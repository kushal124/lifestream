import { addDays, civilDay, daysOf, dayBounds, instant, isObject, wallClock, type DaySettings, type Json, type SourceSelector, type View } from "@lifestreamprotocol/core";
import type { PlaceLabel } from "../family.js";

export interface Circle {
  latitude: number;
  longitude: number;
  radius_m: number;
}

export interface Place extends Circle {
  slug: string;
  name: string;
  also: Circle[];
  ids: string[];
  home?: boolean;
}

export interface GoogleName {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface PlaceTable {
  places: Place[];
  google: GoogleName[];
  hidden: Hidden[];
}

export interface Point {
  latitude: number;
  longitude: number;
}

export interface Where extends Point {
  id?: string;
}


export const EARTH_RADIUS_M = 6_371_008.8;
export const PLACE_REACH_M = 80;
const HOUR_MS = 3_600_000;

export function placeSources(home: string | null): { owner: SourceSelector; google: SourceSelector } {
  return { owner: { product: ["places"], copy: home === null ? [] : [home] }, google: { product: ["google-maps"], copy: ["lookup"] } };
}

export function placeTable(view: View, home: string | null): PlaceTable {
  const sources = placeSources(home);
  const ids = (selector: SourceSelector) => view.sources(selector).map((source) => source.id).sort(compare);
  const places: Place[] = [];
  const hidden: Hidden[] = [];
  for (const source of ids(sources.owner)) {
    for (const { head, version } of view.records(source, "place")) {
      const place = ownerPlace(head.key, version.content);
      if (place !== null) places.push(place);
    }
    for (const { head, version } of view.records(source, "hidden")) {
      const circle = hiddenCircle(version.content);
      if (circle !== null) hidden.push({ key: head.key, ...circle, hidden_ms: head.since_ms });
    }
  }
  const google = new Map<string, GoogleName>();
  for (const source of ids(sources.google)) {
    for (const { head, version } of view.records(source, "place")) {
      const name = googleName(head.key, version.content);
      if (name !== null && !google.has(name.id)) google.set(name.id, name);
    }
  }
  return {
    places: places.sort((left, right) => compare(left.slug, right.slug)), google: [...google.values()].sort((left, right) => compare(left.id, right.id)),
    hidden: hidden.sort((left, right) => compare(left.key, right.key)),
  };
}

export function placedById(where: Where, table: PlaceTable): PlaceLabel | null {
  if (where.id === undefined) return null;
  const carrying = table.places.filter((place) => place.ids.includes(where.id!)).sort((left, right) => compare(left.slug, right.slug))[0];
  if (carrying !== undefined) return label(carrying, carrying);
  const google = table.google.find((name) => name.id === where.id);
  return google === undefined ? null : { slug: google.id, name: google.name, latitude: google.latitude, longitude: google.longitude, radius_m: 0 };
}

export function placeOf(where: Where, table: PlaceTable): PlaceLabel | null {
  const byId = placedById(where, table);
  if (byId !== null) return byId;
  const best = winningCircle(where, table.places.flatMap((place) => circlesOf(place).map((circle) => ({ ...circle, slug: place.slug, place }))));
  return best === null ? null : label(best.place, best);
}

export interface NamedCircle extends Circle {
  slug: string;
}

export interface StayPoint extends Point {
  count: number;
}

export function winningCircle<C extends NamedCircle>(point: Point, circles: readonly C[]): C | null {
  let best: { circle: C; distance: number } | null = null;
  for (const circle of circles) {
    if (Math.abs(point.latitude - circle.latitude) * 110_000 > circle.radius_m) continue;
    const distance = distanceMeters(point, circle);
    if (distance > circle.radius_m) continue;
    if (best === null || circle.radius_m < best.circle.radius_m || (circle.radius_m === best.circle.radius_m &&
        (distance < best.distance || (distance === best.distance && circle.slug < best.circle.slug)))) best = { circle, distance };
  }
  return best === null ? null : best.circle;
}

export function takesIn(circle: NamedCircle, others: readonly NamedCircle[], points: readonly StayPoint[]): number {
  const circles = [circle, ...others];
  let taken = 0;
  for (const point of points) if (winningCircle(point, circles)?.slug === circle.slug) taken += point.count;
  return taken;
}

export function newCircle(spot: Point): Circle {
  return { latitude: spot.latitude, longitude: spot.longitude, radius_m: PLACE_REACH_M };
}

export function circlesOf(place: Place): Circle[] {
  return [{ latitude: place.latitude, longitude: place.longitude, radius_m: place.radius_m }, ...place.also];
}

export function distanceToPlace(point: Point, place: Place): number {
  return Math.min(...circlesOf(place).map((circle) => distanceMeters(point, circle)));
}

export function nearestPlace(point: Point, table: PlaceTable): { place: Place; distance_m: number } | null {
  let best: { place: Place; distance_m: number } | null = null;
  for (const place of table.places) {
    const distance_m = distanceToPlace(point, place);
    if (best === null || distance_m < best.distance_m || (distance_m === best.distance_m && place.slug < best.place.slug)) best = { place, distance_m };
  }
  return best;
}

export interface Stayed {
  start_ms: number;
  end_ms: number;
  centre: Where;
  by: string;
  closed?: true;
}

export interface Visits {
  stays: number;
  days: number;
  hours: number;
  longest_day_hours: number;
  first_ms: number | null;
  last_ms: number | null;
}

export interface Spot extends Visits {
  latitude: number;
  longitude: number;
  key: string;
  worth: boolean;
  ask_home: string | null;
  home_ask: HomeAsk | null;
}

export interface Hidden {
  key: string;
  latitude: number;
  longitude: number;
  radius_m: number;
  hidden_ms: number;
}

export interface HiddenSpot {
  key: string;
  latitude: number;
  longitude: number;
  hidden_ms: number;
  days: number;
  nearest: { slug: string; name: string; distance_m: number } | null;
}

export function hiddenAt(point: Point, hidden: readonly Hidden[]): Hidden | undefined {
  let best: { record: Hidden; distance: number } | undefined;
  for (const record of hidden) {
    const distance = distanceMeters(point, record);
    if (distance <= record.radius_m && (best === undefined || distance < best.distance)) best = { record, distance };
  }
  return best?.record;
}

export function spots(stays: readonly Stayed[], table: PlaceTable, day: DaySettings, options: { now_ms?: number } = {}): {
  places: Map<string, Visits>; spots: Spot[]; hidden: HiddenSpot[]; stays: Map<string, Stayed[]>;
} {
  const hidden = table.hidden;
  const hiddenStays = new Map<string, Stayed[]>(hidden.map((record) => [record.key, []]));
  const held = new Map<string, Stayed[]>(table.places.map((place) => [place.slug, []]));
  const groups: { latitude: number; longitude: number; weight: number; stays: Stayed[] }[] = [];
  for (const stay of [...stays].sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms)) {
    const named = placeOf(stay.centre, table);
    if (named !== null) {
      held.get(named.slug)?.push(stay);
      continue;
    }
    let nearest: { group: (typeof groups)[number]; distance: number } | null = null;
    for (const group of groups) {
      if (Math.abs(group.latitude - stay.centre.latitude) * 110_000 > PLACE_REACH_M) continue;
      const distance = distanceMeters(group, stay.centre);
      if (distance <= PLACE_REACH_M && (nearest === null || distance < nearest.distance)) nearest = { group, distance };
    }
    const weight = Math.max(stay.end_ms - stay.start_ms, 1);
    if (nearest === null) {
      groups.push({ latitude: stay.centre.latitude, longitude: stay.centre.longitude, weight, stays: [stay] });
      continue;
    }
    const group = nearest.group;
    group.latitude = (group.latitude * group.weight + stay.centre.latitude * weight) / (group.weight + weight);
    group.longitude = (group.longitude * group.weight + stay.centre.longitude * weight) / (group.weight + weight);
    group.weight += weight;
    group.stays.push(stay);
  }
  const grouped = new Map<string, Stayed[]>();
  const found = groups.flatMap((group): Spot[] => {
    const centre = { latitude: round(group.latitude, 6), longitude: round(group.longitude, 6) };
    const record = hiddenAt(centre, hidden);
    if (record !== undefined) {
      hiddenStays.get(record.key)!.push(...group.stays);
      return [];
    }
    const { visits, longest_ms } = visitsOf(group.stays, day);
    const home_ask = options.now_ms === undefined ? null : homeAsk({}, group.stays, options.now_ms, day);
    const key = `spot:${centre.latitude},${centre.longitude}`;
    grouped.set(key, group.stays);
    const worth = visits.days >= 3 || longest_ms >= HOUR_MS;
    return [{ ...centre, key, ...visits, worth, ask_home: homeAskWords(home_ask), home_ask }];
  });
  found.sort((left, right) => right.hours - left.hours || (left.first_ms ?? 0) - (right.first_ms ?? 0) || left.latitude - right.latitude || left.longitude - right.longitude);
  const kept = hiddenRows(table, (record) => visitsOf(hiddenStays.get(record.key)!, day).visits.days);
  return { places: new Map([...held].map(([slug, list]) => [slug, visitsOf(list, day).visits])), spots: found, hidden: kept, stays: grouped };
}

