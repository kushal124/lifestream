import { instant, isObject, type AdapterSource, type Copy, type Json, type JsonObject, type PhotoHead, type PhotosAdapter, type PhotoView, type RecordRef } from "@lifestreamprotocol/connect/sdk";
import { PHOTOS_CONNECTOR } from "./phone.js";

const PHOTO_KIND = "img";
const PHOTO_FILE_KIND = "img-file";
const KINDS = [PHOTO_KIND, PHOTO_FILE_KIND];
const ASSET = "photos.apple.asset";
const AVAILABILITY = "photos.apple.availability";
const ORIGINALS = new Set(["photo", "video"]);
const RENDERS = new Set(["fullSizePhoto", "fullSizeVideo"]);
const MOTION = "pairedVideo";
const MOTION_RENDER = "fullSizePairedVideo";
const FILES = new Set([...ORIGINALS, ...RENDERS, MOTION, MOTION_RENDER]);
const NAMED = new Set([...ORIGINALS, MOTION]);
const FINAL = new Set(["not_found", "download_failed"]);

type PhotoFile = Copy["originals"][number];
type PhotoPosition = NonNullable<NonNullable<ReturnType<PhotosAdapter["position"]>>["position"]>;
type Resource = Copy["resources"][number];

export const applePhotosAdapter: PhotosAdapter = {
  version: "1",
  kinds: KINDS,
  library: true,
  rank: (source: AdapterSource) => (source.connector === PHOTOS_CONNECTOR ? 0 : 1),
  paired: (source: AdapterSource) => source.connector === PHOTOS_CONNECTOR,
  copy: (view: PhotoView, source: AdapterSource, id: string) => libraryCopy(view, source.id, id),

  files(version) {
    const payload = payloadOf(version.content, ASSET) ?? payloadOf(version.content, AVAILABILITY);
    if (payload === null) return [];
    const files = new Set<string>();
    for (const resource of resourcesOf(payload)) {
      const file = fileOf(resource);
      if (file !== null && FILES.has(resource.type as string)) files.add(file.sha256);
    }
    return [...files];
  },

  image(view, source, version, key) {
    const asset = payloadOf(version.content, ASSET);
    if (asset !== null) return imageOf(asset);
    const availability = payloadOf(version.content, AVAILABILITY);
    if (availability === null) return null;
    const snapshot = snapshotOf(view, source.id, key);
    return snapshot === null ? null : imageOf({ ...snapshot, resources: availability.resources ?? null });
  },

  placedBy(version, key) {
    if (payloadOf(version.content, AVAILABILITY) === null) return null;
    return { key: /^(.+):sha256:[0-9a-f]{64}$/u.exec(key)?.[1] ?? null };
  },

  position(version) {
    if (!isObject(version.content) || version.content.type !== ASSET) return null;
    const content = isObject(version.content.content) ? version.content.content : undefined;
    const location = isObject(content?.location) ? content.location : undefined;
    return { position: pointOf(location?.latitude, location?.longitude) };
  },
};

function libraryCopy(view: PhotoView, source: string, id: string): Copy | null {
  const records = KINDS.flatMap((kind) => view.keyedUnder(source, kind, `${id}:`)).map((head) => ({ head, version: view.version(head.version) }));
  let current: { head: PhotoHead; payload: JsonObject; modified_ms: number } | null = null;
  for (const { head, version } of records) {
    const payload = payloadOf(version.content, ASSET);
    if (payload === null) continue;
    const modified_ms = modifiedOf(payload);
    if (current === null || modified_ms > current.modified_ms || (modified_ms === current.modified_ms && head.key > current.head.key)) current = { head, payload, modified_ms };
  }
  if (current === null) return null;
  const originals: PhotoFile[] = [];
  const files = new Set<string>();
  const renders: { file: PhotoFile; stated_ms: number }[] = [];
  const motionRenders: { file: PhotoFile; stated_ms: number }[] = [];
  const motion: PhotoFile[] = [];
  const stated = new Map<string, { files: string[]; reason: boolean }>();
  let cloud: string | null = null;
  records.sort((left, right) => Number(right.head.key === current!.head.key) - Number(left.head.key === current!.head.key));
  for (const { head, version } of records) {
    const content = version.content;
    const payload = payloadOf(content, ASSET) ?? payloadOf(content, AVAILABILITY);
    if (payload === null) continue;
    if (cloud === null && typeof payload.cloud_identifier === "string") cloud = payload.cloud_identifier;
    const ofCurrent = head.key === current.head.key || head.key.startsWith(`${current.head.key}:`);
    for (const resource of resourcesOf(payload)) {
      const file = fileOf(resource);
      if (ofCurrent) {
        const said = stated.get(resourceId(resource)) ?? { files: [], reason: false };
        if (file !== null) said.files.push(file.sha256);
        if (FINAL.has(resource.not_local_reason as string)) said.reason = true;
        stated.set(resourceId(resource), said);
      }
      const type = resource.type as string;
      if (file === null || !FILES.has(type)) continue;
      if (ORIGINALS.has(type)) add(originals, file);
      if (type === MOTION) add(motion, file);
      files.add(file.sha256);
      const stated_ms = head.key === current.head.key ? Number.MIN_SAFE_INTEGER : head.start_ms ?? Number.MIN_SAFE_INTEGER;
      if (ofCurrent && RENDERS.has(type)) renders.push({ file, stated_ms });
      if (ofCurrent && type === MOTION_RENDER) motionRenders.push({ file, stated_ms });
    }
  }
  const newest = (stated: { file: PhotoFile; stated_ms: number }[]) => stated.sort((left, right) => right.stated_ms - left.stated_ms).map(({ file }) => file);
  const resources = resourcesOf(current.payload).map((resource): Resource => {
    const said = stated.get(resourceId(resource))!;
    return {
      type: String(resource.type), name: typeof resource.original_filename === "string" ? resource.original_filename : null, size: sizeOf(resource.size),
      files: said.files, refused: said.reason && said.files.length === 0,
    };
  });
  const names = resourcesOf(current.payload).flatMap((resource) => (NAMED.has(resource.type as string) && typeof resource.original_filename === "string" ? [resource.original_filename] : []));
  const video = current.payload.media_type === "video";
  const duration = current.payload.duration;
  return {
    id, records: records.map(({ head }) => ref(head)), at_ms: current.head.start_ms, cloud, names: [...new Set(names)], video,
    originals, renders: newest(renders), motion: video ? { renders: [], originals: [] } : { renders: newest(motionRenders), originals: motion },
    duration_ms: video && typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) : null,
    files: [...files].sort(), resources, modified_ms: current.modified_ms, erased: KINDS.some((kind) => view.erasedUnder(source, kind, `${id}:`)),
  };
}

