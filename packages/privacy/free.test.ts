import { describe, expect, it } from "vitest";
import type { Level, Mark } from "@lifestreamprotocol/core";
import { marksOfFree, readPassages, type Free, type Ways } from "./free.js";
import { compileNames } from "./names.js";

const WAYS: Ways = {
  names: compileNames({
    version: "free-test",
    owner: null,
    people: [
      { who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["+15550000001"] },
      { who: "b-shop", is: "business", shown: "Example Shop", names: ["Example Shop"], accounts: [] },
    ],
  }, () => false),
  links: "tokens",
  always: ["falcon"],
  never: ["lifestream"],
};

const whole = (text: string, known: Mark[] = []): Free => ({ length: text.length, source: text, known });
const shown = (free: Free, marks: Mark[]) => marks.map((mark) => `${mark.type}:${free.source.slice(mark.start, mark.end)}`);

describe("readPassages", () => {
  it("reads every passage a piece touches, and the one after its cut only where the cut meets a passage's edge", () => {
    const source = `${"a ".repeat(497)}+1 555 000 0142 and more`;
    expect(readPassages(whole(source))).toEqual([{ start: 0, end: 1_000 }, { start: 1_001, end: source.length }]);
    expect(readPassages({ length: 1_000, source })).toEqual([{ start: 0, end: 1_000 }, { start: 1_001, end: source.length }]);
    expect(readPassages({ length: 1_001, source })).toEqual([{ start: 0, end: 1_000 }, { start: 1_001, end: source.length }]);
    expect(readPassages({ length: 500, source })).toEqual([{ start: 0, end: 1_000 }]);
    const paragraphs = "First one.\n\nSecond one.";
    expect(readPassages({ length: 10, source: paragraphs })).toEqual([{ start: 0, end: 10 }, { start: 12, end: 23 }]);
    expect(readPassages({ length: 5, source: paragraphs })).toEqual([{ start: 0, end: 10 }]);
  });
});

describe("marksOfFree", () => {
  it("marks over the whole text the piece was cut from, then cuts: what the cut crosses ends at the cut, what lies past it goes", () => {
    const source = "Call +1 555 000 0142 or Ada";
    const marks = marksOfFree({ length: 11, source, known: [] }, WAYS, [], "all");
    expect(marks).toEqual([{ start: 5, end: 11, type: "phone" }]);
    const spaceless = `${"~".repeat(990)}person-b@example.com${"~".repeat(500)}`;
    expect(marksOfFree({ length: 1_000, source: spaceless, known: [] }, WAYS, [], "all")).toEqual([{ start: 990, end: 1_000, type: "email" }]);
  });

  it("hides a detail the level hides inside one it leaves, as the inner's type over the outer, with no who", () => {
    const free = whole("Reset https://example.com/r?token=8f3k2q9xw7v1 or https://wa.me/send?to=15550000001");
    const level: Level = ["secret", "phone", "word"];
    expect(shown(free, marksOfFree(free, WAYS, [], level))).toEqual(["secret:token=8f3k2q9xw7v1", "phone:to=15550000001"]);
    expect(marksOfFree(free, WAYS, [], level).every((mark) => mark.who === undefined)).toBe(true);
    expect(shown(free, marksOfFree(free, WAYS, [], "all"))).toEqual(["link:token=8f3k2q9xw7v1", "link:to=15550000001"]);
  });

  it("drops a business stated as a person, a never word, and marks an always word", () => {
    const free = whole("Example Shop and Lifestream run Falcon for Ada", [{ start: 0, end: 12, type: "person", who: "b-shop" }, { start: 17, end: 27, type: "person" }]);
    expect(shown(free, marksOfFree(free, WAYS, [], "all"))).toEqual(["word:Falcon", "person:Ada"]);
  });

  it("takes the name table's marks of the source its caller read once, and reads none itself", () => {
    const free = whole("Ada met Qorvex");
    const read = WAYS.names.marks(free.source);
    const once: Ways = { ...WAYS, names: { ...WAYS.names, marks: () => { throw new Error("the source read twice"); } } };
    expect(shown(free, marksOfFree(free, once, [], "all", read))).toEqual(["person:Ada"]);
    expect(shown(free, marksOfFree(free, once, [], "all", [...read, { start: 8, end: 14, type: "person" }]))).toEqual(["person:Ada", "person:Qorvex"]);
  });

  it("places a detector's mark at its passage's start in the source", () => {
    const free = whole("Nothing here.\n\nRosalind wrote.");
    expect(shown(free, marksOfFree(free, WAYS, [{ start: 15, marks: [{ start: 0, end: 8, type: "person" }] }], "all"))).toEqual(["person:Rosalind"]);
  });

  it("keeps the type the level hides of two detector marks over one word, whichever was longer", () => {
    const free = whole("Log in as Rosalind2603 now.");
    const detected = [{ start: 0, marks: [{ start: 10, end: 22, type: "person" as const }, { start: 10, end: 22, type: "secret" as const }] }];
    expect(shown(free, marksOfFree(free, WAYS, detected, "names"))).toEqual(["secret:Rosalind2603"]);
    expect(shown(free, marksOfFree(free, WAYS, detected, ["person"]))).toEqual(["person:Rosalind2603"]);
  });

  it("reads a picture's lines across their breaks for the rules, and never a text's", () => {
    const source = "Seats 2345 6789\n0124 left";
    expect(shown({ length: source.length, source, known: [], lines: true }, marksOfFree({ length: source.length, source, known: [], lines: true }, WAYS, [], "all"))).toEqual(["number.government:2345 6789\n0124"]);
    expect(marksOfFree({ length: source.length, source, known: [] }, WAYS, [], "all")).toEqual([]);
  });
});
