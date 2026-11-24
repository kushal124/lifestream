import { addDays, civilDay, digest, sha256, type DaySettings, type OpenView } from "@lifestreamprotocol/core";
import type { JoinedList, PeopleAnswer, PersonEntry, Searched } from "@lifestreamprotocol/families";
import type { AnswerOf, Body, ChatRow, PageHandler, Row } from "./pages.js";
import type { PeopleJoin } from "./people.js";
import type { PreparedRead } from "./prepared.js";
import { notNow } from "./refusal.js";
import { amount, number } from "./stream-words.js";

export interface PeopleReads {
  joined<T>(machine: string, use: (joined: PeopleJoin, file: PreparedRead, view: OpenView) => T): T;
  day(): DaySettings;
}

type People = AnswerOf<"people">;
type Listed = PeopleAnswer["list"] | JoinedList;
type Entry = PersonEntry & { readonly counting?: true };
type Chat = Listed["chats"][number];
type Handle = PersonEntry["handles"][number];
export type NamesHeld = ReadonlyMap<string, readonly string[]>;

const MOST = 5;
const NEW_DAYS = 7;
const NEW_MOST = 3;
const PREPARING_S = 2;
const NOT_YET = "No messages yet";
const CONTACT_CARD = "Contact card";
const YOU = "You";
const GROUP: readonly [string, string] = ["group", "groups"];
const MESSAGE: readonly [string, string] = ["message", "messages"];
const SUGGESTION: readonly [string, string] = ["suggestion", "suggestions"];

export function peoplePage(reads: PeopleReads): PageHandler<People> {
  return {
    params: [],
    open: (ask, use) => reads.joined(ask.machine, (joined, file, view) => {
      const kept = file.etag("answer", "list") ?? notNow("busy", "Your people are being prepared.", PREPARING_S);
      const rejoined = joined.same ? null : joined.list();
      const day = reads.day();
      return use({
        position: view.position(),
        inputs: [rejoined === null ? kept : sha256(JSON.stringify(rejoined)), namesTag(file), digest({ zone: day.zone, day_start_hour: day.day_start_hour })],
        counting: rejoined !== null && countingIn(rejoined),
        build: () => peopleBody(rejoined ?? joined.list(), namesHeld(searchedIn(file)), ask.today, day),
      });
    }),
  };
}

export function searchedIn(file: PreparedRead): readonly Searched[] {
  return file.value<{ people: Searched[] }>("names", "all")?.people ?? [];
}

export function namesHeld(searched: readonly Searched[]): NamesHeld {
  return new Map(searched.map((each) => [each.id, each.words]));
}

const namesTag = (file: PreparedRead): string => file.etag("names", "all") ?? "";

export function countingIn(list: Listed): boolean {
  return [list.you, ...list.people].some((entry) => entry !== null && (entry as Entry).counting === true);
}

export function youRow(list: Listed, names: NamesHeld): Row | null {
  return list.you === null ? null : { ...rowOf(list.you, names.get(list.you.id) ?? []), line: list.you.suggested > 0 ? amount(list.you.suggested, SUGGESTION) : YOU };
}

export function peopleBody(list: Listed, names: NamesHeld, today: string, day: DaySettings): Body<People> {
  const everyone: readonly Entry[] = list.people;
  const rowOfHeld = (person: Entry): Row => rowOf(person, names.get(person.id) ?? []);
  const humans = everyone.filter((person) => person.entity !== "ai").sort(newestFirst);
  const sections: { key: string; title: string | null; rows: Row[] }[] = [];
  for (const person of humans) {
    const key = sectionOf(person.last_ms, today, day);
    const held = sections.at(-1);
    if (held?.key === key) held.rows.push(rowOfHeld(person));
    else sections.push({ key, title: key === "none" ? NOT_YET : null, rows: [rowOfHeld(person)] });
  }
  const queue = list.organise.queue;
  const queued = new Set(queue);
  const since = addDays(today, 1 - NEW_DAYS);
  const groups = list.chats.filter((chat) => chat.group);
  const quiet = groups.filter((chat) => Boolean(chat.quiet));
  const { organised, often } = list.organise;
  const listed = new Map(everyone.map((person) => [person.id, person]));
  return {
    you: youRow(list, names),
    counts: { people: everyone.filter(writesTo).length, groups: groups.length - quiet.length },
    most: humans.filter((person) => isNamed(person) && person.last_30 > 0)
      .sort((left, right) => right.last_30 - left.last_30 || compare(left.id, right.id)).slice(0, MOST).map((person) => ({ id: person.id, line: amount(person.last_30, MESSAGE) })),
    sections,
    ai: everyone.filter((person) => person.entity === "ai").sort(newestFirst).map(rowOfHeld),
    new: everyone.filter((person) => queued.has(person.id) && person.first_ms !== null && civilDay(person.first_ms, day) >= since).slice(0, NEW_MOST)
      .map((person) => ({ id: person.id, line: `New · ${amount(person.received + person.sent, MESSAGE)}` })),
    businesses: businessesOf(list.organise.businesses.flatMap((each) => {
      const person = listed.get(each.id);
      return person === undefined ? [] : [offeredOf(person, each.reasons)];
    }), everyone.filter((person) => person.entity === "business" && person.entity_by === "you").length),
    organise: {
      count: queue.length,
      line: queue.length === 0 ? null : often > 0 ? `${number(organised)} organised · ${number(often)} more you talk to often` : `${number(organised)} organised · ${number(queue.length)} more`,
      queue: [...queue], organised, often,
    },
    groups: { yours: groups.filter((chat) => !chat.quiet).map(chatRowOf), quiet: quiet.map(chatRowOf), quiet_line: quiet.length === 0 ? null : amount(quiet.length, GROUP) },
  };
}

