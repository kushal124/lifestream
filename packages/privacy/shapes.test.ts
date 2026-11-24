import { readFileSync } from "node:fs";
import { baseOf, type DetailType } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { generate, ORDINARY, rngOf, SHAPES, type Shape } from "./bench/synthetic.js";
import { marksOfFree } from "./free.js";
import { compileNames, type NamedPerson } from "./names.js";

const FAULTS: Record<string, string> = {};

const titled = (words: string) => words.toLowerCase().replace(/(^|\s)(\p{L})/gu, (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`);

function tableFor(shape: string, value: string): NamedPerson[] {
  const words = value.split(/\s+/u);
  const full = shape === "person.family-honorific" ? `Ada ${value}`
    : shape === "person.initial" ? `${words[0]} ${words[1]!.replace(".", "")}example`
    : words.length > 1 ? titled(value) : `${value} Example`;
  return [{ who: "p-shape", is: "human", shown: full, names: [...new Set([full, full.split(" ")[0]!])], accounts: [] }];
}

function hidden(shape: Shape, value: string): { whole: boolean; types: string[] } {
  const at = shape.context.indexOf("{}");
  const text = shape.context.replace("{}", value);
  const names = compileNames({ version: `shape-${shape.shape}-${value}`, owner: null, people: shape.table === true ? tableFor(shape.shape, value) : [] });
  const marks = marksOfFree({ length: text.length, source: text, known: [] }, { names, links: "tokens", always: [], never: [] }, [], "all");
  const over = marks.filter((mark) => mark.start < at + value.length && at < mark.end);
  const whole = over.some((mark) => mark.start <= at && at + value.length <= mark.end && baseOf(mark.type) === baseOf(shape.type as DetailType));
  return { whole, types: over.map((mark) => mark.type) };
}

describe("each shape the generator writes", () => {
  for (const shape of SHAPES) {
    const fault = FAULTS[shape.shape];
    const name = `${shape.shape}: hidden whole as ${baseOf(shape.type)}${shape.table === true ? ", People holding its person" : ""}`;
    (fault === undefined ? it : it.skip)(fault === undefined ? name : `${name} (fault: ${fault})`, () => {
      const r = rngOf(17);
      for (let at = 0; at < 5; at += 1) {
        const value = shape.make(r);
        expect({ value, ...hidden(shape, value) }).toMatchObject({ value, whole: true });
      }
    });
  }

  it("names each shape once, and each fault a shape it writes", () => {
    const names = SHAPES.map((shape) => shape.shape);
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(FAULTS).filter((shape) => !names.includes(shape))).toEqual([]);
  });
});

describe("ordinary words", () => {
  const names = compileNames(generate(20261112, 3000).table);
  const marked = (line: string) => marksOfFree({ length: line.length, source: line, known: [] }, { names, links: "tokens", always: [], never: [] }, [], "all").map((mark) => `${mark.type} ${line.slice(mark.start, mark.end)}`);

  it("are hidden nowhere in the chats' ordinary lines, People holding Will, Grace, Rose, Joy and Max (`max 2 people`)", () => {
    for (const line of ORDINARY) expect({ line, marks: marked(line) }).toEqual({ line, marks: [] });
  });
});

describe("the generator", () => {
  const { docs, table } = generate(20261112, 3000);

  it("writes the fixed sample for seed 1, byte for byte", () => {
    const sample = readFileSync(new URL("./bench/sample.jsonl", import.meta.url), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(generate(1, 60).docs).toEqual(sample);
  });

  it("labels each detail where its words stand, in a shape it names, none overlapping", () => {
    const shapes = new Set(SHAPES.map((shape) => shape.shape));
    for (const doc of docs) {
      const spans = [...doc.details.map((detail) => [detail.start, detail.end] as const), ...doc.optional.map(([start, end]) => [start, end] as const)].sort((a, b) => a[0] - b[0]);
      for (let at = 1; at < spans.length; at += 1) expect(spans[at]![0]).toBeGreaterThanOrEqual(spans[at - 1]![1]);
      for (const detail of doc.details) {
        expect(shapes.has(detail.shape), detail.shape).toBe(true);
        expect(doc.text.slice(detail.start, detail.end).trim()).toBe(doc.text.slice(detail.start, detail.end));
      }
    }
    expect(docs.reduce((sum, doc) => sum + doc.details.length, 0)).toBeGreaterThanOrEqual(3000);
  });

  it("writes only obviously fake values: emails at example domains, phones in patterned blocks, the table's too", () => {
    const fakePhone = /^(?:\+?91[- ]?)?(?:98765|99999|90000|80000|70000|60000|55500)[- ]?0\d{4}(?:@.*)?$/u;
    for (const doc of docs) {
      for (const detail of doc.details) {
        const words = doc.text.slice(detail.start, detail.end);
        if (detail.type === "email") expect(words).toMatch(/@example\.(?:com|in|org)$/u);
        if (detail.type === "phone" && detail.shape !== "phone.landline") expect(words.replace(/^91(?=\d{10}@)/u, "")).toMatch(fakePhone);
      }
    }
    for (const person of table.people) for (const account of person.accounts) {
      if (account.startsWith("+")) expect(account).toMatch(fakePhone);
      else if (/@example\./u.test(account) || !account.includes("@")) continue;
      else expect(account).toMatch(/^(?:[a-z.]+|\d{10})@(?:okaxis|oksbi|okhdfcbank|okicici|ybl|paytm|ibl|axl)$/u);
    }
  });
});
