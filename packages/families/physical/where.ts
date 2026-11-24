import { addDays, canonical, civilDay, dayBounds, type DaySettings, type ExtractRow, type Json } from "@lifestreamprotocol/core";
import { accountsOf, type Labels, type PlaceLabel } from "../family.js";
import { areaOf, zoneOf, type Area } from "../shared/geography.js";
import { placeWords } from "../shared/labels.js";
import { distanceMeters, nightAt, PLACE_REACH_M, type Point, type Stayed, type Where } from "../shared/places.js";
import { compare, parseUnit, rounded, seenOf, type Photo, type SeenContent, type Evidence, type How, type LegContent } from "./evidence.js";
import { BOUT_WINDOW_MS, WALK_SPEED_MIN_MPS, type Span } from "./segment.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
export const WHERE_VERSION = "7";
export const VOUCH_MS = 15 * MINUTE_MS;
const SIGHTING_GAP_MS = 10 * MINUTE_MS;
const SIGHTING_REACH_M = 150;
const DOUBT_M = 250;
const STRAY_M = 50_000;
const STRAY_SPEED_MPS = 1_000_000 / 3_600;
const PART_MINIMUM_MS = MINUTE_MS;
const BRIDGE: Record<Level, number> = { place: HOUR_MS, city: 7 * DAY_MS, region: 7 * DAY_MS, country: 30 * DAY_MS };
const PLACE_BRIDGE_M = 150;
const GUESS_DAYS = 30;
export const REACH_DAYS = GUESS_DAYS;

export type Level = "place" | "city" | "region" | "country";
const LEVELS: readonly Level[] = ["place", "city", "region", "country"];

export interface Piece extends Span {
  kind: "stay" | "move" | "gap";
  level: Level | null;
  point: Where | null;
  from: Where | null;
  to: Where | null;
  how: How | "bridged" | "guessed" | null;
  by?: string;
  guess?: Area;
  units: string[];
  legs?: LegContent[];
  distance_m?: number;
  open?: true;
  walks?: Span[];
  silences?: Span[];
  doubted?: { by: string[]; at_ms: number; distance_m: number };
}

export function where(evidence: readonly ExtractRow[], span: Span, labels: Labels, reach: number, settings: DaySettings): Piece[] {
  const { days, window } = reachOf(span, reach, settings);
  const byDay = new Map<string, ExtractRow[]>();
  const seen = new Set<string>();
  for (const row of evidence) {
    if (seen.has(row.unit)) continue;
    seen.add(row.unit);
    for (const day of row.days) {
      const list = byDay.get(day);
      if (list === undefined) byDay.set(day, [row]);
      else list.push(row);
    }
  }
  return finishPieces(stitchDays(days.map((day) => dayPieces(byDay.get(day) ?? [], day, labels, settings).pieces)), window, span);
}

export function reachOf(span: Span, reach: number, settings: DaySettings): { days: string[]; window: Span } {
  const end = Math.max(span.end_ms, span.start_ms + 1);
  const first = addDays(civilDay(span.start_ms, settings), -reach);
  const last = addDays(civilDay(end - 1, settings), reach);
  const days: string[] = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return { days, window: { start_ms: dayBounds(first, settings).start_ms, end_ms: dayBounds(last, settings).end_ms } };
}

export interface LaidStay extends Stayed {
  unit: string;
}

export interface DayLay {
  pieces: Piece[];
  laid: LaidStay[];
}

export function dayPieces(rows: readonly ExtractRow[], day: string, labels: Labels, settings: DaySettings): DayLay {
  if (rows.length === 0) return { pieces: [], laid: [] };
  const laid = layDay(rows, dayBounds(day, settings), labels, new AreaCache());
  return { pieces: joined(laid.pieces, labels), laid: laid.laid };
}

export function stitchDays(days: readonly (readonly Piece[])[]): Piece[] {
  const laid: Piece[] = [];
  for (const pieces of days) {
    const [head, ...rest] = pieces;
    if (head === undefined) continue;
    const before = laid.at(-1);
    if (before !== undefined) {
      const joined = stitched(before, head);
      if (joined !== null) laid[laid.length - 1] = joined;
      else laid.push(head);
    } else laid.push(head);
    laid.push(...rest);
  }
  return laid;
}

export function stitchLaid(days: readonly (readonly LaidStay[])[]): LaidStay[] {
  const out: LaidStay[] = [];
  const open = new Map<string, LaidStay>();
  for (const laid of days) {
    const ends = new Map<string, LaidStay>();
    for (const stay of laid) {
      const before = open.get(stay.unit);
      if (before !== undefined && before.by === stay.by && before.centre.latitude === stay.centre.latitude && before.centre.longitude === stay.centre.longitude &&
        stay.start_ms - before.end_ms >= 0 && stay.start_ms - before.end_ms <= 1) {
        before.end_ms = stay.end_ms;
        ends.set(stay.unit, before);
        continue;
      }
      const copy = { ...stay, centre: { ...stay.centre } };
      out.push(copy);
      ends.set(stay.unit, copy);
    }
    open.clear();
    for (const [unit, stay] of ends) open.set(unit, stay);
  }
  return out.sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || compare(left.unit, right.unit));
}

export function finishPieces(pieces: readonly Piece[], window: Span, span: Span): Piece[] {
  const end = Math.max(span.end_ms, span.start_ms + 1);
  return filled(pieces, window, new AreaCache()).flatMap((piece) => {
    const start_ms = Math.max(piece.start_ms, span.start_ms);
    const end_ms = Math.min(piece.end_ms, end);
    return end_ms > start_ms ? [{ ...piece, start_ms, end_ms }] : [];
  });
}

