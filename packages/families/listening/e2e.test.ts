import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { instant, type DaySettings, type Json, type JsonObject, type ReaderOutput, type View } from "@lifestreamprotocol/core";
import { checkDayFile, type DayDocument, type DayFileFact } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import type { Family } from "../family.js";
import { listeningFamily, type ListeningDay, type Play } from "./family.js";
import { FED } from "../test/fed.js";
import { dayInput } from "../test/day-input.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { pin } from "../test/pin.js";
import { shuffled, TestHome } from "../test/drive.js";

const listening = listeningFamily(FED.listening);
const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const MAC_UNIT = "macbook-pro-0001";
const SOURCE = `now-playing:person-a@example.com:${MAC_UNIT}`;
const MAC = "0000AAAA-0000-4000-8000-000000000001";
const PHONE = "0000BBBB-0000-4000-8000-000000000002";
const APPLE_EPOCH_S = 978_307_200;
const LABELS = buildLabels({ people: [], contacts: [], places: [] });

const PLAYING = 1;
const PAUSED = 2;
const CHANGED = 3;

interface Item { title: string; artist: string; album?: string | null; length?: number; app?: string }
const song = (n: number, artist: string, length = 200): Item => ({ title: `Synthetic Song ${String(n).padStart(2, "0")}`, artist: `Artist ${artist}`, length });
const EPISODE: Item = { title: "Synthetic Episode 12", artist: "Synthetic Show", length: 3600, app: "com.apple.podcasts" };

let entries = 0;
function entry(device: string, iso: string, state: number, item: Item | null): ReaderOutput {
  const at = Date.parse(iso);
  const seconds = at / 1000 - APPLE_EPOCH_S;
  const fields: Record<string, Json> = { "2": seconds, "3": state, "13": 0, "14": { "1": 2, "2": 3, "3": "Speaker" }, "20": 0, "21": 0 };
  if (item !== null) {
    Object.assign(fields, { "5": item.artist, "8": item.title, "15": item.app ?? "com.apple.Music" });
    if (item.album !== null) fields["4"] = item.album ?? (item.app === "com.apple.podcasts" ? null : "Synthetic Album");
    if (fields["4"] === null) delete fields["4"];
    if (item.length !== undefined) fields["6"] = item.length;
  }
  const basic = new Date(at).toISOString().replace(/[-:]/gu, "").replace(".000", "");
  return {
    kind: "now-playing",
    key: `${device}:${basic}:${state}`,
    content: { type: "biome.now-playing", format: 1, written: seconds + 0.002, fields },
    time: instant(seconds, "apple-s"),
    device: MAC_UNIT,
    locator: device === MAC ? `local/810000000000000.segb:entry ${entries++}` : `remote/${device}/809990000000000.segb:entry ${entries++}`,
  };
}

const plus = (iso: string, seconds: number) => new Date(Date.parse(iso) + seconds * 1000).toISOString();

function morning(): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  let at = "2026-09-20T12:10:00Z";
  const artists = ["A", "B", "A", "C", "D", "B", "A", "E", "C", "A", "F"];
  artists.forEach((artist, index) => {
    const item = song(index + 1, artist);
    rows.push(entry(PHONE, at, PLAYING, item));
    if (index === 2) {
      rows.push(entry(PHONE, plus(at, 100), PAUSED, item));
      rows.push(entry(PHONE, plus(at, 220), PLAYING, item));
      at = plus(at, 320);
    } else if (index === 5) {
      rows.push(entry(MAC, plus(at, 2), PLAYING, item));
      rows.push(entry(MAC, plus(at, 201), PAUSED, item));
      at = plus(at, 200);
    } else {
      at = plus(at, 200);
    }
  });
  rows.push(entry(PHONE, at, PLAYING, EPISODE));
  rows.push(entry(PHONE, plus(at, 23 * 60), PAUSED, EPISODE));
  return rows;
}

function evening(): ReaderOutput[] {
  const rows: ReaderOutput[] = [];
  ["G", "H", "G", "G", "H"].forEach((artist, index) => rows.push(entry(MAC, plus("2026-09-20T23:40:00Z", index * 240), PLAYING, song(20 + index, artist, 300))));
  rows.push(entry(MAC, "2026-09-21T00:00:00Z", PLAYING, song(24, "H", 300)));
  rows.push(entry(MAC, "2026-09-21T00:01:00Z", PLAYING, song(25, "I", 240)));
  rows.push(entry(MAC, "2026-09-21T00:05:00Z", PLAYING, song(26, "G", 240)));
  rows.push(entry(MAC, "2026-09-21T00:09:00Z", PAUSED, song(26, "G", 240)));
  rows.push(entry(MAC, "2026-09-21T00:28:00Z", PLAYING, song(30, "I", 180)));
  rows.push(entry(MAC, "2026-09-21T00:31:00Z", CHANGED, song(30, "I", 180)));
  return rows;
}

