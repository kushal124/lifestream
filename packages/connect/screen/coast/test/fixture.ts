import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";
import type { Files, ItemOf, Scenario } from "../../../sdk.js";
import type { CoastShape } from "../shape.js";

export const COAST_UNIT = "macbook-pro-0001";
export const COAST_SOURCE = `coast:local:${COAST_UNIT}`;
export const BASE = 1_790_000_000_000;

const COMMON = [
  `CREATE TABLE application (id INTEGER PRIMARY KEY AUTOINCREMENT, bundle_id TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', icon_path TEXT,
     display_name TEXT, is_user_app INTEGER, dominant_color INTEGER, UNIQUE(bundle_id, version))`,
  `CREATE TABLE domain (id INTEGER PRIMARY KEY AUTOINCREMENT, normalized_domain TEXT NOT NULL UNIQUE, common_name TEXT, icon_path TEXT, dominant_color INTEGER)`,
  `CREATE TABLE video (id INTEGER PRIMARY KEY AUTOINCREMENT, height INTEGER NOT NULL, width INTEGER NOT NULL, path TEXT NOT NULL, num_frames INTEGER NOT NULL,
     status INTEGER NOT NULL DEFAULT 0, size_bytes INTEGER)`,
  `CREATE TABLE segment (id INTEGER PRIMARY KEY AUTOINCREMENT, start_frame_id INTEGER NOT NULL, application INTEGER REFERENCES application(id),
     domain INTEGER REFERENCES domain(id), url TEXT)`,
  "CREATE INDEX idx_segment_start_frame ON segment(start_frame_id)",
  `CREATE TABLE frame (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, video INTEGER REFERENCES video(id), video_index INTEGER,
     image_path TEXT, width INTEGER, height INTEGER, foreground TEXT, background TEXT, title TEXT, tree BLOB, segment INTEGER REFERENCES segment(id),
     is_inactive INTEGER NOT NULL DEFAULT 0, ax_root_hash BLOB, capture_display_x REAL, capture_display_y REAL, capture_display_width REAL,
     capture_display_height REAL, capture_reason TEXT DEFAULT NULL, screen_zoom_factor REAL DEFAULT NULL)`,
  "CREATE INDEX idx_frame_timestamp ON frame(timestamp)",
  "CREATE INDEX idx_frame_segment ON frame(segment)",
  "CREATE INDEX idx_frame_video ON frame(video)",
  `CREATE TABLE window_bound (id INTEGER PRIMARY KEY AUTOINCREMENT, frame INTEGER NOT NULL REFERENCES frame(id), application INTEGER NOT NULL
     REFERENCES application(id), window_title TEXT, x INTEGER NOT NULL, y INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
     window_layer INTEGER NOT NULL DEFAULT 0, z_order INTEGER NOT NULL DEFAULT 0, url TEXT, is_focussed_window INTEGER)`,
  "CREATE INDEX idx_window_bound_frame ON window_bound(frame)",
  "CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)",
  "CREATE TABLE timezone (id INTEGER PRIMARY KEY AUTOINCREMENT, identifier TEXT NOT NULL, observed_at INTEGER NOT NULL)",
];

const HASH_AX = [
  "CREATE TABLE ax_node (hash BLOB PRIMARY KEY, payload BLOB NOT NULL, first_seen_frame_id INTEGER)",
  `CREATE TABLE ax_snapshot (frame_id INTEGER PRIMARY KEY REFERENCES frame(id) ON DELETE CASCADE, root_hash BLOB NOT NULL, timestamp_ms INTEGER NOT NULL,
     application_name TEXT NOT NULL, bundle_id TEXT NOT NULL, process_identifier INTEGER NOT NULL, extraction_mode TEXT NOT NULL DEFAULT 'unknown',
     is_partial_tree INTEGER NOT NULL DEFAULT 0)`,
];

const ID_AX = [
  "CREATE TABLE ax_node (id INTEGER PRIMARY KEY AUTOINCREMENT, payload BLOB NOT NULL, first_seen_frame_id INTEGER)",
  "CREATE INDEX idx_ax_node_first_seen ON ax_node(first_seen_frame_id)",
  "CREATE TABLE ax_node_hash (hash BLOB PRIMARY KEY, node_id INTEGER NOT NULL) WITHOUT ROWID",
  "CREATE TABLE ax_node_child (parent_id INTEGER NOT NULL, position INTEGER NOT NULL, child_id INTEGER NOT NULL, PRIMARY KEY (parent_id, position)) WITHOUT ROWID",
  `CREATE TABLE ax_snapshot (frame_id INTEGER PRIMARY KEY REFERENCES frame(id) ON DELETE CASCADE, root_id INTEGER NOT NULL, timestamp_ms INTEGER NOT NULL,
     application_name TEXT NOT NULL, bundle_id TEXT NOT NULL, process_identifier INTEGER NOT NULL, extraction_mode TEXT NOT NULL DEFAULT 'unknown',
     is_partial_tree INTEGER NOT NULL DEFAULT 0, partial_reason TEXT DEFAULT NULL, truncated_children INTEGER DEFAULT NULL, walk_age_ms INTEGER DEFAULT NULL)`,
];