export function visitsByPlace(pieces: readonly Piece[], labels: Labels): Map<string, Piece[]> {
  const out = new Map<string, Piece[]>();
  for (const piece of pieces) {
    if (piece.kind !== "stay" || piece.level !== "place" || piece.point === null) continue;
    const place = labels.place(piece.point.latitude, piece.point.longitude, piece.point.id);
    if (place === undefined || place.radius_m === 0) continue;
    const list = out.get(place.slug);
    if (list === undefined) out.set(place.slug, [piece]);
    else list.push(piece);
  }
  return out;
}

export interface Named {
  words: string | null;
  area: Area;
  zone: string | null;
}

export interface PieceNames {
  point: Named | null;
  from: Named | null;
  to: Named | null;
}

export function namesOf(pieces: readonly Piece[], labels: Labels): PieceNames[] {
  const areas = new AreaCache();
  const named = (point: Where | null, level: Level | null): Named | null => point === null || level === null ? null
    : { words: level === "place" ? placeWords(point, labels) : null, area: areas.at(point, level), zone: areas.zone(point, level) };
  return pieces.map((piece) => piece.kind === "move"
    ? { point: null, from: named(piece.from, "place"), to: named(piece.to, "place") }
    : { point: named(piece.point, piece.level), from: null, to: null });
}

export interface PresencePiece extends Span {
  kind: Piece["kind"];
  level: Level | null;
  how: Piece["how"];
  sure: boolean;
  point: Named | null;
  from: Named | null;
  to: Named | null;
  zone: string | null;
  known: PresenceArea | null;
  guessed: PresenceArea | null;
  units: { unit: string; reading: string | null }[];
  accounts: string[];
}

export interface PresenceArea extends Area {
  place: string | null;
  country: string;
  zone: string | null;
}

export function presence(pieces: readonly Piece[], labels: Labels, restsOn: (unit: string) => readonly string[], readings: ReadonlyMap<string, string> = new Map()): PresencePiece[] {
  const names = namesOf(pieces, labels);
  const cache = new AreaCache();
  const told = (area: Area | null, piece: Piece, place: string | null): PresenceArea | null => {
    const point = piece.kind === "move" ? piece.from : piece.point;
    if (area === null || area.country === null || point === null) return null;
    const level: Level = area.city !== null ? "city" : area.region !== null ? "region" : "country";
    return { ...area, country: area.country, place, zone: cache.zone(point, place !== null ? "place" : level) };
  };
  return pieces.map((piece, index) => {
    const { point, from, to } = names[index]!;
    const zone = piece.kind === "move" ? (from?.zone != null && from.zone === to?.zone ? from.zone : null) : point?.zone ?? null;
    const where = placed(piece, cache);
    const place = piece.kind !== "move" && piece.level === "place" && piece.how !== "guessed" ? point?.words ?? null : null;
    return {
      start_ms: piece.start_ms, end_ms: piece.end_ms, kind: piece.kind, level: piece.level, how: piece.how,
      sure: piece.how !== null && piece.how !== "bridged" && piece.how !== "guessed", point, from, to, zone,
      known: where === null ? null : told(where.known, piece, place), guessed: where?.guessed == null ? null : told(where.guessed, piece, null),
      units: piece.units.map((unit) => ({ unit, reading: readings.get(unit) ?? null })),
      accounts: accountsOf(piece.units.flatMap((unit) => restsOn(unit))),
    };
  });
}

type Sighted = Span & { centre: Point };

function sightingsOf(content: SeenContent, labels: Labels): Sighted[] {
  const seen = seenOf(content);
  const order = (left: Sighted, right: Sighted) => left.start_ms - right.start_ms || left.centre.latitude - right.centre.latitude || left.centre.longitude - right.centre.longitude;
  if ("sightings" in seen) {
    return seen.sightings.filter((sighting) => sighting.camera !== null && labels.mine(sighting.camera, sighting.start_ms))
      .map((sighting) => ({ start_ms: sighting.start_ms, end_ms: sighting.end_ms, centre: rounded(sighting.centre) })).sort(order);
  }
  const byCamera = new Map<string, Photo[][]>();
  for (const photo of seen.photos) {
    if (photo.camera === null || !labels.mine(photo.camera, photo.at_ms)) continue;
    const groups = byCamera.get(photo.camera) ?? [];
    byCamera.set(photo.camera, groups);
    const group = groups.at(-1);
    if (group !== undefined && photo.at_ms - group.at(-1)!.at_ms <= SIGHTING_GAP_MS && distanceMeters(centreOf(group), photo.point) <= SIGHTING_REACH_M) group.push(photo);
    else groups.push([photo]);
  }
  return [...byCamera.values()].flat().map((group) => ({ start_ms: group[0]!.at_ms, end_ms: group.at(-1)!.at_ms, centre: rounded(centreOf(group)) })).sort(order);
}

function centreOf(photos: readonly Photo[]): Point {
  const first = photos[0]!.point.longitude;
  const longitude = first + photos.reduce((sum, photo) => sum + (photo.point.longitude - first + 540) % 360 - 180, 0) / photos.length;
  return {
    latitude: photos.reduce((sum, photo) => sum + photo.point.latitude, 0) / photos.length,
    longitude: (longitude + 540) % 360 - 180,
  };
}


interface Candidate extends Span {
  kind: "stay" | "move";
  rank: number;
  how: How;
  by: string;
  level: Level;
  point: Where | null;
  from: Where | null;
  to: Where | null;
  unit: string;
  legs?: LegContent[];
  distance_m?: number;
  open?: true;
  walks?: Span[];
  silences?: Span[];
  doubted?: Piece["doubted"];
  confirmed?: Seen[];
  seen?: Seen;
}

interface Seen extends Span { point: Point; unit: string; rank: number; by: string }

