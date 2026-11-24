import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonical, changedPaths, digest, FormatError, parse, sha256, versionId, wellFormedJson } from "./format.js";
import { MissingVersion, tally } from "./records.js";
import { openHome, type HomeDb } from "./home-db.js";
import { openHomeFolder } from "./home-folder.js";
import type { Guard, Head, Json, Landed, RecordRef, ReaderOutput, Statement } from "./types.js";

const GOLDEN = new URL("./test/versions.golden.json", import.meta.url);
const DAY = 86_400_000;
const T1 = Date.UTC(2026, 8, 1);
const T2 = T1 + DAY;
const T3 = T2 + DAY;
const T4 = T3 + DAY;

const isObject: Guard = (content) =>
  typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["content is not an object"];
const GUARDS: Record<string, Guard> = { msg: isObject, sample: isObject, photo: isObject };

describe("format", () => {
  it("a number whose text does not round-trip through a 64-bit float is accepted", () => {
    for (const lossy of ["12345678901234567890", "0.10000000000000000001", "9007199254740993", "1e400", "-1e400", "1e-400", '{"a":[1,2.0000000000000000001]}']) {
      expect(() => parse(lossy), lossy).toThrow(FormatError);
    }
    expect(parse("[1.0, 1e2, 0.1, -0, 1.50e1, 123456789012345680000, 5e-324]")).toEqual([1, 100, 0.1, -0, 15, 123456789012345680000, 5e-324]);
  });

  it("two member names equal under NFC are accepted, by parse or by canonical", () => {
    expect(() => parse('{"a":1,"a":2}')).toThrow(/duplicate member name/);
    expect(() => parse('{"\u00e9":1,"e\u0301":2}')).toThrow(/duplicate member name/);
    expect(() => parse('{"K":1,"\\u212a":2}')).toThrow(/duplicate member name/);
    expect(() => parse('{"x":{"\u00e9":1,"e\\u0301":2}}')).toThrow(/duplicate member name/);
    expect(() => canonical({ "\u00e9": 1, "e\u0301": 2 })).toThrow(/equal under NFC/);
    expect(() => canonical({ K: 1, "\u212a": 2 })).toThrow(/equal under NFC/);
    expect(parse('[{"a":1},{"a":2},{"b":{"a":3}}]')).toEqual([{ a: 1 }, { a: 2 }, { b: { a: 3 } }]);
    expect(canonical({ "e\u0301": "e\u0301" })).toBe('{"e\u0301":"e\u0301"}');
  });

  it("a lone surrogate is accepted, in a string or in a member name", () => {
    expect(() => parse('"\\ud800"')).toThrow(/lone surrogate/);
    expect(() => parse('{"\\udc00":1}')).toThrow(/lone surrogate/);
    expect(() => parse('["\ud800"]')).toThrow(/lone surrogate/);
    expect(() => canonical("\ud800")).toThrow(/lone surrogate/);
    expect(() => canonical({ "\udc00": 1 })).toThrow(/lone surrogate/);
    expect(() => versionId("msg", "k\ud800", {})).toThrow(/lone surrogate/);
    expect(canonical("\ud83d\ude00")).toBe('"\ud83d\ude00"');
    expect(parse('"\\ud83d\\ude00"')).toBe("\ud83d\ude00");
  });

  it("JSON for another language's decoder writes a lone surrogate as an escape, moves an offset, or a well-formed value otherwise than JSON.stringify", () => {
    const written = wellFormedJson({ text: "cut \ud83c", list: ["\udc00x", 1, null], nested: { title: "a\ud83d\ude00b\ud83d" } });
    expect(written).not.toMatch(/\\u[dD][89abAB]/u);
    expect(JSON.parse(written)).toEqual({ text: "cut \ufffd", list: ["\ufffdx", 1, null], nested: { title: "a\ud83d\ude00b\ufffd" } });
    expect((JSON.parse(written) as { text: string }).text.length).toBe("cut \ud83c".length);
    const whole = { text: "Party \u{1F389} \u{1F1EE}\u{1F1F3}", n: 3, deep: [{ a: "\u00e9" }], none: null };
    expect(wellFormedJson(whole)).toBe(JSON.stringify(whole));
  });

  it("a non-finite number or a non-JSON value is accepted by canonical", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { a: undefined }, new Date(0), [1, () => 1]]) {
      expect(() => canonical(bad as unknown as Json)).toThrow(FormatError);
    }
    expect(() => canonical({ a: [1, { b: Number.NaN }] })).toThrow(expect.objectContaining({ path: "$.a[1].b" }));
  });

  it("canonical text differs from RFC 8785 (member order, numbers, escapes)", () => {
    const value = {
      "\u20ac": "Euro Sign", "\r": "Carriage Return", "\ufb33": "Hebrew Letter Dalet With Dagesh", "1": "One",
      "\ud83d\ude00": "Emoji: Grinning Face", "\u0080": "Control", "\u00f6": "Latin Small Letter O With Diaeresis",
    };
    expect(canonical(value)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","\u00f6":"Latin Small Letter O With Diaeresis",' +
        '"\u20ac":"Euro Sign","\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
    expect(canonical([1e21, 1e-7, 0.000001, -0, 333333333.33333329, 4.5, 2e-3, 1e23, 5e-324])).toBe(
      "[1e+21,1e-7,0.000001,0,333333333.3333333,4.5,0.002,1e+23,5e-324]",
    );
    expect(canonical("\u0000\u001f\"\\/\u00e9\u2028")).toBe('"\\u0000\\u001f\\"\\\\/\u00e9\u2028"');
    const text = '{"z":[true,false,null,{"b":2,"a":1}],"a":"x"}';
    expect(canonical(parse(text))).toBe('{"a":"x","z":[true,false,null,{"a":1,"b":2}]}');
    const { id, text: stored } = versionId("msg", "k1", { b: 1, a: 2 });
    expect(stored).toBe('{"content":{"a":2,"b":1},"key":"k1","kind":"msg"}');
    expect(id).toBe(sha256(stored));
    expect(digest({ b: 1, a: 2 })).toBe(sha256('{"a":2,"b":1}'));
  });

  it("changedPaths counts a ticking array element once per element", () => {
    const before = { a: [{ s: 1, t: 1 }, { s: 2, t: 1 }], b: 1, c: { d: 1 } };
    const after = { a: [{ s: 1, t: 2 }, { s: 3, t: 2 }], b: 1, c: { d: 1, e: 2 } };
    expect(changedPaths(before, after)).toEqual(["a[].s", "a[].t", "c.e"]);
    expect(changedPaths([1, 2], [1, 2, 3])).toEqual(["[]"]);
    expect(changedPaths(1, 2)).toEqual(["$"]);
    expect(changedPaths({ a: 1 }, { a: 1 })).toEqual([]);
  });
});

