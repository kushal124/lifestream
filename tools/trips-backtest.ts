import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { addDays, civilDay, dayBounds, type DaySettings, type SourceRow, type Version, type Witness } from "@lifestreamprotocol/core";
import { physicalAdapters } from "../packages/connect/ios-app/adapter-physical.js";
import { hundred, rounded } from "../packages/families/physical/evidence.js";
import { readFix, readMotion } from "../packages/families/physical/phone.js";
import { isRepeat, MOTION_HOLD_MS, motionSpans, segment, shares, type Fix, type Motion, type Stay, type Trip } from "../packages/families/physical/segment.js";
import { distanceMeters, type Point } from "../packages/families/shared/places.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface Span { start_ms: number; end_ms: number }

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const AROUND_MS = 2 * MINUTE;
const STEPS = "HKQuantityTypeIdentifierStepCount";
const FLAGS = ["stationary", "walking", "running", "automotive", "cycling", "unknown"] as const;


async function door(route: string, again = true): Promise<Record<string, unknown>> {
  const machine = process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machine, "reader-token"), "utf8").trim();
  const response = await fetch(`${process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680"}${route}`, { headers: { authorization: `Bearer ${token}` } })
    .catch((error: Error & { cause?: { code?: string; message?: string } }) => {
      if (again && error.cause?.code === "ECONNRESET") return null;
      throw new Error(`${route}: ${error.cause?.code ?? ""} ${error.cause?.message ?? error.message}`);
    });
  if (response === null) return door(route, false);
  if (response.status === 404) return {};
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

async function all<T>(route: string, member: string): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  do {
    const page = await door(`${route}${route.includes("?") ? "&" : "?"}limit=1024${after === undefined ? "" : `&after=${after}`}`);
    items.push(...(page[member] as T[] ?? []));
    after = typeof page.next === "string" ? page.next : undefined;
  } while (after !== undefined);
  return items;
}

interface Served { source: string; kind: string; key: string; head: { version: string; start_ms: number | null; end_ms: number | null }; content: Json }

function versionOf(record: Served): Version {
  const version: Version = { id: record.head.version, kind: record.kind, key: record.key, content: record.content, text: "" };
  if (record.head.start_ms !== null) version.time = { start_ms: record.head.start_ms, precision: "ms" };
  return version;
}

async function records(source: string, kind: string, span: Span): Promise<Served[]> {
  return all<Served>(`/v1/records?source=${encodeURIComponent(source)}&kind=${kind}&from_ms=${span.start_ms}&to_ms=${span.end_ms}`, "records");
}


export interface Item extends Span {
  kind: "stay" | "trip";
  from: Point | null;
  to: Point | null;
  distance_m: number;
  legs: { mode: string; distance_m: number }[];
}

function servedItem(content: Record<string, Json>): Item | null {
  const kind = content.kind;
  if ((kind !== "stay" && kind !== "trip") || typeof content.start_ms !== "number" || typeof content.end_ms !== "number") return null;
  const point = (value: Json | undefined): Point | null => {
    const where = value as { latitude?: number; longitude?: number } | null | undefined;
    return typeof where?.latitude === "number" && typeof where.longitude === "number" ? { latitude: where.latitude, longitude: where.longitude } : null;
  };
  const legs = Array.isArray(content.legs) ? (content.legs as { mode: string; distance_m: number }[]).map(({ mode, distance_m }) => ({ mode, distance_m })) : [];
  return kind === "stay"
    ? { kind, start_ms: content.start_ms, end_ms: content.end_ms, from: point(content.centre), to: point(content.centre), distance_m: 0, legs: [] }
    : { kind, start_ms: content.start_ms, end_ms: content.end_ms, from: point(content.from), to: point(content.to), distance_m: Number(content.distance_m), legs };
}

function stayItem(stay: Stay): Item {
  const centre = rounded(stay.centre);
  return { kind: "stay", start_ms: stay.start_ms, end_ms: stay.end_ms, from: centre, to: centre, distance_m: 0, legs: [] };
}

function tripItem(trip: Trip): Item {
  return { kind: "trip", start_ms: trip.start_ms, end_ms: trip.end_ms, from: rounded(trip.from), to: rounded(trip.to), distance_m: hundred(trip.distance_m),
    legs: trip.legs.map((leg) => ({ mode: leg.mode, distance_m: hundred(leg.distance_m) })) };
}


