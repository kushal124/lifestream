import { sourceName, selects, type How, type InputRecord, type Json, type SourceSelector, type View } from "@lifestreamprotocol/core";
import type { Point, Where } from "../shared/places.js";
import type { Level, Mode, Span } from "./segment.js";

export const PHYSICAL = "physical";
export const PHYSICAL_CODE = "14";
export const OPEN_END_MS = Number.MAX_SAFE_INTEGER;

export type { How };

export interface Witnessed {
  rank: number;
  how: How;
  by: string;
}

export interface StayContent extends Witnessed {
  kind: "stay";
  source: string;
  start_ms: number;
  end_ms: number;
  open: boolean;
  centre: Where;
  level: Level | "stated";
  silences: Span[];
  bouts: Span[];
  record?: { source: string; kind: string; key: string };
}

export interface LegContent extends Span {
  mode: Mode;
  distance_m: number;
  motion: string | null;
  stated: string | null;
}

export interface TripContent extends Witnessed {
  kind: "trip";
  source: string;
  start_ms: number;
  end_ms: number;
  from: Where | null;
  to: Where | null;
  distance_m: number;
  legs: LegContent[];
  record?: { source: string; kind: string; key: string };
}

export interface Photo {
  at_ms: number;
  point: Point;
  accuracy_m: number | null;
  camera: string | null;
}

export interface SeenContent extends Witnessed {
  kind: "seen";
  source: string;
  date: string;
  start_ms: number;
  end_ms: number;
  photos: Photo[];
}

export interface StoredSighting extends Span {
  centre: Point;
  accuracy_m: number | null;
  camera: string | null;
}

export function seenOf(content: SeenContent): { photos: Photo[] } | { sightings: StoredSighting[] } {
  if (content.photos !== undefined) return { photos: content.photos };
  return { sightings: (content as unknown as { sightings: StoredSighting[] }).sightings };
}

export type Said<T> = Omit<T, keyof Witnessed>;
export type Evidence = StayContent | TripContent | SeenContent;


export function unitName(kind: string, source: string, rest: string): string {
  return `${kind}/${source}/${rest}`;
}

export function parseUnit(unit: string): { kind: string; source: string; rest: string } {
  const first = unit.indexOf("/");
  const second = unit.indexOf("/", first + 1);
  if (first < 0 || second < 0) throw new TypeError(`not a physical unit: ${JSON.stringify(unit)}`);
  return { kind: unit.slice(0, first), source: unit.slice(first + 1, second), rest: unit.slice(second + 1) };
}

export function owned(unit: string, kinds: readonly string[], sources: SourceSelector): boolean {
  const first = unit.indexOf("/");
  const second = unit.indexOf("/", first + 1);
  if (first < 0 || second < 0 || !kinds.includes(unit.slice(0, first))) return false;
  try {
    return selects(sources, sourceName(unit.slice(first + 1, second)));
  } catch {
    return false;
  }
}

export function liveRecord(view: View, source: string, kind: string, key: string): InputRecord | null {
  const row = view.source(source);
  const head = view.head({ source, kind, key });
  return row === undefined || head === undefined || head.version === "gone" ? null : { source: row, version: view.version(head.version) };
}


export function finite(value: Json | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function pointOf(latitude: Json | undefined, longitude: Json | undefined): Point | null {
  return finite(latitude) && finite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? { latitude, longitude } : null;
}

export function rounded(point: Point): Point {
  return { latitude: Math.round(point.latitude * 1e6) / 1e6, longitude: Math.round(point.longitude * 1e6) / 1e6 };
}

export function hundred(meters: number): number {
  return Math.round(meters / 100) * 100;
}

export function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
