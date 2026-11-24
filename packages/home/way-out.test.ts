import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { placeholderSpans } from "@lifestreamprotocol/core";
import { Refusal } from "./refusal.js";
import { makeRef } from "./refs.js";
import {
  countAnswer, countParams, leavesOf, object, readAnswer, readParams, recordHit, ROUTES, searchAnswer, searchParams, searchPeopleAnswer, searchPeopleParams, searchRefusal, text,
  type Leaves, type Shape,
} from "./search-contract.js";
import { asked, fixture, hiddenOf, hiding, PAIRS, PEOPLE, seeded, type Hiding } from "./test/way-out-world.js";
import { snippetAt } from "./search-words.js";
import type { Candidates } from "./count.js";
import { sealOf, type Sealed } from "@lifestreamprotocol/privacy";
import { cameOf, continuationOf, CURSOR_PARAMS, GUESS, itemsOf, kept, NAMES_HIDDEN, routed, screenKept, standsFor, UNSTATED, wayIn, wayOut, type Asked, type Hide } from "./way-out.js";

const HIDDEN = readdirSync(fileURLToPath(new URL("./test/contract/", import.meta.url))).filter((name) => name.endsWith("-hidden.json") && !name.startsWith("call-")).map((name) => name.slice(0, -".json".length)).sort();

const REFS = [
  "record.WyJyZWNvcmQiLCJ3aGF0c2FwcDoxNTU1MDAwMDAwOTppcGhvbmUtYWEwMSIsIm1lc3NhZ2UiLCJhMSJd",
  "chat.WyJjaGF0Iiwid2hhdHNhcHA6MTU1NTAwMDAwMDFAcy53aGF0c2FwcC5uZXQiXQ",
  "person.WyJwZXJzb24iLCJwaG9uZTorMTU1NTAwMDAwMDEiXQ",
];

const ROUTE_OF = new Map<unknown, string>(Object.entries(ROUTES).map(([path, route]) => [route.params, path]));

async function inOf<P>(shape: Shape<P>, args: unknown, world: Hiding, level: "all" | "none" = "all", shown: readonly string[] = [], route = ROUTE_OF.get(shape) ?? "/v1/search") {
  return wayIn(route, shape, args, world.table(), level, new Set(shown), PEOPLE, world.look);
}

const out = async <A>(shape: Shape<A>, answer: unknown, read: Asked<unknown>, world: Hiding): Promise<A> => {
  const served = await wayOut(shape as Shape<unknown>, answer, read, world.hide);
  if (!("answer" in served)) throw new Error(served.wait);
  return served.answer as A;
};

function labels(value: unknown, leaves: Leaves | undefined): string[] {
  if (typeof value === "string") return leaves?.leaf === "label" ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((each, i) => labels(each, leaves?.at?.[i] ?? (i === value.length - 1 && leaves?.last !== undefined ? leaves.last : leaves?.each)));
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, each]) => [...leaves?.keys === "label" ? [key] : [], ...labels(each, leaves?.members?.[key] ?? leaves?.values)]);
}

async function handed(world: Hiding, refs: readonly string[]): Promise<string[]> {
  const hidden = await world.hide(refs.map((ref) => [{ text: ref, is: "ref" }]));
  if (!("texts" in hidden)) throw new Error(hidden.wait);
  return hidden.texts as string[];
}

const answered = <P>(read: Awaited<ReturnType<typeof inOf<P>>>): Asked<P> => {
  if (!("params" in read)) throw new Error(JSON.stringify(read));
  return read;
};

