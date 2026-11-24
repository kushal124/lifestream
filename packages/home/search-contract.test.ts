import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { kindsAnswer, kindsHit, kindsPage, kindsParams, sitting, type KindsAnswer } from "./kinds-contract.js";
import { makeRef, readRef } from "./refs.js";
import { Refusal, SEARCH_REFUSALS } from "./refusal.js";
import {
  answerOf, citation, citations, ContractError, countAnswer, countParams, describeAnswer, LEAVES, paramsOf, readAnswer, readParams, routeEchoes, routeParams, routeRefs, ROUTES, screenHit,
  screenList, searchAnswer, searchParams, searchPeopleAnswer, searchPeopleParams, searchRefusal, searchState, TOOL_ROUTES, unread, type Schema, type Shape,
} from "./search-contract.js";

const FIXTURES = fileURLToPath(new URL("./test/contract/", import.meta.url));
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const files = readdirSync(FIXTURES).filter(name => name.endsWith(".json")).sort();
const kept = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`./contract/${name}`, import.meta.url)), "utf8"));

const SHAPES: [string, Shape<unknown>][] = [
  ["call-search", ROUTES["/v1/search"].call], ["call-count", ROUTES["/v1/count"].call], ["call-read", ROUTES["/v1/read"].call],
  ["citations", citations], ["describe", describeAnswer], ["state", searchState],
  ["search", searchAnswer], ["count", countAnswer], ["people", searchPeopleAnswer], ["read", readAnswer],
  ["kinds-see", kindsPage], ["kinds-screen", kindsPage], ["kinds", kindsAnswer],
];
const shapeOf = (name: string): Shape<unknown> | undefined => SHAPES.find(([start]) => name.startsWith(start))?.[1];

const broken = (of: Shape<unknown>, value: unknown): string | null => {
  try {
    of.parse(value);
    return null;
  } catch (error) {
    if (error instanceof ContractError) return error.message;
    throw error;
  }
};

