import { MessageChannel, SHARE_ENV, Worker, type MessagePort } from "node:worker_threads";
import type { HomeFolder } from "@lifestreamprotocol/core";
import type { CopyAnswer, CopyAsked } from "./copies.js";
import type { FromHelper, HelperInit, LineAsked, SecretAnswer, SecretAsked, ToHelper } from "./helper.js";
import { detachWorker, takeWorker, workerKey } from "./idle-workers.js";
import { jobError, type Driving, type JobError, type RunnerDriving, type Task } from "./jobs.js";
import { parkableRegistry, threadProgram } from "./programs.js";
import type { Settings } from "./settings.js";

export interface PoolEvents {
  chunk(job: number, chunk: unknown): void;
  done(job: number, result: unknown): void;
  error(job: number | null, error: JobError): void;
  secret(job: number, asked: SecretAsked): SecretAnswer;
  copy(job: number, asked: CopyAsked): Promise<CopyAnswer>;
  quiet(job: number, rows: number): void;
}

export type Turn = <T>(of: string, work: () => T) => T;

export const LINE = { waiting: 0, answered: 1, closed: 2 } as const;

const STOP_GRACE_MS = 500;
const BOOT_DETACH_MS = 2_000;

export const READ_QUIET_MS = 10 * 60_000;

export const lookOf = (quiet_ms: number): number => (quiet_ms < 60_000 ? quiet_ms / 4 : 15_000);

export const serialAfter = (serial: bigint): bigint => (serial >= SERIAL_END ? 1n : serial + 1n);
const SERIAL_END = 2n ** 63n - 1n;

export interface Seen<H> {
  helper: H;
  job: number | null;
  serial: bigint;
}

export interface Watch<H> {
  at: number | null;
  waits: Map<H, { job: number; serial: bigint; quiet_ms: number }>;
}

export function quietWaits<H>(watch: Watch<H>, now: number, seen: readonly Seen<H>[], quiet_ms: number): { end: number[]; watch: Watch<H> } {
  const look = lookOf(quiet_ms);
  const late = watch.at !== null && now - watch.at > 2 * look;
  const end: number[] = [];
  const waits: Watch<H>["waits"] = new Map();
  for (const { helper, job, serial } of seen) {
    if (job === null || serial === 0n) continue;
    const before = watch.waits.get(helper);
    const same = before !== undefined && before.job === job && before.serial === serial;
    const quiet = !same ? 0 : before.quiet_ms + (late ? 0 : look);
    if (quiet >= quiet_ms) end.push(job);
    else waits.set(helper, { job, serial, quiet_ms: quiet });
  }
  return { end, watch: { at: now, waits } };
}

interface Helper {
  thread: Worker;
  key: string;
  job: number | null;
  up: boolean;
  secrets: MessagePort;
  flag: Int32Array;
  reading: BigInt64Array;
}

export class Pool {
  readonly #helpers: Helper[] = [];
  readonly #ending = new Set<Promise<void>>();
  #closed = false;
  #timer: NodeJS.Timeout | undefined;
  #watch: Watch<Helper> = { at: null, waits: new Map() };
  readonly #quiet_ms: number;
  readonly #stop_grace_ms: number;
  readonly #now: () => number;
  readonly #turn: Turn;

  constructor(
    readonly size: number,
    private data: { folder: HomeFolder; registry: string; stations: Driving; runners: RunnerDriving; settings: Settings; machine: string },
    private readonly events: PoolEvents,
    { quiet_ms = READ_QUIET_MS, stop_grace_ms = STOP_GRACE_MS, now = Date.now, turn = (_of, work) => work() }: { quiet_ms?: number; stop_grace_ms?: number; now?: () => number; turn?: Turn } = {},
  ) {
    this.#quiet_ms = quiet_ms;
    this.#stop_grace_ms = stop_grace_ms;
    this.#now = now;
    this.#turn = turn;
    this.#watched();
  }

  #watched(): void {
    const seen = this.#helpers.map((helper) => ({ helper, job: helper.job, serial: Atomics.load(helper.reading, 0) }));
    const { end, watch } = quietWaits(this.#watch, this.#now(), seen, this.#quiet_ms);
    this.#watch = watch;
    for (const job of end) {
      const helper = this.#helpers.find((each) => each.job === job)!;
      const rows = Number(Atomics.load(helper.reading, 1));
      this.stop(job);
      this.events.quiet(job, rows);
    }
    this.#timer = setTimeout(() => this.#watched(), lookOf(this.#quiet_ms)).unref();
  }

  get free(): number {
    return this.size - this.busy;
  }

  get busy(): number {
    return this.#helpers.filter((helper) => helper.job !== null).length;
  }

  get ending(): number {
    return this.#ending.size;
  }

