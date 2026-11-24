import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { pipeline } from "node:stream/promises";
import { VERDICTS, type Choosing, type HeldSite, type RefusedStation, type SiteAccount, type TabClaim } from "@lifestreamprotocol/connect";
import { GENERATION, isObject, makeUnder, openHomeFolder, RELEASE, writeDurably, type FileKind, type HomeFolder, type JsonObject, type KeptFile } from "@lifestreamprotocol/core";
import { allowExtension } from "./connecting.js";
import { belowFloor, deviceHeader } from "./devices.js";
import { CALL_SLACK_MS, FETCH_AT_ONCE, FETCH_MS, placeErrand, type Errand, type ErrandSpec, type Step } from "./errand.js";
import { answerHeld as answer, jsonOf, openPeers, type Hand, type Peer, type PeerWire } from "./peers.js";
import { bodyOf as body } from "./silence.js";
import { chosenWith } from "./settings.js";
import { NOT_NOW, notNow, refuse, Refusal, RETRY_SOON_S } from "./refusal.js";
import type { Need } from "./streams-report.js";


export const PART_BYTES = 8 * 1024 * 1024;

const CODES = [
  "ORIGIN_REFUSED", "SITE_NOT_ALLOWED", "SECRET_REFUSED", "NOT_FOUND", "AMBIGUOUS", "REF_STALE", "TIMEOUT", "INTERRUPTED",
  "DOWNLOAD_FAILED", "PAGE_ERROR", "OFFLINE", "TOO_LARGE", "NO_ERRAND", "BUSY", "NO_STATION", "BAD_CALL", "HOME_TOO_OLD",
] as const;
type Code = (typeof CODES)[number];

type Op = JsonObject & { readonly op: string; readonly ms?: number };
type Call = JsonObject & { readonly id: string; readonly errand: string; readonly op: string };
type Result = { readonly id: string } & ({ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } });

export interface FileRef {
  readonly name: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path?: string;
}

interface StationInfo {
  readonly unit: string;
  readonly version: string;
  readonly slots: number;
  readonly errands: readonly string[];
  readonly boot: string;
  readonly running: readonly string[];
  readonly pressed?: Pressed;
  readonly allowing?: readonly string[];
  readonly withheld?: readonly string[];
  readonly opened?: readonly string[];
  readonly acted?: readonly Acted[];
  readonly tabs?: readonly StationTab[];
  readonly survey?: true;
  readonly development?: true;
  readonly [member: string]: unknown;
}

interface Site {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly form?: true;
  readonly origins: readonly string[];
}

export interface Pressed {
  readonly choose: readonly string[];
  readonly stop: readonly string[];
}

export interface Changed {
  readonly unit: string;
  readonly first: boolean;
  readonly survey: boolean;
  readonly pressed: Pressed;
  readonly granted: readonly string[];
}

export interface Heard {
  readonly covers?: number;
}

export interface Entry {
  readonly at: number;
  readonly call: string;
  readonly errand: string;
  readonly op: string;
  readonly name?: string;
  readonly urls?: readonly string[];
  readonly target?: unknown;
  readonly secrets?: readonly string[];
  readonly ok: boolean;
  readonly code?: string;
  readonly responses?: readonly { readonly status: number; readonly bytes: number; readonly code?: string }[];
}

export interface HomeNamed {
  readonly version: string;
  readonly generation: number | null;
}

export interface StationFiles {
  readonly folder: HomeFolder;
  readonly dir: string;
}

const STATION_FILE: FileKind = { role: "station-file", passing: true };

export interface StationsOptions {
  readonly files: StationFiles;
  readonly home: HomeNamed;
  readonly needs: () => readonly Need[] | Promise<readonly Need[]>;
  readonly opened: (unit: string, ids: readonly string[]) => void;
  readonly acted: (unit: string, acts: readonly Acted[]) => void;
  readonly changed?: (change: Changed, request: IncomingMessage) => Promise<Heard | undefined> | Heard | undefined;
  readonly chosen: () => readonly string[];
  readonly sites?: readonly Site[];
  readonly probed?: readonly string[];
  readonly log?: (entry: Entry) => void;
  readonly told?: (line: JsonObject) => void;
  readonly slack_ms?: number;
  readonly claimed?: (claim: TabClaim) => Promise<void>;
  readonly poll_ms?: number;
  readonly presence_ms?: number;
  readonly idle_ms?: number;
  readonly sweep_ms?: number;
  readonly needs_ms?: number;
  readonly clock?: () => number;
}

export interface Stations extends PeerWire {
  sites(): HeldSite[];
  present(): string[];
  refused(): RefusedStation[];
  below(unit: string, version: string, request: IncomingMessage): Promise<void>;
  close(): void;
}

type StationState = Peer<StationInfo> & StationKept;

interface StationKept {
  shown: string;
  ending: Map<string, string>;
  gaveUp: { readonly id: string; readonly op: string; readonly at: number }[];
  reload: boolean;
  probed: Record<string, boolean | null>;
  accounts: Record<string, SiteAccount | null>;
  owed: number;
  put: number;
  heard: boolean;
  listed: string;
  offered: string;
  withheld: readonly string[] | null;
  refused: ReadonlySet<string>;
}

interface ErrandState extends Errand {
  readonly files: Map<string, { readonly ref: FileRef; readonly file: KeptFile }>;
  readonly writing: Map<string, Upload>;
}

class Upload {
  readonly #hash = createHash("sha256");
  #parts = 0;
  #bytes = 0;
  readonly #into = new PassThrough({ highWaterMark: 0 });
  readonly #written: Promise<number>;
  #stopped: Error | undefined;
  #turn: Promise<unknown> = Promise.resolve();
  readonly #gone: () => void;

  constructor(readonly name: string, readonly file: KeptFile, gone: () => void) {
    this.#gone = gone;
    this.#into.on("error", () => undefined);
    this.#written = file.writing(this.#into);
    this.#written.catch(() => file.remove()).catch(() => undefined);
  }

