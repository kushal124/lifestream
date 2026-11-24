import { civilDay, digest, sha256, type DaySettings } from "@lifestreamprotocol/core";
import { circlesOf, distanceMeters, newCircle, type HiddenSpot, type HomeAsk, type NamedCircle, type Point, type StayPoint, type Summary } from "@lifestreamprotocol/families";
import type { AnswerOf, Body, PageHandler, PlaceRow, SpotRow, When } from "./pages.js";
import type { PlaceCounted, PlaceEntry, PlacesJoin } from "./places.js";
import type { PreparedRead } from "./prepared.js";
import { notNow, refuse } from "./refusal.js";
import { amount, NB } from "./stream-words.js";

export interface PlacesReads {
  joined<T>(machine: string, now_ms: number, use: (joined: PlacesJoin, position: string) => T): T;
  kept<T>(machine: string, use: (file: PreparedRead) => T): T;
  day(): DaySettings;
}

type Places = AnswerOf<"places">;
type Place = AnswerOf<"place">;
type Edit = AnswerOf<"placeEdit">;
type Year = AnswerOf<"year">;
type Listed = ReturnType<PlacesJoin["list"]>;
type Listing = Listed["places"][number];
type Area = Listing["area"];
type Kept = {
  readonly key?: unknown; readonly latitude: number; readonly longitude: number; readonly days?: unknown; readonly stays?: unknown; readonly area?: unknown;
  readonly last_ms?: unknown; readonly photos?: unknown; readonly photos_count?: unknown; readonly home_ask?: HomeAsk | null;
};
type Visit = { readonly unit: string; readonly start_ms: number; readonly end_ms: number; readonly day: string; readonly focus: string; readonly people: readonly string[] };
type Photo = { readonly crop: string } | { readonly card: string };
type TripDays = { readonly first: string; readonly days: readonly { readonly day: string; readonly line: string }[] };

const REACH_M = 5_000;
const AROUND_M = 400;
const SPOT_M = 80;
const DEGREE_M = 111_320;
const PHOTOS_FIRST = 4;
const PREPARING_S = 2;
const ELSEWHERE = "Elsewhere";
const NOT_YET = "Not yet";
const UNREAD = "Stays not read yet";
const DAY: readonly [string, string] = ["day", "days"];
const STAY: readonly [string, string] = ["stay", "stays"];
const PHOTO: readonly [string, string] = ["photo", "photos"];
const NIGHT: readonly [string, string] = ["night", "nights"];

const compare = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const dayTag = (day: DaySettings): string => digest({ zone: day.zone, day_start_hour: day.day_start_hour });

export function placesPage(reads: PlacesReads): PageHandler<Places> {
  return {
    params: [],
    open: (ask, use) => reads.joined(ask.machine, ask.now_ms, (joined, position) => {
      const list = joined.list();
      const google = joined.table.google.map(({ id, name }) => [id, name]);
      return use({ position, inputs: [sha256(JSON.stringify(list)), sha256(JSON.stringify(google))], counting: listCounting(list), build: () => placesBody(list, joined) });
    }),
  };
}

function placesBody(list: Listed, joined: PlacesJoin): Body<Places> {
  const named = new Map(joined.table.google.map(({ id, name }) => [id, name]));
  const cities = new Map<string, Listing[]>();
  for (const place of list.places) {
    const key = place.area.city === null ? ELSEWHERE : place.area.city;
    cities.set(key, [...cities.get(key) ?? [], place]);
  }
  const grouped = [...cities].map(([title, held]) => ({ title, held: [...held].sort(newestFirst) }))
    .sort((left, right) => Number(left.title === ELSEWHERE) - Number(right.title === ELSEWHERE) || newestFirst(left.held[0]!, right.held[0]!));
  const rowOf = (place: Listing): PlaceRow => placeRow(place, list.day, place.ids.flatMap((each) => named.get(each) ?? []));
  const spots = (list.spots as readonly Kept[]).filter((spot): spot is Kept & { key: string } => typeof spot.key === "string");
  const here = list.here?.slug;
  return {
    here: typeof here === "string" ? here : null,
    frame: frameOf(grouped[0]?.held.flatMap(circlesOfListed) ?? spots.slice(0, 1).map((spot) => ({ latitude: spot.latitude, longitude: spot.longitude, radius_m: SPOT_M }))),
    cities: grouped.map(({ title, held }) => ({
      key: title === ELSEWHERE ? "elsewhere" : `city:${title}`, title, here: held.some((place) => place.slug === here), when: atOf(held[0]!.last_ms), since: sinceOfCity(held),
      point: { latitude: held.reduce((sum, place) => sum + place.latitude, 0) / held.length, longitude: held.reduce((sum, place) => sum + place.longitude, 0) / held.length },
      places: held.filter((place) => place.days !== 1).map(rowOf), once: held.filter((place) => place.days === 1).map(rowOf),
    })),
    to_name: spots.map(spotRow),
    hidden: list.hidden.map(hiddenRow),
  };
}

