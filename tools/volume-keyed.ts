import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type Database from "better-sqlite3";
import { HOME_STORE, openHomeFolder, type HomeFolder } from "@lifestreamprotocol/core";
import { homeSocket, slotFolder } from "../packages/home/lifecycle.js";
import { change } from "../packages/home/settings.js";
import { askHome } from "../packages/home/socket.js";
import { CREDENTIAL, draftRecovery } from "../packages/home/vault.js";
import { DEVICE, REPO } from "../packages/home/test/support.js";

const SCRIPT = fileURLToPath(import.meta.url);
const VARIANTS = ["plain", "keyed"] as const;
type Variant = (typeof VARIANTS)[number];
const STEPS = ["migrate", "walk", "day", "search", "checkpoint", "recount", "index"] as const;
type Step = (typeof STEPS)[number];
const INTAKE_ROWS = 110_000;
const INTAKE_ROW_BYTES = 1024;
const WARM_READS = 5;

interface Place {
  root: string;
  machine: string;
  slot: Buffer | null;
}

interface Run {
  step: Step;
  variant: Variant;
  round: number;
  at: string;
  load: string;
  ms: number;
  peak_rss_mb: number;
  scratch_bytes: number;
  scratch_files: number;
  detail: Record<string, unknown>;
}

function placeOf(at: string): Place {
  const root = join(realpathSync(at), "home"), machine = join(realpathSync(at), "machine");
  const credential = join(machine, "credentials", CREDENTIAL);
  return { root, machine, slot: existsSync(credential) ? readFileSync(credential) : null };
}

function envOf(place: Place): NodeJS.ProcessEnv {
  return { ...process.env, LIFESTREAM_MACHINE_DIR: place.machine, ...(place.slot === null ? {} : { CREDENTIALS_DIRECTORY: join(place.machine, "credentials") }) };
}

function folderOf(place: Place): HomeFolder {
  return place.slot === null ? openHomeFolder(place.root, { machine: place.machine, program: "home" }) : slotFolder(place.root, place.machine, "home", { key: place.slot, why: null }, Date.now());
}

function load(): string {
  return readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
}

function peakMb(pid: number | "self"): number {
  const line = readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((each) => each.startsWith("VmHWM:"));
  return line === undefined ? 0 : Number(/(\d+)/u.exec(line)![1]) / 1024;
}

function written(): number {
  const line = readFileSync("/proc/self/io", "utf8").split("\n").find((each) => each.startsWith("write_bytes:"));
  return line === undefined ? 0 : Number(line.split(":")[1]);
}

function storeFiles(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (folder: string) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (["blobs", "inbox", "days", "scratch", "run"].includes(entry.name)) continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.db(?:-wal|-shm)?(?:\.k\d+)?$/u.test(entry.name)) found.push(path);
    }
  };
  for (const root of roots) walk(root);
  return found;
}

function dropCache(place: Place): void {
  const program = "import os, sys\nfor path in sys.argv[1:]:\n    fd = os.open(path, os.O_RDONLY)\n    os.fsync(fd)\n    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)\n    os.close(fd)\n";
  const ran = spawnSync("python3", ["-I", "-c", program, ...storeFiles(place.root, place.machine)], { stdio: "inherit" });
  if (ran.status !== 0) throw new Error("the file cache could not be dropped");
}

class ScratchWatch {
  readonly #sizes = new Map<string, number>();
  readonly #timer: NodeJS.Timeout;

  constructor(readonly pid: number, readonly scratch: string) {
    this.#timer = setInterval(() => this.#look(), 50);
  }

