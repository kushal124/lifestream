import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DAYS_MARK, openHome, openHomeFolder, type DaySettings, type JsonObject } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, type DayFileFact, type Family, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { ErasableStreams } from "./erasable-streams.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { peopleSearchAnswer } from "./people-search.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { openReads, type Reply } from "./reads.js";
import { makeRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import { answerOf, countParams, paramsOf, ROUTES, searchParams, type ContractPath } from "./search-contract.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import { recordPartOf, searchAskedOf } from "./search-route.js";
import type { Settings } from "./settings.js";
import { collectionsOf, countAskedOf, countIn, plainCount } from "./count.js";
import { onCall } from "./test/calls.js";


const dir = mkdtempSync(join(tmpdir(), "lifestream-call-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BUILT: DaySettings = { zone: "UTC", day_start_hour: 0 };
const MOVED: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const DAY = "2026-11-02";
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const AT = D(DAY, "03:30");
const now_ms = D("2026-11-13");

const callFact = (key: string, at: number, handle: string): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: at, start_ms: at, end_ms: at + 600_000,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes: 10 }, who: [{ handle, role: "receiver" }],
  from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});

function person(id: string, name: string, handles: string[]): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: [], also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })),
  } as unknown as PersonDetail;
}
const ADA = person("person:ada", "Ada Example", ["phone:+15550000001"]);
const searched = (detail: PersonDetail): Searched => ({ id: detail.id, words: detail.name.toLowerCase().split(" "), values: ["15550000001"], phones: ["15550000001"] }) as unknown as Searched;

function homeOf(name: string) {
  const root = join(dir, name);
  const machine = join(dir, `${name}-machine`);
  mkdirSync(join(root, "days"), { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  home.close();
  const families = [{ name: "calls", collections: CALLS_COLLECTIONS }, { name: "notes" }] as unknown as Family[];
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: MOVED }) as Settings,
    registry: { connectors: [], readers: [], families } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const index = () => {
    const built = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, BUILT);
    built.records([{ record: { source: "wa:local:a", kind: "call", key: "c1" }, family: "calls", version: "v1", start_ms: AT, end_ms: AT + 600_000, title: "", text: "a call with Ada", who: [], link: null }], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    built.day(DAY, {
      inputs: "in-1", mtime_us: 1,
      atoms: [{ n: 1, family: "calls", unit: "calls/c1", record: { source: "wa:local:a", kind: "call", key: "c1" }, start_ms: AT, end_ms: AT + 600_000, text: "a call with Ada" }],
      facts: { window: { start_ms: D(DAY, "00:00"), end_ms: D(DAY, "00:00") + 86_400_000 }, facts: [callFact("c1", AT, "phone:+15550000001")] },
    });
    built.finish();
    built.close();
    return SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine))!;
  };
  const people = () => writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, {
    rows: new Map<string, Map<string, JsonObject>>([
      ["answer", new Map([["list", { people: [], chats: [] } as unknown as JsonObject]])],
      ["person", new Map([[ADA.id, { person: ADA } as unknown as JsonObject]])],
      ["alias", new Map([[ADA.id, { id: ADA.id } as JsonObject], ["phone:+15550000001", { id: ADA.id } as JsonObject]])],
      ["names", new Map([["all", { people: [searched(ADA)] } as unknown as JsonObject]])],
    ]),
    position: "1:1",
  });
  const asked = async (url: string): Promise<{ status: number; body: Record<string, any> }> => {
    const path = new URL(url, "http://door").pathname;
    try {
      const reply = await (reads.reply(path)!({ url, now_ms, held: { machine } as never }) as Reply | Promise<Reply>);
      return { status: reply.status ?? 200, body: JSON.parse(String(reply.body)) as Record<string, any> };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      return { status: error.status, body: { code: error.code, message: error.words, ...error.extra } };
    }
  };
  return { root, machine, reads, index, people, asked, families };
}

const ASKS: Record<ContractPath, string> = {
  "/v1/search": "/v1/search?lists=record&query=call",
  "/v1/count": "/v1/count?of=calls",
  "/v1/people/search": "/v1/people/search?name=ada",
  "/v1/read": `/v1/read?from=${DAY}&to=${DAY}&detail=lines`,
  "/v1/describe": `/v1/describe?ref=${encodeURIComponent(makeRef("line", { day: DAY, same: "0000000000000000", m: 0, unit: "notes/a", item: null }))}`,
};

