import type { IncomingMessage } from "node:http";
import type { Connector } from "@lifestreamprotocol/connect";
import { accountOf, addDays, canonical, civilDay, dayBounds, duration, TimeError, TYPES, type Counts, type DaySettings, type Json, type JsonObject, type SourceRow, type Type } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { isRead, LAPSE_MS, reasonFault, type AccessChange as ChangeRow, type AccessRequest, type Came, type ReaderCall, type StoredAccess, type Withheld } from "@lifestreamprotocol/model";
import { AccessError, parseAccess, parseDraft, resolve, widens, type Access, type DraftAccess } from "@lifestreamprotocol/privacy";
import { ASK_READER, defaultAccess, noAccess, reachesOf } from "./access.js";
import {
  agentWords, applyEdit, EditError, parseEdit, personWords, reachesScreen, viewOf, type AccessView, type Edit, type EditorAccount, type EditorSources, type ReadsByKind, type Version,
} from "./access-edit.js";
import {
  accessAt, allowWant, beyondOf, changed, entriesOf, joinsOf, parsedOr, questionKey, summed,
  type Answered, type Asked, type Cursor, type Drop, type Dropped, type Folding, type HeldAsk, type HeldCalls, type HeldHistory, type HeldRead, type HeldReader, type HeldThings, type NarrowedTo, type PersonWriting, type Proposed, type Sent, type StoredWant, type Tallying, type ThingsAt,
} from "./access-ledger.js";
import {
  ACCESS_UNSAVED, addsOf, AGENT_GONE, amountOf, askedLine, calendarOf, cameKinds, changedBy, CHAT_LISTED, CHAT_NOT_DISCONNECTED, agentLines, agentReads, agentText, ALREADY, askLine, ASKED, callLine, changeWords, CHAT_ERASED, CHAT_HIDES, chatHeadOf, chatLine, choicesOf,
  dayMonthWords, dayWordsOf, defaultOf, seeAllWords, differenceOf, disconnectedWords, disconnectingOf, unlistingOf, DROP_VERSION, droppedWords, stillConnected, erasedHead, figureOf, goneWords, headOf, heldWords, keepsOf, keptAbout, keptRows, KIND_READS_DAYS, kindNamed, listed, narrowedWords, neverReadOf, outcomeOf, PERSON_ONLY_WORDS,
  addressOf, ANYWHERE_KEY_ONLY, connectedLine, KEY_ROWS, keyOnMac, pickLine, pickWords, placeOf, quietOf, readCount, readLine, repeatWords, REQUEST_OVER, requestWords, saidOf, sawOf, saysTitle, SCREEN, seesOf, sentenceOf, showOf, SHOW_EARLIER, phraseText, signInHead, signingInLine, signInNotice, signInOver, thingsTitle, toldWords, unchangedWords, underLine, underOf, unshownWords, wantsOf, thingWhen, whyOf, carriedOf, foldOf, foldTally, foldWords, isCarried, tallyOf,
  type AccessCallRead, type Address, type AgentReads, type AskAnswer, type AskWant, type Bolded, type CallShown, type ClockPhrase, type CameKind, type Disconnecting, type Fold, type FoldTally, type KeptRow, type ReadsFigure, type Repeated, type Unlisting, type ReadWant, type Words,
} from "./access-words.js";
import { appOfHost, KEY_APPS, keyWholeOn, markOf, nameOf as guideName, signInFrom, type GuideApp, type KeyApp, type Sees } from "./agent-guides.js";
import { claudeCodeLine, MCP_URL, SIGN_IN_CODE, type MintedKey, type SignInAnswer, type SignInAnswered, type SignInGranted, type SignInHeld, type Waiting } from "./agents.js";
import type { PublicState } from "./funnel.js";
import { catalogOf } from "./catalog.js";
import { deviceOf as passDevice, type GrantApp, type Principal } from "./principals.js";
import { Refusal, refuse } from "./refusal.js";
import { REFS_CHARS, REFS_MOST, type Citation, type DescribeAnswer, type Opens } from "./search-contract.js";
import { readsSource } from "./sources-read.js";


export const AGENTS_ROUTE = "/v1/agents";
export const WAITING_ROUTE = "/v1/agents/waiting";
export const GUIDES_ROUTE = "/v1/agents/guides";
export const ANSWER_ROUTE = "/v1/agents/answer";
export const ADDRESS_ROUTE = "/v1/agents/address";
export const KEYS_ROUTE = "/v1/agents/keys";
const READER_ROUTE = /^\/v1\/agents\/(ask|p-[0-9a-f]{8})(\/history|\/access|\/propose|\/disconnect|\/unlist)?$/u;
const AGENT_ID = /^p-[0-9a-f]{8}$/u;
const READ_PAGE_ROUTE = /^\/v1\/agents\/(ask|p-[0-9a-f]{8})\/reads\/(call-[0-9a-f]{16})(\/things)?$/u;
const REQUEST_ID = "rq-[0-9a-f]{16}";
const ASK_ROUTE = new RegExp(`^/v1/agents/asks/(${REQUEST_ID})$`, "u");
const SIGN_IN_ROUTE = /^\/v1\/agents\/signins\/([A-Za-z0-9_-]{22})$/u;
const IS_REQUEST = new RegExp(`^${REQUEST_ID}$`, "u");
export const HISTORY_PAGE = 50;
export const RECENT_READS = 2;
const RECENT_SCAN = 50;
export const THINGS_PAGE = 50;
const READ_UNKNOWN = "This read isn’t in this agent’s history.";


export interface AgentAsk {
  id: string; reader: string; name: string; by: "agent" | "chat";
  head: string; line: string; asked_line: ClockPhrase; under_line: ClockPhrase; says_title: string; wants: string; today: Bolded; under: string | null;
  reason: string | null; screen: string | null;
  adds: string[]; keeps: string | null;
  choices: { answer: AskAnswer; words: string }[];
  editable: boolean;
  default: AskAnswer;
  version: Version; proposed: DraftAccess;
  at_ms: number; until_ms: number;
  state: AccessRequest["state"]; outcome: ClockPhrase | null;
}

export interface SignIn extends Waiting { head: string; over_line: ClockPhrase; sentence: string; access: Access; view: AccessView; pick: string; pick_line: string; over: string; app: GuideApp | null; notice: string }
const editable = (choices: readonly { answer: AskAnswer }[]): boolean => choices.some((choice) => choice.answer !== "no");

export interface WaitingList { requests: SignIn[]; asks: AgentAsk[] }
export interface GuidesHeld { readers: readonly ReaderEntry[]; sees(name: string): Sees }
export interface Connected { reader: string; line: string }
export interface AnswerReply { state: "approved" | "wrong" | "denied" | AccessRequest["state"]; version: Version | null; outcome: ClockPhrase | null; reader: string | null; connected: Connected | null }
export interface SignInRead { id: string; state: "waiting" | "gone" | SignInAnswer["state"]; outcome: ClockPhrase | null; reader: string | null; connected: Connected | null }
export interface KeyRow { label: string; text: string }
export interface MadeKey { reader: string; name: string; rows: KeyRow[]; connected: Connected }
export interface KeyAsked { app: KeyApp; name: string | null; access: Access; device: string }
export interface AddressAsked { reader: string | null }
export interface AgentList { readers: AgentRow[] }

export type ReaderState = "connected" | "disconnected";
export interface AgentRow { id: string; name: string; kind: "chat" | "agent"; state: ReaderState; summary: string; place: string; reads: AgentReads; has_ask: boolean; mark: string }
export interface AgentRead {
  id: string; name: string; kind: "chat" | "agent"; state: ReaderState; how: string; place: string; disconnected: string | null; reads: AgentReads; figure: ReadsFigure; mark: string;
  access: Access; version: Version; view: AccessView; ask: AgentAsk | null; disconnect: Disconnecting | null; unlist: Unlisting | null;
  recent: { lines: HistoryRead[]; all: string | null };
}
export interface HistoryRead extends CallShown { kind: "call"; id: string; at_ms: number; more: number; took_ms: number | null; told: string | null }
export interface HistoryChange { kind: "change"; at_ms: number; icon: string; words: string; line: string | null; ask: string | null; tone: "plain" | "waiting" }
export interface HistoryFold { kind: "fold"; at_ms: number; n: number; icon: string; words: string; line: string; lines: HistoryRead[]; continues: boolean }
export type HistoryLine = HistoryRead | HistoryChange | HistoryFold;
export interface SessionDay { day: string; words: string; reads: string | null }
export interface HistorySession { key: string; from_ms: number; to_ms: number; day: SessionDay; calls: number; reads: string | null; lines: HistoryLine[] }
export interface Chip { kind: string; name: string; icon: string; n: number }
export interface HistoryPage {
  figure: ReadsFigure | null; chips: Chip[]; kind: string | null; empty: { title: string; line: string } | null;
  sessions: HistorySession[]; next: { before: string; words: string } | null;
}
export interface ReadPage {
  id: string; reader: string; name: string; title: string; line: string;
  figure: { n: number; words: string } | null; kinds: CameKind[];
  kept: { about: string; rows: KeptRow[]; held: string | null } | null;
  why: Bolded | null; refused: string | null; show: { words: string; n: number } | null;
}
export interface Thing { ref: string; title: string; line: string | null; when: string | null; day: string | null; at_ms: number | null; opens: Opens }
export interface ThingsPage { title: string; gone: string | null; groups: (Chip & { things: Thing[] })[]; next: string | null }
export interface Narrowed { words: Bolded; undo: { access: Access; expect: Version } }
export interface AccessDraft { access: DraftAccess; expect: Version | null; view: AccessView; narrowed: Narrowed | null; saved: { access: Access; view: AccessView } | null }
export type AccessChange =
  | ({ id: string; kind: "narrowed"; reader: string } & Narrowed)
  | { id: string; kind: "asked"; snapshot: AgentAsk }
  | { id: string; kind: "unchanged"; reader: string; words: string };


