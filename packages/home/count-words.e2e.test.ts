import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { addDays, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, MESSAGES_COLLECTIONS, type DayFileFact } from "@lifestreamprotocol/families";
import { Refusal } from "./refusal.js";
import { SearchIndex, type AtomEntry, type RecordEntry } from "./search-index.js";
import { type CountContext, type PeopleMap, wordsBudget } from "./counting.js";
import { rowsCounted } from "./work.js";
import { countAsked, countOf, shown } from "./test/record-reads.js";
import { makeRef } from "./refs.js";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const MIN = 60_000;
const DAY_MS = 86_400_000;
const CHAT = "whatsapp:15550000001@s.whatsapp.net";
const SMALL_CHAT = "whatsapp:15550000002@s.whatsapp.net";
const SMALL_CHAT_REF = makeRef("chat", { key: SMALL_CHAT });
const OTHER_CHATS = Array.from({ length: 10 }, (_, i) => `whatsapp:1555000010${i}@s.whatsapp.net`);
const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MESSAGES_COLLECTIONS }));
const PEOPLE: PeopleMap = { version: "people-1", idOf: () => undefined, person: () => undefined, find: () => [] };
const dir = mkdtempSync(join(tmpdir(), "lifestream-count-words-"));
const opened: SearchIndex[] = [];
afterAll(() => {
  for (const index of opened) index.close();
  rmSync(dir, { recursive: true, force: true });
});

const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

class Home {
  readonly records: RecordEntry[] = [];
  readonly atoms = new Map<string, AtomEntry[]>();
  readonly facts = new Map<string, DayFileFact[]>();

  #fact(fact: DayFileFact, day = dayOf(fact.time_ms)): DayFileFact {
    this.facts.set(day, [...this.facts.get(day) ?? [], fact]);
    return fact;
  }

  message(key: string, at: number, text: string, placed: number | null = at, chat = CHAT, direction = "received"): DayFileFact {
    this.records.push({ record: { source: "wa:local:a", kind: "msg", key }, family: "messages", version: "v1", start_ms: placed, end_ms: null, title: "", text, who: [], link: null });
    return this.#fact({
      id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
      keys: { chat, direction, product: "whatsapp", searchable: "yes" }, measures: {}, who: [],
      from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
    });
  }

  call(key: string, start: number, end: number, text: string | null, placed: number | null = start, time = start, only?: readonly string[]): void {
    if (text !== null) this.records.push({ record: { source: "wa:local:a", kind: "call", key }, family: "calls", version: "v1", start_ms: placed, end_ms: null, title: "", text, who: [], link: null });
    const base = {
      id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: time, start_ms: start, end_ms: end,
      keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, who: [],
      from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
    } satisfies Omit<DayFileFact, "measures">;
    if (only === undefined || only.includes(dayOf(time))) this.#fact({ ...base, measures: { minutes: (end - start) / MIN } });
  }

  span(key: string, start: number, end: number): void {
    this.records.push({ record: { source: "wa:local:a", kind: "msg", key }, family: "messages", version: "v1", start_ms: start, end_ms: null, title: "", text: "a span", who: [], link: null });
    const base = {
      id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: start, start_ms: start, end_ms: end,
      keys: { chat: CHAT, direction: "received", product: "whatsapp", searchable: "no" }, measures: {}, who: [],
      from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
    } satisfies DayFileFact;
    this.#fact(base);
  }

  line(day: string, n: number, text: string, start_ms: number | null, facts: readonly DayFileFact[]): void {
    this.atoms.set(day, [...this.atoms.get(day) ?? [], { n, family: "messages", unit: `messages/line-${day}-${n}`, start_ms, end_ms: null, text }]);
    for (const fact of facts) fact.lines.push(n);
    if (!this.facts.has(day)) this.facts.set(day, []);
  }

  index(name: string): SearchIndex {
    const index = SearchIndex.write(openHomeFolder(dirname(join(dir, name, "index.db"))), join(dir, name, "index.db"), () => true, 0, SETTINGS);
    opened.push(index);
    index.records(this.records, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    for (const day of [...new Set([...this.facts.keys(), ...this.atoms.keys()])].sort()) {
      index.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: this.atoms.get(day) ?? [], facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts: this.facts.get(day) ?? [] } });
    }
    return index;
  }
}

