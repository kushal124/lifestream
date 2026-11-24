import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const MiB = 1024 * 1024;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    chmodTree(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

export function temp(prefix = "core-blobs-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function chmodTree(dir: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    chmodSync(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o755 : 0o644);
  }
}

export function writeLargeText(path: string, size: number): void {
  const file = openSync(path, "w");
  try {
    for (let at = 0, n = 0; at < size; n++) {
      const line = `frame ${n} macbook-pro-0001 fake screen text ${"lorem ipsum ".repeat(n % 7)}\n`;
      const block = Buffer.from(line.repeat(Math.ceil(MiB / line.length))).subarray(0, Math.min(MiB, size - at));
      writeSync(file, block);
      at += block.length;
    }
  } finally {
    closeSync(file);
  }
}

export function sha256File(path: string): string {
  const digest = createHash("sha256");
  const file = openSync(path, "r");
  try {
    const chunk = Buffer.allocUnsafe(MiB);
    for (let read = readSync(file, chunk); read > 0; read = readSync(file, chunk)) digest.update(chunk.subarray(0, read));
  } finally {
    closeSync(file);
  }
  return `sha256:${digest.digest("hex")}`;
}
