import { dirname, join } from "node:path";
import {
  openHomeFolder, type BlobStore, type DaySettings, type HomeDb, type JobRow, type JsonObject, type OpenView, type ReaderOutput, type Tx,
} from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { openLedger } from "@lifestreamprotocol/model";
import { extractCursor, extractKind, rebuildCursor, walkKind } from "../derive.js";
import { Due, type DueHome } from "../due.js";
import { LANE, type HelperEnv, type Kind, type Main, type Running } from "../jobs.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const S = 1_000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const MACHINE = "macbook-pro-0001";
const COAST = `coast:local:${MACHINE}`;
const PHONE = "iphone-0001";
const LOCATION = `location:local:${PHONE}`;
const MOTION = `motion:local:${PHONE}`;
const INSTALL = "11111111-1111-4111-8111-111111111111";
const PROCESS = "22222222-2222-4222-8222-222222222222";
const BASE = Date.UTC(2026, 7, 3, 9, 0);

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}


export interface Chunk {
  statements: number;
  touched_rows: number;
  extract_rows: number;
  extract_bytes: number;
  units: number;
  ms: number;
}

export interface Drained {
  chunks: Chunk[];
  touched_bytes: number;
  commit_bytes: number;
  touched: number[][];
  runs: { statements: number; fetched: number; extracts: number; units: number; ms: number }[];
  written: number;
  deleted: number;
  units: number;
  fixes: number;
  views: number;
  reads: Counter["reads"];
  walked?: { slabs: number; records: number; views: number };
}

export class Counter {
  phase: "home" | "touched" | "extract" = "home";
  statements = 0;
  fetched = 0;
  touched = 0;
  extract = 0;
  fixes = 0;
  bytes = 0;
  views = 0;
  reads = { records: 0, versions: 0, extracts: 0, kinds: {} as Record<string, number> };
  extracted = new Map<string, number>();
  touchedCalls: number[] = [];
  touchedBytes = 0;

  count(method: string, rows: number, value: unknown): void {
    if (method === "source" || method === "sources") return;
    if (method === "statements") this.statements += rows;
    else if (this.phase === "touched") this.touched += rows;
    else if (this.phase === "extract") this.extract += rows;
    const kind = value !== null && typeof value === "object" ? (value as { kind?: string }).kind ?? (value as { head?: { kind: string } }).head?.kind : undefined;
    if (this.phase !== "home" && kind === "fix") this.fixes += rows;
    if (this.phase !== "home") {
      if (method === "version") this.reads.versions += rows;
      else if (/^extract/u.test(method)) this.reads.extracts += rows;
      else if (["head", "heads", "records", "keyedUnder", "erasedUnder"].includes(method)) {
        this.reads.records += rows;
        if (kind !== undefined) this.reads.kinds[kind] = (this.reads.kinds[kind] ?? 0) + rows;
      }
    }
    if ((method === "extracts" || method === "extract") && value !== undefined) this.bytes += JSON.stringify((value as { content: unknown }).content).length;
  }

  view(view: OpenView): OpenView {
    const internal = view as unknown as { sql?: { all(text: string, ...params: unknown[]): unknown[] } };
    const sql = internal.sql;
    if (sql !== undefined) internal.sql = new Proxy(sql, {
      get: (target, property) => {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        if (property !== "all") return (value as (...args: unknown[]) => unknown).bind(target);
        return (text: string, ...params: unknown[]) => {
          const rows = target.all(text, ...params);
          if (/^SELECT .+? FROM statements (WHERE seq >|INDEXED BY statements_source)/su.test(text)) this.fetched += rows.length;
          return rows;
        };
      },
    });
    return new Proxy(view, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") return value;
        const method = String(property);
        return (...args: unknown[]) => {
          const result = (value as (...args: unknown[]) => unknown).apply(target, args);
          if (method === "horizon") return this.view(result as OpenView);
          if (Array.isArray(result)) {
            for (const item of result) this.count(method, 1, item);
            return result;
          }
          if (result !== null && typeof result === "object" && Symbol.iterator in result) {
            const counter = this;
            return (function* () {
              for (const item of result as Iterable<unknown>) {
                counter.count(method, 1, item);
                yield item;
              }
            })();
          }
          if (result !== null && typeof result === "object") this.count(method, 1, result);
          return result;
        };
      },
    });
  }

  family(family: Family): Family {
    const within = <T>(phase: Counter["phase"], work: () => T): T => {
      this.phase = phase;
      try {
        return work();
      } finally {
        this.phase = "home";
      }
    };
    return {
      ...family,
      touched: (...args: Parameters<Family["touched"]>) => {
        const before = this.touched;
        this.touchedBytes = Math.max(this.touchedBytes, args[0].reduce((sum, change) => sum + (change.before?.text.length ?? 0) + (change.after?.text.length ?? 0), 0));
        try {
          return within("touched", () => family.touched(...args));
        } finally {
          this.touchedCalls.push(this.touched - before);
        }
      },
      extract: (...args: Parameters<Family["extract"]>) => {
        this.extracted.set(args[0], (this.extracted.get(args[0]) ?? 0) + 1);
        return within("extract", () => family.extract(...args));
      },
      ...(family.readThrough === undefined ? {} : { readThrough: (...args: Parameters<NonNullable<Family["readThrough"]>>) => within("touched", () => family.readThrough!(...args)) }),
    };
  }
}