describe("every fixture parses as its shape", () => {
  it.each(files.filter(name => !name.startsWith("refusals")))("%s", name => {
    const shape = shapeOf(name);
    expect(shape, `${name} names no shape`).toBeDefined();
    const value = fixture(name);
    expect(shape!.parse(value)).toEqual(value);
  });

  it("each route's answer shapes have a fixture, and no old name is left", () => {
    const whats = new Set(files.filter(name => name.startsWith("read-")).map(name => (fixture(name) as { what: string }).what));
    expect([...whats].sort()).toEqual(["brief", "chat", "gone", "line", "lines", "people", "photo", "place", "raw", "record", "refs", "row", "screen", "window"]);
    const counts = files.filter(name => name.startsWith("count")).map(name => fixture(name) as object);
    expect(counts.some(value => "families" in value) && counts.some(value => "asked" in value)).toBe(true);
    for (const route of ["search", "count", "people"]) expect(files.some(name => name.startsWith(route) && name.includes("hidden"))).toBe(true);
    for (const route of ["search", "count", "read"]) expect(files).toContain(`call-${route}-hidden.json`);
    expect(Object.keys(ROUTES).sort()).toEqual(["/v1/count", "/v1/describe", "/v1/people/search", "/v1/read", "/v1/search", "/v1/search/state"]);
    expect(files.filter(name => /^(?:stats|who)|-who\b/u.test(name))).toEqual([]);
    expect(() => readAnswer.parse({ what: "who", match: { ref: "x", kind: "person", name: "A" } })).toThrow("$.what");
  });

  it("a page by time says so, on both lists; a count's held is a span; pending_more beside the 100 named", () => {
    const byTime = fixture("search-record-by-time.json") as { record: { order: string; pending: unknown[]; pending_more: number } };
    expect(byTime.record).toMatchObject({ order: "newest", pending_more: 30 });
    expect(byTime.record.pending).toHaveLength(100);
    expect((fixture("search-screen-next.json") as { screen: { order: string } }).screen.order).toBe("newest");
    expect((fixture("count.json") as { held: unknown }).held).toEqual({ first: "2022-01-01", last: "2026-11-06" });
    const record = (fixture("search.json") as { record: Record<string, unknown> }).record;
    expect(broken(searchAnswer, { record: { ...record, order: "relevance" } })).toContain("$.record.order");
    expect(broken(searchAnswer, { record: { ...record, pending: Array.from({ length: 101 }, () => ({ day: "2026-11-14", why: "new" })) } })).toContain("$.record.pending");
    expect(broken(countAnswer, { ...(fixture("count.json") as object), held: "payments 2022-01-01 → 2026-11-06" })).toContain("none of its shapes");
  });

  it("a descriptor says where its thing opens, every kind; read and Go to say it no more", () => {
    const cited = Object.values(citations.parse(fixture("citations.json")));
    expect(new Set(cited.map(each => each.kind))).toEqual(new Set(["message", "record", "line", "photo", "window", "row", "person", "chat", "place", "gone"]));
    for (const each of cited) {
      if (each.kind === "gone") continue;
      expect(each.opens, each.kind).toBeDefined();
      const ref = readRef(each.ref);
      if (ref.kind === "record" && each.opens.page === "days") expect(each.opens.focus).toBe(`rec:${ref.parts.source} ${ref.parts.kind} ${ref.parts.key}`);
    }
    const record = cited.find(each => each.kind === "record")!;
    expect(broken(citation, { ...record, opens: undefined })).toContain("$.opens");
    expect(broken(citation, { ...record, opens: { page: "days", day: "2026-10-01", focus: "a12" } })).toContain("$.opens");
    expect(broken(citation, { ...record, opens: { page: "people" } })).toContain("$.opens");
    for (const name of ["read-record.json", "read-line.json", "read-window.json"]) expect(broken(readAnswer, { ...(fixture(name) as object), focus: "u:x" }), name).toContain("$.focus");
    const goto = (fixture("search.json") as { goto: { people: object[]; places: object[] } }).goto;
    expect(broken(searchAnswer, { goto: { ...goto, people: [{ ...goto.people[0], id: "person:person-a-1" }] } })).toContain("$.goto.people[0].id");
  });

  it("a message, a record or a line may carry a voice note's `voice`: its audio and its own record, seconds, who said it or mine; no other kind, never without `record`", () => {
    const cited = Object.values(citations.parse(fixture("citations.json")));
    const message = cited.find(each => each.kind === "message")!;
    const own = makeRef("record", { source: "whatsapp:15550000009:iphone-aa01", kind: "message", key: "a2" });
    const voice = { audio: `sha256:${"1".repeat(64)}`, record: own, seconds: 23, from: "Person A" };
    expect(citation.parse({ ...message, voice })).toEqual({ ...message, voice });
    for (const kind of ["record", "line"] as const) {
      const mine = { audio: voice.audio, record: own, seconds: 0, mine: true };
      const each = cited.find(one => one.kind === kind)!;
      expect(citation.parse({ ...each, voice: mine }), kind).toEqual({ ...each, voice: mine });
    }
    expect(citation.parse({ ...message, voice: { audio: voice.audio, record: own } })).toEqual({ ...message, voice: { audio: voice.audio, record: own } });
    expect(broken(citation, { ...message, voice: { audio: voice.audio, seconds: 23 } })).toContain("$.voice.record");
    expect(broken(citation, { ...message, voice: { ...voice, words: "Synthetic words" } })).toContain("$.voice.words");
    expect(broken(citation, { ...message, voice: { ...voice, mine: false } })).toContain("$.voice.mine");
    expect(broken(citation, { ...message, voice: { ...voice, seconds: 2.5 } })).toContain("$.voice.seconds");
    const photo = cited.find(each => each.kind === "photo")!;
    expect(broken(citation, { ...photo, voice })).toContain("$.voice");
  });

  it("names the tools' names: `query`, `the_user_was_at`; `link` is the tool's, not the door's", () => {
    expect(broken(searchParams, { q: "x" })).toContain("$.q: is no member");
    const hit = (fixture("search.json") as { record: { hits: Record<string, unknown>[] } }).record.hits[0]!;
    expect(hit.the_user_was_at).toBe("Example City");
    expect(broken(searchAnswer, { record: { total: 1, hits: [{ ...hit, was_at: "Example City" }] } })).toContain("was_at: is no member");
    const photo = fixture("read-photo.json") as Record<string, unknown>;
    expect(photo.the_user_was_at).toBeDefined();
    expect(broken(readAnswer, { ...photo, was_at: "Example Cafe" })).toContain("$.was_at: is no member");
    expect(broken(readParams, { link: "https://example.com" })).toContain("$.link: is no member");
    expect(broken(readAnswer, { what: "link", link: "https://example.com", text: "x" })).toContain("$.what");
  });

  it("the parameters file the tools build from is the contract's, each tool route's", () => {
    expect(kept("params.json")).toEqual(JSON.parse(JSON.stringify(routeParams())));
    const params = kept("params.json") as Record<string, { properties: Record<string, unknown> }>;
    expect(Object.keys(params).sort()).toEqual(["/v1/count", "/v1/people/search", "/v1/read", "/v1/search"]);
    expect(Object.keys(params["/v1/search"]!.properties)).toContain("query");
    expect(Object.keys(params["/v1/read"]!.properties)).not.toContain("link");
    expect(params["/v1/search"]!.properties.limit).toEqual({ type: "integer", minimum: 1, maximum: 50 });
  });

  it("every string and every map key of every answer, a refusal's too, says what it is to the way out", () => {
    const untyped = (schema: Schema, at: string, out: string[]): string[] => {
      if (schema.type === "string" && !LEAVES.includes(schema.leaf as never)) out.push(at);
      if (Array.isArray(schema.enum) && schema.enum.some(value => typeof value === "string") && schema.leaf !== "label") out.push(at);
      for (const each of (schema.anyOf as Schema[] | undefined) ?? []) untyped(each, at, out);
      for (const [name, member] of Object.entries((schema.properties as Record<string, Schema> | undefined) ?? {})) untyped(member, `${at}.${name}`, out);
      if (typeof schema.additionalProperties === "object") {
        if (!LEAVES.includes((schema.propertyNames as Schema | undefined)?.leaf as never)) out.push(`${at}{key}`);
        untyped(schema.additionalProperties as Schema, `${at}{}`, out);
      }
      if (typeof schema.items === "object") untyped(schema.items as Schema, `${at}[]`, out);
      if (typeof schema.lastItem === "object") untyped(schema.lastItem as Schema, `${at}[-1]`, out);
      ((schema.prefixItems as Schema[] | undefined) ?? []).forEach((each, i) => untyped(each, `${at}[${i}]`, out));
      return out;
    };
    for (const path of TOOL_ROUTES) {
      expect(untyped(ROUTES[path].answer.schema, "$", []), path).toEqual([]);
      expect(untyped(ROUTES[path].params.schema, "$", []), path).toEqual([]);
    }
    expect(untyped(searchRefusal.schema, "$", [])).toEqual([]);
    expect(JSON.stringify(kept("params.json"))).not.toContain('"leaf"');
  });

  it("the refs file is the contract's: every member that holds a ref or a cursor, and no other", () => {
    const refs = kept("refs.json") as Record<string, string[]>;
    expect(refs).toEqual(JSON.parse(JSON.stringify(routeRefs())));
    expect(Object.keys(refs).sort()).toEqual(["/v1/count", "/v1/people/search", "/v1/read", "/v1/search", "refusal"]);
    expect(refs["/v1/search"]).toEqual(expect.arrayContaining(["record.hits[].ref", "record.hits[].chat", "record.next", "screen.next", "person[].ref", "goto.places[].ref"]));
    expect(refs["/v1/count"]).toEqual(expect.arrayContaining(["rows[][-1]", "total.ref", "found.ref", "ties[].ref", "next"]));
    expect(refs["/v1/people/search"]).toEqual(expect.arrayContaining(["matches[].ref", "matches[].tied[]", "matches[].same[].ref", "matches[].chats[].chat", "next"]));
    expect(refs["/v1/read"]).toEqual(expect.arrayContaining(["ref", "chat", "around", "lines[].ref", "lines[].cites[]", "unopened[]", "opened[].ref", "rows[][-1]", "next"]));
    expect(refs.refusal).toEqual(expect.arrayContaining(["matches[].ref"]));
    for (const paths of Object.values(refs)) {
      for (const words of ["title", "name", "asked", "snippet", "text", "matched", "person[].asked", "why"]) expect(paths.some(path => path === words || path.endsWith(`.${words}`)), words).toBe(false);
    }
    const row = (fixture("count-by-month.json") as { columns: string[]; rows: unknown[][] });
    expect(broken(countAnswer, { ...row, rows: [[...row.rows[0]!.slice(0, -1), 7]] })).toContain("rows[0][4]");
    expect(broken(countAnswer, { ...row, rows: [[...row.rows[0]!.slice(0, -1), null]] })).toBeNull();
    expect(broken(countAnswer, { ...row, rows: [[]] })).toContain("rows[0]");
  });

  it("the echoes file is the contract's: every member that says back the reader's own words, whole, and no other", () => {
    const echoes = kept("echoes.json") as Record<string, string[]>;
    expect(echoes).toEqual(JSON.parse(JSON.stringify(routeEchoes())));
    expect(echoes).toEqual({
      "/v1/search": ["not_searched", "person[].asked", "read_as.as", "read_as.without", "variants"],
      "/v1/count": ["matched", "not_searched"],
      "/v1/people/search": [],
      "/v1/read": [],
    });
  });

  it("the screen's `next` says what it gives, and only beside a `next`", () => {
    const list = (fixture("search.json") as { screen: Record<string, unknown> }).screen;
    expect(list.next_gives).toBe("windows");
    expect(broken(screenList, { ...list, next_gives: "days" })).toBeNull();
    expect(broken(screenList, { ...list, next_gives: undefined })).toContain("next_gives");
    expect(broken(screenList, { ...list, capped: false, next: null })).toContain("next_gives");
  });

  it("a place Go to gives opens as Places reads it, and is cited by its name, opening Places at its id", () => {
    const place = (fixture("search.json") as { goto: { places: { ref: string; name: string }[] } }).goto.places[0]!;
    const opened = readAnswer.parse(fixture("read-place.json")) as { what: string; ref: string; place: { slug: string; name: string } };
    expect(opened).toMatchObject({ what: "place", ref: place.ref, place: { name: place.name } });
    expect(broken(readAnswer, { ...opened, place: { ...opened.place, position: 3 } })).toContain("$.place.position: is no member");
    expect(Object.values(citations.parse(fixture("citations.json")))).toContainEqual({ ref: place.ref, kind: "place", name: place.name, opens: { page: "places", id: opened.place.slug } });
  });

  it("a place visited and photographed before 1970 opens: its times are signed", () => {
    const opened = fixture("read-place.json") as { place: { first_ms: number; visits: { start_ms: number; end_ms: number }[]; photos: { at_ms: number }[] } };
    const old = { ...opened, place: { ...opened.place, first_ms: -86_400_000, visits: [{ ...opened.place.visits[0]!, start_ms: -86_400_000, end_ms: -82_800_000 }],
      photos: [{ ...opened.place.photos[0]!, at_ms: -86_000_000 }] } };
    expect(broken(readAnswer, old)).toBeNull();
  });
});

