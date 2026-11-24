import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome, type HomeDb } from "./home-db.js";
import { openHomeFolder } from "./home-folder.js";
import { MissingVersion } from "./records.js";
import type { Version } from "./types.js";

const SOURCE = "apple-notes:local:macbook-pro-0001";
const COUNT = 60;

describe("a view's reads of versions", () => {
  let dir: string;
  let db: HomeDb;
  let ids: string[];
  const truth = new Map<string, Version>();

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "core-version-reader-"));
    db = openHome(openHomeFolder(dir), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: SOURCE, vendor: "apple", connector: "apple-notes", added_ms: 0 });
      const run = tx.tables.runs.start({ kind: "import", subject: SOURCE, started_ms: 1 });
      const rows = Array.from({ length: COUNT }, (_, n) => ({ kind: "msg", key: `k${String(n).padStart(2, "0")}`, content: { n, text: n % 7 === 0 ? `note ${n} `.repeat(900) : `note ${n}` } }));
      tx.records.land(run, { id: "d1", source: SOURCE, stated_ms: 1 }, rows, { msg: () => [] }, { has: () => true });
      tx.tables.runs.end(run, { ended_ms: 1, outcome: "ok", counts: {} });
    });
    const view = db.view();
    ids = Array.from({ length: COUNT }, (_, n) => view.head({ source: SOURCE, kind: "msg", key: `k${String(n).padStart(2, "0")}` })!.version);
    view.close();
    for (const id of ids) {
      const alone = db.view();
      truth.set(id, alone.version(id));
      alone.close();
    }
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const read = (order: readonly number[]): Version[] => {
    const view = db.view();
    try {
      return order.map((n) => view.version(ids[n]!));
    } finally {
      view.close();
    }
  };
  const all = Array.from({ length: COUNT }, (_, n) => n);

  it("answers each version asked for, whatever the order of the asks", () => {
    expect(new Set(ids).size).toBe(COUNT);
    const orders: Record<string, number[]> = {
      "in the file's order": all,
      backwards: [...all].reverse(),
      "in no order": all.map((n) => (n * 37 + 11) % COUNT),
      "each one twice": all.flatMap((n) => [n, n]),
      "a run, a gap, a run": [0, 1, 2, 3, 40, 41, 42, 43, 4, 5, 6, 50, 7],
      "every other one": all.filter((n) => n % 2 === 0),
      "a run that ends at the last row": [COUNT - 3, COUNT - 2, COUNT - 1, COUNT - 1, 0],
    };
    for (const [name, order] of Object.entries(orders)) {
      expect(read(order), name).toEqual(order.map((n) => truth.get(ids[n]!)));
    }
  });

  it("refuses a version the file lacks in the middle of a run, and answers the next as ever", () => {
    const view = db.view();
    try {
      const got = [view.version(ids[10]!), view.version(ids[11]!), view.version(ids[12]!)];
      expect(() => view.version(`sha256:${"0".repeat(64)}`)).toThrow(MissingVersion);
      got.push(view.version(ids[13]!), view.version(ids[14]!), view.version(ids[2]!));
      expect(got).toEqual([10, 11, 12, 13, 14, 2].map((n) => truth.get(ids[n]!)));
    } finally {
      view.close();
    }
  });
});
