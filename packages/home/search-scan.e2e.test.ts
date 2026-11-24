import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, civilDay, dayBounds, scratchFolder, type DaySettings, type RecordRef } from "@lifestreamprotocol/core";
import type { DayFileFact } from "@lifestreamprotocol/families";
import { COUNT_SCAN, EDGE_ROWS, GROUP_ROWS, HIT_ROWS, PAGE_ROWS, SCAN, wholeOf } from "./search-scan.js";
import type { Grouped, Hit, SearchQuery } from "./record-search.js";
import { SearchIndex, type RecordEntry, type SearchCursor } from "./search-index.js";
import { termsOf } from "./search-words.js";
import { reached } from "./counting.js";
import { placeStretches, presenceOver, type PresenceTables } from "./presence.js";
import { rowsCounted, Work } from "./work.js";
import { exactTerms, searchOf } from "./test/record-reads.js";


const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-scan-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
function fresh(name: string, clock: DaySettings = UTC, load?: (index: SearchIndex) => void): { index: SearchIndex; file: string } {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(scratchFolder(dirname(file)), file, () => true, 0, clock);
  if (load !== undefined) load(built);
  else built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return { index: SearchIndex.write(scratchFolder(dirname(file)), file, () => true, 0, clock), file };
}
const put = (index: SearchIndex, puts: RecordEntry[]) => index.records(puts, [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
const record = (key: string, family: string, words: string, start_ms: number | null, source = "notes:local:mac-0001"): RecordEntry => ({
  record: { source, kind: "item", key }, family, version: `v-${key}`, start_ms, end_ms: null, title: "", text: words, who: [], link: null,
});
const keyOf = (hit: Hit) => (hit.ref as RecordRef).key;

function measured(index: SearchIndex, query: Partial<SearchQuery> & { q?: string }) {
  const { q, ...rest } = query;
  const asked: SearchQuery = { order: q === undefined ? "newest" : "relevance", limit: 20, ...(q === undefined ? {} : { terms: termsOf(q) }), ...rest };
  const before = rowsCounted();
  const answer = searchOf(index, asked);
  if (!("hits" in answer)) throw new Error("a search of hits answered groups");
  return { answer, rows: rowsCounted() - before };
}

function walked(work: () => void): Set<string> {
  const walk = Work.prototype.walk;
  const seen = new Set<string>();
  Work.prototype.walk = function (this: Work, statement, params, limit) {
    seen.add(statement.source);
    return walk.call(this, statement, params, limit);
  } as typeof walk;
  try {
    work();
  } finally {
    Work.prototype.walk = walk;
  }
  return seen;
}

function every(index: SearchIndex, query: Partial<SearchQuery> & { q?: string }, pages?: number) {
  const most = pages ?? 2_000;
  const hits: Hit[] = [];
  const answers: ReturnType<typeof measured>[] = [];
  let after: SearchCursor | undefined;
  for (let page = 0; page < most; page++) {
    const one = measured(index, { ...query, ...(after === undefined ? {} : { after }) });
    expect(one.rows).toBeLessThanOrEqual(PAGE_ROWS);
    answers.push(one);
    hits.push(...one.answer.hits);
    if (one.answer.next === undefined) return { hits, pages: answers };
    after = one.answer.next;
  }
  if (pages !== undefined) return { hits, pages: answers };
  throw new Error(`more than ${most} pages`);
}


const LUNCH = 30_000;
const LUNCH_NEWEST = D("2026-04-11", "12:00");
const lunchAt = (k: number) => LUNCH_NEWEST - Math.ceil(k / 2) * MINUTE;
const STORM_DAY = "2026-03-10";
const TEAPOTS = 160;
let big: { index: SearchIndex; file: string };

beforeAll(() => {
  const puts: RecordEntry[] = [];
  for (let k = LUNCH - 1; k >= 0; k--) puts.push(record(`lunch-${k}`, "messages", `lunch with the team ${k}`, lunchAt(k), "wa:local:mac-0001"));
  for (let i = 0; i < 15_000; i++) puts.push(record(`storm-${i}`, "notes", `storm warning ${i}`, D(STORM_DAY) + 2_000 + i * 5_000));
  for (let i = 0; i < 50; i++) puts.push(record(`ping-m-${i}`, "messages", `ping reply ${i}`, D("2026-05-01") + i * 3_600_000, "wa:local:mac-0001"));
  for (let i = 0; i < 30_000; i++) puts.push(record(`ping-n-${i}`, "notes", `ping note ${i}`, D("2026-05-10") + i * 30_000));
  for (let i = 0; i < 3; i++) puts.push(record(`dawn-t-${i}`, "notes", `dawn chorus ${i}`, D("2026-02-01") + i * MINUTE));
  for (let i = 0; i < 3; i++) puts.push(record(`dawn-u-${i}`, "notes", `dawn chorus untimed ${i}`, null));
  for (let i = 0; i < 3; i++) puts.push(record(`zebra-${i}`, "notes", `zebra stripes ${i}`, D("2026-01-15") + i * MINUTE));
  for (let i = 0; i < 1_200; i++) puts.push(record(`quokka-n-${i}`, "notes", `quokka seen ${i}`, D("2026-01-20") + i * MINUTE));
  puts.push(record("quokka-m", "messages", "quokka at the zoo", D("2026-01-10"), "wa:local:mac-0001"));
  for (let i = 0; i < 250; i++) puts.push(record("heron", "notes", "heron sighting by the pond", D("2026-01-05"), `notes:local:mac-${String(i).padStart(4, "0")}`));
  for (let i = 0; i < TEAPOTS; i++) {
    for (let c = 0; c < 200; c++) puts.push(record(`teapot-${i}`, "notes", "teapot whistle", D("2026-01-03") + i * MINUTE, `notes:local:mac-${String(c).padStart(4, "0")}`));
  }
  big = fresh("big", UTC, (index) => {
    put(index, puts);
  });
});

describe("C1 a chat is a term of the match", () => {
  const X = "whatsapp:15550000001@s.whatsapp.net";
  const chatOf = (n: number) => `whatsapp:155500${String(n).padStart(5, "0")}@s.whatsapp.net`;
  const ASKED = "2026-06-15";
  const message = (key: string, at: number, chat: string): DayFileFact => ({
    id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
    keys: { chat, direction: "received" }, measures: {}, who: [{ handle: "+15550000001", role: "sender" }],
    from: { units: [`messages/${key}`], record: { source: "wa:local:mac-0001", kind: "msg", key }, alone: true }, lines: [],
  });
  function chats(name: string, perDay: number): SearchIndex {
    const byDay = new Map<string, { entries: RecordEntry[]; facts: DayFileFact[] }>();
    const add = (key: string, at: number, chat: string, words: string) => {
      const day = civilDay(at, UTC);
      const held = byDay.get(day) ?? { entries: [], facts: [] };
      held.entries.push({ record: { source: "wa:local:mac-0001", kind: "msg", key }, family: "messages", version: `v-${key}`, start_ms: at, end_ms: null, title: "", text: words, who: [], link: null });
      held.facts.push(message(key, at, chat));
      byDay.set(day, held);
    };
    for (let d = 0; d < 100; d++) {
      const day = addDays("2026-06-01", d);
      const count = day === ASKED ? 20 : perDay;
      for (let i = 0; i < count; i++) add(`x-${day}-${i}`, D(day, "08:00") + i * MINUTE, X, i % 5 < 2 ? `tea at four ${i}` : `see you ${i}`);
    }
    for (let c = 2; c <= 50; c++) for (let i = 0; i < 40; i++) {
      const day = addDays("2026-06-01", (c * 7 + i) % 100);
      add(`o-${c}-${i}`, D(day, "12:00") + i * MINUTE + c, chatOf(c), `tea or coffee ${c} ${i}`);
    }
    const { index } = fresh(name, UTC, (built) => {
      put(built, [...byDay.values()].flatMap(({ entries }) => entries));
      built.putDays([...byDay].map(([day, { facts }]) => ({
        day, indexed: { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts } },
      })));
    });
    return index;
  }
  const ask = { terms: exactTerms("tea"), chats: [X], from_ms: D(ASKED), to_ms: D(ASKED) + DAY_MS, order: "newest" as const, limit: 20 };

  it("reads the day's matches of the chat and the page's lookups, the same rows at 2,000 messages and at 20,000", () => {
    const small = measured(chats("chat-small", 20), ask);
    const large = measured(chats("chat-large", 200), ask);
    const expected = Array.from({ length: 20 }, (_, i) => i).filter((i) => i % 5 < 2).map((i) => `x-${ASKED}-${i}`).reverse();
    expect(small.answer.hits.map(keyOf)).toEqual(expected);
    expect(large.answer.hits.map(keyOf)).toEqual(expected);
    expect(small.answer).toMatchObject({ total: 8, capped: false });
    expect(large.rows).toBe(small.rows);
    expect(small.rows).toBeLessThanOrEqual(9 + 8 * 6 + 10);
  });
});

describe("C2 a word in 30,000 entries", () => {
  it("reads at most its budget, counts the newest 10,000 and says how far, in both orders that read newest first", () => {
    for (const order of ["newest", "relevance"] as const) {
      const { answer, rows } = measured(big.index, { q: "lunch", order });
      expect(rows).toBeLessThanOrEqual(PAGE_ROWS);
      expect(answer).toMatchObject({ total: 10_000, capped: true, reached: { side: "newest" } });
      expect(Date.parse(answer.reached!.at!)).toBe(lunchAt(9_999));
    }
  });

  it("goes on by its later pages, newest first, nothing skipped or repeated", () => {
    const first = measured(big.index, { q: "lunch", order: "newest", limit: 20 });
    expect(first.answer.hits.map(keyOf)).toEqual(Array.from({ length: 20 }, (_, k) => `lunch-${k}`));
    const second = measured(big.index, { q: "lunch", order: "newest", limit: 20, after: first.answer.next! });
    expect(second.answer.hits.map(keyOf)).toEqual(Array.from({ length: 20 }, (_, k) => `lunch-${k + 20}`));
    expect(second.answer.total).toBeUndefined();
  });
});

describe("C3 15,000 matches on one civil day", () => {
  it("is reached inside the day, and every day after it is whole; read from the oldest, every day before it", () => {
    const newest = measured(big.index, { q: "storm", order: "newest" }).answer;
    expect(newest).toMatchObject({ total: 10_000, capped: true, reached: { side: "newest", whole: addDays(STORM_DAY, 1) } });
    const at = Date.parse(newest.reached!.at!);
    expect(at).toBeGreaterThanOrEqual(D(STORM_DAY));
    expect(at).toBeLessThan(D(STORM_DAY) + DAY_MS);
    const oldest = measured(big.index, { q: "storm", order: "oldest" }).answer;
    expect(oldest).toMatchObject({ total: 10_000, capped: true, reached: { side: "oldest", whole: addDays(STORM_DAY, -1) } });
  });
});

describe("C4 whole days", () => {
  const UNTIMED = -Number.MAX_SAFE_INTEGER;
  function entries(settings: DaySettings): { slot: number; day: string | null; last: boolean }[] {
    const taken = new Map<number, number>();
    const slot = (ms: number) => {
      const n = taken.get(ms) ?? 0;
      taken.set(ms, n + 1);
      return ms * 1000 + n;
    };
    const out: { slot: number; day: string | null; last: boolean }[] = [];
    for (let d = -1; d < 6; d++) {
      const day = addDays("2026-03-01", d);
      const civilStart = dayBounds(day, settings);
      for (const ms of [civilStart.start_ms, civilStart.start_ms + MINUTE, civilStart.start_ms + 12 * 3_600_000, civilStart.end_ms - MINUTE]) {
        out.push({ slot: slot(ms), day: civilDay(ms, settings), last: false });
      }
    }
    for (let d = -1; d < 6; d++) {
      const day = addDays("2026-03-01", d);
      out.push({ slot: slot(dayBounds(day, settings).start_ms), day, last: false });
    }
    for (let n = 0; n < 3; n++) out.push({ slot: UNTIMED + n, day: null, last: false });
    const lastOf = new Map<string, number>();
    for (const each of out) if (each.day !== null) lastOf.set(each.day, Math.max(lastOf.get(each.day) ?? -Infinity, each.slot));
    return out.map((each) => ({ ...each, last: each.day !== null && lastOf.get(each.day) === each.slot })).sort((left, right) => left.slot - right.slot);
  }
  const inner = (day: string) => day >= "2026-03-01" && day <= "2026-03-05";
  for (const settings of [{ zone: "UTC", day_start_hour: 4 }, { zone: "Asia/Kolkata", day_start_hour: 4 }]) {
    it(`newest: every day from whole was read whole, and the day before it was not (${settings.zone}, 04:00)`, () => {
      const all = entries(settings);
      for (const [at, stop] of all.entries()) {
        const visited = new Set(all.slice(at).map((each) => each.slot));
        const timed = all.slice(at).find((each) => each.day !== null);
        const whole = wholeOf("newest", stop.slot, settings, {}, timed?.day ?? undefined);
        const latest = all.filter((each) => each.day !== null && !visited.has(each.slot)).map((each) => each.day!).sort().at(-1);
        if (latest === undefined) {
          expect(whole).not.toBeNull();
          continue;
        }
        expect(whole! > latest).toBe(true);
        if (inner(addDays(latest, 1))) expect(whole).toBe(addDays(latest, 1));
      }
    });

    it(`oldest: every day up to whole was read whole; the day after it was not, unless the stop is a day's last entry (${settings.zone}, 04:00)`, () => {
      const all = entries(settings);
      for (const [at, stop] of all.entries()) {
        const visited = new Set(all.slice(0, at + 1).map((each) => each.slot));
        const whole = wholeOf("oldest", stop.slot, settings, {});
        if (stop.day === null) {
          expect(whole).toBeNull();
          continue;
        }
        const earliest = all.filter((each) => each.day !== null && !visited.has(each.slot)).map((each) => each.day!).sort()[0];
        if (earliest === undefined) continue;
        expect(whole! < earliest).toBe(true);
        if (inner(addDays(earliest, -1))) expect([addDays(earliest, -1), ...(stop.last ? [addDays(earliest, -2)] : [])]).toContain(whole);
      }
    });
  }

  it("stopped among the entries with no time: newest, every day whole; oldest, none", () => {
    expect(wholeOf("newest", UNTIMED + 1, UTC, { first: "2026-03-01" })).toBe("2026-03-01");
    expect(wholeOf("newest", UNTIMED + 1, UTC, {}, "2026-02-27")).toBe("2026-02-27");
    expect(wholeOf("oldest", UNTIMED + 1, UTC, {})).toBeNull();
  });

  it("names no day outside the range asked", () => {
    expect(wholeOf("newest", D("2026-03-10", "12:00") * 1000, UTC, { last: "2026-03-10" })).toBeNull();
    expect(wholeOf("oldest", D("2026-03-10", "12:00") * 1000, UTC, { first: "2026-03-10" })).toBeNull();
  });
});

describe("C5 a common family tested per row", () => {
  it("relevance: the newest matches all of another family, the scan ends out with no hit, and next finds every match once", () => {
    const first = measured(big.index, { q: "ping", families: ["messages"] });
    expect(first.rows).toBeLessThanOrEqual(PAGE_ROWS);
    expect(first.answer).toMatchObject({ hits: [], total: 0, capped: true });
    expect(first.answer.next).toBeDefined();
    const { hits, pages } = every(big.index, { q: "ping", families: ["messages"] });
    expect(hits.map(keyOf).sort()).toEqual(Array.from({ length: 50 }, (_, i) => `ping-m-${i}`).sort());
    expect(pages.slice(1).some((page) => page.answer.continues === true)).toBe(true);
  });

  it("the default order: the same, next a scan cursor, every match once, newest first", () => {
    const query = { families: ["messages"], from_ms: D("2026-05-01"), to_ms: D("2026-05-21") };
    const first = measured(big.index, query);
    expect(first.answer).toMatchObject({ hits: [], total: 0, capped: true });
    const { hits } = every(big.index, query);
    expect(hits.map(keyOf)).toEqual(Array.from({ length: 50 }, (_, i) => `ping-m-${49 - i}`));
  });
});

describe("C6 a cursor is a slot", () => {
  it("two entries of one instant split by a page: the next page finds the second once, in both orders", () => {
    const newest = every(big.index, { q: "lunch", order: "newest", limit: 1 }, 5).hits;
    expect(newest.map(keyOf)).toEqual(["lunch-0", "lunch-1", "lunch-2", "lunch-3", "lunch-4"]);
  });

  it("the scan's stop shares its instant with an entry not visited: the scan cursor finds it once", () => {
    const seen = new Map<string, number>();
    let after: SearchCursor | undefined;
    let scans = 0;
    for (let page = 0; page < 1_000 && scans < 3 && (page === 0 || after !== undefined); page++) {
      const { answer } = measured(big.index, { q: "lunch", limit: 50, ...(after === undefined ? {} : { after }) });
      for (const hit of answer.hits) seen.set(keyOf(hit), (seen.get(keyOf(hit)) ?? 0) + 1);
      if (page === 0 || answer.continues === true) scans++;
      after = answer.next;
    }
    expect(seen.get("lunch-9999")).toBe(1);
    expect(seen.get("lunch-10000")).toBe(1);
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("next passes through the entries with no time", () => {
    const { hits } = every(big.index, { q: "dawn", order: "newest", limit: 2 });
    expect(hits.map(keyOf)).toEqual(["dawn-t-2", "dawn-t-1", "dawn-t-0", "dawn-u-2", "dawn-u-1", "dawn-u-0"]);
  });
});

describe("C7 oldest", () => {
  it("limit 1 reads the oldest rows, never the newest", () => {
    const { answer, rows } = measured(big.index, { q: "lunch", order: "oldest", limit: 1 });
    expect(rows).toBeLessThanOrEqual(PAGE_ROWS);
    expect(answer.hits.map(keyOf)).toEqual([`lunch-${LUNCH - 1}`]);
    expect(answer).toMatchObject({ total: 10_000, capped: true, reached: { side: "oldest" } });
    expect(Date.parse(answer.reached!.at!)).toBe(lunchAt(LUNCH - 10_000));
  });
});

describe("C8 a hit's own lists", () => {
  it("a hit of more copies than HIT_ROWS is made from its first rows and says more", () => {
    const { answer } = measured(big.index, { q: "heron" });
    const [hit] = answer.hits;
    expect(hit).toMatchObject({ layer: "records", more: true, ref: { kind: "item", key: "heron" } });
  });

  it("a hit whose rows are not left ends the page before it, and next opens it", () => {
    const { hits, pages } = every(big.index, { q: "teapot", order: "newest", limit: TEAPOTS });
    expect(pages[0]!.answer.hits.length).toBeLessThan(TEAPOTS);
    expect(pages[0]!.answer.next).toBeDefined();
    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(hits.map(keyOf)).size).toBe(TEAPOTS);
    expect(hits).toHaveLength(TEAPOTS);
  });
});

describe("C9 near spellings", () => {
  it("typed words that fill the scan are joined by none", () => {
    const filled = measured(big.index, { q: "lunch OR zebrq" }).answer;
    expect(filled.capped).toBe(true);
    expect(filled.variants).toBeUndefined();
    expect(filled.hits.some((hit) => keyOf(hit).startsWith("zebra"))).toBe(false);
    const rare = measured(big.index, { q: "zebrq" }).answer;
    expect(rare.variants).toEqual({ zebrq: ["zebra"] });
  });

  it("a spelling is named only when its walk of 1,000 rows finds an entry the filters keep", () => {
    expect(measured(big.index, { q: "quokkx" }).answer.variants).toEqual({ quokkx: ["quokka"] });
    const { answer, rows } = measured(big.index, { q: "quokkx", families: ["messages"] });
    expect(answer.variants).toBeUndefined();
    expect(rows).toBeLessThanOrEqual(PAGE_ROWS);
  });
});


const TIDES = 150_000;
const TIDE_FROM = D("2025-01-01", "00:03") + 30_000;
const tideAt = (i: number) => TIDE_FROM + i * 7 * MINUTE;
const MONTH_FIRSTS = Array.from({ length: 24 }, (_, m) => `${2025 + Math.floor(m / 12)}-${String((m % 12) + 1).padStart(2, "0")}-01`);
let tides: SearchIndex;
const FOUR: DaySettings = { zone: "UTC", day_start_hour: 4 };

const tideEntries = (): { ms: number; dated: boolean; spring: boolean }[] => [
  ...Array.from({ length: TIDES }, (_, i) => ({ ms: tideAt(i), dated: false, spring: i % 30 === 0 })),
  ...MONTH_FIRSTS.map((day) => ({ ms: dayBounds(day, FOUR).start_ms, dated: true, spring: false })),
].sort((left, right) => left.ms - right.ms);

function counted(index: SearchIndex, query: Partial<SearchQuery> & { q: string }) {
  const { q, ...rest } = query;
  const before = rowsCounted();
  const answer = searchOf(index, { order: "newest", limit: 1, terms: termsOf(q), ...rest });
  if (!("groups" in answer)) throw new Error("a count by group answered hits");
  return { answer, rows: rowsCounted() - before };
}
function byMonth(entries: readonly { ms: number }[], settings: DaySettings): Map<string, number> {
  const months = new Map<string, number>();
  for (const { ms } of entries) {
    const month = civilDay(ms, settings).slice(0, 7);
    months.set(month, (months.get(month) ?? 0) + 1);
  }
  return months;
}
const groupOf = (groups: readonly Grouped[], key: string) => groups.find((each) => each.key === key);

describe("counts by group", () => {
  beforeAll(() => {
    const puts: RecordEntry[] = [];
    for (let i = 0; i < TIDES; i++) puts.push(record(`tide-${i}`, "notes", `tide ${i}${i % 30 === 0 ? " spring" : ""}`, tideAt(i)));
    for (const day of MONTH_FIRSTS) puts.push({ ...record(`tide-${day}`, "notes", `tide dated ${day}`, D(day)), dated: true });
    tides = fresh("tides", FOUR, (index) => {
      for (let at = 0; at < puts.length; at += 10_000) put(index, puts.slice(at, at + 10_000));
    }).index;
  });

  it("C11 by month over 150,000 matches answers the newest 100,000, capped, the month it stopped in partial and short, the months after it exact", () => {
    const { answer, rows } = counted(tides, { q: "tide", group: "month" });
    expect(rows).toBeLessThanOrEqual(GROUP_ROWS);
    expect(answer).toMatchObject({ total: COUNT_SCAN, capped: true, reached: { side: "newest" } });
    const all = tideEntries();
    const stop = all[all.length - COUNT_SCAN]!;
    expect(Date.parse(answer.reached!.at!)).toBe(Math.floor(stop.ms / MINUTE) * MINUTE);
    const month = civilDay(stop.ms, FOUR).slice(0, 7);
    const truth = byMonth(all, FOUR);
    expect(groupOf(answer.groups, month)).toMatchObject({ partial: true });
    expect(groupOf(answer.groups, month)!.n).toBeLessThan(truth.get(month)!);
    for (const group of answer.groups) {
      if ((group.key as string) <= month) continue;
      expect(group, group.key as string).toEqual({ key: group.key, n: truth.get(group.key as string) });
    }
    expect(answer.groups.map((each) => each.key)).toEqual([...truth.keys()].filter((key) => key >= month));
    expect(answer.groups.reduce((sum, each) => sum + each.n, 0)).toBe(COUNT_SCAN);
  });

  it("C12 an entry with only a date at a month's edge, the day starting at 04:00: one instant cuts the days, the month before partial, the month of the date exact", () => {
    const four = FOUR;
    const all = tideEntries();
    const target = all.findIndex((each) => !each.dated && each.ms > D("2025-03-01", "00:30"));
    expect(all[target]!.ms).toBeLessThan(D("2025-03-01", "04:00"));
    const to_ms = all[target + COUNT_SCAN]!.ms;
    expect(MONTH_FIRSTS).not.toContain(new Date(to_ms).toISOString().slice(0, 10));
    const { answer, rows } = counted(tides, { q: "tide", group: "month", to_ms });
    expect(rows).toBeLessThanOrEqual(GROUP_ROWS);
    expect(answer).toMatchObject({ total: COUNT_SCAN, capped: true, reached: { side: "newest", whole: "2025-03-01" } });
    expect(Date.parse(answer.reached!.at!)).toBe(Math.floor(all[target]!.ms / MINUTE) * MINUTE);
    const truth = byMonth(all.filter((each) => each.ms < to_ms), four);
    expect(groupOf(answer.groups, "2025-02"), "2025-02").toMatchObject({ partial: true });
    expect(groupOf(answer.groups, "2025-02")!.n).toBeLessThan(truth.get("2025-02")!);
    for (const group of answer.groups.filter((each) => (each.key as string) >= "2025-03")) {
      expect(group, group.key as string).toEqual({ key: group.key, n: truth.get(group.key as string) });
    }
  });

  it("C13 by month over 5,000 matches is the exact answer, nothing partial", () => {
    const { answer, rows } = counted(tides, { q: "spring", group: "month" });
    expect(rows).toBeLessThanOrEqual(GROUP_ROWS);
    expect(answer).toMatchObject({ total: 5_000, capped: false });
    expect(answer.reached).toBeUndefined();
    const truth = byMonth(tideEntries().filter((each) => each.spring), FOUR);
    expect(answer.groups).toEqual([...truth].map(([key, n]) => ({ key, n })));
    const pairs = counted(tides, { q: "spring", group: ["month", "family"] }).answer;
    expect(pairs.groups).toEqual([...truth].map(([key, n]) => ({ key: [key, "notes"], n })));
  });

  it("C17 search_people's elsewhere (counting.ts `reached`): the words of a name in over 100,000 entries say their count is capped", () => {
    const all = tideEntries();
    const looked = (word: string) => tides.snapshot({}, (read) => reached(read, { words: [{ phrases: [word], negated: false }], to_ms: Date.parse("2100-01-01") }, ["notes"], []));
    const tide = looked("tide");
    expect(tide).toMatchObject([{ family: "notes", n: COUNT_SCAN, capped: true, last: civilDay(all.at(-1)!.ms, FOUR) }]);
    expect(tide !== "unread" && tide[0]!.first! >= civilDay(all[0]!.ms, FOUR)).toBe(true);
    expect(looked("spring")).toEqual([{ family: "notes", n: 5_000, capped: false, first: "2024-12-31", last: civilDay(tideAt(TIDES - 30), FOUR) }]);
  });
});

describe("C14 a facet by time of a capped scan", () => {
  it("marks the day and the month it stopped in partial; an uncapped scan marks none", () => {
    const { answer } = measured(big.index, { q: "storm", order: "newest", facets: ["day", "month"] });
    expect(answer.capped).toBe(true);
    expect(answer.facets!.day).toEqual([{ key: STORM_DAY, n: 10_000, partial: true }]);
    expect(answer.facets!.month).toEqual([{ key: STORM_DAY.slice(0, 7), n: 10_000, partial: true }]);
    const whole = measured(big.index, { q: "zebra", order: "newest", facets: ["day"] }).answer;
    expect(whole.facets!.day).toEqual([{ key: "2026-01-15", n: 3 }]);
  });
});

describe("C15 held", () => {
  const june = { from_ms: D("2026-06-01"), to_ms: D("2026-06-02") };
  it("says the first and last day of what the words match at any time, by two walks of one kept row", () => {
    const { answer, rows } = measured(big.index, { q: "quokka", ...june });
    expect(answer).toMatchObject({ hits: [], total: 0, held: { first: "2026-01-10", last: "2026-01-20" } });
    expect(rows).toBeLessThanOrEqual(2 * EDGE_ROWS + 64);
  });

  it("reads at most 1,000 rows a walk, and a walk that stops first leaves it unsaid", () => {
    const { answer, rows } = measured(big.index, { q: "quokka", families: ["messages"], ...june });
    expect(answer).toMatchObject({ hits: [], total: 0 });
    expect(answer.held).toBeUndefined();
    expect(rows).toBeLessThanOrEqual(2 * EDGE_ROWS + 64);
  });
});

describe("C16 the catalog's families", () => {
  it("each family names holds with its oldest day from 1970, one walk of one row a family; one only a left-out product holds is none", () => {
    const families = (leftOut: string[]) => {
      const before = rowsCounted();
      const found = big.index.snapshot({}, (open) => open.facts((read) => read.families(leftOut)));
      return { found, rows: rowsCounted() - before };
    };
    const all = families([]);
    expect(all.found).toEqual([{ family: "messages", first: "2026-01-10" }, { family: "notes", first: "2026-01-03" }]);
    expect(all.rows).toBeLessThanOrEqual(2 + 2 * 2);
    const left = families(["wa"]);
    expect(left.found).toEqual([{ family: "notes", first: "2026-01-03" }]);
    expect(left.rows).toBeLessThanOrEqual(2 + 2 * 2 + 2);
  });
});

describe("C18 one frontier for the words as typed and their near spellings", () => {
  it("a spelling's walk capped above an older match of the words as typed: following next finds that match once", () => {
    const puts: RecordEntry[] = [record("typed", "notes", "zebrq crossing", D("2026-01-01"))];
    for (let i = 0; i < 9_000; i++) puts.push(record(`filler-${i}`, "notes", `ledger page ${i}`, D("2026-02-01") + i * MINUTE));
    for (let i = 0; i < 25_000; i++) puts.push(record(`zebra-${i}`, "messages", `zebra seen ${i}`, D("2026-03-01") + i * MINUTE, "wa:local:mac-0001"));
    const { index } = fresh("frontier", UTC, (built) => {
      put(built, puts);
    });
    const { hits, pages } = every(index, { q: "zebrq", families: ["notes"] });
    expect(pages[0]!.answer).toMatchObject({ capped: true, next: { kind: "scan" } });
    expect(hits.map(keyOf)).toEqual(["typed"]);
  });

  it("the words as typed spent on 30,000 empty stretches: the spelling's match in the newest is found by following next", () => {
    const { index } = fresh("frontier-stretches");
    const START = D("2026-03-01");
    const NEWEST = START + 29_999 * MINUTE;
    put(index, [record("zebra-newest", "notes", "zebra crossing", NEWEST), record("between", "notes", "ledger page", START + 30 * 1_000)]);
    const clock = Array.from({ length: 30_000 }, (_, i) => [START + i * MINUTE, START + i * MINUTE + 1_000] as [number, number]);
    const { hits, pages } = every(index, { q: "zebrq", places: { clock, date: [] } });
    expect(pages[0]!.answer.variants).toEqual({ zebrq: ["zebra"] });
    expect(hits.map(keyOf)).toEqual(["zebra-newest"]);
  });

  it("exactly SCAN matches of the words as typed, read to their end: the scan is capped there, and following next gives each, then the spelling's, once", () => {
    const START = D("2026-03-01");
    const puts: RecordEntry[] = [record("zebra-older", "notes", "zebra crossing", START - DAY_MS)];
    for (let i = 0; i < SCAN; i++) puts.push(record(`supper-${i}`, "notes", `supper ${i}`, START + i * MINUTE));
    const { index } = fresh("frontier-exact", UTC, (built) => {
      put(built, puts);
    });
    const { hits, pages } = every(index, { q: "supper OR zebrq", limit: 200 }, 200);
    expect(pages.at(-1)!.answer.next).toBeUndefined();
    expect(pages[0]!.answer).toMatchObject({ total: SCAN, capped: true });
    expect(pages[0]!.answer.variants).toBeUndefined();
    const keys = hits.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(puts.map((each) => each.record.key).sort());
    expect(keys.filter((key) => key === "zebra-older")).toHaveLength(1);
  });
});

describe("C19 a rare word of many common near spellings", () => {
  const VOWELS = ["", "a", "e", "i", "o", "u"];
  const spellings = VOWELS.flatMap((a) => VOWELS.flatMap((b) => VOWELS.map((c) => `z${a}b${b}r${c}q`))).filter((word) => word !== "zbrq").slice(0, 31);
  let dense: SearchIndex;
  beforeAll(() => {
    dense = fresh("dense").index;
    put(dense, Array.from({ length: 1_001 }, (_, i) => record(`dense-${i}`, "notes", `${spellings.join(" ")} ${i}`, D("2026-01-01") + i * MINUTE)));
  });

  it("weighs them inside its own bound: the page plans, scans and opens its hits, a filter's lookup too", () => {
    const plain = measured(dense, { q: "zbrq" });
    expect(plain.rows).toBeLessThanOrEqual(PAGE_ROWS);
    expect(plain.answer.hits).toHaveLength(20);
    expect(plain.answer.variants?.zbrq?.length).toBe(5);
    const filtered = measured(dense, { q: "zbrq", families: ["notes"] });
    expect(filtered.rows).toBeLessThanOrEqual(PAGE_ROWS);
    expect(filtered.answer.hits).toHaveLength(20);
  });
});

describe("C20 a hit's chat", () => {
  const CHAT = "whatsapp:15550000009@s.whatsapp.net";
  const DAY = "2026-07-01";
  const at = D(DAY, "09:00");
  const fact = (id: string, line: number, keys: Record<string, string>): DayFileFact => ({
    id, family: id.slice(0, id.indexOf(":")), of: id.slice(0, id.indexOf(":")), time_ms: at, start_ms: at, end_ms: at, keys, measures: {}, who: [], from: { units: [`unit/${id}`] }, lines: [line],
  });
  let lines: SearchIndex;
  beforeAll(() => {
    lines = fresh("chat-lines").index;
    const facts: DayFileFact[] = [];
    for (let i = 0; i < 80; i++) facts.push(fact(`calls:a-${String(i).padStart(5, "0")}`, 1, { direction: "received" }));
    facts.push(fact("messages:a-chat", 1, { chat: CHAT }));
    for (let i = 0; i < 3_000; i++) facts.push(fact(`calls:b-${String(i).padStart(5, "0")}`, 2, { direction: "received" }));
    facts.push(fact("messages:b-chat", 2, { chat: CHAT }));
    lines.day(DAY, {
      inputs: "in-lines", mtime_us: 1,
      atoms: [
        { n: 1, family: "calls", unit: "calls/one", start_ms: at, end_ms: null, text: "parrot squawk" },
        { n: 2, family: "calls", unit: "calls/two", start_ms: at + MINUTE, end_ms: null, text: "macaw squawk" },
      ],
      facts: { window: { start_ms: D(DAY), end_ms: D(DAY) + DAY_MS }, facts },
    });
  });

  it("counts every fact its line's walk visits, and finds the chat past those that name none", () => {
    const { answer, rows } = measured(lines, { q: '"parrot"' });
    expect(answer.hits).toMatchObject([{ layer: "atoms", chat: CHAT }]);
    expect(answer.hits[0]).not.toHaveProperty("more");
    expect(rows).toBeGreaterThan(2 * 80);
  });

  it("a line printing more facts than its hit's rows names no chat, and says more", () => {
    const { answer, rows } = measured(lines, { q: '"macaw"' });
    expect(answer.hits).toHaveLength(1);
    expect(answer.hits[0]).toMatchObject({ layer: "atoms", more: true });
    expect(answer.hits[0]).not.toHaveProperty("chat");
    expect(rows).toBeLessThanOrEqual(PAGE_ROWS);
  });
});

describe("C21 a place is stretches of time, each a walk", () => {
  const inHarbour = (d: number) => d % 10 === 0;
  const hour = (day: string, h: number) => D(day, `${String(h).padStart(2, "0")}:30`);
  function harbour(name: string, days: number, only = false) {
    const { index, file } = fresh(name);
    const puts: RecordEntry[] = [];
    const clock: [number, number][] = [];
    const date: [number, number][] = [];
    for (let d = days - 1; d >= 0; d--) {
      const day = addDays("2026-08-31", -d);
      if (only && !inHarbour(d)) continue;
      for (let h = 0; h < 24; h++) if (!only || (h >= 8 && h < 20)) puts.push(record(`log-${day}-${h}`, "notes", `harbour log ${h}`, hour(day, h)));
      if (!only) puts.push(record(`night-${day}`, "notes", "harbour night", D(day) + 500));
      puts.push({ ...record(`ledger-${day}`, "notes", "harbour ledger", D(day)), dated: true });
      if (inHarbour(d)) {
        clock.push([D(day, "08:00"), D(day, "20:00")]);
        date.push([D(day), D(day) + DAY_MS]);
      }
    }
    for (let at = 0; at < puts.length; at += 10_000) put(index, puts.slice(at, at + 10_000));
    return { index, file, places: { clock, date } };
  }
  const kept = (days: number) => {
    const out: { key: string; at: number }[] = [];
    for (let d = 0; d < days; d++) {
      if (!inHarbour(d)) continue;
      const day = addDays("2026-08-31", -d);
      for (let h = 19; h >= 8; h--) out.push({ key: `log-${day}-${h}`, at: hour(day, h) * 1000 });
      out.push({ key: `ledger-${day}`, at: D(day) * 1000 });
    }
    return out.sort((left, right) => right.at - left.at).map(({ key }) => key);
  };
  let small: ReturnType<typeof harbour>;
  let large: ReturnType<typeof harbour>;
  let only: ReturnType<typeof harbour>;
  beforeAll(() => {
    small = harbour("harbour-small", 40);
    large = harbour("harbour-large", 160);
    only = harbour("harbour-only", 40, true);
  });

  it("keeps the entries of its stretches alone, a note by its clock and a ledger by its day; newest and oldest, every page once", () => {
    const ran = walked(() => {
      for (const order of ["newest", "oldest"] as const) {
        const { hits, pages } = every(small.index, { q: '"harbour"', places: small.places, order, limit: 7 });
        const keys = hits.map(keyOf);
        expect(keys).toEqual(order === "newest" ? kept(40) : kept(40).reverse());
        const alone = every(only.index, { q: '"harbour"', places: only.places, order, limit: 7 });
        expect(alone.hits.map(keyOf)).toEqual(keys);
        expect(pages.map((page) => page.rows)).toEqual(alone.pages.map((page) => page.rows));
        const listed = every(small.index, { places: small.places, order, limit: 7 });
        const listedAlone = every(only.index, { places: only.places, order, limit: 7 });
        expect(listed.hits.map(keyOf)).toEqual(keys);
        expect(listed.pages.map((page) => page.rows)).toEqual(listedAlone.pages.map((page) => page.rows));
      }
    });
    const db = new Database(small.file, { readonly: true });
    try {
      const kinds = [...ran].filter((sql) => /FROM entries e WHERE e\.dated = [01] AND /.test(sql));
      expect(kinds.length).toBeGreaterThan(0);
      for (const sql of kinds) {
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...new Array((sql.match(/\?/g) ?? []).length).fill(null)) as { detail: string }[];
        expect(plan[0]!.detail).toMatch(/USING (COVERING )?INDEX entries_dated \(dated=\? AND rowid>\? AND rowid<\?\)/);
      }
    } finally {
      db.close();
    }
  });

  it("a ledger in a stretch of clock time is not kept by it, nor a note in a stretch of days alone", () => {
    const day = "2026-08-30";
    const clockOnly = { clock: [[D(day) - 3_600_000, D(day) + DAY_MS]] as [number, number][], date: [] };
    expect(every(small.index, { q: "harbour", places: clockOnly }).hits.map(keyOf)).not.toContain(`ledger-${day}`);
    expect(every(small.index, { q: "harbour", places: clockOnly }).hits).toHaveLength(26);
    const dateOnly = { clock: [], date: [[D(day), D(day) + DAY_MS]] as [number, number][] };
    expect(every(small.index, { q: "harbour", places: dateOnly }).hits.map(keyOf)).toEqual([`ledger-${day}`]);
    expect(measured(small.index, { places: { clock: [], date: [] } })).toMatchObject({ answer: { hits: [], total: 0 }, rows: 0 });
  });

  it("reads the same rows at two sizes of home: a page of the place's newest, and a word the place never holds one row a stretch for each walk (the said tier, the title tier, held)", () => {
    const page = (home: typeof small) => measured(home.index, { places: home.places, order: "newest", from_ms: D("2026-07-23"), to_ms: D("2026-09-01") });
    expect(page(small).answer).toMatchObject({ total: 52, capped: false });
    expect(page(small).answer.hits.map(keyOf)).toEqual(page(large).answer.hits.map(keyOf));
    expect(page(large).rows).toBe(page(small).rows);
    const none = (home: typeof small) => measured(home.index, { q: '"ledger"', places: { clock: home.places.clock, date: [] } });
    expect(none(small).answer).toMatchObject({ hits: [], capped: false, held: null });
    expect(none(large).rows - none(small).rows).toBe(3 * (large.places.clock.length - small.places.clock.length));
  });

  it("an entry with only a date, whatever its stored time, is its civil day's, in the place and out of it, east and west of UTC, from 04:00", () => {
    const DAY = "2026-06-10";
    const entries = [{ ...record("ledger-second", "notes", "anchor ledger", D(DAY) + 1_000), dated: true }, record("noon", "notes", "anchor noon", D(DAY, "12:30"))];
    const harbourArea = { id: 0, place: null, city: "Harbour", city_id: "harbour", region: null, country: "Atlantis", country_code: null, zone: "UTC" };
    const hillArea = { ...harbourArea, id: 1, city: "Hill", city_id: "hill" };
    const tables: PresenceTables = {
      version: "v-second", areas: [harbourArea, hillArea],
      pieces: [[D(DAY, "00:00"), D(DAY, "12:00"), 1, null, "UTC", ["location:local"]], [D(DAY, "12:00"), D(DAY, "13:00"), 0, null, "UTC", ["location:local"]], [D(DAY, "13:00"), D(DAY) + DAY_MS, 1, null, "UTC", ["location:local"]]],
      placed: [[DAY, 0, false], [DAY, 1, false]],
    };
    const presence = presenceOver(tables);
    for (const zone of ["Asia/Kolkata", "America/Los_Angeles"]) {
      const settings: DaySettings = { zone, day_start_hour: 4 };
      const { index } = fresh(`harbour-second-${zone.replace("/", "-")}`, settings);
      put(index, entries);
      const into = placeStretches(presence, { in: [0], out: [] }, settings);
      const outOf = placeStretches(presence, { out: [0] }, settings);
      const { start_ms, end_ms } = dayBounds(DAY, settings);
      for (const range of [{}, { from_ms: start_ms, to_ms: end_ms }]) {
        const keys = (places: typeof into) => measured(index, { q: '"anchor"', places, ...range }).answer.hits.map(keyOf).sort();
        expect(keys(into)).toEqual(["ledger-second", "noon"]);
        expect(keys(outOf)).toEqual([]);
      }
    }
  });

  it("a place of more stretches than a page's rows is held by the budget: capped, and the next pages find every entry once", () => {
    const { index } = fresh("harbour-moments");
    const START = D("2026-03-01");
    const puts: RecordEntry[] = [];
    for (let i = 0; i < 30_000; i += 5) puts.push(record(`between-${i}`, "notes", `moment between ${i}`, START + i * MINUTE + 30_000));
    for (let i = 0; i < 30_000; i += 1_000) puts.push(record(`moment-${i}`, "notes", `moment kept ${i}`, START + i * MINUTE));
    for (let at = 0; at < puts.length; at += 10_000) put(index, puts.slice(at, at + 10_000));
    const clock = Array.from({ length: 30_000 }, (_, i) => [START + i * MINUTE, START + i * MINUTE + 1_000] as [number, number]);
    const { hits, pages } = every(index, { places: { clock, date: [] }, order: "newest" });
    expect(hits.map(keyOf)).toEqual(Array.from({ length: 30 }, (_, k) => `moment-${(29 - k) * 1_000}`));
    expect(pages[0]!.answer).toMatchObject({ capped: true });
    expect(pages.length).toBeGreaterThan(1);
    const rows = pages.reduce((sum, page) => sum + page.rows, 0);
    expect(rows).toBeLessThan(30_000 + 30 * 2 + pages.length * 2 * HIT_ROWS);
  });
});
