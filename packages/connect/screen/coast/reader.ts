import { blobIndex, carriesNothing, databaseWindow, each, instant, isObject, openDeliveredSqlite, ordered, refuse, rowJson, span, unitOf, type Guard, type Json, type JsonObject, type Reader, type ReaderOutput, type Sqlite, type SqliteValue } from "@lifestreamprotocol/connect/sdk";
import { axNodes, axTree, COAST_FILE, coastShape } from "./shape.js";

export const COAST_FRAME = "frame";
export const COAST_SESSION = "session";
export const COAST_AX = "ax";
export const VIDEO_INDEX_FILE = "videos.json";
export const VIDEO_DIRECTORY = "videos/";

const HEX = /^[0-9a-f]{64}$/u;
const IDENTITY = /^\d+(?::[1-9]\d*)?$/u;
const CACHE_NODES = 50_000;

const scalar = (value: Json | undefined): boolean => value === null || ["string", "number", "boolean"].includes(typeof value);
const app = (value: Json | undefined): boolean => isObject(value) && exact(value, ["bundle_id", "version", "display_name"]) && Object.values(value).every(scalar);

const frameGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  if (!exact(content, ["type", "frame_id", "timestamp_ms", "width", "height", "is_inactive", "image_path", "foreground", "background", "title", "capture_display", "video", "session_start_frame_identity", "windows"])) {
    problems.push("members must be exactly the frame's");
  }
  if (content.type !== "screen.frame") problems.push("type must be screen.frame");
  if (!positive(content.frame_id) || !positive(content.timestamp_ms)) problems.push("frame_id and timestamp_ms must be positive integers");
  for (const member of ["width", "height", "is_inactive", "image_path", "foreground", "background", "title"]) if (!scalar(content[member])) problems.push(`${member} must be a scalar`);
  const display = content.capture_display;
  if (!isObject(display) || !exact(display, ["x", "y", "width", "height"]) || !Object.values(display).every(scalar)) problems.push("capture_display must state x, y, width, height");
  const video = content.video;
  if (video !== null && !(isObject(video) && exact(video, ["hash", "index"]) && typeof video.hash === "string" && HEX.test(video.hash) && whole(video.index))) {
    problems.push("video must be null or { hash: 64 hex, index }");
  }
  const start = content.session_start_frame_identity;
  if (start !== null && !(typeof start === "string" && IDENTITY.test(start))) problems.push("session_start_frame_identity must be a frame identity or null");
  if (!Array.isArray(content.windows) || !content.windows.every((window) => isObject(window) &&
    exact(window, ["application", "window_title", "url", "x", "y", "width", "height", "window_layer", "z_order"]) && app(window.application) &&
    ["window_title", "url", "x", "y", "width", "height", "window_layer", "z_order"].every((member) => scalar(window[member])))) {
    problems.push("windows must each state its application, title, url and rect");
  }
  return problems;
};

const sessionGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  if (!exact(content, ["type", "start_frame_identity", "application", "frames"], ["domain", "url"])) problems.push("members must be the session's");
  if (content.type !== "screen.session") problems.push("type must be screen.session");
  if (typeof content.start_frame_identity !== "string" || !IDENTITY.test(content.start_frame_identity)) problems.push("start_frame_identity must be a frame identity");
  if (!app(content.application)) problems.push("application must state bundle_id, version, display_name");
  if (content.domain !== undefined && !(isObject(content.domain) && exact(content.domain, ["normalized_domain", "common_name"]) && Object.values(content.domain).every(scalar))) {
    problems.push("domain must state normalized_domain and common_name");
  }
  if (content.url !== undefined && !scalar(content.url)) problems.push("url must be a scalar");
  if (!Array.isArray(content.frames) || !content.frames.every((frame) => typeof frame === "string" && IDENTITY.test(frame))) problems.push("frames must be frame identities");
  return problems;
};

const axGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const problems: string[] = [];
  if (!exact(content, ["type", "frame_identity", "root_hash", "timestamp_ms", "application_name", "bundle_id", "process_identifier", "extraction_mode", "is_partial_tree", "tree"])) {
    problems.push("members must be the AX snapshot's");
  }
  if (content.type !== "screen.ax") problems.push("type must be screen.ax");
  if (typeof content.frame_identity !== "string" || !IDENTITY.test(content.frame_identity)) problems.push("frame_identity must be a frame identity");
  if (typeof content.root_hash !== "string" || !HEX.test(content.root_hash)) problems.push("root_hash must be 64 hex");
  if (!whole(content.timestamp_ms) || !whole(content.process_identifier)) problems.push("timestamp_ms and process_identifier must be whole numbers");
  for (const member of ["application_name", "bundle_id", "extraction_mode"]) if (typeof content[member] !== "string") problems.push(`${member} must be text`);
  if (content.is_partial_tree !== 0 && content.is_partial_tree !== 1) problems.push("is_partial_tree must be 0 or 1");
  if (!isObject(content.tree) || content.tree.hash !== content.root_hash) problems.push("tree must be the decoded tree under root_hash");
  return problems;
};

