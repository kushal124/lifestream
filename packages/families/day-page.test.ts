import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { episodes, type EpisodesExtras, type EpisodesFile } from "./day-episodes.js";
import { dayPage, type Chapter, type DayExtras, type DayPage } from "./day-page.js";
import { NO_SIDE, type DaySideExtras } from "./day-side.js";
import { quietLineOf } from "./day-words.js";
import type { DayAtom } from "./days.js";
import { datedDays, DATE } from "./plain/test/dated.js";

const FOLDER = join(dirname(fileURLToPath(import.meta.url)), "test", "day-page");
const SIDE = join(dirname(fileURLToPath(import.meta.url)), "test", "day-side");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const DAYS = ["2026-10-25", "2026-10-31", "2026-11-10", "2031-03-04", "2031-04-05", "2031-05-20", "2031-06-12", "2031-07-01", "2031-07-02"];
const HOUR = 3600_000;
const CLOCK = /\b\d{1,2}:\d{2}\b/u;
const WEEK = 7 * 24 * HOUR;

const read = (name: string): string => readFileSync(join(FOLDER, name), "utf8");
const { sources } = JSON.parse(read("sources.json")) as { sources: NonNullable<EpisodesExtras["sources"]> };
const today = JSON.parse(read("today.json")) as { day: string; now_ms: number };

const sideOf = (day: string): DaySideExtras => existsSync(join(SIDE, `${day}.json`))
  ? JSON.parse(readFileSync(join(SIDE, `${day}.json`), "utf8")) as DaySideExtras : NO_SIDE;

interface Inputs {
  keep?: (atom: DayAtom) => boolean;
  change?: (atom: DayAtom) => DayAtom;
  side?: false;
}

function inputsOf(day: string, { keep = () => true, change = (atom) => atom, side }: Inputs = {}): { file: EpisodesFile; extras: DayExtras } {
  const { sleep, sent, groups, products, ...file } = JSON.parse(read(`${day}.day.json`)) as EpisodesFile & EpisodesExtras;
  return {
    file: { ...file, atoms: file.atoms.filter(keep).map(change) },
    extras: { ...sleep && { sleep }, ...sent && { sent }, ...groups && { groups }, ...products && { products }, sources, ...side === false ? NO_SIDE : sideOf(day) },
  };
}

interface PageCase extends Inputs {
  name: string;
  day: string;
  now: (window: { start_ms: number }) => number | null;
  differs: string;
}

const OFFICE_END_MS = 1930357680000;
const PHONE_STAYS = (atom: DayAtom): boolean => atom.family === "physical" && atom.unit.startsWith("stay/location:local:") && atom.text.startsWith("At ");
const said = (who: string, ns: number[]) => (atom: DayAtom): DayAtom => ns.includes(atom.n) ? { ...atom, text: atom.text.replace(/^[^:]*:/u, `${who}:`) } : atom;

