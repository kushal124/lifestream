import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { ScreenIndex, readScreen, type ScreenFrame, type ScreenSegment } from "./screen-index.js";
import { addDays, civilDay, openHomeFolder, render, type DaySettings } from "@lifestreamprotocol/core";
import { productWindows } from "./screen-keys.js";
import { ARGUMENTS_BYTES, CursorError, GIVEN_MOST, NEXT_CHARS } from "./cursor-text.js";
import { rowsCounted } from "./work.js";
import { CURSOR_CHARS, cursorOf, cursorText, excerptOf, gaveToo, PAGE_HITS, search, TOP, windowOf, type ScreenCursor, type ScreenHit, type ScreenPage, type ScreenSearch, type ScreenWindow } from "./screen-query.js";


const DAYS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const MIN = 60_000;
const SEG = 5 * MIN;
const DAY = 86_400_000;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-screen-query-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;

interface Window {
  from: number;
  to: number;
  app: string;
  site?: string | null;
  title: string | null;
  lines: string[];
  display?: string;
  every?: number;
}

function segments(machine: string, windows: Window[]): ScreenSegment[] {
  const frames: ScreenFrame[] = [];
  for (const window of windows) {
    for (let t = window.from; t < window.to; t += window.every ?? 2_000) {
      frames.push({ t, app: window.app, site: window.site ?? null, title: window.title, display: window.display ?? "1", lines: window.lines });
    }
  }
  const bySeg = new Map<number, ScreenFrame[]>();
  for (const frame of frames) {
    const start = Math.floor(frame.t / SEG) * SEG;
    bySeg.set(start, [...(bySeg.get(start) ?? []), frame]);
  }
  return [...bySeg].sort((left, right) => left[0] - right[0])
    .map(([start, list]) => ({ machine, version: "v1", start_ms: start, frames: list.sort((left, right) => left.t - right.t) }));
}

function indexOf(all: ScreenSegment[]): Database.Database {
  return readScreen(openHomeFolder(dirname(written(all))), written(all))!;
}

function written(all: ScreenSegment[]): string {
  const file = join(scratch, `f${++files}`, "screen.db");
  ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, () => true).finish();
  const index = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, () => true);
  const source = { segments: (machine: string, day: string) => all.filter((segment) => segment.machine === machine && civilDay(segment.start_ms, DAYS) === day) };
  index.apply(all, source);
  index.close();
  return file;
}

function rekeyed(all: ScreenSegment[], keyAt: (place: number, name: string) => bigint): Database.Database {
  const file = written(all);
  const db = new Database(file);
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('screen_row', 'screen_block', 'screen_unit')").pluck().all() as string[]);
  expect(tables).toContain("screen_row");
  db.transaction(() => {
    const keys = db.prepare("SELECT id, name FROM screen_key ORDER BY id").safeIntegers(true).all() as { id: bigint; name: string }[];
    const aside = 2n ** 40n;
    for (const table of tables) db.prepare(`UPDATE ${table} SET key = key + ?`).run(aside);
    db.prepare("UPDATE screen_key SET id = id + ?").run(aside);
    keys.forEach(({ id, name }, place) => {
      for (const table of tables) db.prepare(`UPDATE ${table} SET key = ? WHERE key = ?`).run(keyAt(place, name), id + aside);
      db.prepare("UPDATE screen_key SET id = ? WHERE id = ?").run(keyAt(place, name), id + aside);
    });
  })();
  db.close();
  return readScreen(openHomeFolder(dirname(file)), file)!;
}

const SQLITE_LEAST = -(2n ** 63n);
const SQLITE_MOST = 2n ** 63n - 1n;
const EDGES = [0n, -1n, 2n ** 32n - 1n, 2n ** 32n, 2n ** 32n + 1n, 2n ** 53n - 1n, 2n ** 53n, 2n ** 53n + 1n, SQLITE_MOST, SQLITE_MOST - 1n, SQLITE_LEAST, SQLITE_LEAST + 1n];
const byKey = (one: ScreenWindow, other: ScreenWindow) => (one.key < other.key ? -1 : one.key > other.key ? 1 : one.day < other.day ? -1 : one.day > other.day ? 1 : 0);

const NOW = T0 + DAY;
const words = (n: number) => Array.from({ length: n }, (_, i) => `filler${i % 7}`).join(" ");
const post = (middle: string) => `Example post opening words ${middle} and then more words follow here.`;

