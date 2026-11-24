import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { addDays, civilDay, instant, openHomeFolder } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { PLACES as PLACES_SHAPE, preparedDirOf, readPrepared } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import { askHome } from "./socket.js";
import { artifact, makeRoot, readHome, removeRoot, REPO, until, TICK_MS } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { doorThenHome } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";

const REGISTRY = new URL("./test/where-registry.ts", import.meta.url);
const HOME_UNIT = "macbook-pro-0001";
const ZONE = "Europe/Paris";
const GOOGLE = "google-photos:person-a@example.com:export";
const TIMELINE = "google-timeline:person-a@example.com:export";
const CAMERAS = `cameras:local:${HOME_UNIT}`;
const LIBRARY = "apple-photos:person-a@example.com:iphone-aa01";
const LOCATION = "location:local:iphone-aa01";
const PLACES = `places:local:${HOME_UNIT}`;
const OWN = "synthetic-make/own-camera";
const READER = "synthetic-token-reader".padEnd(43, "x");
const MINUTE = 60_000;

type Point = { latitude: number; longitude: number };
const NOTRE_DAME: Point = { latitude: 48.853, longitude: 2.3499 };
const BASTILLE: Point = { latitude: 48.8532, longitude: 2.3692 };
const LYON: Point = { latitude: 45.764, longitude: 4.8357 };
const LOUVRE: Point = { latitude: 48.8606, longitude: 2.3376 };
const ETOILE: Point = { latitude: 48.8738, longitude: 2.295 };
const PANTHEON: Point = { latitude: 48.8462, longitude: 2.3464 };
const MONTMARTRE: Point = { latitude: 48.8867, longitude: 2.3431 };

const at = (day: string, clock: string) => instant(`${day}T${clock}:00`, "local", { zone: ZONE }).start_ms;
const iso = (ms: number) => new Date(ms).toISOString();
const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function photos(name: string, start: number, point: Point, count = 1) {
  const rows = [], cameras = [], carried: Record<string, Buffer> = {};
  for (let index = 0; index < count; index++) {
    const taken = start + index * MINUTE;
    const original = Buffer.from(`synthetic image ${name}-${index}`);
    const hex = hexOf(original);
    carried[hex] = original;
    rows.push({
      kind: "img", key: hex, time: { start_ms: taken, precision: "s" }, blobs: [`sha256:${hex}`],
      content: { type: "photos.asset", title: `${name}-${index}.JPG`, photoTakenTime: { timestamp: String(Math.floor(taken / 1000)) },
        geoDataExif: { latitude: point.latitude, longitude: point.longitude, altitude: 35, latitudeSpan: 0, longitudeSpan: 0 },
        blobs: [{ hash: `sha256:${hex}`, bytes: original.length, media_type: "image/jpeg", role: "original" }] },
    });
    cameras.push({ kind: "photo", key: hex, content: { type: "cameras.photo", camera: OWN } });
  }
  return { rows, cameras, carried };
}

function visit(start: number, end: number, point: Point, place: string) {
  return {
    kind: "place-visit", key: `visit-${start}`, time: { start_ms: start, end_ms: end, precision: "ms" },
    content: { type: "timeline.visit", content: { startTime: iso(start), endTime: iso(end),
      visit: { hierarchyLevel: "0", probability: "0.8", topCandidate: { placeID: place, placeLocation: `geo:${point.latitude},${point.longitude}`, probability: "0.9", semanticType: "UNKNOWN" } } } },
  };
}

let fixes = 0;
function fixAt(ms: number, point: Point, speed: number) {
  const n = ++fixes;
  return { kind: "fix", key: `22222222-2222-4222-8222-222222222222:${n}`, time: { start_ms: ms, precision: "ms" },
    content: { type: "location.fix", content: { kind: "fix", payload: { location: { timestamp_rfc3339_utc: iso(ms),
      latitude: point.latitude, longitude: point.longitude, horizontal_accuracy: 5, altitude: 35, speed } } } } };
}

function track(stays: [number, number, Point][]) {
  return stays.flatMap(([from, to, point], index) => {
    const still = Array.from({ length: Math.ceil((to - from) / (2 * MINUTE)) }, (_, step) => fixAt(from + step * 2 * MINUTE, point, 0));
    const next = stays[index + 1];
    if (next === undefined) return still;
    return [...still, ...Array.from({ length: 30 }, (_, leg) => fixAt(to + leg * 20_000, {
      latitude: point.latitude + (next[2].latitude - point.latitude) * leg / 30, longitude: point.longitude + (next[2].longitude - point.longitude) * leg / 30,
    }, 9))];
  });
}