describe("the out face", () => {
  it("leaves each hidden fixture of the contract, from its plain one", () => {
    expect(HIDDEN).toEqual(Object.keys(PAIRS).sort());
  });

  it.each(Object.keys(PAIRS))("%s is the way out of its plain fixture", async (name) => {
    expect(await hiddenOf(name)).toEqual(fixture(name));
  });

  it("serves a string or a key no shape names as free words, hidden", async () => {
    const world = await seeded("all");
    const plain = { ...(fixture("search") as object), surprise: "Person A on Example Street", extra: { "Person A": ["Example Street"] } };
    const out = await wayOut(searchAnswer as Shape<unknown>, plain, asked("all"), world.hide);
    if (!("answer" in out)) throw new Error(out.wait);
    const served = out.answer as { surprise: string; extra: Record<string, string[]> };
    expect(served.surprise).toBe("[[Person 1]] on [[Address 1]]");
    expect(served.extra).toEqual({ "[[Person 1]]": ["[[Address 1]]"] });
  });

  it("says no near spelling or reading of a placeholder's term, nor any word it was put back as", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(searchParams, { query: "[[Person 1]]" }, world));
    const hits = [{ ref: REFS[0], family: "messages", snippet: "the diner at nine" }];
    const plain = { read_as: { without: [], as: { per: ["per"], dinner: ["diner"] } }, variants: { per: ["pet"], "person a": ["persona"], dinner: ["diner"] }, record: { total: 1, hits } };
    const served = await out(searchAnswer, plain, read, world);
    expect({ read_as: served.read_as, variants: served.variants }).toEqual({ read_as: { without: [], as: { dinner: ["diner"] } }, variants: { dinner: ["diner"] } });
  });

  it("names a near spelling or a reading only where it stands in a kept hit", async () => {
    const world = hiding("all");
    const read = answered(await inOf(searchParams, { query: "garden" }, world, "all", ["the garden"]));
    const hits = [{ ref: REFS[0], family: "messages", snippet: "the «gardens» at nine" }];
    const plain = { read_as: { without: [], as: { garden: ["gardener", "gardens"] } }, variants: { garden: ["gardner", "gardens"], plot: ["plots"] }, record: { total: 1, hits } };
    const served = await out(searchAnswer, plain, read, world);
    expect({ read_as: served.read_as, variants: served.variants }).toEqual({ read_as: { without: [], as: { garden: ["gardens"] } }, variants: { garden: ["gardens"] } });
  });

  it("states no Go to at a level that hides, every word of the query shown or not; at none it is the engine's", async () => {
    const goto = { people: [{ ref: REFS[2], name: "Person A" }], places: [{ ref: "place.WyJwbGFjZSIsImV4YW1wbGUtY2FmZSJd", name: "Example Cafe" }], day: null, month: null };
    const world = await seeded("all");
    for (const [query, shown] of [["pe", []], ["pe", ["pe"]], ["[[Person 1]]", ["[[Person 1]]"]]] as const) {
      const read = answered(await inOf(searchParams, { query, lists: ["goto"] }, world, "all", shown));
      expect(await out(searchAnswer, { goto }, read, world), query).not.toHaveProperty("goto");
    }
    const open = hiding("none");
    const none = answered(await inOf(searchParams, { query: "pe", lists: ["goto"] }, open, "none"));
    expect((await out(searchAnswer, { goto }, none, open)).goto!.places).toHaveLength(1);
  });

  it("states `elsewhere` only for a name the reader was shown that holds no placeholder, bracketed or bare", async () => {
    const world = await seeded("all");
    await world.hide([[{ text: "+15550000001", is: "phone" }]]);
    const plain = fixture("people-elsewhere");
    for (const name of ["[[Phone 1]]", "Phone 1", "[[Person 1]]"]) {
      const read = answered(await inOf(searchPeopleParams, { name }, world, "all", ["phone 1 person"]));
      expect(await out(searchPeopleAnswer, plain, read, world), name).not.toHaveProperty("elsewhere");
    }
    const shown = answered(await inOf(searchPeopleParams, { name: "Example Town" }, world, "all", ["Example Town"]));
    expect((await out(searchPeopleAnswer, plain, shown, world)).elsewhere).toHaveLength(3);
    const unshown = answered(await inOf(searchPeopleParams, { name: "Example Town" }, world));
    expect(await out(searchPeopleAnswer, plain, unshown, world)).not.toHaveProperty("elsewhere");
  });

  it("states no place's coordinates or ids at a level that hides, on its own page or among several; at none they are the engine's", async () => {
    const page = fixture("read-place") as { place: Record<string, unknown> };
    const where = /10\.5|20\.2|"latitude"|"longitude"|"radius_m"|"centre"|"also"|"ids"|example-place-id/u;
    for (const level of ["names", "all"] as const) {
      const world = hiding(level);
      const one = await out(readAnswer, page, asked(level, "/v1/read"), world);
      const many = await out(readAnswer, { what: "refs", opened: [page, fixture("read-photo")] }, asked(level, "/v1/read"), world);
      expect(JSON.stringify([one, many]), level).not.toMatch(where);
      expect((one as { place: { visits: unknown[] } }).place.visits).toHaveLength((page.place.visits as unknown[]).length);
    }
    const open = hiding("none");
    expect(JSON.stringify(await out(readAnswer, page, asked("none", "/v1/read"), open))).toMatch(where);
  });

  it("counts each picture that leaves for the outbound row", async () => {
    const world = hiding("all");
    for (const [answer, pictures] of [[fixture("read-photo"), 1], [{ what: "refs", opened: [fixture("read-photo"), fixture("read-photo")] }, 2], [fixture("read-chat"), 0]] as const) {
      const served = await wayOut(readAnswer as Shape<unknown>, answer, asked("all", "/v1/read"), world.hide);
      if (!("answer" in served)) throw new Error(served.wait);
      expect(served.pictures).toBe(pictures);
    }
  });

  it("names every number and every id-like string a level that hides serves of search's lists, every read page and people search: left out by the way out, or known safe", () => {
    const SAFE = [
      "record.total", "record.pending_more", "record.hits[].picture", "record.hits[].rev", "screen.pending_more", "screen.hits[].also", "screen.hits[].app", "screen.unread", "screen.waits",
      "place.days", "place.hours", "place.first_ms", "place.last_ms", "place.visits_count", "place.nights", "place.visits[].start_ms", "place.visits[].end_ms", "place.visits[].unit",
      "place.photos[].at_ms", "place.photos[].image", "place.photos_count", "place.people[].days", "place.people[].photo.crop", "place.people[].photo.card", "pending_more",
      "matches[].chats[].messages", "matches[].reach{}[0]", "match.chats[].messages", "match.reach{}[0]", "elsewhere[].n", "elsewhere[].family",
      "picture", "rev", "app", "lines[].app", "lines[].cites_more", "days[].lines[].cites_more", "latest.lines[].cites_more", "latest.pending_more",
      "record.picture", "records[].picture", "records[].pending_more", "n", "now", "columns[]", "rows[][]",
    ];
    const served = (schema: Record<string, unknown>, path: string, name: string): string[] => {
      const out: string[] = [];
      const at = (inner: unknown, next: string, member: string) => out.push(...served(inner as Record<string, unknown>, next, member));
      const idLike = schema.type === "string" && schema.leaf !== "id"
        && ((schema.leaf === "label" && schema.enum === undefined && schema.pattern === undefined) || /(?:^|_)ids?$/u.test(name));
      if (schema.type === "integer" || schema.type === "number" || idLike) out.push(path);
      for (const each of (schema.anyOf as unknown[] | undefined) ?? []) at(each, path, name);
      for (const [member, inner] of Object.entries((schema.properties as Record<string, unknown> | undefined) ?? {})) at(inner, path === "" ? member : `${path}.${member}`, member);
      if (typeof schema.additionalProperties === "object") at(schema.additionalProperties, `${path}{}`, name);
      if (typeof schema.items === "object") at(schema.items, `${path}[]`, name);
      if (typeof schema.lastItem === "object") at(schema.lastItem, `${path}[-1]`, name);
      ((schema.prefixItems as unknown[] | undefined) ?? []).forEach((each, i) => at(each, `${path}[${i}]`, name));
      return out;
    };
    const search = searchAnswer.schema.properties as Record<string, Record<string, unknown>>;
    const pages = (readAnswer.schema.anyOf as { properties: { what: { enum: string[] } } }[]).map((each) => each.properties.what.enum[0]);
    expect(pages).toEqual(expect.arrayContaining(["record", "chat", "place", "photo", "row", "refs", "lines", "brief", "raw", "screen"]));
    const paths = [...new Set([
      ...served(search.record!, "record", "record"), ...served(search.screen!, "screen", "screen"), ...served(readAnswer.schema, "", ""), ...served(searchPeopleAnswer.schema, "", ""),
    ].map((path) => path.replace(/^opened\[\]\./u, "")))];
    const unstated: readonly string[] = [...UNSTATED["/v1/search"], ...UNSTATED["/v1/read"]];
    const named = (path: string) => SAFE.includes(path) || unstated.some((each) => path === each || path.startsWith(`${each}.`) || path.startsWith(`${each}[]`) || path.startsWith(`${each}{}`));
    expect(paths).toEqual(expect.arrayContaining(["place.ids[]", "place.latitude", "place.photos[].image", "record.picture", "n"]));
    expect(paths.filter((path) => !named(path))).toEqual([]);
  });

  it("serves no label that holds an address or a run of digits, and a place's slug as its name", async () => {
    const world = hiding("all");
    for (const name of Object.keys(PAIRS)) {
      const pair = PAIRS[name]!;
      const shape = pair.route === "refusal" ? searchRefusal : ROUTES[pair.route].answer;
      const each = pair.route === "refusal" ? (fixture(name) as { body: unknown }[]).map(({ body }) => body) : [fixture(name)];
      for (const one of each) expect(labels(one, leavesOf(shape as Shape<unknown>)).filter((label) => /@|\d{5}/u.test(label))).toEqual([]);
    }
    const plain = { ...(fixture("count") as object), counted: "counted from payments as bank:acct:41111111 and gmail:person-a@example.com state them" };
    const counted = await out(countAnswer, plain, asked("all", "/v1/count"), world);
    expect(labels(counted, leavesOf(countAnswer as Shape<unknown>)).filter((label) => /@|\d{5}/u.test(label))).toEqual([]);
    const hit = { ref: REFS[0], family: "mail", product: "bank:acct:41111111" };
    const found = await out(searchAnswer, { record: { total: 1, hits: [hit] } }, asked("all"), world);
    expect(labels(found, leavesOf(searchAnswer as Shape<unknown>)).filter((label) => /@|\d{5}/u.test(label))).toEqual([]);
    const place = await out(readAnswer, fixture("read-place"), asked("all", "/v1/read"), world) as { place: { slug: string; name: string; part_of: { slug: string; name: string } } };
    expect([place.place.slug, place.place.part_of.slug]).toEqual([place.place.name, place.place.part_of.name]);
    expect(JSON.stringify(place)).not.toMatch(/example-cafe/u);
  });

  it("walks a piece-shaped object in an untyped spot as an object, its words hidden", async () => {
    const world = hiding("all");
    const plain = { ...(fixture("search") as object), surprise: { text: "Person A on Example Street" } };
    expect((await out(searchAnswer, plain, asked("all"), world) as { surprise: unknown }).surprise).toEqual({ text: "[[Person 1]] on [[Address 1]]" });
  });

  it("at a level that hides nothing, changes only refs and cursors, each a handle", async () => {
    const world = hiding("none");
    const plain = fixture("search") as Record<string, unknown>;
    const out = await wayOut(searchAnswer as Shape<unknown>, plain, asked("none"), world.hide);
    if (!("answer" in out)) throw new Error(out.wait);
    const handles = (value: unknown): unknown => JSON.parse(JSON.stringify(value).replace(/"(?:record|line|chat|person|place|window)\.[A-Za-z0-9_-]+"|"cursor:[a-z]+:[a-z0-9]+"/gu, '"handle"'));
    expect(handles(JSON.parse(JSON.stringify(out.answer).replace(/"r\d+"/gu, '"handle"')))).toEqual(handles(plain));
  });

  it("walks every refusal by its shape, a guess said back as written", async () => {
    const world = hiding("all");
    const read = answered(await inOf(countParams, { of: "calls", person: ["Person B"] }, world));
    expect(read.params.person).toEqual([`${GUESS}a`]);
    const out = await wayOut(searchRefusal as Shape<unknown>, { code: "PERSON_UNKNOWN", message: `No such person: ${GUESS}a. Find them with \`search_people\`.` }, read, world.hide);
    if (!("answer" in out)) throw new Error(out.wait);
    expect(out.answer).toEqual({ code: "PERSON_UNKNOWN", message: "No such person: Person B. Find them with `search_people`." });
  });
});

