import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { civilDay, openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { report as homeReport, unreadColumns } from "../packages/home/report.js";
import { change } from "../packages/home/settings.js";
import { artifact, makeRoot, removeRoot } from "../packages/home/test/harness-root.js";
import { LOG_BEHIND } from "../packages/home/status.js";
import { releaseFolder } from "../packages/home/test/fed.js";
import { sealDelivery } from "../packages/home/test/ops-support.js";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { Life, SIZES, PAGE_ROWS, HOUR_MS, TAKEOUT_PRODUCTS } from "./volume-life.js";
import { DayWatch, namesBadFile, runVolume, worseThan, type VolumeRun } from "./volume.js";

const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const OUT = join(tmpdir(), "volume-tiny");
let run: VolumeRun | undefined;

afterAll(() => {
  if (run !== undefined && !KEEP) rmSync(run.root, { recursive: true, force: true });
});

describe("the volume tool at --size tiny", () => {
  it("lands every synthetic delivery, fills every section of the report, and refuses the Takeout's bad file", async () => {
    run = await runVolume({ size: "tiny", seed: 1, out: OUT, keep: true });
    const { report } = run;
    const db = new Database(join(run.root, "home.db"), { readonly: true, fileMustExist: true });
    try {
      const deliveries = db.prepare("SELECT d.id, d.source, d.state, d.facts, r.counts FROM deliveries d LEFT JOIN runs r ON r.id = d.run").all() as
        { id: string; source: string; state: string; facts: string; counts: string | null }[];
      expect(new Set(deliveries.map((row) => row.id)).size).toBe(report.life.deliveries);
      expect(deliveries.filter((row) => row.state !== "imported")).toEqual([]);
      for (const row of deliveries.filter((row) => /^(whatsapp|imessage|chrome):/u.test(row.source))) {
        const facts = JSON.parse(row.facts);
        expect(facts.kind).toBe("changes");
        expect(facts).not.toHaveProperty("after");
        expect(facts).not.toHaveProperty("through");
      }
      const refused = (row: { counts: string | null }) => row.counts === null ? 0 : (JSON.parse(row.counts) as { refused?: number }).refused ?? 0;
      expect(deliveries.filter((row) => refused(row) !== (row.source.endsWith(":export") ? 1 : 0)).map((row) => row.id)).toEqual([]);
    } finally {
      db.close();
    }

    const home = report.report;
    expect(Object.keys(home).sort()).toEqual(["columns", "disk", "families", "health", "home", "imports", "live", "log", "phones", "reads", "sweep", "window"]);
    expect(home.columns).toEqual({ whatsapp: { ZWAMESSAGE: ["ZSYNTHETICLATER"] } });
    expect(home.home.statements).toBeGreaterThan(0);
    expect(Object.keys(home.imports)).toEqual(expect.arrayContaining(["whatsapp", "imessage", "chrome", "screen", "claude-code", "location", "motion", "apple-health", "apple-photos", "upload"]));
    expect(Object.values(home.live).some((product) => product.shown > 0)).toBe(true);
    expect(home.families.by_family.messages?.extract?.runs).toBeGreaterThan(0);
    expect(home.families.render.days).toBeGreaterThan(0);
    expect(Object.keys(home.reads.routes)).toEqual(expect.arrayContaining(["GET /v1/status", "PUT /v1/acquisitions/*", "PUT /v1/bundles/*"]));
    expect(home.log.largest_bytes).toBeGreaterThan(0);
    expect(home.disk.free_bytes).toBeGreaterThan(0);
    expect(home.disk.bytes["home.db"]).toBeGreaterThan(0);
    expect(home.health.starts).toBe(4);
    expect(home.sweep).not.toBeNull();
    expect(JSON.stringify(home)).not.toMatch(/person-a@example\.com|\+1555|macbook-pro-0001|\/Users\/|\/private\/|\/var\/|\/tmp\//u);

    const { scenarios } = report;
    expect(Object.keys(scenarios.first_day.sources)).toEqual(expect.arrayContaining(["whatsapp", "location"]));
    expect(scenarios.first_day.sources.location).toMatchObject({ rendered_seconds: null });
    expect(scenarios.live.deliveries).toBe(9);
    expect(scenarios.live.observed).toBe(scenarios.live.imports);
    expect(Object.keys(scenarios.live.sent_to_observed_seconds)).toEqual(["screen", "whatsapp"]);
    expect(scenarios.reads.requests).toBeGreaterThan(0);
    expect(scenarios.rebuild.every_day.days_rendered).toBeGreaterThan(0);
    expect(scenarios.interrupted.killed).toBe(true);
    expect(scenarios.interrupted.landed_before_kill).toBeGreaterThan(0);
    expect(scenarios.interrupted.duplicated).toBeGreaterThan(0);

    for (const product of TAKEOUT_PRODUCTS) {
      const entry = scenarios.takeout[product]!;
      expect(entry).toMatchObject({ state: "imported" });
      expect(entry.rows).toBeGreaterThan(0);
      expect(namesBadFile(entry)).toBe(true);
    }

    expect(readFileSync(run.md, "utf8")).toContain("# Volume report: tiny");
    const changed = structuredClone(report);
    changed.report.disk.free_bytes *= 2;
    changed.report.disk.bytes.search! *= 2;
    changed.report.disk.bytes["replies.db"]! *= 2;
    expect(worseThan(report, changed).map((row) => row.path)).toEqual(["report.disk.bytes.replies.db", "report.disk.bytes.search"]);
    changed.report.disk.free_bytes = home.disk.free_bytes / 2;
    expect(worseThan(report, changed).map((row) => row.path)).toContain("report.disk.free_bytes");
  });
});


describe("report reads on a synthetic home", () => {
  it("clips holds at both edges, sums the drains of its window, and skips non-databases before materialising", async () => {
    const source = "whatsapp:+15550000001:mac-0001";
    const root = makeRoot("report-window-", { sources: { [source]: "whatsapp-db" } });
    const db = openHome(openHomeFolder(root), "migrate");
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    try {
      const bytes = Buffer.from("synthetic non-database".repeat(100));
      const hash = blobs.put(bytes, { mediaType: "text/plain" });
      sealDelivery(root, source, "non-database", { "notes.txt": bytes });
      db.commit((tx) => {
        tx.tables.deliveries.add({ id: `${source}/non-database`, source, stated_ms: 1, sealed_ms: 1, facts: {} });
        for (const [at_ms, key] of [[10, "start"], [30, "end"], [40, "start"]] as const) {
          tx.tables.events.append({ at_ms, kind: LOG_BEHIND, key });
        }
        for (const [at_ms, key, ms] of [[15, "emptied", 5], [35, "outside", 20], [45, "outlasted", 7]] as const) {
          tx.tables.events.append({ at_ms, kind: "log-drain", key, detail: { ms, frames: 300_000, jobs: key === "outlasted" ? 1 : 0 } });
        }
      });
      const materialised: string[] = [];
      const materialise = blobs.materialise.bind(blobs);
      blobs.materialise = async (hash) => { materialised.push(hash); return materialise(hash); };
      const columns = await unreadColumns(openHomeFolder(root), blobs, () => releaseFolder("messages/whatsapp").readers[0]);
      expect(columns).toEqual({});
      expect(materialised).not.toContain(hash);
      const log = join(root, "synthetic-private-door.log");
      writeFileSync(log, "");
      const whole = await homeReport(openHomeFolder(root), { from_ms: 0, to_ms: 50, door_log: log });
      const clipped = await homeReport(openHomeFolder(root), { from_ms: 20, to_ms: 50, door_log: log });
      const spanning = await homeReport(openHomeFolder(root), { from_ms: 41, to_ms: 50, door_log: log });
      expect([whole.log.behind, clipped.log.behind, spanning.log.behind]).toEqual([2, 2, 1]);
      expect([whole.log.behind_now, clipped.log.behind_now, spanning.log.behind_now]).toEqual([true, true, true]);
      expect(clipped.log.behind_ms / whole.log.behind_ms).toBe(2 / 3);
      expect(clipped.log.longest_behind_ms / whole.log.longest_behind_ms).toBe(1 / 2);
      expect(whole.log).toMatchObject({ drains: 3, emptied: 1, outside: 1, outlasted: 1, drained_ms: 32, longest_drain_ms: 20 });
      expect(clipped.log).toMatchObject({ drains: 2, emptied: 0, outside: 1, outlasted: 1, drained_ms: 27, longest_drain_ms: 20 });
      expect(whole.reads.log).toBe("door.log");
      change(root, "connectors.gmail", { folders: 10 });
      const misshapen = await homeReport(openHomeFolder(root), { from_ms: 20, to_ms: 50, door_log: log });
      expect([misshapen.columns, misshapen.columns_error]).toEqual([{}, undefined]);
      artifact(root, "report-window", { whole, clipped, spanning, misshapen, materialised });
    } finally {
      db.close();
      removeRoot(root);
    }
  });

  it("ships a small screen spool live and splits a backlog at the previous UTC hour", () => {
    const now = Date.UTC(2026, 9, 6, 12, 30);
    const small = new Life(SIZES.tiny, 1, now);
    expect(small.pages(["screen"]).every((page) => !page.history)).toBe(true);
    const large = new Life({ ...SIZES.tiny, full: { ...SIZES.tiny.full, screen: PAGE_ROWS + 1 } }, 1, now);
    const pages = large.pages(["screen"]);
    const cut = Math.floor(now / HOUR_MS) * HOUR_MS - HOUR_MS;
    expect(pages[0]).toMatchObject({ from_ms: cut, history: false });
    expect(pages.slice(1).every((page) => page.history && page.to_ms <= cut)).toBe(true);
    expect(pages.slice(1).map((page) => page.from_ms)).toEqual(pages.slice(1).map((page) => page.from_ms).sort((a, b) => a - b));
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, "screen-pages.json"), JSON.stringify({ small: small.pages(["screen"]), backlog: pages }));
  });
});