describe("the spec's examples parse as their types", () => {
  it("search, count and search_people, verbatim but for the moves the spec's examples owe: Go to's entries by ref alone, the count's `held` a span, `the_user_was_at`, the screen's `next_gives`", () => {
    const search = JSON.parse(`{"read_as": {"without": ["what", "did"], "as": {}},
 "variants": {"exampel": ["example"]},
 "record": {
   "as_of": "2026-11-14T22:10+00:00",
   "total": 10000, "capped": true,
   "reached": {"side": "newest", "at": "2026-09-03T14:22+01:00", "whole": "2026-09-04"},
   "hits": [{"ref": "…", "at": "2026-10-04T09:15+01:00", "day": "2026-10-04",
             "family": "messages", "product": "whatsapp", "title": "Person A",
             "from": "Person A", "snippet": "… «example» «street» …",
             "chat": "…", "chat_title": "Person A", "the_user_was_at": "Example City",
             "picture": 1}],
   "spread": {"families": {"messages": 9200, "mail": 800},
              "months": {"2026-10": 310, "2026-09": {"n": 120, "partial": true}}},
   "next": "…"},
 "screen": {
   "as_of": "2026-11-14T22:05+00:00",
   "total": 37, "capped": true,
   "reached": {"side": "newest", "whole": "2026-10-15"},
   "meaning": "off",
   "hits": [{"ref": "…", "at": "2026-11-02T06:03+01:00", "day": "2026-11-02",
             "app": "Example Browser", "title": "Example Air: your trip",
             "snippet": "… «example» …", "reason": "words", "also": 2}],
   "next": "…", "next_gives": "windows"},
 "goto": {"people": [{"ref": "…", "name": "Person A"}],
          "places": [{"ref": "…", "name": "Example Cafe"}],
          "day": null, "month": null}}`);
    const count = JSON.parse(`{"asked": "sum of amount over payments, by item",
 "matched": {"from": "2026-03-01", "to": "2026-03-31",
             "payee": {"acme": ["ACME CABS LIMITED (6)", "ACME CABS (1)"]}},
 "population": {"facts": 7, "valued": 7, "missing": 0, "excluded": {}},
 "held": {"first": "2022-01-01", "last": "2026-11-06"},
 "counted": "counted from payments as Example Bank statement lines state them, read to 2026-11-06",
 "also": ["the record also holds 2 mail entries the same words reach in the range, 2026-03-04 → 2026-03-29: the same kind of thing, held elsewhere: read it, add what these rows do not already hold, and give the whole first"],
 "total": {"n": 7, "sum": "350.00 EUR", "ref": "…"},
 "columns": ["day", "payee", "direction", "amount", "ref"],
 "rows": [["2026-03-02", "ACME CABS LIMITED", "debit", "50.00", "…"]],
 "as_of": "2026-11-14T22:10+00:00", "next": null}`);
    const people = JSON.parse(`{"note": "two contacts go by this name: p1 in touch 2019-02-01 → 2021-06-30, p2 2024-03-04 → 2026-11-13",
 "matches": [{"ref": "…", "kind": "person", "name": "Person A", "also": ["Per"],
   "tied": ["…"], "same": [{"ref": "…", "why": "the same full name, as a sender or a chat gave it"}],
   "handles": ["+15550000001", "person-a@example.com"],
   "chats": [{"chat": "…", "title": "Person A", "messages": 4500}],
   "reach": {"messages": [4800, "2019-02-01", "2021-06-30"], "calls": [280, "2019-02-09", "2021-06-12"]}}],
 "elsewhere": [{"as": "words", "family": "messages", "n": 14, "first": "2020-01-05", "last": "2020-08-17"}]}`);
    expect(searchAnswer.parse(search)).toEqual(search);
    expect(countAnswer.parse(count)).toEqual(count);
    expect(searchPeopleAnswer.parse(people)).toEqual(people);
    expect(unread.parse({ unread: "the screen records no person" })).toEqual({ unread: "the screen records no person" });
  });

  it("the parameters the spec's calls give", () => {
    expect(broken(searchParams, { query: "flight refund", from: "2026-10-07", to: "2026-10-31T18:00", lists: ["record", "screen"], typing: 1 })).toBeNull();
    expect(broken(countParams, { of: "days", measure: "recovery", op: "avg", by: ["month"], from: "2026-09-01", to: "2026-09-30" })).toBeNull();
    expect(broken(countParams, {})).toBeNull();
    expect(broken(countParams, { of: "payments", measure: "amount", by: ["item"], match: { payee: "acme OR -cabs" }, at_least: 10 })).toBeNull();
    expect(broken(searchPeopleParams, { name: "Per" })).toBeNull();
    expect(broken(readParams, { ref: "r3" })).toBeNull();
    expect(broken(readParams, { ref: ["r4", "r5"], history: 1 })).toBeNull();
    expect(broken(readParams, { chat: "r2", from: "2026-10-01", to: "2026-10-31" })).toBeNull();
    expect(broken(readParams, { from: "2026-10-01", to: "2026-10-03", families: ["screen"], detail: "raw" })).toBeNull();
    expect(broken(readParams, { cursor: "cursor:chat:c1:p2" })).toBeNull();
    for (const last of ["45m", "90m", "3h", "24h", "1440m"]) expect(broken(readParams, { last }), last).toBeNull();
    expect(broken(readParams, { last: "1h", families: ["messages"], products: ["whatsapp"], detail: "lines" })).toBeNull();
    expect(broken(readParams, { chat: "r2", last: "45m" })).toBeNull();
    expect(broken(readParams, { from: "2026-10-01", products: ["whatsapp"] })).toBeNull();
  });
});