export interface Ran {
  statements: number;
  built: string[];
  more: boolean;
  lane: number | null;
}

export interface Watched {
  due: Due;
  running?: Running | undefined;
}

const NOW = BASE + 30 * 86_400_000;

export function watchDue(db: HomeDb, families: readonly Family[]): Watched {
  const root = dirname(db.path);
  openLedger(openHomeFolder(root), { mode: "migrate" }).close();
  const watched = {} as Watched;
  const home = {
    folder: openHomeFolder(root), settings: { day: SETTINGS }, registry: { connectors: [], families }, families: new Map(families.map((family) => [family.name, family])),
    now: () => NOW, running: (job: number) => watched.running?.job.id === job ? watched.running : undefined,
  } as unknown as DueHome;
  watched.due = new Due(home);
  return watched;
}

export async function drain(
  db: HomeDb, reader: HomeDb, blobs: BlobStore, plain: Family, options: { afterRun?: (ran: Ran) => void; watched?: Watched } = {},
): Promise<Drained> {
  const { afterRun, watched } = options;
  const counter = new Counter();
  const family = counter.family(plain);
  const main = { families: new Map([[family.name, family]]), now: () => NOW, log: () => undefined } as unknown as Main;
  const commit = <T>(work: (tx: Tx) => T): T => db.commit((tx) => {
    const done = work(tx);
    watched?.due.after(tx);
    return done;
  });
  const counted = new Proxy(reader, {
    get: (target, property, receiver) => property === "view" ? () => {
      counter.views++;
      return counter.view(target.view());
    } : Reflect.get(target, property, receiver) as unknown,
  });
  const env = {
    db: counted, folder: openHomeFolder(dirname(db.path)), blobs, registry: { connectors: [], families: [family] }, settings: { day: SETTINGS }, committed: async () => undefined,
  } as unknown as HelperEnv;
  const drained: Drained = { chunks: [], touched: [], touched_bytes: 0, commit_bytes: 0, runs: [], written: 0, deleted: 0, units: 0, fixes: 0, views: 0, reads: counter.reads };
  db.commit((tx) => {
    if (tx.tables.cursors.get(extractCursor(family.name)) === undefined) tx.tables.cursors.move(extractCursor(family.name), { seq: 0, at_ms: 0 });
  });
  const owed = () => db.commit((tx) => (tx.tables.cursors.get(rebuildCursor(family.name))?.seq ?? 0) > 0 || tx.derived.next.any(family.name));
  for (let id = 1, more = true; ; id++) {
    const walking = owed();
    if (!walking && !more) break;
    const name = walking ? "walk" : "extract";
    const kind = (walking ? walkKind : extractKind) as unknown as Kind<unknown, Parameters<NonNullable<typeof extractKind.chunk>>[2], { statements?: number; more: boolean; slabs?: { slabs: number; records: number } }, { written?: number; deleted?: number }>;
    const job = watched === undefined
      ? { id, kind: name, key: family.name, lane: LANE.backfill, not_before_ms: 0, started_ms: 0 } as unknown as JobRow
      : commit((tx) => {
        tx.tables.jobs.enqueue({ kind: name, key: family.name, lane: LANE.backfill, not_before_ms: NOW, now_ms: NOW });
        return tx.tables.jobs.take(NOW, undefined, ["kind:render", "kind:plan", "kind:index"])!;
      });
    const begun = commit((tx) => kind.begin!(main, tx, job));
    if (begun === null) throw new Error(`the ${name} kind begins with nothing to do`);
    const running: Running<typeof begun.state> = { job, state: begun.state };
    if (watched !== undefined) watched.running = running;
    const steps = kind.helper(env, { job: job.id, kind: name, key: family.name, lane: job.lane, now_ms: 0, data: begun.data });
    const began = performance.now();
    const fetched = counter.fetched;
    const views = counter.views;
    counter.extracted.clear();
    counter.touchedCalls = [];
    let result: Parameters<typeof kind.done>[3] | undefined;
    for (;;) {
      const before = { ...counter };
      const at = performance.now();
      const next = await steps.next();
      const ms = performance.now() - at;
      if (next.done === true) {
        result = next.value;
        break;
      }
      const chunk = next.value;
      if (!("puts" in chunk)) {
        for (const slice of kind.chunk!(main, running, chunk)) commit((tx) => slice.work(tx));
        continue;
      }
      drained.commit_bytes = Math.max(drained.commit_bytes, chunk.puts.reduce((sum, row) => sum + JSON.stringify(row.content).length, 0));
      drained.chunks.push({
        statements: counter.statements - before.statements, touched_rows: counter.touched - before.touched, extract_rows: counter.extract - before.extract,
        extract_bytes: counter.bytes - before.bytes, units: chunk.puts.length + chunk.deletes.length, ms: Math.round(ms),
      });
      for (const slice of kind.chunk!(main, running, chunk)) commit((tx) => slice.work(tx));
    }
    if (running.stale === true) throw new Error(`the ${name} cursor was reset under the drain`);
    const walked = result!.slabs;
    if (walked !== undefined) {
      drained.walked = {
        slabs: (drained.walked?.slabs ?? 0) + walked.slabs, records: (drained.walked?.records ?? 0) + walked.records, views: (drained.walked?.views ?? 0) + counter.views - views,
      };
    }
    commit((tx) => {
      kind.done(main, tx, running, result!);
      if (watched === undefined) return;
      tx.tables.jobs.finish(job.id, NOW);
      const lane = Math.min(running.again?.lane ?? Infinity, running.due ?? Infinity);
      if (lane !== Infinity) tx.tables.jobs.enqueue({ kind: name, key: family.name, lane, not_before_ms: NOW, now_ms: NOW });
    });
    if (watched !== undefined) watched.running = undefined;
    drained.written += running.state.written ?? 0;
    drained.deleted += running.state.deleted ?? 0;
    const statements = result!.statements ?? 0;
    if ((begun.state as { stage?: string }).stage !== "emptying") more = result!.more;
    const extracts = [...counter.extracted.values()].reduce((sum, count) => sum + count, 0);
    if (statements > 0 || extracts > 0) {
      drained.runs.push({ statements, fetched: counter.fetched - fetched, extracts, units: counter.extracted.size, ms: Math.round(performance.now() - began) });
      drained.touched.push(counter.touchedCalls);
    }
    const lane = Math.min(running.again?.lane ?? Infinity, running.due ?? Infinity);
    afterRun?.({ statements, built: [...counter.extracted.keys()], more, lane: lane === Infinity ? null : lane });
  }
  drained.touched_bytes = counter.touchedBytes;
  drained.fixes = counter.fixes;
  drained.views = counter.views;
  const view = db.view();
  drained.units = [...view.extracts(plain.name)].length;
  view.close();
  return drained;
}