describe("the in face", () => {
  it("puts back each handle and placeholder of the calls the contract keeps", async () => {
    const world = await seeded("all");
    const [record, chat, person] = await handed(world, REFS);
    const search = fixture("call-search-hidden") as { args: { query: string; from: string; lists: string[] }; shown: string[] };
    const read = answered(await inOf(searchParams, { ...search.args, chat }, world, "all", search.shown));
    expect(read.params).toEqual({ query: "refund", person: [makeRef("person", { handle: "person:a1" })], chat: REFS[1], from: search.args.from, lists: search.args.lists });
    const count = fixture("call-count-hidden") as { args: Record<string, unknown> };
    const counted = answered(await inOf(countParams, { ...count.args, person: [person], chat }, world));
    expect(counted.params).toMatchObject({ person: [REFS[2]], chat: REFS[1], match: { direction: "outgoing" } });
    const opened = answered(await inOf(readParams, { ...(fixture("call-read-hidden") as { args: object }).args, ref: [record, chat] }, world));
    expect(opened.params).toMatchObject({ ref: [REFS[0], REFS[1]], history: 1 });
  });

  it("names each handle or placeholder the table does not hold, before any read", async () => {
    const world = await seeded("all");
    expect(await inOf(readParams, { ref: "r42" }, world)).toEqual({ unknown: ["r42"] });
    expect(await inOf(searchParams, { query: "[[Person 9]] dinner" }, world)).toEqual({ unknown: ["[[Person 9]]"] });
    expect(await inOf(readParams, { ref: REFS[0] }, world)).toEqual({ unknown: [REFS[0]] });
  });

  it("asks a placeholder's term as every spelling of what it names, quoted, and a plain word only once it stands", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(searchParams, { query: "[[Person 1]] dinner" }, world));
    expect(read.params.query).toBe('"Person A" OR "Per" OR "+15550000001" OR "person-a@example.com" "dinner"');
    expect(read.not_searched).toEqual([]);
  });

  it("leaves out a word that could tell where a hidden detail is, and withholds a search with none left", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(searchParams, { query: "dinner +15550000009" }, world));
    expect(read.not_searched).toEqual(["+15550000009"]);
    expect(read.params.query).toBe('"dinner"');
    expect(await inOf(searchParams, { query: "Example Street" }, world)).toEqual({ withheld: "This search is withheld: each word it must find could tell where a hidden detail is, so none was searched.", not_searched: ["Example", "Street"] });
    const shown = answered(await inOf(searchParams, { query: "Example Street" }, world, "all", ["Example Street"]));
    expect(shown.params.query).toBe("Example Street");
  });

  it("asks the query as written when the level hides nothing", async () => {
    const world = hiding("none");
    const read = answered(await inOf(searchParams, { query: "dinner +15550000009", person: ["Person B"] }, world, "none"));
    expect(read.params).toEqual({ query: "dinner +15550000009", person: ["Person B"] });
  });

  it("asks a guess as a value nothing matches, on every typed parameter", async () => {
    const world = hiding("all");
    const read = answered(await inOf(searchParams, { query: "dinner", person: ["Person B", "+15550000003"] }, world));
    expect(read.params.person).toEqual([`${GUESS}a`, `${GUESS}b`]);
    const shown = answered(await inOf(searchParams, { query: "dinner", person: ["Person B"] }, world, "all", ["Person B"]));
    expect(shown.params.person).toEqual(["Person B"]);
  });

  it("a people search for a name the level hides finds no one and says names are hidden, the same whether anyone has that name; a name it shows says nothing of hiding", async () => {
    const world = hiding("all");
    const peopleOf = async (name: string, shown: readonly string[], matches: unknown[]) => {
      const read = answered(await inOf(searchPeopleParams, { name }, world, "all", shown));
      const through = { engine: async () => ({ status: 200, value: { matches } }), look: world.look, hide: world.hide, marked: () => null, current: () => world.table(), passed: () => false };
      return { asked: read.params, answer: await routed("/v1/people/search", read, through) };
    };
    for (const name of ["Person A", "Person Z"]) {
      const { asked, answer } = await peopleOf(name, [], []);
      expect(asked).toEqual({ name: `${GUESS}a` });
      expect(answer).toEqual({ status: 200, value: { matches: [], note: NAMES_HIDDEN } });
    }
    expect((await peopleOf("Person A", ["Person A"], [])).answer).toEqual({ status: 200, value: { matches: [] } });
  });

  it("goes on from a cursor's handle with page one's terms, alone or beside the arguments as first written", async () => {
    const world = await seeded("all");
    const first = answered(await inOf(searchParams, { query: "[[Person 1]] dinner", limit: 5 }, world));
    const out = await wayOut(searchAnswer as Shape<unknown>, { record: { total: 1, hits: [{ ref: REFS[0], family: "messages", day: "2026-10-04" }], capped: true, next: "cursor:record:k1" } }, first, world.hide);
    if (!("answer" in out)) throw new Error(out.wait);
    const next = (out.answer as { record: { next: string } }).record.next;
    const detail = world.table().entries.find((entry) => entry.placeholder === next)!.detail;
    expect(continuationOf(detail)).toEqual({ of: "cursor:record:k1", asked: { ...first, kept: 1 } });
    const alone = answered(await inOf(searchParams, { cursor: next }, world));
    expect(alone.params).toEqual({ ...first.params, cursor: "cursor:record:k1" });
    expect(alone.terms).toEqual(first.terms);
    expect(alone.kept).toBe(1);
    const beside = answered(await inOf(searchParams, { query: "[[Person 1]] dinner", cursor: next, limit: 9 }, world));
    expect(beside.params).toEqual({ ...first.params, cursor: "cursor:record:k1", limit: 9 });
    await expect(inOf(searchParams, { query: "lunch", cursor: next }, world)).rejects.toThrow(Refusal);
  });

  it("reads a cursor's handle back only at the level it was made for; on another route, BAD_PARAMETER: give it to the route that gave it", async () => {
    const world = await seeded("all");
    const page = async (level: "all" | "none") => {
      const first = answered(await inOf(searchParams, { query: "dinner" }, world, level, ["dinner"]));
      const served = await out(searchAnswer, { record: { total: 1, hits: [], capped: true, next: "cursor:record:k1" } }, first, world);
      return served.record!.next!;
    };
    const none = await page("none");
    expect(await inOf(searchParams, { cursor: none }, world, "all")).toEqual({ unknown: [none] });
    const all = await page("all");
    await expect(inOf(countParams, { cursor: all }, world, "all")).rejects.toMatchObject({ code: "BAD_PARAMETER", words: "`cursor` is the next of another route: give it to the route that gave it." });
    expect("params" in await inOf(searchParams, { cursor: all }, world, "all")).toBe(true);
  });

  it("chooses each parameter's rule by its kind: a parameter with no rule of its own is a guess unless every word was shown", async () => {
    const world = await seeded("all");
    const shape = object({}, { query: text(undefined, undefined, "term"), also: text(undefined, undefined, "term"), note: text(), code: text(undefined, undefined, "id"), tags: text(undefined, undefined, "label") });
    const read = answered(await inOf(shape, { note: "Person A at Example Street", code: "+15550000009", tags: "whatsapp", also: "dinner +15550000008" }, world, "all", [], "/v1/search"));
    expect(read.params).toEqual({ note: `${GUESS}a`, code: `${GUESS}b`, tags: "whatsapp", also: '"dinner"' });
    expect(read.not_searched).toEqual(["+15550000008"]);
    const shown = answered(await inOf(shape, { note: "lunch at [[Person 1]]" }, world, "all", ["lunch at"], "/v1/search"));
    expect(shown.params).toEqual({ note: "lunch at Person A" });
    const place = answered(await inOf(searchParams, { query: "dinner", place: "Example Street" }, world));
    expect(place.params.place).toBe(`${GUESS}a`);
    expect(answered(await inOf(searchParams, { query: "dinner", place: "Example Street" }, world, "all", ["Example Street"])).params.place).toBe("Example Street");
  });

  it("puts a person's placeholder back as the person, never as a name matched by its start", async () => {
    const world = await seeded("all");
    const ref = makeRef("person", { handle: "person:a1" });
    expect(answered(await inOf(searchPeopleParams, { name: "[[Person 1]]" }, world)).params.name).toBe(ref);
    expect(answered(await inOf(countParams, { of: "calls", person: ["[[Person 1]]"] }, world)).params.person).toEqual([ref]);
  });

  it("judges every term as the spec's one rule does: an excluded one that fails asks a guess, a required one is left out and named", async () => {
    const world = hiding("all");
    const both = answered(await inOf(countParams, { of: "calls", words: "+15550000008 -+15550000009" }, world));
    expect([both.params.words, both.not_searched]).toEqual([`"${GUESS}a"`, []]);
    const one = answered(await inOf(countParams, { of: "payments", words: "dinner +15550000008", match: { payee: "acme OR +15550000007" } }, world));
    expect([one.params.words, one.params.match, one.not_searched]).toEqual(['"dinner"', { payee: "acme" }, ["+15550000008", "+15550000007"]]);
    expect(await inOf(countParams, { of: "calls", words: "+15550000008" }, world)).toMatchObject({ withheld: expect.any(String), not_searched: ["+15550000008"] });
  });

  it("keeps a hit read in part only where its words stand in what was read, shown or not", async () => {
    const world = hiding("all");
    const hit = { ref: REFS[0], family: "mail", snippet: "nothing of it here", more: true };
    const seen = { ...hit, snippet: "dinner at eight" };
    for (const shown of [["dinner"], []]) {
      const read = answered(await inOf(searchParams, { query: "dinner" }, world, "all", shown));
      expect(await kept(read, [hit, seen], world.hide, leavesOf(recordHit)), shown.join()).toEqual([seen]);
    }
  });

  it("keeps a hit by a shown word only where the reader sees the word, never where it stands inside a hidden name", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(searchParams, { query: "Person" }, world, "all", ["Person"]));
    expect(read.params.query).toBe("Person");
    const inside = { ref: REFS[0], family: "messages", snippet: "dinner with Person A" };
    expect(await kept(read, [inside], world.hide, leavesOf(recordHit))).toEqual([]);
    const seen = { ref: REFS[0], family: "messages", snippet: "the person at dinner" };
    expect(await kept(read, [seen], world.hide, leavesOf(recordHit))).toEqual([seen]);
  });

  it("takes no word inside a placeholder as a word the reader was shown", async () => {
    const world = await seeded("all");
    expect(answered(await inOf(searchParams, { query: "dinner 1" }, world, "all", ["[[Person 1]] at dinner"])).not_searched).toEqual(["1"]);
    expect(answered(await inOf(searchParams, { query: "dinner 1" }, world, "all", ["dinner at 1"])).not_searched).toEqual([]);
  });

  it("judges a hit over every passage the engine lent, and serves none of them", async () => {
    const world = hiding("all");
    const read = answered(await inOf(searchParams, { query: "invoice overdue" }, world));
    const passages = [{ text: "the invoice for March", names: [] }, { text: "it is now overdue", names: [] }];
    const hit = { ref: REFS[0], family: "mail", snippet: "the «invoice» for March" };
    expect(await kept(read, [{ ...hit, passages }], world.hide, leavesOf(recordHit))).toEqual([{ ...hit, snippet: { ...passages[0], spans: [] } }]);
    expect(await kept(read, [{ ...hit, passages: passages.slice(0, 1) }], world.hide, leavesOf(recordHit))).toEqual([]);
    expect(await kept(asked("none"), [{ ...hit, passages }], world.hide, leavesOf(recordHit))).toEqual([hit]);
  });

  it("serves as a kept hit's snippet the first passage where a word of the query stands once hidden; none when only its title holds them", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(searchParams, { query: "person garden" }, world, "all", ["person garden"]));
    const named = { text: "Person A sent the photos", names: [] };
    const seen = { text: "the person in the garden", names: [] };
    const hit = { ref: REFS[0], family: "messages", title: "notes", snippet: { ...named, spans: [{ start: 0, end: 6 }] } };
    const [one] = await kept(read, [{ ...hit, passages: [named, seen] }], world.hide, leavesOf(recordHit)) as Record<string, unknown>[];
    expect(one!.snippet).toEqual({ ...seen, spans: [] });
    const served = await out(searchAnswer, { record: { total: 1, hits: [one] } }, read, world) as { record: { hits: { snippet: string }[] } };
    expect(served.record.hits[0]!.snippet).toBe("the «person» in the «garden»");
    const titled = await kept(read, [{ ...hit, title: "person garden plan", passages: [named] }], world.hide, leavesOf(recordHit)) as Record<string, unknown>[];
    expect(titled).toHaveLength(1);
    expect(titled[0]).not.toHaveProperty("snippet");
    expect(await kept(answered(await inOf(searchParams, { from: "2026-01-01" }, world)), [{ ...hit, passages: [named] }], world.hide, leavesOf(recordHit))).toEqual([hit]);
  });

  it("counts a shown word only where it stands visible: never inside a hidden value, a hidden passage or a screen line's hidden name", async () => {
    const world = await seeded("all");
    const read = answered(await inOf(countParams, { of: "payments", words: "person", match: { payee: "person" } }, world, "all", ["person"]));
    const terms = read.match!.payee!.map(({ term }) => term);
    const passages = { named: [{ text: "Person A sent it", names: [] }], seen: [{ text: "a person sent it", names: [] }] };
    const candidates = {
      snapshot: {}, persons: [],
      match: { payee: { terms, values: [{ name: 0, value: "Person A Florist" }, { name: 1, value: "the person shop" }] } },
      words: { terms: read.terms.words!.terms, required: { facts: { f1: passages.named, f2: passages.seen }, slots: {}, end: "whole" } },
    } as unknown as Candidates;
    const stands = await standsFor(read, world.look, () => null)(candidates);
    if ("stop" in stands) throw new Error(JSON.stringify(stands.stop));
    expect([0, 1].map((name) => stands.value("payee", terms[0]!, 0, { name, value: name === 0 ? "Person A Florist" : "the person shop" }))).toEqual([false, true]);
    const term = { index: 0, words: ["person"], prefix: false };
    expect([stands.fact(read.terms.words!.terms[0]!, 0, term, "f1", passages.named), stands.fact(read.terms.words!.terms[0]!, 0, term, "f2", passages.seen)]).toEqual([false, true]);
    const screen = answered(await inOf(searchParams, { query: "person", lists: ["screen"] }, world, "all", ["person"]));
    const window = (line: string) => ({ ref: REFS[0], title: "Notes", snippet: line, reason: "words", terms: [{ word: "person", forms: [["person"]], lines: [line] }] });
    const found = await screenKept(screen, [window("Person A sent it"), window("a person sent it")], world.hide);
    if ("wait" in found) throw new Error(found.wait);
    expect(found.hits.map((hit) => hit.snippet)).toEqual([{ text: "a person sent it", names: [], spans: [] }]);
  });

  it("requires no group of words the engine read the query without", async () => {
    const world = hiding("all");
    const read = answered(await inOf(searchParams, { query: "say about the garden party" }, world, "all", ["say about the garden party"]));
    const hit = { ref: REFS[0], family: "messages", snippet: "they say the garden party ran late" };
    expect(await kept(read, [hit], world.hide, leavesOf(recordHit))).toEqual([]);
    expect(await kept(read, [hit], world.hide, leavesOf(recordHit), ["about"])).toEqual([hit]);
    expect(await kept(read, [hit], world.hide, leavesOf(recordHit), ["about", "garden"])).toEqual([hit]);
    expect(await kept(read, [{ ...hit, snippet: "they say the party ran late" }], world.hide, leavesOf(recordHit), ["about"])).toEqual([]);
  });

  it("puts back a placeholder written bare that the table holds, as its brackets would", async () => {
    const world = await seeded("all");
    for (const [shape, args, bracketed] of [
      [searchPeopleParams, { name: "Person 1" }, { name: "[[Person 1]]" }],
      [searchParams, { query: "Person 1 dinner" }, { query: "[[Person 1]] dinner" }],
      [countParams, { of: "calls", person: ["Person 1"] }, { of: "calls", person: ["[[Person 1]]"] }],
    ] as const) {
      const bare = answered(await inOf(shape as Shape<unknown>, args, world, "all", [], ROUTE_OF.get(shape)));
      const put = answered(await inOf(shape as Shape<unknown>, bracketed, world, "all", [], ROUTE_OF.get(shape)));
      expect(bare.params, JSON.stringify(args)).toEqual(put.params);
    }
    expect(answered(await inOf(searchParams, { query: "Person 2 dinner" }, world)).not_searched).toContain("2");
  });

  it("imports of the engine only types, pure word functions, the count's pure steps, the search's page size and its rounds' width", () => {
    const source = readFileSync(fileURLToPath(new URL("./way-out.ts", import.meta.url)), "utf8");
    const values = [...source.matchAll(/^import (?!type )[^;]*? from "\.\/([^"]+)\.js";/gmsu)].map((match) => match[1]).sort();
    expect(values).toEqual(["count", "refs", "refusal", "search-contract", "search-route", "search-words"]);
    expect(/^import \{ ([^}]*) \} from "\.\/count\.js";/mu.exec(source)?.[1]).toBe("admit, ALWAYS, TRIES, walkEndOf, type Candidates, type Snapshot, type Stands");
    expect(/^import \{ ([^}]*) \} from "\.\/search-route\.js";/mu.exec(source)?.[1]).toBe("ROUND_WIDTH, SEARCH_LIMIT, type Copies, type MeaningLent, type Widened");
  });

  it("refuses a body that names a table, a level or an epoch", () => {
    const call = { args: { query: "a" }, to: "anthropic", shown: [] };
    for (const extra of [{ table: "chat:c-1" }, { level: "none" }, { epoch: 3 }]) expect(() => ROUTES["/v1/search"].call.parse({ ...call, ...extra })).toThrow("is no member");
  });
});

