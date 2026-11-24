import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { buildLabels, labelsFrom, type DayFileFact, type Piece } from "@lifestreamprotocol/families";
import { presenceTablesOf, restsOnIn } from "./places.js";

const ALONE = restsOnIn([], []);
import { makeRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import type { Fresh, HeldDays } from "./index-file.js";
import { answerOf, paramsOf, searchParams, type RecordHit, type RecordList, type SearchAnswer } from "./search-contract.js";
import { SearchIndex, type AtomEntry, type RecordEntry } from "./search-index.js";
import { recordPartOf, searchAskedOf } from "./search-route.js";
import { skeletonOf } from "./search-words.js";
import type { PresenceSource } from "./presence.js";
import type { PeopleMap } from "./counting.js";
import { onCall, type CallOf } from "./test/calls.js";
import { presenceSource, writePresenceFile } from "./test/presence-file.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const SETTINGS: DaySettings = { zone: "Europe/Paris", day_start_hour: 0 };
const PARIS = { latitude: 48.8566, longitude: 2.3522 };
const NEW_YORK = { latitude: 40.7128, longitude: -74.006 };
const CHICAGO = { latitude: 41.8781, longitude: -87.6298 };
const HOUR = 3_600_000;
const at = (local: string) => Date.parse(`${local}+01:00`);
const ny = (local: string) => Date.parse(`${local}-05:00`);
const NOTES = "apple-notes:local:device-a";
const CHAT_SOURCE = "whatsapp:local:a";
const HANDLE_A = "15550000001@s.whatsapp.net";
const FLIGHT_DAY = "2025-12-28";
const BANK = "bank:acct:mac";
const HANDLE_B = "15550000002@s.whatsapp.net";
const PEOPLE: Record<string, { name: string; handles: string[] }> = {
  "person:a": { name: "Ana Sharma", handles: [`jid:${HANDLE_A}`] },
  "person:b": { name: "Ana Verma", handles: [`jid:${HANDLE_B}`] },
  "person:c": { name: "Ben Ito", handles: [] },
};
const PEOPLE_MAP: PeopleMap = {
  version: "people-1",
  idOf: (id) => Object.keys(PEOPLE).find((who) => who === id || PEOPLE[who]!.handles.includes(id)),
  person: (id) => PEOPLE[id],
  find: (name) => Object.keys(PEOPLE).filter((who) => PEOPLE[who]!.name.toLowerCase().split(" ").includes(name.toLowerCase()) || PEOPLE[who]!.name.toLowerCase() === name.toLowerCase()),
};

const LABELS = (() => {
  const built = buildLabels({ places: [{ slug: "home", name: "Home", latitude: PARIS.latitude, longitude: PARIS.longitude, radius_m: 100, also: [], ids: [] }] });
  return labelsFrom((unit) => {
    const content = built.contents.get(unit);
    return content === undefined ? undefined : { content };
  }, SETTINGS);
})();
function stay(start: number, end: number, point: typeof PARIS, how: Piece["how"] = "observed", level: Piece["level"] = "place"): Piece {
  return { kind: "stay", level, how, point, from: null, to: null, units: [`stay/location:local:iphone-aa01/${start}`], start_ms: start, end_ms: end };
}
function move(start: number, end: number, from: typeof PARIS, to: typeof PARIS): Piece {
  return { kind: "move", level: "place", how: "observed", point: null, from, to, units: [`trip/location:local:iphone-aa01/${start}`], start_ms: start, end_ms: end };
}
const LINE: Piece[] = [
  stay(at("2025-12-20T00:00"), at("2025-12-28T10:00"), PARIS),
  move(at("2025-12-28T10:00"), ny("2025-12-28T12:00"), PARIS, NEW_YORK),
  stay(ny("2025-12-28T12:00"), ny("2025-12-30T06:00"), NEW_YORK),
  stay(ny("2025-12-30T06:00"), at("2026-01-01T00:30"), NEW_YORK, "guessed", "city"),
  stay(at("2026-01-01T00:30"), ny("2026-01-03T04:00"), NEW_YORK),
  move(ny("2026-01-03T04:00"), at("2026-01-03T20:00"), NEW_YORK, PARIS),
  stay(at("2026-01-03T20:00"), at("2026-01-10T00:00"), PARIS),
  stay(at("2026-01-10T00:00"), at("2026-01-10T12:00"), CHICAGO, "observed", "country"),
  stay(at("2026-01-10T12:00"), at("2026-01-12T00:00"), PARIS),
];
const DAYS = Array.from({ length: 23 }, (_, n) => new Date(Date.UTC(2025, 11, 20 + n)).toISOString().slice(0, 10));
const TABLES = presenceTablesOf(LINE, DAYS, LABELS, new Map(), SETTINGS, at("2026-01-12T00:00"), ALONE);
const placesDir = mkdtempSync(join(tmpdir(), "lifestream-search-meant-places-"));
writePresenceFile(join(placesDir, "places.db"), TABLES);
writePresenceFile(join(placesDir, "moved.db"), { ...TABLES, version: "presence-2" });
const WHERE = presenceSource(join(placesDir, "places.db"));

const note = (key: string, text: string, start_ms: number, who: string[] = []): RecordEntry => ({
  record: { source: NOTES, kind: "note", key }, family: "notes", version: `v-${key}`, start_ms, end_ms: null, title: "", text, who, link: null,
});
const message = (key: string, text: string, start_ms: number): RecordEntry => ({
  record: { source: CHAT_SOURCE, kind: "msg", key }, family: "messages", version: `v-${key}`, start_ms, end_ms: null, title: "", text, who: [], link: null,
});
const ORDINALS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const RECORDS: RecordEntry[] = [
  note("p3", "Priyanaka called about the tickets", at("2025-12-20T09:00")),
  note("p1", "Priyanka booked the bistro", at("2025-12-21T10:00"), [HANDLE_A]),
  note("p2", "lunch with Priyanka tomorrow", at("2025-12-22T12:00"), [HANDLE_A]),
  note("k1", "Kavitha sent the itinerary", at("2026-01-05T10:00"), [HANDLE_A]),
  note("v1", "Vermeer exhibition guide", at("2025-12-24T15:00"), [HANDLE_B]),
  note("s1", "station meeting with the tour group", ny("2025-12-29T09:00")),
  note("s2", "station guessed the platform", ny("2025-12-31T10:00")),
  note("s3", "station coffee before the flight home", at("2026-01-10T07:00")),
  note("r1", "a diner on the corner", at("2025-12-23T08:00")),
  ...ORDINALS.map((word, n) => note(`d${n + 1}`, `dinner plans ${word}`, n < 6 ? at(`2025-12-2${n + 1}T19:00`) : at(`2026-01-0${n - 2}T19:00`))),
  message("m1", "see you at the station gate", at("2026-01-06T09:00")),
  { record: { source: BANK, kind: "txn", key: "t1" }, family: "money", version: "v-t1", start_ms: Date.parse(`${FLIGHT_DAY}T00:00:00Z`), end_ms: null, title: "", text: "card payment Pivert bakery", who: [], link: null, dated: true },
  message("m2", "the station is closed today", at("2026-01-06T10:00")),
];
const CHAT_DAY = "2026-01-06";
const PHOTO_DAY = "2026-01-07";
const messageFact = (key: string, chat: string, n: number, time_ms: number): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms, start_ms: time_ms, end_ms: time_ms,
  keys: { chat, direction: "received", product: "whatsapp", searchable: "yes" }, measures: {}, who: [],
  from: { units: [`messages/${CHAT_DAY}/whatsapp/${chat}`], record: { source: CHAT_SOURCE, kind: "msg", key } }, lines: [n],
});
const chatAtom = (n: number, key: string, text: string, start_ms: number, chat: string): AtomEntry => ({
  n, family: "messages", unit: `messages/${CHAT_DAY}/whatsapp/${chat}`, start_ms, end_ms: null, text, record: { source: CHAT_SOURCE, kind: "msg", key },
});
const photoAtom = (n: number, text: string, start_ms: number, shows?: string): AtomEntry => ({ n, family: "photos", unit: "burst/1", item: `photo:${shows ?? n}`, start_ms, end_ms: null, text, ...(shows === undefined ? {} : { pictures: 1 }) });
const dayWindow = (day: string) => ({ start_ms: at(`${day}T00:00`), end_ms: at(`${day}T00:00`) + 24 * HOUR });

