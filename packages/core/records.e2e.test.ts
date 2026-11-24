import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { countMember, GONE, MissingVersion, openHome, openHomeFolder, REFUSED_MEMBERS, tally, versionId, type Guard, type HomeDb, type Json, type Landed, type RepairPlan, type ReaderOutput } from "./index.js";

const T1 = Date.UTC(2026, 8, 1);
const T2 = T1 + 86_400_000;
const T3 = T2 + 86_400_000;
const object: Guard = (content) => (typeof content === "object" && content !== null && !Array.isArray(content) ? [] : ["not an object"]);
const GUARDS = { msg: object, note: object };

describe("records: a statement's identity and a head's place", () => {
  let dir: string;
  let db: HomeDb;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "core-records-"));
    db = openHome(openHomeFolder(dir), "migrate");
  });

  afterAll(() => {
    const view = db.view();
    const everything = { statements: [...view.statements(0)], rereads: view.rereads(0, 1_000) };
    view.close();
    writeFileSync(join(dir, "records.json"), `${JSON.stringify(everything, null, 2)}\n`);
    db.close();
    if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
  });

  function land(source: string, stated_ms: number, rows: ReaderOutput[], slices = 1, has: (blob: string) => boolean = () => true): { run: number; landed: Landed[] } {
    return db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: source, started_ms: stated_ms });
      const size = Math.ceil(rows.length / slices);
      const landed: Landed[] = [];
      for (let at = 0; at < rows.length; at += size) {
        landed.push(tx.records.land(run, { id: `${source}@${stated_ms}`, source, stated_ms }, rows.slice(at, at + size), GUARDS, { has }));
      }
      tx.tables.runs.end(run, { ended_ms: stated_ms, outcome: "ok" });
      return { run, landed };
    });
  }

  const msg = (key: string, content: Json, extra: Partial<ReaderOutput> = {}): ReaderOutput => ({ kind: "msg", key, content, ...extra });
  const id = (key: string, content: Json): string => versionId("msg", key, content).id;
  const read = <T>(work: (view: ReturnType<HomeDb["view"]>) => T): T => {
    const view = db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  };
  const head = (source: string, key: string) => read((view) => view.head({ source, kind: "msg", key }));
  const history = (source: string, key: string) => read((view) => view.history({ source, kind: "msg", key }));

  it("a repair whose fix leaves out the time drops the record's time, or a time-only fix or a throwing fix stops the plan", () => {
    const source = "chat:repair-time";
    const time = { start_ms: 1_000, precision: "s" } as const;
    land(source, T1, [msg("k", { v: "a" }, { time }), msg("n", { v: "a" }, { time }), msg("t", { v: "a" }, { time })]);
    const plan = read((view) => view.planRepair({
      source,
      fix: (head) => head.key === "k" ? { content: { v: "b" } } : head.key === "n" ? { content: { v: "b" }, time: null } : "keep",
    }));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T2 }), plan, { has: () => true }));
    expect(head(source, "k")).toMatchObject({ version: id("k", { v: "b" }), start_ms: 1_000 });
    expect(read((view) => view.version(id("k", { v: "b" })).time)).toEqual(time);
    expect(head(source, "n")).toMatchObject({ version: id("n", { v: "b" }), start_ms: null });
    const refusing = read((view) => view.planRepair({
      source,
      fix: (head) => {
        if (head.key === "k") throw new Error("no rule for this head");
        return head.key === "t" ? { content: head.content, time: { start_ms: 2_000, precision: "s" } } : { content: { v: "c" } };
      },
    }));
    expect(tally(refusing.steps)).toMatchObject({
      counts: { heads: 3, changed: 1, refused: 2, kept: 0 },
      refusals: [
        { key: "k", violations: ["the fix threw: no rule for this head"] },
        { key: "t", violations: ["the fix changes the time and keeps the content; a version's time follows its content"] },
      ],
    });
  });

  it("a head carries another time than its version: a content stated again keeps the time it was first stated with", () => {
    const source = "whatsapp:+15550000001:head-time";
    const instant = (start_ms: number) => ({ time: { start_ms, precision: "s" as const } });
    land(source, T1, [msg("k", { v: "A" }, instant(1_000))]);
    land(source, T2, [msg("k", { v: "B" }, instant(2_000))]);
    land(source, T3, [msg("k", { v: "A" }, instant(3_000))]);
    expect(head(source, "k")).toMatchObject({ version: id("k", { v: "A" }), start_ms: 1_000 });
    const copy = "whatsapp:+15550000001:head-time-copy";
    land(copy, T3, [msg("k", { v: "A" }, instant(4_000))]);
    expect(head(copy, "k")).toMatchObject({ start_ms: 1_000 });
    const { version } = head(copy, "k")!;
    expect(read((view) => view.version(version).time?.start_ms)).toBe(1_000);
  });

  it("a copy of an account that comes after the owner's erasure brings the record back", () => {
    const first = "whatsapp:+15550000002:mac-1";
    land(first, T1, [msg("erased", { v: "A" })]);
    db.commit((tx) => tx.records.erase({ records: [{ source: first, kind: "msg", key: "erased" }], reason: "the owner's", at_ms: T2 }));
    const later = "whatsapp:+15550000002:mac-2";
    const [landed] = land(later, T3, [msg("erased", { v: "A" }), msg("kept", { v: "B" })]).landed;
    expect(landed).toMatchObject({ erased: 1, new: 1 });
    expect(head(later, "erased")).toBeUndefined();
    expect(land("whatsapp:+15550000003:mac-1", T3, [msg("erased", { v: "A" })]).landed[0]).toMatchObject({ erased: 0, new: 1 });
    expect(read((view) => view.erasedUnder(later, "msg", "eras"))).toBe(true);
  });

  it("an erasure misses a day whose files print a unit with no extract (it moved, or went, after the render), or leaves it unmarked", () => {
    const [dayA, dayB] = ["2026-09-01", "2026-09-02"];
    db.commit((tx) => {
      for (const day of [dayA, dayB]) tx.derived.dayUnits.put(day, [{ family: "notes", unit: "unit-printed", reading: "r1", code: "c1", shown: true }]);
    });
    const dirty = () => {
      const raw = new Database(join(dir, "home.db"), { readonly: true });
      try {
        return raw.prepare("SELECT day FROM dirty_days WHERE day IN (?, ?) AND error IS NULL ORDER BY day").pluck().all(dayA, dayB);
      } finally {
        raw.close();
      }
    };
    expect(dirty()).toEqual([]);
    const erased = db.commit((tx) => tx.records.erase({ records: [], units: [{ family: "notes", unit: "unit-printed" }], reason: "the owner's", at_ms: T2 }));
    expect({ days: erased.days, extracts: erased.extracts }).toEqual({ days: [dayA, dayB], extracts: [] });
    expect(dirty()).toEqual([dayA, dayB]);
  });

  it("a repair that moves a record brings back one its owner erased, or overwrites the source's later deletion, or cannot move it again after an undo", () => {
    const source = "chat:move-into";
    const note = (key: string) => read((view) => view.head({ source, kind: "note", key }));
    const apply = (plan: RepairPlan) =>
      db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T3 }), plan, { has: () => true }));
    const toNote = () => read((view) => view.planRepair({ source, kinds: ["msg"], fix: (head) => ({ content: head.content, kind: "note" }) }));
    land(source, T1, [msg("a", { v: "a" }), msg("b", { v: "b" }), msg("c", { v: "c" })]);
    land(source, T2, [{ kind: "note", key: "a", content: { v: "secret" } }, { kind: "note", key: "b", content: { v: "x" } }]);
    db.commit((tx) => tx.records.erase({ records: [{ source, kind: "note", key: "a" }], reason: "the owner's", at_ms: T2 }));
    land(source, T2 + 1_000, [{ kind: "note", key: "b", content: null, gone: true }]);
    const plan = toNote();
    expect(tally(plan.steps)).toMatchObject({ counts: { heads: 3, changed: 1, gone: 1, refused: 1 }, refusals: [{ key: "a", violations: ["the note record is erased"] }] });
    expect(apply(plan)).toMatchObject({ changed: 1, gone: 1, refused: 0 });
    expect(note("a")).toBeUndefined();
    expect(head(source, "a")).toMatchObject({ version: id("a", { v: "a" }) });
    expect(note("b")).toMatchObject({ version: "gone" });
    expect(head(source, "b")).toMatchObject({ version: "gone" });
    expect(note("c")).toMatchObject({ version: versionId("note", "c", { v: "c" }).id });
    const run = read((view) => view.history({ source, kind: "note", key: "c" }).at(-1)!.run);
    const undo = read((view) => view.planUndo(run));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "undo", subject: `run ${run}`, started_ms: T3 }), undo, { has: () => true }));
    expect(note("c")).toMatchObject({ version: "gone" });
    expect(head(source, "c")).toMatchObject({ version: id("c", { v: "c" }) });
    expect(apply(toNote())).toMatchObject({ changed: 1, refused: 0 });
    expect(note("c")).toMatchObject({ version: versionId("note", "c", { v: "c" }).id });
  });

  it("A→B→A in one delivery lands another head depending on its slices, or takes back a move a slice published", () => {
    const rows = [msg("aba", { v: "a" }), msg("aba", { v: "b" }), msg("aba", { v: "a" })];
    const whole = land("chat:one-slice", T1, rows, 1).landed;
    const sliced = land("chat:three-slices", T1, rows, 3);
    const total = (landed: Landed[]) => landed.reduce((sum, each) => ({ new: sum.new + each.new, duplicated: sum.duplicated + each.duplicated }), { new: 0, duplicated: 0 });
    expect(total(sliced.landed)).toEqual(total(whole));
    for (const source of ["chat:one-slice", "chat:three-slices"]) {
      expect(head(source, "aba")).toMatchObject({ version: id("aba", { v: "a" }), stated_ms: T1 });
    }
    expect(history("chat:one-slice", "aba").map((row) => row.version)).toEqual([id("aba", { v: "a" })]);
    const moves = history("chat:three-slices", "aba");
    expect(moves.map((row) => row.version)).toEqual([id("aba", { v: "a" }), id("aba", { v: "b" }), id("aba", { v: "a" })]);
    expect(read((view) => view.version(id("aba", { v: "b" })))).toBeDefined();
    expect(tally(read((view) => view.planUndo(sliced.run)).steps).counts).toMatchObject({ heads: 1, gone: 1 });
  });

  const delivered = (source: string, id: string, slices: ReaderOutput[][], reread: boolean) => db.commit((tx) => {
    const ran = tx.tables.runs.start({ kind: "import", subject: `${source} ${id}`, started_ms: T1 });
    const landed = slices.map((rows) => tx.records.land(ran, { id, source, stated_ms: T1, reread }, rows, GUARDS, { has: () => true }));
    tx.tables.runs.end(ran, { ended_ms: T1, outcome: "ok" });
    return landed.map((each) => [each.duplicated, each.restated, each.late, each.gone]);
  });

  it("a record a landing tells as stated twice in one slice, a deletion or a refusal told, or a record a slice states not told, whatever case it lands as", () => {
    const source = "chat:stated";
    const told: string[][] = [];
    const slice = (run: number, rows: ReaderOutput[], reread = false) => {
      const each: string[] = [];
      db.commit((tx) => tx.records.land(run, { id: "S", source, stated_ms: T1, reread }, rows, GUARDS, { has: () => true }, (record) => void each.push(`${record.key} ${record.time?.start_ms ?? "-"}`)));
      told.push(each);
    };
    const time = { start_ms: 1_000, precision: "s" } as const;
    const first = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} S`, started_ms: T1 }));
    slice(first, [msg("k", { v: 1 }, { time }), msg("k", { v: 1 }, { time }), msg("j", { v: 1 })]);
    slice(first, [msg("j", { v: 1 }), msg("m", { v: 1 }), { kind: "msg", key: "n", content: null, gone: true }, msg("r", [1])]);
    slice(first, [msg("k", { v: 1 }, { time }), msg("j", { v: 1 }), msg("m", { v: 1 })]);
    const again = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${source} S`, started_ms: T2 }));
    slice(again, [msg("k", { v: 1 }, { time }), msg("j", { v: 1 }), msg("m", { v: 2 })], true);
    expect(told).toEqual([["k 1000", "j -"], ["j -", "m -"], ["k 1000", "j -", "m -"], ["k 1000", "j -", "m -"]]);
  });

  it("a re-read's later row loses the tie to its delivery's own earlier row, stated by an earlier run, or wins one over another delivery's", () => {
    const source = "chat:reread-tie";
    const run = (id: string, slices: ReaderOutput[][], reread: boolean) => delivered(source, id, slices, reread);
    run("D", [[msg("k", { v: 1 })]], false);
    run("E", [[msg("j", { v: 1 })]], false);
    const again = run("D", [[msg("k", { v: 1 }), msg("j", { v: 2 })], [{ kind: "msg", key: "k", content: null, gone: true }]], true);
    expect(again).toEqual([[1, 0, 1, 0], [1, 0, 0, 0]]);
    expect([head(source, "k")?.version, head(source, "j")?.version]).toEqual(["gone", id("j", { v: 1 })]);
  });

  it("a re-read's row an earlier read of its delivery stated exactly, or any live row over its deletion, takes that deletion back", () => {
    const source = "chat:reread-replay";
    delivered(source, "D", [[msg("k", { v: 1 })], [{ kind: "msg", key: "k", content: null, gone: true }]], false);
    expect(head(source, "k")?.version).toBe("gone");
    expect(delivered(source, "D", [[msg("k", { v: 1 })]], true)).toEqual([[1, 0, 0, 0]]);
    expect(head(source, "k")?.version).toBe("gone");
    expect(history(source, "k").map((row) => row.version)).toEqual([id("k", { v: 1 }), "gone"]);
    delivered(source, "F", [[msg("f", { v: 1 }), { kind: "msg", key: "f", content: null, gone: true }]], false);
    expect(delivered(source, "F", [[msg("f", { v: 1 })]], true)).toEqual([[1, 0, 0, 0]]);
    expect([head(source, "f")?.version, history(source, "f").map((row) => row.version)]).toEqual(["gone", ["gone"]]);
  });

  it("a re-read takes a head another delivery returned to its delivery's version, or loses a later row to another delivery's same statement", () => {
    const source = "chat:reread-owner";
    delivered(source, "D", [[msg("k", { v: 1 })]], false);
    delivered(source, "E", [[msg("k", { v: 2 })], [msg("k", { v: 1 })]], false);
    expect(delivered(source, "D", [[msg("k", { v: 3 })]], true)).toEqual([[0, 0, 1, 0]]);
    expect(head(source, "k")?.version).toBe(id("k", { v: 1 }));
    delivered(source, "E", [[msg("j", { v: 2 })]], false);
    delivered(source, "D", [[msg("j", { v: 1 })]], false);
    expect(delivered(source, "D", [[msg("j", { v: 1 })], [msg("j", { v: 2 })]], true)).toEqual([[1, 0, 0, 0], [1, 0, 0, 0]]);
    expect(head(source, "j")?.version).toBe(id("j", { v: 2 }));
  });

  it("a re-read's live row its delivery's deletion holds back drops the blob links it carries, or stores a version no statement names", () => {
    const source = "chat:reread-links";
    const photo = `sha256:${"cd".repeat(32)}`;
    delivered(source, "D", [[msg("k", { v: 1 })], [{ kind: "msg", key: "k", content: null, gone: true }]], false);
    expect(delivered(source, "D", [[msg("k", { v: 1 }, { blobs: [photo] })]], true)).toEqual([[1, 0, 0, 0]]);
    expect([head(source, "k")?.version, read((view) => view.blobsOf(id("k", { v: 1 })))]).toEqual(["gone", [photo]]);
    delivered(source, "F", [[msg("f", { v: 1 }), { kind: "msg", key: "f", content: null, gone: true }]], false);
    expect(delivered(source, "F", [[msg("f", { v: 1 }, { blobs: [photo] })]], true)).toEqual([[1, 0, 0, 0]]);
    expect([head(source, "f")?.version, read((view) => view.blobsOf(id("f", { v: 1 })))]).toEqual(["gone", []]);
    read((view) => expect(() => view.version(id("f", { v: 1 }))).toThrow(MissingVersion));
  });

  it("undo of a run puts back a record a later run returned to the run's own version", () => {
    const source = "chat:undo-aba";
    const first = land(source, T1, [msg("k", { v: "a" })]).run;
    land(source, T2, [msg("k", { v: "b" })]);
    land(source, T3, [msg("k", { v: "a" })]);
    const plan = read((view) => view.planUndo(first));
    expect(tally(plan.steps).counts).toMatchObject({ heads: 1, moved: 1, gone: 0 });
    expect(plan.steps.filter((step) => "fix" in step)).toEqual([]);
  });

  it("a repair planned before an A→B→A lands over it", () => {
    const source = "chat:repair-aba";
    land(source, T1, [msg("k", { v: "a" })]);
    const plan = read((view) => view.planRepair({ source, fix: () => ({ content: { v: "fixed" } }) }));
    land(source, T2, [msg("k", { v: "b" })]);
    land(source, T3, [msg("k", { v: "a" })]);
    const applied = db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T3 }), plan, { has: () => true }));
    expect(applied).toMatchObject({ refused: 1, changed: 0 });
    expect(head(source, "k")).toMatchObject({ version: id("k", { v: "a" }) });
    const fresh = read((view) => view.planRepair({ source, fix: () => ({ content: { v: "fixed" } }) }));
    land(source, T3 + 1_000, [msg("k", { v: "a" })]);
    expect(db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T3 }), fresh, { has: () => true }))).toMatchObject({ changed: 1 });
  });

  it("a restatement that brings new blob links drops them", () => {
    const source = "chat:links";
    const video = `sha256:${"ab".repeat(32)}`;
    const content = { v: "frame", video: "path-1" };
    const version = id("k", content);
    land(source, T1, [msg("k", content)]);
    const before = read((view) => view.rereads(0, 1_000).length);
    expect(land(source, T2, [msg("k", content, { blobs: [video] })]).landed[0]).toMatchObject({ restated: 1 });
    expect(read((view) => view.blobsOf(version))).toEqual([video]);
    expect(read((view) => view.rereads(0, 1_000).slice(before))).toEqual([{ seq: expect.any(Number), record: { source, kind: "msg", key: "k" } }]);
    land(source, T3, [msg("k", content, { blobs: [video] })]);
    expect(read((view) => view.rereads(0, 1_000).length)).toBe(before + 1);
    const other = `sha256:${"ef".repeat(32)}`;
    land(source, T3 + 1_000, [msg("k", { v: "other" })]);
    land(source, T3 + 2_000, [msg("k", content, { blobs: [video, other] })]);
    expect(read((view) => view.blobsOf(version))).toEqual([video, other].sort());
  });

  it("the read of the heads that link a blob misses one past a page, one whose links came with a restatement, or hands back one that links none or is gone", () => {
    const source = "chat:linked";
    const blob = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
    const rows = Array.from({ length: 1_200 }, (_, n) => msg(`m${String(n).padStart(4, "0")}`, { n }, n % 100 === 0 ? { blobs: n === 700 ? [blob(n), blob(1)] : [blob(n)] } : {}));
    rows.push(...Array.from({ length: 600 }, (_, n) => msg(`p${String(n).padStart(4, "0")}`, { p: n }, { blobs: [blob(10_000 + n)] })));
    land(source, T1, rows);
    land(source, T2, [msg("m0001", { n: 1 }, { blobs: [blob(2)] }), { kind: "msg", key: "m0100", content: null, gone: true }]);
    const linked = read((view) => [...view.linked(source, "msg")].map(({ head, blobs }) => [head.key, blobs]));
    const expected = [
      ...Array.from({ length: 12 }, (_, at) => at * 100).filter((n) => n !== 100).map((n) => [`m${String(n).padStart(4, "0")}`, n === 700 ? [blob(1), blob(700)] : [blob(n)]]),
      ["m0001", [blob(2)]],
      ...Array.from({ length: 600 }, (_, n) => [`p${String(n).padStart(4, "0")}`, [blob(10_000 + n)]]),
    ].sort(([left], [right]) => ((left as string) < (right as string) ? -1 : 1));
    expect(linked).toEqual(expected);
    expect(read((view) => [...view.linked(source, "msg", "p0597")].map(({ head }) => head.key))).toEqual(["p0598", "p0599"]);
  });

  it("a record that named a blob the store lacked is never read again once the blob is stored", () => {
    const source = "chat:wanted";
    const blob = `sha256:${"cd".repeat(32)}`;
    land(source, T1, [msg("k", { v: "a", blob }, { blobs: [blob] }), msg("other", { v: "b" })], 1, () => false);
    const before = read((view) => view.rereads(0, 1_000).length);
    expect(db.commit((tx) => tx.records.blobsArrived([blob], {}))).toBe(1);
    const reread = read((view) => view.rereads(0, 1_000).slice(before));
    expect(reread).toEqual([{ seq: expect.any(Number), record: { source, kind: "msg", key: "k" } }]);
    expect(db.commit((tx) => tx.records.blobsArrived([blob], {}))).toBe(0);
  });

  const wanted = (source: string) => {
    const raw = new Database(join(dir, "home.db"), { readonly: true });
    try {
      return raw.prepare("SELECT key || ' ' || blob FROM wanted_blobs WHERE source = ? ORDER BY 1").pluck().all(source);
    } finally {
      raw.close();
    }
  };
  const file = (n: number) => `sha256:${String(n).padStart(64, "0")}`;
  const lacks = () => false;

  it("a record still wants a file its head no longer names: moved past it, gone, repaired away, or named by a late row; or a file that arrives for an old version reads its record again", () => {
    const source = "chat:wants";
    const wants = () => wanted(source);
    land(source, T1, [msg("a", { v: 1 }, { blobs: [file(1)] }), msg("b", { v: 1 }, { blobs: [file(2)] }), msg("c", { v: 1 }, { blobs: [file(3)] }), msg("d", { v: 1 })], 1, lacks);
    expect(wants()).toEqual([`a ${file(1)}`, `b ${file(2)}`, `c ${file(3)}`]);
    land(source, T2, [msg("a", { v: 2 }, { blobs: [file(4)] }), { kind: "msg", key: "b", content: null, gone: true }, msg("c", { v: 2 }, { blobs: [file(3)] })], 1, lacks);
    expect(land(source, T1 - 1_000, [msg("d", { v: 0 }, { blobs: [file(5)] })], 1, lacks).landed[0]).toMatchObject({ late: 1 });
    expect(wants()).toEqual([`a ${file(4)}`, `c ${file(3)}`]);
    const plan = read((view) => view.planRepair({ source, fix: (at) => at.key === "a" ? { content: { v: 3 } } : at.key === "c" ? GONE : "keep" }));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T3 }), plan, { has: lacks }));
    expect(wants()).toEqual([`a ${file(4)}`]);
    const before = read((view) => view.rereads(0, 1_000).length);
    expect(db.commit((tx) => tx.records.blobsArrived([file(1), file(2), file(3), file(5)], {}))).toBe(0);
    expect(read((view) => view.rereads(0, 1_000).length)).toBe(before);
    expect(["a", "b", "c", "d"].map((key) => head(source, key)?.version)).toEqual([id("a", { v: 3 }), "gone", "gone", id("d", { v: 1 })]);
    expect(db.commit((tx) => tx.records.blobsArrived([file(4)], {}))).toBe(1);
  });

  it("a file a device said it cleared stays lost once it arrives, once no record of its source wants it (moved past, its kind forgotten, erased), or is claimed by a later claim; or one a record still wants leaves", () => {
    const source = "chat:lost";
    const lost = () => {
      const raw = new Database(join(dir, "home.db"), { readonly: true });
      try {
        return raw.prepare("SELECT blob || ' ' || claim FROM lost_files WHERE source = ? ORDER BY 1").pluck().all(source);
      } finally {
        raw.close();
      }
    };
    const claim = (id: string, run: number, sealed_ms: number) => db.commit((tx) => {
      tx.tables.deliveries.add({ id, source, sealed_ms, stated_ms: sealed_ms, facts: {}, lost: [{ items: 1, what: "synthetic files" }] });
      tx.tables.deliveries.move(id, source, { move: "land", run, refused: 0, error: null, code: "sha256:code-1" });
    });
    const { run: first } = land(source, T1, [
      msg("a", { lost: 1 }, { blobs: [file(21)] }), msg("b", { lost: 1 }, { blobs: [file(22)] }), msg("c", { lost: 1 }, { blobs: [file(23)] }),
      msg("g", { lost: 1 }, { blobs: [file(26)] }), msg("h", { lost: 1 }, { blobs: [file(26)] }), { kind: "note", key: "n", content: { lost: 1 }, blobs: [file(24)] },
      msg("o", { lost: 1 }, { blobs: [file(29)] }),
    ], 1, (blob) => blob === file(29));
    claim(`${source}/a`, first, T1);
    expect(lost()).toEqual([21, 22, 23, 24, 26].map((n) => `${file(n)} ${source}/a`));
    const { run: second } = land(source, T2, [msg("e", { lost: 2 }, { blobs: [file(21), file(25)] })], 1, lacks);
    claim(`${source}/b`, second, T2);
    expect(lost()).toEqual([...[21, 22, 23, 24, 26].map((n) => `${file(n)} ${source}/a`), `${file(25)} ${source}/b`].sort());
    db.commit((tx) => tx.records.blobsArrived([file(21)], {}));
    land(source, T3, [msg("b", { lost: 3 }), msg("g", { lost: 3 })], 1, lacks);
    db.commit((tx) => tx.records.forget({ sources: [{ source, kinds: ["note"] }] }));
    db.commit((tx) => tx.records.erase({ records: [{ source, kind: "msg", key: "c" }], reason: "the owner's", at_ms: T3 }));
    expect(lost()).toEqual([`${file(25)} ${source}/b`, `${file(26)} ${source}/a`]);
  });

  it("a file a loss claim's run named is lost again when an undo puts back the version that wants it", () => {
    const source = "chat:lost-back";
    const lost = () => {
      const raw = new Database(join(dir, "home.db"), { readonly: true });
      try {
        return raw.prepare("SELECT blob || ' ' || claim FROM lost_files WHERE source = ? ORDER BY 1").pluck().all(source);
      } finally {
        raw.close();
      }
    };
    const { run: first } = land(source, T1, [msg("m", { lostBack: 1 }, { blobs: [file(31)] })], 1, lacks);
    db.commit((tx) => {
      tx.tables.deliveries.add({ id: `${source}/a`, source, sealed_ms: T1, stated_ms: T1, facts: {}, lost: [{ items: 1, what: "synthetic files" }] });
      tx.tables.deliveries.move(`${source}/a`, source, { move: "land", run: first, refused: 0, error: null, code: "sha256:code-1" });
    });
    expect(lost()).toEqual([`${file(31)} ${source}/a`]);
    const { run: second } = land(source, T2, [msg("m", { lostBack: 2 })], 1, lacks);
    expect(lost()).toEqual([]);
    const undo = read((view) => view.planUndo(second));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "undo", subject: `run ${second}`, started_ms: T3 }), undo, { has: lacks }));
    expect(wanted(source)).toEqual([`m ${file(31)}`]);
    expect(lost()).toEqual([`${file(31)} ${source}/a`]);
  });

  it("a record an undo moves back to a version naming a file still missing, or a repair moves to one, wants nothing, so the file's arrival reads it no more", () => {
    const source = "chat:wants-back";
    land(source, T1, [msg("k", { back: 1 }, { blobs: [file(11)] }), msg("j", { back: 1 })], 1, lacks);
    const { run: second } = land(source, T2, [msg("k", { back: 2 })], 1, lacks);
    expect(wanted(source)).toEqual([]);
    const undo = read((view) => view.planUndo(second));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "undo", subject: `run ${second}`, started_ms: T3 }), undo, { has: lacks }));
    expect(head(source, "k")?.version).toBe(id("k", { back: 1 }));
    const plan = read((view) => view.planRepair({ source, fix: (at) => at.key === "j" ? { content: { back: 2 }, blobs: [file(12)] } : "keep" }));
    db.commit((tx) => tx.records.applyRepair(tx.tables.runs.start({ kind: "repair", subject: source, started_ms: T3 }), plan, { has: lacks }));
    expect(wanted(source)).toEqual([`j ${file(12)}`, `k ${file(11)}`]);
    const before = read((view) => view.rereads(0, 1_000).length);
    expect(db.commit((tx) => tx.records.blobsArrived([file(11), file(12)], {}))).toBe(2);
    expect(read((view) => view.rereads(0, 1_000).slice(before).map((each) => "record" in each ? each.record : null))).toEqual([{ source, kind: "msg", key: "k" }, { source, kind: "msg", key: "j" }]);
    expect(wanted(source)).toEqual([]);
  });

  it("a refusal counted by a member its key or locator only looks like, or lost past the bound, or a member the read keeps lost in a later landing, or a name the map holds specially, or a row refused for its key throwing", () => {
    const refused = (key: string, member?: string): ReaderOutput => ({ kind: "file", key, content: null, refused: "synthetic", ...(member === undefined ? {} : { member }) });
    const rows: ReaderOutput[] = [
      ...Array.from({ length: 12 }, (_, index) => refused(`Family:one.vcf:byte ${index}`, "Family:one.vcf")),
      refused("Family:two.vcf", "Family:two.vcf"),
      refused("Calendar [work].ics[3]", "Calendar [work].ics"),
      { kind: "msg", key: 7 as unknown as string, content: {} },
      msg("refused-by-guard", "not an object"),
    ];
    const [named] = land("members", T1, rows).landed;
    expect([named!.refused, named!.refusals.length, named!.refusedMembers]).toEqual([16, 10, new Map([["Family:one.vcf", 12], ["Family:two.vcf", 1], ["Calendar [work].ics", 1]])]);
    const [whole] = land("bounded", T1, Array.from({ length: 501 }, (_, index) => refused(`a${index}`, `a${index}`))).landed;
    const read: Pick<Landed, "refusedMembers"> = {};
    for (const [member, count] of whole!.refusedMembers!) countMember(read, member, count);
    expect([whole!.refused, whole!.refusedMembers!.size, read.refusedMembers!.size, read.refusedMembers!.has("a499"), read.refusedMembers!.has("a500")]).toEqual([501, 501, REFUSED_MEMBERS, true, false]);
    const [later] = land("bounded", T2, [...Array.from({ length: 500 }, (_, index) => refused(`b${index}`, `b${index}`)), refused("a0 again", "a0")]).landed;
    for (const [member, count] of later!.refusedMembers!) countMember(read, member, count);
    expect([read.refusedMembers!.get("a0"), read.refusedMembers!.size, read.refusedMembers!.has("b0")]).toEqual([2, REFUSED_MEMBERS, false]);
    const [special] = land("special", T1, [refused("__proto__", "__proto__"), refused("__proto__ again", "__proto__")]).landed;
    const ofSpecial: Pick<Landed, "refusedMembers"> = {};
    for (const [member, count] of special!.refusedMembers!) countMember(ofSpecial, member, count);
    expect([...ofSpecial.refusedMembers!]).toEqual([["__proto__", 2]]);
  });

  it("a commit's read-through cursors or appended event kinds not noted, or noted in a commit that read none (a reread passed, a clock moved)", () => {
    const noted = db.commit((tx) => {
      tx.tables.cursors.move("extract:labels", { seq: 1, at_ms: T3 });
      tx.tables.events.append({ at_ms: T3, kind: "places", key: "places", detail: { position: "1:1" } });
      return { cursors: [...tx.moved.cursors], events: [...tx.moved.events] };
    });
    expect(noted).toEqual({ cursors: ["extract:labels"], events: ["places"] });
    const started = db.commit((tx) => {
      tx.tables.cursors.reset("extract:notes", null, T3);
      return [...tx.moved.cursors];
    });
    expect(started).toEqual(["extract:notes"]);
    const passed = db.commit((tx) => {
      tx.tables.cursors.move("extract:labels", { reread: 5, at_ms: T3 });
      tx.tables.cursors.move("read:labels:synthetic", { at_ms: T3 });
      return [...tx.moved.cursors];
    });
    expect(passed).toEqual([]);
    expect(db.commit((tx) => ({ cursors: [...tx.moved.cursors], events: [...tx.moved.events] }))).toEqual({ cursors: [], events: [] });
  });
});
