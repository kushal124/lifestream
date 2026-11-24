import {
  addDays, daysOf, digest, instant, render,
  type DaySettings, type ExtractRow, type Focus as Stated, type Json, type PhoneAdapter, type RecordRef, type SourceRow, type SourceSelector, type Version, type View,
} from "@lifestreamprotocol/core";
import { drawnFrom, linesOnly, type DayInput, type DayLine, type Family, type FamilyInput, type Given, type Touched } from "../family.js";

export const PHONE_FAMILY = "phone";
export const STRETCH_GAP_MS = 5 * 60_000;
export const PAIR_REACH_MS = 6 * 3_600_000;
const DAY_MS = 86_400_000;
const LOCAL_SEGMENT = "local/";

export interface PhoneSettings {
  devices?: Readonly<Record<string, string>>;
}

export interface Focus {
  app: string;
  record: RecordRef;
  start_ms: number;
  end_ms: number;
  stated: "both" | "start" | "end";
}

export interface PhoneDay {
  device: string;
  day: string;
  focus: Focus[];
}

interface Event {
  record: RecordRef;
  at: number;
  app: string;
  in: boolean;
}

export function phoneFamily(settings: PhoneSettings = {}): (given: readonly Given<PhoneAdapter>[]) => Family {
  const devices = settings.devices ?? {};
  return (given) => {
    const byProduct = new Map(given.map((each) => [each.product, each.adapter]));
    const logs: Logs = { sources: { product: given.map((each) => each.product) }, adapterOf: (source) => byProduct.get(source.product) };
    return {
      name: PHONE_FAMILY,
      type: "device-activity",
      code: `1:${digest(devices as Json)}`,
      inputs: given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),

      touched(changes, view) {
        const units = new Set<string>();
        for (const change of changes) {
          const source = view.source(change.record.source);
          for (const version of [change.before, change.after]) {
            const at = version?.time?.start_ms;
            const device = version === undefined || source === undefined ? undefined : stated(logs, source, version)?.device;
            if (at === undefined || device === undefined) continue;
            for (let day = utcDay(at - PAIR_REACH_MS); day <= utcDay(at + PAIR_REACH_MS); day = addDays(day, 1)) units.add(unitOf(device, day));
          }
        }
        return [...units].sort().map((unit): Touched => ({ unit }));
      },

      extract(unit, view) {
        const parsed = parseUnit(unit);
        if (parsed === null) return null;
        const start = instant(parsed.day, "date").start_ms;
        const events = readEvents(view, logs, parsed.device, start - PAIR_REACH_MS, start + DAY_MS + PAIR_REACH_MS);
        if (events === null) return null;
        const focus = focusOf(events, start, start + DAY_MS);
        if (focus.length === 0) return null;
        const json = { device: parsed.device, day: parsed.day, focus } satisfies PhoneDay as unknown as Json;
        return {
          content: json,
          start_ms: Math.min(...focus.map((each) => each.start_ms)),
          end_ms: Math.max(...focus.map((each) => each.end_ms)),
          reading: digest(json),
        };
      },

      days: (extract: ExtractRow, day: DaySettings) =>
        daysOf({ start_ms: extract.start_ms! - STRETCH_GAP_MS, end_ms: extract.end_ms! + STRETCH_GAP_MS + 1, precision: "ms" }, day),

      day: linesOnly((input) => phoneLines(input, devices)),
    };
  };
}


interface Logs {
  sources: SourceSelector;
  adapterOf(source: SourceRow): PhoneAdapter | undefined;
}

function stated(logs: Logs, source: SourceRow, version: Version): Stated | null {
  const adapter = logs.adapterOf(source);
  return adapter === undefined || !adapter.kinds.includes(version.kind) ? null : adapter.focus({ source, version });
}

function readEvents(view: View, logs: Logs, device: string, from: number, to: number): Event[] | null {
  const events = new Map<string, Event>();
  for (const source of view.sources(logs.sources)) {
    let checked = false;
    for (const kind of logs.adapterOf(source)?.kinds ?? []) {
      for (const { head, version } of view.records(source.id, kind, { start_ms: from, end_ms: to })) {
        if (head.start_ms! < from || head.start_ms! >= to) continue;
        const focus = stated(logs, source, version);
        if (focus === null || focus.device !== device) continue;
        const record = { source: source.id, kind, key: head.key };
        if (!checked && ownSegment(view, record)) return null;
        checked = true;
        if (!events.has(head.key)) events.set(head.key, { record, at: head.start_ms!, app: focus.app, in: focus.in });
      }
    }
  }
  return [...events.values()].sort((left, right) => left.at - right.at || compare(left.record.key, right.record.key));
}

