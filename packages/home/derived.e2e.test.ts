import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { civilDay, NEWEST, openHome, openHomeFolder, type AskRow, type HomeDb } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { dayPath, readDayHead } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { LANE } from "./jobs.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { askHome } from "./socket.js";
import { Due } from "./due.js";
import { answered } from "./test/ops-support.js";
import { notesFamily, screen } from "./test/fakes.js";
import { artifact, ChildHome, FAKES, hex, LOOK_MS, makeRoot, readHome, removeRoot, settled, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openDoor } from "./test/harness-door.js";
import { statusOf } from "./test/harness-status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { count, DAY, dayText, derivedHomes, extractOf, HOUR, MINUTE, note, quiet, SOURCE, unitOf, UTC4 } from "./test/derived.js";


const owed = (item: string, unit: string, waits: string | null): AskRow => ({
  family: "notes", item, prompt: "fake-caption", version: 1, input_hash: "h", unit, work_id: null, at_key: NEWEST, started: false,
  waits, retry_ms: null, given_up: null, unhideable: null, state: "pending",
});

const threeDays = (): [number, number, number] => {
  const base = Date.UTC(2026, 5, 1, 12, 0);
  return [base, base + DAY, base + 2 * DAY];
};
const notesServed = (root: string): string[] => readHome(root, (db) => db.prepare("SELECT unit FROM extracts WHERE family = 'notes' ORDER BY unit").pluck().all() as string[]);
const setAside = (root: string): { unit: string; error: string }[] => readHome(root, (db) => db.prepare("SELECT unit, error FROM extracts_aside WHERE family = 'notes' ORDER BY unit").all() as { unit: string; error: string }[]);
const extractJob = (root: string) => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'extract' AND key = 'notes'").get()) as { state: string; attempts: number; error: string | null };
const notesCursor = (root: string): number => count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'");
const notesRows = (root: string) => readHome(root, (db) => db.prepare("SELECT unit, code, seq FROM extracts WHERE family = 'notes' ORDER BY unit").all() as { unit: string; code: string; seq: number }[]);
const extractRuns = (root: string) => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'extract' AND subject = 'notes' ORDER BY id").pluck().all() as string[])
  .map((counts) => JSON.parse(counts) as { units: number; written: number; deleted: number; set_aside: number }));
const walks = (root: string): number => count(root, "SELECT count(*) FROM runs WHERE kind = 'walk' AND subject = 'notes' AND counts LIKE '%publish_ms%'");
const walkOwed = (root: string): boolean => count(root, "SELECT coalesce(max(seq), 0) FROM cursors WHERE name = 'rebuild:notes'") > 0;

