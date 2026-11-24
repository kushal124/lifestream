import { mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonical, type Delivery } from "@lifestreamprotocol/connect/sdk";
import type { Scenario } from "../../shared/dependencies.js";
import { artifact, deliver, lending, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { exampleFolderAcquirer, FILE, MANIFEST, PER_CALL } from "./acquirer.js";
import { exampleFolder } from "./reader.js";
import { files, fixture, notePath, noteText, SOURCE, UNIT } from "./test/fixture.js";

const vanishing = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  const gone = (path: unknown, syscall: string) => Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${String(path)}'`), { code: "ENOENT", errno: -2, syscall });
  const readdirSync = ((path: string, ...rest: unknown[]) => {
    if (vanishing.has(String(path))) throw gone(path, "scandir");
    return (fs.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.readdirSync;
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    if (vanishing.has(String(path))) throw gone(path, "lstat");
    return (fs.lstatSync as (...args: unknown[]) => unknown)(path, ...rest);
  }) as typeof fs.lstatSync;
  return { ...fs, default: { ...fs, readdirSync, lstatSync }, readdirSync, lstatSync };
});

const NOW = Date.parse("2026-09-15T12:00:00.000Z");
const HOUR = 3_600_000;
const N = 12;

const scenario = (items: number, more: Partial<Scenario> = {}): Scenario => ({ items, old: 0, edited: [], removed: [], start_ms: NOW, ...more });