function ownSegment(view: View, record: RecordRef): boolean {
  return view.history(record).some((statement) => statement.origin === "source" && statement.locator?.startsWith(LOCAL_SEGMENT) === true);
}

function focusOf(events: readonly Event[], start: number, end: number): Focus[] {
  const next = new Map<number, number>();
  const previous = new Map<number, number>();
  const last = new Map<string, number>();
  events.forEach((event, index) => {
    const before = last.get(event.app);
    if (before !== undefined) {
      next.set(before, index);
      previous.set(index, before);
    }
    last.set(event.app, index);
  });
  const paired = (opening: number | undefined, closing: number | undefined) => opening !== undefined && closing !== undefined
    && events[opening]!.in && !events[closing]!.in && events[closing]!.at - events[opening]!.at <= PAIR_REACH_MS;
  const out: Focus[] = [];
  events.forEach((event, index) => {
    if (event.at < start || event.at >= end) return;
    if (event.in) {
      const closing = next.get(index);
      out.push(paired(index, closing)
        ? { app: event.app, record: event.record, start_ms: event.at, end_ms: events[closing!]!.at, stated: "both" }
        : { app: event.app, record: event.record, start_ms: event.at, end_ms: event.at, stated: "start" });
    } else if (!paired(previous.get(index), index)) {
      out.push({ app: event.app, record: event.record, start_ms: event.at, end_ms: event.at, stated: "end" });
    }
  });
  return out;
}


function phoneLines(input: DayInput, devices: Readonly<Record<string, string>>): DayLine[] {
  const byDevice = new Map<string, { focus: Focus; unit: string }[]>();
  for (const extract of input.extracts) {
    const content = extract.content as unknown as PhoneDay;
    byDevice.set(content.device, [...byDevice.get(content.device) ?? [], ...content.focus.map((focus) => ({ focus, unit: extract.unit }))]);
  }
  const lines: DayLine[] = [];
  for (const [device, focus] of [...byDevice].sort(([left], [right]) => compare(left, right))) {
    const all = focus.sort((left, right) => left.focus.start_ms - right.focus.start_ms || compare(left.focus.record.key, right.focus.record.key));
    const name = devices[device] ?? `Device ${device.split("-")[0]}`;
    let stretch: { focus: Focus; unit: string }[] = [];
    let reach = 0;
    for (const each of all) {
      if (stretch.length > 0 && each.focus.start_ms - reach > STRETCH_GAP_MS) {
        lines.push(stretchLine(name, stretch));
        stretch = [];
      }
      reach = stretch.length === 0 ? each.focus.end_ms : Math.max(reach, each.focus.end_ms);
      stretch.push(each);
    }
    if (stretch.length > 0) lines.push(stretchLine(name, stretch));
  }
  return lines;
}

function stretchLine(name: string, stretch: readonly { focus: Focus; unit: string }[]): DayLine {
  const seconds = new Map<string, number>();
  const openEnded = new Set<string>();
  const openStarted = new Set<string>();
  for (const { focus } of stretch) {
    if (focus.stated === "both") seconds.set(focus.app, (seconds.get(focus.app) ?? 0) + (focus.end_ms - focus.start_ms) / 1000);
    else (focus.stated === "start" ? openEnded : openStarted).add(focus.app);
  }
  const timed = [...seconds].sort((left, right) => right[1] - left[1] || compare(left[0], right[0]))
    .map(([app, total]) => `${app} ${total < 30 ? "<1" : Math.round(total / 60)} min`);
  const words = [
    ...timed,
    ...[...openEnded].sort(compare).map((app) => `${app} (no end stated)`),
    ...[...openStarted].sort(compare).map((app) => `${app} (no start stated)`),
  ];
  const first = stretch[0]!;
  const start_ms = first.focus.start_ms;
  const end_ms = Math.max(...stretch.map(({ focus }) => focus.end_ms));
  const units = [...new Set(stretch.map(({ unit }) => unit))];
  return {
    family: PHONE_FAMILY, unit: first.unit, units, ...drawnFrom(units, stretch.map(({ focus }) => focus.record)), start_ms, end_ms: end_ms > start_ms ? end_ms : null,
    text: `${name}: ${words.join(", ")}`, record: first.focus.record,
  };
}


export function unitOf(device: string, day: string): string {
  return `${device}/${day}`;
}

export function parseUnit(unit: string): { device: string; day: string } | null {
  const match = /^([^/:]+)\/(\d{4}-\d{2}-\d{2})$/u.exec(unit);
  return match === null ? null : { device: match[1]!, day: match[2]! };
}

function utcDay(ms: number): string {
  return render(ms, "UTC", "day");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
