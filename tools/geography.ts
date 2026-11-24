import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/families/shared/geography");

type Ring = [number, number][];
interface Feature { properties: Record<string, string | null>; geometry: { type: "Polygon"; coordinates: Ring[] } | { type: "MultiPolygon"; coordinates: Ring[][] } | null }

const folder = process.argv[2];
if (folder === undefined) {
  console.error("usage: npx tsx tools/geography.ts <folder holding admin0.json, admin1.json, countryInfo.txt, admin1CodesASCII.txt, cities15000.txt>");
  process.exit(2);
}
const features = (name: string): Feature[] => (JSON.parse(readFileSync(join(folder, name), "utf8")) as { features: Feature[] }).features;

function partsOf(feature: Feature): number[][][] {
  const geometry = feature.geometry;
  if (geometry === null) return [];
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  return polygons.map((rings) => rings.map((ring) => {
    const [first, last] = [ring[0]!, ring[ring.length - 1]!];
    const open = first[0] === last[0] && first[1] === last[1] ? ring.slice(0, -1) : ring;
    return open.flat();
  }));
}

const divisions = new Map<string, string>();
for (const line of readFileSync(join(folder, "admin1CodesASCII.txt"), "utf8").split("\n")) {
  const [key, name] = line.split("\t");
  if (key !== undefined && name !== undefined && name.trim() !== "") divisions.set(key, name.trim());
}

interface Place { latitude: number; longitude: number; code: string; division: string | undefined }
const rows = readFileSync(join(folder, "cities15000.txt"), "utf8").split("\n").filter((line) => line !== "").map((line) => line.split("\t"));
const cities = rows.map((fields) => [fields[1], fields[4], fields[5], fields[14] || "0", fields[7], fields[8]].join("\t"));
const tsv = `${cities.join("\n")}\n`;
const zoneRuns: [number, string][] = [];
for (const fields of rows) {
  const last = zoneRuns.at(-1);
  if (last !== undefined && last[1] === fields[17]) last[0]++;
  else zoneRuns.push([1, fields[17]!]);
}
const placesOf = new Map<string, Place[]>();
for (const fields of rows) {
  const place = { latitude: Number(fields[4]), longitude: Number(fields[5]), code: fields[8]!, division: divisions.get(`${fields[8]}.${fields[10]}`) };
  placesOf.set(place.code, [...(placesOf.get(place.code) ?? []), place]);
}

const englishName = new Map<string, string>();
for (const line of readFileSync(join(folder, "countryInfo.txt"), "utf8").split("\n")) {
  if (line.startsWith("#") || line.trim() === "") continue;
  const fields = line.split("\t");
  englishName.set(fields[0]!, fields[4]!.trim());
}

interface Country { name: string; code: string | null; parts: number[][][]; regions: { name: string; parts: number[][][] }[] }
const countries: Country[] = [];
const byCode = new Map<string, Country>();
const byA3 = new Map<string, Country>();
for (const feature of features("admin0.json")) {
  const { ADM0_A3: a3, ISO_A2_EH: iso, NAME_LONG: long } = feature.properties;
  const code = iso === null || iso === undefined || iso === "-99" ? null : iso;
  let country = code === null ? undefined : byCode.get(code);
  if (country === undefined) {
    country = { name: (code === null ? undefined : englishName.get(code)) ?? long!, code, parts: [], regions: [] };
    countries.push(country);
    if (code !== null) byCode.set(code, country);
  }
  country.parts.push(...partsOf(feature));
  byA3.set(a3!, country);
}
const NEAREST_KM = 50;
const named = { country: 0, any: 0, nearest: 0, own: 0 };
const everyPlace = [...placesOf.values()].flat();
for (const feature of features("admin1.json")) {
  const country = byA3.get(feature.properties.adm0_a3!);
  if (country === undefined) throw new Error(`admin-1 ${feature.properties.name} names no admin-0 unit ${feature.properties.adm0_a3}`);
  const parts = partsOf(feature);
  const own = country.code === null ? [] : placesOf.get(country.code) ?? [];
  const [how, name] = ([
    ["country", () => mostInside(parts, own)],
    ["any", () => mostInside(parts, everyPlace)],
    ["nearest", () => nearestDivision(parts, own)],
    ["own", () => feature.properties.name!],
  ] as const).map(([way, find]) => [way, find()] as const).find(([, found]) => found !== undefined)!;
  named[how]++;
  const region = country.regions.find((known) => known.name === name);
  if (region === undefined) country.regions.push({ name: name!, parts });
  else region.parts.push(...parts);
}
const placeCodes = new Set(cities.map((line) => line.slice(line.lastIndexOf("\t") + 1)));
for (const [code, name] of englishName) if (placeCodes.has(code) && !byCode.has(code)) countries.push({ name, code, parts: [], regions: [] });
const world = `${JSON.stringify({ countries })}\n`;