describe("a sealed person in the in face", () => {
  const sealedOf = <P>(shape: Shape<P>, args: unknown, world: Hiding, level: "all" | "none", sealed: Sealed | undefined) => {
    const seal = sealOf(PEOPLE, sealed);
    return wayIn(ROUTE_OF.get(shape) ?? "/v1/search", shape, args, world.table(), level, new Set(), PEOPLE, world.look, seal === null ? undefined : { seal, open: world.look });
  };
  const nothingWith = (...people: string[]): Sealed => ({ people: new Set(people), handles: [] });

  it("asks a sealed name or number as a value nothing matches at none: in a query its words alone, a name whole; anyone else's as written", async () => {
    const world = hiding("none");
    const read = answered(await sealedOf(searchParams, { query: "Person B dinner OR +15550000003", person: ["Person B", "Person A"] }, world, "none", nothingWith("person:b")));
    expect(read.params).toEqual({ query: `${GUESS}a dinner OR ${GUESS}b`, person: [`${GUESS}c`, "Person A"] });
    expect(read.placed.map((each) => [each.written, each.as])).toEqual([["Person B", "guess"], ["+15550000003", "guess"], ["Person B", "guess"]]);
    expect(answered(await sealedOf(searchPeopleParams, { name: "Person B" }, world, "none", nothingWith("person:b"))).params.name).toBe(`${GUESS}a`);
    expect(answered(await sealedOf(searchParams, { query: "Person B dinner", person: ["Person B"] }, world, "none", undefined)).params).toEqual({ query: "Person B dinner", person: ["Person B"] });
  });

  it("asks a sealed person's placeholder as a guess, never as the person or their names, at every level", async () => {
    const world = await seeded("all");
    for (const level of ["all", "none"] as const) {
      const read = answered(await sealedOf(searchParams, { query: "[[Person 1]] dinner" }, world, level, nothingWith("person:a1")));
      expect(read.params.query).toBe(level === "all" ? `"${GUESS}a" "dinner"` : `${GUESS}a dinner`);
      expect(answered(await sealedOf(searchPeopleParams, { name: "[[Person 1]]" }, world, level, nothingWith("person:a1"))).params.name).toBe(`${GUESS}a`);
    }
  });
  it("under only, a name or number of anyone not listed is a guess, the listed one's, the owner's and a value that names no one as written; under a person sealed, a name two people share is a guess", async () => {
    const world = hiding("none");
    const only = answered(await sealedOf(searchParams, { query: "dinner", person: ["Person B", "Owner Example", "Person A", "Zed Nobody", "me", "+15550000001", "+15550000777"] }, world, "none", { except: new Set(["person:b"]) }));
    expect(only.params.person).toEqual(["Person B", "Owner Example", `${GUESS}a`, "Zed Nobody", "me", `${GUESS}b`, `${GUESS}c`]);
    const shared = answered(await sealedOf(searchParams, { query: "dinner", person: ["Person A", "Person B"] }, world, "none", nothingWith("person:a1")));
    expect(shared.params.person).toEqual([`${GUESS}a`, "Person B"]);
  });

  it("a term the hider hides only for the seal is a guess, never left out as not searched", async () => {
    const world = hiding("all");
    const sealedLook: Hide = async (texts) => {
      const out = await world.look(texts);
      return "texts" in out ? { texts: out.texts.map((each) => (typeof each === "string" ? each.replaceAll("dinner", "[[Word 9]]") : each)) } : out;
    };
    const seal = sealOf(PEOPLE, nothingWith("person:b"))!;
    const read = answered(await wayIn("/v1/search", searchParams, { query: "dinner garden" }, world.table(), "all", new Set(), PEOPLE, sealedLook, { seal, open: world.look }));
    expect({ query: read.params.query, not_searched: read.not_searched }).toEqual({ query: `"${GUESS}a" "garden"`, not_searched: [] });
    const unsealed = answered(await wayIn("/v1/search", searchParams, { query: "dinner garden" }, world.table(), "all", new Set(), PEOPLE, sealedLook));
    expect(unsealed.not_searched).toEqual(["dinner"]);
  });
});

