import { createHash } from "node:crypto";
import { basicInstant, checks, instant, isObject, refuse, type Guard, type Instant, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { LIBRARY_FILE_KIND, LIBRARY_PHOTO_KIND } from "../../shared/photo-image.js";

const { count, exact, first, guard, rfc3339, SHA256, text } = checks;

const ASSET = "photos.apple.asset";
const AVAILABILITY = "photos.apple.availability";
export const PHOTO_KIND = LIBRARY_PHOTO_KIND;
export const PHOTO_FILE_KIND = LIBRARY_FILE_KIND;
const TYPES: Readonly<Record<string, string>> = { asset: ASSET, resource_availability: AVAILABILITY };
const KIND_OF: Readonly<Record<string, string>> = { [ASSET]: PHOTO_KIND, [AVAILABILITY]: PHOTO_FILE_KIND };

export function photoRow(kind: Json | undefined, payload: JsonObject, observed: Instant, where: string): ReaderOutput {
  if (kind === "gone") {
    const of = typeof payload.of === "string" ? TYPES[payload.of] : undefined;
    if (of === undefined || !isObject(payload.payload)) refuse(`${where}: a gone names the entry it ends, {of: asset | resource_availability, payload}`);
    return { kind: KIND_OF[of]!, key: keyOf(of, payload.payload, where), content: null, gone: true };
  }
  const type = typeof kind === "string" ? TYPES[kind] : undefined;
  if (type === undefined) refuse(`${where} is a photos entry kind no library writes: ${JSON.stringify(kind)}`);
  const content: JsonObject = { type, content: payload };
  const created = type === ASSET && typeof payload.creation_date === "string" ? readInstant(payload.creation_date, `${where}: its creation_date`) : undefined;
  const time = type === ASSET ? created : observed;
  const blobs = photoBlobs(content);
  return {
    kind: KIND_OF[type]!,
    key: keyOf(type, payload, where),
    content,
    ...(time === undefined ? {} : { time }),
    ...(blobs.length === 0 ? {} : { blobs }),
  };
}

function keyOf(type: string, payload: JsonObject, where: string): string {
  const key = assetKey(payload, where);
  return type === ASSET ? key : `${key}:${bindingsDigest(payload)}`;
}

function assetKey(payload: JsonObject, where: string): string {
  const local = payload.local_identifier;
  if (typeof local !== "string" || local.length === 0 || local.includes(":")) refuse(`${where}: the local identifier must be non-empty and colon-free`);
  const modified = payload.modification_date;
  if (modified === null) return `${local}:null`;
  if (typeof modified !== "string") refuse(`${where}.payload.modification_date must be an RFC 3339 instant or null`);
  const time = readInstant(modified, `${where}.payload.modification_date`);
  const fraction = (/^[^.]*T\d{2}:\d{2}:\d{2}\.(\d+)/u.exec(modified)?.[1] ?? "").replace(/0+$/u, "");
  const whole = basicInstant(Math.floor(time.start_ms / 1000) * 1000).slice(0, -1);
  return `${local}:${whole}${fraction === "" ? "" : `.${fraction}`}Z`;
}

function bindingsDigest(payload: JsonObject): string {
  const resources = Array.isArray(payload.resources) ? payload.resources : [];
  const tuples = new Set(resources.flatMap((resource) =>
    isObject(resource) && isObject(resource.blob) ? [JSON.stringify([resource.type_raw, resource.uti, resource.original_filename, resource.blob.hash])] : []));
  const sorted = [...tuples].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return `sha256:${createHash("sha256").update(`[${sorted.join(",")}]`).digest("hex")}`;
}

function photoBlobs(content: Json): string[] {
  const photo = isObject(content) ? content.content : undefined;
  const resources = isObject(photo) && Array.isArray(photo.resources) ? photo.resources : [];
  const blobs: string[] = [];
  for (const resource of resources) {
    const hash = isObject(resource) && isObject(resource.blob) ? resource.blob.hash : undefined;
    if (typeof hash === "string" && SHA256.test(hash) && !blobs.includes(hash)) blobs.push(hash);
  }
  return blobs;
}

export const img: Guard = guard((content) => entryShape(content, ASSET));

export const imgFile: Guard = guard((content) => entryShape(content, AVAILABILITY));

function entryShape(content: Json, type: typeof ASSET | typeof AVAILABILITY): string | undefined {
  if (!isObject(content) || !exact(content, ["type", "content"]) || !isObject(content.content)) return "content must be {type, content}";
  if (content.type !== type) return `content.type must be ${type}`;
  const photo = content.content;
  return first([
    ["content.local_identifier must be non-empty and colon-free", () => text(photo.local_identifier) && !photo.local_identifier.includes(":")],
    ["content.modification_date must be an RFC 3339 instant or null", () => photo.modification_date === null || rfc3339(photo.modification_date)],
    ["content.cloud_identifier must be text or null", () => photo.cloud_identifier === undefined || photo.cloud_identifier === null || text(photo.cloud_identifier)],
    ["content.resources must each state type, type_raw, uti, original_filename and a blob or not_local", () => Array.isArray(photo.resources) && photo.resources.every(resourceShape)],
    ["an asset must be an image or a video, with a creation_date or null", () =>
      type === AVAILABILITY || ((photo.media_type === "image" || photo.media_type === "video") && (photo.creation_date === null || rfc3339(photo.creation_date)))],
  ]);
}

function resourceShape(resource: Json): boolean {
  if (!isObject(resource) || !text(resource.type) || !text(resource.uti) || !text(resource.original_filename)) return false;
  if (typeof resource.type_raw !== "number" || !Number.isSafeInteger(resource.type_raw)) return false;
  if (resource.blob === null) return resource.not_local === true;
  const blob = resource.blob;
  return isObject(blob) && typeof blob.hash === "string" && SHA256.test(blob.hash) && text(blob.type) && text(blob.role) && count(blob.bytes);
}

function readInstant(value: string, where: string): Instant {
  try {
    return instant(value, "rfc3339");
  } catch {
    return refuse(`${where} must be an RFC 3339 instant`);
  }
}
