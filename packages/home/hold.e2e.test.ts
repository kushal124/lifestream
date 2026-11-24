import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { openHomeFolder, tryLock, type FileLock } from "@lifestreamprotocol/core";
import { LEDGER_DAMAGED_EXIT } from "@lifestreamprotocol/model";
import { runCli } from "./cli.js";
import { startHome, type Home } from "./home.js";
import { admitAsk, beginCheck, hold, holdLine, holdWords, readHold, release, type Hold } from "./hold.js";
import { processStart, running, stale } from "./hold-check.js";
import { awayWords, HOME_FORMAT, HomeRoot, readHome as readHomeJson } from "./lifecycle.js";
import { machine } from "./machine.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { artifact, FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openDoor } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";


const MINUTE = 60_000;
const NOTES = "apple-notes:local:device-a";
const start = (root: string, logs: string[], call?: readonly string[]): Promise<Home> =>
  startHere(root, { tickMs: TICK_MS, log: (line) => logs.push(line), ...(call === undefined ? {} : { call }) });

function waitingStart(root: string): { started: Promise<Home>; logs: string[] } {
  const logs: string[] = [];
  return { started: startHere(root, { tickMs: TICK_MS, log: (line) => logs.push(line) }), logs };
}

const door = (root: string) => openDoor(root);

async function knock(url: string): Promise<{ status: number; code: unknown; wait: unknown; title: unknown; line: unknown; acts: unknown; retry: string | null }> {
  const response = await fetch(`${url}/v1/status`);
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, code: body.code, wait: body.wait, title: body.title, line: body.line, acts: body.acts, retry: response.headers.get("retry-after") };
}

async function saying(url: string, title: string): Promise<Answer> {
  let last: Answer | undefined;
  let asking: Promise<void> | null = null;
  await until(`the door says ${title}`, () => {
    asking ??= knock(url).then((each) => { last = each; }, () => undefined).finally(() => { asking = null; });
    return last?.title === title;
  });
  return last!;
}

async function checkAgain(url: string, token: string): Promise<{ status: number; code: unknown }> {
  const response = await fetch(`${url}/v1/home/verify`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, code: body.code ?? null };
}

const pass = (root: string, unit: string, scopes: string[], kind?: "mac" | "phone" | "extension"): string =>
  mintPrincipal(openHomeFolder(root), { unit, scopes: scopes as never, sources: scopes.includes("deliver") ? [NOTES] : [], ...(kind === undefined ? {} : { kind }), now_ms: 0 }).token;

const CHECKING = "Lifestream is checking its database";
const DAMAGED = "Lifestream's database is damaged";
const CHECK_AGAIN = [{ do: "verify", label: "Check again" }];

const checks = (logs: readonly string[]) => lines(logs).filter((line) => line.home === "checking" || line.home === "checked").map((line) => line.checked ?? line.home);

type Answer = Awaited<ReturnType<typeof knock>>;

async function answered(url: string, status: number): Promise<Answer> {
  let last: Answer | undefined;
  let asking: Promise<void> | null = null;
  await until(`the door answers ${status}`, () => {
    asking ??= knock(url).then((each) => { last = each; }, () => undefined).finally(() => { asking = null; });
    return last?.status === status;
  });
  return last!;
}

const lines = (logs: readonly string[]) => logs.map((line) => JSON.parse(line) as Record<string, unknown>);
const note = (key: string, at: number) => ({ kind: "note", key, content: { text: `synthetic note ${key}`, at }, at });

async function home(root: string, args: string[]): Promise<{ status: number; out: string }> {
  let out = "";
  const status = await runCli([...args, "--root", root], { write: (text) => { out += text; } });
  return { status, out };
}

function corruptNext(first: () => void = () => undefined): void {
  const exec = Database.prototype.exec;
  let met = false;
  Database.prototype.exec = function (this: Database.Database, sql: string) {
    if (met || sql !== "BEGIN IMMEDIATE" || !this.name.endsWith("home.db")) return exec.call(this, sql);
    met = true;
    first();
    throw new Database.SqliteError("database disk image is malformed", "SQLITE_CORRUPT");
  } as typeof exec;
  onTestFinished(() => { Database.prototype.exec = exec; });
}

function driveLeft(): void {
  const reads = HomeRoot.reads;
  HomeRoot.reads = () => false;
  onTestFinished(() => { HomeRoot.reads = reads; });
}

async function holdOnceLockFrees(root: string, id: string): Promise<ReturnType<typeof readHold>> {
  let lock: FileLock | null = null;
  await until("home.lock freed", () => (lock = tryLock(join(root, "home.lock"))) !== null);
  const held = readHold(machine(), id);
  (lock as FileLock | null)?.release();
  return held;
}

