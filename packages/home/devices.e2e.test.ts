import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type Tx } from "@lifestreamprotocol/core";
import { devices } from "@lifestreamprotocol/connect";
import { nameDevice } from "./devices.js";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { artifact, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";

const REGISTRY = new URL("./test/devices-registry.ts", import.meta.url);
const HOME_UNIT = "macbook-pro-0001";
const CAMERAS = `cameras:local:${HOME_UNIT}`;
const DEVICES = `devices:local:${HOME_UNIT}`;
const PLACES = `places:local:${HOME_UNIT}`;
const GOOGLE = "google-photos:person-a@example.com:export";
const LIBRARY = "apple-photos:person-a@example.com:iphone-aa01";
const NEW_PHONE = "apple-photos:person-a@example.com:iphone-17-pro-0042";
const CAMERA = "synthetic-make/synthetic-camera";
const T0 = Date.UTC(2026, 8, 1, 6);
const READER = "synthetic-token-reader".padEnd(43, "x");
const WRITER = "synthetic-token-writer".padEnd(43, "x");
const PHONE = "synthetic-token-phone".padEnd(43, "x");

const hexOf = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function jpeg(make: string, model: string, body: string): Buffer {
  const tiff = Buffer.alloc(96);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(2, 8);
  for (const [index, [tag, value, at]] of ([[0x010f, `${make}\0`, 40], [0x0110, `${model}\0`, 64]] as const).entries()) {
    tiff.writeUInt16LE(tag, 10 + index * 12);
    tiff.writeUInt16LE(2, 12 + index * 12);
    tiff.writeUInt32LE(value.length, 14 + index * 12);
    tiff.writeUInt32LE(at, 18 + index * 12);
    tiff.write(value, at, "ascii");
  }
  const segment = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, (segment.length + 2) >> 8, (segment.length + 2) & 0xff]), segment, Buffer.from([0xff, 0xda]), Buffer.from(body), Buffer.from([0xff, 0xd9])]);
}

function photos(from: number, to: number) {
  const rows = [], carried: Record<string, Buffer> = {};
  for (let n = from; n < to; n++) {
    const bytes = jpeg("Synthetic Make", "Synthetic Camera", `frame ${n}`);
    const hex = hexOf(bytes);
    carried[hex] = bytes;
    rows.push({ kind: "img", key: hex, at: T0 + n * 3_600_000, content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: bytes.length, media_type: "application/octet-stream", role: "original" }] }, blobs: [`sha256:${hex}`] });
  }
  return { rows, carried };
}

type Listed = { camera: string; name: string; make: string | null; model: string | null; photos: number; first_ms: number | null; last_ms: number | null; sample: string | null; phones: string[]; word: unknown; mine: boolean; why: string; rule: string };

