import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { civilDay, dayBounds, emptyLanded, openHome, openHomeFolder, tryLock, type ReaderOutput } from "@lifestreamprotocol/core";
import type { Registry } from "./registry.js";
import { openLedger } from "@lifestreamprotocol/model";
import { runCli } from "./cli.js";
import { connectors, readers } from "./registry-home.js";
import { startHome } from "./home.js";
import type { StatusReport } from "./status.js";
import type { StreamsReport } from "./streams-report.js";
import { launchd } from "./release.js";
import { FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { homeWithDoor, startHere } from "./test/harness-home.js";
import { askHome } from "./socket.js";
import { stagedFile } from "./ask-files.js";
import { readReport, REPORT_FILE, SHOT_FILE } from "./feedback.js";
import { keptReport } from "./test/feedback-worker.js";
import { reach } from "./test/support.js";
import { testSocket } from "./test/folder.js";
import {
  answered, context, DAY, HOUR, land, messages, openTestHome, photos, recordsOf, removeDir, sealDelivery, SETTINGS, sha256, T0, tempDir,
  writeArtifact, writeFolder, type TestHome,
} from "./test/ops-support.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const NOTES = "apple-notes:local:device-a";
const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()!();
});

function home(name: string): TestHome {
  const root = tempDir(name);
  const opened = openTestHome(root);
  writeFolder(root);
  cleanup.push(() => removeDir(root), () => opened.close());
  return opened;
}

function releases(root: string) {
  const dir = join(root, "..", `${root.split("/").at(-1)}-releases`);
  cleanup.push(() => removeDir(dir));
  return { dir, init: launchd({ launchctl: () => ({ status: 113, stdout: "", stderr: "" }) }) };
}

async function cli(root: string, args: string[], registry: Registry = { families: [messages, photos], connectors: connectors(), readers: [] }, extra: { waitMs?: number; startingMs?: number } = {}) {
  const lines: string[] = [];
  const going: string[] = [];
  const status = await runCli([...args, "--root", root], { write: (text) => lines.push(text), going: (text) => going.push(text), registry: { code: "code-test", ...registry }, now: () => T0 + 2 * DAY, releases: releases(root), ...extra });
  const last = lines.join("").trim().split("\n").at(-1) ?? "";
  let result: Record<string, unknown> | undefined;
  try {
    result = JSON.parse(last) as Record<string, unknown>;
  } catch {
    result = undefined;
  }
  return { status, lines, going, result };
}

function message(key: string, extra: Record<string, unknown> = {}, blobs?: string[]): ReaderOutput {
  return { kind: "msg", key, content: { chat: "c1", date: "2026-09-01", text: `synthetic message ${key}`, ZMESSAGEDATE: 800_000_000, ...extra }, ...(blobs === undefined ? {} : { blobs }) };
}

function raw(root: string): Database.Database {
  const db = new Database(join(root, "home.db"), { readonly: true });
  cleanup.push(() => db.close());
  return db;
}