const context = (words?: number, over: Partial<CountContext> = {}): CountContext => ({
  collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-12-30", "12:00"), people: () => PEOPLE,
  ...words === undefined ? {} : { budget: { words } }, ...over,
});

type Answer = { total: { n?: number; sum?: number | string }; rows: unknown[][]; columns: string[]; held?: string; population: Record<string, unknown> };
type Refused = { refused: string; message: string; fits?: { from: string; to: string } };

function daysHeld(index: SearchIndex, from: string, to: string): number {
  const db = new Database(index.file, { readonly: true });
  try {
    return db.prepare("SELECT count(*) FROM days WHERE day >= ? AND day <= ?").pluck().get(from, to) as number;
  } finally {
    db.close();
  }
}

function count(index: SearchIndex, params: Record<string, string>, ctx: CountContext): { answer?: Answer; refused?: Refused; rows: number } {
  const before = rowsCounted();
  try {
    const answer = shown(countOf(index, countAsked(params, COLLECTIONS), ctx)) as unknown as Answer;
    return { answer, rows: rowsCounted() - before };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const fits = (error.extra as { fits?: Refused["fits"] }).fits;
    return { refused: { refused: error.code, message: error.message, ...(fits === undefined ? {} : { fits }) }, rows: rowsCounted() - before };
  }
}
const n = (answer: Answer | undefined) => answer?.total.n;

function wordStatements(work: () => unknown): number {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as { all: (...args: unknown[]) => unknown };
  probe.close();
  const all = statement.all;
  let ran = 0;
  statement.all = function (this: Database.Statement, ...args: unknown[]) {
    if (/\bfts MATCH\b/u.test(this.source) && !/^EXPLAIN\b/u.test(this.source)) ran++;
    return all.apply(this, args);
  };
  try {
    work();
  } finally {
    statement.all = all;
  }
  return ran;
}

function oracle(index: SearchIndex, params: Record<string, string>): Answer {
  return shown(countOf(index, countAsked(params, COLLECTIONS), context(undefined, { budget: { fetch: Number.MAX_SAFE_INTEGER } }))) as unknown as Answer;
}

function chats(others: number): Home {
  const home = new Home();
  for (const [c, chat] of OTHER_CHATS.entries()) {
    for (let i = 0; i < others; i++) home.message(`w9o${c}x${i}`, D("2026-10-01") + Math.floor((i * 28 * DAY_MS) / others) + c * MIN, `lantern ${c} ${i}`, undefined, chat);
  }
  for (let i = 0; i < 40; i++) home.message(`w9s${i}`, D("2026-10-03", "09:00") + i * DAY_MS / 2, `lantern small ${i}`, undefined, SMALL_CHAT, "sent");
  const quiet = Array.from({ length: 40 }, (_, i) => home.message(`w9q${i}`, D("2026-10-03", "10:00") + i * DAY_MS / 2, `quiet ${i}`, undefined, SMALL_CHAT));
  quiet[7]!.keys.direction = "sent";
  home.line(dayOf(quiet[7]!.time_ms), 1, "a lantern summary", quiet[7]!.time_ms, [quiet[7]!]);
  return home;
}