describe("derived work: what a commit made due is found from what it moved, never requested by a writer", () => {
  const { roots, open } = derivedHomes();

  it("a repair or an undo is never extracted, and its day never renders again", async () => {
    const { root, home } = await open("lifestream-derived-repair-");
    try {
      const at = Date.now() - 10 * MINUTE;
      const day = civilDay(at, UTC4);
      await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "before the repair", at)] });
      await until("the note's day", () => dayText(root, day).includes("before the repair"));
      const fix = join(root, "fix.mjs");
      writeFileSync(fix, 'export function fix(head) { return { content: { ...head.content, text: "after the repair" }, time: head.time }; }\n');
      const applied = await askHome(testSocket(root), "repair", ["--source", SOURCE, "--reason", "a test", "--fix", fix, "--apply"]) as { run: number };
      await until("the repaired day", () => dayText(root, day).includes("after the repair"));
      await askHome(testSocket(root), "undo", [String(applied.run), "--apply"]);
      await until("the undone day", () => dayText(root, day).includes("before the repair"));
      expect(dayText(root, day)).not.toContain("after the repair");
      artifact(root, "repair-undo-day", { day, text: dayText(root, day) });
    } finally {
      await home.stop();
    }
  });

  it("a family's code bump drops a served row from a day before its rebuild publishes, holds back what lands meanwhile, or publishes a stale middle", async () => {
    const families = (code: string, per: string) => ({ "families.notes": { code, per } });
    let { root, home } = await open("lifestream-derived-code-", { ...families("1", "day"), helpers: 3 }, false);
    try {
      const gate = join(root, "rebuild-gate");
      const held = Date.UTC(2026, 8, 30, 10, 0);
      const at = Date.UTC(2026, 8, 20, 10, 0);
      await until("the new home's first walk published", () => quiet(root) && count(root, "SELECT count(*) FROM cursors WHERE name = 'rebuild:notes' AND seq > 0") === 0);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n0", "the held note", held, { hold: gate })] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [note("n1", "first", at, { photo: true }), note("n2", "second", at + 2 * HOUR), note("n3", "third", at + 2 * HOUR + MINUTE)] });
      await until("both days rendered and planned", () => quiet(root) && dayText(root, "2026-09-20").includes("third") && dayText(root, "2026-09-30").includes("the held note") &&
        count(root, "SELECT count(*) FROM dirty_units WHERE error IS NULL") === 0);
      const served = () => readHome(root, (db) => db.prepare("SELECT unit, code, seq FROM extracts WHERE family = 'notes' ORDER BY unit").all());
      const pending = () => readHome(root, (db) => db.prepare("SELECT item, unit FROM asks WHERE family = 'notes' AND state = 'pending'").all());
      const before = { served: served(), pending: pending(), days: { "2026-09-20": dayText(root, "2026-09-20"), "2026-09-30": dayText(root, "2026-09-30") } };
      expect(before.pending).toEqual([{ item: "photo:n1", unit: `${SOURCE}/2026-09-20` }]);
      await home.stop();
      writeFileSync(gate, "");
      editSettings(root, families("2", "hour"));
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the rebuild held in its second week", () => existsSync(`${gate}.held`));
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: Date.now(), rows: [{ kind: "frame", key: "f1", content: { at: at + HOUR }, at: at + HOUR }] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 2, rows: [note("n2", "second", at + 5 * HOUR)] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() + 3, rows: [note("n2", "second", at + 6 * HOUR)] });
      await until("the first day rendered with the frame, and both edits landed", () => dayText(root, "2026-09-20").includes("1 frames") &&
        count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 5 &&
        count(root, "SELECT count(*) FROM dirty_days") === 0 &&
        count(root, "SELECT count(*) FROM jobs WHERE kind = 'render' AND state IN ('queued', 'running')") === 0);
      const during = {
        job: readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'walk' AND key = 'notes'").get()),
        flag: count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'"),
        served: served(),
        next: readHome(root, (db) => db.prepare("SELECT unit, code FROM extracts_next WHERE family = 'notes' ORDER BY unit").all()),
        pending: pending(),
        days: { "2026-09-20": dayText(root, "2026-09-20"), "2026-09-30": dayText(root, "2026-09-30") },
      };
      const edited = ["2026-09-20T12", "2026-09-20T16"].map((hour) => ({ unit: `${SOURCE}/${hour}`, code: "2", seq: expect.any(Number) as number }));
      expect(during.served).toEqual([...(before.served as typeof edited), ...edited].sort((a, b) => a.unit.localeCompare(b.unit)));
      expect(during.days["2026-09-20"]).toContain("1 frames");
      expect(during.days["2026-09-20"]).toContain("16:00 second");
      expect(during.days["2026-09-30"]).toContain("10:00 the held note");
      expect(during.next).toEqual(["2026-09-20T10", "2026-09-20T12"].map((hour) => ({ unit: `${SOURCE}/${hour}`, code: "2" })));
      expect(during.job).toEqual({ state: "running", lane: LANE.backfill });
      expect(during.flag).toBe(1);
      rmSync(gate);
      await until("the rebuilt family", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'notes' AND code = '1'") === 0 &&
        count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0 && count(root, "SELECT count(*) FROM dirty_units WHERE error IS NULL") === 0);
      const units = readHome(root, (db) => db.prepare("SELECT unit, code FROM extracts WHERE family = 'notes' ORDER BY unit").all());
      expect(units).toEqual(["2026-09-20T10", "2026-09-20T12", "2026-09-20T16", "2026-09-30T10"].map((hour) => ({ unit: `${SOURCE}/${hour}`, code: "2" })));
      expect(count(root, "SELECT count(*) FROM extracts_next")).toBe(0);
      const walked = readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = 'notes' AND started_ms >= ? ORDER BY id").pluck().all(held) as string[]).map((text) => JSON.parse(text) as Record<string, unknown>);
      expect(walked.filter((run) => run.stage === "emptying").map((run) => run.emptied)).toEqual([4]);
      expect(walked.filter((run) => run.stage !== "emptying").slice(-3)).toEqual([
        expect.objectContaining({ stage: "slabs", slabs: 3, records: 4, units: 3 }), expect.objectContaining({ stage: "reading" }),
        expect.objectContaining({ stage: "closing", written: 2, deleted: 2 }),
      ]);
      expect(pending()).toEqual([{ item: "photo:n1", unit: `${SOURCE}/2026-09-20T10` }]);
      expect(dayText(root, "2026-09-20").match(/first|second|third/gu)).toEqual(["first", "third", "second"]);
      expect(dayText(root, "2026-09-30").match(/the held note/gu)).toEqual(["the held note"]);
      artifact(root, "code-bump-rebuild", { before, during, units, walked, after: { "2026-09-20": dayText(root, "2026-09-20"), "2026-09-30": dayText(root, "2026-09-30") } });
    } finally {
      await home.stop();
    }
  });

  it("a blob that arrives while a family rebuilds waits for the publish, or the walk publishes its unit without it", async () => {
    const screenSource = "screen:local:mac-0001";
    const { root, home } = await open("lifestream-derived-walk-blob-", { helpers: 3 });
    try {
      const gate = join(root, "walk-gate");
      const t0 = Date.UTC(2026, 8, 1, 10, 0);
      const bytes = Buffer.from("synthetic text segment of a frame the rebuild reads");
      const blob = `sha256:${hex(bytes)}`;
      const sittings = () => readHome(root, (db) => db.prepare("SELECT unit, content FROM extracts WHERE family = 'screen' ORDER BY unit").all() as { unit: string; content: string }[])
        .map((row) => ({ unit: row.unit, missing: (JSON.parse(row.content) as { missing: number }).missing }));
      await ship(root, { source: screenSource, fetched_ms: Date.now(), rows: [
        { kind: "frame", key: "f1", content: { at: t0, blob }, at: t0, blobs: [blob] },
        { kind: "frame", key: "f2", content: { at: t0 + 8 * DAY, hold: gate }, at: t0 + 8 * DAY },
      ] });
      await until("both sittings, the first missing its text", () => quiet(root) && sittings().length === 2);
      expect(sittings().map((row) => row.missing)).toEqual([1, 0]);
      writeFileSync(gate, "");
      await askHome(testSocket(root), "rebuild", ["extracts", "--family", "screen"]);
      await until("the rebuild held in its second week", () => existsSync(`${gate}.held`));
      await ship(root, { source: screenSource, fetched_ms: Date.now() + 1, rows: [], carried: { [hex(bytes)]: bytes } });
      await until("the text landed", () => count(root, "SELECT count(*) FROM wanted_blobs") === 0 && count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 2);
      await until("the served sitting has its text", () => sittings()[0]?.missing === 0);
      const during = { served: sittings(), next: count(root, "SELECT count(*) FROM extracts_next WHERE family = 'screen'") };
      expect(during).toEqual({ served: [{ unit: `mac-0001/${t0}`, missing: 0 }, { unit: `mac-0001/${t0 + 8 * DAY}`, missing: 0 }], next: 1 });
      rmSync(gate);
      await until("the rebuild published, its log read having read the text", () => quiet(root) && count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:screen'") === 0);
      expect(sittings().map((row) => row.missing)).toEqual([0, 0]);
      artifact(root, "walk-blob", { during, after: sittings() });
    } finally {
      await home.stop();
    }
  });

  it("a rebuild killed after its first commit leaves half a generation served, or starts again from it; one that changes nothing writes a row", async () => {
    const root = makeRoot("lifestream-derived-walk-kill-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { code: "1", per: "day" } } });
    roots.push(root);
    const child = new ChildHome(root);
    let home: Home | undefined;
    try {
      const served = () => readHome(root, (db) => db.prepare("SELECT unit, code, seq FROM extracts WHERE family = 'notes' ORDER BY unit").all() as { unit: string; code: string; seq: number }[]);
      const next = () => count(root, "SELECT count(*) FROM extracts_next WHERE family = 'notes'");
      const walks = () => count(root, "SELECT count(*) FROM runs WHERE kind = 'walk' AND subject = 'notes' AND counts LIKE '%publish_ms%'");
      const settled = () => quiet(root) && count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0;
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      const days = [Date.UTC(2026, 8, 1, 10), Date.UTC(2026, 8, 10, 10), Date.UTC(2026, 8, 20, 10)];
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: days.map((at, index) => note(`n${index}`, `note ${index}`, at)) });
      await until("three days of notes", () => settled() && served().length === 3);
      const before = served();
      const built = walks();
      await home.stop();
      home = undefined;
      editSettings(root, { "families.notes": { code: "2", per: "day" } });
      child.start("extract.walked");
      expect((await child.exited()).signal).toBe("SIGKILL");
      expect({ served: served(), next: next() }).toEqual({ served: before, next: 1 });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the rebuild walked again and published", () => settled() && served().every((row) => row.code === "2"));
      const rebuilt = served();
      expect(rebuilt.map((row) => row.unit)).toEqual(before.map((row) => row.unit));
      expect({ next: next(), walks: walks() - built }).toEqual({ next: 0, walks: 1 });
      const run = await askHome(testSocket(root), "rebuild", ["extracts", "--family", "notes"]) as { generation: number };
      await until("the second walk published", () => settled() && walks() - built === 2);
      const second = JSON.parse(readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = 'notes' AND counts LIKE '%publish_ms%' ORDER BY id DESC LIMIT 1").pluck().get() as string)) as Record<string, unknown>;
      expect(second).toMatchObject({ stage: "closing", written: 0, deleted: 0 });
      expect(served()).toEqual(rebuilt);
      expect(count(root, "SELECT count(*) FROM dirty_days")).toBe(0);
      await home.stop();
      home = undefined;
      artifact(root, "walk-kill", { before, rebuilt, run, second });
    } finally {
      await home?.stop();
      await child.stop();
    }
  });

  it("a rebuild of extracts is overwritten by a helper still running for it", async () => {
    const { root, home } = await open("lifestream-derived-rebuild-", { helpers: 2 });
    try {
      const start = Date.UTC(2024, 0, 1, 12, 0);
      const notes = 6_000;
      const step = 2 * HOUR;
      const hold = join(root, "extract-hold");
      writeFileSync(hold, "");
      const fetched = Date.now();
      await ship(root, { source: SOURCE, fetched_ms: fetched, rows: [], facts: { generate: { count: notes, start_ms: start, step_ms: step, prefix: "h" } } });
      await ship(root, { source: SOURCE, fetched_ms: fetched + 1, rows: [note("held", "the last day held", start + (notes - 1) * step, { hold })] });
      await until("an extract part way through", () => existsSync(`${hold}.held`) &&
        count(root, "SELECT (SELECT count(*) FROM extracts WHERE family = 'notes') + (SELECT count(*) FROM extracts_next WHERE family = 'notes')") > 0 &&
        readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind IN ('extract', 'walk') AND key = 'notes' AND state = 'running'").pluck().get()) === "running");
      const rebuilt = await askHome(testSocket(root), "rebuild", ["extracts", "--family", "notes"]) as { generation: number };
      rmSync(hold);
      await until("the rebuilt family", () => quiet(root) && count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 2);
      const days = new Set(Array.from({ length: notes }, (_, index) => new Date(start + index * step).toISOString().slice(0, 10)));
      const cursor = readHome(root, (db) => db.prepare("SELECT seq, generation FROM cursors WHERE name = 'extract:notes'").get() as { seq: number; generation: number });
      expect(count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'")).toBe(days.size);
      expect(count(root, "SELECT generation FROM cursors WHERE name = 'rebuild:notes'")).toBe(rebuilt.generation);
      expect(cursor.seq).toBe(count(root, "SELECT max(seq) FROM statements"));
      artifact(root, "rebuild-under-helper", { days: days.size, cursor, rebuilt });
    } finally {
      await home.stop();
    }
  });

  it("a day-start change leaves extracts indexed under the days they were before", async () => {
    let { root, home } = await open("lifestream-derived-day-start-");
    try {
      const date = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
      const at = Date.parse(`${date}T02:00:00Z`);
      const before = civilDay(at, UTC4);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "a note at two", at)] });
      await until("the note on the day before its date", () => dayText(root, before).includes("a note at two"));
      await home.stop();
      editSettings(root, { "day.day_start_hour": 0 });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the note on its date", () => dayText(root, date).includes("a note at two") && quiet(root));
      expect(dayText(root, before)).not.toContain("a note at two");
      expect(readHome(root, (db) => db.prepare("SELECT day FROM extract_days WHERE family = 'notes'").pluck().all())).toEqual([date]);
      artifact(root, "day-start-change", { before, date, days: { [before]: dayText(root, before), [date]: dayText(root, date) } });
    } finally {
      await home.stop();
    }
  });

  it("a rebuild of N units makes N plan jobs", async () => {
    const { root, home } = await open("lifestream-derived-plan-rows-");
    try {
      const units = 300;
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [], facts: { generate: { count: units, start_ms: Date.now() - 400 * DAY, step_ms: DAY, prefix: "d" } } });
      await until("every unit extracted and planned", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'") === units);
      const rebuilt = await askHome(testSocket(root), "rebuild", ["enrichments", "--family", "notes"]) as { units: number };
      expect(rebuilt.units).toBe(units);
      await until("the rebuild planned", () => quiet(root) && count(root, "SELECT count(*) FROM dirty_units") === 0);
      const jobs = readHome(root, (db) => db.prepare("SELECT kind, key, state FROM jobs WHERE kind = 'plan'").all());
      const runs = readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'plan' AND subject = 'notes' ORDER BY id").pluck().all() as string[])
        .map((counts) => JSON.parse(counts) as { units: number; planned: number; rows: number }));
      expect(jobs).toEqual([{ kind: "plan", key: "notes", state: "done" }]);
      expect(runs.reduce((sum, run) => sum + run.planned, 0)).toBe(2 * units);
      artifact(root, "plan-job-rows", { units, rebuilt, jobs, runs });
    } finally {
      await home.stop();
    }
  });

  it("a rebuild of some days' extracts extracts another day's units, misses one of its days, or waits for the family's cursor", async () => {
    const { root, home } = await open("lifestream-derived-rebuild-days-");
    try {
      const start = Date.UTC(2026, 5, 1, 12, 0);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [], facts: { generate: { count: 10, start_ms: start, step_ms: DAY, prefix: "r" } } });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("early", "a synthetic note before the day starts", Date.UTC(2026, 5, 6, 2, 0))] });
      await until("every unit extracted", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'") === 10 &&
        count(root, "SELECT count(*) FROM extract_days WHERE family = 'notes' AND unit = ?", `${SOURCE}/2026-06-06`) === 2);
      const cursor = () => readHome(root, (db) => db.prepare("SELECT seq, generation FROM cursors WHERE name = 'extract:notes'").get());
      const before = { cursor: cursor(), runs: count(root, "SELECT count(*) FROM runs WHERE kind = 'extract' AND subject = 'notes'") };
      const sock = testSocket(root);
      await expect(askHome(sock, "rebuild", ["extracts", "--family", "notes", "--from", "2026-06-05", "--to", "2026-06-03"])).rejects.toThrow("--from 2026-06-05 is after --to 2026-06-03");
      await expect(askHome(sock, "rebuild", ["enrichments", "--family", "notes", "--from", "2026-06-03", "--to", "2026-06-05"])).rejects.toThrow("--from and --to name the days of a rebuild of extracts");
      expect(await askHome(sock, "rebuild", ["extracts", "--family", "notes", "--from", "2026-06-03", "--to", "2026-06-06"])).toMatchObject({ units: 4 });
      const reread = readHome(root, (db) => db.prepare("SELECT unit FROM rereads WHERE family = 'notes' ORDER BY unit").pluck().all());
      expect(reread).toEqual(["03", "04", "05", "06"].map((day) => `${SOURCE}/2026-06-${day}`));
      await until("the days extracted again", () => quiet(root) && count(root, "SELECT count(*) FROM runs WHERE kind = 'extract' AND subject = 'notes'") > before.runs);
      const run = readHome(root, (db) => JSON.parse(db.prepare("SELECT counts FROM runs WHERE kind = 'extract' AND subject = 'notes' ORDER BY id DESC").pluck().get() as string));
      expect(run).toMatchObject({ statements: 0, units: 4 });
      expect(cursor()).toEqual(before.cursor);
      artifact(root, "rebuild-days", { reread, run, cursor: cursor() });
    } finally {
      await home.stop();
    }
  });

  it("one unit whose plan throws stops its family's planning", async () => {
    const { root, home } = await open("lifestream-derived-plan-throws-");
    try {
      const sock = testSocket(root);
      const base = Date.UTC(2026, 5, 1, 12, 0);
      const unit = (at: number) => `${SOURCE}/${new Date(at).toISOString().slice(0, 10)}`;
      const dirty = () => readHome(root, (db) => db.prepare("SELECT unit, error FROM dirty_units ORDER BY unit").all()) as { unit: string; error: string | null }[];
      const plan = () => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'plan' AND key = 'notes'").get()) as { state: string; attempts: number; error: string | null };
      const planned = () => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'plan' AND subject = 'notes'").pluck().all() as string[])
        .reduce((sum, counts) => sum + (JSON.parse(counts) as { planned: number }).planned, 0));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [
        note("a", "the first day", base), note("b", "the malformed day", base + DAY, { plan_throw: true }), note("c", "the third day", base + 2 * DAY),
      ] });
      await until("the other units planned, the malformed one set aside", () => quiet(root) && planned() === 2);
      expect(dirty()).toEqual([{ unit: unit(base + DAY), error: "note b is malformed" }]);
      expect(plan()).toEqual({ state: "done", attempts: 0, error: null });
      const status = statusOf(root) as { notices: { id: string; what: string }[] };
      const need = status.notices.find((each) => each.id === "unit:notes");
      expect(need?.what).toBe(`notes: 1 unit set aside, the plan threw (run plan notes plans them again, as new evidence does): ${unit(base + DAY)}: note b is malformed`);
      const ran = await askHome(sock, "run", ["plan", "notes"]) as { retried: number };
      expect(ran.retried).toBe(1);
      await until("the unit tried again", () => quiet(root) && readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'plan' AND subject = 'notes'").pluck().get()) === 2);
      expect(dirty()).toEqual([{ unit: unit(base + DAY), error: "note b is malformed" }]);
      expect(plan()).toEqual({ state: "done", attempts: 0, error: null });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the corrected day", base + DAY)] });
      await until("the corrected unit planned", () => quiet(root) && dirty().length === 0 && planned() === 3);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR / 2, rows: [
        note("d", "malformed too", base + 3 * DAY, { plan_throw: true }), note("e", "malformed as well", base + 4 * DAY, { plan_throw: true }),
      ] });
      await until("the job failed once", () => plan().attempts === 1);
      expect(dirty().map((row) => row.error)).toEqual(["note d is malformed", "note e is malformed"]);
      expect(plan()).toMatchObject({ state: "queued", attempts: 1, error: expect.stringContaining("every unit of the run threw") });
      artifact(root, "plan-unit-throws", { dirty: dirty(), plan: plan(), need, ran });
    } finally {
      await home.stop();
    }
  });

  it("one unit whose extract throws stops its family", async () => {
    const { root, home } = await open("lifestream-derived-extract-throws-");
    try {
      const sock = testSocket(root);
      const [first, middle, third] = threeDays();
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [
        note("a", "the first day", first), note("b", "the malformed day", middle, { extract_throw: true }), note("c", "the third day", third),
      ] });
      await until("the other units extracted, the malformed one set aside", () => quiet(root) && notesServed(root).length === 2 && setAside(root).length === 1);
      expect(notesServed(root)).toEqual([unitOf(first), unitOf(third)]);
      expect(setAside(root)).toEqual([{ unit: unitOf(middle), error: "note b is malformed" }]);
      expect(extractJob(root)).toEqual({ state: "done", attempts: 0, error: null });
      expect(notesCursor(root)).toBe(count(root, "SELECT max(seq) FROM statements"));
      await until("the other days printed", () => quiet(root) && dayText(root, civilDay(first, UTC4)).includes("the first day") && dayText(root, civilDay(third, UTC4)).includes("the third day"));
      const status = statusOf(root) as { notices: { id: string; what: string }[] };
      const notice = status.notices.find((each) => each.id === "extract:notes");
      expect(notice?.what).toBe(`notes: 1 unit set aside, the extract threw; each keeps its last build where it has one (run extract notes builds them again, as new evidence and the next start do): ${unitOf(middle)}: note b is malformed`);
      artifact(root, "extract-unit-throws", { aside: setAside(root), notice });
    } finally {
      await home.stop();
    }
  });

  it("new evidence does not put a set-aside unit back", async () => {
    const { root, home } = await open("lifestream-derived-extract-evidence-");
    try {
      const [at] = threeDays();
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [note("b", "the malformed day", at, { extract_throw: true })] });
      await until("the unit set aside", () => quiet(root) && setAside(root).length === 1);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the corrected day", at)] });
      await until("the unit built, and printed", () => quiet(root) && dayText(root, civilDay(at, UTC4)).includes("the corrected day"));
      expect({ served: notesServed(root), aside: setAside(root) }).toEqual({ served: [unitOf(at)], aside: [] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR / 2, rows: [note("b", "the corrected day", at, { extract_throw: true })] });
      await until("the unit set aside again", () => quiet(root) && setAside(root).length === 1);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR / 4, rows: [note("b", "the corrected day", at)] });
      await until("the unit built", () => quiet(root) && setAside(root).length === 0);
    } finally {
      await home.stop();
    }
  });

  it("run extract does not put a set-aside unit back, or fails the job on it", async () => {
    const { root, home } = await open("lifestream-derived-extract-run-");
    try {
      const [at] = threeDays();
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the malformed day", at, { extract_throw: true })] });
      await until("the unit set aside", () => quiet(root) && setAside(root).length === 1);
      const tried = () => extractRuns(root).filter((run) => run.set_aside === 1).length;
      expect(tried()).toBe(1);
      const ran = await askHome(testSocket(root), "run", ["extract", "notes"]) as { retried: number };
      expect(ran.retried).toBe(1);
      await until("the unit tried again", () => quiet(root) && tried() === 2);
      expect(setAside(root)).toEqual([{ unit: unitOf(at), error: "note b is malformed" }]);
      expect(extractJob(root)).toEqual({ state: "done", attempts: 0, error: null });
      artifact(root, "extract-run-again", { ran, runs: extractRuns(root) });
    } finally {
      await home.stop();
    }
  });

  it("a shipped fix needs a verb to build a set-aside unit", async () => {
    let { root, home } = await open("lifestream-derived-extract-fix-");
    try {
      const [at] = threeDays();
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the malformed day", at, { extract_throw: true })] });
      await until("the unit set aside", () => quiet(root) && setAside(root).length === 1);
      const walked = walks(root);
      await home.stop();
      editSettings(root, { "families.notes": { tolerant: true } });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the start's put-back built it, and the day printed it", () => quiet(root) && dayText(root, civilDay(at, UTC4)).includes("the malformed day"));
      expect({ served: notesServed(root), aside: setAside(root), walks: walks(root) }).toEqual({ served: [unitOf(at)], aside: [], walks: walked });
    } finally {
      await home.stop();
    }
  });

  it("a run moved by a read-through alone moves the read marker past a unit that threw", async () => {
    const { root, home } = await open("lifestream-derived-extract-read-through-");
    try {
      const source = "screen:local:mac-0001";
      const at = Date.now() - HOUR;
      const aside = () => readHome(root, (db) => db.prepare("SELECT error FROM extracts_aside WHERE family = 'screen'").pluck().all());
      const cursor = () => count(root, "SELECT seq FROM cursors WHERE name = 'extract:screen'");
      await ship(root, { source, fetched_ms: at + MINUTE, rows: [{ kind: "frame", key: "f1", content: { at, closed_throw: true }, at }] });
      await until("the open sitting built", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'screen'") === 1);
      const before = cursor();
      await ship(root, { source, fetched_ms: at + 20 * MINUTE, rows: [], facts: { read_through: new Date(at + 20 * MINUTE).toISOString() } });
      await until("the read marker moved", () => quiet(root) && count(root, "SELECT count(*) FROM cursors WHERE name = ? AND at_ms = ?", `read:screen:${source}`, at + 20 * MINUTE) === 1);
      expect(aside()).toEqual(["frame f1 is malformed"]);
      expect(cursor()).toBe(before);
    } finally {
      await home.stop();
    }
  });

  it("a release erases what a unit held, and a walk killed takes a set-aside or a served row with it", async () => {
    const root = makeRoot("lifestream-derived-extract-release-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { code: "1", tolerant: true } } });
    roots.push(root);
    const child = new ChildHome(root);
    let home: Home | undefined;
    try {
      const settled = () => quiet(root) && !walkOwed(root);
      const codes = () => notesRows(root).map(({ unit, code }) => [unit, code]);
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      const week = 7 * DAY;
      const [bad, good, other, old] = [0, 1, 2, 3].map((index) => Date.UTC(2026, 5, 1, 12) + index * week) as [number, number, number, number];
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [
        note("b", "the day a bump breaks", bad, { extract_throw: true }), note("g", "a good day", good), note("o", "another good day", other), note("e", "an old set-aside", old),
      ] });
      await until("four days served", () => settled() && notesServed(root).length === 4);
      await home.stop();
      home = undefined;
      editSettings(root, { "families.notes": { code: "1" } });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("e", "an old set-aside", old, { extract_throw: true })] });
      await until("the old unit set aside", () => settled() && setAside(root).length === 1);
      await home.stop();
      home = undefined;
      const served = notesRows(root);
      const aside = setAside(root);
      editSettings(root, { "families.notes": { code: "2" } });
      child.start("extract.walked");
      expect((await child.exited()).signal).toBe("SIGKILL");
      expect({ served: notesRows(root), aside: setAside(root), next: count(root, "SELECT count(*) FROM extracts_next WHERE family = 'notes'") }).toEqual({ served, aside, next: 1 });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the walk published", () => settled() && setAside(root).length === 2);
      expect(codes()).toEqual([[unitOf(bad), "1"], [unitOf(good), "2"], [unitOf(other), "2"], [unitOf(old), "1"]]);
      expect(setAside(root)).toEqual([{ unit: unitOf(bad), error: "note b is malformed" }, { unit: unitOf(old), error: "note e is malformed" }]);
      expect(dayText(root, civilDay(bad, UTC4))).toContain("the day a bump breaks");
      expect(count(root, "SELECT count(*) FROM extracts_next")).toBe(0);
      await home.stop();
      home = undefined;
      editSettings(root, { "families.notes": { code: "2", tolerant: true } });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the fix built both", () => settled() && setAside(root).length === 0);
      expect(codes()).toEqual([[unitOf(bad), "2"], [unitOf(good), "2"], [unitOf(other), "2"], [unitOf(old), "2"]]);
      artifact(root, "extract-release", { codes: codes(), runs: extractRuns(root) });
    } finally {
      await home?.stop();
      await child.stop();
    }
  });

  it("a set-aside unit is lost across a kill", async () => {
    const base = Date.UTC(2025, 0, 1, 12);
    const rows = Array.from({ length: 201 }, (_, index) => note(`n${index}`, `note ${index}`, base + index * DAY, index === 0 ? { extract_throw: true } : {}));
    for (const point of ["extract.aside", "home.chunk.extract"]) {
      const root = makeRoot("lifestream-derived-extract-kill-", { sources: { [SOURCE]: "fake-rows" } });
      roots.push(root);
      const child = new ChildHome(root);
      let home: Home | undefined;
      try {
        home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
        await until("the new home's walk published", () => quiet(root) && !walkOwed(root));
        await askHome(testSocket(root), "pause", ["kind:extract", "--reason", "a test"]);
        await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows });
        await until("the notes imported", () => count(root, "SELECT count(*) FROM heads WHERE kind = 'note'") === 201);
        await home.stop();
        home = undefined;
        const cursor = notesCursor(root);
        const db = openHome(openHomeFolder(root), "migrate");
        db.commit((tx) => tx.tables.controls.clear("kind:extract"));
        db.close();
        child.start(point);
        expect((await child.exited()).signal).toBe("SIGKILL");
        const landed = notesRows(root);
        expect(notesCursor(root)).toBe(cursor);
        expect({ point, aside: setAside(root).length, served: landed.length }).toEqual(point === "extract.aside" ? { point, aside: 1, served: 199 } : { point, aside: 0, served: 0 });
        home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
        await until("the run ended", () => extractJob(root).state === "done" && notesCursor(root) > cursor);
        expect(setAside(root)).toEqual([{ unit: unitOf(base), error: "note n0 is malformed" }]);
        const served = notesRows(root);
        expect(served.length).toBe(200);
        expect(served.filter((row) => landed.some((each) => each.unit === row.unit && each.seq === row.seq)).length).toBe(landed.length);
        expect(extractJob(root)).toEqual({ state: "done", attempts: 0, error: null });
        expect(extractRuns(root).at(-1)).toMatchObject({ written: 200 - landed.length, set_aside: 1 });
      } finally {
        await home?.stop();
        await child.stop();
      }
    }
  });

  it("a family no longer run keeps its set-aside", async () => {
    let { root, home } = await open("lifestream-derived-extract-forget-");
    try {
      const [at] = threeDays();
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the malformed day", at, { extract_throw: true })] });
      await until("the unit set aside", () => quiet(root) && setAside(root).length === 1);
      expect(extractJob(root).state).toBe("done");
      await home.stop();
      editSettings(root, { "families.notes": { absent: true } });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      expect(setAside(root)).toEqual([]);
      expect(count(root, "SELECT count(*) FROM rereads WHERE family = 'notes'")).toBe(0);
    } finally {
      await home.stop();
    }
  });

  it("an extract chunk computed before the one ahead of it commits leaves the record's old reading", async () => {
    const { root, home } = await open("lifestream-derived-chunk-ahead-", { helpers: 3 });
    try {
      const sock = testSocket(root);
      const hold = join(root, "extract-hold");
      const x = Date.UTC(2026, 6, 1, 12, 0);
      const z = x + 2 * DAY;
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 3 * HOUR, rows: [note("k", "as it was", x)] });
      await until("the note extracted", () => quiet(root) && JSON.stringify(extractOf(root, unitOf(x))).includes("as it was"));
      await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
      writeFileSync(hold, "");
      const fillers = Array.from({ length: 1_998 }, (_, index) => note(`f${index}`, `filler ${index}`, z + index * MINUTE));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [note("k", "changed", x), note("h", "held", z, { hold }), ...fillers] });
      await until("the change imported", () => count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 2);
      await askHome(sock, "resume", ["kind:extract"]);
      await until("the first chunk held", () => existsSync(`${hold}.held`));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("k", "as it was", x)] });
      await until("the change undone imported", () => count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 3);
      rmSync(hold);
      await until("the extract caught up", () => quiet(root) && count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'") === count(root, "SELECT max(seq) FROM statements"));
      const extract = JSON.stringify(extractOf(root, unitOf(x)));
      artifact(root, "extract-chunk-ahead", { unit: unitOf(x), extract: extractOf(root, unitOf(x)) });
      expect(extract).toContain("as it was");
      expect(extract).not.toContain("changed");
    } finally {
      await home.stop();
    }
  });

  it("a record repeated across slices of one delivery moves its head back unseen by its family", async () => {
    const { root, home } = await open("lifestream-derived-repeat-slices-", { helpers: 3 });
    try {
      const hold = join(root, "import-hold");
      const x = Date.UTC(2026, 6, 1, 12, 0);
      const y = x + DAY;
      const z = x + 2 * DAY;
      const stated = { exported_at: new Date(Date.now() - 3 * HOUR).toISOString() };
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, facts: stated, rows: [note("k", "on x", x)] });
      await until("the note extracted on x", () => quiet(root) && JSON.stringify(extractOf(root, unitOf(x))).includes("on x"));
      writeFileSync(hold, "");
      const fillers = Array.from({ length: 2_000 }, (_, index) => note(`f${index}`, `filler ${index}`, z + index * MINUTE));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, facts: stated, rows: [note("k", "on y", y), ...fillers, { hold }, note("k", "on x", x)] });
      await until("the family read the note on y", () => existsSync(`${hold}.held`) && JSON.stringify(extractOf(root, unitOf(y))).includes("on y"));
      rmSync(hold);
      await until("the delivery imported and read", () => quiet(root) && count(root, "SELECT count(*) FROM deliveries WHERE state = 'imported'") === 2
        && count(root, "SELECT seq FROM cursors WHERE name = 'extract:notes'") === count(root, "SELECT max(seq) FROM statements"));
      const head = readHome(root, (db) => db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.key = 'k'").pluck().get(SOURCE)) as string;
      const extracts = { x: extractOf(root, unitOf(x)), y: extractOf(root, unitOf(y)) };
      artifact(root, "repeat-across-slices", { head, extracts });
      expect(head).toContain("on x");
      expect(JSON.stringify(extracts.x)).toContain("on x");
      expect(extracts.y).toBeUndefined();
    } finally {
      await home.stop();
    }
  });

  it("a dead extract stays dead past the next start, so a release that fixed it never runs it", async () => {
    const root = makeRoot("lifestream-derived-dead-extract-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "extract", key: "notes", lane: LANE.live, not_before_ms: now, now_ms: now });
      const id = tx.tables.jobs.get("extract", "notes")!.id;
      for (let attempt = 0; attempt < 5; attempt++) tx.tables.jobs.fail(id, "a synthetic crash", now);
    });
    db.close();
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const extract = () => readHome(root, (db) => db.prepare("SELECT state, attempts FROM jobs WHERE kind = 'extract' AND key = 'notes'").get());
      await ship(root, { source: SOURCE, fetched_ms: now - MINUTE, rows: [note("n1", "a note after the extract was dead", now - 2 * MINUTE)] });
      await until("the note extracted", () => quiet(root) && count(root, "SELECT count(*) FROM extracts") === 1);
      expect(extract()).toEqual({ state: "done", attempts: 0 });
      const started = JSON.parse(readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'home' AND key = 'start'").pluck().get() as string)) as { revived: string[] };
      expect(started.revived).toEqual(["extract notes"]);
      expect(statusOf(root).needs.filter((each) => each.id.startsWith("job:"))).toEqual([]);
      artifact(root, "dead-extract-revived", { started });
    } finally {
      await home.stop();
    }
  });

  it("a family that adds an input without a code bump never reads what landed before it", async () => {
    let { root, home } = await open("lifestream-derived-inputs-");
    try {
      const at = Date.UTC(2026, 8, 30, 10, 0);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: Date.now(), rows: [{ kind: "frame", key: "f1", content: { at }, at }] });
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "a note beside a frame", at)] });
      const content = () => JSON.parse(readHome(root, (db) => db.prepare("SELECT content FROM extracts WHERE family = 'notes'").pluck().get() as string)) as { frames?: number };
      const cursor = () => readHome(root, (db) => db.prepare("SELECT (SELECT generation FROM cursors WHERE name = 'rebuild:notes') AS generation, fingerprint FROM cursors WHERE name = 'extract:notes'").get()) as { generation: number; fingerprint: string };
      await until("the day unit", () => quiet(root) && count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'") === 1);
      expect(content().frames).toBeUndefined();
      const was = cursor();
      await home.stop();
      editSettings(root, { "families.notes": { frames: true } });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the unit counts the frame that landed before the input", () => quiet(root) && content().frames === 1);
      expect(cursor().generation).toBe(was.generation + 1);
      expect(cursor().fingerprint).not.toBe(was.fingerprint);
      artifact(root, "input-added", { was, now: cursor(), content: content() });
    } finally {
      await home.stop();
    }
  });

  it("a backlog of days to render makes a job per day, and holds the lane: an extract waits behind every one of them", async () => {
    const root = makeRoot("lifestream-derived-render-turns-", { sources: { "apple-notes:local:history": "fake-rows", "screen:local:mac-0001": "fake-rows" }, helpers: 2 });
    roots.push(root);
    const now = Date.now();
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const t0 = now - 3 * DAY;
      await ship(root, { source: "apple-notes:local:history", fetched_ms: t0 - 1, rows: [note("first", "the first note", now - 401 * DAY)] });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 - 1, rows: [{ kind: "frame", key: "f0", content: { at: now - 401 * DAY }, at: now - 401 * DAY }] });
      await until("today and the first records' day rendered", () => quiet(root) && count(root, "SELECT count(*) FROM dirty_days") === 0 && count(root, "SELECT count(*) FROM asks WHERE state = 'pending'") === 0);
      const before = (statusOf(root) as { today: { render: { runs: number } } }).today.render.runs;
      await askHome(sock, "pause", ["kind:render", "--reason", "the test holds it"]);
      const days = 25;
      await ship(root, { source: "apple-notes:local:history", fetched_ms: t0, rows: [], facts: { generate: { count: days, start_ms: now - 400 * DAY, step_ms: DAY, prefix: "h" } } });
      const render = () => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'render' AND key = 'days'").get()) as { state: string; lane: number } | undefined;
      await until("every day marked, the one render job queued, nothing else to do", () => count(root, "SELECT count(*) FROM dirty_days") >= days && render()?.state === "queued" &&
        count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind <> 'render'") === 0);
      expect(render()).toEqual({ state: "queued", lane: LANE.backfill });
      await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0, rows: [{ kind: "frame", key: "f1", content: { at: t0 - 100_000 }, at: t0 - 100_000 }] });
      const queued = () => readHome(root, (db) => db.prepare("SELECT kind || ' ' || key FROM jobs WHERE state = 'queued' AND lane = 5 ORDER BY not_before_ms, id").pluck().all()) as string[];
      await until("the screen extract queued behind the render", () => queued()[0] === "render days" && queued().at(-1) === "extract screen" &&
        count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind NOT IN ('render', 'extract')") === 0);
      const mark = readHome(root, (db) => db.prepare("SELECT coalesce(max(id), 0) FROM runs").pluck().get()) as number;
      await askHome(sock, "resume", ["kind:render"]);
      await askHome(sock, "resume", ["kind:extract"]);
      await until("every day rendered", () => count(root, "SELECT count(*) FROM dirty_days") === 0 && quiet(root));
      const runs = (readHome(root, (db) => db.prepare("SELECT kind, subject, counts FROM runs WHERE id > ? AND kind IN ('render', 'extract', 'plan') ORDER BY id").all(mark)) as { kind: string; subject: string; counts: string }[])
        .map((run) => ({ job: `${run.kind} ${run.subject}`, counts: JSON.parse(run.counts) as Record<string, number> }));
      const renders = runs.flatMap((run, index) => (run.job === "render days" ? [index] : []));
      const extract = runs.findIndex((run) => run.job === "extract screen");
      expect(renders[0]).toBe(0);
      expect(extract).toBeGreaterThan(renders[0]!);
      expect(extract).toBeLessThan(renders[1]!);
      expect(runs.filter((run) => run.job === "render days").every((run) => run.counts.days! <= 10 && run.counts.days! > 0)).toBe(true);
      expect(runs.filter((run) => run.job === "render days").reduce((sum, run) => sum + run.counts.written!, 0)).toBeGreaterThanOrEqual(days);
      expect(readHome(root, (db) => db.prepare("SELECT key FROM jobs WHERE kind = 'render'").pluck().all())).toEqual(["days"]);
      const status = statusOf(root) as { today: { render: { runs: number; days: number; written: number } } };
      expect(status.today.render.runs - before).toBe(renders.length);
      artifact(root, "render-turns", { runs, render: status.today.render });
    } finally {
      await home.stop();
    }
  });

  it("one day whose render throws stops every day's render", async () => {
    const { root, home } = await open("lifestream-derived-render-throws-");
    try {
      const sock = testSocket(root);
      const base = Date.UTC(2026, 5, 1, 12, 0);
      const day = (at: number) => civilDay(at, UTC4);
      const aside = () => readHome(root, (db) => db.prepare("SELECT day, error FROM dirty_days WHERE error IS NOT NULL ORDER BY day").all()) as { day: string; error: string }[];
      const render = () => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'render' AND key = 'days'").get()) as { state: string; attempts: number; error: string | null };
      const runs = () => count(root, "SELECT count(*) FROM runs WHERE kind = 'render'");
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [
        note("a", "the first day", base), note("b", "the unprintable day", base + DAY, { render_throw: true }), note("c", "the third day", base + 2 * DAY),
      ] });
      await until("the other days rendered, the unprintable one set aside", () => quiet(root) && dayText(root, day(base)).includes("the first day") && dayText(root, day(base + 2 * DAY)).includes("the third day"));
      expect(aside()).toEqual([{ day: day(base + DAY), error: "note b cannot be printed" }]);
      expect(dayText(root, day(base + DAY))).toBe("");
      expect(render()).toEqual({ state: "done", attempts: 0, error: null });
      const status = statusOf(root) as { notices: { id: string; what: string }[] };
      const need = status.notices.find((each) => each.id === "day:render");
      expect(need?.what).toBe(`render: 1 day set aside, the render threw (run render days renders them again, as new evidence does): ${day(base + DAY)}: note b cannot be printed`);
      await expect(askHome(sock, "run", ["render", day(base + DAY)])).rejects.toThrow(/the one render job's key is days/u);
      const before = runs();
      const ran = await askHome(sock, "run", ["render", "days"]) as { retried: number };
      expect(ran.retried).toBe(1);
      await until("the day tried again", () => quiet(root) && runs() > before && aside().length === 1);
      expect(aside()).toEqual([{ day: day(base + DAY), error: "note b cannot be printed" }]);
      expect(render()).toEqual({ state: "done", attempts: 0, error: null });
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR, rows: [note("b", "the corrected day", base + DAY)] });
      await until("the corrected day rendered", () => quiet(root) && aside().length === 0 && dayText(root, day(base + DAY)).includes("the corrected day"));
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - HOUR / 2, rows: [
        note("d", "unprintable too", base + 3 * DAY, { render_throw: true }), note("e", "unprintable as well", base + 4 * DAY, { render_throw: true }),
      ] });
      await until("the job failed once", () => render().attempts === 1);
      expect(aside().map((row) => row.error)).toEqual(["note d cannot be printed", "note e cannot be printed"]);
      expect(render()).toMatchObject({ state: "queued", attempts: 1, error: expect.stringContaining("every day of the run threw") });
      artifact(root, "render-throws", { aside: aside(), render: render(), need, ran });
    } finally {
      await home.stop();
    }
  });

  it("a day whose files meet a full disk is set aside as bad content, or its job dies of it", async () => {
    const root = makeRoot("lifestream-derived-render-full-", { sources: { [SOURCE]: "fake-rows", "screen:local:mac-0001": "fake-rows" } });
    roots.push(root);
    const logs: { job?: string; waits?: string }[] = [];
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as { job?: string; waits?: string }) });
    try {
      const base = Date.UTC(2026, 5, 1, 12, 0);
      const day = civilDay(base, UTC4);
      const render = () => readHome(root, (db) => db.prepare("SELECT state, attempts, error FROM jobs WHERE kind = 'render' AND key = 'days'").get()) as { state: string; attempts: number; error: string | null };
      const marked = () => readHome(root, (db) => db.prepare("SELECT day, error FROM dirty_days WHERE day = ?").all(day)) as { day: string; error: string | null }[];
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * HOUR, rows: [note("full", "a day with no room", base, { render_throw: "ENOSPC" })] });
      await until("the render waiting for room", () => logs.some((line) => line.job === "render" && line.waits === "room"));
      expect(marked()).toEqual([{ day, error: null }]);
      expect(render()).toEqual({ state: "queued", attempts: 0, error: null });
      artifact(root, "render-full", { marked: marked(), render: render() });
    } finally {
      await home.stop();
    }
  });

  it("a source's read-through moved within the day writes the day again, or a source that stated nothing is listed as read", async () => {
    const root = makeRoot("lifestream-derived-coverage-", { sources: { [SOURCE]: "fake-rows", "apple-notes:local:silent": "fake-rows", "screen:local:mac-0001": "fake-rows" } });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const at = Date.now() - 10 * MINUTE;
      const day = civilDay(at, UTC4);
      const coverage = () => dayText(root, day).split("\n").find((line) => line.startsWith("notes: "));
      await ship(root, { source: SOURCE, fetched_ms: at + MINUTE, rows: [note("n1", "a note", at)] });
      await until("the day", () => dayText(root, day).includes("a note") && quiet(root));
      const first = coverage();
      const read = "read (?:into|through) the day";
      expect(first).toMatch(new RegExp(`^notes: ${SOURCE} ${read}$`, "u"));
      const inputs = readDayHead(openHomeFolder(root), day)?.inputs;
      await ship(root, { source: SOURCE, fetched_ms: at + 9 * MINUTE, rows: [] });
      await until("the delivery of nothing imported", () => settled(root, 2) && quiet(root));
      const moved = coverage();
      if (civilDay(at + 9 * MINUTE, UTC4) === day) expect([moved, readDayHead(openHomeFolder(root), day)?.inputs]).toEqual([first, inputs]);
      else expect(moved).toBe(`notes: ${SOURCE} read through the day`);
      await ship(root, { source: "apple-notes:local:silent", fetched_ms: at + 10 * MINUTE, rows: [note("s1", "a note from the second source", at + 2 * MINUTE)] });
      await until("the second source listed", () => coverage()?.includes("apple-notes:local:silent") === true && quiet(root));
      expect(coverage()).toMatch(new RegExp(`^notes: ${SOURCE} ${read}; apple-notes:local:silent ${read}$`, "u"));
      artifact(root, "coverage-lines", { first, moved, listed: coverage() });
    } finally {
      await home.stop();
    }
  });

  it("a source's first kind marks every day with files, and lists the source on days before its first record", async () => {
    const root = makeRoot("lifestream-derived-coverage-start-", { sources: { [SOURCE]: "fake-rows", "screen:local:mac-0001": "fake-rows" } });
    roots.push(root);
    const now = Date.now();
    const today = civilDay(now, UTC4);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: () => now, log: () => undefined });
    try {
      const sock = testSocket(root);
      const noon = (date: number) => Date.UTC(2025, 0, date, 12, 0);
      const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => `2025-01-${String(from + index).padStart(2, "0")}`);
      const frame = (key: string, at: number) => ({ kind: "frame", key, content: { at }, at });
      const marked = () => readHome(root, (db) => db.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all());
      const settled = (sittings: number) => count(root, "SELECT count(*) FROM extracts WHERE family = 'screen'") === sittings &&
        count(root, "SELECT count(*) FROM jobs WHERE kind <> 'render' AND state IN ('queued', 'running')") === 0;
      const screenLine = (day: string) => dayText(root, day).split("\n").find((line) => line.startsWith("screen: "));
      await ship(root, { source: SOURCE, fetched_ms: now - 1, rows: days(1, 30).map((day, index) => note(`n${index}`, `the note of ${day}`, noon(index + 1))) });
      await until("a month of days", () => quiet(root) && days(1, 30).every((day) => dayText(root, day).includes(`the note of ${day}`)));
      await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the change marked"]);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: now, rows: [frame("f20", noon(20))] });
      await until("the first sitting", () => settled(1));
      const first = marked();
      expect(first).toEqual([...days(20, 30), today]);
      await askHome(sock, "resume", ["kind:render"]);
      await until("the days rendered", () => quiet(root) && marked().length === 0);
      await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the change marked"]);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: now - 2, rows: [frame("f10", noon(10))] });
      await until("the older sitting", () => settled(2));
      const backfill = marked();
      expect(backfill).toEqual(days(10, 20));
      await askHome(sock, "resume", ["kind:render"]);
      await until("the days rendered again", () => quiet(root) && marked().length === 0);
      const lines = { "2025-01-05": screenLine("2025-01-05"), "2025-01-10": screenLine("2025-01-10"), "2025-01-25": screenLine("2025-01-25") };
      expect(lines).toEqual({
        "2025-01-05": "screen: no sources",
        "2025-01-10": "screen: screen:local:mac-0001 read through the day",
        "2025-01-25": "screen: screen:local:mac-0001 read through the day",
      });
      artifact(root, "coverage-start", { first, backfill, lines });
    } finally {
      await home.stop();
    }
  });

  it("a day rendered leaves the day list without its row, or an erasure that removes a day's files keeps it or tells no reader", async () => {
    const { root, home } = await open("lifestream-derived-day-list-");
    try {
      const sock = testSocket(root);
      const at = Date.UTC(2026, 8, 10, 10, 0);
      const day = civilDay(at, UTC4);
      const listed = () => readHome(root, (db) => (db.prepare("SELECT day, inputs, counts FROM days ORDER BY day").all() as { day: string; inputs: string; counts: string }[])
        .map((row) => ({ ...row, counts: JSON.parse(row.counts) as unknown })));
      const stated = () => readdirSync(join(root, "days")).filter((name) => name.endsWith(".day.json")).map((name) => name.slice(0, -".day.json".length)).sort()
        .map((each) => ({ day: each, inputs: readDayHead(openHomeFolder(root), each)!.inputs, counts: readDayHead(openHomeFolder(root), each)!.counts }));
      const told = (after: number) => count(root, "SELECT count(*) FROM events WHERE kind = 'day' AND key = ? AND seq > ?", day, after);
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "a synthetic note the owner deletes", at)] });
      await until("the note's day rendered", () => quiet(root) && dayText(root, day).includes("the owner deletes"));
      const rendered = { listed: listed(), stated: stated() };
      expect(rendered.listed).toEqual(rendered.stated);
      expect(rendered.listed.map((row) => row.day)).toContain(day);
      expect(told(0)).toBeGreaterThan(0);

      await askHome(sock, "pause", ["kind:render", "--reason", "the test reads what the erasure removed"]);
      const before = count(root, "SELECT max(seq) FROM events");
      await askHome(sock, "erase", ["notes", "n1", "--apply"]);
      const erased = { file: existsSync(join(root, "days", `${day}.day.json`)), listed: listed().map((row) => row.day), told: told(before) };
      expect(erased).toEqual({ file: false, listed: rendered.listed.map((row) => row.day).filter((each) => each !== day), told: 1 });

      await askHome(sock, "resume", ["kind:render"]);
      await until("the day rendered again", () => quiet(root) && existsSync(join(root, "days", `${day}.day.json`)));
      const again = { listed: listed(), stated: stated() };
      expect(again.listed).toEqual(again.stated);
      expect(dayText(root, day)).not.toContain("the owner deletes");
      artifact(root, "day-list", { rendered, erased, again });
    } finally {
      await home.stop();
    }
  });

  it("a day whose files are lost while the home is stopped never comes back, or the day list keeps a day it cannot serve", async () => {
    let { root, home } = await open("lifestream-derived-lost-day-");
    try {
      const days = ["2026-09-10", "2026-09-11"] as const;
      const reader = "synthetic-token-lost-day-reader".padEnd(43, "r");
      mintPrincipal(openHomeFolder(root), { unit: "reader", kind: null, scopes: ["read"], sources: [], token: reader, now_ms: 0 });
      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: days.map((day, i) => note(`n${i}`, `a synthetic note of ${day}`, Date.parse(`${day}T10:00:00Z`))) });
      await until("both notes' days rendered", () => quiet(root) && days.every((day) => dayText(root, day).includes(`a synthetic note of ${day}`)));
      const inputs = () => days.map((day) => readDayHead(openHomeFolder(root), day)?.inputs ?? null);
      const before = inputs();
      expect(before.every((each) => each !== null)).toBe(true);
      const listed = async (): Promise<string[]> => {
        const { door, url } = await openDoor(root);
        try {
          const answer = await fetch(`${url}/v1/days`, { headers: { authorization: `Bearer ${reader}` } });
          return ((await answer.json()) as { days: { day: string }[] }).days.map((each) => each.day);
        } finally {
          await door.close();
        }
      };
      expect(await listed()).toEqual(expect.arrayContaining([...days]));
      const back = async (lose: () => void) => {
        await home.stop();
        lose();
        home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
        await until("the lost days rendered again", () => quiet(root) && inputs().every((each) => each !== null));
        return { inputs: inputs(), listed: await listed() };
      };

      const one = await back(() => {
        for (const file of ["json", "txt", "lines"] as const) rmSync(dayPath(root, days[0], file));
      });
      expect(one.inputs).toEqual(before);
      expect(one.listed).toEqual(expect.arrayContaining([...days]));
      for (const file of ["txt", "lines"] as const) expect(existsSync(dayPath(root, days[0], file))).toBe(true);

      const all = await back(() => rmSync(join(root, "days"), { recursive: true }));
      expect(all.inputs).toEqual(before);
      expect(all.listed).toEqual(expect.arrayContaining([...days]));
      artifact(root, "lost-day", { before, one, all });
    } finally {
      await home.stop();
    }
  });

  it("a code bump's rebuild of one family among two names what it changed and why, empties its next generation, leaves the other family alone, and a day file lost after it comes back", async () => {
    const families = (code: string, per: string) => ({ "families.notes": { code, per } });
    let { root, home } = await open("lifestream-derived-journey-", families("1", "day"));
    try {
      const screenSource = "screen:local:mac-0001";
      const [sep1, sep10, sep20] = [Date.UTC(2026, 8, 1, 10), Date.UTC(2026, 8, 10, 10), Date.UTC(2026, 8, 20, 10)];
      const days = ["2026-09-01", "2026-09-10", "2026-09-20"];
      const served = (family: string) => readHome(root, (db) => db.prepare("SELECT unit, reading, code FROM extracts WHERE family = ? ORDER BY unit").all(family)) as { unit: string; reading: string; code: string }[];
      const publishes = (family: string) => (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = ? AND counts LIKE '%publish_ms%' ORDER BY id").pluck().all(family)) as string[])
        .map((text) => JSON.parse(text) as { written: number; deleted: number; changed_units: { written: string[]; deleted: string[] }; reason: string[] });
      const emptied = () => (readHome(root, (db) => db.prepare("SELECT counts FROM runs WHERE kind = 'walk' AND subject = 'notes' ORDER BY id").pluck().all()) as string[])
        .map((text) => JSON.parse(text) as { stage: string; emptied?: number }).filter((run) => run.stage === "emptying").map((run) => run.emptied ?? 0);
      const settled = () => quiet(root) && count(root, "SELECT count(*) FROM cursors WHERE name LIKE 'rebuild:%' AND seq > 0") === 0;
      const inputs = () => days.map((day) => readDayHead(openHomeFolder(root), day)?.inputs ?? null);
      const restart = async () => {
        home = await startHome(root, { stopGraceMs: 50, lookMs: LOOK_MS, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
      };

      await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [
        note("n1", "the first note", sep1), note("n2", "the second note", sep1 + 4 * HOUR), note("n3", "the third note", sep10), note("n4", "the fourth note", sep20),
      ] });
      await ship(root, { source: screenSource, fetched_ms: Date.now() + 1, rows: [{ kind: "frame", key: "f1", content: { at: sep10 + HOUR }, at: sep10 + HOUR }] });
      await until("both families served and every day rendered", () => settled() && served("notes").length === 3 && served("screen").length === 1 &&
        dayText(root, days[1]!).includes("1 frames: fake reply") && days.every((day) => readDayHead(openHomeFolder(root), day) !== null));
      const before = { notes: served("notes"), screen: served("screen"), screenPublishes: publishes("screen").length, notesPublishes: publishes("notes").length };
      expect(before.notes.map((row) => row.unit)).toEqual(days.map((day) => `${SOURCE}/${day}`));

      await home.stop();
      editSettings(root, families("2", "hour"));
      await restart();
      await until("the walk published and its next generation emptied", () => settled() && publishes("notes").length === before.notesPublishes + 1 &&
        count(root, "SELECT count(*) FROM extracts_next") === 0);
      const hours = ["2026-09-01T10", "2026-09-01T14", "2026-09-10T10", "2026-09-20T10"].map((hour) => `${SOURCE}/${hour}`);
      const walk = publishes("notes").at(-1)!;
      const told = { written: walk.written, deleted: walk.deleted, changed: { written: [...walk.changed_units.written].sort(), deleted: [...walk.changed_units.deleted].sort() }, reason: walk.reason };
      expect(told).toEqual({ written: 4, deleted: 3, changed: { written: hours, deleted: before.notes.map((row) => row.unit) }, reason: ["code"] });
      expect(emptied().reduce((sum, each) => sum + each, 0)).toBe(4);
      expect(served("notes").map((row) => ({ unit: row.unit, code: row.code }))).toEqual(hours.map((unit) => ({ unit, code: "2" })));
      expect({ screen: served("screen"), publishes: publishes("screen").length }).toEqual({ screen: before.screen, publishes: before.screenPublishes });
      expect(dayText(root, days[0]!).match(/the (first|second) note/gu)).toEqual(["the first note", "the second note"]);
      expect(dayText(root, days[1]!)).toContain("1 frames: fake reply");
      const rebuilt = inputs();
      expect(rebuilt.every((each) => each !== null)).toBe(true);

      await home.stop();
      for (const file of ["json", "txt", "lines"] as const) rmSync(dayPath(root, days[1]!, file));
      await restart();
      await until("the lost day rendered again", () => quiet(root) && readDayHead(openHomeFolder(root), days[1]!) !== null);
      expect(inputs()).toEqual(rebuilt);
      expect(dayText(root, days[1]!)).toContain("1 frames: fake reply");
      expect(readHome(root, (db) => db.prepare("SELECT day FROM days ORDER BY day").pluck().all())).toEqual(expect.arrayContaining(days));
      artifact(root, "journey", { before, walk, emptied: emptied(), rebuilt });
    } finally {
      await home.stop();
    }
  });

  it("a blob's arrival is lost when the home dies after storing it and before the import commits", async () => {
    const root = makeRoot("lifestream-derived-late-blob-", { sources: { "screen:local:mac-0001": "fake-rows" } });
    roots.push(root);
    const child = new ChildHome(root);
    let home: Home | undefined;
    try {
      const t0 = Date.now() - 20 * MINUTE;
      const bytes = Buffer.from("synthetic text segment for one frame");
      const blob = `sha256:${hex(bytes)}`;
      const sitting = () => readHome(root, (db) => JSON.parse(db.prepare("SELECT content FROM extracts WHERE family = 'screen'").pluck().get() as string) as { missing: number; closed: boolean });
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 1_000, rows: [{ kind: "frame", key: "f1", content: { at: t0, blob }, at: t0, blobs: [blob] }] });
      await until("the sitting, its segment missing", () => sitting().missing === 1);
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 330_000, rows: [], facts: { read_through: new Date(t0 + 301_000).toISOString() } });
      await until("the sitting closed and quiet", () => sitting().closed && quiet(root));
      await home.stop();
      home = undefined;
      child.start("import.blob");
      await child.ready();
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0 + 400_000, rows: [], carried: { [hex(bytes)]: bytes } });
      expect((await child.exited()).signal).toBe("SIGKILL");
      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
      await until("the segment found", () => sitting().missing === 0 && quiet(root));
      expect(count(root, "SELECT count(*) FROM wanted_blobs")).toBe(0);
      await home.stop();
      home = undefined;
      artifact(root, "late-blob-after-kill", sitting());
    } finally {
      await home?.stop();
      await child.stop();
    }
  });
});

