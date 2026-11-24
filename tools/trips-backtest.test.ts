import { describe, expect, it } from "vitest";
import { compare, gatedLength, type Item } from "./trips-backtest.js";

const ALL = { start_ms: -1e12, end_ms: 1e12 };
const point = (east: number) => ({ latitude: 10, longitude: 20 + east / 109_600 });
const trip = (start_ms: number, end_ms: number, mode = "walk", distance_m = 1_600, to = 0): Item =>
  ({ kind: "trip", start_ms, end_ms, from: point(0), to: point(to), distance_m, legs: [{ mode, distance_m }] });
const stay = (start_ms: number, end_ms: number, east = 0): Item => ({ kind: "stay", start_ms, end_ms, from: point(east), to: point(east), distance_m: 0, legs: [] });

describe("the trips backtest's diff", () => {
  it("D1, D2: a trip the repeat rule removes is the repeat rule's, one the still jump removes the still rule's, one kept is not listed", () => {
    const served = [trip(0, 10), trip(100, 110, "road_vehicle", 100), trip(200, 210)];
    const repeatsOnly = [trip(100, 110, "road_vehicle", 100), trip(200, 210)];
    const lane = [trip(200, 210)];
    const { changed, added } = compare(served, lane, repeatsOnly, ALL);
    expect(changed.map(({ before, after, rule }) => ({ start: before.start_ms, after: after.length, rule }))).toEqual([
      { start: 0, after: 0, rule: "repeats" },
      { start: 100, after: 0, rule: "still" },
    ]);
    expect(added).toEqual([]);
  });

  it("D1, D2: a trip changed by both rules is both's, and its after lists every trip over it", () => {
    const served = [trip(0, 100)];
    const repeatsOnly = [trip(0, 50), trip(60, 100)];
    const lane = [trip(60, 100)];
    expect(compare(served, lane, repeatsOnly, ALL).changed).toEqual([{ before: served[0], after: lane, rule: "repeats+still" }]);
  });

  it("D1: a trip whose legs' mode changed is listed", () => {
    expect(compare([trip(0, 10)], [trip(0, 10, "unclear")], [trip(0, 10, "unclear")], ALL).changed.map((change) => change.rule)).toEqual(["repeats"]);
  });

  it("D3: a trip the home does not serve is added", () => {
    expect(compare([], [trip(0, 10)], [trip(0, 10)], ALL).added).toEqual([trip(0, 10)]);
  });

  it("D4: a stay that grew over a removed trip is listed with how far its centre moved, an unchanged one is not", () => {
    const lane = [stay(0, 100), stay(200, 300)];
    const { stays } = compare([stay(0, 50), stay(60, 100, 90), stay(200, 300)], lane, lane, ALL);
    expect(stays.map(({ before, after, moved_m }) => ({ before: before.start_ms, after: after?.end_ms ?? null, moved: Math.round(moved_m ?? -1) }))).toEqual([
      { before: 0, after: 100, moved: 0 },
      { before: 60, after: 100, moved: 90 },
    ]);
  });

  it("D6: what crosses the compared days' edges is an edge's, never a rule's; what both sides hold alike there is not listed", () => {
    const range = { start_ms: 100, end_ms: 1_000 };
    const served = [stay(0, 150), trip(150, 200), stay(200, 400), trip(400, 450), stay(450, 990), trip(990, 1_010), stay(1_010, 2_000)];
    const lane = [stay(20, 150), trip(150, 200), stay(200, 400), trip(400, 450), stay(450, 1_050), stay(1_050, 2_000, 30)];
    const { changed, added, stays, moved, edges } = compare(served, lane, lane, range);
    expect({ changed, added, stays, moved }).toEqual({ changed: [], added: [], stays: [], moved: [] });
    expect(edges.served.map((item) => [item.kind, item.start_ms])).toEqual([["stay", 450], ["stay", 0], ["trip", 990]]);
    expect(edges.lane.map((item) => [item.kind, item.start_ms])).toEqual([["stay", 20], ["stay", 450]]);
  });

  it("D6: a served trip whose counterpart crosses the edge is an edge's", () => {
    const { changed, edges } = compare([trip(900, 950)], [trip(900, 1_100)], [trip(900, 1_100)], { start_ms: 0, end_ms: 1_000 });
    expect(changed).toEqual([]);
    expect(edges.served.map((item) => item.start_ms)).toEqual([900]);
    expect(edges.lane.map((item) => item.start_ms)).toEqual([900]);
  });

  it("D7: a stay whose centre moved past 10 m with its span the same is listed with the rule that moved it; a move within 10 m is not", () => {
    const served = [stay(0, 100), stay(200, 300), stay(400, 500)];
    const lane = [stay(0, 100, 40), stay(200, 300, 40), stay(400, 500, 8)];
    const repeatsOnly = [stay(0, 100, 40), stay(200, 300), stay(400, 500, 8)];
    const { stays, moved } = compare(served, lane, repeatsOnly, ALL);
    expect(stays).toEqual([]);
    expect(moved.map(({ before, moved_m, rule }) => ({ start: before.start_ms, moved: Math.round(moved_m), rule }))).toEqual([
      { start: 0, moved: 40, rule: "repeats" },
      { start: 200, moved: 40, rule: "still" },
    ]);
  });

  it("D7: a trip whose end moved past 10 m, its span, length and legs the same, is listed and is no change", () => {
    const { changed, moved } = compare([trip(0, 10)], [trip(0, 10, "walk", 1_600, 25)], [trip(0, 10, "walk", 1_600, 25)], ALL);
    expect(changed).toEqual([]);
    expect(moved.map(({ before, moved_m, rule }) => ({ start: before.start_ms, moved: Math.round(moved_m), rule }))).toEqual([{ start: 0, moved: 25, rule: "repeats" }]);
  });

  it("D5: fixes bouncing within their accuracy add nothing; a walk of fixes farther apart than theirs counts whole", () => {
    const fix = (east: number, accuracy_m: number) => ({ key: "", at_ms: 0, latitude: 10, longitude: 20 + east / 109_600, accuracy_m, speed_mps: null, altitude_m: 0 });
    expect(gatedLength([fix(0, 196), fix(190, 196), fix(10, 196), fix(150, 196)])).toBe(0);
    expect(Math.round(gatedLength([fix(0, 5), fix(10, 5), fix(20, 5), fix(30, 5)]))).toBe(30);
  });
});