export function hiddenRows(table: PlaceTable, days: (record: Hidden) => number): HiddenSpot[] {
  return [...table.hidden].sort((left, right) => right.hidden_ms - left.hidden_ms || compare(left.key, right.key)).map((record) => {
    const near = nearestPlace(record, table);
    return {
      key: record.key, latitude: record.latitude, longitude: record.longitude, hidden_ms: record.hidden_ms, days: days(record),
      nearest: near === null ? null : { slug: near.place.slug, name: near.place.name, distance_m: Math.round(near.distance_m) },
    };
  });
}

const PHOTOS = "Photos";
const TIMES_SAID = 3;

export function seenWords(stays: readonly Stayed[], photos: number, settings: DaySettings): { witnessed: string; last: string | null } {
  const sorted = [...stays].sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms);
  const located = sorted.some((stay) => stay.by !== PHOTOS);
  const took = photos === 0 ? "photos" : photos === 1 ? "a photo" : `${photos.toLocaleString("en-US")} photos`;
  const also = located && photos > 0 ? ` You took ${took} here.` : "";
  const who = located ? "You were here" : `You took ${took} here`;
  const { days } = visitsOf(sorted, settings).visits;
  const [first, last] = edges(sorted, settings);
  if (days === 1) {
    const ends = Math.max(...sorted.map((stay) => stay.end_ms));
    const times = sorted.length > TIMES_SAID
      ? `between ${wallClock(sorted[0]!.start_ms, settings.zone)} and ${wallClock(ends, settings.zone)}`
      : sorted.map((stay) => clockWords(stay, settings)).join(" and ");
    return { witnessed: `${who} on ${dateWords(first)} ${times}.${also}`, last: null };
  }
  const when = first.slice(0, 7) === last.slice(0, 7) ? `in ${MONTHS[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`
    : first.slice(0, 4) === last.slice(0, 4) ? `in ${first.slice(0, 4)}` : `between ${first.slice(0, 4)} and ${last.slice(0, 4)}`;
  const latest = sorted.reduce((best, stay) => stay.end_ms > best.end_ms ? stay : best);
  return { witnessed: `${who} on ${days} days ${when}.${also}`,
    last: `Last time ${dateWords(civilDay(latest.start_ms, settings))} ${clockWords(latest, settings)}` };
}

