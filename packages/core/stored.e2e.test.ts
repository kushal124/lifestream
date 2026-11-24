import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
  BLOCKS, FILES_END, GONE, openHome, openHomeFolder, SLAB_REFERENCES, STORED_MARK, type DaySettings, type FileSlab, type Guard, type Holding, type HomeDb, type Json, type Leaves, type OwnerMap, type ReaderOutput,
  type RepairSpec, type StoredFilling, type StoredMark, type TextSlab,
} from "./index.js";
import { OWNER_MAP } from "./stored.js";

const HOUR = 3_600_000;
const START = Date.UTC(2026, 10, 2, 12);
const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"]);
const GUARDS = { msg: object, note: object };
const A = "whatsapp:+15550000001:mac-aa01";
const A2 = "whatsapp:+15550000001:mac-aa02";
const B = "gmail:person-a@example.com:cloud";
const SOURCES = [A, A2, B];
const KINDS = ["msg", "note"];
const FILL_DAY = "2026-01-01";
const file = (n: number): string => `sha256:${createHash("sha256").update(`synthetic file ${n}`).digest("hex")}`;
const POOL = Array.from({ length: 10 }, (_, at) => file(at + 1));

function random(seed: number): { next(): number; int(below: number): number; pick<T>(of: readonly T[]): T } {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return { next, int: (below) => Math.floor(next() * below), pick: (of) => of[Math.floor(next() * of.length)]! };
}

interface FileCount {
  source: string;
  version: number;
  bytes: number;
}

interface Truth {
  text: Record<string, number>;
  whole: Record<string, number>;
  files: Map<string, FileCount>;
  versions: { rowid: number; owner: string; bytes: number }[];
}

interface Counted {
  text: Record<string, number>;
  files: Record<string, number>;
  rows: Map<string, FileCount>;
  days: string[];
}

function countedBy(mark: StoredMark): (rowid: number) => boolean {
  if ("complete" in mark) return () => true;
  const done: [number, number][] = [];
  for (let step = 0; step < mark.blocks; step++) {
    const block = Number.parseInt(step.toString(2).padStart(10, "0").split("").reverse().join(""), 2);
    done.push([Math.ceil((block * mark.M) / 1024), Math.ceil(((block + 1) * mark.M) / 1024)]);
  }
  return (rowid) => rowid > mark.M || done.some(([after, through]) => rowid > after && rowid <= through);
}

const add = (sums: Record<string, number>, source: string, bytes: number) => {
  sums[source] = (sums[source] ?? 0) + bytes;
};
const nonzero = (sums: Record<string, number>) => Object.fromEntries(Object.entries(sums).filter(([, bytes]) => bytes !== 0).sort());

class Scratch {
  readonly dir = mkdtempSync(join(tmpdir(), "core-stored-"));
  readonly path = join(this.dir, "home.db");
  readonly held = new Map<string, number>();
  readonly #byPrefix = new Map<string, Set<string>>();
  readonly written = new Map<string, number>();
  readonly store: Holding = { has: (blob) => this.held.has(blob), stored: (blob) => this.held.get(blob) };
  readonly leaves: Leaves = {
    leaves: () => (prefix) => {
      const bucket = this.#byPrefix.get(prefix);
      if (bucket === undefined || bucket.size === 0) return [];
      return [...bucket]
        .sort()
        .map((blob) => ({ blob, bytes: this.held.get(blob)!, mtime_ms: this.written.get(blob)! }));
    },
  };
  now = START;
  stated = START;
  readonly days = new Set<string>([FILL_DAY]);
  readonly db: HomeDb;
  readonly raw: Database.Database;
  readonly log: unknown[] = [];

  constructor(readonly day: DaySettings = { zone: "UTC", day_start_hour: 0 }) {
    this.db = openHome(openHomeFolder(dirname(this.path)), "migrate", { clock: () => this.now, day: () => this.day });
    this.raw = new Database(this.path);
    this.later(0);
  }