export function axNode(role: string, options: { title?: string; value?: string; position?: [number, number]; size?: [number, number];
  enabled?: boolean; children?: Buffer[]; attributes?: [string, string][] } = {}): Buffer {
  const text = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(2);
    length.writeUInt16LE(bytes.length);
    return [length, bytes];
  };
  let flags = 0x01;
  const parts: Buffer[] = [...text(role)];
  if (options.title !== undefined) { flags |= 0x02; parts.push(...text(options.title)); }
  if (options.value !== undefined) { flags |= 0x08; parts.push(...text(options.value)); }
  for (const [bit, pair] of [[0x10, options.position], [0x20, options.size]] as const) {
    if (pair === undefined) continue;
    flags |= bit;
    const bytes = Buffer.alloc(8);
    bytes.writeFloatLE(pair[0], 0);
    bytes.writeFloatLE(pair[1], 4);
    parts.push(bytes);
  }
  if (options.enabled !== undefined) { flags |= 0x40; parts.push(Buffer.of(options.enabled ? 1 : 0)); }
  const children = options.children ?? [];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(children.length);
  parts.push(count);
  for (const child of children) parts.push(Buffer.of(32, 0), child);
  const attributes = options.attributes ?? [];
  const attributeCount = Buffer.alloc(2);
  attributeCount.writeUInt16LE(attributes.length);
  parts.push(attributeCount);
  for (const [name, value] of attributes) parts.push(...text(name), ...text(value));
  return Buffer.concat([Buffer.from("AXN2", "ascii"), Buffer.of(2, flags), ...parts]);
}

export const sha = (bytes: Buffer): Buffer => createHash("sha256").update(bytes).digest();

export class FakeCoast {
  readonly db: Database.Database;
  readonly path: string;
  readonly shape: CoastShape;

  constructor(path: string, shape: CoastShape, options: { wal?: boolean } = {}) {
    this.path = path;
    this.shape = shape;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    if (options.wal === true) {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("wal_autocheckpoint = 0");
    }
    for (const statement of [...COMMON, ...(shape === "hash" ? HASH_AX : ID_AX)]) this.db.exec(statement);
    this.db.exec(`
      INSERT INTO application (id, bundle_id, version, display_name) VALUES
        (1, 'com.example.browser', '1.0', 'Example Browser'), (2, 'com.example.editor', '2.3', 'Example Editor'), (3, 'com.example.dock', '', NULL);
      INSERT INTO domain (id, normalized_domain, common_name) VALUES (1, 'example.com', 'Example'), (2, 'example.org', NULL);
    `);
  }

  video(id: number, path: string): void {
    this.db.prepare("INSERT INTO video (id, height, width, path, num_frames) VALUES (?, 800, 1200, ?, 30)").run(id, path);
  }

  segment(id: number, start: number, app: number | null, domain: number | null = null, url: string | null = null): void {
    this.db.prepare("INSERT INTO segment (id, start_frame_id, application, domain, url) VALUES (?, ?, ?, ?, ?)").run(id, start, app, domain, url);
  }

  frame(id: number, timestamp: number, segment: number | null, video: [number, number] | null = [1, id - 1], text = `synthetic frame ${id}`): void {
    this.db.prepare(
      `INSERT INTO frame (id, timestamp, video, video_index, image_path, width, height, foreground, background, title, segment, is_inactive,
         capture_display_x, capture_display_y, capture_display_width, capture_display_height, capture_reason)
       VALUES (?, ?, ?, ?, NULL, 1200, 800, ?, NULL, 'Synthetic Window', ?, 0, 0, 0, 1200.5, 800, 'synthetic-timer')`,
    ).run(id, timestamp, video?.[0] ?? null, video?.[1] ?? null, text, segment);
    this.window(id, 1, "Synthetic Window", `https://example.com/frame-${id}`, [0, 25, 1200, 775], 0);
    this.window(id, 3, null, null, [0, 0, 1200, 25], 25);
  }

  window(frame: number, app: number, title: string | null, url: string | null, rect: [number, number, number, number], layer: number): void {
    this.db.prepare(
      "INSERT INTO window_bound (frame, application, window_title, x, y, width, height, window_layer, z_order, url, is_focussed_window) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 1)",
    ).run(frame, app, title, ...rect, layer, url);
  }

  node(payload: Buffer, firstSeen: number): { hash: Buffer; id?: number } {
    const hash = sha(payload);
    if (this.shape === "hash") {
      this.db.prepare("INSERT OR IGNORE INTO ax_node (hash, payload, first_seen_frame_id) VALUES (?, ?, ?)").run(hash, payload, firstSeen);
      return { hash };
    }
    const known = this.db.prepare("SELECT node_id FROM ax_node_hash WHERE hash = ?").get(hash) as { node_id: number } | undefined;
    if (known !== undefined) return { hash, id: known.node_id };
    const id = Number(this.db.prepare("INSERT INTO ax_node (payload, first_seen_frame_id) VALUES (?, ?)").run(payload, firstSeen).lastInsertRowid);
    this.db.prepare("INSERT INTO ax_node_hash (hash, node_id) VALUES (?, ?)").run(hash, id);
    return { hash, id };
  }

