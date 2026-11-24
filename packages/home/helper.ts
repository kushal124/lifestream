import { join } from "node:path";
import { parentPort, receiveMessageOnPort, type MessagePort } from "node:worker_threads";
import { openHandedFolder, openHome, SecretError, type HandedFolder, type HomeDb, type HomeFolder, type Secrets } from "@lifestreamprotocol/core";
import { openAsker, openLedger, type Asker, type Ledger } from "@lifestreamprotocol/model";
import { tagOf } from "@lifestreamprotocol/privacy";
import type { CopyAnswer, CopyAsked } from "./copies.js";
import { driveHalf, type DriveHalf } from "./detector.js";
import { jobError, type Driving, type HelperEnv, type JobError, type RunnerDriving, type Task } from "./jobs.js";
import { KINDS } from "./kinds.js";
import { LINE, serialAfter } from "./pool.js";
import { releasePreparedReaders } from "./prepared.js";
import { promptsOf } from "./prompts.js";
import { homeOf, loadRegistry, type Loaded } from "./registry.js";
import type { Settings } from "./settings.js";

export interface HelperInit {
  root: string;
  handed: HandedFolder;
  registry: string;
  stations: Driving;
  runners: RunnerDriving;
  settings: Settings;
  machine: string;
  secrets: { port: MessagePort; flag: SharedArrayBuffer };
  reading: SharedArrayBuffer;
}

export type ToHelper =
  | { t: "attach"; data: HelperInit }
  | { t: "detach" }
  | { t: "run"; task: Task }
  | { t: "ack"; job: number }
  | { t: "stop" }
  | { t: "settings"; settings: Settings }
  | { t: "privacy"; privacy: Settings["privacy"] };
export type SecretAsked = { op: "get"; name: string } | { op: "rotate"; name: string; value: string };
export type SecretAnswer = { value?: string | null; error?: { message: string; reason: SecretError["reason"] } };
export type LineAsked = SecretAsked | CopyAsked;
export type FromHelper =
  | { t: "up" }
  | { t: "detached" }
  | { t: "chunk"; job: number; chunk: unknown }
  | { t: "done"; job: number; result: unknown }
  | { t: "error"; job: number; error: JobError };

const CREDITS = 2;
const port = parentPort!;
const waitAsync = (Atomics as unknown as { waitAsync(array: Int32Array, index: number, value: number): { async: false; value: string } | { async: true; value: Promise<string> } }).waitAsync.bind(Atomics);

let root = "";
let registryModule = "";
let runners!: RunnerDriving;
let line: { port: MessagePort; flag: SharedArrayBuffer } | undefined;
let waited!: BigInt64Array;
let serial = 0n;
let folder: HomeFolder | undefined;
let registry: Loaded | undefined;
let db: HomeDb | undefined;
let blobs: ReturnType<HomeFolder["blobs"]> | undefined;
let ledger: Ledger | undefined;
let asker: Asker | undefined;
let drive: DriveHalf | undefined;
let stopping = new AbortController();
let env: HelperEnv | undefined;
let prompts: { of: Loaded; by: ReturnType<typeof promptsOf> } | undefined;
let copying = false;
let rebuilt: Promise<void> = Promise.resolve();
let credits = CREDITS;
let waiting: { ready: () => boolean; resolve: () => void }[] = [];
let running: Promise<void> = Promise.resolve();

function ledgerOf(): Ledger {
  ledger ??= openLedger(folder!, { mode: "write" });
  return ledger;
}

function promptOf(name: string) {
  if (prompts === undefined || prompts.of !== registry) prompts = { of: registry!, by: promptsOf(registry!.families) };
  const found = prompts.by.get(name);
  if (found === undefined) throw new Error(`no family states prompt ${name}`);
  return found.prompt;
}

function answered(asked: SecretAsked): SecretAnswer {
  if (copying) throw new SecretError(`a sent copy is asked on this helper's line: ${asked.name} is not answered`);
  const flag = new Int32Array(line!.flag);
  if (Atomics.compareExchange(flag, 0, LINE.answered, LINE.waiting) === LINE.closed) throw new SecretError(`the home closed this helper's line: ${asked.name} is not answered`);
  line!.port.postMessage(asked);
  Atomics.wait(flag, 0, LINE.waiting);
  const answer = receiveMessageOnPort(line!.port)?.message as SecretAnswer | undefined;
  if (answer === undefined) throw new SecretError(`the home did not answer for ${asked.name}`);
  if (answer.error !== undefined) throw new SecretError(answer.error.message, answer.error.reason);
  return answer;
}

async function copied(asked: CopyAsked): Promise<CopyAnswer> {
  const flag = new Int32Array(line!.flag);
  if (copying) throw new Error("a sent copy is asked already on this helper's line");
  if (Atomics.compareExchange(flag, 0, LINE.answered, LINE.waiting) === LINE.closed) throw new Error(`the home closed this helper's line: the copy of ${asked.key} is not made`);
  copying = true;
  try {
    line!.port.postMessage(asked);
    const waitedLine = waitAsync(flag, 0, LINE.waiting);
    if (waitedLine.async) await waitedLine.value;
    const answer = receiveMessageOnPort(line!.port)?.message as CopyAnswer | undefined;
    if (answer === undefined) throw new Error(`the home did not answer the copy of ${asked.key}`);
    return answer;
  } finally {
    copying = false;
  }
}

function untilAcked(ready: () => boolean): Promise<void> {
  return ready() ? Promise.resolve() : new Promise((resolve) => waiting.push({ ready, resolve }));
}