const CALL: Omit<CallOf, "index"> = { now_ms: at("2026-01-12T00:00"), presence: WHERE, people: PEOPLE_MAP, settings: SETTINGS };
const LINES = new Map([[`${FLIGHT_DAY} ${BANK}/${FLIGHT_DAY} null`, 1], [`${PHOTO_DAY} burst/1 photo:1`, 1], [`${PHOTO_DAY} burst/1 photo:${"b".repeat(64)}`, 2]]);

const dir = mkdtempSync(join(tmpdir(), "lifestream-search-meant-"));
const artifact: Record<string, unknown> = {};
let index: SearchIndex;

beforeAll(() => {
  index = SearchIndex.write(openHomeFolder(dirname(join(dir, "index.db"))), join(dir, "index.db"), () => true, 0, SETTINGS);
  index.records(RECORDS, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  index.day(CHAT_DAY, {
    inputs: "chat-1", mtime_us: 1,
    atoms: [chatAtom(1, "m1", "Ana: see you at the station gate", at("2026-01-06T09:00"), "whatsapp:chat-a"), chatAtom(2, "m2", "Ben: the station is closed today", at("2026-01-06T10:00"), "whatsapp:chat-b")],
    facts: { window: dayWindow(CHAT_DAY), facts: [messageFact("m1", "whatsapp:chat-a", 1, at("2026-01-06T09:00")), messageFact("m2", "whatsapp:chat-b", 2, at("2026-01-06T10:00"))] },
  });
  index.day(FLIGHT_DAY, {
    inputs: "money-1", mtime_us: 1,
    atoms: [{ n: 1, family: "money", unit: `${BANK}/${FLIGHT_DAY}`, start_ms: Date.parse(`${FLIGHT_DAY}T00:00:00Z`), end_ms: null, text: "−9.00 EUR card: Merle kiosk", dated: true }],
  });
  index.day(PHOTO_DAY, {
    inputs: "photos-1", mtime_us: 1,
    atoms: [photoAtom(1, "Photo: a receipt from the bakery on the station counter", at("2026-01-07T09:00")), photoAtom(2, "Photo: a dog asleep by the station", at("2026-01-07T10:00"), "b".repeat(64))],
  });
});

afterAll(() => {
  index.close();
  writeFileSync(join(tmpdir(), "search-meant.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
  rmSync(placesDir, { recursive: true, force: true });
});

function search(name: string, params: Record<string, string | string[]>, over: { [K in keyof CallOf]?: CallOf[K] | undefined } = {}, on: SearchIndex = index): SearchAnswer {
  const query = new URLSearchParams("cursor" in params ? [] : [["lists", "record"]]);
  for (const [key, value] of Object.entries(params)) for (const each of Array.isArray(value) ? value : [value]) query.append(key, each);
  const answer = onCall({ ...CALL, index: on, ...over } as CallOf, (call) => recordPartOf(searchAskedOf(paramsOf(searchParams, query)), call).answer);
  const parsed = answerOf("/v1/search", 200, JSON.parse(JSON.stringify(answer))) as SearchAnswer;
  artifact[name] = parsed;
  return parsed;
}
const listOf = (answer: SearchAnswer): RecordList => answer.record!;
const keyOf = (hit: RecordHit): string => {
  const ref = readRef(hit.ref, "ref", ["record", "line"]);
  return ref.kind === "record" ? ref.parts.key : `${ref.parts.day}#${LINES.get(`${ref.parts.day} ${ref.parts.unit} ${ref.parts.item}`) ?? ref.parts.unit}`;
};
const keys = (answer: SearchAnswer) => listOf(answer).hits.map(keyOf);
function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Refusal ? `${error.status} ${error.code}` : String(error);
  }
  return "answered";
}

describe("search finds what was meant (D4)", () => {
  it("M1 joins a misspelt rare name by its right spelling, ranked under the exact match and named", () => {
    const answer = search("Priyanaka", { query: "Priyanaka" });
    expect(answer.variants).toEqual({ priyanaka: ["priyanka"] });
    expect(keys(answer)).toEqual(["p3", "p2", "p1"]);
    expect(listOf(answer).total).toBe(3);
    expect(listOf(answer).hits[1]!.snippet).toBe("lunch with «Priyanka» tomorrow");
    expect(skeletonOf("Priyanaka")).toBe(skeletonOf("Priyanka"));
  });

  it("M2 gives a common word no near spellings, and finds a doubled letter by its skeleton", () => {
    const common = search("dinner", { query: "dinner", limit: "50" });
    expect(common.variants).toBeUndefined();
    expect(listOf(common).total).toBe(12);
    const rare = search("diner", { query: "diner" });
    expect(rare.variants).toEqual({ diner: ["dinner"] });
    expect(keys(rare)[0]).toBe("r1");
  });

  it("M3 never widens a quoted word or an excluded one", () => {
    const quoted = search("quoted", { query: '"Priyanaka"' });
    expect(quoted.variants).toBeUndefined();
    expect(keys(quoted)).toEqual(["p3"]);
    const excluded = search("excluded", { query: "tickets -Priyanaka" });
    expect(excluded.variants).toBeUndefined();
    expect(listOf(excluded).total).toBe(0);
  });

  it("M4 finds a word one edit away whose skeleton differs", () => {
    expect(skeletonOf("Kavita")).not.toBe(skeletonOf("Kavitha"));
    const answer = search("Kavita", { query: "Kavita" });
    expect(answer.variants).toEqual({ kavita: ["kavitha"] });
    expect(keys(answer)).toEqual(["k1"]);
  });

  it("L1 lists a person alone newest first, and the first with order=oldest", () => {
    expect(keys(search("person alone", { person: "Ana Sharma" }))).toEqual(["k1", "p2", "p1"]);
    expect(keys(search("person oldest", { person: "Ana Sharma", order: "oldest", limit: "1" }))).toEqual(["p1"]);
  });

  it("N1 takes person as names, up to 10, by the one reader count reads them by: one match applies and is named, several are refused with the matches", () => {
    const sharma = search("person by name", { person: "Sharma" });
    expect(keys(sharma)).toEqual(["k1", "p2", "p1"]);
    expect(sharma.person).toEqual([{ asked: "Sharma", name: "Ana Sharma", ref: expect.any(String) }]);
    expect(keys(search("person by full name", { person: "Ana Verma" }))).toEqual(["v1"]);
    expect(keys(search("person by handle", { person: `jid:${HANDLE_B}` }))).toEqual(["v1"]);
    expect(keys(search("two by repeat", { person: ["Sharma", "Ana Verma"] }))).toEqual(["k1", "v1", "p2", "p1"]);
    expect(refusal(() => search("a shared name", { person: "Ana" }))).toBe("404 PERSON_UNKNOWN");
    expect(refusal(() => search("nobody", { person: "Rosalind" }))).toBe("404 PERSON_UNKNOWN");
    expect(refusal(() => search("nobody and one", { person: ["Rosalind", "Ana Verma"] }))).toBe("404 PERSON_UNKNOWN");
    expect(refusal(() => search("eleven", { person: Array.from({ length: 11 }, (_, n) => `Name${n}`) }))).toBe("422 BAD_PARAMETER");
    expect(refusal(() => search("ten", { person: Array.from({ length: 10 }, (_, n) => `Name${n}`) }))).toBe("404 PERSON_UNKNOWN");
    expect(refusal(() => search("people prepared", { person: "Sharma" }, { people: undefined }))).toBe("503 INDEX_BUILDING");
  });

  it("P1 keeps by place the times the person was there, a guessed day too; excludes by -place; finds an owner's place by its name", () => {
    expect(keys(search("in New York", { query: "station", place: "New York" }))).toEqual(["s2", "s1"]);
    expect(keys(search("New York alone", { place: "New York" }))).toEqual(["s2", "s1", "2025-12-28#1", "t1"]);
    expect(keys(search("not New York", { query: "station", place: "-New York", order: "newest" }))).toEqual(["s3", "2026-01-07#2", "2026-01-07#1", "m2", "m1"]);
    expect(keys(search("at Home", { query: "station", place: "Home", order: "newest" }))).toEqual(["2026-01-07#2", "2026-01-07#1", "m2", "m1"]);
    expect(keys(search("the United States", { query: "station", place: "United States", order: "newest" }))).toEqual(["s3", "s2", "s1"]);
    expect(refusal(() => search("place while prepared", { query: "station", place: "New York" }, { presence: undefined }))).toBe("503 INDEX_BUILDING");
  });

  it("P2 places a line with no clock by its day: every place of the day matches, the hit names them all, its day the date and no at", () => {
    for (const place of ["New York", "Home", "United States"]) {
      expect(keys(search(`bank in ${place}`, { query: "Pivert OR Merle", place })).sort(), place).toEqual(["2025-12-28#1", "t1"]);
    }
    expect(keys(search("bank not New York", { query: "Pivert OR Merle", place: "-New York" }))).toEqual([]);
    expect(keys(search("bank in Chicago", { query: "Pivert OR Merle", place: "Chicago" }))).toEqual([]);
    const hits = listOf(search("bank placed", { query: "Pivert OR Merle" })).hits;
    expect(hits.map((hit) => [keyOf(hit), hit.day, hit.at, hit.the_user_was_at]).sort(), JSON.stringify(hits)).toEqual([
      ["2025-12-28#1", FLIGHT_DAY, undefined, "Home; an unnamed place in New York City"],
      ["t1", FLIGHT_DAY, undefined, "Home; an unnamed place in New York City"],
    ]);
  });

  it("P3 one read of the index, one version of presence: Places publishing mid-search moves neither what a place keeps nor where a hit was", () => {
    const file = join(placesDir, "publish.db");
    writePresenceFile(file, TABLES);
    const HOME_ONLY = presenceTablesOf([stay(at("2025-12-20T00:00"), at("2026-01-12T00:00"), PARIS)], DAYS, LABELS, new Map(), SETTINGS, at("2026-01-12T00:00"), ALONE);
    const plain = presenceSource(file);
    let published = 0;
    const publishing: PresenceSource = {
      file,
      held: (version, load) => {
        const held = plain.held(version, load);
        if (published++ === 0) writePresenceFile(file, HOME_ONLY, "2");
        return held;
      },
    };
    const during = search("New York while Places publishes", { query: "station", place: "New York" }, { presence: publishing });
    expect(published).toBeGreaterThan(0);
    expect(keys(during)).toEqual(["s2", "s1"]);
    expect(listOf(during).hits.map((hit) => hit.the_user_was_at)).toEqual(["New York City, New York, United States (guessed)", "an unnamed place in New York City"]);
    expect(keys(search("New York after", { query: "station", place: "New York" }, { presence: plain }))).toEqual([]);
  });

  it("T1 gives a hit's time where the person was; a piece with no zone, or a search while Places holds none, in the home's", () => {
    const hits = listOf(search("station", { query: "station", order: "oldest", limit: "50" })).hits.filter((hit) => ["s1", "s2", "s3"].includes(keyOf(hit)));
    expect(hits.map((hit) => [keyOf(hit), hit.at, hit.the_user_was_at])).toEqual([
      ["s1", "2025-12-29T09:00-05:00", "an unnamed place in New York City"],
      ["s2", "2025-12-31T10:00-05:00", "New York City, New York, United States (guessed)"],
      ["s3", "2026-01-10T07:00+01:00", "United States"],
    ]);
    const home = listOf(search("at home", { query: "bistro" })).hits[0]!;
    expect([home.at, home.the_user_was_at]).toEqual(["2025-12-21T10:00+01:00", "Home"]);
    expect(listOf(search("no presence", { query: "bistro" }, { presence: undefined })).hits[0]!.at).toBe("2025-12-21T10:00+01:00");
  });

  it("C1 keeps one chat's messages, and names a message's chat", () => {
    const chatA = makeRef("chat", { key: "whatsapp:chat-a" });
    const answer = search("chat a", { chat: chatA });
    expect(keys(answer)).toEqual(["m1"]);
    expect(listOf(answer).hits[0]!.chat).toBe(chatA);
    expect(keys(search("chat b station", { query: "station", chat: makeRef("chat", { key: "whatsapp:chat-b" }) }))).toEqual(["m2"]);
    expect(refusal(() => search("no such chat", { chat: makeRef("chat", { key: "whatsapp:chat-z" }) }))).toBe("422 BAD_PARAMETER");
  });

  it("K1 gives a photo hit its picture when it shows a file the home holds", () => {
    const hits = listOf(search("photos", { families: "photos" })).hits;
    expect(hits.map((hit) => [keyOf(hit), hit.picture])).toEqual([["2026-01-07#2", 1], ["2026-01-07#1", undefined]]);
  });

  it("H1 states held when nothing matched: where the words are at any time, or that nothing holds them", () => {
    expect(listOf(search("volcano", { query: "volcano" })).held).toBeNull();
    const elsewhere = listOf(search("Kavitha in December", { query: "Kavitha", from: "2025-12-20", to: "2025-12-25" }));
    expect([elsewhere.total, elsewhere.held]).toEqual([0, { first: "2026-01-05", last: "2026-01-05" }]);
    expect(listOf(search("found", { query: "Kavitha" })).held).toBeUndefined();
  });

  it("S1 a page holding fewer hits than its scan matched states the scan's count, and counts nothing past it", () => {
    const short = listOf(search("dinner page", { query: "dinner", limit: "5" }));
    expect(short).toMatchObject({ total: 12, capped: false, spread: { families: { notes: 12 }, months: { "2025-12": 6, "2026-01": 6 } } });
    expect(short.hits).toHaveLength(5);
    expect(short.next).toEqual(expect.any(String));
    expect(listOf(search("dinner whole", { query: "dinner", limit: "50" }))).toMatchObject({ total: 12, capped: false });
  });

  it("M5 O1 forgets a day's words with it, keeps a word written again, and names the day pending, erased", () => {
    const own = SearchIndex.write(openHomeFolder(dirname(join(dir, "forget.db"))), join(dir, "forget.db"), () => true, 0, SETTINGS);
    try {
      own.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      const day = "2026-01-08";
      const atoms = [{ n: 1, family: "notes", unit: "u1", start_ms: at(`${day}T09:00`), end_ms: null, text: "Zanzibarite ferry tickets" }];
      own.day(day, { inputs: "a", mtime_us: 1, atoms });
      expect(search("before", { query: "Zanzibarete" }, {}, own).variants).toEqual({ zanzibarete: ["zanzibarite"] });
      own.day(day, { inputs: "b", mtime_us: 2, atoms: [{ ...atoms[0]!, n: 2 }, { n: 1, family: "notes", unit: "u0", start_ms: at(`${day}T08:00`), end_ms: null, text: "a new line" }] });
      expect(search("again", { query: "Zanzibarete" }, {}, own).variants).toEqual({ zanzibarete: ["zanzibarite"] });
      own.forget([], [day]);
      const fresh = (_seq: number, held: HeldDays): Fresh => ({ as_of: null, pending: [...held.days].filter(([, each]) => each.erased).map(([erased]) => ({ day: erased, why: "erased" })) });
      const after = search("after", { query: "Zanzibarete", from: "2026-01-01", to: "2026-01-31" }, { fresh }, own);
      expect(after.variants).toBeUndefined();
      expect(listOf(after).pending).toEqual([{ day, why: "erased" }]);
      expect(listOf(search("elsewhere", { query: "Zanzibarete", from: "2026-02-01", to: "2026-02-28" }, { fresh }, own)).pending).toBeUndefined();
    } finally {
      own.close();
    }
  });

  it("R1 binds a page's next to what its ask resolved to: a person asked holding other handles expires it; what it did not read moves nothing; given with other filters, or written by hand, it is refused", () => {
    const own = SearchIndex.write(openHomeFolder(dirname(join(dir, "cursor.db"))), join(dir, "cursor.db"), () => true, 0, SETTINGS);
    try {
      own.records(RECORDS, [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      own.day("2026-01-08", { inputs: "a", mtime_us: 1, atoms: [{ n: 1, family: "notes", unit: "u1", start_ms: at("2026-01-08T09:00"), end_ms: null, text: "dinner by the river" }] });
      const first = listOf(search("cursor first", { query: "dinner", limit: "4" }, {}, own));
      expect(first.next).toEqual(expect.any(String));
      const second = search("cursor second", { cursor: first.next!, limit: "3" }, {}, own);
      expect(keys(second).filter((key) => first.hits.map(keyOf).includes(key))).toEqual([]);
      expect(listOf(second).hits).toHaveLength(3);
      expect(refusal(() => search("cursor other filter", { cursor: first.next!, families: "notes" }, {}, own))).toBe("422 BAD_PARAMETER");
      expect(refusal(() => search("cursor bare", { cursor: Buffer.from(JSON.stringify([0, 1])).toString("base64url") }, {}, own))).toBe("422 BAD_PARAMETER");
      expect(refusal(() => search("cursor presence", { cursor: first.next! }, { presence: presenceSource(join(placesDir, "moved.db")) }, own))).toBe("answered");
      expect(refusal(() => search("cursor people unread", { cursor: first.next! }, { people: { ...PEOPLE_MAP, version: "people-2" } }, own))).toBe("answered");
      const ana = listOf(search("cursor person", { person: "Ana Sharma", limit: "1" }, {}, own));
      expect(refusal(() => search("cursor people same", { cursor: ana.next! }, { people: { ...PEOPLE_MAP, version: "people-2" } }, own))).toBe("answered");
      const moved: PeopleMap = { ...PEOPLE_MAP, version: "people-3", person: (id) => (id === "person:a" ? { ...PEOPLE[id]!, handles: [...PEOPLE[id]!.handles, "jid:15550000009@s.whatsapp.net"] } : PEOPLE[id]) };
      expect(refusal(() => search("cursor people moved", { cursor: ana.next! }, { people: moved }, own))).toBe("409 CURSOR_EXPIRED");
      own.forget([], ["2026-01-08"]);
      expect(refusal(() => search("cursor forget", { cursor: first.next! }, {}, own))).toBe("answered");
    } finally {
      own.close();
    }
  });

  it("F4 counts a near spelling's rarity and weight as if the products left out were not there", () => {
    const own = SearchIndex.write(openHomeFolder(dirname(join(dir, "left-out", "index.db"))), join(dir, "left-out", "index.db"), () => true, 0, SETTINGS);
    try {
      const asks = Array.from({ length: 10 }, (_, n): RecordEntry => ({
        record: { source: "ask:local:home", kind: "turn", key: `a${n}` }, family: "ask", version: `v-a${n}`, start_ms: at(`2026-01-0${n % 9 + 1}T09:00`),
        end_ms: null, title: "", text: `what did the exampel say, exampels too ${ORDINALS[n]}`, who: [], link: null,
      }));
      own.records([...asks, message("x1", "an example of the menu", at("2026-01-02T10:00"))], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      expect(search("exampel everywhere", { query: "exampel" }, {}, own).variants).toBeUndefined();
      const left = search("exampel without ask", { query: "exampel" }, { reader: "model" }, own);
      expect(left.variants).toEqual({ exampel: ["example"] });
      expect(keys(left)).toEqual(["x1"]);
      expect(listOf(left).total).toBe(1);
    } finally {
      own.close();
    }
  });

  it("F5 holds, spreads and dates a line with no clock by its date, where the home's day starts at 04:00", () => {
    const late: DaySettings = { zone: "Europe/Paris", day_start_hour: 4 };
    const own = SearchIndex.write(openHomeFolder(dirname(join(dir, "dated", "index.db"))), join(dir, "dated", "index.db"), () => true, 0, late);
    try {
      own.records([
        { record: { source: BANK, kind: "txn", key: "b1" }, family: "money", version: "v-b1", start_ms: Date.parse("2026-03-01T00:00:00Z"), end_ms: null, title: "", text: "card payment Loriot bakery", who: [], link: null, dated: true },
        note("b2", "a payment reminder", at("2026-02-20T12:00")),
      ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      const short = listOf(search("payment by month", { query: "payment", limit: "1" }, { settings: late }, own));
      expect(short.spread!.months).toEqual({ "2026-02": 1, "2026-03": 1 });
      const line = listOf(search("bakery", { query: "bakery" }, { settings: late }, own)).hits[0]!;
      expect([line.day, line.at]).toEqual(["2026-03-01", undefined]);
      expect(listOf(search("bakery in April", { query: "bakery", from: "2026-04-01", to: "2026-04-30" }, { settings: late }, own)).held).toEqual({ first: "2026-03-01", last: "2026-03-01" });
    } finally {
      own.close();
    }
  });

  it("F7 learns a word again after another connection removed its last entry between two of a writer's transactions", () => {
    const file = join(dir, "relearn", "index.db");
    const own = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, SETTINGS);
    try {
      own.records([note("w1", "Quillabeth ferry tickets", at("2026-01-03T09:00"))], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      expect(search("relearn before", { query: "Quillabath" }, {}, own).variants).toEqual({ quillabath: ["quillabeth"] });
      for (const other of SearchIndex.existing(openHomeFolder(dirname(file)), file)) {
        other.forget([{ source: NOTES, kind: "note", key: "w1" }], []);
        other.close();
      }
      expect(search("relearn erased", { query: "Quillabath" }, {}, own).variants).toBeUndefined();
      own.records([note("w2", "Quillabeth ferry again", at("2026-01-04T09:00"))], [], { position: { seq: 2, statement: "s-2", reread: 0 } });
      expect(search("relearn after", { query: "Quillabath" }, {}, own).variants).toEqual({ quillabath: ["quillabeth"] });
    } finally {
      own.close();
    }
  });

  it("F10 names a near spelling only when an entry the query's filters keep holds it", () => {
    const january = search("Priyanaka in January", { query: "Priyanaka", from: "2026-01-01", to: "2026-01-31" });
    expect(listOf(january).total).toBe(0);
    expect(january.variants).toBeUndefined();
    const december = search("Priyanaka in December", { query: "Priyanaka", from: "2025-12-01", to: "2025-12-31" });
    expect(december.variants).toEqual({ priyanaka: ["priyanka"] });
    expect(search("Priyanaka by messages family", { query: "Priyanaka", families: "messages" }).variants).toBeUndefined();
  });
});
