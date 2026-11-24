import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Family, Fed, Given } from "./family.js";
import { pin, type Pin, type PinnedRow } from "./test/pin.js";

const FAMILY = { name: "made-up", code: "3" } as Family;
const given = (product: string, version: string) => ({ product, name: `Example ${product}`, vendor: "example", type: null, adapter: { version, kinds: ["entry"] } }) as Given as Given<never>;
const ADAPTERS: Partial<Fed> = { notes: [given("example-notes", "1")], screen: [given("example-screen", "2")] };
const ROWS: PinnedRow[] = [
  { unit: "a", reading: "r-a", content: { words: "first" }, start_ms: 0, end_ms: 1, days: ["2026-09-20"] },
  { unit: "b", reading: "r-b", content: { words: "second" }, start_ms: 2, end_ms: null, days: ["2026-09-20", "2026-09-21"] },
];

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pins-"));
  file = join(dir, "pin.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const written = (rows: PinnedRow[] = ROWS) => pin(FAMILY, ADAPTERS, rows, { file, update: true });
const check = (family: Family = FAMILY, adapters: Partial<Fed> = ADAPTERS, rows: PinnedRow[] = ROWS) => () => pin(family, adapters, rows, { file, update: false });

describe("the pin: what must be impossible", () => {
  it("no pin passes; the update flag writes a first pin, which then passes", () => {
    expect(check()).toThrow(/made-up family has no pin/u);
    written();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      family: "made-up", key: { code: "3", adapters: { "notes/example-notes": "1", "screen/example-screen": "2" } }, rows: 2,
    });
    expect(check()).not.toThrow();
  });

  it("the same rows in another order fail", () => {
    written();
    expect(check(FAMILY, ADAPTERS, [...ROWS].reverse())).not.toThrow();
  });

  it("an output moved under the same key passes, or fails without the family's name and the bump it asks", () => {
    written();
    const moved = [{ ...ROWS[0]!, days: ["2026-09-21"] }, ROWS[1]!];
    expect(check(FAMILY, ADAPTERS, moved)).toThrow(/made-up family's output .* moved.*bump the made-up family's code, or the version of the adapter/u);
    expect(check(FAMILY, ADAPTERS, [{ ...ROWS[0]!, content: { words: "other" } }, ROWS[1]!])).toThrow(/bump the made-up family's code/u);
    expect(check(FAMILY, ADAPTERS, ROWS.slice(1))).toThrow(/bump the made-up family's code/u);
  });

  it("the update flag writes a moved digest under the same key", () => {
    written();
    const before = readFileSync(file, "utf8");
    expect(() => written([{ ...ROWS[0]!, reading: "r-a2" }, ROWS[1]!])).toThrow(/bump the made-up family's code/u);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("a bumped code with the pin not written again passes", () => {
    written();
    const bumped = { ...FAMILY, code: "4" };
    expect(check(bumped)).toThrow(/made-up family's pin is stale/u);
    expect(check(bumped, ADAPTERS, [{ ...ROWS[0]!, reading: "r-a2" }, ROWS[1]!])).toThrow(/made-up family's pin is stale/u);
    pin(bumped, ADAPTERS, ROWS, { file, update: true });
    expect(check(bumped)).not.toThrow();
  });

  it("a bumped adapter version alone asks for a code bump, not for the pin", () => {
    written();
    const bumped: Partial<Fed> = { ...ADAPTERS, screen: [given("example-screen", "3")] };
    expect(check(FAMILY, bumped)).toThrow(/made-up family's pin is stale/u);
    expect(check(FAMILY, { notes: ADAPTERS.notes! })).toThrow(/made-up family's pin is stale/u);
    pin(FAMILY, bumped, ROWS, { file, update: true });
    expect(check(FAMILY, bumped)).not.toThrow();
  });
});

describe("every family has its pin", () => {
  it("a family the release runs keeps no pin, or a pin of another family's name", () => {
    const here = new URL("./", import.meta.url);
    const families = readdirSync(here, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(new URL(`${entry.name}/family.ts`, here)))
      .map((entry) => entry.name)
      .sort();
    expect(families.length).toBeGreaterThan(0);
    const pinned = (name: string) => {
      const file = new URL(`${name}/test/pin.json`, here);
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Pin).family : undefined;
    };
    expect(families.filter((name) => pinned(name) !== name), "families with no pin of their own").toEqual([]);
  });
});
