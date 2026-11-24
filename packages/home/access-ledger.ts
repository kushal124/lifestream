import { createHash } from "node:crypto";
import { canonical, civilDay, dayBounds, type Counts, type DaySettings, type DetailType, type Json } from "@lifestreamprotocol/core";
import { ACCESS_CHANGED, CALL_ITEMS_KEPT, isRead, LAPSE_MS, type AccessBy, type AccessChange, type AccessRequest, type CallItem, type Came, type KeptItem, type Ledger, type ReaderCall, type ReaderCallBegun, type ReadTally, type StoredAccess, type Withheld } from "@lifestreamprotocol/model";
import { AccessError, numbered, parseAccess, resolve, widens, type Access, type DraftAccess, type DraftAllow, type End } from "@lifestreamprotocol/privacy";
import { emptyAccess, noAccess, reachesOf, type Existing } from "./access.js";
import type { Version } from "./access-edit.js";
import { ACCESS_CHANGED_WORDS, calendarOf, CHAT_ERASED, NOT_STARTED, NOTHING_OPEN, onceOf, OWN_CHANGED, PERSON_ONLY_WORDS, REQUEST_OVER, undroppableWords, type AskAnswer, type AskWant, type FoldCarried } from "./access-words.js";
import { Refusal, refuse } from "./refusal.js";
import { CURSOR_PARAMS } from "./search-contract.js";


export const ACCESS_NOT_STARTED = "ACCESS_NOT_STARTED";
const OLDER_MOST = 10_000;

export type StoredWant = AskWant | { access: Access };

export interface Folding { shown: number; run: { n: number; tally: FoldCarried } | null }
export interface Cursor { call: number | null; change: number | null; carry: { session: number; calls: number; to_ms: number; folding: Folding | null } | null }

export interface Tallying { days: readonly number[] | null; kinds_ms: number | null; today_ms?: number }

export type PersonWriting =
  | { list: { connected: readonly string[]; disconnected: readonly string[]; now_ms: number; tally: Tallying } }
  | { reader: { reader: string; now_ms: number; tally?: Tallying } }
  | { ask: { id: string; now_ms: number } }
  | { waiting: { readers: readonly string[]; now_ms: number } }
  | { history: { reader: string; cursor: Cursor; limit: number; day: DaySettings; kind: string | null; now_ms: number } }
  | { read: { reader: string; call: string; day: DaySettings } }
  | { things: { reader: string; call: string; after: ThingsAt | null; limit: number } }
  | { recent: { reader: string; limit: number; day: DaySettings } }
  | { save: { reader: string; access: DraftAccess; expect: Version; widen: boolean; by: AccessBy; device: string | null; existing: readonly Existing[]; now_ms: number } }
  | { propose: Narrowing }
  | { narrow: Narrowing }
  | { again: Again }
  | { answer: { id: string; answer: AskAnswer; expect: Version | null; access: DraftAccess | null; by: AccessBy; device: string | null; existing: readonly Existing[]; now_ms: number } }
  | { request: Asking }
  | { drop: { reader: string; drop: Drop; version: Version | null; existing: readonly Existing[]; now_ms: number } }
  | { unlist: { reader: string; now_ms: number } };

export type Drop = number | "everything" | "request";
export interface Asking { reader: string; want: AskWant; reason: string; for_ms: number | null; existing: readonly Existing[]; now_ms: number }