describe("a shape refuses what the contract refuses", () => {
  const search = fixture("search.json") as { record: Record<string, unknown>; screen: Record<string, unknown> & { hits: Record<string, unknown>[] } };

  it.each([
    ["a member the type does not name", { ...search, score: 1 }, "$.score: is no member"],
    ["a capped list with no next", { ...search, record: { ...search.record, next: null } }, "$.record: a capped list has no next"],
    ["a hit's instant with no offset", { ...search, record: { ...search.record, hits: [{ ref: "x", day: "2026-10-04", family: "messages", at: "2026-10-04T09:15" }] } }, "$.record.hits[0].at"],
    ["a family no record has", { ...search, record: { ...search.record, hits: [{ ref: "x", day: "2026-10-04", family: "letters" }] } }, "$.record.hits[0].family"],
    ["a hit's time with no day", { ...search, record: { ...search.record, hits: [{ ref: "x", family: "notes", at: "2026-10-04T09:15+00:00" }] } }, "a hit with `at` states its `day`"],
    ["a person said back as a list of matches", { ...search, person: [{ asked: "Per", matches: [{ ref: "person.x", name: "Person A" }] }] }, "$.person[0]"],
    ["a screen list's reached with an instant", { ...search, screen: { ...search.screen, reached: { side: "newest", at: "2026-10-15T00:00Z", whole: "2026-10-15" } } }, "$.screen"],
  ])("search: %s", (_, value, says) => {
    expect(broken(searchAnswer, value)).toContain(says);
  });

  it("a screen hit's until goes with its range, meaning's wait with its line", () => {
    const hit = { ref: "x", day: "2026-11-02", app: "A", title: "T", snippet: "s", reason: "words" };
    expect(broken(screenHit, { ...hit, until: "2026-11-02T07:00Z" })).toContain("go together");
    expect(broken(screenHit, { ...hit, time_precision: "range" })).toContain("go together");
    expect(broken(screenList, { as_of: "2026-11-14T22:05Z", meaning: "waits", hits: [] })).toContain("go together");
    expect(broken(screenList, { as_of: "2026-11-14T22:05Z", meaning: "off", waits: "plugged in", hits: [] })).toContain("go together");
  });

  it.each([
    ["by item beside a key", countParams, { of: "payments", by: ["item", "payee"] }, "stands alone"],
    ["an op with no measure", countParams, { of: "payments", op: "sum" }, "takes a `measure`"],
    ["three keys", countParams, { of: "payments", by: ["month", "payee", "day"] }, "$.by"],
    ["a limit past 100", countParams, { of: "payments", limit: 101 }, "$.limit"],
    ["eleven people", searchParams, { person: Array.from({ length: 11 }, (_, i) => `r${i}`) }, "$.person"],
    ["a limit past 50", searchParams, { query: "a", limit: 51 }, "$.limit"],
    ["a list no search answers", searchParams, { lists: ["record", "facts"] }, "$.lists[1]"],
    ["a parameter the route does not take", searchParams, { query: "a", syntax: "fts" }, "$.syntax"],
    ["both name and id", searchPeopleParams, { name: "Per", id: "r1" }, "not both"],
    ["neither name, id nor cursor", searchPeopleParams, {}, "give `name`"],
    ["two addresses", readParams, { ref: "r1", chat: "r2" }, "one address"],
    ["no address", readParams, { detail: "lines" }, "give `ref`"],
    ["twenty-one refs", readParams, { ref: Array.from({ length: 21 }, (_, i) => `r${i}`) }, "$.ref"],
    ["history without a ref", readParams, { chat: "r2", history: 1 }, "`history`"],
    ["detail on a chat", readParams, { chat: "r2", detail: "brief" }, "`detail`"],
    ["products on a ref", readParams, { ref: "r1", products: ["whatsapp"] }, "`products` read a stretch"],
    ["products on a chat", readParams, { chat: "r2", products: ["whatsapp"] }, "`products` read a stretch"],
    ["last of two units", readParams, { last: "1h30m" }, "a duration: 45m, 3h"],
    ["last with no unit", readParams, { last: "45" }, "a duration: 45m, 3h"],
    ["last of nothing", readParams, { last: "0m" }, "a duration: 45m, 3h"],
    ["last in days", readParams, { last: "2d" }, "a duration: 45m, 3h"],
    ["last over a day, in hours", readParams, { last: "25h" }, "`last` is 24h at most: read days with `from` and `to`"],
    ["last over a day, in minutes", readParams, { last: "1441m" }, "`last` is 24h at most"],
    ["last with from", readParams, { last: "3h", from: "2026-10-01" }, "`last` is a stretch that ends now: give `last`, or `from` and `to`"],
    ["last with to", readParams, { last: "3h", to: "2026-10-01" }, "`last` is a stretch that ends now"],
    ["last with a ref", readParams, { last: "3h", ref: "r1" }, "one address"],
    ["last with a cursor", readParams, { last: "3h", cursor: "c1" }, "`next` is given alone"],
  ])("parameters: %s", (_, of, value, says) => {
    expect(broken(of as Shape<unknown>, value)).toContain(says);
  });

  it("an answer of another shape, a read of a kind no ref names, a code no route refuses with", () => {
    expect(broken(searchPeopleAnswer, { matches: [], capped: true })).toContain("a capped list has no next");
    expect(broken(countAnswer, { asked: "count of calls" })).toContain("none of its shapes");
    expect(broken(readAnswer, { what: "file", ref: "r1" })).toContain("$.what");
    expect(broken(readAnswer, { what: "refs", opened: [{ what: "refs", opened: [] }] })).toContain("$.opened");
    expect(broken(searchRefusal, { code: "NOT_A_CODE", message: "busy" })).toContain("$.code");
  });
});