function land(db: HomeDb, source: string, stated_ms: number, rows: readonly ReaderOutput[], deliveries: { count: number }): void {
  const accept = () => [];
  db.commit((tx) => {
    if (tx.tables.sources.get(source) === undefined) tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector: "synthetic", added_ms: 0 });
    const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
    const guards = Object.fromEntries([...new Set(rows.map((row) => row.kind))].map((kind) => [kind, accept]));
    const landed = tx.records.land(run, { id: `${source}@${stated_ms}/${++deliveries.count}`, source, stated_ms }, rows, guards, { has: () => true });
    if (landed.refusals.length > 0) throw new Error(`refused: ${JSON.stringify(landed.refusals)}`);
    tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok" });
    tx.tables.sources.advance(source, stated_ms);
  });
}

export function summary(drained: Drained): JsonObject {
  const total = (key: keyof Chunk) => drained.chunks.reduce((sum, chunk) => sum + chunk[key], 0);
  const statements = total("statements");
  const max = (key: keyof Chunk) => Math.max(...drained.chunks.map((chunk) => chunk[key]));
  const runs = (key: "extracts" | "units") => drained.runs.reduce((sum, run) => sum + run[key], 0);
  return {
    chunks: drained.chunks.length, runs: drained.runs.length, statements, unit_extracts: runs("extracts"), units_extracted: runs("units"), written: drained.written, deleted: drained.deleted, units: drained.units,
    touched_rows_per_statement: Math.round((100 * total("touched_rows")) / statements) / 100,
    extract_rows_per_statement: Math.round((100 * total("extract_rows")) / statements) / 100,
    extract_bytes_per_statement: Math.round(total("extract_bytes") / statements),
    max_touched_rows_per_chunk: max("touched_rows"), max_extract_rows_per_chunk: max("extract_rows"),
    ms_per_chunk: Math.round(total("ms") / drained.chunks.length), max_ms_per_chunk: max("ms"),
    ms_per_50k_statements: Math.round((total("ms") * 50_000) / statements),
  };
}