describe("screen query", () => {
  it("ranks words that sit together above words hours apart, and keeps only covered windows (Q1, Q2, Q6)", () => {
    const db = indexOf([
      ...segments("mac-0001", [
        { from: T0, to: T0 + 4 * MIN, app: "Example Browser", site: "example.com", title: "Example Page — Site", lines: [post("cobalt lantern harbor"), words(5)] },
        { from: T0 + 4 * MIN, to: T0 + 5 * MIN, app: "Example Browser", site: "example.org", title: "Spread Page — Site", lines: ["cobalt note", words(4)] },
        { from: T0 + 4 * 60 * MIN, to: T0 + 4 * 60 * MIN + MIN, app: "Example Browser", site: "example.org", title: "Spread Page — Site", lines: ["lantern note", words(3)] },
        { from: T0 + 8 * 60 * MIN, to: T0 + 8 * 60 * MIN + MIN, app: "Example Browser", site: "example.org", title: "Spread Page — Site", lines: ["harbor note"] },
        { from: T0 + 9 * 60 * MIN, to: T0 + 9 * 60 * MIN + MIN, app: "Example Browser", site: "example.net", title: "Harbor Only — Site", lines: ["harbor alone here", words(6)] },
      ]),
    ]);
    const answer = pageOf(db, "cobalt lantern harbor");
    expect(answer.hits.map(windowOf)).toEqual(["Example Page — Site", "Spread Page — Site"]);
    expect(answer.hits.every((hit) => hit.reason === "words")).toBe(true);
    expect(answer.hits[0]!.excerpt).toBe("Example post opening words «cobalt» «lantern» «harbor» and then more words follow here.");
    const partial = pageOf(db, "cobalt qqq zzz");
    expect(partial.hits.map((hit) => [windowOf(hit), hit.reason]).sort()).toEqual([
      ["Example Page — Site", "partial"],
      ["Spread Page — Site", "partial"],
    ]);
    db.close();
  });

  it("folds windows of one app showing the same lines into one result, never another app's (Q3)", () => {
    const shared = post("saffronite meadow");
    const db = indexOf(segments("mac-0001", [
      { from: T0, to: T0 + MIN, app: "Example Browser", site: "example.com", title: "Thread One — Site", lines: [shared, words(3)] },
      { from: T0 + MIN, to: T0 + 2 * MIN, app: "Example Browser", site: "example.com", title: "Thread Two — Site", lines: [shared] },
      { from: T0 + 2 * MIN, to: T0 + 3 * MIN, app: "Other Browser", site: "example.com", title: "Thread One — Site", lines: [shared] },
      { from: T0 + 3 * MIN, to: T0 + 4 * MIN, app: "Example Browser", site: "example.com", title: "Thread Three — Site", lines: [post("saffronite elsewhere")] },
    ]));
    const answer = pageOf(db, "saffronite");
    expect(answer.hits).toHaveLength(3);
    const folded = answer.hits.find((hit) => hit.also.length > 0)!;
    expect(folded.app).toBe("Example Browser");
    expect([windowOf(folded), ...folded.also.map(windowOf)].sort()).toEqual(["Thread One — Site", "Thread Two — Site"]);
    expect(answer.hits.filter((hit) => hit.also.length === 0).map(windowOf).sort()).toEqual(["Thread One — Site", "Thread Three — Site"]);
    db.close();
  });

  it("covers a date filter whole, and with none every day back to the file's first (Q4)", () => {
    const old = T0 - 40 * DAY;
    const edge = NOW - 31 * DAY;
    const db = indexOf(segments("mac-0001", [
      { from: old, to: old + MIN, app: "Notes", title: "Glacier Old", lines: ["glacier forty days back"] },
      { from: edge - SEG, to: edge - SEG + MIN, app: "Notes", title: "Glacier Edge Out", lines: ["glacier just outside"] },
      { from: edge, to: edge + MIN, app: "Notes", title: "Glacier Edge In", lines: ["glacier just inside"] },
      { from: T0 - 10 * DAY, to: T0 - 10 * DAY + MIN, app: "Notes", title: "Glacier Recent", lines: ["glacier ten days back"] },
    ]));
    expect(pageOf(db, "glacier").hits.map(windowOf).sort()).toEqual(["Glacier Edge In", "Glacier Edge Out", "Glacier Old", "Glacier Recent"]);
    const filtered = pageOf(db, "glacier", undefined, { from_ms: old - DAY, to_ms: old + DAY });
    expect(filtered.hits.map(windowOf)).toEqual(["Glacier Old"]);
    db.close();
  });

  it("finds the minute from a block in front, else the line, else states the range (Q5)", () => {
    const db = indexOf(segments("mac-0001", [
      { from: T0, to: T0 + MIN, app: "Example Browser", site: "example.com", title: "Other — Site", lines: [words(2)] },
      { from: T0, to: T0 + MIN, app: "Reader", title: "Side Window", display: "2", lines: [post("quillwort marsh")] },
      { from: T0 + 2 * MIN, to: T0 + 3 * MIN, app: "Example Browser", site: "example.com", title: "Bog Page — Site", lines: [words(1)] },
      { from: T0 + 3 * MIN, to: T0 + 4 * MIN, app: "Example Browser", site: "example.com", title: "Bog Page — Site", lines: [words(1), post("quillwort marsh")] },
      { from: T0 + 6 * MIN, to: T0 + 7 * MIN, app: "Example Browser", site: "example.com", title: "Short Lines — Site", lines: ["intro", words(2)] },
      { from: T0 + 7 * MIN + 30_000, to: T0 + 8 * MIN, app: "Example Browser", site: "example.com", title: "Short Lines — Site", lines: ["intro", words(2), "a bogbean here"] },
      { from: T0 + 9 * MIN, to: T0 + 10 * MIN, app: "Example Browser", site: "example.com", title: "Sundew Title — Site", lines: [words(2)] },
    ]));
    const line = pageOf(db, "bogbean").hits[0]!;
    expect([line.at_ms, line.until_ms]).toEqual([T0 + 7 * MIN + 30_000, null]);
    expect(line.evidence).toMatch(/^row:/u);
    expect(line.excerpt).toBe("a «bogbean» here");
    const page = pageOf(db, "quillwort");
    const bog = page.hits.find((hit) => hit.name === "Bog Page — Site")!;
    expect(bog).toMatchObject({ machine: "mac-0001", app: "Example Browser", site: "example.com", day: "2026-11-02", at_ms: T0 + 3 * MIN, until_ms: null, reason: "words" });
    expect(bog.evidence).toMatch(/^block:/u);
    expect(page.seq).toBe(0);
    for (const gone of ["ref", "time", "runs", "rank", "window", "time_precision"]) expect(bog).not.toHaveProperty(gone);
    const spanned = pageOf(db, "sundew").hits[0]!;
    expect([spanned.at_ms, spanned.excerpt]).toEqual([T0 + 9 * MIN, "«Sundew» Title — Site"]);
    expect(render(spanned.until_ms!, "UTC", "minute")).toBe("2026-11-02 06:10");
    db.close();
  });

  it("helps a misspelt word and labels it, drops fillers, reads an alias as a site (Q7, Q8)", () => {
    const db = indexOf(segments("mac-0001", [
      { from: T0, to: T0 + MIN, app: "Example Browser", site: "example.com", title: "Lantern Page — Site", lines: ["lantern shop prices"] },
      { from: T0 + MIN, to: T0 + 2 * MIN, app: "Example Browser", site: "youtube.com", title: "Lantern Making Talk - YouTube", lines: ["lantern making"] },
      { from: T0 + 2 * MIN, to: T0 + 3 * MIN, app: "Example Browser", site: "example.com", title: "Split — Site", lines: ["a nightjar call"] },
    ]));
    const typo = pageOf(db, "lantren").hits;
    expect(typo.map((hit) => hit.reason)).toEqual(["spelling", "spelling"]);
    expect(typo[0]!.excerpt).toContain("«");
    expect(pageOf(db, "night jar").hits).toHaveLength(0);
    expect(pageOf(db, "nightjr").hits.map(windowOf)).toEqual(["Split — Site"]);
    const filler = search(db, { q: "what was that lantern thing", now_ms: NOW });
    expect(filler.read_as.without).toEqual(["what", "was", "that", "thing"]);
    expect(filler.applied_filter.terms.map((term) => term.word)).toEqual(["lantern"]);
    expect(search(db, { q: "the lantern", now_ms: NOW }).read_as.without).toEqual([]);
    const video = pageOf(db, "lantern video");
    expect(video.applied_filter.sites).toContain("youtube.com");
    expect(video.hits.map(windowOf)).toEqual(["Lantern Making Talk - YouTube"]);
    db.close();
  });

  it("marks words and phrases in an excerpt, cut around the first", () => {
    expect(excerptOf("Ünïcode Wörds and words", [{ forms: [["words"]] }])).toBe("Ünïcode «Wörds» and «words»");
    expect(excerptOf("a night jar sings", [{ forms: [["night", "jar"]] }])).toBe("a «night jar» sings");
    const long = `${"x ".repeat(200)}target ${"y ".repeat(200)}`;
    const cut = excerptOf(long, [{ forms: [["target"]] }]);
    expect(cut).toMatch(/^….*«target».*…$/u);
    expect(cut.length).toBeLessThanOrEqual(204);
  });
});


