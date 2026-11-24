import {
  addDays, civilDay, daysOf, digest, instant, sourceName,
  type Cycle, type DaySettings, type ExtractRow, type HealthAdapter, type HealthItem, type Head, type Json, type SourceRow, type Version, type View,
} from "@lifestreamprotocol/core";
import { OPS, statingAccounts, type Change, type Collection, type Extracted, type Family, type FamilyInput, type Given, type Measure, type Touched } from "../family.js";
import { healthDay, parseUnit } from "./lines.js";

export const SPAN_MS = 900_000;
export const BASELINE_DAYS = 14;

const HOUR_MS = 3_600_000;
export const COPY_SERIES = Number.MAX_SAFE_INTEGER;
export const SLEEP_STAGES: readonly string[] = ["in bed", "asleep", "core", "deep", "REM", "awake"];


export interface Lane {
  metric: string;
  instrument: string;
  unit: string;
  count: number;
  sum: number;
  min: number;
  max: number;
}

export interface SpanContent { kind: "span"; source: string; start_ms: number; end_ms: number; own: boolean; lanes: Lane[] }

export interface SleepContent {
  kind: "sleep";
  record: { source: string; key: string; kind: string };
  start_ms: number;
  end_ms: number;
  nap: boolean;
  stages: { in_bed: number | null; light: number | null; deep: number | null; rem: number | null; awake: number | null; cycles: number | null; disturbances: number | null } | null;
  efficiency: number | null;
  performance: number | null;
  respiratory_rate: number | null;
}

export interface StageContent {
  kind: "stage";
  source: string;
  instrument: string;
  stage: string;
  start_ms: number;
  end_ms: number;
  recovery: number | null;
}

export interface WorkoutContent {
  kind: "workout";
  record: { source: string; key: string; kind: string };
  start_ms: number;
  end_ms: number;
  sport: string | null;
  strain: number | null;
  average_heart_rate?: number | null;
  max_heart_rate?: number | null;
  kilojoule?: number | null;
  distance_m?: number | null;
}

export interface HealthWorkoutContent {
  kind: "health-workout";
  record: { source: string; key: string; kind: string };
  instrument: string;
  start_ms: number;
  end_ms: number;
  activity: string;
  duration_s: number | null;
  distance: string | null;
  energy?: string | null;
  average_heart_rate?: number | null;
  max_heart_rate?: number | null;
  strain: number | null;
}

export interface RecoveryContent {
  kind: "recovery";
  record: { source: string; key: string; kind: string };
  wake_ms: number;
  score: number | null;
  hrv: number | null;
  resting_heart_rate: number | null;
  strain: { end_ms: number; strain: number | null; average_heart_rate: number | null; max_heart_rate: number | null; kilojoule: number | null } | null;
}

export interface CycleContent {
  kind: "cycle";
  record: { source: string; key: string; kind: "cycle" };
  start_ms: number;
  end_ms: number;
  sleeps: SleepContent[];
  workouts: WorkoutContent[];
  recovery: RecoveryContent | null;
}

export interface SummaryContent {
  kind: "summary";
  record: { source: string; key: string; kind: string };
  date: string;
  move: [string, string, string];
  exercise: [string, string];
  stand: [string, string];
}

export interface PhoneContent {
  kind: "phone";
  source: string;
  start_ms: number;
  end_ms: number;
  seconds: number;
  categories: { name: string; seconds: number }[];
}

export type HealthContent = SpanContent | SleepContent | StageContent | WorkoutContent | HealthWorkoutContent | RecoveryContent | CycleContent | SummaryContent | PhoneContent;


