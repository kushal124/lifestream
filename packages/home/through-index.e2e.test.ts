import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Json, JobRow, JsonObject } from "@lifestreamprotocol/core";
import { declarations, type Acquirer } from "@lifestreamprotocol/connect";
import { index, pollKind, type Indexed } from "./import.js";
import type { HelperEnv, Main, Running } from "./jobs.js";
import { applyThrough, countedOf } from "./through.js";
import { artifact } from "./test/harness-root.js";
import {
  beginLook, COAST_SOURCE, custodyAt, heartbeatFacts, HOUR, look, MAC_SOURCE, mainOf, MINUTE, nudge, PASS_P, PHONE_OTHER, phonePass, PHONE_SOURCE, sealed,
  settled, ship, statement, throughHome, value, type ThroughHome,
} from "./test/through.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

type Coast = typeof import("../connect/screen/coast/test/fixture.js");
const { FakeCoast } = (await import(new URL("../connect/screen/coast/test/fixture.ts", import.meta.url).href)) as Coast;
const { coastAcquirer } = (await import(new URL("../connect/screen/coast/acquirer.ts", import.meta.url).href)) as typeof import("../connect/screen/coast/acquirer.js");

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const T1 = T0 + MINUTE;
const T2 = T0 + 2 * MINUTE;
const T3 = T0 + 3 * MINUTE;
const T4 = T0 + 4 * MINUTE;
const T5 = T0 + 5 * MINUTE;

