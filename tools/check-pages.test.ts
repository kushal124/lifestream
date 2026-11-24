import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkPages, labelsFit, LISTS, owedByLane, owedLine, RELAYS, runPagesCheck, swiftParams, type Lists } from "./check-pages.js";

const roots: string[] = [];
const NONE: Lists = { pages: ["/v1/page/people"], allowed: [], owed: [], standIns: [], relays: [] };
const LIFE = "dashboard/lib/life.mjs";
const READS = "homelink/Sources/HomeLink/Reads.swift";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "check-pages-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), source);
  }
  return root;
}

const found = (root: string, lists: Lists = NONE) => checkPages(root, lists).map((finding) => `${finding.rule} ${finding.file}:${finding.line} ${finding.detail.split(": ")[0]}`);

const FORMS: readonly (readonly [form: string, file: string, line: string, route: string])[] = [
  ["a JavaScript literal in single quotes", LIFE, "return reach().json('/v1/conversation', { chat, day });", "/v1/conversation"],
  ["a JavaScript literal in double quotes", "dashboard/public/lib/api.js", "fetch(\"/v1/people\")", "/v1/people"],
  ["a route held in a constant", LIFE, "const PEOPLE_ROUTE = '/v1/people';", "/v1/people"],
  ["a template with a segment", LIFE, "reach().text(`/v1/days/${day}`, known?.etag)", "/v1/days/"],
  ["a template with a query", LIFE, "reach().stream(`/v1/pictures/${hash}?${query}`)", "/v1/pictures/"],
  ["a template on the door's address", "dashboard/lib/door.mjs", "const response = await fetch(`${url}/v1/feed`, {", "/v1/feed"],
  ["a Swift literal and a concatenation", READS, "guard let response = try await get(\"/v1/days/\" + path) else { return nil }", "/v1/days/"],
  ["a Swift interpolation", READS, "try await read(\"/v1/outbound/\\(seq)\")", "/v1/outbound/"],
  ["a Swift interpolation of the address", "homelink/Sources/HomeLink/Link.swift", "let url = URL(string: \"\\(address)/v1/where\")", "/v1/where"],
  ["a route key with its method", "homelink/Sources/HomeLink/HomeLink.swift", "\"GET /v1/places/suggest\": Relay(again: false, wait: 5),", "/v1/places/suggest"],
  ["a route key with a placeholder", "homelink/Sources/HomeLink/HomeLink.swift", "route: \"PUT /v1/bundles/<id>\", lands: true", "/v1/bundles/"],
  ["a path relative to the door", "macos-app/Sources/Lifestream/Setup/SetupStart.swift", "guard let url = door?.appendingPathComponent(\"v1/status\"),", "/v1/status"],
  ["a whole URL", "ios-app/LifestreamCapture/Life/Probe.swift", "let query = URL(string: \"https://home.invalid/v1/search?\" + parts[1])", "/v1/search"],
];

