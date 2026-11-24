import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { dayBounds, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { RENDERER_VERSION, type Family } from "@lifestreamprotocol/families";
import type { PeopleMap } from "./counting.js";
import { ARGUMENTS_BYTES, GIVEN_MOST, NEXT_CHARS, sealed } from "./cursor-text.js";
import { makeRef, personRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { answerOf, paramsOf, searchParams, type RecordList, type SearchAnswer } from "./search-contract.js";
import { SearchIndex, type RecordEntry } from "./search-index.js";
import { cursorOf, recordPartOf, searchAskedOf, whenNamed, type Widened } from "./search-route.js";
import { onCall, type CallOf } from "./test/calls.js";
import { PAGE_ROWS, SCAN, TOP } from "./search-scan.js";
import { rowsCounted } from "./work.js";
import type { HeldDays } from "./index-file.js";
import { readDay } from "./search.js";
import { modelReaches } from "./door.js";


const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAY_MS = 86_400_000;
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-route-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
function fresh(name: string): SearchIndex {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
}
const put = (index: SearchIndex, puts: RecordEntry[]) => {
  for (let at = 0; at < puts.length; at += 5_000) index.records(puts.slice(at, at + 5_000), [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
};
const drop = (index: SearchIndex, keys: string[]) =>
  index.records([], keys.map((key) => ({ source: "notes:local:mac-0001", kind: "item", key })), { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
const record = (key: string, words: string, start_ms: number, family = "notes", source = "notes:local:mac-0001"): RecordEntry => ({
  record: { source, kind: "item", key }, family, version: `v-${key}`, start_ms, end_ms: null, title: "", text: words, who: [], link: null,
});

const context = (index: SearchIndex, more: Partial<CallOf> = {}): CallOf => ({ index, epoch: 1, now_ms: D("2026-11-14"), ...more });
const askedOf = (query: URLSearchParams) => searchAskedOf(paramsOf(searchParams, query));

function ask(index: SearchIndex, params: Record<string, string | string[]>, more: Partial<CallOf> = {}): SearchAnswer {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of Array.isArray(value) ? value : [value]) query.append(name, each);
  const answer = onCall(context(index, more), (call) => recordPartOf(askedOf(query), call).answer);
  const parsed = answerOf("/v1/search", 200, JSON.parse(JSON.stringify(answer)));
  return parsed as SearchAnswer;
}
function refused(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
  return "answered";
}
const keyOf = (ref: string) => readRef(ref, "ref", ["record"]).parts.key;
const keysOf = (list: RecordList) => list.hits.map((hit) => keyOf(hit.ref));

function follow(index: SearchIndex, params: Record<string, string | string[]>, between?: (page: number, list: RecordList) => void, more: Partial<CallOf> = {}) {
  const pages: RecordList[] = [];
  let answer = ask(index, { lists: "record", ...params }, more);
  for (let page = 0; page < 2_000; page++) {
    const list = answer.record!;
    pages.push(list);
    if (list.next === null || list.next === undefined) break;
    between?.(page, list);
    answer = ask(index, { cursor: list.next }, more);
  }
  return { pages, keys: pages.flatMap(keysOf) };
}
const once = (keys: string[]) => expect(keys.length).toBe(new Set(keys).size);

describe("the record list", () => {
  it("R1 answers as the contract says: refs, product, at with its offset, no score, held as days", () => {
    const index = fresh("r1");
    put(index, [record("a", "example walk in the park", D("2026-10-04", "09:15")), record("b", "another example", D("2026-10-02"))]);
    const answer = ask(index, { query: "example", lists: ["record", "goto"] });
    const list = answer.record!;
    expect(list.total).toBe(2);
    expect(list.capped).toBe(false);
    expect(list.next).toBeNull();
    expect(list.hits[0]).toMatchObject({ day: "2026-10-04", at: "2026-10-04T09:15+00:00", family: "notes", product: expect.any(String) });
    expect(list.hits[0]!.snippet).toContain("«example»");
    expect(JSON.stringify(list)).not.toContain("score");
    expect(list.hits[0]!.ref.startsWith("record.")).toBe(true);
    expect(readRef(list.hits[0]!.ref, "ref", ["record"])).toEqual({ kind: "record", parts: { source: "notes:local:mac-0001", kind: "item", key: "a" } });
    expect(list.spread).toEqual({ families: { notes: 2 }, months: { "2026-10": 2 } });
    expect(answer.goto).toEqual({ people: [], places: [], day: null, month: null });
    const none = ask(index, { query: "zebra", lists: "record" }).record!;
    expect(none.hits).toEqual([]);
    expect(none.held).toBeNull();
    const elsewhere = ask(index, { query: "example", from: "2026-11-01", lists: "record" }).record!;
    expect(elsewhere.held).toEqual({ first: "2026-10-02", last: "2026-10-04" });
  });

  it("keeps by `families` each hit as its answer names its family: a family the contract does not name is kept as notes", () => {
    const index = fresh("families");
    put(index, [
      record("n", "lantern walk", D("2026-10-04")), record("p", "lantern log", D("2026-10-03"), "plain", "example-log:local:test"),
      record("m", "lantern mail", D("2026-10-02"), "mail", "gmail:local:mac-0001"),
    ]);
    const more = { families: [{ name: "notes" }, { name: "plain" }, { name: "mail" }] as Family[] };
    const all = ask(index, { query: "lantern", lists: "record" }, more).record!;
    expect(all.spread!.families).toEqual({ notes: 2, mail: 1 });
    const notes = ask(index, { query: "lantern", lists: "record", families: "notes" }, more).record!;
    expect([keysOf(notes).sort(), notes.hits.map((hit) => hit.family), notes.spread!.families]).toEqual([["n", "p"], ["notes", "notes"], { notes: 2 }]);
    expect(keysOf(ask(index, { query: "lantern", lists: "record", families: "mail" }, more).record!)).toEqual(["m"]);
  });

  it("R2 a ranked scan of 60: each match reached by next, none twice; R6 a hit given then gone moves nothing", () => {
    const index = fresh("r2");
    put(index, Array.from({ length: 60 }, (_, n) => record(`m${n}`, `common ${"word ".repeat(n % 7)}`, D("2026-01-01") + n * DAY_MS)));
    const { keys, pages } = follow(index, { query: "common", limit: "7" }, (page, list) => {
      if (page === 1) drop(index, [keyOf(list.hits[0]!.ref)]);
    });
    once(keys);
    expect(keys).toHaveLength(60);
    expect(pages.every((page) => page.order === undefined)).toBe(true);
  });

  it("R3 records arriving between pages: every match of the first scan once", () => {
    const index = fresh("r3");
    put(index, Array.from({ length: 60 }, (_, n) => record(`m${n}`, `common thing ${n % 3 === 0 ? "common" : ""}`, D("2026-01-01") + n * DAY_MS)));
    let added = 0;
    const { keys } = follow(index, { query: "common", limit: "10" }, () => put(index, [record(`new${added++}`, "common common common", D("2026-06-01") + added * 1000)]));
    once(keys);
    for (let n = 0; n < 60; n++) expect(keys).toContain(`m${n}`);
  });

  it("R4 60 matches of equal rank, entries holding none of the words arriving: each once", () => {
    const index = fresh("r4");
    put(index, Array.from({ length: 60 }, (_, n) => record(`m${n}`, "same words here", D("2026-03-03", "10:00") + n * 1000)));
    let added = 0;
    const { keys } = follow(index, { query: "same", limit: "9" }, () => put(index, Array.from({ length: 30 }, () => record(`other${added++}`, "unrelated text", D("2026-03-03", "11:00") + added))));
    once(keys);
    expect(keys.sort()).toEqual(Array.from({ length: 60 }, (_, n) => `m${n}`).sort());
  });

  it("R5 a OR b: the second group rises past page one's last hit; every match of both groups once", () => {
    const index = fresh("r5");
    put(index, [
      ...Array.from({ length: 30 }, (_, n) => record(`a${n}`, "alpha", D("2026-02-02", "10:00") + n * 1000)),
      ...Array.from({ length: 30 }, (_, n) => record(`b${n}`, "beta", D("2026-02-02", "09:00") + n * 1000)),
      ...Array.from({ length: 30 }, (_, n) => record(`f${n}`, "beta filler", D("2026-02-01") + n * 1000)),
    ]);
    const first = ask(index, { query: "alpha OR beta", lists: "record", limit: "20" }).record!;
    expect(keysOf(first).every((key) => key.startsWith("a"))).toBe(true);
    put(index, Array.from({ length: 400 }, (_, n) => record(`n${n}`, "alpha", D("2026-05-05") + n * 1000)));
    const pages = [first];
    let next = first.next;
    while (next !== null && next !== undefined) {
      const page = ask(index, { cursor: next }).record!;
      pages.push(page);
      next = page.next;
    }
    const keys = pages.flatMap(keysOf);
    once(keys);
    for (let n = 0; n < 30; n++) {
      expect(keys).toContain(`a${n}`);
      expect(keys).toContain(`b${n}`);
    }
  });
});

describe("past 300 given, by time; then the next scan", () => {
  const index = fresh("r7");
  const STEP = 60_000;
  const base = D("2025-01-01");
  put(index, [
    ...Array.from({ length: 30_000 }, (_, n) => record(`z${n}`, "zz entry", base + n * STEP, n % 50 === 0 ? "mail" : "notes", n % 50 === 0 ? "gmail:person-a@example.com:cloud" : "notes:local:mac-0001")),
    ...Array.from({ length: 12_000 }, (_, n) => record(`m${n}`, "plain mail", base + n * STEP + 7, "mail", "gmail:person-a@example.com:cloud")),
  ]);

  it("R7 by rank to 300 given, the page that fills it ends there, the rest newest first, each once, then the next scan by rank", () => {
    let arrived = 0;
    const { pages, keys } = follow(index, { query: "zz", families: "mail", limit: "50" }, (page, list) => {
      if (page === 2 || list.order === "newest") {
        put(index, [record(`late${arrived++}`, "zz late", base + 29_000 * STEP + arrived, "mail", "gmail:person-a@example.com:cloud")]);
      }
    });
    const first = pages[0]!;
    expect(first.capped).toBe(true);
    expect(first.total).toBeGreaterThan(GIVEN_MOST);
    const turn = pages.findIndex((page) => page.order === "newest");
    expect(turn).toBeGreaterThan(0);
    expect(pages.slice(0, turn).flatMap(keysOf)).toHaveLength(GIVEN_MOST);
    const scanTwo = pages.findIndex((page, at) => at > turn && page.order === undefined);
    expect(scanTwo).toBeGreaterThan(turn);
    expect(pages.slice(turn, scanTwo).every((page) => page.order === "newest")).toBe(true);
    once(keys);
    const firstScan = new Set(pages.slice(0, scanTwo).flatMap(keysOf));
    expect(firstScan.size).toBeGreaterThanOrEqual(first.total);
    for (const page of pages) expect((page.next ?? "").length).toBeLessThanOrEqual(NEXT_CHARS);
    expect(keys.filter((key) => key.startsWith("z"))).toHaveLength(600);
  });
});

describe("the rest by time read wide", () => {
  const index = fresh("r7-wide");
  put(index, Array.from({ length: GIVEN_MOST + 100 }, (_, n) => record(`y${n}`, "yy entry", D("2025-01-01") + n * 60_000)));

  it("R7 wide: one read of the rest by time lent a width gives the narrow pages' hits, each page's next at its last hit, and ends where they end", () => {
    const { pages } = follow(index, { query: "yy", limit: "30" });
    const turn = pages.findIndex((page) => page.order === "newest");
    expect(turn).toBeGreaterThan(0);
    const narrow = pages.slice(turn);
    expect(narrow.every((page) => page.order === "newest")).toBe(true);
    const query = new URLSearchParams({ cursor: pages[turn - 1]!.next! });
    const wide = JSON.parse(JSON.stringify(onCall(context(index), (call) => recordPartOf(askedOf(query), call, { width: 1_000 }).answer).record)) as RecordList & Widened;
    expect(keysOf(wide)).toEqual(narrow.flatMap(keysOf));
    expect(keysOf(wide)).toHaveLength(100);
    let shown = 0;
    for (const page of narrow) {
      shown += page.hits.length;
      expect(wide.steps.find((step) => step.hits === shown)?.next).toBe(page.next);
    }
    expect(wide.ended).toBe(true);
    expect(wide.next).toBe(narrow.at(-1)!.next);
  });
});

describe("the cursor", () => {
  it("R8 the largest cursor fits; arguments one byte past ARGUMENTS_BYTES as a cursor holds them refused on the first page, at it answered", () => {
    const slots = Array.from({ length: GIVEN_MOST }, (_, n) => Math.round(-TOP + (2 * TOP * n) / (GIVEN_MOST - 1)));
    const query = "é".repeat((ARGUMENTS_BYTES - 12) / 2);
    const text = cursorOf({ at: { kind: "rest", place: TOP, stop: -TOP, given: slots }, total: 10_000, capped: true }, { query },
      { index: "f", epoch: 7, resolved: "r".repeat(22) });
    expect(text.length).toBeLessThan(NEXT_CHARS);
    const index = fresh("r8");
    put(index, [record("a", "word", D("2026-01-01"))]);
    expect(refused(() => ask(index, { query: `word ${"x".repeat(ARGUMENTS_BYTES - 16)}`, lists: "record" }))).toBe("BAD_PARAMETER");
    expect(refused(() => ask(index, { query: `word ${"x".repeat(ARGUMENTS_BYTES - 17)}`, lists: "record" }))).toBe("answered");
  });

  it("R9 bound to its query, its file and, holding slots given, the epoch; never to a day indexed", () => {
    const index = fresh("r9");
    put(index, Array.from({ length: 30 }, (_, n) => record(`m${n}`, "kept words", D("2026-01-01") + n * DAY_MS)));
    const ranked = ask(index, { query: "kept", lists: "record", limit: "5" }).record!;
    const byTime = ask(index, { query: "kept", lists: "record", limit: "5", order: "newest" }).record!;
    put(index, [record("later", "other", D("2026-04-01"))]);
    expect(refused(() => ask(index, { cursor: ranked.next! }))).toBe("answered");
    expect(refused(() => ask(index, { cursor: byTime.next! }))).toBe("answered");
    expect(refused(() => ask(index, { cursor: ranked.next!, query: "kept" }))).toBe("answered");
    expect(refused(() => ask(index, { cursor: ranked.next!, query: "other" }))).toBe("BAD_PARAMETER");
    expect(refused(() => ask(index, { cursor: "not-a-cursor" }))).toBe("BAD_PARAMETER");
    expect(refused(() => ask(index, { cursor: ranked.next! }, { epoch: 2 }))).toBe("CURSOR_EXPIRED");
    expect(refused(() => ask(index, { cursor: byTime.next! }, { epoch: 2 }))).toBe("answered");
    const other = fresh("r9b");
    put(other, Array.from({ length: 30 }, (_, n) => record(`m${n}`, "kept words", D("2026-01-01") + n * DAY_MS)));
    expect(refused(() => ask(other, { cursor: byTime.next! }))).toBe("CURSOR_EXPIRED");
  });

  it("R9 by time: pages of the newest first, each once, a page asked with its cursor alone", () => {
    const index = fresh("r9c");
    put(index, Array.from({ length: 45 }, (_, n) => record(`m${n}`, "listed", D("2026-01-01") + n * DAY_MS)));
    const { keys, pages } = follow(index, { query: "listed", order: "newest", limit: "10" });
    expect(keys).toEqual(Array.from({ length: 45 }, (_, n) => `m${44 - n}`));
    expect(pages.every((page) => page.total === 45)).toBe(true);
  });
});

describe("the people and the days a search names", () => {
  it("R10 a name several people may be, or no one is: PERSON_UNKNOWN, the several with their matches; one: who it was", () => {
    const index = fresh("r10");
    put(index, [{ ...record("a", "hello there", D("2026-01-01")), who: ["phone:+15550000001"] }]);
    const people = {
      version: "p1",
      idOf: (id: string) => (id === "person:a" || id === "phone:+15550000001" ? "person:a" : undefined),
      person: (id: string) => (id === "person:a" ? { name: "Person A", handles: ["phone:+15550000001"] } : id === "person:b" ? { name: "Person B", handles: ["phone:+15550000002"] } : undefined),
      find: (name: string) => (name === "Person" ? ["person:a", "person:b"] : name === "Person A" ? ["person:a"] : []),
    };
    let refusal: Refusal | undefined;
    try {
      ask(index, { person: "Person", lists: "record" }, { people });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refusal = error;
    }
    expect([refusal?.status, refusal?.code]).toEqual([404, "PERSON_UNKNOWN"]);
    expect((refusal!.extra.matches as { name: string }[]).map((match) => match.name)).toEqual(["Person A", "Person B"]);
    expect(answerOf("/v1/search", 404, { code: refusal!.code, message: refusal!.words, ...refusal!.extra })).toMatchObject({ code: "PERSON_UNKNOWN" });
    expect(refused(() => ask(index, { person: "Nobody Example", lists: "record" }, { people }))).toBe("PERSON_UNKNOWN");
    expect(refused(() => ask(index, { person: "person:a", lists: "record" }, { people }))).toBe("PERSON_UNKNOWN");
    const ref = personRef({ id: "person:a", handles: ["phone:+15550000001"] });
    expect(readRef(ref, "person", ["person"]).parts).toEqual({ handle: "phone:+15550000001" });
    for (const value of [ref, "phone:+15550000001", "Person A"]) {
      const one = ask(index, { person: value, lists: "record" }, { people });
      expect(one.person, value).toEqual([{ asked: value, ref, name: "Person A" }]);
      expect(one.record!.hits.map((hit) => keyOf(hit.ref))).toEqual(["a"]);
    }
    const goto = ask(index, { query: "Person", lists: ["record", "goto"] }, { people }).goto!;
    expect(goto.people).toEqual([{ ref, name: "Person A" }, { ref: personRef({ id: "person:b", handles: people.person("person:b")?.handles ?? [] }), name: "Person B" }]);
  });

  it("R10 Go to's day and month by the home's today", () => {
    const today = "2026-11-14";
    expect(whenNamed("2026-10-04", today)).toEqual({ day: "2026-10-04", month: null });
    expect(whenNamed("yesterday", today)).toEqual({ day: "2026-11-13", month: null });
    expect(whenNamed("4 october", today)).toEqual({ day: "2026-10-04", month: null });
    expect(whenNamed("december 3", today)).toEqual({ day: "2025-12-03", month: null });
    expect(whenNamed("october 2025", today)).toEqual({ day: null, month: "2025-10" });
    expect(whenNamed("dec", today)).toEqual({ day: null, month: "2025-12" });
    expect(whenNamed("31 february", today)).toEqual({ day: null, month: null });
    expect(whenNamed("dinner", today)).toEqual({ day: null, month: null });
  });

  it("R11 an index that has read no statement states no as_of, and the contract takes it; one that has, its own", () => {
    const index = fresh("r11");
    put(index, [record("a", "example walk", D("2026-10-04"))]);
    const none = ask(index, { query: "example", lists: "record" }, { fresh: () => ({ as_of: null, pending: [] }) }).record!;
    expect(none.hits).toHaveLength(1);
    expect(none).not.toHaveProperty("as_of");
    expect(ask(index, { query: "example", lists: "record" }).record).not.toHaveProperty("as_of");
    const stated = "2026-11-14T09:00:00+00:00";
    expect(ask(index, { query: "example", lists: "record" }, { fresh: () => ({ as_of: stated, pending: [] }) }).record!.as_of).toBe(stated);
  });
});

describe("a capped list by time, and the one meter of a page", () => {
  it("R12 10,001 dated matches newest first, followed to the end: every capped page has a next, each match once", () => {
    const index = fresh("r12");
    put(index, Array.from({ length: SCAN + 1 }, (_, n) => record(`d${n}`, "dated entry", D("2020-01-01") + n * 60_000)));
    const { pages, keys } = follow(index, { query: "dated", from: "2019-01-01", to: "2026-11-01", order: "newest", limit: "50" });
    expect(pages[0]!.capped).toBe(true);
    for (const page of pages) if (page.capped) expect(page.next).toEqual(expect.any(String));
    once(keys);
    expect(keys).toHaveLength(SCAN + 1);
    expect(pages.at(-1)!.next ?? null).toBeNull();
  });

  it("R13 a capped dated search asks freshness of the days its scan reached alone, inside the page's one meter", () => {
    const index = fresh("r13");
    put(index, Array.from({ length: SCAN + 500 }, (_, n) => record(`f${n}`, "fresh entry", D("2026-01-01") + n * 60_000)));
    let held: HeldDays | undefined;
    const query = new URLSearchParams({ lists: "record", query: "fresh", from: "1990-01-01", to: "2026-11-01", order: "newest", limit: "20" });
    const before = rowsCounted();
    const answer = onCall(context(index, {
      budget: PAGE_ROWS,
      fresh: (_seq, days) => {
        held = days;
        return { as_of: null, pending: [] };
      },
    }), (call) => recordPartOf(askedOf(query), call).answer);
    expect(rowsCounted() - before).toBeLessThanOrEqual(PAGE_ROWS);
    const list = answer.record!;
    expect(list.capped).toBe(true);
    expect(held!.from >= list.reached!.at!.slice(0, 10)).toBe(true);
    expect(held!.to).toBe("2026-11-01");
  });

  it("R14 refuses a next of another route", () => {
    const index = fresh("r14");
    put(index, [record("a", "word", D("2026-01-01"))]);
    for (const route of ["count", "read", "people"] as const) {
      expect(refused(() => ask(index, { cursor: sealed(route, [1], route === "people" ? { name: "x" } : route === "read" ? { ref: "record.x" } : { of: "calls" }, {}) }))).toBe("BAD_PARAMETER");
    }
  });
});

describe("what a hit says", () => {
  it("R15 a match with no time at all is a hit with no day and no at, its ref kept: the hits and total of the same matches", () => {
    const index = fresh("r15");
    put(index, [{ ...record("u", "an undated example", 0), start_ms: null }, record("t", "a dated example", D("2026-10-04", "09:15"))]);
    const list = ask(index, { query: "example", lists: "record", order: "newest" }).record!;
    expect(list.total).toBe(2);
    expect(keysOf(list).sort()).toEqual(["t", "u"]);
    const untimed = list.hits.find((hit) => keyOf(hit.ref) === "u")!;
    expect(untimed).not.toHaveProperty("day");
    expect(untimed).not.toHaveProperty("at");
    expect(readRef(untimed.ref, "ref", ["record"]).parts).toMatchObject({ key: "u" });
    expect(list.hits.find((hit) => keyOf(hit.ref) === "t")).toMatchObject({ day: "2026-10-04", at: "2026-10-04T09:15+00:00" });
    const byTime = follow(index, { query: "example", order: "oldest", limit: "1" });
    expect(byTime.keys.sort()).toEqual(["t", "u"]);
  });

  const day = "2026-10-04";
  const CHAT = "whatsapp:15550000001@s.whatsapp.net";
  function indexOfDay(name: string): SearchIndex {
    const root = join(scratch, `${name}-home`);
    mkdirSync(join(root, "days"), { recursive: true });
    const at = (time: string) => D(day, time);
    const line = (n: number, family: string, time: string, text: string, names: { start: number; end: number; who: string }[], more: Record<string, unknown> = {}) =>
      ({ n, family, unit: `${family}/u${n}`, start_ms: at(time), end_ms: at(time), text, names, ...more });
    const fact = (n: number, of: string, time: string, who: { handle: string; role: string }[], keys: Record<string, string> = {}) => ({
      id: `${of}:${String(n).padStart(24, "0")}`, family: of === "mails" ? "mail" : "messages", of, time_ms: at(time), start_ms: at(time), end_ms: at(time),
      keys, measures: {}, who, from: { units: [`${of === "mails" ? "mail" : "messages"}/u${n}`], alone: true }, lines: [n],
    });
    const atoms = [
      line(1, "mail", "09:00", "Mail from Person A: the receipt is ready", [{ start: 10, end: 18, who: "person:person-a" }]),
      line(2, "mail", "10:00", "Mail from receipts@example.com: a receipt copy", [{ start: 10, end: 30, who: "email:receipts@example.com" }]),
      line(3, "mail", "11:00", "Person B: the receipt sent on", [{ start: 0, end: 8, who: "email:person-b@example.com" }]),
      line(4, "messages", "12:00", "Person A: a receipt photo", [{ start: 0, end: 8, who: "person:person-a" }], { chat: CHAT }),
    ];
    const facts = [
      fact(1, "mails", "09:00", [{ handle: "email:person-a@example.com", role: "sender" }]),
      fact(2, "mails", "10:00", [{ handle: "email:receipts@example.com", role: "sender" }]),
      fact(3, "mails", "11:00", [{ handle: "email:person-b@example.com", role: "receiver" }]),
      fact(4, "messages", "12:00", [{ handle: "phone:+15550000001", role: "sender" }], { chat: CHAT, direction: "received" }),
    ];
    const path = join(root, "days", `${day}.day.json`);
    writeFileSync(path, JSON.stringify({ renderer: RENDERER_VERSION, day, window: dayBounds(day, UTC), atoms, facts }));
    const read = readDay(openHomeFolder(root), day, "sha256:r16", Math.round(statSync(path).mtimeMs * 1000))!;
    const index = fresh(name);
    expect(index.day(day, read)).toBe(true);
    return index;
  }
  const PERSON_A: PeopleMap = {
    version: "p1",
    idOf: (id) => (["person:person-a", "email:person-a@example.com", "phone:+15550000001"].includes(id) ? "person:person-a" : undefined),
    person: (id) => (id === "person:person-a" ? { name: "Person A", handles: ["email:person-a@example.com", "phone:+15550000001"] } : undefined),
    find: () => [],
  };

  it("R16 a hit's sender is its family's: wherever its name sits, a receiver never, a labelled one through People", () => {
    const index = indexOfDay("r16");
    const fromOf = (more: Partial<CallOf>) => Object.fromEntries(ask(index, { query: "receipt", lists: "record", order: "newest" }, more).record!.hits
      .map((hit) => [hit.snippet!.replace(/[«»]/gu, ""), hit.from ?? null]));
    expect(fromOf({ people: PERSON_A })).toEqual({
      "Mail from Person A: the receipt is ready": "Person A",
      "Mail from receipts@example.com: a receipt copy": "receipts@example.com",
      "Person B: the receipt sent on": null,
      "a receipt photo": "Person A",
    });
    expect(fromOf({})).toMatchObject({ "Mail from Person A: the receipt is ready": null, "Mail from receipts@example.com: a receipt copy": "receipts@example.com" });
  });

  function said(name: string): SearchIndex {
    const root = join(scratch, `${name}-home`);
    mkdirSync(join(root, "days"), { recursive: true });
    const at = (time: string) => D(day, time);
    const crew = { block: { title: "Harbor Crew" }, chat: CHAT };
    const atom = (n: number, family: string, time: string, text: string, names: { start: number; end: number; who: string }[], more: Record<string, unknown> = {}) =>
      ({ n, family, unit: `${family}/u${n}`, start_ms: at(time), end_ms: at(time), text, names, ...more });
    const fact = (n: number, of: string, time: string, sender: string, keys: Record<string, string>) => ({
      id: `${of}:${String(n).padStart(24, "0")}`, family: of === "mails" ? "mail" : "messages", of, time_ms: at(time), start_ms: at(time), end_ms: at(time),
      keys, measures: {}, who: [{ handle: sender, role: "sender" }], from: { units: [`${of === "mails" ? "mail" : "messages"}/u${n}`], alone: true }, lines: [n],
    });
    const atoms = [
      atom(1, "messages", "09:00", "Person A: see you at noon", [{ start: 0, end: 8, who: "phone:+15550000001" }], crew),
      atom(2, "messages", "08:00", "Person B: the harbor tour is booked", [{ start: 0, end: 8, who: "phone:+15550000002" }], crew),
      atom(3, "messages", "10:00", "the user: harbor tickets bought", [], crew),
      atom(4, "mail", "11:00", "Mail from deals@example.com: a harbor offer", []),
    ];
    const facts = [
      fact(1, "messages", "09:00", "phone:+15550000001", { chat: CHAT, direction: "received" }),
      fact(2, "messages", "08:00", "phone:+15550000002", { chat: CHAT, direction: "received" }),
      fact(3, "messages", "10:00", "email:person-me@example.com", { chat: CHAT, direction: "sent" }),
      fact(4, "mails", "11:00", "email:deals@example.com", { direction: "received" }),
    ];
    const path = join(root, "days", `${day}.day.json`);
    writeFileSync(path, JSON.stringify({ renderer: RENDERER_VERSION, day, window: dayBounds(day, UTC), atoms, facts }));
    const index = fresh(name);
    expect(index.day(day, readDay(openHomeFolder(root), day, `sha256:${name}`, Math.round(statSync(path).mtimeMs * 1000))!)).toBe(true);
    return index;
  }
  const shown = (list: RecordList) => list.hits.map((hit) => [hit.snippet, hit.from ?? null]);

  it("H10 what was said ranks above a chat's name; a title-only hit shows what was said, and the sender once; `the user` by direction: sent", () => {
    const index = said("h10");
    const hits = shown(ask(index, { query: "harbor", lists: "record", families: "messages" }).record!);
    expect(hits.slice(0, 2).sort()).toEqual([["the «harbor» tour is booked", "Person B"], ["«harbor» tickets bought", "the user"]].sort());
    expect(hits[2]).toEqual(["see you at noon", "Person A"]);
  });

  it("H11 a mail's unnamed sender is its address for the person; a model's hit states no new sender and its words as today", () => {
    const index = said("h11");
    expect(shown(ask(index, { query: "offer", lists: "record" }).record!)).toEqual([["Mail from deals@example.com: a harbor «offer»", "deals@example.com"]]);
    const model = ask(index, { query: "harbor", lists: "record", families: "messages" }, { reader: "model" }).record!;
    expect(model.hits.map((hit) => hit.from ?? null).sort()).toEqual([null, "Person A", "Person B"].sort());
    expect(model.hits.at(-1)!.from).toBe("Person A");
    expect(model.hits.map((hit) => hit.snippet)).toContain("the user: «harbor» tickets bought");
  });

  it("R17 a chat ref names a chat the index holds; one it holds no fact of is BAD_PARAMETER naming chat", () => {
    const index = indexOfDay("r17");
    const held = ask(index, { query: "receipt", lists: "record", chat: makeRef("chat", { key: CHAT }) }).record!;
    expect(held.hits.map((hit) => hit.snippet!.replace(/[«»]/gu, ""))).toEqual(["Person A: a receipt photo"]);
    let refusal: Refusal | undefined;
    try {
      ask(index, { query: "receipt", lists: "record", chat: makeRef("chat", { key: "whatsapp:15550000009@s.whatsapp.net" }) });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      refusal = error;
    }
    expect([refusal?.status, refusal?.code]).toEqual([422, "BAD_PARAMETER"]);
    expect(refusal!.words).toMatch(/^`chat` names no chat/u);
  });

  it("R18 Ask's own answers do not exist for a model's search: no hit and no near spelling of them; the person's finds them", () => {
    const index = fresh("r18");
    put(index, [
      record("n1", "the lighthouse keeper", D("2026-11-01")),
      record("a1", "the lighthouse keeper keeps marmalade", D("2026-11-02"), "ai", "ask:local:home"),
    ]);
    expect(keysOf(ask(index, { query: "lighthouse", lists: "record" }).record!).sort()).toEqual(["a1", "n1"]);
    const model = ask(index, { query: "lighthouse", lists: "record" }, { reader: "model" }).record!;
    expect([keysOf(model), model.total]).toEqual([["n1"], 1]);
    expect(ask(index, { query: "marmelade", lists: "record" }).variants).toEqual({ marmelade: ["marmalade"] });
    const near = ask(index, { query: "marmelade", lists: "record" }, { reader: "model" });
    expect([near.variants, near.record!.hits]).toEqual([undefined, []]);
  });
});

describe("the kinds route is the person's", () => {
  it("H7 an agent's pass and a turn's are refused /v1/search/kinds, by GET and by POST", () => {
    const passes = [{ kind: "agent" as const }, { kind: null, turn: { id: "turn-a", chat: "1790000000000-a", level: "all" as const, pick: null } }];
    for (const pass of passes) {
      for (const method of ["GET", "POST"]) expect(modelReaches(pass, method, new URL("/v1/search/kinds?query=example", "http://door")), method).toBe(false);
      expect(modelReaches(pass, "POST", new URL("/v1/search", "http://door"))).toBe(true);
    }
  });
});
