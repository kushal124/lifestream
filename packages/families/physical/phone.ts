import { digest, type Json, type SourceRow, type Version, type View, type Witness as WitnessAdapter } from "@lifestreamprotocol/core";
import type { Change, Given, Touched } from "../family.js";
import { Stretches } from "../shared/stretches.js";
import {
  hundred, OPEN_END_MS, owned, parseUnit, PHYSICAL, rounded, compare, unitName,
  type LegContent, type Said, type StayContent, type TripContent,
} from "./evidence.js";
import {
  KEPT_SILENCE_MS, MOTION_HOLD_MS, motionSpans, segment,
  type Fix, type Leg, type Mode, type Motion, type Shares, type Span, type Stay, type Trip,
} from "./segment.js";
import { declared, type Witness } from "./witnesses.js";

const FIX = "fix";
const MOTION = "motion";
const ACCURACY_CEILING_M = 100;
export const SLACK_MS = 15 * 60_000;
const FIRST_REACH_MS = 6 * 3_600_000;

type PhoneContent = Said<StayContent> | Said<TripContent>;

type ReadFix = (version: Version) => Fix | null;
type ReadMotion = (version: Version) => Omit<Motion, "end_ms"> | null;

export function phoneWitness(stream: Given<WitnessAdapter>, motions: readonly Given<WitnessAdapter>[]): Witness {
  const LOCATION = { product: [stream.product] };
  const MOTIONS = motions.map((each) => each.product);
  const fixOf = (source: SourceRow | undefined): ReadFix => (version) => (source === undefined ? null : readFix(stream.adapter, source, version));
  const motionOf = (source: SourceRow | undefined): ReadMotion | null => {
    const adapter = motions.find((each) => each.product === source?.product)?.adapter;
    return adapter === undefined ? null : (version) => readMotion(adapter, source!, version);
  };

  const phones = new WeakMap<View, Map<string, Phone>>();
  const phoneOf = (view: View, location: string): Phone => {
    let read = phones.get(view);
    if (read === undefined) phones.set(view, read = new Map());
    let phone = read.get(location);
    if (phone === undefined) {
      const motion = sibling(view, location, MOTIONS);
      const reading = motion === undefined ? null : motionOf(view.source(motion));
      read.set(location, phone = new Phone(view, location, fixOf(view.source(location)), reading === null ? null : { source: motion!, read: reading }));
    }
    return phone;
  };

  return {
    ...declared(stream),
    inputs: [stream, ...motions].map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    owns: (unit) => owned(unit, ["stay", "trip"], LOCATION),

    touched(changes: readonly Change[], view: View): Touched[] {
      const spans = new Map<string, Span[]>();
      const at = (location: string, start_ms: number, end_ms: number) => {
        let list = spans.get(location);
        if (list === undefined) spans.set(location, list = []);
        list.push({ start_ms, end_ms });
      };
      for (const change of changes) {
        const { source, kind } = change.record;
        const row = view.source(source);
        if (row === undefined) continue;
        const location = row.product === stream.product ? source : MOTIONS.includes(row.product) ? sibling(view, source, [stream.product]) : undefined;
        if (location === undefined) continue;
        const fix = kind === FIX && row.product === stream.product ? fixOf(row) : null;
        const motion = kind === MOTION ? motionOf(row) : null;
        for (const version of [change.before, change.after]) {
          if (version === undefined) continue;
          if (fix !== null) {
            const read = fix(version);
            if (read !== null) at(location, read.at_ms, read.at_ms);
          } else if (motion !== null) {
            const read = motion(version);
            if (read !== null) at(location, read.at_ms, read.at_ms + MOTION_HOLD_MS);
          }
        }
      }
      const out: Touched[] = [];
      for (const [location, list] of spans) out.push(...phoneTouched(view, phoneOf(view, location), list));
      return out;
    },

    extract(unit: string, view: View): PhoneContent | null {
      const { source, rest } = parseUnit(unit);
      const start = Number(rest);
      if (!Number.isSafeInteger(start)) return null;
      const phone = phoneOf(view, source);
      const window = phone.windows.find((built) => built.start_ms <= start && start < built.end_ms) ?? phoneWindow(phone, { start_ms: start, end_ms: start });
      return window.units.find((found) => found.name === unit)?.content ?? null;
    },
  };
}

function sibling(view: View, source: string, products: readonly string[]): string | undefined {
  const row = view.source(source);
  return row === undefined || products.length === 0 ? undefined : siblingIn(row, view.sources({ product: [...products], copy: [row.copy] }), products);
}

export function siblingIn(row: SourceRow, rows: Iterable<SourceRow>, products: readonly string[]): string | undefined {
  return [...rows].find((other) => products.includes(other.product) && other.copy === row.copy && other.account === row.account)?.id;
}


interface PhoneUnit { name: string; content: PhoneContent }

interface PhoneWindow { units: PhoneUnit[]; start_ms: number; end_ms: number; after_ms: number; until_ms: number; hi: number }

