import { readFileSync } from "node:fs";
import { EARTH_RADIUS_M, type Point } from "./places.js";

export interface Area {
  city: string | null;
  city_id: string | null;
  region: string | null;
  country: string | null;
  country_code: string | null;
}

export const GEOGRAPHY_VERSION = "3-7414146adf6d";
export const ZONES_VERSION = "3-1e63015796ca";

export type AreaLevel = "place" | "city" | "region" | "country";

const COAST_REACH_KM = 20;
const METRO = { population: 1_000_000, reach_km: 40 };
const CITY = { population: 100_000, reach_km: 25 };
const TOWN_REACH_KM = 30;
const ZONE_REACH_KM = 1_000;
const GONE = new Set(["PPLH", "PPLQ", "PPLW", "PPLCH"]);
const SECTIONS = new Set(["PPLX", "PPLL"]);
const SECTION_POPULATION = 1_000_000;

const NONE: Area = { city: null, city_id: null, region: null, country: null, country_code: null };
const RADIANS = Math.PI / 180;
const KM_PER_DEGREE = EARTH_RADIUS_M * RADIANS / 1000;

export function areaOf(point: Point): Area {
  const { latitude, longitude } = point;
  if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return { ...NONE };
  const world = loaded();
  const held = located(world, latitude, longitude);
  const country = held.country ?? islandOf(world, latitude, longitude);
  if (country === null) return { ...NONE };
  const region = held.region ?? nearest(country.regions, latitude, longitude);
  const city = cityOf(world, latitude, longitude, country, region);
  return { city: city?.name ?? null, city_id: city?.id ?? null, region: region?.name ?? null, country: country.name, country_code: country.code };
}

export function areaNames(point: Point, km: number): string[] {
  const area = areaOf(point);
  if (area.country === null) return [];
  const names = placesNear(loaded().named, point.latitude, point.longitude, km).map(({ place }) => place.name);
  return [...new Set([...names, ...(area.region === null ? [] : [area.region]), area.country])].sort();
}

export function zoneOf(point: Point, level: AreaLevel): string | null {
  const { latitude, longitude } = point;
  if (!(Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180)) return null;
  const world = loaded();
  const held = located(world, latitude, longitude);
  const country = held.country ?? islandOf(world, latitude, longitude);
  if (country === null) return null;
  const region = held.region ?? nearest(country.regions, latitude, longitude);
  if (level === "place" || level === "city") {
    const city = cityOf(world, latitude, longitude, country, region);
    if (city !== null) return city.zone;
  }
  if (level === "place") {
    const place = nearestPlace(world, latitude, longitude, country, region);
    if (place !== null) return place.zone;
  }
  if (level !== "country") {
    if (region !== null) {
      const zones = regionZones(world, region);
      if (zones.size === 1) return [...zones][0]!;
      if (zones.size > 1) return null;
    }
  }
  const zones = country.code === null ? undefined : world.zonesByCode.get(country.code);
  return zones !== undefined && zones.size === 1 ? [...zones][0]! : null;
}

function regionZones(world: World, region: Region): ReadonlySet<string> {
  let zones = world.regionZones.get(region);
  if (zones !== undefined) return zones;
  zones = new Set();
  for (const list of world.named.values()) {
    for (const place of list) {
      if (place.code !== region.country.code) continue;
      if ((place.region === undefined ? (place.region = located(world, place.latitude, place.longitude).region) : place.region) === region) zones.add(place.zone);
    }
  }
  world.regionZones.set(region, zones);
  return zones;
}


interface Part { rings: number[][]; west: number; south: number; east: number; north: number }
interface Shape { name: string; parts: Part[] }
interface Country extends Shape { code: string | null; regions: Region[] }
interface Region extends Shape { country: Country }
interface Place {
  id: string;
  name: string; latitude: number; longitude: number; population: number;
  code: string;
  zone: string;
  held?: Country | null;
  region?: Region | null;
  area?: { country: Country; region: Region | null };
}
interface World {
  countries: Country[]; regions: Region[]; byCode: Map<string, Country>; places: Map<number, Place[]>; named: Map<number, Place[]>;
  zonesByCode: Map<string, Set<string>>;
  regionZones: Map<Region, Set<string>>;
}

let world: World | undefined;
function loaded(): World {
  return world ??= load();
}

