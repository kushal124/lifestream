import { request as https } from "node:https";
import {
  afterStop, clientRefresher, feeds, movedEarlier, NeedsYou, NotYet, request, rfc3339,
  type Acquirer, type Dependencies, type FetchedFile, type JsonObject, type Lent, type Months, type RequestOptions, type Secrets,
} from "@lifestreamprotocol/connect/sdk";

export const ORIGIN = "https://api.example.com";
export const PAGE = 3;
const PER_CALL = 4;
const AT_INSTANT = "at-instant";
const QUIET = "quiet";
const DAY = 86_400_000;
const SYNTHETIC = clientRefresher("Synthetic");

export interface Flaws {
  direct?: true;
  grows?: true;
  losesRest?: true;
  dropsSecondPage?: true;
  noPage?: true;
  endless?: true;
  open?: true;
  oauth?: true;
  bearer?: true;
  unrotated?: true;
  swallows?: true;
  spins?: true;
  connects?: true;
  untitled?: true;
  homeFacts?: true;
  blind?: true;
  backwards?: true;
  losesFirst?: true;
  growsFirst?: true;
  daily?: true;
  due?: true;
  resends?: true;
  idles?: true;
  deaf?: true;
  mute?: true;
  unfloored?: true;
  byTime?: true;
  pageOnly?: true;
  ownStart?: true;
  counts?: true;
  countsEvery?: true;
  wholeFirst?: true;
}

export const FLAWS: Readonly<Record<string, Flaws>> = {
  "synthetic-good": {}, "synthetic-direct": { direct: true }, "synthetic-grows": { grows: true }, "synthetic-loses": { losesRest: true },
  "synthetic-drops": { dropsSecondPage: true }, "synthetic-nopage": { noPage: true }, "synthetic-endless": { endless: true }, "synthetic-open": { open: true },
  "synthetic-unfaked": {}, "synthetic-oauth": { oauth: true }, "synthetic-bearer": { oauth: true, bearer: true },
  "synthetic-unrotated": { oauth: true, unrotated: true }, "synthetic-swallows": { oauth: true, swallows: true }, "synthetic-spins": { spins: true },
  "synthetic-connects": { connects: true }, "synthetic-untitled": { untitled: true }, "synthetic-history": { homeFacts: true },
  "synthetic-blind": { blind: true }, "synthetic-daily": { daily: true }, "synthetic-due": { due: true },
  "synthetic-backwards": { backwards: true }, "synthetic-loses-first": { losesFirst: true }, "synthetic-grows-first": { growsFirst: true },
  "synthetic-resends": { resends: true }, "synthetic-idles": { idles: true }, "synthetic-deaf": { deaf: true }, "synthetic-mute": { mute: true },
  "synthetic-unfloored": { unfloored: true }, "synthetic-by-time": { byTime: true },
  "synthetic-page-only": { pageOnly: true }, "synthetic-own-start": { ownStart: true },
  "synthetic-counts": { counts: true }, "synthetic-counts-every": { counts: true, countsEvery: true },
  "synthetic-whole-first": { wholeFirst: true },
};


interface Note {
  id: string;
  created_at: string;
  updated_at: string;
}

interface State {
  fresh: { since_ms: number; after: string | null };
  history: { before_ms: number; after: string | null } | null;
  seen?: string[];
  own_ms?: number | null;
}

function historyAfter(history: State["history"], start_ms: number | null, from_ms: number | null | undefined): State["history"] {
  if (from_ms === undefined || start_ms === from_ms) return history;
  if (history !== null) return { before_ms: history.before_ms, after: null };
  const gap = movedEarlier({ start_ms, from_ms });
  return gap === null ? null : { before_ms: gap, after: null };
}

const earliest = (own: number | null | undefined, start_ms: number | null): number | null => (own === undefined ? start_ms : own === null || start_ms === null ? null : Math.min(own, start_ms));

interface Settings {
  account: string;
  key?: string;
  signin?: string;
}

