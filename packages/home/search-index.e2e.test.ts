import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { civilDay, dayBounds, openHomeFolder, type DaySettings, type RecordRef } from "@lifestreamprotocol/core";
import type { DayFileFact } from "@lifestreamprotocol/families";
import type { Hit, SearchAnswer, SearchQuery } from "./record-search.js";
import { PREPARED_STORE } from "./prepared.js";
import { buildingFileOf, SearchIndex, type AtomEntry, type IndexPosition, type RecordEntry, type RecordRead, type FactsRead, type AttachedRead, type SearchCursor } from "./search-index.js";
import { termsOf } from "./search-words.js";
import { REPO } from "./test/support.js";
import { exactTerms, searchOf } from "./test/record-reads.js";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const NOW = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const T0 = Date.parse("2026-09-28T06:00:00Z");
const A = "apple-notes:local:device-a";
const B = "apple-notes:local:device-b";
const answers: Record<string, unknown> = {};
const scratch = mkdtempSync(join(tmpdir(), "lifestream-search-index-"));

let dir: string;
let file: string;
let seq = 0;

beforeEach((context) => {
  dir = join(scratch, context.task.name.slice(0, 3).trim());
  mkdirSync(dir, { recursive: true });
  file = join(dir, "index.db");
  seq = 0;
});

