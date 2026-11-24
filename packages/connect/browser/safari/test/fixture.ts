import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";
import { HISTORY_FILE, TABS_FILE } from "../reader.js";

export const SAFARI_UNIT = "macbook-pro-0001";
export const SAFARI_SOURCE = `safari:person-a@example.com:${SAFARI_UNIT}`;
export const T0 = 811_584_000;
export const BEGINNING = -63_114_076_800;

const HISTORY_SCHEMA = [
  "CREATE TABLE history_items (id INTEGER PRIMARY KEY AUTOINCREMENT,url TEXT NOT NULL UNIQUE,domain_expansion TEXT NULL,visit_count INTEGER NOT NULL,daily_visit_counts BLOB NOT NULL,weekly_visit_counts BLOB NULL,autocomplete_triggers BLOB NULL,should_recompute_derived_visit_counts INTEGER NOT NULL,visit_count_score INTEGER NOT NULL,status_code INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE history_visits (id INTEGER PRIMARY KEY AUTOINCREMENT,history_item INTEGER NOT NULL REFERENCES history_items(id) ON DELETE CASCADE,visit_time REAL NOT NULL,title TEXT NULL,load_successful BOOLEAN NOT NULL DEFAULT 1,http_non_get BOOLEAN NOT NULL DEFAULT 0,synthesized BOOLEAN NOT NULL DEFAULT 0,redirect_source INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,redirect_destination INTEGER NULL UNIQUE REFERENCES history_visits(id) ON DELETE CASCADE,origin INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,attributes INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE history_tombstones (id INTEGER PRIMARY KEY AUTOINCREMENT,start_time REAL NOT NULL,end_time REAL NOT NULL,url TEXT,generation INTEGER NOT NULL DEFAULT 0, udid TEXT, attributes INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value)",
  "CREATE TABLE history_tags (id INTEGER PRIMARY KEY,type INTEGER NOT NULL,level INTEGER NOT NULL,identifier TEXT NOT NULL,title TEXT NOT NULL,modification_timestamp REAL NOT NULL,item_count INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE history_items_to_tags (history_item INTEGER NOT NULL,tag_id INTEGER NOT NULL,timestamp REAL NOT NULL,FOREIGN KEY(tag_id) REFERENCES history_tags(id) ON DELETE CASCADE,FOREIGN KEY(history_item) REFERENCES history_items(id) ON DELETE CASCADE,UNIQUE(history_item, tag_id) ON CONFLICT REPLACE)",
  "CREATE INDEX history_visits__last_visit ON history_visits (history_item, visit_time DESC, synthesized ASC)",
  "CREATE INDEX history_tombstones__end_time ON history_tombstones (end_time)",
];

const TABS_SCHEMA = [
  "CREATE TABLE cloud_tab_devices (device_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_name TEXT,device_type_identifier TEXT,has_duplicate_device_name BOOLEAN DEFAULT 0,is_ephemeral_device BOOLEAN DEFAULT 0,last_modified REAL NOT NULL)",
  "CREATE TABLE cloud_tabs (tab_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,device_uuid TEXT NOT NULL,position BLOB NOT NULL,title TEXT,url TEXT NOT NULL,is_showing_reader BOOLEAN DEFAULT 0,is_pinned BOOLEAN DEFAULT 0,reader_scroll_position_page_index INTEGER,scene_id TEXT,last_viewed_time REAL DEFAULT 0,FOREIGN KEY(device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE)",
  "CREATE TABLE cloud_tab_close_requests (close_request_uuid TEXT PRIMARY KEY NOT NULL,system_fields BLOB NOT NULL,destination_device_uuid TEXT NOT NULL,url TEXT NOT NULL,tab_uuid TEXT NOT NULL,FOREIGN KEY(destination_device_uuid) REFERENCES cloud_tab_devices(device_uuid) ON DELETE CASCADE)",
  "CREATE TABLE metadata (key TEXT NOT NULL UNIQUE, value)",
  "CREATE INDEX cloud_tabs__device_uuid ON cloud_tabs (device_uuid)",
];

export interface Item {
  id: number;
  url: string;
  visitCount?: number;
}

export interface Visit {
  id: number;
  item: number;
  at: number;
  title?: string | null;
  origin?: number;
}

export interface Tombstone {
  id: number;
  start: number;
  end: number;
  url: string | Buffer | null;
}

export interface History {
  items: Item[];
  visits: Visit[];
  tombstones?: Tombstone[];
}

