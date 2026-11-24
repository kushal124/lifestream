import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, statfsSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

export const KEEP_BYTES = 5_000_000_000;
export const BOTTOM_BYTES = 1_000_000_000;
export const RECHECK_BYTES = 256 * 1024 * 1024;

export type WriteKind = "new" | "later";
export type Room = "ok" | "low" | "full";

export function roomOf(free: number | null): Room {
  if (free === null) return "low";
  return free < BOTTOM_BYTES ? "full" : free < KEEP_BYTES ? "low" : "ok";
}

export function roomAt(path: string): Room {
  return roomOf(freeOf(path));
}

export function lineOf(kind: WriteKind): number {
  return kind === "new" ? BOTTOM_BYTES : KEEP_BYTES;
}

export function fits(free: number | null, kind: WriteKind, bytes: number): boolean {
  if (free === null) return kind === "new";
  return free - bytes >= lineOf(kind);
}

export function freeOf(path: string): number | null {
  try {
    return diskSpace(path).free_bytes;
  } catch {
    return null;
  }
}

export function spare(free: number): number {
  return Math.max(0, free - KEEP_BYTES);
}

export function diskSpace(path: string): { total_bytes: number; free_bytes: number } {
  const stats = statfsSync(path);
  return { total_bytes: Number(stats.blocks) * Number(stats.bsize), free_bytes: Number(stats.bavail) * Number(stats.bsize) };
}

export const OWNER_ONLY_MASK = 0o077;

export function ownerOnly(): void {
  process.umask(OWNER_ONLY_MASK);
}

export function makeUnder(under: string, path: string, mode = 0o700): void {
  let at = under;
  for (const part of relative(under, path).split(sep)) {
    if (part === "") continue;
    at = join(at, part);
    try {
      mkdirSync(at, { mode });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function writeDurably(path: string, data: string | Uint8Array, mode = 0o600): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, data, { mode, flag: "wx" });
    flush(temporary);
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
  flush(dirname(path));
}

export function flush(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export async function flushed(path: string): Promise<void> {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
