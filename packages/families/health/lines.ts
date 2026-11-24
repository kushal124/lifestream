import { addDays, dayBounds, instant, render, sourceName } from "@lifestreamprotocol/core";
import { accountsOf, factId, type DayFact, type DayInput, type DayLine, type DayProjection } from "../family.js";
import {
  BASELINE_DAYS, SLEEP_STAGES,
  type HealthContent, type HealthWorkoutContent, type Lane, type PhoneContent, type RecoveryContent, type SleepContent, type SpanContent, type StageContent, type WorkoutContent,
} from "./family.js";

const TOP_FRACTION = 0.05;
const WINDOW_METRICS = ["heart_rate", "stress"] as const;
export const MEASURE = /^(-?\d+(?:\.\d+)?) (\S+)$/u;
const TOTAL_METRIC = /^(?:steps|active_energy|distance|flights)$/u;
const SHORT_WORDS: Readonly<Record<string, string>> = {
  heart_rate: "hr", resting_heart_rate: "resting hr", respiratory_rate: "resp rate", walking_speed: "walk speed",
};
const NIGHT_GAP_MS = 3_600_000;

export interface Instruments {
  named(instrument: string): string;
  owners(instrument: string): ReadonlySet<string> | undefined;
  own(source: string): string;
}

export function healthDay(input: DayInput, instruments: Instruments): DayProjection {
  const word = (instrument: string) => instruments.named(instrument);
  const ownOverlaps = (instrument: string, own: readonly { record: { source: string }; start_ms: number; end_ms: number }[], copy: { start_ms: number; end_ms: number }) => {
    const owners = instruments.owners(instrument);
    return owners !== undefined && own.some((item) => owners.has(sourceName(item.record.source).product) && item.start_ms < copy.end_ms && item.end_ms > copy.start_ms);
  };
  const contents = input.extracts.flatMap((extract) => {
    const content = extract.content as unknown as HealthContent;
    if (content.kind !== "cycle") return [{ unit: extract.unit, content }];
    return [...content.sleeps, ...content.workouts, ...(content.recovery === null ? [] : [content.recovery])]
      .map((part) => ({ unit: extract.unit, content: part as HealthContent }));
  });
  const lines: DayLine[] = [];
  const days = new DayAccount(input.day);
  const facts: DayFact[] = [];
  const spans = contents.flatMap(({ unit, content }) => content.kind === "span" ? [{ unit, content }] : []);
  const recoveries = contents.flatMap(({ unit, content }) => content.kind === "recovery" ? [{ unit, content }] : []);
  const vitals = vitalsLine(input, spans, recoveries);
  if (vitals !== null) lines.push(vitals);
  const { start_ms, end_ms } = dayBounds(input.day, input.settings);
  const today = (ms: number) => ms >= start_ms && ms < end_ms;
  const steps = chosenSteps(spans.map(({ content }) => content), { start_ms, end_ms });
  if (steps !== null) {
    const counted = spans.flatMap(({ unit, content }) =>
      today(content.start_ms) && content.lanes.some((lane) => lane.metric === "steps" && lane.instrument === steps.instrument) ? [unit] : []);
    days.state(word(steps.instrument), { steps: steps.steps }, vitals === null ? null : 0, counted);
  }
  const clock = (ms: number) => render(ms, input.settings.zone, "minute").slice(11);
  const workouts = contents.flatMap(({ content }) => content.kind === "workout" ? [content] : []);
  const facts_: DayFact[] = [];
  lines.push(...slotRows(word, contents.flatMap(({ unit, content }) =>
    content.kind === "span" && !content.own && today(content.start_ms) ? [{ unit, span: content }] : [])));
  for (const { unit, content } of contents) {
    switch (content.kind) {
      case "span":
        if (content.own && content.start_ms < end_ms && content.end_ms > start_ms) {
          lines.push({ family: "health", unit, units: [unit], start_ms: content.start_ms, end_ms: content.end_ms, text: laneRow(word, content.lanes) });
        }
        break;
      case "phone":
        lines.push({ family: "health", unit, units: [unit], start_ms: content.start_ms, end_ms: content.end_ms, text: phoneText(content) });
        break;
      case "sleep":
        if (content.nap) {
          lines.push({ family: "health", unit, units: [unit], start_ms: content.start_ms, end_ms: content.end_ms,
            text: `nap — ${sleepFacts(content)}`, record: content.record });
        } else if (today(content.end_ms)) {
          const line = lines.push({ family: "health", unit, units: [unit], start_ms: null, end_ms: null, heading: true,
            text: `Sleep ${clock(content.start_ms)}–${clock(content.end_ms)}, wake at ${clock(content.end_ms)}: ${sleepFacts(content)}`,
            record: content.record }) - 1;
          days.state(instruments.own(content.record.source), sleepMeasures(content), line, [unit]);
        }
        break;
      case "workout": {
        const facts = workoutFacts(content.sport, content.end_ms - content.start_ms, {
          distance: content.distance_m == null ? null : kilometres(content.distance_m),
          average_heart_rate: content.average_heart_rate ?? null, max_heart_rate: content.max_heart_rate ?? null,
          energy: content.kilojoule == null ? null : `${Math.round(content.kilojoule / KJ_PER_KCAL).toLocaleString("en-US")} kcal`,
          strain: content.strain,
        });
        const line = lines.push({ family: "health", unit, units: [unit], start_ms: content.start_ms, end_ms: content.end_ms,
          text: `workout — ${facts.join(", ")}`, record: content.record }) - 1;
        facts_.push(workoutFact(unit, content, instruments.own(content.record.source), line));
        break;
      }
      case "health-workout": {
        if (ownOverlaps(content.instrument, workouts, content)) break;
        const facts = workoutFacts(content.activity, content.duration_s === null ? content.end_ms - content.start_ms : content.duration_s * 1000, {
          distance: content.distance === null ? null : measure(content.distance, "m", kilometres),
          average_heart_rate: content.average_heart_rate ?? null, max_heart_rate: content.max_heart_rate ?? null,
          energy: content.energy == null ? null : measure(content.energy, "kcal", (kcal) => `${Math.round(kcal).toLocaleString("en-US")} kcal`),
          strain: content.strain,
        });
        const line = lines.push({ family: "health", unit, units: [unit], start_ms: content.start_ms, end_ms: content.end_ms,
          text: `workout — ${facts.join(", ")} (${word(content.instrument)})`, record: content.record }) - 1;
        facts_.push(workoutFact(unit, content, word(content.instrument), line));
        break;
      }
      case "recovery": {
        const facts = [fact("score", content.score), fact("HRV", content.hrv), fact("resting heart rate", content.resting_heart_rate)]
          .filter((value) => value !== null);
        const line = lines.push({ family: "health", unit, units: [unit], start_ms: content.wake_ms, end_ms: null,
          text: facts.length === 0 ? "recovery" : `recovery — ${facts.join(", ")}`, record: content.record }) - 1;
        if (today(content.wake_ms)) {
          days.state(instruments.own(content.record.source), stated({ recovery: content.score, hrv_ms: content.hrv, rhr_bpm: content.resting_heart_rate }), line, [unit]);
        }
        const strain = strainText(content);
        if (strain !== null) {
          lines.push({ family: "health", unit, units: [unit], start_ms: content.strain!.end_ms, end_ms: null, text: strain,
            record: content.record.kind === "cycle" ? content.record : { ...content.record, kind: "physio-day" } });
        }
        break;
      }
      case "summary": {
        const [burned, goal, energyUnit] = content.move;
        lines.push({ family: "health", unit, units: [unit], start_ms: instant(content.date, "date").start_ms, end_ms: null, date_only: true,
          text: `Activity: move ${burned} of ${goal} ${energyUnit}, exercise ${content.exercise[0]} of ${content.exercise[1]} min, stand ${content.stand[0]} of ${content.stand[1]} h`,
          record: content.record });
        break;
      }
    }
  }
  const sleeps = contents.flatMap(({ content }) => content.kind === "sleep" ? [content] : []);
  const cycles = input.extracts.flatMap((extract) => {
    const content = extract.content as unknown as HealthContent;
    return content.kind === "cycle" ? [content] : [];
  });
  const cycleHolds = (instrument: string, wake_ms: number) => {
    const owners = instruments.owners(instrument);
    return owners !== undefined && cycles.some((cycle) => owners.has(sourceName(cycle.record.source).product) && cycle.start_ms < wake_ms && wake_ms <= cycle.end_ms);
  };
  for (const found of nights(contents.flatMap(({ unit, content }) => content.kind === "stage" ? [{ unit, stage: content }] : []))) {
    if (!today(found.end_ms)) continue;
    if (ownOverlaps(found.instrument, sleeps, found)) continue;
    const night = cycleHolds(found.instrument, found.end_ms) ? { ...found, stages: found.stages.map((stage) => ({ ...stage, recovery: null })) } : found;
    const line = lines.push({ family: "health", unit: night.units[0]!, units: night.units, start_ms: null, end_ms: null, heading: true,
      text: `Sleep ${clock(night.start_ms)}–${clock(night.end_ms)}, wake at ${clock(night.end_ms)}: ${nightFacts(night)} (${word(night.instrument)})` }) - 1;
    days.state(word(night.instrument), nightMeasures(night), line, night.units);
  }
  return { lines, facts: [...facts_, ...days.facts()] };
}


