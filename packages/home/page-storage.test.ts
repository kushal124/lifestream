import { describe, expect, it } from "vitest";
import { addDays } from "@lifestreamprotocol/core";
import { PAGES } from "./pages.js";
import { hereOf, leftWords, moreWords, sentenceOf, spaceWords, storageHandler, storagePage, WORDS, type Storage } from "./page-storage.js";
import { servePages } from "./page-serve.js";
import type { Ask, Reply } from "./reads.js";
import { connectors } from "./registry-home.js";
import { NB } from "./stream-words.js";
import { clientFixture } from "./test/harness-root.js";
import { COUNTING, GB, MAP, TODAY, YEAR, YOUNG, type Read } from "./test/storage-reads.js";

const DAY = { zone: "Asia/Kolkata", day_start_hour: 4 };
const NOW_MS = Date.parse("2026-11-23T06:00:00Z");
const HERE = "this Mac";

const plain = (text: string): string => text.replaceAll(NB, " ");
const page = (read: Read, here = HERE): Storage => storagePage(read, { connectors: connectors(), today: TODAY, here });
const said = (phrase: Storage["sentence"]): string => plain(phrase.map((part) => (part.kind === "words" ? part.words : `<${part.time.kind === "day" ? part.time.day : ""}>`)).join(""));
const sentence = (read: Read, here = HERE): string => said(sentenceOf(read, TODAY, here));
const forecast = (growth: Partial<Read["growth"]>, name: string | null = "T9"): Read => ({ ...YEAR, disk: { ...YEAR.disk, name }, growth: { ...YEAR.growth, ...growth } });

type Asker = { kind: "phone" | "mac"; unit: string } | null;

async function asked(read: Read, by: Asker): Promise<{ answer: Record<string, any>; reads: number }> {
  let reads = 0;
  const routes = servePages({
    storage: storageHandler({
      read: () => {
        reads += 1;
        return { position: "7:1", read, connectors: connectors() };
      },
    }),
  }, () => DAY);
  const ask = { url: PAGES.storage.route, now_ms: NOW_MS, held: { machine: "machine-0001" }, ...(by === null ? {} : { device: by }) } as unknown as Ask;
  const reply: Reply = await routes.get(PAGES.storage.route)!(ask);
  return { answer: JSON.parse(reply.body as string) as Record<string, any>, reads };
}

describe("Storage, counted", () => {
  it("draws the bar as the five largest by rank, Other connectors, Index and AI, the other files and the free space", () => {
    const drawn = page(YEAR);
    expect(drawn.counted).toBe(true);
    expect([plain(drawn.figure), drawn.after, plain(drawn.disk)]).toEqual(["405 GB", "Lifestream", "377 GB free of 1 TB on T9"]);
    const ranked = YEAR.home.streams.slice(0, 5).map((stream) => stream.connector);
    expect(drawn.bar.parts.map((part) => [part.id, part.tone])).toEqual([...ranked.map((id, at) => [id, `s${at + 1}`]), ["other", "other"], ["own", "own"], ["", "disk"], ["", "free"]]);
    expect(drawn.bar.parts.slice(0, 5).map((part) => part.name)).toEqual(["Screen", "Photos", "Granola", "Claude", "WhatsApp"]);
    const share = (bytes: number) => (bytes / YEAR.disk.total_bytes) * 100;
    expect(drawn.bar.parts[0]!.share).toBe(share(YEAR.home.streams[0]!.bytes));
    expect(drawn.bar.parts[5]!.share).toBe(share(YEAR.home.streams.slice(5).reduce((sum, stream) => sum + stream.bytes, 0)));
    expect(drawn.bar.parts[7]).toMatchObject({ name: "Other files on T9", share: share(YEAR.disk.total_bytes - YEAR.disk.free_bytes - YEAR.home.bytes) });
    expect(drawn.bar.parts[8]!.share).toBe(share(YEAR.disk.free_bytes));
    expect(drawn.bar.key.map((each) => each.name).slice(-3)).toEqual(["Other connectors", "Index and AI", "Other files"]);
    expect(drawn.bar.left).toBe("");
  });

  it("draws the chart's parts in the bar's tones, the rate, and the room up to the space kept free", () => {
    const { chart } = page(YEAR);
    const ranked = YEAR.home.streams.slice(0, 5).map((stream) => stream.connector);
    expect(chart!.parts.map((part) => [part.id, part.tone])).toEqual([...ranked.map((id, at) => [id, `s${at + 1}`]), ["other", "other"], ["own", "own"]]);
    expect(chart!.label).toEqual([{ kind: "words", words: "Lifestream’s size since " }, { kind: "time", time: { kind: "day", day: YEAR.series!.first_day } }]);
    expect(chart!.rate).toBe(YEAR.growth.bytes_a_day);
    expect(chart!.room).toEqual({ bytes: YEAR.home.bytes + YEAR.disk.free_bytes - YEAR.disk.keep_bytes - YEAR.disk.coming_bytes, name: "T9 full" });
  });

  it("says the space kept free with its line, as the Mac's Location says it", () => {
    expect(page(YEAR).keep).toEqual({ label: WORDS.keep, line: WORDS.keepLine, size: `5${NB}GB` });
  });
});

