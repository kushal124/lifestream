import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openHomeFolder, sha256, type DaySettings, type DetailType, type Json } from "@lifestreamprotocol/core";
import { openHider, openMarks, passagesOf, type Detector, type DetectorModel, type DetectorState, type MarksStore, type PassageMark } from "@lifestreamprotocol/privacy";
import { startHome, type Home } from "./home.js";
import { forgetMarks, markingProgress, marksFileOf, openMarking, screenQueue, searchQueue } from "./marking.js";
import { ScreenIndex, screenFileOf, type ScreenFrame, type ScreenSegment, type ScreenSource } from "./screen-index.js";
import { SCREEN_INDEX } from "./screen-job.js";
import { SearchIndex, searchFileOf, type RecordEntry } from "./search-index.js";
import { askHome } from "./socket.js";
import { TEST_UNIT, testSocket } from "./test/folder.js";
import { screenFamily } from "./test/fakes.js";
import { FAKES, makeRoot, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { REPO } from "./test/support.js";

const scratch = mkdtempSync(join(tmpdir(), "lifestream-screen-marking-"));
const artifact: Record<string, unknown> = {};
afterAll(() => {
  mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
  writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "screen-marking.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  rmSync(scratch, { recursive: true, force: true });
});

const MODEL: DetectorModel = { id: "privacy-filter", file: "sha256:0f0f", decode: "1" };
const OTHER: DetectorModel = { id: "privacy-filter", file: "sha256:1e1e", decode: "1" };
const DAYS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const MINUTE = 60_000;
const SEG = 5 * MINUTE;
const MACHINE = "mac-0001";
const NOTES = "apple-notes:local:device-a";

function played() {
  let state: DetectorState = { state: "ready", model: MODEL };
  let held: Promise<void> | null = null;
  const calls: string[][] = [];
  const detector: Detector = {
    state: () => state,
    async find(passages) {
      calls.push([...passages]);
      const holding = held;
      held = null;
      if (holding !== null) await holding;
      return {
        model: state.state === "ready" ? state.model : MODEL,
        marks: passages.map((passage): PassageMark[] => (passage.includes("Ada Example") ? [{ start: passage.indexOf("Ada Example"), end: passage.indexOf("Ada Example") + 11, type: "person" as DetailType }] : [])),
      };
    },
  };
  return {
    detector, calls,
    set(next: DetectorState) {
      state = next;
    },
    hold(): () => void {
      let release!: () => void;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
  };
}

function segment(minute: number, title: string, lines: readonly string[], version = "v1"): ScreenSegment {
  const start_ms = T0 + minute * MINUTE;
  const frames: ScreenFrame[] = Array.from({ length: 30 }, (_, i) => ({ t: start_ms + i * 10_000, app: "Example Editor", title, site: null, display: "1", lines }));
  return { machine: MACHINE, version, start_ms, frames };
}

const lines = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `Screen line ${from + i} names Ada Example`);

function sourceOf(segments: readonly ScreenSegment[]): ScreenSource {
  return { segments: (machine) => segments.filter((each) => each.machine === machine) };
}

const note = (key: string, text: string, minutes: number): RecordEntry => ({
  record: { source: NOTES, kind: "note", key }, family: "notes", version: `v-${key}-${text.length}`, start_ms: T0 + minutes * MINUTE, end_ms: null, title: "", text, who: [], link: null,
});

function scenario(name: string, resting?: () => Promise<boolean>) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const searchFile = join(dir, "index.db");
  const screenFile = screenFileOf(searchFile);
  const marksFile = join(dir, "privacy", "marks.db");
  const queues = [searchQueue(openHomeFolder(dirname(searchFile)), searchFile), screenQueue(openHomeFolder(dirname(screenFile)), screenFile)];
  const play = played();
  const logs: Record<string, Json>[] = [];
  const marks: MarksStore = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
  const hider = openHider({
    people: () => ({ version: "people-1", owner: null, people: [] }),
    settings: () => ({ level: "all", chat: "all", detector: `runner-${TEST_UNIT}`, links: "tokens", always: [], never: [] }),
    detector: play.detector, pictures: { read: () => Promise.reject(new Error("no picture here")), make: () => Promise.reject(new Error("no picture here")) }, marks,
  });
  const job = openMarking({ queues, hider, detector: play.detector, marks, chosen: () => true, log: (line) => logs.push(line), look_ms: 0, rest_ms: 0, ...(resting === undefined ? {} : { resting }) });
  let seq = 0;
  let segments: ScreenSegment[] = [];
  return {
    searchFile, screenFile, marksFile, play, logs, marks, job,
    notes(entries: RecordEntry[]) {
      const index = SearchIndex.write(openHomeFolder(dirname(searchFile)), searchFile, () => true, 0, DAYS);
      try {
        index.records(entries, [], { position: { seq: ++seq, statement: `s-${seq}`, reread: 0 } });
        index.finish();
      } finally {
        index.close();
      }
    },
    screen(added: ScreenSegment[], fresh = false) {
      segments = [...segments.filter((held) => !added.some((each) => each.machine === held.machine && each.start_ms === held.start_ms)), ...added];
      const index = ScreenIndex.write(openHomeFolder(dirname(screenFile)), screenFile, { days: DAYS, meaning: false }, () => !fresh);
      try {
        index.apply(fresh ? segments : added, sourceOf(segments), { seq: ++seq });
        index.finish();
      } finally {
        index.close();
      }
    },
    progress: (model: DetectorModel | null = MODEL) => markingProgress(queues, marks, model)!,
    async drain() {
      await until("every row of both queues is marked", async () => {
        await job.poke();
        const progress = markingProgress(queues, marks, MODEL)!;
        return progress.marked === progress.total;
      });
    },
    kept(text: string) {
      const digests = passagesOf(text).map((passage) => sha256(text.slice(passage.start, passage.end)));
      return marks.read(digests, MODEL).size === digests.length;
    },
  };
}