export interface ReaderEntry {
  id: string;
  name: string;
  kind: "chat" | "agent";
  how: string;
  via: "sign-in" | "pass" | null;
  from: string | null;
  app: GrantApp | null;
  anywhere: boolean;
  made_ms: number;
  disconnected_ms: number | null;
  listed: boolean;
}

const WEEK_DAYS = 7;
const DAY_MS = 24 * 3_600_000;

export interface Asker {
  pass: Principal;
  ask: boolean;
  widen: boolean;
}

export interface PersonInputs {
  writer: { person<T>(asked: PersonWriting): Promise<T> };
  signIns: {
    waiting(http: IncomingMessage): Promise<{ requests: Waiting[] }>;
    read(id: string, http: IncomingMessage): Promise<SignInHeld>;
    answer(answer: { id: string; answer: string | "deny"; access?: Access; device: string }, http: IncomingMessage): Promise<SignInAnswered>;
  };
  offered(): Promise<readonly EditorAccount[]>;
  readers(): readonly ReaderEntry[];
  disconnect(id: string, device: string, http: IncomingMessage): Promise<void>;
  address(asked: AddressAsked | null, http: IncomingMessage): Promise<PublicState>;
  key(asked: KeyAsked, http: IncomingMessage): Promise<MintedKey>;
  describe(refs: readonly string[]): Promise<DescribeAnswer>;
  device(pass: string): string | null;
  clock: () => number;
  day: () => DaySettings;
}

export function offeredOf(sources: readonly SourceRow[], connectors: readonly Connector[], families: readonly Pick<Family, "name" | "inputs">[]): EditorAccount[] {
  const catalog = catalogOf(connectors);
  const screen = families.find((family) => family.name === "screen");
  const found = new Map<string, EditorAccount>();
  const types = new Map<string, Set<Type>>();
  const roads = new Map<string, string | null>();
  for (const row of [...sources].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!families.some((family) => readsSource(family, row))) continue;
    const account = accountOf(row.id);
    const connector = catalog.of(row);
    const held = found.get(account);
    const reads = screen !== undefined && readsSource(screen, row);
    const declared = types.get(account) ?? new Set<Type>();
    if (connector?.type !== undefined && connector.type !== null) declared.add(connector.type);
    types.set(account, declared);
    if (held !== undefined) {
      found.set(account, { ...held, screen: held.screen || reads });
      continue;
    }
    const part = account.slice(account.indexOf(":") + 1);
    const arrives = new Set(connector?.sources.flatMap((source) => (typeof source.arrives === "string" ? [source.arrives] : [...source.arrives])) ?? []);
    roads.set(account, arrives.size === 1 ? DEVICE_WORDS[[...arrives][0]!] ?? null : null);
    found.set(account, {
      account, category: null, name: connector?.name ?? account.slice(0, account.indexOf(":")),
      line: part === "local" ? null : part, screen: reads,
    });
  }
  const offered = [...found.values()].map((each) => ({ ...each, category: firstType(types.get(each.account)!) }));
  return offered.map((each) => (each.line !== null || !offered.some((other) => other !== each && other.name === each.name) ? each
    : { ...each, line: roads.get(each.account) ?? each.account.slice(0, each.account.indexOf(":")) }));
}

function firstType(declared: ReadonlySet<Type>): Type | null {
  return (Object.keys(TYPES) as Type[]).find((type) => declared.has(type)) ?? null;
}

const DEVICE_WORDS: Readonly<Record<string, string>> = { mac: "Mac", phone: "iPhone" };
const ownOutcome = (outcome: ClockPhrase | null, now_ms: number, zone: string): string | null => (outcome === null ? null : phraseText(outcome, now_ms, zone));


export interface OwnAccess {
  version: Version;
  access: Access;
  lines: string[];
  text: string;
  request: { id: string; wants: string; at_ms: number; until_ms: number } | null;
  answer: { id: string; wants: string; state: AccessRequest["state"]; outcome: string | null } | null;
  outside: string[];
}

export interface OwnRequest { state: "asked" | "already" | "held"; words: string; request: OwnAccess["request"] }
export interface OwnDrop { words: string; now: OwnAccess }

export interface PersonRoutes {
  own(reader: string, held: StoredAccess | undefined): Promise<OwnAccess>;
  request(reader: string, said: JsonObject, putBack: (value: string) => Promise<string>): Promise<{ answer: OwnRequest; read: Json }>;
  drop(reader: string, said: JsonObject): Promise<{ answer: OwnDrop; read: Json }>;
  routes(method: string | undefined, pathname: string): boolean;
  waiting(asker: Asker, http: IncomingMessage): Promise<WaitingList>;
  guides(asker: Asker): Promise<GuidesHeld>;
  serve(asker: Asker, request: IncomingMessage, url: URL, body: (request: IncomingMessage) => Promise<JsonObject>): Promise<[number, JsonObject]>;
}