function fileOf(all: ScreenSegment[]): string {
  const file = join(scratch, `f${++files}`, "screen.db");
  ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, () => true).finish();
  grow(file, all, all);
  return file;
}

function grow(file: string, all: ScreenSegment[], added: ScreenSegment[]): void {
  const index = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, () => true);
  index.apply(added, { segments: (machine: string, day: string) => all.filter((segment) => segment.machine === machine && civilDay(segment.start_ms, DAYS) === day) });
  index.close();
}

const one = (title: string, at: number, lines: string[], app = "Example Browser"): Window => ({ from: at, to: at + 1, app, site: app === "Example Browser" ? "example.com" : null, title, lines });

function pageOf(db: Database.Database, q: string, cursor?: ScreenCursor, more: Partial<ScreenSearch> = {}): ScreenPage {
  return search(db, { q, now_ms: NOW, ...more, ...(cursor === undefined ? {} : { cursor: cursorOf(cursorText(cursor)) }) });
}

function pagesOf(db: Database.Database, q: string, more: Partial<ScreenSearch> = {}): ScreenPage[] {
  const out = [pageOf(db, q, undefined, more)];
  while (out.at(-1)!.next !== undefined) {
    expect(out.length).toBeLessThan(200);
    out.push(pageOf(db, q, out.at(-1)!.next, more));
  }
  return out;
}

const givenBy = (page: ScreenPage) => page.hits.flatMap((hit) => [`${windowOf(hit)}@${hit.day}`, ...hit.also.map((other) => `${windowOf(other)}@${hit.day}`)]);

function once(pages: readonly ScreenPage[]): string[] {
  const all = pages.flatMap(givenBy);
  expect(all.length).toBe(new Set(all).size);
  return all;
}

const DAY0 = civilDay(T0, DAYS);

function pinned(): Window[] {
  const out: Window[] = [];
  for (let i = 0; i < 56; i++) {
    const day = i % 8;
    const at = T0 - day * DAY + Math.floor(i / 8) * 15 * MIN + i * 1_000;
    const app = i % 5 === 0 ? "Notes" : "Example Browser";
    const site = app === "Notes" ? null : "example.com";
    const one = (from: number, lines: string[]): Window => ({ from, to: from + 1, app, site, title: `Pinned ${i}`, lines });
    const pad = words(1 + (i % 6));
    if (i % 4 === 0) out.push(one(at, [`${"amber ".repeat(1 + (i % 3))}quartz meadow ${pad}`]));
    if (i % 4 === 1) out.push(one(at, [`amber note ${pad}`]), one(at + 127 * MIN + (i % 6) * 37 * MIN, [`quartz meadow note ${pad}`]));
    if (i % 4 === 2) out.push(one(at, [`amber quartz ${pad}`]));
    if (i % 4 === 3) out.push(one(at, [`meadow quartz amber shared line ${day}`, pad]));
  }
  return out;
}

const PINNED_FORTY = [["Pinned 12", ["Pinned 36"]], ["Pinned 0", []], ["Pinned 24", ["Pinned 48"]], ["Pinned 20", []], ["Pinned 44", []], ["Pinned 8", ["Pinned 32"]], ["Pinned 4", ["Pinned 28", "Pinned 52"]], ["Pinned 16", []], ["Pinned 40", []], ["Pinned 7", ["Pinned 31", "Pinned 39"]], ["Pinned 55", ["Pinned 15"]], ["Pinned 19", ["Pinned 43", "Pinned 3", "Pinned 27", "Pinned 51"]], ["Pinned 6", []], ["Pinned 30", []], ["Pinned 13", ["Pinned 37"]], ["Pinned 1", ["Pinned 49"]], ["Pinned 25", []], ["Pinned 21", []], ["Pinned 45", []], ["Pinned 9", ["Pinned 33"]], ["Pinned 5", []], ["Pinned 29", ["Pinned 53"]], ["Pinned 17", ["Pinned 41"]]];

