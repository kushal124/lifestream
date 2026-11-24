import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";
import { addDays, civilDay, dayBounds, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { areaOf, rhythm } from "@lifestreamprotocol/families";
import { afterAll, describe, expect, it } from "vitest";
import { startHome, type Home } from "./home.js";
import { DASHBOARD_UNIT } from "./lifecycle.js";
import { machine } from "./machine.js";
import { PLACES as PLACES_SHAPE, preparedDirOf, preparedFileOf, readPrepared } from "./prepared.js";
import { mintPrincipal, passOf } from "./principals.js";
import { askHome } from "./socket.js";
import { artifact, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { doorThenHome } from "./test/harness-home.js";
import { acquisitionBundle, DEVICE, healthLine, phoneBundle } from "./test/support.js";
import { readOpsSettings } from "./verbs/context.js";
import { testSocket } from "./test/folder.js";

const REGISTRY = new URL("./test/places-registry.ts", import.meta.url);
const GOLDEN = new URL("./test/places/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const HOME_UNIT = "macbook-pro-0001";
const PLACES = `places:local:${HOME_UNIT}`;
const GOOGLE = "google-maps:person-a@example.com:lookup";
const ACCOUNT = "person-a@example.com";
const HEALTH = `apple-health:${ACCOUNT}:cloud`;
const FIXES = "location:local:iphone-fixes-aa01";
const DAY = "2026-10-01";
const at = (clock: string) => Date.parse(`${DAY}T${clock}Z`);
const HOME = { latitude: 0, longitude: 0 };
const SPOT = { latitude: 0, longitude: 0.0135 };
const GYM = { latitude: 0.009, longitude: 0.0135 };
const INSTALL = "11111111-1111-4111-8111-111111111111";
const DASHBOARD = "synthetic-token-dashboard".padEnd(43, "x");

type Answer = { status: number; body: Record<string, unknown>; etag: string | null };

async function request(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  return { status: response.status, body: text === "" ? {} : JSON.parse(text) as Record<string, unknown>, etag: response.headers.get("etag") };
}

const place = (name: string, centre: { latitude: number; longitude: number }, radius_m: number, ids: string[] = []) =>
  ({ type: "places.place", name, centre: { ...centre }, radius_m, ids });
const googleName = (id: string, name: string, centre: { latitude: number; longitude: number }) =>
  ({ kind: "place", key: `google:${id}`, content: { type: "google.place", id, name, centre: { ...centre } } });

function edit(source: string, made_ms: number, statements: unknown[], facts: Record<string, unknown> = {}): { path: string; name: string; bytes: Buffer } {
  const text = Buffer.from(statements.map((line) => `${JSON.stringify(line)}\n`).join(""));
  const bundle = acquisitionBundle({
    source, feeder: "owner-statements", fetched_ms: made_ms, files: [["statements.ndjson", text]],
    manifest: (manifest) => ({ ...manifest, facts: { statements: statements.length, blobs_carried: 0, ...facts } }),
  });
  return { path: bundle.path, name: bundle.path.split("/").at(-1)!, bytes: bundle.bytes };
}

const sayPlaces = (root: string, made_ms: number, statements: unknown[]): Promise<string> =>
  shipFiles(root, PLACES, made_ms, { "statements.ndjson": Buffer.from(statements.map((line) => `${JSON.stringify(line)}\n`).join("")) });

const deliveryName = (root: string, request: string): string =>
  (readHome(root, (db) => db.prepare("SELECT id FROM deliveries WHERE source = ? AND json_extract(facts, '$.request') = ?").pluck().get(PLACES, request)) as string).slice(PLACES.length + 1);

const act = (url: string, headers: Record<string, string>, action: Record<string, unknown>): Promise<Answer> =>
  request(url, "POST", "/v1/owner/act", { ...headers, "content-type": "application/json" }, JSON.stringify({ of: "places", ...action }));

const sayPeople = (root: string, made_ms: number, statements: unknown[]): Promise<string> =>
  shipFiles(root, `people:local:${HOME_UNIT}`, made_ms, { "statements.ndjson": Buffer.from(statements.map((line) => `${JSON.stringify(line)}\n`).join("")) });

let sequence = 0;
function fix(when: number, point: { latitude: number; longitude: number }, speed: number) {
  const iso = new Date(when).toISOString();
  const n = ++sequence;
  return { kind: "fix", key: `${INSTALL}:${n}`, at: when + 1_500, content: { type: "location.fix", content: {
    schema_version: 1, domain: "location", kind: "fix", sequence: n,
    payload: { location: { timestamp_rfc3339_utc: iso, timestamp_unix_seconds: when / 1000, ...point, horizontal_accuracy: 5, vertical_accuracy: 3, altitude: 12, speed, course: 90 },
      capture_context: { engine: "app_owned", authorization: "always" } },
    captured: { wall_rfc3339: iso, wall_unix_seconds: when / 1000, elapsed_seconds: n * 7.5 }, process_instance_id: INSTALL,
  } } };
}

function fixes() {
  const rows: ReturnType<typeof fix>[] = [];
  const stays: [string, string, { latitude: number; longitude: number }][] = [
    ["06:00:00", "09:00:00", HOME], ["09:10:00", "12:00:00", SPOT], ["12:10:00", "13:30:00", GYM], ["13:40:00", "15:00:00", HOME],
  ];
  stays.forEach(([from, to, point], index) => {
    for (let t = at(from); t < at(to); t += 120_000) rows.push(fix(t, point, 0));
    const next = stays[index + 1];
    if (next === undefined) return;
    for (let step = 0; step < 30; step++) {
      const share = step / 30;
      rows.push(fix(at(to) + step * 20_000, { latitude: point.latitude + (next[2].latitude - point.latitude) * share, longitude: point.longitude + (next[2].longitude - point.longitude) * share }, 9));
    }
  });
  return rows;
}

function track(stays: [number, number, { latitude: number; longitude: number }, number][]) {
  const rows: ReturnType<typeof fix>[] = [];
  stays.forEach(([from, to, point, step], index) => {
    for (let t = from; t < to; t += step) rows.push(fix(t, point, 0));
    const next = stays[index + 1];
    if (next === undefined) return;
    for (let leg = 0; leg < 30; leg++) {
      const share = leg / 30;
      rows.push(fix(to + leg * 20_000, { latitude: point.latitude + (next[2].latitude - point.latitude) * share, longitude: point.longitude + (next[2].longitude - point.longitude) * share }, 9));
    }
  });
  return rows;
}

function person(slug: string, name: string, phone: string, me = false) {
  return {
    kind: "person", key: slug, content: {
      type: "people.person", slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me,
      anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null,
    },
  };
}

describe("the owner's places through the door", () => {
  const roots: string[] = [];
  const homes: Home[] = [];
  const doors: { stop(): Promise<void> }[] = [];
  const report: Record<string, unknown> = {};

  async function stopAll(): Promise<void> {
    for (const door of doors.splice(0)) await door.stop();
    for (const home of homes.splice(0)) await home.stop();
  }

  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("1-8, 12, 13: an owner act is lost, doubled, refused, takes the bundle road or feeds a phone bundle, and a removed or old place names a day", async () => {
    try {
      const root = makeRoot("lifestream-places-", { sources: { [FIXES]: "fake-rows", [PLACES]: "places-home", [GOOGLE]: "google-place-names" }, settings: { unit: HOME_UNIT } });
      roots.push(root);
      mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES, GOOGLE], token: DASHBOARD, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root, { registry: REGISTRY });
      doors.push(door);
      const sock = testSocket(root);
      const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
      const day = () => readFileSync(join(root, "days", `${DAY}.day.txt`), "utf8");
      const head = (key: string) => readHome(root, (db) => db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'place' AND h.key = ?")
        .pluck().get(PLACES, key) as string | undefined);

      const pass = randomBytes(32).toString("base64url");
      const { code } = (await askHome(sock, "pair")) as { code: string };
      const paired = await request(door.url, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" },
        JSON.stringify({ code, pass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT }));
      expect(paired.status).toBe(200);
      const answer = paired.body.answer as { sources: Record<string, unknown>; owner: string[] };
      expect(answer.owner).toEqual([`devices:local:${HOME_UNIT}`, `people:local:${HOME_UNIT}`, PLACES]);
      expect(Object.keys(answer.sources)).not.toContain(PLACES);
      expect(Object.keys(answer.sources)).toContain(HEALTH);
      const dashboard = await request(door.url, "POST", "/v1/exchange", { authorization: `Bearer ${DASHBOARD}`, "content-type": "application/json" }, "{}");
      expect([dashboard.status, dashboard.body.code]).toEqual([403, "PRINCIPAL_SCOPE"]);
      const phone = { authorization: `Bearer ${pass}`, ...DEVICE.phone };
      const desk = { authorization: `Bearer ${DASHBOARD}` };
      const owner = (headers: Record<string, string>, action: Record<string, unknown>) => act(door.url, headers, action);

      const now = Date.now();
      await sayPlaces(root, now - 600_000, [
        { kind: "place", key: "home", content: place("Synthetic Home", HOME, 120) }, { kind: "place", key: "gym", content: place("Synthetic Gym", GYM, 100) },
      ]);
      const lookups = edit(GOOGLE, now - 600_000, [
        googleName("synthetic-place-s", "Synthetic Studio Annex", { latitude: 0, longitude: 0.01405 }), googleName("synthetic-place-g", "Synthetic Gym Hall", { latitude: 0.00945, longitude: 0.0135 }),
      ]);
      expect((await request(door.url, "PUT", lookups.path, desk, lookups.bytes)).status).toBe(201);
      await ship(root, { source: FIXES, fetched_ms: now, rows: fixes() });
      await until("the day rendered from the fixes and the places", () => existsSync(join(root, "days", `${DAY}.day.txt`)) && quiet() && day().includes("Synthetic Gym"));
      const before = day();
      expect(before).toMatch(/09:09–12:00 At an unnamed place 1\.0 km from Synthetic Gym\n/u);

      const naming = { kind: "create", request: "phone-names-the-studio", name: "Synthetic Studio", ...SPOT, radius_m: 150, ids: ["google:synthetic-place-s"] };
      const studio = await owner(phone, naming);
      expect(studio.status).toBe(200);
      const studioId = studio.body.id as string;
      expect(studioId).toMatch(/^place:synthetic-studio-[0-9a-f]{6}$/u);
      const studioSlug = studioId.slice("place:".length);
      expect(JSON.parse(head(studioSlug)!).content).toEqual(place("Synthetic Studio", SPOT, 150, ["google:synthetic-place-s"]));
      const sealed = JSON.parse(readFileSync(join(root, "inbox", PLACES, deliveryName(root, naming.request), "manifest.json"), "utf8")) as { custody?: unknown; facts: Record<string, unknown> };
      expect([sealed.custody, sealed.facts.device]).toEqual([undefined, paired.body.unit]);
      const bundle = phoneBundle({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [HEALTH]: { seal: 1 } } });
      expect((await request(door.url, "PUT", `/v1/bundles/${bundle.id}`, phone, bundle.bytes)).status).toBe(201);
      await until("the phone's edit and bundle imported", () => quiet() && count("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'", HEALTH) === 1);
      const fed = readHome(root, (db) => db.prepare("SELECT source FROM deliveries WHERE id = ? ORDER BY source").pluck().all(`phone:${paired.body.unit as string}/${bundle.id}`)) as string[];
      expect(fed).toContain(HEALTH);
      expect(fed).not.toContain(PLACES);
      expect(readHome(root, (db) => db.prepare("SELECT device FROM statements WHERE source = ? AND key = ?").pluck().all(PLACES, studioSlug))).toEqual([paired.body.unit]);
      expect(day()).toMatch(/At Synthetic Studio\n/u);

      const runs = () => count("SELECT count(*) FROM runs WHERE kind = 'import' AND subject LIKE ?", `${PLACES} %`);
      const ran = runs();
      const fromPhone = { kind: "edit", request: "phone-widens-the-gym", slug: "gym", radius_m: 150, was: { radius_m: 100 } };
      const [phoneSaid, deskSaid] = await Promise.all([owner(phone, fromPhone), owner(desk, { kind: "edit", request: "desk-renames-home", slug: "home", name: "Synthetic House", was: { name: "Synthetic Home" } })]);
      expect([phoneSaid.status, deskSaid.status]).toEqual([200, 200]);
      expect(runs()).toBe(ran + 2);
      expect(JSON.parse(head("home")!).content.name).toBe("Synthetic House");
      expect(JSON.parse(head("gym")!).content.radius_m).toBe(150);

      const statements = count("SELECT count(*) FROM statements WHERE source = ?", PLACES);
      const again = await owner(phone, fromPhone);
      expect(again).toEqual(phoneSaid);
      expect([count("SELECT count(*) FROM statements WHERE source = ?", PLACES), runs()]).toEqual([statements, ran + 2]);

      const refusedBad = await owner(phone, { kind: "edit", request: "phone-shrinks-the-gym", slug: "gym", radius_m: 5, was: { radius_m: 150 } });
      expect([refusedBad.status, refusedBad.body.code]).toEqual([422, "STATEMENTS_BAD"]);
      expect(refusedBad.body.message).toMatch(/statements\.ndjson line 1: radius_m must be 20 to 2000/u);
      expect([count("SELECT count(*) FROM statements WHERE source = ?", PLACES), runs()]).toEqual([statements, ran + 2]);

      expect((await owner(desk, { kind: "remove", request: "desk-removes-the-gym", slug: "gym" })).status).toBe(200);
      await ship(root, { source: "places:local:iphone-old-aa01", fetched_ms: now, rows: [{ kind: "place", key: "gym",
        content: { type: "places.place", slug: "gym", name: "Phone Gym", centre: { ...GYM }, radius_m: 150, retired: false } }] });
      await until("the removal rendered", () => quiet() && !day().includes("Synthetic Gym"));
      const after = day();
      expect(after).toMatch(/At an unnamed place 1\.0 km from Synthetic Studio\n/u);
      expect(after).not.toMatch(/Phone Gym/u);

      const read = await request(door.url, "GET", "/v1/places", phone);
      expect(read.status).toBe(200);
      expect((await request(door.url, "GET", "/v1/places", { ...phone, "if-none-match": read.etag! })).status).toBe(304);
      const records = await request(door.url, "GET", `/v1/records?source=${encodeURIComponent(PLACES)}&kind=place`, phone);
      expect(records.status).toBe(200);
      const { position: _position, ...listed } = read.body;
      const { position: _read, ...forReader } = (await request(door.url, "GET", "/v1/places", desk)).body;
      expect(forReader).toEqual(listed);
      const { day: listDay, day_until_ms, ...places } = listed as { day: string; day_until_ms: number } & Record<string, unknown>;
      expect(listDay).toBe(civilDay(day_until_ms - 1, readOpsSettings(root).day));
      expect(day_until_ms).toBeGreaterThan(now);
      expect(JSON.stringify(places)).not.toMatch(/"counting"/u);

      const text = JSON.stringify(places, null, 2).replaceAll(studioSlug, "studio-3f9a2c") + "\n";
      if (UPDATE) {
        writeFileSync(new URL(`${DAY}.day.txt`, GOLDEN), after);
        writeFileSync(new URL("places.json", GOLDEN), text);
      }
      expect(after).toBe(readFileSync(new URL(`${DAY}.day.txt`, GOLDEN), "utf8"));
      expect(text).toBe(readFileSync(new URL("places.json", GOLDEN), "utf8"));
      report.day = { before, after };
      report.places = places;

      const served = async () => {
        const out = [];
        for (const path of ["/v1/places", `/v1/where?from=${DAY}&to=${DAY}`]) {
          const answer = await request(door.url, "GET", path, desk);
          const { position: _at, ...body } = answer.body;
          out.push({ status: answer.status, body });
        }
        return out;
      };
      const current = await served();
      expect((current[0]!.body.places as { stays: number }[]).every((each) => each.stays > 0)).toBe(true);
      await home.stop();
      const rows = () => readHome(root, (db) => db.prepare("SELECT family, unit, reading, code, content, days, start_ms, end_ms FROM extracts WHERE family IN ('physical', 'labels') ORDER BY family, unit").all());
      const clean = rows();
      const raw = new Database(join(root, "home.db"));
      const bumped = raw.prepare("UPDATE extracts SET code = 'older' WHERE family IN ('physical', 'labels') AND rowid % 2 = 0").run().changes;
      const owed = raw.prepare("UPDATE cursors SET seq = (SELECT max(seq) FROM statements) WHERE name IN ('rebuild:physical', 'rebuild:labels')").run().changes;
      raw.close();
      expect(bumped).toBeGreaterThan(0);
      expect(owed).toBe(2);
      const older = await served();
      expect(older.map((answer) => answer.status)).toEqual([200, 200]);
      expect(older).toEqual(current);
      const released = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(released);
      await until("both walks published", () => quiet() && count("SELECT count(*) FROM cursors WHERE name IN ('rebuild:physical', 'rebuild:labels') AND seq > 0") === 0);
      expect(rows()).toEqual(clean);
      expect(await served()).toEqual(current);
      expect(count("SELECT count(*) FROM extracts_next")).toBe(0);
      report.older_code = { rows: bumped, places: older[0]!.body.places, where: older[1]!.body };

      const SEQ = { latitude: 0.03, longitude: -0.03 };
      const list = async () => (await request(door.url, "GET", "/v1/places", desk)).body as { counting?: true; places: { slug: string; name: string; counting?: true }[]; hidden: { key: string; counting?: true }[] };
      const seq = async () => (await list()).places.find((each) => each.slug === "seq-0f0f0f");
      const counted = (label: string) => until(`${label}: counted`, async () => quiet() && (await seq())?.counting === undefined);
      const statementsOf = (key: string) => count("SELECT count(*) FROM statements WHERE source = ? AND key = ?", PLACES, key);
      const seqPlace = (name: string) => [{ kind: "place", key: "seq-0f0f0f", content: place(name, SEQ, 60) }];
      const named = (name: string, request: string, was: string) => ({ kind: "edit", request, slug: "seq-0f0f0f", name, was: { name: was } });
      const said = async (headers: Record<string, string>, action: Record<string, unknown>) => {
        const answer = await act(door.url, headers, action);
        expect(answer.status, String(action.request)).toBe(200);
        return answer.body as { act: null; id: string; position: string };
      };
      const placesRuns = () => count("SELECT count(*) FROM runs WHERE kind = 'places'");
      const held = async (label: string, work: () => Promise<void>) => {
        await askHome(sock, "pause", ["kind:places", "--reason", `the test reads ${label} before a places run counts it`]);
        const ran = placesRuns();
        await work();
        expect(placesRuns(), label).toBe(ran);
        await askHome(sock, "resume", ["kind:places"]);
      };
      await sayPlaces(root, Date.now() - 10_000, seqPlace("Synthetic A"));
      await until("the first A imported", async () => (await seq())?.name === "Synthetic A");
      await counted("the first A");
      await said(desk, named("Synthetic Renamed", "seq-renamed", "Synthetic A"));
      expect((await seq())!.counting, "a rename counts nothing, run or no run").toBeUndefined();
      await said(desk, named("Synthetic A", "seq-renamed-back", "Synthetic Renamed"));
      expect((await seq())!.counting).toBeUndefined();
      await counted("a rename and a rename back, unheld");
      await held("a rename and a rename back", async () => {
        await said(desk, named("Synthetic B", "seq-b", "Synthetic A"));
        expect(await seq()).toMatchObject({ name: "Synthetic B" });
        expect((await seq())!.counting).toBeUndefined();
        await said(desk, named("Synthetic A", "seq-a", "Synthetic B"));
        expect((await seq())!.counting).toBeUndefined();
        expect((await seq())!.name).toBe("Synthetic A");
        await said(desk, { kind: "edit", request: "seq-widened", slug: "seq-0f0f0f", radius_m: 90, was: { radius_m: 60 } });
        expect([(await seq())!.counting, (await list()).counting], "a held places job says no counting it cannot end").toEqual([undefined, undefined]);
        await said(desk, { kind: "edit", request: "seq-narrowed", slug: "seq-0f0f0f", radius_m: 60, was: { radius_m: 90 } });
      });
      await counted("a rename and a rename back");
      const stated = statementsOf("seq-0f0f0f");
      await sayPlaces(root, Date.now() - 5_000, [...seqPlace("Synthetic B"), ...seqPlace("Synthetic A")]);
      await until("the cycle inside one delivery imported", () => quiet());
      expect([(await seq())?.name, statementsOf("seq-0f0f0f") - stated]).toEqual(["Synthetic A", 0]);
      await held("a hide and an unhide", async () => {
        const hidden = await said(desk, { kind: "hide", request: "seq-hide", latitude: -0.04, longitude: 0.04 });
        const key = hidden.id.slice("hidden:".length);
        expect((await list()).hidden.find((each) => each.key === key)).toEqual(expect.objectContaining({ key }));
        expect((await list()).hidden.find((each) => each.key === key)!.counting).toBeUndefined();
        await said(desk, { kind: "unhide", request: "seq-unhide", key });
        expect((await list()).hidden.map((each) => each.key)).not.toContain(key);
      });
      await said(desk, named("Synthetic Desk Word", "seq-desk", "Synthetic A"));
      expect((await seq())!.name).toBe("Synthetic Desk Word");
      await said(phone, named("Synthetic Phone Word", "seq-phone", "Synthetic Desk Word"));
      expect((await seq())!.name).toBe("Synthetic Phone Word");
      await counted("both passes");
      expect(count("SELECT count(*) FROM statements WHERE source = ? AND key = 'seq-0f0f0f' AND late = 1", PLACES)).toBe(0);
      const twice = named("Synthetic Twice", "seq-twice", "Synthetic Phone Word");
      expect(await said(desk, twice)).toEqual(await said(desk, twice));
      expect((await seq())!.name).toBe("Synthetic Twice");
      await counted("the act sent twice");
      const stood = statementsOf("seq-0f0f0f");
      const deliveries = count("SELECT count(*) FROM deliveries WHERE source = ?", PLACES);
      expect((await said(desk, named("Synthetic Twice", "seq-restated", "Synthetic Twice"))).act).toBeNull();
      expect([statementsOf("seq-0f0f0f"), count("SELECT count(*) FROM deliveries WHERE source = ?", PLACES), (await seq())?.name]).toEqual([stood, deliveries, "Synthetic Twice"]);
      await held("an edit", async () => {
        await said(desk, named("Synthetic Restated", "seq-restating", "Synthetic Twice"));
        expect(await seq()).toMatchObject({ name: "Synthetic Restated" });
        expect((await seq())!.counting).toBeUndefined();
      });
      await counted("an edit");
      expect((await said(desk, named("Synthetic Restated", "seq-restating-again", "Synthetic Restated"))).act).toBeNull();
      expect([(await seq())?.name, statementsOf("seq-0f0f0f") - stood]).toEqual(["Synthetic Restated", 1]);
      report.sequences = { statements: statementsOf("seq-0f0f0f") };
      artifact(root, "places", report);
    } finally {
      await stopAll();
    }
  });

  it("30-37, P1-P20: a place's page says the wrong rhythm, nights, home answer, circles, photos or people, pages its photos wrong, answers an unchanged page in full, or is read by a pass that only writes places; the prepared file lags, mixes or over-reads", async () => {
    try {
      const PEOPLE = `people:local:${HOME_UNIT}`;
      const FACES = `faces:local:${HOME_UNIT}`;
      const TAKEOUT = `google-photos:${ACCOUNT}:export`;
      const TAKEOUT_TWO = `google-photos:${ACCOUNT}:export-two`;
      const CAMERAS = `cameras:local:${HOME_UNIT}`;
      const root = makeRoot("lifestream-places-page-", {
        sources: { [FIXES]: "fake-rows", [PLACES]: "places-home", [PEOPLE]: "people-home", [FACES]: "faces-rows", [TAKEOUT_TWO]: "fake-rows", [TAKEOUT]: "fake-rows", [CAMERAS]: "cameras-rows" },
        settings: { unit: HOME_UNIT },
      });
      roots.push(root);
      mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES, PEOPLE], token: DASHBOARD, now_ms: Date.now() });
      const WRITER = "synthetic-token-places-writer".padEnd(43, "x");
      mintPrincipal(openHomeFolder(root), { unit: "places-writer-aa01", scopes: ["deliver"], sources: [PLACES], token: WRITER, now_ms: Date.now() });
      const { home, door } = await doorThenHome(root, { registry: REGISTRY, log: () => undefined }, { registry: REGISTRY });
      homes.push(home);
      doors.push(door);
      const desk = { authorization: `Bearer ${DASHBOARD}` };
      const said = async (action: Record<string, unknown>) => {
        const answer = await act(door.url, desk, action);
        expect(answer.status, String(action.request)).toBe(200);
        return answer.body as { act: null; id: string; position: string };
      };
      const get = (path: string, headers: Record<string, string> = {}) => request(door.url, "GET", path, { ...desk, ...headers });
      const computedYear = async (year: string, { from_ms, to_ms }: { from_ms: number; to_ms: number }): Promise<Record<string, unknown>> => {
        expect(from_ms).toBe(dayBounds(`${year}-01-01`, day).start_ms);
        const computed = await get(`/v1/where?from=${from_ms}&to=${to_ms}&grain=year`);
        expect(computed.status).toBe(200);
        const { position: _computedAt, ...body } = computed.body as { position: string } & Record<string, unknown>;
        return body;
      };
      const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;

      const day: DaySettings = { zone: "UTC", day_start_hour: 4 };
      const now = Date.now();
      const today = civilDay(now, day);
      const on = (back: number, clock: string, dates = 0) => Date.parse(`${addDays(today, dates - back)}T${clock}Z`);
      const MIN = 60_000;
      const FLAT = { latitude: 0.05, longitude: 0 };
      const QUARTER = { latitude: 0.02, longitude: 0.02 };
      const CAFE = { latitude: 0.02, longitude: 0.021 };
      const MUSEUM = { latitude: -0.03, longitude: 0.01 };
      const weekday = (back: number) => new Date(`${addDays(today, -back)}T00:00:00Z`).getUTCDay();
      const evenings = Array.from({ length: 21 }, (_, index) => 28 - index).filter((back) => weekday(back) === 2 || weekday(back) === 4);
      const saturday = Array.from({ length: 21 }, (_, index) => 28 - index).find((back) => weekday(back) === 6)!;
      const rows = [
        ...evenings.flatMap((back) => track([[on(back, "16:00:00"), on(back, "17:40:00"), HOME, 2 * MIN], [on(back, "17:50:00"), on(back, "20:00:00"), CAFE, 2 * MIN],
          [on(back, "20:10:00"), on(back, "07:00:00", 1), HOME, 10 * MIN]])),
        ...track([[on(saturday, "12:00:00"), on(saturday, "12:40:00"), HOME, 2 * MIN], [on(saturday, "12:50:00"), on(saturday, "15:00:00"), CAFE, 2 * MIN],
          [on(saturday, "15:10:00"), on(saturday, "16:00:00"), HOME, 2 * MIN]]),
        ...track([[on(5, "09:00:00"), on(5, "09:40:00"), HOME, 2 * MIN], [on(5, "09:50:00"), on(5, "11:30:00"), MUSEUM, 2 * MIN], [on(5, "11:40:00"), on(5, "12:30:00"), HOME, 2 * MIN]]),
        ...track([[on(4, "20:00:00"), on(4, "20:40:00"), HOME, 2 * MIN], [on(4, "20:50:00"), on(1, "08:00:00"), FLAT, 10 * MIN], [on(1, "08:10:00"), on(1, "03:30:00", 1), HOME, 10 * MIN]]),
      ];
      expect([evenings.length, rows.at(-1)!.at < now]).toEqual([6, true]);

      const photo = (name: string) => {
        const bytes = Buffer.from(`synthetic place photo ${name}`);
        return { bytes, hex: createHash("sha256").update(bytes).digest("hex") };
      };
      const last = evenings.at(-1)!, first = evenings[0]!;
      const homes65 = Array.from({ length: 65 }, (_, index): [string, number] => [`home-${index}`, on(1, "10:00:00") + index * 2 * MIN]);
      const shots: [string, number][] = [
        ["cafe-a", on(last, "18:30:00")], ["cafe-c", on(first, "18:45:00")], ["drive", on(last, "17:45:00")], ["cafe-end", on(last, "20:00:00")],
        ["flat-a", on(3, "12:00:00")], ["flat-b", on(2, "12:00:00")], ...homes65,
      ];
      const takeout: [string, number][] = [["cafe-b", on(last, "19:00:00")]];
      const carried = (list: [string, number][]) => Object.fromEntries(list.map(([name]) => [photo(name).hex, photo(name).bytes]));
      const asset = (hex: string, bytes: Buffer) => ({ hash: `sha256:${hex}`, bytes: bytes.length, media_type: "image/jpeg", role: "original" });
      const cameraOf = (list: [string, number][]) => list.map(([name]) => ({ kind: "photo", key: photo(name).hex, content: { type: "cameras.photo", camera: "synthetic/synthetic-model" } }));
      await ship(root, { source: CAMERAS, fetched_ms: now, rows: cameraOf(shots) });
      await ship(root, {
        source: TAKEOUT_TWO, fetched_ms: now, carried: carried(shots),
        rows: shots.map(([name, at]) => {
          const { hex, bytes } = photo(name);
          return { kind: "img", key: hex, at, blobs: [`sha256:${hex}`], content: { type: "photos.asset", title: `${name}.jpg`, blobs: [asset(hex, bytes)] } };
        }),
      });
      await ship(root, {
        source: TAKEOUT, fetched_ms: now, carried: carried(takeout),
        rows: takeout.map(([name, at]) => {
          const { hex, bytes } = photo(name);
          return { kind: "img", key: hex, at, blobs: [`sha256:${hex}`], content: { type: "photos.asset", blobs: [asset(hex, bytes)] } };
        }),
      });
      const BOX = [10, 10, 50, 50];
      const CROP = "c".repeat(64);
      const taken = new Map([...shots, ...takeout]);
      const named = (slug: string, names: string[]) => ({ kind: "named", key: slug, content: { labels: [], photos: names
        .map((name) => ({ face: `${photo(name).hex}:${BOX.join(",")}`, at_ms: taken.get(name)!, camera: true, crop: name === "cafe-a" ? CROP : null, tier: null, size: name === "cafe-a" ? 1_600 : 0 }))
        .sort((left, right) => right.at_ms - left.at_ms || (left.face < right.face ? -1 : 1)) } });
      const SCANNED = { width: 4032, height: 3024 };
      await ship(root, { source: FACES, fetched_ms: now, rows: [named("person-b", ["cafe-a", "cafe-c", "drive", "cafe-end", "flat-a", "flat-b"]), named("person-me", ["home-7"]),
        { kind: "scan", key: photo("cafe-a").hex, content: { pipeline: "0".repeat(64), status: "ok", ...SCANNED, faces: [{ box: BOX }], vectors: null } },
        { kind: "scan", key: photo("drive").hex, content: { pipeline: "0".repeat(64), status: "unreadable", width: null, height: null, faces: null, vectors: null } }] });
      await sayPeople(root, now - 700_000, [person("person-b", "Person B", "+15550000002"), person("person-me", "Person Me", "+15550000001", true)]);
      await sayPlaces(root, now - 600_000, [
        { kind: "place", key: "home", content: place("Synthetic Home", HOME, 120) }, { kind: "place", key: "flat-0a0a0a", content: place("Synthetic Flat", FLAT, 100) },
        { kind: "place", key: "quarter-0b0b0b", content: place("Synthetic Quarter", QUARTER, 1_000) }, { kind: "place", key: "cafe-0c0c0c", content: place("Synthetic Cafe", CAFE, 60) },
        { kind: "place", key: "museum-0d0d0d", content: place("Synthetic Museum", MUSEUM, 80) },
      ]);
      await ship(root, { source: FIXES, fetched_ms: now, rows });
      await until("the month landed, laid and rendered", () => quiet() && count("SELECT count(*) FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%'") > 0 &&
        count("SELECT count(*) FROM statements WHERE source = ?", PLACES) === 5);

      type Visit = { unit: string; start_ms: number; end_ms: number; day: string; focus: string; centre: { latitude: number; longitude: number }; people: string[] };
      type Page = Record<string, unknown> & { visits: Visit[]; photos: { image: string; at_ms: number }[]; people: { id: string; name: string; days: number; photo?: unknown }[] };
      const page = async (slug: string) => {
        const answer = await get(`/v1/places?slug=${slug}`);
        expect(answer.status, slug).toBe(200);
        return { etag: answer.etag!, place: answer.body.place as Page };
      };
      const listed = async () => (await get("/v1/places")).body.places as { slug: string; home?: boolean; ask_home: string | null }[];
      const report: Record<string, unknown> = { today };

      const cafe = await page("cafe-0c0c0c");
      const since = new Date(`${addDays(today, -Math.max(first, saturday))}T00:00:00Z`).toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
      expect(cafe.place.rhythm).toBe(`7 days here since ${since} · usually Tue and Thu`);
      const daily = Array.from({ length: 9 }, (_, index) => ({ start_ms: Date.parse(`${addDays("2026-03-02", index)}T10:00:00Z`), end_ms: Date.parse(`${addDays("2026-03-02", index)}T11:00:00Z`) }));
      expect(rhythm(daily, [], undefined, day)).toBe("9 days here since Mar 2026");
      expect([cafe.place.visits_count, cafe.place.nights, cafe.place.here, cafe.place.ask_home]).toEqual([7, 0, false, null]);
      expect([cafe.place.days, cafe.place.hours, cafe.place.first_ms, cafe.place.last_ms])
        .toEqual([7, Math.round(7 * 130 / 60 * 100) / 100, Math.min(on(first, "17:50:00"), on(saturday, "12:50:00")), on(last, "20:00:00")]);
      expect(cafe.place.visits.map((visit) => visit.day)).toEqual([...evenings, saturday].sort((left, right) => left - right).map((back) => addDays(today, -back)));
      expect(cafe.place.visits.every((visit) => visit.unit.startsWith(`stay/${FIXES}/`))).toBe(true);
      expect(cafe.place.visits[0]).toMatchObject({ start_ms: on(last, "17:50:00"), end_ms: on(last, "20:00:00") });
      expect(cafe.place.visits.map((visit) => visit.focus)).toEqual(cafe.place.visits.map((visit) => `u:${visit.unit}@${visit.start_ms}-${visit.end_ms}`));
      expect(cafe.place.visits.map((visit) => visit.centre)).toEqual(cafe.place.visits.map(() => ({ latitude: expect.closeTo(CAFE.latitude, 5), longitude: expect.closeTo(CAFE.longitude, 5) })));
      const museum = await page("museum-0d0d0d");
      expect([museum.place.visits_count, museum.place.rhythm, museum.place.visits.map((visit) => visit.day)]).toEqual([1, null, [addDays(today, -5)]]);

      const quarter = await page("quarter-0b0b0b");
      expect([cafe.place.part_of, cafe.place.inside]).toEqual([{ slug: "quarter-0b0b0b", name: "Synthetic Quarter" }, []]);
      expect([quarter.place.part_of, quarter.place.inside, quarter.place.visits_count]).toEqual([null, [{ slug: "cafe-0c0c0c", name: "Synthetic Cafe" }], 0]);

      expect(cafe.place.photos).toEqual([{ image: photo("cafe-a").hex, at_ms: on(last, "18:30:00") }, { image: photo("cafe-c").hex, at_ms: on(first, "18:45:00") }]);
      expect([cafe.place.photos_count, cafe.place.people]).toEqual([2, [{ id: "person:person-b", name: "Person B", days: 2, photo: { crop: CROP } }]]);
      const pictured = [last, first].map((back) => addDays(today, -back));
      expect(cafe.place.visits.map((visit) => visit.people)).toEqual(cafe.place.visits.map((visit) => pictured.includes(visit.day) ? ["person:person-b"] : []));

      const flat = await page("flat-0a0a0a");
      const why = `You've slept here 3 nights, since ${new Date(`${addDays(today, -4)}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })}.`;
      expect([flat.place.nights, flat.place.ask_home, flat.place.visits_count]).toEqual([3, why, 1]);
      expect((await listed()).find((each) => each.slug === "flat-0a0a0a")).toMatchObject({ ask_home: why });
      expect([flat.place.photos_count, flat.place.visits[0]!.people, flat.place.people])
        .toEqual([2, ["person:person-b"], [{ id: "person:person-b", name: "Person B", days: 2, photo: { crop: CROP } }]]);
      const before = await page("home");
      expect([before.place.here, before.place.people, before.place.photos_count, before.place.photos.length]).toEqual([true, [], 65, 4]);
      expect(before.place.rhythm).toMatch(/^\d+ days here since /u);
      report.before = { cafe: cafe.place, museum: museum.place, quarter: quarter.place, flat: flat.place, home: before.place };

      const preparedPlaces = preparedFileOf(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places"), "places");
      const cafeArea = (({ city, region, country }) => ({ city, region, country }))(areaOf(CAFE));
      const indexed = readPrepared(openHomeFolder(dirname(preparedPlaces)), preparedPlaces, PLACES_SHAPE.format, (read) => ({
        cafe: read.db.prepare("SELECT slug FROM photo WHERE image = ?").pluck().all(photo("cafe-a").hex),
        drive: read.db.prepare("SELECT slug FROM photo WHERE image = ?").pluck().all(photo("drive").hex),
        plan: (read.db.prepare("EXPLAIN QUERY PLAN SELECT slug FROM photo WHERE image = ?").all("") as { detail: string }[]).map((row) => row.detail).join(" "),
        head: read.value("head", "cafe-0c0c0c"),
      }))!.value;
      expect(indexed).toEqual({
        cafe: ["cafe-0c0c0c"], drive: [], plan: expect.stringContaining("photo_image"),
        head: { name: "Synthetic Cafe", latitude: CAFE.latitude, longitude: CAFE.longitude, radius_m: 60, area: cafeArea },
      });
      const cafePlace = { slug: "cafe-0c0c0c", name: "Synthetic Cafe", latitude: CAFE.latitude, longitude: CAFE.longitude, radius_m: 60, area: cafeArea };
      const personB = { id: "person:person-b", name: "Person B", me: false, box: BOX, photo: { crop: CROP } };
      const photoRead = async (name: string) => {
        const answer = await get(`/v1/photos/sha256:${photo(name).hex}`);
        return { status: answer.status, photo: answer.body.photo as Record<string, unknown> };
      };
      const viewedCafe = await get(`/v1/photos/sha256:${photo("cafe-a").hex}`);
      expect([viewedCafe.status, viewedCafe.body.photo]).toEqual([200, expect.objectContaining({ kind: "photograph", from: "google-photos", place: cafePlace, people: [personB], size: SCANNED })]);
      expect((await get(`/v1/photos/sha256:${photo("drive").hex}`)).body.photo).toMatchObject({ place: null, area: null, people: [{ ...personB, box: null }], size: null });

      for (const path of ["/v1/places?slug=nowhere-000000", "/v1/places/photos?slug=nowhere-000000"]) {
        const refused = await get(path);
        expect([refused.status, refused.body.code], path).toEqual([404, "PLACE_UNKNOWN"]);
      }
      const one = await get("/v1/places/photos?slug=home");
      const next = one.body.next as string;
      const two = await get(`/v1/places/photos?slug=home&after=${next}`);
      const paged = [...one.body.photos as { image: string }[], ...two.body.photos as { image: string }[]].map((each) => each.image);
      expect([(one.body.photos as unknown[]).length, (two.body.photos as unknown[]).length, two.body.next]).toEqual([60, 5, undefined]);
      expect(paged).toEqual(homes65.map(([name]) => photo(name).hex).reverse());
      expect(paged.slice(0, 4)).toEqual(before.place.photos.map((each) => each.image));
      const third = await get("/v1/places/photos?slug=home&at=24&limit=12");
      const end = await get("/v1/places/photos?slug=home&at=60&limit=12");
      expect([(third.body.photos as { image: string }[]).map((each) => each.image), third.body.total, (end.body.photos as unknown[]).length, end.body.total, end.body.next])
        .toEqual([paged.slice(24, 36), 65, 5, 65, undefined]);
      for (const path of ["/v1/places/photos?slug=home&at=1&after=" + next, "/v1/places/photos?slug=home&limit=0", "/v1/places/photos?slug=home&limit=121", "/v1/places/photos?slug=home&at=-1"]) {
        expect((await get(path)).status, path).toBe(422);
      }

      const writer = { authorization: `Bearer ${WRITER}` };
      const writes = await Promise.all(["/v1/places", "/v1/places?slug=home", "/v1/places/photos?slug=home"].map((path) => request(door.url, "GET", path, writer)));
      expect(writes.map((answer) => [answer.status, answer.body.code])).toEqual([[200, undefined], [403, "PRINCIPAL_SCOPE"], [403, "PRINCIPAL_SCOPE"]]);

      for (const [path, etag] of [["/v1/places?slug=cafe-0c0c0c", cafe.etag], ["/v1/places/photos?slug=home", one.etag!]] as const) {
        expect((await get(path, { "if-none-match": etag })).status, path).toBe(304);
      }

      await said({ kind: "edit", request: "page-flat-not-home", slug: "flat-0a0a0a", home: false, was: { home: null } });
      await said({ kind: "edit", request: "page-home-is-home", slug: "home", home: true, was: { home: null } });
      await until("the answers landed in the labels", () => quiet() &&
        (readHome(root, (db) => db.prepare("SELECT content FROM extracts WHERE family = 'labels' AND unit = 'places'").pluck().get() as string)).includes('"home":false'));
      const after = await listed();
      expect(after.filter((each) => each.slug === "flat-0a0a0a" || each.slug === "home").map(({ slug, home: answered, ask_home }) => ({ slug, home: answered, ask_home })))
        .toEqual([{ slug: "flat-0a0a0a", home: false, ask_home: null }, { slug: "home", home: true, ask_home: null }]);
      const answeredFlat = await page("flat-0a0a0a");
      const answeredHome = await page("home");
      expect([answeredFlat.place.home, answeredFlat.place.ask_home]).toEqual([false, null]);
      const nights = answeredHome.place.nights as number;
      expect(nights).toBeGreaterThan(1);
      expect([answeredHome.place.home, answeredHome.place.ask_home, answeredHome.place.rhythm])
        .toEqual([true, null, `Home · ${nights} nights since ${addDays(today, -Math.max(...evenings, saturday)).slice(0, 4)}`]);
      expect((await get("/v1/places?slug=cafe-0c0c0c", { "if-none-match": cafe.etag })).status).toBe(304);
      report.after = { flat: answeredFlat.place, home: { ...answeredHome.place, visits: answeredHome.place.visits.length, photos: answeredHome.place.photos.length } };
      report.photos_pages = { first: (one.body.photos as unknown[]).length, next, second: (two.body.photos as unknown[]).length };
      artifact(root, "places-page", report);

      const sock = testSocket(root);
      const dir = preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places");
      const file = preparedFileOf(dir, "places");
      type Counts = Record<string, number | string>;
      const placesRuns = () => readHome(root, (db) => (db.prepare("SELECT counts FROM runs WHERE kind = 'places' ORDER BY id").pluck().all() as string[]).map((text) => JSON.parse(text) as Counts));
      const announced = () => readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'places' ORDER BY seq").pluck().all() as string[]).map((text) => JSON.parse(text) as { position: string });
      const summed = (mark: number) => {
        const ran = placesRuns().slice(mark);
        const sum: Record<string, number> = {};
        for (const counts of ran) for (const [key, value] of Object.entries(counts)) if (typeof value === "number") sum[key] = (sum[key] ?? 0) + value;
        return { runs: ran.length, gates: ran.map((counts) => counts.gate), ...sum } as { runs: number; gates: (string | number | undefined)[] } & Record<string, number>;
      };
      const runsLog: Record<string, unknown> = {};
      const step = async (name: string, work: () => Promise<void>) => {
        const mark = placesRuns().length;
        await work();
        await until(`${name}: the home quiet`, quiet);
        const made = summed(mark);
        runsLog[name] = { ...made, each: placesRuns().slice(mark) };
        return made;
      };
      const runPlaces = async () => {
        const before = placesRuns().length;
        await askHome(sock, "run", ["places", "places"]);
        await until("a places run", () => quiet() && placesRuns().length > before);
      };
      const listing = (family: string, prefix: string) => {
        const rows = readHome(root, (db) => db.prepare("SELECT unit, reading, code, days FROM extracts WHERE family = ? AND unit >= ? ORDER BY unit").all(family, prefix)) as { unit: string; reading: string; code: string; days: string }[];
        const kept = rows.filter((row) => row.unit.startsWith(prefix));
        const days = new Map<string, string[]>();
        for (const row of kept) for (const each of JSON.parse(row.days) as string[]) days.set(each, [...days.get(each) ?? [], `${row.unit}\0${row.reading}\0${row.code}`]);
        return { keys: new Set(kept.map((row) => `${row.unit}\0${row.reading}\0${row.code}`)), days };
      };
      const moved = (before: ReturnType<typeof listing>, after: ReturnType<typeof listing>) => ({
        units: [...after.keys].filter((key) => !before.keys.has(key)).length,
        days: [...after.days].filter(([each, keys]) => JSON.stringify(keys.sort()) !== JSON.stringify((before.days.get(each) ?? []).sort())).length,
      });
      const list = async () => (await get("/v1/places")).body as { position: string; day: string; day_until_ms: number;
        here: { latitude: number; longitude: number; start_ms: number; end_ms: number; slug: string | null } | null;
        places: { slug: string; name: string; latitude: number; today_hours: number; counting?: true }[]; hidden: { key: string; hidden_ms: number; counting?: true }[] };
      const year = today.slice(0, 4);
      const yearPath = `/v1/where?from=${year}-01-01&to=${year}-12-31&grain=year`;

      const gzipped = await fetch(`${door.url}/v1/places`, { headers: { ...desk, "accept-encoding": "gzip" } });
      const zipped = await gzipped.json() as { position: string };
      expect([gzipped.status, gzipped.headers.get("content-encoding"), gzipped.headers.get("lifestream-position")]).toEqual([200, "gzip", zipped.position]);
      const unchanged = await fetch(`${door.url}/v1/places`, { headers: { ...desk, "if-none-match": gzipped.headers.get("etag")! } });
      expect([unchanged.status, await unchanged.text(), unchanged.headers.get("lifestream-position")]).toEqual([304, "", zipped.position]);

      const events = announced().length;
      const quietRun = await step("quiet", runPlaces);
      expect(quietRun).toMatchObject({ runs: 1, gates: ["unchanged"], units_read: 0, days_laid: 0, bursts_read: 0, memo_parsed: 0, rows: 0, written: 0, removed: 0 });
      expect(announced().length).toBe(events);

      const counted = await step("people's counts", async () => {
        await sayPeople(root, Date.now() - 2_000, [{ ...person("person-b", "Person B", "+15550000002"), content: { ...person("person-b", "Person B", "+15550000002").content, relationship: "friend" } }]);
        await until("the word landed", () => quiet() && count("SELECT count(*) FROM statements WHERE source = ?", PEOPLE) === 3);
      });
      expect(counted.gates.every((gate) => gate === "unchanged")).toBe(true);
      expect([counted.memo_parsed, counted.rows, announced().length]).toEqual([0, 0, events]);

      const museumTag = (await page("museum-0d0d0d")).etag;
      const renamed = await step("person renamed", async () => {
        await sayPeople(root, Date.now() - 1_000, [person("person-b", "Person Bee", "+15550000002")]);
        await until("the rename prepared", async () => quiet() && (await page("cafe-0c0c0c")).place.people[0]?.name === "Person Bee");
      });
      expect(renamed).toMatchObject({ units_read: 0, days_laid: 0, bursts_read: 0 });
      expect(renamed.people_looked_up).toBeGreaterThan(0);
      expect(announced().length).toBeGreaterThan(events);
      expect((await page("flat-0a0a0a")).place.people.map((each) => each.name)).toEqual(["Person Bee"]);
      expect((await get("/v1/places?slug=museum-0d0d0d", { "if-none-match": museumTag })).status).toBe(304);

      const listBefore = await list();
      expect(listBefore.here).toMatchObject({ slug: "home" });
      expect(listBefore.places.every((each) => each.today_hours === 0)).toBe(true);
      const physicalBefore = listing("physical", "");
      const reached = Date.now() - 2 * MIN;
      const delivered = await step("phone delivery", async () => {
        await ship(root, { source: FIXES, fetched_ms: Date.now(), rows: [fix(on(0, "03:40:00"), HOME, 0), fix(reached, HOME, 0)] });
        await until("the delivery prepared", async () => quiet() && (await list()).here?.end_ms === reached);
      });
      const physicalMoved = moved(physicalBefore, listing("physical", ""));
      expect(physicalMoved.units).toBeGreaterThan(0);
      expect(delivered).toMatchObject({ units_read: physicalMoved.units, days_laid: physicalMoved.days, bursts_read: 0 });
      const listAfter = await list();
      const todayStart = Date.parse(`${today}T04:00:00Z`);
      expect(listAfter.here).toMatchObject({ slug: "home", start_ms: listBefore.here!.start_ms, end_ms: reached });
      expect(listAfter.places.find((each) => each.slug === "home")!.today_hours).toBeCloseTo(Math.max(0, reached - todayStart) / 3_600_000, 2);

      const burstsBefore = listing("photos", "burst/");
      const listTag = (await get("/v1/places")).etag;
      const yearBefore = (await get(yearPath)).body as { to_ms: number };
      const latest = on(last, "19:30:00");
      const photographed = await step("one burst", async () => {
        await ship(root, { source: CAMERAS, fetched_ms: Date.now(), rows: cameraOf([["cafe-d", latest]]) });
        await ship(root, { source: TAKEOUT_TWO, fetched_ms: Date.now(), carried: carried([["cafe-d", latest]]), rows: [(() => {
          const { hex, bytes } = photo("cafe-d");
          return { kind: "img", key: hex, at: latest, blobs: [`sha256:${hex}`], content: { type: "photos.asset", title: "cafe-d.jpg", blobs: [asset(hex, bytes)] } };
        })()] });
        await until("the photo prepared", async () => quiet() && (await page("cafe-0c0c0c")).place.photos_count === 3);
      });
      expect(photographed).toMatchObject({ units_read: 0, days_laid: 0, bursts_read: moved(burstsBefore, listing("photos", "burst/")).units });
      expect((await page("cafe-0c0c0c")).place.photos.map((each) => each.image)).toEqual([photo("cafe-d").hex, photo("cafe-a").hex, photo("cafe-c").hex]);
      expect((await get("/v1/places", { "if-none-match": listTag! })).status).toBe(304);
      const yearAfter = await get(yearPath);
      const { position: _yearAt, ...yearMade } = yearAfter.body as { position: string; to_ms: number } & Record<string, unknown>;
      expect(yearMade.to_ms).toBeGreaterThan(yearBefore.to_ms);
      expect(yearMade).toEqual(await computedYear(year, yearMade as { from_ms: number; to_ms: number }));
      for (const member of ["zone", "day_start_hour"]) expect(yearMade).not.toHaveProperty(member);

      const days = listing("physical", "").days.size;
      let spot = "";
      const hid = await step("hide", async () => {
        spot = (await said({ kind: "hide", request: "page-hide", latitude: -0.05, longitude: -0.05 })).id.slice("hidden:".length);
        expect((await list()).hidden.map((each) => each.key)).toEqual([spot]);
      });
      expect((await list()).hidden).toEqual([expect.objectContaining({ key: spot, hidden_ms: expect.any(Number) })]);
      expect((await list()).hidden[0]!.counting).toBeUndefined();
      expect(hid).toMatchObject({ units_read: 0, days_laid: 0, bursts_read: 0 });
      const unhid = await step("unhide", async () => {
        await said({ kind: "unhide", request: "page-unhide", key: spot });
        expect((await list()).hidden).toEqual([]);
      });
      expect([(await list()).hidden, unhid.days_laid]).toEqual([[], 0]);

      for (const [centre, slug, was] of [[{ latitude: 0.01, longitude: 0 }, null, HOME], [HOME, "home", { latitude: 0.01, longitude: 0 }]] as const) {
        const moving = `page-home-at-${centre.latitude}`;
        const movedRun = await step(`home at ${centre.latitude}`, async () => {
          await said({ kind: "edit", request: moving, slug: "home", ...centre, was: { ...was } });
          expect((await list()).places.find((each) => each.slug === "home")!.latitude).toBe(centre.latitude);
        });
        expect([(await list()).here?.slug, movedRun.days_laid]).toEqual([slug, days]);
      }

      expect(JSON.stringify((await get(yearPath)).body)).toContain("Synthetic Museum");
      const rename = await step("place renamed", async () => {
        await said({ kind: "edit", request: "page-museum-renamed", slug: "museum-0d0d0d", name: "Synthetic Gallery", was: { name: "Synthetic Museum" } });
        await until("the rename prepared", async () => quiet() && (await page("museum-0d0d0d")).place.name === "Synthetic Gallery");
      });
      expect(rename).toMatchObject({ units_read: 0, days_laid: 0, bursts_read: 0 });
      expect(rename.years_made).toBeGreaterThan(0);
      const timers = ["wait_ms", "inputs_ms", "memo_ms", "lay_ms", "years_ms", "stitch_ms", "write_ms"];
      for (const counts of placesRuns()) for (const timer of timers) expect(counts[timer], `${timer} of ${JSON.stringify(counts)}`).toEqual(expect.any(Number));
      const prepared = await get(yearPath);
      const { position: yearAt, ...yearBody } = prepared.body as { position: string; to_ms: number } & Record<string, unknown>;
      expect([prepared.status, yearAt]).toEqual([200, readPrepared(openHomeFolder(root), file, PLACES_SHAPE.format, (read) => read.position)?.value]);
      expect(JSON.stringify(yearBody)).toContain("Synthetic Gallery");
      expect(JSON.stringify(yearBody)).not.toContain("Synthetic Museum");
      expect(yearBody).toEqual(await computedYear(year, yearBody as { from_ms: number; to_ms: number }));
      expect((await get(yearPath, { "if-none-match": prepared.etag! })).status).toBe(304);

      const whole = await list();
      const half = new Database(file);
      half.exec("BEGIN IMMEDIATE");
      half.prepare("UPDATE meta SET value = 'half' WHERE key = 'position'").run();
      half.prepare("DELETE FROM answer").run();
      const during = await get("/v1/places");
      half.exec("ROLLBACK");
      half.close();
      expect([during.status, during.body.position, during.body.places]).toEqual([200, whole.position, whole.places]);

      const lost = "1:1";
      const raw = new Database(file);
      raw.prepare("UPDATE meta SET value = ? WHERE key = 'changed'").run(lost);
      raw.close();
      await step("lost event", runPlaces);
      expect(announced().at(-1)).toEqual({ position: lost });
      const announcedOnce = announced().length;
      await step("lost event announced", runPlaces);
      expect(announced().length).toBe(announcedOnce);

      const stale = new Database(file);
      stale.prepare("UPDATE meta SET value = 'stale' WHERE key IN ('inputs', 'circles')").run();
      stale.close();
      expect(((await get("/v1/places")).body as { counting?: true }).counting, "the list counts by its circles alone").toBe(true);
      const announcedBefore = announced();
      const held = get("/v1/places?settled=1");
      const rewritten = await step("a run over stale inputs", runPlaces);
      expect(rewritten).toMatchObject({ runs: 1, gates: ["changed"] });
      expect(announced().length, "a run that wrote the file announces it").toBe(announcedBefore.length + 1);
      const settled = await held;
      expect([settled.status, (settled.body as { counting?: true }).counting], "a settled read held over it answers, woken by that event").toEqual([200, undefined]);

      for (const suffix of ["", "-wal", "-shm"]) rmSync(join(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "people"), `people.db${suffix}`), { force: true });
      await step("people's file gone", runPlaces);
      const alone = (await page("cafe-0c0c0c")).place;
      expect([alone.people, alone.visits.flatMap((visit) => visit.people)]).toEqual([[], []]);
      const unnamed = await photoRead("cafe-a");
      expect([unnamed.status, unnamed.photo.people, unnamed.photo.size, unnamed.photo.place]).toEqual([200, [], null, cafePlace]);

      const shut = new Database(file);
      shut.pragma("wal_checkpoint(TRUNCATE)");
      const rootPage = shut.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'place'").pluck().get() as number;
      const pageSize = shut.pragma("page_size", { simple: true }) as number;
      shut.close();
      const damagedBytes = readFileSync(file);
      damagedBytes.fill(0xa5, (rootPage - 1) * pageSize, rootPage * pageSize);
      writeFileSync(file, damagedBytes);
      const runsBefore = placesRuns().length;
      const hurt = await get("/v1/places?slug=home");
      expect([hurt.status, (hurt.body.place as { counting?: boolean } | undefined)?.counting], "a damaged file reads the definition from the heads, counting").toEqual([200, true]);
      await until("the damaged file written again whole", async () => quiet() && placesRuns().length > runsBefore && (await get("/v1/places?slug=home")).status === 200);
      expect(placesRuns().at(-1)!.gate).toBe("changed");

      const erasedHex = photo("cafe-d").hex;
      const erased = await step("erase", async () => {
        await askHome(sock, "erase", ["photos", `photo:${erasedHex}`, "--apply"]);
        await until("the erasure prepared", async () => quiet() && existsSync(file) && (await page("cafe-0c0c0c")).place.photos_count === 2);
      });
      expect(erased.units_read).toBeGreaterThan(0);
      const memo = new Database(join(dir, "memo.db"), { readonly: true });
      const spaces = memo.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'space:%'").pluck().all() as string[];
      expect(spaces.map((space) => memo.prepare(`SELECT count(*) FROM "${space}" WHERE value LIKE ?`).pluck().get(`%${erasedHex}%`))).toEqual(spaces.map(() => 0));
      memo.close();
      const placesFile = new Database(file, { readonly: true });
      expect(placesFile.prepare("SELECT count(*) FROM photo WHERE image = ?").pluck().get(erasedHex)).toBe(0);
      placesFile.close();
      for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      const placeless = await photoRead("cafe-a");
      expect([placeless.status, placeless.photo.place, placeless.photo.people]).toEqual([200, null, [{ ...personB, name: "Person Bee" }]]);
      await step("places made again", runPlaces);
      expect((await photoRead("cafe-a")).photo.place).toEqual(cafePlace);

      const firstPage = await get("/v1/places/photos?slug=home");
      expect((await get("/v1/places/photos?slug=home", { "if-none-match": firstPage.etag! })).status).toBe(304);
      await step("an older photo erased", async () => {
        await askHome(sock, "erase", ["photos", `photo:${photo("home-0").hex}`, "--apply"]);
        await until("the older erasure prepared", async () => quiet() && existsSync(file) && (await page("home")).place.photos_count === 64);
      });
      const again = await get("/v1/places/photos?slug=home", { "if-none-match": firstPage.etag! });
      expect([again.status, again.body.photos]).toEqual([200, firstPage.body.photos]);

      await step("place removed", async () => {
        await said({ kind: "remove", request: "page-cafe-removed", slug: "cafe-0c0c0c" });
        expect([(await get("/v1/places?slug=cafe-0c0c0c")).status, (await list()).places.map((each) => each.slug)]).toEqual([404, expect.not.arrayContaining(["cafe-0c0c0c"])]);
      });
      expect((await get("/v1/places/photos?slug=cafe-0c0c0c")).body.code).toBe("PLACE_UNKNOWN");
      const removedFile = new Database(file, { readonly: true });
      expect(removedFile.prepare("SELECT count(*) FROM photo WHERE slug = 'cafe-0c0c0c'").pluck().get()).toBe(0);
      removedFile.close();
      artifact(root, "places-runs", runsLog);
    } finally {
      await stopAll();
    }
  });

  it("P20: a delivery 20 days into a year does not make the year before again, or one 40 days in makes more than its own year and the current one", async () => {
    try {
      const root = makeRoot("lifestream-places-years-", { sources: { [FIXES]: "fake-rows" }, settings: { unit: HOME_UNIT } });
      roots.push(root);
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const count = (sql: string) => readHome(root, (db) => db.prepare(sql).pluck().get() as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
      const memoFile = join(preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places"), "memo.db");
      const yearKeys = () => {
        if (!existsSync(memoFile)) return new Map<string, string>();
        const memo = new Database(memoFile, { readonly: true });
        try {
          return new Map((memo.prepare('SELECT key FROM "space:years"').pluck().all() as string[]).map((key) => [key, key.slice(0, 4)]));
        } finally {
          memo.close();
        }
      };
      const made: Record<string, string[]> = {};
      const mornings = (dates: string[]) => track(dates.flatMap((date) => [
        [Date.parse(`${date}T09:00:00Z`), Date.parse(`${date}T11:00:00Z`), HOME, 120_000], [Date.parse(`${date}T11:20:00Z`), Date.parse(`${date}T13:00:00Z`), GYM, 120_000],
      ] as [number, number, { latitude: number; longitude: number }, number][]));
      const deliver = async (label: string, dates: string[]) => {
        const before = yearKeys();
        await ship(root, { source: FIXES, fetched_ms: Date.now(), rows: mornings(dates) });
        await until(`${label} prepared`, () => quiet() && [...yearKeys().keys()].some((key) => !before.has(key)));
        await until(`${label} settled`, quiet);
        made[label] = [...new Set([...yearKeys()].filter(([key]) => !before.has(key)).map(([, year]) => year))].sort();
        return made[label];
      };
      const current = new Date().getUTCFullYear();
      const [two, one] = [current - 2, current - 1];
      await deliver("base", [`${two}-12-10`, `${one}-01-05`, `${one}-02-03`, `${one}-03-01`]);
      expect(await deliver("20 days in", [`${one}-01-21`])).toEqual([String(two), String(one), String(current)]);
      expect(await deliver("40 days in", [`${one}-02-10`])).toEqual([String(one), String(current)]);
      artifact(root, "places-years", made);
    } finally {
      await stopAll();
    }
  });

  it("the dashboard's own pass reads only, so an owner edit there never saves, or a pass held from before is replaced or never given the owner's sources", async () => {
    try {
      const root = makeRoot("lifestream-places-dashboard-", { sources: { [PLACES]: "places-home" }, settings: { unit: HOME_UNIT } });
      roots.push(root);
      const dir = mkdtempSync(join(tmpdir(), "lifestream-places-dashboard-machine-"));
      roots.push(dir);
      const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir }, home: dir });
      const principals = openHomeFolder(root);
      const before = mintPrincipal(principals, { unit: DASHBOARD_UNIT, scopes: ["read"], now_ms: Date.now() });
      mkdirSync(join(dir, "dashboard"), { recursive: true });
      writeFileSync(join(dir, "dashboard", "door-token"), `${before.token}\n`, { mode: 0o600 });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, machine: at, log: () => undefined });
      homes.push(home);
      const token = readFileSync(join(dir, "dashboard", "door-token"), "utf8").trim();
      const pass = passOf(principals, token)!;
      expect(token).toBe(before.token);
      expect({ id: pass.id, scopes: pass.scopes, sources: [...pass.sources].sort() }).toEqual({
        id: before.principal.id, scopes: ["read", "deliver"], sources: [`ask:local:${HOME_UNIT}`, `devices:local:${HOME_UNIT}`, `people:local:${HOME_UNIT}`, PLACES],
      });
      const door = await doorHere(root, { registry: REGISTRY, machine: at });
      doors.push(door);
      const made = await act(door.url, { authorization: `Bearer ${token}` }, { kind: "create", request: "dashboard-names-home", name: "Synthetic Home", ...HOME, radius_m: 120 });
      expect(made.status).toBe(200);
      const slug = (made.body.id as string).slice("place:".length);
      expect(readHome(root, (db) => db.prepare("SELECT count(*) FROM statements WHERE source = ? AND key = ?").pluck().get(PLACES, slug) as number), "the dashboard's act is in the records when answered").toBe(1);
      report.dashboard_pass = { scopes: pass.scopes, sources: pass.sources, act: made.status };
    } finally {
      await stopAll();
    }
  });

  it("P12: a home with no stays answers other than an empty list, or a damaged or missing file other than its heads uncounted and no spots until a run, saying no counting while the places job is held, never \"being prepared\"", async () => {
    try {
      const root = makeRoot("lifestream-places-no-stays-", { sources: { [PLACES]: "places-home" }, settings: { unit: HOME_UNIT } });
      roots.push(root);
      const READER = "synthetic-token-places-reader".padEnd(43, "x");
      mintPrincipal(openHomeFolder(root), { unit: "places-reader-aa01", scopes: ["read"], token: READER, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root, { registry: REGISTRY });
      doors.push(door);

      const reader = { authorization: `Bearer ${READER}` };
      const quiet = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get()) === 0;
      const dir = preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places");
      await until("Places prepared", () => quiet() && existsSync(preparedFileOf(dir, "places")));
      const listed = await request(door.url, "GET", "/v1/places", reader);
      const { position: _position, day: _day, day_until_ms: _until, ...empty } = listed.body;
      expect(empty).toEqual({ here: null, places: [], spots: [], hidden: [] });
      expect((await request(door.url, "GET", "/v1/places", { ...reader, "if-none-match": listed.etag! })).status).toBe(304);

      await askHome(testSocket(root), "pause", ["kind:places", "--reason", "the test reads the places with no file to join"]);
      await sayPlaces(root, Date.now() - 1_000, [{ kind: "place", key: "home", content: place("Synthetic Home", HOME, 120) }]);
      await until("the place imported", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = 'place'").pluck().get(PLACES)) === 1);
      const file = preparedFileOf(dir, "places");
      const missing = { here: null, places: [{
        slug: "home", name: "Synthetic Home", ...HOME, radius_m: 120, also: [], ids: [], stays: 0, days: 0, hours: 0, longest_day_hours: 0, first_ms: null, last_ms: null,
        area: expect.any(Object), ask_home: null, today_hours: 0,
      }], spots: [], hidden: [] };
      for (const suffix of ["-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
      writeFileSync(file, Buffer.from("synthetic damage, no database".repeat(200)));
      const damagedAsk = await request(door.url, "GET", "/v1/places", reader);
      const { position: _damaged, day: _on, day_until_ms: _end, ...damagedList } = damagedAsk.body;
      expect([damagedAsk.status, damagedList]).toEqual([200, missing]);
      rmSync(dir, { recursive: true, force: true });
      const gone = await request(door.url, "GET", "/v1/places", reader);
      const { position: _gone, day: goneDay, day_until_ms: goneUntil, ...goneList } = gone.body as { day: string; day_until_ms: number } & Record<string, unknown>;
      expect([gone.status, goneList]).toEqual([200, missing]);
      expect(goneDay).toBe(civilDay(goneUntil - 1, readOpsSettings(root).day));
      const page = await request(door.url, "GET", "/v1/places?slug=home", reader);
      expect([page.status, (page.body.place as Record<string, unknown>).counting, (page.body.place as Record<string, unknown>).visits]).toEqual([200, undefined, []]);
      const photos = await request(door.url, "GET", "/v1/places/photos?slug=home", reader);
      const { position: _photos, ...photoPage } = photos.body;
      expect([photos.status, photoPage]).toEqual([200, { photos: [], total: 0 }]);
      expect((await request(door.url, "GET", "/v1/places/photos?slug=nowhere", reader)).body.code).toBe("PLACE_UNKNOWN");

      await askHome(testSocket(root), "resume", ["kind:places"]);
      await askHome(testSocket(root), "run", ["places", "places"]);
      await until("Places prepared again", async () => quiet() && existsSync(file));
      const counted = await request(door.url, "GET", "/v1/places", reader);
      const entries = counted.body.places as Record<string, unknown>[];
      expect([counted.body.counting, entries.map((each) => [each.slug, each.counting, each.stays])]).toEqual([undefined, [["home", undefined, 0]]]);
    } finally {
      await stopAll();
    }
  });

  it("N1-N6: a spot is keyed, witnessed, photographed or spanned wrong, a walk's photo makes one, or a place's other circle is not the place's", async () => {
    try {
      const TAKEOUT = `google-photos:${ACCOUNT}:export`;
      const TAKEOUT_TWO = `google-photos:${ACCOUNT}:export-two`;
      const CAMERAS = `cameras:local:${HOME_UNIT}`;
      const CAMERA = "synthetic/synthetic-model";
      const root = makeRoot("lifestream-places-naming-", {
        sources: { [FIXES]: "fake-rows", [PLACES]: "places-home", [TAKEOUT]: "fake-rows", [TAKEOUT_TWO]: "fake-rows", [CAMERAS]: "cameras-rows" },
        settings: { unit: HOME_UNIT },
      });
      roots.push(root);
      mintPrincipal(openHomeFolder(root), { unit: `dashboard-${HOME_UNIT}`, scopes: ["read", "deliver"], sources: [PLACES], token: DASHBOARD, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root, { registry: REGISTRY });
      doors.push(door);
      const desk = { authorization: `Bearer ${DASHBOARD}` };
      const get = (path: string) => request(door.url, "GET", path, desk);
      const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 &&
        count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0 && count("SELECT count(*) FROM dirty_days") === 0;
      const when = (date: string, clock: string) => Date.parse(`${date}T${clock}Z`);
      const MIN = 60_000;
      const B = { latitude: 0.01, longitude: 0 }, C = { latitude: 0, longitude: 0.02 }, A = { latitude: -0.02, longitude: 0 };
      const D = { latitude: 0.03, longitude: 0.03 }, E = { latitude: -0.01, longitude: -0.02 }, WALK = { latitude: 0, longitude: 0.01 };
      const away = (date: string, point: { latitude: number; longitude: number }, to = "13:00:00") =>
        track([[when(date, "09:00:00"), when(date, "10:50:00"), HOME, 10 * MIN], [when(date, "11:00:00"), when(date, to), point, 2 * MIN], [when(date, "14:00:00"), when(date, "15:00:00"), HOME, 10 * MIN]]);
      const rows = [
        ...away("2026-08-12", B, "12:20:00"),
        ...away("2026-07-07", C), ...away("2026-07-09", C, "12:20:00"), ...away("2026-07-14", C),
        ...away("2026-09-01", A), ...away("2026-09-15", E),
      ];
      await ship(root, { source: FIXES, fetched_ms: Date.now(), rows });

      const shot = (name: string) => {
        const bytes = Buffer.from(`synthetic naming photo ${name}`);
        return { bytes, hex: createHash("sha256").update(bytes).digest("hex") };
      };
      const taken: [string, number, { latitude: number; longitude: number }][] = [
        ["b-1", when("2024-03-05", "12:00:00"), B], ["b-2", when("2025-06-10", "12:00:00"), B], ["b-3", when("2026-08-12", "12:00:00"), B], ["b-4", when("2026-08-12", "12:20:00"), B],
        ["d-1", when("2025-02-03", "12:00:00"), D], ["d-2", when("2025-05-06", "12:00:00"), D], ["d-3", when("2025-09-09", "12:00:00"), D],
        ["e-1", when("2026-09-15", "12:00:00"), E], ["walk", when("2026-07-09", "12:25:00"), WALK],
      ];
      const takeout = (list: typeof taken) => list.map(([name, at]) => {
        const { hex, bytes } = shot(name);
        return { kind: "img", key: hex, at, blobs: [`sha256:${hex}`], content: { type: "photos.asset", title: `${name}.jpg`,
          blobs: [{ hash: `sha256:${hex}`, bytes: bytes.length, media_type: "image/jpeg", role: "original" }] } };
      });
      const carried = (list: typeof taken) => Object.fromEntries(list.map(([name]) => [shot(name).hex, shot(name).bytes]));
      await ship(root, { source: CAMERAS, fetched_ms: Date.now(), rows: [
        { kind: "camera", key: CAMERA, content: { type: "cameras.camera", make: "Synthetic", model: "Synthetic Model", photos: 60, first_ms: null, last_ms: null, sample: null, phones: [] } },
        ...taken.map(([name, , point]) => ({ kind: "photo", key: shot(name).hex, content: { type: "cameras.photo", camera: CAMERA, gps: { ...point } } })),
      ] });
      await ship(root, { source: TAKEOUT, fetched_ms: Date.now(), rows: takeout(taken), carried: carried(taken) });
      const twice = taken.filter(([name]) => name === "b-3");
      await ship(root, { source: TAKEOUT_TWO, fetched_ms: Date.now(), rows: takeout(twice), carried: carried(twice) });
      await sayPlaces(root, Date.now() - 60_000, [{ kind: "place", key: "harbour", content: place("Synthetic Harbour", HOME, 120) }]);
      type Listed = { latitude: number; longitude: number; worth: boolean; key?: string; witnessed?: string; last?: string | null; photos?: { image: string; at_ms: number }[]; photos_count?: number } & Record<string, unknown>;
      const list = async () => (await get("/v1/places")).body as { spots: Listed[]; places: ({ slug: string; also: unknown[] } & Record<string, unknown>)[] };
      const near = (spots: Listed[], point: { latitude: number; longitude: number }) => spots.filter((spot) => Math.hypot(spot.latitude - point.latitude, spot.longitude - point.longitude) < 0.0008);
      await until("the years landed, laid and listed", async () => quiet() && count("SELECT count(*) FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%'") > 0 &&
        near((await list()).spots, E).length === 1);
      const listed = await list();
      const report: Record<string, unknown> = { list: listed };
      const [b, c, a, d, e] = [B, C, A, D, E].map((point) => {
        const found = near(listed.spots, point);
        expect(found, JSON.stringify(point)).toHaveLength(1);
        return found[0]!;
      });

      for (const spot of [a!, b!, c!, d!, e!]) {
        expect(spot).toMatchObject({ worth: true, key: `spot:${spot.latitude},${spot.longitude}` });
        expect(["newest", "suggestions"].filter((member) => member in spot)).toEqual([]);
      }
      for (const spot of listed.spots.filter((each) => !each.worth)) expect(["key", "witnessed", "last", "photos", "photos_count"].filter((member) => member in spot)).toEqual([]);

      const time = String.raw`(at \d\d:\d\d|from \d\d:\d\d to \d\d:\d\d)`;
      expect(b!.witnessed).toMatch(/^You were here on 3 days between 2024 and 2026\. You took (a photo|\d+ photos) here\.$/u);
      expect(b!.last).toMatch(new RegExp(`^Last time Wed 12 Aug 2026 ${time}$`, "u"));
      expect(c!.witnessed).toBe("You were here on 3 days in Jul 2026.");
      expect(c!.last).toMatch(new RegExp(`^Last time Tue 14 Jul 2026 ${time}$`, "u"));
      expect(d!.witnessed).toMatch(/^You took (a photo|\d+ photos|photos) here on 3 days in 2025\.$/u);
      expect(d!.last).toMatch(new RegExp(`^Last time Tue 9 Sep 2025 ${time}$`, "u"));
      expect([a!.witnessed, a!.last]).toEqual([expect.stringMatching(new RegExp(`^You were here on Tue 1 Sep 2026 ${time}\\.$`, "u")), null]);
      expect([e!.witnessed, e!.last]).toEqual([expect.stringMatching(/^You were here on Tue 15 Sep 2026 .+\. You took (a photo|\d+ photos) here\.$/u), null]);

      const photosOf = (...names: string[]) => names.map((name) => ({ image: shot(name).hex, at_ms: taken.find(([each]) => each === name)![1] }));
      expect([b!.photos, b!.photos_count]).toEqual([photosOf("b-4", "b-3", "b-2", "b-1"), 4]);
      expect([d!.photos, d!.photos_count]).toEqual([photosOf("d-3", "d-2", "d-1"), 3]);
      expect([e!.photos, e!.photos_count]).toEqual([photosOf("e-1"), 1]);
      for (const spot of [a!, c!]) expect([spot.photos, spot.photos_count]).toEqual([[], 0]);

      await home.stop();
      const raw = new Database(join(root, "home.db"));
      const renamed = raw.prepare("UPDATE extracts SET unit = 'burst/unknown/' || substr(unit, 7) WHERE family = 'photos' AND unit LIKE 'burst/%'").run().changes;
      raw.prepare("UPDATE cursors SET fingerprint = 'older' WHERE name = 'extract:photos'").run();
      raw.close();
      expect(renamed).toBeGreaterThan(0);
      homes.push(await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: REGISTRY, log: () => undefined }));
      const named = () => readHome(root, (db) => db.prepare("SELECT unit FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%' ORDER BY unit").pluck().all()) as string[];
      await until("the photos family read again under its own names", async () => quiet() && count("SELECT count(*) FROM cursors WHERE name = 'rebuild:photos' AND seq > 0") === 0 &&
        named().length === renamed && named().every((unit) => /^burst\/\d+$/u.test(unit)));
      const relisted = await list();
      for (const [spot, point] of [[b!, B], [d!, D], [e!, E]] as const) expect(near(relisted.spots, point).map((each) => [each.photos, each.photos_count])).toEqual([[spot.photos, spot.photos_count]]);
      report.renamed = { bursts: renamed, units: named() };

      expect(near(listed.spots, WALK)).toEqual([]);

      const dir = preparedDirOf(root, process.env.LIFESTREAM_MACHINE_DIR!, "places");
      type Spans = { latitude: number; longitude: number; photos: boolean; spans: { start_ms: number; end_ms: number; by: string }[] };
      const spansOf = (key: string) => readPrepared(openHomeFolder(dirname(preparedFileOf(dir, "places"))), preparedFileOf(dir, "places"), PLACES_SHAPE.format, (read) => read.value<Spans>("spans", key))!.value;
      const dSpans = spansOf(d!.key!)!;
      expect(dSpans).toEqual({ latitude: d!.latitude, longitude: d!.longitude, photos: true,
        spans: photosOf("d-3", "d-2", "d-1").map(({ at_ms }) => ({ start_ms: at_ms, end_ms: at_ms, by: "Photos" })) });
      const bSpans = spansOf(b!.key!)!;
      expect(bSpans.photos).toBe(false);
      expect(bSpans.spans).toHaveLength(5);
      expect(bSpans.spans.filter((span) => span.by === "Phone")).toHaveLength(1);
      expect(bSpans.spans.some((span) => span.by === "Photos" && span.start_ms <= when("2026-08-12", "12:20:00") && span.end_ms >= when("2026-08-12", "12:20:00"))).toBe(true);
      expect(bSpans.spans.at(-1)).toEqual({ start_ms: when("2025-06-10", "12:00:00"), end_ms: when("2025-06-10", "12:00:00"), by: "Photos" });
      expect(bSpans.spans.map((span) => span.start_ms)).toEqual([...bSpans.spans.map((span) => span.start_ms)].sort((left, right) => right - left));
      expect(spansOf(c!.key!)!.spans.map((span) => span.by)).toEqual(["Phone", "Phone", "Phone"]);
      expect(spansOf("spot:0.5,0.5")).toBeUndefined();
      type Spotted = { unit: string; start_ms: number; end_ms: number; key: string };
      const spotted = readPrepared(openHomeFolder(dirname(preparedFileOf(dir, "places"))), preparedFileOf(dir, "places"), PLACES_SHAPE.format, (read) =>
        read.db.prepare("SELECT unit, start_ms, end_ms, key FROM spotted ORDER BY start_ms DESC, end_ms DESC").all() as Spotted[])!.value;
      const spanned = (key: string) => spotted.filter((row) => row.key === key).map(({ start_ms, end_ms }) => ({ start_ms, end_ms }));
      expect(spanned(d!.key!)).toEqual(dSpans.spans.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })));
      expect(spanned(b!.key!)).toHaveLength(6);
      expect(spanned(b!.key!).slice(0, 5)).toEqual(bSpans.spans.map(({ start_ms, end_ms }) => ({ start_ms, end_ms })));
      expect(spotted.filter((row) => row.key === c!.key).map((row) => row.unit.startsWith("stay/"))).toEqual([true, true, true]);
      expect(new Set(spotted.map((row) => row.key))).toEqual(new Set(listed.spots.filter((spot) => spot.worth).map((spot) => spot.key)));
      report.spotted = spotted;
      report.spans = { b: bSpans, d: dSpans };

      const text = await (await fetch(`${door.url}/v1/places`, { headers: desk })).text();
      artifact(root, "places-list-size", { raw_bytes: Buffer.byteLength(text), gzip_bytes: gzipSync(text).length, spots: listed.spots.length });

      const harbour = async () => (await get("/v1/places?slug=harbour")).body.place as { visits_count: number; visits: { day: string }[]; photos: { image: string }[]; also: unknown[] };
      const dayFile = (date: string) => readFileSync(join(root, "days", `${date}.day.txt`), "utf8");
      const before = { place: await harbour(), day: dayFile("2026-09-15") };
      expect(before.place.visits.some((visit) => visit.day === "2026-09-15")).toBe(true);
      const visitsBefore = before.place.visits_count;
      const circle = { centre: { latitude: e!.latitude, longitude: e!.longitude }, radius_m: 80 };
      expect((await act(door.url, desk, { kind: "add-circle", request: "harbour-circle", slug: "harbour", ...circle.centre, radius_m: circle.radius_m })).status).toBe(200);
      await until("the circle stands in the list", async () => quiet() && near((await list()).spots, E).length === 0);
      const added = await list();
      expect(added.places.find((each) => each.slug === "harbour")!.also).toEqual([{ ...circle.centre, radius_m: 80 }]);
      const withCircle = await harbour();
      expect(withCircle.also).toEqual([{ ...circle.centre, radius_m: 80 }]);
      expect(withCircle.visits_count).toBe(visitsBefore + 1);
      expect(withCircle.photos.map((photo) => photo.image)).toContain(shot("e-1").hex);
      expect(dayFile("2026-09-15")).toMatch(/11:\d\d–1[23]:\d\d At Synthetic Harbour/u);
      expect(before.day).not.toMatch(/11:\d\d–1[23]:\d\d At Synthetic Harbour/u);
      report.with_circle = { list: added, harbour: withCircle, day: dayFile("2026-09-15") };
      expect((await act(door.url, desk, { kind: "edit", request: "harbour-circle-undone", slug: "harbour", also: [], was: { also: [{ ...circle.centre, radius_m: 80 }] } })).status).toBe(200);
      await until("the spot listed again", async () => quiet() && near((await list()).spots, E).length === 1);
      const undone = await list();
      expect(near(undone.spots, E)).toEqual([e]);
      expect(undone.places.find((each) => each.slug === "harbour")!.also).toEqual([]);
      expect((await harbour()).visits_count).toBe(visitsBefore);
      expect(dayFile("2026-09-15")).toBe(before.day);
      artifact(root, "places-naming", report);
    } finally {
      await stopAll();
    }
  });
});