describe("the one registration", () => {
  it("A1 every route of the contract answers through it: a parameter none names is the same BAD_PARAMETER on all four", async () => {
    const { asked } = homeOf("a1");
    const paths = Object.keys(ROUTES).filter((path) => path !== "/v1/search/state") as ContractPath[];
    expect(paths.sort()).toEqual(Object.keys(ASKS).sort());
    const refusals = await Promise.all(paths.map((path) => asked(`${ASKS[path]}&nonsense=1`)));
    for (const [at, refusal] of refusals.entries()) {
      expect(refusal, paths[at]).toEqual({ status: 422, body: { code: "BAD_PARAMETER", message: "`nonsense` is not an argument this takes." } });
      expect(answerOf(paths[at]!, refusal.status, refusal.body)).toMatchObject({ code: "BAD_PARAMETER" });
    }
  });

  it("A2 no index yet: INDEX_BUILDING naming `words` and nothing else, on all four, each held to the contract's refusal", async () => {
    const { asked } = homeOf("a2");
    for (const [path, url] of Object.entries(ASKS) as [ContractPath, string][]) {
      const refusal = await asked(url);
      expect(refusal, path).toEqual({ status: 503, body: { code: "INDEX_BUILDING", message: "the search index is being built", building: ["words"] } });
      expect(answerOf(path, refusal.status, refusal.body)).toMatchObject({ code: "INDEX_BUILDING" });
    }
  });
});

describe("one clock", () => {
  it("C1 the home's day settings moved since the index was built: a part of a day read and counted is one span, the index's", async () => {
    const { asked, index, people } = homeOf("c1");
    index().close();
    people();
    const span = `from=${DAY}T03:00&to=${DAY}T04:00`;
    const read = await asked(`/v1/read?${span}&detail=lines`);
    expect(read.status).toBe(200);
    expect(read.body.lines.map((line: { text: string }) => line.text)).toEqual(["a call with Ada"]);
    expect(read.body.span.from).toMatch(/^2026-11-02T03:00(?::00)?(?:Z|\+00:00)$/u);
    const counted = await asked(`/v1/count?of=calls&${span}`);
    expect(counted.status).toBe(200);
    expect(counted.body.total.n).toBe(1);
    const found = await asked(`/v1/search?lists=record&query=call&${span}`);
    expect(found.body.record.hits).toHaveLength(1);
  });
});

describe("one call, each store once", () => {
  it("O1 a search naming a person with Go to, a count and search_people on one call open the index once and People's file once", () => {
    const { root, machine, index, people, families } = homeOf("o1");
    const built = index();
    people();
    const hold = vi.spyOn(built, "hold");
    const file = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
    onCall({ index: built, peopleFile: file, home: join(root, "home.db"), now_ms, families }, (call) => {
      recordPartOf(searchAskedOf(paramsOf(searchParams, new URLSearchParams({ lists: "record", query: "ada", person: "Ada Example" }))), call).answer;
      recordPartOf(searchAskedOf(paramsOf(searchParams, new URLSearchParams([["lists", "record"], ["lists", "goto"], ["query", "ada"]]))), call).answer;
      const asked = countAskedOf(paramsOf(countParams, new URLSearchParams({ of: "calls", person: "Ada Example" })), collectionsOf(families));
      countIn(call, asked, (read, counted, context) => plainCount(read, counted, context));
      peopleSearchAnswer(call, { name: "ada" });
      expect(Object.fromEntries(call.opens)).toMatchObject({ index: 1, people: 1 });
      expect([...call.opens.values()].every((opens) => opens === 1)).toBe(true);
    });
    expect(hold).toHaveBeenCalledTimes(1);
    built.close();
  });
});

describe("the call's meter", () => {
  it("M1 count and search_people read on the call's meter: past it, the count is TOO_BROAD and search_people capped, in the contract's words", () => {
    const { root, machine, index, people, families } = homeOf("m1");
    const built = index();
    people();
    const file = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
    const asked = countAskedOf(paramsOf(countParams, new URLSearchParams({ of: "calls", by: "item" })), collectionsOf(families));
    const counted = (budget: number) => onCall({ index: built, home: join(root, "home.db"), now_ms, families, budget }, (call) => countIn(call, asked, (read, each, context) => plainCount(read, each, context)));
    expect(() => counted(Infinity)).not.toThrow();
    let refusal: unknown;
    try {
      counted(2);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Refusal);
    expect(answerOf("/v1/count", (refusal as Refusal).status, { code: (refusal as Refusal).code, message: (refusal as Refusal).words, ...(refusal as Refusal).extra })).toMatchObject({ code: "TOO_BROAD" });
    const whole = onCall({ index: built, peopleFile: file, home: join(root, "home.db"), now_ms, families }, (call) => peopleSearchAnswer(call, { name: "ada" }));
    expect(whole.capped).toBeUndefined();
    const capped = onCall({ index: built, peopleFile: file, home: join(root, "home.db"), now_ms, families, budget: 3 }, (call) => peopleSearchAnswer(call, { name: "ada" }));
    expect(capped.capped).toBe(true);
    expect(answerOf("/v1/people/search", 200, JSON.parse(JSON.stringify(capped)))).toMatchObject({ capped: true });
    built.close();
  });
});

