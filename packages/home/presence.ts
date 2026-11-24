import { addDays, civilDay, dayBounds, instantIn, offsetMinutes, type DaySettings } from "@lifestreamprotocol/core";
import { placesBy, type DayArea, type ReadDay } from "@lifestreamprotocol/families";
import { plain, text, type Cell } from "./cell.js";
import { damaged, PLACES, PREPARED_STORE } from "./prepared.js";
import type { Attached, AttachedRead, RecordRead } from "./search-index.js";
import { placeFold, placeIn } from "./search-words.js";


export const PRESENCE_META = "presence";

const DAY_MS = 86_400_000;

export interface PresenceAreaRow {
  id: number;
  place: string | null;
  city: string | null;
  city_id: string | null;
  region: string | null;
  country: string;
  country_code: string | null;
  zone: string | null;
}

export interface PresenceTables {
  version: string;
  areas: PresenceAreaRow[];
  pieces: [start_ms: number, end_ms: number, known: number | null, guessed: number | null, zone: string | null, accounts: string[]][];
  placed: [day: string, area: number, guessed: boolean][];
}

export interface Presence {
  version: string;
  areas: readonly PresenceAreaRow[];
  pieces: PresenceTables["pieces"];
  placed: PresenceTables["placed"];
  area(id: number): PresenceAreaRow | undefined;
  pieceAt(ms: number): { known: number | null; guessed: number | null; zone: string | null } | undefined;
  placedOn(day: string): readonly { area: PresenceAreaRow; guessed: boolean }[];
  zoneAt(ms: number): string | null;
  dayAt(ms: number, settings: DaySettings): string;
  offsets(homeZone: string): readonly [number, number][];
  between(start_ms: number, end_ms: number): PresenceTables["pieces"];
}

export function presenceOver(tables: PresenceTables): Presence {
  const starts = tables.pieces.map((piece) => piece[0]);
  const pieceAt = (ms: number) => {
    let [low, high] = [0, starts.length];
    while (low < high) {
      const middle = (low + high) >> 1;
      if (starts[middle]! <= ms) low = middle + 1;
      else high = middle;
    }
    const piece = tables.pieces[low - 1];
    return piece !== undefined && ms < piece[1] ? { known: piece[2], guessed: piece[3], zone: piece[4] } : undefined;
  };
  const byId = new Map(tables.areas.map((area) => [area.id, area]));
  const placed = new Map<string, { area: PresenceAreaRow; guessed: boolean }[]>();
  for (const [day, id, guessed] of tables.placed) {
    const area = byId.get(id);
    if (area !== undefined) placed.set(day, [...placed.get(day) ?? [], { area, guessed }]);
  }
  const offsets = new Map<string, [number, number][]>();
  const zoneOf = (piece: { known: number | null; guessed: number | null; zone: string | null }): string | null =>
    piece.zone ?? (piece.known === null ? undefined : byId.get(piece.known)?.zone) ?? (piece.guessed === null ? undefined : byId.get(piece.guessed)?.zone) ?? null;
  const zoneAt = (ms: number): string | null => {
    const piece = pieceAt(ms);
    return piece === undefined ? null : zoneOf(piece);
  };
  return {
    version: tables.version, areas: tables.areas, pieces: tables.pieces, placed: tables.placed, pieceAt, zoneAt,
    dayAt: (ms, settings) => civilDay(ms, { zone: zoneAt(ms) ?? settings.zone, day_start_hour: settings.day_start_hour }),
    area: (id) => byId.get(id), placedOn: (day) => placed.get(day) ?? [],
    between(start_ms, end_ms) {
      let [low, high] = [0, starts.length];
      while (low < high) {
        const middle = (low + high) >> 1;
        if (starts[middle]! <= start_ms) low = middle + 1;
        else high = middle;
      }
      const out: PresenceTables["pieces"] = [];
      for (let at = Math.max(0, low - 1); at < tables.pieces.length && tables.pieces[at]![0] < end_ms; at++) if (tables.pieces[at]![1] > start_ms) out.push(tables.pieces[at]!);
      return out;
    },
    offsets(homeZone) {
      let found = offsets.get(homeZone);
      if (found === undefined) offsets.set(homeZone, found = offsetsOf(tables.pieces, zoneOf, homeZone));
      return found;
    },
  };
}

