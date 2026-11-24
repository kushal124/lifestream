import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { dayBounds, openHomeFolder, type RecordRef } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, RENDERER_VERSION, type DayDocument, type DayFileFact } from "@lifestreamprotocol/families";
import { FACTS_FORMAT, FACTS_SCHEMA, FactsLayer } from "./index-layers.js";
import { Refusal } from "./refusal.js";
import { days } from "./search.js";
import { FORMAT, SearchIndex, type AtomEntry, type IndexedDay, type RecordEntry } from "./search-index.js";
import { STRUCTURE_KEYS } from "./search-words.js";
import type { CountContext } from "./counting.js";
import { countAsked, exactTerms, searchOf, countOf } from "./test/record-reads.js";
import { chatTag } from "./search-scan.js";


const DAY_MS = 86_400_000;
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const A = "2026-10-01";
const B = "2026-10-02";
const C = "2026-10-03";
const X = "whatsapp:15550000001@s.whatsapp.net";
const Y = "whatsapp:15550000002@s.whatsapp.net";
const P1 = "+15550000001";
const P2 = "+15550000002";
const SOURCE = "wa:local:mac-0001";
const scratch = mkdtempSync(join(tmpdir(), "lifestream-index-layers-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let dir: string;
let seq = 0;
beforeEach((context) => {
  dir = join(scratch, context.task.name.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  seq = 0;
});

const ref = (key: string): RecordRef => ({ source: SOURCE, kind: "msg", key });
const text = (key: string, words: string, start_ms: number): RecordEntry => ({
  record: ref(key), family: "messages", version: `v-${key}-${words.length}`, start_ms, end_ms: null, title: "", text: words, who: [], link: null,
});
const line = (n: number, words: string, start_ms: number | null, extra: Partial<AtomEntry> = {}): AtomEntry => ({ n, family: "messages", unit: `u${n}`, start_ms, end_ms: null, text: words, ...extra });
const message = (key: string, at: number, chat: string, lines: number[], who: string[] = [P1], record: string | null = key): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
  keys: { chat, direction: "received" }, measures: {}, who: who.map((handle) => ({ handle, role: "sender" })),
  from: { units: [`messages/${key}`], ...(record === null ? {} : { record: ref(record) }), alone: true }, lines,
});
const call = (key: string, start: number, minutes: number, lines: number[], who: string[] = []): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + minutes * 60_000,
  keys: { service: "whatsapp", direction: "outgoing" }, measures: { minutes }, who: who.map((handle) => ({ handle, role: "receiver" })), from: { units: [`calls/${key}`], accounts: ["wa:local"] }, lines,
});
const payment = (key: string, day: string, amount: string, lines: number[]): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { payee: "CORNER BAKERY", direction: "debit", currency: "EUR" }, measures: { amount }, who: [], from: { units: [`money/${key}`], accounts: ["bank:acct"], instrument: "bank:acct:mac-0001" }, lines,
});
const stay = (key: string, start: number, minutes: number): DayFileFact => ({
  id: `stays:${key.padStart(24, "0")}`, family: "physical", of: "stays", time_ms: start, start_ms: start, end_ms: start + minutes * 60_000,
  keys: { place: "place-a", how: "seen" }, measures: { minutes }, who: [], from: { units: [`physical/${key}`, `physical/${key}-photos`], accounts: ["location:local", "photos:local"] }, lines: [],
});

function fresh(name: string): { index: SearchIndex; file: string } {
  const file = join(dir, name, "index.db");
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return { index: SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 }), file };
}
const put = (index: SearchIndex, puts: RecordEntry[]) => index.records(puts, [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
const dayOf = (day: string, stamp: number, atoms: AtomEntry[], facts: DayFileFact[]): IndexedDay =>
  ({ inputs: `in-${day}-${++seq}`, mtime_us: stamp, atoms, facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts } });
const write = (index: SearchIndex, day: string, stamp: number, atoms: AtomEntry[], facts: DayFileFact[]): IndexedDay => {
  const indexed = dayOf(day, stamp, atoms, facts);
  index.day(day, indexed);
  return indexed;
};

function raw<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}
const all = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).all(...args);

function pairs(db: Database.Database): Record<string, [unknown, unknown]> {
  const stated = new Map<string, { n: number; detail: number }>();
  for (const { key, name } of all(db, "SELECT k.key, n.name FROM fact f JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of JOIN names n ON n.id = k.name") as { key: string; name: string }[]) {
    const counted = stated.get(name) ?? { n: 0, detail: 0 };
    stated.set(name, { n: counted.n + 1, detail: counted.detail + (STRUCTURE_KEYS.has(key) ? 0 : 1) });
  }
  return {
    orphans: [
      [],
      [
        ...all(db, "SELECT 'measure' AS of, fid FROM fact_measure WHERE fid NOT IN (SELECT fid FROM fact)"),
        ...all(db, "SELECT 'line' AS of, fid FROM fact_line WHERE fid NOT IN (SELECT fid FROM fact)"),
        ...all(db, "SELECT 'entry' AS of, fid FROM entry_fact WHERE fid NOT IN (SELECT fid FROM fact)"),
        ...all(db, "SELECT 'states' AS of, slot FROM entry_states WHERE slot NOT IN (SELECT slot FROM entries)"),
        ...all(db, "SELECT 'accounts' AS of, day, atom FROM line_accounts x WHERE NOT EXISTS (SELECT 1 FROM atoms a WHERE a.day = x.day AND a.n = x.atom)"),
      ],
    ],
    values: [
      [...stated].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, counted]) => ({ name, ...counted })),
      all(db, "SELECT name, n, detail FROM names WHERE role = 'value' ORDER BY name"),
    ],
    tally: [
      all(db, "SELECT of, day, combo, crew, source, count(*) AS n, min(time_ms) AS t, max(time_ms) AS u FROM fact GROUP BY of, day, combo, crew, source ORDER BY 1, 2, 3, 4, 5"),
      all(db, "SELECT of, day, combo, crew, source, n, t, u FROM tally ORDER BY 1, 2, 3, 4, 5"),
    ],
    day_total: [
      all(db, "SELECT of, day, source, count(*) AS n, min(time_ms) AS t, max(time_ms) AS u FROM fact GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"),
      all(db, "SELECT of, day, source, n, t, u FROM day_total ORDER BY 1, 2, 3"),
    ],
    totals: [
      all(db, "SELECT of, crew, combo, count(*) AS n, min(day) AS first, max(day) AS last FROM fact GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"),
      all(db, "SELECT of, crew, combo, sum(n) AS n, min(first) AS first, max(last) AS last FROM totals GROUP BY 1, 2, 3 ORDER BY 1, 2, 3"),
    ],
    totals_by_accounts: [
      all(db, "SELECT of, crew, combo, accounts, sum(n) AS n, min(day) AS first, max(day) AS last FROM tally GROUP BY 1, 2, 3, 4 ORDER BY 1, 2, 3, 4"),
      all(db, "SELECT of, crew, combo, accounts, n, first, last FROM totals ORDER BY 1, 2, 3, 4"),
    ],
    crews: [
      all(db, "SELECT crew AS id, count(*) AS n FROM tally WHERE crew > 0 GROUP BY crew ORDER BY 1"),
      all(db, "SELECT id, n FROM crews ORDER BY 1"),
    ],
    counts: [
      all(db, "SELECT 'entries' AS key, count(*) AS n FROM entries UNION ALL SELECT 'unstated', count(*) FROM entries e WHERE NOT EXISTS (SELECT 1 FROM entry_states x WHERE x.slot = e.slot)"),
      all(db, "SELECT key, CAST(value AS INTEGER) AS n FROM meta WHERE key IN ('entries', 'unstated') ORDER BY key"),
    ],
  };
}

