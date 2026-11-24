import { createHash } from "node:crypto";
import { closeSync, constants, cpSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dayBounds, DAYS_MARK, HOME_STORE, homeSchema, openHome, openHomeFolder, RELEASE, type DaySettings, type ExtractRow, type HomeFolder, type JsonObject, type Tx } from "@lifestreamprotocol/core";
import { documentText, RENDERER_VERSION, type AtomFlag, type ChatDay, type DayAtom, type DayDocument, type DayFileFact, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { dayPath } from "../packages/home/derive.js";
import { HOME_FILE, HOME_FORMAT } from "../packages/home/lifecycle.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "../packages/home/prepared.js";
import { FACTS_FORMAT } from "../packages/home/index-layers.js";
import { ScreenIndex, screenFileOf, type ScreenSegment, type ScreenSource } from "../packages/home/screen-index.js";
import { FORMAT as SEARCH_FORMAT, SearchIndex, searchFileOf, type AtomEntry, type RecordEntry } from "../packages/home/search-index.js";

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const LONG_DAYS = 28;
const LONG_HOUR = 10;
const LONG_PLACE = "Place Longstay";
const HER_RECORDS = 40;
export const FILED_DAYS = 60;
const HERE = fileURLToPath(import.meta.url);
const FORMATS = { home: HOME_FORMAT, schema: homeSchema.latest, search: SEARCH_FORMAT, facts: FACTS_FORMAT, people: PEOPLE.format, days: RENDERER_VERSION };
const BUILT = "built.json";
const BUILDING = ".building-";
const ASKING = "asking";
export const GATE_CACHE = join(homedir(), platform() === "darwin" ? "Library/Caches" : ".cache", "lifestream-tests", "gate");

export interface GateSize {
  years: number;
  messages: number;
  mails: number;
  stays: number;
  calls: number;
  payments: number;
  people: number;
  chats: number;
  screen: { days: number; segments: number };
}

export const SIZES = {
  full: { years: 10, messages: 2_740_000, mails: 123_000, stays: 5_000, calls: 8_000, payments: 9_000, people: 1_400, chats: 2_000, screen: { days: 365, segments: 108 } },
  tenth: { years: 10, messages: 274_000, mails: 12_300, stays: 500, calls: 800, payments: 900, people: 300, chats: 400, screen: { days: 365, segments: 108 } },
  tiny: { years: 1, messages: 2_000, mails: 120, stays: 40, calls: 30, payments: 40, people: 24, chats: 16, screen: { days: 14, segments: 12 } },
} as const satisfies Record<string, GateSize>;
export type SizeName = keyof typeof SIZES;

export const END = "2026-11-10";
export const NOW_MS = Date.parse("2026-11-13T12:00:00Z");
export const UNIT = "macbook-pro-0001";
export const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };

const SOURCES = {
  whatsapp: { id: `whatsapp:+15550000001:${UNIT}`, connector: "whatsapp", vendor: "meta", kind: "msg" },
  gmail: { id: "gmail:person-a@example.com:cloud", connector: "gmail", vendor: "google", kind: "mailmsg" },
  calls: { id: `apple-calls:local:${UNIT}`, connector: "apple-calls", vendor: "apple", kind: "call" },
  location: { id: "location:local:phone-gate-0001", connector: "location", vendor: "lifestream", kind: "fix" },
  bank: { id: "bank:acct-0001:export", connector: "bank-statement", vendor: "bank", kind: "payment" },
} as const;

export interface GateHome {
  root: string;
  machine: string;
  key: string;
  digest: string;
  size: GateSize;
  seed: number;
  first: string;
  last: string;
  counts: Record<string, number>;
  largest: { id: string; handles: string[]; name: string; messages: number; chat: string; chat_messages: number };
  small: { chat: string; messages: number };
  common: string;
  common_groups: number;
  her: { id: string; name: string; phone: string; records: number };
  crowd: { name: string; people: number };
  words: { common: string; rare: string; top: string[] };
  filed: { from: string; busy: string; lines: number };
  long: { from: string; inside: string; to: string; place: string; minutes: number };
  screen: { from: string; to: string; common: string; common_windows: number; name: string; name_windows: number };
  build_s: number;
  bytes: number;
  kept: boolean;
}


function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function cumulative(weights: readonly number[]): Float64Array {
  const sums = new Float64Array(weights.length);
  let sum = 0;
  weights.forEach((weight, at) => (sums[at] = sum += weight));
  return sums;
}
function pick(sums: Float64Array, next: () => number): number {
  const target = next() * sums[sums.length - 1]!;
  let low = 0, high = sums.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sums[mid]! <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}
const zipf = (n: number, s = 1.07) => Array.from({ length: n }, (_, at) => 1 / (at + 1) ** s);


const GIVEN = ["Sam", "Ada", "Raj", "Kai", "Mei", "Noor", "Leo", "Ana", "Ravi", "Zoe", "Ivo", "Lena", "Omar", "Tia", "Yuki", "Dev", "Ines", "Joss", "Nia", "Ola",
  "Pax", "Rhea", "Teo", "Uma", "Vik", "Wren", "Xia", "Yan", "Zed", "Bea", "Cyd", "Dax", "Eli", "Fay", "Gus", "Hal", "Ira", "Jem", "Kit", "Lux"];
const PHONE_PREFIX = "+1555";
const FAMILY = ["Example", "Sample", "Placeholder", "Fictional", "Synthetic", "Testwell", "Demo", "Mockley", "Stubbs", "Fixture", "Dummy", "Pretend"];

