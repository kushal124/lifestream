import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { DAYS_MARK, openHome, openHomeFolder, type DaySettings, type Tx } from "@lifestreamprotocol/core";
import { listeningFamily, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, RENDERER_VERSION, type DayDocument, type DayFileFact, type Family } from "@lifestreamprotocol/families";
import { renderKind } from "./derive.js";
import { Due } from "./due.js";
import type { HelperEnv, Main } from "./jobs.js";
import { indexKind } from "./index-job.js";
import { days, readDay, RUN_DAYS } from "./search.js";
import { freshOf, PENDING_NAMED, type HeldDays } from "./index-file.js";
import { minorUnits, SearchIndex, searchFileOf, type IndexedDay, type RecordEntry } from "./search-index.js";
import { Refusal } from "./refusal.js";
import { rowsCounted } from "./work.js";
import { effective } from "./settings.js";
import { notesFamily } from "./test/fakes.js";
import { makeRoot } from "./test/harness-root.js";
import { REPO } from "./test/support.js";
import { countAsked, countOf, shown } from "./test/record-reads.js";


const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const FIXTURE = join(REPO, "packages", "families", "test", "facts");
const ALL = () => true;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-facts-"));
let root: string;
let file: string;

beforeEach((context) => {
  root = join(scratch, context.task.name.slice(0, 3).trim());
  mkdirSync(join(root, "days"), { recursive: true });
  file = join(root, "machine", "index.db");
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const fixture = (day: string) => JSON.parse(readFileSync(join(FIXTURE, `${day}.day.json`), "utf8")) as DayDocument;
const CALL = "calls:debe53fddb0e37e56b297bb3";
const indexed = (document: DayDocument, mtime_us = 1): IndexedDay => ({
  inputs: document.inputs, mtime_us, atoms: [], facts: { window: document.window, facts: document.facts },
});
const rows = (index: SearchIndex, sql: string, ...args: unknown[]) => {
  const db = new Database(index.file, { readonly: true });
  try {
    return db.prepare(sql).all(...args) as Record<string, unknown>[];
  } finally {
    db.close();
  }
};
const sum = (index: SearchIndex, of: string, measure: string, from: string, to: string): number => {
  return rows(index, `SELECT coalesce(sum(m.value), 0) AS total FROM fact_measure m JOIN fact f ON f.fid = m.fid WHERE f.of = ? AND m.measure = ? AND f.day >= ? AND f.day <= ?`, of, measure, from, to)[0]!.total as number;
};

const DAY0 = Date.parse("2026-10-01T00:00:00Z");
const paymentsDay = (day: string, payments: [string, string][]): DayDocument => {
  const start = DAY0 + (Date.parse(`${day}T00:00:00Z`) - DAY0);
  const facts: DayFileFact[] = payments.map(([key, amount], at) => ({
    id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: start, start_ms: start, end_ms: start, date_only: true,
    keys: { payee: `Shop ${key}`, direction: "out", currency: "USD" }, measures: { amount }, who: [],
    from: { units: [`money/${key}`], record: { source: "bank:acct:mac", kind: "payment", key }, alone: true }, lines: [at + 1],
  }));
  return {
    day, zone: "UTC", day_start_hour: 0, window: { start_ms: start, end_ms: start + 86_400_000 }, renderer: RENDERER_VERSION, inputs: `sha256:${createHash("sha256").update(`${day} ${payments.map(([key]) => key).join("")}`).digest("hex")}`,
    counts: { total: payments.length, per_family: { money: payments.length } }, coverage: [], atoms: [], facts,
  };
};
const older = (document: DayDocument): DayDocument => ({
  ...document, renderer: "9/2-d9f8a5b4946e/5", inputs: `sha256:${createHash("sha256").update(`older ${document.inputs}`).digest("hex")}`,
  facts: document.facts.map(({ from: { units, ...from }, ...fact }) => ({ ...fact, from: { ...from, unit: units[0] } })) as unknown as DayFileFact[],
});
const write = (document: DayDocument, mtime_s: number) => {
  const path = join(root, "days", `${document.day}.day.json`);
  const { atoms, facts, ...head } = document;
  const list = (items: readonly unknown[]) => items.length === 0 ? "[]" : `[\n${items.map((item) => `    ${JSON.stringify(item)}`).join(",\n")}\n  ]`;
  writeFileSync(path, `{\n${Object.entries(head).map(([name, value]) => `  ${JSON.stringify(name)}: ${JSON.stringify(value)}`).join(",\n")},\n  "atoms": ${list(atoms)},\n  "facts": ${list(facts)}\n}\n`);
  utimesSync(path, mtime_s, mtime_s);
};
const job = (index: SearchIndex) => days(openHomeFolder(root), index, { days: 0 }, performance.now());
const OCTOBER = ["payments", "2026-10-01", "2026-10-31"] as const;
const held = (index: SearchIndex) => index.snapshot({}, (read) => read.held(OCTOBER[1], OCTOBER[2]));
const NOW = Date.parse("2026-10-06T16:00:00Z");
const PAYMENTS = new Map(Object.entries(MONEY_COLLECTIONS));

function scheduled() {
  const at = makeRoot("lifestream-search-aside-", { sources: {} });
  root = at;
  mkdirSync(join(at, "days"), { recursive: true });
  const machine = join(at, "machine");
  const searchFile = searchFileOf(at, machine);
  const db = openHome(openHomeFolder(at), "migrate");
  db.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  const family = { ...notesFamily(), text: { version: "1", kinds: ["note"], of: () => null }, collections: { payments: {} } } as unknown as Family;
  const due = new Due({ folder: openHomeFolder(at), settings: { ...effective(at).settings, day: SETTINGS }, registry: { connectors: [], readers: [], families: [family], code: "test" }, families: new Map([[family.name, family]]), now: () => NOW, running: () => undefined });
  const main = { now: () => NOW, settings: { day: SETTINGS } } as unknown as Main;
  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    due.after(tx);
    return done;
  });
  const DAY5 = "2026-10-05";
  const queued = (): boolean => {
    const writer = new Database(join(at, "home.db"));
    try {
      return writer.prepare("DELETE FROM jobs WHERE kind = 'index' AND key = 'search' AND state = 'queued' RETURNING 1").all().length > 0;
    } finally {
      writer.close();
    }
  };
  return {
    searchFile,
    started(document: DayDocument, mtime_s: number) {
      write(document, mtime_s);
      commit((tx) => {
        tx.derived.days.put(DAY5, document.inputs, document.counts);
        tx.tables.dirty.days([DAY5]);
      });
    },
    listed(documents: readonly DayDocument[], mtime_s: number) {
      for (const document of documents) write(document, mtime_s);
      commit((tx) => {
        for (const document of documents) tx.derived.days.put(document.day, document.inputs, document.counts);
      });
    },
    unmark: () => commit((tx) => tx.tables.meta.delete(DAYS_MARK)),
    render(document: DayDocument | "threw", mtime_s?: number) {
      commit((tx) => tx.tables.dirty.days([DAY5]));
      commit((tx) => {
        const { marks } = tx.tables.dirty.nextDays(1, DAY5, DAY5)[0]!;
        const running = { job: {}, state: { written: 0, current: 0, set_aside: 0 } } as never;
        const files = mtime_s !== undefined;
        if (document !== "threw" && files) write(document, mtime_s);
        const outcome = document === "threw" ? { day: DAY5, marks, error: "threw" }
          : { day: DAY5, marks, head: { inputs: document.inputs, counts: document.counts }, units: [], devices: [], ...(files ? { staged: [] } : {}) };
        renderKind.chunk!(main, running, outcome as never)[0]!.work!(tx);
      });
    },
    retry: () => commit((tx) => tx.tables.dirty.retryDays()),
    mark: () => commit((tx) => tx.tables.dirty.days([DAY5])),
    unlist: () => commit((tx) => tx.derived.days.delete(DAY5)),
    queued,
    async search() {
      queued();
      const begun = commit((tx) => indexKind.begin!(main, tx, { key: "search" } as never)!);
      const running = { job: { key: "search", lane: 0, started_ms: NOW }, state: begun.state } as never;
      const env = { folder: openHomeFolder(at), machine, db, registry: { families: [family] }, settings: { day: SETTINGS } } as unknown as HelperEnv;
      const helper = indexKind.helper(env, { job: 1, kind: "index", key: "search", lane: 0, now_ms: NOW, data: begun.data });
      for (let step = await helper.next(); step.done !== true; step = await helper.next()) {
        const chunk = step.value;
        commit((tx) => indexKind.chunk!(main, running, chunk)[0]!.work!(tx));
      }
    },
    erase(records: { source: string; kind: string; key: string }[]) {
      rmSync(join(at, "days", `${DAY5}.day.json`), { force: true });
      for (const index of SearchIndex.existing(openHomeFolder(dirname(searchFile)), searchFile)) {
        index.forget(records, [DAY5]);
        index.close();
      }
      commit((tx) => {
        tx.derived.days.delete(DAY5);
        tx.tables.dirty.days([DAY5]);
      });
    },
    count(query = "from=2026-10-01&to=2026-10-31"): { n: number; sum: string | undefined; as_of?: string; pending?: { day: string; why: string }[]; pending_more?: number } {
      const index = SearchIndex.read(openHomeFolder(dirname(searchFile)), searchFile)!;
      try {
        const fresh = (seq: number, heldDays: HeldDays) => {
          const view = db.view();
          try {
            const fresh = freshOf(seq, heldDays, view, "2026-10-06", SETTINGS.zone);
            if (fresh === null) throw new Error("NOT_NOW");
            return fresh;
          } finally {
            view.close();
          }
        };
        const answer = shown(countOf(index, countAsked(Object.fromEntries(new URLSearchParams(`of=payments&measure=amount&${query}`)), PAYMENTS), {
          collections: PAYMENTS, settings: SETTINGS, now_ms: NOW, people: () => undefined, fresh,
        })) as { total: { n: number; sum?: string } | { n: number; sum?: string }[]; as_of?: string; pending?: { day: string; why: string }[]; pending_more?: number };
        const total = [answer.total].flat()[0]!;
        return {
          n: total.n, sum: total.sum, ...answer.as_of === undefined ? {} : { as_of: answer.as_of }, ...answer.pending === undefined ? {} : { pending: answer.pending },
          ...answer.pending_more === undefined ? {} : { pending_more: answer.pending_more },
        };
      } finally {
        index.close();
      }
    },
    pending() {
      return this.count().pending ?? [];
    },
    close() {
      db.close();
      rmSync(at, { recursive: true, force: true });
    },
  };
}

