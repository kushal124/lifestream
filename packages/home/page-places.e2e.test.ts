import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, openHome as openHomeDb, openHomeFolder } from "@lifestreamprotocol/core";
import { takesIn, unitFocus } from "@lifestreamprotocol/families";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { PAGES, type PageName } from "./pages.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { clientFixture, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";

const REGISTRY = join(REPO, "packages", "home", "test", "places-registry.ts");
const HOME_UNIT = "macbook-pro-0001";
const PLACES = `places:local:${HOME_UNIT}`;
const FIXES = "location:local:iphone-fixes-aa01";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const DESK = "synthetic-token-places-desk".padEnd(43, "d");
const SETTINGS = { unit: HOME_UNIT, "day.zone": "UTC" };
const BASE = Date.parse("2026-10-05T06:00:00Z");
const MIN = 60_000;
const at = (day: string, clock: string) => Date.parse(`${day}T${clock}Z`);

type Point = { latitude: number; longitude: number };
type Body = Record<string, any>;
type Stay = [from: number, to: number, point: Point, step: number];

const HOME = { latitude: 48.8566, longitude: 2.3522 };
const CAFE = { latitude: 48.8606, longitude: 2.3376 };
const SPOT = { latitude: 48.853, longitude: 2.37 };
const LOOSE = { latitude: 48.85, longitude: 2.36 };
const HOTEL = { latitude: 40.7128, longitude: -74.006 };
const BUOY = { latitude: 0, longitude: 0 };

let sequence = 0;
function fix(when: number, point: Point, speed: number) {
  const iso = new Date(when).toISOString();
  const n = ++sequence;
  return { kind: "fix", key: `${INSTALL}:${n}`, at: when + 1_500, content: { type: "location.fix", content: {
    schema_version: 1, domain: "location", kind: "fix", sequence: n,
    payload: { location: { timestamp_rfc3339_utc: iso, timestamp_unix_seconds: when / 1000, ...point, horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed, course: 90 },
      capture_context: { engine: "app_owned", authorization: "always" } },
    captured: { wall_rfc3339: iso, wall_unix_seconds: when / 1000, elapsed_seconds: n * 7.5 }, process_instance_id: INSTALL,
  } } };
}

function track(stays: readonly Stay[], legs = 30) {
  const rows: ReturnType<typeof fix>[] = [];
  stays.forEach(([from, to, point, step], index) => {
    for (let t = from; t < to; t += step) rows.push(fix(t, point, 0));
    const next = stays[index + 1];
    if (next === undefined) return;
    for (let leg = 0; leg < legs; leg++) {
      const share = leg / legs;
      rows.push(fix(to + leg * 20_000, { latitude: point.latitude + (next[2].latitude - point.latitude) * share, longitude: point.longitude + (next[2].longitude - point.longitude) * share }, 9));
    }
  });
  return rows;
}

function homeBetween(away: readonly Stay[], from: number, to: number): Stay[] {
  const stays: Stay[] = [];
  let cursor = from;
  for (const stay of away) {
    stays.push([cursor, stay[0] - 15 * MIN, HOME, 10 * MIN], stay);
    cursor = stay[1] + 15 * MIN;
  }
  stays.push([cursor, to, HOME, 10 * MIN]);
  return stays;
}

const place = (key: string, name: string, centre: Point, radius_m: number) =>
  ({ kind: "place", key, content: { type: "places.place", name, centre: { ...centre }, radius_m, ids: [] } });