function night(): ReaderOutput[] {
  return [
    entry(PHONE, "2026-09-21T01:00:00Z", PLAYING, song(40, "J", 180)),
    entry(PHONE, "2026-09-21T03:00:00Z", PLAYING, song(41, "J", 180)),
    entry(PHONE, "2026-09-21T03:03:00Z", PAUSED, song(41, "J", 180)),
    entry(MAC, "2026-09-21T07:50:00Z", PLAYING, { title: "Synthetic Long Piece", artist: "Artist K", length: 1500, app: "com.example.player" }),
    entry(MAC, "2026-09-21T08:12:00Z", PAUSED, { title: "Synthetic Long Piece", artist: "Artist K", length: 1500, app: "com.example.player" }),
    entry(PHONE, "2026-09-21T09:30:00Z", PLAYING, song(50, "L", 180)),
  ];
}

function quiet(): ReaderOutput[] {
  const untimed = entry(MAC, "2026-09-20T14:00:00Z", PLAYING, song(60, "M"));
  delete untimed.time;
  untimed.key = `${MAC}:sha256:0000000000000000000000000000000000000000000000000000000000000000`;
  return [
    entry(MAC, "2026-09-20T15:00:00Z", 0, song(61, "M")),
    entry(MAC, "2026-09-20T15:01:00Z", 4, song(62, "M")),
    entry(MAC, "2026-09-20T15:02:00Z", PAUSED, song(63, "M")),
    entry(MAC, "2026-09-20T15:03:00Z", CHANGED, song(64, "M")),
    untimed,
  ];
}

const SPOTIFY = "com.spotify.client";
const tune = (n: number, artist: string, length: number): Item => ({ ...song(n, artist, length), app: SPOTIFY });

function afternoon(): ReaderOutput[] {
  const tracks = [tune(70, "N", 213), tune(71, "O", 248), tune(72, "N", 190), tune(73, "N", 205)];
  const rows: ReaderOutput[] = [entry(MAC, "2026-09-20T17:00:00Z", PLAYING, tracks[0]!)];
  let at = "2026-09-20T17:00:00Z";
  for (let index = 1; index < tracks.length; index++) {
    at = plus(at, tracks[index - 1]!.length!);
    rows.push(entry(MAC, at, PLAYING, tracks[index]!), entry(MAC, plus(at, 0.001), CHANGED, tracks[index - 1]!));
    if (index === 1) rows.push(entry(MAC, plus(at, 0.03), PLAYING, tracks[index]!), entry(MAC, plus(at, 0.031), CHANGED, tracks[index - 1]!));
  }
  at = plus(at, tracks[3]!.length!);
  rows.push(entry(MAC, at, CHANGED, tracks[3]!), entry(MAC, plus(at, 60), CHANGED, tracks[3]!));
  return rows;
}

const ALL = (): ReaderOutput[] => [...morning(), ...afternoon(), ...evening(), ...night(), ...quiet()];
const STATED = Date.UTC(2026, 8, 22);

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});
function newHome(): TestHome {
  const home = new TestHome("families-listening-", { families: [listening], settings: SETTINGS });
  home.addSource(SOURCE, "biome-now-playing");
  homes.push(home);
  return home;
}

function golden(name: string, text: string): void {
  const path = new URL(name, GOLDEN);
  if (UPDATE) writeFileSync(path, text);
  expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}

function timed(txt: string): string[] {
  const lines = txt.split("\n");
  return lines.slice(3, lines.indexOf("Coverage") - 1);
}

function plays(home: TestHome): ListeningDay["plays"] {
  return home.extracts("listening").flatMap((row) => (row.content as unknown as ListeningDay).plays);
}

