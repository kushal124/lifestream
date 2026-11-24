import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { addDays, civilDay, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { googlePlaces } from "@lifestreamprotocol/connect";
import { placesKey } from "./registry-home.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { searchFileOf } from "./search-index.js";
import { ask, askHome } from "./socket.js";
import { makeRoot, makeVault, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const REGISTRY = fileURLToPath(new URL("./test/suggest-registry.ts", import.meta.url));
const UNIT = "macbook-pro-0001";
const PLACES = `places:local:${UNIT}`;
const PEOPLE = `people:local:${UNIT}`;
const ANSWERS = `google-places:${UNIT}:nearby`;
const FIXES = "location:local:iphone-fixes-aa01";
const ACCOUNT = "person-a@example.com";
const MAPS = `google-maps:${ACCOUNT}:export`;
const WHATSAPP = `whatsapp:+15550000001:${UNIT}`;
const MESSAGES = `imessage:+15550000001:${UNIT}`;
const CALENDAR = `apple-calendar:local:${UNIT}`;
const NOTES = `apple-notes:local:${UNIT}`;
const SCREEN = `screen:local:${UNIT}`;
const ASK = `ask:local:${UNIT}`;
const CHATGPT = `chatgpt:${ACCOUNT}:cloud`;
const AGENT = `claude-code:local:${UNIT}`;
const TOKEN = "synthetic-token-dashboard".padEnd(43, "x");
const KEY = "synthetic-google-key-0001";
const INSTALL = "11111111-1111-4111-8111-111111111111";
const MIN = 60_000;
const DAY_MS = 86_400_000;

type Point = { latitude: number; longitude: number };
const off = (from: Point, north: number, east = 0): Point => ({
  latitude: Math.round((from.latitude + north / 111_320) * 1e6) / 1e6,
  longitude: Math.round((from.longitude + east / (111_320 * Math.cos(from.latitude * Math.PI / 180))) * 1e6) / 1e6,
});
const FLAT = { latitude: 48.87, longitude: 2.36 };
const ROAD = { latitude: 48.73, longitude: 2.38 };
const MALL = { latitude: 48.86, longitude: 2.34 };
const HIDE = { latitude: 48.85, longitude: 2.3 };
const NEW = { latitude: 48.84, longitude: 2.32 };
const CAFE = { latitude: 48.845, longitude: 2.37 };
const GYM = off(MALL, 0, 100);
const PARK = { latitude: 48.95, longitude: 2.45 };
const PARK_OUT = off(PARK, 600);

const google = (id: string, name: string, at: Point, types: string[]) => ({ id, displayName: { text: name, languageCode: "en" }, location: { ...at }, types, primaryType: types[0] });

const RECORDED: [googlePlaces.Request, Point, number, ReturnType<typeof google>[]][] = [
  ["nearby", MALL, 150, [
    google("g-fabrica", "Fabrica, Grand Arcade", off(MALL, 30), ["clothing_store", "store"]),
    google("g-sweet", "Sweet Dreams | Grand Arcade", off(MALL, 40), ["dessert_shop", "food"]),
    google("g-harbour", "Harbour Cafe", off(MALL, 60), ["cafe", "food"]),
    google("g-bank", "Lakeshore Bank", off(MALL, 20), ["bank", "finance"]),
    google("g-flat21", "Building E, Flat 21", off(MALL, 10), ["premise"]),
    google("g-union", "Union Consultancy", off(MALL, 25), ["consultant"]),
    google("g-odile", "Odile Atelier", off(MALL, 70), ["clothing_store", "store"]),
    google("g-boulogne", "Boulogne Grill", off(MALL, 80), ["restaurant", "food"]),
    google("g-zephyrine", "Zephyrine Quillon Tailors", off(MALL, 90), ["tailor"]),
    google("g-bus", "Bus Stop Rue Neuve", off(MALL, 15), ["bus_stop", "transit_station"]),
    google("g-mirabelle", "Mirabelle Bistro", off(MALL, 120), ["restaurant", "food"]),
  ]],
  ["venues", MALL, 300, [google("g-clare", "Saint Clare Hospital", off(MALL, 250), ["hospital"])]],
  ["nearby", CAFE, 150, [
    google("g-olive", "Olive Terrace", off(CAFE, 50), ["restaurant"]), google("g-moon", "Moonlight Lounge", off(CAFE, 70), ["bar"]),
    google("g-pomona", "Pomona Bakery", off(CAFE, 30), ["bakery"]), google("g-velvet", "Velvet Cinema", off(CAFE, 90), ["movie_theater"]),
    google("g-quayside", "Quayside Books", off(CAFE, 40), ["book_store", "store"]), google("g-ristretto", "Ristretto Bar", off(CAFE, 110), ["bar"]),
  ]],
  ["venues", CAFE, 300, []],
  ["nearby", ROAD, 150, [
    google("g-terminal", "Terminal 2 Departures", off(ROAD, 40), ["establishment"]), google("g-relay", "Relay News Kiosk", off(ROAD, 60), ["store"]),
    google("g-p3", "Parking P3", off(ROAD, 30), ["parking"]),
  ]],
  ["venues", ROAD, 300, []],
  ["airport", ROAD, 5_000, [google("g-airport", "Northfield International Airport", off(ROAD, 3_000), ["international_airport", "airport"])]],
  ["nearby", FLAT, 150, [
    google("g-levain", "Levain Bakery", off(FLAT, 30), ["bakery"]), google("g-arlo", "Arlo Pharmacy", off(FLAT, 60), ["pharmacy"]),
    google("g-lumiere", "Hotel Lumiere", off(FLAT, 120), ["hotel", "lodging"]),
  ]],
  ["venues", FLAT, 300, []],
  ["nearby", PARK, 150, [
    google("g-linden", "Linden Pavilion", off(PARK, 30), ["park"]), google("g-cedar", "Cedar Kiosk", off(PARK, 40), ["store"]),
    google("g-juniper", "Juniper Hall", off(PARK, 120), ["event_venue"]), google("g-poplar", "Poplar Hall", off(PARK, 60), ["tourist_attraction"]),
    google("g-oak", "Oak Terrace Cafe", off(PARK, 0, 140), ["cafe"]),
  ]],
  ["venues", PARK, 300, []],
];

const predicted = (id: string, name: string, types: string[], distance_m?: number) => ({
  placePrediction: { placeId: id, text: { text: `${name}, Synthetic City` }, structuredFormat: { mainText: { text: name } }, types, ...(distance_m === undefined ? {} : { distanceMeters: distance_m }) },
});

const PREDICTIONS: Record<string, ReturnType<typeof predicted>[]> = {
  cedar: [predicted("g-cedar", "Cedar Kiosk", ["store"], 40), predicted("g-cedarlane", "Cedar Lane Bakery", ["bakery"])],
  hall: [predicted("g-elm", "Elm Hall", ["event_venue"], 500)],
  oak: [predicted("g-oak", "Oak Terrace Cafe", ["cafe"], 140)],
  garden: [predicted("g-linden", "Linden Garden Pavilion", ["park"], 200)],
  maple: [predicted("g-maple", "Maple Lodge", ["lodging"], 8_000)],
};

class FakeGoogle {
  readonly asked: { centre: Point; what: string; key: string | undefined; written: number }[] = [];
  readonly typed: { input: string; centre: Point; key: string | undefined; written: number }[] = [];
  lookups: (by: string) => number = () => 0;
  typing: "answer" | "refuse" | "down" = "answer";
  cut = 0;
  #server!: Server;
  url = "";

  async start(): Promise<void> {
    this.#server = createServer((request, response) => {
      let text = "";
      request.on("data", (chunk: Buffer) => (text += chunk.toString()));
      request.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          this.cut += 1;
          response.writeHead(400).end();
          return;
        }
        if (request.url === "/v1/places:autocomplete") {
          const typed = parsed as { input: string; locationBias: { circle: { center: Point } } };
          this.typed.push({ input: typed.input, centre: typed.locationBias.circle.center, key: request.headers["x-goog-api-key"] as string | undefined, written: this.lookups("places-search") });
          if (this.typing === "down") {
            request.socket.destroy();
            return;
          }
          if (this.typing === "refuse") {
            response.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: 403, message: "API key not valid.", status: "PERMISSION_DENIED" } }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ suggestions: PREDICTIONS[typed.input.toLowerCase()] ?? [] }));
          return;
        }
        const body = parsed as { includedTypes?: string[]; includedPrimaryTypes?: string[]; locationRestriction: { circle: { center: Point } } };
        const what = body.includedPrimaryTypes !== undefined ? "big" : body.includedTypes !== undefined ? "venues" : "nearby";
        this.asked.push({ centre: body.locationRestriction.circle.center, what, key: request.headers["x-goog-api-key"] as string | undefined, written: this.lookups("google-places") });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(what === "nearby" ? { places: [google("g-kettle", "Copper Kettle Tea Room", off(NEW, 20), ["tea_house"])] } : {}));
      });
    });
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    const closed = new Promise<void>((resolve) => this.#server.close(() => resolve()));
    this.#server.closeAllConnections();
    return closed;
  }
}

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