export function openPersonAccess(inputs: PersonInputs): PersonRoutes {
  const { writer } = inputs;
  const home = async () => {
    const sources: EditorSources = { accounts: await inputs.offered() };
    const zone = inputs.day().zone;
    return { sources, zone, now_ms: inputs.clock(), words: personWords(sources, zone) };
  };
  type Home = Awaited<ReturnType<typeof home>>;
  const readerOf = (id: string): ReaderEntry => inputs.readers().find((each) => each.id === id) ?? refuse(404, "AGENT_UNKNOWN", AGENT_GONE);
  const connectedOf = (id: string): ReaderEntry => {
    const entry = readerOf(id);
    return entry.disconnected_ms === null ? entry : refuse(404, "AGENT_UNKNOWN", AGENT_GONE);
  };
  const connectedIds = () => inputs.readers().filter((each) => each.disconnected_ms === null).map((each) => each.id);
  const nameOf = (id: string) => inputs.readers().find((each) => each.id === id)?.name ?? "An agent";
  const deviceOf = (pass: string | null) => (pass === null ? null : inputs.device(pass));

  const weekOf = (now_ms: number) => {
    const day = calendarOf(inputs.day().zone);
    const today = civilDay(now_ms, day);
    return Array.from({ length: WEEK_DAYS }, (_, index) => {
      const each = addDays(today, index - (WEEK_DAYS - 1));
      return { day: each, start_ms: dayBounds(each, day).start_ms };
    });
  };
  type Week = ReturnType<typeof weekOf>;
  const sessionDay = (now_ms: number) => {
    const day = calendarOf(inputs.day().zone);
    const today = civilDay(now_ms, day);
    return (ms: number): Omit<SessionDay, "reads"> => {
      const on = civilDay(ms, day);
      return { day: on, words: dayWordsOf(on, today, addDays(today, -1), ms, day.zone) };
    };
  };
  const tallying = (week: Week | null, now_ms: number, kinds: boolean): Tallying => ({
    days: week === null ? null : week.map((each) => each.start_ms), kinds_ms: kinds ? now_ms - KIND_READS_DAYS * DAY_MS : null, ...(week === null ? {} : { today_ms: week.at(-1)!.start_ms }),
  });
  const readsOf = (held: HeldReader, week: Week, zone: string): AgentReads => agentReads({
    last_ms: held.tally?.last_ms ?? null, total: held.tally?.total ?? 0, first_ms: held.tally?.first_ms ?? null,
    days: week.map((each, index) => ({ ...each, n: held.tally?.within[index] ?? 0 })),
  }, zone);

  const shutOf = (access: Access, at: Home): Type[] => {
    const reached = new Set(reachesOf(access, at.sources.accounts, at.now_ms));
    return (Object.keys(TYPES) as Type[]).filter((type) => {
      const accounts = at.sources.accounts.filter((each) => each.category === type);
      return accounts.length > 0 && accounts.every((each) => !reached.has(each.account));
    });
  };
  const figureFor = (held: HeldReader, reads: AgentReads, entry: ReaderEntry, access: Access, at: Home): ReadsFigure => {
    const today: Came = held.today ?? {};
    const said = reads.today > 0 ? saidOf(entry.name, today, entry.kind === "chat" ? [] : shutOf(access, at))
      : held.last === null ? [] : quietOf({ at_ms: held.last.at_ms, words: historyRead(held.last, { calls: [], versions: {}, counts: {}, requests: [] }, entry.name, at.words).words }, at.now_ms, at.zone);
    return figureOf(reads, said);
  };
  const chipsOf = (held: HeldReader): Chip[] => cameKinds(held.today ?? {}).map(({ kind, name, icon, n }) => ({ kind, name, icon, n }));

  const narrowedOf = (entry: ReaderEntry, before: Access, after: Access, version: Version, at: Home): Narrowed => {
    const said = { accounts: at.sources.accounts, now_ms: at.now_ms, chat: entry.kind === "chat" };
    return { words: narrowedWords(entry.name, before, after, at.words, said), undo: { access: before, expect: version } };
  };

  const askOf = (held: HeldAsk, at: Home): AgentAsk => {
    const { request } = held;
    const name = nameOf(request.reader);
    if (request.want === null) return erasedAsk(request, name, held.access, at);
    const want = request.want as unknown as StoredWant;
    const chat = request.by === "chat";
    const from = chat ? { version: held.requested?.version ?? 0, lines: held.requested?.lines ?? null } : { version: held.access?.version ?? 0, lines: held.access?.lines ?? null };
    const before = from.lines === null ? null : parsedOr(from.lines);
    const { by } = request;
    const lasts = chat ? null : request.for_ms;
    const answer = defaultOf(by, lasts);
    const chatAccess = chat ? parsedOr((want as unknown as { access: Json }).access) : null;
    const proposed: DraftAccess = chatAccess ?? allowWant(before ?? noAccess(request.reader), want as AskWant, lasts, at.sources.accounts);
    const difference = chatAccess === null ? null : differenceOf(before ?? noAccess(request.reader), chatAccess, at.sources.accounts);
    const adds = difference === null ? [] : addsOf(difference, at.words);
    const wants = chat ? listed(adds) || "more" : wantsOf(want as AskWant, lasts, at.words);
    return {
      id: request.id, reader: request.reader, name, by,
      head: difference !== null ? chatHeadOf(name, difference, at.words) : headOf(name, wants),
      line: chat ? chatLine(adds) : askLine(wants),
      ...askLines(request, name, at), wants,
      today: seesOf(before ?? noAccess(request.reader), name, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms, chat: request.reader === ASK_READER, today: true }),
      under: chat ? null : underOf(want as AskWant, at.words, at.sources.accounts),
      reason: chat ? null : request.reason,
      screen: reachesScreen(proposed, at.sources, at.now_ms) && (before === null || !reachesScreen(before, at.sources, at.now_ms)) ? SCREEN : null,
      adds,
      keeps: difference === null || chatAccess === null || request.reader === ASK_READER ? null : keepsOf(difference, chatAccess),
      choices: choicesOf(by, lasts), editable: editable(choicesOf(by, lasts)), default: answer,
      version: from.version, proposed,
      at_ms: request.at_ms, until_ms: request.at_ms + LAPSE_MS,
      state: request.state,
      outcome: outcomeOf({ state: request.state, answered_ms: request.answered_ms, device: deviceOf(request.device), name, until_ms: held.until_ms, by: request.by }, at.now_ms),
    };
  };

  const erasedAsk = (request: AccessRequest, name: string, access: StoredAccess | undefined, at: Home): AgentAsk => {
    const { by } = request;
    const head = by === "chat" ? CHAT_ERASED : erasedHead(name);
    return {
      id: request.id, reader: request.reader, name, by, head, line: head, ...askLines(request, name, at), wants: "something since erased",
      today: seesOf(accessAt(request.reader, access), name, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms, chat: request.reader === ASK_READER, today: true }), under: null,
      reason: by === "chat" ? null : request.reason, screen: null, adds: [], keeps: null, choices: choicesOf(by, request.for_ms, true), editable: editable(choicesOf(by, request.for_ms, true)), default: defaultOf(by, request.for_ms, true),
      version: access?.version ?? 0, proposed: accessAt(request.reader, access), at_ms: request.at_ms, until_ms: request.at_ms + LAPSE_MS,
      state: request.state, outcome: outcomeOf({ state: request.state, answered_ms: request.answered_ms, device: deviceOf(request.device), name, by: request.by }, at.now_ms),
    };
  };

  const askLines = (request: AccessRequest, name: string, at: Home) => ({
    asked_line: askedLine(request.at_ms, request.at_ms + LAPSE_MS),
    under_line: underLine(request.by === "chat" ? null : request.reason, request.at_ms),
    says_title: saysTitle(name),
  });

  const readAsk = async (id: string, at: Home): Promise<AgentAsk> => {
    const held = await writer.person<HeldAsk | null>({ ask: { id, now_ms: at.now_ms } });
    if (held === null) refuse(404, "AGENT_REQUEST_GONE", REQUEST_OVER);
    return askOf(held, at);
  };

  const draftOf = (access: DraftAccess, expect: Version | null, saved: Access | null, name: string, chat: boolean, at: Home, kinds: ReadsByKind | null = null, narrowed: Narrowed | null = null): AccessDraft => ({
    access, expect, view: viewOf(access, saved, at.sources, at.now_ms, { name, zone: at.zone, chat }, kinds), narrowed,
    saved: narrowed === null || saved === null ? null : { access: saved, view: viewOf(saved, saved, at.sources, at.now_ms, { name, zone: at.zone, chat }, kinds) },
  });

  const kindsOf = (kinds: Readonly<Record<string, number>> | null): ReadsByKind | null =>
    kinds === null ? null : Object.fromEntries(Object.entries(kinds).filter(([kind]) => Object.hasOwn(TYPES, kind)));

  const list = async (): Promise<JsonObject> => {
    const at = await home();
    const readers = inputs.readers().filter((each) => each.listed);
    const week = weekOf(at.now_ms);
    const held = await writer.person<Record<string, HeldReader>>({ list: {
      connected: readers.filter((each) => each.disconnected_ms === null).map((each) => each.id),
      disconnected: readers.filter((each) => each.disconnected_ms !== null).map((each) => each.id),
      now_ms: at.now_ms, tally: tallying(week, at.now_ms, false),
    } });
    const rows: AgentRow[] = readers.filter((each) => Object.hasOwn(held, each.id)).map((each) => {
      const one = held[each.id]!;
      const gone = each.disconnected_ms;
      const reads = readsOf(one, week, at.zone);
      return {
        id: each.id, name: each.name, kind: each.kind, state: gone === null ? "connected" : "disconnected",
        summary: amountOf(reads, gone, at.zone), place: placeOf(each), reads, has_ask: gone === null && one.open !== undefined, mark: markOf(each),
      };
    });
    const rank = (row: AgentRow) => (row.kind === "chat" ? 0 : row.has_ask ? 1 : row.state === "connected" ? 2 : 3);
    const answer: AgentList = {
      readers: rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index).map(({ row }) => row),
    };
    return answer as unknown as JsonObject;
  };

  const one = async (id: string, counted: boolean): Promise<AgentRead> => {
    const entry = readerOf(id);
    const at = await home();
    const week = weekOf(at.now_ms);
    const held = await writer.person<HeldReader>({ reader: { reader: id, now_ms: at.now_ms, ...(counted ? { tally: tallying(week, at.now_ms, true) } : {}) } });
    const recent = counted ? await writer.person<HeldCalls>({ recent: { reader: id, limit: RECENT_SCAN, day: inputs.day() } }) : null;
    const access = accessAt(id, held.access);
    const gone = entry.disconnected_ms;
    const open = held.open === undefined || gone !== null ? null : await readAsk(held.open.id, at);
    const view = viewOf(access, access, at.sources, at.now_ms, { name: entry.name, zone: at.zone, chat: entry.kind === "chat" }, kindsOf(held.kinds));
    const reads = readsOf(held, week, at.zone);
    return {
      id, name: entry.name, kind: entry.kind, state: gone === null ? "connected" : "disconnected", how: entry.how, place: placeOf(entry), disconnected: gone === null ? null : disconnectedWords(gone, at.zone),
      reads, figure: figureFor(held, reads, entry, access, at), mark: markOf(entry), access, version: held.access?.version ?? 0, view, ask: open,
      disconnect: gone !== null || entry.via === null ? null
        : disconnectingOf(entry.name, entry.via === "pass" ? { via: "pass", made_ms: entry.made_ms } : { via: "sign-in", from: entry.from }, open === null ? null : open.wants, held.tally?.total ?? 0, at.zone),
      unlist: gone === null ? null : unlistingOf(entry.name),
      recent: {
        lines: recent === null ? [] : recentOf(recent, entry.name, at.words),
        all: recent === null || recent.calls.length === 0 ? null : seeAllWords(held.tally?.total ?? 0),
      },
    };
  };

  const history = async (asker: Asker, id: string, before: string | null, kind: string | null): Promise<HistoryPage> => {
    const entry = readerOf(id);
    if (kind !== null && !/^[a-z][a-z-]{0,39}$/u.test(kind)) refuse(422, "BAD_REQUEST", "kind is a kind a chip named");
    const cursor = before === null ? { call: null, change: null, carry: null } : cursorOf(before);
    const at = await home();
    const held = await writer.person<HeldHistory>({ history: { reader: id, cursor, limit: HISTORY_PAGE, day: inputs.day(), kind, now_ms: at.now_ms } });
    const here = inputs.device(asker.pass.id);
    const device = (pass: string): string | null => {
      const there = inputs.device(pass);
      return there === null ? null : there === here ? `this ${there}` : `your ${there}`;
    };
    const page = pageOf(held, cursor, HISTORY_PAGE, at.words, device, sessionDay(at.now_ms), { name: entry.name, chat: entry.kind === "chat" });
    if (before !== null) return { figure: null, chips: [], kind, empty: null, ...page };
    const week = weekOf(at.now_ms);
    const reader = await writer.person<HeldReader>({ reader: { reader: id, now_ms: at.now_ms, tally: tallying(week, at.now_ms, false) } });
    const reads = readsOf(reader, week, at.zone);
    if (reads.total === 0) return { figure: null, chips: [], kind, empty: neverReadOf(entry.name, entry.made_ms, at.now_ms, at.zone), ...page };
    return { figure: figureFor(reader, reads, entry, accessAt(id, reader.access), at), chips: chipsOf(reader), kind, empty: null, ...page };
  };

  const readCall = async (id: string, call: string): Promise<{ entry: ReaderEntry; held: HeldRead }> => {
    const entry = readerOf(id);
    const held = await writer.person<HeldRead | null>({ read: { reader: id, call, day: inputs.day() } });
    return { entry, held: held ?? refuse(404, "READ_UNKNOWN", READ_UNKNOWN) };
  };

  const readPage = async (id: string, call: string): Promise<ReadPage> => {
    const { entry, held } = await readCall(id, call);
    const at = await home();
    const [root, ...pages] = held.calls;
    const shown = historyRead(root!, { ...held, requests: [] }, entry.name, at.words, pages);
    const came = cameOfAll(held.calls);
    const kinds = cameKinds(came);
    const n = kinds.reduce((sum, each) => sum + each.n, 0);
    const lines = root!.access_version === null ? null : held.versions[String(root!.access_version)] ?? null;
    const access = lines === null ? null : parsedOr(lines);
    const counts = summed(held.calls.map((each) => held.counts[each.id] ?? {}));
    const rows = keptRows(counts);
    const unshown = unshownWords(held.calls.flatMap((each) => each.withheld), access, at.words);
    const refused = shown.tone === "refused" ? shown.line : null;
    return {
      id: root!.id, reader: id, name: entry.name, title: shown.words,
      line: readLine(root!.at_ms, held.calls.at(-1)!.at_ms, pages.length, at.now_ms, at.zone),
      figure: refused !== null ? null : sawOf(n), kinds,
      kept: refused !== null || (rows.length === 0 && unshown === null) ? null : { about: keptAbout(entry.name), rows, held: unshown },
      why: whyOf(access, entry.name, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms, chat: entry.kind === "chat", at_ms: root!.at_ms }),
      refused, show: refused !== null ? null : showOf(n),
    };
  };

  const things = async (asker: Asker, id: string, call: string, before: string | null): Promise<ThingsPage> => {
    personOnly(asker);
    const { held } = await readCall(id, call);
    const after = before === null ? null : thingsAtOf(before);
    const found = await writer.person<HeldThings | null>({ things: { reader: id, call, after, limit: THINGS_PAGE } }) ?? refuse(404, "READ_UNKNOWN", READ_UNKNOWN);
    const at = await home();
    const described = await describedOf(inputs.describe, found.items.map((each) => each.ref));
    const kinds = cameKinds(cameOfAll(held.calls));
    const shown = new Map<string, Thing[]>();
    let gone = found.erased;
    for (const item of found.items) {
      const thing = thingOf(described.get(item.ref), at.zone);
      if (thing === null) gone += 1;
      else shown.set(item.kind, [...shown.get(item.kind) ?? [], thing]);
    }
    return {
      title: thingsTitle(kinds.reduce((sum, each) => sum + each.n, 0)),
      gone: goneWords(gone),
      groups: kinds.filter((each) => shown.has(each.kind)).map(({ kind, name, icon, n }) => ({ kind, name, icon, n, things: shown.get(kind)! })),
      next: found.next === null ? null : `${found.next.call}.${found.next.at}`,
    };
  };

  const edit = async (asker: Asker, said: JsonObject, http: IncomingMessage): Promise<AccessDraft> => {
    const asked = editRequestOf(said);
    const by = asker.ask ? "chat" : "person";
    let name: string;
    let chat = false;
    let saved: Access | null;
    let entry: ReaderEntry | null = null;
    let kinds: ReadsByKind | null = null;
    let again: Sent | null = null;
    if ("reader" in asked.target) {
      entry = connectedOf(asked.target.reader);
      name = entry.name;
      chat = entry.kind === "chat";
      const now_ms = inputs.clock();
      const held = await writer.person<HeldReader>({ reader: { reader: entry.id, now_ms, tally: tallying(null, now_ms, true) } });
      saved = accessAt(entry.id, held.access);
      kinds = kindsOf(held.kinds);
      if (asked.expect !== (held.access?.version ?? 0)) {
        again = asked.edit === null ? null : await writer.person<Sent | null>({ again: { reader: entry.id, expect: asked.expect!, by, device: asker.pass.id } });
        if (again === null) changed();
        saved = again.before === null ? noAccess(entry.id) : parsedOr(again.before);
      }
    } else if ("key" in asked.target) {
      if (asked.expect !== null) refuse(422, "BAD_REQUEST", "a key's draft names no version: expect is null");
      name = guideName(asked.target.key);
      saved = null;
    } else {
      const target = asked.target.request;
      if (IS_REQUEST.test(target)) {
        const held = await writer.person<HeldAsk | null>({ ask: { id: target, now_ms: inputs.clock() } });
        if (held === null || held.request.state !== "open") refuse(404, "AGENT_REQUEST_GONE", REQUEST_OVER);
        const drawn = askOf(held, await home());
        if (asked.expect !== drawn.version) changed();
        name = drawn.name;
        chat = held.request.reader === ASK_READER;
        saved = accessAt(held.request.reader, held.access);
      } else {
        const signIn = (await inputs.signIns.waiting(http)).requests.find((each) => each.id === target) ?? refuse(404, "AGENT_REQUEST_GONE", signInOver(null));
        if (asked.expect !== null) refuse(422, "BAD_REQUEST", "a sign-in's draft names no version: expect is null");
        name = signIn.name;
        saved = null;
      }
    }
    const at = await home();
    let access = asked.access;
    if (chat && asked.edit !== null && ("hide" in asked.edit || "detail" in asked.edit)) refuse(422, "BAD_REQUEST", CHAT_HIDES);
    if (asked.edit !== null) {
      try {
        access = applyEdit(access, asked.edit, at.sources, at.now_ms);
      } catch (error) {
        if (error instanceof EditError) refuse(422, "BAD_REQUEST", error.message);
        throw error;
      }
    }
    if (entry === null || asked.edit === null || saved === null) return draftOf(access, asked.expect, saved, name, chat, at, kinds);
    const next = narrowerOf(saved, access, asked.edit, at);
    if (again !== null) {
      if (next === null || canonical(next as unknown as Json) !== canonical(again.after)) changed();
      return draftOf(access, again.version, next, name, chat, at, kinds, narrowedOf(entry, saved, next, again.version, at));
    }
    if (next === null) return draftOf(access, asked.expect, saved, name, chat, at, kinds);
    const made = await writer.person<NarrowedTo | null>({ narrow: {
      reader: entry.id, access: next, expect: asked.expect!, by, device: asker.pass.id, existing: at.sources.accounts, now_ms: at.now_ms,
    } });
    if (made === null) return draftOf(access, asked.expect, saved, name, chat, at, kinds);
    return draftOf(access, made.version, next, name, chat, at, kinds, narrowedOf(entry, saved, next, made.version, at));
  };

  const narrowerOf = (saved: Access, draft: DraftAccess, edit: Edit, at: Home): Access | null => {
    const narrows = (next: Access) => !widens(saved, next, at.sources.accounts) && widens(next, saved, at.sources.accounts) ? next : null;
    const whole = resolve(draft, at.now_ms);
    if (!widens(saved, whole, at.sources.accounts)) return narrows(whole);
    try {
      return narrows(resolve(applyEdit(saved, edit, at.sources, at.now_ms), at.now_ms));
    } catch (error) {
      if (error instanceof EditError) return null;
      throw error;
    }
  };

  const save = async (asker: Asker, id: string, said: JsonObject): Promise<AccessDraft> => {
    const entry = connectedOf(id);
    const { access, expect } = savedOf(said, sentDraft);
    chatHidesNothing(entry.id, access);
    const at = await home();
    const stored = await writer.person<StoredAccess>({ save: {
      reader: id, access, expect, widen: asker.widen, by: asker.ask ? "chat" : "person", device: asker.pass.id, existing: at.sources.accounts, now_ms: at.now_ms,
    } });
    const now = parsedOr(stored.lines);
    return draftOf(now, stored.version, now, entry.name, entry.kind === "chat", at);
  };

  const propose = async (asker: Asker, id: string, said: JsonObject): Promise<AccessChange> => {
    const entry = connectedOf(id);
    const { access, expect } = savedOf(said, modelAccessOf);
    chatHidesNothing(entry.id, access);
    const at = await home();
    const made = await writer.person<Proposed>({ propose: {
      reader: id, access, expect, by: asker.ask ? "chat" : "person", device: asker.pass.id, existing: at.sources.accounts, now_ms: at.now_ms,
    } });
    if (made.request !== null) return { id: made.request.id, kind: "asked", snapshot: await readAsk(made.request.id, at) };
    const change = made.change;
    if (change === null) return { id: `${id}@${made.version}`, kind: "unchanged", reader: id, words: unchangedWords(entry.name) };
    const before = made.before === null ? noAccess(id) : parsedOr(made.before);
    return { id: `ch-${change.seq}`, kind: "narrowed", reader: id, ...narrowedOf(entry, before, parsedOr(change.lines!), made.version, at) };
  };

  const waiting = async (asker: Asker, http: IncomingMessage): Promise<WaitingList> => {
    personOnly(asker);
    const signIns = (await inputs.signIns.waiting(http)).requests;
    const at = await home();
    const held = await writer.person<HeldAsk[]>({ waiting: { readers: connectedIds(), now_ms: at.now_ms } });
    const access = defaultAccess();
    return {
      requests: signIns.filter((each) => each.until_ms > at.now_ms).map((card) => {
        const app = appOfHost(card.host);
        const each = app === null ? card : { ...card, name: guideName(app) };
        return {
          ...each, head: signInHead(each.name), over_line: signingInLine(each.host, each.at_ms, app === null || each.host === null ? null : signInFrom(app, each.host)),
          sentence: sentenceOf(access, each.name, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms }), access,
          view: viewOf(access, null, at.sources, at.now_ms, { name: each.name, zone: at.zone, chat: false }),
          pick: pickWords(each.name), pick_line: pickLine(each.name), over: signInOver(each.host ?? each.name), app, notice: signInNotice(each.name),
        };
      }),
      asks: held.map((each) => askOf(each, at)),
    };
  };

  const guides = async (asker: Asker): Promise<GuidesHeld> => {
    personOnly(asker);
    const at = await home();
    const access = defaultAccess();
    return {
      readers: inputs.readers(),
      sees: (name) => ({ access, view: viewOf(access, null, at.sources, at.now_ms, { name, zone: at.zone, chat: false }) }),
    };
  };

  const answer = async (asker: Asker, said: JsonObject, http: IncomingMessage): Promise<AnswerReply> => {
    personOnly(asker);
    const asked = answerOf(said);
    if (asked.sign_in) {
      const signedIn = await inputs.signIns.answer({ id: asked.id, answer: asked.answer, ...(asked.access === null ? {} : { access: asked.access as Access }), device: asker.pass.id }, http);
      return {
        state: signedIn.state, version: null,
        outcome: outcomeOf({ state: signedIn.state, answered_ms: signedIn.at_ms, device: deviceOf(signedIn.device), name: signedIn.name }, inputs.clock()),
        ...await grantedIn(signedIn.granted),
      };
    }
    const at = await home();
    const held = await writer.person<HeldAsk | null>({ ask: { id: asked.id, now_ms: at.now_ms } });
    if (held !== null && !connectedIds().includes(held.request.reader)) refuse(404, "AGENT_UNKNOWN", AGENT_GONE);
    if (held !== null && asked.access !== null) chatHidesNothing(held.request.reader, asked.access);
    const done = await writer.person<Answered>({ answer: {
      id: asked.id, answer: asked.answer, expect: asked.expect, access: asked.access, by: "person", device: asker.pass.id, existing: at.sources.accounts, now_ms: at.now_ms,
    } });
    const { request } = done;
    return {
      state: request.state, version: done.version,
      outcome: outcomeOf({ state: request.state, answered_ms: request.answered_ms, device: deviceOf(request.device), name: nameOf(request.reader), until_ms: done.until_ms, by: request.by }, at.now_ms),
      reader: null, connected: null,
    };
  };

  const grantedIn = async (granted: SignInGranted | null): Promise<Pick<SignInRead, "reader" | "connected">> => {
    if (granted === null) return { reader: null, connected: null };
    const at = await home();
    return { reader: granted.reader, connected: { reader: granted.reader, line: connectedLine(granted.access, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms }) } };
  };

  const address = async (asker: Asker, asked: AddressAsked | null, http: IncomingMessage): Promise<Address> => {
    personOnly(asker);
    if (asked !== null && asked.reader !== null) {
      if (!keyWholeOn("another", passDevice(asker.pass))) refuse(403, "PERSON_ONLY", keyOnMac(guideName("another")));
      if (connectedOf(asked.reader).via !== "pass") refuse(422, "BAD_REQUEST", ANYWHERE_KEY_ONLY);
    }
    return addressOf(await inputs.address(asked, http), asker.pass.kind === "phone");
  };

  const key = async (asker: Asker, said: JsonObject, http: IncomingMessage): Promise<MadeKey> => {
    personOnly(asker);
    const asked = keyOf(said, inputs.clock());
    if (!keyWholeOn(asked.app, passDevice(asker.pass))) refuse(403, "PERSON_ONLY", keyOnMac(guideName(asked.app)));
    const made = await inputs.key({ ...asked, device: asker.pass.id }, http);
    const at = await home();
    return {
      reader: made.reader, name: made.name, rows: keyRows(asked.app, made),
      connected: { reader: made.reader, line: connectedLine(asked.access, at.words, { accounts: at.sources.accounts, now_ms: at.now_ms }) },
    };
  };

  const signIn = async (asker: Asker, id: string, http: IncomingMessage): Promise<SignInRead> => {
    personOnly(asker);
    const held = await inputs.signIns.read(id, http).catch((error: unknown) => {
      if (error instanceof Refusal && error.code === "AGENT_REQUEST_GONE") return null;
      throw error;
    });
    if (held === null) return { id, state: "gone", outcome: null, reader: null, connected: null };
    const { answered, granted } = held;
    if (answered === null) return { id, state: "waiting", outcome: null, reader: null, connected: null };
    return {
      id, state: answered.state, outcome: outcomeOf({ state: answered.state, answered_ms: answered.at_ms, device: deviceOf(answered.device), name: answered.name }, inputs.clock()),
      ...await grantedIn(granted),
    };
  };

  const ownWants = (request: AccessRequest, words: Words) => request.want === null ? "something since erased" : wantsOf(request.want as unknown as AskWant, request.for_ms, words);
  const openOf = (request: AccessRequest, words: Words): OwnAccess["request"] => ({ id: request.id, wants: ownWants(request, words), at_ms: request.at_ms, until_ms: request.at_ms + LAPSE_MS });

  const own = async (reader: string, held: StoredAccess | undefined): Promise<OwnAccess> => {
    const { sources, zone, now_ms } = await home();
    const words = agentWords(sources, zone);
    const access = accessAt(reader, held);
    const lines = agentLines(access, words, now_ms);
    const reached = new Set(reachesOf(access, sources.accounts, now_ms));
    const outside = [...new Set(sources.accounts.filter((each) => !reached.has(each.account)).map((each) => words.account(each.account)))];
    const { own: newest, own_until } = await writer.person<HeldReader>({ reader: { reader, now_ms } });
    return {
      version: held?.version ?? 0, access, lines,
      text: agentText(lines, outside, access.allow.length === 0 && access.window === null, newest === undefined ? null : requestWords(newest.state, ownWants(newest, words))),
      request: newest?.state === "open" ? openOf(newest, words) : null,
      answer: newest === undefined || newest.state === "open" ? null
        : { id: newest.id, wants: ownWants(newest, words), state: newest.state, outcome: ownOutcome(outcomeOf({ state: newest.state, answered_ms: newest.answered_ms, device: null, name: nameOf(reader), until_ms: own_until }, now_ms), now_ms, zone) },
      outside,
    };
  };

  const request = async (reader: string, said: JsonObject, putBack: (value: string) => Promise<string>): Promise<{ answer: OwnRequest; read: Json }> => {
    const at = await home();
    const asked = askedOf(said, inputs.day());
    const want = { ...asked.want, read: await namedIn(asked.want.read, at.sources.accounts, putBack) };
    const made = await writer.person<Asked>({ request: { reader, want, reason: asked.reason, for_ms: asked.for_ms, existing: at.sources.accounts, now_ms: at.now_ms } });
    const read = (state: OwnRequest["state"]): Json => ({ want: want as unknown as Json, for_ms: asked.for_ms, state, changed: state === "asked" } satisfies AccessCallRead);
    const words = agentWords(at.sources, at.zone);
    if ("already" in made) return { answer: { state: "already", words: ALREADY, request: null }, read: read("already") };
    if ("held" in made) return { answer: { state: "held", words: heldWords(made.held.declined_ms, made.held.until_ms, at.zone), request: null }, read: read("held") };
    return { answer: { state: "asked", words: ASKED, request: openOf(made.request, words) }, read: read("asked") };
  };

  const drop = async (reader: string, said: JsonObject): Promise<{ answer: OwnDrop; read: Json }> => {
    exactly(said, ["drop"], ["version"], "a drop");
    const asked = said.drop;
    const line = asked === "everything" || asked === "request" || (Number.isSafeInteger(asked) && (asked as number) >= 1) ? asked as Drop
      : refuse(422, "BAD_REQUEST", "drop names a line by its number, everything, or request");
    const version = said.version === undefined ? null : versionOf(said.version, "version");
    if (typeof line === "number" && version === null) refuse(422, "BAD_REQUEST", DROP_VERSION);
    const at = await home();
    const dropped = await writer.person<Dropped>({ drop: { reader, drop: line, version, existing: at.sources.accounts, now_ms: at.now_ms } });
    return { answer: { words: droppedWords(line), now: await own(reader, dropped.access) }, read: { changed: dropped.changed } satisfies AccessCallRead };
  };

  const disconnect = async (asker: Asker, id: string, http: IncomingMessage): Promise<AgentRead> => {
    personOnly(asker);
    const entry = readerOf(id);
    if (entry.kind === "chat") refuse(422, "BAD_REQUEST", CHAT_NOT_DISCONNECTED);
    if (entry.disconnected_ms === null) await inputs.disconnect(id, asker.pass.id, http);
    return one(id, true);
  };

  const unlist = async (asker: Asker, id: string): Promise<JsonObject> => {
    personOnly(asker);
    const entry = readerOf(id);
    if (entry.kind === "chat") refuse(422, "BAD_REQUEST", CHAT_LISTED);
    if (entry.disconnected_ms === null) refuse(409, "AGENT_CONNECTED", stillConnected(entry.name));
    await writer.person<boolean>({ unlist: { reader: id, now_ms: inputs.clock() } });
    return list();
  };

  return {
    own,
    request,
    drop,
    waiting,
    guides,
    routes: (method, pathname) => (method === "GET" && (pathname === AGENTS_ROUTE || ASK_ROUTE.test(pathname) || SIGN_IN_ROUTE.test(pathname) || READ_PAGE_ROUTE.test(pathname)))
      || (method === "GET" && pathname === ADDRESS_ROUTE)
      || (method === "POST" && (pathname === `${AGENTS_ROUTE}/edit` || pathname === ANSWER_ROUTE || pathname === ADDRESS_ROUTE || pathname === KEYS_ROUTE))
      || (READER_ROUTE.test(pathname) && method === (READER_ROUTE.exec(pathname)![2] === undefined || READER_ROUTE.exec(pathname)![2] === "/history" ? "GET" : "POST")),

    async serve(asker, request, url, body) {
      const { pathname } = url;
      if (request.method === "GET") {
        if (pathname === AGENTS_ROUTE) return [200, await list()];
        if (pathname === ADDRESS_ROUTE) return [200, await address(asker, null, request) as unknown as JsonObject];
        const ask = ASK_ROUTE.exec(pathname);
        if (ask !== null) return [200, await readAsk(ask[1]!, await home()) as unknown as JsonObject];
        const signedIn = SIGN_IN_ROUTE.exec(pathname);
        if (signedIn !== null) return [200, await signIn(asker, signedIn[1]!, request) as unknown as JsonObject];
        const read = READ_PAGE_ROUTE.exec(pathname);
        if (read !== null) {
          const [, id, call, part] = read;
          if (part === "/things") return [200, await things(asker, id!, call!, url.searchParams.get("before")) as unknown as JsonObject];
          return [200, await readPage(id!, call!) as unknown as JsonObject];
        }
        const [, id, part] = READER_ROUTE.exec(pathname)!;
        if (part === "/history") return [200, await history(asker, id!, url.searchParams.get("before"), url.searchParams.get("kind")) as unknown as JsonObject];
        return [200, await one(id!, !asker.ask) as unknown as JsonObject];
      }
      const said = await body(request);
      if (pathname === `${AGENTS_ROUTE}/edit`) return [200, await edit(asker, said, request) as unknown as JsonObject];
      if (pathname === ANSWER_ROUTE) return [200, await answer(asker, said, request) as unknown as JsonObject];
      if (pathname === ADDRESS_ROUTE) return [200, await address(asker, addressAsked(said), request) as unknown as JsonObject];
      if (pathname === KEYS_ROUTE) return [200, await key(asker, said, request) as unknown as JsonObject];
      const [, id, part] = READER_ROUTE.exec(pathname)!;
      if (part === "/access") return [200, await save(asker, id!, said) as unknown as JsonObject];
      if (part === "/disconnect") return [200, await disconnect(asker, id!, request) as unknown as JsonObject];
      if (part === "/unlist") return [200, await unlist(asker, id!)];
      return [200, await propose(asker, id!, said) as unknown as JsonObject];
    },
  };
}