function clockWords(stay: Stayed, settings: DaySettings): string {
  const from = wallClock(stay.start_ms, settings.zone);
  if (stay.end_ms <= stay.start_ms) return `at ${from}`;
  const day = civilDay(stay.end_ms - 1, settings);
  const to = wallClock(stay.end_ms, settings.zone);
  if (day !== civilDay(stay.start_ms, settings)) return `from ${from} to ${dateWords(day)} ${to}`;
  return to === from ? `at ${from}` : `from ${from} to ${to}`;
}

function edges(stays: readonly Stayed[], settings: DaySettings): [string, string] {
  const first = Math.min(...stays.map((stay) => stay.start_ms));
  const last = Math.max(...stays.map((stay) => stay.closed === true ? stay.end_ms : Math.max(stay.start_ms, stay.end_ms - 1)));
  return [civilDay(first, settings), civilDay(last, settings)];
}

function dateWords(day: string): string {
  const [year, month, date] = day.split("-");
  return `${WEEKDAYS[weekdayOf(day)]!.slice(0, 3)} ${Number(date)} ${MONTHS[Number(month) - 1]} ${year}`;
}

export const ASK_FRESH_DAYS = 7;
export const ASK_HALF_LIFE_DAYS = 45;
export const ASK_REGULAR_DAYS = 20;
const DAY_MS = 86_400_000;

export function askScore(spot: Visits, now_ms: number): number {
  const label = 1.5 * Math.log2(1 + spot.days) + 2 * Math.log2(1 + 2 * spot.longest_day_hours);
  const age = spot.last_ms === null ? Infinity : Math.max(0, Math.floor((now_ms - spot.last_ms) / DAY_MS));
  const remembered = 0.5 ** (Math.max(0, age - ASK_FRESH_DAYS) / ASK_HALF_LIFE_DAYS);
  const floor = 0.25 + 0.5 * Math.min(1, spot.days / ASK_REGULAR_DAYS);
  return label * Math.max(remembered, floor);
}