type Offered = NonNullable<Body<People>["businesses"]>["offered"][number];

const BUSINESS_SIGNS: readonly (readonly [reason: string, why: string])[] = [
  ["whatsapp", "Listed as a business on WhatsApp"],
  ["named", "Named like a business you hear from"],
  ["relay", "Mail signed by several people"],
  ["cards", "A company, no person’s name"],
];

function offeredOf(person: Entry, reasons: Readonly<Record<string, number>>): Offered {
  return {
    id: person.id, name: person.name, named: isNamed(person), photo: photoOf(person),
    why: BUSINESS_SIGNS.find(([reason]) => (reasons[reason] ?? 0) > 0)?.[1] ?? null,
    handles: person.handles.map((handle) => ({ id: handle.id, words: handle.words })),
  };
}

function businessesOf(offered: readonly Offered[], marked: number): Body<People>["businesses"] {
  if (offered.length > 0) return { line: `${number(offered.length)} to accept`, offered: [...offered] };
  return marked > 0 ? { line: `${number(marked)} marked as ${marked === 1 ? "a business" : "businesses"}`, offered: [] } : null;
}

function writesTo(person: Entry): boolean {
  return person.sent > 0 || person.by === "contact" || person.by === "registry";
}

export function isNamed(person: Pick<PersonEntry, "by">): boolean {
  return person.by !== "none";
}

function sectionOf(last_ms: number | null, today: string, day: DaySettings): string {
  if (last_ms === null) return "none";
  const on = civilDay(last_ms, day);
  return on.slice(0, 4) === today.slice(0, 4) ? `month:${on.slice(0, 7)}` : `year:${on.slice(0, 4)}`;
}

function newestFirst(left: Entry, right: Entry): number {
  if (left.last_ms !== right.last_ms) {
    if (left.last_ms === null) return 1;
    if (right.last_ms === null) return -1;
    return right.last_ms - left.last_ms;
  }
  return compare(left.id, right.id);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const valueOf = (handle: Handle): string => (handle.kind === "network" ? handle.id : handle.id.slice(handle.id.indexOf(":") + 1));

export function rowOf(person: Entry, names: readonly string[]): Row {
  return {
    id: person.id,
    name: person.name,
    named: isNamed(person),
    face: faceOnly(person),
    photo: photoOf(person),
    when: person.last_ms === null ? null : { kind: "at", at_ms: person.last_ms },
    line: lineOf(person),
    find: findOf(person, names),
  };
}

export function photoOf(person: { readonly photo: PersonEntry["photo"] }): string | null {
  return person.photo === null ? null : "crop" in person.photo ? person.photo.crop : person.photo.card;
}

function lineOf(person: Entry): string | null {
  if (person.me) return YOU;
  if (person.last_ms !== null) return null;
  const other = person.handles.find((handle) => valueOf(handle) !== person.name && handle.words !== person.name);
  return other?.words ?? (person.card ? CONTACT_CARD : null);
}

export function faceOnly(person: Pick<Entry, "person" | "handles">): boolean {
  return person.person !== null && person.handles.length === 0;
}

function findOf(person: Entry, names: readonly string[]): string[] {
  const words = [person.name, person.call_name, person.full_name ?? "", ...names, ...person.handles.flatMap((handle) => {
    const value = valueOf(handle);
    return [handle.words, value, ...(handle.kind === "phone" ? [value.replace(/\D/gu, "")] : [])];
  })];
  return [...new Set(words.filter((each) => each !== ""))];
}

function chatRowOf(chat: Chat): ChatRow {
  const title = chat.label === "" ? chat.chat : chat.label;
  return { chat: chat.key, title, photo: null, when: { kind: "at", at_ms: chat.last_ms }, line: null, find: [title] };
}
