import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Fixture } from "../../../test/drive.js";

export const USER = "10000001";
export const SOURCE = `whoop:${USER}:cloud`;
export const FAKE_EMAIL = "person-a@example.com";
export const FAKE_PASSWORD = "fake-password-1";
export const FAKE_FIRST_DAY = "2026-07-22";
export const DAY = "2026-08-01";
export const SECOND_DAY = "2026-08-02";
export const OFFICIAL_FORMAT = "org.lifestreamprotocol.whoop-official-snapshot/0.1";
export const PRIVATE_FORMAT = "org.lifestreamprotocol.whoop-private-snapshot/0.1";

export type Files = Record<string, Buffer>;

export interface CaptureOptions {
  official?: "manifest" | "hand" | false;
  private?: "one" | "two" | "unplaced" | "empty" | "half-empty" | false;
  recoveryScore?: number;
  recoveryUpdatedAt?: string;
  nonidenticalEndpoint?: boolean;
  sleepStyle?: string;
  stressPositionShift?: boolean;
  duplicateCycle?: boolean;
}

export function capture(options: CaptureOptions = {}): Files {
  const files: Files = {};
  const official = options.official ?? "manifest";
  const half = options.private ?? "one";
  if (official !== false) Object.assign(files, officialHalf(official, options));
  if (half !== false) Object.assign(files, privateHalf(half, options));
  return files;
}

function officialHalf(layout: "manifest" | "hand", options: CaptureOptions): Files {
  const user_id = Number(USER);
  const cycle = {
    id: 2001, user_id, created_at: "2026-08-01T00:00:00.000Z", updated_at: "2026-08-01T01:00:00.000Z",
    start: "2026-07-31T18:30:00.000Z", end: null, timezone_offset: "+05:30", score_state: "SCORED", score: { strain: 4.25 },
  };
  const closed = {
    id: 2000, user_id, created_at: "2026-07-31T00:00:00.000Z", updated_at: "2026-07-31T19:00:00.000Z",
    start: "2026-07-30T18:30:00.000Z", end: "2026-07-31T18:30:00.000Z", timezone_offset: "+05:30", score_state: "SCORED",
    score: { strain: 11.5, kilojoule: 9000.125 },
  };
  const recovery = {
    cycle_id: 2001, sleep_id: "11111111-1111-4111-8111-111111111111", user_id, created_at: "2026-08-01T00:05:00.000Z",
    updated_at: options.recoveryUpdatedAt ?? "2026-08-01T00:06:00.000Z", score_state: "SCORED",
    score: { recovery_score: options.recoveryScore ?? 50, hrv_rmssd_milli: 50.5 },
  };
  const sleep = {
    id: "11111111-1111-4111-8111-111111111111", cycle_id: 2001, user_id, created_at: "2026-08-01T00:05:00.000Z",
    updated_at: "2026-08-01T00:06:00.000Z", start: "2026-07-31T18:30:00.000Z", end: "2026-08-01T00:00:00.000Z",
    timezone_offset: "+05:30", nap: false, score_state: "SCORED", score: { respiratory_rate: 15.25 },
  };
  const workout = {
    id: "22222222-2222-4222-8222-222222222222", user_id, created_at: "2026-08-01T03:00:00.000Z",
    updated_at: "2026-08-01T03:01:00.000Z", start: "2026-08-01T02:00:00.000Z", end: "2026-08-01T03:00:00.000Z",
    timezone_offset: "+05:30", sport_name: "synthetic-activity", score_state: "SCORED", score: { strain: 3 },
  };
  const cycles = options.duplicateCycle === true ? [closed, cycle, closed] : [closed, cycle];
  const pages: Record<string, unknown> = {
    profile: { user_id, first_name: "Person", last_name: "A" },
    cycles: { records: cycles, next_token: null },
    recoveries: { records: [recovery], next_token: null },
    sleeps: { records: [sleep], next_token: null },
    workouts: { records: [workout], next_token: null },
  };
  const files: Files = {};
  if (layout === "hand") {
    const members: Record<string, Buffer> = {
      "profile.raw.json": json(pages.profile),
      "cycles/page-00001.raw.json": json(pages.cycles),
      "recoveries/page-00001.raw.json": json(pages.recoveries),
      "sleeps/page-00001.raw.json": json(pages.sleeps),
      "workouts/page-00001.raw.json": json(pages.workouts),
      "fetch-all.sh": Buffer.from("#!/bin/sh\n# synthetic read-only fetch provenance\n"),
    };
    for (const [name, bytes] of Object.entries(members)) files[`official/${name}`] = bytes;
    files["official/MANIFEST.md"] = Buffer.from("# Synthetic WHOOP capture\n\nCaptured: 2026-08-01\n");
    files["official/SHA256SUMS"] = Buffer.from(
      Object.keys(members).sort().map((name) => `${hex(members[name]!)}  ./${name}\n`).join(""),
    );
    return files;
  }
  const page = (name: string, bytes: Buffer, records?: number) => {
    files[`official/${name}`] = bytes;
    return { file: name, bytes: bytes.length, sha256: hex(bytes), ...(records === undefined ? {} : { records }) };
  };
  const counted = (resource: string, value: { records: unknown[] }) => ({
    record_count: value.records.length,
    pages: [page(`${resource}-00001.json`, json(value), value.records.length)],
  });
  const manifest = {
    format: OFFICIAL_FORMAT, started_at: "2026-08-02T00:00:33.000Z", finished_at: "2026-08-02T00:00:34.000Z", complete: true,
    filters: { start: "2026-08-01T00:00:00+05:30", end: "2026-08-01T23:59:59+05:30" },
    resources: {
      profile: { pages: [page("profile.json", json(pages.profile))] },
      cycles: counted("cycles", pages.cycles as { records: unknown[] }),
      recoveries: counted("recoveries", pages.recoveries as { records: unknown[] }),
      sleeps: counted("sleeps", pages.sleeps as { records: unknown[] }),
      workouts: counted("workouts", pages.workouts as { records: unknown[] }),
    },
  };
  files["official/manifest.json"] = json(manifest);
  return files;
}

