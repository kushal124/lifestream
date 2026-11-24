import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath, pathToFileURL } from "node:url";
import { digest, openHome, openHomeFolder, type JsonObject, type ReaderOutput, type RepairAt, type RepairStep } from "@lifestreamprotocol/core";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { runCli } from "./cli.js";
import { startHome, type Home } from "./home.js";
import type { RunCounts } from "./repair.js";
import { artifact, ChildHome, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { releaseFolder } from "./test/fed.js";


const SOURCE = "apple-notes:local:archive";
const T0 = Date.UTC(2026, 8, 1, 8);
const HEADS = 4_000;
const PAGE = 512;

const key = (index: number) => `n-${String(index).padStart(5, "0")}`;

function seed(root: string, count: number): void {
  const db = openHome(openHomeFolder(root), "migrate");
  try {
    db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: SOURCE, started_ms: T0 });
      const rows: ReaderOutput[] = Array.from({ length: count }, (_, index) => {
        const at = T0 + index * 60_000;
        return { kind: "note", key: key(index), content: { text: `note ${index}`, at }, time: { start_ms: at, precision: "ms" } };
      });
      tx.records.land(run, { id: `${SOURCE}/seed`, source: SOURCE, stated_ms: T0 }, rows, { note: () => [] }, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: T0, outcome: "ok" });
    });
  } finally {
    db.close();
  }
}

function writeFix(root: string, hold: string, name = "fix.mjs"): string {
  const path = join(root, name);
  writeFileSync(path, `import { existsSync, writeFileSync } from "node:fs";
const HOLD = ${JSON.stringify(join(root, "hold"))};
const pause = new Int32Array(new SharedArrayBuffer(4));
const appended = (head) => ({ ...head.content, text: head.content.text + " +fixed" });
export function fix(head) {
  if (head.key === ${JSON.stringify(hold)} && existsSync(HOLD)) {
    writeFileSync(HOLD + ".held", "");
    while (existsSync(HOLD)) Atomics.wait(pause, 0, 0, 20);
  }
  if (head.kind === "note-moved") return { content: appended(head) };
  const index = Number(head.key.slice(2));
  if (index % 10 === 3) return { kind: "note-moved", content: appended(head) };
  if (index % 7 === 0) return "gone";
  if (index % 2 === 0) return { content: appended(head) };
  return "keep";
}
`);
  return path;
}

const CORE = realpathSync(fileURLToPath(new URL("../core/", import.meta.url)));
const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<{ resolved: string }>;

async function resolvedBeside(fix: string, specifier: string): Promise<string> {
  const folder = dirname(fix);
  mkdirSync(join(folder, "node_modules", "@lifestreamprotocol"), { recursive: true });
  symlinkSync(CORE, join(folder, "node_modules", "@lifestreamprotocol", "core"));
  const beside = join(folder, "beside.mjs");
  writeFileSync(beside, `export const resolved = import.meta.resolve(${JSON.stringify(specifier)});\n`);
  try {
    return (await nativeImport(pathToFileURL(beside).href)).resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING") throw error;
    return (createRequire(import.meta.url)(beside) as { resolved: string }).resolved;
  }
}

const REPAIR = ["repair", "--source", SOURCE, "--kinds", "note,note-moved", "--reason", "a synthetic repair"];

async function cli(root: string, args: string[]) {
  const lines: string[] = [];
  const status = await runCli([...args, "--root", root], { write: (text) => lines.push(text) });
  const last = lines.join("").trim().split("\n").at(-1) ?? "";
  let result: Record<string, unknown> | undefined;
  try {
    result = JSON.parse(last) as Record<string, unknown>;
  } catch {
    result = undefined;
  }
  return { status, lines, result };
}

function run(root: string, id: number): { kind: string; outcome: string | null; error: string | null; counts: RunCounts | null } {
  const row = readHome(root, (db) => db.prepare("SELECT kind, outcome, error, counts FROM runs WHERE id = ?").get(id)) as { kind: string; outcome: string | null; error: string | null; counts: string | null };
  return { ...row, counts: row.counts === null ? null : JSON.parse(row.counts) as RunCounts };
}

function records(root: string) {
  return readHome(root, (db) => ({
    heads: db.prepare(`SELECT h.kind, h.key, h.version, json_extract(v.text, '$.content.text') AS text FROM heads h LEFT JOIN versions v ON v.id = h.version
      WHERE h.source = ? ORDER BY h.kind, h.key`).all(SOURCE) as { kind: string; key: string; version: string; text: string | null }[],
    statements: db.prepare("SELECT kind, key, version, stated_ms, origin FROM statements WHERE source = ? ORDER BY kind, key, seq").all(SOURCE),
  }));
}

