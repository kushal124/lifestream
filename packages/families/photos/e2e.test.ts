import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { digest, piecesText, type Ask, type DaySettings, type ExtractRow, type Json, type OpenView, type ReaderOutput } from "@lifestreamprotocol/core";
import { checkDayFile, renderDay, tableUnits, type DayDocument } from "../days.js";
import type { Family } from "../family.js";
import { photoWitness } from "../physical/seen.js";
import { buildLabels } from "../shared/labels.js";
import { PHOTO_CAPTION, PHOTO_CAPTION_PROMPT, photographsOf, photosFamily, type BurstContent } from "./family.js";
import { cameraOf, copyOf, joinedOf, PhotoRoutes } from "./read.js";
import { wanted } from "./wanted.js";
import { askKey, dayReader, FakeLedger, inputHash, ROUTE, sha256, shuffled, TestHome } from "../test/drive.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { conforming } from "../test/units.js";

const GOLDEN_DIR = new URL("./test/golden/", import.meta.url);
const GOLDEN = JSON.parse(readFileSync(new URL("photo-caption-v9.golden.json", GOLDEN_DIR), "utf8")) as {
  runtime: { model: string; effort: string; sampling: { temperature: number } };
  photos: {
    name: string;
    original: { file: string; sha256: string };
    faces: { name: string; box: number[] }[];
    request: { model: string; prompt_hash: string; input_hash: string; body: string; attachments: { kind: string; sha256: string; extension: string }[] };
  }[];
};
const golden = (name: string) => GOLDEN.photos.find((photo) => photo.name === name)!;
const facesOf = (name: string): Face[] => golden(name).faces.map(({ name: shown, box }) => (shown === "" ? { box } : { name: shown, box }));
const drawnOver = (faces: readonly Face[]) => faces.map(({ box: [x1, y1, x2, y2] }, index) => ({ placeholder: `[[Person ${index + 1}]]`, box: { x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! } }));
const goldenBytes = (file: string) => readFileSync(new URL(file, GOLDEN_DIR));

const PHONE = "iphone-aa01";
const GOOGLE = "google-photos:person-a@example.com:export";
const GOOGLE_TWO = "google-photos:person-a@example.com:export-two";
const APPLE = `apple-photos:person-a@example.com:${PHONE}`;
const FACES = "faces:local:macbook-pro-0001";
const CAMERAS = "cameras:local:macbook-pro-0001";
const IN_APP = `camera:local:${PHONE}`;
const CAMERA = "synthetic/synthetic-camera";
const SETTINGS: DaySettings = { zone: "Asia/Kolkata", day_start_hour: 4 };
const NOON = Date.UTC(2026, 8, 5, 6, 30);
const family = photosFamily({ faces: true })(FED.photos);
const unfaced = photosFamily({ faces: false })(FED.photos);
const caption = (ask: Ask) => {
  const drawn = ask.attachments?.[0]?.drawn ?? [];
  return JSON.stringify({
    caption: `A synthetic caption of ${ask.item.slice(6, 14)}${drawn.map((face) => `, beside ${face.placeholder}`).join("")}.`,
    faces: drawn.map((face) => ({ placeholder: face.placeholder, who: "a person" })),
  });
};

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});
function home(): TestHome {
  const opened = new TestHome("lifestream-photos-");
  homes.push(opened);
  opened.addSource(APPLE, "photos-ios-bundle");
  return opened;
}

const burstUnit = (at_ms: number) => `burst/${at_ms}`;

function jpeg(tag: string, camera: boolean): Buffer {
  const tiff = camera ? cameraTiff() : Buffer.alloc(0);
  const app1 = camera ? segment(0xe1, Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff])) : Buffer.alloc(0);
  const comment = segment(0xfe, Buffer.from(tag, "utf8"));
  const sof = segment(0xc0, Buffer.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, comment, sof, Buffer.from([0xff, 0xd9])]);
}

function segment(marker: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, marker, 0, 0]);
  head.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([head, body]);
}

function cameraTiff(): Buffer {
  const tiff = Buffer.alloc(64);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(271, 10);
  tiff.writeUInt16LE(2, 12);
  tiff.writeUInt32LE(17, 14);
  tiff.writeUInt32LE(32, 18);
  tiff.write("Synthetic Camera\0", 32, "latin1");
  return tiff;
}

interface Photo { bytes: Buffer; sha: string; at_ms: number; camera: boolean }
function photo(tag: string, at_ms: number, camera = true): Photo {
  const bytes = jpeg(tag, camera);
  return { bytes, sha: sha256(bytes), at_ms, camera };
}

function cameraRows(items: readonly Photo[], camera = CAMERA): ReaderOutput[] {
  return items.filter((item) => item.camera).map((item) => cameraRow(item.sha, camera));
}

function cameraRow(sha: string, camera = CAMERA, gps?: { latitude: number; longitude: number }): ReaderOutput {
  return { kind: "photo", key: sha, content: { type: "cameras.photo", camera, ...(gps === undefined ? {} : { gps }) } };
}

function put(target: TestHome, bytes: Buffer): string {
  return target.blobs.put(bytes, { mediaType: "image/jpeg" });
}

function googleRow(target: TestHome, item: Photo, fields: Record<string, string> = {}): ReaderOutput {
  const hash = put(target, item.bytes);
  return {
    kind: "img", key: item.sha, time: { start_ms: item.at_ms, precision: "s" },
    content: {
      type: "photos.asset", title: `${item.sha.slice(0, 8)}.jpg`, photoTakenTime: { timestamp: String(Math.floor(item.at_ms / 1000)) }, ...fields,
      blobs: [{ hash, bytes: item.bytes.length, media_type: "image/jpeg", role: "original" }],
    },
    blobs: [hash],
  };
}

function inAppRow(target: TestHome, item: Photo, key: string): ReaderOutput {
  const blob = put(target, item.bytes);
  return {
    kind: "img", key, time: { start_ms: item.at_ms, precision: "ms" }, blobs: [blob],
    content: { type: "camera.photo", content: { payload: { blob: { hash: blob, type: "image/jpeg" } } } },
  };
}

function appleRow(target: TestHome, item: Photo, local: string, modified: string, extra: { favorite?: boolean; hidden?: boolean; adjustment?: Buffer; reason?: string; missing?: boolean } = {}): ReaderOutput {
  const hash = put(target, item.bytes);
  const video = extra.missing === true || extra.reason !== undefined ? null : target.blobs.put(Buffer.from(`synthetic live photo video of ${local}`));
  const resources = [
    extra.missing === true
      ? { type: "photo", type_raw: 1, uti: "public.jpeg", original_filename: "IMG_0001.JPG", blob: null, not_local: true, not_local_reason: "icloud" }
      : { type: "photo", type_raw: 1, uti: "public.jpeg", original_filename: "IMG_0001.JPG", blob: { hash, type: "image/jpeg", bytes: item.bytes.length, role: "original" } },
    video === null
      ? { type: "pairedVideo", type_raw: 9, uti: "com.apple.quicktime-movie", original_filename: "IMG_0001.MOV", blob: null, not_local: true, not_local_reason: extra.reason ?? "icloud" }
      : { type: "pairedVideo", type_raw: 9, uti: "com.apple.quicktime-movie", original_filename: "IMG_0001.MOV", blob: { hash: video, type: "video/quicktime", bytes: 1, role: "paired_video" } },
    ...(extra.adjustment === undefined ? [] : [{
      type: "adjustmentData", type_raw: 7, uti: "com.apple.adjustment", original_filename: "Adjustments.plist",
      blob: { hash: target.blobs.put(extra.adjustment), type: "application/octet-stream", bytes: extra.adjustment.length, role: "adjustment_data" },
    }]),
  ];
  return {
    kind: "img", key: `${local}:${modified}`, time: { start_ms: item.at_ms, precision: "ms" },
    content: {
      type: "photos.apple.asset",
      content: {
        local_identifier: local, media_type: "image", media_type_raw: 1, media_subtypes: [], media_subtypes_raw: 0,
        creation_date: new Date(item.at_ms).toISOString(), modification_date: modified, pixel_width: 16, pixel_height: 16, duration: null,
        is_favorite: extra.favorite ?? false, is_hidden: extra.hidden ?? false, source_type: "user_library", source_type_raw: 1,
        burst_identifier: null, represents_burst: false, resources, location: null,
      },
    },
    blobs: [...(extra.missing === true ? [] : [hash]), ...(video === null ? [] : [video])],
  };
}

function availabilityRow(target: TestHome, local: string, modified: string, captured_ms: number, resources: { type: "photo" | "fullSizePhoto"; item: Photo }[]): ReaderOutput {
  const video = Buffer.from(`synthetic live photo video of ${local}`);
  const stated = [...resources.map(({ type, item }) => ({
    type, type_raw: type === "photo" ? 1 : 5, uti: "public.jpeg", original_filename: type === "photo" ? "IMG_0001.JPG" : "FullSizeRender.jpg",
    blob: { hash: put(target, item.bytes), type: "image/jpeg", bytes: item.bytes.length, role: type === "photo" ? "original" : "full_size_photo" },
  })), {
    type: "pairedVideo", type_raw: 9, uti: "com.apple.quicktime-movie", original_filename: "IMG_0001.MOV",
    blob: { hash: target.blobs.put(video), type: "video/quicktime", bytes: video.length, role: "paired_video" },
  }];
  const tuples = [...new Set(stated.map((resource) => JSON.stringify([resource.type_raw, resource.uti, resource.original_filename, resource.blob.hash])))].sort();
  return {
    kind: "img-file", key: `${local}:${modified}:sha256:${sha256(`[${tuples.join(",")}]`)}`, time: { start_ms: captured_ms, precision: "ms" },
    content: {
      type: "photos.apple.availability",
      content: { snapshot_replay_key: `photos:${local}:${modified}`, local_identifier: local, modification_date: modified, resources: stated },
    },
    blobs: stated.map((resource) => resource.blob.hash),
  };
}

type Face = { box: number[]; name?: string };

function modelImageRow(sha: string, faces: Face[] = []): ReaderOutput {
  return {
    kind: "model-image", key: sha,
    content: { faces: faces.map(({ box }) => ({ box })), names: faces.map(({ name }) => (name === undefined ? null : { who: `person:${name.toLowerCase().replace(/ /gu, "-")}`, shown: name })) },
  };
}