interface Person {
  id: string;
  name: string;
  phone: string;
  email: string | null;
}
interface Chat {
  key: string;
  title: string;
  group: boolean;
  members: number[];
  from: number;
  to: number;
  weight: number;
}

const digits = (n: number, width: number) => String(n).padStart(width, "0");
const hex = (n: number) => n.toString(16).padStart(24, "0");
const handlesOf = (person: Person) => [`phone:${person.phone}`, ...(person.email === null ? [] : [`email:${person.email}`])];

function castOf(size: GateSize, next: () => number, days: number): { people: Person[]; chats: Chat[] } {
  const given = cumulative(zipf(GIVEN.length, 1.2));
  const people: Person[] = Array.from({ length: size.people }, (_, at) => {
    const name = at === 0 ? "Ada Example" : `${GIVEN[pick(given, next)]!} ${FAMILY[at % FAMILY.length]!}${at >= FAMILY.length ? `-${at}` : ""}`;
    return { id: `person:p${digits(at, 4)}`, name, phone: `${PHONE_PREFIX}${digits(1_000_000 + at, 7)}`, email: at % 2 === 0 ? `person-${at}@example.com` : null };
  });
  const big = [0.182, 0.091, 0.055, 0.036];
  const rest = zipf(size.chats - big.length);
  const restSum = rest.reduce((sum, weight) => sum + weight, 0);
  const left = 1 - big.reduce((sum, weight) => sum + weight, 0);
  const chats: Chat[] = [];
  for (let at = 0; at < size.chats; at++) {
    const group = at === 0 || (at >= big.length && (at % 7 === 3 || at >= size.people));
    const members = at === 0 ? [0, size.people - 1, size.people - 2] : group
      ? Array.from({ length: 2 + Math.floor(next() * 58) }, () => 1 + Math.floor(next() * (size.people - 1)))
      : [at % size.people];
    const unique = [...new Set(members)];
    const span = at < big.length ? Math.floor(days * (0.7 + 0.3 * next())) : Math.max(30, Math.floor(days * (0.1 + 0.9 * next())));
    const now = at < big.length || next() < 2 / 3;
    const from = now ? days - span : Math.floor(next() * (days - span));
    const title = !group ? people[unique[0]!]!.name : at > 0 && at % 4 === 1 ? `${people[unique[0]!]!.name.split(" ")[0]!} and friends ${at}` : `Group ${at}`;
    chats.push({
      key: group ? `whatsapp:120363${digits(at, 12)}@g.us` : `whatsapp:${people[unique[0]!]!.phone.slice(1)}@s.whatsapp.net`,
      title, group, members: unique, from, to: from + span,
      weight: at < big.length ? big[at]! : (left * rest[at - big.length]!) / restSum,
    });
  }
  return { people, chats };
}


function vocabularyOf(): string[] {
  const all = readFileSync(fileURLToPath(new URL("../packages/core/english-words.txt", import.meta.url)), "utf8").split("\n").filter((word) => /^[a-z]{3,9}$/u.test(word));
  const step = Math.max(1, Math.floor(all.length / 4_000));
  return Array.from({ length: Math.min(4_000, Math.floor(all.length / step)) }, (_, at) => all[at * step]!);
}


