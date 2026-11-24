import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DAYS_MARK, openHome, openHomeFolder, type DaySettings, type JsonObject } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, type DayFileFact, type Family, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { ErasableStreams } from "./erasable-streams.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { peopleOne } from "./people-search.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { openReads, type Reply } from "./reads.js";
import { makeRef, personRef, readRef, REF_CHARS } from "./refs.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import { answerOf, countParams, paramsOf, searchParams, type ContractPath } from "./search-contract.js";
import { recordPartOf, searchAskedOf } from "./search-route.js";
import { collectionsOf, countAskedOf, countIn, countShown, plainCount } from "./count.js";
import { SearchIndex, searchFileOf, type AtomEntry, type RecordEntry } from "./search-index.js";
import type { Settings } from "./settings.js";
import { onCall } from "./test/calls.js";


const dir = mkdtempSync(join(tmpdir(), "lifestream-count-door-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLOCK: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAY = "2026-11-02";
const LATER = "2026-11-03";
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const now_ms = D("2026-11-13");
const CHAT = "whatsapp:15550000001@s.whatsapp.net";
const H1 = "phone:+15550000001";
const H2 = "email:person-a@example.com";
const H3 = "phone:+15550000003";

interface Called {
  key: string;
  day: string;
  time: string;
  handle: string;
  text: string;
}
const record = (key: string) => ({ source: "wa:local:a", kind: "call", key });
const factOf = (call: Called): DayFileFact => ({
  id: `calls:${call.key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: D(call.day, call.time), start_ms: D(call.day, call.time), end_ms: D(call.day, call.time) + 600_000,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected", chat: CHAT }, measures: { minutes: 10 }, who: [{ handle: call.handle, role: "receiver" }],
  from: { units: [`calls/${call.key}`], record: record(call.key), alone: true }, lines: [],
});
const entryOf = (call: Called): RecordEntry => ({
  record: record(call.key), family: "calls", version: `v-${call.key}`, start_ms: D(call.day, call.time), end_ms: D(call.day, call.time) + 600_000, title: "", text: call.text,
  who: [call.handle.slice(call.handle.indexOf(":") + 1)], link: null,
});

function person(id: string, name: string, handles: readonly string[]): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: [], also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })),
  } as unknown as PersonDetail;
}

function homeOf(name: string) {
  const root = join(dir, name);
  const machine = join(dir, `${name}-machine`);
  mkdirSync(join(root, "days"), { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  home.close();
  const families = [{ name: "calls", collections: CALLS_COLLECTIONS }] as unknown as Family[];
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: CLOCK }) as Settings,
    registry: { connectors: [], readers: [], families } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const file = searchFileOf(root, machine);
  let seq = 0;
  const index = (calls: readonly Called[]) => {
    const first = seq === 0;
    const writer = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, CLOCK);
    writer.records(calls.map(entryOf), [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
    for (const day of new Set(calls.map((call) => call.day))) {
      const today = calls.filter((call) => call.day === day);
      const atoms: AtomEntry[] = today.map((call, n) => ({ n: n + 1, family: "calls", unit: `calls/${call.key}`, record: record(call.key), start_ms: D(day, call.time), end_ms: D(day, call.time) + 600_000, text: call.text }));
      writer.day(day, { inputs: `in-${day}-${seq}`, mtime_us: seq, atoms, facts: { window: { start_ms: D(day, "00:00"), end_ms: D(day, "00:00") + 86_400_000 }, facts: today.map(factOf) } });
    }
    if (first) writer.finish();
    writer.close();
  };
  const peopleFile = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
  let version = 0;
  const people = (persons: readonly PersonDetail[]) => writePrepared(openHomeFolder(dirname(peopleFile)), peopleFile, PEOPLE, {
    rows: new Map<string, Map<string, JsonObject>>([
      ["answer", new Map([["list", { people: [], chats: [] } as unknown as JsonObject]])],
      ["person", new Map(persons.map((each) => [each.id, { person: each } as unknown as JsonObject]))],
      ["alias", new Map(persons.flatMap((each) => [[each.id, { id: each.id }], ...each.handles.map((handle) => [handle.id, { id: each.id }])] as [string, JsonObject][]))],
      ["names", new Map([["all", { people: persons.map((each): Searched => ({ id: each.id, words: each.name.toLowerCase().split(" "), values: [], phones: [] }) as unknown as Searched) } as unknown as JsonObject]])],
    ]),
    position: `1:${++version}`,
  });
  const asked = async (url: string, tag?: string): Promise<{ status: number; body: Record<string, any>; etag?: string }> => {
    const path = new URL(url, "http://door").pathname as ContractPath;
    try {
      const reply = await (reads.reply(path)!({ url, now_ms, held: { machine } as never, ...(tag === undefined ? {} : { if_none_match: tag }) }) as Reply | Promise<Reply>);
      const status = reply.status ?? 200;
      const body = status === 304 ? {} : JSON.parse(String(reply.body)) as Record<string, any>;
      if (status === 200) answerOf(path, 200, body);
      return { status, body, ...(reply.headers?.etag === undefined ? {} : { etag: reply.headers.etag }) };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const body = { code: error.code, message: error.words, ...error.extra };
      answerOf(path, error.status, body);
      return { status: error.status, body };
    }
  };
  return { root, machine, index, people, peopleFile, asked, families, file };
}

const url = (path: string, params: Record<string, string>) => `${path}?${new URLSearchParams(params)}`;
const factsOf = (read: Record<string, any>): string[] => (read.rows as unknown[][]).map((row) => row.at(-1) as string).sort();
const refOf = (key: string) => makeRef("record", record(key));

describe("a person inside a row is held by handles", () => {
  it("S6a a count by a person whose handles pass the bound: its row narrows each to their lowest handle, says so, and opens over them", async () => {
    const { asked, index, people } = homeOf("s6a");
    const many = Array.from({ length: 160 }, (_, at) => `email:person-many-${String(at).padStart(3, "0")}@example.com`);
    index([{ key: "c1", day: DAY, time: "09:00", handle: many[100]!, text: "a call" }, { key: "c2", day: DAY, time: "10:00", handle: H3, text: "a call" }]);
    const MANY = person("person:many", "Many Example", many);
    people([MANY, person("person:bea", "Bea Example", [H3])]);
    const counted = await asked(url("/v1/count", { of: "calls", person: personRef({ id: MANY.id, handles: many }) }));
    expect(counted.status).toBe(200);
    expect(counted.body.total.n).toBe(1);
    const row: string = counted.body.total.ref;
    expect(row.length).toBeLessThanOrEqual(REF_CHARS);
    expect(readRef(row, "ref", ["row"]).parts.kept.persons).toEqual([many[0]]);
    const opened = await asked(url("/v1/read", { ref: row }));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ what: "row", n: 1 });
    expect(opened.body.now).toBeUndefined();
    expect(factsOf(opened.body)).toEqual([refOf("c1")]);
    expect(opened.body.asked).toMatch(/narrowed to fit its ref: each person is whoever holds one handle of theirs now/u);
    const whole = await asked(url("/v1/read", { ref: (await asked(url("/v1/count", { of: "calls", person: H3 }))).body.total.ref }));
    expect(whole.body.asked).not.toMatch(/narrowed/u);
  });

  it("S6b a person's group, opened after People split a handle away and gave the person another, counts the handles it was counted over", async () => {
    const { asked, index, people } = homeOf("s6b");
    index([
      { key: "c1", day: DAY, time: "09:00", handle: H1, text: "a call" },
      { key: "c2", day: DAY, time: "10:00", handle: H2, text: "a call" },
      { key: "c3", day: DAY, time: "11:00", handle: H3, text: "a call" },
    ]);
    people([person("person:ada", "Ada Example", [H1, H2]), person("person:bea", "Bea Example", [H3])]);
    const counted = await asked(url("/v1/count", { of: "calls", by: "person" }));
    expect(counted.status).toBe(200);
    const ada = (counted.body.rows as unknown[][]).find((row) => row[0] === "Ada Example")!;
    expect(ada[1]).toBe(2);
    const row = ada.at(-1) as string;
    people([person("person:ada", "Ada Example", [H1, H3]), person("person:cy", "Cy Example", [H2])]);
    const opened = await asked(url("/v1/read", { ref: row }));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ what: "row", n: 2 });
    expect(opened.body.now).toBeUndefined();
    expect(factsOf(opened.body)).toEqual([refOf("c1"), refOf("c2")].sort());
  });
});

describe("cursors bound to what their answer depends on", () => {
  it("S7a a count by words goes on when a record that matches the words is indexed between two pages", async () => {
    const { asked, index, people } = homeOf("s7a");
    index([
      { key: "c1", day: DAY, time: "09:00", handle: H1, text: "a meeting call" },
      { key: "c2", day: DAY, time: "10:00", handle: H1, text: "a meeting call" },
      { key: "c3", day: DAY, time: "11:00", handle: H1, text: "a meeting call" },
    ]);
    people([person("person:ada", "Ada Example", [H1])]);
    const first = await asked(url("/v1/count", { of: "calls", words: "meeting", by: "item", order: "time", limit: "1" }));
    expect(first.status).toBe(200);
    expect(first.body.next).toEqual(expect.any(String));
    index([{ key: "c4", day: LATER, time: "09:00", handle: H1, text: "a meeting call" }]);
    const second = await asked(url("/v1/count", { cursor: first.body.next }));
    expect(second.status).toBe(200);
    expect(second.body.rows).toHaveLength(1);
    expect(second.body.rows[0].at(-1)).not.toBe(first.body.rows[0].at(-1));
  });
});

describe("the rest of count, search and search_people", () => {
  it("R2 a chat that names nothing held is refused by count as by search, naming `chat`", () => {
    const { root, index, people, peopleFile, families, file } = homeOf("r2");
    index([{ key: "c1", day: DAY, time: "09:00", handle: H1, text: "a call" }]);
    people([person("person:ada", "Ada Example", [H1])]);
    const built = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    const over = { index: built, peopleFile, home: join(root, "home.db"), now_ms, families };
    const count = (chat: string) => onCall(over, (call) => {
      const asked = countAskedOf(paramsOf(countParams, new URLSearchParams({ of: "calls", chat })), collectionsOf(families));
      return countShown(countIn(call, asked, (read, each, context) => plainCount(read, each, context)), asked);
    });
    const search = (chat: string) => onCall(over, (call) => recordPartOf(searchAskedOf(paramsOf(searchParams, new URLSearchParams({ lists: "record", query: "call", chat }))), call).answer);
    try {
      expect(count(makeRef("chat", { key: CHAT }))).toMatchObject({ total: { n: 1 } });
      expect(search(makeRef("chat", { key: CHAT })).record!.hits).toHaveLength(1);
      const erased = makeRef("chat", { key: "whatsapp:15550000099@s.whatsapp.net" });
      for (const [path, run] of [["/v1/count", () => count(erased)], ["/v1/search", () => search(erased)]] as const) {
        let refusal: unknown;
        try {
          run();
        } catch (error) {
          refusal = error;
        }
        expect(refusal, path).toBeInstanceOf(Refusal);
        const { status, code, words, extra } = refusal as Refusal;
        expect(answerOf(path, status, { code, message: words, ...extra }), path).toEqual({ code: "BAD_PARAMETER", message: "`chat` names no chat the home holds now. Find it with `search_people`." });
      }
    } finally {
      built.close();
    }
  });

  it("R3 a handle People does not know filters, and is named back with no ref; one People knows, with its person's", async () => {
    const { asked, index, people } = homeOf("r3");
    index([{ key: "c1", day: DAY, time: "09:00", handle: H1, text: "a call" }, { key: "c2", day: DAY, time: "10:00", handle: H3, text: "a call" }]);
    people([person("person:ada", "Ada Example", [H1])]);
    const found = await asked(url("/v1/search", { lists: "record", query: "call", person: H3 }));
    expect(found.status).toBe(200);
    expect(found.body.person).toEqual([{ asked: H3, name: H3 }]);
    expect(found.body.record.hits.map((hit: { ref: string }) => hit.ref)).toEqual([refOf("c2")]);
    const known = await asked(url("/v1/search", { lists: "record", query: "call", person: H1 }));
    expect(known.body.person).toEqual([{ asked: H1, ref: makeRef("person", { handle: H1 }), name: "Ada Example" }]);
  });

  it("R4 every contract answer is tagged by its body: two asks of one body share a tag, and If-None-Match with it is 304", async () => {
    const { asked, index, people } = homeOf("r4");
    index([{ key: "c1", day: DAY, time: "09:00", handle: H1, text: "a call" }]);
    people([person("person:ada", "Ada Example", [H1])]);
    const plain = await asked("/v1/count?of=calls");
    const paged = await asked("/v1/count?of=calls&limit=50");
    expect(paged.body).toEqual(plain.body);
    expect(plain.etag).toMatch(/^"[0-9a-f]{64}"$/u);
    expect(paged.etag).toBe(plain.etag);
    expect((await asked("/v1/count?of=calls&limit=50", plain.etag)).status).toBe(304);
    const other = await asked("/v1/count?of=calls&by=person");
    expect(other.etag).not.toBe(plain.etag);
    expect((await asked("/v1/people/search?name=ada")).etag).toMatch(/^"[0-9a-f]{64}"$/u);
  });

  it("R5 a chat's ref is read as its match while People is being prepared: no match, so `read` opens it as its latest; a person's waits for People", () => {
    const { root, index, families, file } = homeOf("r5");
    index([{ key: "c1", day: DAY, time: "09:00", handle: H1, text: "a call" }]);
    const built = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    try {
      onCall({ index: built, home: join(root, "home.db"), now_ms, families }, (call) => {
        expect(peopleOne(call, CHAT, true)).toBeUndefined();
        let refusal: unknown;
        try {
          peopleOne(call, H1);
        } catch (error) {
          refusal = error;
        }
        expect(refusal).toBeInstanceOf(Refusal);
        expect((refusal as Refusal).code).toBe("INDEX_BUILDING");
        expect((refusal as Refusal).extra).toMatchObject({ building: ["people"] });
      });
    } finally {
      built.close();
    }
  });
});