class DayAccount {
  readonly #by = new Map<string, { measures: Record<string, number>; lines: Set<number>; units: Set<string> }>();
  constructor(readonly day: string) {}

  state(instrument: string, measures: Readonly<Record<string, number>>, line: number | null, units: readonly string[]): void {
    if (Object.keys(measures).length === 0) return;
    const entry = this.#by.get(instrument) ?? { measures: {}, lines: new Set<number>(), units: new Set<string>() };
    for (const [name, value] of Object.entries(measures)) entry.measures[name] = name in entry.measures && ADDS.has(name) ? entry.measures[name]! + value : value;
    if (line !== null) entry.lines.add(line);
    for (const unit of units) entry.units.add(unit);
    this.#by.set(instrument, entry);
  }

  facts(): DayFact[] {
    const at = instant(this.day, "date").start_ms;
    return [...this.#by].map(([instrument, { measures, lines, units }]): DayFact => ({
      of: "days", id: factId("days", `${this.day}/${instrument}`), time_ms: at, start_ms: at, end_ms: at, date_only: true,
      keys: { instrument }, measures, who: [], from: { units: [...units].sort(compare), instrument }, lines: [...lines].sort((left, right) => left - right),
    }));
  }
}

const ADDS = new Set(["asleep_min", "in_bed_min", "steps"]);