function load(): World {
  type Stored = { name: string; parts: number[][][] };
  const stored = JSON.parse(readFileSync(new URL("./geography/world.json", import.meta.url), "utf8")) as { countries: (Stored & { code: string | null; regions: Stored[] })[] };
  const shape = ({ name, parts }: Stored): Shape => ({ name, parts: parts.map(part) });
  const countries: Country[] = stored.countries.map((stored) => {
    const country: Country = { ...shape(stored), code: stored.code, regions: [] };
    country.regions = stored.regions.map((region) => ({ ...shape(region), country }));
    return country;
  });
  const byCode = new Map(countries.flatMap((country) => country.code === null ? [] : [[country.code, country] as const]));
  const places = new Map<number, Place[]>();
  const named = new Map<number, Place[]>();
  const add = (grid: Map<number, Place[]>, place: Place) => {
    const cell = cellOf(Math.floor(place.latitude), Math.floor(place.longitude));
    const list = grid.get(cell);
    if (list === undefined) grid.set(cell, [place]);
    else list.push(place);
  };
  const zones = readFileSync(new URL("./geography/zones.tsv", import.meta.url), "utf8").split("\n").filter((line) => line !== "")
    .flatMap((line) => {
      const [count, zone] = line.split("\t") as [string, string];
      return Array<string>(Number(count)).fill(zone);
    });
  const zonesByCode = new Map<string, Set<string>>();
  let row = -1;
  for (const line of readFileSync(new URL("./geography/cities.tsv", import.meta.url), "utf8").split("\n")) {
    if (line === "") continue;
    row++;
    const [name, lat, lon, people, feature, code] = line.split("\t") as [string, string, string, string, string, string];
    const population = Number(people);
    if (GONE.has(feature)) continue;
    const zone = zones[row]!;
    zonesByCode.set(code, (zonesByCode.get(code) ?? new Set()).add(zone));
    const place: Place = { id: `${lat},${lon} ${name}`, name, latitude: Number(lat), longitude: Number(lon), population, code, zone };
    add(named, place);
    if (!(SECTIONS.has(feature) && population < SECTION_POPULATION)) add(places, place);
  }
  if (zones.length !== row + 1) throw new Error(`geography: zones.tsv holds ${zones.length} rows, cities.tsv ${row + 1}`);
  return { countries, regions: countries.flatMap((country) => country.regions), byCode, places, named, zonesByCode, regionZones: new Map() };
}

function part(rings: number[][]): Part {
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  const outer = rings[0]!;
  for (let index = 0; index < outer.length; index += 2) {
    west = Math.min(west, outer[index]!);
    east = Math.max(east, outer[index]!);
    south = Math.min(south, outer[index + 1]!);
    north = Math.max(north, outer[index + 1]!);
  }
  return { rings, west, south, east, north };
}


function located(world: World, latitude: number, longitude: number): { country: Country | null; region: Region | null } {
  const region = containing(world.regions, latitude, longitude);
  return { region, country: region?.country ?? containing(world.countries, latitude, longitude) ?? nearest(world.countries, latitude, longitude) };
}

function containing<S extends Shape>(shapes: readonly S[], latitude: number, longitude: number): S | null {
  for (const shape of shapes) {
    for (const { rings, west, south, east, north } of shape.parts) {
      if (longitude < west || longitude > east || latitude < south || latitude > north) continue;
      if (within(rings, longitude, latitude)) return shape;
    }
  }
  return null;
}

function nearest<S extends Shape>(shapes: readonly S[], latitude: number, longitude: number): S | null {
  const reachLat = COAST_REACH_KM / KM_PER_DEGREE;
  const reachLon = longitudeDegrees(COAST_REACH_KM, latitude, reachLat);
  let found: S | null = null;
  let best = COAST_REACH_KM;
  for (const shape of shapes) {
    for (const { rings, west, south, east, north } of shape.parts) {
      if (latitude < south - reachLat || latitude > north + reachLat || longitudeGap(longitude, west, east) > reachLon) continue;
      for (const ring of rings) {
        const km = ringDistanceKm(ring, latitude, longitude);
        if (km < best || (km === best && found === null)) [best, found] = [km, shape];
      }
    }
  }
  return found;
}

function within(rings: number[][], x: number, y: number): boolean {
  if (!inside(rings[0]!, x, y)) return false;
  for (let hole = 1; hole < rings.length; hole++) if (inside(rings[hole]!, x, y)) return false;
  return true;
}

