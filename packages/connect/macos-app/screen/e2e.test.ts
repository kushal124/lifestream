import { artifact, collect, counts, deliver, expectParity, openTestHome, readGolden } from "../../test/drive.js";
import { describe, expect, it } from "vitest";
import type { BlobStore, Delivery, JsonObject } from "@lifestreamprotocol/core";
import { FRAME, GAP, screenRecorder } from "./reader.js";
import { folderAt, frameLine, gapLine, inlineDelivery, observation, RECORDER_SOURCE, swiftBundle, type RecorderDelivery } from "./test/fixture.js";


function shipped(blobs: BlobStore, delivery: RecorderDelivery, lines?: Buffer): Delivery {
  for (const bytes of Object.values(delivery.blobs)) blobs.put(bytes);
  return deliver(blobs, RECORDER_SOURCE, lines === undefined ? delivery.files : { "observations.jsonl": lines }, delivery.facts);
}

describe("screen recorder: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, or a frame loses the blobs it names", async () => {
    const home = openTestHome();
    try {
      const bundle = swiftBundle();
      const delivery = shipped(home.blobs, bundle);
      const rows = await collect(screenRecorder.read(delivery, home.blobs));
      const landed = await home.land(screenRecorder, delivery, rows);
      expect(landed).toMatchObject({ new: 6, refused: 0, duplicated: 0 });
      const heads = home.heads(RECORDER_SOURCE);
      expect(heads.map((head) => `${head.kind} ${head.key}`)).toEqual([
        `${FRAME} 20260924T151509.603Z`, `${FRAME} 20260924T151511.604Z`, `${FRAME} 20260924T151515.603Z`, `${FRAME} 20260924T151517.604Z`,
        `${GAP} 20260924T151503.603Z`, `${GAP} 20260924T151513.603Z`,
      ]);
      const named = new Set(rows.flatMap((row) => row.blobs ?? []));
      expect([...named].sort()).toEqual(Object.keys(bundle.blobs).map((hex) => `sha256:${hex}`).sort());
      expect(rows.every((row) => !("imageFile" in (row.content as JsonObject)))).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const bundle = await collect(screenRecorder.read(shipped(home.blobs, swiftBundle()), home.blobs));
      const inline = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery()), home.blobs));
      expect(inline.map((row) => row.key)).toEqual(["20261001T094917.303Z", "20261001T094919.403Z", "20261001T094919.403Z:1"]);
      const goldens = { bundle: new URL("./test/recorder-bundle.golden.json", import.meta.url), inline: new URL("./test/recorder-inline.golden.json", import.meta.url) };
      artifact(home.dir, "parity.json", { bundle: expectParity(bundle, goldens.bundle), inline: expectParity(inline, goldens.inline) });
    } finally {
      home.close();
    }
  });

  it("a later delta without earlier lines lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(screenRecorder, shipped(home.blobs, swiftBundle()));
      const later = inlineDelivery();
      const landed = await home.land(screenRecorder, shipped(home.blobs, later));
      expect(landed).toMatchObject({ new: 3, gone: 0 });
      expect(home.heads(RECORDER_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("observations of one millisecond rank by anything but capture folder, or a line out of folder order lands", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const lines = [frameLine(folderAt(at, 1), observation(at)), frameLine(folderAt(at + 0.5, 2), observation(at + 0.5)), gapLine(folderAt(at + 0.6, 3), observation(at + 0.6).replace('"captured"', '"gap"'))];
      const rows = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join(""))), home.blobs));
      expect(rows.map((row) => `${row.kind} ${row.key} ${row.locator}`)).toEqual([
        `${FRAME} 20261001T094919.403Z ${folderAt(at, 1)}`,
        `${FRAME} 20261001T094919.403Z:1 ${folderAt(at + 0.5, 2)}`,
        `${GAP} 20261001T094919.403Z ${folderAt(at + 0.6, 3)}`,
      ]);
      const swapped = Buffer.from([lines[1], lines[0]].map((line) => `${line}\n`).join(""));
      const out = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery(), swapped), home.blobs));
      expect(out.map((row) => (row.refused === undefined ? `${row.kind} ${row.locator}` : `refused ${row.key}`))).toEqual([`${FRAME} ${folderAt(at + 0.5, 2)}`, "refused observations.jsonl:2"]);
      expect(out[1]!.refused).toMatch(/does not follow/u);
      const landed = await home.land(screenRecorder, shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join(""))));
      expect(landed).toMatchObject({ new: 3, duplicated: 0 });
      artifact(home.dir, "ranks.json", rows.map((row) => [row.kind, row.key, row.locator]));
    } finally {
      home.close();
    }
  });

  it("a line refused after its instant reads takes no rank, or a refused line's folder holds back the lines after it", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const shapeless = `{"bundle":"${folderAt(at + 0.2, 2).replaceAll("/", "\\/")}","observation":${observation(at + 0.2)},"archive":null,"pending":null}`;
      const timeless = frameLine(folderAt(at + 9000, 4), observation(at).replace(`"capturedAt":${at}`, '"capturedAt":null'));
      const lines = [frameLine(folderAt(at, 1), observation(at)), shapeless, frameLine(folderAt(at + 0.4, 3), observation(at + 0.4)), timeless, frameLine(folderAt(at + 1000, 5), observation(at + 1000))];
      const rows = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join(""))), home.blobs));
      expect(rows.map((row) => (row.refused === undefined ? `${row.kind} ${row.key}` : `refused ${row.key}`))).toEqual([
        `${FRAME} 20261001T094919.403Z`,
        "refused observations.jsonl:2",
        `${FRAME} 20261001T094919.403Z:2`,
        "refused observations.jsonl:4",
        `${FRAME} 20261001T094920.403Z`,
      ]);
      artifact(home.dir, "refused-ranks.json", rows.map((row) => [row.kind, row.key, row.refused ?? null]));
    } finally {
      home.close();
    }
  });

  it("a frame whose text does not splice to the observation the recorder wrote is stated, or takes the lines after it with it", async () => {
    const home = openTestHome();
    try {
      const bundle = swiftBundle();
      const text = bundle.files["observations.jsonl"]!.toString("utf8");
      const lines = text.split("\n");
      const packed = lines.findIndex((line) => line.includes('"text":{'));
      expect(packed).toBeGreaterThanOrEqual(0);
      lines[packed] = lines[packed]!.replace("Example Browser", "Example Browsex");
      const landed = await home.land(screenRecorder, shipped(home.blobs, bundle, Buffer.from(lines.join("\n"))));
      expect(landed).toMatchObject({ new: 5, refused: 1 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([`observations.jsonl:${packed + 1}`]);
      expect(landed.refusals[0]!.violations.join()).toMatch(/not the observation the recorder wrote/u);
      const absent = openTestHome();
      try {
        const segment = Object.keys(bundle.blobs).find((hex) => lines.some((line) => line.includes('"text":{') && line.includes(Buffer.from(hex, "hex").toString("base64").replaceAll("/", "\\/"))))!;
        const { [segment]: _missing, ...others } = bundle.blobs;
        const delivery = shipped(absent.blobs, { ...bundle, blobs: others });
        const landed = await absent.land(screenRecorder, delivery);
        expect(landed).toMatchObject({ new: 6, refused: 0 });
        expect(absent.blobs.has(`sha256:${segment}`)).toBe(false);
      } finally {
        absent.close();
      }
    } finally {
      home.close();
    }
  });

  it("a span gap the recorder states for its own absence or a failed store, or the spans of idle and the full disk, lands as an instant or is refused", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const spans: [string, number, number][] = [
        ["recorder-not-running", at, at + 3 * 3_600_000 + 0.5],
        ["storage-failed", at + 4 * 3_600_000, at + 4 * 3_600_000 + 600_000],
        ["storage_backpressure", at + 5 * 3_600_000, at + 5 * 3_600_000 + 1_800_000],
        ["input-inactive-capture-paused", at + 6 * 3_600_000, at + 6 * 3_600_000 + 2_400_000],
      ];
      const gap = (reason: string, from: number, until: number) =>
        `{"capturedAt":${from},"capturedUntil":${until},"displayID":0,"height":0,"ocr":[],"ocrStatus":"not-run","reason":"${reason}","status":"gap","width":0,"windows":[]}`;
      const lines = spans.map(([reason, from, until], index) => gapLine(folderAt(from, index + 1), gap(reason, from, until)));
      const delivery = shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join("")));
      const landed = await home.land(screenRecorder, delivery);
      expect(landed).toMatchObject({ new: 4, refused: 0 });
      const heads = home.heads(RECORDER_SOURCE);
      expect(heads.map((head) => [head.kind, head.start_ms, head.end_ms])).toEqual(spans.map(([, from, until]) => [GAP, Math.floor(from), Math.floor(until)]));
      const rows = await collect(screenRecorder.read(delivery, home.blobs));
      expect(rows.map((row) => (row.content as JsonObject).reason)).toEqual(spans.map(([reason]) => reason));
      artifact(home.dir, "span-gaps.json", heads);
    } finally {
      home.close();
    }
  });

  it("a frame an earlier Mac wrote with `pageStale` is refused, or loses the member", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const stale = '"pageStale":{"ageMs":4210,"cause":"browser-did-not-answer"},';
      const lines = [frameLine(folderAt(at, 1), observation(at, stale)), frameLine(folderAt(at + 2000, 2), observation(at + 2000))];
      const rows = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join(""))), home.blobs));
      expect(rows.map((row) => row.refused ?? null)).toEqual([null, null]);
      expect(rows.map((row) => (row.content as JsonObject).pageStale ?? null)).toEqual([{ ageMs: 4210, cause: "browser-did-not-answer" }, null]);
    } finally {
      home.close();
    }
  });

  it("a frame an earlier Mac wrote with its image `pending` is refused, or loses where its pixels went", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const folder = folderAt(at, 1);
      const sha256 = "ab".repeat(32);
      const pending = `{"bytes":4096,"file":"${folder.replaceAll("/", "\\/")}\/image.pending","sha256":"${sha256}"}`;
      const line = frameLine(folder, observation(at)).replace('"pending":null', `"pending":${pending}`);
      const rows = await collect(screenRecorder.read(shipped(home.blobs, inlineDelivery(), Buffer.from(`${line}\n`)), home.blobs));
      expect(rows.map((row) => row.refused ?? null)).toEqual([null]);
      expect((rows[0]!.content as JsonObject).image).toEqual({ pending: { bytes: 4096, file: `${folder}/image.pending`, sha256 } });
      expect(rows[0]!.blobs).toEqual([`sha256:${sha256}`]);
    } finally {
      home.close();
    }
  });

  it("a gap run whose first attempt is not the gap, or an instant core cannot read, takes the lines after it with it, or is read", async () => {
    const home = openTestHome();
    try {
      const at = 1_790_848_159_403.25;
      const folder = folderAt(at, 1);
      const later = folderAt(at + 2000, 2);
      const gap = observation(at).replace('"captured"', '"gap"');
      const run = `{"attempts":[["${later.replaceAll("/", "\\/")}","${at}",null,null],["${folderAt(at + 4000, 3).replaceAll("/", "\\/")}","${at + 4000}",null,null]]}`;
      const lines = [gapLine(folder, gap, run), frameLine(folderAt(at + 6000, 4), observation(9e15)), frameLine(folderAt(at + 8000, 5), observation(at + 8000))];
      const landed = await home.land(screenRecorder, shipped(home.blobs, inlineDelivery(), Buffer.from(lines.map((line) => `${line}\n`).join(""))));
      expect(landed).toMatchObject({ new: 1, refused: 2 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual(["observations.jsonl:1", "observations.jsonl:2"]);
      expect(landed.refusals[1]!.violations.join()).toMatch(/capturedAt 9000000000000000: .*outside the years/u);
      expect(home.heads(RECORDER_SOURCE)).toHaveLength(1);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });
});