function sleepMeasures(sleep: SleepContent): Record<string, number> {
  const stages = sleep.stages;
  if (stages === null) return {};
  const asleep = stages.light === null || stages.deep === null || stages.rem === null ? null : (stages.light + stages.deep + stages.rem) / MINUTE_MS;
  return stated({ asleep_min: asleep, in_bed_min: stages.in_bed === null ? null : stages.in_bed / MINUTE_MS });
}

function nightMeasures(night: Night): Record<string, number> {
  const inBed = covering(night.stages.filter((stage) => stage.stage === "in bed"));
  const asleep = covering(night.stages.filter((stage) => SLEEPING.has(stage.stage)));
  const recovery = night.stages.filter((stage) => stage.recovery !== null).sort((left, right) => left.end_ms - right.end_ms).at(-1)?.recovery ?? null;
  return stated({ in_bed_min: inBed === 0 ? null : inBed / MINUTE_MS, asleep_min: asleep === 0 ? null : asleep / MINUTE_MS, recovery });
}

const SLEEPING = new Set(["asleep", "core", "deep", "REM"]);
const MINUTE_MS = 60_000;

function workoutFact(unit: string, workout: WorkoutContent | HealthWorkoutContent, instrument: string, line: number): DayFact {
  const own = workout.kind === "workout";
  const what = workout.record.kind === "cycle" ? `${workout.record.source}/cycle-workout/${workout.start_ms}` : `${workout.record.source}/${workout.record.key}`;
  const sport = own ? workout.sport : workout.activity;
  const measures = own ? stated({
    minutes: (workout.end_ms - workout.start_ms) / MINUTE_MS,
    km: workout.distance_m == null ? null : workout.distance_m / 1000,
    kcal: workout.kilojoule == null ? null : workout.kilojoule / KJ_PER_KCAL,
    strain: workout.strain, avg_hr: workout.average_heart_rate, max_hr: workout.max_heart_rate,
  }) : stated({
    minutes: (workout.duration_s === null ? workout.end_ms - workout.start_ms : workout.duration_s * 1000) / MINUTE_MS,
    km: workout.distance === null ? null : statedIn(workout.distance, { m: 0.001, km: 1 }),
    kcal: workout.energy == null ? null : statedIn(workout.energy, { kcal: 1, kJ: 1 / KJ_PER_KCAL }),
    strain: workout.strain, avg_hr: workout.average_heart_rate, max_hr: workout.max_heart_rate,
  });
  return {
    of: "workouts", id: factId("workouts", what), time_ms: workout.start_ms, start_ms: workout.start_ms, end_ms: workout.end_ms,
    keys: { ...(sport === null ? {} : { sport }), instrument }, measures, who: [],
    from: { units: [unit], record: workout.record, alone: true, instrument }, lines: [line],
  };
}

