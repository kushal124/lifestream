import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DAYS_MARK, digest, openHome, openHomeFolder, type DaySettings, type ExtractRow, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { providers } from "@lifestreamprotocol/connect";
import { buildLabels, listeningFamily, renderDay, tableUnits, type DayDocument } from "@lifestreamprotocol/families";
import { ErasableStreams } from "./erasable-streams.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { openReads, type Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import { fedBy } from "./registry-home.js";
import { answerOf, type ContractPath } from "./search-contract.js";
import { SearchIndex, searchFileOf, type RecordEntry } from "./search-index.js";
import type { Settings } from "./settings.js";
import { REPO } from "./test/support.js";


const dir = mkdtempSync(join(tmpdir(), "lifestream-count-plays-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLOCK: DaySettings = { zone: "UTC", day_start_hour: 0 };
const OWNER = "person-a@example.com";
const PHONE_UNIT = "iphone-aa01";
const MAC_UNIT = "macbook-pro-0001";
const PHONE = "0000BBBB-0000-4000-8000-000000000002";
const MAC = "0000AAAA-0000-4000-8000-000000000001";
const sourceOf = (unit: string) => `now-playing:${OWNER}:${unit}`;
const SOURCES: SourceRow[] = [PHONE_UNIT, MAC_UNIT].map((unit) => ({
  id: sourceOf(unit), product: "now-playing", vendor: "apple", account: OWNER, copy: unit, connector: "now-playing", options: {}, read_through_ms: null, added_ms: 0,
}));
const listening = listeningFamily(fedBy(providers()).listening);
const now_ms = Date.parse("2026-11-14T22:10:00Z");
const fixture = (name: string) => JSON.parse(readFileSync(join(REPO, "packages", "home", "test", "contract", name), "utf8")) as Record<string, any>;

interface Heard { unit: string; at: string; minutes: number; track: string; artist: string; album: string; app: string; length_s: number }
const RIVERSIDE = { track: "Riverside", artist: "The Quiet Hours", album: "Low Tide", length_s: 240 };
const SPOTIFY = "com.spotify.client";
const MUSIC = "com.apple.Music";
const HEARD: Heard[] = [
  { ...RIVERSIDE, unit: PHONE_UNIT, at: "2026-11-01T08:12", minutes: 4, app: SPOTIFY },
  { track: "Riverside Drive", artist: "The Quiet Hours", album: "Low Tide", length_s: 300, unit: PHONE_UNIT, at: "2026-11-02T09:00", minutes: 5, app: SPOTIFY },
  { ...RIVERSIDE, unit: MAC_UNIT, at: "2026-11-03T13:58", minutes: 8, app: MUSIC },
  { track: "Down by the Riverside", artist: "Harbour Lights", album: "Night Water", length_s: 200, unit: MAC_UNIT, at: "2026-11-04T10:00", minutes: 10, app: MUSIC },
  { track: "Morning Light", artist: "June Field", album: "Fields", length_s: 180, unit: PHONE_UNIT, at: "2026-11-05T07:00", minutes: 3, app: SPOTIFY },
  { ...RIVERSIDE, unit: PHONE_UNIT, at: "2026-11-10T07:38", minutes: 8, app: SPOTIFY },
];

const keyOf = (heard: Heard) => `${heard.unit === MAC_UNIT ? MAC : PHONE}:${heard.at.replace(/[-:]/gu, "")}00Z:1`;
const startOf = (heard: Heard) => Date.parse(`${heard.at}:00Z`);

function extracts(): ExtractRow[] {
  const units = new Map<string, Heard[]>();
  for (const heard of HEARD) {
    const unit = `${sourceOf(heard.unit)}/${heard.at.slice(0, 10)}`;
    units.set(unit, [...units.get(unit) ?? [], heard]);
  }
  return [...units].map(([unit, heards]) => {
    const source = unit.slice(0, unit.lastIndexOf("/"));
    const device = heards[0]!.unit === MAC_UNIT ? MAC : PHONE;
    const plays = heards.map((heard) => ({
      device, title: heard.track, artist: heard.artist, album: heard.album, app: heard.app, length_s: heard.length_s,
      start_ms: startOf(heard), end_ms: startOf(heard) + heard.minutes * 60_000, last_ms: startOf(heard), keys: [keyOf(heard)],
    }));
    const content = { source, day: unit.slice(unit.lastIndexOf("/") + 1), devices: [{ id: device, local: true }], plays } as unknown as Json;
    const row: ExtractRow = {
      family: listening.name, unit, reading: digest(content), code: listening.code, content,
      start_ms: plays[0]!.start_ms, end_ms: plays.at(-1)!.end_ms, days: [], seq: 0,
    };
    return { ...row, days: listening.days(row, CLOCK) };
  });
}

const records = (): RecordEntry[] => HEARD.map((heard) => ({
  record: { source: sourceOf(heard.unit), kind: "now-playing", key: keyOf(heard) }, family: listening.name, version: `v-${keyOf(heard)}`,
  start_ms: startOf(heard), end_ms: null, title: heard.track, text: `${heard.artist}\n${heard.album}`, who: [], link: null,
}));

function testHome() {
  const root = join(dir, "home");
  const machine = join(dir, "machine");
  mkdirSync(join(root, "days"), { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  home.close();
  const rows = extracts();
  const reader = { extractsOn: (_family: string, on: string) => rows.filter((each) => each.days.includes(on)), enrichment: () => undefined, sources: () => SOURCES, since: () => undefined };
  const labels = tableUnits(buildLabels({ people: [], contacts: [], places: [] }));
  const days = [...new Set(rows.flatMap((row) => row.days))].sort();
  const documents = new Map(days.map((day) => [day, JSON.parse(renderDay(day, [listening], reader, CLOCK, labels).json) as DayDocument]));
  const file = searchFileOf(root, machine);
  const writer = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, CLOCK);
  writer.records(records(), [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, document] of documents) writer.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: document.window, facts: document.facts } });
  writer.finish();
  writer.close();
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: CLOCK }) as Settings,
    registry: { connectors: [], readers: [], families: [listening] } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const asked = async (params: [string, string][]): Promise<{ status: number; body: Record<string, any> }> => {
    const path: ContractPath = "/v1/count";
    const url = `${path}?${new URLSearchParams(params)}`;
    try {
      const reply = await (reads.reply(path)!({ url, now_ms, held: { machine } as never }) as Reply | Promise<Reply>);
      const body = JSON.parse(String(reply.body)) as Record<string, any>;
      answerOf(path, reply.status ?? 200, body);
      return { status: reply.status ?? 200, body };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { status: error.status, body: { code: error.code, message: error.words, ...error.extra } };
    }
  };
  return { documents, asked };
}

