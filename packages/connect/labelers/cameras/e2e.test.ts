import { createHash } from "node:crypto";
import { type BlobReader, type Delivery, type Json, type Landed, type PhotosAdapter, type ReaderOutput, type Registered } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { Refused } from "../../shared/index.js";
import { artifact, collect, fetchedBytes, openTestHome } from "../../test/drive.js";
import { camerasConnector, CAMERAS_FILE, type Camera, type CameraPhoto } from "./reader.js";
import { camerasLabeler } from "./labeler.js";
import { jpeg, tiff } from "./test/fixtures.js";
import { declarations } from "../../index.js";
import { vendorOf } from "../../products.js";
import { registered } from "../../test/registered.js";

const UNIT = "macbook-pro-0001";
const CAMERAS = `cameras:local:${UNIT}`;
const GOOGLE = "google-photos:person-a@example.com:export";
const GOOGLE_TWO = "google-photos:person-a@example.com:export-two";
const LIBRARY = "apple-photos:person-a@example.com:iphone-aa01";
const REINSTALLED = "apple-photos:person-a@example.com:iphone-bb02";
const IN_APP = "camera:local:iphone-aa01";
const T0 = Date.UTC(2026, 9, 1);
const GUARDS: Record<string, (content: Json) => string[]> = { img: () => [], "img-file": () => [] };

const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const shot = (make: string, model: string, body: string) => jpeg(tiff({ make, model }), body);

function heic(make: string, model: string, body: string, gap = 0): Buffer {
  const u16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
  const u32 = (value: number) => { const out = Buffer.alloc(4); out.writeUInt32BE(value); return out; };
  const box = (type: string, ...parts: Buffer[]) => { const content = Buffer.concat(parts); return Buffer.concat([u32(8 + content.length), Buffer.from(type, "latin1"), content]); };
  const full = (type: string, version: number, ...parts: Buffer[]) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
  const exif = Buffer.concat([u32(6), Buffer.from("Exif\0\0", "latin1"), tiff({ make, model })]);
  const image = Buffer.from(`synthetic hevc tiles ${body}`);
  const before = Buffer.alloc(gap, 0x11);
  const split = Math.floor(exif.length / 2);
  const meta = (at: number) => full("meta", 0,
    full("hdlr", 0, u32(0), Buffer.from("pict", "latin1"), Buffer.alloc(13)),
    full("iinf", 0, u16(2), full("infe", 2, u16(1), u16(0), Buffer.from("hvc1\0", "latin1")), full("infe", 2, u16(2), u16(0), Buffer.from("Exif\0", "latin1"))),
    full("iloc", 1, Buffer.from([0x44, 0x00]), u16(2),
      u16(1), u16(0), u16(0), u16(1), u32(at + exif.length + 16), u32(image.length),
      u16(2), u16(0), u16(0), u16(2), u32(at), u32(split), u32(at + split + 16), u32(exif.length - split)));
  const ftyp = box("ftyp", Buffer.from("heic", "latin1"), u32(0), Buffer.from("mif1heic", "latin1"));
  const start = ftyp.length + meta(0).length + 8 + before.length;
  return Buffer.concat([ftyp, meta(start), box("mdat", before, exif.subarray(0, split), Buffer.alloc(16), exif.subarray(split), image)]);
}

const googlePhoto = (hex: string, at: number): ReaderOutput => ({
  kind: "img", key: hex, time: { start_ms: at, precision: "ms" },
  content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "application/octet-stream", role: "original" }] },
  blobs: [`sha256:${hex}`],
});

const resource = (hex: string | null) => ({
  type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC",
  ...(hex === null ? { blob: null, not_local: true } : { blob: { hash: `sha256:${hex}`, bytes: 24, type: "image/heic", role: "original" } }),
});

const libraryAsset = (local: string, at: number, hex: string | null): ReaderOutput => ({
  kind: "img", key: `${local}:null`, time: { start_ms: at, precision: "s" },
  content: { type: "photos.apple.asset", content: { local_identifier: local, media_type: "image", modification_date: null, creation_date: new Date(at).toISOString(), resources: [resource(hex)] } },
  ...(hex === null ? {} : { blobs: [`sha256:${hex}`] }),
});

