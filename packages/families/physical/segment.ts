import { distanceMeters, PLACE_REACH_M, type Point } from "../shared/places.js";

export const STAY_MINIMUM_MS = 5 * 60_000;
export const FLIGHT_MINIMUM_M = 20_000;
const TRAFFIC_PAUSE_CEILING_MS = 15 * 60_000;
const TRAFFIC_PAUSE_WALKING_CEILING_MS = 60_000;
const FIX_SILENCE_MINIMUM_MS = 3 * 60_000;
const GONE_MINIMUM_MS = 60_000;
const STILL_HEARD_MS = 2 * 60_000;
const STILL_JUMP_CEILING_M = 100;
const JUMP_SHARE = 0.75;
export const KEPT_SILENCE_MS = 30 * 60_000;
const MOTION_MOVEMENT_CLOCK_MS = 2 * 60_000;
export const BOUT_WINDOW_MS = 10 * 60_000;
const BOUT_WALKING_SHARE = 0.7;
const MOTION_MAJORITY_SHARE = 0.5;
const LEG_FOLD_MS = 90_000;
const SPEED_SMOOTHING_MS = 90_000;
const FLIGHT_ALTITUDE_M = 2_500;
const FLIGHT_SPEED_MPS = 60;
export const WALK_SPEED_MIN_MPS = 0.4;
const RUN_SPEED_MIN_MPS = 2.3;
const RUN_SPEED_MAX_MPS = 4;
const CYCLE_SPEED_MIN_MPS = 3.5;
const CYCLE_SPEED_MAX_MPS = 8;
const ROAD_SPEED_MIN_MPS = 6;
const ROAD_MEAN_SPEED_MPS = 4;
export const MOTION_HOLD_MS = 30 * 60_000;

export interface Fix extends Point {
  key: string;
  at_ms: number;
  speed_mps: number | null;
  altitude_m: number;
  accuracy_m: number;
}

export interface Motion {
  key: string;
  at_ms: number;
  end_ms: number;
  stationary: boolean;
  walking: boolean;
  running: boolean;
  automotive: boolean;
  cycling: boolean;
  unknown: boolean;
}

export type Level = "observed" | "inferred";
export type Mode = "flight" | "road_vehicle" | "cycle" | "run" | "walk" | "unclear" | "unknown";
export type Shares = Record<"stationary" | "walking" | "running" | "automotive" | "cycling" | "unknown", number>;

export interface Span { start_ms: number; end_ms: number }

export interface Stay extends Span {
  centre: Point;
  open: boolean;
  level: Level;
  silences: Span[];
  bouts: Span[];
  before: Fix | null;
  after: Fix | null;
}

export interface Leg extends Span { mode: Mode; distance_m: number; speed_median: number; shares: Shares }

export interface Trip extends Span {
  from: Point;
  to: Point;
  distance_m: number;
  legs: Leg[];
}


interface Group { fixes: Fix[]; first: number; last: number; centre: Point }

export function segment(fixes: readonly Fix[], motions: readonly Motion[]): { stays: Stay[]; trips: Trip[] } {
  const ordered = [...fixes].sort(byFix);
  const groups = joinRuns(candidates(ordered).filter((group) => !isTrafficPause(group, ordered, motions)), ordered, motions);
  const stays: Stay[] = [];
  const trips: Trip[] = [];
  for (let index = 0; index < groups.length; index++) {
    const group = groups[index]!;
    const next = groups[index + 1];
    const first = group.fixes[0]!;
    const last = group.fixes.at(-1)!;
    const firstAway = ordered[group.last + 1];
    const silences = samePlaceSilences(group.fixes);
    const moved = firstAway === undefined ? null : movementStart(motions, last.at_ms, firstAway.at_ms);
    if (moved !== null) silences.push({ start_ms: last.at_ms, end_ms: moved });
    const departure = moved ?? last.at_ms;
    stays.push({ centre: group.centre, start_ms: first.at_ms, end_ms: departure, open: firstAway === undefined,
      level: silences.length === 0 ? "observed" : "inferred", silences, bouts: walkingBouts(first.at_ms, departure, motions),
      before: ordered[group.first - 1] ?? null, after: firstAway ?? null });
    if (next === undefined) continue;
    const tripFixes = ordered.slice(group.last, next.first + 1).filter((fix) => fix.at_ms >= last.at_ms && fix.at_ms <= next.fixes[0]!.at_ms);
    trips.push(buildTrip(group.centre, next.centre, departure, next.fixes[0]!.at_ms, tripFixes, motions));
  }
  return { stays, trips };
}