export function baseHistory(): History {
  return {
    items: [
      { id: 1, url: "https://example.com/a", visitCount: 2 },
      { id: 2, url: "https://example.com/b" },
      { id: 3, url: "https://example.org/c" },
    ],
    visits: [
      { id: 1, item: 1, at: T0 + 0.25, title: "Page A" },
      { id: 2, item: 2, at: T0 + 60.5, title: "Page B", origin: 1 },
      { id: 3, item: 1, at: T0 + 120, title: "Page A", origin: 1 },
      { id: 4, item: 3, at: T0 + 180.125, title: null },
    ],
  };
}

export function createHistory(path: string, history: History): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of HISTORY_SCHEMA) db.exec(statement);
    db.exec("INSERT INTO metadata VALUES ('current_generation', 2)");
    db.exec(`INSERT INTO history_tags VALUES (1, 0, 0, 'synthetic-topic', 'Synthetic', ${T0}.0, 0)`);
  } finally {
    db.close();
  }
  appendHistory(path, history);
}

export function appendHistory(path: string, history: History): void {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = OFF");
    db.exec("BEGIN");
    const item = db.prepare("INSERT OR REPLACE INTO history_items VALUES (?, ?, ?, ?, X'00', NULL, NULL, 0, ?, 200)");
    for (const i of history.items) item.run(i.id, i.url, "example", i.visitCount ?? 1, 10 * (i.visitCount ?? 1));
    const visit = db.prepare("INSERT INTO history_visits VALUES (?, ?, ?, ?, 1, 0, 0, NULL, NULL, ?, 1, 0, 10)");
    for (const v of history.visits) visit.run(v.id, v.item, v.at, v.title === undefined ? "Synthetic" : v.title, v.origin ?? 0);
    const tombstone = db.prepare("INSERT INTO history_tombstones VALUES (?, ?, ?, ?, 2, 'SYNTH-DEVICE-0001', 0)");
    for (const t of history.tombstones ?? []) tombstone.run(t.id, t.start, t.end, t.url);
    if (history.items.some((i) => i.id === 1)) db.exec(`INSERT OR REPLACE INTO history_items_to_tags VALUES (1, 1, ${T0}.0)`);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export interface Tab {
  uuid: string;
  title: string;
  url: string;
  viewed: number;
  pinned?: number;
}

export function createTabs(path: string, tabs: Tab[] = baseTabs(), closeFirst = true): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of TABS_SCHEMA) db.exec(statement);
    db.prepare("INSERT INTO cloud_tab_devices VALUES ('SYNTH-DEVICE-0001', X'01', 'Synthetic Phone', 'com.example.phone', 0, 0, ?)").run(T0);
    const tab = db.prepare("INSERT INTO cloud_tabs VALUES (?, X'02', 'SYNTH-DEVICE-0001', X'03', ?, ?, 0, ?, NULL, 'scene-1', ?)");
    for (const t of tabs) tab.run(t.uuid, t.title, t.url, t.pinned ?? 0, t.viewed);
    if (closeFirst && tabs.length > 0) {
      db.prepare("INSERT INTO cloud_tab_close_requests VALUES ('SYNTH-CLOSE-0001', X'04', 'SYNTH-DEVICE-0001', ?, ?)").run(tabs[0]!.url, tabs[0]!.uuid);
    }
  } finally {
    db.close();
  }
}

export function baseTabs(): Tab[] {
  return [
    { uuid: "SYNTH-TAB-0001", title: "Tab One", url: "https://example.com/one", viewed: T0 + 100 },
    { uuid: "SYNTH-TAB-0002", title: "Tab Two", url: "https://example.com/two", viewed: 0, pinned: 1 },
  ];
}

export function sealDelta(source: string, path: string, after: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const delta = new Database(path);
  delta.pragma("foreign_keys = OFF");
  delta.exec(`
    DROP TRIGGER IF EXISTS increment_count_on_insert;
    DELETE FROM history_visits WHERE NOT (id > ${after});
    DELETE FROM history_items WHERE NOT EXISTS (SELECT 1 FROM history_visits AS kept WHERE kept.history_item = history_items.id);
    DELETE FROM history_items_to_tags WHERE NOT EXISTS (SELECT 1 FROM history_items AS kept WHERE kept.id = history_items_to_tags.history_item);
    DELETE FROM history_tombstones;
    VACUUM;
  `);
  delta.close();
}

export const fixture: Fixture = (folder) => {
  createHistory(join(folder, HISTORY_FILE), baseHistory());
  createTabs(join(folder, TABS_FILE));
  return {
    source: SAFARI_SOURCE, facts: { snapshot_taken_at: "2026-09-21T04:00:00.000Z", kind: "snapshot", through: 4 },
    files: { [HISTORY_FILE]: { alone: baseHistory().visits.map((visit) => `page-visit ${visit.id}:${visit.at}`) }, [TABS_FILE]: { alone: baseTabs().map((tab) => `tab ${tab.uuid}`) } },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "safari-history": fixture,
};
