import { refuse } from "./refusal.js";


export interface ErrandSpec {
  readonly name: string;
  readonly origins: readonly string[];
  readonly secrets?: readonly string[];
  readonly cookies?: readonly string[];
  readonly deadline_ms: number;
}

export type Step = "placed" | "running" | "closing" | "ended" | "expired";

export const CALL_SLACK_MS = 90_000;
export const FETCH_MS = 60_000;
export const FETCH_AT_ONCE = 4;
const BEGIN_SLACK_MS = 1_000;

export interface Errand {
  readonly id: string;
  readonly spec: ErrandSpec;
  readonly unit: string;
  readonly expires: number;
  step(): Step;
  holds(): boolean;
  idleFor(): number | null;
  spent(): boolean;
  run<T>(work: () => Promise<T>): Promise<T>;
  reached(): void;
  begun(): boolean;
  close(end: () => Promise<void>): Promise<void>;
  lost(): void;
  end(): void;
}

export function placeErrand(id: string, spec: ErrandSpec, unit: string, clock: () => number = Date.now): Errand {
  const expires = clock() + spec.deadline_ms;
  let stored: Exclude<Step, "expired"> = "placed";
  let closing: Promise<void> | null = null;
  let inFlight = 0;
  let last = clock();
  const step = (): Step => ((stored === "placed" || stored === "running") && clock() > expires ? "expired" : stored);
  return {
    id, spec, unit, expires,
    step,
    holds: () => stored !== "ended" && clock() <= expires + BEGIN_SLACK_MS,
    idleFor: () => (inFlight > 0 ? null : clock() - last),
    spent: () => stored !== "closing" && clock() > expires + CALL_SLACK_MS,
    async run(work) {
      inFlight++;
      try {
        return await work();
      } finally {
        inFlight--;
        last = clock();
      }
    },
    reached() {
      last = clock();
    },
    begun() {
      if (stored === "ended") return false;
      if (stored !== "placed") throw new Error(`errand ${id} is begun while ${stored}`);
      stored = "running";
      return true;
    },
    close(end) {
      if (stored === "ended") return Promise.resolve();
      if (closing !== null) return closing;
      if (stored === "placed") refuse(409, "NO_ERRAND", `errand ${id} has not begun`);
      stored = "closing";
      closing = end().finally(() => {
        stored = "ended";
      });
      return closing;
    },
    lost() {
      if (stored === "running") stored = "ended";
    },
    end() {
      stored = "ended";
    },
  };
}