function privateHalf(kind: "one" | "two" | "unplaced" | "empty" | "half-empty", options: CaptureOptions): Files {
  const files: Files = {};
  const day = (date: string, graph: unknown, stress: unknown) => {
    const graphBytes = json(graph);
    const stressBytes = json(stress);
    files[`private/daily-graph-${date}.json`] = graphBytes;
    files[`private/stress-${date}.json`] = stressBytes;
    return {
      date,
      stress: {
        file: `stress-${date}.json`, bytes: stressBytes.length, sha256: hex(stressBytes),
        request_url: `https://api.prod.whoop.com/health-service/v2/stress-bff/${date}?apiVersion=7`, plot_points: 3,
      },
      daily_graph: {
        file: `daily-graph-${date}.json`, bytes: graphBytes.length, sha256: hex(graphBytes),
        request_url: `https://api.prod.whoop.com/home-service/v1/tilt-view?apiVersion=7&date=${date}`, series_points: 4,
      },
    };
  };
  const stress = stressRoot(options.stressPositionShift === true);
  if (kind === "empty") {
    for (const name of ["stress_graph", "previous_stress_graph", "extended24_hour_graph"]) {
      (stress[name] as { graph: { plots: unknown[] } }).graph.plots = [{ type: "LINE_PLOT", plot: { id: "empty", segments: [] } }];
    }
  }
  const graph = kind === "empty" || kind === "half-empty"
    ? { graph: { id: "synthetic-empty-graph", plane: {}, plots: [] } }
    : heartRateRoot(options.nonidenticalEndpoint === true, kind === "unplaced", options.sleepStyle ?? "TILT_MODE_SLEEP");
  const days = [day(DAY, graph, stress)];
  if (kind === "two") days.push(day(SECOND_DAY, secondHeartRateRoot(), secondStressRoot()));
  files["private/manifest.json"] = json({
    format: PRIVATE_FORMAT, started_at: "2026-08-02T00:00:00.000Z", finished_at: "2026-08-02T00:00:01.000Z", complete: true,
    date_range: { start: DAY, end: kind === "two" ? SECOND_DAY : DAY, timezone: "Asia/Kolkata" },
    days,
  });
  return files;
}

export function graphPoint(position: number, value: number, clock: string, family: "hr" | "stress"): Record<string, unknown> {
  return {
    visible: false,
    position_x: position,
    position_y: family === "hr" ? value / 200 : value / 3,
    style: "SYNTHETIC",
    accessibility_label: null,
    details: null,
    data_scrubber_details:
      family === "hr"
        ? {
            primary_contextual_display: null, value, value_display: String(value), unit_display: "bpm",
            secondary_contextual_display: clock, scrubber_style: null,
          }
        : {
            primary_contextual_display: clock, value: value / 4, value_display: value.toFixed(1), unit_display: null,
            secondary_contextual_display: "SYNTHETIC", scrubber_style: "SYNTHETIC",
          },
    graph_label: null,
    theme: null,
  };
}