describe("versions", () => {
  let dir: string;
  let db: HomeDb;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "core-versions-"));
    db = openHome(openHomeFolder(dir), "migrate");
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function land(source: string, stated_ms: number, rows: ReaderOutput[], slices = 1): { run: number; landed: Landed[] } {
    return db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
      const size = Math.ceil(rows.length / slices);
      const landed: Landed[] = [];
      for (let at = 0; at < rows.length || at === 0; at += size) {
        landed.push(tx.records.land(run, { id: `${source}@${stated_ms}`, source, stated_ms }, rows.slice(at, at + size), GUARDS, { has: () => true }));
        if (rows.length === 0) break;
      }
      tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok", counts: landed.map(counts) });
      return { run, landed };
    });
  }

  const msg = (key: string, content: Json, extra: Partial<ReaderOutput> = {}): ReaderOutput => ({ kind: "msg", key, content, ...extra });
  const gone = (key: string): ReaderOutput => ({ kind: "msg", key, content: null, gone: true });

  function read<T>(work: (view: ReturnType<HomeDb["view"]>) => T): T {
    const view = db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  }

  const head = (source: string, key: string, kind = "msg"): Head | undefined => read((view) => view.head({ source, kind, key }));
  const history = (source: string, key: string, kind = "msg"): Statement[] => read((view) => view.history({ source, kind, key }));
  const id = (key: string, content: Json, kind = "msg"): string => versionId(kind, key, content).id;

  function dump(source?: string): { statements: Statement[]; heads: Head[] } {
    return read((view) => {
      const statements = [...view.statements(0, source === undefined ? {} : { sources: [source] })];
      const records = [...new Set(statements.map((row) => canonical([row.source, row.kind, row.key])))].sort();
      const heads = records.flatMap((record) => {
        const [src, kind, key] = JSON.parse(record) as [string, string, string];
        const found = view.head({ source: src, kind, key });
        return found ? [found] : [];
      });
      return { statements, heads };
    });
  }

  it("a replay of a delivery writes a row, positive or gone", () => {
    const s = "chat:replay";
    const first = land(s, T1, [msg("m1", { text: "a" }), msg("m2", { text: "b" }), gone("m3")]).landed[0]!;
    expect(counts(first)).toMatchObject({ new: 2, gone: 1 });
    const second = land(s, T2, [msg("m1", { text: "a2" }), gone("m2")]).landed[0]!;
    expect(counts(second)).toMatchObject({ changed: 1, gone: 1 });
    const before = canonical(dump(s) as unknown as Json);
    const replayFirst = land(s, T1, [msg("m1", { text: "a" }), msg("m2", { text: "b" }), gone("m3")]).landed[0]!;
    const replaySecond = land(s, T2, [msg("m1", { text: "a2" }), gone("m2")]).landed[0]!;
    expect(counts(replayFirst)).toMatchObject({ replayed: 2, restated: 1, new: 0, changed: 0, late: 0, gone: 0 });
    expect(counts(replaySecond)).toMatchObject({ restated: 2, new: 0, changed: 0, gone: 0 });
    expect(canonical(dump(s) as unknown as Json)).toBe(before);
  });

  it("A→B→A collides or is refused", () => {
    const s = "chat:aba";
    const a = { text: "hello", status: 1 };
    const b = { text: "hello", status: 2 };
    expect(counts(land(s, T1, [msg("k", a)]).landed[0]!)).toMatchObject({ new: 1 });
    expect(counts(land(s, T2, [msg("k", b)]).landed[0]!)).toMatchObject({ changed: 1, changedPaths: { status: 1 } });
    expect(counts(land(s, T3, [msg("k", a)]).landed[0]!)).toMatchObject({ changed: 1, changedPaths: { status: 1 } });
    const statements = history(s, "k");
    expect(statements.map((row) => row.version)).toEqual([id("k", a), id("k", b), id("k", a)]);
    expect(head(s, "k")).toMatchObject({ version: id("k", a), stated_ms: T3, since_ms: T3 });
  });

  it("a newer statement cannot reopen a gone record", () => {
    const s = "health:reopen";
    const sample = { value: 7 };
    land(s, T1, [msg("K", sample)]);
    expect(counts(land(s, T2, [gone("K")]).landed[0]!)).toMatchObject({ gone: 1 });
    expect(head(s, "K")).toMatchObject({ version: "gone", stated_ms: T2 });
    expect(counts(land(s, T3, [msg("K", sample)]).landed[0]!)).toMatchObject({ changed: 1 });
    expect(head(s, "K")).toMatchObject({ version: id("K", sample), stated_ms: T3, since_ms: T3 });
    expect(counts(land(s, T2, [gone("K")]).landed[0]!)).toMatchObject({ replayed: 1, gone: 0 });
    expect(head(s, "K")).toMatchObject({ version: id("K", sample) });
    expect(history(s, "K")).toHaveLength(3);
  });

  it("an old delivery moves a head", () => {
    const s = "chat:late";
    land(s, T1, [msg("k", { v: "a" })]);
    land(s, T3, [msg("k", { v: "b" })]);
    expect(counts(land(s, T2, [msg("k", { v: "c" })]).landed[0]!)).toMatchObject({ late: 1, changed: 0 });
    expect(counts(land(s, T2, [gone("k")]).landed[0]!)).toMatchObject({ late: 1, gone: 0 });
    expect(counts(land(s, T2, [msg("k", { v: "b" })]).landed[0]!)).toMatchObject({ restated: 1 });
    expect(head(s, "k")).toMatchObject({ version: id("k", { v: "b" }), stated_ms: T3, since_ms: T3 });
    expect(history(s, "k").map((row) => [row.stated_ms, row.late])).toEqual([[T1, false], [T3, false], [T2, true], [T2, true]]);
  });

  it("a later-dated import of an older version beats a newer restatement", () => {
    const s = "chat:restated";
    land(s, T1, [msg("k", { v: "old" })]);
    land(s, T2, [msg("k", { v: "new" })]);
    const restated = land(s, T4, [msg("k", { v: "new" })]).landed[0]!;
    expect(counts(restated)).toMatchObject({ restated: 1 });
    expect(head(s, "k")).toMatchObject({ stated_ms: T4, since_ms: T2 });
    expect(counts(land(s, T3, [msg("k", { v: "old" })]).landed[0]!)).toMatchObject({ late: 1 });
    expect(head(s, "k")).toMatchObject({ version: id("k", { v: "new" }), stated_ms: T4 });
    expect(history(s, "k")).toHaveLength(3);
  });

  it("a repeat inside one delivery moves another run's statement, and undo of that run restores a version that did not exist before it", () => {
    const s = "chat:twin";
    const a = { v: "twin a" };
    const b = { v: "twin b" };
    const first = land(s, T1, [msg("k", a)]).run;
    const stated = history(s, "k");
    const second = land(s, T1, [msg("k", b), msg("k", a)], 2);
    expect(counts(second.landed[1]!)).toMatchObject({ duplicated: 1, replayed: 0, changed: 0 });
    const undoFirst = read((view) => view.planUndo(first));
    expect(undoFirst.examples.map((example) => example.after)).not.toContainEqual(b);
    expect(tally(undoFirst.steps).counts).toMatchObject({ heads: 1, moved: 1, changed: 0, gone: 0 });
    expect(tally(read((view) => view.planUndo(second.run)).steps).counts).toMatchObject({ heads: 1, kept: 1, changed: 0, gone: 0 });
    const moves = history(s, "k");
    expect(moves.slice(0, 1)).toEqual(stated);
    expect(moves.map((row) => [row.version, row.run])).toEqual([[id("k", a), first], [id("k", b), second.run], [id("k", a), second.run]]);
    expect(head(s, "k")).toMatchObject({ version: id("k", a), stated_ms: T1, since_ms: T1 });
    expect(counts(land(s, T1, [msg("k", a)]).landed[0]!)).toMatchObject({ restated: 1 });
    expect(counts(land(s, T1, [msg("k", b)]).landed[0]!)).toMatchObject({ replayed: 1 });
    expect(history(s, "k")).toEqual(moves);
  });

  it("an erased thing returns through a ticked version or another replica", () => {
    const blob = sha256("photo bytes of a synthetic image");
    const content = { text: "a message to forget", photo: blob };
    const photo = { kind: "msg", key: "3EB0AA01", content, blobs: [blob] } satisfies ReaderOutput;
    land("whatsapp:+15550000001:iphone-aa01", T1, [photo]);
    land("whatsapp:+15550000001:macbook-pro-0001", T1, [photo]);
    const records: RecordRef[] = [
      { source: "whatsapp:+15550000001:iphone-aa01", kind: "msg", key: "3EB0AA01" },
      { source: "whatsapp:+15550000001:macbook-pro-0001", kind: "msg", key: "3EB0AA01" },
    ];
    const erased = db.commit((tx) => {
      tx.derived.enrichments.put({
        family: "messages", item: "3EB0AA01", prompt: "chat-image-v1", input_hash: sha256("input"), reply_key: null,
        reused_from: null, content: "a caption", state: "done",
      });
      tx.derived.extracts.put({
        family: "messages", unit: "chat-a:2026-09-01", reading: digest(["x"]), code: "1", content: ["line"],
        start_ms: T1, end_ms: T1 + DAY, days: ["2026-09-01", "2026-09-02"], seq: 1,
      });
      return tx.records.erase({
        records, items: [{ family: "messages", item: "3EB0AA01" }], units: [{ family: "messages", unit: "chat-a:2026-09-01" }],
        reason: "owner deletion", at_ms: T2,
      });
    });
    expect(erased).toMatchObject({
      records: 2, statements: 2, versions: [id("3EB0AA01", content)], blobs: [blob], enrichments: 1,
      extracts: [{ family: "messages", unit: "chat-a:2026-09-01" }], days: ["2026-09-01", "2026-09-02"],
    });
    for (const record of records) {
      expect(head(record.source, record.key)).toBeUndefined();
      expect(history(record.source, record.key)).toEqual([]);
      const ticked = land(record.source, T3, [{ ...photo, content: { ...content, status: "read" } }]).landed[0]!;
      const again = land(record.source, T4, [photo, gone("3EB0AA01")]).landed[0]!;
      expect(counts(ticked)).toMatchObject({ erased: 1, new: 0 });
      expect(counts(again)).toMatchObject({ erased: 2, new: 0, duplicated: 0 });
      expect(head(record.source, record.key)).toBeUndefined();
    }
    read((view) => {
      expect(() => view.version(id("3EB0AA01", content))).toThrow(MissingVersion);
      expect(view.enrichment("messages", "3EB0AA01", "chat-image-v1")).toBeUndefined();
      expect(view.extract("messages", "chat-a:2026-09-01")).toBeUndefined();
    });
  });

  it("two sources stating identical bytes lose a statement", () => {
    const content = { subject: "Invoice", from: "person-a@example.com" };
    land("mail:person-a@example.com:imap", T1, [msg("<m1@example.com>", content)]);
    land("mail:person-a@example.com:export", T2, [msg("<m1@example.com>", content)]);
    const one = history("mail:person-a@example.com:imap", "<m1@example.com>");
    const two = history("mail:person-a@example.com:export", "<m1@example.com>");
    expect(one).toHaveLength(1);
    expect(two).toHaveLength(1);
    expect(one[0]!.version).toBe(two[0]!.version);
    expect(head("mail:person-a@example.com:export", "<m1@example.com>")).toMatchObject({ stated_ms: T2 });
  });

  it("a second, different row for one record in a delivery lands other than last, or goes uncounted", () => {
    const s = "health:dupes";
    const landed = land(s, T1, [msg("303", { v: 1 }), msg("303", { v: 2 }), msg("305", { v: 1 }), msg("305", { v: 1 })]).landed[0]!;
    expect(counts(landed)).toMatchObject({ new: 2, duplicated: 2 });
    expect(head(s, "303")).toMatchObject({ version: id("303", { v: 2 }) });
    expect(history(s, "303")).toHaveLength(1);
    const sliced = land(s, T2, [msg("400", { v: 1 }), msg("400", { v: 2 })], 2).landed;
    expect(counts(sliced[0]!)).toMatchObject({ new: 1 });
    expect(counts(sliced[1]!)).toMatchObject({ duplicated: 1, changed: 0 });
    expect(head(s, "400")).toMatchObject({ version: id("400", { v: 2 }), stated_ms: T2 });
  });

  it("a row its kind's guard refuses lands anything or goes unnamed", () => {
    const s = "chat:refused";
    const landed = land(s, T1, [
      msg("ok", { v: 1 }),
      msg("array", [1, 2]),
      { kind: "unknown", key: "u", content: {} },
      msg("nan", { v: Number.NaN }),
      msg("", { v: 1 }),
      msg("time", { v: 1 }, { time: { start_ms: 1.5, precision: "ms" } }),
      msg("blob", { v: 1 }, { blobs: ["not-a-hash"] }),
    ]).landed[0]!;
    expect(counts(landed)).toMatchObject({ new: 1, refused: 6 });
    expect(landed.refusals.map((refusal) => refusal.key)).toEqual(["array", "u", "nan", "", "time", "blob"]);
    expect(landed.refusals[0]!.violations).toEqual(["content is not an object"]);
    expect(landed.refusals[2]!.violations[0]).toMatch(/non-finite number NaN at \$\.v/);
    for (const key of ["array", "nan", "time", "blob"]) expect(history(s, key)).toEqual([]);
  });

  const repairSource = "whatsapp:+15550000001:macbook-pro-0001:shifted";
  const shifted = (n: number) => ({ ZTEXT: `message ${n}`, ZMESSAGEDATE: 1_000_000 + n * 60 - 19_800, ZISFROMME: n % 2 });
  const repaired = (n: number) => ({ ...shifted(n), ZMESSAGEDATE: 1_000_000 + n * 60 });
  let repairRun = 0;
  let undoRun = 0;

  it("a repair loses history", () => {
    land(repairSource, T1, [1, 2, 3].map((n) => msg(`k${n}`, shifted(n), { time: { start_ms: n * 60_000, precision: "s" } })));
    const plan = read((view) =>
      view.planRepair({
        source: repairSource,
        fix: (version) => {
          const content = version.content as { ZMESSAGEDATE: number };
          return { content: { ...content, ZMESSAGEDATE: content.ZMESSAGEDATE + 19_800 }, time: { start_ms: version.time!.start_ms + 19_800_000, precision: "s" } };
        },
      }),
    );
    expect(tally(plan.steps).counts).toEqual({ heads: 3, changed: 3, gone: 0, kept: 0, moved: 0, refused: 0 });
    expect(tally(plan.steps).changedPaths).toEqual({ ZMESSAGEDATE: 3 });
    expect(plan.examples[0]).toMatchObject({ before: shifted(1), after: repaired(1) });
    const applied = db.commit((tx) => {
      repairRun = tx.tables.runs.start({ kind: "repair", subject: repairSource, started_ms: T2 });
      return tx.records.applyRepair(repairRun, plan, { has: () => true });
    });
    expect(counts(applied)).toMatchObject({ changed: 3, changedPaths: { ZMESSAGEDATE: 3 } });
    for (const n of [1, 2, 3]) {
      const rows = history(repairSource, `k${n}`);
      expect(rows.map((row) => [row.version, row.origin, row.stated_ms])).toEqual([
        [id(`k${n}`, shifted(n)), "source", T1],
        [id(`k${n}`, repaired(n)), "repair", T1],
      ]);
      expect(head(repairSource, `k${n}`)).toMatchObject({ version: id(`k${n}`, repaired(n)), stated_ms: T1, start_ms: n * 60_000 + 19_800_000 });
    }
    expect(counts(land(repairSource, T1, [msg("k1", shifted(1))]).landed[0]!)).toMatchObject({ replayed: 1 });
    expect(head(repairSource, "k1")).toMatchObject({ version: id("k1", repaired(1)) });
  });

  it("undo or undo-of-undo fails", () => {
    const undo = read((view) => view.planUndo(repairRun));
    expect(tally(undo.steps).counts).toMatchObject({ heads: 3, changed: 3, moved: 0 });
    undoRun = db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "repair", subject: `undo run ${repairRun}`, started_ms: T3 });
      expect(counts(tx.records.applyRepair(run, undo, { has: () => true }))).toMatchObject({ changed: 3, refused: 0 });
      return run;
    });
    for (const n of [1, 2, 3]) expect(head(repairSource, `k${n}`)).toMatchObject({ version: id(`k${n}`, shifted(n)), start_ms: n * 60_000 });
    const redo = read((view) => view.planUndo(undoRun));
    const redoRun = db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "repair", subject: `undo run ${undoRun}`, started_ms: T4 });
      expect(counts(tx.records.applyRepair(run, redo, { has: () => true }))).toMatchObject({ changed: 3, refused: 0 });
      return run;
    });
    for (const n of [1, 2, 3]) {
      expect(head(repairSource, `k${n}`)).toMatchObject({ version: id(`k${n}`, repaired(n)) });
      expect(history(repairSource, `k${n}`).map((row) => row.origin)).toEqual(["source", "repair", "repair", "repair"]);
    }
    const stale = read((view) => view.planUndo(redoRun));
    land(repairSource, T4, [msg("k1", { ZTEXT: "edited" })]);
    db.commit((tx) => {
      const landed = tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: "stale", started_ms: T4 }), stale, { has: () => true });
      expect(counts(landed)).toMatchObject({ changed: 2, refused: 1 });
      expect(landed.refusals[0]).toMatchObject({ key: "k1", violations: ["the head moved since the plan read it"] });
    });
    const imported = land("chat:undo-import", T1, [msg("x", { v: 1 })]).run;
    const plan = read((view) => view.planUndo(imported));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: `undo run ${imported}`, started_ms: T2 }), plan, { has: () => true }));
    expect(head("chat:undo-import", "x")).toMatchObject({ version: "gone" });
  });

  it("a failed commit leaves partial rows", () => {
    const before = canonical(dump() as unknown as Json);
    const runsBefore = read((view) => view.tables.runs.running().length);
    expect(() =>
      db.commit((tx) => {
        const run = tx.tables.runs.start({ kind: "import", subject: "chat:crash", started_ms: T1 });
        tx.records.land(run, { id: "d", source: "chat:crash", stated_ms: T1 }, [msg("a", { v: 1 })], GUARDS, { has: () => true });
        tx.tables.jobs.enqueue({ kind: "render", key: "days", lane: 0, not_before_ms: T1, now_ms: T1 });
        tx.records.land(run, { id: "d", source: "chat:aba", stated_ms: T4 }, [msg("k", { text: "x" })], GUARDS, { has: () => true });
        throw new Error("the process died between two slices");
      }),
    ).toThrow(/died/);
    expect(canonical(dump() as unknown as Json)).toBe(before);
    read((view) => {
      expect(view.tables.jobs.get("render", "days")).toBeUndefined();
      expect(view.tables.runs.running()).toHaveLength(runsBefore);
      expect(view.history({ source: "chat:crash", kind: "msg", key: "a" })).toEqual([]);
    });
  });

  it("a text over 4 KB reads back different from what was landed, or under another id", () => {
    const s = "screen:macbook-pro-0001";
    const tree = { window: "Editor", nodes: Array.from({ length: 400 }, (_, n) => ({ role: "text", value: `line ${n} \u00e9` })) };
    land(s, T1, [{ kind: "msg", key: "frame-1", content: tree }]);
    const { id: expected, text } = versionId("msg", "frame-1", tree);
    expect(Buffer.byteLength(text)).toBeGreaterThan(4096);
    const version = read((view) => view.version(expected));
    expect(version?.text).toBe(text);
    expect(version?.content).toEqual(tree);
    expect(sha256(version!.text)).toBe(expected);
    const raw = new Database(join(dir, "home.db"), { readonly: true });
    try {
      const stored = raw.prepare("SELECT typeof(text) AS type, length(text) AS size FROM versions WHERE id = ?").get(expected) as { type: string; size: number };
      expect(stored.type).toBe("blob");
      expect(stored.size).toBeLessThan(Buffer.byteLength(text) / 4);
    } finally {
      raw.close();
    }
  });

  it("a worker thread's read view sees other than the committed heads", async () => {
    const expected = read((view) => ({ through: view.through, heads: [...view.heads("chat:aba", "msg")] }));
    const seen = await new Promise<{ through: number; heads: Head[] }>((resolve, reject) => {
      const worker = new Worker(new URL("./test/view-worker.ts", import.meta.url), {
        execArgv: ["--import", "tsx"],
        workerData: { handed: openHomeFolder(dir).handOver(), source: "chat:aba", kind: "msg" },
      });
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    expect(seen).toEqual(expected);
  });

  it("the statements and heads differ from the golden", () => {
    const artifact = join(dir, "versions.json");
    const all = dump();
    const text = `${canonical({ heads: all.heads, statements: all.statements } as unknown as Json)}\n`;
    writeFileSync(artifact, text);
    if (process.env.LIFESTREAM_UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, text);
    expect(readFileSync(artifact, "utf8")).toBe(readFileSync(GOLDEN, "utf8"));
  });
});

function counts(landed: Landed): Omit<Landed, "refusals" | "refusedMembers"> {
  const { refusals: _, refusedMembers: _members, ...rest } = landed;
  return rest;
}
