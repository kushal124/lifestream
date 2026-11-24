import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { flush, isObject, tryLock, writeDurably } from "@lifestreamprotocol/core";
import type { Machine } from "./machine.js";
import type { Act } from "./streams-report.js";

export interface Hold {
  since_ms: number;
  cause: HoldCause;
  check: HoldCheck;
}

export type HoldCause = { met: HomeDatabase; error: string } | { missing: HomeDatabase };

export type HoldCheck = null | Running | { found: string[]; at_ms: number } | { unfinished: Unfinished; at_ms: number };

export interface Running {
  running_since_ms: number;
  pid: number;
  started: string;
}

export type Unfinished = "drive" | "stopped";

export type HomeDatabase = "home.db" | "the ledger";

export interface HoldWords {
  message: string;
  detail: string;
  acts: Act[];
}

const HOLD_DIRECTORY = "hold";
const CHECK_AGAIN: Act = { do: "verify", label: "Check again" };

export function readHold(at: Machine, home: string): Hold | null {
  let text: string;
  try {
    text = readFileSync(holdPath(at, home), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return unreadable(`${holdPath(at, home)} cannot be read (${(error as Error).message})`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (isObject(value) && typeof value.since_ms === "number" && isCause(value.cause) && isCheck(value.check)) {
      return { since_ms: value.since_ms, cause: value.cause, check: value.check };
    }
  } catch {
  }
  return unreadable(`${holdPath(at, home)} is not a hold`);
}

export function hold(at: Machine, home: string, value: Hold): void {
  mkdirSync(join(at.dir, HOLD_DIRECTORY), { recursive: true });
  writeDurably(holdPath(at, home), `${JSON.stringify(value)}\n`);
}

export function release(at: Machine, home: string): void {
  rmSync(holdPath(at, home), { force: true });
  rmSync(askPath(at, home), { force: true });
  if (existsSync(join(at.dir, HOLD_DIRECTORY))) flush(join(at.dir, HOLD_DIRECTORY));
}

function askCheck(at: Machine, home: string): void {
  mkdirSync(join(at.dir, HOLD_DIRECTORY), { recursive: true });
  writeDurably(askPath(at, home), "{}\n");
}

const ADMIT_MS = 2_000;

function admitting<T>(at: Machine, home: string, step: () => T, waitMs = ADMIT_MS): T {
  mkdirSync(join(at.dir, HOLD_DIRECTORY), { recursive: true });
  const giveUp = Date.now() + waitMs;
  for (;;) {
    const lock = tryLock(join(at.dir, HOLD_DIRECTORY, `${home}.lock`));
    if (lock !== null) {
      try {
        return step();
      } finally {
        lock.release();
      }
    }
    if (Date.now() >= giveUp) throw new Error("the hold's lock is held: try again in a moment");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

export function admitAsk(at: Machine, home: string, during: () => void = () => undefined): "asked" | "checking" | "free" {
  return admitting(at, home, () => {
    const held = readHold(at, home);
    during();
    if (held === null) return "free";
    if (holdWords(held, asked(at, home)).acts.length === 0) return "checking";
    askCheck(at, home);
    return "asked";
  });
}

export function beginCheck(at: Machine, home: string, running: Running, waitMs?: number): Hold | null {
  return admitting(at, home, () => {
    const held = readHold(at, home);
    if (held !== null) hold(at, home, { ...held, check: running });
    takeAsk(at, home);
    return held;
  }, waitMs);
}

export function asked(at: Machine, home: string): boolean {
  return existsSync(askPath(at, home));
}

function takeAsk(at: Machine, home: string): void {
  rmSync(askPath(at, home), { force: true });
}

export function holdWords(value: Hold, asking = false): HoldWords {
  if (asking || value.check === null || "running_since_ms" in value.check) {
    return { message: "Lifestream is checking its database", detail: "It starts again when the check ends, up to an hour", acts: [] };
  }
  if ("unfinished" in value.check) {
    return {
      message: "Lifestream's database check stopped",
      detail: value.check.unfinished === "drive" ? "Connect its drive and it checks again" : "Check it again",
      acts: [CHECK_AGAIN],
    };
  }
  if ("missing" in value.cause) return { message: "Lifestream's database is missing", detail: "Put back a copy from a backup", acts: [CHECK_AGAIN] };
  return { message: "Lifestream's database is damaged", detail: "Put back a copy from a backup", acts: [CHECK_AGAIN] };
}

export function holdLine(value: Hold, folder: string): string {
  const { message, detail } = holdWords(value);
  const checking = value.check === null || "running_since_ms" in value.check;
  const facts = [
    "missing" in value.cause ? `${value.cause.missing} is not in its folder` : value.cause.met,
    ...checking ? [`checking ${sized(homeBytes(folder))}`] : [],
    ...value.check !== null && "found" in value.check ? value.check.found : [],
  ];
  return `${message}: ${detail} (${facts.join("; ")})`;
}

function homeBytes(folder: string): number {
  let bytes = 0;
  for (const path of [join(folder, "home.db"), join(folder, "replies", "replies.db")]) {
    try {
      bytes += statSync(path).size;
    } catch {
    }
  }
  return bytes;
}

function sized(bytes: number): string {
  return bytes >= 1e9 ? `${Math.round(bytes / 1e9)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function unreadable(error: string): Hold {
  return { since_ms: 0, cause: { met: "home.db", error }, check: null };
}

function isDatabase(value: unknown): value is HomeDatabase {
  return value === "home.db" || value === "the ledger";
}

function isCause(value: unknown): value is HoldCause {
  if (!isObject(value)) return false;
  return (isDatabase(value.met) && typeof value.error === "string") || isDatabase(value.missing);
}

function isCheck(value: unknown): value is HoldCheck {
  if (value === null) return true;
  if (!isObject(value)) return false;
  if (typeof value.running_since_ms === "number" && typeof value.pid === "number" && typeof value.started === "string") return true;
  if ((value.unfinished === "drive" || value.unfinished === "stopped") && typeof value.at_ms === "number") return true;
  return Array.isArray(value.found) && value.found.every((line) => typeof line === "string") && typeof value.at_ms === "number";
}

function holdPath(at: Machine, home: string): string {
  return join(at.dir, HOLD_DIRECTORY, `${home}.json`);
}

function askPath(at: Machine, home: string): string {
  return join(at.dir, HOLD_DIRECTORY, `${home}.ask`);
}
