import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";
import { CHROME_FILE } from "../reader.js";

export const CHROME_UNIT = "macbook-pro-0001";
export const CHROME_SOURCE = `chrome:profile-2:${CHROME_UNIT}`;
export const T0 = 13_434_364_800_000_000n;
export const SECOND = 1_000_000n;
export const SNAPSHOT = { snapshot_taken_at: "2026-09-21T04:00:00.000Z", kind: "snapshot", through: 5 };

const SCHEMA = [
  "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)",
  "CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL)",
  "CREATE TABLE visits(id INTEGER PRIMARY KEY AUTOINCREMENT,url INTEGER NOT NULL,visit_time INTEGER NOT NULL,from_visit INTEGER,external_referrer_url TEXT,transition INTEGER DEFAULT 0 NOT NULL,segment_id INTEGER,visit_duration INTEGER DEFAULT 0 NOT NULL,incremented_omnibox_typed_score BOOLEAN DEFAULT FALSE NOT NULL,opener_visit INTEGER,originator_cache_guid TEXT,originator_visit_id INTEGER,originator_from_visit INTEGER,originator_opener_visit INTEGER,is_known_to_sync BOOLEAN DEFAULT FALSE NOT NULL,consider_for_ntp_most_visited BOOLEAN DEFAULT FALSE NOT NULL,visited_link_id INTEGER DEFAULT 0 NOT NULL,app_id TEXT)",
  "CREATE TABLE visit_source(id INTEGER PRIMARY KEY,source INTEGER NOT NULL)",
  "CREATE TABLE keyword_search_terms (keyword_id INTEGER NOT NULL,url_id INTEGER NOT NULL,term LONGVARCHAR NOT NULL,normalized_term LONGVARCHAR NOT NULL)",
  "CREATE TABLE downloads (id INTEGER PRIMARY KEY,guid VARCHAR NOT NULL,current_path LONGVARCHAR NOT NULL,target_path LONGVARCHAR NOT NULL,start_time INTEGER NOT NULL,received_bytes INTEGER NOT NULL,total_bytes INTEGER NOT NULL,state INTEGER NOT NULL,danger_type INTEGER NOT NULL,interrupt_reason INTEGER NOT NULL,hash BLOB NOT NULL,end_time INTEGER NOT NULL,opened INTEGER NOT NULL,last_access_time INTEGER NOT NULL,transient INTEGER NOT NULL,referrer VARCHAR NOT NULL,site_url VARCHAR NOT NULL,embedder_download_data VARCHAR NOT NULL,tab_url VARCHAR NOT NULL,tab_referrer_url VARCHAR NOT NULL,http_method VARCHAR NOT NULL,by_ext_id VARCHAR NOT NULL,by_ext_name VARCHAR NOT NULL,by_web_app_id VARCHAR NOT NULL,etag VARCHAR NOT NULL,last_modified VARCHAR NOT NULL,mime_type VARCHAR(255) NOT NULL,original_mime_type VARCHAR(255) NOT NULL)",
  "CREATE TABLE downloads_url_chains (id INTEGER NOT NULL,chain_index INTEGER NOT NULL,url LONGVARCHAR NOT NULL, PRIMARY KEY (id, chain_index) )",
  "CREATE TABLE downloads_slices (download_id INTEGER NOT NULL,offset INTEGER NOT NULL,received_bytes INTEGER NOT NULL,finished INTEGER NOT NULL DEFAULT 0,PRIMARY KEY (download_id, offset) )",
  "CREATE TABLE segments (id INTEGER PRIMARY KEY,name VARCHAR,url_id INTEGER NON NULL)",
  "CREATE TABLE content_annotations(visit_id INTEGER PRIMARY KEY,visibility_score NUMERIC,floc_protected_score NUMERIC,categories VARCHAR,page_topics_model_version INTEGER,annotation_flags INTEGER NOT NULL,entities VARCHAR,related_searches VARCHAR,search_normalized_url VARCHAR,search_terms LONGVARCHAR,alternative_title VARCHAR,page_language VARCHAR,password_state INTEGER DEFAULT 0 NOT NULL,has_url_keyed_image BOOLEAN NOT NULL)",
  "CREATE TABLE context_annotations(visit_id INTEGER PRIMARY KEY,context_annotation_flags INTEGER NOT NULL,duration_since_last_visit INTEGER,page_end_reason INTEGER,total_foreground_duration INTEGER,browser_type INTEGER DEFAULT 0 NOT NULL,window_id INTEGER DEFAULT -1 NOT NULL,tab_id INTEGER DEFAULT -1 NOT NULL,task_id INTEGER DEFAULT -1 NOT NULL,root_task_id INTEGER DEFAULT -1 NOT NULL,parent_task_id INTEGER DEFAULT -1 NOT NULL,response_code INTEGER DEFAULT 0 NOT NULL)",
  "CREATE TABLE visited_links(id INTEGER PRIMARY KEY AUTOINCREMENT,link_url_id INTEGER NOT NULL,top_level_url LONGVARCHAR NOT NULL,frame_url LONGVARCHAR NOT NULL,visit_count INTEGER DEFAULT 0 NOT NULL)",
  "CREATE INDEX visits_url_index ON visits (url)",
  "CREATE INDEX visits_time_index ON visits (visit_time)",
  "CREATE INDEX keyword_search_terms_index1 ON keyword_search_terms (keyword_id, normalized_term)",
  "CREATE INDEX keyword_search_terms_index2 ON keyword_search_terms (url_id)",
  "CREATE INDEX urls_url_index ON urls (url)",
];

