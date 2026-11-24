import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openHomeFolder, VECTOR_SEGMENT, type HomeFolder } from "@lifestreamprotocol/core";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { DIM, ROW_BYTES } from "./screen-scan-wasm.js";
import {
  changeVectorModel, compactVectors, createVectorTables, landVectors, nearest, quantize, scopeOf, sweepVectorFiles, textsOf, VECTOR_FILE, vectorFileOf, vectorFiles, VectorScan,
  type VectorReply,
} from "./screen-vectors.js";

const MODEL = "embeddinggemma-2-q8-512";

function forgetUnnamed(db: Database.Database): number {
  const gone = db.prepare("DELETE FROM screen_vector WHERE NOT EXISTS (SELECT 1 FROM screen_unit u WHERE u.text_hash = screen_vector.text_hash) RETURNING model, month").all() as { model: string; month: string }[];
  for (const { model, month } of gone) db.prepare("UPDATE screen_vector_file SET named = named - 1 WHERE model = ? AND month = ?").run(model, month);
  return gone.length;
}
let scan: VectorScan;
let folder: HomeFolder;
let dir: string;
let vectors: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "screen-vectors-"));
  folder = openHomeFolder(dir);
  scan = new VectorScan(folder);
  vectors = join(dir, "screen-vectors");
  db = new Database(join(dir, "screen.db"));
  db.exec(`
    CREATE TABLE meta(name TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
    CREATE TABLE screen_unit(unit INTEGER PRIMARY KEY, kind TEXT NOT NULL, key INTEGER NOT NULL, day TEXT NOT NULL, text_hash TEXT NOT NULL, runs TEXT NOT NULL, vmonth TEXT, vrow INTEGER);
    CREATE INDEX screen_unit_hash ON screen_unit(text_hash);
    CREATE TABLE screen_embed_queue(text_hash TEXT PRIMARY KEY, day TEXT NOT NULL) WITHOUT ROWID;
    INSERT INTO meta VALUES ('generation', 'g1');
  `);
  createVectorTables(db);
  changeVectorModel(db, vectors, MODEL);
});