function track(stays: [number, number, Point, number][]) {
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

const person = (slug: string, name: string, phone: string, me = false) => ({
  kind: "person", key: slug, content: {
    type: "people.person", slug, name, full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me,
    anchor: { kind: "phone", value: phone }, handles: [], excluded: [], dismissed: [], merged_into: null,
  },
});

const place = (name: string, centre: Point, radius_m: number, home?: boolean, ids: string[] = []) => ({ type: "places.place", name, centre: { ...centre }, radius_m, ids, ...(home === undefined ? {} : { home }) });

describe("naming places, the home's side", () => {
  const fake = new FakeGoogle();
  const report: Record<string, unknown> = {};
  let root: string;
  let home: Home | undefined;
  let door: Door | undefined;
  let url: string;
  const settings: DaySettings = { zone: "UTC", day_start_hour: 4 };
  const now = Date.now();
  const D = addDays(civilDay(now, settings), -3);
  const on = (days: number, clock: string) => Date.parse(`${addDays(D, days)}T${clock}Z`);

  const auth = { authorization: `Bearer ${TOKEN}` };
  const get = async (path: string) => {
    const response = await fetch(`${url}${path}`, { headers: auth });
    const body = await response.json() as Record<string, any>;
    expect(response.status, `${path}: ${JSON.stringify(body)}`).toBe(200);
    return body;
  };
  const say = (made_ms: number, statements: unknown[]) => shipFiles(root, PLACES, made_ms, { "statements.ndjson": Buffer.from(statements.map((line) => `${JSON.stringify(line)}\n`).join("")) });
  const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
  const quiet = () => {
    if (count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") > 0 || count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") > 0 ||
      count("SELECT count(*) FROM dirty_days") > 0) return false;
    let indexed: number;
    try {
      const index = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true });
      try {
        indexed = (JSON.parse(index.prepare("SELECT value FROM meta WHERE key = 'position'").pluck().get() as string) as { seq: number }).seq;
      } finally {
        index.close();
      }
    } catch {
      return false;
    }
    return indexed === count("SELECT coalesce(max(seq), 0) FROM statements");
  };
  const dayText = () => readFileSync(join(root, "days", `${D}.day.txt`), "utf8");
  type Suggested = { name: string; id?: string; slug?: string; distance_m: number | null; why?: { product: string; family: string | null; at_ms: number; tier: number } };
  type Provider = { name: string; need: { words: string; act: { do: "set"; label: string; connector: string; member: string } } | null };
  const ANSWERED: Provider = { name: "Google Places", need: null };
  const NO_KEY: Provider = { name: "Google Places", need: { words: "Names from Google Places come once Lifestream holds a key",
    act: { do: "set", label: "Add key", connector: "google-places", member: "key" } } };
  const REFUSED: Provider = { name: "Google Places", need: { words: "Your Google Places key was refused",
    act: { do: "set", label: "Change key", connector: "google-places", member: "key" } } };
  const asked = async (name: string, query: string) => {
    const body = await get(`/v1/places/suggest?${query}`);
    const list = body.suggestions as Suggested[];
    expect(body.google, name).toBeUndefined();
    (report.lists as Record<string, unknown>)[name] = { ...(body.provider === undefined ? {} : { provider: body.provider }),
      suggestions: list.map((each) => ({ ...each, ...(each.why === undefined ? {} : { why: { ...each.why, at: new Date(each.why.at_ms).toISOString() } }) })) };
    return { list, provider: body.provider as Provider | undefined };
  };
  const suggest = async (name: string, point: Point, from_ms: number, to_ms: number) =>
    (await asked(name, `latitude=${point.latitude}&longitude=${point.longitude}&from_ms=${from_ms}&to_ms=${to_ms}`)).list;
  const listed = async () => (await get("/v1/places")) as { places: { slug: string; name: string; home?: boolean; ask_home: string | null; stays: number }[];
    spots: (Point & { worth: boolean; ask_home: string | null; key: string; witnessed: string })[]; hidden: { key: string; latitude: number; longitude: number; hidden_ms: number; days: number; nearest: unknown }[] };
  const near = (left: Point, right: Point) => Math.abs(left.latitude - right.latitude) < 0.0005 && Math.abs(left.longitude - right.longitude) < 0.0005;

  beforeAll(async () => {
    await fake.start();
    report.lists = {};
    root = makeRoot("lifestream-suggest-", {
      sources: {
        [FIXES]: "fake-rows", [PLACES]: "places-home", [PEOPLE]: "people-home", [ANSWERS]: "google-places",
        ...Object.fromEntries([MAPS, WHATSAPP, MESSAGES, CALENDAR, NOTES, SCREEN, ASK, CHATGPT, AGENT].map((source) => [source, "said-rows"])),
      },
      settings: { unit: UNIT },
    });
    writeFileSync(join(root, "fake-google.txt"), fake.url);
    fake.lookups = (by) => {
      const ledger = new Database(join(root, "replies", "replies.db"), { readonly: true });
      try {
        return ledger.prepare("SELECT count(*) FROM outbound WHERE what = 'lookup' AND by = ?").pluck().get(by) as number;
      } finally {
        ledger.close();
      }
    };
    mintPrincipal(openHomeFolder(root), { unit: `dashboard-${UNIT}`, scopes: ["read", "deliver"], sources: [PLACES, PEOPLE], token: TOKEN, now_ms: now });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: REGISTRY, log: () => undefined });
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: REGISTRY });
    url = `http://127.0.0.1:${door.port}`;

    await shipFiles(root, PEOPLE, now - 700_000, { "statements.ndjson": Buffer.from([person("person-odile", "Odile Varennes", "+15550000002"), person("person-me", "Person Me", "+15550000001", true)]
      .map((line) => `${JSON.stringify(line)}\n`).join("")) });
    await say(now - 600_000, [
      { kind: "place", key: "krux-gym-0a0a0a", content: place("Krux Gym", GYM, 50) },
      { kind: "place", key: "juniper-1b1b1b", content: place("Juniper Hall", off(PARK, 120), 30) },
      { kind: "place", key: "willow-2c2c2c", content: place("Willow Hall", off(PARK, -100), 20) },
      { kind: "place", key: "oak-3d3d3d", content: place("Oak Terrace", off(PARK, 0, 140), 20, undefined, ["google:g-oak"]) },
      { kind: "place", key: "birch-4e4e4e", content: place("Birch Studio", off(PARK, 0, -120), 20) },
      { kind: "place", key: "birch-5f5f5f", content: place("Birch Studio", off(PARK, 6_000), 50) },
      { kind: "place", key: "rowan-6a6a6a", content: place("Rowan Cottage", off(PARK, 8_000), 50, undefined, ["google:g-maple"]) },
    ]);
    const asked = now - DAY_MS;
    await shipFiles(root, ANSWERS, asked, {
      [googlePlaces.ANSWERS_FILE]: Buffer.from(RECORDED.map(([request, point, radius, places]) =>
        `${JSON.stringify({ at_ms: asked, content: { type: googlePlaces.ANSWER_TYPE, ...(places.length === 0 ? {} : { places }) }, key: googlePlaces.answerKey(request, point.latitude, point.longitude, radius), kind: "answer" })}\n`).join("")),
    });
    const said = (source: string, kind: string, key: string, at: number, content: Record<string, unknown>) => ({ source, row: { kind, key, at, content } });
    const records = [
      said(MAPS, "search", "m1", on(0, "08:00:00"), { type: "google.activity", title: "Searched for Atelier Nord", titleUrl: `https://www.google.com/maps/place/Atelier+Nord/@${off(MALL, 50).latitude},${off(MALL, 50).longitude},17z` }),
      said(MAPS, "search", "m2", on(0, "11:50:00"), { type: "google.activity", title: "Searched for Harbour Cafe" }),
      said(MESSAGES, "msg", "bank-1", on(0, "12:00:00"), { text: "Lakeshore Bank: your account balance is low. Visit any Lakeshore Bank branch." }),
      said(WHATSAPP, "msg", "w1", on(0, "13:00:00"), { text: "we spent an hour at sweet dreams" }),
      said(NOTES, "note", "n1", on(0, "13:10:00"), { text: "zephyrine was closed" }),
      said(WHATSAPP, "msg", "w2", on(0, "13:20:00"), { text: "the union meeting ran long" }),
      said(WHATSAPP, "msg", "w3", on(0, "13:25:00"), { text: "say hi to odile" }),
      said(WHATSAPP, "msg", "w4", on(0, "13:30:00"), { text: "boulogne traffic is bad" }),
      said(SCREEN, "frame", "s1", on(0, "13:05:00"), { text: "Mirabelle Bistro menu and opening hours" }),
      said(ASK, "msg", "a1", on(0, "13:06:00"), { text: "is Mirabelle Bistro any good" }),
      said(AGENT, "agent-turn", "t1", on(0, "13:07:00"), { text: "looked up mirabelle bistro" }),
      said(CHATGPT, "msg", "c1", on(0, "13:08:00"), { title: "Lifestream test", text: "Mirabelle Bistro is a fixture of the lifestream suggester" }),
      said(MAPS, "search", "m3", on(0, "13:00:00"), { type: "google.activity", title: "Searched for Quayside Books" }),
      said(MAPS, "directions", "m4", on(0, "17:30:00"), { type: "google.activity", title: "Directions to Velvet Cinema" }),
      said(MESSAGES, "msg", "pay-1", on(0, "17:50:00"), { text: "Rs 120 debited from a/c XX01 to POMONA BAKERY on 01-10-26. Not you? Call us." }),
      said(CALENDAR, "event", "e1", on(0, "18:30:00"), { title: "Dinner at Olive Terrace, then Moonlight Lounge" }),
      said(MAPS, "directions", "m5", on(0, "19:10:00"), { type: "google.activity", title: "Directions to Ristretto Bar" }),
      said(MAPS, "search", "p1", on(-4, "09:55:00"), { type: "google.activity", title: "Searched for Linden Pavilion" }),
      said(MAPS, "search", "p2", on(-4, "13:30:00"), { type: "google.activity", title: "Searched for Cedar Kiosk" }),
      said(MAPS, "search", "p3", on(-6, "05:00:00"), { type: "google.activity", title: "Searched for Juniper Hall" }),
      said(MAPS, "search", "p4", on(-12, "09:30:00"), { type: "google.activity", title: "Searched for Poplar Hall" }),
    ];
    for (const source of new Set(records.map((each) => each.source))) {
      await ship(root, { source, fetched_ms: now + sequence++, rows: records.filter((each) => each.source === source).map((each) => each.row) as never });
    }
    await ship(root, { source: FIXES, fetched_ms: now, rows: [
      ...track([
        [on(-1, "22:00:00"), on(0, "07:00:00"), FLAT, 10 * MIN], [on(0, "08:30:00"), on(0, "10:00:00"), ROAD, 2 * MIN],
        [on(0, "12:30:00"), on(0, "13:45:00"), MALL, 2 * MIN], [on(0, "14:30:00"), on(0, "15:45:00"), HIDE, 2 * MIN],
        [on(0, "16:00:00"), on(0, "17:10:00"), NEW, 2 * MIN], [on(0, "18:00:00"), on(0, "19:30:00"), CAFE, 2 * MIN],
        [on(0, "22:30:00"), on(1, "08:00:00"), FLAT, 10 * MIN],
      ]),
      ...track([[on(1, "22:00:00"), on(2, "08:00:00"), FLAT, 10 * MIN]]),
      ...track([[on(-4, "10:00:00"), on(-4, "11:00:00"), PARK, 2 * MIN], [on(-4, "11:10:00"), on(-4, "11:30:00"), PARK_OUT, 2 * MIN]]),
      ...[-4, -6, -8, -9, -12].flatMap((back, index) => track([
        [on(back, back === -4 ? "13:00:00" : "10:00:00"), on(back, back === -4 ? "14:00:00" : "11:00:00"), PARK, 2 * MIN],
        [on(back, back === -4 ? "14:10:00" : "11:10:00"), on(back, back === -4 ? "14:30:00" : "11:30:00"), off(PARK, -600 - 400 * index), 2 * MIN],
      ])),
    ] });
    await until("the day landed, laid, rendered and indexed", () => quiet() && count("SELECT count(*) FROM heads WHERE source = ?", ANSWERS) === RECORDED.length);
  });

  afterAll(async () => {
    await door?.close();
    await home?.stop().catch(() => undefined);
    await fake.stop();
    report.requests = fake.asked;
    report.cut = fake.cut;
    const kept = join(REPO, "packages", "home", ".build", "e2e");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "suggest.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`suggest artifact: ${join(kept, "suggest.json")}\n`);
    if (root !== undefined) removeRoot(root);
  });

  it("S1-S6: the suggester orders by the night, the evidence, then the fit, and never by a plain word, a name, an area, a bank's alert or the system's own words", async () => {
    const mall = await suggest("mall, lunch", MALL, on(0, "12:30:00"), on(0, "13:45:00"));
    expect(mall.map((each) => each.name)).toEqual([
      "Harbour Cafe", "Atelier Nord", "Sweet Dreams | Grand Arcade", "Zephyrine Quillon Tailors",
      "Krux Gym",
      "Boulogne Grill", "Mirabelle Bistro", "Grand Arcade", "Saint Clare Hospital",
      "Lakeshore Bank", "Fabrica, Grand Arcade", "Odile Atelier", "Bus Stop Rue Neuve", "Union Consultancy",
    ]);
    expect(mall.find((each) => each.name === "Krux Gym")).toMatchObject({ slug: "krux-gym-0a0a0a", distance_m: 100 });
    const why = (list: typeof mall, name: string) => list.find((each) => each.name === name)?.why;
    expect(why(mall, "Harbour Cafe")).toEqual({ product: "Google Maps", family: "maps", at_ms: on(0, "11:50:00"), tier: 3 });
    expect(why(mall, "Atelier Nord")).toEqual({ product: "Google Maps", family: "maps", at_ms: on(0, "08:00:00"), tier: 3 });
    expect(why(mall, "Sweet Dreams | Grand Arcade")).toEqual({ product: "WhatsApp", family: "messages", at_ms: on(0, "13:00:00"), tier: 2 });
    expect(why(mall, "Zephyrine Quillon Tailors")).toEqual({ product: "Notes", family: "notes", at_ms: on(0, "13:10:00"), tier: 1 });
    for (const name of ["Lakeshore Bank", "Union Consultancy", "Odile Atelier", "Boulogne Grill", "Mirabelle Bistro"]) expect(why(mall, name), name).toBeUndefined();
    expect(mall.find((each) => each.name === "Harbour Cafe")).toMatchObject({ id: "google:g-harbour", distance_m: 60 });
    expect(mall.some((each) => each.name.startsWith("Building E"))).toBe(false);

    const cafe = await suggest("café street, dinner", CAFE, on(0, "18:00:00"), on(0, "19:30:00"));
    expect(cafe.map((each) => [each.name, each.why?.tier, each.why?.product, each.why?.family])).toEqual([
      ["Pomona Bakery", 3, "iMessage", "messages"], ["Velvet Cinema", 3, "Google Maps", "maps"], ["Olive Terrace", 3, "Calendar", "calendar"],
      ["Moonlight Lounge", 3, "Calendar", "calendar"], ["Quayside Books", 3, "Google Maps", "maps"], ["Ristretto Bar", 1, "Google Maps", "maps"],
    ]);

    const road = await suggest("airport road, morning", ROAD, on(0, "08:30:00"), on(0, "10:00:00"));
    expect(road.map((each) => each.name)).toEqual(["Northfield International Airport", "Relay News Kiosk", "Parking P3", "Terminal 2 Departures"]);
    expect(road[0]!.id).toBe("google:g-airport");
    expect(Math.abs(road[0]!.distance_m! - 3_000)).toBeLessThan(10);

    const flat = await suggest("flat, night", FLAT, on(0, "22:30:00"), on(1, "08:00:00"));
    expect(flat.map((each) => each.name)).toEqual(["Hotel Lumiere", "Levain Bakery", "Arlo Pharmacy"]);
    expect(flat[0]!.why).toBeUndefined();

    for (const list of [mall, cafe, road, flat]) {
      expect(list.length).toBeLessThanOrEqual(16);
      expect(list.every((each) => each.why === undefined || !each.why.product.includes(":"))).toBe(true);
    }
    const drifted = await suggest("mall, asked 60 m off its centre", off(MALL, 60), on(0, "12:30:00"), on(0, "13:45:00"));
    expect(drifted.find((each) => each.name === "Harbour Cafe")).toMatchObject({ id: "google:g-harbour", distance_m: 0 });
    const whole = await get(`/v1/places/suggest?latitude=${MALL.latitude}&longitude=${MALL.longitude}&from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&limit=500`);
    expect((whole.suggestions as { name: string }[]).map((each) => each.name)).toEqual(mall.map((each) => each.name));
    const two = await get(`/v1/places/suggest?latitude=${MALL.latitude}&longitude=${MALL.longitude}&from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&limit=2`);
    expect((two.suggestions as { name: string }[]).map((each) => each.name)).toEqual(mall.slice(0, 2).map((each) => each.name));
    const refused = async (query: string) => {
      const response = await fetch(`${url}/v1/places/suggest?latitude=${MALL.latitude}&longitude=${MALL.longitude}&${query}`, { headers: auth });
      return { status: response.status, body: await response.json() as { code: string; message: string } };
    };
    for (const [query, words] of [
      [`from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&limit=0`, "limit must be a whole number from 1 to 500"],
      [`from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&limit=501`, "limit must be a whole number from 1 to 500"],
      [`from_ms=${on(0, "13:45:00")}&to_ms=${on(0, "12:30:00")}`, "to_ms is before from_ms"],
    ]) {
      const { status, body } = await refused(query!);
      expect([status, body.code, body.message], query).toEqual([422, "BAD_PARAMETER", words]);
    }
    const typed = await asked("mall, typed with no key", `latitude=${MALL.latitude}&longitude=${MALL.longitude}&from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&q=harbour`);
    expect([typed.provider, typed.list.map((each) => each.name), fake.typed]).toEqual([NO_KEY, ["Harbour Cafe"], []]);
    const first = await asked("mall, first ask with no key", `latitude=${MALL.latitude}&longitude=${MALL.longitude}&from_ms=${on(0, "12:30:00")}&to_ms=${on(0, "13:45:00")}&q=`);
    expect([first.provider, first.list.map((each) => each.name), fake.typed]).toEqual([NO_KEY, mall.map((each) => each.name), []]);
  });

  it("H1, L1, A1: a hidden spot leaves the places and To name and is back after Unhide; Google is asked only what is owed, with a key; a spot slept at three nights asks Is this home?, and a Yes ends it", async () => {
    const before = await listed();
    const spotAt = (answer: typeof before, point: Point) => answer.spots.find((spot) => near(spot, point));
    const weekday = new Date(`${addDays(D, -1)}T00:00:00Z`).toLocaleString("en-US", { weekday: "long", timeZone: "UTC" });
    expect(spotAt(before, FLAT)).toMatchObject({ worth: true, ask_home: `You've slept here 3 nights, since ${weekday}.` });
    expect(spotAt(before, MALL)!.ask_home).toBeNull();
    const unhidden = spotAt(before, HIDE)!;
    expect(unhidden).toMatchObject({ worth: true, key: `spot:${unhidden.latitude},${unhidden.longitude}`, witnessed: expect.stringMatching(/^You were here on \w{3} \d+ \w{3} \d{4} from \d\d:\d\d to \d\d:\d\d\.$/u) });
    expect(before.hidden).toEqual([]);
    const toName = (answer: typeof before) => answer.spots.filter((spot) => spot.worth).length;
    const count0 = toName(before);
    const day0 = dayText();
    const etag0 = (await fetch(`${url}/v1/places`, { headers: auth })).headers.get("etag")!;
    const since = async (etag: string) => {
      const response = await fetch(`${url}/v1/places`, { headers: { ...auth, "if-none-match": etag } });
      await response.arrayBuffer();
      return { status: response.status, etag: response.headers.get("etag")! };
    };
    expect((await since(etag0)).status).toBe(304);
    const unnamed = (text: string) => new Set([...text.matchAll(/an unnamed place [\d.]+ km from [A-Z][a-z]+(?: [A-Z][a-z]+)*/gu)].map((match) => match[0]));
    expect(day0).not.toContain("a hidden place");
    expect(fake.asked).toEqual([]);

    const hidden_ms = Date.now() - 1_000;
    const { latitude, longitude } = spotAt(before, HIDE)!;
    await say(hidden_ms, [{ kind: "hidden", key: "hidden-1a2b3c", content: { type: "places.hidden", centre: { latitude, longitude }, radius_m: 80 } }]);
    await until("the hidden spot landed", () => quiet() && count("SELECT count(*) FROM heads WHERE source = ? AND kind = 'hidden'", PLACES) === 1);
    const hid = await listed();
    expect(spotAt(hid, HIDE)).toBeUndefined();
    expect(toName(hid)).toBe(count0 - 1);
    expect(hid.hidden).toEqual([{ key: "hidden-1a2b3c", latitude, longitude, hidden_ms, days: 1, nearest: { slug: "krux-gym-0a0a0a", name: "Krux Gym", distance_m: expect.any(Number) } }]);
    const hiddenTag = await since(etag0);
    expect(hiddenTag.status).toBe(200);
    const dayHidden = dayText();
    expect(dayHidden).toContain("a hidden place");
    const told = [...unnamed(day0)].filter((words) => !unnamed(dayHidden).has(words));
    expect(told).toHaveLength(1);
    expect([...unnamed(dayHidden)].every((words) => unnamed(day0).has(words))).toBe(true);
    report.hidden = hid.hidden;
    report.days = { told: told[0], hidden: dayHidden.split("\n").filter((line) => line.includes("a hidden place")) };

    await makeVault(root);
    await ask(testSocket(root), { verb: "seal", secret: placesKey({ connectors: {} }), value: KEY });
    const flatSpot = spotAt(hid, FLAT)!;
    await say(Date.now() - 500, [{ kind: "place", key: "home-4d5e6f", content: place("Home", { latitude: flatSpot.latitude, longitude: flatSpot.longitude }, 80, true) }]);
    await until("the labeler asked Google about the new spot and its answers landed", () => fake.asked.length >= 2 && quiet() && count("SELECT count(*) FROM heads WHERE source = ?", ANSWERS) === RECORDED.length + 2);
    expect(fake.asked.map(({ centre, what, key }) => [what, near(centre, NEW), key])).toEqual([["nearby", true, KEY], ["venues", true, KEY]]);
    expect(fake.asked.map(({ written }) => written)).toEqual([1, 2]);
    const named = await listed();
    expect(named.places.find((each) => each.slug === "home-4d5e6f")).toMatchObject({ name: "Home", home: true, ask_home: null, stays: 2 });
    expect(spotAt(named, FLAT)).toBeUndefined();
    const fresh = await suggest("new spot, from Google's answer", NEW, on(0, "16:00:00"), on(0, "17:10:00"));
    expect(fresh[0]).toMatchObject({ name: "Copper Kettle Tea Room", id: "google:g-kettle" });

    const etag1 = (await fetch(`${url}/v1/places`, { headers: auth })).headers.get("etag")!;
    await say(Date.now() - 100, [{ kind: "hidden", key: "hidden-1a2b3c", gone: true }]);
    await until("the unhidden spot was asked about", () => fake.asked.length >= 4 && quiet());
    expect(fake.asked.slice(2).map(({ centre, what }) => [what, near(centre, HIDE)])).toEqual([["nearby", true], ["venues", true]]);
    const back = await listed();
    expect(spotAt(back, HIDE)).toMatchObject({ worth: true });
    expect(back.hidden).toEqual([]);
    expect((await since(etag1)).status).toBe(200);
    expect(dayText()).not.toContain("a hidden place");
    expect(dayText()).toContain(told[0]);
    report.places = { before: before.spots.length, hidden: hid.spots.length, back: back.spots.length, home: named.places };
  });

  it("T1, T2: a spot is asked over its newest five spans, a record once for the nearer; the typed search asks Google only with words, a key and no refusal, and ranks its names with the person's own", async () => {
    const park = (await listed()).spots.find((spot) => near(spot, PARK))!;
    expect(park).toMatchObject({ worth: true, key: `spot:${park.latitude},${park.longitude}`, witnessed: expect.stringMatching(/^You were here on 5 days /u) });
    const spot = `spot=${encodeURIComponent(park.key)}`;
    const shown = (list: Suggested[]) => list.map(({ name, slug, why }) => [name, slug ?? null, why?.at_ms ?? null]);
    const whole = await asked("park, its five spans", spot);
    expect(whole.provider).toBeUndefined();
    expect(shown(whole.list)).toEqual([
      ["Linden Pavilion", null, on(-4, "09:55:00")], ["Cedar Kiosk", null, on(-4, "13:30:00")], ["Juniper Hall", "juniper-1b1b1b", on(-6, "05:00:00")],
      ["Willow Hall", "willow-2c2c2c", null], ["Birch Studio", "birch-4e4e4e", null], ["Oak Terrace", "oak-3d3d3d", null], ["Poplar Hall", null, null],
    ]);
    const unknown = await fetch(`${url}/v1/places/suggest?spot=${encodeURIComponent("spot:1.5,1.5")}`, { headers: auth });
    expect([unknown.status, ((await unknown.json()) as { code: string }).code]).toEqual([404, "SPOT_UNKNOWN"]);
    const both = await fetch(`${url}/v1/places/suggest?${spot}&latitude=1&longitude=1&from_ms=1&to_ms=2`, { headers: auth });
    expect(both.status).toBe(422);
    const searchedFrom = Date.now();
    const empty = await asked("park, first ask", `${spot}&q=`);
    expect([empty.provider, shown(empty.list), fake.typed]).toEqual([ANSWERED, shown(whole.list), []]);
    const gone = await fetch(`${url}/v1/places/suggest?spot=${encodeURIComponent("spot:1.5,1.5")}&q=cedar`, { headers: auth });
    expect([gone.status, fake.typed]).toEqual([404, []]);

    const cedar = await asked("park, typed cedar", `${spot}&q=cedar`);
    expect(cedar.provider).toEqual(ANSWERED);
    expect(cedar.list).toEqual([
      { name: "Cedar Lane Bakery", id: "google:g-cedarlane", distance_m: null, why: expect.objectContaining({ at_ms: on(-4, "13:30:00"), tier: 3 }) },
      { name: "Cedar Kiosk", id: "google:g-cedar", distance_m: 40, why: expect.objectContaining({ at_ms: on(-4, "13:30:00"), tier: 3 }) },
    ]);
    expect(fake.typed.map(({ input, centre, key }) => [input, near(centre, PARK), key])).toEqual([["cedar", true, KEY]]);
    expect(fake.typed.map(({ written }) => written)).toEqual([1]);
    const search = new Database(join(root, "replies", "replies.db"), { readonly: true });
    try {
      expect(search.prepare("SELECT receiver, route, what, tool, level, counts, chars, pictures, key FROM outbound WHERE by = 'places-search'").all()).toEqual([
        { receiver: "Google", route: null, what: "lookup", tool: "autocomplete", level: "none", counts: '{"place":1}', chars: 5, pictures: 0, key: null },
      ]);
    } finally {
      search.close();
    }
    const hall = await asked("park, typed hall", `${spot}&q=hall`);
    expect(shown(hall.list)).toEqual([["Juniper Hall", "juniper-1b1b1b", on(-6, "05:00:00")], ["Willow Hall", "willow-2c2c2c", null], ["Poplar Hall", null, null], ["Elm Hall", null, null]]);
    const birch = await asked("park, typed birch", `${spot}&q=birch`);
    expect(birch.list.map(({ name, slug }) => [name, slug])).toEqual([["Birch Studio", "birch-4e4e4e"], ["Birch Studio", "birch-5f5f5f"]]);
    const oak = await asked("park, typed oak", `${spot}&q=oak`);
    expect(oak.list.map(({ name, slug }) => [name, slug])).toEqual([["Oak Terrace", "oak-3d3d3d"]]);
    const garden = await asked("park, typed garden", `${spot}&q=garden`);
    expect(garden.list.map(({ name, id }) => [name, id])).toEqual([["Linden Pavilion", "google:g-linden"]]);
    const maple = await asked("park, typed maple", `${spot}&q=maple`);
    expect(maple.list).toEqual([{ name: "Rowan Cottage", slug: "rowan-6a6a6a", distance_m: expect.any(Number) }]);
    expect(Math.abs(maple.list[0]!.distance_m! - 8_000)).toBeLessThan(100);
    const asks = fake.typed.length;
    const writtenBefore = fake.lookups("places-search");
    expect((await asked("park, typed one character", `${spot}&q=c`)).provider).toEqual(ANSWERED);
    expect(fake.typed.length).toBe(asks);
    expect(fake.lookups("places-search")).toBe(writtenBefore);
    expect((await fetch(`${url}/v1/places/suggest?${spot}&q=${"a".repeat(101)}`, { headers: auth })).status).toBe(422);

    fake.typing = "down";
    const down = await asked("park, Google unreachable", `${spot}&q=cedar`);
    expect([down.provider, down.list.map((each) => each.name)]).toEqual([ANSWERED, ["Cedar Kiosk"]]);

    fake.typing = "refuse";
    const refusedAt = fake.typed.length;
    expect((await asked("park, the key refused", `${spot}&q=cedar`)).provider).toEqual(REFUSED);
    expect((await asked("park, the key refused, again", `${spot}&q=hall`)).provider).toEqual(REFUSED);
    expect(fake.typed.length).toBe(refusedAt + 1);
    const lookups = fake.asked.length;
    const sent = Date.now();
    await ship(root, { source: FIXES, fetched_ms: Date.now(), rows: track([[on(-2, "10:00:00"), on(-2, "12:00:00"), off(PARK, -3_000), 2 * MIN]]) });
    await until("the labeler ran after the new spot", () => quiet() &&
      count("SELECT count(*) FROM cursors WHERE name = 'label:google-places' AND at_ms >= ?", sent) === 1);
    expect(fake.asked.length).toBe(lookups);
    fake.typing = "answer";
    await ask(testSocket(root), { verb: "seal", secret: placesKey({ connectors: {} }), value: `${KEY}-2` });
    expect((await asked("park, a new key", `${spot}&q=cedar`)).provider).toEqual(ANSWERED);
    expect(fake.typed.at(-1)!.key).toBe(`${KEY}-2`);
    const logged = ((await ask(testSocket(root), { verb: "vault" })) as { requests: { at_ms: number; task: string; lane: string; ok: boolean }[] }).requests
      .filter((each) => each.task === "places-search" && each.at_ms >= searchedFrom);
    expect(logged.map(({ lane, ok }) => [lane, ok])).toEqual([["door", true], ["door", false], ["door", true]]);
    await askHome(testSocket(root), "connectors", ["set", "google-places", "key", "google-places-other"]);
    await ask(testSocket(root), { verb: "seal", secret: "google-places-other", value: `${KEY}-3` });
    expect((await asked("park, the key named anew", `${spot}&q=cedar`)).provider).toEqual(ANSWERED);
    expect(fake.typed.at(-1)!.key).toBe(`${KEY}-3`);
    report.typed = fake.typed;
  });
});