describe("listening family: what must be impossible", () => {
  it("an entry's search text misses its track, artist or album, or an entry naming no item has one", () => {
    const home = newHome();
    const rows = [
      entry(PHONE, "2026-09-20T12:10:00Z", PLAYING, song(1, "A")),
      entry(PHONE, "2026-09-20T12:20:00Z", PAUSED, EPISODE),
      entry(MAC, "2026-09-20T12:30:00Z", 0, null),
    ];
    home.deliver(SOURCE, Date.UTC(2026, 8, 21), rows);
    expect(home.texts(listening).map(({ text }) => text)).toEqual([
      null,
      { title: "Synthetic Song 01", text: "Artist A\nSynthetic Album" },
      { title: "Synthetic Episode 12", text: "Synthetic Show" },
    ]);
    home.artifact("texts.json", home.texts(listening));
  });

  it("a day prints other lines than the golden", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, ALL());
    const day = home.render("2026-09-20", LABELS);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    expect(timed(day.txt)).toEqual([
      "08:10–09:11 synced device 0000BBBB and macbook-pro-0001: 11 tracks in Music — Artist A, Artist B, Artist C and 3 others (Synthetic Episode 12 by Synthetic Show in Podcasts, 23 min)",
      "13:00–13:14 macbook-pro-0001: 4 tracks in Spotify — Artist N, Artist O",
      "19:40–20:09 macbook-pro-0001: 7 tracks in Music — Artist G, Artist H, Artist I",
      "20:28–20:31 macbook-pro-0001: Synthetic Song 30 by Artist I in Music",
      "21:00 synced device 0000BBBB: Synthetic Song 40 by Artist J in Music; no end stated for Synthetic Song 40",
      "23:00–23:03 synced device 0000BBBB: Synthetic Song 41 by Artist J in Music",
      "2026-09-21 03:50–04:00 macbook-pro-0001: Synthetic Long Piece by Artist K in com.example.player, 22 min (continues into 21 Sep)",
    ]);
    golden("2026-09-20.day.txt", day.txt);
    const next = home.render("2026-09-21", LABELS);
    golden("2026-09-21.day.txt", next.txt);
    home.artifact("days.json", { "2026-09-20": day.txt, "2026-09-21": next.txt, extracts: home.extracts("listening") as unknown as Json });
    pin(listening, { listening: FED.listening }, home.extracts("listening"));
  });

  it("a track change ends the new track at once", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, afternoon());
    const at = (iso: string) => Date.parse(iso);
    expect(plays(home).map((play) => [play.title, play.start_ms, play.end_ms, play.keys.length])).toEqual([
      ["Synthetic Song 70", at("2026-09-20T17:00:00Z"), at("2026-09-20T17:03:33Z"), 1],
      ["Synthetic Song 71", at("2026-09-20T17:03:33Z"), at("2026-09-20T17:07:41Z"), 2],
      ["Synthetic Song 72", at("2026-09-20T17:07:41Z"), at("2026-09-20T17:10:51Z"), 1],
      ["Synthetic Song 73", at("2026-09-20T17:10:51Z"), at("2026-09-20T17:14:16Z"), 1],
    ]);
    expect(timed(home.render("2026-09-20", LABELS).txt)).toEqual([
      "13:00–13:14 macbook-pro-0001: 4 tracks in Spotify — Artist N, Artist O",
    ]);
    home.artifact("track-change.json", plays(home) as unknown as Json);
  });

  it("a pause and a resume count as two tracks, or the paused minutes as listened", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, morning());
    const third = plays(home).filter((play) => play.title === "Synthetic Song 03");
    expect(third.map((play) => [play.start_ms, play.end_ms])).toEqual([
      [Date.parse("2026-09-20T12:16:40Z"), Date.parse("2026-09-20T12:18:20Z")],
      [Date.parse("2026-09-20T12:20:20Z"), Date.parse("2026-09-20T12:22:00Z")],
    ]);
    const line = timed(home.render("2026-09-20", LABELS).txt)[0]!;
    expect(line).toContain("11 tracks");
    expect(line).toContain("Synthetic Episode 12 by Synthetic Show in Podcasts, 23 min");
    home.artifact("pause.json", { third, line } as unknown as Json);
  });

  it("a play with no stated end is given a length, or an entry long past its item's length ends it", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, night());
    const byTitle = new Map(plays(home).map((play) => [play.title, play]));
    expect(byTitle.get("Synthetic Song 40")).toMatchObject({ start_ms: Date.parse("2026-09-21T01:00:00Z"), end_ms: null, last_ms: Date.parse("2026-09-21T01:00:00Z") });
    expect(byTitle.get("Synthetic Song 50")).toMatchObject({ end_ms: null });
    const document = JSON.parse(home.render("2026-09-21", LABELS).json) as DayDocument;
    const open = document.atoms.filter((atom) => atom.text.includes("no end stated"));
    expect(open.map((atom) => [atom.local_start, atom.end_ms])).toEqual([["05:30", null]]);
    home.artifact("open.json", { plays: [...byTitle.values()], open } as unknown as Json);
  });

  it("a state other than playing starts a play, or a record without a time or an item breaks the family", () => {
    const home = newHome();
    const delivered = home.deliver(SOURCE, STATED, quiet());
    expect(delivered.landed.new).toBe(5);
    expect(home.extracts("listening")).toEqual([]);
    expect(home.render("2026-09-20", LABELS).txt).toContain("0 atoms: listening 0");
    home.deliver(SOURCE, STATED + 1, [entry(MAC, "2026-09-20T16:00:00Z", PLAYING, null), entry(MAC, "2026-09-20T16:02:00Z", PAUSED, null)]);
    expect(timed(home.render("2026-09-20", LABELS).txt)).toEqual(["12:00–12:02 macbook-pro-0001: an untitled item"]);
    home.artifact("quiet.json", home.extracts("listening") as unknown as Json);
  });

  it("a pause longer than the session gap leaves one session, or a shorter one splits it", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, evening());
    expect(home.extracts("listening").map((row) => row.unit)).toEqual([`${SOURCE}/2026-09-20`, `${SOURCE}/2026-09-21`]);
    expect(timed(home.render("2026-09-20", LABELS).txt)).toEqual([
      "19:40–20:09 macbook-pro-0001: 7 tracks in Music — Artist G, Artist H, Artist I",
      "20:28–20:31 macbook-pro-0001: Synthetic Song 30 by Artist I in Music",
    ]);
    const morningHome = newHome();
    morningHome.deliver(SOURCE, STATED, morning());
    expect(timed(morningHome.render("2026-09-20", LABELS).txt)).toHaveLength(1);
  });

  it("the phone's and the Mac's records of one play print twice, or one is dropped as a record", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, morning());
    const sixth = plays(home).filter((play) => play.title === "Synthetic Song 06");
    expect(sixth.map((play) => play.device).sort()).toEqual([MAC, PHONE]);
    const line = timed(home.render("2026-09-20", LABELS).txt);
    expect(line).toHaveLength(1);
    expect(line[0]).toMatch(/^08:10–09:11 synced device 0000BBBB and macbook-pro-0001: 11 tracks/u);
    const apart = newHome();
    apart.deliver(SOURCE, STATED, morning().filter((row) => row.key.startsWith(MAC)));
    expect(timed(apart.render("2026-09-20", LABELS).txt)).toEqual(["08:28–08:32 macbook-pro-0001: Synthetic Song 06 by Artist B in Music"]);
  });

  it("a session across the day's start prints in pieces that disagree", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, night());
    const before = timed(home.render("2026-09-20", LABELS).txt).filter((line) => line.includes("Long Piece"));
    const after = timed(home.render("2026-09-21", LABELS).txt).filter((line) => line.includes("Long Piece"));
    expect(before).toEqual(["2026-09-21 03:50–04:00 macbook-pro-0001: Synthetic Long Piece by Artist K in com.example.player, 22 min (continues into 21 Sep)"]);
    expect(after).toEqual(["04:00–04:12 macbook-pro-0001: Synthetic Long Piece by Artist K in com.example.player, 22 min (continues from 20 Sep)"]);
  });

  it("the log landed in many late deliveries, in any order, builds other extracts than at once", () => {
    const once = newHome();
    once.deliver(SOURCE, STATED, ALL());
    const expected = once.extracts("listening").map(({ unit, reading, content, days }) => ({ unit, reading, content, days }));
    const byTime = ALL().sort((left, right) => (left.time?.start_ms ?? 0) - (right.time?.start_ms ?? 0));
    const orders: [string, ReaderOutput[][]][] = [
      ["oldest first", byTime.map((row) => [row])],
      ["newest first", [...byTime].reverse().map((row) => [row])],
      ...[1, 2, 3].map((seed): [string, ReaderOutput[][]] => {
        const rows = shuffled(ALL(), seed);
        return [`seed ${seed}`, [0, 1, 2, 3, 4, 5, 6].map((part) => rows.filter((_, index) => index % 7 === part))];
      }),
    ];
    for (const [name, deliveries] of orders) {
      const home = newHome();
      deliveries.forEach((rows, index) => home.deliver(SOURCE, STATED + index, rows));
      expect(home.extracts("listening").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })), name).toEqual(expected);
    }
    once.artifact("order.json", expected as unknown as Json);
  });

  it("a long play of hundreds of entries walks its history once per entry, or a late entry misses where it began", () => {
    const STREAM: Item = { title: "Synthetic Radio", artist: "Synthetic Station", album: null, app: "com.example.radio" };
    const start = "2026-09-20T10:00:00Z";
    const COUNT = 1_560;
    const stream = Array.from({ length: COUNT }, (_, index) => entry(PHONE, plus(start, index * 60), PLAYING, STREAM));
    const stop = entry(PHONE, plus(start, COUNT * 60), PAUSED, STREAM);
    let read = 0;
    const counting = (view: View): View => new Proxy(view, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "records") return (value as (...args: unknown[]) => unknown).bind(target);
        return (...args: unknown[]) => {
          const rows = [...((value as (...args: unknown[]) => Iterable<unknown>).apply(target, args))];
          read += rows.length;
          return rows;
        };
      },
    });
    const counted: Family = { ...listening, touched: (changes, view) => listening.touched(changes, counting(view)), extract: (unit, view, blobs) => listening.extract(unit, counting(view), blobs) };
    const home = new TestHome("families-listening-", { families: [counted], settings: SETTINGS });
    home.addSource(SOURCE, "biome-now-playing");
    homes.push(home);
    home.deliver(SOURCE, STATED, stream);
    const landed = read;
    read = 0;
    const late = home.deliver(SOURCE, STATED + 1, [stop]);
    const restated = read;
    expect(late.written).toContain(`listening ${SOURCE}/2026-09-20`);
    const once = newHome();
    once.deliver(SOURCE, STATED, [...stream, stop]);
    const strip = (each: TestHome) => each.extracts("listening").map(({ unit, reading, content, days }) => ({ unit, reading, content, days }));
    expect(strip(home)).toEqual(strip(once));
    expect(plays(home).map((play) => [play.start_ms, play.end_ms, play.keys.length])).toEqual([[Date.parse(start), Date.parse(plus(start, COUNT * 60)), COUNT]]);
    home.artifact("long-play.json", { entries: COUNT, rows_read: { landed, late_stop: restated } });
    expect(landed).toBeLessThan(4 * (COUNT + 1));
    expect(restated).toBeLessThan(4 * (COUNT + 1));
  });

  it("the same delivery again writes an extract, or the family asks a model", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, ALL());
    const again = home.deliver(SOURCE, STATED + 1, ALL());
    expect(again.landed.new).toBe(0);
    expect(again.written).toEqual([]);
    expect(again.days).toEqual([]);
    expect(listening.plan).toBeUndefined();
    expect(listening.items).toBeUndefined();
    expect(listening.prompts).toBeUndefined();
  });
});


