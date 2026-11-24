import { checks, each, instant, isObject, listedBlobs, readJson, refuse, unitOf, utf8, type BlobReader, type Delivery, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../shared/phone-shipment.js";

const { count, exact, first, guard, rfc3339, SHA256, text } = checks;
const { readShipment } = phoneShipment;
type Shipment = phoneShipment.Shipment;

export const UPLOAD_CONNECTOR = "upload";
export const UPLOAD_INDEX = "upload.json";
export const UPLOAD_INDEX_FORMAT = "org.lifestreamprotocol.upload/1";
export const UPLOAD_FILES = "files/";
export const UPLOAD_DOMAIN = "upload";

const INDEX_LIMIT = 64 * 1024 * 1024;
const PHONE_LANE = /^phone:[^/]+\//u;

export interface UploadedFile {
  readonly path: string;
  readonly name: string;
  readonly blob: string;
  readonly bytes: number;
  readonly media_type?: string;
  readonly created_at?: string;
  readonly modified_at?: string;
  readonly shared_at?: string;
  readonly device?: string;
  readonly locator: string;
}

export async function* uploadedFiles(delivery: Delivery, files: BlobReader): AsyncGenerator<UploadedFile> {
  for await (const part of uploadParts(delivery, files)) yield part.read();
}

interface UploadPart {
  readonly where: string;
  read(): UploadedFile;
}

async function* uploadParts(delivery: Delivery, files: BlobReader): AsyncGenerator<UploadPart> {
  if (delivery.files.some((file) => file.path === UPLOAD_INDEX)) {
    for (const file of folderFiles(delivery, files)) yield { where: file.locator, read: () => file };
  } else if (PHONE_LANE.test(delivery.id)) {
    yield* readShipment(delivery, files, sharedFiles);
  }
}

function* folderFiles(delivery: Delivery, files: BlobReader): Generator<UploadedFile> {
  const index = delivery.files.find((file) => file.path === UPLOAD_INDEX)!;
  if (index.size > INDEX_LIMIT) refuse(`${UPLOAD_INDEX} holds ${index.size} bytes, past the ${INDEX_LIMIT} it may`);
  const stated = readJson(utf8(files.bytes(index.blob), UPLOAD_INDEX), UPLOAD_INDEX);
  if (!exact(stated, ["format", "files"]) || stated.format !== UPLOAD_INDEX_FORMAT || !Array.isArray(stated.files))
    refuse(`${UPLOAD_INDEX} must be {format: "${UPLOAD_INDEX_FORMAT}", files: [...]}`);
  const held = new Map(delivery.files.filter((file) => file.path.startsWith(UPLOAD_FILES)).map((file) => [file.path.slice(UPLOAD_FILES.length), file]));
  const named = new Set<string>();
  const device = unitOf(delivery.source);
  for (const [at, entry] of (stated.files as Json[]).entries()) {
    const where = `${UPLOAD_INDEX} files[${at}]`;
    if (!exact(entry, ["path"], ["media_type", "created_at", "modified_at"])) refuse(`${where} must state path, and only media_type, created_at and modified_at beside it`);
    const path = entry.path;
    if (!text(path)) refuse(`${where}.path must be non-empty text`);
    if (named.has(path)) refuse(`${where} names ${JSON.stringify(path)} a second time`);
    named.add(path);
    const file = held.get(path) ?? refuse(`${where} names ${JSON.stringify(path)}, which the delivery does not hold`);
    yield {
      path, name: path.slice(path.lastIndexOf("/") + 1), blob: file.blob, bytes: file.size, device, locator: `${UPLOAD_FILES}${path}`,
      ...stringMembers(entry, ["media_type", "created_at", "modified_at"], where),
    };
  }
  const unnamed = [...held.keys()].filter((path) => !named.has(path));
  if (unnamed.length > 0) refuse(`${UPLOAD_INDEX} names no entry for ${unnamed.length} file(s) the delivery holds: ${unnamed.slice(0, 3).join(", ")}`);
}

async function* sharedFiles(shipment: Shipment): AsyncGenerator<UploadPart> {
  for await (const part of shipment.entries(UPLOAD_DOMAIN)) yield { where: part.where, read: () => sharedFile(shipment, part.where, part.read().entry) };
}

function sharedFile(shipment: Shipment, where: string, entry: JsonObject): UploadedFile {
  if (entry.kind !== "file") refuse(`${where} is an entry kind this connector does not know: ${JSON.stringify(entry.kind)}`);
  const payload = entry.payload;
  if (!exact(payload, ["name", "blob"]) || !text(payload.name)) refuse(`${where}.payload must be {name, blob}`);
  const blob = payload.blob;
  if (!exact(blob, ["hash", "bytes", "type", "role"]) || typeof blob.hash !== "string" || !SHA256.test(blob.hash) || !count(blob.bytes) || !text(blob.type) || blob.role !== "original")
    refuse(`${where}.payload.blob must state hash, bytes, type and role "original"`);
  const hash = blob.hash as string;
  const carried = shipment.carriedSize(hash);
  if (carried !== undefined && carried !== blob.bytes) refuse(`${where} states ${String(blob.bytes)} bytes for a blob of ${carried}`);
  if (!rfc3339(entry.observed_at)) refuse(`${where}.observed_at must be an RFC 3339 instant`);
  return {
    path: payload.name as string, name: payload.name as string, blob: hash, bytes: blob.bytes as number, media_type: blob.type as string,
    shared_at: entry.observed_at, locator: where, ...(shipment.unit === undefined ? {} : { device: shipment.unit }),
  };
}

function stringMembers(object: JsonObject, names: readonly string[], where: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = object[name];
    if (value === undefined) continue;
    if (!text(value) || (name.endsWith("_at") && !rfc3339(value))) refuse(`${where}.${name} must be ${name.endsWith("_at") ? "an RFC 3339 instant" : "non-empty text"}`);
    out[name] = value;
  }
  return out;
}