function heartRateRoot(nonidenticalEndpoint: boolean, unplaced: boolean, sleepStyle: string): Record<string, unknown> {
  const repeated = graphPoint(0.5, 60, "12:01 AM", "hr");
  const second = structuredClone(repeated);
  if (nonidenticalEndpoint) {
    const details = second.data_scrubber_details as Record<string, unknown>;
    details.value = 61;
    details.value_display = "61";
  }
  return {
    graph: {
      id: "synthetic-tilt-graph",
      plane: {},
      plots: [
        {
          type: "X_LABEL_PLOT",
          plot: {
            id: "x_label_plot",
            zoom_buckets: unplaced ? [] : [
              {
                zoom_threshold: 1,
                axis_labels: [
                  { label: "12:00 AM", position: 0, id: "2026-08-01T00:00+05:30" },
                  { label: "12:02 AM", position: 1, id: "2026-08-01T00:02+05:30" },
                ],
              },
              { zoom_threshold: 2, axis_labels: [{ label: "12:01 AM", position: 0.5, id: "2026-08-01T00:01+05:30" }] },
            ],
          },
        },
        {
          type: "LINE_PLOT",
          plot: {
            id: "TILT_MODE",
            segments: [
              { style: sleepStyle, points: [graphPoint(0, 60, "12:00 AM", "hr"), repeated] },
              { style: "TILT_MODE_STRAIN", points: [second, graphPoint(1, 60, "12:02 AM", "hr")] },
            ],
          },
        },
      ],
    },
    last_updated_timestamp: "2026-08-01T00:02:00+05:30",
  };
}

function secondHeartRateRoot(): Record<string, unknown> {
  return {
    graph: {
      id: "synthetic-tilt-graph",
      plane: {},
      plots: [
        {
          type: "X_LABEL_PLOT",
          plot: {
            id: "x_label_plot",
            zoom_buckets: [{
              zoom_threshold: 1,
              axis_labels: [
                { label: "12:00 AM", position: 0, id: "2026-08-02T00:00+05:30" },
                { label: "12:02 AM", position: 1, id: "2026-08-02T00:02+05:30" },
              ],
            }],
          },
        },
        {
          type: "LINE_PLOT",
          plot: {
            id: "TILT_MODE",
            segments: [{
              style: "TILT_MODE_SLEEP",
              points: [graphPoint(0, 62, "12:00 AM", "hr"), graphPoint(0.5, 63, "12:01 AM", "hr"), graphPoint(1, 64, "12:02 AM", "hr")],
            }],
          },
        },
      ],
    },
    last_updated_timestamp: "2026-08-02T00:02:00+05:30",
  };
}

function stressGraph(plotId: string, labels: readonly unknown[], points: readonly unknown[]): Record<string, unknown> {
  return {
    graph: {
      plane: { bottom_xaxis: { labels } },
      plots: [{ type: "LINE_PLOT", plot: { id: plotId, segments: [{ style: "SYNTHETIC", points }] } }],
    },
  };
}

function stressRoot(shift: boolean): Record<string, Record<string, unknown> | string> {
  const at = (position: number) => (shift ? 1 - (1 - position) / 2 : position);
  const extended = shift
    ? [
        { label: "5:19 AM", position: 0 },
        { label: "5:28 AM", position: at(0.3) },
        { label: "5:30 AM", position: at(0.6) },
      ]
    : [
        { label: "5:26 AM", position: 0 },
        { label: "5:28 AM", position: 0.3 },
        { label: "5:30 AM", position: 0.6 },
      ];
  return {
    last_updated_display: "5:32 AM",
    typeform_url:
      "https://api.prod.whoop.com/url-mapping-service/v1/STRESS_FEEDBACK" +
      `?stressScore=1.5&stressScoreTimestamp=2026-08-01T00%3A02%3A40.000Z&userId=${USER}`,
    stress_graph: stressGraph("stress", [{ label: "5:30 AM", position: 0.2 }, { label: "5:31 AM", position: 0.5 }], [
      graphPoint(0.5, 0.5, "5:31 AM", "stress"),
      graphPoint(1, 1.5, "5:32 AM", "stress"),
    ]),
    previous_stress_graph: stressGraph("previous-stress", [{ label: "5:26 AM", position: 0 }, { label: "5:28 AM", position: 0.5 }], [
      graphPoint(0.25, 0.2, "5:27 AM", "stress"),
    ]),
    extended24_hour_graph: stressGraph("stress", extended, [
      graphPoint(at(0.15), 0.2, "5:27 AM", "stress"),
      graphPoint(at(0.75), 0.5, "5:31 AM", "stress"),
      graphPoint(1, 1.5, "5:32 AM", "stress"),
    ]),
  };
}