export type Rule = "repeats" | "still" | "repeats+still";
export interface TripChange { before: Item; after: Item[]; rule: Rule }
export interface StayChange { before: Item; after: Item | null; moved_m: number | null }
export interface Moved { before: Item; after: Item; moved_m: number; rule: Rule }
export interface Edges { served: Item[]; lane: Item[] }
export interface Comparison { changed: TripChange[]; added: Item[]; stays: StayChange[]; moved: Moved[]; edges: Edges }

export const MOVED_M = 10;

const overlaps = (left: Span, right: Span) => left.start_ms < right.end_ms && right.start_ms < left.end_ms;
const samePoint = (left: Point | null, right: Point | null) => left?.latitude === right?.latitude && left?.longitude === right?.longitude;
const sameTrip = (left: Item, right: Item) => left.start_ms === right.start_ms && left.end_ms === right.end_ms && left.distance_m === right.distance_m &&
  left.legs.length === right.legs.length && left.legs.every((leg, index) => leg.mode === right.legs[index]!.mode && leg.distance_m === right.legs[index]!.distance_m);
const sameTrips = (left: readonly Item[], right: readonly Item[]) => left.length === right.length && left.every((item, index) => sameTrip(item, right[index]!));
const sameItem = (left: Item, right: Item) => left.kind === right.kind && sameTrip(left, right) && samePoint(left.from, right.from) && samePoint(left.to, right.to);
const displacement = (left: Item, right: Item) => left.from === null || left.to === null || right.from === null || right.to === null ? null
  : Math.max(distanceMeters(left.from, right.from), distanceMeters(left.to, right.to));
const ruleOf = (repeats: boolean, still: boolean): Rule => (repeats && still ? "repeats+still" : repeats ? "repeats" : "still");

function stayOver(items: readonly Item[], before: Item): Item | null {
  return items.find((stay) => stay.kind === "stay" && stay.start_ms <= before.start_ms && before.start_ms < Math.max(stay.end_ms, stay.start_ms + 1)) ?? null;
}

function counterpart(items: readonly Item[], before: Item): Item | null {
  return before.kind === "stay" ? stayOver(items, before) : items.find((trip) => trip.kind === "trip" && trip.start_ms === before.start_ms && trip.end_ms === before.end_ms) ?? null;
}

export function compare(served: readonly Item[], lane: readonly Item[], repeatsOnly: readonly Item[], range: Span): Comparison {
  const inside = (item: Item) => item.start_ms >= range.start_ms && item.end_ms <= range.end_ms;
  const meets = (item: Item) => overlaps(item, range);
  const edges: Edges = { served: [], lane: [] };
  const toEdge = (before: Item) => {
    if (!edges.served.includes(before)) edges.served.push(before);
  };
  const trips = (items: readonly Item[]) => items.filter((item) => item.kind === "trip" && meets(item));
  const laneTrips = trips(lane);
  const aloneTrips = trips(repeatsOnly);

  const changed: TripChange[] = [];
  for (const before of served.filter((item) => item.kind === "trip" && inside(item))) {
    const after = laneTrips.filter((trip) => overlaps(trip, before));
    if (sameTrips(after, [before])) continue;
    if (!after.every(inside)) {
      toEdge(before);
      continue;
    }
    const alone = aloneTrips.filter((trip) => overlaps(trip, before));
    changed.push({ before, after, rule: ruleOf(!sameTrips(alone, [before]), !sameTrips(after, alone)) });
  }
  const added = laneTrips.filter((trip) => inside(trip) && !served.some((before) => before.kind === "trip" && overlaps(trip, before)));

  const stays: StayChange[] = [];
  const moved: Moved[] = [];
  for (const before of served.filter(inside)) {
    const after = counterpart(lane, before);
    if (after !== null && !inside(after)) {
      if (!sameItem(after, before)) toEdge(before);
      continue;
    }
    const moved_m = after === null ? null : displacement(after, before);
    if (before.kind === "stay" && (after === null || after.start_ms !== before.start_ms || after.end_ms !== before.end_ms)) stays.push({ before, after, moved_m });
    if (after === null || moved_m === null || moved_m <= MOVED_M) continue;
    const alone = counterpart(repeatsOnly, before);
    const aloneMoved = alone === null ? Infinity : displacement(alone, before) ?? Infinity;
    const stillMoved = alone === null ? Infinity : displacement(after, alone) ?? Infinity;
    const repeats = aloneMoved > MOVED_M;
    const still = stillMoved > MOVED_M;
    moved.push({ before, after, moved_m, rule: ruleOf(repeats || !still, still || !repeats) });
  }

  for (const item of served) if (meets(item) && !inside(item) && !lane.some((other) => sameItem(other, item))) toEdge(item);
  edges.lane = lane.filter((item) => meets(item) && !inside(item) && !served.some((other) => sameItem(other, item)));
  return { changed, added, stays, moved, edges };
}

