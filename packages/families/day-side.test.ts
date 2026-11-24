import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { episodes, type EpisodesExtras, type EpisodesFile } from "./day-episodes.js";
import { dayPage } from "./day-page.js";
import { daySide, NO_SIDE, type DaySide, type DaySideExtras, type WherePiece } from "./day-side.js";
import type { DayAtom } from "./days.js";

const TEST = join(dirname(fileURLToPath(import.meta.url)), "test");
const HOUR = 3600_000;
const MINUTE = 60_000;
const WEEK = 7 * 24 * HOUR;
const CLOCK = /\b\d{1,2}:\d{2}\b|\b(?:today|tomorrow|yesterday|since|ago)\b/iu;

const read = (path: string): unknown => JSON.parse(readFileSync(join(TEST, path), "utf8"));
const { sources } = read("day-page/sources.json") as { sources: NonNullable<EpisodesExtras["sources"]> };

function inputsOf(day: string, change: (atom: DayAtom) => DayAtom = (atom) => atom): { file: EpisodesFile; extras: EpisodesExtras & DaySideExtras } {
  const { sleep, sent, groups, products, ...file } = read(`day-page/${day}.day.json`) as EpisodesFile & EpisodesExtras;
  const side = existsSync(join(TEST, "day-side", `${day}.json`)) ? read(`day-side/${day}.json`) as DaySideExtras : NO_SIDE;
  return {
    file: { ...file, atoms: file.atoms.map(change) },
    extras: { ...sleep && { sleep }, ...sent && { sent }, ...groups && { groups }, ...products && { products }, sources, ...side },
  };
}

function sideOf(day: string, now: number | null = null, change?: (atom: DayAtom) => DayAtom): DaySide {
  const { file, extras } = inputsOf(day, change);
  return daySide(file, extras, episodes(file, extras, now), now);
}

const wrote = (ns: number[]) => (atom: DayAtom): DayAtom => ns.includes(atom.n) ? { ...atom, text: atom.text.replace(/^[^:]*:/u, "the user:") } : atom;