describe("The places pages through the door", () => {
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  const started = Date.now();
  const clock = () => BASE + (Date.now() - started);
  const bounds = new Set<() => void>();
  const report: Record<string, unknown> = {};

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const sayPlaces = async (statements: object[]) => {
    const id = await shipFiles(root, PLACES, clock(), { "statements.ndjson": Buffer.from(statements.map((line) => `${JSON.stringify(line)}\n`).join("")) });
    await until(`${id} imported and the places written after it`, () => imported(id) && ran());
  };
  const sendFixes = async (rows: ReturnType<typeof fix>[]) => {
    const id = await ship(root, { source: FIXES, fetched_ms: clock(), rows });
    await until(`${id} imported and the places written after it`, () => imported(id) && ran());
  };
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${DESK}`, ...headers } });
    const text = await response.text();
    return { status: response.status, etag: response.headers.get("etag"), body: text === "" ? null : JSON.parse(text) as Body };
  };
  const page = async (name: PageName, query = "") => {
    const path = `${PAGES[name].route}${query}`;
    const answer = await get(path);
    expect(answer.status, path).toBe(200);
    PAGES[name].shape.parse(answer.body);
    return answer;
  };
  const act = async (action: Record<string, unknown>) => {
    const response = await fetch(`${url}/v1/owner/act`, {
      method: "POST", headers: { authorization: `Bearer ${DESK}`, "content-type": "application/json" }, body: JSON.stringify({ of: "places", request: randomUUID(), ...action }),
    });
    expect(response.status, JSON.stringify(action)).toBe(200);
  };
  const pinned = (name: string, body: Body) => {
    mkdirSync(join(REPO, "homelink", "Tests", "Fixtures", "pages"), { recursive: true });
    const fixture = clientFixture(`pages/${name}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };
  const start = async () => {
    home = await startHome(root, { registry: REGISTRY, clock, log: () => undefined });
  };
  const dragged = (edit: Body, circle: { latitude: number; longitude: number; radius_m: number }) =>
    edit.held + takesIn({ slug: edit.slug, ...circle }, edit.others, edit.points);

  beforeAll(async () => {
    root = makeRoot("lifestream-page-places-", { sources: { [FIXES]: "fake-rows", [PLACES]: "places-home" }, settings: SETTINGS });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: DESK, now_ms: 0 });
    await start();
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      log: () => undefined, registry: REGISTRY, clock, beats: { settled: (end) => { bounds.add(end); return () => { bounds.delete(end); }; } },
    });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-places.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("reads each places page in its shape: cities with Elsewhere last, a city's name in find, the spot to name, a trip as values, and the edit page's sum equal to the place page's stays", async () => {
    await sayPlaces([
      place("home", "Synthetic Home", HOME, 120), place("cafe-0c0c0c", "Synthetic Cafe", CAFE, 60),
      place("hotel-0e0e0e", "Synthetic Hotel", HOTEL, 100), place("buoy-0f0f0f", "Synthetic Buoy", BUOY, 100),
    ]);
    const days = Array.from({ length: 13 }, (_, index) => addDays("2026-09-15", index));
    const away: Stay[] = days.flatMap((day, index): Stay[] => [
      ...(index % 2 === 0 ? [[at(day, "09:00:00"), at(day, "11:00:00"), CAFE, 2 * MIN] as Stay] : []),
      ...([2, 5, 9].includes(index) ? [[at(day, "12:00:00"), at(day, "14:00:00"), SPOT, 2 * MIN] as Stay] : []),
    ]);
    away.push([at("2026-09-28", "12:00:00"), at("2026-09-30", "10:00:00"), HOTEL, 10 * MIN], [at("2026-10-02", "12:00:00"), at("2026-10-02", "12:20:00"), LOOSE, 2 * MIN]);
    await sendFixes(track(homeBetween(away, at("2026-09-14", "20:00:00"), at("2026-10-04", "08:00:00"))));

    const places = (await page("places")).body!;
    expect(places.cities.map((city: Body) => city.key).at(-1), "Elsewhere comes last").toBe("elsewhere");
    const byKey = new Map(places.cities.map((city: Body) => [city.key, city]));
    const paris = byKey.get("city:Paris") as Body;
    expect(paris.title).toBe("Paris");
    const parisRows = [...paris.places, ...paris.once] as Body[];
    expect(parisRows.map((row) => row.slug).sort()).toEqual(["cafe-0c0c0c", "home"]);
    expect(parisRows.find((row) => row.slug === "cafe-0c0c0c")!.find, "a city's name finds its places").toEqual(expect.arrayContaining(["Synthetic Cafe", "Paris", "France"]));
    expect(([...(byKey.get("city:New York City") as Body).places, ...(byKey.get("city:New York City") as Body).once] as Body[]).map((row) => row.slug)).toEqual(["hotel-0e0e0e"]);
    const buoy = (byKey.get("elsewhere") as Body).places[0] as Body;
    expect([buoy.slug, buoy.when, buoy.line], "a place never visited says so with no date").toEqual(["buoy-0f0f0f", null, "Not yet"]);
    expect(places.to_name).toHaveLength(1);
    const spotKey = places.to_name[0].key as string;
    expect([places.counting, places.hidden]).toEqual([false, []]);
    expect((await page("place", "?slug=home")).body!.here, "the list's here is the place page's").toBe(places.here === "home");
    expect(places.frame.north).toBeGreaterThan(places.frame.south);
    report.places = places;
    pinned("places.full", places);

    const cafe = (await page("place", "?slug=cafe-0c0c0c")).body!;
    expect([cafe.head.name, cafe.head.line, cafe.here, cafe.counting]).toEqual(["Synthetic Cafe", "Paris", false, false]);
    expect(cafe.stays, "the cafe's seven mornings").toBe(7);
    expect(cafe.visits.count).toBe(cafe.visits.rows.length);
    const focuses = (cafe.visits.rows as Body[]).map((visit) => visit.focus);
    expect(focuses, "each visit opens its day on its own stay: the unit and the visit's span").toEqual((cafe.visits.rows as Body[]).map((visit) => unitFocus(visit.unit, { from_ms: visit.start_ms, to_ms: visit.end_ms })));
    expect(focuses, "the focus the place read gives each visit").toEqual(((await get("/v1/places?slug=cafe-0c0c0c")).body!.place.visits as Body[]).map((visit) => visit.focus));
    expect(cafe.head.since === null || cafe.head.since.kind !== "at", "since is a day or a month, never an instant").toBe(true);
    report.place = cafe;
    pinned("place.full", cafe);

    const edit = (await page("placeEdit", "?slug=cafe-0c0c0c")).body!;
    expect([edit.slug, edit.circle, edit.read, edit.line, edit.counting]).toEqual(["cafe-0c0c0c", { ...CAFE, radius_m: 60 }, true, null, false]);
    expect(edit.others.map((circle: Body) => circle.slug), "every other place's circle within 5 km, none an ocean away").toEqual(["home"]);
    expect(dragged(edit, edit.circle), "held and what the circle takes in are the place page's stays").toBe(cafe.stays);
    report.edit = edit;
    pinned("placeEdit.slug", edit);

    const spotted = (await page("placeEdit", `?spot=${encodeURIComponent(spotKey)}`)).body!;
    const listed = ((await get("/v1/places")).body!.spots as Body[]).find((spot) => spot.key === spotKey)!;
    expect([spotted.slug, spotted.circle.radius_m, spotted.held]).toEqual([spotKey, 80, 0]);
    expect(dragged(spotted, spotted.circle), "a new circle on the spot takes in the spot's stays").toBe(listed.stays);
    pinned("placeEdit.spot", spotted);

    const year = (await page("year", "?year=2026")).body!;
    const trip = (year.trips as Body[]).find((each) => (each.route as string[]).includes("New York City"));
    expect(trip, "the nights in New York are a trip").toBeDefined();
    expect([trip!.range.first <= trip!.range.last, /\d{4}-\d{2}/u.test(trip!.nights)]).toEqual([true, false]);
    const tripDays: string[] = [];
    for (let each = trip!.range.first as string; each <= trip!.range.last; each = addDays(each, 1)) tripDays.push(each);
    expect((trip!.days as Body[]).map((each) => each.day), "a day of the trip a row").toEqual(tripDays);
    expect((trip!.days as Body[]).filter((each) => !(each.line as string).startsWith("New York City") || /\d:\d{2}/u.test(each.line)), "each night in New York, no time in its words").toEqual([]);
    expect([year.year, year.span.last, year.base?.name]).toEqual([2026, 2026, "Paris"]);
    report.year = year;
    pinned("year.full", year);

    for (const [path, code] of [["/v1/page/place?slug=nowhere-000000", "PLACE_UNKNOWN"], ["/v1/page/place/edit?spot=spot:1,1", "SPOT_UNKNOWN"], ["/v1/page/year?year=1999", "YEAR_UNKNOWN"],
      ["/v1/page/place/edit?slug=home&spot=spot:1,1", "BAD_PARAMETER"], ["/v1/page/year?year=20x6", "BAD_PARAMETER"], ["/v1/page/place", "BAD_PARAMETER"]] as const) {
      expect((await get(path)).body, path).toMatchObject({ code });
    }
  });

  it("answers 304 on its ETag, and moves it when a stay lands", async () => {
    const list = await page("places");
    const one = await page("place", "?slug=cafe-0c0c0c");
    expect((await get("/v1/page/places", { "if-none-match": list.etag! })).status).toBe(304);
    expect((await get("/v1/page/place?slug=cafe-0c0c0c", { "if-none-match": one.etag! })).status).toBe(304);

    await sendFixes(track([[at("2026-10-04", "09:00:00"), at("2026-10-04", "10:00:00"), HOME, 10 * MIN], [at("2026-10-04", "10:15:00"), at("2026-10-04", "11:30:00"), CAFE, 2 * MIN],
      [at("2026-10-04", "11:45:00"), at("2026-10-04", "13:00:00"), HOME, 10 * MIN]]));
    const moved = await get("/v1/page/place?slug=cafe-0c0c0c", { "if-none-match": one.etag! });
    expect([moved.status, moved.body?.stays], "a new morning at the cafe moved the ETag").toEqual([200, 8]);
    PAGES.place.shape.parse(moved.body);
    expect((await get("/v1/page/places", { "if-none-match": list.etag! })).status).toBe(200);
  });

  it("counts while dragging what a save takes in: the place page read settled=1 after the save says held and takesIn", async () => {
    const edit = (await page("placeEdit", "?slug=cafe-0c0c0c")).body!;
    const moved = { ...SPOT, radius_m: 150 };
    const expected = dragged(edit, moved);
    expect(expected, "the moved circle takes in the spot's three afternoons").toBe(3);

    await askHome(testSocket(root), "pause", ["kind:places", "--reason", "a test holds the places run"]);
    await act({ kind: "edit", slug: "cafe-0c0c0c", ...moved, was: { ...CAFE, radius_m: 60 } });
    await home.stop();
    const db = openHomeDb(openHomeFolder(root), "migrate");
    try {
      db.commit((tx) => {
        for (const control of tx.tables.controls.list()) tx.tables.controls.clear(control.target);
      });
    } finally {
      db.close();
    }

    const counting = (await page("place", "?slug=cafe-0c0c0c")).body!;
    expect(counting.counting, "the edit is in the records, the places run not yet made").toBe(true);
    pinned("place.counting", counting);
    const answered: { settled?: Awaited<ReturnType<typeof get>> } = {};
    const held = get("/v1/page/place?slug=cafe-0c0c0c&settled=1").then((answer) => { answered.settled = answer; });
    await until("the settled read held", () => bounds.size === 1);

    await start();
    await until("the settled read answered after the restart", () => answered.settled !== undefined);
    await held;
    const settled = answered.settled!;
    expect(settled.status).toBe(200);
    PAGES.place.shape.parse(settled.body);
    expect([settled.body!.counting, settled.body!.stays], "the count the drag showed is the count the save took in").toEqual([false, expected]);
    expect(bounds.size).toBe(0);
    await until("the places written after the restart", ran);
  });
});