export const coast: Reader = {
  name: "coast",
  kinds: { [COAST_FRAME]: frameGuard, [COAST_SESSION]: sessionGuard, [COAST_AX]: axGuard },
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const file = delivery.files.find((entry) => entry.path === COAST_FILE);
    if (file === undefined) refuse(`the delivery carries no ${COAST_FILE}`);
    const window = databaseWindow(delivery.facts);
    const device = unitOf(delivery.source);
    const videos = coastVideos(delivery.files, files);
    const db = await openDeliveredSqlite(files, file);
    try {
      const nodes = axNodes(coastShape((table) => db.columns(table)), (sql, ...params) => db.get(sql, ...(params as SqliteValue[])));
      const identities = new Identities(db);
      const touched = window.kind === "delta" ? new Set<bigint>() : undefined;
      yield* each(db.rows("frame", "id", { window }), (part) => part.where, function* (part) {
        const row = part.read();
        const id = int(row.id, "frame.id");
        if (typeof row.timestamp !== "bigint") refuse(`frame ${id} timestamp is not an integer`);
        const identity = identities.of(id, row.timestamp);
        let start: string | null = null;
        if (row.segment !== null) {
          const segment = int(row.segment, `frame ${id} segment`);
          touched?.add(segment);
          start = identities.sessionStart(segment, `frame ${id}`);
        }
        let video: JsonObject | null = null;
        if (row.video !== null) {
          const found = db.get("SELECT path FROM video WHERE id = ?", row.video!);
          if (typeof found?.path !== "string" || !HEX.test(found.path)) refuse(`frame ${id} video does not resolve to a 64-hex path`);
          video = { hash: found.path, index: number(row.video_index ?? null) };
        }
        const windows = db.all(
          `SELECT a.bundle_id, a.version, a.display_name, w.window_title, w.url, w.x, w.y, w.width, w.height, w.window_layer, w.z_order
             FROM window_bound AS w LEFT JOIN application AS a ON a.id = w.application WHERE w.frame = ?`,
          row.id!,
        ).map((window) => {
          const cells = rowJson(window);
          const { bundle_id, version, display_name, ...rest } = cells;
          return { application: { bundle_id: bundle_id ?? null, version: version ?? null, display_name: display_name ?? null }, ...rest };
        });
        const cells = rowJson(row);
        const frame: ReaderOutput = {
          kind: COAST_FRAME,
          key: identity,
          content: {
            type: "screen.frame",
            frame_id: Number(id),
            timestamp_ms: Number(row.timestamp),
            width: cells.width ?? null,
            height: cells.height ?? null,
            is_inactive: cells.is_inactive ?? null,
            image_path: cells.image_path ?? null,
            foreground: cells.foreground ?? null,
            background: cells.background ?? null,
            title: cells.title ?? null,
            capture_display: {
              x: cells.capture_display_x ?? null,
              y: cells.capture_display_y ?? null,
              width: cells.capture_display_width ?? null,
              height: cells.capture_display_height ?? null,
            },
            video,
            session_start_frame_identity: start,
            windows: ordered(windows),
          },
          time: instant(String(row.timestamp), "unix-ms"),
          device,
          locator: `frame row ${id}`,
        };
        const blobs = coastFrameBlobs(frame.content!, videos);
        if (blobs.length > 0) frame.blobs = blobs;
        yield frame;
      });

      const stated = (segment: bigint): ReaderOutput[] => [session(db, identities, segment, device)];
      if (touched === undefined) yield* each(db.rows("segment", "id", { columns: ["id"] }), (part) => part.where, (part) => stated(part.read().id as bigint));
      else yield* each([...touched].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), (segment) => `segment id ${segment}`, stated);

      if (db.get("SELECT 1 AS found FROM ax_snapshot LIMIT 1") === undefined) return;
      let cache = new Map<string, JsonObject>();
      yield* each(db.rows("ax_snapshot", "frame_id", { window }), (part) => part.where, function* (part) {
        const row = part.read();
        const frameId = int(row.frame_id, "ax_snapshot.frame_id");
        const frame = db.get("SELECT timestamp FROM frame WHERE id = ?", frameId);
        if (typeof frame?.timestamp !== "bigint") refuse(`ax_snapshot frame_id ${frameId} does not resolve to a frame`);
        if (typeof row.timestamp_ms !== "bigint") refuse(`ax_snapshot for frame ${frameId} timestamp_ms is not an integer`);
        const where = `ax_snapshot frame ${frameId} ${nodes.rootColumn}`;
        const root = nodes.rootHash(row[nodes.rootColumn], where);
        if (root === undefined) refuse(`${where} names no AX node`);
        if (cache.size > CACHE_NODES) cache = new Map();
        const tree = axTree(root, nodes, cache);
        const cells = rowJson(row);
        const identity = identities.of(frameId, frame.timestamp);
        yield {
          kind: COAST_AX,
          key: identity,
          content: {
            type: "screen.ax",
            frame_identity: identity,
            root_hash: root,
            timestamp_ms: Number(row.timestamp_ms),
            application_name: cells.application_name ?? null,
            bundle_id: cells.bundle_id ?? null,
            process_identifier: cells.process_identifier ?? null,
            extraction_mode: cells.extraction_mode ?? null,
            is_partial_tree: cells.is_partial_tree ?? null,
            tree,
          },
          time: instant(String(row.timestamp_ms), "unix-ms"),
          device,
          locator: `ax_snapshot frame ${frameId}`,
        };
      });
    } finally {
      db.close();
    }
  },
};