function layDay(rows: readonly ExtractRow[], day: Span, labels: Labels, areas: AreaCache): DayLay {
  const clip = (span: Span): Span | null => {
    const start_ms = Math.max(span.start_ms, day.start_ms);
    const end_ms = Math.min(span.end_ms, day.end_ms);
    return end_ms > start_ms ? { start_ms, end_ms } : null;
  };
  const stays: Candidate[] = [];
  const moves: Candidate[] = [];
  const sightings: Seen[] = [];
  for (const row of [...rows].sort((left, right) => compare(left.unit, right.unit))) {
    const content = row.content as unknown as Evidence;
    if (content.kind === "seen") {
      for (const sighting of sightingsOf(content, labels)) {
        sightings.push({ start_ms: sighting.start_ms, end_ms: sighting.end_ms, point: sighting.centre, unit: row.unit, rank: content.rank, by: content.by });
      }
      continue;
    }
    if (content.kind !== "stay" && content.kind !== "trip") continue;
    const span = clip(content);
    if (span === null) continue;
    const base = { ...span, rank: content.rank, how: content.how, by: content.by, level: "place" as const, unit: row.unit };
    if (content.kind === "stay") {
      stays.push({ ...base, kind: "stay", point: content.centre, from: null, to: null, walks: content.bouts, silences: content.silences, ...(content.open ? { open: true } : {}) });
    } else {
      moves.push({ ...base, kind: "move", point: null, from: content.from, to: content.to, legs: content.legs, distance_m: content.distance_m });
    }
  }
  const kept = outAndBack(sightings.filter((sighting) => !stray(sighting, [...stays, ...moves])));
  const doubted = stays.flatMap((stay) => doubt(stay, kept, areas) ?? []);
  const seen = kept.flatMap((sighting): Candidate[] => {
    const agreeing = doubted.filter((stay) => stay.level === "place" && stay.start_ms <= sighting.end_ms && stay.end_ms >= sighting.start_ms &&
      distanceMeters(stay.point!, sighting.point) <= PLACE_BRIDGE_M);
    for (const stay of agreeing) stay.confirmed = [...stay.confirmed ?? [], sighting];
    const span = clip(vouched(sighting, [...moves, ...kept.filter((other) => other !== sighting)]));
    if (span === null) return [];
    return without(span, agreeing).filter((part) => part === span || part.end_ms - part.start_ms >= PART_MINIMUM_MS)
      .map((part) => ({ ...part, kind: "stay", rank: sighting.rank, how: "seen", by: sighting.by, level: "place", point: sighting.point, from: null, to: null, unit: sighting.unit, seen: sighting }));
  });
  const parts = lay([...doubted, ...moves, ...seen]);
  const placed = new Set(parts.flatMap(({ candidate }) => candidate.kind === "stay" && candidate.level === "place" ? [candidate] : []));
  const laid: LaidStay[] = [];
  for (const stay of doubted) {
    if (placed.has(stay)) laid.push({ unit: stay.unit, by: stay.by, start_ms: stay.start_ms, end_ms: stay.end_ms, centre: stay.point! });
  }
  const confirming = new Set([...placed].flatMap((stay) => stay.confirmed ?? []));
  const own = new Set([...placed].flatMap((candidate) => candidate.seen ?? []));
  for (const sighting of kept) {
    if (!own.has(sighting) && !confirming.has(sighting)) continue;
    const start_ms = Math.max(sighting.start_ms, day.start_ms), end_ms = Math.min(sighting.end_ms, day.end_ms - 1);
    if (start_ms <= end_ms) laid.push({ unit: sighting.unit, by: sighting.by, start_ms, end_ms, centre: sighting.point, closed: true });
  }
  laid.sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || compare(left.unit, right.unit));
  return { pieces: parts.map(({ candidate, start_ms, end_ms }) => pieceOf(candidate, start_ms, end_ms)), laid };
}

function stray(sighting: Seen, candidates: readonly Candidate[]): boolean {
  const observed = candidates.filter((candidate) => candidate.how === "observed" &&
    !(candidate.kind === "move" && candidate.start_ms < sighting.end_ms && candidate.end_ms > sighting.start_ms));
  const before = observed.filter((candidate) => candidate.start_ms <= sighting.start_ms).sort((left, right) => left.end_ms - right.end_ms).at(-1);
  const after = observed.filter((candidate) => candidate.end_ms >= sighting.end_ms).sort((left, right) => left.start_ms - right.start_ms)[0];
  const far = (point: Where | null, gap_ms: number) => point !== null && !reachable(point, sighting.point, gap_ms);
  return (before !== undefined && far(before.kind === "move" ? before.to : before.point, sighting.start_ms - before.end_ms)) ||
    (after !== undefined && far(after.kind === "move" ? after.from : after.point, after.start_ms - sighting.end_ms));
}

function outAndBack(sightings: readonly Seen[]): Seen[] {
  const runs: Seen[][] = [];
  for (const sighting of [...sightings].sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms || compare(left.unit, right.unit))) {
    const run = runs.at(-1);
    if (run !== undefined && seenReaches(run.at(-1)!, sighting)) run.push(sighting);
    else runs.push([sighting]);
  }
  const kept: Seen[][] = [];
  runs.forEach((run, index) => {
    const [before, after, last] = [kept.at(-1)?.at(-1), runs[index + 1]?.[0], run.at(-1)!];
    const back = before !== undefined && (before.end_ms >= last.end_ms || (after !== undefined && seenReaches(before, after) && !seenReaches(last, after)));
    if (!(back && !seenReaches(before!, run[0]!))) kept.push(run);
  });
  return kept.flat();
}

function seenReaches(earlier: Seen, later: Seen): boolean {
  return reachable(earlier.point, later.point, later.start_ms - earlier.end_ms);
}

function reachable(from: Point, to: Point, gap_ms: number): boolean {
  const meters = distanceMeters(from, to);
  return meters <= STRAY_M || meters <= STRAY_SPEED_MPS * Math.max(0, gap_ms) / 1000;
}

