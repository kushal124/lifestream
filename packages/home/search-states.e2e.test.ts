import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { DaySettings, RecordRef } from "@lifestreamprotocol/core";
import type { DayFileFact } from "@lifestreamprotocol/families";
import { SearchIndex, type AtomEntry, type IndexedDay, type RecordEntry } from "./search-index.js";
import { chatTag } from "./search-scan.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const DAY_MS = 86_400_000;
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const A = "2026-10-01";
const B = "2026-10-02";
const X = "whatsapp:15550000001@s.whatsapp.net";
const Y = "whatsapp:15550000002@s.whatsapp.net";
const SOURCE = "wa:local:mac-0001";
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-states-"));
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
const message = (key: string, at: number, chat: string, lines: number[], record: string | null = key): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
  keys: { chat, direction: "received" }, measures: {}, who: [{ handle: "+15550000001", role: "sender" }],
  from: { units: [`messages/${key}`], ...(record === null ? {} : { record: ref(record) }), alone: true }, lines,
});
const call = (key: string, start: number, minutes: number, lines: number[]): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + minutes * 60_000,
  keys: { service: "whatsapp", direction: "outgoing" }, measures: { minutes }, who: [], from: { units: [`calls/${key}`] }, lines,
});
const payment = (key: string, day: string, lines: number[]): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { payee: "CORNER BAKERY", direction: "debit", currency: "EUR" }, measures: { amount: "4.50" }, who: [], from: { units: [`money/${key}`] }, lines,
});

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };

function fresh(name: string): { index: SearchIndex; file: string } {
  const file = join(dir, name, "index.db");
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return { index: SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC), file };
}
const put = (index: SearchIndex, puts: RecordEntry[]) => index.records(puts, [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
const write = (index: SearchIndex, day: string, stamp: number, atoms: AtomEntry[], facts: DayFileFact[]) =>
  index.day(day, { inputs: `in-${day}-${++seq}`, mtime_us: stamp, atoms, facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts } });

function raw<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function oracle(db: Database.Database): Map<number, string[]> {
  const head = db.prepare("SELECT head FROM entries WHERE slot = ?").pluck();
  const record = db.prepare("SELECT * FROM records WHERE id = ?");
  const copiesOf = db.prepare("SELECT * FROM records WHERE account = ? AND kind = ? AND key = ? AND hash = ? ORDER BY id");
  const atom = db.prepare("SELECT * FROM atoms WHERE id = ?");
  const atomsOf = db.prepare("SELECT * FROM atoms WHERE source = ? AND kind = ? AND key = ?");
  const ofRecords = db.prepare("SELECT id FROM fact WHERE of = ? AND record IN (SELECT value FROM json_each(?))").pluck();
  const ofLine = db.prepare("SELECT f.id FROM fact_line l JOIN fact f ON f.fid = l.fid WHERE l.day = ? AND l.atom = ? AND f.of = ?").pluck();
  const collections = db.prepare("SELECT DISTINCT of FROM fact").pluck().all() as string[];
  type Row = { source: string; account: string; kind: string; key: string; hash: string; day: string; n: number };
  const out = new Map<number, string[]>();
  for (const slot of db.prepare("SELECT slot FROM entries").pluck().all() as number[]) {
    const at = head.get(slot) as number;
    const found = new Set<string>();
    for (const of of collections) {
      let atoms: Row[];
      if (at < 0) atoms = [atom.get(-at) as Row];
      else {
        const first = record.get(at) as Row;
        const copies = copiesOf.all(first.account, first.kind, first.key, first.hash) as Row[];
        atoms = copies.flatMap((copy) => atomsOf.all(copy.source, copy.kind, copy.key) as Row[]);
        for (const fact of ofRecords.all(of, JSON.stringify(copies.map((copy) => `${copy.source}\0${copy.kind}\0${copy.key}`))) as string[]) found.add(fact);
      }
      for (const each of atoms) for (const fact of ofLine.all(each.day, each.n, of) as string[]) found.add(fact);
    }
    if (found.size > 0) out.set(slot, [...found].sort());
  }
  return out;
}

function stated(db: Database.Database): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const { slot, fact } of db.prepare("SELECT e.slot, f.id AS fact FROM entry_fact e JOIN fact f ON f.fid = e.fid ORDER BY 1, 2").all() as { slot: number; fact: string }[]) {
    out.set(slot, [...out.get(slot) ?? [], fact]);
  }
  return out;
}