function secondStressRoot(): Record<string, unknown> {
  return {
    last_updated_display: "5:36 AM",
    typeform_url:
      "https://api.prod.whoop.com/url-mapping-service/v1/STRESS_FEEDBACK" +
      "?stressScore=1.0&stressScoreTimestamp=2026-08-01T00%3A06%3A40.000Z",
    stress_graph: stressGraph("stress", [{ label: "5:32 AM", position: 0.2 }, { label: "5:34 AM", position: 0.6 }], [
      graphPoint(1, 1.0, "5:36 AM", "stress"),
    ]),
    previous_stress_graph: stressGraph("previous-stress", [{ label: "5:26 AM", position: 0 }, { label: "5:28 AM", position: 0.5 }], [
      graphPoint(0.25, 0.2, "5:27 AM", "stress"),
    ]),
    extended24_hour_graph: stressGraph("stress", [
      { label: "5:30 AM", position: 0 },
      { label: "5:32 AM", position: 0.3 },
      { label: "5:34 AM", position: 0.6 },
    ], [
      graphPoint(0.15, 0.5, "5:31 AM", "stress"),
      graphPoint(0.4, 2.1, "5:32 AM", "stress"),
      graphPoint(1, 1.0, "5:36 AM", "stress"),
    ]),
  };
}

export function json(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

export function hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const WHOOP_SETS: Record<string, CaptureOptions> = {
  paired: {},
  "hand-official": { official: "hand", private: false },
  "private-two-days": { official: false, private: "two" },
  "private-unplaced": { official: false, private: "unplaced" },
  "empty-private-day": { private: "empty" },
  rescored: { recoveryScore: 55, recoveryUpdatedAt: "2026-08-02T00:10:00.000Z" },
  restyled: { official: false, sleepStyle: "TILT_MODE_NAP" },
  "positions-moved": { official: false, stressPositionShift: true },
};

export const during = (start: number, end: number | null): string => end === null ? `['${new Date(start).toISOString()}',)` : `['${new Date(start).toISOString()}','${new Date(end).toISOString()}')`;

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetCache = new Map<string, number>();
const wallCache = new Map<string, number>();

export function offsetAt(zone: string, ms: number): number {
  const minute = Math.floor(ms / 60_000);
  const key = `${zone}|${minute}`;
  const cached = offsetCache.get(key);
  if (cached !== undefined) return cached;
  let fmt = zoneFormatters.get(zone);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
    zoneFormatters.set(zone, fmt);
  }
  const at = minute * 60_000;
  let year = 0, month = 0, day = 0, hour = 0, min = 0, second = 0;
  for (const part of fmt.formatToParts(at)) {
    if (part.type === "year") year = Number(part.value);
    else if (part.type === "month") month = Number(part.value);
    else if (part.type === "day") day = Number(part.value);
    else if (part.type === "hour") hour = Number(part.value);
    else if (part.type === "minute") min = Number(part.value);
    else if (part.type === "second") second = Number(part.value);
  }
  const offset = Math.round((Date.UTC(year, month - 1, day, hour, min, second) - at) / 60_000);
  offsetCache.set(key, offset);
  return offset;
}

export function wallMs(day: string, clock: string, zone: string): number {
  const key = `${zone}|${day}|${clock}`;
  const cached = wallCache.get(key);
  if (cached !== undefined) return cached;
  const naive = Date.parse(`${day}T${clock}Z`);
  const result = naive - offsetAt(zone, naive) * 60_000;
  wallCache.set(key, result);
  return result;
}