export interface Url {
  id: number;
  url: string;
  title: string;
  visitCount?: number;
  lastVisit: bigint;
}

export interface Visit {
  id: number;
  url: number;
  at: bigint;
  duration?: bigint;
  transition?: number;
  from?: number;
}

export interface Download {
  id: number;
  guid: string;
  start: bigint;
  end: bigint;
  state?: number;
  received?: number;
  chain: string[];
}

export interface History {
  urls: Url[];
  visits: Visit[];
  searches: { keyword: number; url: number; term: string }[];
  downloads: Download[];
  annotated?: number[];
  tabbed?: { visit: number; tab: number; foreground: number }[];
}

export function baseHistory(): History {
  return {
    urls: [
      { id: 1, url: "https://example.com/a", title: "Page A", lastVisit: T0 },
      { id: 2, url: "https://search.example.com/?q=synthetic+one", title: "synthetic one - Search", visitCount: 2, lastVisit: T0 + 240n * SECOND },
      { id: 3, url: "https://example.com/b", title: "Page B", lastVisit: T0 + 180n * SECOND },
      { id: 4, url: "https://search.example.com/?q=synthetic+two", title: "synthetic two - Search", lastVisit: T0 + 120n * SECOND },
    ],
    visits: [
      { id: 1, url: 1, at: T0 + 123n, duration: 2_500_000n },
      { id: 2, url: 2, at: T0 + 60n * SECOND, transition: 805306369 },
      { id: 3, url: 4, at: T0 + 120n * SECOND },
      { id: 4, url: 3, at: T0 + 180n * SECOND, duration: 900n },
      { id: 5, url: 2, at: T0 + 240n * SECOND },
    ],
    searches: [{ keyword: 7, url: 2, term: "synthetic one" }, { keyword: 7, url: 4, term: "synthetic two" }],
    downloads: [
      { id: 1, guid: "SYNTH-0000-0000-0000-DOWNLOAD0001", start: T0 + 30n * SECOND, end: T0 + 31n * SECOND, state: 1, received: 1024, chain: ["https://example.com/redirect", "https://example.com/synthetic.pdf"] },
      { id: 2, guid: "SYNTH-0000-0000-0000-DOWNLOAD0002", start: T0 + 300n * SECOND, end: 0n, state: 0, received: 10, chain: ["https://example.com/large.zip"] },
    ],
    annotated: [1, 5],
  };
}

export function createHistory(path: string, history: History): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of SCHEMA) db.exec(statement);
    db.exec("INSERT INTO meta VALUES ('version', '70'), ('last_compatible_version', '69')");
    db.exec("INSERT INTO segments VALUES (1, 'http://example.com/', 1)");
    db.exec("INSERT INTO visited_links VALUES (1, 1, 'https://example.com/', '', 1)");
  } finally {
    db.close();
  }
  appendHistory(path, history);
}

