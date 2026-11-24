import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { addDays, dayBounds, DAYS_MARK, importSubject, openHome, openHomeFolder, type DaySettings, type Delivery, type Guard, type HomeDb, type ReaderOutput, type RecordRef, type Version } from "@lifestreamprotocol/core";
import { providers } from "@lifestreamprotocol/connect";
import { CALENDAR_COLLECTIONS, calendarFamily, MESSAGES_COLLECTIONS, RENDERER_VERSION, type DayAtom, type DayFileFact, type Family } from "@lifestreamprotocol/families";
import type { HelperEnv, Main } from "./jobs.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { openReads, type Reply } from "./reads.js";
import type { Registry } from "./registry.js";
import type { Settings } from "./settings.js";
import { fedBy, readers } from "./registry-home.js";
import { indexKind } from "./index-job.js";
import { readDay } from "./search.js";
import type { Hit } from "./record-search.js";
import { paramsOf, searchParams, type RecordList } from "./search-contract.js";
import { readRef } from "./refs.js";
import { FORMAT, SearchIndex, searchFileOf, type RecordEntry } from "./search-index.js";
import { recordPartOf, searchAskedOf } from "./search-route.js";
import { readQuery, RECORD_WORDS } from "./search-words.js";
import { notesFamily } from "./test/fakes.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";
import { onCall } from "./test/calls.js";
import { countAsked, searchOf, countOf, shown } from "./test/record-reads.js";


const D = "2026-10-07";
const ACCOUNT = "person-a@example.com";
const CALENDAR = `google-calendar:${ACCOUNT}:export`;
const NOTES = "apple-notes:local:macbook-pro-0001";
const NOW = Date.parse("2026-10-12T12:00:00Z");
const WEST: DaySettings = { zone: "America/Los_Angeles", day_start_hour: 4 };
const EAST: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const OBJECT: Guard = (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]);
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Example//Synthetic//EN", "BEGIN:VEVENT", "DTSTART;VALUE=DATE:20261007", "DTEND;VALUE=DATE:20261008",
  "DTSTAMP:20261001T000000Z", "UID:allday-1@example.com", "SUMMARY:Lantern festival", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");

