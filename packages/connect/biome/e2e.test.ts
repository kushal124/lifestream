import { describe, expect, it } from "vitest";
import { artifact, collect, deliver, openTestHome } from "../test/drive.js";
import { fingerprint } from "../shared/fingerprint.js";
import type { SourceRow, Version } from "@lifestreamprotocol/core";
import { listeningAdapters } from "./adapter-listening.js";
import { biomeAppInFocus, biomeNowPlaying } from "./reader.js";
import {
  FACTS, focus, focusFiles, type Field, MAC_SYNC, MAC_UNIT, NOW_PLAYING_SOURCE, PHONE_SYNC, playingFiles, SCREEN_TIME_SOURCE, segment, type Written,
} from "./test/fixture.js";

const MAC = MAC_SYNC;
const PHONE = PHONE_SYNC;

describe("Biome app focus and now playing: each of these is impossible", () => {
  it("a synthetic delivery lands other heads than expected", async () => {
    const home = openTestHome();
    try {
      const focusLanded = await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, focusFiles(), FACTS));
      expect(focusLanded).toMatchObject({ new: 6, refused: 0, gone: 0 });
      const heads = home.heads(SCREEN_TIME_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms])).toEqual([
        ["app-focus", `${MAC}:20260902T000000.25Z:com.example.mail:in`, Date.parse("2026-09-02T00:00:00.250Z")],
        ["app-focus", `${MAC}:20260902T000100.500001Z:com.example.mail:out`, Date.parse("2026-09-02T00:01:00.500Z")],
        ["app-focus", `${MAC}:20260902T000140Z:com.example.chat:in`, Date.parse("2026-09-02T00:01:40.000Z")],
        ["app-focus", `${MAC}:20260902T000240.000123Z:com.example.chat:out`, Date.parse("2026-09-02T00:02:40.000Z")],
        ["app-focus", `${PHONE}:20260901T211320.75Z:com.example.maps:in`, Date.parse("2026-09-01T21:13:20.750Z")],
        ["app-focus", `${PHONE}:20260901T211350Z:com.example.maps:out`, Date.parse("2026-09-01T21:13:50.000Z")],
      ]);
      expect(heads[3]!.content).toEqual({
        type: "biome.app-in-focus", format: 10, written: 810_000_160.000123,
        fields: {
          "2": 1, "3": 0, "4": 810_000_160.000123, "6": "com.example.chat", "9": "1.0.0", "10": "100", "11": 1, "12": 1, "13": 0,
          "30": "1152921504606846976", "31": ["first", "second"], "32": { fixed32: 7 }, "33": { base64: "//4=" },
        },
      });
      expect(heads[0]!.time).toEqual({ start_ms: Date.parse("2026-09-02T00:00:00.250Z"), precision: "ms" });

      const playingLanded = await home.land(biomeNowPlaying, deliver(home, NOW_PLAYING_SOURCE, playingFiles(), FACTS));
      expect(playingLanded).toMatchObject({ new: 4, refused: 0 });
      const plays = home.heads(NOW_PLAYING_SOURCE);
      expect(plays.map((head) => [head.kind, head.key])).toEqual([
        ["now-playing", `${MAC}:20260902T000000.5Z:1`],
        ["now-playing", `${MAC}:20260902T000320.5Z:2`],
        ["now-playing", `${MAC}:20260902T000321Z:3`],
        ["now-playing", `${PHONE}:20260901T211320.125Z:1`],
      ]);
      expect(plays[0]!.content).toEqual({
        type: "biome.now-playing", format: 1, written: 810_000_000.502,
        fields: {
          "2": 810_000_000.5, "3": 1, "4": "Synthetic Album", "5": "Synthetic Artist", "6": 313, "8": "Synthetic Song One", "13": 0,
          "14": { "1": 2, "2": 3, "3": "Speaker" }, "15": "com.example.player", "20": 0, "21": 0,
        },
      });

      const rows = await collect(biomeAppInFocus.read(deliver(home, SCREEN_TIME_SOURCE, focusFiles(), FACTS), home.blobs));
      expect(rows.every((row) => row.device === MAC_UNIT)).toBe(true);
      expect(rows.map((row) => row.locator)).toEqual([
        "local/810000000000000.segb:entry 1", "local/810000000000000.segb:entry 2",
        "local/810000100000000.segb:entry 0", "local/810000100000000.segb:entry 1", "local/810000100000000.segb:entry 2",
        `remote/${PHONE}/809990000000000.segb:entry 0`, `remote/${PHONE}/809990000000000.segb:entry 1`,
      ]);
      artifact(home.dir, "heads.json", { focusLanded, heads, playingLanded, plays });
    } finally {
      home.close();
    }
  });

  it("the same delivery again writes anything new", async () => {
    const home = openTestHome();
    try {
      await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, focusFiles(), FACTS));
      const again = await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, focusFiles(), { ...FACTS, snapshot_taken_at: "2026-09-02T01:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, changed: 0, gone: 0, refused: 0 });
      expect(again.restated).toBeGreaterThanOrEqual(6);
      artifact(home.dir, "again.json", again);
    } finally {
      home.close();
    }
  });

  it("a segment that grew, and lost a record to the log's retention, lands a gone or loses the new record", async () => {
    const home = openTestHome();
    try {
      await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, focusFiles(), FACTS));
      const grown = {
        "local/810000100000000.segb": segment([
          { state: "deleted", bytes: 60, written: 810_000_100 },
          { state: "deleted", bytes: 60, written: 810_000_100 },
          focus(810_000_160.000123, "com.example.chat", false, [
            [30, "varint", 2n ** 60n], [31, "text", "first"], [31, "text", "second"], [32, "fixed32", 7], [33, "bytes", Buffer.from([0xff, 0xfe])],
          ]),
          focus(810_000_300, "com.example.notes", true),
        ]),
      };
      const landed = await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, grown, { ...FACTS, snapshot_taken_at: "2026-09-02T01:00:00.000Z" }));
      expect(landed).toMatchObject({ new: 1, restated: 1, changed: 0, gone: 0 });
      const heads = home.heads(SCREEN_TIME_SOURCE);
      expect(heads.filter((head) => head.gone)).toEqual([]);
      expect(heads.map((head) => head.key)).toContain(`${MAC}:20260902T000140Z:com.example.chat:in`);
      expect(heads.map((head) => head.key)).toContain(`${MAC}:20260902T000500Z:com.example.notes:in`);
      artifact(home.dir, "grown.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a record missing a part of its key is refused, or one that states nothing lands", async () => {
    const home = openTestHome();
    try {
      const noApp: Field[] = [[3, "varint", 1], [4, "double", 810_000_000]];
      const files = {
        "local/810000000000000.segb": segment([
          { state: "written", written: 810_000_000, fields: noApp },
          { state: "written", written: 810_000_001, fields: [[3, "varint", 2], [4, "double", 810_000_001], [6, "text", "com.example.mail"]] },
          { state: "written", written: 810_000_002, fields: [[3, "varint", 1], [4, "double", 0], [6, "text", "com.example.mail"]] },
          { state: "written", written: 810_000_003, fields: [] },
          focus(810_000_010, "com.example.mail", true),
        ]),
      };
      const landed = await home.land(biomeAppInFocus, deliver(home, SCREEN_TIME_SOURCE, files, FACTS));
      expect(landed).toMatchObject({ new: 4, refused: 1 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([`${MAC}:local/810000000000000.segb:entry 3`]);
      const heads = home.heads(SCREEN_TIME_SOURCE);
      expect(heads.map((head) => head.key)).toContain(`${MAC}:${fingerprint({ "3": 1, "4": 810_000_000 })}`);
      expect(heads.filter((head) => head.start_ms === null).map((head) => head.key))
        .toEqual([`${MAC}:${fingerprint({ "3": 1, "4": 0, "6": "com.example.mail" })}`]);
      artifact(home.dir, "unkeyed.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a segment the reader cannot read is read anyway, unnamed, or takes the segments beside it with it", async () => {
    const home = openTestHome();
    try {
      const written = focus(810_000_000, "com.example.mail", true);
      const cases: [string, Record<string, Buffer>, Record<string, string>][] = [
        ["not SEGB", { "local/810000000000000.segb": Buffer.from("SEGA and the rest") }, FACTS],
        ["an index larger than the file", { "local/810000000000000.segb": (() => { const file = segment([written], 256); file.writeUInt32LE(100, 4); return file; })() }, FACTS],
        ["a record past the index", { "local/810000000000000.segb": segment([{ state: "raw", code: 1, end: 400, written: 810_000_000 }], 256) }, FACTS],
        ["a CRC that fails", { "local/810000000000000.segb": segment([{ ...written, crc: 1 }]) }, FACTS],
        ["a state the log never writes", { "local/810000000000000.segb": segment([{ state: "raw", code: 7, end: 40, written: 810_000_000 }]) }, FACTS],
        ["a protobuf group", { "local/810000000000000.segb": segment([{ state: "written", fields: [], body: Buffer.from([0x0b, 0x0c]) }]) }, FACTS],
      ];
      const phone = { [`remote/${PHONE}/809990000000000.segb`]: segment([focus(809_990_000.75, "com.example.maps", true)]) };
      const refusals: Record<string, string> = {};
      for (const [name, files, facts] of cases) {
        const rows = await collect(biomeAppInFocus.read(deliver(home, SCREEN_TIME_SOURCE, { ...files, ...phone }, facts), home.blobs));
        const refused = rows.filter((row) => row.refused !== undefined);
        expect(refused.map((row) => row.key), name).toEqual([name === "a protobuf group" ? "local/810000000000000.segb:entry 0" : "local/810000000000000.segb"]);
        expect(refused[0]!.refused, name).toMatch(/^local\/810000000000000\.segb/u);
        expect(rows.filter((row) => row.refused === undefined).map((row) => row.key), name).toEqual([`${PHONE}:20260901T211320.75Z:com.example.maps:in`]);
        refusals[name] = refused[0]!.refused!;
      }
      const nameless = deliver(home, SCREEN_TIME_SOURCE, { "local/810000000000000.segb": segment([written]), ...phone }, { snapshot_taken_at: FACTS.snapshot_taken_at });
      await expect(collect(biomeAppInFocus.read(nameless, home.blobs))).rejects.toMatchObject({ name: "Refused", message: expect.stringContaining("local_device") });
      artifact(home.dir, "refusals.json", refusals);
    } finally {
      home.close();
    }
  });

  it("a play cast to a TV is read as one track with the TV for its artist, or Spotify's label as the item's", async () => {
    const home = openTestHome();
    try {
      const said = (at: number, title: string, artist: string): Written => ({
        state: "written", written: at + 0.002, format: 1,
        fields: [[2, "double", at], [3, "varint", 1], [5, "text", artist], [6, "varint", 200], [8, "text", title], [15, "text", "com.spotify.client"]],
      });
      const files = {
        "local/810000000000000.segb": segment([
          said(810_000_000, "Synthetic Song • Synthetic Artist • Video Available", "Listening on Synthetic TV"),
          said(810_000_300, "Synthetic Song Two • Synthetic Artist", "Listening on Synthetic TV"),
          said(810_000_600, "Synthetic Song Three", "Listening on Synthetic TV"),
          said(810_000_900, "Synthetic Song • Four", "Synthetic Artist"),
        ], 16 * 1024, 1),
      };
      expect(await home.land(biomeNowPlaying, deliver(home, NOW_PLAYING_SOURCE, files, FACTS))).toMatchObject({ new: 4, refused: 0 });
      const adapter = listeningAdapters["now-playing"]!.listening!;
      const heads = home.heads(NOW_PLAYING_SOURCE);
      const read = heads.map((head) => adapter.play({ source: {} as SourceRow, version: { key: head.key, content: head.content } as unknown as Version }));
      expect(read.map((play) => play === null ? null : [play.title, play.artist])).toEqual([
        ["Synthetic Song", "Synthetic Artist"],
        ["Synthetic Song Two", "Synthetic Artist"],
        ["Synthetic Song Three", null],
        ["Synthetic Song • Four", "Synthetic Artist"],
      ]);
      expect(heads[0]!.content).toMatchObject({ fields: { "5": "Listening on Synthetic TV", "8": "Synthetic Song • Synthetic Artist • Video Available" } });
      artifact(home.dir, "cast.json", { heads, read });
    } finally {
      home.close();
    }
  });
});