describe("operator verbs", () => {
  it("the report leaves out the units whose extract threw, or counts them as the plan's", async () => {
    const test = home("report-aside");
    test.db.commit((tx) => {
      tx.derived.extracts.aside.put("photos", "burst-1", "a build that threw", T0);
      tx.derived.extracts.aside.put("photos", "burst-2", "a build that threw", T0);
      tx.derived.extracts.aside.put("messages", "thread-1", "a build that threw", T0);
    });
    const { result } = await cli(test.root, ["report"]);
    expect((result as unknown as { health: { set_aside_extracts: unknown; set_aside_units: unknown } }).health).toMatchObject({ set_aside_extracts: { messages: 1, photos: 2 }, set_aside_units: {} });
  });

  it("a day that has not started is rendered before it starts, or a day marked again mid-render leaves the queue", () => {
    const test = home("day-start");
    const today = "2026-09-01";
    const tomorrow = "2026-09-02";
    const start = dayBounds(tomorrow, SETTINGS.day).start_ms;
    const civil = (ms: number) => civilDay(ms, SETTINGS.day);
    test.db.commit((tx) => tx.tables.dirty.days([today, tomorrow, "2026-08-20"]));
    const taken = (now: number, since?: string) => test.db.commit((tx) => tx.tables.dirty.nextDays(10, civil(now), since).map((row) => row.day));
    expect(taken(T0)).toEqual([today, "2026-08-20"]);
    expect(taken(T0, civil(T0 - 2 * DAY))).toEqual([today]);
    expect(test.db.commit((tx) => tx.tables.dirty.newestDay(civil(T0)))).toBe(today);
    expect(taken(start)).toEqual([tomorrow, today, "2026-08-20"]);
    const marks = test.db.commit((tx) => Object.fromEntries(tx.tables.dirty.nextDays(10, civil(start)).map((row) => [row.day, row.marks])));
    test.db.commit((tx) => tx.tables.dirty.days([today]));
    expect(test.db.commit((tx) => [tx.tables.dirty.rendered(today, marks[today]!, true), tx.tables.dirty.rendered(tomorrow, marks[tomorrow]!, true)])).toEqual([false, true]);
    expect(taken(start)).toEqual([today, "2026-08-20"]);
    writeArtifact("day-start.json", { today, tomorrow, start, marks, left: taken(start) });
  });

  it("an erasure with the home down rewrites a queued report that carried the thing: its answer, its screenshot and the staged copy go; a report it cannot read is named in its output", async () => {
    const test = home("erase-feedback");
    const mac = "imessage:local:mac-0001";
    land(test.db, { source: mac, stated_ms: T0, name: "d1", rows: [message("3EB0-K")] });
    openLedger(openHomeFolder(test.root), { mode: "migrate" }).close();
    const folder = openHomeFolder(test.root);
    const [id, unread] = ["3f2b8c1e-5d4a-4b6c-9e7f-0a1b2c3d4e5f", "7a6b5c4d-3e2f-4a1b-8c9d-0e1f2a3b4c5d"];
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9]);
    const hash = `sha256:${sha256(bytes)}`;
    stagedFile(folder, hash).write(bytes);
    keptReport(folder, id, T0, [{ source: mac, kind: "msg", key: "3EB0-K" }], { shot: { hash, width: 8, height: 8 }, bytes });
    folder.file(REPORT_FILE, join(test.root, "feedback", unread, "report.json")).write(Buffer.from("not json"));

    const erased = await cli(test.root, ["erase", "messages", "3EB0-K", "--apply"]);
    expect(erased.status, erased.lines.join("")).toBe(0);
    expect(readReport(folder, id)).toMatchObject({ state: "queued", refs: [], screenshot: null, attachments: [{ kind: "app" }] });
    expect(folder.file(SHOT_FILE, join(test.root, "feedback", id, "screenshot.jpg")).exists()).toBe(false);
    expect(stagedFile(folder, hash).exists()).toBe(false);
    expect(erased.result).toMatchObject({ applied: true });
    expect(erased.going.join("")).toContain(`"feedback":"unread","id":"${unread}"`);
  });

  it("an erasure leaves a replica record, an enrichment or a ledger row quoting the thing", async () => {
    const test = home("erase");
    const thing = (key: string) => ({ source: "", kind: "msg", key });
    const photo = Buffer.from("synthetic photo bytes for message K");
    const snapshot = Buffer.from("synthetic chat database snapshot");
    const hash = test.blobs.put(photo, { mediaType: "image/jpeg" });
    const snapshotHash = test.blobs.put(snapshot, { mediaType: "application/vnd.sqlite3" });
    const mac = "imessage:local:mac-0001";
    const phone = "imessage:local:iphone-aa01";
    land(test.db, { source: mac, stated_ms: T0, name: "d1", rows: [message("3EB0-K", { image: hash }, [hash]), message("3EB0-L")] });
    land(test.db, { source: phone, stated_ms: T0 + HOUR, name: "d2", rows: [message("3EB0-K", { image: hash, read: true }, [hash]), message("3EB0-L")] });
    sealDelivery(test.root, mac, "d1", { "media/photo.jpg": photo, "chat.db": snapshot });
    sealDelivery(test.root, phone, "d2", { "chat.db": Buffer.from("synthetic phone snapshot") });
    mkdirSync(join(test.root, "inbox", phone, "blobs"), { recursive: true });
    writeFileSync(join(test.root, "inbox", phone, "blobs", sha256(photo)), photo);
    test.db.commit((tx) => {
      tx.derived.extracts.put({ family: "messages", unit: "c1/2026-09-01", reading: "r", code: "1", content: { images: ["3EB0-K"] }, start_ms: T0, end_ms: T0, days: ["2026-09-01"], seq: 0 });
      for (const item of ["3EB0-K", "3EB0-L"]) {
        tx.derived.enrichments.put({ family: "messages", item, prompt: "chat-image", input_hash: sha256(item), reply_key: `req-${item}`, reused_from: null, content: { caption: "synthetic" }, state: "done" });
      }
    });
    mkdirSync(join(test.root, "days"), { recursive: true });
    for (const suffix of [".day.json", ".day.txt", ".day.lines.json"]) writeFileSync(join(test.root, "days", `2026-09-01${suffix}`), "synthetic message 3EB0-K\n");
    const ledger = openLedger(openHomeFolder(test.root), { mode: "migrate" });
    answered(ledger, { key: "req-3EB0-K", family: "messages", unit: "3EB0-K", at_ms: T0, attachment: photo });
    answered(ledger, { key: "req-3EB0-L", family: "messages", unit: "3EB0-L", at_ms: T0 });
    ledger.close();

    const planned = await cli(test.root, ["erase", "messages", "3EB0-K", "--reason", "the owner deleted it"]);
    expect(planned.result).toMatchObject({
      applied: false, records: [{ ...thing("3EB0-K"), source: phone }, { ...thing("3EB0-K"), source: mac }], items: ["3EB0-K"], units: [{ family: "messages", unit: "c1/2026-09-01" }],
    });
    expect(raw(test.root).prepare("SELECT count(*) FROM statements WHERE key = '3EB0-K'").pluck().get()).toBe(2);
    expect(test.blobs.has(hash)).toBe(true);
    const erased = await cli(test.root, ["erase", "messages", "3EB0-K", "--reason", "the owner deleted it", "--apply"]);
    expect(erased.status, erased.lines.join("")).toBe(0);
    expect(erased.result).toMatchObject({ records: 2, enrichments: 1, units: 1, days: ["2026-09-01"], inbox_files: 2 });

    const db = raw(test.root);
    for (const table of ["statements", "heads", "versions", "erasures"]) {
      const count = (key: string) => db.prepare(`SELECT count(*) FROM ${table} WHERE key = ?`).pluck().get(key);
      expect(count("3EB0-K"), table).toBe(table === "erasures" ? 1 : 0);
      expect(count("3EB0-L"), table).toBe(table === "erasures" ? 0 : table === "versions" ? 1 : 2);
    }
    expect(db.prepare("SELECT item FROM enrichments ORDER BY item").pluck().all()).toEqual(["3EB0-L"]);
    expect(db.prepare("SELECT count(*) FROM extracts").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM version_blobs WHERE blob = ?").pluck().get(hash)).toBe(0);
    expect(db.prepare("SELECT family, unit FROM rereads").all()).toEqual([{ family: "messages", unit: "c1/2026-09-01" }]);
    expect(db.prepare("SELECT day FROM dirty_days").pluck().all()).toEqual(["2026-09-01"]);
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    const replies = new Database(join(test.root, "replies", "replies.db"), { readonly: true });
    cleanup.push(() => replies.close());
    for (const table of ["requests", "replies"]) {
      expect(replies.prepare(`SELECT unit FROM ${table} ORDER BY unit`).pluck().all(), table).toEqual(["3EB0-L"]);
    }
    expect(replies.prepare("SELECT count(*) FROM attempts WHERE key = 'req-3EB0-K'").pluck().get()).toBe(0);
    const attachment = join(test.root, "replies", "blobs", sha256(photo).slice(0, 2), sha256(photo).slice(2, 4), sha256(photo));
    expect(existsSync(attachment)).toBe(false);
    expect(test.blobs.has(hash)).toBe(false);
    expect(test.blobs.has(snapshotHash)).toBe(true);
    expect(existsSync(join(test.root, "inbox", mac, "d1", "media", "photo.jpg"))).toBe(false);
    expect(existsSync(join(test.root, "inbox", mac, "d1", "chat.db"))).toBe(true);
    expect(existsSync(join(test.root, "inbox", mac, "d1", "swept.json"))).toBe(true);
    expect(existsSync(join(test.root, "inbox", phone, "blobs", sha256(photo)))).toBe(false);
    expect(existsSync(join(test.root, "days", "2026-09-01.day.txt"))).toBe(false);

    const again = land(test.db, { source: phone, stated_ms: T0 + 3 * HOUR, name: "d3", rows: [message("3EB0-K", { read: true, edited: true })] });
    expect(again.landed).toMatchObject({ erased: 1, new: 0, changed: 0 });
    expect(db.prepare("SELECT count(*) FROM heads WHERE key = '3EB0-K'").pluck().get()).toBe(0);

    test.db.commit((tx) => {
      tx.tables.deliveries.move(`${mac}/d1`, mac, { move: "reread", code: "sha256:code-1", refused: 1 });
      tx.tables.deliveries.move(`${mac}/d1`, mac, { move: "give-up", code: "sha256:code-1" });
      tx.tables.deliveries.move(`${phone}/d2`, phone, { move: "reread", code: "sha256:code-1", refused: 2 });
    });
    const beat = { id: `${mac}/heartbeat`, at: T0 + 2 * HOUR };
    const beatFacts = { snapshot_taken_at: new Date(beat.at).toISOString(), read_through: new Date(beat.at - HOUR).toISOString() };
    sealDelivery(test.root, mac, "heartbeat", {}, beatFacts);
    test.db.commit((tx) => {
      tx.tables.deliveries.add({ id: beat.id, source: mac, sealed_ms: beat.at, stated_ms: beat.at, facts: beatFacts });
      const run = tx.tables.runs.start({ kind: "import", subject: mac, started_ms: beat.at });
      tx.tables.deliveries.move(beat.id, mac, { move: "begin", run });
      tx.tables.deliveries.move(beat.id, mac, { move: "land", run, refused: 0, error: null, code: "sha256:code-1" });
      tx.tables.runs.end(run, { ended_ms: beat.at, outcome: "ok" });
    });
    const plan = await cli(test.root, ["erase", "messages", "3EB0-L", "--purge-deliveries"]);
    expect(plan.result).toMatchObject({ applied: false, deliveries: [`${mac}/d1`, `${phone}/d2`], unreadable: [] });
    const purged = await cli(test.root, ["erase", "messages", "3EB0-L", "--purge-deliveries", "--apply"]);
    expect(purged.status, purged.lines.join("")).toBe(0);
    expect(purged.result).toMatchObject({ records: 2, deliveries_purged: 2 });
    expect(existsSync(join(test.root, "inbox", mac, "d1"))).toBe(false);
    expect(existsSync(join(test.root, "inbox", phone, "d2"))).toBe(false);
    expect(test.blobs.has(snapshotHash)).toBe(false);
    expect(db.prepare("SELECT error FROM deliveries WHERE id IN ('imessage:local:mac-0001/d1', 'imessage:local:iphone-aa01/d2') ORDER BY id").pluck().all())
      .toEqual([expect.stringMatching(/^purged by erasure run/u), expect.stringMatching(/^purged by erasure run/u)]);
    expect(db.prepare("SELECT id, state, refused FROM deliveries WHERE id IN (?, ?) ORDER BY id").all(`${mac}/d1`, `${phone}/d2`)).toEqual([
      { id: `${phone}/d2`, state: "imported", refused: 0 }, { id: `${mac}/d1`, state: "superseded", refused: 0 },
    ]);
    expect(replies.prepare("SELECT count(*) FROM requests").pluck().get()).toBe(0);
    writeArtifact("erase", { planned: planned.result, erased: erased.result, purged: purged.result, again: again.landed });
  });

  it("status counts a family's calls and spend today, a reply that stated no cost an unknown spend", async () => {
    const test = home("unpriced");
    const ctx = context(test, { settings: { ...SETTINGS, model: { cap: 4 } } });
    cleanup.push(() => ctx.close());
    answered(ctx.ledger, { key: "priced", family: "photos", unit: "p1", at_ms: T0 - HOUR, cost: 0.02 });
    answered(ctx.ledger, { key: "unpriced", family: "photos", unit: "p2", at_ms: T0 - HOUR });
    const { status } = await import("./verbs/status.js");
    const report = await status(ctx, []) as import("./status.js").StatusReport;
    expect(report.today.families).toContainEqual(expect.objectContaining({ family: "photos", spend: { calls: 2, usd: 0.02, unpriced: 1 } }));
  });

  it("a dead import blocks its source after the operator gives its delivery up", async () => {
    const test = home("drop-import");
    const source = "imessage:local:mac-0001";
    test.db.commit((tx) => {
      tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "imessage-db", added_ms: T0 });
      for (const [name, at, seal] of [["d1", T0, 1], ["d2", T0 + HOUR, 2]] as const) tx.tables.deliveries.add({ id: `${source}/${name}`, source, sealed_ms: at, stated_ms: at, facts: {}, pass: "p-0000000a", seal });
      tx.tables.jobs.enqueue({ kind: "import", key: source, lane: 0, not_before_ms: T0, now_ms: T0 });
      for (let attempt = 0; attempt < 5; attempt++) tx.tables.jobs.fail(tx.tables.jobs.take(T0 + attempt * DAY)!.id, `${source}/d1: the connector refused it`, T0 + attempt * DAY);
      for (let failure = 0; failure < 5; failure++) reach(tx, `${source}/d1`, source, "failed");
    });
    const status = await cli(test.root, ["status", "--json"]);
    const said = status.result as unknown as import("./status.js").StatusReport;
    expect(said.notices.find((notice) => notice.id === `job:import:${source}`)?.what).toMatch(/imessage:local:mac-0001 is blocked at imessage:local:mac-0001\/d1 after 5 tries/u);
    const dropped = await cli(test.root, ["drop", "job", "import", source]);
    expect(dropped.result).toMatchObject({ delivery: `${source}/d1` });
    expect(dropped.going.join("")).toContain(`the device may forget its copy of ${source}/d1; its bytes stay in the inbox`);
    const view = test.db.view();
    try {
      expect(view.tables.deliveries.get(`${source}/d1`, source)!.state).toBe("dead");
      expect(view.tables.deliveries.next(source)!.id).toBe(`${source}/d2`);
    } finally {
      view.close();
    }
  });

  it("a drop gives up the delivery its import stopped at, not one indexed before it since", async () => {
    const test = home("drop-stopped-at");
    const source = "apple-notes:local:mac-0001";
    const [stopped, earlier] = [`${source}/stopped`, `${source}/earlier`];
    test.db.commit((tx) => {
      tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "apple-notes", added_ms: T0 });
      tx.tables.deliveries.add({ id: stopped, source, sealed_ms: T0 + HOUR, stated_ms: T0 + HOUR, facts: {} });
      tx.tables.jobs.enqueue({ kind: "import", key: source, lane: 0, not_before_ms: T0, now_ms: T0 });
      const job = tx.tables.jobs.take(T0)!;
      const run = tx.tables.runs.start({ kind: "import", subject: `${source} ${stopped}`, started_ms: T0 });
      for (let failure = 0; failure < 2; failure++) {
        tx.tables.deliveries.move(stopped, source, { move: "begin", run });
        tx.tables.deliveries.move(stopped, source, { move: "fail", error: `${stopped}: the connector refused it` });
      }
      tx.tables.jobs.progress(job.id, { run, delivery: stopped, counts: { ...emptyLanded(), refused: 2 } } as never);
      for (let attempt = 0; attempt < 5; attempt++) tx.tables.jobs.fail(attempt === 0 ? job.id : tx.tables.jobs.take(T0 + attempt * DAY)!.id, "refused", T0 + attempt * DAY);
      tx.tables.deliveries.add({ id: earlier, source, sealed_ms: T0 + 2 * HOUR, stated_ms: T0, facts: {} });
      expect(tx.tables.deliveries.next(source)!.id).toBe(earlier);
    });
    const dropped = await cli(test.root, ["drop", "job", "import", source]);
    expect(dropped.result).toMatchObject({ delivery: stopped });
    const view = test.db.view();
    try {
      expect(view.tables.deliveries.get(stopped, source)).toMatchObject({ state: "dead", refused: 2, read_by: expect.any(String) });
      expect(view.tables.deliveries.get(earlier, source)!.state).toBe("sealed");
      expect(view.tables.deliveries.next(source)!.id).toBe(earlier);
    } finally {
      view.close();
    }
  });

  it("a drop of an import whose delivery was superseded under it (faces forget) lets the job go and reads nothing again", async () => {
    const test = home("drop-superseded");
    const source = "apple-notes:local:mac-0001";
    const id = `${source}/forgotten`;
    test.db.commit((tx) => {
      tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "apple-notes", added_ms: T0 });
      tx.tables.deliveries.add({ id, source, sealed_ms: T0, stated_ms: T0, facts: {} });
      tx.tables.jobs.enqueue({ kind: "import", key: source, lane: 0, not_before_ms: T0, now_ms: T0 });
      const job = tx.tables.jobs.take(T0)!;
      const run = tx.tables.runs.start({ kind: "import", subject: `${source} ${id}`, started_ms: T0 });
      tx.tables.deliveries.move(id, source, { move: "begin", run });
      tx.tables.jobs.progress(job.id, { run, delivery: id, counts: { ...emptyLanded(), refused: 1 } } as never);
      tx.tables.jobs.recover();
      tx.tables.deliveries.move(id, source, { move: "supersede", why: "removed by faces forget" });
    });
    const dropped = await cli(test.root, ["drop", "job", "import", source]);
    expect(dropped.status).toBe(0);
    const view = test.db.view();
    try {
      expect(view.tables.deliveries.get(id, source)).toMatchObject({ state: "superseded", refused: 0, read_by: null });
      expect(view.tables.jobs.get("import", source)!.state).toBe("done");
    } finally {
      view.close();
    }
  });

  it("leaves a dismissed need off the status list while its stream still shows it, lists it again once it changed, and dismisses none not standing", async () => {
    const test = home("dismiss");
    const copy = "claude:11111111-1111-4111-8111-00000000000a:browser";
    const need = `fetch:claude-browser:${copy}`;
    const signedOut = (since_ms: number) => test.db.commit((tx) => tx.tables.attempts.put({
      target: "fetch:claude-browser", source: copy, outcome: "need", reason: "signed-out", facts: {}, detail: null, since_ms, at_ms: since_ms, contact_ms: null, fails: 0,
    }));
    test.db.commit((tx) => {
      tx.tables.sources.add({ id: copy, vendor: vendorOf(declarations(), copy), connector: "claude-browser", options: { lane: "claude-browser", email: "person-a@example.com" }, added_ms: T0 });
      tx.tables.deliveries.add({ id: "claude-browser/1", source: copy, sealed_ms: T0, stated_ms: T0, facts: {} });
    });
    signedOut(T0 + DAY);
    const listed = async () => ((await cli(test.root, ["status", "--json"])).result as unknown as StatusReport).needs.find((each) => each.id === need);
    const stream = async () => ((await cli(test.root, ["connectors", "--json"])).result as unknown as StreamsReport).connectors.find((each) => each.id === "claude")!.copies.find((each) => each.id === copy)!.health;
    expect(await listed()).toMatchObject({ words: "Sign in to Claude in Chrome", dismissed: false });
    expect((await cli(test.root, ["act", "fetch:gmail-imap", "dismiss"])).lines.join("")).toContain("NOT_OFFERED");
    expect((await cli(test.root, ["act", need, "dismiss"])).result).toEqual({ acted: "dismissed" });
    expect(await listed()).toBeUndefined();
    expect(await stream()).toMatchObject({ state: "needs-you", reason: "signed-out" });
    signedOut(T0 + 2 * DAY);
    expect(await listed()).toMatchObject({ dismissed: false });
    writeArtifact("dismiss", await listed());
  });

  it("the CLI runs a verb beside a home that holds home.lock", async () => {
    const test = home("cli");
    const lock = tryLock(join(test.root, "home.lock"))!;
    cleanup.push(() => lock.release());
    const refused = await cli(test.root, ["device", "add", "iphone-aa01", "--model", "Synthetic iPhone"], undefined, { waitMs: 50, startingMs: 10 });
    expect(refused.status).toBe(1);
    expect(refused.lines.join("")).toMatch(/home\.lock is held/u);
    expect(raw(test.root).prepare("SELECT count(*) FROM devices").pluck().get()).toBe(0);
    const requests: unknown[] = [];
    const socket: Server = createServer((connection) => {
      connection.setEncoding("utf8");
      connection.once("data", (line: string) => {
        requests.push(JSON.parse(line));
        connection.end(`${JSON.stringify({ out: "added by the home" })}\n${JSON.stringify({ result: { unit: "iphone-aa01" } })}\n`);
      });
    });
    mkdirSync(dirname(testSocket(test.root).path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => socket.listen(testSocket(test.root).path, resolve));
    cleanup.push(() => socket.close());
    const answered = await cli(test.root, ["device", "add", "iphone-aa01", "--model", "Synthetic iPhone"]);
    expect(answered).toMatchObject({ status: 0, lines: ["added by the home\n"], result: undefined });
    const program = await cli(test.root, ["device", "add", "iphone-aa01", "--model", "Synthetic iPhone", "--json"]);
    expect(program).toMatchObject({ status: 0, lines: [`${JSON.stringify({ unit: "iphone-aa01" })}\n`] });
    expect(requests).toEqual([
      { verb: "device", args: ["add", "iphone-aa01", "--model", "Synthetic iPhone"], cwd: process.cwd(), by: "terminal", folder: test.root, sent_ms: expect.any(Number) },
      { verb: "device", args: ["add", "iphone-aa01", "--model", "Synthetic iPhone", "--json"], cwd: process.cwd(), by: "terminal", folder: test.root, sent_ms: expect.any(Number) },
    ]);
    land(test.db, { source: "imessage:local:mac-0001", stated_ms: T0, rows: [message("m1")] });
    const fix = join(test.root, "keep.mjs");
    writeFileSync(fix, "export function fix() { return 'keep'; }\n");
    const planned = await cli(test.root, ["repair", "--source", "imessage:local:mac-0001", "--reason", "a plan", "--fix", fix]);
    expect(planned.result).toMatchObject({ applied: false, counts: { heads: 1, kept: 1 } });
    expect(requests).toHaveLength(2);
  });

  it("status not naming a dead job or a silent phone over 26 h", async () => {
    const test = home("status");
    const BROKE = "synthetic: chatgpt.com answered 500\npage https://chatgpt.example.com/ \"ChatGPT\"";
    const now = T0 + 2 * DAY;
    const door: Server = createServer((socket) => socket.end());
    await new Promise<void>((resolve) => door.listen(0, "127.0.0.1", resolve));
    cleanup.push(() => { if (door.listening) door.close(); });
    const port = (door.address() as { port: number }).port;
    mkdirSync(join(test.root, "config"), { recursive: true });
    writeFolder(test.root, { "door.port": port, "connectors.gmail": { account: "person-a@example.com", route: "gmail-imap" } });
    const IMESSAGE = "imessage:person-a@example.com:macbook-pro-0001";
    test.db.commit((tx) => {
      tx.tables.devices.add({ unit: "iphone-aa01", model: "Synthetic iPhone", added_ms: T0 - 30 * DAY });
      tx.tables.devices.add({ unit: "iphone-bb02", model: "Synthetic iPhone", added_ms: T0 - 30 * DAY });
      tx.tables.devices.add({ unit: "macbook-pro-0001", model: "Synthetic MacBook Pro", added_ms: T0 - 30 * DAY });
      tx.tables.jobs.enqueue({ kind: "import", key: "coast:local:macbook-pro-0001/20260901T080000Z", lane: 0, not_before_ms: T0, now_ms: T0 });
      for (let attempt = 0; attempt < 5; attempt++) {
        const at = T0 + attempt * HOUR;
        const job = tx.tables.jobs.take(at)!;
        tx.tables.jobs.fail(job.id, "the connector knows no schema shape 'ax_id_schema_switch'", at);
      }
      tx.tables.sources.add({ id: IMESSAGE, vendor: vendorOf(declarations(), IMESSAGE), connector: "imessage-db", added_ms: T0 });
      tx.tables.jobs.enqueue({ kind: "import", key: IMESSAGE, lane: 0, not_before_ms: T0 + 6 * HOUR, now_ms: T0 + 6 * HOUR });
      for (let attempt = 0; attempt < 5; attempt++) {
        const at = T0 + (6 + attempt) * HOUR;
        tx.tables.jobs.fail(tx.tables.jobs.take(at)!.id, "synthetic: chat.db is not a database", at);
      }
      const failed = (acquirer: string, detail: string, reason = "failing", facts = {}) =>
        tx.tables.attempts.put({ target: `fetch:${acquirer}`, source: "", outcome: "fail", reason, facts, detail, since_ms: now - HOUR, at_ms: now - HOUR, contact_ms: null, fails: 3 });
      tx.tables.polls.put({ acquirer: "gmail-imap", next_ms: now + 65 * 60_000 - 1 });
      failed("gmail-imap", "synthetic: the mailbox did not answer");
      tx.tables.polls.put({ acquirer: "chatgpt-browser", next_ms: now - 1 });
      failed("chatgpt-browser", BROKE);
      tx.tables.jobs.enqueue({ kind: "render", key: "days", lane: 0, not_before_ms: now, now_ms: now });
    });
    land(test.db, { source: "location:local:iphone-aa01", stated_ms: now - 30 * HOUR, rows: [{ kind: "sample", key: "s1", content: { lat: 0, lon: 0 } }] });
    land(test.db, { source: "location:local:iphone-bb02", stated_ms: now - HOUR, rows: [{ kind: "sample", key: "s1", content: { lat: 0, lon: 0 } }] });
    const today = now - 2 * HOUR;
    test.db.commit((tx) => {
      for (const [source, counts, paths] of [
        ["whoop:person-a:cloud", { new: 13, restated: 0, changed: 4_987 }, { segment_styles: 4_987, score: 3 }],
        ["whatsapp:+15550000001:macbook-pro-0001", { new: 3, restated: 120_397, changed: 1_600 }, { ZMESSAGESTATUS: 1_600 }],
      ] as const) {
        tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "synthetic", added_ms: T0 });
        tx.tables.deliveries.add({ id: `${source}/today`, source, sealed_ms: today, stated_ms: today, facts: {} });
        const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: today });
        tx.tables.runs.end(run, { ended_ms: today, outcome: "ok", counts, changed_paths: paths });
        tx.tables.deliveries.move(`${source}/today`, source, { move: "begin", run });
        reach(tx, `${source}/today`, source, "imported");
      }
    });
    const report = await cli(test.root, ["status", "--json"]);
    expect(report.status, report.lines.join("")).toBe(0);
    const status = report.result as unknown as import("./status.js").StatusReport;
    expect(status.needs.map((need) => need.id).sort()).toEqual([
      "fetch:chatgpt-browser",
      "fetch:gmail-imap",
      `job:import:${IMESSAGE}`,
      "vault:none",
    ]);
    const need = (id: string) => status.needs.find((each) => each.id === id)!;
    const notice = (id: string) => status.notices.find((each) => each.id === id)?.what;
    expect(need(`job:import:${IMESSAGE}`)).toMatchObject({
      state: "broken", reason: "import", words: "Couldn’t import new messages", line: "iMessage", next_ms: null, acts: [{ do: "skip", label: "Skip it", need: `job:import:${IMESSAGE}` }],
    });
    expect(notice(`job:import:${IMESSAGE}`)).toMatch(/dead after 5 tries: synthetic: chat\.db is not a database/u);
    expect(need("fetch:gmail-imap")).toMatchObject({
      state: "broken", words: "Couldn’t read Gmail", since_ms: now - HOUR, next_ms: now + 65 * 60_000 - 1, acts: [{ do: "try", label: "Try now", need: "poll:gmail-imap" }],
    });
    expect(need("fetch:chatgpt-browser")).toMatchObject({ state: "broken", words: "Couldn’t read ChatGPT", connector: "chatgpt", acts: [{ do: "try", label: "Try now" }], detail: BROKE });
    const unheld = "job:import:coast:local:macbook-pro-0001/20260901T080000Z";
    expect(notice(unheld)).toMatch(/dead after 5 tries: the connector knows no schema shape/u);
    expect(status.needs.some((each) => each.unit === "iphone-aa01")).toBe(false);
    const whoop = status.today.sources.find((source) => source.source === "whoop:person-a:cloud")!;
    expect(whoop.likely_noise).toEqual([{ path: "segment_styles", count: 4_987, of: 5_000 }]);
    expect(status.today.sources.find((source) => source.source.startsWith("whatsapp:"))!.likely_noise).toEqual([]);
    expect(status.running.lanes).toEqual([{ lane: 0, queued: 1, running: 0, due_ms: now }]);

    const text = await cli(test.root, ["status"]);
    expect(text.lines.join("")).toMatch(/\n {2}- \(broken\) Couldn’t import new messages · iMessage \[Skip it\]\n {6}import imessage:/u);
    expect(text.lines.join("")).toContain(`\n  - (broken) Couldn’t read ChatGPT [Try now]\n${BROKE.split("\n").map((line) => `      ${line}\n`).join("")}`);
    expect(text.lines.join("")).toMatch(/For whoever runs Lifestream\n(?: {2}- .*\n)* {2}- import coast:local:macbook-pro-0001\/20260901T080000Z is dead after 5 tries/u);
    expect(text.lines.join("")).toMatch(/likely noise: segment_styles changed on 4987 of 5000 rows/u);
    door.close();
    const closed = await cli(test.root, ["status", "--json"]);
    expect((closed.result as unknown as import("./status.js").StatusReport).needs.map((need) => need.id)).toContain("door");
    writeArtifact("status", status);
    expect(JSON.parse(readFileSync(join(test.root, "config", "settings.json"), "utf8"))["door.port"]).toBe(port);
  });
  it("a mistyped root becomes a new empty home, serve exits on it into launchd's loop, or a root too long for a socket fails late", async () => {
    const parent = tempDir("cli-root");
    cleanup.push(() => removeDir(parent));
    const missing = join(parent, "lifestraem");
    mkdirSync(missing);
    const refusals: Record<string, string> = {};
    const notHome = `${missing} is not Lifestream's folder: it holds no HOME.json (lifestream adopt <folder> makes one)`;
    for (const args of [["status"], ["device", "add", "iphone-aa01", "--model", "Synthetic iPhone"], ["sweep"]]) {
      const answer = await cli(missing, args);
      expect(answer.status, args.join(" ")).toBe(1);
      expect(answer.lines.join("")).toContain(notHome);
      refusals[args[0]!] = answer.lines.join("").trim();
    }
    const logs: string[] = [];
    const ending = new AbortController();
    const started = startHome(missing, { stopGraceMs: 50, registry: FAKES, lookMs: 50, log: (line) => logs.push(line), signal: ending.signal });
    await until("serve waits on the mistyped root", () => logs.length > 0);
    ending.abort();
    await started.then((running) => running.stop(), () => undefined);
    expect(logs.map((line) => JSON.parse(line))).toEqual([{ at: expect.any(String), home: "waiting", why: notHome }]);
    refusals.serve = notHome;
    expect(readdirSync(missing)).toEqual([]);
    const deep = join(parent, "deep");
    const longMachine = join(parent, "m".repeat(Math.max(1, 104 - join(parent, "run", "00000000.sock").length)));
    mkdirSync(deep);
    mkdirSync(longMachine);
    writeFolder(deep);
    const machineDir = process.env.LIFESTREAM_MACHINE_DIR;
    process.env.LIFESTREAM_MACHINE_DIR = longMachine;
    const long = await cli(deep, ["status"]).finally(() => { process.env.LIFESTREAM_MACHINE_DIR = machineDir; });
    expect(long.status).toBe(1);
    expect(long.lines.join("")).toMatch(new RegExp(`\\.sock is ${Buffer.byteLength(join(longMachine, "run", "00000000.sock"))} bytes; a socket's path must be under 104`, "u"));
    expect(readdirSync(deep).sort()).toEqual(["HOME.json", "config"]);
    writeArtifact("cli-root", { refusals, long: long.lines.join("").trim() });
  });

  it("a stray argument or an out-of-range value runs as something else", async () => {
    const test = home("cli-args");
    const cases: [string[], RegExp][] = [
      [["sweep", "extra"], /"extra" is not an argument of sweep/u],
      [["status", "--jsn"], /status: Unknown option '--jsn'/u],
      [["pause", "lane:7"], /a pause is home, kind:<kind>, <kind>:<key>, pause:<connector>, pause:<connector>:history or runner:<unit>/u],
      [["pause", "kind:imports"], /no job kind imports; the home runs/u],
      [["resume", "kind:repair", "now"], /"now" is not an argument of resume/u],
      [["run", "extract", "notes", "--lane", "4"], /--lane is one of 0, 1, 2, 3, 5, not "4"/u],
      [["run", "extrct", "notes"], /no job kind extrct/u],
      [["undo", "7x"], /the run is a run's number, not "7x"/u],
      [["drop", "job", "import", "imessage:local:mac-0001", "--reason", "x"], /drop job takes no --reason/u],
      [["deploy", "--rollbak"], /deploy: Unknown option '--rollbak'/u],
      [["deploy", "--to", "abc"], /deploy only rolls back: a release arrives inside the Mac app/u],
      [["deploy"], /deploy only rolls back/u],
      [["deploy", "--rollback", "--commit", "main"], /deploy: Unknown option '--commit'/u],
      [["install", "--face-idx"], /install: Unknown option '--face-idx'/u],
      [["maintenance", "checkpoint", "extra"], /"extra" is not an argument of maintenance/u],
    ];
    const answers: Record<string, string> = {};
    for (const [args, pattern] of cases) {
      const answer = await cli(test.root, args);
      const text = answer.lines.join("");
      expect(answer.status, `${args.join(" ")}: ${text}`).toBe(1);
      expect(text, args.join(" ")).toMatch(pattern);
      answers[args.join(" ")] = text.trim();
    }
    const db = raw(test.root);
    expect(db.prepare("SELECT count(*) FROM controls").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM jobs").pluck().get()).toBe(0);
    expect(db.prepare("SELECT count(*) FROM runs").pluck().get()).toBe(0);
    expect((await cli(test.root, ["pause", "kind:repair", "--reason", "a long repair"])).result).toEqual({ paused: "kind:repair", by: "terminal" });
    expect((await cli(test.root, ["resume", "kind:repair"])).result).toEqual({ resumed: "kind:repair" });
    expect((await cli(test.root, ["run", "index-inbox", "inbox", "--lane", "1"])).result).toMatchObject({ kind: "index-inbox", lane: 1, state: "queued" });
    writeArtifact("cli-args", answers);
  });

  it("makes a source of a product no connector declares, or stores one with a vendor other than its declaration's", async () => {
    const test = home("source-vendor");
    const registry: Registry = { families: [], connectors: connectors(), readers: readers() };
    const refused = await cli(test.root, ["source", "add", "acme:person-a@example.com:cloud", "--connector", "gmail"], registry);
    expect(refused.status).toBe(1);
    expect(refused.lines.join("")).toMatch(/"acme:person-a@example\.com:cloud": a source is <product>:<account>:<copy>, the product one the home knows; acme is not a product \(no connector declares it\)/u);
    expect((await cli(test.root, ["source", "add", "google-contacts:person-a@example.com:export", "--connector", "contacts-vcard"], registry)).status).toBe(0);
    expect(raw(test.root).prepare("SELECT id, product, vendor FROM sources").all()).toEqual([
      { id: "google-contacts:person-a@example.com:export", product: "google-contacts", vendor: "google" },
    ]);
    const site = "chatgpt:user-synthetic0001:browser";
    const unnamed = await cli(test.root, ["source", "add", site, "--connector", "chatgpt-browser"], registry);
    expect([unnamed.status, unnamed.lines.join("")]).toEqual([1, expect.stringContaining(`${site} is read in Chrome, where its account is named as the site shows it: add --options '{"name":"<your name as ChatGPT shows it>"}' (or "email", where it shows one)`)]);
    expect((await cli(test.root, ["source", "add", site, "--connector", "chatgpt-browser", "--options", JSON.stringify({ email: "person-a@example.com" })], registry)).status).toBe(0);
    expect((await cli(test.root, ["source", "add", "chatgpt:user-synthetic0001:export", "--connector", "chatgpt-export"], registry)).status).toBe(0);
  });

  it("help needs a root, reads the home or its socket, or prints a usage the verb's own refusal does not", async () => {
    const run = async (args: string[]) => {
      const lines: string[] = [];
      const status = await runCli(args, { write: (text) => lines.push(text) });
      return { status, text: lines.join("") };
    };
    const top = await run([]);
    expect(top.status).toBe(2);
    const verbs = /; verbs: (.+)\n$/u.exec(top.text)![1]!.split(", ");
    expect(verbs).toEqual(expect.arrayContaining(["status", "drop", "principals", "sweep", "rehydrate", "maintenance", "serve", "install", "self-check", "deploy"]));

    const test = home("cli-help");
    const usages: Record<string, string> = {};
    const refusals: Record<string, string> = {};
    for (const verb of verbs) {
      const asked = await run(["help", verb]);
      expect(asked.status, `help ${verb}: ${asked.text}`).toBe(0);
      const [said, guide] = asked.text.split("\n\n");
      expect(guide === undefined || verb === "connectors", `help ${verb}: ${asked.text}`).toBe(true);
      const usage = /^usage: lifestream (.+?)\nA verb's answer is its lines, for a person .+; with --json, its answer alone, .+ never both\. What a verb says as it goes, a wait or a warning, is on standard error\.\n?$/su.exec(said!)?.[1] ?? "";
      expect(usage === verb || usage.startsWith(`${verb} `), `help ${verb}: ${asked.text}`).toBe(true);
      for (const flag of ["--help", "-h"]) expect(await run([verb, flag]), `${verb} ${flag}`).toEqual(asked);
      const refused = await cli(test.root, [verb, "--nope"]);
      const text = refused.lines.join("");
      expect(refused.status, `${verb} --nope: ${text}`).toBe(1);
      expect(text.endsWith(`usage: lifestream ${usage}\n`), `${verb} --nope: ${text}`).toBe(true);
      usages[verb] = usage;
      refusals[verb] = text.trim();
    }

    const form = "A verb's answer is its lines, for a person (one with no line of its own prints its answer as one line of JSON); with --json, its answer alone, as one line of JSON, for a program: never both. What a verb says as it goes, a wait or a warning, is on standard error.";
    const listing = `usage: lifestream <verb> [arguments…] [--root <root>] [--json]\n${verbs.map((verb) => `       lifestream ${usages[verb]}\n`).join("")}${form}\n`;
    for (const args of [["help"], ["--help"], ["-h"]]) expect(await run(args), args[0]).toEqual({ status: 0, text: listing });
    for (const args of [
      ["principals", "mint", "--unit", "x", "--scope", "read", "--help"], ["connectors", "set", "whatsapp", "-h"], ["rebuild", "enrichments", "--family", "notes", "--help"],
      ["maintenance", "checkpoint", "--help"], ["deploy", "--rollback", "--help"], ["help", "connectors", "set"],
    ]) {
      expect(await run(args), args.join(" ")).toEqual({ status: 0, text: `usage: lifestream ${usages[args[0] === "help" ? args[1]! : args[0]!]}\n${form}\n` });
    }
    for (const args of [["help", "nope"], ["nope", "--help"], ["nope"]]) expect(await run(args), args.join(" ")).toEqual(top);
    const away = tempDir("cli-help-bin");
    cleanup.push(() => removeDir(away));
    symlinkSync(fileURLToPath(new URL("../../bin/lifestream", import.meta.url)), join(away, "first"));
    symlinkSync("first", join(away, "lifestream"));
    const bin = (args: string[]) => {
      const ran = spawnSync(join(away, "lifestream"), args, { cwd: away, env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
      return { status: ran.status, text: ran.stdout };
    };
    expect(bin(["help"])).toEqual({ status: 0, text: listing });
    expect(bin(["nope"])).toEqual(top);

    const root = tempDir("cli-help-root");
    cleanup.push(() => removeDir(root));
    writeFolder(root);
    writeFileSync(join(root, "config", "settings.json"), "not json\n");
    let connections = 0;
    const socket: Server = createServer((connection) => {
      connections++;
      connection.end();
    });
    mkdirSync(dirname(testSocket(root).path), { recursive: true, mode: 0o700 });
    await new Promise<void>((resolve) => socket.listen(testSocket(root).path, resolve));
    cleanup.push(() => socket.close());
    const files = readdirSync(root).sort();
    for (const args of [["help"], ["help", "status"], ["status", "--help"], ["rebuild", "-h"], ["serve", "--help"], ["self-check", "--help"]]) {
      const usage = args.length === 1 ? listing : `usage: lifestream ${usages[args[0] === "help" ? args[1]! : args[0]!]}\n${form}\n`;
      expect(await run([...args, "--root", root]), args.join(" ")).toEqual({ status: 0, text: usage });
    }
    expect(connections).toBe(0);
    expect(readdirSync(root).sort()).toEqual(files);
    expect((await run(["status", "--root", root])).status).toBe(1);
    expect(connections).toBe(1);

    writeArtifact("cli-help", { listing, usages, refusals, unknown: top.text.trim() });
  });

  it("rebuild enrichments deletes a family's rows, so a day renders without its captions until the plans put them back", async () => {
    const root = makeRoot("lifestream-verbs-rebuild-enrichments-", { sources: { [NOTES]: "fake-rows" } });
    cleanup.push(() => removeRoot(root));
    const running = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    const sock = testSocket(root);
    const at = Date.UTC(2026, 8, 10, 10, 0);
    const day = "2026-09-10";
    const quiet = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
    const text = () => readFileSync(join(root, "days", `${day}.day.txt`), "utf8");
    const rows = () => readHome(root, (db) => db.prepare("SELECT item, prompt, input_hash, reply_key, state, content FROM enrichments WHERE family = 'notes' ORDER BY item").all());
    const marked = () => readHome(root, (db) => db.prepare("SELECT unit FROM dirty_units WHERE family = 'notes' ORDER BY unit").pluck().all());
    const told = (after: number) => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'day' AND seq > ?").pluck().get(after)) as number;
    await ship(root, { source: NOTES, fetched_ms: Date.now(), rows: [{ kind: "note", key: "n1", content: { text: "a synthetic note with a photo", at, photo: true }, at }] });
    await until("the day printed its caption", () => quiet() && text().includes("[fake reply "));
    const before = { rows: rows(), text: text() };
    expect(before.rows.length).toBe(1);
    const since = readHome(root, (db) => db.prepare("SELECT coalesce(max(seq), 0) FROM events").pluck().get()) as number;

    await askHome(sock, "pause", ["kind:plan", "--reason", "the test reads what the verb's commit left"]);
    const rebuilt = await askHome(sock, "rebuild", ["enrichments", "--family", "notes"]);
    expect(rebuilt).toEqual({ run: expect.any(Number), family: "notes", units: 1 });
    const committed = { rows: rows(), marked: marked() };
    expect(committed).toEqual({ rows: before.rows, marked: [`${NOTES}/2026-09-10`] });

    await askHome(sock, "resume", ["kind:plan"]);
    await until("the units planned again", () => quiet() && marked().length === 0);
    const after = { rows: rows(), text: text(), told: told(since) };
    expect(after).toEqual({ rows: before.rows, text: before.text, told: 0 });
    writeArtifact("rebuild-enrichments", { before, rebuilt, committed, after });
    await running.stop();
  });

  it("status builds the connectors and families", async () => {
    const test = home("status-families");
    writeFolder(test.root, { "families.notes": { per: "hour" }, "families.photos": { per: "day" } });
    const lines: string[] = [];
    const status = await runCli(["status", "--root", test.root], { write: (text) => lines.push(text), now: () => T0 });
    expect(status, lines.join("")).toBe(0);
    const rebuilt: string[] = [];
    await runCli(["rebuild", "enrichments", "--family", "photos", "--root", test.root], { write: (text) => rebuilt.push(text), now: () => T0 });
    expect(rebuilt.join("")).not.toMatch(/families\./u);
    writeArtifact("status-families", { text: lines.join(""), rebuilt: rebuilt.join("").trim() });
  });
});

describe("codex", () => {
  it("names this machine's Codex as the calls' preflight judges it, looked at again on every ask", async () => {
    const test = home("codex");
    const bin = tempDir("codex-bin");
    const overrides = join(process.env.LIFESTREAM_MACHINE_DIR!, "machine.json");
    const saved = existsSync(overrides) ? readFileSync(overrides) : null;
    cleanup.push(() => removeDir(bin), () => { if (saved === null) rmSync(overrides, { force: true }); else writeFileSync(overrides, saved); });
    const fake = (name: string, version: string, login: string): string => {
      const path = join(bin, name);
      writeFileSync(path, ["#!/bin/sh", `case "$1" in --version) echo "codex-cli ${version}"; exit 0;; login) ${login};; esac`, "exit 3", ""].join("\n"), { mode: 0o755 });
      return path;
    };
    const ask = async (codex: string) => {
      writeFileSync(overrides, JSON.stringify({ codex }));
      return (await cli(test.root, ["codex"])).result;
    };
    const signedIn = fake("signed-in", "0.200.0", "exit 0");
    const seen = {
      signed_in: await ask(signedIn),
      signed_out: await ask(fake("signed-out", "0.200.0", 'echo "Not logged in" >&2; exit 1')),
      absent: await ask(join(bin, "absent")),
    };
    expect(seen.signed_in).toEqual({ state: "signed_in", path: signedIn, version: "0.200.0", why: null });
    expect(seen.signed_out).toMatchObject({ state: "signed_out", version: "0.200.0", why: "Codex is not signed in to ChatGPT: Not logged in; sign in from Lifestream's Settings" });
    expect(seen.absent).toMatchObject({ state: "unusable", version: null, why: expect.stringMatching(/absent is missing$/u) });
    writeArtifact("codex", seen);
  });

  it("names this machine's Claude Code as the calls' preflight judges it, signed in only as its auth status says", async () => {
    const test = home("claude");
    const bin = tempDir("claude-bin");
    const overrides = join(process.env.LIFESTREAM_MACHINE_DIR!, "machine.json");
    const saved = existsSync(overrides) ? readFileSync(overrides) : null;
    cleanup.push(() => removeDir(bin), () => { if (saved === null) rmSync(overrides, { force: true }); else writeFileSync(overrides, saved); });
    const fake = (name: string, version: string, status: string): string => {
      const path = join(bin, name);
      writeFileSync(path, ["#!/bin/sh", `case "$1" in --version) echo "${version} (Claude Code)"; exit 0;; auth) ${status};; esac`, "exit 3", ""].join("\n"), { mode: 0o755 });
      return path;
    };
    const ask = async (claude: string) => {
      writeFileSync(overrides, JSON.stringify({ claude }));
      return (await cli(test.root, ["claude"])).result;
    };
    const signedIn = fake("signed-in", "2.2.0", `echo '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'; exit 0`);
    const seen = {
      signed_in: await ask(signedIn),
      signed_out: await ask(fake("signed-out", "2.2.0", `echo '{"loggedIn":false,"authMethod":"none"}'; exit 1`)),
      absent: await ask(join(bin, "absent")),
    };
    expect(seen.signed_in).toEqual({ state: "signed_in", path: signedIn, version: "2.2.0", why: null });
    expect(seen.signed_out).toMatchObject({ state: "signed_out", version: "2.2.0", why: "Claude Code is not signed in to Claude; sign in from Lifestream's Settings" });
    expect(seen.absent).toMatchObject({ state: "unusable", version: null, why: expect.stringMatching(/absent is missing$/u) });
    writeArtifact("claude", seen);
  });
});

describe("device retire", () => {
  const GONE = "iphone-aa01";
  const KEPT = "iphone-bb02";
  const USAGE = /usage: lifestream device add <unit> --model <model> \| device retire <unit>/u;
  const sample = (key: string): ReaderOutput => ({ kind: "sample", key, content: { lat: 0, lon: 0 } });
  const phones = async (root: string) => {
    const report = (await cli(root, ["connectors", "--json"])).result as unknown as StreamsReport;
    return report.devices.filter((device) => device.kind === "phone" && !device.retired && device.health.state === "quiet").map((device) => `phone:${device.unit}`).sort();
  };
  const rowOf = async (root: string, unit: string) => {
    const device = ((await cli(root, ["connectors", "--json"])).result as unknown as StreamsReport).devices.find((each) => each.unit === unit)!;
    return { state: device.health.state, retired: device.retired };
  };
  const unitNeeds = (report: unknown) => (report as StatusReport).needs.filter((need) => need.unit !== null).map((need) => need.id);
  const history = (root: string) => readHome(root, (db) => ({
    devices: db.prepare("SELECT unit, model, added_ms FROM devices ORDER BY unit").all(),
    sources: db.prepare("SELECT * FROM sources ORDER BY id").all(),
    deliveries: db.prepare("SELECT * FROM deliveries ORDER BY source, id").all(),
    statements: db.prepare("SELECT * FROM statements ORDER BY seq").all(),
    heads: db.prepare("SELECT * FROM heads ORDER BY source, kind, key").all(),
  }));
  const written = (root: string) => readHome(root, (db) => ({
    devices: db.prepare("SELECT * FROM devices ORDER BY unit").all(),
    events: db.prepare("SELECT count(*) FROM events WHERE kind LIKE 'device-%'").pluck().get(),
  }));

  it("a retired phone still said quiet, a silent phone a need, its retirement losing a row of its history, or a refused retire writing anything", async () => {
    const gone = `location:local:${GONE}`;
    const kept = `location:local:${KEPT}`;
    const root = makeRoot("lifestream-device-retire-", { sources: { [gone]: "fake-rows", [kept]: "fake-rows" }, defaults: false });
    cleanup.push(() => removeRoot(root));
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    try {
      db.commit((tx) => {
        for (const unit of [GONE, KEPT]) tx.tables.devices.add({ unit, model: "Synthetic iPhone", added_ms: now - 300 * DAY });
        tx.tables.devices.add({ unit: "macbook-pro-0001", model: "Synthetic MacBook Pro", added_ms: now - 300 * DAY });
      });
      land(db, { source: gone, stated_ms: now - 40 * DAY, rows: [sample("s1"), sample("s2")] });
      land(db, { source: kept, stated_ms: now - 30 * HOUR, rows: [sample("s1")] });
    } finally {
      db.close();
    }
    const home = await homeWithDoor(root, { registry: FAKES, log: () => undefined });
    const kept_before = history(root);
    const answers: Record<string, unknown> = {};
    try {
      const before = await cli(root, ["status", "--json"]);
      expect(await phones(root)).toEqual([`phone:${GONE}`, `phone:${KEPT}`]);
      expect(unitNeeds(before.result)).toEqual([]);
      answers.before = (before.result as unknown as StatusReport).needs;

      const asked = Date.now();
      const retired = await cli(root, ["device", "retire", GONE]);
      expect(retired.status, retired.lines.join("")).toBe(0);
      expect(retired.lines).toHaveLength(1);
      expect(retired.result).toEqual({ unit: GONE, model: "Synthetic iPhone", added_ms: now - 300 * DAY, retired_ms: expect.any(Number) });
      const at = retired.result!.retired_ms as number;
      expect(at).toBeGreaterThanOrEqual(asked);
      expect(at).toBeLessThanOrEqual(Date.now());
      answers.retired = retired.result;

      const after = await cli(root, ["status", "--json"]);
      expect([await phones(root), unitNeeds(after.result)]).toEqual([[`phone:${KEPT}`], []]);
      answers.after = (after.result as unknown as StatusReport).needs;

      const iso = new Date(at).toISOString();
      const cases: [string[], RegExp][] = [
        [["device", "retire", "iphone-zz99"], /^no device iphone-zz99/u],
        [["device", "retire", GONE], new RegExp(`^device ${GONE} was retired at ${iso}`, "u")],
        [["device", "add", GONE, "--model", "Synthetic iPhone 16"], new RegExp(`^device ${GONE} exists, retired at ${iso}`, "u")],
        [["device", "retire"], USAGE],
        [["device", "retire", KEPT, "now"], /"now" is not an argument of device/u],
        [["device", "retire", KEPT, "--model", "Synthetic iPhone"], /device retire takes no --model/u],
        [["device", "retire", KEPT, "--at", "2026-01-15"], /device: Unknown option '--at'/u],
        [["device", "unplug", KEPT], USAGE],
      ];
      const state = written(root);
      const refusals: Record<string, string> = {};
      for (const [args, pattern] of cases) {
        const answer = await cli(root, args);
        const text = answer.lines.join("");
        expect(answer.status, `${args.join(" ")}: ${text}`).toBe(1);
        expect(text, args.join(" ")).toMatch(pattern);
        refusals[args.join(" ")] = text.trim();
      }
      expect(written(root)).toEqual(state);
      answers.refusals = refusals;
      expect(await phones(root)).toEqual([`phone:${KEPT}`]);
    } finally {
      await home.stop();
    }

    expect(history(root)).toEqual(kept_before);
    expect(readHome(root, (read) => read.prepare("SELECT unit, retired_ms FROM devices ORDER BY unit").all())).toEqual([
      { unit: GONE, retired_ms: (answers.retired as { retired_ms: number }).retired_ms },
      { unit: KEPT, retired_ms: null },
      { unit: "macbook-pro-0001", retired_ms: null },
    ]);
    expect(readHome(root, (read) => read.prepare("SELECT kind, key, detail FROM events WHERE kind LIKE 'device-%'").all())).toEqual([{ kind: "device-retire", key: GONE, detail: null }]);
    const reader = openHome(openHomeFolder(root), "read");
    try {
      answers.records = recordsOf(reader, gone, "sample");
      expect((answers.records as { heads: unknown[] }).heads).toHaveLength(2);
    } finally {
      reader.close();
    }
    writeArtifact("device-retire", answers);
  });

  it("a device the CLI retires with no home running stays the owner's, or its row is not retired", async () => {
    const root = tempDir("device-retire-cli");
    cleanup.push(() => removeDir(root));
    writeFolder(root);
    mkdirSync(join(root, "replies"), { recursive: true });
    const path = join(root, "home.db");
    openHome(openHomeFolder(root), "migrate").close();
    const raw = new Database(path);
    const add = raw.prepare("INSERT INTO devices (unit, model, added_ms) VALUES (?, ?, ?)");
    add.run(GONE, "Synthetic iPhone", T0 - 30 * DAY);
    add.run("macbook-pro-0001", "Synthetic MacBook Pro", T0 - 30 * DAY);
    raw.close();

    const before = await cli(root, ["status", "--json"]);
    expect([await rowOf(root, GONE), unitNeeds(before.result)]).toEqual([{ state: "ok", retired: false }, []]);
    const retired = await cli(root, ["device", "retire", GONE]);
    expect(retired.result).toEqual({ unit: GONE, model: "Synthetic iPhone", added_ms: T0 - 30 * DAY, retired_ms: T0 + 2 * DAY });
    const after = await cli(root, ["status", "--json"]);
    expect([await rowOf(root, GONE), unitNeeds(after.result)]).toEqual([{ state: "off", retired: true }, []]);
    writeArtifact("device-retire-cli", { before: (before.result as unknown as StatusReport).needs, retired: retired.result, after: (after.result as unknown as StatusReport).needs });
  });
});
