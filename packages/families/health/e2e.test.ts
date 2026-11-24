import { constants, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  addDays, dayBounds, digest,
  type DaySettings, type ExtractRow, type HealthAdapter, type Json, type JsonObject, type ReaderOutput,
} from "@lifestreamprotocol/core";
import { renderDay, type RenderedDay, tableUnits } from "../days.js";
import type { DayLine } from "../family.js";
import { dayReader, shuffled, TestHome, type Pass } from "../test/drive.js";
import { buildLabels, type DayLabels } from "../shared/labels.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { healthFamily } from "./family.js";
import { conforming } from "../test/units.js";

const health = healthFamily(FED.health);
const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const APPLE = "apple-health:person-a@example.com:cloud";
const WHOOP = "whoop:1:cloud";
const USAGE = "screen-time:local:iphone-aa01";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const FIRST = "2026-09-14";
const LABELS: DayLabels = buildLabels({ people: [], contacts: [], places: [] });
const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), "lifestream-health-"));
const ARTIFACT: Record<string, Json> = {};

let shared17: { home: TestHome; deliveries: Delivery[]; dbPath: string; snapDir: string } | undefined;

afterAll(() => {
  shared17?.home.close();
  if (shared17 !== undefined) rmSync(shared17.snapDir, { recursive: true, force: true });
  writeFileSync(join(ARTIFACT_DIR, "health.json"), `${JSON.stringify(ARTIFACT, null, 1)}\n`);
  if (!KEEP) rmSync(ARTIFACT_DIR, { recursive: true, force: true });
});

const newHome = (templateDb?: string) => new TestHome("lifestream-health-home-", templateDb === undefined ? {} : { templateDb });
function get17(): { home: TestHome; deliveries: Delivery[]; dbPath: string } {
  if (shared17 !== undefined) return shared17;
  const seed = newHome();
  const deliveries = dataset(17);
  landAll(seed, deliveries);
  const snapDir = mkdtempSync(join(tmpdir(), "lifestream-health-snap17-"));
  const dbPath = join(snapDir, "home.db");
  seed.db.close();
  copyFileSync(join(seed.dir, "home.db"), dbPath, constants.COPYFILE_FICLONE);
  rmSync(seed.dir, { recursive: true, force: true });
  shared17 = { home: newHome(dbPath), deliveries, dbPath, snapDir };
  return shared17;
}
const pass = (home: TestHome, settings: DaySettings = SETTINGS): Pass => home.extractPass(health, settings);
const extracts = (home: TestHome): ExtractRow[] => home.read((view) => [...view.extracts("health")]);
const render = (home: TestHome, day: string, settings: DaySettings = SETTINGS): RenderedDay =>
  home.read((view) => conforming(renderDay(day, [health], dayReader(view), settings, tableUnits(LABELS))));


interface Delivery { source: string; stated_ms: number; rows: ReaderOutput[] }

const iso = (ms: number) => new Date(ms).toISOString();
const basic = (ms: number) => iso(ms).replace(/[-:]/gu, "");

function appleSample(input: { type: string; start_ms: number; end_ms: number; value: string; unit: string; from: string;
  metadata?: JsonObject; device?: JsonObject }): ReaderOutput {
  const content: JsonObject = {
    type: "health.sample", sample_type: input.type, start: iso(input.start_ms).replace(".000", ""), end: iso(input.end_ms).replace(".000", ""),
    value: input.value, unit: input.unit, source_name: input.from, source_version: "1",
    metadata: input.metadata ?? { HKMetadataKeySyncIdentifier: `sync-${input.start_ms}` },
    ...(input.device === undefined ? {} : { device: input.device }),
  };
  const key = digest([input.type, input.start_ms, input.end_ms, input.value, input.unit, input.from, "1"]).slice(7, 47);
  return { kind: "sample", key, content, time: { start_ms: input.start_ms, end_ms: input.end_ms, precision: "s" } };
}

function whoopPoint(family: "hr" | "stress", at_ms: number, reading: number, styles: string[] = [], position = 0.5): ReaderOutput {
  const content: JsonObject = family === "hr"
    ? { type: "whoop.hr", content: { bpm: reading, segment_styles: styles, position_x: position, position_y: reading / 200 } }
    : { type: "whoop.stress", content: { value: reading / 3, display: reading.toFixed(1), level: reading > 2 ? "HIGH" : "LOW", segment_styles: styles,
      position_x: position, position_y: reading / 3 } };
  return { kind: "sample", key: `${family}:${basic(at_ms)}`, content, time: { start_ms: at_ms, precision: "ms" } };
}

function whoopObject(kind: "sleep" | "workout" | "recovery" | "physio-day", key: string, content: JsonObject, start_ms: number, end_ms?: number): ReaderOutput {
  const type = kind === "physio-day" ? "whoop.cycle" : `whoop.${kind}`;
  return { kind, key, content: { type, content }, time: { start_ms, ...(end_ms === undefined ? {} : { end_ms }), precision: "ms" } };
}

function sleepId(day: number, nap = false): string {
  return `00000000-0000-4000-8000-${String(day * 10 + (nap ? 1 : 0)).padStart(12, "0")}`;
}

const INSTALL = "00000000-0000-4000-8000-0000000000a1";

const appleDate = (ms: number) => ({ epochSeconds: ms / 1000, rfc3339: iso(ms).replace(".000", "") });

interface Hour { start_ms: number; categories: [string, number][]; sequence: number; captured_ms: number; kind?: "hourly" | "daily";
  pickups?: number; updated_ms?: number; total?: number }

function usageSegment(hour: Hour): ReaderOutput {
  const length = hour.kind === "daily" ? 24 * HOUR : HOUR;
  const total = hour.total ?? hour.categories.reduce((sum, [, seconds]) => sum + seconds, 0);
  const data: JsonObject = {
    lastUpdatedDate: appleDate(hour.updated_ms ?? hour.captured_ms),
    device: { name: null, model: 1 },
    user: { role: 0, accountIdentifiersOmitted: true },
    segmentInterval: { kind: hour.kind ?? "hourly", during: { start: appleDate(hour.start_ms), end: appleDate(hour.start_ms + 24 * HOUR) } },
    filter: { device: "current", user: "current", applications: [], categories: [], webDomains: [] },
    osVersion: "Version 0.0 (Build 0A0)", sdk: "iphoneos0.0", xcodeBuild: "0A0",
    dateInterval: { start: appleDate(hour.start_ms), end: appleDate(hour.start_ms + length) },
    totalActivityDuration: total,
    longestActivity: null,
    firstPickup: total === 0 ? null : appleDate(hour.start_ms + MINUTE),
    totalPickupsWithoutApplicationActivity: hour.pickups ?? 0,
    categories: hour.categories.map(([name, seconds], index) => ({
      category: { localizedDisplayName: name, token: { encoding: "json-base64", value: `dG9rZW4t${index}` } },
      totalActivityDuration: seconds,
      applications: [{ application: { bundleIdentifier: `com.example.app${index}`, localizedDisplayName: null, token: null },
        totalActivityDuration: seconds, numberOfPickups: hour.pickups ?? 1, numberOfNotifications: 2 }],
      webDomains: [],
    })),
  };
  const line: JsonObject = {
    schema_version: 1, domain: "usage", kind: "activity_segment", sequence: hour.sequence, observed_at: iso(hour.start_ms),
    captured: { wall_rfc3339: iso(hour.captured_ms).replace("Z", "+00:00"), monotonic_s: hour.sequence },
    payload: { data },
  };
  return { kind: "usage", key: `${INSTALL}:${hour.sequence}`, content: { type: "usage.segment", content: line },
    time: { start_ms: hour.start_ms, end_ms: hour.start_ms + length, precision: "s" } };
}

const CATEGORIES = ["Entertainment", "Games", "Information & Reading", "Utilities", "Other"];

function usageDay(day: string, index: number, random: () => number): ReaderOutput[] {
  const { start_ms } = dayBounds(day, SETTINGS);
  const rows: ReaderOutput[] = [];
  let sequence = index * 100;
  for (const offset of [1, 4, 5, 8, 12, 15]) {
    const hour = start_ms + offset * HOUR;
    const categories = CATEGORIES.slice(0, 1 + Math.floor(random() * 4))
      .map((name): [string, number] => [name, Math.floor(random() * 1500) + (name === "Other" ? 0 : 20)]);
    if (offset === 15) {
      rows.push(usageSegment({ start_ms: hour, categories: categories.map(([name, seconds]) => [name, Math.floor(seconds / 3)]),
        sequence: ++sequence, captured_ms: hour + 20 * MINUTE }));
    }
    rows.push(usageSegment({ start_ms: hour, categories, sequence: ++sequence, captured_ms: hour + 2 * HOUR }));
  }
  rows.push(usageSegment({ start_ms: start_ms + 22 * HOUR, categories: [], sequence: ++sequence, captured_ms: start_ms + 23 * HOUR }));
  rows.push(usageSegment({ start_ms, kind: "daily", categories: [["Games", 4000]], sequence: ++sequence, captured_ms: start_ms + 23 * HOUR }));
  return rows;
}