  run(task: Task): void {
    let helper = this.#helpers.find((each) => each.job === null);
    if (helper === undefined) {
      if (this.#helpers.length >= this.size) throw new Error("no helper is free");
      helper = this.#spawn();
      this.#helpers.push(helper);
    }
    helper.job = task.job;
    helper.thread.postMessage({ t: "run", task } satisfies ToHelper);
  }

  settings(settings: Settings): void {
    this.data = { ...this.data, settings };
    for (const helper of this.#helpers) helper.thread.postMessage({ t: "settings", settings } satisfies ToHelper);
  }

  privacy(privacy: Settings["privacy"]): void {
    this.data = { ...this.data, settings: { ...this.data.settings, privacy } };
    for (const helper of this.#helpers) helper.thread.postMessage({ t: "privacy", privacy } satisfies ToHelper);
  }

  ack(job: number): void {
    this.#helpers.find((helper) => helper.job === job)?.thread.postMessage({ t: "ack", job } satisfies ToHelper);
  }

  stop(job: number): void {
    const index = this.#helpers.findIndex((helper) => helper.job === job);
    if (index < 0) return;
    const [helper] = this.#helpers.splice(index, 1);
    const ending = Pool.#end(helper!, this.#stop_grace_ms);
    this.#ending.add(ending);
    void ending.then(() => this.#ending.delete(ending));
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    const canPark = parkableRegistry(this.data.registry) && process.env.LIFESTREAM_FAILPOINT === undefined;
    await Promise.all([
      ...this.#helpers.splice(0).map((helper) => canPark ? Pool.#park(helper, this.#stop_grace_ms) : Pool.#end(helper, this.#stop_grace_ms)),
      ...this.#ending,
    ]);
  }

  static #park(helper: Helper, stopGraceMs: number): Promise<void> {
    helper.secrets.close();
    raise(helper.flag, LINE.closed);
    return detachWorker(
      helper.key,
      helper.thread,
      { t: "detach" } satisfies ToHelper,
      (reply) => (reply as FromHelper | undefined)?.t === "detached",
      helper.up ? (helper.job === null ? Math.max(stopGraceMs, STOP_GRACE_MS) : stopGraceMs) : BOOT_DETACH_MS,
    );
  }

  static #end(helper: Helper, stopGraceMs: number): Promise<void> {
    const { thread } = helper;
    helper.secrets.close();
    raise(helper.flag, LINE.closed);
    for (const event of ["message", "error", "exit"]) thread.removeAllListeners(event);
    thread.on("error", () => undefined);
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const grace = () => { timer = setTimeout(() => void thread.terminate().then(() => resolve(), () => resolve()), helper.job === null ? 0 : stopGraceMs); };
      thread.on("exit", () => { clearTimeout(timer); resolve(); });
      if (helper.up) grace();
      else thread.on("message", (message: FromHelper) => { if (message.t === "up") grace(); });
      thread.postMessage({ t: "stop" } satisfies ToHelper);
    });
  }

  #spawn(): Helper {
    const program = threadProgram("helper");
    const key = workerKey(program);
    const line = new MessageChannel();
    const flag = new SharedArrayBuffer(4);
    const reading = new SharedArrayBuffer(16);
    const { folder, ...data } = this.data;
    const thread = takeWorker(key) ?? new Worker(program.url, {
      workerData: { root: folder.root },
      env: SHARE_ENV,
      ...(program.execArgv === undefined ? {} : { execArgv: program.execArgv }),
    });
    const init: HelperInit = { ...data, root: folder.root, handed: folder.handOver(), secrets: { port: line.port2, flag }, reading };
    thread.postMessage({ t: "attach", data: init } satisfies ToHelper, [line.port2]);
    const helper: Helper = { thread, key, job: null, up: false, secrets: line.port1, flag: new Int32Array(flag), reading: new BigInt64Array(reading) };
    line.port1.on("message", (asked: LineAsked) => this.#turn(`line ${asked.op}`, () => {
      if (asked.op === "copy") {
        const job = helper.job;
        const answer = job === null ? Promise.resolve<CopyAnswer>({ wait: "the helper runs no job" }) : this.events.copy(job, asked);
        void answer.catch((error: unknown): CopyAnswer => ({ error: `the sent copy was not made: ${(error as Error).message}` })).then((answered) => {
          try {
            line.port1.postMessage(answered);
          } catch {
          } finally {
            if (Atomics.compareExchange(helper.flag, 0, LINE.waiting, LINE.answered) === LINE.waiting) Atomics.notify(helper.flag, 0);
          }
        });
        return;
      }
      try {
        line.port1.postMessage(helper.job === null ? { error: { message: "the helper runs no job", reason: "refused" } } satisfies SecretAnswer : this.events.secret(helper.job, asked));
      } finally {
        raise(helper.flag, LINE.answered);
      }
    }));
    thread.on("message", (message: FromHelper) => this.#turn(`helper ${message.t}`, () => {
      if (message.t === "up") return void (helper.up = true);
      if (message.t === "detached") return;
      if (message.t === "chunk") return this.events.chunk(message.job, message.chunk);
      helper.job = null;
      if (message.t === "done") this.events.done(message.job, message.result);
      else this.events.error(message.job, message.error);
    }));
    const lost = (error: Error) => {
      if (this.#closed) return;
      const job = helper.job;
      const index = this.#helpers.indexOf(helper);
      if (index >= 0) this.#helpers.splice(index, 1);
      this.events.error(job, { ...jobError(error), message: `the helper ended: ${error.message}` });
    };
    thread.on("error", (error) => lost(error));
    thread.on("exit", (code) => lost(new Error(`exit ${code}`)));
    return helper;
  }
}

function raise(flag: Int32Array, state: (typeof LINE)["answered" | "closed"]): void {
  Atomics.store(flag, 0, state);
  Atomics.notify(flag, 0);
}