export interface Narrowing { reader: string; access: Access; expect: Version; by: AccessBy; device: string | null; existing: readonly Existing[]; now_ms: number }
export interface NarrowedTo { before: Json | null; version: Version }
export interface Again { reader: string; expect: Version; by: AccessBy; device: string | null }
export interface Sent { before: Json | null; after: Json; version: Version }
export interface HeldReader {
  access: StoredAccess | undefined; own: AccessRequest | undefined; own_until: number | null; open: AccessRequest | undefined; tally: ReadTally | null; kinds: Record<string, number> | null;
  today: Record<string, number> | null; last: ReaderCall | null;
}
export interface HeldAsk { request: AccessRequest; until_ms: number | null; access: StoredAccess | undefined; requested: { version: Version; lines: Json | null } | null }
export interface Answered { request: AccessRequest; until_ms: number | null; version: Version | null }
export type HeldCalls = Pick<HeldHistory, "calls" | "versions" | "counts" | "requests">;
export interface HeldHistory {
  calls: ReaderCall[]; changes: AccessChange[]; requests: AccessRequest[]; versions: Record<string, Json | null>; befores: Record<string, Json | null>; older: number;
  counts: Record<string, Counts>; scanned: number | null; days: Record<string, number>;
}
export interface HeldRead { calls: ReaderCall[]; versions: Record<string, Json | null>; counts: Record<string, Counts> }
export interface ThingsAt { call: number; at: number }
export interface HeldThings { items: (KeptItem & { call: number })[]; next: ThingsAt | null; erased: number; first: boolean }
export interface Proposed { change: AccessChange | null; request: AccessRequest | null; before: Json | null; version: Version }

export interface CallBegin {
  reader: string;
  tool: string;
  sent: Json;
  at_ms: number;
  initialize: boolean;
  existing: readonly Existing[];
}

export interface CallEnd {
  id: string;
  result: "answered" | "refused" | "failed";
  code?: string;
  words: string | null;
  ms: number;
  withheld: readonly Withheld[];
  read?: Json;
  came?: Came;
  items?: readonly CallItem[];
}

export type Begun = ReaderCallBegun | { moved: false };

export function beginIn(ledger: Ledger, { reader, tool, sent, at_ms, initialize, existing }: CallBegin): Begun {
  if (ledger.access.moved() === null) return { moved: false };
  return ledger.access.begin({ reader, tool, sent, read: null, at_ms, initialize, reaches: (lines) => reachesOf(parsedOr(lines), existing, at_ms) });
}

export function endIn(ledger: Ledger, { id, ...end }: CallEnd): boolean {
  return ledger.access.end(id, end);
}

export function writes(asked: PersonWriting): boolean {
  return "save" in asked || "propose" in asked || "narrow" in asked || "answer" in asked || "request" in asked || "drop" in asked || "unlist" in asked;
}

export function personIn(ledger: Ledger, asked: PersonWriting): unknown {
  if ("list" in asked) {
    const { connected, disconnected, now_ms, tally } = asked.list;
    const unlisted = ledger.access.unlisted();
    const listed = disconnected.filter((reader) => !unlisted.has(reader) && (ledger.access.removedBy(reader) !== "home" || ledger.access.tally(reader, []).total > 0));
    return Object.fromEntries([...connected, ...listed].map((reader) => [reader, heldReader(ledger, reader, now_ms, tally)]));
  }
  if ("reader" in asked) return heldReader(ledger, asked.reader.reader, asked.reader.now_ms, asked.reader.tally ?? null);
  if ("ask" in asked) return heldAsk(ledger, asked.ask.id, asked.ask.now_ms) ?? null;
  if ("waiting" in asked) {
    const { readers, now_ms } = asked.waiting;
    const standing = new Set(readers);
    return ledger.access.waiting(now_ms).filter((each) => standing.has(each.reader)).map((each) => heldAsk(ledger, each.id, now_ms)!);
  }
  if ("history" in asked) return heldHistory(ledger, asked.history);
  if ("read" in asked) return heldRead(ledger, asked.read);
  if ("things" in asked) return heldThings(ledger, asked.things);
  if ("recent" in asked) return heldRecent(ledger, asked.recent);
  if ("again" in asked) return againIn(ledger, asked.again);
  if ("unlist" in asked) return ledger.access.unlist(asked.unlist.reader, asked.unlist.now_ms);
  if (ledger.access.moved() === null) refuse(409, ACCESS_NOT_STARTED, NOT_STARTED);
  return changing(() => {
    if ("save" in asked) return saveIn(ledger, asked.save);
    if ("propose" in asked) return proposeIn(ledger, asked.propose);
    if ("narrow" in asked) return narrowIn(ledger, asked.narrow);
    if ("request" in asked) return askIn(ledger, asked.request);
    if ("drop" in asked) return dropIn(ledger, asked.drop);
    return answerIn(ledger, asked.answer);
  });
}