describe("what the index states", () => {
  let home: ThroughHome | undefined;
  const seen: Record<string, unknown> = {};
  const open = (): ThroughHome => (home = throughHome("lifestream-through-index-", T0 + 10 * MINUTE));
  afterEach(() => {
    if (home === undefined) return;
    artifact(home.root, "through-index", seen);
    home.close();
    home = undefined;
  });
  const rowsOf = (h: ThroughHome, id: string): string[] => h.db.commit((tx) => tx.tables.deliveries.shipment(id).map((row) => row.source));

  it("feeds a phone shipment only to the sources it carries; a quiet source moves by its value, heard at its sealed_at; one sat out moves nothing", async () => {
    const h = open();
    const pass = phonePass(h);
    const first = ship(h, { pass, sealed_ms: T2, stated_ms: T1, carries: ["location"], sat_out: [PHONE_OTHER], custody: { [PHONE_SOURCE]: { seal: 1 } } });
    expect(nudge(h, first)).toBe(1);
    expect(rowsOf(h, first)).toEqual([PHONE_SOURCE]);
    expect([h.readThrough(PHONE_OTHER), h.kept(PHONE_OTHER)]).toEqual([null, { applied: null, left: null, heard_ms: null }]);
    const second = ship(h, { pass, sealed_ms: T4, stated_ms: T3, carries: ["location"], custody: { [PHONE_SOURCE]: { seal: 2 } }, received: { [PHONE_OTHER]: {} } });
    expect(nudge(h, second)).toBe(1);
    expect(rowsOf(h, second)).toEqual([PHONE_SOURCE]);
    expect(h.readThrough(PHONE_OTHER)).toBe(T3);
    expect(h.kept(PHONE_OTHER)).toEqual({ applied: { read_through_ms: T3, stated_ms: T3 }, left: null, heard_ms: T4 });
    const old = ship(h, { pass, sealed_ms: T5, carries: ["location"], custody: { [PHONE_SOURCE]: { seal: 3 } } });
    h.commit((tx) => {
      sealed(tx, { id: old, source: PHONE_SOURCE, sealed_ms: T5, pass, seal: 3 });
      sealed(tx, { id: old, source: PHONE_OTHER, sealed_ms: T5, pass });
    });
    const lines: Json[] = [];
    await look(h, lines);
    expect(rowsOf(h, old)).toEqual([PHONE_OTHER, PHONE_SOURCE].sort());
    seen.rows = { first: rowsOf(h, first), second: rowsOf(h, second), kept: h.kept(PHONE_OTHER), look: lines };
  });

  const ways = [
    { name: "by a nudge", passes: 1, look: false },
    { name: "from two passes of one unit", passes: 2, look: false },
    { name: "found by a look", passes: 1, look: true },
  ] as const;
  for (const way of ways) {
    it(`the phone's last statement (${way.name}): a shipment quiet for S, indexed before the one that carries S, applies once S's seal imports`, async () => {
      const h = open();
      const carrier = phonePass(h);
      const quiet = way.passes === 2 ? phonePass(h) : carrier;
      const b = ship(h, { pass: quiet, sealed_ms: T3, carries: ["health"], custody: { [PHONE_OTHER]: { seal: 1 } }, received: { [PHONE_SOURCE]: { [carrier]: 1 } } });
      if (way.look) await look(h);
      else nudge(h, b);
      expect(h.readThrough(PHONE_SOURCE)).toBeNull();
      expect(h.waiting(PHONE_SOURCE)).toMatchObject({ value: { read_through_ms: T3, stated_ms: T3 }, received: { [carrier]: 1 }, at_ms: T3 });
      const a = ship(h, { pass: carrier, sealed_ms: T1, carries: ["location"], custody: { [PHONE_SOURCE]: { seal: 1 } } });
      nudge(h, a);
      expect(h.readThrough(PHONE_SOURCE)).toBeNull();
      h.reopen();
      h.commit((tx) => settled(tx, a, PHONE_SOURCE, h.now));
      expect(h.readThrough(PHONE_SOURCE)).toBe(T3);
      expect(h.waiting(PHONE_SOURCE)).toBeUndefined();
      expect(h.kept(PHONE_SOURCE)).toMatchObject({ applied: { read_through_ms: T3, stated_ms: T3 }, heard_ms: T3 });
      seen[`last-${way.name}`] = h.kept(PHONE_SOURCE);
    });
  }

  it("a shipment sealed without `received` in its stamp (a replaced pass's, or before the stamp) states no value, by a nudge or a look", async () => {
    const h = open();
    const pass = phonePass(h);
    nudge(h, ship(h, { pass, sealed_ms: T1, carries: ["health"], custody: { [PHONE_OTHER]: { seal: 1 } } }));
    ship(h, { pass, sealed_ms: T2, carries: ["health"], custody: { [PHONE_OTHER]: { seal: 2 } } });
    await look(h);
    expect([h.readThrough(PHONE_SOURCE), h.kept(PHONE_SOURCE), h.waiting(PHONE_SOURCE)]).toEqual([null, { applied: null, left: null, heard_ms: null }, undefined]);
  });

  it("states a delivery's `left` as its row is added, by statement time over seal time, and never again on a re-read", () => {
    const h = open();
    const main = mainOf(h);
    const delivery = (id: string, at: { sealed_ms: number; stated_ms: number }, facts: JsonObject): Indexed => ({
      id, ...at, facts, sources: [MAC_SOURCE], feeder: "mac", fetched_at: new Date(at.sealed_ms).toISOString(), pass: PASS_P, custody: {}, received: {}, bytes: 0,
    });
    const newer = delivery("lane-mac/d3", { sealed_ms: T3, stated_ms: T3 }, heartbeatFacts(T3, T2, { left: 0, start_ms: null }));
    const older = delivery("lane-mac/d1", { sealed_ms: T4, stated_ms: T1 }, { left: 100, start_ms: null, history: true });
    h.commit((tx) => index(main, tx, newer));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T3, from: "delivery" });
    h.commit((tx) => index(main, tx, older));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2, T2, { left: 50, start_ms: null })), h.now));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T3, from: "delivery" });
    expect(h.commit((tx) => index(main, tx, older))).toBe(0);
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T3, from: "delivery" });
    h.commit((tx) => index(main, tx, { ...delivery("lane-mac/d5", { sealed_ms: T5, stated_ms: T5 }, { left: 7 }), pass: null }));
    expect(h.kept(MAC_SOURCE).left?.stated_ms).toBe(T3);
    seen.left = h.kept(MAC_SOURCE);
  });

  it("keeps a page's months as its source's count when its row is added, the later count over the earlier, and nothing from a page whose months are no count or that is no page", () => {
    const h = open();
    const main = mainOf(h);
    const page = (id: string, stated_ms: number, facts: JsonObject): Indexed => ({
      id, sealed_ms: stated_ms, stated_ms, facts: { history: true, left: 3, start_ms: null, ...facts }, sources: [COAST_SOURCE], feeder: "coast", fetched_at: new Date(stated_ms).toISOString(), pass: null, custody: {}, received: {}, bytes: 0,
    });
    const counted = () => h.commit((tx) => countedOf(tx.tables.meta, COAST_SOURCE));
    h.commit((tx) => index(main, tx, page("lane-coast/p1", T1, {})));
    expect(counted()).toBeUndefined();
    h.commit((tx) => index(main, tx, page("lane-coast/p3", T3, { months: { "2026-11": [4, 4000], "2025-02": [1, 100], undated: [2, 0] } })));
    expect(counted()).toEqual({ months: { "2026-11": [4, 4000], "2025-02": [1, 100], undated: [2, 0] }, counted_ms: T3 });
    h.commit((tx) => index(main, tx, page("lane-coast/p2", T2, { months: { "2026-11": [9, 9000] } })));
    h.commit((tx) => index(main, tx, page("lane-coast/p4", T4, { months: { "2026-13": [1, 1] } })));
    h.commit((tx) => index(main, tx, page("lane-coast/p5", T5, { months: { "2026-11": [9, 9000] }, start_ms: "all" })));
    expect(counted()?.counted_ms).toBe(T3);
    seen.months = counted();
  });

  it("keeps a device delivery's months as its source's count, a live bundle's as a history one's, through the same writer as a page's", () => {
    const h = open();
    const main = mainOf(h);
    const delivery = (id: string, stated_ms: number, facts: JsonObject): Indexed => ({
      id, sealed_ms: stated_ms, stated_ms, facts, sources: [MAC_SOURCE], feeder: "mac", fetched_at: new Date(stated_ms).toISOString(), pass: PASS_P, custody: {}, received: {}, bytes: 0,
    });
    const counted = () => h.commit((tx) => countedOf(tx.tables.meta, MAC_SOURCE));
    h.commit((tx) => index(main, tx, delivery("lane-mac/m1", T1, heartbeatFacts(T1, T0, { left: 2, start_ms: null }))));
    expect(counted()).toBeUndefined();
    h.commit((tx) => index(main, tx, delivery("lane-mac/m2", T2, { history: true, left: 2, start_ms: null, months: { "2026-11": [5, 0], "2026-01": [3, 0] } })));
    expect(counted()).toEqual({ months: { "2026-11": [5, 0], "2026-01": [3, 0] }, counted_ms: T2 });
    h.commit((tx) => index(main, tx, delivery("lane-mac/m4", T4, { ...heartbeatFacts(T4, T3), months: { "2026-11": [6, 0], "2026-01": [3, 0] } })));
    h.commit((tx) => index(main, tx, delivery("lane-mac/m3", T3, { history: true, left: 1, start_ms: null, months: { "2026-11": [9, 0] } })));
    h.commit((tx) => index(main, tx, delivery("lane-mac/m5", T5, { history: true, left: 0, start_ms: null, months: { "2026-11": [-1, 0] } })));
    expect(counted()).toEqual({ months: { "2026-11": [6, 0], "2026-01": [3, 0] }, counted_ms: T4 });
    seen.device_months = counted();
  });

  it("Coast's fetch of nothing seals no delivery and states its read-through at the poll's last commit", async () => {
    const h = open();
    const live = join(h.root, "coast", "rem.db");
    const store = new FakeCoast(live, "id", { wal: true });
    try {
      const at = T0 + HOUR;
      const acquirer = coastAcquirer({ unit: "macbook-pro-0001", database: live, videos: join(h.root, "coast", "videos"), settle_ms: MINUTE, work: join(h.root, "coast-work"), clock: () => at });
      const main = { ...mainOf(h), registry: { ...mainOf(h).registry, connectors: declarations(), readers: [{ name: "coast" }], acquirers: [acquirer] } } as unknown as Main;
      const env = { folder: openHomeFolder(h.root), registry: main.registry, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door: "http://127.0.0.1:9", pass: "none" }, signal: new AbortController().signal } as unknown as HelperEnv;
      const fetched_at = new Date(at).toISOString();
      const helper = pollKind.helper(env, { job: 0, kind: "poll", key: acquirer.name, lane: 1, now_ms: at, data: { acquirer: acquirer.name, cursor: null, fetched_at, accounts: {}, call: "fetch", start_ms: null, from_ms: undefined } });
      const result = await helper.next();
      expect(result.done).toBe(true);
      const ran = result.value as Parameters<typeof pollKind.done>[3];
      expect(ran.delivery).toBeNull();
      const running = { job: { key: acquirer.name } as JobRow, state: { call: "fetch", queued: [], fetched_at, source: COAST_SOURCE, resets: null } } as Running<Parameters<typeof pollKind.done>[2]["state"]>;
      h.now = at;
      h.commit((tx) => pollKind.done(main, tx, running, ran));
      expect(h.readThrough(COAST_SOURCE)).toBe(at - MINUTE);
      expect(h.kept(COAST_SOURCE)).toEqual({ applied: { read_through_ms: at - MINUTE, stated_ms: at }, left: null, heard_ms: at });
      expect(h.db.commit((tx) => tx.tables.deliveries.list().length)).toBe(0);
      seen.coast = { through: ran.through ?? null, kept: h.kept(COAST_SOURCE) };
    } finally {
      store.close();
    }
  });

  it("a poll that seals refuses facts that state a read-through, which would read as carrying nothing and pass it unread", async () => {
    const h = open();
    const read_through = new Date(T1).toISOString();
    const stating: Acquirer = {
      name: "fake-stating", source: COAST_SOURCE,
      fetch: async () => ({ files: [{ path: "frames.bin", bytes: Buffer.from("synthetic frames") }], facts: { read_through }, state: {} }),
      page: async () => ({ files: [], facts: { read_through }, state: {}, left: 0 }),
    };
    const main = { ...mainOf(h), registry: { ...mainOf(h).registry, acquirers: [stating] } } as unknown as Main;
    const env = { folder: openHomeFolder(h.root), registry: main.registry, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door: "http://127.0.0.1:9", pass: "none" }, signal: new AbortController().signal } as unknown as HelperEnv;
    for (const call of ["fetch", "page"] as const) {
      const helper = pollKind.helper(env, { job: 0, kind: "poll", key: stating.name, lane: 1, now_ms: T2, data: { acquirer: stating.name, cursor: null, fetched_at: new Date(T2).toISOString(), accounts: {}, call, start_ms: null, from_ms: undefined } });
      await expect(helper.next(), call).rejects.toThrow("acquirer fake-stating's facts state read_through beside what it seals");
    }
    expect(h.db.commit((tx) => tx.tables.deliveries.list().length)).toBe(0);
  });
});

