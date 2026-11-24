import { brotliDecompressSync } from "node:zlib";
import { GONE, parse, type BlobReader, type Json, type JsonObject, type RecordRef, type Version, type View } from "@lifestreamprotocol/core";
import { coastInactive, object, sourceOf, text, type Roles } from "./sittings.js";

export interface FrameRow {
  t: number;
  app: string;
  bundle: string | null;
  title: string | null;
  site: string | null;
  inactive: boolean;
  text(): string[];
}

export interface GapRow {
  s: number;
  e: number;
  status: string;
  reason: string | null;
}

export interface InputEvent {
  t: number;
  e: string;
  app?: string;
  site?: string;
  poster?: string;
  raw: JsonObject;
}

export interface MachineEvent {
  t: number;
  event: string;
  detail: JsonObject;
}

export interface SittingRead {
  rows: FrameRow[];
  gaps: GapRow[];
  events: InputEvent[];
  machine: MachineEvent[];
  hasInput: boolean;
  textMissing: number;
}

export const AFTER_END_MS = 300_000;
const BEFORE_START_MS = 60_000;
const SHIPPER_RUN = "shipper_run";
const MAX_SEGMENT_BODY = 512 * 1024 * 1024;
const TEXT_WINDOW_MS = 300_000;
export const WALK_SEGMENTS = 1;
const SITTING_SEGMENTS = 4;
const CHROME_ROLES = new Set(["AXToolbar", "AXTabGroup", "AXMenuBar", "AXMenuButton", "AXScrollBar"]);
const TYPING_ROLES = new Set(["TextField", "TextArea", "ComboBox", "SearchField"]);
const KNOWN_APPS: ReadonlyMap<string, string> = new Map([["com.apple.Spotlight", "Spotlight"]]);

export function readSitting(view: View, roles: Roles, blobs: BlobReader, machine: string, cutover_ms: number, start: number, end: number): SittingRead {
  const rows: FrameRow[] = [];
  const gaps: GapRow[] = [];
  let textMissing = 0;
  const coast = sourceOf(view, roles, machine, "prior");
  const recorder = sourceOf(view, roles, machine, "frames");
  if (start < cutover_ms && coast !== undefined) rows.push(...coastRows(view, coast, start, Math.min(end, cutover_ms)));
  if (end > cutover_ms && recorder !== undefined) {
    const read = recorderRows(view, blobs, recorder, Math.max(start, cutover_ms), end);
    rows.push(...read.rows);
    gaps.push(...read.gaps);
    textMissing = read.missing;
  }
  rows.sort((left, right) => left.t - right.t || compare(left.app, right.app) || compare(left.title ?? "", right.title ?? ""));
  const input = sourceOf(view, roles, machine, "input");
  const hasInput = input !== undefined;
  const names = new Map<string, string>();
  for (const row of rows) if (row.bundle !== null) names.set(row.bundle, row.app);
  const events = hasInput ? namedApps(inputEvents(view, input, start, end, names), rows) : [];
  const machineSource = sourceOf(view, roles, machine, "machine");
  const happened = machineSource === undefined ? [] : machineEvents(view, machineSource, start - BEFORE_START_MS, end + AFTER_END_MS);
  return { rows, gaps, events, machine: happened, hasInput, textMissing };
}

export function shipperRun(content: Json | undefined): boolean {
  return object(content).event === SHIPPER_RUN;
}

function machineEvents(view: View, source: string, from: number, to: number): MachineEvent[] {
  const out: MachineEvent[] = [];
  for (const { head, version } of view.records(source, "machine-event", { start_ms: from, end_ms: to + 1 })) {
    const t = head.start_ms!;
    const content = object(version.content);
    if (t < from || t > to || content.type !== "machine.event" || shipperRun(content) || typeof content.event !== "string") continue;
    out.push({ t, event: content.event, detail: object(content.detail) });
  }
  return out.sort((left, right) => left.t - right.t || compare(left.event, right.event));
}


export interface ScreenFrameHead {
  t: number;
  app: string;
  title: string | null;
  site: string | null;
  display: string;
  read: string;
}

export interface ScreenText {
  lines: string[];
  ocr: string[];
}

export interface LazyFrame extends ScreenFrameHead {
  text(): ScreenText;
}

export interface ScreenFrameRead extends ScreenFrameHead, ScreenText {}

export class ScreenFrameReader {
  readonly #segments: Segments;

  constructor(private readonly view: View, private readonly roles: Roles, blobs: BlobReader, private readonly cutover_ms: number, segmentsHeld: number) {
    this.#segments = new Segments(blobs, segmentsHeld);
  }