const KEYS = "(SELECT coalesce(group_concat(k.key || '=' || n.name, ';' ORDER BY k.key), '') FROM combo_keys k JOIN names n ON n.id = k.name WHERE k.combo = f.combo AND k.of = f.of)";
const tagged = (db: Database.Database, chat: string) => (db.prepare("SELECT rowid FROM fts WHERE fts MATCH ? ORDER BY rowid").pluck().all(`tags : ${chatTag(chat)}`) as number[]);
const ofChat = (db: Database.Database, chat: string) => db.prepare(`SELECT DISTINCT e.slot FROM entry_fact e JOIN fact f ON f.fid = e.fid
  JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of AND k.key = 'chat' JOIN names n ON n.id = k.name WHERE n.name = ? ORDER BY e.slot`).pluck().all(chat) as number[];
const entryOf = (db: Database.Database, slot: number): string => {
  const head = db.prepare("SELECT head FROM entries WHERE slot = ?").pluck().get(slot) as number;
  if (head > 0) return `record ${db.prepare("SELECT key FROM records WHERE id = ?").pluck().get(head) as string}`;
  const atom = db.prepare("SELECT day, n FROM atoms WHERE id = ?").get(-head) as { day: string; n: number };
  return `atom ${atom.day} ${atom.n}`;
};
function rowsOf(file: string, fact: string): Record<string, unknown> {
  return raw(file, (db) => ({
    facts: db.prepare("SELECT id, of, day, time_ms, start_ms, end_ms, record FROM fact WHERE id = ?").all(fact),
    keys: db.prepare(`SELECT ${KEYS} AS keys FROM fact f WHERE f.id = ?`).all(fact),
    who: db.prepare("SELECT c.handles FROM fact f JOIN crews c ON c.id = f.crew WHERE f.id = ?").all(fact),
    measures: db.prepare("SELECT m.measure, m.value FROM fact_measure m JOIN fact f ON f.fid = m.fid WHERE f.id = ? ORDER BY 1").all(fact),
    lines: db.prepare("SELECT l.day, l.atom FROM fact_line l JOIN fact f ON f.fid = l.fid WHERE f.id = ? ORDER BY 1, 2").all(fact),
    stating: (db.prepare("SELECT e.slot FROM entry_fact e JOIN fact f ON f.fid = e.fid WHERE f.id = ?").pluck().all(fact) as number[]).map((slot) => entryOf(db, slot)).sort(),
    x: tagged(db, X).map((slot) => entryOf(db, slot)).sort(),
    y: tagged(db, Y).map((slot) => entryOf(db, slot)).sort(),
  }));
}
function snapshot(file: string): Record<string, unknown> {
  const byEntry = (rows: [string, unknown][]) => rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sorted = (rows: unknown[]) => rows.map((row) => JSON.stringify(row)).sort();
  return raw(file, (db) => {
    const combos = new Map((db.prepare(`SELECT k.combo, group_concat(k.key || '=' || n.name, ';' ORDER BY k.key) AS keys FROM combo_keys k JOIN names n ON n.id = k.name
      GROUP BY k.combo`).all() as { combo: number; keys: string }[]).map(({ combo, keys }) => [combo, keys]));
    const crews = new Map((db.prepare("SELECT id, handles FROM crews").all() as { id: number; handles: string }[]).map(({ id, handles }) => [id, handles]));
    const comboOf = (id: number) => combos.get(id) ?? "";
    const crewOf = (id: number) => (id === 0 ? "" : crews.get(id) ?? `missing ${id}`);
    return {
      ...facts(db),
      tally: sorted((db.prepare("SELECT of, day, combo, crew, source, n, t, u FROM tally").all() as { combo: number; crew: number }[])
        .map((row) => ({ ...row, combo: comboOf(row.combo), crew: crewOf(row.crew) }))),
      totals: sorted((db.prepare("SELECT of, crew, combo, n FROM totals").all() as { combo: number; crew: number }[])
        .map((row) => ({ ...row, combo: comboOf(row.combo), crew: crewOf(row.crew) }))),
      day_total: db.prepare("SELECT of, day, source, n, t, u FROM day_total ORDER BY of, day, source").all(),
      crews: db.prepare("SELECT handles, n FROM crews ORDER BY handles").all(),
    };
  });
  function facts(db: Database.Database): Record<string, unknown> {
    return {
      facts: db.prepare(`SELECT f.id, f.of, f.day, f.time_ms, f.start_ms, f.end_ms, f.record, ${KEYS} AS keys, coalesce(c.handles, '') AS who FROM fact f LEFT JOIN crews c ON c.id = f.crew ORDER BY f.id`).all(),
      measures: db.prepare("SELECT f.id, m.measure, m.value FROM fact_measure m JOIN fact f ON f.fid = m.fid ORDER BY 1, 2").all(),
      lines: db.prepare("SELECT f.id, l.day, l.atom FROM fact_line l JOIN fact f ON f.fid = l.fid ORDER BY 1, 2, 3").all(),
      rivals: db.prepare("SELECT id, day, claim FROM fact_rival ORDER BY id, day").all(),
      stated: byEntry([...stated(db)].map(([slot, facts]) => [entryOf(db, slot), facts])),
      x: tagged(db, X).map((slot) => entryOf(db, slot)).sort(),
      y: tagged(db, Y).map((slot) => entryOf(db, slot)).sort(),
    };
  }
}
const lastWritten = (file: string) => raw(file, (db) => db.prepare("SELECT max(n) FROM unmarked").pluck().get() as number);
const writtenSince = (file: string, n: number) => raw(file, (db) => (db.prepare("SELECT slot FROM unmarked WHERE n > ?").pluck().all(n) as number[]).map((slot) => entryOf(db, slot)).sort());

