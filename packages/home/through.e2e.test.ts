import { afterEach, describe, expect, it } from "vitest";
import { applyThrough, countedOf, gapOf, hear, markLost, monthsIn, stateLeft } from "./through.js";
import { artifact } from "./test/harness-root.js";
import {
  custodyAt, MAC_SOURCE, MINUTE, PASS_P, PASS_Q, phoneFacts, PHONE_OTHER, PHONE_SOURCE, sealed, settled, statement, throughHome, value,
  type ThroughHome,
} from "./test/through.js";

const T0 = Date.UTC(2026, 10, 13, 9, 0, 0);
const T1 = T0 + MINUTE;
const T2 = T0 + 2 * MINUTE;
const T3 = T0 + 3 * MINUTE;
const T5 = T0 + 5 * MINUTE;

describe("a stated read-through", () => {
  let home: ThroughHome | undefined;
  const seen: Record<string, unknown> = {};
  const open = (): ThroughHome => (home = throughHome("lifestream-through-", T0 + 10 * MINUTE));
  afterEach(() => {
    if (home === undefined) return;
    artifact(home.root, "through", seen);
    home.close();
    home = undefined;
  });

  it("applies a value only once nothing of its source waits, and the import's last commit applies it with no second statement", () => {
    const h = open();
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1, facts: {} }));
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }), h.now))).toBe("kept");
    expect(h.readThrough(MAC_SOURCE)).toBeNull();
    expect(h.waiting(MAC_SOURCE)).toMatchObject({ value: { read_through_ms: T2 }, received: { [PASS_P]: 1 }, since_ms: h.now });
    h.commit((tx) => settled(tx, "lane-mac/d1", MAC_SOURCE, h.now, T1));
    expect(h.readThrough(MAC_SOURCE)).toBe(T2);
    expect(h.waiting(MAC_SOURCE)).toBeUndefined();
    expect(h.kept(MAC_SOURCE)).toEqual({ applied: { read_through_ms: T2, stated_ms: T2 }, left: null, heard_ms: T2 });
  });

  it("holds a value back on a seal the door gave out and the home holds no row of, until it is indexed and imported", () => {
    const h = open();
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }), h.now))).toBe("kept");
    h.reopen();
    expect(h.readThrough(MAC_SOURCE)).toBeNull();
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    expect(h.readThrough(MAC_SOURCE)).toBeNull();
    h.commit((tx) => settled(tx, "lane-mac/d1", MAC_SOURCE, h.now));
    expect(h.readThrough(MAC_SOURCE)).toBe(T2);
  });

  for (const passes of [{ a: PASS_P, b: PASS_P }, { a: PASS_P, b: PASS_Q }]) {
    it(`finishes the phone's last statement, indexed before the shipment that carries its source (shipments of ${passes.a === passes.b ? "one pass" : "two passes of one unit"})`, () => {
      const h = open();
      h.commit((tx) => sealed(tx, { id: `lane-${passes.b}/b`, source: PHONE_OTHER, sealed_ms: T3, pass: passes.b, seal: 1, facts: phoneFacts(T3, ["health"]) }));
      expect(h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(T3), { [passes.a]: 1 }, T3), h.now))).toBe("kept");
      expect(h.readThrough(PHONE_SOURCE)).toBeNull();
      h.commit((tx) => sealed(tx, { id: `lane-${passes.a}/a`, source: PHONE_SOURCE, sealed_ms: T1, pass: passes.a, seal: 1, facts: phoneFacts(T1, ["location"]) }));
      h.reopen();
      h.commit((tx) => settled(tx, `lane-${passes.a}/a`, PHONE_SOURCE, h.now, T1));
      expect(h.readThrough(PHONE_SOURCE)).toBe(T3);
      expect(h.waiting(PHONE_SOURCE)).toBeUndefined();
      expect(h.kept(PHONE_SOURCE).heard_ms).toBe(T3);
    });
  }

  it("keeps one value held back, the newer by statement, with the first one's `since_ms`; applying it leaves none waiting", () => {
    const h = open();
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    const since = h.now;
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 1 }), h.now))).toBe("kept");
    h.now += MINUTE;
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3), { [PASS_P]: 1 }), h.now))).toBe("kept");
    h.now += MINUTE;
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }), h.now))).toBe("old");
    expect(h.waiting(MAC_SOURCE)).toEqual({ value: value(T3), received: { [PASS_P]: 1 }, at_ms: T3, since_ms: since });
    h.commit((tx) => settled(tx, "lane-mac/d1", MAC_SOURCE, h.now));
    expect({ read: h.readThrough(MAC_SOURCE), waiting: h.waiting(MAC_SOURCE) }).toEqual({ read: T3, waiting: undefined });
  });

  it("applies an older value under a newer one that still waits, and finishes the newer one when its own seal settles", () => {
    const h = open();
    expect(h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(T3), { [PASS_P]: 2 }), h.now))).toBe("kept");
    const since = h.now;
    h.now += MINUTE;
    h.commit((tx) => custodyAt(tx, PASS_P, PHONE_SOURCE, 1, h.now));
    expect(h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(T1), { [PASS_P]: 1 }), h.now))).toBe("applied");
    expect(h.readThrough(PHONE_SOURCE)).toBe(T1);
    expect(h.waiting(PHONE_SOURCE)).toEqual({ value: value(T3), received: { [PASS_P]: 2 }, at_ms: T3, since_ms: since });
    h.reopen();
    h.commit((tx) => {
      sealed(tx, { id: "lane-p/s2", source: PHONE_SOURCE, sealed_ms: T2, pass: PASS_P, seal: 2 });
      settled(tx, "lane-p/s2", PHONE_SOURCE, h.now);
    });
    expect({ read: h.readThrough(PHONE_SOURCE), waiting: h.waiting(PHONE_SOURCE) }).toEqual({ read: T3, waiting: undefined });
  });

  it("removes the waiting value when one stated at its instant or later applies", () => {
    const h = open();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }), h.now));
    h.commit((tx) => custodyAt(tx, PASS_P, MAC_SOURCE, 1, h.now));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3), { [PASS_P]: 2 }), h.now));
    expect(h.waiting(MAC_SOURCE)?.value.stated_ms).toBe(T3);
    h.commit((tx) => {
      sealed(tx, { id: "lane-p/s2", source: MAC_SOURCE, sealed_ms: T3, pass: PASS_P, seal: 2 });
      settled(tx, "lane-p/s2", MAC_SOURCE, h.now);
    });
    expect(h.waiting(MAC_SOURCE)).toBeUndefined();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T5), { [PASS_P]: 3 }), h.now));
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T5), { [PASS_P]: 2 }), h.now))).toBe("applied");
    expect({ read: h.readThrough(MAC_SOURCE), waiting: h.waiting(MAC_SOURCE) }).toEqual({ read: T5, waiting: undefined });
  });

  it("moves nothing back: a waiting value older than a delivery that lands after it is gone, and a value older than the read-through moves nothing", () => {
    const h = open();
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 1 }), h.now));
    h.commit((tx) => settled(tx, "lane-mac/d1", MAC_SOURCE, h.now, T5));
    expect({ read: h.readThrough(MAC_SOURCE), waiting: h.waiting(MAC_SOURCE) }).toEqual({ read: T5, waiting: undefined });
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2, T5 + MINUTE)), h.now))).toBe("applied");
    expect(h.readThrough(MAC_SOURCE)).toBe(T5);
  });

  it("takes the same statement twice, across a restart, as it took it once: applied and waiting", () => {
    const h = open();
    const applied = statement(value(T1), {}, T1);
    const held = statement(value(T2, T3), { [PASS_P]: 1 }, T3);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, applied, h.now));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, held, h.now));
    const first = { kept: h.kept(MAC_SOURCE), waiting: h.waiting(MAC_SOURCE) };
    h.reopen();
    h.now += 10 * MINUTE;
    const again = h.commit((tx) => [applyThrough(tx, MAC_SOURCE, applied, h.now), applyThrough(tx, MAC_SOURCE, held, h.now)]);
    expect(again).toEqual(["old", "old"]);
    expect({ kept: h.kept(MAC_SOURCE), waiting: h.waiting(MAC_SOURCE) }).toEqual(first);
    seen.twice = first;
  });

  it("ends two values taken out of order as one taking in order: T2 stands", () => {
    const h = open();
    expect(h.commit((tx) => [applyThrough(tx, MAC_SOURCE, statement(value(T2)), h.now), applyThrough(tx, MAC_SOURCE, statement(value(T1)), h.now)]))
      .toEqual(["applied", "old"]);
    expect(h.kept(MAC_SOURCE).applied).toEqual({ read_through_ms: T2, stated_ms: T2 });
    expect(h.readThrough(MAC_SOURCE)).toBe(T2);
  });

  it("never moves `heard_ms` back, whoever raises it", () => {
    const h = open();
    h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(T2), {}, T5), h.now));
    h.commit((tx) => applyThrough(tx, PHONE_SOURCE, statement(value(T3), {}, T3), h.now));
    expect(h.kept(PHONE_SOURCE).heard_ms).toBe(T5);
    expect(h.commit((tx) => [hear(tx, PHONE_SOURCE, T1), hear(tx, PHONE_SOURCE, T5 + MINUTE)])).toEqual([false, true]);
    expect(h.kept(PHONE_SOURCE)).toEqual({ applied: { read_through_ms: T3, stated_ms: T3 }, left: null, heard_ms: T5 + MINUTE });
  });

  it("raises `heard_ms` for a value held back as for one applied, and moves no read-through; the same value again raises nothing", () => {
    const h = open();
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }, T3), h.now))).toBe("kept");
    expect([h.readThrough(MAC_SOURCE), h.kept(MAC_SOURCE)]).toEqual([null, { applied: null, left: null, heard_ms: T3 }]);
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 1 }, T5), h.now))).toBe("old");
    expect(h.kept(MAC_SOURCE).heard_ms).toBe(T3);
  });

  it("orders what is left by when it was stated: an old value, a new page, the old value again", () => {
    const h = open();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1, T1, { left: 100, start_ms: null })), h.now));
    h.commit((tx) => stateLeft(tx, MAC_SOURCE, { left: 0, start_ms: null, stated_ms: T2, from: "delivery" }));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1, T1, { left: 100, start_ms: null })), h.now));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T2, from: "delivery" });
  });

  it("orders what is left against the seal order: T3's 0 stands over T1's 100 sealed after it and T2's 50 applied, and a re-read changes nothing", () => {
    const h = open();
    const t1 = { id: "lane-mac/t1", stated: T1, left: 100 };
    const t3 = { id: "lane-mac/t3", stated: T3, left: 0 };
    const index = (row: typeof t1) => h.commit((tx) => {
      sealed(tx, { id: row.id, source: MAC_SOURCE, sealed_ms: h.now, stated_ms: row.stated, facts: { snapshot_taken_at: new Date(row.stated).toISOString(), left: row.left, start_ms: null } });
      return stateLeft(tx, MAC_SOURCE, { left: row.left, start_ms: null, stated_ms: row.stated, from: "delivery" });
    });
    expect(index(t3)).toBe(true);
    h.now += MINUTE;
    expect(index(t1)).toBe(false);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2, T2, { left: 50, start_ms: null })), h.now));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T3, from: "delivery" });
  });

  it("keeps a stated `left` under a value that states none, replaces it with a later `0`, and takes a held-back value's `left`", () => {
    const h = open();
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1, T1, { left: 40, start_ms: null })), h.now));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2)), h.now));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 40, start_ms: null, stated_ms: T1, from: "value" });
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3, T3, { left: 0, start_ms: null })), h.now));
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 0, start_ms: null, stated_ms: T3, from: "value" });
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T5, T5, { left: 7 }), { [PASS_P]: 1 }), h.now))).toBe("kept");
    expect(h.kept(MAC_SOURCE).left).toEqual({ left: 7, stated_ms: T5, from: "value" });
  });

  for (const first of ["value", "delivery"] as const) {
    it(`at one instant takes a delivery's \`left\` over a value's, the ${first} taken first`, () => {
      const h = open();
      const byValue = () => h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2, T2, { left: 9, start_ms: null })), h.now));
      const byDelivery = () => h.commit((tx) => stateLeft(tx, MAC_SOURCE, { left: 3, start_ms: null, stated_ms: T2, from: "delivery" }));
      if (first === "value") (byValue(), byDelivery());
      else (byDelivery(), byValue());
      expect(h.kept(MAC_SOURCE).left).toEqual({ left: 3, start_ms: null, stated_ms: T2, from: "delivery" });
    });
  }

  it("reads a gap as a seal no row holds, never one a row holds that waits on an import, and keeps a mark only on the same gap", () => {
    const h = open();
    h.commit((tx) => custodyAt(tx, PASS_P, MAC_SOURCE, 1, h.now));
    const gap = () => h.commit((tx) => gapOf(tx.tables, MAC_SOURCE, { [PASS_Q]: 1, [PASS_P]: 3 }) ?? null);
    expect(gap()).toEqual({ pass: PASS_P, seal: 2 });
    h.commit((tx) => sealed(tx, { id: "lane-p/s2", source: MAC_SOURCE, sealed_ms: T2, pass: PASS_P, seal: 2 }));
    expect(gap()).toEqual({ pass: PASS_Q, seal: 1 });
    expect(h.commit((tx) => gapOf(tx.tables, MAC_SOURCE, { [PASS_P]: 3 }) ?? null)).toBeNull();
    h.commit((tx) => settled(tx, "lane-p/s2", MAC_SOURCE, h.now));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1), { [PASS_P]: 3 }), h.now));
    expect(h.commit((tx) => [markLost(tx, MAC_SOURCE, { pass: PASS_P, seal: 3 }, h.now), markLost(tx, MAC_SOURCE, { pass: PASS_P, seal: 3 }, h.now)])).toEqual([true, false]);
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2), { [PASS_P]: 4 }), h.now));
    expect(h.waiting(MAC_SOURCE)?.lost).toEqual({ pass: PASS_P, seal: 3, at_ms: h.now });
    h.commit((tx) => {
      sealed(tx, { id: "lane-p/s3", source: MAC_SOURCE, sealed_ms: T3, pass: PASS_P, seal: 3 });
      settled(tx, "lane-p/s3", MAC_SOURCE, h.now);
    });
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3), { [PASS_P]: 5 }), h.now));
    expect(h.waiting(MAC_SOURCE)).toMatchObject({ value: { stated_ms: T3 }, received: { [PASS_P]: 5 } });
    expect(h.waiting(MAC_SOURCE)?.lost).toBeUndefined();
  });

  it("keeps a device's count under months:<source>, applied or waiting, the newest statement's; the value kept carries none, and a statement without one leaves it", () => {
    const h = open();
    const months = { "2026-10": [40, 9_000_000] as [number, number], "2026-09": [12, null] as [number, null], undated: [2, 0] as [number, number] };
    const counted = () => h.commit((tx) => countedOf(tx.tables.meta, MAC_SOURCE) ?? null);
    h.commit((tx) => sealed(tx, { id: "lane-mac/d1", source: MAC_SOURCE, sealed_ms: T0, pass: PASS_P, seal: 1 }));
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T2, T2, { months }), { [PASS_P]: 1 }), h.now))).toBe("kept");
    expect(counted()).toEqual({ months, counted_ms: T2 });
    expect(h.waiting(MAC_SOURCE)?.value).toEqual(value(T2));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T1, T1, { months: { "2026-10": [1, 1] } })), h.now));
    expect(counted()).toEqual({ months, counted_ms: T2 });
    h.commit((tx) => settled(tx, "lane-mac/d1", MAC_SOURCE, h.now));
    h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T3)), h.now));
    expect(counted()).toEqual({ months, counted_ms: T2 });
    const later = { "2026-10": [41, 9_100_000] as [number, number] };
    expect(h.commit((tx) => applyThrough(tx, MAC_SOURCE, statement(value(T5, T5, { months: later })), h.now))).toBe("applied");
    expect(counted()).toEqual({ months: later, counted_ms: T5 });
    seen.months = counted();
  });

  it("reads a count only as months or undated to a whole number of items and whole bytes or null", () => {
    expect(monthsIn({ "2026-01": [3, null], undated: [0, 0] })).toEqual({ "2026-01": [3, null], undated: [0, 0] });
    expect(monthsIn({})).toEqual({});
    for (const bad of [null, [], { "2026-13": [1, 1] }, { "2026-1": [1, 1] }, { later: [1, 1] }, { "2026-01": [1] }, { "2026-01": [-1, 0] }, { "2026-01": [1.5, 0] },
      { "2026-01": [1, "2"] }, { "2026-01": { items: 1 } }]) expect(monthsIn(bad), JSON.stringify(bad)).toBeNull();
  });
});
