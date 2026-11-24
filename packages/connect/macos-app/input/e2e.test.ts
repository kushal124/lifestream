import { artifact, collect, counts, deliver, expectParity, openTestHome, temp } from "../../test/drive.js";
import { describe, expect, it } from "vitest";
import { inputEvents } from "./reader.js";
import { logFile, chunkLine, INPUT_FACTS, INPUT_SOURCE, inputFiles } from "./test/fixture.js";

const GOLDEN = new URL("./test/parity.golden.json", import.meta.url);

describe("input events: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    try {
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, inputFiles(), INPUT_FACTS));
      expect(landed).toMatchObject({ new: 5, refused: 0, duplicated: 0 });
      const heads = home.heads(INPUT_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["20260906T230000Z", Date.parse("2026-09-06T23:00:00Z"), Date.parse("2026-09-06T23:01:00Z")],
        ["20260906T230100Z", Date.parse("2026-09-06T23:01:00Z"), Date.parse("2026-09-06T23:02:00Z")],
        ["20260906T230200Z", Date.parse("2026-09-06T23:02:00Z"), Date.parse("2026-09-06T23:02:30.125Z")],
        ["20260906T233000Z", Date.parse("2026-09-06T23:30:00Z"), Date.parse("2026-09-06T23:31:00Z")],
        ["20260906T233000Z:1", Date.parse("2026-09-06T23:30:00Z"), Date.parse("2026-09-06T23:30:40.500Z")],
      ]);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const rows = await collect(inputEvents.read(deliver(home, INPUT_SOURCE, inputFiles(), INPUT_FACTS), home.blobs));
      artifact(home.dir, "parity.json", expectParity(rows, GOLDEN));
    } finally {
      home.close();
    }
  });

  it("a later delivery without an earlier file lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(inputEvents, deliver(home, INPUT_SOURCE, inputFiles(), INPUT_FACTS));
      const later = { "20260907T000000.000Z.jsonl": logFile([chunkLine({ at: "2026-09-07T00:00:00.000Z", until: "2026-09-07T00:01:00.000Z" })]) };
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, later, { snapshot_taken_at: "2026-09-07T00:02:00.000Z" }));
      expect(landed).toMatchObject({ new: 1, gone: 0 });
      expect(home.heads(INPUT_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
      artifact(home.dir, "heads.json", home.heads(INPUT_SOURCE));
    } finally {
      home.close();
    }
  });

  it("two chunks in one delivery state one key, or a chunk outside the contract lands", async () => {
    const home = openTestHome();
    try {
      const files = {
        "20260906T230000.000Z.jsonl": logFile([
          chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:01:00.000Z" }),
          chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:01:00.000Z" }),
          chunkLine({ at: "2026-09-06T23:01:00.000Z", until: "2026-09-06T23:02:00.000Z", events: [{ e: "teleport", t: 1 }] }),
          chunkLine({ at: "2026-09-06T23:02:00.000Z", until: "2026-09-06T23:03:00.000Z", events: [{ e: "down", t: 1, app: 3 }] }),
        ]),
      };
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, files, INPUT_FACTS));
      expect(landed).toMatchObject({ new: 2, duplicated: 0, refused: 2 });
      expect(landed.refusals.map((refusal) => refusal.violations)).toEqual([
        ["events[0] type \"teleport\" is outside the closed list"],
        ["events[0] app is not an index into apps"],
      ]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a minute refused for space, stated as its loss-only line, is refused or lands without its loss", async () => {
    const home = openTestHome();
    try {
      const files = {
        "20260906T230000.000Z.jsonl": logFile([
          chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:01:00.000Z" }),
          chunkLine({ at: "2026-09-06T23:01:00.000Z", until: "2026-09-06T23:02:00.000Z", apps: [], events: [], lost: 412 }),
        ]),
      };
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, files, INPUT_FACTS));
      expect(landed).toMatchObject({ new: 2, refused: 0 });
      const heads = home.heads(INPUT_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["20260906T230000Z", Date.parse("2026-09-06T23:00:00Z"), Date.parse("2026-09-06T23:01:00Z")],
        ["20260906T230100Z", Date.parse("2026-09-06T23:01:00Z"), Date.parse("2026-09-06T23:02:00Z")],
      ]);
      const rows = await collect(inputEvents.read(deliver(home, INPUT_SOURCE, files, INPUT_FACTS), home.blobs));
      expect(rows[1]!.content).toEqual({ type: "input.chunk", until: "2026-09-06T23:02:00.000Z", layout: "com.example.keylayout.US", apps: [], events: [], lost: 412 });
      artifact(home.dir, "loss-only.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a chunk without a millisecond UTC `at`, or a line that is not one JSON object, takes the chunks after it with it, or lands", async () => {
    const home = openTestHome();
    try {
      const log = logFile([
        chunkLine({ at: "2026-09-06T23:00:00Z", until: "2026-09-06T23:01:00.000Z" }),
        "not json",
        chunkLine({ at: "2026-09-06T23:01:00.000Z", until: "2026-13-06T23:02:00.000Z" }),
        chunkLine({ at: "2026-09-06T23:02:00.000Z", until: "2026-09-06T23:03:00.000Z" }),
      ]);
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, { "20260906T230000.000Z.jsonl": log }, INPUT_FACTS));
      expect(landed).toMatchObject({ new: 1, refused: 3 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([1, 2, 3].map((line) => `20260906T230000.000Z.jsonl:${line}`));
      expect(home.heads(INPUT_SOURCE).map((head) => head.key)).toEqual(["20260906T230200Z"]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a line refused after its instant reads takes no rank, so a code that reads it moves a later line's key", async () => {
    const home = openTestHome();
    try {
      const log = logFile([
        chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:01:00.000Z" }),
        chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:61:00.000Z" }),
        chunkLine({ at: "2026-09-06T23:00:00.000Z", until: "2026-09-06T23:00:40.500Z" }),
      ]);
      const landed = await home.land(inputEvents, deliver(home, INPUT_SOURCE, { "20260906T230000.000Z.jsonl": log }, INPUT_FACTS));
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual(["20260906T230000.000Z.jsonl:2"]);
      expect(home.heads(INPUT_SOURCE).map((head) => head.key)).toEqual(["20260906T230000Z", "20260906T230000Z:2"]);
      artifact(home.dir, "ranks.json", { landed, heads: home.heads(INPUT_SOURCE) });
    } finally {
      home.close();
    }
  });
});