describe("the pages check", () => {
  it.each(FORMS)("catches %s, naming the route and its line", (_form, file, line, route) => {
    const root = tree({ [file]: `import x\n\n${line}\n` });
    expect(found(root)).toEqual([`refused ${file}:3 ${route}`]);
  });

  it("takes no path that is not a door path: a model's address, a ref, base64", () => {
    const root = tree({
      "dashboard/public/ui/connectors/settings-models.js": "field('Address', 'http://127.0.0.1:11434/v1')\n",
      "dashboard/public/kit-gallery-llm.js": "const HEARD = { item: 'whatsapp:synthetic/msg/v1' };\nconst still = 'AAgICA9w0QIEDgUgEBf+/v1/nFOhYBAgQEvG';\n",
    });
    expect(found(root)).toEqual([]);
  });

  it("passes a route in PAGES, and a route on the allowed list as it is or under a prefix that ends in a slash", () => {
    const root = tree({ [READS]: "read(\"/v1/page/people\")\nread(\"/v1/clock\")\nread(\"/v1/blobs/\" + hash)\nread(\"/v1/blobs/held\")\nread(\"/v1/clocks\")\n" });
    const lists: Lists = { ...NONE, allowed: [{ route: "/v1/clock", reason: "the clock" }, { route: "/v1/blobs/", reason: "bytes" }] };
    expect(found(root, lists)).toEqual([`refused ${READS}:5 /v1/clocks`]);
  });

  it("passes an owed read in its own file and refuses the same raw read in a new file, even under an allowed prefix", () => {
    const fresh = "dashboard/lib/digest.mjs";
    const root = tree({ [LIFE]: "reach().json('/v1/agents/waiting')\n", [fresh]: "\n\nreach().json('/v1/agents/waiting')\n" });
    const lists: Lists = { ...NONE, allowed: [{ route: "/v1/agents/", reason: "access" }], owed: [{ file: LIFE, route: "/v1/agents/waiting", lane: "streams" }] };
    expect(checkPages(root, lists)).toEqual([{ file: fresh, line: 3, rule: "owed elsewhere", detail: expect.stringContaining("/v1/agents/waiting: a raw read lane streams still owes") }]);
  });

  it("refuses an owed file's second raw route", () => {
    const root = tree({ [LIFE]: "reach().json('/v1/people')\nreach().json('/v1/places')\n" });
    const lists: Lists = { ...NONE, owed: [{ file: LIFE, route: "/v1/people", lane: "people" }] };
    expect(found(root, lists)).toEqual([`refused ${LIFE}:2 /v1/places`]);
  });

  it("says when an owed entry, an allowed entry or a stand-in finds nothing", () => {
    const canned = "ios-app/LifestreamCapture/Life/CannedHome.swift";
    const root = tree({ [LIFE]: "reach().json('/v1/clock')\n", [canned]: "let silent = true\n" });
    const lists: Lists = {
      ...NONE,
      allowed: [{ route: "/v1/clock", reason: "the clock" }, { route: "/v1/feed", reason: "the clock" }],
      owed: [{ file: LIFE, route: "/v1/days/", lane: "days" }],
      standIns: [{ file: canned, reason: "serves the door's routes" }],
    };
    expect(found(root, lists)).toEqual([
      `entry finds nothing ${LIFE}:0 /v1/days/ (owed, days)`,
      "entry finds nothing /v1/feed:0 allowed",
      `entry finds nothing ${canned}:0 stand-in`,
    ]);
  });

  it("reads no stand-in, no test target, no vendored file, nothing outside the five folders and no file that is not code", () => {
    const canned = "ios-app/LifestreamCapture/Life/CannedHome.swift";
    const root = tree({
      [canned]: "case \"/v1/people\": return reply(200, people)\n",
      "ios-app/LifestreamCaptureTests/LifeReaderTests.swift": "let path = \"/v1/days/2026-11-21\"\n",
      "ios-app/LifestreamCaptureUITests/Flow.swift": "let path = \"/v1/days\"\n",
      "ios-app/Tests/LifestreamCaptureCoreTests/FakeHome.swift": "let path = \"/v1/people\"\n",
      "ios-app/testflight.py": "url = \"https://api.example.com/v1/apps\"\n",
      "ios-app/README.md": "It reads `/v1/people`.\n",
      "dashboard/public/vendor/map.js": "fetch('/v1/tiles')\n",
      "dashboard/test/door.mjs": "fetch('/v1/people')\n",
      "mcp/server.mjs": "fetch('/v1/search')\n",
      "macos-app/Tests/LifestreamTests/HostTests.swift": "let path = \"/v1/status\"\n",
      "homelink/.build/checkouts/Other.swift": "let path = \"/v1/status\"\n",
    });
    expect(found(root, { ...NONE, standIns: [{ file: canned, reason: "serves the door's routes" }] })).toEqual([]);
  });

  it("counts the owed entries by lane, every lane named", () => {
    const owed: Lists["owed"] = [
      { file: LIFE, route: "/v1/people", lane: "people" },
      { file: LIFE, route: "/v1/days", lane: "days" },
      { file: READS, route: "/v1/days", lane: "days" },
    ];
    expect(owedByLane(owed)).toEqual({ people: 1, days: 2, places: 0, search: 0, streams: 0, faces: 0, floor: 0 });
    expect(owedLine(owed)).toBe("owed reads by lane: people 1, days 2, places 0, search 0, streams 0, faces 0, floor 0 (3 in all)");
  });

  it("prints the owed count on every run, clean or not", () => {
    const root = tree({ [LIFE]: "reach().json('/v1/people')\n" });
    let output = "";
    let errors = "";
    expect(runPagesCheck(root, (text) => { output += text; }, (text) => { errors += text; }, NONE)).toBe(1);
    expect(output).toBe("owed reads by lane: people 0, days 0, places 0, search 0, streams 0, faces 0, floor 0 (0 in all)\n");
    expect(errors).toContain(`${LIFE}:1: refused: /v1/people`);
  });

  it("holds every owed and allowed route off the PAGES routes", () => {
    const pages = new Set(LISTS.pages);
    expect([...LISTS.owed.map((entry) => entry.route), ...LISTS.allowed.map((entry) => entry.route)].filter((route) => pages.has(route))).toEqual([]);
  });

  it("holds the repository to its lists", () => {
    let output = "";
    let errors = "";
    expect(runPagesCheck(resolve(dirname(fileURLToPath(import.meta.url)), ".."), (text) => { output += text; }, (text) => { errors += text; })).toBe(0);
    expect([output.endsWith("pages check: clean\n"), errors]).toEqual([true, ""]);
  });
});