  #look(): void {
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${this.pid}/fd`);
    } catch {
      return;
    }
    for (const fd of fds) {
      try {
        const target = readlinkSync(`/proc/${this.pid}/fd/${fd}`);
        if (!target.startsWith(this.scratch) && !target.includes("etilqs_")) continue;
        const stat = statSync(`/proc/${this.pid}/fd/${fd}`);
        const id = `${stat.dev}:${stat.ino}`;
        this.#sizes.set(id, Math.max(this.#sizes.get(id) ?? 0, stat.size));
      } catch {
        continue;
      }
    }
  }

  stop(): { bytes: number; files: number } {
    this.#look();
    clearInterval(this.#timer);
    return { bytes: [...this.#sizes.values()].reduce((sum, size) => sum + size, 0), files: this.#sizes.size };
  }
}

interface Spawned {
  child: ChildProcess;
  lines: string[];
  until(test: (line: string) => boolean): Promise<string>;
}

function start(args: string[], env: NodeJS.ProcessEnv, input?: string): Spawned {
  const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: REPO, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (input !== undefined) child.stdin!.end(input);
  const lines: string[] = [];
  const waiting: { test: (line: string) => boolean; resolve: (line: string) => void }[] = [];
  let pending = "";
  const take = (chunk: Buffer) => {
    const split = (pending + chunk.toString("utf8")).split("\n");
    pending = split.pop()!;
    for (const line of split) {
      lines.push(line);
      for (const wait of [...waiting]) {
        if (wait.test(line)) {
          waiting.splice(waiting.indexOf(wait), 1);
          wait.resolve(line);
        }
      }
    }
  };
  child.stdout!.on("data", take);
  child.stderr!.on("data", take);
  const exited = new Promise<never>((_, reject) => child.once("exit", (code, signal) => reject(new Error(`${args.join(" ")} exited ${code ?? signal}:\n${lines.slice(-20).join("\n")}`))));
  exited.catch(() => undefined);
  return {
    child, lines,
    until: (test) => {
      const found = lines.find(test);
      if (found !== undefined) return Promise.resolve(found);
      return Promise.race([new Promise<string>((resolve) => waiting.push({ test, resolve })), exited]);
    },
  };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}

async function exitOf(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return new Promise((resolve) => child.once("exit", (code) => resolve(code)));
}

async function startHome(place: Place): Promise<Spawned> {
  const home = start(["packages/home/cli.ts", "serve", "--root", place.root], envOf(place));
  await home.until((line) => line.includes('"home":"started"'));
  return home;
}

async function startDoor(place: Place): Promise<{ door: Spawned; url: string }> {
  const door = start(["packages/home/door-main.ts", "serve", "--root", place.root], envOf(place));
  const line = await door.until((each) => each.includes('"door":"open"'));
  return { door, url: `http://127.0.0.1:${(JSON.parse(line) as { port: number }).port}` };
}

async function child(step: string, at: string, place: Place): Promise<{ result: Record<string, unknown>; scratch: { bytes: number; files: number } }> {
  const run = start([SCRIPT, "step", step, "--at", at], envOf(place));
  const watch = new ScratchWatch(run.child.pid!, join(place.machine, "scratch"));
  const status = await exitOf(run.child);
  const scratch = watch.stop();
  const line = run.lines.findLast((each) => each.startsWith("{\"step\""));
  if (status !== 0 || line === undefined) throw new Error(`step ${step} on ${at} exited ${status}:\n${run.lines.slice(-20).join("\n")}`);
  return { result: JSON.parse(line) as Record<string, unknown>, scratch };
}

async function prepare(at: string, place: Place): Promise<string> {
  await child("ports", at, place);
  const tokenFile = join(at, "reader.token");
  if (existsSync(tokenFile)) return readFileSync(tokenFile, "utf8").trim();
  const home = await startHome(place);
  try {
    const lines: string[] = [];
    await askHome(homeSocket(place.root, place.machine), "principals", ["mint", "--unit", "p6-reader", "--scope", "read"], (line) => lines.push(line));
    const token = /: (\S+)$/u.exec(lines.find((line) => line.startsWith("token for")) ?? "")?.[1];
    if (token === undefined) throw new Error(`principals mint printed no token: ${lines.join(" | ")}`);
    writeFileSync(tokenFile, token, { mode: 0o600 });
    return token;
  } finally {
    await stop(home.child);
  }
}

