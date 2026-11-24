import type Database from "better-sqlite3";
import { roadsOf, type Acquirer, type Connector, type Road } from "@lifestreamprotocol/connect";
import { diskSpace, heldOf, KEEP_BYTES, readTables, spansOf, UNDATED, type HomeFolder, type Months, type SourceRow, type Span } from "@lifestreamprotocol/core";
import { catalogOf, declaredOf, switchOf } from "./catalog.js";
import { skipKey } from "./connectors.js";
import { readPrincipals } from "./principals.js";
import type { Registry } from "./registry.js";
import { ALL, monthsBefore, startOf, type StartSettings } from "./start.js";
import type { Stated, Statement } from "./stated.js";
import { streamOf } from "./storage-read.js";
import { storeStateOf } from "./stores.js";
import { ownFiles, ownNow, readRest, STORED_REST } from "./stored.js";
import { keptKey, MONTHS_PREFIX, type Counted, type Kept } from "./through.js";

export const TEXT_BYTES = 3000;
export const OWN_TEXT_ITEMS = 200;
export const STOPS = [1, 3, 6, 12, 24, 60, 120] as const;

export interface CostView {
  sources: readonly Pick<SourceRow, "id" | "connector" | "options" | "account" | "copy">[];
  retired: ReadonlySet<string>;
  stored: ReadonlyMap<string, { text: number; files: number }>;
  spans: ReadonlyMap<string, readonly Span[]>;
  counted: ReadonlyMap<string, Counted>;
  started: ReadonlySet<string>;
  macs: readonly { unit: string; sources: readonly string[]; found_ms: number | null }[];
  stated: Readonly<Record<string, MacStated>>;
  own_bytes: number;
  disk: { free_bytes: number; keep_bytes: number };
}

export type MacStated = Pick<Statement, "found" | "grants" | "stores" | "sending" | "heard_ms">;

export type PriceSettings = StartSettings & { sources: { off: readonly string[] } };

export interface Stop {
  day: string | null;
  months: number | null;
  bytes: number;
  more: boolean;
  streams: Record<string, number>;
}

export interface StartCost {
  start: string | null;
  first: string | null;
  disk: { free_bytes: number; keep_bytes: number };
  held_bytes: number;
  settled: boolean;
  stops: Stop[];
}

interface Stream {
  id: string;
  held: number;
  text: number;
  items: Map<string, number> | null;
  own: { day: string | null } | null;
  copies: { key: string; months: Months }[];
}

export function costView(db: Database.Database, folder: HomeFolder, stated: Stated): CostView {
  const { root } = folder;
  const rows = db.prepare("SELECT source, sum(text) AS text, sum(files) AS files FROM stored_days GROUP BY source").all() as { source: string; text: number; files: number }[];
  const counted = db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?").all(MONTHS_PREFIX, `${MONTHS_PREFIX.slice(0, -1)};`) as { key: string; value: string }[];
  const kept = db.prepare("SELECT key, value FROM meta WHERE key >= ? AND key < ?").all(keptKey(""), `${keptKey("").slice(0, -1)};`) as { key: string; value: string }[];
  const rest = db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_REST) as string | undefined;
  const text = rows.reduce((sum, row) => sum + row.text, 0);
  const marked = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  return {
    sources: readTables(db).sources.list(),
    retired: new Set(db.prepare("SELECT unit FROM devices WHERE retired_ms IS NOT NULL").pluck().all() as string[]),
    stored: new Map(rows.map(({ source, text, files }) => [source, { text, files }])),
    spans: spansOf(db),
    counted: new Map(counted.map(({ key, value }) => [key.slice(MONTHS_PREFIX.length), JSON.parse(value) as Counted])),
    started: new Set(kept.filter(({ value }) => (JSON.parse(value) as Kept).left?.start_ms !== undefined).map(({ key }) => key.slice(keptKey("").length))),
    macs: readPrincipals(folder).principals.filter((pass) => pass.kind === "mac" && pass.revoked_at === null && pass.retired_at === undefined)
      .map(({ unit, sources }) => {
        const found = marked.get(skipKey(unit, "found")) as string | undefined;
        return { unit, sources, found_ms: found === undefined ? null : Number(found) };
      }),
    stated,
    own_bytes: ownNow(ownFiles(root), readRest(rest)?.bytes ?? 0, text),
    disk: { free_bytes: diskSpace(root).free_bytes, keep_bytes: KEEP_BYTES },
  };
}

