import { createHash } from "node:crypto";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { engineMaker, fromBytes, openPictures, type PictureSize, type Pictures } from "./pictures.js";
import { buildEngine, endRuns, FACES_FETCHED, samplesTool, UPRIGHT, type Facts, type Samples } from "./test/faces-programs.js";
import { REPO } from "./test/harness-root.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-pictures-mac-"));
const ARTIFACTS = join(REPO, "packages", "home", ".build", "e2e", "pictures-mac");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!FACES_FETCHED)("pictures over the real face engine", () => {
  let samples: Samples;
  let pictures: Pictures;
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    pictures = openPictures({ folder: openHomeFolder(dir), dir: join(dir, "pictures") }, engineMaker(await buildEngine()));
    samples = await samplesTool(dir);
    rmSync(ARTIFACTS, { recursive: true, force: true });
    mkdirSync(ARTIFACTS, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(ARTIFACTS)) writeFileSync(join(ARTIFACTS, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    endRuns();
  });

  const sample = (name: string, ...args: string[]): Promise<Buffer> => samples.sample(name, ...args);
  const facts = (file: string): Promise<Facts> => samples.facts(file);
  const served = async (name: string, bytes: Buffer, size: PictureSize) => {
    const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const answer = await pictures.picture(hash, size, fromBytes(bytes, pictures.cache, () => true));
    if (answer === null) throw new Error(`no picture of ${name} at ${size}`);
    if (answer.kept === null) return { type: answer.type, own: true, facts: null };
    const kept = join(ARTIFACTS, `${name}-${size}.${answer.type === "image/png" ? "png" : "jpg"}`);
    writeFileSync(kept, answer.kept.read()!);
    const seen = await facts(kept);
    report[`${name} ${size}`] = { served: answer.type, ...seen };
    return { type: answer.type, own: false, facts: seen };
  };

  it("makes a JPEG whose orientation is 6 and a HEIC whose orientation is 8 upright and bare, at tile, screen and full", async () => {
    const jpeg = await sample("six.jpg", "marked", "1200", "800", "jpeg", "6");
    const heic = await sample("eight.heic", "marked", "1200", "800", "heic", "8");
    for (const [name, bytes, orientation] of [["six", jpeg, 6], ["eight", heic, 8]] as const) {
      const original = await facts(join(dir, name === "six" ? "six.jpg" : "eight.heic"));
      expect([original.orientation, original.width, original.height, original.gps, original.shown], name).toEqual([orientation, 800, 1200, true, UPRIGHT]);
      expect(original.corners, name).not.toEqual(UPRIGHT);
      for (const [size, width, height] of [["tile", 640, 427], ["screen", 1200, 800], ["full", 1200, 800]] as const) {
        const made = await served(name, bytes, size);
        expect([made.type, made.facts!.type, made.facts!.width, made.facts!.orientation, made.facts!.gps, made.facts!.corners], `${name} ${size}`)
          .toEqual(["image/jpeg", "public.jpeg", width, undefined, false, UPRIGHT]);
        expect(Math.abs(made.facts!.height - height), `${name} ${size}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("makes a 400 px JPEG whose orientation is 6 and a static WebP whose orientation is 6, and keeps a transparent PNG a PNG", async () => {
    for (const [name, bytes] of [["small", await sample("small.jpg", "marked", "400", "300", "jpeg", "6")], ["webp", await sample("still.webp", "marked", "400", "300", "webp", "6")]] as const) {
      const made = await served(name, bytes, "tile");
      expect([made.own, made.type, made.facts!.width, made.facts!.height, made.facts!.orientation, made.facts!.corners], name).toEqual([false, "image/jpeg", 400, 300, undefined, UPRIGHT]);
    }
    const clear = await served("clear", await sample("clear.png", "marked", "1600", "1200", "png", "1", "clear"), "tile");
    expect([clear.type, clear.facts!.width, clear.facts!.height, clear.facts!.alpha]).toEqual(["image/png", 640, 480, true]);
  });

  it("serves an animated GIF and an animated WebP as their own bytes", async () => {
    for (const [name, type] of [["moving.gif", "image/gif"], ["moving.webp", "image/webp"]] as const) {
      const bytes = await sample(name, "marked", "200", "150", type.slice(6), "1", "frames");
      expect((await facts(join(dir, name))).frames, name).toBe(2);
      expect(await served(name, bytes, "tile"), name).toEqual({ type, own: true, facts: null });
    }
  });

  it("makes a movie's poster upright, as the player turns its track", async () => {
    const movie = await sample("turned.mov", "movie", "640", "480");
    const made = await served("poster", movie, "tile");
    expect([made.type, made.facts!.width, made.facts!.height, made.facts!.orientation, made.facts!.corners]).toEqual(["image/jpeg", 640, 480, undefined, UPRIGHT]);
  });

  it("makes full of a turned photo in the scan's frame: every face box the labeler found lies on the face", async () => {
    const reference = join(REPO, "faces", "reference", "crew-seven.jpg");
    const turned = join(dir, "crew-seven-6.jpg");
    await samples.run("turned", reference, "6", turned);
    const made = await served("crew-seven", readFileSync(turned), "full");
    const original = await facts(reference);
    expect([made.facts!.width, made.facts!.height]).toEqual([original.width, original.height]);
    const expected = JSON.parse(readFileSync(join(REPO, "faces", "reference", "expected.json"), "utf8")) as { photos: { key: string; faces: { box: number[] }[] }[] };
    const boxes = expected.photos.find((photo) => photo.key === "crew-seven.jpg")!.faces.map((face) => face.box);
    expect(boxes.length).toBeGreaterThan(0);
    const mean = async (file: string, box: number[]) => JSON.parse(await samples.run("mean", file, ...box.map(String))) as number[];
    for (const box of boxes) {
      const [want, got] = [await mean(reference, box), await mean(join(ARTIFACTS, "crew-seven-full.jpg"), box)];
      for (const channel of [0, 1, 2]) expect(Math.abs(got[channel]! - want[channel]!), `face ${box.join(",")}`).toBeLessThan(6);
    }
  });
});