const availability = (local: string, at: number, hex: string): ReaderOutput => ({
  kind: "img-file", key: `${local}:null:sha256:${"d".repeat(64)}`, time: { start_ms: at, precision: "s" },
  content: { type: "photos.apple.availability", content: { local_identifier: local, snapshot_replay_key: `${local}:snapshot`, resources: [resource(hex)] } },
  blobs: [`sha256:${hex}`],
});

const inAppPhoto = (key: string, at: number, hex: string): ReaderOutput => ({
  kind: "img", key, time: { start_ms: at, precision: "ms" },
  content: { type: "camera.photo", content: { payload: { blob: { hash: `sha256:${hex}`, type: "image/heic" } } } },
  blobs: [`sha256:${hex}`],
});

function bench(photos: readonly Registered<PhotosAdapter>[] = registered("photos")) {
  const home = openTestHome("connect-cameras-");
  const { db, blobs } = home;
  let labeler = camerasLabeler({ unit: UNIT, photos });
  let run = 0;
  let clock = T0;
  let since = { seq: 0, reread: 0 };
  const reads: { method: string; hash: string; bytes?: number }[] = [];
  const watched: BlobReader = {
    has: (hash) => blobs.has(hash),
    bytes: (hash) => (reads.push({ method: "bytes", hash }), blobs.bytes(hash)),
    text: (hash) => (reads.push({ method: "text", hash }), blobs.text(hash)),
    prefix: (hash, bytes) => (reads.push({ method: "prefix", hash, bytes }), blobs.prefix(hash, bytes)),
    materialise: (hash) => (reads.push({ method: "materialise", hash }), blobs.materialise(hash)),
  };
  const land = (source: string, rows: ReaderOutput[], guards = source === CAMERAS ? camerasConnector.kinds : GUARDS): Landed => db.commit((tx) => {
    const connector = source.startsWith("apple-photos:") ? "photos-ios-bundle" : source.startsWith("camera:") ? "camera-ios-bundle" : "synthetic";
    if (tx.tables.sources.get(source) === undefined) tx.tables.sources.add({ id: source, vendor: vendorOf(declarations(), source), connector, added_ms: T0 });
    return tx.records.land(++run, { id: `d${run}`, source, stated_ms: (clock += 1000) }, rows, guards, blobs);
  });
  return {
    home, blobs, land, reads,
    lend: (adapters: readonly Registered<PhotosAdapter>[]) => { labeler = camerasLabeler({ unit: UNIT, photos: adapters }); },
    startOver: () => { since = { seq: 0, reread: 0 }; },
    put: (bytes: Buffer) => blobs.put(bytes).slice("sha256:".length),
    async label(): Promise<{ facts: Json; lines: Json[]; landed: Landed } | null> {
      reads.length = 0;
      const view = db.view();
      const through = { seq: view.through, reread: view.newestReread() };
      let labelling;
      try {
        labelling = labeler.label(view, watched, since);
      } finally {
        view.close();
      }
      const output = await labelling;
      since = through;
      if (output === null) return null;
      const files = output.files.map((file) => ({ path: file.path, blob: blobs.put(fetchedBytes(file)), size: fetchedBytes(file).length }));
      const stated_ms = (clock += 1000);
      const delivery: Delivery = { id: `cameras-${run + 1}`, source: CAMERAS, sealed_ms: stated_ms, stated_ms, facts: output.facts, files };
      const rows = await collect(camerasConnector.read(delivery, blobs));
      const lines = fetchedBytes(output.files[0]!).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
      return { facts: output.facts, lines, landed: land(CAMERAS, rows) };
    },
    records<T>(kind: string): Record<string, T> {
      return Object.fromEntries(home.heads(CAMERAS, [kind]).filter((head) => !head.gone).map((head) => [head.key, head.content as T]));
    },
    read(method: string): string[] {
      return reads.filter((each) => each.method === method).map((each) => each.hash.slice("sha256:".length)).sort();
    },
  };
}

