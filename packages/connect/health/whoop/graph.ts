import { instantMs, instantOf, isObject, refuse, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { member, object, text, url } from "./parts.js";

const POSITION_TOLERANCE = 1e-9;
const ANCHOR_RESIDUAL_MS = 100;
const LATTICE_MS = 10;
const LATTICE_RESIDUAL_MS = 1;
const CLOCK = /^(?:(1[0-2]|[1-9]):([0-5]\d) ([AP]M)|([01]\d|2[0-3]):([0-5]\d))$/iu;
const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const STRESS_AXIS_DAYS = 31;

export type Family = "hr" | "stress";

export interface Point {
  family: Family;
  ms: number;
  offset_min: number;
  content: JsonObject;
  locator: string;
}

interface Occurrence {
  point: JsonObject;
  text: string;
  style: string | null;
  locator: string;
}

export function statesHeartRate(root: JsonObject, file: string): boolean {
  return plots(member(root, "graph", file), file).some((plot) => plot.id === "TILT_MODE");
}

export function statesStress(root: JsonObject, file: string): boolean {
  return plots(extendedGraph(root, file), file).some((plot) => plot.id === "stress");
}

export function placesHeartRate(root: JsonObject, file: string): boolean {
  return heartRateAnchors(member(root, "graph", file), file).length >= 2;
}

export function heartRatePoints(root: JsonObject, file: string): Point[] {
  const graph = member(root, "graph", file);
  const anchors = heartRateAnchors(graph, file);
  if (anchors.length < 2) refuse(`${file}: the heart-rate graph needs at least two timestamp anchors`);
  const low = anchors.reduce((a, b) => (a.position < b.position ? a : b));
  const high = anchors.reduce((a, b) => (a.position > b.position ? a : b));
  if (Math.abs(high.position - low.position) < POSITION_TOLERANCE) refuse(`${file}: heart-rate anchors have zero position span`);
  const spanMs = (high.ms - low.ms) / (high.position - low.position);
  if (!(spanMs > 0)) refuse(`${file}: the heart-rate graph has a non-positive time span`);
  const originMs = low.ms - low.position * spanMs;
  for (const [index, anchor] of anchors.entries()) {
    if (anchor.offset_min !== low.offset_min) refuse(`${file}: the heart-rate axis offset changes within one graph`);
    const residual = Math.abs(originMs + anchor.position * spanMs - anchor.ms);
    if (residual > ANCHOR_RESIDUAL_MS) refuse(`${file}: heart-rate axis anchor ${index} is off by ${residual.toFixed(3)} ms`);
  }
  return grouped("hr", file, occurrences(graph, "TILT_MODE", file), (point) => {
    const ms = lattice(originMs + position(point.position_x, `${file}: heart-rate position_x`) * spanMs, file);
    const details = member(point, "data_scrubber_details", file);
    const value = num(details.value, `${file}: heart-rate value`);
    const display = text(details.value_display, `${file}: heart-rate value_display`);
    if (text(details.unit_display, `${file}: heart-rate unit_display`) !== "bpm" || Number(display) !== value) {
      refuse(`${file}: heart-rate value, value_display and unit_display disagree`);
    }
    clockMatches(text(details.secondary_contextual_display, `${file}: heart-rate clock`), ms, low.offset_min, `${file}: heart-rate clock`);
    return { ms, offset_min: low.offset_min, content: { bpm: details.value! } };
  });
}

export function stressUser(root: JsonObject, file: string, account: string): void {
  if (typeof root.typeform_url !== "string" || !URL.canParse(root.typeform_url)) return;
  const user = new URL(root.typeform_url).searchParams.get("userId");
  if (user !== null && user !== account) refuse(`${file}.typeform_url states userId ${user}, not ${account}`);
}

export function stressPoints(root: JsonObject, file: string, zone: string): Point[] {
  const graph = extendedGraph(root, file);
  const typeform = url(text(root.typeform_url, `${file}.typeform_url`), `${file}.typeform_url`);
  const final = typeform.searchParams.get("stressScoreTimestamp") ?? refuse(`${file}.typeform_url states no stressScoreTimestamp`);
  const anchorMs = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(final) ? instantMs(final) : undefined;
  if (anchorMs === undefined) refuse(`${file}: stressScoreTimestamp ${JSON.stringify(final)} is not an instant`);
  const offset = zoneOffset(zone, anchorMs);
  clockMatches(text(root.last_updated_display, `${file}.last_updated_display`), Math.round(anchorMs / 1000) * 1000, offset, `${file}.last_updated_display`);
  const plane = member(graph, "plane", file);
  const bottom = member(plane, "bottom_xaxis", file);
  if (!Array.isArray(bottom.labels) || bottom.labels.length < 2) refuse(`${file}: the stress graph needs at least two bottom-axis anchors`);
  const anchors = bottom.labels
    .map((value, index) => {
      const label = object(value, `${file}: stress axis anchor ${index}`);
      const at = position(label.position, `${file}: stress axis anchor ${index}.position`);
      if (at >= 1 - POSITION_TOLERANCE) refuse(`${file}: stress axis anchor ${index} must precede the final position 1`);
      const clock = text(label.label, `${file}: stress axis anchor ${index}.label`);
      parseClock(clock, `${file}: stress axis anchor ${index}.label`);
      return { position: at, clock };
    })
    .filter((anchor) => anchor.position > POSITION_TOLERANCE);
  if (anchors.length < 2) refuse(`${file}: the extended stress graph needs at least two precise axis anchors`);
  const localAnchorMs = anchorMs + offset * MINUTE;
  const last = anchors.reduce((a, b) => (a.position > b.position ? a : b));
  const latest = latestClockAtOrBefore(last.clock, localAnchorMs, file);
  let spanMs: number | undefined;
  for (let day = 0; day < STRESS_AXIS_DAYS && spanMs === undefined; day++) {
    const tried = (localAnchorMs - (latest - day * DAY_MS)) / (1 - last.position);
    if (!(tried > 0)) continue;
    const spans = anchors.map((anchor) => (localAnchorMs - nearestClock(anchor.clock, localAnchorMs - (1 - anchor.position) * tried, file)) / (1 - anchor.position));
    const span = median(spans);
    if (spans.every((each) => Math.abs(each - span) <= ANCHOR_RESIDUAL_MS)) spanMs = span;
  }
  if (spanMs === undefined) refuse(`${file}: no whole-day placement of the stress axis within ${STRESS_AXIS_DAYS} days puts every label within ${ANCHOR_RESIDUAL_MS} ms of its clock`);
  return grouped("stress", file, occurrences(graph, "stress", file), (point) => {
    const ms = lattice(anchorMs - (1 - position(point.position_x, `${file}: stress position_x`)) * spanMs, file);
    const details = member(point, "data_scrubber_details", file);
    num(details.value, `${file}: stress value`);
    const display = text(details.value_display, `${file}: stress value_display`);
    const score = Number(display);
    if (!Number.isFinite(score) || score < 0 || score > 3) refuse(`${file}: stress value_display is outside WHOOP's 0 to 3`);
    const level = text(details.secondary_contextual_display, `${file}: stress level`);
    clockMatches(text(details.primary_contextual_display, `${file}: stress clock`), ms, offset, `${file}: stress clock`);
    return { ms, offset_min: offset, content: { value: details.value!, display, level } };
  });
}

function grouped(
  family: Family,
  file: string,
  found: Occurrence[],
  derive: (point: JsonObject) => { ms: number; offset_min: number; content: JsonObject },
): Point[] {
  const byMs = new Map<number, { point: Point; text: string; styles: string[] }>();
  let previous = -Infinity;
  for (const occurrence of found) {
    const derived = derive(occurrence.point);
    if (derived.ms < previous) refuse(`${file}: ${family} points run backwards after placement`);
    previous = derived.ms;
    const seen = byMs.get(derived.ms);
    if (seen === undefined) {
      byMs.set(derived.ms, {
        point: { family, ms: derived.ms, offset_min: derived.offset_min, content: derived.content, locator: occurrence.locator },
        text: occurrence.text,
        styles: occurrence.style === null ? [] : [occurrence.style],
      });
      continue;
    }
    if (seen.text !== occurrence.text) refuse(`${file}: non-identical ${family} points collide at ${new Date(derived.ms).toISOString()}`);
    if (occurrence.style !== null && !seen.styles.includes(occurrence.style)) seen.styles.push(occurrence.style);
  }
  return [...byMs.values()].map(({ point, styles }) => ({
    ...point,
    content: { ...point.content, segment_styles: [...styles].sort() },
  }));
}

function occurrences(graph: JsonObject, id: string, file: string): Occurrence[] {
  const matching = plots(graph, file).filter((plot) => plot.id === id);
  if (matching.length !== 1) refuse(`${file}: expected exactly one graph plot with id ${id}`);
  const segments = matching[0]!.segments;
  if (!Array.isArray(segments)) refuse(`${file}: plot ${id}.segments must be an array`);
  const out: Occurrence[] = [];
  for (const [segmentIndex, value] of segments.entries()) {
    const segment = object(value, `${file}: plot ${id} segment ${segmentIndex}`);
    if (!Array.isArray(segment.points)) refuse(`${file}: plot ${id} segment ${segmentIndex} states no points`);
    const style = segment.style;
    if (style !== null && style !== undefined && typeof style !== "string") refuse(`${file}: plot ${id} segment ${segmentIndex}.style must be text or null`);
    for (const [pointIndex, raw] of segment.points.entries()) {
      const point = object(raw, `${file}: point ${segmentIndex}/${pointIndex}`);
      out.push({ point, text: JSON.stringify(point), style: typeof style === "string" ? style : null, locator: `${file}#segment[${segmentIndex}].points[${pointIndex}]` });
    }
  }
  if (out.length === 0) refuse(`${file}: plot ${id} contains no points`);
  return out;
}

function heartRateAnchors(graph: JsonObject, file: string): { position: number; ms: number; offset_min: number }[] {
  let found = false;
  const anchors: { position: number; ms: number; offset_min: number }[] = [];
  for (const plot of plots(graph, file)) {
    if (plot.id !== "x_label_plot") continue;
    found = true;
    if (!Array.isArray(plot.zoom_buckets)) refuse(`${file}: x_label_plot.zoom_buckets must be an array`);
    for (const [bucketIndex, bucket] of plot.zoom_buckets.entries()) {
      const labels = object(bucket, `${file}: x_label_plot bucket ${bucketIndex}`).axis_labels;
      if (!Array.isArray(labels)) refuse(`${file}: x_label_plot bucket ${bucketIndex} has no axis_labels array`);
      for (const [labelIndex, label] of labels.entries()) {
        const where = `${file}: heart-rate axis label ${bucketIndex}/${labelIndex}`;
        const stated = object(label, where);
        anchors.push({ position: position(stated.position, `${where}.position`), ...axisInstant(stated.id, `${where}.id`) });
      }
    }
  }
  if (!found) refuse(`${file}: the heart-rate graph states no x_label_plot`);
  return anchors;
}

function axisInstant(value: Json | undefined, where: string): { ms: number; offset_min: number } {
  const stated = text(value, where);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(stated)) refuse(`${where} ${JSON.stringify(stated)} is not an instant with an offset`);
  const read = instantOf(stated, "rfc3339", where);
  return { ms: read.start_ms, offset_min: read.offset_min ?? 0 };
}

