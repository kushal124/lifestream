import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { declarations, type Acquirer, type Connector } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { latest, record, targetOf } from "./attempts.js";
import { chromeCame, heardNeed, nextTurn, pageTurns, siteNeed, siteNeedsMet } from "./import.js";
import { connectorSettings } from "./settings.js";
import { RETRY_MS } from "./status.js";
import { stateMonths } from "./through.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const LANE = "claude-browser";
const connectors = declarations();
const main = { room: "ok" as const, stated: {}, registry: { connectors }, settings: { history: { start: "all" }, connectors: {}, sources: { off: [] } } };
const home = main as unknown as Parameters<typeof nextTurn>[0];
const noPage: Acquirer["page"] = async () => {
  throw new Error("no page is called here");
};
const claude = connectors.find((each) => each.id === "claude")!;
const { refresh_ms } = connectorSettings(claude, undefined);

describe("a site's need the home hears end holds its clocks", () => {
  let root: string;
  let db: HomeDb;

  beforeAll(() => {
    root = makeRoot("lifestream-heard-needs-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
  });

  afterAll(() => {
    db.close();
    removeRoot(root);
  });

  const pageDue = (fetch: { outcome: "ok" | "need"; reason: string | null; facts?: Record<string, string> }, page: typeof fetch | null): boolean => {
    db.commit((tx) => {
      for (const [call, end] of [["fetch", fetch], ["page", page]] as const) {
        tx.tables.attempts.delete(targetOf(call, LANE), "");
        if (end !== null) record(tx, targetOf(call, LANE), [], { ...end, reason: end.reason as never, facts: end.facts ?? {}, answered: true }, NOW - 60_000 + (call === "page" ? 1 : 0));
      }
      tx.tables.polls.put({ acquirer: LANE, next_ms: NOW + 3_600_000, paged_ms: NOW - 10 * 60_000 });
    });
    const view = db.view();
    try {
      return pageTurns(main, view.tables, NOW)({ name: LANE, source: "claude:<account>:browser", page: noPage }).due;
    } finally {
      view.close();
    }
  };

  it("tells the needs the home hears end, on a site's lane alone, and those a read shows gone", () => {
    const need = (reason: string, facts: Record<string, string> = {}) => ({ outcome: "need", reason, facts });
    const withheld = need("extension", { code: "SITE_NOT_ALLOWED" });
    expect([heardNeed(connectors, LANE, need("signed-out")), heardNeed(connectors, LANE, need("password"))]).toEqual([true, true]);
    expect([siteNeed(connectors, LANE, withheld), heardNeed(connectors, LANE, withheld)]).toEqual([true, false]);
    expect([
      heardNeed(connectors, LANE, need("confirm")), heardNeed(connectors, LANE, { outcome: "fail", reason: "signed-out", facts: {} }),
      heardNeed(connectors, "gmail-api", need("signed-out")), heardNeed(connectors, LANE, undefined),
    ]).toEqual([false, false, false, false]);
  });

  it("turns a fetch that stands on one at the refresh, never the retry", () => {
    expect(refresh_ms! > RETRY_MS).toBe(true);
    expect(nextTurn(home, LANE, NOW, {}, false, true)).toBe(NOW + refresh_ms!);
    expect(nextTurn(home, LANE, NOW, {}, false)).toBe(NOW + RETRY_MS);
    expect(nextTurn(home, LANE, NOW, { next_ms: NOW + 2 * refresh_ms! }, false, true)).toBe(NOW + 2 * refresh_ms!);
    expect(nextTurn(home, LANE, NOW, {}, true, false)).toBe(NOW + refresh_ms!);
  });

  it("holds the lane's page while one stands on either call, and pages again once the lane reads", () => {
    expect(pageDue({ outcome: "need", reason: "signed-out" }, null)).toBe(false);
    expect(pageDue({ outcome: "ok", reason: null }, { outcome: "need", reason: "password" })).toBe(false);
    expect(pageDue({ outcome: "need", reason: "confirm" }, { outcome: "need", reason: "confirm" })).toBe(true);
    expect(pageDue({ outcome: "ok", reason: null }, { outcome: "need", reason: "extension", facts: { code: "SITE_NOT_ALLOWED" } })).toBe(true);
    expect(pageDue({ outcome: "ok", reason: null }, null)).toBe(true);
  });

  it("ends the lane's site needs on both calls once a call reads, its own copy's page too, and leaves the rows it wrote", () => {
    const COPY = "claude:<account>:browser";
    db.commit((tx) => {
      for (const call of ["fetch", "page"] as const) tx.tables.attempts.delete(targetOf(call, LANE), COPY);
      record(tx, targetOf("page", LANE), [COPY], { outcome: "need", reason: "signed-out", facts: {}, answered: true }, NOW - 60_000);
      record(tx, targetOf("fetch", LANE), [COPY], { outcome: "ok", reason: null, facts: {}, answered: true }, NOW);
      siteNeedsMet(tx, connectors, LANE, targetOf("fetch", LANE), [COPY], NOW);
    });
    const view = db.view();
    try {
      expect([latest(view.tables, targetOf("page", LANE))?.outcome, latest(view.tables, targetOf("fetch", LANE))?.outcome]).toEqual([undefined, "ok"]);
    } finally {
      view.close();
    }
  });

  it("asks for every lane of a site Chrome just granted that it refused, one queued and its sibling's fetch kept, and no other", () => {
    const LATER = NOW + 3_600_000;
    let round = 0;
    const refusedWith = (code: string, granted: string[], chosen = ["shop"]) => {
      round += 1;
      const lanes = [`shop-orders-${round}`, `shop-lists-${round}`];
      const site = lanes.map((lane, index) => ({
        ...claude, id: index === 0 ? "shop" : `shop-${round}`, acquirers: [lane],
        sources: [{ id: `shop${index}:<account>:browser`, read: claude.sources[0]!.read, arrives: "chrome" }], chrome: { origin: "https://shop.example", probe: null },
      }) as Connector);
      db.commit((tx) => {
        for (const lane of lanes) {
          record(tx, targetOf("fetch", lane), [], { outcome: "need", reason: "extension", facts: { code }, answered: false }, NOW - 60_000);
          tx.tables.polls.put({ acquirer: lane, next_ms: LATER });
        }
        chromeCame(tx, site, chosen, new Set(granted), NOW, new Set());
      });
      const view = db.view();
      try {
        return lanes.map((lane) => [view.tables.jobs.get("poll", lane)?.state ?? null, view.tables.meta.get(`poll-queued:${lane}`) ?? null]);
      } finally {
        view.close();
      }
    };
    expect(refusedWith("SITE_NOT_ALLOWED", ["shop"])).toEqual([["queued", '["fetch"]'], [null, '["fetch"]']]);
    expect(refusedWith("SITE_NOT_ALLOWED", ["chatgpt"])).toEqual([[null, null], [null, null]]);
    expect(refusedWith("SITE_NOT_ALLOWED", ["shop"], [])).toEqual([[null, null], [null, null]]);
  });
});

describe("a history page is due while its walk stands under another start", () => {
  let root: string;
  let db: HomeDb;
  const COPY = "claude:person-a@example.com:browser";
  const MAY = Date.UTC(2026, 4, 19);

  beforeAll(() => {
    root = makeRoot("lifestream-page-start-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: COPY, vendor: "anthropic", connector: "claude-browser", options: { lane: LANE }, added_ms: 0 });
      record(tx, targetOf("fetch", LANE), [], { outcome: "ok", reason: null, facts: {}, answered: true }, NOW - 60_000);
      tx.tables.polls.put({ acquirer: LANE, next_ms: NOW + 3_600_000, paged_ms: NOW - 10 * 60_000 });
    });
  });

  afterAll(() => {
    db.close();
    removeRoot(root);
  });

  const due = (walk: { left: number; start_ms: number | null }, start: string, own: Record<string, string> = {}, months?: true): boolean => {
    db.commit((tx) => tx.tables.backfills.paged({ source: COPY, acquirer: LANE, left: walk.left, unit: null, start_ms: walk.start_ms, at_ms: NOW - 10 * 60_000, delivery: `${COPY}/page` }));
    const view = db.view();
    try {
      const settings = { history: { start }, connectors: { claude: own }, sources: { off: [] } };
      return pageTurns({ ...main, settings }, view.tables, NOW)({ name: LANE, source: LANE, page: noPage, ...months === undefined ? {} : { months } }).due;
    } finally {
      view.close();
    }
  };

  it("is done once left is 0 under the start that runs, and due again when the start moves either way", () => {
    expect(due({ left: 0, start_ms: null }, "all")).toBe(false);
    expect(due({ left: 0, start_ms: null }, "2026-05-19")).toBe(true);
    expect(due({ left: 0, start_ms: MAY }, "2026-05-19")).toBe(false);
    expect(due({ left: 4, start_ms: MAY }, "2026-05-19")).toBe(true);
    expect(due({ left: 0, start_ms: MAY }, "2026-09-01")).toBe(true);
    expect(due({ left: 0, start_ms: MAY }, "all")).toBe(true);
  });

  it("follows the stream's own start over the home's, and the home's again once the own one is gone", () => {
    expect(due({ left: 0, start_ms: MAY }, "all", { start: "2026-05-19" })).toBe(false);
    expect(due({ left: 0, start_ms: MAY }, "2026-05-19", { start: "2019-01-01" })).toBe(true);
    expect(due({ left: 0, start_ms: Date.UTC(2019, 0, 1) }, "2026-05-19", { start: "2019-01-01" })).toBe(false);
    expect(due({ left: 0, start_ms: Date.UTC(2019, 0, 1) }, "2026-05-19")).toBe(true);
  });

  it("is due once more, its walk ended, for an acquirer that counts while its source holds no count, and done once one is kept", () => {
    expect(due({ left: 0, start_ms: MAY }, "2026-05-19", {}, true)).toBe(true);
    db.commit((tx) => stateMonths(tx, COPY, { months: { "2026-10": [3, 0] }, counted_ms: NOW - 60_000 }));
    expect(due({ left: 0, start_ms: MAY }, "2026-05-19", {}, true)).toBe(false);
    expect(due({ left: 4, start_ms: MAY }, "2026-05-19", {}, true)).toBe(true);
  });
});
