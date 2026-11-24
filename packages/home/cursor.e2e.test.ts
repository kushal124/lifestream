import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DAYS_MARK, openHome, openHomeFolder, type DaySettings, type JsonObject } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, type DayFileFact, type Family, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { argumentsWritten, ARGUMENTS_BYTES, EXPIRED, sealed } from "./cursor-text.js";
import { ErasableStreams } from "./erasable-streams.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { openReads, type Reply } from "./reads.js";
import { Refusal } from "./refusal.js";
import type { Registry } from "./registry.js";
import { answerOf, type ContractPath } from "./search-contract.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import type { Settings } from "./settings.js";


const dir = mkdtempSync(join(tmpdir(), "lifestream-cursor-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAYS = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"];
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const now_ms = D("2026-11-13");
const ADA_PHONE = "phone:+15550000001";
const BEA_PHONE = "phone:+15550000002";

function person(id: string, name: string, handles: string[]): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: [], also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })),
  } as unknown as PersonDetail;
}
const searched = (detail: PersonDetail): Searched => ({ id: detail.id, words: detail.name.toLowerCase().split(" "), values: [], phones: [] }) as unknown as Searched;

const callFact = (key: string, at: number, handle: string): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: at, start_ms: at, end_ms: at + 600_000,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes: 10 }, who: [{ handle, role: "receiver" }],
  from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});

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
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: UTC }) as Settings,
    registry: { connectors: [], readers: [], families } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const built = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, UTC);
  const calls = DAYS.map((day, n) => ({ key: `c${n}`, day, at: D(day, "09:00"), handle: n === 3 ? BEA_PHONE : ADA_PHONE }));
  built.records(calls.map((each) => ({
    record: { source: "wa:local:a", kind: "call", key: each.key }, family: "calls", version: "v1", start_ms: each.at, end_ms: each.at + 600_000,
    title: "", text: "a call about the harbour", who: [each.handle], link: null,
  })), [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const each of calls) {
    built.day(each.day, {
      inputs: `in-${each.key}`, mtime_us: 1,
      atoms: [{ n: 1, family: "calls", unit: `calls/${each.key}`, record: { source: "wa:local:a", kind: "call", key: each.key }, start_ms: each.at, end_ms: each.at + 600_000, text: "a call about the harbour" }],
      facts: { window: { start_ms: D(each.day, "00:00"), end_ms: D(each.day, "00:00") + 86_400_000 }, facts: [callFact(each.key, each.at, each.handle)] },
    });
  }
  built.finish();
  built.close();
  const people = (everyone: PersonDetail[], position: string) => writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, {
    rows: new Map<string, Map<string, JsonObject>>([
      ["answer", new Map([["list", { people: [], chats: [] } as unknown as JsonObject]])],
      ["person", new Map(everyone.map((each) => [each.id, { person: each } as unknown as JsonObject]))],
      ["alias", new Map(everyone.flatMap((each) => [[each.id, { id: each.id }], ...each.handles.map((handle) => [handle.id, { id: each.id }])] as [string, JsonObject][]))],
      ["names", new Map([["all", { people: everyone.map(searched) } as unknown as JsonObject]])],
    ]),
    position,
  });
  const asked = async (url: string): Promise<{ status: number; body: Record<string, any> }> => {
    const path = new URL(url, "http://door").pathname as ContractPath;
    let out: { status: number; body: Record<string, any> };
    try {
      const reply = await (reads.reply(path)!({ url, now_ms, held: { machine } as never }) as Reply | Promise<Reply>);
      out = { status: reply.status ?? 200, body: JSON.parse(String(reply.body)) as Record<string, any> };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      out = { status: error.status, body: { code: error.code, message: error.words, ...error.extra } };
    }
    answerOf(path, out.status, out.body);
    return out;
  };
  return { people, asked };
}

const ADA = person("person:ada", "Ada Example", [ADA_PHONE]);
const BEA = person("person:bea", "Bea Example", [BEA_PHONE]);
const q = (url: string, params: Record<string, string>) => `${url}?${new URLSearchParams(params)}`;