function countingRangeReads(view: OpenView): { counted: OpenView; reads: () => number; rows: () => number } {
  let reads = 0;
  let rows = 0;
  const counted = new Proxy(view, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (property !== "heads") return (value as (...args: unknown[]) => unknown).bind(target);
      return (...args: unknown[]) => {
        const heads = (value as (...args: unknown[]) => Iterable<unknown>).apply(target, args);
        if (args[2] === undefined) return heads;
        reads++;
        return (function* () {
          for (const head of heads) {
            rows++;
            yield head;
          }
        })();
      };
    },
  });
  return { counted, reads: () => reads, rows: () => rows };
}

function countingRows(view: OpenView): { counted: OpenView; rows: () => number } {
  let rows = 0;
  const counted = new Proxy(view, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const result = (value as (...args: unknown[]) => unknown).apply(target, args);
        if (Array.isArray(result)) rows += result.length;
        else if (result !== null && typeof result === "object" && Symbol.iterator in result) {
          return (function* () {
            for (const item of result as Iterable<unknown>) {
              rows++;
              yield item;
            }
          })();
        } else if (result !== null && typeof result === "object") rows++;
        return result;
      };
    },
  });
  return { counted, rows: () => rows };
}

function extractsAlike(target: TestHome): void {
  expect(unfaced.code).toBe(family.code);
  for (const row of bursts(target)) {
    expect(target.read((view) => unfaced.extract(row.unit, view, target.blobs))).toEqual(target.read((view) => family.extract(row.unit, view, target.blobs)));
  }
}

function extracts(target: TestHome): ExtractRow[] {
  return target.read((view) => [...view.extracts("photos")]).sort((left, right) => left.unit < right.unit ? -1 : 1);
}

function bursts(target: TestHome): ExtractRow[] {
  return extracts(target).filter((row) => row.unit.startsWith("burst/"));
}

function comparable(rows: ExtractRow[]) {
  return rows.map(({ unit, reading, content, days, start_ms, end_ms }) => ({ unit, reading, content, days, start_ms, end_ms }));
}

let clock = NOON;
const next = () => (clock += 1_000);

