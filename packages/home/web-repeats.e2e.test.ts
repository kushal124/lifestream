import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { startHome } from "./home.js";
import { searchFileOf } from "./search-index.js";
import { LOOK_MS, makeRoot, readHome, removeRoot, searchIndexed, TICK_MS, until } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { TEST_UNIT } from "./test/folder.js";

type History = import("../connect/browser/chrome/test/fixture.js").History;
const { createHistory } = (await import(new URL("../connect/browser/chrome/test/fixture.ts", import.meta.url).href)) as typeof import("../connect/browser/chrome/test/fixture.js");

const REGISTRY = new URL("./test/errand-tabs-registry.ts", import.meta.url);
const CHROME = `chrome:profile-1:${TEST_UNIT}`;
const SHOP = "https://www.shop.example/frames";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-09-28T09:00:00Z");
const LINK = 0x30000000;
const SELF = 0x60000000;

const chromeTime = (ms: number): bigint => (BigInt(ms) + 11_644_473_600_000n) * 1000n;

interface Visit {
  id: number;
  at: number;
  transition: number;
  from?: number;
  tab?: number;
}

function history(visits: readonly Visit[]): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "web-repeats-history-"));
  try {
    const store: History = {
      urls: [{ id: 1, url: SHOP, title: "Framespage Shop", lastVisit: chromeTime(Math.max(...visits.map((visit) => visit.at))) }],
      visits: visits.map((visit) => ({ id: visit.id, url: 1, at: chromeTime(visit.at), transition: visit.transition, ...(visit.from === undefined ? {} : { from: visit.from }) })),
      searches: [], downloads: [],
      tabbed: visits.flatMap((visit) => visit.tab === undefined ? [] : [{ visit: visit.id, tab: visit.tab, foreground: 3_000_000 }]),
    };
    createHistory(join(dir, "history.sqlite"), store);
    return readFileSync(join(dir, "history.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function entries(root: string): number[] {
  const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true, timeout: 10_000 });
  try {
    const keys = db.prepare("SELECT key FROM records WHERE source = ? AND kind = 'page-visit'").pluck().all(CHROME) as string[];
    return keys.map((key) => Number(key.split(":")[0])).sort((left, right) => left - right);
  } finally {
    db.close();
  }
}

describe("a page's repeat of itself in search", () => {
  it("1-2: the index reads a repeat again when the visit it repeats loses its tab, though the repeat was never stated again", async () => {
    const root = makeRoot("lifestream-web-repeats-", { sources: { [CHROME]: "chrome-history" }, defaults: false });
    onTestFinished(() => removeRoot(root));
    const home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, tickMs: TICK_MS, lookMs: LOOK_MS, log: () => undefined });
    onTestFinished(() => home.stop());
    let delivered = 0;
    const deliver = async (visits: readonly Visit[]) => {
      await shipFiles(root, CHROME, T0 + 24 * HOUR + ++delivered, { "history.sqlite": history(visits) }, { kind: "changes" });
      await until("Chrome's delivery imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(CHROME) as number) === delivered);
      await until("the home has read, rendered and indexed everything", () => searchIndexed(root));
    };

    await deliver([{ id: 1, at: T0, transition: LINK, tab: 41 }, { id: 2, at: T0 + 8 * HOUR, transition: SELF, from: 1, tab: 41 }]);
    expect(entries(root)).toEqual([1]);

    const repeat = readHome(root, (db) => db.prepare("SELECT version FROM heads WHERE source = ? AND kind = 'page-visit' AND key LIKE '2:%'").pluck().get(CHROME) as string);
    await deliver([{ id: 1, at: T0, transition: LINK }]);
    expect(readHome(root, (db) => db.prepare("SELECT version FROM heads WHERE source = ? AND kind = 'page-visit' AND key LIKE '2:%'").pluck().get(CHROME) as string)).toBe(repeat);
    expect(entries(root)).toEqual([1, 2]);
  });
});