describe("a planning backlog in the backfill lane", () => {
  let root: string;
  afterAll(() => removeRoot(root));

  it("holds the lane until it is done: another family's extract waits behind the whole backlog", async () => {
    root = makeRoot("lifestream-plan-turns-", { sources: { "apple-notes:local:history": "fake-rows", "screen:local:mac-0001": "fake-rows" }, helpers: 2 });
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.controls.set({ target: "kind:plan", reason: "the test holds it", at_ms: now, by: "terminal" });
      tx.tables.controls.set({ target: "kind:render", reason: "the test holds it", at_ms: now, by: "terminal" });
    });
    db.close();
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const units = 2_100;
      await ship(root, { source: "apple-notes:local:history", fetched_ms: now - 2 * HOUR, rows: [], facts: { generate: { count: units, start_ms: now - 2_200 * DAY, step_ms: DAY, prefix: "history" } } });
      const plan = (family: string) => readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = 'plan' AND key = ?").get(family)) as { state: string; lane: number } | undefined;
      await until("every unit marked, every extract done, the family's one plan queued", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM dirty_units WHERE family = 'notes'").pluck().get()) === units &&
        readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind IN ('extract', 'walk') AND state <> 'done'").pluck().get()) === 0 && plan("notes")?.state === "queued");
      expect(plan("notes")).toEqual({ state: "queued", lane: LANE.backfill });
      await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
      const t0 = now - 3 * DAY;
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0, rows: [{ kind: "frame", key: "f1", content: { at: t0 - 100_000 }, at: t0 - 100_000 }] });
      const queued = () => readHome(root, (db) => db.prepare("SELECT kind || ' ' || key FROM jobs WHERE state = 'queued' AND lane = 5 AND kind <> 'render' ORDER BY not_before_ms, id").pluck().all()) as string[];
      await until("the screen extract queued behind the plan", () => queued().join() === "plan notes,extract screen");
      const mark = readHome(root, (db) => db.prepare("SELECT coalesce(max(id), 0) FROM runs").pluck().get()) as number;
      await askHome(sock, "resume", ["kind:plan"]);
      await askHome(sock, "resume", ["kind:extract"]);
      await until("every unit planned", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM dirty_units").pluck().get()) === 0 &&
        readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind <> 'render'").pluck().get()) === 0);
      const runs = (readHome(root, (db) => db.prepare("SELECT kind, subject, counts FROM runs WHERE id > ? AND kind IN ('plan', 'extract') ORDER BY id").all(mark)) as { kind: string; subject: string; counts: string }[])
        .map((run) => ({ job: `${run.kind} ${run.subject}`, counts: JSON.parse(run.counts) as Record<string, number> }));
      expect(runs.map((run) => run.job)).toEqual(["plan notes", "extract screen", "plan notes", "plan screen", "plan notes"]);
      expect(runs.filter((run) => run.job === "plan notes").map((run) => run.counts.planned)).toEqual([1_000, 1_000, 100]);
      for (const [index, run] of runs.entries()) {
        const next = runs.findIndex((other, at) => at > index && other.job === run.job);
        if (next < 0) continue;
        const between = runs.slice(index + 1, next).map((other) => other.job);
        expect(new Set(between).size, `${run.job} at turn ${index}`).toBe(between.length);
      }
      expect(readHome(root, (db) => db.prepare("SELECT key FROM jobs WHERE kind = 'plan' ORDER BY key").pluck().all())).toEqual(["notes", "screen"]);
      artifact(root, "plan-turns", runs);
    } finally {
      await home.stop();
    }
  });
});