function personOnly(asker: Asker): void {
  if (!asker.widen) refuse(403, "PERSON_ONLY", PERSON_ONLY_WORDS);
}

function addressAsked(said: JsonObject): AddressAsked {
  exactly(said, ["on"], ["reader"], "an address");
  if (said.on !== true) refuse(422, "BAD_REQUEST", "an address is turned on: on is true");
  if (said.reader === undefined) return { reader: null };
  if (typeof said.reader !== "string" || !AGENT_ID.test(said.reader)) refuse(422, "BAD_REQUEST", "a reader is named by its id");
  return { reader: said.reader };
}

const NAME_MOST = 200;

function keyOf(said: JsonObject, now_ms: number): Omit<KeyAsked, "device"> {
  exactly(said, ["app", "access"], ["name"], "a key");
  const app = (KEY_APPS as readonly unknown[]).includes(said.app) ? said.app as KeyApp : refuse(422, "BAD_REQUEST", `a key is made for one of ${KEY_APPS.join(", ")}`);
  const name = typeof said.name === "string" ? said.name.trim() : null;
  if (app === "another" && (name === null || name === "" || name.length > NAME_MOST)) refuse(422, "BAD_REQUEST", `another agent's key names the app, 1 to ${NAME_MOST} characters`);
  if (app !== "another" && said.name !== undefined) refuse(422, "BAD_REQUEST", `${guideName(app)}’s key takes its name from Lifestream: it names no app`);
  return { app, name, access: resolve(sentDraft(said.access), now_ms) };
}

