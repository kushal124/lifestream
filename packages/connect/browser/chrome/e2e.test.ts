import { artifact, collect, deliver, macBundle, openTestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { fingerprint } from "../../shared/fingerprint.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CHROME_FILE, chromeHistory, DOWNLOAD, PAGE_VISIT, SEARCH } from "./reader.js";
import { appendHistory, baseHistory, CHROME_SOURCE, createHistory, sealDelta, SECOND, SNAPSHOT, T0 } from "./test/fixture.js";

const at = (text: string): number => Date.parse(text);
const visit = (id: number, time = baseHistory().visits.find((stated) => stated.id === id)!.at): string => `${id}:${time}`;
const search = (term: string, url: string): string => fingerprint({ keyword_id: 7, term, url });
const ONE = search("synthetic one", "https://search.example.com/?q=synthetic+one");
const TWO = search("synthetic two", "https://search.example.com/?q=synthetic+two");
const byKindKey = (left: unknown[], right: unknown[]): number => `${String(left[0])} ${String(left[1])}` < `${String(right[0])} ${String(right[1])}` ? -1 : 1;

function store(dir: string, name = "history.sqlite", history = baseHistory()): string {
  const path = join(dir, name);
  createHistory(path, history);
  return path;
}

describe("Chrome history: each of these is impossible", () => {
  it("a synthetic snapshot lands other heads than expected, or a time loses a digit", async () => {
    const home = openTestHome();
    try {
      const landed = await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 9, refused: 0, duplicated: 0 });
      const heads = home.heads(CHROME_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms, head.end_ms])).toEqual([
        [DOWNLOAD, "SYNTH-0000-0000-0000-DOWNLOAD0001", at("2026-09-20T08:00:30Z"), at("2026-09-20T08:00:31Z")],
        [DOWNLOAD, "SYNTH-0000-0000-0000-DOWNLOAD0002", at("2026-09-20T08:05:00Z"), null],
        [PAGE_VISIT, visit(1), at("2026-09-20T08:00:00Z"), at("2026-09-20T08:00:02.500Z")],
        [PAGE_VISIT, visit(2), at("2026-09-20T08:01:00Z"), null],
        [PAGE_VISIT, visit(3), at("2026-09-20T08:02:00Z"), null],
        [PAGE_VISIT, visit(4), at("2026-09-20T08:03:00Z"), null],
        [PAGE_VISIT, visit(5), at("2026-09-20T08:04:00Z"), null],
        [SEARCH, ONE, at("2026-09-20T08:04:00Z"), null],
        [SEARCH, TWO, at("2026-09-20T08:02:00Z"), null],
      ].sort(byKindKey));
      expect(visit(1)).toBe(`1:${T0 + 123n}`);
      const first = heads.find((head) => head.kind === PAGE_VISIT && head.key === visit(1))!;
      const content = first.content as { visit: Record<string, unknown>; url: Record<string, unknown>; context_annotations: Record<string, unknown>; content_annotations: unknown; visit_source: unknown };
      expect(content.visit.visit_time).toBe((T0 + 123n).toString());
      expect(content.visit.visit_duration).toBe(2_500_000);
      expect(content.url).toEqual({ id: 1, url: "https://example.com/a", title: "Page A", hidden: 0 });
      expect(content.context_annotations).toMatchObject({ visit_id: 1, tab_id: 11, total_foreground_duration: 2_500_000 });
      expect(content.visit_source).toEqual({ id: 1, source: 0 });
      expect(content.content_annotations).toMatchObject({ visit_id: 1, page_language: "en" });
      expect(first.time).toEqual({ start_ms: at("2026-09-20T08:00:00Z"), end_ms: at("2026-09-20T08:00:02.500Z"), precision: "ms" });
      const search = heads.find((head) => head.kind === SEARCH && head.key === ONE)!.content as { term: unknown; url: Record<string, unknown> };
      expect(search.term).toEqual({ keyword_id: 7, url_id: 2, term: "synthetic one", normalized_term: "synthetic one" });
      expect(search.url).toMatchObject({ id: 2, visit_count: 2 });
      const download = heads.find((head) => head.key === "SYNTH-0000-0000-0000-DOWNLOAD0001")!.content as { url_chain: { url: string }[]; download: Record<string, unknown> };
      expect(download.url_chain.map((link) => link.url)).toEqual(["https://example.com/redirect", "https://example.com/synthetic.pdf"]);
      expect(download.download.hash).toEqual({ $bytes64: "" });
      expect(heads.every((head) => head.version !== "gone")).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the same snapshot again writes a new version", async () => {
    const home = openTestHome();
    try {
      const bytes = readFileSync(store(home.dir));
      await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: bytes }, SNAPSHOT));
      const again = await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: bytes }, { ...SNAPSHOT, snapshot_taken_at: "2026-09-22T04:00:00.000Z" }));
      expect(again).toMatchObject({ new: 0, restated: 9, changed: 0, gone: 0, refused: 0 });
      artifact(home.dir, "again.json", again);
    } finally {
      home.close();
    }
  });

  it("a later snapshot leaves a changed item's head behind, moves a visit for its URL's counters, or lands a gone for an expired visit", async () => {
    const home = openTestHome();
    try {
      await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT));
      const before = home.heads(CHROME_SOURCE);
      const later = baseHistory();
      later.visits = later.visits.filter((visit) => visit.id !== 1 && visit.id !== 3).concat([{ id: 6, url: 2, at: T0 + 86_400n * SECOND }]);
      later.urls = later.urls.filter((url) => url.id !== 1 && url.id !== 4).map((url) => (url.id === 2 ? { ...url, visitCount: 3, lastVisit: T0 + 86_400n * SECOND } : url));
      later.searches = later.searches.filter((search) => search.url !== 4);
      later.downloads = later.downloads.map((download) => (download.id === 2 ? { ...download, state: 1, received: 1024, end: T0 + 400n * SECOND } : download));
      const path = store(home.dir, "later.sqlite", later);
      const landed = await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(path) }, { snapshot_taken_at: "2026-09-22T04:00:00.000Z", kind: "snapshot", through: 6 }));
      expect(landed).toMatchObject({ new: 1, changed: 2, restated: 4, gone: 0, refused: 0 });
      const after = home.heads(CHROME_SOURCE);
      const version = (heads: typeof after, kind: string, key: string) => heads.find((head) => head.kind === kind && head.key === key)!.version;
      expect(version(after, PAGE_VISIT, visit(2))).toBe(version(before, PAGE_VISIT, visit(2)));
      expect(version(after, PAGE_VISIT, visit(5))).toBe(version(before, PAGE_VISIT, visit(5)));
      expect(version(after, SEARCH, ONE)).not.toBe(version(before, SEARCH, ONE));
      expect(version(after, DOWNLOAD, "SYNTH-0000-0000-0000-DOWNLOAD0002")).not.toBe(version(before, DOWNLOAD, "SYNTH-0000-0000-0000-DOWNLOAD0002"));
      expect(after.find((head) => head.key === "SYNTH-0000-0000-0000-DOWNLOAD0002")!.end_ms).toBe(at("2026-09-20T08:06:40Z"));
      for (const [kind, key] of [[PAGE_VISIT, visit(1)], [PAGE_VISIT, visit(3)], [SEARCH, TWO]] as const) {
        expect(after.find((head) => head.kind === kind && head.key === key)!.gone).toBe(false);
      }
      artifact(home.dir, "heads.json", { landed, after });
    } finally {
      home.close();
    }
  });

  it("a visit after a clear of all history takes the key of the old visit its id once named", async () => {
    const home = openTestHome();
    try {
      await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT));
      const before = home.heads(CHROME_SOURCE, [PAGE_VISIT]);
      const cleared = baseHistory();
      const day = 2n * 86_400n * SECOND;
      cleared.visits = [{ id: 1, url: 1, at: T0 + day }, { id: 2, url: 2, at: T0 + day + 60n * SECOND }];
      cleared.urls = cleared.urls.filter((url) => url.id <= 2).map((url) => (url.id === 2 ? { ...url, id: 9 } : url));
      cleared.visits[1]!.url = 9;
      cleared.searches = [{ keyword: 7, url: 9, term: "synthetic one" }];
      cleared.annotated = [];
      const path = store(home.dir, "cleared.sqlite", cleared);
      const landed = await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(path) }, { snapshot_taken_at: "2026-09-23T04:00:00.000Z", kind: "snapshot", through: 2 }));
      expect(landed).toMatchObject({ new: 2, gone: 0, refused: 0 });
      const after = home.heads(CHROME_SOURCE, [PAGE_VISIT]);
      expect(after.map((head) => head.key)).toEqual([...before.map((head) => head.key), visit(1, T0 + day), visit(2, T0 + day + 60n * SECOND)].sort());
      for (const head of before) expect(after.find((now) => now.key === head.key)).toMatchObject({ version: head.version, gone: false });
      expect(home.heads(CHROME_SOURCE, [SEARCH]).map((head) => head.key).sort()).toEqual([ONE, TWO].sort());
      artifact(home.dir, "cleared.json", { landed, after });
    } finally {
      home.close();
    }
  });

  it("an older Mac's delta states a visit at or below its cursor, or misses the search of a new URL", async () => {
    const home = openTestHome();
    try {
      const live = store(home.dir);
      await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(live) }, SNAPSHOT));
      const before = home.heads(CHROME_SOURCE);
      appendHistory(live, {
        urls: [{ id: 5, url: "https://search.example.com/?q=synthetic+three", title: "synthetic three - Search", lastVisit: T0 + 600n * SECOND }],
        visits: [{ id: 6, url: 5, at: T0 + 600n * SECOND }, { id: 7, url: 3, at: T0 + 660n * SECOND, duration: 30n * SECOND }],
        searches: [{ keyword: 7, url: 5, term: "synthetic three" }],
        downloads: [],
      });
      const delta = join(home.dir, "delta.sqlite");
      sealDelta(live, delta, 5);
      const landed = await home.land(chromeHistory, deliver(home, CHROME_SOURCE, { [CHROME_FILE]: readFileSync(delta) }, { snapshot_taken_at: "2026-09-21T04:05:00.000Z", kind: "delta", after: 5, through: 7 }));
      expect(landed).toMatchObject({ new: 3, restated: 2, changed: 0, gone: 0, refused: 0 });
      const after = home.heads(CHROME_SOURCE);
      expect(after.filter((head) => !before.some((old) => old.kind === head.kind && old.key === head.key)).map((head) => [head.kind, head.key])).toEqual([
        [PAGE_VISIT, visit(6, T0 + 600n * SECOND)], [PAGE_VISIT, visit(7, T0 + 660n * SECOND)],
        [SEARCH, search("synthetic three", "https://search.example.com/?q=synthetic+three")],
      ].sort(byKindKey));
      for (const head of before) expect(after.find((now) => now.kind === head.kind && now.key === head.key)!.version).toBe(head.version);
      artifact(home.dir, "delta.json", { landed, after });
    } finally {
      home.close();
    }
  });

  it("a file that is not Chrome's history is read", async () => {
    const home = openTestHome();
    try {
      const read = (files: Record<string, Buffer>) => collect(chromeHistory.read(deliver(home, CHROME_SOURCE, files, SNAPSHOT), home.blobs));
      await expect(read({ [CHROME_FILE]: Buffer.from("not a database at all, synthetic bytes") })).rejects.toThrow(/does not open as a SQLite database/u);
      expect(await read({ "other.sqlite": readFileSync(store(home.dir)) })).toEqual([]);
      const drifted = store(home.dir, "drifted.sqlite");
      const db = new Database(drifted);
      db.exec("DROP TABLE downloads_url_chains");
      db.close();
      await expect(read({ [CHROME_FILE]: readFileSync(drifted) })).rejects.toThrow(Refused);
      await expect(read({ [CHROME_FILE]: readFileSync(drifted) })).rejects.toThrow(/no downloads_url_chains table/u);
      const added = store(home.dir, "added.sqlite");
      const grown = new Database(added);
      grown.exec("ALTER TABLE visits ADD COLUMN synthetic_new_column INTEGER DEFAULT 4");
      grown.close();
      const rows = await read({ [CHROME_FILE]: readFileSync(added) });
      expect(rows.filter((row) => row.kind === PAGE_VISIT).every((row) => (row.content as { visit: Record<string, unknown> }).visit.synthetic_new_column === 4)).toBe(true);
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, CHROME_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const file = join(home.dir, "changes.sqlite");
      writeFileSync(file, home.blobs.bytes(changes.files.find((each) => each.path === CHROME_FILE)!.blob));
      const db = new Database(file, { readonly: true });
      const held = (table: string): number => Number((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
      const expected = { [PAGE_VISIT]: held("visits"), [SEARCH]: held("keyword_search_terms"), [DOWNLOAD]: held("downloads") };
      db.close();
      const rows = await collect(chromeHistory.read(changes, home.blobs));
      const stated = Object.fromEntries(Object.keys(expected).map((kind) => [kind, rows.filter((row) => row.kind === kind).length]));
      expect(stated).toEqual(expected);
      expect(await home.land(chromeHistory, changes, rows)).toMatchObject({ refused: 0 });
      artifact(home.dir, "changes.json", stated);
    } finally {
      home.close();
    }
  });
});