export function notesAcquirer(id: string): (settings: Settings, dependencies?: Dependencies) => Acquirer {
  const flaws = FLAWS[id]!;
  return (settings, dependencies = {}) => {
    const now = dependencies.now ?? Date.now;
    const source = `${id}:${settings.account}:cloud`;
    const signed = (secrets: Secrets): { headers: Record<string, string>; options: object } => {
      if (!flaws.oauth) return { headers: settings.key === undefined ? {} : { authorization: `Bearer ${secrets.get(settings.key)}` }, options: {} };
      if (flaws.bearer) return { headers: { authorization: `Bearer ${(JSON.parse(secrets.get(settings.signin!) ?? "{}") as { access_token?: string }).access_token}` }, options: {} };
      const kept: Secrets = flaws.unrotated ? { get: (name) => secrets.get(name), rotate: () => undefined } : secrets;
      return { headers: {}, options: { refresher: SYNTHETIC, secrets: kept, secret: settings.signin! } };
    };
    const list = async (query: Record<string, string | number | null>, secrets: Secrets, budget: { left: number }) => {
      const url = new URL("/v1/notes", ORIGIN);
      for (const [name, value] of Object.entries(query)) if (value !== null) url.searchParams.set(name, String(value));
      if (flaws.connects) {
        await new Promise((resolve, reject) => https(url, resolve).on("error", reject).end());
      }
      const { headers, options } = signed(secrets);
      let answer;
      try {
        answer = await request(url, { headers }, { budget, now, ...(flaws.direct || dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }), ...options } as RequestOptions);
      } catch (error) {
        if (flaws.swallows && error instanceof NeedsYou) throw new Error("Synthetic refused the sign-in");
        throw error;
      }
      if (!(answer instanceof Response)) {
        if (flaws.swallows && answer.stop === "signed-out") throw new Error("Synthetic refused the sign-in");
        return answer;
      }
      if (!answer.ok) throw new Error(`the provider answered ${answer.status}`);
      return (await answer.json()) as { notes: Note[]; next: string | null; remaining: number };
    };
    const begin = (state: JsonObject | null, lent: Lent, call: "fetch" | "page") => {
      const at = now();
      const cursor: State = structuredClone(state as unknown as State | null) ?? { fresh: { since_ms: flaws.wholeFirst ? 0 : at, after: null }, history: { before_ms: at, after: null } };
      if (flaws.ownStart) {
        const gap = state === null ? null : movedEarlier({ start_ms: lent.start_ms, from_ms: cursor.own_ms });
        if (gap !== null) cursor.history = { before_ms: cursor.history?.before_ms ?? gap, after: null };
        cursor.own_ms = earliest(cursor.own_ms, lent.start_ms);
      } else if (!flaws.pageOnly || call === "page") cursor.history = historyAfter(cursor.history, lent.start_ms, lent.from_ms);
      return { at, cursor };
    };
    const dated = (note: Note) => (flaws.daily ? { ...note, day: note.created_at.slice(0, 10) } : flaws.due ? { ...note, due: rfc3339(Date.parse(note.created_at) + 30 * DAY) } : note);
    const keep = (note: Note): FetchedFile => ({ path: `notes/${note.id}.json`, bytes: Buffer.from(JSON.stringify(flaws.untitled ? { ...note, title: undefined } : dated(note))) });
    const delivered = (at: number, files: FetchedFile[], cursor: State) => ({
      files, facts: { fetched_at: rfc3339(at), ...feeds(source, id), ...(flaws.homeFacts ? { history: true } : {}) }, state: cursor as unknown as JsonObject,
    });
    const everyId = async (at: number, secrets: Secrets, cursor: State): Promise<string[]> => {
      const ids: string[] = [];
      for (let after: string | null = null; ;) {
        const page = await list({ updated_before: at, after }, secrets, { left: 1 });
        if ("stop" in page) {
          afterStop(page, false, cursor as unknown as JsonObject, "Synthetic");
          return ids;
        }
        ids.push(...page.notes.map((note) => note.id));
        if (page.next === null) return ids;
        after = page.next;
      }
    };
    const monthsOf = async (secrets: Secrets, cursor: State): Promise<Months> => {
      const months: Months = {};
      for (let after: string | null = null; ;) {
        const page = await list({ after }, secrets, { left: 1 });
        if ("stop" in page) {
          afterStop(page, false, cursor as unknown as JsonObject, "Synthetic");
          throw new Error(`Synthetic stopped the count: ${page.stop}`);
        }
        for (const note of page.notes) {
          const month = note.created_at.slice(0, 7);
          const [items, bytes] = months[month] ?? [0, 0];
          months[month] = [items + 1, (bytes ?? 0) + Buffer.byteLength(JSON.stringify(note))];
        }
        if (page.next === null) return months;
        after = page.next;
      }
    };
    const acquirer: Acquirer = {
      name: id,
      source,
      ...(flaws.counts ? { months: true as const } : {}),
      async fetch(state, secrets, lent) {
        while (flaws.spins) now();
        const { at, cursor } = begin(state, lent, "fetch");
        if (flaws.blind || (flaws.backwards && state === null)) return delivered(at, [], cursor);
        if (flaws.mute && lent.memory.get(QUIET, "idle") !== undefined) {
          lent.memory.drop(QUIET, "idle");
          return delivered(at, [], cursor);
        }
        if (flaws.growsFirst && state === null) cursor.seen = await everyId(at, secrets, cursor);
        else if (flaws.growsFirst) delete cursor.seen;
        const budget = { left: PER_CALL };
        const kept: FetchedFile[] = [];
        const since_ms = cursor.fresh.since_ms;
        let newest = { ms: since_ms, ids: [] as string[] };
        const seal = (more: object) => {
          if (flaws.grows) cursor.seen = [...(cursor.seen ?? []), ...kept.map((file) => file.path)];
          return { ...delivered(at, kept, cursor), ...more, ...(flaws.endless ? { more: true as const } : {}), ...(flaws.deaf ? { answered: false as const } : {}) };
        };
        for (;;) {
          const page = await list({ [flaws.backwards ? "updated_before" : "updated_since"]: since_ms, after: cursor.fresh.after }, secrets, budget);
          if ("stop" in page) {
            if (flaws.losesFirst && page.stop === "limit" && state === null) throw new NotYet("provider-limit", "Synthetic is limiting requests", { backoff_ms: page.retry_ms });
            if (flaws.losesRest && page.stop === "limit") {
              cursor.fresh = { since_ms: newest.ms, after: null };
              return seal({});
            }
            return seal(afterStop(page, kept.length > 0, cursor as unknown as JsonObject, "Synthetic"));
          }
          for (const note of page.notes) {
            const updated = Date.parse(note.updated_at);
            if (updated === since_ms && (flaws.byTime ? lent.memory.list(AT_INSTANT, undefined, 1).length > 0 : lent.memory.get(AT_INSTANT, note.id) !== undefined)) continue;
            kept.push(keep(note));
            if (updated > newest.ms) newest = { ms: updated, ids: [] };
            if (updated === newest.ms) newest.ids.push(note.id);
          }
          if (page.next !== null) {
            cursor.fresh = { ...cursor.fresh, after: page.next };
            continue;
          }
          cursor.fresh = { since_ms: newest.ms, after: null };
          if (newest.ms !== since_ms) lent.memory.clear(AT_INSTANT);
          for (const each of newest.ids) lent.memory.put(AT_INSTANT, each, true);
          if (kept.length === 0 && state !== null) {
            if (flaws.idles) throw new NotYet("provider-making", "Synthetic has nothing new", { state: cursor as unknown as JsonObject, next_ms: at + 60_000 });
            if (flaws.mute) lent.memory.put(QUIET, "idle", true);
            if (flaws.resends) {
              const old = await list({ updated_before: at, after: null }, secrets, { left: 1 });
              if (!("stop" in old)) kept.push(...old.notes.slice(0, 1).map(keep));
            }
          }
          return seal({});
        }
      },
    };
    if (flaws.noPage) return acquirer;
    return {
      ...acquirer,
      async page(state, secrets, lent) {
        const { at, cursor } = begin(state, lent, "page");
        if (cursor.history === null) return { ...delivered(at, [], cursor), left: 0 };
        const floor = flaws.unfloored || flaws.backwards ? null : lent.start_ms;
        const page = await list({ [flaws.backwards ? "updated_since" : "updated_before"]: cursor.history.before_ms, ...(floor === null ? {} : { updated_since: floor }), after: cursor.history.after }, secrets, { left: 1 });
        if ("stop" in page) {
          if (flaws.losesRest && page.stop === "limit") return { ...delivered(at, [], { ...cursor, history: null }), left: 0 };
          return { ...delivered(at, [], cursor), left: null, ...afterStop(page, false, cursor as unknown as JsonObject, "Synthetic") };
        }
        const second = cursor.history.after === String(PAGE);
        const months = flaws.counts && (flaws.countsEvery || cursor.history.after === null) ? { months: await monthsOf(secrets, cursor) } : {};
        cursor.history = page.next === null ? null : { before_ms: cursor.history.before_ms, after: page.next };
        return { ...delivered(at, flaws.dropsSecondPage && second ? [] : page.notes.map(keep), cursor), left: page.next === null ? 0 : page.remaining, ...months };
      },
    };
  };
}