export interface PresenceSource {
  file: string;
  held(version: string, load: () => PresenceTables): Presence;
  damaged?(): void;
}

export function presenceAttached(source: PresenceSource | undefined): Record<string, Attached> {
  return source === undefined ? {} : { places: { kind: PREPARED_STORE, file: source.file } };
}

const PRESENCE_READ = new WeakMap<AttachedRead, Presence | null>();

export function presenceIn(read: RecordRead, source: PresenceSource | undefined): Presence | undefined {
  if (source === undefined) return undefined;
  const places = read.attached("places");
  if (places === undefined) return undefined;
  let found = PRESENCE_READ.get(places);
  if (found === undefined) {
    found = null;
    try {
      const version = places.meta(PRESENCE_META);
      if (places.meta("format") === PLACES.format && places.meta("position") !== undefined && version !== undefined) {
        found = source.held(version, () => ({
          version,
          areas: places.rows<PresenceAreaRow>("area", "id, place, city, city_id, region, country, country_code, zone", "id"),
          pieces: places.rows<[number, number, number | null, number | null, string | null, string]>("presence", "start_ms, end_ms, known, guessed, zone, accounts", "start_ms", true)
            .map(([start_ms, end_ms, known, guessed, zone, accounts]) => [start_ms, end_ms, known, guessed, zone, accounts === "" ? [] : accounts.split("\x1e")]),
          placed: places.rows<[string, number, number]>("placed", "day, area, guessed", "day, area", true).map(([day, area, guessed]) => [day, area, guessed === 1]),
        }));
      }
    } catch (error) {
      if (!damaged(error)) throw error;
      source.damaged?.();
    }
    PRESENCE_READ.set(places, found);
  }
  return found ?? undefined;
}


function zoneSpans(zone: string, start_ms: number, end_ms: number): [number, number][] {
  const out: [number, number][] = [[start_ms, offsetMinutes(start_ms, zone)]];
  const WEEK = 7 * 86_400_000;
  for (let at = start_ms; at < end_ms;) {
    const next = Math.min(at + WEEK, end_ms - 1);
    if (next <= at) break;
    const off = out.at(-1)![1];
    if (offsetMinutes(next, zone) !== off) {
      let [low, high] = [Math.floor(at / 1000), Math.ceil(next / 1000)];
      while (high - low > 1) {
        const middle = Math.floor((low + high) / 2);
        if (offsetMinutes(middle * 1000, zone) === off) low = middle;
        else high = middle;
      }
      out.push([high * 1000, offsetMinutes(high * 1000, zone)]);
      at = high * 1000;
      continue;
    }
    at = next + 1;
  }
  return out;
}

function offsetsOf(pieces: PresenceTables["pieces"], zoneOf: (piece: { known: number | null; guessed: number | null; zone: string | null }) => string | null, homeZone: string): [number, number][] {
  const out: [number, number][] = [];
  const home = (start_ms: number, end_ms: number) => {
    if (end_ms > start_ms) out.push(...zoneSpans(homeZone, start_ms, end_ms));
  };
  let at = 0;
  for (const [start_ms, end_ms, known, guessed, own] of pieces) {
    const zone = zoneOf({ known, guessed, zone: own });
    if (zone === null) continue;
    home(at, start_ms);
    out.push(...zoneSpans(zone, start_ms, end_ms));
    at = end_ms;
  }
  home(at, Math.max(at + 1, Date.now() + 2 * 365 * 86_400_000));
  return out;
}