interface Day {
  day: string;
  facts: DayFileFact[];
  atoms: AtomEntry[];
  records: RecordEntry[];
  extracts: ExtractRow[];
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function* life(size: GateSize, seed: number, landmarks: { people: Person[]; chats: Chat[]; words: string[] }): Generator<Day> {
  const next = random(seed);
  const days = Math.round(size.years * 365.25);
  const first_ms = Date.parse(`${END}T00:00:00Z`) - (days - 1) * DAY_MS;
  const { people, chats } = castOf(size, next, days);
  const vocabulary = vocabularyOf();
  landmarks.people.push(...people);
  landmarks.chats.push(...chats);
  landmarks.words.push(...vocabulary);
  const word = cumulative(zipf(vocabulary.length));
  const words = (n: number) => Array.from({ length: n }, () => vocabulary[pick(word, next)]!).join(" ");
  const rise = Array.from({ length: days }, (_, at) => 0.1 + 0.9 * (at / days) ** 1.5);
  const riseSum = rise.reduce((sum, weight) => sum + weight, 0);
  const perDay = (total: number, at: number) => {
    const mean = (total * rise[at]!) / riseSum;
    return Math.max(0, Math.floor(mean * (0.6 + 0.8 * next()) + next()));
  };
  const inWindow = chats.map((chat) => rise.slice(chat.from, chat.to + 1).reduce((sum, weight) => sum + weight, 0));
  const flat = (total: number) => Math.floor(total / days + (next() < (total / days) % 1 ? 1 : 0));
  const hour = cumulative([1, 0.5, 0.2, 0.1, 0.1, 0.2, 0.6, 1.5, 3, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4.5, 5, 5, 4.5, 3.5, 2]);
  const at = (day_ms: number) => day_ms + pick(hour, next) * 3_600_000 + Math.floor(next() * 3_600_000);
  const senders = cumulative(zipf(300));
  const payees = cumulative(zipf(300));
  const places = cumulative(zipf(200));
  const callers = cumulative(zipf(size.people));
  let n = 0;

  for (let d = 0; d < days; d++) {
    const day_ms = first_ms + d * DAY_MS;
    const day = dayOf(day_ms);
    const facts: DayFileFact[] = [];
    const lines: { at: number; atom: Omit<AtomEntry, "n">; fact?: DayFileFact }[] = [];
    const records: RecordEntry[] = [];
    const chatDay = new Map<string, ChatDay["messages"]>();
    const extracts: ExtractRow[] = [];

    for (const [c, chat] of chats.entries()) {
      if (d < chat.from || d > chat.to) continue;
      for (let count = Math.floor((size.messages * chat.weight * rise[d]!) / inWindow[c]! * (0.6 + 0.8 * next()) + next()); count > 0; count--) {
        const time = at(day_ms);
        const sent = next() < 0.45;
        const from = sent ? -1 : chat.key.endsWith("@g.us") && chat.members.length > 1
          ? (chat === chats[0] ? (next() < 0.91 ? 0 : chat.members[1 + Math.floor(next() * 2)]!) : chat.members[Math.floor(next() * chat.members.length)]!)
          : chat.members[0]!;
        const who = sent ? chat.members.map((member) => ({ handle: `phone:${people[member]!.phone}`, role: "receiver" as const })) : [{ handle: `phone:${people[from]!.phone}`, role: "sender" as const }];
        const said = next() < 0.92 ? words(3 + Math.floor(next() * 12)) : null;
        const key = `m${n}`;
        const record = { source: SOURCES.whatsapp.id, kind: SOURCES.whatsapp.kind, key };
        const unit = `${day}:${chat.key}`;
        const said_by = sent ? { id: "me", kind: "me" as const } : { id: `${people[from]!.phone.slice(1)}@s.whatsapp.net`, kind: "jid" as const };
        const listed = chatDay.get(chat.key) ?? (chatDay.set(chat.key, []), chatDay.get(chat.key)!);
        listed.push({ source: SOURCES.whatsapp.id, key, at: time, from: said_by, ...(said === null ? { parts: [{ what: "photo" }] } : { text: said }) });
        const fact: DayFileFact = {
          id: `messages:${hex(n++)}`, family: "messages", of: "messages", time_ms: time, start_ms: time, end_ms: time,
          keys: { chat: chat.key, direction: sent ? "sent" : "received", product: "whatsapp", searchable: said === null ? "no" : "yes" }, measures: {},
          who: [...new Map(who.map((each) => [each.handle, each])).values()].sort((a, b) => (a.handle < b.handle ? -1 : 1)), from: { units: [unit], record, alone: true }, lines: [],
        };
        const speaker = sent ? "Me" : people[from]!.name;
        const text = `${speaker}: ${said ?? "(photo)"}`;
        lines.push({
          at: time, fact, atom: {
            family: "messages", unit, record, start_ms: time, end_ms: null, text, title: chat.title,
            ...(sent ? {} : { names: [{ start: 0, end: speaker.length, who: `phone:${people[from]!.phone}` }] }),
            ...(chat.group ? {} : { title_names: [{ start: 0, end: chat.title.length, who: `phone:${people[chat.members[0]!]!.phone}` }] }),
          },
        });
        if (said !== null) records.push({ record, family: "messages", version: `v-${key}`, start_ms: time, end_ms: null, title: "", text: said, who: fact.who.map((each) => each.handle), link: null });
      }
    }

    for (let count = perDay(size.mails, d); count > 0; count--) {
      const time = at(day_ms);
      const roll = next();
      const person = people[Math.floor(next() * people.length / 2) * 2]!;
      const sent = roll < 0.1;
      const sender = roll < 0.3 ? `email:${person.email}` : `email:news-${pick(senders, next)}@example.com`;
      const who = sent ? [{ handle: `email:${person.email}`, role: "receiver" as const }] : [{ handle: sender, role: "sender" as const }];
      const subject = words(3 + Math.floor(next() * 5));
      const key = `e${n}`;
      const record = { source: SOURCES.gmail.id, kind: SOURCES.gmail.kind, key };
      const fact: DayFileFact = {
        id: `mails:${hex(n++)}`, family: "mail", of: "mails", time_ms: time, start_ms: time, end_ms: time, keys: { direction: sent ? "sent" : "received", title: subject }, measures: {},
        who, from: { units: [`mail/${key}`], record, alone: true }, lines: [],
      };
      lines.push({ at: time, fact, atom: { family: "mail", unit: `mail/${key}`, record, start_ms: time, end_ms: null, text: `${subject}\n${words(8)}` } });
      records.push({ record, family: "mail", version: `v-${key}`, start_ms: time, end_ms: null, title: subject, text: words(10 + Math.floor(next() * 30)), who: who.map((each) => each.handle), link: null });
    }

    for (let count = flat(size.calls); count > 0; count--) {
      const person = people[pick(callers, next)]!;
      const late = next() < 0.1;
      const time = late ? day_ms + 23 * 3_600_000 + Math.floor(next() * 50) * MIN_MS : Math.floor(at(day_ms) / MIN_MS) * MIN_MS;
      const missed = next() < 0.15;
      const minutes = missed ? null : 1 + Math.floor(next() * (late ? 90 : 40));
      const key = `c${n}`;
      const record = { source: SOURCES.calls.id, kind: SOURCES.calls.kind, key };
      const end_ms = time + (minutes ?? 0) * MIN_MS;
      const fact: DayFileFact = {
        id: `calls:${hex(n++)}`, family: "calls", of: "calls", time_ms: time, start_ms: time, end_ms,
        keys: { service: "whatsapp", direction: next() < 0.5 ? "outgoing" : "incoming", outcome: missed ? "missed" : "connected", chat: `whatsapp:${person.phone.slice(1)}@s.whatsapp.net` },
        measures: minutes === null ? {} : { minutes }, who: [{ handle: `phone:${person.phone}`, role: "receiver" }], from: { units: [`calls/${key}`], record, alone: true }, lines: [],
      };
      lines.push({ at: time, fact, atom: { family: "calls", unit: `calls/${key}`, record, start_ms: time, end_ms, text: `Call with ${person.name}${minutes === null ? ", missed" : `, ${minutes} min`}`, names: [{ start: 10, end: 10 + person.name.length, who: `phone:${person.phone}` }] } });
    }

    for (let count = flat(size.stays); count > 0; count--) {
      const evening = next() < 0.5;
      const place = evening ? 0 : pick(places, next);
      const start = evening ? day_ms + (19 + Math.floor(next() * 4)) * 3_600_000 : day_ms + (8 + Math.floor(next() * 9)) * 3_600_000;
      const minutes = evening ? 300 + Math.floor(next() * 600) : 30 + Math.floor(next() * 240);
      const end_ms = Math.min(start + minutes * MIN_MS, evening ? day_ms + DAY_MS + 12 * 3_600_000 : day_ms + DAY_MS - MIN_MS);
      const unit = `stay/${SOURCES.location.id}/s${n}`;
      const fact: DayFileFact = {
        id: `stays:${hex(n++)}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms,
        keys: { place: `Place ${place}`, city: `City ${place % 15}`, country: `Country ${place % 4}`, how: "observed" },
        measures: { minutes: Math.round((end_ms - start) / MIN_MS) }, who: [], from: { units: [unit] }, lines: [],
      };
      lines.push({ at: start, fact, atom: { family: "physical", unit, start_ms: start, end_ms, text: `At Place ${place}` } });
      const point = { latitude: 10 + (place % 20) * 0.01, longitude: -30 - Math.floor(place / 20) * 0.01 };
      extracts.push({
        family: "physical", unit, reading: `r-${unit}`, code: "13", start_ms: start, end_ms, days: end_ms > day_ms + DAY_MS ? [day, dayOf(day_ms + DAY_MS)] : [day], items: [], seq: 0,
        content: { rank: 1, how: "observed", by: "Phone", kind: "stay", source: SOURCES.location.id, start_ms: start, end_ms, open: false, centre: point, level: "observed", silences: [], bouts: [] },
      } as ExtractRow);
    }

    if (d === days - 60) {
      const start = day_ms + LONG_HOUR * 3_600_000;
      const end_ms = start + LONG_DAYS * DAY_MS;
      const unit = `stay/${SOURCES.location.id}/long`;
      const fact: DayFileFact = {
        id: `stays:${hex(n++)}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms,
        keys: { place: LONG_PLACE, city: "City 1", country: "Country 1", how: "observed" },
        measures: { minutes: Math.round((end_ms - start) / MIN_MS) }, who: [], from: { units: [unit] }, lines: [],
      };
      lines.push({ at: start, fact, atom: { family: "physical", unit, start_ms: start, end_ms, text: `At ${LONG_PLACE}` } });
      extracts.push({
        family: "physical", unit, reading: `r-${unit}`, code: "13", start_ms: start, end_ms, days: Array.from({ length: LONG_DAYS + 1 }, (_, at) => dayOf(day_ms + at * DAY_MS)), items: [], seq: 0,
        content: { rank: 1, how: "observed", by: "Phone", kind: "stay", source: SOURCES.location.id, start_ms: start, end_ms, open: false, centre: { latitude: 10.01, longitude: -30 }, level: "observed", silences: [], bouts: [] },
      } as ExtractRow);
    }

    for (let count = flat(size.payments); count > 0; count--) {
      const payee = `SYNTHETIC SHOP ${pick(payees, next)}`;
      const inr = next() < 0.3;
      const amount = inr ? `${100 + Math.floor(next() * 5000)}.00` : `${1 + Math.floor(next() * 120)}.${digits(Math.floor(next() * 100), 2)}`;
      const key = `p${n}`;
      const record = { source: SOURCES.bank.id, kind: SOURCES.bank.kind, key };
      const fact: DayFileFact = {
        id: `payments:${hex(n++)}`, family: "money", of: "payments", time_ms: day_ms, start_ms: day_ms, end_ms: day_ms, date_only: true,
        keys: { payee, direction: next() < 0.9 ? "debit" : "credit", channel: next() < 0.6 ? "UPI" : "POS", currency: inr ? "INR" : "EUR" }, measures: { amount },
        who: [], from: { units: [`money/${key}`], record, alone: true }, lines: [],
      };
      lines.push({ at: day_ms, fact, atom: { family: "money", unit: `money/${key}`, record, start_ms: day_ms, end_ms: null, dated: true, text: `${payee} ${amount} ${inr ? "INR" : "EUR"}` } });
      records.push({ record, family: "money", version: `v-${key}`, start_ms: day_ms, end_ms: null, title: "", text: `UPI-${payee}-ref ${words(2)}`, who: [], link: null, dated: true });
    }

    lines.sort((a, b) => a.at - b.at);
    const atoms: AtomEntry[] = lines.map((line, index) => {
      if (line.fact !== undefined) line.fact.lines = [index + 1];
      return { n: index + 1, ...line.atom };
    });
    facts.push(...lines.flatMap((line) => (line.fact === undefined ? [] : [line.fact])));
    facts.sort((a, b) => a.time_ms - b.time_ms || (a.family < b.family ? -1 : a.family > b.family ? 1 : a.id < b.id ? -1 : 1));
    for (const [chat, messages] of chatDay) {
      const unit = `${day}:${chat}`;
      messages.sort((a, b) => a.at - b.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      const content: ChatDay = { network: "whatsapp", chat: chat.slice("whatsapp:".length), day, messages };
      extracts.push({ family: "messages", unit, reading: `r-${unit}`, code: "1", content: content as unknown as JsonObject, start_ms: messages[0]!.at, end_ms: messages.at(-1)!.at, days: [day], items: [], seq: 0 } as ExtractRow);
    }
    yield { day, facts, atoms, records, extracts };
  }
}


export function keyOf(size: GateSize, seed: number): string {
  return createHash("sha256").update(readFileSync(HERE)).update(JSON.stringify(FORMATS)).update(JSON.stringify(size)).update(String(seed)).digest("hex").slice(0, 16);
}

export function gateHome(options: { size: GateSize; seed: number; cache: string; log?: (line: string) => void }): GateHome {
  const { size, seed, cache } = options;
  const log = options.log ?? (() => undefined);
  mkdirSync(cache, { recursive: true });
  sweep(cache);
  const key = keyOf(size, seed);
  const dir = join(cache, key);
  const found = keptIn(dir);
  if (found !== undefined && fits(found)) {
    prune(cache, key, size, log);
    return found;
  }
  if (found !== undefined) log(`gate home ${key}: a format moved, building again`);
  rmSync(dir, { recursive: true, force: true });
  const building = join(cache, `${key}${BUILDING}${process.pid}`);
  rmSync(building, { recursive: true, force: true });
  const started = Date.now();
  const built = build(building, size, seed, log);
  const facts = { ...built, key, build_s: Math.round((Date.now() - started) / 100) / 10, bytes: bytesOf(building) };
  writeFileSync(join(building, BUILT), `${JSON.stringify(facts, null, 2)}\n`);
  try {
    renameSync(building, dir);
  } catch (error) {
    const theirs = keptIn(dir);
    if (theirs === undefined) throw error;
    rmSync(building, { recursive: true, force: true });
    log(`gate home ${key}: another run kept it first, taking theirs`);
    return theirs;
  }
  prune(cache, key, size, log);
  return { ...facts, root: join(dir, "home"), machine: join(dir, "machine"), kept: false };
}

export function copyToAsk(home: GateHome, cache: string): { home: GateHome; drop: () => void } {
  const at = join(cache, ASKING, `${process.pid}-${home.key}`);
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true });
  const copy = { ...home, root: join(at, "home"), machine: join(at, "machine") };
  cpSync(home.root, copy.root, { recursive: true, mode: constants.COPYFILE_FICLONE });
  cpSync(home.machine, copy.machine, { recursive: true, mode: constants.COPYFILE_FICLONE });
  flushed(at);
  return { home: copy, drop: () => rmSync(at, { recursive: true, force: true }) };
}