export function askOrder<T extends Spot>(found: readonly T[], now_ms: number): T[] {
  return found.filter((spot) => spot.worth)
    .map((spot) => ({ spot, score: askScore(spot, now_ms) }))
    .sort((left, right) => right.score - left.score || left.spot.latitude - right.spot.latitude || left.spot.longitude - right.spot.longitude)
    .map(({ spot }) => spot);
}

export interface Span {
  start_ms: number;
  end_ms: number;
}

const NIGHT_HOUR = 3;

export function nightAt(day: string, settings: DaySettings): number {
  const date = settings.day_start_hour > NIGHT_HOUR ? addDays(day, 1) : day;
  return instant(`${date}T0${NIGHT_HOUR}:00:00`, "local", { zone: settings.zone }).start_ms;
}

export function nightsIn(spans: readonly Span[], settings: DaySettings): string[] {
  const nights = new Set<string>();
  for (const span of spans) {
    if (span.end_ms <= span.start_ms) continue;
    for (let day = civilDay(span.start_ms, settings), last = civilDay(span.end_ms - 1, settings); day <= last; day = addDays(day, 1)) {
      const at = nightAt(day, settings);
      if (span.start_ms <= at && at < span.end_ms) nights.add(day);
    }
  }
  return [...nights].sort(compare);
}

export const ASK_HOME_NIGHTS = 3;
export const ASK_HOME_DAYS = 7;

export interface HomeAsk {
  nights: number;
  since: string;
}

export function homeAsk(place: Pick<Place, "home">, visits: readonly Span[], now_ms: number, settings: DaySettings): HomeAsk | null {
  if (place.home !== undefined) return null;
  const from = now_ms - ASK_HOME_DAYS * DAY_MS;
  const recent = visits.flatMap((visit) => {
    const span = { start_ms: Math.max(visit.start_ms, from), end_ms: Math.min(visit.end_ms, now_ms) };
    return span.end_ms > span.start_ms ? [span] : [];
  });
  const nights = nightsIn(recent, settings);
  return nights.length < ASK_HOME_NIGHTS ? null : { nights: nights.length, since: nights[0]! };
}

export function asksHome(place: Pick<Place, "home">, visits: readonly Span[], now_ms: number, settings: DaySettings): string | null {
  return homeAskWords(homeAsk(place, visits, now_ms, settings));
}

function homeAskWords(ask: HomeAsk | null): string | null {
  return ask === null ? null : `You've slept here ${ask.nights} nights, since ${WEEKDAYS[weekdayOf(ask.since)]}.`;
}

function holds(outer: Place, inner: Place): boolean {
  return outer.slug !== inner.slug && outer.radius_m > inner.radius_m && distanceMeters(outer, inner) + inner.radius_m <= outer.radius_m;
}

export function partOf(place: Place, table: PlaceTable): Place | null {
  return table.places.filter((outer) => holds(outer, place))
    .sort((left, right) => left.radius_m - right.radius_m || distanceMeters(left, place) - distanceMeters(right, place) || compare(left.slug, right.slug))[0] ?? null;
}

export function placesInside(place: Place, table: PlaceTable): Place[] {
  return table.places.filter((inner) => holds(place, inner)).sort((left, right) => compare(left.name, right.name) || compare(left.slug, right.slug));
}