  frames(machine: string, start: number, end: number): LazyFrame[] {
    return [...this.#stored(machine, start, end)].sort(inOrder);
  }

  reads(machine: string, start: number, end: number): ScreenFrameRead[] {
    const out: ScreenFrameRead[] = [];
    for (const frame of this.#stored(machine, start, end)) out.push(frameRead(frame));
    return out.sort(inOrder);
  }

  *#stored(machine: string, start: number, end: number): Generator<LazyFrame> {
    const coast = sourceOf(this.view, this.roles, machine, "prior");
    const recorder = sourceOf(this.view, this.roles, machine, "frames");
    if (start < this.cutover_ms && coast !== undefined) yield* coastFrames(this.view, coast, start, Math.min(end, this.cutover_ms));
    if (end > this.cutover_ms && recorder !== undefined) yield* recorderFrames(this.view, this.#segments, recorder, Math.max(start, this.cutover_ms), end);
  }
}

export function screenFrames(view: View, roles: Roles, blobs: BlobReader, machine: string, cutover_ms: number, start: number, end: number): ScreenFrameRead[] {
  return new ScreenFrameReader(view, roles, blobs, cutover_ms, WALK_SEGMENTS).reads(machine, start, end);
}

export function segmentsSpanning(span_ms: number): number {
  return Math.ceil(span_ms / TEXT_WINDOW_MS) + 1;
}

function inOrder(left: ScreenFrameHead, right: ScreenFrameHead): number {
  return left.t - right.t || compare(left.app, right.app) || compare(left.title ?? "", right.title ?? "");
}

function frameRead(frame: LazyFrame): ScreenFrameRead {
  const { t, app, title, site, display, read } = frame;
  return { t, app, title, site, display, read, ...frame.text() };
}

function once<T>(read: () => T): () => T {
  let held: { value: T } | undefined;
  return () => (held ??= { value: read() }).value;
}

export function screenFrameVersions(view: View, blobs: BlobReader, role: "frames" | "prior", ref: RecordRef): ScreenFrameRead[] {
  const versions = (kind: string): Version[] => [...new Set(view.history({ source: ref.source, kind, key: ref.key })
    .map((statement) => statement.version).filter((id) => id !== GONE))].map((id) => view.version(id));
  const timed = (each: Version) => each.time?.start_ms;
  if (role === "frames") {
    if (ref.kind !== "frame") return [];
    const segments = new Segments(blobs, WALK_SEGMENTS);
    return versions("frame").flatMap((version) => {
      const t = timed(version);
      if (t === undefined) return [];
      const frame = recorderFrameOf(segments, t, version);
      return [{ t, app: frame.app, title: frame.title, site: frame.site, display: frame.display, read: frame.version, ...recorderScreenText(frame) }];
    });
  }
  if (ref.kind !== "frame" && ref.kind !== "ax") return [];
  const session = coastSessions(view, ref.source);
  const axes = [[] as string[], ...versions("ax").map((ax) => {
    const tree = object(ax.content).tree;
    return tree === undefined ? [] : treeLines(tree);
  })];
  return versions("frame").flatMap((version) => {
    const t = timed(version);
    if (t === undefined) return [];
    const frame = coastFrameOf(session, t, version);
    return axes.map((lines) => ({ t, app: frame.app, title: frame.title, site: frame.site, display: "", lines, ocr: coastOcr(frame.ocr), read: frame.version }));
  });
}


interface CoastFrame {
  t: number;
  key: string;
  version: string;
  app: string;
  bundle: string | null;
  title: string | null;
  site: string | null;
  inactive: boolean;
  ocr: string;
}

function* coastEach(view: View, source: string, start: number, end: number): Generator<CoastFrame> {
  const session = coastSessions(view, source);
  for (const { head, version } of view.records(source, "frame", { start_ms: start, end_ms: end })) {
    const t = head.start_ms!;
    if (t < start || t >= end) continue;
    yield coastFrameOf(session, t, version);
  }
}

function coastSessions(view: View, source: string): (identity: Json | undefined) => JsonObject | null {
  const sessions = new Map<string, JsonObject | null>();
  return (identity) => {
    if (typeof identity !== "string") return null;
    if (!sessions.has(identity)) {
      const head = view.head({ source, kind: "session", key: identity });
      const version = head === undefined || head.version === "gone" ? undefined : view.version(head.version);
      sessions.set(identity, version === undefined ? null : object(version.content));
    }
    return sessions.get(identity)!;
  };
}

function coastFrameOf(session: (identity: Json | undefined) => JsonObject | null, t: number, version: Version): CoastFrame {
  const content = object(version.content);
  const application = object(session(content.session_start_frame_identity)?.application);
  const display = text(application.display_name)?.replace(/^‎/u, "") ?? null;
  const bundle = text(application.bundle_id);
  return {
    t, key: version.key, version: version.id,
    app: display ?? bundle ?? "unknown",
    bundle,
    title: text(content.title),
    site: host(session(content.session_start_frame_identity)?.url),
    inactive: coastInactive(content),
    ocr: typeof content.foreground === "string" ? content.foreground : "",
  };
}

function coastAx(view: View, source: string, key: string): { version: string; lines(): string[] } {
  const ax = view.head({ source, kind: "ax", key });
  if (ax === undefined || ax.version === "gone") return { version: ax?.version ?? "none", lines: () => [] };
  return {
    version: ax.version,
    lines: () => {
      const tree = object(view.version(ax.version).content).tree;
      return tree === undefined ? [] : treeLines(tree);
    },
  };
}

function coastRows(view: View, source: string, start: number, end: number): FrameRow[] {
  return [...coastEach(view, source, start, end)].map(({ t, key, app, bundle, title, site, inactive, ocr }) => ({
    t, app, bundle, title, site, inactive,
    text: () => {
      const lines = coastAx(view, source, key).lines();
      return lines.length > 3 ? lines : coastOcr(ocr);
    },
  }));
}

function* coastFrames(view: View, source: string, start: number, end: number): Generator<LazyFrame> {
  for (const frame of coastEach(view, source, start, end)) {
    if (frame.inactive) continue;
    const ax = coastAx(view, source, frame.key);
    yield {
      t: frame.t, app: frame.app, title: frame.title, site: frame.site, display: "", read: `${frame.version}+${ax.version}`,
      text: once(() => ({ lines: ax.lines(), ocr: coastOcr(frame.ocr) })),
    };
  }
}

function coastOcr(ocr: string): string[] {
  return ocr.split(/(?<=[.!?])\s+/u).filter((line) => line.trim() !== "");
}

function treeLines(tree: Json): string[] {
  const out: string[] = [];
  const walk = (value: Json | undefined) => {
    const branch = object(value);
    const node = object(branch.node);
    const role = String(node.role ?? "");
    if (CHROME_ROLES.has(role)) return;
    const attributes: Record<string, string> = {};
    if (Array.isArray(node.attributes)) {
      for (const attribute of node.attributes) {
        const pair = object(attribute);
        if (typeof pair.name === "string") attributes[pair.name] = String(pair.value ?? "");
      }
    }
    nodeLines(out, role, text(node.value) ?? text(node.title) ?? text(node.description), {
      focused: attributes.focused === "true", url: attributes.url ?? null,
      label: text(node.title) ?? text(node.description) ?? text(attributes.placeholder ?? null),
    });
    if (Array.isArray(branch.children)) for (const child of branch.children) walk(child);
  };
  walk(tree);
  return out;
}

function* recorderFrames(view: View, segments: Segments, source: string, start: number, end: number): Generator<LazyFrame> {
  for (const frame of recorderEach(view, segments, source, start, end)) {
    yield {
      t: frame.t, app: frame.app, title: frame.title, site: frame.site, display: frame.display,
      read: `${frame.version}${frame.missing ? "+missing" : ""}`,
      text: once(() => recorderScreenText(frame)),
    };
  }
}

function recorderScreenText(frame: RecorderFrame): ScreenText {
  const read = frame.text();
  return read === null ? { lines: [], ocr: [] } : { lines: recorderLines(read.nodes), ocr: recorderOcr(read.ocr) };
}


interface Segment {
  frames: { splices: { array: number; member: string }[] }[];
  arrays: [number, number][];
  region: Buffer;
}

interface RecorderFrame {
  t: number;
  version: string;
  app: string;
  bundle: string | null;
  title: string | null;
  site: string | null;
  display: string;
  missing: boolean;
  text(): { nodes?: Json | undefined; ocr?: Json | undefined } | null;
}

function* recorderEach(view: View, segments: Segments, source: string, start: number, end: number): Generator<RecorderFrame> {
  for (const { head, version } of view.records(source, "frame", { start_ms: start, end_ms: end })) {
    const t = head.start_ms!;
    if (t < start || t >= end) continue;
    yield recorderFrameOf(segments, t, version);
  }
}

function recorderFrameOf(segments: Segments, t: number, version: Version): RecorderFrame {
  const content = object(version.content);
  const reference = object(content.text);
  const hash = typeof reference.segmentSHA256 === "string" ? `sha256:${Buffer.from(reference.segmentSHA256, "base64").toString("hex")}` : null;
  const ordinal = Number(reference.ordinal);
  const found = hash === null ? null : segments.get(hash);
  const windows = hash === null ? content.windows : found === null ? undefined : segmentText(found, ordinal, "windows").windows;
  const application = object(content.application);
  const name = text(application.name);
  const bundle = text(application.bundleID);
  const frontId = object(content.frontWindow).windowID;
  const front = Array.isArray(windows) && frontId !== undefined
    ? object(windows.find((window) => object(window).windowID === frontId)) : {};
  const activityOnly = content.status === "activity_only";
  return {
    t,
    version: version.id,
    app: name ?? bundle ?? "unknown",
    bundle,
    title: text(front.title),
    site: text(content.site) ?? text(front.site),
    display: content.displayID === undefined || content.displayID === null ? "" : String(content.displayID),
    missing: hash !== null && found === null,
    text: () => {
      if (activityOnly) return null;
      if (hash === null) return { ocr: content.ocr, nodes: object(content.accessibility).nodes };
      const segment = segments.get(hash);
      return segment === null ? {} : segmentText(segment, ordinal, "ocr", "nodes");
    },
  };
}

function recorderRows(view: View, blobs: BlobReader, source: string, start: number, end: number): { rows: FrameRow[]; gaps: GapRow[]; missing: number } {
  const segments = new Segments(blobs, SITTING_SEGMENTS);
  const rows: FrameRow[] = [];
  let missing = 0;
  for (const frame of recorderEach(view, segments, source, start, end)) {
    if (frame.missing) missing++;
    rows.push({
      t: frame.t, app: frame.app, bundle: frame.bundle, title: frame.title, site: frame.site, inactive: false,
      text: () => {
        const read = frame.text();
        return read === null ? [] : recorderText(read.nodes, read.ocr);
      },
    });
  }
  const gaps: GapRow[] = [];
  for (const { head, version } of view.records(source, "recorder", { start_ms: start, end_ms: end })) {
    const content = object(version.content);
    gaps.push({
      s: Math.max(head.start_ms!, start), e: Math.min(head.end_ms ?? head.start_ms!, end),
      status: String(content.status ?? "gap"), reason: text(content.reason),
    });
  }
  gaps.sort((left, right) => left.s - right.s || left.e - right.e);
  return { rows, gaps, missing };
}

function readSegment(bytes: Buffer): Segment | null {
  try {
    const body = brotliDecompressSync(bytes, { maxOutputLength: MAX_SEGMENT_BODY });
    const newline = body.indexOf(0x0a);
    const header = parse(body.subarray(0, newline).toString("utf8")) as {
      arrays: [number, number][];
      frames: { splices: { before: string; array: number }[] }[];
    };
    return {
      arrays: header.arrays,
      region: body.subarray(newline + 1),
      frames: header.frames.map((frame) => ({
        splices: frame.splices.map((splice) => ({ array: splice.array, member: /"(\w+)":$/u.exec(splice.before)?.[1] ?? "" })),
      })),
    };
  } catch {
    return null;
  }
}

class Segments {
  readonly #held = new Map<string, Segment>();
  readonly #absent = new Set<string>();
  constructor(private readonly blobs: BlobReader, private readonly most: number) {}

  get(hash: string): Segment | null {
    if (this.#absent.has(hash)) return null;
    const held = this.#held.get(hash);
    if (held !== undefined) {
      this.#held.delete(hash);
      this.#held.set(hash, held);
      return held;
    }
    const segment = this.blobs.has(hash) ? readSegment(this.blobs.bytes(hash)) : null;
    if (segment === null) {
      this.#absent.add(hash);
      return null;
    }
    this.#held.set(hash, segment);
    if (this.#held.size > this.most) this.#held.delete(this.#held.keys().next().value!);
    return segment;
  }
}

function segmentText(segment: Segment, ordinal: number, ...members: ("windows" | "ocr" | "nodes")[]): { windows?: Json; ocr?: Json; nodes?: Json } {
  const frame = segment.frames[ordinal];
  if (frame === undefined) return {};
  const found: Record<string, Json> = {};
  for (const splice of frame.splices) {
    if (!(members as string[]).includes(splice.member)) continue;
    const [offset, length] = segment.arrays[splice.array] ?? [0, 0];
    try {
      found[splice.member] = parse(segment.region.subarray(offset, offset + length).toString("utf8"));
    } catch {
      continue;
    }
  }
  return found;
}

function recorderText(nodes: Json | undefined, ocr: Json | undefined): string[] {
  const out = recorderLines(nodes);
  return out.length > 3 ? out : recorderOcr(ocr);
}

function recorderOcr(ocr: Json | undefined): string[] {
  return (Array.isArray(ocr) ? ocr : []).map((line) => text(object(line).text)).filter((line): line is string => line !== null);
}

function recorderLines(nodes: Json | undefined): string[] {
  const out: string[] = [];
  let skipBelow: number | null = null;
  for (const value of Array.isArray(nodes) ? nodes : []) {
    const node = object(value);
    const depth = Number(node.depth ?? 0);
    if (skipBelow !== null && depth > skipBelow) continue;
    skipBelow = null;
    const role = String(node.role ?? "");
    if (CHROME_ROLES.has(role)) {
      skipBelow = depth;
      continue;
    }
    nodeLines(out, role, text(node.value) ?? text(node.title) ?? text(node.description) ?? text(node.text), {
      focused: node.focused === true, url: text(node.url), label: text(node.title) ?? text(node.description),
    });
  }
  return out;
}

function nodeLines(out: string[], role: string, value: string | null, extra: { focused: boolean; url: string | null; label: string | null }): void {
  const short = role.replace(/^AX/u, "");
  const focused = extra.focused && TYPING_ROLES.has(short);
  let first = true;
  if (value !== null && short !== "Window" && short !== "Application") {
    for (const piece of value.split("\n")) {
      const line = piece.trimEnd();
      if (line.trim() === "") continue;
      const shown = short === "StaticText" || short === "TextArea" ? line
        : `[${short}] ${line}${extra.url !== null && short === "Link" ? ` <${extra.url}>` : ""}`;
      out.push(focused && first ? `▶ cursor here: ${shown}` : shown);
      first = false;
    }
  }
  if (focused && first) out.push(`▶ cursor here: empty ${short}${extra.label !== null ? ` “${extra.label}”` : ""}`);
}


function inputEvents(view: View, source: string, start: number, end: number, names: ReadonlyMap<string, string>): InputEvent[] {
  const out: InputEvent[] = [];
  for (const { head, version } of view.records(source, "input", { start_ms: start - 60_000, end_ms: end })) {
    const content = object(version.content);
    const at = head.start_ms!;
    const apps = Array.isArray(content.apps) ? content.apps.map(String) : [];
    const sites = Array.isArray(content.sites) ? content.sites.map(String) : [];
    for (const value of Array.isArray(content.events) ? content.events : []) {
      const raw = object(value);
      const t = at + Number(raw.t ?? Number.NaN);
      if (!(t >= start && t < end)) continue;
      const app = raw.app === undefined ? undefined : apps[Number(raw.app)];
      const site = raw.site === undefined ? undefined : sites[Number(raw.site)];
      const poster = raw.syn === undefined ? undefined : apps[Number(raw.syn)];
      out.push({
        t, e: String(raw.e), raw,
        ...(app === undefined ? {} : { app: names.get(app) ?? KNOWN_APPS.get(app) ?? app }),
        ...(site === undefined ? {} : { site }),
        ...(poster === undefined ? {} : { poster: names.get(poster) ?? KNOWN_APPS.get(poster) ?? poster }),
      });
    }
  }
  return out.sort((left, right) => left.t - right.t || compare(left.e, right.e));
}

function namedApps(events: InputEvent[], rows: readonly FrameRow[]): InputEvent[] {
  const votes = new Map<string, Map<string, number>>();
  let index = 0;
  for (const event of events) {
    if (event.e !== "activate" || event.app === undefined || !/^[\w-]+(\.[\w-]+)+$/u.test(event.app)) continue;
    while (index < rows.length && rows[index]!.t <= event.t) index++;
    const row = rows[index];
    if (row === undefined || row.t - event.t > 3_000) continue;
    const tally = votes.get(event.app) ?? new Map<string, number>();
    tally.set(row.app, (tally.get(row.app) ?? 0) + 1);
    votes.set(event.app, tally);
  }
  const names = new Map<string, string>();
  for (const [id, tally] of votes) {
    const [best, count] = [...tally].sort((left, right) => right[1] - left[1] || compare(left[0], right[0]))[0]!;
    const total = [...tally.values()].reduce((sum, n) => sum + n, 0);
    if (count * 2 > total) names.set(id, best);
  }
  if (names.size === 0) return events;
  return events.map((event) => ({
    ...event,
    ...(event.app !== undefined && names.has(event.app) ? { app: names.get(event.app)! } : {}),
    ...(event.poster !== undefined && names.has(event.poster) ? { poster: names.get(event.poster)! } : {}),
  }));
}

function host(url: Json | undefined): string | null {
  if (typeof url !== "string" || !/^https?:/u.test(url)) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

