import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { render } from "@lifestreamprotocol/core";
import { areaOf, GEOGRAPHY_VERSION, type Area, ZONES_VERSION, zoneOf } from "./geography.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "geography");
const ROOT = resolve(HERE, "../../..");

const POINTS = {
  "Copenhagen": [55.67594, 12.56553],
  "Abu Dhabi": [24.45118, 54.39696],
  "Colombo": [6.93548, 79.84868],
  "Durban": [-29.8579, 31.0292],
  "Halifax": [44.64269, -63.57688],
  "Acapulco": [16.84942, -99.90891],
  "Maceió": [-9.66583, -35.73528],
  "Key West": [24.55524, -81.78163],
  "Tarawa": [1.3278, 172.97696],
  "Lý Sơn": [15.37198, 109.11891],
  "Adamstown, Pitcairn": [-25.06597, -130.10147],
  "mid-Atlantic": [0, -30],
  "Indian Ocean": [-30, 80],
  "North Pacific": [10, -150],
  "Southern Ocean": [-60, -30],
  "Versailles": [48.80359, 2.13424],
  "Burbank": [34.18084, -118.30897],
  "Osasco": [-23.5325, -46.79167],
  "Ikeja": [6.60086, 3.35147],
  "Townsville": [-19.26639, 146.80569],
  "Reims": [49.26526, 4.02853],
  "Birdsville": [-25.8986, 139.3517],
  "Tonopah": [38.0672, -117.2301],
  "Hong Kong": [22.27832, 114.17469],
  "San Diego": [32.71571, -117.16472],
  "Windsor": [42.30008, -83.01654],
  "Malmö": [55.60587, 13.00073],
  "Camden, New Jersey": [39.92595, -75.11962],
  "Covington, Kentucky": [39.08367, -84.50855],
  "Council Bluffs, Iowa": [41.26194, -95.86083],
  "Gatineau, Quebec": [45.47723, -75.70164],
  "Philadelphia": [39.95238, -75.16362],
  "Cincinnati": [39.12711, -84.51439],
  "Ottawa": [45.41117, -75.69812],
  "Picayune, Mississippi": [30.52556, -89.67788],
  "Laredo, north side": [27.56, -99.47],
  "Midtown Manhattan": [40.754, -73.984],
  "lower Manhattan": [40.7075, -74.0113],
  "Hoboken, New Jersey": [40.74399, -74.03236],
  "Jersey City, New Jersey": [40.72816, -74.07764],
  "Vancouver, Washington": [45.63873, -122.66149],
  "East St. Louis, Illinois": [38.6245, -90.15094],
  "Saint-Denis, Réunion": [-20.88231, 55.4504],
  "Melilla": [35.29369, -2.93833],
  "Goma": [-1.67409, 29.22845],
  "centre of Lesotho": [-29.6, 28.25],
  "Bloemfontein": [-29.1211, 26.214],
  "Vatican City": [41.9029, 12.4534],
  "Harsūd (abandoned)": [22.09947, 76.73423],
  "Bāzār-e Yakāwlang (destroyed)": [34.73525, 66.97379],
  "New South Memphis (a section)": [35.08676, -90.05676],
  "North Pole": [90, 0],
  "South Pole": [-90, 0],
  "Taveuni, east of 180°": [-16.8, -179.99],
  "Taveuni, west of 180°": [-16.8, 179.99],
  "New York City": [40.71427, -74.00597],
  "Geneva": [46.20222, 6.14569],
  "El Paso": [31.75872, -106.48693],
  "Yerevan": [40.18111, 44.51361],
  "Addis Ababa": [9.02497, 38.74689],
  "Cairo": [30.0444, 31.2357],
  "Macau": [22.20056, 113.54611],
  "London": [51.50853, -0.12574],
  "Tokyo": [35.6895, 139.6917],
  "Paris": [48.8566, 2.3522],
  "São Paulo": [-23.5505, -46.6333],
  "Nairobi": [-1.2864, 36.8172],
  "Sydney": [-33.8688, 151.2093],
  "Mumbai": [19.076, 72.8777],
  "Mexico City": [19.4326, -99.1332],
  "Chicago": [41.8781, -87.6298],
  "Moscow": [55.7558, 37.6173],
  "Buenos Aires": [-34.6037, -58.3816],
} as const satisfies Record<string, readonly [number, number]>;
type Named = keyof typeof POINTS;

const NONE: Omit<Area, "city_id"> = { city: null, region: null, country: null, country_code: null };
const area = (city: string | null, region: string | null, country: string | null, country_code: string | null): Omit<Area, "city_id"> => ({ city, region, country, country_code });

