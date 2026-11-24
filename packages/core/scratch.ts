import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMainThread } from "node:worker_threads";

const SCRATCH = "scratch";
export const SORTS = "sqlite";

let spills: string | undefined;
let cipherFirst = false;

export function madeScratch(machine: string): string {
  const folder = join(machine, SCRATCH);
  const made = mkdirSync(folder, { recursive: true, mode: 0o700 }) !== undefined;
  chmodSync(folder, 0o700);
  if (made) keptFromBackup(folder);
  return folder;
}

function keptFromBackup(folder: string): void {
  if (process.platform !== "darwin") return;
  try {
    execFileSync("/usr/bin/tmutil", ["addexclusion", folder], { timeout: 5_000, stdio: "ignore" });
  } catch {
  }
}

export function cipherLoaded(): void {
  if (spills === undefined) cipherFirst = true;
}

export function spillSorts(folder: string): string | null {
  if (spills !== undefined) return null;
  if (!isMainThread) {
    const named = process.env.SQLITE_TMPDIR;
    if (named === undefined || basename(named) !== SORTS || basename(dirname(named)) !== SCRATCH) {
      return `SQLITE_TMPDIR is the process's: the main thread names a machine's ${SCRATCH}/${SORTS} before it starts this thread, not ${named ?? "nothing"}`;
    }
    spills = named;
    return null;
  }
  if (cipherFirst) return `this process's sorts already spill to SQLite's own temporary folder, not ${folder}`;
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  process.env.SQLITE_TMPDIR = folder;
  spills = folder;
  return null;
}
