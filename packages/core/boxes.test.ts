import { describe, expect, it } from "vitest";
import { overlap } from "./boxes.js";

const box = (x: number, y: number, side: number) => ({ x, y, width: side, height: side });

describe("overlap", () => {
  it("over the union takes a small box inside a large one for another, over the smaller box for the same", () => {
    const large = box(0, 0, 100), inside = box(10, 10, 40);
    expect(overlap(large, inside, "union")).toBeCloseTo(0.16);
    expect(overlap(large, inside, "smaller")).toBe(1);
  });

  it("is the same either way round, and 0 for boxes that only touch or lie apart", () => {
    const a = box(0, 0, 10), b = box(5, 0, 10);
    expect(overlap(a, b, "union")).toBeCloseTo(50 / 150);
    expect(overlap(b, a, "union")).toBe(overlap(a, b, "union"));
    expect(overlap(a, b, "smaller")).toBeCloseTo(0.5);
    expect(overlap(a, box(10, 0, 10), "union")).toBe(0);
    expect(overlap(a, box(30, 30, 10), "smaller")).toBe(0);
  });
});
