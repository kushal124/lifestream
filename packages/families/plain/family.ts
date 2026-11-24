import {
  daysOf, digest, instant, render,
  type DaySettings, type ExtractRow, type Instant, type Json, type Line, type LineAdapter, type Precision, type SourceRow, type Type, type Version, type View,
} from "@lifestreamprotocol/core";
import { linesOnly, type Change, type DayInput, type DayLine, type Extracted, type Family, type FamilyInput, type Given, type Touched } from "../family.js";
import { recordRead, recordText } from "../shared/text.js";

export const PLAIN_FAMILY = "plain";
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const PLACED: ReadonlySet<Precision> = new Set(["ms", "s", "minute", "day"]);
const STATES_NO_TIME = ["at_ms", "end_ms"] as const;

export interface PlainLine {
  start_ms: number;
  end_ms?: number;
  precision: Precision;
  text: string;
  title?: string;
  kind: string;
  key: string;
}

export interface PlainDay {
  name: string;
  type: Type | null;
  lines: PlainLine[];
}

export function plainFamily(given: readonly Given<LineAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const adapterOf = (source: SourceRow | undefined, kind: string): Given<LineAdapter> | undefined => {
    const fed = source === undefined ? undefined : byProduct.get(source.product);
    return fed?.adapter.kinds.includes(kind) === true ? fed : undefined;
  };
  const inputs: FamilyInput[] = given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" }));
  return {
    name: PLAIN_FAMILY,
    type: null,
    code: "2",
    inputs,
    text: {
      version: "1",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const fed = adapterOf(source, record.kind);
        const line = fed === undefined ? null : lineOf(fed, source!, version);
        return line === null ? null : recordText({ title: line.title, text: line.text, ...(line.who === undefined ? {} : { who: line.who }), link: line.link });
      },
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const fed = adapterOf(source, record.kind);
        const line = fed === undefined ? null : lineOf(fed, source!, version);
        return line === null ? null : recordRead({ title: line.title, text: line.text, ...(line.who === undefined ? {} : { who: line.who }), link: line.link });
      },
    },

    touched(changes: readonly Change[], view: View): Touched[] {
      const units = new Set<string>();
      for (const { record, before, after } of changes) {
        if (adapterOf(view.source(record.source), record.kind) === undefined) continue;
        for (const version of [before, after]) {
          const start = version?.time?.start_ms;
          if (start !== undefined) units.add(`${record.source}/${utcDay(start)}`);
        }
      }
      return [...units].sort().map((unit) => ({ unit }));
    },

    extract(unit: string, view: View): Extracted | null {
      const parsed = parseUnit(unit);
      const source = parsed === null ? undefined : view.source(parsed.source);
      const fed = source === undefined ? undefined : byProduct.get(source.product);
      if (parsed === null || source === undefined || fed === undefined) return null;
      const start = instant(parsed.day, "date").start_ms;
      const lines: PlainLine[] = [];
      for (const kind of fed.adapter.kinds) {
        for (const { head, version } of view.records(source.id, kind, { start_ms: start, end_ms: start + DAY_MS })) {
          if (head.start_ms === null || head.start_ms < start || head.start_ms >= start + DAY_MS) continue;
          const time = version.time;
          if (time === undefined || !PLACED.has(time.precision)) continue;
          const line = lineOf(fed, source, version);
          if (line === null) continue;
          lines.push({
            start_ms: time.start_ms, ...(time.end_ms === undefined ? {} : { end_ms: time.end_ms }), precision: time.precision, text: line.text,
            ...(line.title === undefined ? {} : { title: line.title }), kind, key: head.key,
          });
        }
      }
      if (lines.length === 0) return null;
      lines.sort((left, right) => left.start_ms - right.start_ms || compare(left.kind, right.kind) || compare(left.key, right.key));
      const content: PlainDay = { name: fed.name, type: fed.type, lines };
      return {
        content: content as unknown as Json,
        start_ms: Math.min(...lines.map((line) => line.start_ms)),
        end_ms: Math.max(...lines.map((line) => line.end_ms ?? line.start_ms)),
        reading: digest(content as unknown as Json),
      };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      const { lines } = extract.content as unknown as PlainDay;
      return [...new Set(lines.flatMap((line) => daysOf(timeOf(line), settings)))].sort();
    },

    day: linesOnly((input: DayInput): DayLine[] => {
      return input.extracts.flatMap((extract) => {
        const { source } = parseUnit(extract.unit)!;
        const day = extract.content as unknown as PlainDay;
        return day.lines.map((line): DayLine => ({
          family: PLAIN_FAMILY, unit: extract.unit, units: [extract.unit], ...placed(line),
          text: line.title === undefined ? line.text : `${line.title}: ${line.text}`,
          record: { source, kind: line.kind, key: line.key },
          block: { key: source, title: day.name },
          ...(day.type === null ? {} : { type: day.type }),
        }));
      });
    }),
  };
}

function timeOf(line: PlainLine): Instant {
  return { start_ms: line.start_ms, ...(line.end_ms === undefined ? {} : { end_ms: line.end_ms }), precision: line.precision };
}

function placed(line: PlainLine): Pick<DayLine, "start_ms" | "end_ms" | "date_only"> {
  if (line.precision !== "day") return { start_ms: line.start_ms, end_ms: line.end_ms ?? null };
  const several = line.end_ms !== undefined && line.end_ms - line.start_ms > DAY_MS;
  return { start_ms: line.start_ms, end_ms: several ? line.end_ms! : null, date_only: true };
}

function lineOf(fed: Given<LineAdapter>, source: SourceRow, version: Version): Line | null {
  const line = fed.adapter.line({ source, version });
  if (line === null) return null;
  const fault = lineFaults(line)[0];
  if (fault !== undefined) throw new TypeError(`the line adapter of ${fed.product} gives ${version.kind} ${version.key} a line that ${fault}`);
  return line;
}

export function lineFaults(line: Line): string[] {
  return [
    ...STATES_NO_TIME.filter((stated) => Object.hasOwn(line, stated)).map((stated) => `states ${stated}: a line is placed at its record's own time; drop at_ms and end_ms`),
    ...(typeof line.text === "string" ? [] : ["has no text"]),
    ...(line.title !== undefined && typeof line.title !== "string" ? ["has a title that is no text"] : []),
  ];
}

function parseUnit(unit: string): { source: string; day: string } | null {
  const slash = unit.lastIndexOf("/");
  const day = unit.slice(slash + 1);
  return slash < 0 || !DATE.test(day) ? null : { source: unit.slice(0, slash), day };
}

function utcDay(ms: number): string {
  return render(ms, "UTC", "day");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