function closeOpen(): void {
  try { db?.close(); } catch {}
  try { ledger?.close(); } catch {}
  try { line?.port.close(); } catch {}
  try { releasePreparedReaders(); } catch {}
  db = undefined;
  ledger = undefined;
  asker = undefined;
  drive = undefined;
  prompts = undefined;
  env = undefined;
  folder = undefined;
  blobs = undefined;
  registry = undefined;
  line = undefined;
  copying = false;
  serial = 0n;
  credits = CREDITS;
  waiting = [];
}

async function attach(data: HelperInit): Promise<void> {
  closeOpen();
  root = data.root;
  registryModule = data.registry;
  runners = data.runners;
  line = data.secrets;
  waited = new BigInt64Array(data.reading);
  serial = 0n;
  stopping = new AbortController();
  const openedFolder = openHandedFolder(data.handed);
  folder = openedFolder;
  const loadedRegistry = await loadRegistry(registryModule, data.settings, homeOf(openedFolder));
  registry = loadedRegistry;
  const openedDb = openHome(openedFolder, "read");
  db = openedDb;
  const openedBlobs = openedFolder.blobs(join(root, "blobs"));
  blobs = openedBlobs;
  env = {
    folder: openedFolder, settings: data.settings, registry: loadedRegistry, db: openedDb, blobs: openedBlobs, stations: data.stations, machine: data.machine,
    asker() {
      if (asker === undefined) {
        const labeler = registry!.labelers?.find((each) => each.draw !== undefined);
        asker = openAsker({
          ledger: ledgerOf(), blobs: openedBlobs, prompt: promptOf,
          ...(labeler === undefined ? {} : {
            draw: (photo, faces) => labeler.draw!(photo, faces.map(({ placeholder, box }) => ({ name: tagOf(placeholder), box: [box.x, box.y, box.x + box.width, box.y + box.height] }))),
          }),
        });
      }
      return asker;
    },
    secrets(): Secrets {
      return {
        get: (name) => answered({ op: "get", name }).value ?? undefined,
        rotate: (name, value) => void answered({ op: "rotate", name, value }),
      };
    },
    drive() {
      drive ??= driveHalf(runners.door, { call: () => runners.call, drive: () => runners.drive });
      return drive;
    },
    get signal() {
      return stopping.signal;
    },
    committed() {
      return untilAcked(() => credits >= CREDITS);
    },
    copy: (asked) => copied(asked),
    epoch: () => ledgerOf().placeholders.epoch().epoch,
    reading(rows) {
      if (rows === null) return void Atomics.store(waited, 0, 0n);
      Atomics.store(waited, 1, BigInt(rows));
      serial = serialAfter(serial);
      Atomics.store(waited, 0, serial);
    },
  };
  port.postMessage({ t: "up" } satisfies FromHelper);
}

async function waitProcesses(): Promise<void> {
  while (process.getActiveResourcesInfo().includes("ProcessWrap")) await new Promise((resolve) => setTimeout(resolve, 10));
}

async function endOnceCollected(): Promise<void> {
  closeOpen();
  await waitProcesses();
  process.exit();
}

port.on("message", (message: ToHelper) => {
  if (message.t === "attach") {
    rebuilt = attach(message.data).catch((error) => {
      setImmediate(() => { throw error; });
      return new Promise<void>(() => undefined);
    });
    return;
  }
  if (message.t === "detach") {
    stopping.abort();
    for (const each of waiting.splice(0)) each.resolve();
    void running.then(() => rebuilt).catch(() => undefined).then(async () => {
      closeOpen();
      await waitProcesses();
      rebuilt = Promise.resolve();
      running = Promise.resolve();
      port.postMessage({ t: "detached" } satisfies FromHelper);
    });
    return;
  }
  if (message.t === "stop") {
    stopping.abort();
    for (const each of waiting.splice(0)) each.resolve();
    void running.then(endOnceCollected);
    return;
  }
  if (message.t === "settings") {
    const next = message.settings;
    rebuilt = rebuilt.then(async () => {
      registry = await loadRegistry(registryModule, next, homeOf(folder!));
      Object.assign(env!, { settings: next, registry });
    });
    return;
  }
  if (message.t === "privacy") {
    const privacy = message.privacy;
    rebuilt = rebuilt.then(() => {
      Object.assign(env!, { settings: { ...env!.settings, privacy } });
    });
    return;
  }
  if (message.t === "ack") {
    credits++;
    const still = [];
    for (const each of waiting) {
      if (each.ready()) each.resolve();
      else still.push(each);
    }
    waiting = still;
    return;
  }
  running = run(message.task);
});

async function run(task: Task): Promise<void> {
  credits = CREDITS;
  waiting = [];
  stopping = new AbortController();
  try {
    await rebuilt;
    if (stopping.signal.aborted) return;
    const kind = KINDS[task.kind];
    if (kind === undefined) throw new Error(`no helper runs ${task.kind}`);
    const steps = kind.helper(env!, task);
    for (;;) {
      const next = await steps.next();
      if (next.done === true) {
        port.postMessage({ t: "done", job: task.job, result: next.value } satisfies FromHelper);
        return;
      }
      credits--;
      port.postMessage({ t: "chunk", job: task.job, chunk: next.value } satisfies FromHelper);
      await untilAcked(() => credits > 0);
      if (stopping.signal.aborted) {
        await steps.return(undefined as never);
        return;
      }
    }
  } catch (error) {
    port.postMessage({ t: "error", job: task.job, error: jobError(error) } satisfies FromHelper);
  }
}