function heldReader(ledger: Ledger, reader: string, now_ms: number, tally: Tallying | null): HeldReader {
  const requests = ledger.access.requests(reader, now_ms);
  const own = requests.find((each) => each.by === "agent");
  return {
    access: ledger.access.get(reader), own, own_until: own === undefined ? null : endOf(ledger, own), open: requests.find((each) => each.state === "open"),
    tally: tally?.days == null ? null : ledger.access.tally(reader, tally.days),
    kinds: tally?.kinds_ms == null ? null : ledger.access.kinds(reader, tally.kinds_ms),
    today: tally?.today_ms === undefined ? null : ledger.access.kinds(reader, tally.today_ms),
    last: tally?.today_ms === undefined ? null : ledger.access.reads(reader, 1)[0] ?? null,
  };
}

function heldAsk(ledger: Ledger, id: string, now_ms: number): HeldAsk | undefined {
  const request = ledger.access.request(id, now_ms);
  if (request === undefined) return undefined;
  const row = ledger.access.requested(request.reader, id);
  return { request, until_ms: endOf(ledger, request), access: ledger.access.get(request.reader), requested: row === undefined ? null : { version: row.version, lines: row.lines } };
}

function endOf(ledger: Ledger, request: AccessRequest): number | null {
  if (request.state !== "allowed") return null;
  const granted = ledger.access.granted(request.reader, request.id);
  if (granted === undefined || granted.lines === null) return null;
  const was = ledger.access.made(request.reader, granted.version - 1)?.lines ?? null;
  const before = new Set((was === null ? [] : parsedOr(was).allow).map((allow) => canonical(allow as unknown as Json)));
  const made = parsedOr(granted.lines).allow.filter((allow) => !before.has(canonical(allow as unknown as Json)));
  const ends = new Set(made.map((allow) => allow.until_ms).filter((end): end is number => end !== null && end > granted.at_ms));
  const [end] = ends;
  return ends.size === 1 && end !== undefined ? end : null;
}

export type Entry = { at_ms: number; call: ReaderCall } | { at_ms: number; change: AccessChange };

export function entriesOf(calls: readonly ReaderCall[], changes: readonly AccessChange[], limit: number): { page: Entry[]; more: boolean } {
  const merged: Entry[] = [...calls.map((call) => ({ at_ms: call.at_ms, call })), ...changes.map((change) => ({ at_ms: change.at_ms, change }))]
    .sort((a, b) => b.at_ms - a.at_ms || ("call" in a ? 0 : 1) - ("call" in b ? 0 : 1) || seqOf(b) - seqOf(a));
  return { page: merged.slice(0, limit), more: merged.length > limit };
}

export function beyondOf(page: readonly Entry[], calls: readonly ReaderCall[]): ReaderCall | null {
  const shown = new Set(page.flatMap((each) => ("call" in each ? [each.call.seq] : [])));
  return calls.find((each) => !shown.has(each.seq)) ?? null;
}

function seqOf(entry: { call: ReaderCall } | { change: AccessChange }): number {
  return "call" in entry ? entry.call.seq : entry.change.seq;
}

function callsHeld(ledger: Ledger, reader: string, calls: readonly ReaderCall[], day: DaySettings): Pick<HeldHistory, "versions" | "counts"> {
  const versions: Record<string, Json | null> = {};
  const counts: Record<string, Counts> = {};
  for (const call of calls) {
    counts[call.id] = summed(call.outbound.map((seq) => ledger.outbound.row(seq, day)?.counts ?? {}));
    if (call.access_version === null || Object.hasOwn(versions, String(call.access_version))) continue;
    versions[String(call.access_version)] = ledger.access.made(reader, call.access_version)?.lines ?? null;
  }
  return { versions, counts };
}