const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-dated-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function landed(name: string, ics = ICS) {
  const root = makeRoot(`lifestream-search-dated-${name}-`, { sources: {} });
  mkdirSync(join(root, "days"), { recursive: true });
  const machine = join(root, "machine");
  const db: HomeDb = openHome(openHomeFolder(root), "migrate");
  const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
  const fed = fedBy(providers());
  const calendar = calendarFamily({ books: fed.labels })(fed.calendar);
  const notes = {
    ...notesFamily(),
    text: { version: "1", kinds: ["note"], of: (_record: RecordRef, version: Version) => ({ text: String((version.content as { text: string }).text) }) },
  } as unknown as Family;
  const registry = { connectors: [], readers: [], families: [calendar, notes], code: "test" };
  const reader = readers().find((each) => each.name === "gcal-export")!;
  const bytes = Buffer.from(ics);
  const delivery: Delivery = {
    id: `${CALENDAR}/1`, source: CALENDAR, sealed_ms: NOW, stated_ms: NOW, facts: { exported_at: "2026-10-12T11:00:00Z", fetched_at: "2026-10-12T12:00:00Z" },
    files: [{ path: `${ACCOUNT}.ics`, blob: blobs.put(bytes, { mediaType: "text/calendar" }), size: bytes.length }],
  };
  const rows: ReaderOutput[] = [];
  for await (const row of reader.read(delivery, blobs)) rows.push(row);
  const counts = db.commit((tx) => {
    tx.tables.sources.add({ id: CALENDAR, vendor: "google", connector: reader.name, added_ms: NOW });
    tx.tables.sources.add({ id: NOTES, vendor: "apple", connector: "fake-rows", added_ms: NOW });
    const event = tx.records.land(tx.tables.runs.start({ kind: "import", subject: importSubject(CALENDAR, delivery.id), started_ms: NOW }), delivery, rows, reader.kinds, blobs);
    const midnight = Date.parse(`${D}T00:00:00Z`);
    const note = tx.records.land(tx.tables.runs.start({ kind: "import", subject: importSubject(NOTES, `${NOTES}/1`), started_ms: NOW }), { id: `${NOTES}/1`, source: NOTES, stated_ms: NOW }, [{
      kind: "note", key: "ledger", content: { text: "harvest ledger settled", at: midnight, photo: false }, time: { start_ms: midnight, precision: "day" },
    }], { note: OBJECT }, blobs);
    return { event: event.new, note: note.new };
  });
  const searchFile = searchFileOf(root, machine);
  const reading = openHome(openHomeFolder(root), "read");
  return {
    rows, counts, searchFile, root, machine,
    async search(day: DaySettings) {
      const main = { now: () => NOW, settings: { day } } as unknown as Main;
      const begun = db.commit((tx) => indexKind.begin!(main, tx, { key: "search" } as never)!);
      const running = { job: { key: "search", lane: 0, started_ms: NOW }, state: begun.state } as never;
      const env = { folder: openHomeFolder(root), machine, db: reading, registry, blobs, settings: { day } } as unknown as HelperEnv;
      const helper = indexKind.helper(env, { job: 1, kind: "index", key: "search", lane: 0, now_ms: NOW, data: begun.data });
      for (let step = await helper.next(); step.done !== true; step = await helper.next()) {
        const chunk = step.value;
        db.commit((tx) => indexKind.chunk!(main, running, chunk)[0]!.work!(tx));
      }
    },
    ask(params: Record<string, string>): RecordList {
      const index = SearchIndex.read(openHomeFolder(dirname(searchFile)), searchFile)!;
      try {
        return recordListOf(index, params);
      } finally {
        index.close();
      }
    },
    held() {
      const file = new Database(searchFile, { readonly: true });
      try {
        return {
          entries: file.prepare("SELECT slot, dated FROM entries ORDER BY slot").all() as { slot: number; dated: number }[],
          clock: JSON.parse(file.prepare("SELECT value FROM meta WHERE key = 'clock'").pluck().get() as string) as DaySettings,
        };
      } finally {
        file.close();
      }
    },
    close() {
      reading.close();
      db.close();
      removeRoot(root);
    },
  };
}

function recordListOf(index: SearchIndex, params: Record<string, string>): RecordList {
  const asked = searchAskedOf(paramsOf(searchParams, new URLSearchParams({ lists: "record", ...params })));
  return JSON.parse(JSON.stringify(onCall({ index, now_ms: NOW }, (call) => recordPartOf(asked, call).answer).record)) as RecordList;
}

describe("D1 a date is a date, through the ingestion seam", () => {
  for (const settings of [WEST, EAST]) {
    it(`an all-day event and a dated note sit at their civil day's start and are found on their date and on no other (${settings.zone}, 04:00)`, async () => {
      const home = await landed(`d1-${settings.zone.replace("/", "-")}`);
      expect(home.rows).toMatchObject([{ kind: "event", time: { start_ms: Date.parse(`${D}T00:00:00Z`), precision: "day" } }]);
      expect(home.counts).toEqual({ event: 1, note: 1 });
      await home.search(settings);
      const start = dayBounds(D, settings).start_ms;
      expect(start).not.toBe(Date.parse(`${D}T00:00:00Z`));
      expect(home.held()).toEqual({ entries: [{ slot: start * 1000, dated: 1 }, { slot: start * 1000 + 1, dated: 1 }], clock: settings });

      const found = (query: string, range: Record<string, string>) => home.ask({ query, ...range }).hits.map((hit) => hit.title || hit.snippet);
      for (const day of [addDays(D, -1), D, addDays(D, 1)]) {
        expect(found("lantern", { from: day, to: day }), day).toEqual(day === D ? ["Lantern festival"] : []);
        expect(found("harvest", { from: day, to: day }), day).toEqual(day === D ? ["«harvest» ledger settled"] : []);
      }
      expect(found("lantern", { from: D })).toEqual(["Lantern festival"]);
      expect(found("lantern", { to: D })).toEqual(["Lantern festival"]);
      expect(found("lantern", { from: addDays(D, 1) })).toEqual([]);
      expect(found("lantern", { to: addDays(D, -1) })).toEqual([]);
      expect(found("lantern", { from: `${D}T04:00`, to: addDays(D, 1) })).toEqual(["Lantern festival"]);
      expect(found("lantern", { from: `${D}T04:01`, to: addDays(D, 1) })).toEqual([]);

      const [hit] = home.ask({ query: "lantern" }).hits;
      expect(hit).toMatchObject({ day: D, family: "calendar" });
      expect(hit).not.toHaveProperty("at");
      expect(hit).not.toHaveProperty("score");
      expect(home.ask({ query: "lantern OR harvest" }).spread!.months).toEqual({ "2026-10": 2 });
      home.close();
    });
  }
});

