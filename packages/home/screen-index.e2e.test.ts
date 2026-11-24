import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { civilDay, openHomeFolder, type DaySettings } from "@lifestreamprotocol/core";
import { DIM } from "./screen-scan-wasm.js";
import { quantize } from "./screen-vectors.js";
import { ScreenIndex, chunkLines, meaningWalk, readScreen, screenBytes, unpackText, vectorsDirOf, type ScreenFrame, type ScreenSegment, type ScreenSource } from "./screen-index.js";


const DAYS: DaySettings = { zone: "UTC", day_start_hour: 4 };
const T0 = Date.parse("2026-11-02T06:00:00Z");
const MIN = 60_000;
const SEG = 5 * MIN;
const scratch = mkdtempSync(join(tmpdir(), "lifestream-screen-index-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let files = 0;
const fileOf = () => join(scratch, `f${++files}`, "screen.db");

const WORDS = ["amber", "basil", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp", "lumen", "meadow", "nectar", "onyx", "pepper", "quartz", "russet", "saffron", "tundra"];

function sentence(seed: number): string {
  const words = Array.from({ length: 12 }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]);
  return `Example post ${seed}: ${words.join(" ")}.`;
}

function life(machine: string, start: number, count: number, version = "v1"): ScreenSegment[] {
  const out: ScreenSegment[] = [];
  for (let s = 0; s < count; s++) {
    const from = start + s * SEG;
    const frames: ScreenFrame[] = [];
    for (let t = from; t < from + SEG; t += 2_000) {
      const phase = Math.floor((t - start) / MIN) % 3;
      const step = Math.floor((t - start) / 10_000);
      if (phase === 0) {
        frames.push({ t, app: "Example Browser", site: "www.example.com", title: `(${step % 4}) Example Page ${s % 2} — Site`, display: "1",
          lines: ["[Link] Home", sentence(step), sentence(step + 1), `Footer ${s % 2}`], ocr: [`ocr ${step}`] });
      } else if (phase === 1) {
        frames.push({ t, app: "WhatsApp", site: null, title: "WhatsApp", display: "1",
          lines: ["[Button] Start video call with Person A", `Message ${Math.floor(step / 3)} says hello`, sentence(100 + (step % 5))] });
      } else {
        frames.push({ t, app: "Codex", site: null, title: "Codex", display: "2",
          lines: ["[Button] Thread actions for Fix the example build", `step ${step} ${version}`] });
      }
    }
    out.push({ machine, version, start_ms: from, frames });
  }
  return out;
}

function sourceOf(segments: ScreenSegment[]): ScreenSource {
  return {
    segments: (machine, day) => segments.filter((segment) => segment.machine === machine && civilDay(segment.start_ms, DAYS) === day),
  };
}

function fresh(file: string, meaning = false): ScreenIndex {
  const options = { days: DAYS, meaning: meaning ? "test-model" : false as const };
  ScreenIndex.write(openHomeFolder(dirname(file)), file, options, () => true).finish();
  return ScreenIndex.write(openHomeFolder(dirname(file)), file, options, () => true);
}

function build(file: string, segments: ScreenSegment[], meaning = false, order: ScreenSegment[] = segments): ScreenIndex {
  const index = fresh(file, meaning);
  const source = sourceOf(segments);
  for (const segment of order) index.apply([segment], source);
  return index;
}

function dump(file: string): unknown {
  const db = new Database(file, { readonly: true });
  try {
    const key = "k.machine || '/' || k.app || '/' || k.site || '/' || k.name";
    const rows = (db.prepare(`SELECT r.slot, ${key} AS key, r.day, r.end_ms, r.seg_ms, r.tenths, r.prose, s.machine, s.start_ms, s.version, t.times, t.body
      FROM screen_row r JOIN screen_key k ON k.id = r.key JOIN screen_segment s ON s.id = r.segment LEFT JOIN screen_text t ON t.slot = r.slot ORDER BY r.slot`).all() as Record<string, unknown>[])
      .map(({ times, body, ...row }) => ({ ...row, text: body === null ? null : unpackText(times as Buffer, body as Buffer) }));
    const meaning = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'screen_unit'").get() !== undefined;
    return {
      keys: db.prepare(`SELECT ${key} AS key FROM screen_key k ORDER BY 1`).all(),
      rows,
      spans: db.prepare("SELECT * FROM screen_span ORDER BY slot, display, from_ms").all(),
      words: db.prepare("CREATE VIRTUAL TABLE temp.i USING fts5vocab(main, screen_fts, 'instance')").run() && db.prepare("SELECT term, doc, col, offset FROM temp.i ORDER BY 1, 2, 3, 4").all(),
      unmarked: db.prepare("SELECT slot FROM unmarked ORDER BY slot").all(),
      texts: db.prepare("SELECT value FROM meta WHERE name = 'texts'").get(),
      blocks: db.prepare(`SELECT b.machine, b.day, b.hash, ${key} AS key, f.body FROM screen_block b JOIN screen_key k ON k.id = b.key JOIN screen_block_fts f ON f.rowid = b.id ORDER BY 1, 2, 3`).all(),
      runs: db.prepare("SELECT b.hash, r.display, r.from_ms, r.to_ms FROM screen_block_run r JOIN screen_block b ON b.id = r.block ORDER BY 1, 2, 3").all(),
      tail: db.prepare("SELECT * FROM screen_tail ORDER BY 1, 2").all(),
      units: meaning ? db.prepare(`SELECT u.kind, ${key} AS key, u.day, u.text_hash, u.runs, u.members FROM screen_unit u JOIN screen_key k ON k.id = u.key ORDER BY 1, 2, 3, 4, 5`).all() : null,
      queue: meaning ? db.prepare("SELECT * FROM screen_embed_queue ORDER BY 1").all() : null,
    };
  } finally {
    db.close();
  }
}

function query<T>(file: string, sql: string, ...values: unknown[]): T[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all(...values) as T[];
  } finally {
    db.close();
  }
}

describe("screen index", () => {
  it("makes the same tables in order, late, and from scratch, with meaning and without (I1)", () => {
    for (const meaning of [false, true]) {
      const segments = [...life("mac-0001", T0, 12), ...life("mac-bb17", T0 + 30_000, 6)];
      const inOrder = fileOf();
      build(inOrder, segments, meaning).close();
      const late = fileOf();
      const order = [...segments.filter((_, i) => i !== 3 && i !== 8), segments[8]!, segments[3]!];
      const index = fresh(late, meaning);
      const arrived: ScreenSegment[] = [];
      let rebuilt = 0;
      for (const segment of order) {
        arrived.push(segment);
        rebuilt += index.apply([segment], sourceOf(arrived)).rebuilt.length;
      }
      index.close();
      expect(rebuilt).toBe(2);
      const whole = fileOf();
      const scratchIndex = fresh(whole, meaning);
      scratchIndex.rebuild("mac-0001", "2026-11-02", sourceOf(segments));
      scratchIndex.rebuild("mac-bb17", "2026-11-02", sourceOf(segments));
      scratchIndex.close();
      const expected = dump(inOrder);
      expect(dump(late)).toEqual(expected);
      expect(dump(whole)).toEqual(expected);
      if (meaning) {
        const walked = fileOf();
        build(walked, segments).close();
        const on = ScreenIndex.write(openHomeFolder(dirname(walked)), walked, { days: DAYS, meaning: "test-model" }, () => true);
        expect(on.building).toBe(false);
        while (on.walking) on.walkMeaning();
        on.close();
        expect(dump(walked)).toEqual(expected);
      }
      expect((expected as { rows: unknown[] }).rows.length).toBeGreaterThan(30);
    }
  });

  it("keys one window per machine, with the count taken off and the chat named (I5, I6)", () => {
    const file = fileOf();
    build(file, [...life("mac-0001", T0, 3), ...life("mac-bb17", T0, 3)]).close();
    const keys = query<{ machine: string; app: string; site: string; name: string }>(file, "SELECT machine, app, site, name FROM screen_key ORDER BY 1, 2, 3, 4");
    expect(keys.map((k) => `${k.machine}|${k.app}|${k.site}|${k.name}`)).toEqual([
      "mac-0001|Codex||Fix the example build",
      "mac-0001|Example Browser|example.com|Example Page 0 — Site",
      "mac-0001|Example Browser|example.com|Example Page 1 — Site",
      "mac-0001|WhatsApp||Person A",
      "mac-bb17|Codex||Fix the example build",
      "mac-bb17|Example Browser|example.com|Example Page 0 — Site",
      "mac-bb17|Example Browser|example.com|Example Page 1 — Site",
      "mac-bb17|WhatsApp||Person A",
    ]);
    const [hit] = query<{ n: number }>(file, "SELECT count(*) AS n FROM screen_fts WHERE screen_fts MATCH 'title:\"Person A\"'");
    expect(hit!.n).toBeGreaterThan(0);
  });

  it("forgets an erased frame: its title goes, and its lines are first seen where they recur (I2)", () => {
    const segments = life("mac-0001", T0, 6);
    const secret = { t: T0 + SEG + 1_000, app: "Example Browser", site: "secret.example.com", title: "Kept Title Example", display: "1",
      lines: ["A recurring line that shows twice today", "zebraword only here"] };
    const titled = { t: T0 + SEG + 1_500, app: "Example Browser", site: "secret.example.com", title: "Erased Title Example", display: "1", lines: ["zebraword again"] };
    const again = { t: T0 + 4 * SEG + 1_000, app: "Example Browser", site: "secret.example.com", title: "Kept Title Example", display: "1",
      lines: ["A recurring line that shows twice today"] };
    segments[1] = { ...segments[1]!, frames: [...segments[1]!.frames, secret, titled].sort((a, b) => a.t - b.t) };
    segments[4] = { ...segments[4]!, frames: [...segments[4]!.frames, again].sort((a, b) => a.t - b.t) };
    const file = fileOf();
    build(file, segments).close();
    const firstSeen = () => query<{ slot: number }>(file, "SELECT rowid AS slot FROM screen_fts WHERE screen_fts MATCH 'recurring'").map((row) => Math.floor(row.slot / 8));
    expect(firstSeen()).toEqual([secret.t]);
    const after = segments.map((segment, i) => i === 1 ? { ...segment, version: "v1-erased", frames: segment.frames.filter((f) => f !== secret && f !== titled) } : segment);
    ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: secret.t, to_ms: titled.t + 1 }], sourceOf(after));
    expect(firstSeen()).toEqual([again.t]);
    expect(query(file, "SELECT rowid FROM screen_fts WHERE screen_fts MATCH 'zebraword OR erased'")).toEqual([]);
    expect(query(file, "SELECT name FROM screen_key WHERE name LIKE '%Erased%'")).toEqual([]);
    expect(query(file, "SELECT term FROM screen_vocab WHERE term IN ('zebraword', 'erased')")).toEqual([]);
    const clean = fileOf();
    build(clean, after).close();
    expect(dump(file)).toEqual(dump(clean));
  });

  it("reaches a build under way as well as the published file, and publishes by one rename once its readers are done (I3, I9)", () => {
    const segments = life("mac-0001", T0, 4);
    segments[2] = { ...segments[2]!, frames: [...segments[2]!.frames, { t: T0 + 2 * SEG + 500, app: "Example Notes", site: null, title: "Erased Note", lines: ["zebraword secret line"] }].sort((a, b) => a.t - b.t) };
    const file = fileOf();
    const first = build(file, segments);
    const generation = first.generation();
    first.close();
    const rebuilding = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, (_, building) => building);
    expect(rebuilding.building).toBe(true);
    expect(rebuilding.generation()).not.toBe(generation);
    rebuilding.apply(segments.slice(0, 3), sourceOf(segments), { seq: 3 });
    rebuilding.close();
    expect(existsSync(join(file, "..", "screen.building.db"))).toBe(true);
    const reader = readScreen(openHomeFolder(dirname(file)), file)!;
    expect(reader.prepare("SELECT value FROM meta WHERE name = 'generation'").get()).toEqual({ value: generation });
    const after = segments.map((segment) => ({ ...segment, version: "erased", frames: segment.frames.filter((f) => f.app !== "Example Notes") }));
    ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: T0 + 2 * SEG + 500, to_ms: T0 + 2 * SEG + 501 }], sourceOf(after));
    const match = "SELECT rowid FROM screen_fts WHERE screen_fts MATCH 'zebraword'";
    expect(query(file, match)).toEqual([]);
    expect(query(join(file, "..", "screen.building.db"), match)).toEqual([]);
    const resumed = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, (position, building) => building && (position as { seq: number }).seq === 3);
    expect(resumed.position()).toEqual({ seq: 3 });
    resumed.apply(after.slice(3), sourceOf(after), { seq: 4 });
    expect(reader.prepare("SELECT value FROM meta WHERE name = 'generation'").get()).toEqual({ value: generation });
    reader.close();
    resumed.finish();
    expect(existsSync(join(file, "..", "screen.building.db"))).toBe(false);
    for (const suffix of ["-wal", "-shm", "-journal"]) expect(existsSync(`${file}${suffix}`)).toBe(false);
    const published = readScreen(openHomeFolder(dirname(file)), file)!;
    expect(published.prepare("SELECT value FROM meta WHERE name = 'position'").get()).toEqual({ value: JSON.stringify({ seq: 4 }) });
    published.close();
    const clean = fileOf();
    build(clean, after).close();
    expect(dump(file)).toEqual(dump(clean));
  });

  it("changes meaning in place: another model queues every text again with no new file, off drops it, words kept (I10)", () => {
    const segments = life("mac-0001", T0, 3);
    const file = fileOf();
    const vector = Float32Array.from({ length: DIM }, (_, at) => (at === 0 ? 1 : 0));
    const embed = (index: ScreenIndex) => index.land({ model: index.vectorModel()!, generation: index.generation() }, index.queued(2).map((each) => ({ textHash: each.textHash, vector })));
    const first = build(file, segments, true);
    const generation = first.generation();
    expect(embed(first)).toEqual({ landed: 2, dropped: 0 });
    const vectors = first.vectors;
    expect(vectors).toBe(vectorsDirOf(file, generation));
    expect(existsSync(join(vectors, "test-model"))).toBe(true);
    first.close();
    const texts = query<{ n: number }>(file, "SELECT count(DISTINCT text_hash) AS n FROM screen_unit")[0]!.n;

    const other = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "other-model" }, () => true);
    expect(other.building).toBe(false);
    expect(other.generation()).toBe(generation);
    expect(existsSync(join(file, "..", "screen.building.db"))).toBe(false);
    expect(query(file, "SELECT value FROM meta WHERE name = 'vector_model'")).toEqual([{ value: "other-model" }]);
    expect(query(file, "SELECT count(*) AS n FROM screen_vector")).toEqual([{ n: 0 }]);
    expect(other.queueLength()).toBe(texts);
    expect(existsSync(join(vectors, "test-model"))).toBe(false);
    expect(embed(other)).toEqual({ landed: 2, dropped: 0 });
    expect(existsSync(join(vectors, "other-model"))).toBe(true);
    const more = life("mac-0001", T0 + 3 * SEG, 1);
    expect(other.apply(more, sourceOf([...segments, ...more])).appended).toBe(1);
    other.close();

    const off = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, () => true);
    expect(off.building).toBe(false);
    expect(off.meaning).toBe(false);
    expect(off.queued(5)).toEqual([]);
    off.close();
    expect(existsSync(vectors)).toBe(false);
    expect(query(file, "SELECT name FROM sqlite_master WHERE name LIKE 'screen_unit%' OR name LIKE 'screen_embed%' OR name LIKE 'screen_chunk%' OR name LIKE 'screen_vector%'")).toEqual([]);
    const words = fileOf();
    build(words, [...segments, ...more]).close();
    expect(dump(file)).toEqual(dump(words));
  });

  it("turns meaning on over a published file newest day first, words kept current while it walks (I12)", () => {
    const DAY = 24 * 60 * MIN;
    const days = [0, 1, 2].map((d) => life("mac-0001", T0 + d * DAY, 3));
    const held = days.flat();
    const file = fileOf();
    build(file, held).close();
    const on = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "test-model" }, () => true);
    expect(on.building).toBe(false);
    expect(on.walking).toBe(true);
    let left = 1;
    expect(on.walkMeaning(() => left-- > 0)).toBe(1);
    expect(query(file, "SELECT DISTINCT day FROM screen_unit")).toEqual([{ day: "2026-11-04" }]);
    expect(on.queued(1_000).length).toBeGreaterThan(0);
    const reader = readScreen(openHomeFolder(dirname(file)), file)!;
    expect(meaningWalk(reader)).toBe("2026-11-03");
    reader.close();
    const arriving = life("mac-0001", T0 + 2 * DAY + 3 * SEG, 2, "late");
    for (const segment of arriving) expect(on.apply([segment], sourceOf([...held, ...arriving])).appended).toBe(1);
    expect(query(file, "SELECT rowid FROM screen_fts WHERE screen_fts MATCH 'late'").length).toBeGreaterThan(0);
    while (on.walking) on.walkMeaning();
    on.close();
    expect(query(file, "SELECT value FROM meta WHERE name = 'meaning_walk'")).toEqual([]);
    const scratch = fileOf();
    build(scratch, [...held, ...arriving], true).close();
    expect(dump(file)).toEqual(dump(scratch));
  });

  it("leaves nothing of meaning on disk while it is off: a crash's folder, and screen.db's meaning beside a build (I11)", () => {
    const segments = life("mac-0001", T0, 3);
    const vector = Float32Array.from({ length: DIM }, (_, at) => (at === 0 ? 1 : 0));
    const embed = (index: ScreenIndex) => index.land({ model: index.vectorModel()!, generation: index.generation() }, index.queued(2).map((each) => ({ textHash: each.textHash, vector })));

    const crashed = fileOf();
    build(crashed, segments).close();
    const generation = query<{ value: string }>(crashed, "SELECT value FROM meta WHERE name = 'generation'")[0]!.value;
    mkdirSync(vectorsDirOf(crashed, generation), { recursive: true });
    writeFileSync(join(vectorsDirOf(crashed, generation), "left"), "x".repeat(4096));
    expect(screenBytes(crashed).vectors_bytes).toBeGreaterThan(0);
    ScreenIndex.write(openHomeFolder(dirname(crashed)), crashed, { days: DAYS, meaning: false }, () => true).close();
    expect(screenBytes(crashed).vectors_bytes).toBe(0);

    const file = fileOf();
    const first = build(file, segments, true);
    expect(embed(first)).toEqual({ landed: 2, dropped: 0 });
    first.close();
    const other = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "test-model" }, (_, building) => building);
    expect(other.building).toBe(true);
    other.apply([segments[0]!], sourceOf(segments));
    expect(embed(other)).toEqual({ landed: 2, dropped: 0 });
    other.close();
    const off = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: false }, (_, building) => building);
    expect(off.building).toBe(true);
    expect(off.meaning).toBe(false);
    off.close();
    expect(query(file, "SELECT value FROM meta WHERE name = 'meaning'")).toEqual([{ value: "false" }]);
    expect(query(file, "SELECT name FROM sqlite_master WHERE name LIKE 'screen_unit%' OR name LIKE 'screen_vector%'")).toEqual([]);
    expect(screenBytes(file).vectors_bytes).toBe(0);
  });

  it("writes a batch's position after the days it emptied are rebuilt, so a failed rebuild leaves the position where it was (I14)", () => {
    const segments = life("mac-0001", T0, 3);
    const file = fileOf();
    const index = build(file, segments.slice(0, 2));
    index.apply([], sourceOf(segments), { seq: 1 });
    const failing: ScreenSource = { segments: () => { throw new Error("cut"); } };
    expect(() => index.apply([segments[2]!], failing, { seq: 2 }, ["mac-0001\x002026-11-02"])).toThrow("cut");
    expect(index.position()).toEqual({ seq: 1 });
    const applied = index.apply([segments[2]!], sourceOf(segments), { seq: 2 }, ["mac-0001\x002026-11-02"]);
    expect(applied).toMatchObject({ held: 1, rebuilt: ["mac-0001\x002026-11-02"] });
    expect(index.position()).toEqual({ seq: 2 });
    index.close();
  });

  it("leaves no erased text's vector on disk: its month written again whatever its dead share, a stray generation gone (I15)", () => {
    const segments = life("mac-0001", T0, 6);
    const secret = { t: T0 + SEG + 1_000, app: "Example Notes", site: null, title: "Secret Note", display: "1",
      lines: ["A secret paragraph that is long enough to be a block of its own today", "zebraword only here"] };
    segments[1] = { ...segments[1]!, frames: [...segments[1]!.frames, secret].sort((a, b) => a.t - b.t) };
    const file = fileOf();
    const index = build(file, segments, true);
    const vectorOf = (hash: string) => Float32Array.from({ length: DIM }, (_, at) => parseInt(hash.slice((at * 2) % 30, (at * 2) % 30 + 2), 16) - 127.5);
    const queued = index.queued(10_000);
    expect(index.land({ model: index.vectorModel()!, generation: index.generation() }, queued.map((each) => ({ textHash: each.textHash, vector: vectorOf(each.textHash) })))).toMatchObject({ dropped: 0 });
    const stray = vectorsDirOf(file, "an-older-build");
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, "2026-11.q8"), quantize(vectorOf(queued[0]!.textHash)));
    const vectors = index.vectors;
    index.close();
    const before = query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_vector").map((row) => row.text_hash);
    const after = segments.map((segment, i) => i === 1 ? { ...segment, version: "v1-erased", frames: segment.frames.filter((f) => f !== secret) } : segment);
    ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: secret.t, to_ms: secret.t + 1 }], sourceOf(after));
    const kept = query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_vector").map((row) => row.text_hash);
    const gone = before.filter((hash) => !kept.includes(hash));
    expect(gone.length).toBeGreaterThan(0);
    expect(gone.length).toBeLessThan(before.length * 0.25);
    const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]);
    const disk = files(join(file, "..", "screen-vectors")).map((path) => readFileSync(path));
    const held = (hash: string) => disk.some((bytes) => bytes.includes(quantize(vectorOf(hash))));
    expect(gone.filter(held)).toEqual([]);
    expect(kept.every(held)).toBe(true);
    expect(existsSync(stray)).toBe(false);
    expect(existsSync(vectors)).toBe(true);
  });

  it("purges every dead vector at an erasure, an earlier append's too, and finishes a purge a crash cut off at the next open (I16)", () => {
    const segments = life("mac-0001", T0, 6);
    const note = (t: number, title: string, line: string) => ({ t, app: "Example Notes", site: null, title, display: "1", lines: [line, `${title} only here`] });
    const secret = note(T0 + SEG + 1_000, "Secret Note", "A secret paragraph that is long enough to be a block of its own today");
    const draft = note(T0 + 3 * SEG + 1_000, "Old Draft", "An old draft paragraph that is long enough to be a block of its own too");
    segments[1] = { ...segments[1]!, frames: [...segments[1]!.frames, secret].sort((a, b) => a.t - b.t) };
    const later = note(T0 + 4 * SEG + 1_000, "Later Draft", "A later draft paragraph that is long enough to be a block of its own as well");
    segments[3] = { ...segments[3]!, frames: [...segments[3]!.frames, draft].sort((a, b) => a.t - b.t) };
    segments[4] = { ...segments[4]!, frames: [...segments[4]!.frames, later].sort((a, b) => a.t - b.t) };
    const file = fileOf();
    const index = build(file, segments, true);
    const vectorOf = (hash: string) => Float32Array.from({ length: DIM }, (_, at) => parseInt(hash.slice((at * 2) % 30, (at * 2) % 30 + 2), 16) - 127.5);
    const queued = index.queued(10_000);
    expect(index.land({ model: index.vectorModel()!, generation: index.generation() }, queued.map((each) => ({ textHash: each.textHash, vector: vectorOf(each.textHash) })))).toMatchObject({ dropped: 0 });
    const vectors = index.vectors;
    const all = () => query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_vector").map((row) => row.text_hash);
    const landed = all();
    const restated = segments.map((segment, i) => i === 3 ? { ...segment, version: "v1-restated", frames: segment.frames.filter((f) => f !== draft) } : segment);
    index.apply([restated[3]!], sourceOf(restated));
    index.close();
    const dead = () => query<{ dead: number }>(file, "SELECT coalesce(sum(rows - named), 0) AS dead FROM screen_vector_file")[0]!.dead;
    const drafted = landed.filter((hash) => !all().includes(hash));
    expect(drafted.length).toBeGreaterThan(0);
    expect(dead()).toBe(drafted.length);
    const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]);
    const held = (hash: string) => files(vectors).some((path) => readFileSync(path).includes(quantize(vectorOf(hash))));
    expect(drafted.every(held)).toBe(true);
    const pending = () => query<{ value: string }>(file, "SELECT value FROM meta WHERE name = 'purge_pending'")[0]?.value;

    const after = restated.map((segment, i) => i === 1 ? { ...segment, version: "v1-erased", frames: segment.frames.filter((f) => f !== secret) } : segment);
    const [month] = readdirSync(join(vectors, "test-model"));
    const path = join(vectors, "test-model", month!);
    renameSync(path, `${path}.away`);
    expect(() => ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: secret.t, to_ms: secret.t + 1 }], sourceOf(after))).toThrow();
    renameSync(`${path}.away`, path);
    const erased = landed.filter((hash) => !drafted.includes(hash) && !all().includes(hash));
    expect(erased.length).toBeGreaterThan(0);
    expect(pending()).toBe("true");
    expect([...drafted, ...erased].every(held)).toBe(true);

    ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "test-model" }, () => true).close();
    expect(pending()).toBeUndefined();
    expect(dead()).toBe(0);
    expect([...drafted, ...erased].filter(held)).toEqual([]);
    expect(all().every(held)).toBe(true);

    const again = ScreenIndex.write(openHomeFolder(dirname(file)), file, { days: DAYS, meaning: "test-model" }, () => true);
    const restatedAgain = after.map((segment, i) => i === 4 ? { ...segment, version: "v1-again", frames: segment.frames.filter((f) => f !== later) } : segment);
    again.apply([restatedAgain[4]!], sourceOf(restatedAgain));
    again.close();
    expect(dead()).toBeGreaterThan(0);
    ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: T0, to_ms: T0 + 1 }], sourceOf(restatedAgain));
    expect(dead()).toBe(0);
    expect(pending()).toBeUndefined();
  });

  it("rebuilds under secure_delete ON and leaves FAST, a throw too, and empties its log when no reader holds it (I17)", () => {
    const segments = life("mac-0001", T0, 6);
    const secret = { t: T0 + SEG + 1_000, app: "Example Browser", site: "secret.example.com", title: "Erased Title Example", display: "1", lines: ["zebraword only here"] };
    segments[1] = { ...segments[1]!, frames: [...segments[1]!.frames, secret].sort((a, b) => a.t - b.t) };
    const file = fileOf();
    build(file, segments).close();
    const after = segments.map((segment, i) => i === 1 ? { ...segment, version: "v1-erased", frames: segment.frames.filter((f) => f !== secret) } : segment);
    const said: string[] = [];
    const original = Database.prototype.pragma;
    const spy = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, ...args: Parameters<Database.Database["pragma"]>) {
      if (/^secure_delete = /u.test(args[0])) said.push(args[0]);
      return Reflect.apply(original, this, args) as unknown;
    });
    try {
      expect(ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: secret.t, to_ms: secret.t + 1 }], sourceOf(after), () => {}, 1_000)).toEqual([]);
      expect(said.slice(-2)).toEqual(["secure_delete = ON", "secure_delete = FAST"]);
      expect(existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0).toBe(0);
      expect(query(file, "SELECT rowid FROM screen_fts WHERE screen_fts MATCH 'zebraword'")).toEqual([]);
      said.length = 0;
      const throwing: ScreenSource = { segments: () => { throw new Error("a synthetic failure inside the rebuild"); } };
      expect(() => ScreenIndex.erase(openHomeFolder(dirname(file)), file, [{ machine: "mac-0001", from_ms: T0, to_ms: T0 + 1 }], throwing)).toThrow("a synthetic failure inside the rebuild");
      expect(said.slice(-2)).toEqual(["secure_delete = ON", "secure_delete = FAST"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("rebuilds the machine-day when a segment's version changes, and skips one it holds (I4)", () => {
    const segments = life("mac-0001", T0, 4);
    const file = fileOf();
    const index = build(file, segments);
    expect(index.apply([segments[1]!], sourceOf(segments)).held).toBe(1);
    const changed = segments.map((segment, i) => i === 1 ? life("mac-0001", T0, 2, "v2")[1]! : segment);
    expect(index.apply([changed[1]!], sourceOf(changed)).rebuilt).toEqual(["mac-0001\x002026-11-02"]);
    index.close();
    expect(query(file, "SELECT rowid FROM screen_fts WHERE screen_fts MATCH 'v2'").length).toBeGreaterThan(0);
    const clean = fileOf();
    build(clean, changed).close();
    expect(dump(file)).toEqual(dump(clean));
  });

  it("writes no unit or queue without meaning; with it, a rebuild lets go of texts no unit names (I7)", () => {
    const without = fileOf();
    build(without, life("mac-0001", T0, 3)).close();
    expect(query(without, "SELECT name FROM sqlite_master WHERE name LIKE 'screen_unit%' OR name LIKE 'screen_embed%' OR name LIKE 'screen_chunk%'")).toEqual([]);

    const segments = life("mac-0001", T0, 3);
    const file = fileOf();
    const index = build(file, segments, true);
    const units = query<{ kind: string; n: number }>(file, "SELECT kind, count(*) AS n FROM screen_unit GROUP BY kind ORDER BY kind");
    expect(units.map((u) => u.kind)).toEqual(["block", "chunk"]);
    const queued = query<{ n: number }>(file, "SELECT count(*) AS n FROM screen_embed_queue")[0]!.n;
    expect(queued).toBe(query<{ n: number }>(file, "SELECT count(DISTINCT text_hash) AS n FROM screen_unit")[0]!.n);
    const db = new Database(file);
    db.prepare("INSERT INTO screen_vector(model, month, row, text_hash) SELECT 'test-model', '2026-11', row_number() OVER (), text_hash FROM screen_embed_queue").run();
    db.exec("DELETE FROM screen_embed_queue");
    db.close();
    const before = query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_vector ORDER BY 1").map((row) => row.text_hash);
    const fewer = segments.map((segment) => ({ ...segment, version: "v2", frames: segment.frames.filter((f) => f.app !== "WhatsApp") }));
    index.rebuild("mac-0001", "2026-11-02", sourceOf(fewer));
    index.close();
    const named = query<{ text_hash: string }>(file, "SELECT DISTINCT text_hash FROM screen_unit ORDER BY 1").map((row) => row.text_hash);
    const vectors = query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_vector ORDER BY 1").map((row) => row.text_hash);
    expect(vectors.length).toBeLessThan(before.length);
    expect(vectors.every((hash) => named.includes(hash))).toBe(true);
    const queue = query<{ text_hash: string }>(file, "SELECT text_hash FROM screen_embed_queue").map((row) => row.text_hash);
    expect([...vectors, ...queue].sort()).toEqual(named);
  });

  it("cuts a key-day's lines into chunks of about 6,000 bytes, the last one growing, each its own lines (I7, I13)", () => {
    const long = (n: number) => `Line ${n} ${"of example words ".repeat(20)}`;
    const segments = Array.from({ length: 4 }, (_, s): ScreenSegment => ({
      machine: "mac-0001", version: "v1", start_ms: T0 + s * SEG,
      frames: Array.from({ length: 10 }, (_, i) => ({ t: T0 + s * SEG + i * 2_000, app: "Example Reader", site: null, title: "Example Book",
        lines: Array.from({ length: 4 }, (_, j) => long(s * 40 + i * 4 + j)) })),
    }));
    const file = fileOf();
    const index = build(file, segments, true);
    const queue = new Map(index.queued(1_000).map((each) => [each.textHash, each.text]));
    index.close();
    const chunks = query<{ unit: number; text_hash: string; members: string }>(file, "SELECT unit, text_hash, members FROM screen_unit WHERE kind = 'chunk' ORDER BY unit");
    const texts = chunks.map((chunk) => queue.get(chunk.text_hash)!);
    const db = new Database(file, { readonly: true });
    const lines = chunks.map((chunk) => chunkLines(db, chunk.members).flatMap((member) => member.lines));
    db.close();
    expect(lines.map((each) => each.join("\n"))).toEqual(texts);
    expect(new Set(lines.flat()).size).toBe(lines.flat().length);
    expect(texts.slice(0, -1).every((text) => Buffer.byteLength(text) <= 6_000 && Buffer.byteLength(text) > 5_000)).toBe(true);
    expect(texts.join("\n").split("\n")).toEqual(Array.from({ length: 160 }, (_, n) => long(n).trimEnd().replace(/\s+/gu, " ")));
    expect(queue.size).toBe(query<{ n: number }>(file, "SELECT count(DISTINCT text_hash) AS n FROM screen_unit")[0]!.n);
  });

  it("counts front time from tenths: 10 s at most per frame, an unchanged screen 5 minutes at most (I8)", () => {
    const still = (start: number, count: number): ScreenSegment[] => Array.from({ length: count }, (_, s) => ({
      machine: "mac-0001", version: "v1", start_ms: start + s * SEG,
      frames: Array.from({ length: SEG / 2_000 }, (_, i) => ({ t: start + s * SEG + i * 2_000, app: "Example Reader", site: null, title: "Still Page", lines: ["the same words"] })),
    }));
    const sparse: ScreenSegment = {
      machine: "mac-0001", version: "v1", start_ms: T0 + 6 * SEG,
      frames: [0, 30_000, 32_000, 100_000].map((offset, i) => ({ t: T0 + 6 * SEG + offset, app: "Example Notes", site: null, title: "Gappy", lines: [`line ${i}`] })),
    };
    const file = fileOf();
    build(file, [...still(T0, 3), sparse]).close();
    const total = (title: string) => query<{ tenths: number }>(file, "SELECT sum(r.tenths) AS tenths FROM screen_row r JOIN screen_key k ON k.id = r.key WHERE k.name = ?", title)[0]!.tenths;
    expect(total("Still Page")).toBe(3_000);
    expect(total("Gappy")).toBe(320);
    expect(query(file, "SELECT r.tenths FROM screen_row r JOIN screen_key k ON k.id = r.key WHERE k.name = 'Still Page' ORDER BY slot")).toEqual([{ tenths: 3_000 }, { tenths: 0 }, { tenths: 0 }]);
  });

  it("keeps a row's new lines with their times, a key in front with no new text still counted", () => {
    const segments = life("mac-0001", T0, 3);
    const repeat: ScreenSegment = { machine: "mac-0001", version: "v1", start_ms: T0 + 3 * SEG,
      frames: segments[0]!.frames.map((frame) => ({ ...frame, t: frame.t + 3 * SEG })) };
    const file = fileOf();
    build(file, [...segments, repeat]).close();
    const rows = query<{ slot: number; seg_ms: number; times: Buffer | null; body: Buffer | null; name: string; tenths: number }>(file,
      "SELECT r.slot, r.seg_ms, t.times, t.body, k.name, r.tenths FROM screen_row r JOIN screen_key k ON k.id = r.key LEFT JOIN screen_text t ON t.slot = r.slot ORDER BY r.slot");
    const first = rows[0]!;
    const lines = unpackText(first.times!, first.body!);
    expect(lines[0]).toEqual({ line: "Home", tenths: 0, ax: true });
    expect(lines.find((l) => l.line === "ocr 0")).toEqual({ line: "ocr 0", tenths: 0, ax: false });
    expect(rows.every((row) => row.tenths > 0)).toBe(true);
    expect(rows.some((row) => row.body === null)).toBe(true);
  });
});
