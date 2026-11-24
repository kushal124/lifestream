import type { BlobReader, Json, RecordRef } from "@lifestreamprotocol/connect/sdk";
import { BlobError, readExif, versionId, type OpenView, type SourceSelector } from "@lifestreamprotocol/core";
import { cameraId } from "../../shared/exif.js";
import { phonePhoto, photoImage, photoInputs, type PhotoAdapters } from "../../shared/photo-image.js";
import type { Labeler, LabelSince } from "../../labeler.js";
import { CAMERA_KIND, CAMERAS_FILE, camerasConnector, camerasLine, PHOTO_KIND, type Camera, type CameraPhoto } from "./reader.js";

const REREAD_PAGE = 500;
const PAIRED = "phone/";

export interface CamerasSettings {
  unit: string;
  photos: PhotoAdapters;
}

interface Photos {
  adapters: PhotoAdapters;
  sources: SourceSelector;
  kinds: readonly string[];
}

interface Named {
  taken_ms: number | null;
  phones: Set<string>;
}

interface Census {
  images: Map<string, Named>;
  imageOf: Map<string, string>;
  unheld: Map<string, Map<string, number | null>>;
}

export function camerasLabeler(settings: CamerasSettings): Labeler {
  const source = `cameras:local:${settings.unit}`;
  const reading: Photos = { adapters: settings.photos, ...photoInputs(settings.photos) };
  return {
    name: "cameras",
    source,
    inputs: [{ sources: reading.sources, kinds: [...reading.kinds] }],
    reading: { code: "1", borrows: ["photos"] },

    async label(view: OpenView, blobs: BlobReader, since: LabelSince, signal?: AbortSignal) {
      const whole = since.seq === 0 || repairedSince(view, since.seq, source);
      const moves = whole ? null : moved(view, reading, since);
      if (moves !== null && moves.records.size === 0 && !moves.erased) return null;
      const census = readCensus(view, reading, blobs);
      const photos = new Map([...view.records(source, PHOTO_KIND)].map(({ head, version }) => [head.key, { version: head.version, camera: (version.content as unknown as CameraPhoto).camera }]));
      const cameras = new Map([...view.records(source, CAMERA_KIND)].map(({ head, version }) => [head.key, { version: head.version, content: version.content as unknown as Camera }]));
      const owed = whole ? [...census.images.keys()].sort()
        : [...new Set([...moves!.records].flatMap((record) => census.imageOf.get(record) ?? []))].filter((hex) => !photos.has(hex)).sort();

      await Promise.resolve();
      const read = new Map<string, { content: CameraPhoto; make: string; model: string } | null>();
      for (const hex of owed) {
        signal?.throwIfAborted();
        const exif = exifOf(blobs, hex);
        const camera = cameraId(exif?.make, exif?.model);
        read.set(hex, camera === null ? null : {
          content: { type: "cameras.photo", camera, ...(exif?.gps === undefined ? {} : { gps: exif.gps }) },
          make: trim(exif!.make!), model: trim(exif!.model!),
        });
      }

      const lines: string[] = [];
      const standing = new Map<string, string>();
      for (const [hex, held] of photos) if (census.images.has(hex) && !read.has(hex)) standing.set(hex, held.camera);
      for (const [hex, found] of read) {
        if (found !== null) standing.set(hex, found.content.camera);
        if (found !== null && photos.get(hex)?.version !== versionId(PHOTO_KIND, hex, found.content as unknown as Json).id) lines.push(camerasLine(PHOTO_KIND, hex, found.content));
      }
      for (const hex of photos.keys()) if (!standing.has(hex)) lines.push(camerasLine(PHOTO_KIND, hex, "gone"));
      const stated = lines.length;

      const tallies = new Map<string, Tally>();
      const tally = (camera: string) => tallies.get(camera) ?? tallies.set(camera, { photos: 0, first_ms: null, last_ms: null, sample: null, phones: new Set() }).get(camera)!;
      for (const [hex, camera] of standing) count(tally(camera), census.images.get(hex)!.taken_ms, hex);
      for (const [unit, camera] of phoneCameras(standing, census)) tally(camera).phones.add(unit);
      for (const [camera, taken] of census.unheld) for (const taken_ms of taken.values()) count(tally(camera), taken_ms, null);
      const spelled = new Map<string, { make: string | null; model: string | null }>();
      for (const [, found] of [...read].sort(([left], [right]) => compare(left, right))) if (found !== null && !spelled.has(found.content.camera)) spelled.set(found.content.camera, { make: found.make, model: found.model });
      for (const [camera, held] of cameras) spelled.set(camera, { make: held.content.make, model: held.content.model });
      for (const [camera, counted] of [...tallies].sort(([left], [right]) => compare(left, right))) {
        const name = spelled.get(camera) ?? { make: null, model: null };
        const content: Camera = {
          type: "cameras.camera", ...name, photos: counted.photos, first_ms: counted.first_ms, last_ms: counted.last_ms,
          sample: counted.sample === null ? null : `sha256:${counted.sample.hex}`, phones: [...counted.phones].sort(compare),
        };
        if (cameras.get(camera)?.version !== versionId(CAMERA_KIND, camera, content as unknown as Json).id) lines.push(camerasLine(CAMERA_KIND, camera, content));
      }
      for (const camera of cameras.keys()) if (!tallies.has(camera)) lines.push(camerasLine(CAMERA_KIND, camera, "gone"));

      if (lines.length === 0) return null;
      return {
        files: [{ path: CAMERAS_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }],
        facts: { whole, read: owed.length, photos: stated, cameras: lines.length - stated, sources: [{ id: source, connector: camerasConnector.name }] },
      };
    },
  };
}

