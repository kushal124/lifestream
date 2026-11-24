import { isObject, type Copy, type Json, type JsonObject, type PhotoHead, type PhotosAdapter, type PhotoView } from "@lifestreamprotocol/connect/sdk";
import { companionName, extensionless, unmarked, uneditedOf } from "./names.js";

const PHOTO_KIND = "img";
const ASSET = "photos.asset";

export const googlePhotosAdapter: PhotosAdapter = {
  version: "1",
  kinds: [PHOTO_KIND],
  keyed: true,
  rank: () => 2,
  copy: (view: PhotoView, source, key) => takeoutCopy(view, source.id, key),
  files: (_version, key) => [key],
  image: (_view, _source, version, key) => {
    const file = fileOf(version.content, key);
    return file === null || file.video ? null : key;
  },
  placedBy: () => null,

  position(version) {
    const content = version.content;
    if (!isObject(content) || content.type !== ASSET) return null;
    const exif = isObject(content.geoDataExif) ? content.geoDataExif : undefined;
    const latitude = exif?.latitude;
    const longitude = exif?.longitude;
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) return { position: null };
    return { position: latitude === 0 && longitude === 0 ? null : { latitude, longitude, accuracy_m: null } };
  },
};

interface Read {
  key: string;
  at_ms: number | null;
  name: string | null;
  media_type: string;
  bytes: number | null;
  video: boolean;
}

function takeoutCopy(view: PhotoView, source: string, key: string): Copy | null {
  const record = readOf(view, source, key);
  if (record === null) return null;
  const pair = companionOf(view, source, record);
  const [still, video] = pair ?? [record, null];
  const reads = video === null ? [still] : [still, { ...video, name: video.name === null ? null : unmarked(video.name) }];
  const resource = (each: Read, type: string) => ({ type, name: each.name, size: each.bytes, files: [each.key], refused: false });
  return {
    id: still.key, records: reads.map((each) => ({ source, kind: PHOTO_KIND, key: each.key })),
    at_ms: still.at_ms, cloud: null, names: reads.flatMap((each) => (each.name === null ? [] : [each.name])), video: still.video,
    originals: [{ sha256: still.key, media_type: still.media_type }], renders: [],
    motion: { renders: [], originals: video === null ? [] : [{ sha256: video.key, media_type: video.media_type }] }, duration_ms: null,
    files: reads.map((each) => each.key),
    resources: reads.map((each, index) => resource(each, index === 0 ? "original" : "motion")),
    modified_ms: Number.MIN_SAFE_INTEGER, erased: false,
  };
}

function companionOf(view: PhotoView, source: string, record: Read): [Read, Read] | null {
  return record.at_ms === null || record.name === null ? null : pairsAt(view, source, record.at_ms).get(record.key) ?? null;
}

const pairsByView = new WeakMap<PhotoView, Map<string, ReadonlyMap<string, [Read, Read]>>>();

function pairsAt(view: PhotoView, source: string, at_ms: number): ReadonlyMap<string, [Read, Read]> {
  const ofView = pairsByView.get(view) ?? new Map<string, ReadonlyMap<string, [Read, Read]>>();
  pairsByView.set(view, ofView);
  const id = `${source}\0${at_ms}`;
  const known = ofView.get(id);
  if (known !== undefined) return known;
  const at = [...view.heads(source, PHOTO_KIND, { start_ms: at_ms, end_ms: at_ms + 1 })]
    .filter((head) => head.start_ms === at_ms).flatMap((head) => readHead(view, head) ?? []);
  const stills = new Map<string, Read[]>();
  const videos = new Map<string, Read[]>();
  const add = (by: Map<string, Read[]>, name: string, read: Read) => by.set(name, [...(by.get(name) ?? []), read]);
  for (const read of at) {
    if (read.name === null) continue;
    if (!read.video && uneditedOf(read.name) === null) add(stills, extensionless(unmarked(read.name)), read);
    if (read.video && companionName(read.name)) for (const name of videoNames(read.name)) add(videos, name, read);
  }
  const pairs = new Map<string, [Read, Read]>();
  for (const [bare, met] of stills) {
    const video = met.length === 1 && videos.get(bare)?.length === 1 ? videos.get(bare)![0]! : null;
    if (video === null || videoNames(video.name!).flatMap((name) => stills.get(name) ?? []).length !== 1) continue;
    pairs.set(met[0]!.key, [met[0]!, video]).set(video.key, [met[0]!, video]);
  }
  ofView.set(id, pairs);
  return pairs;
}

function videoNames(name: string): [string, string] {
  const named = unmarked(name);
  return [extensionless(named), named];
}

function readOf(view: PhotoView, source: string, key: string): Read | null {
  const head = view.head({ source, kind: PHOTO_KIND, key });
  return head === undefined || head.version === "gone" ? null : readHead(view, head);
}

function readHead(view: PhotoView, head: PhotoHead): Read | null {
  const content = view.version(head.version).content;
  const file = fileOf(content, head.key);
  if (file === null || !isObject(content)) return null;
  const name = typeof content.title === "string" ? content.title : null;
  return { key: head.key, at_ms: head.start_ms, name, media_type: file.media_type, bytes: file.bytes, video: file.video };
}

function fileOf(content: Json, key: string): { media_type: string; bytes: number | null; video: boolean } | null {
  if (!isObject(content) || content.type !== ASSET) return null;
  const first: Json | undefined = Array.isArray(content.blobs) ? content.blobs[0] : undefined;
  if (!isObject(first) || (first as JsonObject).hash !== `sha256:${key}` || typeof first.media_type !== "string") return null;
  return { media_type: first.media_type, bytes: sizeOf(first.bytes), video: first.media_type.toLowerCase().startsWith("video/") };
}

function sizeOf(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
