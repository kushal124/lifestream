import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { notesFamily, type Meeting, type Note } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const NOTES = notesFamily(FED.notes);
const ACCOUNT = "person-a@example.com";
const SOURCE = `granola:${ACCOUNT}:macbook-pro-0001`;
const at = (local: string) => Date.parse(`${local}-04:00`);

function meeting(key: string, said: Partial<Meeting> & Pick<Meeting, "start_ms" | "end_ms">): Content {
  const content: Meeting = { product: "granola", source: SOURCE, key, title: key, people: ["Person B", "Person C"], ...said };
  return { unit: `granola:${ACCOUNT}/${key}`, content, start_ms: content.start_ms, end_ms: content.end_ms };
}

const NOTE: Note = {
  source: `apple-notes:${ACCOUNT}:macbook-pro-0001`, key: "n1", title: "Groceries", locked: false, trashed: false,
  start_ms: at("2026-10-25T10:00"), end_ms: null, excerpt: "Milk", words: 2,
};
const RECORD: Content[] = [
  meeting("review", { start_ms: at("2026-10-25T09:00"), end_ms: at("2026-10-25T09:33") }),
  meeting("late", { start_ms: at("2026-10-25T03:30"), end_ms: at("2026-10-25T04:30") }),
  meeting("open", { start_ms: at("2026-10-25T15:00"), end_ms: null }),
  { unit: `apple-notes:${ACCOUNT}/n1`, content: NOTE, start_ms: NOTE.start_ms, end_ms: null },
];
const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(NOTES, day, contents, SETTINGS);
const facts = (day: string, contents?: readonly Content[]) => NOTES.day(input(day, contents)).facts;

describe("notes facts", () => {
  it("a meeting states one fact, its id its unit whichever copy is shown, and a note none", () => {
    const moved = meeting("review", { source: `granola:${ACCOUNT}:mac-mini`, start_ms: at("2026-10-25T09:00"), end_ms: at("2026-10-25T09:40"), title: "Review, renamed" });
    const review = facts("2026-10-25").find((fact) => fact.keys["title"] === "review")!;
    expect(facts("2026-10-25", [moved])[0]!.id).toBe(review.id);
    expect(facts("2026-10-25").map((fact) => fact.keys["title"]).sort()).toEqual(["open", "review"]);
    expect([review.measures, review.who]).toEqual([{ minutes: 33 }, []]);
  });

  it("a meeting's recorded minutes stay whole on the day it began; one with no end states none", () => {
    expect(facts("2026-10-24").map((fact) => [fact.keys["title"], fact.measures])).toEqual([["late", { minutes: 60 }]]);
    expect(facts("2026-10-25").find((fact) => fact.keys["title"] === "open")!.measures).toEqual({});
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(NOTES, ["2026-10-24", "2026-10-25"].map((day) => input(day)))).toEqual([]);
    const earlier = meeting("early", { start_ms: at("2026-10-25T08:00"), end_ms: at("2026-10-25T08:15") });
    expect(insertKeepsFacts(NOTES, input("2026-10-25"), input("2026-10-25", [earlier, ...RECORD]))).toEqual([]);
  });
});