function phoneWindow(phone: Phone, changed: Span): PhoneWindow {
  const known = phone.windows.find((window) => window.after_ms <= changed.start_ms && changed.end_ms < window.until_ms);
  if (known !== undefined) return known;
  const earliest = phone.earliest();
  if (earliest === null) {
    const empty = { units: [], start_ms: -Infinity, end_ms: Infinity, after_ms: -Infinity, until_ms: Infinity, hi: Infinity };
    phone.windows.splice(0, phone.windows.length, empty);
    return empty;
  }
  const anchor = phone.anchor(changed.start_ms);
  let begin = anchor ?? earliest;
  let after = anchor === null ? -Infinity : changed.start_ms;
  let hi = changed.end_ms;
  for (;;) {
    const built = ahead(phone, begin, hi);
    const met = phone.windows.filter((window) => window.start_ms <= built.end_ms && begin <= window.end_ms);
    if (met.length === 0) {
      const units: PhoneUnit[] = [];
      const source = phone.location;
      const inside = (start: number) => start >= begin && start < built.end_ms;
      for (const stay of built.stays) if (inside(stay.start_ms)) units.push(stayUnit(source, stay));
      for (const trip of built.trips) if (inside(trip.start_ms)) units.push(tripUnit(source, trip));
      units.sort((left, right) => left.content.start_ms - right.content.start_ms || compare(left.name, right.name));
      const window: PhoneWindow = { units, start_ms: begin, end_ms: built.end_ms, after_ms: after, until_ms: built.until_ms, hi };
      phone.windows.push(window);
      return window;
    }
    for (const window of met) {
      begin = Math.min(begin, window.start_ms);
      after = Math.min(after, window.after_ms);
      hi = Math.max(hi, window.hi);
      phone.windows.splice(phone.windows.indexOf(window), 1);
    }
  }
}

interface Ahead { stays: Stay[]; trips: Trip[]; end_ms: number; until_ms: number }

function ahead(phone: Phone, begin: number, hi: number): Ahead {
  for (let reach = phone.storesAfter(hi) ? FIRST_REACH_MS : Infinity; ; reach *= 2) {
    const last = !(hi + reach < OPEN_END_MS) || phone.nextFix(hi + reach) === null;
    const fixes = phone.fixes(begin, last ? OPEN_END_MS : hi + reach);
    const end = (fixes.at(-1)?.at_ms ?? begin) + 1;
    const { stays, trips } = segment(fixes, phone.motions(begin, end));
    const meets = stays.find((stay, index) => stay.before !== null && stay.before.at_ms > hi && stays[index + 1] !== undefined &&
      phone.holds(stayUnit(phone.location, stay)));
    if (meets !== undefined) return { stays, trips, end_ms: meets.start_ms, until_ms: meets.before!.at_ms };
    if (last) return { stays, trips, end_ms: Infinity, until_ms: Infinity };
  }
}

function phoneTouched(view: View, phone: Phone, spans: readonly Span[]): Touched[] {
  const windows = new Set<PhoneWindow>();
  for (const changed of [...spans].sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms)) windows.add(phoneWindow(phone, changed));
  const out: Touched[] = [];
  for (const window of windows) {
    if (!phone.windows.includes(window)) continue;
    const fresh = new Set(window.units.map((unit) => unit.name));
    const stale: string[] = [];
    const start = Math.min(window.start_ms, window.after_ms);
    const range = { ...Number.isFinite(start) ? { start_ms: start } : {}, ...Number.isFinite(window.end_ms) ? { end_ms: window.end_ms } : {} };
    for (const extract of view.extracts(PHYSICAL, range)) {
      if (parseUnit(extract.unit).source === phone.location && !fresh.has(extract.unit)) stale.push(extract.unit);
    }
    out.push(...[...fresh].map((unit, index) => stale[index] === undefined ? { unit } : { unit, previous: stale[index]! }));
    for (const unit of stale.slice(fresh.size)) out.push({ unit });
  }
  return out;
}

function stayUnit(source: string, stay: Stay): PhoneUnit {
  return {
    name: unitName("stay", source, String(stay.start_ms)),
    content: {
      kind: "stay", source, start_ms: stay.start_ms, end_ms: stay.end_ms, open: stay.open, centre: rounded(stay.centre),
      level: stay.level, silences: stay.silences.filter((silence) => silence.end_ms - silence.start_ms >= KEPT_SILENCE_MS)
        .map(({ start_ms, end_ms }) => ({ start_ms, end_ms })),
      bouts: stay.bouts.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })),
    },
  };
}

function tripUnit(source: string, trip: Trip): PhoneUnit {
  return {
    name: unitName("trip", source, String(trip.start_ms)),
    content: {
      kind: "trip", source, start_ms: trip.start_ms, end_ms: trip.end_ms, from: rounded(trip.from), to: rounded(trip.to),
      distance_m: hundred(trip.distance_m), legs: trip.legs.map(legContent),
    },
  };
}

function legContent(leg: Leg): LegContent {
  return { start_ms: leg.start_ms, end_ms: leg.end_ms, mode: leg.mode, distance_m: hundred(leg.distance_m), motion: otherMovement(leg.mode, leg.shares), stated: null };
}