describe("D2 the home's clock moved", () => {
  it("the job builds the index again under the new clock, the old one answering until the build is read through", async () => {
    const home = await landed("d2");
    await home.search(WEST);
    expect(home.held().clock).toEqual(WEST);
    const beside = SearchIndex.write(openHomeFolder(dirname(home.searchFile)), home.searchFile, () => true, 0, EAST);
    expect(beside.building).toBe(true);
    beside.close();
    expect(home.held().entries[0]!.slot).toBe(dayBounds(D, WEST).start_ms * 1000);
    await home.search(EAST);
    expect(home.held()).toMatchObject({ clock: EAST, entries: [{ slot: dayBounds(D, EAST).start_ms * 1000 }, { slot: dayBounds(D, EAST).start_ms * 1000 + 1 }] });
    expect(home.ask({ query: "lantern", from: D, to: D }).hits.map((hit) => hit.title)).toEqual(["Lantern festival"]);
    home.close();
  });
});

describe("D3, D4 what a hit states", () => {
  const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
  let seq = 0;
  const fresh = (name: string) => {
    const index = SearchIndex.write(openHomeFolder(dirname(join(scratch, name, "index.db"))), join(scratch, name, "index.db"), () => true, 0, UTC);
    index.records([], [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
    return index;
  };
  const search = (index: SearchIndex, q: string) => (searchOf(index, { terms: readQuery(q, RECORD_WORDS).terms, order: "relevance", limit: 20 }) as { hits: Hit[] }).hits
    .sort((left, right) => ((left.day ?? "") < (right.day ?? "") ? -1 : 1));

  it("D3 a day line states its day's revision and a message's chat title, the title of the block its line prints in", () => {
    const index = fresh("d3");
    const chat = "whatsapp:local:c";
    const at = Date.parse("2026-09-28T09:00:00Z");
    const fact: DayFileFact = {
      id: "messages:m1", family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
      keys: { chat: "whatsapp:111@lid", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle: "phone:+15550000001", role: "sender" }],
      from: { units: [`${chat}/c`], record: { source: chat, kind: "msg", key: "m1" }, alone: true }, lines: [1],
    };
    const line = { n: 1, family: "messages", unit: `${chat}/c`, start_ms: at, end_ms: null, text: "Person A: [voice note: \"the lantern is lit\"]", title: "Person A", record: { source: chat, kind: "msg", key: "m1" } };
    index.day("2026-09-28", { inputs: "sha256:inputs-of-the-28th", mtime_us: 1, atoms: [line], facts: { window: dayBounds("2026-09-28", UTC), facts: [fact] } });
    index.day("2026-09-29", { inputs: "sha256:inputs-of-the-29th", mtime_us: 1, atoms: [{ n: 1, family: "notes", unit: "u1", start_ms: at + 86_400_000, end_ms: null, text: "a lantern bought" }] });
    const hits = search(index, "lantern");
    expect(hits.map((hit) => [hit.day, hit.rev, hit.chat, hit.chat_title])).toEqual([
      ["2026-09-28", "sha256:inputs-of-the-28th", "whatsapp:111@lid", "Person A"],
      ["2026-09-29", "sha256:inputs-of-the-29th", undefined, undefined],
    ]);
    for (const hit of hits) expect(hit).not.toHaveProperty("score");
    index.close();
  });

  it("D4 copies fold inside one account: one message on two devices of one account is one entry, the same words in two accounts two", () => {
    const index = fresh("d4");
    const at = Date.parse("2026-09-28T09:00:00Z");
    const copy = (source: string): RecordEntry => ({ record: { source, kind: "note", key: "same" }, family: "notes", version: "v-same", start_ms: at, end_ms: null, title: "", text: "the lantern list", who: [], link: null });
    index.records([copy("apple-notes:person-a@example.com:macbook-pro-0001"), copy("apple-notes:person-a@example.com:iphone-aa01"), copy("apple-notes:person-b@example.com:macbook-pro-0001")], [],
      { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
    const hits = search(index, "lantern");
    expect(hits.map((hit) => (hit.ref as RecordRef).source).sort()).toEqual(["apple-notes:person-a@example.com:macbook-pro-0001", "apple-notes:person-b@example.com:macbook-pro-0001"]);
    index.close();
  });
});

describe("D5 an index is read under its own clock until its replacement publishes", () => {
  it("built under Kolkata, the home moved to Los Angeles: the old index finds its dated entry on its own date, then the new one does", async () => {
    const home = await landed("d5");
    await home.search(EAST);
    const beside = SearchIndex.write(openHomeFolder(dirname(home.searchFile)), home.searchFile, () => true, 0, WEST);
    expect(beside.building).toBe(true);
    beside.close();
    const asked = () => ({
      on: home.ask({ query: "lantern", from: D, to: D }).hits.map((hit) => [hit.title, hit.day]),
      before: home.ask({ query: "lantern", from: addDays(D, -1), to: addDays(D, -1) }).hits.length,
    });
    expect(home.held().clock).toEqual(EAST);
    expect(asked()).toEqual({ on: [["Lantern festival", D]], before: 0 });
    await home.search(WEST);
    expect(home.held().clock).toEqual(WEST);
    expect(asked()).toEqual({ on: [["Lantern festival", D]], before: 0 });
    home.close();
  });
});

describe("D6 a dated thing over several dates is found on each of them", () => {
  const OVER_THREE = ICS.replace("DTEND;VALUE=DATE:20261008", "DTEND;VALUE=DATE:20261010").replace("allday-1@", "allday-3@");
  for (const settings of [WEST, EAST]) {
    it(`its record indexed, the event is found on each of its dates and on no other (${settings.zone}, 04:00)`, async () => {
      const home = await landed(`d6-${settings.zone.replace("/", "-")}`, OVER_THREE);
      expect(home.rows).toMatchObject([{ kind: "event", time: { start_ms: Date.parse(`${D}T00:00:00Z`), end_ms: Date.parse("2026-10-10T00:00:00Z"), precision: "day" } }]);
      await home.search(settings);
      const found = (range: Record<string, string>) => home.ask({ query: "lantern", ...range }).hits.map((hit) => hit.title);
      for (const day of [addDays(D, -1), D, addDays(D, 1), addDays(D, 2), addDays(D, 3)]) {
        expect(found({ from: day, to: day }), day).toEqual(day >= D && day <= addDays(D, 2) ? ["Lantern festival"] : []);
      }
      expect(found({ from: addDays(D, 2) })).toEqual(["Lantern festival"]);
      expect(found({ from: addDays(D, 3) })).toEqual([]);
      expect(found({ from: `${addDays(D, 1)}T04:00`, to: `${addDays(D, 1)}T05:00` })).toEqual(["Lantern festival"]);
      expect(found({ from: `${addDays(D, 1)}T04:01`, to: `${addDays(D, 1)}T23:00` })).toEqual([]);
      expect(found({ from: `${addDays(D, 2)}T04:01`, to: addDays(D, 3) })).toEqual([]);
      expect(found({ from: addDays(D, 1), to: addDays(D, 1), order: "oldest" })).toEqual(["Lantern festival"]);
      expect(home.ask({ families: "calendar", from: addDays(D, 1), to: addDays(D, 1) }).hits.map((hit) => hit.title)).toEqual(["Lantern festival"]);
      home.close();
    });
  }
});

describe("D7 search and count place a dated thing alike", () => {
  for (const settings of [WEST, EAST]) {
    it(`a range from a minute past its day's start keeps it in neither; its whole day in both (${settings.zone}, 04:00)`, () => {
      const file = join(scratch, `d7-${settings.zone.replace("/", "-")}`, "index.db");
      const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, settings);
      const midnight = Date.parse(`${D}T00:00:00Z`);
      const record = { source: CALENDAR, kind: "event", key: "allday-1" };
      index.records([{ record, family: "calendar", version: "v-1", start_ms: midnight, end_ms: midnight + 86_400_000, title: "Lantern festival", text: "", who: [], link: null, dated: true }], [],
        { position: { seq: 1, statement: "s-1", reread: 0 } });
      const fact: DayFileFact = {
        id: "events:000000000000000000000001", family: "calendar", of: "events", time_ms: midnight, start_ms: midnight, end_ms: midnight, date_only: true,
        keys: { title: "Lantern festival" }, measures: {}, who: [], from: { units: ["calendar/u1"], record, alone: true }, lines: [1],
      };
      index.day(D, {
        inputs: "sha256:d7", mtime_us: 1, facts: { window: dayBounds(D, settings), facts: [fact] },
        atoms: [{ n: 1, family: "calendar", unit: "calendar/u1", start_ms: midnight, end_ms: null, text: "Lantern festival", record, dated: true }],
      });
      const searched = (range: Record<string, string>) => recordListOf(index, { query: "lantern", ...range }).hits.length;
      const counted = (range: Record<string, string>) => (shown(countOf(index, countAsked({ of: "events", words: "lantern", ...range }, new Map(Object.entries(CALENDAR_COLLECTIONS))), {
        collections: new Map(Object.entries(CALENDAR_COLLECTIONS)), settings, now_ms: NOW, people: () => undefined,
      })) as { total: { n: number } }).total.n;
      for (const [range, n] of [[{ from: `${D}T04:01`, to: D }, 0], [{ from: D, to: D }, 1], [{ from: `${D}T04:00`, to: D }, 1], [{ from: addDays(D, 1), to: addDays(D, 1) }, 0]] as const) {
        expect([searched(range), counted(range)], JSON.stringify(range)).toEqual([n, n]);
      }
      index.close();
    });
  }
});

describe("D8 a hit states its chat and its pictures, as the day file's lines state them", () => {
  it("a message with two pictures, an AI turn and a photo, read from a day file by the index job's reader", () => {
    const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
    const root = mkdtempSync(join(scratch, "d8-"));
    mkdirSync(join(root, "days"));
    const day = "2026-09-28";
    const at = (time: string) => Date.parse(`${day}T${time}:00Z`);
    const AI = "chatgpt:user-synthetic-aa01:export";
    const atom = (n: number, rest: Partial<DayAtom> & Pick<DayAtom, "family" | "unit" | "text" | "start_ms">): DayAtom => ({
      n, units: [rest.unit], end_ms: null, local_start: null, local_end: null, flags: [], ...rest,
    });
    const atoms: DayAtom[] = [
      atom(1, { family: "messages", unit: `${day}:imessage:+15550000001`, start_ms: at("09:00"), text: "Person A: the lantern photos", record: { source: "imessage:person-a@example.com:macbook-pro-0001", kind: "msg", key: "M1" },
        block: { key: "imessage:+15550000001", title: "Person A" }, chat: "imessage:+15550000001", pictures: 2 }),
      atom(2, { family: "ai", unit: `${AI}/conv-1/${day}`, start_ms: at("10:00"), text: "You: where are the lanterns", record: { source: AI, kind: "msg", key: "conv-1:t1" },
        block: { key: `${AI}/conv-1`, title: "ChatGPT · Lantern route" }, chat: `${AI}/conv-1` }),
      atom(3, { family: "photos", unit: "burst/synthetic-1", start_ms: at("12:00"), text: "Photograph: lanterns on the river", item: `photo:${"4".repeat(64)}`, pictures: 1 }),
    ];
    const path = join(root, "days", `${day}.day.json`);
    writeFileSync(path, JSON.stringify({ renderer: RENDERER_VERSION, day, window: dayBounds(day, UTC), atoms, facts: [] }));
    const read = readDay(openHomeFolder(root), day, "sha256:d8", Math.round(statSync(path).mtimeMs * 1000))!;
    const index = SearchIndex.write(openHomeFolder(dirname(join(root, "index.db"))), join(root, "index.db"), () => true, 0, UTC);
    index.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    expect(index.day(day, read)).toBe(true);
    const hits = (searchOf(index, { terms: readQuery("lantern OR lanterns", RECORD_WORDS).terms, order: "newest", limit: 10 }) as { hits: Hit[] }).hits;
    expect(hits.map((hit) => [hit.family, hit.chat, hit.chat_title, hit.picture])).toEqual([
      ["photos", undefined, undefined, 1],
      ["ai", `${AI}/conv-1`, "ChatGPT · Lantern route", undefined],
      ["messages", "imessage:+15550000001", "Person A", 2],
    ]);
    index.close();
  });
});

describe("D9 a file of the words layer's format before this one", () => {
  it("is never opened: a reader, the marking job and an erasure pass it by, and the job builds the index again beside it", () => {
    const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
    const file = join(scratch, "d9", "index.db");
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
    index.records([{ record: { source: NOTES, kind: "note", key: "n1" }, family: "notes", version: "v-1", start_ms: Date.parse("2026-09-28T09:00:00Z"), end_ms: null, title: "", text: "the lantern list", who: [], link: null }], [],
      { position: { seq: 1, statement: "s-1", reread: 0 } });
    index.finish();
    expect(FORMAT).not.toBe("15");
    const before = new Database(file);
    before.exec("DROP INDEX records_copy; ALTER TABLE records DROP COLUMN account");
    before.prepare("UPDATE meta SET value = '15' WHERE key = 'format'").run();
    before.close();
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)).toBeUndefined();
    expect(SearchIndex.marking(openHomeFolder(dirname(file)), file)).toBeUndefined();
    const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
    expect(built.building).toBe(true);
    built.close();
  });
});

