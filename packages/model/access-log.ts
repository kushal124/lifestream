import { randomBytes } from "node:crypto";
import { canonical, type Json } from "@lifestreamprotocol/core";
import type { Conn } from "./ledger.js";
import { bounded, REASON_CHARS } from "./transport.js";

export const LAPSE_MS = 24 * 60 * 60_000;
export const SESSION_GAP_MS = 30 * 60_000;
export const ACCESS_CHANGED = "ACCESS_CHANGED";

export const ACCESS_CHANGES = ["granted", "widened", "narrowed", "requested", "allowed", "declined", "replaced", "dropped", "lapsed", "joined", "erased", "removed"] as const;
export type AccessChangeWhat = (typeof ACCESS_CHANGES)[number];
export const ACCESS_BY = ["person", "home", "chat", "agent"] as const;
export type AccessBy = (typeof ACCESS_BY)[number];
export const REQUEST_STATES = ["open", "allowed", "declined", "replaced", "dropped", "lapsed"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];
export const REQUEST_BY = ["agent", "chat"] as const;
export type RequestBy = (typeof REQUEST_BY)[number];
export const READER_CALL_RESULTS = ["running", "answered", "refused", "failed"] as const;
export type ReaderCallResult = (typeof READER_CALL_RESULTS)[number];
export const NOT_READS = ["access", "feedback"] as const;
const IS_READ = "result = 'answered' AND tool NOT IN ('access', 'feedback')";
export const CALL_ITEMS_KEPT = 1_024;

export interface StoredAccess {
  reader: string;
  version: number;
  lines: Json;
  covers: string[];
  at_ms: number;
}

export interface AccessChange {
  seq: number;
  at_ms: number;
  reader: string;
  version: number;
  what: AccessChangeWhat;
  by: AccessBy;
  device: string | null;
  request: string | null;
  lines: Json | null;
  about: Json | null;
}

export interface AccessRequest {
  id: string;
  reader: string;
  by: RequestBy;
  at_ms: number;
  want: Json | null;
  want_key: string | null;
  reason: string;
  for_ms: number | null;
  state: RequestState;
  answered_ms: number | null;
  device: string | null;
  told_ms: number | null;
}

export interface ChangeBy {
  at_ms: number;
  by: AccessBy;
  device: string | null;
}

export interface Withheld {
  line: string;
  n: number;
  least: boolean;
}

export type Came = Record<string, number>;

export interface CallItem {
  kind: string;
  ref: string;
  source: string | null;
  rkind: string | null;
  key: string | null;
  day: string | null;
}

export interface KeptItem extends CallItem {
  at: number;
}

export interface CallItems {
  items: KeptItem[];
  next: number | null;
  kept: number;
  unkept: number;
}

export interface KindCalls {
  calls: ReaderCall[];
  next: number | null;
}

export interface ReaderCall {
  seq: number;
  id: string;
  at_ms: number;
  reader: string;
  session: number;
  access_version: number | null;
  tool: string;
  sent: Json;
  read: Json;
  result: ReaderCallResult;
  code: string | null;
  words: string | null;
  ms: number | null;
  withheld: Withheld[];
  came: Came | null;
  outbound: number[];
}

export interface ReaderCallBegun {
  id: string;
  seq: number;
  session: number;
  epoch: number;
  access: StoredAccess | undefined;
  news: AccessRequest | undefined;
}

export interface Scrub {
  access(lines: Json): { lines: Json; went: Json | null };
  names(value: Json): boolean;
}

export interface ReadTally {
  total: number;
  first_ms: number | null;
  last_ms: number | null;
  within: number[];
}

export interface AccessErased {
  accesses: number;
  snapshots: number;
  wants: number;
  reads: number;
}