  part(index: number, read: () => Promise<Buffer>): Promise<void> {
    return this.#inTurn(async () => {
      if (index !== this.#parts) refuse(400, "BAD_CALL", `part ${index} of "${this.name}" is out of order`);
      const bytes = await read();
      await this.#failing(() => this.#take(bytes));
      this.#parts += 1;
      this.#bytes += bytes.length;
      this.#hash.update(bytes);
    });
  }

  finish(count: number): Promise<{ readonly bytes: number; readonly sha256: string }> {
    return this.#inTurn(async () => {
      if (count !== this.#parts) refuse(400, "BAD_CALL", `"${this.name}" has ${this.#parts} parts, not ${count}`);
      await this.#failing(() => this.#end());
      this.#gone();
      return { bytes: this.#bytes, sha256: this.#hash.digest("hex") };
    });
  }

  stop(why: Error): void {
    if (this.#stopped !== undefined) return;
    this.#stopped = why;
    this.#into.destroy(why);
  }

  #inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = this.#turn.then(() => {
      if (this.#stopped !== undefined) throw this.#stopped;
      return work();
    });
    this.#turn = done.catch(() => undefined);
    return done;
  }

  async #take(bytes: Buffer): Promise<void> {
    if (this.#stopped !== undefined) throw this.#stopped;
    if (this.#into.write(bytes)) return;
    await Promise.race([once(this.#into, "drain"), this.#written.then((): never => {
      throw new Error("the file's writer ended before its last part");
    })]);
  }

  async #end(): Promise<void> {
    this.#into.end();
    await this.#written;
    if (this.#stopped === undefined) return;
    this.file.remove();
    throw this.#stopped;
  }

  async #failing(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      const why = this.#stopped ?? (error instanceof Error ? error : new Error(String(error)));
      this.stop(why);
      this.#gone();
      throw why;
    }
  }
}

interface Waiter {
  readonly spec: ErrandSpec;
  readonly named: string | undefined;
  readonly site: string | undefined;
  readonly placed: (placing: { readonly errand: ErrandState; readonly kept: boolean } | null) => void;
}

const REFUSED: Record<Exclude<Step, "running">, string> = {
  placed: "has not begun", closing: "is ending", ended: "has ended", expired: "passed its deadline",
};

const OPS: ReadonlySet<string> = new Set(["open", "goto", "snapshot", "find", "click", "fill", "select", "wait", "fetch"]);

