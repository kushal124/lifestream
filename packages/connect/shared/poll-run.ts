import { readFileSync } from "node:fs";
import { parse, type JsonObject, type MemoryChanges, type Months } from "@lifestreamprotocol/core";
import { HOME_FACTS, NeedsYou, NotYet, type Acquirer, type Fetched, type FetchedFile, type Lent, type Memory, type Secrets } from "../seams.js";
import { byBytes, callMemory, cursorText, type Remembered } from "./memory.js";

export interface KeptPoll {
  state: JsonObject | null;
  memory?: Map<string, Map<string, string>>;
  changes?: MemoryChanges;
  next?: { more?: true; next_ms?: number; backoff_ms?: number; answered?: false };
  left?: number | null;
  facts?: JsonObject;
  from_ms?: number | null;
}

export interface Sealing {
  readonly files: Readonly<Record<string, Buffer>>;
  readonly facts: JsonObject;
  readonly source: string;
}

export async function pollCall<T>(
  acquirer: Acquirer, kept: KeptPoll, secrets: Secrets, call: "fetch" | "page", seal: (sealing: Sealing) => T | Promise<T>, lent: Omit<Lent, "memory" | "from_ms"> = LENT,
): Promise<T | undefined> {
  const memory = callMemory(remembered(kept));
  const given: Lent = { ...lent, from_ms: kept.state === null ? undefined : kept.from_ms ?? null, memory };
  let fetched: Fetched & { more?: true; next_ms?: number; left?: number | null; months?: Months };
  kept.changes = NOTHING_CHANGED;
  const state = kept.state !== null && Object.keys(kept.state).length === 0 ? null : kept.state;
  try {
    if (call === "page" && acquirer.page === undefined) throw new Error(`${acquirer.name} has no page`);
    fetched = call === "fetch" ? await acquirer.fetch(state, secrets, given) : await acquirer.page!(state, secrets, given);
  } catch (error) {
    if ((error instanceof NotYet || error instanceof NeedsYou) && error.state !== undefined) leave(kept, cursorText(error.state), memory.end(), lent.start_ms);
    else memory.end();
    throw error;
  }
  const cursor = cursorText(fetched.state);
  const changes = memory.end();
  const facts = sealedFacts(acquirer.name, call, fetched, lent.start_ms);
  kept.next = { ...(fetched.more === undefined ? {} : { more: fetched.more }), ...(fetched.next_ms === undefined ? {} : { next_ms: fetched.next_ms }), ...(fetched.backoff_ms === undefined ? {} : { backoff_ms: fetched.backoff_ms }), ...(fetched.answered === false ? { answered: false as const } : {}) };
  kept.facts = fetched.facts;
  if (call === "page") kept.left = fetched.left ?? null;
  if (facts === null) {
    leave(kept, cursor, changes, lent.start_ms);
    return undefined;
  }
  const files: Record<string, Buffer> = {};
  for (const file of fetched.files) {
    if (files[file.path] !== undefined) throw new Error(`the acquirer fetched ${file.path} twice`);
    files[file.path] = fetchedBytes(file);
  }
  const stated = Array.isArray(fetched.facts.sources) && fetched.facts.sources.length === 1 ? (fetched.facts.sources[0] as { id?: unknown }).id : undefined;
  const sealed = await seal({ files, facts, source: typeof stated === "string" ? stated : acquirer.source });
  leave(kept, cursor, changes, lent.start_ms);
  return sealed;
}

export function sealedFacts(name: string, call: "fetch" | "page", fetched: Fetched & { left?: number | null; months?: Months }, start_ms: number | null): JsonObject | null {
  const stating = HOME_FACTS.filter((fact) => Object.hasOwn(fetched.facts, fact));
  if (stating.length > 0) throw new Error(`acquirer ${name}'s facts state ${stating.join(", ")}, which only the home states of a page`);
  if ((call === "page" || fetched.files.length > 0) && Object.hasOwn(fetched.facts, "read_through")) throw new Error(`acquirer ${name}'s facts state read_through beside what it seals: only a fetch that answered nothing new states it`);
  if (call === "fetch" && fetched.files.length === 0) return null;
  const facts = fetched.facts.exported_at === undefined ? fetched.facts : { ...fetched.facts, history: true };
  if (call === "fetch") return facts;
  const left = fetched.left;
  if (left !== null && !(Number.isSafeInteger(left) && left! >= 0)) throw new Error(`acquirer ${name}'s page says ${JSON.stringify(left)} left: a count, or null while it cannot count`);
  return { ...facts, history: true, left: left!, start_ms, ...(fetched.months === undefined ? {} : { months: fetched.months }) };
}

const NOTHING_CHANGED: MemoryChanges = { cleared: [], entries: [] };

export function fetchedBytes(file: FetchedFile): Buffer {
  return "bytes" in file ? file.bytes : readFileSync(file.file);
}

function remembered(kept: KeptPoll): Remembered {
  return {
    get: (part, key) => kept.memory?.get(part)?.get(key),
    after: (part, after, limit) =>
      [...(kept.memory?.get(part) ?? [])]
        .filter(([key]) => after === null || byBytes(key, after) > 0)
        .sort(([a], [b]) => byBytes(a, b))
        .slice(0, limit),
  };
}

function leave(kept: KeptPoll, cursor: string, changes: MemoryChanges, start_ms: number | null): void {
  kept.state = parse(cursor) as JsonObject;
  kept.from_ms = start_ms;
  kept.changes = changes;
  const memory = (kept.memory ??= new Map());
  for (const part of changes.cleared) memory.delete(part);
  for (const [part, key, value] of changes.entries) {
    const entries = memory.get(part) ?? new Map<string, string>();
    if (value === null) entries.delete(key);
    else entries.set(key, value);
    if (entries.size === 0) memory.delete(part);
    else memory.set(part, entries);
  }
}


export function memorySecrets(values: Record<string, string>): Secrets & { values: Record<string, string> } {
  return {
    values,
    get: (service) => values[service],
    rotate(service, value) {
      values[service] = value;
    },
  };
}

export const NO_MEMORY: Memory = {
  get: () => undefined,
  list: () => [],
  put: keepsNoMemory,
  drop: keepsNoMemory,
  clear: keepsNoMemory,
};

function keepsNoMemory(): never {
  throw new Error("this test lends no poll memory: a call that changes it is driven through the `poll` run (connect/shared/poll-run.ts), which keeps one");
}

export const LENT: Lent = {
  stations: new Proxy({}, { get: (_, member) => () => { throw new Error(`this test lends no station: ${String(member)}`); } }) as Lent["stations"],
  accounts: {},
  start_ms: null,
  from_ms: undefined,
  memory: NO_MEMORY,
};

export function lending<A extends Acquirer>(acquirer: A, start_ms: number | null, extra: Partial<Lent> = {}): A {
  const lent = (given: Lent | undefined): Lent => ({
    stations: given?.stations ?? (undefined as never), accounts: given?.accounts ?? {}, memory: given?.memory ?? NO_MEMORY, from_ms: given?.from_ms === undefined ? undefined : start_ms, ...extra, start_ms,
  });
  return {
    ...acquirer,
    fetch: (state: JsonObject | null, secrets: Secrets, given?: Lent) => acquirer.fetch(state, secrets, lent(given)),
    ...(acquirer.page === undefined ? {} : { page: (state: JsonObject | null, secrets: Secrets, given?: Lent) => acquirer.page!(state, secrets, lent(given)) }),
  };
}
