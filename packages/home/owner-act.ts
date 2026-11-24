import { createHash } from "node:crypto";
import {
  isObject, outOfRoom, OWNER_REQUEST,
  type BlobStore, type Delivery, type DeliveryFile, type HomeFolder, type Json, type JsonObject, type OpenView, type ReaderOutput, type SourceRow, type Tx,
} from "@lifestreamprotocol/core";
import { devices, people, places, readStatements, Refused, STATEMENTS_FILE, type OwnerReader, type Pictures, type StatementKind } from "@lifestreamprotocol/connect";
import { OWNER_PRODUCTS, isOwnerProduct, type OwnerProduct } from "./devices.js";
import { failpoint } from "./failpoint.js";
import { landSealed, sealedIndexed, type Requested } from "./import.js";
import { basicInstant, deliveredFile, deliveriesOf, deliveryDirectory, inboxLane, manifestOf, openSealing, readDelivery, readSealed, removeDelivery, type Sealing } from "./inbox.js";
import { errorText, storageError, type Main } from "./jobs.js";
import { notBegun, notNowRefusal, refuse, Refusal, RETRY_FULL_S, RETRY_SOON_S } from "./refusal.js";
import { served } from "./reads.js";
import { readerFor } from "./registry.js";
import type { Call } from "./socket.js";
import type { Part, Turns } from "./turns.js";

export interface OwnerAnswer {
  act: string | null;
  id: string | null;
  position: string;
}

export type Statement = { kind: string; key: string; content: Json } | { kind: string; key: string; gone: true };

export interface Drafted {
  kind: string;
  statements: Statement[];
  blobs: Map<string, Buffer>;
  id: string | null;
  undoable: boolean;
  keep?(tx: Tx, delivery: string): void;
}

export interface WriterHost extends Pick<Main, "folder" | "now" | "settings" | "registry" | "log"> {
  readonly blobs: BlobStore;
  readonly machine: string;
  view(): OpenView;
  commit<T>(work: (tx: Tx) => T): T;
  turn: Turns["run"];
}

export interface DraftRead {
  view: OpenView;
  source: string;
  host: WriterHost;
  reader: OwnerReader;
}

export interface Drafter {
  draft(read: DraftRead, action: JsonObject): Drafted;
  follow?(view: OpenView, id: string): string;
}

export const KEPT_MS = 7 * 24 * 60 * 60_000;
const REQUEST = /^[A-Za-z0-9._:-]{1,128}$/u;
const READERS: Readonly<Record<OwnerProduct, OwnerReader>> = { people: people.peopleHome, places: places.placesHome, devices: devices.devicesHome };

export function statedHead(view: OpenView, source: string, kind: string, key: string): JsonObject | undefined {
  const head = view.head({ source, kind, key });
  if (head === undefined || head.version === "gone") return undefined;
  const content = view.version(head.version).content;
  return isObject(content) ? content : undefined;
}

export function bad(words: string): never {
  return refuse(400, "BAD_ACTION", words);
}

export function verbOf<V extends string>(action: JsonObject, verbs: Readonly<Record<V, readonly string[]>>, words: string): V {
  const verb = action.kind;
  if (typeof verb !== "string" || !Object.hasOwn(verbs, verb)) bad(words);
  const allowed = new Set<string>(["of", "kind", "request", ...verbs[verb as V]]);
  const stray = Object.keys(action).find((member) => !allowed.has(member));
  if (stray !== undefined) bad(`A ${verb as string} carries no ${stray}.`);
  return verb as V;
}

export function single(kind: string, statement: Statement | null, id: string): Drafted {
  return { kind, statements: statement === null ? [] : [statement], blobs: new Map(), id, undoable: false };
}

function writerFailed(error: unknown): never {
  if (error instanceof Refusal || storageError(error)) throw error;
  if (outOfRoom(error)) refuse(503, "DISK_LOW", "Lifestream's disk is full: free some space, then try again.", RETRY_FULL_S);
  return refuse(500, "WRITER_FAILED", `Lifestream could not save this: ${errorText(error)}`);
}

function requestOf(action: unknown): string | null {
  const request = isObject(action as Json) ? (action as JsonObject).request : undefined;
  return typeof request === "string" && REQUEST.test(request) ? request : null;
}

