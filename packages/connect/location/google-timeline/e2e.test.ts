import { artifact, collect, CONNECT_ROOT, deliver, openTestHome, parityOf, readGolden } from "../../test/drive.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSUMED, type JsonObject } from "@lifestreamprotocol/core";
import { looked } from "../../test/imports.js";
import { googleTimeline } from "./reader.js";
import { exportFile, FACTS, SEGMENTS, SOURCE, timelineHanded } from "./test/fixtures.js";

const GOLDEN = join(CONNECT_ROOT, "location", "google-timeline", "test", "golden.json");

describe("google timeline: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    const landed = await home.land(googleTimeline, deliver(home, SOURCE, { "location-history.json": exportFile() }, FACTS));
    expect(landed).toMatchObject({ new: 4, refused: 0, duplicated: 0 });
    expect(home.heads(SOURCE).map((head) => `${head.kind}:${head.key}`)).toEqual([
      "path:20260905T034500Z",
      "place-visit:20260905T023000Z:ChIJ-synthetic-place-0001",
      "place-visit:20260905T041030Z",
      "trip:20260905T034500Z",
    ]);
    artifact(home.dir, "heads.json", { landed, heads: home.heads(SOURCE) });
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    const rows = await collect(googleTimeline.read(deliver(home, SOURCE, { "location-history.json": exportFile() }, FACTS), home.blobs));
    const ours = parityOf(rows);
    const golden = parityOf(readGolden(GOLDEN));
    artifact(home.dir, "parity.json", { golden, ours });
    expect(ours).toEqual(golden);
    expect(rows.every((row) => row.device === "pixel-0001")).toBe(true);
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    await home.land(googleTimeline, deliver(home, SOURCE, { "location-history.json": exportFile() }, FACTS));
    const later = await home.land(googleTimeline, deliver(home, SOURCE, { "location-history.json": exportFile(SEGMENTS.slice(0, 1)) }, { exported_at: "2026-09-20T00:00:00Z" }));
    expect(later).toMatchObject({ gone: 0, restated: 1 });
    expect(home.heads(SOURCE).filter((head) => head.gone)).toEqual([]);
    artifact(home.dir, "heads.json", { later, heads: home.heads(SOURCE) });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    const again = { ...SEGMENTS[0]!, startTime: "2026-09-05T02:30:00.000Z", visit: { ...(SEGMENTS[0]!.visit as object), probability: 0.9 } };
    const landed = await home.land(googleTimeline, deliver(home, SOURCE, { "location-history.json": exportFile([...SEGMENTS, again]) }, FACTS));
    expect(landed).toMatchObject({ new: 4, duplicated: 1 });
    artifact(home.dir, "landed.json", landed);
  });

  it("a number no float carries is stored as a different number, or a malformed segment is passed over or refuses its neighbours", async () => {
    const home = openTestHome();
    const text = exportFile(SEGMENTS.slice(0, 1)).toString("utf8").replace('"probability": 0.85', '"probability": 0.85000000000000000001');
    const rows = await collect(googleTimeline.read(deliver(home, SOURCE, { "location-history.json": Buffer.from(text) }, FACTS), home.blobs));
    expect(((rows[0]!.content as { content: { visit: { probability: unknown } } }).content.visit.probability)).toBe("0.85000000000000000001");
    const both = { ...SEGMENTS[1]!, visit: {} };
    const unknown = { startTime: "2026-09-05T11:00:00.000Z", endTime: "2026-09-05T11:30:00.000Z", newFamily: { probability: 0.5 } };
    const landed = await home.land(googleTimeline, deliver(home, SOURCE, { "a.json": exportFile([SEGMENTS[0]!, both, unknown, SEGMENTS[2]!]) }, FACTS));
    expect(landed).toMatchObject({ new: 2, refused: 2 });
    expect(landed.refusals).toEqual([
      { kind: "file", key: "a.json:semanticSegments[1]", violations: [expect.stringContaining("holds visit and activity")] },
      { kind: "file", key: "a.json:semanticSegments[2]", violations: [expect.stringContaining("holds none of visit, activity and timelinePath")] },
    ]);
    artifact(home.dir, "rows.json", { rows, landed });
  });

  it("a lossy number lets a duplicated member through, the second silently kept, or the file's refusal takes its neighbour", async () => {
    const home = openTestHome();
    const text = exportFile(SEGMENTS.slice(0, 1)).toString("utf8")
      .replace('"probability": 0.85', '"probability": 0.85000000000000000001, "probability": 0.5');
    const rows = await collect(googleTimeline.read(deliver(home, SOURCE, { "location-history.json": Buffer.from(text), "other.json": exportFile(SEGMENTS.slice(1, 2)) }, FACTS), home.blobs));
    expect(rows.map((row) => [row.key, row.refused === undefined])).toEqual([["location-history.json", false], [expect.any(String), true]]);
    expect(rows[0]!.refused).toMatch(/duplicate/u);
  });
});