  #reader: HomeDb | undefined;
  get reader(): HomeDb {
    return (this.#reader ??= openHome(openHomeFolder(dirname(this.path)), "read"));
  }

  close(): void {
    this.#reader?.close();
    writeFileSync(join(this.dir, "stored.json"), `${JSON.stringify({ steps: this.log, truth: this.truth().versions }, null, 2)}\n`);
    this.raw.close();
    this.db.close();
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(this.dir, { recursive: true, force: true });
  }

  mark(): StoredMark {
    return JSON.parse(this.raw.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(STORED_MARK) as string) as StoredMark;
  }

  land(source: string, rows: ReaderOutput[], options: { stated_ms?: number; slices?: number; ended?: boolean } = {}): void {
    const stated_ms = options.stated_ms ?? (this.stated += 1_000);
    const delivery = { id: `${source}@${stated_ms}`, source, stated_ms };
    const run = this.db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} ${delivery.id}`, started_ms: this.now }));
    const size = Math.ceil(rows.length / (options.slices ?? 1));
    for (let at = 0; at < rows.length; at += size) this.db.commit((tx) => tx.records.land(run, delivery, rows.slice(at, at + size), GUARDS, this.store));
    if (options.ended !== false) this.db.commit((tx) => tx.tables.runs.end(run, { ended_ms: this.now, outcome: "ok" }));
  }

  repair(source: string, fix: RepairSpec["fix"]): void {
    const view = this.db.view();
    const plan = (() => {
      try {
        return view.planRepair({ source, fix });
      } finally {
        view.close();
      }
    })();
    this.db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: this.now }), plan, this.store));
  }

  arrive(blobs: string[], bytes = 1_000): void {
    this.put(blobs, bytes);
    this.db.commit((tx) => tx.records.blobsArrived(blobs, this.store));
  }

  put(blobs: string[], bytes = 1_000): void {
    for (const blob of blobs) {
      this.held.set(blob, bytes + blob.charCodeAt(70));
      this.written.set(blob, this.now);
      if (blob.startsWith("sha256:")) {
        const prefix = blob.slice(7, 11);
        let bucket = this.#byPrefix.get(prefix);
        if (bucket === undefined) {
          bucket = new Set();
          this.#byPrefix.set(prefix, bucket);
        }
        bucket.add(blob);
      }
    }
  }

  erase(records: { source: string; kind: string; key: string }[]): void {
    const erased = this.db.commit((tx) => tx.records.erase({ records, reason: "the owner's", at_ms: this.now }));
    for (const blob of erased.blobs) {
      this.held.delete(blob);
      if (blob.startsWith("sha256:")) this.#byPrefix.get(blob.slice(7, 11))?.delete(blob);
    }
  }

  forget(source: string, kind: string): void {
    const forgotten = this.db.commit((tx) => tx.records.forget({ sources: [{ source, kinds: [kind] }] }));
    for (const blob of forgotten.blobs) {
      this.held.delete(blob);
      if (blob.startsWith("sha256:")) this.#byPrefix.get(blob.slice(7, 11))?.delete(blob);
    }
  }

  later(ms: number): void {
    this.now += ms;
    this.days.add(new Date(this.now - this.day.day_start_hour * HOUR).toISOString().slice(0, 10));
  }

  truth(mark: StoredMark = this.mark()): Truth {
    const counted = countedBy(mark);
    const versions = this.raw.prepare(
      "SELECT v.rowid AS rowid, v.id AS id, octet_length(v.text) AS bytes, (SELECT s.source FROM statements s WHERE s.version = v.id ORDER BY s.seq LIMIT 1) AS owner FROM versions v",
    ).all() as { rowid: number; id: string; bytes: number; owner: string }[];
    const byId = new Map(versions.map((version) => [version.id, version]));
    const text: Record<string, number> = {};
    const whole: Record<string, number> = {};
    for (const version of versions) {
      add(whole, version.owner, version.bytes);
      if (counted(version.rowid)) add(text, version.owner, version.bytes);
    }
    const files = new Map<string, FileCount>();
    for (const { blob, version } of this.raw.prepare("SELECT blob, version FROM version_blobs").all() as { blob: string; version: string }[]) {
      const bytes = this.held.get(blob);
      const naming = byId.get(version)!;
      if (bytes === undefined) continue;
      const known = files.get(blob);
      if (known === undefined || naming.rowid < known.version) files.set(blob, { source: naming.owner, version: naming.rowid, bytes });
    }
    return { text, whole, files, versions: versions.map(({ rowid, owner, bytes }) => ({ rowid, owner, bytes })) };
  }

  counted(): Counted {
    const text: Record<string, number> = {};
    const files: Record<string, number> = {};
    for (const row of this.raw.prepare("SELECT source, sum(text) AS text, sum(files) AS files FROM stored_days GROUP BY source").all() as { source: string; text: number; files: number }[]) {
      text[row.source] = row.text;
      files[row.source] = row.files;
    }
    const rows = new Map((this.raw.prepare("SELECT blob, source, version, bytes FROM stored_files").all() as (FileCount & { blob: string })[]).map(({ blob, ...row }) => [blob, row]));
    const days = this.raw.prepare("SELECT DISTINCT day FROM stored_days ORDER BY day").pluck().all() as string[];
    return { text, files, rows, days };
  }

  check(step: string): void {
    const mark = this.mark();
    const truth = this.truth(mark);
    const counted = this.counted();
    expect(nonzero(counted.text), `${step}: text by source`).toEqual(nonzero(truth.text));
    const rowsBySource: Record<string, number> = {};
    for (const [blob, row] of counted.rows) {
      expect(row, `${step}: the file ${blob}`).toEqual(truth.files.get(blob));
      add(rowsBySource, row.source, row.bytes);
    }
    expect(nonzero(counted.files), `${step}: files by source`).toEqual(nonzero(rowsBySource));
    const M = "complete" in mark ? 0 : mark.M;
    for (const [blob, count] of truth.files) if (count.version > M) expect(counted.rows.has(blob), `${step}: the file ${blob} named above M`).toBe(true);
    for (const day of counted.days) expect(this.days.has(day), `${step}: the day ${day}`).toBe(true);
  }

  checkWhole(step: string): void {
    expect("complete" in this.mark(), step).toBe(true);
    const truth = this.truth();
    const counted = this.counted();
    expect(nonzero(counted.text), `${step}: text by source`).toEqual(nonzero(truth.whole));
    expect([...counted.rows.keys()].sort(), `${step}: the files counted`).toEqual([...truth.files.keys()].sort());
    this.check(step);
  }

  upgrade(blocks: number, share: (blob: string) => boolean): void {
    const M = this.raw.prepare("SELECT coalesce(max(rowid), 0) FROM versions").pluck().get() as number;
    const mark: StoredMark = M === 0 ? { complete: "checkout" } : { M, blocks, after: null, erasures: 0, slab_ms: 0 };
    this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM stored_days").run();
      this.raw.prepare("DELETE FROM stored_files").run();
      this.#counts(this.truth(mark).text, {}, [...this.truth(mark).files].filter(([blob]) => share(blob)));
      this.raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(mark), STORED_MARK);
    })();
  }

  finish(): void {
    const mark = this.mark();
    if ("complete" in mark) return;
    const counted = countedBy(mark);
    const text: Record<string, number> = {};
    for (const version of this.truth(mark).versions) if (!counted(version.rowid)) add(text, version.owner, version.bytes);
    const rows = this.counted().rows;
    this.raw.transaction(() => {
      this.#counts(text, {}, [...this.truth(mark).files].filter(([blob]) => !rows.has(blob)));
      this.raw.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify({ complete: "checkout" }), STORED_MARK);
    })();
  }

  #counts(text: Record<string, number>, files: Record<string, number>, rows: [string, FileCount][]): void {
    for (const [blob, row] of rows) {
      this.raw.prepare("INSERT INTO stored_files (blob, source, version, bytes) VALUES (?, ?, ?, ?)").run(blob, row.source, row.version, row.bytes);
      add(files, row.source, row.bytes);
    }
    for (const source of new Set([...Object.keys(text), ...Object.keys(files)])) {
      this.raw.prepare(`INSERT INTO stored_days (day, source, text, files) VALUES (?, ?, ?, ?)
        ON CONFLICT (day, source) DO UPDATE SET text = text + excluded.text, files = files + excluded.files`).run(FILL_DAY, source, text[source] ?? 0, files[source] ?? 0);
    }
  }
}

type Read = { text: TextSlab } | { files: FileSlab };

function onView<T>(home: Scratch, read: (view: ReturnType<HomeDb["view"]>) => T): T {
  const view = home.reader.view();
  try {
    return read(view);
  } finally {
    view.close();
  }
}

function wholeMap(view: ReturnType<HomeDb["view"]>, home: Scratch, round?: number): OwnerMap {
  const map = view.stored.ownerMap({ settings: home.day, now_ms: home.now }, round)!;
  expect(view.stored.mapBatch(map, Number.POSITIVE_INFINITY)).toBe(true);
  return map;
}

class Fill {
  map: OwnerMap | null = null;
  built = 0;
  widest = 0;
  batches = 0;
  stale = 0;
  #files = true;

  constructor(
    readonly home: Scratch,
    readonly options: { round?: number | undefined; seqs?: number | undefined; between?: (() => void) | undefined } = {},
  ) {}

  read(): Read | null {
    let turned = false;
    let refused = false;
    let mapping = false;
    for (;;) {
      if (mapping) this.options.between?.();
      mapping = false;
      const view = this.home.reader.view();
      try {
        const mark = view.stored.mark();
        if ("complete" in mark) return null;
        const texts = mark.blocks < BLOCKS;
        const files = mark.after !== FILES_END;
        if (!texts && !files) return null;
        if (!turned) this.#files = texts && files ? !this.#files : files;
        turned = true;
        if (this.map === null || this.map.erasures !== mark.erasures || (!this.#files && !this.map.covers(mark.blocks))) {
          this.map = view.stored.ownerMap({ settings: this.home.day, now_ms: this.home.now }, this.options.round)!;
          this.built++;
          this.widest = Math.max(this.widest, this.map.owner.length);
        }
        if (!this.map.whole) {
          const whole = view.stored.mapBatch(this.map, this.options.seqs);
          if (whole === null) {
            this.stale++;
            this.map = null;
            continue;
          }
          this.batches++;
          if (!whole) {
            mapping = true;
            continue;
          }
        }
        const read: Read | null = this.#files
          ? ((slab) => (slab === null ? null : { files: slab }))(view.stored.files(this.map, this.home.leaves, mark))
          : ((slab) => (slab === null ? null : { text: slab }))(view.stored.text(this.map, mark.blocks));
        if (read !== null) return read;
        if (refused) throw new Error("a map made whole on this snapshot is stale on it");
        refused = true;
        this.map = null;
      } finally {
        view.close();
      }
    }
  }

  commit(read: Read): boolean {
    return this.home.db.commit((tx) => ("text" in read ? tx.stored.countText(read.text) : tx.stored.countFiles(read.files)));
  }

  complete(own: number): boolean {
    return this.home.db.commit((tx) => tx.stored.complete(own));
  }

  finish(own = 1_000_000): void {
    for (let read = this.read(); read !== null; read = this.read()) expect(this.commit(read)).toBe(true);
    expect(this.complete(own)).toBe(true);
  }
}

function step(home: Scratch, rng: ReturnType<typeof random>): string {
  home.later(rng.int(8) * HOUR);
  const blobs = () => [...new Set(Array.from({ length: rng.int(3) }, () => rng.pick(POOL)))];
  const content = (): Json => (rng.next() < 0.1 ? { v: rng.int(3), long: "x".repeat(5_000 + rng.int(3)) } : { v: rng.int(3) });
  const row = (): ReaderOutput => {
    const kind = rng.pick(KINDS);
    const key = `k${rng.int(5)}`;
    return rng.next() < 0.1 ? { kind, key, content: null, gone: true } : { kind, key, content: content(), blobs: blobs() };
  };
  const heads = () => home.raw.prepare("SELECT source, kind, key FROM heads ORDER BY source, kind, key").all() as { source: string; kind: string; key: string }[];
  const roll = rng.next();
  if (roll < 0.45) {
    const source = rng.pick(SOURCES);
    const rows = Array.from({ length: 1 + rng.int(4) }, row);
    const late = rng.next() < 0.15;
    home.land(source, rows, { slices: 1 + rng.int(2), ...(late ? { stated_ms: home.stated - rng.int(5_000) } : {}) });
    return `land ${source}${late ? " late" : ""} ${JSON.stringify(rows.map((each) => [each.kind, each.key, each.gone === true ? GONE : each.content, each.blobs]))}`;
  }
  if (roll < 0.55) {
    const source = rng.pick(SOURCES);
    home.repair(source, () => {
      const choice = rng.next();
      return choice < 0.4 ? "keep" : choice < 0.5 ? GONE : choice < 0.75 ? { content: { v: rng.int(4) } } : { content: { v: rng.int(4) }, blobs: blobs() };
    });
    return `repair ${source}`;
  }
  if (roll < 0.72) {
    const absent = POOL.filter((blob) => !home.held.has(blob));
    if (absent.length === 0) return "arrive nothing";
    const arriving = [rng.pick(absent)];
    home.arrive(arriving);
    return `arrive ${arriving.join(" ")}`;
  }
  const all = heads();
  if (all.length === 0) return "nothing to erase";
  const head = rng.pick(all);
  if (roll < 0.86) {
    home.erase([head]);
    return `erase ${head.source} ${head.kind} ${head.key}`;
  }
  home.forget(head.source, head.kind);
  return `forget ${head.source} ${head.kind}`;
}

describe("Storage's live count", () => {
  const homes: Scratch[] = [];
  afterAll(() => {
    for (const home of homes) home.close();
  });
  const scratch = (day?: DaySettings): Scratch => {
    const home = new Scratch(day);
    homes.push(home);
    return home;
  };

  it("any write leaves the count off the recount on a home counted from its first commit", () => {
    for (const seed of [1, 2, 3]) {
      const home = scratch();
      const rng = random(seed);
      expect(home.mark()).toEqual({ complete: "checkout" });
      for (let at = 0; at < 250; at++) {
        const did = step(home, rng);
        home.log.push(did);
        home.checkWhole(`seed ${seed} step ${at}: ${did}`);
      }
    }
  });

  it("a version is counted twice or by neither on a home upgraded mid-history, or the fill's erasures stand still", () => {
    for (const seed of [11, 12, 13, 14]) {
      const home = scratch();
      const rng = random(seed);
      for (let at = 0; at < 60; at++) home.log.push(step(home, rng));
      const blocks = [0, 1, 300, 700, 1023][seed % 5]!;
      home.upgrade(blocks, (blob) => blob.charCodeAt(blob.length - 1) % 2 === 0);
      home.log.push(`upgrade at ${JSON.stringify(home.mark())}`);
      home.check(`seed ${seed} upgraded`);
      let erasures = 0;
      for (let at = 0; at < 250; at++) {
        const did = step(home, rng);
        home.log.push(did);
        if (/^(erase|forget) /u.test(did)) erasures++;
        home.check(`seed ${seed} step ${at}: ${did}`);
      }
      expect(home.mark()).toMatchObject({ erasures });
      home.finish();
      home.checkWhole(`seed ${seed} the fill's end`);
    }
  });

  it("a version's owner is not the next source once its first is erased, or a replica's once the first copy's kind is forgotten", () => {
    const home = scratch();
    const v = { kind: "msg", key: "shared", content: { text: "synthetic" } };
    home.arrive([file(1)]);
    home.land(A, [{ ...v, blobs: [file(1)] }]);
    home.land(B, [v]);
    home.check("A first, then B");
    expect(home.counted().rows.get(file(1))).toMatchObject({ source: A });
    home.erase([{ source: A, kind: "msg", key: "shared" }]);
    home.check("A's statement erased");
    expect(home.counted().rows.get(file(1))).toMatchObject({ source: B });
    expect(nonzero(home.counted().text)).toEqual({ [B]: home.truth().whole[B] });

    const w = { kind: "note", key: "copied", content: { text: "synthetic note" } };
    home.land(A2, [{ ...w, blobs: [file(2)] }]);
    home.land(A, [w]);
    home.arrive([file(2)]);
    expect(home.counted().rows.get(file(2))).toMatchObject({ source: A2 });
    home.forget(A2, "note");
    home.check("the first copy's kind forgotten");
    expect(home.counted().rows.get(file(2))).toMatchObject({ source: A });
    home.forget(A, "note");
    home.check("the other copy's kind forgotten");
    expect(home.counted().rows.has(file(2))).toBe(false);
    expect(home.held.has(file(2))).toBe(false);
  });

  it("a link added to an older version, by a land or by a repair, leaves the file with the newer version's owner", () => {
    const home = scratch();
    home.arrive([file(3), file(4)]);
    expect(home.counted().rows.size).toBe(0);
    const older = { kind: "msg", key: "m", content: { v: 1 } };
    home.land(A, [older]);
    home.land(B, [{ kind: "msg", key: "n", content: { v: 2 }, blobs: [file(3)] }]);
    expect(home.counted().rows.get(file(3))).toMatchObject({ source: B, version: 2 });
    home.land(A, [{ ...older, blobs: [file(3)] }]);
    home.check("a land links the older version");
    expect(home.counted().rows.get(file(3))).toMatchObject({ source: A, version: 1 });
    home.land(B, [{ kind: "msg", key: "o", content: { v: 3 } }]);
    home.land(A2, [{ kind: "msg", key: "p", content: { v: 4 }, blobs: [file(4)] }]);
    expect(home.counted().rows.get(file(4))).toMatchObject({ source: A2, version: 4 });
    home.land(A, [{ kind: "msg", key: "o", content: { v: 9 } }]);
    home.repair(A, (version) => (version.key === "o" ? { content: { v: 3 }, blobs: [file(4)] } : "keep"));
    home.check("a repair links the older version");
    expect(home.counted().rows.get(file(4))).toMatchObject({ source: B, version: 3 });
  });

  it("a file escapes: one arrived before its link, one after, one no version names, and an import that ends dead", () => {
    const home = scratch();
    home.arrive([file(5), file(9)]);
    expect(home.counted().rows.size).toBe(0);
    home.land(A, [{ kind: "msg", key: "before", content: { v: 1 }, blobs: [file(5)] }, { kind: "msg", key: "after", content: { v: 1 }, blobs: [file(6)] }]);
    home.check("landed");
    expect([...home.counted().rows.keys()]).toEqual([file(5)]);
    home.arrive([file(6)]);
    home.check("arrived after");
    expect([...home.counted().rows.keys()].sort()).toEqual([file(5), file(6)].sort());
    home.arrive([file(5), file(6)]);
    home.check("told again");
    home.land(B, [1, 2, 3].map((n) => ({ kind: "note", key: `s${n}`, content: { n }, blobs: [file(9)] })), { slices: 3, ended: false });
    home.checkWhole("an import ended dead");
  });

  it("a version stored while the fill runs takes a rowid at or below M, or one stored after it takes no freed rowid", () => {
    const home = scratch();
    home.land(A, [1, 2, 3].map((n) => ({ kind: "msg", key: `r${n}`, content: { n } })));
    home.upgrade(0, () => false);
    expect(home.mark()).toMatchObject({ M: 3 });
    home.erase([{ source: A, kind: "msg", key: "r3" }]);
    home.land(A, [{ kind: "msg", key: "r4", content: { n: 4 } }]);
    const rowid = () => home.raw.prepare("SELECT rowid FROM versions WHERE kind = 'msg' AND key = 'r4'").pluck().get() as number;
    expect(rowid()).toBe(4);
    home.check("stored while filling");
    expect(nonzero(home.counted().text)).toEqual({ [A]: home.truth().versions.find((version) => version.rowid === 4)!.bytes });
    home.finish();
    home.checkWhole("filled");
    home.erase([{ source: A, kind: "msg", key: "r4" }]);
    home.land(A, [{ kind: "msg", key: "r5", content: { n: 5 } }]);
    expect(home.raw.prepare("SELECT rowid FROM versions WHERE key = 'r5'").pluck().get()).toBe(3);
    home.checkWhole("complete");
  });

  it("a commit a minute before the day's start is placed on the day after, or one a minute after on the day before", () => {
    const home = scratch({ zone: "Asia/Kolkata", day_start_hour: 4 });
    home.now = Date.UTC(2026, 10, 2, 22, 29);
    home.land(A, [{ kind: "msg", key: "before", content: { v: 1 } }]);
    home.now = Date.UTC(2026, 10, 2, 22, 31);
    home.land(A, [{ kind: "msg", key: "after", content: { v: 1 } }]);
    const bytes = (key: string) => home.raw.prepare("SELECT octet_length(text) FROM versions WHERE key = ?").pluck().get(key) as number;
    expect(home.raw.prepare("SELECT day, source, text, files FROM stored_days ORDER BY day").all()).toEqual([
      { day: "2026-11-02", source: A, text: bytes("before"), files: 0 },
      { day: "2026-11-03", source: A, text: bytes("after"), files: 0 },
    ]);
  });
});