function strings(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((each, at) => strings(each, `${path}[${at}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, each]) => strings(each, `${path}.${key}`));
  return [];
}

describe("a day's side", () => {
  it("groups come most written first, ties by name, then the quiet ones by how many wrote to you", () => {
    const groups = sideOf("2031-05-20", null, wrote([26, 27, 51])).groups;
    expect(groups.map((group) => [group.title, group.runs[0]?.value])).toEqual([["Group Beta", "3"], ["Group Alpha", "1"]]);
    const tied = sideOf("2031-05-20", null, wrote([26, 52])).groups;
    expect(tied.map((group) => [group.title, group.runs[0]?.value])).toEqual([["Group Alpha", "1"], ["Group Beta", "1"]]);
    const day = sideOf("2031-03-04").groups;
    expect(day.map((group) => [group.title, group.quiet])).toEqual([["Group Alpha", false], ["Group Gamma", true]]);
    expect(day[1]?.runs).toEqual([{ glyph: "message", value: "4", quiet: true }]);
  });

  it("a quiet line whose chat also wrote stands once, as the written group", () => {
    const groups = sideOf("2031-03-04", null, (atom) => atom.n === 78
      ? { ...atom, text: "Group Alpha · 4 messages", block: { key: "whatsapp:120363000000000001@g.us", title: "You were quiet in" } } : atom).groups;
    expect(groups.map((group) => [group.chat, group.quiet])).toEqual([["whatsapp:120363000000000001@g.us", false]]);
  });

  it("a call with no party is left out of the people and is never unreturned (Days 8)", () => {
    const side = sideOf("2031-04-05");
    expect(side.people.map((person) => person.name)).toEqual(["Person D"]);
    expect(side.people.flatMap((person) => person.rows)).not.toContain("e12");
    expect(side.unreturned).toEqual([]);
  });

  it("a missed call is unreturned until a later call with the same party connects, and its row says so", () => {
    const side = sideOf("2031-03-04");
    expect(side.unreturned).toEqual([{ key: "e52", at_ms: 1930366680000, person: "person-a", name: "Person A" }]);
    const caller = side.people.find((person) => person.key === "call:+15550000006");
    expect(caller?.runs).toEqual([{ glyph: "call", value: "2m", quiet: false }]);
    const personA = side.people.find((person) => person.person === "person-a");
    expect(personA?.runs.map((run) => run.glyph)).toEqual(["message", "call", "call-missed"]);
    const { file, extras } = inputsOf("2031-03-04");
    const rows = dayPage(file, extras, null).chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows));
    const marked = rows.filter((row) => row.words.some((run) => run.type === "text" && run.text === "not returned yet")).map((row) => row.key);
    expect(marked).toEqual(["e52"]);
  });

  it("a place's hours are its pieces clipped to the day, and to now on today (Days 10)", () => {
    const { file, extras } = inputsOf("2031-03-04");
    const clipped = (end: number): number => extras.where
      .filter((piece) => piece.place?.slug === "synthetic-home")
      .reduce((sum, piece) => sum + Math.max(0, Math.min(piece.end_ms, end) - Math.max(piece.start_ms, file.window.start_ms)), 0);
    const home = sideOf("2031-03-04").places.find((place) => place.slug === "synthetic-home");
    expect(home?.ms).toBe(clipped(file.window.end_ms));
    expect(home?.ms).toBeLessThan(extras.where.filter((piece) => piece.place?.slug === "synthetic-home").reduce((sum, piece) => sum + piece.end_ms - piece.start_ms, 0));
    for (const day of ["2031-03-04", "2031-05-20", "2031-06-12"]) {
      const length = inputsOf(day).file.window;
      for (const place of sideOf(day).places) expect(place.ms, `${day} ${place.name}`).toBeLessThanOrEqual(length.end_ms - length.start_ms);
    }
    const now = file.window.start_ms + 4 * HOUR + 15 * 60_000;
    const today = sideOf("2031-03-04", now).places;
    expect(today.map((place) => [place.name, place.ms])).toEqual([["Synthetic Home", clipped(now)]]);
  });

  it("a piece the home has no name for, from a label, a stay or its area, is left out", () => {
    const places = sideOf("2031-03-04").places;
    expect(places.map((place) => place.key)).not.toContain("spot:10.0301,20.0301");
    expect(places.map((place) => place.name)).toEqual(["Synthetic Home", "Synthetic Office", "Synthetic Cafe", "Synthetic City", "Synthetic Port Town"]);
    expect(places.find((place) => place.slug === "synthetic-home")?.home).toBe(true);
    expect(sideOf("2031-06-12").places.map((place) => place.name)).not.toContain("a hidden place");
  });

  it("a place carries its known place's radius, for a map of one stay; a spot and a place with no radius carry none", () => {
    const places = sideOf("2031-03-04").places;
    expect(places.map((place) => [place.name, place.radius_m])).toEqual([
      ["Synthetic Home", 80], ["Synthetic Office", null], ["Synthetic Cafe", null], ["Synthetic City", null], ["Synthetic Port Town", null],
    ]);
  });

  it("a head at an instant holds the piece that holds the instant, never one that ends as it starts: its place and its Name it", () => {
    const near = (atom: DayAtom): DayAtom => atom.n === 3 ? { ...atom, end_ms: atom.start_ms } : atom;
    const { file, extras } = inputsOf("2031-06-12", near);
    const stay = file.atoms.find((atom) => atom.n === 3)!;
    const at = stay.start_ms as number;
    const piece = (start_ms: number, end_ms: number): WherePiece => ({ kind: "stay", start_ms, end_ms, point: { latitude: 1, longitude: 2 }, units: [stay.unit],
      names: { point: { words: "an unnamed place 1 km from Home" } }, place: null, spot: "spot:1,2" });
    const read = (where: WherePiece[]) => {
      const page = dayPage(file, { ...extras, where }, null);
      return { places: page.side.places.map((place) => [place.name, place.ms]), spots: page.chapters.flatMap((chapter) => chapter.head?.place ? [[chapter.head.title, chapter.head.place]] : []) };
    };
    expect(read([piece(at, at + 30 * MINUTE)])).toEqual({ places: [["Near Synthetic Home", 30 * MINUTE]], spots: [["Near Synthetic Home", "spot:1,2"]] });
    expect(read([piece(at - 10 * MINUTE, at)])).toEqual({ places: [["an unnamed place 1 km from Home", 10 * MINUTE]], spots: [] });
  });

  it("two heads share a piece: each has it as its own, each its Name it; the places count it once, under the first", () => {
    const { file: first } = inputsOf("2031-06-12");
    const unit = first.atoms.find((atom) => atom.n === 3)!.unit;
    const { file, extras } = inputsOf("2031-06-12", (atom) => atom.n === 9 ? { ...atom, unit } : atom);
    const [from, to] = [file.atoms.find((atom) => atom.n === 3)!.start_ms as number, file.atoms.find((atom) => atom.n === 9)!.end_ms as number];
    const where: WherePiece[] = [{ kind: "stay", start_ms: from, end_ms: to, point: { latitude: 1, longitude: 2 }, units: [unit],
      names: { point: { words: "an unnamed place" } }, place: null, spot: "spot:1,2" }];
    const page = dayPage(file, { ...extras, where }, null);
    expect(page.chapters.flatMap((chapter) => chapter.head?.place ? [[chapter.head.title, chapter.head.place]] : []))
      .toEqual([["Near Synthetic Home", "spot:1,2"], ["Synthetic Port Town", "spot:1,2"]]);
    expect(page.side.places.map((place) => [place.name, place.ms])).toEqual([["Near Synthetic Home", to - from]]);
  });

  it("the lists are whole: how many to show is the app's", () => {
    const side = sideOf("2031-05-20");
    expect(side.people).toHaveLength(18);
    expect(sideOf("2031-03-04").figures.map((figure) => figure.key)).toEqual(["asleep", "steps", "recovery", "sent", "received"]);
  });

  it("no words member holds a time, and a past day's side reads the same a week apart", () => {
    for (const day of ["2031-03-04", "2031-04-05", "2031-05-20", "2031-06-12", "2031-07-01"]) {
      const { file, extras } = inputsOf(day);
      const later = dayPage(file, extras, file.window.end_ms + WEEK).side;
      expect(dayPage(file, extras, file.window.end_ms + 2 * WEEK).side, day).toEqual(later);
      expect(strings(later).filter(([, text]) => CLOCK.test(text)), day).toEqual([]);
    }
  });
});