describe("a count with words", () => {
  it("W1 a word with 5,000 hits reaches every fact through its record or a line that prints it, about two rows a hit, every statement a walk or a point (the meter checks each)", () => {
    const home = new Home();
    const expected = new Map<string, number>();
    const take = (fact: DayFileFact) => expected.set(dayOf(fact.time_ms), (expected.get(dayOf(fact.time_ms)) ?? 0) + 1);
    for (let i = 0; i < 7_000; i++) {
      const at = D("2026-10-01") + Math.floor((i * 20 * DAY_MS) / 7_000);
      const fact = home.message(`w1m${i}`, at, i % 7 < 5 ? `the lantern ${i}` : `another word ${i}`);
      if (i % 7 < 5) take(fact);
      if (i % 7 === 6 && i % 35 === 6) {
        home.line(dayOf(at), i, `lantern seen ${i}`, at, [fact]);
        take(fact);
      }
    }
    const index = home.index("w1");
    const hits = 5_000 + [...Array(7_000).keys()].filter((i) => i % 35 === 6).length;
    const { answer, rows } = count(index, { of: "messages", words: "lantern", by: "day" }, context());
    expect(n(answer)).toBe([...expected.values()].reduce((sum, each) => sum + each, 0));
    expect(Object.fromEntries(answer!.rows.map((row) => [row[0], row[1]]))).toEqual(Object.fromEntries([...expected].sort()));
    expect(rows).toBeGreaterThanOrEqual(2 * hits);
    expect(rows).toBeLessThanOrEqual(2 * hits + Math.ceil(hits / 256) + 2 + n(answer)! + 1 + 2 * 9);
  });

  it("W2 a call that began the day before the range is in its clock sum; a fact a line with no time prints is counted", () => {
    const home = new Home();
    home.call("w2a", D("2026-10-04", "23:40"), D("2026-10-05", "00:40"), "standup with the team");
    home.call("w2b", D("2026-10-05", "10:00"), D("2026-10-05", "10:15"), "lunch");
    home.call("w2c", D("2026-10-05", "14:00"), D("2026-10-05", "14:25"), null);
    home.call("w2d", D("2026-10-03", "09:00"), D("2026-10-03", "09:30"), "standup again");
    const index0 = home.index("w2-before");
    expect(count(index0, { of: "calls", measure: "minutes", op: "sum", words: "standup", from: "2026-10-05", to: "2026-10-05" }, context()).answer!.total).toMatchObject({ n: 1, sum: 40 });
    const fact = home.facts.get("2026-10-05")!.find((each) => each.id.endsWith("w2c"))!;
    home.line("2026-10-05", 1, "standup notes", null, [fact]);
    const index = home.index("w2");
    expect(count(index, { of: "calls", measure: "minutes", op: "sum", words: "standup", from: "2026-10-05", to: "2026-10-05" }, context()).answer!.total).toMatchObject({ n: 2, sum: 65 });
  });

  it("W3 at the range's start F: a point fact at F, a fact counted at its end at F, and one an entry with no time reaches are each counted", () => {
    const home = new Home();
    const F = D("2026-10-05");
    home.message("w3a", F, "beacon at the start");
    home.message("w3b", F - 1, "beacon just before");
    home.call("w3c", F - 60 * MIN, F, "beacon call", F - 60 * MIN, F);
    home.call("w3d", F, F + 5 * MIN, "beacon untimed", null);
    const index = home.index("w3");
    expect(n(count(index, { of: "messages", words: "beacon", from: "2026-10-05", to: "2026-10-05" }, context()).answer)).toBe(1);
    expect(n(count(index, { of: "calls", words: "beacon", from: "2026-10-05", to: "2026-10-05" }, context()).answer)).toBe(2);
    expect(n(count(index, { of: "calls", words: "beacon", from: "2026-10-05T00:00:00Z", to: "2026-10-05T00:10:00Z" }, context()).answer)).toBe(2);
  });

  it("W4 a word past its budget over ten months is TOO_BROAD, its fits the newest whole days its rows reach; asked over them, every number is the record's", () => {
    const home = new Home();
    const days: string[] = [];
    for (let day = "2026-01-01"; day <= "2026-10-27"; day = addDays(day, 1)) days.push(day);
    for (const [d, day] of days.entries()) for (let i = 0; i < 3; i++) home.message(`w4m${d}x${i}`, D(day, `0${3 * i + 1}:00`), `ember ${d} ${i}`);
    const index = home.index("w4");
    const asked = { of: "messages", words: "ember", from: "2026-01-01", to: "2026-10-27" };
    const broad = count(index, asked, context(600));
    expect(broad.refused).toMatchObject({ refused: "TOO_BROAD" });
    const fits = broad.refused!.fits!;
    expect(fits.to).toBe("2026-10-27");
    expect(fits.from > "2026-01-01").toBe(true);
    expect(broad.refused!.message).toContain(`from=${fits.from} to=${fits.to}`);
    const narrow = count(index, { ...asked, ...fits, by: "day", limit: "100" }, context(600));
    const inFits = days.filter((day) => day >= fits.from && day <= fits.to);
    expect(broad.rows).toBeLessThanOrEqual(600 + 3 * inFits.length + 20 + daysHeld(index, asked.from, asked.to));
    expect(n(narrow.answer)).toBe(3 * inFits.length);
    expect(narrow.answer!.rows.map((row) => [row[0], row[1]])).toEqual(inFits.map((day) => [day, 3]));
    expect(count(index, { ...asked, from: addDays(fits.from, -30) }, context(600)).refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(n(count(index, asked, context()).answer)).toBe(3 * days.length);
  });

  it("W5 one day past the budget names no range and says one day is too much; the untimed reach stopped names none either", () => {
    const home = new Home();
    for (let i = 0; i < 600; i++) home.message(`w5m${i}`, D("2026-10-20", "08:00") + i * 1_000, `spark ${i}`);
    home.message("w5early", D("2026-10-19", "08:00"), "spark early");
    for (let i = 0; i < 400; i++) home.message(`w5u${i}`, D("2026-10-10", "08:00") + i * 1_000, `drift ${i}`, null);
    const index = home.index("w5");
    for (const range of [{ from: "2026-10-20", to: "2026-10-20" }, { from: "2026-10-01", to: "2026-10-20" }]) {
      const day = count(index, { of: "messages", words: "spark", ...range }, context(600));
      expect(day.refused, JSON.stringify(range)).toMatchObject({ refused: "TOO_BROAD" });
      expect(day.refused!.fits).toBeUndefined();
      expect(day.refused!.message).toContain("not one day");
    }
    const untimed = count(index, { of: "messages", words: "drift", from: "2026-10-10", to: "2026-10-10" }, context(600));
    expect(untimed.refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(untimed.refused!.fits).toBeUndefined();
    expect(untimed.refused!.message).toContain("entries with no time");
    expect(n(count(index, { of: "messages", words: "spark", from: "2026-10-19", to: "2026-10-19" }, context(600)).answer)).toBe(1);
  });

  it("W6 the required words end and an excluded word's walk stops: TOO_BROAD, never a number", () => {
    const home = new Home();
    home.message("w6rare", D("2026-10-20", "09:00"), "rare comet");
    for (let i = 0; i < 400; i++) home.message(`w6c${i}`, D("2026-10-20", "10:00") + i * 1_000, `common comet ${i}`);
    const index = home.index("w6");
    expect(n(count(index, { of: "messages", words: "rare" }, context(600)).answer)).toBe(1);
    expect(count(index, { of: "messages", words: "rare -common" }, context(600)).refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(n(count(index, { of: "messages", words: "comet -common" }, context()).answer)).toBe(1);
  });

  it("W7 a word held only in December, asked over January to October: an empty count whose held is of the ask without the words, and says so", () => {
    const home = new Home();
    home.message("w7a", D("2026-01-15", "09:00"), "plain words");
    home.message("w7b", D("2026-06-15", "09:00"), "plain words");
    home.message("w7c", D("2026-12-05", "09:00"), "frost on the window");
    const index = home.index("w7");
    const { answer } = count(index, { of: "messages", words: "frost", from: "2026-01-01", to: "2026-10-31" }, context());
    expect(n(answer)).toBe(0);
    expect(answer!.held).toBe("messages 2026-01-15 → 2026-12-05, whatever the words; search the words for their own first and last day");
    expect(n(count(index, { of: "messages", words: "frost", from: "2026-12-01", to: "2026-12-31" }, context()).answer)).toBe(1);
  });

  it("W8 a line that states many facts charges each; the same ask at two sizes of home, the extra outside the window, reads the same rows", () => {
    const small = new Home();
    const printed = Array.from({ length: 30 }, (_, i) => small.message(`w8m${i}`, D("2026-10-10", "09:00") + i * MIN, `plain ${i}`));
    small.line("2026-10-10", 1, "a summary of the flare", D("2026-10-10", "09:00"), printed);
    for (let i = 0; i < 20; i++) small.message(`w8f${i}`, D("2026-10-12", "09:00") + i * MIN, `flare ${i}`);
    const large = new Home();
    const printedAgain = Array.from({ length: 30 }, (_, i) => large.message(`w8m${i}`, D("2026-10-10", "09:00") + i * MIN, `plain ${i}`));
    large.line("2026-10-10", 1, "a summary of the flare", D("2026-10-10", "09:00"), printedAgain);
    for (let i = 0; i < 20; i++) large.message(`w8f${i}`, D("2026-10-12", "09:00") + i * MIN, `flare ${i}`);
    for (let i = 0; i < 500; i++) large.message(`w8x${i}`, D("2026-03-01", "09:00") + i * MIN, `flare in march ${i}`);
    const [a, b] = [small.index("w8-small"), large.index("w8-large")];
    const line = count(a, { of: "messages", words: "summary", from: "2026-10-01", to: "2026-10-31" }, context());
    expect(n(line.answer)).toBe(30);
    expect(line.rows).toBe(3 + 1 + 30 + 30 + 5 + 2 + 2 * 2 + daysHeld(a, "2026-10-01", "2026-10-31"));
    const asked = { of: "messages", words: "flare", from: "2026-10-01", to: "2026-10-31" };
    const [left, right] = [count(a, asked, context()), count(b, asked, context())];
    expect([n(left.answer), n(right.answer)]).toEqual([50, 50]);
    expect(right.rows).toBe(left.rows);
  });

  it("W9 a word said in many chats, counted in one small chat, reads about the chat's matches: the same rows at two sizes of the other chats, the unbounded count's number", () => {
    const [a, b] = [chats(300).index("w9-small"), chats(1_200).index("w9-large")];
    const asked = { of: "messages", words: "lantern", chat: SMALL_CHAT_REF, from: "2026-10-01", to: "2026-10-31", by: "day", limit: "100" };
    const [left, right] = [count(a, asked, context()), count(b, asked, context())];
    expect([n(left.answer), n(right.answer)]).toEqual([41, 41]);
    const expected = oracle(a, { of: "messages", chat: SMALL_CHAT_REF, "match.direction": "sent", from: "2026-10-01", to: "2026-10-31", by: "day", limit: "100" });
    expect(n(left.answer)).toBe(n(expected));
    const days = (answer: Answer) => answer.rows.map((row) => [row[0], row[1]]);
    expect(days(left.answer!)).toEqual(days(expected));
    expect(days(right.answer!)).toEqual(days(expected));
    expect(left.rows).toBeLessThanOrEqual(2 * 41 + 2 + 2 + 41 + 6 + 16 + 3 + 1 + daysHeld(a, asked.from, asked.to));
    expect(right.rows).toBe(left.rows);
    const excluded = { ...asked, words: "lantern -small" };
    const [one, two] = [count(a, excluded, context()), count(b, excluded, context())];
    expect([n(one.answer), n(two.answer)]).toEqual([1, 1]);
    expect(two.rows).toBe(one.rows);
  });

  it("W10 a count of a word too common to count in one call names a chat among what to narrow by, and a chat brings it inside", () => {
    const index = chats(300).index("w10");
    const one = { of: "messages", words: "lantern", from: "2026-10-05", to: "2026-10-05" };
    const broad = count(index, one, context(60));
    expect(broad.refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(broad.refused!.fits).toBeUndefined();
    expect(broad.refused!.message).toContain("in one chat");
    const fitted = count(index, { of: "messages", words: "lantern", from: "2026-10-01", to: "2026-10-31" }, context(600));
    expect(fitted.refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(fitted.refused!.fits).toBeDefined();
    expect(fitted.refused!.message).toContain("in one chat");
    expect(n(count(index, { ...one, from: "2026-10-01", to: "2026-10-31", chat: SMALL_CHAT_REF }, context(600)).answer)).toBe(41);
    const inChat = count(index, { ...one, from: "2026-10-01", to: "2026-10-31", chat: SMALL_CHAT_REF }, context(20));
    expect(inChat.refused).toMatchObject({ refused: "TOO_BROAD" });
    expect(inChat.refused!.message).not.toContain("in one chat");
  });

  it("W11 past the fetch's rows: a clock sum reads only the facts that reach its range, crossing facts too, and its fits is answered when asked, as an avg's", () => {
    const home = new Home();
    const days: string[] = [];
    for (let day = "2026-07-01"; day <= "2026-10-10"; day = addDays(day, 1)) days.push(day);
    for (const [d, day] of days.entries()) for (let i = 0; i < 10; i++) home.call(`w11c${d}x${i}`, D(day, `${String(8 + i).padStart(2, "0")}:00`), D(day, `${String(8 + i).padStart(2, "0")}:15`), `standup ${d} ${i}`);
    home.call("w11in", D("2026-09-30", "23:30"), D("2026-10-01", "00:30"), "standup in");
    home.call("w11out", D("2026-10-10", "23:30"), D("2026-10-11", "00:30"), "standup out", D("2026-10-10", "23:30"), D("2026-10-11", "00:30"));
    const index = home.index("w11");
    const small = context(undefined, { budget: { fetch: 500 } });
    for (const op of ["sum", "avg"]) {
      for (const words of [{ words: "standup" }, {}]) {
        const said = JSON.stringify({ op, ...words });
        const ten = count(index, { of: "calls", measure: "minutes", op, from: "2026-10-01", to: "2026-10-10", ...words }, small);
        expect(ten.answer?.total, said).toMatchObject(op === "sum" ? { n: 102, sum: 1_560 } : { n: 100, avg: 15 });
        const asked = { of: "calls", measure: "minutes", op, from: "2026-09-01", to: "2026-10-10", ...words };
        const broad = count(index, asked, small);
        expect(broad.refused, said).toMatchObject({ refused: "TOO_BROAD" });
        expect(broad.refused!.message, said).toContain("from=");
        const fits = broad.refused!.fits!;
        expect(fits, said).toBeDefined();
        expect(fits.to).toBe("2026-10-10");
        expect(fits.from > "2026-09-01" && fits.from <= "2026-10-10", said).toBe(true);
        const narrow = count(index, { ...asked, ...fits }, small);
        const inside = 10 * days.filter((day) => day >= fits.from).length
          + (op === "sum" ? 1 + (fits.from <= "2026-10-01" ? 1 : 0) : fits.from <= "2026-09-30" ? 1 : 0);
        expect(narrow.answer?.total, said).toMatchObject({ n: inside });
        if (op === "sum") {
          const crossed = 30 + (fits.from <= "2026-09-30" ? 60 : fits.from <= "2026-10-01" ? 30 : 0);
          expect(narrow.answer?.total.sum, said).toBe(150 * days.filter((day) => day >= fits.from).length + crossed);
        }
      }
    }
  });

  it("W11d a clock sum takes a crossing fact's share on the days inside its range whose files state nothing of it", () => {
    const home = new Home();
    home.call("w11d", D("2026-09-30", "23:00"), D("2026-10-03", "12:00"), "long");
    home.message("w11d1", D("2026-10-01", "09:00"), "a day");
    home.message("w11d3", D("2026-10-03", "09:00"), "a day");
    const index = home.index("w11d");
    const asked = { of: "calls", measure: "minutes", op: "sum", from: "2026-10-01", to: "2026-10-03" };
    expect(count(index, asked, context()).answer?.total).toMatchObject({ n: 1, sum: 3_600 });
    expect(oracle(index, asked).total).toMatchObject({ n: 1, sum: 3_600 });
    expect(count(index, { ...asked, by: "day" }, context()).answer?.rows.map((row) => row.slice(0, 3))).toEqual([["2026-10-01", 1, 1_440], ["2026-10-02", 1, 1_440], ["2026-10-03", 1, 720]]);
  });

  it("W12 a walk of the words to its whole budget makes a statement of the word index for each eighth of it, whatever the budget, and its proof none", () => {
    const home = new Home();
    for (let i = 0; i < 12_000; i++) home.message(`w12m${i}`, D("2026-10-01") + Math.floor((i * 20 * DAY_MS) / 12_000), `the lantern ${i}`);
    const index = home.index("w12");
    const asked = { of: "messages", words: "lantern", from: "2026-10-01", to: "2026-10-20" };
    for (const budget of [4_000, 20_000]) {
      let refused: Refused | undefined;
      const ran = wordStatements(() => {
        refused = count(index, asked, context(budget)).refused;
      });
      expect(refused, String(budget)).toMatchObject({ refused: "TOO_BROAD" });
      expect(ran, String(budget)).toBeLessThanOrEqual(4);
    }
    let whole: Answer | undefined;
    const ran = wordStatements(() => {
      whole = count(index, asked, context(30_000)).answer;
    });
    expect(n(whole)).toBe(12_000);
    expect(ran).toBeLessThanOrEqual(4);
  });

  it("W13 a reader that hides walks half the plain reader's budget of the words; a budget asked is kept", () => {
    const plain = wordsBudget({} as CountContext, false);
    expect(plain).toBe(100_000);
    expect(wordsBudget({} as CountContext, true)).toBe(plain / 2);
    expect(wordsBudget({ budget: { words: 40 } } as CountContext, true)).toBe(40);
  });

  it("W14 a first with words past their budget walks them from the oldest: its fits starts at the range's start, and asked over them the first is the record's", () => {
    const home = new Home();
    const days: string[] = [];
    for (let day = "2026-10-01"; day <= "2026-10-12"; day = addDays(day, 1)) days.push(day);
    for (const [d, day] of days.entries()) for (let i = 0; i < 3; i++) home.call(`w14c${d}x${i}`, D(day, `0${3 * i + 1}:00`), D(day, `0${3 * i + 1}:20`), `ember call ${d} ${i}`);
    const index = home.index("w14");
    const asked = { of: "calls", measure: "minutes", op: "first", words: "ember", from: "2026-10-01", to: "2026-10-12" };
    expect(JSON.stringify(count(index, asked, context()).answer!.total)).toContain("2026-10-01");
    const broad = count(index, asked, context(60));
    expect(broad.refused).toMatchObject({ refused: "TOO_BROAD" });
    const fits = broad.refused!.fits!;
    expect(fits, broad.refused!.message).toBeDefined();
    expect(fits.from).toBe("2026-10-01");
    expect(fits.to < "2026-10-12").toBe(true);
    expect(broad.refused!.message).toContain(`from=${fits.from} to=${fits.to}, then the days after it`);
    const narrow = count(index, { ...asked, ...fits }, context(60));
    expect(JSON.stringify(narrow.answer?.total), narrow.refused?.message).toContain("2026-10-01");
  });

  it("W15 a costly match at the edge of fits: every fits a count names answers when asked again at the same budget", () => {
    const home = new Home();
    const cheap = (key: string, at: number) => home.records.push({ record: { source: "notes:local:a", kind: "note", key }, family: "notes", version: "v1", start_ms: at, end_ms: null, title: "", text: `ember ${key}`, who: [], link: null });
    const printing = (day: string, time: string, facts: number) => {
      const at = D(day, time);
      home.line(day, 1, "ember summary", at, Array.from({ length: facts }, (_, i) => home.message(`w15${day}x${i}`, at, `plain ${i}`)));
    };
    cheap("w15last", D("2026-10-20", "06:00"));
    for (let i = 0; i < 255; i++) cheap(`w15a${i}`, D("2026-10-19", "23:00") - i * 1_000);
    printing("2026-10-19", "12:00", 1_490);
    for (let i = 0; i < 243; i++) cheap(`w15b${i}`, D("2026-10-19", "06:00") - i * 1_000);
    printing("2026-10-18", "12:00", 20);
    const index = home.index("w15");
    const asked = { of: "messages", words: "ember", from: "2026-10-01", to: "2026-10-20T12:00:00Z" };
    let named = 0;
    for (let budget = 1_900; budget <= 2_100; budget += 20) {
      const broad = count(index, asked, context(budget));
      const fits = broad.refused?.fits;
      if (fits === undefined) continue;
      named++;
      const again = count(index, { ...asked, ...fits }, context(budget));
      expect(again.refused, `${budget}: ${JSON.stringify(fits)}`).toBeUndefined();
      expect(n(again.answer)).toBe((fits.from <= "2026-10-18" ? 20 : 0) + (fits.to >= "2026-10-19" ? 1_490 : 0));
    }
    expect(named).toBeGreaterThan(0);
  });
});