function without(span: Span, covers: readonly Span[]): Span[] {
  let parts = [span];
  for (const cover of covers) {
    if (cover.end_ms <= span.start_ms || cover.start_ms >= span.end_ms) continue;
    parts = parts.flatMap((part) => [
      { start_ms: part.start_ms, end_ms: Math.min(part.end_ms, cover.start_ms) }, { start_ms: Math.max(part.start_ms, cover.end_ms), end_ms: part.end_ms },
    ].filter((each) => each.end_ms > each.start_ms));
  }
  return parts;
}

function doubt(stay: Candidate, sightings: readonly Seen[], areas: AreaCache): Candidate | null {
  if (stay.how !== "stated" || stay.point === null) return stay;
  const point = stay.point;
  const far = sightings.filter((sighting) => sighting.end_ms >= stay.start_ms && sighting.start_ms <= stay.end_ms && distanceMeters(sighting.point, point) > DOUBT_M);
  if (far.length === 0) return stay;
  const own = areas.of(point);
  const level = (["city", "region", "country"] as const).find((each) => far.every((sighting) => agreeAt(each, own, areas.of(sighting.point))));
  if (level === undefined) return null;
  const first = far[0]!;
  return { ...stay, level, doubted: { by: [...new Set(far.map((sighting) => sighting.unit))].sort(compare), at_ms: first.start_ms, distance_m: Math.round(distanceMeters(first.point, point)) } };
}

function vouched(sighting: Seen, stops: readonly Span[]): Span {
  let start = sighting.start_ms - VOUCH_MS;
  let end = sighting.end_ms + VOUCH_MS;
  for (const stop of stops) {
    if (stop.start_ms < sighting.start_ms && stop.end_ms > start) start = Math.max(start, Math.min(stop.end_ms, sighting.start_ms));
    if (stop.end_ms > sighting.end_ms && stop.start_ms < end) end = Math.min(end, Math.max(stop.start_ms, sighting.end_ms));
  }
  return { start_ms: start, end_ms: end };
}

function lay(candidates: readonly Candidate[]): { candidate: Candidate; start_ms: number; end_ms: number }[] {
  const passed = new Map<Candidate, Span[]>();
  for (;;) {
    const parts = winners(candidates, passed);
    const short = parts.reduce<(typeof parts)[number] | null>((first, part) =>
      part.end_ms - part.start_ms >= PART_MINIMUM_MS || (part.start_ms === part.candidate.start_ms && part.end_ms === part.candidate.end_ms) ? first
        : first === null || better(part.candidate, first.candidate) < 0 ? part : first, null);
    if (short === null) return parts;
    passed.set(short.candidate, [...passed.get(short.candidate) ?? [], { start_ms: short.start_ms, end_ms: short.end_ms }]);
  }
}

function better(left: Candidate, right: Candidate): number {
  return left.rank - right.rank || left.start_ms - right.start_ms || compare(left.unit, right.unit);
}

function winners(candidates: readonly Candidate[], passed: ReadonlyMap<Candidate, readonly Span[]>): { candidate: Candidate; start_ms: number; end_ms: number }[] {
  const edges = [...new Set(candidates.flatMap((candidate) => [candidate.start_ms, candidate.end_ms]))].sort((left, right) => left - right);
  const sorted = [...candidates].sort((left, right) => left.start_ms - right.start_ms);
  const parts: { candidate: Candidate; start_ms: number; end_ms: number }[] = [];
  let active: Candidate[] = [];
  let next = 0;
  for (let index = 0; index + 1 < edges.length; index++) {
    const [start, end] = [edges[index]!, edges[index + 1]!];
    while (next < sorted.length && sorted[next]!.start_ms <= start) active.push(sorted[next++]!);
    active = active.filter((candidate) => candidate.end_ms > start);
    const winner = active.reduce<Candidate | null>((best, candidate) =>
      passed.get(candidate)?.some((span) => span.start_ms <= start && end <= span.end_ms) === true ? best : best === null || better(candidate, best) < 0 ? candidate : best, null);
    if (winner === null) continue;
    const last = parts.at(-1);
    if (last?.candidate === winner && last.end_ms === start) last.end_ms = end;
    else parts.push({ candidate: winner, start_ms: start, end_ms: end });
  }
  return parts;
}

function pieceOf(candidate: Candidate, start_ms: number, end_ms: number): Piece {
  const within = (spans: readonly Span[] | undefined) => (spans ?? []).filter((span) => span.end_ms > start_ms && span.start_ms < end_ms);
  const piece: Piece = {
    start_ms, end_ms, kind: candidate.kind, level: candidate.level, point: candidate.point, from: candidate.from, to: candidate.to,
    how: candidate.how, by: candidate.by, units: [candidate.unit, ...[...new Set((candidate.confirmed ?? []).map((sighting) => sighting.unit))].sort(compare).filter((unit) => unit !== candidate.unit)],
  };
  if (candidate.kind === "move") return { ...piece, legs: candidate.legs ?? [], distance_m: candidate.distance_m ?? 0 };
  return {
    ...piece, ...(candidate.open === true ? { open: true } : {}), walks: within(candidate.walks), silences: within(candidate.silences),
    ...(candidate.doubted === undefined ? {} : { doubted: candidate.doubted }),
  };
}


