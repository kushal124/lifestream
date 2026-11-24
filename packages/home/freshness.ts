import type Database from "better-sqlite3";
import { connectorName, roadsOf, type Connector, type Road } from "@lifestreamprotocol/connect";
import { civilDay, itemSpanOf, readTables, render, spansOf, wallClock, type DaySettings, type SourceRow, type Span } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { catalogOf, declaredOf, switchOf } from "./catalog.js";
import { nameKey } from "./devices.js";
import { readsSource } from "./sources-read.js";
import { keptKey, keptOf } from "./through.js";

export const FRESH_MS = 15 * 60_000;
const SPELLED_MOST = 8;
const HEARD_ROADS: ReadonlySet<Road> = new Set(["mac", "phone", "upload", "owner"]);

export interface SourceFresh {
  road: Road | null;
  heard_ms: number | null;
  synced_ms: number | null;
  item_ms: number | null;
  item_dated: boolean;
}

export interface Told {
  target: string;
  outcome: string;
  reason: string | null;
}

export function toldBy(connector: Pick<Connector, "acquirers" | "label">): (attempt: Told) => boolean {
  const acquirers = new Set(connector.acquirers ?? []);
  const labeler = connector.label?.labeler;
  return (attempt) => {
    const colon = attempt.target.indexOf(":");
    const [kind, rest] = [attempt.target.slice(0, colon), attempt.target.slice(colon + 1)];
    const own = kind === "label" ? rest === labeler : (kind === "fetch" || kind === "page") && acquirers.has(rest);
    return own && !(attempt.outcome === "wait" && attempt.reason === "door");
  };
}

export interface FreshRead {
  spans: ReadonlyMap<string, readonly Span[]>;
  attempts(source: string): readonly (Told & { contact_ms: number | null })[];
}

export function freshReadOf(db: Database.Database): FreshRead {
  const attempts = new Map<string, (Told & { contact_ms: number | null })[]>();
  for (const row of db.prepare("SELECT target, source, outcome, reason, contact_ms FROM attempts").all() as (Told & { source: string; contact_ms: number | null })[]) {
    attempts.set(row.source, [...attempts.get(row.source) ?? [], row]);
  }
  return { spans: spansOf(db), attempts: (source) => attempts.get(source) ?? [] };
}

export function freshnessOf(db: Database.Database, input: { connectors: readonly Connector[]; now_ms: number; read: FreshRead }): ReadonlyMap<string, SourceFresh> {
  const { connectors, now_ms, read: { spans, attempts } } = input;
  const catalog = catalogOf(connectors);
  const perSource = <T>(value: string): Map<string, T> => new Map((db.prepare(`SELECT s.id, (${value}) AS value FROM sources s`).all() as { id: string; value: T }[])
    .map((row) => [row.id, row.value]));
  const sealed = perSource<number | null>("SELECT sealed_ms FROM deliveries INDEXED BY deliveries_sealed WHERE source = s.id ORDER BY sealed_ms DESC LIMIT 1");
  const kept = perSource<string | null>(`SELECT value FROM meta WHERE key = '${keptKey("")}' || s.id`);
  const pastNewest = db.prepare(`SELECT h.start_ms, v.precision IS 'day' AS dated FROM heads h INDEXED BY heads_time JOIN versions v ON v.id = h.version
    WHERE h.source = ? AND h.kind = ? AND h.version <> 'gone' AND h.start_ms IS NOT NULL AND h.start_ms <= ? ORDER BY h.start_ms DESC LIMIT 1`);

  const heardOf = (source: string): number | null => {
    const heard = Math.max(sealed.get(source) ?? 0, keptOf({ get: () => kept.get(source) ?? undefined }, source).heard_ms ?? 0);
    return heard === 0 ? null : heard;
  };
  const itemOf = (source: string, counts: readonly string[] | null): { item_ms: number | null; item_dated: boolean } => {
    const counted = (spans.get(source) ?? []).filter((each) => counts === null || counts.includes(each.kind));
    const span = itemSpanOf(counted);
    if (span.newest_ms === null || span.newest_ms <= now_ms) return { item_ms: span.newest_ms, item_dated: span.newest_dated };
    let newest: { start_ms: number; dated: number } | undefined;
    for (const { kind } of counted) {
      const head = pastNewest.get(source, kind, now_ms) as { start_ms: number; dated: number } | undefined;
      if (head !== undefined && (newest === undefined || head.start_ms > newest.start_ms)) newest = head;
    }
    return { item_ms: newest?.start_ms ?? null, item_dated: newest?.dated === 1 };
  };

  const out = new Map<string, SourceFresh>();
  for (const row of db.prepare("SELECT id, connector, options FROM sources ORDER BY id").all() as { id: string; connector: string; options: string }[]) {
    const held = { id: row.id, connector: row.connector, options: JSON.parse(row.options) as SourceRow["options"] };
    const connector = catalog.of(held);
    const road = connector === undefined ? null : roadsOf(declaredOf(connector, held))[0] ?? null;
    const heard_ms = heardOf(row.id);
    const told = connector === undefined ? undefined : toldBy(connector);
    const synced_ms = road === null || HEARD_ROADS.has(road) || told === undefined ? heard_ms
      : attempts(row.id).filter(told).reduce<number | null>((best, each) => (each.contact_ms !== null && (best === null || each.contact_ms > best) ? each.contact_ms : best), null);
    out.set(row.id, { road, heard_ms, synced_ms, ...itemOf(row.id, connector?.counts ?? null) });
  }
  return out;
}