function daySummary(date: string, burned: string): ReaderOutput {
  return {
    kind: "day-summary", key: date.replaceAll("-", ""),
    content: { type: "health.day-summary", date, active_energy_burned: burned, active_energy_burned_goal: "600", active_energy_unit: "kcal",
      move_time: "0", move_time_goal: "0", exercise_time: "34", exercise_time_goal: "30", stand_hours: "11", stand_hours_goal: "12" },
    time: { start_ms: Date.parse(`${date}T00:00:00Z`), end_ms: Date.parse(`${date}T00:00:00Z`) + 24 * HOUR, precision: "day" },
  };
}

function dataset(days: number, seed = 7): Delivery[] {
  const random = mulberry32(seed);
  const pick = (low: number, high: number) => low + Math.floor(random() * (high - low + 1));
  const deliveries: Delivery[] = [];
  for (let index = 0; index < days; index++) {
    const day = addDays(FIRST, index);
    const { start_ms, end_ms } = dayBounds(day, SETTINGS);
    const whoop: ReaderOutput[] = [];
    const apple: ReaderOutput[] = [];
    for (let at = start_ms; at < end_ms; at += 10 * MINUTE) {
      const hour = (at - start_ms) / HOUR;
      const effort = index === 12 && hour >= 10 && hour < 11 ? 60 : 0;
      whoop.push(whoopPoint("hr", at + 5_000, 55 + Math.round(15 * Math.sin(hour / 4)) + pick(0, 8) + effort, hour < 3 ? ["TILT_MODE_SLEEP"] : []));
    }
    for (let at = start_ms; at < end_ms; at += 15 * MINUTE) whoop.push(whoopPoint("stress", at + 7_000, pick(0, 30) / 10));
    for (let at = start_ms + 4 * HOUR; at < start_ms + 18 * HOUR; at += 15 * MINUTE) {
      for (const from of ["iPhone", "Apple Watch"]) {
        apple.push(appleSample({ type: "HKQuantityTypeIdentifierStepCount", start_ms: at + MINUTE, end_ms: at + 11 * MINUTE,
          value: String(pick(0, 700)), unit: "count", from }));
      }
      apple.push(appleSample({ type: "HKQuantityTypeIdentifierHeartRate", start_ms: at + 2 * MINUTE, end_ms: at + 2 * MINUTE,
        value: String(pick(60, 90)), unit: "count/min", from: "WHOOP" }));
    }
    if (index % 3 === 1) {
      apple.push(appleSample({ type: "HKQuantityTypeIdentifierDistanceWalkingRunning", start_ms: start_ms + 14 * HOUR, end_ms: start_ms + 16 * HOUR,
        value: "3.1", unit: "mi", from: "Run Tracker" }));
    }
    apple.push(daySummary(day, String(400 + index * 10)));
    const sleepStart = start_ms - 4.5 * HOUR;
    const wake = start_ms + 3 * HOUR;
    whoop.push(whoopObject("sleep", sleepId(index), {
      id: sleepId(index), cycle_id: 1000 + index, user_id: 1, created_at: iso(wake), updated_at: iso(wake + HOUR), start: iso(sleepStart), end: iso(wake),
      timezone_offset: "-04:00", nap: false, score_state: "SCORED",
      score: { stage_summary: { total_in_bed_time_milli: wake - sleepStart, total_awake_time_milli: 20 * MINUTE, total_no_data_time_milli: 0,
        total_light_sleep_time_milli: 200 * MINUTE, total_slow_wave_sleep_time_milli: 90 * MINUTE, total_rem_sleep_time_milli: 120 * MINUTE,
        sleep_cycle_count: 4, disturbance_count: pick(1, 9) }, sleep_needed: { baseline_milli: 480 * MINUTE },
        respiratory_rate: 15.2, sleep_performance_percentage: pick(70, 99), sleep_consistency_percentage: 80, sleep_efficiency_percentage: 93 },
    }, sleepStart, wake));
    whoop.push(whoopObject("recovery", String(1000 + index), {
      cycle_id: 1000 + index, sleep_id: sleepId(index), user_id: 1, created_at: iso(wake), updated_at: iso(wake + HOUR), score_state: "SCORED",
      score: { user_calibrating: false, recovery_score: pick(30, 95), resting_heart_rate: pick(48, 60), hrv_rmssd_milli: pick(40, 90) + 0.5,
        spo2_percentage: 96, skin_temp_celsius: 33.1 },
    }, wake + HOUR));
    const open = index === days - 1;
    whoop.push(whoopObject("physio-day", String(1000 + index), {
      id: 1000 + index, user_id: 1, created_at: iso(wake), updated_at: iso(end_ms), start: iso(wake), end: open ? null : iso(wake + 24 * HOUR),
      timezone_offset: "-04:00", score_state: "SCORED",
      score: { strain: 8 + pick(0, 80) / 10, kilojoule: pick(7000, 11000), average_heart_rate: pick(60, 75), max_heart_rate: pick(140, 180), step_count: pick(3000, 9000) },
    }, wake, open ? undefined : wake + 24 * HOUR));
    if (index % 2 === 0) {
      const workout = start_ms + 14 * HOUR;
      whoop.push(whoopObject("workout", `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`, {
        id: `00000000-0000-4000-9000-${String(index).padStart(12, "0")}`, user_id: 1, created_at: iso(workout), updated_at: iso(workout + HOUR),
        start: iso(workout), end: iso(workout + 45 * MINUTE), timezone_offset: "-04:00", sport_name: "running", sport_id: 0, score_state: "SCORED",
        score: { strain: 10 + pick(0, 40) / 10, average_heart_rate: 150, max_heart_rate: 178, kilojoule: 2100, percent_recorded: 100,
          zone_durations: { zone_one_milli: 60_000 } },
      }, workout, workout + 45 * MINUTE));
    }
    if (index === 5) {
      const nap = start_ms + 11 * HOUR;
      whoop.push(whoopObject("sleep", sleepId(index, true), {
        id: sleepId(index, true), cycle_id: 1000 + index, user_id: 1, created_at: iso(nap), updated_at: iso(nap), start: iso(nap), end: iso(nap + 35 * MINUTE),
        timezone_offset: "-04:00", nap: true, score_state: "PENDING_SCORE", score: null,
      }, nap, nap + 35 * MINUTE));
    }
    deliveries.push({ source: WHOOP, stated_ms: end_ms + HOUR, rows: whoop }, { source: APPLE, stated_ms: end_ms + 2 * HOUR, rows: apple });
  }
  const phone = mulberry32(seed + 101);
  for (let index = 0; index < days; index++) {
    const day = addDays(FIRST, index);
    deliveries.push({ source: USAGE, stated_ms: dayBounds(day, SETTINGS).end_ms + 3 * HOUR, rows: usageDay(day, index, phone) });
  }
  return deliveries;
}

function landAll(home: TestHome, deliveries: readonly Delivery[], each = false): Pass[] {
  const out: Pass[] = [];
  for (const delivery of deliveries) {
    home.land(delivery.source, delivery.stated_ms, delivery.rows);
    if (each) out.push(pass(home));
  }
  if (!each) out.push(pass(home));
  return out;
}

function ticked(row: ReaderOutput): ReaderOutput | null {
  const content = structuredClone(row.content) as JsonObject;
  const inner = content.content as JsonObject | undefined;
  if (content.type === "whoop.hr" || content.type === "whoop.stress") {
    const point = inner!;
    point.segment_styles = (point.segment_styles as string[]).length === 0 ? ["TILT_MODE_SLEEP"] : [];
    point.position_x = (point.position_x as number) + 0.013;
    point.position_y = (point.position_y as number) + 0.021;
    if (content.type === "whoop.stress") point.value = (point.value as number) + 0.0004;
  } else if (content.type === "whoop.cycle") {
    inner!.updated_at = iso(Date.parse(inner!.updated_at as string) + MINUTE);
    const score = inner!.score as JsonObject;
    score.step_count = (score.step_count as number) + 120;
    if (inner!.end === null) Object.assign(score, { strain: (score.strain as number) + 0.4, kilojoule: (score.kilojoule as number) + 300, average_heart_rate: 77 });
  } else if (content.type === "whoop.recovery") {
    Object.assign(inner!, { updated_at: iso(Date.parse(inner!.updated_at as string) + MINUTE), created_at: iso(Date.parse(inner!.created_at as string) + 1) });
    Object.assign(inner!.score as JsonObject, { user_calibrating: true, spo2_percentage: 97.5, skin_temp_celsius: 33.4 });
  } else if (content.type === "whoop.sleep") {
    Object.assign(inner!, { updated_at: iso(Date.parse(inner!.updated_at as string) + MINUTE), timezone_offset: "-05:00" });
    if (inner!.score !== null) Object.assign(inner!.score as JsonObject, { sleep_consistency_percentage: 61, sleep_needed: { baseline_milli: 1 } });
  } else if (content.type === "whoop.workout") {
    inner!.updated_at = iso(Date.parse(inner!.updated_at as string) + MINUTE);
    Object.assign(inner!.score as JsonObject, { percent_recorded: 99, altitude_gain_meter: 12.5, zone_durations: { zone_one_milli: 61_000 } });
  } else if (content.type === "health.sample") {
    content.metadata = { HKMetadataKeySyncIdentifier: "resynced", HKMetadataKeyHeartRateMotionContext: 1 };
    content.device = { hardware_model: "Watch0,0", software_version: "99.1" };
  } else if (content.type === "health.day-summary") {
    Object.assign(content, { move_time: "1", move_time_goal: "1" });
  } else if (content.type === "usage.segment") {
    tickUsage(inner!);
  } else return null;
  return { ...row, content };
}