const TIMES: [string, string][] = [["of", "plays"], ["measure", "times"], ["op", "sum"]];

describe("plays counted through the door", () => {
  const { documents, asked } = testHome();

  it("the sum of times by track and artist answers as count-plays.json does, each play counted by time listened over its length", async () => {
    expect([...documents.values()].flatMap((document) => document.facts).map((fact) => [fact.keys.track, fact.measures.times])).toEqual([
      ["Riverside", 1], ["Riverside Drive", 1], ["Riverside", 2], ["Down by the Riverside", 3], ["Morning Light", 1], ["Riverside", 2],
    ]);
    const counted = await asked([...TIMES, ["by", "track"], ["by", "artist"], ["words", "riverside"], ["order", "value"]]);
    expect(counted.status).toBe(200);
    const shaped = fixture("count-plays.json");
    expect(counted.body.asked).toBe(shaped.asked);
    expect(counted.body.columns).toEqual(shaped.columns);
    expect(counted.body.rows.map((row: unknown[]) => row.slice(0, -1))).toEqual([
      ["Riverside", "The Quiet Hours", 3, 5, 0],
      ["Down by the Riverside", "Harbour Lights", 1, 3, 0],
      ["Riverside Drive", "The Quiet Hours", 1, 1, 0],
    ]);
    expect(counted.body.total).toMatchObject({ n: 5, sum: 9 });
    expect(counted.body.counted).toMatch(/^counted from plays as /u);
  });

  it("one track's plays, each with its keys and measures, answer as count-plays-by-item.json does", async () => {
    const counted = await asked([...TIMES, ["by", "item"], ["match.track", "=Riverside"], ["match.artist", "=The Quiet Hours"], ["order", "time"]]);
    expect(counted.status).toBe(200);
    const shaped = fixture("count-plays-by-item.json");
    expect(counted.body.asked).toBe(shaped.asked);
    expect(counted.body.columns).toEqual(shaped.columns);
    expect(Object.keys(counted.body.matched)).toEqual(Object.keys(shaped.matched).filter((key) => key !== "from" && key !== "to"));
    expect(counted.body.matched.track["=Riverside"][0]).toBe("Riverside (3)");
    expect(counted.body.rows.map((row: unknown[]) => row.slice(0, -1)).filter((row: unknown[]) => row[1] === "Riverside")).toEqual([
      ["2026-11-01T08:12+00:00", "Riverside", "The Quiet Hours", "Low Tide", "Spotify", PHONE_UNIT, 4, 1],
      ["2026-11-03T13:58+00:00", "Riverside", "The Quiet Hours", "Low Tide", "Music", MAC_UNIT, 8, 2],
      ["2026-11-10T07:38+00:00", "Riverside", "The Quiet Hours", "Low Tide", "Spotify", PHONE_UNIT, 8, 2],
    ]);
  });
});