export const uploadConnector: Reader = {
  name: UPLOAD_CONNECTOR,
  kinds: { file: guard(fileGuard) },
  read: (delivery, files) => each(delivery.facts.import !== undefined ? [] : uploadParts(delivery, files), (part) => part.where, (part): ReaderOutput[] => {
    const file = part.read();
    const content: JsonObject = {
      type: "upload.file", path: file.path, name: file.name, bytes: file.bytes,
      ...(file.media_type === undefined ? {} : { media_type: file.media_type }),
      ...(file.created_at === undefined ? {} : { created_at: file.created_at }),
      ...(file.modified_at === undefined ? {} : { modified_at: file.modified_at }),
      ...(file.shared_at === undefined ? {} : { shared_at: file.shared_at }),
      blobs: [{ hash: file.blob, bytes: file.bytes, role: "original" }],
    };
    const row: ReaderOutput = { kind: "file", key: file.blob.slice("sha256:".length), content, blobs: listedBlobs(content), locator: file.locator };
    const time = timeOf(file);
    if (time !== undefined) row.time = time;
    if (file.device !== undefined) row.device = file.device;
    return [row];
  }),
};

function timeOf(file: UploadedFile): Instant | undefined {
  const at = file.modified_at ?? file.shared_at;
  return at === undefined ? undefined : instant(at, "rfc3339");
}

function fileGuard(content: Json): string | undefined {
  if (!exact(content, ["type", "path", "name", "bytes", "blobs"], ["media_type", "created_at", "modified_at", "shared_at"]) || content.type !== "upload.file")
    return "content must be {type: upload.file, path, name, bytes, blobs} with media_type, created_at, modified_at, shared_at where stated";
  const blobs = content.blobs;
  const blob = Array.isArray(blobs) && blobs.length === 1 && isObject(blobs[0]) ? blobs[0] : undefined;
  return first([
    ["path and name must be non-empty text", () => text(content.path) && text(content.name)],
    ["bytes must be a whole number", () => count(content.bytes)],
    ["media_type must be non-empty text", () => content.media_type === undefined || text(content.media_type)],
    ["created_at, modified_at and shared_at must be RFC 3339 instants", () => ["created_at", "modified_at", "shared_at"].every((name) => content[name] === undefined || rfc3339(content[name]))],
    ["blobs must be one original, its hash and its bytes", () => blob !== undefined && exact(blob, ["hash", "bytes", "role"]) && typeof blob.hash === "string" && SHA256.test(blob.hash) && blob.bytes === content.bytes && blob.role === "original"],
  ]);
}