function agrees(file: string): void {
  raw(file, (db) => {
    for (const [name, [was, is]] of Object.entries(pairs(db))) expect({ [name]: is }).toEqual({ [name]: was });
  });
}

const entryOf = (db: Database.Database, slot: number): string => {
  const head = db.prepare("SELECT head FROM entries WHERE slot = ?").pluck().get(slot) as number;
  if (head > 0) return `record ${db.prepare("SELECT key FROM records WHERE id = ?").pluck().get(head) as string}`;
  const atom = db.prepare("SELECT day, n FROM atoms WHERE id = ?").get(-head) as { day: string; n: number };
  return `atom ${atom.day} ${atom.n}`;
};

function layer(file: string): Record<string, unknown> {
  return raw(file, (db) => {
    const combo = "(SELECT coalesce(group_concat(k.key || '=' || n.name, ';' ORDER BY k.key), '') FROM combo_keys k JOIN names n ON n.id = k.name WHERE k.combo = x.combo AND k.of = x.of)";
    const crew = "(SELECT coalesce(replace(c.handles, char(30), ';'), '') FROM crews c WHERE c.id = x.crew)";
    const stating = (sql: string) => (db.prepare(sql).all() as { slot: number; id: string }[]).map(({ slot, id }) => `${entryOf(db, slot)} ${id}`).sort();
    const meta = (key: string) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) ?? null;
    return {
      fact: all(db, `SELECT id, of, ${combo} AS combo, ${crew} AS crew, day, time_ms, start_ms, end_ms, date_only, source, record, unit, item, accounts FROM fact x ORDER BY id`),
      measure: all(db, "SELECT f.id, m.measure, m.value FROM fact_measure m JOIN fact f ON f.fid = m.fid ORDER BY 1, 2"),
      line: all(db, "SELECT f.id, l.day, l.atom FROM fact_line l JOIN fact f ON f.fid = l.fid ORDER BY 1, 2, 3"),
      rival: all(db, "SELECT id, day, claim FROM fact_rival ORDER BY id, day"),
      entry_fact: stating("SELECT e.slot, f.id FROM entry_fact e JOIN fact f ON f.fid = e.fid"),
      entry_states: (all(db, "SELECT slot, accounts, who, chat FROM entry_states") as { slot: number; accounts: string; who: string | null; chat: string | null }[])
        .map(({ slot, ...states }) => ({ entry: entryOf(db, slot), ...states })).sort((a, b) => (a.entry < b.entry ? -1 : a.entry > b.entry ? 1 : 0)),
      unstated: (db.prepare("SELECT slot FROM entries e WHERE NOT EXISTS (SELECT 1 FROM entry_states x WHERE x.slot = e.slot)").pluck().all() as number[]).map((slot) => entryOf(db, slot)).sort(),
      line_accounts: all(db, "SELECT day, atom, accounts FROM line_accounts ORDER BY day, atom"),
      tally: all(db, `SELECT of, day, ${combo} AS combo, ${crew} AS crew, source, n, t, u FROM tally x ORDER BY 1, 2, 3, 4, 5`),
      day_total: all(db, "SELECT * FROM day_total ORDER BY 1, 2, 3"),
      totals: all(db, `SELECT of, ${combo} AS combo, ${crew} AS crew, accounts, n, first, last FROM totals x ORDER BY 1, 2, 3, 4`),
      values: all(db, "SELECT name, n, detail FROM names WHERE role = 'value' ORDER BY name"),
      unmarked_values: all(db, "SELECT n.name FROM unmarked_values u JOIN names n ON n.id = u.name ORDER BY 1"),
      slack: meta("slack"), untimed: meta("untimed"), span: meta("span"),
    };
  });
}