export function forgetRequests(tx: Tx, before_ms: number): void {
  for (const request of tx.tables.meta.under(OWNER_REQUEST)) {
    const key = `${OWNER_REQUEST}${request}`;
    const kept = tx.tables.meta.get(key);
    const at_ms = kept === undefined ? null : (JSON.parse(kept) as Partial<Requested>).at_ms;
    if (typeof at_ms !== "number" || at_ms < before_ms) tx.tables.meta.delete(key);
  }
}

interface Waiting {
  device: string;
  action: unknown;
  call: Call;
  settle: (answer: OwnerAnswer) => void;
  reject: (error: unknown) => void;
  drop: () => void;
}

interface Ready {
  source: string;
  drafted: Drafted;
  reader: OwnerReader;
  delivery: Delivery;
  bytes: Buffer;
  name: string;
  fetched_at: string;
}

export class OwnerWriter {
  readonly #host: WriterHost;
  readonly #drafters: Readonly<Record<OwnerProduct, Drafter>>;
  readonly #held: () => boolean;
  #queue: Waiting[] = [];
  #running = false;
  #closed: string | null = null;
  #lastMs = 0;

  constructor(host: WriterHost, drafters: Readonly<Record<OwnerProduct, Drafter>>, held: () => boolean) {
    this.#host = host;
    this.#drafters = drafters;
    this.#held = held;
  }

  sourceOf(product: OwnerProduct): string {
    return `${product}:local:${this.#host.settings.unit}`;
  }