describe("D10 a count reads under its index's clock, as search does", () => {
  it("built under Kolkata, the home moved to Los Angeles: search, a count of its words and a count by tallies agree on the day, before and after the new build publishes", async () => {
    const root = join(scratch, "d10", "home");
    const machine = join(scratch, "d10", "machine");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
    const home = openHome(openHomeFolder(root), "migrate");
    home.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
    home.close();
    let now: DaySettings = EAST;
    const families = [{ name: "messages", collections: MESSAGES_COLLECTIONS }] as unknown as Family[];
    const reads = openReads({
      folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: now }) as Settings,
      registry: { connectors: [], readers: [], families } as unknown as Registry,
    });
    const asked = async (url: string) => JSON.parse(String((await reads.reply(url.slice(0, url.indexOf("?")))!({ url, now_ms: NOW, held: { machine } as never }) as Reply).body)) as Record<string, unknown>;
    const at = Date.parse(`${D}T01:00:00Z`);
    const chat = "whatsapp:local:c";
    const record = { source: chat, kind: "msg", key: "m1" };
    const fill = (index: SearchIndex, clock: DaySettings, seq: number) => {
      const day = clock === EAST ? D : addDays(D, -1);
      index.records([{ record, family: "messages", version: "v-1", start_ms: at, end_ms: null, title: "", text: "the lantern is lit", who: [], link: null }], [],
        { position: { seq, statement: `s-${seq}`, reread: 0 } });
      const fact: DayFileFact = {
        id: "messages:m1", family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
        keys: { chat: "whatsapp:111@lid", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle: "phone:+15550000001", role: "sender" }],
        from: { units: [`${chat}/c`], record, alone: true }, lines: [1],
      };
      index.day(day, {
        inputs: `in-${day}`, mtime_us: 1, facts: { window: dayBounds(day, clock), facts: [fact] },
        atoms: [{ n: 1, family: "messages", unit: `${chat}/c`, start_ms: at, end_ms: null, text: "Person A: the lantern is lit", title: "Person A", record }],
      });
      index.finish();
    };
    const file = searchFileOf(root, machine);
    fill(SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, EAST), EAST, 1);
    const on = async (day: string) => {
      const search = (await asked(`/v1/search?lists=record&query=lantern&from=${day}&to=${day}`)).record as RecordList;
      const words = await asked(`/v1/count?of=messages&words=lantern&by=item&from=${day}&to=${day}`);
      const tallies = await asked(`/v1/count?of=messages&from=${day}&to=${day}`);
      const time = (words.rows as unknown[][])[0]?.[(words.columns as string[]).indexOf("time")] as string | undefined;
      return [[search.hits[0]?.at?.slice(16) ?? null, time?.slice(16) ?? null], [search.hits.length, (words.total as { n: number }).n, (tallies.total as { n: number }).n]];
    };
    now = WEST;
    const beside = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, WEST);
    expect(beside.building).toBe(true);
    expect(await on(D)).toEqual([["+05:30", "+05:30"], [1, 1, 1]]);
    expect(await on(addDays(D, -1))).toEqual([[null, null], [0, 0, 0]]);
    fill(beside, WEST, 2);
    expect(await on(D)).toEqual([[null, null], [0, 0, 0]]);
    expect(await on(addDays(D, -1))).toEqual([["-07:00", "-07:00"], [1, 1, 1]]);
  });
});

