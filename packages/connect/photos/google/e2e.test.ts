import { CONSUMED, type Delivery, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { artifact, collect, deliver, openTestHome, readStoring, temp, type TestHome } from "../../test/drive.js";
import { googlePhotosAdapter } from "./adapter.js";
import { fix } from "./photos-repair.js";
import { googlePhotosTakeout } from "./reader.js";
import { ACCOUNT, ALBUM, EXPORTED_AT, FACTS, firstFile, hexOf, jpeg, LONG, MEDIA, MODEL, MOTION, NAMED_ALBUM, secondFile, sidecar, SOURCE, STAMP, takeoutZip, zipName } from "./test/fixtures.js";

function sealed(home: TestHome, seq: number, members: readonly [string, Buffer][], beside: readonly Delivery[] = [], facts: JsonObject = FACTS): Delivery {
  const path = takeoutZip(temp("photos-google-"), seq, members);
  return besides(deliver(home, SOURCE, { [`files/${zipName(seq)}`]: path }, facts), beside);
}

function besides(delivery: Delivery, beside: readonly Delivery[]): Delivery {
  const files = beside.flatMap((other) => other.files.map((file) => ({ path: `${other.id}/${file.path}`, blob: file.blob, size: file.size })));
  const { beside: _was, ...facts } = delivery.facts;
  return { ...delivery, facts: files.length === 0 ? facts : { ...facts, beside: files } };
}

async function read(home: TestHome, delivery: Delivery): Promise<{ rows: ReaderOutput[]; landed: Awaited<ReturnType<TestHome["land"]>> }> {
  const rows = await readStoring(googlePhotosTakeout, delivery, home.blobs);
  return { rows, landed: await home.land(googlePhotosTakeout, delivery, rows) };
}

const refusals = (rows: readonly ReaderOutput[]) => rows.filter((row) => row.refused !== undefined).map((row) => [row.key.slice(row.key.indexOf("Takeout/")), row.refused]);
const consumed = (rows: readonly ReaderOutput[]) => rows.filter((row) => row.kind === CONSUMED).map((row) => row.key);
const key = (bytes: Buffer) => hexOf(bytes);
const seconds = (head: { start_ms: number | null }) => (head.start_ms === null ? null : head.start_ms / 1000);

describe("google photos from a takeout: each of these is impossible", () => {
  it("a photo whose sidecar lies in another file of the archive is lost, stated without its time, or lets its file go before it is read whole", async () => {
    const home = openTestHome();
    const first = sealed(home, 1, firstFile());
    const one = await read(home, first);
    expect(one.landed).toMatchObject({ new: 4, refused: 1 });
    expect(refusals(one.rows)).toEqual([[`${ALBUM}/IMG_0002.jpg`, expect.stringMatching(/^waiting for its sidecar/u)]]);
    expect(consumed(one.rows)).toEqual([]);
    const second = sealed(home, 2, secondFile(), [first]);
    const two = await read(home, second);
    expect(two.landed).toMatchObject({ new: 6, refused: 1 });
    expect(refusals(two.rows)).toEqual([[`${ALBUM}/IMG_0007.jpg`, expect.stringMatching(/^waiting for its sidecar/u)]]);
    expect(consumed(two.rows)).toEqual([]);
    const again = await read(home, besides(first, [second]));
    expect(again.landed).toMatchObject({ new: 1, refused: 0 });
    expect(consumed(again.rows)).toEqual([`files/${zipName(1)}`]);

    const heads = home.heads(SOURCE);
    const of = (bytes: Buffer) => heads.find((head) => head.key === key(bytes));
    expect(heads.map((head) => head.kind)).toEqual(Array(11).fill("img"));
    expect(Object.fromEntries(Object.entries(MEDIA).map(([name, bytes]) => [name, of(bytes) === undefined ? null : seconds(of(bytes)!)]))).toEqual({
      plain: 1788775200, split: 1788778800, original: 1788782400, copy: 1788786000, edited: 1788782400, motion: 1788603300, motionVideo: 1788603300,
      live: 1788790000, liveVideo: 1788790000, video: 1788793600, long: 1788687000, lone: null,
    });
    const stated = JSON.parse(sidecar("IMG_0001.jpg", "1788775200").toString("utf8")) as JsonObject;
    expect(of(MEDIA.plain)!.content).toEqual({ type: "photos.asset", ...stated, blobs: [{ hash: `sha256:${key(MEDIA.plain)}`, bytes: MEDIA.plain.length, media_type: "image/jpeg", role: "original" }] });
    expect(Object.fromEntries(Object.entries(MEDIA).filter(([name]) => name !== "lone").map(([name, bytes]) => [name, ((of(bytes)!.content as { blobs: { media_type: string }[] }).blobs[0]!.media_type)]))).toEqual({
      plain: "image/jpeg", split: "image/jpeg", original: "image/jpeg", copy: "image/jpeg", edited: "image/jpeg", motion: "image/jpeg", motionVideo: "video/mp4",
      live: "image/heic", liveVideo: "video/quicktime", video: "video/mp4", long: "image/jpeg",
    });
    const titleOf = (bytes: Buffer) => (of(bytes)!.content as { title: string }).title;
    expect([titleOf(MEDIA.copy), titleOf(MEDIA.edited), titleOf(MEDIA.liveVideo), titleOf(MEDIA.motionVideo)]).toEqual(["IMG_0003.jpg", "IMG_0003-edited.jpg", "IMG_0005.MOV", MOTION]);
    for (const row of [...one.rows, ...two.rows, ...again.rows].filter((each) => each.kind === "img")) {
      expect([row.bytes, row.blobs, row.streamed?.map((each) => each.hash), hexOf(home.blobs.bytes(`sha256:${row.key}`))]).toEqual([undefined, [`sha256:${row.key}`], [`sha256:${row.key}`], row.key]);
    }
    artifact(home.dir, "heads.json", { landed: { one: one.landed, two: two.landed, again: again.landed }, refusals: { one: refusals(one.rows), two: refusals(two.rows) }, consumed: consumed(again.rows), heads });
  });

  it("a sidecar that lands before its photo is lost, or its photo is stated by any read but its own file's", async () => {
    const home = openTestHome();
    const second = sealed(home, 2, secondFile());
    const two = await read(home, second);
    expect(refusals(two.rows)).toEqual([
      [`${ALBUM}/IMG_0002.jpg.supplemental-metadata.json`, expect.stringMatching(/^waiting for its photo/u)],
      [`${ALBUM}/IMG_0007.jpg`, expect.stringMatching(/^waiting for its sidecar/u)],
    ]);
    const first = sealed(home, 1, firstFile(), [second]);
    const one = await read(home, first);
    expect(one.landed).toMatchObject({ new: 5, refused: 0 });
    expect(consumed(one.rows)).toEqual([`files/${zipName(1)}`]);
    const again = await read(home, besides(second, [first]));
    expect(again.landed).toMatchObject({ new: 0, refused: 1 });
    expect(refusals(again.rows)).toEqual([[`${ALBUM}/IMG_0007.jpg`, expect.stringMatching(/^waiting for its sidecar/u)]]);
    expect(seconds(home.heads(SOURCE).find((head) => head.key === key(MEDIA.split))!)).toBe(1788778800);
    artifact(home.dir, "order.json", { two: refusals(two.rows), one: one.landed, again: again.landed, heads: home.heads(SOURCE).length });
  });

  it("a delivery read again writes anything new, a later export missing a photo states it gone, a stored delivery naming a device map stops reading or states a device, or another account's export is read", async () => {
    const home = openTestHome();
    const first = sealed(home, 1, firstFile());
    await read(home, first);
    const twice = await read(home, first);
    expect(twice.landed).toMatchObject({ new: 0, gone: 0 });
    const later = sealed(home, 1, [[`${ALBUM}/IMG_0001.jpg`, MEDIA.plain], [`${ALBUM}/IMG_0001.jpg.supplemental-metadata.json`, sidecar("IMG_0001.jpg", "1788775200")]],
      [], { ...FACTS, import: { kind: "google-takeout", id: "20260920T000000Z" }, exported_at: "2026-09-20T00:00:00Z", device_map: [{ model: MODEL, unit: "synthetic-phone-aa01" }] });
    const restated = await read(home, later);
    expect(restated.landed).toMatchObject({ gone: 0 });
    expect(restated.rows.map((row) => row.device)).toEqual(restated.rows.map(() => undefined));
    expect(home.heads(SOURCE).filter((head) => head.gone)).toEqual([]);
    expect(home.heads(SOURCE)).toHaveLength(4);
    const other = sealed(home, 2, secondFile(), [], { ...FACTS, account: "person-b@example.com" });
    expect(await collect(googlePhotosTakeout.read(other, home.blobs))).toEqual([]);
    artifact(home.dir, "again.json", { twice: twice.landed, later: restated.landed, heads: home.heads(SOURCE) });
  });

  it("a member that does not read refuses more than itself, or a photo is stated without a time it can read", async () => {
    const home = openTestHome();
    const good = jpeg(MODEL, "a good photo");
    const members: [string, Buffer][] = [
      [`${ALBUM}/IMG_0101.jpg`, good],
      [`${ALBUM}/IMG_0101.jpg.supplemental-metadata.json`, sidecar("IMG_0101.jpg", "1788775200")],
      [`${ALBUM}/IMG_0102.jpg`, Buffer.from("these bytes are no photo")],
      [`${ALBUM}/IMG_0102.jpg.supplemental-metadata.json`, sidecar("IMG_0102.jpg", "1788775200")],
      [`${ALBUM}/IMG_0103.jpg`, jpeg(MODEL, "photo 103")],
      [`${ALBUM}/IMG_0103.jpg.supplemental-metadata.json`, sidecar("IMG_0103.jpg", "1788775200").subarray(0, 40)],
      [`${ALBUM}/IMG_0104.jpg`, jpeg(MODEL, "photo 104")],
      [`${ALBUM}/IMG_0104.jpg.supplemental-metadata.json`, sidecar("IMG_0104.jpg", "1788775200", "1788775200", { type: "synthetic" })],
      [`${ALBUM}/IMG_0105.jpg`, jpeg(MODEL, "photo 105")],
      [`${ALBUM}/IMG_0105.jpg.supplemental-metadata.json`, Buffer.from(JSON.stringify({ title: "IMG_0105.jpg", photoTakenTime: { timestamp: "0" } }))],
      [`${NAMED_ALBUM}/shared_album_comments.json`, Buffer.from("[]")],
    ];
    const { rows, landed } = await read(home, sealed(home, 1, members));
    expect(landed).toMatchObject({ new: 1, refused: 4 });
    expect(refusals(rows)).toEqual([
      [`${ALBUM}/IMG_0102.jpg`, expect.stringMatching(/its first bytes are no photo's or video's$/u)],
      [`${ALBUM}/IMG_0103.jpg`, expect.stringMatching(/its sidecar \S+.*IMG_0103\.jpg\.supplemental-metadata\.json does not read/u)],
      [`${ALBUM}/IMG_0104.jpg`, expect.stringMatching(/states a member type, which is the content's own$/u)],
      [`${ALBUM}/IMG_0105.jpg`, expect.stringMatching(/states no time: neither photoTakenTime nor creationTime$/u)],
    ]);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual([key(good)]);
    expect(consumed(rows)).toEqual([]);
    artifact(home.dir, "refusals.json", { landed, refusals: refusals(rows), stamp: STAMP, account: ACCOUNT, exported_at: EXPORTED_AT, motion: MOTION, long: LONG });
  });
  it("a photo in two files of the archive is stated by both, or by the later file's read; a group of names sharing a first dot pairs a photo with another's sidecar", async () => {
    const home = openTestHome();
    const both = jpeg(MODEL, "a photo in two albums");
    const dotted = [jpeg(MODEL, "a dotted name"), jpeg(MODEL, "another dotted name")] as const;
    const first = sealed(home, 1, [[`${NAMED_ALBUM}/IMG_0201.jpg`, both], [`${NAMED_ALBUM}/IMG_0201.jpg.supplemental-metadata.json`, sidecar("IMG_0201.jpg", "1788775200")]]);
    expect((await read(home, first)).landed).toMatchObject({ new: 1, refused: 0 });
    const second = sealed(home, 2, [
      [`${ALBUM}/IMG_0201.jpg`, both], [`${ALBUM}/IMG_0201.jpg.supplemental-metadata.json`, sidecar("IMG_0201.jpg", "1788779999")],
      [`${ALBUM}/2026.01.05 a.jpg`, dotted[0]], [`${ALBUM}/2026.01.05 a.jpg.supplemental-metadata.json`, sidecar("2026.01.05 a.jpg", "1788700001")],
      [`${ALBUM}/2026.01.05 b.jpg`, dotted[1]], [`${ALBUM}/2026.01.05 b.jpg.supplemental-metadata.json`, sidecar("2026.01.05 b.jpg", "1788700002")],
    ], [first]);
    const two = await read(home, second);
    expect(two.rows.filter((row) => row.kind === "img").map((row) => row.key).sort()).toEqual(dotted.map(key).sort());
    expect(consumed(two.rows)).toEqual([`files/${zipName(2)}`]);
    const heads = home.heads(SOURCE);
    expect(heads.map((head) => [head.key, seconds(head)]).sort()).toEqual([[key(both), 1788775200], [key(dotted[0]), 1788700001], [key(dotted[1]), 1788700002]].sort());
    artifact(home.dir, "once.json", { two: two.landed, heads });
  });

  it("a record of the index route repaired is not the version a read of its Takeout states, or loses its key", async () => {
    const home = openTestHome();
    const bytes = jpeg(MODEL, "a photo of the index route");
    const hash = `sha256:${key(bytes)}`;
    const stated = sidecar("IMG_0301.jpg", "1788775200");
    const album = sidecar("IMG_0301.jpg", "1788775200", "1788800000", { description: "the album's copy" });
    for (const each of [bytes, stated, album]) home.blobs.put(each);
    const indexed = {
      type: "photos.asset",
      takeout_sources: [{ archive: zipName(1), media_path: `${ALBUM}/IMG_0301.jpg`, raw_sidecars: [{ member_path: `${ALBUM}/IMG_0301.jpg.supplemental-metadata.json` }, { member_path: `${NAMED_ALBUM}/IMG_0301.jpg.supplemental-metadata.json` }] }],
      blobs: [
        { hash, bytes: bytes.length, media_type: "application/octet-stream", role: "original" },
        { hash: `sha256:${key(album)}`, bytes: album.length, media_type: "application/json", role: `raw_sidecar:${NAMED_ALBUM}/IMG_0301.jpg.supplemental-metadata.json` },
        { hash: `sha256:${key(stated)}`, bytes: stated.length, media_type: "application/json", role: `raw_sidecar:${ALBUM}/IMG_0301.jpg.supplemental-metadata.json` },
      ],
    };
    const repaired = fix({ id: "sha256:synthetic", kind: "img", key: key(bytes), content: indexed } as never, home.blobs);
    const read = await collect(googlePhotosTakeout.read(sealed(home, 1, [[`${ALBUM}/IMG_0301.jpg`, bytes], [`${ALBUM}/IMG_0301.jpg.supplemental-metadata.json`, stated]]), home.blobs));
    const row = read.find((each) => each.kind === "img")!;
    const fromAlbum = await collect(googlePhotosTakeout.read(sealed(home, 2, [[`${NAMED_ALBUM}/IMG_0301.jpg`, bytes], [`${NAMED_ALBUM}/IMG_0301.jpg.supplemental-metadata.json`, album]]), home.blobs));
    expect(repaired).toEqual({ content: fromAlbum.find((each) => each.kind === "img")!.content, time: row.time, blobs: [hash] });
    expect(row.key).toBe(key(bytes));
    expect(fix({ id: "sha256:synthetic", kind: "img", key: row.key, content: row.content } as never, home.blobs)).toBe("keep");
    artifact(home.dir, "repair.json", { indexed, repaired });
  });

  it("a Live Photo's or motion photo's video is a photo of its own, read otherwise from its video than from its still, or a video is read as a picture", async () => {
    const home = openTestHome();
    const first = sealed(home, 1, firstFile());
    await read(home, first);
    const second = sealed(home, 2, secondFile(), [first]);
    await read(home, second);
    await read(home, besides(first, [second]));
    const view = home.db.view();
    try {
      const source = view.sources().find((row) => row.id === SOURCE)!;
      const copyOf = (bytes: Buffer) => googlePhotosAdapter.copy(view, source, key(bytes))!;
      const shape = (bytes: Buffer) => {
        const { id, records, names, video, originals, motion, files, resources, duration_ms } = copyOf(bytes);
        return {
          id, records: records.map((record) => record.key), names, video, originals: originals.map((file) => [file.sha256, file.media_type]),
          motion: [motion.renders, motion.originals].map((part) => part.map((file) => [file.sha256, file.media_type])), files, resources: resources.map((each) => [each.type, each.name, each.size, each.files]), duration_ms,
        };
      };
      const pair = (still: Buffer, movie: Buffer, names: string[], types: [string, string]) => ({
        id: key(still), records: [key(still), key(movie)], names, video: false, originals: [[key(still), types[0]]], motion: [[], [[key(movie), types[1]]]],
        files: [key(still), key(movie)], resources: [["original", names[0], still.length, [key(still)]], ["motion", names[1], movie.length, [key(movie)]]], duration_ms: null,
      });
      const live = pair(MEDIA.live, MEDIA.liveVideo, ["IMG_0005.HEIC", "IMG_0005.MOV"], ["image/heic", "video/quicktime"]);
      const motion = pair(MEDIA.motion, MEDIA.motionVideo, [`${MOTION}.jpg`, MOTION], ["image/jpeg", "video/mp4"]);
      expect([shape(MEDIA.live), shape(MEDIA.liveVideo), shape(MEDIA.motion), shape(MEDIA.motionVideo)]).toEqual([live, live, motion, motion]);
      expect(shape(MEDIA.video)).toMatchObject({ id: key(MEDIA.video), records: [key(MEDIA.video)], names: ["VID_0006.mp4"], video: true, motion: [[], []] });
      expect([shape(MEDIA.edited), shape(MEDIA.copy)].map((each) => [each.records.length, each.video, each.motion])).toEqual([[1, false, [[], []]], [1, false, [[], []]]]);
      const image = (bytes: Buffer) => googlePhotosAdapter.image(view, source, view.version(view.head({ source: SOURCE, kind: "img", key: key(bytes) })!.version), key(bytes));
      expect([MEDIA.live, MEDIA.liveVideo, MEDIA.motionVideo, MEDIA.video].map(image)).toEqual([key(MEDIA.live), null, null, null]);
      artifact(home.dir, "copies.json", { live, motion, video: shape(MEDIA.video) });
    } finally {
      view.close();
    }
  });
});