function joined(pieces: readonly Piece[], labels: Labels): Piece[] {
  const out: Piece[] = [];
  let held: { stay: Piece; place: PlaceLabel | undefined; reach: number; moves: Piece[] } | null = null;
  const release = () => {
    if (held !== null) out.push(...held.moves);
    held = null;
  };
  for (const piece of pieces) {
    if (piece.kind === "move") {
      if (held !== null && piece.start_ms <= held.reach && (legsOf(piece).length === 0 || (held.place !== undefined && inside(piece, held.place)))) {
        held.reach = Math.max(held.reach, piece.end_ms);
        held.moves.push(piece);
        continue;
      }
      release();
      out.push(piece);
      continue;
    }
    const placed = piece.kind === "stay" && piece.level === "place" && piece.point !== null;
    if (held !== null && placed && piece.by === held.stay.by && piece.start_ms <= held.reach && samePlace(held.stay.point!, piece.point!, labels)) {
      const stay = held.stay;
      const walks = held.moves.flatMap((move) => move.legs ?? [])
        .filter((leg) => (leg.mode === "walk" || leg.mode === "run") && leg.end_ms - leg.start_ms >= BOUT_WINDOW_MS).map(({ start_ms, end_ms }) => ({ start_ms, end_ms }));
      stay.end_ms = Math.max(stay.end_ms, piece.end_ms);
      if (piece.open === true) stay.open = true;
      else delete stay.open;
      stay.walks = [...stay.walks ?? [], ...walks, ...piece.walks ?? []];
      stay.silences = [...stay.silences ?? [], ...piece.silences ?? []];
      stay.units = [...new Set([...stay.units, ...held.moves.flatMap((move) => move.units), ...piece.units])];
      held.moves = [];
      held.reach = piece.end_ms;
      continue;
    }
    release();
    const stay: Piece = { ...piece, units: [...piece.units] };
    out.push(stay);
    if (placed) held = { stay, place: labels.place(piece.point!.latitude, piece.point!.longitude, piece.point!.id), reach: piece.end_ms, moves: [] };
  }
  release();
  return out;
}

function stitched(before: Piece, piece: Piece): Piece | null {
  const same = (left: unknown, right: unknown) => left === undefined || right === undefined ? left === right : canonical(left as Json) === canonical(right as Json);
  if (before.end_ms !== piece.start_ms || before.kind !== piece.kind || before.by !== piece.by || before.level !== piece.level ||
    !before.units.includes(piece.units[0]!) || !same(before.point, piece.point) || !same(before.doubted, piece.doubted)) return null;
  const once = (spans: readonly Span[]) => [...new Map(spans.map((span) => [`${span.start_ms}/${span.end_ms}`, span])).values()];
  const joined: Piece = { ...before, end_ms: piece.end_ms, units: [...new Set([...before.units, ...piece.units])] };
  if (piece.kind === "stay") {
    joined.walks = once([...before.walks ?? [], ...piece.walks ?? []]);
    joined.silences = once([...before.silences ?? [], ...piece.silences ?? []]);
    if (piece.open === true) joined.open = true;
    else delete joined.open;
  }
  return joined;
}

export function samePlace(left: Where, right: Where, labels: Labels): boolean {
  const [one, other] = [labels.place(left.latitude, left.longitude, left.id), labels.place(right.latitude, right.longitude, right.id)];
  return one !== undefined || other !== undefined ? one?.slug === other?.slug : distanceMeters(left, right) <= PLACE_BRIDGE_M;
}

function inside(move: Piece, place: PlaceLabel): boolean {
  if (move.from === null || move.to === null) return false;
  return (distanceMeters(move.from, place) + distanceMeters(move.to, place) + (move.distance_m ?? 0) + 50) / 2 <= place.radius_m;
}

export function legsOf(move: Pick<Piece, "from" | "to" | "legs" | "start_ms" | "end_ms">): (LegContent & { whole_ms: number })[] {
  const legs = move.legs ?? [];
  const apart = move.from === null || move.to === null ? null : distanceMeters(move.from, move.to);
  const bridged = (leg: LegContent) => leg.stated !== null && leg.distance_m / ((leg.end_ms - leg.start_ms) / 1_000) < WALK_SPEED_MIN_MPS;
  return legs.map((leg): LegContent => !bridged(leg) ? leg
    : { ...leg, mode: "unknown", motion: null, stated: null, distance_m: apart === null ? leg.distance_m : Math.round(apart / 100) * 100 })
    .filter((leg, index) => leg.distance_m > 0 && !(bridged(legs[index]!) && apart !== null && apart <= PLACE_REACH_M))
    .map((leg) => ({ ...leg, whole_ms: leg.end_ms - leg.start_ms, start_ms: Math.max(leg.start_ms, move.start_ms), end_ms: Math.min(leg.end_ms, move.end_ms) }))
    .filter((leg) => leg.end_ms >= leg.start_ms);
}


interface Side { point: Where; level: Level; area: Area; units: string[]; edge_ms: number }

function filled(pieces: readonly Piece[], window: Span, areas: AreaCache): Piece[] {
  const out: Piece[] = [];
  let cursor = window.start_ms;
  let before: Piece | null = null;
  for (const piece of pieces) {
    if (piece.start_ms > cursor) out.push(...gap({ start_ms: cursor, end_ms: piece.start_ms }, sideOf(before, "end", areas), sideOf(piece, "start", areas)));
    out.push(piece);
    cursor = Math.max(cursor, piece.end_ms);
    before = piece;
  }
  if (cursor < window.end_ms) out.push(...gap({ start_ms: cursor, end_ms: window.end_ms }, sideOf(before, "end", areas), null));
  return out;
}

function sideOf(piece: Piece | null, at: "start" | "end", areas: AreaCache): Side | null {
  if (piece === null || piece.level === null) return null;
  const point = piece.kind === "move" ? (at === "end" ? piece.to : piece.from) : piece.point;
  if (point === null) return null;
  return { point, level: piece.level, area: areas.at(point, piece.level), units: piece.units, edge_ms: at === "end" ? piece.end_ms : piece.start_ms };
}