export function summed(all: readonly Counts[]): Counts {
  const sum: Counts = {};
  for (const counts of all) {
    for (const [type, n] of Object.entries(counts) as [DetailType, number | undefined][]) if (n !== undefined && n > 0) sum[type] = (sum[type] ?? 0) + n;
  }
  return sum;
}

const UNJOINED: ReadonlySet<string> = new Set([...CURSOR_PARAMS, "limit"]);

function askedIn(call: Pick<ReaderCall, "read" | "sent">): Record<string, Json> {
  const of = (value: Json) => (typeof value === "object" && value !== null && !Array.isArray(value) ? value : {});
  const read = of(call.read);
  return Object.keys(read).length > 0 ? read : of(call.sent);
}

export function questionKey(call: Pick<ReaderCall, "tool" | "read" | "sent">): string {
  const asked = askedIn(call);
  return `${call.tool}\0${canonical(Object.fromEntries(Object.entries(asked).filter(([name]) => !UNJOINED.has(name))))}`;
}

function continues(call: Pick<ReaderCall, "read" | "sent">): boolean {
  const asked = askedIn(call);
  return [...CURSOR_PARAMS].some((name) => asked[name] !== undefined && asked[name] !== null);
}

export function joinsOf(calls: readonly ReaderCall[]): Map<number, number> {
  const roots = new Map<string, number>();
  const joins = new Map<number, number>();
  for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
    const key = `${call.session}\0${questionKey(call)}`;
    const root = roots.get(key);
    if (root !== undefined && continues(call)) joins.set(call.seq, root);
    else roots.set(key, call.seq);
  }
  return joins;
}

const SCAN_PAGE = 500;

function sessionAround(ledger: Ledger, call: ReaderCall): ReaderCall[] {
  const log = ledger.access;
  const earlier: ReaderCall[] = [];
  for (let before = call.seq, looked = 0; looked < OLDER_MOST;) {
    const page = log.calls(call.reader, { before, limit: SCAN_PAGE });
    const same = page.filter((each) => each.session === call.session);
    earlier.push(...same);
    looked += page.length;
    if (same.length < page.length || page.length < SCAN_PAGE) break;
    before = page.at(-1)!.seq;
  }
  const later: ReaderCall[] = [];
  for (let after = call.seq, looked = 0; looked < OLDER_MOST;) {
    const page = log.later(call.reader, { after, limit: SCAN_PAGE });
    const same = page.filter((each) => each.session === call.session);
    later.push(...same);
    looked += page.length;
    if (same.length < page.length || page.length < SCAN_PAGE) break;
    after = page.at(-1)!.seq;
  }
  return [...earlier.reverse(), call, ...later];
}

function joinedOf(ledger: Ledger, call: ReaderCall): ReaderCall[] {
  const session = sessionAround(ledger, call);
  const joins = joinsOf(session);
  const root = joins.get(call.seq) ?? call.seq;
  return session.filter((each) => each.seq === root || joins.get(each.seq) === root);
}

function heldRead(ledger: Ledger, { reader, call: id, day }: Extract<PersonWriting, { read: unknown }>["read"]): HeldRead | null {
  const call = ledger.access.call(id);
  if (call === undefined || call.reader !== reader) return null;
  const calls = joinedOf(ledger, call);
  return { calls, ...callsHeld(ledger, reader, calls, day) };
}

