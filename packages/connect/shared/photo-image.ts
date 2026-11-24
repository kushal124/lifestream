import { isObject, type Json, type PhotosAdapter, type RecordRef, type Registered, type SourceRow, type SourceSelector, type Version, type View } from "@lifestreamprotocol/core";

export const LIBRARY_PHOTO_KIND = "img";
export const LIBRARY_FILE_KIND = "img-file";
export const CAMERA_PHOTO_KIND = "photo";

export type PhotoAdapters = readonly Registered<PhotosAdapter>[];

export function photoInputs(photos: PhotoAdapters): { sources: SourceSelector; kinds: string[] } {
  return { sources: { product: photos.map((each) => each.product) }, kinds: [...new Set(photos.flatMap((each) => each.adapter.kinds))] };
}

export function photoImage(view: View, photos: PhotoAdapters, source: SourceRow, record: RecordRef, version: Version): string | null {
  return adapterOf(photos, source)?.image(view, source, version, record.key) ?? null;
}

export function phonePhoto(view: View, photos: PhotoAdapters, source: SourceRow, record: RecordRef & { start_ms: number | null }, content: Json): { photo: string; taken_ms: number | null } | null {
  if (adapterOf(photos, source)?.paired?.(source) !== true || !isObject(content)) return null;
  if (content.type === "camera.photo") return { photo: record.key, taken_ms: record.start_ms };
  if (content.type !== "photos.apple.asset" && content.type !== "photos.apple.availability") return null;
  const photo = isObject(content.content) ? content.content.local_identifier : undefined;
  if (typeof photo !== "string") return null;
  if (content.type === "photos.apple.asset") return { photo, taken_ms: record.start_ms };
  const key = /^(.+):sha256:[0-9a-f]{64}$/u.exec(record.key)?.[1];
  const asset = key === undefined ? undefined : view.head({ source: record.source, kind: LIBRARY_PHOTO_KIND, key });
  return { photo, taken_ms: asset === undefined || asset.version === "gone" ? null : asset.start_ms };
}

function adapterOf(photos: PhotoAdapters, source: SourceRow): PhotosAdapter | undefined {
  return photos.find((each) => each.product === source.product)?.adapter;
}