describe("Storage, counting", () => {
  it("shows each stream at what is counted, the rest Not yet counted, the time left; no week, no chart", () => {
    const drawn = page(COUNTING);
    expect([drawn.counted, drawn.figure, plain(drawn.after)]).toEqual([false, "Counting…", "212 GB so far"]);
    expect(drawn.bar.parts.at(-2)).toMatchObject({ name: WORDS.uncounted, tone: "uncounted" });
    expect(drawn.bar.key.at(-1)?.name).toBe(WORDS.uncounted);
    expect(plain(drawn.bar.left)).toBe("About 4 minutes left");
    expect(drawn.chart).toBeNull();
    expect(drawn.uses.length).toBeGreaterThan(0);
    expect(drawn.uses.slice(0, -1).every((use) => use.line === null)).toBe(true);
    expect(said(drawn.sentence)).toBe(`T9 fills by about 2.1 GB a day. At this rate it is full around <${addDays(TODAY, 178)}>.`);
    expect(page({ ...COUNTING, counting: { map: false, left_ms: null } }).bar.left).toBe("");
    expect([plain(leftWords(30_000)), plain(leftWords(61_000)), leftWords(null)]).toEqual(["Less than a minute left", "About 1 minute left", ""]);
  });

  it("before the first figure says Counting… alone, the used space one grey, the sentence, no uses and no chart", () => {
    const drawn = page(MAP);
    expect([drawn.counted, drawn.figure, drawn.after]).toEqual([false, "Counting…", ""]);
    expect(drawn.bar.parts.map((part) => part.tone)).toEqual(["uncounted", "free"]);
    expect(drawn.bar.parts[0]!.share).toBe(((MAP.disk.total_bytes - MAP.disk.free_bytes) / MAP.disk.total_bytes) * 100);
    expect(drawn.bar.key.map((each) => each.name)).toEqual([WORDS.uncounted]);
    expect([drawn.uses, drawn.chart, drawn.more]).toEqual([[], null, null]);
    expect(said(drawn.sentence).startsWith("T9 fills by about")).toBe(true);
  });
});

describe("Storage's sentence", () => {
  it("says the forecast case by case, its date a day When", () => {
    expect(sentence(forecast({ readings: 30, bytes_a_day: 2.1e9, days_left: 178 }))).toBe(`T9 fills by about 2.1 GB a day. At this rate it is full around <${addDays(TODAY, 178)}>.`);
    expect(sentence(forecast({ readings: 3, bytes_a_day: 2.1e9, days_left: 178 }))).toBe("Lifestream has been measuring for 3 days. How fast it grows shows here after a week.");
    expect(sentence(forecast({ readings: 0, bytes_a_day: null, days_left: null }))).toBe("Lifestream has been measuring for 1 day. How fast it grows shows here after a week.");
    expect(sentence(forecast({ readings: 3, bytes_a_day: 9e9, days_left: 12 })), "a month left speaks before the week").toBe(`T9 fills by about 9 GB a day. At this rate it is full around <${addDays(TODAY, 12)}>.`);
    expect(sentence(forecast({ readings: 30, bytes_a_day: null, days_left: null }))).toBe("T9 is not filling.");
    expect(sentence(forecast({ readings: 30, bytes_a_day: 0, days_left: null }))).toBe("T9 is not filling.");
    expect(sentence(forecast({ readings: 30, bytes_a_day: 1e9, days_left: 0 }))).toBe("T9 is full.");
    expect(sentence(forecast({ readings: 30, bytes_a_day: 1e8, days_left: 2000 })), "past five years: the rate alone").toBe("T9 fills by about 100 MB a day.");
    expect(sentence(forecast({ readings: 30, bytes_a_day: 1e8, days_left: null }))).toBe("T9 fills by about 100 MB a day.");
  });

  it("names a disk with no name as the asker's Mac", () => {
    expect(sentence(forecast({ readings: 30, bytes_a_day: null, days_left: null }, null))).toBe("This Mac is not filling.");
    expect(sentence(forecast({ readings: 30, bytes_a_day: null, days_left: null }, null), hereOf({ device: "phone" }))).toBe("Your Mac is not filling.");
    expect(plain(page(forecast({}, null)).disk)).toBe("377 GB free of 1 TB on this Mac");
    expect(page(forecast({}, null)).chart?.room?.name).toBe("This Mac full");
  });

  it("draws the rate on the chart only when the sentence says a rate", () => {
    expect(page(forecast({ readings: 3 })).chart?.rate).toBeNull();
    expect(page(forecast({ readings: 30, bytes_a_day: 1e9, days_left: 0 })).chart?.rate).toBeNull();
    expect(page({ ...YOUNG, growth: { readings: 2, bytes_a_day: 9e9, days_left: 12 } }).chart?.rate).toBe(9e9);
  });
});

