import {
  civilDay, daysOf, digest, selects,
  type BlobReader, type DaySettings, type ExtractRow, type Json, type PhotosAdapter, type SourceRow, type View, type Witness as WitnessAdapter,
} from "@lifestreamprotocol/core";
import { statingAccounts, type Change, type Extracted, type Family, type Given, type Touched } from "../family.js";
import { liveRecord, owned, parseUnit, PHYSICAL, PHYSICAL_CODE, seenOf, unitName, type Evidence } from "./evidence.js";
import { PHYSICAL_COLLECTIONS, physicalDay } from "./lines.js";
import { siblingIn } from "./phone.js";
import { VOUCH_MS } from "./where.js";
import { PhotoRoutes } from "../photos/read.js";
import { witnesses as witnessTable, type Part } from "./witnesses.js";

export type { Evidence, LegContent, SeenContent, Photo, StayContent, TripContent } from "./evidence.js";

const REPORT = "report";
const VIGILANCE = "vigilance";
const LAPSE_MS = 500;

export interface ReportContent {
  kind: "report";
  record: { source: string; kind: string; key: string };
  at_ms: number;
  form: string;
  items: { id: string; value: string | number | boolean; scale: number }[];
  note: string | null;
}

export interface VigilanceContent {
  kind: "vigilance";
  record: { source: string; kind: string; key: string };
  at_ms: number;
  completed: boolean;
  responses: number;
  median_ms: number | null;
  lapses: number;
  false_starts: number;
}

export type PhysicalContent = Evidence | ReportContent | VigilanceContent;

function checkins(given: readonly Given<WitnessAdapter>[]): Part<ReportContent | VigilanceContent> {
  const reading = given.filter((each) => each.adapter.report !== undefined || each.adapter.vigilance !== undefined);
  const SOURCES = { product: reading.map((each) => each.product) };
  return {
    inputs: reading.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    owns: (unit) => owned(unit, [REPORT, VIGILANCE], SOURCES),
    touched: (changes) => changes.map((change) => ({ unit: unitName(change.record.kind, change.record.source, change.record.key) })),
    extract(unit, view) {
      const { kind, source, rest } = parseUnit(unit);
      const adapter = reading.find((each) => each.product === view.source(source)?.product)?.adapter;
      if (adapter === undefined) return null;
      return kind === REPORT ? report(adapter, view, source, rest) : kind === VIGILANCE ? vigilance(adapter, view, source, rest) : null;
    },
  };
}

export type WitnessSources = (unit: string, sources: ReadonlyMap<string, SourceRow>) => string[];

export function witnessSourcesOf(given: readonly Given<WitnessAdapter>[]): WitnessSources {
  const phones = given.filter((each) => each.adapter.fix !== undefined).map((each) => each.product);
  const motions = given.filter((each) => each.adapter.motion !== undefined).map((each) => each.product);
  return (unit, sources) => {
    const { kind, source } = parseUnit(unit);
    const row = sources.get(source);
    const motion = row === undefined || !phones.includes(row.product) || (kind !== "stay" && kind !== "trip") ? undefined : siblingIn(row, sources.values(), motions);
    return motion === undefined ? [source] : [source, motion];
  };
}

export interface PhysicalOptions {
  photos: readonly Given<PhotosAdapter>[];
}

export function physicalFamily(options: PhysicalOptions): (given: readonly Given<WitnessAdapter>[]) => Family {
  return (given) => {
    const witnesses = witnessTable(new PhotoRoutes(options.photos), given);
    const parts: readonly Part[] = [...witnesses, checkins(given)];
    const witnessSources = witnessSourcesOf(given);
    return {
      name: PHYSICAL,
      borrowed: { photos: options.photos },
      type: "places",
      code: `${PHYSICAL_CODE}:${digest(witnesses.map(({ name, rank, how }) => [name, rank, how]))}`,
      inputs: parts.flatMap((part) => part.inputs),

      touched(changes: readonly Change[], view: View): Touched[] {
        return parts.flatMap((part) => {
          const mine = changes.filter((change) => {
            const source = view.source(change.record.source);
            return source !== undefined && part.inputs.some((input) => input.kinds.includes(change.record.kind) && selects(input.sources, source));
          });
          return mine.length === 0 ? [] : part.touched(mine, view);
        });
      },

      extract(unit: string, view: View, files: BlobReader): Extracted | null {
        const part = parts.find((each) => each.owns(unit));
        const said = part?.extract(unit, view, files) ?? null;
        if (said === null) return null;
        const witness = witnesses.find((each) => each === part);
        const content = (witness === undefined ? said : { ...said as object, rank: witness.rank, how: witness.how, by: witness.name }) as PhysicalContent;
        const { start_ms, end_ms } = content.kind === "report" || content.kind === "vigilance"
          ? { start_ms: content.at_ms, end_ms: content.at_ms }
          : { start_ms: content.start_ms, end_ms: content.end_ms };
        return { content: content as unknown as Json, start_ms, end_ms, reading: digest(said as Json) };
      },

      days(extract: ExtractRow, settings: DaySettings): string[] {
        const content = extract.content as unknown as PhysicalContent;
        if (content.kind === "report" || content.kind === "vigilance") return [civilDay(content.at_ms, settings)];
        const seen = content.kind === "seen" ? seenOf(content) : null;
        const spans = seen !== null
          ? ("photos" in seen ? seen.photos.map((photo) => ({ start_ms: photo.at_ms, end_ms: photo.at_ms })) : seen.sightings)
            .map((span) => ({ start_ms: span.start_ms - VOUCH_MS, end_ms: span.end_ms + VOUCH_MS }))
          : [{ start_ms: content.start_ms, end_ms: Math.max(content.end_ms, content.start_ms + 1) }];
        return [...new Set(spans.flatMap((span) => daysOf({ ...span, precision: "ms" }, settings)))].sort();
      },

      day: (input) => statingAccounts(physicalDay(input), (unit) => witnessSources(unit, input.sources)),
      collections: PHYSICAL_COLLECTIONS,
    };
  };
}



function report(adapter: WitnessAdapter, view: View, source: string, key: string): ReportContent | null {
  const record = liveRecord(view, source, REPORT, key);
  const read = record === null || adapter.report === undefined ? null : adapter.report(record);
  return read === null ? null : { kind: "report", record: { source, kind: REPORT, key }, at_ms: read.at_ms, form: read.form, items: read.items, note: read.note };
}

function vigilance(adapter: WitnessAdapter, view: View, source: string, key: string): VigilanceContent | null {
  const record = liveRecord(view, source, VIGILANCE, key);
  const read = record === null || adapter.vigilance === undefined ? null : adapter.vigilance(record);
  if (read === null) return null;
  const responses = read.trials.flatMap((trial) => (trial.outcome === "response" ? [trial.rt_ms] : [])).sort((left, right) => left - right);
  const middle = Math.floor(responses.length / 2);
  return {
    kind: "vigilance", record: { source, kind: VIGILANCE, key }, at_ms: read.at_ms, completed: read.completed,
    responses: responses.length,
    median_ms: responses.length === 0 ? null : responses.length % 2 === 1 ? responses[middle]! : (responses[middle - 1]! + responses[middle]!) / 2,
    lapses: read.trials.filter((trial) => trial.outcome === "timeout" || (trial.outcome === "response" && trial.rt_ms >= LAPSE_MS)).length,
    false_starts: read.trials.filter((trial) => trial.outcome === "false_start").length,
  };
}