describe("A place and a spot slept in three nights this week ask Is this home?", () => {
  const FLAT = { latitude: 48.8566, longitude: 2.3522 };
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  const started = Date.now();
  const clock = () => BASE + (Date.now() - started);

  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
  const page = async (name: PageName, query = "") => {
    const response = await fetch(`${url}${PAGES[name].route}${query}`, { headers: { authorization: `Bearer ${DESK}` } });
    expect(response.status, name).toBe(200);
    const body = await response.json() as Body;
    PAGES[name].shape.parse(body);
    return body;
  };
  const pinned = (name: string, body: Body) => {
    const fixture = clientFixture(`pages/${name}`, body);
    expect(fixture.held, `homelink/Tests/Fixtures/pages/${name}.json is this read: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
  };

  beforeAll(async () => {
    root = makeRoot("lifestream-page-places-asking-", { sources: { [FIXES]: "fake-rows", [PLACES]: "places-home" }, settings: SETTINGS });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: DESK, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, clock, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("carries the question on the spot to name and on the named place, its words and the day of the first night, pinned for the apps", async () => {
    const shipped = await shipFiles(root, PLACES, clock(), { "statements.ndjson": Buffer.from(`${JSON.stringify(place("flat-0d0d0d", "Synthetic Flat", FLAT, 120))}\n`) });
    const fixes = await ship(root, { source: FIXES, fetched_ms: clock(), rows: track([
      [at("2026-09-28", "20:00:00"), at("2026-10-01", "08:00:00"), FLAT, 10 * MIN],
      [at("2026-10-01", "08:30:00"), at("2026-10-04", "08:00:00"), SPOT, 10 * MIN],
    ]) });
    await until(`${shipped} and ${fixes} imported and the places written after them`, () => imported(shipped) && imported(fixes) && ran());
    const line = expect.stringMatching(/^You've slept here 3\snights$/u);

    const places = await page("places");
    const asking = (places.to_name as Body[]).filter((spot) => spot.ask !== null);
    expect(asking.map((spot) => spot.ask), "the spot slept in from the night of 1 October asks, and only it").toEqual([{ line, since: { kind: "day", day: "2026-10-01" } }]);
    pinned("places.asking", places);

    const flat = await page("place", "?slug=flat-0d0d0d");
    expect([flat.counting, flat.ask_home], "the flat slept in from the night of 28 September asks").toEqual([false, { line, since: { kind: "day", day: "2026-09-28" } }]);
    pinned("place.asking", flat);
  });
});

describe("The places pages at the live home's size", () => {
  const PLACES_AT_SIZE = 82;
  const WORTH = 111;
  const LOOSE_SPOTS = 2_600;
  const READS = 5;
  let root: string;
  let home: Home;
  let door: Door;
  let url = "";
  const started = Date.now();
  const clock = () => BASE + (Date.now() - started);
  const report: Record<string, unknown> = {};

  const timed = async (path: string) => {
    const began = performance.now();
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${DESK}` } });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) as Body, ms: performance.now() - began };
  };
  const median = (values: number[]) => [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)]!;
  const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
  const ran = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;

  beforeAll(async () => {
    root = makeRoot("lifestream-page-places-size-", { sources: { [FIXES]: "fake-rows", [PLACES]: "places-home" }, settings: SETTINGS });
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: DESK, now_ms: 0 });
    home = await startHome(root, { registry: REGISTRY, clock, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY, clock });
    url = `http://127.0.0.1:${door.port}`;
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "page-places-size.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("answers about 82 places, 111 spots to name and 2,600 spots not worth naming, each page's time printed for the evidence step", async () => {
    const grid = (from: Point, n: number, across: number): Point => ({ latitude: from.latitude + Math.floor(n / across) * 0.003, longitude: from.longitude + (n % across) * 0.003 });
    const named = Array.from({ length: PLACES_AT_SIZE }, (_, n) => grid({ latitude: 48.7, longitude: 2.2 }, n, 10));
    const worth = Array.from({ length: WORTH }, (_, n) => grid({ latitude: 48.75, longitude: 2.2 }, n, 12));
    const loose = Array.from({ length: LOOSE_SPOTS }, (_, n) => grid({ latitude: 48.8, longitude: 2.2 }, n, 52));
    const shipped = await shipFiles(root, PLACES, clock(), {
      "statements.ndjson": Buffer.from(named.map((centre, n) => `${JSON.stringify(place(`place-${String(n).padStart(3, "0")}-0a0a0a`, `Synthetic Place ${n}`, centre, 60))}\n`).join("")),
    });
    let cursor = at("2026-08-01", "06:00:00");
    const stays: Stay[] = [];
    const visit = (point: Point, minutes: number, step: number) => {
      stays.push([cursor, cursor + minutes * MIN, point, step * MIN]);
      cursor += (minutes + 5) * MIN;
    };
    for (const point of named) visit(point, 20, 2);
    for (const point of worth) visit(point, 150, 10);
    for (const point of loose) visit(point, 10, 2);
    const fixes = await ship(root, { source: FIXES, fetched_ms: clock(), rows: track(stays, 6) });
    await until(`${shipped} and ${fixes} imported and the places written after them`, () => imported(shipped) && imported(fixes) && ran());
    const prepared = await timed("/v1/page/places");
    expect([prepared.status, prepared.body.counting, prepared.body.to_name.length], "every spot worth naming: a visit of over two hours keeps an hour on one side of the day's start").toEqual([200, false, WORTH]);
    const paths = { places: "/v1/page/places", place: "/v1/page/place?slug=place-041-0a0a0a", placeEdit: "/v1/page/place/edit?slug=place-041-0a0a0a", year: "/v1/page/year?year=2026" } as const;
    const budgets = { places: 60, place: 50, placeEdit: 50, year: 50 } as const;
    const times: Record<string, number[]> = {};
    for (let read = 0; read < READS; read++) {
      for (const [name, path] of Object.entries(paths) as [keyof typeof paths, string][]) {
        const answer = await timed(path);
        expect(answer.status, path).toBe(200);
        PAGES[name].shape.parse(answer.body);
        (times[name] ??= []).push(answer.ms);
      }
    }
    const edit = await timed(paths.placeEdit);
    expect(edit.body.points.length, "the stays within 5 km of a place").toBeGreaterThan(0);
    for (const name of Object.keys(paths) as (keyof typeof paths)[]) {
      report[name] = { ms: times[name], median_ms: median(times[name]!), budget_ms: budgets[name] };
      process.stdout.write(`page ${paths[name]} at ${PLACES_AT_SIZE} places, ${WORTH} spots to name, ${LOOSE_SPOTS} not worth naming: median ${median(times[name]!).toFixed(1)} ms over ${READS} reads (budget ${budgets[name]})\n`);
    }
  });
});
