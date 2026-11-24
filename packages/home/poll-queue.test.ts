import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declarations, type Acquirer, type Connector } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { BY_HAND, pollsDue, queuePoll, type Call } from "./import.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const LATER = NOW + 3_600_000;
const claude = declarations().find((each) => each.id === "claude")!;
const site = ["orders", "lists"].map((id, index) => ({
  ...claude, id: `shop-${id}`, acquirers: [`shop-${id}`],
  sources: [{ id: `shop${index}:<account>:browser`, read: claude.sources[0]!.read, arrives: "chrome" }], chrome: { origin: "https://shop.example", probe: null },
}) as Connector);
const [ORDERS, LISTS] = ["shop-orders", "shop-lists"] as const;
const acquirers = [ORDERS, LISTS].map((name, index) => ({ name, source: `shop${index}:<account>:browser` }) as Acquirer);
const main = { room: "ok" as const, stated: {}, registry: { connectors: site, acquirers }, settings: { history: { start: "all" }, connectors: {}, sources: { off: [] } } };

describe("a poll asked for while its site is busy is read after it, never dropped", () => {
  let root: string;
  let db: HomeDb;

  beforeAll(() => {
    root = makeRoot("lifestream-poll-queue-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
  });

  afterAll(() => {
    db.close();
    removeRoot(root);
  });

  const read = <T>(of: (tables: ReturnType<HomeDb["view"]>["tables"]) => T): T => {
    const view = db.view();
    try {
      return of(view.tables);
    } finally {
      view.close();
    }
  };
  const state = (lane: string) => read((tables) => tables.jobs.get("poll", lane)?.state ?? null);
  const due = (now: number) => read((tables) => pollsDue(main, tables, now));

  const kinds: readonly (readonly Call[])[] = [["fetch"], BY_HAND, ["page"]];
  for (const calls of kinds) {
    it(`keeps a request for ${calls.join(" and ")} while the sibling runs, and the tick reads it first once the sibling is done`, () => {
      db.commit((tx) => {
        for (const lane of [ORDERS, LISTS]) {
          const job = tx.tables.jobs.get("poll", lane);
          if (job !== undefined) tx.tables.jobs.delete(job.id);
          tx.tables.meta.delete(`poll-queued:${lane}`);
          tx.tables.polls.put({ acquirer: lane, next_ms: LATER, paged_ms: NOW });
        }
        queuePoll(tx, site, ORDERS, NOW, new Set(), ["fetch"]);
        tx.tables.jobs.take(NOW);
        tx.tables.meta.delete(`poll-queued:${ORDERS}`);
        queuePoll(tx, site, LISTS, NOW, new Set(), calls);
      });
      expect([state(ORDERS), state(LISTS)]).toEqual(["running", null]);
      expect(read((tables) => tables.polls.get(LISTS))).toMatchObject({ next_ms: LATER, paged_ms: NOW });
      const running = due(NOW + 1);
      expect(running.map(({ name }) => name)).toEqual([LISTS]);
      db.commit((tx) => {
        for (const { name, calls: asked } of running) queuePoll(tx, site, name, NOW + 1, new Set(), asked);
      });
      expect([state(ORDERS), state(LISTS)]).toEqual(["running", null]);
      db.commit((tx) => {
        tx.tables.jobs.finish(tx.tables.jobs.get("poll", ORDERS)!.id, NOW + 2);
        tx.tables.polls.put({ acquirer: ORDERS, next_ms: NOW + 2, paged_ms: NOW });
      });
      const next = due(LATER - 1).sort((a, b) => a.due_ms - b.due_ms);
      expect(next.map(({ name, calls: asked }) => [name, asked])).toEqual([[LISTS, [...calls]], [ORDERS, ["fetch"]]]);
      db.commit((tx) => {
        for (const { name, calls: asked } of next) queuePoll(tx, site, name, LATER - 1, new Set(), asked);
      });
      expect([state(ORDERS), state(LISTS)]).toEqual(["done", "queued"]);
    });
  }

  it("queues a lane whose site is free at once, and beside a paused sibling, which runs nothing", () => {
    db.commit((tx) => {
      for (const lane of [ORDERS, LISTS]) {
        const job = tx.tables.jobs.get("poll", lane);
        if (job !== undefined) tx.tables.jobs.delete(job.id);
      }
      queuePoll(tx, site, LISTS, NOW, new Set(), ["fetch"]);
    });
    expect([state(ORDERS), state(LISTS)]).toEqual([null, "queued"]);
    db.commit((tx) => queuePoll(tx, site, ORDERS, NOW, new Set([`poll:${LISTS}`]), ["fetch"]));
    expect([state(ORDERS), state(LISTS)]).toEqual(["queued", "queued"]);
  });
});
