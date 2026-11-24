import { civilDay, handleId, type DaySettings } from "@lifestreamprotocol/core";
import type { DayDocument } from "../days.js";
import { MESSAGES_FAMILY, QUIET_TITLE, type Conversation } from "./family.js";
import { partyHandle } from "./networks.js";

export const TALK_GAP_MS = 30 * 60_000;
export const TALK_DAYS = 3;
const SAID = ": ";

export interface Spoken {
  readonly chat: string;
  readonly at_ms: number;
  readonly n: number;
  readonly from: readonly string[];
  readonly mine: boolean;
  readonly name: string;
  readonly text: string;
  readonly forwarded: boolean;
}

export interface TalkDay {
  readonly day: string;
  readonly said: readonly Spoken[];
}

export interface TalkRun {
  readonly day: string;
  readonly chat: string;
  readonly runs: readonly (readonly Spoken[])[];
}

export interface Talker {
  readonly handles: readonly { readonly id: string }[];
  readonly chats: readonly { readonly key: string }[];
  readonly days?: Readonly<Record<string, number>>;
  readonly last_ms: number | null;
}

export interface TalkChat {
  readonly key: string;
  readonly group: boolean;
  readonly last_ms: number;
}

type DayFile = Pick<DayDocument, "atoms" | "facts">;

export function saidIn(file: DayFile): Spoken[] {
  const facts = new Map<number, { mine: boolean; from: string[] }>();
  for (const fact of file.facts) {
    if (fact.of !== MESSAGES_FAMILY) continue;
    const mine = fact.keys.direction === "sent";
    const from = mine ? [] : fact.who.filter((each) => each.role === "sender").map((each) => each.handle);
    for (const n of fact.lines) facts.set(n, { mine, from });
  }
  const said: Spoken[] = [];
  for (const atom of file.atoms) {
    if (atom.family !== MESSAGES_FAMILY || atom.block === undefined || atom.start_ms === null || atom.block.title === QUIET_TITLE) continue;
    const fact = facts.get(atom.n);
    said.push(spoken(atom.block.key, atom.start_ms, atom.n, atom.text, fact?.mine ?? false, fact?.from ?? []));
  }
  return said;
}

export function foldedIn(file: DayFile, chats: ReadonlySet<string>): { chat: string; line: string; n: number }[] {
  return file.atoms.flatMap((atom) => atom.family === MESSAGES_FAMILY && atom.block?.title === QUIET_TITLE && chats.has(atom.block.key) ? [{ chat: atom.block.key, line: atom.text, n: atom.n }] : []);
}

export function saidOf(chat: string, conversation: Conversation, n: number): Spoken[] {
  const network = chat.slice(0, chat.indexOf(":"));
  return conversation.messages.flatMap(({ line, fact }) => {
    if (line.start_ms === null) return [];
    const handle = partyHandle(network, fact.from);
    return [spoken(chat, line.start_ms, n, line.text, fact.from.kind === "me", handle === null ? [] : [handleId(handle)])];
  });
}

function spoken(chat: string, at_ms: number, n: number, line: string, mine: boolean, from: readonly string[]): Spoken {
  const colon = line.indexOf(SAID);
  return { chat, at_ms, n, from, mine, name: colon < 0 ? "" : line.slice(0, colon), ...talkText(colon < 0 ? line : line.slice(colon + SAID.length)) };
}

const FORWARDED = /^\(forwarded\)\s*/u;
const ASIDES = /\s*\((?:reply to|to) [^)]*\)|\s*\(edited\)/gu;
const EVENTS = /\[(?:system event|group event)[^\]]*\]/gu;
const MEDIA = /\[(photo|video|sticker|voice note|document|location|contact card)(?:, (\d+) s)?(?:: ([^\]]*))?\]/gu;

export function talkText(words: string): { text: string; forwarded: boolean } {
  const text = words.replace(FORWARDED, "").replace(ASIDES, "").replace(EVENTS, "")
    .replace(MEDIA, (_, kind: string, seconds: string | undefined, about: string | undefined) => {
      const length = seconds === undefined ? "" : `${Math.floor(Number(seconds) / 60)}:${String(Number(seconds) % 60).padStart(2, "0")}`;
      return [`${kind.charAt(0).toUpperCase()}${kind.slice(1)}`, length, about ?? ""].filter(Boolean).join(" · ");
    })
    .trim();
  return { text, forwarded: FORWARDED.test(words) };
}

export function talkDays(person: Talker, chats: ReadonlyMap<string, TalkChat>, settings: DaySettings): string[] {
  const direct = person.chats.map((each) => chats.get(each.key)).filter((chat) => chat !== undefined && !chat.group).map((chat) => chat!.last_ms);
  const days = Object.keys(person.days ?? {}).sort();
  const candidates = [
    direct.length === 0 ? null : civilDay(Math.max(...direct), settings),
    days.at(-1) ?? null,
    person.last_ms === null ? null : civilDay(person.last_ms, settings),
  ];
  return [...new Set(candidates.filter((day): day is string => day !== null))].slice(0, TALK_DAYS);
}

export function talkOn(person: Talker, chats: ReadonlyMap<string, TalkChat>, said: readonly Spoken[]): Omit<TalkRun, "day"> | null {
  const theirs = new Set(person.chats.map((each) => each.key));
  const handles = new Set(person.handles.map((each) => each.id));
  const pool = inOrder(said.filter((line) => theirs.has(line.chat)));
  const direct = talkOf(pool.filter((line) => chats.get(line.chat)?.group === false));
  if (direct !== null) return direct;
  const spoke = (line: Spoken) => line.from.some((handle) => handles.has(handle));
  const spokeIn = new Set(pool.filter(spoke).map((line) => line.chat));
  return talkOf(pool.filter((line) => spokeIn.has(line.chat) && (spoke(line) || line.mine)));
}

export function isDirect(talk: Pick<TalkRun, "chat">, chats: ReadonlyMap<string, TalkChat>): boolean {
  return chats.get(talk.chat)?.group === false;
}

export function lastTalk(person: Talker, chats: ReadonlyMap<string, TalkChat>, days: readonly TalkDay[]): TalkRun | null {
  for (const { day, said } of days.slice(0, TALK_DAYS)) {
    const talk = talkOn(person, chats, said);
    if (talk !== null) return { day, ...talk };
  }
  return null;
}

export function groupTalk(chat: string, days: readonly TalkDay[]): TalkRun | null {
  for (const { day, said } of days.slice(0, TALK_DAYS)) {
    const talk = talkOf(inOrder(said.filter((line) => line.chat === chat)));
    if (talk !== null) return { day, ...talk };
  }
  return null;
}

export function talkRuns(said: readonly Spoken[], gap_ms = TALK_GAP_MS): Spoken[][] {
  const runs: Spoken[][] = [];
  for (const line of inOrder(said)) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (run !== undefined && last !== undefined && line.at_ms - last.at_ms <= gap_ms) run.push(line);
    else runs.push([line]);
  }
  return runs;
}

function talkOf(pool: readonly Spoken[]): Omit<TalkRun, "day"> | null {
  const newest = pool.at(-1);
  if (newest === undefined) return null;
  return { chat: newest.chat, runs: talkRuns(pool.filter((line) => line.chat === newest.chat)) };
}

function inOrder(said: readonly Spoken[]): Spoken[] {
  return [...said].sort((left, right) => left.at_ms - right.at_ms);
}