const HOMELINK = "homelink/Sources/HomeLink/Reads.swift";
const LIFE_READER = "ios-app/LifestreamCapture/Life/LifeReader.swift";
const SCREEN = "ios-app/LifestreamCapture/People/NewScreen.swift";
const RELAYED: Lists = { ...NONE, relays: RELAYS };

const HOMELINK_READS = [
  "extension HomeLink {",
  "    public func people() async throws -> People {",
  "        try await read(\"/v1/people\")",
  "    }",
  "",
  "    public func day(_ day: String, etag inputs: String? = nil) async throws -> DayFile? {",
  "        guard let response = try await get(\"/v1/days/\" + day, etag: inputs) else { return nil }",
  "        return try Self.decoded(DayFile.self, response)",
  "    }",
  "",
  "    public func `where`(at instant: Date, etag: String? = nil) async throws -> Tagged<Where.At>? {",
  "        try await tagged(\"/v1/where\", [(\"at\", String(Self.milliseconds(instant)))], etag: etag)",
  "    }",
  "",
  "    public func count(_ query: CountQuery) async throws -> Counted {",
  "        try await counted(query)",
  "    }",
  "",
  "    private func counted(_ query: CountQuery) async throws -> Counted {",
  "        try await read(\"/v1/count\", [(\"of\", query.of)])",
  "    }",
  "",
  "    public func clock() async throws -> HomeClock {",
  "        try await read(\"/v1/clock\")",
  "    }",
  "",
  "    private func read<Value: Decodable>(_ path: String, _ query: [(String, String?)] = []) async throws -> Value {",
  "        try await contact(\"GET\", path + Self.query(query))",
  "    }",
  "}",
  "",
].join("\n");

const LIFE_READER_SOURCE = [
  "final class LifeReader {",
  "    private let link: HomeLink",
  "",
  "    func people() async throws -> HomeLink.People {",
  "        try await ask { try await $0.people() }",
  "    }",
  "",
  "    func `where`(at instant: Date) async throws -> HomeLink.Where.At {",
  "        try await ask { try await Self.value($0.where(at: instant)) }",
  "    }",
  "",
  "    func day(_ name: String, held: HomeLink.DayFile? = nil, kept: (Day) async -> Void = { _ in }) async throws -> Day {",
  "        let file = try await link.day(name, etag: held?.inputs)",
  "        return Day(file: file)",
  "    }",
  "",
  "    private func ask<Value>(_ read: (HomeLink) async throws -> Value) async throws -> Value {",
  "        try await read(link)",
  "    }",
  "}",
  "",
].join("\n");

const SERVER_LIFE = [
  "// @ts-check",
  "const PEOPLE_ROUTE = '/v1/people';",
  "/** @param {{ json: (path: string) => Promise<unknown> }} door */",
  "export function lifeReader(door) {",
  "  const currentPeople = () => door.json(PEOPLE_ROUTE);",
  "  const clock = () => door.json('/v1/clock');",
  "  return { people: currentPeople, clock };",
  "}",
  "/** @typedef {ReturnType<typeof lifeReader>} LifeReader */",
  "",
].join("\n");

const SERVER_ROUTES = [
  "// @ts-check",
  "/** @import { LifeReader } from '../life.mjs' */",
  "/** @param {LifeReader} life @param {{ json: (path: string) => Promise<unknown> }} door */",
  "export function lifeRoutes(life, door) {",
  "  const passed = (/** @type {string} */ path, /** @type {string} */ route) => ({ method: 'GET', path, handle: () => door.json(route) });",
  "  return [",
  "    { method: 'GET', path: '/api/life/people', handle: async () => life.people() },",
  "    { method: 'GET', path: '/api/clock', handle: async () => life.clock() },",
  "    passed('/api/search', '/v1/search'),",
  "  ];",
  "}",
  "",
].join("\n");