function terns(n: number, shared: (i: number) => boolean = () => false, app = "Example Browser"): Window[] {
  return Array.from({ length: n }, (_, k) => {
    const i = k + 1;
    const lines = i <= TOP ? [`tern tern tern tern tern heavy${i}`] : [shared(i) ? `tern ${words(4)} shared` : `tern ${words(4)} solo${i}`];
    return one(`Tern ${i}`, T0 + i * MIN, lines, app);
  });
}

describe("screen search, a stretch page by page", () => {
  it("reads phrases, OR and -word, and the last word as typed (S1)", () => {
    const db = indexOf(segments("mac-0001", [
      one("Phrase Together", T0, ["the window seat was taken"]),
      one("Phrase Apart", T0 + MIN, ["a window by the seat"]),
      one("Refund", T0 + 2 * MIN, ["refund issued today"]),
      one("Credit", T0 + 3 * MIN, ["credit applied today"]),
      one("Booking A", T0 - DAY, ["booking confirmed"]),
      one("Booking A", T0 + 4 * MIN, ["booking confirmed"]),
      one("Booking A", T0 + 180 * MIN, ["booking cancelled"]),
      one("Booking B", T0 + 5 * MIN, ["booking confirmed"]),
      one("Lantern", T0 + 6 * MIN, ["lantern shop"]),
    ]));
    const hits = (q: string) => pageOf(db, q).hits.map((hit) => `${windowOf(hit)}@${hit.day}`).sort();
    expect(hits('"window seat"')).toEqual([`Phrase Together@${DAY0}`]);
    expect(hits("window seat")).toEqual([`Phrase Apart@${DAY0}`, `Phrase Together@${DAY0}`]);
    const either = pageOf(db, "refund OR credit");
    expect(either.hits.map((hit) => [windowOf(hit), hit.reason]).sort()).toEqual([["Credit", "words"], ["Refund", "words"]]);
    expect(either.applied_filter.terms.map((term) => term.word)).toEqual(["refund OR credit"]);
    expect(hits("booking -cancelled")).toEqual([`Booking A@${addDays(DAY0, -1)}`, `Booking B@${DAY0}`]);
    expect(pageOf(db, "booking").total).toBe(3);
    expect(hits("lant")).toEqual([]);
    db.close();
  });

  it("holds a phrase within one line or the window's name, never across two lines (S1)", () => {
    const db = indexOf(segments("mac-0001", [
      one("Across Lines", T0, ["we looked through the window", "seat booking confirmation"]),
      one("Window Seat Map", T0 + MIN, ["rows and booking"]),
      one("Plain Booking", T0 + 2 * MIN, ["booking held"]),
    ]));
    const hits = (q: string) => pageOf(db, q).hits.map((hit) => windowOf(hit)).sort();
    expect(hits('"window seat"')).toEqual(["Window Seat Map"]);
    expect(pageOf(db, '"window seat"').total).toBe(1);
    expect(hits("window.seat")).toEqual(["Window Seat Map"]);
    expect(hits('"window seat" OR looked')).toEqual(["Across Lines", "Window Seat Map"]);
    expect(hits('booking -"window seat"')).toEqual(["Across Lines", "Plain Booking"]);
    expect(hits("window seat")).toEqual(["Across Lines", "Window Seat Map"]);
    for (const hit of pageOf(db, '"window seat"', undefined, { evidence: true }).hits) {
      expect(hit.terms!.every((term) => term.lines.length > 0 || windowOf(hit).toLowerCase().includes(term.word))).toBe(true);
    }
    db.close();
  });

  it("gives the forty as the engine before the stretch gave them, window for window (S2)", () => {
    const db = indexOf(segments("mac-0001", pinned()));
    const pin = (hits: readonly ScreenHit[]) => hits.map((hit) => [windowOf(hit), hit.also.map(windowOf)]);
    const pages = pagesOf(db, "amber quartz meadow");
    expect(pin(pages.flatMap((page) => page.hits).slice(0, PINNED_FORTY.length))).toEqual(PINNED_FORTY);
    expect(once(pages)).toHaveLength(pages[0]!.total);
    expect(pages[0]!.total).toBeGreaterThan(TOP);
    db.close();
  });

  it("gives each window past the forty once, ten hits a page, siblings past it folded into one (S3)", () => {
    const alone = indexOf(segments("mac-0001", terns(61)));
    const pages = pagesOf(alone, "tern");
    expect(pages.map((page) => page.hits.length)).toEqual([10, 10, 10, 10, 10, 10, 1]);
    expect(pages.slice(0, 4).flatMap(givenBy).sort()).toEqual(Array.from({ length: 40 }, (_, k) => `Tern ${k + 1}@${DAY0}`).sort());
    expect(pages.slice(4).flatMap(givenBy).sort()).toEqual(Array.from({ length: 21 }, (_, k) => `Tern ${k + 41}@${DAY0}`).sort());
    expect(once(pages)).toHaveLength(61);
    expect(pages.every((page) => page.total === 61 && page.order === undefined)).toBe(true);
    expect(pages.slice(0, -1).every((page) => page.capped && page.next !== undefined)).toBe(true);
    expect(pages.at(-1)!.capped).toBe(false);
    alone.close();

    const folded = indexOf(segments("mac-0001", terns(61, (i) => i >= 41 && i <= 50)));
    const fold = pagesOf(folded, "tern");
    expect(fold.map((page) => page.hits.length)).toEqual([10, 10, 10, 10, 10, 2]);
    expect(fold[4]!.hits.map((hit) => hit.also.length)).toEqual([9, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(windowOf(fold[4]!.hits[0]!)).toBe("Tern 41");
    expect(fold[5]!.hits.map((hit) => windowOf(hit))).toEqual(["Tern 60", "Tern 61"]);
    expect(once(fold)).toHaveLength(61);
    folded.close();
  });

  it("gives a sibling of an earlier page's hit as a hit of its own, with a snippet (S3)", () => {
    const db = indexOf(segments("mac-0001", terns(51, (i) => i >= 50)));
    const pages = pagesOf(db, "tern");
    expect(windowOf(pages[4]!.hits.at(-1)!)).toBe("Tern 50");
    expect(pages[4]!.hits.at(-1)!.also).toEqual([]);
    const sibling = pages[5]!.hits[0]!;
    expect([windowOf(sibling), sibling.also.length]).toEqual(["Tern 51", 0]);
    expect(sibling.excerpt).toContain("«tern»");
    expect(once(pages)).toHaveLength(51);
    db.close();
  });

  it("gives no window twice and leaves none out when the index takes rows between pages (S4)", () => {
    const first = Array.from({ length: 30 }, (_, k) => one(`Kestrel ${k}`, T0 + (10 + k) * MIN, [`${"kestrel ".repeat(1 + (k % 4))}note${k}`]));
    const all = segments("mac-0001", first);
    const file = fileOf(all);
    let db = readScreen(openHomeFolder(dirname(file)), file)!;
    const pages = [pageOf(db, "kestrel")];
    db.close();
    const given = new Set(givenBy(pages[0]!).map((name) => name.split("@")[0]!));
    const later = first.filter((window) => !given.has(window.title!)).slice(0, 3).map((window, k) => one(window.title!, T0 + (40 + k) * MIN, ["kestrel kestrel kestrel kestrel kestrel kestrel"]));
    const added = segments("mac-0001", [
      ...Array.from({ length: 5 }, (_, k) => one(`Kestrel new ${k}`, k < 2 ? T0 + k * MIN : T0 + (50 + k) * MIN, ["kestrel kestrel kestrel kestrel kestrel"])),
      ...later,
      one([...given][0]!, T0 + 60 * MIN, ["kestrel kestrel kestrel kestrel kestrel kestrel kestrel"]),
    ]);
    const grown = [...all, ...added];
    grow(file, grown, added);
    db = readScreen(openHomeFolder(dirname(file)), file)!;
    while (pages.at(-1)!.next !== undefined) pages.push(pageOf(db, "kestrel", pages.at(-1)!.next));
    expect(once(pages).sort()).toEqual([...first.map((window) => window.title!), ...Array.from({ length: 5 }, (_, k) => `Kestrel new ${k}`)].map((title) => `${title}@${DAY0}`).sort());
    db.close();
  });

  it("reaches every window a longer read ranks among its forty from the stretch alone; then the older days, by rank (S5, S7)", () => {
    const near = Array.from({ length: 50 }, (_, k) => one(`Heron ${k}`, T0 - (330 + (k % 25)) * DAY + k * MIN, [`${"heron ".repeat(1 + (k % 3))}near${k} ${words(k % 5)}`]));
    const far = Array.from({ length: 30 }, (_, k) => one(`Heron old ${k}`, T0 - (370 + (k % 20)) * DAY + k * MIN, [`${"heron ".repeat(2 + (k % 4))}far${k}`]));
    const db = indexOf(segments("mac-0001", [...near, ...far]));
    const longer = pagesOf(db, "heron", { from_ms: NOW - 400 * DAY, to_ms: NOW - 200 * DAY });
    expect(longer.flatMap((page) => page.hits).every((hit) => hit.also.length === 0)).toBe(true);
    const forty = longer.flatMap(givenBy).slice(0, TOP);
    const stretch = pagesOf(db, "heron");
    const first = stretch.filter((page) => page.stretch.to === stretch[0]!.stretch.to);
    expect(stretch[0]!.stretch).toEqual({ from: addDays(civilDay(NOW, DAYS), -365), to: civilDay(NOW, DAYS) });
    const inStretch = forty.filter((name) => name.split("@")[1]! >= stretch[0]!.stretch.from);
    expect(inStretch.length).toBeGreaterThan(0);
    expect(inStretch.length).toBeLessThan(TOP);
    const reached = new Set(first.flatMap(givenBy));
    expect(inStretch.filter((name) => !reached.has(name))).toEqual([]);
    expect(first.every((page) => page.reached?.whole === stretch[0]!.stretch.from)).toBe(true);
    const older = stretch.slice(first.length);
    expect(older[0]!.stretch.to).toBe(addDays(stretch[0]!.stretch.from, -1));
    expect(older.every((page) => page.order === undefined)).toBe(true);
    expect(once(stretch).sort()).toEqual([...near, ...far].map((window) => `${window.title}@${civilDay(window.from, DAYS)}`).sort());
    db.close();
  });

  it("reads at most 366 days, with dates or without, the rest by next (S7)", () => {
    const db = indexOf(segments("mac-0001", [
      one("Plover new", T0, ["plover"]),
      one("Plover 300", T0 - 300 * DAY, ["plover"]),
      one("Plover 380", T0 - 380 * DAY, ["plover"]),
    ]));
    const pages = pagesOf(db, "plover", { from_ms: NOW - 400 * DAY, to_ms: NOW });
    const windows = (list: readonly ScreenPage[]) => list.map((page) => page.hits.map((hit) => windowOf(hit)).sort());
    expect(windows(pages)).toEqual([["Plover 300", "Plover new"], ["Plover 380"]]);
    expect(pages[0]!.stretch).toEqual({ from: addDays(civilDay(NOW, DAYS), -365), to: civilDay(NOW, DAYS) });
    expect(pages[0]!.reached).toEqual({ side: "newest", whole: pages[0]!.stretch.from });
    expect(pages[1]!.stretch).toEqual({ from: civilDay(NOW - 400 * DAY, DAYS), to: addDays(pages[0]!.stretch.from, -1) });
    expect(pages[1]!.capped).toBe(false);
    const plain = pagesOf(db, "plover");
    expect(windows(plain)).toEqual([["Plover 300", "Plover new"], ["Plover 380"]]);
    expect(plain[0]!.stretch).toEqual(pages[0]!.stretch);
    expect(plain[1]!.stretch).toEqual({ from: civilDay(T0 - 380 * DAY, DAYS), to: addDays(civilDay(NOW, DAYS), -366) });
    db.close();
  });

  it("gives 400 windows by rank until the cursor holds 300, then the rest by day, newest first, then the next stretch by rank (S6)", () => {
    const windows = Array.from({ length: 400 }, (_, k) => one(`Wren ${k}`, T0 - (k % 20) * DAY + k * 10_000, [`${"wren ".repeat(1 + (k % 5))}own${k}`]));
    const db = indexOf(segments("mac-0001", [...windows, one("Wren old", T0 - 370 * DAY, ["wren"]), one("Wren older", T0 - 371 * DAY, ["wren wren"])]));
    const pages = pagesOf(db, "wren");
    expect(pages.map((page) => page.hits.length)).toEqual([...Array<number>(40).fill(10), 2]);
    const ranked = pages.slice(0, 30);
    expect(ranked.every((page) => page.order === undefined)).toBe(true);
    expect(ranked.flatMap(givenBy)).toHaveLength(GIVEN_MOST);
    const byDay = pages.slice(30, 40);
    expect(byDay.every((page) => page.order === "newest" && page.total === 400)).toBe(true);
    const days = byDay.flatMap((page) => page.hits.map((hit) => hit.day));
    expect(days).toEqual([...days].sort().reverse());
    expect(pages[40]!.order).toBeUndefined();
    expect(pages[40]!.hits.map((hit) => windowOf(hit))).toEqual(["Wren older", "Wren old"]);
    expect(once(pages)).toHaveLength(402);
    for (const page of pages) if (page.next !== undefined) expect(cursorText(page.next).length).toBeLessThan(6_000);
    db.close();
  });

  it("ends the page that fills the cursor inside a hit's siblings, and gives the rest by day (S6)", () => {
    const db = indexOf(segments("mac-0001", terns(TOP + 351, (i) => i > TOP)));
    const pages = pagesOf(db, "tern");
    expect(pages.map((page) => page.hits.length)).toEqual([10, 10, 10, 10, 1, 1]);
    expect(pages[4]!.hits[0]!.also).toHaveLength(GIVEN_MOST - TOP - 1);
    expect(pages[4]!.next!.given).toHaveLength(GIVEN_MOST);
    expect(pages[4]!.order).toBeUndefined();
    expect(pages[5]!.order).toBe("newest");
    expect(pages[5]!.hits[0]!.also).toHaveLength(TOP + 351 - GIVEN_MOST - 1);
    expect(once(pages)).toHaveLength(TOP + 351);
    db.close();
  });

  it("writes a cursor of any SQLite integer keys and reads it back exact, and reads back only its own (S6, S9)", () => {
    const newest = "2026-11-02";
    const step = (SQLITE_MOST - SQLITE_LEAST) / BigInt(GIVEN_MOST + TOP + PAGE_HITS - 2);
    const window = (k: number): ScreenWindow => ({ key: SQLITE_LEAST + BigInt(k) * step, day: addDays(newest, -(365 - (k % 3))) });
    const largest: ScreenCursor = {
      newest, oldest: addDays(newest, -365), upto_ms: Date.parse("2255-12-31T23:59:59Z"), by_day: true, place: { key: SQLITE_MOST, day: addDays(newest, -364) },
      given: [...Array.from({ length: GIVEN_MOST + TOP + PAGE_HITS - 2 }, (_, k) => window(k)), { key: SQLITE_MOST, day: newest }],
    };
    const text = cursorText(largest);
    expect(text.length).toBeGreaterThan(CURSOR_CHARS);
    const back = cursorOf(text);
    expect({ ...back, given: [...back.given].sort(byKey) }).toEqual({ ...largest, given: [...largest.given].sort(byKey) });
    const edges: ScreenCursor = { ...largest, by_day: false, given: [...EDGES, 7n].flatMap((key) => [{ key, day: newest }, { key, day: addDays(newest, -2) }]) };
    const edgesBack = cursorOf(cursorText(edges));
    expect(edgesBack.given.sort(byKey)).toEqual([...edges.given].sort(byKey));
    expect(cursorText({ ...edges, given: [{ key: 2n ** 32n + 5n, day: newest }] }).length).toBeLessThan(cursorText({ ...edges, given: [{ key: 5n, day: newest }] }).length + 6);
    expect(() => cursorOf("not a cursor!")).toThrow(CursorError);
    expect(() => cursorOf(text.slice(0, -4))).toThrow(CursorError);
    expect(() => cursorOf(cursorText({ ...largest, given: [...largest.given, window(1_000), window(1_001)] }))).toThrow(CursorError);
    expect(() => cursorOf(cursorText({ ...largest, place: { key: SQLITE_MOST + 1n, day: newest } }))).toThrow(CursorError);
    expect(() => cursorOf(cursorText({ ...edges, given: [{ key: SQLITE_MOST, day: newest }, { key: SQLITE_MOST + 1n, day: newest }] }))).toThrow(CursorError);
    expect(() => cursorOf("A".repeat(NEXT_CHARS + 4))).toThrow(CursorError);
    expect(() => cursorOf(cursorText({ ...largest, given: [...largest.given, { key: 5n, day: newest }] }))).toThrow(CursorError);
    const textOf = (numbers: number[]) => {
      const out: number[] = [];
      for (let n of numbers) {
        for (; n >= 0x80; n = Math.floor(n / 0x80)) out.push((n % 0x80) | 0x80);
        out.push(n);
      }
      return Buffer.from(out).toString("base64url");
    };
    expect(cursorOf(textOf([1, 0, 0, 0, 0, 0])).newest).toBe("1970-01-01");
    expect(() => cursorOf(textOf([1, 2 ** 40, 0, 0, 0, 0]))).toThrow(CursorError);
    expect(() => cursorOf(textOf([1, 3_000_000, 0, 0, 0, 0]))).toThrow(CursorError);
    expect(() => cursorOf(textOf([1, Number.MAX_SAFE_INTEGER, 0, 0, 0, 0]))).toThrow(CursorError);
  });

  it("gives each window once, keys past 2^32 and 2^53 and at both ends of an SQLite integer mixed with small ones on one day (S9)", () => {
    const windows = Array.from({ length: 64 }, (_, k) => one(`Gull ${k}`, T0 + k * 10_000, [`${"gull ".repeat(1 + (k % 4))}own${k}`]));
    const again = windows.slice(0, 8).map((window, k) => one(window.title!, T0 - DAY + k * 10_000, [`gull again${k}`]));
    const keyAt = (place: number) => (place % 2 === 1 && place < 2 * EDGES.length ? EDGES[(place - 1) / 2]! : BigInt(place + 1));
    const db = rekeyed(segments("mac-0001", [...windows, ...again]), keyAt);
    const pages = pagesOf(db, "gull", { evidence: true });
    expect(once(pages)).toHaveLength(72);
    expect(pages[0]!.total).toBe(72);
    const groups = pages.flatMap((page) => page.hits.flatMap((hit) => [hit.group!, ...hit.also.map((other) => other.group!)]));
    const keys = [...new Set(groups.map((group) => BigInt(group.split("/")[0]!)))].sort((one, other) => (one < other ? -1 : one > other ? 1 : 0));
    expect(keys).toEqual(Array.from({ length: 64 }, (_, place) => keyAt(place)).sort((one, other) => (one < other ? -1 : one > other ? 1 : 0)));
    expect(groups).toHaveLength(72);
    db.close();
  });

  it("turns to time when the windows given would pass the cursor's room, before 300, and counts the largest cursor with the arguments at their bound (S9)", () => {
    const windows = Array.from({ length: 330 }, (_, k) => one(`Ibis ${k}`, T0 - (128 + (k % 230)) * DAY + k * 1_000, [`${"ibis ".repeat(1 + (k % 5))}own${k}`]));
    const step = (SQLITE_MOST - SQLITE_LEAST) / 329n;
    const db = rekeyed(segments("mac-0001", windows), (place) => SQLITE_LEAST + BigInt(place) * step);
    const range = { from_ms: NOW - 365 * DAY, to_ms: NOW };
    const turnOf = (pages: readonly ScreenPage[]) => pages.findIndex((page) => page.order === "newest");
    const plain = pagesOf(db, "ibis", range);
    expect(once(plain)).toHaveLength(330);
    expect(plain.slice(0, turnOf(plain)).flatMap(givenBy)).toHaveLength(GIVEN_MOST);
    const largest = Math.max(...plain.flatMap((page) => (page.next === undefined ? [] : [cursorText(page.next).length])));
    expect(largest).toBeLessThanOrEqual(CURSOR_CHARS);
    const argumentsAtBound = Buffer.alloc(ARGUMENTS_BYTES).toString("base64url");
    expect(largest + 1 + argumentsAtBound.length).toBeLessThan(NEXT_CHARS);
    expect(CURSOR_CHARS + 1 + argumentsAtBound.length).toBeLessThan(NEXT_CHARS);
    const room = 1_500;
    const tight = pagesOf(db, "ibis", { ...range, room });
    const turn = turnOf(tight);
    const ranked = tight.slice(0, turn).flatMap(givenBy);
    expect(ranked.length).toBeGreaterThan(TOP);
    expect(ranked.length).toBeLessThan(GIVEN_MOST);
    expect(tight.slice(0, turn).every((page) => page.order === undefined)).toBe(true);
    expect(tight[turn - 1]!.next!.by_day).toBe(true);
    expect(tight[turn - 1]!.next!.given).toHaveLength(ranked.length);
    expect(tight.slice(turn).every((page) => page.order === "newest")).toBe(true);
    const days = tight.slice(turn).flatMap((page) => page.hits.map((hit) => hit.day));
    expect(days).toEqual([...days].sort().reverse());
    for (const page of tight) if (page.next !== undefined) expect(cursorText(page.next).length).toBeLessThanOrEqual(room);
    const atTurn = tight[turn - 1]!.next!;
    const worstPlace = { key: SQLITE_MOST, day: atTurn.oldest };
    expect(cursorText({ ...atTurn, place: worstPlace }).length).toBeLessThanOrEqual(room);
    expect(once(tight)).toHaveLength(330);
    db.close();
  });

  it("keeps the cursor inside its room when a window comes before every key held, and the page by day after it (S9)", () => {
    const old = Array.from({ length: 10 }, (_, i) => one(`Shore old ${i}`, T0 - (140 + i) * DAY, [`${"wader ".repeat(40 - i)}own${i}`]));
    const far = one("Shore far 0", T0 - 130 * DAY, [`${"wader ".repeat(25)}far`]);
    const recent = Array.from({ length: 12 }, (_, i) => one(`Shore new ${i}`, T0 - i * DAY, [`${"wader ".repeat(12 - i)}new${i}`]));
    const keyOf = (name: string) => (name === "Shore far 0" ? SQLITE_LEAST : name.startsWith("Shore old ") ? BigInt(name.slice(10)) : 2n ** 62n + BigInt(name.slice(10)));
    const db = rekeyed(segments("mac-0001", [...old, far, ...recent]), (_, name) => keyOf(name));
    const range = { from_ms: NOW - 365 * DAY, to_ms: NOW };
    const free = pageOf(db, "wader", undefined, range);
    expect(free.hits.map((hit) => windowOf(hit))).toEqual(old.map((window) => window.title));
    const start = Buffer.from(cursorText(free.next!), "base64url").length + 12;
    let band = 0;
    for (let chars = Math.ceil((start * 4) / 3); chars <= Math.ceil(((start + 30) * 4) / 3); chars++) {
      const pages = pagesOf(db, "wader", { ...range, room: chars });
      expect(once(pages)).toHaveLength(23);
      expect(pages[0]!.hits).toHaveLength(10);
      for (const page of pages) if (page.next !== undefined) expect(cursorText(page.next).length).toBeLessThanOrEqual(chars);
      const turn = pages.findIndex((page) => page.order === "newest");
      const atTurn = pages[turn - 1]!.next!;
      expect(cursorText({ ...atTurn, place: { key: SQLITE_MOST, day: atTurn.oldest } }).length).toBeLessThanOrEqual(chars);
      const bytes = Math.floor((chars * 3) / 4);
      if (bytes >= start + 13 && bytes < start + 21) {
        band++;
        expect(atTurn.given).toHaveLength(10);
        expect(pages[turn]!.hits).toHaveLength(10);
        expect(pages[turn]!.next!.given).toHaveLength(10);
      }
    }
    expect(band).toBeGreaterThan(0);
    db.close();
  });

  it("reads a product's windows alone, and no product it has no row for (S8)", () => {
    const db = indexOf(segments("mac-0001", [
      one("Person A", T0, ["see you at the osprey hide"], "WhatsApp"),
      { from: T0 + MIN, to: T0 + MIN + 1, app: "Example Browser", site: "web.whatsapp.com", title: "WhatsApp Web", lines: ["osprey photos"] },
      one("Osprey Article", T0 + 2 * MIN, ["the osprey returns"]),
    ]));
    const windows = productWindows(["whatsapp"])!;
    expect(pageOf(db, "osprey", undefined, { windows }).hits.map((hit) => windowOf(hit)).sort()).toEqual(["Person A", "WhatsApp Web"]);
    expect(pageOf(db, "osprey").total).toBe(3);
    expect(productWindows(["whatsapp", "no-such-product"])).toBeUndefined();
    expect(productWindows([])).toBeUndefined();
    db.close();
  });

  it("counts the rows a page reads after its ranking: a window's front spans, the blocks its minute is chosen among and their runs (R5b, Sol R12-8)", () => {
    const once = indexOf(segments("mac-0001", [{ from: T0, to: T0 + 4 * MIN, app: "Reader", title: "Bog Page", lines: [post("quillwort marsh")] }]));
    const toggled: Window[] = [];
    for (let n = 0; n < 30; n++) {
      toggled.push({ from: T0 + n * 8_000, to: T0 + n * 8_000 + 4_000, app: "Reader", title: "Bog Page", lines: [post("quillwort marsh")] });
      toggled.push({ from: T0 + n * 8_000 + 4_000, to: T0 + n * 8_000 + 8_000, app: "Other", title: "Other Page", lines: [words(3)] });
    }
    const many = indexOf(segments("mac-0001", toggled));
    const spansOf = (db: Database.Database) => Number(db.prepare(`SELECT count(*) FROM screen_span s JOIN screen_row r ON r.slot = s.slot
      JOIN screen_key k ON k.id = r.key WHERE k.name = 'Bog Page'`).pluck().get());
    const runsOf = (db: Database.Database) => Number(db.prepare("SELECT count(*) FROM screen_block_run").pluck().get());
    const counted = (db: Database.Database) => {
      const before = rowsCounted();
      expect(pageOf(db, "quillwort").hits).toHaveLength(1);
      return rowsCounted() - before;
    };
    expect(spansOf(many)).toBeGreaterThan(spansOf(once) + 20);
    expect(counted(many) - counted(once)).toBeGreaterThanOrEqual(spansOf(many) - spansOf(once) + runsOf(many) - runsOf(once));
    once.close();
    many.close();
  });

  it("reads each text and a day's spans once a page: a hit's evidence reads fewer rows than the hit has slots, never each slot's text and the day's spans again", () => {
    const db = indexOf(segments("mac-0001", Array.from({ length: 30 }, (_, n) => ({ from: T0 + n * MIN, to: T0 + (n + 1) * MIN, app: "Reader", title: "Bog Page", lines: [post(`quillwort marsh ${"ab".repeat(n + 1)}`)] }))));
    const slots = Number(db.prepare("SELECT count(*) FROM screen_fts WHERE screen_fts MATCH 'quillwort'").pluck().get());
    const counted = (evidence: boolean) => {
      const before = rowsCounted();
      expect(pageOf(db, "quillwort", undefined, { evidence }).hits).toHaveLength(1);
      return rowsCounted() - before;
    };
    expect(slots).toBeGreaterThan(1);
    expect(counted(true) - counted(false)).toBeLessThan(slots);
    db.close();
  });

  it("gives the windows a stretch's first page gave by meaning too: no later page of the stretch gives them, the next stretch is not told (R5b, Sol R12-5)", () => {
    const db = indexOf(segments("mac-0001", Array.from({ length: 15 }, (_, n) => one(`Heron ${n}`, T0 + n * MIN, [`the heron flies ${n}`]))));
    const first = pageOf(db, "heron");
    expect(first.hits).toHaveLength(10);
    const keys = db.prepare("SELECT id, name FROM screen_key").safeIntegers(true).all() as { id: bigint; name: string }[];
    const given = new Set(first.next!.given.map((window) => window.key));
    const meant = keys.filter((key) => key.name.startsWith("Heron") && !given.has(key.id)).slice(0, 2);
    expect(meant).toHaveLength(2);
    const day = first.hits[0]!.day;
    const next = gaveToo(first, meant.map((key) => ({ key: key.id, day })))!;
    expect(next.given.length).toBe(first.next!.given.length + 2);
    const later = search(db, { q: "heron", now_ms: NOW, cursor: cursorOf(cursorText(next)) }).hits.map((hit) => windowOf(hit));
    expect(later).toHaveLength(3);
    for (const key of meant) expect(later).not.toContain(key.name);
    const older = { ...first, next: { ...first.next!, newest: "2000-01-01", given: [] } } as ScreenPage;
    expect(gaveToo(older, meant.map((key) => ({ key: key.id, day })))!.given).toEqual([]);
    db.close();
  });
});