function leaves(centre: Point, fix: Fix): boolean {
  return distanceMeters(centre, fix) - fix.accuracy_m > PLACE_REACH_M;
}

export function isRepeat(fixes: readonly Fix[], index: number): boolean {
  const fix = fixes[index];
  const before = fixes[index - 1];
  return fix !== undefined && before !== undefined && fix.latitude === before.latitude && fix.longitude === before.longitude &&
    fix.accuracy_m === before.accuracy_m;
}

const statements = new WeakMap<readonly Fix[], { first: Int32Array; last: Int32Array }>();

function statementOf(fixes: readonly Fix[], index: number): { first: number; last: number } {
  let found = statements.get(fixes);
  if (found === undefined) {
    const first = new Int32Array(fixes.length);
    const last = new Int32Array(fixes.length);
    for (let at = 0; at < fixes.length; at++) first[at] = isRepeat(fixes, at) ? first[at - 1]! : at;
    for (let at = fixes.length - 1; at >= 0; at--) last[at] = isRepeat(fixes, at + 1) ? last[at + 1]! : at;
    statements.set(fixes, found = { first, last });
  }
  return { first: found.first[index]!, last: found.last[index]! };
}

function isStray(fixes: readonly Fix[], index: number): boolean {
  const fix = fixes[index];
  if (fix === undefined) return false;
  const { first, last } = statementOf(fixes, index);
  const before = fixes[first - 1];
  const after = fixes[last + 1];
  if (before === undefined || after === undefined) return false;
  if (last > first && after.at_ms - before.at_ms >= GONE_MINIMUM_MS) return false;
  const agree = (left: Fix, right: Fix) => distanceMeters(left, right) <= left.accuracy_m + right.accuracy_m;
  return agree(before, after) && !agree(before, fix) && !agree(fix, after);
}

function candidates(fixes: readonly Fix[]): Group[] {
  const out: Group[] = [];
  let open: { first: number; members: Fix[]; sum: Point; count: number; centre: Point } | null = null;
  const close = (last: number) => {
    if (open !== null && open.members.at(-1)!.at_ms - open.members[0]!.at_ms >= STAY_MINIMUM_MS) {
      out.push({ fixes: open.members, first: open.first, last, centre: open.centre });
    }
  };
  fixes.forEach((fix, index) => {
    if (open !== null) {
      if (!leaves(open.centre, fix)) {
        open.members.push(fix);
        open.sum = { latitude: open.sum.latitude + fix.latitude, longitude: open.sum.longitude + fix.longitude };
        open.count++;
        open.centre = { latitude: open.sum.latitude / open.count, longitude: open.sum.longitude / open.count };
        return;
      }
      if (isStray(fixes, index)) {
        open.members.push(fix);
        return;
      }
      close(index - 1);
    }
    open = { first: index, members: [fix], sum: { latitude: fix.latitude, longitude: fix.longitude }, count: 1, centre: { latitude: fix.latitude, longitude: fix.longitude } };
  });
  close(fixes.length - 1);
  return out;
}

