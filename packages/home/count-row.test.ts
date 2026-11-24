import { describe, expect, it } from "vitest";
import { text } from "./cell.js";
import type { CountAsk, CountContext, Kept } from "./counting.js";
import { makeRef, readRef } from "./refs.js";
import type { FactsRead } from "./search-index.js";
import { termsOf } from "./search-words.js";
import { canonical, type Json } from "@lifestreamprotocol/core";
import { ARGUMENTS_BYTES, argumentsWritten, NEXT_BYTES, NEXT_CHARS, sealed } from "./cursor-text.js";
import type { PeopleMap } from "./counting.js";
import { REF_CHARS } from "./refs.js";
import { admissionOf, keptSpelled, rowRefOf, VALUE_KEPT } from "./count.js";

const KEPT: Kept = {
  persons: [{ said: text("Ada"), id: "person:ada", name: "Ada Example", handles: ["jid:15550000142@s.whatsapp.net", "email:person-a@example.com"], bare: false }],
  handles: ["jid:15550000142@s.whatsapp.net", "email:person-a@example.com"],
  values: { payee: { in: ["ACME CABS LIMITED", "ACME, CABS"], out: ["ACME TAXI"] }, direction: { out: ["sent"] } },
  took: { payee: [{ said: text("acme"), values: ["ACME CABS LIMITED"] }], direction: [] },
  chat: [],
  place: { in: [{ level: "city", key: "example-city" }], out: [{ level: "country", key: "example-country" }], took: [] },
  words: termsOf('cab "airport run" OR taxi -late'),
};
const ASK: CountAsk = { of: "payments", op: "count", by: ["payee"], person: ["Ada"], match: { payee: "acme -taxi" }, limit: 50 };
const CONTEXT = { people: () => undefined } as unknown as CountContext;