function keyRows(app: KeyApp, made: MintedKey): KeyRow[] {
  const internet = made.origin === null ? null : `${made.origin}/mcp`;
  const row = (label: string, text: string): KeyRow => ({ label, text });
  if (app === "grok-bot") {
    return [row(KEY_ROWS.name, "Lifestream"), row(KEY_ROWS.url, internet!), row(KEY_ROWS.header, "Authorization"), row(KEY_ROWS.value, `Bearer ${made.pass}`)];
  }
  if (app === "instinct") return [row(KEY_ROWS.address, internet!), row(KEY_ROWS.key, made.pass)];
  return [
    row(KEY_ROWS.address, MCP_URL), row(KEY_ROWS.key, made.pass), row(KEY_ROWS.code, claudeCodeLine(MCP_URL)),
    ...(internet === null ? [] : [row(KEY_ROWS.internet, internet)]),
  ];
}

type AnswerAsked =
  | { sign_in: true; id: string; answer: string; access: Access | null; expect: null }
  | { sign_in: false; id: string; answer: "once" | "always"; access: DraftAccess | null; expect: Version }
  | { sign_in: false; id: string; answer: "no"; access: null; expect: null };

function answerOf(said: JsonObject): AnswerAsked {
  exactly(said, ["id", "answer"], ["access", "expect"], "an answer");
  const { id, answer } = said;
  if (typeof id !== "string" || id === "") refuse(422, "BAD_REQUEST", "an answer names the id of a sign-in or a request");
  const access = said.access ?? null;
  const expect = said.expect ?? null;
  if (answer === "deny" || answer === "no") {
    if (access !== null) refuse(422, "BAD_REQUEST", `an answer of ${answer} carries no access`);
    if (expect !== null) refuse(422, "BAD_REQUEST", `an answer of ${answer} names no version`);
    return answer === "deny" ? { sign_in: true, id, answer, access: null, expect: null } : { sign_in: false, id, answer, access: null, expect: null };
  }
  if (typeof answer === "string" && SIGN_IN_CODE.test(answer)) {
    if (expect !== null) refuse(422, "BAD_REQUEST", "a sign-in's answer names no version");
    return { sign_in: true, id, answer, access: access === null ? null : accessOf(access), expect: null };
  }
  if (answer === "once" || answer === "always") {
    return { sign_in: false, id, answer, access: access === null ? null : sentDraft(access), expect: versionOf(expect, "expect") };
  }
  return refuse(422, "BAD_REQUEST", "an answer is a sign-in's 6-digit code or deny, or a request's once, always or no");
}