function joinRuns(groups: readonly Group[], fixes: readonly Fix[], motions: readonly Motion[]): Group[] {
  const out: Group[][][] = [];
  for (const group of groups) {
    const stay = out.at(-1);
    const place = stay?.at(-1);
    const previous = place?.at(-1);
    if (previous !== undefined && oneStay(previous, group, fixes)) place!.push(group);
    else if (previous !== undefined && stillStep(previous, group, fixes, motions)) stay!.push([group]);
    else out.push([[group]]);
  }
  return out.map((stay) => {
    const places = stay.map((runs) => onePlace(runs, fixes));
    if (places.length === 1) return places[0]!;
    const span = (place: Group) => place.fixes.at(-1)!.at_ms - place.fixes[0]!.at_ms;
    const longest = places.reduce((best, place) => (span(place) > span(best) ? place : best));
    const first = places[0]!.first;
    const last = places.at(-1)!.last;
    return { first, last, fixes: fixes.slice(first, last + 1), centre: longest.centre };
  });
}

function onePlace(runs: readonly Group[], fixes: readonly Fix[]): Group {
  if (runs.length === 1) return runs[0]!;
  const first = runs[0]!.first;
  const last = runs.at(-1)!.last;
  const members = fixes.slice(first, last + 1);
  const kept = members.filter((_, offset) => !isStray(fixes, first + offset));
  const centre = { latitude: kept.reduce((sum, fix) => sum + fix.latitude, 0) / kept.length, longitude: kept.reduce((sum, fix) => sum + fix.longitude, 0) / kept.length };
  return { first, last, fixes: members, centre };
}

function oneStay(left: Group, right: Group, fixes: readonly Fix[]): boolean {
  if (distanceMeters(left.centre, right.centre) > PLACE_REACH_M) return false;
  if (right.fixes[0]!.at_ms - left.fixes.at(-1)!.at_ms < GONE_MINIMUM_MS) return true;
  for (let index = left.last + 1; index < right.first; index++) {
    const fix = fixes[index]!;
    if (leaves(left.centre, fix) && leaves(right.centre, fix) && !isStray(fixes, index)) return false;
  }
  return true;
}

function stillStep(left: Group, right: Group, fixes: readonly Fix[], motions: readonly Motion[]): boolean {
  if (distanceMeters(left.centre, right.centre) > STILL_JUMP_CEILING_M) return false;
  const from = jumpFrom(left, right, fixes);
  if (from === null) return false;
  for (let index = Math.min(from, left.last); index <= right.first; index++) {
    if (distanceMeters(left.centre, fixes[index]!) > STILL_JUMP_CEILING_M) return false;
  }
  return heardStill(motions, Math.min(fixes[from]!.at_ms, left.fixes.at(-1)!.at_ms), right.fixes[0]!.at_ms);
}

function jumpFrom(left: Group, right: Group, fixes: readonly Fix[]): number | null {
  for (let index = right.first - 1; index >= left.first; index--) {
    if (distanceMeters(left.centre, fixes[index]!) > PLACE_REACH_M) continue;
    const from = fixes[index]!;
    const to = fixes[index + 1]!;
    const took = to.at_ms - from.at_ms;
    const jumped = distanceMeters(from, to);
    const most = JUMP_SHARE * distanceMeters(left.centre, right.centre);
    return took < GONE_MINIMUM_MS && jumped > RUN_SPEED_MAX_MPS * (took / 1_000) && jumped >= most ? index : null;
  }
  return null;
}

function heardStill(motions: readonly Motion[], start: number, end: number): boolean {
  let heard: number | null = null;
  let across = false;
  for (const motion of overlapping(motions, start - STILL_HEARD_MS, end + STILL_HEARD_MS)) {
    if (moves(motion)) return false;
    if (across || !motion.stationary || motion.unknown || motion.at_ms < start - STILL_HEARD_MS) continue;
    if (heard === null ? motion.at_ms > start : motion.at_ms - heard > STILL_HEARD_MS) return false;
    heard = motion.at_ms;
    across = heard >= end;
  }
  return across;
}