function otherMovement(mode: Mode, shares: Shares): string | null {
  const agrees: Partial<Record<Mode, string>> = { walk: "walking", run: "running", cycle: "cycling", road_vehicle: "automotive", flight: "automotive" };
  for (const flag of ["automotive", "walking", "running", "cycling"] as const) {
    if (shares[flag] >= 0.5) return agrees[mode] === flag ? null : `phone motion: ${flag}`;
  }
  return null;
}


class Phone {
  readonly #fixes = new Stretches<Fix>((fix) => fix.at_ms);
  readonly #motions = new Stretches<Omit<Motion, "end_ms">>((motion) => motion.at_ms);
  #earliest: number | null | undefined;
  readonly windows: PhoneWindow[] = [];

  constructor(
    private readonly view: View, readonly location: string, private readonly fix: ReadFix,
    readonly motion: { source: string; read: ReadMotion } | null,
  ) {}

  fixes(lo: number, hi: number): Fix[] {
    this.#fixes.cover(lo - SLACK_MS, hi + SLACK_MS, (from, to) => this.#read(this.location, FIX, from, to, this.fix));
    return this.#fixes.within(lo, hi);
  }

  motions(lo: number, hi: number): Motion[] {
    this.#motions.cover(lo - MOTION_HOLD_MS - SLACK_MS, hi + SLACK_MS, (from, to) => (this.motion === null ? [] : this.#read(this.motion.source, MOTION, from, to, this.motion.read)));
    return motionSpans(this.#motions.within(lo - MOTION_HOLD_MS, hi));
  }

  earliest(): number | null {
    if (this.#earliest === undefined) this.#earliest = this.nextFix(Number.MIN_SAFE_INTEGER);
    return this.#earliest;
  }

  nextFix(ms: number): number | null {
    return this.#first(this.location, FIX, ms, this.fix, (fix) => fix.at_ms);
  }

  anchor(lo: number): number | null {
    const earliest = this.earliest();
    for (let reach = FIRST_REACH_MS; earliest !== null; reach *= 2) {
      const from = lo - reach;
      const ended: number[] = [];
      for (const stored of this.view.extracts(PHYSICAL, { start_ms: from, end_ms: lo })) {
        if (stored.unit.startsWith(`stay/${this.location}/`) && stored.end_ms !== null && stored.end_ms < lo) ended.push(stored.start_ms!);
      }
      if (ended.length >= 2) return ended.at(-2)!;
      if (from <= earliest) break;
    }
    return null;
  }

  storesAfter(ms: number): boolean {
    for (const stored of this.view.extracts(PHYSICAL, Number.isFinite(ms) ? { start_ms: ms + 1 } : {})) {
      if (stored.unit.startsWith(`stay/${this.location}/`)) return true;
    }
    return false;
  }

  holds(unit: PhoneUnit): boolean {
    const stored = this.view.extract(PHYSICAL, unit.name);
    return stored?.reading === digest(unit.content as unknown as Json);
  }

  #read<T extends { key: string }>(source: string, kind: string, from: number, to: number, read: (version: Version) => T | null): T[] {
    const out: T[] = [];
    const range = { start_ms: Math.max(from, Number.MIN_SAFE_INTEGER), end_ms: Math.min(to, OPEN_END_MS) };
    for (const { version } of this.view.records(source, kind, range)) {
      const value = read(version);
      if (value !== null) out.push(value);
    }
    return out;
  }

  #first<T>(source: string, kind: string, ms: number, read: (version: Version) => T | null, at: (value: T) => number): number | null {
    let best: number | null = null;
    for (const { head, version } of this.view.records(source, kind, { start_ms: Math.max(ms - SLACK_MS, Number.MIN_SAFE_INTEGER) })) {
      if (best !== null && head.start_ms! > best + SLACK_MS) break;
      const value = read(version);
      if (value === null) continue;
      const time = at(value);
      if (time >= ms && (best === null || time < best)) best = time;
    }
    return best;
  }
}

export function readFix(adapter: WitnessAdapter, source: SourceRow, version: Version): Fix | null {
  const fix = adapter.fix!({ source, version });
  if (fix === null || fix.accuracy_m < 0 || fix.accuracy_m > ACCURACY_CEILING_M || !agrees(version, fix.at_ms)) return null;
  const { at_ms, latitude, longitude, speed_mps, altitude_m, accuracy_m } = fix;
  return { key: version.key, at_ms, latitude, longitude, speed_mps, altitude_m, accuracy_m };
}

export function readMotion(adapter: WitnessAdapter, source: SourceRow, version: Version): Omit<Motion, "end_ms"> | null {
  const motion = adapter.motion!({ source, version });
  if (motion === null || !agrees(version, motion.at_ms)) return null;
  const { at_ms, stationary, walking, running, automotive, cycling, unknown } = motion;
  return { key: version.key, at_ms, stationary, walking, running, automotive, cycling, unknown };
}

export function agrees(version: { readonly time?: { readonly start_ms: number } }, at: number): boolean {
  const stated = version.time?.start_ms;
  return stated !== undefined && Math.abs(stated - at) <= SLACK_MS;
}