const CLIENT_API = [
  "// @ts-check",
  "async function call(path) {",
  "  return (await fetch('api/' + path, { method: 'GET' })).json();",
  "}",
  "export const fetchPeople = () => call('life/people');",
  "export const findPeople = q => call('life/people?q=' + encodeURIComponent(q));",
  "export const fetchClock = () => call('clock');",
  "export async function fetchSearch(params) {",
  "  return (await fetch(`api/search?${params}`)).json();",
  "}",
  "",
].join("\n");

const RELAY_TREE: Record<string, string> = {
  [HOMELINK]: HOMELINK_READS,
  [LIFE_READER]: LIFE_READER_SOURCE,
  "dashboard/lib/life.mjs": SERVER_LIFE,
  "dashboard/lib/routes/life.mjs": SERVER_ROUTES,
  "dashboard/public/lib/api.js": CLIENT_API,
};

describe("reads through a relay", () => {
  it("passes the relays themselves: HomeLink, LifeReader, the dashboard's server and its api.js", () => {
    expect(found(tree(RELAY_TREE), RELAYED)).toEqual([]);
  });

  it("refuses a new phone file calling a LifeReader method that reads a raw route, naming the method", () => {
    const root = tree({ ...RELAY_TREE, [SCREEN]: "struct NewScreen {\n    func load() async throws {\n        let people = try await AppRuntime.shared.life.people()\n    }\n}\n" });
    expect(checkPages(root, RELAYED)).toEqual([{ file: SCREEN, line: 3, rule: "refused", detail: expect.stringContaining("/v1/people (through people()): an app reads page answers") }]);
  });

  it("refuses a Mac file calling HomeLink's own method, and follows HomeLink's private helpers", () => {
    const mac = "macos-app/Sources/Lifestream/People/Counts.swift";
    const root = tree({ ...RELAY_TREE, [mac]: "func calls(link: HomeLink, query: HomeLink.CountQuery) async throws {\n    let counted = try? await link.count(query)\n}\n" });
    expect(found(root, RELAYED)).toEqual([`refused ${mac}:2 /v1/count (through count(_:))`]);
  });

  it("follows a LifeReader method whose HomeLink call sits inside another call", () => {
    const root = tree({ ...RELAY_TREE, [SCREEN]: "func here(life: LifeReader) async throws {\n    let at = try await life.where(at: Date())\n}\n" });
    expect(found(root, RELAYED)).toEqual([`refused ${SCREEN}:2 /v1/where (through where(at:etag:) or where(at:))`]);
  });

  it("takes a call only when it is awaited on a receiver with labels that fit: no static call, no enum case, no other signature", () => {
    const root = tree({
      ...RELAY_TREE,
      [SCREEN]: [
        "func quiet(life: LifeReader, kept: Shelf) async throws {",
        "    let words = Words.count(5)",
        "    EnergyLedger.shared.count(\"unlocks\")",
        "    AppNavigation.shared.open(.day(day), in: .days)",
        "    let held = await kept.people(generation)",
        "    let fix = await FirstRunFinds.place()",
        "    let summaries = try await life.where(from: .day(\"2026-01-01\"), to: .day(\"2026-12-31\"), grain: .year)",
        "    let people = await PeopleBook.shared.people(named: who)",
        "}",
        "",
      ].join("\n"),
    });
    expect(found(root, RELAYED)).toEqual([]);
  });

  it("takes a call with a trailing closure, inside a task group, and through async let", () => {
    const root = tree({
      ...RELAY_TREE,
      [SCREEN]: [
        "func loud(life: LifeReader) async throws {",
        "    let read = try await life.day(day, held: file) { kept in await self.show(kept) }",
        "    group.addTask { (unit, try? await life.people()) }",
        "    async let at = life.where(at: now)",
        "}",
        "",
      ].join("\n"),
    });
    expect(found(root, RELAYED)).toEqual([
      `refused ${SCREEN}:2 /v1/days/ (through day(_:held:kept:))`,
      `refused ${SCREEN}:3 /v1/people (through people())`,
      `refused ${SCREEN}:4 /v1/where (through where(at:etag:) or where(at:))`,
    ]);
  });

  it("covers a HomeLink method added with a new raw route, with no edit to the guard", () => {
    const moods = HOMELINK_READS.replace(/\}\n$/u, "    public func moods(on day: String) async throws -> Moods {\n        try await read(\"/v1/moods\", [(\"day\", day)])\n    }\n}\n");
    const root = tree({ ...RELAY_TREE, [HOMELINK]: moods, [SCREEN]: "func load(link: HomeLink) async throws {\n    let moods = try await link.moods(on: today)\n}\n" });
    expect(found(root, RELAYED)).toEqual([`refused ${SCREEN}:2 /v1/moods (through moods(on:))`]);
  });

  it("follows a route held in a constant to the method that reads it, and refuses one no method reads as the relay file's own", () => {
    const held = HOMELINK_READS
      .replace(/^extension HomeLink \{\n/u, "let moodsRoute = \"/v1/moods\"\nlet mealsRoute = \"/v1/meals\"\n\nextension HomeLink {\n")
      .replace(/\}\n$/u, "    public func moods(on day: String) async throws -> Moods {\n        try await read(moodsRoute, [(\"day\", day)])\n    }\n}\n");
    const root = tree({ ...RELAY_TREE, [HOMELINK]: held, [SCREEN]: "func load(link: HomeLink) async throws {\n    let moods = try await link.moods(on: today)\n}\n" });
    expect(found(root, RELAYED)).toEqual([`refused ${HOMELINK}:2 /v1/meals`, `refused ${SCREEN}:2 /v1/moods (through moods(on:))`]);
    expect(found(root, { ...RELAYED, owed: [{ file: HOMELINK, route: "/v1/meals", lane: "people" }, { file: SCREEN, route: "/v1/moods", lane: "people" }] })).toEqual([]);
  });

  it("passes a caller's own owed entry and refuses the same call from a new file as owed elsewhere", () => {
    const book = "ios-app/LifestreamCapture/People/PeopleBook.swift";
    const call = "func load(life: LifeReader) async throws {\n    let read = try await life.people()\n}\n";
    const root = tree({ ...RELAY_TREE, [book]: call, [SCREEN]: call });
    const lists: Lists = { ...RELAYED, owed: [{ file: book, route: "/v1/people", lane: "people" }] };
    expect(found(root, lists)).toEqual([`owed elsewhere ${SCREEN}:2 /v1/people (through people())`]);
  });

  it("refuses a new dashboard page calling an api.js export whose /api/ route relays a raw read", () => {
    const page = "dashboard/public/pages/digest.js";
    const root = tree({ ...RELAY_TREE, [page]: "import { fetchClock, fetchPeople as people } from '../lib/api.js';\n\nconst clock = await fetchClock();\nconst all = await people();\n" });
    const lists: Lists = { ...RELAYED, allowed: [{ route: "/v1/clock", reason: "the clock" }] };
    expect(checkPages(root, lists)).toEqual([{ file: page, line: 4, rule: "refused", detail: expect.stringContaining("/v1/people (through fetchPeople() → /api/life/people)") }]);
  });

  it("follows a namespace import of api.js, and a page fetching an /api/ route itself", () => {
    const page = "dashboard/public/ui/digest/side.js";
    const root = tree({ ...RELAY_TREE, [page]: "import * as api from '../../lib/api.js';\n\nconst found = await api.findPeople('a');\nconst raw = await fetch('/api/search?' + query);\nconst more = await fetch(`api/life/people?id=${id}`);\n" });
    expect(found(root, RELAYED)).toEqual([
      `refused ${page}:3 /v1/people (through findPeople() → /api/life/people)`,
      `refused ${page}:4 /v1/search (through /api/search)`,
      `refused ${page}:5 /v1/people (through /api/life/people)`,
    ]);
  });

  it("says when a relay derives nothing", () => {
    const root = tree({ [LIFE_READER]: "final class LifeReader {\n    var quiet = true\n}\n" });
    expect(found(root, { ...NONE, relays: RELAYS.filter((relay) => relay.path === LIFE_READER) })).toEqual([`entry finds nothing ${LIFE_READER}:0 relay`]);
  });

  it("reads a Swift parameter list and fits a call's labels to it", () => {
    const params = swiftParams("_ name: String, held: HomeLink.DayFile? = nil, kept: (Day) async -> Void = { _ in }");
    expect(params).toEqual([{ label: null, required: true }, { label: "held", required: false }, { label: "kept", required: false }]);
    expect([labelsFit(params, [null], 0), labelsFit(params, [null, "kept"], 0), labelsFit(params, ["held"], 0), labelsFit(params, [null, null], 0)]).toEqual([true, true, false, false]);
    expect(labelsFit(swiftParams("_ query: Query, then: () -> Void"), [null], 1)).toBe(true);
  });
});