function live(root: string) {
  return records(root).heads.filter((head) => head.version !== "gone").map(({ kind, key, version }) => ({ kind, key, version }));
}

const landed = new Map<string, number[]>();
const held: number[] = [];
const exec = Database.prototype.exec;
beforeAll(() => {
  const began = new WeakMap<Database.Database, number>();
  const heads = new Map<string, number>();
  Database.prototype.exec = function (this: Database.Database, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.name.endsWith("home.db")) began.set(this, performance.now());
    const done = exec.call(this, sql);
    const start = began.get(this);
    if ((sql === "COMMIT" || sql === "ROLLBACK") && start !== undefined) {
      held.push(performance.now() - start);
      began.delete(this);
      const runs = this.prepare("SELECT id, counts FROM runs WHERE kind IN ('repair', 'undo') AND counts IS NOT NULL").all() as { id: number; counts: string }[];
      for (const row of runs) {
        const name = `${this.name} ${row.id}`;
        const now = (JSON.parse(row.counts) as { heads: number }).heads;
        if (now !== (heads.get(name) ?? 0)) (landed.get(name) ?? landed.set(name, []).get(name)!).push(now - (heads.get(name) ?? 0));
        heads.set(name, now);
      }
    }
    return done;
  };
});
const commits = (root: string, run: number): number[] => landed.get(`${join(root, "home.db")} ${run}`) ?? [];
afterAll(() => {
  Database.prototype.exec = exec;
});