const APPS = ["Editor", "Browser", "Terminal", "Mail", "Chat", "Notes"];

function bundleOf(app: string): string {
  return `com.example.${app.toLowerCase()}`;
}

function coastSitting(from: number, hours: number, random: () => number, treeLines = 12): { frames: ReaderOutput[]; sessions: ReaderOutput[]; ax: ReaderOutput[] } {
  const frames: ReaderOutput[] = [];
  const ax: ReaderOutput[] = [];
  const sessions: { key: string; app: string; frames: string[] }[] = [];
  let app = APPS[0]!;
  let page = 0;
  for (let t = from; t < from + hours * HOUR; t += 2 * S + Math.floor(random() * 3 * S)) {
    if (random() < 0.01) app = APPS[Math.floor(random() * APPS.length)]!;
    if (random() < 0.03) page++;
    const title = `${app} window ${page % 40}`;
    const lines = Array.from({ length: treeLines }, (_, line) => `${title}: synthetic line ${line} of page ${page} reads plain words here`);
    const key = String(t);
    if (sessions.at(-1)?.app !== app) sessions.push({ key, app, frames: [] });
    sessions.at(-1)!.frames.push(key);
    frames.push({
      kind: "frame", key, time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.frame", frame_id: t / 1000, timestamp_ms: t, width: 1440, height: 900, is_inactive: 0, image_path: `v/${t}`,
        foreground: lines.join(". "), background: "", title, capture_display: { id: 1 }, video: { hash: "f".repeat(64), index: 0 },
        session_start_frame_identity: sessions.at(-1)!.key, windows: [],
      },
    });
    ax.push({
      kind: "ax", key, time: { start_ms: t, precision: "ms" },
      content: {
        type: "screen.ax", frame_identity: key, root_hash: "a".repeat(64), timestamp_ms: t, application_name: app, bundle_id: bundleOf(app),
        process_identifier: 42, extraction_mode: "full", is_partial_tree: 0,
        tree: { hash: "a".repeat(64), node: { role: "AXWindow", title }, children: lines.map((line) => ({ hash: "b".repeat(64), node: { role: "AXStaticText", value: line }, children: [] })) },
      },
    });
  }
  return {
    frames, ax,
    sessions: sessions.map((each) => ({
      kind: "session", key: each.key,
      content: { type: "screen.session", start_frame_identity: each.key, application: { bundle_id: bundleOf(each.app), version: "1", display_name: each.app }, frames: each.frames },
    })),
  };
}

export function screenBacklog(db: HomeDb, sittings: number, hours: number, first = 0, treeLines = 12): { rows: number; restate(): number } {
  const random = seeded(7 + first);
  const all = Array.from({ length: sittings }, (_, index) => coastSitting(BASE + (first + index) * 24 * HOUR, hours, random, treeLines));
  const deliveries = { count: first * 3 };
  const stated = BASE + (first + sittings + 1) * 24 * HOUR;
  for (const kind of ["frames", "sessions", "ax"] as const) land(db, COAST, stated, all.flatMap((sitting) => sitting[kind]), deliveries);
  return {
    rows: all.reduce((sum, sitting) => sum + sitting.frames.length + sitting.sessions.length + sitting.ax.length, 0),
    restate() {
      const trees = all.flatMap((sitting) => sitting.ax).map((row) => ({ ...row, content: { ...row.content as JsonObject, process_identifier: 43 } }));
      land(db, COAST, stated + HOUR, trees, deliveries);
      return trees.length;
    },
  };
}