describe("the old hidden search's in-face cases, carried", () => {
  const withheld = "This search is withheld: each word it must find could tell where a hidden detail is, so none was searched.";

  it("withholds a search whose every required term is a seeded phone's first digits or a seeded name, and asks an excluded seeded name as a guess", async () => {
    const world = await seeded("all");
    for (const [query, not] of [["555-000", ["555-000"]], ['"Person A"', ["Person A"]], ['"Person A" OR 555', ["Person A", "555"]]] as const) {
      expect(await inOf(searchParams, { query }, world), query).toEqual({ withheld, not_searched: not });
    }
    const excluded = answered(await inOf(searchParams, { query: 'dinner -"Person A"' }, world));
    expect([excluded.params.query, excluded.not_searched]).toEqual([`"${GUESS}a"`, []]);
  });

  it("keeps an OR group's admitted alternatives, runs an AND query without the word that fails, and starts a group whose first alternative left out at the next", async () => {
    const world = await seeded("all");
    for (const [query, asked, not] of [
      ['zebra OR "Person A" OR kombuchas', '"zebra" OR "kombuchas"', ["Person A"]],
      ['lighthouse "Person A" 4471', '"lighthouse"', ["Person A", "4471"]],
      ['"Person A" OR zebra plain', '"zebra" "plain"', ["Person A"]],
      ['lighthouse "Person A" OR zebra', '"lighthouse" "zebra"', ["Person A"]],
    ] as const) {
      const read = answered(await inOf(searchParams, { query }, world));
      expect([read.params.query, read.not_searched], query).toEqual([asked, not]);
    }
  });

  it("leaves out every term with a digit, a date's too, and searches the words beside it", async () => {
    const world = hiding("all");
    for (const query of ['"13 January 2027"', "2026-10-12", "2027", '"January 2027"', "13/01/2027", "2282"]) {
      expect(await inOf(searchParams, { query }, world), query).toEqual({ withheld, not_searched: [query.replaceAll('"', "")] });
    }
    for (const [query, asked] of [["flight 2027", '"flight"'], ["card 2282", '"card"']] as const) {
      const read = answered(await inOf(searchParams, { query }, world));
      expect([read.params.query, read.not_searched], query).toEqual([asked, [query.split(" ")[1]]]);
    }
  });

  it("asks a near spelling only of a term the reader was shown: an unshown term is asked exact, so a hidden twin of its near spelling is never read", async () => {
    const world = hiding("all");
    expect(answered(await inOf(searchParams, { query: "lighthose" }, world)).params.query).toBe('"lighthose"');
    expect(answered(await inOf(searchParams, { query: "lighthose" }, world, "all", ["the lighthose was lovely"])).params.query).toBe("lighthose");
  });

  it("refuses a parameter the contract does not take, FTS5's syntax among them, at every level", async () => {
    for (const level of ["none", "all"] as const) {
      await expect(inOf(searchParams, { query: "dinner", syntax: "fts5" }, hiding(level), level)).rejects.toMatchObject({ code: "BAD_PARAMETER" });
    }
  });

  it("hides a stretch's screen lines one at a time, each a text of its own", async () => {
    const world = hiding("all");
    const plain = fixture("read-screen") as never as { what: "screen"; span: { from: string; to: string }; lines: { at: string; text: string }[] };
    plain.lines[1]!.text = "call Person B at +15550000003";
    const texts: string[] = [];
    const served = await wayOut(readAnswer, plain, asked("all", "/v1/read"), async (each) => {
      for (const text of each) if (Array.isArray(text)) texts.push(text.map((piece) => piece.text).join(""));
      return world.hide(each);
    });
    if (!("answer" in served)) throw new Error(served.wait);
    const lines = (served.answer as { lines: { text: string }[] }).lines;
    expect(lines.map((line) => line.text)).toEqual(["Your trip to Example City", expect.stringMatching(/^call \[\[Person \d+\]\] at \[\[Phone \d+\]\]$/u)]);
    expect(texts).toEqual(expect.arrayContaining(["Your trip to Example City", "call Person B at +15550000003"]));
  });

  it("cuts a snippet that never crosses a placeholder", () => {
    const between = " and then a good many more words came along, before the long ";
    const text = `${"words ".repeat(10)}[[Person 1]]${between}lighthouse at the far end`;
    const at = text.indexOf("lighthouse");
    expect(at - 70).toBeGreaterThan(text.indexOf("[["));
    expect(at - 70).toBeLessThan(text.indexOf(" 1]]"));
    expect(snippetAt(text, [{ start: at, end: at + "lighthouse".length }], placeholderSpans(text))).toBe(`…[[Person 1]]${between}«lighthouse» at the far end`);
  });
});

