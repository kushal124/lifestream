import { describe, expect, it } from "vitest";
import { served } from "./reads.js";

const BLOB = `sha256:${"d".repeat(64)}`;

describe("served: the one test of a blob the door serves, which describe's voice and the blob route share", () => {
  it("serves a blob only when a record names it and the store keeps its file: a file no record names (an erasure cut between its parts) or a name whose file is gone is not served", () => {
    const view = (named: boolean) => ({ holds: (blob: string) => named && blob === BLOB });
    const store = (kept: boolean) => ({ has: (blob: string) => kept && blob === BLOB });
    const cases: [named: boolean, kept: boolean][] = [[true, true], [false, true], [true, false], [false, false]];
    expect(cases.map(([named, kept]) => served(view(named), store(kept), BLOB))).toEqual([true, false, false, false]);
    expect(served(view(true), store(true), `sha256:${"e".repeat(64)}`)).toBe(false);
  });
});