  snapshot(frame: number, root: Buffer, timestamp: number): void {
    const { hash, id } = this.node(root, frame);
    this.db.prepare(
      `INSERT INTO ax_snapshot (frame_id, ${this.shape === "hash" ? "root_hash" : "root_id"}, timestamp_ms, application_name, bundle_id,
         process_identifier, extraction_mode, is_partial_tree) VALUES (?, ?, ?, 'Example Browser', 'com.example.browser', 4242, 'synthetic-complete', 0)`,
    ).run(frame, this.shape === "hash" ? hash : id, timestamp);
  }

  tree(frame: number, timestamp: number, options: { nan?: boolean; missing?: boolean } = {}): void {
    const shared = axNode("AXStaticText", { value: "SYNTHETIC SHARED TEXT", position: [0.25, 10] });
    const own = axNode("AXButton", { title: `Synthetic button ${frame}`, size: options.nan ? [Number.NaN, 4] : [80, 24.5], enabled: true, attributes: [["AXIdentifier", `button-${frame}`]] });
    this.node(shared, frame);
    const absent = axNode("AXGhost", { title: `never persisted ${frame}` });
    if (options.missing !== true) this.node(own, frame);
    const root = axNode("AXWindow", { title: "Synthetic Window", children: [sha(shared), sha(options.missing === true ? absent : own)] });
    this.snapshot(frame, root, timestamp);
  }

  close(): void {
    this.db.close();
  }
}

export const VIDEOS: Record<string, Buffer> = {
  ["a".repeat(64)]: Buffer.from("synthetic mp4 one"),
  ["b".repeat(64)]: Buffer.from("synthetic mp4 two"),
};

export function parityStore(path: string, shape: CoastShape): FakeCoast {
  const coast = new FakeCoast(path, shape);
  coast.video(1, "a".repeat(64));
  coast.video(2, "b".repeat(64));
  coast.segment(1, 1, 1, 1, "https://example.com/session");
  coast.segment(2, 5, 2, null, null);
  coast.segment(3, 9, 1, 2, "https://example.org/");
  coast.frame(1, BASE, 1);
  coast.frame(2, BASE + 1_000, null);
  coast.frame(3, BASE + 1_000, 1);
  coast.frame(4, BASE + 2_000, null, null);
  coast.frame(5, BASE + 3_000, 2);
  coast.frame(6, BASE + 4_000, 2, [2, 0]);
  coast.frame(7, BASE + 6_000, 1, [2, 1]);
  coast.frame(8, BASE + 7_000, null, [2, 2]);
  coast.frame(9, BASE + 8_000, 3, [2, 3]);
  coast.frame(10, BASE + 9_000, 3, [2, 4]);
  coast.tree(5, BASE + 3_123);
  coast.tree(7, BASE + 6_123, { nan: true });
  coast.tree(3, BASE + 1_123);
  return coast;
}

export const fixture: Fixture = (folder) => {
  parityStore(join(folder, "coast.sqlite"), "id").close();
  return {
    source: COAST_SOURCE, facts: { snapshot_taken_at: "2026-09-21T14:00:00.000Z" }, files: { "coast.sqlite": "trust" },
    heads: [
      "ax 1790000001000:1", "ax 1790000003000", "ax 1790000006000", "frame 1790000000000", "frame 1790000001000",
      "frame 1790000001000:1", "frame 1790000002000", "frame 1790000003000", "frame 1790000004000", "frame 1790000006000",
      "frame 1790000007000", "frame 1790000008000", "frame 1790000009000", "session 1790000000000", "session 1790000003000",
      "session 1790000008000",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "coast": fixture,
};

export const immutable = true;

const FRAME_MS = 1_000;

export const settings = { videos: "/var/empty/coast-videos-synthetic" };

export function files(scenario: Scenario): Files {
  const dir = mkdtempSync(join(tmpdir(), "coast-scenario-"));
  try {
    const coast = new FakeCoast(join(dir, "coast.sqlite"), "id");
    for (let n = 0; n < scenario.items; n++) {
      if (scenario.removed.includes(n)) continue;
      coast.segment(n + 1, n + 1, 1, 1, `https://example.com/page-${n}`);
      coast.frame(n + 1, BASE + n * FRAME_MS, n + 1, null, `synthetic frame ${n}${scenario.edited.includes(n) ? ", edited" : ""}`);
    }
    coast.close();
    return { "coast.sqlite": readFileSync(join(dir, "coast.sqlite")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const item: ItemOf = ({ key }) => {
  const at = /^(\d+)/u.exec(key)?.[1];
  return at === undefined ? null : (Number(at) - BASE) / FRAME_MS;
};
