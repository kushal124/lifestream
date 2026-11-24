import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { MARKS_STORE, openMarks, passagesOf, type DetectorModel } from "./index.js";
import { PASSAGE_LIMIT } from "./passages.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-privacy-marks-"));
const artifact: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "privacy-marks.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

const texts = (text: string) => passagesOf(text).map((passage) => text.slice(passage.start, passage.end));

describe("passages", () => {
  it("are paragraphs, blank lines between them in none", () => {
    const text = "First line\nsecond line\n\n  \nThird paragraph\n\n";
    artifact.paragraphs = texts(text);
    expect(texts(text)).toEqual(["First line\nsecond line", "Third paragraph"]);
  });

  it("move only their own when a line is added", () => {
    const before = texts("One.\n\nTwo two.\n\nThree.");
    const after = texts("One.\n\nTwo two.\nAdded.\n\nThree.");
    expect(after.filter((passage) => before.includes(passage))).toEqual(["One.", "Three."]);
  });

  it("cut a long paragraph at the last space within each 1,000 characters, or at each 1,000 where none is", () => {
    const words = Array.from({ length: 280 }, (_, index) => `w${String(index).padStart(7, "0")}`).join(" ").slice(0, 2_500);
    const spaced = passagesOf(words);
    artifact.spaced = spaced;
    expect(spaced).toHaveLength(3);
    expect(spaced.every((passage) => passage.end - passage.start <= PASSAGE_LIMIT && (words[passage.end] === " " || passage.end === words.length))).toBe(true);
    expect(spaced[0]).toEqual({ start: 0, end: 998 });
    const solid = "x".repeat(2_500);
    expect(passagesOf(solid)).toEqual([{ start: 0, end: 1_000 }, { start: 1_000, end: 2_000 }, { start: 2_000, end: 2_500 }]);
  });

  it("cut a list of links at a line's end, each cut counted from the last", () => {
    const links = Array.from({ length: 60 }, (_, index) => `https://example.com/a/very/long/path/to/page-${String(index).padStart(4, "0")}?ref=list`).join("\n");
    const cut = texts(links);
    artifact.links = cut;
    expect(cut.length).toBeGreaterThan(2);
    expect(cut.every((passage) => passage.length <= PASSAGE_LIMIT && passage.split("\n").every((line) => /^https:\/\/example\.com\/.*\?ref=list$/u.test(line)))).toBe(true);
    expect(cut.join("\n")).toBe(links);
  });
});