export interface AccessLog {
  get(reader: string): StoredAccess | undefined;
  all(): StoredAccess[];
  changes(reader: string, page: { before?: number; limit: number }): AccessChange[];
  made(reader: string, version: number): AccessChange | undefined;
  requested(reader: string, id: string): AccessChange | undefined;
  granted(reader: string, id: string): AccessChange | undefined;
  requests(reader: string, now_ms: number): AccessRequest[];
  told(reader: string, page: { from_ms: number; to_ms: number; limit: number }): AccessRequest[];
  request(id: string, now_ms: number): AccessRequest | undefined;
  waiting(now_ms: number): AccessRequest[];
  change(reader: string, change: { from: number; what: "granted" | "widened" | "narrowed"; lines: Json; covers: readonly string[] }, by: ChangeBy): StoredAccess;
  remove(reader: string, from: number, by: ChangeBy): void;
  ask(reader: string, want: { from: number; want: Json; want_key: string; reason: string; for_ms: number | null }, by: ChangeBy): AccessRequest;
  answer(id: string, answer: { from: number; answer: "declined" } | { from: number; answer: "allowed"; lines: Json; covers: readonly string[] }, by: ChangeBy): { request: AccessRequest; applied: boolean } | undefined;
  drop(reader: string, from: number, by: ChangeBy & { by: "agent" }): AccessRequest | undefined;
  moved(): number | null;
  move(accesses: readonly { reader: string; lines: Json; covers: readonly string[] }[], at_ms: number): boolean;
  begin(call: { reader: string; tool: string; sent: Json; read: Json; at_ms: number; initialize?: boolean; reaches?: (lines: Json) => readonly string[] }): ReaderCallBegun;
  end(id: string, end: { result: Exclude<ReaderCallResult, "running">; code?: string; words: string | null; ms: number; withheld: readonly Withheld[]; read?: Json; came?: Came; items?: readonly CallItem[] }): boolean;
  call(id: string): ReaderCall | undefined;
  calls(reader: string, page: { before?: number; limit: number }): ReaderCall[];
  calls(reader: string, page: { before?: number; limit: number; kind: string; scan: number }): KindCalls;
  later(reader: string, page: { after: number; limit: number }): ReaderCall[];
  items(call: number, page: { after?: number; limit: number }): CallItems;
  reads(reader: string, limit: number): ReaderCall[];
  readsIn(reader: string, span: { from_ms: number; to_ms: number; limit: number }): ReaderCall[];
  tally(reader: string, bounds: readonly number[]): ReadTally;
  kinds(reader: string, from_ms: number): Record<string, number> | null;
  everRead(reader: string): string[];
  removedBy(reader: string): AccessBy | null;
  unlist(reader: string, at_ms: number): boolean;
  unlisted(): Set<string>;
}