describe("not ready, and gone, one way on every route", () => {
  it("N1 People not prepared: a person asked of search or count, and search_people, are INDEX_BUILDING naming `people`", async () => {
    const { asked, index } = homeOf("n1");
    index().close();
    for (const url of ["/v1/search?lists=record&person=Ada", "/v1/count?of=calls&person=Ada", "/v1/people/search?name=ada"]) {
      const refusal = await asked(url);
      expect(refusal, url).toEqual({ status: 503, body: { code: "INDEX_BUILDING", message: "your people are being prepared", building: ["people"] } });
    }
  });

  it("N2 Places not ready: a place asked of search or count, and a place's ref read, are INDEX_BUILDING naming `places`; an `at` states the home's zone", async () => {
    const { asked, index, people } = homeOf("n2");
    index().close();
    people();
    for (const url of ["/v1/search?lists=record&query=call&place=Lisbon", "/v1/count?of=calls&place=Lisbon", `/v1/read?ref=${encodeURIComponent(makeRef("place", { id: "lisbon" }))}`]) {
      const refusal = await asked(url);
      expect(refusal.status, url).toBe(503);
      expect(refusal.body, url).toMatchObject({ code: "INDEX_BUILDING", building: ["places"] });
    }
    const found = await asked("/v1/search?lists=record&query=call");
    expect(found.body.record.hits[0].at).toMatch(/^2026-11-02T03:30(?::00)?(?:Z|\+00:00)$/u);
  });

  it("N3 a ref that names nothing now: `gone` on read, BAD_PARAMETER naming its parameter on search, count and search_people", async () => {
    const { asked, index, people } = homeOf("n3");
    index().close();
    people();
    const nobody = makeRef("person", { handle: "person:nobody" });
    for (const [url, member] of [[`/v1/search?lists=record&person=${encodeURIComponent(nobody)}`, "person"], [`/v1/count?of=calls&person=${encodeURIComponent(nobody)}`, "person"], [`/v1/people/search?id=${encodeURIComponent(nobody)}`, "id"]] as const) {
      const refusal = await asked(url);
      expect(refusal.status, url).toBe(422);
      expect(refusal.body.code, url).toBe("BAD_PARAMETER");
      expect(refusal.body.message, url).toMatch(new RegExp(`^\`${member}\` names no`, "u"));
    }
    const read = await asked(`/v1/read?ref=${encodeURIComponent(nobody)}`);
    expect(read).toMatchObject({ status: 200, body: { what: "gone", ref: nobody } });
  });
});

describe("the search's ETag", () => {
  it("E1 /v1/search answers with its body's ETag: If-None-Match with it is 304 while the answer stands, the index read further or not; another answer, a whole one", async () => {
    const { root, machine, reads, index } = homeOf("e1");
    index().close();
    const reply = async (url: string, tag?: string): Promise<Reply> =>
      await (reads.reply("/v1/search")!({ url, now_ms, held: { machine } as never, ...(tag === undefined ? {} : { if_none_match: tag }) }) as Reply | Promise<Reply>);
    const url = "/v1/search?lists=record&query=call";
    const first = await reply(url);
    const etag = first.headers.etag!;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/u);
    expect((await reply(url)).headers.etag).toBe(etag);
    expect(await reply(url, etag)).toMatchObject({ status: 304, body: "", headers: { etag } });
    const other = await reply("/v1/search?lists=record&query=ada", etag);
    expect(other.status).toBe(200);
    expect(other.headers.etag).not.toBe(etag);
    const writer = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, BUILT);
    writer.records([], [], { position: { seq: 2, statement: "s-2", reread: 0 } });
    writer.close();
    expect(await reply(url, etag)).toMatchObject({ status: 304, headers: { etag } });
    const more = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, BUILT);
    more.records([{ record: { source: "wa:local:a", kind: "call", key: "c2" }, family: "calls", version: "v1", start_ms: AT + 3_600_000, end_ms: null, title: "", text: "another call", who: [], link: null }], [], { position: { seq: 3, statement: "s-3", reread: 0 } });
    more.close();
    const moved = await reply(url, etag);
    expect(moved.status).toBe(200);
    expect(moved.headers.etag).not.toBe(etag);
    expect(JSON.parse(String(moved.body)).record.hits).toHaveLength(2);
  });
});