export function healthFamily(given: readonly Given<HealthAdapter>[]): Family {
  const fed = fedOf(given);
  return {
    name: "health",
    type: "health",
    code: "7",
    inputs: given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),

    touched(changes: readonly Change[], view: View): Touched[] {
      let others: Map<string, string[]> | undefined;
      return changes.flatMap((change): Touched[] => {
        const { source, kind, key } = change.record;
        const row = view.source(source);
        const units = new Set<string>();
        for (const version of [change.before, change.after]) {
          if (version === undefined) continue;
          const item = row === undefined ? null : fed.item(row, version);
          if (kind === "sample") {
            if (item?.item === "stage") {
              units.add(unitName("stage", source, key));
              continue;
            }
            const span = sampleSpan(version);
            if (span === null) continue;
            units.add(unitName("span", source, `${span.start_ms}/${span.end_ms}`));
            if (item?.item === "sample" && item.series !== undefined) {
              others ??= new Map();
              const ids = others.get(row!.product) ?? fed.sampled(view, row!.product);
              others.set(row!.product, ids);
              for (const id of ids) units.add(unitName("span", id, `${span.start_ms}/${span.end_ms}`));
            }
          } else if (kind === "sleep") {
            units.add(unitName("sleep", source, key));
            if (item?.item === "sleep" && item.cycle !== null) units.add(unitName("recovery", source, item.cycle));
          } else if (kind === "workout" || kind === "recovery") {
            units.add(unitName(kind, source, key));
          } else if (kind === "cycle") {
            units.add(unitName("cycle", source, key));
            if (item?.item === "cycle") {
              for (const id of item.states.sleeps) units.add(unitName("sleep", source, id));
              for (const id of item.states.workouts) units.add(unitName("workout", source, id));
            }
            units.add(unitName("recovery", source, key));
          } else if (kind === "physio-day") {
            units.add(unitName("recovery", source, key));
          } else if (kind === "day-summary") {
            units.add(unitName("summary", source, key));
          } else if (kind === "usage") {
            const hour = item?.item === "usage" ? usageHour(version) : null;
            if (hour !== null) units.add(unitName("phone", source, String(hour)));
          }
        }
        return [...units].sort().map((unit) => ({ unit }));
      });
    },

    extract(unit: string, view: View): Extracted | null {
      const { kind, source, rest } = parseUnit(unit);
      const content = kind === "span" ? spanContent(fed, view, source, rest)
        : kind === "sleep" ? sleepContent(fed, view, source, rest)
        : kind === "stage" ? stageContent(fed, view, source, rest)
        : kind === "workout" ? workoutContent(fed, view, source, rest)
        : kind === "recovery" ? recoveryContent(fed, view, source, rest)
        : kind === "cycle" ? cycleContent(fed, view, source, rest)
        : kind === "summary" ? summaryContent(fed, view, source, rest)
        : kind === "phone" ? phoneContent(fed, view, source, rest)
        : null;
      if (content === null) return null;
      const { start_ms, end_ms } = bounds(content);
      return { content: content as unknown as Json, start_ms, end_ms, reading: digest(content as unknown as Json) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      const content = extract.content as unknown as HealthContent;
      switch (content.kind) {
        case "span": {
          const own = daysOf({ start_ms: content.start_ms, end_ms: content.end_ms, precision: "ms" }, settings);
          const compared = content.lanes.some((lane) => lane.metric === "steps" || (!content.own && (lane.metric === "heart_rate" || lane.metric === "stress")));
          return compared ? withLookback(own) : own;
        }
        case "sleep":
          return content.nap ? daysOf({ start_ms: content.start_ms, end_ms: content.end_ms, precision: "ms" }, settings)
            : wakeDays(content.end_ms, settings);
        case "stage": {
          const day = civilDay(content.end_ms, settings);
          return [addDays(day, -1), day, addDays(day, 1)];
        }
        case "workout":
          return padded(daysOf({ start_ms: content.start_ms, end_ms: content.end_ms, precision: "ms" }, settings));
        case "health-workout":
        case "phone":
          return daysOf({ start_ms: content.start_ms, end_ms: content.end_ms, precision: "ms" }, settings);
        case "recovery": {
          const days = new Set([civilDay(content.wake_ms, settings)]);
          if (content.strain !== null) for (const day of withLookback([civilDay(content.strain.end_ms, settings)])) days.add(day);
          return [...days].sort();
        }
        case "cycle": {
          const days = new Set<string>(daysOf({ start_ms: content.start_ms, end_ms: Math.max(content.end_ms, content.start_ms + 1), precision: "ms" }, settings));
          for (const sleep of content.sleeps) {
            if (sleep.nap) for (const day of daysOf({ start_ms: sleep.start_ms, end_ms: sleep.end_ms, precision: "ms" }, settings)) days.add(day);
            else for (const day of wakeDays(sleep.end_ms, settings)) days.add(day);
          }
          for (const workout of content.workouts) for (const day of padded(daysOf({ start_ms: workout.start_ms, end_ms: workout.end_ms, precision: "ms" }, settings))) days.add(day);
          if (content.recovery !== null) {
            days.add(civilDay(content.recovery.wake_ms, settings));
            if (content.recovery.strain !== null) for (const day of withLookback([civilDay(content.recovery.strain.end_ms, settings)])) days.add(day);
          }
          return [...days].sort();
        }
        case "summary":
          return [content.date];
      }
    },

    day: (input) => statingAccounts(healthDay(input, fed), (unit) => [parseUnit(unit).source]),
    collections: HEALTH_COLLECTIONS,
  };
}