function inside(ring: number[], x: number, y: number): boolean {
  let odd = false;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const [xi, yi, xj, yj] = [ring[i]!, ring[i + 1]!, ring[j]!, ring[j + 1]!];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

function ringDistanceKm(ring: number[], latitude: number, longitude: number): number {
  const scale = Math.cos(latitude * RADIANS) * KM_PER_DEGREE;
  let best = Infinity;
  for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
    const [ax, ay] = [wrap(ring[j]! - longitude) * scale, (ring[j + 1]! - latitude) * KM_PER_DEGREE];
    const [bx, by] = [wrap(ring[i]! - longitude) * scale, (ring[i + 1]! - latitude) * KM_PER_DEGREE];
    const [dx, dy] = [bx - ax, by - ay];
    const length = dx * dx + dy * dy;
    const t = length === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

function regionIn(world: World, place: Place, country: Country): Region | null {
  if (place.area?.country === country) return place.area.region;
  const held = located(world, place.latitude, place.longitude).region;
  const region = held?.country === country ? held : nearest(country.regions, place.latitude, place.longitude);
  place.area = { country, region };
  return region;
}

function islandOf(world: World, latitude: number, longitude: number): Country | null {
  const closest = placesNear(world.places, latitude, longitude, TOWN_REACH_KM).sort(nearer)[0];
  return closest === undefined ? null : world.byCode.get(closest.place.code) ?? null;
}


interface Near { place: Place; km: number }

function cityOf(world: World, latitude: number, longitude: number, country: Country, region: Region | null): Place | null {
  const near = placesNear(world.places, latitude, longitude, METRO.reach_km).filter(({ place }) => heldBy(world, place, country, region));
  for (const { population, reach_km } of [METRO, CITY]) {
    const held = near.filter(({ place, km }) => place.population >= population && km <= reach_km);
    if (held.length > 0) return held.sort((left, right) => right.place.population - left.place.population || nearer(left, right))[0]!.place;
  }
  return near.filter(({ km }) => km <= TOWN_REACH_KM).sort(nearer)[0]?.place ?? null;
}

function heldBy(world: World, place: Place, country: Country, region: Region | null): boolean {
  return (place.code === country.code || (place.held === undefined ? (place.held = located(world, place.latitude, place.longitude).country) : place.held) === country)
    && (region === null || regionIn(world, place, country) === region);
}

function nearestPlace(world: World, latitude: number, longitude: number, country: Country, region: Region | null): Place | null {
  for (let km = 100; ; km = Math.min(km * 2, ZONE_REACH_KM)) {
    const found = placesNear(world.places, latitude, longitude, km).filter(({ place }) => heldBy(world, place, country, region)).sort(nearer)[0];
    if (found !== undefined) return found.place;
    if (km === ZONE_REACH_KM) return null;
  }
}

function nearer(left: Near, right: Near): number {
  return left.km - right.km || (left.place.name < right.place.name ? -1 : left.place.name > right.place.name ? 1 : 0);
}

function placesNear(grid: Map<number, Place[]>, latitude: number, longitude: number, km: number): Near[] {
  const near: Near[] = [];
  const [phi, cosPhi] = [latitude * RADIANS, Math.cos(latitude * RADIANS)];
  const reachLat = km / KM_PER_DEGREE;
  const reachLon = longitudeDegrees(km, latitude, reachLat);
  const first = Math.floor(longitude - reachLon);
  const columns = reachLon >= 180 ? 360 : Math.min(360, Math.floor(longitude + reachLon) - first + 1);
  for (let row = Math.max(-90, Math.floor(latitude - reachLat)); row <= Math.min(89, Math.floor(latitude + reachLat)); row++) {
    for (let column = first; column < first + columns; column++) {
      for (const place of grid.get(cellOf(row, column)) ?? []) {
        if (Math.abs(place.latitude - latitude) > reachLat) continue;
        const h = Math.sin((place.latitude * RADIANS - phi) / 2) ** 2 + cosPhi * Math.cos(place.latitude * RADIANS) * Math.sin((place.longitude - longitude) * RADIANS / 2) ** 2;
        const distance = 2 * EARTH_RADIUS_M / 1000 * Math.asin(Math.min(1, Math.sqrt(h)));
        if (distance <= km) near.push({ place, km: distance });
      }
    }
  }
  return near;
}

function cellOf(row: number, column: number): number {
  return (row + 90) * 360 + (((column + 180) % 360) + 360) % 360;
}


function longitudeDegrees(km: number, latitude: number, reachLat: number): number {
  const cos = Math.cos(Math.min(90, Math.abs(latitude) + reachLat) * RADIANS);
  return cos * KM_PER_DEGREE * 180 <= km ? 180 : Math.min(180, km / (KM_PER_DEGREE * cos));
}

function longitudeGap(longitude: number, west: number, east: number): number {
  if (longitude >= west && longitude <= east) return 0;
  return Math.min(Math.abs(wrap(west - longitude)), Math.abs(wrap(longitude - east)));
}

function wrap(degrees: number): number {
  return ((degrees + 540) % 360) - 180;
}