describe("Storage's fill", () => {
  const homes: Scratch[] = [];
  afterAll(() => {
    for (const home of homes) home.close();
  });
  const scratch = (day?: DaySettings): Scratch => {
    const home = new Scratch(day);
    homes.push(home);
    return home;
  };
  const text = (home: Scratch, key: string) => home.raw.prepare("SELECT octet_length(text) FROM versions WHERE key = ?").pluck().get(key) as number;

  it("a version or file is counted twice or by neither when slabs run at random points between live writes", () => {
    for (const seed of [21, 22, 23, 24]) {
      const home = scratch();
      const rng = random(seed);
      for (let at = 0; at < 60 || home.truth().versions.length === 0; at++) home.log.push(step(home, rng));
      home.put([POOL[seed % POOL.length]!]);
      home.upgrade(0, () => false);
      home.log.push(`upgrade at ${JSON.stringify(home.mark())}`);
      expect(home.mark(), `seed ${seed} holds versions at the upgrade`).toHaveProperty("M");
      const round = seed === 24 ? 5 : undefined;
      const fill = new Fill(home, {
        round, seqs: seed === 23 ? 8 : seed === 24 ? 7 : undefined,
        between: seed !== 23 ? undefined : () => {
          if (rng.next() >= 0.1) return;
          const did = step(home, rng);
          home.log.push(`between two map batches: ${did}`);
          home.check(`seed ${seed} between two map batches: ${did}`);
        },
      });
      let slabs = 0;
      let refused = 0;
      for (let read = fill.read(); read !== null; read = fill.read()) {
        const between = rng.next() < 0.12 ? step(home, rng) : null;
        if (between !== null) home.log.push(between);
        const committed = fill.commit(read);
        if (!committed) refused++;
        expect(committed, `seed ${seed} slab ${slabs} after ${between}`).toBe(!/^(erase|forget) /u.test(between ?? ""));
        const empty = "text" in read ? read.text.rows.length === 0 : read.files.files.length === 0;
        if (between !== null || !empty) home.check(`seed ${seed} slab ${slabs}${between === null ? "" : ` after ${between}`}`);
        slabs++;
      }
      expect(fill.complete(1_000_000)).toBe(true);
      home.log.push(`filled in ${slabs} slabs, ${refused} refused, ${fill.built} maps in ${fill.batches} batches, the widest ${fill.widest} rowids`);
      if (seed === 23 || seed === 24) expect(fill.batches).toBeGreaterThan(fill.built);
      home.checkWhole(`seed ${seed} the fill's end`);
      if (round !== undefined) {
        expect(fill.widest).toBeLessThanOrEqual(round);
        expect(fill.built).toBeGreaterThan(BLOCKS / round - 1);
      }
      expect(fill.read()).toBeNull();
      home.log.push(step(home, rng));
      home.checkWhole(`seed ${seed} after the end`);
    }
  });

  it("a map read in batches on many snapshots, lands between them, owns a version otherwise than one read or the recount", () => {
    for (const seed of [31, 32, 33]) {
      const home = scratch();
      const rng = random(seed);
      for (let at = 0; at < 60 || home.truth().versions.length === 0; at++) home.log.push(step(home, rng));
      home.upgrade(0, () => false);
      const { M } = home.mark() as StoredFilling;
      const [map, one] = onView(home, (view) => [view.stored.ownerMap({ settings: home.day, now_ms: home.now })!, wholeMap(view, home)] as const);
      let seen: unknown[][] = [];
      const see = map.see.bind(map);
      map.see = (rowid, source, started_ms) => {
        seen.push([rowid, source, started_ms]);
        see(rowid, source, started_ms);
      };
      const statements = (after: number, through: number) => home.raw.prepare(`SELECT v.rowid, s.source, r.started_ms FROM statements s
        JOIN versions v ON v.id = s.version LEFT JOIN runs r ON r.id = s.run WHERE s.seq > ? AND s.seq <= ? AND v.rowid <= ? ORDER BY s.seq`).raw(true).all(after, through, M);
      let batches = 0;
      for (let whole = false; !whole; batches++) {
        const source = rng.pick(SOURCES);
        const rows = Array.from({ length: 1 + rng.int(3) }, (): ReaderOutput => ({ kind: rng.pick(KINDS), key: `k${rng.int(5)}`, content: { v: rng.int(4) } }));
        home.later(rng.int(8) * HOUR);
        home.land(source, rows);
        home.log.push(`land between two map batches ${source} ${JSON.stringify(rows)}`);
        const seqs = 1 + rng.int(3);
        const after = map.seq;
        const through = Math.min(map.end, after + seqs);
        seen = [];
        whole = onView(home, (view) => view.stored.mapBatch(map, seqs))!;
        expect(whole, `seed ${seed} batch ${batches}`).not.toBeNull();
        expect(map.seq).toBe(through);
        expect(seen, `seed ${seed} batch ${batches}, seqs ${after} to ${through}`).toEqual(statements(after, through));
      }
      expect(batches, `seed ${seed}`).toBeGreaterThan(10);
      expect(map.seq).toBe(map.end);
      for (let rowid = 1; rowid <= M; rowid++) expect(map.at(rowid), `seed ${seed} rowid ${rowid}`).toEqual(one.at(rowid));
      const owners = home.truth().versions.filter((version) => version.rowid <= M);
      expect(owners.length).toBeGreaterThan(0);
      for (const { rowid, owner } of owners) expect(map.at(rowid)?.source, `seed ${seed} rowid ${rowid}`).toBe(owner);
      const fill = new Fill(home);
      fill.map = map;
      fill.finish();
      expect(fill.built).toBe(0);
      home.checkWhole(`seed ${seed} filled from the map read in batches`);
    }
  });

  it("an erase or forget between two map batches leaves the map read on, a partial map serves a slab, or the fill ends off the recount", () => {
    const home = scratch();
    const v = { kind: "msg", key: "shared", content: { text: "synthetic" } };
    const w = { kind: "note", key: "copied", content: { text: "synthetic note" } };
    home.put([file(1), file(2)]);
    home.land(A, [{ ...v, blobs: [file(1)] }]);
    home.land(B, [v]);
    home.land(A2, [{ ...w, blobs: [file(2)] }]);
    home.land(A, [w]);
    home.upgrade(0, () => false);
    const map = onView(home, (view) => {
      const begun = view.stored.ownerMap({ settings: home.day, now_ms: home.now })!;
      expect(begun.end).toBe(4);
      expect(view.stored.mapBatch(begun, 1)).toBe(false);
      return begun;
    });
    expect(map.at(1)).toMatchObject({ source: A });
    onView(home, (view) => {
      expect(() => view.stored.text(map, 0)).toThrow(RangeError);
      expect(() => view.stored.files(map, home.leaves, { after: null })).toThrow(RangeError);
    });
    home.erase([{ source: A, kind: "msg", key: "shared" }]);
    onView(home, (view) => expect(view.stored.mapBatch(map, 1)).toBeNull());
    expect(map.seq).toBe(1);
    let forgot = false;
    const fill = new Fill(home, {
      seqs: 1,
      between: () => {
        if (forgot) return;
        forgot = true;
        home.forget(A2, "note");
      },
    });
    fill.finish();
    expect(fill.built).toBe(2);
    home.checkWhole("filled");
    expect(nonzero(home.counted().text)).toEqual({ [A]: text(home, "copied"), [B]: text(home, "shared") });
    expect(home.counted().rows.get(file(1))).toMatchObject({ source: B });
    expect(home.counted().rows.get(file(2))).toMatchObject({ source: A });
  });

  it("an erase or forget between a slab's read and its commit counts the owner it moved, or a file it removed", () => {
    const home = scratch();
    const v = { kind: "msg", key: "shared", content: { text: "synthetic" } };
    const w = { kind: "note", key: "copied", content: { text: "synthetic note" } };
    home.put([file(1), file(2)]);
    home.land(A, [{ ...v, blobs: [file(1)] }]);
    home.land(B, [v]);
    home.land(A2, [{ ...w, blobs: [file(2)] }]);
    home.land(A, [w]);
    home.upgrade(0, () => false);
    const fill = new Fill(home);
    const first = fill.read()!;
    expect(first).toHaveProperty("text");
    home.erase([{ source: A, kind: "msg", key: "shared" }]);
    expect(fill.commit(first)).toBe(false);
    home.check("the text slab refused");
    const again = fill.read()!;
    expect(again).toHaveProperty("files");
    home.forget(A2, "note");
    expect(fill.commit(again)).toBe(false);
    home.check("the file slab refused");
    fill.finish();
    home.checkWhole("filled");
    expect(nonzero(home.counted().text)).toEqual({ [A]: text(home, "copied"), [B]: text(home, "shared") });
    expect(home.counted().rows.get(file(1))).toMatchObject({ source: B });
    expect(home.counted().rows.get(file(2))).toMatchObject({ source: A });

    const gone = scratch();
    gone.put([file(3)]);
    gone.land(A, [{ kind: "msg", key: "m", content: { v: 1 }, blobs: [file(3)] }]);
    gone.land(A, [{ kind: "msg", key: "n", content: { v: 2 } }]);
    gone.upgrade(0, () => false);
    const view = gone.reader.view();
    const slab = (() => {
      try {
        const map = wholeMap(view, gone);
        return view.stored.files(map, gone.leaves, { after: null }, { leaves: 0x10000, references: 4096 })!;
      } finally {
        view.close();
      }
    })();
    expect(slab.through).toBe(FILES_END);
    expect(slab.files.map((each) => each.blob)).toEqual([file(3)]);
    gone.erase([{ source: A, kind: "msg", key: "m" }]);
    expect(gone.held.has(file(3))).toBe(false);
    expect(gone.db.commit((tx) => tx.stored.countFiles(slab))).toBe(false);
    new Fill(gone).finish();
    gone.checkWhole("filled");
    expect(gone.counted().rows.size).toBe(0);
  });

  it("a file is counted twice or by neither when it arrives between a leaf's listing and the slab's commit, or a repair links an older version", () => {
    const home = scratch();
    home.land(A, [{ kind: "msg", key: "listed", content: { v: 1 }, blobs: [file(4)] }, { kind: "msg", key: "late", content: { v: 2 }, blobs: [file(5)] }]);
    home.land(B, [{ kind: "msg", key: "o", content: { v: 3 } }]);
    home.put([file(4), file(6)]);
    home.land(A2, [{ kind: "msg", key: "p", content: { v: 4 }, blobs: [file(6)] }]);
    home.land(A, [{ kind: "msg", key: "o", content: { v: 9 } }]);
    home.upgrade(0, () => false);
    const view = home.reader.view();
    const slab = (() => {
      try {
        const map = wholeMap(view, home);
        return view.stored.files(map, home.leaves, { after: null }, { leaves: 0x10000, references: 4096 })!;
      } finally {
        view.close();
      }
    })();
    expect(new Map(slab.files.map((each) => [each.blob, each.source]))).toEqual(new Map([[file(4), A], [file(6), A2]]));
    home.arrive([file(4), file(5)]);
    home.repair(A, (version) => (version.key === "o" ? { content: { v: 3 }, blobs: [file(6)] } : "keep"));
    expect(home.counted().rows.get(file(6))).toMatchObject({ source: B, version: 3 });
    expect(home.db.commit((tx) => tx.stored.countFiles(slab))).toBe(true);
    home.check("the slab committed after the live path");
    expect(home.counted().rows.get(file(6))).toMatchObject({ source: B, version: 3 });
    new Fill(home).finish();
    home.checkWhole("filled");
  });

  it("a rowid freed and stored again while its block is read is counted twice or not at all", () => {
    const home = scratch();
    home.land(A, [{ kind: "msg", key: "r1", content: { n: 1 } }]);
    home.upgrade(0, () => false);
    expect(home.mark()).toMatchObject({ M: 1 });
    const fill = new Fill(home);
    const read = fill.read()!;
    expect(read).toEqual(expect.objectContaining({ text: expect.objectContaining({ step: 0, rows: [expect.objectContaining({ source: A, text: text(home, "r1") })] }) }));
    home.erase([{ source: A, kind: "msg", key: "r1" }]);
    home.land(A, [{ kind: "msg", key: "r2", content: { n: 2 } }]);
    expect(home.raw.prepare("SELECT rowid FROM versions WHERE key = 'r2'").pluck().get()).toBe(2);
    expect(fill.commit(read)).toBe(false);
    fill.finish();
    home.checkWhole("filled");
    expect(nonzero(home.counted().text)).toEqual({ [A]: text(home, "r2") });
  });

  it("a batch of the owner map's read scans statements, versions or runs, or sorts, before or after ANALYZE", () => {
    const home = scratch();
    home.land(A, Array.from({ length: 200 }, (_, n): ReaderOutput => ({ kind: "msg", key: `m${n}`, content: { v: n } })));
    for (const analyzed of [false, true]) {
      if (analyzed) home.raw.exec("ANALYZE");
      const plan = (home.raw.prepare(`EXPLAIN QUERY PLAN ${OWNER_MAP}`).all(0, 8192, 1) as { detail: string }[]).map((row) => row.detail);
      expect(plan[0], `${analyzed ? "after" : "before"} ANALYZE: ${plan.join("; ")}`).toMatch(/^SEARCH s USING INTEGER PRIMARY KEY \(rowid>\? AND rowid<\?\)/u);
      expect(plan.some((detail) => /^SEARCH v USING (?:COVERING )?INDEX \w+ \(id=\?\)/u.test(detail)), plan.join("; ")).toBe(true);
      expect(plan.some((detail) => /^SEARCH r USING INTEGER PRIMARY KEY/u.test(detail)), plan.join("; ")).toBe(true);
      expect(plan.filter((detail) => /^SCAN /u.test(detail)), plan.join("; ")).toEqual([]);
      expect(plan.some((detail) => /TEMP B-TREE/u.test(detail)), plan.join("; ")).toBe(false);
    }
  });

  it("a file the fill counts is dated another day than its mtime's, or one written before the home's first day another than the first", () => {
    const home = scratch();
    const day = (n: number) => `2026-11-0${n}`;
    home.land(A, [{ kind: "msg", key: "early", content: { v: 1 }, blobs: [file(7)] }, { kind: "msg", key: "dated", content: { v: 2 }, blobs: [file(8)] }]);
    home.later(24 * HOUR);
    home.later(48 * HOUR);
    home.land(B, [{ kind: "msg", key: "later", content: { v: 3 } }]);
    home.put([file(7), file(8)]);
    home.written.set(file(7), Date.UTC(2026, 9, 20, 12));
    home.written.set(file(8), Date.UTC(2026, 10, 3, 18));
    home.upgrade(0, () => false);
    new Fill(home).finish();
    home.checkWhole("filled");
    expect(home.raw.prepare("SELECT day, source, files FROM stored_days WHERE files != 0 ORDER BY day").all()).toEqual([
      { day: day(2), source: A, files: home.held.get(file(7)) },
      { day: day(3), source: A, files: home.held.get(file(8)) },
    ]);
  });

  it("a file named by more than a slab's references is read whole in one slab, loses the lowest rowid across slabs, or an erase between them keeps a gone one", () => {
    const home = scratch();
    home.put([file(9)]);
    home.land(B, [{ kind: "msg", key: "first", content: { v: 0 }, blobs: [file(9)] }]);
    home.land(A, Array.from({ length: 5_000 }, (_, n): ReaderOutput => ({ kind: "msg", key: `m${n}`, content: { n }, blobs: [file(9)] })));
    home.upgrade(0, () => false);
    const slab = (): FileSlab => {
      const view = home.reader.view();
      try {
        const map = wholeMap(view, home);
        return view.stored.files(map, home.leaves, view.stored.mark() as StoredFilling, { leaves: 0x10000, references: SLAB_REFERENCES })!;
      } finally {
        view.close();
      }
    };
    const commit = (read: FileSlab) => home.db.commit((tx) => tx.stored.countFiles(read));
    const firstPage = home.raw.prepare(`SELECT min(rowid) FROM (SELECT v.rowid AS rowid FROM version_blobs vb JOIN versions v ON v.id = vb.version
      WHERE vb.blob = ? ORDER BY vb.version LIMIT 4096)`).pluck().get(file(9)) as number;
    const before = `sha256:${(Number.parseInt(file(9).slice(7, 11), 16) - 1).toString(16).padStart(4, "0")}${"f".repeat(60)}`;
    const first = slab();
    expect(first).toMatchObject({ through: before, references: 4096, files: [], naming: { blob: file(9), lowest: firstPage } });
    expect(commit(first)).toBe(true);
    expect(home.mark()).toMatchObject({ after: before, naming: first.naming });
    expect(commit(first)).toBe(false);
    const second = slab();
    expect(second.references).toBe(905);
    expect(second).not.toHaveProperty("naming");
    expect(second.files).toEqual([expect.objectContaining({ blob: file(9), source: B, version: 1 })]);
    home.erase([{ source: B, kind: "msg", key: "first" }]);
    expect(commit(second)).toBe(false);
    expect(home.mark()).not.toHaveProperty("naming");
    const again = slab();
    expect(again).toMatchObject({ from: before, through: before, references: 4096, files: [], naming: { blob: file(9) } });
    expect(commit(again)).toBe(true);
    const last = slab();
    expect(last.references).toBe(904);
    expect(last).not.toHaveProperty("naming");
    expect(last.files).toEqual([expect.objectContaining({ blob: file(9), source: A, version: 2 })]);
    expect(commit(last)).toBe(true);
    expect(home.mark()).not.toHaveProperty("naming");
    new Fill(home).finish();
    home.checkWhole("filled");
    expect(home.counted().rows.get(file(9))).toEqual({ source: A, version: 2, bytes: home.held.get(file(9)) });
  });

  it("the fill's end writes the days before the upgrade's own bytes off another figure than the text held by each day, or writes today", () => {
    const home = scratch();
    const day = (n: number) => `2026-11-0${n}`;
    home.now = Date.UTC(2026, 10, 2, 9);
    home.land(A, [{ kind: "msg", key: "d2", content: { v: 2 } }]);
    home.now = Date.UTC(2026, 10, 4, 9);
    home.land(B, [{ kind: "msg", key: "d4", content: { v: 4, long: "x".repeat(200) } }]);
    home.upgrade(0, () => false);
    home.now = Date.UTC(2026, 10, 6, 9);
    home.days.add(day(6));
    home.raw.prepare("INSERT INTO own_days (day, bytes) VALUES (?, ?)").run(day(5), 7);
    new Fill(home).finish(9_000);
    const total = text(home, "d2") + text(home, "d4");
    expect(home.raw.prepare("SELECT day, bytes FROM own_days ORDER BY day").all()).toEqual([
      { day: day(2), bytes: Math.round(9_000 * (text(home, "d2") / total)) },
      { day: day(3), bytes: Math.round(9_000 * (text(home, "d2") / total)) },
      { day: day(4), bytes: 9_000 },
      { day: day(5), bytes: 7 },
    ]);
    expect(home.raw.prepare("SELECT day, source FROM stored_days ORDER BY day").all()).toEqual([{ day: day(2), source: A }, { day: day(4), source: B }]);
    expect(home.mark()).toEqual({ complete: "checkout" });
    expect(home.db.commit((tx) => tx.stored.complete(1))).toBe(false);
  });
});