function repairedSince(view: OpenView, after: number, source: string): boolean {
  for (const statement of view.statements(after, { sources: [source] })) if (statement.origin === "repair") return true;
  return false;
}

interface Tally {
  photos: number;
  first_ms: number | null;
  last_ms: number | null;
  sample: { at_ms: number | null; hex: string } | null;
  phones: Set<string>;
}

function phoneCameras(standing: ReadonlyMap<string, string>, census: Census): Map<string, string> {
  const taken = new Map<string, Map<string, number>>();
  for (const [hex, camera] of standing) {
    for (const unit of census.images.get(hex)!.phones) {
      const cameras = taken.get(unit) ?? taken.set(unit, new Map()).get(unit)!;
      cameras.set(camera, (cameras.get(camera) ?? 0) + 1);
    }
  }
  return new Map([...taken].map(([unit, cameras]) => [unit, [...cameras].sort(([left, many], [right, more]) => more - many || compare(left, right))[0]![0]]));
}

function count(tally: Tally, taken_ms: number | null, hex: string | null): void {
  tally.photos++;
  if (taken_ms !== null) {
    tally.first_ms = tally.first_ms === null ? taken_ms : Math.min(tally.first_ms, taken_ms);
    tally.last_ms = tally.last_ms === null ? taken_ms : Math.max(tally.last_ms, taken_ms);
  }
  if (hex === null) return;
  const sample = tally.sample;
  const later = (at: number | null, than: number | null) => (at ?? -Infinity) > (than ?? -Infinity);
  if (sample === null || later(taken_ms, sample.at_ms) || (taken_ms === sample.at_ms && compare(hex, sample.hex) < 0)) tally.sample = { at_ms: taken_ms, hex };
}

function moved(view: OpenView, photos: Photos, since: LabelSince): { records: Set<string>; erased: boolean } {
  const inputs = new Set(view.sources(photos.sources).map((row) => row.id));
  const records = new Set<string>();
  const note = (record: RecordRef) => {
    if (inputs.has(record.source) && photos.kinds.includes(record.kind)) records.add(`${record.source}\0${record.key}`);
  };
  for (const statement of view.statements(since.seq, { sources: [...inputs], kinds: [...photos.kinds] })) note(statement);
  let erased = false;
  for (let after = since.reread; ;) {
    const page = view.rereads(after, REREAD_PAGE);
    for (const reread of page) {
      if ("record" in reread) note(reread.record);
      else erased = true;
    }
    if (page.length < REREAD_PAGE) break;
    after = page.at(-1)!.seq;
  }
  return { records, erased };
}

function readCensus(view: OpenView, photos: Photos, blobs: BlobReader): Census {
  const census: Census = { images: new Map(), imageOf: new Map(), unheld: new Map() };
  for (const row of view.sources(photos.sources)) {
    const phone = new Map<string, { held: boolean; taken_ms: number | null }>();
    for (const kind of photos.kinds) {
      for (const { head, version } of view.records(row.id, kind)) {
        const hex = photoImage(view, photos.adapters, row, head, version);
        const held = hex !== null && blobs.has(`sha256:${hex}`);
        const own = phonePhoto(view, photos.adapters, row, head, version.content);
        const taken_ms = own?.taken_ms ?? head.start_ms;
        if (own !== null) {
          const photo = phone.get(own.photo);
          phone.set(own.photo, { held: held || photo?.held === true, taken_ms: earliest(photo?.taken_ms ?? null, taken_ms) });
        }
        if (!held) continue;
        census.imageOf.set(`${row.id}\0${head.key}`, hex);
        const named = census.images.get(hex);
        const phones = named?.phones ?? new Set<string>();
        if (own !== null) phones.add(row.copy);
        census.images.set(hex, { taken_ms: earliest(named?.taken_ms ?? null, taken_ms), phones });
      }
    }
    const unheld = [...phone].filter(([, photo]) => !photo.held);
    if (unheld.length === 0) continue;
    const camera = `${PAIRED}${row.copy}`;
    const taken = census.unheld.get(camera) ?? new Map<string, number | null>();
    for (const [photo, { taken_ms }] of unheld) taken.set(`${row.id}\0${photo}`, taken_ms);
    census.unheld.set(camera, taken);
  }
  return census;
}

function exifOf(blobs: BlobReader, hex: string): ReturnType<typeof readExif> {
  try {
    return readExif((bytes) => blobs.prefix(`sha256:${hex}`, bytes));
  } catch (error) {
    if (error instanceof BlobError && error.code === "BLOB_NOT_FOUND") return undefined;
    throw error;
  }
}

function earliest(known: number | null, at_ms: number | null): number | null {
  return known === null ? at_ms : at_ms === null ? known : Math.min(known, at_ms);
}

function trim(value: string): string {
  return value.replace(/^[\s\0]+|[\s\0]+$/gu, "");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