const atOf = (at_ms: number | null): When | null => (at_ms === null ? null : { kind: "at", at_ms });

function sinceOfCity(held: readonly Listing[]): When | null {
  const firsts = held.flatMap((place) => place.first_ms ?? []);
  return firsts.length === 0 ? null : { kind: "at", at_ms: Math.min(...firsts) };
}

function listCounting(list: Listed): boolean {
  return "counting" in list || [...list.places, ...list.hidden].some((entry) => "counting" in entry);
}

function newestFirst(left: Listing, right: Listing): number {
  if (left.last_ms !== right.last_ms) {
    if (left.last_ms === null) return 1;
    if (right.last_ms === null) return -1;
    return right.last_ms - left.last_ms;
  }
  return compare(left.name, right.name) || compare(left.slug, right.slug);
}

function circlesOfListed(place: Listing): { latitude: number; longitude: number; radius_m: number }[] {
  return [{ latitude: place.latitude, longitude: place.longitude, radius_m: place.radius_m }, ...place.also];
}

function frameOf(circles: readonly { latitude: number; longitude: number; radius_m: number }[]): Places["frame"] {
  if (circles.length === 0) return null;
  const sides = circles.map(({ latitude, longitude, radius_m }) => {
    const out = radius_m + AROUND_M;
    const north = out / DEGREE_M;
    const east = out / (DEGREE_M * Math.max(0.01, Math.cos((latitude * Math.PI) / 180)));
    return { north: latitude + north, south: latitude - north, east: longitude + east, west: longitude - east };
  });
  return {
    north: Math.max(...sides.map((side) => side.north)), south: Math.min(...sides.map((side) => side.south)),
    east: Math.max(...sides.map((side) => side.east)), west: Math.min(...sides.map((side) => side.west)),
  };
}

const areaWords = (area: Area | null | undefined): string[] => (area === null || area === undefined ? [] : [area.city, area.region, area.country].flatMap((each) => each ?? []));

function placeRow(place: Listing, day: string, otherNames: readonly string[]): PlaceRow {
  return {
    slug: place.slug,
    name: place.name,
    line: place.last_ms === null ? NOT_YET : null,
    when: atOf(place.last_ms),
    spent: place.today_hours > 0 ? { day, hours: place.today_hours } : null,
    find: [...new Set([place.name, ...otherNames, ...areaWords(place.area)])],
    latitude: place.latitude,
    longitude: place.longitude,
    radius_m: place.radius_m,
    also: place.also.map(({ latitude, longitude, radius_m }) => ({ latitude, longitude, radius_m })),
    hours: place.hours,
  };
}

function spotRow(spot: Kept & { key: string }): SpotRow {
  const days = typeof spot.days === "number" ? spot.days : 0;
  const stays = typeof spot.stays === "number" ? spot.stays : 0;
  const area = spot.area as Area | undefined;
  const photos = Array.isArray(spot.photos) ? (spot.photos as readonly { image: string }[]) : [];
  return {
    key: spot.key, latitude: spot.latitude, longitude: spot.longitude,
    line: `${amount(days, DAY)} · ${amount(stays, STAY)}`,
    find: [...new Set(areaWords(area))],
    when: atOf(typeof spot.last_ms === "number" ? spot.last_ms : null),
    photos: photos.map((photo) => `sha256:${photo.image}`),
    photos_total: typeof spot.photos_count === "number" ? spot.photos_count : photos.length,
    ask: homeAskOf(spot.home_ask),
    city: area?.city ?? area?.region ?? null,
  };
}

