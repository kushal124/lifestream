import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { canonical, dayBounds, digest, type DaySettings, type ExtractRow, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { renderDay, type DayDocument, type RenderedDay, tableUnits } from "../days.js";
import type { Change, DayLine, Family } from "../family.js";
import { buildLabels, readLabels, resolvedPlace, type DayLabels } from "../shared/labels.js";
import { askOrder, distanceMeters, placeTable, spots, type Place, type Point, type Spot } from "../shared/places.js";
import { dayReader, shuffled, TestHome, type Pass } from "../test/drive.js";
import type { StayContent, TripContent } from "./family.js";
import { physicalFamily } from "./family.js";
import { FED, NETWORKED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { conforming } from "../test/units.js";

const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const UNIT = "iphone-0001";
const LOCATION = `location:local:${UNIT}`;
const MOTION = `motion:local:${UNIT}`;
const CHECKIN = `checkin:local:${UNIT}`;
const HOME_UNIT = "macbook-pro-0001";
const OWNER_PLACES = `places:local:${HOME_UNIT}`;
const ownerPlace = (id: string, name: string, centre: Point, radius_m = 120): ReaderOutput =>
  ({ kind: "place", key: id, content: { type: "places.place", name, centre: { latitude: centre.latitude, longitude: centre.longitude }, radius_m, ids: [] } });
const TIMELINE = "google-timeline:person-a@example.com:export";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const PROCESS = "22222222-2222-4222-8222-222222222222";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAYS = ["2026-09-21", "2026-09-22", "2026-09-23"];
const HOME: Point = { latitude: 0, longitude: 0 };
const OFFICE: Point = { latitude: 0, longitude: 0.0135 };
const GYM: Point = { latitude: 0.009, longitude: 0.0135 };
const owned = (list: { slug: string; name: string; centre: Point; radius_m: number; ids?: string[] }[]): Place[] =>
  list.map(({ centre, ids, ...place }) => ({ ...place, latitude: centre.latitude, longitude: centre.longitude, ids: ids ?? [], also: [] }));
const seed = (names: Record<string, string>) => owned([
  { slug: "home", name: names.home!, centre: { latitude: 0, longitude: 0 }, radius_m: 120 },
  { slug: "office", name: names.office!, centre: { latitude: 0, longitude: 0.0135 }, radius_m: 120 },
]);
const PLACES = seed({ home: "Home", office: "Office" });
const LABELS: DayLabels = buildLabels({ people: [], contacts: [], places: PLACES });
const physical = physicalFamily({ photos: FED.photos })(FED.physical);
const FAMILY = physical;
const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), "lifestream-physical-"));
const ARTIFACT: Record<string, Json> = {};

afterAll(() => {
  writeFileSync(join(ARTIFACT_DIR, "physical.json"), `${JSON.stringify(ARTIFACT, null, 1)}\n`);
  if (!KEEP) rmSync(ARTIFACT_DIR, { recursive: true, force: true });
});


const newHome = () => new TestHome("lifestream-physical-home-");
const pass = (home: TestHome, settings: DaySettings = SETTINGS, family = FAMILY): Pass => home.extractPass(family, settings);
const extracts = (home: TestHome): ExtractRow[] => home.read((view) => [...view.extracts("physical")]);
const render = (home: TestHome, day: string, labels: DayLabels = LABELS, family = FAMILY): RenderedDay =>
  home.read((view) => conforming(renderDay(day, [family], dayReader(view), SETTINGS, tableUnits(labels))));
const summary = (home: TestHome) => extracts(home).map(({ unit, reading, days }) => ({ unit, reading, days }));


interface Delivery { source: string; stated_ms: number; rows: ReaderOutput[] }

const iso = (ms: number) => new Date(ms).toISOString();

function entry(domain: string, kind: string, sequence: number, at: number, payload: JsonObject, extra: JsonObject = {}): JsonObject {
  return { schema_version: 1, domain, kind, sequence, ...extra,
    captured: { wall_rfc3339: iso(at + 1_500), wall_unix_seconds: (at + 1_500) / 1_000, elapsed_seconds: sequence * 7.5 },
    process_instance_id: PROCESS, payload };
}

function fixRow(sequence: number, at: number, point: Point, speed: number, accuracy = 5, altitude = 12): ReaderOutput {
  return {
    kind: "fix", key: `${INSTALL}:${sequence}`, time: { start_ms: at + 1_500, precision: "ms" },
    content: { type: "location.fix", content: entry("location", "fix", sequence, at, {
      location: { timestamp_rfc3339_utc: iso(at), timestamp_unix_seconds: at / 1_000, latitude: point.latitude, longitude: point.longitude,
        horizontal_accuracy: accuracy, vertical_accuracy: 3, altitude, speed, course: 90 },
      capture_context: { engine: "app_owned", authorization: "always" },
    }) },
  };
}

type Activity = "stationary" | "walking" | "automotive" | "cycling";

function motionRow(sequence: number, at: number, activity: Activity): ReaderOutput {
  return {
    kind: "motion", key: `${INSTALL}:${sequence}`, time: { start_ms: at + 1_500, precision: "ms" },
    content: { type: "motion.activity", content: entry("motion", "activity", sequence, at, {
      start_date_rfc3339: iso(at), start_date_unix_seconds: at / 1_000, stationary: activity === "stationary", walking: activity === "walking",
      running: false, automotive: activity === "automotive", cycling: activity === "cycling", unknown: false, confidence: "high", confidence_raw: 2, delivery: "live_update",
    }) },
  };
}

function gapRow(sequence: number, start: number, end: number): ReaderOutput {
  return {
    kind: "gap", key: `${INSTALL}:${sequence}`, time: { start_ms: start, end_ms: end, precision: "ms" },
    content: { type: "location.gap", content: entry("location", "gap", sequence, end, { start: iso(start), end: iso(end), reason: "unknown_process_absence" }) },
  };
}

function phoneDay(day: string, first: number, random: () => number): { location: ReaderOutput[]; motion: ReaderOutput[] } {
  const base = dayBounds(day, SETTINGS).start_ms;
  const at = (hours: number) => base + Math.round(hours * HOUR);
  let sequence = first;
  const location: ReaderOutput[] = [];
  const motion: ReaderOutput[] = [];
  const jitter = (point: Point): Point => ({ latitude: point.latitude + (random() - 0.5) * 0.0002, longitude: point.longitude + (random() - 0.5) * 0.0002 });
  const stay = (place: Point, from: number, to: number, every: number) => {
    for (let ms = at(from); ms < at(to); ms += every) location.push(fixRow(++sequence, ms, jitter(place), 0));
  };
  const move = (from: Point, to: Point, start: number, end: number, every: number, speed: number) => {
    const steps = Math.round((at(end) - at(start)) / every);
    for (let step = 0; step < steps; step++) {
      const share = step / steps;
      location.push(fixRow(++sequence, at(start) + step * every,
        { latitude: from.latitude + (to.latitude - from.latitude) * share, longitude: from.longitude + (to.longitude - from.longitude) * share }, speed));
    }
  };
  const activity = (hours: number, kind: Activity) => motion.push(motionRow(++sequence, at(hours), kind));
  activity(0, "stationary");
  stay(HOME, 0, 4, 150_000);
  activity(4, "automotive");
  move(HOME, OFFICE, 4, 4 + 10 / 60, 20_000, 9);
  activity(4 + 10 / 60, "stationary");
  stay(OFFICE, 4 + 10 / 60, 8.5, 2 * MINUTE);
  activity(6, "walking");
  activity(6.25, "stationary");
  activity(8.5, "walking");
  move(OFFICE, GYM, 8.5, 8.75, 30_000, 1.1);
  activity(8.75, "stationary");
  stay(GYM, 8.75, 9.75, 2 * MINUTE);
  activity(9.75, "walking");
  move(GYM, OFFICE, 9.75, 10, 30_000, 1.1);
  activity(10, "stationary");
  stay(OFFICE, 10, 11, 2 * MINUTE);
  stay(OFFICE, 11.75, 14, 2 * MINUTE);
  activity(14, "automotive");
  move(OFFICE, HOME, 14, 14 + 10 / 60, 20_000, 9);
  activity(14 + 10 / 60, "stationary");
  stay(HOME, 14 + 10 / 60, 24, 150_000);
  return { location, motion };
}

function offset(point: Point, east: number, north = 0): Point {
  return { latitude: point.latitude + north / 111_195, longitude: point.longitude + east / (111_195 * Math.cos(point.latitude * Math.PI / 180)) };
}

function strayNight(day: string, first: number, random: () => number): { location: ReaderOutput[]; motion: ReaderOutput[] } {
  const base = dayBounds(day, SETTINGS).start_ms;
  const at = (hours: number) => base + Math.round(hours * HOUR);
  let sequence = first;
  const location: ReaderOutput[] = [];
  const fix = (ms: number, point: Point, speed = 0, accuracy = 5) => location.push(fixRow(++sequence, ms, point, speed, accuracy));
  const jitter = (point: Point): Point => ({ latitude: point.latitude + (random() - 0.5) * 0.0001, longitude: point.longitude + (random() - 0.5) * 0.0001 });
  for (let ms = at(0); ms < at(6); ms += 30_000) fix(ms, jitter(HOME));
  [60, 120, 180, 230, 150, 80].forEach((east, index) => fix(at(1) + 1_000 + index * 3_000, offset(HOME, east), 8, 90));
  [100, 170, 200, 90].forEach((north, index) => fix(at(2) + 1_000 + index * 2_000, offset(HOME, 0, north), 7, 70));
  fix(at(3) + 5_000, offset(HOME, 140, 140), -1, 50);
  fix(at(3) + 5_000, offset(HOME, 20), -1, 50);
  fix(at(4) + 2_000, jitter(HOME));
  fix(at(4) + 7_000, offset(HOME, 600), -1, 65);
  fix(at(4) + 12_000, jitter(HOME));
  fix(at(5) + 5_000, HOME, 0, 20);
  fix(at(5) + 10_000, offset(HOME, 245), -1, 37);
  fix(at(5) + 20_000, offset(HOME, 0, 178), -1, 35);
  fix(at(5) + 25_000, HOME, 0, 20);
  const steps = 30;
  for (let step = 0; step < steps; step++) {
    const share = step / steps;
    const ms = at(6) + step * 20_000;
    fix(ms, { latitude: HOME.latitude + (OFFICE.latitude - HOME.latitude) * share, longitude: HOME.longitude + (OFFICE.longitude - HOME.longitude) * share },
      ms >= at(6) + 3 * MINUTE && ms < at(6) + 6 * MINUTE ? 75 : 9);
  }
  for (let ms = at(6) + 10 * MINUTE; ms < at(9); ms += 2 * MINUTE) fix(ms, jitter(OFFICE));
  const motion = [motionRow(++sequence, at(0), "stationary"), motionRow(++sequence, at(6), "automotive"), motionRow(++sequence, at(6) + 10 * MINUTE, "stationary")];
  return { location, motion };
}

function flight(day: string, first: number): { location: ReaderOutput[]; motion: ReaderOutput[] } {
  const base = dayBounds(day, SETTINGS).start_ms;
  const far = offset(OFFICE, 550_000);
  let sequence = first;
  const location: ReaderOutput[] = [];
  for (let ms = base + 10 * HOUR; ms < base + 11 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, OFFICE, 0));
  for (let step = 0; step <= 60; step++) {
    const share = step / 60;
    location.push(fixRow(++sequence, base + 11 * HOUR + step * MINUTE, { latitude: OFFICE.latitude, longitude: OFFICE.longitude + (far.longitude - OFFICE.longitude) * share }, 150, 10, 10_000));
  }
  for (let ms = base + 12 * HOUR + 2 * MINUTE; ms < base + 14 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, far, 0));
  return { location, motion: [] };
}

