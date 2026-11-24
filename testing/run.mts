import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, statSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import { constants, homedir, platform, userInfo } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ForksPoolWorker, type PoolOptions, type PoolRunnerInitializer, type PoolWorker, type Reporter, type TestModule, type Vitest, type WorkerRequest } from "vitest/node";

const TEST_LOCK = fileURLToPath(new URL("../tools/test-lock.sh", import.meta.url));
const SET_UP = Symbol.for("lifestream.test-run");
const TSX_CACHE = join(homedir(), ...(platform() === "darwin" ? ["Library", "Caches"] : [".cache"]), "lifestream-tests", "tsx");
const TSX_CACHE_MOST = 20_000;

function fastTmp(): string | undefined {
  if (platform() !== "linux" || process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") return undefined;
  try {
    const stat = statfsSync("/dev/shm");
    if (stat.bavail * stat.bsize < 2 * 1024 ** 3) return undefined;
    return "/dev/shm";
  } catch {
    return undefined;
  }
}

export function pruneTsxCache(folder: string, most = TSX_CACHE_MOST): void {
  const names = readdirSync(folder);
  if (names.length <= most) return;
  const written = names.flatMap((name) => {
    try {
      return [{ name, ms: statSync(join(folder, name)).mtimeMs }];
    } catch {
      return [];
    }
  });
  written.sort((a, b) => b.ms - a.ms);
  for (const { name } of written.slice(Math.floor(most / 2))) rmSync(join(folder, name), { force: true });
}

function shareTsxCache(folder: string): void {
  mkdirSync(TSX_CACHE, { recursive: true });
  pruneTsxCache(TSX_CACHE);
  try {
    symlinkSync(TSX_CACHE, join(folder, `tsx-${process.geteuid?.() ?? userInfo().username}`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

async function lockedRun(): Promise<never> {
  const child = spawn(TEST_LOCK, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.removeAllListeners(signal);
    process.on(signal, () => child.kill(signal));
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (status, signal) => resolve(status ?? (signal === null ? 1 : 128 + constants.signals[signal])));
  });
  process.exit(code);
}

function processes(): Array<{ pid: number; command: string }> {
  return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.trim() !== "" && !line.includes(" ps -axo"))
    .map((line) => ({ pid: Number(line.trim().split(/\s+/u)[0]), command: line.trim().replace(/^\d+\s+/u, "") }))
    .filter((each) => each.pid !== process.pid);
}

async function probe(run: string): Promise<void> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(join(run, "probe.sock"), resolve);
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") throw new Error("this sandbox cannot open a socket: the tests start homes and doors; the orchestrator runs them");
    throw error;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function setup(): Promise<(() => void) | undefined> {
  const global = globalThis as { [SET_UP]?: true };
  if (global[SET_UP]) return undefined;
  global[SET_UP] = true;
  const inside = process.env.LIFESTREAM_TEST_RUN;
  if (inside === undefined && process.env.LIFESTREAM_TEST_LOCKED !== undefined) throw new Error("LIFESTREAM_TEST_LOCKED is set without LIFESTREAM_TEST_RUN: run vitest bare, or through tools/test-lock.sh, which sets both");
  if (inside === undefined) return lockedRun();
  const base = fastTmp() ?? inside;
  const run = mkdtempSync(join(base, "vitest-"));
  process.env.LIFESTREAM_TEST_RUN = run;
  process.env.LIFESTREAM_TEST_LOCKED = "1";
  process.env.TMPDIR = run;
  shareTsxCache(run);
  await probe(run);
  return () => {
    const left = processes().filter((each) => each.command.includes(run));
    for (const each of left) {
      try {
        process.kill(each.pid, "SIGKILL");
      } catch {
      }
    }
    if (base !== inside) rmSync(run, { recursive: true, force: true });
    if (left.length > 0) {
      process.stderr.write(`\n ${left.length} process${left.length === 1 ? "" : "es"} outlived the tests that started them, killed now:\n${left.map((each) => `  ${each.command.slice(0, 200)}`).join("\n")}\n`);
      process.exitCode = 1;
    }
  };
}

export class Slow implements Reporter {
  #root = "";

  constructor(private readonly over?: number) {}

  onInit(vitest: Vitest): void {
    this.#root = vitest.config.root;
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const files = modules.map((module) => ({ file: relative(this.#root, module.moduleId), s: module.diagnostic().duration / 1_000 })).sort((a, b) => b.s - a.s);
    const shown = (some: typeof files) => some.map((each) => `${each.file} ${each.s.toFixed(1)} s`).join(", ");
    if (files.length > 0) process.stdout.write(`\n Slowest files  ${shown(files.slice(0, 5))}\n`);
    const limit = this.over;
    const over = limit === undefined ? [] : files.filter((each) => each.s > limit);
    if (over.length > 0) process.stdout.write(` Warning: over ${limit} s in this run, where files wait on each other  ${shown(over)}: check each one's time alone (npx vitest run <file>) before shrinking a test of it, or move it to the full tier if it measures scale\n`);
  }
}

type Say = (line: string) => void;

const FORKS_NAMING_DEATH = "forks-naming-death";

export class ForksNamingDeath implements PoolWorker {
  readonly name = FORKS_NAMING_DEATH;
  readonly cacheFs = true;
  readonly #forks: ForksPoolWorker;
  readonly #root: string;
  readonly #say: Say;
  readonly #ran: string[] = [];
  #running: string[] = [];
  #stopping = false;

  constructor(options: PoolOptions, say: Say = (line) => process.stderr.write(line)) {
    this.#forks = new ForksPoolWorker(options);
    this.#root = options.project.vitest.config.root;
    this.#say = say;
  }

  on(event: string, callback: (arg: any) => void): void {
    this.#forks.on(event, callback);
  }

  off(event: string, callback: (arg: any) => void): void {
    this.#forks.off(event, callback);
  }

  send(message: WorkerRequest): void {
    if (message.type === "stop") this.#stopping = true;
    if (message.type === "run" || message.type === "collect") this.#running = message.context.files.map((file) => relative(this.#root, file.filepath));
    this.#forks.send(message);
  }

  deserialize(data: unknown): unknown {
    return this.#forks.deserialize(data);
  }

  async start(): Promise<void> {
    await this.#forks.start();
    this.#forks.on("message", this.#finished);
    // external: vitest types a pool worker's listener with one argument; a fork's "exit" passes its code and its signal
    this.#forks.on("exit", this.#exited as (code: unknown) => void);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    await this.#forks.stop();
  }

  readonly #finished = (message: { type?: unknown } | null): void => {
    if (message?.type !== "testfileFinished") return;
    this.#ran.push(...this.#running);
    this.#running = [];
  };

  readonly #exited = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (!this.#stopping) this.#say(deathLines(this.#running, this.#ran, code, signal));
  };
}

export const forksNamingDeath: PoolRunnerInitializer = {
  name: FORKS_NAMING_DEATH,
  createPoolWorker: (options) => new ForksNamingDeath(options),
};

export function deathLines(running: readonly string[], ran: readonly string[], code: number | null, signal: NodeJS.Signals | null): string {
  const how = signal === null ? `exit code ${code}` : `signal ${signal}`;
  const what = running.length > 0 ? `running ${running.join(", ")}` : "between files";
  return `worker died ${what}: ${how}\n${ran.length > 0 ? `  its process ran before: ${ran.join(", ")}\n` : ""}`;
}