function heldThings(ledger: Ledger, { reader, call: id, after, limit }: Extract<PersonWriting, { things: unknown }>["things"]): HeldThings | null {
  const call = ledger.access.call(id);
  if (call === undefined || call.reader !== reader) return null;
  const calls = joinedOf(ledger, call);
  if (after !== null && !calls.some((each) => each.seq === after.call)) return null;
  const items: HeldThings["items"] = [];
  let erased = 0;
  let next: ThingsAt | null = null;
  for (const each of calls) {
    const kept = ledger.access.items(each.seq, { limit: 0 });
    const brought = Object.values(each.came ?? {}).reduce((sum, n) => sum + n, 0);
    erased += Math.max(0, Math.min(brought, CALL_ITEMS_KEPT) - kept.kept);
    if (next !== null || (after !== null && each.seq < after.call)) continue;
    const page = ledger.access.items(each.seq, { ...(after !== null && each.seq === after.call ? { after: after.at } : {}), limit: limit - items.length + 1 });
    for (const item of page.items) {
      if (items.length === limit) {
        next = { call: items.at(-1)!.call, at: items.at(-1)!.at };
        break;
      }
      items.push({ ...item, call: each.seq });
    }
  }
  return { items, next, erased, first: after === null };
}

function heldRecent(ledger: Ledger, { reader, limit, day }: Extract<PersonWriting, { recent: unknown }>["recent"]): HeldCalls {
  const calls = ledger.access.reads(reader, limit);
  return { calls, ...callsHeld(ledger, reader, calls, day), requests: [] };
}

function heldHistory(ledger: Ledger, { reader, cursor, limit, day, kind, now_ms }: Extract<PersonWriting, { history: unknown }>["history"]): HeldHistory {
  const log = ledger.access;
  const page = (before: number | null, size: number): { calls: ReaderCall[]; next: number | null } => {
    const at = before === null ? {} : { before };
    if (kind === null) {
      const calls = log.calls(reader, { ...at, limit: size });
      return { calls, next: calls.length === size ? calls.at(-1)!.seq : null };
    }
    return log.calls(reader, { ...at, limit: size, kind, scan: OLDER_MOST });
  };
  const first = page(cursor.call, limit + 1);
  const calls = first.calls;
  const scanned = calls.length > limit ? null : first.next;
  const changes = kind !== null ? [] : log.changes(reader, { ...(cursor.change === null ? {} : { before: cursor.change }), limit: limit + 1 });
  const { versions, counts } = callsHeld(ledger, reader, calls, day);
  let older = 0;
  const beyond = beyondOf(entriesOf(calls, changes, limit).page, calls);
  if (beyond !== null) {
    const same: ReaderCall[] = [];
    let before: number | null = beyond.seq + 1;
    let looked = 0;
    while (before !== null && looked < OLDER_MOST) {
      const more = page(before, SCAN_PAGE);
      const other = more.calls.findIndex((each) => each.session !== beyond.session);
      same.push(...(other === -1 ? more.calls : more.calls.slice(0, other)));
      looked += kind === null ? more.calls.length : OLDER_MOST;
      if (other !== -1) break;
      before = more.next;
    }
    const joins = joinsOf(same);
    older = same.filter((each) => isRead(each) && !joins.has(each.seq)).length;
  }
  const requests = new Map<string, AccessRequest>();
  for (const change of changes) {
    if (change.request === null || requests.has(change.request)) continue;
    const request = log.request(change.request, now_ms);
    if (request !== undefined) requests.set(request.id, request);
  }
  if (calls.length > 0) for (const request of log.told(reader, { from_ms: calls.at(-1)!.at_ms, to_ms: calls[0]!.at_ms, limit: calls.length })) requests.set(request.id, request);
  const befores: Record<string, Json | null> = {};
  for (const change of changes) if (change.what === "narrowed") befores[String(change.seq)] = log.made(reader, change.version - 1)?.lines ?? null;
  return { calls, changes, requests: [...requests.values()], versions, befores, older, counts, scanned, days: daysRead(ledger, reader, calls.slice(0, limit), day, kind) };
}