export function placeDaysOf(presence: Presence, ids: readonly number[], fromDay: string, toDay: string, settings: DaySettings): { days: Map<string, { area: PresenceAreaRow; guessed: boolean }[]>; zones: string[] } {
  const days = new Map<string, Map<number, { area: PresenceAreaRow; guessed: boolean }>>();
  const zones = new Set<string>();
  if (ids.length === 0 || toDay < fromDay) return { days: new Map(), zones: [] };
  const wanted = new Set(ids);
  for (const [start_ms, end_ms, known, guessed] of presence.between(dayBounds(addDays(fromDay, -1), settings).start_ms, dayBounds(toDay, settings).end_ms + DAY_MS)) {
    for (const [id, onlyGuessed] of [[known, false], [guessed, true]] as const) {
      if (id === null || !wanted.has(id)) continue;
      const area = presence.area(id)!;
      const kept = presence.zoneAt(start_ms) ?? settings.zone;
      for (let day = presence.dayAt(start_ms, settings), last = presence.dayAt(end_ms - 1, settings); day <= last; day = addDays(day, 1)) {
        if (day < fromDay || day > toDay) continue;
        const held = days.get(day) ?? new Map();
        if (!onlyGuessed || !held.has(id)) held.set(id, { area, guessed: onlyGuessed });
        days.set(day, held);
        if (kept !== settings.zone) zones.add(kept);
      }
    }
  }
  return { days: new Map([...days].sort(([left], [right]) => left.localeCompare(right)).map(([day, held]) => [day, [...held.values()]])), zones: [...zones].sort() };
}

export function at(ms: number, dated: boolean | undefined, where: Presence | undefined, clock: Pick<DaySettings, "zone">): string | undefined {
  return dated === true ? undefined : instantIn(ms, where?.zoneAt(ms) ?? clock.zone);
}

export function dayOf(ms: number | null, dated: boolean | undefined, clock: DaySettings): string | undefined {
  if (ms === null) return undefined;
  return dated === true ? new Date(ms).toISOString().slice(0, 10) : civilDay(ms, clock);
}

export function wasAt(presence: Presence | undefined, thing: { start_ms: number; dated?: boolean | undefined; day: string | null }): { words?: string; owners: string[] } {
  const words = (area: PresenceAreaRow) => area.place ?? [area.city, area.region, area.country].filter((each) => each !== null).join(", ");
  if (presence === undefined) return { owners: [] };
  if (thing.dated === true) {
    const all = thing.day === null ? [] : presence.placedOn(thing.day);
    const areas = all.filter(({ area }) => !all.some(({ area: other }) => other !== area && within(other, area)));
    return {
      ...(areas.length === 0 ? {} : { words: areas.map(({ area, guessed }) => (guessed ? `${words(area)} (guessed)` : words(area))).join("; ") }),
      owners: areas.flatMap(({ area }) => (area.place === null ? [] : [area.place])),
    };
  }
  const piece = presence.pieceAt(thing.start_ms);
  const id = piece === undefined ? null : piece.known ?? piece.guessed;
  const area = id === null ? undefined : presence.area(id);
  if (area === undefined) return { owners: [] };
  return { words: piece!.known === null ? `${words(area)} (guessed)` : words(area), owners: area.place === null ? [] : [area.place] };
}

function within(inner: PresenceAreaRow, outer: PresenceAreaRow): boolean {
  const levels = ["place", "city_id", "region", "country"] as const;
  const stated = (area: typeof inner) => levels.filter((level) => area[level] !== null).length;
  return levels.every((level) => outer[level] === null || outer[level] === inner[level]) && stated(inner) > stated(outer);
}

export interface RunRow {
  from_day: string;
  to_day: string;
  days: number;
  guessed_days: number;
  cities: string[];
  country: string;
}

export function runsOver(presence: Presence, matchedDays: readonly string[], placeIn: readonly number[] | undefined, settings: DaySettings): RunRow[] {
  const held = [...new Set(matchedDays)].sort();
  if (held.length === 0) return [];
  const placed = new Map<string, { area: DayArea; guessed: boolean }[]>();
  const rows: (PresenceAreaRow & { day: string; guessed: boolean })[] = [];
  if (placeIn !== undefined) {
    for (const [day, areas] of placeDaysOf(presence, placeIn, held[0]!, held.at(-1)!, settings).days) rows.push(...areas.map(({ area, guessed }) => ({ ...area, day, guessed })));
  } else {
    for (let day = held[0]!; day <= held.at(-1)!; day = addDays(day, 1)) rows.push(...presence.placedOn(day).map(({ area, guessed }) => ({ ...area, day, guessed })));
  }
  for (const row of rows) {
    const area: DayArea = { city: row.city, city_id: row.city_id, region: row.region, country: placeIn === undefined ? "" : row.country, country_code: placeIn === undefined ? null : row.country_code, zone: row.zone };
    placed.set(row.day, [...placed.get(row.day) ?? [], { area, guessed: row.guessed }]);
  }
  const matched = new Set(held);
  const days: ReadDay[] = [];
  for (let day = held[0]!; day <= held.at(-1)!; day = addDays(day, 1)) {
    const areas = matched.has(day) ? placed.get(day) ?? [] : [];
    const none: DayArea = { city: null, city_id: null, region: null, country: "", country_code: null, zone: null };
    const known = areas.filter((each) => !each.guessed || placeIn === undefined).map((each) => each.area);
    const guessed = placeIn === undefined ? [] : areas.filter((each) => each.guessed).map((each) => each.area);
    days.push({ day, known: matched.has(day) && placeIn === undefined && known.length === 0 ? [none] : known, guessed, night: null, night_guess: null });
  }
  return placesBy(days, "country").flatMap((area) => area.runs.map((run) => ({
    from_day: run.from_day, to_day: run.to_day, days: run.days, guessed_days: run.guessed_days, cities: run.cities ?? [], country: area.place.country,
  }))).sort((left, right) => left.from_day.localeCompare(right.from_day) || left.country.localeCompare(right.country));
}


