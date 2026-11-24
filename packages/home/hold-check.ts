import { execFileSync, spawn } from "node:child_process";
import { handedFolderIn, KeyError, type HandedFolder } from "@lifestreamprotocol/core";
import { asked, beginCheck, hold, readHold, type Hold, type Running, type Unfinished } from "./hold.js";
import type { Machine } from "./machine.js";

export type Checked = "whole" | "found" | Unfinished;

const SAID = 10;

export function processStart(pid: number): string | null {
  try {
    const said = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return said === "" ? null : said;
  } catch {
    return null;
  }
}

export function running(): Running {
  return { running_since_ms: Date.now(), pid: process.pid, started: processStart(process.pid) ?? "" };
}

export function stale(held: Hold): boolean {
  if (held.check === null || !("running_since_ms" in held.check)) return false;
  const started = processStart(held.check.pid);
  return started === null || started !== held.check.started;
}

export function stopped(at: Machine, home: string, held: Hold): Hold {
  const value: Hold = { ...held, check: { unfinished: "stopped", at_ms: Date.now() } };
  hold(at, home, value);
  return value;
}

export function due(at: Machine, home: string, held: Hold, failed: boolean): boolean {
  if (held.check !== null && "running_since_ms" in held.check) return false;
  if (asked(at, home)) return true;
  if (failed) return false;
  return held.check === null || "unfinished" in held.check;
}

export const KEYS_ON_INPUT = "--keys-on-input";

export async function handedOnInput(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin): Promise<HandedFolder> {
  const refused = () => new KeyError("LOCKED", "this home is encrypted: its check is run by the home, which hands it the keys on standard input");
  if (input.isTTY === true) throw refused();
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") throw refused();
  return handedFolderIn(text);
}

export async function run(at: Machine, folder: string, home: string, command: readonly string[], signal?: AbortSignal, handed?: HandedFolder): Promise<{ checked: Checked; said: string[] }> {
  const began = Date.now();
  beginCheck(at, home, running());
  const said: string[] = [];
  const keep = (chunk: Buffer) => {
    said.push(...chunk.toString("utf8").split("\n").filter((line) => line !== ""));
    said.splice(0, Math.max(0, said.length - SAID));
  };
  await new Promise<void>((resolve) => {
    const child = spawn(command[0]!, [...command.slice(1), "verify", "--root", folder, ...(handed === undefined ? [] : [KEYS_ON_INPUT])], {
      env: { ...process.env, LIFESTREAM_MACHINE_DIR: at.dir }, stdio: [handed === undefined ? "ignore" : "pipe", "pipe", "pipe"], ...(signal === undefined ? {} : { signal }),
    });
    if (handed !== undefined) {
      child.stdin!.on("error", () => undefined);
      child.stdin!.end(`${JSON.stringify(handed)}\n`);
    }
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    if (process.platform === "darwin" && child.pid !== undefined) {
      spawn("/usr/bin/caffeinate", ["-i", "-w", String(child.pid)], { stdio: "ignore" }).on("error", () => undefined);
    }
    child.once("close", () => resolve());
    child.once("error", (error) => {
      said.push(String(error));
      resolve();
    });
  });
  const after = readHold(at, home);
  if (after === null) return { checked: "whole", said };
  const check = after.check;
  if (check !== null && "found" in check && check.at_ms >= began) return { checked: "found", said };
  if (check !== null && "unfinished" in check && check.at_ms >= began) return { checked: check.unfinished, said };
  stopped(at, home, after);
  return { checked: "stopped", said };
}