const PAST = (): null => null;
const CASES: PageCase[] = [
  ...DAYS.map((day): PageCase => ({
    name: day, day, now: PAST,
    differs: day === "2031-03-04"
      ? "rule 2: midnight sits on the 01:00 hour line of the evening stay; the dashboard put it on that hour's first row, seen only once the hour was opened"
      : "none: the dashboard's layout",
  })),
  {
    name: "today", day: today.day, now: () => today.now_ms,
    differs: "rule 1: at 08:25 the event after now is a plan and until_ms is its start; rule 5: its 'in …' words and the now line's clock are the app's; rule 2 as 2031-03-04",
  },
  {
    name: "today-late", day: today.day, now: ({ start_ms }) => start_ms + 17 * HOUR + 50 * 60_000,
    differs: "rule 1: at 21:50 the evening stay is the last and holds now, so it is open (end_ms null, no length); the dashboard gave it 6h",
  },
  {
    name: "gap-now", day: "2031-03-04", now: ({ start_ms }) => start_ms + 10 * HOUR, keep: PHONE_STAYS, side: false,
    differs: "rule 1: the day's three phone stays alone at 14:00; the quiet gap after the office ends at now, not at the evening stay",
  },
  {
    name: "stay-open", day: "2031-03-04", now: () => OFFICE_END_MS + 40 * 60_000, keep: (atom) => PHONE_STAYS(atom) && atom.n !== 56, side: false,
    differs: "rule 1: the office stay is the last and its last fix is 40 min before now, so it is open; the dashboard closed it at its last fix",
  },
  {
    name: "stay-closed", day: "2031-03-04", now: () => OFFICE_END_MS + 90 * 60_000, keep: (atom) => PHONE_STAYS(atom) && atom.n !== 56, side: false,
    differs: "none: the office stay's last fix is 90 min before now, over the hour, so it stays closed with its length",
  },
  {
    name: "all-day", day: "2031-04-05", now: PAST,
    keep: (atom) => atom.family === "calendar" && atom.flags.includes("date_only"), side: false,
    differs: "rule 4 (Days 4): a day of only all-day events has no day-end row (end_ms null); the dashboard drew one",
  },
  {
    name: "groups", day: "2031-05-20", now: PAST, change: said("the user", [26, 27, 51]),
    differs: "side: Group Beta (3 written) stands before Group Alpha (1), though Alpha was written first; the dashboard put Alpha first",
  },
  {
    name: "quiet-wrote", day: "2031-03-04", now: PAST,
    change: (atom) => atom.n === 78 ? { ...atom, text: "Group Alpha · 4 messages", block: { key: "whatsapp:120363000000000001@g.us", title: "You were quiet in" } } : atom,
    differs: "none: Group Alpha wrote and has a quiet line too; it stands once, as written",
  },
];

function built(page: PageCase): { got: DayPage; now: number | null } {
  const { file, extras } = inputsOf(page.day, page);
  const now = page.now(file.window);
  return { got: dayPage(file, extras, now), now };
}

function held(page: PageCase): { written: string; held: string } {
  const written = `${JSON.stringify(built(page).got, null, 2)}\n`;
  const name = `${page.name}.page.json`;
  if (WRITE) writeFileSync(join(FOLDER, name), written);
  return { written, held: read(name) };
}

const pageOf = (name: string): DayPage => built(CASES.find((each) => each.name === name) as PageCase).got;

const dividers = (got: DayPage): string[] => [
  ...got.chapters.flatMap((chapter) => [
    ...chapter.divider ? [`chapter ${chapter.key}`] : [],
    ...chapter.blocks.flatMap((block) => [
      ...block.divider ? [`block ${block.key}`] : [],
      ...block.rows.flatMap((row) => row.divider ? [`row ${row.key}`] : []),
    ]),
  ]),
  ...got.now_divider ? ["now"] : [],
  ...got.plans.flatMap((row) => row.divider ? [`plan ${row.key}`] : []),
];

const headWords = (got: DayPage): string[] => [
  ...got.line === null ? [] : [got.line],
  ...got.chapters.flatMap((chapter) => [
    ...chapter.head ? [chapter.head.title, chapter.head.line, chapter.head.stated_by, chapter.head.length] : [],
    ...chapter.blocks.map((block) => block.line),
  ]).filter((words): words is string => words !== null),
];