export function clockAt(ms: number, offset: number): string {
  const wall = new Date(ms + offset * 60_000);
  const hour = wall.getUTCHours();
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(wall.getUTCMinutes()).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export function sleepEvents(start: number): Record<string, unknown>[] {
  const hour = 3_600_000;
  return [
    { during: during(start, start + 600_000), type: "LATENCY" },
    { during: during(start + 2 * hour, start + 4 * hour), type: "SWS" },
    { during: during(start + 600_000, start + 2 * hour), type: "LIGHT" },
    { during: during(start + 4 * hour, start + 6 * hour), type: "REM" },
    { during: during(start + 3 * hour, start + 3 * hour + 300_000), type: "WAKE" },
    { during: during(start + hour, start + hour + 60_000), type: "DISTURBANCES" },
  ];
}


export const APP_FORMAT = "org.lifestreamprotocol.whoop-app-snapshot/0.1";
export const APP_SLEEP = "11111111-1111-4111-8111-111111111111";

export interface AppCaptureOptions {
  restatedStrain?: number;
  noStress?: boolean | "graph";
  otherUser?: boolean;
  brokenDuring?: string;
  step?: 6 | 60 | 600;
  sleepOffset?: string;
  stressDays?: Record<string, Record<string, unknown>>;
  sleepEvents?: unknown;
  cyclesWindow?: { start: string; end: string };
}

export function longStress(start: number, edge: number, labels: number[], points: number[], clocks: string[] = []): Record<string, unknown> {
  const offset = offsetAt("Asia/Kolkata", edge);
  const position = (at: number) => (at - start) / (edge - start);
  return {
    last_updated_display: clockAt(Math.round(edge / 1000) * 1000, offset),
    typeform_url:
      "https://api.prod.whoop.com/url-mapping-service/v1/STRESS_FEEDBACK" +
      `?stressScore=1.5&stressScoreTimestamp=${encodeURIComponent(new Date(edge).toISOString())}&userId=${USER}`,
    extended24_hour_graph: stressGraph("stress", [
      { label: clockAt(start, offset), position: 0 },
      ...labels.map((at, index) => ({ label: clocks[index] ?? clockAt(at, offset), position: position(at) })),
    ], points.map((at, index) => graphPoint(position(at), (index % 3) + 0.5, clockAt(at, offset), "stress"))),
  };
}

export function appCapture(options: AppCaptureOptions = {}): Files {
  const files: Files = {};
  const user_id = Number(USER);
  const stepS = options.step ?? 60;
  const closed: Record<string, unknown> = {
    cycle: {
      id: 2000, user_id, created_at: "2026-07-31T00:30:00.000Z", updated_at: "2026-08-01T00:30:00.000Z",
      during: options.brokenDuring ?? "['2026-07-31T00:30:00.000Z','2026-08-01T00:30:00.000Z')",
      timezone_offset: "+0530", days: "['2026-07-31','2026-08-01')", data_state: "complete",
      scaled_strain: 11.5, day_strain: 11.4, day_kilojoules: 9000.125, day_avg_heart_rate: 70, day_max_heart_rate: 120,
    },
    recovery: {
      activity_id: APP_SLEEP, user_id, state: "SCORED", recovery_score: 50, resting_heart_rate: 55, hrv_rmssd: 0.0505,
      created_at: "2026-07-31T00:35:00.000Z", updated_at: "2026-07-31T00:36:00.000Z",
    },
    sleeps: [{
      activity_id: APP_SLEEP, user_id: options.otherUser === true ? user_id + 1 : user_id,
      during: "['2026-07-30T18:30:00.000Z','2026-07-31T00:30:00.000Z')", timezone_offset: "+05:30",
      state: "SCORED", score: 88, is_nap: false, time_in_bed: 21_600_000, light_sleep_duration: 10_800_000,
      slow_wave_sleep_duration: 5_400_000, rem_sleep_duration: 3_600_000, wake_duration: 1_800_000,
      cycles_count: 4, disturbances: 2, in_sleep_efficiency: 0.9, respiratory_rate: 15.25,
    }],
    workouts: [{
      activity_id: "22222222-2222-4222-8222-222222222222", during: "['2026-07-31T02:00:00.000Z','2026-07-31T03:00:00.000Z')",
      timezone_offset: "+05:30", score: 3.5, sport_id: 9999,
    }],
    v2_activities: [{ id: "33333333-3333-4333-8333-333333333333", cycle_id: 2000, user_id, type: "walking", translated_type: "Walking" }],
  };
  const open: Record<string, unknown> = {
    cycle: {
      id: 2001, user_id, during: "['2026-08-01T00:30:00.000Z',)", timezone_offset: "+0530",
      data_state: "pending", scaled_strain: 4.25,
    },
    recovery: null, sleeps: [], workouts: [], v2_activities: [],
  };
  const cyclesEntries: Record<string, unknown>[] = [];
  const window = options.cyclesWindow ?? { start: "2026-07-31T00:00:00+05:30", end: "2026-08-01T23:59:59+05:30" };
  const page = (index: number, records: unknown[]) => {
    const file = `cycles-${String(index).padStart(5, "0")}.json`;
    const bytes = json({ records });
    files[`app/${file}`] = bytes;
    cyclesEntries.push({
      file, bytes: bytes.length, sha256: hex(bytes), records: records.length,
      request_url: `https://api.prod.whoop.com/core-details-bff/v0/cycles/details?${new URLSearchParams({ apiVersion: "7", id: USER, startTime: window.start, endTime: window.end, limit: "31" })}`,
    });
  };
  page(1, [closed, open]);
  if (options.restatedStrain !== undefined) {
    const again = structuredClone(closed) as { cycle: Record<string, unknown> };
    again.cycle.scaled_strain = options.restatedStrain;
    page(2, [again]);
  }
  const events = options.sleepEvents ?? sleepEvents(Date.parse("2026-07-30T18:30:00.000Z"));
  const eventsFile = `sleep-events-${APP_SLEEP}.json`;
  const eventsBytes = json(events);
  files[`app/${eventsFile}`] = eventsBytes;
  const base = Date.parse("2026-08-01T00:00:00.000Z");
  const values = [0, 1, 2, 3].map((at) => ({ time: base + at * stepS * 1000, data: 60 + at }));
  const hrFile = `heart-rate-${new Date(base).toISOString().replace(/[-:]/gu, "")}-step${stepS}.json`;
  const hrBytes = json({ name: "heart_rate", start: base, values });
  files[`app/${hrFile}`] = hrBytes;
  const stress = stressRoot(false);
  if (options.noStress === true) {
    (stress.extended24_hour_graph as { graph: { plots: unknown[] } }).graph.plots = [{ type: "LINE_PLOT", plot: { id: "empty", segments: [] } }];
  }
  if (options.noStress === "graph") delete stress.extended24_hour_graph;
  const stressEntries = Object.entries({ [DAY]: stress, ...options.stressDays }).map(([day, root]) => {
    const bytes = json(root);
    files[`app/stress-${day}.json`] = bytes;
    return {
      file: `stress-${day}.json`, bytes: bytes.length, sha256: hex(bytes), date: day,
      request_url: `https://api.prod.whoop.com/health-service/v2/stress-bff/${day}?apiVersion=7`,
    };
  });
  files["app/manifest.json"] = json({
    format: APP_FORMAT, started_at: "2026-08-01T12:00:00.000Z", finished_at: "2026-08-01T12:00:01.000Z", complete: true,
    date_range: { start: DAY, end: DAY, timezone: "Asia/Kolkata" }, hr_step_s: stepS,
    cycles: cyclesEntries,
    sleep_events: [{
      file: eventsFile, bytes: eventsBytes.length, sha256: hex(eventsBytes), activity_id: APP_SLEEP, timezone_offset: options.sleepOffset ?? "+05:30",
      request_url: `https://api.prod.whoop.com/sleep-service/v1/sleep-events?apiVersion=7&activityId=${APP_SLEEP}`,
    }],
    heart_rate: [{
      file: hrFile, bytes: hrBytes.length, sha256: hex(hrBytes), step: stepS, readings: values.length,
      request_url: `https://api.prod.whoop.com/metrics-service/v1/metrics/user/${USER}?apiVersion=7&name=heart_rate&order=t&step=${stepS}&start=2026-08-01T00%3A00%3A00.000Z&end=2026-08-01T00%3A03%3A00.000Z`,
    }],
    stress: stressEntries,
  });
  return files;
}

export const whoopFixture: Fixture = (folder) => {
  const files = appCapture();
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
  }
  return {
    source: SOURCE, facts: {}, files: Object.fromEntries(Object.keys(files).map((path) => [path, "trust" as const])),
    heads: [
      "cycle 2000", "cycle 2001", "sample hr60:20260801T000000.000Z", "sample hr60:20260801T000100.000Z",
      "sample hr60:20260801T000200.000Z", "sample hr60:20260801T000300.000Z", "sample stress:20260731T235700.000Z",
      "sample stress:20260801T000100.000Z", "sample stress:20260801T000240.000Z",
      "sleep-stages 11111111-1111-4111-8111-111111111111",
    ],
  };
};