function words(file: string): Record<string, unknown> {
  return raw(file, (db) => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fts%' ORDER BY name").pluck().all() as string[];
    return {
      ...Object.fromEntries(tables.filter((table) => table !== "fts").map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY 1`)])),
      ...Object.fromEntries(["entries", "records", "atoms", "skeletons", "unmarked", "days"].map((table) => [table, all(db, `SELECT * FROM ${table} ORDER BY 1`)])),
      names: all(db, "SELECT * FROM names WHERE role != 'value' ORDER BY id"),
    };
  });
}

const otherFacts = (file: string) => {
  const db = new Database(file);
  try {
    db.prepare("UPDATE meta SET value = '0' WHERE key = 'facts_format'").run();
  } finally {
    db.close();
  }
};

function dayA(index: SearchIndex, stamp = 1): IndexedDay {
  put(index, [text("m1", "dinner tonight", D(A, "09:00")), text("m2", "running late", D(A, "10:00")), text("m3", "the lighthouse at noon", D(A, "11:00"))]);
  return write(index, A, stamp, [
    line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
    line(2, "Two messages, one call and a payment", D(A, "12:00")),
    line(3, "Person B: on my way", D(A, "13:00")),
    line(4, "", null, { title: "The day's chats" }),
  ], [
    message("m1", D(A, "09:00"), X, [1, 4]),
    message("m2", D(A, "10:00"), X, [2], [P1, P2]),
    message("m3", D(A, "11:00"), Y, [], [P2]),
    message("m4", D(A, "13:00"), Y, [3], [P2], null),
    call("c1", D(A, "08:00"), 30, [2, 4], [P1]),
    payment("p1", A, "4.50", [2]),
  ]);
}
function dayB(index: SearchIndex, stamp = 1): IndexedDay {
  put(index, [text("n1", "see you friday", D(B, "09:30"))]);
  return write(index, B, stamp, [
    line(1, "Person A: see you friday", D(B, "09:30"), { record: ref("n1") }),
    line(2, "A call with Person A", D(B, "18:00")),
  ], [
    message("n1", D(B, "09:30"), X, [1]),
    message("n2", D(B, "10:30"), X, [], [P1], null),
    call("c2", D(B, "18:00"), 45, [2], [P1]),
    stay("s1", D(B, "08:00"), 780),
  ]);
}

describe("the facts layer", () => {
  it("F1 F2 on seeded days the layer states what the days state, and its tallies, totals and crews are its rows'", () => {
    const { index, file } = fresh("f1");
    try {
      dayA(index);
      agrees(file);
      dayB(index);
      agrees(file);
      raw(file, (db) => {
        expect(db.prepare("SELECT count(*) FROM fact").pluck().get()).toBe(10);
        expect(all(db, "SELECT sum(n) AS n, count(*) AS cells FROM tally WHERE of = 'messages' AND day = ?", A)).toEqual([{ n: 4, cells: 4 }]);
        expect(all(db, "SELECT source, n, t, u FROM day_total WHERE of = 'messages' AND day = ? ORDER BY source", A)).toEqual([
          { source: "", n: 1, t: D(A, "13:00"), u: D(A, "13:00") },
          { source: SOURCE, n: 3, t: D(A, "09:00"), u: D(A, "11:00") },
        ]);
        expect(all(db, `SELECT sum(t.n) AS n, min(t.first) AS first, max(t.last) AS last FROM totals t JOIN crews c ON c.id = t.crew WHERE t.of = 'messages' AND c.handles = ?
          AND t.combo = (SELECT combo FROM fact WHERE id = 'messages:0000000000000000000000m1')`, P1)).toEqual([{ n: 3, first: A, last: B }]);
        expect(all(db, "SELECT f.crew, f.source, m.value FROM fact f JOIN fact_measure m ON m.fid = f.fid WHERE f.of = 'payments'")).toEqual([{ crew: 0, source: "bank:acct:mac-0001", value: 450 }]);
        expect(all(db, "SELECT id, accounts FROM fact WHERE id IN ('messages:0000000000000000000000m1', 'payments:0000000000000000000000p1', 'stays:0000000000000000000000s1') ORDER BY id")).toEqual([
          { id: "messages:0000000000000000000000m1", accounts: null },
          { id: "payments:0000000000000000000000p1", accounts: "bank:acct" },
          { id: "stays:0000000000000000000000s1", accounts: "location:local\x1ephotos:local" },
        ]);
      });
    } finally {
      index.close();
    }
  });

  it("F3 a fact moved between days is the newer render's in both orders of indexing, each day's tally right after every write", () => {
    const F = "messages:0000000000000000000000f1";
    const older = (index: SearchIndex) => write(index, A, 1, [line(1, "Person A: about friday", D(A, "21:00"))], [message("f1", D(A, "21:00"), X, [1], [P1], null)]);
    const newer = (index: SearchIndex) => write(index, B, 2, [line(1, "Person B: friday it is", D(B, "06:00")), line(2, "Later", D(B, "07:00"))], [message("f1", D(B, "06:00"), Y, [1, 2], [P2], null)]);
    const ends: Record<string, unknown> = {};
    for (const order of ["A then B", "B then A"] as const) {
      const { index, file } = fresh(`f3 ${order}`);
      try {
        const steps = order === "A then B" ? [older, newer] : [newer, older];
        steps[0]!(index);
        agrees(file);
        const fid = raw(file, (db) => db.prepare("SELECT fid FROM fact WHERE id = ?").pluck().get(F));
        steps[1]!(index);
        agrees(file);
        raw(file, (db) => {
          expect(all(db, "SELECT day, time_ms FROM fact WHERE id = ?", F)).toEqual([{ day: B, time_ms: D(B, "06:00") }]);
          expect(all(db, "SELECT day, n FROM tally WHERE of = 'messages' ORDER BY day")).toEqual([{ day: B, n: 1 }]);
          expect(all(db, "SELECT l.day, l.atom FROM fact_line l JOIN fact f ON f.fid = l.fid WHERE f.id = ? ORDER BY 1, 2", F)).toEqual([{ day: A, atom: 1 }, { day: B, atom: 1 }, { day: B, atom: 2 }]);
          expect(all(db, "SELECT day, json_extract(claim, '$.lines') AS lines FROM fact_rival WHERE id = ?", F)).toEqual([{ day: A, lines: "[1]" }]);
          if (order === "A then B") expect(db.prepare("SELECT fid FROM fact WHERE id = ?").pluck().get(F)).toBe(fid);
        });
        ends[order] = layer(file);
      } finally {
        index.close();
      }
    }
    expect(ends["B then A"]).toEqual(ends["A then B"]);
  });

  it("F4 an erasure of the day that holds a fact removes it from the layer; come back, it has the lines of the claim that stood aside", () => {
    const F = "messages:0000000000000000000000f1";
    const { index, file } = fresh("f4");
    try {
      write(index, A, 1, [line(1, "Person A: about friday", D(A, "21:00"))], [message("f1", D(A, "21:00"), X, [1], [P1], null)]);
      write(index, B, 2, [line(1, "Person B: friday it is", D(B, "06:00"))], [message("f1", D(B, "06:00"), Y, [1], [P2], null)]);
      index.forget([], [B]);
      agrees(file);
      raw(file, (db) => {
        expect(all(db, "SELECT * FROM fact")).toEqual([]);
        for (const table of ["fact_measure", "fact_line", "entry_fact", "tally", "day_total", "totals", "crews", "crew_members"]) expect({ [table]: all(db, `SELECT * FROM ${table}`) }).toEqual({ [table]: [] });
        expect(all(db, "SELECT day, json_extract(claim, '$.lines') AS lines FROM fact_rival WHERE id = ?", F)).toEqual([{ day: A, lines: "[1]" }]);
      });
      write(index, B, 3, [line(1, "Person B: friday it is", D(B, "06:00"))], [message("f1", D(B, "06:00"), Y, [1], [P2], null)]);
      agrees(file);
      raw(file, (db) => {
        expect(all(db, "SELECT l.day, l.atom FROM fact_line l JOIN fact f ON f.fid = l.fid WHERE f.id = ? ORDER BY 1, 2", F)).toEqual([{ day: A, atom: 1 }, { day: B, atom: 1 }]);
        expect(all(db, "SELECT e.slot FROM entry_fact e JOIN fact f ON f.fid = e.fid WHERE f.id = ?", F)).toHaveLength(2);
      });
    } finally {
      index.close();
    }
  });

  it("F5 a day written twice keeps every fid; written with a measure and a person changed, it counts the new and drops the old crew", () => {
    const { index, file } = fresh("f5");
    try {
      dayA(index);
      const fids = raw(file, (db) => all(db, "SELECT id, fid FROM fact ORDER BY id"));
      dayA(index, 2);
      agrees(file);
      expect(raw(file, (db) => all(db, "SELECT id, fid FROM fact ORDER BY id"))).toEqual(fids);
      write(index, A, 3, [line(2, "A call", D(A, "08:00"))], [call("c1", D(A, "08:00"), 45, [2], [P2])]);
      agrees(file);
      raw(file, (db) => {
        expect(all(db, "SELECT m.value FROM fact_measure m JOIN fact f ON f.fid = m.fid WHERE f.id = 'calls:0000000000000000000000c1'")).toEqual([{ value: 45 }]);
        expect(all(db, "SELECT c.handles FROM fact f JOIN crews c ON c.id = f.crew WHERE f.id = 'calls:0000000000000000000000c1'")).toEqual([{ handles: P2 }]);
        expect(all(db, "SELECT handles, n FROM crews")).toEqual([{ handles: P2, n: 1 }]);
        expect(all(db, "SELECT handle FROM crew_members")).toEqual([{ handle: P2 }]);
      });
    } finally {
      index.close();
    }
  });

  it("F6 totals keep their first and last day when a day at an end loses the pair's last fact", () => {
    const { index, file } = fresh("f6");
    const on = (day: string, stamp: number, keys: string[]) => write(index, day, stamp, [], keys.map((key, at) => message(`${day.slice(-2)}${key}`, D(day, `0${at}:00`), X, [], [P1], null)));
    const ends = () => raw(file, (db) => all(db, "SELECT n, first, last FROM totals WHERE of = 'messages'"));
    try {
      on(A, 1, ["a"]);
      on(B, 1, ["a", "b"]);
      on(C, 1, ["a"]);
      expect(ends()).toEqual([{ n: 4, first: A, last: C }]);
      on(C, 2, []);
      agrees(file);
      expect(ends()).toEqual([{ n: 3, first: A, last: B }]);
      on(A, 2, []);
      agrees(file);
      expect(ends()).toEqual([{ n: 2, first: B, last: B }]);
      on(C, 3, ["a"]);
      expect(ends()).toEqual([{ n: 3, first: B, last: C }]);
      index.forget([], [B, C]);
      agrees(file);
      expect(ends()).toEqual([]);
    } finally {
      index.close();
    }
  });

  it("F7 span is the longest fact of each collection, and never shrinks", () => {
    const { index, file } = fresh("f7");
    const span = () => raw(file, (db) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'span'").pluck().get() as string) as Record<string, number>);
    try {
      dayA(index);
      expect(span()).toEqual({ calls: 30 * 60_000, messages: 0 });
      dayB(index);
      expect(span()).toEqual({ calls: 45 * 60_000, messages: 0, stays: 780 * 60_000 });
      write(index, B, 2, [], [stay("s1", D(B, "08:00"), 60)]);
      expect(span()).toEqual({ calls: 45 * 60_000, messages: 0, stays: 780 * 60_000 });
    } finally {
      index.close();
    }
  });

  it("F13 a fact with only a date sits at its civil day's start under the file's clock and spans that day, its tally with it", () => {
    const clock = { zone: "Asia/Kolkata", day_start_hour: 4 };
    const file = join(dir, "f13", "index.db");
    const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
    built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
    built.finish();
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
    try {
      write(index, A, 1, [], [payment("p1", A, "4.50", [])]);
      const { start_ms, end_ms } = dayBounds(A, clock);
      expect(start_ms).not.toBe(D(A));
      raw(file, (db) => {
        expect(all(db, "SELECT time_ms, start_ms, end_ms, date_only, day FROM fact")).toEqual([{ time_ms: start_ms, start_ms, end_ms, date_only: 1, day: A }]);
        expect(all(db, "SELECT t, u FROM tally")).toEqual([{ t: start_ms, u: start_ms }]);
        expect(all(db, "SELECT t, u FROM day_total")).toEqual([{ t: start_ms, u: start_ms }]);
      });
    } finally {
      index.close();
    }
  });
});

describe("a first build and the kept-up path", () => {
  const clock = { zone: "UTC", day_start_hour: 0 };
  const wordsSaid = (file: string) => raw(file, (db) => {
    const named = (column: string) => `(SELECT name FROM names WHERE id = e.${column}) AS ${column}`;
    return {
      entries: (all(db, `SELECT e.slot, e.dated, e.last, ${["family", "kind", "product", "title", "layer"].map(named).join(", ")} FROM entries e ORDER BY e.slot`) as { slot: number }[])
        .map((entry) => ({ ...entry, is: entryOf(db, entry.slot) })),
      records: all(db, "SELECT source, kind, key, version, family, account, start_ms, end_ms, hash, title, text, who, link, dated, entry FROM records ORDER BY source, kind, key"),
      atoms: all(db, "SELECT day, n, family, unit, item, source, kind, key, start_ms, end_ms, title, line, names, title_names, dated, chat, pictures, same, entry FROM atoms ORDER BY day, n"),
      names: all(db, "SELECT role, name, n FROM names WHERE role != 'value' AND n > 0 ORDER BY role, name"),
      skeletons: all(db, "SELECT word, skeleton FROM skeletons ORDER BY word"),
      unmarked: all(db, "SELECT slot FROM unmarked ORDER BY slot"),
      days: all(db, "SELECT day, inputs, mtime_us FROM days ORDER BY day"),
      position: db.prepare("SELECT value FROM meta WHERE key = 'position'").pluck().get(),
    };
  });
  const found = (index: SearchIndex) => Object.fromEntries(["dinner", "eight", "tonight", "late", "lighthouse", "friday", "call", "payment", "harbour", "person"].map((word) => {
    const answer = searchOf(index, { terms: exactTerms(word), order: "newest", limit: 50 });
    const hits = "hits" in answer ? answer.hits : [];
    return [word, { total: answer.total, hits: hits.map((hit) => ({ layer: hit.layer, ref: hit.ref, title: hit.title, chat: hit.chat ?? null, start_ms: hit.start_ms, who: hit.who })) }];
  }));

  it("F14 give the same file by what it names, and the same answers, for the same records and day files", () => {
    const records = [text("m1", "dinner at eight", D(A, "09:00")), text("m3", "the lighthouse at noon", D(A, "11:00")), text("n1", "see you friday", D(B, "09:30"))];
    const dayAFile = dayOf(A, 2, [
      line(1, "Person A: dinner at eight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
      line(2, "One message, one call and a payment", D(A, "12:00")),
      line(3, "", null, { title: "The day's chats" }),
    ], [
      message("m1", D(A, "09:00"), X, [1, 3]),
      message("m3", D(A, "11:00"), Y, [], [P2]),
      call("c1", D(A, "08:00"), 30, [2, 3], [P1]),
      payment("p1", A, "4.50", [2]),
    ]);
    const dayBFile = dayOf(B, 3, [
      line(1, "Person A: see you friday", D(B, "09:30"), { record: ref("n1") }),
      line(2, "A call with Person A", D(B, "18:00")),
    ], [
      message("n1", D(B, "09:30"), X, [1]),
      message("n2", D(B), X, [], [P1], null),
      call("c2", D(B, "18:00"), 45, [2], [P1]),
    ]);

    const kept = fresh("f14 kept");
    const told = (n: number) => n % 2 === 0;
    let n = 0;
    const one = (puts: RecordEntry[], removes: RecordRef[] = []) => kept.index.records(puts, removes, { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } }, told(n++));
    one([text("m1", "dinner tonight", D(A, "09:00"))]);
    one([text("m2", "running late", D(A, "10:00"))]);
    write(kept.index, A, 1, [
      line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
      line(2, "Person A: running late", D(A, "10:00"), { record: ref("m2"), title: "Chat with Person A" }),
      line(3, "A walk by the harbour", D(A, "15:00")),
    ], [
      message("m1", D(A, "09:00"), X, [1]),
      message("m2", D(A, "10:00"), X, [2], [P1, P2]),
      message("n2", D(B) - 1, X, [], [P1], null),
      payment("p0", A, "9.00", [3]),
    ]);
    one([text("m3", "the lighthouse at noon", D(A, "11:00")), text("n1", "see you friday", D(B, "09:30"))]);
    put(kept.index, [text("q1", "a note from the harbour", D(C, "07:00"))]);
    write(kept.index, C, 1, [line(1, "Person B: a note from the harbour", D(C, "07:00"), { record: ref("q1") })], [message("q1", D(C, "07:00"), Y, [1], [P2])]);
    kept.index.day(B, dayBFile);
    one([text("m1", "dinner at eight", D(A, "09:00"))]);
    one([text("m1", "dinner at eight", D(A, "09:00"))], [ref("m2")]);
    one([], [ref("q1")]);
    kept.index.day(C, null);
    kept.index.day(A, dayAFile);
    kept.index.records([], [], { position: { seq: 1_000, statement: "s-end", reread: 0 } }, true);

    const file = join(dir, "f14 built", "index.db");
    const building = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
    building.records(records, [], { position: { seq: 1_000, statement: "s-end", reread: 0 } }, true);
    building.finish();
    const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, clock);
    try {
      built.day(B, dayBFile);
      built.day(A, dayAFile);
      agrees(kept.file);
      agrees(file);
      const { slack: keptSlack, span: keptSpan, ...keptLayer } = layer(kept.file);
      const { slack: builtSlack, span: builtSpan, ...builtLayer } = layer(file);
      expect(keptLayer).toEqual(builtLayer);
      const wide = (text: unknown) => Object.entries(JSON.parse(text as string) as Record<string, number | { before: number; after: number }>);
      for (const [of, bound] of wide(builtSpan)) expect((JSON.parse(keptSpan as string) as Record<string, number>)[of]).toBeGreaterThanOrEqual(bound as number);
      for (const [of, bound] of wide(builtSlack)) {
        const held = (JSON.parse(keptSlack as string) as Record<string, { before: number; after: number }>)[of]!;
        expect([held.before >= (bound as { before: number }).before, held.after >= (bound as { after: number }).after]).toEqual([true, true]);
      }
      expect(wordsSaid(kept.file)).toEqual(wordsSaid(file));
      expect(found(kept.index)).toEqual(found(built));
      expect(found(built)["tonight"]!.total).toBe(0);
      expect(found(built)["eight"]!.total).toBe(1);
      expect(raw(file, (db) => all(db, "SELECT day FROM fact WHERE id = ?", `messages:${"n2".padStart(24, "0")}`))).toEqual([{ day: B }]);
    } finally {
      built.close();
      kept.index.close();
    }
  });
});

describe("the facts layer made again in place", () => {
  const building = (index: SearchIndex) => index.snapshot({}, (read) => read.building());

  it("F8 a file states both layers' formats; a facts layer of another is made again in place from the days, fts untouched, the same as before", () => {
    const { index: first, file } = fresh("f8");
    let index = first;
    try {
      const formats = () => raw(file, (db) => all(db, "SELECT key, value FROM meta WHERE key IN ('format', 'facts_format') ORDER BY key"));
      expect(formats()).toEqual([{ key: "facts_format", value: FACTS_FORMAT }, { key: "format", value: FORMAT }]);
      const a = dayA(index);
      const b = dayB(index);
      const c = write(index, C, 0, [line(1, "Person A: moved", D(C, "05:00"))], [message("f9", D(C, "05:00"), Y, [1], [P1], null)]);
      const b2 = write(index, B, 5, [...b.atoms, line(3, "Person A: moved", D(B, "23:00"))], [...b.facts!.facts, message("f9", D(B, "23:00"), X, [3], [P1], null)]);
      expect(building(index)).toBeNull();
      agrees(file);
      const before = { layer: layer(file), words: words(file), revision: index.revision() };
      index.close();

      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      raw(file, (db) => {
        for (const table of ["fact", "fact_rival", "entry_fact", "tally", "totals", "crews"]) expect({ [table]: all(db, `SELECT * FROM ${table}`) }).toEqual({ [table]: [] });
        expect(db.prepare("SELECT day FROM facts_owed ORDER BY day").pluck().all()).toEqual([A, B, C]);
      });
      expect(formats()).toEqual([{ key: "facts_format", value: FACTS_FORMAT }, { key: "format", value: FORMAT }]);
      expect(words(file)).toEqual(before.words);
      expect(index.revision()).not.toBe(before.revision);
      expect(building(index)).toEqual({ days: 3 });

      expect(index.factsDay(B, b2)).toBe(true);
      expect(index.factsDay(B, b2)).toBe(false);
      expect(building(index)).toEqual({ days: 2 });
      expect(index.factsDay(C, c)).toBe(true);
      expect(index.factsDay(A, a)).toBe(true);
      expect(building(index)).toEqual({ days: null });
      expect(index.fillStates()).toBe(true);
      expect(index.fillStates()).toBe(false);
      agrees(file);
      expect(building(index)).toBeNull();
      expect(words(file)).toEqual(before.words);
      expect(layer(file)).toEqual(before.layer);
    } finally {
      index.close();
    }
  });

  it("F8 a day written in full while the layer is made leaves the list; a day's file replaced since it was read writes nothing", () => {
    const { index: first, file } = fresh("f8 write");
    let index = first;
    try {
      const a = dayA(index);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.factsDay(A, { ...a, still: () => false })).toBe(false);
      expect(index.factsOwed(10)).toEqual([A]);
      dayA(index, 2);
      expect(index.factsOwed(10)).toEqual([]);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("F9 a day written in full while the layer is made, the rest read after a stop: every entry's chats and people are a fresh build's", () => {
    const older = (index: SearchIndex) => write(index, A, 1, [line(1, "Person A: about friday", D(A, "21:00"))], [message("f1", D(A, "21:00"), X, [1], [P1], null)]);
    const newer = (index: SearchIndex) => write(index, B, 2, [line(1, "Person B: friday it is", D(B, "06:00")), line(2, "Later", D(B, "07:00"))], [message("f1", D(B, "06:00"), Y, [1, 2], [P2], null)]);
    const carried = (file: string) => raw(file, (db) => Object.fromEntries(([["X", `tags : ${chatTag(X)}`], ["Y", `tags : ${chatTag(Y)}`], ["P1", `who : ${P1.slice(1)}`], ["P2", `who : ${P2.slice(1)}`]] as const)
      .map(([name, match]) => [name, (db.prepare("SELECT rowid FROM fts WHERE fts MATCH ?").pluck().all(match) as number[]).map((slot) => entryOf(db, slot)).sort()])));
    const built = fresh("f9 fresh");
    let expected: Record<string, unknown>;
    try {
      older(built.index);
      newer(built.index);
      expected = carried(built.file);
      expect(expected).toEqual({ X: [], Y: [`atom ${A} 1`, `atom ${B} 1`, `atom ${B} 2`], P1: [], P2: [`atom ${A} 1`, `atom ${B} 1`, `atom ${B} 2`] });
    } finally {
      built.index.close();
    }

    const { index: first, file } = fresh("f9 made");
    let index = first;
    try {
      older(index);
      const b = newer(index);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      older(index);
      expect(index.factsOwed(10)).toEqual([B]);
      index.close();
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.factsDay(B, b)).toBe(true);
      expect(index.factsOwed(10)).toEqual([]);
      while (index.statesOwed()) expect(index.fillStates()).toBe(true);
      agrees(file);
      expect(carried(file)).toEqual(expected);
    } finally {
      index.close();
    }
  });

  it("F10 a reader that opens a facts layer of another format first reads none of it: every count building, a search of words answers", () => {
    const { index: first, file } = fresh("f10");
    let index: SearchIndex | undefined = first;
    try {
      dayA(index);
      index.close();
      index = undefined;
      const db = new Database(file);
      try {
        db.prepare("UPDATE meta SET value = '0' WHERE key = 'facts_format'").run();
        for (const table of ["facts_owed", "tally", "totals", "fact_line", "fact"]) db.exec(`DROP TABLE ${table}`);
      } finally {
        db.close();
      }
      index = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
      expect(building(index)).toEqual({ days: null });
      const collections = new Map(Object.entries({ ...MESSAGES_COLLECTIONS, ...CALLS_COLLECTIONS, ...MONEY_COLLECTIONS }));
      const context: CountContext = { collections, settings: { zone: "UTC", day_start_hour: 0 }, now_ms: D(C, "12:00"), people: () => undefined };
      for (const asked of [{ of: "messages" }, { of: "messages", from: "2026-10-01", to: "2026-10-01" }, {}]) {
        let refused: unknown;
        try {
          countOf(index, countAsked(asked, collections), context);
        } catch (error) {
          refused = error;
        }
        expect(refused, JSON.stringify(asked)).toBeInstanceOf(Refusal);
        expect((refused as Refusal).code, JSON.stringify(asked)).toBe("INDEX_BUILDING");
      }
      const found = searchOf(index, { terms: exactTerms("dinner"), order: "relevance", limit: 10 });
      expect("hits" in found ? found.hits.length : -1).toBe(1);
    } finally {
      index?.close();
    }
  });
});

describe("the search job reads the days a facts layer made in place has not read", () => {
  const RUN_DAYS = 20;
  const first = D("2026-09-01");
  const document = (n: number): DayDocument => {
    const start = first + n * DAY_MS;
    const day = new Date(start).toISOString().slice(0, 10);
    const facts: DayFileFact[] = [
      { ...payment(`p${n}`, day, `${n}.25`, [1]) },
      message(`m${n}`, start + 3_600_000, n % 2 === 0 ? X : Y, [2], [P1], null),
    ];
    return {
      day, zone: "UTC", day_start_hour: 0, window: { start_ms: start, end_ms: start + DAY_MS }, renderer: RENDERER_VERSION,
      inputs: `sha256:${createHash("sha256").update(day).digest("hex")}`, counts: { total: 2, per_family: { money: 1, messages: 1 } }, coverage: [],
      atoms: [
        { n: 1, family: "money", unit: `money/p${n}`, start_ms: null, end_ms: null, text: `Paid ${n}.25 at a bakery`, flags: ["date_only"] },
        { n: 2, family: "messages", unit: `messages/m${n}`, start_ms: start + 3_600_000, end_ms: null, text: `Person A: note ${n}` },
      ] as unknown as DayDocument["atoms"],
      facts,
    };
  };
  const place = (root: string, doc: DayDocument, seconds = 1_000_000_000) => {
    const path = join(root, "days", `${doc.day}.day.json`);
    const { atoms, facts, ...head } = doc;
    const list = (items: readonly unknown[]) => items.length === 0 ? "[]" : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
    writeFileSync(path, `{\n${Object.entries(head).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(",\n")},\n  "atoms": ${list(atoms)},\n  "facts": ${list(facts)}\n}\n`);
    utimesSync(path, seconds, seconds);
  };

  it("F8 each run reads at most its count of days, the newest first, and the layer read again is the one before", () => {
    const root = join(dir, "home");
    mkdirSync(join(root, "days"), { recursive: true });
    for (let n = 0; n < RUN_DAYS + 3; n++) place(root, document(n));
    const { index: opened, file } = fresh("f8 job");
    let index = opened;
    const job = () => days(openHomeFolder(root), index, { days: 0 }, performance.now(), RUN_DAYS);
    try {
      expect(job()).toBe(true);
      expect(job()).toBe(false);
      agrees(file);
      const before = { layer: layer(file), words: words(file) };
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      const result = { days: 0 };
      expect(days(openHomeFolder(root), index, result, performance.now(), RUN_DAYS)).toBe(true);
      expect(result.days).toBe(RUN_DAYS);
      expect(index.factsOwed(10)).toEqual(["2026-09-03", "2026-09-02", "2026-09-01"]);
      expect(job()).toBe(false);
      expect(index.factsOwed(10)).toEqual([]);
      agrees(file);
      expect(words(file)).toEqual(before.words);
      expect(layer(file)).toEqual(before.layer);
    } finally {
      index.close();
    }
  });

  it("F11 a day written again unchanged with a new stamp while the layer is made is read under its new stamp, and the layer read through", () => {
    const root = join(dir, "home");
    mkdirSync(join(root, "days"), { recursive: true });
    for (let n = 0; n < 3; n++) place(root, document(n));
    const empty: DayDocument = { ...document(3), counts: { total: 0, per_family: {} }, atoms: [], facts: [] };
    place(root, empty);
    const { index: opened, file } = fresh("f11 job");
    let index = opened;
    const job = () => days(openHomeFolder(root), index, { days: 0 }, performance.now());
    try {
      expect(job()).toBe(false);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.factsOwed(10)).toEqual([empty.day, "2026-09-03", "2026-09-02", "2026-09-01"]);
      place(root, empty, 2_000_000_000);
      expect(job()).toBe(false);
      expect(index.factsOwed(10)).toEqual([]);
      agrees(file);
    } finally {
      index.close();
    }
  });
});

describe("what an entry states", () => {
  const WEB = "chrome:person-a@example.com:mac-0001";
  const PROFILE_A = "chrome:person-a@example.com";
  const PROFILE_B = "chrome:person-b@example.com";
  const PARENT = "whatsapp:15550000000";
  const visit = (key: string, words: string, start_ms: number): RecordEntry => ({
    record: { source: WEB, kind: "visit", key }, family: "web", version: `v-${key}-${words.length}`, start_ms, end_ms: null, title: words, text: "", who: [], link: null,
  });
  const visitLine = (accounts: string[]) => line(1, "Read a page on two profiles", D(A, "09:00"), { family: "web", unit: "web/w1", record: { source: WEB, kind: "visit", key: "w1" }, accounts });
  const states = (file: string) => (layer(file) as { entry_states: unknown[] }).entry_states;

  it("S1 a web entry folding a line from a second profile states both accounts; a reply line its parent's; a lone line its own; who as handle ids", () => {
    const { index, file } = fresh("s1");
    try {
      put(index, [visit("w1", "a page", D(A, "09:00")), text("r2", "yes, see you there", D(A, "10:00")), text("m1", "dinner tonight", D(A, "11:00"))]);
      write(index, A, 1, [
        visitLine([PROFILE_A, PROFILE_B]),
        line(2, "Person A: yes, see you there", D(A, "10:00"), { record: ref("r2"), chat: X, accounts: [PARENT, "wa:local"], names: [{ start: 0, end: 8, who: "phone:+15550000001" }] }),
        line(3, "Person A: dinner tonight", D(A, "11:00"), { record: ref("m1"), chat: X }),
        line(4, "Sat at the desk for an hour", D(A, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] }),
      ], [message("r2", D(A, "10:00"), X, [2], [P1, P2])]);
      agrees(file);
      expect(states(file)).toEqual([
        { entry: `atom ${A} 4`, accounts: "screen:mac-0001", who: null, chat: null },
        { entry: "record m1", accounts: "wa:local", who: null, chat: X },
        { entry: "record r2", accounts: `wa:local\x1e${PARENT}`, who: "phone:+15550000001\x1ephone:+15550000002", chat: X },
        { entry: "record w1", accounts: `${PROFILE_A}\x1e${PROFILE_B}`, who: null, chat: null },
      ]);
      expect(index.unresolved()).toBe(0);
    } finally {
      index.close();
    }
  });

  it("S2 a day rendered again with a folded line's accounts changed rewrites the entry's row; a record's new version reads them again", () => {
    const { index, file } = fresh("s2");
    try {
      put(index, [visit("w1", "a page", D(A, "09:00"))]);
      write(index, A, 1, [visitLine([PROFILE_A, PROFILE_B])], []);
      expect(states(file)).toEqual([{ entry: "record w1", accounts: `${PROFILE_A}\x1e${PROFILE_B}`, who: null, chat: null }]);
      write(index, A, 2, [visitLine([PROFILE_A, "chrome:person-c@example.com"])], []);
      expect(states(file)).toEqual([{ entry: "record w1", accounts: `${PROFILE_A}\x1echrome:person-c@example.com`, who: null, chat: null }]);
      put(index, [visit("w1", "a page, edited", D(A, "09:00"))]);
      expect(states(file)).toEqual([{ entry: "record w1", accounts: `${PROFILE_A}\x1echrome:person-c@example.com`, who: null, chat: null }]);
      write(index, A, 3, [visitLine([PROFILE_A])], []);
      expect(states(file)).toEqual([{ entry: "record w1", accounts: PROFILE_A, who: null, chat: null }]);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S3 a fact's people changed on a record no line prints rewrites the record's row", () => {
    const { index, file } = fresh("s3");
    try {
      put(index, [text("m3", "the lighthouse at noon", D(A, "11:00"))]);
      write(index, A, 1, [], [message("m3", D(A, "11:00"), Y, [], [P1])]);
      expect(states(file)).toEqual([{ entry: "record m3", accounts: "wa:local", who: "phone:+15550000001", chat: Y }]);
      write(index, A, 2, [], [message("m3", D(A, "11:00"), Y, [], [P2])]);
      expect(states(file)).toEqual([{ entry: "record m3", accounts: "wa:local", who: "phone:+15550000002", chat: Y }]);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S4 an entry unstated leaves no row behind: its record dropped, then its day erased", () => {
    const { index, file } = fresh("s4");
    try {
      put(index, [visit("w1", "a page", D(A, "09:00"))]);
      write(index, A, 1, [visitLine([PROFILE_A, PROFILE_B])], []);
      index.records([], [{ source: WEB, kind: "visit", key: "w1" }], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
      expect(states(file)).toEqual([{ entry: `atom ${A} 1`, accounts: `${PROFILE_A}\x1e${PROFILE_B}`, who: null, chat: null }]);
      index.day(A, null);
      raw(file, (db) => {
        expect(all(db, "SELECT * FROM entries")).toEqual([]);
        expect(all(db, "SELECT * FROM entry_states")).toEqual([]);
        expect(all(db, "SELECT * FROM line_accounts")).toEqual([]);
      });
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S5 a fact claimed twice in one day, alone on its record and by a claim that states accounts, states the record's account too", () => {
    const { index, file } = fresh("s5");
    try {
      put(index, [text("m1", "dinner tonight", D(A, "09:00"))]);
      const alone = message("m1", D(A, "09:00"), X, []);
      write(index, A, 1, [], [alone, { ...alone, from: { units: ["messages/m1", "messages/m1-copy"], accounts: [PARENT], record: ref("m1") } }]);
      expect(raw(file, (db) => db.prepare("SELECT accounts FROM fact WHERE id = ?").pluck().get(alone.id))).toBe(`wa:local\x1e${PARENT}`);
    } finally {
      index.close();
    }
  });

  it("S11 an index written before it kept its counts reads none, and fills them from its rows when a writer opens it", () => {
    const { index: first, file } = fresh("s11");
    let index = first;
    try {
      put(index, [visit("w1", "a page", D(A, "09:00")), text("m1", "dinner tonight", D(A, "11:00"))]);
      write(index, A, 1, [visitLine([PROFILE_A])], []);
      index.close();
      const db = new Database(file);
      try {
        db.prepare("DELETE FROM meta WHERE key IN ('entries', 'unstated')").run();
        db.prepare("DELETE FROM entry_states WHERE slot = (SELECT min(slot) FROM entry_states)").run();
      } finally {
        db.close();
      }
      const reader = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
      try {
        expect(reader.unresolved()).toBeNull();
      } finally {
        reader.close();
      }
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.unresolved()).toBe(1);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S6 a facts layer made again in place states every entry once read through, the rows a fresh build's, and counts the entries it has not", () => {
    const { index: first, file } = fresh("s6");
    let index = first;
    try {
      put(index, [visit("w1", "a page", D(A, "09:00")), text("r2", "yes, see you there", D(A, "10:00")), text("q1", "a note from the harbour", D(B, "07:00"))]);
      put(index, [{ ...text("u1", "an undated note", D(A, "08:00")), start_ms: null }]);
      const a = write(index, A, 1, [
        visitLine([PROFILE_A, PROFILE_B]),
        line(2, "Person A: yes, see you there", D(A, "10:00"), { record: ref("r2"), chat: X, accounts: [PARENT, "wa:local"] }),
      ], [message("r2", D(A, "10:00"), X, [2], [P1])]);
      const b = write(index, B, 1, [line(1, "Sat at the desk", D(B, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] })], []);
      const before = layer(file);
      expect(index.unresolved()).toBe(0);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.unresolved()).toBe(5);
      expect(index.factsDay(A, a)).toBe(true);
      expect(index.unresolved()).toBeGreaterThan(0);
      expect(index.factsDay(B, b)).toBe(true);
      expect(index.unresolved()).toBe(5);
      expect(index.fillStates()).toBe(true);
      expect(index.unresolved()).toBe(0);
      expect(layer(file)).toEqual(before);
      agrees(file);
    } finally {
      index.close();
    }
  });
});

describe("an entry's people are handle ids, and a layer made again in place resolves nothing until it is read through", () => {
  const states = (file: string) => (layer(file) as { entry_states: unknown[] }).entry_states;
  const building = (index: SearchIndex) => index.snapshot({}, (read) => read.building());
  const PARENT = "whatsapp:15550000000";

  it("S7 a copy's who, a fact's people and a line's people, by phone, email and WhatsApp LID, each state one handle id", () => {
    const { index, file } = fresh("s7");
    try {
      put(index, [{ ...text("r1", "hello both", D(A, "09:00")), who: ["person-b@example.com", "123456@lid", "+15550000002"] }]);
      write(index, A, 1, [
        line(1, "Person D, Person E, Person G: hello both", D(A, "09:00"), {
          record: ref("r1"), chat: X,
          names: [{ start: 0, end: 8, who: "email:person-d@example.com" }, { start: 10, end: 18, who: "jid:777777@lid" }, { start: 20, end: 28, who: "phone:+15550000003" }],
        }),
        line(2, "A call with Person F", D(A, "18:00"), { family: "calls", accounts: ["wa:local"] }),
      ], [
        message("r1", D(A, "09:00"), X, [1], ["email:person-c@example.com", "jid:654321@lid", "phone:+15550000001"]),
        call("c1", D(A, "18:00"), 20, [2], ["email:person-f@example.com", "jid:888888@lid"]),
      ]);
      expect(states(file)).toEqual([
        { entry: `atom ${A} 2`, accounts: "wa:local", who: "email:person-f@example.com\x1ejid:888888@lid", chat: null },
        {
          entry: "record r1", accounts: "wa:local", chat: X,
          who: [
            "email:person-b@example.com", "email:person-c@example.com", "email:person-d@example.com", "jid:123456@lid", "jid:654321@lid", "jid:777777@lid",
            "phone:+15550000001", "phone:+15550000002", "phone:+15550000003",
          ].join("\x1e"),
        },
      ]);
    } finally {
      index.close();
    }
  });

  it("S10 a call line names no chat, its fact does: the hit prints the fact's chat, and the row states it", () => {
    const { index, file } = fresh("s10");
    try {
      const inGroup = call("c1", D(A, "18:00"), 20, [1], ["jid:888888@lid"]);
      write(index, A, 1, [line(1, "WhatsApp call with Person F in the group", D(A, "18:00"), { family: "calls", accounts: ["wa:local"] })], [{ ...inGroup, keys: { ...inGroup.keys, chat: Y } }]);
      expect(states(file)).toEqual([{ entry: `atom ${A} 1`, accounts: "wa:local", who: "jid:888888@lid", chat: Y }]);
      const found = searchOf(index, { terms: exactTerms("group"), order: "relevance", limit: 10 });
      expect("hits" in found ? found.hits.map((hit) => hit.chat) : []).toEqual([Y]);
    } finally {
      index.close();
    }
  });

  it("S8 a record's new version while the layer is made again writes a row from what is read so far; every entry reads unresolved until the layer and its fill are through", () => {
    const { index: first, file } = fresh("s8");
    let index = first;
    try {
      put(index, [text("r2", "yes, see you there", D(A, "10:00"))]);
      const a = write(index, A, 1, [line(1, "Person A: yes, see you there", D(A, "10:00"), { record: ref("r2"), chat: X, accounts: [PARENT, "wa:local"] })], [message("r2", D(A, "10:00"), X, [1])]);
      const b = write(index, B, 1, [line(1, "Sat at the desk", D(B, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] })], []);
      expect(index.unresolved()).toBe(0);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(building(index)).toEqual({ days: 2 });
      put(index, [text("r2", "yes, see you there at eight", D(A, "10:00"))]);
      expect(states(file)).toEqual([{ entry: "record r2", accounts: "wa:local", who: null, chat: X }]);
      expect(index.unresolved()).toBe(2);
      expect(index.factsDay(A, a)).toBe(true);
      expect(states(file)).toEqual([{ entry: "record r2", accounts: `wa:local\x1e${PARENT}`, who: "phone:+15550000001", chat: X }]);
      expect(index.unresolved()).toBe(2);
      expect(index.factsDay(B, b)).toBe(true);
      expect(building(index)).toEqual({ days: null });
      expect(index.unresolved()).toBe(2);
      expect(index.fillStates()).toBe(true);
      expect(building(index)).toBeNull();
      expect(index.unresolved()).toBe(0);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S9 a fill larger than its batch takes one transaction a batch, the layer owed between them", () => {
    const { index: first, file } = fresh("s9");
    let index = first;
    try {
      put(index, ["q1", "q2", "q3", "q4", "q5"].map((key, n) => text(key, `a note ${key}`, D(A, `0${n + 1}:00`))));
      const a = write(index, A, 1, [line(1, "Sat at the desk", D(A, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] })], []);
      const before = layer(file);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      expect(index.fillStates(2)).toBe(false);
      expect(index.factsDay(A, a)).toBe(true);
      const stated = () => raw(file, (db) => db.prepare("SELECT count(*) FROM entry_states").pluck().get());
      expect(stated()).toBe(1);
      const filled: unknown[] = [];
      while (index.statesOwed()) {
        const revision = index.revision();
        expect(index.fillStates(2)).toBe(true);
        expect(index.revision()).not.toBe(revision);
        filled.push({ stated: stated(), owed: index.statesOwed(), building: building(index), unresolved: index.unresolved() });
      }
      expect(filled).toEqual([
        { stated: 3, owed: true, building: { days: null }, unresolved: 6 },
        { stated: 5, owed: true, building: { days: null }, unresolved: 6 },
        { stated: 6, owed: false, building: null, unresolved: 0 },
      ]);
      expect(index.fillStates(2)).toBe(false);
      expect(layer(file)).toEqual(before);
      agrees(file);
    } finally {
      index.close();
    }
  });

  it("S12 the entries written while the layer is made again are written again a batch a transaction once it is read through, the layer owed until the last", () => {
    const { index: first, file } = fresh("s12");
    let index = first;
    try {
      const keys = ["q1", "q2", "q3", "q4", "q5"];
      put(index, keys.map((key, n) => text(key, `a note ${key}`, D(A, `0${n + 1}:00`))));
      const a = write(index, A, 1, [line(1, "Sat at the desk", D(A, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] })], []);
      index.close();
      otherFacts(file);
      index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, { zone: "UTC", day_start_hour: 0 });
      put(index, keys.map((key, n) => text(key, `a later note ${key}`, D(A, `0${n + 1}:00`))));
      const stale = () => raw(file, (db) => db.prepare("SELECT count(*) FROM facts_stale").pluck().get());
      expect(stale()).toBe(5);
      expect(index.factsDay(A, a)).toBe(true);
      expect(stale()).toBe(5);
      const filled: unknown[] = [];
      while (index.statesOwed()) {
        expect(index.fillStates(2)).toBe(true);
        filled.push({ stale: stale(), building: building(index) });
      }
      expect(filled).toEqual([
        { stale: 3, building: { days: null } },
        { stale: 1, building: { days: null } },
        { stale: 0, building: null },
      ]);
      expect(index.fillStates(2)).toBe(false);
      const fresher = fresh("s12 fresh");
      try {
        put(fresher.index, keys.map((key, n) => text(key, `a later note ${key}`, D(A, `0${n + 1}:00`))));
        write(fresher.index, A, 1, [line(1, "Sat at the desk", D(A, "12:00"), { family: "screen", accounts: ["screen:mac-0001"] })], []);
        expect(layer(file)).toEqual(layer(fresher.file));
      } finally {
        fresher.index.close();
      }
      agrees(file);
    } finally {
      index.close();
    }
  });
});

describe("a day's recount", () => {
  it("F12 reads and removes its own tally rows alone: every statement of it a search of an index, none a scan of a table", () => {
    const db = new Database(":memory:");
    try {
      db.exec(FACTS_SCHEMA);
      const statements = new Set<string>();
      const facts = new FactsLayer((sql) => {
        statements.add(sql);
        return db.prepare(sql);
      }, () => 1, () => false);
      const fact = db.prepare(`INSERT INTO fact (id, of, combo, crew, day, time_ms, start_ms, end_ms, date_only, source, record, unit, item)
        VALUES (?, 'messages', ?, 0, ?, ?, ?, ?, 0, '', NULL, 'u', NULL)`);
      for (const [n, day] of [A, B, C].entries()) for (const combo of [1, 2]) fact.run(`messages:${day}-${combo}`, combo, day, D(day, `0${n}:00`), D(day, `0${n}:00`), D(day, `0${n}:00`));
      for (const day of [A, B, C]) facts.tally(day);
      db.prepare("DELETE FROM fact WHERE day = ? AND combo = 2").run(C);
      facts.tally(C);
      facts.tally(B);
      const scans: string[] = [];
      for (const sql of statements) {
        const bound = Array.from({ length: (sql.match(/\?/gu) ?? []).length }, () => A);
        for (const { detail } of db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...bound) as { detail: string }[]) if (/^SCAN /u.test(detail)) scans.push(`${detail}: ${sql.replace(/\s+/gu, " ")}`);
      }
      expect(scans).toEqual([]);
      expect([...statements].some((sql) => /FROM tally WHERE day = \?/u.test(sql))).toBe(true);
    } finally {
      db.close();
    }
  });
});