export function coastHeard(db: HomeDb, day: number): void {
  db.commit((tx) => tx.tables.sources.advance(COAST, BASE + day * 24 * HOUR));
}


function entry(domain: string, kind: string, sequence: number, at: number, payload: JsonObject): JsonObject {
  return {
    schema_version: 1, domain, kind, sequence, process_instance_id: PROCESS, payload,
    captured: { wall_rfc3339: new Date(at + 1_500).toISOString(), wall_unix_seconds: (at + 1_500) / 1_000, elapsed_seconds: sequence * 2.5 },
  };
}

const PLACES = [{ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0.0135 }, { latitude: 0.009, longitude: 0.0135 }];
const DAY: [number, number, number][] = [[7.5, 0, 0], [0.25, 0, 1], [2, 1, 1], [0.2, 1, 2], [1, 2, 2], [0.2, 2, 1], [5, 1, 1], [0.3, 1, 0], [7.55, 0, 0]];
export const SHORT_DAY: [number, number, number][] = [[0.4, 0, 0], [0.2, 0, 1], [0.4, 1, 1]];

function phoneDay(
  start: number, first: number, random: () => number, plan: readonly [number, number, number][] = DAY, places: readonly { latitude: number; longitude: number }[] = PLACES,
): { location: ReaderOutput[]; motion: ReaderOutput[] } {
  let sequence = first;
  const location: ReaderOutput[] = [];
  const motion: ReaderOutput[] = [];
  let t = start;
  for (const [hours, from, to] of plan) {
    const end = t + hours * HOUR;
    const moving = from !== to;
    let activity = "";
    for (let at = t; at < end; at += 2 * S + Math.floor(random() * 3 * S)) {
      const share = (at - t) / (end - t);
      const a = places[from]!;
      const b = places[to]!;
      const point = moving
        ? { latitude: a.latitude + (b.latitude - a.latitude) * share, longitude: a.longitude + (b.longitude - a.longitude) * share }
        : { latitude: a.latitude + (random() - 0.5) * 0.0002, longitude: a.longitude + (random() - 0.5) * 0.0002 };
      const fix = ++sequence;
      location.push({
        kind: "fix", key: `${INSTALL}:${fix}`, time: { start_ms: at + 1_500, precision: "ms" },
        content: { type: "location.fix", content: entry("location", "fix", fix, at, {
          location: { timestamp_rfc3339_utc: new Date(at).toISOString(), timestamp_unix_seconds: at / 1_000, latitude: point.latitude, longitude: point.longitude,
            horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed: moving ? (to === 2 || from === 2 ? 1.2 : 11) : 0, course: 90 },
          capture_context: { engine: "app_owned", authorization: "always" },
        }) },
      });
      for (let event = 0; event < 2; event++) {
        const own = ++sequence;
        location.push({
          kind: "recorder", key: `${INSTALL}:${own}`, time: { start_ms: at + 1_600 + event, precision: "ms" },
          content: { type: "location.recorder", content: entry("location", "recorder_event", own, at, { event: event === 0 ? "delivered" : "deferred_updates", count: 1 }) },
        });
      }
      const now = moving ? (to === 2 || from === 2 ? "walking" : "automotive") : random() < 0.05 ? "walking" : "stationary";
      if (now !== activity || random() < 0.4) {
        activity = now;
        const own = ++sequence;
        motion.push({
          kind: "motion", key: `${INSTALL}:${own}`, time: { start_ms: at + 1_500, precision: "ms" },
          content: { type: "motion.activity", content: entry("motion", "activity", own, at, {
            start_date_rfc3339: new Date(at).toISOString(), start_date_unix_seconds: at / 1_000, stationary: now === "stationary", walking: now === "walking",
            running: false, automotive: now === "automotive", cycling: false, unknown: false, confidence: "high", confidence_raw: 2, delivery: "live_update",
          }) },
        });
      }
    }
    t = end;
  }
  return { location, motion };
}