describe("the photos family: each way it could fail, written before the code", () => {
  it("an extract is written when only an unread field ticked (Photos library favourites, edit counters, iCloud state…)", () => {
    const target = home();
    const a = photo("apple-1", NOON);
    const g = photo("google-1", NOON + 3_600_000);
    const d = photo("takeout-two-1", NOON + 7_200_000);
    target.land(APPLE, next(), [appleRow(target, a, "SYNTH-0001/L0/001", "2026-09-05T06:30:00.000Z", { reason: "icloud" })]);
    target.land(GOOGLE, next(), [googleRow(target, g)]);
    target.land(GOOGLE_TWO, next(), [googleRow(target, d, { title: "Synthetic.jpg" })]);
    target.land(FACES, next(), [a, g, d].map((item) => modelImageRow(item.sha)));
    target.land(CAMERAS, next(), cameraRows([a, g, d]));
    const first = target.extractPass(family, SETTINGS);
    expect(first.written.length).toBe(7);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, family, caption).asked.map((ask) => ask.item).sort()).toEqual([`photo:${g.sha}`, `photo:${d.sha}`].sort());
    const before = comparable(bursts(target));

    target.land(APPLE, next(), [appleRow(target, a, "SYNTH-0001/L0/001", "2026-09-05T06:30:00.000Z", { favorite: true, hidden: true, reason: "network", adjustment: Buffer.from("synthetic adjustment") })]);
    target.land(APPLE, next(), [appleRow(target, a, "SYNTH-0001/L0/001", "2026-09-06T08:00:00.000Z", { favorite: true, reason: "network" })]);
    target.land(GOOGLE, next(), [googleRow(target, g, { description: "synthetic" })]);
    target.land(GOOGLE_TWO, next(), [googleRow(target, d, { title: "Renamed.jpg" })]);
    target.land(FACES, next(), [
      { kind: "faces", key: a.sha, content: { width: 16, height: 16, faces: [{ face_id: "f1", box: [1, 1, 4, 4], person: "" }] } },
      ...[a, g, d].map((item) => modelImageRow(item.sha)),
    ]);
    target.land(CAMERAS, next(), cameraRows([a, g, d]));
    const ticked = target.extractPass(family, SETTINGS);
    expect(ticked.touched.length).toBeGreaterThan(0);
    expect(ticked.written).toEqual(["photo/" + APPLE + "/SYNTH-0001/L0/001"]);
    expect(ticked.deleted).toEqual([]);
    expect(comparable(bursts(target))).toEqual(before);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    target.artifact("unread-ticks", { first, ticked, extracts: before });
  });

  it("a long burst is read once per gap, or once per photo that names it: its range reads grow with its length", () => {
    const target = home();
    const items = Array.from({ length: 400 }, (_, index) => photo(`long-burst-${index}`, NOON + index * 30_000));
    target.land(APPLE, next(), items.map((item, index) => appleRow(target, item, `SYNTH-LONG/L0/${String(index).padStart(3, "0")}`, "2026-09-05T06:30:00.000Z")));
    const head = burstUnit(NOON);
    const measured = target.read((view) => {
      const { counted, reads } = countingRangeReads(view);
      const record = { source: APPLE, kind: "img", key: "SYNTH-LONG/L0/200:2026-09-05T06:30:00.000Z" };
      const after = counted.version(counted.head(record)!.version)!;
      const touched = family.touched([{ record, after }], counted);
      const afterTouched = reads();
      expect(touched.map((unit) => unit.unit)).toContain(head);
      const extracted = family.extract(head, counted, target.blobs);
      expect((extracted!.content as { photos: unknown[] }).photos.length).toBe(400);
      return { touched: afterTouched, extract: reads() - afterTouched };
    });
    expect(measured.touched).toBeLessThan(40);
    expect(measured.extract).toBeLessThan(10);
    target.artifact("long-burst", { photos: items.length, range_reads: measured });
  });

  it("the faces labeler's chunk over a dense library reads each photo once and each minute of it in one seek, whichever photo's seek reaches it first: a change costs itself, not the changes before it", () => {
    const target = home();
    const items = Array.from({ length: 240 }, (_, index) => photo(`dense-${index}`, NOON + index * 5_000));
    target.land(APPLE, next(), items.map((item, index) => appleRow(target, item, `SYNTH-DENSE/L0/${String(index).padStart(3, "0")}`, "2026-09-05T06:30:00.000Z")));
    target.land(FACES, next(), items.map((item) => modelImageRow(item.sha)));
    const minutes = Math.floor((items.at(-1)!.at_ms - NOON) / 60_000) + 1;
    const measured = target.read((view) => {
      const { counted, reads, rows } = countingRangeReads(view);
      const changes = [...view.heads(FACES, "model-image")].map((head) => ({ record: { source: FACES, kind: "model-image", key: head.key }, after: view.version(head.version)! }));
      const units = family.touched(changes, counted).map((unit) => unit.unit);
      return { changes: changes.length, reads: reads(), rows: rows(), bursts: units.filter((unit) => unit.startsWith("burst/")) };
    });
    expect(measured).toEqual({ changes: items.length, reads: expect.any(Number) as number, rows: items.length, bursts: [burstUnit(NOON)] });
    expect(measured.reads).toBeLessThanOrEqual(minutes + 2);
    target.artifact("dense-chunk", { photos: items.length, minutes, ...measured });
  });

  it("a photo whose file arrives after its snapshot (an `img-file`, its own kind) is missing from its burst, or moves its burst when its file and its camera arrive; an edit whose render it shows, the labeler naming only its original, is not a photograph", () => {
    const target = home();
    const late = photo("late-bytes", NOON);
    const neighbour = photo("late-neighbour", NOON + 20_000);
    const edit = photo("late-edit", NOON);
    const LOCAL = "SYNTH-LATE/L0/001";
    const MODIFIED = "2026-09-05T06:30:00.000Z";
    const unit = burstUnit(NOON);
    const shown = () => (bursts(target)[0]!.content as { photos: { sha256: string | null; at_ms: number; kind: string | null }[] }).photos.map((each) => [each.sha256, each.at_ms, each.kind]);
    target.land(APPLE, next(), [appleRow(target, late, LOCAL, MODIFIED, { missing: true }), appleRow(target, neighbour, "SYNTH-LATE/L0/002", MODIFIED)]);
    target.land(FACES, next(), [late, neighbour, edit].map((item) => modelImageRow(item.sha)));
    target.land(CAMERAS, next(), cameraRows([neighbour]));
    target.extractPass(family, SETTINGS);
    expect(bursts(target).map((row) => row.unit)).toEqual([unit]);
    expect(shown()).toEqual([[null, NOON, null], [neighbour.sha, NOON + 20_000, "photograph"]]);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, family, caption).asked.map((ask) => ask.item)).toEqual([`photo:${neighbour.sha}`]);

    target.land(APPLE, next(), [availabilityRow(target, LOCAL, MODIFIED, NOON + 2 * 86_400_000, [{ type: "photo", item: late }])]);
    target.land(CAMERAS, next(), cameraRows([late]));
    const fetched = target.extractPass(family, SETTINGS);
    expect(fetched.deleted).toEqual([`wanted/${APPLE}/${LOCAL}`]);
    expect(bursts(target).map((row) => row.unit)).toEqual([unit]);
    expect(shown()).toEqual([[late.sha, NOON, "photograph"], [neighbour.sha, NOON + 20_000, "photograph"]]);
    expect(ledger.settle(target, family, caption).asked.map((ask) => ask.item)).toEqual([`photo:${late.sha}`]);

    target.land(APPLE, next(), [availabilityRow(target, LOCAL, MODIFIED, NOON + 3 * 86_400_000, [{ type: "photo", item: late }, { type: "fullSizePhoto", item: edit }])]);
    const edited = target.extractPass(family, SETTINGS);
    expect(edited.deleted).toEqual([]);
    expect(shown()[0]).toEqual([edit.sha, NOON, "photograph"]);
    expect(ledger.settle(target, family, caption).asked.map((ask) => ask.item)).toEqual([`photo:${edit.sha}`]);
    target.artifact("late-bytes", { fetched, edited, extracts: comparable(extracts(target)) });
  });

  it("undoing the import of an asset whose bytes an availability brought leaves its burst and caption", () => {
    const target = home();
    const shown = photo("undo-asset", NOON);
    const LOCAL = "SYNTH-UNDO/L0/001";
    const MODIFIED = "2026-09-05T06:30:00.000Z";
    target.land(APPLE, next(), [appleRow(target, shown, LOCAL, MODIFIED, { missing: true })]);
    target.land(APPLE, next(), [availabilityRow(target, LOCAL, MODIFIED, NOON + 86_400_000, [{ type: "photo", item: shown }])]);
    target.land(FACES, next(), [modelImageRow(shown.sha)]);
    target.land(CAMERAS, next(), cameraRows([shown]));
    target.extractPass(family, SETTINGS);
    const unit = burstUnit(NOON);
    expect(bursts(target).map((row) => row.unit)).toEqual([unit]);
    expect(new FakeLedger(ROUTE).settle(target, family, caption).asked.map((ask) => ask.item)).toEqual([`photo:${shown.sha}`]);
    const day = (): string => target.read((view) => conforming(renderDay("2026-09-05", [family], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))))).txt;
    expect(day()).toContain("Photo: A synthetic caption");

    const record = { source: APPLE, kind: "img", key: `${LOCAL}:${MODIFIED}` };
    const plan = target.read((view) => view.planUndo(view.history(record)[0]!.run!));
    target.db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "undo", subject: "the asset's import", started_ms: next() }), plan, { has: () => true }));
    const undone = target.extractPass(family, SETTINGS);
    expect(undone.deleted).toEqual([unit, `photo/${APPLE}/${LOCAL}`]);
    expect(extracts(target)).toEqual([]);
    expect(day()).not.toContain("Photo");
    target.artifact("undo-asset", { undone, day: day() });
  });

  it("one connector's adapter that throws ranking its source fails the read of every other connector's photos beside it", () => {
    const google = FED.photos.find((each) => each.product === "google-photos")!;
    const broken = { ...google, product: "broken-photos", name: "Broken", adapter: { ...google.adapter, rank: () => { throw new Error("synthetic rank failure"); } } };
    const over = photosFamily({ faces: false })([...FED.photos, broken]);
    const target = home();
    const kept = photo("rank-kept", NOON);
    target.land(GOOGLE, next(), [googleRow(target, kept)]);
    target.land("broken-photos:person-a@example.com:export", next(), [googleRow(target, photo("rank-broken", NOON + 10_000))]);
    const read = target.read((view) => {
      const record = { source: GOOGLE, kind: "img", key: kept.sha };
      const units = over.touched([{ record, after: view.version(view.head(record)!.version)! }], view);
      return units.map((unit) => [unit.unit, over.extract(unit.unit, view, target.blobs) === null ? "none" : "built"]);
    });
    expect(read).toContainEqual([burstUnit(NOON), "built"]);
  });

  it("one photo's chunk reads the whole library", () => {
    const measure = (size: number) => {
      const target = home();
      const library = Array.from({ length: size }, (_, index) => photo(`library-${size}-${index}`, NOON - (index + 1) * 3_600_000));
      target.land(APPLE, next(), library.map((item, index) => appleRow(target, item, `SYNTH-LIB/L0/${index}`, "2026-09-05T06:30:00.000Z")));
      const fresh = photo(`fresh-${size}`, NOON);
      target.land(GOOGLE, next(), [googleRow(target, fresh)]);
      return target.read((view) => {
        const { counted, rows } = countingRows(view);
        const record = { source: GOOGLE, kind: "img", key: fresh.sha };
        const after = counted.version(counted.head(record)!.version)!;
        const units = family.touched([{ record, after }], counted);
        expect(units.map((unit) => unit.unit)).toContain(burstUnit(NOON));
        for (const unit of units) family.extract(unit.unit, counted, target.blobs);
        return rows();
      });
    };
    const small = measure(20);
    const large = measure(600);
    expect(large).toBe(small);
  });

  it("units differ when the same data arrives in another order, its cameras' records among it", () => {
    const items = {
      x1: photo("x1", NOON), x2: photo("x2", NOON + 40_000), x3: photo("x3", NOON + 80_000),
      x4: photo("x4", NOON + 130_000), x5: photo("x5", NOON + 180_000), x6: photo("x6", NOON + 220_000),
      y1: photo("y1", NOON + 100_000), z1: photo("z1", NOON + 600_000),
    };
    type Step = { source: string; row: (target: TestHome) => ReaderOutput };
    const steps: Step[] = [
      ...(["x1", "x2", "x3", "x4", "x5", "x6"] as const).map((name): Step => ({ source: GOOGLE, row: (target) => googleRow(target, items[name]) })),
      { source: GOOGLE_TWO, row: (target) => googleRow(target, items.y1) },
      { source: GOOGLE, row: (target) => googleRow(target, items.z1) },
      { source: GOOGLE_TWO, row: (target) => googleRow(target, items.z1) },
      ...Object.values(items).map((item): Step => ({ source: FACES, row: () => modelImageRow(item.sha) })),
      ...Object.values(items).map((item): Step => ({ source: CAMERAS, row: () => cameraRow(item.sha, item === items.y1 ? "other/camera" : CAMERA) })),
    ];
    const run = (order: Step[]) => {
      const target = home();
      for (const step of order) {
        target.land(step.source, next(), [step.row(target)]);
        target.extractPass(family, SETTINGS);
      }
      return target;
    };
    const forward = run(steps);
    const backward = run([...steps].reverse());
    const shuffled = run([...steps].sort((left, right) => (sha256(String(steps.indexOf(left))) < sha256(String(steps.indexOf(right))) ? -1 : 1)));
    const units = comparable(extracts(forward));
    const burstsOf = (rows: ReturnType<typeof comparable>) => rows.filter((row) => row.unit.startsWith("burst/"));
    expect(burstsOf(units).map((row) => row.unit)).toEqual([burstUnit(NOON), burstUnit(NOON + 600_000)]);
    expect((burstsOf(units)[0]!.content as { photos: { kind: string }[] }).photos.map((each) => each.kind)).toEqual(Array(7).fill("photograph"));
    expect(comparable(extracts(backward))).toEqual(units);
    expect(comparable(extracts(shuffled))).toEqual(units);

    for (const target of [forward, backward]) {
      target.land(GOOGLE, next(), [{ kind: "img", key: items.x4.sha, content: null, gone: true }]);
      target.extractPass(family, SETTINGS);
    }
    const split = comparable(extracts(forward));
    expect(burstsOf(split).map((row) => row.unit)).toEqual([burstUnit(NOON), burstUnit(NOON + 180_000), burstUnit(NOON + 600_000)]);
    expect(comparable(extracts(backward))).toEqual(split);
    const fresh = run(steps.filter((step) => step !== steps[3]));
    expect(comparable(extracts(fresh))).toEqual(split);
    forward.artifact("orders", { units, split });
    pin(family, { photos: FED.photos }, extracts(forward));
  });

  it("an edit in the phone's library leaves the photo it replaced", () => {
    const target = home();
    const original = photo("edit-original", NOON);
    const edited = photo("edit-rendered", NOON);
    const shows = () => bursts(target).map((row) => [row.unit, (row.content as { photos: { sha256: string }[] }).photos.map((each) => each.sha256)]);
    target.land(APPLE, next(), [appleRow(target, original, "AAAA-0001", "2026-09-05T07:00:00Z")]);
    target.extractPass(family, SETTINGS);
    expect(shows()).toEqual([[burstUnit(NOON), [original.sha]]]);
    target.land(APPLE, next(), [appleRow(target, edited, "AAAA-0001", "2026-09-05T08:00:00Z")]);
    target.extractPass(family, SETTINGS);
    expect(shows()).toEqual([[burstUnit(NOON), [edited.sha]]]);
    target.artifact("edit", comparable(extracts(target)));
  });

  it("the raise to code 13 states on each burst photo the accounts of every record joined into it, and asks no caption again", () => {
    const shared = photo("accounts-1", NOON);
    const own = photo("accounts-2", NOON + 20_000);
    const [before, after] = [home(), home()];
    for (const target of [before, after]) {
      target.land(APPLE, next(), [appleRow(target, shared, "ACCT-0001", "2026-09-05T07:00:00Z")]);
      target.land(GOOGLE, next(), [googleRow(target, shared), googleRow(target, own)]);
      target.land(FACES, next(), [shared, own].map((item) => modelImageRow(item.sha)));
      target.land(CAMERAS, next(), cameraRows([shared, own]));
    }
    const older: Family = {
      ...family, code: "12",
      extract(unit, view, files) {
        const built = family.extract(unit, view, files);
        if (built === null || !unit.startsWith("burst/")) return built;
        const content = { photos: (built.content as unknown as BurstContent).photos.map(({ accounts: _accounts, ...rest }) => rest) } as unknown as Json;
        return { ...built, content, reading: digest(content) };
      },
    };
    before.extractPass(older, SETTINGS);
    after.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(before, older, caption).asked.map((ask) => ask.item).sort()).toEqual([`photo:${shared.sha}`, `photo:${own.sha}`].sort());
    expect(ledger.settle(after, family, caption).asked).toEqual([]);
    const both = ["apple-photos:person-a@example.com", "google-photos:person-a@example.com"];
    expect(bursts(after).map((row) => (row.content as unknown as BurstContent).photos.map((each) => each.accounts))).toEqual([[both, ["google-photos:person-a@example.com"]]]);
    const day = after.read((view) => conforming(renderDay("2026-09-05", [family], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] })))));
    expect((JSON.parse(day.json) as DayDocument).atoms.map((atom) => [atom.item, atom.accounts])).toEqual([[`photo:${shared.sha}`, both], [`photo:${own.sha}`, ["google-photos:person-a@example.com"]]]);
  });

  it("one image is two photos when its copies are an hour apart (which one shows depends on where the read looked)", () => {
    const target = home();
    const shared = photo("one-image", NOON);
    target.land(IN_APP, next(), [inAppRow(target, shared, "camera-1")]);
    target.land(APPLE, next(), [appleRow(target, { ...shared, at_ms: NOON + 3_600_000 }, "BBBB-0001", "2026-09-05T08:00:00Z")]);
    target.extractPass(family, SETTINGS);
    const units = bursts(target).map((row) => row.unit);
    expect(units).toEqual([burstUnit(NOON + 3_600_000)]);
    target.artifact("dedup", units);
  });

  it("an answered item is asked again", () => {
    const target = home();
    const run = [photo("r1", NOON), photo("r2", NOON + 20_000), photo("r3", NOON + 40_000)];
    const twin = photo("twin", NOON + 3_600_000);
    target.land(GOOGLE, next(), [...run.map((item) => googleRow(target, item)), googleRow(target, twin)]);
    target.land(GOOGLE_TWO, next(), [googleRow(target, twin)]);
    target.land(FACES, next(), [...run, twin].map((item) => modelImageRow(item.sha)));
    target.land(CAMERAS, next(), cameraRows([...run, twin]));
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    const first = ledger.settle(target, family, caption);
    expect(first.asked.map((ask) => ask.item).sort()).toEqual([`photo:${run[0]!.sha}`, `photo:${run[2]!.sha}`, `photo:${twin.sha}`].sort());
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    target.land(GOOGLE, next(), [googleRow(target, twin, { description: "synthetic" })]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    expect(ledger.sent.length).toBe(3);
    const refusing = new FakeLedger(ROUTE);
    let replies = 0;
    const again = refusing.settle(target, family, (ask) => (replies++ === 0 ? "  " : caption(ask)));
    expect(again.refused.length).toBe(1);
    expect(refusing.sent.length).toBe(4);
    target.artifact("asks", { first: first.asked.map((ask) => ask.item), sent: ledger.sent });
  });

  it("a photo whose model image has not arrived is asked about, or its arrival never asks it", () => {
    const target = home();
    const shot = photo("late", NOON);
    target.land(GOOGLE, next(), [googleRow(target, shot)]);
    target.land(CAMERAS, next(), cameraRows([shot]));
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    target.land(FACES, next(), [modelImageRow(shot.sha)]);
    const landed = target.extractPass(family, SETTINGS);
    expect(landed.written).toEqual([burstUnit(NOON)]);
    expect(ledger.settle(target, family, caption).asked.map((ask) => ask.item)).toEqual([`photo:${shot.sha}`]);
  });

  it("while faces is not on, a photo with no model image is never captioned, or is asked with names or another identity than the photo; while it is on, one waiting for its scan is captioned without its names first", () => {
    const shot = photo("unscanned", NOON);
    const plain = photo("saved", NOON + 3_600_000, false);
    const never = home();
    never.land(GOOGLE, next(), [googleRow(never, shot), googleRow(never, plain)]);
    never.land(CAMERAS, next(), cameraRows([shot, plain]));
    never.extractPass(unfaced, SETTINGS);
    const asked = new FakeLedger(ROUTE).settle(never, unfaced, caption).asked;
    expect(asked.map((ask) => ({ item: ask.item, attachments: ask.attachments, identity: ask.identity }))).toEqual([{
      item: `photo:${shot.sha}`, attachments: [{ blob: `sha256:${shot.sha}`, media_type: "image/jpeg", drawn: [] }], identity: { photo: shot.sha },
    }]);

    const on = home();
    on.land(GOOGLE, next(), [googleRow(on, shot), googleRow(on, plain)]);
    on.land(CAMERAS, next(), cameraRows([shot, plain]));
    on.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(on, family, caption).asked).toEqual([]);
    on.land(FACES, next(), [modelImageRow(shot.sha)]);
    on.extractPass(family, SETTINGS);
    const scanned = ledger.settle(on, family, caption).asked;
    expect(scanned.map((ask) => askKey(family, ask, ROUTE).key)).toEqual(asked.map((ask) => askKey(unfaced, ask, ROUTE).key));
    never.artifact("unfaced", { never: asked, on: scanned });
  });

  it("faces turned on asks a captioned photo again, or never asks a new one; Delete all face data or faces turned off asks again a photo with a model image", () => {
    const target = home();
    const [a, b, c] = [photo("a", NOON), photo("b", NOON + 3_600_000), photo("c", NOON + 7_200_000)];
    const ledger = new FakeLedger(ROUTE);
    target.land(GOOGLE, next(), [googleRow(target, a), googleRow(target, b)]);
    target.land(CAMERAS, next(), cameraRows([a, b, c]));
    target.extractPass(unfaced, SETTINGS);
    const never = ledger.settle(target, unfaced, caption).asked;
    expect(never.map((ask) => ask.item).sort()).toEqual([`photo:${a.sha}`, `photo:${b.sha}`].sort());

    extractsAlike(target);
    target.land(GOOGLE, next(), [googleRow(target, c)]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);

    const named = [{ name: "Person A", box: [2, 2, 8, 8] }];
    target.land(FACES, next(), [
      { kind: "faces", key: b.sha, content: { width: 16, height: 16, faces: [{ face: `${b.sha}:2,2,8,8`, box: [2, 2, 8, 8], person: "person-a", cluster: "" }] } },
      modelImageRow(a.sha), modelImageRow(b.sha, named), modelImageRow(c.sha),
    ]);
    target.extractPass(family, SETTINGS);
    const scanned = ledger.settle(target, family, caption).asked;
    expect(scanned.map((ask) => ({ item: ask.item, drawn: ask.attachments![0]!.drawn }))).toEqual([{ item: `photo:${c.sha}`, drawn: [] }]);

    target.db.commit((tx) => tx.records.forget({ sources: [{ source: FACES, kinds: ["faces"] }] }));
    expect(target.extractPass(family, SETTINGS).written).toEqual([]);
    extractsAlike(target);
    const off = ledger.settle(target, unfaced, caption);
    expect(off.asked).toEqual([]);
    expect(ledger.sent.length).toBe(3);
    target.artifact("faces-turned", { never: never.map((ask) => ask.item), scanned: scanned.map((ask) => ask.item), off: off.written, sent: ledger.sent });
  });

  it("a caption request's input, identity or old name differs from the golden", () => {
    const target = home();
    const cases = [
      { name: "p1-no-faces", source: GOOGLE_TWO, at: NOON },
      { name: "p2-unnamed", source: GOOGLE_TWO, at: NOON + 3_600_000 },
      { name: "p3-one-of-two-named", source: GOOGLE_TWO, at: NOON + 7_200_000 },
      { name: "p4-rotated-named", source: GOOGLE, at: NOON + 10_800_000 },
    ];
    for (const item of cases) {
      const entry = golden(item.name);
      const original = { bytes: goldenBytes(entry.original.file), sha: entry.original.sha256, at_ms: item.at, camera: true };
      target.land(item.source, next(), [googleRow(target, original)]);
      target.land(FACES, next(), [modelImageRow(entry.original.sha256, facesOf(item.name))]);
      target.land(CAMERAS, next(), cameraRows([original]));
    }
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    const asked = ledger.settle(target, family, caption).asked;
    expect(family.prompts![PHOTO_CAPTION]).toBe(PHOTO_CAPTION_PROMPT);
    const compared = cases.map((item) => {
      const entry = golden(item.name);
      const ask = asked.find((candidate) => candidate.item === `photo:${entry.original.sha256}`)!;
      expect(ask).toBeDefined();
      expect({ model: ROUTE.model, input: entry.request.body.endsWith(piecesText(ask.input)), input_hash: inputHash(ask), attachments: ask.attachments }).toEqual({
        model: entry.request.model, input: true, input_hash: entry.request.input_hash,
        attachments: [{ blob: `sha256:${entry.original.sha256}`, media_type: "image/jpeg", drawn: drawnOver(facesOf(item.name)) }],
      });
      expect(entry.request.attachments[0]!.extension).toBe(".jpg");
      return { name: item.name, ...askKey(family, ask, ROUTE) };
    });
    expect(GOLDEN.runtime).toMatchObject(ROUTE);

    const named = golden("p2-named");
    expect(named.request.input_hash).toBe(golden("p2-unnamed").request.input_hash);
    target.land(FACES, next(), [modelImageRow(named.original.sha256, facesOf("p2-named"))]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    target.artifact("golden-keys", { compared, named: named.request.input_hash });
  });

  it("naming a face touches photos that don't show it, or asks its photo again", () => {
    const target = home();
    const run = [photo("a1", NOON), photo("a2", NOON + 20_000), photo("a3", NOON + 40_000)];
    const alone = photo("b1", NOON + 3_600_000);
    target.land(GOOGLE, next(), [...run, alone].map((item) => googleRow(target, item)));
    target.land(FACES, next(), [...run, alone].map((item) => modelImageRow(item.sha)));
    target.land(CAMERAS, next(), cameraRows([...run, alone]));
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    ledger.settle(target, family, caption);
    const enrichments = () => target.read((view) => [run[0]!, run[2]!, alone].map((item) => view.enrichment("photos", `photo:${item.sha}`, PHOTO_CAPTION)));
    const before = enrichments();
    const units = bursts(target).map((row) => row.unit);

    target.land(FACES, next(), [
      { kind: "faces", key: run[2]!.sha, content: { width: 16, height: 16, faces: [{ face: `${run[2]!.sha}:2,2,8,8`, box: [2, 2, 8, 8], person: "person-a", cluster: "" }] } },
      modelImageRow(run[2]!.sha, [{ name: "Person A", box: [2, 2, 8, 8] }]),
    ]);
    const pass = target.extractPass(family, SETTINGS);
    const burst = units.find((unit) => unit === burstUnit(run[0]!.at_ms))!;
    expect(pass.touched).toEqual([burst]);
    expect(pass.written).toEqual([burst]);
    const settled = ledger.settle(target, family, caption);
    expect(settled.asked).toEqual([]);
    expect(enrichments()).toEqual(before);
    target.artifact("naming", { pass, asked: settled.asked.map((ask) => ask.item) });
  });

  it("a caption reads a placeholder on the day, puts a name on the wrong face, or asks again when a face is named", () => {
    const target = home();
    const shot = photo("faced", NOON);
    target.land(GOOGLE, next(), [googleRow(target, shot)]);
    target.land(CAMERAS, next(), cameraRows([shot]));
    target.land(FACES, next(), [modelImageRow(shot.sha, [{ box: [0, 0, 10, 10], name: "Ada Example" }, { box: [40, 0, 50, 10] }])]);
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    const first = ledger.settle(target, family, () =>
      JSON.stringify({ caption: "[[Person 2]] hands [[Person 1]] a cake. [[Person 2]] smiles.", faces: [{ placeholder: "[[Person 1]]", who: "a woman" }, { placeholder: "[[Person 2]]", who: "a man" }] }));
    expect([first.asked.length, first.refused]).toEqual([1, []]);
    expect(first.asked[0]!.attachments).toEqual([{ blob: `sha256:${shot.sha}`, media_type: "image/jpeg", drawn: [
      { placeholder: "[[Person 1]]", box: { x: 0, y: 0, width: 10, height: 10 } }, { placeholder: "[[Person 2]]", box: { x: 40, y: 0, width: 10, height: 10 } },
    ] }]);
    const stored = () => target.read((view) => view.enrichment("photos", `photo:${shot.sha}`, PHOTO_CAPTION)!.content);
    const line = () => target.read((view) => family.day({ day: "2026-09-05", settings: SETTINGS, extracts: [...view.extracts("photos", { start_ms: NOON, end_ms: NOON + 1 })].filter((row) => row.unit.startsWith("burst/")), enrichments: new Map([[`photo:${shot.sha}`, view.enrichment("photos", `photo:${shot.sha}`, PHOTO_CAPTION)!]]), labels: buildLabels({ people: [], contacts: [], places: [] }), sources: new Map(), device: (unit) => unit }).lines)[0]!;
    expect(stored()).toEqual({ text: "A man hands Ada Example a cake. A man smiles.", names: [{ start: 12, end: 23, who: "person:ada-example" }] });
    expect(line()).toMatchObject({ text: "Photo: A man hands Ada Example a cake. A man smiles.", names: [{ start: 19, end: 30, who: "person:ada-example" }] });
    target.land(FACES, next(), [modelImageRow(shot.sha, [{ box: [0, 0, 10, 10], name: "Ada Example" }, { box: [41, 1, 51, 11], name: "Rose Example" }])]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    expect(stored()).toEqual({ text: "Rose Example hands Ada Example a cake. Rose Example smiles.", names: [
      { start: 0, end: 12, who: "person:rose-example" }, { start: 19, end: 30, who: "person:ada-example" }, { start: 39, end: 51, who: "person:rose-example" },
    ] });
    target.land(FACES, next(), [modelImageRow(shot.sha, [{ box: [0, 0, 10, 10], name: "Ada Example" }])]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    expect((stored() as { text: string }).text).toBe("A man hands Ada Example a cake. A man smiles.");
    target.artifact("put-back", { caption: stored(), line: line() });
  });

  it("a photo is asked again when its model image is drawn again, with the same names or another", () => {
    const target = home();
    const shot = photo("redrawn", NOON);
    target.land(GOOGLE, next(), [googleRow(target, shot)]);
    target.land(CAMERAS, next(), cameraRows([shot]));
    const names = [{ name: "Person B", box: [9, 9, 14, 14] }, { name: "Person A", box: [1, 1, 4, 4] }];
    target.land(FACES, next(), [modelImageRow(shot.sha, names)]);
    target.extractPass(family, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    const [ask] = ledger.settle(target, family, caption).asked;
    expect(ask!.identity).toEqual({ photo: shot.sha });
    target.land(FACES, next(), [modelImageRow(shot.sha, [names[1]!, { ...names[0]!, box: [10, 9, 14, 15] }])]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    target.land(FACES, next(), [modelImageRow(shot.sha, [...names, { name: "Person C", box: [5, 5, 8, 8] }])]);
    target.extractPass(family, SETTINGS);
    expect(ledger.settle(target, family, caption).asked).toEqual([]);
    expect(ledger.sent.length).toBe(1);
  });

  it("an erasure of a photo leaves a record of its image, its caption, its faces, its camera or the owner's statements about them, or takes them while a chat still shows it", () => {
    const target = home();
    const shot = photo("erased", NOON);
    const people = "people:local:macbook-pro-0001";
    target.land(GOOGLE, next(), [googleRow(target, shot)]);
    target.land(GOOGLE_TWO, next(), [googleRow(target, shot)]);
    target.land(FACES, next(), [
      { kind: "scan", key: shot.sha, content: { status: "ok" } }, modelImageRow(shot.sha),
    ]);
    target.land(CAMERAS, next(), cameraRows([shot]));
    target.land(people, next(), [
      { kind: "face", key: `${shot.sha}:1,1,4,4`, content: { is: "person-a" } }, { kind: "face", key: `${"0".repeat(64)}:1,1,4,4`, content: { ignore: true } },
    ]);
    const erased = target.read((view) => family.replicas!(`photo:${shot.sha}`, view, buildLabels({ people: [], contacts: [], places: [] })));
    expect(erased).toEqual({
      records: [
        { source: GOOGLE, kind: "img", key: shot.sha }, { source: GOOGLE_TWO, kind: "img", key: shot.sha },
        { source: FACES, kind: "scan", key: shot.sha }, { source: FACES, kind: "model-image", key: shot.sha },
        { source: CAMERAS, kind: "photo", key: shot.sha },
        { source: people, kind: "face", key: `${shot.sha}:1,1,4,4` },
      ],
      items: [`photo:${shot.sha}`],
    });
    expect(target.read((view) => family.replicas!(`photo:${"f".repeat(64)}`, view, buildLabels({ people: [], contacts: [], places: [] })))).toEqual({ records: [], items: [] });
    target.land("whatsapp:15550000000:macbook-pro-0001", next(), [{ kind: "msg", key: "15550000002@s.whatsapp.net:B1", content: {}, blobs: [`sha256:${shot.sha}`] }]);
    const shared = target.read((view) => family.replicas!(`photo:${shot.sha}`, view, buildLabels({ people: [], contacts: [], places: [] })));
    expect(shared.records).toEqual(erased.records.slice(0, 2));
    target.artifact("erase", { erased, shared });
  });

  it("a burst read before its photo's camera lands is not read again when it lands, a camera's record gone leaves a photograph standing, or the family reads a camera from a file's bytes", () => {
    const target = home();
    const shot = photo("labelled-later", NOON);
    const whole = vi.spyOn(target.blobs, "bytes");
    const prefix = vi.spyOn(target.blobs, "prefix");
    const kinds = () => bursts(target).map((row) => (row.content as { photos: { kind: string }[] }).photos.map((each) => each.kind));
    const day = (): string => target.read((view) => renderDay("2026-09-05", [unfaced], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] })))).txt;
    const ledger = new FakeLedger(ROUTE);
    target.land(GOOGLE, next(), [googleRow(target, shot)]);
    target.extractPass(unfaced, SETTINGS);
    expect(kinds()).toEqual([["image"]]);
    expect(ledger.settle(target, unfaced, caption).asked).toEqual([]);
    expect(day()).toContain("Image");
    target.land(CAMERAS, next(), cameraRows([shot]));
    expect(target.extractPass(unfaced, SETTINGS).written).toEqual([burstUnit(NOON)]);
    expect(kinds()).toEqual([["photograph"]]);
    expect(ledger.settle(target, unfaced, caption).asked.map((ask) => ask.item)).toEqual([`photo:${shot.sha}`]);
    expect(day()).toContain("Photo: A synthetic caption");
    target.land(CAMERAS, next(), [{ kind: "photo", key: shot.sha, content: null, gone: true }]);
    expect(target.extractPass(unfaced, SETTINGS).written).toEqual([burstUnit(NOON)]);
    expect(kinds()).toEqual([["image"]]);
    expect(day()).toContain("Image");
    expect(day()).not.toContain("Photo: ");
    expect(whole).not.toHaveBeenCalled();
    expect(prefix).not.toHaveBeenCalled();
    expect(ledger.sent.length).toBe(1);
    target.artifact("labelled-later", { day: day(), sent: ledger.sent });
  });

  it("`renderDay` reads outside `days()`", () => {
    const target = home();
    const boundary = Date.UTC(2026, 8, 5, 22, 30);
    const items = [photo("d1", boundary - 30_000), photo("d2", boundary + 20_000), photo("d3", NOON), photo("d4", NOON + 86_400_000 * 2, false)];
    target.land(GOOGLE, next(), items.map((item) => googleRow(target, item)));
    target.land(FACES, next(), items.map((item) => modelImageRow(item.sha)));
    target.land(CAMERAS, next(), cameraRows(items));
    target.extractPass(family, SETTINGS);
    new FakeLedger(ROUTE).settle(target, family, caption);
    const seen = new Map<string, string[]>();
    const files: Record<string, string> = {};
    for (const day of ["2026-09-04", "2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08"]) {
      const reads: { family: string; unit: string; day: string }[] = [];
      const rendered = target.read((view) => renderDay(day, [family], dayReader(view, reads), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))));
      for (const readOne of reads) {
        const row = extracts(target).find((extract) => extract.unit === readOne.unit)!;
        expect(family.days(row, SETTINGS)).toContain(day);
      }
      const document = JSON.parse(rendered.json) as { atoms: { item?: string }[] };
      expect(checkDayFile(document)).toEqual([]);
      for (const atom of document.atoms) seen.set(atom.item!, [...(seen.get(atom.item!) ?? []), day]);
      files[day] = rendered.txt;
    }
    expect(Object.fromEntries(seen)).toEqual({
      [`photo:${items[0]!.sha}`]: ["2026-09-05"], [`photo:${items[1]!.sha}`]: ["2026-09-06"],
      [`photo:${items[2]!.sha}`]: ["2026-09-05"], [`photo:${items[3]!.sha}`]: ["2026-09-07"],
    });
    expect(files["2026-09-05"]).toContain("Photo: A synthetic caption");
    expect(files["2026-09-07"]).toContain("Image");
    target.artifact("days", files);
  });

  it("a phone paired again under a new unit loses its photos: not photographs, not captioned, or captioned again", () => {
    const target = home();
    const FIRST = "apple-photos:person-a@example.com:iphone-bb02";
    target.addSource(FIRST, "photos-ios-bundle");
    const shots = [photo("paired-1", NOON), photo("paired-2", NOON + 3_600_000)];
    const library = (into: TestHome) => shots.map((item, index) => appleRow(into, item, `SYNTH-PAIR/L0/00${index}`, "2026-09-05T06:30:00.000Z"));
    target.land(FIRST, next(), library(target));
    target.land(CAMERAS, next(), cameraRows(shots));
    target.extractPass(unfaced, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, unfaced, caption).asked.map((ask) => ask.item).sort()).toEqual(shots.map((item) => `photo:${item.sha}`).sort());
    const units = bursts(target).map((row) => row.unit);
    target.land(APPLE, next(), library(target));
    const again = target.extractPass(unfaced, SETTINGS);
    expect(again.deleted.sort()).toEqual(shots.map((_, index) => `photo/${FIRST}/SYNTH-PAIR/L0/00${index}`).sort());
    expect(bursts(target).map((row) => row.unit)).toEqual(units);
    const photos = bursts(target).flatMap((row) => (row.content as { photos: { photo: string; kind: string; held: boolean }[] }).photos);
    expect(photos.map(({ photo: id, kind, held }) => ({ id, kind, held }))).toEqual(shots.map((_, index) => ({ id: `${APPLE}/SYNTH-PAIR/L0/00${index}`, kind: "photograph", held: true })));
    expect(ledger.settle(target, unfaced, caption).asked).toEqual([]);
    expect(ledger.sent.length).toBe(shots.length);
    target.artifact("paired-again", { again, photos });
  });

  it("the photo witness and the burst read a photo's camera two ways, and disagree, on any route", () => {
    const target = home();
    const at = (hours: number) => NOON + hours * 3_600_000;
    const routes = [
      { source: APPLE, item: photo("route-apple", at(0)), camera: "synthetic/camera-a" },
      { source: GOOGLE, item: photo("route-google", at(1)), camera: "synthetic/camera-b" },
      { source: IN_APP, item: photo("route-in-app", at(2)), camera: "synthetic/camera-c" },
    ];
    for (const { source, item } of routes) {
      const row = source === APPLE ? appleRow(target, item, "SYNTH-ROUTE/L0/001", "2026-09-05T06:30:00.000Z")
        : source === GOOGLE ? googleRow(target, item) : inAppRow(target, item, "camera-route");
      target.land(source, next(), [row]);
    }
    target.land(CAMERAS, next(), routes.map(({ item, camera }) => cameraRow(item.sha, camera, { latitude: 0.01, longitude: 0.02 })));
    target.extractPass(unfaced, SETTINGS);
    const date = new Date(NOON).toISOString().slice(0, 10);
    const witnessed = target.read((view) => routes.map(({ source }) =>
      (photoWitness(new PhotoRoutes(FED.photos)).extract(`seen/${source}/${date}`, view, target.blobs) as { photos: { camera: string | null }[] } | null)?.photos.map((each) => each.camera)));
    expect(witnessed).toEqual(routes.map(({ camera }) => [camera]));
    expect(target.read((view) => routes.map(({ item }) => cameraOf(view, [item.sha])?.camera))).toEqual(routes.map(({ camera }) => camera));
    expect(bursts(target).map((row) => [row.unit, (row.content as { photos: { kind: string }[] }).photos.map((each) => each.kind)]))
      .toEqual(routes.map(({ item }) => [burstUnit(item.at_ms), ["photograph"]]));
    target.artifact("routes", { witnessed });
  });

  it("two cameras shooting one moment make two interleaved blocks, or a Mac library's photo sits apart from the phone's of the same moment", () => {
    const target = home();
    const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
    target.addSource(MAC, "photos-mac-bundle");
    const [phone, mac, friend] = [photo("moment-phone", NOON), photo("moment-mac", NOON + 10_000), photo("moment-friend", NOON + 40_000)];
    target.land(APPLE, next(), [appleRow(target, phone, "SYNTH-MOMENT/L0/001", "2026-09-05T06:30:00.000Z")]);
    target.land(MAC, next(), [appleRow(target, mac, "SYNTH-MOMENT/L0/002", "2026-09-05T06:30:00.000Z")]);
    target.land(GOOGLE, next(), [googleRow(target, friend)]);
    target.land(CAMERAS, next(), [cameraRow(phone.sha), cameraRow(mac.sha, "synthetic/camera-b"), cameraRow(friend.sha, "other/camera")]);
    target.extractPass(unfaced, SETTINGS);
    expect(bursts(target).map((row) => row.unit)).toEqual([burstUnit(NOON)]);
    const photos = (bursts(target)[0]!.content as { photos: { item: string; position: string }[] }).photos;
    expect(photos.map(({ item, position }) => [item, position])).toEqual([[`photo:${phone.sha}`, "first"], [`photo:${mac.sha}`, "member"], [`photo:${friend.sha}`, "last"]]);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, unfaced, caption).asked.map((ask) => [ask.item, ask.work, ask.source])).toEqual([
      [`photo:${phone.sha}`, "photos", APPLE], [`photo:${friend.sha}`, "photos", GOOGLE],
    ]);
    const day = target.read((view) => renderDay("2026-09-05", [unfaced], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))));
    const atoms = (JSON.parse(day.json) as { atoms: { item?: string; block?: { key: string } }[] }).atoms.filter((atom) => atom.item?.startsWith("photo:"));
    expect(atoms.map((atom) => atom.block?.key)).toEqual([burstUnit(NOON), burstUnit(NOON), burstUnit(NOON)]);
    target.artifact("one-moment", { photos, day: day.txt });
  });

  it("another person's camera is left out of captions or of the photos taken", () => {
    const target = home();
    const shots = [photo("stranger-1", NOON), photo("stranger-2", NOON + 3_600_000), photo("stranger-3", NOON + 7_200_000)];
    target.land(GOOGLE, next(), shots.map((item) => googleRow(target, item)));
    target.land(CAMERAS, next(), cameraRows(shots, "stranger/camera"));
    target.extractPass(unfaced, SETTINGS);
    expect(new FakeLedger(ROUTE).settle(target, unfaced, caption).asked.map((ask) => ask.item).sort()).toEqual(shots.map((item) => `photo:${item.sha}`).sort());
    expect(bursts(target).flatMap((row) => photographsOf(row))).toEqual(shots.map((item) => ({ image: item.sha, at_ms: item.at_ms })));
  });

  it("a renamed burst asks every caption again", () => {
    const target = home();
    const run = [photo("renamed-1", NOON), photo("renamed-2", NOON + 20_000), photo("renamed-3", NOON + 40_000)];
    target.land(GOOGLE, next(), run.map((item) => googleRow(target, item)));
    target.land(CAMERAS, next(), cameraRows(run));
    target.extractPass(unfaced, SETTINGS);
    const ledger = new FakeLedger(ROUTE);
    expect(ledger.settle(target, unfaced, caption).asked.map((ask) => ask.item).sort()).toEqual([`photo:${run[0]!.sha}`, `photo:${run[2]!.sha}`].sort());
    const [stored] = bursts(target);
    const old = `burst/${PHONE}/${NOON}`;
    target.db.commit((tx) => {
      tx.derived.extracts.delete("photos", stored!.unit);
      tx.derived.extracts.put({ ...stored!, unit: old, code: "8:older", content: { device: PHONE, ...(stored!.content as object) } });
      tx.tables.cursors.reset("extract:photos", null, 0);
    });
    const again = target.extractPass(unfaced, SETTINGS);
    expect(again.deleted).toContain(old);
    expect(bursts(target).map((row) => row.unit)).toEqual([burstUnit(NOON)]);
    expect(ledger.settle(target, unfaced, caption).asked).toEqual([]);
    expect(ledger.sent.length).toBe(2);
  });

  it("a photo re-timed by a higher-ranked route's copy stays in its old burst too", () => {
    const target = home();
    const shot = photo("re-timed", NOON);
    const neighbour = photo("re-timed-neighbour", NOON + 20_000);
    target.land(GOOGLE, next(), [googleRow(target, shot), googleRow(target, neighbour)]);
    target.land(CAMERAS, next(), cameraRows([shot, neighbour]));
    target.extractPass(unfaced, SETTINGS);
    expect(bursts(target).map((row) => row.unit)).toEqual([burstUnit(NOON)]);
    const later = NOON + 30 * 60_000;
    target.land(APPLE, next(), [appleRow(target, { ...shot, at_ms: later }, "SYNTH-RETIME/L0/001", "2026-09-05T07:00:00.000Z")]);
    const moved = target.extractPass(unfaced, SETTINGS);
    expect(moved.deleted.sort()).toEqual([burstUnit(NOON), `photo/${GOOGLE}/${shot.sha}`].sort());
    const placed = bursts(target).map((row) => [row.unit, (row.content as { photos: { item: string }[] }).photos.map((each) => each.item)]);
    expect(placed).toEqual([[burstUnit(NOON + 20_000), [`photo:${neighbour.sha}`]], [burstUnit(later), [`photo:${shot.sha}`]]]);
    target.artifact("re-timed", { moved, placed });
  });
});