function phoneStay(start: number, end: number, point: Point) {
  return Array.from({ length: (end - start) / MINUTE }, (_, index) => {
    const ms = start + index * MINUTE;
    return { kind: "fix", key: `11111111-1111-4111-8111-111111111111:${index}`, time: { start_ms: ms, precision: "ms" },
      content: { type: "location.fix", content: { kind: "fix", payload: { location: { timestamp_rfc3339_utc: iso(ms),
        latitude: point.latitude, longitude: point.longitude, horizontal_accuracy: 5, altitude: 35, speed: 0 } } } } };
  });
}

type Named = { words: string | null; area: { city: string | null; city_id: string | null; region: string | null; country: string | null } };
type Served = {
  start_ms: number; end_ms: number; kind: string; level: string | null; how: string | null; units: string[]; point: Point | null; spot?: string | null;
  guess?: { city: string | null }; doubted?: unknown; names: { point: Named | null; from: Named | null; to: Named | null };
};
type Atom = { family: string; unit: string; start_ms: number | null; end_ms: number | null; text: string };

describe("where the person was, through the door", () => {
  const roots: string[] = [];
  const homes: Home[] = [];
  const doors: { stop(): Promise<void> }[] = [];

  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("10: the backtest counts a known city night on a move and measures individual photos", async () => {
    const root = makeRoot("lifestream-where-backtest-", {
      sources: { [GOOGLE]: "where-rows", [TIMELINE]: "where-rows", [CAMERAS]: "where-rows", [LOCATION]: "where-rows" },
      settings: { unit: HOME_UNIT, "day.zone": ZONE },
    });
    roots.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    onTestFinished(() => home.stop());
    const door = await doorHere(root);
    onTestFinished(() => door.stop());
    const start = at("2026-09-14", "12:00"), end = at("2026-09-15", "06:00");
    const shot = photos("night-on-move", at("2026-09-15", "03:00"), NOTRE_DAME);
    const clustered = [photos("at-stay", at("2026-09-14", "08:30"), NOTRE_DAME, 2),
      photos("near-stay", at("2026-09-14", "08:32"), { ...NOTRE_DAME, latitude: NOTRE_DAME.latitude + 0.0009 })];
    const fetched = Date.now();
    await ship(root, { source: TIMELINE, fetched_ms: fetched, rows: [{
      kind: "trip", key: `trip-${start}`, time: { start_ms: start, end_ms: end, precision: "ms" },
      content: { type: "timeline.trip", content: { startTime: iso(start), endTime: iso(end), activity: {
        start: `geo:${NOTRE_DAME.latitude},${NOTRE_DAME.longitude}`, end: `geo:${BASTILLE.latitude},${BASTILLE.longitude}`,
        distanceMeters: "200", topCandidate: { type: "IN_PASSENGER_VEHICLE", probability: "0.7" },
      } } },
    }, visit(at("2026-09-14", "08:00"), at("2026-09-14", "10:00"), NOTRE_DAME, "synthetic-place-r")] });
    await ship(root, { source: LOCATION, fetched_ms: fetched, rows: phoneStay(at("2026-09-14", "08:00"), at("2026-09-14", "10:00"), NOTRE_DAME) });
    await ship(root, { source: GOOGLE, fetched_ms: fetched + 1, rows: [shot, ...clustered].flatMap((each) => each.rows),
      carried: Object.assign({}, shot.carried, ...clustered.map((each) => each.carried)) });
    await ship(root, { source: CAMERAS, fetched_ms: fetched + 2, rows: [...shot.cameras, ...clustered.flatMap((each) => each.cameras),
      { kind: "camera", key: OWN, content: { type: "cameras.camera", make: "Synthetic Make", model: "Own Camera", photos: 60, first_ms: null, last_ms: null, sample: null, phones: [] } },
    ] });
    await until("the move and photo rendered", () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === 4 &&
      db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0));
    const out = join(root, "where-backtest.json");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(process.execPath, ["--import", "tsx", "tools/where-backtest.ts", "--out", out], {
        cwd: REPO,
        env: { ...process.env, LIFESTREAM_DOOR: door.url, LIFESTREAM_DOOR_TOKEN: READER },
      }, (error) => error === null ? resolve() : reject(error));
      onTestFinished(() => { child.kill(); });
    });
    const report = JSON.parse(readFileSync(out, "utf8")) as { nights: { with_the_guess: unknown; countries: unknown; by_bridge: unknown[] }; photos_vs_phone: { photos: number; median_m: number }; timeline: { photos_in_visits: number } };
    expect(report.photos_vs_phone).toMatchObject({ photos: 3, median_m: 0 });
    expect(report.timeline.photos_in_visits).toBe(3);
    expect(report.nights).toMatchObject({
      with_the_guess: { right: 1, wrong: 0, unknown: 0 }, countries: { right: 1, wrong: 0, unknown: 0 },
      by_bridge: [1, 3, 7, 30].map((days) => ({ days, right: 1, wrong: 0, unknown: 0 })),
    });
  });

  it("1-7, 9: the route's evidence is the day's, gaps are bridged and guessed only by the route, an instant is whole, summaries are the families', the ETag follows the answer, bad asks are refused, and the line ends at the door's clock", async () => {
    try {
      const root = makeRoot("lifestream-where-", {
        sources: { [GOOGLE]: "where-rows", [TIMELINE]: "where-rows", [CAMERAS]: "where-rows" },
        settings: { unit: HOME_UNIT, "day.zone": ZONE },
      });
      roots.push(root);
      const principals = openHomeFolder(root);
      mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root);
      doors.push(door);
      const count = (sql: string) => readHome(root, (db) => db.prepare(sql).pluck().get() as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
      let fetched = Date.now();
      let shipped = 0;
      const land = async (source: string, rows: unknown[], carried: Record<string, Buffer> = {}) => {
        await ship(root, { source, fetched_ms: fetched++, rows: rows as never, carried });
        shipped++;
      };
      const settle = (what: string) => until(what, () => quiet() && count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === shipped);
      const get = async (path: string, headers: Record<string, string> = {}) => {
        const response = await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
        const text = await response.text();
        return { status: response.status, etag: response.headers.get("etag"), body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
      };
      const answers: Record<string, unknown> = {};

      const place = Buffer.from(`${JSON.stringify({ kind: "place", key: "restaurant", content: { type: "places.place", name: "Synthetic Restaurant",
        centre: NOTRE_DAME, radius_m: 60, ids: ["google:synthetic-place-r"] } })}\n`);
      await shipFiles(root, PLACES, Date.now() - 60_000, { "statements.ndjson": place });
      shipped++;
      await land(CAMERAS, [{ kind: "camera", key: OWN, content: { type: "cameras.camera", make: "Synthetic Make", model: "Own Camera", photos: 60, first_ms: null, last_ms: null, sample: null, phones: [] } }]);
      await land(TIMELINE, [visit(at("2026-09-14", "18:00"), at("2026-09-16", "12:00"), NOTRE_DAME, "synthetic-place-r")]);
      const shot = [photos("own", at("2026-09-15", "13:38"), BASTILLE), photos("lyon", at("2026-09-20", "12:00"), LYON), photos("lyon-2", at("2026-09-21", "20:00"), LYON),
        ...Array.from({ length: 52 }, (_, week) => photos(`year-${week}`, at("2025-01-02", "12:00") + week * 7 * 86_400_000, week % 3 === 2 ? LYON : NOTRE_DAME, 3))];
      await land(GOOGLE, shot.flatMap((each) => each.rows), Object.assign({}, ...shot.map((each) => each.carried)));
      await land(CAMERAS, shot.flatMap((each) => each.cameras));
      await settle("the photos, the visit and the place landed, extracted and rendered");

      const range = async (from: string, to: string) => (await get(`/v1/where?from=${from}&to=${to}`)).body.pieces as Served[];
      const atoms = async (day: string) => ((await get(`/v1/days/${day}?file=json`)).body.atoms as Atom[]).filter((atom) => atom.family === "physical");
      const window = (day: string) => ({ start_ms: at(day, "04:00"), end_ms: at(day, "04:00") + 86_400_000 });

      for (const day of ["2026-09-15", "2026-09-16"]) {
        const pieces = (await range(day, day)).filter((piece) => piece.how === "observed" || piece.how === "seen" || piece.how === "stated");
        const lines = await atoms(day);
        const bounds = window(day);
        expect(pieces.map((piece) => [Math.max(piece.start_ms, bounds.start_ms), Math.min(piece.end_ms, bounds.end_ms)]), day)
          .toEqual(lines.map((atom) => [Math.max(atom.start_ms!, bounds.start_ms), Math.min(atom.end_ms!, bounds.end_ms)]));
        expect(pieces.map((piece, index) => lines[index]!.text.startsWith(piece.doubted === undefined ? `At ${piece.names.point!.words}` : `In ${piece.names.point!.area.city} (`)), day)
          .toEqual(pieces.map(() => true));
        answers[`day ${day}`] = { pieces, lines };
      }
      const fifteenth = await range("2026-09-15", "2026-09-15");
      expect(fifteenth.filter((piece) => piece.how !== null && piece.kind !== "gap").map((piece) => [piece.how, piece.level, piece.names.point?.words ?? null, piece.names.point?.area.city])).toEqual([
        ["stated", "city", null, "Paris"], ["seen", "place", "an unnamed place 1.4 km from Synthetic Restaurant", "Paris"], ["stated", "city", null, "Paris"],
      ]);

      expect((await atoms("2026-09-21")).map((atom) => atom.text)).toEqual(["At an unnamed place in Lyon (from photos)"]);
      const twentyFirst = await range("2026-09-21", "2026-09-21");
      expect(twentyFirst.map((piece) => [piece.kind, piece.how, piece.level, piece.names.point?.area.city ?? null])).toEqual([
        ["gap", "bridged", "city", "Lyon"], ["stay", "seen", "place", "Lyon"], ["gap", "guessed", "city", "Lyon"],
      ]);
      const after = await range("2026-09-22", "2026-09-23");
      expect(after.map((piece) => [piece.kind, piece.how, piece.names.point?.area.city ?? null])).toEqual([["gap", "guessed", "Lyon"]]);
      answers.bridged = { "2026-09-21": twentyFirst, after };

      const inSighting = await get(`/v1/where?at=${encodeURIComponent("2026-09-15T13:40:00+02:00")}`);
      expect(inSighting.status).toBe(200);
      const piece = inSighting.body.piece as Served;
      expect([piece.how, piece.start_ms, piece.end_ms, "before" in inSighting.body]).toEqual(["seen", at("2026-09-15", "13:23"), at("2026-09-15", "13:53"), false]);
      for (const member of ["zone", "day_start_hour"]) expect(inSighting.body).not.toHaveProperty(member);
      expect((await get("/v1/where?at=2026-09-15T13:40")).body.piece).toEqual(piece);
      const inGap = await get(`/v1/where?at=${at("2026-09-21", "08:00")}`);
      const [gap, before, later] = [inGap.body.piece, inGap.body.before, inGap.body.after] as Served[];
      expect([gap!.how, gap!.start_ms, gap!.end_ms]).toEqual(["bridged", at("2026-09-20", "12:15"), at("2026-09-21", "19:45")]);
      expect([before!.how, before!.names.point!.words, later!.how, later!.start_ms]).toEqual(["seen", "an unnamed place in Lyon", "seen", at("2026-09-21", "19:45")]);
      answers.at = { sighting: inSighting.body, gap: inGap.body };

      const trailingPath = `/v1/where?at=${Date.now() - 60_000}`;
      const trailing = await get(trailingPath);
      await until("the door's clock passed the first answer", () => Date.now() > (trailing.body.piece as Served).end_ms);
      const laterGap = await get(trailingPath, { "if-none-match": trailing.etag! });
      expect(laterGap.status).toBe(200);
      expect(laterGap.etag).not.toBe(trailing.etag);
      expect((laterGap.body.piece as Served).end_ms > (trailing.body.piece as Served).end_ms).toBe(true);
      answers.trailing = { first: trailing, later: laterGap };

      const days = (await get("/v1/where?from=2026-09-14&to=2026-09-16&grain=day")).body;
      for (const member of ["zone", "day_start_hour"]) expect(days).not.toHaveProperty(member);
      expect((days.summaries as { period: string; base: { city: string } | null }[]).map((summary) => [summary.period, summary.base?.city ?? null])).toEqual([
        ["2026-09-14", "Paris"], ["2026-09-15", "Paris"], ["2026-09-16", "Paris"],
      ]);
      const month = (await get("/v1/where?from=2026-09-01&to=2026-09-30&grain=month")).body;
      const [september] = month.summaries as { period: string; base: { city: string; city_id: string }; cities: { name: string; city_id: string }[] }[];
      expect([september!.period, september!.base.city, september!.cities.map((city) => city.name).sort()]).toEqual(["2026-09", "Paris", ["Lyon", "Paris"]]);
      expect([september!.cities.find((city) => city.city_id === september!.base.city_id)?.name, fifteenth.find((piece) => piece.how === "seen")!.names.point!.area.city_id])
        .toEqual(["Paris", september!.base.city_id]);
      answers.summaries = { days, month };

      const timed = async (path: string) => {
        await get(path);
        const started = performance.now();
        const read = await get(path);
        return { path, status: read.status, ms: Math.round(performance.now() - started), bytes: JSON.stringify(read.body).length };
      };
      answers.measure = { year: await timed("/v1/where?from=2025-01-01&to=2025-12-31&grain=month"), moment: await timed(`/v1/where?at=${at("2025-06-15", "12:00")}`) };

      const first = await get("/v1/where?from=2026-09-17&to=2026-09-17");
      expect((await get("/v1/where?from=2026-09-17&to=2026-09-17", { "if-none-match": first.etag! })).status).toBe(304);
      const late = photos("late", at("2026-09-17", "10:00"), BASTILLE);
      await land(GOOGLE, late.rows, late.carried);
      await land(CAMERAS, late.cameras);
      await settle("the late photo landed and extracted");
      const moved = await get("/v1/where?from=2026-09-17&to=2026-09-17", { "if-none-match": first.etag! });
      expect([moved.status, moved.etag === first.etag]).toEqual([200, false]);

      const refused: Record<string, unknown> = {};
      for (const [path, parameter] of [
        ["/v1/where?at=yesterday", "at"], ["/v1/where?at=2026-09-15T25:40", "at"], ["/v1/where?at=1&from=2026-09-15", "from"],
        ["/v1/where?from=2026-09-15", "to"], ["/v1/where?grain=month", "from"], ["/v1/where?from=2026-09-15&to=2026-09-15&grain=week", "grain"],
        ["/v1/where?from=2026-09-15&to=2026-09-14", "to"], ["/v1/where?from=2025-01-01&to=2026-01-02", "to"], ["/v1/where?day=2026-09-15", "day"],
      ] as const) {
        const read = await get(path);
        refused[path] = read.body;
        expect([path, read.status, read.body.code, String(read.body.message).replace(/^\[\w+\] /u, "").split(" ")[0]]).toEqual([path, 422, "BAD_PARAMETER", parameter]);
      }
      expect(String((await get("/v1/where?at=2026-09-15")).body.message).replace(/^\[\w+\] /u, "")).toBe("at names a moment, not a day");
      expect((await get("/v1/where?from=2024-01-01&to=2024-12-31&grain=year")).status).toBe(200);
      answers.refused = refused;

      const today = civilDay(Date.now(), { zone: ZONE, day_start_hour: 4 });
      const asked = Date.now();
      const ahead = (await get(`/v1/where?from=${addDays(today, -1)}&to=${addDays(today, 40)}&grain=day`)).body;
      const summaries = ahead.summaries as { period: string; coverage: { nights_unknown: string[] } }[];
      expect([(ahead.to_ms as number) >= asked, (ahead.to_ms as number) <= Date.now(), summaries.map((summary) => summary.period)]).toEqual([true, true, [addDays(today, -1), today]]);
      expect(summaries.at(-1)!.coverage.nights_unknown).toEqual(at(addDays(today, 1), "03:00") < (ahead.to_ms as number) ? [today] : []);
      const pieces = (await get(`/v1/where?from=${addDays(today, -1)}&to=${addDays(today, 40)}`)).body;
      expect(Math.max(...(pieces.pieces as Served[]).map((piece) => piece.end_ms))).toBe(pieces.to_ms);
      for (const [path, parameter] of [[`/v1/where?at=${Date.now() + 3_600_000}`, "at"], [`/v1/where?from=${addDays(today, 1)}&to=${addDays(today, 2)}`, "from"]] as const) {
        const read = await get(path);
        expect([read.status, String(read.body.message).replace(/^\[\w+\] /u, "").split(" ")[0]]).toEqual([422, parameter]);
      }
      answers.ahead = { days: ahead, pieces };
      artifact(root, "where", answers);
    } finally {
      for (const door of doors.splice(0)) await door.stop();
      for (const home of homes.splice(0)) await home.stop();
    }
  });

  it("8: an erasure of a library photo takes its whole asset: its location leaves the day and the route", async () => {
    try {
      const root = makeRoot("lifestream-where-erasure-", { sources: { [LIBRARY]: "where-rows", [CAMERAS]: "where-rows" }, settings: { unit: HOME_UNIT, "day.zone": ZONE } });
      roots.push(root);
      mintPrincipal(openHomeFolder(root), { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
      const { home, door } = await doorThenHome(root, { registry: REGISTRY, log: () => undefined });
      homes.push(home);
      doors.push(door);
      const count = (sql: string) => readHome(root, (db) => db.prepare(sql).pluck().get() as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
      let shipped = 0;
      const land = async (rows: unknown[], source: string, carried: Record<string, Buffer> = {}) => {
        await ship(root, { source, fetched_ms: Date.now() + shipped, rows: rows as never, carried });
        shipped++;
        await until(`delivery ${shipped} imported`, () => quiet() && count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === shipped);
      };
      const get = async (path: string) => JSON.parse(await (await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${READER}` } })).text()) as Record<string, unknown>;
      const seen = async () => ((await get("/v1/where?from=2026-09-15&to=2026-09-15")).pieces as Served[]).filter((piece) => piece.how === "seen").map((piece) => piece.names.point!.area.city);
      const lines = async () => ((await get("/v1/days/2026-09-15?file=json")).atoms as Atom[]).filter((atom) => atom.family === "physical").map((atom) => atom.text);

      const taken = at("2026-09-15", "13:00");
      const original = Buffer.from("synthetic library original");
      const hex = hexOf(original);
      const resource = (blob: unknown) => ({ type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC", ...(blob === null ? { blob: null, not_local: true } : { blob }) });
      const asset = { local_identifier: "EEEE-0001", media_type: "image", modification_date: null, creation_date: iso(taken), location: LYON, resources: [resource(null)] };
      await land([
        { kind: "camera", key: "phone/iphone-aa01", content: { type: "cameras.camera", make: null, model: null, photos: 1, first_ms: taken, last_ms: taken, sample: null, phones: [] } },
        { kind: "camera", key: "apple/iphone-16-pro", content: { type: "cameras.camera", make: "Apple", model: "iPhone 16 Pro", photos: 1, first_ms: taken, last_ms: taken, sample: `sha256:${hex}`, phones: ["iphone-aa01"] } },
        { kind: "photo", key: hex, content: { type: "cameras.photo", camera: "apple/iphone-16-pro" } },
      ], CAMERAS);
      await land([{ kind: "img", key: "EEEE-0001:null", time: { start_ms: taken, precision: "s" }, content: { type: "photos.apple.asset", content: asset } }], LIBRARY);
      await land([{
        kind: "img", key: `EEEE-0001:null:sha256:${"d".repeat(64)}`, time: { start_ms: taken + 86_400_000, precision: "s" }, blobs: [`sha256:${hex}`],
        content: { type: "photos.apple.availability", content: { local_identifier: "EEEE-0001", snapshot_replay_key: "EEEE-0001:snapshot",
          resources: [resource({ hash: `sha256:${hex}`, bytes: original.length, type: "image/heic", role: "original" })] } },
      }], LIBRARY, { [hex]: original });
      const before = { seen: await seen(), lines: await lines() };
      expect(before).toEqual({ seen: ["Lyon"], lines: ["At an unnamed place in Lyon (from photos)"] });

      const erased = await askHome(testSocket(root), "erase", ["photos", `photo:${hex}`, "--apply"]) as { records: number };
      await until("the home caught up", () => quiet());
      const after = { erased, records: count("SELECT count(*) FROM heads WHERE key LIKE 'EEEE-0001:%'"), seen: await seen(), lines: await lines() };
      artifact(root, "where-erasure", { before, after });
      expect(after).toMatchObject({ records: 0, seen: [], lines: [] });
    } finally {
      for (const door of doors.splice(0)) await door.stop();
      for (const home of homes.splice(0)) await home.stop();
    }
  });

  it("S1-S4: a stay's spot is the worth spot holding its occurrence, null elsewhere and while Places' file is missing or of the previous format, and in the ETag", async () => {
    try {
      const root = makeRoot("lifestream-where-spot-", {
        sources: { [GOOGLE]: "where-rows", [CAMERAS]: "where-rows", [LOCATION]: "where-rows" },
        settings: { unit: HOME_UNIT, "day.zone": ZONE },
      });
      roots.push(root);
      const principals = openHomeFolder(root);
      mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root);
      doors.push(door);
      const count = (sql: string) => readHome(root, (db) => db.prepare(sql).pluck().get() as number);
      let shipped = 0;
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state = 'imported'") === shipped &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
      const get = async (path: string, headers: Record<string, string> = {}) => {
        const response = await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${READER}`, ...headers } });
        const text = await response.text();
        return { status: response.status, etag: response.headers.get("etag"), body: (text === "" ? {} : JSON.parse(text)) as Record<string, unknown> };
      };
      const ownerEdit = async (lines: unknown[], made_ms: number) => {
        await shipFiles(root, PLACES, made_ms, { "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) });
        shipped++;
      };
      const answers: Record<string, unknown> = {};

      await ownerEdit([
        { kind: "place", key: "home", content: { type: "places.place", name: "Synthetic Home", centre: NOTRE_DAME, radius_m: 60, ids: [] } },
        { kind: "hidden", key: "hidden-5a5a5a", content: { type: "places.hidden", centre: ETOILE, radius_m: 80 } },
      ], Date.now() - 120_000);
      await ship(root, { source: LOCATION, fetched_ms: Date.now(), rows: [
        ...track([[at("2026-09-07", "08:00"), at("2026-09-07", "09:00"), NOTRE_DAME], [at("2026-09-07", "10:00"), at("2026-09-07", "12:00"), BASTILLE],
          [at("2026-09-07", "12:30"), at("2026-09-07", "12:50"), LOUVRE], [at("2026-09-07", "13:30"), at("2026-09-07", "15:30"), ETOILE],
          [at("2026-09-07", "16:00"), at("2026-09-07", "17:00"), NOTRE_DAME]]),
        ...track([[at("2026-09-08", "18:00"), at("2026-09-08", "21:00"), NOTRE_DAME], [at("2026-09-08", "22:00"), at("2026-09-09", "06:00"), BASTILLE],
          [at("2026-09-09", "06:30"), at("2026-09-09", "07:30"), NOTRE_DAME]]),
      ] as never });
      shipped++;
      const shot = ["2026-09-14", "2026-09-15", "2026-09-16"].flatMap((day) => [photos(`pantheon-${day}`, at(day, "10:00"), PANTHEON, 2), photos(`montmartre-${day}`, at(day, "15:00"), MONTMARTRE, 2)]);
      await ship(root, { source: CAMERAS, fetched_ms: Date.now() + 1, rows: [
        { kind: "camera", key: OWN, content: { type: "cameras.camera", make: "Synthetic Make", model: "Own Camera", photos: 60, first_ms: null, last_ms: null, sample: null, phones: [] } },
        ...shot.flatMap((each) => each.cameras),
      ] as never });
      shipped++;
      await ship(root, { source: GOOGLE, fetched_ms: Date.now() + 2, rows: shot.flatMap((each) => each.rows) as never, carried: Object.assign({}, ...shot.map((each) => each.carried)) });
      shipped++;

      type Listed = { latitude: number; longitude: number; worth: boolean; key?: string };
      const near = (spots: Listed[], point: Point) => spots.filter((spot) => Math.hypot(spot.latitude - point.latitude, spot.longitude - point.longitude) < 0.0008);
      const list = async () => (await get("/v1/places")).body as { spots: Listed[]; hidden: { key: string; days: number }[] };
      await until("the phone, the photos and the owner's places landed and Places prepared", async () => quiet() && (await get("/v1/places")).status === 200 &&
        near((await list()).spots, MONTMARTRE).length === 1);
      const listed = await list();
      const [bastille, louvre, pantheon, montmartre] = [BASTILLE, LOUVRE, PANTHEON, MONTMARTRE].map((point) => {
        const found = near(listed.spots, point);
        expect(found, JSON.stringify(point)).toHaveLength(1);
        return found[0]!;
      });
      expect([bastille!.worth, louvre!.worth, pantheon!.worth, montmartre!.worth, "key" in louvre!]).toEqual([true, false, true, true, false]);
      expect(near(listed.spots, ETOILE)).toEqual([]);
      expect(listed.hidden.map((hidden) => [hidden.key, hidden.days])).toEqual([["hidden-5a5a5a", 1]]);
      answers.list = listed;

      const day = async (date: string) => {
        const read = await get(`/v1/where?from=${date}&to=${date}`);
        expect(read.status, date).toBe(200);
        return { etag: read.etag!, pieces: read.body.pieces as Served[] };
      };
      const stayAt = (pieces: Served[], point: Point) => pieces.filter((piece) => piece.kind === "stay" && piece.point !== null &&
        Math.hypot(piece.point.latitude - point.latitude, piece.point.longitude - point.longitude) < 0.0008);
      const seventh = await day("2026-09-07");
      const [home7, bastille7, louvre7, etoile7] = [NOTRE_DAME, BASTILLE, LOUVRE, ETOILE].map((point) => {
        const found = stayAt(seventh.pieces, point);
        expect(found.length, JSON.stringify(point)).toBeGreaterThan(0);
        return found[0]!;
      });

      const file = join(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places"), "places.db");
      type Row = { unit: string; start_ms: number; end_ms: number; latitude: number; longitude: number; key: string };
      const spotted = () => readPrepared(openHomeFolder(dirname(file)), file, PLACES_SHAPE.format, (read) => read.db.prepare("SELECT unit, start_ms, end_ms, latitude, longitude, key FROM spotted ORDER BY key, start_ms").all() as Row[])!.value;
      const rows = spotted();
      const eighth = await day("2026-09-08"), ninth = await day("2026-09-09");
      const overnight = stayAt(eighth.pieces, BASTILLE)[0]!;
      const bastilleRows = rows.filter((row) => row.key === bastille!.key);
      expect(bastilleRows.map((row, index) => {
        const piece = [bastille7!, overnight][index]!;
        return [row.unit, row.latitude === piece.point!.latitude && row.longitude === piece.point!.longitude, row.start_ms <= piece.start_ms && piece.start_ms < row.end_ms];
      })).toEqual([[bastille7!.units[0], true, true], [overnight.units[0], true, true]]);
      expect(bastilleRows.at(-1)!.end_ms).toBeGreaterThan(at("2026-09-09", "04:00"));
      const units = (key: string) => rows.filter((row) => row.key === key).map((row) => row.unit);
      expect(units(pantheon!.key!)).toEqual(units(montmartre!.key!));
      expect(units(pantheon!.key!)).toHaveLength(3);
      expect(units(pantheon!.key!).every((unit) => unit.startsWith("seen/"))).toBe(true);
      expect(new Set(rows.map((row) => row.key))).toEqual(new Set([bastille!.key, pantheon!.key, montmartre!.key]));
      expect(rows.some((row) => [home7, louvre7, etoile7].some((piece) => piece!.units[0] === row.unit))).toBe(false);
      answers.spotted = rows;

      expect([home7!.spot, bastille7!.spot, louvre7!.spot, etoile7!.spot]).toEqual([null, bastille!.key, null, null]);
      expect(seventh.pieces.filter((piece) => piece.kind !== "stay").every((piece) => !("spot" in piece))).toBe(true);
      expect(seventh.pieces.filter((piece) => piece.kind === "stay").every((piece) => "spot" in piece)).toBe(true);
      const ninthStay = stayAt(ninth.pieces, BASTILLE)[0]!;
      expect([overnight.end_ms, ninthStay.start_ms, ninthStay.units[0]]).toEqual([at("2026-09-09", "04:00"), at("2026-09-09", "04:00"), overnight.units[0]]);
      const both = (await get("/v1/where?from=2026-09-08&to=2026-09-09")).body.pieces as Served[];
      expect([overnight.spot, ninthStay.spot, stayAt(both, BASTILLE).map((piece) => [piece.start_ms, piece.spot])])
        .toEqual([bastille!.key, bastille!.key, [[overnight.start_ms, bastille!.key]]]);
      const sixteenth = await day("2026-09-16");
      const [pantheon16, montmartre16] = [stayAt(sixteenth.pieces, PANTHEON)[0]!, stayAt(sixteenth.pieces, MONTMARTRE)[0]!];
      expect([pantheon16.units[0] === montmartre16.units[0], pantheon16.spot, montmartre16.spot]).toEqual([true, pantheon!.key, montmartre!.key]);
      expect(((await get(`/v1/where?at=${at("2026-09-16", "15:01")}`)).body.piece as Served).spot).toBe(montmartre!.key);
      answers.keyed = { seventh, eighth, ninth, both, sixteenth };

      const allNull = (pieces: Served[]) => pieces.filter((piece) => piece.kind === "stay").every((piece) => piece.spot === null);
      rmSync(dirname(file), { recursive: true, force: true });
      const missing = await get("/v1/where?from=2026-09-07&to=2026-09-07", { "if-none-match": seventh.etag });
      expect([missing.status, allNull(missing.body.pieces as Served[]), missing.etag === seventh.etag]).toEqual([200, true, false]);
      await askHome(testSocket(root), "run", ["places", "places"]);
      await until("Places prepared again, the Bastille's stay keyed", async () => quiet() && stayAt((await day("2026-09-07")).pieces, BASTILLE)[0]?.spot === bastille!.key);
      expect((await get("/v1/where?from=2026-09-07&to=2026-09-07", { "if-none-match": seventh.etag })).status).toBe(304);
      const older = new Database(file);
      older.prepare("UPDATE meta SET value = ? WHERE key = 'format'").run(String(Number(PLACES_SHAPE.format) - 1));
      older.exec("DROP TABLE spotted");
      older.close();
      const previous = await get("/v1/where?from=2026-09-07&to=2026-09-07");
      expect([previous.status, allNull(previous.body.pieces as Served[])]).toEqual([200, true]);
      await askHome(testSocket(root), "run", ["places", "places"]);
      await until("the previous format replaced, the Bastille's stay keyed", async () => quiet() && stayAt((await day("2026-09-07")).pieces, BASTILLE)[0]?.spot === bastille!.key);
      expect(spotted()).toEqual(rows);
      answers.missing = { missing: missing.body, previous: previous.body };

      await ownerEdit([{ kind: "place", key: "corner", content: { type: "places.place", name: "Synthetic Corner", centre: { latitude: bastille!.latitude, longitude: bastille!.longitude }, radius_m: 80, ids: [] } }], Date.now() - 60_000);
      await until("the Bastille named in the route and in Places", async () => {
        if (!quiet()) return false;
        const named = stayAt((await day("2026-09-07")).pieces, BASTILLE)[0];
        return named?.names.point?.words === "Synthetic Corner" && named.spot === null;
      });
      const renamed = await get("/v1/where?from=2026-09-07&to=2026-09-07", { "if-none-match": seventh.etag });
      expect([renamed.status, renamed.etag === seventh.etag, stayAt(renamed.body.pieces as Served[], BASTILLE).map((piece) => piece.spot)]).toEqual([200, false, [null]]);
      expect(spotted().some((row) => row.key === bastille!.key)).toBe(false);
      answers.named = renamed.body;
      artifact(root, "where-spot", answers);
    } finally {
      for (const door of doors.splice(0)) await door.stop();
      for (const home of homes.splice(0)) await home.stop();
    }
  });
});