const LEVEL: Measure["ops"] = ["avg", "min", "max", "first", "last"];

export const HEALTH_COLLECTIONS: Readonly<Record<string, Collection>> = {
  days: {
    keys: ["instrument"],
    measures: {
      recovery: { unit: "score", ops: LEVEL, time: "end", split: "whole", from: "stated" },
      hrv_ms: { unit: "ms", ops: LEVEL, time: "end", split: "whole", from: "stated" },
      rhr_bpm: { unit: "bpm", ops: LEVEL, time: "end", split: "whole", from: "stated" },
      asleep_min: { unit: "min", ops: OPS, time: "end", split: "whole", readings: ["days.in_bed_min"], from: "derived" },
      in_bed_min: { unit: "min", ops: OPS, time: "end", split: "whole", readings: ["days.asleep_min"], from: "derived" },
      steps: { unit: "count", ops: OPS, time: "end", split: "whole", copies: "the largest instrument's total", from: "derived" },
    },
  },
  workouts: {
    keys: ["sport", "instrument"],
    measures: {
      minutes: { unit: "min", ops: OPS, time: "start", split: "clock", from: "derived" },
      km: { unit: "km", ops: OPS, time: "start", split: "whole", from: "stated" },
      kcal: { unit: "kcal", ops: OPS, time: "start", split: "whole", from: "stated" },
      strain: { unit: "score", ops: LEVEL, time: "start", split: "whole", from: "stated" },
      avg_hr: { unit: "bpm", ops: LEVEL, time: "start", split: "whole", from: "stated" },
      max_hr: { unit: "bpm", ops: LEVEL, time: "start", split: "whole", from: "stated" },
    },
  },
};


interface Fed {
  item(source: SourceRow, version: Version): HealthItem | null;
  sampled(view: View, product: string): string[];
  owners(instrument: string): ReadonlySet<string> | undefined;
  named(instrument: string): string;
  own(source: string): string;
}

function fedOf(given: readonly Given<HealthAdapter>[]): Fed {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const owners = new Map<string, Set<string>>();
  const words: [RegExp, string][] = [];
  for (const each of given) {
    for (const name of each.adapter.instrument ?? []) {
      owners.set(name, new Set([...owners.get(name) ?? [], each.product]));
      words.push([new RegExp(`^${escaped(name)}(?:\\b|$)`, "iu"), each.name]);
    }
  }
  return {
    item(source, version) {
      const adapter = byProduct.get(source.product)?.adapter;
      return adapter === undefined || !adapter.kinds.includes(version.kind) ? null : adapter.item({ source, version });
    },
    sampled: (view, product) => view.sources({ product: given.filter((each) => each.product !== product && each.adapter.kinds.includes("sample")).map((each) => each.product) }).map((row) => row.id),
    owners: (instrument) => owners.get(instrument),
    own(source) {
      const product = sourceName(source).product;
      return byProduct.get(product)?.name ?? product;
    },
    named(instrument) {
      for (const [pattern, name] of words) if (pattern.test(instrument)) return name;
      if (/iphone/iu.test(instrument)) return "iPhone";
      return instrument;
    },
  };
}

function escaped(name: string): string {
  return name.replace(/[.*+?^$|()[\]{}\\]/gu, "\\$&");
}

function live(fed: Fed, view: View, source: string, kind: string, key: string): { head: Head; version: Version; item: HealthItem | null } | null {
  const head = view.head({ source, kind, key });
  const row = view.source(source);
  if (head === undefined || head.version === "gone" || row === undefined) return null;
  const version = view.version(head.version);
  return { head, version, item: fed.item(row, version) };
}

