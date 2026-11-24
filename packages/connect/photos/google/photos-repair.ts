import { isObject, MEDIA_HEAD, mediaTypeOf, type BlobReader, type Instant, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import type { Projection, Version } from "@lifestreamprotocol/core";

const SIDECAR_SUFFIX = "supplemental-metadata";
const OWN_MEMBERS = ["type", "blobs"] as const;
const MIN_MS = Date.UTC(1000, 0, 1);
const MAX_MS = Date.UTC(10000, 0, 1) - 1;

export function sidecarNames(name: string, title: string | null): Set<string> {
  const copy = /\((\d+)\)\.json$/iu.exec(name)?.[1];
  const byName = namedBy(name);
  return title === null ? new Set([byName]) : new Set([copy === undefined ? title : copied(title, copy), byName]);
}

export function photoAsset(fields: JsonObject, where: string, original: { hash: string; bytes: number; media_type: string }, title?: string): { content: JsonObject; time: Instant } {
  for (const own of OWN_MEMBERS) if (Object.hasOwn(fields, own)) throw new Error(`${where} states a member ${own}, which is the content's own`);
  const time = timeOf(fields, where);
  return { content: { type: "photos.asset", ...fields, ...(title === undefined ? {} : { title }), blobs: [{ ...original, role: "original" }] }, time };
}

function timeOf(fields: JsonObject, where: string): Instant {
  for (const field of ["photoTakenTime", "creationTime"] as const) {
    const stated = fields[field];
    const timestamp = isObject(stated) ? stated.timestamp : undefined;
    if (timestamp === undefined || timestamp === null) continue;
    if (typeof timestamp !== "string" && typeof timestamp !== "number") throw new Error(`${where}: ${field}.timestamp is no number`);
    const spelled = String(timestamp);
    if (/^-?0+$/u.test(spelled)) continue;
    if (!/^-?\d+$/u.test(spelled)) throw new Error(`${where}: ${field}.timestamp ${JSON.stringify(spelled)} is no whole number of seconds`);
    const start_ms = Number(spelled) * 1000;
    if (!Number.isSafeInteger(start_ms) || start_ms < MIN_MS || start_ms > MAX_MS) throw new Error(`${where}: ${field}.timestamp ${spelled} lies outside the years 1000 to 9999`);
    return { start_ms, precision: "s" };
  }
  throw new Error(`${where} states no time: neither photoTakenTime nor creationTime`);
}

function namedBy(name: string): string {
  let base = name.replace(/\.json$/iu, "");
  const copy = /\((\d+)\)$/u.exec(base)?.[1];
  if (copy !== undefined) base = base.slice(0, -(copy.length + 2));
  const dot = base.lastIndexOf(".");
  const tail = base.slice(dot + 1).toLowerCase();
  if (dot > 0 && tail.length > 0 && SIDECAR_SUFFIX.startsWith(tail)) base = base.slice(0, dot);
  return copy === undefined ? base : copied(base, copy);
}

function copied(name: string, copy: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? `${name.slice(0, dot)}(${copy})${name.slice(dot)}` : `${name}(${copy})`;
}

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

export function fix(head: Version, files: BlobReader): Projection | "keep" {
  const content = head.content;
  if (head.kind !== "img" || !isObject(content) || !Array.isArray(content.takeout_sources)) return "keep";
  const blobs = (Array.isArray(content.blobs) ? content.blobs : []).filter(isObject);
  const original = blobs.find((blob) => blob.role === "original");
  if (original === undefined || typeof original.hash !== "string" || typeof original.bytes !== "number") throw new Error("it holds no original blob");
  const place = content.takeout_sources[0];
  if (!isObject(place) || typeof place.media_path !== "string") throw new Error("its first place names no media path");
  const photo = baseName(place.media_path);
  const sidecars = blobs.flatMap((blob) => (typeof blob.role === "string" && blob.role.startsWith("raw_sidecar:") && typeof blob.hash === "string" ? [{ path: blob.role.slice("raw_sidecar:".length), hash: blob.hash }] : []))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const read = sidecars.map((sidecar) => {
    const fields = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files.bytes(sidecar.hash))) as unknown;
    if (!isObject(fields)) throw new Error(`its sidecar ${sidecar.path} is not a JSON object`);
    return { ...sidecar, fields };
  });
  const own = read.find((sidecar) => sidecarNames(baseName(sidecar.path), typeof sidecar.fields.title === "string" && sidecar.fields.title !== "" ? sidecar.fields.title : null).has(photo));
  const chosen = own ?? read[0];
  if (chosen === undefined) throw new Error(`${photo} keeps no sidecar`);
  const media_type = mediaTypeOf(files.prefix(original.hash, MEDIA_HEAD));
  if (media_type === null) throw new Error(`${photo}: its first bytes are no photo's or video's`);
  const asset = photoAsset(chosen.fields, chosen.path, { hash: original.hash, bytes: original.bytes, media_type }, own === undefined ? photo : undefined);
  return { content: asset.content, time: asset.time, blobs: [original.hash] };
}