function write(folder: string, at: Scenario): void {
  rmSync(folder, { recursive: true, force: true });
  for (const [path, value] of Object.entries(files(at))) {
    const { bytes, modified_ms } = value as { bytes: string; modified_ms: number };
    const file = join(folder, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    utimesSync(file, new Date(modified_ms), new Date(modified_ms));
  }
}

function example(folder: string, floor: number | null = null) {
  return lending(exampleFolderAcquirer({ folder, work: temp("example-folder-work-"), zone: "UTC", unit: UNIT }, { now: () => NOW }), floor);
}

const fresh = (): PollRecord => ({ state: null, deliveries: [] });

async function call(home: TestHome, acquirer: ReturnType<typeof example>, record: PollRecord): Promise<Delivery | null> {
  const delivery = await poll(home, acquirer, record, memorySecrets({}), NOW);
  if (delivery === undefined) return null;
  await home.land(exampleFolder, delivery);
  return delivery;
}

function manifest(home: TestHome, delivery: Delivery | null): { sealed: string[]; gone: string[] } {
  const file = delivery?.files.find((each) => each.path === MANIFEST);
  if (file === undefined) return { sealed: [], gone: [] };
  const stated = JSON.parse(home.blobs.text(file.blob)) as { files: { path: string }[]; gone: string[] };
  return { sealed: stated.files.map((each) => each.path), gone: stated.gone };
}

const live = (home: TestHome) => home.heads(SOURCE).filter((head) => !head.gone).map((head) => head.key);

describe("example folder: each of these is impossible", () => {
  it("a file is sealed twice unchanged, a changed one is missed or sealed twice, or a touched one seals a version", async () => {
    const home = openTestHome();
    const folder = join(temp("example-folder-"), "Notes");
    write(folder, scenario(N));
    const acquirer = example(folder);
    const record = fresh();
    expect(manifest(home, await call(home, acquirer, record)).sealed).toHaveLength(N);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(Array.from({ length: N }, (_, n) => notePath(n)));
    expect(await call(home, acquirer, record)).toBeNull();
    expect(record.changes).toEqual({ cleared: [], entries: [] });
    write(folder, scenario(N, { edited: [3] }));
    const edited = await call(home, acquirer, record);
    expect(manifest(home, edited)).toEqual({ sealed: [notePath(3)], gone: [] });
    expect(home.heads(SOURCE).find((head) => head.key === notePath(3))?.content).toMatchObject({ text: noteText(3, true) });
    expect(await call(home, acquirer, record)).toBeNull();
    const touched = join(folder, notePath(5));
    utimesSync(touched, NOW / 1000, NOW / 1000);
    expect(await call(home, acquirer, record)).toBeNull();
    expect(record.changes?.entries.map(([part, key]) => `${part} ${key}`)).toEqual([`${FILE} ${notePath(5)}`]);
    expect(await call(home, acquirer, record)).toBeNull();
    expect(record.changes).toEqual({ cleared: [], entries: [] });
    expect(record.deliveries).toHaveLength(2);
    artifact(home.dir, "heads.json", home.heads(SOURCE));
  });

  it("a removed file stays, takes another with it, or a folder away states every note gone", async () => {
    const home = openTestHome();
    const folder = join(temp("example-folder-"), "Notes");
    write(folder, scenario(N));
    const acquirer = example(folder);
    const record = fresh();
    await call(home, acquirer, record);
    write(folder, scenario(N, { removed: [4] }));
    const removal = await call(home, acquirer, record);
    expect(manifest(home, removal)).toEqual({ sealed: [], gone: [notePath(4)] });
    expect(home.heads(SOURCE).filter((head) => head.gone).map((head) => head.key)).toEqual([notePath(4)]);
    expect(live(home)).toHaveLength(N - 1);
    expect(record.memory?.get(FILE)?.has(notePath(4))).toBe(false);
    rmSync(folder, { recursive: true });
    const kept = canonical(Object.fromEntries(record.memory!.get(FILE)!) as never);
    await expect(call(home, acquirer, record)).rejects.toThrow(`the notes folder ${folder} is not there: connect its drive, or choose it again in the connector's settings`);
    expect(canonical(Object.fromEntries(record.memory!.get(FILE)!) as never)).toBe(kept);
    write(folder, scenario(N, { removed: [4] }));
    expect(await call(home, acquirer, record)).toBeNull();
    expect(live(home)).toHaveLength(N - 1);
  });

  it("a folder that empties, or goes while it is walked, states its notes gone; a folder deleted inside it does not", async () => {
    const home = openTestHome();
    const folder = join(temp("example-folder-"), "Notes");
    write(folder, scenario(N));
    writeFileSync(join(folder, "top.md"), "A note at the top.\n");
    utimesSync(join(folder, "top.md"), NOW / 1000, NOW / 1000);
    const acquirer = example(folder);
    const record = fresh();
    expect(manifest(home, await call(home, acquirer, record)).sealed).toHaveLength(N + 1);
    const kept = () => canonical(Object.fromEntries(record.memory!.get(FILE)!) as never);
    const held = kept();
    const failures: Record<string, string> = {};
    for (const [path, words] of [
      [folder, `the notes folder ${folder} is not there: connect its drive, or choose it again in the connector's settings`],
      [join(folder, "notes"), `the notes folder ${folder} changed while it was read: the next poll reads it again`],
      [join(folder, notePath(2)), `the notes folder ${folder} changed while it was read: the next poll reads it again`],
    ] as const) {
      vanishing.add(path);
      const failed = call(home, acquirer, record);
      await expect(failed, path).rejects.toThrow(words);
      failures[path] = String(await failed.catch((error: unknown) => (error as Error).message));
      vanishing.delete(path);
      expect(kept(), path).toBe(held);
    }
    rmSync(folder, { recursive: true });
    mkdirSync(folder);
    await expect(call(home, acquirer, record)).rejects.toThrow(`the notes folder ${folder} holds no note now: connect its drive if it is on one. Notes deleted from it go gone once it holds a note again`);
    expect([kept(), live(home)]).toEqual([held, [...Array.from({ length: N }, (_, n) => notePath(n)), "top.md"]]);
    writeFileSync(join(folder, "top.md"), "A note at the top.\n");
    utimesSync(join(folder, "top.md"), NOW / 1000, NOW / 1000);
    expect(manifest(home, await call(home, acquirer, record))).toEqual({ sealed: [], gone: Array.from({ length: N }, (_, n) => notePath(n)) });
    expect(live(home)).toEqual(["top.md"]);
    artifact(home.dir, "failures.json", failures);
  });

  it("the cursor grows with the folder, or a folder past one call's bound misses a file or seals one twice", async () => {
    const cursors: string[] = [];
    for (const items of [N, 4 * N]) {
      const home = openTestHome();
      const folder = join(temp("example-folder-"), "Notes");
      write(folder, scenario(items));
      const record = fresh();
      await call(home, example(folder), record);
      expect(record.memory?.get(FILE)?.size).toBe(items);
      cursors.push(canonical(record.state ?? {}));
    }
    expect(cursors).toEqual(["{}", "{}"]);
    const home = openTestHome();
    const folder = join(temp("example-folder-"), "Notes");
    const items = PER_CALL + 7;
    write(folder, scenario(items));
    const acquirer = example(folder);
    const record = fresh();
    const counts: [number, boolean][] = [];
    do counts.push([manifest(home, await call(home, acquirer, record)).sealed.length, record.next?.more === true]);
    while (record.next?.more === true);
    expect(counts).toEqual([[PER_CALL, true], [7, false]]);
    expect(home.heads(SOURCE)).toHaveLength(items);
  });

  it("an app's dot folder, a link, a file the reader does not read, or one before the start is sealed, or a file iCloud took off the Mac goes gone", async () => {
    const home = openTestHome();
    const folder = join(temp("example-folder-"), "Notes");
    write(folder, scenario(3, { old: 1 }));
    mkdirSync(join(folder, ".app"));
    writeFileSync(join(folder, ".app", "settings.md"), "an app's own");
    writeFileSync(join(folder, "picture.png"), "not a note");
    symlinkSync(join(folder, notePath(0)), join(folder, "linked.md"));
    const acquirer = example(folder, NOW - 2.5 * HOUR);
    const record = fresh();
    expect(manifest(home, await call(home, acquirer, record)).sealed).toEqual([notePath(1), notePath(2)]);
    rmSync(join(folder, notePath(1)));
    writeFileSync(join(folder, "notes", `.${"note-001.md"}.icloud`), "");
    expect(await call(home, acquirer, record)).toBeNull();
    expect(live(home)).toEqual([notePath(1), notePath(2)]);
  });

  it("a folder that is no full path, or a file, is polled", async () => {
    const home = openTestHome();
    const file = join(temp("example-folder-"), "notes.md");
    writeFileSync(file, "a file");
    await expect(call(home, example("Notes"), fresh())).rejects.toThrow(`the notes folder "Notes" is no full path: choose it in the connector's settings`);
    await expect(call(home, example(file), fresh())).rejects.toThrow(`the notes folder ${file} is a file, not a folder`);
  });

  it("a note is timed by when it arrived, a manifest's lost file lands, or a gone path is not gone", async () => {
    const home = openTestHome();
    const at = temp("example-folder-fixture-");
    const stated = fixture(at);
    const read = (path: string) => join(at, path);
    const delivery = deliver(home, stated.source, Object.fromEntries(Object.keys(stated.files).map((path) => [path, read(path)])), stated.facts);
    expect(await home.land(exampleFolder, delivery)).toMatchObject({ new: 2, refused: 0 });
    const heads = Object.fromEntries(home.heads(SOURCE).map((head) => [head.key, head.gone ? "gone" : [head.start_ms, head.end_ms]]));
    expect(heads).toEqual({
      "daily/2026-09-14.md": [Date.parse("2026-09-14T07:30:00.000Z"), Date.parse("2026-09-14T21:05:00.000Z")],
      "drafts/old-idea.md": "gone",
      "reading-list.md": [Date.parse("2026-09-15T09:00:00.000Z"), null],
    });
    const lost = deliver(home, SOURCE, { [MANIFEST]: Buffer.from(JSON.stringify({ files: [{ path: "lost.md", file: "files/9", created: "2026-09-15T09:00:00.000Z", modified: "2026-09-15T09:00:00.000Z" }], gone: ["reading-list.md"] })) }, stated.facts, NOW);
    expect(await home.land(exampleFolder, lost)).toMatchObject({ new: 0, refused: 1 });
    expect(home.heads(SOURCE).find((head) => head.key === "reading-list.md")?.gone).toBe(true);
  });
});