const MIN_FOR_MS = 5 * 60_000;
const MAX_FOR_MS = 7 * 24 * 3_600_000;
const ONE_HOUR_MS = 3_600_000;

interface AgentAsked { want: AskWant; for_ms: number | null; reason: string }

function askedOf(said: JsonObject, day: DaySettings): AgentAsked {
  exactly(said, ["request", "reason"], ["for"], "a request");
  const request = said.request;
  if (typeof request !== "object" || request === null || Array.isArray(request)) refuse(422, "BAD_REQUEST", "request is a want: {read, since?, past?}");
  exactly(request, ["read"], ["since", "past"], "a want");
  if (request.since !== undefined && request.past !== undefined) refuse(422, "BAD_REQUEST", "a want names since or past, never both");
  const reason = said.reason;
  if (typeof reason !== "string" || reason.trim() === "") refuse(422, "BAD_REQUEST", "reason is why you ask, in your own words");
  const fault = reasonFault(reason);
  if (fault !== null) refuse(422, "BAD_REQUEST", fault);
  return { want: { read: readOf(request.read), window: windowOf(request.since, request.past, day) }, for_ms: forOf(said.for), reason };
}

function readOf(value: unknown): ReadWant {
  if (value === "everything") return "everything";
  const keys = typeof value === "object" && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
  const named = keys.length === 1 ? (value as Record<string, unknown>)[keys[0]!] : undefined;
  if (typeof named !== "string" || named === "" || !["category", "product", "account"].includes(keys[0]!)) {
    refuse(422, "BAD_REQUEST", "read is \"everything\", {category}, {product} or {account}");
  }
  if (keys[0] === "category") {
    if (!Object.hasOwn(TYPES, named)) refuse(422, "BAD_REQUEST", `${named} is no category: name one of ${Object.keys(TYPES).join(", ")}`);
    return { category: named as Type };
  }
  return keys[0] === "product" ? { product: named } : { account: named };
}

const SINCE_DAY = "since is a day, as 2026-11-01";

function windowOf(since: unknown, past: unknown, day: DaySettings): AskWant["window"] {
  if (since !== undefined) {
    if (typeof since !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(since)) refuse(422, "BAD_REQUEST", SINCE_DAY);
    try {
      return { since_ms: dayBounds(since, day).start_ms };
    } catch (error) {
      if (error instanceof TimeError) refuse(422, "BAD_REQUEST", `${since} is no day: ${SINCE_DAY}`);
      throw error;
    }
  }
  if (past !== undefined) return { past_ms: spanOf(past, "past") };
  return null;
}

function forOf(value: unknown): number | null {
  if (value === undefined) return ONE_HOUR_MS;
  if (value === "always") return null;
  const ms = spanOf(value, "for");
  if (ms < MIN_FOR_MS || ms > MAX_FOR_MS) refuse(422, "BAD_REQUEST", "for is from 5m to 7d, or always");
  return ms;
}

function spanOf(value: unknown, member: string): number {
  try {
    if (typeof value === "string") return duration(value);
  } catch {}
  return refuse(422, "BAD_REQUEST", `${member} is a whole number and one unit, m, h or d: 30m, 1h, 7d`);
}

async function namedIn(read: ReadWant, accounts: readonly EditorAccount[], putBack: (value: string) => Promise<string>): Promise<ReadWant> {
  if (read === "everything" || "category" in read) return read;
  if ("product" in read) {
    const product = await putBack(read.product);
    if (!accounts.some((each) => each.account.startsWith(`${product}:`))) refuse(422, "BAD_REQUEST", `No ${product} account is connected on this home.`);
    return { product };
  }
  const named = await putBack(read.account);
  const account = accounts.find((each) => each.account === named || each.account === accountOf(named))?.account;
  return account === undefined ? refuse(422, "BAD_REQUEST", `${read.account} is no account on this home: name one as an answer gave it.`) : { account };
}

