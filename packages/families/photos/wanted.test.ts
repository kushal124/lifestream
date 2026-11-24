import { describe, expect, it } from "vitest";
import { coming, type WantedContent } from "./wanted.js";

const PHONE = "apple-photos:person-a@example.com:iphone-0001";
const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
const START = Date.UTC(2026, 4, 19);
const DAY = 86_400_000;

function photo(at_ms: number | null, sources: readonly string[] = [PHONE], size: number | null = 1_000): WantedContent {
  return {
    at_ms,
    missing: [{ type: "photo", name: null, size }],
    routes: sources.map((source) => ({ source, asset: `asset-${at_ms ?? "undated"}`, files: ["photo"], refused: false })),
  };
}

describe("photo files under the start: each way it could fail", () => {
  it("a photo dated before the start is still wanted, an undated one is dropped, or one dated on the start's midnight is left out", () => {
    const units = [photo(START - DAY), photo(START - 1), photo(START), photo(START + DAY, [PHONE, MAC], null), photo(null)];
    expect(coming(units, START)).toEqual({ wanted: 3, unavailable: 0, bytes: 2_000, unsized: 1, libraries: { [PHONE]: 3, [MAC]: 1 } });
    expect(coming(units, null)).toEqual({ wanted: 5, unavailable: 0, bytes: 4_000, unsized: 1, libraries: { [PHONE]: 5, [MAC]: 1 } });
  });

  it("a start moved later still counts the files below it as coming, so a library never says done", () => {
    const units = [photo(START - 30 * DAY), photo(START - DAY)];
    expect(coming(units, START).libraries[PHONE]).toBeUndefined();
    expect(coming(units, START - 2 * DAY).libraries[PHONE]).toBe(1);
  });
});