const SPOTIFY_SOURCE = "spotify:synthetic-user-0001:export";
const HISTORY_MEMBER = "my_spotify_data.zip:Spotify Extended Streaming History/Streaming_History_Audio_2026.json";
const NO_ITEM: Record<string, Json> = {
  master_metadata_track_name: null, master_metadata_album_artist_name: null, master_metadata_album_album_name: null, spotify_track_uri: null,
  episode_name: null, episode_show_name: null, spotify_episode_uri: null,
  audiobook_title: null, audiobook_uri: null, audiobook_chapter_uri: null, audiobook_chapter_title: null,
};

interface Listed { uri: string; members: Record<string, Json> }
const listedTrack = (n: number, artist: string, title = `Synthetic Song ${n}`): Listed => {
  const uri = `spotify:track:00000000000000000000${n}`;
  return { uri, members: { master_metadata_track_name: title, master_metadata_album_artist_name: `Artist ${artist}`, master_metadata_album_album_name: "Synthetic Album", spotify_track_uri: uri } };
};
const listedEpisode = (n: number): Listed => {
  const uri = `spotify:episode:00000000000000000000${n}`;
  return { uri, members: { episode_name: `Synthetic Episode ${n}`, episode_show_name: "Synthetic Show", spotify_episode_uri: uri } };
};
const listedChapter = (n: number): Listed => {
  const uri = `spotify:chapter:00000000000000000000${n}`;
  return { uri, members: { audiobook_title: "Synthetic Book", audiobook_uri: "spotify:audiobook:000000000000000000b1", audiobook_chapter_uri: uri, audiobook_chapter_title: `Synthetic Chapter ${n}` } };
};