function liveItem<K extends HealthItem["item"]>(fed: Fed, view: View, source: string, kind: string, key: string, shape: K): { version: Version; item: Extract<HealthItem, { item: K }> } | null {
  const read = live(fed, view, source, kind, key);
  return read?.item?.item === shape ? { version: read.version, item: read.item as Extract<HealthItem, { item: K }> } : null;
}


function unitName(kind: string, source: string, rest: string): string {
  return `${kind}/${source}/${rest}`;
}

function sampleSpan(version: Version): { start_ms: number; end_ms: number } | null {
  const time = version.time;
  if (time === undefined) return null;
  const end = time.end_ms ?? time.start_ms;
  if (end - time.start_ms > SPAN_MS) return { start_ms: time.start_ms, end_ms: end };
  const start = Math.floor(time.start_ms / SPAN_MS) * SPAN_MS;
  return { start_ms: start, end_ms: start + SPAN_MS };
}

function bounds(content: HealthContent): { start_ms: number | null; end_ms: number | null } {
  switch (content.kind) {
    case "span":
    case "sleep":
    case "stage":
    case "workout":
    case "health-workout":
    case "phone":
    case "cycle":
      return { start_ms: content.start_ms, end_ms: content.end_ms };
    case "recovery":
      return { start_ms: Math.min(content.wake_ms, content.strain?.end_ms ?? content.wake_ms),
        end_ms: Math.max(content.wake_ms, content.strain?.end_ms ?? content.wake_ms) };
    case "summary": {
      const start = instant(content.date, "date").start_ms;
      return { start_ms: start, end_ms: start + 86_400_000 };
    }
  }
}

function wakeDays(end_ms: number, settings: DaySettings): string[] {
  return padded([civilDay(end_ms, settings)]);
}

function padded(days: readonly string[]): string[] {
  return days.length === 0 ? [] : [addDays(days[0]!, -1), ...days, addDays(days.at(-1)!, 1)];
}

function withLookback(days: readonly string[]): string[] {
  const out = new Set<string>();
  for (const day of days) for (let after = 0; after <= BASELINE_DAYS; after++) out.add(addDays(day, after));
  return [...out].sort();
}


function spanContent(fed: Fed, view: View, source: string, rest: string): SpanContent | null {
  const [start_ms, end_ms] = rest.split("/").map(Number) as [number, number];
  if (!Number.isSafeInteger(start_ms) || !Number.isSafeInteger(end_ms)) return null;
  const own = end_ms - start_ms > SPAN_MS;
  const row = view.source(source);
  if (row === undefined) return null;
  const gathered: { key: string; reading: Reading | null }[] = [];
  for (const { head, version } of view.records(source, "sample", { start_ms, end_ms })) {
    const span = sampleSpan(version);
    if (span === null || span.start_ms !== start_ms || span.end_ms !== end_ms) continue;
    gathered.push({ key: head.key, reading: readSample(fed, row, version) });
  }
  const finest = new Map<string, number>();
  const choose = (metric: string, series: number) => finest.set(metric, Math.min(finest.get(metric) ?? Infinity, series));
  const copies = new Map<string, Reading>();
  for (const { reading } of gathered) {
    if (reading?.series === undefined) continue;
    choose(reading.metric, reading.series);
    if (reading.series === COPY_SERIES) copies.set(`${reading.metric}\u0000${reading.instrument}`, reading);
  }
  for (const copy of copies.values()) {
    const series = trackerSeries(fed, view, copy, start_ms, end_ms);
    if (series !== null) choose(copy.metric, series);
  }
  const values = new Map<string, { lane: Omit<Lane, "count" | "sum" | "min" | "max">; values: { key: string; value: number }[] }>();
  for (const { key, reading } of gathered) {
    if (reading === null) continue;
    if (reading.series !== undefined && reading.series !== finest.get(reading.metric)) continue;
    const id = `${reading.metric}\u0000${reading.instrument}\u0000${reading.unit}`;
    const entry = values.get(id) ?? { lane: { metric: reading.metric, instrument: reading.instrument, unit: reading.unit }, values: [] };
    entry.values.push({ key, value: reading.value });
    values.set(id, entry);
  }
  if (values.size === 0) return null;
  const lanes = [...values.values()].map(({ lane, values: list }): Lane => {
    const ordered = list.sort((left, right) => compare(left.key, right.key)).map((entry) => entry.value);
    return {
      ...lane,
      count: ordered.length,
      sum: round(ordered.reduce((total, value) => total + value, 0)),
      min: Math.min(...ordered),
      max: Math.max(...ordered),
    };
  }).sort((left, right) => compare(left.metric, right.metric) || compare(left.instrument, right.instrument) || compare(left.unit, right.unit));
  return { kind: "span", source, start_ms, end_ms, own, lanes };
}