afterEach(async () => {
  await scan.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function unit(values: Float32Array): Float32Array {
  let sum = 0;
  for (let at = 0; at < values.length; at++) {
    const v = values[at]!;
    sum += v * v;
  }
  const inv = 1 / Math.sqrt(sum);
  const out = new Float32Array(values.length);
  for (let at = 0; at < values.length; at++) out[at] = values[at]! * inv;
  return out;
}

function vectorOf(next: () => number): Float32Array {
  const values = new Float32Array(DIM);
  let sum = 0;
  for (let at = 0; at < DIM; at++) {
    const v = next() - 0.5;
    values[at] = v;
    sum += v * v;
  }
  const inv = 1 / Math.sqrt(sum);
  for (let at = 0; at < DIM; at++) values[at] = values[at]! * inv;
  return values;
}

function queue(hash: string, day: string): void {
  db.prepare("INSERT INTO screen_unit(kind, key, day, text_hash, runs) VALUES ('block', 1, ?, ?, '[]')").run(day, hash);
  db.prepare("INSERT OR IGNORE INTO screen_embed_queue(text_hash, day) VALUES (?, ?)").run(hash, day);
}

const asked = { model: MODEL, generation: "g1" };

function stored(row: Buffer, ask: Float32Array): number {
  let sum = 0;
  for (let at = 0; at < DIM; at++) {
    const b = row[at]!;
    sum += (b > 127 ? b - 256 : b) * ask[at]!;
  }
  return sum * row.readFloatLE(DIM);
}

describe("landing a batch", () => {
  it("appends each text's row to the month of its latest unit, raises rows and takes it off the queue", () => {
    const next = random(1);
    queue("a", "2026-10-30");
    queue("a", "2026-11-02");
    queue("b", "2026-10-31");
    const replies: VectorReply[] = [{ textHash: "a", vector: vectorOf(next) }, { textHash: "b", vector: vectorOf(next) }];
    expect(landVectors(db, folder, vectors, asked, replies)).toEqual({ landed: 2, dropped: 0 });
    expect(db.prepare("SELECT month, row, text_hash FROM screen_vector ORDER BY id").all()).toEqual([
      { month: "2026-10", row: 0, text_hash: "b" }, { month: "2026-11", row: 0, text_hash: "a" },
    ]);
    expect(vectorFiles(db, vectors, MODEL).map(({ month, rows }) => ({ month, rows }))).toEqual([{ month: "2026-10", rows: 1 }, { month: "2026-11", rows: 1 }]);
    expect(statSync(vectorFileOf(vectors, MODEL, "2026-11")).size).toBe(ROW_BYTES);
    expect(db.prepare("SELECT count(*) AS n FROM screen_embed_queue").get()).toEqual({ n: 0 });
  });

  it("drops a reply asked under another generation (a rebuild came between), another model, for a text no longer queued, or named twice", () => {
    const next = random(2);
    queue("a", "2026-11-01");
    queue("b", "2026-11-01");
    const reply = (textHash: string) => ({ textHash, vector: vectorOf(next) });
    db.prepare("UPDATE meta SET value = 'g2' WHERE name = 'generation'").run();
    expect(landVectors(db, folder, vectors, asked, [reply("a")])).toEqual({ landed: 0, dropped: 1 });
    expect(landVectors(db, folder, vectors, { model: "another", generation: "g2" }, [reply("a")])).toEqual({ landed: 0, dropped: 1 });
    expect(landVectors(db, folder, vectors, { ...asked, generation: "g2" }, [reply("a"), reply("a"), reply("gone")])).toEqual({ landed: 1, dropped: 2 });
    expect(landVectors(db, folder, vectors, { ...asked, generation: "g2" }, [reply("a"), reply("b")])).toEqual({ landed: 1, dropped: 1 });
    expect(db.prepare("SELECT text_hash, row FROM screen_vector ORDER BY id").all()).toEqual([{ text_hash: "a", row: 0 }, { text_hash: "b", row: 1 }]);
    expect(existsSync(join(vectors, "another"))).toBe(false);
  });

  it("never reads bytes past rows, and the next append overwrites them", async () => {
    const next = random(3);
    queue("a", "2026-11-01");
    queue("b", "2026-11-01");
    const ask = vectorOf(next);
    landVectors(db, folder, vectors, asked, [{ textHash: "a", vector: vectorOf(next) }]);
    const path = vectorFileOf(vectors, MODEL, "2026-11");
    const inode = statSync(path).ino;
    appendFileSync(path, Buffer.concat([quantize(ask), Buffer.alloc(ROW_BYTES / 2, 1)]));
    const torn = await scan.scan(vectorFiles(db, vectors, MODEL), ask, 10);
    expect(torn.map(({ month, row }) => ({ month, row }))).toEqual([{ month: "2026-11", row: 0 }]);
    const b = vectorOf(next);
    landVectors(db, folder, vectors, asked, [{ textHash: "b", vector: b }]);
    expect([statSync(path).size, statSync(path).ino]).toEqual([2 * ROW_BYTES, inode]);
    const hits = await scan.scan(vectorFiles(db, vectors, MODEL), b, 10);
    expect(textsOf(db, MODEL, hits)[0]).toMatchObject({ textHash: "b", row: 1 });
    expect(hits[0]!.score).toBeGreaterThan(0.99);
  });
});

describe("going", () => {
  it("a model change, or meaning off, deletes every vector and its files, and a reply under the old model lands nowhere", () => {
    const next = random(4);
    queue("a", "2026-11-01");
    queue("b", "2026-11-01");
    landVectors(db, folder, vectors, asked, [{ textHash: "a", vector: vectorOf(next) }]);
    changeVectorModel(db, vectors, "another-model");
    expect(db.prepare("SELECT count(*) AS n FROM screen_vector").get()).toEqual({ n: 0 });
    expect(vectorFiles(db, vectors, MODEL)).toEqual([]);
    expect(existsSync(join(vectors, MODEL))).toBe(false);
    expect(landVectors(db, folder, vectors, asked, [{ textHash: "b", vector: vectorOf(next) }])).toEqual({ landed: 0, dropped: 1 });
    expect(landVectors(db, folder, vectors, { model: "another-model", generation: "g1" }, [{ textHash: "b", vector: vectorOf(next) }])).toEqual({ landed: 1, dropped: 0 });
    expect(existsSync(join(vectors, "another-model"))).toBe(true);
    changeVectorModel(db, vectors, null);
    expect(db.prepare("SELECT count(*) AS n FROM screen_vector_file").get()).toEqual({ n: 0 });
    expect(existsSync(join(vectors, "another-model"))).toBe(false);
    expect(db.prepare("SELECT count(*) AS n FROM meta WHERE name = 'vector_model'").get()).toEqual({ n: 0 });
  });

  it("a text let go leaves its row dead, its month's named count down by one, and a hit on it is left out when named", async () => {
    const next = random(5);
    queue("a", "2026-11-01");
    queue("b", "2026-11-01");
    const a = vectorOf(next);
    landVectors(db, folder, vectors, asked, [{ textHash: "a", vector: a }, { textHash: "b", vector: vectorOf(next) }]);
    db.prepare("DELETE FROM screen_unit WHERE text_hash = 'a'").run();
    expect(forgetUnnamed(db)).toBe(1);
    expect(db.prepare("SELECT text_hash FROM screen_vector").all()).toEqual([{ text_hash: "b" }]);
    expect(vectorFiles(db, vectors, MODEL).map(({ rows, dead }) => ({ rows, dead }))).toEqual([{ rows: 2, dead: 1 }]);
    const hits = await scan.scan(vectorFiles(db, vectors, MODEL), a, 2);
    expect(hits.map((each) => each.row)).toEqual([0, 1]);
    expect(textsOf(db, MODEL, hits).map((each) => each.textHash)).toEqual(["b"]);
  });
});

describe("a range's scope", () => {
  it("keeps the rows whose texts a unit names on the range's days, wherever their vectors are stored, and those alone", async () => {
    const next = random(12);
    queue("x", "2026-10-05");
    queue("y", "2026-10-06");
    const x = vectorOf(next);
    const y = vectorOf(next);
    landVectors(db, folder, vectors, asked, [{ textHash: "x", vector: x }, { textHash: "y", vector: y }]);
    expect(db.prepare("SELECT text_hash, vmonth, vrow FROM screen_unit ORDER BY text_hash").all()).toEqual([
      { text_hash: "x", vmonth: "2026-10", vrow: 0 }, { text_hash: "y", vmonth: "2026-10", vrow: 1 },
    ]);
    db.prepare("INSERT INTO screen_unit(kind, key, day, text_hash, runs, vmonth, vrow) VALUES ('block', 1, '2026-11-02', 'x', '[]', '2026-10', 0)").run();
    const november = scopeOf(db, vectors, MODEL, { from: "2026-11-01", to: "2026-11-30" });
    expect(november.files.map((each) => each.month)).toEqual(["2026-10"]);
    expect([...november.only![0]!]).toEqual([0b01]);
    expect((await nearest(db, scan, MODEL, november, y, 2)).map((each) => each.textHash)).toEqual(["x"]);
    expect(scopeOf(db, vectors, MODEL, { from: "2026-12-01", to: "2026-12-31" }).files).toEqual([]);
    expect(scopeOf(db, vectors, MODEL, { from: "2026-10-01", to: "2026-11-30" }).only).toBeUndefined();
  });
});

describe("dead rows", () => {
  function four(seed: number): { ask: Float32Array; landed: Record<string, Float32Array> } {
    const next = random(seed);
    const ask = vectorOf(next);
    const near = (by: number) => unit(ask.map((value) => value + (next() - 0.5) * by));
    const landed = { a: ask, b: near(0.02), c: near(0.2), d: vectorOf(next) };
    for (const hash of Object.keys(landed)) queue(hash, "2026-11-01");
    landVectors(db, folder, vectors, asked, Object.entries(landed).map(([textHash, vector]) => ({ textHash, vector })));
    return { ask, landed };
  }

  const forget = (...hashes: string[]) => {
    for (const hash of hashes) db.prepare("DELETE FROM screen_unit WHERE text_hash = ?").run(hash);
    forgetUnnamed(db);
  };

  it("an ask gets its exact k though the best rows are dead: it scans for k and every dead row of the files it reads", async () => {
    const { ask } = four(8);
    forget("a", "b");
    expect(vectorFiles(db, vectors, MODEL).map(({ rows, dead }) => ({ rows, dead }))).toEqual([{ rows: 4, dead: 2 }]);
    expect(textsOf(db, MODEL, await scan.scan(vectorFiles(db, vectors, MODEL), ask, 1))).toEqual([]);
    expect((await nearest(db, scan, MODEL, scopeOf(db, vectors, MODEL), ask, 1)).map((each) => each.textHash)).toEqual(["c"]);
  });

  it("compacts a month past a quarter dead into its next file, renumbered in order; a hit read from the old file names nothing", async () => {
    const { ask, landed } = four(9);
    forget("a");
    expect(compactVectors(db, folder, vectors, MODEL)).toEqual([]);
    const before = await scan.scan(vectorFiles(db, vectors, MODEL), ask, 4);
    forget("b");
    expect(compactVectors(db, folder, vectors, MODEL)).toEqual(["2026-11"]);
    expect(existsSync(vectorFileOf(vectors, MODEL, "2026-11"))).toBe(false);
    expect(statSync(vectorFileOf(vectors, MODEL, "2026-11", 1)).size).toBe(2 * ROW_BYTES);
    expect(vectorFiles(db, vectors, MODEL).map(({ file, rows, dead }) => ({ file, rows, dead }))).toEqual([{ file: 1, rows: 2, dead: 0 }]);
    expect(db.prepare("SELECT text_hash, row FROM screen_vector ORDER BY row").all()).toEqual([{ text_hash: "c", row: 0 }, { text_hash: "d", row: 1 }]);
    expect(textsOf(db, MODEL, before.filter((hit) => hit.row < 2))).toEqual([]);
    const after = await nearest(db, scan, MODEL, scopeOf(db, vectors, MODEL), ask, 2);
    expect(after.map((each) => each.textHash)).toEqual(["c", "d"]);
    expect(readFileSync(vectorFileOf(vectors, MODEL, "2026-11", 1))).toEqual(Buffer.concat([quantize(landed.c!), quantize(landed.d!)]));
    queue("e", "2026-11-03");
    landVectors(db, folder, vectors, asked, [{ textHash: "e", vector: ask }]);
    expect(statSync(vectorFileOf(vectors, MODEL, "2026-11", 1)).size).toBe(3 * ROW_BYTES);
    expect((await nearest(db, scan, MODEL, scopeOf(db, vectors, MODEL), ask, 1)).map((each) => each.textHash)).toEqual(["e"]);
  });

  it("on a plain home a landing makes the model's folder at today's mode, and a compaction that keeps no row leaves an empty next file", () => {
    four(11);
    expect(statSync(join(vectors, MODEL)).mode & 0o777).toBe(0o777 & ~process.umask());
    forget("a", "b", "c", "d");
    expect(compactVectors(db, folder, vectors, MODEL)).toEqual(["2026-11"]);
    expect([existsSync(vectorFileOf(vectors, MODEL, "2026-11")), statSync(vectorFileOf(vectors, MODEL, "2026-11", 1)).size]).toEqual([false, 0]);
  });

  it("sweeps every file no month reads and every other model's folder", () => {
    four(10);
    const stray = join(vectors, MODEL, "2026-11.7.q8");
    writeFileSync(stray, Buffer.alloc(ROW_BYTES));
    mkdirSync(join(vectors, "another-model"));
    sweepVectorFiles(db, folder, vectors);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(join(vectors, "another-model"))).toBe(false);
    expect(existsSync(vectorFileOf(vectors, MODEL, "2026-11"))).toBe(true);
  });
});

describe("the scan", () => {
  it("finds the same top ten as a float32 scan, across months and both workers", async () => {
    const next = random(6);
    const ask = vectorOf(next);
    const texts: { hash: string; day: string; vector: Float32Array }[] = [];
    for (let at = 0; at < 3000; at++) {
      const step = (at - 7) / 300;
      const vector = at % 300 === 7 ? unit(ask.map((value) => value + (next() - 0.5) * 0.02 * (step + 1))) : vectorOf(next);
      texts.push({ hash: `t${at}`, day: ["2026-09-03", "2026-10-14", "2026-11-25"][at % 3]!, vector });
    }
    db.transaction(() => {
      for (const text of texts) queue(text.hash, text.day);
    })();
    for (let at = 0; at < texts.length; at += 32) {
      landVectors(db, folder, vectors, asked, texts.slice(at, at + 32).map((each) => ({ textHash: each.hash, vector: each.vector })));
    }
    const exact = texts.map((each) => ({ hash: each.hash, score: each.vector.reduce((sum, value, at) => sum + value * ask[at]!, 0) }))
      .sort((a, b) => b.score - a.score).slice(0, 10);
    const hits = textsOf(db, MODEL, await scan.scan(vectorFiles(db, vectors, MODEL), ask, 10));
    expect(hits.map((each) => each.textHash)).toEqual(exact.map((each) => each.hash));
    hits.forEach((hit, at) => expect(hit.score).toBeCloseTo(exact[at]!.score, 2));
    for (const hit of hits) expect(hit.score).toBeCloseTo(stored(quantize(texts.find((each) => each.hash === hit.textHash)!.vector), ask), 4);
  });

  it("scores every row as a float32 scan of the stored rows does, over more rows than one read", async () => {
    const next = random(7);
    const ask = vectorOf(next);
    const rows = 40_000;
    const texts = Array.from({ length: rows }, (_, at) => ({ hash: `r${at}`, vector: vectorOf(next) }));
    const insert = db.transaction(() => {
      for (const text of texts) queue(text.hash, "2026-11-01");
    });
    insert();
    landVectors(db, folder, vectors, asked, texts.map((each) => ({ textHash: each.hash, vector: each.vector })));
    const exact = texts.map((each, row) => ({ row, score: stored(quantize(each.vector), ask) })).sort((a, b) => b.score - a.score).slice(0, 25);
    const hits = await scan.scan(vectorFiles(db, vectors, MODEL), ask, 25);
    expect(hits.map((each) => each.row)).toEqual(exact.map((each) => each.row));
    hits.forEach((hit, at) => expect(hit.score).toBeCloseTo(exact[at]!.score, 5));
  });
});

describe("a keyed home's vectors", () => {
  let keyed: HomeFolder;
  let sealed: VectorScan;
  beforeEach(() => {
    keyed = keyedFolder(dir);
    sealed = new VectorScan(keyed);
  });
  afterEach(() => sealed.close());

  const onDisk = () => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((each) => each.isFile()).map((each) => join(each.parentPath, each.name));
  const pieces = (path: string) => new Map(readdirSync(`${path}.k1`).filter((name) => !name.startsWith(".")).map((name) => {
    const stat = statSync(join(`${path}.k1`, name));
    return [name, { ino: stat.ino, size: stat.size }] as const;
  }));

  it("lands row by row rewriting at most one piece, holds no row's bytes on disk, and the workers read every row through their own handle", async () => {
    const next = random(13);
    const ask = vectorOf(next);
    const texts = Array.from({ length: 2400 }, (_, at) => ({ hash: `k${at}`, vector: vectorOf(next) }));
    db.transaction(() => {
      for (const text of texts) queue(text.hash, "2026-11-01");
    })();
    const path = vectorFileOf(vectors, MODEL, "2026-11");
    let most = 0;
    for (let at = 0; at < texts.length; at += 100) {
      const before = existsSync(`${path}.k1`) ? pieces(path) : new Map<string, { ino: number; size: number }>();
      landVectors(db, keyed, vectors, asked, texts.slice(at, at + 100).map((each) => ({ textHash: each.hash, vector: each.vector })));
      const rewritten = [...pieces(path)].filter(([name, now]) => before.get(name)?.ino !== now.ino);
      expect(rewritten.filter(([name]) => before.has(name)).length).toBeLessThanOrEqual(1);
      most = Math.max(most, rewritten.reduce((sum, [, now]) => sum + now.size, 0));
    }
    expect(most).toBeLessThanOrEqual(VECTOR_SEGMENT + 100 * ROW_BYTES + 56);
    expect([...pieces(path).keys()].sort()).toEqual(["0.k1", "1.k1"]);
    expect([existsSync(path), keyed.names(join(vectors, MODEL))]).toEqual([false, ["2026-11.q8"]]);
    const rows = Buffer.concat(texts.map((each) => quantize(each.vector)));
    expect(keyed.file(VECTOR_FILE, path).read()).toEqual(rows);
    const canaries = [0, 1500, 2399].map((row) => rows.subarray(row * ROW_BYTES, row * ROW_BYTES + 64));
    expect(onDisk().filter((each) => canaries.some((canary) => readFileSync(each).includes(canary)))).toEqual([]);
    const exact = texts.map((each, row) => ({ row, score: stored(quantize(each.vector), ask) })).sort((a, b) => b.score - a.score).slice(0, 25);
    const hits = await sealed.scan(vectorFiles(db, vectors, MODEL), ask, 25);
    expect(hits.map((each) => each.row)).toEqual(exact.map((each) => each.row));
  });

  it("past rows a landing ends the file where the store does, compaction and the sweep go through the handle", async () => {
    const next = random(14);
    const ask = vectorOf(next);
    const landed = { a: ask, b: vectorOf(next), c: vectorOf(next), d: vectorOf(next) };
    for (const hash of Object.keys(landed)) queue(hash, "2026-11-01");
    landVectors(db, keyed, vectors, asked, [{ textHash: "a", vector: landed.a }]);
    const path = vectorFileOf(vectors, MODEL, "2026-11");
    keyed.file(VECTOR_FILE, path).append(Buffer.concat([quantize(vectorOf(next)), Buffer.alloc(ROW_BYTES / 2, 1)]));
    expect((await sealed.scan(vectorFiles(db, vectors, MODEL), ask, 10)).map(({ row }) => row)).toEqual([0]);
    landVectors(db, keyed, vectors, asked, (["b", "c", "d"] as const).map((textHash) => ({ textHash, vector: landed[textHash] })));
    expect(keyed.file(VECTOR_FILE, path).read()).toEqual(Buffer.concat([landed.a, landed.b, landed.c, landed.d].map(quantize)));
    for (const hash of ["a", "b"]) db.prepare("DELETE FROM screen_unit WHERE text_hash = ?").run(hash);
    forgetUnnamed(db);
    expect(compactVectors(db, keyed, vectors, MODEL)).toEqual(["2026-11"]);
    const compacted = vectorFileOf(vectors, MODEL, "2026-11", 1);
    expect([existsSync(`${path}.k1`), keyed.file(VECTOR_FILE, compacted).read()]).toEqual([false, Buffer.concat([quantize(landed.c), quantize(landed.d)])]);
    expect((await nearest(db, sealed, MODEL, scopeOf(db, vectors, MODEL), landed.c, 1)).map((each) => each.textHash)).toEqual(["c"]);
    const stray = vectorFileOf(vectors, MODEL, "2026-11", 7);
    keyed.file(VECTOR_FILE, stray).append(Buffer.alloc(ROW_BYTES));
    mkdirSync(join(vectors, "another-model"));
    sweepVectorFiles(db, keyed, vectors);
    expect([existsSync(`${stray}.k1`), existsSync(join(vectors, "another-model")), keyed.names(join(vectors, MODEL))]).toEqual([false, false, ["2026-11.1.q8"]]);
  });
});
