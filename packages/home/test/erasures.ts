import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readHome, readLedger } from "./harness-root.js";

export const MINUTE = 60_000;
export const SOURCE = "apple-notes:local:device-a";

export const note = (key: string, text: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: "note", key, content: { text, at, ...extra }, at });
export const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
export const quiet = (root: string): boolean => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
export const requests = (root: string, item: string): number => readLedger(root, (db) => db.prepare("SELECT count(*) FROM requests WHERE unit = ?").pluck().get(item) as number) ?? 0;
export const inFlight = (root: string): number => readLedger(root, (db) => db.prepare("SELECT count(*) FROM attempts WHERE state = 'sending'").pluck().get() as number) ?? 0;

export const sharded = (store: string, hash: string): string => join(store, hash.slice(0, 2), hash.slice(2, 4), hash);
export const filesUnder = (directory: string): string[] => !existsSync(directory) ? [] : (readdirSync(directory, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();

export function left(root: string, key: string) {
  return {
    statements: count(root, "SELECT count(*) FROM statements WHERE key = ?", key),
    heads: count(root, "SELECT count(*) FROM heads WHERE key = ?", key),
    erasures: count(root, "SELECT count(*) FROM erasures WHERE key = ?", key),
    enrichments: count(root, "SELECT count(*) FROM enrichments WHERE item = ?", `photo:${key}`),
    requests: requests(root, `photo:${key}`),
  };
}
