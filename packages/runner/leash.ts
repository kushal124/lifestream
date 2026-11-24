import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RELEASE, tryLock } from "@lifestreamprotocol/core";


export const HELD = 3;
export const HELD_SAID = "leash: the lock is held by another";

const EXIT_MS = 10_000;

export function leashCommand(): string[] {
  if (RELEASE !== "checkout") return [process.execPath, join(dirname(realpathSync(process.argv[1]!)), "leash.mjs")];
  const dist = process.env.LIFESTREAM_TEST_DIST;
  const bundle = dist === undefined ? undefined : join(dist, "packages~runner~leash.mjs");
  if (bundle !== undefined && existsSync(bundle)) return [process.execPath, bundle];
  return [process.execPath, "--import", "tsx", fileURLToPath(import.meta.url)];
}

function leash(args: readonly string[]): void {
  let exitMs = EXIT_MS;
  let at = 0;
  if (args[0] === "--exit-ms" && args[1] !== undefined) {
    exitMs = Number(args[1]);
    at = 2;
  }
  const [lockFile, program, ...rest] = args.slice(at);
  if (lockFile === undefined || program === undefined) {
    process.stderr.write("usage: leash <lock file> <program> <args…>\n");
    process.exit(2);
  }
  const lock = tryLock(lockFile);
  if (lock === null) return void process.stderr.write(`${HELD_SAID}\n`, () => process.exit(HELD));
  const child = spawn(program, rest, { stdio: ["ignore", "inherit", "inherit"] });
  let killing: ReturnType<typeof setTimeout> | undefined;
  const stop = (): void => {
    if (killing !== undefined || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    killing = setTimeout(() => child.kill("SIGKILL"), exitMs);
  };
  process.stdin.once("end", stop).once("close", stop).on("error", stop).resume();
  process.once("SIGTERM", stop).once("SIGINT", stop);
  child.once("error", (error) => {
    process.stderr.write(`leash: ${program} could not start: ${error.message}\n`);
    lock.release();
    process.exit(127);
  });
  child.once("exit", (code, signal) => {
    clearTimeout(killing);
    lock.release();
    process.exit(code ?? 128 + (signal === null ? 0 : constants.signals[signal]));
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) leash(process.argv.slice(2));