const artifact: { points: Record<string, Area & { latitude: number; longitude: number }>; [key: string]: unknown } = { points: {} };
afterAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "families-geography-"));
  writeFileSync(join(dir, "geography.json"), `${JSON.stringify({ version: GEOGRAPHY_VERSION, ...artifact }, null, 2)}\n`);
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS === "1") console.log(`geography artifact kept: ${dir}`);
  else rmSync(dir, { recursive: true, force: true });
});

function at(name: Named): Omit<Area, "city_id"> {
  const [latitude, longitude] = POINTS[name];
  const found = areaOf({ latitude, longitude });
  artifact.points[name] = { latitude, longitude, ...found };
  const { city_id, ...named } = found;
  expect(city_id === null, name).toBe(found.city === null);
  return named;
}

function inFreshProcess(): Promise<{ areas: Record<string, Area>; reached: string[] }> {
  const child = `
    import dgram from "node:dgram"; import dns from "node:dns"; import http from "node:http";
    import https from "node:https"; import net from "node:net"; import tls from "node:tls";
    const reached = [];
    const refuse = (what) => function () { reached.push(what); throw new Error("network: " + what); };
    net.Socket.prototype.connect = refuse("net.Socket.connect");
    net.connect = net.createConnection = refuse("net.connect");
    tls.connect = refuse("tls.connect");
    http.request = http.get = refuse("http.request");
    https.request = https.get = refuse("https.request");
    dns.lookup = dns.resolve = refuse("dns.lookup");
    dns.promises.lookup = dns.promises.resolve = refuse("dns.promises.lookup");
    dgram.createSocket = refuse("dgram.createSocket");
    globalThis.fetch = refuse("fetch");
    const { areaOf } = await import(process.argv[1]);
    const points = JSON.parse(process.argv[2]);
    const areas = Object.fromEntries(Object.entries(points).map(([name, [latitude, longitude]]) => [name, areaOf({ latitude, longitude })]));
    process.stdout.write(JSON.stringify({ areas, reached }));
  `;
  return new Promise((done, fail) => {
    const process_ = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", child, pathToFileURL(join(HERE, "geography.ts")).href, JSON.stringify(POINTS)], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    onTestFinished(() => { if (process_.exitCode === null) process_.kill(); });
    let out = "";
    let err = "";
    process_.stdout.on("data", (chunk: Buffer) => { out += chunk.toString(); });
    process_.stderr.on("data", (chunk: Buffer) => { err += chunk.toString(); });
    process_.on("error", fail);
    process_.on("close", (code) => code === 0 ? done(JSON.parse(out) as { areas: Record<string, Area>; reached: string[] }) : fail(new Error(`the fresh process exited ${code}: ${err}`)));
  });
}

