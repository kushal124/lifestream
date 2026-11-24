import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { feeds, fileSha256, movedEarlier, Refused, rfc3339, type Acquirer, type FetchedFile, type JsonObject, type Lent, type Memory } from "@lifestreamprotocol/connect/sdk";
import { makeUnder } from "@lifestreamprotocol/core";
import Database from "better-sqlite3";
import { axNodes, COAST_FILE, coastShape, decodeAxNode, MissingAxNode, type AxNodes, type CoastShape } from "./shape.js";
import { coast, VIDEO_DIRECTORY, VIDEO_INDEX_FILE } from "./reader.js";

const coastSource = (unit: string): string => `coast:local:${unit}`;

export interface CoastSettings {
  unit: string;
  database: string;
  videos: string;
  settle_ms?: number;
  max_frames?: number;
  work: string;
  clock?: () => number;
}

export interface CoastCursor {
  frame_id?: number;
  frame_ms?: number;
  polled_ms?: number;
  gap?: { after: number; through: number };
}

export const VIDEO = "video";

interface VideoBlob extends JsonObject {
  sha256: string;
  bytes: number;
}

const SETTLE_MS = 120_000;
const MAX_FRAMES = 20_000;
const DROPPED_NAMED = 50;

export function coastAcquirer(settings: CoastSettings): Acquirer {
  const clock = settings.clock ?? Date.now;
  return {
    name: "coast",
    source: coastSource(settings.unit),
    async fetch(state, _secrets, lent) {
      const { work } = settings;
      rmSync(work, { recursive: true, force: true });
      makeUnder(dirname(work), work);
      const scratch = mkdtempSync(join(work, "poll-"));
      try {
        return poll(settings, scratch, (state ?? {}) as CoastCursor, lent, clock());
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

function poll(settings: CoastSettings, scratch: string, held: CoastCursor, lent: Lent, now: number): { files: FetchedFile[]; facts: JsonObject; state: JsonObject; more?: true } {
  const { memory } = lent;
  const floor = lent.start_ms ?? 0;
  const settle = settings.settle_ms ?? SETTLE_MS;
  const cap = settings.max_frames ?? MAX_FRAMES;
  const live = new Database(settings.database, { readonly: true, fileMustExist: true });
  try {
    live.defaultSafeIntegers(true);
    const one = (sql: string, ...params: unknown[]) => live.prepare(sql).get(...params) as Record<string, unknown> | undefined;
    live.exec("BEGIN");
    const shape = coastShape((table) => (live.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((row) => row.name));

    const earlier = movedEarlier(lent);
    const opened = clipped(earlier === null ? held.gap : gapOf(floor, earlier, held.gap, one), floor, one);
    const { gap: _gap, ...walk } = held;
    const cursor: CoastCursor = opened === undefined ? walk : { ...walk, gap: opened };
    const { after, window } = opened === undefined ? start(cursor, floor, one) : { after: BigInt(opened.after), window: "gap" };
    const bound = opened === undefined ? null : BigInt(opened.through);
    const candidates = live.prepare("SELECT id, timestamp FROM frame WHERE id > ? AND id <= coalesce(?, id) ORDER BY id LIMIT ?").all(after, bound, cap + 1) as { id: bigint; timestamp: bigint }[];
    let through = after;
    let last: bigint | undefined;
    let capped = false;
    for (const [index, frame] of candidates.entries()) {
      if (index === cap) {
        capped = true;
        break;
      }
      if (Number(frame.timestamp) > now - settle) break;
      through = frame.id;
      last = frame.timestamp;
    }
    if (through === after) {
      live.exec("COMMIT");
      const readThrough = now - settle;
      const { gap: _ended, ...ended } = cursor;
      return {
        files: [],
        facts: { snapshot_taken_at: rfc3339(now), read_through: rfc3339(readThrough), window, shape, ...feeds(coastSource(settings.unit), coast.name) },
        state: { ...(opened === undefined ? cursorOf(cursor, after, one) : ended), polled_ms: now } as JsonObject,
        ...(opened === undefined ? {} : { more: true as const }),
      };
    }

    live.exec(`
      CREATE TEMP TABLE seed (id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE pick (id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE segs (id INTEGER PRIMARY KEY);
      CREATE TEMP TABLE seen (hash BLOB PRIMARY KEY);
      CREATE TEMP TABLE dropped (frame_id INTEGER PRIMARY KEY);
    `);
    for (;;) {
      const peer = one(
        "SELECT max(id) AS id FROM frame WHERE id > ? AND timestamp IN (SELECT timestamp FROM frame WHERE id > ? AND id <= ?)",
        through, after, through,
      )?.id as bigint | null;
      if (peer === null || peer === undefined) break;
      through = peer;
    }
    live.prepare("INSERT INTO temp.seed SELECT id FROM frame WHERE id > ? AND id <= ?").run(after, through);
    live.exec("INSERT INTO temp.pick SELECT id FROM temp.seed");
    const sessions = live.prepare("INSERT OR IGNORE INTO temp.segs SELECT f.segment FROM temp.pick AS p JOIN frame AS f ON f.id = p.id WHERE f.segment IS NOT NULL");
    const members = live.prepare("INSERT OR IGNORE INTO temp.pick SELECT f.id FROM temp.segs AS s JOIN frame AS f ON f.segment = s.id WHERE f.id <= ?");
    const peers = live.prepare(
      "INSERT OR IGNORE INTO temp.pick SELECT f.id FROM (SELECT DISTINCT g.timestamp FROM temp.pick AS p JOIN frame AS g ON g.id = p.id) AS t JOIN frame AS f ON f.timestamp = t.timestamp WHERE f.id <= ?",
    );
    for (;;) {
      sessions.run();
      if (Number(members.run(through).changes) + Number(peers.run(through).changes) === 0) break;
    }

    const nodes = axNodes(shape, one);
    const ax = reachable(live, nodes);
    const videos = videoFiles(live, settings, memory);
    const file = join(scratch, "window.sqlite");
    copyWindow(live, shape, join(scratch, "scratch.sqlite"), file);
    live.exec("COMMIT");

    const count = (sql: string) => Number(one(sql)!.n);
    const files: FetchedFile[] = [{ path: COAST_FILE, file }, ...videos.files];
    if (Object.keys(videos.listed).length > 0) {
      files.push({ path: VIDEO_INDEX_FILE, bytes: Buffer.from(JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries: videos.listed })) });
    }
    const lastSeed = Number(last ?? one("SELECT timestamp FROM frame WHERE id = ?", through)!.timestamp);
    return {
      files,
      facts: {
        snapshot_taken_at: rfc3339(capped ? lastSeed : now - settle),
        kind: "delta",
        after: Number(after),
        through: Number(through),
        window,
        shape,
        seeds: Number(through - after),
        frames: count("SELECT count(*) AS n FROM temp.pick"),
        sessions: count("SELECT count(*) AS n FROM temp.segs"),
        ...feeds(coastSource(settings.unit), coast.name),
        ax_snapshots: ax.kept,
        ax_dropped: ax.dropped.length,
        ax_dropped_frames: ax.dropped.slice(0, DROPPED_NAMED),
        ax_nodes: count("SELECT count(*) AS n FROM temp.seen"),
        videos_carried: videos.files.length,
        videos_listed: Object.keys(videos.listed).length,
        videos_missing: videos.missing,
      },
      state: (opened === undefined ? { frame_id: Number(through), frame_ms: lastSeed, polled_ms: now } : gapAfter(cursor, opened, through, now)) as JsonObject,
      ...(capped || opened !== undefined ? { more: true as const } : {}),
    };
  } finally {
    if (live.inTransaction) live.exec("ROLLBACK");
    live.close();
  }
}

function gapOf(floor: number, from_ms: number, open: CoastCursor["gap"], one: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined): CoastCursor["gap"] {
  const first = one("SELECT min(id) AS id FROM frame WHERE timestamp >= ?", floor)?.id as bigint | null | undefined;
  if (first === null || first === undefined) return open;
  const reached = (one("SELECT min(id) AS id FROM frame WHERE timestamp >= ?", from_ms)?.id as bigint | null | undefined) ?? (one("SELECT max(id) + 1 AS id FROM frame")!.id as bigint);
  const through = Math.max(Number(reached - 1n), open?.through ?? 0);
  return through > Number(first - 1n) ? { after: Number(first - 1n), through } : open;
}

function clipped(gap: CoastCursor["gap"], floor: number, one: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined): CoastCursor["gap"] {
  if (gap === undefined) return undefined;
  const first = one("SELECT min(id) AS id FROM frame WHERE timestamp >= ?", floor)?.id as bigint | null | undefined;
  const after = first === null || first === undefined ? gap.through : Math.max(gap.after, Number(first - 1n));
  return after >= gap.through ? undefined : { after, through: gap.through };
}

function gapAfter(cursor: CoastCursor, gap: NonNullable<CoastCursor["gap"]>, through: bigint, now: number): CoastCursor {
  const { gap: _walked, ...walk } = cursor;
  return { ...walk, polled_ms: now, ...(Number(through) >= gap.through ? {} : { gap: { after: Number(through), through: gap.through } }) };
}

function start(cursor: CoastCursor, floor: number, one: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined): { after: bigint; window: string } {
  if (cursor.frame_id !== undefined && (cursor.frame_ms ?? floor) >= floor) {
    const held = one("SELECT timestamp FROM frame WHERE id = ?", cursor.frame_id)?.timestamp;
    if (held !== undefined && Number(held) === cursor.frame_ms) return { after: BigInt(cursor.frame_id), window: "id" };
  }
  const since = Math.max(cursor.frame_ms ?? floor, floor);
  const first = one("SELECT min(id) AS id FROM frame WHERE timestamp > ?", since)?.id as bigint | null;
  return { after: first === null || first === undefined ? (one("SELECT coalesce(max(id), 0) AS id FROM frame")!.id as bigint) : first - 1n, window: "time" };
}

function cursorOf(cursor: CoastCursor, after: bigint, one: (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined): CoastCursor {
  if (after === 0n) return { ...cursor };
  const timestamp = one("SELECT timestamp FROM frame WHERE id = ?", after)?.timestamp;
  return timestamp === undefined ? { ...cursor } : { ...cursor, frame_id: Number(after), frame_ms: Number(timestamp) };
}

function reachable(live: Database.Database, nodes: AxNodes): { kept: number; dropped: number[] } {
  const snapshots = live.prepare(`SELECT a.frame_id, a.${nodes.rootColumn} AS root FROM temp.seed AS s JOIN ax_snapshot AS a ON a.frame_id = s.id ORDER BY a.frame_id`).all() as { frame_id: bigint; root: unknown }[];
  const seen = live.prepare("INSERT OR IGNORE INTO temp.seen (hash) VALUES (?)");
  const unsee = live.prepare("DELETE FROM temp.seen WHERE hash = ?");
  const drop = live.prepare("INSERT INTO temp.dropped (frame_id) VALUES (?)");
  const dropped: number[] = [];
  let kept = 0;
  for (const snapshot of snapshots) {
    const reached: Buffer[] = [];
    const walk = (hash: string, ancestors: Set<string>): void => {
      if (ancestors.has(hash)) throw new MissingAxNode(`a cycle at AX node ${hash}`);
      const key = Buffer.from(hash, "hex");
      if (Number(seen.run(key).changes) === 0) return;
      reached.push(key);
      const payload = nodes.payload(hash);
      if (payload === undefined) throw new MissingAxNode(`AX node ${hash}`);
      if (createHash("sha256").update(payload).digest("hex") !== hash) throw new MissingAxNode(`AX node ${hash} whose payload hashes otherwise`);
      ancestors.add(hash);
      for (const child of decodeAxNode(payload, `AX node ${hash}`, () => {}).child_hashes as string[]) walk(child, ancestors);
      ancestors.delete(hash);
    };
    try {
      const root = nodes.rootHash(snapshot.root, `ax_snapshot frame ${snapshot.frame_id}`);
      if (root === undefined) throw new MissingAxNode(`the root of frame ${snapshot.frame_id}`);
      walk(root, new Set());
      kept++;
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      for (const hash of reached) unsee.run(hash);
      drop.run(snapshot.frame_id);
      dropped.push(Number(snapshot.frame_id));
    }
  }
  return { kept, dropped };
}

function videoFiles(live: Database.Database, settings: CoastSettings, memory: Memory) {
  const paths = (live.prepare("SELECT DISTINCT v.path AS path FROM temp.seed AS s JOIN frame AS f ON f.id = s.id JOIN video AS v ON v.id = f.video ORDER BY v.path").all() as { path: unknown }[])
    .map((row) => row.path)
    .filter((path): path is string => typeof path === "string" && /^[0-9a-f]{64}$/u.test(path));
  const files: FetchedFile[] = [];
  const listed: Record<string, VideoBlob> = {};
  const named: Record<string, VideoBlob> = {};
  let missing = 0;
  for (const path of paths) {
    const before = memory.get(VIDEO, path) as VideoBlob | undefined;
    if (before !== undefined) {
      listed[path] = before;
      named[path] = before;
      continue;
    }
    const where = join(settings.videos, path);
    if (!existsSync(where) || !statSync(where).isFile()) {
      missing++;
      continue;
    }
    named[path] = { sha256: fileSha256(where), bytes: statSync(where).size };
    files.push({ path: `${VIDEO_DIRECTORY}${path}`, file: where });
  }
  for (let page = memory.list(VIDEO); page.length > 0; page = memory.list(VIDEO, page.at(-1)![0])) {
    for (const [path] of page) if (named[path] === undefined) memory.drop(VIDEO, path);
  }
  for (const [path, blob] of Object.entries(named)) memory.put(VIDEO, path, blob);
  return { files, listed, missing };
}

function selections(shape: CoastShape): [table: string, sql: string][] {
  const nodes: [string, string][] = shape === "hash"
    ? [["ax_node", "SELECT n.* FROM temp.seen AS r JOIN ax_node AS n ON n.hash = r.hash"]]
    : [
        ["ax_node", "SELECT n.* FROM temp.seen AS r JOIN ax_node_hash AS h ON h.hash = r.hash JOIN ax_node AS n ON n.id = h.node_id"],
        ["ax_node_hash", "SELECT h.* FROM temp.seen AS r JOIN ax_node_hash AS h ON h.hash = r.hash"],
      ];
  return [
    ["application", `SELECT * FROM application WHERE id IN (SELECT s.application FROM temp.segs AS p JOIN segment AS s ON s.id = p.id)
       OR id IN (SELECT w.application FROM temp.seed AS p JOIN window_bound AS w ON w.frame = p.id)`],
    ["domain", "SELECT * FROM domain WHERE id IN (SELECT s.domain FROM temp.segs AS p JOIN segment AS s ON s.id = p.id)"],
    ["video", "SELECT * FROM video WHERE id IN (SELECT f.video FROM temp.pick AS p JOIN frame AS f ON f.id = p.id)"],
    ["segment", "SELECT s.* FROM temp.segs AS p JOIN segment AS s ON s.id = p.id"],
    ["frame", "SELECT f.* FROM temp.pick AS p JOIN frame AS f ON f.id = p.id"],
    ["window_bound", "SELECT w.* FROM temp.seed AS p JOIN window_bound AS w ON w.frame = p.id"],
    ["ax_snapshot", "SELECT a.* FROM temp.seed AS p JOIN ax_snapshot AS a ON a.frame_id = p.id WHERE a.frame_id NOT IN (SELECT frame_id FROM temp.dropped)"],
    ...nodes,
  ];
}

function copyWindow(live: Database.Database, shape: CoastShape, scratchPath: string, file: string): void {
  const out = new Database(scratchPath);
  try {
    out.pragma("journal_mode = OFF");
    out.pragma("synchronous = OFF");
    out.defaultSafeIntegers(true);
    const tables = selections(shape);
    const names = tables.map(([table]) => table);
    const ddl = live.prepare(
      `SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table', 'index') AND tbl_name IN (${names.map(() => "?").join(", ")})
        ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    ).all(...names) as { sql: string }[];
    out.exec("BEGIN");
    for (const { sql } of ddl) out.exec(sql);
    for (const [table, sql] of tables) {
      const select = live.prepare(sql).raw(true);
      const width = select.columns().length;
      const insert = out.prepare(`INSERT INTO "${table}" VALUES (${Array.from({ length: width }, () => "?").join(", ")})`);
      for (const row of select.iterate() as Iterable<unknown[]>) insert.run(...row);
    }
    out.exec("COMMIT");
    out.prepare("VACUUM INTO ?").run(file);
  } finally {
    out.close();
  }
}