function gap(span: Span, left: Side | null, right: Side | null): Piece[] {
  const length = span.end_ms - span.start_ms;
  const level = left === null || right === null ? undefined
    : LEVELS.find((each) => length <= BRIDGE[each] && levelOf(left) <= LEVELS.indexOf(each) && levelOf(right) <= LEVELS.indexOf(each) &&
      (each === "place" ? distanceMeters(left.point, right.point) <= PLACE_BRIDGE_M : agreeAt(each, left.area, right.area)));
  const units = [...new Set([...left?.units ?? [], ...right?.units ?? []])];
  const base = { kind: "gap" as const, from: left?.point ?? null, to: right?.point ?? null, units };
  if (level === "place" || level === "city") return [{ ...span, ...base, level, point: left!.point, how: "bridged" }];
  const middle = left === null ? span.start_ms : right === null ? span.end_ms : span.start_ms + Math.floor(length / 2);
  const halves: [Span, Side | null][] = [[{ start_ms: span.start_ms, end_ms: middle }, left], [{ start_ms: middle, end_ms: span.end_ms }, right]];
  return halves.filter(([half]) => half.end_ms > half.start_ms).flatMap(([half, side]): Piece[] => {
    if (level !== undefined) return [{ ...half, ...base, level, point: side!.point, how: "bridged", guess: side!.area }];
    const unknown = (part: Span): Piece => ({ ...part, ...base, level: null, point: null, how: null });
    if (side === null || side.area.city === null) return [unknown(half)];
    const reach = GUESS_DAYS * DAY_MS;
    const guessed = side === left ? { start_ms: half.start_ms, end_ms: Math.min(half.end_ms, side.edge_ms + reach) }
      : { start_ms: Math.max(half.start_ms, side.edge_ms - reach), end_ms: half.end_ms };
    if (guessed.end_ms <= guessed.start_ms) return [unknown(half)];
    const piece: Piece = { ...guessed, ...base, level: "city", point: side.point, how: "guessed" };
    const rest = side === left ? { start_ms: guessed.end_ms, end_ms: half.end_ms } : { start_ms: half.start_ms, end_ms: guessed.start_ms };
    const parts = side === left ? [piece, unknown(rest)] : [unknown(rest), piece];
    return parts.filter((part) => part.end_ms > part.start_ms);
  });
}

function levelOf(side: Side): number {
  return LEVELS.indexOf(side.level);
}

function agreeAt(level: Exclude<Level, "place">, left: Area, right: Area): boolean {
  const key = areaKey(level, left);
  return key !== null && key === areaKey(level, right);
}

function areaKey(level: Exclude<Level, "place">, area: Area): string | null {
  if (area.country === null) return null;
  const country = `${area.country_code ?? ""}\0${area.country}`;
  const within = level === "country" ? "" : level === "region" ? area.region : area.city_id;
  return within === null ? null : `${country}\0${within}`;
}

class AreaCache {
  readonly #found = new Map<string, Area>();
  readonly #zones = new Map<string, string | null>();

  zone(point: Point, level: Level): string | null {
    const key = `${point.latitude},${point.longitude},${level}`;
    let zone = this.#zones.get(key);
    if (zone === undefined) this.#zones.set(key, zone = zoneOf(point, level));
    return zone;
  }

  of(point: Point): Area {
    const key = `${point.latitude},${point.longitude}`;
    let area = this.#found.get(key);
    if (area === undefined) this.#found.set(key, area = areaOf(point));
    return area;
  }

  at(point: Point, level: Level): Area {
    const area = this.of(point);
    const index = LEVELS.indexOf(level);
    return {
      city: index <= 1 ? area.city : null, city_id: index <= 1 ? area.city_id : null, region: index <= 2 ? area.region : null,
      country: area.country, country_code: area.country_code,
    };
  }
}


export interface AreaCount {
  name: string;
  city_id?: string;
  country: string | null;
  days: number;
  nights: number;
  guessed_days: number;
  guessed_nights: number;
}

export interface PlaceCount {
  slug: string | null;
  name: string;
  latitude: number;
  longitude: number;
  hours: number;
  days: number;
}

export interface TripSummary {
  first: string;
  last: string;
  cities: string[];
  guessed: boolean;
}

export interface Summary {
  period: string;
  from: string;
  to: string;
  places: PlaceCount[];
  cities: AreaCount[];
  regions: AreaCount[];
  countries: AreaCount[];
  base: { city: string; city_id: string; nights: number } | null;
  trips: TripSummary[];
  coverage: {
    place: number; moving: number; city: number; region: number; country: number; guessed: number; unknown: number;
    days_unknown: string[];
    nights_unknown: string[];
  };
}

export function summarise(pieces: readonly Piece[], span: Span, grain: "day" | "month" | "year", settings: DaySettings, labels: Labels): Summary[] {
  const areas = new AreaCache();
  const days = daysIn(span, settings);
  const nights = new Map(days.flatMap((day) => {
    const at = nightAt(day, settings);
    return at < span.end_ms ? [[day, nightOf(at, pieces)] as const] : [];
  }));
  const bases = new Map<string, string | null>();
  for (const month of new Set(days.map((day) => day.slice(0, 7)))) {
    bases.set(month, baseOf(days.filter((day) => day.startsWith(month)).map((day) => nights.get(day) ?? null), areas)?.key ?? null);
  }
  const periods = new Map<string, string[]>();
  for (const day of days) {
    const period = grain === "day" ? day : grain === "month" ? day.slice(0, 7) : day.slice(0, 4);
    periods.set(period, [...periods.get(period) ?? [], day]);
  }
  return [...periods].map(([period, list]) => summaryOf(period, list, pieces, nights, bases, settings, labels, areas));
}

export interface DayArea {
  city: string | null;
  city_id: string | null;
  region: string | null;
  country: string;
  country_code: string | null;
  zone: string | null;
}

export interface PlacedDay {
  day: string;
  known: number[];
  guessed: number[];
  night?: number;
  night_guess?: number;
}

export interface PlacedDays {
  areas: DayArea[];
  days: PlacedDay[];
}