type PriceRegistry = Pick<Registry, "connectors" | "acquirers">;

export function priceStops(view: CostView, settings: PriceSettings, registry: PriceRegistry, now_ms: number): StartCost {
  const today = utcDay(now_ms);
  const { streams, own, waiting, reading } = streamsOf(view, settings, registry, now_ms);
  const held = [...streams.values()].reduce((sum, stream) => sum + stream.held, own);
  const known = [...streams.values()].flatMap((stream) => (stream.items === null ? [] : [{ text: stream.text, items: itemsOf(stream.items) }]));
  const [text, items] = [known.reduce((sum, stream) => sum + stream.text, 0), known.reduce((sum, stream) => sum + stream.items, 0)];
  const home = text > 0 && items > 0 ? text / items : TEXT_BYTES;
  const priced = [...streams.values()].map((stream) => ({ stream, whole: wholeOf(stream, textOf(stream, home)) }));

  const first = firstOf(view);
  const start = settings.history.start === ALL ? null : settings.history.start > today ? today : settings.history.start;
  const said = start === null ? null : monthsBetween(start, today);
  const days = [...new Set([...STOPS.map((months) => monthsBefore(today, months)).filter((day) => monthsBetween(day, today) !== said), ...start === null ? [] : [start]])]
    .filter((day) => day === start || first === null || day.slice(0, 7) >= first)
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
  const stops = [...days, null].map((day): Stop => {
    const costs = priced.map(({ stream, whole }) => [stream.id, costOf(stream, whole, stream.own === null ? day : stream.own.day)] as const)
      .sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0));
    return {
      day, months: day === null ? null : monthsBetween(day, today), bytes: costs.reduce((sum, [, bytes]) => sum + bytes, own), more: waiting,
      streams: Object.fromEntries(costs),
    };
  });
  return { start, first, disk: view.disk, held_bytes: held, settled: !waiting && !reading, stops };
}

function streamsOf(view: CostView, settings: PriceSettings, { connectors, acquirers = [] }: PriceRegistry, now_ms: number): { streams: Map<string, Stream>; own: number; waiting: boolean; reading: boolean } {
  const catalog = catalogOf(connectors);
  const off = switchOf(connectors, settings.sources.off);
  const feeding = new Map(acquirers.map((acquirer) => [acquirer.source, acquirer]));
  const rows = new Map(view.sources.map((row) => [row.id, row]));
  const streams = new Map<string, Stream>();
  let own = view.own_bytes;
  const wired = new Set(view.sources.filter((row) => view.started.has(row.id) || view.counted.has(row.id)).map((row) => row.copy));
  let waiting = false;
  let reading = false;
  for (const id of new Set([...rows.keys(), ...view.stored.keys()])) {
    const row = rows.get(id);
    const connector = catalog.of(row ?? { id });
    const stored = view.stored.get(id) ?? { text: 0, files: 0 };
    const stream = streamOf(connector);
    if (stream === null || connector === undefined) {
      own += stored.text + stored.files;
      continue;
    }
    let into = streams.get(stream);
    if (into === undefined) {
      const start = startOf(settings, connector, now_ms);
      streams.set(stream, into = { id: stream, held: 0, text: 0, items: new Map(), own: start.own ? { day: start.day } : null, copies: [] });
    }
    into.held += stored.text + stored.files;
    into.text += stored.text;
    const items = heldOf((view.spans.get(id) ?? []).filter((span) => connector.counts === undefined || connector.counts.includes(span.kind)));
    const key = connector.mirror === true && row !== undefined ? row.account : id;
    if (items === null) into.items = null;
    else if (into.items !== null) into.items.set(key, Math.max(into.items.get(key) ?? 0, items));
    if (row === undefined || off.source(row) || view.retired.has(row.copy)) continue;
    const road = roadsOf(declaredOf(connector, row))[0];
    const heard = road === "mac" ? heardFrom(view, row.copy) : null;
    const expected = road === "mac" ? heard !== null && macCounts(connector, id, heard) : counts(connector, road, feeding.get(id), wired.has(row.copy));
    const counted = view.counted.get(id);
    if (counted !== undefined) {
      into.copies.push({ key, months: counted.months });
      if (expected && Object.values(counted.months).some(([, bytes]) => bytes === null)) reading = true;
    } else if (expected) waiting = true;
  }
  const unheard = view.macs.filter((mac) => heardFrom(view, mac.unit) === null && !view.retired.has(mac.unit) && !off.unit(mac.unit));
  if (unheard.some((mac) => mac.sources.some((id) => !off.source({ id }) && catalog.delivered("mac", id)?.backfill !== undefined))) waiting = true;
  return { streams, own, waiting, reading };
}

