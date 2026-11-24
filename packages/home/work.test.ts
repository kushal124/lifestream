import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertPoint, assertWalk, rowsCounted, Work } from "./work.js";

let db: Database.Database;
const ENTRIES = 50;

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE names (id INTEGER PRIMARY KEY, role TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, UNIQUE (role, name)) STRICT;
    CREATE TABLE entries (slot INTEGER PRIMARY KEY, head INTEGER NOT NULL, family INTEGER, title INTEGER, layer INTEGER NOT NULL) STRICT;
    CREATE INDEX entries_family ON entries(family);
    CREATE TABLE entry_states (slot INTEGER PRIMARY KEY, accounts TEXT NOT NULL, who TEXT, chat TEXT) STRICT;
    CREATE TABLE facts (id TEXT PRIMARY KEY, of TEXT NOT NULL, day TEXT NOT NULL) STRICT, WITHOUT ROWID;
    CREATE INDEX facts_of ON facts(of, day);
    CREATE TABLE fact_who (fact TEXT NOT NULL, handle TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY (fact, handle, role)) STRICT, WITHOUT ROWID;
    CREATE INDEX fact_who_handle ON fact_who(handle);
    CREATE VIRTUAL TABLE fts USING fts5(line, tags, content = '', contentless_delete = 1);
  `);
  const family = db.prepare("INSERT INTO names (role, name, n) VALUES ('family', ?, 0)");
  const [messages, calls] = [Number(family.run("messages").lastInsertRowid), Number(family.run("calls").lastInsertRowid)];
  const entry = db.prepare("INSERT INTO entries (slot, head, family, title, layer) VALUES (?, ?, ?, NULL, 0)");
  const words = db.prepare("INSERT INTO fts (rowid, line, tags) VALUES (?, ?, ?)");
  for (let n = 1; n <= ENTRIES; n++) {
    entry.run(n * 1000, n, n % 5 === 0 ? calls : messages);
    words.run(n * 1000, n % 2 === 0 ? "even lunch" : "odd dinner", n % 5 === 0 ? "fcalls" : "fmessages");
  }
  const fact = db.prepare("INSERT INTO facts (id, of, day) VALUES (?, 'messages', ?)");
  const who = db.prepare("INSERT INTO fact_who (fact, handle, role) VALUES (?, ?, 'from')");
  for (let n = 1; n <= 20; n++) {
    fact.run(`fact-${n}`, `2026-10-${String(n).padStart(2, "0")}`);
    who.run(`fact-${n}`, n % 2 === 0 ? "+15550000001" : "+15550000002");
  }
});

afterAll(() => {
  db.close();
});

const RANGE = "SELECT slot, head FROM entries WHERE slot < ? ORDER BY slot DESC LIMIT ?";

describe("a walk", () => {
  it("returns its rows, at most its limit, counts each, and says there was another", () => {
    const work = new Work(1_000);
    const before = rowsCounted();
    const first = work.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 10);
    expect(first.rows.map((each) => each.slot)).toEqual(Array.from({ length: 10 }, (_, n) => (ENTRIES - n) * 1000));
    expect(first.more).toBe(true);
    expect(work.spent).toBe(11);
    const last = work.walk<{ slot: number }>(db.prepare(RANGE), [6000], 10);
    expect(last.rows.map((each) => each.slot)).toEqual([5000, 4000, 3000, 2000, 1000]);
    expect(last.more).toBe(false);
    expect(work.spent).toBe(16);
    expect(work.out).toBe(false);
    expect(rowsCounted() - before).toBe(16);
  });

  it("counts a point as one row, found or not", () => {
    const work = new Work(1_000);
    const one = db.prepare("SELECT head FROM entries WHERE slot = ?");
    expect(work.point<{ head: number }>(one, [3000])).toEqual({ head: 3 });
    expect(work.point(one, [3001])).toBeUndefined();
    expect(work.spent).toBe(2);
  });

  it("stops at the budget: the row that says there is more is taken from it, so `spent` never passes it", () => {
    const work = new Work(25);
    const first = work.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 20);
    expect(first.rows).toHaveLength(20);
    expect(work.out).toBe(false);
    const second = work.walk<{ slot: number }>(db.prepare(RANGE), [first.rows.at(-1)!.slot], 20);
    expect(second.rows.map((each) => each.slot)).toEqual([30000, 29000, 28000]);
    expect(second.more).toBe(true);
    expect(work.spent).toBe(25);
    expect(work.out).toBe(true);
    expect(work.walk(db.prepare(RANGE), [28000], 20)).toEqual({ rows: [], more: true });
    expect(work.spent).toBe(25);
  });

  it("keeps the lookahead inside the budget when the walk's last row is the budget's last", () => {
    const work = new Work(11);
    const walked = work.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 10);
    expect(walked.rows).toHaveLength(10);
    expect(walked.more).toBe(true);
    expect(work.spent).toBe(11);
    expect(work.out).toBe(true);
  });

  it("reads nothing with fewer than two rows left, says there is more, and the read is out", () => {
    const work = new Work(12);
    work.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 10);
    expect(work.spent).toBe(11);
    expect(work.walk(db.prepare(RANGE), [41000], 5)).toEqual({ rows: [], more: true });
    expect(work.spent).toBe(11);
    expect(work.out).toBe(true);
    expect(work.point(db.prepare("SELECT head FROM entries WHERE slot = ?"), [1000])).toEqual({ head: 1 });
    expect(work.spent).toBe(12);
  });

  it("walks a list to its end under a budget that holds it, with no row of lookahead past it", () => {
    const work = new Work(51);
    const walked = work.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], ENTRIES);
    expect(walked.rows).toHaveLength(ENTRIES);
    expect(walked.more).toBe(false);
    expect(work.spent).toBe(ENTRIES);
    expect(work.out).toBe(false);
  });

  it("walks with a budget of Infinity as far as its limit", () => {
    const work = new Work(Infinity);
    const walked = work.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 30);
    expect(walked.rows).toHaveLength(30);
    expect(walked.more).toBe(true);
    expect(work.spent).toBe(31);
    expect(work.out).toBe(false);
  });
});

describe("a lookup", () => {
  const one = "SELECT head FROM entries WHERE slot = ?";

  it("is one row of the budget, and with none left it throws, reading nothing", () => {
    const work = new Work(2);
    work.point(db.prepare(one), [1000]);
    work.point(db.prepare(one), [1001]);
    expect(work.spent).toBe(2);
    const before = rowsCounted();
    expect(() => work.point(db.prepare(one), [2000])).toThrow(/no row left/);
    expect(work.spent).toBe(2);
    expect(rowsCounted()).toBe(before);
  });
});

describe("a reservation", () => {
  const one = "SELECT head FROM entries WHERE slot = ?";

  it("holds a unit's rows when they are left, counts none itself, and the unit reads whole inside them", () => {
    const work = new Work(20);
    work.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 9);
    expect(work.spent).toBe(10);
    expect(work.reserve(10)).toBe(true);
    expect(work.spent).toBe(10);
    expect(work.out).toBe(false);
    const unit = work.walk<{ slot: number }>(db.prepare(RANGE), [41000], 8);
    expect(unit.rows).toHaveLength(8);
    expect(unit.more).toBe(true);
    expect(work.point(db.prepare(one), [1000])).toEqual({ head: 1 });
    expect(work.spent).toBe(20);
    expect(work.out).toBe(true);
  });

  it("answers no when the rows are not left: nothing is read, and the read is out, so it stops before the unit", () => {
    const work = new Work(20);
    work.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 9);
    expect(work.reserve(11)).toBe(false);
    expect(work.spent).toBe(10);
    expect(work.out).toBe(true);
    expect(work.walk(db.prepare(RANGE), [41000], 3)).toEqual({ rows: [], more: true });
    expect(work.spent).toBe(10);
  });

  it("refuses a count of rows that is not a whole number", () => {
    const work = new Work(20);
    expect(() => work.reserve(-1)).toThrow(/whole number/);
    expect(() => work.reserve(1.5)).toThrow(/whole number/);
  });
});

describe("the statements a meter runs", () => {
  it("under a test, checks each statement against the rule the first time it runs: a walk and a point pass, a fold or a lookup by part of a key is refused before it reads", () => {
    expect(process.env.LIFESTREAM_TEST_WALKS).toBe("1");
    const work = new Work(100);
    for (let twice = 0; twice < 2; twice++) {
      expect(work.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 1).rows).toHaveLength(1);
      expect(work.point(db.prepare("SELECT head FROM entries WHERE slot = ?"), [1000])).toBeDefined();
    }
    const spent = work.spent;
    expect(() => work.walk(db.prepare("SELECT count(*) FROM entries WHERE slot >= ? LIMIT ?"), [0], 1)).toThrow(/aggregates/);
    expect(() => work.point(db.prepare("SELECT id FROM names WHERE role = ?"), ["person"])).toThrow(/reads more than one row/);
    expect(work.spent).toBe(spent);
  });
});

describe("the guard of the one rule", () => {
  it("accepts a range of one index with lookups by primary key", () => {
    assertWalk(db, "SELECT e.slot, n.name FROM entries e JOIN names n ON n.id = e.family WHERE e.slot >= ? AND e.slot < ? ORDER BY e.slot DESC LIMIT ?");
    assertWalk(db, "SELECT e.slot FROM entries e INDEXED BY entries_family WHERE e.family = ? AND e.slot < ? ORDER BY e.slot DESC LIMIT ?");
    assertWalk(db, "SELECT f.id, f.day FROM fact_who w JOIN facts f ON f.id = w.fact WHERE w.handle = ? LIMIT ?");
    assertWalk(db, "SELECT e.slot, x.accounts AS accounts FROM entries e LEFT JOIN entry_states x ON x.slot = e.slot WHERE e.slot >= ? AND e.slot < ? ORDER BY e.slot DESC LIMIT ?");
  });

  it("accepts a match of the word index joined to entries by slot", () => {
    const sql = "SELECT e.slot, e.family FROM fts f JOIN entries e ON e.slot = f.rowid WHERE fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ORDER BY f.rowid DESC LIMIT ?";
    assertWalk(db, sql);
    assertWalk(db, "SELECT f.rowid AS slot, x.accounts AS accounts FROM fts f JOIN entries e ON e.slot = f.rowid LEFT JOIN entry_states x ON x.slot = e.slot WHERE fts MATCH ? AND f.rowid >= ? AND f.rowid < ? ORDER BY f.rowid DESC LIMIT ?");
    const work = new Work(100);
    const walked = work.walk<{ slot: number }>(db.prepare(sql), ["line : even", 0, Number.MAX_SAFE_INTEGER], 3);
    expect(walked.rows.map((each) => each.slot)).toEqual([50000, 48000, 46000]);
    expect(walked.more).toBe(true);
  });

  it("accepts a point by a whole key, and refuses one by part of a key", () => {
    assertPoint(db, "SELECT head FROM entries WHERE slot = ?");
    assertPoint(db, "SELECT id FROM names WHERE role = ? AND name = ?");
    assertPoint(db, "SELECT day FROM facts WHERE id = ?");
    expect(() => assertPoint(db, "SELECT id FROM names WHERE role = ?")).toThrow(/reads more than one row/);
  });

  it("refuses a join of two lists", () => {
    expect(() => assertWalk(db, "SELECT f.id, w.handle FROM facts f JOIN fact_who w ON w.fact = f.id WHERE f.of = ? LIMIT ?")).toThrow(/reads more than one row/);
    expect(() => assertWalk(db, "SELECT f.id, w.handle FROM facts f LEFT JOIN fact_who w ON w.fact = f.id WHERE f.id >= ? LIMIT ?")).toThrow(/reads more than one row/);
  });

  it("refuses an aggregate, though its plan is one range", () => {
    expect(() => assertWalk(db, "SELECT count(*) FROM entries WHERE slot >= ? LIMIT ?")).toThrow(/aggregates/);
    expect(() => assertWalk(db, "SELECT count(*) FROM fts WHERE fts MATCH ? LIMIT ?")).toThrow(/aggregates/);
    expect(() => assertWalk(db, "SELECT max(slot) FROM entries WHERE slot < ? LIMIT ?")).toThrow(/aggregates/);
    expect(() => assertWalk(db, "SELECT DISTINCT family FROM entries WHERE slot >= ? LIMIT ?")).toThrow(/folds rows/);
    expect(() => assertWalk(db, "SELECT family, count(*) FROM entries WHERE slot >= ? GROUP BY family LIMIT ?")).toThrow(/folds rows/);
  });

  it("refuses an IN (SELECT ...)", () => {
    expect(() => assertWalk(db, "SELECT slot FROM entries WHERE family IN (SELECT id FROM names WHERE role = ?) LIMIT ?")).toThrow(/builds a list aside/);
  });

  it("refuses a statement with no LIMIT", () => {
    expect(() => assertWalk(db, "SELECT slot FROM entries WHERE slot >= ? AND slot < ? ORDER BY slot DESC")).toThrow(/LIMIT/);
    expect(() => assertWalk(db, "SELECT slot FROM entries WHERE slot >= ? LIMIT 10")).toThrow(/LIMIT/);
  });

  it("refuses a temp B-tree", () => {
    expect(() => assertWalk(db, "SELECT slot FROM entries WHERE slot >= ? ORDER BY title LIMIT ?")).toThrow(/TEMP B-TREE/);
  });

  it("refuses a scan of a real table", () => {
    expect(() => assertWalk(db, "SELECT slot FROM entries LIMIT ?")).toThrow(/enters no index at a bound/);
  });
});

describe("one meter a call", () => {
  it("bounds every meter made inside it, counts their rows in it, and the thread's once", () => {
    const before = rowsCounted();
    const call = new Work(25);
    const one = call.inner(Infinity);
    const two = one.beside(1_000);
    const first = one.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 10);
    expect(first.rows).toHaveLength(10);
    expect(call.spent).toBe(11);
    const second = two.walk<{ slot: number }>(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 40);
    expect(second.rows).toHaveLength(13);
    expect(second.more).toBe(true);
    expect(call.spent).toBe(25);
    expect(two.out).toBe(true);
    expect(() => call.inner(10).point(db.prepare("SELECT head FROM entries WHERE slot = ?"), [1000])).toThrow(expect.objectContaining({ code: "TOO_BROAD", status: 422 }));
    expect(call.spent).toBe(25);
    expect(rowsCounted() - before).toBe(25);
  });

  it("nests: a meter inside one inside the call is in both; one beside a meter is in its call; one of what a read would walk is in none", () => {
    const outer = new Work(100);
    const inner = outer.inner(10);
    inner.inner(Infinity).walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 5);
    expect(inner.spent).toBe(6);
    expect(outer.spent).toBe(6);
    inner.beside(Infinity).walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 3);
    expect(inner.spent).toBe(6);
    expect(outer.spent).toBe(10);
    const would = outer.inner(1).beside(1_000, false);
    would.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 50);
    expect(outer.spent).toBe(10);
  });

  it("is nothing ambient: a meter made with no call is in none, whatever is open", () => {
    const call = new Work(5);
    call.inner(Infinity);
    const alone = new Work(1_000);
    alone.walk(db.prepare(RANGE), [Number.MAX_SAFE_INTEGER], 20);
    expect(alone.spent).toBe(21);
    expect(call.spent).toBe(0);
  });
});