function statedIn(value: string, factors: Readonly<Record<string, number>>): number | null {
  const m = MEASURE.exec(value);
  const factor = m === null ? undefined : factors[m[2]!];
  return factor === undefined ? null : Number(m![1]) * factor;
}

function stated(measures: Readonly<Record<string, number | null | undefined>>): Record<string, number> {
  return Object.fromEntries(Object.entries(measures).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1])));
}


interface Night { units: string[]; instrument: string; start_ms: number; end_ms: number; stages: StageContent[] }

function nights(stages: readonly { unit: string; stage: StageContent }[]): Night[] {
  const byInstrument = new Map<string, { unit: string; stage: StageContent }[]>();
  for (const entry of stages) {
    const id = `${entry.stage.source}\u0000${entry.stage.instrument}`;
    byInstrument.set(id, [...byInstrument.get(id) ?? [], entry]);
  }
  const out: Night[] = [];
  for (const list of byInstrument.values()) {
    let night: Night | null = null;
    for (const { unit, stage } of list.sort((left, right) => left.stage.start_ms - right.stage.start_ms || compare(left.unit, right.unit))) {
      if (night !== null && stage.start_ms <= night.end_ms + NIGHT_GAP_MS) {
        night.end_ms = Math.max(night.end_ms, stage.end_ms);
        night.stages.push(stage);
        if (!night.units.includes(unit)) night.units.push(unit);
      } else {
        night = { units: [unit], instrument: stage.instrument, start_ms: stage.start_ms, end_ms: stage.end_ms, stages: [stage] };
        out.push(night);
      }
    }
  }
  return out;
}

function nightFacts(night: Night): string {
  const facts = SLEEP_STAGES.flatMap((word) => {
    const covered = covering(night.stages.filter((stage) => stage.stage === word));
    return covered === 0 ? [] : [`${word} ${duration(covered)}`];
  });
  const recovery = night.stages.filter((stage) => stage.recovery !== null).sort((left, right) => left.end_ms - right.end_ms).at(-1)?.recovery ?? null;
  const stated = [...facts, fact("recovery", recovery)].filter((value) => value !== null);
  return stated.length === 0 ? `duration ${duration(night.end_ms - night.start_ms)}` : stated.join(", ");
}

function covering(intervals: readonly { start_ms: number; end_ms: number }[]): number {
  let total = 0;
  let reached = -Infinity;
  for (const { start_ms, end_ms } of [...intervals].sort((left, right) => left.start_ms - right.start_ms)) {
    const from = Math.max(start_ms, reached);
    if (end_ms > from) total += end_ms - from;
    reached = Math.max(reached, end_ms);
  }
  return total;
}