describe("the cameras labeler: each of these is impossible", () => {
  it("C1 C2 C3: a camera's photos are miscounted, an early JPEG is read twice or past its first window, or a run with nothing moved reads", async () => {
    const b = bench();
    const images = Array.from({ length: 49 }, (_, n) => b.put(shot("Synthetic Make", "Synthetic Camera", `frame ${n} ${"x".repeat(n === 0 ? 1 << 20 : 0)}`)));
    b.land(GOOGLE, images.map((hex, n) => googlePhoto(hex, T0 + n * 3_600_000)));
    b.land(GOOGLE_TWO, [googlePhoto(images[7]!, T0 + 7 * 3_600_000)]);
    const first = (await b.label())!;
    expect(first.facts).toEqual({ whole: true, read: 49, photos: 49, cameras: 1, sources: [{ id: CAMERAS, connector: "cameras" }] });
    expect(b.reads.filter((read) => read.method !== "prefix")).toEqual([]);
    expect(new Set(b.reads.map((read) => read.bytes))).toEqual(new Set([256 * 1024]));
    const camera = () => b.records<Camera>("camera")["synthetic-make/synthetic-camera"]!;
    expect(camera()).toEqual({
      type: "cameras.camera", make: "Synthetic Make", model: "Synthetic Camera", photos: 49,
      first_ms: T0, last_ms: T0 + 48 * 3_600_000, sample: `sha256:${images[48]}`, phones: [],
    });
    expect(Object.values(b.records<{ camera: string }>("photo")).every((photo) => photo.camera === "synthetic-make/synthetic-camera")).toBe(true);
    expect(await b.label()).toBeNull();
    expect(b.reads).toEqual([]);

    const fiftieth = b.put(shot("Synthetic Make", "Synthetic Camera", "frame 49"));
    b.land(GOOGLE, [googlePhoto(fiftieth, T0 + 49 * 3_600_000)]);
    const second = (await b.label())!;
    expect(b.read("prefix")).toEqual([fiftieth]);
    expect(second.lines.map((line) => (line as { kind: string }).kind)).toEqual(["photo", "camera"]);
    expect(camera()).toMatchObject({ photos: 50, last_ms: T0 + 49 * 3_600_000, sample: `sha256:${fiftieth}` });
    const corrected = googlePhoto(images[0]!, T0 - 3_600_000);
    b.land(GOOGLE, [{ ...corrected, content: { ...(corrected.content as Record<string, Json>), title: "IMG_0001.JPG" } }]);
    expect(await b.label()).not.toBeNull();
    expect(b.reads).toEqual([]);
    expect(camera()).toMatchObject({ photos: 50, first_ms: T0 - 3_600_000 });
    artifact(b.home.dir, "count.json", { first: first.facts, second: second.facts, camera: camera() as unknown as Json });
  });

  it("C4 C5 C8: one camera spelled two ways is two, or the same camera under a reinstalled phone's unit is another, or a HEIC's distant, split EXIF item is not read", async () => {
    const b = bench();
    const spellings = [["SONY", "ILCE-7M3"], ["  Sony", "ILCE-7M3 "], ["Sony \0\0", " ILCE-7M3\0"]] as const;
    const sony = spellings.map(([make, model], n) => b.put(shot(make, model, `sony ${n}`)));
    b.land(GOOGLE, sony.map((hex, n) => googlePhoto(hex, T0 + n)));
    const before = b.put(heic("Apple", "iPhone 17 Pro", "before", 1 << 20));
    const after = b.put(shot("Apple", "iPhone 17 Pro", "after"));
    b.land(LIBRARY, [libraryAsset("AAAA-0001", T0 + 10, before)]);
    b.land(REINSTALLED, [libraryAsset("BBBB-0001", T0 + 20, after)]);
    await b.label();
    const cameras = b.records<Camera>("camera");
    expect(Object.keys(cameras).sort()).toEqual(["apple/iphone-17-pro", "sony/ilce-7m3"]);
    expect(cameras["sony/ilce-7m3"]).toMatchObject({ photos: 3 });
    expect([cameras["sony/ilce-7m3"]!.make, cameras["sony/ilce-7m3"]!.model]).toEqual([
      ["SONY", "ILCE-7M3"], ["Sony", "ILCE-7M3"], ["Sony", "ILCE-7M3"],
    ][sony.indexOf([...sony].sort()[0]!)]);
    expect(cameras["apple/iphone-17-pro"]).toMatchObject({ make: "Apple", model: "iPhone 17 Pro", photos: 2, first_ms: T0 + 10, last_ms: T0 + 20 });
    expect(b.records<{ camera: string }>("photo")[before]).toEqual({ type: "cameras.photo", camera: "apple/iphone-17-pro" });
    artifact(b.home.dir, "cameras.json", cameras as unknown as Json);
  });

  it("C6 C9: a paired phone's photo not held is not counted under its phone, stays there once its original arrives (an `img-file`, its own kind), or a photo naming no camera counts", async () => {
    const b = bench();
    const screenshot = b.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]));
    const snapped = b.put(heic("Apple", "iPhone 17 Pro", "in-app"));
    b.land(LIBRARY, [libraryAsset("AAAA-0001", T0 + 1_000, null), libraryAsset("AAAA-0002", T0 + 2_000, screenshot)]);
    b.land(IN_APP, [inAppPhoto("in-app-1", T0 + 3_000, snapped), inAppPhoto("in-app-2", T0 + 4_000, "e".repeat(64))]);
    await b.label();
    expect(b.read("prefix")).toEqual([screenshot, snapped].sort());
    let cameras = b.records<Camera>("camera");
    expect(Object.keys(cameras).sort()).toEqual(["apple/iphone-17-pro", "phone/iphone-aa01"]);
    expect(cameras["phone/iphone-aa01"]).toEqual({ type: "cameras.camera", make: null, model: null, photos: 2, first_ms: T0 + 1_000, last_ms: T0 + 4_000, sample: null, phones: [] });
    expect(Object.keys(b.records("photo"))).toEqual([snapped]);

    const original = b.put(shot("Apple", "iPhone 17 Pro", "original"));
    b.land(LIBRARY, [availability("AAAA-0001", T0 + 7 * 86_400_000, original)]);
    await b.label();
    expect(b.read("prefix")).toEqual([original]);
    cameras = b.records<Camera>("camera");
    expect(cameras["phone/iphone-aa01"]).toMatchObject({ photos: 1, first_ms: T0 + 4_000, last_ms: T0 + 4_000 });
    expect(cameras["apple/iphone-17-pro"]).toMatchObject({ photos: 2, first_ms: T0 + 1_000, last_ms: T0 + 3_000 });
    artifact(b.home.dir, "phone.json", cameras as unknown as Json);
  });

  it("C15: an EXIF's GPS is not stated, is read in the wrong hemisphere, a void or unhemisphered one is stated, or a cursor started over leaves a record without it", async () => {
    const b = bench();
    const camera = { make: "Synthetic Make", model: "Synthetic Camera" };
    const south = b.put(jpeg(tiff({ ...camera, gps: { latitude: -22.9068, longitude: -43.1729 } }), "south"));
    const north = b.put(heic("Apple", "iPhone 17 Pro", "north"));
    const northGps = b.put(jpeg(tiff({ ...camera, gps: { latitude: 35.6762, longitude: 139.6503 } }), "north-gps"));
    const voided = b.put(jpeg(tiff({ ...camera, gps: { latitude: 35.6762, longitude: 139.6503, status: "V" } }), "void"));
    const bare = b.put(jpeg(tiff({ ...camera, gps: { latitude: 35.6762, longitude: 139.6503, hemispheres: false } }), "bare"));
    b.land(GOOGLE, [south, north, northGps, voided, bare].map((hex, index) => googlePhoto(hex, T0 + index)));
    const other = b.put(jpeg(tiff({ make: "Other Make", model: "Other Phone", gps: { latitude: 51.5074, longitude: -0.1278 } }), "other"));
    b.land(GOOGLE_TWO, [googlePhoto(other, T0 + 9)]);
    await b.label();
    const photos = b.records<CameraPhoto>("photo");
    const near = (gps: CameraPhoto["gps"], latitude: number, longitude: number) =>
      gps !== undefined && Math.abs(gps.latitude - latitude) < 1e-6 && Math.abs(gps.longitude - longitude) < 1e-6;
    expect(near(photos[south]!.gps, -22.9068, -43.1729)).toBe(true);
    expect(near(photos[northGps]!.gps, 35.6762, 139.6503)).toBe(true);
    expect(near(photos[other]!.gps, 51.5074, -0.1278)).toBe(true);
    expect(photos[other]!.camera).toBe("other-make/other-phone");
    for (const hex of [north, voided, bare]) expect(Object.keys(photos[hex]!).sort()).toEqual(["camera", "type"]);
    artifact(b.home.dir, "gps.json", photos as unknown as Json);

    b.land(CAMERAS, [south, northGps].map((hex) => ({ kind: "photo", key: hex, content: { type: "cameras.photo", camera: "synthetic-make/synthetic-camera" } })));
    b.startOver();
    const again = (await b.label())!;
    expect(again.lines.filter((line) => (line as { kind: string }).kind === "photo").map((line) => (line as { key: string }).key).sort()).toEqual([south, northGps].sort());
    expect(near(b.records<CameraPhoto>("photo")[south]!.gps, -22.9068, -43.1729)).toBe(true);
  });

  it("C17: a bare TIFF whose Exif pointer lies past its end loses the camera its first directory names", async () => {
    const b = bench();
    const torn = tiff({ make: "Torn Make", model: "Torn Camera" });
    torn.writeUInt32LE(1 << 20, 54);
    const hex = b.put(torn);
    b.land(GOOGLE, [googlePhoto(hex, T0)]);
    await b.label();
    expect(b.records<{ camera: string }>("photo")[hex]).toEqual({ type: "cameras.photo", camera: "torn-make/torn-camera" });
  });

  it("C10: a photo stated gone keeps its count, or a camera with no photo left keeps its record", async () => {
    const b = bench();
    const [one, two] = ["one", "two"].map((body) => b.put(shot("Synthetic Make", "Synthetic Camera", body))) as [string, string];
    b.land(GOOGLE, [googlePhoto(one, T0), googlePhoto(two, T0 + 1_000)]);
    await b.label();
    b.land(GOOGLE, [{ kind: "img", key: two, content: null, gone: true }]);
    await b.label();
    expect(Object.keys(b.records("photo"))).toEqual([one]);
    expect(b.records<Camera>("camera")["synthetic-make/synthetic-camera"]).toMatchObject({ photos: 1, first_ms: T0, last_ms: T0, sample: `sha256:${one}` });
    b.land(GOOGLE, [{ kind: "img", key: one, content: null, gone: true }]);
    const last = (await b.label())!;
    expect([b.records("photo"), b.records("camera")]).toEqual([{}, {}]);
    expect(last.landed).toMatchObject({ gone: 2 });
    expect(b.reads).toEqual([]);
  });

  it("C12: a paired phone's own camera is not its phone from its first photo, or a friend's camera saved into its library is", async () => {
    const b = bench();
    const phone = "apple-photos:person-a@example.com:iphone-17-pro-0042";
    const own = ["one", "two", "three"].map((body) => b.put(heic("Apple", "iPhone 17 Pro", body)));
    const friends = b.put(shot("Google", "Pixel 9", "saved"));
    b.land(phone, [...own.map((hex, n) => libraryAsset(`CCCC-000${n}`, T0 + n, hex)), libraryAsset("CCCC-0009", T0 + 9, friends)]);
    b.land(GOOGLE, [googlePhoto(b.put(shot("Apple", "iPhone 17 Pro", "takeout")), T0 + 10)]);
    await b.label();
    const cameras = b.records<Camera>("camera");
    expect(cameras["apple/iphone-17-pro"]).toMatchObject({ photos: 4, phones: ["iphone-17-pro-0042"] });
    expect(cameras["google/pixel-9"]).toMatchObject({ photos: 1, phones: [] });
    artifact(b.home.dir, "phones.json", cameras as unknown as Json);
  });

  it("C16: a phone paired under its machine id is its own camera's phone, a saved photo makes no phone, and a bracketed model gets no trailing dash", async () => {
    const b = bench();
    const phone = "apple-photos:person-a@example.com:iphone17-1-aa01";
    const own = ["one", "two", "three"].map((body) => b.put(heic("Apple", "iPhone 16 Pro", body)));
    const saved = b.put(shot("Apple", "iPhone SE (3rd generation)", "saved"));
    const screenshot = b.put(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]));
    b.land(phone, [...own.map((hex, n) => libraryAsset(`DDDD-000${n}`, T0 + n, hex)), libraryAsset("DDDD-0008", T0 + 8, saved), libraryAsset("DDDD-0009", T0 + 9, screenshot)]);
    await b.label();
    const cameras = b.records<Camera>("camera");
    expect(Object.keys(cameras).sort()).toEqual(["apple/iphone-16-pro", "apple/iphone-se-3rd-generation"]);
    expect(cameras["apple/iphone-16-pro"]).toMatchObject({ photos: 3, phones: ["iphone17-1-aa01"] });
    expect(cameras["apple/iphone-se-3rd-generation"]).toMatchObject({ photos: 1, phones: [] });
    artifact(b.home.dir, "machine-id.json", cameras as unknown as Json);
  });

  it("C13: an erased photo's image keeps its count, or its record is stated again", async () => {
    const b = bench();
    const [kept, erased] = ["kept", "erased"].map((body) => b.put(shot("Synthetic Make", "Synthetic Camera", body))) as [string, string];
    b.land(GOOGLE, [googlePhoto(kept, T0), googlePhoto(erased, T0 + 1_000)]);
    await b.label();
    b.home.db.commit((tx) => tx.records.erase({
      records: [{ source: GOOGLE, kind: "img", key: erased }, { source: CAMERAS, kind: "photo", key: erased }],
      units: [{ family: "photos", unit: `${GOOGLE}/2026-10-01` }], reason: "a synthetic erasure", at_ms: T0,
    }));
    const after = (await b.label())!;
    expect(after.lines.map((line) => [(line as { kind: string }).kind, (line as { key: string }).key])).toEqual([["camera", "synthetic-make/synthetic-camera"]]);
    expect(Object.keys(b.records("photo"))).toEqual([kept]);
    expect(b.records<Camera>("camera")["synthetic-make/synthetic-camera"]).toMatchObject({ photos: 1, sample: `sha256:${kept}` });
    expect(b.reads).toEqual([]);
  });

  it("C14: a cursor started over leaves a photo record an older rule stated", async () => {
    const b = bench();
    const image = b.put(shot("Synthetic Make", "Synthetic Camera", "renamed"));
    b.land(GOOGLE, [googlePhoto(image, T0)]);
    await b.label();
    b.land(CAMERAS, [{ kind: "photo", key: image, content: { type: "cameras.photo", camera: "synthetic/synthetic-camera" } }]);
    b.startOver();
    const again = (await b.label())!;
    expect(again.facts).toMatchObject({ whole: true, read: 1 });
    expect(b.records<{ camera: string }>("photo")[image]).toEqual({ type: "cameras.photo", camera: "synthetic-make/synthetic-camera" });
  });

  it("C18: an adapter that now finds an image in an old record is read by it once the home's start sets its cursor over", async () => {
    const blind = registered("photos").map((each) => each.product === "google-photos" ? { ...each, adapter: Object.assign(Object.create(each.adapter) as PhotosAdapter, { image: () => null }) } : each);
    const b = bench(blind);
    const image = b.put(shot("Synthetic Make", "Synthetic Camera", "found later"));
    b.land(GOOGLE, [googlePhoto(image, T0)]);
    expect(await b.label()).toBeNull();
    b.lend(registered("photos"));
    expect([await b.label(), b.reads]).toEqual([null, []]);
    b.startOver();
    const whole = (await b.label())!;
    expect([whole.facts, b.records<CameraPhoto>("photo")[image]?.camera]).toEqual([
      { whole: true, read: 1, photos: 1, cameras: 1, sources: [{ id: CAMERAS, connector: "cameras" }] }, "synthetic-make/synthetic-camera",
    ]);
  });

  it("C19: a photo record of its own a repair restated is stated again; its own delivery's landing, nothing undone, reads no image", async () => {
    const b = bench();
    const [undone, kept] = ["undone", "kept"].map((body) => b.put(shot("Synthetic Make", "Synthetic Camera", body))) as [string, string];
    b.land(GOOGLE, [googlePhoto(undone, T0), googlePhoto(kept, T0 + 1_000)]);
    await b.label();
    expect(await b.label()).toBeNull();
    const run = b.home.db.commit((tx) => tx.tables.runs.start({ kind: "repair", subject: CAMERAS, started_ms: T0 }));
    const view = b.home.db.view();
    const plan = view.planRepair({ source: CAMERAS, kinds: ["photo"], run, fix: (head) => (head.key === undone ? "gone" : "keep") });
    view.close();
    b.home.db.commit((tx) => tx.records.applyRepair(run, plan, { has: () => true }));
    expect(Object.keys(b.records("photo"))).toEqual([kept]);
    const restated = (await b.label())!;
    expect([(restated.facts as { whole: boolean }).whole, restated.lines.map((line) => [(line as { kind: string }).kind, (line as { key: string }).key])]).toEqual([true, [["photo", undone]]]);
    expect(Object.keys(b.records("photo")).sort()).toEqual([kept, undone].sort());
    expect([await b.label(), b.reads]).toEqual([null, []]);
    artifact(b.home.dir, "repaired.json", restated.lines);
  });

  it("C11: the connector lands part of a delivery with a bad line", async () => {
    const b = bench();
    const good = JSON.stringify({ content: { camera: "apple/iphone-17-pro", type: "cameras.photo" }, key: "a".repeat(64), kind: "photo" });
    const bad: [string, unknown][] = [
      ["a camera that is no id", { content: { camera: "Apple iPhone", type: "cameras.photo" }, key: "a".repeat(64), kind: "photo" }],
      ["a photo keyed otherwise", { content: { camera: "apple/iphone-17-pro", type: "cameras.photo" }, key: "IMG_0001", kind: "photo" }],
      ["a count of none", { content: { type: "cameras.camera", make: "Apple", model: "iPhone", photos: 0, first_ms: null, last_ms: null, sample: null, phones: [] }, key: "apple/iphone", kind: "camera" }],
      ["first after last", { content: { type: "cameras.camera", make: "Apple", model: "iPhone", photos: 1, first_ms: 2, last_ms: 1, sample: null, phones: [] }, key: "apple/iphone", kind: "camera" }],
      ["a make without a model", { content: { type: "cameras.camera", make: "Apple", model: null, photos: 1, first_ms: null, last_ms: null, sample: null, phones: [] }, key: "apple/iphone", kind: "camera" }],
      ["a member more", { content: { camera: "apple/iphone-17-pro", type: "cameras.photo", device: "iphone-aa01" }, key: "a".repeat(64), kind: "photo" }],
      ["another kind", { content: {}, key: "a".repeat(64), kind: "image" }],
      ["not JSON", "{not json"],
    ];
    const refusals: Record<string, string> = {};
    for (const [name, line] of bad) {
      const text = `${good}\n${typeof line === "string" ? line : JSON.stringify(line)}\n`;
      const delivery: Delivery = { id: "c", source: CAMERAS, sealed_ms: T0, stated_ms: T0, facts: {}, files: [{ path: CAMERAS_FILE, blob: b.blobs.put(Buffer.from(text)), size: text.length }] };
      const error = await collect(camerasConnector.read(delivery, b.blobs)).then(() => null, (thrown: Error) => thrown);
      expect(error, name).toBeInstanceOf(Refused);
      expect(error!.message, name).toContain(`${CAMERAS_FILE} line 2`);
      refusals[name] = error!.message;
    }
    expect(refusals["a count of none"]).toContain("photos must be a whole number of at least 1");
    expect(refusals["first after last"]).toContain("first_ms and last_ms must be integer milliseconds, first not after last, or both null");
    expect(refusals["a make without a model"]).toContain("make and model must both be trimmed text, or both null");
    const gone = `${good}\n${JSON.stringify({ gone: true, key: "apple/iphone-17-pro", kind: "camera" })}\n`;
    const rows = await collect(camerasConnector.read({ id: "c", source: CAMERAS, sealed_ms: T0, stated_ms: T0, facts: {}, files: [{ path: CAMERAS_FILE, blob: b.blobs.put(Buffer.from(gone)), size: gone.length }] }, b.blobs));
    expect(rows.map((row) => [row.kind, row.gone === true])).toEqual([["photo", false], ["camera", true]]);
    artifact(b.home.dir, "refusals.json", refusals);
  });
});
