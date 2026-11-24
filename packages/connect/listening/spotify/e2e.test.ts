import { describe, expect, it } from "vitest";
import { CONSUMED, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, openTestHome } from "../../test/drive.js";
import { looked } from "../../test/imports.js";
import { spotifyConnector } from "./reader.js";
import { EPISODE_D, EPISODE_V, FOLDER, json, offlineBatch, otherHistory, SPOTIFY_ACCOUNT, SPOTIFY_SOURCE, SPOTIFY_ZIP as ZIP, spotifyDownload, spotifyHanded, TRACK_B, TRACK_C, track, userdata, type Members } from "./test/fixtures.js";

const T0 = Date.UTC(2026, 0, 5);
const DAY = 86_400_000;
const IMPORT = { import: { kind: "spotify", id: "import-0001" } };
const FIRST_PLAY = "20251231T235958Z:spotify:track:0000000000000000000000a1";

const zipped = (members: Members): Buffer => spotifyHanded(members)[ZIP]!;

function download(version: "first" | "later" = "first", extra: Members = {}): Record<string, Buffer> {
  return { [ZIP]: zipped({ ...spotifyDownload(version), ...extra }) };
}

describe("spotify connector", () => {
  it("a synthetic download lands different plays than expected", async () => {
    const at = openTestHome("connect-spotify-");
    const landed = await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, download(), {}, T0));
    expect(landed).toMatchObject({ new: 6, duplicated: 1, refused: 0 });
    const heads = at.heads(SPOTIFY_SOURCE, ["play"]);
    expect(heads.map((head) => head.key)).toEqual([
      `20251231T235958Z:spotify:track:0000000000000000000000a1`,
      `20260102T100000Z:${TRACK_B}`,
      `20260102T100000Z:${TRACK_B}:1`,
      `20260103T083000Z:${EPISODE_D}`,
      `20260103T090000Z:spotify:track:0000000000000000000000c3`,
      `20260104T200000Z:${EPISODE_V}`,
    ]);
    const first = heads[0]!;
    expect([first.start_ms, first.end_ms]).toEqual([Date.UTC(2025, 11, 31, 23, 59, 58), null]);
    expect(first.time).toMatchObject({ precision: "s" });
    expect(first.content).toEqual({ type: "spotify.play", history: "audio", play: track("2025-12-31T23:59:58Z", "spotify:track:0000000000000000000000a1", { ip_addr: "192.0.2.7" }) });
    artifact(at.dir, "heads.json", { landed: counts(landed), heads });
  });

  it("the same download twice lands a play again", async () => {
    const at = openTestHome("connect-spotify-");
    const files = download();
    await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, files, {}, T0));
    const before = at.heads(SPOTIFY_SOURCE, ["play"]);
    const again = await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, files, {}, T0 + DAY));
    expect(again).toMatchObject({ new: 0, changed: 0, gone: 0, late: 0, refused: 0, restated: 6 });
    expect(at.heads(SPOTIFY_SOURCE, ["play"]).map((head) => [head.key, head.version])).toEqual(before.map((head) => [head.key, head.version]));
    artifact(at.dir, "again.json", counts(again));
  });

  it("a later cumulative download lands more than its new plays", async () => {
    const at = openTestHome("connect-spotify-");
    await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, download("first"), {}, T0));
    const later = await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, download("later"), {}, T0 + 30 * DAY));
    expect(later).toMatchObject({ new: 2, changed: 0, gone: 0, restated: 6, duplicated: 1 });
    expect(at.heads(SPOTIFY_SOURCE, ["play"])).toHaveLength(8);
    artifact(at.dir, "later.json", counts(later));
  });

  it("plays that share an end second and an item collapse or follow the download's order", async () => {
    const at = openTestHome("connect-spotify-");
    const [first, second, relisted] = offlineBatch();
    const read = async (batch: unknown[]) => {
      const members = { [`${FOLDER}Streaming_History_Audio_2026.json`]: json(batch) };
      const rows = await collect(spotifyConnector.read(deliver(at, SPOTIFY_SOURCE, { [ZIP]: zipped(members) }, {}, T0), at.blobs));
      return rows.map((row) => JSON.stringify([row.key, (row.content as JsonObject).play]));
    };
    const listed = await read([first, second, relisted]);
    expect(new Set(listed.map((row) => (JSON.parse(row) as string[])[0]))).toEqual(new Set([`20260102T100000Z:${TRACK_B}`, `20260102T100000Z:${TRACK_B}:1`]));
    expect(listed[2]).toEqual(listed[0]);
    const reversed = await read([relisted, second, first]);
    expect([...reversed].sort()).toEqual([...listed].sort());
    const split = await collect(spotifyConnector.read(deliver(at, SPOTIFY_SOURCE, { [ZIP]: zipped({
      [`${FOLDER}Streaming_History_Audio_2025.json`]: json([second]),
      [`${FOLDER}Streaming_History_Audio_2026.json`]: json([first]),
    }) }, {}, T0), at.blobs));
    expect(split.map((row) => row.key).sort()).toEqual([`20260102T100000Z:${TRACK_B}`, `20260102T100000Z:${TRACK_B}:1`]);
    artifact(at.dir, "shared.json", { listed, reversed });
  });

  it("an episode reads as a track, or a play of no item or two lands, or refuses the plays beside it", async () => {
    const at = openTestHome("connect-spotify-");
    const rows = await collect(spotifyConnector.read(deliver(at, SPOTIFY_SOURCE, download(), {}, T0), at.blobs));
    const episodes = rows.filter((row) => ((row.content as JsonObject).play as JsonObject).spotify_episode_uri !== null);
    expect(episodes.map((row) => [row.key, (row.content as JsonObject).history])).toEqual([[`20260103T083000Z:${EPISODE_D}`, "audio"], [`20260104T200000Z:${EPISODE_V}`, "video"]]);
    expect(episodes.every((row) => ((row.content as JsonObject).play as JsonObject).spotify_track_uri === null)).toBe(true);
    const member = `${FOLDER}Streaming_History_Audio_2026.json`;
    const good = track("2026-01-02T11:00:00Z", TRACK_C);
    for (const [name, bad, why] of [
      ["twice", track("2026-01-02T10:00:00Z", TRACK_B, { spotify_episode_uri: EPISODE_D }), /names 2 items/u],
      ["none", track("2026-01-02T10:00:00Z", TRACK_B, { spotify_track_uri: null }), /names no items/u],
    ] as const) {
      const scratch = openTestHome("connect-spotify-");
      const landed = await scratch.land(spotifyConnector, deliver(scratch, SPOTIFY_SOURCE, { [ZIP]: zipped({ [member]: json([bad, good]) }) }, {}, T0));
      expect(landed, name).toMatchObject({ new: 1, refused: 1 });
      expect(landed.refusals, name).toEqual([{ kind: "file", key: `${ZIP}:${member}[0]`, violations: [expect.stringMatching(why)] }]);
      expect(scratch.heads(SPOTIFY_SOURCE).map((head) => head.key), name).toEqual([`20260102T110000Z:${TRACK_C}`]);
    }
    artifact(at.dir, "episodes.json", episodes.map((row) => row.key));
  });

  it("a member that is not a JSON array of plays lands anything, or refuses the members beside it", async () => {
    const member = `${FOLDER}Streaming_History_Audio_2026.json`;
    const cases: [string, Buffer, string, RegExp][] = [
      ["an object", json({ ts: "2026-01-02T10:00:00Z" }), `${ZIP}:${member}`, /the top-level value is no array/u],
      ["a scalar", json(["2026-01-02T10:00:00Z"]), `${ZIP}:${member}[0]`, /a play must be an object/u],
      ["an untimed play", json([track("2026-01-02 10:00", TRACK_B)]), `${ZIP}:${member}[0]`, /2026-01-02 10:00/u],
    ];
    for (const [name, bytes, key, why] of cases) {
      const at = openTestHome("connect-spotify-");
      const landed = await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, download("first", { [member]: bytes }), {}, T0));
      expect(landed, name).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals, name).toEqual([{ kind: "file", key, violations: [expect.stringMatching(why)] }]);
    }
    const at = openTestHome("connect-spotify-");
    const empty = { [ZIP]: zipped({ [`${FOLDER}ReadMeFirst_ExtendedStreamingHistory.pdf`]: Buffer.from("%PDF") }) };
    await expect(at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, empty, {}, T0))).rejects.toThrow(/holds no Streaming_History/u);
    expect(at.heads(SPOTIFY_SOURCE)).toEqual([]);
  });

  it("another account's download lands in this source", async () => {
    const at = openTestHome("connect-spotify-");
    const theirs = download("first", { "Spotify Account Data/Userdata.json": userdata("synthetic-user-0002") });
    await expect(at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, theirs, {}, T0))).rejects.toThrow(/states user "synthetic-user-0002"; the source is spotify:synthetic-user-0001:export/u);
    await expect(at.land(spotifyConnector, deliver(at, "spotify:synthetic-user-0001", download(), {}, T0))).rejects.toThrow(/is not a spotify:<user>:export source/u);
    expect(at.heads(SPOTIFY_SOURCE)).toEqual([]);
    const ours = download("first", { "Spotify Account Data/Userdata.json": userdata(SPOTIFY_ACCOUNT) });
    expect(await at.land(spotifyConnector, deliver(at, SPOTIFY_SOURCE, ours, {}, T0))).toMatchObject({ new: 6 });
  });
});