export function gatedLength(fixes: readonly Fix[]): number {
  let total = 0;
  let counted: Fix | undefined;
  for (const fix of fixes) {
    if (counted === undefined) counted = fix;
    else if (distanceMeters(counted, fix) > Math.max(counted.accuracy_m, fix.accuracy_m)) {
      total += distanceMeters(counted, fix);
      counted = fix;
    }
  }
  return total;
}


interface Phone { location: SourceRow; motion: SourceRow | null }

async function phones(): Promise<Phone[]> {
  const motions = await all<SourceRow>("/v1/sources?product=motion", "sources");
  return (await all<SourceRow>("/v1/sources?product=location", "sources")).map((location) => ({
    location, motion: motions.find((motion) => motion.account === location.account && motion.copy === location.copy) ?? null,
  }));
}

type ServedRow = { unit: string; content: Record<string, Json> };

async function servedItems(phone: Phone, span: Span): Promise<Item[]> {
  const rows = new Map<string, ServedRow>();
  for (let from = Math.round(span.start_ms); from < span.end_ms; from += 3 * DAY) {
    const to = Math.min(from + 3 * DAY, Math.round(span.end_ms));
    for (const row of await all<ServedRow>(`/v1/extracts?family=physical&from_ms=${from}&to_ms=${to}`, "extracts")) rows.set(row.unit, row);
  }
  return [...rows.values()].filter((row) => row.content.source === phone.location.id).flatMap((row) => servedItem(row.content) ?? [])
    .sort((left, right) => left.start_ms - right.start_ms);
}

async function anchorOf(phone: Phone, start_ms: number): Promise<number> {
  for (let reach = 6 * 60 * MINUTE; reach <= 64 * DAY; reach *= 2) {
    const ended = (await servedItems(phone, { start_ms: start_ms - reach, end_ms: start_ms })).filter((item) => item.kind === "stay" && item.end_ms < start_ms);
    if (ended.length >= 2) return ended.at(-2)!.start_ms;
  }
  return start_ms - 64 * DAY;
}