describe("backfill on every helper but the last free one", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  const job = (root: string, kind: string, key: string) =>
    readHome(root, (db) => db.prepare("SELECT state, lane FROM jobs WHERE kind = ? AND key = ?").get(kind, key)) as { state: string; lane: number } | undefined;
  const queuedIn = (row: { state: string; lane: number } | undefined, lane: number) => row?.state === "queued" && row.lane === lane;
  const running = (root: string, kind: string, key: string, lane: number) => {
    const row = job(root, kind, key);
    return row?.state === "running" && row.lane === lane;
  };

  it("a rebuild of several families in backfill runs one family at a time on a home with free helpers", async () => {
    const root = makeRoot("lifestream-backfill-families-", { sources: { "apple-notes:local:archive": "fake-rows", "screen:local:mac-0001": "fake-rows" }, helpers: 4 });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const gates = { notes: join(root, "notes-gate"), screen: join(root, "screen-gate") };
      const at = Date.now() - 30 * DAY;
      await ship(root, { source: "apple-notes:local:archive", fetched_ms: at, rows: [note("n1", "an old note", at, { hold: gates.notes }), note("n2", "another old note", at + DAY)] });
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: at + 2 * DAY, rows: [0, 1, 2].map((index) => ({ kind: "frame", key: `f${index}`, content: { at: at + index * MINUTE, ...(index === 1 ? { hold: gates.screen } : {}) }, at: at + index * MINUTE })) });
      await until("both families built", () => quiet(root) && count(root, "SELECT count(DISTINCT family) FROM extracts") === 2);
      const built = readHome(root, (db) => db.prepare("SELECT family, unit, reading FROM extracts ORDER BY family, unit").all());
      writeFileSync(gates.notes, "");
      writeFileSync(gates.screen, "");
      await askHome(sock, "rebuild", ["extracts", "--family", "notes"]);
      await askHome(sock, "rebuild", ["extracts", "--family", "screen"]);
      await until("both rebuilds running in the backfill lane at once", () => running(root, "walk", "notes", LANE.backfill) && running(root, "walk", "screen", LANE.backfill));
      const during = { notes: job(root, "walk", "notes"), screen: job(root, "walk", "screen"), helpers: home.stats().helpers };
      expect(during.helpers.busy).toBeGreaterThanOrEqual(2);
      expect(during.helpers.busy).toBeLessThan(during.helpers.size);
      rmSync(gates.notes);
      rmSync(gates.screen);
      await until("both rebuilds done", () => quiet(root));
      expect(readHome(root, (db) => db.prepare("SELECT family, unit, reading FROM extracts ORDER BY family, unit").all())).toEqual(built);
      artifact(root, "backfill-families", { during, built });
    } finally {
      await home.stop();
    }
  });

  it("a live job waits behind backfill that fills every helper", async () => {
    const root = makeRoot("lifestream-backfill-live-", { sources: { "apple-notes:local:archive": "fake-rows", "apple-notes:local:device-a": "fake-rows", "screen:local:mac-0001": "fake-rows" }, helpers: 3 });
    roots.push(root);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, log: () => undefined });
    try {
      const sock = testSocket(root);
      const gates = { plan: join(root, "plan-gate"), render: join(root, "render-gate"), screen: join(root, "screen-gate") };
      for (const gate of Object.values(gates)) writeFileSync(gate, "");
      const old = Date.now() - 30 * DAY;
      await ship(root, { source: "apple-notes:local:archive", fetched_ms: old - DAY, rows: [note("first", "the archive's first note", old - DAY)] });
      await until("today and the first note's day rendered", () => quiet(root) && count(root, "SELECT count(*) FROM dirty_days") === 0);
      const mark = readHome(root, (db) => db.prepare("SELECT coalesce(max(id), 0) FROM runs").pluck().get()) as number;
      await askHome(sock, "pause", ["kind:plan", "--reason", "a test"]);
      await askHome(sock, "pause", ["kind:render", "--reason", "a test"]);
      await ship(root, { source: "apple-notes:local:archive", fetched_ms: old, rows: [note("old", "a month-old note", old, { plan_hold: gates.plan, render_hold: gates.render })] });
      await until("the old note extracted, its plan and its day queued in backfill", () =>
        job(root, "extract", "notes")?.state === "done" && queuedIn(job(root, "plan", "notes"), LANE.backfill) &&
        queuedIn(job(root, "render", "days"), LANE.backfill));
      await askHome(sock, "resume", ["kind:render"]);
      await until("the render running in backfill", () => running(root, "render", "days", LANE.backfill));
      await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
      const t0 = Date.now() - 2 * MINUTE;
      await ship(root, { source: "screen:local:mac-0001", fetched_ms: t0, rows: [{ kind: "frame", key: "f1", content: { at: t0, hold: gates.screen }, at: t0 }] });
      await until("the sitting's extract queued live", () => job(root, "extract", "screen")?.state === "queued" && job(root, "extract", "screen")?.lane === LANE.live);
      await ship(root, { source: "apple-notes:local:device-a", fetched_ms: t0 + MINUTE, rows: [note("live", "a live note", t0 + MINUTE)] });
      await until("the note's extract queued live", () => job(root, "extract", "notes")?.state === "queued" && job(root, "extract", "notes")?.lane === LANE.live);
      await askHome(sock, "resume", ["kind:plan"]);
      await until("the plan and the render running in backfill at once", () => running(root, "plan", "notes", LANE.backfill) && running(root, "render", "days", LANE.backfill));
      expect(home.stats().helpers).toEqual({ size: 3, busy: 2, ending: 0 });
      const resumed = Date.now();
      await askHome(sock, "resume", ["kind:extract"]);
      await until("the sitting's extract running live", () => running(root, "extract", "screen", LANE.live));
      const first = { waited_ms: Date.now() - resumed, helpers: home.stats().helpers };
      expect(first.helpers).toEqual({ size: 3, busy: 3, ending: 0 });
      expect(job(root, "extract", "notes")).toEqual({ state: "queued", lane: LANE.live });
      const runs = () => readHome(root, (db) => db.prepare("SELECT kind, subject, started_ms, ended_ms FROM runs WHERE id > ? AND kind IN ('extract', 'plan', 'render') ORDER BY id").all(mark)) as
        { kind: string; subject: string; started_ms: number; ended_ms: number | null }[];
      const opened = Date.now();
      rmSync(gates.render);
      await until("the note's extract run", () => runs().some((run) => run.kind === "extract" && run.subject === "notes" && run.started_ms >= opened));
      const second = runs().find((run) => run.kind === "extract" && run.subject === "notes" && run.started_ms >= opened)!;
      const ended = runs().filter((run) => (run.kind === "plan" || run.kind === "render") && run.started_ms < opened);
      expect(ended.map((run) => run.kind)).toEqual(["render"]);
      expect(running(root, "plan", "notes", LANE.backfill)).toBe(true);
      rmSync(gates.plan);
      rmSync(gates.screen);
      await until("everything done", () => quiet(root));
      expect(dayText(root, civilDay(t0 + MINUTE, UTC4))).toContain("a live note");
      expect(dayText(root, civilDay(old, UTC4))).toContain("a month-old note");
      artifact(root, "backfill-live", { first, second: { waited_ms: second.started_ms - opened, backfill_runs_ended: ended }, runs: runs() });
    } finally {
      await home.stop();
    }
  });
});