let listed = 0;
function heard(ts: string, ms_played: number, item: Listed, extra: Record<string, Json> = {}, rank = 0): ReaderOutput {
  const play: Record<string, Json> = {
    ts, platform: "ios", ms_played, conn_country: "ZZ", ip_addr: "192.0.2.1", ...NO_ITEM, ...item.members,
    reason_start: "trackdone", reason_end: "trackdone", shuffle: false, skipped: false, offline: false, offline_timestamp: null, incognito_mode: false, ...extra,
  };
  const basic = new Date(Date.parse(ts)).toISOString().replace(/[-:]/gu, "").replace(".000", "");
  return {
    kind: "play",
    key: `${basic}:${item.uri}${rank === 0 ? "" : `:${rank}`}`,
    content: { type: "spotify.play", history: "audio", play },
    time: instant(ts, "rfc3339"),
    locator: `${HISTORY_MEMBER}[${listed++}]`,
  };
}

function spotifyMorning(): ReaderOutput[] {
  return [
    heard("2026-09-20T14:03:20Z", 200_000, listedTrack(80, "P")),
    heard("2026-09-20T14:03:50Z", 30_000, listedTrack(81, "Q"), { skipped: true, reason_end: "fwdbtn" }),
    heard("2026-09-20T14:07:00Z", 190_000, listedTrack(82, "P"), { incognito_mode: true }),
    heard("2026-09-20T14:07:01Z", 0, listedTrack(83, "Q"), { skipped: true, reason_end: "fwdbtn" }),
    heard("2026-09-20T14:30:00Z", 1_200_000, listedEpisode(13)),
    heard("2026-09-20T20:30:00Z", 1_800_000, listedChapter(1)),
    heard("2026-09-20T20:50:00Z", 1_200_000, listedChapter(2)),
  ];
}

function spotifyAfternoon(): ReaderOutput[] {
  const osx = { platform: "osx" };
  return [
    heard("2026-09-20T17:03:33Z", 213_000, listedTrack(70, "N"), osx),
    heard("2026-09-20T17:07:41Z", 248_000, listedTrack(71, "O", "SYNTHETIC  SONG 71"), osx),
    heard("2026-09-20T17:10:51Z", 190_000, listedTrack(72, "N"), osx),
    heard("2026-09-20T17:14:16Z", 205_000, listedTrack(73, "N"), osx),
  ];
}

function spotifyEvening(): ReaderOutput[] {
  return [
    heard("2026-09-20T23:00:00Z", 180_000, listedTrack(90, "R")),
    heard("2026-09-20T23:00:00Z", 175_000, listedTrack(91, "S"), { offline: true, offline_timestamp: 1_789_930_000 }),
    heard("2026-09-20T23:00:00Z", 12_000, listedTrack(91, "S"), { offline: true, offline_timestamp: 1_789_930_180, skipped: true, reason_end: "fwdbtn" }, 1),
  ];
}
const macEvening = (): ReaderOutput[] => [entry(MAC, "2026-09-20T22:57:05Z", PLAYING, song(91, "S", 180)), entry(MAC, "2026-09-20T23:00:00Z", PAUSED, song(91, "S", 180))];

const SPOTIFY_ALL = (): ReaderOutput[] => [...spotifyMorning(), ...spotifyAfternoon(), ...spotifyEvening()];

function bothHome(): TestHome {
  const home = newHome();
  home.addSource(SPOTIFY_SOURCE, "spotify-export");
  return home;
}

function spotifyPlays(home: TestHome): Play[] {
  return home.extracts("listening").filter((row) => row.unit.startsWith(`${SPOTIFY_SOURCE}/`)).flatMap((row) => (row.content as unknown as ListeningDay).plays);
}

function coverage(txt: string): string {
  const lines = txt.split("\n");
  return lines[lines.indexOf("Coverage") + 1]!;
}

