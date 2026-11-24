import { createHash } from "node:crypto";
import { dayBounds, GONE, type BlobReader, type DaySettings, type RecordRef, type ScreenAdapter, type View } from "@lifestreamprotocol/core";
import { screenFrames, screenFrameVersions, ScreenRoles, type Family, type Given, type ScreenFrameRead } from "@lifestreamprotocol/families";
import { SEGMENT_MS, type ScreenSegment, type ScreenSource } from "./screen-index.js";
import { keyOf, plainLine } from "./screen-keys.js";

export function bucketOf(t: number): number {
  return Math.floor(t / SEGMENT_MS) * SEGMENT_MS;
}

export function screenRoles(families: readonly Family[]): ScreenRoles | undefined {
  const given = (families.find((family) => family.name === "screen")?.adapters ?? []) as readonly Given<ScreenAdapter>[];
  return given.some((each) => each.adapter.role === "frames" || each.adapter.role === "prior") ? new ScreenRoles(given) : undefined;
}

export function frameSources(view: View, roles: ScreenRoles): Map<string, string> {
  const products = [...roles.products("frames"), ...roles.products("prior")];
  const out = new Map<string, string>();
  if (products.length === 0) return out;
  for (const row of view.sources({ product: products })) {
    const role = roles.of(row);
    if (role === "frames" || role === "prior") out.set(row.id, row.copy);
  }
  return out;
}

export interface MachineSources {
  of(machine: string): readonly string[];
  machines(): readonly string[];
}

export function machineSources(view: View, roles: ScreenRoles | undefined): MachineSources {
  let held: Map<string, string[]> | undefined;
  const read = () => {
    if (held !== undefined) return held;
    held = new Map();
    for (const [source, copy] of roles === undefined ? [] : frameSources(view, roles)) held.set(copy, [...held.get(copy) ?? [], source]);
    return held;
  };
  return { of: (machine) => read().get(machine) ?? [], machines: () => [...read().keys()] };
}

export function withoutRecords(view: View, records: readonly RecordRef[]): View {
  const gone = new Set(records.map((record) => `${record.source}\0${record.kind}\0${record.key}`));
  const kept = (source: string, kind: string, key: string) => !gone.has(`${source}\0${kind}\0${key}`);
  const reads: Partial<View> = {
    head: (ref) => kept(ref.source, ref.kind, ref.key) ? view.head(ref) : undefined,
    *heads(source, kind, range) {
      for (const head of view.heads(source, kind, range)) if (kept(source, kind, head.key)) yield head;
    },
    *records(source, kind, range) {
      for (const each of view.records(source, kind, range)) if (kept(source, kind, each.head.key)) yield each;
    },
  };
  return new Proxy(view, {
    get(target, name) {
      if (Object.hasOwn(reads, name)) return reads[name as keyof View];
      const value: unknown = Reflect.get(target, name, target);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

export function erasedStretches(view: View, roles: ScreenRoles, records: readonly RecordRef[]): { machine: string; from_ms: number; to_ms: number }[] {
  const machines = frameSources(view, roles);
  const out: { machine: string; from_ms: number; to_ms: number }[] = [];
  for (const record of records) {
    const machine = machines.get(record.source);
    if (machine === undefined) continue;
    const ref = record.kind === "ax" ? { ...record, kind: "frame" } : record;
    const versions = new Set(view.history(ref).map((statement) => statement.version).filter((id) => id !== GONE));
    for (const id of versions) {
      const time = view.version(id).time;
      if (time === undefined) continue;
      out.push({ machine, from_ms: time.start_ms, to_ms: Math.max(time.start_ms + 1, time.end_ms ?? time.start_ms) });
    }
  }
  return out;
}

export function erasedTexts(view: View, roles: ScreenRoles, blobs: BlobReader, cutover_ms: number, stretches: readonly { machine: string; from_ms: number; to_ms: number }[], records: readonly RecordRef[]): string[] {
  const out = new Set<string>();
  const take = (frame: ScreenFrameRead) => {
    const key = keyOf(frame.app, frame.site, frame.title, frame.lines);
    out.add(key.name);
    out.add(key.name !== "" ? key.name : key.app);
    for (const line of [...frame.lines, ...frame.ocr]) out.add(plainLine(line));
  };
  for (const stretch of stretches) for (const frame of screenFrames(view, roles, blobs, stretch.machine, cutover_ms, stretch.from_ms, stretch.to_ms)) take(frame);
  const sources = new Map<string, "frames" | "prior">();
  const products = [...roles.products("frames"), ...roles.products("prior")];
  for (const row of products.length === 0 ? [] : view.sources({ product: products })) {
    const role = roles.of(row);
    if (role === "frames" || role === "prior") sources.set(row.id, role);
  }
  for (const record of records) {
    const role = sources.get(record.source);
    if (role !== undefined) for (const frame of screenFrameVersions(view, blobs, role, record)) take(frame);
  }
  return [...out].filter((text) => text.trim() !== "");
}

export class ViewScreenSource implements ScreenSource {
  constructor(
    private readonly view: View,
    private readonly roles: ScreenRoles,
    private readonly blobs: BlobReader,
    private readonly cutover_ms: number,
    private readonly days: DaySettings,
  ) {}

  *segments(machine: string, day: string): Iterable<ScreenSegment> {
    const { start_ms, end_ms } = dayBounds(day, this.days);
    const frames = screenFrames(this.view, this.roles, this.blobs, machine, this.cutover_ms, start_ms, end_ms);
    let at = 0;
    while (at < frames.length) {
      const bucket = bucketOf(frames[at]!.t);
      let next = at;
      while (next < frames.length && bucketOf(frames[next]!.t) === bucket) next++;
      yield segmentOf(machine, Math.max(bucket, start_ms), Math.min(bucket + SEGMENT_MS, end_ms), frames.slice(at, next));
      at = next;
    }
  }

  segment(machine: string, bucket_ms: number, day: string): ScreenSegment | undefined {
    const bounds = dayBounds(day, this.days);
    const from = Math.max(bucket_ms, bounds.start_ms);
    const to = Math.min(bucket_ms + SEGMENT_MS, bounds.end_ms);
    if (from >= to) return undefined;
    const frames = screenFrames(this.view, this.roles, this.blobs, machine, this.cutover_ms, from, to);
    return frames.length === 0 ? undefined : segmentOf(machine, from, to, frames);
  }
}

function segmentOf(machine: string, start_ms: number, end_ms: number, frames: ReturnType<typeof screenFrames>): ScreenSegment {
  const hash = createHash("sha256");
  for (const frame of frames) hash.update(`${frame.t}\0${frame.read}\n`);
  return {
    machine,
    version: hash.digest("hex").slice(0, 32),
    start_ms,
    end_ms,
    frames: frames.map(({ t, app, title, site, display, lines, ocr }) => ({ t, app, title, site, display, lines, ocr })),
  };
}
