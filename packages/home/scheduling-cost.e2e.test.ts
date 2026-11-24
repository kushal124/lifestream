import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { startHome } from "./home.js";
import { LANE } from "./jobs.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const SOURCE = "apple-notes:local:device-a";
const BOUND = 30;

interface Transaction {
  landing: boolean;
  own: number;
  scheduling: number;
  scheduling_ms: number;
}

type Method = (this: unknown, ...args: unknown[]) => unknown;

function countStatements(): { transactions: Transaction[]; stop(): void } {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, Method>;
  probe.close();
  const database = Database.prototype as unknown as Record<string, Method>;
  const names = ["run", "get", "all", "iterate"] as const;
  const originals = Object.fromEntries(names.map((name) => [name, statement[name]!])) as Record<(typeof names)[number], Method>;
  const exec = database.exec!;
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 64;
  const transactions: Transaction[] = [];
  let open: Transaction | null = null;
  for (const name of names) {
    statement[name] = function counted(this: unknown, ...args: unknown[]) {
      if (open === null) return originals[name].apply(this, args);
      const stack = new Error().stack ?? "";
      if (stack.includes("/home/import.ts")) {
        open.own++;
        if (stack.includes("Records.land")) open.landing = true;
        return originals[name].apply(this, args);
      }
      const began = performance.now();
      try {
        return originals[name].apply(this, args);
      } finally {
        open.scheduling++;
        open.scheduling_ms += performance.now() - began;
      }
    };
  }
  database.exec = function counted(this: unknown, sql: unknown) {
    if (sql === "BEGIN IMMEDIATE") open = { landing: false, own: 0, scheduling: 0, scheduling_ms: 0 };
    const result = exec.call(this, sql);
    if ((sql === "COMMIT" || sql === "ROLLBACK") && open !== null) {
      transactions.push(open);
      open = null;
    }
    return result;
  };
  return {
    transactions,
    stop() {
      for (const name of names) statement[name] = originals[name];
      database.exec = exec;
      Error.stackTraceLimit = limit;
    },
  };
}

describe("an import slice's scheduling is a fixed few statements, whatever waits in the inbox", () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  async function measure(sources: number, per: number): Promise<{ slices: Transaction[]; waiting: number }> {
    const root = makeRoot(`lifestream-scheduling-cost-${sources}-`, { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const now = Date.now();
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      for (let source = 0; source < sources; source++) {
        const id = `apple-notes:local:blocked-${String(source).padStart(4, "0")}`;
        tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: "fake-rows", added_ms: 0 });
        for (let delivery = 0; delivery < per; delivery++) {
          const stated = now - 3 * 86_400_000 + delivery * 60_000;
          tx.tables.deliveries.add({ id: `${id}/d${String(delivery).padStart(4, "0")}`, source: id, sealed_ms: stated, stated_ms: stated, facts: {} });
        }
        tx.tables.jobs.enqueue({ kind: "import", key: id, lane: LANE.history, not_before_ms: now, now_ms: now });
        const job = tx.tables.jobs.get("import", id)!.id;
        for (let attempt = 0; attempt < 5; attempt++) tx.tables.jobs.fail(job, "a synthetic outage", now);
      }
    });
    db.close();
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined });
    const imported = () => readHome(root, (read) => read.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(SOURCE)) as number;
    const counter = countStatements();
    try {
      const at = Date.now() - 60_000;
      const rows = Array.from({ length: 500 }, (_, index) => ({ kind: "note", key: `n${index}`, content: { text: `synthetic note ${index}`, at: at + index }, at: at + index }));
      await ship(root, { source: SOURCE, fetched_ms: at, rows });
      await until("the delivery imported", () => imported() === 1);
    } finally {
      counter.stop();
      await home.stop();
    }
    const waiting = readHome(root, (read) => read.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing', 'failed')").pluck().get()) as number;
    return { slices: counter.transactions.filter((each) => each.landing), waiting };
  }

  it("20 deliveries waiting on 10 sources, or 20,000 on 1,000: the same few statements a slice", async () => {
    const small = await measure(10, 2);
    const large = await measure(1_000, 20);
    const per = (measured: { slices: Transaction[]; waiting: number }) => ({
      waiting: measured.waiting,
      slices: measured.slices.length,
      own: measured.slices.map((slice) => slice.own),
      scheduling: measured.slices.map((slice) => slice.scheduling),
      scheduling_ms: measured.slices.map((slice) => Math.round(slice.scheduling_ms * 1000) / 1000),
    });
    const result = { bound: BOUND, small: per(small), large: per(large) };
    artifact(roots[1]!, "scheduling-cost", result);
    expect(result.small.waiting).toBe(20);
    expect(result.large.waiting).toBe(20_000);
    expect(result.small.slices).toBeGreaterThan(0);
    expect(result.large.slices).toBeGreaterThan(0);
    expect(Math.max(...result.small.scheduling)).toBeLessThanOrEqual(BOUND);
    expect(Math.max(...result.large.scheduling)).toBeLessThanOrEqual(BOUND);
  });
});