function flushed(path: string): void {
  const kind = lstatSync(path);
  if (kind.isSymbolicLink()) return;
  if (kind.isDirectory()) for (const name of readdirSync(path)) flushed(join(path, name));
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function keptIn(dir: string): GateHome | undefined {
  const file = join(dir, BUILT);
  if (!existsSync(file)) return undefined;
  return { ...JSON.parse(readFileSync(file, "utf8")) as GateHome, root: join(dir, "home"), machine: join(dir, "machine"), kept: true };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pidOf(name: string, from: number): number {
  return Number.parseInt(name.slice(from), 10);
}

function sweep(cache: string): void {
  for (const name of readdirSync(cache)) {
    const at = name.indexOf(BUILDING);
    if (at > 0 && !alive(pidOf(name, at + BUILDING.length))) rmSync(join(cache, name), { recursive: true, force: true });
  }
  const asking = join(cache, ASKING);
  if (!existsSync(asking)) return;
  for (const name of readdirSync(asking)) if (!alive(pidOf(name, 0))) rmSync(join(asking, name), { recursive: true, force: true });
}

function prune(cache: string, key: string, size: GateSize, log: (line: string) => void): void {
  const asking = existsSync(join(cache, ASKING)) ? readdirSync(join(cache, ASKING)) : [];
  for (const name of readdirSync(cache)) {
    if (name === key || name === ASKING || name.includes(BUILDING)) continue;
    const other = keptIn(join(cache, name));
    if (other === undefined || JSON.stringify(other.size) !== JSON.stringify(size)) continue;
    if (asking.some((each) => each.endsWith(`-${name}`))) continue;
    rmSync(join(cache, name), { recursive: true, force: true });
    log(`gate home ${name}: removed, ${key} is the newest of its size`);
  }
}

function fits(home: GateHome): boolean {
  if (!existsSync(join(home.root, HOME_FILE))) return false;
  const folder = openHomeFolder(home.root, { machine: home.machine, program: "home" });
  const index = SearchIndex.read(folder, searchFileOf(home.root, home.machine));
  if (index === undefined) return false;
  index.close();
  const screen = ScreenIndex.read(folder, screenFileOf(searchFileOf(home.root, home.machine)));
  if (screen === undefined) return false;
  screen.close();
  const db = folder.store(HOME_STORE, join(home.root, "home.db"), { mode: "read", mustExist: true });
  try {
    return homeSchema.refusal(homeSchema.version(db)) === null;
  } finally {
    db.close();
  }
}

function bytesOf(path: string): number {
  const stat = statSync(path);
  return stat.isDirectory() ? readdirSync(path).reduce((sum, name) => sum + bytesOf(join(path, name)), 0) : stat.size;
}

type Built = Omit<GateHome, "key" | "root" | "machine" | "build_s" | "bytes" | "kept">;

function build(dir: string, size: GateSize, seed: number, log: (line: string) => void): Built {
  const root = join(dir, "home"), machine = join(dir, "machine");
  mkdirSync(root, { recursive: true });
  mkdirSync(machine, { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: `home-gate-${seed}`, created: "2016-01-01T00:00:00Z" }));
  const folder = openHomeFolder(root, { machine, program: "home" });
  const index = SearchIndex.write(folder, searchFileOf(root, machine), () => true, 0, DAY);
  const home = openHome(folder, "migrate");
  const hash = createHash("sha256");
  const counts: Record<string, number> = {};
  const listed = new Map<string, string>();
  const cast = { people: [] as Person[], chats: [] as Chat[], words: [] as string[] };
  const inPerson = new Map<number, number>();
  const inHandle = new Map<string, number>();
  const inChat = new Map<string, number>();
  const wordCount = new Map<string, number>();
  let first = "", last = "", seq = 0, started = Date.now();
  let pending: Day[] = [];
  const flush = () => {
    home.commit((tx: Tx) => {
      for (const each of pending) {
        tx.derived.days.put(each.day, listed.get(each.day)!, { total: each.atoms.length, per_family: perFamily(each.atoms) });
        for (const extract of each.extracts) tx.derived.extracts.put(extract);
      }
    });
    pending = [];
  };
  home.commit((tx: Tx) => {
    for (const source of Object.values(SOURCES)) tx.tables.sources.add({ id: source.id, vendor: source.vendor, connector: source.connector, options: {}, added_ms: Date.parse("2016-01-01") });
  });
  const filedFrom = dayOf(Date.parse(`${END}T00:00:00Z`) - (FILED_DAYS - 1) * DAY_MS);
  const busy = { day: "", lines: -1 };
  mkdirSync(join(root, "days"));
  for (const day of life(size, seed, cast)) {
    first ||= day.day;
    last = day.day;
    const inputs = `sha256:${createHash("sha256").update(JSON.stringify([day.facts, day.atoms])).digest("hex")}`;
    if (day.day >= filedFrom) {
      writeFileSync(dayPath(root, day.day, "json"), documentText(dayDocumentOf(day, inputs)));
      if (day.atoms.length > busy.lines) Object.assign(busy, { day: day.day, lines: day.atoms.length });
    }
    hash.update(inputs).update(JSON.stringify(day.records)).update(JSON.stringify(day.extracts));
    listed.set(day.day, inputs);
    seq++;
    index.records(day.records, [], { position: { seq, statement: `gate-${seq}`, reread: 0 } });
    index.day(day.day, { inputs, mtime_us: 1, atoms: day.atoms, facts: { window: dayBounds(day.day, DAY), facts: day.facts } });
    for (const fact of day.facts) {
      counts[fact.of] = (counts[fact.of] ?? 0) + 1;
      if (fact.of !== "messages") continue;
      inChat.set(fact.keys.chat!, (inChat.get(fact.keys.chat!) ?? 0) + 1);
      for (const { handle } of fact.who) {
        const person = Number(handle.slice(-7)) - 1_000_000;
        inPerson.set(person, (inPerson.get(person) ?? 0) + 1);
      }
    }
    for (const record of day.records) if (record.family === "messages") for (const word of new Set(record.text.split(" "))) wordCount.set(word, (wordCount.get(word) ?? 0) + 1);
    for (const record of day.records) for (const handle of new Set(record.who)) inHandle.set(handle, (inHandle.get(handle) ?? 0) + 1);
    pending.push(day);
    if (pending.length >= 60) flush();
    if (seq % 365 === 0) log(`gate home: ${day.day}, ${counts.messages ?? 0} messages, ${Math.round((Date.now() - started) / 1000)} s`);
  }
  flush();
  home.commit((tx: Tx) => tx.tables.meta.set(DAYS_MARK, RELEASE));
  home.close();
  index.finish();
  index.close();
  writePeople(folder, machine, cast.people, cast.chats);
  const screen = writeScreen(folder, screenFileOf(searchFileOf(root, machine)), size, seed, cast, hash, log);
  const [top] = [...inPerson].sort((a, b) => b[1] - a[1]);
  const largest = cast.people[top![0]]!;
  const ranked = [...wordCount].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const givens = new Map<string, number>();
  for (const person of cast.people) givens.set(person.name.split(" ")[0]!, (givens.get(person.name.split(" ")[0]!) ?? 0) + 1);
  const [theirChat, chatMessages] = [...inChat].filter(([chat]) => cast.chats.find((each) => each.key === chat)!.members.includes(top![0])).sort((a, b) => b[1] - a[1])[0]!;
  const lastDay = Math.round(size.years * 365.25) - 1;
  const [smallChat, smallMessages] = cast.chats.filter((chat) => chat.to >= lastDay && inChat.has(chat.key))
    .map((chat) => [chat.key, inChat.get(chat.key)!] as const).sort((a, b) => Math.abs(a[1] - 60) - Math.abs(b[1] - 60) || (a[0] < b[0] ? -1 : 1))[0]!;
  const common = [...givens].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  const named = cast.people.map((person) => person.name.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const holds = (words: readonly string[], part: readonly string[]) => words.some((_, at) => part.every((word, j) => words[at + j] === word));
  const her = cast.people.map((person, at) => ({ person, at, records: handlesOf(person).reduce((sum, handle) => sum + (inHandle.get(handle) ?? 0), 0) }))
    .filter(({ person, at, records }) => person.name.split(" ")[0] === common && records > 0 && !named.some((words, other) => other !== at && holds(words, named[at]!)))
    .sort((a, b) => Math.abs(a.records - HER_RECORDS) - Math.abs(b.records - HER_RECORDS) || a.at - b.at)[0]!;
  return {
    digest: hash.digest("hex"), size, seed, first, last, counts,
    largest: { id: largest.id, handles: handlesOf(largest), name: largest.name, messages: top![1], chat: theirChat, chat_messages: chatMessages },
    small: { chat: smallChat, messages: smallMessages },
    common, common_groups: cast.chats.filter((chat) => chat.group && chat.title.startsWith(`${common} `)).length,
    her: { id: her.person.id, name: her.person.name, phone: her.person.phone, records: her.records },
    crowd: { name: PHONE_PREFIX, people: cast.people.filter((person) => person.phone.startsWith(PHONE_PREFIX)).length },
    words: { common: ranked[0]![0], rare: (ranked.find(([, count]) => count <= Math.max(3, (counts.messages ?? 0) / 10_000)) ?? ranked.at(-1)!)[0], top: ranked.slice(0, 7).map(([word]) => word) },
    filed: { from: filedFrom, busy: busy.day, lines: busy.lines },
    long: longOf(),
    screen,
  };
}

function longOf(): GateHome["long"] {
  const from_ms = Date.parse(`${END}T00:00:00Z`) - 59 * DAY_MS;
  const inside_ms = from_ms + 14 * DAY_MS;
  const end_ms = from_ms + LONG_HOUR * 3_600_000 + LONG_DAYS * DAY_MS;
  return { from: dayOf(from_ms), inside: dayOf(inside_ms), to: dayOf(end_ms), place: LONG_PLACE, minutes: Math.round((end_ms - inside_ms) / MIN_MS) };
}


const SCREEN_MACHINE = UNIT;
const APPS = ["Editor", "Browser", "Mail", "Terminal", "Notes", "Sheets"];

function writeScreen(folder: HomeFolder, file: string, size: GateSize, seed: number, cast: { people: Person[]; words: string[] }, hash: ReturnType<typeof createHash>, log: (line: string) => void): GateHome["screen"] {
  const vocabulary = cast.words;
  const word = cumulative(zipf(vocabulary.length));
  const common = vocabulary[Math.floor(vocabulary.length / 2)]!;
  const givens = new Map<string, number>();
  for (const person of cast.people) givens.set(person.name.split(" ")[0]!, (givens.get(person.name.split(" ")[0]!) ?? 0) + 1);
  const name = [...givens].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]![0];
  const named = cast.people.filter((person) => person.name.startsWith(`${name} `));
  const segmentsOf = (day: string): ScreenSegment[] => {
    const at = random(seed ^ Number(day.replaceAll("-", "")));
    const words = (n: number) => Array.from({ length: n }, () => vocabulary[pick(word, at)]!);
    const day_ms = Date.parse(`${day}T00:00:00Z`);
    const out: ScreenSegment[] = [];
    for (let s = 0; s < size.screen.segments; s++) {
      const start_ms = day_ms + 8 * 3_600_000 + s * 300_000;
      const window = Math.floor(at() * 12);
      const app = APPS[window % APPS.length]!;
      const site = app === "Browser" ? `site-${window}.example.com` : null;
      const title = `Page ${window} ${day.slice(5)}`;
      const showsName = window % 3 === 0;
      const frames = [0, 100_000, 200_000].map((offset) => ({
        t: start_ms + offset, app, title, site,
        lines: Array.from({ length: 6 }, (_, line) => {
          const said = words(6 + Math.floor(at() * 5));
          if (line === 0 && at() < 0.95) said.splice(Math.floor(at() * said.length), 0, common);
          if (showsName && line === 1) said.splice(0, 0, named[Math.floor(at() * named.length)]?.name ?? `${name} Example`, "wrote");
          return said.join(" ");
        }),
      }));
      out.push({ machine: SCREEN_MACHINE, version: `gate-${day}-${s}`, start_ms, end_ms: start_ms + 300_000, frames });
    }
    return out;
  };
  const end_ms = Date.parse(`${END}T00:00:00Z`);
  const days = Array.from({ length: size.screen.days }, (_, at) => dayOf(end_ms - (size.screen.days - 1 - at) * DAY_MS));
  const source: ScreenSource = { segments: (machine, day) => (machine === SCREEN_MACHINE ? segmentsOf(day) : []) };
  const index = ScreenIndex.write(folder, file, { days: DAY, meaning: false }, () => true);
  let common_windows = 0, name_windows = 0;
  for (const [at, day] of days.entries()) {
    const segments = segmentsOf(day);
    hash.update(JSON.stringify(segments));
    const windows = new Map<string, { common: boolean; name: boolean }>();
    for (const segment of segments) {
      const frame = segment.frames[0]!;
      const seen = windows.get(frame.title!) ?? { common: false, name: false };
      for (const each of segment.frames) for (const line of each.lines) {
        if (line.split(" ").includes(common)) seen.common = true;
        if (line.split(" ").includes(name)) seen.name = true;
      }
      windows.set(frame.title!, seen);
    }
    common_windows += [...windows.values()].filter((each) => each.common).length;
    name_windows += [...windows.values()].filter((each) => each.name).length;
    index.apply(segments, source, { seq: at + 1 });
    if ((at + 1) % 91 === 0) log(`gate home: screen to ${day}`);
  }
  index.finish();
  index.close();
  return { from: days[0]!, to: days.at(-1)!, common, common_windows, name, name_windows };
}

const COVERED: Record<string, string> = { messages: SOURCES.whatsapp.id, mail: SOURCES.gmail.id, calls: SOURCES.calls.id, physical: SOURCES.location.id, money: SOURCES.bank.id };

function dayDocumentOf(day: Day, inputs: string): DayDocument {
  const window = dayBounds(day.day, DAY);
  const per_family = perFamily(day.atoms);
  return {
    day: day.day, zone: DAY.zone, day_start_hour: DAY.day_start_hour, window: { start_ms: window.start_ms, end_ms: window.end_ms }, renderer: RENDERER_VERSION, inputs,
    counts: { total: day.atoms.length, per_family },
    coverage: Object.keys(per_family).sort().map((family) => ({ family, sources: [{ source: COVERED[family]!, read: "through" as const }] })),
    atoms: day.atoms.map((atom) => dayAtomOf(atom, day.day, window)),
    facts: day.facts,
  };
}

function dayAtomOf(atom: AtomEntry, day: string, window: { start_ms: number; end_ms: number }): DayAtom {
  const clock = (ms: number) => {
    const iso = new Date(ms).toISOString();
    return iso.slice(0, 10) === day ? iso.slice(11, 16) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  };
  const end = atom.end_ms === null ? null : Math.min(atom.end_ms, window.end_ms);
  const flags: AtomFlag[] = [...(atom.dated === true ? ["date_only" as const] : []), ...(atom.end_ms !== null && atom.end_ms > window.end_ms ? ["continues_into_next_day" as const] : [])];
  return {
    n: atom.n, family: atom.family, unit: atom.unit, units: [atom.unit], start_ms: atom.start_ms, end_ms: end,
    local_start: atom.dated === true || atom.start_ms === null ? null : clock(atom.start_ms), local_end: atom.dated === true || end === null ? null : clock(end),
    flags, text: atom.text, ...(atom.names === undefined ? {} : { names: atom.names }), ...(atom.record === undefined ? {} : { record: atom.record }),
    ...(atom.family === "messages" && atom.title !== undefined
      ? { block: { key: atom.unit.slice("YYYY-MM-DD:".length), title: atom.title, ...(atom.title_names === undefined ? {} : { names: atom.title_names }) } } : {}),
  };
}

function perFamily(atoms: readonly AtomEntry[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const atom of atoms) out[atom.family] = (out[atom.family] ?? 0) + 1;
  return out;
}

function writePeople(folder: HomeFolder, machine: string, people: readonly Person[], chats: readonly Chat[]): void {
  const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const details = people.map((person): PersonDetail => {
    const handles = handlesOf(person);
    return {
      id: person.id, name: person.name, call_name: person.name.split(" ")[0]!, full_name: person.name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
      hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
      last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], also_called: [], joined: [], names_seen: [], record: null,
      handles: handles.map((id) => ({ id, kind: id.slice(0, id.indexOf(":")), network: null, words: id, from: null })),
    } satisfies Omit<Record<keyof PersonDetail, unknown>, "details" | "work"> as unknown as PersonDetail;
  });
  const searched = details.map((detail): Searched => ({
    id: detail.id, words: [...new Set(fold(detail.name).split(/[^\p{L}\p{N}]+/u).filter(Boolean))],
    values: detail.handles.map((handle) => fold(handle.id.slice(handle.id.indexOf(":") + 1))),
    phones: detail.handles.flatMap((handle) => (handle.kind === "phone" ? [handle.id.slice("phone:+".length)] : [])),
  }) as Searched);
  const rows = new Map<string, Map<string, JsonObject>>([
    ["answer", new Map([["list", { people: [], chats: chats.map((chat) => ({ key: chat.key, group: chat.group, label: chat.title })) } as unknown as JsonObject]])],
    ["person", new Map(details.map((each) => [each.id, { person: each } as unknown as JsonObject]))],
    ["alias", new Map(details.flatMap((each) => [each.id, ...each.handles.map((handle) => handle.id)].map((id) => [id, { id: each.id }] as [string, JsonObject])))],
    ["names", new Map([
      ["all", { people: searched } as unknown as JsonObject],
      ["table", { owner: null, people: people.map((person) => ({
        who: person.id, is: "human", shown: person.name, names: [person.name, ...person.name.split(" ")], accounts: [person.phone, ...(person.email === null ? [] : [person.email])],
      })) } as unknown as JsonObject],
    ])],
  ]);
  writePrepared(folder, preparedFileOf(preparedDirOf(folder.root, machine, "people"), "people"), PEOPLE, { rows, position: "1:1" });
}