describe("R7: what a search says of a hit and of a person", () => {
  it("a thing with no time at all is a hit with neither day nor at; a person asked is the one person, by ref and name", () => {
    const search = fixture("search.json") as { record: { hits: Record<string, unknown>[] } };
    const untimed = { ref: "record.x", family: "notes", title: "An undated note", snippet: "an «example»" };
    expect(searchAnswer.parse({ ...search, record: { ...search.record, hits: [untimed] } })).toMatchObject({ record: { hits: [untimed] } });
    const person = { asked: "Person A", ref: "person.x", name: "Person A" };
    expect(searchAnswer.parse({ person: [person] })).toEqual({ person: [person] });
  });

  it("no search fixture holds a mark in a title: marks live in snippets alone", () => {
    for (const name of files.filter((each) => each.startsWith("search"))) {
      const answer = fixture(name) as { record?: { hits: { title?: string }[] }; screen?: { hits?: { title?: string }[] } };
      for (const hit of [...answer.record?.hits ?? [], ...answer.screen?.hits ?? []]) expect(hit.title ?? "", name).not.toMatch(/[«»]/u);
    }
  });
});

describe("hidden fixtures are what the way out leaves", () => {
  const handles = (value: unknown, at: string, out: [string, unknown][]): [string, unknown][] => {
    if (Array.isArray(value)) value.forEach((member, i) => handles(member, `${at}[${i}]`, out));
    else if (typeof value === "object" && value !== null) {
      const object = value as Record<string, unknown>;
      for (const [name, member] of Object.entries(object)) {
        if (["ref", "chat", "next", "around", "tied", "cites"].includes(name) && member !== null) {
          for (const one of [member].flat()) if (typeof one === "string") out.push([`${at}.${name}`, one]);
        }
        if (name === "rows" && Array.isArray(object.columns) && object.columns.at(-1) === "ref") {
          for (const [i, row] of (member as unknown[][]).entries()) out.push([`${at}.rows[${i}]`, row.at(-1)]);
        }
        if (typeof member === "object") handles(member, `${at}.${name}`, out);
      }
    }
    return out;
  };

  it.each(files.filter(name => name.includes("hidden")))("%s gives handles, never refs", name => {
    const given = handles(fixture(name), "$", []);
    expect(given.length).toBeGreaterThan(0);
    for (const [at, one] of given) expect(one, at).toMatch(/^r\d+$/u);
  });

  it("the plain fixtures give refs the door made, each read by readRef, a chat member a chat's; no handle", () => {
    for (const name of files.filter(name => !name.includes("hidden"))) {
      for (const [at, one] of handles(fixture(name), "$", [])) {
        expect(one, `${name} ${at}`).not.toMatch(/^r\d+$/u);
        if (at.endsWith(".next")) continue;
        expect(() => readRef(one as string, at, at.endsWith(".chat") ? ["chat"] : undefined), `${name} ${at}`).not.toThrow();
      }
    }
  });

  it("a model reader is never told what Days focuses", () => {
    for (const name of files.filter(name => name.includes("hidden"))) expect(JSON.stringify(fixture(name)), name).not.toContain('"focus"');
  });

  it("a list by a placeholder's term states no progress; the screen's hidden list no total", () => {
    const placeholder = fixture("search-placeholder-hidden.json") as { record: Record<string, unknown> };
    for (const member of ["reached", "held", "spread", "unproven", "fits"]) expect(placeholder.record).not.toHaveProperty(member);
    expect(placeholder.record).toMatchObject({ capped: true, next: expect.any(String), total: expect.any(Number) });
    const hidden = fixture("search-hidden.json") as { screen: Record<string, unknown> };
    expect(hidden.screen).not.toHaveProperty("total");
  });
});

describe("refusals", () => {
  const refusals = fixture("refusals.json") as { status: number; retry_after?: number; body: { code: keyof typeof SEARCH_REFUSALS } }[];

  it.each(refusals.map(refusal => [`${refusal.body.code} ${JSON.stringify(refusal.body).slice(0, 40)}`, refusal] as const))("%s", (_, refusal) => {
    expect(searchRefusal.parse(refusal.body)).toEqual(refusal.body);
    expect(refusal.status).toBe(SEARCH_REFUSALS[refusal.body.code]);
    expect(refusal.retry_after !== undefined).toBe(refusal.status === 503);
  });

  it("every code has a fixture", () => {
    expect([...new Set(refusals.map(refusal => refusal.body.code))].sort()).toEqual(Object.keys(SEARCH_REFUSALS).sort());
  });
});

