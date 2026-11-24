import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyTable, openHomeFolder, overlap } from "@lifestreamprotocol/core";
import { openHider, openMarks, type Findings, type Picture } from "@lifestreamprotocol/privacy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openEnginePictures } from "./engine-pictures.js";
import { buildEngine, endRuns, FACES_FETCHED } from "./test/faces-programs.js";
import { REPO } from "./test/harness-root.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-engine-pictures-mac-"));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  endRuns();
});

describe.skipIf(!FACES_FETCHED)("over the real face engine", () => {
  let engine: string;
  beforeAll(async () => {
    engine = await buildEngine();
  });

  it("reads a photo's faces in the scan's frame, and makes it under all with every face covered in its own tone and the drawn one's placeholder on it, the same bytes each time", async () => {
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const blob = blobs.put(readFileSync(join(REPO, "faces", "reference", "crew-seven.jpg")));
    const expected = JSON.parse(readFileSync(join(REPO, "faces", "reference", "expected.json"), "utf8")) as { photos: { key: string; faces: { box: number[] }[] }[] };
    const scanned = expected.photos.find((photo) => photo.key === "crew-seven.jpg")!.faces.map(({ box: [x1, y1, x2, y2] }) => ({ x: x1!, y: y1!, width: x2! - x1!, height: y2! - y1! }));
    const pictures = openEnginePictures({ engine, blobs, findings: { folder: openHomeFolder(dir), dir: join(dir, "findings") }, faces: () => [] });

    const read = await pictures.read(blob) as Findings;
    expect(read.faces).toHaveLength(scanned.length);
    for (const face of scanned) expect(read.faces.filter((found) => overlap(found.box, face, "smaller") >= 0.5)).toHaveLength(1);

    const hider = openHider({
      people: () => ({ version: "people-1", owner: null, people: [] }),
      settings: () => ({ level: "all", chat: "all", detector: "off", links: "tokens", always: [], never: [] }),
      detector: { state: () => ({ state: "absent", why: "no detector in this test" }), find: () => Promise.reject(new Error("the detector is off")) },
      pictures, marks: openMarks(openHomeFolder(dirname(join(dir, "marks.db"))), join(dir, "marks.db")),
    });
    const drawn = scanned[0]!;
    const hidden = await hider.hide([{ picture: blob, faces: [{ box: drawn, placeholder: "[[Person 1]]" }] }], "all", emptyTable("ask:test"));
    if (!("texts" in hidden)) throw new Error(`expected a picture, got ${JSON.stringify(hidden)}`);
    const [picture] = hidden.texts as Picture[];
    expect(picture!.recipe.engine).toBe("make 2");
    expect(picture!.recipe.covered).toHaveLength(scanned.length);
    expect(picture!.recipe.covered[0]).toMatchObject({ placeholder: "[[Person 1]]" });
    expect(overlap(picture!.recipe.covered[0]!.box, drawn, "smaller")).toBeGreaterThanOrEqual(0.5);
    for (const face of scanned) expect(picture!.recipe.covered.filter((covered) => overlap(covered.box, face, "smaller") >= 0.5)).toHaveLength(1);
    for (const covered of picture!.recipe.covered) expect(covered.colour).toMatch(/^#[0-9a-f]{6}$/u);
    expect(picture!.recipe.covered.some((covered) => covered.colour !== "#000000")).toBe(true);
    expect(picture!.recipe.filled).toEqual([]);
    expect([...picture!.jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    const again = await pictures.make(picture!.recipe) as Picture;
    expect(Buffer.from(again.jpeg).equals(Buffer.from(picture!.jpeg))).toBe(true);
  });
});
