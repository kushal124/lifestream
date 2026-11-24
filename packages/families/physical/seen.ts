import { addDays, type BlobReader, type Head, type RecordRef, type SourceRow, type Version, type View } from "@lifestreamprotocol/core";
import type { Change, Touched } from "../family.js";
import { cameraOf, CAMERA_PHOTO_KIND, CAMERAS_SOURCES, copyOf, joinedOf, namingCopies, placeOf, routesOf, type Copy, type PhotoRoutes, type Route } from "../photos/read.js";
import type { Point } from "../shared/places.js";
import { compare, owned, parseUnit, pointOf, unitName, type Said, type SeenContent, type Photo } from "./evidence.js";
import type { Witness } from "./witnesses.js";

const PHOTO_KIND = "img";
const PHOTO_FILE_KIND = "img-file";
const PAIRED = "phone/";
const DAY_MS = 86_400_000;

export function photoWitness(routes: PhotoRoutes): Witness {
  return {
  name: "Photos",
  rank: 20,
  how: "seen",
  inputs: [
    { sources: routes.sources, kinds: [PHOTO_KIND, PHOTO_FILE_KIND], role: "evidence" },
    { sources: CAMERAS_SOURCES, kinds: [CAMERA_PHOTO_KIND], role: "labels" },
  ],
  owns: (unit) => owned(unit, ["seen"], routes.sources),

  touched(changes: readonly Change[], view: View): Touched[] {
    const units = new Set<string>();
    const add = (record: RecordRef, version: Version) => {
      const at = placeOf(view, routes, record, version);
      if (at !== null) units.add(seenUnit(record.source, at.at_ms));
    };
    const photo = (copy: Copy | null) => {
      if (copy === null) return;
      for (const { copy: each } of joinedOf(view, routes, copy).copies) {
        for (const record of each.records) add(record, view.version(view.head(record)!.version));
      }
    };
    for (const change of changes) {
      if (view.source(change.record.source)?.product === "cameras") {
        namingCopies(view, routes, change.record.key).forEach(photo);
        continue;
      }
      if (change.before !== undefined) add(change.record, change.before);
      photo(copyOf(view, routes, change.record));
    }
    return [...units].sort(compare).map((unit) => ({ unit }));
  },

  extract(unit: string, view: View, files: BlobReader): Said<SeenContent> | null {
    const { source, rest: date } = parseUnit(unit);
    const start = /^\d{4}-\d{2}-\d{2}$/u.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;
    const row = view.source(source);
    if (!Number.isFinite(start) || row === undefined || addDays(date, 0) !== date) return null;
    const photos = photosOn(view, routes, files, row, start, start + DAY_MS)
      .sort((left, right) => left.at_ms - right.at_ms || compare(left.key, right.key)).map(({ key, ...photo }) => photo);
    if (photos.length === 0) return null;
    return { kind: "seen", source, date, start_ms: photos[0]!.at_ms, end_ms: photos.at(-1)!.at_ms, photos };
  },
  };
}

function seenUnit(source: string, at_ms: number): string {
  return unitName("seen", source, new Date(at_ms).toISOString().slice(0, 10));
}

function photosOn(view: View, routes: PhotoRoutes, files: BlobReader, row: SourceRow, lo: number, hi: number): (Photo & { key: string })[] {
  const source = row.id;
  const route = routesOf(view, routes).get(source);
  if (route === undefined) return [];
  const photos: (Photo & { key: string })[] = [];
  for (const { head, version } of view.records(source, PHOTO_KIND, { start_ms: lo, end_ms: hi })) {
    if (head.start_ms === null || head.start_ms < lo || head.start_ms >= hi) continue;
    const stated = route.adapter.position(version);
    if (stated === null) continue;
    let point = stated.position === null ? null : pointOf(stated.position.latitude, stated.position.longitude);
    const accuracy_m = point === null ? null : stated.position?.accuracy_m ?? null;
    let images: string[];
    let key = head.key;
    if (route.library) {
      const copy = copyOf(view, routes, head);
      if (copy === null || copy.records[0]!.key !== head.key) continue;
      images = joinedOf(view, routes, copy).copies.filter(({ rung }) => rung <= 2).flatMap(({ copy: each }) => each.files);
      key = copy.id;
    } else {
      images = image(view, routes, head, version);
    }
    const label = cameraOf(view, images);
    point ??= label?.gps ? pointOf(label.gps.latitude, label.gps.longitude) : null;
    if (point === null) continue;
    photos.push({ key, at_ms: head.start_ms, point, accuracy_m, camera: label?.camera ?? paired(route, images, files) });
  }
  return photos;
}

function image(view: View, routes: PhotoRoutes, head: Head, version: Version): string[] {
  const placed = placeOf(view, routes, head, version);
  return placed === null || placed.sha256 === null ? [] : [placed.sha256];
}

function paired(route: Route, images: readonly string[], files: BlobReader): string | null {
  return route.adapter.paired?.(route.row) === true && !images.some((hex) => files.has(`sha256:${hex}`)) ? `${PAIRED}${route.row.copy}` : null;
}