  act(device: string, action: unknown, call: Call): Promise<OwnerAnswer> {
    if (this.#closed !== null) return Promise.reject(notNowRefusal("busy", this.#closed, RETRY_SOON_S));
    if (call.left.aborted) return Promise.reject(notBegun());
    return new Promise((settle, reject) => {
      const waiting: Waiting = {
        device, action, call, settle, reject,
        drop: () => {
          const at = this.#queue.indexOf(waiting);
          if (at < 0) return;
          this.#queue.splice(at, 1);
          reject(notBegun());
        },
      };
      call.left.addEventListener("abort", waiting.drop, { once: true });
      this.#queue.push(waiting);
      this.drain();
    });
  }

  answered(action: unknown): OwnerAnswer | null {
    const request = requestOf(action);
    if (request === null) return null;
    const view = this.#host.view();
    try {
      const kept = view.tables.meta.get(`${OWNER_REQUEST}${request}`);
      return kept === undefined ? null : this.#keptAnswer(view, JSON.parse(kept) as Requested);
    } finally {
      view.close();
    }
  }

  drain(): void {
    if (this.#running) return;
    this.#running = true;
    try {
      while (this.#ready()) {
        const next = this.#queue.shift()!;
        next.call.left.removeEventListener("abort", next.drop);
        next.call.began();
        try {
          next.settle(this.#host.turn("owner act", (part) => this.#run(part, next.device, next.action), next.call));
        } catch (error) {
          next.reject(error);
        }
      }
    } finally {
      this.#running = false;
    }
  }

  close(words: string): void {
    this.#closed = words;
    for (const waiting of this.#queue.splice(0)) {
      waiting.call.left.removeEventListener("abort", waiting.drop);
      waiting.reject(notNowRefusal("busy", words, RETRY_SOON_S));
    }
  }

  #ready(): boolean {
    return this.#closed === null && !this.#held() && this.#queue.length > 0;
  }

  recover(): string[] {
    const host = this.#host;
    const landed: string[] = [];
    for (const of of Object.keys(OWNER_PRODUCTS) as OwnerProduct[]) {
      const source = this.sourceOf(of);
      for (const name of this.#unindexed(source)) {
        const directory = deliveryDirectory(host.folder, source, name);
        const manifest = readSealed(host.folder, directory);
        if (manifest === null) {
          removeDelivery(host.folder, directory);
          continue;
        }
        const request = manifest.facts.request;
        if (manifest.feeder !== "owner-statements" || typeof request !== "string") continue;
        const id = `${source}/${name}`;
        const view = host.view();
        let kept: boolean;
        let reader: OwnerReader;
        try {
          kept = view.tables.meta.get(`${OWNER_REQUEST}${request}`) !== undefined;
          reader = readerOf(host, view.tables.sources.get(source), of);
        } finally {
          view.close();
        }
        if (kept) {
          unseal(host.folder, directory);
          continue;
        }
        const delivery = readDelivery(host.folder, source, name)!;
        let rows: ReaderOutput[];
        try {
          rows = rowsOf({ ...delivery, source }, (file) => deliveredFile(host.folder, directory, file.path).read() ?? gone(file.path), reader.statements);
        } catch (error) {
          host.log({ owner: "recovery", delivery: id, left: errorText(error) });
          continue;
        }
        for (const blob of new Set(rows.flatMap((row) => row.blobs ?? []))) {
          const carried = inboxLane(host.folder, source).blob(blob).read();
          if (!host.blobs.has(blob) && carried !== undefined) host.blobs.put(carried, { expect: blob, mediaType: "image/jpeg" });
        }
        const named = typeof manifest.facts.id === "string" ? manifest.facts.id : null;
        host.commit((tx) => this.#landIndexed(tx, source, id, rows, reader, { id: named, undoable: false }));
        landed.push(id);
      }
    }
    return landed;
  }

  #unindexed(source: string): string[] {
    const names = deliveriesOf(this.#host.folder, source);
    if (names.length === 0) return [];
    const view = this.#host.view();
    try {
      return names.filter((name) => view.tables.deliveries.get(`${source}/${name}`, source) === undefined);
    } finally {
      view.close();
    }
  }

  #keptAnswer(view: OpenView, kept: Requested): OwnerAnswer {
    const follow = this.#drafters[kept.of].follow;
    const id = kept.id === null || follow === undefined ? kept.id : follow(view, kept.id);
    return { act: kept.undoable ? kept.act : null, id, position: kept.position };
  }

  #landIndexed(tx: Tx, source: string, id: string, rows: readonly ReaderOutput[], reader: OwnerReader, requested: Pick<Requested, "id" | "undoable">): string | null {
    return landSealed(this.#host, tx, sealedIndexed(this.#host.folder, tx, id)!, source, rows, reader.kinds, requested);
  }

  #run(part: Part, device: string, action: unknown): OwnerAnswer {
    let ready: Ready;
    let rows: ReaderOutput[];
    try {
      part("draft");
      const drafted = this.#draft(device, action);
      if (!("delivery" in drafted)) return drafted;
      ready = drafted;
      rows = rowsOf(ready.delivery, () => ready.bytes, ready.reader.statements);
    } catch (error) {
      return writerFailed(error);
    }
    return this.#land(part, ready, rows);
  }

  #draft(device: string, action: unknown): OwnerAnswer | Ready {
    const host = this.#host;
    if (!isObject(action as Json)) bad("An action is a JSON object.");
    const asked = action as JsonObject;
    const request = requestOf(asked) ?? bad("An action carries its request: the id its device made for it.");
    const of = isOwnerProduct(asked.of) ? asked.of : bad("An action says what it changes: of people, places or devices.");
    const source = this.sourceOf(of);
    const key = `${OWNER_REQUEST}${request}`;
    let unchanged: OwnerAnswer & { kind: string };
    const view = host.view();
    try {
      const kept = view.tables.meta.get(key);
      if (kept !== undefined) return this.#keptAnswer(view, JSON.parse(kept) as Requested);
      const row = view.tables.sources.get(source);
      if (row === undefined) refuse(409, "NO_SOURCE", "Lifestream has no place to keep this yet: it makes one from this Mac's unit setting.");
      const reader = readerOf(host, row, of);
      const drafted = this.#drafters[of].draft({ view, source, host, reader }, asked);
      if (drafted.statements.length === 0) {
        unchanged = { kind: drafted.kind, act: null, id: drafted.id, position: view.position() };
      } else {
        const at_ms = Math.max(host.now(), (row.read_through_ms ?? 0) + 1, this.#lastMs + 1);
        this.#lastMs = at_ms;
        const fetched_at = new Date(at_ms).toISOString();
        const bytes = Buffer.from(drafted.statements.map((statement) => `${JSON.stringify(statement)}\n`).join(""));
        const hex = createHash("sha256").update(bytes).digest("hex");
        const name = `${basicInstant(fetched_at)}.${hex.slice(0, 12)}`;
        const facts: JsonObject = { action: drafted.kind, request, id: drafted.id, device, statements: drafted.statements.length, blobs_carried: drafted.blobs.size };
        const delivery: Delivery = {
          id: `${source}/${name}`, source, sealed_ms: at_ms, stated_ms: at_ms, facts,
          files: [{ path: STATEMENTS_FILE, blob: `sha256:${hex}`, size: bytes.length }],
        };
        const pictures: Pictures = {
          carried: (blob) => {
            const square = drafted.blobs.get(blob);
            return square === undefined ? undefined : { size: square.length, bytes: () => square };
          },
          held: (blob) => served(view, host.blobs, blob),
        };
        for (const [index, statement] of drafted.statements.entries()) {
          const rule = reader.statements[statement.kind]?.picture;
          const fault = "gone" in statement || rule === undefined ? undefined : rule(statement.content as JsonObject, pictures);
          if (fault !== undefined) refuse(422, "STATEMENTS_BAD", `${STATEMENTS_FILE} line ${index + 1}: ${fault}`);
        }
        return { source, drafted, reader, delivery, bytes, name, fetched_at };
      }
    } finally {
      view.close();
    }
    const { kind, ...answer } = unchanged;
    host.commit((tx) => {
      const at_ms = host.now();
      tx.tables.meta.set(key, JSON.stringify({ of, act: null, kind, id: answer.id, undoable: false, position: answer.position, at_ms } satisfies Requested));
      forgetRequests(tx, at_ms - KEPT_MS);
    });
    return answer;
  }

  #land(part: Part, ready: Ready, rows: readonly ReaderOutput[]): OwnerAnswer {
    const host = this.#host;
    const { source, drafted, delivery, bytes, reader } = ready;
    part("seal");
    failpoint("owner.seal");
    let sealing: Sealing | undefined;
    try {
      sealing = openSealing(host.folder, { source, name: ready.name, feeder: "owner-statements", fetched_at: ready.fetched_at });
      const lane = inboxLane(host.folder, source);
      for (const [blob, square] of drafted.blobs) {
        const kept = lane.placed(blob);
        if (!kept.exists()) kept.write(square);
      }
      const put = sealing.put(STATEMENTS_FILE, bytes);
      if (`sha256:${put.sha256}` !== delivery.files[0]!.blob) throw new Error(`${STATEMENTS_FILE} did not seal as the statements drafted`);
      sealing.seal(delivery.facts);
    } catch (error) {
      sealing?.abandon();
      return writerFailed(error);
    }
    part("land");
    let position: string;
    try {
      failpoint("owner.land");
      for (const [blob, square] of drafted.blobs) if (!host.blobs.has(blob)) host.blobs.put(square, { expect: blob, mediaType: "image/jpeg" });
      position = host.commit((tx) => {
        const landed = this.#landIndexed(tx, source, delivery.id, rows, reader, { id: drafted.id, undoable: drafted.undoable });
        drafted.keep?.(tx, delivery.id);
        forgetRequests(tx, host.now() - KEPT_MS);
        return landed!;
      });
    } catch (error) {
      if (this.#indexed(source, delivery.id, error)) throw error;
      try {
        unseal(host.folder, sealing.directory);
      } catch (removal) {
        this.close("Lifestream could not save this: it saves it again when it starts.");
        host.log({ owner: "unsealed", delivery: delivery.id, failed: errorText(removal) });
        throw error;
      }
      return writerFailed(error);
    }
    failpoint("owner.answer");
    return { act: drafted.undoable ? delivery.id : null, id: drafted.id, position };
  }

  #indexed(source: string, id: string, error: unknown): boolean {
    let view: OpenView;
    try {
      view = this.#host.view();
    } catch {
      throw error;
    }
    try {
      return view.tables.deliveries.get(id, source) !== undefined;
    } catch {
      throw error;
    } finally {
      view.close();
    }
  }
}

function readerOf(host: WriterHost, source: SourceRow | undefined, of: OwnerProduct): OwnerReader {
  const reader = source === undefined ? undefined : readerFor(host.registry, source);
  return reader !== undefined && "statements" in reader ? reader as OwnerReader : READERS[of];
}

function rowsOf(delivery: Delivery, bytes: (file: DeliveryFile) => Buffer, kinds: Readonly<Record<string, StatementKind>>): ReaderOutput[] {
  let rows: ReaderOutput[];
  try {
    rows = readStatements(delivery, bytes, kinds);
  } catch (error) {
    if (error instanceof Refused) refuse(422, "STATEMENTS_BAD", error.message);
    throw error;
  }
  const refused = rows.find((row) => row.refused !== undefined);
  if (refused !== undefined) refuse(422, "STATEMENTS_BAD", refused.refused!);
  return rows;
}

function gone(path: string): never {
  throw new Error(`${path} is not in the inbox`);
}

function unseal(folder: HomeFolder, directory: string): void {
  manifestOf(folder, directory).remove();
  removeDelivery(folder, directory);
}
