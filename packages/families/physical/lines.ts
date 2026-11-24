import { dayBounds, render } from "@lifestreamprotocol/core";
import { factId, OPS, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Labels } from "../family.js";
import { areaOf } from "../shared/geography.js";
import { placeWords } from "../shared/labels.js";
import type { Evidence, LegContent } from "./evidence.js";
import type { ReportContent, VigilanceContent } from "./family.js";
import type { Span } from "./segment.js";
import { legsOf, samePlace, where, type Piece } from "./where.js";

const MODE_WORDS: Record<Exclude<LegContent["mode"], "unclear">, string> = {
  walk: "Walk", run: "Run", cycle: "Cycle", road_vehicle: "Road vehicle", flight: "Flight", unknown: "Not recorded",
};
const PRINTED_SILENCE_MS = 3 * 3_600_000;

type Content = Evidence | ReportContent | VigilanceContent;

export const PHYSICAL_COLLECTIONS: Readonly<Record<string, Collection>> = {
  stays: {
    about: "time the person spent at a place, as the day's timeline lays it; not where they slept or lodged (read the days or search for that); a stay seen only in a photo (how seen) was near the place it names",
    keys: ["place", "city", "country", "how"],
    measures: { minutes: { unit: "min", ops: OPS, time: "start", split: "clock", from: "derived" } },
  },
};

export function physicalDay(input: DayInput): DayProjection {
  const day = dayBounds(input.day, input.settings);
  const contents = new Map(input.extracts.map((extract) => [extract.unit, extract.content as unknown as Content]));
  const pieces = where(input.extracts, day, input.labels, 0, input.settings);
  const lines: DayLine[] = [];
  const facts: DayFact[] = [];
  let last: { piece: Piece; line: DayLine; fact: DayFact } | null = null;
  pieces.forEach((piece, index) => {
    if (piece.kind === "gap") return;
    if (piece.kind === "move") {
      lines.push(...moveLines({ ...piece, ...extent(piece, piece, contents, day) }, contents, input.labels));
      last = null;
      return;
    }
    const next = pieces[index + 1];
    const bridge = next?.kind === "gap" && next.how === "bridged" && next.level === "place" ? next : null;
    const end_ms = bridge?.end_ms ?? piece.end_ms;
    const units = unitsOf(piece.units, piece.doubted?.by ?? [], bridge?.units ?? []);
    const printed = stayLines({ ...piece, ...extent({ start_ms: piece.start_ms, end_ms }, piece, contents, day) }, units, contents, input);
    const at = printed[0]!;
    if (last !== null && last.line.end_ms === at.start_ms && last.piece.by === piece.by && last.piece.level === "place" && piece.level === "place" &&
        samePlace(last.piece.point!, piece.point!, input.labels)) {
      last.line.end_ms = at.end_ms;
      last.line.units = unitsOf(last.line.units, units);
      last.fact = stayFact(last.piece, { start_ms: last.line.start_ms!, end_ms: at.end_ms! }, last.fact.lines[0]!, input.labels, last.line);
      facts[facts.length - 1] = last.fact;
      lines.push(...printed.slice(1));
      return;
    }
    const printedAt = lines.length;
    lines.push(...printed);
    const fact = stayFact(piece, { start_ms: at.start_ms!, end_ms: at.end_ms! }, printedAt, input.labels, at);
    facts.push(fact);
    last = { piece, line: at, fact };
  });
  for (const [unit, content] of contents) {
    if (content.kind === "report") lines.push(reportLine(unit, content));
    else if (content.kind === "vigilance") lines.push(vigilanceLine(unit, content));
  }
  return { lines, facts };
}

function stayFact(stay: Piece, span: Span, line: number, labels: Labels, printed: DayLine): DayFact {
  const point = stay.point!;
  const unit = stay.units[0]!;
  const hidden = labels.hidden?.(point.latitude, point.longitude) === true;
  const named = stay.level === "place" ? (hidden ? placeWords(point, labels) : labels.place(point.latitude, point.longitude, point.id)?.name) : undefined;
  const area = hidden ? null : areaOf(point);
  const keys: Record<string, string> = {
    ...(named === undefined ? {} : { place: named }),
    ...(area?.city != null && (stay.level === "place" || stay.level === "city") ? { city: area.city } : {}),
    ...(area?.country != null ? { country: area.country } : {}),
    how: stay.how!,
  };
  return {
    of: "stays", id: factId("stays", `${unit}\0${span.start_ms}`), time_ms: span.start_ms, start_ms: span.start_ms, end_ms: span.end_ms,
    keys, measures: { minutes: (span.end_ms - span.start_ms) / 60_000 }, who: [],
    from: { units: [...printed.units], ...(printed.record === undefined ? {} : { record: printed.record }), instrument: stay.by! }, lines: [line],
  };
}

function extent(span: Span, piece: Piece, contents: ReadonlyMap<string, Content>, day: Span): Span {
  const spans = piece.units.flatMap((unit) => {
    const content = contents.get(unit);
    return content?.kind === "stay" || content?.kind === "trip" ? [{ start_ms: content.start_ms, end_ms: content.end_ms }] : [];
  });
  return {
    start_ms: span.start_ms === day.start_ms ? Math.min(span.start_ms, ...spans.map((each) => each.start_ms)) : span.start_ms,
    end_ms: span.end_ms === day.end_ms ? Math.max(span.end_ms, ...spans.map((each) => each.end_ms)) : span.end_ms,
  };
}

