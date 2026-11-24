import { createHash } from "node:crypto";
import fs, { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHomeFolder, type HomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder, testMachine } from "@lifestreamprotocol/core/test/keyed";
import { documentText, RENDERER_VERSION } from "@lifestreamprotocol/families";
import { Agents, type AgentsOptions } from "./agents.js";
import { openStage } from "./ask-files.js";
import { dayFile, readDayHead, readDays, renderKind, sweepDayTemporaries } from "./derive.js";
import { FINDINGS_FILE, forgetMatches, keepMatch, matchesForgotten } from "./engine-pictures.js";
import { ErasableStreams } from "./erasable-streams.js";
import { HomeFile } from "./home-file.js";
import type { Main, Running } from "./jobs.js";
import type { Machine } from "./machine.js";
import { forgetPictures, fromBytes, openPictures, PICTURE_FILE, type Maker } from "./pictures.js";
import { openReads } from "./reads.js";
import { days } from "./search.js";
import { SearchIndex } from "./search-index.js";
import type { Settings } from "./settings.js";
import { inboxLane, UPLOAD } from "./inbox.js";

const CANARY = "canary-7f3a9c-synthetic";
const BLOB = `sha256:${"ab".repeat(32)}`;
const made: string[] = [];

afterAll(() => {
  for (const each of made) rmSync(each, { recursive: true, force: true });
});

function fresh(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `lifestream-kept-${name}-`));
  made.push(root);
  return root;
}

function homes(name: string): { keyed: HomeFolder; plain: HomeFolder; machine: string; mine: string } {
  const machine = testMachine();
  return { keyed: keyedFolder(fresh(`${name}-keyed`), machine), plain: openHomeFolder(fresh(`${name}-plain`)), machine, mine: join(machine, name) };
}

function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function canaries(...dirs: string[]): string[] {
  return dirs.flatMap((dir) => filesUnder(dir).filter((file) => readFileSync(file).includes(CANARY)).map((file) => relative(dir, file)));
}

function sealedNames(dir: string): string[] {
  return filesUnder(dir).map((file) => relative(dir, file)).filter((name) => !name.startsWith("config/"));
}

function renamesFrom<T>(run: () => T, died = false): { from: string[]; value: T } {
  const real = fs.renameSync;
  const from: string[] = [];
  fs.renameSync = (source, target) => {
    from.push(String(source));
    if (died) throw Object.assign(new Error("the process died here"), { code: "EDIED" });
    real(source, target);
  };
  syncBuiltinESMExports();
  try {
    return { from, value: run() };
  } finally {
    fs.renameSync = real;
    syncBuiltinESMExports();
  }
}