function mostInside(parts: number[][][], places: readonly Place[]): string | undefined {
  const votes = new Map<string, number>();
  const [west, south, east, north] = boxOf(parts);
  for (const place of places) {
    if (place.division === undefined || place.longitude < west || place.longitude > east || place.latitude < south || place.latitude > north) continue;
    if (!parts.some((rings) => holds(rings, place.longitude, place.latitude))) continue;
    votes.set(place.division, (votes.get(place.division) ?? 0) + 1);
  }
  return [...votes].sort(([left, many], [right, more]) => more - many || (left < right ? -1 : 1))[0]?.[0];
}

function nearestDivision(parts: number[][][], places: readonly Place[]): string | undefined {
  const kmPerDegree = 111.195;
  const [west, south, east, north] = boxOf(parts);
  let best = NEAREST_KM;
  let found: string | undefined;
  for (const place of places) {
    const cos = Math.cos(place.latitude * Math.PI / 180);
    const reach = NEAREST_KM / kmPerDegree;
    if (place.division === undefined || place.latitude < south - reach || place.latitude > north + reach) continue;
    if (place.longitude < west - reach / cos || place.longitude > east + reach / cos) continue;
    for (const rings of parts) {
      const ring = rings[0]!;
      for (let index = 0; index < ring.length; index += 2) {
        const km = Math.hypot((ring[index]! - place.longitude) * cos, ring[index + 1]! - place.latitude) * kmPerDegree;
        if (km < best) [best, found] = [km, place.division];
      }
    }
  }
  return found;
}

function boxOf(parts: number[][][]): [number, number, number, number] {
  const box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const rings of parts) {
    const ring = rings[0]!;
    for (let index = 0; index < ring.length; index += 2) {
      box[0] = Math.min(box[0], ring[index]!);
      box[1] = Math.min(box[1], ring[index + 1]!);
      box[2] = Math.max(box[2], ring[index]!);
      box[3] = Math.max(box[3], ring[index + 1]!);
    }
  }
  return box;
}

function holds(rings: number[][], x: number, y: number): boolean {
  const inside = (ring: number[]) => {
    let odd = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      if ((ring[i + 1]! > y) !== (ring[j + 1]! > y) && x < (ring[j]! - ring[i]!) * (y - ring[i + 1]!) / (ring[j + 1]! - ring[i + 1]!) + ring[i]!) odd = !odd;
    }
    return odd;
  };
  return inside(rings[0]!) && !rings.slice(1).some(inside);
}


writeFileSync(join(OUT, "world.json"), world);
writeFileSync(join(OUT, "cities.tsv"), tsv);
const zonesTsv = zoneRuns.map(([count, zone]) => `${count}\t${zone}`).join("\n") + "\n";
writeFileSync(join(OUT, "zones.tsv"), zonesTsv);
const digest = createHash("sha256").update(world).update(tsv).digest("hex").slice(0, 12);
console.log(`regions named by the country's places inside ${named.country}, by any places inside ${named.any}, by the nearest place ${named.nearest}; ${named.own} keep Natural Earth's name`);
console.log(`wrote ${countries.length} countries, ${countries.reduce((sum, country) => sum + country.regions.length, 0)} regions, ${cities.length} places to ${OUT}`);
console.log(`data digest ${digest}: GEOGRAPHY_VERSION ends with it`);
console.log(`zones digest ${createHash("sha256").update(zonesTsv).digest("hex").slice(0, 12)}: ZONES_VERSION ends with it`);