describe("the marks store", () => {
  const model: DetectorModel = { id: "privacy-filter", file: "sha256:aa", decode: "1" };

  it("keeps marks under four parts: another model, file or decode reads them as another's", async () => {
    const path = join(dir, "key", "marks.db");
    const store = openMarks(openHomeFolder(dirname(path)), path);
    store.write(model, new Map([["sha256:p1", [{ start: 0, end: 3, type: "person" }]], ["sha256:p2", []]]), store.epoch);
    expect(store.read(["sha256:p1", "sha256:p2", "sha256:p3"], model)).toEqual(new Map([
      ["sha256:p1", { marks: [{ start: 0, end: 3, type: "person" }], current: true }],
      ["sha256:p2", { marks: [], current: true }],
    ]));
    for (const other of [{ ...model, id: "privacy-filter-2" }, { ...model, file: "sha256:bb" }, { ...model, decode: "2" }]) {
      expect(store.read(["sha256:p1"], other).get("sha256:p1")).toEqual({ marks: [{ start: 0, end: 3, type: "person" }], current: false });
    }
    const next = { ...model, decode: "2" };
    store.write(next, new Map([["sha256:p1", [{ start: 0, end: 3, type: "email" }]]]), store.epoch);
    expect(store.read(["sha256:p1"], model).get("sha256:p1")).toEqual({ marks: [{ start: 0, end: 3, type: "person" }], current: true });
    expect(store.read(["sha256:p1"], { ...model, decode: "3" }).get("sha256:p1")).toEqual({ marks: [{ start: 0, end: 3, type: "email" }], current: false });
    store.close();
    const again = openMarks(openHomeFolder(dirname(path)), path);
    expect(await again.dropOthers(next)).toBe(2);
    expect(again.read(["sha256:p1", "sha256:p2"], next)).toEqual(new Map([["sha256:p1", { marks: [{ start: 0, end: 3, type: "email" }], current: true }]]));
    expect(again.forget(["sha256:p1", "sha256:p9"])).toBe(1);
    expect(again.read(["sha256:p1"], next).size).toBe(0);
    again.close();
  });

  it("keeps nothing a write was handed an epoch from before a forget, in this process or another, or from before the file started afresh", () => {
    const path = join(dir, "epoch", "marks.db");
    const home = openMarks(openHomeFolder(dirname(path)), path);
    const door = openMarks(openHomeFolder(dirname(path)), path);
    const placed = door.epoch;
    home.write(model, new Map([["sha256:p1", []]]), home.epoch);
    expect(home.forget(["sha256:p1"])).toBe(1);
    expect(door.epoch).not.toBe(placed);
    expect(door.write(model, new Map([["sha256:p1", [{ start: 0, end: 3, type: "person" }]]]), placed)).toBe(false);
    expect(home.read(["sha256:p1"], model).size).toBe(0);
    expect(door.write(model, new Map([["sha256:p2", []]]), door.epoch)).toBe(true);
    expect(home.read(["sha256:p2"], model).size).toBe(1);
    const before = home.epoch;
    home.close();
    door.close();
    rmSync(path);
    const fresh = openMarks(openHomeFolder(dirname(path)), path);
    expect(fresh.write(model, new Map([["sha256:p3", []]]), before)).toBe(false);
    expect(fresh.read(["sha256:p3"], model).size).toBe(0);
    fresh.close();
  });

  it("answers false to a write that finds the write lock held, keeping nothing, and drops another model's rows a chunk at a time, a write landing between", async () => {
    const path = join(dir, "busy", "marks.db");
    const home = openMarks(openHomeFolder(dirname(path)), path);
    const door = openMarks(openHomeFolder(dirname(path)), path);
    const held = openHomeFolder(dirname(path)).store(MARKS_STORE, path);
    held.exec("BEGIN IMMEDIATE");
    expect(door.write(model, new Map([["sha256:p1", []]]), door.epoch)).toBe(false);
    expect(door.read(["sha256:p1"], model).size).toBe(0);
    held.exec("ROLLBACK");
    held.close();
    expect(door.write(model, new Map([["sha256:p1", []]]), door.epoch)).toBe(true);
    const old = { ...model, decode: "0" };
    const olds = Array.from({ length: 2_500 }, (_, index) => `sha256:o${index}`);
    expect(home.write(old, new Map(olds.map((digest) => [digest, []])), home.epoch)).toBe(true);
    let between: { left: number; wrote: boolean } | undefined;
    const dropping = home.dropOthers(model);
    setImmediate(() => {
      between = { left: door.read(olds, model).size, wrote: door.write(model, new Map([["sha256:p2", []]]), door.epoch) };
    });
    expect(await dropping).toBe(2_500);
    artifact.busy = between;
    expect(between!.left).toBeGreaterThan(0);
    expect(between!.left).toBeLessThan(2_500);
    expect(between!.wrote).toBe(true);
    expect(door.read([...olds, "sha256:p1", "sha256:p2"], model)).toEqual(new Map([["sha256:p1", { marks: [], current: true }], ["sha256:p2", { marks: [], current: true }]]));
    home.close();
    door.close();
  });

  it("keeps one id while it keeps its marks", () => {
    const path = join(dir, "id", "marks.db");
    const store = openMarks(openHomeFolder(dirname(path)), path);
    const { id } = store;
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    store.close();
    const again = openMarks(openHomeFolder(dirname(path)), path);
    expect(again.id).toBe(id);
    again.close();
    rmSync(path);
    const lost = openMarks(openHomeFolder(dirname(path)), path);
    expect(lost.id).not.toBe(id);
    lost.close();
  });

  it("starts empty under a new id over a damaged file and over a file of another schema", () => {
    const damaged = join(dir, "damaged", "marks.db");
    mkdirSync(join(dir, "damaged"));
    writeFileSync(damaged, "not a database, only bytes ".repeat(200));
    const store = openMarks(openHomeFolder(dirname(damaged)), damaged);
    expect(store.read(["sha256:p1"], model).size).toBe(0);
    store.write(model, new Map([["sha256:p1", []]]), store.epoch);
    store.close();
    const other = join(dir, "other", "marks.db");
    mkdirSync(join(dir, "other"));
    const db = openHomeFolder(dirname(other)).store(MARKS_STORE, other);
    db.exec("CREATE TABLE marks (digest TEXT, held TEXT)");
    db.exec("INSERT INTO marks VALUES ('sha256:p1', 'x')");
    db.pragma("user_version = 7");
    db.close();
    const fresh = openMarks(openHomeFolder(dirname(other)), other);
    expect(fresh.read(["sha256:p1"], model).size).toBe(0);
    fresh.close();
  });

  it("starts empty under a new id when a read finds the file damaged after it opened", () => {
    const path = join(dir, "read", "marks.db");
    const store = openMarks(openHomeFolder(dirname(path)), path);
    const before = store.id;
    store.write(model, new Map(Array.from({ length: 200 }, (_, index) => [`sha256:p${index}`, [{ start: 0, end: 3, type: "person" as const }]])), store.epoch);
    store.close();
    const db = openHomeFolder(dirname(path)).store(MARKS_STORE, path);
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const pages = (db.prepare("SELECT rootpage FROM sqlite_master WHERE tbl_name = 'marks'").all() as { rootpage: number }[]).map((row) => row.rootpage);
    db.close();
    const bytes = readFileSync(path);
    for (const page of pages) bytes.fill(0xff, (page - 1) * pageSize, page * pageSize);
    writeFileSync(path, bytes);
    const damaged = openMarks(openHomeFolder(dirname(path)), path);
    expect(damaged.id).toBe(before);
    expect(damaged.read(["sha256:p1"], model).size).toBe(0);
    expect(damaged.id).not.toBe(before);
    damaged.write(model, new Map([["sha256:p1", []]]), damaged.epoch);
    expect(damaged.read(["sha256:p1"], model).get("sha256:p1")).toEqual({ marks: [], current: true });
    damaged.close();
  });

  it("moves a second process onto the file the first started afresh: its reads and writes land there, under its new id", () => {
    const path = join(dir, "two", "marks.db");
    const seeded = openMarks(openHomeFolder(dirname(path)), path);
    const before = seeded.id;
    seeded.write(model, new Map(Array.from({ length: 200 }, (_, index) => [`sha256:p${index}`, [{ start: 0, end: 3, type: "person" as const }]])), seeded.epoch);
    seeded.close();
    const db = openHomeFolder(dirname(path)).store(MARKS_STORE, path);
    const pageSize = db.pragma("page_size", { simple: true }) as number;
    const pages = (db.prepare("SELECT rootpage FROM sqlite_master WHERE tbl_name = 'marks'").all() as { rootpage: number }[]).map((row) => row.rootpage);
    db.close();
    const bytes = readFileSync(path);
    for (const page of pages) bytes.fill(0xff, (page - 1) * pageSize, page * pageSize);
    writeFileSync(path, bytes);
    const door = openMarks(openHomeFolder(dirname(path)), path);
    const home = openMarks(openHomeFolder(dirname(path)), path);
    expect(door.id).toBe(before);
    expect(home.id).toBe(before);
    expect(door.read(["sha256:p1"], model).size).toBe(0);
    expect(door.id).not.toBe(before);
    expect(home.id).toBe(door.id);
    home.write(model, new Map([["sha256:p1", [{ start: 0, end: 3, type: "email" }]]]), home.epoch);
    expect(door.read(["sha256:p1"], model).get("sha256:p1")).toEqual({ marks: [{ start: 0, end: 3, type: "email" }], current: true });
    door.write(model, new Map([["sha256:p2", []]]), door.epoch);
    expect(home.read(["sha256:p2"], model).get("sha256:p2")).toEqual({ marks: [], current: true });
    expect(home.id).toBe(door.id);
    door.close();
    home.close();
  });
});