export interface FreshDevice {
  unit: string;
  name: string;
}

export interface FreshSource extends SourceFresh {
  id: string;
  product: string;
  name: string;
  device: FreshDevice | null;
  families: readonly string[];
}

export function freshSourcesOf(db: Database.Database, input: {
  connectors: readonly Connector[]; families: readonly Pick<Family, "name" | "inputs">[]; off: readonly string[]; now_ms: number;
}): FreshSource[] {
  const catalog = catalogOf(input.connectors);
  const off = switchOf(input.connectors, input.off);
  const fresh = freshnessOf(db, { ...input, read: freshReadOf(db) });
  const devices = new Map((db.prepare("SELECT unit, model, retired_ms FROM devices").all() as { unit: string; model: string; retired_ms: number | null }[]).map((row) => [row.unit, row]));
  const named = db.prepare("SELECT value FROM meta WHERE key = ?").pluck();
  const deviceOf = (row: SourceRow): FreshDevice | null => {
    const device = devices.get(row.copy);
    return device === undefined ? null : { unit: row.copy, name: (named.get(nameKey(row.copy)) as string | undefined) ?? device.model };
  };
  const where = (row: SourceRow): string => {
    const email = row.options.email, name = row.options.name;
    return typeof email === "string" ? email : typeof name === "string" ? name : row.account === "local" ? "" : row.account;
  };
  return readTables(db).sources.list().flatMap((row): FreshSource[] => {
    const connector = catalog.of(row);
    if (connector === undefined || connector.hidden === true || off.source(row) || (devices.get(row.copy)?.retired_ms ?? null) !== null) return [];
    const families = input.families.filter((family) => readsSource(family, row)).map((family) => family.name);
    if (families.length === 0) return [];
    const device = deviceOf(row);
    const place = device?.name ?? where(row);
    return [{ id: row.id, product: row.product, name: place === "" ? connectorName(connector) : `${connectorName(connector)}, ${place}`, device, families, ...fresh.get(row.id)! }];
  });
}

export type Freshened = Pick<FreshSource, "name" | "device" | "synced_ms" | "item_ms" | "item_dated">;

interface FreshEntry extends Pick<Freshened, "name" | "synced_ms" | "item_ms" | "item_dated"> {
  sources: number;
}

