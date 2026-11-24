import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { civilDay, dayBounds, DAYS_MARK, openHome, openHomeFolder, type DaySettings, type RecordRef } from "@lifestreamprotocol/core";
import { declarations, providers, vendorOf } from "@lifestreamprotocol/connect";
import { listeningFamily, type DayFileFact } from "@lifestreamprotocol/families";
import type { PeopleMap } from "./counting.js";
import { kindsAnswer, kindsPage, kindsParams, type Kind, type KindsAnswer, type KindsHit, type KindsPage, type ListeningPage, type RecordPage, type ScreenPage } from "./kinds-contract.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { readRef } from "./refs.js";
import { fedBy } from "./registry-home.js";
import { ScreenIndex, type ScreenFrame, type ScreenSegment } from "./screen-index.js";
import type { SittingSpan } from "./screen-sittings.js";
import { paramsOf } from "./search-contract.js";
import { SearchIndex, type AtomEntry, type RecordEntry } from "./search-index.js";
import { kindsOf } from "./search-kinds.js";
import { PAGE_ROWS } from "./search-scan.js";
import { onCall, type CallOf } from "./test/calls.js";
import { rowsCounted } from "./work.js";


const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const MIN = 60_000;
const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-14T12:00:00Z");
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const MACHINE = "mac-0001";
const OTHER = "mac-bb17";
const sourceOf = (machine: string) => `screen:local:${machine}`;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-kinds-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let seq = 0;
function fresh(name: string): SearchIndex {
  const file = join(scratch, name, "index.db");
  mkdirSync(join(scratch, name), { recursive: true });
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  built.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
  built.finish();
  return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
}
const put = (index: SearchIndex, puts: RecordEntry[]) => {
  for (let at = 0; at < puts.length; at += 5_000) index.records(puts.slice(at, at + 5_000), [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
};
const record = (key: string, words: string, start_ms: number, family = "notes", title = ""): RecordEntry => ({
  record: { source: `${family}:local:${MACHINE}`, kind: "item", key }, family, version: `v-${key}`, start_ms, end_ms: null, title, text: words, who: [], link: null,
});
const unitOf = (first_ms: number, machine = MACHINE) => `${sourceOf(machine)}/${first_ms}`;
function sittingDay(index: SearchIndex, day: string, lines: { first_ms: number; text: string; machine?: string; at?: number }[]): void {
  const atoms: AtomEntry[] = lines.map(({ first_ms, text, machine, at }, n) => ({ n, family: "screen", unit: unitOf(first_ms, machine), item: unitOf(first_ms, machine), start_ms: at ?? first_ms, end_ms: (at ?? first_ms) + 30 * MIN, text }));
  expect(index.day(day, { inputs: `in-${day}-${++seq}`, mtime_us: seq, atoms })).toBe(true);
}

interface Window {
  at: readonly number[];
  title: string;
  words: string;
  machine?: string;
}
let screens = 0;
function screenFile(windows: readonly Window[]): string {
  const file = join(scratch, `screen-${++screens}`, "screen.db");
  mkdirSync(join(scratch, `screen-${screens}`), { recursive: true });
  const held: ScreenSegment[] = windows.flatMap((window) => window.at.map((from) => {
    const frames: ScreenFrame[] = Array.from({ length: 5 }, (_, f) => ({ t: from + f * 4_000, app: "Example Browser", site: null, title: window.title, display: "1", lines: [window.words] }));
    return { machine: window.machine ?? MACHINE, version: "v1", start_ms: from, frames };
  }));
  const source = { segments: (machine: string, day: string) => held.filter((each) => each.machine === machine && civilDay(each.start_ms, UTC) === day) };
  const build = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: UTC, meaning: false }, () => true);
  build.apply(held, source, { seq: 7 });
  build.finish();
  ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: UTC, meaning: false }, () => true).close();
  return file;
}
const onDay = (each: SittingSpan, day: string) => civilDay(each.start_ms, UTC) <= day && day <= civilDay(each.end_ms, UTC);
const spanned = (spans: readonly SittingSpan[], machines: readonly string[] = [MACHINE]) => () => ({
  machines: () => machines,
  holding: (machine: string, day: string, from_ms: number, to_ms: number) => spans.filter((each) => each.unit.startsWith(`${sourceOf(machine)}/`) && onDay(each, day) && each.start_ms <= to_ms && from_ms <= each.end_ms),
  reach: (day: string, at_ms: number) => spans.filter((each) => onDay(each, day) && each.start_ms <= at_ms && at_ms <= each.end_ms).reduce((most, each) => Math.max(most, each.end_ms + 1), at_ms),
});

interface Played {
  key: string;
  track: string;
  artist: string;
  at: number;
}
const PLAYER = `now-playing:local:${MACHINE}`;
const LISTENING = [listeningFamily(fedBy(providers()).listening)];
function homeHolding(name: string, sources: readonly string[]): string {
  const root = join(scratch, `${name}-home`);
  mkdirSync(join(root, "days"), { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => {
    tx.tables.meta.set(DAYS_MARK, "test");
    for (const id of sources) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: "now-playing", added_ms: 0 });
  });
  home.close();
  return join(root, "home.db");
}
const listening = (name: string, sources: readonly string[] = [PLAYER]): Partial<CallOf> => ({ families: LISTENING, home: homeHolding(name, sources) });
function playsDay(index: SearchIndex, day: string, plays: readonly Played[], line: string): void {
  const recordOf = (play: Played): RecordRef => ({ source: PLAYER, kind: "now-playing", key: play.key });
  put(index, plays.map((play) => ({ record: recordOf(play), family: "listening", version: `v-${play.key}`, start_ms: play.at, end_ms: null, title: play.track, text: `${play.track} · ${play.artist}`, who: [], link: null })));
  const unit = `${PLAYER}/${day}`;
  const facts: DayFileFact[] = plays.map((play) => ({
    id: `plays:${play.key.padStart(24, "0")}`, family: "listening", of: "plays", time_ms: play.at, start_ms: play.at, end_ms: play.at + 3 * MIN,
    keys: play.track === "" ? { artist: play.artist } : { track: play.track, artist: play.artist }, measures: { times: 1, minutes: 3 }, who: [], from: { units: [unit], record: recordOf(play) }, lines: [],
  }));
  const atoms: AtomEntry[] = [{ n: 0, family: "listening", unit, item: unit, start_ms: plays[0]!.at, end_ms: plays.at(-1)!.at + 3 * MIN, text: line }];
  const { start_ms, end_ms } = dayBounds(day, UTC);
  expect(index.day(day, { inputs: `in-${day}-${++seq}`, mtime_us: seq, atoms, facts: { window: { start_ms, end_ms }, facts } })).toBe(true);
}
function owed(name: string, day: string): void {
  const db = new Database(join(scratch, name, "index.db"));
  try {
    db.prepare("INSERT INTO facts_owed (day) VALUES (?)").run(day);
  } finally {
    db.close();
  }
}

