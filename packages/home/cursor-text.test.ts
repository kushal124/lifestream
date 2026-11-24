import { describe, expect, it } from "vitest";
import { argumentsWritten, ARGUMENTS_BYTES, aroundBytes, CursorWriter, EXPIRED, LIMIT_BYTES, NEXT_BYTES, NEXT_CHARS, opened, sealed, type Bound, type Params, type Route } from "./cursor-text.js";
import { Refusal } from "./refusal.js";

const place = new CursorWriter().put(7).signed(-3).set([5n, 1n, 2n ** 62n]).written;
const PARAMS: { [R in Route]: Params<R> } = {
  record: { query: "word", from: "2026-01-01", person: ["Person A", "Doe, Jane"], families: ["messages"], limit: 20, typing: 1 },
  screen: { query: "word", products: ["slack"] },
  count: { of: "payments", measure: "amount", op: "sum", by: ["payee"], match: { payee: "acme -taxi" }, at_least: 2.5, limit: 50 },
  people: { name: "Sam" },
  read: { ref: ["record.a", "record.b"], history: 1 },
  kinds: { query: "word", to: "2026-11-14", typing: 1, see: "calendar", upcoming: 1 },
};
const BOUND: { [R in Route]: Bound } = {
  record: { index: "f", epoch: 3, resolved: "r" }, screen: { screen: "s", epoch: 3 }, count: { index: "f", facts: "b", resolved: "r" },
  people: { index: "f", facts: "b", resolved: "r" }, read: { index: "f" }, kinds: { index: "f", screen: "s" },
};
const ROUTES = Object.keys(PARAMS) as Route[];

function code(run: () => unknown): string {
  try {
    run();
    return "answered";
  } catch (error) {
    if (error instanceof Refusal) return error.code;
    throw error;
  }
}

describe("one sealer", () => {
  it("reads back each route's place and its parameters as the contract parsed them", () => {
    for (const route of ROUTES) {
      const text = sealed(route, place, PARAMS[route] as never, BOUND[route]);
      expect(text).toMatch(/^[A-Za-z0-9_-]+$/u);
      const cursor = opened(text, [route]);
      expect(cursor.route).toBe(route);
      expect([cursor.place.small(), Number(cursor.place.signed()), cursor.place.set(3)]).toEqual([7, -3, [1n, 5n, 2n ** 62n]]);
      cursor.place.end();
      expect(cursor.params).toEqual(PARAMS[route]);
    }
  });

  it("refuses a next of another route, and a text it did not write", () => {
    const count = sealed("count", place, PARAMS.count, BOUND.count);
    for (const routes of [["record", "screen"], ["read"], ["people"]] as const) expect(code(() => opened(count, routes))).toBe("BAD_PARAMETER");
    expect(opened(count, ["count"]).route).toBe("count");
    for (const text of ["not a cursor", count.slice(0, 10), "A".repeat(NEXT_CHARS + 4)]) {
      expect(code(() => opened(text, ["count"]))).toBe("BAD_PARAMETER");
    }
  });

  it("goes on given alone with its parameters; with its own, the same; with others refused; `limit` beside it pages at that size", () => {
    const text = sealed("record", place, PARAMS.record, BOUND.record);
    expect(opened(text, ["record"]).params).toEqual(PARAMS.record);
    expect(opened(text, ["record"], { ...PARAMS.record, cursor: text }).params).toEqual(PARAMS.record);
    expect(opened(text, ["record"], { limit: 5, lists: ["record"] }).params).toEqual({ ...PARAMS.record, limit: 5 });
    expect(code(() => opened(text, ["record"], { query: "other" }))).toBe("BAD_PARAMETER");
    expect(code(() => opened(text, ["record"], { ...PARAMS.record, person: ["Person A"] }))).toBe("BAD_PARAMETER");
  });

  it("expires once a member it holds moved, one sentence on every route; never for a member it does not hold", () => {
    for (const route of ROUTES) {
      const cursor = opened(sealed(route, place, PARAMS[route] as never, BOUND[route]), [route]);
      const now = (bound: Bound) => Object.fromEntries(Object.entries(bound).map(([member, value]) => [member, () => value]));
      expect(code(() => cursor.check(now(BOUND[route])))).toBe("answered");
      for (const member of Object.keys(BOUND[route]) as (keyof Bound)[]) {
        const moved = { ...BOUND[route], [member]: member === "epoch" ? 4 : "moved" };
        try {
          cursor.check(now(moved));
          throw new Error(`${route} went on with ${member} moved`);
        } catch (error) {
          expect(error).toMatchObject({ code: "CURSOR_EXPIRED", words: EXPIRED });
        }
      }
    }
    const byTime = opened(sealed("record", place, PARAMS.record, { index: "f" }), ["record"]);
    expect(code(() => byTime.check({ index: () => "f", epoch: () => 9, resolved: () => "anything" }))).toBe("answered");
    expect(() => sealed("screen", place, PARAMS.screen, { index: "f" })).toThrow(/does not name/u);
  });

  it("holds parameters at ARGUMENTS_BYTES as written: past it refused, and every next of them fits NEXT_CHARS", () => {
    const q = (bytes: number) => "q".repeat(bytes - argumentsWritten("record", { query: "" }).length);
    expect(argumentsWritten("record", { query: q(ARGUMENTS_BYTES) }).length).toBe(ARGUMENTS_BYTES);
    expect(code(() => argumentsWritten("record", { query: q(ARGUMENTS_BYTES + 1) }))).toBe("BAD_PARAMETER");
    expect(argumentsWritten("record", { query: "\"" }).length).toBe(argumentsWritten("record", { query: "x" }).length + 1);
    expect(code(() => argumentsWritten("record", { query: "\ud800" }))).toBe("BAD_PARAMETER");
    const text = sealed("record", new Uint8Array(2_400), { query: q(ARGUMENTS_BYTES) }, BOUND.record);
    expect(text.length).toBeLessThanOrEqual(NEXT_CHARS);
    expect(opened(text, ["record"]).params).toEqual({ query: q(ARGUMENTS_BYTES) });
    expect(() => sealed("record", new Uint8Array(NEXT_CHARS), { query: "x" }, BOUND.record)).toThrow(/characters/u);
  });

  it("`limit` pages and is no argument: an ask at 1,095 bytes, then its next with limit=50, is read; a limit beside arguments at their bound still fits", () => {
    for (const route of ["record", "count"] as const) {
      const base = (route === "record" ? { query: "" } : { of: "payments", words: "" }) as Record<string, unknown>;
      const member = route === "record" ? "query" : "words";
      const asked = { ...base, [member]: "q".repeat(1_095 - argumentsWritten(route, base as never).length) };
      expect(argumentsWritten(route, asked as never).length).toBe(1_095);
      const text = sealed(route, place, asked as never, BOUND[route]);
      const held = opened(text, [route], { limit: 50 });
      expect(held.params).toEqual({ ...asked, limit: 50 });
      expect(code(() => argumentsWritten(route, held.params as never))).toBe("answered");
      expect(argumentsWritten(route, held.params as never).length).toBeGreaterThan(1_100);
    }
    const args = { query: "q".repeat(ARGUMENTS_BYTES - argumentsWritten("record", { query: "" }).length), limit: 100 };
    expect(argumentsWritten("record", args).length).toBe(ARGUMENTS_BYTES + LIMIT_BYTES);
    const text = sealed("record", new Uint8Array(NEXT_BYTES - aroundBytes(ARGUMENTS_BYTES + LIMIT_BYTES)), args, BOUND.record);
    expect(text.length).toBeLessThanOrEqual(NEXT_CHARS);
  });
});
