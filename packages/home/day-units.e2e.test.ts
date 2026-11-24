import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type DayUnit, type HomeDb, type JobRow, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { DAY_FILES, extractKind, readDayHead, rebuildExtracts, renderKind } from "./derive.js";
import { LANE, type HelperEnv, type Kind, type Main, type Running } from "./jobs.js";
import { effective } from "./settings.js";
import fakeRegistry, { fakeRows } from "./test/fakes.js";
import { artifact, makeRoot, removeRoot } from "./test/harness-root.js";
import { homeOf } from "./registry.js";


const DAY = "2026-09-03";
const SOURCES = Array.from({ length: 12 }, (_, index) => `apple-notes:local:device-${String(index + 1).padStart(2, "0")}`);
const CONTACTS = "apple-contacts:local:device-a";
const HOURS = Array.from({ length: 10 }, (_, index) => 12 + index);
const HIDDEN = "+15550000001";
const at = (hour: number, minute = 0) => Date.parse(`${DAY}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
const note = (key: string, text: string, ms: number, extra: JsonObject = {}): ReaderOutput =>
  ({ kind: "note", key, content: { text, at: ms, ...extra }, time: { start_ms: ms, precision: "ms" } });

describe("a render writes only the day's rows that changed", () => {
  let root: string | undefined;
  afterAll(() => {
    if (root !== undefined) removeRoot(root);
  });

  it("one source's change rewrites its rows, a flip of shown updates, a removed unit goes, and a day that changed nothing writes nothing", async () => {
    root = makeRoot("lifestream-day-units-", {
      sources: { ...Object.fromEntries(SOURCES.map((id) => [id, "fake-rows"])), [CONTACTS]: "fake-rows" },
      settings: { "families.notes": { per: "hour" } },
    });
    const home = root;
    const settings = effective(home).settings;
    const registry = fakeRegistry(settings, homeOf(openHomeFolder(home)));
    const db = openHome(openHomeFolder(home), "migrate");
    const reader = openHome(openHomeFolder(home), "read");
    const blobs = openHomeFolder(home).blobs(join(home, "blobs"));
    const raw = (db as unknown as { db: Database.Database }).db;
    raw.exec(`
      CREATE TEMP TABLE writes (op TEXT NOT NULL, family TEXT NOT NULL, unit TEXT NOT NULL);
      CREATE TEMP TRIGGER writes_insert AFTER INSERT ON main.day_units BEGIN INSERT INTO writes VALUES ('insert', new.family, new.unit); END;
      CREATE TEMP TRIGGER writes_update AFTER UPDATE ON main.day_units BEGIN INSERT INTO writes VALUES ('update', new.family, new.unit); END;
      CREATE TEMP TRIGGER writes_delete AFTER DELETE ON main.day_units BEGIN INSERT INTO writes VALUES ('delete', old.family, old.unit); END;
    `);
    const writes = () => {
      const rows = raw.prepare("SELECT op, family, unit FROM writes ORDER BY rowid").all() as { op: string; family: string; unit: string }[];
      raw.exec("DELETE FROM writes");
      return rows;
    };
    const units = () => raw.prepare("SELECT family, unit, reading, code, shown FROM day_units WHERE day = ? ORDER BY family, unit").all(DAY) as
      { family: string; unit: string; reading: string; code: string; shown: number }[];
    const files = () => Object.fromEntries(Object.values(DAY_FILES).map((suffix) => [suffix, readFileSync(join(home, "days", `${DAY}.${suffix}`), "utf8")]));
    const listed = () => (raw.prepare("SELECT day, inputs, counts FROM days").all() as { day: string; inputs: string; counts: string }[])
      .map((row) => ({ ...row, counts: JSON.parse(row.counts) as unknown }));
    const head = () => {
      const { inputs, counts } = readDayHead(openHomeFolder(home), DAY)!;
      return [{ day: DAY, inputs, counts }];
    };
    let told = 0;
    const events = () => {
      const rows = raw.prepare("SELECT seq, key FROM events WHERE kind = 'day' AND seq > ? ORDER BY seq").all(told) as { seq: number; key: string }[];
      told = rows.at(-1)?.seq ?? told;
      return rows.map((row) => row.key);
    };
    let deliveries = 0;
    const land = (source: string, rows: ReaderOutput[]) => db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: Date.now() });
      tx.records.land(run, { id: `${source}/${++deliveries}`, source, stated_ms: Date.now() }, rows, fakeRows.kinds, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: Date.now(), outcome: "ok" });
    });

    const main = { folder: openHomeFolder(home), settings, registry, families: new Map(registry.families.map((family) => [family.name, family])), now: () => Date.now() } as unknown as Main;
    const env = { folder: openHomeFolder(home), settings, registry, db: reader, blobs, committed: async () => undefined } as unknown as HelperEnv;
    const drive = async <D, C, R, S>(kind: Kind<D, C, R, S>, key: string) => {
      for (let id = 1; ; id++) {
        const job = { id, kind: kind === renderKind as unknown ? "render" : "extract", key, lane: LANE.backfill, not_before_ms: 0, started_ms: Date.now() } as JobRow;
        const begun = db.commit((tx) => kind.begin!(main, tx, job));
        if (begun === null) return;
        const running: Running<S> = { job, state: begun.state };
        const steps = kind.helper(env, { job: id, kind: job.kind, key, lane: LANE.backfill, now_ms: Date.now(), data: begun.data });
        let next = await steps.next();
        for (; next.done !== true; next = await steps.next()) {
          for (const slice of kind.chunk?.(main, running, next.value) ?? []) {
            slice.settle?.();
            db.commit((tx) => slice.work(tx));
          }
        }
        db.commit((tx) => kind.done(main, tx, running, next.value as R));
        if (running.again === undefined) return;
      }
    };
    const render = async () => {
      for (const family of ["notes", "labels"]) await drive(extractKind, family);
      writes();
      await drive(renderKind, "days");
      return writes();
    };
    const report: Record<string, unknown> = {};

    try {
      db.commit((tx) => {
        for (const family of ["notes", "labels"]) rebuildExtracts(tx, family, Date.now());
      });
      for (const source of SOURCES) land(source, HOURS.map((hour) => note(`n${hour}`, `synthetic note ${hour}`, at(hour, 10))));
      land(SOURCES[0]!, [note("h", "synthetic note about a person", at(22, 10), { hidden: HIDDEN })]);
      const first = await render();
      const all = units();
      const notes = all.filter((row) => row.family === "notes");
      expect(notes.length).toBe(SOURCES.length * HOURS.length + 1);
      expect(first.length).toBe(all.length);
      expect(first.every((write) => write.op === "insert")).toBe(true);
      const hidden = `${SOURCES[0]}/${DAY}T22`;
      expect(all.find((row) => row.unit === hidden)?.shown).toBe(0);
      report.first = { rows: all.length, writes: first.length };
      expect(listed()).toEqual(head());
      expect(events()).toEqual([DAY]);

      const before = files();
      db.commit((tx) => tx.tables.dirty.days([DAY]));
      expect(await render()).toEqual([]);
      expect(units()).toEqual(all);
      expect(files()).toEqual(before);
      const same: DayUnit[] = all.map((row) => ({ family: row.family, unit: row.unit, reading: row.reading, code: row.code, shown: row.shown === 1 }));
      expect(db.commit((tx) => tx.derived.dayUnits.put(DAY, same))).toBe(false);
      expect(writes()).toEqual([]);
      expect(listed()).toEqual(head());
      expect(events()).toEqual([]);
      report.unchanged = { writes: 0 };

      db.commit((tx) => {
        tx.derived.days.delete(DAY);
        tx.tables.dirty.days([DAY]);
      });
      await render();
      expect(files()).toEqual(before);
      expect(listed()).toEqual(head());
      expect(events()).toEqual([DAY]);
      report.healed = { listed: listed() };

      const last = SOURCES.at(-1)!;
      land(last, [note("n12", "synthetic note 12, edited", at(12, 10)), note("n13", "synthetic note 13", at(23, 10))]);
      const changed = await render();
      expect(changed.map(({ op, unit }) => `${op} ${unit}`).sort()).toEqual([
        `delete ${last}/${DAY}T13`, `insert ${last}/${DAY}T23`, `update ${last}/${DAY}T12`,
      ]);
      const after = units();
      const untouched = (rows: typeof all) => rows.filter((row) => !row.unit.startsWith(`${last}/`));
      expect(untouched(after)).toEqual(untouched(all));
      expect(after.some((row) => row.unit === `${last}/${DAY}T13`)).toBe(false);
      expect(files()["day.txt"]).toContain("synthetic note 12, edited");
      report.changed = { rows: after.length, writes: changed };

      land(CONTACTS, [{ kind: "contact", key: "c1", content: { card: `BEGIN:VCARD\r\nFN:Person A\r\nTEL:${HIDDEN}\r\nEND:VCARD\r\n` } }]);
      const flipped = await render();
      expect(flipped.map(({ op, family }) => `${op} ${family}`).sort()).toEqual(["update labels", "update notes"]);
      expect(flipped.find((write) => write.family === "notes")?.unit).toBe(hidden);
      const shown = units();
      const was = after.find((row) => row.unit === hidden)!;
      expect(shown.find((row) => row.unit === hidden)).toEqual({ ...was, shown: 1 });
      expect(files()["day.txt"]).toContain("synthetic note about a person");
      report.flipped = { writes: flipped };

      const incremental = { rows: shown, files: files() };
      db.commit((tx) => {
        tx.derived.dayUnits.put(DAY, []);
        tx.tables.dirty.days([DAY]);
      });
      for (const suffix of Object.values(DAY_FILES)) rmSync(join(home, "days", `${DAY}.${suffix}`));
      writes();
      await drive(renderKind, "days");
      expect({ rows: units(), files: files() }).toEqual(incremental);
      artifact(home, "day-units", report);
    } finally {
      reader.close();
      db.close();
    }
  });
});