let empty: string | undefined;

interface Asking {
  screen?: string;
  spans?: readonly SittingSpan[];
  machines?: readonly string[];
  photo?: (record: RecordRef) => string | undefined;
  more?: Partial<CallOf>;
}

async function ask(index: SearchIndex, params: Record<string, string | string[]>, how: Asking = {}): Promise<KindsAnswer | KindsPage> {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) for (const each of [value].flat()) query.append(name, each);
  const screen = how.screen ?? (empty ??= screenFile([]));
  const over: CallOf = { index, epoch: 1, now_ms: NOW, screen, ...how.more };
  const answer = await onCall(over, (call) => kindsOf(paramsOf(kindsParams, query), call, { sittings: spanned(how.spans ?? [], how.machines), photo: how.photo ?? (() => undefined) }));
  const written = JSON.parse(JSON.stringify(answer)) as unknown;
  return params.see !== undefined || params.cursor !== undefined ? kindsPage.parse(written) : kindsAnswer.parse(written);
}
const page = async (index: SearchIndex, cursor: string, how?: Asking) => (await ask(index, { cursor }, how)) as ScreenPage;
async function seeAll<P extends KindsPage>(index: SearchIndex, params: Record<string, string>, how: Asking = {}): Promise<P[]> {
  const pages = [(await ask(index, params, how)) as P];
  for (let last = pages.at(-1)!; "next" in last && last.next !== null && pages.length < 80; last = pages.at(-1)!) pages.push((await ask(index, { cursor: last.next }, how)) as P);
  return pages;
}
const pagesOf = (index: SearchIndex, query: string, how: Asking) => seeAll<ScreenPage>(index, { query, see: "screen" }, how);
const focusOf = (pages: readonly ScreenPage[]) => pages.flatMap((each) => each.sittings.map((row) => row.focus ?? null));
const first = async (index: SearchIndex, params: Record<string, string | string[]>, how?: Asking) => (await ask(index, params, how)) as KindsAnswer;
const kindOf = (answer: KindsAnswer, family: string): Kind | undefined => answer.kinds.find((each) => each.family === family);
const keyOf = (ref: string) => readRef(ref, "ref", ["record"]).parts.key;
const nOf = (kind: Kind | undefined) => (kind === undefined || !("n" in kind) || kind.n === undefined ? undefined : typeof kind.n === "number" ? kind.n : kind.n.n);
const hitsOf = (kind: Kind | undefined) => (kind !== undefined && "hits" in kind ? kind.hits.map((hit) => keyOf(hit.ref)) : []);