export function placedDays(pieces: readonly Piece[], span: Span, settings: DaySettings): PlacedDays {
  const cache = new AreaCache();
  const areas: DayArea[] = [];
  const indexes = new Map<string, number>();
  const indexOf = (area: Area, point: Point): number | null => {
    if (area.country === null) return null;
    const found: DayArea = { city: area.city, city_id: area.city_id, region: area.region, country: area.country, country_code: area.country_code, zone: cache.zone(point, area.city !== null ? "city" : area.region !== null ? "region" : "country") };
    const key = JSON.stringify(found);
    let index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, index = areas.length);
      areas.push(found);
    }
    return index;
  };
  const sides = (piece: Piece | null): { known: number | null; guessed: number | null } => {
    const where = placed(piece, cache);
    const point = piece?.kind === "move" ? piece.from : piece?.point ?? null;
    if (where === null || point === null) return { known: null, guessed: null };
    return { known: indexOf(where.known, point), guessed: where.guessed === null ? null : indexOf(where.guessed, point) };
  };
  const list = daysIn(span, settings);
  const days = new Map<string, { known: Set<number>; guessed: Set<number> }>(list.map((day) => [day, { known: new Set(), guessed: new Set() }]));
  for (const piece of pieces) {
    const start_ms = Math.max(piece.start_ms, span.start_ms);
    const end_ms = Math.min(piece.end_ms, Math.max(span.end_ms, span.start_ms + 1));
    if (end_ms <= start_ms) continue;
    const { known, guessed } = sides(piece);
    if (known === null && guessed === null) continue;
    for (let day = civilDay(start_ms, settings), last = civilDay(end_ms - 1, settings); day <= last; day = addDays(day, 1)) {
      const held = days.get(day);
      if (held === undefined) continue;
      if (known !== null) held.known.add(known);
      if (guessed !== null) held.guessed.add(guessed);
    }
  }
  return {
    areas,
    days: list.map((day) => {
      const held = days.get(day)!;
      const at = nightAt(day, settings);
      const night = at < span.end_ms ? sides(nightOf(at, pieces)) : { known: null, guessed: null };
      const [known, guessed] = [[...held.known].sort((a, b) => a - b), [...held.guessed].filter((each) => !held.known.has(each)).sort((a, b) => a - b)];
      return {
        day, known, guessed,
        ...(night.known === null ? {} : { night: night.known }), ...(night.guessed === null ? {} : { night_guess: night.guessed }),
      };
    }),
  };
}

function daysIn(span: Span, settings: DaySettings): string[] {
  const out: string[] = [];
  const last = civilDay(Math.max(span.end_ms, span.start_ms + 1) - 1, settings);
  for (let day = civilDay(span.start_ms, settings); day <= last; day = addDays(day, 1)) out.push(day);
  return out;
}

function nightOf(at: number, pieces: readonly Piece[]): Piece | null {
  let [low, high] = [0, pieces.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    if (pieces[middle]!.start_ms <= at) low = middle + 1;
    else high = middle;
  }
  const piece = pieces[low - 1];
  return piece !== undefined && at < piece.end_ms ? piece : null;
}

function placed(piece: Piece | null, areas: AreaCache): { known: Area; guessed: Area | null } | null {
  if (piece?.kind === "move") {
    if (piece.from === null || piece.to === null) return null;
    const [from, to] = [areas.of(piece.from), areas.of(piece.to)];
    const level = (["city", "region", "country"] as const).find((each) => agreeAt(each, from, to));
    return level === undefined ? null : { known: areas.at(piece.from, level), guessed: null };
  }
  if (piece === null || piece.level === null || piece.point === null) return null;
  if (piece.how === "guessed") return { known: { city: null, city_id: null, region: null, country: null, country_code: null }, guessed: areas.at(piece.point, piece.level) };
  return { known: areas.at(piece.point, piece.level), guessed: piece.guess ?? null };
}

function cityOf(night: ReturnType<typeof placed>): { key: string; city: string; city_id: string; guessed: boolean } | null {
  for (const [area, guessed] of [[night?.known, false], [night?.guessed, true]] as const) {
    const key = area == null ? null : areaKey("city", area);
    if (key !== null) return { key, city: area!.city!, city_id: area!.city_id!, guessed };
  }
  return null;
}

function baseOf(nights: readonly (Piece | null)[], areas: AreaCache): { key: string; city: string; city_id: string; nights: number } | null {
  const counted = new Map<string, { city: string; city_id: string; nights: number; known: number }>();
  for (const night of nights) {
    const where = cityOf(placed(night, areas));
    if (where === null) continue;
    const count = counted.get(where.key) ?? { city: where.city, city_id: where.city_id, nights: 0, known: 0 };
    count.nights++;
    if (!where.guessed) count.known++;
    counted.set(where.key, count);
  }
  const best = [...counted].sort(([leftKey, left], [rightKey, right]) => right.nights - left.nights || right.known - left.known || compare(leftKey, rightKey))[0];
  return best === undefined ? null : { key: best[0], city: best[1].city, city_id: best[1].city_id, nights: best[1].nights };
}