export function accessLogOver(conn: Conn, epoch: () => number): {
  log: AccessLog;
  forgetIn(scrub: Scrub, at_ms: number): AccessErased;
  forgetItems(records: readonly { source: string; kind: string; key: string }[], days: readonly string[]): void;
} {
  const { sql, write } = conn;
  const accessOf = sql<RawAccess>("SELECT reader, version, lines, covers, at_ms FROM access WHERE reader = ?");
  const allAccess = sql<RawAccess>("SELECT reader, version, lines, covers, at_ms FROM access ORDER BY reader");
  const lastVersion = sql<{ v: number | null }>("SELECT max(version) AS v FROM access_changes WHERE reader = ?");
  const putAccess = sql("INSERT INTO access (reader, version, lines, covers, at_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (reader) DO UPDATE SET version = excluded.version, lines = excluded.lines, covers = excluded.covers, at_ms = excluded.at_ms");
  const dropAccess = sql("DELETE FROM access WHERE reader = ?");
  const putChange = sql("INSERT INTO access_changes (at_ms, reader, version, what, by, device, request, lines, about) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const CHANGE = "seq, at_ms, reader, version, what, by, device, request, lines, about";
  const changePage = sql<RawChange>(`SELECT ${CHANGE} FROM access_changes WHERE reader = ? AND seq < ? ORDER BY seq DESC LIMIT ?`);
  const madeOf = sql<RawChange>(`SELECT ${CHANGE} FROM access_changes WHERE reader = ? AND version = ? AND what NOT IN ('requested', 'declined', 'replaced', 'dropped', 'lapsed') ORDER BY seq DESC LIMIT 1`);
  const requestedOf = sql<RawChange>(`SELECT ${CHANGE} FROM access_changes WHERE reader = ? AND request = ? AND what = 'requested' ORDER BY seq DESC LIMIT 1`);
  const grantedOf = sql<RawChange>(`SELECT ${CHANGE} FROM access_changes WHERE reader = ? AND request = ? AND what = 'allowed' ORDER BY seq DESC LIMIT 1`);
  const REQUEST = "id, reader, by, at_ms, want, want_key, reason, for_ms, state, answered_ms, device, told_ms";
  const requestOf = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE id = ?`);
  const requestsOf = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE reader = ? ORDER BY at_ms DESC, rowid DESC`);
  const toldOf = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE reader = ? AND told_ms BETWEEN ? AND ? ORDER BY told_ms DESC, rowid DESC LIMIT ?`);
  const openOf = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE reader = ? AND by = ? AND state = 'open'`);
  const allOpen = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE state = 'open' ORDER BY at_ms, rowid`);
  const putRequest = sql(`INSERT INTO access_requests (${REQUEST}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, NULL, NULL)`);
  const moveRequest = sql("UPDATE access_requests SET state = ?, answered_ms = ?, device = ? WHERE id = ? AND state = 'open'");
  const untold = sql<RawRequest>(`SELECT ${REQUEST} FROM access_requests WHERE reader = ? AND by = 'agent' AND told_ms IS NULL AND state IN ('allowed', 'declined', 'lapsed') ORDER BY answered_ms DESC, rowid DESC`);
  const tell = sql("UPDATE access_requests SET told_ms = ? WHERE id = ?");
  const markOf = sql<{ at_ms: number }>("SELECT at_ms FROM access_moved");
  const putMark = sql("INSERT INTO access_moved (at_ms) VALUES (?)");
  const anyAccess = sql("SELECT 1 FROM access LIMIT 1");
  const CALL = "c.seq, c.id, c.at_ms, c.reader, c.session, c.access_version, c.tool, c.sent, c.read, c.result, x.code, c.words, c.ms, c.epoch, k.came";
  const CALLS = "calls c LEFT JOIN call_came k ON k.call = c.seq LEFT JOIN call_code x ON x.call = c.seq";
  const lastCall = sql<{ session: number; at_ms: number }>("SELECT session, at_ms FROM calls WHERE reader = ? ORDER BY seq DESC LIMIT 1");
  const putCall = sql("INSERT INTO calls (id, at_ms, reader, session, access_version, tool, sent, read, result, epoch) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)");
  const callOf = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.id = ?`);
  const callPage = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.reader = ? AND c.seq < ? AND NOT EXISTS (SELECT 1 FROM call_opened o WHERE o.call = c.seq) ORDER BY c.seq DESC LIMIT ?`);
  const putOpened = sql("INSERT INTO call_opened (call) VALUES (?)");
  const scanFloor = sql<{ seq: number }>("SELECT seq FROM calls WHERE reader = ? AND seq < ? ORDER BY seq DESC LIMIT 1 OFFSET ?");
  const kindPage = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.reader = ? AND c.seq < ? AND c.seq >= ? AND NOT EXISTS (SELECT 1 FROM call_opened o WHERE o.call = c.seq)
    AND EXISTS (SELECT 1 FROM json_each(k.came) j WHERE j.key = ?) ORDER BY c.seq DESC LIMIT ?`);
  const laterPage = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.reader = ? AND c.seq > ? AND NOT EXISTS (SELECT 1 FROM call_opened o WHERE o.call = c.seq) ORDER BY c.seq LIMIT ?`);
  const putItem = sql("INSERT INTO call_items (call, at, kind, ref, source, rkind, key, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const itemPage = sql<KeptItem>("SELECT at, kind, ref, source, rkind, key, day FROM call_items WHERE call = ? AND at > ? ORDER BY at LIMIT ?");
  const itemsKept = sql<{ n: number }>("SELECT count(*) AS n FROM call_items WHERE call = ?");
  const cameOfCall = sql<{ came: string }>("SELECT came FROM call_came WHERE call = ?");
  const dropRecordItems = sql("DELETE FROM call_items WHERE source = ? AND rkind = ? AND key = ?");
  const dropDayItems = sql("DELETE FROM call_items WHERE day = ?");
  const readPage = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.reader = ? AND ${IS_READ} ORDER BY c.at_ms DESC, c.seq DESC LIMIT ?`);
  const readsInSpan = sql<RawCall>(`SELECT ${CALL} FROM ${CALLS} WHERE c.reader = ? AND c.at_ms >= ? AND c.at_ms < ? AND ${IS_READ}
    AND NOT EXISTS (SELECT 1 FROM call_opened o WHERE o.call = c.seq) ORDER BY c.seq DESC LIMIT ?`);
  const endCall = sql("UPDATE calls SET result = ?, words = ?, ms = ?, read = coalesce(?, read) WHERE seq = ? AND result = 'running'");
  const putCode = sql("INSERT INTO call_code (call, code) VALUES (?, ?)");
  const putCame = sql("INSERT INTO call_came (call, came) VALUES (?, ?)");
  const putUnlisted = sql("INSERT INTO unlisted (reader, at_ms) VALUES (?, ?) ON CONFLICT (reader) DO NOTHING");
  const allUnlisted = sql<{ reader: string }>("SELECT reader FROM unlisted");
  const putWithheld = sql("INSERT INTO call_withheld (call, line, n, least) VALUES (?, ?, ?, ?)");
  const withheldOf = sql<{ line: string; n: number; least: number }>("SELECT line, n, least FROM call_withheld WHERE call = ? ORDER BY line");
  const outboundOf = sql<{ outbound: number }>("SELECT outbound FROM outbound_calls WHERE call = ? ORDER BY outbound");
  const readsOf = sql<{ n: number; first_ms: number; last_ms: number }>("SELECT n, first_ms, last_ms FROM reader_reads WHERE reader = ?");
  const putRead = sql("INSERT INTO reader_reads (reader, n, first_ms, last_ms) VALUES (?, 1, ?, ?) ON CONFLICT (reader) DO UPDATE SET n = n + 1, first_ms = min(first_ms, excluded.first_ms), last_ms = max(last_ms, excluded.last_ms)");
  const putKind = sql("INSERT INTO reader_kinds (reader, kind, n) VALUES (?, ?, 1) ON CONFLICT (reader, kind) DO UPDATE SET n = n + 1");
  const kindsOf = sql<{ kind: string }>("SELECT kind FROM reader_kinds WHERE reader = ? ORDER BY n DESC, kind");
  const readsBetween = sql<{ n: number }>(`SELECT count(*) AS n FROM calls WHERE reader = ? AND at_ms >= ? AND at_ms < ? AND ${IS_READ}`);
  const kindsSince = sql<{ kind: string; n: number }>(`SELECT j.key AS kind, count(*) AS n FROM calls c JOIN call_came k ON k.call = c.seq, json_each(k.came) j WHERE c.reader = ? AND c.at_ms >= ? AND ${IS_READ} GROUP BY j.key`);
  const unrecordedSince = sql<{ seq: number }>(`SELECT c.seq FROM calls c LEFT JOIN call_came k ON k.call = c.seq WHERE c.reader = ? AND c.at_ms >= ? AND ${IS_READ} AND k.call IS NULL LIMIT 1`);
  const removedOf = sql<{ by: AccessBy }>("SELECT by FROM access_changes WHERE reader = ? AND what = 'removed' ORDER BY seq DESC LIMIT 1");

  const stored = (row: RawAccess | undefined): StoredAccess | undefined => row === undefined ? undefined : {
    reader: row.reader, version: Number(row.version), lines: JSON.parse(row.lines) as Json, covers: JSON.parse(row.covers) as string[], at_ms: Number(row.at_ms),
  };
  const requestRow = (row: RawRequest | undefined, now_ms: number): AccessRequest | undefined => {
    if (row === undefined) return undefined;
    const lapsed = row.state === "open" && now_ms - Number(row.at_ms) >= LAPSE_MS;
    return {
      id: row.id, reader: row.reader, by: row.by, at_ms: Number(row.at_ms), want: row.want === null ? null : JSON.parse(row.want) as Json, want_key: row.want_key,
      reason: row.reason, for_ms: row.for_ms === null ? null : Number(row.for_ms), state: lapsed ? "lapsed" : row.state,
      answered_ms: lapsed ? lapsedAt(row) : nullableNumber(row.answered_ms), device: row.device, told_ms: nullableNumber(row.told_ms),
    };
  };
  const changeRow = (row: RawChange | undefined): AccessChange | undefined => row === undefined ? undefined : {
    seq: Number(row.seq), at_ms: Number(row.at_ms), reader: row.reader, version: Number(row.version), what: row.what, by: row.by, device: row.device,
    request: row.request, lines: parsed(row.lines), about: parsed(row.about),
  };
  const callRow = (row: RawCall | undefined): ReaderCall | undefined => row === undefined ? undefined : {
    seq: Number(row.seq), id: row.id, at_ms: Number(row.at_ms), reader: row.reader, session: Number(row.session),
    access_version: nullableNumber(row.access_version), tool: row.tool, sent: JSON.parse(row.sent) as Json, read: JSON.parse(row.read) as Json,
    result: row.result, code: row.code, words: row.words, ms: nullableNumber(row.ms),
    withheld: withheldOf.all(row.seq).map((each) => ({ line: each.line, n: Number(each.n), least: each.least === 1 })),
    came: row.came === null ? null : JSON.parse(row.came) as Came,
    outbound: outboundOf.all(row.seq).map((each) => Number(each.outbound)),
  };

  const at = (reader: string, from: number): StoredAccess | undefined => {
    const now = stored(accessOf.get(reader));
    const version = now?.version ?? 0;
    if (from !== version) throw Object.assign(new Error(`the access of ${reader} is at version ${version}, not ${from}: read it again`), { code: ACCESS_CHANGED });
    return now;
  };
  const nextVersion = (reader: string): number => Number(lastVersion.get(reader)?.v ?? 0) + 1;
  const row = (reader: string, version: number, what: AccessChangeWhat, by: ChangeBy, rest: { request?: string | null; lines: Json | null; about?: Json | null }) => {
    if (!ACCESS_BY.includes(by.by)) throw new TypeError(`${JSON.stringify(by.by)} is no change's maker`);
    putChange.run(by.at_ms, reader, version, what, by.by, by.device, rest.request ?? null, text(rest.lines), text(rest.about ?? null));
  };
  const set = (reader: string, what: AccessChangeWhat, lines: Json, covers: readonly string[], by: ChangeBy, rest: { request?: string; about?: Json } = {}): StoredAccess => {
    const proposal = openOf.get(reader, "chat");
    const version = nextVersion(reader);
    const list = coversOf(covers);
    putAccess.run(reader, version, canonical(lines), canonical(list), by.at_ms);
    row(reader, version, what, by, { ...rest, lines });
    if (proposal !== undefined) {
      moveRequest.run("replaced", by.at_ms, null, proposal.id);
      row(reader, version, "replaced", by, { request: proposal.id, lines: null, about: { changed: true } });
    }
    return { reader, version, lines: JSON.parse(canonical(lines)) as Json, covers: list, at_ms: by.at_ms };
  };
  const openRequest = (reader: string, asker: RequestBy, now: StoredAccess | undefined, by: ChangeBy): RawRequest | undefined => {
    const open = openOf.get(reader, asker);
    if (open === undefined || by.at_ms - Number(open.at_ms) < LAPSE_MS) return open;
    moveRequest.run("lapsed", lapsedAt(open), null, open.id);
    row(reader, now?.version ?? 0, "lapsed", { at_ms: by.at_ms, by: "home", device: null }, { request: open.id, lines: now?.lines ?? null });
    return undefined;
  };

  const log: AccessLog = {
    get: (reader) => stored(accessOf.get(reader)),
    all: () => allAccess.all().map((each) => stored(each)!),
    changes: (reader, { before, limit }) => changePage.all(reader, before ?? Number.MAX_SAFE_INTEGER, limit).map((each) => changeRow(each)!),
    made: (reader, version) => changeRow(madeOf.get(reader, version)),
    requested: (reader, id) => changeRow(requestedOf.get(reader, id)),
    granted: (reader, id) => changeRow(grantedOf.get(reader, id)),
    requests: (reader, now_ms) => requestsOf.all(reader).map((each) => requestRow(each, now_ms)!),
    told: (reader, { from_ms, to_ms, limit }) => toldOf.all(reader, from_ms, to_ms, limit).map((each) => requestRow(each, Number(each.told_ms))!),
    request: (id, now_ms) => requestRow(requestOf.get(id), now_ms),
    waiting: (now_ms) => allOpen.all().map((each) => requestRow(each, now_ms)!).filter((each) => each.state === "open"),

    change: (reader, { from, what, lines, covers }, by) => write(() => {
      if (!["granted", "widened", "narrowed"].includes(what)) throw new TypeError(`${JSON.stringify(what)} is no change of an access's lines`);
      at(reader, from);
      return set(reader, what, lines, covers, by);
    }),

    remove: (reader, from, by) => write(() => {
      if (at(reader, from) === undefined) return;
      dropAccess.run(reader);
      row(reader, nextVersion(reader), "removed", by, { lines: null });
    }),

    ask: (reader, { from, want, want_key, reason, for_ms }, by) => write(() => {
      const fault = reasonFault(reason);
      if (fault !== null) throw new TypeError(fault);
      if (for_ms !== null && !(Number.isSafeInteger(for_ms) && for_ms > 0)) throw new TypeError(`a request lasts a positive whole number of milliseconds, or always: ${for_ms}`);
      if (want_key.length === 0) throw new TypeError("a request names its want's key");
      const now = at(reader, from);
      const lines = now?.lines ?? null;
      const id = `rq-${randomBytes(8).toString("hex")}`;
      const asker = askerOf(by);
      const open = openRequest(reader, asker, now, by);
      if (open !== undefined) {
        moveRequest.run("replaced", by.at_ms, null, open.id);
        row(reader, now?.version ?? 0, "replaced", by, { request: open.id, lines });
      }
      putRequest.run(id, reader, asker, by.at_ms, canonical(want), want_key, reason, for_ms);
      row(reader, now?.version ?? 0, "requested", by, { request: id, lines });
      return requestRow(requestOf.get(id), by.at_ms)!;
    }),

    answer: (id, answer, by) => write(() => {
      const asked = requestOf.get(id);
      if (asked === undefined) return undefined;
      const now = at(asked.reader, answer.from);
      const open = openRequest(asked.reader, asked.by, now, by);
      if (open?.id !== id || (asked.want === null && answer.answer === "allowed")) return { request: requestRow(requestOf.get(id), by.at_ms)!, applied: false };
      moveRequest.run(answer.answer, by.at_ms, by.device, id);
      if (answer.answer === "allowed") set(asked.reader, "allowed", answer.lines, answer.covers, by, { request: id });
      else row(asked.reader, now?.version ?? 0, "declined", by, { request: id, lines: now?.lines ?? null });
      return { request: requestRow(requestOf.get(id), by.at_ms)!, applied: true };
    }),

    drop: (reader, from, by) => write(() => {
      const now = at(reader, from);
      const open = openRequest(reader, "agent", now, by);
      if (open === undefined) return undefined;
      moveRequest.run("dropped", by.at_ms, by.device, open.id);
      row(reader, now?.version ?? 0, "dropped", by, { request: open.id, lines: now?.lines ?? null });
      return requestRow(requestOf.get(open.id), by.at_ms)!;
    }),

    moved: () => nullableNumber(markOf.get()?.at_ms ?? null),

    move: (accesses, at_ms) => write(() => {
      if (markOf.get() !== undefined) return false;
      if (anyAccess.get() !== undefined) throw new Error("the ledger holds an access but not the move's mark: the move would write over it");
      for (const { reader, lines, covers } of accesses) set(reader, "granted", lines, covers, { at_ms, by: "home", device: null });
      putMark.run(at_ms);
      return true;
    }),

    begin: ({ reader, tool, sent, read, at_ms, initialize, reaches }) => write(() => {
      let access = stored(accessOf.get(reader));
      if (access !== undefined && reaches !== undefined) {
        const covered = new Set(access.covers);
        for (const account of coversOf(reaches(access.lines))) {
          if (covered.has(account)) continue;
          covered.add(account);
          access = set(reader, "joined", access.lines, [...covered], { at_ms, by: "home", device: null }, { about: account });
        }
      }
      for (const asker of REQUEST_BY) openRequest(reader, asker, access, { at_ms, by: "home", device: null });
      const told = untold.all(reader).slice(0, 1);
      for (const each of told) tell.run(at_ms, each.id);
      const last = lastCall.get(reader);
      const session = last === undefined ? 1 : initialize !== true && at_ms - Number(last.at_ms) < SESSION_GAP_MS ? Number(last.session) : Number(last.session) + 1;
      const id = `call-${randomBytes(8).toString("hex")}`;
      const now = epoch();
      const seq = Number(putCall.run(id, at_ms, reader, session, access?.version ?? null, tool, canonical(sent), canonical(read), now).lastInsertRowid);
      if (initialize === true) putOpened.run(seq);
      const news = told[0] === undefined ? undefined : requestRow({ ...told[0], told_ms: at_ms }, at_ms);
      return { id, seq, session, epoch: now, access, news };
    }),

    end: (id, { result, code, words, ms, withheld, read, came, items }) => write(() => {
      if (!READER_CALL_RESULTS.slice(1).includes(result)) throw new TypeError(`${JSON.stringify(result)} is no call's end`);
      if (came !== undefined && items !== undefined) throw new TypeError("a call's end gives what came back or the items it is the tally of, never both");
      const call = callOf.get(id);
      if (call === undefined) return false;
      const same = Number(call.epoch) === epoch();
      const kept = words === null || !same ? null : bounded(words);
      if (endCall.run(result, kept, Math.max(0, Math.round(ms)), read === undefined || !same ? null : canonical(read), call.seq).changes === 0) return false;
      const brought = items !== undefined ? cameOf(tallyOf(items)) : came === undefined ? undefined : cameOf(came);
      if (brought !== undefined) putCame.run(call.seq, canonical(brought));
      for (const [at, item] of (same ? items ?? [] : []).slice(0, CALL_ITEMS_KEPT).entries()) {
        putItem.run(call.seq, at, item.kind, item.ref, item.source, item.rkind, item.key, item.day);
      }
      if (code !== undefined) putCode.run(call.seq, code);
      const lines = new Map<string, { n: number; least: boolean }>();
      for (const each of withheld) {
        if (!(Number.isSafeInteger(each.n) && each.n > 0)) throw new TypeError(`a withheld count is a positive whole number: ${each.n}`);
        const was = lines.get(each.line) ?? { n: 0, least: false };
        lines.set(each.line, { n: was.n + each.n, least: was.least || each.least });
      }
      for (const [line, { n, least }] of lines) putWithheld.run(call.seq, line, n, least ? 1 : 0);
      if (isRead({ result, tool: call.tool })) {
        putRead.run(call.reader, Number(call.at_ms), Number(call.at_ms));
        for (const kind of Object.keys(brought ?? {})) putKind.run(call.reader, kind);
      }
      return true;
    }),

    call: (id) => callRow(callOf.get(id)),
    calls: ((reader: string, page: { before?: number; limit: number; kind?: string; scan?: number }) => {
      const before = page.before ?? Number.MAX_SAFE_INTEGER;
      if (page.kind === undefined) return callPage.all(reader, before, page.limit).map((each) => callRow(each)!);
      const scan = page.scan ?? 0;
      if (!(Number.isSafeInteger(scan) && scan > 0)) throw new TypeError(`a page of one kind scans a positive whole number of calls: ${scan}`);
      const floor = scanFloor.get(reader, before, scan - 1)?.seq;
      const calls = kindPage.all(reader, before, floor ?? 0, page.kind, page.limit).map((each) => callRow(each)!);
      const next = calls.length === page.limit ? calls.at(-1)!.seq : floor === undefined ? null : Number(floor);
      return { calls, next };
    }) as AccessLog["calls"],
    later: (reader, { after, limit }) => laterPage.all(reader, after, limit).map((each) => callRow(each)!),
    items(call, { after, limit }) {
      const items = itemPage.all(call, after ?? -1, limit).map((each) => ({ ...each, at: Number(each.at) }));
      const kept = Number(itemsKept.get(call)!.n);
      const came = cameOfCall.get(call);
      const brought = came === undefined ? 0 : Object.values(JSON.parse(came.came) as Came).reduce((sum, n) => sum + n, 0);
      const last = items.at(-1);
      return { items, next: items.length === limit && last !== undefined && last.at < kept - 1 ? last.at : null, kept, unkept: Math.max(0, brought - kept) };
    },
    reads: (reader, limit) => readPage.all(reader, limit).map((each) => callRow(each)!),
    readsIn: (reader, { from_ms, to_ms, limit }) => readsInSpan.all(reader, from_ms, to_ms, limit).map((each) => callRow(each)!),

    tally(reader, bounds) {
      const reads = readsOf.get(reader);
      const within = bounds.map((start, at) => Number(readsBetween.get(reader, start, bounds[at + 1] ?? Number.MAX_SAFE_INTEGER)!.n));
      return { total: Number(reads?.n ?? 0), first_ms: nullableNumber(reads?.first_ms), last_ms: nullableNumber(reads?.last_ms), within };
    },
    kinds: (reader, from_ms) => unrecordedSince.get(reader, from_ms) !== undefined ? null : Object.fromEntries(kindsSince.all(reader, from_ms).map((each) => [each.kind, Number(each.n)])),
    everRead: (reader) => kindsOf.all(reader).map((each) => each.kind),
    removedBy: (reader) => removedOf.get(reader)?.by ?? null,
    unlist: (reader, at_ms) => write(() => putUnlisted.run(reader, at_ms).changes === 1),
    unlisted: () => new Set(allUnlisted.all().map((each) => each.reader)),
  };

  return {
    log,
    forgetItems(records, days) {
      for (const record of records) dropRecordItems.run(record.source, record.kind, record.key);
      for (const day of days) dropDayItems.run(day);
    },
    forgetIn(scrub, at_ms) {
      const counts: AccessErased = { accesses: 0, snapshots: 0, wants: 0, reads: 0 };
      const rewriteChange = sql("UPDATE access_changes SET lines = ?, about = ? WHERE seq = ?");
      const clearWant = sql("UPDATE access_requests SET want = NULL, want_key = NULL WHERE id = ?");
      const scrubbed = (lines: Json) => {
        const after = scrub.access(lines);
        if (scrub.names(after.lines) || (after.went !== null && scrub.names(after.went))) throw new Error("the scrub left an erased identity in an access: the erasure writes nothing");
        return after;
      };
      for (const each of sql<{ seq: number; lines: string | null; about: string | null }>("SELECT seq, lines, about FROM access_changes").all()) {
        const lines = each.lines === null ? null : canonical(scrubbed(JSON.parse(each.lines) as Json).lines);
        const about = each.about !== null && scrub.names(JSON.parse(each.about) as Json) ? null : each.about;
        if (lines === each.lines && about === each.about) continue;
        rewriteChange.run(lines, about, each.seq);
        counts.snapshots++;
      }
      for (const each of sql<{ id: string; want: string | null }>("SELECT id, want FROM access_requests WHERE want IS NOT NULL").all()) {
        if (!scrub.names(JSON.parse(each.want!) as Json)) continue;
        clearWant.run(each.id);
        counts.wants++;
      }
      const clearRead = sql("UPDATE calls SET read = 'null' WHERE seq = ?");
      for (const each of sql<{ seq: number; read: string }>("SELECT seq, read FROM calls WHERE read != 'null'").all()) {
        if (!scrub.names(JSON.parse(each.read) as Json)) continue;
        clearRead.run(each.seq);
        counts.reads++;
      }
      for (const live of allAccess.all().map((each) => stored(each)!)) {
        const after = scrubbed(live.lines);
        const covers = live.covers.filter((account) => !scrub.names(account));
        if (canonical(after.lines) !== canonical(live.lines)) {
          set(live.reader, "erased", after.lines, covers, { at_ms, by: "person", device: null }, after.went === null ? {} : { about: after.went });
          counts.accesses++;
        } else if (covers.length !== live.covers.length) {
          putAccess.run(live.reader, live.version, canonical(live.lines), canonical(covers), live.at_ms);
        }
      }
      return counts;
    },
  };
}