describe("the marking job over the screen index", () => {
  it("marks every screen row after the search entries, each line a passage of its own, and counts both queues in one share", async () => {
    const run = scenario("both");
    run.notes([note("n1", "Lunch with Ada Example at noon.", 0)]);
    run.screen([segment(0, "Draft — Notes", lines(0, 3)), segment(5, "Draft — Notes", lines(3, 6))]);
    const before = run.progress();
    expect(before).toEqual({ marked: 0, total: 3, line: "Marked 0% of your record" });
    await run.drain();
    artifact.both = { calls: run.play.calls, progress: run.progress() };
    expect(run.progress()).toEqual({ marked: 3, total: 3, line: "Marked 100% of your record" });
    expect(run.play.calls[0]).toContain("Lunch with Ada Example at noon.");
    expect(run.play.calls[0]!.some((passage) => passage.startsWith("Screen line"))).toBe(false);
    const sent = run.play.calls.flat();
    for (const line of lines(0, 6)) {
      expect(sent).toContain(line);
      expect(run.kept(line)).toBe(true);
    }
    expect(sent.some((passage) => passage.includes("Draft"))).toBe(true);
  });

  it("serves a search entry written while the screen's backlog waits before the rest of the backlog", async () => {
    const run = scenario("backlog");
    run.screen(Array.from({ length: 10 }, (_, s) => segment(s * 5, `Page ${s}`, lines(s * 10, s * 10 + 10))));
    const release = run.play.hold();
    const running = run.job.poke();
    await until("the first screen find is placed", () => run.play.calls.length === 1);
    run.notes([note("n1", "A note written meanwhile, Ada Example.", 60)]);
    release();
    await running;
    await run.drain();
    artifact.backlog = { calls: run.play.calls.map((call) => call.length) };
    expect(run.play.calls[1]).toContain("A note written meanwhile, Ada Example.");
    expect(run.play.calls[1]!.some((passage) => passage.startsWith("Screen line"))).toBe(false);
    expect(run.progress().marked).toBe(11);
  });

  it("queues a rebuilt machine-day's rows again, a row the batch read before the rebuild standing, and marks none of its kept lines again", async () => {
    const run = scenario("rebuild");
    run.screen([segment(0, "Draft", lines(0, 2)), segment(5, "Draft", lines(2, 4))]);
    await run.drain();
    const index = ScreenIndex.marking(openHomeFolder(dirname(run.screenFile)), run.screenFile)!;
    try {
      run.screen([segment(0, "Draft", [...lines(0, 2), "A line added later"], "v2")]);
      expect(run.progress().marked).toBe(0);
      const taken = index.unmarked({ store: run.marks.id, model: JSON.stringify([MODEL.id, MODEL.file, MODEL.decode]) }, 10);
      expect(taken.length).toBe(2);
      run.screen([segment(5, "Draft", [...lines(2, 4), "Another later line"], "v2")]);
      index.marked(taken);
      expect(run.progress()).toMatchObject({ marked: 0, total: 2 });
    } finally {
      index.close();
    }
    const calls = run.play.calls.length;
    await run.drain();
    expect(run.play.calls.slice(calls).flat().sort()).toEqual(["A line added later", "Another later line"]);
    expect(run.progress()).toMatchObject({ marked: 2, total: 2 });
  });

  it("counts every screen row unmarked under another model, and marks the build that replaced screen.db under the run", async () => {
    const run = scenario("model");
    run.notes([note("n1", "Ada Example", 0)]);
    run.screen([segment(0, "Draft", lines(0, 2))]);
    await run.drain();
    expect(run.progress(OTHER)).toMatchObject({ marked: 0, total: 2 });
    run.screen([segment(5, "Draft", lines(2, 3))], true);
    expect(run.progress()).toMatchObject({ marked: 1, total: 3 });
    const calls = run.play.calls.length;
    await run.drain();
    expect(run.play.calls.slice(calls).flat()).toEqual([lines(2, 3)[0]]);
  });

  it("passes the screen queue over while the screen job holds its write lock, marks the search entries meanwhile, and goes on once it lets go", async () => {
    const run = scenario("busy");
    run.screen([segment(0, "Draft", lines(0, 2))]);
    const writer = new Database(run.screenFile);
    writer.prepare("BEGIN IMMEDIATE").run();
    try {
      await run.job.poke();
      expect(run.logs.some((line) => line.marks === "failed")).toBe(false);
      expect(run.logs.at(-1)).toMatchObject({ marks: "busy", queues: ["screen.db"] });
      expect(run.progress()).toMatchObject({ marked: 0, total: 1 });
      run.notes([note("n1", "Ada Example", 0)]);
      await run.job.poke();
      expect(run.progress()).toMatchObject({ marked: 1, total: 2 });
      expect(run.kept("Ada Example")).toBe(true);
      const said = run.logs.length;
      await run.job.poke();
      expect(run.logs.slice(said).filter((line) => line.marks === "busy")).toEqual([]);
    } finally {
      writer.prepare("COMMIT").run();
      writer.close();
    }
    await run.drain();
    expect(run.progress()).toMatchObject({ marked: 2, total: 2 });
  });

  it("marks the screen queue only while the detector's machine rests, the search entries meanwhile, and asks the machine only when a screen row waits", async () => {
    let rests = false;
    let asked = 0;
    const resting = async () => {
      asked += 1;
      return rests;
    };
    const quiet = scenario("resting-none", resting);
    quiet.notes([note("n1", "Ada Example", 0)]);
    await quiet.drain();
    expect(asked).toBe(0);

    const run = scenario("resting", resting);
    run.screen([segment(0, "Draft", lines(0, 2))]);
    run.notes([note("n1", "Lunch with Ada Example.", 0)]);
    await run.job.poke();
    expect(run.progress()).toMatchObject({ marked: 1, total: 2 });
    expect(run.play.calls.flat().some((passage) => passage.startsWith("Screen line"))).toBe(false);
    expect(run.logs.at(-1)).toMatchObject({ marks: "resting" });
    expect(asked).toBeGreaterThan(0);
    const said = run.logs.length;
    await run.job.poke();
    expect(run.logs.slice(said)).toEqual([]);
    rests = true;
    await run.drain();
    expect(run.kept(lines(0, 1)[0]!)).toBe(true);
    artifact.resting = { asked, logs: run.logs };
  });

  it("forgets the marks of the erased rows' lines when the screen index is erased, and keeps the rest", async () => {
    const run = scenario("erase");
    const first = segment(0, "Draft", ["An erased line, Ada Example"]);
    const later = segment(30, "Draft", ["A line that stays, Ada Example"]);
    run.screen([first, later]);
    await run.drain();
    expect(run.kept("An erased line, Ada Example")).toBe(true);
    const epoch = run.marks.epoch;
    ScreenIndex.erase(openHomeFolder(dirname(run.screenFile)), run.screenFile, [{ machine: MACHINE, from_ms: first.start_ms, to_ms: first.start_ms + SEG }], sourceOf([later]), (texts) => {
      forgetMarks(openHomeFolder(dirname(run.marksFile)), run.marksFile, texts);
    });
    expect(run.kept("An erased line, Ada Example")).toBe(false);
    expect(run.kept("A line that stays, Ada Example")).toBe(true);
    expect(run.marks.epoch).not.toBe(epoch);
  });
});