function words(value: unknown, path = ""): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((each, at) => words(each, `${path}[${at}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, each]) => words(each, `${path}.${key}`));
  return [];
}

describe("a day's page", () => {
  it("the folder holds one page for each case", () => {
    expect(readdirSync(FOLDER).filter((name) => name.endsWith(".page.json")).sort())
      .toEqual(CASES.map((page) => `${page.name}.page.json`).sort());
  });

  for (const page of CASES) {
    it(`${page.name}: the page is the expected file, byte for byte (differs from the dashboard: ${page.differs})`, () => {
      const { written, held: kept } = held(page);
      expect(kept, `test/day-page/${page.name}.page.json is this case's page: LIFESTREAM_FIXTURES=write writes it`).toBe(written);
    });
  }

  it("rule 1: a past day has no now, no plans and no open stay", () => {
    for (const day of DAYS) {
      const got = pageOf(day);
      expect(got.now_ms, day).toBeNull();
      expect(got.updated_ms, day).toBeNull();
      expect(got.plans, day).toEqual([]);
      expect(got.until_ms, day).toBeNull();
      expect(got.chapters.filter((chapter) => chapter.end_ms === null), day).toEqual([]);
    }
  });

  it("rule 1: today, an event after now is a plan out of the chapters, and the page reads again at the next plan", () => {
    const got = pageOf("today");
    expect(got.now_ms).toBe(today.now_ms);
    expect(got.plans.length).toBeGreaterThan(0);
    for (const plan of got.plans) expect(plan.at_ms as number).toBeGreaterThan(today.now_ms);
    expect(got.until_ms).toBe(Math.min(...got.plans.map((plan) => plan.at_ms as number)));
    const rows = new Set(got.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows.map((row) => row.key))));
    for (const plan of got.plans) expect(rows.has(plan.key)).toBe(false);
    expect(got.chapters.filter((chapter) => chapter.end_ms === null)).toEqual([]);
  });

  it("rule 1: the last stay is open when nothing follows it and its last fix is within the hour before now", () => {
    for (const name of ["today-late", "stay-open"]) {
      const got = pageOf(name);
      const last = got.chapters.at(-1) as Chapter;
      expect(last.kind, name).toBe("stay");
      expect(last.end_ms, name).toBeNull();
      expect(last.head?.length, name).toBeNull();
      expect(got.chapters.slice(0, -1).filter((chapter) => chapter.end_ms === null), name).toEqual([]);
    }
    const closed = pageOf("stay-closed").chapters.at(-1) as Chapter;
    expect(closed.kind).toBe("stay");
    expect(closed.end_ms).toBe(OFFICE_END_MS);
    expect(closed.head?.length).not.toBeNull();
  });

  it("rule 1: a quiet gap ends at now at the latest", () => {
    const got = pageOf("gap-now");
    const gaps = got.chapters.filter((chapter) => chapter.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.end_ms).toBe(got.now_ms);
  });

  it("rule 2: the midnight divider sits on the hour line it falls before, once a page", () => {
    expect(dividers(pageOf("2031-03-04"))).toEqual(["block stay/location:local:phone-aa01/1930368000000@1930368000000#1930401000000"]);
    for (const page of CASES) expect(dividers(built(page).got).length, page.name).toBeLessThanOrEqual(1);
    for (const day of ["2031-07-01", "2031-07-02"]) expect(dividers(pageOf(day)), `${day} is a midnight-to-midnight day`).toEqual([]);
  });

  it("rule 3 (Days 2): every quiet gap of a placeless stretch is its own chapter", () => {
    for (const page of CASES) {
      for (const chapter of built(page).got.chapters.filter((each) => each.kind === "gap")) {
        expect(chapter.blocks, page.name).toEqual([]);
        expect(chapter.key, page.name).toBe(`gap:${chapter.start_ms}`);
      }
    }
  });

  it("rule 3: a quiet gap that played music stands on the page as what played, each a row that opens", () => {
    for (const [day, key] of [["2031-03-04", "e72"], ["2031-04-05", "e21"]] as const) {
      const { file, extras } = inputsOf(day);
      const gap = episodes(file, extras, null).chapters.flatMap((chapter) => chapter.gaps).find((each) => each.played.includes(key));
      expect(gap, `${day}: ${key} played in a quiet gap`).toBeDefined();
      const rows = pageOf(day).chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows));
      expect(rows.filter((row) => row.key === key).map((row) => [row.kind, row.icon, row.focus !== null]), day).toEqual([["listening", "listening", true]]);
      expect(pageOf(day).chapters.some((chapter) => chapter.key === gap?.id), `${day}: the gap is no chapter of its own`).toBe(false);
    }
  });

  it("a chat of a network the app was not built with is one person's unless the labels say group; a plain stream is one row a block, named and drawn by its product, or by its id and the info glyph with no product", () => {
    const rowsOf = (got: DayPage) => got.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows));
    const { file, extras } = inputsOf("2031-07-01");
    expect(rowsOf(pageOf("2031-07-01")).map((row) => [row.key, row.kind, row.icon, row.name])).toEqual([
      ["e1", "conversation", "message", "Person A"], ["e3", "other", "recording", "Example Log"], ["e5", "other", "info", "example-gone"],
    ]);
    const grouped = rowsOf(dayPage(file, { ...extras, groups: ["example-chat:12345"] }, null));
    expect(grouped.find((row) => row.key === "e1")?.icon, "the chat's id says nothing; the labels do").toBe("meeting");
    const lines = episodes(file, extras, null).episodes.filter((episode) => episode.kind === "other");
    expect(lines.map((episode) => [episode.product, episode.atoms]), "one episode a stream's block").toEqual([["example-log", [3, 4]], ["example-gone", [5]]]);
    expect(lines.map((episode) => episode.title), "titled by its first line's words").toEqual(["Synthetic entry one: the first line", "A line of a stream since removed"]);
  });

  it("a stay at the person's home carries the home glyph, every other stay the place glyph", () => {
    const got = pageOf("2031-03-04");
    const home = got.side.places.find((place) => place.home)?.name;
    expect(home).toBe("Synthetic Home");
    const stays = got.chapters.filter((chapter) => chapter.kind === "stay" && chapter.episode !== null);
    expect(stays.filter((chapter) => chapter.head?.title === home).length).toBeGreaterThan(0);
    expect(stays.filter((chapter) => chapter.head?.title !== home).length).toBeGreaterThan(0);
    for (const chapter of stays) expect(chapter.head?.icon, chapter.key).toBe(chapter.head?.title === home ? "home" : "place");
    for (const chapter of pageOf("gap-now").chapters) if (chapter.kind === "stay") expect(chapter.head?.icon, "no known home, no home glyph").toBe("place");
  });

  it("every photo of a strip carries the time it was taken", () => {
    const got = pageOf("2031-03-04");
    const strip = got.chapters.flatMap((chapter) => chapter.photos.map((photo) => [chapter, photo] as const));
    expect(strip.length).toBeGreaterThan(0);
    for (const [chapter, photo] of strip) {
      expect(photo.at_ms, photo.hash).not.toBeNull();
      expect(photo.at_ms as number, photo.hash).toBeGreaterThanOrEqual(chapter.start_ms);
      expect(photo.at_ms as number, photo.hash).toBeLessThan(chapter.end_ms ?? Infinity);
    }
    const tiles = got.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows))
      .flatMap((row) => row.words.flatMap((run) => run.type === "tiles" ? run.photos.map((photo) => [row, photo] as const) : []));
    expect(tiles.length).toBeGreaterThan(0);
    for (const [row, photo] of tiles) expect(photo.at_ms, photo.hash).toBeGreaterThanOrEqual(row.at_ms as number);
  });

  it("rule 4 (Days 4): the day-end row stands for a day with a chapter, an undated row or a now, and not for all-day events alone", () => {
    expect(pageOf("all-day").all_day.length).toBeGreaterThan(0);
    expect(pageOf("all-day").end_ms).toBeNull();
    for (const day of DAYS) expect(pageOf(day).end_ms, day).toBe(inputsOf(day).file.window.end_ms);
  });

  it("rule 4 (Days 5): a quiet line is read from its first line only", () => {
    const atom = (text: string): DayAtom => ({
      n: 1, family: "messages", unit: "chat/a", units: [], start_ms: null, end_ms: null, local_start: null, local_end: null, flags: ["no_time"], text,
      block: { key: "chat-a", title: "You were quiet in" },
    });
    expect(quietLineOf(atom("Group Alpha · 12 messages\nPerson A · 3 earlier"))).toEqual(
      { chat: "chat-a", heading: "You were quiet in", title: "Group Alpha", count: "12 messages" });
    expect(quietLineOf(atom("Group Alpha"))).toEqual({ chat: "chat-a", heading: "You were quiet in", title: "Group Alpha", count: "" });
    expect(quietLineOf({ ...atom("Group Alpha · 2 messages"), block: { key: "chat-a", title: "Group Alpha" } })).toBeNull();
  });

  it("rule 4 (Days 6): how a stay is known is its stated_by, never inside its title or line", () => {
    const stated = CASES.flatMap((page) => built(page).got.chapters.flatMap((chapter) => chapter.head?.stated_by ?? []));
    expect(new Set(stated)).toEqual(new Set(["from photos", "stated by Timeline"]));
    for (const page of CASES) {
      for (const chapter of built(page).got.chapters) {
        expect(`${chapter.head?.title} ${chapter.head?.line}`, page.name).not.toMatch(/stated by|from photos|\(/u);
      }
    }
  });

  it("rule 5: no words member changes with the clock: a past day built a week apart says the same", () => {
    for (const day of DAYS) {
      const { file, extras } = inputsOf(day);
      const later = dayPage(file, extras, file.window.end_ms + WEEK);
      const muchLater = dayPage(file, extras, file.window.end_ms + 2 * WEEK);
      expect(words(muchLater), day).toEqual(words(later));
      expect(later, day).toEqual(pageOf(day));
    }
  });

  it("rule 5: a wake and a night are times beside their words, and no member of any page holds a clock", () => {
    const got = pageOf("2031-03-04");
    const woke = got.chapters.flatMap((chapter) => chapter.names).filter((name) => name.text === "Woke");
    expect(woke).toHaveLength(1);
    const night = got.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows)).find((row) => row.kind === "sleep");
    expect(night?.words[0]).toMatchObject({ type: "span", text: "asleep", end_ms: woke[0]?.at_ms });
    expect(night?.words.slice(1)).toEqual([{ type: "text", text: "WHOOP", tone: "secondary" }]);
    for (const page of CASES) {
      expect(words(built(page).got).filter(([path, text]) => !path.endsWith(".hash") && CLOCK.test(text)), page.name).toEqual([]);
    }
  });

  it("a quiet stay whose first piece is a spot worth naming carries the spot as its head's place, for Name it; a named stay never does", () => {
    const heads = pageOf("2031-03-04").chapters.flatMap((chapter) => chapter.kind === "stay" && chapter.head ? [[chapter.episode, chapter.head.quiet, chapter.head.place]] : []);
    expect(heads.filter(([, , place]) => place !== null)).toEqual([["e42", true, "spot:10.0201,20.0201"]]);
    expect(heads.find(([episode]) => episode === "e12"), "the office stay is named: its spot is no Name it").toEqual(["e12", false, null]);
    const { file, extras } = inputsOf("2031-03-04");
    const unspotted = { ...extras, where: extras.where.map(({ spot: _, ...piece }) => piece) };
    expect(dayPage(file, unspotted, null).chapters.filter((chapter) => chapter.head?.place), "no spot, no Name it").toEqual([]);
  });

  it("rule 5: hours, rows and the day's end are times, never words of the day or of now", () => {
    for (const page of CASES) {
      const got = built(page).got;
      for (const chapter of got.chapters) for (const block of chapter.blocks) expect(block.title, page.name).toBeNull();
      for (const said of headWords(got)) expect(said, page.name).not.toMatch(/\b(?:today|tomorrow|yesterday|since|ago)\b|^in \d|^\d{1,2}:\d{2}\b/iu);
    }
  });
});

describe("a dated line on the day's page", () => {
  it("is an untimed row of its own date in every zone, in no block, out of the all-day row and on no other day", () => {
    for (const { zone, days } of datedDays()) {
      for (const [day, rendered] of Object.entries(days)) {
        const film = rendered.atoms.find((atom) => atom.record?.key === "film");
        const page = dayPage(rendered, NO_SIDE, null);
        const timed = page.chapters.flatMap((chapter) => chapter.blocks.flatMap((block) => block.rows));
        if (day !== DATE) {
          expect(film, `${zone}: not on ${day}`).toBeUndefined();
          continue;
        }
        const key = episodes(rendered, {}).episodes.find((episode) => episode.atoms.includes(film!.n))?.id;
        expect(key, `${zone}: the film is a row of ${DATE}`).toBeDefined();
        expect(page.also?.rows.find((row) => row.key === key)?.at_ms, `${zone}: in the untimed rows`).toBeNull();
        expect(timed.some((row) => row.key === key), `${zone}: in no block`).toBe(false);
        expect(page.all_day.some((row) => row.key === key), `${zone}: not in the all-day row`).toBe(false);
      }
    }
  });
});