function slotRows(instrumentWord: (instrument: string) => string, spans: readonly { unit: string; span: SpanContent }[]): DayLine[] {
  const slots = new Map<number, { unit: string; span: SpanContent }[]>();
  for (const entry of spans) slots.set(entry.span.start_ms, [...slots.get(entry.span.start_ms) ?? [], entry]);
  const lines: DayLine[] = [];
  for (const slot of slots.values()) {
    slot.sort((left, right) => compare(left.unit, right.unit));
    const byInstrument = new Map<string, string[]>();
    for (const { span } of slot) {
      for (const lane of [...span.lanes].sort((left, right) => compare(instrumentWord(left.instrument), instrumentWord(right.instrument)))) {
        const metrics = byInstrument.get(instrumentWord(lane.instrument)) ?? [];
        const word = metricWord(lane.metric);
        if (!metrics.includes(word)) metrics.push(word);
        byInstrument.set(instrumentWord(lane.instrument), metrics);
      }
    }
    const title = [...byInstrument].map(([instrument, metrics]) => `${instrument} ${metrics.join(", ")}`).join("; ");
    for (const { unit, span } of slot) {
      lines.push({ family: "health", unit, units: [unit], start_ms: span.start_ms, end_ms: span.end_ms,
        text: laneRow(instrumentWord, span.lanes, { short: true, instruments: byInstrument.size > 1 }), block: { key: `health/${title}`, title } });
    }
  }
  return lines;
}


function phoneText(phone: PhoneContent): string {
  const minutes = (seconds: number) => seconds < 30 ? "<1 min" : `${Math.round(seconds / 60)} min`;
  return [`Phone: ${minutes(phone.seconds)}`, ...phone.categories.map((category) => `${category.name} ${minutes(category.seconds)}`)].join(", ");
}


interface Window { start_ms: number; end_ms: number; average: number }

export function parseUnit(unit: string): { kind: string; source: string; rest: string } {
  const first = unit.indexOf("/");
  const second = unit.indexOf("/", first + 1);
  if (first < 0 || second < 0) throw new TypeError(`not a health unit: ${JSON.stringify(unit)}`);
  return { kind: unit.slice(0, first), source: unit.slice(first + 1, second), rest: unit.slice(second + 1) };
}

function vitalsLine(input: DayInput, unitSpans: readonly { unit: string; content: SpanContent }[], unitRecoveries: readonly { unit: string; content: RecoveryContent }[]): DayLine | null {
  const { day, settings } = input;
  const spans = unitSpans.map(({ content }) => content);
  const recoveries = unitRecoveries.map(({ content }) => content);
  const today = dayBounds(day, settings);
  const from = dayBounds(addDays(day, -BASELINE_DAYS), settings).start_ms;
  const inToday = (ms: number) => ms >= today.start_ms && ms < today.end_ms;
  const inBaseline = (ms: number) => ms >= from && ms < today.start_ms;
  const parts: string[] = [];
  let any = false;
  for (const metric of WINDOW_METRICS) {
    const windows = spans.filter((span) => !span.own).flatMap((span) => span.lanes
      .filter((lane) => lane.metric === metric && lane.count > 0)
      .map((lane): Window => ({ start_ms: span.start_ms, end_ms: span.end_ms, average: lane.sum / lane.count })));
    const now = windows.filter((window) => inToday(window.start_ms));
    if (now.length > 0) any = true;
    parts.push(windowWords(metric.replaceAll("_", " "), now, windows.filter((window) => inBaseline(window.start_ms)),
      (ms) => render(ms, settings.zone, "minute", day)));
  }
  const prior = Array.from({ length: BASELINE_DAYS }, (_, index) => addDays(day, index - BASELINE_DAYS));
  const steps = dayTotal(day, prior, (d) => daySteps(spans, dayBounds(d, settings)));
  if (steps !== null) parts.push(totalWords("steps", steps, (value) => Math.round(value).toLocaleString("en-US")));
  const strain = dayTotal(day, prior, (d) => dayStrain(recoveries, dayBounds(d, settings)));
  if (strain !== null) parts.push(totalWords("strain", strain, oneDecimal));
  if (!any && steps === null && strain === null) return null;
  const summed = (window: { start_ms: number; end_ms: number }) => [
    ...unitSpans.filter(({ content }) => content.start_ms >= window.start_ms && content.start_ms < window.end_ms && content.lanes.some((lane) =>
      lane.metric === "steps" || (!content.own && lane.count > 0 && (WINDOW_METRICS as readonly string[]).includes(lane.metric)))),
    ...unitRecoveries.filter(({ content }) => dayStrain([content], window) !== null),
  ].map(({ unit }) => unit);
  const units = summed(today);
  return {
    family: "health", unit: `vitals/${day}`, units: [...new Set(units)].sort(compare),
    accounts: accountsOf(summed({ start_ms: from, end_ms: today.end_ms }).map((unit) => parseUnit(unit).source)), start_ms: null, end_ms: null, heading: true,
    text: `Vitals against ${shortDay(prior[0]!)}–${shortDay(prior.at(-1)!)}: ${parts.join("; ")}`,
  };
}

