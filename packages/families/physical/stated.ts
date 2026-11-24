import type { AdapterSource, AdapterVersion, Version, View, Witness as WitnessAdapter } from "@lifestreamprotocol/core";
import type { Change, Given, Touched } from "../family.js";
import type { Where } from "../shared/places.js";
import {
  compare, hundred, liveRecord, OPEN_END_MS, owned, parseUnit, rounded, unitName,
  type Said, type StayContent, type TripContent,
} from "./evidence.js";
import { WALK_SPEED_MIN_MPS, type Mode, type Span } from "./segment.js";
import { declared, type Witness } from "./witnesses.js";

const VISIT = "place-visit";
const TRIP = "trip";

export function statedWitness(stream: Given<WitnessAdapter>): Witness {
  const SOURCES = { product: [stream.product] };
  const { adapter } = stream;
  const cache = new WeakMap<object, Map<string, Visits>>();

  const visitOf = (source: AdapterSource | undefined, version: AdapterVersion | undefined): Visit | null => {
    const visit = source === undefined || version === undefined || adapter.visit === undefined ? null : adapter.visit({ source, version });
    return visit === null ? null : {
      key: version!.key, start_ms: visit.start_ms, end_ms: visit.end_ms, centre: { ...rounded(visit.centre), ...(visit.place === null ? {} : { id: visit.place }) },
    };
  };

  const visitsOf = (view: View, source: string): Visits => {
    const snapshot = view.snapshot ?? view;
    let bySource = cache.get(snapshot);
    if (bySource === undefined) cache.set(snapshot, bySource = new Map());
    let visits = bySource.get(source);
    if (visits === undefined) {
      const row = view.source(source);
      const read: Visit[] = [];
      for (const { version } of view.records(source, VISIT)) {
        const visit = visitOf(row, version);
        if (visit !== null) read.push(visit);
      }
      visits = {
        byStart: [...read].sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || compare(left.key, right.key)),
        byEnd: [...read].sort((left, right) => left.end_ms - right.end_ms || compare(left.key, right.key)),
      };
      bySource.set(source, visits);
    }
    return visits;
  };

  const tripsBeside = (view: View, source: string, key: string, versions: readonly (Version | undefined)[]): string[] => {
    const row = view.source(source);
    const spans = versions.flatMap((version) => {
      const visit = visitOf(row, version);
      return visit === null ? [] : [visit];
    });
    if (spans.length === 0) return [];
    const visits = visitsOf(view, source);
    const start = Math.min(...spans.map((span) => span.start_ms));
    const end = Math.max(...spans.map((span) => span.end_ms));
    const lo = endedBy(visits, start, key)?.end_ms ?? Number.MIN_SAFE_INTEGER;
    const hi = startedFrom(visits, end, key)?.start_ms ?? OPEN_END_MS;
    const keys: string[] = [];
    for (const { head } of view.records(source, TRIP, { start_ms: lo, end_ms: hi })) {
      const inside = (ms: number | null | undefined) => ms !== null && ms !== undefined && ms >= lo && ms <= hi;
      if (inside(head.start_ms) || inside(head.end_ms)) keys.push(head.key);
    }
    return keys;
  };

  const stay = (view: View, source: string, key: string): Said<StayContent> | null => {
    const record = liveRecord(view, source, VISIT, key);
    const visit = visitOf(record?.source, record?.version);
    if (visit === null) return null;
    return { kind: "stay", source, start_ms: visit.start_ms, end_ms: visit.end_ms, open: false, centre: visit.centre, level: "stated", silences: [], bouts: [],
      record: { source, kind: VISIT, key } };
  };

  const trip = (view: View, source: string, key: string): Said<TripContent> | null => {
    const record = liveRecord(view, source, TRIP, key);
    const activity = record === null || adapter.activity === undefined ? null : adapter.activity(record);
    if (activity === null) return null;
    const span = { start_ms: activity.start_ms, end_ms: activity.end_ms };
    const duration = span.end_ms - span.start_ms;
    const beside = visitsBeside(visitsOf(view, source), span);
    const ends = {
      from: beside.from === null ? activity.from : beside.from.centre,
      to: beside.to === null ? activity.to : beside.to.centre,
    };
    const floor = activity.mode === "flight" ? 40 : activity.mode === "walk" ? WALK_SPEED_MIN_MPS : 1.5;
    const stands = (activity.mode === "flight" || duration <= 3 * 3_600_000) && activity.distance_m / (duration / 1_000) >= floor;
    const mode: Mode = stands ? activity.mode : "unknown";
    return {
      kind: "trip", source, ...span, ...ends, distance_m: hundred(activity.distance_m),
      legs: [{ ...span, mode, distance_m: hundred(activity.distance_m), motion: null, stated: activity.stated }],
      record: { source, kind: TRIP, key },
    };
  };

  return {
    ...declared(stream),
    inputs: [{ sources: SOURCES, kinds: [...adapter.kinds], role: "evidence" }],
    owns: (unit) => owned(unit, ["stay", "trip"], SOURCES),

    touched(changes: readonly Change[], view: View): Touched[] {
      const out: Touched[] = [];
      for (const change of changes) {
        const { source, kind, key } = change.record;
        if (kind === TRIP) out.push({ unit: unitName("trip", source, key) });
        if (kind !== VISIT) continue;
        out.push({ unit: unitName("stay", source, key) });
        for (const each of tripsBeside(view, source, key, [change.before, change.after])) out.push({ unit: unitName("trip", source, each) });
      }
      return out;
    },

    extract(unit: string, view: View): Said<StayContent> | Said<TripContent> | null {
      const { kind, source, rest } = parseUnit(unit);
      return kind === "stay" ? stay(view, source, rest) : kind === "trip" ? trip(view, source, rest) : null;
    },
  };
}

interface Visit extends Span { key: string; centre: Where }

interface Visits {
  byStart: Visit[];
  byEnd: Visit[];
}

function firstNot<T>(list: readonly T[], before: (item: T) => boolean): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (before(list[mid]!)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function endedBy(visits: Visits, ms: number, key?: string): Visit | null {
  for (let index = firstNot(visits.byEnd, (visit) => visit.end_ms <= ms) - 1; index >= 0; index--) {
    if (visits.byEnd[index]!.key !== key) return visits.byEnd[index]!;
  }
  return null;
}

function startedFrom(visits: Visits, ms: number, key?: string): Visit | null {
  for (let index = firstNot(visits.byStart, (visit) => visit.start_ms < ms); index < visits.byStart.length; index++) {
    if (visits.byStart[index]!.key !== key) return visits.byStart[index]!;
  }
  return null;
}

function visitsBeside(visits: Visits, span: Span): { from: Visit | null; to: Visit | null } {
  return { from: endedBy(visits, span.start_ms), to: startedFrom(visits, span.end_ms) };
}