describe("google timeline as an import: each of these is impossible", () => {
  const IMPORT = { ...FACTS, import: { kind: "google-timeline", id: "import-0001" } };
  const keys = (home: ReturnType<typeof openTestHome>) => home.heads(SOURCE).map((head) => [`${head.kind}:${head.key}`, head.version]);

  it("the file zipped, or in a folder, lands other heads than the file alone", async () => {
    const alone = openTestHome();
    await alone.land(googleTimeline, deliver(alone, SOURCE, { "location-history.json": exportFile() }, IMPORT));
    for (const files of [timelineHanded("zip"), timelineHanded("folder")]) {
      const home = openTestHome();
      expect(await home.land(googleTimeline, deliver(home, SOURCE, files, IMPORT))).toMatchObject({ new: 4, refused: 0 });
      expect(keys(home)).toEqual(keys(alone));
    }
    artifact(alone.dir, "heads.json", keys(alone));
  });

  it("a file is given an account it does not name, a time other than its newest segment's end, or a JSON is not of the kind", async () => {
    const home = openTestHome();
    const seen = await looked("google-timeline", deliver(home, "upload:local:macbook-pro-0001", { "location-history.json": exportFile() }, {}, 0), home.blobs);
    expect(seen.resolved).toEqual({ products: [{ id: "google-timeline", named: [] }] });
    const newest = Math.max(...SEGMENTS.map((segment) => Date.parse(segment.endTime as string)));
    expect(seen.stated).toEqual({ time_ms: newest });
    const bare = await looked("google-timeline", deliver(home, "upload:local:macbook-pro-0001", timelineHanded("file", exportFile(SEGMENTS, "array")), {}, 0), home.blobs);
    expect(bare.stated).toEqual({ time_ms: newest });
    expect(seen.listing.routes.map((route) => [route.product, route.copy, route.connector])).toEqual([["google-timeline", "export", "google-timeline"]]);
    const other = await looked("google-timeline", deliver(home, "upload:local:macbook-pro-0001", { "notes.json": Buffer.from("{\"a\": 1}") }, {}, 0), home.blobs);
    expect(other.stated).toEqual({ refused: "This isn't a Timeline export: none of its files holds a location history" });
    artifact(home.dir, "looked.json", seen);
  });

  it("a file read whole is kept, or a delivery of no import is let go", async () => {
    const home = openTestHome();
    const consumed = async (files: Record<string, Buffer>, facts: JsonObject = IMPORT) => (await collect(googleTimeline.read(deliver(home, SOURCE, files, facts), home.blobs))).filter((row) => row.kind === CONSUMED).map((row) => row.key);
    expect(await consumed({ "location-history.json": exportFile() })).toEqual(["location-history.json"]);
    expect(await consumed(timelineHanded("zip"))).toEqual(["Timeline.zip"]);
    expect(await consumed({ "location-history.json": exportFile() }, FACTS)).toEqual([]);
  });
});
