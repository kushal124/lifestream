import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { FILL_HEADS, GONE, HELD_MARK, heldOf, itemSpanOf, openHome, openHomeFolder, spansOf, type Guard, type HeldMark, type HomeDb, type Landed, type ReaderOutput } from "./index.js";

const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const MINUTE = 60_000;
const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
const GUARDS = { msg: object, note: object, chat: object };
const A = "whatsapp:+15550000001:macbook-pro-0001";
const B = "gmail:person-a@example.com:cloud";
const C = "youtube:person-a@example.com:cloud";

type Count = [string, string, number | null];

describe("what the home holds", () => {
  const dirs: string[] = [];
  const artifact: Record<string, unknown> = {};
  afterAll(() => {
    for (const dir of dirs) {
      writeFileSync(join(dir, "held.json"), `${JSON.stringify(artifact, null, 2)}\n`);
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  function fresh(): { path: string; db: HomeDb } {
    const dir = mkdtempSync(join(tmpdir(), "core-held-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    return { path, db: openHome(openHomeFolder(dirname(path)), "migrate") };
  }

  let stated = NOW;
  const land = (db: HomeDb, source: string, rows: ReaderOutput[], slices = 1): Landed[] => {
    stated += 1;
    const delivery = { id: `${source}@${stated}`, source, stated_ms: stated };
    const run = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} ${delivery.id}`, started_ms: stated }));
    const size = Math.ceil(rows.length / slices);
    const landed: Landed[] = [];
    for (let at = 0; at < rows.length; at += size) landed.push(db.commit((tx) => tx.records.land(run, delivery, rows.slice(at, at + size), GUARDS, { has: () => true })));
    return landed;
  };
  const msg = (key: string, text = key, kind = "msg", start_ms = NOW - MINUTE): ReaderOutput => ({ kind, key, content: { text }, time: { start_ms, precision: "ms" } });
  const gone = (key: string, kind = "msg"): ReaderOutput => ({ kind, key, content: null, gone: true });

  const raw = <T>(path: string, read: (sql: Database.Database) => T): T => {
    const sql = new Database(path, { readonly: true });
    try {
      return read(sql);
    } finally {
      sql.close();
    }
  };
  const counted = (path: string): Count[] => raw(path, (sql) => sql.prepare("SELECT source, kind, live FROM spans ORDER BY source, kind").raw().all() as Count[]);
  const truth = (path: string): Count[] => raw(path, (sql) => sql.prepare(
    `SELECT s.source, s.kind, (SELECT count(*) FROM heads h WHERE h.source = s.source AND h.kind = s.kind AND h.version <> 'gone')
     FROM spans s ORDER BY s.source, s.kind`,
  ).raw().all() as Count[]);
  const mark = (path: string): HeldMark | null => raw(path, (sql) => {
    const value = sql.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(HELD_MARK) as string | undefined;
    return value === undefined ? null : JSON.parse(value) as HeldMark;
  });
  const unfill = (path: string) => {
    const sql = new Database(path);
    sql.exec(`UPDATE spans SET live = NULL; DELETE FROM meta WHERE key = '${HELD_MARK}'`);
    sql.close();
  };
  const rowsOf = (sql: Database.Database, source: string, counts: string[] | null) => (spansOf(sql).get(source) ?? []).filter((span) => counts === null || counts.includes(span.kind));
  const held = (sql: Database.Database, sources: string[], counts: string[] | null) => Object.fromEntries(sources.map((source) => [source, heldOf(rowsOf(sql, source, counts))]));
  const spanOf = (sql: Database.Database, source: string, counts: string[] | null) => itemSpanOf(rowsOf(sql, source, counts));
  const viewed = (db: HomeDb, asked: [string, string][]): (number | null)[] => {
    const view = db.view();
    try {
      return asked.map(([source, kind]) => view.count(source, kind));
    } finally {
      view.close();
    }
  };
  const through = (path: string, at: { source: string; kind: string; key: string }) => raw(path, (sql) =>
    sql.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = ? AND key <= ?").pluck().get(at.source, at.kind, at.key) as number);

  it("counts the live heads, not what landed, whatever moves them", () => {
    const { path, db } = fresh();
    try {
      land(db, A, [msg("m1"), msg("m2"), msg("m3"), msg("m1", "again"), msg("m4")], 3);
      expect(counted(path)).toEqual([[A, "msg", 4]]);
      land(db, A, [msg("m1", "edited"), msg("m2")]);
      expect(counted(path)).toEqual([[A, "msg", 4]]);
      land(db, A, [gone("m3"), gone("never")]);
      expect(counted(path)).toEqual([[A, "msg", 3]]);
      land(db, A, [gone("m3")]);
      expect(counted(path)).toEqual([[A, "msg", 3]]);
      land(db, A, [msg("m3", "back"), msg("n1", "n", "note"), gone("m4")]);
      expect(counted(path)).toEqual([[A, "msg", 3], [A, "note", 1]]);
      land(db, B, [msg("b1"), msg("b2")]);
      expect(counted(path)).toEqual(truth(path));
      db.commit((tx) => tx.records.erase({ records: [{ source: A, kind: "msg", key: "m1" }, { source: A, kind: "msg", key: "m4" }], reason: "the owner's", at_ms: NOW }));
      expect(counted(path).find(([source, kind]) => source === A && kind === "msg")).toEqual([A, "msg", 2]);
      const view = db.view();
      const plan = view.planRepair({ source: A, kinds: ["msg"], fix: (head) => (head.key === "m2" ? { content: head.content, kind: "chat" } : head.key === "m3" ? GONE : "keep") });
      view.close();
      db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: A, started_ms: NOW }), plan, { has: () => true }));
      expect(counted(path).filter(([source]) => source === A)).toEqual([[A, "chat", 1], [A, "msg", 0], [A, "note", 1]]);
      expect(counted(path)).toEqual(truth(path));
      db.commit((tx) => tx.records.forget({ sources: [{ source: B, kinds: ["msg"] }] }));
      expect(counted(path).find(([source]) => source === B)).toEqual([B, "msg", 0]);
      land(db, B, [msg("b2")]);
      expect(counted(path)).toEqual(truth(path));
      expect(counted(path)).toEqual([[B, "msg", 1], [A, "chat", 1], [A, "msg", 0], [A, "note", 1]]);
      artifact.moves = { counted: counted(path), truth: truth(path) };
    } finally {
      db.close();
    }
  });

  it("fills a source of many heads in bounded commits, resumable, true to heads landed on either side of its mark", () => {
    const { path, db: first } = fresh();
    let db = first;
    try {
      const keys = Array.from({ length: 10_000 }, (_, at) => `k${String(at + 1).padStart(5, "0")}${at + 1 === FILL_HEADS ? "�" : ""}`);
      land(db, A, keys.map((key) => msg(key)), 4);
      land(db, A, keys.filter((_, at) => at % 10 === 9).map((key) => gone(key)));
      land(db, C, [msg("c1"), msg("c2", "c", "note")]);
      expect(counted(path)).toEqual(truth(path));
      unfill(path);
      expect(raw(path, (sql) => held(sql, [A, C], null))).toEqual({ [A]: null, [C]: null });
      expect(viewed(db, [[A, "msg"], [C, "msg"], [A, "note"]])).toEqual([null, null, 0]);

      expect(db.commit((tx) => tx.records.fillHeld())).toBe(false);
      expect(viewed(db, [[A, "msg"]])).toEqual([null]);
      const at = mark(path);
      expect(at !== null && "at" in at ? [at.at.source, at.at.kind, at.at.key, through(path, at.at)] : at).toEqual([A, "msg", keys[FILL_HEADS - 1], FILL_HEADS]);

      land(db, A, [msg("k00001-new"), gone("k00002"), msg("k00010", "back"), msg("k09000-new"), gone("k09001"), msg("k09010", "back"), msg(`k${String(FILL_HEADS).padStart(5, "0")}\u{1F600}`)]);
      db.commit((tx) => tx.records.erase({ records: [{ source: A, kind: "msg", key: "k00003" }, { source: A, kind: "msg", key: "k09002" }], reason: "the owner's", at_ms: NOW }));
      expect(counted(path).every(([, , live]) => live === null)).toBe(true);

      db.close();
      db = openHome(openHomeFolder(dirname(path)), "migrate");
      const commits = [mark(path)];
      for (let at = 0; at < 10 && !db.commit((tx) => tx.records.fillHeld()); at++) commits.push(mark(path));
      expect(commits.length).toBe(2);
      expect(mark(path)).toMatchObject({ complete: expect.any(String) });
      expect(counted(path)).toEqual(truth(path));
      expect(raw(path, (sql) => held(sql, [A, C], null))).toEqual({ [A]: truth(path).find(([s]) => s === A)![2], [C]: 2 });
      expect(viewed(db, [[A, "msg"], [C, "msg"], [C, "note"]])).toEqual([truth(path).find(([s]) => s === A)![2], 1, 1]);
      expect(db.commit((tx) => tx.records.fillHeld())).toBe(true);
      land(db, A, [msg("k99999")]);
      expect(counted(path)).toEqual(truth(path));
      artifact.fill = { commits, counted: counted(path), truth: truth(path) };
    } finally {
      db.close();
    }
  });

  it("forgets the kind the fill stands inside without counting what went", () => {
    const { path, db } = fresh();
    try {
      land(db, A, Array.from({ length: FILL_HEADS + 10 }, (_, at) => msg(`k${String(at).padStart(5, "0")}`)));
      land(db, A, [msg("n1", "n", "note")]);
      unfill(path);
      expect(db.commit((tx) => tx.records.fillHeld())).toBe(false);
      expect(mark(path)).toMatchObject({ at: { source: A, kind: "msg" } });
      db.commit((tx) => tx.records.forget({ sources: [{ source: A, kinds: ["msg"] }] }));
      expect(mark(path)).toBeNull();
      land(db, A, [msg("k00001")]);
      while (!db.commit((tx) => tx.records.fillHeld()));
      expect(counted(path)).toEqual([[A, "msg", 1], [A, "note", 1]]);
      expect(counted(path)).toEqual(truth(path));
    } finally {
      db.close();
    }
  });

  it("says no count until a source's rows are filled, only of the kinds asked", () => {
    const { path, db } = fresh();
    try {
      land(db, A, [msg("a1", "a", "msg", NOW - 3 * MINUTE), msg("a2", "a", "msg", NOW - MINUTE), msg("a3", "a", "msg", NOW - 2 * MINUTE), msg("n1", "n", "note", NOW - 90 * MINUTE)]);
      land(db, A, [gone("a2"), { kind: "chat", key: "c1", content: { name: "a chat" } }]);
      land(db, B, [msg("b1", "b", "msg", NOW - 10 * MINUTE)]);
      raw(path, (sql) => {
        expect(held(sql, [A, B, "contacts:person-a@example.com:cloud"], null)).toEqual({ [A]: 4, [B]: 1, "contacts:person-a@example.com:cloud": 0 });
        expect(held(sql, [A], ["msg"])).toEqual({ [A]: 2 });
        expect(spanOf(sql, A, ["msg"])).toEqual({ oldest_ms: NOW - 3 * MINUTE, newest_ms: NOW - 2 * MINUTE, newest_dated: false });
        expect(spanOf(sql, A, null)).toEqual({ oldest_ms: NOW - 90 * MINUTE, newest_ms: NOW - 2 * MINUTE, newest_dated: false });
        expect(spanOf(sql, A, ["chat"])).toEqual({ oldest_ms: null, newest_ms: null, newest_dated: false });
      });
      land(db, B, [{ kind: "msg", key: "b2", content: { text: "b2" }, time: { start_ms: Date.UTC(2026, 9, 27), precision: "day" } }]);
      raw(path, (sql) => {
        expect(spanOf(sql, B, ["msg"])).toMatchObject({ newest_ms: Date.UTC(2026, 9, 27), newest_dated: true });
      });
      const sql = new Database(path);
      sql.prepare("UPDATE spans SET live = NULL WHERE source = ? AND kind = 'note'").run(A);
      sql.close();
      raw(path, (read) => {
        expect(held(read, [A, B], null)).toEqual({ [A]: null, [B]: 2 });
        expect(held(read, [A], ["msg"])).toEqual({ [A]: 2 });
      });
    } finally {
      db.close();
    }
  });

  type Ends = [string, string, number | null, number | null, number | null];
  const ends = (path: string): Ends[] => raw(path, (sql) => sql.prepare("SELECT source, kind, oldest_ms, newest_ms, newest_dated FROM spans ORDER BY source, kind").raw().all() as Ends[]);
  const oracle = (path: string): Ends[] => raw(path, (sql) => {
    const end = (order: "ASC" | "DESC") => sql.prepare(
      `SELECT start_ms, version FROM heads INDEXED BY heads_time WHERE source = ? AND kind = ? AND version <> 'gone' AND start_ms IS NOT NULL ORDER BY start_ms ${order} LIMIT 1`);
    const precision = sql.prepare("SELECT precision FROM versions WHERE id = ?").pluck();
    return (sql.prepare("SELECT source, kind FROM spans ORDER BY source, kind").all() as { source: string; kind: string }[]).map(({ source, kind }): Ends => {
      const first = end("ASC").get(source, kind) as { start_ms: number } | undefined;
      const last = end("DESC").get(source, kind) as { start_ms: number; version: string } | undefined;
      return [source, kind, first?.start_ms ?? null, last?.start_ms ?? null, last === undefined ? null : precision.get(last.version) === "day" ? 1 : 0];
    });
  });

  it("keeps the ends of a kind true after every write", () => {
    const { path, db } = fresh();
    const checks: Ends[][] = [];
    const check = () => {
      expect(ends(path)).toEqual(oracle(path));
      checks.push(ends(path));
    };
    try {
      land(db, A, [msg("a1", "a1", "msg", NOW - 3 * MINUTE), msg("a2", "a2", "msg", NOW - 2 * MINUTE), msg("a3", "a3", "msg", NOW - MINUTE), msg("n1", "n1", "note", NOW - 90 * MINUTE)]);
      land(db, A, [{ kind: "chat", key: "c1", content: { name: "a chat" } }]);
      land(db, B, [msg("b1", "b1", "msg", NOW - 10 * MINUTE)]);
      check();
      expect(ends(path).find(([source, kind]) => source === A && kind === "chat")).toEqual([A, "chat", null, null, null]);
      land(db, A, [msg("a2", "a2", "msg", NOW - 2 * MINUTE)]);
      check();
      land(db, A, [msg("a3", "a3 moved", "msg", NOW - 30 * MINUTE)]);
      check();
      expect(ends(path).find(([source, kind]) => source === A && kind === "msg")!.slice(2)).toEqual([NOW - 30 * MINUTE, NOW - 2 * MINUTE, 0]);
      land(db, A, [msg("a2", "a2 later", "msg", NOW - 2 * MINUTE + 1_000)]);
      check();
      land(db, A, [msg("a0", "a0", "msg", NOW - 5 * 60 * MINUTE), gone("a1")]);
      check();
      land(db, A, [gone("a2")]);
      check();
      land(db, A, [gone("a0")]);
      check();
      const view = db.view();
      const plan = view.planRepair({ source: A, kinds: ["msg"], fix: (head) => (head.key === "a3" ? { content: head.content, kind: "chat" } : "keep") });
      view.close();
      db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: A, started_ms: NOW }), plan, { has: () => true }));
      check();
      expect(ends(path).find(([source, kind]) => source === A && kind === "msg")).toEqual([A, "msg", null, null, null]);
      land(db, B, [msg("b2", "b2", "msg", NOW - 20 * MINUTE)]);
      db.commit((tx) => tx.records.erase({ records: [{ source: B, kind: "msg", key: "b2" }], reason: "the owner's", at_ms: NOW }));
      check();
      land(db, B, [{ kind: "msg", key: "b3", content: { text: "b3" }, time: { start_ms: Date.UTC(2026, 9, 27), precision: "day" } }]);
      check();
      expect(ends(path).find(([source]) => source === B)!.slice(2)).toEqual([NOW - 10 * MINUTE, Date.UTC(2026, 9, 27), 1]);
      db.commit((tx) => tx.records.forget({ sources: [{ source: A, kinds: ["note"] }] }));
      check();
      expect(ends(path).find(([source, kind]) => source === A && kind === "note")).toEqual([A, "note", null, null, null]);
      artifact.ends = checks;
    } finally {
      db.close();
    }
  });
});