interface RawAccess { reader: string; version: number; lines: string; covers: string; at_ms: number }
interface RawChange { seq: number; at_ms: number; reader: string; version: number; what: AccessChangeWhat; by: AccessBy; device: string | null; request: string | null; lines: string | null; about: string | null }
interface RawRequest { id: string; reader: string; by: RequestBy; at_ms: number; want: string | null; want_key: string | null; reason: string; for_ms: number | null; state: RequestState; answered_ms: number | null; device: string | null; told_ms: number | null }
interface RawCall { seq: number; id: string; at_ms: number; reader: string; session: number; access_version: number | null; tool: string; sent: string; read: string; result: ReaderCallResult; code: string | null; words: string | null; ms: number | null; epoch: number; came: string | null }

export function reasonFault(reason: string): string | null {
  const chars = [...reason].length;
  if (chars > REASON_CHARS) return `reason is one line of at most ${REASON_CHARS} characters: this one has ${chars}`;
  const control = /[\p{Cc}\u2028\u2029]/u.exec(reason);
  if (control !== null) return `reason is one line of plain text: it holds a line break or a control character (${codePoint(control[0])})`;
  const direction = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.exec(reason);
  if (direction !== null) return `reason is plain text: it holds a mark that turns the direction of the text (${codePoint(direction[0])}), which would show your words as something else`;
  return null;
}