function chatHidesNothing(reader: string, access: DraftAccess): void {
  if (reader === ASK_READER && access.hide !== "none") refuse(422, "BAD_REQUEST", CHAT_HIDES);
}


export const FOLD_AT = 8;
export const FOLD_SHOWN = 5;

export function historyRead(call: ReaderCall, held: HeldCalls, name: string, words: Words, pages: readonly ReaderCall[] = []): HistoryRead {
  const lines = held.versions[String(call.access_version)];
  const all = [call, ...pages];
  const shown = callLine({
    tool: call.tool, sent: call.sent, read: call.read, result: call.result, code: call.code, words: call.words,
    came: all.every((each) => each.came === null) ? null : cameOfAll(all), counts: summed(all.map((each) => held.counts[each.id] ?? {})), withheld: all.flatMap((each): Withheld[] => each.withheld),
  }, lines === undefined || lines === null ? null : parsedOr(lines), name, words);
  const told = held.requests.find((each) => each.told_ms === call.at_ms);
  return { kind: "call", id: call.id, at_ms: call.at_ms, ...shown, more: pages.length, took_ms: call.ms, told: told === undefined ? null : toldWords(told.state) };
}

export function cameOfAll(calls: readonly ReaderCall[]): Came {
  const came: Came = {};
  for (const call of calls) for (const [kind, n] of Object.entries(call.came ?? {})) came[kind] = (came[kind] ?? 0) + n;
  return came;
}

function rootsOf(calls: readonly ReaderCall[]): { roots: ReaderCall[]; pages: Map<number, ReaderCall[]> } {
  const joins = joinsOf(calls);
  const pages = new Map<number, ReaderCall[]>();
  for (const call of [...calls].sort((a, b) => a.seq - b.seq)) {
    const root = joins.get(call.seq);
    if (root !== undefined) pages.set(root, [...pages.get(root) ?? [], call]);
  }
  return { roots: calls.filter((call) => !joins.has(call.seq)), pages };
}

function recentOf(held: HeldCalls, name: string, words: Words): HistoryRead[] {
  const { roots, pages } = rootsOf(held.calls);
  return roots.slice(0, RECENT_READS).map((call) => historyRead(call, held, name, words, pages.get(call.seq) ?? []));
}


async function describedOf(describe: (refs: readonly string[]) => Promise<DescribeAnswer>, refs: readonly string[]): Promise<Map<string, Citation>> {
  const described = new Map<string, Citation>();
  for (let left = [...new Set(refs)]; left.length > 0;) {
    let chars = 0;
    const taken = left.slice(0, REFS_MOST).filter((ref) => (chars += ref.length) <= REFS_CHARS);
    const batch = taken.length === 0 ? left.slice(0, 1) : taken;
    const answer = await describe(batch);
    answer.described.forEach((citation, at) => described.set(batch[at]!, citation));
    left = [...batch.slice(Math.max(1, answer.described.length)), ...left.slice(batch.length)];
  }
  return described;
}

function thingOf(citation: Citation | undefined, zone: string): Thing | null {
  if (citation === undefined || citation.kind === "gone") return null;
  const { opens } = citation;
  if (citation.kind === "person" || citation.kind === "place" || citation.kind === "chat") return { ref: citation.ref, title: citation.name, line: null, when: null, day: null, at_ms: null, opens };
  if (citation.kind === "row") return { ref: citation.ref, title: citation.asked, line: null, when: null, day: null, at_ms: null, opens };
  const at_ms = citation.at === undefined ? null : Date.parse(citation.at);
  const known = at_ms === null || Number.isNaN(at_ms) ? null : at_ms;
  const day = citation.day ?? (known === null ? null : civilDay(known, calendarOf(zone)));
  if (citation.kind === "window") return { ref: citation.ref, title: citation.title, line: citation.app, when: known === null ? null : thingWhen(known, zone), day, at_ms: known, opens };
  return {
    ref: citation.ref, title: citation.title ?? NOUN_TITLES[citation.kind], line: citation.chat_title ?? null,
    when: known === null ? null : thingWhen(known, zone), day, at_ms: known, opens,
  };
}

const NOUN_TITLES: Readonly<Record<"record" | "message" | "turn" | "line" | "photo", string>> = { record: "A thing", message: "A message", turn: "An AI chat", line: "A line of your day", photo: "A photo" };

function thingsAtOf(text: string): ThingsAt {
  const found = /^(\d{1,15})\.(\d{1,4})$/u.exec(text);
  return found === null ? refuse(422, "BAD_REQUEST", "before is a cursor a things page answered") : { call: Number(found[1]), at: Number(found[2]) };
}

type PageOf = Omit<HistoryPage, "figure" | "chips" | "kind" | "empty">;

export function pageOf(held: HeldHistory, cursor: Cursor, limit: number, words: Words, device: (pass: string) => string | null, dayOf: (ms: number) => Omit<SessionDay, "reads">, reader: { name: string; chat: boolean }): PageOf {
  const dayAt = (ms: number): SessionDay => {
    const on = dayOf(ms);
    const n = held.days[on.day] ?? 0;
    return { ...on, reads: n === 0 ? null : readCount(n) };
  };
  const { page, more } = entriesOf(held.calls, held.changes, limit);
  const beyond = beyondOf(page, held.calls);
  const requests = new Map(held.requests.map((each) => [each.id, each] as const));
  const wantsWords = (request: AccessRequest | undefined): string | null => {
    if (request === undefined || request.want === null) return null;
    return request.by === "chat" ? "more" : wantsOf(request.want as unknown as AskWant, request.for_ms, words);
  };
  const act = (change: ChangeRow) => `${change.by} ${change.at_ms}`;
  const replacing = (change: ChangeRow) => change.what === "replaced" && (change.about as { changed?: unknown } | null)?.changed !== true;
  const asked = new Set(held.changes.filter((change) => change.what === "requested").map(act));
  const again = new Set(held.changes.filter(replacing).map(act));
  const { pages } = rootsOf(page.flatMap((entry) => ("call" in entry ? [entry.call] : [])));
  const joined = new Set([...pages.values()].flat().map((call) => call.seq));
  type Group = Omit<HistorySession, "lines" | "reads" | "day"> & { lines: (HistoryRead | HistoryChange)[]; folding: Folding | null | undefined };
  const sessions: Group[] = [];
  const seen = new Map<string, number>();
  const folds = new Map<HistoryRead, Fold>();
  const repeats = new Map<HistoryRead, Repeated & { key: string }>();
  let group: Group | null = null;
  let newer: number | null = cursor.carry?.session ?? null;
  const openSession = (session: number, at_ms: number): Group => {
    const carried = cursor.carry !== null && cursor.carry.session === session && sessions.every((each) => !each.key.startsWith("s-")) ? cursor.carry : null;
    const opened: Group = { key: `s-${session}`, from_ms: at_ms, to_ms: carried?.to_ms ?? at_ms, calls: carried?.calls ?? 0, lines: [], folding: carried === null ? undefined : carried.folding };
    sessions.push(opened);
    seen.set(opened.key, opened.calls);
    return opened;
  };
  page.forEach((entry, index) => {
    if ("call" in entry) {
      const { call } = entry;
      if (group?.key !== `s-${call.session}`) group = openSession(call.session, call.at_ms);
      group.from_ms = call.at_ms;
      newer = call.session;
      if (joined.has(call.seq)) return;
      if (isRead(call)) {
        group.calls += 1;
        seen.set(group.key, seen.get(group.key)! + 1);
      }
      if (!changedBy(call)) {
        const joinedPages = pages.get(call.seq) ?? [];
        const line = historyRead(call, held, reader.name, words, joinedPages);
        folds.set(line, foldOf(call, words));
        if (line.tone === "plain" && line.opens) repeats.set(line, { at_ms: call.at_ms, tool: call.tool, sent: call.sent, read: call.read, came: cameOfAll([call, ...joinedPages]), key: questionKey(call) });
        group.lines.push(line);
      }
      return;
    }
    const { change } = entry;
    if (replacing(change) && asked.has(act(change))) return;
    const next = page.slice(index + 1).find((each): each is { at_ms: number; call: ReaderCall } => "call" in each)?.call;
    const older = next?.session ?? beyond?.session ?? null;
    const maker = change.by === "agent" && next !== undefined && changedBy(next) ? next.session : null;
    if (maker !== null) {
      if (group?.key !== `s-${maker}`) group = openSession(maker, change.at_ms);
    } else if (newer !== null && newer === older) {
      if (group?.key !== `s-${newer}`) group = openSession(newer, change.at_ms);
    } else {
      group = { key: `c-${change.seq}`, from_ms: change.at_ms, to_ms: change.at_ms, calls: 0, lines: [], folding: null };
      sessions.push(group);
    }
    const about = change.about as { lines?: number[]; changed?: boolean } | string | null;
    const request = change.request === null ? undefined : requests.get(change.request);
    const waiting = change.what === "requested" && request?.state === "open";
    const shown = changeWords({
      name: reader.name, what: change.what, by: change.by, device: change.device === null ? null : device(change.device), access: change.lines === null ? null : parsedOr(change.lines),
      before: beforeOf(held, change),
      wants: change.request === null ? null : wantsWords(request),
      about: typeof about === "string" ? { account: about } : about !== null && Array.isArray(about.lines) ? { lines: about.lines } : about?.changed === true ? { changed: true } : null,
      ...(change.what === "requested" ? { reason: request?.by === "agent" && request.reason !== "" ? request.reason : null, open: waiting } : {}),
      ...(change.what === "requested" && again.has(act(change)) ? { again: true as const } : {}),
    }, words, { chat: reader.chat });
    group.lines.push({
      kind: "change", at_ms: change.at_ms, icon: waiting || change.what === "requested" ? "needs-you" : change.what === "removed" ? "link" : "private",
      ...shown, ask: waiting ? request!.id : null, tone: waiting ? "waiting" : "plain",
    });
  });
  const last = sessions.at(-1);
  if (beyond !== null && last?.key === `s-${beyond.session}`) last.calls += held.older;
  const continuing = more && beyond !== null ? `s-${beyond.session}` : null;
  const ends = new Map<string, Folding | null>();
  const drawn = sessions.filter((each) => each.lines.length > 0).map((each): HistorySession => {
    const folding = each.folding !== undefined ? each.folding
      : each.key.startsWith("s-") && Math.max(each.calls, each.lines.filter((line) => line.kind === "call").length) > FOLD_AT ? { shown: 0, run: null } : null;
    const { lines, end } = folded(each.lines, folding, each.key === continuing, folds);
    ends.set(each.key, end);
    return { key: each.key, from_ms: each.from_ms, to_ms: each.to_ms, calls: each.calls, day: dayAt(each.to_ms), reads: each.calls === 0 ? null : readCount(each.calls), lines };
  });
  const shownSessions = repeated(drawn, repeats, words);
  const tail = page.filter((each): each is { at_ms: number; call: ReaderCall } => "call" in each).at(-1)?.call;
  if (!more && held.scanned === null) return { sessions: shownSessions, next: null };
  const changes = page.filter((each): each is { at_ms: number; change: ChangeRow } => "change" in each);
  const tailKey = tail === undefined ? null : `s-${tail.session}`;
  const next: Cursor = {
    call: more ? tail?.seq ?? cursor.call : held.scanned, change: changes.at(-1)?.change.seq ?? cursor.change,
    carry: tail === undefined ? cursor.carry
      : { session: tail.session, calls: seen.get(tailKey!)!, to_ms: sessions.find((each) => each.key === tailKey)!.to_ms, folding: ends.get(tailKey!) ?? null },
  };
  return { sessions: shownSessions, next: { before: cursorText(next), words: SHOW_EARLIER } };
}

