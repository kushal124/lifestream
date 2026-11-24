import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { checkAgain, codesigned, makeReady, readyEntry, Refused, removeBuilds, type Build, type SignatureCheck } from "@lifestreamprotocol/model";
import { OLLAMA } from "./files.js";
import { HELD_SAID, leashCommand } from "./leash.js";
import { NotReady } from "./library.js";


export interface OllamaChild {
  readonly models: string;
  url(signal?: AbortSignal): Promise<string>;
  build(signal: AbortSignal, progress?: (bytes: number) => void): Promise<number>;
  remove(): Promise<void>;
  heal(): Promise<void>;
  close(): Promise<void>;
}

const START_MS = 30_000;
const HELD_MS = 250;
const LOCK = "child.lock";
const HEAL_MS = 5_000;

class Unstarted extends Error {}

interface Starting {
  readonly promise: Promise<string>;
  readonly stop: AbortController;
  waiters: number;
}

interface Child {
  readonly url: string;
  readonly leash: ChildProcess;
  readonly exited: Promise<void>;
}

export interface OllamaOptions {
  readonly build?: Build;
  readonly signed?: SignatureCheck;
  readonly bound?: () => AbortSignal;
}

export function openOllama(folder: string, options: OllamaOptions = {}): OllamaChild {
  const pin = options.build ?? OLLAMA;
  const signed = options.signed ?? codesigned;
  const bound = options.bound ?? (() => AbortSignal.timeout(START_MS));
  const built = join(folder, "build");
  const models = join(folder, "models");
  const home = join(folder, "home");
  const checking = { signed, env: { PATH: "/usr/bin:/bin", HOME: home, OLLAMA_HOST: "127.0.0.1:1" } };
  mkdirSync(folder, { recursive: true });
  let child: Child | null = null;
  let starting: Starting | null = null;
  let ending: Promise<void> = Promise.resolve();
  const endings = new WeakMap<ChildProcess, Promise<void>>();
  let closing: Promise<void> | null = null;

  function end(leash: ChildProcess, exited: Promise<void>): Promise<void> {
    if (child?.leash === leash) child = null;
    let made = endings.get(leash);
    if (made === undefined) {
      leash.stdin!.end();
      made = exited;
      endings.set(leash, made);
      ending = made;
    }
    return made;
  }

  async function stopChild(why: string): Promise<void> {
    starting?.stop.abort(new Error(why));
    await starting?.promise.catch(() => undefined);
    if (child !== null) await end(child.leash, child.exited);
    await ending;
  }

  function spawnChild(binary: string, port: number): { leash: ChildProcess; exited: Promise<void>; said: () => string } {
    const [node, ...args] = leashCommand();
    const leash = spawn(node!, [...args, join(folder, LOCK), binary, "serve"], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: join(folder, "tmp"), HOME: home, OLLAMA_HOST: `127.0.0.1:${port}`, OLLAMA_MODELS: models,
        OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", OLLAMA_NOPRUNE: "1",
      },
      stdio: ["pipe", "ignore", "pipe"],
    });
    leash.stdin!.on("error", () => undefined);
    let said = "";
    leash.stderr!.on("data", (chunk: Buffer) => { said = (said + chunk.toString("utf8")).slice(-2_000); });
    const exited = new Promise<void>((resolve) => leash.once("close", () => {
      if (child?.leash === leash) child = null;
      resolve();
    }));
    return { leash, exited, said: () => said };
  }

  const held = (): Error => new Error(`Another Ollama holds ${folder}: another runner's, or one still ending.`);

  async function start(signal: AbortSignal): Promise<string> {
    await until(ending, signal);
    const binary = readyEntry(built, pin.version);
    if (binary === null) throw new NotReady(`Ollama ${pin.version} is not ready on this runner`);
    for (const each of ["models", "home", "tmp"]) mkdirSync(join(folder, each), { recursive: true });
    try {
      return await spawnUntilAnswered(binary, signal);
    } catch (error) {
      if (!(error instanceof Unstarted)) throw error;
      await checkAgain(built, pin, { ...checking, signal }).catch((again: unknown) => {
        if (again instanceof Refused) throw new NotReady(`Ollama ${pin.version} did not start, and its build is refused: ${again.message}`);
      });
      throw error;
    }
  }

  async function spawnUntilAnswered(binary: string, signal: AbortSignal): Promise<string> {
    const deadline = AbortSignal.any([signal, bound()]);
    for (;;) {
      signal.throwIfAborted();
      const url = `http://127.0.0.1:${await freePort()}`;
      const { leash, exited, said } = spawnChild(binary, Number(new URL(url).port));
      try {
        for (;;) {
          const answered = await fetch(new URL("/api/version", url), { signal: deadline }).then((response) => response.ok, () => false);
          if (leash.exitCode !== null || leash.signalCode !== null) {
            await exited;
            if (said().includes(HELD_SAID)) break;
            throw new Unstarted(`Ollama stopped as it started: ${said()}`);
          }
          signal.throwIfAborted();
          if (answered) {
            child = { url, leash, exited };
            return url;
          }
          deadline.throwIfAborted();
          await Promise.race([exited, pause(100, deadline)]);
        }
      } catch (error) {
        await end(leash, exited);
        if (signal.aborted) throw signal.reason;
        if (deadline.aborted) throw said().includes(HELD_SAID) ? held() : new Unstarted(`Ollama did not answer before its start's bound: ${said()}`);
        throw error;
      }
      await pause(HELD_MS, deadline);
      signal.throwIfAborted();
      if (deadline.aborted) throw held();
    }
  }

  return {
    models,
    async url(signal = new AbortController().signal) {
      if (closing !== null) throw new Error("The runner is stopping.");
      if (child !== null) return child.url;
      if (starting === null) {
        const stop = new AbortController();
        const made: Starting = {
          promise: start(stop.signal).finally(() => {
            if (starting === made) starting = null;
          }),
          stop, waiters: 0,
        };
        starting = made;
      }
      const made = starting;
      made.waiters++;
      try {
        return await until(made.promise, signal);
      } finally {
        if (--made.waiters === 0 && starting === made) made.stop.abort(signal.reason ?? new Error("no one waits on Ollama"));
      }
    },
    async build(signal, progress) {
      mkdirSync(home, { recursive: true });
      await makeReady(built, pin, { ...checking, signal, ...(progress === undefined ? {} : { progress }) });
      return pin.artifact.bytes;
    },
    async remove() {
      await stopChild("Ollama's build is removed");
      await removeBuilds(built);
    },
    async heal() {
      const was = child;
      if (was === null) return;
      const well = await fetch(new URL("/api/version", was.url), { signal: AbortSignal.timeout(HEAL_MS) }).then((response) => response.ok, () => false);
      if (well || child !== was) return;
      await end(was.leash, was.exited);
    },
    close() {
      closing ??= stopChild("The runner is stopping.");
      return closing;
    },
  };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function until<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = (): void => reject(signal.reason);
    signal.addEventListener("abort", stop, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
