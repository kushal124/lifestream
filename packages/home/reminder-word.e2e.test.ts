import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { civilDay, openHome, openHomeFolder } from "@lifestreamprotocol/core";
import type { DayDocument } from "@lifestreamprotocol/families";
import { dayPath } from "./derive.js";
import { startHome, type Home } from "./home.js";
import { effective } from "./settings.js";
import { count, quiet } from "./test/derived.js";
import { artifact, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { WORD_FILE } from "./test/reminder-word-registry.js";

const REGISTRY = new URL("./test/reminder-word-registry.ts", import.meta.url).pathname;
const SOURCE = "example-tasks:local:test";
const AT = Date.UTC(2026, 8, 28, 10, 0);

function printed(root: string, day: string): { json: string[]; txt: string[] } {
  try {
    const json = (JSON.parse(readFileSync(dayPath(root, day, "json"), "utf8")) as DayDocument).atoms.filter((atom) => atom.family === "calendar").map((atom) => atom.text);
    const txt = readFileSync(dayPath(root, day, "txt"), "utf8").split("\n").filter((line) => line.includes("Mail the invoice")).map((line) => line.trim());
    return { json, txt };
  } catch {
    return { json: [], txt: [] };
  }
}

function generation(root: string): number {
  return readHome(root, (db) => db.prepare("SELECT generation FROM cursors WHERE name = 'rebuild:calendar'").pluck().get() as number | undefined) ?? 0;
}

describe("a reminder's word", () => {
  let root: string;
  let home: Home | undefined;
  let day: string;

  beforeAll(async () => {
    root = makeRoot("lifestream-reminder-word-", { sources: {} });
    writeFileSync(join(root, WORD_FILE), JSON.stringify({ word: "Task" }));
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: SOURCE, vendor: "example", connector: "example-tasks-rows", added_ms: 0 }));
    db.close();
    day = civilDay(AT, effective(root).settings.day);
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
  });

  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("changed with no version moved, leaves day.txt and day.json printing the old word", async () => {
    await ship(root, { source: SOURCE, fetched_ms: AT + 60_000, rows: [{ kind: "reminder", key: "task-1", content: { title: "Mail the invoice", done: AT }, at: AT }] as never });
    await until("the day files print the task", () => printed(root, day).json.length === 1 && printed(root, day).txt.length === 1);
    const before = printed(root, day);
    expect(before.json).toEqual(["Task “Mail the invoice” completed"]);
    expect(before.txt).toEqual([expect.stringContaining("Task “Mail the invoice” completed")]);

    await until("the home at rest", () => quiet(root));
    const walked = generation(root);
    await home!.stop();
    home = undefined;
    writeFileSync(join(root, WORD_FILE), JSON.stringify({ word: "To-do" }));
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    await until("the calendar family walked and published, and the home at rest", () => generation(root) === walked + 1 &&
      count(root, "SELECT count(*) FROM cursors WHERE name = 'rebuild:calendar' AND seq > 0") === 0 && quiet(root));
    const after = printed(root, day);
    expect(after.json).toEqual(["To-do “Mail the invoice” completed"]);
    expect(after.txt).toEqual([expect.stringContaining("To-do “Mail the invoice” completed")]);
    artifact(root, "reminder-word", { day, before, after });
  });
});