describe("listening family: Spotify's plays, what must be impossible", () => {
  it("a Spotify play prints at another time than ms_played before its end, a skipped or incognito play is dropped, or one that heard nothing prints", () => {
    const home = bothHome();
    home.deliver(SPOTIFY_SOURCE, STATED, spotifyMorning());
    const at = (iso: string) => Date.parse(iso);
    expect(spotifyPlays(home).map((play) => [play.title, play.artist, play.album, play.start_ms, play.end_ms])).toEqual([
      ["Synthetic Song 80", "Artist P", "Synthetic Album", at("2026-09-20T14:00:00Z"), at("2026-09-20T14:03:20Z")],
      ["Synthetic Song 81", "Artist Q", "Synthetic Album", at("2026-09-20T14:03:20Z"), at("2026-09-20T14:03:50Z")],
      ["Synthetic Song 82", "Artist P", "Synthetic Album", at("2026-09-20T14:03:50Z"), at("2026-09-20T14:07:00Z")],
      ["Synthetic Episode 13", "Synthetic Show", null, at("2026-09-20T14:10:00Z"), at("2026-09-20T14:30:00Z")],
      ["Synthetic Book", null, "Synthetic Chapter 1", at("2026-09-20T20:00:00Z"), at("2026-09-20T20:30:00Z")],
      ["Synthetic Book", null, "Synthetic Chapter 2", at("2026-09-20T20:30:00Z"), at("2026-09-20T20:50:00Z")],
    ]);
    const day = home.render("2026-09-20", LABELS);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    expect(timed(day.txt)).toEqual([
      "10:00–10:30 Spotify on ios: Synthetic Song 80 by Artist P, Synthetic Song 81 by Artist Q, Synthetic Song 82 by Artist P (Synthetic Episode 13 by Synthetic Show, 20 min)",
      "16:00–16:50 Spotify on ios: Synthetic Book, 50 min",
    ]);
    const atoms = (JSON.parse(day.json) as DayDocument).atoms;
    expect(atoms[0]!.record).toEqual({ source: SPOTIFY_SOURCE, kind: "play", key: "20260920T140320Z:spotify:track:0000000000000000000080" });
    expect(coverage(day.txt)).toBe(`listening: ${SPOTIFY_SOURCE} read through the day`);
    home.artifact("spotify-morning.json", { plays: spotifyPlays(home), day: day.txt } as unknown as Json);
  });

  it("a Spotify play's search text misses its track, episode or book", () => {
    const home = bothHome();
    home.deliver(SPOTIFY_SOURCE, STATED, [heard("2026-09-20T14:03:20Z", 200_000, listedTrack(80, "P")), heard("2026-09-20T14:30:00Z", 1_200_000, listedEpisode(13)), heard("2026-09-20T20:30:00Z", 1_800_000, listedChapter(1))]);
    expect(home.texts(listening).map(({ text }) => text)).toEqual([
      { title: "Synthetic Song 80", text: "Artist P\nSynthetic Album" },
      { title: "Synthetic Episode 13", text: "Synthetic Show" },
      { title: "Synthetic Book", text: "Synthetic Chapter 1" },
    ]);
    home.artifact("spotify-texts.json", home.texts(listening));
  });

  it("a play Spotify's history and the Mac's log both state prints twice, or one is dropped as a record", () => {
    const home = bothHome();
    home.deliver(SOURCE, STATED, afternoon());
    home.deliver(SPOTIFY_SOURCE, STATED, spotifyAfternoon());
    expect(plays(home).map((play) => play.title?.toLowerCase().replace(/\s+/gu, " "))).toEqual([
      ...["70", "71", "72", "73"].map((n) => `synthetic song ${n}`),
      ...["70", "71", "72", "73"].map((n) => `synthetic song ${n}`),
    ]);
    const day = home.render("2026-09-20", LABELS);
    expect(timed(day.txt)).toEqual(["13:00–13:14 macbook-pro-0001 and Spotify on osx: 4 tracks in Spotify — Artist N, Artist O"]);
    expect(coverage(day.txt)).toBe(`listening: ${SOURCE} read through the day; ${SPOTIFY_SOURCE} read through the day`);
    const alone = bothHome();
    alone.deliver(SPOTIFY_SOURCE, STATED, spotifyAfternoon());
    expect(timed(alone.render("2026-09-20", LABELS).txt)).toEqual(["13:00–13:14 Spotify on osx: 4 tracks — Artist N, Artist O"]);
    const unplaced = bothHome();
    unplaced.deliver(SOURCE, STATED, afternoon());
    unplaced.deliver(SPOTIFY_SOURCE, STATED, spotifyAfternoon().map((row) => ({ ...row, content: { ...(row.content as JsonObject), play: { ...((row.content as JsonObject).play as JsonObject), platform: null } } })));
    expect(timed(unplaced.render("2026-09-20", LABELS).txt)).toEqual(["13:00–13:14 Spotify and macbook-pro-0001: 4 tracks in Spotify — Artist N, Artist O"]);
    home.artifact("spotify-join.json", { extracts: home.extracts("listening"), day: day.txt } as unknown as Json);
  });

  it("a line over two services states one service's account and not the other's", () => {
    const accounts = (home: TestHome) => (JSON.parse(home.render("2026-09-20", LABELS).json) as DayDocument).atoms.map((atom) => atom.accounts);
    const home = bothHome();
    home.deliver(SOURCE, STATED, afternoon());
    home.deliver(SPOTIFY_SOURCE, STATED, spotifyAfternoon());
    expect(accounts(home)).toEqual([["now-playing:person-a@example.com", "spotify:synthetic-user-0001"]]);
    const alone = bothHome();
    alone.deliver(SPOTIFY_SOURCE, STATED, spotifyAfternoon());
    expect(accounts(alone)).toEqual([undefined]);
  });

  it("an offline play joins another by the time it was logged, runs into a session of plays timed as heard, or prints without saying so", () => {
    const home = bothHome();
    home.deliver(SOURCE, STATED, macEvening());
    home.deliver(SPOTIFY_SOURCE, STATED, spotifyEvening());
    const at = (iso: string) => Date.parse(iso);
    expect(spotifyPlays(home).map((play) => [play.title, play.start_ms, play.end_ms, play.offline ?? false])).toEqual([
      ["Synthetic Song 90", at("2026-09-20T22:57:00Z"), at("2026-09-20T23:00:00Z"), false],
      ["Synthetic Song 91", at("2026-09-20T22:57:05Z"), at("2026-09-20T23:00:00Z"), true],
      ["Synthetic Song 91", at("2026-09-20T22:59:48Z"), at("2026-09-20T23:00:00Z"), true],
    ]);
    expect(timed(home.render("2026-09-20", LABELS).txt)).toEqual([
      "18:57–19:00 Spotify on ios: Synthetic Song 90 by Artist R",
      "18:57–19:00 macbook-pro-0001: Synthetic Song 91 by Artist S in Music",
      "18:57–19:00 Spotify on ios: Synthetic Song 91 by Artist S; offline, timed when logged",
    ]);
    home.artifact("spotify-offline.json", spotifyPlays(home) as unknown as Json);
  });

  it("a later cumulative download, or the same plays in another order, writes another extract", () => {
    const once = bothHome();
    once.deliver(SPOTIFY_SOURCE, STATED, SPOTIFY_ALL());
    const strip = (each: TestHome) => each.extracts("listening").map(({ unit, reading, content, days }) => ({ unit, reading, content, days }));
    const expected = strip(once);
    expect(expected.map((row) => row.unit)).toEqual([`${SPOTIFY_SOURCE}/2026-09-20`]);
    const later = once.deliver(SPOTIFY_SOURCE, STATED + DAY_MS, [...shuffled(SPOTIFY_ALL(), 4), heard("2026-09-25T12:00:00Z", 180_000, listedTrack(84, "T"))]);
    expect(later.landed.new).toBe(1);
    expect(later.written).toEqual([`listening ${SPOTIFY_SOURCE}/2026-09-25`]);
    for (const seed of [1, 2, 3]) {
      const home = bothHome();
      const rows = shuffled(SPOTIFY_ALL(), seed);
      [0, 1, 2].forEach((part) => home.deliver(SPOTIFY_SOURCE, STATED + part, rows.filter((_, index) => index % 3 === part)));
      expect(strip(home), `seed ${seed}`).toEqual(expected);
    }
    once.artifact("spotify-order.json", expected as unknown as Json);
  });

  it("a day with Spotify's history beside the log prints other lines than the golden", () => {
    const home = bothHome();
    home.deliver(SOURCE, STATED, [...ALL(), ...macEvening()]);
    home.deliver(SPOTIFY_SOURCE, STATED, SPOTIFY_ALL());
    const day = home.render("2026-09-20", LABELS);
    expect(checkDayFile(JSON.parse(day.json))).toEqual([]);
    golden("2026-09-20.spotify.day.txt", day.txt);
    home.artifact("spotify-day.json", { "2026-09-20": day.txt, extracts: home.extracts("listening") as unknown as Json });
  });
});