describe("the kinds route", () => {
  it("H1 a kind of 4 among 10,000 entries lists its best 3, its n 4", async () => {
    const index = fresh("h1");
    put(index, [
      ...Array.from({ length: 9_996 }, (_, n) => record(`m${n}`, "lantern lantern lantern by the water", D("2026-11-01") + n * 1_000, "messages")),
      ...Array.from({ length: 4 }, (_, n) => record(`n${n}`, `a lantern note ${n}`, D(`2025-01-0${n + 1}`), "notes")),
    ]);
    const answer = await first(index, { query: "lantern" });
    expect(nOf(kindOf(answer, "notes"))).toBe(4);
    expect(hitsOf(kindOf(answer, "notes"))).toHaveLength(3);
    expect(answer.top.every((row) => "hit" in row && row.hit.family === "messages")).toBe(true);
    expect(answer.kinds.map((each) => each.family)).toEqual(["messages", "notes"]);
  });

  it("H2 top is people, then places, then hits, three in all, none again in its kind; a kind whose best are in top states n and no row", async () => {
    const index = fresh("h2");
    put(index, [
      record("best", "harbor harbor harbor harbor", D("2026-11-10"), "voice"),
      ...Array.from({ length: 5 }, (_, n) => record(`m${n}`, `the harbor ${n}`, D("2026-10-01") + n * DAY_MS, "messages")),
    ]);
    const people: PeopleMap = {
      version: "p1", idOf: (id) => id, person: (id) => (id === "person:harbor" ? { name: "Harbor Person", handles: ["phone:+15550000003"] } : undefined),
      find: (name) => (name.toLowerCase().includes("harbor") ? ["person:harbor"] : []),
    };
    const answer = await first(index, { query: "harbor" }, { more: { people, places: [{ slug: "harbor-cafe", name: "Harbor Cafe", days: 3 }] } });
    expect(answer.top.map((row) => Object.keys(row)[0])).toEqual(["person", "place", "hit"]);
    expect(answer.top[1]).toEqual({ place: { ref: expect.stringMatching(/^place\./u), name: "Harbor Cafe", days: 3 } });
    expect(answer.top[2]).toMatchObject({ hit: { family: "voice" } });
    expect(kindOf(answer, "voice")).toEqual({ family: "voice", n: 1, hits: [] });
    expect(hitsOf(kindOf(answer, "messages"))).toHaveLength(3);
    expect(answer.kinds.map((each) => each.family)).toEqual(["messages", "voice"]);
    expect(answer.total).toBe(6);
  });

  it("H3 20,000 listening log entries spend no cap and are no row anywhere: the 4 messages are listed whole", async () => {
    const index = fresh("h3");
    put(index, [
      ...Array.from({ length: 20_000 }, (_, n) => record(`l${n}`, "Harbor Song by Artist P", NOW - n * MIN, "listening", "Harbor Song")),
      ...Array.from({ length: 4 }, (_, n) => record(`m${n}`, `meet at the harbor ${n}`, D("2026-06-01") + n * DAY_MS, "messages")),
    ]);
    const answer = await first(index, { query: "harbor" });
    expect(answer.kinds.map((each) => [each.family, nOf(each)])).toEqual([["messages", 4]]);
    expect(answer.capped).toBe(false);
    expect(JSON.stringify(answer)).not.toContain("listening");
  });

  it("H4 a sitting whose summary and two windows match is one row, n 1, windows 2", async () => {
    const index = fresh("h4");
    const start = D("2026-11-12", "08:30");
    sittingDay(index, "2026-11-12", [{ first_ms: start, text: "Summary: Planned the harbor trip" }]);
    const screen = screenFile([{ at: [start + 5 * MIN], title: "Harbor map", words: "harbor map of the bay" }, { at: [start + 10 * MIN], title: "Harbor tickets", words: "harbor ferry tickets" }]);
    const answer = await first(index, { query: "harbor" }, { screen, spans: [{ unit: unitOf(start), start_ms: start, end_ms: start + 30 * MIN }] });
    const kind = kindOf(answer, "screen")!;
    expect(nOf(kind)).toBe(1);
    expect("sittings" in kind && kind.sittings).toEqual([expect.objectContaining({
      focus: `u:${unitOf(start)}`, day: "2026-11-12", summary: "Planned the harbor trip", snippet: "Planned the «harbor» trip", windows: 2,
    })]);
    const windows = "sittings" in kind ? kind.sittings![0]!.matched : [];
    expect(windows.map((window) => window.title).sort()).toEqual(["Harbor map", "Harbor tickets"]);
    for (const window of windows) {
      const [, unit, from, to] = /^u:(.+)@(\d+)-(\d+)$/u.exec(window.focus ?? "") ?? [];
      const minute = Date.parse(window.at!);
      expect([unit, Number(from) >= minute && Number(from) < minute + MIN, Number(to) > Number(from) && Number(to) <= Number(from) + MIN], `${window.title} opens its day at its own span in its sitting`)
        .toEqual([unitOf(start), true, true]);
    }
    expect(answer.top).toEqual([]);
  });

  it("H4 a window whose matched rows fall in two sittings counts in each, once; a time no sitting holds is a row of its own; a sitting with no summary says its first window's app; see=screen pages the same sittings, newest first", async () => {
    const index = fresh("h4b");
    const one = D("2026-11-10", "09:00"), two = D("2026-11-10", "11:00");
    const screen = screenFile([
      { at: [one + 5 * MIN], title: "Harbor notes", words: "harbor notes for the week" },
      { at: [two + 5 * MIN], title: "Harbor notes", words: "harbor notes for the weekend" },
      { at: [D("2026-11-11", "15:00")], title: "Harbor news", words: "harbor news today" },
    ]);
    const spans = [{ unit: unitOf(one), start_ms: one, end_ms: one + 30 * MIN }, { unit: unitOf(two), start_ms: two, end_ms: two + 30 * MIN }];
    const answer = await first(index, { query: "harbor" }, { screen, spans });
    const kind = kindOf(answer, "screen")!;
    expect(nOf(kind)).toBe(3);
    const rows = "sittings" in kind ? kind.sittings! : [];
    expect(rows.map((row) => [row.focus ?? null, row.windows]).sort()).toEqual([[null, 1], [`u:${unitOf(one)}`, 1], [`u:${unitOf(two)}`, 1]].sort());
    expect(rows.filter((row) => row.focus !== undefined).map((row) => [row.summary, row.matched.map((each) => each.title)])).toEqual([["Example Browser", ["Harbor notes"]], ["Example Browser", ["Harbor notes"]]]);
    const page = (await ask(index, { query: "harbor", see: "screen" }, { screen, spans })) as ScreenPage;
    expect(page.sittings.map((row) => row.focus ?? null)).toEqual([null, `u:${unitOf(two)}`, `u:${unitOf(one)}`]);
    expect(page.next).toBeNull();
  });

  it("H4 25 windows in 6 sittings on 2 machines and 2 sittings by their lines: n 8, each sitting's windows whole, one page newest first", async () => {
    const index = fresh("h4c");
    const starts = [
      { machine: MACHINE, at: D("2026-11-12", "08:00"), windows: 5 }, { machine: OTHER, at: D("2026-11-12", "08:30"), windows: 4 },
      { machine: MACHINE, at: D("2026-11-12", "09:00"), windows: 4 }, { machine: OTHER, at: D("2026-11-12", "09:30"), windows: 4 },
      { machine: MACHINE, at: D("2026-11-12", "10:00"), windows: 4 }, { machine: OTHER, at: D("2026-11-12", "10:30"), windows: 4 },
    ];
    const lined = [{ machine: MACHINE, at: D("2026-11-11", "08:00") }, { machine: OTHER, at: D("2026-11-13", "08:00") }];
    sittingDay(index, "2026-11-12", starts.map(({ machine, at }) => ({ first_ms: at, text: "Summary: Read the week's pages", machine })));
    for (const { machine, at } of lined) sittingDay(index, civilDay(at, UTC), [{ first_ms: at, text: "Summary: Planned the harbor trip", machine }]);
    const screen = screenFile(starts.flatMap(({ machine, at, windows }, s) => Array.from({ length: windows }, (_, w) => ({
      machine, at: [at + (w + 1) * 2 * MIN], title: `Harbor page ${s}-${w}`, words: `harbor page ${s} ${w}`,
    }))));
    const spans = [...starts, ...lined].map(({ machine, at }) => ({ unit: unitOf(at, machine), start_ms: at, end_ms: at + 25 * MIN }));
    const whole = new Map<string, number>([...starts.map(({ machine, at, windows }) => [`u:${unitOf(at, machine)}`, windows] as const), ...lined.map(({ machine, at }) => [`u:${unitOf(at, machine)}`, 0] as const)]);
    const answer = await first(index, { query: "harbor" }, { screen, spans });
    const kind = kindOf(answer, "screen")!;
    expect("n" in kind && kind.n).toBe(8);
    const rows = "sittings" in kind ? kind.sittings! : [];
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row.windows).toBe(whole.get(row.focus!));
    expect(rows.filter((row) => row.windows === 0).map((row) => [row.summary, row.snippet])).toEqual([["Planned the harbor trip", "Planned the «harbor» trip"], ["Planned the harbor trip", "Planned the «harbor» trip"]]);
    const page = (await ask(index, { query: "harbor", see: "screen" }, { screen, spans })) as ScreenPage;
    expect(page.sittings.map((row) => [row.focus, row.windows])).toEqual([...whole].sort(([one], [other]) => Number(other!.split("/").at(-1)) - Number(one!.split("/").at(-1))));
    expect(page.sittings.filter((row) => row.windows > 0).every((row) => row.summary === "Read the week's pages" && row.matched.length === 3)).toBe(true);
    expect(page.next).toBeNull();
  });

  it("H4 see=screen pages by sitting, newest first across pages and stretches, each sitting once", async () => {
    const index = fresh("h4d");
    const days = Array.from({ length: 45 }, (_, n) => civilDay(D("2026-11-13") - n * DAY_MS, UTC));
    const windowed = days.map((day) => D(day, "09:00"));
    const lined = [days[3]!, days[20]!, days[41]!].map((day) => D(day, "20:00"));
    const older = D("2025-06-01", "09:00");
    for (const at of lined) sittingDay(index, civilDay(at, UTC), [{ first_ms: at, text: "Summary: Planned the harbor trip" }]);
    const screen = screenFile([...windowed, older].map((at, n) => ({ at: [at + 5 * MIN], title: `Harbor log ${n}`, words: `harbor log ${n}` })));
    const spans = [...windowed, ...lined, older].map((at) => ({ unit: unitOf(at), start_ms: at, end_ms: at + 30 * MIN }));
    const answer = await first(index, { query: "harbor" }, { screen, spans });
    expect(kindOf(answer, "screen")).toMatchObject({ n: { n: 48, partial: true } });
    const pages: ScreenPage[] = [(await ask(index, { query: "harbor", see: "screen" }, { screen, spans })) as ScreenPage];
    while (pages.at(-1)!.next !== null && pages.length < 10) pages.push((await ask(index, { cursor: pages.at(-1)!.next! }, { screen, spans })) as ScreenPage);
    expect(pages.map((page) => page.sittings.length)).toEqual([20, 20, 8, 1]);
    const at = pages.flatMap((page) => page.sittings).map((row) => Date.parse(row.at));
    expect(at).toEqual([...at].sort((one, other) => other - one));
    expect(new Set(pages.flatMap((page) => page.sittings.map((row) => row.focus))).size).toBe(49);
    expect(pages.at(-1)!.sittings[0]!.focus).toBe(`u:${unitOf(older)}`);
  });

  it("an unread screen's page is the sittings whose lines matched, newest first, paged, its unread stated", async () => {
    const index = fresh("unread-page");
    const lined = Array.from({ length: 25 }, (_, n) => D("2026-11-13", "08:00") - n * DAY_MS);
    for (const at of lined) sittingDay(index, civilDay(at, UTC), [{ first_ms: at, text: "Summary: Planned the harbor trip" }]);
    const one = (await ask(index, { query: "harbor", see: "screen" }, { screen: "none" })) as ScreenPage;
    expect(one.unread).toBe("Screen search is getting ready.");
    expect(one.sittings.map((row) => row.focus)).toEqual(lined.slice(0, 20).map((at) => `u:${unitOf(at)}`));
    const two = (await ask(index, { cursor: one.next! }, { screen: "none" })) as ScreenPage;
    expect(two).toMatchObject({ next: null, unread: "Screen search is getting ready." });
    expect(two.sittings.map((row) => row.focus)).toEqual(lined.slice(20).map((at) => `u:${unitOf(at)}`));
  });

  it("N1 rows tied at a page's end: the next page stays in the stretch and lists its sittings by lines below the tie", async () => {
    const index = fresh("n1");
    const tie = D("2026-11-12", "09:00");
    const lined = D("2026-11-11", "09:00");
    sittingDay(index, "2026-11-11", [{ first_ms: lined, text: "Summary: Planned the harbor trip" }]);
    const screen = screenFile([
      ...Array.from({ length: 19 }, (_, n) => ({ at: [tie + (n + 1) * MIN], title: `Harbor page ${n}`, words: `harbor page ${n}` })),
      ...[MACHINE, OTHER, "mac-cc03"].map((machine, n) => ({ at: [tie], title: `Harbor display ${n}`, words: `harbor display ${n}`, machine })),
    ]);
    const pages = await pagesOf(index, "harbor", { screen });
    expect(pages.map((each) => each.sittings.length)).toEqual([22, 1]);
    expect(pages[1]!.sittings[0]!.focus).toBe(`u:${unitOf(lined)}`);
  });

  it("N2 the sittings by lines are read newest first below the page's end: a cut scan ends the page at what it read, so 30 sittings of 18,000 lines page whole, in order", async () => {
    const index = fresh("n2");
    const starts = Array.from({ length: 30 }, (_, n) => D("2026-11-13", "08:00") - n * DAY_MS);
    starts.forEach((at, n) => sittingDay(index, civilDay(at, UTC), Array.from({ length: 600 }, (_, k) => ({
      first_ms: at, at: at + k * 1_000, text: n < 15 ? `the long and winding notes on the harbor walk and the boats ${k}` : `harbor ${k}`,
    }))));
    const pages = await pagesOf(index, "harbor", { screen: "none" });
    expect(pages.some((each) => each.next !== null && each.sittings.length < 20)).toBe(true);
    expect(focusOf(pages)).toEqual(starts.map((at) => `u:${unitOf(at)}`));
  });

  it("N2 a sitting that starts before a page's end and matched only after it is the next page's", async () => {
    const index = fresh("n2-reach");
    const starts = Array.from({ length: 20 }, (_, n) => D("2026-11-13", "08:00") - n * DAY_MS);
    const long = starts.at(-1)! - 60 * MIN;
    for (const at of starts.slice(0, -1)) sittingDay(index, civilDay(at, UTC), [{ first_ms: at, text: "Summary: Planned the harbor trip" }]);
    sittingDay(index, civilDay(long, UTC), [
      { first_ms: starts.at(-1)!, text: "Summary: Planned the harbor trip" },
      { first_ms: long, text: "Summary: Read the week's pages" }, { first_ms: long, at: long + 90 * MIN, text: "the harbor map" },
    ]);
    const spans = [...starts.map((at) => ({ unit: unitOf(at), start_ms: at, end_ms: at + 30 * MIN })), { unit: unitOf(long), start_ms: long, end_ms: long + 120 * MIN }];
    const pages = await pagesOf(index, "harbor", { screen: "none", spans });
    expect(pages.map((each) => each.sittings.length)).toEqual([20, 1]);
    expect(pages[1]!.sittings[0]!.focus).toBe(`u:${unitOf(long)}`);
  });

  it("N3 a page read while the screen was unread goes on when it is ready: the first stretch below the page's end, nothing expired", async () => {
    const index = fresh("n3");
    const lined = Array.from({ length: 25 }, (_, n) => D("2026-11-13", "08:00") - n * DAY_MS);
    for (const at of lined) sittingDay(index, civilDay(at, UTC), [{ first_ms: at, text: "Summary: Planned the harbor trip" }]);
    const screen = screenFile([{ at: [D("2026-11-13", "09:00")], title: "Harbor news", words: "harbor news" }, { at: [D("2026-10-22", "12:00")], title: "Harbor log", words: "harbor log" }]);
    const one = (await ask(index, { query: "harbor", see: "screen" }, { screen: "none" })) as ScreenPage;
    expect(one.unread).toBe("Screen search is getting ready.");
    const two = await page(index, one.next!, { screen });
    expect(two.unread).toBeUndefined();
    expect(focusOf([two])).toEqual([...lined.slice(20, 22).map((at) => `u:${unitOf(at)}`), null, ...lined.slice(22).map((at) => `u:${unitOf(at)}`)]);
    expect(two.next).toBeNull();
  });

  it("N4 a sitting that starts on the older stretch's last day and runs past midnight is listed once, by the older stretch, in order", async () => {
    const index = fresh("n4");
    const crossing = D("2025-11-13", "23:50");
    const later = D("2025-11-13", "23:55");
    const recent = D("2026-11-10", "09:00");
    const screen = screenFile([
      { at: [recent + 5 * MIN], title: "Harbor news", words: "harbor news" },
      { at: [crossing + 5 * MIN], title: "Harbor map", words: "harbor map" },
      { at: [D("2025-11-14", "00:10")], title: "Harbor tide", words: "harbor tide" },
      { at: [later + 3 * MIN], title: "Harbor ferry", words: "harbor ferry", machine: OTHER },
    ]);
    const spans = [
      { unit: unitOf(recent), start_ms: recent, end_ms: recent + 30 * MIN },
      { unit: unitOf(crossing), start_ms: crossing, end_ms: crossing + 40 * MIN },
      { unit: unitOf(later, OTHER), start_ms: later, end_ms: later + 4 * MIN },
    ];
    const pages = await pagesOf(index, "harbor", { screen, spans });
    expect(focusOf(pages)).toEqual([`u:${unitOf(recent)}`, `u:${unitOf(later, OTHER)}`, `u:${unitOf(crossing)}`]);
  });

  it("N5 a window is placed at its matched rows only: open all day, the word once, it is one sitting's", async () => {
    const index = fresh("n5");
    const morning = D("2026-11-12", "09:00"), ten = D("2026-11-12", "10:00");
    const screen = screenFile([{ at: [morning + 5 * MIN], title: "Chat", words: "lunch plans" }, { at: [ten + 5 * MIN], title: "Chat", words: "the harbor at noon" }]);
    const spans = [{ unit: unitOf(morning), start_ms: morning, end_ms: morning + 30 * MIN }, { unit: unitOf(ten), start_ms: ten, end_ms: ten + 30 * MIN }];
    expect(nOf(kindOf(await first(index, { query: "harbor" }, { screen, spans }), "screen"))).toBe(1);
    const pages = await pagesOf(index, "harbor", { screen, spans });
    expect(pages.flatMap((each) => each.sittings.map((row) => [row.focus, row.windows]))).toEqual([[`u:${unitOf(ten)}`, 1]]);
  });

  it("N6 a page whose next holds a stretch is refused NOT_NOW while the screen cannot be read, and its next still pages after", async () => {
    const index = fresh("n6");
    const days = Array.from({ length: 25 }, (_, n) => D("2026-11-13", "09:00") - n * DAY_MS);
    const screen = screenFile(days.map((at, n) => ({ at: [at], title: `Harbor log ${n}`, words: `harbor log ${n}` })));
    const one = (await ask(index, { query: "harbor", see: "screen" }, { screen })) as ScreenPage;
    expect(one.sittings).toHaveLength(20);
    await expect(page(index, one.next!, { screen: "busy" })).rejects.toMatchObject({ code: "NOT_NOW", words: "Screen search is busy: try again in a moment." });
    await expect(page(index, one.next!, { screen: "none" })).rejects.toMatchObject({ code: "NOT_NOW", words: "Screen search is getting ready." });
    const two = await page(index, one.next!, { screen });
    expect(two.sittings.map((row) => Date.parse(row.at))).toEqual(days.slice(20));
    expect(two.next).toBeNull();
  });

  it("a screen not read yet is stated in the person's words, and the rest stands", async () => {
    const index = fresh("unread");
    put(index, [record("m1", "the harbor at noon", D("2026-11-10"), "messages")]);
    const answer = await first(index, { query: "harbor" }, { screen: "none" });
    expect(kindOf(answer, "screen")).toEqual({ family: "screen", unread: "Screen search is getting ready." });
    expect(answer.total).toEqual({ n: 1, partial: true });
  });

  it("H5 a play counts by its own item's words: a session line naming two artists counts only the asked artist's plays, and a track the line leaves out is found", async () => {
    const index = fresh("h5");
    const at = D("2026-11-10", "08:00");
    const plays: Played[] = [
      { key: "p1", track: "Song One", artist: "The Pellows", at }, { key: "p2", track: "Song Two", artist: "Quarry Lane", at: at + 4 * MIN },
      { key: "p3", track: "Song Three", artist: "The Pellows", at: at + 8 * MIN }, { key: "p4", track: "Song Four", artist: "Quarry Lane", at: at + 12 * MIN },
      { key: "p5", track: "Lanternfish", artist: "The Pellows", at: at + 16 * MIN },
    ];
    playsDay(index, "2026-11-10", plays, "Listened to Song One, Song Two, Song Three and 2 others by The Pellows and Quarry Lane");
    const how: Asking = { more: listening("h5") };
    const pellows = await first(index, { query: "pellows" }, how);
    const kind = kindOf(pellows, "listening")!;
    expect(nOf(kind)).toBe(3);
    const tracks = "tracks" in kind ? kind.tracks : [];
    expect(tracks.map((each) => [each.track, each.artist, each.plays]).sort()).toEqual([["Lanternfish", "The Pellows", 1], ["Song One", "The Pellows", 1], ["Song Three", "The Pellows", 1]]);
    expect(tracks.every((each) => each.ref.startsWith("row."))).toBe(true);
    expect(pellows.top.every((row) => !("hit" in row) || row.hit.family !== "listening")).toBe(true);
    const lanternfish = kindOf(await first(index, { query: "lanternfish" }, how), "listening");
    expect(lanternfish).toEqual({ family: "listening", n: 1, tracks: [{ ref: expect.stringMatching(/^row\./u), track: "Lanternfish", artist: "The Pellows", plays: 1 }] });
  });

  it("H5 the plays are counted by the words the record scan read: words of no meaning left out, the last word a beginning while typing", async () => {
    const index = fresh("h5-words");
    const at = D("2026-11-10", "08:00");
    put(index, [record("m1", "lanternfish by the pellows on the radio", D("2026-11-09"), "messages")]);
    playsDay(index, "2026-11-10", [
      { key: "w1", track: "Lanternfish", artist: "The Pellows", at }, { key: "w2", track: "Song Two", artist: "Quarry Lane", at: at + 4 * MIN },
    ], "Listened to Lanternfish and Song Two by The Pellows and Quarry Lane");
    const how: Asking = { more: listening("h5-words") };
    const tracks = (kind: Kind | undefined) => (kind !== undefined && "tracks" in kind ? kind.tracks.map((each) => each.track) : []);
    const said = await first(index, { query: "lanternfish by the pellows" }, how);
    expect(nOf(kindOf(said, "messages"))).toBe(1);
    expect(tracks(kindOf(said, "listening"))).toEqual(["Lanternfish"]);
    const typing = await first(index, { query: "lanternf", typing: "1" }, how);
    expect(nOf(kindOf(typing, "messages"))).toBe(1);
    expect(tracks(kindOf(typing, "listening"))).toEqual(["Lanternfish"]);
  });

  it("H6 a count being made again makes listening unread in the person's words, and the rest stands", async () => {
    const index = fresh("h6-building");
    put(index, [record("m1", "the harbor at noon", D("2026-11-09"), "messages")]);
    playsDay(index, "2026-11-10", [{ key: "h1", track: "Harbor Song", artist: "The Pellows", at: D("2026-11-10", "08:00") }], "Listened to Harbor Song by The Pellows");
    owed("h6-building", "2026-11-08");
    const answer = await first(index, { query: "harbor" }, { more: listening("h6-building") });
    expect(kindOf(answer, "listening")).toEqual({ family: "listening", unread: "Your plays are being counted again. Try again in a few minutes." });
    expect(nOf(kindOf(answer, "messages"))).toBe(1);
    expect(answer.total).toEqual({ n: 1, partial: true });
  });

  it("H6 a count too broad for one call makes listening unread in the person's words, never the count's hint, and the rest stands", async () => {
    const index = fresh("h6-broad");
    put(index, [record("m1", "the harbor at noon", D("2026-11-09"), "messages")]);
    const at = D("2026-11-10", "00:10");
    playsDay(index, "2026-11-10", Array.from({ length: 3_000 }, (_, n) => ({ key: `b${n}`, track: `Harbor Song ${n}`, artist: "The Pellows", at: at + n * 20_000 })), "Listened to Harbor Song 0 by The Pellows");
    const budget = PAGE_ROWS / 2;
    const before = rowsCounted();
    expect(nOf(kindOf(await first(index, { query: "harbor" }, { more: listening("h6-broad-whole") }), "listening"))).toBe(3_000);
    expect(rowsCounted() - before).toBeGreaterThan(budget);
    const answer = await first(index, { query: "harbor" }, { more: { ...listening("h6-broad"), budget } });
    expect(kindOf(answer, "listening")).toEqual({ family: "listening", unread: "Too many plays match to count. Add a word or pick a time." });
    expect(nOf(kindOf(answer, "messages"))).toBe(1);
    expect(answer.total).toEqual({ n: 1, partial: true });
  });

  it("H6 a home holding no listening source states no listening kind, whatever the count's state, and its total is exact", async () => {
    const index = fresh("h6-none");
    put(index, [record("m1", "the harbor at noon", D("2026-11-09"), "messages")]);
    owed("h6-none", "2026-11-08");
    const answer = await first(index, { query: "harbor" }, { more: listening("h6-none", []) });
    expect(kindOf(answer, "listening")).toBeUndefined();
    expect(answer.total).toBe(1);
  });

  it("H12 a photo's hit states the image the route's photo reader gives its record; no other hit asks it", async () => {
    const index = fresh("h12");
    const hexOf = (key: string) => key.padEnd(64, "0").replace(/[^0-9a-f]/gu, "a");
    put(index, [
      ...Array.from({ length: 4 }, (_, n) => record(`p${n}`, `the harbor at dusk ${n}`, D(`2026-11-0${n + 1}`), "photos")),
      record("n1", "harbor notes", D("2026-11-06"), "notes"),
    ]);
    const asked: string[] = [];
    const photo = (ref: RecordRef) => {
      asked.push(ref.key);
      return `sha256:${hexOf(ref.key)}`;
    };
    const answer = await first(index, { query: "harbor" }, { photo });
    const hits: KindsHit[] = [...answer.top.flatMap((row) => ("hit" in row ? [row.hit] : [])), ...answer.kinds.flatMap((each) => ("hits" in each ? each.hits : []))];
    const photos = hits.filter((hit) => hit.family === "photos");
    expect(photos.length).toBeGreaterThan(0);
    for (const hit of photos) expect(hit.image).toBe(`sha256:${hexOf(keyOf(hit.ref))}`);
    expect(hits.filter((hit) => hit.family !== "photos").every((hit) => hit.image === undefined)).toBe(true);
    expect(asked.every((key) => key.startsWith("p"))).toBe(true);
  });

  it("H8 a record kind's upcoming counts its matches after today", async () => {
    const index = fresh("h8");
    put(index, [
      record("next-year", "Lantern festival", D("2027-11-07"), "calendar"), record("next-week", "Lantern festival", D("2026-11-21"), "calendar"),
      record("last-week", "Lantern festival", D("2026-11-07"), "calendar"),
    ]);
    const answer = await first(index, { query: "lantern" });
    expect(kindOf(answer, "calendar")).toMatchObject({ n: 3, upcoming: 2 });
  });

  it("H13 twelve kinds within one page's rows, each of them listed, the plays counted beside them", async () => {
    const families = ["ai", "calendar", "calls", "health", "mail", "messages", "money", "notes", "photos", "physical", "voice", "web"];
    const index = fresh("h13");
    put(index, families.flatMap((family, at) => Array.from({ length: 600 }, (_, n) => record(`${family}${n}`, `harbor ${family} ${n}`, D("2026-01-01") + (n * 12 + at) * 600_000, family))));
    playsDay(index, "2026-11-10", [{ key: "h1", track: "Harbor Song", artist: "The Pellows", at: D("2026-11-10", "08:00") }], "Listened to Harbor Song by The Pellows");
    const before = rowsCounted();
    const answer = await first(index, { query: "harbor" }, { more: listening("h13") });
    expect(rowsCounted() - before).toBeLessThanOrEqual(PAGE_ROWS);
    expect(answer.kinds.map((each) => each.family).sort()).toEqual([...families, "listening"].sort());
    expect(answer.kinds.filter((each) => each.family !== "listening").map((each) => hitsOf(each).length)).toEqual(families.map(() => 3));
  });

  it("H17 See all on listening lists the kind's tracks, read by the first screen's words, mid-word and with words of no meaning", async () => {
    const index = fresh("h17-listening");
    const at = D("2026-11-10", "08:00");
    playsDay(index, "2026-11-10", [
      { key: "s1", track: "Lanternfish", artist: "The Pellows", at }, { key: "s2", track: "Song Two", artist: "Quarry Lane", at: at + 4 * MIN },
      { key: "s3", track: "Lanternfish", artist: "The Pellows", at: at + 8 * MIN },
    ], "Listened to Lanternfish and Song Two by The Pellows and Quarry Lane");
    const how: Asking = { more: listening("h17-listening") };
    for (const params of [{ query: "lanternf", typing: "1" }, { query: "lanternfish by the pellows" }]) {
      const kind = kindOf(await first(index, params, how), "listening");
      const pages = await seeAll<ListeningPage>(index, { ...params, see: "listening" }, how);
      expect(pages).toHaveLength(1);
      const tracks = pages.flatMap((each) => ("tracks" in each ? each.tracks : []));
      expect(tracks.map((each) => [each.track, each.artist, each.plays])).toEqual([["Lanternfish", "The Pellows", 2]]);
      expect(kind !== undefined && "tracks" in kind ? kind.tracks : []).toEqual(tracks);
    }
  });

  it("H17 See all on listening while typing reads its second page: 45 tracks in two pages, each once", async () => {
    const index = fresh("h17-typing-pages");
    const at = D("2026-11-10", "08:00");
    playsDay(index, "2026-11-10", Array.from({ length: 45 }, (_, n) => ({ key: `t${n}`, track: `Harbor Song ${n}`, artist: "The Pellows", at: at + n * MIN })), "Listened to Harbor Song 0 by The Pellows");
    const pages = await seeAll<ListeningPage>(index, { query: "harbo", typing: "1", see: "listening" }, { more: listening("h17-typing-pages") });
    expect(pages).toHaveLength(2);
    const tracks = pages.flatMap((each) => ("tracks" in each ? each.tracks.map((track) => track.track) : []));
    expect(tracks).toHaveLength(45);
    expect(new Set(tracks)).toEqual(new Set(Array.from({ length: 45 }, (_, n) => `Harbor Song ${n}`)));
  });

  it("H17 See all on photos holds every hit its n counted, newest first, 40 a page, each with its image", async () => {
    const index = fresh("h17-photos");
    const hexOf = (key: string) => key.padEnd(64, "0").replace(/[^0-9a-f]/gu, "a");
    put(index, Array.from({ length: 45 }, (_, n) => record(`p${n}`, `the harbor at dusk ${n}`, D("2026-09-01") + n * DAY_MS, "photos")));
    const how: Asking = { photo: (ref) => `sha256:${hexOf(ref.key)}` };
    const kind = kindOf(await first(index, { query: "harbor" }, how), "photos");
    const pages = await seeAll<RecordPage>(index, { query: "harbor", see: "photos" }, how);
    expect(pages.map((each) => [each.family, each.hits.length])).toEqual([["photos", 40], ["photos", 5]]);
    const hits = pages.flatMap((each) => each.hits);
    expect(hits).toHaveLength(nOf(kind)!);
    expect(hits.map((hit) => keyOf(hit.ref))).toEqual(Array.from({ length: 45 }, (_, n) => `p${44 - n}`));
    for (const hit of hits) expect(hit.image).toBe(`sha256:${hexOf(keyOf(hit.ref))}`);
  });

  it("H17 See all on a record kind ends today or at `to`; its Upcoming runs soonest first from the later of tomorrow and `from`", async () => {
    const index = fresh("h17-upcoming");
    put(index, [
      record("last-week", "Lantern festival", D("2026-11-07"), "calendar"), record("tonight", "Lantern festival", D("2026-11-14", "18:00"), "calendar"),
      record("tomorrow", "Lantern festival", D("2026-11-15"), "calendar"), record("next-week", "Lantern festival", D("2026-11-21"), "calendar"),
      record("next-year", "Lantern festival", D("2027-11-07"), "calendar"),
    ]);
    const keys = async (params: Record<string, string>) => (await seeAll<RecordPage>(index, { query: "lantern", see: "calendar", ...params })).flatMap((each) => each.hits.map((hit) => keyOf(hit.ref)));
    expect(kindOf(await first(index, { query: "lantern" }), "calendar")).toMatchObject({ n: 5, upcoming: 3 });
    expect(await keys({})).toEqual(["tonight", "last-week"]);
    expect(await keys({ to: "2026-11-10" })).toEqual(["last-week"]);
    expect(await keys({ to: "2027-12-31" })).toEqual(["tonight", "last-week"]);
    expect(await keys({ upcoming: "1" })).toEqual(["tomorrow", "next-week", "next-year"]);
    expect(await keys({ upcoming: "1", from: "2026-11-20" })).toEqual(["next-week", "next-year"]);
    expect(await keys({ upcoming: "1", from: "2026-11-01", to: "2026-11-30" })).toEqual(["tomorrow", "next-week"]);
    const upcoming = (await ask(index, { query: "lantern", see: "calendar", upcoming: "1" })) as RecordPage;
    expect(upcoming).toMatchObject({ family: "calendar", upcoming: true, next: null });
  });

  it("H17 a page's cursor comes alone: anything beside it is refused", async () => {
    const index = fresh("h17-alone");
    put(index, Array.from({ length: 45 }, (_, n) => record(`n${n}`, `harbor note ${n}`, D("2026-09-01") + n * DAY_MS, "notes")));
    const one = (await ask(index, { query: "harbor", see: "notes" })) as RecordPage;
    expect(one.next).not.toBeNull();
    for (const beside of [{ query: "harbor" }, { see: "notes" }, { typing: "1" }, { to: "2026-11-14" }]) {
      await expect(ask(index, { ...beside, cursor: one.next! })).rejects.toThrow("comes alone");
    }
    expect(((await ask(index, { cursor: one.next! })) as RecordPage).hits).toHaveLength(5);
  });

  it("H17 a refused count is the listening page's unread in the person's words; a later page refused is NOT_NOW in them", async () => {
    const index = fresh("h17-broad");
    const at = D("2026-11-10", "00:10");
    playsDay(index, "2026-11-10", Array.from({ length: 3_000 }, (_, n) => ({ key: `b${n}`, track: `Harbor Song ${n}`, artist: "The Pellows", at: at + n * 20_000 })), "Listened to Harbor Song 0 by The Pellows");
    const narrow: Asking = { more: { ...listening("h17-broad"), budget: PAGE_ROWS / 2 } };
    const said = "Too many plays match to count. Add a word or pick a time.";
    expect(await ask(index, { query: "harbor", see: "listening" }, narrow)).toEqual({ family: "listening", unread: said });
    expect(kindOf(await first(index, { query: "harbor" }, narrow), "listening")).toEqual({ family: "listening", unread: said });
    const one = (await ask(index, { query: "harbor", see: "listening" }, { more: listening("h17-broad-whole") })) as ListeningPage;
    expect("tracks" in one && one.tracks).toHaveLength(40);
    const next = "next" in one ? one.next : null;
    expect(next).not.toBeNull();
    await expect(ask(index, { cursor: next! }, narrow)).rejects.toMatchObject({ code: "NOT_NOW", words: said });
  });

  it("H17 See all on screen reads past a stretch with no sitting between two that hold some; a word only an older stretch holds is a Screen kind", async () => {
    const index = fresh("h17-stretch");
    const recent = D("2026-11-10", "09:00"), old = D("2024-06-01", "09:00");
    const screen = screenFile([{ at: [recent + 5 * MIN], title: "Harbor news", words: "harbor news" }, { at: [old + 5 * MIN], title: "Harbor log", words: "harbor log tides" }]);
    const spans = [recent, old].map((start) => ({ unit: unitOf(start), start_ms: start, end_ms: start + 30 * MIN }));
    const pages = await pagesOf(index, "harbor", { screen, spans });
    expect(pages.map((each) => each.sittings.length)).toEqual([1, 1]);
    expect(focusOf(pages)).toEqual([`u:${unitOf(recent)}`, `u:${unitOf(old)}`]);
    const answer = await first(index, { query: "tides" }, { screen, spans });
    const kind = kindOf(answer, "screen");
    expect(nOf(kind)).toBe(1);
    expect(kind !== undefined && "sittings" in kind ? kind.sittings!.map((row) => row.day) : []).toEqual(["2024-06-01"]);
    expect(answer.held).toEqual({ first: "2024-06-01", last: "2024-06-01" });
    const tides = await pagesOf(index, "tides", { screen, spans });
    expect(tides.map((each) => [each.sittings.length, each.next])).toEqual([[1, null]]);
  });

  it("defect 4: a word in thousands of sitting lines leaves the rest of the answer standing: summaries, held, the plays, a person's messages", async () => {
    const index = fresh("d4");
    const days = ["2026-11-11", "2026-11-12", "2026-11-13"];
    for (const day of days) {
      sittingDay(index, day, Array.from({ length: 1_000 }, (_, u) => D(day, "06:00") + u * MIN).flatMap((start, u) => [
        { first_ms: start, text: `Summary: harbor work ${u}` }, { first_ms: start, at: start + 10_000, text: `harbor line ${u}` }, { first_ms: start, at: start + 20_000, text: `harbor tide ${u}` },
      ]));
    }
    put(index, [record("m1", "the harbor at noon", D("2026-11-09"), "messages")]);
    playsDay(index, "2026-11-10", [{ key: "h1", track: "Harbor Song", artist: "The Pellows", at: D("2026-11-10", "08:00") }], "Listened to Harbor Song by The Pellows");
    const people: PeopleMap = {
      version: "p1", idOf: (id) => id, person: (id) => (id === "person:harbor" ? { name: "Harbor Person", handles: ["phone:+15550000003"] } : undefined),
      find: (name) => (name.toLowerCase().includes("harbor") ? ["person:harbor"] : []),
    };
    const answer = await first(index, { query: "harbor" }, { screen: "none", more: { ...listening("d4"), people, budget: PAGE_ROWS } });
    const screen = kindOf(answer, "screen")!;
    expect(screen).toMatchObject({ n: { partial: true } });
    const sittings = "sittings" in screen ? screen.sittings! : [];
    expect(sittings).toHaveLength(3);
    for (const row of sittings) expect(row.summary).toMatch(/^harbor work \d+$/u);
    expect(answer.held).toEqual({ first: "2026-11-09", last: "2026-11-13" });
    expect(nOf(kindOf(answer, "listening"))).toBe(1);
    expect(answer.top[0]).toEqual({ person: { ref: expect.any(String), name: "Harbor Person", messages: 0 } });
  });

  it("a home whose machines record no screen states no Screen kind, and its total is exact; its See all is empty", async () => {
    const index = fresh("no-screen");
    put(index, [record("m1", "the harbor at noon", D("2026-11-10"), "messages")]);
    const answer = await first(index, { query: "harbor" }, { screen: "none", machines: [] });
    expect(kindOf(answer, "screen")).toBeUndefined();
    expect(answer.total).toBe(1);
    expect(await ask(index, { query: "harbor", see: "screen" }, { screen: "none", machines: [] })).toEqual({ family: "screen", sittings: [], next: null });
  });

  it("the screen's windows are read by the same word rule as the records: mid-word, the last word a beginning", async () => {
    const index = fresh("screen-typing");
    const start = D("2026-11-12", "08:30");
    const screen = screenFile([{ at: [start + 5 * MIN], title: "Market", words: "the lanternfish market opens" }]);
    const spans = [{ unit: unitOf(start), start_ms: start, end_ms: start + 30 * MIN }];
    const kind = kindOf(await first(index, { query: "lanternf", typing: "1" }, { screen, spans }), "screen");
    expect(nOf(kind)).toBe(1);
    expect(kind !== undefined && "sittings" in kind ? kind.sittings![0]!.matched.map((each) => each.snippet) : []).toEqual([expect.stringContaining("«lanternfish»")]);
    const pages = await pagesOf(index, "lanternf", { screen, spans });
    expect(pages.flatMap((each) => each.sittings)).toHaveLength(0);
    const typed = await seeAll<ScreenPage>(index, { query: "lanternf", typing: "1", see: "screen" }, { screen, spans });
    expect(focusOf(typed)).toEqual([`u:${unitOf(start)}`]);
  });

  it("a person's row leaves out its messages while the index is built again, and the rest stands", async () => {
    const index = fresh("person-building");
    put(index, [record("m1", "the harbor at noon", D("2026-11-09"), "messages")]);
    owed("person-building", "2026-11-08");
    const people: PeopleMap = {
      version: "p1", idOf: (id) => id, person: (id) => (id === "person:harbor" ? { name: "Harbor Person", handles: ["phone:+15550000003"] } : undefined),
      find: (name) => (name.toLowerCase().includes("harbor") ? ["person:harbor"] : []),
    };
    const answer = await first(index, { query: "harbor" }, { more: { people } });
    expect(answer.top[0]).toEqual({ person: { ref: expect.any(String), name: "Harbor Person" } });
    expect(nOf(kindOf(answer, "messages"))).toBe(1);
  });

  it("Any time's years see a word only plays hold", async () => {
    const index = fresh("held-plays");
    playsDay(index, "2025-03-10", [{ key: "q1", track: "Quietude", artist: "The Pellows", at: D("2025-03-10", "08:00") }], "Listened to Quietude by The Pellows");
    const answer = await first(index, { query: "quietude" }, { more: listening("held-plays") });
    expect(nOf(kindOf(answer, "listening"))).toBe(1);
    expect(answer.held).toEqual({ first: "2025-03-10", last: "2025-03-10" });
  });

  it("listening's n counts only plays a row can show: a play whose item names no track is in no row and no n", async () => {
    const index = fresh("no-track");
    const at = D("2026-11-10", "08:00");
    playsDay(index, "2026-11-10", [
      { key: "t1", track: "Lanternfish", artist: "The Pellows", at }, { key: "t2", track: "", artist: "The Pellows", at: at + 4 * MIN },
      { key: "t3", track: "", artist: "The Pellows", at: at + 8 * MIN },
    ], "Listened to Lanternfish and 2 others by The Pellows");
    const how: Asking = { more: listening("no-track") };
    expect(kindOf(await first(index, { query: "pellows" }, how), "listening")).toEqual({
      family: "listening", n: 1, tracks: [{ ref: expect.stringMatching(/^row\./u), track: "Lanternfish", artist: "The Pellows", plays: 1 }],
    });
    const pages = await seeAll<ListeningPage>(index, { query: "pellows", see: "listening" }, how);
    expect(pages.flatMap((each) => ("tracks" in each ? each.tracks.map((track) => track.track) : []))).toEqual(["Lanternfish"]);
  });
});