type Reading = { metric: string; instrument: string; unit: string; value: number; series?: number };

function readSample(fed: Fed, source: SourceRow, version: Version): Reading | null {
  const item = fed.item(source, version);
  if (item?.item !== "sample") return null;
  const { metric, instrument, unit, value, series } = item;
  const copy = series === undefined && [...fed.owners(instrument) ?? []].some((product) => product !== source.product);
  return { metric, instrument, unit, value, ...(series !== undefined ? { series } : copy && tracked(metric) ? { series: COPY_SERIES } : {}) };
}

function tracked(metric: string): boolean {
  return metric === "heart_rate";
}

function trackerSeries(fed: Fed, view: View, copy: Reading, start_ms: number, end_ms: number): number | null {
  for (const tracker of view.sources({ product: [...fed.owners(copy.instrument) ?? []] })) {
    for (const { version } of view.records(tracker.id, "sample", { start_ms, end_ms })) {
      const span = sampleSpan(version);
      if (span?.start_ms !== start_ms || span.end_ms !== end_ms) continue;
      const item = fed.item(tracker, version);
      if (item?.item === "sample" && item.metric === copy.metric && item.series !== undefined) return item.series;
    }
  }
  return null;
}

function instrumentWorkoutContent(fed: Fed, view: View, source: string, key: string): HealthWorkoutContent | null {
  const read = liveItem(fed, view, source, "workout", key, "instrument-workout");
  const time = read?.version.time;
  if (read === null || time?.end_ms === undefined) return null;
  const { instrument, activity, duration_s, distance, energy, average_heart_rate, max_heart_rate, strain } = read.item;
  return {
    kind: "health-workout", record: { source, key, kind: "workout" }, instrument, start_ms: time.start_ms, end_ms: time.end_ms,
    activity, duration_s, distance, strain, ...stated({ energy, average_heart_rate, max_heart_rate }),
  };
}

function stageContent(fed: Fed, view: View, source: string, key: string): StageContent | null {
  const read = liveItem(fed, view, source, "sample", key, "stage");
  const time = read?.version.time;
  if (read === null || time?.end_ms === undefined) return null;
  const { instrument, stage, recovery } = read.item;
  return { kind: "stage", source, instrument, stage, start_ms: time.start_ms, end_ms: time.end_ms, recovery };
}


function sleepContent(fed: Fed, view: View, source: string, key: string): SleepContent | null {
  const read = liveItem(fed, view, source, "sleep", key, "sleep");
  const time = read?.version.time;
  if (read === null || time === undefined || time.end_ms === undefined) return null;
  const { cycle, nap, stages, efficiency, performance, respiratory_rate } = read.item;
  if (cycle !== null && cycleStated(fed, view, source, cycle)?.sleeps.includes(key) === true) return null;
  return { kind: "sleep", record: { source, key, kind: "sleep" }, start_ms: time.start_ms, end_ms: time.end_ms, nap, stages, efficiency, performance, respiratory_rate };
}

function workoutContent(fed: Fed, view: View, source: string, key: string): WorkoutContent | HealthWorkoutContent | null {
  if (live(fed, view, source, "workout", key)?.item?.item === "instrument-workout") return instrumentWorkoutContent(fed, view, source, key);
  const read = liveItem(fed, view, source, "workout", key, "workout");
  const time = read?.version.time;
  if (read === null || time === undefined || time.end_ms === undefined) return null;
  const row = view.source(source)!;
  for (const { version } of view.records(source, "cycle", { start_ms: time.start_ms - 2 * 86_400_000, end_ms: time.end_ms })) {
    const item = fed.item(row, version);
    if (item?.item === "cycle" && item.states.workouts.includes(key)) return null;
  }
  const { sport, strain, average_heart_rate, max_heart_rate, kilojoule, distance_m } = read.item;
  return {
    kind: "workout", record: { source, key, kind: "workout" }, start_ms: time.start_ms, end_ms: time.end_ms,
    sport, strain, ...stated({ average_heart_rate, max_heart_rate, kilojoule, distance_m }),
  };
}