describe("the items a read returned", () => {
  const MAIL = "gmail:person-a@example.com";
  const CHATS = "whatsapp:15550000001";
  const ACCOUNTS = [{ account: MAIL, category: "mail" as const }, { account: CHATS, category: "messages" as const }];
  const DAY = "2026-11-13";
  const message = (key: string) => makeRef("record", { source: `${CHATS}:iphone-aa01`, kind: "msg", key });
  const line = (m: number, family: string) => ({ ref: makeRef("line", { day: DAY, same: "0123456789abcdef", m, unit: `u-${m}`, item: null }), family, text: "a line" });
  const total = (came: Record<string, number>) => Object.values(came).reduce((sum, n) => sum + n, 0);

  it("are as many as `came` counts, for a search answer and a day answer", () => {
    const search = {
      person: [{ asked: "Ada", name: "Ada", ref: makeRef("person", { handle: "15550000002" }) }],
      record: { total: 4, hits: [{ ref: message("m-1"), family: "messages" }, { ref: message("m-2"), family: "messages" }, line(1, "mail"), line(2, "calendar")] },
    };
    const day = { what: "lines", span: { from: DAY, to: DAY }, lines: [line(1, "mail"), line(2, "messages"), { text: "a line with no ref" }] };
    for (const [tool, answer] of [["search", search], ["read", day]] as const) {
      expect(itemsOf(tool, answer, ACCOUNTS)).toHaveLength(total(cameOf(tool, answer, ACCOUNTS)));
    }
    expect(itemsOf("search", search, ACCOUNTS)[0]).toEqual({ kind: "messages", ref: message("m-1"), source: `${CHATS}:iphone-aa01`, rkind: "msg", key: "m-1", day: null });
  });

  it("keep each of a day's 22 lines as its own item with its day, never one item for the day", () => {
    const day = { what: "lines", span: { from: DAY, to: DAY }, lines: Array.from({ length: 22 }, (_, m) => line(m, "messages")) };
    const items = itemsOf("read", day, ACCOUNTS);
    expect(items).toHaveLength(22);
    expect(new Set(items.map((each) => each.ref)).size).toBe(22);
    expect(items.every((each) => each.day === DAY && each.kind === "messages" && each.source === null)).toBe(true);
  });

  it("name the cursor parameter of every reading tool", () => {
    expect([...CURSOR_PARAMS]).toEqual(["cursor"]);
  });
});