function session(db: Sqlite, identities: Identities, segment: bigint, device: string): ReaderOutput {
  const row = db.get(
    `SELECT s.id, s.start_frame_id, s.url, s.domain AS domain_id, a.bundle_id, a.version, a.display_name, d.normalized_domain, d.common_name
       FROM segment AS s LEFT JOIN application AS a ON a.id = s.application LEFT JOIN domain AS d ON d.id = s.domain WHERE s.id = ?`,
    segment,
  );
  if (row === undefined) refuse(`segment ${segment} is named by a frame but not held`);
  const members = db.all("SELECT id, timestamp FROM frame WHERE segment = ? ORDER BY timestamp, id", segment);
  const startId = int(row.start_frame_id, `segment ${segment} start_frame_id`);
  if (members.length === 0 || members[0]!.id !== startId) {
    refuse(`segment ${segment} start_frame_id ${startId} is not its earliest frame`);
  }
  const frames = members.map((member) => identities.of(member.id as bigint, member.timestamp as bigint));
  const cells = rowJson(row);
  const content: JsonObject = {
    type: "screen.session",
    start_frame_identity: frames[0]!,
    application: { bundle_id: cells.bundle_id ?? null, version: cells.version ?? null, display_name: cells.display_name ?? null },
    ...(row.domain_id === null ? {} : { domain: { normalized_domain: cells.normalized_domain ?? null, common_name: cells.common_name ?? null } }),
    ...(row.url === null ? {} : { url: cells.url ?? null }),
    frames,
  };
  const first = instant(String(members[0]!.timestamp), "unix-ms");
  const last = instant(String(members[members.length - 1]!.timestamp), "unix-ms");
  return { kind: COAST_SESSION, key: frames[0]!, content, time: span(first, last), device, locator: `segment row ${segment}` };
}

class Identities {
  readonly #rank;
  readonly #frame;
  readonly #segment;

  constructor(db: Sqlite) {
    this.#rank = (id: bigint, timestamp: bigint) => Number((db.get("SELECT count(*) AS n FROM frame WHERE timestamp = ? AND id < ?", timestamp, id)!.n as bigint));
    this.#frame = (id: bigint) => db.get("SELECT timestamp FROM frame WHERE id = ?", id);
    this.#segment = (id: bigint) => db.get("SELECT start_frame_id FROM segment WHERE id = ?", id);
  }

  of(id: bigint, timestamp: bigint): string {
    const rank = this.#rank(id, timestamp);
    return rank === 0 ? String(timestamp) : `${timestamp}:${rank}`;
  }

  sessionStart(segment: bigint, where: string): string {
    const start = this.#segment(segment)?.start_frame_id;
    const frame = typeof start === "bigint" ? this.#frame(start) : undefined;
    if (typeof frame?.timestamp !== "bigint") refuse(`${where} segment ${segment} start_frame_id ${String(start)} does not resolve to a frame`);
    return this.of(start as bigint, frame.timestamp);
  }
}

export function coastVideos(delivery: readonly { path: string; blob: string }[], files?: { bytes(hash: string): Buffer }): Map<string, string> {
  const videos = new Map<string, string>();
  const index = delivery.find((file) => file.path === VIDEO_INDEX_FILE);
  if (index !== undefined && files !== undefined) for (const [path, entry] of blobIndex(files.bytes(index.blob))) videos.set(path, entry.blob);
  for (const file of delivery) if (file.path.startsWith(VIDEO_DIRECTORY)) videos.set(file.path.slice(VIDEO_DIRECTORY.length), file.blob);
  return videos;
}

export function coastFrameBlobs(content: Json, videos: ReadonlyMap<string, string>): string[] {
  const video = isObject(content) ? content.video : undefined;
  const blob = isObject(video) && typeof video.hash === "string" ? videos.get(video.hash) : undefined;
  return blob === undefined ? [] : [blob];
}

function int(value: SqliteValue | undefined, where: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) refuse(`${where} is not a positive integer`);
  return value;
}

function number(value: SqliteValue): Json {
  return rowJson({ value }).value ?? null;
}

function exact(value: JsonObject, required: string[], optional: string[] = []): boolean {
  return required.every((member) => member in value) && Object.keys(value).every((member) => required.includes(member) || optional.includes(member));
}

function whole(value: Json | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positive(value: Json | undefined): boolean {
  return whole(value) && (value as number) > 0;
}

