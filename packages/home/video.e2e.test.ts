import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readHome, REPO } from "./test/harness-root.js";
import { endRuns, FACES_FETCHED, UPRIGHT, type Facts } from "./test/faces-programs.js";
import { AT, DAY, VIDEO_SECONDS, videoHome, type VideoHome } from "./test/video-home.js";

const ARTIFACTS = join(REPO, "packages", "home", ".build", "e2e", "video");
const GOOGLE = "google-photos:person-a@example.com:export";
const PHOTOS = ["live", "video", "pair", "mp4"] as const;
type Name = (typeof PHOTOS)[number];

describe.skipIf(!FACES_FETCHED)("a phone's and a Takeout's videos and Live Photos through the real door", () => {
  let home: VideoHome;
  let recipe: number;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
    home = await videoHome();
    recipe = ((await (await home.get("/v1/pictures")).json()) as { recipe: number }).recipe;
  });

  afterAll(async () => {
    if (existsSync(ARTIFACTS)) writeFileSync(join(ARTIFACTS, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await home?.stop();
    endRuns();
  });

  const entries = () => readHome(home.root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'photos' AND unit LIKE 'burst/%' ORDER BY unit").pluck().all() as string[])
      .flatMap((content) => (JSON.parse(content) as { photos: { sha256: string | null; kind: string; media_type: string | null; motion: { sha256: string; media_type: string } | null; duration_ms: number | null; held: boolean; at_ms: number }[] }).photos));
  const hex = (hash: string | null) => hash?.slice("sha256:".length) ?? null;

  const picture = async (name: string, hash: string, size: "tile" | "screen" | "full"): Promise<Facts & { served: string }> => {
    const response = await home.get(`/v1/pictures/${hash}?size=${size}&recipe=${recipe}`);
    expect(response.status, `${name} ${size}: ${response.status}`).toBe(200);
    const kept = join(ARTIFACTS, `${name}-${size}.jpg`);
    const body = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get("content-length"), `${name} ${size}: its length`).toBe(String(body.length));
    writeFileSync(kept, body);
    return { served: response.headers.get("content-type") ?? "", ...(await home.films.facts(kept)) };
  };

  it("J1: each library's delivery is read whole, the Takeout's Live Photo .MOV with no ftyp among its files", () => {
    const deliveries = readHome(home.root, (db) => db.prepare("SELECT source, state, refused FROM deliveries WHERE source IN (?, ?) ORDER BY source").all(home.phone.source, GOOGLE));
    report.deliveries = { read: deliveries, runs: readHome(home.root, (db) => db.prepare("SELECT outcome, counts, error FROM runs WHERE kind = 'import' AND subject = ?").all(GOOGLE)) };
    expect(deliveries).toEqual([{ source: home.phone.source, state: "imported", refused: 0 }, { source: GOOGLE, state: "imported", refused: 0 }]);
  });

  it("J1 J2: one burst entry a photo, a Live Photo's motion its own, a video a video with its length; nothing wanted of the phone", async () => {
    const seen = entries();
    report.bursts = seen;
    const { hashes } = home;
    expect(seen.map((entry) => [entry.at_ms, entry.sha256, entry.kind, entry.media_type, entry.motion, entry.duration_ms, entry.held])).toEqual([
      [AT.live, hex(hashes.live.image), "image", "image/jpeg", { sha256: hex(hashes.live.motion), media_type: "video/quicktime" }, null, true],
      [AT.video, hex(hashes.video.image), "video", "video/quicktime", null, Math.round(VIDEO_SECONDS * 1000), true],
      [AT.pair, hex(hashes.pair.image), "image", "image/heic", { sha256: hex(hashes.pair.motion), media_type: "video/quicktime" }, null, true],
      [AT.mp4, hex(hashes.mp4.image), "video", "video/mp4", null, null, true],
    ]);
    const units = readHome(home.root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'photos' AND unit LIKE 'photo/%' ORDER BY unit").pluck().all() as string[])
      .map((content) => JSON.parse(content) as { at_ms: number; video: boolean; held: boolean; records: { source: string; key: string; rung: number }[] }));
    const library = (source: string) => (source === home.phone.source ? "phone" : "takeout");
    report.units = units.map((unit) => ({ at_ms: unit.at_ms, video: unit.video, held: unit.held, records: unit.records.map((record) => [library(record.source), record.key, record.rung]) }));
    expect(units.map((unit) => [unit.at_ms, unit.video, unit.records.map((record) => library(record.source)).sort()]).sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual([
      [AT.live, false, ["phone", "takeout", "takeout"]], [AT.video, true, ["phone"]], [AT.pair, false, ["takeout", "takeout"]], [AT.mp4, true, ["takeout"]],
    ]);
    const wanted = await (await fetch(`${home.url}/v1/photos/wanted?source=${encodeURIComponent(home.phone.source)}&files=1`,
      { headers: { authorization: `Bearer ${home.phone.pass}`, "lifestream-device": "phone/1.0.0" } })).json() as { photos: unknown[] };
    expect(wanted.photos, "the phone asked for nothing: the Takeout's still and .MOV are the Live Photo's at their names and sizes").toEqual([]);

    const day = JSON.parse(readFileSync(join(home.root, "days", `${DAY}.day.json`), "utf8")) as { atoms: { item?: string; text: string; video?: { duration_ms: number | null } }[] };
    const photoAtoms = day.atoms.filter((atom) => atom.item?.startsWith("photo:"));
    report.atoms = photoAtoms.map((atom) => ({ item: atom.item, text: atom.text, video: atom.video ?? null }));
    expect(photoAtoms.map((atom) => [atom.item, atom.video ?? null])).toEqual([
      [`photo:${hex(hashes.live.image)}`, null],
      [`photo:${hex(hashes.video.image)}`, { duration_ms: Math.round(VIDEO_SECONDS * 1000) }],
      [`photo:${hex(hashes.pair.image)}`, null],
      [`photo:${hex(hashes.mp4.image)}`, { duration_ms: null }],
    ]);
    expect(photoAtoms[3]!.text).toMatch(/^Video\b/u);
  });

  it("J3 J4: each photo plays what it should, and its picture or poster is upright", async () => {
    const { hashes } = home;
    const plays: Record<Name, { hash: string; media_type: string; live: boolean } | null> = {
      live: { hash: hashes.live.motion!, media_type: "video/quicktime", live: true },
      video: { hash: hashes.video.image, media_type: "video/quicktime", live: false },
      pair: { hash: hashes.pair.motion!, media_type: "video/quicktime", live: true },
      mp4: { hash: hashes.mp4.image, media_type: "video/mp4", live: false },
    };
    const photos: Record<string, unknown> = {};
    for (const name of PHOTOS) {
      const response = await home.get(`/v1/photos/${hashes[name].image}`);
      expect(response.status, name).toBe(200);
      const facts = (await response.json()) as { photo: { kind: string; play: unknown } };
      const shown = await picture(name, hashes[name].image, "screen");
      photos[name] = { hash: hashes[name].image, kind: facts.photo.kind, play: facts.photo.play,
        picture: { size: "screen", served: shown.served, width: shown.width, height: shown.height, orientation: shown.orientation ?? null, corners: shown.corners } };
      expect([facts.photo.kind, facts.photo.play], name).toEqual([name === "video" || name === "mp4" ? "video" : "image", plays[name]]);
      expect([shown.served, shown.orientation], name).toEqual(["image/jpeg", undefined]);
    }
    report.photos = photos;

    const poster = await picture("video", hashes.video.image, "tile");
    expect([poster.width, poster.height, poster.orientation, poster.corners]).toEqual([480, 640, undefined, UPRIGHT]);
    const full = await picture("live", hashes.live.image, "full");
    expect([full.width, full.height, full.orientation, full.gps, full.corners]).toEqual([800, 1200, undefined, false, UPRIGHT]);
    const heic = photos.pair as { picture: { width: number; height: number; corners: string[] } };
    expect([heic.picture.width, heic.picture.height, heic.picture.corners]).toEqual([1200, 800, UPRIGHT]);
    report.upright = { "video tile": poster, "live full": full };
  });

  it("J5: a range of the Live Photo's motion is 206, one from its end 416 naming its length: HomeLink's contract file", async () => {
    const hash = home.hashes.live.motion!;
    const total = home.films.live.motion!.length;
    const KEPT = ["content-range", "content-type", "content-length", "accept-ranges"];
    const answer = async (range: string) => {
      const response = await home.get(`/v1/blobs/${hash}`, { range });
      const body = Buffer.from(await response.arrayBuffer());
      return { range, status: response.status, headers: Object.fromEntries(KEPT.flatMap((name) => { const value = response.headers.get(name); return value === null ? [] : [[name, value]]; })), body: body.toString("base64") };
    };
    const inside = await answer("bytes=0-1023");
    const past = await answer(`bytes=${total}-${total + 1023}`);
    expect([inside.status, inside.headers["content-range"], Buffer.from(inside.body, "base64")]).toEqual([206, `bytes 0-1023/${total}`, home.films.live.motion!.subarray(0, 1024)]);
    expect([past.status, past.headers["content-range"], past.body]).toEqual([416, `bytes */${total}`, ""]);
    report.ranges = { hash, total, inside: { ...inside, body: `${Buffer.from(inside.body, "base64").length} bytes` }, past };

    const file = join(REPO, "homelink", "Tests", "Fixtures", "blob-range.json");
    const written = `${JSON.stringify({ hash, total, inside, past }, null, 2)}\n`;
    if (process.env.LIFESTREAM_FIXTURES === "write") writeFileSync(file, written);
    expect(existsSync(file) ? readFileSync(file, "utf8") : "", "homelink/Tests/Fixtures/blob-range.json is these answers: LIFESTREAM_FIXTURES=write writes it").toBe(written);
  });
});