describe("a Live Photo is one photo, a video a video: each way it could fail, written before the code", () => {
  const AT = NOON + 30 * 86_400_000;
  const LIVE = "LIVE-0001/L0/001";
  const CLOUD = "CLOUD-LIVE-0001";
  const still = Buffer.from("synthetic heic bytes of the live photo's still");
  const movie = Buffer.from("synthetic quicktime bytes of the live photo's movie, a little longer");
  const reencoded = Buffer.concat([movie, Buffer.from("!!")]);
  const appleStill = Buffer.from("synthetic heic bytes of the library's own still");
  const appleMovie = Buffer.from("synthetic quicktime bytes of the library's own movie, a little longer");
  type Sent = { bytes: Buffer; sent: boolean };

  function takeoutRow(target: TestHome, bytes: Buffer, title: string, at_ms: number, media_type: string): ReaderOutput {
    const hash = target.blobs.put(bytes, { mediaType: media_type });
    return {
      kind: "img", key: sha256(bytes), time: { start_ms: at_ms, precision: "s" },
      content: { type: "photos.asset", title, photoTakenTime: { timestamp: String(at_ms / 1000) }, blobs: [{ hash, bytes: bytes.length, media_type, role: "original" }] },
      blobs: [hash],
    };
  }
  const gone = (bytes: Buffer): ReaderOutput => ({ kind: "img", key: sha256(bytes), content: null, gone: true });

  function liveRow(target: TestHome, still_: Sent, motion: Sent, at_ms = AT + 300, local = LIVE, cloud = CLOUD, sizes = { still: still_.bytes.length, motion: motion.bytes.length }): ReaderOutput {
    const resource = (type: string, type_raw: number, name: string, file: Sent, size: number, media_type: string) => ({
      type, type_raw, uti: media_type === "image/heic" ? "public.heic" : "com.apple.quicktime-movie", original_filename: name, size,
      ...(file.sent ? { blob: { hash: target.blobs.put(file.bytes), type: media_type, bytes: file.bytes.length, role: type } } : { blob: null, not_local: true, not_local_reason: "icloud" }),
    });
    const resources = [resource("photo", 1, "IMG_0001.HEIC", still_, sizes.still, "image/heic"), resource("pairedVideo", 9, "IMG_0001.MOV", motion, sizes.motion, "video/quicktime")];
    return {
      kind: "img", key: `${local}:2026-10-05T06:30:00.000Z`, time: { start_ms: at_ms, precision: "ms" },
      content: { type: "photos.apple.asset", content: {
        local_identifier: local, cloud_identifier: cloud, media_type: "image", creation_date: new Date(at_ms).toISOString(), modification_date: "2026-10-05T06:30:00.000Z",
        duration: null, resources,
      } },
      blobs: resources.flatMap((each) => (each.blob === null ? [] : [each.blob.hash])),
    };
  }

  function videoRow(target: TestHome, bytes: Buffer, at_ms: number, local: string, duration: number): ReaderOutput {
    const hash = target.blobs.put(bytes);
    return {
      kind: "img", key: `${local}:null`, time: { start_ms: at_ms, precision: "ms" },
      content: { type: "photos.apple.asset", content: {
        local_identifier: local, cloud_identifier: null, media_type: "video", creation_date: new Date(at_ms).toISOString(), modification_date: null, duration,
        resources: [{ type: "video", type_raw: 2, uti: "com.apple.quicktime-movie", original_filename: "IMG_0042.MOV", size: bytes.length, blob: { hash, type: "video/quicktime", bytes: bytes.length, role: "video" } }],
      } },
      blobs: [hash],
    };
  }

  function state(target: TestHome) {
    target.extractPass(family, SETTINGS);
    const rows = extracts(target);
    return {
      units: rows.map((row) => row.unit).filter((unit) => unit.startsWith("photo/")),
      entries: bursts(target).flatMap((row) => (row.content as unknown as BurstContent).photos.map((entry) => ({ image: entry.sha256, kind: entry.kind, motion: entry.motion?.sha256 ?? null }))),
      wanted: Object.fromEntries(rows.filter((row) => row.unit.startsWith("wanted/")).map((row) => [row.unit, (row.content as { missing: { type: string }[] }).missing.map((each) => each.type)])),
    };
  }
  const T = (bytes: Buffer) => `photo/${GOOGLE}/${sha256(bytes)}`;
  const A = `photo/${APPLE}/${LIVE}`;
  const wantedA = `wanted/${APPLE}/${LIVE}`;
  const [s, m, mr, as, am] = [still, movie, reencoded, appleStill, appleMovie].map(sha256) as [string, string, string, string, string];
  const lines = (target: TestHome) => family.day({ day: "", settings: SETTINGS, extracts: bursts(target), enrichments: new Map(), labels: {} as never, sources: new Map(), device: (unit) => unit }).lines;

  it("a Takeout still and its movie are two photos, or its movie the image of a photo whose still is gone; a Live Photo Takeout holds whole is wanted of its library", () => {
    const target = home();
    const steps: Record<string, unknown> = {};
    target.land(GOOGLE, next(), [takeoutRow(target, movie, "IMG_0001.MOV", AT, "video/quicktime")]);
    expect(steps[1] = state(target)).toEqual({ units: [T(movie)], entries: [{ image: m, kind: "video", motion: null }], wanted: {} });
    target.land(GOOGLE, next(), [takeoutRow(target, still, "IMG_0001.HEIC", AT, "image/heic")]);
    expect(steps[2] = state(target)).toEqual({ units: [T(still)], entries: [{ image: s, kind: "image", motion: m }], wanted: {} });
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: false }, { bytes: movie, sent: false })]);
    expect(steps[3] = state(target)).toEqual({ units: [A], entries: [{ image: s, kind: "image", motion: m }], wanted: {} });
    target.land(GOOGLE, next(), [gone(still)]);
    expect(steps[4] = state(target)).toEqual({ units: [A], entries: [{ image: null, kind: null, motion: m }], wanted: { [wantedA]: ["photo"] } });
    expect(bursts(target).flatMap((row) => (row.content as unknown as BurstContent).photos.map((entry) => entry.item))).toEqual([`photo:apple:${CLOUD}`]);
    target.land(APPLE, next(), [liveRow(target, { bytes: appleStill, sent: true }, { bytes: appleMovie, sent: true })]);
    expect(steps[5] = state(target)).toEqual({ units: [A], entries: [{ image: as, kind: "image", motion: am }], wanted: {} });
    target.artifact("live-photo-steps", steps);
  });

  it("Google's re-encoded movie makes the library's held, is ever a photo's image, or a still arriving or leaving changes which file plays", () => {
    const target = home();
    const steps: Record<string, unknown> = {};
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: false }, { bytes: movie, sent: false })]);
    target.land(GOOGLE, next(), [takeoutRow(target, reencoded, "IMG_0001.MOV", AT, "video/quicktime")]);
    expect(steps["1'"] = state(target)).toEqual({ units: [A], entries: [{ image: null, kind: null, motion: mr }], wanted: { [wantedA]: ["photo", "pairedVideo"] } });
    target.land(GOOGLE, next(), [takeoutRow(target, still, "IMG_0001.HEIC", AT, "image/heic")]);
    expect(steps["2'"] = state(target)).toEqual({ units: [A], entries: [{ image: s, kind: "image", motion: mr }], wanted: { [wantedA]: ["pairedVideo"] } });
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: false }, { bytes: appleMovie, sent: true }, AT + 300, LIVE, CLOUD, { still: still.length, motion: movie.length })]);
    expect(steps["3'"] = state(target)).toEqual({ units: [A], entries: [{ image: s, kind: "image", motion: am }], wanted: {} });
    target.land(GOOGLE, next(), [gone(still)]);
    expect(steps["4'"] = state(target)).toEqual({ units: [A], entries: [{ image: null, kind: null, motion: am }], wanted: { [wantedA]: ["photo"] } });
    target.artifact("live-photo-reencoded", steps);
  });

  it("with no library, a Takeout pair whose still goes leaves no photo, or its movie no video", () => {
    const target = home();
    target.land(GOOGLE, next(), [takeoutRow(target, still, "IMG_0001.HEIC", AT, "image/heic"), takeoutRow(target, movie, "IMG_0001.MOV", AT, "video/quicktime")]);
    expect(state(target)).toEqual({ units: [T(still)], entries: [{ image: s, kind: "image", motion: m }], wanted: {} });
    target.land(GOOGLE, next(), [gone(still)]);
    expect(state(target)).toEqual({ units: [T(movie)], entries: [{ image: m, kind: "video", motion: null }], wanted: {} });
  });

  it("a motion photo, or a pair whose movie carries a copy mark, is two photos; a pair is guessed where a name or an instant meets two", () => {
    const target = home();
    const motionStill = Buffer.from("synthetic jpeg of a motion photo"), motionVideo = Buffer.from("synthetic mp4 of a motion photo");
    const marked = Buffer.from("synthetic quicktime of a copy's movie"), markedStill = Buffer.from("synthetic heic of a copy's still");
    target.land(GOOGLE, next(), [
      takeoutRow(target, motionStill, "PXL_20261005_063000000.MP.jpg", AT, "image/jpeg"), takeoutRow(target, motionVideo, "PXL_20261005_063000000.MP", AT, "video/mp4"),
      takeoutRow(target, markedStill, "IMG_0002.HEIC", AT + 600_000, "image/heic"), takeoutRow(target, marked, "IMG_0002(1).MOV", AT + 600_000, "video/quicktime"),
    ]);
    expect(state(target).entries).toEqual([
      { image: sha256(motionStill), kind: "image", motion: sha256(motionVideo) },
      { image: sha256(markedStill), kind: "image", motion: sha256(marked) },
    ]);
    const routes = new PhotoRoutes(FED.photos);
    expect(target.read((view) => copyOf(view, routes, { source: GOOGLE, key: sha256(marked) })!.names)).toEqual(["IMG_0002.HEIC", "IMG_0002.MOV"]);

    const other = home();
    const [heic, jpg, edited, edMovie, one, twoA, twoB] = ["two stills: heic", "two stills: jpg", "an edited still", "its movie", "one still", "a first movie", "a second movie"].map((words) => Buffer.from(`synthetic bytes of ${words}`)) as [Buffer, Buffer, Buffer, Buffer, Buffer, Buffer, Buffer];
    other.land(GOOGLE, next(), [
      takeoutRow(other, heic, "IMG_0001.HEIC", AT, "image/heic"), takeoutRow(other, jpg, "IMG_0001.JPG", AT, "image/jpeg"), takeoutRow(other, movie, "IMG_0001.MOV", AT, "video/quicktime"),
      takeoutRow(other, edited, "IMG_0003-edited.jpg", AT + 600_000, "image/jpeg"), takeoutRow(other, edMovie, "IMG_0003.MOV", AT + 600_000, "video/quicktime"),
      takeoutRow(other, one, "IMG_0004.HEIC", AT + 1_200_000, "image/heic"), takeoutRow(other, twoA, "IMG_0004.MOV", AT + 1_200_000, "video/quicktime"), takeoutRow(other, twoB, "IMG_0004(1).MOV", AT + 1_200_000, "video/quicktime"),
    ]);
    const entries = state(other).entries;
    expect(entries.filter((entry) => entry.motion !== null)).toEqual([]);
    expect(entries.map((entry) => [entry.image, entry.kind]).sort()).toEqual([heic, jpg, movie, edited, edMovie, one, twoA, twoB].map((bytes) => [sha256(bytes), /MOV|movie/u.test(bytes.toString()) ? "video" : "image"]).sort());
    expect(other.read((view) => [one, twoA, twoB].map((bytes) => copyOf(view, routes, { source: GOOGLE, key: sha256(bytes) })!.records.length))).toEqual([1, 1, 1]);
    other.land(APPLE, next(), [liveRow(other, { bytes: heic, sent: false }, { bytes: movie, sent: false })]);
    expect(state(other).entries.filter((entry) => entry.motion === m)).toEqual([{ image: sha256(heic), kind: "image", motion: m }]);
    expect(state(other).entries.some((entry) => entry.image === m)).toBe(false);
  });

  it("two library Live Photos of one name and second are bridged by one Takeout pair", () => {
    const target = home();
    target.land(APPLE, next(), [
      liveRow(target, { bytes: still, sent: false }, { bytes: movie, sent: false }, AT + 200, "LIVE-0001/L0/001", "CLOUD-LIVE-0001"),
      liveRow(target, { bytes: still, sent: false }, { bytes: movie, sent: false }, AT + 700, "LIVE-0002/L0/001", "CLOUD-LIVE-0002"),
    ]);
    target.land(GOOGLE, next(), [takeoutRow(target, still, "IMG_0001.HEIC", AT, "image/heic"), takeoutRow(target, movie, "IMG_0001.MOV", AT, "video/quicktime")]);
    expect(state(target).units).toEqual([`photo/${APPLE}/LIVE-0001/L0/001`, `photo/${APPLE}/LIVE-0002/L0/001`, T(still)]);
  });

  it("a Takeout video is a camera's photograph or an image, an Apple video's line has a span or no length, or a Live Photo's line is a video's", () => {
    const target = home();
    const mp4 = Buffer.from("synthetic mp4 of a takeout video"), mov = Buffer.from("synthetic quicktime of a library video"), long = Buffer.from("synthetic quicktime of a long video");
    const blink = Buffer.from("synthetic quicktime of a third of a second");
    target.land(GOOGLE, next(), [takeoutRow(target, mp4, "VID_0001.mp4", AT, "video/mp4")]);
    target.land(CAMERAS, next(), [cameraRow(sha256(mp4))]);
    target.land(APPLE, next(), [videoRow(target, mov, AT + 600_000, "VIDEO-0001/L0/001", 42.4), videoRow(target, long, AT + 1_200_000, "VIDEO-0002/L0/001", 3720)]);
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: true }, { bytes: movie, sent: true }, AT + 1_800_000)]);
    target.land(APPLE, next(), [videoRow(target, blink, AT + 2_400_000, "VIDEO-0003/L0/001", 0.333)]);
    target.extractPass(family, SETTINGS);
    const entries = bursts(target).flatMap((row) => (row.content as unknown as BurstContent).photos.map((entry) => [entry.kind, entry.duration_ms, entry.motion?.sha256 ?? null]));
    expect(entries).toEqual([["video", null, null], ["video", 42_400, null], ["video", 3_720_000, null], ["image", null, m], ["video", 333, null]]);
    expect(lines(target).map(({ text, end_ms, video, live }) => ({ text, end_ms, video, live }))).toEqual([
      { text: "Video", end_ms: null, video: { duration_ms: null }, live: undefined },
      { text: "Video: 42s", end_ms: null, video: { duration_ms: 42_400 }, live: undefined },
      { text: "Video: 1h 2m", end_ms: null, video: { duration_ms: 3_720_000 }, live: undefined },
      { text: "Image", end_ms: null, video: undefined, live: true },
      { text: "Video: 1s", end_ms: null, video: { duration_ms: 333 }, live: undefined },
    ]);
  });

  it("a library photo meets a Takeout movie of its paired video's bytes from one side only", () => {
    const target = home();
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: true }, { bytes: movie, sent: true })]);
    target.land(GOOGLE, next(), [takeoutRow(target, movie, "renamed.mov", AT + 3_600_000, "video/quicktime")]);
    const routes = new PhotoRoutes(FED.photos);
    const from = (record: { source: string; key: string }) => target.read((view) => joinedOf(view, routes, copyOf(view, routes, record)!).copies.map(({ copy, rung }) => [copy.route.id, copy.id, rung]));
    const expected = [[APPLE, LIVE, 0], [GOOGLE, m, 1]];
    expect([from({ source: APPLE, key: `${LIVE}:2026-10-05T06:30:00.000Z` }), from({ source: GOOGLE, key: m })]).toEqual([expected, expected]);
    expect(state(target)).toEqual({ units: [A], entries: [{ image: s, kind: "image", motion: m }], wanted: {} });
  });

  const atoms = (target: TestHome) => target.read((view) => {
    const day = renderDay("2026-10-05", [family], dayReader(view), SETTINGS, tableUnits(buildLabels({ people: [], contacts: [], places: [] })));
    return (JSON.parse(day.json) as { atoms: { text: string; end_ms: number | null; video?: unknown; live?: unknown }[] }).atoms.map(({ text, end_ms, video, live }) => ({ text, end_ms, video, live }));
  });

  it("a day holding a video's row an older code wrote (no length, no motion) fails to render, or prints a length or a Live Photo it does not hold", () => {
    const target = home();
    target.land(APPLE, next(), [videoRow(target, Buffer.from("synthetic quicktime of an old row's video"), AT + 600_000, "VIDEO-0001/L0/001", 42.4)]);
    target.land(APPLE, next(), [liveRow(target, { bytes: still, sent: true }, { bytes: movie, sent: true }, AT + 1_800_000)]);
    target.extractPass(family, SETTINGS);
    const current = bursts(target);
    const old = current.map((row) => ({ ...row, code: "11", content: { photos: (row.content as unknown as BurstContent).photos.map(({ duration_ms: _length, motion: _motion, ...entry }) => entry) } as unknown as ExtractRow["content"] }));
    target.db.commit((tx) => { for (const row of old) tx.derived.extracts.put(row); });
    expect(atoms(target)).toEqual([
      { text: "Video", end_ms: null, video: { duration_ms: null }, live: undefined },
      { text: "Image", end_ms: null, video: undefined, live: undefined },
    ]);
    target.db.commit((tx) => { for (const row of current) tx.derived.extracts.put(row); });
    expect(atoms(target)).toEqual([
      { text: "Video: 42s", end_ms: null, video: { duration_ms: 42_400 }, live: undefined },
      { text: "Image", end_ms: null, video: undefined, live: true },
    ]);
  });

  function libraryRow(target: TestHome, local: string, modified: string, resources: [string, number, string, Sent, string][]): ReaderOutput {
    const stated = resources.map(([type, type_raw, name, file, media_type]) => ({
      type, type_raw, original_filename: name, size: file.bytes.length,
      ...(file.sent ? { blob: { hash: target.blobs.put(file.bytes), type: media_type, bytes: file.bytes.length, role: type } } : { blob: null, not_local: true, not_local_reason: "icloud" }),
    }));
    return {
      kind: "img", key: `${local}:${modified}`, time: { start_ms: AT + 300, precision: "ms" },
      content: { type: "photos.apple.asset", content: {
        local_identifier: local, cloud_identifier: CLOUD, media_type: "image", creation_date: new Date(AT + 300).toISOString(), modification_date: modified, duration: null, resources: stated,
      } },
      blobs: stated.flatMap((each) => (each.blob === null ? [] : [each.blob.hash])),
    };
  }

  it("an edit a lower route holds shows its still with the older motion, or its motion render is passed over for an original", () => {
    const target = home();
    const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
    target.addSource(MAC, "photos-mac-bundle");
    const [render, movieRender] = ["the newer edit's still", "the newer edit's motion"].map((words) => Buffer.from(`synthetic bytes of ${words}`)) as [Buffer, Buffer];
    target.land(APPLE, next(), [libraryRow(target, LIVE, "2026-10-05T06:30:00.000Z", [["photo", 1, "IMG_0001.HEIC", { bytes: still, sent: true }, "image/heic"], ["pairedVideo", 9, "IMG_0001.MOV", { bytes: movie, sent: true }, "video/quicktime"]])]);
    target.land(MAC, next(), [libraryRow(target, "LIVE-MAC/L0/001", "2026-10-07T06:30:00.000Z", [
      ["photo", 1, "IMG_0001.HEIC", { bytes: still, sent: false }, "image/heic"], ["pairedVideo", 9, "IMG_0001.MOV", { bytes: movie, sent: false }, "video/quicktime"],
      ["fullSizePhoto", 5, "FullSizeRender.heic", { bytes: render, sent: true }, "image/heic"], ["fullSizePairedVideo", 10, "FullSizeRender.mov", { bytes: movieRender, sent: true }, "video/quicktime"],
    ])]);
    expect(state(target).entries).toEqual([{ image: sha256(render), kind: "image", motion: sha256(movieRender) }]);
  });

  it("a Takeout still whose own name carries a `(n)` loses it, and so no longer joins its library's photo", () => {
    const target = home();
    const marked = Buffer.from("synthetic jpeg of a still whose own name carries a mark");
    target.land(APPLE, next(), [libraryRow(target, LIVE, "2026-10-05T06:30:00.000Z", [["photo", 1, "IMG_0001(1).JPG", { bytes: marked, sent: false }, "image/jpeg"]])]);
    target.land(GOOGLE, next(), [takeoutRow(target, marked, "IMG_0001(1).JPG", AT, "image/jpeg")]);
    expect(state(target)).toEqual({ units: [A], entries: [{ image: sha256(marked), kind: "image", motion: null }], wanted: {} });
    const routes = new PhotoRoutes(FED.photos);
    expect(target.read((view) => copyOf(view, routes, { source: GOOGLE, key: sha256(marked) })!.names)).toEqual(["IMG_0001(1).JPG"]);
  });
});