function moves(motion: Motion): boolean {
  return motion.walking || motion.running || motion.cycling || motion.automotive;
}

function isTrafficPause(group: Group, fixes: readonly Fix[], motions: readonly Motion[]): boolean {
  const first = group.fixes[0]!;
  const last = group.fixes.at(-1)!;
  if (last.at_ms - first.at_ms >= TRAFFIC_PAUSE_CEILING_MS) return false;
  const before = fixes[group.first - 1];
  const after = fixes[group.last + 1];
  if (before === undefined || after === undefined) return false;
  const walking = motionDuration(motions, first.at_ms, last.at_ms, (motion) => motion.walking || motion.running);
  if (walking > (last.at_ms - first.at_ms) * MOTION_MAJORITY_SHARE) return true;
  return walking < TRAFFIC_PAUSE_WALKING_CEILING_MS && vehicleBetween(before, first, motions) && vehicleBetween(last, after, motions);
}

function vehicleBetween(left: Fix, right: Fix, motions: readonly Motion[]): boolean {
  if (right.at_ms <= left.at_ms) return false;
  if (shares(motions, left.at_ms, right.at_ms).automotive > MOTION_MAJORITY_SHARE) return true;
  const mean = distanceMeters(left, right) / ((right.at_ms - left.at_ms) / 1_000);
  return (right.speed_mps ?? mean) >= ROAD_SPEED_MIN_MPS || mean >= ROAD_MEAN_SPEED_MPS;
}

function samePlaceSilences(fixes: readonly Fix[]): Span[] {
  const out: Span[] = [];
  for (let index = 1; index < fixes.length; index++) {
    if (fixes[index]!.at_ms - fixes[index - 1]!.at_ms >= FIX_SILENCE_MINIMUM_MS) out.push({ start_ms: fixes[index - 1]!.at_ms, end_ms: fixes[index]!.at_ms });
  }
  return out;
}

function movementStart(motions: readonly Motion[], start: number, end: number): number | null {
  if (end - start < FIX_SILENCE_MINIMUM_MS) return null;
  let runStart: number | null = null;
  let runEnd: number | null = null;
  let began: number | null = null;
  let heard = start;
  for (const motion of overlapping(motions, start, end)) {
    const from = Math.max(start, motion.at_ms);
    const to = Math.min(end, motion.end_ms);
    if (to <= from) continue;
    if (from > heard) began = null;
    heard = to;
    if (!moves(motion)) {
      runStart = runEnd = null;
      continue;
    }
    if (runStart === null || runEnd === null || from > runEnd) runStart = from;
    runEnd = Math.max(runEnd ?? from, to);
    if (began === null && runEnd - runStart >= MOTION_MOVEMENT_CLOCK_MS) began = runStart;
  }
  return heard >= end ? began : null;
}

function walkingBouts(start: number, end: number, motions: readonly Motion[]): Span[] {
  if (end - start < BOUT_WINDOW_MS) return [];
  const starts = new Set<number>([start, end - BOUT_WINDOW_MS]);
  const clamp = (value: number) => Math.max(start, Math.min(end - BOUT_WINDOW_MS, value));
  for (const motion of overlapping(motions, start, end)) {
    for (const boundary of [motion.at_ms, motion.end_ms]) {
      starts.add(clamp(boundary));
      starts.add(clamp(boundary - BOUT_WINDOW_MS));
    }
  }
  const bouts: Span[] = [];
  for (const from of [...starts].sort((left, right) => left - right)) {
    const share = shares(motions, from, from + BOUT_WINDOW_MS);
    if (share.walking + share.running <= BOUT_WALKING_SHARE) continue;
    const previous = bouts.at(-1);
    if (previous !== undefined && from <= previous.end_ms) previous.end_ms = Math.max(previous.end_ms, from + BOUT_WINDOW_MS);
    else bouts.push({ start_ms: from, end_ms: from + BOUT_WINDOW_MS });
  }
  return bouts.filter((bout) => motionDuration(motions, bout.start_ms, bout.end_ms, (motion) => motion.walking || motion.running) >= BOUT_WINDOW_MS);
}


