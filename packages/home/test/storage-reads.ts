import { addDays } from "@lifestreamprotocol/core";
import type { StorageRead } from "../storage-read.js";

export type Read = Omit<StorageRead, "position">;

export const GB = 1e9;
export const TODAY = "2026-11-23";

const YEAR_STREAMS: readonly (readonly [string, number, number])[] = [
  ["screen", 150, 6.7], ["apple-photos", 90, 2], ["granola", 40, 0.000_999_999], ["claude", 30, -2], ["whatsapp", 20, 1],
  ["ask", 9, 0.1], ["gmail", 8, 0.1], ["location", 7, 0.1], ["chrome", 6, 0.1], ["imessage", 5, 0.1], ["notes", 4, 0.1], ["spotify", 3, 0.1], ["github", 2, 0.1], ["x", 1, 0.1],
];
const OWN_GB = 30;

const grown = (days: number, bytes: number): number[] => Array.from({ length: days + 1 }, (_, at) => Math.round((bytes * (at + 1)) / (days + 1)));

function countedRead(streams: readonly (readonly [string, number, number])[], days: number, readings: number): Read {
  const home = streams.reduce((sum, [, size]) => sum + size * GB, OWN_GB * GB);
  const rest = streams.slice(5).reduce((sum, [, size]) => sum + size * GB, 0);
  return {
    disk: { name: "T9", total_bytes: 1000 * GB, free_bytes: 377 * GB, keep_bytes: 5 * GB, coming_bytes: 0 },
    counting: null,
    home: {
      bytes: home,
      streams: streams.map(([connector, size, week]) => ({ connector, bytes: size * GB, week_bytes: Math.round(week * GB) })),
      own: { bytes: OWN_GB * GB, week_bytes: 0.5 * GB },
    },
    series: {
      first_day: addDays(TODAY, -days),
      parts: [
        ...streams.slice(0, 5).map(([part, size]) => ({ part, bytes: grown(days, size * GB) })),
        ...(rest > 0 ? [{ part: "other", bytes: grown(days, rest) }] : []),
        { part: "own", bytes: grown(days, OWN_GB * GB) },
      ],
    },
    growth: { readings, bytes_a_day: 2.1 * GB, days_left: 178 },
  };
}

export const YEAR: Read = countedRead(YEAR_STREAMS, 20, 30);

export const YOUNG: Read = countedRead([["screen", 4.6, 4.6], ["apple-photos", 4.4, 4.4], ["whatsapp", 0.63, 0.63], ["notes", 0.053, 0.053]], 3, 3);

export const COUNTING: Read = {
  ...YEAR,
  counting: { map: false, left_ms: 4 * 60_000 },
  series: null,
  home: {
    bytes: 212 * GB,
    streams: YEAR.home.streams.map((stream) => ({ connector: stream.connector, bytes: Math.round((stream.bytes * 212) / 405), week_bytes: null })),
    own: { bytes: Math.round((OWN_GB * GB * 212) / 405), week_bytes: null },
  },
};

export const MAP: Read = { ...COUNTING, counting: { map: true, left_ms: null }, home: { bytes: 0, streams: [], own: { bytes: 0, week_bytes: null } } };