function plots(graph: JsonObject, file: string): JsonObject[] {
  if (!Array.isArray(graph.plots)) refuse(`${file}: graph.plots must be an array`);
  return graph.plots.flatMap((wrapper) =>
    isObject(wrapper) && isObject(wrapper.plot) ? [wrapper.plot] : [],
  );
}

function extendedGraph(root: JsonObject, file: string): JsonObject {
  return member(member(root, "extended24_hour_graph", file), "graph", `${file}.extended24_hour_graph`);
}

function lattice(ms: number, file: string): number {
  const rounded = Math.round(ms / LATTICE_MS) * LATTICE_MS;
  const residual = Math.abs(ms - rounded);
  if (residual > LATTICE_RESIDUAL_MS) refuse(`${file}: a placed point misses the 10 ms lattice by ${residual.toFixed(3)} ms`);
  return rounded;
}

const FORMATS = new Map<string, Intl.DateTimeFormat>();

export function zoneOffset(zone: string, ms: number): number {
  let format = FORMATS.get(zone);
  if (format === undefined) {
    try {
      format = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23",
      });
    } catch {
      return refuse(`the capture states zone ${JSON.stringify(zone)}, which this runtime does not know`);
    }
    FORMATS.set(zone, format);
  }
  const parts = Object.fromEntries(format.formatToParts(ms).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / MINUTE);
}