function windowWords(word: string, today: readonly Window[], baseline: readonly Window[], clock: (ms: number) => string): string {
  if (baseline.length === 0) return `${word} has no baseline yet`;
  const sorted = baseline.map((window) => window.average).sort((left, right) => left - right);
  const threshold = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * (1 - TOP_FRACTION)) - 1))]!;
  const runs: { start_ms: number; end_ms: number; peak: number }[] = [];
  for (const window of [...today].sort((left, right) => left.start_ms - right.start_ms)) {
    if (window.average < threshold) continue;
    const last = runs.at(-1);
    if (last !== undefined && last.end_ms === window.start_ms) {
      last.end_ms = window.end_ms;
      last.peak = Math.max(last.peak, window.average);
    } else runs.push({ ...window, peak: window.average });
  }
  if (runs.length === 0) return `${word} never above ${oneDecimal(threshold)}`;
  return `${word} high, over ${oneDecimal(threshold)}, at ${runs.map((run) =>
    `${span(clock(run.start_ms), clock(run.end_ms))} (peak avg ${oneDecimal(run.peak)})`).join(", ")}`;
}

interface Total { value: number; median: number | null; days: number; rank: "highest" | "lowest" | null }

function dayTotal(day: string, prior: readonly string[], read: (day: string) => number | null): Total | null {
  const value = read(day);
  if (value === null) return null;
  const sorted = prior.map(read).filter((total) => total !== null).sort((left, right) => left - right);
  const median = sorted.length === 0 ? null : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]!
    : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
  const rank = sorted.length === 0 ? null : value > sorted.at(-1)! ? "highest" : value < sorted[0]! ? "lowest" : null;
  return { value, median, days: sorted.length, rank };
}

function daySteps(spans: readonly SpanContent[], window: { start_ms: number; end_ms: number }): number | null {
  return chosenSteps(spans, window)?.steps ?? null;
}

function chosenSteps(spans: readonly SpanContent[], window: { start_ms: number; end_ms: number }): { instrument: string; steps: number } | null {
  const byInstrument = new Map<string, number>();
  for (const span of spans) {
    if (span.start_ms < window.start_ms || span.start_ms >= window.end_ms) continue;
    for (const lane of span.lanes) if (lane.metric === "steps") byInstrument.set(lane.instrument, (byInstrument.get(lane.instrument) ?? 0) + lane.sum);
  }
  const [chosen] = [...byInstrument].sort(([left, a], [right, b]) => b - a || compare(left, right));
  return chosen === undefined ? null : { instrument: chosen[0], steps: chosen[1] };
}

function dayStrain(recoveries: readonly RecoveryContent[], window: { start_ms: number; end_ms: number }): number | null {
  const values = recoveries.flatMap((recovery) => recovery.strain !== null && recovery.strain.strain !== null &&
    recovery.strain.end_ms > window.start_ms && recovery.strain.end_ms <= window.end_ms ? [recovery.strain.strain] : []);
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0);
}

function totalWords(word: string, total: Total, format: (value: number) => string): string {
  const median = total.median === null ? "no prior days" : `median ${format(total.median)} over ${total.days} prior days`;
  return `${word} ${format(total.value)} (${median}${total.rank === null ? "" : `, ${total.rank} of these days`})`;
}