describe("repair and undo as jobs", () => {
  const roots: string[] = [];
  const homes: Home[] = [];
  const children: ChildHome[] = [];
  async function stopAll(): Promise<void> {
    for (const home of homes.splice(0)) await home.stop();
    for (const child of children.splice(0)) await child.stop();
  }
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  function root(prefix: string, helpers?: number): string {
    const made = makeRoot(prefix, { sources: { [SOURCE]: "fake-rows", "apple-notes:local:device-b": "fake-rows" }, ...(helpers === undefined ? {} : { helpers }) });
    roots.push(made);
    return made;
  }

  it("a repair lands its plan in one long commit, stops an import, or overwrites a head moved under it; its undo misses part of it", async () => {
    try {
    const at = root("lifestream-repair-load-", 3);
      seed(at, HEADS);
      const original = live(at);
      const fix = writeFix(at, key(1_551));
      const whole = join(at, "whole");
      mkdirSync(whole);
      copyFileSync(join(at, "home.db"), join(whole, "home.db"));
      const { fix: wholeFix } = (await import(pathToFileURL(fix).href)) as { fix: (head: unknown) => never };
      const once = openHome(openHomeFolder(whole), "migrate");
      let oneCommitMs: number;
      try {
        const steps: RepairStep[] = [];
        for (let after: RepairAt | null = null; ;) {
          const view = once.view();
          const page = view.planRepair({ source: SOURCE, kinds: ["note", "note-moved"], fix: wholeFix }, after);
          view.close();
          steps.push(...page.steps);
          if (page.next === null) break;
          after = page.next;
        }
        const began = performance.now();
        once.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: SOURCE, started_ms: T0 }), { steps }, { has: () => true }));
        oneCommitMs = performance.now() - began;
      } finally {
        once.close();
        rmSync(whole, { recursive: true, force: true });
      }

      const hold = join(at, "hold");
      writeFileSync(hold, "");
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));
      held.length = 0;
      const applied = await cli(at, [...REPAIR, "--fix", fix, "--apply"]);
      expect(applied.result).toMatchObject({ queued: true, kinds: ["note", "note-moved"] });
      const repair = applied.result!.run as number;
      await until("the repair held halfway", () => existsSync(`${hold}.held`));

      const shipped = await ship(at, { source: SOURCE, fetched_ms: Date.now(), rows: [
        { kind: "note", key: key(1_550), content: { text: "edited by the source", at: T0 }, at: T0 },
        { kind: "note", key: key(3_000), content: { text: "edited before the walk came", at: T0 }, at: T0 },
      ] });
      const other = await ship(at, { source: "apple-notes:local:device-b", fetched_ms: Date.now(), rows: [{ kind: "note", key: "b1", content: { text: "another source", at: T0 }, at: T0 }] });
      const imported = (id: string) => readHome(at, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
      await until("both imports landed while the repair is under way", () => imported(shipped) && imported(other));
      expect(run(at, repair).outcome).toBeNull();
      expect(readHome(at, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'repair' AND key = ?").pluck().get(String(repair)))).toBe("running");
      const underWay = statusOf(at).running.repairs as unknown as { run: number; counts: RunCounts }[];
      expect(underWay.map((row) => row.run)).toEqual([repair]);
      expect(underWay[0]!.counts.heads).toBeGreaterThan(0);

      rmSync(hold);
      await until("the repair done", () => run(at, repair).outcome === "ok");
      const longest = Math.max(...held);
      const done = run(at, repair);
      const pages = commits(at, repair);
      const after = records(at);
      const text = (kind: string, index: number) => after.heads.find((head) => head.kind === kind && head.key === key(index))?.text;
      artifact(at, "repair-load", {
        heads: HEADS, one_commit_ms: Math.round(oneCommitMs), longest_commit_ms: Math.round(longest), commits: held.length,
        over_100_ms: held.filter((ms) => ms > 100).length, counts: done.counts, heads_per_commit: pages,
      });
      expect(pages.reduce((sum, heads) => sum + heads, 0)).toBe(HEADS);
      expect(Math.max(...pages)).toBeLessThanOrEqual(PAGE);
      expect(done.counts).toMatchObject({ heads: HEADS, refused: 1, refusals: [{ key: key(1_550), violations: ["the head moved since the plan read it"] }] });
      expect(text("note", 1_550)).toBe("edited by the source");
      expect(text("note", 3_000)).toBe("edited before the walk came +fixed");
      expect(text("note-moved", 13)).toBe("note 13 +fixed");
      expect(after.heads.filter((head) => head.text?.includes("+fixed +fixed") === true)).toEqual([]);
      expect(readHome(at, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'repair'").pluck().get())).toBe(1);

      const undone = await cli(at, ["undo", String(repair), "--apply"]);
      const undoRun = undone.result!.run as number;
      await until("the undo done", () => run(at, undoRun).outcome === "ok");
      const restated = new Set([key(1_550), key(3_000)]);
      const now = live(at);
      expect(now.filter((head) => !restated.has(head.key))).toEqual(original.filter((head) => !restated.has(head.key)));
      expect(records(at).heads.filter((head) => restated.has(head.key)).map((head) => head.text)).toEqual(["edited by the source", "edited before the walk came"]);
      const undonePages = commits(at, undoRun);
      expect(undonePages.length).toBeGreaterThan(1);
      expect(Math.max(...undonePages)).toBeLessThanOrEqual(PAGE);
    } finally {
      await stopAll();
    }
  });

  it("a repair killed halfway resumes to other records or counts than an unbroken one, lands its fix twice, or runs on a main thread when dry", async () => {
    try {
      const unbroken = root("lifestream-repair-unbroken-");
      const killed = root("lifestream-repair-killed-");
      for (const each of [unbroken, killed]) seed(each, HEADS);
      const hold = key(2_001);

      const reference = new ChildHome(unbroken);
      children.push(reference);
      reference.start();
      await reference.ready();
      const dry = await cli(unbroken, [...REPAIR, "--fix", writeFix(unbroken, hold)]);
      expect(dry.result).toMatchObject({ applied: false, counts: { heads: HEADS, refused: 0, moved: 0 } });
      const queued = await cli(unbroken, [...REPAIR, "--fix", writeFix(unbroken, hold), "--apply"]);
      const first = queued.result!.run as number;
      await until("the unbroken repair done", () => run(unbroken, first).outcome === "ok");
      await reference.stop();

      const queuedHere = await cli(killed, [...REPAIR, "--fix", writeFix(killed, hold), "--apply"]);
      expect(queuedHere.result).toMatchObject({ queued: true });
      const second = queuedHere.result!.run as number;
      const child = new ChildHome(killed);
      children.push(child);
      child.start("repair.slice");
      expect(await child.exited()).toMatchObject({ signal: "SIGKILL" });
      const afterFirst = run(killed, second).counts!.heads;
      expect(afterFirst).toBeGreaterThan(0);
      writeFileSync(join(killed, "hold"), "");
      child.start();
      await until("held halfway, the pages before it landed", () => existsSync(join(killed, "hold.held")) && run(killed, second).counts!.heads >= 3 * PAGE);
      child.kill();
      await child.exited();
      const atKill = run(killed, second);
      rmSync(join(killed, "hold"));
      child.start();
      await until("the killed repair done", () => run(killed, second).outcome === "ok");
      await child.stop();

      const want = run(unbroken, first);
      const got = run(killed, second);
      artifact(killed, "repair-killed", { dry: dry.result, after_first_slice: afterFirst, at_kill: atKill.counts, unbroken: want.counts, killed: got.counts });
      expect(got.counts).toEqual(want.counts);
      expect(dry.result!.counts).toEqual({ heads: want.counts!.heads, changed: want.counts!.changed, gone: want.counts!.gone, kept: want.counts!.kept, moved: 0, refused: 0 });
      expect(records(killed)).toEqual(records(unbroken));
      expect(records(killed).heads.filter((head) => head.text?.includes("+fixed +fixed") === true)).toEqual([]);
      expect(readHome(killed, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'repair'").pluck().get())).toBe(1);
    } finally {
      await stopAll();
    }
  });

  it("an undo leaves a half-done repair landing, or a stopped repair runs again", async () => {
    try {
      const at = root("lifestream-repair-half-");
      seed(at, 3_000);
      const original = live(at);
      const fix = writeFix(at, key(1_500));
      writeFileSync(join(at, "hold"), "");
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));
      const repair = (await cli(at, [...REPAIR, "--fix", fix, "--apply"])).result!.run as number;
      await until("the repair held, its first pages landed", () => existsSync(join(at, "hold.held")) && run(at, repair).counts!.heads >= 1_024);

      const undone = await cli(at, ["undo", String(repair), "--apply"]);
      expect(undone.result).toMatchObject({ queued: true, stopped: repair });
      const undoRun = undone.result!.run as number;
      const landedBefore = readHome(at, (db) => db.prepare("SELECT count(*) FROM statements WHERE run = ?").pluck().get(repair)) as number;
      rmSync(join(at, "hold"));
      await until("the undo done", () => run(at, undoRun).outcome === "ok");
      await until("the stopped repair's job let go", () => readHome(at, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'repair' AND key = ?").pluck().get(String(repair))) === "done");
      expect(readHome(at, (db) => db.prepare("SELECT count(*) FROM statements WHERE run = ?").pluck().get(repair))).toBe(landedBefore);
      expect(run(at, repair)).toMatchObject({ outcome: "failed", error: `stopped by undo run ${undoRun}` });
      expect(live(at)).toEqual(original);

      expect((await cli(at, ["run", "repair", String(repair), "--lane", "5"])).result).toMatchObject({ state: "queued" });
      await until("the stopped repair's job done again", () => readHome(at, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'repair' AND key = ?").pluck().get(String(repair))) === "done");
      expect(readHome(at, (db) => db.prepare("SELECT count(*) FROM statements WHERE run = ?").pluck().get(repair))).toBe(landedBefore);
      artifact(at, "repair-half-undone", { repair: run(at, repair), undo: run(at, undoRun), statements: landedBefore });
    } finally {
      await stopAll();
    }
  });

  it("a repair loses history, or undo or undo-of-undo fails; a changed fix module runs as the same run; a module beside the fix meets the one-door rule", async () => {
    try {
      const at = root("lifestream-repair-history-");
      const source = "imessage:local:mac-0001";
      const db = openHome(openHomeFolder(at), "migrate");
      db.commit((tx) => {
        tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", added_ms: T0 });
        const imported = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
        const message = (name: string): ReaderOutput => ({ kind: "msg", key: name, content: { chat: "c1", text: `synthetic message ${name}`, ZMESSAGEDATE: 800_000_000 } });
        tx.records.land(imported, { id: `${source}/seed`, source, stated_ms: T0 }, [message("m1"), message("m2"), message("m3")], { msg: () => [] }, { has: () => true });
        tx.tables.runs.end(imported, { ended_ms: T0, outcome: "ok" });
      });
      db.close();
      const history = () => readHome(at, (read) => read.prepare("SELECT key, version, origin FROM statements WHERE source = ? ORDER BY key, seq").all(source)) as { key: string; version: string; origin: string }[];
      const versions = () => readHome(at, (read) => read.prepare("SELECT key, version FROM heads WHERE source = ? ORDER BY key").all(source));
      const original = versions();
      const fix = join(at, "shift.mjs");
      writeFileSync(fix, "export function fix(head) { return { content: { ...head.content, ZMESSAGEDATE: head.content.ZMESSAGEDATE + 19800 } }; }\n");
      const args = ["repair", "--source", source, "--reason", "times shifted 5 h 30 m", "--fix", fix];

      const dry = await cli(at, args);
      expect(dry.result).toMatchObject({ applied: false, counts: { heads: 3, changed: 3 }, changed_paths: { ZMESSAGEDATE: 3 } });
      expect(await resolvedBeside(fix, "@lifestreamprotocol/core")).toBe(pathToFileURL(join(CORE, "index.ts")).href);
      const applied = (await cli(at, [...args, "--apply"])).result!.run as number;
      expect(versions()).toEqual(original);
      writeFileSync(fix, "export function fix() { return 'gone'; }\n");
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));
      await until("the run refused the changed module", () => (readHome(at, (read) => read.prepare("SELECT error FROM jobs WHERE kind = 'repair'").pluck().get()) as string | null)?.includes("is not the one the repair began with") === true);
      expect(versions()).toEqual(original);
      writeFileSync(fix, "export function fix(head) { return { content: { ...head.content, ZMESSAGEDATE: head.content.ZMESSAGEDATE + 19800 } }; }\n");
      await cli(at, ["run", "repair", String(applied), "--lane", "5"]);
      await until("the repair done", () => run(at, applied).outcome === "ok");
      expect(run(at, applied).counts).toMatchObject({ heads: 3, changed: 3, refused: 0 });
      const repaired = versions();
      expect(repaired).not.toEqual(original);
      expect(history().filter((row) => row.origin === "repair")).toHaveLength(3);

      const plannedUndo = await cli(at, ["undo", String(applied)]);
      expect(plannedUndo.result).toMatchObject({ applied: false, counts: { heads: 3, changed: 3 }, changed_paths: { ZMESSAGEDATE: 3 } });
      const undone = (await cli(at, ["undo", String(applied), "--apply"])).result!.run as number;
      await until("the undo done", () => run(at, undone).outcome === "ok");
      expect(versions()).toEqual(original);
      const redone = (await cli(at, ["undo", String(undone), "--apply"])).result!.run as number;
      await until("the undo of the undo done", () => run(at, redone).outcome === "ok");
      expect(versions()).toEqual(repaired);
      expect(history().map((row) => row.origin)).toEqual(Array.from({ length: 3 }, () => ["source", "repair", "repair", "repair"]).flat());
      artifact(at, "repair-history", { dry: dry.result, history: history() });
    } finally {
      await stopAll();
    }
  });

  it("a repair that moves records to another kind leaves both live, or undo fails", async () => {
    try {
      const at = root("lifestream-repair-kind-");
      const source = "location:local:iphone-aa01";
      const HOUR = 3_600_000;
      const line = (sequence: number, kind: string, payload: Record<string, string>): ReaderOutput => ({ kind: "recorder", key: `install-a1:${sequence}`, content: { type: "location.recorder", content: { kind, sequence, payload } }, time: { start_ms: T0 + sequence * HOUR, precision: "ms" } });
      const gap = (sequence: number) => line(sequence, "gap", { start: new Date(T0 + sequence * HOUR - 600_000).toISOString(), end: new Date(T0 + sequence * HOUR - 60_000).toISOString() });
      const db = openHome(openHomeFolder(at), "migrate");
      db.commit((tx) => {
        tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", added_ms: T0 });
        const first = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
        tx.records.land(first, { id: `${source}/a`, source, stated_ms: T0 }, [gap(1), line(2, "recorder_event", { event: "engine_b_state" }), gap(3)], { recorder: () => [] }, { has: () => true });
        const second = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
        const stated: ReaderOutput = { kind: "gap", key: "install-a1:3", content: { type: "location.gap", content: (gap(3).content as { content: ReaderOutput["content"] }).content }, time: { start_ms: T0 + 3 * HOUR - 600_000, end_ms: T0 + 3 * HOUR - 60_000, precision: "ms" } };
        tx.records.land(second, { id: `${source}/b`, source, stated_ms: T0 + 24 * HOUR }, [stated], { gap: () => [] }, { has: () => true });
        for (const each of [first, second]) tx.tables.runs.end(each, { ended_ms: T0, outcome: "ok" });
      });
      db.close();
      const heads = (kind: string) => readHome(at, (read) => read.prepare("SELECT key, version FROM heads WHERE source = ? AND kind = ? AND version <> 'gone' ORDER BY key").all(source, kind)) as { key: string; version: string }[];
      const before = { recorder: heads("recorder"), gap: heads("gap") };
      const fix = join(at, "gap-kind.mjs");
      writeFileSync(fix, [
        "export function fix(head) {",
        "  const line = head.content.content;",
        "  if (line.kind !== 'gap') return 'keep';",
        "  return { kind: 'gap', content: { type: 'location.gap', content: line }, time: { start_ms: Date.parse(line.payload.start), end_ms: Date.parse(line.payload.end), precision: 'ms' } };",
        "}",
      ].join("\n"));
      const args = ["repair", "--source", source, "--kinds", "recorder", "--reason", "a gap is its own kind", "--fix", fix];
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));

      const dry = await cli(at, args);
      expect(dry.result).toMatchObject({ applied: false, counts: { heads: 3, changed: 1, gone: 1, kept: 1 } });
      expect((dry.result!.examples as { kind?: string }[]).map((example) => example.kind)).toEqual(["gap", undefined]);
      const applied = (await cli(at, [...args, "--apply"])).result!.run as number;
      await until("the repair done", () => run(at, applied).outcome === "ok");
      expect(run(at, applied).counts).toMatchObject({ changed: 1, gone: 1 });
      expect(heads("recorder").map((head) => head.key)).toEqual(["install-a1:2"]);
      expect(heads("gap").map((head) => head.key)).toEqual(["install-a1:1", "install-a1:3"]);
      const moved = readHome(at, (read) => read.prepare("SELECT stated_ms, start_ms, end_ms FROM heads WHERE source = ? AND kind = 'gap' AND key = 'install-a1:1'").get(source));
      expect(moved).toEqual({ stated_ms: T0, start_ms: T0 + HOUR - 600_000, end_ms: T0 + HOUR - 60_000 });
      expect(heads("gap")[1]!.version).toBe(before.gap[0]!.version);

      const undone = (await cli(at, ["undo", String(applied), "--apply"])).result!.run as number;
      await until("the undo done", () => run(at, undone).outcome === "ok");
      expect({ recorder: heads("recorder"), gap: heads("gap") }).toEqual(before);
      const redone = (await cli(at, ["undo", String(undone), "--apply"])).result!.run as number;
      await until("the undo of the undo done", () => run(at, redone).outcome === "ok");
      expect(heads("recorder").map((head) => head.key)).toEqual(["install-a1:2"]);
      expect(heads("gap").map((head) => head.key)).toEqual(["install-a1:1", "install-a1:3"]);
      artifact(at, "repair-kind", { dry: dry.result, gap: heads("gap") });
    } finally {
      await stopAll();
    }
  });

  it("a repair that re-keys My Activity to the second leaves a record under its old key, doubles two that come to one, or undo fails", async () => {
    try {
      const at = root("lifestream-repair-key-");
      const source = "google-search:person-a@example.com:export";
      const url = "https://local.google.com/place?id=1000000000000000001";
      const entry = (title: string, time: string, titleUrl?: string): JsonObject => ({
        type: "google.activity", header: "Search", title, ...(titleUrl === undefined ? {} : { titleUrl }), time, products: ["Search"], activityControls: ["Search Services History"],
      });
      const keyed = (content: JsonObject) => digest({
        time: content.time as string, header: content.header as string, title: content.title as string, ...(content.titleUrl === undefined ? {} : { titleUrl: content.titleUrl as string }),
      });
      const toSecond = (content: JsonObject) => releaseFolder("google/my-activity").entryKey(Date.parse(content.time as string), content.header as string, content.title as string, content.titleUrl as string | undefined);
      const query = entry("Searched for example query", "2026-09-01T08:00:00.123Z", "https://www.google.com/search?q=example+query");
      const used = entry("Used Search", "2026-09-01T09:00:00Z");
      const usedAgain = entry("Used Search", "2026-09-01T09:00:00.500Z");
      const viewed = [entry("Viewed Example Cafe", "2026-09-01T10:00:00.100Z", url), entry("Viewed Example Cafe", "2026-09-01T10:00:00.900Z", url)];
      const all = [query, used, usedAgain, ...viewed];
      const db = openHome(openHomeFolder(at), "migrate");
      db.commit((tx) => {
        tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", added_ms: T0 });
        const imported = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
        const rows: ReaderOutput[] = all.map((content) => ({
          kind: (content.title as string).startsWith("Searched") ? "search" : "activity", key: keyed(content), content,
          time: { start_ms: Date.parse(content.time as string), precision: (content.time as string).includes(".") ? "ms" : "s" },
        }));
        tx.records.land(imported, { id: `${source}/seed`, source, stated_ms: T0 }, rows, { search: () => [], activity: () => [] }, { has: () => true });
        tx.tables.runs.end(imported, { ended_ms: T0, outcome: "ok" });
      });
      db.close();
      const live = () => readHome(at, (read) => read.prepare(`SELECT h.kind, h.key, h.start_ms, json_extract(v.text, '$.content.time') AS time FROM heads h JOIN versions v ON v.id = h.version
        WHERE h.source = ? AND h.version <> 'gone' ORDER BY h.kind, h.key`).all(source)) as { kind: string; key: string; start_ms: number; time: string }[];
      const original = live();
      expect(original).toHaveLength(5);
      const fix = fileURLToPath(new URL("../connect/google/my-activity/key-repair.ts", import.meta.url));
      const args = ["repair", "--source", source, "--reason", "My Activity's key to the second", "--fix", fix];
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));

      const dry = await cli(at, args);
      expect(dry.result).toMatchObject({ applied: false, counts: { heads: 5, changed: 2, gone: 2, kept: 1, refused: 0 } });
      expect((dry.result!.examples as { key?: string }[]).map((example) => example.key).filter((key) => key !== undefined).sort()).toEqual([toSecond(query), toSecond(viewed[0]!)].sort());
      const applied = (await cli(at, [...args, "--apply"])).result!.run as number;
      await until("the key repair done", () => run(at, applied).outcome === "ok");
      expect(run(at, applied).counts).toMatchObject({ heads: 5, changed: 2, gone: 2, kept: 1, refused: 0 });
      const repaired = live();
      expect(repaired.map((head) => head.key).sort()).toEqual([toSecond(query), toSecond(used), toSecond(viewed[0]!)].sort());
      expect(repaired.find((head) => head.key === toSecond(query))).toMatchObject({ kind: "search", start_ms: Date.parse(query.time as string), time: query.time });
      expect(viewed.map((each) => each.time)).toContain(repaired.find((head) => head.key === toSecond(viewed[0]!))!.time);
      expect(repaired.find((head) => head.key === toSecond(used))!.time).toBe(used.time);

      const undone = (await cli(at, ["undo", String(applied), "--apply"])).result!.run as number;
      await until("the undo done", () => run(at, undone).outcome === "ok");
      expect(live()).toEqual(original);
      const redone = (await cli(at, ["undo", String(undone), "--apply"])).result!.run as number;
      await until("the undo of the undo done", () => run(at, redone).outcome === "ok");
      expect(live()).toEqual(repaired);
      artifact(at, "repair-key", { dry: dry.result, repair: run(at, applied).counts, original, repaired });
    } finally {
      await stopAll();
    }
  });

  it("a repair of Google Photos' index-route records leaves one naming its places, loses an original's blob, or moves a key", async () => {
    try {
      const at = root("lifestream-repair-photos-");
      const source = "google-photos:person-a@example.com:export";
      const album = "Takeout/Google Photos/Photos from 2016";
      const other = "Takeout/Google Photos/Album A";
      const blobs = openHomeFolder(at).blobs(join(at, "blobs"));
      const jpeg = (name: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]), Buffer.from(name), Buffer.from([0xff, 0xd9])]);
      const sidecar = (title: string, taken: string, extra: JsonObject = {}) => Buffer.from(JSON.stringify({ title, photoTakenTime: { timestamp: taken }, ...extra }));
      const hex = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
      const photo = jpeg("IMG_0001.jpg");
      const edited = jpeg("IMG_0002-edited.jpg");
      const read = jpeg("IMG_0003.jpg");
      const own = sidecar("IMG_0001.jpg", "1465545600", { description: "a synthetic photo" });
      const albumCopy = sidecar("IMG_0001.jpg", "1465545600", { description: "the album's copy" });
      const original = sidecar("IMG_0002.jpg", "1465549200");
      for (const bytes of [photo, edited, read, own, albumCopy, original]) blobs.put(bytes);
      const indexed = (bytes: Buffer, media: string, sidecars: [string, Buffer][]): ReaderOutput => {
        const content: JsonObject = {
          type: "photos.asset",
          takeout_sources: [{ archive: "takeout-20260814T091500Z-1-001.zip", media_path: media, raw_sidecars: sidecars.map(([path]) => ({ member_path: path })) }],
          blobs: [{ hash: `sha256:${hex(bytes)}`, bytes: bytes.length, media_type: "application/octet-stream", role: "original" },
            ...sidecars.map(([path, json]) => ({ hash: `sha256:${hex(json)}`, bytes: json.length, media_type: "application/json", role: `raw_sidecar:${path}` }))],
        };
        return { kind: "img", key: hex(bytes), content, time: { start_ms: T0, precision: "s" }, blobs: [bytes, ...sidecars.map(([, json]) => json)].map((each) => `sha256:${hex(each)}`) };
      };
      const rows: ReaderOutput[] = [
        indexed(photo, `${album}/IMG_0001.jpg`, [[`${album}/IMG_0001.jpg.supplemental-metadata.json`, own], [`${other}/IMG_0001.jpg.supplemental-metadata.json`, albumCopy]]),
        indexed(edited, `${album}/IMG_0002-edited.jpg`, [[`${album}/IMG_0002.jpg.supplemental-metadata.json`, original]]),
        { kind: "img", key: hex(read), content: { type: "photos.asset", title: "IMG_0003.jpg", photoTakenTime: { timestamp: "1465552800" }, blobs: [{ hash: `sha256:${hex(read)}`, bytes: read.length, media_type: "image/jpeg", role: "original" }] },
          time: { start_ms: 1_465_552_800_000, precision: "s" }, blobs: [`sha256:${hex(read)}`] },
      ];
      const db = openHome(openHomeFolder(at), "migrate");
      db.commit((tx) => {
        tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "fake-rows", added_ms: T0 });
        const imported = tx.tables.runs.start({ kind: "import", subject: source, started_ms: T0 });
        tx.records.land(imported, { id: `${source}/seed`, source, stated_ms: T0 }, rows, { img: () => [] }, { has: () => true });
        tx.tables.runs.end(imported, { ended_ms: T0, outcome: "ok" });
      });
      db.close();
      const live = () => (readHome(at, (each) => each.prepare(`SELECT h.key, h.start_ms, v.text FROM heads h JOIN versions v ON v.id = h.version
        WHERE h.source = ? AND h.version <> 'gone' ORDER BY h.key`).all(source)) as { key: string; start_ms: number; text: string }[])
        .map((head) => ({ key: head.key, start_ms: head.start_ms, content: (JSON.parse(head.text) as { content: JsonObject }).content }));
      const before = live();
      expect(before.filter((head) => head.content.takeout_sources !== undefined)).toHaveLength(2);
      const fix = fileURLToPath(new URL("../connect/photos/google/photos-repair.ts", import.meta.url));
      const args = ["repair", "--source", source, "--kinds", "img", "--reason", "a Google photo is its sidecar's fields", "--fix", fix];
      homes.push(await startHome(at, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined }));

      const dry = await cli(at, args);
      expect(dry.result).toMatchObject({ applied: false, counts: { heads: 3, changed: 2, gone: 0, kept: 1, refused: 0 } });
      const applied = (await cli(at, [...args, "--apply"])).result!.run as number;
      await until("the Photos repair done", () => run(at, applied).outcome === "ok");
      expect(run(at, applied).counts).toMatchObject({ heads: 3, changed: 2, gone: 0, kept: 1, refused: 0 });
      const after = live();
      expect(after.map((head) => head.key)).toEqual(before.map((head) => head.key));
      expect(after.filter((head) => head.content.takeout_sources !== undefined)).toEqual([]);
      const byKey = new Map(after.map((head) => [head.key, head]));
      expect(byKey.get(hex(photo))).toEqual({ key: hex(photo), start_ms: 1_465_545_600_000, content: {
        type: "photos.asset", title: "IMG_0001.jpg", photoTakenTime: { timestamp: "1465545600" }, description: "the album's copy",
        blobs: [{ hash: `sha256:${hex(photo)}`, bytes: photo.length, media_type: "image/jpeg", role: "original" }],
      } });
      expect(byKey.get(hex(edited))).toEqual({ key: hex(edited), start_ms: 1_465_549_200_000, content: {
        type: "photos.asset", title: "IMG_0002-edited.jpg", photoTakenTime: { timestamp: "1465549200" },
        blobs: [{ hash: `sha256:${hex(edited)}`, bytes: edited.length, media_type: "image/jpeg", role: "original" }],
      } });
      expect(byKey.get(hex(read))).toEqual(before.find((head) => head.key === hex(read)));
      const named = readHome(at, (each) => each.prepare(`SELECT vb.blob FROM heads h JOIN version_blobs vb ON vb.version = h.version WHERE h.source = ? ORDER BY vb.blob`).pluck().all(source)) as string[];
      expect(named).toEqual([photo, edited, read].map((each) => `sha256:${hex(each)}`).sort());
      expect(named.every((hash) => blobs.has(hash))).toBe(true);
      artifact(at, "repair-photos", { dry: dry.result, repair: run(at, applied).counts, before, after });
    } finally {
      await stopAll();
    }
  });
});