function heardFrom(view: CostView, unit: string): MacStated | null {
  const own = view.stated[unit];
  if (own === undefined || own.found === null) return null;
  const found_ms = view.macs.find((mac) => mac.unit === unit)?.found_ms ?? null;
  return found_ms !== null && own.heard_ms < found_ms ? null : own;
}

function macCounts(connector: Connector, source: string, own: MacStated): boolean {
  const mac = connector.mac;
  if (mac === undefined || connector.backfill === undefined || own.found?.includes(connector.id) !== true) return false;
  if (mac.store !== undefined && storeStateOf(own, connector.id) !== "allowed") return false;
  if (own.sending.sources?.[source] !== undefined) return false;
  return mac.grants.every((grant) => own.grants?.[grant] === "on" || own.grants?.[grant] === "limited");
}

function counts(connector: Connector, road: Road | undefined, acquirer: Acquirer | undefined, wired: boolean): boolean {
  if (road === "phone") return wired && connector.phone?.library === true;
  if (road === "poll") return acquirer?.months === true;
  return false;
}

function itemsOf(items: ReadonlyMap<string, number>): number {
  return [...items.values()].reduce((sum, each) => sum + each, 0);
}

function textOf(stream: Stream, home: number): number {
  const items = stream.items === null ? 0 : itemsOf(stream.items);
  return items < OWN_TEXT_ITEMS || stream.text === 0 ? home : stream.text / items;
}

function wholeOf(stream: Stream, text: number): Map<string, number> {
  const keys = new Map<string, Map<string, number>>();
  for (const copy of stream.copies) {
    const months = keys.get(copy.key) ?? new Map<string, number>();
    keys.set(copy.key, months);
    const mean = meanOf(copy.months);
    for (const [month, [items, bytes]] of Object.entries(copy.months)) {
      months.set(month, Math.max(months.get(month) ?? 0, items * text + (bytes ?? items * mean)));
    }
  }
  const whole = new Map<string, number>();
  for (const months of keys.values()) for (const [month, bytes] of months) whole.set(month, (whole.get(month) ?? 0) + bytes);
  return whole;
}

function meanOf(months: Months): number {
  let items = 0;
  let bytes = 0;
  for (const [count, size] of Object.values(months)) {
    if (size === null) continue;
    items += count;
    bytes += size;
  }
  return items === 0 ? 0 : bytes / items;
}

function costOf(stream: Stream, whole: ReadonlyMap<string, number>, day: string | null): number {
  if (stream.copies.length === 0) return stream.held;
  const month = day?.slice(0, 7);
  let sum = 0;
  for (const [each, bytes] of whole) {
    if (month === undefined || each === UNDATED || each > month) sum += bytes;
    else if (each === month) sum += bytes * shareOf(day!);
  }
  return Math.max(stream.held, Math.round(sum));
}

function firstOf(view: CostView): string | null {
  let first: string | null = null;
  const take = (month: string) => {
    if (first === null || month < first) first = month;
  };
  for (const { months } of view.counted.values()) for (const [month, [items]] of Object.entries(months)) if (month !== UNDATED && items > 0) take(month);
  for (const spans of view.spans.values()) for (const span of spans) if (span.oldest_ms !== null) take(utcDay(span.oldest_ms).slice(0, 7));
  return first;
}

function shareOf(day: string): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return (days - date + 1) / days;
}

function monthsBetween(day: string, today: string): number {
  const [y1, m1, d1] = day.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = today.split("-").map(Number) as [number, number, number];
  return Math.max(0, (y2 - y1) * 12 + (m2 - m1) - (d1 > d2 ? 1 : 0));
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