function distanceWords(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)}${NB}m` : `${(metres / 1000).toFixed(1)}${NB}km`;
}

function hiddenRow(row: HiddenSpot): Places["hidden"][number] {
  const words = [...(row.days > 0 ? [amount(row.days, DAY)] : []), ...(row.nearest === null ? [] : [`${distanceWords(row.nearest.distance_m)} from ${row.nearest.name}`])];
  return { key: row.key, latitude: row.latitude, longitude: row.longitude, hidden: { kind: "at", at_ms: row.hidden_ms }, line: words.length === 0 ? null : words.join(" · ") };
}

export function placePage(reads: PlacesReads): PageHandler<Place> {
  return {
    params: ["slug"],
    open: (ask, use) => reads.joined(ask.machine, ask.now_ms, (joined, position) => {
      const slug = ask.query.get("slug") ?? refuse(422, "BAD_PARAMETER", "slug names the place");
      const counted = joined.counted(slug) ?? refuse(404, "PLACE_UNKNOWN", `no place ${slug}`);
      const day = reads.day();
      const counting = counted.entry.counting === true || (counted.counts === null && !joined.paused);
      const clashes = clashesOf(slug, joined);
      return use({
        position,
        inputs: [sha256(JSON.stringify({ counted, counting, clashes })), dayTag(day)],
        counting,
        build: () => ({ ...placeBody(counted.entry, counted.counts, day), clashes }),
      });
    }),
  };
}

function clashesOf(slug: string, joined: PlacesJoin): Place["clashes"] {
  const place = joined.table.places.find((each) => each.slug === slug);
  return (place?.ids ?? []).flatMap((id) => {
    const names = joined.table.places.filter((other) => other.slug !== slug && other.ids.includes(id)).map((other) => other.name);
    return names.length === 0 ? [] : [{ id, names }];
  });
}

function placeBody(entry: PlaceEntry, counts: PlaceCounted["counts"], day: DaySettings): Omit<Body<Place>, "clashes"> {
  const visits = entry.visits as unknown as readonly Visit[];
  const people = entry.people as unknown as readonly { id: string; name: string; days: number; photo?: Photo }[];
  return {
    head: { name: entry.name, line: entry.area.city ?? entry.area.region ?? null, since: sinceOf(entry, visits, day) },
    here: entry.here,
    rhythm: entry.rhythm,
    stays: counts?.stays ?? 0,
    visits: {
      count: entry.visits_count,
      rows: visits.map((visit) => ({ key: `${visit.unit}@${visit.start_ms}-${visit.end_ms}`, unit: visit.unit, day: visit.day, start_ms: visit.start_ms, end_ms: visit.end_ms, focus: visit.focus, people: [...visit.people] })),
    },
    people: people.map((person) => ({
      id: person.id, name: person.name, photo: person.photo === undefined ? null : "crop" in person.photo ? person.photo.crop : person.photo.card,
      line: entry.days > 1 ? amount(person.days, DAY) : null,
    })),
    photos: {
      first: entry.photos.slice(0, PHOTOS_FIRST).map((photo) => `sha256:${photo.image}`),
      total: entry.photos_count,
      line: entry.photos_count === 0 ? null : amount(entry.photos_count, PHOTO),
    },
    part_of: entry.part_of,
    inside: entry.inside,
    ask_home: homeAskOf(counts?.home_ask),
  };
}

function homeAskOf(ask: HomeAsk | null | undefined): Place["ask_home"] {
  return ask === null || ask === undefined ? null : { line: `You've slept here ${amount(ask.nights, NIGHT)}`, since: { kind: "day", day: ask.since } };
}

function sinceOf(entry: PlaceEntry, visits: readonly Visit[], day: DaySettings): When | null {
  if (entry.first_ms === null || entry.rhythm?.includes("since ") === true) return null;
  if (entry.days === 1) return { kind: "day", day: visits[0]?.day ?? civilDay(entry.first_ms, day) };
  return { kind: "month", month: civilDay(entry.first_ms, day).slice(0, 7) };
}

export function placeEditPage(reads: PlacesReads): PageHandler<Edit> {
  return {
    params: ["slug", "spot"],
    open: (ask, use) => reads.joined(ask.machine, ask.now_ms, (joined, position) => {
      const asked = editAsked(ask.query);
      const edited = asked.slug !== undefined ? editedPlace(joined, asked.slug) : editedSpot(joined, asked.spot);
      const others = joined.table.places.filter((place) => place.slug !== edited.slug).flatMap((place) => circlesOf(place).map((circle) => ({ slug: place.slug, ...circle })))
        .filter((circle) => edited.own.some((own) => distanceMeters(own, circle) - circle.radius_m <= REACH_M));
      const kept = joined.points();
      const { latitude, longitude, radius_m } = edited.own[0]!;
      const fixed = { slug: edited.slug, circle: { latitude, longitude, radius_m }, others: [...edited.mine, ...others], held: edited.held };
      return use({
        position,
        inputs: [kept?.etag ?? "unread", sha256(JSON.stringify({ ...fixed, counting: edited.counting }))],
        counting: edited.counting,
        build: () => ({
          ...fixed,
          points: kept === null ? [] : near(kept.read(), edited.own),
          read: kept !== null,
          line: kept === null ? UNREAD : null,
        }),
      });
    }),
  };
}

function editAsked(query: URLSearchParams): { slug: string; spot?: undefined } | { slug?: undefined; spot: string } {
  const slug = query.get("slug"), spot = query.get("spot");
  if (slug !== null && spot !== null) refuse(422, "BAD_PARAMETER", "slug is not named with spot");
  if (slug !== null) return { slug };
  if (spot !== null) return { spot };
  return refuse(422, "BAD_PARAMETER", "slug names the place, or spot the spot to name");
}

interface Edited {
  readonly slug: string;
  readonly own: readonly NamedCircle[];
  readonly mine: readonly NamedCircle[];
  readonly held: number;
  readonly counting: boolean;
}

