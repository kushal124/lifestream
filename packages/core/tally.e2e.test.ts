import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { addDays, civilDay, dayBounds, instant, openHome, openHomeFolder, TALLY_MARK, weekOf, weeksOf, windowFloor, type DaySettings, type Guard, type HomeDb, type ReaderOutput } from "./index.js";

const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };
const NOW = Date.UTC(2026, 9, 26, 12, 0, 0);
const DAY_MS = 86_400_000;
const MINUTE = 60_000;
const object: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
const GUARDS = { msg: object, chat: object, note: object };
const A = "whatsapp:+15550000001:macbook-pro-0001";
const B = "gmail:person-a@example.com:cloud";

type Minute = [string, string, number, number];

describe("the tally of what happened when", () => {
  const dirs: string[] = [];
  const artifact: Record<string, unknown> = {};
  afterAll(() => {
    for (const dir of dirs) {
      writeFileSync(join(dir, "tally.json"), `${JSON.stringify(artifact, null, 2)}\n`);
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  function fresh(day = DAY, now = NOW): { path: string; db: HomeDb } {
    const dir = mkdtempSync(join(tmpdir(), "core-tally-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    db.commit((tx) => tx.tally.prune(day, now));
    return { path, db };
  }

  let stated = NOW;
  const land = (db: HomeDb, source: string, rows: ReaderOutput[]) => db.commit((tx) => {
    stated += 1;
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated });
    return tx.records.land(run, { id: `${source}@${stated}`, source, stated_ms: stated }, rows, GUARDS, { has: () => true });
  });
  const msg = (key: string, start_ms: number, text = key, kind = "msg"): ReaderOutput => ({ kind, key, content: { text }, time: { start_ms, precision: "ms" } });
  const gone = (key: string, kind = "msg"): ReaderOutput => ({ kind, key, content: null, gone: true });

  const raw = <T>(path: string, read: (sql: Database.Database) => T): T => {
    const sql = new Database(path, { readonly: true });
    try {
      return read(sql);
    } finally {
      sql.close();
    }
  };
  const tallied = (path: string): Minute[] => raw(path, (sql) =>
    (sql.prepare("SELECT source, kind, minute, records FROM start_minutes ORDER BY source, kind, minute").raw().all() as Minute[]));
  const truth = (path: string): Minute[] => raw(path, (sql) => {
    const floor = Number(sql.prepare("SELECT value FROM meta WHERE key = 'tally:start_minutes:floor'").pluck().get());
    return sql.prepare(`SELECT source, kind, start_ms / 60000, count(*) FROM heads WHERE version <> 'gone' AND start_ms >= ? GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).raw().all(floor) as Minute[];
  });
  const rebuild = (db: HomeDb, day = DAY) => {
    const chunks = db.commit((tx) => tx.tally.chunks(day));
    for (const chunk of chunks) db.commit((tx) => tx.tally.rebuild(chunk));
    db.commit((tx) => tx.tally.complete());
    return chunks.length;
  };
  const minute = (ms: number) => Math.floor(ms / MINUTE);
  const kindsOf = (sql: Database.Database, counts: string[] | null) =>
    (sql.prepare("SELECT source, kind FROM spans").raw().all() as [string, string][]).filter(([, kind]) => counts === null || counts.includes(kind));

  it("counts a record on the minute it happened, once, whatever moves its head, and nothing before the window", () => {
    const { path, db } = fresh();
    try {
      const three = NOW - 3 * DAY_MS;
      const lastYear = NOW - 365 * DAY_MS;
      land(db, A, [msg("old", three), msg("ancient", lastYear), msg("moving", NOW - DAY_MS), msg("same", NOW - 2 * DAY_MS)]);
      expect(tallied(path)).toEqual([[A, "msg", minute(NOW - 2 * DAY_MS), 1], [A, "msg", minute(NOW - DAY_MS), 1], [A, "msg", minute(three), 1]].sort((x, y) => (x[2] as number) - (y[2] as number)));
      land(db, A, [msg("moving", NOW - 5 * MINUTE, "later"), msg("same", NOW - 2 * DAY_MS), msg("old", three, "edited")]);
      expect(tallied(path)).toEqual([
        [A, "msg", minute(three), 1], [A, "msg", minute(NOW - 2 * DAY_MS), 1], [A, "msg", minute(NOW - 5 * MINUTE), 1]]);
      land(db, A, [gone("moving")]);
      expect(tallied(path).some(([, , at]) => at === minute(NOW - 5 * MINUTE))).toBe(false);
      land(db, A, [msg("moving", NOW - 5 * MINUTE, "later")]);
      land(db, A, [msg("moving", NOW - 5 * MINUTE, "later")]);
      expect(tallied(path).filter(([, , at]) => at === minute(NOW - 5 * MINUTE))).toEqual([[A, "msg", minute(NOW - 5 * MINUTE), 1]]);
      const view = db.view();
      const plan = view.planRepair({ source: A, kinds: ["msg"], fix: (head) => (head.key === "same" ? { content: head.content, kind: "note" } : "keep") });
      view.close();
      db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: A, started_ms: NOW }), plan, { has: () => true }));
      expect(tallied(path).filter(([, , at]) => at === minute(NOW - 2 * DAY_MS))).toEqual([[A, "note", minute(NOW - 2 * DAY_MS), 1]]);
      land(db, A, [{ kind: "chat", key: "c1", content: { name: "a chat" } }]);
      expect(tallied(path).some(([, kind]) => kind === "chat")).toBe(false);
      expect(tallied(path)).toEqual(truth(path));
      artifact.moves = { tally: tallied(path), truth: truth(path) };
    } finally {
      db.close();
    }
  });

  it("takes an erased record off, a forgotten kind's rows alone, and keeps the window by its floor", () => {
    const { path, db } = fresh();
    try {
      land(db, A, [msg("m1", NOW - DAY_MS), msg("m2", NOW - DAY_MS + MINUTE), msg("n1", NOW - DAY_MS, "n", "note")]);
      land(db, B, [msg("x", NOW - 6 * DAY_MS), msg("y", NOW - 7 * DAY_MS)]);
      db.commit((tx) => tx.records.erase({ records: [{ source: A, kind: "msg", key: "m1" }], reason: "the owner's", at_ms: NOW }));
      expect(tallied(path).filter(([source, kind]) => source === A && kind === "msg")).toEqual([[A, "msg", minute(NOW - DAY_MS + MINUTE), 1]]);
      db.commit((tx) => tx.records.forget({ sources: [{ source: A, kinds: ["msg"] }] }));
      expect(tallied(path).filter(([source]) => source === A)).toEqual([[A, "note", minute(NOW - DAY_MS), 1]]);
      land(db, A, [msg("m2", NOW - DAY_MS + MINUTE)]);
      expect(tallied(path).filter(([source, kind]) => source === A && kind === "msg")).toEqual([[A, "msg", minute(NOW - DAY_MS + MINUTE), 1]]);
      expect(tallied(path)).toEqual(truth(path));
      const next = NOW + DAY_MS;
      const before = tallied(path);
      const removed = db.commit((tx) => tx.tally.prune(DAY, next));
      const floor = windowFloor(DAY, next);
      expect(floor).toBe(dayBounds(addDays(civilDay(next, DAY), -7), DAY).start_ms);
      expect([removed, tallied(path)]).toEqual([before.filter(([, , at]) => at < floor / MINUTE).length, before.filter(([, , at]) => at >= floor / MINUTE)]);
      expect(tallied(path).some(([source, , at]) => source === B && at === minute(NOW - 7 * DAY_MS))).toBe(false);
      land(db, B, [msg("z", floor - 1)]);
      expect(tallied(path)).toEqual(truth(path));
      artifact.window = { floor, tally: tallied(path) };
    } finally {
      db.close();
    }
  });

  it("rebuilds from the heads to what was tallied, one (source, kind, day) a commit, resuming after a kill", () => {
    const { path, db: first } = fresh();
    let db = first;
    try {
      land(db, A, Array.from({ length: 8 }, (_, day) => msg(`a${day}`, NOW - day * DAY_MS - MINUTE)));
      land(db, A, [msg("a3", NOW - 3 * DAY_MS + 7 * MINUTE), gone("a5"), msg("later", NOW + 2 * DAY_MS)]);
      land(db, B, [msg("b", NOW - 2 * DAY_MS), msg("bb", NOW - 2 * DAY_MS, "b2", "note")]);
      db.commit((tx) => tx.records.erase({ records: [{ source: B, kind: "note", key: "bb" }], reason: "the owner's", at_ms: NOW }));
      const kept = tallied(path);
      expect(kept).toEqual(truth(path));
      const spoil = new Database(path);
      const bogus = minute(NOW - 4 * DAY_MS);
      spoil.prepare("DELETE FROM start_minutes").run();
      spoil.prepare("INSERT INTO start_minutes (source, kind, minute, records) VALUES (?, 'msg', ?, 9)").run(B, bogus);
      spoil.close();
      const all = db.commit((tx) => tx.tally.chunks(DAY));
      const at = all.findIndex((chunk) => chunk.source === B && chunk.kind === "msg" && chunk.day === civilDay(NOW - 4 * DAY_MS, DAY));
      for (const chunk of all.slice(0, at)) db.commit((tx) => tx.tally.rebuild(chunk));
      expect(tallied(path)).toEqual([[B, "msg", bogus, 9]]);
      db.commit((tx) => tx.tally.rebuild(all[at]!));
      expect(tallied(path)).toEqual([]);
      db.close();
      db = openHome(openHomeFolder(dirname(path)), "migrate");
      const rest = db.commit((tx) => tx.tally.chunks(DAY));
      expect(rest).toEqual(all.slice(at + 1));
      db.commit((tx) => tx.tally.rebuild(rest[0]!));
      land(db, B, [msg("b3", NOW - 3 * DAY_MS + 30 * MINUTE), msg("b1", NOW - DAY_MS)]);
      for (const chunk of rest.slice(1)) db.commit((tx) => tx.tally.rebuild(chunk));
      db.commit((tx) => tx.tally.complete());
      expect(tallied(path)).toEqual(truth(path));
      expect(tallied(path).filter(([source, kind]) => source === B && kind === "msg")).toEqual([
        [B, "msg", minute(NOW - 3 * DAY_MS + 30 * MINUTE), 1], [B, "msg", minute(NOW - 2 * DAY_MS), 1], [B, "msg", minute(NOW - DAY_MS), 1]]);
      expect(db.commit((tx) => tx.tally.chunks(DAY))).toEqual([]);
      artifact.rebuild = { chunks: all.length, tally: tallied(path) };
    } finally {
      db.close();
    }
  });

  it("rebuilds across midnight: the prune between two chunks leaves today's starts tallied, and nothing before the new floor", () => {
    const { path, db } = fresh();
    try {
      const midnight = dayBounds(addDays(civilDay(NOW, DAY), 1), DAY).start_ms;
      db.commit((tx) => tx.tally.prune(DAY, midnight - 30 * MINUTE));
      land(db, A, [msg("tonight", midnight - 20 * MINUTE), msg("tomorrow", midnight + 30 * MINUTE), msg("oldest", windowFloor(DAY, midnight - 30 * MINUTE) + MINUTE)]);
      const spoil = new Database(path);
      spoil.prepare("DELETE FROM start_minutes").run();
      spoil.close();
      const all = db.commit((tx) => tx.tally.chunks(DAY));
      db.commit((tx) => tx.tally.rebuild(all[0]!));
      db.commit((tx) => tx.tally.prune(DAY, midnight + MINUTE));
      for (const chunk of all.slice(1)) db.commit((tx) => tx.tally.rebuild(chunk));
      db.commit((tx) => tx.tally.complete());
      expect(tallied(path)).toEqual(truth(path));
      expect(tallied(path).map(([, , at]) => at)).toEqual([minute(midnight - 20 * MINUTE), minute(midnight + 30 * MINUTE)]);
      artifact.midnight = { chunks: all.length, tally: tallied(path) };
    } finally {
      db.close();
    }
  });

  it("counts a date on its own civil day west of UTC, a month and a year on none, and places dates again when the day settings change", () => {
    const york: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const now = Date.UTC(2027, 0, 3, 18);
    const { path, db } = fresh(york, now);
    try {
      rebuild(db, york);
      const date = instant("2027-01-02", "date");
      const year = instant("2027", "year");
      land(db, A, [
        { kind: "msg", key: "all-day", content: { text: "all day" }, time: date },
        { kind: "msg", key: "january", content: { text: "a month" }, time: instant("2027-01", "month") },
        { kind: "msg", key: "the-year", content: { text: "a year" }, time: year },
        msg("instant", year.start_ms),
      ]);
      const week = (day: DaySettings) => raw(path, (sql) => weekOf(weeksOf(sql, kindsOf(sql, null), day, now)!, A));
      const today = civilDay(now, york);
      const at = (day: string) => 6 - (Date.parse(today) - Date.parse(day)) / DAY_MS;
      expect(week(york)).toEqual(Array.from({ length: 7 }, (_, index) => (index === at("2027-01-02") || index === at("2026-12-31") ? 1 : 0)));
      const placed = tallied(path);
      expect(placed).toEqual([[A, "msg", minute(year.start_ms), 1], [A, "msg", minute(dayBounds("2027-01-02", york).start_ms), 1]]);
      db.commit((tx) => tx.tables.meta.delete(TALLY_MARK));
      rebuild(db, york);
      expect(tallied(path)).toEqual(placed);
      db.commit((tx) => tx.tally.prune(DAY, now));
      expect(db.commit((tx) => tx.tally.mark())).toBeNull();
      rebuild(db);
      expect(tallied(path)).toEqual([[A, "msg", minute(year.start_ms), 1], [A, "msg", minute(date.start_ms), 1]]);
      db.commit((tx) => tx.tally.prune(DAY, now));
      expect(db.commit((tx) => tx.tally.mark())).not.toBeNull();
      artifact.dates = { tally: tallied(path), week: week(DAY) };
    } finally {
      db.close();
    }
  });

  it("takes a date a later land changes off its own day's minute, west of UTC, never its midnight UTC's", () => {
    const york: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const now = Date.UTC(2027, 0, 3, 18);
    const { path, db } = fresh(york, now);
    try {
      rebuild(db, york);
      land(db, A, [{ kind: "msg", key: "all-day", content: { text: "all day" }, time: instant("2027-01-02", "date") }]);
      expect(tallied(path)).toEqual([[A, "msg", minute(dayBounds("2027-01-02", york).start_ms), 1]]);
      land(db, A, [{ kind: "msg", key: "all-day", content: { text: "moved" }, time: instant("2027-01-01", "date") }]);
      expect(tallied(path)).toEqual([[A, "msg", minute(dayBounds("2027-01-01", york).start_ms), 1]]);
      artifact.changed_date = tallied(path);
    } finally {
      db.close();
    }
  });

  it("answers no week before the rebuild completes, and only the kinds its noun counts", () => {
    const { path, db } = fresh();
    try {
      land(db, A, [msg("today", NOW - MINUTE), msg("y1", NOW - DAY_MS), msg("y2", NOW - DAY_MS + MINUTE), msg("c", NOW - MINUTE, "c", "note"), msg("tomorrow", NOW + DAY_MS)]);
      land(db, B, [msg("six", NOW - 6 * DAY_MS)]);
      const week = (counts: string[] | null) => raw(path, (sql) => {
        const weeks = weeksOf(sql, kindsOf(sql, counts), DAY, NOW);
        return weeks === null ? null : [A, B].map((source) => weekOf(weeks, source)).reduce((sum, each) => sum.map((n, at) => n + each[at]!));
      });
      expect(week(null)).toBeNull();
      expect(rebuild(db)).toBeGreaterThan(0);
      expect([week(null), week(["msg"])]).toEqual([[1, 0, 0, 0, 0, 2, 2], [1, 0, 0, 0, 0, 2, 1]]);
      artifact.week = { all: week(null), msg: week(["msg"]) };
    } finally {
      db.close();
    }
  });

});