function checkins(day: string): ReaderOutput[] {
  const base = dayBounds(day, SETTINGS).start_ms;
  const report = base + 5 * HOUR;
  const test = base + 5.5 * HOUR;
  const trials = Array.from({ length: 30 }, (_, index) => ({ n: index + 1, isi_ms: 2000 + index * 100, stimulus_ms: index * 5000, response_ms: index * 5000 + 300,
    rt_ms: index === 3 ? 640 : 250 + (index % 7) * 10, class: index === 9 ? "false_start" : "response" }));
  return [
    { kind: "report", key: `${INSTALL}:9001`, time: { start_ms: report, precision: "ms" },
      content: { type: "checkin.report", content: entry("checkin", "report", 9001, report, {
        form: "moment", form_version: 1, prompt_id: null, trigger: "random", opened_at: iso(report - 9_000), answered_at: iso(report),
        local_zone: "America/New_York", response_ms: 9000, changes: 1, awake_for_s: 3600, wake_source: "default", block_id: null,
        items: [
          { id: "alertness", question: "How alert do you feel?", scale: 7, anchors: ["very sleepy", "very alert"], value: 5 },
          { id: "activity", question: "What are you doing?", scale: 0, anchors: [], value: "synthetic task" },
        ],
        note: null,
      }, { observed_at: iso(report) }) } },
    { kind: "vigilance", key: `${INSTALL}:9002`, time: { start_ms: test, precision: "ms" },
      content: { type: "checkin.vigilance", content: entry("checkin", "vigilance", 9002, test, {
        protocol: "pvt-b-3min-v1", duration_ms: 180000, isi_ms: [2000, 10000], lapse_threshold_ms: 500, false_start_under_ms: 100, timeout_ms: 30000,
        prompt_id: null, trigger: "manual", started_at: iso(test), ended_at: iso(test + 180_000), completed: true, session_number: 1,
        awake_for_s: 5400, wake_source: "default", device: { model: "iPhone0,0", os: "0.0", refresh_hz: 120, low_power: false }, trials, interruptions: [],
      }, { observed_at: iso(test) }) } },
  ];
}

function timeline(): ReaderOutput[] {
  const visit = (start: string, end: string, geo: string, level = "0"): ReaderOutput => ({
    kind: "place-visit", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
    content: { type: "timeline.visit", content: { startTime: start, endTime: end,
      visit: { hierarchyLevel: level, probability: "0.8", topCandidate: { placeID: "synthetic-place-a", placeLocation: geo, probability: "0.91", semanticType: "UNKNOWN" } } } },
  });
  const trip = (start: string, end: string, type: string, distance: string): ReaderOutput => ({
    kind: "trip", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
    content: { type: "timeline.trip", content: { startTime: start, endTime: end,
      activity: { start: "geo:0.000000,0.000000", end: "geo:0.000000,0.013500", distanceMeters: distance, probability: "0.7", topCandidate: { type, probability: "0.8" } } } },
  });
  return [
    visit("2026-09-19T00:00:00.000-04:00", "2026-09-19T09:00:00.000-04:00", "geo:0.000010,0.000020"),
    trip("2026-09-19T09:00:00.000-04:00", "2026-09-19T09:20:00.000-04:00", "walking", "1500.00"),
    visit("2026-09-19T09:20:00.000-04:00", "2026-09-19T17:00:00.000-04:00", "geo:0.000010,0.013480"),
    visit("2026-09-19T10:00:00.000-04:00", "2026-09-19T11:00:00.000-04:00", "geo:0.000010,0.013480", "1"),
    trip("2026-09-19T17:00:00.000-04:00", "2026-09-19T21:30:00.000-04:00", "in passenger vehicle", "1500.00"),
    visit("2026-09-21T08:30:00.000-04:00", "2026-09-21T12:00:00.000-04:00", "geo:0.000010,0.013480"),
  ];
}

function bundles(days: readonly { location: ReaderOutput[]; motion: ReaderOutput[] }[], every = 4 * HOUR): Delivery[] {
  const out: Delivery[] = [];
  for (const [source, rows] of [[LOCATION, days.flatMap((day) => day.location)], [MOTION, days.flatMap((day) => day.motion)]] as const) {
    const byWindow = new Map<number, ReaderOutput[]>();
    for (const row of rows) {
      const window = Math.ceil(row.time!.start_ms / every) * every;
      byWindow.set(window, [...(byWindow.get(window) ?? []), row]);
    }
    for (const [window, list] of [...byWindow].sort(([left], [right]) => left - right)) out.push({ source, stated_ms: window + 5 * MINUTE, rows: list });
  }
  return out.sort((left, right) => left.stated_ms - right.stated_ms || left.source.localeCompare(right.source));
}

function dataset(): Delivery[] {
  const random = mulberry32(5);
  const days = DAYS.map((day, index) => phoneDay(day, index * 10_000, random));
  const base = dayBounds(DAYS[1]!, SETTINGS).start_ms;
  days[1]!.location.push(gapRow(19_999, base + 14 * HOUR + MINUTE, base + 14 * HOUR + 9 * MINUTE));
  days[1]!.location = days[1]!.location.filter((row) => row.kind !== "fix" ||
    !(row.time!.start_ms > base + 14 * HOUR + MINUTE && row.time!.start_ms < base + 14 * HOUR + 9 * MINUTE));
  return [
    { source: TIMELINE, stated_ms: Date.parse("2026-09-20T12:00:00Z"), rows: timeline() },
    ...bundles(days),
    { source: CHECKIN, stated_ms: dayBounds(DAYS[0]!, SETTINGS).end_ms, rows: checkins(DAYS[0]!) },
  ];
}

function landAll(home: TestHome, deliveries: readonly Delivery[], each = false, family = FAMILY): Pass[] {
  const out: Pass[] = [];
  for (const delivery of deliveries) {
    home.land(delivery.source, delivery.stated_ms, delivery.rows);
    if (each) out.push(pass(home, SETTINGS, family));
  }
  if (!each) out.push(pass(home, SETTINGS, family));
  return out;
}

function ticked(row: ReaderOutput): ReaderOutput {
  const content = structuredClone(row.content) as JsonObject;
  const inner = content.content as JsonObject;
  if (content.type === "timeline.visit" || content.type === "timeline.trip") {
    const segment = inner;
    const member = (segment.visit ?? segment.activity) as JsonObject;
    member.probability = "0.55";
    (member.topCandidate as JsonObject).probability = "0.42";
    return { ...row, content };
  }
  Object.assign(inner, { process_instance_id: "44444444-4444-4444-8444-444444444444",
    capture_replay_key: "replay-1" });
  Object.assign(inner.captured as JsonObject, { elapsed_seconds: 99.5, wall_unix_seconds: (inner.captured as JsonObject).wall_unix_seconds as number + 0.001 });
  const payload = inner.payload as JsonObject;
  if (content.type === "location.fix") {
    const location = payload.location as JsonObject;
    Object.assign(location, { vertical_accuracy: 7, course: 180, timestamp_unix_seconds: location.timestamp_unix_seconds as number + 0.0001 });
    (payload.capture_context as JsonObject).authorization = "when_in_use";
  } else if (content.type === "motion.activity") {
    Object.assign(payload, { confidence: "medium", confidence_raw: 1, start_date_unix_seconds: payload.start_date_unix_seconds as number + 0.0001 });
  } else if (content.type === "checkin.report") {
    Object.assign(payload, { opened_at: iso(Date.parse(payload.opened_at as string) - 1_000), response_ms: 9_500, changes: 2, prompt_id: null });
    for (const item of payload.items as JsonObject[]) Object.assign(item, { question: `${item.question as string} (reworded)` });
  } else if (content.type === "checkin.vigilance") {
    Object.assign(payload, { device: { model: "iPhone0,1", os: "0.1", refresh_hz: 60, low_power: true }, interruptions: [{ at_ms: 1, reason: "background" }] });
    for (const trial of payload.trials as JsonObject[]) trial.isi_ms = (trial.isi_ms as number) + 1;
  }
  return { ...row, content };
}

function overlaps(rows: readonly ExtractRow[]): string[] {
  const phone = rows.filter((row) => row.unit.includes(`/${LOCATION}/`)).sort((left, right) => left.start_ms! - right.start_ms!);
  return phone.slice(1).flatMap((row, index) => row.start_ms! < phone[index]!.end_ms! ? [`${phone[index]!.unit} × ${row.unit}`] : []);
}

function chunkedRun(home: TestHome, split: (changes: Change[]) => Change[][]): { readings: Map<string, string>; read: Record<string, number> } {
  const read: Record<string, number> = {};
  return home.read((open) => {
    const view = new Proxy(open, { get(target, name) {
      const member = Reflect.get(target, name, target) as unknown;
      if (name !== "records" || typeof member !== "function") return typeof member === "function" ? (member as (...args: unknown[]) => unknown).bind(target) : member;
      return function* (...args: unknown[]) {
        read[args[1] as string] ??= 0;
        for (const row of (member as (...args: unknown[]) => Iterable<unknown>).apply(target, args)) {
          read[args[1] as string] = (read[args[1] as string] ?? 0) + 1;
          yield row;
        }
      };
    } });
    const cursor = open.tables.cursors.get("extract:physical")?.seq ?? 0;
    const changes: Change[] = [];
    for (const statement of open.statements(cursor, { sources: [LOCATION, MOTION], kinds: ["fix", "gap", "motion"] })) {
      const previous = open.history(statement).filter((row) => row.seq < statement.seq).at(-1);
      const version = (id: string | undefined) => id === undefined || id === "gone" ? undefined : open.version(id);
      const before = version(previous?.version);
      const after = version(statement.version);
      changes.push({ record: { source: statement.source, kind: statement.kind, key: statement.key }, ...(before ? { before } : {}), ...(after ? { after } : {}) });
    }
    const units = new Set<string>();
    for (const group of split(changes)) {
      for (const touched of FAMILY.touched(group, view)) {
        units.add(touched.unit);
        if (touched.previous !== undefined) units.add(touched.previous);
      }
    }
    const readings = new Map([...open.extracts("physical")].filter((row) => row.unit.includes(`/${LOCATION}/`)).map((row) => [row.unit, row.reading]));
    for (const unit of units) {
      const built = FAMILY.extract(unit, view, home.blobs);
      if (built === null) readings.delete(unit);
      else readings.set(unit, built.reading);
    }
    return { readings, read };
  });
}

function walkingDays(days: number, first: number, random: () => number): { location: ReaderOutput[]; motion: ReaderOutput[] } {
  const location: ReaderOutput[] = [];
  const motion: ReaderOutput[] = [];
  let sequence = first;
  const jitter = (point: Point): Point => ({ latitude: point.latitude + (random() - 0.5) * 0.0002, longitude: point.longitude + (random() - 0.5) * 0.0002 });
  const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
  for (let day = 0; day < days; day++) {
    const at = (hours: number) => base + day * 24 * HOUR + Math.round(hours * HOUR);
    const stay = (place: Point, from: number, to: number) => {
      for (let ms = at(from); ms < at(to); ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, jitter(place), 0));
    };
    const walk = (from: Point, to: Point, start: number, end: number) => {
      const steps = Math.round((at(end) - at(start)) / 30_000);
      for (let step = 0; step < steps; step++) {
        const share = step / steps;
        location.push(fixRow(++sequence, at(start) + step * 30_000,
          { latitude: from.latitude + (to.latitude - from.latitude) * share, longitude: from.longitude + (to.longitude - from.longitude) * share }, 1.3));
      }
    };
    motion.push(motionRow(++sequence, at(0), "stationary"));
    stay(HOME, 0, 4);
    motion.push(motionRow(++sequence, at(4), "walking"));
    walk(HOME, OFFICE, 4, 4 + 20 / 60);
    motion.push(motionRow(++sequence, at(4 + 20 / 60), "stationary"));
    stay(OFFICE, 4 + 20 / 60, 6);
    motion.push(motionRow(++sequence, at(6), "walking"));
    walk(OFFICE, GYM, 6, 6.2);
    motion.push(motionRow(++sequence, at(6.2), "stationary"));
    stay(GYM, 6.2, 7);
    motion.push(motionRow(++sequence, at(7), "walking"));
    walk(GYM, OFFICE, 7, 7.2);
    motion.push(motionRow(++sequence, at(7.2), "stationary"));
    stay(OFFICE, 7.2, 10);
    motion.push(motionRow(++sequence, at(10), "walking"));
    walk(OFFICE, HOME, 10, 10 + 20 / 60);
    motion.push(motionRow(++sequence, at(10 + 20 / 60), "stationary"));
    stay(HOME, 10 + 20 / 60, 24);
  }
  return { location, motion };
}