describe("D11 a dated thing over several dates is judged at a place on the date the range holds", () => {
  it("an event of 7 to 9 October, place A held only on the 7th, B on the 8th, C on the 9th: asked of the 8th, B finds it and A does not", () => {
    const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
    const index = SearchIndex.write(openHomeFolder(dirname(join(scratch, "d11", "index.db"))), join(scratch, "d11", "index.db"), () => true, 0, UTC);
    const midnight = Date.parse(`${D}T00:00:00Z`);
    index.records([{ record: { source: CALENDAR, kind: "event", key: "allday-3" }, family: "calendar", version: "v-1", start_ms: midnight, end_ms: midnight + 3 * 86_400_000,
      title: "Lantern festival", text: "", who: [], link: null, dated: true }], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    const date = (day: string) => [[dayBounds(day, UTC).start_ms, dayBounds(day, UTC).end_ms]] as [number, number][];
    const [A, B, C] = [date(D), date(addDays(D, 1)), date(addDays(D, 2))];
    const found = (from: string, to: string, places: [number, number][]) => (searchOf(index, {
      terms: readQuery("lantern", RECORD_WORDS).terms, order: "newest", limit: 20, from_ms: dayBounds(from, UTC).start_ms, to_ms: dayBounds(to, UTC).end_ms, places: { clock: [], date: places },
    }) as { hits: Hit[] }).hits.map((hit) => hit.title);
    expect(found(addDays(D, 1), addDays(D, 1), B)).toEqual(["Lantern festival"]);
    expect(found(addDays(D, 1), addDays(D, 1), A)).toEqual([]);
    expect(found(addDays(D, 1), addDays(D, 2), C)).toEqual(["Lantern festival"]);
    expect(found(addDays(D, 1), addDays(D, 2), A)).toEqual([]);
    expect(found(D, D, A)).toEqual(["Lantern festival"]);
    expect(found(D, D, B)).toEqual([]);
    index.close();
  });
});

describe("D12 a date is no clock time on the contract's routes", () => {
  it("the all-day event's hit in search and its record whole in read state its day and no `at`", async () => {
    const home = await landed("d12");
    await home.search(EAST);
    const { machine } = home;
    const listed = openHome(openHomeFolder(home.root), "migrate");
    listed.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
    listed.close();
    const registry = { connectors: [], readers: [], families: [calendarFamily({ books: fedBy(providers()).labels })(fedBy(providers()).calendar)], code: "test" } as unknown as Registry;
    const reads = openReads({ folder: openHomeFolder(home.root), home: new HomeFile(openHomeFolder(home.root)), blobs: openHomeFolder(home.root).blobs(join(home.root, "blobs")), settings: () => ({ day: EAST }) as Settings, registry });
    const asked = async (url: string) => {
      const reply = await reads.reply(url.slice(0, url.indexOf("?")))!({ url, now_ms: NOW, held: { machine } as never }) as Reply;
      return JSON.parse(String(reply.body)) as Record<string, any>;
    };
    const found = await asked("/v1/search?lists=record&query=lantern");
    const hit = found.record.hits.find((each: { family: string }) => each.family === "calendar");
    expect(hit).toMatchObject({ day: D, family: "calendar" });
    expect(hit).not.toHaveProperty("at");
    const opened = await asked(`/v1/read?ref=${encodeURIComponent(hit.ref)}`);
    expect(opened).toMatchObject({ what: "record", day: D });
    expect(opened).not.toHaveProperty("at");
    home.close();
  });
});

describe("today, and what comes after it", () => {
  const UTC: DaySettings = { zone: "UTC", day_start_hour: 0 };
  const at = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
  const TODAY = at("2026-11-14", "10:00");
  let written = 0;
  function index(entries: RecordEntry[]): SearchIndex {
    const file = join(scratch, `today-${++written}`, "index.db");
    mkdirSync(join(scratch, `today-${written}`), { recursive: true });
    const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
    built.records(entries, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    built.finish();
    return SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, UTC);
  }
  const entry = (key: string, words: string, start_ms: number): RecordEntry => ({
    record: { source: CALENDAR, kind: "event", key }, family: "calendar", version: `v-${key}`, start_ms, end_ms: null, title: "", text: words, who: [], link: null,
  });
  const listOf = (held: SearchIndex, params: Record<string, string>, now_ms = TODAY): RecordList => {
    const asked = searchAskedOf(paramsOf(searchParams, new URLSearchParams({ lists: "record", ...params })));
    return JSON.parse(JSON.stringify(onCall({ index: held, now_ms, settings: UTC }, (call) => recordPartOf(asked, call).answer).record)) as RecordList;
  };
  const keysOf = (list: RecordList) => list.hits.map((hit) => readRef(hit.ref, "ref", ["record"]).parts.key);
  const held = () => index([
    entry("next-year", "lantern festival", at("2027-11-07")), entry("today", "lantern festival", at("2026-11-14", "08:00")),
    entry("last-week", "lantern festival", at("2026-11-07")),
  ]);

  it("H8 newest leads with today's: next year's waits for a `to` past today", () => {
    const events = held();
    expect(keysOf(listOf(events, { query: "lantern", order: "newest" }))).toEqual(["today", "last-week"]);
    expect(keysOf(listOf(events, { query: "lantern", order: "newest", to: "2028-01-01" }))).toEqual(["next-year", "today", "last-week"]);
  });

  it("H8 relevance counts days from today either side: last week's ranks above next year's", () => {
    expect(keysOf(listOf(held(), { query: "lantern" }))).toEqual(["today", "last-week", "next-year"]);
  });

  it("H8 a page asked after midnight ranks as its first page did", () => {
    const events = index(Array.from({ length: 40 }, (_, n) => entry(`e${n}`, `lantern ${"festival ".repeat(n % 5)}`, at("2026-11-14", "06:00") + (n - 20) * 3 * 86_400_000)));
    const pages = (later: number) => {
      const keys: string[] = [];
      let list = listOf(events, { query: "lantern", limit: "7" });
      for (let page = 1; ; page++) {
        keys.push(...keysOf(list));
        if (list.next === null || list.next === undefined) return keys;
        list = listOf(events, { cursor: list.next }, TODAY + later * page);
      }
    };
    expect(pages(86_400_000)).toEqual(pages(0));
  });
});
