import { createHash } from "node:crypto";
import { afterStop, answered, feeds, isObject, movedEarlier, NeedsYou, readJson, Refused, request, rfc3339, Stopped, utf8, type Acquirer, type Budget, type Fetched, type FetchedFile, type Json, type JsonObject, type Lent, type Secrets, type Stop } from "@lifestreamprotocol/connect/sdk";
import { API_FORMAT, PULL_MANIFEST } from "./answers.js";

function refuse(message: string): never {
  throw new Refused(`granola-api: ${message}`);
}

export const API = "https://public-api.granola.ai";
const LIST_SIZE = 30;
const TRANSCRIPT_SIZE = 100;
const PER_POLL = 200;
const GAP_MS = 250;
const MARGIN_MS = 10 * 60_000;
const SEALED = "sealed";

type Memory = Parameters<Acquirer["fetch"]>[2]["memory"];
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const ID = /^[\w-]+$/u;

export interface GranolaApiSettings {
  account: string;
  key: string;
  per_poll?: number;
}

export interface GranolaApiDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface Listing {
  cursor: string | null;
  read: Record<string, string>;
}

export interface GranolaApiState {
  cursor_ms: number;
  walk?: Listing & { from_ms: number; began_ms: number; newest_ms: number | null };
  backfill?: Listing & { before_ms: number; oldest_ms: number | null; done?: true };
}

export function granolaApiAcquirer(settings: GranolaApiSettings, dependencies: GranolaApiDependencies = {}): Acquirer {
  const now = dependencies.now ?? Date.now;
  const source = `granola:${settings.account}:cloud`;
  const begin = (state: JsonObject | null, secrets: Secrets, lent: Lent) => {
    if (typeof settings.account !== "string" || !EMAIL.test(settings.account)) refuse("account must be the Granola account's email");
    const perPoll = settings.per_poll ?? PER_POLL;
    if (!Number.isSafeInteger(perPoll) || perPoll < 4) refuse("per_poll must be a whole number, 4 or more");
    const key = secrets.get(settings.key);
    if (key === undefined || key.trim() === "") throw new NeedsYou("signed-out", `no API key is sealed under ${settings.key}`, { answered: false });
    const at = now();
    const previous = state as unknown as GranolaApiState | null;
    const next: GranolaApiState = structuredClone(previous ?? { cursor_ms: at });
    const gap = movedEarlier(lent);
    if (next.backfill?.done === true && gap !== null) next.backfill = { before_ms: gap, oldest_ms: null, cursor: null, read: {} };
    return { at, next, session: new Session(dependencies, key.trim(), { left: perPoll }) };
  };
  const sealed = (session: Session, next: GranolaApiState, at: number, stopped: Stop | undefined): Fetched & { more?: true } => {
    const fetchedAt = rfc3339(at);
    const after = afterStop(stopped, session.notes.length > 0, next as unknown as JsonObject, "Granola");
    const stop = stopped === undefined ? {} : { stopped: stopped.stop === "limit" ? "rate-limit" : stopped.stop };
    const manifest = { format: API_FORMAT, complete: true, account: settings.account, fetched_at: fetchedAt, requests: session.requests, ...stop, notes: session.notes };
    return {
      files: session.notes.length === 0 ? [] : [...session.files, { path: PULL_MANIFEST, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) }],
      facts: {
        fetched_at: fetchedAt, account: settings.account, notes: session.notes.length, requests: session.requests, ...stop,
        ...(session.skipped.length === 0 ? {} : { skipped: session.skipped }), ...feeds(source, "granola-api"),
      },
      state: next as unknown as JsonObject,
      ...(session.requests === 0 ? { answered: false as const } : {}),
      ...after,
    };
  };
  return {
    name: "granola-api",
    source,
    async fetch(state, secrets, lent) {
      const { at, next, session } = begin(state, secrets, lent);
      const walk = (next.walk ??= { from_ms: next.cursor_ms - 1, began_ms: at, newest_ms: null, cursor: null, read: {} });
      let stopped: Stop | undefined;
      try {
        const created = lent.start_ms === null ? {} : { created_after: rfc3339(lent.start_ms - 1) };
        await list(session, lent.memory, walk, () => ({ updated_after: rfc3339(walk.from_ms), ...created }), Number.POSITIVE_INFINITY, (summary) => {
          walk.newest_ms = Math.max(walk.newest_ms ?? Number.NEGATIVE_INFINITY, summary.updated_ms);
        }, () => {
          walk.cursor = null;
          walk.read = {};
        });
        if (walk.newest_ms !== null) next.cursor_ms = Math.max(next.cursor_ms, Math.min(walk.newest_ms, walk.began_ms - MARGIN_MS));
        delete next.walk;
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        stopped = error.stop;
      }
      return sealed(session, next, at, stopped);
    },
    async page(state, secrets, lent) {
      const { at, next, session } = begin(state, secrets, lent);
      const floor = lent.start_ms;
      const backfill = (next.backfill ??= { before_ms: at, oldest_ms: null, cursor: null, read: {} });
      let stopped: Stop | undefined;
      if (backfill.done !== true) {
        try {
          const query = () => ({ created_before: rfc3339(backfill.before_ms), ...(floor === null ? {} : { created_after: rfc3339(floor - 1) }) });
          const ended = await list(session, lent.memory, backfill, query, 1, (summary) => {
            backfill.oldest_ms = Math.min(backfill.oldest_ms ?? Number.POSITIVE_INFINITY, summary.created_ms);
          }, () => {
            if (backfill.oldest_ms !== null) backfill.before_ms = backfill.oldest_ms + 1;
            backfill.cursor = null;
            backfill.read = {};
          });
          if (ended) backfill.done = true;
        } catch (error) {
          if (!(error instanceof Stopped)) throw error;
          stopped = error.stop;
        }
      }
      const { more: _more, ...ended } = sealed(session, next, at, stopped);
      return { ...ended, left: backfill.done === true ? 0 : null };
    },
  };
}