describe("physical family, end to end through core", () => {
  it("an extract is written when only an unread field ticked (every measured ticking path flipped)", () => {
    const home = newHome();
    try {
      const deliveries = dataset().slice(0, 9);
      landAll(home, [...deliveries, { source: CHECKIN, stated_ms: dayBounds(DAYS[0]!, SETTINGS).end_ms, rows: checkins(DAYS[0]!) }]);
      const before = extracts(home);
      expect(before.length).toBeGreaterThan(8);
      let changed = 0;
      const changedPaths: Record<string, number> = {};
      for (const delivery of [...deliveries, { source: CHECKIN, stated_ms: dayBounds(DAYS[0]!, SETTINGS).end_ms, rows: checkins(DAYS[0]!) }]) {
        const landed = home.land(delivery.source, delivery.stated_ms + 24 * HOUR, delivery.rows.map(ticked));
        changed += landed.changed;
        for (const [path, count] of Object.entries(landed.changedPaths)) changedPaths[path] = (changedPaths[path] ?? 0) + count;
      }
      const ticks = pass(home);
      expect(changed).toBeGreaterThan(400);
      for (const path of ["content.captured.elapsed_seconds", "content.payload.location.vertical_accuracy", "content.payload.confidence",
        "content.visit.topCandidate.probability", "content.payload.items[].question", "content.payload.trials[].isi_ms", "content.process_instance_id"]) {
        expect(changedPaths[path], path).toBeGreaterThan(0);
      }
      expect(ticks.touched.length).toBeGreaterThan(8);
      expect(ticks.written).toEqual([]);
      expect(ticks.deleted).toEqual([]);
      expect(extracts(home)).toEqual(before);
      ARTIFACT.ticks = { changed, changedPaths, touched: ticks.touched.length, written: ticks.written };
    } finally {
      home.close();
    }
  });

  it("units differ when the same data arrives in another order", () => {
    const deliveries = dataset();
    const once = newHome();
    try {
      landAll(once, deliveries);
      const expected = summary(once);
      expect(overlaps(extracts(once))).toEqual([]);
      for (const [name, order] of Object.entries({ arrival: deliveries, reversed: [...deliveries].reverse(), shuffled: shuffle(deliveries, 9) })) {
        const home = newHome();
        try {
          landAll(home, order, true);
          expect(summary(home), name).toEqual(expected);
          for (const day of DAYS) expect(render(home, day).txt, `${name} ${day}`).toBe(render(once, day).txt);
        } finally {
          home.close();
        }
      }
      ARTIFACT.order = { units: expected.map(({ unit }) => unit), readings: digest(expected as unknown as Json) };
    } finally {
      once.close();
    }
  });

  it("a late fix splitting a stay leaves an orphan unit", () => {
    const full = phoneDay(DAYS[0]!, 0, mulberry32(13));
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const excursion = (row: ReaderOutput) => row.time!.start_ms >= base + 8.5 * HOUR && row.time!.start_ms < base + 10 * HOUR;
    const day = { location: full.location.filter((row) => !excursion(row)), motion: full.motion.filter((row) => !excursion(row)) };
    const late = full.location.filter(excursion);
    const lateMotion = full.motion.filter(excursion);
    const home = newHome();
    const reference = newHome();
    try {
      landAll(home, bundles([day]), true);
      const office = extracts(home).filter((row) => row.unit.startsWith(`stay/${LOCATION}/`)).find((row) => (row.content as JsonObject).silences !== undefined &&
        row.end_ms! - row.start_ms! > 9 * HOUR)!;
      expect(office).toBeDefined();
      home.land(MOTION, Date.parse(`${DAYS[1]}T12:00:00Z`), lateMotion);
      home.land(LOCATION, Date.parse(`${DAYS[1]}T12:00:00Z`), late);
      const split = pass(home);
      landAll(reference, [...bundles([full]), { source: MOTION, stated_ms: Date.parse(`${DAYS[1]}T12:00:00Z`), rows: lateMotion },
        { source: LOCATION, stated_ms: Date.parse(`${DAYS[1]}T12:00:00Z`), rows: late }]);
      expect(summary(home)).toEqual(summary(reference));
      expect(overlaps(extracts(home))).toEqual([]);
      const kept = extracts(home).find((row) => row.unit === office.unit)!;
      expect(kept.end_ms! - kept.start_ms!).toBeLessThan(5 * HOUR);
      expect(split.written.filter((unit) => unit !== office.unit).length).toBeGreaterThanOrEqual(4);
      ARTIFACT.split = { office: office.unit, written: split.written, deleted: split.deleted };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("a late fix before a stay's first fix keeps the old unit instead of naming it previous", () => {
    const full = phoneDay(DAYS[0]!, 0, mulberry32(17));
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const arrival = (row: ReaderOutput) => row.time!.start_ms >= base + 14 * HOUR + 9 * MINUTE + 10_000 && row.time!.start_ms < base + 14.5 * HOUR;
    const day = { location: full.location.filter((row) => !arrival(row)), motion: full.motion };
    const late = full.location.filter(arrival);
    const home = newHome();
    const reference = newHome();
    try {
      landAll(home, bundles([day]), true);
      const evening = extracts(home).find((row) => row.unit.startsWith(`stay/${LOCATION}/`) && row.start_ms! >= base + 14.4 * HOUR)!;
      home.land(LOCATION, Date.parse(`${DAYS[1]}T12:00:00Z`), late);
      const touched = home.read((view) => {
        const statement = [...view.statements(0, { sources: [LOCATION] })].at(-1)!;
        const change: Change = { record: statement, after: view.version(statement.version) };
        return FAMILY.touched([change], view);
      });
      expect(touched.some((unit) => unit.previous === evening.unit)).toBe(true);
      const moved = pass(home);
      expect(moved.deleted).toContain(evening.unit);
      landAll(reference, [...bundles([day]), { source: LOCATION, stated_ms: Date.parse(`${DAYS[1]}T12:00:00Z`), rows: late }]);
      expect(summary(home)).toEqual(summary(reference));
      expect(overlaps(extracts(home))).toEqual([]);
      ARTIFACT.previous = { evening: evening.unit, touched: touched as unknown as Json, deleted: moved.deleted };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("a deleted-then-returned fix is counted twice or lost", () => {
    const deliveries = bundles([phoneDay(DAYS[0]!, 0, mulberry32(21))]);
    const fixes = deliveries.filter((delivery) => delivery.source === LOCATION).flatMap((delivery) => delivery.rows);
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const gone = fixes.find((row) => row.time!.start_ms > base + 8.6 * HOUR)!;
    const later = Date.parse(`${DAYS[1]}T12:00:00Z`);
    const home = newHome();
    const without = newHome();
    const reference = newHome();
    try {
      landAll(home, deliveries, true);
      landAll(reference, deliveries);
      const original = summary(reference);
      home.land(LOCATION, later, [{ kind: "fix", key: gone.key, content: null, gone: true }]);
      pass(home);
      landAll(without, deliveries.map((delivery) => ({ ...delivery, rows: delivery.rows.filter((row) => row.key !== gone.key || delivery.source !== LOCATION) })));
      expect(summary(home)).toEqual(summary(without));
      home.land(LOCATION, later + HOUR, [gone]);
      pass(home);
      expect(summary(home)).toEqual(original);
      expect(overlaps(extracts(home))).toEqual([]);
    } finally {
      home.close();
      without.close();
      reference.close();
    }
  });

  it("a deleted first or last fix leaves the stay it headed beside its replacement, or deleting every fix leaves a unit", () => {
    const deliveries = bundles([phoneDay(DAYS[0]!, 0, mulberry32(23))]);
    const fixes = deliveries.filter((delivery) => delivery.source === LOCATION).flatMap((delivery) => delivery.rows)
      .sort((left, right) => left.time!.start_ms - right.time!.start_ms);
    const later = Date.parse(`${DAYS[1]}T12:00:00Z`);
    for (const gone of [fixes[0]!, fixes.at(-1)!]) {
      const home = newHome();
      const without = newHome();
      try {
        landAll(home, deliveries, true);
        home.land(LOCATION, later, [{ kind: "fix", key: gone.key, content: null, gone: true }]);
        pass(home);
        landAll(without, deliveries.map((delivery) => ({ ...delivery, rows: delivery.rows.filter((row) => row.key !== gone.key || delivery.source !== LOCATION) })));
        expect(summary(home)).toEqual(summary(without));
        expect(overlaps(extracts(home))).toEqual([]);
      } finally {
        home.close();
        without.close();
      }
    }
    const home = newHome();
    try {
      const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
      const few = [fixRow(1, base, HOME, 0), fixRow(2, base + 3 * MINUTE, HOME, 0), fixRow(3, base + 6 * MINUTE, HOME, 0)];
      home.land(LOCATION, base + HOUR, few);
      pass(home);
      expect(extracts(home).map((row) => row.unit)).toEqual([`stay/${LOCATION}/${base}`]);
      home.land(LOCATION, later, few.map((row) => ({ kind: "fix", key: row.key, content: null, gone: true as const })));
      const emptied = pass(home);
      expect(emptied.deleted).toEqual([`stay/${LOCATION}/${base}`]);
      expect(extracts(home)).toEqual([]);
      ARTIFACT["deleted-edges"] = { emptied: emptied as unknown as Json };
    } finally {
      home.close();
    }
  });

  it("an extract stores a place name, or renderDay reads outside days()", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      const all = extracts(home);
      expect(JSON.stringify(all.map((row) => row.content))).not.toMatch(/Home|Office|Casa/u);
      for (const day of ["2026-09-19", ...DAYS]) {
        const strict = FAMILY.day({ day, settings: SETTINGS, extracts: all.filter((row) => row.days.includes(day)), enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines;
        const loose = FAMILY.day({ day, settings: SETTINGS, extracts: all, enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines;
        expect(onDay(loose, day), day).toEqual(onDay(strict, day));
      }
      const named = render(home, DAYS[0]!);
      expect(named.txt).toMatch(/At Home\n/u);
      expect(named.txt).toMatch(/Road vehicle, Home → Office/u);
      const renamed = render(home, DAYS[0]!, buildLabels({ people: [], contacts: [], places: seed({ home: "Casa", office: "Office" }) }));
      expect(renamed.inputs).not.toBe(named.inputs);
      expect(renamed.txt).toMatch(/At Casa\n/u);
      expect(pass(home).written).toEqual([]);
      ARTIFACT.places = { named: named.inputs, renamed: renamed.inputs };
    } finally {
      home.close();
    }
  });

  it("an owner place renamed or removed names a stay by its old word, or a phone's own saved place names one", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      home.land(OWNER_PLACES, Date.UTC(2026, 8, 24), [ownerPlace("home", "Casa", HOME), ownerPlace("gym", "Gym", GYM), ownerPlace("office", "Office", OFFICE)]);
      const read = () => home.read((view) => readLabels(view, HOME_UNIT, NETWORKED));
      expect(read().place(OFFICE.latitude, OFFICE.longitude)?.name).toBe("Office");
      home.land(OWNER_PLACES, Date.UTC(2026, 8, 25), [{ kind: "place", key: "office", content: null, gone: true }]);
      home.land(`places:local:${UNIT}`, Date.UTC(2026, 8, 26), [{ kind: "place", key: "office",
        content: { type: "places.place", slug: "office", name: "Phone Office", centre: { latitude: OFFICE.latitude, longitude: OFFICE.longitude }, radius_m: 120, retired: false } }]);
      const labels = read();
      expect(labels.place(HOME.latitude, HOME.longitude)?.name).toBe("Casa");
      expect(labels.place(GYM.latitude, GYM.longitude)?.name).toBe("Gym");
      expect(labels.place(OFFICE.latitude, OFFICE.longitude)).toBeUndefined();
      const rendered = render(home, DAYS[0]!, labels);
      expect(rendered.txt).toMatch(/At Casa\n/u);
      expect(rendered.txt).not.toMatch(/Office/u);
      ARTIFACT.owner_places = { home: labels.place(HOME.latitude, HOME.longitude)!.name, gym: labels.place(GYM.latitude, GYM.longitude)!.name };
    } finally {
      home.close();
    }
  });

  it("a point's served place differs from the place its day prints for the stay or the trip", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      const byUnit = new Map(extracts(home).map((row) => [row.unit, row.content as unknown as StayContent | TripContent]));
      const shown = (point: Point): string => {
        const [, , slug, name, words] = resolvedPlace(point, LABELS);
        expect(slug === null, `${point.latitude},${point.longitude}`).toBe(name === null);
        expect(name === null ? words.startsWith("an unnamed place ") : words === name).toBe(true);
        return words;
      };
      const checked: Json[] = [];
      for (const day of ["2026-09-19", ...DAYS]) {
        const atoms = (JSON.parse(render(home, day).json) as { atoms: { unit: string; units: string[]; text: string; block?: { title: string } }[] }).atoms;
        for (const atom of atoms) {
          const content = byUnit.get(atom.unit);
          if (content?.kind === "stay" && atom.text.startsWith("At ")) {
            expect(atom.text, atom.unit).toMatch(new RegExp(`^At ${escape(shown(content.centre))}(?: \\(|$)`, "u"));
            checked.push([day, "stay", resolvedPlace(content.centre, LABELS)]);
          } else if (content?.kind === "trip" && content.from !== null && content.to !== null) {
            expect(atom.block?.title ?? atom.text, atom.unit).toContain(`${shown(content.from)} → ${shown(content.to)}`);
            checked.push([day, "trip", resolvedPlace(content.from, LABELS), resolvedPlace(content.to, LABELS)]);
          }
        }
      }
      const kinds = new Set(checked.map((entry) => `${(entry as Json[])[1]}:${((entry as Json[])[2] as Json[])[3] === null ? "unnamed" : "named"}`));
      expect([...kinds].sort()).toEqual(["stay:named", "stay:unnamed", "trip:named", "trip:unnamed"]);
      expect(resolvedPlace(HOME, LABELS)).toEqual([0, 0, "home", "Home", "Home"]);
      ARTIFACT.points = checked;
    } finally {
      home.close();
    }
  });

  it("a Google Timeline visit prints beside the phone's own stay for the same hours", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      const phoneDayText = render(home, DAYS[0]!).txt;
      expect(phoneDayText).not.toMatch(/stated by Timeline/u);
      const timelineDay = render(home, "2026-09-19").txt;
      expect(timelineDay).toMatch(/04:00–09:00 At Home \(stated by Timeline\)/u);
      expect(timelineDay).toMatch(/09:00–09:20 Walking \(stated by Timeline\), Home → Office, 1\.5 km in 20 m\n/u);
      expect(timelineDay).not.toMatch(/Passenger vehicle/u);
      expect(timelineDay.match(/At Office \(stated by Timeline\)/gu)).toHaveLength(1);
    } finally {
      home.close();
    }
  });

  it("a witness's declared name, rank or how changed builds an extract whose content differs under the stored reading and code", () => {
    const home = newHome();
    try {
      home.land(TIMELINE, Date.parse("2026-09-20T12:00:00Z"), timeline());
      pass(home);
      const renamed = physicalFamily({ photos: FED.photos })(FED.physical.map((given) =>
        given.product === "google-timeline" ? { ...given, adapter: { ...given.adapter, name: "Maps history", rank: given.adapter.rank! + 1 } } : given));
      const stored = extracts(home);
      expect(stored.length).toBeGreaterThan(0);
      const unkeyed = home.read((view) => stored.flatMap((row) => {
        const built = renamed.extract(row.unit, view, home.blobs)!;
        const same = built.reading === row.reading && renamed.code === row.code;
        return same && canonical(built.content) !== canonical(row.content) ? [row.unit] : [];
      }));
      expect(unkeyed).toEqual([]);
      ARTIFACT.declared_stamp = { units: stored.length, code: [FAMILY.code, renamed.code] };
    } finally {
      home.close();
    }
  });

  it("a stay or trip a day leaves out is recorded as shown, or one it prints as hidden: the render's units are its own atoms", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      const start = "2026-09-21T02:00:00.000-04:00", end = "2026-09-21T05:00:00.000-04:00";
      home.land(TIMELINE, Date.parse("2026-09-24T12:00:00Z"), [{
        kind: "place-visit", key: "20260921T0200000400", time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
        content: { type: "timeline.visit", content: { startTime: start, endTime: end,
          visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: "synthetic-place-a", placeLocation: "geo:0.000010,0.000020", probability: "0.91", semanticType: "UNKNOWN" } } } },
      }]);
      pass(home);
      const all = extracts(home);
      const days = [...new Set(all.flatMap((row) => row.days))].sort();
      const rendered = new Map(days.map((day) => [day, render(home, day)]));
      const printed = new Map([...rendered].map(([day, files]) => [day, new Set((JSON.parse(files.json) as { atoms: { units: string[] }[] }).atoms.flatMap((atom) => atom.units))]));
      const recorded = new Map([...rendered].map(([day, files]) => [day, new Map(files.units.map((unit) => [unit.unit, unit]))]));
      const shownOn: Record<string, string[]> = {};
      for (const row of all) {
        for (const day of row.days) expect(recorded.get(day)!.get(row.unit), `${day} ${row.unit}`).toEqual({ family: "physical", unit: row.unit, reading: row.reading, code: row.code, shown: printed.get(day)!.has(row.unit) });
        shownOn[row.unit] = row.days.filter((day) => recorded.get(day)!.get(row.unit)!.shown);
      }
      for (const [day, units] of recorded) expect([...units.values()].filter((unit) => unit.family === "physical").map((unit) => unit.unit).sort(), day).toEqual(all.filter((row) => row.days.includes(day)).map((row) => row.unit).sort());
      const timeline = (key: string) => shownOn[`stay/${TIMELINE}/${key}`];
      expect(timeline("20260921T0830000400")).toEqual([]);
      expect(all.find((row) => row.unit === `stay/${TIMELINE}/20260921T0200000400`)?.days).toEqual(["2026-09-20", "2026-09-21"]);
      expect(timeline("20260921T0200000400")).toEqual(["2026-09-20"]);
      expect(all.filter((row) => row.unit.includes(`/${LOCATION}/`)).every((row) => shownOn[row.unit]!.length > 0)).toBe(true);
      ARTIFACT.shown_on = shownOn;
    } finally {
      home.close();
    }
  });

  it("a night at home with stray fixes or two good-accuracy outliers prints trips from home to home, a leg under the flight minimum prints as a flight, or a flight prints its median speed", () => {
    const night = strayNight(DAYS[0]!, 0, mulberry32(31));
    const plane = flight(DAYS[0]!, 50_000);
    const days = [{ location: [...night.location, ...plane.location], motion: night.motion }];
    const once = newHome();
    try {
      landAll(once, bundles(days));
      const txt = render(once, DAYS[0]!).txt;
      expect(txt).not.toMatch(/Home → Home/u);
      expect(txt.match(/ At Home/gu)).toHaveLength(1);
      expect(txt).toMatch(/04:00–10:00 At Home\n/u);
      expect(txt).toMatch(/10:00–10:09 Road vehicle, Home → Office, 1\.\d km\n/u);
      expect(txt.match(/Flight/gu)).toHaveLength(1);
      expect(txt).toMatch(/Flight, Office → an unnamed place 55\d km from Office, 5\d\d\.\d km\n/u);
      expect(txt).not.toMatch(/km\/h|median|stationary/u);
      expect(overlaps(extracts(once))).toEqual([]);
      for (const [name, order] of Object.entries({ halfHourly: bundles(days, HOUR / 2), reversed: bundles(days, HOUR / 2).reverse() })) {
        const home = newHome();
        try {
          landAll(home, order, true);
          expect(summary(home), name).toEqual(summary(once));
          expect(render(home, DAYS[0]!).txt.split("\nCoverage")[0], name).toBe(txt.split("\nCoverage")[0]);
        } finally {
          home.close();
        }
      }
      ARTIFACT.stray_night = txt;
    } finally {
      once.close();
    }
  });

  it("a jitter trip that crosses 04:00 prints on both days", () => {
    const base = dayBounds(DAYS[1]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(41);
    for (let ms = base - 6 * HOUR; ms < base + 4 * HOUR; ms += MINUTE) {
      const wandering = ms >= base - 3 * MINUTE && ms <= base + 3 * MINUTE;
      const east = wandering ? 100 + 50 * random() : 10 * random();
      location.push(fixRow(++sequence, ms, offset(HOME, east), wandering ? 6 : 0, wandering ? 80 : 5));
    }
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion: [motionRow(++sequence, base - 6 * HOUR, "stationary")] }]));
      const before = render(home, DAYS[0]!).txt;
      const after = render(home, DAYS[1]!).txt;
      for (const txt of [before, after]) expect(txt).not.toMatch(/→/u);
      expect(before).toMatch(/\n22:00–2026-09-22 04:00 At Home \(still there at the last fix\) \(continues into 22 Sep\)\n/u);
      expect(after).toMatch(/\n04:00–07:59 At Home \(still there at the last fix\) \(continues from 21 Sep\)\n/u);
      expect(extracts(home).filter((row) => row.unit.startsWith(`trip/${LOCATION}/`))).toEqual([]);
      ARTIFACT.jitter_at_four = { before, after };
    } finally {
      home.close();
    }
  });

  it("a 20-minute visit next door prints as home, or a stay 162 m from a 150 m place prints as at the place", () => {
    const places = owned([{ slug: "home", name: "Home", centre: { latitude: 0, longitude: 0 }, radius_m: 150 }]);
    const family = physical;
    const labels = buildLabels({ people: [], contacts: [], places });
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    const motion: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(43);
    const still = (point: Point, from: number, to: number) => {
      for (let ms = from; ms < to; ms += 30_000) location.push(fixRow(++sequence, ms, offset(point, 5 * random(), 5 * random()), 0));
    };
    const walk = (from: Point, to: Point, start: number) => {
      for (let step = 0; step <= 12; step++) location.push(fixRow(++sequence, start + step * 10_000, offset(from, (to.longitude - from.longitude) * 111_195 * step / 12, (to.latitude - from.latitude) * 111_195 * step / 12), 1.4));
    };
    const door = offset(HOME, 200);
    const near = offset(HOME, 0, 162);
    motion.push(motionRow(++sequence, base, "stationary"));
    still(HOME, base, base + 2 * HOUR);
    motion.push(motionRow(++sequence, base + 2 * HOUR, "walking"));
    walk(HOME, door, base + 2 * HOUR);
    motion.push(motionRow(++sequence, base + 2 * HOUR + 2 * MINUTE, "stationary"));
    still(door, base + 2 * HOUR + 2 * MINUTE + 30_000, base + 2 * HOUR + 22 * MINUTE);
    motion.push(motionRow(++sequence, base + 2 * HOUR + 22 * MINUTE, "walking"));
    walk(door, HOME, base + 2 * HOUR + 22 * MINUTE);
    motion.push(motionRow(++sequence, base + 2 * HOUR + 24 * MINUTE, "stationary"));
    still(HOME, base + 2 * HOUR + 24 * MINUTE + 30_000, base + 4 * HOUR);
    still(near, base + 4 * HOUR + 30_000, base + 6 * HOUR);
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion }]), false, family);
      const txt = render(home, DAYS[0]!, labels, family).txt;
      expect(txt).toMatch(/\n04:00–06:00 At Home\n06:01–06:22 At an unnamed place 0\.2 km from Home\n06:23–07:59 At Home\n/u);
      expect(txt).toMatch(/\n07:59–08:00 Moved 0\.2 km, mode unclear, Home → an unnamed place 0\.2 km from Home\n08:00–09:59 At an unnamed place 0\.2 km from Home \(still there at the last fix\)\n/u);
      expect(extracts(home).filter((row) => row.unit.startsWith(`trip/${LOCATION}/`))).toHaveLength(3);
      ARTIFACT.next_door = txt;
    } finally {
      home.close();
    }
  });

  it("an unnamed hotel abroad reads as another place on each day", () => {
    const hotel = offset(OFFICE, 550_000);
    const cafe = offset(hotel, 3_000);
    const location: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(47);
    for (const [index, day] of DAYS.entries()) {
      const base = dayBounds(day, SETTINGS).start_ms;
      const night = offset(hotel, 15 * (random() - 0.5) * (index + 1), 15 * (random() - 0.5));
      for (let ms = base; ms < base + 6 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, night, 0, 10));
      for (let step = 0; step < 30; step++) location.push(fixRow(++sequence, base + 6 * HOUR + step * 20_000, offset(hotel, 100 * step), 9));
      for (let ms = base + 6 * HOUR + 10 * MINUTE; ms < base + 9 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, cafe, 0, 10));
      for (let step = 0; step < 30; step++) location.push(fixRow(++sequence, base + 9 * HOUR + step * 20_000, offset(cafe, -100 * step), 9));
      for (let ms = base + 9 * HOUR + 10 * MINUTE; ms < base + 24 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, offset(night, 3, 3), 0, 10));
    }
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion: [] }]));
      const words = DAYS.map((day) => [...render(home, day).txt.matchAll(/ At (an unnamed place [^\n(]+?)(?: \(|\n)/gu)].map((match) => match[1]));
      for (const day of words) expect(new Set(day)).toEqual(new Set(["an unnamed place 553 km from Office", "an unnamed place 550 km from Office"]));
      ARTIFACT.hotel = words as unknown as Json;
    } finally {
      home.close();
    }
  });

  it("a Timeline stay partly overlapped by the phone's hours prints nothing for its uncovered hours", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    let sequence = 0;
    for (let ms = base + 6 * HOUR; ms <= base + 12 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, OFFICE, 0));
    const start = "2026-09-21T05:00:00.000-04:00", end = "2026-09-21T17:05:00.000-04:00";
    const home = newHome();
    try {
      home.land(TIMELINE, Date.parse("2026-09-20T12:00:00Z"), [{
        kind: "place-visit", key: "20260921T0900000000", time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
        content: { type: "timeline.visit", content: { startTime: start, endTime: end,
          visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: "synthetic-place-a", placeLocation: "geo:0.000010,0.013480", probability: "0.91", semanticType: "UNKNOWN" } } } },
      }]);
      landAll(home, bundles([{ location, motion: [] }]));
      const txt = render(home, DAYS[0]!).txt;
      expect(txt).toMatch(/05:00–10:00 At Office \(stated by Timeline\)\n10:00–16:00 At Office \(still there at the last fix\)\n16:00–17:05 At Office \(stated by Timeline\)\n/u);
      ARTIFACT.partial = txt;
    } finally {
      home.close();
    }
  });

  it("a Timeline visit at a Google place prints unnamed, a Timeline trip's ends are not the visits beside it, or a visit's change leaves a trip's end stale", () => {
    const visit = (start: string, end: string, point: Point, place: string): ReaderOutput => ({
      kind: "place-visit", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
      content: { type: "timeline.visit", content: { startTime: start, endTime: end,
        visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: place, placeLocation: `geo:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
    });
    const trip = (start: string, end: string): ReaderOutput => ({
      kind: "trip", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
      content: { type: "timeline.trip", content: { startTime: start, endTime: end,
        activity: { start: "geo:0.020000,0.020000", end: "geo:0.040000,0.040000", distanceMeters: "3000.00", probability: "0.7", topCandidate: { type: "in passenger vehicle", probability: "0.8" } } } },
    });
    const bakery = { latitude: 0.05, longitude: 0.05 };
    const next = offset(bakery, 50);
    const rows = [
      visit("2026-09-19T05:00:00.000-04:00", "2026-09-19T08:00:00.000-04:00", offset(HOME, 30), "synthetic-place-h"),
      trip("2026-09-19T08:00:00.000-04:00", "2026-09-19T08:20:00.000-04:00"),
      visit("2026-09-19T08:20:00.000-04:00", "2026-09-19T10:00:00.000-04:00", next, "synthetic-place-e"),
      trip("2026-09-19T10:00:00.000-04:00", "2026-09-19T10:20:00.000-04:00"),
    ];
    const places = owned([
      { slug: "home", name: "Home", centre: { latitude: 0, longitude: 0 }, radius_m: 120, ids: ["google:synthetic-place-h"] },
      { slug: "synthetic-bakery", name: "Synthetic Bakery", centre: { ...bakery }, radius_m: 80, ids: ["google:synthetic-place-e"] },
      { slug: "next-door", name: "Next Door", centre: { ...offset(bakery, 90) }, radius_m: 40 },
    ]);
    const family = physical;
    const labels = buildLabels({ people: [], contacts: [], places });
    const home = newHome();
    const fresh = newHome();
    try {
      home.land(TIMELINE, Date.parse("2026-09-20T12:00:00Z"), rows);
      pass(home, SETTINGS, family);
      const txt = render(home, "2026-09-19", labels, family).txt;
      expect(txt).toMatch(/05:00–08:00 At Home \(stated by Timeline\)/u);
      expect(txt).toMatch(/08:20–10:00 At Synthetic Bakery \(stated by Timeline\)/u);
      const bakeryStay = extracts(home).find((row) => row.unit.endsWith("/20260919T0820000400"))!.content as unknown as StayContent;
      expect(bakeryStay.centre).toEqual({ latitude: 0.05, longitude: 0.05045, id: "google:synthetic-place-e" });
      expect(txt).toMatch(/08:00–08:20 Passenger vehicle \(stated by Timeline\), Home → Synthetic Bakery, 3\.0 km in 20 m\n/u);
      expect(txt).toMatch(/10:00–10:20 Passenger vehicle \(stated by Timeline\), Synthetic Bakery → an unnamed place 1\.6 km from Synthetic Bakery, 3\.0 km in 20 m\n/u);
      const moved = visit("2026-09-19T08:20:00.000-04:00", "2026-09-19T10:00:00.000-04:00", next, "synthetic-place-z");
      home.land(TIMELINE, Date.parse("2026-09-21T12:00:00Z"), [moved]);
      const again = pass(home, SETTINGS, family);
      expect(again.written.filter((unit) => unit.startsWith("trip/")).length).toBe(2);
      fresh.land(TIMELINE, Date.parse("2026-09-20T12:00:00Z"), [...rows.slice(0, 2), moved, rows[3]!]);
      pass(fresh, SETTINGS, family);
      expect(summary(home)).toEqual(summary(fresh));
      const renamed = render(home, "2026-09-19", labels, family).txt;
      expect(renamed).toMatch(/08:00–08:20 Passenger vehicle \(stated by Timeline\), Home → Next Door, 3\.0 km in 20 m\n/u);
      for (const content of extracts(home).map((row) => row.content as unknown as TripContent).filter((content) => content.kind === "trip")) {
        expect(renamed).toContain(`${resolvedPlace(content.from!, labels)[4]} → ${resolvedPlace(content.to!, labels)[4]}`);
      }
      ARTIFACT.timeline_trips = renamed;
    } finally {
      home.close();
      fresh.close();
    }
  });

  it("an owner place touches a physical unit, or the day splits a stay its circle holds", () => {
    const cafe = { latitude: 0.03, longitude: 0 };
    const gate = { latitude: 0.03, longitude: 0.03 };
    const first: Delivery = { source: OWNER_PLACES, stated_ms: Date.UTC(2026, 8, 19), rows: [ownerPlace("home", "Home", HOME), ownerPlace("office", "Office", OFFICE), ownerPlace("cafe", "Cafe", cafe, 40)] };
    const placeRows: ReaderOutput[] = [ownerPlace("cafe", "Cafe", cafe, 150), ownerPlace("gate", "Gate", gate, 150)];
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(53);
    const hour = (place: Point, from: number) => {
      for (let ms = from; ms < from + HOUR; ms += 30_000) {
        const out = Math.floor((ms - from) / (10 * MINUTE)) % 2 === 1;
        location.push(fixRow(++sequence, ms, offset(place, 5 * random(), (out ? 110 : 0) + 5 * random()), 0));
      }
    };
    hour(cafe, base + HOUR);
    for (let step = 0; step < 30; step++) location.push(fixRow(++sequence, base + 2 * HOUR + step * 20_000, offset(cafe, 3_340 * step / 30), 9));
    hour(gate, base + 2 * HOUR + 10 * MINUTE);
    const phone = bundles([{ location, motion: [] }]);
    const late = newHome();
    const fresh = newHome();
    try {
      landAll(late, [first, ...phone]);
      const labelsOf = (home: TestHome) => home.read((view) => readLabels(view, HOME_UNIT, NETWORKED));
      const split = render(late, DAYS[0]!, labelsOf(late)).txt;
      expect(split.match(/ At /gu)!.length).toBeGreaterThan(4);
      const stored = summary(late);
      late.land(OWNER_PLACES, Date.UTC(2026, 8, 24), placeRows);
      expect(pass(late)).toEqual({ touched: [], written: [], deleted: [] });
      expect(FAMILY.inputs.some((input) => input.sources.product?.includes("places") === true)).toBe(false);
      landAll(fresh, [first, { source: OWNER_PLACES, stated_ms: Date.UTC(2026, 8, 20), rows: placeRows }, ...phone]);
      expect(summary(fresh)).toEqual(stored);
      const txt = render(late, DAYS[0]!, labelsOf(late)).txt;
      expect(txt).toMatch(/\n05:00–05:59 At Cafe\n05:59–06:10 Road vehicle, Cafe → Gate, 3\.\d km\n06:10–07:09 At Gate \(still there at the last fix\)\n/u);
      expect(txt.match(/ At /gu)).toHaveLength(2);
      ARTIFACT.one_list = { split, txt };
    } finally {
      late.close();
      fresh.close();
    }
  });

  it("a walk out of a place and back prints as one stay, or a move inside the place prints as a trip", () => {
    const places = owned([{ slug: "home", name: "Home", centre: { latitude: 0, longitude: 0 }, radius_m: 150 }]);
    const labels = buildLabels({ people: [], contacts: [], places });
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    const motion: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(59);
    const still = (point: Point, from: number, to: number) => {
      for (let ms = from; ms < to; ms += 30_000) location.push(fixRow(++sequence, ms, offset(point, 5 * random(), 5 * random()), 0));
    };
    const walk = (from: Point, to: Point, start: number): number => {
      const east = (to.longitude - from.longitude) * 111_195;
      const north = (to.latitude - from.latitude) * 111_195;
      const steps = Math.ceil(Math.hypot(east, north) / 14);
      for (let step = 0; step < steps; step++) location.push(fixRow(++sequence, start + step * 10_000, offset(from, east * step / steps, north * step / steps), 1.4));
      return start + steps * 10_000;
    };
    const far = offset(HOME, 500);
    const inner = offset(HOME, 0, 110);
    motion.push(motionRow(++sequence, base, "stationary"));
    still(HOME, base, base + 2 * HOUR);
    motion.push(motionRow(++sequence, base + 2 * HOUR, "walking"));
    const back = walk(far, HOME, walk(HOME, far, base + 2 * HOUR));
    motion.push(motionRow(++sequence, back, "stationary"));
    still(HOME, back, base + 4 * HOUR);
    motion.push(motionRow(++sequence, base + 4 * HOUR, "walking"));
    const there = walk(HOME, inner, base + 4 * HOUR);
    motion.push(motionRow(++sequence, there, "stationary"));
    still(inner, there, there + 15 * MINUTE);
    motion.push(motionRow(++sequence, there + 15 * MINUTE, "walking"));
    const home2 = walk(inner, HOME, there + 15 * MINUTE);
    motion.push(motionRow(++sequence, home2, "stationary"));
    still(HOME, home2, base + 6 * HOUR);
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion }]));
      expect(extracts(home).filter((row) => row.unit.startsWith(`stay/${LOCATION}/`)).length).toBe(4);
      const txt = render(home, DAYS[0]!, labels).txt;
      expect(txt.match(/ At /gu)).toHaveLength(2);
      expect(txt).toMatch(/\n04:00–06:01 At Home\n06:01–06:11 Walk, Home → Home, 0\.9 km\n06:11–09:59 At Home \(still there at the last fix\)\n/u);
      expect(txt).not.toMatch(/0\.1 km/u);
      ARTIFACT.one_place = txt;
    } finally {
      home.close();
    }
  });

  it("an early fix rewrites a unit it did not change, leaves one it changed unbuilt, or rebuilds to the phone's last fix", () => {
    const deliveries = bundles(DAYS.map((day, index) => phoneDay(day, index * 10_000, mulberry32(59 + index))));
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const early = fixRow(9_999, base + 11.5 * HOUR, OFFICE, 0);
    const home = newHome();
    const reference = newHome();
    try {
      landAll(home, deliveries, true);
      const before = new Map(extracts(home).map((row) => [row.unit, row.reading]));
      home.land(LOCATION, Date.parse(`${DAYS[2]}T20:00:00Z`), [early]);
      const moved = pass(home);
      landAll(reference, [...deliveries, { source: LOCATION, stated_ms: Date.parse(`${DAYS[2]}T20:00:00Z`), rows: [early] }]);
      expect(summary(home)).toEqual(summary(reference));
      expect(overlaps(extracts(home))).toEqual([]);
      const changed = extracts(home).filter((row) => before.get(row.unit) !== row.reading).map((row) => row.unit);
      expect(changed.length).toBeGreaterThan(0);
      expect(moved.written.sort()).toEqual(changed.sort());
      expect(moved.deleted).toEqual([]);
      const touchedDays = new Set(extracts(home).filter((row) => moved.touched.includes(row.unit)).flatMap((row) => row.days));
      expect([...touchedDays].sort()).toEqual([DAYS[0]]);
      for (const row of extracts(home).filter((each) => each.unit.includes(`/${LOCATION}/`))) {
        expect(home.read((view) => FAMILY.extract(row.unit, view, home.blobs)?.reading), row.unit).toBe(row.reading);
      }
      ARTIFACT.early_fix = { touched: moved.touched.length, written: moved.written, days: [...touchedDays] };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("a late motion reading leaves a unit it holds over stale, or rebuilds one past its 30 minutes", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const at = (hours: number) => base + Math.round(hours * HOUR);
    const random = mulberry32(61);
    const jitter = (point: Point): Point => ({ latitude: point.latitude + (random() - 0.5) * 0.0002, longitude: point.longitude + (random() - 0.5) * 0.0002 });
    let sequence = 0;
    const location: ReaderOutput[] = [];
    const stay = (place: Point, from: number, to: number) => {
      for (let ms = at(from); ms < at(to); ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, jitter(place), 0));
    };
    const walk = (from: Point, to: Point, start: number, end: number) => {
      const steps = Math.round((at(end) - at(start)) / 30_000);
      for (let step = 0; step < steps; step++) {
        const share = step / steps;
        location.push(fixRow(++sequence, at(start) + step * 30_000,
          { latitude: from.latitude + (to.latitude - from.latitude) * share, longitude: from.longitude + (to.longitude - from.longitude) * share }, 1.3));
      }
    };
    stay(HOME, 0, 2);
    walk(HOME, OFFICE, 2, 2 + 20 / 60);
    stay(OFFICE, 2 + 20 / 60, 4);
    walk(OFFICE, GYM, 4, 4.2);
    stay(GYM, 4.2, 5);
    const motion = [motionRow(++sequence, at(0), "stationary"), motionRow(++sequence, at(6), "stationary")];
    const late = motionRow(++sequence, at(2), "automotive");
    const home = newHome();
    const reference = newHome();
    try {
      landAll(home, bundles([{ location, motion }]), true);
      home.land(MOTION, Date.parse(`${DAYS[1]}T12:00:00Z`), [late]);
      const moved = pass(home);
      landAll(reference, [...bundles([{ location, motion }]), { source: MOTION, stated_ms: Date.parse(`${DAYS[1]}T12:00:00Z`), rows: [late] }]);
      expect(summary(home)).toEqual(summary(reference));
      const walks = extracts(home).filter((row) => row.unit.startsWith(`trip/${LOCATION}/`));
      expect(walks.map((row) => (row.content as unknown as TripContent).legs.map((leg) => leg.mode))).toEqual([["road_vehicle"], ["walk"]]);
      expect(moved.written).toEqual([walks[0]!.unit]);
      ARTIFACT.late_motion = { touched: moved.touched, written: moved.written };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("a change stops at the first stay an older code stored as it comes out: a reading holds no code", () => {
    const deliveries = bundles(DAYS.map((day, index) => phoneDay(day, index * 10_000, mulberry32(59 + index))));
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const early = fixRow(9_999, base + 11.5 * HOUR, OFFICE, 0);
    const late = { source: LOCATION, stated_ms: Date.parse(`${DAYS[2]}T20:00:00Z`), rows: [early] };
    const older: Family = { ...FAMILY, code: "12" };
    const home = newHome();
    const current = newHome();
    const reference = newHome();
    try {
      landAll(home, deliveries, true, older);
      landAll(current, deliveries, true);
      expect(summary(home)).toEqual(summary(current));
      expect(summary(home).length).toBeGreaterThan(10);
      expect(new Set(extracts(home).map((row) => row.code))).toEqual(new Set(["12"]));
      expect(new Set(extracts(current).map((row) => row.code))).toEqual(new Set([FAMILY.code]));
      home.land(late.source, late.stated_ms, late.rows);
      const moved = pass(home);
      landAll(reference, [...deliveries, late]);
      expect(summary(home)).toEqual(summary(reference));
      const touchedDays = new Set(extracts(home).filter((row) => moved.touched.includes(row.unit)).flatMap((row) => row.days));
      expect([...touchedDays].sort()).toEqual([DAYS[0]]);
      const untouched = extracts(home).filter((row) => !moved.touched.includes(row.unit));
      expect(untouched.length).toBeGreaterThan(4);
      expect(untouched.every((row) => row.code === "12")).toBe(true);
      ARTIFACT.older_code = { units: summary(current).length, touched: moved.touched.length, untouched: untouched.length, days: [...touchedDays] };
    } finally {
      home.close();
      current.close();
      reference.close();
    }
  });

  it("a late fix reads the phone back to where it last broke off, days behind the stays the store holds before it", () => {
    const days = walkingDays(2, 0, mulberry32(71));
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms + 24 * HOUR;
    const late = fixRow(99_999, base + 8.5 * HOUR + 30_000, offset(OFFICE, 12), 0);
    const home = newHome();
    const reference = newHome();
    try {
      const events: ReaderOutput[] = Array.from({ length: 2 * 24 * 6 }, (_, index) => ({
        kind: "recorder", key: `${INSTALL}:${200_000 + index}`, time: { start_ms: base - 24 * HOUR + index * 10 * MINUTE, precision: "ms" },
        content: { type: "location.recorder", content: entry("location", "recorder_event", 200_000 + index, base - 24 * HOUR + index * 10 * MINUTE, { event: "engine_b_state" }) },
      }));
      landAll(home, [...bundles([days]), { source: LOCATION, stated_ms: base + 25 * HOUR, rows: events }]);
      home.land(LOCATION, base + 30 * HOUR, [late]);
      const run = chunkedRun(home, (changes) => [changes]);
      landAll(reference, [...bundles([days]), { source: LOCATION, stated_ms: base + 30 * HOUR, rows: [late] }]);
      expect(Object.fromEntries([...run.readings].sort())).toEqual(Object.fromEntries(summary(reference).filter((row) => row.unit.includes(`/${LOCATION}/`)).map((row) => [row.unit, row.reading])));
      const fixes = days.location.filter((row) => row.time!.start_ms >= base - 2 * HOUR).length;
      expect(run.read.fix).toBeLessThan(fixes);
      expect(Object.keys(run.read).sort()).toEqual(["fix", "motion"]);
      ARTIFACT.late_fix = { read: run.read, fixes_since_morning: fixes, fixes: days.location.length };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("a change in a later chunk rebuilds from a stored stay an earlier chunk's change removed", () => {
    const deliveries = bundles([phoneDay(DAYS[0]!, 0, mulberry32(73)), phoneDay(DAYS[1]!, 10_000, mulberry32(74))]);
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const home = newHome();
    const reference = newHome();
    try {
      landAll(home, deliveries);
      const gym = deliveries.flatMap((delivery) => delivery.rows).filter((row) => row.kind === "fix" && row.time!.start_ms >= base + 8.75 * HOUR && row.time!.start_ms < base + 9.75 * HOUR);
      const evening = fixRow(9_998, base + 15 * HOUR + 20_000, offset(HOME, 6), 0);
      home.land(LOCATION, base + 30 * HOUR, gym.map((row): ReaderOutput => ({ kind: row.kind, key: row.key, content: null, gone: true })));
      home.land(LOCATION, base + 31 * HOUR, [evening]);
      const reference_rows = deliveries.map((delivery) => ({ ...delivery, rows: delivery.rows.filter((row) => !gym.includes(row)) }));
      landAll(reference, [...reference_rows, { source: LOCATION, stated_ms: base + 31 * HOUR, rows: [evening] }]);
      const expected = Object.fromEntries(summary(reference).filter((row) => row.unit.includes(`/${LOCATION}/`)).map((row) => [row.unit, row.reading]));
      for (const order of ["gone first", "evening first"] as const) {
        const run = chunkedRun(home, (changes) => {
          const gone = changes.filter((change) => change.after === undefined);
          const rest = changes.filter((change) => change.after !== undefined);
          return order === "gone first" ? [gone, rest] : [rest, gone];
        });
        expect(Object.fromEntries([...run.readings].sort()), order).toEqual(expected);
      }
      ARTIFACT.chunks = { expected: Object.keys(expected).length };
    } finally {
      home.close();
      reference.close();
    }
  });

  it("touching Timeline visits at one place print as two stays, or a visit's change leaves the stay it joined stale", () => {
    const visit = (start: string, end: string, point: Point, place: string): ReaderOutput => ({
      kind: "place-visit", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
      content: { type: "timeline.visit", content: { startTime: start, endTime: end,
        visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: place, placeLocation: `geo:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
    });
    const rows = [
      visit("2026-09-17T00:00:00.000-04:00", "2026-09-17T06:00:00.000-04:00", offset(HOME, 20), "synthetic-place-h"),
      visit("2026-09-17T06:00:00.000-04:00", "2026-09-17T12:15:00.000-04:00", offset(HOME, 0, 40), "synthetic-place-k"),
      visit("2026-09-17T12:15:00.000-04:00", "2026-09-17T20:00:00.000-04:00", offset(HOME, 20), "synthetic-place-h"),
      visit("2026-09-17T20:00:00.000-04:00", "2026-09-17T22:00:00.000-04:00", OFFICE, "synthetic-place-o"),
    ];
    const home = newHome();
    const fresh = newHome();
    try {
      home.land(TIMELINE, Date.parse("2026-09-18T12:00:00Z"), rows);
      pass(home);
      expect(extracts(home).filter((row) => row.unit.startsWith(`stay/${TIMELINE}/`))).toHaveLength(4);
      const txt = render(home, "2026-09-17").txt;
      expect(txt).toMatch(/\n04:00–20:00 At Home \(stated by Timeline\) \(continues from 16 Sep\)\n20:00–22:00 At Office \(stated by Timeline\)\n/u);
      expect(txt.match(/ At /gu)).toHaveLength(2);
      const atHome = (JSON.parse(render(home, "2026-09-17").json) as { atoms: { text: string; units: string[] }[] }).atoms.find((atom) => atom.text.startsWith("At Home"))!;
      expect(atHome.units.filter((unit) => unit.startsWith(`stay/${TIMELINE}/`)).sort()).toEqual(
        extracts(home).filter((row) => row.unit.startsWith(`stay/${TIMELINE}/`) && row.end_ms! <= Date.parse("2026-09-17T20:00:00.000-04:00")).map((row) => row.unit).sort());
      const moved = visit("2026-09-17T06:00:00.000-04:00", "2026-09-17T12:15:00.000-04:00", OFFICE, "synthetic-place-o");
      home.land(TIMELINE, Date.parse("2026-09-19T12:00:00Z"), [moved]);
      pass(home);
      fresh.land(TIMELINE, Date.parse("2026-09-18T12:00:00Z"), [rows[0]!, moved, rows[2]!, rows[3]!]);
      pass(fresh);
      expect(summary(home)).toEqual(summary(fresh));
      const again = render(home, "2026-09-17").txt;
      expect(again).toMatch(/\n04:00–06:00 At Home \(stated by Timeline\) \(continues from 16 Sep\)\n06:00–12:15 At Office \(stated by Timeline\)\n12:15–20:00 At Home \(stated by Timeline\)\n/u);
      ARTIFACT.touching_visits = { txt, again };
    } finally {
      home.close();
      fresh.close();
    }
  });

  it("an overnight silence prints as a journey with a mode, a recorder gap record changes a unit, or a drive motion saw across a silence prints as not recorded", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const away = offset(HOME, 6_600);
    const location: ReaderOutput[] = [];
    let sequence = 0;
    for (let ms = base + 15 * HOUR; ms <= base + 19.25 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, HOME, 0));
    for (let ms = base + 29 * HOUR + 58 * MINUTE; ms < base + 32 * HOUR; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, away, 0));
    const motion = [motionRow(++sequence, base, "stationary")];
    const gap = gapRow(++sequence, base + 19.25 * HOUR, base + 29 * HOUR + 58 * MINUTE);
    const home = newHome();
    const recorded = newHome();
    const drive = newHome();
    try {
      landAll(home, bundles([{ location, motion }]));
      const night = render(home, DAYS[0]!).txt;
      const morning = render(home, DAYS[1]!).txt;
      expect(night).toMatch(/\n19:00–23:14 At Home\n23:14–2026-09-22 04:00 Not recorded, Home → an unnamed place 5\.1 km from Office, 6\.6 km \(continues into 22 Sep\)\n/u);
      expect(morning).toMatch(/\n04:00–09:58 Not recorded, Home → an unnamed place 5\.1 km from Office, 6\.6 km \(continues from 21 Sep\)\n/u);
      for (const txt of [night, morning]) expect(txt).not.toMatch(/Unknown|stationary|phone motion/u);
      landAll(recorded, bundles([{ location: [...location, gap], motion }]));
      expect(summary(recorded)).toEqual(summary(home));
      landAll(drive, dataset());
      expect(render(drive, DAYS[1]!).txt).toMatch(/\n18:00–18:10 Road vehicle, Office → Home, 1\.\d km\n/u);
      ARTIFACT.overnight_silence = { night, morning };
    } finally {
      home.close();
      recorded.close();
      drive.close();
    }
  });

  it("a silence after a stay prints as movement or stretches the stay, a silence makes a whole trip unknown, or a recorder gap record touches a unit", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const at = (minutes: number) => base + Math.round(minutes * MINUTE);
    const location: ReaderOutput[] = [];
    const motion: ReaderOutput[] = [];
    let sequence = 0;
    const random = mulberry32(79);
    const fix = (minutes: number, point: Point, speed: number) => location.push(fixRow(++sequence, at(minutes), point, speed));
    const still = (point: Point, from: number, to: number) => {
      for (let minutes = from; minutes <= to; minutes += 2) fix(minutes, offset(point, 5 * random(), 5 * random()), 0);
    };
    const activity = (minutes: number, kind: Activity) => motion.push(motionRow(++sequence, at(minutes), kind));
    let east = 300;
    const drive = (from: number, to: number) => {
      for (let step = 0; from + step / 3 < to - 0.01; step++, east += 300) fix(from + step / 3, offset(HOME, east), 15);
    };
    activity(0, "stationary");
    still(HOME, 0, 376);
    activity(458, "automotive");
    drive(458, 464);
    activity(464, "stationary");
    activity(466, "automotive");
    drive(466, 470);
    activity(470, "stationary");
    east -= 250;
    fix(473.5, offset(HOME, east), 0);
    fix(473.5 + 1 / 6, offset(HOME, east + 10), 0);
    east += 50;
    activity(477, "automotive");
    drive(477, 487);
    east += 2_700;
    drive(490, 496);
    const far = offset(HOME, east);
    activity(496, "stationary");
    still(far, 496, 600);
    activity(610, "walking");
    for (let step = 0; step < 20; step++) fix(620 + step / 2, offset(far, 840 + 42 * step), 1.4);
    const cafe = offset(far, 1_680);
    activity(630, "stationary");
    still(cafe, 630, 700);
    const gaps = [gapRow(++sequence, at(376) + 1_000, at(458)), gapRow(++sequence, at(470), at(477)), gapRow(++sequence, at(600) + 1_000, at(620))];
    const labels = buildLabels({ people: [], contacts: [], places: owned([
      { slug: "home", name: "Home", centre: HOME, radius_m: 120 },
      { slug: "far", name: "Far", centre: far, radius_m: 120 },
      { slug: "cafe", name: "Cafe", centre: cafe, radius_m: 120 },
    ]) });
    const home = newHome();
    const recorded = newHome();
    try {
      landAll(home, bundles([{ location, motion }]));
      const txt = render(home, DAYS[0]!, labels).txt;
      expect(txt).toMatch(/\n04:00–10:16 At Home\n10:16–12:16 Trip, Home → Far, \d+\.\d km, 4 legs \(4\)\n {2}10:16–11:38 Not recorded, 0\.3 km\n/u);
      const trip = extracts(home).find((row) => row.unit === `trip/${LOCATION}/${at(376)}`)!.content as unknown as TripContent;
      expect(trip.legs.map((leg) => [leg.mode, (leg.start_ms - base) / MINUTE, (leg.end_ms - base) / MINUTE])).toEqual([
        ["unknown", 376, 458],
        ["road_vehicle", 458, 469 + 2 / 3],
        ["unknown", 469 + 2 / 3, 477],
        ["road_vehicle", 477, 496],
      ]);
      expect(trip.legs.map((leg) => leg.motion)).toEqual([null, null, null, null]);
      expect(txt).toMatch(/\n12:16–14:10 At Far\n14:10–14:30 Walk, Far → Cafe, 1\.7 km\n14:30–15:40 At Cafe \(still there at the last fix\)\n/u);
      expect(txt).not.toMatch(/mode unclear|Unknown|phone motion/u);
      home.land(LOCATION, at(24 * 60), gaps);
      expect(pass(home)).toEqual({ touched: [], written: [], deleted: [] });
      landAll(recorded, bundles([{ location: [...location, ...gaps], motion }]));
      expect(summary(recorded)).toEqual(summary(home));
      ARTIFACT.silent_departure = txt;
    } finally {
      home.close();
      recorded.close();
    }
  });

  it("one motion reading held while the phone is quiet makes a silence a walk or a drive, or a silence crossed at road speed prints as a cycle", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const at = (minutes: number) => base + Math.round(minutes * MINUTE);
    const location: ReaderOutput[] = [];
    const motion: ReaderOutput[] = [];
    let sequence = 0;
    const fix = (minutes: number, point: Point, speed: number) => location.push(fixRow(++sequence, at(minutes), point, speed));
    const activity = (minutes: number, kind: Activity) => motion.push(motionRow(++sequence, at(minutes), kind));
    const still = (point: Point, from: number, to: number) => {
      for (let minutes = from; minutes <= to; minutes += 2) fix(minutes, point, 0);
    };
    let east = 0;
    const go = (from: number, to: number, speed: number, every: number) => {
      for (let seconds = 0; from + seconds / 60 < to - 0.001; seconds += every, east += speed * every) fix(from + seconds / 60, offset(HOME, east), speed);
    };
    activity(0, "stationary");
    still(HOME, 0, 120);
    activity(120, "walking");
    activity(122, "walking");
    activity(124, "walking");
    go(120.5, 125, 1.3, 30);
    east += 2_000;
    activity(205, "automotive");
    go(205, 215, 15, 20);
    activity(215, "cycling");
    east += 4_000;
    fix(220, offset(HOME, east), 6.9);
    activity(220, "automotive");
    go(220 + 1 / 3, 230, 15, 20);
    const far = offset(HOME, east);
    activity(230, "stationary");
    still(far, 230, 300);
    const labels = buildLabels({ people: [], contacts: [], places: owned([
      { slug: "home", name: "Home", centre: HOME, radius_m: 120 },
      { slug: "far", name: "Far", centre: far, radius_m: 120 },
    ]) });
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion }]));
      const trip = extracts(home).find((row) => row.unit.startsWith(`trip/${LOCATION}/`))!.content as unknown as TripContent;
      expect(trip.legs.map((leg) => [leg.mode, Math.round((leg.start_ms - base) / MINUTE), Math.round((leg.end_ms - base) / MINUTE), leg.motion])).toEqual([
        ["walk", 122, 125, null],
        ["unknown", 125, 205, null],
        ["road_vehicle", 205, 230, null],
      ]);
      const txt = render(home, DAYS[0]!, labels).txt;
      expect(txt).toMatch(/\n {2}06:04–07:25 Not recorded, 2\.\d km\n/u);
      expect(txt).not.toMatch(/Cycle|phone motion/u);
      ARTIFACT.quiet_phone = txt;
    } finally {
      home.close();
    }
  });

  it("a trip that starts where motion began in a silence takes its speed over the whole silence", () => {
    const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
    const at = (minutes: number) => base + Math.round(minutes * MINUTE);
    const location: ReaderOutput[] = [];
    const motion: ReaderOutput[] = [];
    let sequence = 0;
    const still = (point: Point, from: number, to: number) => {
      for (let minutes = from; minutes <= to; minutes += 2) location.push(fixRow(++sequence, at(minutes), point, 0));
    };
    const far = offset(HOME, 2_000);
    motion.push(motionRow(++sequence, at(0), "stationary"));
    still(HOME, 0, 10);
    motion.push(motionRow(++sequence, at(55), "cycling"));
    motion.push(motionRow(++sequence, at(61), "stationary"));
    still(far, 60, 90);
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion }]));
      const trip = extracts(home).find((row) => row.unit.startsWith(`trip/${LOCATION}/`))!.content as unknown as TripContent;
      expect(trip.legs.map((leg) => [leg.mode, Math.round((leg.start_ms - base) / MINUTE), Math.round((leg.end_ms - base) / MINUTE)])).toEqual([["cycle", 55, 60]]);
    } finally {
      home.close();
    }
  });

  it("a Timeline stretch Google did not see prints as an activity or loses where the person went, or a doubtful activity prints as a sure one", () => {
    const visit = (start: string, end: string, point: Point): ReaderOutput => ({
      kind: "place-visit", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
      content: { type: "timeline.visit", content: { startTime: start, endTime: end,
        visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: "synthetic-place-a", placeLocation: `geo:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
    });
    const trip = (start: string, end: string, type: string, distance: string): ReaderOutput => ({
      kind: "trip", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
      content: { type: "timeline.trip", content: { startTime: start, endTime: end,
        activity: { start: "geo:0.000000,0.000000", end: "geo:0.000000,0.013500", distanceMeters: distance, probability: "0.4", topCandidate: { type, probability: "0.3" } } } },
    });
    const rows = [
      visit("2026-09-14T00:00:00.000-04:00", "2026-09-14T06:00:00.000-04:00", HOME),
      trip("2026-09-14T06:00:00.000-04:00", "2026-09-16T04:54:00.000-04:00", "in passenger vehicle", "100.00"),
      visit("2026-09-16T04:54:00.000-04:00", "2026-09-16T08:00:00.000-04:00", OFFICE),
      trip("2026-09-16T08:00:00.000-04:00", "2026-09-16T12:00:00.000-04:00", "in passenger vehicle", "6500.00"),
      visit("2026-09-16T12:00:00.000-04:00", "2026-09-16T13:00:00.000-04:00", HOME),
      trip("2026-09-16T13:00:00.000-04:00", "2026-09-16T13:20:00.000-04:00", "walking", "1500.00"),
      visit("2026-09-16T13:20:00.000-04:00", "2026-09-16T18:00:00.000-04:00", OFFICE),
      trip("2026-09-16T18:00:00.000-04:00", "2026-09-16T20:00:00.000-04:00", "walking", "300.00"),
      visit("2026-09-16T20:00:00.000-04:00", "2026-09-16T22:00:00.000-04:00", offset(OFFICE, 70)),
    ];
    const home = newHome();
    try {
      home.land(TIMELINE, Date.parse("2026-09-18T12:00:00Z"), rows);
      pass(home);
      const days = ["2026-09-14", "2026-09-15", "2026-09-16"].map((day) => render(home, day).txt);
      expect(days[0]).toMatch(/\n06:00–2026-09-15 04:00 Not recorded, Home → Office, 1\.5 km \(continues into 15 Sep\)\n/u);
      expect(days[1]).toMatch(/\n04:00–2026-09-16 04:00 Not recorded, Home → Office, 1\.5 km \(continues from 14 Sep\) \(continues into 16 Sep\)\n/u);
      expect(days[2]).toMatch(/\n04:00–04:54 Not recorded, Home → Office, 1\.5 km \(continues from 15 Sep\)\n/u);
      for (const txt of days) expect(txt).not.toMatch(/0\.1 km|46 h|Walking \(stated by Timeline[^)]*\), Office → Office/u);
      expect(days[2]).not.toMatch(/18:00–20:00/u);
      expect(days[2]).toMatch(/\n08:00–12:00 Passenger vehicle \(stated by Timeline, doubtful\), Office → Home, 6\.5 km in 4 h\n/u);
      expect(days[2]).toMatch(/\n13:00–13:20 Walking \(stated by Timeline\), Home → Office, 1\.5 km in 20 m\n/u);
      const still = extracts(home).find((row) => row.unit === `trip/${TIMELINE}/20260914T0600000400`)!.content as unknown as TripContent;
      expect(still.legs).toMatchObject([{ mode: "unknown", distance_m: 100, stated: "in passenger vehicle" }]);
      ARTIFACT.timeline_moves = days;
    } finally {
      home.close();
    }
  });

  it("a silence under three hours prints, one crossing 04:00 prints its whole length on each day, and one on another day of its stay never", () => {
    const base = dayBounds(DAYS[1]!, SETTINGS).start_ms;
    const location: ReaderOutput[] = [];
    let sequence = 0;
    const fixes = (from: number, to: number) => {
      for (let ms = from; ms <= to; ms += 2 * MINUTE) location.push(fixRow(++sequence, ms, HOME, 0));
    };
    fixes(base - 6 * HOUR, base - 3 * HOUR);
    fixes(base + 3 * HOUR, base + 5 * HOUR);
    fixes(base + 5.75 * HOUR, base + 8 * HOUR);
    fixes(base + 11.5 * HOUR, base + 12 * HOUR);
    const home = newHome();
    try {
      landAll(home, bundles([{ location, motion: [motionRow(++sequence, base - 6 * HOUR, "stationary")] }]));
      const before = render(home, DAYS[0]!).txt;
      const after = render(home, DAYS[1]!).txt;
      expect(before).toMatch(/\n2026-09-22 01:00–04:00 No location for 3 h \(continues into 22 Sep\)\n/u);
      expect(after).toMatch(/\n04:00–07:00 No location for 3 h \(continues from 21 Sep\)\n/u);
      expect(after).not.toMatch(/45 m/u);
      expect(after).toMatch(/\n11:59–15:30 No location for 3 h 31 m\n/u);
      expect(before).not.toMatch(/15:30|No location for -/u);
      const stay = extracts(home).find((row) => row.unit.startsWith(`stay/${LOCATION}/`))!.content as unknown as StayContent;
      expect(stay.silences).toHaveLength(3);
      ARTIFACT.silences = { before, after };
    } finally {
      home.close();
    }
  });

  it("a phone's stay or trip that Motion shaped states Location's account alone, or a phone with no Motion source states Motion's", () => {
    const shaped = (deliveries: readonly Delivery[]) => {
      const home = newHome();
      try {
        landAll(home, deliveries);
        const document = JSON.parse(render(home, DAYS[0]!).json) as DayDocument;
        const pick = ["At Home", "Road vehicle, Home → Office, 1.4 km", "Walking at Office"];
        return {
          lines: document.atoms.filter((atom) => pick.includes(atom.text)).map((atom) => [atom.text, atom.accounts]),
          stays: [...new Set(document.facts.map((fact) => JSON.stringify(fact.from.accounts)))],
        };
      } finally {
        home.close();
      }
    };
    const both = ["location:local", "motion:local"];
    const day = bundles([phoneDay(DAYS[0]!, 0, mulberry32(5))]);
    expect(shaped(day)).toEqual({
      lines: [["At Home", both], ["Road vehicle, Home → Office, 1.4 km", both], ["Walking at Office", both]],
      stays: [JSON.stringify(both)],
    });
    const located = shaped(day.filter((delivery) => delivery.source === LOCATION));
    expect(located.lines).toContainEqual(["At Home", ["location:local"]]);
    expect(located.lines.map(([, accounts]) => accounts)).toEqual(located.lines.map(() => ["location:local"]));
    expect(located.stays).toEqual([JSON.stringify(["location:local"])]);
  });

  it("a rendered day drifts from its golden", () => {
    const home = newHome();
    try {
      landAll(home, dataset());
      for (const day of ["2026-09-19", DAYS[0]!, DAYS[1]!]) {
        const rendered = render(home, day);
        for (const [suffix, text] of [["day.txt", rendered.txt], ["day.json", rendered.json]] as const) {
          const golden = new URL(`${day}.${suffix}`, GOLDEN);
          if (UPDATE) writeFileSync(golden, text);
          expect(text, `${day}.${suffix}`).toBe(readFileSync(golden, "utf8"));
        }
      }
      pin(FAMILY, { physical: FED.physical, photos: FED.photos }, extracts(home));
    } finally {
      home.close();
    }
  });
});

describe("the order spots are asked about", () => {
  const DAY = 86_400_000;
  const NOW = Date.parse("2026-10-17T12:00:00Z");
  const spot = (name: number, days: number, longest: number, ageDays: number, worth = true): Spot => ({
    latitude: 38 + name / 100, longitude: -9, stays: days, days, hours: longest * days, longest_day_hours: longest,
    first_ms: NOW - (ageDays + days) * DAY, last_ms: NOW - ageDays * DAY, worth, ask_home: null, home_ask: null,
    key: `spot:${38 + name / 100},-9`,
  });
  const yesterday = spot(1, 1, 1.4, 1);
  const oldOneOff = spot(2, 3, 0.2, 900);
  const oldRegular = spot(3, 27, 0.1, 900);
  const recentRegular = spot(4, 21, 0.1, 11);
  const recentFew = spot(5, 4, 0.1, 11);
  const unworthy = spot(6, 1, 0.2, 0, false);
  const order = (list: Spot[], now = NOW) => askOrder(list, now).map((each) => each.latitude);

  it("A1–A4: worth naming only; fresh and long first, regulars kept high, many days before few", () => {
    const asked = order([oldOneOff, unworthy, recentFew, oldRegular, yesterday, recentRegular]);
    expect(asked).not.toContain(unworthy.latitude);
    expect(asked.indexOf(yesterday.latitude)).toBeLessThan(asked.indexOf(oldOneOff.latitude));
    expect(asked.indexOf(oldRegular.latitude)).toBeLessThan(asked.indexOf(recentFew.latitude));
    expect(asked.indexOf(recentRegular.latitude)).toBeLessThan(asked.indexOf(recentFew.latitude));
    expect(asked.at(-1)).toBe(oldOneOff.latitude);
  });

  it("A5–A6: the same order all day, and the same for equals", () => {
    const list = [oldOneOff, recentFew, oldRegular, yesterday, recentRegular];
    const morning = Date.parse("2026-10-17T00:30:00Z");
    expect(order(list, morning)).toEqual(order(list, morning + 10 * 3_600_000));
    const twin = { ...recentFew, latitude: recentFew.latitude - 0.001 };
    expect(order([recentFew, twin])).toEqual(order([twin, recentFew]));
  });
});

describe("the places a day names a stay by, and the spots", () => {
  const GOOGLE = "google-maps:person-a@example.com:lookup";
  const CAFE = offset(HOME, 2_000);
  const googleName = (placeId: string, name: string, point: Point): ReaderOutput =>
    ({ kind: "place", key: `google:${placeId}`, content: { type: "google.place", id: placeId, name, centre: { latitude: point.latitude, longitude: point.longitude } } });
  const carrying = (id: string, name: string, point: Point, ids: string[]): ReaderOutput =>
    ({ kind: "place", key: id, content: { type: "places.place", name, centre: { latitude: point.latitude, longitude: point.longitude }, radius_m: 120, ids } });
  const visit = (start: string, end: string, point: Point, placeId: string): ReaderOutput => ({
    kind: "place-visit", key: start.replace(/[-:]/gu, "").replace(".000", ""), time: { start_ms: Date.parse(start), end_ms: Date.parse(end), precision: "ms" },
    content: { type: "timeline.visit", content: { startTime: start, endTime: end,
      visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: placeId, placeLocation: `geo:${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
  });
  const phone = (legs: { at: Point; from: number; to: number }[]): ReaderOutput[] => {
    const rows: ReaderOutput[] = [];
    let sequence = 0;
    legs.forEach((leg, index) => {
      for (let ms = leg.from; ms <= leg.to; ms += 30_000) rows.push(fixRow(++sequence, ms, leg.at, 0));
      const next = legs[index + 1];
      if (next === undefined) return;
      for (let step = 1; step < 30; step++) {
        const share = step / 30;
        rows.push(fixRow(++sequence, leg.to + share * (next.from - leg.to), {
          latitude: leg.at.latitude + share * (next.at.latitude - leg.at.latitude), longitude: leg.at.longitude + share * (next.at.longitude - leg.at.longitude),
        }, 9));
      }
    });
    return rows;
  };
  const labelsOf = (home: TestHome) => home.read((view) => readLabels(view, HOME_UNIT, NETWORKED));

  it("9: a Google name draws a circle over the phone's stay, or tells an unnamed stay where it is", () => {
    const home = newHome();
    try {
      const base = dayBounds(DAYS[0]!, SETTINGS).start_ms;
      home.land(OWNER_PLACES, Date.UTC(2026, 8, 1), [ownerPlace("home", "Home", HOME)]);
      home.land(GOOGLE, Date.UTC(2026, 8, 1), [googleName("synthetic-place-c", "Synthetic Cafe", CAFE), googleName("synthetic-place-d", "Synthetic Deli", offset(CAFE, 100))]);
      landAll(home, bundles([{ location: phone([{ at: HOME, from: base + HOUR, to: base + 2 * HOUR }, { at: CAFE, from: base + 2 * HOUR + 10 * MINUTE, to: base + 3 * HOUR + 10 * MINUTE }]), motion: [] }]));
      const labels = labelsOf(home);
      expect(labels.place(CAFE.latitude, CAFE.longitude)).toBeUndefined();
      expect(labels.nearest(CAFE.latitude, CAFE.longitude)?.name).toBe("Home");
      const txt = render(home, DAYS[0]!, labels).txt;
      expect(txt).toMatch(/At an unnamed place 2\.0 km from Home \(still there at the last fix\)\n/u);
      expect(txt).not.toMatch(/Synthetic (Cafe|Deli)/u);
      ARTIFACT.google_names_no_circle = txt;
    } finally {
      home.close();
    }
  });

  it("10, 11: a Timeline visit stating an ID an owner place carries prints Google's name, or two places carrying one ID name it by the higher id", () => {
    const home = newHome();
    try {
      const office = offset(HOME, 1_500);
      home.land(OWNER_PLACES, Date.UTC(2026, 8, 1), [
        ownerPlace("home", "Home", HOME),
        carrying("office", "Office", office, ["google:synthetic-place-o"]),
        carrying("beta-place", "Beta Place", offset(HOME, 9_000), ["google:synthetic-place-x"]),
        carrying("alpha-place", "Alpha Place", offset(HOME, 6_000), ["google:synthetic-place-x"]),
      ]);
      home.land(GOOGLE, Date.UTC(2026, 8, 1), [
        googleName("synthetic-place-o", "Google's Office Name", office), googleName("synthetic-place-c", "Synthetic Cafe", CAFE),
      ]);
      home.land(TIMELINE, Date.UTC(2026, 8, 24), [
        visit("2026-09-23T06:00:00.000-04:00", "2026-09-23T08:00:00.000-04:00", offset(office, 40), "synthetic-place-o"),
        visit("2026-09-23T09:00:00.000-04:00", "2026-09-23T10:00:00.000-04:00", CAFE, "synthetic-place-c"),
        visit("2026-09-23T11:00:00.000-04:00", "2026-09-23T12:00:00.000-04:00", offset(HOME, 9_000), "synthetic-place-x"),
      ]);
      pass(home);
      const txt = render(home, DAYS[2]!, labelsOf(home)).txt;
      expect(txt).toMatch(/06:00–08:00 At Office \(stated by Timeline\)\n/u);
      expect(txt).toMatch(/09:00–10:00 At Synthetic Cafe \(stated by Timeline\)\n/u);
      expect(txt).toMatch(/11:00–12:00 At Alpha Place \(stated by Timeline\)\n/u);
      expect(txt).not.toMatch(/Google's Office Name|Beta Place/u);
      ARTIFACT.stated_ids = txt;
    } finally {
      home.close();
    }
  });

  it("14: a Timeline stay and a phone stay of the same hour count twice, or a spot holds a stay a place or a name holds", () => {
    const home = newHome();
    try {
      const spot = offset(HOME, 4_000);
      const lull = offset(HOME, 8_000);
      home.land(OWNER_PLACES, Date.UTC(2026, 8, 1), [ownerPlace("home", "Home", HOME)]);
      home.land(GOOGLE, Date.UTC(2026, 8, 1), [
        googleName("synthetic-place-n", "Near Name", offset(spot, 100)), googleName("synthetic-place-f", "Far Name", offset(spot, 300)),
        googleName("synthetic-place-c", "Synthetic Cafe", CAFE),
      ]);
      const base = dayBounds(DAYS[1]!, SETTINGS).start_ms;
      landAll(home, bundles([{ location: phone([
        { at: HOME, from: base + 2 * HOUR, to: base + 3 * HOUR },
        { at: spot, from: base + 3 * HOUR + 10 * MINUTE, to: base + 4 * HOUR + 10 * MINUTE },
        { at: lull, from: base + 4 * HOUR + 20 * MINUTE, to: base + 4 * HOUR + 40 * MINUTE },
        { at: HOME, from: base + 4 * HOUR + 50 * MINUTE, to: base + 5 * HOUR + 10 * MINUTE },
      ]), motion: [] }]));
      home.land(TIMELINE, Date.UTC(2026, 8, 24), [
        visit(new Date(base + 3 * HOUR + 10 * MINUTE).toISOString(), new Date(base + 4 * HOUR + 10 * MINUTE).toISOString(), offset(spot, 20), "synthetic-place-s"),
        visit("2026-09-23T09:00:00.000-04:00", "2026-09-23T10:00:00.000-04:00", CAFE, "synthetic-place-c"),
      ]);
      pass(home);
      const stays = extracts(home).map((row) => row.content as unknown as StayContent).filter((content) => content.kind === "stay");
      const found = home.read((view) => spots(stays, placeTable(view, HOME_UNIT), SETTINGS));
      const at = found.spots.find((each) => distanceMeters(each, spot) < 80)!;
      expect(at).toMatchObject({ stays: 2, days: 1, hours: 1, longest_day_hours: 1, worth: true });
      expect("suggestions" in at).toBe(false);
      expect(found.spots.find((each) => distanceMeters(each, lull) < 80)).toMatchObject({ stays: 1, worth: false });
      expect(found.spots.filter((each) => distanceMeters(each, CAFE) < 500 || distanceMeters(each, HOME) < 500)).toEqual([]);
      expect(found.spots).toHaveLength(2);
      expect(found.places.get("home")).toMatchObject({ stays: 2, days: 1 });
      ARTIFACT.spots = { places: Object.fromEntries(found.places) as unknown as Json, spots: found.spots as unknown as Json };
    } finally {
      home.close();
    }
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function onDay(lines: readonly DayLine[], day: string): DayLine[] {
  const { start_ms, end_ms } = dayBounds(day, SETTINGS);
  return lines.filter((line) => line.start_ms !== null &&
    (line.end_ms === null ? line.start_ms >= start_ms && line.start_ms < end_ms : line.start_ms < end_ms && line.end_ms > start_ms));
}

function shuffle<T>(items: readonly T[], seedValue: number): T[] {
  const random = mulberry32(seedValue);
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

function mulberry32(seedValue: number): () => number {
  let state = seedValue >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