const COUNTRY_ALIASES: Readonly<Record<string, string>> = { uk: "GB", "great britain": "GB", us: "US", usa: "US", "united states of america": "US", uae: "AE" };

export interface PlaceTerm {
  text: string;
  fold: string;
  negated: boolean;
  said: Cell;
}

type PlaceLevel = "place" | "city" | "region" | "country";

export interface PlaceAt {
  level: PlaceLevel;
  key: string;
}

export interface PlaceValue {
  said: Cell;
  at: PlaceAt;
  ids: number[];
  whole: boolean;
  owner?: string;
}

function keyAt(area: PresenceAreaRow, level: PlaceLevel): string | null {
  return level === "place" ? (area.place === null ? null : `${area.place}\0${area.city_id}\0${area.country}`)
    : level === "city" ? (area.city_id === null ? null : `${area.city_id}\0${area.country}`)
      : level === "region" ? (area.region === null ? null : `${area.region}\0${area.country}`) : `${area.country_code}\0${area.country}`;
}

export function areasAt(areas: readonly PresenceAreaRow[], at: PlaceAt): number[] {
  return areas.filter((each) => keyAt(each, at.level) === at.key).map((each) => each.id);
}

export function placeTermsOf(written: string): PlaceTerm[] {
  return written.split(/\s+OR\s+/u).flatMap((part) => {
    const trimmed = part.trim();
    const negated = trimmed.startsWith("-") && trimmed.length > 1;
    const words = negated ? trimmed.slice(1).trim() : trimmed;
    const fold = placeFold(words);
    return fold === "" ? [] : [{ text: words, fold, negated, said: text(words) }];
  });
}


function wholeFirst<T extends { whole: boolean }>(values: readonly T[]): T[] {
  return values.some((value) => value.whole) ? values.filter((value) => value.whole) : [...values];
}

export function placeNamed(areas: readonly PresenceAreaRow[], term: Pick<PlaceTerm, "fold">): PlaceValue[] {
  const levels: PlaceLevel[] = ["place", "city", "region", "country"];
  const nameAt = (area: PresenceAreaRow, level: PlaceLevel): string => (level === "place" ? area.place : level === "city" ? area.city : level === "region" ? area.region : area.country)!;
  const code = COUNTRY_ALIASES[term.fold] ?? (/^[a-z]{2}$/u.test(term.fold) ? term.fold.toUpperCase() : null);
  const values = new Map<string, { level: PlaceLevel; area: PresenceAreaRow; whole: boolean }>();
  for (const area of areas) {
    for (const level of levels) {
      const key = keyAt(area, level);
      if (key === null || values.has(`${level}\0${key}`)) continue;
      const name = placeFold(nameAt(area, level));
      const whole = name === term.fold || (level === "country" && code !== null && area.country_code === code);
      if (whole || placeIn(name, term.fold)) values.set(`${level}\0${key}`, { level, area, whole });
    }
  }
  return [...values.values()].map(({ level, area, whole }) => {
    const at: PlaceAt = { level, key: keyAt(area, level)! };
    const said: Cell = level === "place" ? text(area.place!) : plain([level === "city" ? area.city : null, level !== "country" ? area.region : null, area.country].filter((each) => each !== null).join(", "));
    return { said, at, ids: areasAt(areas, at), whole, ...(level === "place" ? { owner: area.place! } : {}) };
  });
}