function codePoint(char: string): string {
  return `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
}

export function isRead(call: { result: ReaderCallResult; tool: string }): boolean {
  return call.result === "answered" && !(NOT_READS as readonly string[]).includes(call.tool);
}

function askerOf(by: ChangeBy): RequestBy {
  return by.by === "agent" ? "agent" : "chat";
}

function lapsedAt(row: RawRequest): number {
  return Number(row.at_ms) + LAPSE_MS;
}

function cameOf(came: Came): Came {
  const kept: Came = {};
  for (const [kind, n] of Object.entries(came)) {
    if (!/^[a-z-]{1,24}$/u.test(kind)) throw new TypeError(`a kind of what came back is a short word: ${JSON.stringify(kind)}`);
    if (!(Number.isSafeInteger(n) && n > 0)) throw new TypeError(`a count of what came back is a positive whole number: ${n}`);
    kept[kind] = n;
  }
  return kept;
}

export function tallyOf(items: readonly { kind: string }[]): Came {
  const came: Came = {};
  for (const { kind } of items) came[kind] = (came[kind] ?? 0) + 1;
  return came;
}

function coversOf(accounts: readonly string[]): string[] {
  return [...new Set(accounts)].sort();
}

function text(value: Json | null): string | null {
  return value === null ? null : canonical(value);
}

function parsed(value: string | null): Json | null {
  return value === null ? null : JSON.parse(value) as Json;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}