export function appendHistory(path: string, history: History): void {
  const db = new Database(path);
  try {
    db.defaultSafeIntegers(true);
    db.exec("BEGIN");
    const url = db.prepare("INSERT OR REPLACE INTO urls VALUES (?, ?, ?, ?, 0, ?, 0)");
    for (const u of history.urls) url.run(u.id, u.url, u.title, u.visitCount ?? 1, u.lastVisit);
    const visit = db.prepare("INSERT INTO visits VALUES (?, ?, ?, ?, '', ?, 0, ?, 0, 0, '', 0, 0, 0, 0, 1, 0, NULL)");
    for (const v of history.visits) visit.run(v.id, v.url, v.at, v.from ?? 0, v.transition ?? 805306368, v.duration ?? 0n);
    const search = db.prepare("INSERT INTO keyword_search_terms VALUES (?, ?, ?, ?)");
    for (const s of history.searches) search.run(s.keyword, s.url, s.term, s.term);
    for (const id of history.annotated ?? []) {
      db.prepare("INSERT OR REPLACE INTO context_annotations VALUES (?, 0, 0, 1, 2500000, 1, 9, ?, 0, 0, 0, 200)").run(id, 10 + id);
      db.prepare("INSERT OR REPLACE INTO visit_source VALUES (?, 0)").run(id);
    }
    for (const { visit, tab, foreground } of history.tabbed ?? []) {
      db.prepare("INSERT OR REPLACE INTO context_annotations VALUES (?, 0, 0, 1, ?, 1, 9, ?, 0, 0, 0, 200)").run(visit, foreground, tab);
    }
    if ((history.annotated ?? []).length > 0) {
      db.prepare("INSERT OR REPLACE INTO content_annotations VALUES (?, 0, 0, '', 0, 0, '', '', '', '', '', 'en', 0, 0)").run(history.annotated![0]!);
    }
    const download = db.prepare(`INSERT OR REPLACE INTO downloads VALUES (?, ?, '/tmp/synthetic', '/tmp/synthetic', ?, ?, 1024, ?, 0, 0, X'', ?, 0, 0, 0,
      'https://example.com/a', '', '', 'https://example.com/a', '', 'GET', '', '', '', '', '', 'application/octet-stream', 'application/octet-stream')`);
    const chain = db.prepare("INSERT OR REPLACE INTO downloads_url_chains VALUES (?, ?, ?)");
    const slice = db.prepare("INSERT OR REPLACE INTO downloads_slices VALUES (?, 0, ?, ?)");
    for (const d of history.downloads) {
      download.run(d.id, d.guid, d.start, d.received ?? 1024, d.state ?? 1, d.end);
      d.chain.forEach((link, index) => chain.run(d.id, index, link));
      slice.run(d.id, d.received ?? 1024, d.state === 1 ? 1 : 0);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function sealDelta(source: string, path: string, after: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const delta = new Database(path);
  delta.exec(`
    DELETE FROM visits WHERE NOT (id > ${after});
    DELETE FROM urls WHERE NOT EXISTS (SELECT 1 FROM visits AS kept WHERE kept.url = urls.id);
    DELETE FROM visit_source WHERE NOT EXISTS (SELECT 1 FROM visits AS kept WHERE kept.id = visit_source.id);
    DELETE FROM context_annotations WHERE NOT EXISTS (SELECT 1 FROM visits AS kept WHERE kept.id = context_annotations.visit_id);
    DELETE FROM content_annotations WHERE NOT EXISTS (SELECT 1 FROM visits AS kept WHERE kept.id = content_annotations.visit_id);
    DELETE FROM keyword_search_terms WHERE NOT EXISTS (SELECT 1 FROM urls AS kept WHERE kept.id = keyword_search_terms.url_id);
    DELETE FROM segments; DELETE FROM visited_links;
    VACUUM;
  `);
  delta.close();
}

export const fixture: Fixture = (folder) => {
  createHistory(join(folder, CHROME_FILE), baseHistory());
  return {
    source: CHROME_SOURCE, facts: { snapshot_taken_at: "2026-09-21T04:00:00.000Z", kind: "snapshot", through: 5 }, files: { [CHROME_FILE]: "trust" },
    heads: [
      "download SYNTH-0000-0000-0000-DOWNLOAD0001", "download SYNTH-0000-0000-0000-DOWNLOAD0002",
      "page-visit 1:13434364800000123", "page-visit 2:13434364860000000", "page-visit 3:13434364920000000",
      "page-visit 4:13434364980000000", "page-visit 5:13434365040000000",
      "search sha256:5130a2100a97fe761146d6b686996a2338306743dff5ce6fd4643b2188bf54c5",
      "search sha256:8d0ecf4614a6ba24d0dba73ed2b2d7dd8a8c05222dc87c521ecffc9f23df5ad8",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "chrome-history": fixture,
};