function entriesOf(sources: readonly Freshened[]): FreshEntry[] {
  const lone = (each: Freshened): FreshEntry => ({ name: each.name, sources: 1, synced_ms: each.synced_ms, item_ms: each.item_ms, item_dated: each.item_dated });
  const newest = <T>(all: readonly T[], at: (each: T) => number | null): T | undefined =>
    all.reduce<T | undefined>((best, each) => (at(each) !== null && (best === undefined || at(each)! > at(best)!) ? each : best), undefined);
  const byDevice = new Map<string, Freshened[]>();
  const entries: FreshEntry[] = [];
  for (const each of sources) {
    if (each.device === null) entries.push(lone(each));
    else byDevice.set(each.device.unit, [...byDevice.get(each.device.unit) ?? [], each]);
  }
  for (const held of byDevice.values()) {
    const synced_ms = newest(held, (each) => each.synced_ms)?.synced_ms ?? null;
    const lags = (each: Freshened) => synced_ms !== null && (each.synced_ms === null || synced_ms - each.synced_ms > FRESH_MS);
    const rest = held.filter((each) => !lags(each));
    entries.push(...held.filter(lags).map(lone));
    if (rest.length === 1) entries.push(lone(rest[0]!));
    else {
      const item = newest(rest, (each) => each.item_ms);
      entries.push({ name: rest[0]!.device!.name, sources: rest.length, synced_ms, item_ms: item?.item_ms ?? null, item_dated: item?.item_dated ?? false });
    }
  }
  return entries;
}

export function freshnessWords(sources: readonly Freshened[], input: { now_ms: number; clock: DaySettings }): string | undefined {
  if (sources.length === 0) return undefined;
  const { now_ms, clock } = input;
  const today = civilDay(now_ms, clock);
  const time = (ms: number): string => (civilDay(ms, clock) === today ? wallClock(ms, clock.zone) : render(ms, clock.zone, "minute"));
  const item = (each: FreshEntry): string => (each.item_ms === null ? "none" : each.item_dated ? render(each.item_ms, clock.zone, "day") : time(each.item_ms));
  const entries = entriesOf(sources);
  const fresh = entries.filter((each) => each.synced_ms !== null && now_ms - each.synced_ms <= FRESH_MS);
  const lagging = entries.filter((each) => !fresh.includes(each)).sort((left, right) => (left.synced_ms ?? -Infinity) - (right.synced_ms ?? -Infinity) || left.name.localeCompare(right.name));
  if (lagging.length === 0) return sources.length === 1 ? "The one source synced in the last 15 min." : `All ${sources.length} sources synced in the last 15 min.`;
  const counted = fresh.reduce((sum, each) => sum + each.sources, 0);
  const said = (each: FreshEntry): string => {
    const synced = each.synced_ms === null ? "never synced" : `last synced ${time(each.synced_ms)}`;
    const last = each.synced_ms === null && each.item_ms === null ? "" : `, last item ${item(each)}`;
    return `${each.name} (${each.sources === 1 ? "" : `${each.sources} sources, `}${synced}${last})`;
  };
  const rest = (more: readonly FreshEntry[]): string => {
    const newest = more.reduce<number | null>((best, each) => (each.synced_ms !== null && (best === null || each.synced_ms > best) ? each.synced_ms : best), null);
    const many = more.reduce((sum, each) => sum + each.sources, 0);
    return newest === null ? `and ${many} more never synced` : `and ${many} more not synced since ${time(newest)}`;
  };
  const lag = [...lagging.slice(0, SPELLED_MOST).map(said), ...lagging.length > SPELLED_MOST ? [rest(lagging.slice(SPELLED_MOST))] : []].join("; ");
  return [
    ...counted > 0 ? [`Synced in the last 15 min: ${counted} ${counted === 1 ? "source" : "sources"}.`] : [],
    `${counted > 0 ? "Not since" : "Not synced in the last 15 min"}: ${lag}.`,
  ].join(" ");
}