describe("a cursor bound to what its ask resolved to", () => {
  it("C1 a search and a count by person go on after another person's name changed in People; once the asked person's handles change, CURSOR_EXPIRED", async () => {
    const { people, asked } = homeOf("c1");
    people([ADA, BEA], "1:1");
    const search = await asked(q("/v1/search", { lists: "record", query: "harbour", person: "Ada Example", order: "newest", limit: "1" }));
    const count = await asked(q("/v1/count", { of: "calls", person: "Ada Example", by: "item", limit: "1" }));
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    expect(count.status, JSON.stringify(count.body)).toBe(200);
    const searchNext = search.body.record.next as string;
    const countNext = count.body.next as string;
    expect([typeof searchNext, typeof countNext]).toEqual(["string", "string"]);

    people([ADA, person(BEA.id, "Bea Renamed", [BEA_PHONE])], "2:2");
    const searchOn = await asked(q("/v1/search", { cursor: searchNext }));
    const countOn = await asked(q("/v1/count", { cursor: countNext }));
    expect(searchOn.status, JSON.stringify(searchOn.body)).toBe(200);
    expect(countOn.status, JSON.stringify(countOn.body)).toBe(200);
    expect(searchOn.body.record.hits).toHaveLength(1);
    expect(searchOn.body.record.hits[0].ref).not.toBe(search.body.record.hits[0].ref);
    expect(countOn.body.rows).toHaveLength(1);

    people([person(ADA.id, ADA.name, [ADA_PHONE, "phone:+15550000009"]), BEA], "3:3");
    for (const url of [q("/v1/search", { cursor: searchNext }), q("/v1/count", { cursor: countNext })]) {
      expect(await asked(url)).toEqual({ status: 409, body: { code: "CURSOR_EXPIRED", message: EXPIRED } });
    }
  });
});

describe("every next good alone", () => {
  it("C2 a search and a count asked with a thousand bytes of words go on given their `next` alone", async () => {
    const { people, asked } = homeOf("c2");
    people([ADA, BEA], "1:1");
    const words = (filler: string) => `harbour OR ${filler.repeat(1_000 - "harbour OR ".length)}`;
    expect(Buffer.byteLength(words("x"))).toBe(1_000);
    expect(argumentsWritten("record", { query: words("x"), order: "newest", limit: 1 }).length).toBeLessThanOrEqual(ARGUMENTS_BYTES);
    const search = await asked(q("/v1/search", { lists: "record", query: words("x"), order: "newest", limit: "1" }));
    expect(search.status, JSON.stringify(search.body)).toBe(200);
    const on = await asked(q("/v1/search", { cursor: search.body.record.next }));
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.record.hits).toHaveLength(1);
    expect((await asked(q("/v1/search", { cursor: search.body.record.next, limit: "3" }))).body.record.hits).toHaveLength(3);

    const count = await asked(q("/v1/count", { of: "calls", by: "item", limit: "1", words: words("y") }));
    expect(count.status, JSON.stringify(count.body)).toBe(200);
    const counted = await asked(q("/v1/count", { cursor: count.body.next }));
    expect(counted.status, JSON.stringify(counted.body)).toBe(200);
    expect(counted.body.rows).toHaveLength(1);
  });

  it("C3 a next given to another route is BAD_PARAMETER on every route", async () => {
    const { people, asked } = homeOf("c3");
    people([ADA, BEA], "1:1");
    const of = { record: { query: "x" }, count: { of: "calls" }, people: { name: "x" }, read: { ref: "record.x" } } as const;
    const route = { "/v1/search": "record", "/v1/count": "count", "/v1/people/search": "people", "/v1/read": "read" } as const;
    for (const [path, own] of Object.entries(route)) {
      for (const [other, params] of Object.entries(of)) {
        if (other === own) continue;
        const reply = await asked(q(path, { cursor: sealed(other as keyof typeof of, [1], params as never, {}) }));
        expect([path, other, reply.body.code]).toEqual([path, other, "BAD_PARAMETER"]);
      }
    }
  });
});