function tickUsage(line: JsonObject): void {
  const data = (line.payload as JsonObject).data as JsonObject;
  const updated = data.lastUpdatedDate as { epochSeconds: number };
  Object.assign(data, {
    lastUpdatedDate: appleDate(updated.epochSeconds * 1000 + 7 * MINUTE), osVersion: "Version 0.1 (Build 0A1)", xcodeBuild: "0A1",
    segmentInterval: { ...(data.segmentInterval as JsonObject), during: { start: appleDate(0), end: appleDate(86_400_000) } },
    totalPickupsWithoutApplicationActivity: (data.totalPickupsWithoutApplicationActivity as number) + 3,
    firstPickup: appleDate(1_000_000), longestActivity: { start: appleDate(1_000_000), end: appleDate(1_060_000) },
  });
  for (const category of data.categories as JsonObject[]) {
    for (const app of category.applications as JsonObject[]) Object.assign(app, { numberOfPickups: 9, numberOfNotifications: 40 });
    category.webDomains = [{ webDomain: { domain: "example.com", token: null }, totalActivityDuration: 1 }];
  }
  line.captured = { ...(line.captured as JsonObject), monotonic_s: 99 };
}

interface Printed { text: string; atoms: number[] }

function printed(rendered: RenderedDay): Printed[] {
  const map = JSON.parse(rendered.lines) as number[][];
  return rendered.txt.split("\n").slice(0, -1).map((text, index) => ({ text, atoms: map[index]! }));
}

interface Atom { n: number; unit: string; units: string[]; text: string; start_ms: number | null; local_start: string | null; local_end: string | null;
  block?: { key: string; title: string } }

const atomsOf = (rendered: RenderedDay) => (JSON.parse(rendered.json) as { atoms: Atom[] }).atoms;