export function readFixes(view: OpenView, days: number): { fixes: number; ms: number } {
  const began = performance.now();
  let fixes = 0;
  for (const _ of view.records(LOCATION, "fix", { start_ms: BASE, end_ms: BASE + days * 24 * HOUR })) fixes++;
  return { fixes, ms: performance.now() - began };
}

export function physicalBacklog(db: HomeDb, days: number, moved = false, plan: readonly [number, number, number][] = DAY): number {
  const random = seeded(11);
  const placesOf = (day: number) => PLACES.map((place) => ({ latitude: place.latitude, longitude: place.longitude + (moved ? day * 0.01 : 0) }));
  return landPhone(db, Array.from({ length: days }, (_, index) => phoneDay(BASE + index * 24 * HOUR, index * 1_000_000, random, plan, placesOf(index))));
}


const TIMELINE = "google-timeline:person-a@example.com:export";
const CONTACTS = "apple-contacts:local:phone";
const ASK = `ask:local:${MACHINE}`;
export const STILL = "location:local:iphone-bb02";

export function historyBacklog(db: HomeDb, days: number): { visits: number; trips: number; cards: number; chats: number; messages: number; still: number } {
  const deliveries = { count: 0 };
  const iso = (ms: number) => new Date(ms).toISOString();
  const timeline: ReaderOutput[] = [];
  const cards: ReaderOutput[] = [];
  const ask: ReaderOutput[] = [];
  const still: ReaderOutput[] = [];
  for (let day = 0; day < days; day++) {
    const noon = BASE + day * 24 * HOUR + 3 * HOUR;
    const centre = `geo:${(10 + day * 0.01).toFixed(4)},${(20).toFixed(4)}`;
    timeline.push({ kind: "place-visit", key: `visit-${day}`, time: { start_ms: noon, end_ms: noon + 2 * HOUR, precision: "s" }, content: { type: "timeline.visit", content: {
      startTime: iso(noon), endTime: iso(noon + 2 * HOUR), visit: { hierarchyLevel: "0", topCandidate: { placeLocation: centre, placeID: `ChIJ-synthetic-${day}` } } } } });
    timeline.push({ kind: "trip", key: `trip-${day}`, time: { start_ms: noon - 30 * MIN, end_ms: noon, precision: "s" }, content: { type: "timeline.trip", content: {
      startTime: iso(noon - 30 * MIN), endTime: iso(noon), activity: { topCandidate: { type: "walking" }, distanceMeters: "900", start: "geo:10.0000,19.9900", end: centre } } } });
    cards.push({ kind: "contact", key: `card-${day}`, time: { start_ms: noon, precision: "s" },
      content: { card: `BEGIN:VCARD\r\nFN:Person ${day}\r\nTEL:+1555000${String(day).padStart(4, "0")}\r\nEND:VCARD\r\n` } });
    const chat = `chat-${String(day).padStart(4, "0")}`;
    ask.push({ kind: "chat", key: chat, time: { start_ms: noon + MIN, precision: "ms" }, content: { type: "ask.chat", title: `Synthetic question ${day}`, at_ms: noon + MIN } });
    for (const [n, role] of [[1, "user"], [2, "assistant"]] as const) {
      ask.push({ kind: "msg", key: `${chat}:${String(n).padStart(4, "0")}`, time: { start_ms: noon + n * 1_000, precision: "ms" },
        content: { type: "ask.msg", chat, n, at_ms: noon + n * 1_000, role, text: `Synthetic ${role} words ${day}` } });
    }
    for (let at = BASE + day * 24 * HOUR; at < BASE + (day + 1) * 24 * HOUR; at += 10 * MIN) {
      still.push({ kind: "fix", key: `${INSTALL}:still-${at}`, time: { start_ms: at, precision: "ms" }, content: { type: "location.fix", content: entry("location", "fix", at / MIN, at, {
        location: { timestamp_rfc3339_utc: iso(at), timestamp_unix_seconds: at / 1_000, latitude: 1, longitude: 1, horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed: 0, course: 90 },
        capture_context: { engine: "app_owned", authorization: "always" },
      }) } });
    }
  }
  const end = BASE + days * 24 * HOUR;
  land(db, TIMELINE, end, timeline, deliveries);
  land(db, CONTACTS, end, cards, deliveries);
  land(db, ASK, end, ask, deliveries);
  land(db, STILL, end, still, deliveries);
  return { visits: days, trips: days, cards: days, chats: days, messages: 2 * days, still: still.length };
}