describe("the look tests what was opened; the hold says what happened", () => {
  it("a descriptor that no longer reads looks false with the path matching; so do a root closed and another folder at the path", () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-look-"));
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, "HOME.json"), JSON.stringify({ format: HOME_FORMAT, id: "look-home", created: "2026-11-10T00:00:00Z" }));
    const root = HomeRoot.open(folder);
    onTestFinished(() => root.close());
    const path = statSync(folder, { bigint: true });
    const reads = HomeRoot.reads;
    const looked: Record<string, boolean> = { opened: root.look() };
    HomeRoot.reads = () => false;
    looked.left = root.look();
    HomeRoot.reads = reads;
    const now = statSync(folder, { bigint: true });
    looked.samePath = now.dev === path.dev && now.ino === path.ino;
    root.close();
    looked.closed = root.look();
    const second = HomeRoot.open(folder);
    onTestFinished(() => second.close());
    renameSync(folder, `${folder}-aside`);
    onTestFinished(() => rmSync(`${folder}-aside`, { recursive: true, force: true }));
    mkdirSync(folder);
    copyFileSync(join(`${folder}-aside`, "HOME.json"), join(folder, "HOME.json"));
    looked.replaced = second.look();
    expect(looked).toEqual({ opened: true, left: false, samePath: true, closed: false, replaced: false });
  });

  it("the words: checking while unjudged, running or asked; a finding, a file missing, a drive that left and a check that stopped offer Check again; no clock time, no operator text; the log's line keeps the database, the size and the findings; a file that is not a hold holds, unjudged", () => {
    const folder = mkdtempSync(join(tmpdir(), "lifestream-words-"));
    onTestFinished(() => rmSync(folder, { recursive: true, force: true }));
    writeFileSync(join(folder, "home.db"), Buffer.alloc(2_600_000));
    mkdirSync(join(folder, "replies"));
    writeFileSync(join(folder, "replies", "replies.db"), Buffer.alloc(400_000));
    const met = { met: "home.db" as const, error: "SQLITE_CORRUPT: database disk image is malformed" };
    const at_ms = Date.UTC(2026, 10, 9, 17, 8);
    const found: Hold = { since_ms: at_ms, cause: met, check: { found: ["home.db is damaged: SQLite finds 2nd reference to page 7", `home.db: 1 record points at content the home does not hold (such as ${NOTES} note n1)`], at_ms } };
    const words = {
      unjudged: holdWords({ since_ms: at_ms, cause: met, check: null }),
      running: holdWords({ since_ms: at_ms, cause: met, check: { running_since_ms: at_ms, pid: 1 << 30, started: "Thu Jan  1 00:00:00 1970" } }),
      asked: holdWords(found, true),
      found: holdWords(found),
      ledger: holdWords({ ...found, cause: { met: "the ledger", error: "SQLITE_NOTADB" } }),
      missing: holdWords({ since_ms: at_ms, cause: { missing: "home.db" }, check: { found: ["home.db is not there"], at_ms } }),
      drive: holdWords({ since_ms: at_ms, cause: met, check: { unfinished: "drive", at_ms } }),
      stopped: holdWords({ since_ms: at_ms, cause: met, check: { unfinished: "stopped", at_ms } }),
    };
    const checking = { message: CHECKING, detail: "It starts again when the check ends, up to an hour", acts: [] };
    const unfinished = (detail: string) => ({ message: "Lifestream's database check stopped", detail, acts: CHECK_AGAIN });
    const putBack = "Put back a copy from a backup";
    expect(words).toEqual({
      unjudged: checking,
      running: checking,
      asked: checking,
      found: { message: DAMAGED, detail: putBack, acts: CHECK_AGAIN },
      ledger: { message: DAMAGED, detail: putBack, acts: CHECK_AGAIN },
      missing: { message: "Lifestream's database is missing", detail: putBack, acts: CHECK_AGAIN },
      drive: unfinished("Connect its drive and it checks again"),
      stopped: unfinished("Check it again"),
    });
    expect(JSON.stringify(Object.values(words))).not.toMatch(/\d:\d\d|lifestream verify|SQLite|SQLITE|next start|apple-notes|home\.db|ledger/u);
    expect(holdLine(found, folder)).toBe(`${DAMAGED}: ${putBack} (home.db; ${(found.check as { found: string[] }).found.join("; ")})`);
    expect(holdLine({ since_ms: at_ms, cause: met, check: null }, folder)).toBe(`${CHECKING}: ${checking.detail} (home.db; checking 3 MB)`);

    const at = machine();
    const id = "words-not-a-hold";
    onTestFinished(() => release(at, id));
    hold(at, id, { since_ms: at_ms, cause: met, check: null });
    writeFileSync(join(at.dir, "hold", `${id}.json`), "{\"reason\":\"damaged\"");
    expect(readHold(at, id)).toEqual({ since_ms: 0, cause: { met: "home.db", error: `${join(at.dir, "hold", `${id}.json`)} is not a hold` }, check: null });
  });
});