describe("a row's kept", () => {
  it("travels in its ref as the record spells it, and reads back as the count kept it", () => {
    const spelled = keptSpelled(KEPT);
    expect(spelled).toEqual({
      persons: [["jid:15550000142@s.whatsapp.net", "email:person-a@example.com"]], chat: [],
      values: { payee: { in: ["ACME CABS LIMITED", "ACME, CABS"], out: ["ACME TAXI"] }, direction: { out: ["sent"] } },
      place: { in: [{ level: "city", id: "example-city" }], out: [{ level: "country", id: "example-country" }] },
    });
    const ref = makeRef("row", { ask: { of: "payments", by: ["payee"], match: { payee: "acme -taxi" }, words: 'cab "airport run" OR taxi -late' }, kept: spelled, scope: { g: ["ACME CABS LIMITED"], p: null }, n: 3 });
    expect(readRef(ref, "ref", ["row"]).parts.kept).toEqual(spelled);
  });

  it("is admitted again as what the count kept: each filter's values, its handles, its places", () => {
    const { words: _words, ...plainKept } = KEPT;
    const spelled = keptSpelled(plainKept);
    const admission = admissionOf({} as FactsRead, ASK, CONTEXT, spelled);
    expect(admission.words).toBeUndefined();
    expect({ handles: admission.kept.handles, values: admission.kept.values, chat: admission.kept.chat, place: { in: admission.kept.place?.in, out: admission.kept.place?.out } })
      .toEqual({ handles: KEPT.handles, values: KEPT.values, chat: [], place: { in: KEPT.place!.in, out: KEPT.place!.out } });
    expect(admission.kept.persons.map((person) => person.handles)).toEqual([KEPT.persons[0]!.handles]);
    const unmatched: CountAsk = { ...ASK, match: {}, person: [] };
    expect(admissionOf({} as FactsRead, unmatched, CONTEXT, {}).kept.handles).toBeUndefined();
    expect(admissionOf({} as FactsRead, unmatched, CONTEXT, keptSpelled({ ...plainKept, values: {}, persons: [], handles: [] })).kept.handles).toEqual([]);
  });

  it("keeps a key's values, or a place's, while its ref fits REF_CHARS; past it, the ask's words, admitted again when it opens", () => {
    const many = Array.from({ length: 200 }, (_, at) => `ACME BRANCH ${at}`);
    const wide: Kept = { ...KEPT, words: [], values: { payee: { in: many, out: [] }, direction: { out: ["sent"] } }, place: { in: many.map((key) => ({ level: "city", key })), out: [], took: [] } };
    const rowAsk = { of: "payments", match: { payee: "acme -taxi", direction: "sent" }, place: "acme" };
    const ref = rowRefOf(rowAsk, keptSpelled(wide), {}, 3);
    expect(ref.length).toBeLessThanOrEqual(REF_CHARS);
    const spelled = readRef(ref, "ref", ["row"]).parts.kept;
    expect(spelled.values).toEqual({ direction: { out: ["sent"] } });
    expect(spelled.place).toBeUndefined();
    expect(spelled.persons).toEqual([KEPT.persons[0]!.handles]);
    const { place: _place, ...unplaced } = wide;
    const few = readRef(rowRefOf(rowAsk, keptSpelled({ ...unplaced, values: { payee: { in: many.slice(0, 20), out: [] } } }), {}, 3), "ref", ["row"]).parts.kept;
    expect(few.values?.payee?.in).toHaveLength(20);
    const held = [...many, "ACME TAXI", "EXAMPLE BAKERY"].map((value, name) => ({ name, value }));
    const read = { revision: "rev-1", values: (_of: string, key: string) => (key === "payee" ? held : []) } as unknown as FactsRead;
    const context = { people: () => undefined, collections: new Map([["payments", { keys: ["payee", "direction"], measures: {} }]]) } as unknown as CountContext;
    const ask: CountAsk = { of: "payments", op: "count", by: [], person: [], match: { payee: "acme -taxi", direction: "sent" }, limit: 50 };
    const { persons: _persons, ...plainKept } = spelled;
    const admitted = admissionOf(read, ask, context, plainKept);
    expect(admitted.kept.values.payee).toEqual({ in: [...many, "ACME TAXI"], out: ["ACME TAXI"] });
    expect(admitted.kept.values.direction).toEqual({ out: ["sent"] });
  });

  it("past its values, each person narrows to their lowest handle, opened as whoever holds it now: never a name resolved again", () => {
    const handles = (person: number) => Array.from({ length: 40 }, (_, at) => `email:person-${person}-handle-${String(39 - at).padStart(2, "0")}@example.com`);
    const kept: Kept = {
      persons: Array.from({ length: 10 }, (_, at) => ({ said: text(`Person ${at}`), id: `person:${at}`, name: `Person ${at}`, handles: handles(at), bare: false })),
      handles: Array.from({ length: 10 }, (_, at) => handles(at)).flat(), values: {}, took: {},
    };
    const names = Array.from({ length: 10 }, (_, at) => `Person ${at}`);
    const ref = rowRefOf({ of: "calls", person: names }, keptSpelled(kept), {}, 1);
    expect(ref.length).toBeLessThanOrEqual(REF_CHARS);
    const lowest = (person: number) => `email:person-${person}-handle-00@example.com`;
    expect(readRef(ref, "ref", ["row"]).parts.kept.persons).toEqual(Array.from({ length: 10 }, (_, at) => lowest(at)));
    const people: PeopleMap = {
      version: "v", idOf: (value: string) => (value.startsWith("email:person-") ? `person:${value.slice(13, value.indexOf("-handle"))}` : undefined),
      person: (id: string) => ({ name: `Someone Else ${id.slice(7)}`, handles: handles(Number(id.slice(7))) }), find: () => ["person:9"],
    } as unknown as PeopleMap;
    const ask: CountAsk = { of: "calls", op: "count", by: [], person: names, match: {}, limit: 50, asked: { of: "calls", person: names } };
    const admitted = admissionOf({} as FactsRead, ask, { people: () => people } as unknown as CountContext, readRef(ref, "ref", ["row"]).parts.kept);
    expect(admitted.kept.handles).toEqual(kept.handles);
    const alone = admissionOf({} as FactsRead, ask, { people: () => ({ ...people, idOf: () => undefined }) } as unknown as CountContext, { persons: [lowest(3)] });
    expect(alone.kept.handles).toEqual([lowest(3)]);
  });

  it("a row grouped by two long non-Latin values, its ask at its bound: the ref within REF_CHARS, its values kept by bytes, the row's next within NEXT_CHARS", () => {
    const long = (seed: string) => `${seed}${"\u6f22\u5b57\u306e\u9577\u3044\u540d\u524d".repeat(43)}`;
    const base = { of: "payments", measure: "amount", op: "sum" as const, by: ["payee", "note"], from: "2026-01-01", to: "2026-10-31", words: "\u4f1a\u8b70 ".repeat(40).trim(), match: { payee: "x", note: "x" } };
    const filler = ARGUMENTS_BYTES - argumentsWritten("count", base).length;
    const ask = { ...base, match: { payee: `x${"\u5546".repeat(Math.floor(filler / 3))}${"n".repeat(filler % 3)}`, note: "x" } };
    expect(argumentsWritten("count", ask).length).toBe(ARGUMENTS_BYTES);
    const kept: Kept = { values: { payee: { in: [long("a")], out: [] }, note: { in: [long("b")], out: [] } }, took: {}, persons: [] };
    const ref = rowRefOf(ask, keptSpelled(kept), { g: [long("a"), long("b")], p: "EUR" }, 1_000_000);
    expect(ref.length).toBeLessThanOrEqual(REF_CHARS);
    const scope = readRef(ref, "ref", ["row"]).parts.scope as { g: { v: string; h: string }[] };
    for (const cell of scope.g) expect(Buffer.byteLength(cell.v)).toBeLessThanOrEqual(VALUE_KEPT);
    expect(scope.g[0]!.v.length).toBeGreaterThan(0);
    const place = { k: "row", p: { after: { unit: `payments/${"u".repeat(240)}`, p: "EUR", fact: `payments:${"f".repeat(120)}`, t: 1_790_000_000_000, d: "2026-10-31", v: -123_456_789.12 } } };
    const next = sealed("read", Buffer.from(canonical(place as unknown as Json)), { ref }, { index: "file-1", facts: "build-1" });
    expect(next.length).toBeLessThanOrEqual(NEXT_CHARS);
  });

  it("the largest row ref is at most REF_CHARS, and the `next` of the row `read` opens, with the largest place, fits 6,000 characters", () => {
    const handles = (person: number) => Array.from({ length: 40 }, (_, at) => (at % 2 === 0 ? `phone:+1555000${String(person).padStart(2, "0")}${String(at).padStart(2, "0")}` : `email:person-${person}-${at}@example.com`));
    const value = (at: number) => `EXAMPLE MERCHANT ${String(at).padStart(3, "0")} LIMITED`.padEnd(40, "X");
    const many = Array.from({ length: 200 }, (_, at) => value(at));
    const words = Array.from({ length: 30 }, (_, at) => `word${at}`).join(" ");
    const base = {
      of: "payments", measure: "amount", op: "sum" as const, by: ["person", "month"], from: "2026-01-01T00:00+05:30", to: "2026-10-31T23:59+05:30",
      person: Array.from({ length: 10 }, (_, at) => `Person Example ${at}`), words, match: { payee: "merchant OR shop -refund", channel: "card" }, place: "Example City OR Other City",
    };
    const filler = ARGUMENTS_BYTES - argumentsWritten("count", { ...base, match: { ...base.match, note: "" } }).length;
    const ask = { ...base, match: { ...base.match, note: "n".repeat(filler) } };
    expect(argumentsWritten("count", ask).length).toBe(ARGUMENTS_BYTES);
    const kept: Kept = {
      persons: Array.from({ length: 10 }, (_, at) => ({ said: text(`Person Example ${at}`), id: `person:${at}`, name: `Person Example ${at}`, handles: handles(at), bare: false })),
      handles: Array.from({ length: 10 }, (_, at) => handles(at)).flat(),
      values: { payee: { in: many, out: many.slice(0, 5) }, channel: { in: ["card"], out: [] } }, took: {},
      place: { in: many.map((key, at) => ({ level: at % 2 === 0 ? "city" : "region", key: key.toLowerCase() })), out: [], took: [] },
    };
    const largest = rowRefOf(ask, keptSpelled(kept), { g: [handles(0), "2026-03"], p: "EUR" }, 1_000_000);
    expect(largest.length).toBeLessThanOrEqual(REF_CHARS);
    const place = { k: "row", p: { after: { unit: `payments/${"u".repeat(240)}`, p: "EUR", fact: `payments:${"f".repeat(120)}`, t: 1_790_000_000_000, d: "2026-10-31", v: -123_456_789.12 } } };
    const placeBytes = Buffer.byteLength(canonical(place as unknown as Json));
    expect(18 + 10 + REF_CHARS + placeBytes).toBeLessThanOrEqual(NEXT_BYTES);
    const next = sealed("read", Buffer.from(canonical(place as unknown as Json)), { ref: largest }, { index: "file-1", facts: "build-1" });
    expect(next.length).toBeLessThanOrEqual(NEXT_CHARS);
  });
});