function daysRead(ledger: Ledger, reader: string, calls: readonly ReaderCall[], day: DaySettings, kind: string | null): Record<string, number> {
  const calendar = calendarOf(day.zone);
  const days: Record<string, number> = {};
  for (const on of new Set(calls.map((each) => civilDay(each.at_ms, calendar)))) {
    const { start_ms, end_ms } = dayBounds(on, calendar);
    const reads = ledger.access.readsIn(reader, { from_ms: start_ms, to_ms: end_ms, limit: OLDER_MOST }).filter((each) => kind === null || Object.hasOwn(each.came ?? {}, kind));
    const joins = joinsOf(reads);
    days[on] = reads.filter((each) => !joins.has(each.seq)).length;
  }
  return days;
}

function saveIn(ledger: Ledger, { reader, access: draft, expect, widen, by, device, existing, now_ms }: Extract<PersonWriting, { save: unknown }>["save"]): StoredAccess {
  const log = ledger.access;
  const access = resolve(draft, now_ms);
  const now = log.get(reader);
  if ((now?.version ?? 0) !== expect) changed();
  if (now !== undefined && canonical(now.lines) === canonical(access as unknown as Json)) return now;
  const wider = widens(accessAt(reader, now), access, existing);
  if (wider && !widen) refuse(403, "PERSON_ONLY", PERSON_ONLY_WORDS);
  return log.change(reader, { from: expect, what: wider ? "widened" : "narrowed", lines: access as unknown as Json, covers: reachesOf(access, existing, now_ms) }, { at_ms: now_ms, by, device });
}

function proposeIn(ledger: Ledger, narrowing: Narrowing): Proposed {
  const { reader, access, expect, by, device, now_ms } = narrowing;
  const log = ledger.access;
  const now = log.get(reader);
  const key = wantKey({ access });
  if (canonical(now === undefined ? noAccess(reader) as unknown as Json : now.lines) === canonical(access as unknown as Json)) return kept(ledger, reader, now?.version ?? 0, key, now_ms, by);
  const open = log.requests(reader, now_ms).find((each) => each.by === "chat" && each.state === "open");
  if (open !== undefined && open.want_key === key) return { change: null, request: open, before: null, version: now?.version ?? 0 };
  const narrowed = narrowIn(ledger, narrowing);
  if (narrowed !== null) return kept(ledger, reader, narrowed.version, key, now_ms, by);
  return { change: null, request: log.ask(reader, { from: expect, want: { access } as unknown as Json, want_key: key, reason: "", for_ms: null }, { at_ms: now_ms, by, device }), before: null, version: expect };
}

function narrowIn(ledger: Ledger, { reader, access, expect, by, device, existing, now_ms }: Narrowing): NarrowedTo | null {
  const log = ledger.access;
  const now = log.get(reader);
  if ((now?.version ?? 0) !== expect) changed();
  if (widens(accessAt(reader, now), access, existing)) return null;
  const stored = log.change(reader, { from: expect, what: "narrowed", lines: access as unknown as Json, covers: reachesOf(access, existing, now_ms) }, { at_ms: now_ms, by, device });
  return { before: now?.lines ?? null, version: stored.version };
}

function againIn(ledger: Ledger, { reader, expect, by, device }: Again): Sent | null {
  const log = ledger.access;
  const now = log.get(reader);
  const row = now?.version === expect + 1 ? log.made(reader, now.version) : undefined;
  if (now === undefined || row?.what !== "narrowed" || row.by !== by || row.device !== device) return null;
  return { before: log.made(reader, expect)?.lines ?? null, after: now.lines, version: now.version };
}

function kept(ledger: Ledger, reader: string, version: Version, key: string, now_ms: number, by: AccessBy): Proposed {
  const log = ledger.access;
  let row = log.made(reader, version);
  while (row?.what === "joined") row = log.made(reader, row.version - 1);
  if (row?.what === "narrowed" && row.by === by) return { change: row, request: null, before: log.made(reader, row.version - 1)?.lines ?? null, version };
  const request = row?.what === "allowed" && row.request !== null ? log.request(row.request, now_ms) : undefined;
  if (request?.want_key === key) return { change: null, request, before: null, version };
  return { change: null, request: null, before: null, version };
}