describe("a drive that leaves is not damage", () => {
  it("CORRUPT with the folder taken away in the wait holds nothing, and the home starts when it returns", async () => {
    const root = makeRoot("lifestream-leaves-", { sources: { [NOTES]: "fake-rows" } });
    const away = `${root}-away`;
    onTestFinished(() => { removeRoot(root); removeRoot(away); });
    const { id } = readHomeJson(root);
    const logs: string[] = [];
    const running = await startHere(root, { tickMs: TICK_MS, log: (line) => {
      logs.push(line);
      if (JSON.parse(line).storage === "failed") renameSync(root, away);
    } });
    corruptNext();
    const why = await running.stopped;
    expect(why).toMatch(/^storage: SQLITE_CORRUPT/u);
    expect(readHold(machine(), id)).toBeNull();

    const waiting = waitingStart(root);
    await until("the start waits for the folder", () => lines(waiting.logs).some((line) => line.home === "waiting"));
    expect(lines(waiting.logs)).toEqual([{ at: expect.any(String), home: "waiting", why: awayWords(root) }]);
    renameSync(away, root);
    const again = await waiting.started;
    await until("the home ticks on its folder", () => again.stats().ticks.count > 0);
    expect(readHold(machine(), id)).toBeNull();
    artifact(root, "drive-leaves", { why, log: lines(logs), waiting: lines(waiting.logs) });
  });

  it("CORRUPT while what the home opened no longer reads, at the same path: no hold, the home stops for launchd's restart, which serves", async () => {
    const root = makeRoot("lifestream-left-back-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { id } = readHomeJson(root);
    const running = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    const reads = HomeRoot.reads;
    corruptNext(() => driveLeft());
    const why = await running.stopped;
    expect(why).toBe(awayWords(root));
    expect(readHold(machine(), id)).toBeNull();
    HomeRoot.reads = reads;
    const again = await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    await until("the home ticks again", () => again.stats().ticks.count > 0);
    expect(readHold(machine(), id)).toBeNull();
    artifact(root, "drive-left-and-back", { why });
  });

  it("the hold is on the disk before home.lock frees; the waiting start checks it as its child, finds the file whole, and starts with no person", async () => {
    const root = makeRoot("lifestream-hold-lock-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { id } = readHomeJson(root);
    onTestFinished(() => release(machine(), id));
    const served = await door(root);
    const running = await startHere(root, { tickMs: TICK_MS, lookMs: 150, log: () => undefined });
    corruptNext();
    const held = await holdOnceLockFrees(root, id);
    expect(held).toMatchObject({ cause: { met: "home.db", error: expect.stringMatching(/^SQLITE_CORRUPT/u) }, check: null });
    await running.stopped;
    expect(await saying(served.url, CHECKING)).toMatchObject({ status: 503, code: "NOT_NOW", wait: "needs", line: "It starts again when the check ends, up to an hour", acts: [] });
    const waiting = waitingStart(root);
    const again = await waiting.started;
    await until("the home ticks again", () => again.stats().ticks.count > 0);
    expect({ hold: readHold(machine(), id), checks: checks(waiting.logs) }).toEqual({ hold: null, checks: ["checking", "whole"] });
    await answered(served.url, 401);
    artifact(root, "hold-before-lock", { held, waiting: lines(waiting.logs) });
  });

  it("a commit that meets CORRUPT while the home stops holds it", async () => {
    const root = makeRoot("lifestream-hold-stopping-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { id } = readHomeJson(root);
    onTestFinished(() => release(machine(), id));
    const running = await start(root, []);
    corruptNext(() => void running.stop());
    expect(await running.stopped).toMatch(/^storage: SQLITE_CORRUPT/u);
    expect(readHold(machine(), id)).toMatchObject({ cause: { met: "home.db", error: expect.stringMatching(/^SQLITE_CORRUPT/u) }, check: null });
  });

  it("a start that meets CORRUPT closes what it opened, holds, and only then lets home.lock go", async () => {
    const root = makeRoot("lifestream-hold-start-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const { id } = readHomeJson(root);
    onTestFinished(() => release(machine(), id));
    corruptNext();
    const started = startHere(root, { tickMs: TICK_MS, lookMs: 150, log: () => undefined });
    await until("the start took the lock", () => {
      const lock = tryLock(join(root, "home.lock"));
      lock?.release();
      return lock === null;
    });
    const held = await holdOnceLockFrees(root, id);
    await expect(started).rejects.toThrow(/malformed/u);
    expect(held).toMatchObject({ cause: { met: "home.db", error: expect.stringMatching(/^SQLITE_CORRUPT/u) }, check: null });
    expect(existsSync(join(root, "home.db-wal"))).toBe(false);
    artifact(root, "hold-at-start", { held });
  });
});

describe("damage stops the home; nothing else does", () => {
  it("a home.db with overwritten pages: the home stops at its first CORRUPT, held; the waiting start checks it, finds it and keeps the hold, the door saying so with Check again; a good copy put back and Check again pressed on a phone, it starts", async () => {
    const root = makeRoot("lifestream-damage-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const phone = pass(root, "iphone-0001", ["deliver", "read"], "phone");
    const at_ms = Date.now() - 10 * MINUTE;

    const first = await start(root, []);
    await ship(root, { source: NOTES, fetched_ms: at_ms, rows: [note("n1", at_ms), note("n2", at_ms)] });
    await until("the first delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    await first.stop();
    const good = `${root}-good.db`;
    onTestFinished(() => rmSync(good, { force: true }));
    copyFileSync(join(root, "home.db"), good);

    const pages = readHome(root, (db) => db.prepare("SELECT pageno FROM dbstat WHERE name = 'versions'").pluck().all() as number[]);
    const size = readHome(root, (db) => db.pragma("page_size", { simple: true }) as number);
    const bytes = readFileSync(join(root, "home.db"));
    for (const page of pages) bytes.fill(0x2a, (page - 1) * size, page * size);
    writeFileSync(join(root, "home.db"), bytes);

    const damagedLogs: string[] = [];
    const damaged = await start(root, damagedLogs);
    await ship(root, { source: NOTES, fetched_ms: at_ms + MINUTE, rows: [note("n3", at_ms + MINUTE)] });
    const why = await damaged.stopped;
    expect(why).toMatch(/^storage: SQLITE_CORRUPT/u);
    expect(lines(damagedLogs).filter((line) => line.storage === "failed")).toEqual([expect.objectContaining({ error: expect.stringMatching(/^SQLITE_CORRUPT/u) })]);
    expect(readHold(at, id)).toMatchObject({ cause: { met: "home.db" }, check: null });

    const served = await door(root);
    const waiting = waitingStart(root);
    await until("the start checked and found the damage", () => checks(waiting.logs).includes("found"));
    const held = readHold(at, id)!;
    expect(held).toMatchObject({ cause: { met: "home.db" }, check: { found: [expect.stringMatching(/^home\.db is damaged: SQLite /u)] } });
    await until("the start waits on what it found", () => lines(waiting.logs).at(-1)?.home === "waiting");
    expect(lines(waiting.logs).at(-1)).toEqual({ at: expect.any(String), home: "waiting", why: holdLine(held, root) });
    expect(existsSync(testSocket(root).path)).toBe(false);

    const refused = await saying(served.url, DAMAGED);
    const words = holdWords(held);
    expect(refused).toEqual({ status: 503, code: "NOT_NOW", wait: "needs", title: words.message, line: words.detail, acts: words.acts, retry: "60" });
    expect(refused).toMatchObject({ wait: "needs", line: "Put back a copy from a backup", acts: CHECK_AGAIN });

    for (const suffix of ["", "-wal", "-shm"]) rmSync(join(root, `home.db${suffix}`), { force: true });
    copyFileSync(good, join(root, "home.db"));
    expect(await checkAgain(served.url, phone)).toEqual({ status: 202, code: null });
    await waiting.started;
    expect({ hold: readHold(at, id), checks: checks(waiting.logs) }).toEqual({ hold: null, checks: ["checking", "found", "checking", "whole"] });
    await until("the delivery sealed during the damage imported from the inbox", () =>
      readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 2);
    await answered(served.url, 401);
    artifact(root, "damage", { why, held, refused, door: lines(served.logs), waiting: lines(waiting.logs) });
  });

  it("a head whose version row is gone fails its job with the named need, and the home runs on; verify names it", async () => {
    const root = makeRoot("lifestream-missing-version-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const day = Date.UTC(2026, 9, 1, 10);
    const first = await start(root, []);
    await ship(root, { source: NOTES, fetched_ms: day, rows: [note("n1", day)] });
    await until("n1 extracted", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM extracts WHERE family = 'notes'").pluck().get()) === 1);
    await first.stop();
    const db = new Database(join(root, "home.db"));
    db.prepare("DELETE FROM version_blobs WHERE version = (SELECT version FROM heads WHERE key = 'n1')").run();
    db.prepare("DELETE FROM versions WHERE id = (SELECT version FROM heads WHERE key = 'n1')").run();
    db.close();

    const logs: string[] = [];
    const running = await start(root, logs);
    let stopped = false;
    void running.stopped.then(() => { stopped = true; });
    await ship(root, { source: NOTES, fetched_ms: day + MINUTE, rows: [note("n2", day + MINUTE)] });
    const need = "a record points at content the home does not hold";
    await until("the extract failed with the need", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM jobs WHERE kind = 'extract' AND instr(error, ?) > 0").pluck().get(need)) === 1);
    const later = Date.UTC(2026, 9, 2, 10);
    await ship(root, { source: NOTES, fetched_ms: later, rows: [note("n3", later)] });
    await until("n3 imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 3);
    expect(stopped).toBe(false);
    const error = readHome(root, (db) => db.prepare("SELECT error FROM jobs WHERE kind = 'extract' AND error IS NOT NULL").pluck().get()) as string;
    expect(error).toMatch(/^a record points at content the home does not hold \(version [^)]+\): run lifestream verify$/u);
    expect(lines(logs).filter((line) => line.storage !== undefined || /TypeError/u.test(JSON.stringify(line)))).toEqual([]);
    await running.stop();

    const { id } = readHomeJson(root);
    onTestFinished(() => release(machine(), id));
    const verified = await home(root, ["verify"]);
    expect(verified.status).toBe(1);
    expect(verified.out).toContain(`home.db: 1 record points at content the home does not hold (such as ${NOTES} note n1)`);
    expect(verified.out.trim().split("\n").at(-1)).toBe("The home does not hold, and stays held: put back a good copy of the file it names, then run lifestream verify again.");
    expect(readHold(machine(), id)).toMatchObject({ cause: { met: "home.db" }, check: { found: [expect.stringContaining("1 record points at content")] } });
    const json = await home(root, ["verify", "--json"]);
    expect([json.status, JSON.parse(json.out)]).toEqual([1, { holds: false, wrong: [expect.stringContaining("1 record points at content")], hold: expect.objectContaining({ cause: expect.objectContaining({ met: "home.db" }) }) }]);
    artifact(root, "missing-version", { error, verify: verified.out });
  });

  it("a version whose text no longer hashes to its id passes lifestream verify: it reads the structure only", async () => {
    const root = makeRoot("lifestream-hold-hash-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const day = Date.UTC(2026, 9, 1, 10);
    const running = await start(root, []);
    await ship(root, { source: NOTES, fetched_ms: day, rows: [note("n1", day)] });
    await until("n1 imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    await running.stop();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(machine(), id));
    const db = new Database(join(root, "home.db"));
    db.prepare("UPDATE versions SET text = x'00' WHERE rowid = (SELECT min(rowid) FROM versions)").run();
    db.close();
    const verified = await home(root, ["verify"]);
    expect({ status: verified.status, hold: readHold(machine(), id) }).toEqual({ status: 0, hold: null });
    const json = await home(root, ["verify", "--json"]);
    expect([json.status, JSON.parse(json.out)]).toEqual([0, { holds: true, wrong: [], hold: null }]);
  });

  it("a page claimed by two tables never passes: verify names it in SQLite's words, as each file begins and ends, holds the home, and changes no byte", async () => {
    const root = makeRoot("lifestream-torn-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const at_ms = Date.now() - 10 * MINUTE;
    const first = await start(root, []);
    await ship(root, { source: NOTES, fetched_ms: at_ms, rows: [note("n1", at_ms)] });
    await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    await first.stop();
    const db = new Database(join(root, "home.db"));
    const events = db.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'events'").pluck().get() as number;
    db.unsafeMode(true);
    db.pragma("writable_schema = ON");
    db.prepare("UPDATE sqlite_master SET rootpage = ? WHERE name = 'runs'").run(events);
    db.pragma("writable_schema = OFF");
    db.close();
    const before = readFileSync(join(root, "home.db"));

    const verified = await home(root, ["verify"]);
    expect(verified.status).toBe(1);
    const said = verified.out.trim().split("\n");
    expect(said.some((line) => /^home\.db: checking its [\d.]+ GB$/u.test(line)), verified.out).toBe(true);
    expect(said.find((line) => line.startsWith("home.db is damaged: SQLite finds"))).toMatch(new RegExp(`2nd reference to page ${events}`, "u"));
    expect(said.find((line) => line.startsWith("home.db: checked, in"))).toMatch(/^home\.db: checked, in \d+\.\d s$/u);
    expect(said.find((line) => line.startsWith("the ledger: whole, in"))).toMatch(/^the ledger: whole, in \d+\.\d s$/u);
    expect(said.at(-1)).toBe("The home does not hold, and stays held: put back a good copy of the file it names, then run lifestream verify again.");
    expect(readHold(at, id)).toMatchObject({ cause: { met: "home.db" }, check: { found: [expect.stringContaining(`2nd reference to page ${events}`)] } });
    expect(readFileSync(join(root, "home.db")).equals(before)).toBe(true);
    artifact(root, "torn", { verify: verified.out, bytes: statSync(join(root, "home.db")).size });
  });

  it("a lost ledger never passes: a verb or a start holds it damaged before it opens anything to write, a start waits, verify names it, and none makes it again", async () => {
    const root = makeRoot("lifestream-lost-ledger-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const at_ms = Date.now() - 10 * MINUTE;
    const first = await start(root, []);
    await ship(root, { source: NOTES, fetched_ms: at_ms, rows: [note("n1", at_ms)] });
    await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    await first.stop();
    const ledger = join(root, "replies", "replies.db");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${ledger}${suffix}`, { force: true });

    const lost = "the ledger is not there, though the home has run here: it is never made again empty";
    const changed = await home(root, ["settings", "set", "door.port", "4999"]);
    expect(changed).toEqual({ status: 1, out: `${holdLine(readHold(at, id)!, root)}\n` });
    expect({ hold: readHold(at, id), ledger: existsSync(ledger), replies: existsSync(join(root, "replies")) })
      .toEqual({ hold: { since_ms: expect.any(Number), cause: { missing: "the ledger" }, check: { found: [lost], at_ms: expect.any(Number) } }, ledger: false, replies: true });
    expect(holdWords(readHold(at, id)!)).toEqual({ message: "Lifestream's database is missing", detail: "Put back a copy from a backup", acts: CHECK_AGAIN });
    expect(holdLine(readHold(at, id)!, root)).toMatch(/\(the ledger is not in its folder; /u);
    const again = await home(root, ["settings", "set", "door.port", "4999"]);
    expect(again).toEqual(changed);
    expect(effective(root).settings.door.port).not.toBe(4999);
    release(at, id);
    const waiting = waitingStart(root);
    await until("the start held the home", () => readHold(at, id) !== null);
    await until("the start waits on it", () => lines(waiting.logs).some((line) => line.home === "waiting"));
    expect(lines(waiting.logs).map(({ at: _, ...line }) => line)).toEqual([{ home: "waiting", why: holdLine(readHold(at, id)!, root) }]);
    expect(readHold(at, id)).toMatchObject({ cause: { missing: "the ledger" }, check: { found: [lost] } });
    expect(existsSync(ledger)).toBe(false);

    const verified = await home(root, ["verify"]);
    expect(verified.status).toBe(1);
    expect(verified.out.split("\n")[0]).toBe(lost);
    expect(verified.out).toContain("The home does not hold, and stays held");
    expect(existsSync(ledger)).toBe(false);
    artifact(root, "lost-ledger", { verb: [changed.out, again.out], waiting: lines(waiting.logs), verify: verified.out });
  });

  it("a call process that meets the ledger damaged stops the home, held damaged, as the home's own read of it would", async () => {
    const root = makeRoot("lifestream-call-damage-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const call = join(root, "damaged-call.mjs");
    writeFileSync(call, `process.stderr.write("the ledger is damaged: database disk image is malformed\\n");\nprocess.exit(${LEDGER_DAMAGED_EXIT});\n`);
    const logs: string[] = [];
    const running = await start(root, logs, [process.execPath, call]);
    const at_ms = Date.now() - 10 * MINUTE;
    await ship(root, { source: NOTES, fetched_ms: at_ms, rows: [{ ...note("n1", at_ms), content: { text: "synthetic note n1", at: at_ms, photo: true } }] });
    const why = await running.stopped;
    expect(why).toMatch(/^storage: SQLITE_CORRUPT: a call process met the ledger damaged/u);
    expect(readHold(at, id)).toMatchObject({ cause: { met: "the ledger", error: expect.stringContaining("a call process met the ledger damaged") }, check: null });
    expect(lines(logs).filter((line) => line.storage === "failed")).toHaveLength(1);
    artifact(root, "call-damage", { why, hold: readHold(at, id) });
  });
});

describe("the folder is the whole home, and the home waits for it", () => {
  it("a folder renamed away and back while the home and the door run: both wait, the door says which path, and both go on", async () => {
    const root = makeRoot("lifestream-away-", { sources: { [NOTES]: "fake-rows" } });
    const away = `${root}-away`;
    onTestFinished(() => { removeRoot(root); removeRoot(away); });
    const served = await door(root);
    const running = await start(root, []);
    expect((await knock(served.url)).status).toBe(401);

    renameSync(root, away);
    expect(await running.stopped).toBe(awayWords(root));
    const waiting = waitingStart(root);
    expect(await answered(served.url, 503)).toEqual({ status: 503, code: "NOT_NOW", wait: "needs", title: "Lifestream's folder isn't there",
      line: `Lifestream waits for it at ${root}`, acts: [], retry: "60" });
    await until("the start waits for the folder", () => lines(waiting.logs).some((line) => line.home === "waiting"));
    expect(lines(waiting.logs)).toEqual([{ at: expect.any(String), home: "waiting", why: awayWords(root) }]);

    renameSync(away, root);
    const again = await waiting.started;
    await answered(served.url, 401);
    const at_ms = Date.now() - MINUTE;
    await ship(root, { source: NOTES, fetched_ms: at_ms, rows: [note("back", at_ms)] });
    await until("the delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get()) === 1);
    await again.stop();
    expect(lines(served.logs).filter((line) => line.door !== undefined).map((line) => [line.door, line.why ?? null])).toEqual([
      ["open", null], ["waiting", awayWords(root)], ["serving", null],
    ]);
    artifact(root, "folder-away", { door: lines(served.logs), waiting: lines(waiting.logs) });
  });

  it("a hold written while the home and the door run: the home stops, the door says why; Check again from a Mac reads as checking at once, a second press queues nothing, and the one check finds the home whole and releases it", async () => {
    const root = makeRoot("lifestream-held-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const mac = pass(root, "macbook-pro-0001", ["deliver"], "mac");
    const served = await door(root);
    const running = await start(root, []);
    const held: Hold = { since_ms: Date.now(), cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: { found: ["home.db is damaged: synthetic"], at_ms: Date.now() } };
    hold(at, id, held);
    expect(await running.stopped).toBe(holdLine(held, root));
    expect(await answered(served.url, 503)).toMatchObject({ status: 503, code: "NOT_NOW", wait: "needs", title: DAMAGED, acts: CHECK_AGAIN, retry: "60" });
    expect(await checkAgain(served.url, mac)).toEqual({ status: 202, code: null });
    expect(await knock(served.url)).toMatchObject({ status: 503, wait: "needs", title: CHECKING, acts: [] });
    expect(await checkAgain(served.url, mac)).toEqual({ status: 409, code: "CHECKING" });
    const waiting = waitingStart(root);
    const again = await waiting.started;
    expect({ hold: readHold(at, id), ask: existsSync(join(at.dir, "hold", `${id}.ask`)), checks: checks(waiting.logs) }).toEqual({ hold: null, ask: false, checks: ["checking", "whole"] });
    await answered(served.url, 401);
    await again.stop();
    artifact(root, "held", { door: lines(served.logs), waiting: lines(waiting.logs) });
  });

  it("Check again: 409 NOT_HELD with no hold; 403 on a reader's, the MCP server's, a station's or the drive pass; 202 on a Mac's, its part closed, then 409 CHECKING while the ask waits", async () => {
    const root = makeRoot("lifestream-check-again-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const passes = {
      read: pass(root, "reader-0001", ["read"]), admit: pass(root, "mcp-0001", ["admit"]), station: pass(root, "chrome-0001", ["station"], "extension"),
      drive: pass(root, "home", ["drive"]), mac: pass(root, "macbook-pro-0001", ["deliver"], "mac"), phone: pass(root, "iphone-0001", ["deliver", "read"], "phone"),
    };
    const served = await door(root);
    const free = await (await fetch(`${served.url}/v1/home/verify`, { method: "POST", headers: { authorization: `Bearer ${passes.phone}` } })).json();
    hold(at, id, { since_ms: Date.now(), cause: { missing: "home.db" }, check: { found: ["home.db is not there"], at_ms: Date.now() } });
    await saying(served.url, "Lifestream's database is missing");
    const asked: Record<string, unknown> = {};
    for (const [name, token] of Object.entries(passes)) asked[name] = await checkAgain(served.url, token);
    expect({ free, asked, ask: existsSync(join(at.dir, "hold", `${id}.ask`)) }).toEqual({
      free: { code: "NOT_HELD", message: "Lifestream is running: there is nothing to check." },
      asked: {
        read: { status: 403, code: "PRINCIPAL_SCOPE" }, admit: { status: 403, code: "PRINCIPAL_SCOPE" }, station: { status: 403, code: "PRINCIPAL_SCOPE" },
        drive: { status: 403, code: "PRINCIPAL_SCOPE" }, mac: { status: 202, code: null }, phone: { status: 409, code: "CHECKING" },
      },
      ask: true,
    });
  });

  it("a check killed mid-run: a press meanwhile is refused; the hold reads that it stopped, with Check again; that start runs it no more, and the next start runs it again and starts", async () => {
    const root = makeRoot("lifestream-check-killed-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const phone = pass(root, "iphone-0001", ["deliver", "read"], "phone");
    const served = await door(root);
    hold(at, id, { since_ms: Date.now(), cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: null });
    const pidFile = join(root, "check.pid");
    const killed = join(root, "killed-check.mjs");
    writeFileSync(killed, [
      'import { execFileSync } from "node:child_process";',
      'import { readFileSync, writeFileSync } from "node:fs";',
      `const path = ${JSON.stringify(join(at.dir, "hold", `${id}.json`))};`,
      "const started = execFileSync(\"ps\", [\"-o\", \"lstart=\", \"-p\", String(process.pid)], { encoding: \"utf8\" }).trim();",
      "writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, \"utf8\")), check: { running_since_ms: Date.now(), pid: process.pid, started } }));",
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => undefined, 1 << 30);",
    ].join("\n"));
    const logs: string[] = [];
    const first = new AbortController();
    onTestFinished(() => first.abort());
    const waiting = startHome(root, { stopGraceMs: 50, registry: FAKES, lookMs: LOOK_MS, tickMs: TICK_MS, verify: [process.execPath, killed], signal: first.signal, log: (line) => logs.push(line) });
    waiting.catch(() => undefined);
    await until("the check runs", () => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    await until("the check names itself", () => { const check = readHold(at, id)?.check; return check != null && "pid" in check && check.pid === pid; });
    expect(await checkAgain(served.url, phone)).toEqual({ status: 409, code: "CHECKING" });
    expect(existsSync(join(at.dir, "hold", `${id}.ask`))).toBe(false);
    process.kill(pid, "SIGKILL");
    await until("the start waits after the check", () => lines(logs).at(-1)?.home === "waiting");
    expect({ check: readHold(at, id)!.check, checks: checks(logs) }).toEqual({ check: { unfinished: "stopped", at_ms: expect.any(Number) }, checks: ["checking", "stopped"] });
    expect(await saying(served.url, "Lifestream's database check stopped")).toMatchObject({ wait: "needs", line: "Check it again", acts: CHECK_AGAIN });
    first.abort();
    await expect(waiting).rejects.toThrow();
    const next = waitingStart(root);
    await next.started;
    expect({ hold: readHold(at, id), checks: checks(next.logs) }).toEqual({ hold: null, checks: ["checking", "whole"] });
    artifact(root, "check-killed", { first: lines(logs), next: lines(next.logs) });
  });

  it("a check's process gone, or its pid now another process's, is stale; a hold reading running in one is judged stopped by the next start, which checks and starts", async () => {
    const root = makeRoot("lifestream-check-orphan-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const cause = { met: "home.db" as const, error: "SQLITE_CORRUPT: synthetic" };
    const gone = spawn(process.execPath, ["-e", ""]);
    await new Promise((resolve) => gone.once("exit", resolve));
    const here = processStart(process.pid)!;
    expect({
      gone: stale({ since_ms: 0, cause, check: { running_since_ms: Date.now(), pid: gone.pid!, started: here } }),
      live: stale({ since_ms: 0, cause, check: { running_since_ms: Date.now(), pid: process.pid, started: here } }),
    }).toEqual({ gone: true, live: false });
    hold(at, id, { since_ms: Date.now(), cause, check: { running_since_ms: Date.now(), pid: process.pid, started: "Thu Jan  1 00:00:00 1970" } });
    const next = waitingStart(root);
    await next.started;
    expect({ hold: readHold(at, id), checks: checks(next.logs) }).toEqual({ hold: null, checks: ["stopped", "checking", "whole"] });
  });

  it("a press and a check's start are one at a time under the hold's lock: a press admitted is taken by the check, a press inside the start waits for it, and then reads checking", () => {
    const at = machine();
    const id = "admit-home";
    onTestFinished(() => release(at, id));
    const askFile = join(at.dir, "hold", `${id}.ask`);
    const found: Hold = { since_ms: 1, cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: { found: ["home.db is damaged: synthetic"], at_ms: 1 } };
    hold(at, id, found);
    const steps: unknown[] = [admitAsk(at, id), existsSync(askFile)];
    beginCheck(at, id, running());
    steps.push(existsSync(askFile), admitAsk(at, id), existsSync(askFile));
    hold(at, id, found);
    steps.push(admitAsk(at, id, () => {
      steps.push((() => { try { beginCheck(at, id, running(), 0); return "began"; } catch { return "waited"; } })());
    }));
    beginCheck(at, id, running());
    steps.push(existsSync(askFile), admitAsk(at, id));
    expect(steps).toEqual(["asked", true, false, "checking", false, "waited", "asked", false, "checking"]);
  });

  it("a drive that left during the check and is back: the check runs again with no press, once what the start opened before it no longer reads", async () => {
    const root = makeRoot("lifestream-check-drive-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    hold(at, id, { since_ms: Date.now(), cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: null });
    const first = join(root, "check-1");
    const go = join(root, "check-go");
    const check = join(root, "drive-check.mjs");
    const path = join(at.dir, "hold", `${id}.json`);
    writeFileSync(check, [
      'import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
      `const [path, first, go] = ${JSON.stringify([path, first, go])};`,
      "if (!existsSync(first)) {",
      "  writeFileSync(first, \"\");",
      "  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, \"utf8\")), check: { unfinished: \"drive\", at_ms: Date.now() } }));",
      "  process.exit(1);",
      "}",
      "const wait = setInterval(() => { if (existsSync(go)) { clearInterval(wait); rmSync(path); } }, 20);",
    ].join("\n"));
    const logs: string[] = [];
    const waiting = startHere(root, { tickMs: TICK_MS, verify: [process.execPath, check], log: (line) => logs.push(line) });
    await until("the first check ended: its drive left", () => checks(logs).includes("drive"));
    await until("the start waits", () => lines(logs).at(-1)?.home === "waiting");
    expect(checks(logs)).toEqual(["checking", "drive"]);
    const open = HomeRoot.open;
    let flapped = 0;
    HomeRoot.open = (path, clock) => {
      if (flapped++ === 0) throw new Error("ENOENT: synthetic, the drive gone again");
      return open.call(HomeRoot, path, clock);
    };
    onTestFinished(() => { HomeRoot.open = open; });
    const reads = HomeRoot.reads;
    driveLeft();
    await until("the check runs again", () => checks(logs).length === 3);
    HomeRoot.open = open;
    expect(flapped).toBeGreaterThan(1);
    HomeRoot.reads = reads;
    writeFileSync(go, "");
    await waiting;
    expect({ hold: readHold(at, id), ask: existsSync(join(at.dir, "hold", `${id}.ask`)), checks: checks(logs) }).toEqual({ hold: null, ask: false, checks: ["checking", "drive", "checking", "whole"] });
  });

  it("verify meeting CORRUPT while the folder it opened no longer reads could not finish: the hold says its drive left, nothing found", async () => {
    const root = makeRoot("lifestream-verify-left-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    const held: Hold = { since_ms: Date.now(), cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: null };
    hold(at, id, held);
    const pragma = Database.prototype.pragma;
    Database.prototype.pragma = function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source === "integrity_check") {
        driveLeft();
        throw new Database.SqliteError("database disk image is malformed", "SQLITE_CORRUPT");
      }
      return pragma.call(this, source, options);
    } as typeof pragma;
    onTestFinished(() => { Database.prototype.pragma = pragma; });
    const verified = await home(root, ["verify"]);
    expect({ status: verified.status, last: verified.out.trim().split("\n").at(-1), hold: readHold(at, id) }).toEqual({
      status: 1, last: "the home's folder no longer reads as it was opened (its drive left): the check could not finish, and runs again",
      hold: { ...held, check: { unfinished: "drive", at_ms: expect.any(Number) } },
    });
    expect(verified.out).not.toContain("is damaged");
  });

  it("verify whose drive leaves while it waits for the locks: the hold says its drive left, not that it stopped", async () => {
    const root = makeRoot("lifestream-verify-quiet-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    onTestFinished(() => release(at, id));
    hold(at, id, { since_ms: Date.now(), cause: { met: "home.db", error: "SQLITE_CORRUPT: synthetic" }, check: null });
    const lock = tryLock(join(root, "home.lock"))!;
    onTestFinished(() => lock.release());
    driveLeft();
    const verified = await home(root, ["verify"]);
    expect({ status: verified.status, check: readHold(at, id)!.check }).toEqual({ status: 1, check: { unfinished: "drive", at_ms: expect.any(Number) } });
  });

  it("verify on a running home: it asks the home to stop over its socket, checks each file, holds nothing, and the home starts again", async () => {
    const root = makeRoot("lifestream-verify-running-", { sources: { [NOTES]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const at = machine();
    const { id } = readHomeJson(root);
    const running = await start(root, []);
    const verified = await home(root, ["verify"]);
    expect(await running.stopped).toBe("stopped: a move or a verify asked");
    const said = verified.out.trim().split("\n");
    expect({ status: verified.status, first: said[0], last: said.at(-1), hold: readHold(at, id) }).toEqual({ status: 0, first: "waiting for Lifestream to stop", last: "The home holds.", hold: null });
    expect(said.filter((line) => / whole, in \d+\.\d s$/u.test(line)).map((line) => line.split(":")[0])).toEqual(["home.db", "the ledger"]);
    const again = await start(root, []);
    await again.stop();
    artifact(root, "verify-running", { verify: verified.out });
  });
});