function thrownCode(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

const INPUTS = `sha256:${"cd".repeat(32)}`;
const dayDocument = (day: string) => documentText({
  day, zone: "UTC", day_start_hour: 0, window: { start_ms: Date.parse(`${day}T00:00:00Z`), end_ms: Date.parse(`${day}T00:00:00Z`) + 86_400_000 }, renderer: RENDERER_VERSION, inputs: INPUTS,
  counts: { total: 0, per_family: {} }, coverage: [], atoms: [], facts: [],
});
const dayText = (file: "json" | "txt" | "lines", day: string) => (file === "json" ? dayDocument(day) : `${day}: ${CANARY}\n`);
const DAY_FILE_NAMES = (day: string) => [`${day}.day.json`, `${day}.day.lines.json`, `${day}.day.txt`];

type Rendered = Parameters<NonNullable<typeof renderKind.chunk>>[2];

function rendered(folder: HomeFolder, day: string): { settle(): void } {
  const staged = (["lines", "txt", "json"] as const).map((file) => dayFile(folder, day, file).stage(Buffer.from(dayText(file, day))));
  const outcome = { day, marks: 1, head: { inputs: INPUTS, counts: { total: 0, per_family: {} } }, units: [], devices: [], staged: structuredClone(staged) } as Rendered;
  const running = { job: { id: 1 }, state: { written: 0, current: 0, set_aside: 0 } } as unknown as Running<never>;
  const [slice] = renderKind.chunk!({ folder } as Main, running, outcome);
  return { settle: () => slice!.settle!() };
}

const NO_ACCESS: AgentsOptions["access"] = {
  get: () => undefined,
  change: () => { throw new Error("a note changes no access"); },
  remove: () => { throw new Error("a note removes no access"); },
};

describe("the home's own files of the life, on a keyed folder", () => {
  it("day files: staged by the render, published at its settle, sealed, their head read back, the day listed by its plain name; a plain home keeps today's names, bytes and mode", () => {
    const { keyed, plain } = homes("days");
    for (const folder of [keyed, plain]) {
      const render = rendered(folder, "2026-11-14");
      expect(readDayHead(folder, "2026-11-14")).toBeNull();
      render.settle();
    }
    expect(canaries(keyed.root)).toEqual([]);
    expect(sealedNames(keyed.root).sort()).toEqual(DAY_FILE_NAMES("2026-11-14").map((name) => `days/${name}.k1`));
    for (const folder of [keyed, plain]) {
      expect(readDayHead(folder, "2026-11-14")).toMatchObject({ inputs: INPUTS });
      expect(readDayHead(folder, "2026-11-15")).toBeNull();
      const read = readDays(folder);
      expect("error" in read ? read : read.days).toEqual(["2026-11-14"]);
    }
    for (const file of ["json", "txt", "lines"] as const) expect(readFileSync(dayFile(plain, "2026-11-14", file).path, "utf8")).toBe(dayText(file, "2026-11-14"));
    expect(readdirSync(join(plain.root, "days")).sort()).toEqual(DAY_FILE_NAMES("2026-11-14"));
    expect(statSync(dayFile(plain, "2026-11-14", "json").path).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it("a discarded render publishes no day file, and the start's sweep leaves no stage of it, on either form", () => {
    const { keyed, plain } = homes("discarded");
    for (const folder of [keyed, plain]) {
      rendered(folder, "2026-11-14");
      const days = join(folder.root, "days");
      expect(readdirSync(days)).toHaveLength(3);
      expect(readDays(folder)).toMatchObject({ days: [] });
      sweepDayTemporaries(folder.root);
      expect(readdirSync(days)).toEqual([]);
    }
    writeFileSync(join(plain.root, "days", ".2026-11-15.day.json.0a0b.tmp"), "left by a crash before today");
    sweepDayTemporaries(plain.root);
    expect(readdirSync(join(plain.root, "days"))).toEqual([]);
  });

  it("a keyed home's day files: search lists and reads the day, and the door's day route serves each file streamed with its length", async () => {
    const { keyed, machine } = homes("day-reads");
    const day = "2026-11-14";
    for (const file of ["json", "txt", "lines"] as const) dayFile(keyed, day, file).write(Buffer.from(dayText(file, day)));
    const at = fresh("day-reads-index");
    const index = SearchIndex.write(openHomeFolder(at), join(at, "search.db"), () => true, 0, { zone: "UTC", day_start_hour: 0 });
    const result = { days: 0 };
    try {
      expect(days(keyed, index, result, performance.now())).toBe(false);
      expect([result.days, index.days().get(day)?.inputs]).toEqual([1, INPUTS]);
    } finally {
      index.close();
    }
    const reads = openReads({
      folder: keyed, home: new HomeFile(keyed), blobs: undefined as never, settings: () => ({ day: { zone: "UTC", day_start_hour: 0 } }) as Settings,
      streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
    });
    const route = reads.route(`/v1/days/${day}`)!;
    const server = createServer((request, response) => void route(request, response, { machine, still: () => true }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      for (const file of ["json", "txt", "lines"] as const) {
        const answer = await fetch(`http://127.0.0.1:${port}/v1/days/${day}?file=${file}`);
        const body = await answer.text();
        expect([answer.status, answer.headers.get("etag"), body], file).toEqual([200, `"${INPUTS}"`, dayText(file, day)]);
        expect(answer.headers.get("content-length"), file).toBe(String(Buffer.byteLength(body)));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("agents' notes: a note is kept sealed and read back; a plain note is appended, the earlier bytes untouched", () => {
    const { keyed, plain } = homes("notes");
    for (const folder of [keyed, plain]) {
      const agents = new Agents({ folder, machine: { dir: fresh("notes-dir") } as Machine, commit: (work) => work(undefined as never), tables: { drop: () => undefined }, access: NO_ACCESS, existing: () => [], now: () => Date.UTC(2026, 10, 14) });
      expect(agents.call("feedback", { category: "other", message: CANARY }, "pass-a")).toEqual({ outcome: "saved" });
      expect(agents.call("feedback", { category: "slow", message: "a second note" }, "pass-a")).toEqual({ outcome: "saved" });
      expect(agents.notes().map((note) => note.message)).toEqual(["a second note", CANARY]);
    }
    expect(canaries(keyed.root)).toEqual([]);
    expect(sealedNames(keyed.root)).toEqual(["agents/feedback.jsonl.k1/0.k1"]);
    const notes = join(plain.root, "agents", "feedback.jsonl");
    expect(readFileSync(notes, "utf8").split("\n").filter(Boolean)).toHaveLength(2);
    const before = readFileSync(notes);
    const inode = statSync(notes).ino;
    const agents = new Agents({ folder: plain, machine: { dir: fresh("notes-dir") } as Machine, commit: (work) => work(undefined as never), tables: { drop: () => undefined }, access: NO_ACCESS, existing: () => [], now: () => Date.UTC(2026, 10, 14) });
    expect(agents.call("feedback", { category: "other", message: "a third note" }, "pass-b")).toEqual({ outcome: "saved" });
    expect([statSync(notes).ino, readFileSync(notes).subarray(0, before.length).equals(before)]).toEqual([inode, true]);
  });

  it("faces findings: a match is kept sealed, Delete all face data finds it by its plain name, and the count reads back", () => {
    const { keyed, mine } = homes("findings");
    const findings = { folder: keyed, dir: join(mine, "privacy", "home-a", "findings") };
    const held = { has: () => true };
    keepMatch(findings, BLOB, [{ box: { x: 1, y: 1, width: 2, height: 2 }, who: `person:${CANARY}` }], held, matchesForgotten(findings));
    expect(canaries(mine)).toEqual([]);
    expect(sealedNames(findings.dir)).toEqual([`ab/${"ab".repeat(32)}.match.json.k1`]);
    expect(forgetMatches(findings)).toEqual([join(findings.dir, "ab")]);
    expect(matchesForgotten(findings)).toBe(1);
    expect(sealedNames(findings.dir)).toEqual(["matches.forgotten.k1"]);
  });

  it("faces findings on a plain home: a finding's and a match's temporaries are named as today, at today's modes, and a match's temporary left by a crash goes with Delete all face data", () => {
    const { plain } = homes("plain-findings");
    const findings = { folder: plain, dir: join(plain.root, "privacy", "home-a", "findings") };
    const hex = "ab".repeat(32);
    const shard = join(findings.dir, "ab");
    const open = 0o777 & ~process.umask();
    const finding = renamesFrom(() => plain.file(FINDINGS_FILE, join(shard, `${hex}.json`)).write(Buffer.from("{}\n")));
    const match = renamesFrom(() => keepMatch(findings, BLOB, [{ box: { x: 1, y: 1, width: 2, height: 2 } }], { has: () => true }, matchesForgotten(findings)));
    expect([...finding.from, ...match.from].map((each) => basename(each))).toEqual([expect.stringMatching(new RegExp(`^\\.${hex}\\.[0-9a-f]{12}\\.json$`, "u")), expect.stringMatching(new RegExp(`^\\.${hex}\\.[0-9a-f]{12}\\.match\\.json$`, "u"))]);
    expect([dirname(finding.from[0]!), dirname(match.from[0]!)]).toEqual([shard, shard]);
    expect([findings.dir, shard, join(shard, `${hex}.json`), join(shard, `${hex}.match.json`)].map((each) => statSync(each).mode & 0o777)).toEqual([open, open, open & 0o666, open & 0o666]);
    expect(thrownCode(() => renamesFrom(() => keepMatch(findings, BLOB, [{ box: { x: 3, y: 3, width: 2, height: 2 } }], { has: () => true }, matchesForgotten(findings)), true))).toBe("EDIED");
    expect(readdirSync(shard).filter((name) => name.startsWith(".")).length).toBe(1);
    forgetMatches(findings);
    expect(readdirSync(shard).sort()).toEqual([`${hex}.json`]);
  });

  it("pictures cache on a plain home: a marker is kept at today's name, bytes and mode", async () => {
    const { plain } = homes("plain-markers");
    const cache = { folder: plain, dir: join(plain.root, "pictures", "home-a") };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(await openPictures(cache, async () => ({ cannot: "This picture cannot be hidden: synthetic." })).picture(BLOB, "tile", fromBytes(jpeg, cache, () => true))).toBeNull();
    const [marker] = filesUnder(cache.dir);
    expect([basename(marker!), readFileSync(marker!, "utf8"), statSync(marker!).mode & 0o777]).toEqual([`${"ab".repeat(32)}.cannot`, "This picture cannot be hidden: synthetic.\n", 0o666 & ~process.umask()]);
    expect(plain.file(PICTURE_FILE, marker!).stat()?.size).toBe(statSync(marker!).size);
  });

  it("pictures cache: a made picture is kept sealed, served back through the handle, found again by its plain name, and forgotten", async () => {
    const { keyed, machine, mine } = homes("pictures");
    const cache = { folder: keyed, dir: join(mine, "pictures", "home-a") };
    let makings = 0;
    const maker: Maker = async ({ to }) => {
      makings++;
      writeFileSync(to, `made ${CANARY}`);
      return { made: "jpeg" };
    };
    const pictures = openPictures(cache, maker);
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(CANARY)]);
    const served = await pictures.picture(BLOB, "tile", fromBytes(jpeg, cache, () => true));
    expect(served?.kept?.read()?.toString()).toBe(`made ${CANARY}`);
    expect(canaries(mine, join(machine, "scratch"))).toEqual([]);
    const again = await pictures.picture(BLOB, "tile", fromBytes(jpeg, cache, () => true));
    expect([makings, again?.type]).toEqual([1, "image/jpeg"]);
    expect(forgetPictures(cache, BLOB)).toHaveLength(1);
    expect(filesUnder(cache.dir)).toEqual([]);
    expect(filesUnder(join(machine, "scratch")).filter((file) => /\/(picture|original)-/u.test(file))).toEqual([]);
  });

  it("pictures cache on a plain home: the made picture is renamed in beside its place, as today, and nothing is left beside it", async () => {
    const { plain } = homes("plain-pictures");
    const cache = { folder: plain, dir: join(plain.root, "pictures", "home-a") };
    const made: { at?: string; inode?: number } = {};
    const maker: Maker = async ({ to }) => {
      writeFileSync(to, "made");
      Object.assign(made, { at: to, inode: statSync(to).ino });
      return { made: "jpeg" };
    };
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const served = await openPictures(cache, maker).picture(BLOB, "tile", fromBytes(jpeg, cache, () => true));
    const kept = served!.kept!.path;
    expect(made.at?.startsWith(`${dirname(kept)}/.`)).toBe(true);
    expect([statSync(kept).ino, readFileSync(kept, "utf8")]).toEqual([made.inode, "made"]);
    expect(readdirSync(dirname(kept))).toEqual([basename(kept)]);
  });

  it("Ask's files: photos, a note's seconds and its join, the closed and erased marks are kept sealed and read back through the stage; its working copies are emptied; a photo carried into its lane is the stage's sealed file under a second name, which the store links", async () => {
    const { keyed, machine } = homes("ask");
    const stage = openStage(keyed, () => Date.parse("2026-11-17T10:00:00Z"));
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(` ${CANARY} `.repeat(4_000))]);
    const hex = createHash("sha256").update(photo).digest("hex");
    const upload = keyed.file(UPLOAD, join(keyed.root, "door", "uploads", "upload"));
    upload.write(photo);
    await stage.adopt(upload, hex);
    expect(upload.exists()).toBe(false);
    const blob = `sha256:${hex}`;
    const staged = stage.staged(blob)!;
    expect([staged.size, staged.bytes().equals(photo), staged.head(4).equals(photo.subarray(0, 4))]).toEqual([photo.length, true, true]);
    const streamed: Buffer[] = [];
    for await (const chunk of staged.stream({ start: 10, end: 5_010 })) streamed.push(chunk as Buffer);
    expect(Buffer.concat(streamed).equals(photo.subarray(10, 5_010))).toBe(true);
    const copy = await stage.materialise(blob);
    expect([copy.path.startsWith(join(machine, "scratch")), readFileSync(copy.path).equals(photo)]).toEqual([true, true]);
    copy.dispose();
    const second = Buffer.from(`${CANARY}!`.repeat(2));
    const note = "0123456789abcdef0123456789abcdef";
    expect(await stage.second(note, 0, second)).toBe("kept");
    expect(await stage.second(note, 0, second)).toBe("held");
    const joined = await stage.join(note, 1);
    expect([stage.closed(note), stage.staged(joined.audio)!.bytes().subarray(-second.length).equals(second)]).toEqual([true, true]);
    stage.erasing(["1763373600000-abcdef"]);
    expect(stage.erased("1763373600000-abcdef")).toBe(true);
    const lane = inboxLane(keyed, "ask:local:unit-a");
    const carried = await stage.carry([blob], lane, { has: () => false, materialise: async () => { throw new Error("not stored"); } });
    expect([carried.carried, carried.missing, stage.laned(blob)]).toEqual([[blob], [], true]);
    const laneFile = lane.blob(blob);
    expect(laneFile.read()?.equals(photo)).toBe(true);
    expect(readdirSync(dirname(laneFile.path))).toEqual([`${basename(laneFile.path)}.k1`]);
    expect(basename(laneFile.path)).not.toBe(hex);
    const store = keyed.blobs(join(keyed.root, "blobs"));
    expect(await store.putKept(laneFile, { expect: blob, mediaType: "image/jpeg" })).toBe(blob);
    expect(store.bytes(blob).equals(photo)).toBe(true);
    carried.undo();
    expect([laneFile.exists(), stage.laned(blob)]).toEqual([false, false]);
    expect(canaries(keyed.root, machine)).toEqual([]);
    const works = join(machine, "scratch", "home");
    expect((existsSync(works) ? readdirSync(works) : []).filter((name) => name.startsWith("ask-"))).toEqual([]);
    expect(stage.sweep({ has: (each) => each === blob })).toEqual([blob]);
    expect(stage.staged(blob)).toBeUndefined();
  });
});