export const REPEAT_AT = 3;

function repeated(sessions: readonly HistorySession[], repeats: ReadonlyMap<HistoryRead, Repeated & { key: string }>, words: Words): HistorySession[] {
  const keyOf = (session: HistorySession): string | null => {
    const reads = session.lines.map((line) => (line.kind === "call" ? repeats.get(line) : undefined));
    const first = reads[0];
    return first !== undefined && reads.every((each) => each?.key === first.key) ? first.key : null;
  };
  const out: HistorySession[] = [];
  let run: HistorySession[] = [];
  const close = () => {
    const lines = run.flatMap((each) => each.lines) as HistoryRead[];
    if (run.length > 0 && lines.length >= REPEAT_AT) {
      const shown = repeatWords(lines.map((line) => repeats.get(line)!), words);
      const calls = run.reduce((sum, each) => sum + each.calls, 0);
      out.push({
        key: run[0]!.key, from_ms: run.at(-1)!.from_ms, to_ms: run[0]!.to_ms, calls, day: run[0]!.day, reads: calls === 0 ? null : readCount(calls),
        lines: [{ kind: "fold", at_ms: lines[0]!.at_ms, n: lines.length, ...shown, lines, continues: false }],
      });
    } else out.push(...run);
    run = [];
  };
  for (const session of sessions) {
    const key = keyOf(session);
    const runKey = run.length === 0 ? null : keyOf(run[0]!);
    if (key === null || (runKey !== null && (key !== runKey || session.day.day !== run[0]!.day.day))) close();
    if (key === null) out.push(session);
    else run.push(session);
  }
  close();
  return out;
}

function folded(lines: readonly (HistoryRead | HistoryChange)[], folding: Folding | null, open: boolean, folds: ReadonlyMap<HistoryRead, Fold>): { lines: HistoryLine[]; end: Folding | null } {
  if (folding === null) return { lines: [...lines], end: null };
  const out: HistoryLine[] = [];
  let { shown } = folding;
  let carried = folding.run;
  let run: HistoryRead[] = [];
  let tally: FoldTally = carried === null ? {} : tallyOf(carried.tally);
  const close = (last: boolean) => {
    const n = (carried?.n ?? 0) + run.length;
    if (run.length === 1 && carried === null && !(last && open)) out.push(run[0]!);
    else if (run.length > 0) out.push({ kind: "fold", at_ms: run[0]!.at_ms, n, icon: "more", ...foldWords(n, tally), lines: run, continues: carried !== null });
    const end = last && open && run.length > 0 ? { n, tally: carriedOf(tally) } : null;
    carried = null;
    run = [];
    tally = {};
    return end;
  };
  for (const line of lines) {
    if (line.kind === "change") {
      close(false);
      out.push(line);
    } else if (shown < FOLD_SHOWN) {
      shown += 1;
      out.push(line);
    } else {
      run.push(line);
      tally = foldTally(tally, folds.get(line)!);
    }
  }
  return { lines: out, end: { shown, run: close(true) } };
}

function beforeOf(held: HeldHistory, change: ChangeRow): Access | null {
  const lines = held.befores[String(change.seq)];
  return lines === undefined || lines === null ? null : parsedOr(lines);
}

function cursorText(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function cursorOf(text: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(text, "base64url").toString("utf8")) as Cursor;
    const seq = (each: unknown) => each === null || (Number.isSafeInteger(each) && (each as number) >= 0);
    const carry = value.carry;
    if (typeof value === "object" && value !== null && seq(value.call) && seq(value.change)
      && (carry === null || (typeof carry === "object" && Number.isSafeInteger(carry.session) && Number.isSafeInteger(carry.calls) && Number.isSafeInteger(carry.to_ms) && foldingOf(carry.folding)))
      && Object.keys(value).sort().join() === "call,carry,change") return value;
  } catch {}
  return refuse(422, "BAD_REQUEST", "before is a cursor a history page answered");
}

function foldingOf(value: unknown): boolean {
  if (value === null) return true;
  if (typeof value !== "object") return false;
  const { shown, run } = value as Folding;
  const counted = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  return counted(shown) && (run === null || (typeof run === "object" && counted(run.n) && isCarried(run.tally)));
}

function accessOf(value: unknown): Access {
  return parsedBy(parseAccess, value, () => ACCESS_UNSAVED);
}

function modelAccessOf(value: unknown, where: string): Access {
  return parsedBy(parseAccess, value, (error) => `${where}: ${error.message}`);
}

function sentDraft(value: unknown): DraftAccess {
  return parsedBy(parseDraft, value, () => ACCESS_UNSAVED);
}

function parsedBy<T>(parse: (value: unknown) => T, value: unknown, words: (error: AccessError) => string): T {
  try {
    return parse(value);
  } catch (error) {
    if (error instanceof AccessError) refuse(422, "BAD_REQUEST", words(error));
    throw error;
  }
}

function exactly(said: JsonObject, keys: readonly string[], optional: readonly string[], what: string): void {
  for (const key of Object.keys(said)) if (!keys.includes(key) && !optional.includes(key)) refuse(422, "BAD_REQUEST", `${what} has no member ${key}`);
  for (const key of keys) if (!Object.hasOwn(said, key)) refuse(422, "BAD_REQUEST", `${what} has ${key}`);
}

function versionOf(value: unknown, where: string): Version {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : refuse(422, "BAD_REQUEST", `${where} is a version, a whole number`);
}

function savedOf<T extends DraftAccess>(said: JsonObject, parse: (value: unknown, where: string) => T): { access: T; expect: Version } {
  exactly(said, ["access", "expect"], [], "a save");
  return { access: parse(said.access, "access"), expect: versionOf(said.expect, "expect") };
}

interface EditAsked {
  target: { reader: string } | { request: string } | { key: KeyApp };
  access: DraftAccess;
  expect: Version | null;
  edit: ReturnType<typeof parseEdit> | null;
}

function editRequestOf(said: JsonObject): EditAsked {
  exactly(said, ["target", "access", "expect", "edit"], [], "an edit request");
  const target = said.target as Record<string, unknown> | null;
  const keys = typeof target === "object" && target !== null && !Array.isArray(target) ? Object.keys(target).join() : "";
  const named = keys === "reader" || keys === "request" || keys === "key" ? target![keys] : null;
  if (typeof named !== "string" || named === "") refuse(422, "BAD_REQUEST", "a target is {reader}, {request} or {key}");
  if (keys === "key" && !(KEY_APPS as readonly string[]).includes(named)) refuse(422, "BAD_REQUEST", `a key's draft is for one of ${KEY_APPS.join(", ")}`);
  let edit: EditAsked["edit"] = null;
  if (said.edit !== null) {
    try {
      edit = parseEdit(said.edit);
    } catch (error) {
      if (error instanceof EditError) refuse(422, "BAD_REQUEST", error.message);
      throw error;
    }
  }
  return {
    target: keys === "reader" ? { reader: named } : keys === "key" ? { key: named as KeyApp } : { request: named }, access: sentDraft(said.access),
    expect: said.expect === null ? null : versionOf(said.expect, "expect"), edit,
  };
}

export function howOf(agent: { via: "sign-in" | "pass"; from: string | null; anywhere?: true } | null, made_ms: number, zone: string): string {
  if (agent === null) return "In Lifestream";
  const made = dayMonthWords(made_ms, zone);
  if (agent.via === "sign-in") return agent.from === null ? `Signed in ${made}` : `Signed in from ${agent.from}`;
  return agent.anywhere === true ? `Key made ${made}, reads from the internet` : `Key made ${made}`;
}