it("counts what the day files hold as the home left them, timed by the home's day events", () => {
  const root = makeRoot("volume-days-", { sources: {} });
  const watch = new DayWatch(root);
  try {
    const now = Date.now();
    const yesterday = now - 24 * HOUR_MS;
    const sent = now - 1_000;
    const days = [yesterday, now].map((at) => civilDay(at, { zone: "UTC", day_start_hour: 4 }));
    const today = days[1]!;
    const source = "location:person-a@example.com:phone-0001";
    const written = new Map<string, number>();
    const write = (day: string, inputs: string, at_ms: number, keys: string[]) => {
      writeFileSync(join(root, "days", `${day}.day.json`), JSON.stringify({ inputs, coverage: [{ family: "physical", sources: [{ source, read: "into" }] }],
        atoms: keys.map((key) => ({ family: "messages", end_ms: null, record: { key: `whatsapp:${key}` } })) }));
      written.set(`${day} ${inputs}`, at_ms);
    };
    mkdirSync(join(root, "days"), { recursive: true });
    write(today, "today-1", now - 500, ["message-a"]);
    write(days[0]!, "yesterday-1", now - 400, ["message-y"]);
    write(today, "today-2", now + 200, ["message-a", "message-b"]);
    write(today, "today-3", now + 300, ["message-a", "message-b", "message-c"]);
    watch.stop();
    const tick = (day: string, shows: Record<string, unknown>) =>
      ({ id: day, products: Object.keys(shows), what: "tick" as const, rows: 1, by: {}, bytes: 1, sent_ms: sent, shows: shows as never });
    const recorded = { written: (day: string, inputs: string) => written.get(`${day} ${inputs}`) ?? null };
    const observed = {
      yesterday: watch.shown(tick(days[0]!, { whatsapp: { day: days[0], messages: ["message-y"] } }), "whatsapp", recorded),
      replaced: watch.shown(tick(today, { whatsapp: { day: today, messages: ["message-b"] } }), "whatsapp", recorded),
      latest: watch.shown(tick(today, { whatsapp: { day: today, messages: ["message-c"] } }), "whatsapp", recorded),
      never: watch.shown(tick(today, { whatsapp: { day: today, messages: ["message-z"] } }), "whatsapp", recorded),
      phone: watch.shown(tick(today, {}), "location", recorded),
    };
    expect(observed).toEqual({ yesterday: now - 400, replaced: now + 300, latest: now + 300, never: null, phone: null });
    artifact(root, "volume-days", observed);
  } finally {
    watch.stop();
    removeRoot(root);
  }
});

it("exits after a scenario rejects with its day watcher running", async () => {
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type", "module", "-e", `
    import { runVolume } from ${JSON.stringify(new URL("./volume.ts", import.meta.url).href)};
    try {
      await runVolume({ size: "tiny", seed: 1, out: ${JSON.stringify(join(OUT, "failed"))},
        log(line) { if (line.startsWith("first day settled:")) throw new Error("synthetic scenario failure"); } });
      process.exitCode = 1;
    } catch (error) {
      if (error.message !== "synthetic scenario failure") throw error;
      process.stdout.write("scenario rejected and cleaned up\\n");
    }
  `], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } });
  onTestFinished(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  child.stderr.on("data", (bytes: Buffer) => { output += bytes.toString(); });
  const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  expect(code, output).toBe(0);
  expect(output).toContain("scenario rejected and cleaned up");
  writeFileSync(join(OUT, "failed-scenario.txt"), output);
});