export function strayFix(db: HomeDb, at: number): void {
  const { location } = phoneDay(at, 900_000_000 + Math.floor(at / 1_000), seeded(23), [[0.0001, 0, 0]]);
  land(db, LOCATION, at + MIN, location.slice(0, 1), { count: Math.floor(at / 1_000) });
}

export function driveBacklog(db: HomeDb, hours: number): number {
  const away = { latitude: 0, longitude: (hours * HOUR / S) * 25 / 111_320 };
  return landPhone(db, [phoneDay(BASE, 0, seeded(17), [[0.5, 0, 0], [hours, 0, 1], [0.5, 1, 1]], [PLACES[0]!, away])]);
}

function landPhone(db: HomeDb, all: readonly { location: ReaderOutput[]; motion: ReaderOutput[] }[]): number {
  const deliveries = { count: 0 };
  const windows = new Map<number, { location: ReaderOutput[]; motion: ReaderOutput[] }>();
  for (const day of all) {
    for (const kind of ["location", "motion"] as const) {
      for (const row of day[kind]) {
        const window = Math.ceil(row.time!.start_ms / (4 * HOUR)) * 4 * HOUR;
        if (!windows.has(window)) windows.set(window, { location: [], motion: [] });
        windows.get(window)![kind].push(row);
      }
    }
  }
  let rows = 0;
  for (const [window, bundle] of [...windows].sort(([left], [right]) => left - right)) {
    land(db, LOCATION, window + 5 * MIN, bundle.location, deliveries);
    land(db, MOTION, window + 5 * MIN, bundle.motion, deliveries);
    rows += bundle.location.length + bundle.motion.length;
  }
  return rows;
}



const GOOGLE = "google-photos:person-a@example.com:export";
const LIBRARY = `apple-photos:local:${PHONE}`;
const CAMERAS = [PHONE, "camera-bb02", "camera-cc03", "unknown"];

function hexOf(random: () => number): string {
  return Array.from({ length: 8 }, () => Math.floor(random() * 4_294_967_296).toString(16).padStart(8, "0")).join("");
}

export function photosBacklog(db: HomeDb, moments: number): { rows: number; photos: number; wanted: number } {
  const random = seeded(13);
  const google: ReaderOutput[] = [];
  const library: ReaderOutput[] = [];
  for (let moment = 0; moment < moments; moment++) {
    const from = BASE + moment * 24 * HOUR;
    for (const camera of CAMERAS) {
      for (let t = from + Math.floor(random() * 10 * S); t < from + 2 * MIN; t += S + Math.floor(random() * 2 * S)) {
        const alike = random() < 0.05 ? 6 : 1;
        for (let copy = 0; copy < alike; copy++) {
          const sha = hexOf(random);
          const hash = `sha256:${sha}`;
          google.push({
            kind: "img", key: sha, time: { start_ms: t, precision: "s" }, device: camera, blobs: [hash],
            content: {
              type: "photos.asset", title: `${sha.slice(0, 8)}.jpg`, photoTakenTime: { timestamp: String(Math.floor(t / 1000)) },
              blobs: [{ hash, bytes: 1_000, media_type: "image/jpeg", role: "original" }],
            },
          });
          if (camera !== PHONE) continue;
          const local = `SYNTH-${sha.slice(0, 8)}/L0/001`;
          library.push({
            kind: "img", key: `${local}:2026-08-03T09:00:00.000Z`, time: { start_ms: t, precision: "ms" }, device: PHONE, blobs: [hash],
            content: {
              type: "photos.apple.asset",
              content: {
                local_identifier: local, media_type: "image", modification_date: "2026-08-03T09:00:00.000Z", is_favorite: false,
                resources: [{ type: "photo", uti: "public.jpeg", blob: { hash, type: "image/jpeg", bytes: 1_000, role: "original" } }],
              },
            },
          });
        }
      }
    }
  }
  const order = google.map((row) => ({ row, at: random() })).sort((left, right) => left.at - right.at).map((each) => each.row);
  const deliveries = { count: 0 };
  const stated = BASE + (moments + 1) * 24 * HOUR;
  land(db, LIBRARY, stated, library, deliveries);
  land(db, GOOGLE, stated + HOUR, order, deliveries);
  return { rows: library.length + google.length, photos: google.length, wanted: library.length };
}