describe("geography", () => {
  it("a coastal city centre the simplified coast leaves outside every polygon still gets its country", () => {
    expect(at("Copenhagen")).toEqual(area("Copenhagen", "Capital Region", "Denmark", "DK"));
    expect(at("Abu Dhabi")).toEqual(area("Abu Dhabi", "Abu Dhabi", "United Arab Emirates", "AE"));
    expect(at("Colombo")).toEqual(area("Colombo", "Western Province", "Sri Lanka", "LK"));
    expect(at("Durban")).toEqual(area("Durban", "KwaZulu-Natal", "South Africa", "ZA"));
    expect(at("Halifax")).toEqual(area("Halifax", "Nova Scotia", "Canada", "CA"));
    expect(at("Acapulco")).toEqual(area("Acapulco de Juárez", "Guerrero", "Mexico", "MX"));
    expect(at("Maceió")).toEqual(area("Maceió", "Alagoas", "Brazil", "BR"));
  });

  it("an island the simplification dropped is told by its places", () => {
    expect(at("Lý Sơn")).toEqual(area("Lý Sơn", null, "Vietnam", "VN"));
    expect(at("Adamstown, Pitcairn")).toEqual(area("Adamstown", null, "Pitcairn", "PN"));
    expect(at("Key West")).toEqual(area("Key West", "Florida", "United States", "US"));
    expect(at("Tarawa")).toEqual(area("Tarawa", "Gilbert Islands", "Kiribati", "KI"));
  });

  it("a point at sea, far from land, has no area, so no two sea points share a country", () => {
    for (const sea of ["mid-Atlantic", "Indian Ocean", "North Pacific", "Southern Ocean"] as const) expect(at(sea)).toEqual(NONE);
  });

  it("a satellite town 15–20 km from a metro of a million is that metro", () => {
    expect(at("Versailles")).toMatchObject({ city: "Paris", country: "France" });
    expect(at("Burbank")).toMatchObject({ city: "Los Angeles", country: "United States" });
    expect(at("Osasco")).toMatchObject({ city: "São Paulo", country: "Brazil" });
    expect(at("Ikeja")).toMatchObject({ city: "Lagos", country: "Nigeria" });
  });

  it("a town of 200,000 far from any big city is its own city", () => {
    expect(at("Townsville")).toEqual(area("Townsville", "Queensland", "Australia", "AU"));
    expect(at("Reims")).toEqual(area("Reims", "Grand Est", "France", "FR"));
  });

  it("a point far from every place has no city, and keeps its region and country", () => {
    expect(at("Birdsville")).toEqual(area(null, "Queensland", "Australia", "AU"));
    expect(at("Tonopah")).toEqual(area(null, "Nevada", "United States", "US"));
  });

  it("a metro across a border never names a point", () => {
    expect(at("Hong Kong")).toMatchObject({ city: "Hong Kong", country: "Hong Kong", country_code: "HK" });
    expect(at("San Diego")).toMatchObject({ city: "San Diego", country_code: "US" });
    expect(at("Windsor")).toMatchObject({ city: "Windsor", country_code: "CA" });
    expect(at("Malmö")).toMatchObject({ city: "Malmö", country_code: "SE" });
  });

  it("a city across a region's border never names a point: its own region's city does, or none", () => {
    expect(at("Camden, New Jersey")).toEqual(area("Camden", "New Jersey", "United States", "US"));
    expect(at("Covington, Kentucky")).toEqual(area("Covington", "Kentucky", "United States", "US"));
    expect(at("Council Bluffs, Iowa")).toEqual(area("Council Bluffs", "Iowa", "United States", "US"));
    expect(at("Gatineau, Quebec")).toEqual(area("Gatineau", "Quebec", "Canada", "CA"));
    expect(at("Picayune, Mississippi")).toEqual(area(null, "Mississippi", "United States", "US"));
  });

  it("a point across a river that is a state's border is of its own state", () => {
    expect(at("Midtown Manhattan")).toEqual(area("New York City", "New York", "United States", "US"));
    expect(at("lower Manhattan")).toEqual(area("New York City", "New York", "United States", "US"));
    expect(at("Hoboken, New Jersey")).toEqual(area("Newark", "New Jersey", "United States", "US"));
    expect(at("Jersey City, New Jersey")).toEqual(area("Newark", "New Jersey", "United States", "US"));
    expect(at("Vancouver, Washington")).toEqual(area("Vancouver", "Washington", "United States", "US"));
    expect(at("East St. Louis, Illinois")).toEqual(area("St. Louis", "Illinois", "United States", "US"));
  });

  it("a point inside a city stays that city, a border city whose centre the polygons misplace too", () => {
    expect(at("Philadelphia")).toEqual(area("Philadelphia", "Pennsylvania", "United States", "US"));
    expect(at("Cincinnati")).toEqual(area("Cincinnati", "Ohio", "United States", "US"));
    expect(at("Ottawa")).toEqual(area("Ottawa", "Ontario", "Canada", "CA"));
    expect(at("Laredo, north side")).toEqual(area("Laredo", "Texas", "United States", "US"));
    const places = readFileSync(join(DATA, "cities.tsv"), "utf8").split("\n").filter((line) => line !== "")
      .map((line) => line.split("\t")).filter((fields) => Number(fields[3]) >= 100_000 && !["PPLX", "PPLL", "PPLH", "PPLQ", "PPLW", "PPLCH"].includes(fields[4]!))
      .map(([name, latitude, longitude]) => ({ name: name!, latitude: Number(latitude), longitude: Number(longitude) }));
    const cityless = places.filter((place) => areaOf(place).city === null).map((place) => place.name);
    expect(cityless).toEqual([]);
  });

  it("a place GeoNames files under its own code still names its city", () => {
    expect(at("Saint-Denis, Réunion")).toEqual(area("Saint-Denis", "Reunion", "France", "FR"));
  });

  it("where the two layers disagree the finer one decides, and the region is its country's", () => {
    expect(at("Melilla")).toEqual(area("Melilla", "Melilla", "Spain", "ES"));
    expect(at("Goma")).toEqual(area("Goma", "North Kivu", "Democratic Republic of the Congo", "CD"));
  });

  it("a country inside another is told as itself", () => {
    expect(at("centre of Lesotho")).toMatchObject({ country: "Lesotho", country_code: "LS" });
    expect(at("Bloemfontein")).toMatchObject({ city: "Bloemfontein", country: "South Africa", country_code: "ZA" });
    expect(at("Vatican City")).toMatchObject({ country: "Vatican", country_code: "VA" });
  });

  it("a place gone, or a small section of a city, names no point", () => {
    expect(at("Harsūd (abandoned)")).toMatchObject({ country: "India" });
    expect(at("Harsūd (abandoned)").city).not.toBe("Harsūd");
    expect(at("Bāzār-e Yakāwlang (destroyed)")).toEqual(area(null, "Bamyan", "Afghanistan", "AF"));
    expect(at("New South Memphis (a section)")).toEqual(area("Memphis", "Tennessee", "United States", "US"));
  });

  it("a pole, the antimeridian or a point that is no point gives an area or none, never an error", () => {
    expect(at("North Pole")).toEqual(NONE);
    expect(at("South Pole")).toEqual(area(null, "Antarctica", "Antarctica", "AQ"));
    expect(at("Taveuni, east of 180°")).toMatchObject({ country: "Fiji", country_code: "FJ" });
    expect(at("Taveuni, west of 180°")).toMatchObject({ country: "Fiji", country_code: "FJ" });
    for (const [latitude, longitude] of [[Number.NaN, 0], [0, Number.NaN], [91, 0], [-91, 0], [0, 181], [0, -181], [Number.POSITIVE_INFINITY, 0]]) {
      expect(areaOf({ latitude: latitude!, longitude: longitude! })).toEqual({ ...NONE, city_id: null });
    }
  });

  it("regions are GeoNames' first-level divisions, whatever level Natural Earth's admin-1 is", () => {
    expect(at("London")).toEqual(area("London", "England", "United Kingdom", "GB"));
  });

  it("city centres the simplification misplaces at coarser settings give what the bundled data gives", () => {
    expect(at("Geneva")).toEqual(area("Geneva", "Geneva", "Switzerland", "CH"));
    expect(at("Yerevan")).toEqual(area("Yerevan", "Yerevan", "Armenia", "AM"));
    expect(at("Addis Ababa")).toEqual(area("Addis Ababa", "Addis Ababa", "Ethiopia", "ET"));
    expect(at("Cairo")).toEqual(area("Cairo", "Cairo", "Egypt", "EG"));
    expect(at("New York City")).toEqual(area("New York City", "New York", "United States", "US"));
    expect(at("Macau")).toEqual(area("Macau", "Our Lady of Carmo", "Macao", "MO"));
    expect(at("El Paso")).toEqual(area("Ciudad Juárez", "Chihuahua", "Mexico", "MX"));
  });

  it("public city centres across continents give their city, region and country", () => {
    expect(at("Tokyo")).toEqual(area("Tokyo", "Tokyo", "Japan", "JP"));
    expect(at("Paris")).toEqual(area("Paris", "Île-de-France", "France", "FR"));
    expect(at("São Paulo")).toEqual(area("São Paulo", "São Paulo", "Brazil", "BR"));
    expect(at("Nairobi")).toEqual(area("Nairobi", "Nairobi County", "Kenya", "KE"));
    expect(at("Sydney")).toEqual(area("Sydney", "New South Wales", "Australia", "AU"));
    expect(at("Mumbai")).toEqual(area("Mumbai", "Maharashtra", "India", "IN"));
    expect(at("Mexico City")).toEqual(area("Mexico City", "Mexico City", "Mexico", "MX"));
    expect(at("Chicago")).toEqual(area("Chicago", "Illinois", "United States", "US"));
    expect(at("Moscow")).toEqual(area("Moscow", "Moscow", "Russia", "RU"));
    expect(at("Buenos Aires")).toEqual(area("Buenos Aires", "Buenos Aires F.D.", "Argentina", "AR"));
  });

  it("the same answers twice, in either order, and in a fresh process that opens no network", async () => {
    const names = Object.keys(POINTS) as Named[];
    const forward = Object.fromEntries(names.map((name) => [name, areaOf({ latitude: POINTS[name][0], longitude: POINTS[name][1] })]));
    const backward = Object.fromEntries([...names].reverse().map((name) => [name, areaOf({ latitude: POINTS[name][0], longitude: POINTS[name][1] })]));
    expect(backward).toEqual(forward);
    const fresh = await inFreshProcess();
    expect(fresh.reached).toEqual([]);
    expect(fresh.areas).toEqual(forward);
  });

  it("every place of 100,000 people has a country, nearly always GeoNames' own; 10,000 calls are timed", () => {
    const places = readFileSync(join(DATA, "cities.tsv"), "utf8").split("\n").filter((line) => line !== "")
      .map((line) => line.split("\t")).filter((fields) => Number(fields[3]) >= 100_000)
      .map(([name, latitude, longitude, , , code]) => ({ name: name!, latitude: Number(latitude), longitude: Number(longitude), code: code! }));
    const elsewhere: string[] = [];
    let without = 0;
    for (const place of places) {
      const found = areaOf(place);
      if (found.country === null) without++;
      else if (found.country_code !== place.code) elsewhere.push(`${place.name} (${place.code}): ${found.country} (${found.country_code ?? "no code"})`);
    }
    const start = performance.now();
    for (let call = 0; call < 10_000; call++) areaOf(places[call % places.length]!);
    artifact.ten_thousand_calls_ms = Math.round(performance.now() - start);
    artifact.places_of_100000 = { checked: places.length, without_country: without, in_another_country: elsewhere };
    expect(places.length).toBeGreaterThan(6_000);
    expect(without).toBe(0);
    expect(elsewhere.length).toBeLessThan(places.length / 100);
  });

  it("two cities of one name are two cities", () => {
    const [oregon, maine, downtown] = [{ latitude: 45.5152, longitude: -122.6784 }, { latitude: 43.6591, longitude: -70.2568 }, { latitude: 45.52, longitude: -122.68 }].map(areaOf);
    expect([oregon!.city, maine!.city]).toEqual(["Portland", "Portland"]);
    expect(oregon!.city_id).not.toBe(maine!.city_id);
    expect(downtown!.city_id).toBe(oregon!.city_id);
    artifact.portlands = [oregon, maine];
  });

  it("the bundled data stays within its bound: 8.5 MB, the 20% outlines and the places", () => {
    const bytes = ["world.json", "cities.tsv", "zones.tsv"].reduce((sum, file) => sum + statSync(join(DATA, file)).size, 0);
    artifact.bundled_bytes = bytes;
    expect(bytes).toBeLessThan(8_500_000);
  });

  it("the version names the bundled data", () => {
    const digest = createHash("sha256").update(readFileSync(join(DATA, "world.json"))).update(readFileSync(join(DATA, "cities.tsv"))).digest("hex").slice(0, 12);
    expect(GEOGRAPHY_VERSION.endsWith(`-${digest}`)).toBe(true);
    const zones = createHash("sha256").update(readFileSync(join(DATA, "zones.tsv"))).digest("hex").slice(0, 12);
    expect(ZONES_VERSION.endsWith(`-${zones}`)).toBe(true);
  });

  it("a city's zone is its own; a region or country gives one only when all its places keep it; else none", () => {
    const zone = (name: keyof typeof POINTS, level: Parameters<typeof zoneOf>[1]) => zoneOf({ latitude: POINTS[name][0], longitude: POINTS[name][1] }, level);
    const at = (latitude: number, longitude: number, level: Parameters<typeof zoneOf>[1]) => zoneOf({ latitude, longitude }, level);
    expect([at(40.7, -74, "place"), at(37.77, -122.42, "city"), at(-31.95, 115.86, "city"), zone("Colombo", "place")])
      .toEqual(["America/New_York", "America/Los_Angeles", "Australia/Perth", "Asia/Colombo"]);
    expect([at(32.53, -117.03, "city"), at(32.71, -117.16, "city")]).toEqual(["America/Tijuana", "America/Los_Angeles"]);
    expect([zone("Colombo", "country"), at(15.5, 73.83, "country"), at(48.86, 2.35, "country")]).toEqual(["Asia/Colombo", "Asia/Kolkata", "Europe/Paris"]);
    expect([at(40.7, -74, "country"), at(-31.95, 115.86, "country")]).toEqual([null, null]);
    expect([at(37.77, -122.42, "region"), at(-31.95, 115.86, "region")]).toEqual(["America/Los_Angeles", "Australia/Perth"]);
    expect(at(0, -30, "country")).toBeNull();
  });

  it("a zone is applied at the instant: a clock change moves the local time across it", () => {
    const zone = zoneOf({ latitude: 40.7, longitude: -74 }, "city")!;
    expect([render(Date.parse("2026-11-01T05:30Z"), zone, "minute"), render(Date.parse("2026-11-01T06:30Z"), zone, "minute")])
      .toEqual(["2026-11-01 01:30", "2026-11-01 01:30"]);
    expect([render(Date.parse("2026-10-31T12:00Z"), zone, "minute"), render(Date.parse("2026-11-02T12:00Z"), zone, "minute")])
      .toEqual(["2026-10-31 08:00", "2026-11-02 07:00"]);
  });
});