const DAY_MS = 86_400_000;

const PLAY_DAY = "2026-09-22";
const at22 = (time: string) => `${PLAY_DAY}T${time}Z`;

function playFacts(home: TestHome, day = PLAY_DAY): DayFileFact[] {
  const document = JSON.parse(home.render(day, LABELS).json) as DayDocument;
  expect(checkDayFile(document)).toEqual([]);
  return document.facts.filter((fact) => fact.of === "plays");
}

const told = (facts: readonly DayFileFact[]) => facts.map((fact) => [fact.keys.track, fact.keys.device, Math.round(Number(fact.measures.minutes) * 100) / 100, fact.measures.times]);

function looped(device: string, start: string, item: Item, minutes: number, every_s = 150): ReaderOutput[] {
  const rows = Array.from({ length: (minutes * 60) / every_s }, (_, index) => entry(device, plus(start, index * every_s), PLAYING, item));
  return [...rows, entry(device, plus(start, minutes * 60), PAUSED, item)];
}

describe("listening family: plays as facts, what must be impossible", () => {
  it("a play is folded wrong: entries restating it, a pause and a resume, two devices are one fact each; a replay after another track is two", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, morning());
    const morningFacts = playFacts(home, "2026-09-20");
    expect(morningFacts).toHaveLength(12);
    const third = morningFacts.filter((fact) => fact.keys.track === "Synthetic Song 03");
    expect(told(third)).toEqual([["Synthetic Song 03", PHONE, 3.33, 1]]);
    const sixth = morningFacts.filter((fact) => fact.keys.track === "Synthetic Song 06");
    expect(sixth).toHaveLength(1);
    expect(sixth[0]!.keys.device).toBe(PHONE);

    const restated = newHome();
    const SONG = song(90, "V", 200);
    const OTHER = song(91, "W", 200);
    restated.deliver(SOURCE, STATED, [
      entry(MAC, at22("14:00:00"), PLAYING, SONG), entry(MAC, at22("14:01:00"), PLAYING, SONG), entry(MAC, at22("14:02:00"), PLAYING, SONG),
      entry(MAC, at22("14:03:20"), PLAYING, OTHER), entry(MAC, at22("14:06:40"), PLAYING, SONG), entry(MAC, at22("14:10:00"), PAUSED, SONG),
    ]);
    const facts = playFacts(restated);
    expect(told(facts)).toEqual([
      ["Synthetic Song 90", MAC_UNIT, 3.33, 1],
      ["Synthetic Song 91", MAC_UNIT, 3.33, 1],
      ["Synthetic Song 90", MAC_UNIT, 3.33, 1],
    ]);
    const key = `${MAC}:20260922T140000Z:${PLAYING}`;
    expect(facts[0]).toMatchObject({
      family: "listening", time_ms: Date.parse(at22("14:00:00")), start_ms: Date.parse(at22("14:00:00")), end_ms: Date.parse(at22("14:03:20")),
      keys: { track: "Synthetic Song 90", artist: "Artist V", album: "Synthetic Album", app: "Music", device: MAC_UNIT },
      who: [], from: { units: [`${SOURCE}/${PLAY_DAY}`], record: { source: SOURCE, kind: "now-playing", key } }, lines: [],
    });
    expect(new Set(facts.map((fact) => fact.id)).size).toBe(3);
    restated.artifact("plays.json", { morning: morningFacts, replay: facts } as unknown as Json);
  });

  it("a play's times is not the time listened over its length: 30 minutes of a 180-second item is 10, an item with no length is 1", () => {
    const home = newHome();
    home.deliver(SOURCE, STATED, [
      ...looped(MAC, at22("14:00:00"), song(92, "X", 180), 30),
      ...looped(MAC, at22("16:00:00"), { title: "Synthetic Stream", artist: "Synthetic Station", album: null }, 30),
    ]);
    expect(told(playFacts(home))).toEqual([
      ["Synthetic Song 92", MAC_UNIT, 30, 10],
      ["Synthetic Stream", MAC_UNIT, 30, 1],
    ]);
  });

  it("a play's fact is stated otherwise on another day, by another day than its start's, or moves with the order of the extracts or a play added", () => {
    const home = bothHome();
    home.deliver(SOURCE, STATED, [...ALL(), ...macEvening()]);
    home.deliver(SPOTIFY_SOURCE, STATED, SPOTIFY_ALL());
    const sources = new Map(home.read((view) => view.sources()).map((row) => [row.id, row]));
    const contents = home.extracts("listening").map(({ unit, content, start_ms, end_ms }) => ({ unit, content, start_ms, end_ms }));
    const input = (day: string, extra = contents) => dayInput(listening, day, extra, SETTINGS, { sources });
    const days = ["2026-09-19", "2026-09-20", "2026-09-21", "2026-09-22"];
    expect(factsConform(listening, days.map((day) => input(day)))).toEqual([]);
    const late = newHome();
    late.deliver(SOURCE, STATED, [entry(MAC, "2026-09-20T12:00:00Z", PLAYING, song(99, "Z")), entry(MAC, "2026-09-20T12:03:00Z", PAUSED, song(99, "Z"))]);
    const added = [...contents, ...late.extracts("listening").map(({ content, start_ms, end_ms }) => ({ unit: `${SOURCE}/2026-09-20-late`, content, start_ms, end_ms }))];
    expect(insertKeepsFacts(listening, input("2026-09-20"), input("2026-09-20", added))).toEqual([]);
  });

  it("a play cast to a TV is its own track with the TV for an artist, or is not found by its artist's word", () => {
    const home = newHome();
    const PHONE_SIDE: Item = { title: "Synthetic Song 95", artist: "Artist U", length: 200, app: SPOTIFY };
    const CAST: Item = { title: "Synthetic Song 95 • Artist U • Video Available", artist: "Listening on Synthetic TV", album: null, length: 200, app: SPOTIFY };
    home.deliver(SOURCE, STATED, [
      entry(PHONE, at22("14:00:00"), PLAYING, PHONE_SIDE), entry(PHONE, at22("14:03:20"), PAUSED, PHONE_SIDE),
      entry(MAC, at22("14:00:01"), PLAYING, CAST), entry(MAC, at22("14:03:20"), PAUSED, CAST),
    ]);
    const facts = playFacts(home);
    expect(facts.map((fact) => fact.keys)).toEqual([{ track: "Synthetic Song 95", artist: "Artist U", album: "Synthetic Album", app: "Spotify", device: PHONE }]);
    expect(facts[0]!.measures.times).toBe(1);
    const texts = home.texts(listening).map(({ text }) => text);
    expect(texts).toContainEqual({ title: "Synthetic Song 95", text: "Artist U" });
    expect(texts.flatMap((text) => (text === null ? [] : [`${text.title} ${text.text}`])).filter((said) => said.includes("Synthetic TV") || said.includes("Video Available"))).toEqual([]);
  });
});