describe("a reply that lands before its pending enrichment row is written", () => {
  let root: string;
  let db: HomeDb;
  let due: Due;
  const look = () => db.commit((tx) => {
    due.watch(tx);
    due.after(tx);
  });
  const woken = () => readHome(root, (home) => home.prepare("SELECT unit FROM dirty_units WHERE family = 'notes' AND woken = 1 ORDER BY unit").pluck().all());
  const pending = (item: string, unit: string) => db.commit((tx) => {
    tx.tables.asks.put(owed(item, unit, null));
    due.after(tx);
  });

  beforeAll(() => {
    root = makeRoot("lifestream-derived-fast-reply-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
    const family = notesFamily();
    due = new Due({
      folder: openHomeFolder(root), settings: effective(root).settings, registry: { connectors: [], readers: [], families: [family], code: "test" },
      families: new Map([[family.name, family]]), now: () => Date.now(), running: () => undefined,
    });
  });

  afterAll(() => {
    due.close();
    db.close();
    removeRoot(root);
  });

  it("is never planned again while the home runs", () => {
    look();
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    answered(ledger, { key: "req-photo", family: "notes", unit: "photo:p1", at_ms: Date.now() });
    ledger.close();
    look();
    const plans = () => readHome(root, (home) => home.prepare("SELECT key, lane FROM jobs WHERE kind = 'plan' AND state = 'queued' ORDER BY key").all());
    expect(plans()).toEqual([]);
    pending("photo:p1", `${SOURCE}/2026-09-30`);
    const planned = plans();
    const units = readHome(root, (home) => home.prepare("SELECT family, unit, woken FROM dirty_units").all());
    expect(planned).toEqual([{ key: "notes", lane: LANE.live }]);
    expect(units).toEqual([{ family: "notes", unit: `${SOURCE}/2026-09-30`, woken: 1 }]);
    artifact(root, "fast-reply-planned", { planned, units });
  });

  it("a reply committed hours after its stamp wakes its unit", () => {
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    pending("photo:now", "unit-now");
    pending("photo:stalled", "unit-stalled");
    look();
    expect(woken()).toEqual([]);
    const now = Date.now();
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    answered(ledger, { key: "req-now", family: "notes", unit: "photo:now", at_ms: now });
    look();
    expect(woken()).toEqual(["unit-now"]);
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    answered(ledger, { key: "req-stalled", family: "notes", unit: "photo:stalled", at_ms: now - 6 * HOUR });
    ledger.close();
    look();
    expect(woken()).toEqual(["unit-stalled"]);
  });

  it("a reply committed after one stamped later wakes its unit too", () => {
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    pending("photo:later", "unit-later");
    pending("photo:earlier", "unit-earlier");
    look();
    const t = Date.now() + 10 * MINUTE;
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    answered(ledger, { key: "req-later", family: "notes", unit: "photo:later", at_ms: t + 10_000 });
    look();
    expect(woken()).toEqual(["unit-later"]);
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    answered(ledger, { key: "req-earlier", family: "notes", unit: "photo:earlier", at_ms: t });
    ledger.close();
    look();
    expect(woken()).toEqual(["unit-earlier"]);
    db.commit((tx) => tx.tables.dirty.clear("notes"));
    look();
    expect(woken()).toEqual([]);
  });
});

describe("plan jobs: one per family, in the lane its most urgent unit needs", () => {
  let root: string;
  let db: HomeDb;
  let due: Due | undefined;

  beforeAll(() => {
    root = makeRoot("lifestream-derived-plan-lanes-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    openLedger(openHomeFolder(root), { mode: "migrate" }).close();
  });

  afterAll(() => {
    due?.close();
    db.close();
    removeRoot(root);
  });

  it("a backlog of units makes a job row per unit, and a woken unit waits behind them", () => {
    const settings = effective(root).settings;
    const families = [notesFamily(), screen];
    const now = Date.now();
    const home = new Due({ folder: openHomeFolder(root), settings, registry: { connectors: [], readers: [], families, code: "test" }, families: new Map(families.map((family) => [family.name, family])), now: () => now, running: () => undefined });
    due = home;
    const look = () => db.commit((tx) => {
      home.watch(tx);
      home.after(tx);
    });
    const plans = () => readHome(root, (home) => home.prepare("SELECT key, lane, state, not_before_ms FROM jobs WHERE kind = 'plan' ORDER BY key").all()) as
      { key: string; lane: number; state: string; not_before_ms: number }[];
    const extract = (family: string, unit: string, end_ms: number | null) => ({
      family, unit, reading: `r-${unit}`, code: "1", content: { source: SOURCE, notes: [] }, start_ms: end_ms, end_ms, days: end_ms === null ? [] : [civilDay(end_ms, UTC4)], seq: 0,
    });
    db.commit((tx) => {
      for (let index = 0; index < 500; index++) tx.derived.extracts.put(extract("notes", `old-${String(index).padStart(3, "0")}`, now - 30 * DAY - index * HOUR));
      tx.derived.extracts.put(extract("screen", "sitting-1", now - HOUR));
    });
    look();
    const before = plans();
    expect(before.map(({ key, lane, state }) => ({ key, lane, state }))).toEqual([
      { key: "notes", lane: LANE.backfill, state: "queued" },
      { key: "screen", lane: LANE.planning, state: "queued" },
    ]);
    expect(count(root, "SELECT count(*) FROM dirty_units")).toBe(501);
    db.commit((tx) => {
      tx.tables.asks.put(owed("photo:old-250", "old-250", "req-old-250"));
    });
    const ledger = openLedger(openHomeFolder(root), { mode: "migrate" });
    answered(ledger, { key: "req-old-250", family: "notes", unit: "photo:old-250", at_ms: now });
    ledger.close();
    look();
    const after = plans();
    expect(after.find((job) => job.key === "notes")).toEqual({ ...before.find((job) => job.key === "notes"), lane: LANE.live });
    expect(after).toHaveLength(2);
    const taken = db.commit((tx) => tx.tables.dirty.next("notes", 3));
    expect(taken.map((each) => each.unit)).toEqual(["old-250", "old-000", "old-001"]);
    db.commit((tx) => tx.tables.dirty.units("notes", ["old-000"]));
    expect(db.commit((tx) => ["old-000", "old-001"].map((unit) => tx.tables.dirty.planned("notes", unit, 1, { reading: `r-${unit}`, code: "1" })))).toEqual([false, true]);
    expect(count(root, "SELECT count(*) FROM dirty_units WHERE family = 'notes'")).toBe(499);
    artifact(root, "plan-lanes", { before, after, taken });
  });
});
