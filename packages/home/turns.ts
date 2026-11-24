import { monitorEventLoopDelay } from "node:perf_hooks";
import type { JsonObject } from "@lifestreamprotocol/core";
import { Refusal } from "./refusal.js";
import type { Call } from "./socket.js";

export const TURN_BUDGET_MS = 100;
const SLOW_MS = 1_000;
const COMMIT_SAMPLES = 65_536;

export type Truncated = { busy: number; log: number; checkpointed: number };
export type Polled = { bytes: number; rows: number };
export type Part = (name: string) => void;

export interface Turns {
  run<T>(of: string, work: (part: Part) => T, under?: Call): T;
  request(verb: string, call: Call, answer: (call: Call) => Promise<unknown>): Promise<unknown>;
  answeredAtArrival(verb: string | null, sent_ms: number | null, answer: string): void;
  committed(ms: number, due_ms: number): void;
  checkpointed(ms: number | null, result: Truncated): void;
  copied(ms: number): void;
  polled(left: Polled | null): void;
  line(): JsonObject;
}

export interface TurnsOptions {
  log: (line: JsonObject) => void;
  slow_ms?: number;
  now?: () => number;
  cpu?: () => number;
}

export function openTurns(options: TurnsOptions): Turns {
  return new Layer(options);
}

function threadCpu(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1_000;
}

const rounded = (ms: number): number => Math.round(ms * 100) / 100;

interface Asked {
  readonly verb: string;
  readonly sent_ms: number | null;
  began: number | null;
  cpu: number;
  readonly parts: Map<string, number>;
}

interface Frame {
  readonly of: string;
  readonly start: number;
  readonly cpu: number;
  readonly asked: Asked | null;
  readonly marks: { name: string; at: number; nested: number }[];
  nested_ms: number;
  nested_cpu: number;
}

class Layer implements Turns {
  readonly #log: (line: JsonObject) => void;
  readonly #slow_ms: number;
  readonly #now: () => number;
  readonly #cpu: () => number;
  readonly #frames: Frame[] = [];
  readonly #asked = new WeakMap<Call, Asked>();
  readonly #loop = monitorEventLoopDelay();
  readonly #samples = new Float64Array(COMMIT_SAMPLES);
  readonly #due = new Float64Array(COMMIT_SAMPLES);
  #commits = 0;
  #max_ms = 0;
  #due_max_ms = 0;
  #checkpoints = 0;
  #checkpoint_ms = 0;
  #copies = 0;
  #copy_ms = 0;
  #truncate: Truncated | null = null;
  #polls = { calls: 0, cursor_bytes: 0, memory_rows: 0 };
  #over = new Map<string, { count: number; max_ms: number }>();

  constructor({ log, slow_ms = SLOW_MS, now = Date.now, cpu = threadCpu }: TurnsOptions) {
    this.#log = log;
    this.#slow_ms = slow_ms;
    this.#now = now;
    this.#cpu = cpu;
    this.#loop.enable();
  }

  run<T>(of: string, work: (part: Part) => T, under?: Call): T {
    return this.#run(of, null, work, under === undefined ? null : this.#asked.get(under) ?? null);
  }