function stated<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function recoveryContent(fed: Fed, view: View, source: string, key: string): RecoveryContent | null {
  const read = liveItem(fed, view, source, "recovery", key, "recovery");
  if (read === null) return null;
  if (cycleStated(fed, view, source, key)?.recovery === true) return null;
  const recovery = read.item;
  const sleep = recovery.sleep === null ? null : live(fed, view, source, "sleep", recovery.sleep);
  const day = liveItem(fed, view, source, "physio-day", key, "physio-day");
  const dayEnd = day !== null && day.item.closed ? day.version.time?.end_ms ?? null : null;
  const strain = dayEnd === null || day === null ? null : {
    end_ms: dayEnd, strain: day.item.strain, average_heart_rate: day.item.average_heart_rate, max_heart_rate: day.item.max_heart_rate, kilojoule: day.item.kilojoule,
  };
  const wake = sleep?.version.time?.end_ms ?? dayEnd;
  if (wake === null || wake === undefined) return null;
  return {
    kind: "recovery", record: { source, key, kind: "recovery" }, wake_ms: wake,
    score: recovery.score, hrv: recovery.hrv, resting_heart_rate: recovery.resting_heart_rate, strain,
  };
}

function cycleStated(fed: Fed, view: View, source: string, cycleId: string): Cycle["states"] | null {
  return liveItem(fed, view, source, "cycle", cycleId, "cycle")?.item.states ?? null;
}

function cycleContent(fed: Fed, view: View, source: string, key: string): CycleContent | null {
  const read = liveItem(fed, view, source, "cycle", key, "cycle");
  const time = read?.version.time;
  if (read === null || time === undefined) return null;
  const record = { source, key, kind: "cycle" as const };
  const sleeps = read.item.sleeps.map((sleep): SleepContent => ({ kind: "sleep", record, ...sleep }));
  const workouts = read.item.workouts.map((workout): WorkoutContent => ({ kind: "workout", record, ...workout }));
  const recovery: RecoveryContent | null = read.item.recovery === null ? null : { kind: "recovery", record, ...read.item.recovery };
  if (sleeps.length === 0 && workouts.length === 0 && recovery === null) return null;
  return { kind: "cycle", record, start_ms: time.start_ms, end_ms: time.end_ms ?? time.start_ms, sleeps, workouts, recovery };
}

function summaryContent(fed: Fed, view: View, source: string, key: string): SummaryContent | null {
  const read = liveItem(fed, view, source, "day-summary", key, "day-summary");
  if (read === null) return null;
  const { date, move, exercise, stand } = read.item;
  return { kind: "summary", record: { source, key, kind: "day-summary" }, date, move, exercise, stand };
}


export function usageHour(version: { readonly time?: { readonly start_ms: number; readonly end_ms?: number } }): number | null {
  const time = version.time;
  if (time === undefined || time.end_ms !== time.start_ms + HOUR_MS) return null;
  return time.start_ms;
}

function phoneContent(fed: Fed, view: View, source: string, rest: string): PhoneContent | null {
  const start_ms = Number(rest);
  const row = view.source(source);
  if (!Number.isSafeInteger(start_ms) || row === undefined) return null;
  let newest: { captured_ms: number; key: string; usage: Extract<HealthItem, { item: "usage" }> } | null = null;
  for (const { head, version } of view.records(source, "usage", { start_ms, end_ms: start_ms + HOUR_MS })) {
    const usage = fed.item(row, version);
    if (usage?.item !== "usage" || usageHour(version) !== start_ms || usage.captured_ms === null) continue;
    const captured_ms = usage.captured_ms;
    if (newest === null || captured_ms > newest.captured_ms || (captured_ms === newest.captured_ms && head.key > newest.key)) {
      newest = { captured_ms, key: head.key, usage };
    }
  }
  if (newest === null) return null;
  const { seconds, categories } = newest.usage;
  if (seconds === null || (seconds <= 0 && categories.length === 0)) return null;
  return { kind: "phone", source, start_ms, end_ms: start_ms + HOUR_MS, seconds, categories };
}


function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