function sleepFacts(sleep: SleepContent): string {
  const stages = sleep.stages;
  const facts = stages === null ? [] : [
    stages.in_bed === null ? null : `in bed ${duration(stages.in_bed)}`,
    stages.light === null ? null : `light ${duration(stages.light)}`,
    stages.deep === null ? null : `deep ${duration(stages.deep)}`,
    stages.rem === null ? null : `REM ${duration(stages.rem)}`,
    stages.awake === null ? null : `awake ${duration(stages.awake)}`,
    stages.cycles === null ? null : `${oneDecimal(stages.cycles)} cycle${stages.cycles === 1 ? "" : "s"}`,
    stages.disturbances === null ? null : `${oneDecimal(stages.disturbances)} disturbance${stages.disturbances === 1 ? "" : "s"}`,
  ];
  facts.push(
    sleep.efficiency === null ? null : `efficiency ${oneDecimal(sleep.efficiency)}%`,
    sleep.performance === null ? null : `performance ${oneDecimal(sleep.performance)}%`,
    fact("respiratory rate", sleep.respiratory_rate),
  );
  const stated = facts.filter((value) => value !== null);
  return stated.length === 0 ? `duration ${duration(sleep.end_ms - sleep.start_ms)}` : stated.join(", ");
}

function strainText(recovery: RecoveryContent): string | null {
  const strain = recovery.strain;
  if (strain === null) return null;
  const facts = [fact("day strain", strain.strain), fact("average heart rate", strain.average_heart_rate), fact("max", strain.max_heart_rate),
    strain.kilojoule === null ? null : `${Math.round(strain.kilojoule).toLocaleString("en-US")} kJ`].filter((value) => value !== null);
  return facts.length === 0 ? null : facts.join(", ");
}

function laneRow(instrumentWord: (instrument: string) => string, lanes: readonly Lane[], options: { short?: boolean; instruments?: boolean } = {}): string {
  const instruments = new Set(lanes.map((lane) => instrumentWord(lane.instrument)));
  const named = options.instruments ?? true;
  const shared = instruments.size === 1 ? [...instruments][0]! : null;
  const row = lanes.map((lane) => {
    const word = (options.short === true ? SHORT_WORDS[lane.metric] : undefined) ?? metricWord(lane.metric);
    const suffix = lane.unit === "count" || lane.unit === "score" || lane.unit === "count/min" ? "" : ` ${lane.unit}`;
    const values = TOTAL_METRIC.test(lane.metric)
      ? (lane.metric === "steps" ? Math.round(lane.sum).toLocaleString("en-US") : oneDecimal(lane.sum))
      : lane.min === lane.max ? oneDecimal(lane.min) : `${oneDecimal(lane.min)}–${oneDecimal(lane.max)} avg ${oneDecimal(lane.sum / lane.count)}`;
    return `${word} ${values}${suffix}${named && shared === null ? ` (${instrumentWord(lane.instrument)})` : ""}`;
  }).join("; ");
  return named && shared !== null ? `${row} (${shared})` : row;
}

function metricWord(metric: string): string {
  return metric === "spo2" ? "SpO2" : metric.replaceAll("_", " ");
}

function span(start: string, end: string): string {
  const date = start.length > 5 ? start.slice(0, 11) : "";
  return `${start}–${date !== "" && end.startsWith(date) ? end.slice(11) : end}`;
}

const KJ_PER_KCAL = 4.184;

function workoutFacts(sport: string | null, duration_ms: number, stated: {
  distance: string | null; average_heart_rate: number | null; max_heart_rate: number | null; energy: string | null; strain: number | null;
}): string[] {
  return [
    sport, `duration ${duration(duration_ms)}`,
    stated.distance === null ? null : `distance ${stated.distance}`,
    stated.average_heart_rate === null ? null : `average heart rate ${Math.round(stated.average_heart_rate)}`,
    stated.max_heart_rate === null ? null : `max heart rate ${Math.round(stated.max_heart_rate)}`,
    stated.energy === null ? null : `energy ${stated.energy}`,
    fact("strain", stated.strain),
  ].filter((value) => value !== null);
}

function kilometres(metres: number): string {
  return `${(metres / 1000).toFixed(2)} km`;
}

function measure(stated: string, unit: string, say: (value: number) => string): string {
  const m = MEASURE.exec(stated);
  return m !== null && m[2] === unit ? say(Number(m[1])) : stated;
}

function fact(label: string, value: number | null): string | null {
  return value === null ? null : `${label} ${oneDecimal(value)}`;
}

function oneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/u, "");
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function shortDay(day: string): string {
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(day.slice(5, 7)) - 1]!;
  return `${Number(day.slice(8, 10))} ${month}`;
}