describe("spotify export as an import", () => {
  const unzipped = (members: Members) => spotifyHanded(members, "folder");

  it("its unzipped folder lands other plays than its zip", async () => {
    const zip = openTestHome("connect-spotify-");
    await zip.land(spotifyConnector, deliver(zip, SPOTIFY_SOURCE, download(), IMPORT, T0));
    const folder = openTestHome("connect-spotify-");
    expect(await folder.land(spotifyConnector, deliver(folder, SPOTIFY_SOURCE, unzipped(spotifyDownload()), IMPORT, T0))).toMatchObject({ new: 6, duplicated: 1, refused: 0 });
    const heads = (at: typeof zip) => at.heads(SPOTIFY_SOURCE, ["play"]).map((head) => [head.key, head.version]);
    expect(heads(folder)).toEqual(heads(zip));
    artifact(folder.dir, "heads.json", heads(folder));
  });

  it("an export's account is other than its Userdata.json names, or one that names none is not asked", async () => {
    const at = openTestHome("connect-spotify-");
    const named = await looked("spotify", deliver(at, "upload:local:macbook-pro-0001", download("first", { "Spotify Account Data/Userdata.json": userdata(SPOTIFY_ACCOUNT) }), {}, T0), at.blobs);
    expect(named.resolved).toEqual({ products: [{ id: "spotify", named: [SPOTIFY_ACCOUNT] }] });
    const none = await looked("spotify", deliver(at, "upload:local:macbook-pro-0001", unzipped(spotifyDownload()), {}, T0), at.blobs);
    expect(none.resolved).toEqual({ products: [{ id: "spotify", named: [] }] });
    expect(none.listing.routes.map((route) => [route.product, route.copy, route.connector])).toEqual([["spotify", "export", "spotify-export"]]);
    artifact(at.dir, "looked.json", { named, none });
  });

  it("an export's time is other than its newest play's end, its anchor other than its earliest play, or another account's history is taken", async () => {
    const at = openTestHome("connect-spotify-");
    const look = (members: Members, anchor: string | null) => looked("spotify", deliver(at, "upload:local:macbook-pro-0001", { [ZIP]: zipped(members) }, {}, T0), at.blobs, anchor);
    const first = await look(spotifyDownload("first"), null);
    expect(first.stated).toEqual({ time_ms: Date.UTC(2026, 0, 4, 20), anchor: FIRST_PLAY });
    expect((await look(spotifyDownload("later"), FIRST_PLAY)).stated).toEqual({ time_ms: Date.UTC(2026, 1, 2, 7), anchor: FIRST_PLAY });
    expect((await look(otherHistory(), FIRST_PLAY)).stated).toEqual({ refused: expect.stringMatching(/^This isn't the same account's history as your earlier Spotify export/u) });
    expect((await look({ ...spotifyDownload("first"), [`${FOLDER}Streaming_History_Audio_2026.json`]: Buffer.from("{}") }, null)).stated).toEqual({ time_ms: Date.UTC(2026, 0, 4, 20), anchor: FIRST_PLAY });
    artifact(at.dir, "stated.json", first);
  });

  it("a file read whole is not let go with its read-me, or one holding what it does not read is", async () => {
    const at = openTestHome("connect-spotify-");
    const consumed = async (files: Record<string, Buffer>) => (await collect(spotifyConnector.read(deliver(at, SPOTIFY_SOURCE, files, IMPORT, T0), at.blobs))).filter((row) => row.kind === CONSUMED).map((row) => row.key);
    expect(await consumed(download())).toEqual([ZIP]);
    expect(await consumed(unzipped(spotifyDownload()))).toEqual(["my_spotify_data"]);
    expect(await consumed(download("first", { [`${FOLDER}cover.png`]: Buffer.from("synthetic png") }))).toEqual([]);
    expect((await collect(spotifyConnector.read(deliver(at, SPOTIFY_SOURCE, download(), {}, T0), at.blobs))).filter((row) => row.kind === CONSUMED)).toEqual([]);
  });
});