function answerIn(ledger: Ledger, { id, answer, expect, access, by, device, existing, now_ms }: Extract<PersonWriting, { answer: unknown }>["answer"]): Answered {
  const log = ledger.access;
  const asked = log.request(id, now_ms) ?? refuse(404, "AGENT_REQUEST_GONE", REQUEST_OVER);
  const now = log.get(asked.reader);
  if (asked.state !== "open") return { request: asked, until_ms: endOf(ledger, asked), version: now?.version ?? null };
  if (answer === "no") {
    const done = log.answer(id, { from: now?.version ?? 0, answer: "declined" }, { at_ms: now_ms, by, device })!;
    return { request: done.request, until_ms: null, version: now?.version ?? null };
  }
  if (asked.want === null) refuse(409, "AGENT_REQUEST_ERASED", CHAT_ERASED);
  const want = asked.want as unknown as StoredWant;
  if (asked.by === "chat" && answer === "once") refuse(422, "BAD_REQUEST", "Chat's change is allowed or not: answer always or no");
  const from = drawnFrom(ledger, asked);
  if (expect !== from.version) changed();
  const draft = access ?? ("access" in want ? parseAccess(want.access)
    : allowWant(from.lines === null ? noAccess(asked.reader) : parsedOr(from.lines), want, answer === "always" ? null : onceOf(asked.for_ms), existing));
  const lines = resolve(draft, now_ms);
  const done = log.answer(id, { from: from.version, answer: "allowed", lines: lines as unknown as Json, covers: reachesOf(lines, existing, now_ms) }, { at_ms: now_ms, by, device });
  if (done === undefined) refuse(404, "AGENT_REQUEST_GONE", REQUEST_OVER);
  return { request: done.request, until_ms: endOf(ledger, done.request), version: log.get(asked.reader)?.version ?? null };
}

export type Requested = { request: AccessRequest } | { held: { declined_ms: number; until_ms: number | null } };
export type Asked = Requested | { already: true };

export function askIn(ledger: Ledger, { existing, ...asking }: Asking): Asked {
  const now = accessAt(asking.reader, ledger.access.get(asking.reader));
  const allowed = resolve(allowWant(now, asking.want, asking.for_ms, existing), asking.now_ms);
  if (!widens(now, allowed, existing)) return { already: true };
  return requestIn(ledger, asking);
}

export type Dropped = { access: StoredAccess | undefined; dropped: AccessRequest | null; changed: boolean };

function dropIn(ledger: Ledger, { reader, drop, version: read, existing, now_ms }: Extract<PersonWriting, { drop: unknown }>["drop"]): Dropped {
  const log = ledger.access;
  const held = log.get(reader);
  const version = held?.version ?? 0;
  if (read !== null && read !== version) refuse(409, "ACCESS_CHANGED", OWN_CHANGED);
  const by = { at_ms: now_ms, by: "agent" as const, device: null };
  if (drop === "request") return { access: held, dropped: log.drop(reader, version, by) ?? refuse(404, "AGENT_REQUEST_GONE", NOTHING_OPEN), changed: true };
  const now = accessAt(reader, held);
  let allow = now.allow;
  if (drop === "everything") allow = [];
  else {
    const lines = numbered(now);
    const line = lines.find((each) => each.number === drop);
    if (line?.member !== "allow") refuse(422, "BAD_REQUEST", undroppableWords(drop, line?.member ?? null, lines.length));
    allow = now.allow.filter((_, index) => index !== line.index);
  }
  if (allow.length === now.allow.length) return { access: held, dropped: null, changed: false };
  const access: Access = { ...now, allow };
  return { access: log.change(reader, { from: version, what: "narrowed", lines: access as unknown as Json, covers: reachesOf(access, existing, now_ms) }, by), dropped: null, changed: true };
}