const RHYTHM_DAYS = 4;
const RHYTHM_SPREAD_DAYS = 7;
const USUAL_SHARE = 0.25;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const WEEK = [1, 2, 3, 4, 5, 6, 0] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export function rhythm(visits: readonly Span[], nights: readonly string[], home: boolean | undefined, settings: DaySettings): string | null {
  if (home === true && nights.length > 0) return `Home · ${nights.length} night${nights.length === 1 ? "" : "s"} since ${nights[0]!.slice(0, 4)}`;
  const days = visits.map((visit) => civilDay(visit.start_ms, settings));
  const sorted = [...new Set(days)].sort(compare);
  if (sorted.length < RHYTHM_DAYS || addDays(sorted[0]!, RHYTHM_SPREAD_DAYS) >= sorted.at(-1)!) return null;
  const counts = new Map<number, number>();
  for (const day of sorted) counts.set(weekdayOf(day), (counts.get(weekdayOf(day)) ?? 0) + 1);
  const usual = WEEK.filter((weekday) => (counts.get(weekday) ?? 0) > sorted.length * USUAL_SHARE).map((weekday) => WEEKDAYS[weekday].slice(0, 3));
  const listed = usual.length < 2 ? usual.join("") : `${usual.slice(0, -1).join(", ")} and ${usual.at(-1)}`;
  const [year, month] = sorted[0]!.split("-");
  const since = `${sorted.length} days here since ${MONTHS[Number(month) - 1]} ${year}`;
  return listed === "" ? since : `${since} · usually ${listed}`;
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

export function distanceMeters(left: Point, right: Point): number {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const a = Math.sin(radians(right.latitude - left.latitude) / 2) ** 2 +
    Math.cos(radians(left.latitude)) * Math.cos(radians(right.latitude)) *
    Math.sin(radians(right.longitude - left.longitude) / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function ownerPlace(key: string, content: Json): Place | null {
  if (!isObject(content) || content.type !== "places.place") return null;
  const { name, radius_m, ids, home, also } = content;
  const point = pointOf(content.centre);
  if (typeof name !== "string" || name.length === 0 || point === null || typeof radius_m !== "number" || !(radius_m > 0)) return null;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return null;
  const circles = also === undefined ? [] : Array.isArray(also) ? also.map((circle) => {
    const centre = isObject(circle) ? pointOf(circle.centre) : null;
    return centre === null || !isObject(circle) || typeof circle.radius_m !== "number" || !(circle.radius_m > 0) ? null : { ...centre, radius_m: circle.radius_m };
  }) : [null];
  if (circles.includes(null)) return null;
  return { slug: key, name, ...point, radius_m, also: circles as Circle[], ids: [...(ids as string[])].sort(compare), ...(typeof home === "boolean" ? { home } : {}) };
}

function googleName(key: string, content: Json): GoogleName | null {
  if (!isObject(content) || content.type !== "google.place" || key !== `google:${String(content.id)}`) return null;
  const point = pointOf(content.centre);
  return typeof content.name !== "string" || content.name.length === 0 || point === null ? null : { id: key, name: content.name, ...point };
}

function hiddenCircle(content: Json): Omit<Hidden, "key" | "hidden_ms"> | null {
  const point = isObject(content) && content.type === "places.hidden" ? pointOf(content.centre) : null;
  return point === null || !isObject(content) || typeof content.radius_m !== "number" || !(content.radius_m > 0) ? null : { ...point, radius_m: content.radius_m };
}

function pointOf(centre: Json | undefined): Point | null {
  return isObject(centre) && typeof centre.latitude === "number" && typeof centre.longitude === "number" ? { latitude: centre.latitude, longitude: centre.longitude } : null;
}

function label(place: Place, circle: Circle): PlaceLabel {
  return { slug: place.slug, name: place.name, latitude: circle.latitude, longitude: circle.longitude, radius_m: circle.radius_m };
}

export function visitsOf(stays: readonly (Span & { closed?: true })[], day: DaySettings): { visits: Visits; longest_ms: number } {
  const union: { start_ms: number; end_ms: number }[] = [];
  for (const stay of [...stays].sort((left, right) => left.start_ms - right.start_ms)) {
    const last = union.at(-1);
    if (last !== undefined && stay.start_ms <= last.end_ms) last.end_ms = Math.max(last.end_ms, stay.end_ms);
    else union.push({ start_ms: stay.start_ms, end_ms: stay.end_ms });
  }
  const perDay = new Map<string, number>();
  let total = 0;
  for (const span of union) {
    total += span.end_ms - span.start_ms;
    for (const each of daysOf({ ...span, precision: "ms" }, day)) {
      const bounds = dayBounds(each, day);
      perDay.set(each, (perDay.get(each) ?? 0) + Math.max(0, Math.min(span.end_ms, bounds.end_ms) - Math.max(span.start_ms, bounds.start_ms)));
    }
  }
  for (const stay of stays) if (stay.closed === true) { const last = civilDay(stay.end_ms, day); perDay.set(last, perDay.get(last) ?? 0); }
  const longest_ms = Math.max(0, ...perDay.values());
  return {
    visits: {
      stays: stays.length, days: perDay.size, hours: round(total / HOUR_MS, 2), longest_day_hours: round(longest_ms / HOUR_MS, 2),
      first_ms: union[0]?.start_ms ?? null, last_ms: union.at(-1)?.end_ms ?? null,
    },
    longest_ms,
  };
}

function round(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