function unitsOf(...lists: readonly (readonly string[])[]): string[] {
  return [...new Set(lists.flat())];
}

function stayLines(stay: Piece, units: string[], contents: ReadonlyMap<string, Content>, input: DayInput): DayLine[] {
  const unit = stay.units[0]!;
  const point = stay.point!;
  const place = placeWords(point, input.labels);
  const content = contents.get(unit);
  const named = content !== undefined && "record" in content && content.record !== undefined ? { record: content.record } : {};
  const at = (span: Span, text: string): DayLine => ({ family: "physical", unit, units: [...units], start_ms: span.start_ms, end_ms: span.end_ms, text, ...named });
  const day = dayBounds(input.day, input.settings);
  const part = (silence: Span) => Math.min(silence.end_ms, day.end_ms) - Math.max(silence.start_ms, day.start_ms);
  return [
    at(stay, stayText(stay, place, stay.by!, input)),
    ...(stay.walks ?? []).map((walk) => at(walk, `Walking at ${place}`)),
    ...(stay.silences ?? []).filter((silence) => silence.end_ms - silence.start_ms >= PRINTED_SILENCE_MS)
      .map((silence) => at(silence, `No location for ${duration(part(silence))}`)),
  ];
}

function stayText(stay: Piece, place: string, name: string, input: DayInput): string {
  if (stay.doubted !== undefined) {
    const area = areaOf(stay.point!);
    const named = stay.level === "city" ? area.city : stay.level === "region" ? area.region : area.country;
    return `In ${named ?? "an unknown area"} (${name} said ${place}; a photo at ${render(stay.doubted.at_ms, input.settings.zone, "minute", input.day)} was ${km(stay.doubted.distance_m)} away)`;
  }
  const exception = stay.open === true ? " (still there at the last fix)" : stay.how === "stated" ? ` (stated by ${name})` : stay.how === "seen" ? " (from photos)" : "";
  return `At ${place}${exception}`;
}

function moveLines(move: Piece, contents: ReadonlyMap<string, Content>, labels: Labels): DayLine[] {
  const [unit, name] = [move.units[0]!, move.by!];
  const route = `${move.from === null ? "an unknown place" : placeWords(move.from, labels)} → ${move.to === null ? "an unknown place" : placeWords(move.to, labels)}`;
  const content = contents.get(unit);
  const named = content !== undefined && "record" in content && content.record !== undefined ? { record: content.record } : {};
  const legs = legsOf(move);
  if (legs.length === 1) {
    return [{ family: "physical", unit, units: [...move.units], start_ms: legs[0]!.start_ms, end_ms: legs[0]!.end_ms, text: legText(legs[0]!, name, route), ...named }];
  }
  const block = { key: unit, title: `Trip, ${route}, ${km(move.distance_m ?? 0)}, ${legs.length} legs` };
  return legs.map((leg) => ({ family: "physical", unit, units: [...move.units], start_ms: leg.start_ms, end_ms: leg.end_ms, text: legText(leg, name), ...named, block }));
}

function legText(leg: LegContent & { whole_ms: number }, name: string, route?: string): string {
  const where = route === undefined ? [] : [route];
  if (leg.stated !== null) {
    const words = leg.stated.replace(/^in /u, "");
    const doubt = leg.mode === "unknown" ? ", doubtful" : "";
    return [`${words.charAt(0).toUpperCase()}${words.slice(1)} (stated by ${name}${doubt})`, ...where, `${km(leg.distance_m)} in ${duration(leg.whole_ms)}`].join(", ");
  }
  if (leg.mode === "unclear") return [`Moved ${km(leg.distance_m)}, mode unclear`, ...where].join(", ");
  return [MODE_WORDS[leg.mode], ...where, km(leg.distance_m), ...(leg.motion === null ? [] : [leg.motion])].join(", ");
}

function reportLine(unit: string, report: ReportContent): DayLine {
  const items = report.items.map((item) => typeof item.value === "number" ? `${item.id} ${item.value}/${item.scale}`
    : typeof item.value === "boolean" ? `${item.id} ${item.value ? "yes" : "no"}` : `${item.id}: ${item.value}`);
  const note = report.note === null ? "" : `; note: ${report.note}`;
  return { family: "physical", unit, units: [unit], start_ms: report.at_ms, end_ms: null, record: report.record,
    text: `Check-in (${report.form.replaceAll("_", " ")}): ${items.length === 0 ? "no answers" : items.join(", ")}${note}` };
}

function vigilanceLine(unit: string, test: VigilanceContent): DayLine {
  const facts = [`${test.responses} responses`, ...(test.median_ms === null ? [] : [`median ${Math.round(test.median_ms)} ms`]),
    `${test.lapses} lapse${test.lapses === 1 ? "" : "s"}`, `${test.false_starts} false start${test.false_starts === 1 ? "" : "s"}`];
  return { family: "physical", unit, units: [unit], start_ms: test.at_ms, end_ms: null, record: test.record,
    text: `Vigilance test: ${facts.join(", ")}${test.completed ? "" : ", not completed"}` };
}

function km(meters: number): string {
  return `${(Math.round(meters / 100) / 10).toFixed(1)} km`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return minutes < 60 ? `${minutes} m` : minutes % 60 === 0 ? `${minutes / 60} h` : `${Math.floor(minutes / 60)} h ${minutes % 60} m`;
}
