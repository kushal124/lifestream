import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, macBundle, openTestHome } from "../../test/drive.js";
import { applePhotosAdapter } from "./adapter.js";
import { photosMac } from "./reader.js";
import { fix } from "./img-file-repair.js";
import { photos as photosPhone } from "./phone.js";
import { bundle, sealedFiles } from "../../ios-app/phone.test-support.js";

const MAC = "apple-photos:person-a@example.com:macbook-pro-0001";
const PHONE = "apple-photos:person-a@example.com:iphone-aa01";
const ORIGINAL = Buffer.from("synthetic heic bytes of photo one");
const RENDER = Buffer.from("synthetic jpeg bytes of photo one's edit");
const sha = (bytes: Buffer | string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const LOCAL = "CCCCCCCC-0000-4000-8000-000000000001/L0/001";
const MODIFIED = "2026-10-03T08:41:05.1234510+05:30";

const resource = (type: string, type_raw: number, uti: string, name: string, blob: Buffer | null, reason?: string): JsonObject => ({
  type, type_raw, uti, original_filename: name,
  ...(blob === null ? { blob: null, not_local: true, ...(reason === undefined ? {} : { not_local_reason: reason }) } : { blob: { hash: sha(blob), bytes: blob.length, type: "image/heic", role: type } }),
});

function asset(local: string, media_type: string, creation_date: string | null, resources: JsonObject[], cloud: string | null = `${local.slice(0, 36)}:001:synthetic`): JsonObject {
  return {
    local_identifier: local, cloud_identifier: cloud, modification_date: MODIFIED, creation_date, media_type, media_subtypes: 0,
    pixel_width: 4032, pixel_height: 3024, location: null, favorite: false, hidden: false, resources,
  };
}

const availability = (local: string, resources: JsonObject[]): JsonObject => ({
  local_identifier: local, modification_date: MODIFIED, snapshot_replay_key: `photos:${local}:${MODIFIED}`, resources,
});

const line = (kind: string, observed_at: string, payload: JsonObject) => JSON.stringify({ kind, observed_at, payload });

function macDelivery(home: ReturnType<typeof openTestHome>, lines: string[], carried: Buffer[] = []) {
  for (const bytes of carried) home.blobs.put(bytes);
  return deliver(home, MAC, { "photos.jsonl": Buffer.from(lines.map((each) => `${each}\n`).join("")) }, { snapshot_taken_at: "2026-10-03T05:00:00Z" });
}

describe("the Mac's Photos library: each of these is impossible", () => {
  it("the Mac keys, times or states one entry otherwise than the phone does, or names a device", async () => {
    const home = openTestHome();
    try {
      const snapshot = asset(LOCAL, "image", "2026-10-03T03:10:00.5Z", [resource("photo", 1, "public.heic", "IMG_0001.HEIC", null)]);
      const fetched = availability(LOCAL, [resource("photo", 1, "public.heic", "IMG_0001.HEIC", ORIGINAL), resource("fullSizePhoto", 5, "public.jpeg", "FullSizeRender.jpg", RENDER)]);
      const mac = await collect(photosMac.read(macDelivery(home, [line("asset", "2026-10-03T09:30:00.5+05:30", snapshot), line("resource_availability", "2026-10-03T09:40:00.5+05:30", fetched)], [ORIGINAL, RENDER]), home.blobs));

      const tuples = [...new Set((fetched.resources as JsonObject[]).map((each) => JSON.stringify([each.type_raw, each.uti, each.original_filename, (each.blob as JsonObject).hash])))].sort();
      const digest = sha(`[${tuples.join(",")}]`);
      const shipment = bundle("mac-parity", "2026-10-03T10:00:00+05:30", {
        photos: [
          { domain: "photos", kind: "asset", sequence: 1, captured: { wall_rfc3339: "2026-10-03T09:30:00.5+05:30" }, payload: snapshot },
          { domain: "photos", kind: "resource_availability", sequence: 2, captured: { wall_rfc3339: "2026-10-03T09:40:00.5+05:30" }, capture_replay_key: `photos:${LOCAL}:${MODIFIED}:availability:${digest}`, payload: fetched },
        ],
      }, [ORIGINAL, RENDER]);
      const phone = await collect(photosPhone.read({ id: "phone:iphone-aa01/1", source: PHONE, sealed_ms: 0, stated_ms: 0, facts: {}, files: sealedFiles(home.blobs, shipment) }, home.blobs));

      const shape = (rows: typeof mac) => rows.map((row) => ({ kind: row.kind, key: row.key, content: row.content, time: row.time ?? null, blobs: row.blobs ?? [] }));
      expect(shape(mac)).toEqual(shape(phone));
      expect(mac.map((row) => row.key)).toEqual([`${LOCAL}:20261003T031105.123451Z`, `${LOCAL}:20261003T031105.123451Z:${digest}`]);
      expect(mac.map((row) => row.device)).toEqual([undefined, undefined]);
      expect(phone.map((row) => row.device)).toEqual(["iphone-aa01", "iphone-aa01"]);
      expect((mac[0]!.content as { content: JsonObject }).content.cloud_identifier).toBe(snapshot.cloud_identifier);

      const landed = await home.land(photosMac, macDelivery(home, [line("asset", "2026-10-03T09:30:00.5+05:30", snapshot), line("resource_availability", "2026-10-03T09:40:00.5+05:30", fetched)]));
      expect(landed).toMatchObject({ new: 2, refused: 0 });
      const again = await home.land(photosMac, macDelivery(home, [line("asset", "2026-10-03T09:30:00.5+05:30", snapshot), line("resource_availability", "2026-10-03T09:40:00.5+05:30", fetched)]));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 2 });
      artifact(home.dir, "parity.json", { mac: shape(mac) as unknown as Json, landed: counts(landed), again: counts(again) });
    } finally {
      home.close();
    }
  });

  it("an availability lands as img, an asset as img-file, either guard takes the other's entry, or an availability a home holds as img stays img after its repair", async () => {
    const home = openTestHome();
    try {
      const snapshot = asset(LOCAL, "image", "2026-10-03T03:10:00.5Z", [resource("photo", 1, "public.heic", "IMG_0001.HEIC", null)]);
      const fetched = availability(LOCAL, [resource("photo", 1, "public.heic", "IMG_0001.HEIC", ORIGINAL)]);
      const lines = [line("asset", "2026-10-03T09:30:00.5+05:30", snapshot), line("resource_availability", "2026-10-03T09:40:00.5+05:30", fetched)];
      const rows = await collect(photosMac.read(macDelivery(home, lines, [ORIGINAL]), home.blobs));
      expect(rows.map((row) => [row.kind, (row.content as { type: string }).type])).toEqual([["img", "photos.apple.asset"], ["img-file", "photos.apple.availability"]]);
      for (const kinds of [photosMac.kinds, photosPhone.kinds]) {
        expect([kinds.img!(rows[0]!.content), kinds["img-file"]!(rows[1]!.content)]).toEqual([[], []]);
        expect(kinds.img!(rows[1]!.content).length).toBeGreaterThan(0);
        expect(kinds["img-file"]!(rows[0]!.content).length).toBeGreaterThan(0);
      }

      const before = { ...photosMac, kinds: { ...photosMac.kinds, img: () => [] } };
      await home.land(before, macDelivery(home, lines), rows.map((row) => ({ ...row, kind: "img" })));
      const held = home.heads(MAC);
      expect(held.map((head) => head.kind)).toEqual(["img", "img"]);
      const view = home.db.view();
      const plan = (() => {
        try {
          return view.planRepair({ source: MAC, kinds: ["img"], fix });
        } finally {
          view.close();
        }
      })();
      const repaired = home.db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: MAC, started_ms: Date.parse("2026-10-05T00:00:00Z") }), plan, { has: () => true }));
      const heads = home.heads(MAC);
      const live = heads.filter((head) => !head.gone);
      expect(live.map((head) => [head.kind, head.key])).toEqual([["img", rows[0]!.key], ["img-file", rows[1]!.key]]);
      expect(heads.filter((head) => head.gone).map((head) => [head.kind, head.key])).toEqual([["img", rows[1]!.key]]);
      const moved = live.find((head) => head.kind === "img-file")!;
      const was = held.find((head) => head.key === rows[1]!.key)!;
      expect([moved.content, moved.start_ms]).toEqual([was.content, was.start_ms]);
      const again = await home.land(photosMac, macDelivery(home, lines));
      expect(again).toMatchObject({ new: 0, changed: 0, restated: 2 });
      artifact(home.dir, "img-file.json", { heads: heads as unknown as Json, repaired: counts(repaired), again: counts(again) });
    } finally {
      home.close();
    }
  });

  it("a video, a photo with no creation date or a refusal is dropped, a gone ends a record other than the one its entry made, or an asset that is neither image nor video refuses the delivery", async () => {
    const home = openTestHome();
    try {
      const lines = [
        line("asset", "2026-10-03T09:30:00Z", asset("VIDEO-1/L0/001", "video", "2026-10-03T03:11:00Z", [resource("video", 2, "com.apple.quicktime-movie", "IMG_0002.MOV", null)])),
        line("asset", "2026-10-03T09:30:00Z", asset("UNDATED-1/L0/001", "image", null, [resource("photo", 1, "public.jpeg", "IMG_0003.JPG", null)], null)),
        line("asset", "2026-10-03T09:30:00Z", asset("AUDIO-1/L0/001", "audio", "2026-10-03T03:12:00Z", [])),
        line("resource_availability", "2026-10-03T09:41:00Z", availability("VIDEO-1/L0/001", [resource("video", 2, "com.apple.quicktime-movie", "IMG_0002.MOV", null, "download_failed")])),
      ];
      const landed = await home.land(photosMac, macDelivery(home, lines));
      expect(landed).toMatchObject({ new: 3, refused: 1 });
      const heads = home.heads(MAC);
      expect(heads.map((head) => [head.key.split(":")[0], head.start_ms])).toEqual([
        ["UNDATED-1/L0/001", null],
        ["VIDEO-1/L0/001", Date.parse("2026-10-03T03:11:00Z")],
        ["VIDEO-1/L0/001", Date.parse("2026-10-03T09:41:00Z")],
      ]);
      expect((heads[2]!.content as { content: { resources: JsonObject[] } }).content.resources[0]!.not_local_reason).toBe("download_failed");
      const goneVideo = await home.land(photosMac, macDelivery(home, [
        line("gone", "2026-10-04T09:00:00Z", { of: "asset", payload: JSON.parse(lines[0]!).payload as JsonObject }),
        line("gone", "2026-10-04T09:00:00Z", { of: "resource_availability", payload: JSON.parse(lines[3]!).payload as JsonObject }),
      ]));
      expect([goneVideo.gone, home.heads(MAC).filter((head) => head.version !== "gone").map((head) => head.key.split(":")[0])]).toEqual([2, ["UNDATED-1/L0/001"]]);
      const refused = await collect(photosMac.read(macDelivery(home, [
        line("gone", "2026-10-04T09:00:00Z", { of: "sweep", payload: {} }), line("sweep", "2026-10-03T09:30:00Z", {}), "not json", lines[1]!,
      ]), home.blobs));
      expect(refused.map((row) => (row.refused === undefined ? `${row.kind} ${row.locator}` : `${row.key}: ${row.refused}`))).toEqual([
        expect.stringMatching(/^photos\.jsonl:1: .*a gone names the entry it ends/u),
        expect.stringMatching(/^photos\.jsonl:2: photos\.jsonl line 2 is a photos entry kind no library writes/u),
        expect.stringMatching(/^photos\.jsonl:3: photos\.jsonl line 3 is not one JSON object/u),
        "img photos.jsonl line 4",
      ]);
      artifact(home.dir, "kinds.json", { landed: counts(landed), heads: heads as unknown as Json, gone: counts(goneVideo) });
    } finally {
      home.close();
    }
  });

  it("the Mac's own bundle reads otherwise than its lines state, lands a file other than the library's bytes, or leaves a deleted photo live", async () => {
    const home = openTestHome();
    try {
      const delivery = macBundle(home, MAC, new URL("./test/mac-bundle.zip", import.meta.url));
      const file = delivery.files.find((each) => each.path === "photos.jsonl")!;
      const lines = home.blobs.bytes(file.blob).toString("utf8").trimEnd().split("\n").map((each) => JSON.parse(each) as { kind: string; payload: JsonObject });
      const rows = await collect(photosMac.read(delivery, home.blobs));
      expect(rows.map((row) => row.gone === true ? "gone" : (row.content as { type: string }).type)).toEqual(lines.map((line) => line.kind === "gone" ? "gone" : line.kind === "asset" ? "photos.apple.asset" : "photos.apple.availability"));
      rows.forEach((row, n) => { if (row.gone !== true) expect((row.content as { content: JsonObject }).content).toEqual(lines[n]!.payload); });
      expect(rows.filter((row) => row.gone !== true).map((row) => row.key.split(":")[0])).toEqual([
        "EDITED/L0/001", "CLOUD/L0/001", "VIDEO/L0/001", "LOST/L0/001", "UNDATED/L0/001",
        "EDITED/L0/001", "CLOUD/L0/001", "VIDEO/L0/001", "LOST/L0/001",
      ]);
      const named = [...new Set(rows.flatMap((row) => row.blobs ?? []))];
      expect(named.map((hash) => home.blobs.bytes(hash).toString("utf8")).sort()).toEqual([
        "synthetic cloud bytes", "EDITED/L0/001/FullSizeRender.jpg", "EDITED/L0/001/IMG_0001.HEIC", "VIDEO/L0/001/IMG_0004.MOV",
      ].sort());
      const lost = rows.find((row) => row.key.startsWith("LOST/") && (row.content as { type: string }).type === "photos.apple.availability")!;
      expect(((lost.content as { content: { resources: JsonObject[] } }).content.resources[0]!).not_local_reason).toBe("not_found");

      const landed = await home.land(photosMac, delivery);
      expect(landed.refused).toBe(0);
      const heads = home.heads(MAC);
      expect(heads.filter((head) => head.version === "gone").map((head) => head.key.split(":")[0])).toEqual(["VIDEO/L0/001", "VIDEO/L0/001"]);
      expect(heads.filter((head) => head.version !== "gone")).toHaveLength(7);
      artifact(home.dir, "mac-bundle.json", { lines: lines.length, landed: counts(landed), heads: heads.map((head) => [head.key, head.version]) as unknown as Json });
    } finally {
      home.close();
    }
  });

  it("a Live Photo's video is no part of its copy, its name joins nothing, a render's name joins, or a video's length is lost", async () => {
    const home = openTestHome();
    try {
      const [still, movie, render, renderedMovie, video] = ["still", "paired video", "edit's render", "edit's paired video", "video"].map((what) => Buffer.from(`synthetic bytes of the ${what}`)) as [Buffer, Buffer, Buffer, Buffer, Buffer];
      const file = (type: string, type_raw: number, name: string, bytes: Buffer, media_type: string): JsonObject => ({
        type, type_raw, uti: media_type, original_filename: name, size: bytes.length, blob: { hash: sha(bytes), bytes: bytes.length, type: media_type, role: type },
      });
      const live = "LIVE-1/L0/001", movieAsset = "VIDEO-2/L0/001";
      const lines = [
        line("asset", "2026-10-03T09:30:00Z", { ...asset(live, "image", "2026-10-03T03:10:00Z", [
          file("photo", 1, "IMG_0005.HEIC", still, "image/heic"), file("pairedVideo", 9, "IMG_0005.MOV", movie, "video/quicktime"),
          file("fullSizePhoto", 5, "FullSizeRender.heic", render, "image/heic"), file("fullSizePairedVideo", 10, "FullSizeRender.mov", renderedMovie, "video/quicktime"),
        ]), duration: null }),
        line("asset", "2026-10-03T09:30:00Z", { ...asset(movieAsset, "video", "2026-10-03T03:11:00Z", [file("video", 2, "IMG_0006.MOV", video, "video/quicktime")]), duration: 42.4 }),
      ];
      await home.land(photosMac, macDelivery(home, lines, [still, movie, render, renderedMovie, video]));
      const view = home.db.view();
      try {
        const source = view.sources().find((row) => row.id === MAC)!;
        const hex = (bytes: Buffer) => sha(bytes).slice("sha256:".length);
        const photo = applePhotosAdapter.copy(view, source, live)!;
        expect({ motion: { renders: photo.motion.renders.map((each) => each.sha256), originals: photo.motion.originals.map((each) => each.sha256) }, files: photo.files, names: photo.names, video: photo.video, duration_ms: photo.duration_ms }).toEqual({
          motion: { renders: [hex(renderedMovie)], originals: [hex(movie)] }, files: [still, movie, render, renderedMovie].map(hex).sort(), names: ["IMG_0005.HEIC", "IMG_0005.MOV"], video: false, duration_ms: null,
        });
        const head = view.head({ source: MAC, kind: "img", key: photo.records[0]!.key })!;
        expect(applePhotosAdapter.files(view.version(head.version), head.key).sort()).toEqual(photo.files);
        expect(applePhotosAdapter.copy(view, source, movieAsset)).toMatchObject({ video: true, motion: { renders: [], originals: [] }, duration_ms: 42_400, names: ["IMG_0006.MOV"], originals: [{ sha256: hex(video) }] });
        artifact(home.dir, "live-copy.json", { photo: photo as unknown as Json });
      } finally {
        view.close();
      }
    } finally {
      home.close();
    }
  });
});