function summaryOf(
  period: string, days: readonly string[], pieces: readonly Piece[], nights: ReadonlyMap<string, Piece | null>, bases: ReadonlyMap<string, string | null>,
  settings: DaySettings, labels: Labels, areas: AreaCache,
): Summary {
  const bounds = { start_ms: dayBounds(days[0]!, settings).start_ms, end_ms: dayBounds(days.at(-1)!, settings).end_ms };
  const within = pieces.flatMap((piece) => {
    const start_ms = Math.max(piece.start_ms, bounds.start_ms);
    const end_ms = Math.min(piece.end_ms, bounds.end_ms);
    return end_ms > start_ms ? [{ ...piece, start_ms, end_ms }] : [];
  });
  const counts = { city: new Map<string, AreaTally>(), region: new Map<string, AreaTally>(), country: new Map<string, AreaTally>() };
  const tally = (where: NonNullable<ReturnType<typeof placed>>, day: string, night: boolean) => {
    for (const level of ["city", "region", "country"] as const) {
      const known = areaKey(level, where.known);
      const area = known !== null ? where.known : where.guessed;
      const key = area === null ? null : areaKey(level, area);
      if (area === null || key === null) continue;
      const found = counts[level].get(key) ?? { name: area[level]!, ...(level === "city" ? { city_id: area.city_id! } : {}), country: area.country, days: new Set(), nights: new Set(), guessed_days: new Set(), guessed_nights: new Set() };
      const guessed = known === null;
      (night ? guessed ? found.guessed_nights : found.nights : guessed ? found.guessed_days : found.days).add(day);
      counts[level].set(key, found);
    }
  };
  const places = new Map<string, { label: Omit<PlaceCount, "hours" | "days">; ms: number; days: Set<string> }>();
  const hours = { place: 0, moving: 0, city: 0, region: 0, country: 0, guessed: 0, unknown: 0 };
  const known = new Set<string>();
  for (const piece of within) {
    for (let day = civilDay(piece.start_ms, settings), last = civilDay(piece.end_ms - 1, settings); day <= last; day = addDays(day, 1)) {
      const dayBound = dayBounds(day, settings);
      const start_ms = Math.max(piece.start_ms, dayBound.start_ms);
      const end_ms = Math.min(piece.end_ms, dayBound.end_ms);
      if (end_ms <= start_ms) continue;
      const length = end_ms - start_ms;
      const where = placed(piece, areas);
      if (piece.kind === "move") {
        hours.moving += length;
        known.add(day);
        if (where !== null) tally(where, day, false);
        continue;
      }
      if (where === null) {
        hours.unknown += length;
        continue;
      }
      known.add(day);
      hours[piece.how === "guessed" ? "guessed" : piece.level!] += length;
      tally(where, day, false);
      if (piece.level === "place" && piece.point !== null) {
        const place = labels.place(piece.point.latitude, piece.point.longitude, piece.point.id);
        const key = place?.slug ?? `${piece.point.latitude.toFixed(3)},${piece.point.longitude.toFixed(3)}`;
        const entry = places.get(key) ?? {
          label: { slug: place?.slug ?? null, name: place?.name ?? placeWords(piece.point, labels), latitude: place?.latitude ?? piece.point.latitude, longitude: place?.longitude ?? piece.point.longitude },
          ms: 0, days: new Set<string>(),
        };
        entry.ms += length;
        entry.days.add(day);
        places.set(key, entry);
      }
    }
  }
  for (const day of days) {
    const night = placed(nights.get(day) ?? null, areas);
    if (night !== null) tally(night, day, true);
  }
  const base = baseOf(days.map((day) => nights.get(day) ?? null), areas);
  const total = Object.values(hours).reduce((sum, value) => sum + value, 0) || 1;
  const share = (value: number) => Math.round(value / total * 1_000) / 1_000;
  const listed = (map: Map<string, AreaTally>): AreaCount[] => [...map.values()].map((count) => ({
    name: count.name, ...(count.city_id === undefined ? {} : { city_id: count.city_id }), country: count.country, days: count.days.size, nights: count.nights.size,
    guessed_days: [...count.guessed_days].filter((day) => !count.days.has(day)).length,
    guessed_nights: [...count.guessed_nights].filter((day) => !count.nights.has(day)).length,
  })).sort((left, right) => right.nights + right.guessed_nights - left.nights - left.guessed_nights || right.days - left.days || compare(left.name, right.name));
  return {
    period, from: days[0]!, to: days.at(-1)!,
    places: [...places.values()].map(({ label, ms, days: on }) => ({ ...label, hours: Math.round(ms / HOUR_MS * 100) / 100, days: on.size }))
      .sort((left, right) => right.hours - left.hours || compare(left.name, right.name)),
    cities: listed(counts.city), regions: listed(counts.region), countries: listed(counts.country),
    base: base === null ? null : { city: base.city, city_id: base.city_id, nights: base.nights },
    trips: tripsOf(days, nights, bases, areas),
    coverage: {
      place: share(hours.place), moving: share(hours.moving), city: share(hours.city), region: share(hours.region), country: share(hours.country),
      guessed: share(hours.guessed), unknown: share(hours.unknown),
      days_unknown: days.filter((day) => !known.has(day)), nights_unknown: days.filter((day) => nights.has(day) && placed(nights.get(day)!, areas) === null),
    },
  };
}

interface AreaTally { name: string; city_id?: string; country: string | null; days: Set<string>; nights: Set<string>; guessed_days: Set<string>; guessed_nights: Set<string> }

function tripsOf(days: readonly string[], nights: ReadonlyMap<string, Piece | null>, bases: ReadonlyMap<string, string | null>, areas: AreaCache): TripSummary[] {
  const trips: TripSummary[] = [];
  let open: { trip: TripSummary; named: Set<string> } | null = null;
  for (const day of days) {
    const night = placed(nights.get(day) ?? null, areas);
    const city = cityOf(night);
    const base = bases.get(day.slice(0, 7)) ?? null;
    if (night === null || base === null || city?.key === base) {
      open = null;
      continue;
    }
    const level = city !== null ? "city" : night.known.region !== null ? "region" : "country";
    const [key, name] = city !== null ? [city.key, city.city] : [areaKey(level, night.known), night.known[level]];
    if (open === null) trips.push((open = { trip: { first: day, last: day, cities: [], guessed: false }, named: new Set() }).trip);
    open.trip.last = day;
    if (key !== null && name !== null && !open.named.has(key)) {
      open.named.add(key);
      open.trip.cities.push(name);
    }
    open.trip.guessed ||= city?.guessed === true;
  }
  return trips;
}