export function requestIn(ledger: Ledger, { reader, want, reason, for_ms, now_ms }: { reader: string; want: AskWant; reason: string; for_ms: number | null; now_ms: number }): Requested {
  const log = ledger.access;
  const key = wantKey(want);
  const declined = declinedSince(ledger, reader, key, now_ms);
  if (declined.length >= 2) return { held: { declined_ms: declined[0]!, until_ms: null } };
  if (declined.length === 1 && now_ms < declined[0]! + LAPSE_MS) return { held: { declined_ms: declined[0]!, until_ms: declined[0]! + LAPSE_MS } };
  return { request: log.ask(reader, { from: log.get(reader)?.version ?? 0, want: want as unknown as Json, want_key: key, reason, for_ms }, { at_ms: now_ms, by: "agent", device: null }) };
}

const PERSON_CHANGES: ReadonlySet<string> = new Set(["granted", "widened", "narrowed", "allowed"]);
const CHANGES_PAGE = 200;

function declinedSince(ledger: Ledger, reader: string, key: string, now_ms: number): number[] {
  const declined: number[] = [];
  let before: number | undefined;
  for (;;) {
    const page = ledger.access.changes(reader, { ...(before === undefined ? {} : { before }), limit: CHANGES_PAGE });
    for (const row of page) {
      if (PERSON_CHANGES.has(row.what) && row.by === "person") return declined;
      if (row.what === "declined" && row.request !== null && ledger.access.request(row.request, now_ms)?.want_key === key) declined.push(row.at_ms);
      if (declined.length === 2) return declined;
    }
    if (page.length < CHANGES_PAGE) return declined;
    before = page.at(-1)!.seq;
  }
}

function drawnFrom(ledger: Ledger, request: AccessRequest): { version: Version; lines: Json | null } {
  if (request.by === "chat") {
    const row = ledger.access.requested(request.reader, request.id);
    return { version: row?.version ?? 0, lines: row?.lines ?? null };
  }
  const now = ledger.access.get(request.reader);
  return { version: now?.version ?? 0, lines: now?.lines ?? null };
}

function changing<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof Refusal) && (error as { code?: unknown }).code === ACCESS_CHANGED) changed();
    throw error;
  }
}

export function changed(): never {
  return refuse(409, "ACCESS_CHANGED", ACCESS_CHANGED_WORDS);
}

export function wantKey(want: StoredWant): string {
  return createHash("sha256").update(canonical(want as unknown as Json)).digest("hex");
}

export function allowWant(access: DraftAccess, want: AskWant, lasts_ms: number | null, existing: readonly Existing[]): DraftAccess {
  const end: End = lasts_ms === null ? { until_ms: null } : { lasts_ms };
  const read = want.read;
  const grant = (reach: DraftAllow["reach"]): DraftAllow => ({ reach, window: want.window, ...end });
  if (read === "everything") return { ...access, allow: [...access.allow, grant({ all: true, but: [] })] };
  if ("category" in read) return { ...access, allow: [...access.allow, grant({ type: read.category, but: [] })] };
  if ("product" in read) {
    const accounts = existing.filter((each) => each.account.split(":")[0] === read.product);
    return { ...access, allow: [...access.allow, ...accounts.map((each) => grant({ account: each.account, but: [] }))] };
  }
  return { ...access, allow: [...access.allow, grant({ account: read.account, but: [] })] };
}

export function accessAt(reader: string, held: StoredAccess | undefined): Access {
  return held === undefined ? noAccess(reader) : parsedOr(held.lines);
}

export function parsedOr(lines: Json): Access {
  try {
    return parseAccess(lines);
  } catch (error) {
    if (error instanceof AccessError) return emptyAccess();
    throw error;
  }
}