interface Summary {
  id: string;
  updated_at: string;
  updated_ms: number;
  created_ms: number;
}

async function list(session: Session, memory: Memory, listing: Listing, query: () => Record<string, string>, pages: number, sealedOne: (summary: Summary) => void, restart: () => void): Promise<boolean> {
  let restarted = false;
  for (let page = 0; page < pages; page++) {
    const params = new URLSearchParams({ ...query(), page_size: String(LIST_SIZE), ...(listing.cursor === null ? {} : { cursor: listing.cursor }) });
    const answer = await session.api(`/v1/notes?${params}`, [400]);
    if (answer.status === 400) {
      if (listing.cursor === null || restarted) refuse(`the list ${params} answered HTTP 400`);
      restarted = true;
      restart();
      page--;
      continue;
    }
    const body = object(answer.json(), "a list");
    const notes = Array.isArray(body.notes) ? body.notes : refuse("a list states no notes");
    for (const [index, value] of notes.entries()) {
      const summary = summaryOf(value, `a list's notes[${index}]`);
      if (listing.read[summary.id] === summary.updated_at) continue;
      if (memory.get(SEALED, summary.id) !== summary.updated_at && await session.note(summary.id)) {
        sealedOne(summary);
        memory.put(SEALED, summary.id, summary.updated_at);
      }
      listing.read[summary.id] = summary.updated_at;
    }
    if (body.hasMore !== true) return true;
    listing.cursor = typeof body.cursor === "string" && body.cursor !== "" ? body.cursor : refuse("a list has more and states no cursor");
    listing.read = {};
  }
  return false;
}

function summaryOf(value: Json, where: string): Summary {
  const note = object(value, where);
  const id = typeof note.id === "string" && ID.test(note.id) ? note.id : refuse(`${where} states no id`);
  const updated_at = typeof note.updated_at === "string" ? note.updated_at : refuse(`${where} states no updated_at`);
  const created_at = typeof note.created_at === "string" ? note.created_at : refuse(`${where} states no created_at`);
  const [updated_ms, created_ms] = [Date.parse(updated_at), Date.parse(created_at)];
  if (!Number.isFinite(updated_ms) || !Number.isFinite(created_ms)) refuse(`${where} states a time that does not read`);
  return { id, updated_at, updated_ms, created_ms };
}

interface Named {
  file: string;
  sha256: string;
  bytes: number;
}

export interface ManifestNote extends Named {
  id: string;
  transcript: Named[];
  attachments: (Named & { id: string })[];
}

interface Answer {
  status: number;
  bytes: Buffer;
  json(): Json;
}