describe("the index's facts", () => {
  it("L1 a day's facts are its rows: measures, keys, people and lines; money in minor units", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    index.day("2026-10-24", indexed(fixture("2026-10-24")));
    index.day("2026-10-25", indexed(fixture("2026-10-25")));
    expect(rows(index, "SELECT of, day, count(*) AS n FROM fact GROUP BY of, day ORDER BY of, day")).toEqual([
      { of: "calls", day: "2026-10-24", n: 1 }, { of: "calls", day: "2026-10-25", n: 1 }, { of: "payments", day: "2026-10-25", n: 1 }, { of: "screen_time", day: "2026-10-25", n: 3 },
    ]);
    expect(rows(index, "SELECT f.day, m.value FROM fact f JOIN fact_measure m ON m.fid = f.fid AND m.measure = 'minutes' WHERE f.id = ?", CALL)).toEqual([{ day: "2026-10-24", value: 60 }]);
    expect(rows(index, "SELECT c.handles FROM fact f JOIN crews c ON c.id = f.crew WHERE f.id = ?", CALL)).toEqual([{ handles: "+15550000001" }]);
    expect(rows(index, "SELECT count(*) AS n FROM fact_line WHERE day = '2026-10-25' AND atom = 2")).toEqual([{ n: 3 }]);
    const payment = "payments:04281a010a56ffc6efb4ae97";
    expect(rows(index, "SELECT m.measure, m.value FROM fact_measure m JOIN fact f ON f.fid = m.fid WHERE f.id = ? ORDER BY m.measure", payment)).toEqual([
      { measure: "amount", value: -1250 }, { measure: "balance", value: 98750 },
    ]);
    expect(rows(index, "SELECT k.key, n.name FROM fact f JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of JOIN names n ON n.id = k.name WHERE f.id = ? ORDER BY k.key", payment)).toEqual([
      { key: "currency", name: "USD" }, { key: "direction", name: "out" }, { key: "payee", name: "Shop 4" },
    ]);
    index.day("2026-10-25", { inputs: "empty", mtime_us: 2, atoms: [], facts: { window: fixture("2026-10-25").window, facts: [] } });
    expect(rows(index, "SELECT day FROM fact_line WHERE day = '2026-10-25'")).toEqual([]);
    expect(rows(index, "SELECT id FROM fact")).toEqual([{ id: CALL }]);
    expect(rows(index, "SELECT name FROM names WHERE role = 'value' ORDER BY name").map((row) => row["name"])).toEqual(["out", "phone"]);
    index.close();
  });

  it("L1 a currency's amount is exact in its minor units, or refused", () => {
    expect([minorUnits("-12.50", "USD", "f"), minorUnits("3", "USD", "f"), minorUnits("1200", "JPY", "f"), minorUnits("7.250", "USD", "f"), minorUnits("0.125", "BHD", "f")]).toEqual([-1250, 300, 1200, 725, 125]);
    expect(() => minorUnits("1.005", "USD", "f")).toThrow(/finer than its minor unit/u);
    expect(() => minorUnits("1.5", undefined, "f")).toThrow(/no currency/u);
  });

  it("L3 one payment erased: its amount gone, the day saying so until its render is read, then 80; a day gone with no erasure is simply gone", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-02", [["a", "20.00"]]), 1_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"]]), 1_000);
    job(index);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(12_000);
    rmSync(join(root, "days", "2026-10-05.day.json"));
    index.forget([{ source: "bank:acct:mac", kind: "payment", key: "b" }], ["2026-10-05"]);
    expect(rows(index, "SELECT value FROM fact_measure WHERE value = 4000")).toEqual([]);
    expect(rows(index, "SELECT id FROM fact WHERE id LIKE '%b'")).toEqual([]);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(2_000);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: true });
    job(index);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: true });
    const rendered = paymentsDay("2026-10-05", [["c", "60.00"]]);
    write(rendered, 2_000);
    job(index);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(8_000);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: rendered.inputs, erased: false });
    rmSync(join(root, "days", "2026-10-02.day.json"));
    job(index);
    expect([index.days().has("2026-10-02"), sum(index, "payments", "amount", "2026-10-01", "2026-10-31")]).toEqual([false, 6_000]);
    index.close();
  });

  it("L4 an erasure during a build reaches the build: its facts gone, the day erased there", () => {
    const before = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    before.day("2026-10-25", indexed(fixture("2026-10-25")));
    before.finish();
    before.close();
    const build = SearchIndex.write(openHomeFolder(dirname(file)), file, (_position, building) => building, 0, SETTINGS);
    expect(build.building).toBe(true);
    build.day("2026-10-25", indexed(fixture("2026-10-25")));
    build.close();
    const reached = SearchIndex.existing(openHomeFolder(dirname(file)), file);
    expect(reached.map((index) => index.building).sort()).toEqual([false, true]);
    for (const index of reached) index.forget([], ["2026-10-25"]);
    for (const index of reached) {
      expect(rows(index, "SELECT count(*) AS n FROM fact_measure m JOIN fact f ON f.fid = m.fid WHERE f.day = '2026-10-25'")).toEqual([{ n: 0 }]);
      expect(rows(index, "SELECT count(*) AS n FROM fact")).toEqual([{ n: 0 }]);
      expect(held(index).days.get("2026-10-25")).toEqual({ inputs: "", erased: true });
      index.close();
    }
  });

  it("L5 the content revision moves with each change a query sees, and not otherwise", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const count = () => Number(index.revision().split(":")[1]);
    let last = count();
    const moved = () => {
      const now = count();
      const was = last;
      last = now;
      return now - was;
    };
    expect(last).toBe(0);
    const position = (seq: number) => ({ position: { seq, statement: `s-${seq}`, reread: 0 } });
    const note = { record: { source: "notes:a:b", kind: "note", key: "n1" }, family: "notes", version: "v1", start_ms: 1, end_ms: null, title: "", text: "tickets", who: [], link: null };
    index.records([], [], position(1));
    expect(moved()).toBe(0);
    index.records([note], [], position(2));
    expect(moved()).toBe(1);
    index.day("2026-10-25", indexed(fixture("2026-10-25"), 1));
    expect(moved()).toBe(1);
    index.touchDay("2026-10-25", indexed(fixture("2026-10-25"), 2));
    expect(moved()).toBe(0);
    expect(index.days().get("2026-10-25")).toMatchObject({ mtime_us: 2 });
    index.records([], [note.record], position(3));
    expect(moved()).toBe(1);
    index.records([], [note.record], position(4));
    expect(moved()).toBe(0);
    index.forget([], ["2026-10-25"]);
    expect(moved()).toBe(1);
    index.close();
  });

  it("L5 an erased day is never touched: only its replacement read stands for it", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    index.day("2026-10-25", indexed(fixture("2026-10-25"), 1));
    index.forget([], ["2026-10-25"]);
    index.touchDay("2026-10-25", indexed(fixture("2026-10-25"), 3));
    expect(index.days().get("2026-10-25")).toEqual({ inputs: "", mtime_us: -1 });
    index.close();
  });

  it("L6 a build killed before it reads through is never served, and resumes with its facts", () => {
    const build = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    build.day("2026-10-24", indexed(fixture("2026-10-24")));
    build.close();
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)).toBeUndefined();
    expect(SearchIndex.progress(openHomeFolder(dirname(file)), file)).toEqual({ read: 0 });
    const resumed = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    expect(resumed.building).toBe(true);
    expect(rows(resumed, "SELECT id FROM fact")).toEqual([{ id: CALL }]);
    resumed.day("2026-10-25", indexed(fixture("2026-10-25")));
    resumed.finish();
    const served = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    expect([...served.snapshot({}, (read) => read.held("2026-10-24", "2026-10-25")).days.keys()]).toEqual(["2026-10-24", "2026-10-25"]);
    served.close();
    copyFileSync(file, join(root, "old.db"));
    const old = new Database(join(root, "old.db"));
    old.prepare("UPDATE meta SET value = '5' WHERE key = 'format'").run();
    old.close();
    expect(SearchIndex.read(openHomeFolder(dirname(join(root, "old.db"))), join(root, "old.db"))).toBeUndefined();
  });

  it("L8 a day read before an erasure removed its file never stands in for the erased day with the erased content", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-02", [["a", "20.00"]]), 1_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"]]), 1_000);
    job(index);
    expect(sum(index, "payments", "amount", OCTOBER[1], OCTOBER[2])).toBe(12_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"], ["e", "0.00"]]), 1_500);
    const read = readDay(openHomeFolder(root), "2026-10-05", paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"], ["e", "0.00"]]).inputs, 1_500_000_000)!;
    rmSync(join(root, "days", "2026-10-05.day.json"));
    index.forget([{ source: "bank:acct:mac", kind: "payment", key: "b" }], ["2026-10-05"]);
    expect(index.day("2026-10-05", read)).toBe(false);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: true });
    expect(rows(index, "SELECT count(*) AS n FROM fact_measure WHERE value = 4000")).toEqual([{ n: 0 }]);
    expect(sum(index, "payments", "amount", OCTOBER[1], OCTOBER[2])).toBe(2_000);
    write(paymentsDay("2026-10-05", [["c", "60.00"]]), 2_000);
    expect(index.day("2026-10-05", read)).toBe(false);
    expect(sum(index, "payments", "amount", OCTOBER[1], OCTOBER[2])).toBe(2_000);
    job(index);
    expect(sum(index, "payments", "amount", OCTOBER[1], OCTOBER[2])).toBe(8_000);
    index.close();
  });

  it("L18 a day of another renderer's file is written once, what it held gone; later runs pass it by until its render", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-02", [["a", "20.00"]]), 1_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"]]), 1_000);
    job(index);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(6_000);
    write(older(paymentsDay("2026-10-05", [["c", "60.00"]])), 2_000);
    const counted = { days: 0 };
    expect(days(openHomeFolder(root), index, counted, performance.now())).toBe(false);
    expect(counted.days).toBe(0);
    expect(rows(index, "SELECT id FROM fact WHERE day = '2026-10-05'")).toEqual([]);
    expect(index.days().get("2026-10-05")).toEqual({ inputs: "", mtime_us: 2_000_000_000 });
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: false });
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(2_000);
    const revision = index.revision();
    job(index);
    expect(index.revision()).toBe(revision);
    const current = paymentsDay("2026-10-05", [["c", "60.00"]]);
    write(current, 3_000);
    job(index);
    expect(index.days().get("2026-10-05")).toMatchObject({ inputs: current.inputs });
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(8_000);
    index.close();
  });

  it("L19 a file another renderer wrote is never read, whatever head was read before it", () => {
    const document = older(paymentsDay("2026-10-05", [["b", "40.00"]]));
    write(document, 1_000);
    expect(readDay(openHomeFolder(root), "2026-10-05", paymentsDay("2026-10-05", [["b", "40.00"]]).inputs, 1_000_000_000)).toBeNull();
  });

  it("L20 an erased day whose next file is another renderer's holds nothing and stays erased until this renderer's is read", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"]]), 1_000);
    job(index);
    rmSync(join(root, "days", "2026-10-05.day.json"));
    index.forget([{ source: "bank:acct:mac", kind: "payment", key: "b" }], ["2026-10-05"]);
    write(older(paymentsDay("2026-10-05", [["c", "60.00"]])), 2_000);
    job(index);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: true });
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(0);
    const revision = index.revision();
    job(index);
    expect(index.revision()).toBe(revision);
    expect(held(index).days.get("2026-10-05")).toEqual({ inputs: "", erased: true });
    write(paymentsDay("2026-10-05", [["c", "60.00"]]), 3_000);
    job(index);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(6_000);
    index.close();
  });

  it("P1 a day rendering: a count over it answers what the index holds and names it new, until its render is read", async () => {
    const home = scheduled();
    try {
      const v1 = paymentsDay("2026-10-05", [["b", "40.00"]]);
      home.render(v1, 1_000);
      expect(home.queued()).toBe(true);
      await home.search();
      expect(home.count()).toMatchObject({ n: 1, sum: "40.00 USD" });
      expect(home.pending()).toEqual([]);
      home.mark();
      expect(home.count()).toMatchObject({ n: 1, sum: "40.00 USD", pending: [{ day: "2026-10-05", why: "new" }] });
      home.render(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "2.00"]]), 2_000);
      expect(home.queued()).toBe(true);
      await home.search();
      expect(home.count()).toMatchObject({ n: 2, sum: "42.00 USD" });
      expect(home.pending()).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("P2 a day set aside is named failed, its old content counted; retried it is new; rendered to the same files it is named no more", async () => {
    const home = scheduled();
    try {
      const v1 = paymentsDay("2026-10-05", [["b", "40.00"]]);
      home.render(v1, 1_000);
      await home.search();
      home.render("threw");
      expect(home.count()).toMatchObject({ n: 1, pending: [{ day: "2026-10-05", why: "failed" }] });
      await home.search();
      expect(home.pending()).toEqual([{ day: "2026-10-05", why: "failed" }]);
      home.retry();
      expect(home.pending()).toEqual([{ day: "2026-10-05", why: "new" }]);
      home.render(v1);
      expect(home.pending()).toEqual([]);
      expect(home.count()).toMatchObject({ n: 1, sum: "40.00 USD" });
    } finally {
      home.close();
    }
  });

  it("P3 a day erased: the erased amount in no answer, the day named erased while it renders again, and named no more once read", async () => {
    const home = scheduled();
    try {
      home.render(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"]]), 1_000);
      await home.search();
      expect(home.count()).toMatchObject({ n: 2, sum: "100.00 USD" });
      home.erase([{ source: "bank:acct:mac", kind: "payment", key: "b" }]);
      expect(home.count()).toMatchObject({ n: 0, pending: [{ day: "2026-10-05", why: "erased" }] });
      await home.search();
      expect(home.pending()).toEqual([{ day: "2026-10-05", why: "erased" }]);
      home.render(paymentsDay("2026-10-05", [["c", "60.00"]]), 2_000);
      await home.search();
      expect(home.count()).toMatchObject({ n: 1, sum: "60.00 USD" });
      expect(home.pending()).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("P4 a change the index missed is named: a render it has not read, and a day home.db lists no more", async () => {
    const home = scheduled();
    try {
      const v1 = paymentsDay("2026-10-05", [["b", "40.00"]]);
      home.render(v1, 1_000);
      await home.search();
      home.render(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "2.00"]]), 2_000);
      expect(home.count()).toMatchObject({ n: 1, pending: [{ day: "2026-10-05", why: "new" }] });
      await home.search();
      expect(home.pending()).toEqual([]);
      home.unlist();
      expect(home.pending()).toEqual([{ day: "2026-10-05", why: "new" }]);
    } finally {
      home.close();
    }
  });

  it("P5 a first build publishes once it has read home.db's statements: a day of another renderer's file named new until its render is read", async () => {
    const home = scheduled();
    try {
      const current = paymentsDay("2026-10-05", [["b", "40.00"]]);
      home.started(older(current), 1_000);
      await home.search();
      expect(SearchIndex.read(openHomeFolder(dirname(home.searchFile)), home.searchFile)).toBeDefined();
      expect(home.count()).toMatchObject({ n: 0, pending: [{ day: "2026-10-05", why: "new" }] });
      home.render(current, 2_000);
      expect(home.queued()).toBe(true);
      await home.search();
      expect(home.count()).toMatchObject({ n: 1, sum: "40.00 USD" });
      expect(home.pending()).toEqual([]);
      const db = new Database(home.searchFile, { readonly: true });
      try {
        expect(db.prepare("SELECT id, unit, record FROM fact").all()).toEqual([{ id: current.facts[0]!.id, unit: "money/b", record: "bank:acct:mac\0payment\0b" }]);
      } finally {
        db.close();
      }
    } finally {
      home.close();
    }
  });

  it("P6 a range of more days still being read than PENDING_NAMED names the newest and counts the rest; as_of is home.db's time of the statement read through", () => {
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
      const first = "2026-01-01";
      const all: string[] = [];
      for (let day = first; day <= "2026-10-06"; day = new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) all.push(day);
      db.commit((tx: Tx) => {
        tx.tables.dirty.days(all);
        tx.tables.meta.set(DAYS_MARK, "test");
      });
      index.records([], [], { position: { seq: 3, statement: "s-3", reread: 0 } });
      const view = db.view();
      try {
        const fresh = index.snapshot({}, (read) => freshOf(read.seq, read.held(first, "2026-12-31"), view, "2026-10-06", SETTINGS.zone))!;
        expect(fresh.pending).toHaveLength(PENDING_NAMED);
        expect(fresh.pending[0]).toEqual({ day: "2026-10-06", why: "new" });
        expect(fresh.pending_more).toBe(all.length - PENDING_NAMED);
        expect(fresh.as_of).toBeNull();
      } finally {
        view.close();
      }
      index.close();
      const raw = new Database(join(root, "home.db"));
      try {
        raw.prepare("INSERT INTO statements (seq, source, kind, key, version, stated_ms, run, origin, late) VALUES (3, 'bank:acct:mac', 'payment', 'b', 'v', ?, 1, 'source', 0)").run(Date.parse("2026-10-06T14:30:00Z"));
      } finally {
        raw.close();
      }
      const again = db.view();
      try {
        expect(freshOf(3, { from: first, to: first, days: new Map() }, again, "2026-10-06", SETTINGS.zone)!.as_of).toBe("2026-10-06T10:30-04:00");
      } finally {
        again.close();
      }
    } finally {
      db.close();
    }
  });

  it("P7 a count with no from names every day before its end still being read: a first build published after its newest days", async () => {
    const home = scheduled();
    try {
      const documents: DayDocument[] = [];
      for (let at = 0; at < RUN_DAYS + 130; at++) {
        const day = new Date(Date.parse("2026-10-05T00:00:00Z") - at * 86_400_000).toISOString().slice(0, 10);
        documents.push(paymentsDay(day, [[`k${at}`, "1.00"]]));
      }
      home.listed(documents, 1_000);
      await home.search();
      expect(SearchIndex.read(openHomeFolder(dirname(home.searchFile)), home.searchFile)).toBeDefined();
      const all = home.count("");
      expect(all).toMatchObject({ n: RUN_DAYS, pending_more: 130 - PENDING_NAMED });
      expect(all.pending).toHaveLength(PENDING_NAMED);
      expect(all.pending![0]).toEqual({ day: documents[RUN_DAYS]!.day, why: "new" });
      const before = home.count(`to=${documents[RUN_DAYS + 80]!.day}`).pending!;
      expect({ n: before.length, newest: before[0]!.day, oldest: before.at(-1)!.day }).toEqual({ n: 50, newest: documents[RUN_DAYS + 80]!.day, oldest: documents[RUN_DAYS + 129]!.day });
    } finally {
      home.close();
    }
  });

  it("P8 a day list that is not authoritative is no freshness: a render the index missed is NOT_NOW, never an answer said fresh", async () => {
    const home = scheduled();
    try {
      home.render(paymentsDay("2026-10-05", [["b", "40.00"]]), 1_000);
      await home.search();
      home.render(paymentsDay("2026-10-05", [["b", "40.00"], ["c", "2.00"]]), 2_000);
      expect(home.count()).toMatchObject({ pending: [{ day: "2026-10-05", why: "new" }] });
      home.unmark();
      expect(() => home.count()).toThrow("NOT_NOW");
    } finally {
      home.close();
    }
  });

  it("L21 a days folder that cannot be read is no listing: the job reads and drops nothing; an absent one reads as empty", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-04", [["a", "10.00"]]), 1_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"]]), 1_000);
    expect(job(index)).toBe(false);
    const before = index.days();
    expect([...before.keys()].sort()).toEqual(["2026-10-04", "2026-10-05"]);
    renameSync(join(root, "days"), join(root, "days-aside"));
    writeFileSync(join(root, "days"), "");
    expect(job(index)).toBe("unreadable");
    expect(index.days()).toEqual(before);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(5_000);
    renameSync(join(root, "days"), join(root, "days-file"));
    expect(job(index)).toBe(false);
    expect(index.days().size).toBe(0);
    index.close();
  });

  it("L23 a day file that cannot be looked at is not gone: the job reads and drops nothing, and looks again", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-04", [["a", "10.00"]]), 1_000);
    write(paymentsDay("2026-10-05", [["b", "40.00"]]), 1_000);
    expect(job(index)).toBe(false);
    const before = index.days();
    renameSync(join(root, "days", "2026-10-05.day.json"), join(root, "2026-10-05.day.json.aside"));
    symlinkSync("2026-10-05.day.json", join(root, "days", "2026-10-05.day.json"));
    write(paymentsDay("2026-10-04", [["a", "10.00"], ["c", "5.00"]]), 2_000);
    expect(job(index)).toBe("unreadable");
    expect(index.days()).toEqual(before);
    expect(sum(index, "payments", "amount", "2026-10-01", "2026-10-31")).toBe(5_000);
    index.close();
  });

  it("L12 a day read with its file standing is written wholly before an erasure's forget, or not at all", () => {
    const first = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    write(paymentsDay("2026-10-05", [["c", "60.00"]]), 1_000);
    job(first);
    first.finish();
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    expect(index.building).toBe(false);
    const erasure = SearchIndex.marking(openHomeFolder(dirname(file)), file)!;
    const day = paymentsDay("2026-10-05", [["b", "40.00"], ["c", "60.00"]]);
    write(day, 2_000);
    const read = readDay(openHomeFolder(root), day.day, day.inputs, 2_000_000_000)!;
    let forgotFirst = false;
    const raced: IndexedDay = {
      ...read,
      still: () => {
        const standing = read.still!();
        rmSync(join(root, "days", `${day.day}.day.json`));
        try {
          erasure.forget([{ source: "bank:acct:mac", kind: "payment", key: "b" }], [day.day]);
          forgotFirst = true;
        } catch (error) {
          expect((error as { code?: string }).code).toBe("SQLITE_BUSY");
        }
        return standing;
      },
    };
    expect(index.day(day.day, raced)).toBe(true);
    if (!forgotFirst) erasure.forget([{ source: "bank:acct:mac", kind: "payment", key: "b" }], [day.day]);
    expect(index.days().get(day.day)).toEqual({ inputs: "", mtime_us: -1 });
    expect(rows(index, "SELECT count(*) AS n FROM fact_measure WHERE value = 4000")).toEqual([{ n: 0 }]);
    erasure.close();
    index.close();
  });

  it("L13 an index that replaces another never stands at its revision", () => {
    const first = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    first.day("2026-10-25", indexed(fixture("2026-10-25")));
    const was = first.revision();
    first.finish();
    const build = SearchIndex.write(openHomeFolder(dirname(file)), file, () => false, 0, SETTINGS);
    expect(build.building).toBe(true);
    build.day("2026-10-25", indexed(fixture("2026-10-25")));
    expect(build.revision()).not.toBe(was);
    expect(build.revision().split(":")[1]).toBe(was.split(":")[1]);
    build.close();
  });

  it("L22 a day file written again unchanged reaches the accepted-statement rule: the job's index is a build of the same files", () => {
    const F = "payments:0000000000000000000000f1";
    const onA = paymentsDay("2026-10-01", [["f1", "4.50"]]);
    const onB = paymentsDay("2026-10-02", [["f1", "4.50"]]);
    onB.facts = onB.facts.map((fact) => ({ ...fact, keys: { ...fact.keys, payee: "Shop B" } }));
    const holder = (index: SearchIndex) => rows(index, "SELECT f.day, n.name AS payee FROM fact f JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of AND k.key = 'payee' JOIN names n ON n.id = k.name WHERE f.id = ?", F);
    write(onA, 1_000);
    write(onB, 2_000);
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    try {
      job(index);
      expect(holder(index)).toEqual([{ day: "2026-10-02", payee: "Shop B" }]);
      write(onA, 3_000);
      job(index);
      expect(index.days().get("2026-10-01")).toMatchObject({ inputs: onA.inputs, mtime_us: 3_000_000_000 });
      expect(holder(index)).toEqual([{ day: "2026-10-01", payee: "Shop f1" }]);
    } finally {
      index.close();
    }
    rmSync(join(root, "machine"), { recursive: true, force: true });
    const build = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    try {
      job(build);
      expect(holder(build)).toEqual([{ day: "2026-10-01", payee: "Shop f1" }]);
    } finally {
      build.close();
    }
  });
});

