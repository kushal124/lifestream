import { describe, expect, it } from "vitest";
import type { LineAdapter } from "@lifestreamprotocol/core";
import { AT_MS, statedOf } from "../test/stated.js";
import { plainFaults } from "./faults.js";

const line = (value: object) => plainFaults(statedOf<LineAdapter>({}, "line", value));

describe("plainFaults", () => {
  it("passes a line that keeps every rule", () => {
    expect(line({ text: "Synthetic line", title: "A title" })).toEqual([]);
  });

  it("names each rule a line breaks, in the words the family throws", () => {
    expect(line({ text: "Synthetic line", at_ms: AT_MS })).toEqual(["its line states at_ms: a line is placed at its record's own time; drop at_ms and end_ms"]);
    expect(line({ title: "A title" })).toEqual(["its line has no text"]);
    expect(line({ text: "Synthetic line", title: 4 })).toEqual(["its line has a title that is no text"]);
  });
});
