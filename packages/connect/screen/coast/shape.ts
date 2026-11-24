import { createHash } from "node:crypto";
import { refuse, Refused, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export type CoastShape = "hash" | "id";

export const COAST_FILE = "coast.sqlite";

export const COAST_COLUMNS: Record<string, string[]> = {
  application: ["id", "bundle_id", "version", "display_name"],
  domain: ["id", "normalized_domain", "common_name"],
  video: ["id", "path"],
  segment: ["id", "start_frame_id", "application", "domain", "url"],
  frame: [
    "id", "timestamp", "video", "video_index", "image_path", "width", "height", "foreground", "background", "title",
    "segment", "is_inactive", "capture_display_x", "capture_display_y", "capture_display_width", "capture_display_height",
  ],
  window_bound: ["frame", "application", "window_title", "url", "x", "y", "width", "height", "window_layer", "z_order"],
  ax_snapshot: ["frame_id", "timestamp_ms", "application_name", "bundle_id", "process_identifier", "extraction_mode", "is_partial_tree"],
  ax_node: ["payload"],
};

export class CoastShapeUnknown extends Refused {
  readonly shape: string;

  constructor(shape: string) {
    super(`Coast's schema is a shape this connector does not read: ${shape}`);
    this.shape = shape;
    this.name = "CoastShapeUnknown";
  }
}

export function coastShape(columns: (table: string) => string[]): CoastShape {
  const missing: string[] = [];
  for (const [table, wanted] of Object.entries(COAST_COLUMNS)) {
    const declared = columns(table);
    for (const column of wanted) if (!declared.includes(column)) missing.push(`${table}.${column}`);
  }
  const node = columns("ax_node");
  const snapshot = columns("ax_snapshot");
  const index = columns("ax_node_hash");
  const ax = `ax_node(${node.join(",")}) ax_snapshot root ${snapshot.filter((column) => column.startsWith("root")).join(",") || "none"} ax_node_hash(${index.join(",")})`;
  const shape: CoastShape | undefined =
    node.includes("hash") && snapshot.includes("root_hash") ? "hash"
    : node.includes("id") && snapshot.includes("root_id") && index.includes("hash") && index.includes("node_id") ? "id"
    : undefined;
  if (shape === undefined || missing.length > 0) {
    throw new CoastShapeUnknown(`${missing.length === 0 ? "" : `missing ${missing.join(", ")}; `}${ax}`);
  }
  return shape;
}

export class MissingAxNode extends Refused {
  constructor(where: string) {
    super(`${where} is absent`);
    this.name = "MissingAxNode";
  }
}

type Get = (sql: string, ...params: unknown[]) => Record<string, unknown> | undefined;

export interface AxNodes {
  readonly rootColumn: "root_hash" | "root_id";
  rootHash(value: unknown, where: string): string | undefined;
  payload(hash: string): Buffer | undefined;
}

export function axNodes(shape: CoastShape, get: Get): AxNodes {
  const payloadOf = (row: Record<string, unknown> | undefined): Buffer | undefined =>
    row !== undefined && Buffer.isBuffer(row.payload) ? row.payload : undefined;
  if (shape === "hash") {
    return {
      rootColumn: "root_hash",
      rootHash(value, where) {
        if (!Buffer.isBuffer(value) || value.length !== 32) refuse(`${where} is not a 32-byte hash`);
        return value.toString("hex");
      },
      payload: (hash) => payloadOf(get("SELECT payload FROM ax_node WHERE hash = ?", Buffer.from(hash, "hex"))),
    };
  }
  return {
    rootColumn: "root_id",
    rootHash(value) {
      const payload = payloadOf(get("SELECT payload FROM ax_node WHERE id = ?", value));
      return payload === undefined ? undefined : createHash("sha256").update(payload).digest("hex");
    },
    payload: (hash) =>
      payloadOf(get("SELECT n.payload AS payload FROM ax_node_hash AS h CROSS JOIN ax_node AS n ON n.id = h.node_id WHERE h.hash = ?", Buffer.from(hash, "hex"))),
  };
}

export function axTree(root: string, nodes: AxNodes, cache: Map<string, JsonObject>, onNonFinite: () => void = () => {}): JsonObject {
  const walk = (hash: string, ancestors: Set<string>): JsonObject => {
    if (ancestors.has(hash)) refuse(`a cycle reaches AX node ${hash}`);
    let node = cache.get(hash);
    if (node === undefined) {
      const payload = nodes.payload(hash);
      if (payload === undefined) throw new MissingAxNode(`AX node ${hash}`);
      const actual = createHash("sha256").update(payload).digest("hex");
      if (actual !== hash) refuse(`AX node ${hash} payload hashes to ${actual}`);
      node = decodeAxNode(payload, `AX node ${hash}`, onNonFinite);
      cache.set(hash, node);
    }
    ancestors.add(hash);
    try {
      return { hash, node, children: (node.child_hashes as string[]).map((child) => walk(child, ancestors)) };
    } finally {
      ancestors.delete(hash);
    }
  };
  return walk(root, new Set());
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export function decodeAxNode(input: Buffer, where: string, onNonFinite: () => void): JsonObject {
  let at = 0;
  const take = (length: number, member: string): Buffer => {
    if (length < 0 || at + length > input.length) refuse(`${where}: ${member} is truncated at byte ${at}`);
    const bytes = input.subarray(at, at + length);
    at += length;
    return bytes;
  };
  const u8 = (member: string) => take(1, member)[0]!;
  const u16 = (member: string) => take(2, member).readUInt16LE(0);
  const text = (member: string): string => {
    const bytes = take(u16(`${member} length`), member);
    try {
      return UTF8.decode(bytes);
    } catch {
      return refuse(`${where}: ${member} is not UTF-8`);
    }
  };
  const flag = (member: string): boolean => {
    const value = u8(member);
    if (value !== 0 && value !== 1) refuse(`${where}: ${member} is ${value}, not 0 or 1`);
    return value === 1;
  };
  if (!take(4, "magic").equals(Buffer.from("AXN2", "ascii"))) refuse(`${where}: no AXN2 magic`);
  const version = u8("version");
  if (version !== 2) refuse(`${where}: AXN2 version ${version} is not one this connector reads`);
  const flags = u8("field mask");
  const node: JsonObject = { version, flags };
  if ((flags & 0x01) !== 0) {
    node.role = text("role");
    if (node.role === "") refuse(`${where}: role is present but empty`);
  }
  if ((flags & 0x02) !== 0) node.title = text("title");
  if ((flags & 0x04) !== 0) node.description = text("description");
  if ((flags & 0x08) !== 0) node.value = text("value");
  if ((flags & 0x10) !== 0) {
    const pair = take(8, "position");
    const x = pair.readFloatLE(0);
    const y = pair.readFloatLE(4);
    if (Number.isFinite(x) && Number.isFinite(y)) node.position = { x, y };
    else onNonFinite();
  }
  if ((flags & 0x20) !== 0) {
    const pair = take(8, "size");
    const width = pair.readFloatLE(0);
    const height = pair.readFloatLE(4);
    if (Number.isFinite(width) && Number.isFinite(height)) node.size = { width, height };
    else onNonFinite();
  }
  if ((flags & 0x40) !== 0) node.enabled = flag("enabled");
  if ((flags & 0x80) !== 0) node.visible = flag("visible");
  const children = take(4, "child count").readUInt32LE(0);
  const child_hashes: string[] = [];
  for (let index = 0; index < children; index++) {
    const length = u16(`child ${index} hash length`);
    if (length !== 32) refuse(`${where}: child ${index} hash has ${length} bytes instead of 32`);
    child_hashes.push(take(length, `child ${index} hash`).toString("hex"));
  }
  node.child_hashes = child_hashes;
  const attributes: JsonObject[] = [];
  const count = u16("attribute count");
  for (let index = 0; index < count; index++) attributes.push({ name: text(`attribute ${index} name`), value: text(`attribute ${index} value`) });
  node.attributes = attributes;
  if (at !== input.length) refuse(`${where}: ${input.length - at} unexplained byte(s) follow the AXN2 node`);
  return node;
}