function editedPlace(joined: PlacesJoin, slug: string): Edited {
  const place = joined.table.places.find((each) => each.slug === slug) ?? refuse(404, "PLACE_UNKNOWN", `no place ${slug}`);
  const counted = joined.counted(slug)!;
  const own = circlesOf(place).map((circle) => ({ slug, latitude: circle.latitude, longitude: circle.longitude, radius_m: circle.radius_m }));
  return { slug, own, mine: own.slice(1), held: counted.counts?.held ?? 0, counting: counted.entry.counting === true || (counted.counts === null && !joined.paused) };
}

function editedSpot(joined: PlacesJoin, key: string): Edited {
  const list = joined.list();
  const spot = (list.spots as readonly Kept[]).find((each) => each.key === key) ?? refuse(404, "SPOT_UNKNOWN", `no spot ${key}: read the places page again`);
  const circle = newCircle(spot);
  return { slug: key, own: [{ slug: key, ...circle }], mine: [], held: 0, counting: "counting" in list };
}

function near(points: readonly StayPoint[], own: readonly Point[]): StayPoint[] {
  return points.filter((point) => own.some((circle) => Math.abs(point.latitude - circle.latitude) * DEGREE_M <= REACH_M + 1 && distanceMeters(point, circle) <= REACH_M));
}

export function yearPage(reads: PlacesReads): PageHandler<Year> {
  return {
    params: ["year"],
    open: (ask, use) => reads.kept(ask.machine, (file) => {
      const asked = ask.query.get("year") ?? refuse(422, "BAD_PARAMETER", "year names the year");
      if (!/^\d{4}$/u.test(asked)) refuse(422, "BAD_PARAMETER", "year is four digits");
      const years = (file.db.prepare("SELECT key FROM year ORDER BY key").pluck().all() as string[]);
      const etag = file.etag("year", asked) ?? (years.length === 0 ? notNow("busy", "Your places are being prepared.", PREPARING_S) : refuse(404, "YEAR_UNKNOWN", `no year ${asked}: the years are ${years[0]} to ${years.at(-1)}`));
      const tripsTag = file.etag("trips", asked) ?? notNow("busy", "Your places are being prepared.", PREPARING_S);
      return use({
        position: file.position,
        inputs: [etag, tripsTag, digest({ years })],
        counting: false,
        build: () => yearBody(Number(asked), years, file.value<{ summaries: Summary[] }>("year", asked)!.summaries[0]!,
          new Map(file.value<{ trips: TripDays[] }>("trips", asked)!.trips.map((trip) => [trip.first, trip.days]))),
      });
    }),
  };
}

function yearBody(year: number, years: readonly string[], summary: Summary, days: ReadonlyMap<string, TripDays["days"]>): Body<Year> {
  const base = summary.base?.city_id ?? null;
  const away = summary.cities.filter((city) => city.city_id !== base && city.nights > 0);
  const nights = away.reduce((sum, city) => sum + city.nights, 0);
  const countries = summary.countries.filter((country) => country.nights > 0).length;
  return {
    year,
    span: { first: Number(years[0]), last: Number(years.at(-1)) },
    trips: [...summary.trips].reverse().map((trip) => ({
      title: tripTitle(trip.cities), nights: amount(nightsOf(trip.first, trip.last), NIGHT), range: { first: trip.first, last: trip.last }, route: [...trip.cities], guessed: trip.guessed,
      days: [...days.get(trip.first) ?? []],
    })),
    figures: [
      { count: nights, words: nights === 1 ? "Night away" : "Nights away" },
      { count: countries, words: countries === 1 ? "Country" : "Countries" },
      { count: away.length, words: away.length === 1 ? "City" : "Cities" },
    ],
    cities: summary.cities.filter((city) => city.nights > 0 || (city.city_id !== undefined && city.city_id === base))
      .map((city) => ({ name: city.name, nights: city.nights, point: pointOf(city.city_id), country: city.country, base: city.city_id !== undefined && city.city_id === base })),
    base: summary.base === null ? null : { name: summary.base.city, nights: summary.base.nights },
  };
}

function nightsOf(first: string, last: string): number {
  return Math.round((Date.parse(last) - Date.parse(first)) / 86_400_000) + 1;
}

function tripTitle(cities: readonly string[]): string {
  const [first, second, ...rest] = cities;
  if (first === undefined) return "Somewhere not known";
  if (second === undefined) return first;
  return rest.length > 0 ? `${first}, ${second} and ${rest.length} more` : `${first} and ${second}`;
}

function pointOf(city: string | undefined): { latitude: number; longitude: number } | null {
  const found = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?) /u.exec(city ?? "");
  return found === null ? null : { latitude: Number(found[1]), longitude: Number(found[2]) };
}
