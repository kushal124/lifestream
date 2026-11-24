import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { emptyTable, openHomeFolder, type Box, type Json, type View } from "@lifestreamprotocol/core";
import { openHider, openMarks, type Picture } from "@lifestreamprotocol/privacy";
import { afterAll, describe, expect, it } from "vitest";
import { forgetFindings, forgetMatches, keepMatch, matchesForgotten, mergedPeople, openEnginePictures, scannedFaces, type EnginePicturesInputs } from "./engine-pictures.js";
import { hex, REPO, until } from "./test/harness-root.js";

const FAKE = join(REPO, "packages", "connect", "labelers", "faces", "test", "fake-engine.mjs");
const JPEG_START = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const dir = mkdtempSync(join(tmpdir(), "lifestream-engine-pictures-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const box = (x: number, y = 0, width = 10, height = 10): Box => ({ x, y, width, height });
const corners = (b: Box) => [b.x, b.y, b.x + b.width, b.y + b.height];

let opened = 0;
function setUp(engine: Record<string, Json> = {}) {
  const at = join(dir, `case-${(opened += 1)}`);
  mkdirSync(at, { recursive: true });
  const program = join(at, "face-engine");
  writeFileSync(program, `#!/bin/sh\nFAKE_ENGINE_DIR='${at}' exec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(program, 0o755);
  writeFileSync(join(at, "engine.json"), JSON.stringify(engine));
  const blobs = openHomeFolder(at).blobs(join(at, "blobs"));
  const findings = { folder: openHomeFolder(at), dir: join(at, "findings") };
  const calls = () => (existsSync(join(at, "calls.log")) ? readFileSync(join(at, "calls.log"), "utf8").split("\n").filter((line) => line !== "") : []);
  const config = (next: Record<string, Json>) => writeFileSync(join(at, "engine.json"), JSON.stringify(next));
  const open = (inputs: Partial<EnginePicturesInputs> = {}) => openEnginePictures({ engine: program, blobs, findings, faces: () => [], ...inputs });
  return { at, program, blobs, findings, calls, config, open };
}

function screenshot(name: string) {
  const bytes = Buffer.from(`synthetic screenshot ${name}`);
  const words = (texts: string[], y: number) => texts.map((text, index) => ({ text, box: [index * 100, y, index * 100 + 90, y + 40] }));
  const found = {
    lines: [
      { confidence: 1, words: words(["Call", "+1", "555", "000", "0001"], 0) },
      { confidence: 0.98, words: words(["Write", "person-a@example.com"], 100) },
    ],
    faces: [{ box: [600, 300, 700, 420], confidence: 0.9 }],
  };
  return { bytes, blob: `sha256:${hex(bytes)}`, found: { [hex(bytes)]: found } };
}

describe("reading a picture", () => {
  it("reads it once, keeps its findings by blob, and adds the faces the labeler finds at each call", async () => {
    const shot = screenshot("read");
    const engine = setUp({ found: shot.found });
    engine.blobs.put(shot.bytes);
    let scanned = [{ box: box(590, 290, 120, 140) }];
    const pictures = engine.open({ faces: (blob) => (blob === shot.blob ? scanned : []) });
    const reads = () => engine.calls().filter((call) => call.startsWith("read ")).map((call) => JSON.parse(call.slice(5)).pictures.length);
    const answers = await Promise.all(Array.from({ length: 10 }, () => pictures.read(shot.blob)));
    expect(answers[0]).toEqual({
      lines: [
        { words: ["Call", "+1", "555", "000", "0001"].map((text, index) => ({ text, box: box(index * 100, 0, 90, 40) })) },
        { words: ["Write", "person-a@example.com"].map((text, index) => ({ text, box: box(index * 100, 100, 90, 40) })) },
      ],
      faces: [{ box: box(600, 300, 100, 120) }, { box: box(590, 290, 120, 140) }],
    });
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(reads()).toEqual([1]);
    const file = join(engine.findings.dir, hex(shot.bytes).slice(0, 2), `${hex(shot.bytes)}.json`);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ reader: "fake read 1", status: "ok" });
    scanned = [...scanned, { box: box(10, 500) }];
    expect(await pictures.read(shot.blob)).toMatchObject({ faces: [{ box: box(600, 300, 100, 120) }, { box: box(590, 290, 120, 140) }, { box: box(10, 500) }] });
    expect(reads()).toEqual([1]);
    await engine.open().read(shot.blob);
    expect(reads()).toEqual([1, 0]);
  });

  it("reads again what was kept under another reading, or kept damaged", async () => {
    const shot = screenshot("reader");
    const engine = setUp({ found: shot.found });
    engine.blobs.put(shot.bytes);
    await engine.open().read(shot.blob);
    const file = join(engine.findings.dir, hex(shot.bytes).slice(0, 2), `${hex(shot.bytes)}.json`);
    engine.config({ found: shot.found, reader: "fake read 2" });
    await engine.open().read(shot.blob);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ reader: "fake read 2" });
    writeFileSync(file, "{ a damaged file");
    expect(await engine.open().read(shot.blob)).toMatchObject({ faces: [{ box: box(600, 300, 100, 120) }] });
    expect(engine.calls().filter((call) => call.startsWith("read ") && JSON.parse(call.slice(5)).pictures.length === 1)).toHaveLength(3);
  });

  it("answers cannot for a picture the engine cannot decode, kept so, and throws for an engine that cannot run", async () => {
    const engine = setUp();
    const video = engine.blobs.put(Buffer.from("not an image: a synthetic video"));
    const pictures = engine.open();
    const cannot = { cannot: "This picture cannot be hidden: not an image ImageIO can read." };
    expect(await pictures.read(video)).toEqual(cannot);
    expect(await pictures.read(video)).toEqual(cannot);
    expect(await pictures.make({ blob: video, filled: [], covered: [], written: [] })).toEqual(cannot);
    expect(engine.calls().filter((call) => call.startsWith("read ") && JSON.parse(call.slice(5)).pictures.length === 1)).toHaveLength(1);

    const shot = screenshot("failing");
    engine.blobs.put(shot.bytes);
    engine.config({ fail: { read: 1, make: 2 } });
    const plain = (words: string) => ({ name: "Error", message: expect.stringContaining(words) });
    await expect(pictures.read(shot.blob)).rejects.toMatchObject(plain("face-engine read failed: exit 1: face-engine: a fake failure"));
    await expect(pictures.make({ blob: shot.blob, filled: [], covered: [], written: [] })).rejects.toMatchObject(plain("face-engine make could not read the request"));
    engine.config({ hang: "read" });
    await expect(engine.open({ timeoutMs: 300 }).read(shot.blob)).rejects.toMatchObject(plain("face-engine read ran past the 0.3 s limit and was stopped"));
    const stopping = new AbortController();
    const hung = engine.open({ signal: stopping.signal }).read(shot.blob);
    const reads = () => engine.calls().filter((call) => call.startsWith("read ")).length;
    const before = reads();
    await until("the engine's read under way", () => reads() > before);
    const closing = new Error("the door is closing");
    stopping.abort(closing);
    await expect(hung).rejects.toBe(closing);
    const unbuilt = openEnginePictures({ engine: join(engine.at, "no-engine"), blobs: engine.blobs, findings: engine.findings, faces: () => [] });
    await expect(unbuilt.read(shot.blob)).rejects.toThrow("the face engine is not built");
    await expect(pictures.read(`sha256:${"0".repeat(64)}`)).rejects.toThrow();
    expect(readdirSync(engine.findings.dir).flatMap((shard) => readdirSync(join(engine.findings.dir, shard)))).toEqual([`${video.slice(7)}.json`]);
  });

  it("keeps no findings of a blob an erasure removed while it was read, and forgets a blob's findings", async () => {
    const shot = screenshot("erased");
    const engine = setUp({ found: shot.found });
    engine.blobs.put(shot.bytes);
    const gone = engine.open({ blobs: { materialise: (hash) => engine.blobs.materialise(hash), has: () => false } });
    await expect(gone.read(shot.blob)).rejects.toThrow("went while it was read");
    const shard = join(engine.findings.dir, hex(shot.bytes).slice(0, 2));
    expect(readdirSync(shard)).toEqual([]);

    await engine.open().read(shot.blob);
    expect(readdirSync(shard)).toEqual([`${hex(shot.bytes)}.json`]);
    expect(forgetFindings(engine.findings, shot.blob)).toEqual([shard]);
    expect(readdirSync(shard)).toEqual([]);
    expect(forgetFindings(engine.findings, shot.blob)).toEqual([shard]);
    expect(forgetFindings({ folder: openHomeFolder(engine.at), dir: join(engine.at, "never-made") }, shot.blob)).toEqual([]);
  });
});

describe("making a picture", () => {
  it("makes it anew at each call from the recipe given, keeping nothing, and answers the recipe with the engine's version", async () => {
    const shot = screenshot("make");
    const engine = setUp({ engine: "fake make 7" });
    engine.blobs.put(shot.bytes);
    const pictures = engine.open();
    const recipe = {
      blob: shot.blob, filled: [box(100, 0, 90, 40)],
      covered: [{ box: box(600, 300, 100, 120), placeholder: "[[Person 2]]" }, { box: box(20, 300, 40, 40), colour: "#336699" }],
      written: [{ box: box(300, 300, 100, 120), placeholder: "[[Person 1]]" }],
    };
    const made = await pictures.make(recipe) as Picture;
    expect(made.recipe).toEqual({ ...recipe, covered: [{ ...recipe.covered[0]!, colour: "#808080" }, recipe.covered[1]], engine: "fake make 7" });
    expect(Buffer.from(made.jpeg).subarray(0, JPEG_START.length)).toEqual(JPEG_START);
    expect(Buffer.from(made.jpeg).subarray(JPEG_START.length).toString()).toBe(`made ${hex(shot.bytes)} ${JSON.stringify({
      filled: recipe.filled.map(corners),
      covered: [{ box: corners(recipe.covered[0]!.box), tag: "P2" }, { box: corners(recipe.covered[1]!.box), colour: "#336699" }],
      written: [{ box: corners(recipe.written[0]!.box), tag: "P1" }],
    })}`);
    const again = await pictures.make(recipe) as Picture;
    expect(Buffer.from(again.jpeg)).toEqual(Buffer.from(made.jpeg));
    expect(engine.calls().filter((call) => call.startsWith("make "))).toHaveLength(2);
    expect(existsSync(engine.findings.dir)).toBe(false);
    engine.config({ engine: "fake make 8" });
    const remade = (await pictures.make(made.recipe)) as Picture;
    expect(remade.recipe).toEqual({ ...made.recipe, engine: "fake make 8" });
    expect(JSON.parse(Buffer.from(remade.jpeg).toString().split(" ").slice(2).join(" ")).covered[0].colour).toBe("#808080");
  });
});

describe("behind the hider", () => {
  it("fills a marked word and every face under all, writes only the asked face's placeholder, and names nothing it covers", async () => {
    const shot = screenshot("hidden");
    const engine = setUp({ found: shot.found });
    engine.blobs.put(shot.bytes);
    const labelers = box(590, 290, 120, 140);
    const pictures = engine.open({ faces: async () => [{ box: labelers }] });
    const detector = {
      state: () => ({ state: "absent", why: "no detector in this test" }) as const,
      find: () => Promise.reject(new Error("the detector is off")),
    };
    const hider = openHider({
      people: () => ({ version: "people-1", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["person-a@example.com", "+15550000001"] }] }),
      settings: () => ({ level: "all", chat: "all", detector: "off", links: "tokens", always: [], never: [] }),
      detector, pictures, marks: openMarks(openHomeFolder(dirname(join(engine.at, "marks.db"))), join(engine.at, "marks.db")),
    });
    const asked = { picture: shot.blob, faces: [{ box: labelers, placeholder: "[[Person 1]]" }] };
    const all = await hider.hide([asked], "all", emptyTable("ask:test"));
    if (!("texts" in all)) throw new Error(`expected a picture, got ${JSON.stringify(all)}`);
    const [picture] = all.texts as Picture[];
    const words = (texts: string[]) => texts.map((text) => shot.found[hex(shot.bytes)]!.lines.flatMap((line) => line.words).find((word) => word.text === text)!.box);
    const filled = picture!.recipe.filled.map(corners);
    for (const covered of words(["+1", "555", "000", "0001", "person-a@example.com"])) expect(filled).toContainEqual(covered);
    for (const left of words(["Call", "Write"])) expect(filled).not.toContainEqual(left);
    expect(picture!.recipe.covered).toEqual([{ box: box(590, 290, 120, 140), placeholder: "[[Person 1]]", colour: "#808080" }]);
    expect(picture!.recipe.written).toEqual([]);
    expect(all.table.entries).toEqual([]);
    const names = await hider.hide([asked], "names", emptyTable("ask:test"));
    const [kept] = ("texts" in names ? names.texts : []) as Picture[];
    expect(kept!.recipe.covered).toEqual([]);
    expect(kept!.recipe.written).toEqual([{ box: labelers, placeholder: "[[Person 1]]" }]);
  });
});

describe("the faces labeler's faces", () => {
  it("reads every faces source's scan of the blob, none of a gone or unreadable one", () => {
    const blob = `sha256:${"ab".repeat(32)}`;
    const versions: Record<string, Json> = {
      v1: { status: "ok", faces: [{ box: [10, 20, 30, 50] }, { box: [100, 100, 140, 160] }] },
      v2: { status: "ok", faces: [{ box: [5, 5, 15, 15] }] },
      v3: { status: "unreadable", faces: null },
    };
    const heads: Record<string, string> = { "faces:local:mac-a": "v1", "faces:local:mac-b": "v2", "faces:local:mac-c": "v3", "faces:local:mac-d": "gone" };
    const view = {
      sources: () => Object.keys(heads).map((id) => ({ id })),
      head: (ref: { source: string; kind: string; key: string }) => (ref.kind === "scan" && ref.key === "ab".repeat(32) ? { version: heads[ref.source] } : undefined),
      version: (id: string) => ({ content: versions[id] }),
    } as unknown as Pick<View, "sources" | "head" | "version">;
    expect(scannedFaces(view, blob)).toEqual([{ box: box(10, 20, 20, 30) }, { box: box(100, 100, 40, 60) }, { box: box(5, 5, 10, 10) }]);
    expect(scannedFaces(view, `sha256:${"cd".repeat(32)}`)).toEqual([]);
  });

  it("names each scanned face the person its source's model image names it, where that image states the scan's faces box for box", () => {
    const blob = `sha256:${"ab".repeat(32)}`;
    const scan = { status: "ok", faces: [{ box: [10, 20, 30, 50] }, { box: [100, 100, 140, 160] }] };
    const versions: Record<string, Json> = {
      scanA: scan, scanB: scan,
      imageA: { faces: [{ box: [10, 20, 30, 50] }, { box: [100, 100, 140, 160] }], names: [{ who: "person:ada", shown: "Ada Example" }, null] },
      imageB: { faces: [{ box: [11, 20, 30, 50] }, { box: [100, 100, 140, 160] }], names: [{ who: "person:ada", shown: "Ada Example" }, { who: "person:rose", shown: "Rose Example" }] },
    };
    const heads: Record<string, Record<string, string>> = { "faces:local:mac-a": { scan: "scanA", "model-image": "imageA" }, "faces:local:mac-b": { scan: "scanB", "model-image": "imageB" } };
    const view = {
      sources: () => Object.keys(heads).map((id) => ({ id })),
      head: (ref: { source: string; kind: string; key: string }) => (ref.key === "ab".repeat(32) && heads[ref.source]![ref.kind] !== undefined ? { version: heads[ref.source]![ref.kind] } : undefined),
      version: (id: string) => ({ content: versions[id] }),
    } as unknown as Pick<View, "sources" | "head" | "version">;
    expect(scannedFaces(view, blob)).toEqual([
      { box: box(10, 20, 20, 30), who: "person:ada" }, { box: box(100, 100, 40, 60) },
      { box: box(10, 20, 20, 30) }, { box: box(100, 100, 40, 60) },
    ]);
  });
});

describe("a Chat photo's faces", () => {
  function staged(engine: ReturnType<typeof setUp>) {
    const stage = openHomeFolder(dirname(join(engine.at, "stage"))).blobs(join(engine.at, "stage"));
    const both = {
      has: (hash: string) => engine.blobs.has(hash) || stage.has(hash),
      materialise: (hash: string) => (engine.blobs.has(hash) ? engine.blobs.materialise(hash) : stage.materialise(hash)),
    };
    return { stage, both };
  }

  it("answers the match kept at upload with every finder's faces at each read, its persons kept, and covers and tags a face only the match holds, matching turned off or not", async () => {
    const shot = screenshot("matched");
    const engine = setUp({ found: shot.found });
    const { stage, both } = staged(engine);
    stage.put(shot.bytes);
    keepMatch(engine.findings, shot.blob, [{ box: box(100, 300, 80, 100), who: "p-ada" }, { box: box(598, 302, 100, 118) }], both, 0);
    const shard = join(engine.findings.dir, hex(shot.bytes).slice(0, 2));
    expect(readdirSync(shard)).toEqual([`${hex(shot.bytes)}.match.json`]);
    let scanned = [{ box: box(10, 500) }];
    const pictures = engine.open({ blobs: both, faces: () => scanned });
    expect((await pictures.read(shot.blob) as { faces: unknown }).faces).toEqual([
      { box: box(600, 300, 100, 120) }, { box: box(10, 500) }, { box: box(100, 300, 80, 100), who: "p-ada" }, { box: box(598, 302, 100, 118) },
    ]);
    const hider = openHider({
      people: () => ({ version: "people-1", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: [] }] }),
      settings: () => ({ level: "all", chat: "all", detector: "off", links: "tokens", always: [], never: [] }),
      detector: { state: () => ({ state: "absent", why: "no detector in this test" }), find: () => Promise.reject(new Error("the detector is off")) },
      pictures, marks: openMarks(openHomeFolder(dirname(join(engine.at, "marks.db"))), join(engine.at, "marks.db")),
    });
    const covers = async (blob: string) => {
      const answer = await hider.hide([{ picture: blob, tags: true }], "all", emptyTable("chat:c1"));
      if (!("texts" in answer)) throw new Error(`expected a picture, got ${JSON.stringify(answer)}`);
      return (answer.texts[0] as Picture).recipe.covered.map(({ colour: _colour, ...face }) => face);
    };
    const matched = [
      { box: box(100, 300, 80, 100), placeholder: "[[Person 1]]" }, { box: box(598, 300, 102, 120) }, { box: box(10, 500) },
    ];
    expect(await covers(shot.blob)).toEqual(matched);
    scanned = [];
    expect(await covers(shot.blob)).toEqual(matched.slice(0, 2));
    const other = screenshot("unmatched");
    engine.config({ found: { ...shot.found, ...other.found } });
    stage.put(other.bytes);
    expect(await covers(other.blob)).toEqual([{ box: box(600, 300, 100, 120) }]);
  });

  it("keeps a picture's findings and match while the stage or the store holds its blob, and removes them once neither does", async () => {
    const shot = screenshot("staged");
    const engine = setUp({ found: shot.found });
    const { stage, both } = staged(engine);
    stage.put(shot.bytes);
    await engine.open({ blobs: both }).read(shot.blob);
    keepMatch(engine.findings, shot.blob, [{ box: box(1, 1), who: "p-ada" }], both, 0);
    const shard = join(engine.findings.dir, hex(shot.bytes).slice(0, 2));
    const kept = [`${hex(shot.bytes)}.json`, `${hex(shot.bytes)}.match.json`];
    expect(readdirSync(shard).sort()).toEqual(kept);
    engine.blobs.put(shot.bytes);
    expect(forgetFindings(engine.findings, shot.blob, both)).toEqual([]);
    stage.remove(shot.blob);
    expect(forgetFindings(engine.findings, shot.blob, both)).toEqual([]);
    expect(readdirSync(shard).sort()).toEqual(kept);
    engine.blobs.remove(shot.blob);
    expect(forgetFindings(engine.findings, shot.blob, both)).toEqual([shard]);
    expect(readdirSync(shard)).toEqual([]);
    expect(() => keepMatch(engine.findings, shot.blob, [{ box: box(1, 1) }], both, 0)).toThrow("went while it was matched");
    expect(readdirSync(shard)).toEqual([]);
  });

  it("names a kept match's person as People names them now: one merged since the upload is tagged as the one they were merged into, through every merge", async () => {
    const shot = screenshot("merged");
    const engine = setUp({ found: shot.found });
    const { stage, both } = staged(engine);
    stage.put(shot.bytes);
    keepMatch(engine.findings, shot.blob, [{ box: box(100, 300, 80, 100), who: "person:ada-old" }, { box: box(300, 300, 80, 100), who: "person:bo" }], both, 0);
    const persons = [
      { head: { key: "ada-old" }, version: { content: { name: "Ada", merged_into: "ada-mid" } } },
      { head: { key: "ada-mid" }, version: { content: { name: "Ada", merged_into: "ada" } } },
      { head: { key: "ada" }, version: { content: { name: "Ada Example" } } },
      { head: { key: "bo" }, version: { content: { name: "Bo Example", merged_into: null } } },
    ];
    const view = { records: (source: string, kind: string) => (source === "people:local:unit-a" && kind === "person" ? persons : []) } as unknown as Pick<View, "records">;
    const merged = mergedPeople(view, "unit-a");
    expect(merged).toEqual({ "ada-old": "ada-mid", "ada-mid": "ada" });
    const read = async (inputs: Partial<EnginePicturesInputs>) => ((await engine.open({ blobs: both, ...inputs }).read(shot.blob)) as { faces: { who?: string }[] }).faces.map((face) => face.who ?? null);
    expect(await read({ merged: async () => merged })).toEqual([null, "person:ada", "person:bo"]);
    expect(await read({ merged: () => ({ "ada-old": "ada-mid", "ada-mid": "ada-old" }) })).toEqual([null, "person:ada-old", "person:bo"]);
  });

  it("Delete all face data removes every kept match, never the engine's own findings, and a match made while it ran is not kept", async () => {
    const shot = screenshot("forgotten");
    const engine = setUp({ found: shot.found });
    const { stage, both } = staged(engine);
    stage.put(shot.bytes);
    await engine.open({ blobs: both }).read(shot.blob);
    keepMatch(engine.findings, shot.blob, [{ box: box(1, 1), who: "person:ada" }], both, matchesForgotten(engine.findings));
    const shard = join(engine.findings.dir, hex(shot.bytes).slice(0, 2));
    expect(readdirSync(shard).sort()).toEqual([`${hex(shot.bytes)}.json`, `${hex(shot.bytes)}.match.json`]);
    const before = matchesForgotten(engine.findings);
    expect(forgetMatches(engine.findings)).toEqual([shard]);
    expect(readdirSync(shard)).toEqual([`${hex(shot.bytes)}.json`]);
    expect(() => keepMatch(engine.findings, shot.blob, [{ box: box(1, 1), who: "person:ada" }], both, before)).toThrow("face data was deleted");
    expect(readdirSync(shard)).toEqual([`${hex(shot.bytes)}.json`]);
    keepMatch(engine.findings, shot.blob, [{ box: box(1, 1) }], both, matchesForgotten(engine.findings));
    expect(readdirSync(shard).sort()).toEqual([`${hex(shot.bytes)}.json`, `${hex(shot.bytes)}.match.json`]);
  });

  it("Delete all face data on a home with no findings yet refuses the first match under way", () => {
    const shot = screenshot("the first match");
    const engine = setUp({ found: shot.found });
    const { stage, both } = staged(engine);
    stage.put(shot.bytes);
    expect(existsSync(engine.findings.dir)).toBe(false);
    const before = matchesForgotten(engine.findings);
    expect(forgetMatches(engine.findings)).toEqual([]);
    expect(matchesForgotten(engine.findings)).toBe(before + 1);
    expect(() => keepMatch(engine.findings, shot.blob, [{ box: box(1, 1), who: "person:ada" }], both, before)).toThrow("face data was deleted");
    expect(existsSync(join(engine.findings.dir, hex(shot.bytes).slice(0, 2), `${hex(shot.bytes)}.match.json`))).toBe(false);
  });
});