function dayA(index: SearchIndex, stamp = 1): void {
  put(index, [text("m1", "dinner tonight", D(A, "09:00")), text("m2", "running late", D(A, "10:00")), text("m3", "the lighthouse at noon", D(A, "11:00"))]);
  write(index, A, stamp, [
    line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
    line(2, "Three messages, one call and a payment", D(A, "12:00")),
    line(3, "Person B: on my way", D(A, "13:00")),
    line(4, "", null, { title: "The day's chats" }),
  ], [
    message("m1", D(A, "09:00"), X, [1, 4]),
    message("m2", D(A, "10:00"), X, [2]),
    message("m3", D(A, "11:00"), Y, []),
    message("m4", D(A, "13:00"), Y, [3], null),
    call("c1", D(A, "08:00"), 30, [2, 4]),
    payment("p1", A, [2]),
  ]);
}

describe("what an entry states", () => {
  it("E1 an entry's rows in entry_fact are the facts the words' reach found, entry by entry", () => {
    const { index, file } = fresh("e1");
    try {
      dayA(index);
      put(index, [{ ...text("m3", "the lighthouse at noon", D(A, "11:00")), record: { ...ref("m3"), source: "wa:local:iphone-0042" } }]);
      write(index, B, 2, [line(1, "Person A: running late, still", D(B, "08:00"))], [message("m5", D(B, "08:00"), X, [1], null), { ...message("m2", D(A, "10:00"), X, [1]) }]);
      raw(file, (db) => {
        const want = oracle(db);
        expect(want.size).toBeGreaterThanOrEqual(6);
        expect(stated(db)).toEqual(want);
        const by = new Map([...stated(db)].map(([slot, facts]) => [entryOf(db, slot), facts]));
        expect(by.get("record m1")).toEqual(["messages:0000000000000000000000m1"]);
        expect(by.get("atom 2026-10-01 2")).toEqual(["calls:0000000000000000000000c1", "messages:0000000000000000000000m2", "payments:0000000000000000000000p1"]);
        expect(by.get("record m2")).toEqual(["messages:0000000000000000000000m2"]);
        expect(by.get("record m3")).toEqual(["messages:0000000000000000000000m3"]);
        expect(by.get("atom 2026-10-02 1")).toEqual(["messages:0000000000000000000000m2", "messages:0000000000000000000000m5"]);
      });
    } finally {
      index.close();
    }
  });

  it("E2 a match of a chat's tag returns exactly the entries that state a fact of the chat", () => {
    const { index, file } = fresh("e2");
    try {
      dayA(index);
      raw(file, (db) => {
        for (const chat of [X, Y]) {
          expect(ofChat(db, chat).length).toBeGreaterThan(0);
          expect(tagged(db, chat)).toEqual(ofChat(db, chat));
        }
        expect(tagged(db, "whatsapp:15550000009@s.whatsapp.net")).toEqual([]);
      });
    } finally {
      index.close();
    }
  });

  it("E3 a fact that moves to another day with another chat retags the line that prints it, in both orders; a fact's old record loses it", () => {
    const moved = (lines: number[]) => message("m9", D(B, "07:00"), Y, lines, null);
    const atomsA = [line(1, "Person A: see you there", D(A, "20:00"))];
    for (const order of ["A first", "B first"] as const) {
      const { index, file } = fresh(`e3 ${order}`);
      try {
        write(index, A, 1, atomsA, [message("m9", D(A, "20:00"), X, [1], null)]);
        expect(rowsOf(file, "messages:0000000000000000000000m9")).toMatchObject({ x: ["atom 2026-10-01 1"], y: [] });
        if (order === "A first") write(index, A, 2, atomsA, [moved([1])]);
        write(index, B, 2, [line(1, "Person B: the plan moved", D(B, "07:00"))], [moved([1])]);
        expect(rowsOf(file, "messages:0000000000000000000000m9")).toMatchObject({ x: [], y: ["atom 2026-10-01 1", "atom 2026-10-02 1"] });
        if (order === "B first") write(index, A, 2, atomsA, [moved([1])]);
        expect(rowsOf(file, "messages:0000000000000000000000m9")).toMatchObject({ facts: [{ day: B }], x: [], y: ["atom 2026-10-01 1", "atom 2026-10-02 1"] });
      } finally {
        index.close();
      }
    }
    const { index, file } = fresh("e3 record");
    try {
      put(index, [text("r1", "first words", D(A, "09:00")), text("r2", "second words", D(A, "10:00"))]);
      write(index, A, 1, [], [message("m8", D(A, "09:30"), X, [], "r1")]);
      expect(rowsOf(file, "messages:0000000000000000000000m8")).toMatchObject({ stating: ["record r1"], x: ["record r1"] });
      write(index, A, 2, [], [message("m8", D(A, "09:30"), X, [], "r2")]);
      expect(rowsOf(file, "messages:0000000000000000000000m8")).toMatchObject({ stating: ["record r2"], x: ["record r2"] });
    } finally {
      index.close();
    }
  });

  it("E4 a fact's accepted statement is the newest render's whatever the order; erasing its owner removes it and its reach", () => {
    const F = "messages:0000000000000000000000f1";
    const older = (index: SearchIndex) => write(index, A, 1, [line(1, "Person A: about friday", D(A, "21:00"))], [{ ...message("f1", D(A, "21:00"), X, [1], null), measures: { words: 3 } }]);
    const newer = (index: SearchIndex) => write(index, B, 2, [line(1, "Person B: friday it is", D(B, "06:00"))], [{ ...message("f1", D(B, "06:00"), Y, [1], null), measures: { words: 4 } }]);
    const steps: Record<string, Record<string, unknown>[]> = {};
    for (const order of ["B then A", "A then B"] as const) {
      const { index, file } = fresh(`e4 ${order}`);
      const seen: Record<string, unknown>[] = [];
      try {
        if (order === "B then A") {
          newer(index);
          older(index);
        } else {
          older(index);
          newer(index);
        }
        const both = rowsOf(file, F);
        expect(both).toMatchObject({ facts: [{ day: B }], measures: [{ measure: "words", value: 4 }], x: [], y: ["atom 2026-10-01 1", "atom 2026-10-02 1"] });
        seen.push(both);
        index.forget([], [B]);
        const erased = rowsOf(file, F);
        expect(erased).toEqual({ facts: [], keys: [], who: [], measures: [], lines: [], stating: [], x: [], y: [] });
        seen.push(erased);
        steps[order] = seen;
      } finally {
        index.close();
      }
    }
    expect(steps["A then B"]).toEqual(steps["B then A"]);

    for (const order of ["A first", "B first"] as const) {
      const { index, file } = fresh(`e4 one stamp ${order}`);
      try {
        const onA = () => write(index, A, 5, [], [message("g1", D(A, "22:00"), X, [], null)]);
        const onB = () => write(index, B, 5, [], [message("g1", D(B, "05:00"), Y, [], null)]);
        if (order === "A first") {
          onA();
          onB();
        } else {
          onB();
          onA();
        }
        expect(rowsOf(file, "messages:0000000000000000000000g1")).toMatchObject({ facts: [{ day: B, time_ms: D(B, "05:00") }], keys: [{ keys: `chat=${Y};direction=received` }] });
      } finally {
        index.close();
      }
    }
  });

  it("E5 one fact of a line replaced by another of the same chat rewrites that entry alone; a day written again unchanged rewrites none", () => {
    const { index, file } = fresh("e5");
    try {
      dayA(index);
      const facts = (third: DayFileFact) => [
        message("m1", D(A, "09:00"), X, [1, 4]), message("m2", D(A, "10:00"), X, [2]), message("m3", D(A, "11:00"), Y, []), third,
        call("c1", D(A, "08:00"), 30, [2, 4]), payment("p1", A, [2]),
      ];
      const atoms = [
        line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
        line(2, "Three messages, one call and a payment", D(A, "12:00")),
        line(3, "Person B: on my way", D(A, "13:00")),
        line(4, "", null, { title: "The day's chats" }),
      ];
      const before = lastWritten(file);
      write(index, A, 2, atoms, facts(message("m4", D(A, "13:00"), Y, [3], null)));
      expect(lastWritten(file)).toBe(before);
      write(index, A, 3, atoms, facts(message("m6", D(A, "13:00"), Y, [3], null)));
      expect(writtenSince(file, before)).toEqual(["atom 2026-10-01 3"]);
      raw(file, (db) => expect(stated(db)).toEqual(oracle(db)));
    } finally {
      index.close();
    }
  });

  it("E6 slack bounds every pair of entry_fact whose entry has a time, through a fact's span grown; untimed counts the entries with none", () => {
    const { index, file } = fresh("e6");
    const holds = (least = 6) => raw(file, (db) => {
      const meta = (key: string) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) as string ?? "{}") as Record<string, unknown>;
      const slack = meta("slack") as Record<string, { before: number; after: number }>;
      const untimed = meta("untimed") as Record<string, number>;
      const pairs = db.prepare("SELECT e.slot, f.of, f.day, f.start_ms, f.end_ms, f.date_only FROM entry_fact e JOIN fact f ON f.fid = e.fid").all() as
        { slot: number; of: string; day: string; start_ms: number; end_ms: number; date_only: number }[];
      const counted: Record<string, Set<number>> = {};
      let timed = 0;
      for (const pair of pairs) {
        if (pair.slot < -9_000_000_000_000 * 1000) {
          (counted[pair.of] ??= new Set()).add(pair.slot);
          continue;
        }
        timed++;
        const p = Math.floor(pair.slot / 1000);
        const [a, b] = pair.date_only === 1 ? [D(pair.day), D(pair.day) + DAY_MS] : [pair.start_ms, pair.end_ms];
        expect(slack[pair.of]!.before).toBeGreaterThanOrEqual(b - p);
        expect(slack[pair.of]!.after).toBeGreaterThanOrEqual(p - a);
      }
      expect(timed).toBeGreaterThanOrEqual(least);
      expect(untimed).toEqual(Object.fromEntries(Object.entries(counted).map(([of, slots]) => [of, slots.size])));
      return { slack, untimed };
    });
    try {
      dayA(index);
      const first = holds();
      expect(first.untimed).toEqual({ messages: 1, calls: 1 });
      expect(first.slack["calls"]!.after).toBeGreaterThanOrEqual(4 * 3_600_000);
      expect(first.slack["payments"]!.before).toBeGreaterThanOrEqual(12 * 3_600_000);
      const before = lastWritten(file);
      write(index, A, 2, [
        line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
        line(2, "Three messages, one call and a payment", D(A, "12:00")),
        line(3, "Person B: on my way", D(A, "13:00")),
        line(4, "", null, { title: "The day's chats" }),
      ], [
        message("m1", D(A, "09:00"), X, [1, 4]), message("m2", D(A, "10:00"), X, [2]), message("m3", D(A, "11:00"), Y, []),
        message("m4", D(A, "13:00"), Y, [3], null), call("c1", D(A, "08:00"), 900, [2, 4]), payment("p1", A, [2]),
      ]);
      expect(lastWritten(file)).toBe(before);
      expect(holds().slack["calls"]!.before).toBeGreaterThanOrEqual(11 * 3_600_000);
      write(index, A, 3, [
        line(1, "Person A: dinner tonight", D(A, "09:00"), { record: ref("m1"), title: "Chat with Person A" }),
        line(2, "Three messages, one call and a payment", D(A, "12:00")),
        line(3, "Person B: on my way", D(A, "13:00")),
        line(4, "", null, { title: "The day's chats" }),
      ], [
        message("m1", D(A, "09:00"), X, [1, 4]), message("m2", D(A, "10:00"), X, [2]), message("m3", D(A, "11:00"), Y, []),
        message("m4", D(A, "13:00"), Y, [3], null), call("c1", D(A, "08:00"), 900, [2]), payment("p1", A, [2]),
      ]);
      expect(writtenSince(file, before)).toEqual(["atom 2026-10-01 4"]);
      expect(holds().untimed).toEqual({ messages: 1 });
      index.forget([], [A]);
      expect(holds(0).untimed).toEqual({});
    } finally {
      index.close();
    }
  });

  it("E7 a day written again unchanged is judged again under its new stamp: the facts are the files', whatever the history of indexing", () => {
    const F = "messages:0000000000000000000000f1";
    const dayOfA = (stamp: number): IndexedDay => ({
      inputs: "in-A", mtime_us: stamp, atoms: [line(1, "Person A: about friday", D(A, "21:00")), line(2, "Person A: and the tickets", D(A, "22:00"))],
      facts: { window: { start_ms: D(A), end_ms: D(A) + DAY_MS }, facts: [message("f1", D(A, "21:00"), X, [1], null), message("f2", D(A, "22:00"), "whatsapp:15550000003@s.whatsapp.net", [2], null)] },
    });
    const dayOfB = (stamp: number): IndexedDay => ({
      inputs: "in-B", mtime_us: stamp, atoms: [line(1, "Person B: friday it is", D(B, "06:00"))],
      facts: { window: { start_ms: D(B), end_ms: D(B) + DAY_MS }, facts: [message("f1", D(B, "06:00"), Y, [1], null)] },
    });
    const rebuilt = (name: string, a: number, b: number) => {
      const builds = (["A first", "B first"] as const).map((order) => {
        const { index, file } = fresh(`${name} ${order}`);
        try {
          for (const day of order === "A first" ? [A, B] : [B, A]) index.day(day, day === A ? dayOfA(a) : dayOfB(b));
          return snapshot(file);
        } finally {
          index.close();
        }
      });
      expect(builds[1]).toEqual(builds[0]);
      return builds[0];
    };

    {
      const { index, file } = fresh("e7 newer");
      try {
        index.day(A, dayOfA(10));
        index.day(B, dayOfB(20));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: B }], x: [], y: ["atom 2026-10-01 1", "atom 2026-10-02 1"] });
        const before = lastWritten(file);
        const revision = index.revision();
        index.touchDay(A, dayOfA(30));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: A }], keys: [{ keys: `chat=${X};direction=received` }], x: ["atom 2026-10-01 1", "atom 2026-10-02 1"], y: [] });
        expect(snapshot(file)).toEqual(rebuilt("e7 newer rebuilt", 30, 20));
        expect(writtenSince(file, before)).toEqual(["atom 2026-10-01 1", "atom 2026-10-02 1"]);
        expect(index.revision()).not.toBe(revision);
        expect(index.days().get(A)).toMatchObject({ inputs: "in-A", mtime_us: 30 });
      } finally {
        index.close();
      }
    }

    {
      const { index, file } = fresh("e7 older");
      try {
        index.day(A, dayOfA(10));
        index.day(B, dayOfB(30));
        const was = snapshot(file);
        const before = lastWritten(file);
        const revision = index.revision();
        index.touchDay(A, dayOfA(20));
        expect(snapshot(file)).toEqual(was);
        expect(lastWritten(file)).toBe(before);
        expect(index.revision()).toBe(revision);
        expect(index.days().get(A)).toMatchObject({ mtime_us: 20 });
        expect(snapshot(file)).toEqual(rebuilt("e7 older rebuilt", 20, 30));
      } finally {
        index.close();
      }
    }

    {
      const { index, file } = fresh("e7 falls");
      try {
        index.day(A, dayOfA(30));
        index.day(B, dayOfB(20));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: A }] });
        index.touchDay(A, dayOfA(10));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: B }], keys: [{ keys: `chat=${Y};direction=received` }], x: [], y: ["atom 2026-10-01 1", "atom 2026-10-02 1"] });
        expect(snapshot(file)).toEqual(rebuilt("e7 falls rebuilt", 10, 20));
        expect(index.days().get(A)).toMatchObject({ inputs: "in-A", mtime_us: 10 });
      } finally {
        index.close();
      }
    }

    const PAID = "payments:0000000000000000000000p1";
    const richA = (stamp: number, f1 = true): IndexedDay => ({
      ...dayOfA(stamp),
      inputs: f1 ? "in-A" : "in-A without f1",
      facts: {
        window: { start_ms: D(A), end_ms: D(A) + DAY_MS },
        facts: [
          ...(f1 ? [{ ...message("f1", D(A, "21:00"), X, [1], null), measures: { minutes: 5 } }] : []),
          message("f2", D(A, "22:00"), "whatsapp:15550000003@s.whatsapp.net", [2], null),
          payment("p1", A, [2]),
        ],
      },
    });
    const richB = (stamp: number): IndexedDay => ({
      ...dayOfB(stamp),
      facts: { window: { start_ms: D(B), end_ms: D(B) + DAY_MS }, facts: [message("f1", D(B, "06:00"), Y, [1], null), { ...payment("p1", B, [1]), keys: { payee: "NIGHT MARKET", direction: "debit", currency: "EUR" }, measures: { amount: "5.00" } }] },
    });
    const rebuiltOf = (name: string, a: IndexedDay | null, b: IndexedDay | null) => {
      const builds = (["A first", "B first"] as const).map((order) => {
        const { index, file } = fresh(`${name} ${order}`);
        try {
          for (const day of order === "A first" ? [A, B] : [B, A]) {
            const indexed = day === A ? a : b;
            if (indexed !== null) index.day(day, indexed);
          }
          return snapshot(file);
        } finally {
          index.close();
        }
      });
      expect(builds[1]).toEqual(builds[0]);
      return builds[0];
    };
    {
      const { index, file } = fresh("e7 comes back");
      try {
        index.day(A, richA(10));
        index.day(B, richB(20));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: B }], measures: [] });
        expect(rowsOf(file, PAID)).toMatchObject({ facts: [{ day: B }], measures: [{ measure: "amount", value: 500 }] });
        index.touchDay(B, richB(5));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: A }], measures: [{ measure: "minutes", value: 5 }] });
        expect(rowsOf(file, PAID)).toMatchObject({ facts: [{ day: A }], keys: [{ keys: "currency=EUR;direction=debit;payee=CORNER BAKERY" }], measures: [{ measure: "amount", value: 450 }] });
        expect(snapshot(file)).toEqual(rebuiltOf("e7 comes back rebuilt", richA(10), richB(5)));
        index.touchDay(B, richB(25));
        expect(snapshot(file)).toEqual(rebuiltOf("e7 back again rebuilt", richA(10), richB(25)));
      } finally {
        index.close();
      }
    }

    {
      const { index, file } = fresh("e7 drops");
      try {
        index.day(B, richB(20));
        index.day(A, richA(30));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: A }] });
        index.day(A, richA(40, false));
        expect(rowsOf(file, F)).toMatchObject({ facts: [{ day: B }], keys: [{ keys: `chat=${Y};direction=received` }] });
        expect(snapshot(file)).toEqual(rebuiltOf("e7 drops rebuilt", richA(40, false), richB(20)));
        index.day(A, null);
        expect(rowsOf(file, PAID)).toMatchObject({ facts: [{ day: B }], measures: [{ measure: "amount", value: 500 }] });
        expect(snapshot(file)).toEqual(rebuiltOf("e7 gone rebuilt", null, richB(20)));
      } finally {
        index.close();
      }
    }
  });

  it("E8 untimed counts an entry with no time once, however many facts of the collection it states, and to 0 when the last goes", () => {
    const { index, file } = fresh("e8");
    const untimed = () => raw(file, (db) => JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'untimed'").pluck().get() as string ?? "{}") as Record<string, number>);
    const heading = line(1, "", null, { title: "The day's chats" });
    const facts = (lines: [number[], number[]]) => [message("u1", D(A, "09:00"), X, lines[0], null), message("u2", D(A, "10:00"), Y, lines[1], null)];
    try {
      write(index, A, 1, [heading], facts([[1], [1]]));
      expect(untimed()).toEqual({ messages: 1 });
      write(index, A, 2, [heading], facts([[1], []]));
      expect(untimed()).toEqual({ messages: 1 });
      write(index, A, 3, [heading], facts([[], []]));
      expect(untimed()["messages"] ?? 0).toBe(0);
    } finally {
      index.close();
    }
  });
});