interface Sample extends Span { distance_m: number; speed_mps: number; altitude_m: number; silent: boolean }
interface Working { samples: Sample[]; leg: Leg }

function buildTrip(from: Point, to: Point, start: number, end: number, fixes: readonly Fix[], motions: readonly Motion[]): Trip {
  const stretches: Sample[][] = [];
  for (const sample of speedSamples(fixes, start, end, motions)) {
    const last = stretches.at(-1);
    if (last !== undefined && last[0]!.silent === sample.silent) last.push(sample);
    else stretches.push([sample]);
  }
  const silent = (stretch: Sample[]) => stretch[0]!.silent || (stretches.length > 1 && stretch.at(-1)!.end_ms - stretch[0]!.start_ms < LEG_FOLD_MS);
  const legs: Leg[] = [];
  let unknown: Sample[] = [];
  const close = () => {
    if (unknown.length === 0) return;
    const span = { start_ms: unknown[0]!.start_ms, end_ms: unknown.at(-1)!.end_ms };
    legs.push({ ...span, mode: "unknown", distance_m: unknown.reduce((sum, sample) => sum + sample.distance_m, 0), speed_median: 0,
      shares: shares(motions, span.start_ms, span.end_ms) });
    unknown = [];
  };
  for (const stretch of stretches) {
    if (silent(stretch)) unknown.push(...stretch);
    else {
      close();
      legs.push(...movedLegs(stretch, motions));
    }
  }
  close();
  if (legs.length === 0) legs.push({ start_ms: start, end_ms: end, mode: "unclear", distance_m: 0, speed_median: 0, shares: shares(motions, start, end) });
  return { start_ms: start, end_ms: end, from, to, distance_m: pathDistance(fixes), legs };
}

function movedLegs(stretch: readonly Sample[], motions: readonly Motion[]): Leg[] {
  const samples = smooth(stretch);
  const legs = foldShortLegs(samples, runs(samples, motions)).map((part) => combine([{ samples: samples.slice(part.from, part.to) }], part.mode, motions));
  const roads = legs.map((leg, index) => {
    const { speed_median, shares: share } = leg.leg;
    if (speed_median < RUN_SPEED_MIN_MPS || speed_median >= ROAD_SPEED_MIN_MPS || share.running > 0 || share.cycling > 0) return leg;
    const road = legs[index - 1]?.leg.mode === "road_vehicle" || legs[index + 1]?.leg.mode === "road_vehicle";
    return road ? combine([leg], "road_vehicle", motions) : leg;
  });
  const joined = joinNeighbours(roads, motions);
  const grounded = (leg: Working) => leg.leg.mode === "flight" && leg.leg.distance_m < FLIGHT_MINIMUM_M;
  const merged = joined.some(grounded)
    ? joinNeighbours(joined.map((leg) => grounded(leg) ? fromSamples(leg.samples, motions, false) : leg), motions)
    : joined;
  return merged.map((leg) => leg.leg);
}

function joinNeighbours(legs: readonly Working[], motions: readonly Motion[]): Working[] {
  const runsOf: Working[][] = [];
  for (const leg of legs) {
    const previous = runsOf.at(-1);
    if (previous?.[0]!.leg.mode === leg.leg.mode) previous.push(leg);
    else runsOf.push([leg]);
  }
  return runsOf.map((run) => run.length === 1 ? run[0]! : combine(run, run[0]!.leg.mode, motions));
}