describe("health family, end to end through core", () => {
  it("an extract is written when only an unread field ticked (every measured ticking path flipped)", () => {
    const home = newHome();
    try {
      const deliveries = dataset(3);
      landAll(home, deliveries);
      const before = extracts(home);
      expect(before.length).toBeGreaterThan(300);
      const changedPaths: Record<string, number> = {};
      let changed = 0;
      for (const delivery of deliveries) {
        const rows = delivery.rows.map(ticked).filter((row) => row !== null);
        const landed = home.land(delivery.source, delivery.stated_ms + 24 * HOUR, rows);
        changed += landed.changed;
        for (const [path, count] of Object.entries(landed.changedPaths)) changedPaths[path] = (changedPaths[path] ?? 0) + count;
      }
      const ticks = pass(home);
      expect(changed).toBe(deliveries.reduce((sum, delivery) => sum + delivery.rows.length, 0));
      for (const path of ["content.segment_styles", "content.position_x", "content.position_y", "content.value", "content.updated_at",
        "content.score.step_count", "content.score.strain", "metadata.HKMetadataKeySyncIdentifier", "device", "move_time",
        "content.payload.data.lastUpdatedDate", "content.payload.data.categories"]) {
        expect(Object.keys(changedPaths).some((name) => name.startsWith(path)), path).toBe(true);
      }
      expect(ticks.touched.length).toBeGreaterThan(0);
      expect(ticks.written).toEqual([]);
      expect(ticks.deleted).toEqual([]);
      expect(extracts(home)).toEqual(before);

      const point = deliveries[0]!.rows.find((row) => row.kind === "sample" && (row.content as JsonObject).type === "whoop.hr")!;
      const restated = structuredClone(point);
      ((restated.content as JsonObject).content as JsonObject).bpm = 140;
      home.land(WHOOP, deliveries[0]!.stated_ms + 48 * HOUR, [restated]);
      const genuine = pass(home);
      expect(genuine.written).toEqual([`span/${WHOOP}/${Math.floor(point.time!.start_ms / 900_000) * 900_000}/${Math.floor(point.time!.start_ms / 900_000) * 900_000 + 900_000}`]);
      ARTIFACT.ticks = { changed, changedPaths, touched: ticks.touched.length, wrote: ticks.written, genuine: genuine.written };
    } finally {
      home.close();
    }
  });

  it("units differ when the same data arrives in another order", () => {
    const deliveries = dataset(4, 11);
    const steps = deliveries[1]!.rows.find((row) => row.kind === "sample" && (row.content as JsonObject).type === "health.sample")!;
    const later = deliveries.at(-1)!.stated_ms;
    deliveries.push({ source: APPLE, stated_ms: later + HOUR, rows: [{ kind: "sample", key: steps.key, content: null, gone: true }] });
    deliveries.push({ source: APPLE, stated_ms: later + 2 * HOUR, rows: [steps] });
    const orders = {
      arrival: deliveries,
      reversed: [...deliveries].reverse(),
      shuffled: shuffle(deliveries, 3),
    };
    const results: Record<string, { unit: string; reading: string; days: string[] }[]> = {};
    const once = newHome();
    try {
      landAll(once, deliveries);
      results.once = extracts(once).map(({ unit, reading, days }) => ({ unit, reading, days }));
      for (const [name, order] of Object.entries(orders)) {
        const home = newHome();
        try {
          landAll(home, order, true);
          results[name] = extracts(home).map(({ unit, reading, days }) => ({ unit, reading, days }));
          expect(render(home, addDays(FIRST, 2)).txt, name).toBe(render(once, addDays(FIRST, 2)).txt);
        } finally {
          home.close();
        }
        expect(results[name], name).toEqual(results.once);
      }
    } finally {
      once.close();
    }
    ARTIFACT.order = { units: results.once!.length, readings: digest(results.once as unknown as Json) };
  });

  it("a deleted-then-returned sample is counted twice or lost", () => {
    const home = newHome();
    try {
      const { start_ms } = dayBounds(FIRST, SETTINGS);
      const span = Math.floor((start_ms + 5 * HOUR) / 900_000) * 900_000;
      const sample = (minute: number, value: string) => appleSample({ type: "HKQuantityTypeIdentifierStepCount", start_ms: span + minute * MINUTE,
        end_ms: span + (minute + 2) * MINUTE, value, unit: "count", from: "iPhone" });
      const [a, k, b] = [sample(1, "100"), sample(5, "250"), sample(9, "50")];
      const unit = `span/${APPLE}/${span}/${span + 900_000}`;
      const lane = () => {
        const extract = extracts(home).find((row) => row.unit === unit);
        return extract === undefined ? null : ((extract.content as JsonObject).lanes as JsonObject[])[0]!;
      };
      const t1 = start_ms + 6 * HOUR;
      home.land(APPLE, t1, [a, k, b]);
      pass(home);
      expect(lane()).toMatchObject({ count: 3, sum: 400 });
      home.land(APPLE, t1 + HOUR, [{ kind: "sample", key: k.key, content: null, gone: true }]);
      pass(home);
      expect(lane()).toMatchObject({ count: 2, sum: 150 });
      home.land(APPLE, t1 + 3 * HOUR, [k]);
      pass(home);
      expect(lane()).toMatchObject({ count: 3, sum: 400 });
      const replay = home.land(APPLE, t1 + HOUR, [{ kind: "sample", key: k.key, content: null, gone: true }]);
      expect(replay.gone + replay.changed + replay.new).toBe(0);
      expect(pass(home).written).toEqual([]);
      expect(lane()).toMatchObject({ count: 3, sum: 400 });
      ARTIFACT.deletion = { unit, lane: lane() };
    } finally {
      home.close();
    }
  });

  it("a sample is counted twice through the export and the bundle, or through WHOOP's copy in Apple Health", () => {
    const home = newHome();
    try {
      const { start_ms } = dayBounds(FIRST, SETTINGS);
      const span = Math.floor((start_ms + 6 * HOUR) / 900_000) * 900_000;
      const steps = appleSample({ type: "HKQuantityTypeIdentifierStepCount", start_ms: span + MINUTE, end_ms: span + 3 * MINUTE, value: "321", unit: "count", from: "iPhone" });
      const copy = appleSample({ type: "HKQuantityTypeIdentifierHeartRate", start_ms: span + 2 * MINUTE, end_ms: span + 2 * MINUTE, value: "71", unit: "count/min", from: "WHOOP" });
      const watch = appleSample({ type: "HKQuantityTypeIdentifierHeartRate", start_ms: span + 4 * MINUTE, end_ms: span + 4 * MINUTE, value: "66", unit: "count/min", from: "Apple Watch" });
      home.land(APPLE, start_ms + 8 * HOUR, [steps, copy, watch]);
      home.land(APPLE, start_ms + 30 * HOUR, [{ ...steps, content: { ...(steps.content as JsonObject), metadata: {} } }, copy, watch]);
      home.land(WHOOP, start_ms + 9 * HOUR, [whoopPoint("hr", span + 2 * MINUTE, 71), whoopPoint("hr", span + 7 * MINUTE, 73)]);
      pass(home);
      const lanes = (source: string) => (extracts(home).find((row) => row.unit === `span/${source}/${span}/${span + 900_000}`)!.content as JsonObject).lanes;
      expect(lanes(APPLE)).toEqual([
        { metric: "heart_rate", instrument: "Apple Watch", unit: "count/min", count: 1, sum: 66, min: 66, max: 66 },
        { metric: "steps", instrument: "iPhone", unit: "count", count: 1, sum: 321, min: 321, max: 321 },
      ]);
      expect(lanes(WHOOP)).toEqual([{ metric: "heart_rate", instrument: "WHOOP", unit: "count/min", count: 2, sum: 144, min: 71, max: 73 }]);
      ARTIFACT.copies = { apple: lanes(APPLE)!, whoop: lanes(WHOOP)! };
    } finally {
      home.close();
    }
  });

  it("a vitals baseline reads outside its lookback, or renderDay reads outside days()", () => {
    const { deliveries, dbPath } = get17();
    const home = newHome(dbPath);
    try {
      const all = extracts(home);
      const target = addDays(FIRST, 15);
      const inputs: Record<string, string> = {};
      for (let index = 0; index < 17; index++) {
        const day = addDays(FIRST, index);
        const strict = health.day({ day, settings: SETTINGS, extracts: all.filter((row) => row.days.includes(day)), enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines;
        const loose = health.day({ day, settings: SETTINGS, extracts: all, enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines;
        expect(onDay(loose, day), day).toEqual(onDay(strict, day));
        inputs[day] = render(home, day).inputs;
      }
      const day12 = render(home, addDays(FIRST, 12)).txt;
      expect(day12).toMatch(/Vitals against 12 Sep–25 Sep: heart rate high, over [\d.]+, at .*14:00–15:00 \(peak avg 1\d\d\)/u);

      const outside = deliveries[0]!.rows.find((row) => (row.content as JsonObject).type === "whoop.hr")!;
      home.land(WHOOP, deliveries.at(-1)!.stated_ms + HOUR, [{ ...outside, content: { type: "whoop.hr", content: { ...((outside.content as JsonObject).content as JsonObject), bpm: 199 } } }]);
      const first = pass(home);
      expect(first.written).toHaveLength(1);
      expect(extracts(home).find((row) => row.unit === first.written[0])!.days).not.toContain(target);
      expect(render(home, target).inputs).toBe(inputs[target]);
      const inside = deliveries[2]!.rows.find((row) => (row.content as JsonObject).type === "whoop.hr")!;
      home.land(WHOOP, deliveries.at(-1)!.stated_ms + 2 * HOUR, [{ ...inside, content: { type: "whoop.hr", content: { ...((inside.content as JsonObject).content as JsonObject), bpm: 199 } } }]);
      const second = pass(home);
      expect(extracts(home).find((row) => row.unit === second.written[0])!.days).toContain(target);
      expect(render(home, target).inputs).not.toBe(inputs[target]);
      ARTIFACT.lookback = { inputs, outside: first.written, inside: second.written };
    } finally {
      home.close();
    }
  });

  it("the vitals heading states the accounts of its day's values and not those its baseline reads", () => {
    const { home } = get17();
    const day = addDays(FIRST, 15);
    const today = dayBounds(day, SETTINGS);
    const appleToday = (row: { unit: string; start_ms: number | null }) => row.unit.includes(`/${APPLE}/`) && row.start_ms! >= today.start_ms && row.start_ms! < today.end_ms;
    const read = extracts(home).filter((row) => row.days.includes(day) && !appleToday(row));
    const vitals = health.day({ day, settings: SETTINGS, extracts: read, enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines.find((line) => line.unit === `vitals/${day}`)!;
    expect(vitals.units.some((unit) => unit.includes(`/${APPLE}/`))).toBe(false);
    expect(vitals.accounts).toEqual(["apple-health:person-a@example.com", "whoop:1"]);
  });

  it("a date-precision summary is shifted a day by the zone", () => {
    for (const zone of ["Pacific/Kiritimati", "Pacific/Pago_Pago", "America/New_York", "Asia/Kolkata"]) {
      const settings: DaySettings = { zone, day_start_hour: 4 };
      const home = newHome();
      try {
        home.land(APPLE, Date.parse("2026-10-07T00:00:00Z"), [daySummary("2026-10-05", "512")]);
        pass(home, settings);
        const [summary] = extracts(home);
        expect(summary!.days, zone).toEqual(["2026-10-05"]);
        for (const day of ["2026-10-04", "2026-10-05", "2026-10-06"]) {
          const atoms = (JSON.parse(render(home, day, settings).json) as { atoms: { text: string; flags: string[] }[] }).atoms;
          const shown = atoms.filter((atom) => atom.text.startsWith("Activity: move 512"));
          expect(shown.length, `${zone} ${day}`).toBe(day === "2026-10-05" ? 1 : 0);
          if (shown.length > 0) expect(shown[0]!.flags).toEqual(["date_only"]);
        }
      } finally {
        home.close();
      }
    }
  });

  it("a day with 15-minute heart-rate and stress samples prints no 15-minute rows, or prints one outside its run", () => {
    const home = newHome();
    try {
      const deliveries = dataset(6);
      landAll(home, deliveries);
      const day = addDays(FIRST, 4);
      const window = dayBounds(day, SETTINGS);
      const rendered = render(home, day);
      const atoms = atomsOf(rendered);
      const byUnit = new Map(atoms.map((atom) => [atom.unit, atom]));
      const spans = extracts(home).filter((row) => row.unit.startsWith("span/") && !(row.content as JsonObject).own &&
        row.start_ms! >= window.start_ms && row.start_ms! < window.end_ms);
      expect(spans.length).toBe(96 + 56);
      for (const span of spans) {
        expect(byUnit.get(span.unit)?.block?.key, span.unit).toMatch(/^health\//u);
        expect(rendered.units.find((unit) => unit.unit === span.unit)?.shown, span.unit).toBe(true);
      }
      const lines = printed(rendered);
      const rows = new Set(atoms.filter((atom) => atom.block?.key.startsWith("health/")).map((atom) => atom.n));
      const placed = new Map<number, string[]>();
      let runs = 0;
      for (let index = 0; index < lines.length; index++) {
        const line = lines[index]!;
        if (!line.atoms.some((n) => rows.has(n))) continue;
        if (line.atoms.length === 1) {
          expect(line.text, line.text).toMatch(/^(?:\d{4}-\d\d-\d\d )?\d\d:\d\d–\d\d:\d\d [^·]+ · \S/u);
          placed.set(line.atoms[0]!, [...placed.get(line.atoms[0]!) ?? [], line.text]);
          continue;
        }
        runs++;
        const title = atoms[line.atoms[0]! - 1]!.block!.title;
        expect(line.atoms.every((n) => atoms[n - 1]!.block!.title === title), line.text).toBe(true);
        expect(line.text).toMatch(/^(?:\d{4}-\d\d-\d\d )?\d\d:\d\d–(?:\d{4}-\d\d-\d\d )?\d\d:\d\d /u);
        expect(line.text.endsWith(` ${title} (${line.atoms.length})`), line.text).toBe(true);
        const under = lines.slice(index + 1, index + 1 + line.atoms.length);
        expect(under.map((row) => row.atoms), line.text).toEqual(line.atoms.map((n) => [n]));
        for (const row of under) {
          expect(row.text.startsWith("  "), row.text).toBe(true);
          placed.set(row.atoms[0]!, [...placed.get(row.atoms[0]!) ?? [], row.text]);
        }
        index += line.atoms.length;
      }
      expect(runs).toBeGreaterThan(1);
      for (const n of rows) expect(placed.get(n), `atom ${n}`).toHaveLength(1);
      const slot = window.start_ms + HOUR;
      const whoopDay = deliveries.find((delivery) => delivery.source === WHOOP && delivery.stated_ms === window.end_ms + HOUR)!;
      const bpm = whoopDay.rows.filter((row) => (row.content as JsonObject).type === "whoop.hr" && row.time!.start_ms >= slot && row.time!.start_ms < slot + 900_000)
        .map((row) => ((row.content as JsonObject).content as JsonObject).bpm as number);
      const stress = whoopDay.rows.filter((row) => (row.content as JsonObject).type === "whoop.stress" && row.time!.start_ms >= slot && row.time!.start_ms < slot + 900_000)
        .map((row) => Number(((row.content as JsonObject).content as JsonObject).display));
      const row = byUnit.get(`span/${WHOOP}/${slot}/${slot + 900_000}`)!;
      expect(row.block!.title).toBe("WHOOP heart rate, stress");
      expect(row.text).toBe(`hr ${range(bpm)}; stress ${range(stress)}`);
      ARTIFACT.rows = { day, spans: spans.length, runs, sample: lines.filter((line) => line.atoms.some((n) => rows.has(n))).slice(0, 8).map((line) => line.text) };
    } finally {
      home.close();
    }
  });

  it("iPhone steps per 15 minutes are missing beside WHOOP", () => {
    const home = newHome();
    try {
      const deliveries = dataset(6);
      landAll(home, deliveries);
      const day = addDays(FIRST, 4);
      const window = dayBounds(day, SETTINGS);
      const slot = window.start_ms + 5 * HOUR;
      const appleDay = deliveries.find((delivery) => delivery.source === APPLE && delivery.stated_ms === window.end_ms + 2 * HOUR)!;
      const steps = (from: string) => appleDay.rows.filter((row) => (row.content as JsonObject).type === "health.sample" &&
        (row.content as JsonObject).source_name === from && (row.content as JsonObject).sample_type === "HKQuantityTypeIdentifierStepCount" &&
        row.time!.start_ms >= slot && row.time!.start_ms < slot + 900_000).reduce((sum, row) => sum + Number((row.content as JsonObject).value), 0);
      const rendered = render(home, day);
      const atoms = atomsOf(rendered);
      const apple = atoms.find((atom) => atom.unit === `span/${APPLE}/${slot}/${slot + 900_000}`)!;
      const whoop = atoms.find((atom) => atom.unit === `span/${WHOOP}/${slot}/${slot + 900_000}`)!;
      expect(apple.block!.title).toBe("Apple Watch steps; iPhone steps; WHOOP heart rate, stress");
      expect(whoop.block).toEqual(apple.block);
      expect(whoop.n).toBe(apple.n + 1);
      expect(apple.text).toBe(`steps ${steps("Apple Watch").toLocaleString("en-US")} (Apple Watch); steps ${steps("iPhone").toLocaleString("en-US")} (iPhone)`);
      expect(whoop.text).toMatch(/^hr [\d.–]+(?: avg [\d.]+)?; stress [\d.]+ \(WHOOP\)$/u);
      const lines = printed(rendered);
      const at = lines.findIndex((line) => line.atoms.length === 1 && line.atoms[0] === apple.n);
      expect(lines[at]!.text).toBe(`  ${apple.local_start}–${apple.local_end} ${apple.text}`);
      expect(lines[at + 1]).toEqual({ text: `  ${whoop.text}`, atoms: [whoop.n] });
      ARTIFACT.beside = { day, slot: apple.local_start, lines: [lines[at]!.text, lines[at + 1]!.text] };
    } finally {
      home.close();
    }
  });

  it("a day with phone usage prints no phone hour, or its categories out of minute order, or one name twice, or a total that is not the stated one", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 2);
      const { start_ms } = dayBounds(day, SETTINGS);
      const hour = (offset: number) => start_ms + offset * HOUR;
      const busy = usageSegment({ start_ms: hour(1), categories: [["Utilities", 100], ["Games", 840], ["Other", 20], ["Entertainment", 500], ["Utilities", 70]], sequence: 1, captured_ms: hour(3) });
      const whole = usageSegment({ start_ms: hour(4), categories: [["Information & Reading", 300], ["Games", 300]], sequence: 3, captured_ms: hour(6) });
      const partial = usageSegment({ start_ms: hour(4), categories: [["Games", 100]], sequence: 2, captured_ms: hour(4) + 20 * MINUTE });
      const idle = usageSegment({ start_ms: hour(6), categories: [], sequence: 4, captured_ms: hour(8) });
      const daily = usageSegment({ start_ms: hour(0), kind: "daily", categories: [["Games", 4000]], sequence: 5, captured_ms: hour(20) });
      home.land(USAGE, hour(9), [busy, whole, idle, daily]);
      home.land(USAGE, hour(10), [partial]);
      pass(home);
      const phone = extracts(home).filter((row) => row.unit.startsWith("phone/"));
      expect(phone.map((row) => row.unit)).toEqual([`phone/${USAGE}/${hour(1)}`, `phone/${USAGE}/${hour(4)}`]);
      const first = phone[0]!.content as { seconds: number; categories: { seconds: number }[] };
      expect(first.seconds).toBe(1530);
      expect(first.categories.reduce((sum, category) => sum + category.seconds, 0)).toBe(first.seconds);
      const rendered = render(home, day);
      const lines = rendered.txt.split("\n");
      expect(lines).toContain("05:00–06:00 Phone: 26 min, Games 14 min, Entertainment 8 min, Utilities 3 min, Other <1 min");
      expect(lines).toContain("08:00–09:00 Phone: 10 min, Games 5 min, Information & Reading 5 min");
      expect(lines.filter((line) => line.includes("Phone"))).toHaveLength(2);
      expect(lines.filter((line) => line.startsWith("health: "))).toEqual([`health: ${USAGE} read into the day`]);
      ARTIFACT.phone = { day, extracts: phone.map(({ unit, content }) => ({ unit, content })), lines: lines.filter((line) => line.includes("Phone")) };
    } finally {
      home.close();
    }
  });

  it("a usage row restated with only a ticking field re-renders the day", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 2);
      const { start_ms, end_ms } = dayBounds(day, SETTINGS);
      const hour = start_ms + 4 * HOUR;
      const categories: [string, number][] = [["Games", 610], ["Utilities", 95]];
      const snapshot = usageSegment({ start_ms: hour, categories, sequence: 7, captured_ms: hour + HOUR });
      home.land(USAGE, end_ms + HOUR, [snapshot]);
      pass(home);
      const before = render(home, day);
      const restated = ticked(snapshot)!;
      const newer = ticked(usageSegment({ start_ms: hour, categories, sequence: 8, captured_ms: hour + 3 * HOUR, pickups: 4, updated_ms: hour + 3 * HOUR }))!;
      const landed = home.land(USAGE, end_ms + 2 * HOUR, [restated, newer]);
      expect(landed.changed + landed.new).toBe(2);
      const quiet = pass(home);
      expect(quiet.touched).toEqual([`phone/${USAGE}/${hour}`]);
      expect(quiet.written).toEqual([]);
      expect(render(home, day).inputs).toBe(before.inputs);
      home.land(USAGE, end_ms + 3 * HOUR, [usageSegment({ start_ms: hour, categories: [["Games", 900], ["Utilities", 95]], sequence: 9, captured_ms: hour + 4 * HOUR })]);
      const genuine = pass(home);
      expect(genuine.written).toEqual([`phone/${USAGE}/${hour}`]);
      const after = render(home, day);
      expect(after.inputs).not.toBe(before.inputs);
      expect(after.txt).toContain("08:00–09:00 Phone: 17 min, Games 15 min, Utilities 2 min");
      ARTIFACT.usageTicks = { quiet: quiet.written, genuine: genuine.written };
    } finally {
      home.close();
    }
  });

  it("WHOOP's app shape prints a night twice beside its developer shape, a span counts two heart-rate series, or an unprinted cycle field rewrites an extract", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 1);
      const { start_ms, end_ms } = dayBounds(day, SETTINGS);
      const sleepStart = start_ms - 4.5 * HOUR;
      const wake = start_ms + 3 * HOUR;
      const during = (a: number, b: number) => `['${iso(a)}','${iso(b)}')`;
      const metricsPoint = (step: number, at_ms: number, bpm: number): ReaderOutput => ({
        kind: "sample", key: `hr${step}:${basic(at_ms)}`,
        content: { type: "whoop.heart-rate", content: { bpm } }, time: { start_ms: at_ms, precision: "ms" },
      });
      const spanAt = start_ms + HOUR;
      const workoutId = "00000000-0000-4000-8000-000000000999";
      home.land(WHOOP, end_ms, [
        whoopObject("workout", workoutId, {
          id: workoutId, user_id: 1, created_at: iso(wake), updated_at: iso(wake), start: iso(wake + HOUR), end: iso(wake + 2 * HOUR),
          timezone_offset: "-04:00", sport_name: "running", sport_id: 0, score_state: "SCORED", score: { strain: 5.5 },
        }, wake + HOUR, wake + 2 * HOUR),
        whoopObject("recovery", "4242", {
          cycle_id: 4242, sleep_id: sleepId(42), user_id: 1, created_at: iso(wake), updated_at: iso(wake), score_state: "SCORED",
          score: { recovery_score: 77, resting_heart_rate: 54, hrv_rmssd_milli: 60 },
        }, wake),
        whoopObject("physio-day", "4242", {
          id: 4242, user_id: 1, created_at: iso(wake), updated_at: iso(wake), start: iso(wake - 24 * HOUR), end: iso(wake),
          timezone_offset: "-04:00", score_state: "SCORED", score: { strain: 9.5, kilojoule: 8000, average_heart_rate: 70, max_heart_rate: 120 },
        }, wake - 24 * HOUR, wake),
        whoopPoint("hr", spanAt + MINUTE, 200),
        metricsPoint(60, spanAt + MINUTE, 100),
        metricsPoint(6, spanAt + MINUTE, 60),
        metricsPoint(6, spanAt + MINUTE + 6_000, 62),
        whoopObject("sleep", sleepId(42), {
          id: sleepId(42), cycle_id: 4242, user_id: 1, created_at: iso(wake), updated_at: iso(wake), start: iso(sleepStart), end: iso(wake),
          timezone_offset: "-04:00", nap: false, score_state: "SCORED", score: { respiratory_rate: 15.2 },
        }, sleepStart, wake),
      ]);
      pass(home);
      const span = extracts(home).find((row) => row.unit === `span/${WHOOP}/${spanAt}/${spanAt + 900_000}`)!;
      const lanes = (span.content as unknown as { lanes: { metric: string; count: number; sum: number }[] }).lanes;
      expect(lanes).toEqual([{ metric: "heart_rate", instrument: "WHOOP", unit: "count/min", count: 2, sum: 122, min: 60, max: 62 }]);
      const oldUnits = [`sleep/${WHOOP}/${sleepId(42)}`, `workout/${WHOOP}/${workoutId}`, `recovery/${WHOOP}/4242`];
      for (const unit of oldUnits) expect(extracts(home).some((row) => row.unit === unit), unit).toBe(true);

      const answer = (debt: number, open = false): JsonObject => ({
        cycle: {
          id: 4242, user_id: 1, during: open ? `['${iso(wake - 24 * HOUR)}',)` : during(wake - 24 * HOUR, wake), timezone_offset: "-0400",
          scaled_strain: 9.5, day_kilojoules: 8000, day_avg_heart_rate: 70, day_max_heart_rate: 120,
        },
        recovery: { activity_id: sleepId(42), user_id: 1, recovery_score: 77, resting_heart_rate: 54, hrv_rmssd: 0.06 },
        sleeps: [{
          activity_id: sleepId(42), user_id: 1, during: during(sleepStart, wake), timezone_offset: "-04:00",
          state: "SCORED", score: 88, is_nap: false, time_in_bed: wake - sleepStart, light_sleep_duration: 200 * MINUTE,
          slow_wave_sleep_duration: 90 * MINUTE, rem_sleep_duration: 120 * MINUTE, wake_duration: 20 * MINUTE,
          cycles_count: 4, disturbances: 2, in_sleep_efficiency: 0.93, respiratory_rate: 15.2, debt_pre: debt,
        }],
        workouts: [
          { activity_id: workoutId, during: during(wake + HOUR, wake + 2 * HOUR), timezone_offset: "-04:00", score: 5.5, sport_id: 9999 },
          { activity_id: "00000000-0000-4000-8000-000000000998", during: during(wake + 3 * HOUR, wake + 3.5 * HOUR), timezone_offset: "-04:00",
            score: 12.2, sport_id: 0, kilojoules: 1569.34, average_heart_rate: 152, max_heart_rate: 198, total_steps: null, zone_durations_v2: { zone0_to50_duration: 0 } },
        ],
        v2_activities: [],
      });
      const cycleRow = (debt: number, open = false): ReaderOutput => ({
        kind: "cycle", key: "4242",
        content: { type: "whoop.cycle-details", content: answer(debt, open) },
        time: open ? { start_ms: wake - 24 * HOUR, precision: "ms" } : { start_ms: wake - 24 * HOUR, end_ms: wake, precision: "ms" },
      });
      home.land(WHOOP, end_ms + HOUR / 2, [cycleRow(0.5, true)]);
      const opened = pass(home);
      expect([...opened.deleted].sort()).toEqual([...oldUnits].sort());
      home.land(WHOOP, end_ms + HOUR, [cycleRow(0.5)]);
      const switched = pass(home);
      for (const unit of oldUnits) expect(extracts(home).some((row) => row.unit === unit), unit).toBe(false);
      expect(extracts(home).some((row) => row.unit === `cycle/${WHOOP}/4242`)).toBe(true);
      const rendered = render(home, day);
      const lines = rendered.txt.split("\n");
      expect(lines.filter((line) => line.includes("Sleep "))).toHaveLength(1);
      expect(lines.find((line) => line.includes("Sleep "))).toContain("performance 88%");
      expect(lines.find((line) => line.includes("Sleep "))).toContain("efficiency 93%");
      expect(lines.some((line) => line.includes("recovery — score 77, HRV 60, resting heart rate 54"))).toBe(true);
      expect(lines.some((line) => line.includes("workout — duration 1:00, strain 5.5"))).toBe(true);
      expect(lines.some((line) => line.endsWith("workout — running, duration 0:30, average heart rate 152, max heart rate 198, energy 375 kcal, strain 12.2"))).toBe(true);
      home.land(WHOOP, end_ms + 2 * HOUR, [cycleRow(9.75)]);
      const quiet = pass(home);
      expect(quiet.written).toEqual([]);
      expect(render(home, day).inputs).toBe(rendered.inputs);
      ARTIFACT.cycleShape = { deleted: switched.deleted, lines: lines.filter((line) => /Sleep |recovery|workout/u.test(line)), quiet: quiet.written };
    } finally {
      home.close();
    }
  });

  it("WHOOP's heart rate in Apple Health is lost where the WHOOP connector states none, or counted beside the connector's", () => {
    const home = newHome();
    try {
      const { start_ms } = dayBounds(addDays(FIRST, 1), SETTINGS);
      const [both, alone] = [start_ms + 6 * HOUR, start_ms + 7 * HOUR];
      const heart = (at_ms: number, value: string, from: string) =>
        appleSample({ type: "HKQuantityTypeIdentifierHeartRate", start_ms: at_ms, end_ms: at_ms, value, unit: "count/min", from });
      const unit = (source: string, span: number) => `span/${source}/${span}/${span + 900_000}`;
      const lanes = (source: string, span: number) => (extracts(home).find((row) => row.unit === unit(source, span))?.content as JsonObject | undefined)?.lanes;
      home.land(APPLE, start_ms + 9 * HOUR, [heart(both + 2 * MINUTE, "71", "WHOOP"), heart(both + 4 * MINUTE, "66", "Apple Watch"),
        heart(alone + MINUTE, "80", "WHOOP"), heart(alone + 3 * MINUTE, "84", "WHOOP")]);
      pass(home);
      expect(lanes(APPLE, both)).toEqual([
        { metric: "heart_rate", instrument: "Apple Watch", unit: "count/min", count: 1, sum: 66, min: 66, max: 66 },
        { metric: "heart_rate", instrument: "WHOOP", unit: "count/min", count: 1, sum: 71, min: 71, max: 71 },
      ]);
      const atom = (span: number) => atomsOf(render(home, addDays(FIRST, 1))).find((row) => row.unit === unit(APPLE, span))!;
      expect(atom(both).text).toBe("hr 66 (Apple Watch); hr 71 (WHOOP)");
      expect(atom(alone)).toMatchObject({ text: "hr 80–84 avg 82", block: { title: "WHOOP heart rate" } });
      home.land(WHOOP, start_ms + 10 * HOUR, [whoopPoint("hr", both + 2 * MINUTE, 72), whoopPoint("hr", both + 7 * MINUTE, 74)]);
      const landed = pass(home);
      expect(landed.written).toContain(unit(APPLE, both));
      expect(lanes(APPLE, both)).toEqual([{ metric: "heart_rate", instrument: "Apple Watch", unit: "count/min", count: 1, sum: 66, min: 66, max: 66 }]);
      expect(lanes(WHOOP, both)).toEqual([{ metric: "heart_rate", instrument: "WHOOP", unit: "count/min", count: 2, sum: 146, min: 72, max: 74 }]);
      expect(lanes(APPLE, alone)).toEqual([{ metric: "heart_rate", instrument: "WHOOP", unit: "count/min", count: 2, sum: 164, min: 80, max: 84 }]);
      ARTIFACT.healthCopy = { both: lanes(APPLE, both)!, connector: lanes(WHOOP, both)!, alone: lanes(APPLE, alone)! };
    } finally {
      home.close();
    }
  });

  it("Apple Health's sleep prints no night, one night in pieces as many, or the WHOOP app's copy beside the WHOOP connector's own night", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 1);
      const { start_ms } = dayBounds(day, SETTINGS);
      const night = start_ms - 4.5 * HOUR;
      const stage = (from: string, value: string, start: number, minutes: number, recovery?: number) => appleSample({
        type: "HKCategoryTypeIdentifierSleepAnalysis", start_ms: start, end_ms: start + minutes * MINUTE,
        value: `HKCategoryValueSleepAnalysis${value}`, unit: "", from,
        metadata: { HKMetadataKeySyncIdentifier: `sync-${from}-${start}`, ...(recovery === undefined ? {} : { "WHOOP Recovery": recovery }) },
      });
      const run = (from: string, start: number, steps: [string, number][], recovery?: number) => {
        let at = start;
        return steps.map(([value, minutes]) => {
          const row = stage(from, value, at, minutes, recovery);
          at += minutes * MINUTE;
          return row;
        });
      };
      const whoopNight = [stage("WHOOP", "InBed", night, 450, 64), ...run("WHOOP", night, [["Awake", 15], ["AsleepCore", 90], ["AsleepDeep", 75],
        ["AsleepREM", 60], ["AsleepCore", 90], ["Awake", 10], ["AsleepREM", 90], ["AsleepCore", 20]], 64)];
      const watchNight = run("Apple Watch", night + 10 * MINUTE, [["AsleepCore", 200], ["AsleepDeep", 90], ["AsleepREM", 140], ["Awake", 5]]);
      const nextNight = run("Apple Watch", night + 24 * HOUR + 30 * MINUTE, [["AsleepCore", 120], ["AsleepUnspecified", 60], ["AsleepREM", 100], ["Awake", 10]]);
      const all = [...whoopNight, ...watchNight];
      home.land(APPLE, start_ms + 4 * HOUR, shuffled(all.slice(0, 7), 5));
      home.land(APPLE, start_ms + 5 * HOUR, shuffled(all.slice(7), 6));
      home.land(APPLE, start_ms + 29 * HOUR, nextNight);
      pass(home);
      expect(extracts(home).filter((row) => row.unit.startsWith(`span/${APPLE}/`))).toEqual([]);
      const sleeps = (on: string) => render(home, on).txt.split("\n").filter((line) => line.startsWith("Sleep "));
      const whoopLine = "Sleep 23:30–07:00, wake at 07:00: in bed 7:30, core 3:20, deep 1:15, REM 2:30, awake 0:25, recovery 64 (WHOOP)";
      const watchLine = "Sleep 23:40–06:55, wake at 06:55: core 3:20, deep 1:30, REM 2:20, awake 0:05 (Apple Watch)";
      expect(sleeps(day).sort()).toEqual([whoopLine, watchLine].sort());
      expect(sleeps(addDays(day, -1))).toEqual([]);
      expect(sleeps(addDays(day, 1))).toEqual(["Sleep 00:00–04:50, wake at 04:50: asleep 1:00, core 2:00, REM 1:40, awake 0:10 (Apple Watch)"]);
      const wake = start_ms + 3 * HOUR;
      home.land(WHOOP, start_ms + 6 * HOUR, [whoopObject("sleep", sleepId(77), {
        id: sleepId(77), cycle_id: 7777, user_id: 1, created_at: iso(wake), updated_at: iso(wake), start: iso(night), end: iso(wake),
        timezone_offset: "-04:00", nap: false, score_state: "SCORED",
        score: { stage_summary: { total_in_bed_time_milli: wake - night, total_awake_time_milli: 25 * MINUTE, total_light_sleep_time_milli: 200 * MINUTE,
          total_slow_wave_sleep_time_milli: 75 * MINUTE, total_rem_sleep_time_milli: 150 * MINUTE, sleep_cycle_count: 4, disturbance_count: 3 },
          respiratory_rate: 15.2, sleep_performance_percentage: 88, sleep_efficiency_percentage: 93 },
      }, night, wake)]);
      pass(home);
      const connectorLine = "Sleep 23:30–07:00, wake at 07:00: in bed 7:30, light 3:20, deep 1:15, REM 2:30, awake 0:25, 4 cycles, 3 disturbances, efficiency 93%, performance 88%, respiratory rate 15.2";
      expect(sleeps(day).sort()).toEqual([connectorLine, watchLine].sort());
      ARTIFACT.healthSleep = { before: [whoopLine, watchLine], after: sleeps(day), next: sleeps(addDays(day, 1)) };
    } finally {
      home.close();
    }
  });

  it("the WHOOP app's night in Health ending just before the day's start prints beside the connector's same night ending just after it", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 3);
      const { start_ms } = dayBounds(day, SETTINGS);
      const night = start_ms - 5 * HOUR;
      const stages = [["AsleepCore", 120], ["AsleepDeep", 60], ["AsleepREM", 119]] as const;
      let at = night;
      home.land(APPLE, start_ms + 2 * HOUR, stages.map(([value, minutes]) => {
        const row = appleSample({ type: "HKCategoryTypeIdentifierSleepAnalysis", start_ms: at, end_ms: at + minutes * MINUTE,
          value: `HKCategoryValueSleepAnalysis${value}`, unit: "", from: "WHOOP", metadata: { "WHOOP Recovery": 51 } });
        at += minutes * MINUTE;
        return row;
      }));
      pass(home);
      const sleeps = (on: string) => render(home, on).txt.split("\n").filter((line) => line.startsWith("Sleep "));
      expect(sleeps(addDays(day, -1))).toEqual(["Sleep 23:00–03:59, wake at 03:59: core 2:00, deep 1:00, REM 1:59, recovery 51 (WHOOP)"]);
      const wake = start_ms + MINUTE;
      home.land(WHOOP, start_ms + 3 * HOUR, [whoopObject("sleep", sleepId(88), {
        id: sleepId(88), cycle_id: 8888, user_id: 1, created_at: iso(wake), updated_at: iso(wake), start: iso(night), end: iso(wake),
        timezone_offset: "-04:00", nap: false, score_state: "SCORED", score: { sleep_performance_percentage: 70 },
      }, night, wake)]);
      pass(home);
      expect(extracts(home).find((row) => row.unit === `sleep/${WHOOP}/${sleepId(88)}`)!.days).toEqual([addDays(day, -1), day, addDays(day, 1)]);
      expect(sleeps(addDays(day, -1))).toEqual([]);
      expect(sleeps(day)).toEqual(["Sleep 23:00–04:01, wake at 04:01: performance 70%"]);
      ARTIFACT.dayEdge = { before: sleeps(addDays(day, -1)), on: sleeps(day) };
    } finally {
      home.close();
    }
  });

  it("the connector's night ending just before the day's start never prints beside the WHOOP app's copy in Health ending just after it", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 3);
      const { start_ms } = dayBounds(day, SETTINGS);
      const night = start_ms - 5 * HOUR;
      const end = start_ms - MINUTE;
      home.land(WHOOP, start_ms + HOUR, [whoopObject("sleep", sleepId(89), {
        id: sleepId(89), cycle_id: 8989, user_id: 1, created_at: iso(end), updated_at: iso(end), start: iso(night), end: iso(end),
        timezone_offset: "-04:00", nap: false, score_state: "SCORED", score: { sleep_performance_percentage: 72 },
      }, night, end)]);
      const stages = [["AsleepCore", 120], ["AsleepDeep", 60], ["AsleepREM", 121]] as const;
      let at = night;
      home.land(APPLE, start_ms + 2 * HOUR, stages.map(([value, minutes]) => {
        const row = appleSample({ type: "HKCategoryTypeIdentifierSleepAnalysis", start_ms: at, end_ms: at + minutes * MINUTE,
          value: `HKCategoryValueSleepAnalysis${value}`, unit: "", from: "WHOOP", metadata: { "WHOOP Recovery": 52 } });
        at += minutes * MINUTE;
        return row;
      }));
      pass(home);
      const sleeps = (on: string) => render(home, on).txt.split("\n").filter((line) => line.startsWith("Sleep "));
      expect(extracts(home).find((row) => row.unit === `sleep/${WHOOP}/${sleepId(89)}`)!.days).toEqual([addDays(day, -2), addDays(day, -1), day]);
      expect(sleeps(addDays(day, -1))).toEqual(["Sleep 23:00–03:59, wake at 03:59: performance 72%"]);
      expect(sleeps(day)).toEqual([]);
      ARTIFACT.dayEdgeReversed = { before: sleeps(addDays(day, -1)), on: sleeps(day) };
    } finally {
      home.close();
    }
  });

  it("a Health workout prints nothing, or the WHOOP app's copy prints beside the connector's own workout, on its day or the one before, or a workout's line leaves out a fact its source states", () => {
    const home = newHome();
    try {
      const day = addDays(FIRST, 4);
      const { start_ms } = dayBounds(day, SETTINGS);
      const workout = (key: string, from: string, start: number, minutes: number,
        extra: { strain?: number; activity?: string; distance?: string; energy?: string; heart?: [string, string] } = {}): ReaderOutput => ({
        kind: "workout", key,
        content: {
          type: "health.workout", sample_type: "HKWorkoutTypeIdentifier", start: iso(start).replace(".000", ""), end: iso(start + minutes * MINUTE).replace(".000", ""),
          value: extra.activity ?? "HKWorkoutActivityTypeRunning", unit: "", source_name: from, source_version: "1",
          metadata: extra.strain === undefined ? {} : { "WHOOP Strain": extra.strain },
          detail: {
            duration_s: String(minutes * 60 - 30), distance: extra.distance ?? null, energy: extra.energy ?? null, events: [],
            statistics: extra.heart === undefined ? [] : [
              { type: "HKQuantityTypeIdentifierActiveEnergyBurned", start: iso(start), end: iso(start + minutes * MINUTE), sum: "210", average: null, minimum: null, maximum: null, unit: "kcal" },
              { type: "HKQuantityTypeIdentifierHeartRate", start: iso(start), end: iso(start + minutes * MINUTE), sum: null, average: extra.heart[0], minimum: "88", maximum: extra.heart[1], unit: "count/min" },
            ],
          },
        },
        time: { start_ms: start, end_ms: start + minutes * MINUTE, precision: "s" },
      });
      const run = start_ms + 6 * HOUR;
      const edge = start_ms - 20 * MINUTE;
      home.land(APPLE, start_ms + 12 * HOUR, [
        workout("w-run", "WHOOP", run, 45, { strain: 9.4, distance: "5012.3 m" }),
        workout("w-ride", "Apple Watch", run + 2 * HOUR, 30, { activity: "HKWorkoutActivityTypeHighIntensityIntervalTraining", energy: "210.4 kcal", heart: ["141.6", "171"] }),
        workout("w-edge", "WHOOP", edge, 30, { strain: 4.2, distance: "2.5 mi" }),
      ]);
      pass(home);
      const workouts = (on: string) => render(home, on).txt.split("\n").filter((line) => line.includes("workout —"));
      const runLine = "10:00–10:45 workout — running, duration 0:45, distance 5.01 km, strain 9.4 (WHOOP)";
      const rideLine = "12:00–12:30 workout — high intensity interval training, duration 0:30, average heart rate 142, max heart rate 171, energy 210 kcal (Apple Watch)";
      const edgeLine = "workout — running, duration 0:30, distance 2.5 mi, strain 4.2 (WHOOP)";
      expect(workouts(day)).toEqual([expect.stringContaining(edgeLine), runLine, rideLine]);
      expect(workouts(addDays(day, -1))).toEqual([expect.stringContaining(edgeLine)]);
      const ride = extracts(home).find((row) => row.unit === `workout/${APPLE}/w-ride`)!.content as JsonObject;
      expect(ride).toMatchObject({ activity: "high intensity interval training", energy: "210.4 kcal", average_heart_rate: 141.6, max_heart_rate: 171, distance: null });
      const whoopWorkout = (id: string, start: number, minutes: number, score: JsonObject, sport: JsonObject) => whoopObject("workout", id, {
        id, user_id: 1, created_at: iso(start), updated_at: iso(start), start: iso(start), end: iso(start + minutes * MINUTE), timezone_offset: "-04:00",
        ...sport, score_state: "SCORED", score,
      }, start, start + minutes * MINUTE);
      home.land(WHOOP, start_ms + 13 * HOUR, [
        whoopWorkout("00000000-0000-4000-9000-0000000000a1", run + 5 * MINUTE, 35, {
          strain: 9.5, average_heart_rate: 152, max_heart_rate: 198, kilojoule: 1569.34, percent_recorded: 100, distance_meter: 5012.3,
          altitude_gain_meter: 46.6, zone_durations: { zone_five_milli: 300_000 },
        }, { sport_name: "running", sport_id: 0 }),
        whoopWorkout("00000000-0000-4000-9000-0000000000a2", start_ms, 10, { strain: 4.3 }, { sport_id: 0 }),
      ]);
      pass(home);
      expect(extracts(home).find((row) => row.unit === `workout/${WHOOP}/00000000-0000-4000-9000-0000000000a2`)!.days).toEqual([addDays(day, -1), day, addDays(day, 1)]);
      expect(workouts(day)).toEqual([
        "04:00–04:10 workout — running, duration 0:10, strain 4.3",
        "10:05–10:40 workout — running, duration 0:35, distance 5.01 km, average heart rate 152, max heart rate 198, energy 375 kcal, strain 9.5",
        rideLine,
      ]);
      expect(extracts(home).find((row) => row.unit === `workout/${WHOOP}/00000000-0000-4000-9000-0000000000a1`)!.content).toMatchObject({
        sport: "running", strain: 9.5, average_heart_rate: 152, max_heart_rate: 198, kilojoule: 1569.34, distance_m: 5012.3,
      });
      expect(workouts(addDays(day, -1))).toEqual([]);
      ARTIFACT.healthWorkouts = { day: workouts(day), before: workouts(addDays(day, -1)) };
    } finally {
      home.close();
    }
  });

  it("a workout whose adapter leaves out its heart rate, energy or distance lands no extract, or one that states them", () => {
    const adapter: HealthAdapter = {
      version: "1", kinds: ["workout"],
      item: (record) => ((record.version.content as { id: string }).id === "w-copy"
        ? { item: "instrument-workout", instrument: "Example", activity: "running", duration_s: 1_800, distance: "5000 m", strain: null }
        : { item: "workout", sport: "cycling", strain: 7.1 }),
    };
    const family = healthFamily([{ product: "example", name: "Example", vendor: "example", type: null, adapter }]);
    const source = "example:person-a@example.com:export";
    const home = newHome();
    try {
      const day = addDays(FIRST, 4);
      const at = dayBounds(day, SETTINGS).start_ms + 6 * HOUR;
      const row = (key: string, start: number): ReaderOutput => ({ kind: "workout", key, content: { id: key }, time: { start_ms: start, end_ms: start + 30 * MINUTE, precision: "s" } });
      home.land(source, at + 4 * HOUR, [row("w-copy", at), row("w-own", at + HOUR)]);
      home.extractPass(family, SETTINGS);
      const contents = home.read((view) => [...view.extracts("health")]).map((extract) => extract.content as JsonObject);
      expect(contents.map((content) => content.kind).sort()).toEqual(["health-workout", "workout"]);
      for (const content of contents) for (const field of ["average_heart_rate", "max_heart_rate", "energy", "kilojoule", "distance_m"]) expect(content).not.toHaveProperty(field);
      const lines = home.read((view) => conforming(renderDay(day, [family], dayReader(view), SETTINGS, tableUnits(LABELS)))).txt.split("\n").filter((line) => line.includes("workout —"));
      expect(lines).toEqual([
        "10:00–10:30 workout — running, duration 0:30, distance 5.00 km (Example)",
        "11:00–11:30 workout — cycling, duration 0:30, strain 7.1",
      ]);
    } finally {
      home.close();
    }
  });

  it("a rendered day drifts from its golden", () => {
    const { home } = get17();
    for (const day of [addDays(FIRST, 4), addDays(FIRST, 5), addDays(FIRST, 12)]) {
      const rendered = render(home, day);
      for (const [suffix, text] of [["day.txt", rendered.txt], ["day.json", rendered.json]] as const) {
        const golden = new URL(`${day}.${suffix}`, GOLDEN);
        if (UPDATE) writeFileSync(golden, text);
        expect(text, `${day}.${suffix}`).toBe(readFileSync(golden, "utf8"));
      }
    }
    pin(health, { health: FED.health }, extracts(home));
  });
});

function range(values: readonly number[]): string {
  const one = (value: number) => (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/u, "");
  const [min, max] = [Math.min(...values), Math.max(...values)];
  return min === max ? one(min) : `${one(min)}–${one(max)} avg ${one(values.reduce((sum, value) => sum + value, 0) / values.length)}`;
}

function onDay(lines: readonly DayLine[], day: string): DayLine[] {
  const { start_ms, end_ms } = dayBounds(day, SETTINGS);
  const date = Date.parse(`${day}T00:00:00Z`);
  return lines.filter((line) => line.heading === true ? true
    : line.date_only === true ? line.start_ms === date
    : line.start_ms !== null && (line.end_ms === null ? line.start_ms >= start_ms && line.start_ms < end_ms
      : line.start_ms < end_ms && line.end_ms > start_ms));
}

function shuffle<T>(items: readonly T[], seed: number): T[] {
  const random = mulberry32(seed);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

