import { CHECKPOINT_PAGES } from "@lifestreamprotocol/core";


export interface Stands {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface Copied {
  checkpointed: number;
  ms: number;
}

export type CopyEnd = Copied | "lost" | "closed";

export type DrainEnd = "emptied" | "outlasted" | "outside";

export interface Drain {
  at_ms: number;
  end: DrainEnd;
  ms: number;
  frames: number;
  jobs: number;
}

export interface LogSeam {
  now(): number;
  look(): Stands;
  copy(): void;
  truncate(wait_ms: number): Stands;
  began(frames: number, jobs: number): void;
  ended(drain: Drain): void;
  need(since_ms: number | null): void;
}

export const DRAIN_PAGES = 262_144;
export const RESIDUE_PAGES = 1_024;
export const LOG_DRAIN = "log-drain";
export const DRAIN_MS = 2 * 60_000;
export const BEHIND_MS = 10 * 60_000;
export const RECHECK_MS = 60_000;

export class WriteLog {
  readonly #seam: LogSeam;
  readonly #drainPages: number;
  readonly #turnMs: number;
  #tried: number | null = null;
  #triedAt = 0;
  #out: { from: number } | null = null;
  #drain: { since_ms: number; frames: number; running: Set<number> } | null = null;
  #after: { jobs: Set<number> } | { frames: number } | null = null;
  #outside: { since_ms: number; raised: boolean } | null;

  constructor(seam: LogSeam, options: { drain_pages?: number; turn_ms: number }, raised: number | null) {
    this.#seam = seam;
    this.#drainPages = options.drain_pages ?? DRAIN_PAGES;
    this.#turnMs = options.turn_ms;
    this.#outside = raised === null ? null : { since_ms: raised, raised: true };
  }

  tick(clock: boolean, running: ReadonlySet<number>): void {
    if (this.#out !== null || this.#drain !== null) return;
    const now = this.#seam.now();
    const stands = this.#seam.look();
    const due = stands.log >= CHECKPOINT_PAGES && (this.#tried === null || stands.log - this.#tried >= CHECKPOINT_PAGES);
    const paced = this.#outside !== null && now - this.#triedAt >= RECHECK_MS;
    if (!clock && !due && !paced) {
      if (stands.log < CHECKPOINT_PAGES) this.#emptied();
      return;
    }
    this.#try(stands, running);
  }

  mayStart(running: ReadonlySet<number>): boolean {
    const drain = this.#drain;
    if (drain === null) {
      this.#noteEnded(running);
      return true;
    }
    const ended = [...drain.running].some((job) => !running.has(job));
    drain.running = new Set(running);
    if (this.#out === null) {
      if (running.size > 0 && !ended && this.#seam.now() < drain.since_ms + DRAIN_MS) return false;
      this.#try(this.#seam.look(), running);
    }
    if (this.#drain === null) return true;
    if (this.#out === null || this.#seam.now() < drain.since_ms + DRAIN_MS) return false;
    this.#bounded(this.#seam.look(), running);
    return true;
  }

  copied(end: CopyEnd, running: ReadonlySet<number>): void {
    const out = this.#out;
    if (out === null) return;
    this.#out = null;
    if (end === "closed") return;
    const stands = this.#seam.look();
    if (end !== "lost" && (stands.log - stands.checkpointed < RESIDUE_PAGES || end.checkpointed > out.from)) this.#try(stands, running);
    else this.#settle({ ...stands, busy: 1 }, running);
  }

  #try(stands: Stands, running: ReadonlySet<number>): void {
    if (stands.log - stands.checkpointed >= RESIDUE_PAGES) {
      this.#seam.copy();
      this.#out = { from: stands.checkpointed };
      return;
    }
    this.#settle(this.#seam.truncate(this.#wait(running)), running);
  }

  #wait(running: ReadonlySet<number>): number {
    const drain = this.#drain;
    if (drain === null) return this.#counts(running) ? this.#turnMs : 0;
    if (running.size > 0) return 0;
    return Math.max(0, Math.min(this.#turnMs, drain.since_ms + DRAIN_MS - this.#seam.now()));
  }

  #counts(running: ReadonlySet<number>): boolean {
    return this.#outside !== null && running.size === 0;
  }

  #settle(stands: Stands, running: ReadonlySet<number>): void {
    const now = this.#seam.now();
    const drain = this.#drain;
    if (drain !== null) {
      if (stands.log < CHECKPOINT_PAGES) this.#end(stands, "emptied", running);
      else if (now >= drain.since_ms + DRAIN_MS) this.#bounded(stands, running);
      return;
    }
    const counts = this.#counts(running);
    this.#triedAt = now;
    if (stands.log < CHECKPOINT_PAGES) {
      this.#emptied();
      return;
    }
    this.#tried = stands.log;
    if (counts) this.#behind(now);
    if (stands.log < this.#drainPages || !this.#mayDrain(stands.log, running)) return;
    this.#drain = { since_ms: now, frames: stands.log, running: new Set(running) };
    this.#seam.began(stands.log, running.size);
  }

  #bounded(stands: Stands, running: ReadonlySet<number>): void {
    if (stands.log < CHECKPOINT_PAGES) {
      this.#end(stands, "emptied", running);
    } else if (running.size > 0) {
      this.#after = { jobs: new Set(running) };
      this.#end(stands, "outlasted", running);
    } else {
      this.#after = { frames: stands.log + this.#drainPages };
      this.#end(stands, "outside", running);
    }
  }

  #mayDrain(frames: number, running: ReadonlySet<number>): boolean {
    this.#noteEnded(running);
    const after = this.#after;
    if (after !== null && "frames" in after && frames >= after.frames) this.#after = null;
    return this.#after === null;
  }

  #noteEnded(running: ReadonlySet<number>): void {
    const after = this.#after;
    if (after !== null && "jobs" in after && [...after.jobs].every((job) => !running.has(job))) this.#after = null;
  }

  #end(stands: Stands, end: DrainEnd, running: ReadonlySet<number>): void {
    const drain = this.#drain!;
    this.#drain = null;
    const at_ms = this.#seam.now();
    this.#seam.ended({ at_ms, end, ms: at_ms - drain.since_ms, frames: drain.frames, jobs: running.size });
    if (end === "emptied") {
      this.#emptied();
      return;
    }
    this.#tried = stands.log;
    this.#triedAt = at_ms;
    if (end === "outside") {
      this.#outside ??= { since_ms: at_ms, raised: false };
      this.#behind(at_ms);
    }
  }

  #behind(at_ms: number): void {
    const outside = this.#outside!;
    if (outside.raised || at_ms - outside.since_ms < BEHIND_MS) return;
    outside.raised = true;
    this.#seam.need(outside.since_ms);
  }

  #emptied(): void {
    this.#tried = null;
    this.#after = null;
    const outside = this.#outside;
    this.#outside = null;
    if (outside?.raised === true) this.#seam.need(null);
  }
}