  request(verb: string, call: Call, answer: (call: Call) => Promise<unknown>): Promise<unknown> {
    const asked: Asked = { verb, sent_ms: call.sent_ms, began: null, cpu: 0, parts: new Map() };
    const begun: Call = {
      left: call.left,
      sent_ms: call.sent_ms,
      began: () => {
        if (asked.began === null) asked.began = this.#now();
        call.began();
      },
    };
    this.#asked.set(begun, asked);
    const pending = this.#run(`request ${verb}`, asked, () => {
      try {
        return answer(begun);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return pending.then((result) => {
      this.#answered(asked, "ok");
      return result;
    }, (error: unknown) => {
      this.#answered(asked, error instanceof Refusal ? error.code : "error");
      throw error;
    });
  }

  answeredAtArrival(verb: string | null, sent_ms: number | null, answer: string): void {
    this.#log({ request: verb, queued_ms: sent_ms === null ? null : Math.round(this.#now() - sent_ms), ran_ms: null, answer });
  }

  committed(ms: number, due_ms: number): void {
    const at = this.#commits++ % COMMIT_SAMPLES;
    this.#samples[at] = ms;
    this.#due[at] = due_ms;
    this.#max_ms = Math.max(this.#max_ms, ms);
    this.#due_max_ms = Math.max(this.#due_max_ms, due_ms);
  }

  checkpointed(ms: number | null, result: Truncated): void {
    if (ms !== null) {
      this.#checkpoints++;
      this.#checkpoint_ms = Math.max(this.#checkpoint_ms, ms);
    }
    this.#truncate = result;
  }

  copied(ms: number): void {
    this.#copies++;
    this.#copy_ms = Math.max(this.#copy_ms, ms);
  }

  polled(left: Polled | null): void {
    this.#polls.calls++;
    this.#polls.cursor_bytes += left?.bytes ?? 0;
    this.#polls.memory_rows += left?.rows ?? 0;
  }

  line(): JsonObject {
    const count = Math.min(this.#commits, COMMIT_SAMPLES);
    const figures = (samples: Float64Array, max_ms: number) => {
      const sorted = samples.subarray(0, count).sort();
      const share = (of: number) => (sorted.length === 0 ? null : rounded(sorted[Math.ceil(of * sorted.length) - 1]!));
      return { p50_ms: share(0.5), p99_ms: share(0.99), max_ms: rounded(max_ms) };
    };
    const line = {
      commits: this.#commits, ...figures(this.#samples, this.#max_ms), due: figures(this.#due, this.#due_max_ms),
      checkpoints: this.#checkpoints, checkpoint_max_ms: rounded(this.#checkpoint_ms),
      copies: this.#copies, copy_max_ms: rounded(this.#copy_ms), truncate: this.#truncate, polls: this.#polls,
      over: Object.fromEntries([...this.#over].map(([of, { count: over, max_ms }]) => [of, { count: over, max_ms: rounded(max_ms) }])),
      loop: { p99_ms: rounded(this.#loop.percentile(99) / 1e6), max_ms: rounded(this.#loop.max / 1e6) },
    };
    this.#polls = { calls: 0, cursor_bytes: 0, memory_rows: 0 };
    this.#commits = 0;
    this.#max_ms = 0;
    this.#due_max_ms = 0;
    this.#checkpoints = 0;
    this.#checkpoint_ms = 0;
    this.#copies = 0;
    this.#copy_ms = 0;
    this.#over = new Map();
    this.#loop.reset();
    return line;
  }

  #run<T>(of: string, asked: Asked | null, work: (part: Part) => T, under: Asked | null = null): T {
    const outer = this.#frames.at(-1);
    const frame: Frame = { of, start: this.#now(), cpu: this.#cpu(), asked: asked ?? under ?? outer?.asked ?? null, marks: [], nested_ms: 0, nested_cpu: 0 };
    this.#frames.push(frame);
    let failed = true;
    try {
      const result = work((name) => frame.marks.push({ name, at: this.#now(), nested: frame.nested_ms }));
      failed = false;
      return result;
    } finally {
      this.#frames.pop();
      this.#ended(frame, outer, asked !== null, failed);
    }
  }

  #ended(frame: Frame, outer: Frame | undefined, own: boolean, failed: boolean): void {
    const end = this.#now();
    const spent = this.#cpu() - frame.cpu;
    const wall = end - frame.start;
    if (outer !== undefined) {
      outer.nested_ms += wall;
      outer.nested_cpu += spent;
    }
    const ms = wall - frame.nested_ms;
    const cpu = spent - frame.nested_cpu;
    const parts = new Map<string, number>();
    frame.marks.forEach((mark, index) => {
      const next = frame.marks[index + 1] ?? { at: end, nested: frame.nested_ms };
      parts.set(mark.name, (parts.get(mark.name) ?? 0) + (next.at - mark.at) - (next.nested - mark.nested));
    });
    if (own) frame.asked!.cpu += spent;
    else if (frame.asked !== null) {
      for (const [name, part] of parts) frame.asked.parts.set(name, (frame.asked.parts.get(name) ?? 0) + part);
      const lender = outer?.asked ?? null;
      if (lender !== frame.asked) {
        frame.asked.cpu += spent;
        if (lender !== null) lender.cpu -= spent;
      }
    }
    if (cpu > TURN_BUDGET_MS) {
      const over = this.#over.get(frame.of) ?? { count: 0, max_ms: 0 };
      this.#over.set(frame.of, { count: over.count + 1, max_ms: Math.max(over.max_ms, cpu) });
    }
    if (ms > this.#slow_ms) {
      this.#log({ slow: Math.round(ms), of: frame.of, cpu_ms: Math.round(cpu), ...msOf(parts), ...(failed ? { failed: true } : {}) });
    }
  }

  #answered(asked: Asked, answer: string): void {
    const end = this.#now();
    this.#log({
      request: asked.verb,
      queued_ms: asked.began === null || asked.sent_ms === null ? null : Math.round(asked.began - asked.sent_ms),
      ran_ms: asked.began === null ? null : Math.round(end - asked.began),
      cpu_ms: Math.round(asked.cpu),
      ...msOf(asked.parts),
      answer,
    });
  }
}

function msOf(parts: ReadonlyMap<string, number>): JsonObject {
  return Object.fromEntries([...parts].map(([name, ms]) => [`${name}_ms`, Math.round(ms)]));
}