describe("paramsOf reads a query string into the parsed form", () => {
  const refused = (run: () => unknown): { status: number; code: string; words: string } => {
    try {
      run();
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, code: error.code, words: error.words };
      throw error;
    }
    throw new Error("not refused");
  };

  it("lists from repeats, one value each, a name with a comma one person", () => {
    const query = new URLSearchParams([["query", "corner, cafe"], ["person", "Doe, Jane"], ["person", "r3"], ["families", "messages"], ["families", "mail"],
      ["lists", "record"], ["lists", "screen"], ["limit", "20"], ["typing", "1"], ["from", "2026-10-01"]]);
    expect(paramsOf(searchParams, query)).toEqual({ query: "corner, cafe", person: ["Doe, Jane", "r3"], families: ["messages", "mail"],
      lists: ["record", "screen"], limit: 20, typing: 1, from: "2026-10-01" });
    expect(paramsOf(searchParams, new URLSearchParams("families=messages"))).toEqual({ families: ["messages"] });
  });

  it("a map from one parameter a key, numbers as numbers", () => {
    const query = new URLSearchParams([["of", "payments"], ["measure", "amount"], ["by", "month"], ["by", "payee"], ["match.payee", "acme OR -cabs"],
      ["match.direction", "debit"], ["at_least", "10.5"], ["at_most", "-2"], ["limit", "100"]]);
    expect(paramsOf(countParams, query)).toEqual({ of: "payments", measure: "amount", by: ["month", "payee"],
      match: { payee: "acme OR -cabs", direction: "debit" }, at_least: 10.5, at_most: -2, limit: 100 });
  });

  it("read's ref: one value, or repeats as a list", () => {
    expect(paramsOf(readParams, new URLSearchParams("ref=r1"))).toEqual({ ref: "r1" });
    expect(paramsOf(readParams, new URLSearchParams("ref=r1&ref=r2&history=1"))).toEqual({ ref: ["r1", "r2"], history: 1 });
    expect(paramsOf(ROUTES["/v1/search/state"].params, new URLSearchParams())).toEqual({});
  });

  it.each([
    ["a parameter the route does not take", searchParams, "query=a&syntax=fts", "`syntax` is not an argument this takes"],
    ["a map's key on a member that is no map", searchParams, "query.x=a", "`query.x` is not an argument this takes"],
    ["a map given whole", countParams, "of=payments&match=acme", "`match` is not an argument this takes"],
    ["one value given twice", searchParams, "query=a&query=b", "`query` is given more than once"],
    ["a number that is not one", searchParams, "limit=ten", "`limit` wants a whole number"],
    ["a number past its bound", searchParams, "limit=51", "`limit` wants 1 to 50"],
    ["a list value the list does not take", searchParams, "lists=record&lists=facts", "`lists` wants one of"],
    ["typing other than 1", searchParams, "typing=true", "`typing` wants one of 1"],
    ["a rule across members", searchPeopleParams, "name=Per&id=r1", "give `name` or `id`, not both"],
    ["a state asked anything", ROUTES["/v1/search/state"].params, "q=x", "`q` is not an argument this takes"],
    ["a map key `__proto__`", countParams, "of=payments&match.__proto__=acme", "`match.__proto__` wants a key a collection has"],
    ["a parameter named after an inherited member", searchParams, "constructor=x", "`constructor` is not an argument this takes"],
    ["a parameter `__proto__`", searchParams, "__proto__=x", "`__proto__` is not an argument this takes"],
  ])("BAD_PARAMETER for %s", (_, of, query, says) => {
    const refusal = refused(() => paramsOf(of as Shape<unknown>, new URLSearchParams(query)));
    expect(refusal).toMatchObject({ status: SEARCH_REFUSALS.BAD_PARAMETER, code: "BAD_PARAMETER" });
    expect(refusal.words).toContain(says);
  });

  it("a model reader's call carries the same parsed form as `args`", () => {
    const call = fixture("call-search-hidden.json") as { args: unknown };
    expect(ROUTES["/v1/search"].call.parse(call)).toEqual(call);
    expect(broken(ROUTES["/v1/search"].call, { ...call, args: { query: "a", syntax: "fts" } })).toContain("$.args.syntax");
    expect(broken(ROUTES["/v1/search"].call, { ...call, level: "none" })).toContain("$.level: is no member");
  });

  it("no member vanishes: one named `constructor` or `__proto__` is refused, in a `POST` as in a query string", () => {
    const call = fixture("call-count-hidden.json") as { args: object };
    const posted = (body: string): string | null => broken(ROUTES["/v1/count"].call, JSON.parse(body));
    expect(posted(JSON.stringify({ ...call, constructor: "x" }))).toContain("$.constructor: is no member");
    expect(posted(JSON.stringify({ ...call, args: { ...call.args, constructor: "x" } }))).toContain("$.args.constructor: is no member");
    expect(posted(JSON.stringify({ ...call, args: { of: "payments" } }).replace('{"of"', '{"__proto__":{"of":"x"},"of"'))).toContain("$.args.__proto__: is no member");
    expect(posted(JSON.stringify({ ...call, args: { of: "payments", match: { payee: "acme" } } }).replace('{"payee"', '{"__proto__":"x","payee"')))
      .toContain("$.args.match.__proto__: wants a key a collection has");
    const kept = paramsOf(countParams, new URLSearchParams("of=payments&match.payee=acme&match.constructor=x"));
    expect(Object.getPrototypeOf(kept)).toBeNull();
    expect(Object.getPrototypeOf(kept.match)).toBeNull();
    expect(Object.entries(kept.match!), "a key named as an inherited member is kept for the route to refuse").toEqual([["payee", "acme"], ["constructor", "x"]]);
  });
});

describe("answerOf holds a route's answer or refusal to the contract", () => {
  it("an answer by its route's shape, a refusal by its code's status", () => {
    expect(answerOf("/v1/search", 200, fixture("search.json"))).toEqual(fixture("search.json"));
    expect(answerOf("/v1/search/state", 200, fixture("state.json"))).toEqual(fixture("state.json"));
    const moved = { code: "LINE_MOVED", message: "the line moved" };
    expect(answerOf("/v1/read", 409, moved)).toEqual(moved);
    expect(() => answerOf("/v1/read", 422, moved)).toThrow("LINE_MOVED is 409, answered 422");
    expect(() => answerOf("/v1/count", 200, fixture("search.json"))).toThrow(ContractError);
    expect(() => answerOf("/v1/people/search", 200, { matches: [], score: 1 })).toThrow("$.score");
    expect(answerOf("/v1/people/search", 200, { matches: [], elsewhere: [{ as: "words", capped: true }] })).toEqual({ matches: [], elsewhere: [{ as: "words", capped: true }] });
    expect(() => answerOf("/v1/people/search", 200, { matches: [], elsewhere: [{ as: "words" }] })).toThrow("an entry with no count is `capped`");
    const chat = { as: "chat", ref: makeRef("chat", { key: "whatsapp:15550000199@s.whatsapp.net" }), n: 3, first: "2026-10-20", last: "2026-10-22" };
    expect(answerOf("/v1/people/search", 200, { matches: [], elsewhere: [chat] })).toEqual({ matches: [], elsewhere: [chat] });
  });
});

