import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { leftOf } from "./asks-left.js";
import { Sql } from "./sql.js";
import { FILL_ASKS, homeSchema, LEFT_MARK, NEWEST, openHome, openHomeFolder, readTables, Schema, type AskRow, type HomeDb, type LeftMark } from "./index.js";

const DAY_MS = 86_400_000;
const NOON = Date.UTC(2026, 10, 12, 12);
const MAIL = "gmail/mail";
const PHOTOS = "whatsapp/photos";
const STARTS = [NOON - 5 * DAY_MS + 1_234, Date.UTC(2026, 10, 10), NOON - DAY_MS, -DAY_MS - 7, Number.MIN_SAFE_INTEGER];

function ask(item: string, at_key: number, more: Partial<AskRow> = {}): AskRow {
  return {
    family: "mail", item, prompt: "mail-tag", version: 1, input_hash: `hash-${item}`, unit: "unit-a", work_id: MAIL, at_key,
    started: false, waits: null, retry_ms: null, given_up: null, unhideable: null, state: "pending", ...more,
  };
}

describe("what each work has left to ask", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });

  function fresh(): { path: string; home: HomeDb } {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-asks-left-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    return { path, home: openHome(openHomeFolder(dirname(path)), "migrate") };
  }

  function agrees(path: string): void {
    const db = new Database(path, { readonly: true });
    try {
      const day = "(CASE WHEN at_key >= 0 THEN at_key / 86400000 ELSE (at_key + 1) / 86400000 - 1 END)";
      const kept = db.prepare("SELECT work_id, prompt, day, pending FROM asks_left WHERE pending <> 0 ORDER BY work_id, prompt, day").all();
      const counted = db.prepare(`SELECT work_id, prompt, ${day} AS day, count(*) AS pending FROM asks
        WHERE state = 'pending' AND work_id IS NOT NULL GROUP BY work_id, prompt, day ORDER BY work_id, prompt, day`).all();
      expect(kept).toEqual(counted);
      const tables = readTables(db);
      for (const work of [MAIL, PHOTOS]) {
        const walked = (db.prepare(`SELECT prompt, count(*) AS total${STARTS.map((_, index) => `, sum(at_key >= ?) AS s${index}`).join("")}
          FROM asks WHERE work_id = ? AND state = 'pending' GROUP BY prompt ORDER BY prompt`).all(...STARTS, work) as ({ prompt: string; total: number } & Record<string, number>)[])
          .map((row) => ({ prompt: row.prompt, total: row.total, from: STARTS.map((_, index) => row[`s${index}`]) }));
        expect(tables.asks.left(work, STARTS)).toEqual(walked);
      }
    } finally {
      db.close();
    }
  }

  it("is the pending asks counted, through every writer of asks", () => {
    const { path, home } = fresh();
    try {
      const extract = (unit: string, end_ms: number | null) => ({
        family: "mail", unit, reading: `r-${unit}-${end_ms}`, code: "1", content: {}, start_ms: null, end_ms, days: ["2026-11-12"], seq: 1,
      });
      home.commit((tx) => {
        tx.derived.extracts.put(extract("unit-a", NOON));
        tx.derived.extracts.put(extract("unit-b", NOON - 3 * DAY_MS));
        tx.derived.extracts.put(extract("unit-c", null));
        tx.tables.asks.put(ask("m1", NOON));
        tx.tables.asks.put(ask("m2", NOON - 5 * DAY_MS + 1_234));
        tx.tables.asks.put(ask("m3", NOON - 5 * DAY_MS + 1_233));
        tx.tables.asks.put(ask("m4", Date.UTC(2026, 10, 10)));
        tx.tables.asks.put(ask("m5", -DAY_MS - 7));
        tx.tables.asks.put(ask("m6", -DAY_MS - 8, { prompt: "mail-other" }));
        tx.tables.asks.put(ask("m7", NEWEST, { unit: "unit-c" }));
        tx.tables.asks.put(ask("m8", NOON, { work_id: null }));
        tx.tables.asks.put(ask("m9", NOON, { state: "done" }));
        tx.tables.asks.put(ask("b1", NOON - 3 * DAY_MS, { unit: "unit-b" }));
        tx.tables.asks.put(ask("b2", NOON - 3 * DAY_MS, { unit: "unit-b", prompt: "mail-other" }));
        tx.tables.asks.put(ask("p1", NOON - 2 * DAY_MS, { family: "photos", unit: "photo-a", work_id: PHOTOS, prompt: "photo-caption" }));
        tx.tables.asks.put(ask("p2", NOON - 9 * DAY_MS, { family: "photos", unit: "photo-a", work_id: PHOTOS, prompt: "photo-text" }));
      });
      agrees(path);
      home.commit((tx) => {
        tx.tables.asks.put(ask("m1", NOON - 40 * DAY_MS));
        tx.tables.asks.put(ask("m2", NOON - 5 * DAY_MS + 1_234, { work_id: PHOTOS }));
        tx.tables.asks.put(ask("m3", NOON - 5 * DAY_MS + 1_233, { state: "done" }));
        tx.tables.asks.put(ask("m9", NOON));
        tx.tables.asks.put(ask("m8", NOON));
      });
      agrees(path);
      home.commit((tx) => {
        tx.tables.asks.giveUp("mail", "m1", "mail-tag", "route-a");
        tx.tables.asks.giveUp("mail", "m3", "mail-tag", "route-a");
        tx.tables.asks.giveUp("mail", "m4", "mail-tag", "route-a");
      });
      agrees(path);
      home.commit((tx) => {
        expect(tx.tables.asks.reopen("mail", "m1", "mail-tag")).toBe(true);
        expect(tx.tables.asks.reopen("mail", "m1", "mail-tag")).toBe(false);
        tx.tables.itemRoutes.set({ family: "mail", item: "m4", prompt: "mail-tag", route: "route-b", model: "model-b" });
        tx.tables.itemRoutes.set({ family: "mail", item: "m4", prompt: "mail-tag", route: "route-b", model: "model-b" });
      });
      agrees(path);
      home.commit((tx) => tx.derived.extracts.put(extract("unit-b", NOON - 4 * DAY_MS)));
      agrees(path);
      home.commit((tx) => {
        tx.derived.next.put(extract("unit-a", NOON - DAY_MS + 1));
        tx.derived.next.put(extract("unit-c", null));
        tx.derived.extracts.publish("mail", tx.derived.extracts.compare("mail"));
      });
      agrees(path);
      home.commit((tx) => tx.derived.extracts.delete("mail", "unit-a"));
      agrees(path);
      home.commit((tx) => {
        tx.tables.asks.put(ask("m10", NOON, { unit: "unit-c" }));
        tx.tables.asks.put(ask("m10", NOON, { unit: "unit-c", prompt: "mail-other" }));
        tx.tables.asks.put(ask("m11", NOON, { unit: "unit-c" }));
        tx.tables.asks.put(ask("m12", NOON, { unit: "unit-c" }));
      });
      home.commit((tx) => {
        tx.tables.asks.delete("mail", "m10", "mail-tag");
        tx.tables.asks.delete("mail", "m11");
        tx.records.erase({ records: [], items: [{ family: "mail", item: "m12" }], reason: "test", at_ms: NOON });
      });
      agrees(path);
      home.commit((tx) => {
        for (const item of ["p1", "p2"]) tx.tables.asks.delete("photos", item);
      });
      agrees(path);
      const read = new Database(path, { readonly: true });
      try {
        expect(readTables(read).asks.left(PHOTOS, STARTS)).toEqual([]);
      } finally {
        read.close();
      }
    } finally {
      home.close();
    }
  });

  it("reads no ask for a start at a day's first instant, and a start asked twice once", () => {
    const { path, home } = fresh();
    const MIDNIGHT = Date.UTC(2026, 10, 12);
    home.commit((tx) => {
      tx.tables.asks.put(ask("m1", MIDNIGHT));
      tx.tables.asks.put(ask("m2", MIDNIGHT - 1));
      tx.tables.asks.put(ask("m3", NOON));
      tx.tables.asks.put(ask("m4", MIDNIGHT - DAY_MS));
      tx.tables.asks.put(ask("m5", NEWEST, { prompt: "mail-other" }));
      tx.tables.asks.put(ask("m6", -DAY_MS));
    });
    home.close();
    const db = new Database(path, { readonly: true });
    try {
      const read: string[] = [];
      const sql = new (class extends Sql {
        override all<T>(text: string, ...params: unknown[]): T[] {
          read.push(/\bFROM asks\b(?!_)/u.test(text) ? "asks" : "asks_left");
          return super.all<T>(text, ...params);
        }
      })(db);
      const walk = (starts: number[]) => (db.prepare(`SELECT prompt, count(*) AS total${starts.map((_, index) => `, sum(at_key >= ?) AS s${index}`).join("")}
        FROM asks WHERE work_id = ? AND state = 'pending' GROUP BY prompt ORDER BY prompt`).all(...starts, MAIL) as ({ prompt: string; total: number } & Record<string, number>)[])
        .map((row) => ({ prompt: row.prompt, total: row.total, from: starts.map((_, index) => row[`s${index}`]) }));
      const midnights = [MIDNIGHT, MIDNIGHT, MIDNIGHT - DAY_MS, -DAY_MS, 0, MIDNIGHT + DAY_MS];
      expect(leftOf(sql, MAIL, midnights)).toEqual(walk(midnights));
      expect(read).toEqual(["asks_left"]);
      read.length = 0;
      const mixed = [NOON - 1, MIDNIGHT, NOON - 1, MIDNIGHT - 1, MIDNIGHT];
      expect(leftOf(sql, MAIL, mixed)).toEqual(walk(mixed));
      expect(read).toEqual(["asks_left", "asks", "asks"]);
    } finally {
      db.close();
    }
  });

  function before(rows: AskRow[]): string {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-asks-left-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    const at24 = new Schema({ name: homeSchema.name, file: homeSchema.file, base: homeSchema.base, baseline: homeSchema.baseline, migrations: homeSchema.migrations.slice(0, 2), small: [...homeSchema.small] });
    const db = new Database(path);
    try {
      at24.open(db, "migrate");
      const insert = db.prepare(`INSERT INTO asks (family, item, prompt, prompt_hash, prompt_version, input_hash, unit, work_id, at_key, started, waits, retry_ms, given_up, state)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      db.transaction(() => {
        for (const row of rows) {
          insert.run(row.family, row.item, row.prompt, row.version, row.input_hash, row.unit, row.work_id, row.at_key, row.started ? 1 : 0, row.waits, row.retry_ms, row.given_up, row.state);
        }
      })();
    } finally {
      db.close();
    }
    return path;
  }

  function markOf(path: string): LeftMark | null {
    const db = new Database(path, { readonly: true });
    try {
      const value = db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(LEFT_MARK) as string | undefined;
      return value === undefined ? null : JSON.parse(value) as LeftMark;
    } finally {
      db.close();
    }
  }

  it("is made empty by its migration, marked to fill only where a work has a pending ask", () => {
    const none = before([ask("m1", NOON, { work_id: null }), ask("m2", NOON, { state: "done" })]);
    openHome(openHomeFolder(dirname(none)), "migrate").close();
    expect(markOf(none)).toBeNull();
    agrees(none);

    const some = before([ask("m1", NOON), ask("m2", NOON - DAY_MS, { prompt: "mail-other" }), ask("m3", NOON, { work_id: null })]);
    const home = openHome(openHomeFolder(dirname(some)), "migrate");
    try {
      expect(markOf(some)).toEqual({ at: null });
      const db = new Database(some, { readonly: true });
      try {
        expect(db.prepare("SELECT count(*) FROM asks_left").pluck().get()).toBe(0);
        expect(readTables(db).asks.left(MAIL, STARTS)).toBeNull();
        expect(readTables(db).asks.filling()).toBe(true);
      } finally {
        db.close();
      }
      expect(home.commit((tx) => tx.tables.asks.fill())).toBe(true);
      expect(home.commit((tx) => tx.tables.asks.filling())).toBe(false);
    } finally {
      home.close();
    }
    expect(markOf(some)).toBeNull();
    agrees(some);
  });

  it("is filled in bounded commits, a writer between them counting only what the fill has passed", () => {
    const BASE = NOON - 40 * DAY_MS;
    const endOf = (unit: number) => BASE + unit * Math.floor(DAY_MS / 3);
    const rows: AskRow[] = [];
    for (let unit = 0; unit < 30; unit++) {
      const photo = unit >= 20;
      for (let n = 0; n < 300; n++) {
        rows.push(ask(`i${unit}-${n}`, endOf(unit), {
          family: photo ? "photos" : "mail", unit: `u${unit}`, work_id: photo ? PHOTOS : MAIL, prompt: n % 3 === 0 ? "second" : "first",
        }));
      }
    }
    const path = before(rows);
    const home = openHome(openHomeFolder(dirname(path)), "migrate");
    const extract = (family: string, unit: string, end_ms: number) => ({
      family, unit, reading: `r-${unit}-${end_ms}`, code: "1", content: {}, start_ms: null, end_ms, days: ["2026-11-12"], seq: 1,
    });
    try {
      home.commit((tx) => {
        for (let unit = 0; unit < 30; unit++) tx.derived.extracts.put(extract(unit >= 20 ? "photos" : "mail", `u${unit}`, endOf(unit)));
      });
      const counted = () => {
        const db = new Database(path, { readonly: true });
        try {
          return db.prepare("SELECT coalesce(sum(pending), 0) FROM asks_left").pluck().get() as number;
        } finally {
          db.close();
        }
      };
      const holds = () => {
        const mark = markOf(path)!;
        const db = new Database(path, { readonly: true });
        try {
          const day = "(CASE WHEN at_key >= 0 THEN at_key / 86400000 ELSE (at_key + 1) / 86400000 - 1 END)";
          const kept = db.prepare("SELECT work_id, prompt, day, pending FROM asks_left WHERE pending <> 0 ORDER BY work_id, prompt, day").all();
          const passed = db.prepare(`SELECT work_id, prompt, ${day} AS day, count(*) AS pending FROM asks
            WHERE state = 'pending' AND work_id IS NOT NULL AND (work_id, started, at_key, unit, item, prompt, family) <= (?, ?, ?, ?, ?, ?, ?)
            GROUP BY work_id, prompt, day ORDER BY work_id, prompt, day`).all(...mark.at!);
          expect(kept).toEqual(passed);
          expect(readTables(db).asks.left(MAIL, STARTS)).toBeNull();
        } finally {
          db.close();
        }
      };

      expect(home.commit((tx) => tx.tables.asks.fill())).toBe(false);
      expect(counted()).toBe(FILL_ASKS);
      const first = markOf(path)!.at!;
      expect(first.slice(0, 4)).toEqual([MAIL, 0, endOf(13), "u13"]);
      holds();

      home.commit((tx) => tx.derived.extracts.put(extract("mail", "u2", endOf(29) + DAY_MS)));
      holds();
      home.commit((tx) => tx.derived.extracts.put(extract("mail", "u17", BASE - 3 * DAY_MS)));
      holds();
      home.commit((tx) => {
        tx.tables.asks.put(ask("new-before", BASE - 9 * DAY_MS, { unit: "u-new" }));
        tx.tables.asks.put(ask("new-after", endOf(19) + 1, { unit: "u-new" }));
        tx.tables.asks.put(ask("i0-1", endOf(0), { unit: "u0", prompt: "first", started: true }));
        tx.tables.asks.put(ask("i18-1", endOf(18), { unit: "u18", prompt: "first", started: true }));
        tx.tables.asks.giveUp("mail", "i1-1", "first", "route-a");
        tx.tables.asks.giveUp("mail", "i19-1", "first", "route-a");
        tx.tables.asks.giveUp("mail", "i1-2", "first", "route-a");
        tx.tables.asks.reopen("mail", "i1-2", "first");
        tx.tables.asks.delete("mail", "i1-4");
        tx.tables.asks.delete("mail", "i19-4");
        tx.records.erase({ records: [], items: [{ family: "mail", item: "i3-5" }, { family: "photos", item: "i25-5" }], reason: "test", at_ms: NOON });
        tx.derived.extracts.delete("mail", "u5");
        tx.derived.extracts.delete("photos", "u21");
      });
      holds();

      for (;;) {
        const was = counted();
        const done = home.commit((tx) => tx.tables.asks.fill());
        expect(counted() - was).toBeLessThanOrEqual(FILL_ASKS);
        if (done) break;
        holds();
      }
      expect(markOf(path)).toBeNull();
      agrees(path);
    } finally {
      home.close();
    }
  });
});
