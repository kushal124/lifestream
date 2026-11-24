import { describe, expect, it } from "vitest";
import type { Place } from "@lifestreamprotocol/families";
import { countsServed } from "./places.js";

const counted: Place = { slug: "harbour-0a0a0a", name: "Synthetic Harbour", latitude: 10, longitude: 20, radius_m: 120, also: [{ latitude: 10.01, longitude: 20.01, radius_m: 60 }], ids: ["google:synthetic-a"] };

describe("which counts a place's read serves as its own", () => {
  it("a place the counts were made for, renamed, reads them; one with no row, or other circles, ids or home word, does not", () => {
    expect(countsServed({ ...counted, name: "Synthetic Port" }, counted)).toBe(true);
    expect(countsServed(counted, undefined)).toBe(false);
    for (const changed of [
      { ...counted, latitude: 10.5 },
      { ...counted, radius_m: 140 },
      { ...counted, also: [] },
      { ...counted, also: [...counted.also, { latitude: 10.02, longitude: 20.02, radius_m: 60 }] },
      { ...counted, ids: [] },
      { ...counted, home: true },
      { ...counted, home: false },
    ]) {
      expect(countsServed(changed, counted), JSON.stringify(changed)).toBe(false);
    }
  });
});