describe("the kinds route's contract: the person's Search, built from the search shapes", () => {
  const kinds = fixture("kinds.json") as KindsAnswer;
  const unreadAnswer = fixture("kinds-unread.json") as KindsAnswer;
  const kindOf = <T = Record<string, unknown>>(answer: KindsAnswer, family: string): T => answer.kinds.find(each => each.family === family) as unknown as T;

  it("the fixtures hold every row shape: people, places and hits on top; hits, tracks and sittings; upcoming; unread; a kind all in top", () => {
    expect(kinds.top.map(row => Object.keys(row)[0])).toEqual(["person", "place", "hit"]);
    expect(kinds.kinds.map(each => Object.keys(each).find(key => ["hits", "tracks", "sittings"].includes(key)))).toEqual(expect.arrayContaining(["hits", "tracks", "sittings"]));
    expect(kindOf(kinds, "calendar").upcoming).toBe(2);
    expect((kindOf(kinds, "photos").hits as { image?: string }[]).every(hit => hit.image !== undefined)).toBe(true);
    const sittings = kindOf(kinds, "screen").sittings as { focus?: string; windows: number; matched: unknown[] }[];
    expect(sittings.some(each => each.focus === undefined)).toBe(true);
    expect(sittings.some(each => each.windows === 2 && each.matched.length === 2)).toBe(true);
    expect(kindOf(unreadAnswer, "listening")).toEqual({ family: "listening", unread: expect.any(String) });
    expect(kindOf(unreadAnswer, "screen")).toMatchObject({ n: { partial: true }, unread: expect.any(String) });
    expect(kindOf(unreadAnswer, "notes")).toEqual({ family: "notes", n: 1, hits: [] });
  });

  it("the listening kind is the plays count: its n the count's sum, its tracks the count's first rows", () => {
    const count = fixture("count-plays.json") as { total: { sum: number }; columns: string[]; rows: unknown[][] };
    const listening = kindOf<{ n: number; tracks: { ref: string; track: string; artist: string; plays: number }[] }>(kinds, "listening");
    expect(listening.n).toBe(count.total.sum);
    expect(count.columns).toEqual(["track", "artist", "n", "sum", "missing", "ref"]);
    expect(listening.tracks).toEqual(count.rows.slice(0, 3).map(row => ({ ref: row[5], track: row[0], artist: row[1], plays: row[3] })));
    const month = fixture("count-plays-by-month.json") as { total: { n: number }; rows: number[][] };
    expect(month.total.n).toBe(count.rows[0]![2]);
    const item = fixture("count-plays-by-item.json") as { columns: string[]; rows: unknown[][]; total: { sum: number } };
    expect(item.columns).toEqual(["time", "track", "artist", "album", "app", "device", "minutes", "times", "ref"]);
    expect(item.rows.reduce((sum, row) => sum + (row[7] as number), 0)).toBe(item.total.sum);
    expect(item.rows.every(row => readRef(row.at(-1) as string).kind === "record")).toBe(true);
  });

  it("a kinds hit is a record hit, and a photo's hit alone states its image", () => {
    for (const hit of (fixture("search.json") as { record: { hits: unknown[] } }).record.hits) expect(broken(kindsHit, hit)).toBeNull();
    const message = kinds.kinds[0]!.family === "messages" ? (kinds.kinds[0] as { hits: object[] }).hits[0]! : {};
    expect(broken(kindsHit, { ...message, image: `sha256:${"1".repeat(64)}` })).toContain("only a photo's hit");
  });

  it("the home's rules hold: one kind a family, most first, total summed, top in its order, no hit twice", () => {
    const [messages, listening, ...rest] = kinds.kinds;
    expect(broken(kindsAnswer, { ...kinds, kinds: [listening, messages, ...rest] })).toContain("most first");
    expect(broken(kindsAnswer, { ...kinds, kinds: [messages, messages, listening, ...rest] })).toContain("one kind");
    expect(broken(kindsAnswer, { ...kinds, total: { n: 1746, partial: true } })).toContain("summed");
    expect(broken(kindsAnswer, { ...kinds, total: 1747 })).toContain("partial");
    expect(broken(kindsAnswer, { ...kinds, top: [...kinds.top].reverse() })).toContain("people, then places");
    expect(broken(kindsAnswer, { ...kinds, top: [...kinds.top, kinds.top[2]] })).toContain("$.top");
    const topHit = (kinds.top[2] as { hit: object }).hit;
    expect(broken(kindsAnswer, { ...kinds, kinds: [{ ...messages, hits: [topHit] }, listening, ...rest] })).toContain("not again");
    expect(broken(kindsAnswer, { ...kinds, kinds: [{ ...messages, hits: [{ ...topHit, family: "mail" }] }, listening, ...rest] })).toContain("of its family");
    const calendar = kindOf(kinds, "calendar");
    expect(broken(kindsAnswer, { ...kinds, kinds: kinds.kinds.map(each => (each.family === "calendar" ? { ...calendar, upcoming: 24 } : each)) })).toContain("`upcoming`");
    expect(broken(kindsAnswer, { ...kinds, kinds: kinds.kinds.map(each => (each.family === "web" ? { ...each, tracks: [] } : each)) })).toContain("is no member");
  });

  it("listening is tracks or unread; screen is sittings, unread in part, or unread alone", () => {
    const unreadScreen = { family: "screen", unread: "the screen records no person" };
    const without = unreadAnswer.kinds.filter(each => each.family !== "screen");
    const total = { n: 11602, partial: true };
    expect(broken(kindsAnswer, { ...unreadAnswer, total, kinds: [...without, unreadScreen] })).toBeNull();
    expect(broken(kindsAnswer, { ...unreadAnswer, kinds: unreadAnswer.kinds.map(each => (each.family === "screen" ? { ...each, n: 2 } : each)) })).toContain("partial");
    expect(broken(kindsAnswer, { ...unreadAnswer, total, kinds: [...without, { family: "screen", n: 2 }] })).toContain("holds its `sittings`");
    expect(broken(kindsAnswer, { ...unreadAnswer, kinds: unreadAnswer.kinds.map(each => (each.family === "listening" ? { ...each, n: 3 } : each)) })).toContain("none of its shapes");
    const tracks = kindOf<{ tracks: unknown[] }>(kinds, "listening").tracks;
    expect(broken(kindsAnswer, { ...kinds, kinds: kinds.kinds.map(each => (each.family === "listening" ? { ...each, tracks: [...tracks].reverse() } : each)) })).toContain("most played");
  });

  it("a sitting: its focus and summary together, no more windows shown than it holds, a run no sitting holds its windows alone", () => {
    const [first, , loose] = (kindOf(kinds, "screen").sittings as Record<string, unknown>[]);
    expect(broken(sitting, { ...first, summary: undefined })).toContain("go together");
    expect(broken(sitting, { ...first, windows: 1 })).toContain("no more windows");
    expect(broken(sitting, { ...loose, snippet: "x" })).toContain("matched windows alone");
    expect(broken(sitting, { ...first, focus: "rec:a b c" })).toContain("$.focus");
  });

  it("a sitting's window opens its day at that window's minute within the sitting; a run's window has no focus of its own", () => {
    const [first, , loose] = (kindOf(kinds, "screen").sittings as { focus?: string; matched: { focus?: string }[] }[]);
    expect(first!.matched.every(window => window.focus?.startsWith(`${first!.focus}@`))).toBe(true);
    expect(broken(sitting, first)).toBeNull();
    const elsewhere = { ...first, matched: first!.matched.map(window => ({ ...window, focus: "u:screen:local:macbook-pro-0001/1@2-3" })) };
    expect(broken(sitting, elsewhere)).toContain("within its sitting");
    expect(broken(sitting, { ...first, matched: first!.matched.map(window => Object.fromEntries(Object.entries(window).filter(([key]) => key !== "focus"))) })).toContain("within its sitting");
    expect(broken(sitting, { ...loose, matched: loose!.matched.map(window => ({ ...window, focus: `${first!.focus}@1-2` })) })).toContain("within its sitting");
  });

  it("its parameters: the words, a time, and `see` a kind with `upcoming` for a record kind's coming entries; a `cursor` alone; no filter, order, limit or lists", () => {
    expect(paramsOf(kindsParams, new URLSearchParams("query=riverside&typing=1&from=2026-10-01&to=2026-10-31")))
      .toEqual({ query: "riverside", typing: 1, from: "2026-10-01", to: "2026-10-31" });
    for (const see of ["screen", "listening", "mail", "photos"]) expect(paramsOf(kindsParams, new URLSearchParams(`query=riverside&typing=1&see=${see}`))).toEqual({ query: "riverside", typing: 1, see });
    expect(paramsOf(kindsParams, new URLSearchParams("query=riverside&see=calendar&upcoming=1&from=2026-11-01"))).toEqual({ query: "riverside", see: "calendar", upcoming: 1, from: "2026-11-01" });
    expect(paramsOf(kindsParams, new URLSearchParams("cursor=k2"))).toEqual({ cursor: "k2" });
    for (const name of ["order=newest", "limit=3", "lists=record", "families=mail", "products=whatsapp", "person=Person%20A", "chat=chat.a", "place=Example%20Cafe", "words=riverside", "by=track"]) {
      expect(() => paramsOf(kindsParams, new URLSearchParams(`query=a&${name}`))).toThrow("is not an argument this takes");
    }
    for (const beside of ["query=a", "see=screen", "typing=1", "to=2026-11-14"]) expect(() => paramsOf(kindsParams, new URLSearchParams(`${beside}&cursor=k2`))).toThrow("comes alone");
    for (const see of ["", "&see=listening", "&see=screen"]) expect(() => paramsOf(kindsParams, new URLSearchParams(`query=a&upcoming=1${see}`))).toThrow("record kind's coming");
    expect(() => paramsOf(kindsParams, new URLSearchParams("query=a&see=everything"))).toThrow("`see` wants one of");
  });

  it("See all is a page of the kind in its first screen's row shape: a record kind's hits with a photo's image, Upcoming, tracks, sittings, unread", () => {
    const photos = kindsPage.parse(fixture("kinds-see-photos.json")) as { family: string; hits: { image?: string }[]; next: string | null; pending?: unknown[] };
    expect(photos).toMatchObject({ family: "photos", next: expect.any(String), pending: [expect.anything()] });
    expect(photos.hits.filter(hit => hit.image !== undefined).length).toBeGreaterThan(0);
    expect(photos.hits.slice(0, 2)).toEqual((kindOf<{ hits: unknown[] }>(kinds, "photos")).hits);
    expect(kindsPage.parse(fixture("kinds-see-upcoming.json"))).toMatchObject({ family: "calendar", upcoming: true, next: null });
    const count = fixture("count-plays.json") as { rows: unknown[][] };
    const listening = kindsPage.parse(fixture("kinds-see-listening.json")) as { tracks: unknown[] };
    expect(listening.tracks).toEqual(count.rows.map(row => ({ ref: row[5], track: row[0], artist: row[1], plays: row[3] })));
    expect(listening.tracks.slice(0, 3)).toEqual(kindOf<{ tracks: unknown[] }>(kinds, "listening").tracks);
    expect(kindsPage.parse(fixture("kinds-screen.json"))).toMatchObject({ family: "screen", next: expect.any(String) });
    expect(fixture("kinds-see-unread.json")).toEqual(kindOf(unreadAnswer, "listening"));
  });

  it("a page's rules: its kind's rows only, newest first (Upcoming soonest first, tracks most played), no `next` on a page with no row", () => {
    const photos = fixture("kinds-see-photos.json") as { hits: Record<string, unknown>[] };
    const upcoming = fixture("kinds-see-upcoming.json") as { hits: unknown[] };
    const listening = fixture("kinds-see-listening.json") as { tracks: unknown[] };
    const screen = fixture("kinds-screen.json") as { sittings: unknown[] };
    expect(broken(kindsPage, { ...photos, hits: [...photos.hits].reverse() })).toContain("newest first");
    const { image: _image, ...plain } = photos.hits[0] as { image?: string };
    expect(broken(kindsPage, { ...photos, hits: [{ ...plain, family: "notes" }] })).toContain("of its kind");
    expect(broken(kindsPage, { ...photos, family: "notes" })).toContain("of its kind");
    expect(broken(kindsPage, { ...upcoming, hits: [...upcoming.hits].reverse() })).toContain("soonest first");
    expect(broken(kindsPage, { ...upcoming, upcoming: undefined })).toContain("newest first");
    expect(broken(kindsPage, { ...listening, tracks: [...listening.tracks].reverse() })).toContain("none of its shapes");
    expect(broken(kindsPage, { ...listening, tracks: [{ ...(listening.tracks[0] as object), track: "" }] })).toContain("names its `track`");
    expect(broken(kindsPage, { ...screen, sittings: [...screen.sittings].reverse() })).toContain("newest first");
    for (const empty of [{ ...photos, hits: [] }, { ...screen, sittings: [] }, { family: "screen", sittings: [], next: "k3", unread: "Screen search is getting ready." }]) {
      expect(broken(kindsPage, empty)).toContain("no `next`");
    }
    expect(broken(kindsPage, { ...screen, sittings: [], next: null, unread: "Screen search is getting ready." })).toBeNull();
    expect(broken(kindsPage, { family: "listening", tracks: [], next: null })).toBeNull();
    expect(broken(kindsPage, { family: "listening", unread: "Too many plays match to count. Add a word or pick a time.", next: null })).toContain("none of its shapes");
    expect(broken(kindsPage, { family: "listening", tracks: [], next: "k3" })).toContain("none of its shapes");
    expect(broken(kindsPage, { ...screen, family: undefined })).toContain("$.family");
  });
});