async function measurePhone(phone: Phone, days: readonly string[], settings: DaySettings, health: readonly string[]): Promise<Record<string, Json>> {
  const window = { start_ms: dayBounds(days[0]!, settings).start_ms, end_ms: dayBounds(days.at(-1)!, settings).end_ms };
  const fixed = await door(`/v1/records?source=${encodeURIComponent(phone.location.id)}&kind=fix&from_ms=${window.start_ms}&to_ms=${window.end_ms}&limit=1`);
  const any = Array.isArray(fixed.records) && fixed.records.length > 0;
  const read = { start_ms: any ? await anchorOf(phone, window.start_ms) : window.start_ms, end_ms: Math.min(window.end_ms + DAY, Date.now()) };
  const slack = { start_ms: read.start_ms - MOTION_HOLD_MS - 30 * MINUTE, end_ms: read.end_ms + 30 * MINUTE };
  const location = physicalAdapters.location!.physical as Witness;
  const motion = physicalAdapters.motion!.physical as Witness;
  const fixes = (await records(phone.location.id, "fix", slack)).flatMap((record) => readFix(location, phone.location, versionOf(record)) ?? [])
    .filter((fix) => fix.at_ms >= read.start_ms && fix.at_ms < read.end_ms).sort((left, right) => left.at_ms - right.at_ms || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  const readings = phone.motion === null ? [] : (await records(phone.motion.id, "motion", slack))
    .flatMap((record) => readMotion(motion, phone.motion!, versionOf(record)) ?? []).filter((each) => each.at_ms >= read.start_ms - MOTION_HOLD_MS && each.at_ms < read.end_ms);
  const motions = motionSpans(readings);
  const lane = segment(fixes, motions);
  const repeatsOnly = segment(fixes, motionSpans(readings.map((each) => ({ ...each, stationary: false }))));

  const served = await servedItems(phone, read);
  const laneItems = [...lane.stays.map(stayItem), ...lane.trips.map(tripItem)].sort((left, right) => left.start_ms - right.start_ms);
  const aloneItems = [...repeatsOnly.stays.map(stayItem), ...repeatsOnly.trips.map(tripItem)];
  const { changed, added, stays, moved, edges } = compare(served, laneItems, aloneItems, window);

  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: settings.zone, month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  const at = (ms: number) => clock.format(ms);
  const km = (meters: number) => `${(meters / 1_000).toFixed(1)} km`;
  const line = (item: Item) => `${at(item.start_ms)} to ${at(item.end_ms)}: ${item.kind === "stay" ? "stay"
    : `trip ${km(item.distance_m)}, ${item.legs.map((leg) => `${leg.mode} ${km(leg.distance_m)}`).join(", ") || "no leg"}`}`;
  const apart = (item: Item) => (item.from === null || item.to === null ? null : Math.round(distanceMeters(item.from, item.to)));

  const changes: Json[] = [];
  for (const change of changed) {
    const span = { start_ms: change.before.start_ms, end_ms: change.before.end_ms };
    changes.push({
      rule: change.rule, before: line(change.before), after: change.after.length === 0 ? "none: one stay" : change.after.map(line),
      ends_apart_m: apart(change.before), motion: motionAround(motions, span, at), steps: await steps(health, span),
    });
  }
  const inside = (item: Item) => item.start_ms >= window.start_ms && item.end_ms <= window.end_ms;
  const count = (items: readonly Item[], kind: Item["kind"]) => items.filter((item) => item.kind === kind && inside(item)).length;
  const kept = laneItems.filter((trip) => trip.kind === "trip" && inside(trip) && !changed.some((change) => change.after.includes(trip)) && !added.includes(trip))
    .map((trip) => keptColumns(trip, fixes, motions, line));
  return {
    location: phone.location.id, motion: phone.motion?.id ?? null, read_from: at(read.start_ms), fixes: fixes.length, readings: readings.length,
    served: { stays: count(served, "stay"), trips: count(served, "trip") },
    lane: { stays: count(laneItems, "stay"), trips: count(laneItems, "trip") },
    trips_changed: changes,
    trips_added: added.map((trip) => ({ line: line(trip), ends_apart_m: apart(trip) })),
    stays_changed: stays.map((change) => ({ before: line(change.before), after: change.after === null ? "none" : line(change.after),
      centre_moved_m: change.moved_m === null ? null : Math.round(change.moved_m) })),
    moved: moved.map((each) => ({ rule: each.rule, before: line(each.before), after: line(each.after), moved_m: Math.round(each.moved_m) })),
    edges_served: edges.served.map(line),
    edges_lane: edges.lane.map(line),
    repeats: repeatsByDay(fixes, days, settings),
    trips_kept: kept,
  };
}

function motionAround(motions: readonly Motion[], span: Span, at: (ms: number) => string): Record<string, Json> {
  const from = span.start_ms - AROUND_MS;
  const to = span.end_ms + AROUND_MS;
  const counts: Record<string, number> = {};
  const said: Json[] = [];
  let still: number | null = null;
  let longest = 0;
  for (const motion of motions) {
    if (motion.end_ms <= from || motion.at_ms >= to) continue;
    const flags = FLAGS.filter((flag) => motion[flag]).join("+") || "none";
    counts[flags] = (counts[flags] ?? 0) + 1;
    if (flags !== "stationary" && flags !== "none") said.push(`${at(motion.at_ms)} ${flags}`);
    if (flags === "stationary" && motion.at_ms >= from) {
      if (still !== null) longest = Math.max(longest, motion.at_ms - still);
      still = motion.at_ms;
    }
  }
  return { readings: counts, said, longest_still_wait_s: still === null ? null : Math.round(longest / 1_000) };
}

async function steps(health: readonly string[], span: Span): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const source of health) {
    for (const record of await records(source, "sample", span)) {
      const content = record.content as Record<string, Json>;
      if (content.sample_type !== STEPS) continue;
      const start = Date.parse(String(content.start));
      const end = Date.parse(String(content.end));
      const share = end > start ? Math.max(0, Math.min(end, span.end_ms) - Math.max(start, span.start_ms)) / (end - start) : 1;
      const name = String(content.source_name);
      out[name] = Math.round((out[name] ?? 0) + Number(content.value) * share);
    }
  }
  return out;
}