function speedSamples(fixes: readonly Fix[], start: number, end: number, motions: readonly Motion[]): Sample[] {
  const out: Sample[] = [];
  for (let index = 1; index < fixes.length; index++) {
    const previous = fixes[index - 1]!;
    const current = fixes[index]!;
    const from = Math.max(start, previous.at_ms);
    const to = Math.min(end, current.at_ms);
    if (to <= from) continue;
    const distance = distanceMeters(previous, current);
    const mean = distance / ((to - from) / 1_000);
    const silence = current.at_ms - previous.at_ms >= FIX_SILENCE_MINIMUM_MS;
    out.push({ start_ms: from, end_ms: to, distance_m: distance,
      speed_mps: silence ? mean : current.speed_mps ?? mean, altitude_m: current.altitude_m,
      silent: silence && movementStart(motions, previous.at_ms, current.at_ms) === null });
  }
  if (out.length > 0) {
    out[0]!.start_ms = start;
    out.at(-1)!.end_ms = end;
  }
  return out;
}

function smooth(samples: readonly Sample[]): Sample[] {
  let first = 0;
  const window: number[] = [];
  return samples.map((sample) => {
    window.splice(sortedIndex(window, sample.speed_mps), 0, sample.speed_mps);
    while (samples[first]!.end_ms <= sample.end_ms - SPEED_SMOOTHING_MS) window.splice(sortedIndex(window, samples[first++]!.speed_mps), 1);
    const middle = Math.floor(window.length / 2);
    return { ...sample, speed_mps: window.length % 2 === 1 ? window[middle]! : (window[middle - 1]! + window[middle]!) / 2 };
  });
}

