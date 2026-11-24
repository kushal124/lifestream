import { isObject, type Adapters, type Copy, type Json, type JsonObject, type PhotosAdapter, type PhotoView } from "@lifestreamprotocol/connect/sdk";

const PHOTO_KIND = "img";
const PHOTO = "camera.photo";

const cameraPhotos: PhotosAdapter = {
  version: "1",
  kinds: [PHOTO_KIND],
  rank: () => 3,
  paired: () => true,
  copy: (view: PhotoView, source, key) => cameraCopy(view, source.id, key),
  files: (version) => {
    const sha256 = hashOf(version.content);
    return sha256 === null ? [] : [sha256];
  },
  image: (_view, _source, version) => blobOf(version.content)?.sha256 ?? null,
  placedBy: () => null,

  position(version) {
    const content = version.content;
    if (!isObject(content) || content.type !== PHOTO) return null;
    const payload = isObject(content.content) && isObject(content.content.payload) ? content.content.payload : undefined;
    const location = isObject(payload?.location) ? payload.location : undefined;
    const { latitude, longitude, horizontal_accuracy: accuracy } = location ?? {};
    if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) return { position: null };
    return { position: { latitude, longitude, accuracy_m: typeof accuracy === "number" && Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null } };
  },
};

export const photosAdapters: Readonly<Record<string, Pick<Adapters, "photos">>> = { camera: { photos: cameraPhotos } };

function cameraCopy(view: PhotoView, source: string, key: string): Copy | null {
  const head = view.head({ source, kind: PHOTO_KIND, key });
  if (head === undefined || head.version === "gone") return null;
  const content = view.version(head.version).content;
  if (!isObject(content) || content.type !== PHOTO) return null;
  const original = blobOf(content);
  if (original === null) return null;
  return {
    id: key, records: [{ source, kind: head.kind, key: head.key }], at_ms: head.start_ms, cloud: null, names: [], video: false,
    originals: [original], renders: [], motion: { renders: [], originals: [] }, duration_ms: null, files: [original.sha256],
    resources: [{ type: "original", name: null, size: null, files: [original.sha256], refused: false }], modified_ms: Number.MIN_SAFE_INTEGER, erased: false,
  };
}

function blobOf(content: Json): { sha256: string; media_type: string } | null {
  if (!isObject(content) || content.type !== PHOTO) return null;
  const sha256 = hashOf(content);
  const blob = payloadBlob(content);
  return sha256 === null || !isObject(blob) || typeof blob.type !== "string" ? null : { sha256, media_type: blob.type };
}

function hashOf(content: Json): string | null {
  const blob = payloadBlob(content);
  const hash = isObject(blob) ? (blob as JsonObject).hash : undefined;
  return typeof hash === "string" && /^sha256:[0-9a-f]{64}$/u.test(hash) ? hash.slice(7) : null;
}

function payloadBlob(content: Json): Json | undefined {
  return isObject(content) && isObject(content.content) && isObject(content.content.payload) ? content.content.payload.blob : undefined;
}