class Session {
  readonly files: FetchedFile[] = [];
  readonly notes: ManifestNote[] = [];
  readonly skipped: string[] = [];
  requests = 0;
  #last = Number.NEGATIVE_INFINITY;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly dependencies: GranolaApiDependencies;
  readonly key: string;
  readonly budget: Budget;

  constructor(dependencies: GranolaApiDependencies, key: string, budget: Budget) {
    this.dependencies = dependencies;
    this.key = key;
    this.budget = budget;
    this.#now = dependencies.now ?? Date.now;
    this.#sleep = dependencies.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async api(path: string, allowed: readonly number[] = []): Promise<Answer> {
    const wait = this.#last + GAP_MS - this.#now();
    if (wait > 0) await this.#sleep(wait);
    this.#last = this.#now();
    const response = await this.#send(new URL(path, API), { authorization: `Bearer ${this.key}`, accept: "application/json" });
    return this.#answer(response, path, allowed);
  }

  async note(id: string): Promise<boolean> {
    if (this.notes.some((note) => note.id === id)) return true;
    const answer = await this.api(`/v1/notes/${id}?include=transcript`, [404, 413]);
    if (answer.status === 404) {
      this.skipped.push(id);
      return false;
    }
    this.budget.pass = true;
    try {
      return await this.#whole(id, answer);
    } finally {
      this.budget.pass = false;
    }
  }

  async #whole(id: string, first: Answer): Promise<true> {
    let answer = first;
    const files: FetchedFile[] = [];
    const named = (path: string, bytes: Buffer): Named => {
      files.push({ path, bytes });
      return { file: path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    };
    const transcript: Named[] = [];
    if (answer.status === 413) {
      answer = await this.api(`/v1/notes/${id}`);
      for (let cursor: string | null = null, page = 1; ; page++) {
        const params = new URLSearchParams({ page_size: String(TRANSCRIPT_SIZE), ...(cursor === null ? {} : { cursor }) });
        const lines = await this.api(`/v1/notes/${id}/transcript?${params}`);
        transcript.push(named(`notes/${id}/transcript-${String(page).padStart(4, "0")}.json`, lines.bytes));
        const body = object(lines.json(), `${id}'s transcript`);
        if (body.hasMore !== true) break;
        cursor = typeof body.cursor === "string" && body.cursor !== "" ? body.cursor : refuse(`${id}'s transcript has more and states no cursor`);
      }
    }
    const note = object(answer.json(), `note ${id}`);
    const attachments: ManifestNote["attachments"] = [];
    for (const [index, value] of (Array.isArray(note.attachments) ? note.attachments : []).entries()) {
      const attachment = object(value, `${id}'s attachments[${index}]`);
      const attachmentId = typeof attachment.id === "string" && ID.test(attachment.id) ? attachment.id : refuse(`${id}'s attachments[${index}] states no id`);
      const url = typeof attachment.url === "string" ? attachment.url : refuse(`${id}'s attachment ${attachmentId} states no url`);
      const bytes = await this.attachment(url, `${id}'s attachment ${attachmentId}`);
      attachments.push({ id: attachmentId, ...named(`notes/${id}/attachments/${attachmentId}`, bytes) });
    }
    const entry: ManifestNote = { id, ...named(`notes/${id}.json`, answer.bytes), transcript, attachments };
    this.files.push(...files);
    this.notes.push(entry);
    return true;
  }

  async attachment(url: string, what: string): Promise<Buffer> {
    let address: URL;
    try {
      address = new URL(url);
    } catch {
      return refuse(`${what}'s url is no address`);
    }
    if (address.protocol !== "https:") refuse(`${what}'s url is not https`);
    return (await this.#answer(await this.#send(address, {}), what, [])).bytes;
  }

  async #send(url: URL, headers: Record<string, string>): Promise<Response> {
    const answer = answered(await request(url, { method: "GET", headers: { ...headers, "user-agent": "lifestream-home" } }, { budget: this.budget, ...this.dependencies }));
    this.requests++;
    return answer;
  }

  async #answer(response: Response, what: string, allowed: readonly number[]): Promise<Answer> {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok && !allowed.includes(response.status)) refuse(`${what.replace(/\?.*$/u, "")} answered HTTP ${response.status}`);
    return { status: response.status, bytes, json: () => readJson(utf8(bytes, what), what) };
  }
}

function object(value: Json, where: string): JsonObject {
  if (!isObject(value)) refuse(`${where} is not an object`);
  return value;
}