function sortedIndex(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sorted[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

interface Part { from: number; to: number; mode: Mode }

function runs(samples: readonly Sample[], motions: readonly Motion[]): Part[] {
  const out: Part[] = [];
  let leg: { speeds: RunningMedian; distance: number; altitude: number } | null = null;
  samples.forEach((sample, index) => {
    const single = fromSamples([sample], motions).leg.mode;
    const previous = out.at(-1);
    if (previous !== undefined && leg !== null && previous.mode === single) {
      leg.speeds.add(sample.speed_mps);
      leg.distance += sample.distance_m;
      leg.altitude = Math.max(leg.altitude, sample.altitude_m);
      const start = samples[previous.from]!.start_ms;
      previous.to = index + 1;
      previous.mode = decideMode(leg.speeds.median(), leg.distance / ((sample.end_ms - start) / 1_000), leg.altitude, shares(motions, start, sample.end_ms));
      return;
    }
    leg = { speeds: new RunningMedian(), distance: 0 + sample.distance_m, altitude: Math.max(-Infinity, sample.altitude_m) };
    leg.speeds.add(sample.speed_mps);
    out.push({ from: index, to: index + 1, mode: single });
  });
  return out;
}

function foldShortLegs(samples: readonly Sample[], input: readonly Part[]): Part[] {
  const span = (part: Part) => samples[part.to - 1]!.end_ms - samples[part.from]!.start_ms;
  const out: Part[] = [];
  let current: Part | undefined = input[0] === undefined ? undefined : { ...input[0] };
  for (let index = 1; current !== undefined; index++) {
    const next = input[index];
    if (span(current) >= LEG_FOLD_MS || (out.length === 0 && next === undefined)) {
      out.push(current);
      current = next === undefined ? undefined : { ...next };
      continue;
    }
    const previous = out.at(-1);
    if (previous !== undefined && (next === undefined || span(previous) >= span(next))) {
      previous.to = current.to;
      current = next === undefined ? undefined : { ...next };
    } else {
      current = { from: current.from, to: next!.to, mode: next!.mode };
    }
  }
  return out;
}

class RunningMedian {
  readonly #lower = new Heap((left, right) => left > right);
  readonly #upper = new Heap((left, right) => left < right);

  add(value: number): void {
    if (this.#lower.size === 0 || value <= this.#lower.top()) this.#lower.push(value);
    else this.#upper.push(value);
    if (this.#lower.size > this.#upper.size + 1) this.#upper.push(this.#lower.pop());
    else if (this.#upper.size > this.#lower.size) this.#lower.push(this.#upper.pop());
  }

  median(): number {
    if (this.#lower.size === 0) return 0;
    return this.#lower.size > this.#upper.size ? this.#lower.top() : (this.#lower.top() + this.#upper.top()) / 2;
  }
}

class Heap {
  readonly #items: number[] = [];

  constructor(private readonly before: (left: number, right: number) => boolean) {}

  get size(): number {
    return this.#items.length;
  }

  top(): number {
    return this.#items[0]!;
  }

  push(value: number): void {
    const items = this.#items;
    items.push(value);
    for (let index = items.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (!this.before(items[index]!, items[parent]!)) break;
      [items[index], items[parent]] = [items[parent]!, items[index]!];
      index = parent;
    }
  }

  pop(): number {
    const items = this.#items;
    const top = items[0]!;
    const last = items.pop()!;
    if (items.length === 0) return top;
    items[0] = last;
    for (let index = 0; ;) {
      const left = 2 * index + 1;
      const right = left + 1;
      let best = index;
      if (left < items.length && this.before(items[left]!, items[best]!)) best = left;
      if (right < items.length && this.before(items[right]!, items[best]!)) best = right;
      if (best === index) break;
      [items[index], items[best]] = [items[best]!, items[index]!];
      index = best;
    }
    return top;
  }
}

function combine(legs: readonly Pick<Working, "samples">[], mode: Mode, motions: readonly Motion[]): Working {
  const combined = fromSamples(legs.flatMap((leg) => leg.samples), motions);
  return { ...combined, leg: { ...combined.leg, mode } };
}

function fromSamples(samples: readonly Sample[], motions: readonly Motion[], flights = true): Working {
  const ordered = [...samples].sort((left, right) => left.start_ms - right.start_ms);
  const start = ordered[0]!.start_ms;
  const end = ordered.at(-1)!.end_ms;
  const speed = median(ordered.map((sample) => sample.speed_mps));
  const distance = ordered.reduce((sum, sample) => sum + sample.distance_m, 0);
  const share = shares(motions, start, end);
  const altitude = ordered.reduce((highest, sample) => Math.max(highest, sample.altitude_m), -Infinity);
  return { samples: ordered, leg: { start_ms: start, end_ms: end, mode: decideMode(speed, distance / ((end - start) / 1_000), altitude, share, flights),
    distance_m: distance, speed_median: speed, shares: share } };
}

function decideMode(speedMedian: number, speedMean: number, altitude: number, share: Shares, flights = true): Exclude<Mode, "unknown"> {
  if (flights && (altitude > FLIGHT_ALTITUDE_M || speedMedian > FLIGHT_SPEED_MPS)) return "flight";
  if (share.automotive > MOTION_MAJORITY_SHARE) return "road_vehicle";
  if (speedMedian >= CYCLE_SPEED_MIN_MPS && speedMedian <= CYCLE_SPEED_MAX_MPS && share.cycling > MOTION_MAJORITY_SHARE) return "cycle";
  if (speedMedian >= RUN_SPEED_MIN_MPS && speedMedian <= RUN_SPEED_MAX_MPS && share.running > MOTION_MAJORITY_SHARE) return "run";
  if (speedMedian >= ROAD_SPEED_MIN_MPS || speedMean >= ROAD_MEAN_SPEED_MPS) return "road_vehicle";
  if ((speedMedian >= WALK_SPEED_MIN_MPS && speedMedian < RUN_SPEED_MIN_MPS) ||
      (speedMedian < ROAD_SPEED_MIN_MPS && share.walking > MOTION_MAJORITY_SHARE)) return "walk";
  return "unclear";
}


export function motionSpans(readings: readonly Omit<Motion, "end_ms">[]): Motion[] {
  const byStart = new Map<number, Omit<Motion, "end_ms">>();
  for (const reading of readings) {
    const current = byStart.get(reading.at_ms);
    if (current === undefined || reading.key < current.key) byStart.set(reading.at_ms, reading);
  }
  const ordered = [...byStart.values()].sort((left, right) => left.at_ms - right.at_ms);
  return ordered.map((reading, index) => ({ ...reading, end_ms: Math.min(ordered[index + 1]?.at_ms ?? Infinity, reading.at_ms + MOTION_HOLD_MS) }));
}

const FLAGS = ["stationary", "walking", "running", "automotive", "cycling", "unknown"] as const;

const covered = new WeakMap<readonly Motion[], Record<keyof Shares, number[]> | null>();

function coveredOf(motions: readonly Motion[]): Record<keyof Shares, number[]> | null {
  let found = covered.get(motions);
  if (found !== undefined) return found;
  found = motions.every((motion) => Number.isSafeInteger(motion.at_ms) && Number.isSafeInteger(motion.end_ms))
    ? Object.fromEntries(FLAGS.map((flag) => {
      const before = [0];
      motions.forEach((motion, index) => before.push(before[index]! + (motion[flag] ? motion.end_ms - motion.at_ms : 0)));
      return [flag, before];
    })) as Record<keyof Shares, number[]>
    : null;
  covered.set(motions, found);
  return found;
}

export function shares(motions: readonly Motion[], start: number, end: number): Shares {
  const totals: Shares = { stationary: 0, walking: 0, running: 0, automotive: 0, cycling: 0, unknown: 0 };
  const duration = end - start;
  if (duration <= 0) return totals;
  const before = Number.isSafeInteger(start) && Number.isSafeInteger(end) ? coveredOf(motions) : null;
  if (before !== null) {
    let low = 0;
    let high = motions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (motions[middle]!.end_ms <= start) low = middle + 1;
      else high = middle;
    }
    const first = low;
    high = motions.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (motions[middle]!.at_ms < end) low = middle + 1;
      else high = middle;
    }
    const last = low - 1;
    const part = (motion: Motion) => Math.max(0, Math.min(end, motion.end_ms) - Math.max(start, motion.at_ms));
    for (const flag of FLAGS) {
      if (last < first) continue;
      let total = motions[first]![flag] ? part(motions[first]!) : 0;
      if (last > first) total += before[flag][last]! - before[flag][first + 1]! + (motions[last]![flag] ? part(motions[last]!) : 0);
      totals[flag] = total / duration;
    }
    return totals;
  }
  for (const motion of overlapping(motions, start, end)) {
    const overlap = Math.min(end, motion.end_ms) - Math.max(start, motion.at_ms);
    if (overlap <= 0) continue;
    for (const flag of Object.keys(totals) as (keyof Shares)[]) if (motion[flag]) totals[flag] += overlap;
  }
  for (const flag of Object.keys(totals) as (keyof Shares)[]) totals[flag] /= duration;
  return totals;
}

function motionDuration(motions: readonly Motion[], start: number, end: number, test: (motion: Motion) => boolean): number {
  let total = 0;
  for (const motion of overlapping(motions, start, end)) {
    if (test(motion)) total += Math.max(0, Math.min(end, motion.end_ms) - Math.max(start, motion.at_ms));
  }
  return total;
}

function* overlapping(motions: readonly Motion[], start: number, end: number): Iterable<Motion> {
  let low = 0;
  let high = motions.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (motions[middle]!.end_ms <= start) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < motions.length && motions[index]!.at_ms < end; index++) yield motions[index]!;
}


function pathDistance(fixes: readonly Fix[]): number {
  let total = 0;
  for (let index = 1; index < fixes.length; index++) total += distanceMeters(fixes[index - 1]!, fixes[index]!);
  return total;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function byFix(left: Fix, right: Fix): number {
  return left.at_ms - right.at_ms || compare(left.key, right.key);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