afterAll(() => {
  mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
  writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "search-index.json"), `${JSON.stringify(answers, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
});

const letters = (i: number) => [i % 26, Math.floor(i / 26) % 26, Math.floor(i / 676) % 26].map((at) => String.fromCharCode(97 + at)).join("");
const record = (source: string, key: string, text: string, start_ms: number | null, extra: Partial<RecordEntry> = {}): RecordEntry => ({
  record: { source, kind: "note", key }, family: "notes", version: `v-${key}-${text.length}`, start_ms, end_ms: null, title: "", text, who: [], link: null, ...extra,
});
const atom = (n: number, text: string, start_ms: number | null, extra: Partial<AtomEntry> = {}): AtomEntry => ({ n, family: "notes", unit: `u${n}`, start_ms, end_ms: null, text, ...extra });
const put = (index: SearchIndex, puts: RecordEntry[], removes: RecordRef[] = []) => index.records(puts, removes, { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
const ALL = () => true;
const watchSynchronous = (index: SearchIndex) => {
  const db = (index as unknown as { db: Database.Database }).db;
  const pragma = db.pragma.bind(db);
  const said: string[] = [];
  db.pragma = ((source: string, options?: Database.PragmaOptions) => {
    if (/^synchronous\s*=/u.test(source)) said.push(source.replace(/^synchronous\s*=\s*/u, ""));
    return pragma(source, options);
  }) as typeof db.pragma;
  return { said: () => said.splice(0), level: () => pragma("synchronous", { simple: true }) };
};
const metaOf = (path: string, key: string) => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(key) ?? null;
  } finally {
    db.close();
  }
};
const day = (index: SearchIndex, name: string, atoms: AtomEntry[]) => index.day(name, { inputs: `inputs-${++seq}`, mtime_us: seq, atoms });
const query = (q: string | undefined, extra: Partial<SearchQuery> = {}): SearchQuery =>
  ({ ...(q === undefined ? {} : { terms: exactTerms(q) }), order: q === undefined ? "newest" : "relevance", limit: 200, ...extra });
const find = (index: SearchIndex, q: string | undefined, extra: Partial<SearchQuery> = {}, name?: string) => {
  const answer = searchOf(index, query(q, extra));
  if (name !== undefined) answers[name] = answer;
  if (!("hits" in answer)) throw new Error("a search answered counts");
  return answer;
};
const refs = (hits: Hit[]) => hits.map((hit) => (hit.layer === "records" ? `${(hit.ref as RecordRef).source.slice(-8)} ${(hit.ref as RecordRef).key}` : `atom ${JSON.stringify(hit.ref)}`));
const names = (index: SearchIndex, role: string) => {
  const db = new Database(index.file, { readonly: true });
  try {
    return db.prepare("SELECT name FROM names WHERE role = ? ORDER BY name").pluck().all(role) as string[];
  } finally {
    db.close();
  }
};
const slots = (index: SearchIndex) => {
  const db = new Database(index.file, { readonly: true });
  try {
    return db.prepare("SELECT slot FROM entries ORDER BY slot").pluck().all() as number[];
  } finally {
    db.close();
  }
};

describe("the search index", () => {
  it("S1 a record and the atom that prints it are one entry, whichever came first", () => {
    const ref = { source: A, kind: "note", key: "r1" };
    const words = record(A, "r1", "dinner at the lighthouse", T0);
    const line = atom(1, "Person A: dinner at the lighthouse", T0, { record: ref, title: "Chat with Person A" });
    const first = SearchIndex.write(openHomeFolder(dirname(join(dir, "first.db"))), join(dir, "first.db"), ALL, 0, SETTINGS);
    put(first, [words]);
    day(first, "2026-09-28", [line]);
    const second = SearchIndex.write(openHomeFolder(dirname(join(dir, "second.db"))), join(dir, "second.db"), ALL, 0, SETTINGS);
    day(second, "2026-09-28", [line]);
    put(second, [words]);
    const one = find(first, "lighthouse", {}, "S1 record first");
    const other = find(second, "lighthouse", {}, "S1 day first");
    expect(one).toEqual(other);
    expect(one.hits).toHaveLength(1);
    expect(one.hits[0]).toMatchObject({ layer: "records", ref, day: "2026-09-28", n: 1, title: "Chat with Person A" });
    for (const words of ["Chat", "Person", "dinner lighthouse"]) expect(refs(find(first, words).hits)).toEqual([`device-a r1`]);
    expect(slots(first)).toHaveLength(1);
    expect(slots(second)).toHaveLength(1);
    first.close();
    second.close();
  });

  it("S2 an atom's new words replace its old ones in its record's entry when the day renders again", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const ref = { source: A, kind: "note", key: "r1" };
    put(index, [record(A, "r1", "tickets", T0, { who: ["+15550000003"] })]);
    day(index, "2026-09-28", [atom(1, "tickets with +15550000003", T0, { record: ref })]);
    expect(refs(find(index, "15550000003").hits)).toEqual(["device-a r1"]);
    day(index, "2026-09-28", [atom(1, "tickets with Person C", T0, { record: ref })]);
    const named = find(index, "Person C", {}, "S2 renamed");
    expect(refs(named.hits)).toEqual(["device-a r1"]);
    expect(named.hits[0]!.snippet).toBe("tickets with «Person» «C»");
    expect(find(index, "Person").total).toBe(1);
    expect(slots(index)).toHaveLength(1);
    index.close();
  });

  it("S3 an atom whose record has no text, or whose record goes, is an entry of its own", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const ref = { source: A, kind: "note", key: "photo" };
    day(index, "2026-09-28", [atom(4, "a photo of the harbour", T0, { record: ref })]);
    expect(find(index, "harbour").hits.map((hit) => [hit.layer, hit.ref, hit.record])).toEqual([["atoms", { day: "2026-09-28", n: 4 }, ref]]);
    put(index, [record(A, "photo", "harbour at dusk", T0)]);
    expect(find(index, "harbour").hits.map((hit) => hit.layer)).toEqual(["records"]);
    put(index, [], [ref]);
    expect(find(index, "harbour", {}, "S3 record removed").hits.map((hit) => [hit.layer, hit.ref])).toEqual([["atoms", { day: "2026-09-28", n: 4 }]]);
    expect(find(index, "dusk").hits).toEqual([]);
    put(index, [record(A, "photo", "harbour at dusk", T0)]);
    index.forget([ref], []);
    expect(find(index, "harbour").hits.map((hit) => hit.layer)).toEqual(["atoms"]);
    index.forget([], ["2026-09-28"]);
    expect(find(index, "harbour").hits).toEqual([]);
    expect(slots(index)).toEqual([]);
    index.close();
  });

  it("S4 two copies of a record are one hit; removing one leaves the other", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(index, [record(A, "n2", "buy lighthouse tickets", T0)]);
    put(index, [record(B, "n2", "buy lighthouse tickets", T0)]);
    day(index, "2026-09-28", [atom(1, "buy lighthouse tickets", T0, { record: { source: A, kind: "note", key: "n2" } }), atom(2, "buy lighthouse tickets", T0, { record: { source: B, kind: "note", key: "n2" } })]);
    const both = find(index, "tickets", {}, "S4 copies");
    expect(refs(both.hits)).toEqual(["device-a n2"]);
    expect(both.total).toBe(1);
    put(index, [], [{ source: A, kind: "note", key: "n2" }]);
    const left = find(index, "tickets").hits;
    expect(refs(left.filter((hit) => hit.layer === "records"))).toEqual(["device-b n2"]);
    expect(left.filter((hit) => hit.layer === "atoms").map((hit) => hit.ref)).toEqual([{ day: "2026-09-28", n: 1 }]);
    index.close();
  });

  it("S5 a full millisecond takes the next; an entry whose time changes moves", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(index, Array.from({ length: 1_001 }, (_, i) => record(A, `m${i}`, `crowded millisecond ${letters(i)}`, T0)));
    const taken = slots(index);
    expect(taken.filter((slot) => Math.floor(slot / 1000) === T0)).toHaveLength(1_000);
    expect(taken.filter((slot) => Math.floor(slot / 1000) === T0 + 1)).toHaveLength(1);
    expect(find(index, "crowded").total).toBe(1_001);
    const seen = new Set<string>();
    for (let after: SearchCursor | undefined; ;) {
      const page = find(index, "crowded", { order: "newest", limit: 200, ...(after === undefined ? {} : { after }) });
      for (const hit of page.hits) seen.add((hit.ref as RecordRef).key);
      if (page.next === undefined) break;
      after = page.next;
    }
    expect(seen.size).toBe(1_001);
    put(index, [record(A, "m7", "crowded millisecond, moved", T0 + 5 * DAY)]);
    expect(refs(find(index, "moved", { from_ms: T0 + 5 * DAY, to_ms: T0 + 6 * DAY }).hits)).toEqual(["device-a m7"]);
    expect(find(index, "moved", { from_ms: T0, to_ms: T0 + DAY }).hits).toEqual([]);
    expect(slots(index)).toHaveLength(1_001);
    index.close();
  });

  it("S6 every filter keeps what a scan of the fixture keeps", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const sources = ["apple-notes:local:a", "apple-notes:local:b", "whatsapp:local:c", "gmail:person-a@example.com"];
    const families = ["notes", "messages", "mail"];
    const kinds = ["note", "msg", "mail"];
    const fixture = Array.from({ length: 60 }, (_, i) => ({
      entry: record(sources[i % 4]!, `k${i}`, `synthetic entry ${letters(i)}`, i % 10 === 9 ? null : T0 + i * 7 * HOUR, {
        record: { source: sources[i % 4]!, kind: kinds[i % 3]!, key: `k${i}` }, family: families[i % 3]!, who: i % 5 === 0 ? ["+15550000001"] : [],
      }),
    }));
    put(index, fixture.map((each) => each.entry));
    const lone = Array.from({ length: 6 }, (_, i) => atom(i + 1, `synthetic total ${letters(i)}`, T0 + i * 11 * HOUR, { family: "health" }));
    day(index, "2026-09-28", lone);
    type Row = { ref: string; family: string; source: string | null; who: string[]; start: number | null };
    const rows: Row[] = [
      ...fixture.map(({ entry }) => ({ ref: `${entry.record.source} ${entry.record.key}`, family: entry.family, source: entry.record.source, who: entry.who, start: entry.start_ms })),
      ...lone.map((each) => ({ ref: `atom ${each.n}`, family: "health", source: null, who: [], start: each.start_ms })),
    ];
    const cases: [string, Partial<SearchQuery>, (row: Row) => boolean][] = [
      ["family", { families: ["messages", "mail"] }, (row) => ["messages", "mail"].includes(row.family)],
      ["product", { products: ["apple-notes"] }, (row) => row.source?.startsWith("apple-notes:") === true],
      ["person", { who: ["+15550000001"] }, (row) => row.who.includes("+15550000001")],
      ["from", { from_ms: T0 + 100 * HOUR }, (row) => row.start !== null && row.start >= T0 + 100 * HOUR],
      ["to", { to_ms: T0 + 100 * HOUR }, (row) => row.start !== null && row.start < T0 + 100 * HOUR],
      ["family and time", { families: ["notes"], from_ms: T0, to_ms: T0 + 200 * HOUR }, (row) => row.family === "notes" && row.start !== null && row.start < T0 + 200 * HOUR],
    ];
    const name = (hit: Hit) => (hit.layer === "records" ? `${(hit.ref as RecordRef).source} ${(hit.ref as RecordRef).key}` : `atom ${(hit.ref as { n: number }).n}`);
    for (const [label, filter, keeps] of cases) {
      const expected = rows.filter(keeps).map((row) => row.ref).sort();
      expect(find(index, undefined, filter).hits.map(name).sort(), `${label}, no words`).toEqual(expected);
      expect(find(index, "synthetic", filter).hits.map(name).sort(), `${label}, with words`).toEqual(expected);
      expect(searchOf(index, query("synthetic", { ...filter, group: "family" })), label).toMatchObject({ total: expected.length, capped: false });
    }
    index.close();
  });

  it("S7 a page's total is the scan's, which stops at its bound and says capped; its facets are of the scan; a count by group of fewer than its scan holds is of every match", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(index, Array.from({ length: 10_000 }, (_, i) => record(A, `h${i}`, `history ${i}`, T0 + i * 1_000)));
    expect(find(index, "history", { limit: 5, facets: ["family"] })).toMatchObject({ total: 10_000, capped: false, facets: { family: [{ key: "notes", n: 10_000 }] } });
    put(index, [record(A, "h-last", "history once more", T0 + 20_000_000)]);
    const capped = find(index, "history", { limit: 5, facets: ["family", "day"] }, "S7 capped");
    expect(capped).toMatchObject({ total: 10_000, capped: true, facets: { family: [{ key: "notes", n: 10_000 }] } });
    expect(find(index, "history", { order: "newest", limit: 5 })).toMatchObject({ total: 10_000, capped: true });
    expect(find(index, undefined, { families: ["notes"], order: "newest", limit: 5 })).toMatchObject({ total: 10_000, capped: true });
    put(index, [record(A, "typo", "histroy once", T0 + 30_000_000)]);
    const near = searchOf(index, query(undefined, { terms: termsOf("histroy"), order: "relevance", limit: 5 }));
    expect(near).toMatchObject({ variants: { histroy: ["history"] }, total: 10_000, capped: true });
    expect(searchOf(index, query("history", { group: "family" }))).toEqual({ groups: [{ key: "notes", n: 10_001 }], total: 10_001, capped: false });
    expect(refs(find(index, "history", { order: "oldest", limit: 1 }).hits)).toEqual(["device-a h0"]);
    index.close();
  });

  it("S8 ranks a newer match above an older one alike, gives every near-copy as a hit of its own, and cuts a snippet around the first word", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(index, [record(A, "old", "dinner at the lighthouse north", NOW - 400 * DAY), record(A, "new", "dinner at the lighthouse south", NOW - 2 * DAY)]);
    expect(refs(find(index, "lighthouse").hits)).toEqual(["device-a new", "device-a old"]);
    for (let i = 0; i < 5; i++) day(index, `2026-10-0${i + 1}`, [atom(1, `${i % 2 === 0 ? "" : "Person A: "}viewed the dinner chat ${i}`, Date.parse(`2026-10-0${i + 1}T12:00:00Z`), { family: "screen" })]);
    const repeated = find(index, "viewed", {}, "S8 repeated");
    expect(repeated.hits).toHaveLength(5);
    expect(repeated.total).toBe(5);
    put(index, [
      record(A, "pay1", "−175.95 INR Bank …0001: UPI-Ride Co", NOW - 3 * DAY), record(A, "pay2", "−929.44 INR Bank …0001: UPI-Ride Co", NOW - 3 * DAY),
      record(A, "pay3", "−929.44 INR Bank …0001: UPI-Ride Co", NOW - 3 * DAY),
    ]);
    expect(refs(find(index, "ride").hits).sort()).toEqual(["device-a pay1", "device-a pay2", "device-a pay3"]);
    const long = `${"word ".repeat(40)}the harbour light ${"more ".repeat(40)}`;
    put(index, [record(A, "long", long, NOW - DAY)]);
    const snippet = find(index, "harbour").hits[0]!.snippet;
    expect(snippet).toMatch(/^…(word )+the «harbour» light( more)+…$/u);
    expect(snippet.length).toBeLessThan(2 * 70 + 20);
    index.close();
  });

  it("S9 the last word is a prefix only in a box, from three characters, and the word as typed ranks first", () => {
    const typing = (q: string, extra: Partial<SearchQuery> = {}) => {
      const answer = searchOf(index, { terms: termsOf(q), typing: true, order: "relevance", limit: 200, ...extra });
      if (!("hits" in answer)) throw new Error("a search answered counts");
      return answer;
    };
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(index, [record(A, "c", "coffee with co", T0), record(A, "d", "a cozy coat", T0 + HOUR)]);
    expect(refs(find(index, "co").hits)).toEqual(["device-a c"]);
    expect(find(index, "cof").hits).toEqual([]);
    expect(searchOf(index, { terms: termsOf("cof"), order: "relevance", limit: 200 })).toMatchObject({ hits: [], total: 0 });
    expect(refs(typing("co").hits)).toEqual(["device-a c"]);
    expect(refs(typing("cof").hits)).toEqual(["device-a c"]);
    expect(refs(typing("cof", { order: "newest" }).hits)).toEqual(["device-a c"]);
    expect(typing("cof").hits[0]!.snippet).toBe("«coffee» with co");
    expect(find(index, "coffee").hits[0]!.snippet).toBe("«coffee» with co");
    put(index, [record(A, "cot", "a cot for the night", T0), record(A, "cotton", "cotton", T0 + 30 * DAY, { title: "cotton cotton" })]);
    expect(refs(typing("cot").hits)).toEqual(["device-a cot", "device-a cotton"]);
    expect(refs((searchOf(index, { terms: termsOf("cot"), order: "relevance", limit: 200 }) as { hits: Hit[] }).hits)).toEqual(["device-a cot"]);
    index.close();
  });

  it("S10 a build is read only once it has read through; a rebuild leaves the index read; a file home.db no longer holds as it read it, or of another format, is built again", () => {
    const other = new Map<number, string>();
    const fits = (at: IndexPosition) => at.seq === 0 || (other.get(at.seq) ?? `s-${at.seq}`) === at.statement;
    const rebuild = (at: IndexPosition, building: boolean) => at.seq === 0 || building;
    let index = SearchIndex.write(openHomeFolder(dirname(file)), file, fits, 0, SETTINGS);
    expect(index.building).toBe(true);
    put(index, [record(A, "w", "whole words", T0)]);
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)).toBeUndefined();
    index.finish();
    index.close();
    const read = () => {
      const reader = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
      try {
        return refs(find(reader, "whole").hits);
      } finally {
        reader.close();
      }
    };
    expect(read()).toEqual(["device-a w"]);
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, fits, 0, SETTINGS);
    expect(index.building).toBe(false);
    index.close();
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, rebuild, 0, SETTINGS);
    expect(index.building).toBe(true);
    expect(read()).toEqual(["device-a w"]);
    put(index, [record(A, "w", "whole words again", T0)]);
    index.close();
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, rebuild, 0, SETTINGS);
    expect(index.building).toBe(true);
    expect(refs(find(index, "again").hits)).toEqual(["device-a w"]);
    index.finish();
    index.close();
    const rebuilt = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    expect(rebuilt.position()).toEqual({ seq, statement: `s-${seq}`, reread: 0 });
    rebuilt.close();
    other.set(seq, "s-another");
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, fits, 7, SETTINGS);
    expect(index.building).toBe(true);
    expect(index.position()).toEqual({ seq: 0, statement: null, reread: 7 });
    put(index, [record(A, "w", "whole words, built again", T0)]);
    index.close();
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, fits, 7, SETTINGS);
    expect(index.building).toBe(true);
    expect(refs(find(index, "built").hits)).toEqual(["device-a w"]);
    index.close();
    rmSync(buildingFileOf(file), { force: true });
    writeFileSync(file, "not an index");
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)).toBeUndefined();
    expect(SearchIndex.existing(openHomeFolder(dirname(file)), file)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    index = SearchIndex.write(openHomeFolder(dirname(file)), file, fits, 0, SETTINGS);
    expect(index.building).toBe(true);
    index.close();
  });

  it("S11 counts by day by the day start, and a title no entry shows leaves the file", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const message = (key: string, chat: string, at: number) => record("whatsapp:local:c", key, "the user said hello", at, { title: chat, family: "messages", record: { source: "whatsapp:local:c", kind: "msg", key } });
    const messages = [message("1", "Person A", T0), message("2", "Person B", T0 + HOUR), message("3", "Person B", T0 + 2 * HOUR), message("4", "Person C", T0 - 3 * HOUR)];
    put(index, messages);
    const counted = find(index, "the user", { facets: ["day"] }, "S11 facets");
    expect(counted.facets!.day).toEqual([{ key: "2026-09-27", n: 1 }, { key: "2026-09-28", n: 3 }]);
    const midnight = SearchIndex.write(openHomeFolder(dirname(join(dirname(file), "s11-midnight", "index.db"))), join(dirname(file), "s11-midnight", "index.db"), ALL, 0, { zone: "UTC", day_start_hour: 0 });
    put(midnight, messages);
    expect(searchOf(midnight, query("the user", { facets: ["day"] }))).toMatchObject({ facets: { day: [{ key: "2026-09-28", n: 4 }] } });
    midnight.close();
    put(index, [], [{ source: "whatsapp:local:c", kind: "msg", key: "2" }, { source: "whatsapp:local:c", kind: "msg", key: "3" }]);
    expect(names(index, "title")).toEqual(["Person A", "Person C"]);
    index.close();
  });

  it("S12 a text the line says only in another order keeps its own column", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const ref = { source: A, kind: "note", key: "p" };
    put(index, [record(A, "p", "dinner at the lighthouse", T0), record(A, "q", "harbour lights", T0 + HOUR)]);
    day(index, "2026-09-28", [atom(1, "the lighthouse at dinner", T0, { record: ref }), atom(2, "Person A: harbour lights", T0 + HOUR, { record: { source: A, kind: "note", key: "q" } })]);
    expect(refs(find(index, '"dinner at the lighthouse"').hits)).toEqual(["device-a p"]);
    expect(refs(find(index, '"harbour lights"').hits)).toEqual(["device-a q"]);
    index.close();
  });

  it("S13 a filter on most of the index keeps what a scan of the fixture keeps, counted alike", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const entries = Array.from({ length: 200 }, (_, i) => record(i % 10 === 0 ? "calls:local:a" : "whatsapp:local:a", `m${i}`, `synthetic said ${letters(i)}`, T0 + i * HOUR, {
      family: i % 10 === 0 ? "calls" : "messages", record: { source: i % 10 === 0 ? "calls:local:a" : "whatsapp:local:a", kind: i % 10 === 0 ? "call" : "msg", key: `m${i}` },
    }));
    put(index, entries);
    for (const family of ["messages", "calls"]) {
      const kept = entries.filter((each) => each.family === family);
      for (const order of ["relevance", "newest", "oldest"] as const) {
        const found = find(index, "synthetic", { families: [family], order, facets: ["family"] });
        expect(found.hits.map((hit) => (hit.ref as RecordRef).key).sort(), `${family} ${order}`).toEqual(kept.map((each) => each.record.key).sort());
        expect(found).toMatchObject({ total: kept.length, capped: false, facets: { family: [{ key: family, n: kept.length }] } });
      }
      expect(searchOf(index, query(undefined, { families: [family], group: "family" }))).toMatchObject({ total: kept.length, capped: false });
    }
    const seen: string[] = [];
    for (let after: SearchCursor | undefined; ;) {
      const page = find(index, undefined, { families: ["messages"], order: "newest", limit: 7, ...(after === undefined ? {} : { after }) });
      seen.push(...page.hits.map((hit) => (hit.ref as RecordRef).key));
      if (page.next === undefined) break;
      after = page.next;
    }
    expect(seen).toHaveLength(180);
    expect(new Set(seen).size).toBe(180);
    index.close();
  });

  it("S15 an atom's printed names are kept beside its line and title, and move with them", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const ref = { source: A, kind: "note", key: "r1" };
    put(index, [record(A, "r1", "I will call", T0)]);
    const rose = { start: 0, end: 4, who: "phone:+15550000001" };
    day(index, "2026-09-28", [
      atom(1, "Rose: I will call", T0, { record: ref, names: [rose], title: "Rose", title_names: [rose] }),
      atom(2, "a line that names no one", T0 + HOUR, { title: "Notes" }),
    ]);
    const passages = (reader: SearchIndex, q: string) => find(reader, q, { passages: true }).hits.map((hit) => hit.passages);
    expect(passages(index, "call")).toEqual([[{ text: "Rose: I will call", names: [rose] }, { text: "I will call", names: [] }, { text: "Rose", names: [rose] }]]);
    expect(passages(index, "line")).toEqual([[{ text: "a line that names no one", names: [] }, { text: "Notes", names: [] }]]);
    expect(find(index, "call").hits[0]).not.toHaveProperty("passages");
    const merged = { ...rose, who: "person:rose" };
    day(index, "2026-09-28", [
      atom(1, "Rose: I will call", T0, { record: ref, names: [merged], title: "Rose", title_names: [merged] }),
      atom(2, "a line that names no one", T0 + HOUR, { title: "Notes" }),
    ]);
    const now = [[{ text: "Rose: I will call", names: [merged] }, { text: "I will call", names: [] }, { text: "Rose", names: [merged] }]];
    expect(passages(index, "call")).toEqual(now);
    expect(slots(index)).toHaveLength(2);
    index.finish();
    const read = SearchIndex.read(openHomeFolder(dirname(file)), file)!;
    try {
      expect(passages(read, "call")).toEqual(now);
    } finally {
      read.close();
    }
  });

  it("S16 a record printed by two atoms hands on each passage with its own names", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const ref = { source: A, kind: "note", key: "r1" };
    put(index, [record(A, "r1", "dinner at eight", T0, { title: "Plans" })]);
    const ada = { start: 0, end: 11, who: "person:ada" };
    const bo = { start: 8, end: 18, who: "person:bo" };
    const group = { start: 11, end: 21, who: "person:bo" };
    day(index, "2026-09-28", [
      atom(1, "Ada Example: dinner at eight", T0, { record: ref, names: [ada], title: "Chat with Ada Example", title_names: [{ start: 10, end: 21, who: "person:ada" }] }),
      atom(2, "Sent to Bo Example: dinner at eight", T0, { record: ref, names: [bo], title: "Group with Bo Example", title_names: [group] }),
    ]);
    const hit = find(index, "dinner", { passages: true }, "S16 two atoms").hits;
    expect(hit).toHaveLength(1);
    const said = hit[0]!.passages!.map(({ text, names }) => [text, names.map(({ start, end, who }) => [text.slice(start, end), who])]);
    expect(said).toEqual([
      ["Ada Example: dinner at eight", [["Ada Example", "person:ada"]]],
      ["Sent to Bo Example: dinner at eight", [["Bo Example", "person:bo"]]],
      ["dinner at eight", []],
      ["Chat with Ada Example", [["Ada Example", "person:ada"]]],
      ["Group with Bo Example", [["Bo Example", "person:bo"]]],
      ["Plans", []],
    ]);
    expect(hit[0]).toMatchObject({ title: "Plans", snippet: "Ada Example: «dinner» at eight" });
    index.close();
  });

  it("S17 a count by one key or two of fewer matches than its scan holds is every match, counted exactly", () => {
    const kolkata: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, kolkata);
    const entries = Array.from({ length: 15_000 }, (_, i) => {
      const message = i % 5 !== 0;
      const at = Date.parse("2025-11-20T00:00:00Z") + i * 47 * 60_000;
      return record(message ? "whatsapp:local:c" : A, `c${i}`, `synthetic ${letters(i)}`, at, message
        ? { family: "messages", record: { source: "whatsapp:local:c", kind: "msg", key: `c${i}` } }
        : {});
    });
    put(index, [...entries, record(A, "untimed-1", "synthetic untimed", null), record(A, "untimed-2", "synthetic untimed too", null)]);
    type Row = { at: number | null; family: string };
    const rows: Row[] = [...entries, { start_ms: null, family: "notes" }, { start_ms: null, family: "notes" }].map((each) => ({ at: each.start_ms, family: each.family }));
    const keyOf = (key: string, row: Row): string | null => {
      if (key === "family") return row.family;
      if (row.at === null) return null;
      const day = civilDay(row.at, kolkata);
      return key === "day" ? day : day.slice(0, 7);
    };
    const byHand = (by: string[], keep: (row: Row) => boolean = () => true) => {
      const counted = new Map<string, number>();
      for (const row of rows.filter(keep)) {
        const key = by.map((each) => keyOf(each, row));
        if (key.includes(null)) continue;
        counted.set(JSON.stringify(key), (counted.get(JSON.stringify(key)) ?? 0) + 1);
      }
      return counted;
    };
    const asked = (q: string | undefined, by: SearchQuery["group"], extra: Partial<SearchQuery> = {}) => {
      const answer = searchOf(index, query(q, { group: by, ...extra }));
      if (!("groups" in answer)) throw new Error("a count answered hits");
      return answer;
    };
    const asMap = (groups: { key: string | string[]; n: number }[]) => new Map(groups.map(({ key, n }) => [JSON.stringify(Array.isArray(key) ? key : [key]), n]));
    for (const key of ["day", "month", "family"] as const) {
      const answer = asked("synthetic", key);
      expect(answer.total, key).toBe(15_002);
      expect(answer.capped, key).toBe(false);
      expect(asMap(answer.groups), key).toEqual(byHand([key]));
      expect(answer.groups.map((each) => each.key), key).toEqual([...byHand([key]).keys()].map((each) => JSON.parse(each)[0]).sort());
    }
    const messages = asked(undefined, "month", { families: ["messages"], from_ms: Date.parse("2026-01-01T00:00:00Z") });
    expect(asMap(messages.groups)).toEqual(byHand(["month"], (row) => row.family === "messages" && row.at !== null && row.at >= Date.parse("2026-01-01T00:00:00Z")));
    const pairs = asked("synthetic", ["family", "day"]);
    expect(pairs.groups).toEqual([...byHand(["family", "day"])].map(([key, n]) => ({ key: JSON.parse(key), n })).sort((a, b) => JSON.stringify(a.key) < JSON.stringify(b.key) ? -1 : 1));
    answers["S17 family by day"] = pairs.groups.slice(0, 12);
    index.close();
  });

  it("S18 a day's bound at an offset in seconds counts each match on its own day", () => {
    const monrovia: DaySettings = { zone: "Africa/Monrovia", day_start_hour: 0 };
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, monrovia);
    const bound = Date.parse("1965-06-02T00:44:30Z");
    const times = [bound - 60_000, bound - 1, bound, bound + 60_000, bound + 10 * 60_000];
    put(index, times.map((at, i) => record(A, `m${i}`, `synthetic ${letters(i)}`, at)));
    expect(times.map((at) => civilDay(at, monrovia))).toEqual(["1965-06-01", "1965-06-01", "1965-06-02", "1965-06-02", "1965-06-02"]);
    expect(searchOf(index, query("synthetic", { group: "day" }))).toEqual({ groups: [{ key: "1965-06-01", n: 2 }, { key: "1965-06-02", n: 3 }], total: 5, capped: false });
    expect(searchOf(index, query("synthetic", { group: ["day", "family"] }))).toMatchObject({ groups: [{ key: ["1965-06-01", "notes"], n: 2 }, { key: ["1965-06-02", "notes"], n: 3 }] });
    index.close();
  });

  it("S19 a workout's day line is found by its sport, a word's start, `workout` and its heart rate", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const whoop = { source: "whoop:1:cloud", kind: "workout", key: "w-run" };
    const watch = { source: "apple-health:person-a@example.com:cloud", kind: "workout", key: "w-ride" };
    day(index, "2026-09-28", [
      atom(1, "workout — running, duration 0:35, distance 5.01 km, average heart rate 152, max heart rate 198, energy 375 kcal, strain 9.5", T0,
        { family: "health", record: whoop }),
      atom(2, "workout — high intensity interval training, duration 0:30, average heart rate 142, max heart rate 171, energy 210 kcal (Apple Watch)", T0 + 2 * HOUR,
        { family: "health", record: watch }),
      atom(3, "steps 4,210, heart rate 61–88 avg 70", T0 + 4 * HOUR, { family: "health" }),
    ]);
    const atoms = (q: string) => find(index, q).hits.map((hit) => (hit.ref as { n: number }).n).sort();
    expect(atoms("running")).toEqual([1]);
    expect(atoms("run")).toEqual([]);
    expect((searchOf(index, { terms: termsOf("run"), typing: true, order: "relevance", limit: 200 }) as { hits: Hit[] }).hits.map((hit) => (hit.ref as { n: number }).n)).toEqual([1]);
    expect(atoms("workout")).toEqual([1, 2]);
    expect(atoms('"max heart rate 198"')).toEqual([1]);
    index.close();
  });

  it("S20 a range by day keeps a line with no clock by its date, a timed one by its instant, in a zone west of UTC", () => {
    const york: DaySettings = { zone: "America/New_York", day_start_hour: 0 };
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, york);
    const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`);
    put(index, [
      record(A, "bank-2", "bank card payment north", midnight("2026-01-02"), { dated: true }),
      record(A, "bank-3", "bank card payment east", midnight("2026-01-03"), { dated: true }),
      record(A, "bank-4", "bank card payment south", midnight("2026-01-04"), { dated: true }),
      record(A, "call-3", "bank call late", Date.parse("2026-01-04T04:30:00Z")),
      record(A, "call-4", "bank call early", Date.parse("2026-01-04T05:30:00Z")),
    ]);
    day(index, "2026-01-03", [atom(1, "bank line of the day", midnight("2026-01-03"), { dated: true }), atom(2, "bank line at noon", Date.parse("2026-01-03T17:00:00Z"))]);
    const third = dayBounds("2026-01-03", york);
    const range = { from_ms: third.start_ms, to_ms: third.end_ms };
    const kept = (answer: SearchAnswer) => ("hits" in answer ? refs(answer.hits).sort() : []);
    const want = ["atom {\"day\":\"2026-01-03\",\"n\":1}", "atom {\"day\":\"2026-01-03\",\"n\":2}", "device-a bank-3", "device-a call-3"];
    expect(kept(searchOf(index, query("bank", range)))).toEqual(want);
    expect(kept(searchOf(index, query(undefined, { ...range, families: ["notes"] })))).toEqual(want);
    expect(searchOf(index, query("bank", { ...range, group: "family" }))).toMatchObject({ total: 4 });
    expect(kept(searchOf(index, query("payment", { from_ms: third.start_ms })))).toEqual(["device-a bank-3", "device-a bank-4"]);
    expect(kept(searchOf(index, query("payment", { to_ms: third.end_ms })))).toEqual(["device-a bank-2", "device-a bank-3"]);
    index.close();
  });

  it("S21 an erasure's forget runs under secure_delete ON and leaves FAST, a throw too; it finds nothing after, and its log empties", () => {
    const secure = (index: SearchIndex) => (index as unknown as { db: Database.Database }).db.pragma("secure_delete", { simple: true });
    const ref = { source: A, kind: "note", key: "erased" };
    const written = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    put(written, [record(A, "erased", "zqxerasedtoken at the harbour", T0), record(A, "kept", "a note that stays", T0)]);
    day(written, "2026-09-28", [atom(1, "zqxerasedtoken at the harbour", T0, { record: ref })]);
    written.finish();
    written.close();
    const [index] = SearchIndex.existing(openHomeFolder(dirname(file)), file) as [SearchIndex];
    const db = (index as unknown as { db: Database.Database }).db;
    const inside: unknown[] = [];
    const transaction = db.transaction.bind(db);
    db.transaction = ((work: (...args: never[]) => unknown) => {
      inside.push(db.pragma("secure_delete", { simple: true }));
      return transaction(work);
    }) as typeof db.transaction;
    expect(secure(index)).toBe(2);
    index.forget([ref], ["2026-09-28"]);
    expect({ inside, after: secure(index) }).toEqual({ inside: [1], after: 2 });
    expect(find(index, "zqxerasedtoken", {}, "S21 forgotten").hits).toEqual([]);
    expect(refs(find(index, "stays").hits)).toEqual(["device-a kept"]);
    expect(index.truncateLog(1_000)).toBe(true);
    expect(statSync(`${file}-wal`).size).toBe(0);
    db.transaction = (() => {
      throw new Error("a synthetic failure inside the forget");
    }) as typeof db.transaction;
    expect(() => index.forget([ref], [])).toThrow("a synthetic failure inside the forget");
    expect(secure(index)).toBe(2);
    index.close();
  });

  it("S22 a line that prints no indexed record names the people its facts name: a person filter finds it by any of their handles", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const chat = "whatsapp:local:c";
    put(index, [record(chat, "m1", "keys under the mat", T0, { record: { source: chat, kind: "msg", key: "m1" }, family: "messages", who: ["15550000001@s.whatsapp.net", "+15550000001"] })]);
    const voice = atom(2, "Person A: [voice note, 8 s: \"the spare keys are with the neighbour\"]", T0 + HOUR, { family: "messages", record: { source: chat, kind: "msg", key: "m2" } });
    const other = atom(3, "Person B: [voice note, 3 s: \"keys found\"]", T0 + 2 * HOUR, { family: "messages", record: { source: chat, kind: "msg", key: "m3" } });
    const fact = (key: string, at: number, line: number, handle: string): DayFileFact => ({
      id: `messages:${key}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
      keys: { chat: "whatsapp:111@lid", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle, role: "sender" }],
      from: { units: [`${chat}/c`], record: { source: chat, kind: "msg", key }, alone: true }, lines: [line],
    });
    index.day("2026-09-28", {
      inputs: `inputs-${++seq}`, mtime_us: seq, atoms: [voice, other],
      facts: { window: dayBounds("2026-09-28", SETTINGS), facts: [fact("m2", T0 + HOUR, 2, "jid:111@lid"), fact("m3", T0 + 2 * HOUR, 3, "phone:+15550000002")] },
    });
    const byPerson = (who: string[]) => refs(find(index, "keys", { who }, `S22 ${who.join(" ")}`).hits).sort();
    expect(byPerson(["+15550000001", "111@lid"])).toEqual(["atom {\"day\":\"2026-09-28\",\"n\":2}", ":local:c m1"].sort());
    expect(byPerson(["111@lid"])).toEqual(["atom {\"day\":\"2026-09-28\",\"n\":2}"]);
    expect(byPerson(["+15550000002"])).toEqual(["atom {\"day\":\"2026-09-28\",\"n\":3}"]);
    index.close();
  });

  it("S23 a line that prints no indexed record is written again when only the people of its facts change", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const chat = "whatsapp:local:c";
    const voice = atom(2, "Person A: [voice note, 8 s: \"the spare keys are with the neighbour\"]", T0 + HOUR, { family: "messages", record: { source: chat, kind: "msg", key: "m2" } });
    const fact = (handle: string): DayFileFact => ({
      id: "messages:m2", family: "messages", of: "messages", time_ms: T0 + HOUR, start_ms: T0 + HOUR, end_ms: T0 + HOUR,
      keys: { chat: "whatsapp:111@lid", direction: "received", product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle, role: "sender" }],
      from: { units: [`${chat}/c`], record: { source: chat, kind: "msg", key: "m2" }, alone: true }, lines: [2],
    });
    const byPerson = (who: string[]) => refs(find(index, "keys", { who }, `S23 ${who.join(" ")}`).hits);
    index.day("2026-09-28", { inputs: `inputs-${++seq}`, mtime_us: seq, atoms: [voice], facts: { window: dayBounds("2026-09-28", SETTINGS), facts: [fact("phone:+15550000001")] } });
    expect(byPerson(["+15550000001"])).toEqual(["atom {\"day\":\"2026-09-28\",\"n\":2}"]);
    index.day("2026-09-28", { inputs: `inputs-${++seq}`, mtime_us: seq, atoms: [voice], facts: { window: dayBounds("2026-09-28", SETTINGS), facts: [fact("phone:+15550000002")] } });
    expect(byPerson(["+15550000002"])).toEqual(["atom {\"day\":\"2026-09-28\",\"n\":2}"]);
    expect(byPerson(["+15550000001"])).toEqual([]);
    index.close();
  });

  it("S26 a record read before its words landed takes them when its day prints them, in the same transaction, and nothing is written again where they stand", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    const question = { source: A, kind: "note", key: "q1" };
    const item = "voice:0a1b";
    put(index, [], [question]);
    const words = record(A, "q1", "a synthetic lighthouse note", T0);
    let held: RecordEntry | null = words;
    const asked: string[][] = [];
    const reread = (records: readonly RecordRef[]) => {
      asked.push(records.map((each) => each.key));
      return held === null ? [] : [held];
    };
    const render = (text: string) => index.day("2026-09-28", { inputs: `inputs-${++seq}`, mtime_us: seq, atoms: [atom(1, text, T0, { record: question, item }), atom(2, "a line of its own", T0)] }, reread);
    const row = () => {
      const db = new Database(index.file, { readonly: true });
      try {
        return db.prepare("SELECT id, hash, text FROM records WHERE key = ?").get("q1") ?? null;
      } finally {
        db.close();
      }
    };
    expect(render("the user: [voice note, 2 s: \"a synthetic lighthouse note\"]")).toBe(true);
    expect(asked).toEqual([["q1"]]);
    const found = find(index, "lighthouse", {}, "S26 the words found");
    expect(found.hits.filter((hit) => hit.layer === "records").map((hit) => hit.ref)).toEqual([question]);
    const written = row();
    expect(written).toMatchObject({ text: "a synthetic lighthouse note" });
    expect(render("the user: [voice note, 2 s: \"a synthetic lighthouse note\"]")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(render("the user: [voice note, 2 s: \"a synthetic lighthouse note\"] (edited)")).toBe(true);
    expect(asked).toHaveLength(2);
    expect(row()).toEqual(written);
    held = null;
    render("the user: [voice note, 2 s]");
    expect(row()).toBeNull();
    expect(find(index, "lighthouse").hits).toEqual([]);
    expect(find(index, "voice note").hits.map((hit) => hit.layer)).toEqual(["atoms"]);
    index.close();
  });

  it("S14 every commit of the published file is flushed, and a build's commit the home acts on; no other build commit waits on the disk", () => {
    const before = process.env.LIFESTREAM_TEST_FSYNC;
    process.env.LIFESTREAM_TEST_FSYNC = "1";
    try {
      const building = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
      const built = watchSynchronous(building);
      const seen: Record<string, unknown> = { opened: built.level() };
      building.records([record(A, "k1", "kiwi", T0)], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
      seen.untold = built.said();
      day(building, "2026-09-28", [atom(1, "kiwi on the table", T0, { record: { source: A, kind: "note", key: "k1" } })]);
      seen.day = built.said();
      building.records([record(A, "k2", "plum", T0)], [], { position: { seq: 2, statement: "s-2", reread: 0 } }, true);
      seen.told = [...built.said(), built.level()];
      expect(building.told()).toEqual({ seq: 2, statement: "s-2", reread: 0 });
      seen.position = [...built.said(), built.level()];
      building.finish();
      building.close();
      seen.log_left = existsSync(`${buildingFileOf(file)}-wal`) || existsSync(`${file}-wal`);
      const published = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
      const kept = watchSynchronous(published);
      seen.published = [published.building, kept.level()];
      published.records([record(A, "k3", "pear", T0)], [], { position: { seq: 3, statement: "s-3", reread: 0 } });
      day(published, "2026-09-29", [atom(1, "pear on the table", T0 + DAY, { record: { source: A, kind: "note", key: "k3" } })]);
      seen.kept = [...kept.said(), kept.level()];
      published.close();
      const marking = SearchIndex.marking(openHomeFolder(dirname(file)), file)!;
      seen.marking = watchSynchronous(marking).level();
      marking.close();
      const [erasing] = SearchIndex.existing(openHomeFolder(dirname(file)), file);
      const erased = watchSynchronous(erasing!);
      erasing!.forget([{ source: A, kind: "note", key: "k1" }], []);
      seen.forget = [...erased.said(), erased.level()];
      expect(() => erasing!.forget([null as unknown as RecordRef], [])).toThrow();
      seen.thrown = [...erased.said(), erased.level()];
      erasing!.close();
      answers.S14 = seen;
    } finally {
      if (before === undefined) delete process.env.LIFESTREAM_TEST_FSYNC;
      else process.env.LIFESTREAM_TEST_FSYNC = before;
    }
    expect(answers.S14).toEqual({
      opened: 1, untold: [], day: [], told: ["FULL", "NORMAL", 1], position: ["FULL", "NORMAL", 1], log_left: false,
      published: [false, 2], kept: [2], marking: 2, forget: [2], thrown: [2],
    });
  });

  it("S25 a told commit that changes nothing else still writes, under FULL: an erasure's forget of what an untold slice dropped", () => {
    const before = process.env.LIFESTREAM_TEST_FSYNC;
    process.env.LIFESTREAM_TEST_FSYNC = "1";
    const k1 = { source: A, kind: "note", key: "k1" };
    try {
      const building = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
      const path = building.file;
      building.records([record(A, "k1", "kiwi", T0)], [], { position: { seq: 1, statement: "s-1", reread: 0 } }, true);
      const reader = new Database(path, { readonly: true });
      reader.exec("BEGIN");
      reader.prepare("SELECT count(*) FROM records").get();
      try {
        building.records([], [k1], { position: { seq: 2, statement: "s-2", reread: 0 } });
        building.close();
        const [erasing] = SearchIndex.existing(openHomeFolder(dirname(file)), file);
        expect(erasing!.building).toBe(true);
        const watched = watchSynchronous(erasing!);
        const at = () => ({ log: statSync(`${path}-wal`).size, told: metaOf(path, "told"), revision: erasing!.revision() });
        const was = at();
        erasing!.forget([k1], []);
        const now = at();
        answers.S25 = { said: watched.said(), level: watched.level(), wrote: now.log > was.log, told: [was.told, now.told], revision: now.revision === was.revision };
        erasing!.close();
      } finally {
        reader.exec("COMMIT");
        reader.close();
      }
    } finally {
      if (before === undefined) delete process.env.LIFESTREAM_TEST_FSYNC;
      else process.env.LIFESTREAM_TEST_FSYNC = before;
    }
    expect(answers.S25).toEqual({ said: ["FULL", "NORMAL"], level: 1, wrote: true, told: ["1", "2"], revision: true });
  });

  it("S24 a place's mentions are one walk of the word index a phrase, each step a lookup of its entry and its record; a member asked after its read throws", () => {
    const index = SearchIndex.write(openHomeFolder(dirname(file)), file, ALL, 0, SETTINGS);
    try {
      put(index, [record(A, "m1", "dinner at the harbour cafe", T0), record(A, "m2", "the harbour cafe again", T0 + HOUR), record(A, "m3", "nothing said here", T0 + 2 * HOUR)]);
      const out = { families: [], products: [], kinds: [], words: [] };
      let ended: RecordRead | undefined;
      const found = index.snapshot({}, (read) => {
        ended = read;
        return read.mentions(["harbour cafe"], { from_ms: T0 - DAY, to_ms: T0 + DAY }, out);
      });
      expect(found.map((each) => each.record.key)).toEqual(["m1", "m2"]);
      expect(() => ended!.mentions(["harbour cafe"], { from_ms: T0 - DAY, to_ms: T0 + DAY }, out)).toThrow(/read/u);

      const other = join(dir, "attached.db");
      const attachedDb = new Database(other);
      attachedDb.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('id', 'attached-1')");
      attachedDb.close();
      type Kept = { facts: FactsRead; attached: AttachedRead };
      const kept = index.snapshot({ places: { kind: PREPARED_STORE, file: other } }, (read): Kept => {
        const attached = read.attached("places")!;
        expect(attached.meta("id")).toBe("attached-1");
        const facts = read.facts((each) => each);
        expect(() => facts.walk("SELECT slot FROM entries WHERE slot >= ? ORDER BY slot LIMIT ?", [0], 1)).not.toThrow();
        return { facts, attached };
      });
      const late = (kept: Kept): (() => unknown)[] => [
        () => kept.facts.meta("revision"),
        () => kept.facts.walk("SELECT slot FROM entries WHERE slot >= ? ORDER BY slot LIMIT ?", [0], 1),
        () => kept.facts.point("SELECT slot FROM entries WHERE slot = ?", [1]),
        () => kept.facts.people("notes"),
        () => kept.facts.values("notes", "chat", "x"),
        () => kept.attached.meta("id"),
      ];
      put(index, [record(A, "m4", "the harbour cafe once more", T0 + 3 * HOUR)]);
      for (const each of late(kept)) expect(each).toThrow(/outside its read/u);
      index.snapshot({ places: { kind: PREPARED_STORE, file: other } }, () => {
        for (const each of late(kept)) expect(each).toThrow(/outside its read/u);
      });
    } finally {
      index.close();
    }
  });
});