describe("what uses the space", () => {
  it("says a use's week, Not growing, or since the home's first day while the home is under a week old", () => {
    expect(plain(said(page(YEAR).uses[0]!.line!))).toBe("+6.7 GB this week");
    expect(page(YEAR).uses.slice(2, 4).map((use) => said(use.line!))).toEqual(["Not growing", "Not growing"]);
    const young = page(YOUNG);
    const since = `<${YOUNG.series!.first_day}>`;
    expect(young.uses.map((use) => said(use.line!))).toEqual([`+4.6 GB since ${since}`, `+4.4 GB since ${since}`, `+630 MB since ${since}`, `+53 MB since ${since}`, WORDS.ownLine]);
    expect(young.more).toBeNull();
  });

  it("names a use by its connector, else its id, and opens only a connector the Connectors page shows", () => {
    const drawn = page({ ...YEAR, home: { ...YEAR.home, streams: [{ connector: "unheard-of", bytes: 500 * GB, week_bytes: GB }, ...YEAR.home.streams] } });
    expect(drawn.uses.slice(0, 2).map((use) => [use.name, use.opens])).toEqual([["unheard-of", null], ["Screen", "screen"]]);
    expect(page(YEAR).uses.find((use) => use.id === "ask")).toMatchObject({ name: "Ask", opens: null });
  });

  it("folds the uses past five behind Show 9 more connectors, each lit as Other connectors and opening its own stream, Index and AI last", () => {
    const drawn = page(YEAR);
    expect(drawn.uses.map((use) => use.id)).toEqual([...YEAR.home.streams.map((stream) => stream.connector), "own"]);
    expect(drawn.uses.map((use) => use.folded)).toEqual([...Array(5).fill(false), ...Array(9).fill(true), false]);
    expect(drawn.uses.map((use) => use.part)).toEqual([...YEAR.home.streams.slice(0, 5).map((stream) => stream.connector), ...Array(9).fill("other"), "own"]);
    expect(drawn.uses.slice(5, -1).every((use) => use.tone === "other" && (use.opens === use.id || use.id === "ask"))).toBe(true);
    expect([plain(drawn.more!), drawn.fewer, plain(moreWords(1))]).toEqual(["Show 9 more connectors", "Show fewer", "Show 1 more connector"]);
    expect(drawn.bar.parts.some((part) => part.id === "other")).toBe(true);
  });

  it("says a size never as 1000 of a unit, one way across Settings", () => {
    expect([999.7e9, 999.6e6, 999_600, 999.4e9, 9.96e9, 2.08e9, 1.25e12, 0].map((bytes) => plain(spaceWords(bytes))))
      .toEqual(["1 TB", "1 GB", "1 MB", "999 GB", "10 GB", "2.1 GB", "1.25 TB", "0 KB"]);
  });
});

describe("the Storage page", () => {
  it("answers in its shape from one read, and words a disk with no name as the phone's own Mac", async () => {
    const { answer, reads } = await asked({ ...YEAR, disk: { ...YEAR.disk, name: null } }, { kind: "phone", unit: "iphone-0001" });
    PAGES.storage.shape.parse(answer);
    expect(reads).toBe(1);
    expect(plain(answer.disk)).toBe("377 GB free of 1 TB on your Mac");
    expect((await asked(YEAR, { kind: "mac", unit: "macbook-pro-0001" })).answer.counted).toBe(true);
  });

  it("moves with the storage count and with today", () => {
    expect(PAGES.storage.moves).toEqual(["storage", "today"]);
  });

  it("pins each answer the apps decode", async () => {
    const pinned = {
      "storage.counted": (await asked(YEAR, { kind: "phone", unit: "iphone-0001" })).answer,
      "storage.counting": (await asked(COUNTING, { kind: "phone", unit: "iphone-0001" })).answer,
    };
    for (const [name, answer] of Object.entries(pinned)) {
      const fixture = clientFixture(`pages/${name}`, answer);
      expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
    }
  });
});