function snapshotOf(view: PhotoView, source: string, key: string): JsonObject | null {
  const asset = /^(.+):sha256:[0-9a-f]{64}$/u.exec(key)?.[1];
  const head = asset === undefined ? undefined : view.head({ source, kind: PHOTO_KIND, key: asset });
  if (head === undefined || head.version === "gone" || head.start_ms === null) return null;
  return payloadOf(view.version(head.version).content, ASSET);
}

function imageOf(asset: JsonObject): string | null {
  if (asset.media_type !== "image" || typeof asset.local_identifier !== "string" || !Array.isArray(asset.resources)) return null;
  const local = asset.resources.flatMap((resource) => {
    if (!isObject(resource) || (resource.type !== "fullSizePhoto" && resource.type !== "photo") || !isObject(resource.blob)) return [];
    const sha256 = hexOf(resource.blob.hash);
    return sha256 === null || typeof resource.blob.type !== "string" ? [] : [{ type: resource.type, sha256 }];
  });
  const rendered = local.filter((resource) => resource.type === "fullSizePhoto");
  const best = rendered.length > 0 ? rendered : local;
  if (best.length === 0 || best.some((resource) => resource.sha256 !== best[0]!.sha256)) return null;
  if (typeof asset.modification_date === "string") {
    try {
      instant(asset.modification_date, "rfc3339");
    } catch {
      return null;
    }
  }
  return best[0]!.sha256;
}

function resourceId(resource: JsonObject): string {
  return JSON.stringify([resource.type_raw ?? null, resource.original_filename ?? null]);
}

function sizeOf(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function add(files: PhotoFile[], file: PhotoFile): void {
  if (!files.some((each) => each.sha256 === file.sha256)) files.push(file);
}

function payloadOf(content: Json | undefined, type: string): JsonObject | null {
  return isObject(content) && content.type === type && isObject(content.content) ? content.content : null;
}

function resourcesOf(payload: JsonObject): JsonObject[] {
  return Array.isArray(payload.resources) ? payload.resources.filter(isObject) : [];
}

function fileOf(resource: JsonObject): PhotoFile | null {
  const blob = resource.blob;
  const sha256 = isObject(blob) ? hexOf(blob.hash) : null;
  return sha256 === null || !isObject(blob) || typeof blob.type !== "string" ? null : { sha256, media_type: blob.type };
}

function modifiedOf(payload: JsonObject): number {
  if (typeof payload.modification_date !== "string") return Number.MIN_SAFE_INTEGER;
  try {
    return instant(payload.modification_date, "rfc3339").start_ms;
  } catch {
    return Number.MIN_SAFE_INTEGER;
  }
}

function ref(head: PhotoHead): RecordRef {
  return { source: head.source, kind: head.kind, key: head.key };
}

function hexOf(value: Json | undefined): string | null {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) ? value.slice(7) : null;
}

function pointOf(latitude: Json | undefined, longitude: Json | undefined): PhotoPosition | null {
  return typeof latitude === "number" && Number.isFinite(latitude) && typeof longitude === "number" && Number.isFinite(longitude) ? { latitude, longitude, accuracy_m: null } : null;
}