describe("a lost seal, as the whole inbox look finds it", () => {
  let home: ThroughHome | undefined;
  const seen: Record<string, unknown> = {};
  const open = (): ThroughHome => (home = throughHome("lifestream-through-lost-", T0 + 10 * MINUTE));
  afterEach(() => {
    if (home === undefined) return;
    artifact(home.root, "through-lost", seen);
    home.close();
    home = undefined;
  });
  const lost = (lines: Json[]) => lines.filter((line) => (line as JsonObject).through === "seal lost");

  it("is marked and logged once by a look that covered it from its start an hour in; a later value on the same gap keeps the mark; put back, the value applies", async () => {
    const h = open();
    h.commit((tx) => custodyAt(tx, PASS_P, MAC_SOURCE, 1, T0));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 2 }, h.now), h.now));
    const since = h.now;
    const lines: Json[] = [];
    await look(h, lines);
    expect([lost(lines), h.waiting(MAC_SOURCE)?.lost]).toEqual([[], undefined]);
    h.now = since + HOUR;
    const running = beginLook(h, lines);
    expect([lost(lines), h.waiting(MAC_SOURCE)?.lost]).toEqual([[], undefined]);
    await running.end();
    expect(lost(lines)).toEqual([{ through: "seal lost", pass: PASS_P, seal: 2 }]);
    expect(h.waiting(MAC_SOURCE)).toMatchObject({ since_ms: since, lost: { pass: PASS_P, seal: 2, at_ms: since + HOUR } });
    await look(h, lines);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3), { [PASS_P]: 2 }, h.now), h.now));
    expect(lost(lines)).toHaveLength(1);
    expect(h.waiting(MAC_SOURCE)).toMatchObject({ value: { read_through_ms: T3 }, since_ms: since, lost: { pass: PASS_P, seal: 2 } });
    expect(h.readThrough(MAC_SOURCE)).toBeNull();
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-2", source: MAC_SOURCE, sealed_ms: T1, pass: PASS_P, seal: 2 }));
    h.commit((tx) => settled(tx, "lane-mac/seal-2", MAC_SOURCE, h.now));
    expect([h.readThrough(MAC_SOURCE), h.waiting(MAC_SOURCE)]).toEqual([T3, undefined]);
    seen.lost = lines;
  });

  it("a seal the door took during the look is not lost; a look begun after it was owed marks it", async () => {
    const h = open();
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 1 }, h.now), h.now));
    const since = h.now;
    h.now += 2 * HOUR;
    const lines: Json[] = [];
    const running = beginLook(h, lines);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 2 }, h.now), h.now));
    h.commit((tx) => settled(tx, "lane-mac/seal-1", MAC_SOURCE, h.now));
    await running.end();
    expect([lost(lines), h.waiting(MAC_SOURCE)?.lost, h.waiting(MAC_SOURCE)?.since_ms]).toEqual([[], undefined, since]);
    await look(h, lines);
    expect(lost(lines)).toEqual([{ through: "seal lost", pass: PASS_P, seal: 2 }]);
  });

  it("a mark does not move to a new gap: seal 1 put back while a newer value waits on seal 2, which no line names until a look covers it", async () => {
    const h = open();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 1 }, h.now), h.now));
    h.now += HOUR;
    const lines: Json[] = [];
    await look(h, lines);
    expect(h.waiting(MAC_SOURCE)?.lost).toMatchObject({ pass: PASS_P, seal: 1 });
    const running = beginLook(h, lines);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 2 }, h.now), h.now));
    h.commit((tx) => sealed(tx, { id: "lane-mac/seal-1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    h.commit((tx) => settled(tx, "lane-mac/seal-1", MAC_SOURCE, h.now));
    await running.end();
    expect(lost(lines).map((line) => (line as JsonObject).seal)).toEqual([1]);
    await look(h, lines);
    expect(lost(lines).map((line) => (line as JsonObject).seal)).toEqual([1, 2]);
    expect(h.waiting(MAC_SOURCE)?.lost).toMatchObject({ pass: PASS_P, seal: 2 });
  });

  it("a waiting value whose next seal has a row not yet imported (an import's file, behind another source) is never marked", async () => {
    const h = open();
    h.commit((tx) => {
      sealed(tx, { id: "lane-mac/import", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1, facts: { import: { kind: "google-takeout" } } });
      sealed(tx, { id: "lane-mac/import", source: PHONE_OTHER, sealed_ms: T0, facts: { import: { kind: "google-takeout" } } });
    });
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 1 }, h.now), h.now));
    const lines: Json[] = [];
    for (let hours = 1; hours <= 3; hours++) {
      h.now += HOUR;
      await look(h, lines);
    }
    expect([lost(lines), h.waiting(MAC_SOURCE)?.lost]).toEqual([[], undefined]);
  });
});