describe("Storage's day's close", () => {
  const homes: Scratch[] = [];
  afterAll(() => {
    for (const home of homes) home.close();
  });
  const scratch = (): Scratch => {
    const home = new Scratch();
    homes.push(home);
    return home;
  };
  const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
  const own = (home: Scratch) => home.raw.prepare("SELECT day, bytes FROM own_days ORDER BY day").all();

  it("a close writes another day than the one that ended on an empty table, or overwrites a day it closed", () => {
    const home = scratch();
    home.db.commit((tx) => tx.stored.close(day(3), 100));
    expect(own(home)).toEqual([{ day: day(3), bytes: 100 }]);
    home.db.commit((tx) => tx.stored.close(day(3), 200));
    expect(own(home)).toEqual([{ day: day(3), bytes: 100 }]);
    home.db.commit((tx) => tx.stored.close(day(2), 300));
    expect(own(home)).toEqual([{ day: day(3), bytes: 100 }]);
  });

  it("the days a home was stopped through are left out, or take another reading than the next one", () => {
    const home = scratch();
    home.db.commit((tx) => tx.stored.close(day(3), 100));
    home.db.commit((tx) => tx.stored.close(day(4), 150));
    home.db.commit((tx) => tx.stored.close(day(9), 400));
    expect(own(home)).toEqual([
      { day: day(3), bytes: 100 }, { day: day(4), bytes: 150 },
      ...[5, 6, 7, 8, 9].map((n) => ({ day: day(n), bytes: 400 })),
    ]);
    home.db.commit((tx) => tx.stored.close("2026-12-01", 500));
    expect((own(home) as { day: string }[]).slice(-3)).toEqual([
      { day: "2026-11-29", bytes: 500 }, { day: "2026-11-30", bytes: 500 }, { day: "2026-12-01", bytes: 500 },
    ]);
  });

  it("all text counted, as a helper reads it, is another figure than every source's text on every day", () => {
    const home = scratch();
    const read = () => {
      const view = home.reader.view();
      try {
        return view.stored.textCounted();
      } finally {
        view.close();
      }
    };
    expect(read()).toBe(0);
    home.land(A, [{ kind: "msg", key: "t1", content: { v: 1, long: "x".repeat(300) } }]);
    home.later(24 * HOUR);
    home.land(B, [{ kind: "msg", key: "t2", content: { v: 2 } }]);
    const total = home.raw.prepare("SELECT sum(octet_length(text)) FROM versions").pluck().get() as number;
    expect(total).toBeGreaterThan(300);
    expect(read()).toBe(total);
  });
});
