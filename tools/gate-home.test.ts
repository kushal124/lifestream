import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import type { ChatDay } from "@lifestreamprotocol/families";
import { readDayHead } from "../packages/home/derive.js";
import { PEOPLE, preparedDirOf, preparedFileOf, readPrepared } from "../packages/home/prepared.js";
import type { Searched } from "@lifestreamprotocol/families";
import { afterAll, describe, expect, it } from "vitest";
import { screenFileOf } from "../packages/home/screen-index.js";
import { CALLS_COLLECTIONS, physicalFamily } from "@lifestreamprotocol/families";
import { FETCH_ROWS } from "../packages/home/counting.js";
import { SearchIndex, searchFileOf } from "../packages/home/search-index.js";
import type { CountContext } from "../packages/home/counting.js";
import { countAsked, countOf, shown } from "../packages/home/test/record-reads.js";
import { rowsCounted } from "../packages/home/work.js";
import { copyToAsk, END, FILED_DAYS, gateHome, keyOf, NOW_MS, SIZES, type GateSize } from "./gate-home.js";


const SIZE: GateSize = { years: 1, messages: 400, mails: 40, stays: 20, calls: 20, payments: 20, people: 12, chats: 8, screen: { days: 5, segments: 6 } };
const dirs: string[] = [];
const cache = () => {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-gate-home-"));
  dirs.push(dir);
  return dir;
};
let shared: ReturnType<typeof gateHome> | undefined;
const sharedHome = () => (shared ??= gateHome({ size: SIZE, seed: 7, cache: cache() }));
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("the gate's home", () => {
  it("G1 G2 G3 the same seed is the same life, another seed another; a kept home is taken", () => {
    const here = cache();
    const first = gateHome({ size: SIZE, seed: 7, cache: here });
    const again = gateHome({ size: SIZE, seed: 7, cache: cache() });
    expect(first.kept).toBe(false);
    expect(again.digest).toBe(first.digest);
    expect(again.counts).toEqual(first.counts);
    expect(gateHome({ size: SIZE, seed: 8, cache: cache() }).digest).not.toBe(first.digest);
    const kept = gateHome({ size: SIZE, seed: 7, cache: here });
    expect(kept).toMatchObject({ kept: true, digest: first.digest, key: first.key });
    expect(keyOf({ ...SIZE, messages: 401 }, 7)).not.toBe(first.key);
  });

  it("G4 the index holds each fact the generator counted, once", () => {
    const home = sharedHome();
    const db = new Database(searchFileOf(home.root, home.machine), { readonly: true });
    try {
      const held = Object.fromEntries((db.prepare('SELECT "of", count(*) AS n FROM fact GROUP BY "of"').all() as { of: string; n: number }[]).map((row) => [row.of, row.n]));
      expect(held).toEqual(home.counts);
      expect(home.counts.messages).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  it("G5 each of the last days has a day file the door reads, its lines the day's", async () => {
    const home = sharedHome();
    const db = new Database(join(home.root, "home.db"), { readonly: true });
    try {
      const listed = (db.prepare("SELECT day, inputs, counts FROM days WHERE day >= ? ORDER BY day").all(home.filed.from) as { day: string; inputs: string; counts: string }[])
        .map((row) => ({ day: row.day, inputs: row.inputs, total: (JSON.parse(row.counts) as { total: number }).total }));
      expect(listed).toHaveLength(FILED_DAYS);
      expect(listed.at(-1)!.day).toBe(END);
      for (const { day, inputs, total } of listed) expect(await readDayHead(openHomeFolder(home.root), day)).toMatchObject({ day, inputs, counts: { total } });
      expect(home.filed.lines).toBe(Math.max(...listed.map((each) => each.total)));
    } finally {
      db.close();
    }
  });

  it("G6 the chat-days hold each message once, in its chat and its UTC day", () => {
    const home = sharedHome();
    const db = openHome(openHomeFolder(home.root), "read");
    try {
      const keys = new Set<string>();
      let messages = 0;
      for (const row of db.view().extracts("messages")) {
        const content = row.content as unknown as ChatDay;
        expect(row.unit).toBe(`${content.day}:${content.network}:${content.chat}`);
        for (const message of content.messages) {
          expect(new Date(message.at).toISOString().slice(0, 10)).toBe(content.day);
          keys.add(message.key);
          messages++;
        }
      }
      expect(messages).toBe(home.counts.messages);
      expect(keys.size).toBe(messages);
    } finally {
      db.close();
    }
  });

  it("G7 every person in People's file holds the crowd's number, as many as the home says", () => {
    const home = sharedHome();
    const file = preparedFileOf(preparedDirOf(home.root, home.machine, "people"), "people");
    const people = readPrepared(openHomeFolder(dirname(file)), file, PEOPLE.format, (read) => read.value<{ people: Searched[] }>("names", "all")?.people ?? [])!.value;
    const digits = home.crowd.name.replace(/\D/gu, "");
    expect(people).toHaveLength(SIZE.people);
    expect(people.filter((person) => person.phones.some((phone) => phone.startsWith(digits)))).toHaveLength(home.crowd.people);
    expect(home.crowd.people).toBe(SIZE.people);
  });

  it("G8 the screen's year holds each day's segments, and its common word and its name on the windows the home says", () => {
    const home = sharedHome();
    const db = new Database(screenFileOf(searchFileOf(home.root, home.machine)), { readonly: true });
    try {
      const days = db.prepare("SELECT day, count(*) AS n FROM screen_segment GROUP BY day ORDER BY day").all() as { day: string; n: number }[];
      expect(days).toHaveLength(SIZE.screen.days);
      expect(days.every((each) => each.n === SIZE.screen.segments)).toBe(true);
      expect([days[0]!.day, days.at(-1)!.day]).toEqual([home.screen.from, END]);
      const matched = (word: string) => (db.prepare("SELECT count(*) AS n FROM screen_fts WHERE screen_fts MATCH ?").get(`"${word}"`) as { n: number }).n;
      expect(home.screen.common_windows).toBeGreaterThan(0);
      expect(home.screen.name_windows).toBeGreaterThan(0);
      expect(matched(home.screen.common)).toBeGreaterThan(0);
      expect(matched(home.screen.name)).toBeGreaterThan(0);
      expect(home.screen.name).toBe(home.common);
    } finally {
      db.close();
    }
  });

  it("G11 her, of the common given name, is one person in records, her phone hers alone, her name's words no other person's, among others of that name", () => {
    const home = sharedHome();
    const file = preparedFileOf(preparedDirOf(home.root, home.machine, "people"), "people");
    const people = readPrepared(openHomeFolder(dirname(file)), file, PEOPLE.format, (read) => read.value<{ people: Searched[] }>("names", "all")?.people ?? [])!.value;
    const words = home.her.name.toLowerCase().split(/[^\p{L}\p{N}]+/u);
    expect(home.her.name.split(" ")[0]).toBe(home.common);
    expect(home.her.records).toBeGreaterThan(0);
    expect(people.filter((person) => person.id === home.her.id)).toHaveLength(1);
    expect(people.filter((person) => person.phones.includes(home.her.phone.slice(1))).map((person) => person.id)).toEqual([home.her.id]);
    expect(people.filter((person) => person.id !== home.her.id && words.every((word) => person.words.includes(word)))).toEqual([]);
    expect(people.filter((person) => person.words[0] === home.common.toLowerCase()).length).toBeGreaterThan(1);
  });

  it("G9 the stay of four weeks is one fact, whole, on the day it began, at a place no other stay is, its minutes in the gate's range as the home says", () => {
    const home = sharedHome();
    const db = new Database(searchFileOf(home.root, home.machine), { readonly: true });
    try {
      const long = db.prepare(`SELECT id, day, start_ms, end_ms FROM fact WHERE "of" = 'stays' AND end_ms - start_ms > 7 * 86400000`).all() as { id: string; day: string; start_ms: number; end_ms: number }[];
      expect(long).toHaveLength(1);
      expect(long[0]!.day).toBe(home.long.from);
      expect(new Date(long[0]!.end_ms).toISOString().slice(0, 10)).toBe(home.long.to);
      expect(home.long.inside > home.long.from && home.long.inside < home.long.to).toBe(true);
      const at = db.prepare(`SELECT f.id AS fact FROM fact f JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of JOIN names n ON n.id = k.name WHERE f.of = 'stays' AND k.key = 'place' AND n.name = ?`).all(home.long.place) as { fact: string }[];
      expect(at.map((each) => each.fact)).toEqual([long[0]!.id]);
      expect(home.long.minutes).toBe((long[0]!.end_ms - Date.parse(`${home.long.inside}T00:00:00Z`)) / 60_000);
    } finally {
      db.close();
    }
  });

  it("G10 the gate's largest sum of a clock measure, a whole life of calls or of stays, reads inside a count's budget at the full size", () => {
    const home = sharedHome();
    const index = SearchIndex.read(openHomeFolder(home.root), searchFileOf(home.root, home.machine))!;
    const collections = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...physicalFamily({ photos: [] })([]).collections! }));
    const context: CountContext = {
      collections, settings: { zone: "UTC", day_start_hour: 0 }, now_ms: NOW_MS,
      people: () => ({ version: "people-0", idOf: () => undefined, person: () => undefined, find: () => [] }),
    };
    const file = new Database(index.file, { readonly: true });
    const daysHeld = file.prepare("SELECT count(*) FROM days WHERE day >= ? AND day <= ?").pluck().get(home.first, home.last) as number;
    file.close();
    try {
      for (const of of ["calls", "stays"] as const) {
        for (const by of [{}, { by: "day" }]) {
          const before = rowsCounted();
          const answer = shown(countOf(index, countAsked({ of, measure: "minutes", op: "sum", from: home.first, to: home.last, ...by }, collections), context)) as unknown as { total: { n: number } };
          const rows = rowsCounted() - before - daysHeld;
          const facts = home.counts[of]!;
          expect(facts).toBeGreaterThan(0);
          expect(answer.total.n).toBe(facts);
          expect(Math.ceil((rows / facts) * SIZES.full[of]), `${of} ${JSON.stringify(by)}: ${rows} rows for ${facts}`).toBeLessThanOrEqual(FETCH_ROWS);
        }
      }
    } finally {
      index.close();
    }
  });

  it("G12 the gate asks a copy of the kept home, so no run's asks change the next run's home", () => {
    const here = cache();
    const kept = gateHome({ size: SIZE, seed: 7, cache: here });
    const { home, drop } = copyToAsk(kept, here);
    expect(home.root).not.toBe(kept.root);
    expect(home.digest).toBe(kept.digest);
    expect(existsSync(searchFileOf(home.root, home.machine))).toBe(true);
    writeFileSync(join(home.root, "asked.txt"), "changed by an ask");
    expect(existsSync(join(kept.root, "asked.txt"))).toBe(false);
    drop();
    expect(existsSync(home.root)).toBe(false);
    expect(gateHome({ size: SIZE, seed: 7, cache: here })).toMatchObject({ kept: true, key: kept.key, root: kept.root });
  });

  it("G13 a new home keeps only the newest of its size, never one a live run is asking, and sweeps what dead runs left", () => {
    const here = cache();
    const dead = 999_999_999;
    const first = gateHome({ size: SIZE, seed: 7, cache: here });
    const other = gateHome({ size: { ...SIZE, messages: 300 }, seed: 7, cache: here });
    mkdirSync(join(here, `${first.key}.building-${dead}`));
    mkdirSync(join(here, "asking", `${dead}-${first.key}`), { recursive: true });
    const asked = copyToAsk(first, here);
    const second = gateHome({ size: SIZE, seed: 8, cache: here });
    expect(readdirSync(here).sort()).toEqual([first.key, other.key, second.key, "asking"].sort());
    expect(readdirSync(join(here, "asking"))).toEqual([`${process.pid}-${first.key}`]);
    asked.drop();
    gateHome({ size: SIZE, seed: 8, cache: here });
    expect(readdirSync(here).sort()).toEqual([other.key, second.key, "asking"].sort());
  });
});
