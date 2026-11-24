import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { civilDay, dayBounds, heldOf, type JsonObject, openHomeFolder, spansOf } from "@lifestreamprotocol/core";
import type { StreamsReport } from "./streams-report.js";
import { dayPath } from "./derive.js";
import { startHome } from "./home.js";
import { ORDERED_ROWS } from "./import.js";
import { basicInstant, openSealing } from "./inbox.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { ask, askHome } from "./socket.js";
import { FAKES, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { streamsOf } from "./test/harness-status.js";
import { testSocket } from "./test/folder.js";

const MINUTE = 60_000;
const DAY = 86_400_000;
const GMAIL = "gmail:person-a@example.com:cloud";
const WHOOP = "whoop:user-0001:cloud";
const MAC = "macbook-pro-0001";
const NOTES = `apple-notes:local:${MAC}`;
const MACHINE = `machine:local:${MAC}`;
const EMPTY = "gmail:person-b@example.com:cloud";

const note = (key: string, at: number, text = `synthetic ${key}`) => ({ kind: "note", key, content: { text, at }, at });
const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
const state = (root: string, id: string): string => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string;

const heldIn = (report: StreamsReport, id: string): number | null => report.connectors.flatMap((connector) => connector.copies).find((copy) => copy.id === id)!.held;
const historyOf = (report: StreamsReport, id: string) => report.connectors.find((connector) => connector.copies.some((copy) => copy.id === id))!.history;
const live = (root: string, source: string): number => count(root, "SELECT count(*) FROM heads WHERE source = ? AND version <> 'gone'", source);

describe("the past, arriving", () => {
  const roots: string[] = [];
  const summary: JsonObject = {};

  afterAll(() => {
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "arriving.json"), `${JSON.stringify(summary, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });

  it("states a source's count and work left as its deliveries import", async () => {
    const root = makeRoot("lifestream-arriving-", { sources: { [GMAIL]: "fake-rows", [WHOOP]: "fake-rows" } });
    roots.push(root);
    const begun = Date.now();
    let clock = begun;
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined, clock: () => clock });
    const hold = join(root, "import-hold");
    const report = async () => streamsOf(root);
    const lines: JsonObject = {};
    try {
      const first = [note("m1", begun - 30 * MINUTE), note("m2", begun - 20 * MINUTE), note("m3", begun - 10 * MINUTE)];
      const d1 = await ship(root, { source: GMAIL, fetched_ms: begun - 1_000, rows: first });
      await until("the first delivery imported", () => state(root, d1) === "imported");
      const fresh = await report();
      lines.fresh = { gmail: heldIn(fresh, GMAIL), whoop: heldIn(fresh, WHOOP) };
      expect(lines.fresh).toEqual({ gmail: 3, whoop: 0 });
      clock = begun + 2 * MINUTE;

      writeFileSync(hold, "");
      const backlog = Array.from({ length: 2_500 }, (_, index) => note(`b${index}`, begun - 400 * DAY + index * DAY / 10));
      const newer = [note("late-1", begun - 3 * DAY), note("late-2", begun - 2 * DAY)];
      const d2 = await ship(root, { source: GMAIL, fetched_ms: clock - 1_000, rows: [...backlog, { hold } as never, ...newer], facts: { left: 120 } });
      await until("the backlog's first chunk landed, its read held", () =>
        count(root, "SELECT count(*) FROM heads WHERE source = ?", GMAIL) > 3 && readHome(root, (db) => db.prepare("SELECT 1 FROM jobs WHERE kind = 'import' AND key = ? AND progress IS NOT NULL").get(GMAIL)) !== undefined);
      const landedSoFar = count(root, "SELECT count(*) FROM heads WHERE source = ?", GMAIL);
      const midway = heldIn(await report(), GMAIL)!;
      lines.midway = midway;
      expect(state(root, d2)).toBe("importing");
      expect(midway).toBeGreaterThanOrEqual(landedSoFar);
      expect(midway).toBeLessThan(3 + backlog.length + newer.length);

      rmSync(hold);
      await until("the backlog imported", () => state(root, d2) === "imported");
      const whole = heldIn(await report(), GMAIL);
      lines.whole = whole;
      expect(whole).toBe(3 + backlog.length + newer.length);

      const d3 = await ship(root, { source: GMAIL, fetched_ms: clock - 500, rows: [...first, note("m4", begun - 5 * MINUTE)] });
      await until("the third delivery imported", () => state(root, d3) === "imported");
      const again = heldIn(await report(), GMAIL);
      lines.again = again;
      expect(again).toBe(3 + backlog.length + newer.length + 1);

      clock = begun + 22 * MINUTE;
      const quiet = heldIn(await report(), GMAIL)!;
      lines.quiet = quiet;
      expect(quiet).toBe(3 + backlog.length + newer.length + 1);

      const failing = join(root, "failing");
      writeFileSync(failing, "");
      writeFileSync(hold, "");
      const broken = Array.from({ length: 2_500 }, (_, index) => note(`f${index}`, begun - 600 * DAY + index * MINUTE));
      const d4 = await ship(root, { source: GMAIL, fetched_ms: clock - 100, rows: [...broken, { hold } as never, { fault_if: failing } as never] });
      const failedLanded = () => count(root, "SELECT count(*) FROM heads WHERE source = ? AND key LIKE 'f%'", GMAIL);
      await until("the failing delivery's first chunk landed", () => failedLanded() > 0);
      rmSync(hold);
      const failures = () => count(root, "SELECT count(*) FROM events WHERE kind = 'import-failed' AND key = ?", d4);
      for (let tries = 1; tries <= 5; tries++) {
        await until(`import failure ${tries}`, () => failures() === tries);
        clock += 31 * MINUTE;
      }
      const job = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(GMAIL)) as string | undefined;
      await until("the import dead", () => job() === "dead");
      const dead = heldIn(await report(), GMAIL);
      lines.dead = dead;
      const given = failedLanded();
      expect(dead).toBe(quiet + given);
      const failedRun = readHome(root, (db) => db.prepare("SELECT run FROM deliveries WHERE id = ?").pluck().get(d4)) as number;
      const runCounts = () => readHome(root, (db) => db.prepare("SELECT json_extract(counts, '$.new') FROM runs WHERE id = ?").pluck().get(failedRun)) as number | null;
      expect(runCounts()).toBeNull();
      await askHome(testSocket(root), "drop", ["job", "import", GMAIL]);
      const readBy = readHome(root, (db) => db.prepare("SELECT read_by FROM deliveries WHERE id = ?").pluck().get(d4)) as string | null;
      const runsOf = readHome(root, (db) => db.prepare("SELECT id FROM runs WHERE kind = 'import' AND subject = ?").pluck().all(`${GMAIL} ${d4}`)) as number[];
      expect([state(root, d4), job(), readBy !== null, runCounts(), runsOf]).toEqual(["dead", "done", true, given, [failedRun]]);
      const skipped = heldIn(await report(), GMAIL);
      lines.skipped = skipped;
      expect(skipped).toBe(quiet + given);
      expect([skipped, heldIn(await report(), WHOOP)]).toEqual([live(root, GMAIL), live(root, WHOOP)]);
      const tallies = readHome(root, (db) => {
        const truth = db.prepare("SELECT source, count(*) AS records FROM heads WHERE version <> 'gone' GROUP BY source ORDER BY source").all() as { source: string; records: number }[];
        const spans = spansOf(db);
        return { held: truth.map(({ source }) => ({ source, records: heldOf(spans.get(source) ?? []) })), truth };
      });
      expect(tallies.held).toEqual(tallies.truth);
      summary.tallies = tallies as never;
      summary.lines = lines;
    } finally {
      rmSync(hold, { force: true });
      rmSync(join(root, "failing"), { force: true });
      await home.stop();
    }
  });

  it("writes today's day file at a Mac's first delivery, before any family has a line of it; a sensor and an empty store state no past to come", async () => {
    const root = makeRoot("lifestream-arriving-first-", { sources: { [NOTES]: "fake-rows", [MACHINE]: "machine-events", [EMPTY]: "fake-rows"} });
    roots.push(root);
    const { day } = effective(root).settings;
    const begun = Date.now();
    let clock = begun;
    const todayDay = civilDay(begun, day);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined, clock: () => clock });
    const report = async () => streamsOf(root);
    const written = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'day' AND key = ?").pluck().get(todayDay)) as number;
    try {
      const first = await ship(root, { source: NOTES, fetched_ms: begun - 1_000, rows: [{ kind: "contact", key: "c1", content: { card: "BEGIN:VCARD\nFN:Person A\nEND:VCARD" } }] });
      await until("today's day file written", () => written() > 0);
      expect(state(root, first)).toBe("imported");
      const file = JSON.parse(readFileSync(dayPath(root, todayDay, "json"), "utf8")) as { day: string; counts: { total: number } };
      expect(file).toMatchObject({ day: todayDay, counts: { total: 0 } });

      const events = [begun - 50_000, begun - 40_000].map((at) => `{"at":"${new Date(at).toISOString()}","event":"wake","detail":{}}`).join("\n");
      const machine = await shipFiles(root, MACHINE, begun - 500, { [`${new Date(begun - 50_000).toISOString()}.jsonl`]: Buffer.from(`${events}\n`) });
      const nothing = await ship(root, { source: EMPTY, fetched_ms: begun - 400, rows: [] });
      await until("the machine's events and the mailbox's delivery imported", () => state(root, machine) === "imported" && state(root, nothing) === "imported");
      clock = begun + 2 * MINUTE;
      const after = await report();
      const sensor = { held: heldIn(after, MACHINE), history: historyOf(after, MACHINE) };
      const empty = heldIn(after, EMPTY);
      expect(sensor).toEqual({ held: 2, history: null });
      expect(empty).toBe(0);
      summary.first_delivery = { day_file: dayPath(root, todayDay, "json").slice(root.length + 1), renders: written(), sensor: JSON.parse(JSON.stringify(sensor)) as JsonObject, empty };
    } finally {
      await home.stop();
    }
  });

  it("lands a Mac's delivery today first, then newest first, and writes today's day file while the Mac's past waits", async () => {
    const root = makeRoot("lifestream-arriving-today-", { sources: { [NOTES]: "fake-rows" } });
    roots.push(root);
    const principals = openHomeFolder(root);
    const { principal: mac } = mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [NOTES], now_ms: 0 });
    const { day } = effective(root).settings;
    const now = Date.now();
    const today = dayBounds(civilDay(now, day), day);
    const todayDay = civilDay(now, day);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    const hold = join(root, "page-hold");
    writeFileSync(hold, "");

    const shipMac = async (fetched_ms: number, rows: JsonObject[], facts: JsonObject = {}): Promise<string> => {
      const fetched_at = new Date(fetched_ms).toISOString();
      const name = basicInstant(fetched_at);
      const sealing = openSealing(openHomeFolder(root), { source: NOTES, name, feeder: "fake-rows", fetched_at });
      await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`); })());
      sealing.seal(facts, undefined, { pass: mac.id, sealed_at: fetched_at });
      const id = `${NOTES}/${name}`;
      await ask(testSocket(root), { verb: "sealed", delivery: id });
      return id;
    };

    try {
      const past = Array.from({ length: 6 }, (_, index) => note(`day-${6 - index}`, today.start_ms - (6 - index) * DAY + MINUTE));
      const rows = [
        ...past.slice(0, 2),
        note("twice", today.start_ms - 5 * DAY, "the old row"),
        ...past.slice(2),
        { kind: "contact", key: "c1", content: { card: "BEGIN:VCARD\nFN:Person A\nEND:VCARD" } },
        note("today-1", today.start_ms + 1),
        note("twice", today.start_ms + 2, "today's row"),
        note("today-2", today.start_ms + 3),
      ];
      const live = await shipMac(now - 2_000, rows);
      const page = await shipMac(now - 1_000, Array.from({ length: 10 }, (_, index) => note(`page-${9 - index}`, today.start_ms - (39 - index) * DAY)), { history: true, hold });

      await until("today's day file written", () => readHome(root, (db) => db.prepare("SELECT 1 FROM events WHERE kind = 'day' AND key = ?").get(todayDay)) !== undefined);
      expect(state(root, page)).not.toBe("imported");
      expect(state(root, live)).toBe("imported");
      const run = readHome(root, (db) => db.prepare("SELECT run FROM deliveries WHERE id = ?").pluck().get(live)) as number;
      const landed = readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE run = ? ORDER BY seq").pluck().all(run)) as string[];
      expect(landed).toEqual(["c1", "today-2", "twice", "today-1", "day-1", "day-2", "day-3", "day-4", "day-5", "day-6"]);
      const twice = readHome(root, (db) => db.prepare("SELECT json_extract(v.text, '$.content.text') FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.key = 'twice'").pluck().get(NOTES));
      expect(twice).toBe("today's row");

      rmSync(hold);
      await until("the page imported", () => state(root, page) === "imported");
      const order = readHome(root, (db) => db.prepare("SELECT seq, kind, key FROM events WHERE (kind = 'day' AND key = ?) OR (kind = 'import' AND key = ?) ORDER BY seq").all(todayDay, page)) as { seq: number; kind: string; key: string }[];
      expect(order[0]).toMatchObject({ kind: "day", key: todayDay });
      expect(order.some((event) => event.kind === "import")).toBe(true);
      const pageRun = readHome(root, (db) => db.prepare("SELECT run FROM deliveries WHERE id = ?").pluck().get(page)) as number;
      const paged = readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE run = ? ORDER BY seq").pluck().all(pageRun)) as string[];
      expect(paged).toEqual(Array.from({ length: 10 }, (_, index) => `page-${index}`));
      summary.today_first = { live: landed, page: paged, events: order, day_file: dayPath(root, todayDay, "json").slice(root.length + 1) };

      const first = join(root, "first-hold");
      const again = join(root, "again-hold");
      writeFileSync(first, "");
      writeFileSync(again, "");
      const big = await shipMac(now, [], { generate: { count: ORDERED_ROWS + 1, start_ms: today.start_ms - (ORDERED_ROWS - 2) * MINUTE, step_ms: MINUTE, prefix: "big", hold: first, again } });
      const bigLanded = () => count(root, "SELECT count(*) FROM heads WHERE source = ? AND key LIKE 'big-%'", NOTES);
      await until("the big delivery's first read whole, held", () => existsSync(`${first}.held`));
      expect(bigLanded()).toBe(0);
      rmSync(first);
      await until("the second read at its end, held, its chunks landed", () => existsSync(`${again}.held`) && bigLanded() >= 3 + 14 * 2_000);
      const progress = readHome(root, (db) => JSON.parse(db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(NOTES) as string)) as { newest_first: boolean };
      const bigRun = readHome(root, (db) => db.prepare("SELECT run FROM deliveries WHERE id = ?").pluck().get(big)) as number;
      const firstLanded = readHome(root, (db) => db.prepare("SELECT key FROM statements WHERE run = ? ORDER BY seq LIMIT 4").pluck().all(bigRun)) as string[];
      expect([state(root, big), progress.newest_first, firstLanded]).toEqual(["importing", false, ["big-30000", "big-29999", "big-29998", "big-0"]]);
      rmSync(again);
      await until("the big delivery imported", () => state(root, big) === "imported");
      const statedOnce = count(root, "SELECT count(*) FROM statements WHERE run = ?", bigRun);
      expect(statedOnce).toBe(ORDERED_ROWS + 1);
      summary.past_the_bound = { rows: ORDERED_ROWS + 1, newest_first: progress.newest_first, first_landed: firstLanded, statements: statedOnce };
    } finally {
      for (const path of [hold, join(root, "first-hold"), join(root, "again-hold")]) rmSync(path, { force: true });
      await home.stop();
    }
  });
});