describe("a count by words", () => {
  const COUNTED = new Map(Object.entries({ ...MESSAGES_COLLECTIONS, ...listeningFamily([]).collections }));
  const OWNERS: Record<string, readonly string[]> = { messages: ["messages"], plays: ["listening"] };

  it("H16 a word in 120,000 message entries and 10 plays: plays by it counts 10, the excluded walk too, reading only the listening family's entries", () => {
    const records: RecordEntry[] = [];
    const facts: DayFileFact[] = [];
    for (let i = 0; i < 120_000; i++) {
      const at = Date.parse("2026-10-01T12:00:00Z") + Math.floor((i * 20 * 86_400_000) / 120_000);
      records.push({ record: { source: "wa:local:a", kind: "msg", key: `m${i}` }, family: "messages", version: "v1", start_ms: at, end_ms: null, title: "", text: `echo ${i}`, who: [], link: null });
    }
    const PLAYED = Date.parse("2026-10-10T15:00:00Z");
    const play = (key: string, track: string, at: number) => {
      const record = { source: "biome:home:a", kind: "now_playing", key };
      records.push({ record, family: "listening", version: "v1", start_ms: at, end_ms: null, title: track, text: `${track} · Artist A`, who: [], link: null });
      facts.push({
        id: `plays:${key.padStart(24, "0")}`, family: "listening", of: "plays", time_ms: at, start_ms: at, end_ms: at + 180_000,
        keys: { track, artist: "Artist A" }, measures: { times: 1, minutes: 3 }, who: [], from: { units: [`listening/${key}`], record, alone: true }, lines: [],
      });
    };
    for (let i = 0; i < 10; i++) play(`echo${i}`, "Echo Song", PLAYED + i * 600_000);
    for (let i = 0; i < 3; i++) play(`quiet${i}`, "Quiet Song", PLAYED + (10 + i) * 600_000);
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    try {
      index.records(records, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      index.day("2026-10-10", { inputs: "in-2026-10-10", mtime_us: 1, atoms: [], facts: { window: { start_ms: Date.parse("2026-10-10T08:00:00Z"), end_ms: Date.parse("2026-10-11T08:00:00Z") }, facts } });
      const counted = (words: string) => {
        const before = rowsCounted();
        try {
          const answer = shown(countOf(index, countAsked({ of: "plays", words }, COUNTED), {
            collections: COUNTED, settings: SETTINGS, now_ms: Date.parse("2026-10-30T12:00:00Z"), people: () => undefined, familiesOf: (of) => OWNERS[of] ?? [],
          })) as { total: { n: number } };
          return { n: answer.total.n, rows: rowsCounted() - before };
        } catch (error) {
          if (!(error instanceof Refusal)) throw error;
          return { refused: error.code, rows: rowsCounted() - before };
        }
      };
      const echo = counted("echo");
      expect(echo).toMatchObject({ n: 10 });
      expect(echo.rows).toBeLessThan(1_000);
      const quiet = counted("song -echo");
      expect(quiet).toMatchObject({ n: 3 });
      expect(quiet.rows).toBeLessThan(1_000);
    } finally {
      index.close();
    }
  });
});
