import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import { temp, writeZip } from "../../../test/drive.js";

export type Members = Record<string, Buffer>;

export const SPOTIFY_ACCOUNT = "synthetic-user-0001";
export const SPOTIFY_SOURCE = `spotify:${SPOTIFY_ACCOUNT}:export`;
export const FOLDER = "Spotify Extended Streaming History/";

export const TRACK_A = "spotify:track:0000000000000000000000a1";
export const TRACK_B = "spotify:track:0000000000000000000000b2";
export const TRACK_C = "spotify:track:0000000000000000000000c3";
export const EPISODE_D = "spotify:episode:00000000000000000000d4";
export const EPISODE_V = "spotify:episode:00000000000000000000e5";

type Play = Record<string, unknown>;

export function track(ts: string, uri: string, extra: Play = {}): Play {
  return {
    ts,
    platform: "synthetic-platform",
    ms_played: 180_000,
    conn_country: "ZZ",
    ip_addr: "192.0.2.1",
    master_metadata_track_name: `Synthetic track ${uri.slice(-2)}`,
    master_metadata_album_artist_name: "Synthetic Artist",
    master_metadata_album_album_name: "Synthetic Album",
    spotify_track_uri: uri,
    episode_name: null,
    episode_show_name: null,
    spotify_episode_uri: null,
    audiobook_title: null,
    audiobook_uri: null,
    audiobook_chapter_uri: null,
    audiobook_chapter_title: null,
    reason_start: "clickrow",
    reason_end: "trackdone",
    shuffle: false,
    skipped: false,
    offline: false,
    offline_timestamp: null,
    incognito_mode: false,
    ...extra,
  };
}

export function episode(ts: string, uri: string, extra: Play = {}): Play {
  return track(ts, TRACK_A, {
    master_metadata_track_name: null,
    master_metadata_album_artist_name: null,
    master_metadata_album_album_name: null,
    spotify_track_uri: null,
    episode_name: `Synthetic episode ${uri.slice(-2)}`,
    episode_show_name: "Synthetic Show",
    spotify_episode_uri: uri,
    ms_played: 1_200_000,
    ...extra,
  });
}

export function offlineBatch(): Play[] {
  const first = track("2026-01-02T10:00:00Z", TRACK_B, { offline: true, offline_timestamp: 1767240000, ms_played: 175_000, reason_start: "trackdone" });
  const second = track("2026-01-02T10:00:00Z", TRACK_B, { offline: true, offline_timestamp: 1767240180, ms_played: 12_000, reason_end: "fwdbtn", skipped: true });
  return [first, second, { ...first }];
}

export function spotifyDownload(version: "first" | "later" = "first"): Members {
  const batch = offlineBatch();
  const audio2025 = [track("2025-12-31T23:59:58Z", TRACK_A, { ip_addr: "192.0.2.7" })];
  const audio2026 = [
    ...(version === "first" ? batch : [batch[1]!, batch[2]!, batch[0]!]),
    episode("2026-01-03T08:30:00Z", EPISODE_D, { reason_end: "endplay" }),
    track("2026-01-03T09:00:00Z", TRACK_C, { shuffle: true }),
    ...(version === "later" ? [track("2026-02-01T12:00:00Z", TRACK_A), episode("2026-02-02T07:00:00Z", EPISODE_D, { ms_played: 600_000 })] : []),
  ];
  const video2026 = [episode("2026-01-04T20:00:00Z", EPISODE_V, { platform: "synthetic-tv" })];
  return {
    [FOLDER]: Buffer.alloc(0),
    [`${FOLDER}Streaming_History_Audio_2025.json`]: json(audio2025),
    [`${FOLDER}Streaming_History_Audio_2026.json`]: json(audio2026),
    [`${FOLDER}Streaming_History_Video_2026.json`]: json(video2026),
    [`${FOLDER}ReadMeFirst_ExtendedStreamingHistory.pdf`]: Buffer.from("%PDF-1.4 synthetic read-me"),
  };
}

export function otherHistory(): Members {
  const { [`${FOLDER}Streaming_History_Audio_2025.json`]: _, ...theirs } = spotifyDownload("later");
  return theirs;
}

export const SPOTIFY_ZIP = "my_spotify_data.zip";

export function spotifyHanded(members: Members, form: "zip" | "folder" = "zip"): Record<string, Buffer> {
  if (form === "folder") return Object.fromEntries(Object.entries(members).filter(([name]) => !name.endsWith("/")).map(([name, bytes]) => [`my_spotify_data/${name}`, bytes]));
  const path = join(temp("spotify-export-"), SPOTIFY_ZIP);
  writeZip(path, Object.entries(members).map(([name, bytes]) => ({ name, bytes, method: "deflate" as const })));
  return { [SPOTIFY_ZIP]: readFileSync(path) };
}

export function userdata(username: string): Buffer {
  return json({ username, email: "person-a@example.com", country: "ZZ", birthdate: "1990-01-01", creationTime: "2017-01-01" });
}

export function json(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2));
}

export const spotifyFixture: Fixture = (folder) => {
  const members = { ...spotifyDownload("first"), "Spotify Account Data/Userdata.json": userdata(SPOTIFY_ACCOUNT) };
  writeZip(join(folder, "my_spotify_data.zip"), Object.entries(members).map(([name, bytes]) => ({ name, bytes, method: "deflate" as const })));
  return {
    source: SPOTIFY_SOURCE, facts: { snapshot_taken_at: "2026-01-05T09:00:00Z" }, files: { "my_spotify_data.zip": "trust" },
    heads: [
      "play 20251231T235958Z:spotify:track:0000000000000000000000a1",
      "play 20260102T100000Z:spotify:track:0000000000000000000000b2",
      "play 20260102T100000Z:spotify:track:0000000000000000000000b2:1",
      "play 20260103T083000Z:spotify:episode:00000000000000000000d4",
      "play 20260103T090000Z:spotify:track:0000000000000000000000c3",
      "play 20260104T200000Z:spotify:episode:00000000000000000000e5",
    ],
  };
};