function clockMatches(clock: string, ms: number, offset: number, where: string): void {
  const parsed = parseClock(clock, where);
  const wall = new Date(ms + offset * MINUTE);
  if (wall.getUTCHours() !== parsed.hour || wall.getUTCMinutes() !== parsed.minute) {
    refuse(`${where} ${JSON.stringify(clock)} disagrees with the placed instant`);
  }
}

function parseClock(clock: string, where: string): { hour: number; minute: number } {
  const m = CLOCK.exec(clock) ?? refuse(`${where} ${JSON.stringify(clock)} is not a WHOOP clock`);
  if (m[4] !== undefined) return { hour: Number(m[4]), minute: Number(m[5]) };
  return { hour: (Number(m[1]) % 12) + (m[3]!.toUpperCase() === "PM" ? 12 : 0), minute: Number(m[2]) };
}

function latestClockAtOrBefore(clock: string, localMs: number, file: string): number {
  const { hour, minute } = parseClock(clock, `${file}: stress axis clock`);
  const day = new Date(localMs);
  const candidate = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute);
  return candidate > localMs ? candidate - DAY_MS : candidate;
}

function nearestClock(clock: string, localMs: number, file: string): number {
  const latest = latestClockAtOrBefore(clock, localMs, file);
  return localMs - latest > DAY_MS / 2 ? latest + DAY_MS : latest;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function position(value: Json | undefined, where: string): number {
  const at = num(value, where);
  if (at < -POSITION_TOLERANCE || at > 1 + POSITION_TOLERANCE) refuse(`${where} must lie between 0 and 1`);
  return at;
}

export function num(value: Json | undefined, where: string): number {
  const read = typeof value === "number" ? value : typeof value === "string" && /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(value) ? Number(value) : Number.NaN;
  if (!Number.isFinite(read)) refuse(`${where} must be a number`);
  return read;
}