const MAX_JSON = 64 * 1024 * 1024;
const SILENT_MS = 5 * 60_000;
const json = (request: IncomingMessage): Promise<JsonObject> => jsonOf(request, MAX_JSON, SILENT_MS);
const REFUSED_JSON = 256 * 1024;
const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*(\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;
const UNIT = /^chrome-[0-9a-f]{8}$/u;
const CLOCK_MS = 60_000;
const CALL_ID = /^c-[0-9a-f]{12}$/u;
const STATED = 1_000;
const IDLE_MS = 5 * 60_000;
const MAX_WAIT_MS = 15 * 60_000;
export interface Acted {
  readonly need: string;
  readonly do: "try" | "skip" | "read" | "ignore";
  readonly of?: string;
}

function isActed(value: unknown): value is Acted {
  if (!isObject(value) || !text(value.need, 300) || !["try", "skip", "read", "ignore"].includes(value.do as string)) return false;
  return value.do === "read" || value.do === "ignore" ? text(value.of, 300) : value.of === undefined;
}

interface StationTab {
  readonly tab: number;
  readonly errand: string | null;
  readonly from: number;
  readonly until: number;
}

const TABS_CLAIMED = 200;
const ERRAND = /^e-[0-9a-f]{8}$/u;
const isMs = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function isStationTab(value: unknown): value is StationTab {
  if (!isObject(value) || !isMs(value.tab) || !isMs(value.from) || !isMs(value.until) || value.from > value.until) return false;
  return value.errand === null || (typeof value.errand === "string" && ERRAND.test(value.errand));
}

const ENDED_KEPT = 256;

export function budgetOf(op: JsonObject, slack: number): number {
  if (op.op === "fetch") return Math.ceil((Array.isArray(op.requests) ? op.requests.length : 0) / FETCH_AT_ONCE) * FETCH_MS + slack;
  return (typeof op.ms === "number" ? op.ms : 0) + slack;
}

const codeOf = (code: unknown): string => ((CODES as readonly unknown[]).includes(code) ? (code as string) : "other");

const NEEDS_MS = 1_000;

const hex = (bytes: number): string => randomBytes(bytes).toString("hex");
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value !== "" && value.length <= limit;

const siteOf = ({ id, name, origin, form, origins }: Site): Site =>
  (form === true ? { id, name, origin, form, origins: [...origins] } : { id, name, origin, origins: [...origins] });
const failure = (id: string, code: Code | typeof NOT_NOW, message: string): Result => ({ id, ok: false, error: { code, message } });

export const CLOSED = "Lifestream's door closed while the call ran: it is asked again in a moment.";

function entry(at: number, errand: string, call: Op | { op: "begin"; spec: ErrandSpec } | { op: "end" }, result: Result): Entry {
  const asked: Record<string, unknown> = { at, call: result.id, errand, op: call.op };
  const op = call as JsonObject;
  if (call.op === "begin") Object.assign(asked, { name: (call as { spec: ErrandSpec }).spec.name, urls: [...(call as { spec: ErrandSpec }).spec.origins] });
  if ((call.op === "open" || call.op === "goto") && typeof op.url === "string") asked.urls = [op.url];
  if (call.op === "fetch" && Array.isArray(op.requests)) asked.urls = op.requests.map((request) => `${(request as JsonObject).method ?? "GET"} ${String((request as JsonObject).url)}`);
  if ("target" in op) asked.target = op.target;
  const named = secretsOf(op).map(({ name }) => name);
  if (named.length > 0) asked.secrets = named;
  asked.ok = result.ok;
  if (!result.ok) asked.code = result.error.code;
  else if (call.op === "fetch" && Array.isArray(result.value)) {
    asked.responses = (result.value as { status: number; file?: FileRef; json?: unknown; error?: { code?: unknown } }[]).map((response) => ({
      status: response.status,
      bytes: response.file?.bytes ?? (response.json === undefined ? 0 : Buffer.byteLength(JSON.stringify(response.json))),
      ...(typeof response.error?.code === "string" ? { code: response.error.code } : {}),
    }));
  }
  return asked as unknown as Entry;
}

function pressesOf(stated: unknown): Pressed {
  const ids = (named: unknown): string[] => (Array.isArray(named) ? named.filter((id): id is string => text(id, 100)) : []);
  return isObject(stated) ? { choose: ids(stated.choose), stop: ids(stated.stop) } : { choose: [], stop: [] };
}

function secretsOf(op: JsonObject): { name: unknown; value: unknown }[] {
  const found: { name: unknown; value: unknown }[] = [];
  const look = (value: unknown): void => {
    if (isObject(value) && "secret" in value) found.push({ name: value.secret, value: value.value });
  };
  look(op.value);
  for (const value of Object.values(isObject(op.headers) ? op.headers : {})) look(value);
  for (const request of Array.isArray(op.requests) ? op.requests : []) {
    for (const value of Object.values(isObject((request as JsonObject).headers) ? (request as JsonObject).headers as JsonObject : {})) look(value);
  }
  return found;
}

export function openStations(options: StationsOptions): Stations {
  const pollMs = options.poll_ms ?? 25_000;
  const presenceMs = options.presence_ms ?? 90_000;
  const idleMs = options.idle_ms ?? IDLE_MS;
  const slackMs = options.slack_ms ?? CALL_SLACK_MS;
  const clock = options.clock ?? Date.now;
  const withProbe = new Set(options.probed ?? []);
  const peers = openPeers<StationInfo, Call, Result, StationKept>({
    poll_ms: pollMs, presence_ms: presenceMs, noun: "station",
    interrupted: (id, cause, unit) => (cause === "closed" ? failure(id, NOT_NOW, CLOSED) : failure(id, "INTERRUPTED", `station ${unit} started again while the call ran`)),
  });
  let closed = false;
  const present = (state: StationState): boolean => peers.present(state);
  const refusedAt = new Map<string, RefusedStation & { at_ms: number }>();
  const refusedList = (): RefusedStation[] => [...refusedAt.values()].filter((each) => clock() - each.at_ms < presenceMs).sort((a, b) => (a.unit < b.unit ? -1 : 1))
    .map(({ unit, version, development, since_ms }) => ({ unit, version, development, since_ms }));
  const errands = new Map<string, ErrandState>();
  const waiters: Waiter[] = [];
  let sites: Site[] = (options.sites ?? []).map(siteOf);
  const originsOf = new Map((options.sites ?? []).map((site) => [site.id, site.origins]));
  const chosen = (): string[] => options.chosen().filter((id) => sites.some((site) => site.id === id));
  const held = (): HeldSite[] => {
    const picked = new Set(chosen());
    const there = peers.peers().filter(present);
    const signedIn = (id: string): boolean | null => {
      const found = there.map((state) => state.probed[id] ?? null);
      return found.includes(true) ? true : found.includes(false) ? false : null;
    };
    const allowing = new Set(there.flatMap((state) => (Array.isArray(state.info.allowing) ? state.info.allowing : [])));
    const owed = there.some((state) => state.put < state.owed);
    const byUnit = [...there].sort((a, b) => (a.info.unit < b.info.unit ? -1 : a.info.unit > b.info.unit ? 1 : 0));
    return sites.map((site) => ({
      ...site, signed_in: signedIn(site.id), chosen: picked.has(site.id), checking: owed && withProbe.has(site.id), choosing: allowing.has(site.id) ? "allowing" : null,
      stations: byUnit.map((state) => ({
        unit: state.info.unit, signed_in: state.probed[site.id] ?? null, account: state.accounts[site.id] ?? null,
        ...(state.withheld !== null ? { allowed: !state.withheld.includes(site.id) } : state.refused.has(site.id) ? { allowed: false } : {}),
      })),
    }));
  };
  const { folder: filesFolder, dir: filesDir } = options.files;
  rmSync(filesDir, { recursive: true, force: true });
  mkdirSync(filesDir);
  let written = 0;

  function stopWriting(errand: ErrandState, why: string): void {
    for (const upload of errand.writing.values()) upload.stop(new Refusal(409, "INTERRUPTED", why));
    errand.writing.clear();
  }

  function forget(errand: ErrandState): void {
    errand.end();
    stopWriting(errand, `errand ${errand.id} ended while a file was sent`);
    errands.delete(errand.id);
    endCalls(errand, (id) => failure(id, "INTERRUPTED", `errand ${errand.id} ended while the call ran`));
    void rm(join(filesDir, errand.id), { recursive: true, force: true });
  }

  function endCalls(errand: ErrandState, result: (id: string) => Result): void {
    const station = peers.get(errand.unit);
    if (station === undefined) return;
    for (const call of peers.pending(station)) if (call.errand === errand.id) gaveUp(station, call, result(call.id));
  }

  function gaveUp(station: StationState, call: Call, result: Result): void {
    if (!peers.holds(station, call.id)) return;
    station.gaveUp = [...station.gaveUp, { id: call.id, op: call.op, at: clock() }].slice(-ENDED_KEPT);
    peers.end(station, call.id, result);
  }

  const tell = (unit: string, line: JsonObject): void => options.told?.({ station: unit, ...line });

  const wake = (): void => peers.wake();

  let lastNeeds: Need[] = [];
  async function needs(): Promise<Need[]> {
    try {
      lastNeeds = [...await options.needs()];
    } catch {
    }
    return lastNeeds;
  }

  const needing = setInterval(async () => {
    if (!peers.peers().some((state) => peers.waiting(state))) return;
    const home = await needs();
    for (const state of peers.peers()) {
      if (!peers.waiting(state)) continue;
      if (state.shown === JSON.stringify(home)) continue;
      peers.wake(state);
    }
  }, options.needs_ms ?? NEEDS_MS);
  needing.unref();

  function dispatch(errand: ErrandState, call: Call, waitMs: number): Promise<Result> {
    const station = peers.get(errand.unit);
    if (station === undefined || !present(station)) return Promise.resolve(failure(call.id, "NO_STATION", `station ${errand.unit} is not connected`));
    return new Promise((resolve) => {
      const silent = failure(call.id, "INTERRUPTED", `no answer from station ${errand.unit} within ${waitMs} ms: whether the call ran is not known`);
      const timer = setTimeout(() => gaveUp(station, call, silent), waitMs);
      peers.hand(station, call, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }

  function checkSecrets(errand: ErrandState, op: Op): void {
    const allowed = errand.spec.secrets ?? [];
    for (const { name, value } of secretsOf(op)) {
      if (typeof name !== "string" || !allowed.includes(name)) refuse(403, "SECRET_REFUSED", `the errand's spec does not name secret "${String(name)}"`);
      if (typeof value !== "string" || value === "") refuse(400, "BAD_CALL", `secret "${name}" is sent with its value`);
    }
  }

  function withPaths(errand: ErrandState, op: Op, result: Result): Result {
    if (!result.ok) return result;
    const located = (file: FileRef | undefined): FileRef | undefined => {
      const kept = file === undefined ? undefined : errand.files.get(file.name);
      return file === undefined || kept === undefined || filesFolder.form !== "plain" ? file : { ...file, path: kept.file.path };
    };
    if (op.op === "fetch" && Array.isArray(result.value)) {
      return { ...result, value: (result.value as { file?: FileRef }[]).map((response) => (response.file === undefined ? response : { ...response, file: located(response.file) })) };
    }
    return result;
  }

  function prune(): void {
    for (const errand of [...errands.values()]) if (errand.spent()) forget(errand);
  }

  const standing = (): Set<string> => new Set(lastNeeds.flatMap((need) => (need.at?.errand == null ? [] : [need.at.errand])));

  function reserve(spec: ErrandSpec, named: string | undefined, site: string | undefined): { errand: ErrandState; kept: boolean } | null {
    const running = [...errands.values()].filter((errand) => errand.holds());
    const picked = site === undefined || chosen().includes(site);
    const fits = (state: StationState | undefined): state is StationState =>
      picked && state !== undefined && present(state) && (named === undefined || state.info.unit === named);
    const left = standing();
    const kept = running.find((errand) => errand.spec.name === spec.name && errand.step() === "running" && errand.idleFor() !== null && left.has(errand.id) && fits(peers.get(errand.unit)));
    if (kept !== undefined) {
      kept.reached();
      return { errand: kept, kept: true };
    }
    const station = peers.peers()
      .filter(fits)
      .filter((state) => {
        const there = running.filter((errand) => errand.unit === state.info.unit);
        return there.length < state.info.slots && !there.some((errand) => errand.spec.origins.some((origin) => spec.origins.includes(origin)));
      })
      .sort((a, b) => b.seen - a.seen)[0];
    if (station === undefined) return null;
    const errand: ErrandState = Object.assign(placeErrand(`e-${hex(4)}`, spec, station.info.unit, clock), { files: new Map(), writing: new Map() });
    errands.set(errand.id, errand);
    return { errand, kept: false };
  }

  function drain(): void {
    for (const waiter of [...waiters]) {
      const placing = reserve(waiter.spec, waiter.named, waiter.site);
      if (placing === null) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.placed(placing);
    }
  }

  function log(errand: string, call: Parameters<typeof entry>[2], result: Result): void {
    options.log?.(entry(clock(), errand, call, result));
  }

  async function close(errand: ErrandState): Promise<void> {
    await errand.close(async () => {
      const result = await dispatch(errand, { id: `c-${hex(6)}`, errand: errand.id, op: "end" }, CALL_SLACK_MS);
      log(errand.id, { op: "end" }, result);
    });
    forget(errand);
    drain();
  }

  function sweep(): void {
    prune();
    for (const errand of errands.values()) {
      const station = peers.get(errand.unit);
      if (station !== undefined && present(station)) continue;
      endCalls(errand, (id) => failure(id, "NO_STATION", `station ${errand.unit} has not been seen for ${Math.round(presenceMs / 1_000)} s: Chrome closed, or the extension off`));
    }
    const left = standing();
    for (const errand of errands.values()) {
      if (errand.step() === "running" && (errand.idleFor() ?? 0) > idleMs && !left.has(errand.id)) void close(errand);
    }
    drain();
  }
  const sweeper = setInterval(sweep, options.sweep_ms ?? Math.max(50, Math.min(5_000, idleMs / 4)));
  sweeper.unref();

  function errandOf(id: string | undefined): ErrandState {
    prune();
    const errand = id === undefined ? undefined : errands.get(id);
    return errand ?? refuse(404, "NO_ERRAND", `no errand ${id}`);
  }

  function restarted(state: StationState): void {
    for (const errand of errands.values()) {
      if (errand.unit !== state.info.unit || state.info.errands.includes(errand.id) || errand.step() === "ended") continue;
      errand.lost();
      if (errand.step() === "ended") endCalls(errand, (id) => failure(id, "INTERRUPTED", "Chrome started again under the errand"));
    }
  }

  function strays(state: StationState): void {
    const running = new Set(state.info.errands);
    for (const id of [...state.ending.keys()]) if (!running.has(id)) state.ending.delete(id);
    for (const id of running) {
      const errand = errands.get(id);
      if ((errand !== undefined && errand.step() !== "ended") || state.ending.has(id)) continue;
      const call = `c-${hex(6)}`;
      state.ending.set(id, call);
      peers.hand(state, { id: call, errand: id, op: "end" }, (result) => {
        if (!result.ok && state.ending.get(id) === call) state.ending.delete(id);
      });
    }
  }

  function late(state: StationState, result: unknown): void {
    if (!isObject(result)) return;
    const at = state.gaveUp.findIndex((ended) => ended.id === result.id);
    if (at === -1) return;
    const [ended] = state.gaveUp.splice(at, 1);
    const failed = isObject(result.error) ? result.error.code : undefined;
    const slots = ended!.op === "fetch" && result.ok === true && Array.isArray(result.value)
      ? { slots: result.value.map((slot) => (isObject(slot) && isObject(slot.error) ? { code: codeOf(slot.error.code) } : { status: isObject(slot) && isMs(slot.status) ? slot.status : 0 })) }
      : {};
    tell(state.info.unit, { late: ended!.id, op: ended!.op, code: result.ok === true ? "ok" : codeOf(failed), after_ms: Math.max(0, clock() - ended!.at), ...slots });
  }

  function slotsOf(call: Call, value: unknown): boolean {
    const requests = Array.isArray(call.requests) ? call.requests : [];
    if (!Array.isArray(value) || value.length !== requests.length) return false;
    const errand = errands.get(call.errand);
    return value.every((slot, at) => {
      if (!isObject(slot) || typeof slot.status !== "number") return false;
      if (slot.error !== undefined && !(isObject(slot.error) && typeof slot.error.code === "string")) return false;
      if (slot.file === undefined) return true;
      const file = slot.file;
      if (!isObject(file) || typeof file.name !== "string") return false;
      const kept = errand?.files.get(file.name)?.ref;
      const request = requests[at];
      return kept !== undefined && isObject(request) && request.name === kept.name && file.bytes === kept.bytes && file.sha256 === kept.sha256;
    });
  }

  function read(call: Call, result: JsonObject & { readonly id: string }): Result {
    const wrong = failure(call.id, "BAD_CALL", "the station's answer has the wrong shape");
    if (result.ok === false) {
      const error = result.error;
      const told = isObject(error) && (CODES as readonly unknown[]).includes(error.code) && typeof error.message === "string" && (error.snapshot === undefined || isObject(error.snapshot));
      return told ? (result as unknown as Result) : wrong;
    }
    if (result.ok !== true || !("value" in result)) return wrong;
    const value = result.value;
    const url = isObject(value) && typeof value.url === "string";
    const right = call.op === "open" ? url && Number.isSafeInteger((value as JsonObject).tab)
      : call.op === "goto" || call.op === "click" ? url
        : call.op === "fetch" ? slotsOf(call, value)
          : true;
    return right ? (result as unknown as Result) : wrong;
  }

  async function exchange(unit: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sent = await json(request);
    const info = sent.station as StationInfo | undefined;
    const strings = (value: unknown): boolean => Array.isArray(value) && value.length <= STATED && value.every((each) => text(each, 300));
    if (
      !isObject(info) || typeof info.unit !== "string" || !UNIT.test(info.unit) || !text(info.boot, 300)
      || !Number.isSafeInteger(info.slots) || info.slots < 1 || !strings(info.errands) || !strings(info.running)
    ) {
      refuse(400, "BAD_CALL", "an exchange names its station, its start, its slots, its errands and the calls it holds");
    }
    if (info.unit !== unit) refuse(403, "PRINCIPAL_SCOPE", `this pass is station ${unit}'s, not ${info.unit}'s`);
    const known = peers.get(unit) !== undefined;
    const { peer: state, again, was, retired } = peers.arrive(unit, info, (): StationKept => ({
      shown: "", ending: new Map(), gaveUp: [], reload: info.development === true, probed: {}, accounts: {}, owed: 0, put: 0, heard: false, listed: "", offered: "", withheld: null, refused: new Set(),
    }));
    if (!known || again) tell(unit, { boot: known ? "again" : "first", version: deviceHeader(request.headers["lifestream-device"])?.version ?? null, retired: retired.length });
    refusedAt.delete(unit);
    if (again) restarted(state);
    const opened = (Array.isArray(info.opened) ? info.opened : []).filter((id): id is string => text(id, 300));
    if (opened.length > 0) {
      for (const need of lastNeeds) {
        const errand = need.at?.errand == null || !opened.includes(need.id) ? undefined : errands.get(need.at.errand);
        errand?.reached();
      }
      options.opened(unit, opened);
    }
    const acted = (Array.isArray(info.acted) ? info.acted : []).filter(isActed);
    if (acted.length > 0) options.acted(unit, acted);
    const tabs = (Array.isArray(info.tabs) ? info.tabs : []).filter(isStationTab).slice(0, TABS_CLAIMED);
    for (const { tab, errand, from, until } of tabs) await options.claimed?.({ station: unit, tab, errand, from_ms: Math.max(0, from - CLOCK_MS), until_ms: until + CLOCK_MS });
    strays(state);
    drain();
    const held = new Map(peers.pending(state).map((call) => [call.id, call]));
    const results = (Array.isArray(sent.results) ? sent.results : [])
      .filter((result): result is JsonObject & { readonly id: string } => isObject(result) && typeof result.id === "string" && CALL_ID.test(result.id))
      .map((result) => (held.has(result.id) ? read(held.get(result.id)!, result) : (result as unknown as Result)));
    for (const result of peers.settle(state, results)) late(state, result);
    const opOf = new Map(peers.pending(state).map((call) => [call.id, call.op]));
    for (const id of peers.rehand(state)) tell(unit, { handed_again: id, op: opOf.get(id) ?? null });
    const pressed = pressesOf(info.pressed);
    const pressing = pressed.choose.length > 0 || pressed.stop.length > 0;
    const first = !state.heard;
    const survey = info.survey === true;
    const withheld = Array.isArray(info.withheld) ? info.withheld.filter((id): id is string => text(id, 100)) : null;
    const granted = state.withheld === null || withheld === null ? [] : state.withheld.filter((id) => !withheld.includes(id));
    if (first || !was || survey || pressing || granted.length > 0) {
      const heard = await options.changed?.({ unit, first, survey, pressed, granted }, request);
      state.heard = true;
      if (typeof heard?.covers === "number") state.owed = Math.max(state.owed, heard.covers);
      if (pressing) wake();
    }
    if (withheld !== null) state.withheld = withheld;
    const giveBack = (hand: Hand<Call>): void => {
      const opOf = new Map(hand.calls.map((call) => [call.id, call.op]));
      for (const { id, why } of peers.giveBack(state, hand)) tell(unit, { fenced: id, op: opOf.get(id) ?? null, why });
    };
    const offeredOf = () => {
      const emailOf = (id: string): { email: string } | null => {
        const account = state.accounts[id];
        return account != null && "email" in account ? { email: account.email } : null;
      };
      return sites.map((site) => ({ ...site, signed_in: state.probed[site.id] ?? null, account: emailOf(site.id) }));
    };
    const send = async (hand: Hand<Call>): Promise<void> => {
      const shown = response.destroyed ? undefined : await needs();
      if (shown === undefined || response.destroyed) return giveBack(hand);
      state.shown = JSON.stringify(shown);
      const reload = state.reload;
      state.reload = false;
      if (reload) giveBack(hand);
      const calls = reload ? [] : hand.calls;
      const listed = chosen();
      state.listed = JSON.stringify(listed);
      const offered = offeredOf();
      state.offered = JSON.stringify(offered);
      return answer(response, 200, { home: options.home, calls, needs: shown, sites: offered, chosen: listed, ...(reload ? { reload: true } : {}) });
    };
    const needed = JSON.stringify(await needs());
    if (peers.queued(state) > 0 || state.reload || pressing || tabs.length > 0 || JSON.stringify(chosen()) !== state.listed || JSON.stringify(offeredOf()) !== state.offered || needed !== state.shown) return send(peers.take(state));
    return send(await peers.wait(state, response));
  }

  async function file(unit: string, parts: string[], query: URLSearchParams, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const errand = errandOf(parts[3]);
    if (errand.unit !== unit) refuse(403, "PRINCIPAL_SCOPE", `errand ${errand.id} is not station ${unit}'s`);
    const name = parts.slice(4).map(decodeURIComponent).join("/");
    if (!FILE_NAME.test(name) || name.includes("..")) refuse(400, "BAD_CALL", `"${name}" is not a file name`);
    if (errand.files.has(name)) refuse(400, "BAD_CALL", `errand ${errand.id} has a file "${name}" already`);
    const count = (key: string): number | null => (query.has(key) && /^\d+$/u.test(query.get(key)!) ? Number(query.get(key)) : null);
    const start = (): Upload => {
      makeUnder(filesDir, join(filesDir, errand.id));
      errand.writing.get(name)?.stop(new Refusal(409, "INTERRUPTED", `"${name}" was sent again from its first part`));
      const upload: Upload = new Upload(name, filesFolder.file(STATION_FILE, join(filesDir, errand.id, String(written++))), () => {
        if (errand.writing.get(name) === upload) errand.writing.delete(name);
      });
      errand.writing.set(name, upload);
      return upload;
    };
    const part = count("part");
    if (request.method === "PUT" && part !== null) {
      const upload = part === 0 ? start() : errand.writing.get(name);
      if (upload === undefined) refuse(400, "BAD_CALL", `part ${part} of "${name}" is out of order`);
      await upload.part(part, () => body(request, PART_BYTES, SILENT_MS));
      return answer(response, 201, { part });
    }
    const done = count("done");
    if (request.method === "POST" && done !== null) {
      const upload = done === 0 ? start() : errand.writing.get(name);
      if (upload === undefined) refuse(400, "BAD_CALL", `"${name}" has 0 parts, not ${done}`);
      const ref: FileRef = { name, ...(await upload.finish(done)) };
      errand.files.set(name, { ref, file: upload.file });
      return answer(response, 200, ref);
    }
    refuse(404, "NOT_FOUND", "no such route");
  }

  async function begin(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const sent = await json(request);
    const spec = sent.spec as ErrandSpec | undefined;
    if (!isObject(spec) || typeof spec.name !== "string" || !Array.isArray(spec.origins) || typeof spec.deadline_ms !== "number") {
      refuse(400, "BAD_CALL", "an errand has a spec: name, origins, deadline_ms");
    }
    const named = typeof sent.station === "string" ? sent.station : undefined;
    const site = typeof sent.site === "string" ? sent.site : undefined;
    const waitMs = typeof sent.wait_ms === "number" && sent.wait_ms > 0 ? Math.min(sent.wait_ms, MAX_WAIT_MS) : 0;
    prune();
    const there = (): boolean => (site === undefined || chosen().includes(site)) && peers.peers().some((state) => present(state) && (named === undefined || state.info.unit === named));
    const placing = await new Promise<{ errand: ErrandState; kept: boolean } | null>((placed) => {
      if (response.destroyed) return placed(null);
      const waiter: Waiter = { spec, named, site, placed };
      waiters.push(waiter);
      drain();
      if (!waiters.includes(waiter)) return;
      if (!there()) {
        waiters.splice(waiters.indexOf(waiter), 1);
        placed(null);
        return;
      }
      const give = (): void => {
        const at = waiters.indexOf(waiter);
        if (at === -1) return;
        waiters.splice(at, 1);
        placed(null);
      };
      response.once("close", () => {
        if (!response.writableFinished) give();
      });
      if (waitMs === 0) give();
      else setTimeout(give, waitMs);
    });
    if (placing === null) {
      if (response.destroyed) return;
      if (closed) notNow("busy", CLOSED, RETRY_SOON_S);
      const asked = named === undefined ? undefined : peers.get(named);
      if (asked !== undefined && present(asked)) refuse(409, "BUSY", `station ${named} has no free slot for ${spec.origins.join(", ")}`);
      if (named !== undefined) refuse(503, "NO_STATION", `station ${named} is not connected`);
      if (site !== undefined && !chosen().includes(site)) refuse(503, "NO_STATION", `${sites.find((each) => each.id === site)?.name ?? site} is not chosen: Lifestream reads it in no Chrome`);
      if (there()) refuse(409, "BUSY", `the Lifestream extension in every Chrome profile is busy with ${spec.origins.join(", ")} or has no free slot`);
      refuse(503, "NO_STATION", "no Chrome profile is running the Lifestream extension");
    }
    const { errand, kept } = placing;
    if (!kept) {
      const result = await errand.run(() => dispatch(errand, { id: `c-${hex(6)}`, errand: errand.id, op: "begin", spec: spec as unknown as JsonObject }, CALL_SLACK_MS));
      log(errand.id, { op: "begin", spec }, result);
      if (!result.ok) {
        forget(errand);
        drain();
        if (closed) notNow("busy", CLOSED, RETRY_SOON_S);
        refuse(result.error.code === "NO_STATION" ? 503 : 409, result.error.code, result.error.message);
      }
      if (!errand.begun()) {
        forget(errand);
        drain();
        if (closed) notNow("busy", CLOSED, RETRY_SOON_S);
        refuse(409, "INTERRUPTED", `errand ${errand.id} ended as the station began it`);
      }
      if (response.destroyed && !response.writableFinished) return close(errand);
    }
    const placed = peers.get(errand.unit);
    return answer(response, 201, { errand: errand.id, station: placed?.info ?? null });
  }

  function call(errand: ErrandState, sent: Op, response: ServerResponse): Promise<void> {
    const id = `c-${hex(6)}`;
    const logged = (result: Result): Result => {
      log(errand.id, sent, result);
      return result;
    };
    const step = errand.step();
    if (step !== "running") return answer(response, 200, logged(failure(id, "NO_ERRAND", `errand ${errand.id} ${REFUSED[step]}`)));
    if (typeof sent.op !== "string" || !OPS.has(sent.op)) return answer(response, 200, logged(failure(id, "BAD_CALL", `"${String(sent.op)}" is not an op`)));
    const heldInFile = sent.op === "fetch" && Array.isArray(sent.requests) ? sent.requests.findIndex((request) => isObject(request) && request.as === "file" && request.hold !== undefined) : -1;
    if (heldInFile !== -1) return answer(response, 200, logged(failure(id, "BAD_CALL", `request ${heldInFile} holds a value and keeps a file: \`hold\` reads a JSON body only`)));
    response.once("close", () => {
      if (!response.writableFinished && !standing().has(errand.id)) void close(errand);
    });
    const made = errand.run(async (): Promise<Result> => {
      try {
        checkSecrets(errand, sent);
        const sent_ms = clock();
        const result = await dispatch(errand, { ...sent, id, errand: errand.id } as Call, budgetOf(sent, slackMs));
        if (sent.op === "open" && result.ok) {
          await options.claimed?.({ station: errand.unit, tab: (result.value as { tab: number }).tab, errand: errand.id, from_ms: sent_ms - CLOCK_MS, until_ms: errand.expires + CLOCK_MS });
        }
        return withPaths(errand, sent, result);
      } catch (error) {
        if (!(error instanceof Refusal) || !(CODES as readonly string[]).includes(error.code)) throw error;
        return failure(id, error.code as Code, error.message.replace(/^\[[A-Z_]+\] /u, ""));
      }
    });
    return answer(response, 200, made.then(logged));
  }

  async function drive(request: IncomingMessage, response: ServerResponse, parts: string[]): Promise<void> {
    if (request.method === "GET" && parts[1] === "stations" && parts.length === 2) {
      return answer(response, 200, { stations: peers.peers().map((state) => ({ ...state.info, seen: state.seen, present: present(state) })), refused: refusedList() });
    }
    if (request.method === "POST" && parts[1] === "stations" && parts[3] === "reload" && parts.length === 4) {
      const state = peers.get(parts[2]!) ?? refuse(404, "NO_STATION", `no station ${parts[2]}`);
      if (state.info.development !== true) refuse(409, "BAD_CALL", "a store build never reloads itself");
      state.reload = true;
      wake();
      return answer(response, 202, { reload: state.info.unit });
    }
    if (parts[1] === "sites" && parts.length === 2) {
      if (request.method === "GET") return answer(response, 200, { sites: held() });
      if (request.method === "PUT") {
        const sent = await json(request);
        type Sent = { id?: unknown; name?: unknown; origin?: unknown; form?: unknown; signed_in?: unknown; account?: unknown; allowed?: unknown };
        if (sent.survey !== undefined && !Number.isSafeInteger(sent.survey)) refuse(400, "BAD_CALL", "a survey's number is an integer");
        const account = (value: unknown): boolean => value === undefined || value === null
          || (isObject(value) && ((text(value.email, 320) && value.name === undefined) || (text(value.name, 320) && value.email === undefined))
            && (VERDICTS as readonly string[]).includes(value.verdict as string));
        const valid = (site: Sent): boolean =>
          text(site.id, 100) && text(site.name, 200) && text(site.origin, 2_000) && (site.form === undefined || site.form === true)
          && (site.signed_in === null || typeof site.signed_in === "boolean") && account(site.account) && (site.allowed === undefined || site.allowed === false);
        if (!Array.isArray(sent.sites) || !sent.sites.every((site) => isObject(site) && valid(site as Sent))) {
          refuse(400, "BAD_CALL", "sites are each an id, a name, an origin, form true or none, signed_in, an account (an email or a name, and a verdict; or null), and allowed false or none");
        }
        const put = (sent.sites as unknown as (Omit<Site, "origins"> & { signed_in: boolean | null; account?: SiteAccount | null; allowed?: false })[])
          .map((site) => ({ ...site, origins: originsOf.get(site.id) ?? [site.origin] }));
        let changed: Record<string, boolean | null> = {};
        if (sent.station !== undefined) {
          const state = (typeof sent.station === "string" ? peers.get(sent.station) : undefined) ?? refuse(404, "NO_STATION", `no station ${String(sent.station)}`);
          const [before, was] = [state.probed, state.accounts];
          state.probed = Object.fromEntries(put.map((site) => [site.id, site.signed_in ?? before[site.id] ?? null]));
          const kept = (site: (typeof put)[number]): SiteAccount | null => (site.account == null ? null
            : { ...("email" in site.account ? { email: site.account.email } : { name: site.account.name }), verdict: site.account.verdict });
          state.accounts = Object.fromEntries(put.map((site) => [site.id, site.signed_in === null ? was[site.id] ?? null : kept(site)]));
          state.refused = new Set(put.filter((site) => site.allowed === false || (site.signed_in === null && state.refused.has(site.id))).map((site) => site.id));
          state.put = Math.max(state.put, typeof sent.survey === "number" ? sent.survey : state.owed);
          const moved = (id: string): boolean => (before[id] ?? null) !== state.probed[id] || JSON.stringify(was[id] ?? null) !== JSON.stringify(state.accounts[id]);
          changed = Object.fromEntries(Object.entries(state.probed).filter(([id]) => moved(id)));
        }
        sites = put.map(siteOf);
        wake();
        return answer(response, 200, { sites: sites.length, changed });
      }
    }
    if (request.method === "POST" && parts[1] === "sites" && parts.length === 2) {
      wake();
      return answer(response, 202, { asked: peers.peers().filter(present).map((state) => state.info.unit) });
    }
    if (parts[1] !== "errands") refuse(404, "NOT_FOUND", "no such route");
    if (request.method === "POST" && parts.length === 2) return begin(request, response);
    const errand = errandOf(parts[2]);
    if (request.method === "POST" && parts[3] === "calls" && parts.length === 4) return call(errand, (await json(request)) as Op, response);
    if (request.method === "GET" && parts[3] === "files" && parts.length >= 5) {
      const name = parts.slice(4).map(decodeURIComponent).join("/");
      const kept = errand.files.get(name);
      const opened = await kept?.file.open();
      if (kept === undefined || opened === undefined) refuse(404, "NOT_FOUND", `errand ${errand.id} has no file "${name}"`);
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": kept.ref.bytes });
      void pipeline(opened.reading(), response).catch(() => undefined).finally(() => opened.close());
      return;
    }
    if (request.method === "DELETE" && parts.length === 3) {
      await close(errand);
      return answer(response, 200, { ended: errand.id, files: [...errand.files.keys()] });
    }
    refuse(404, "NOT_FOUND", "no such route");
  }

  return {
    sites: held,
    present: () => peers.peers().filter(present).map((state) => state.info.unit),
    refused: refusedList,
    async below(unit, version, request) {
      const sent = await body(request, REFUSED_JSON, SILENT_MS).then((read) => JSON.parse(read.toString("utf8")) as unknown).catch(() => null);
      const development = isObject(sent) && isObject(sent.station) && sent.station.development === true;
      const now = clock();
      const was = refusedAt.get(unit);
      refusedAt.set(unit, { unit, version, development, since_ms: was?.version === version ? was.since_ms : now, at_ms: now });
    },
    half(method, pathname) {
      const parts = pathname.split("/").filter((part) => part !== "");
      if (parts[0] !== "v1") return null;
      if (parts[1] === "stations" && (parts[2] === "exchange" || parts[2] === "files")) return "peer";
      if (parts[1] === "errands" || parts[1] === "sites") return "drive";
      if (parts[1] === "stations" && (parts.length === 2 || (parts.length === 4 && parts[3] === "reload" && method === "POST"))) return "drive";
      return null;
    },
    async serve(caller, request, response) {
      const url = new URL(request.url ?? "/", "http://door");
      const parts = url.pathname.split("/").filter((part) => part !== "");
      if ("peer" in caller) {
        if (request.method === "POST" && parts[2] === "exchange" && parts.length === 3) return exchange(caller.peer, request, response);
        if (parts[2] === "files" && parts.length >= 5) return file(caller.peer, parts, url.searchParams, request, response);
        refuse(404, "NOT_FOUND", "no such route");
      }
      return drive(request, response, parts);
    },
    close() {
      closed = true;
      clearInterval(sweeper);
      clearInterval(needing);
      for (const waiter of waiters.splice(0)) waiter.placed(null);
      for (const errand of errands.values()) {
        errand.end();
        stopWriting(errand, `the door closed while ${errand.id} sent a file`);
      }
      peers.close();
    },
  };
}


interface Alone {
  url: string;
  drive_token: string;
  code: string;
  stations: Record<string, string>;
}

export interface AloneOptions {
  readonly port?: number;
  readonly host?: string;
  readonly floor?: string;
  readonly home?: HomeNamed;
  readonly idle_ms?: number;
  readonly sweep_ms?: number;
  readonly poll_ms?: number;
  readonly presence_ms?: number;
}

export async function serveStations(state: string, options: AloneOptions = {}): Promise<{ url: string; close(): Promise<void> }> {
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const file = join(state, "relay.json");
  const read = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Partial<Alone>) : {};
  const kept: Omit<Alone, "url"> = {
    drive_token: read.drive_token ?? randomBytes(32).toString("base64url"),
    code: read.code ?? String(randomInt(10 ** 8)).padStart(8, "0"),
    stations: read.stations ?? {},
  };
  const floor = options.floor ?? "0";
  let url = "";
  const save = (): void => writeDurably(file, `${JSON.stringify({ url, ...kept }, null, 2)}\n`, 0o600);
  const needsFile = join(state, "needs.json");
  let held: { at: number; needs: Need[] } = { at: -1, needs: [] };
  const chosenFile = join(state, "chosen.json");
  const listed = (): string[] => (existsSync(chosenFile) ? (JSON.parse(readFileSync(chosenFile, "utf8")) as string[]) : []);
  const stations = openStations({
    files: { folder: openHomeFolder(state), dir: join(state, "files") },
    home: options.home ?? { version: RELEASE, generation: GENERATION },
    needs: () => {
      const at = existsSync(needsFile) ? statSync(needsFile).mtimeMs : 0;
      if (at !== held.at) held = { at, needs: at === 0 ? [] : (JSON.parse(readFileSync(needsFile, "utf8")) as Need[]) };
      return held.needs;
    },
    opened: (unit, ids) => {
      for (const id of ids) appendFileSync(join(state, "opened.jsonl"), `${JSON.stringify({ at: Date.now(), unit, id })}\n`, { mode: 0o600 });
    },
    acted: (unit, acts) => {
      for (const act of acts) appendFileSync(join(state, "acted.jsonl"), `${JSON.stringify({ at: Date.now(), unit, ...act })}\n`, { mode: 0o600 });
    },
    claimed: async (claim) => appendFileSync(join(state, "claims.jsonl"), `${JSON.stringify({ at: Date.now(), ...claim })}\n`, { mode: 0o600 }),
    chosen: listed,
    changed: ({ pressed }) => {
      if (pressed.choose.length === 0 && pressed.stop.length === 0) return undefined;
      const next = chosenWith(stations.sites().map((site) => site.id), listed(), pressed.choose, pressed.stop);
      writeDurably(chosenFile, `${JSON.stringify(next)}\n`, 0o600);
      return undefined;
    },
    log: (entry) => appendFileSync(join(state, "transcript.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 }),
    ...(options.idle_ms === undefined ? {} : { idle_ms: options.idle_ms }),
    ...(options.sweep_ms === undefined ? {} : { sweep_ms: options.sweep_ms }),
    ...(options.poll_ms === undefined ? {} : { poll_ms: options.poll_ms }),
    ...(options.presence_ms === undefined ? {} : { presence_ms: options.presence_ms }),
  });
  const hashOf = (pass: string): string => createHash("sha256").update(pass).digest("hex");
  const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  const bearer = (request: IncomingMessage): string => /^Bearer (\S+)$/u.exec(request.headers.authorization ?? "")?.[1] ?? "";

  const device = (request: IncomingMessage): void => {
    const stated = deviceHeader(request.headers["lifestream-device"]);
    if (stated === null || stated.kind !== "extension" || belowFloor({ mac: "0", phone: "0", extension: floor, runner: "0" }, "extension", stated.version)) {
      refuse(426, "DEVICE_TOO_OLD", `this extension is older than the stations serve: update it to ${floor} or later`, undefined, { floor });
    }
  };

  const pair = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    device(request);
    const sent = await json(request);
    if (sent.kind !== "extension" || typeof sent.pass !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(sent.pass) || typeof sent.unit !== "string" || !UNIT.test(sent.unit)) {
      refuse(422, "PAIR_REQUEST", "an extension pairs with its code, its pass and its unit");
    }
    const hash = hashOf(sent.pass);
    if (kept.stations[sent.unit] !== hash) {
      if (typeof sent.code !== "string" || !same(sent.code, kept.code)) refuse(403, "PAIR_CODE", "this code does not pair");
      kept.stations[sent.unit] = hash;
      save();
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ unit: sent.unit, answer: { home: { id: "stations", version: "development", floors: { extension: floor } }, unit: sent.unit, needs: [], calls: [] } }));
  };

  const server = createServer((request, response) => {
    allowExtension(request, response);
    if (request.method === "OPTIONS") return void response.writeHead(204).end();
    void (async () => {
      try {
        const path = new URL(request.url ?? "/", "http://stations").pathname;
        if (request.method === "POST" && path === "/v1/pair") return await pair(request, response);
        const half = stations.half(request.method, path) ?? refuse(404, "NOT_FOUND", "no such route");
        const pass = bearer(request);
        if (half === "drive") {
          if (!same(pass, kept.drive_token)) refuse(401, "PRINCIPAL_UNKNOWN", "unknown pass");
          return await stations.serve({ drive: true }, request, response);
        }
        const unit = Object.entries(kept.stations).find(([, hash]) => same(hash, hashOf(pass)))?.[0] ?? refuse(401, "PRINCIPAL_UNKNOWN", "unknown pass");
        device(request);
        await stations.serve({ peer: unit }, request, response);
      } catch (error) {
        const refusal = error instanceof Refusal ? error : new Refusal(500, "STATIONS_FAILED", error instanceof Error ? error.message : String(error));
        if (response.headersSent) response.end();
        else response.writeHead(refusal.status, { "content-type": "application/json" }).end(JSON.stringify({ code: refusal.code, message: refusal.words, ...refusal.extra }));
      }
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 4690, options.host ?? "127.0.0.1", () => resolve()));
  url = `http://${options.host ?? "127.0.0.1"}:${(server.address() as AddressInfo).port}`;
  save();
  return {
    url,
    close: () =>
      new Promise((resolve) => {
        stations.close();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