describe("the owner's cameras through the door", () => {
  const roots: string[] = [];
  const homes: Home[] = [];
  const doors: { stop(): Promise<void> }[] = [];

  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("1-10: a stray camera is the owner's, a count moves a unit, a phone's photos are not its own, the owner's word waits or changes nothing, its writer cannot read it back, an old phone writes a place, or a phone's camera goes by its unit", async () => {
    try {
      const root = makeRoot("lifestream-devices-", { sources: { [GOOGLE]: "fake-rows", [LIBRARY]: "photos-ios-bundle", [NEW_PHONE]: "photos-ios-bundle" }, settings: { unit: HOME_UNIT } });
      roots.push(root);
      const principals = openHomeFolder(root);
      mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: READER, now_ms: Date.now() });
      mintPrincipal(principals, { unit: `dashboard-${HOME_UNIT}`, scopes: ["deliver"], sources: [DEVICES], token: WRITER, now_ms: Date.now() });
      mintPrincipal(principals, { unit: "iphone-aa01", scopes: ["deliver"], sources: [PLACES], kind: "phone", token: PHONE, now_ms: Date.now() });
      const home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, tickMs: TICK_MS, log: () => undefined });
      homes.push(home);
      const door = await doorHere(root);
      doors.push(door);
      const count = (sql: string, ...params: unknown[]) => readHome(root, (db) => db.prepare(sql).pluck().get(...params) as number);
      const quiet = () => count("SELECT count(*) FROM deliveries WHERE state <> 'imported'") === 0 && count("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')") === 0;
      const counted = () => readHome(root, (db) => db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'camera' AND h.key = ?")
        .pluck().get(CAMERAS, CAMERA) as string | undefined);
      const photosOf = () => (counted() === undefined ? 0 : (JSON.parse(counted()!) as { content: { photos: number } }).content.photos);
      const unit = (camera: string) => readHome(root, (db) => db.prepare("SELECT seq, reading, content FROM extracts WHERE family = 'labels' AND unit = ?").get(`camera:${camera}`) as { seq: number; reading: string; content: string } | undefined);
      const get = async (token: string, path: string) => {
        const response = await fetch(`${door.url}${path}`, { headers: { authorization: `Bearer ${token}` } });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const listed = async (token = READER) => (await get(token, "/v1/devices")).body.cameras as Listed[];
      const answers: Record<string, unknown> = {};
      expect(readHome(root, (db) => db.prepare("SELECT id, connector FROM sources WHERE id LIKE '%:local:' || ? ORDER BY id").all(HOME_UNIT))).toEqual([
        { id: `ask:local:${HOME_UNIT}`, connector: "ask-home" }, { id: DEVICES, connector: "devices-home" }, { id: `people:local:${HOME_UNIT}`, connector: "people-home" },
        { id: `places:local:${HOME_UNIT}`, connector: "places-home" }, { id: `stations:local:${HOME_UNIT}`, connector: "stations-home" },
      ]);

      const first = photos(0, 49);
      await ship(root, { source: GOOGLE, fetched_ms: Date.now(), rows: first.rows, carried: first.carried });
      await until("the labeler counted 49 and the labels stored the camera", () => quiet() && photosOf() === 49 && unit(CAMERA) !== undefined);
      expect(count("SELECT count(*) FROM sources WHERE id = ? AND connector = 'cameras'", CAMERAS)).toBe(1);
      answers.forty_nine = await listed();
      expect(answers.forty_nine).toEqual([{
        camera: CAMERA, name: "Synthetic Make Synthetic Camera", make: "Synthetic Make", model: "Synthetic Camera", photos: 49, first_ms: T0, last_ms: T0 + 48 * 3_600_000,
        sample: `sha256:${first.rows[48]!.key}`, phones: [], word: null, mine: false, why: "none", rule: "none",
      }]);

      const fiftieth = photos(49, 50);
      await ship(root, { source: GOOGLE, fetched_ms: Date.now(), rows: fiftieth.rows, carried: fiftieth.carried });
      await until("the 50th counted and the unit moved", () => quiet() && photosOf() === 50 && JSON.parse(unit(CAMERA)!.content).mine_by_count === true);
      answers.fifty = await listed();
      expect((answers.fifty as Listed[])[0]).toMatchObject({ photos: 50, mine: true, why: "count", rule: "count" });

      const stood = unit(CAMERA)!;
      const fiftyFirst = photos(50, 51);
      await ship(root, { source: GOOGLE, fetched_ms: Date.now(), rows: fiftyFirst.rows, carried: fiftyFirst.carried });
      await until("the 51st counted", () => quiet() && photosOf() === 51);
      expect(unit(CAMERA)).toEqual(stood);

      await ship(root, { source: LIBRARY, fetched_ms: Date.now(), rows: [{
        kind: "img", key: "AAAA-0001:null", at: T0,
        content: { type: "photos.apple.asset", content: { local_identifier: "AAAA-0001", media_type: "image", modification_date: null, creation_date: new Date(T0).toISOString(),
          resources: [{ type: "photo", type_raw: 1, uti: "public.heic", original_filename: "IMG_0001.HEIC", blob: null, not_local: true }] } },
      }] });
      await until("the phone's camera stored", () => quiet() && unit("phone/iphone-aa01") !== undefined);
      answers.paired = await listed();
      expect((answers.paired as Listed[]).map(({ camera, name, photos: taken, mine, why, rule }) => [camera, name, taken, mine, why, rule])).toEqual([
        ["phone/iphone-aa01", "phone/iphone-aa01", 1, true, "paired", "paired"], [CAMERA, "Synthetic Make Synthetic Camera", 51, true, "count", "count"],
      ]);

      const library = [["Apple", "iPhone 17 Pro"], ["Apple", "iPhone 17 Pro"], ["Apple", "iPhone 17 Pro"], ["Google", "Pixel 9"]].map(([make, model], n) => {
        const bytes = jpeg(make!, model!, `library ${n}`);
        const hex = hexOf(bytes);
        const row = {
          kind: "img", key: `DDDD-000${n}:null`, at: T0 + n,
          content: { type: "photos.apple.asset", content: { local_identifier: `DDDD-000${n}`, media_type: "image", modification_date: null, creation_date: new Date(T0 + n).toISOString(),
            resources: [{ type: "photo", type_raw: 1, uti: "public.jpeg", original_filename: `IMG_000${n}.JPG`, blob: { hash: `sha256:${hex}`, bytes: bytes.length, type: "image/jpeg", role: "original" } }] } },
          blobs: [`sha256:${hex}`],
        };
        return { row, hex, bytes };
      });
      await ship(root, { source: NEW_PHONE, fetched_ms: Date.now(), rows: library.map((each) => each.row), carried: Object.fromEntries(library.map((each) => [each.hex, each.bytes])) });
      await until("the new phone's camera stored", () => quiet() && unit("apple/iphone-17-pro") !== undefined && unit("google/pixel-9") !== undefined);
      answers.new_phone = await listed();
      expect((answers.new_phone as Listed[]).filter((camera) => !camera.camera.startsWith("phone/") && camera.camera !== CAMERA).map(({ camera, photos: taken, mine, why }) => [camera, taken, mine, why])).toEqual([
        ["apple/iphone-17-pro", 3, true, "paired"], ["google/pixel-9", 1, false, "none"],
      ]);

      const act = async (token: string, action: Record<string, unknown>, headers: Record<string, string> = {}) => {
        const response = await fetch(`${door.url}/v1/owner/act`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers }, body: JSON.stringify(action) });
        return { status: response.status, body: await response.json() as Record<string, unknown> };
      };
      const refused = await act(WRITER, { of: "devices", kind: "camera", request: "word-backwards", camera: CAMERA, mine: false, from: "2026-10-02", to: "2026-10-01" });
      expect([refused.status, refused.body.code]).toEqual([422, "STATEMENTS_BAD"]);
      const said = await act(WRITER, { of: "devices", kind: "camera", request: "word-not-mine", camera: CAMERA, mine: false });
      expect([said.status, said.body]).toEqual([200, { act: null, id: `camera:${CAMERA}`, position: expect.any(String) }]);
      answers.answered = await listed(WRITER);
      expect((answers.answered as Listed[]).find((camera) => camera.camera === CAMERA), "the word is read in the answer's own tick").toMatchObject({ word: { mine: false }, mine: false, why: "owner" });
      await until("the word stored in the camera's unit", () => quiet() && JSON.parse(unit(CAMERA)!.content).word !== undefined);
      answers.marked = await listed(WRITER);
      expect((answers.marked as Listed[]).find((camera) => camera.camera === CAMERA)).toMatchObject({ photos: 51, word: { mine: false }, mine: false, why: "owner", rule: "count" });
      expect((await get(WRITER, "/v1/devices")).body).toEqual({ ...(await get(READER, "/v1/devices")).body, position: expect.any(String) });
      for (const path of [`/v1/records?source=${encodeURIComponent(DEVICES)}&kind=camera`, "/v1/places", "/v1/labels"]) {
        const read = await get(WRITER, path);
        expect([path, read.status, read.body.code]).toEqual([path, 403, "PRINCIPAL_SCOPE"]);
      }
      await home.stop();
      homes.splice(homes.indexOf(home), 1);
      const db = openHome(openHomeFolder(root), "migrate");
      try {
        db.commit((tx) => {
          const now = Date.now();
          const run = tx.tables.runs.start({ kind: "import", subject: DEVICES, started_ms: now });
          const landed = tx.records.land(run, { id: "synthetic-live-word", source: DEVICES, stated_ms: now },
            [{ kind: "camera", key: CAMERA, content: { type: "devices.camera", mine: true } }], devices.devicesHome.kinds, { has: () => true });
          expect(landed.changed).toBe(1);
          tx.tables.runs.end(run, { ended_ms: now, outcome: "ok" });
        });
      } finally {
        db.close();
      }
      expect(JSON.parse(unit(CAMERA)!.content).word).toEqual({ mine: false });
      answers.before_extract = await listed();
      expect((answers.before_extract as Listed[]).find((camera) => camera.camera === CAMERA)).toMatchObject({ photos: 51, word: { mine: true }, mine: true, why: "owner", rule: "count" });
      const phoneName = async (change: (tx: Tx) => void) => {
        const named = openHome(openHomeFolder(root), "migrate");
        try {
          named.commit(change);
        } finally {
          named.close();
        }
        return (await listed()).find((camera) => camera.camera === "phone/iphone-aa01")?.name;
      };
      answers.phone_names = [
        await phoneName((tx) => tx.tables.devices.add({ unit: "iphone-aa01", model: "iPhone 17 Pro", added_ms: Date.now() })),
        await phoneName((tx) => nameDevice(tx, "iphone-aa01", "Synthetic Phone", Date.now())),
      ];
      expect(answers.phone_names).toEqual(["iPhone 17 Pro (paired)", "Synthetic Phone (paired)"]);
      homes.push(await startHome(root, { stopGraceMs: 50, registry: REGISTRY, tickMs: TICK_MS, log: () => undefined }));
      await until("the door reaches the started home", async () => (await get(READER, "/v1/status")).status === 200);
      const put = (version: string) => act(PHONE, { of: "places", kind: "create", request: `harbour-${version}`, name: "Synthetic Harbour", latitude: 0, longitude: 0, radius_m: 120 }, { "lifestream-device": `phone/${version}` });
      const old = await put("0.2.0");
      expect([old.status, old.body]).toEqual([426, expect.objectContaining({ code: "DEVICE_TOO_OLD", floor: "0.3.0" })]);
      expect(await put("0.3.0")).toEqual({ status: 200, body: { act: null, id: expect.stringMatching(/^place:synthetic-harbour-[0-9a-f]{6}$/u), position: expect.any(String) } });
      answers.floor = { refused: "0.2.0", landed: "0.3.0" };
      artifact(root, "devices", answers);
    } finally {
      for (const door of doors.splice(0)) await door.stop();
      for (const home of homes.splice(0)) await home.stop();
    }
  });
});