describe("the screen's marks in a home's erasure", () => {
  const SOURCE = `screen:local:${MACHINE}`;
  let root: string | undefined;
  let home: Home | undefined;
  afterAll(async () => {
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  const frame = (key: string, at: number, ...texts: string[]) => ({
    kind: "frame", key, at,
    content: {
      at, status: "captured", displayID: 1,
      application: { name: "Example Editor", bundleID: "com.example.editor" },
      frontWindow: { windowID: 11 }, windows: [{ windowID: 11, title: "Notes" }],
      accessibility: { nodes: texts.map((value) => ({ depth: 1, role: "AXStaticText", value })) },
      ocr: [],
    },
  });

  it("forgets the erased frame's lines in the marks store through the erase verb", async () => {
    root = makeRoot("lifestream-screen-marks-erase-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true } } });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [frame("e1", T0, "lima line"), frame("e4", T0 + 15 * MINUTE, "oscar line")] as never });
    const screenFile = screenFileOf(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!));
    await until("the screen index holds both frames", () => {
      const index = ScreenIndex.read(openHomeFolder(dirname(screenFile)), screenFile);
      if (index === undefined) return false;
      try {
        return index.markCounts({ store: "", model: null }).entries === 2;
      } finally {
        index.close();
      }
    });
    const marksFile = marksFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!);
    const store = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
    try {
      const digest = (text: string) => sha256(text);
      expect(store.write(MODEL, new Map([[digest("lima line"), []], [digest("oscar line"), []]]), store.epoch)).toBe(true);
      const erased = await askHome(testSocket(root), "erase", ["screen", "e1", "--apply"]) as { applied: boolean };
      expect(erased.applied).toBe(true);
      expect([...store.read([digest("lima line"), digest("oscar line")], MODEL).keys()]).toEqual([digest("oscar line")]);
    } finally {
      store.close();
    }
  });

  it("forgets the marks a reader made of a frame's lines before any index held it, read from the frame itself", async () => {
    await home?.stop();
    if (root !== undefined) removeRoot(root);
    root = makeRoot("lifestream-screen-marks-early-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true } } });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [frame("e1", T0, "papa line"), frame("e4", T0 + 15 * MINUTE, "quebec line")] as never });
    const machineDir = process.env.LIFESTREAM_MACHINE_DIR!;
    const screenFile = screenFileOf(searchFileOf(root, machineDir));
    await until("the screen index holds both frames", () => {
      const index = ScreenIndex.read(openHomeFolder(dirname(screenFile)), screenFile);
      if (index === undefined) return false;
      try {
        return index.markCounts({ store: "", model: null }).entries === 2;
      } finally {
        index.close();
      }
    });
    await home.stop();
    home = undefined;
    for (const name of readdirSync(dirname(screenFile)).filter((each) => each.startsWith("screen"))) rmSync(join(dirname(screenFile), name), { recursive: true, force: true });
    const marksFile = marksFileOf(root, machineDir);
    const store = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
    try {
      const digest = (text: string) => sha256(text);
      expect(store.write(MODEL, new Map([[digest("papa line"), []], [digest("quebec line"), []]]), store.epoch)).toBe(true);
      SCREEN_INDEX.forget({
        folder: openHomeFolder(root), machine: machineDir, blobs: openHomeFolder(root).blobs(join(root, "blobs")), settings: { day: DAYS, screen_cutover_ms: 0 }, families: [screenFamily({ index: true })],
        forgetMarks: (texts) => forgetMarks(openHomeFolder(dirname(marksFile)), marksFile, texts), wait_ms: 0, kept: [],
      }, [{ source: SOURCE, kind: "frame", key: "e1" }], []);
      expect(existsSync(screenFile)).toBe(false);
      expect([...store.read([digest("papa line"), digest("quebec line")], MODEL).keys()]).toEqual([digest("quebec line")]);
    } finally {
      store.close();
    }
  });

  it("forgets the marks of every version an erased frame stated, an earlier one's lines no index or current version holds", async () => {
    await home?.stop();
    if (root !== undefined) removeRoot(root);
    root = makeRoot("lifestream-screen-marks-versions-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.screen": { index: true } } });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
    const machineDir = process.env.LIFESTREAM_MACHINE_DIR!;
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [frame("e1", T0, "tango line"), frame("e4", T0 + 15 * MINUTE, "uniform line")] as never });
    await ship(root, { source: SOURCE, fetched_ms: Date.now() + 1, rows: [frame("e1", T0, "victor line")] as never });
    await until("home.db holds both versions of the frame", () => {
      const db = new Database(join(root!, "home.db"), { readonly: true });
      try {
        return (db.prepare("SELECT count(DISTINCT version) FROM statements WHERE key = 'e1' AND version <> 'gone'").pluck().get() as number) === 2;
      } finally {
        db.close();
      }
    });
    await home.stop();
    home = undefined;
    const marksFile = marksFileOf(root, machineDir);
    const store = openMarks(openHomeFolder(dirname(marksFile)), marksFile);
    try {
      const digest = (text: string) => sha256(text);
      const lines = ["tango line", "victor line", "uniform line"].map(digest);
      expect(store.write(MODEL, new Map(lines.map((each) => [each, []])), store.epoch)).toBe(true);
      SCREEN_INDEX.forget({
        folder: openHomeFolder(root), machine: machineDir, blobs: openHomeFolder(root).blobs(join(root, "blobs")), settings: { day: DAYS, screen_cutover_ms: 0 }, families: [screenFamily({ index: true })],
        forgetMarks: (texts) => forgetMarks(openHomeFolder(dirname(marksFile)), marksFile, texts), wait_ms: 0, kept: [],
      }, [{ source: SOURCE, kind: "frame", key: "e1" }], []);
      expect([...store.read(lines, MODEL).keys()]).toEqual([digest("uniform line")]);
    } finally {
      store.close();
    }
  });
});