async function timedGet(url: string, path: string, token: string): Promise<{ ms: number; bytes: number }> {
  const began = performance.now();
  const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}`, ...DEVICE.mac } });
  const body = await response.arrayBuffer();
  const ms = performance.now() - began;
  if (response.status !== 200) throw new Error(`GET ${path}: ${response.status} ${Buffer.from(body).toString("utf8").slice(0, 300)}`);
  return { ms, bytes: body.byteLength };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

async function readRoute(at: string, place: Place, token: string, path: string): Promise<Omit<Run, "step" | "variant" | "round" | "at" | "load">> {
  dropCache(place);
  const { door, url } = await startDoor(place);
  try {
    const watch = new ScratchWatch(door.child.pid!, join(place.machine, "scratch"));
    const cold = await timedGet(url, path, token);
    const warm: number[] = [];
    for (let i = 0; i < WARM_READS; i++) warm.push((await timedGet(url, path, token)).ms);
    const scratch = watch.stop();
    return { ms: cold.ms, peak_rss_mb: peakMb(door.child.pid!), scratch_bytes: scratch.bytes, scratch_files: scratch.files, detail: { path, bytes: cold.bytes, warm_ms: median(warm), warm_all_ms: warm } };
  } finally {
    await stop(door.child);
  }
}

async function migrate(at: string, place: Place, data: string): Promise<Omit<Run, "step" | "variant" | "round" | "at" | "load">> {
  const fresh = join(data, `fresh-${randomUUID().slice(0, 8)}`);
  const root = join(fresh, "home"), machine = join(fresh, "machine");
  mkdirSync(machine, { recursive: true, mode: 0o700 });
  writeFileSync(join(machine, "machine.json"), JSON.stringify({ dnssd: join(machine, "no-dns-sd") }));
  const slot = place.slot === null ? null : randomBytes(32);
  if (slot !== null) {
    mkdirSync(join(machine, "credentials"), { mode: 0o700 });
    writeFileSync(join(machine, "credentials", CREDENTIAL), slot, { mode: 0o600 });
  }
  const freshPlace: Place = { root, machine, slot };
  try {
    const adopt = start(["packages/home/cli.ts", "adopt", root, ...(slot === null ? [] : ["--keyed"])], envOf(freshPlace),
      slot === null ? undefined : JSON.stringify({ home_id: randomUUID(), slot_key: slot.toString("hex"), recovery: draftRecovery(Date.now()).recovery }));
    if ((await exitOf(adopt.child)) !== 0) throw new Error(`adopt exited:\n${adopt.lines.join("\n")}`);
    await child("ports", fresh, freshPlace);
    const began = performance.now();
    const home = start(["packages/home/cli.ts", "serve", "--root", root], envOf(freshPlace));
    const watch = new ScratchWatch(home.child.pid!, join(machine, "scratch"));
    await home.until((line) => line.includes('"home":"started"'));
    const ms = performance.now() - began;
    const scratch = watch.stop();
    const peak = peakMb(home.child.pid!);
    await stop(home.child);
    const stamp = join(root, "config", "stores.json");
    return { ms, peak_rss_mb: peak, scratch_bytes: scratch.bytes, scratch_files: scratch.files, detail: { stores: existsSync(stamp) ? JSON.parse(readFileSync(stamp, "utf8")) : null } };
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

async function recount(at: string, place: Place): Promise<Omit<Run, "step" | "variant" | "round" | "at" | "load">> {
  const reset = await child("recount-reset", at, place);
  dropCache(place);
  const began = performance.now();
  const home = start(["packages/home/cli.ts", "serve", "--root", place.root], envOf(place));
  const watch = new ScratchWatch(home.child.pid!, join(place.machine, "scratch"));
  try {
    await home.until((line) => line.includes('"home":"started"'));
    const started = performance.now();
    const line = await home.until((each) => each.includes('"stored":"fill"') && each.includes('"completed":true'));
    const ms = performance.now() - started;
    const scratch = watch.stop();
    const runs = home.lines.filter((each) => each.includes('"stored":"fill"')).map((each) => JSON.parse(each.slice(each.indexOf("{"))) as Record<string, unknown>);
    return {
      ms, peak_rss_mb: peakMb(home.child.pid!), scratch_bytes: scratch.bytes, scratch_files: scratch.files,
      detail: { start_ms: started - began, reset: reset.result, runs: runs.length, run_ms: runs.map((run) => run.run_ms), files: runs.reduce((sum, run) => sum + Number(run.files ?? 0), 0), last: JSON.parse(line.slice(line.indexOf("{"))) },
    };
  } finally {
    watch.stop();
    await stop(home.child);
  }
}

async function offline(step: Step, at: string, place: Place): Promise<Omit<Run, "step" | "variant" | "round" | "at" | "load">> {
  dropCache(place);
  const { result, scratch } = await child(step, at, place);
  return { ms: result.ms as number, peak_rss_mb: result.peak_rss_mb as number, scratch_bytes: scratch.bytes, scratch_files: scratch.files, detail: result };
}

async function bench(options: { data: string; first: number; rounds: number; steps: Step[]; day: string; query: string; out: string; log: (line: string) => void }): Promise<Run[]> {
  const places = Object.fromEntries(VARIANTS.map((variant) => [variant, placeOf(join(options.data, variant))])) as Record<Variant, Place>;
  const tokens = {} as Record<Variant, string>;
  for (const variant of VARIANTS) tokens[variant] = await prepare(join(options.data, variant), places[variant]);
  const runs: Run[] = [];
  for (let round = options.first; round < options.first + options.rounds; round++) {
    for (const step of options.steps) {
      for (const variant of round % 2 === 1 ? VARIANTS : [...VARIANTS].reverse()) {
        const at = join(options.data, variant), place = places[variant];
        const before = load();
        const started = new Date().toISOString();
        const measured = step === "migrate" ? await migrate(at, place, options.data)
          : step === "day" ? await readRoute(at, place, tokens[variant], `/v1/days/${options.day}?file=json`)
          : step === "search" ? await readRoute(at, place, tokens[variant], `/v1/search?lists=record&query=${encodeURIComponent(options.query)}`)
          : step === "recount" ? await recount(at, place)
          : await offline(step, at, place);
        const run: Run = { step, variant, round, at: started, load: before, ...measured };
        runs.push(run);
        appendFileSync(options.out, `${JSON.stringify(run)}\n`);
        options.log(`${step} ${variant} round ${round}: ${run.ms.toFixed(1)} ms, peak ${run.peak_rss_mb.toFixed(0)} MB, scratch ${run.scratch_bytes} B, load ${before}`);
      }
    }
  }
  return runs;
}

function store(place: Place, mode: "read" | "write"): { folder: HomeFolder; db: Database.Database } {
  const folder = folderOf(place);
  return { folder, db: folder.store(HOME_STORE, join(place.root, "home.db"), { mode, mustExist: true, timeout: 60_000 }) };
}

function stepWalk(place: Place): Record<string, unknown> {
  const { db } = store(place, "read");
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'").pluck().all() as string[];
  let rows = 0, bytes = 0;
  const began = performance.now();
  for (const table of tables) {
    for (const row of db.prepare(`SELECT * FROM "${table}"`).raw().iterate() as Iterable<unknown[]>) {
      rows++;
      for (const value of row) bytes += typeof value === "string" ? Buffer.byteLength(value) : Buffer.isBuffer(value) ? value.length : 8;
    }
  }
  const ms = performance.now() - began;
  db.close();
  return { ms, tables: tables.length, rows, bytes };
}

function stepCheckpoint(place: Place): Record<string, unknown> {
  const { db } = store(place, "write");
  db.pragma("wal_checkpoint(TRUNCATE)");
  const autocheckpoint = db.pragma("wal_autocheckpoint", { simple: true }) as number;
  db.pragma("wal_autocheckpoint = 0");
  db.exec("DROP TABLE IF EXISTS p6_intake; CREATE TABLE p6_intake (x BLOB NOT NULL) STRICT");
  const insert = db.prepare("INSERT INTO p6_intake (x) VALUES (?)");
  const began = performance.now();
  db.transaction(() => {
    for (let i = 0; i < INTAKE_ROWS; i++) insert.run(randomBytes(INTAKE_ROW_BYTES));
  })();
  const write_ms = performance.now() - began;
  const wal = statSync(join(place.root, "home.db-wal")).size;
  const checking = performance.now();
  const [row] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number; log: number; checkpointed: number }[];
  const ms = performance.now() - checking;
  db.exec("DROP TABLE p6_intake");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma(`wal_autocheckpoint = ${autocheckpoint}`);
  db.close();
  return { ms, write_ms, wal_bytes: wal, autocheckpoint, busy: row?.busy ?? null };
}

function stepIndex(place: Place): Record<string, unknown> {
  const { db } = store(place, "write");
  db.exec("DROP INDEX IF EXISTS p6_versions");
  const versions = db.prepare("SELECT count(*) FROM versions").pluck().get() as number;
  const began = performance.now();
  db.exec("CREATE INDEX p6_versions ON versions(kind, key, start_ms)");
  const ms = performance.now() - began;
  db.exec("DROP INDEX p6_versions");
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { ms, versions };
}

function stepRecountReset(place: Place): Record<string, unknown> {
  const { db } = store(place, "write");
  const M = db.prepare("SELECT coalesce(max(rowid), 0) FROM versions").pluck().get() as number;
  const files = db.prepare("SELECT count(*) FROM stored_files").pluck().get() as number;
  db.transaction(() => {
    db.exec("DELETE FROM stored_days; DELETE FROM stored_files; DELETE FROM own_days");
    db.prepare("DELETE FROM meta WHERE key IN ('stored:rest', 'stored:at')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('stored:fill', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify({ M, blocks: 0, after: null, erasures: 0, slab_ms: 0 }));
  })();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
  return { ms: 0, M, files_before: files };
}

function stepPorts(place: Place): Record<string, unknown> {
  const folder = folderOf(place);
  change(folder, "door.port", 0);
  change(folder, "door.lan_port", 0);
  return { ms: 0 };
}

function stepSizes(place: Place): Record<string, unknown> {
  const { db } = store(place, "read");
  const count = (table: string) => db.prepare(`SELECT count(*) FROM "${table}"`).pluck().get() as number;
  const result = { ms: 0, versions: count("versions"), statements: count("statements"), stored_files: count("stored_files") };
  db.close();
  return result;
}

const STEP_WORK: Record<string, (place: Place) => Record<string, unknown>> = {
  walk: stepWalk, checkpoint: stepCheckpoint, index: stepIndex, "recount-reset": stepRecountReset, ports: stepPorts, sizes: stepSizes,
};

if (process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === SCRIPT) {
  const usage = "usage: npx tsx tools/volume-keyed.ts bench --data <dir holding plain/ and keyed/> --day <YYYY-MM-DD> [--rounds <n>] [--first <round>] [--steps <step,…>] [--query <word>] [--out <file>]\n       npx tsx tools/volume-keyed.ts step <walk|checkpoint|index|recount-reset|ports|sizes> --at <dir>";
  const [command, ...rest] = process.argv.slice(2);
  if (command === "step") {
    const { positionals, values } = parseArgs({ args: rest, options: { at: { type: "string" } }, allowPositionals: true, strict: true });
    const work = STEP_WORK[positionals[0] ?? ""];
    if (work === undefined || values.at === undefined) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }
    const before = written();
    const result = work(placeOf(values.at));
    process.stdout.write(`${JSON.stringify({ step: positionals[0], ...result, peak_rss_mb: peakMb("self"), written_bytes: written() - before })}\n`);
  } else if (command === "bench") {
    const { values } = parseArgs({ args: rest, options: { data: { type: "string" }, day: { type: "string" }, rounds: { type: "string" }, first: { type: "string" }, steps: { type: "string" }, query: { type: "string" }, out: { type: "string" } }, strict: true });
    const steps = (values.steps ?? STEPS.join(",")).split(",") as Step[];
    if (values.data === undefined || values.day === undefined || !steps.every((step) => (STEPS as readonly string[]).includes(step))) {
      process.stderr.write(`${usage}\n`);
      process.exit(2);
    }
    const out = values.out ?? join(values.data, "runs.jsonl");
    bench({ data: values.data, first: Number(values.first ?? 1), rounds: Number(values.rounds ?? 3), steps, day: values.day, query: values.query ?? "synthetic", out, log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`) }).then(
      (runs) => process.stdout.write(`${JSON.stringify(runs)}\n`),
      (error: unknown) => {
        process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
        process.exitCode = 1;
      },
    );
  } else {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
}