function keptColumns(trip: Item, fixes: readonly Fix[], motions: readonly Motion[], line: (item: Item) => string): Record<string, Json> {
  const span = trip.end_ms - trip.start_ms;
  const share = shares(motions, trip.start_ms, trip.end_ms);
  const heard = heardMs(motions, trip);
  const walking = (share.walking + share.running) * span;
  const inside = fixes.filter((fix) => fix.at_ms >= trip.start_ms && fix.at_ms <= trip.end_ms);
  const walkUnheard = trip.legs.some((leg) => leg.mode === "walk") && heard >= span / 2 && walking <= heard / 2;
  return {
    line: line(trip), heard_share: round(span === 0 ? 0 : heard / span), walking_share_of_heard: heard === 0 ? null : round(walking / heard),
    walk_motion_says_otherwise: walkUnheard, length_km: round(trip.distance_m / 1_000), gated_length_km: round(gatedLength(inside) / 1_000),
  };
}

function heardMs(motions: readonly Motion[], span: Span): number {
  let total = 0;
  for (const motion of motions) total += Math.max(0, Math.min(span.end_ms, motion.end_ms) - Math.max(span.start_ms, motion.at_ms));
  return total;
}

function repeatsByDay(fixes: readonly Fix[], days: readonly string[], settings: DaySettings): Json[] {
  const counts = new Map(days.map((day) => [day, { fixes: 0, repeats: 0 }]));
  fixes.forEach((fix, index) => {
    const count = counts.get(civilDay(fix.at_ms, settings));
    if (count === undefined) return;
    count.fixes++;
    if (isRepeat(fixes, index)) count.repeats++;
  });
  return [...counts].map(([day, count]) => ({ day, ...count }));
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}


function render(report: Record<string, Json>): string {
  const out: string[] = [];
  const line = (value: Json): string => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).map(([key, inner]) => `${key} ${inner !== null && typeof inner === "object" ? JSON.stringify(inner) : String(inner)}`).join("  ")
    : JSON.stringify(value);
  for (const phone of report.phones as Record<string, Json>[]) {
    out.push(`${phone.location}`);
    for (const [key, value] of Object.entries(phone)) {
      if (Array.isArray(value)) {
        out.push(`  ${key} (${value.length})`);
        for (const row of value) out.push(`    ${line(row)}`);
      } else if (key !== "location") out.push(`  ${key}: ${line(value)}`);
    }
    out.push("");
  }
  return out.join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const out = option("--out");
  const count = Number(option("--days"));
  if (out === undefined || !Number.isSafeInteger(count) || count < 1 || args.length !== 4) {
    throw new Error("usage: npx tsx tools/trips-backtest.ts --days <N> --out <file.json>, a path outside the checkout");
  }
  const checkout = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const target = resolve(out);
  let parent = dirname(target);
  try {
    parent = realpathSync(parent);
  } catch {
    throw new Error(`${dirname(target)} does not exist`);
  }
  if (parent === checkout || parent.startsWith(`${checkout}${sep}`)) throw new Error(`the artifact holds the person's movements: write it outside ${checkout}`);

  const listed = await all<{ day: string }>("/v1/days", "days");
  const newest = listed.at(-1)?.day;
  if (newest === undefined) throw new Error("the home has no day files yet");
  const head = await door(`/v1/days/${newest}?file=json`);
  const settings: DaySettings = { zone: String(head.zone), day_start_hour: Number(head.day_start_hour) };
  const yesterday = addDays(civilDay(Date.now(), settings), -1);
  const days = Array.from({ length: count }, (_, index) => addDays(yesterday, index - count + 1));
  const health = (await all<SourceRow>("/v1/sources?product=apple-health", "sources")).map((source) => source.id);
  const report: Record<string, Json> = { days: { first: days[0]!, last: days.at(-1)!, ...settings }, phones: [] };
  for (const phone of await phones()) (report.phones as Json[]).push(await measurePhone(phone, days, settings, health));
  writeFileSync(target, `${JSON.stringify(report, null, 1)}\n`);
  process.stdout.write(`${render(report)}artifact: ${target}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
