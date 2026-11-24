import {
  afterStop, clientRefresher, feeds, instantMs, isObject, isStop, movedEarlier, request, rfc3339,
  type Acquirer, type AcquirerSettings, type Budget, type Dependencies, type Fetched, type FetchedFile, type JsonObject, type Lent, type Memory, type Secrets, type Stop,
} from "@lifestreamprotocol/connect/sdk";

export const API = "https://api.example.com";
const PER_CALL = 50;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const ID = /^[\w-]+$/u;
const EXAMPLE = clientRefresher("Example");

export interface ExampleOauthFields {
  account: string;
  token: string;
}

export interface ExampleOauthState {
  fresh: { since_ms: number; newest_ms: number; after: string | null };
  history: { before_ms: number; after: string | null } | null;
}

export const AT_INSTANT = "at-instant";
export const AT_NEWEST = "at-newest";

interface Listed {
  notes: JsonObject[];
  next: string | null;
  remaining: number | null;
}

export function exampleOauthAcquirer(settings: AcquirerSettings<ExampleOauthFields>, dependencies: Dependencies = {}): Acquirer {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const source = `example-oauth:${settings.account}:cloud`;

  const list = async (query: Record<string, string | number | null>, secrets: Secrets, budget: Budget): Promise<Listed | Stop> => {
    const url = new URL("/v1/notes", API);
    for (const [name, value] of Object.entries(query)) if (value !== null) url.searchParams.set(name, String(value));
    const answer = await request(url, { headers: { accept: "application/json" } }, { budget, fetch, now, refresher: EXAMPLE, secrets, secret: settings.token });
    if (isStop(answer)) return answer;
    if (!answer.ok) throw new Error(`Example answered ${answer.status} listing notes`);
    const body = (await answer.json()) as unknown;
    if (!isObject(body) || !Array.isArray(body.notes) || !body.notes.every((note) => isObject(note) && typeof note.id === "string" && ID.test(note.id))) {
      throw new Error("Example's listing is not { notes: [{ id, … }], next }");
    }
    return { notes: body.notes as JsonObject[], next: typeof body.next === "string" ? body.next : null, remaining: typeof body.remaining === "number" ? body.remaining : null };
  };

  const begin = (state: JsonObject | null, lent: Lent) => {
    if (!EMAIL.test(settings.account)) throw new Error("account must be the email Example's sign-in wrote");
    const at = now();
    const cursor: ExampleOauthState = structuredClone(state as unknown as ExampleOauthState | null) ?? { fresh: { since_ms: at, newest_ms: at, after: null }, history: { before_ms: at, after: null } };
    cursor.history = historyUnder(cursor.history, lent);
    return { at, cursor };
  };

  const delivered = (at: number, kept: FetchedFile[], cursor: ExampleOauthState): Fetched => ({
    files: kept, facts: { fetched_at: rfc3339(at), ...feeds(source, "example-oauth") }, state: cursor as unknown as JsonObject,
  });
  const keep = (note: JsonObject): FetchedFile => ({ path: `notes/${note.id as string}.json`, bytes: Buffer.from(JSON.stringify(note)) });

  return {
    name: "example-oauth",
    source,
    secrets: [settings.token],
    async fetch(state, secrets, lent) {
      const { at, cursor } = begin(state, lent);
      const { fresh } = cursor;
      const budget = { left: PER_CALL };
      const kept: FetchedFile[] = [];
      for (;;) {
        const page = await list({ updated_since: fresh.since_ms, after: fresh.after }, secrets, budget);
        if (isStop(page)) return { ...delivered(at, kept, cursor), ...afterStop(page, kept.length > 0, cursor as unknown as JsonObject, "Example") };
        for (const note of page.notes) {
          const id = note.id as string;
          const updated = instantMs(String(note.updated_at)) ?? fresh.since_ms;
          if (updated <= fresh.since_ms) {
            if (lent.memory.get(AT_INSTANT, id) !== undefined) continue;
            lent.memory.put(AT_INSTANT, id, true);
          } else {
            if (updated > fresh.newest_ms) {
              lent.memory.clear(AT_NEWEST);
              fresh.newest_ms = updated;
            }
            if (updated === fresh.newest_ms) lent.memory.put(AT_NEWEST, id, true);
          }
          kept.push(keep(note));
        }
        fresh.after = page.next;
        if (page.next !== null) continue;
        settle(lent.memory, fresh);
        return delivered(at, kept, cursor);
      }
    },
    async page(state, secrets, lent) {
      const { at, cursor } = begin(state, lent);
      if (cursor.history === null) return { ...delivered(at, [], cursor), left: 0 };
      const page = await list({ updated_before: cursor.history.before_ms, updated_since: lent.start_ms, after: cursor.history.after }, secrets, { left: 1 });
      if (isStop(page)) return { ...delivered(at, [], cursor), left: null, ...afterStop(page, false, cursor as unknown as JsonObject, "Example") };
      cursor.history = page.next === null ? null : { before_ms: cursor.history.before_ms, after: page.next };
      return { ...delivered(at, page.notes.map(keep), cursor), left: page.next === null ? 0 : page.remaining };
    },
  };
}

function settle(memory: Memory, fresh: ExampleOauthState["fresh"]): void {
  if (fresh.newest_ms === fresh.since_ms) return;
  memory.clear(AT_INSTANT);
  for (let ids = memory.list(AT_NEWEST); ids.length > 0; ids = memory.list(AT_NEWEST, ids.at(-1)![0])) {
    for (const [id] of ids) memory.put(AT_INSTANT, id, true);
  }
  memory.clear(AT_NEWEST);
  fresh.since_ms = fresh.newest_ms;
}

function historyUnder(history: ExampleOauthState["history"], { start_ms, from_ms }: Lent): ExampleOauthState["history"] {
  if (from_ms === undefined || start_ms === from_ms) return history;
  if (history !== null) return { before_ms: history.before_ms, after: null };
  const gap = movedEarlier({ start_ms, from_ms });
  return gap === null ? null : { before_ms: gap, after: null };
}
