import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll } from "vitest";
import { openHome, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { startHome, type Home } from "../home.js";
import { FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS } from "./harness-root.js";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const UTC4: DaySettings = { zone: "UTC", day_start_hour: 4 };
export const SOURCE = "apple-notes:local:device-a";

export const dayText = (root: string, day: string): string => {
  const path = join(root, "days", `${day}.day.txt`);
  return existsSync(path) ? readFileSync(path, "utf8") : "";
};
export const note = (key: string, text: string, at: number, extra: Record<string, unknown> = {}) => ({ kind: "note", key, content: { text, at, ...extra }, at });
export const count = (root: string, sql: string, ...params: unknown[]): number => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
export const unitOf = (at: number): string => `${SOURCE}/${new Date(at).toISOString().slice(0, 10)}`;
export const extractOf = (root: string, unit: string): unknown => {
  const db = openHome(openHomeFolder(root), "read");
  const view = db.view();
  try {
    return view.extract("notes", unit)?.content;
  } finally {
    view.close();
    db.close();
  }
};
export const quiet = (root: string): boolean => count(root, "SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;

export function derivedHomes(): { roots: string[]; open: (prefix: string, settings?: Record<string, unknown>, sending?: boolean) => Promise<{ root: string; home: Home }> } {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });
  async function open(prefix: string, settings?: Record<string, unknown>, sending = true): Promise<{ root: string; home: Home }> {
    const root = makeRoot(prefix, { sources: { [SOURCE]: "fake-rows", "screen:local:mac-0001": "fake-rows" }, ...(settings === undefined ? {} : { settings: settings as never }), ...(sending ? {} : { defaults: false }) });
    roots.push(root);
    const home = await startHome(root, { registry: FAKES, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50 });
    return { root, home };
  }
  return { roots, open };
}