interface KeptPlaces {
  in?: PlaceAt[];
  out: PlaceAt[];
  took: { said: Cell; values: { said: Cell; at: PlaceAt }[] }[];
}

export function placesKept(areas: readonly PresenceAreaRow[], terms: readonly PlaceTerm[], stands?: (term: PlaceTerm, at: number, value: PlaceValue & { owner: string }) => boolean): KeptPlaces {
  const named = terms.flatMap((term, at) => wholeFirst(placeNamed(areas, term).filter((value) => value.owner === undefined || stands === undefined || stands(term, at, value as PlaceValue & { owner: string }))).map((value) => ({ term: at, ...value })));
  const of = (negated: boolean) => [...new Map(named.filter((value) => terms[value.term]!.negated === negated).map((value) => [`${value.at.level}\0${value.at.key}`, value.at])).values()];
  return {
    ...(terms.some((term) => !term.negated) ? { in: of(false) } : {}), out: of(true),
    took: terms.flatMap((term, index) => (term.negated ? [] : [{ said: term.said, values: named.filter((value) => value.term === index).map(({ said, at }) => ({ said, at })) }])),
  };
}

export function areasKept(areas: readonly PresenceAreaRow[], kept: Pick<KeptPlaces, "in" | "out">): { in?: number[]; out: number[] } {
  const bound = (at: readonly PlaceAt[]) => [...new Set(at.flatMap((each) => areasAt(areas, each)))];
  return { ...(kept.in === undefined ? {} : { in: bound(kept.in) }), out: bound(kept.out) };
}

export type TimeStretch = readonly [from_ms: number | null, to_ms: number | null];

export interface PlaceStretches {
  clock: TimeStretch[];
  date: TimeStretch[];
}

export function placeStretches(presence: Presence, areas: { readonly in?: readonly number[] | undefined; readonly out: readonly number[] }, settings: DaySettings): PlaceStretches {
  const wanted = areas.in === undefined ? undefined : new Set(areas.in);
  const left = new Set(areas.out);
  const among = (set: ReadonlySet<number>, ...ids: (number | null)[]) => ids.some((id) => id !== null && set.has(id));
  const kept = (...ids: (number | null)[]) => !among(left, ...ids) && (wanted === undefined || among(wanted, ...ids));
  const clock = new Stretches();
  if (wanted === undefined) clock.add(null, null);
  for (const [start_ms, end_ms, known, guessed] of presence.pieces) {
    if (wanted === undefined ? !kept(known, guessed) : kept(known, guessed)) clock.add(start_ms, end_ms);
  }
  const byDay = new Map<string, number[]>();
  for (const [day, area] of presence.placed) byDay.set(day, [...byDay.get(day) ?? [], area]);
  const date = new Stretches();
  if (wanted === undefined) date.add(null, null);
  for (const [day, ids] of byDay) {
    if (wanted === undefined ? !kept(...ids) : kept(...ids)) {
      const { start_ms, end_ms } = dayBounds(day, settings);
      date.add(start_ms, end_ms);
    }
  }
  return wanted === undefined ? { clock: clock.cut(), date: date.cut() } : { clock: clock.joined(), date: date.joined() };
}

class Stretches {
  readonly #all: [number | null, number | null][] = [];

  add(from: number | null, to: number | null): void {
    this.#all.push([from, to]);
  }

  joined(): TimeStretch[] {
    const out: [number | null, number | null][] = [];
    for (const [from, to] of this.#all) {
      const last = out.at(-1);
      if (last !== undefined && last[1] !== null && from !== null && from <= last[1]) last[1] = to === null ? null : Math.max(last[1], to);
      else out.push([from, to]);
    }
    return out;
  }

  cut(): TimeStretch[] {
    const out: TimeStretch[] = [];
    let at: number | null = null;
    for (const [from, to] of this.#all.slice(1)) {
      if (at === null || from! > at) out.push([at, from]);
      at = at === null ? to : Math.max(at, to!);
    }
    out.push([at, null]);
    return out;
  }
}
