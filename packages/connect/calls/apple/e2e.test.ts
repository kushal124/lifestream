import { artifact, collect, counts, deliver, expectParity, macBundle, openTestHome, temp } from "../../test/drive.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { callHistory, CALLHISTORY_FILE } from "./reader.js";
import { appendCalls, baseCalls, CALLS_SOURCE, createCallHistory, MACOS_15_LACKS, OLDER_LACKS, T0, PHONE_A, PHONE_B, sealDelta } from "./test/fixture.js";

const GOLDEN = new URL("./test/parity.golden.json", import.meta.url);
const SNAPSHOT = { snapshot_taken_at: "2026-09-21T00:00:00.000Z" };

function store(dir: string, name = "store.sqlite", calls = baseCalls(), without: readonly string[] = []): string {
  const path = join(dir, name);
  createCallHistory(path, calls, { without });
  return path;
}

function leftOut(content: Record<string, unknown>, columns: readonly string[], members: readonly string[]): Record<string, unknown> {
  const call = Object.fromEntries(Object.entries(content.call as Record<string, unknown>).filter(([column]) => !columns.includes(column)));
  return { ...Object.fromEntries(Object.entries(content).filter(([member]) => !members.includes(member))), call };
}

describe("Mac call history: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected, from either generation of the store", async () => {
    const home = openTestHome();
    try {
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 3, refused: 0, duplicated: 0 });
      const heads = home.heads(CALLS_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["SYNTH-CALL-0001", Date.parse("2026-09-20T08:00:00.250Z"), Date.parse("2026-09-20T08:01:01.750Z")],
        ["SYNTH-CALL-0002", Date.parse("2026-09-20T08:10:00Z"), null],
        ["SYNTH-CALL-0003", Date.parse("2026-09-20T08:20:00Z"), Date.parse("2026-09-20T08:25:00Z")],
      ]);
      const older = openTestHome();
      try {
        const path = store(older.dir, "older.sqlite", baseCalls(), OLDER_LACKS);
        const olderLanded = await older.land(callHistory, deliver(older.blobs, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(path) }, SNAPSHOT));
        expect(olderLanded).toMatchObject({ new: 3, refused: 0 });
        const call = (older.heads(CALLS_SOURCE)[0]!.content as { call: Record<string, unknown> }).call;
        expect("ZORIGINATINGUITYPE" in call || "ZORIGINATINGDEVICENAME" in call).toBe(false);
      } finally {
        older.close();
      }
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a store without ZINITIATOR (macOS 15) is refused, or a call read from it states an initiator or differs otherwise from the same store with it", async () => {
    const home = openTestHome();
    try {
      const path = store(home.dir, "uninitiated.sqlite");
      const db = new Database(path);
      db.exec("DROP INDEX ZCALLRECORD_ZINITIATOR_INDEX; ALTER TABLE ZCALLRECORD DROP COLUMN ZINITIATOR");
      db.close();
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(path) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 3, refused: 0 });
      const without = home.heads(CALLS_SOURCE).map((head) => head.content as Record<string, unknown>);
      expect(without.map((content) => "initiator" in content)).toEqual([false, false, false]);
      const whole = await collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir, "initiated.sqlite")) }, SNAPSHOT), home.blobs));
      expect(whole.map((row) => (row.content as Record<string, unknown>).initiator)).toEqual([
        { ZTYPE: 2, ZNORMALIZEDVALUE: PHONE_A, ZVALUE: PHONE_A }, { ZTYPE: 2, ZNORMALIZEDVALUE: PHONE_B, ZVALUE: PHONE_B }, null,
      ]);
      expect(without).toEqual(whole.map((row) => Object.fromEntries(Object.entries(row.content as Record<string, unknown>).filter(([member]) => member !== "initiator"))));
      artifact(home.dir, "uninitiated.json", { landed, heads: home.heads(CALLS_SOURCE) });
    } finally {
      home.close();
    }
  });

  it("a store missing columns macOS 15 lacks, or any but a call's identity, is refused, or a call read from it states them or differs otherwise from the whole store's", async () => {
    const home = openTestHome();
    try {
      const whole = await collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir, "whole.sqlite")) }, SNAPSHOT), home.blobs));
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir, "macos15.sqlite", baseCalls(), MACOS_15_LACKS)) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 3, refused: 0 });
      const heads = home.heads(CALLS_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual(whole.map((row) => [row.key, row.time?.start_ms, row.time?.end_ms ?? null]));
      expect(heads.map((head) => head.content)).toEqual(whole.map((row) => leftOut(row.content as Record<string, unknown>, MACOS_15_LACKS, ["initiator"])));
      const read = async (name: string, change: string) => {
        const path = store(home.dir, name);
        const db = new Database(path);
        db.exec(change);
        db.close();
        return collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(path) }, SNAPSHOT), home.blobs));
      };
      const half = await read("half.sqlite", "ALTER TABLE ZCALLRECORD DROP COLUMN ZORIGINATINGUITYPE");
      expect(half.map((row) => row.content)).toEqual(whole.map((row) => leftOut(row.content as Record<string, unknown>, ["ZORIGINATINGUITYPE"], [])));
      const sparse = await read("sparse.sqlite", "DROP TABLE ZEMERGENCYMEDIAITEM; ALTER TABLE ZHANDLE DROP COLUMN ZNORMALIZEDVALUE");
      expect(sparse.map((row) => row.refused)).toEqual([undefined, undefined, undefined]);
      expect(sparse.map((row) => "emergency_media" in (row.content as Record<string, unknown>))).toEqual([false, false, false]);
      expect((sparse[2]!.content as { handles: unknown[] }).handles).toEqual([
        { ZTYPE: 2, ZVALUE: PHONE_B }, { ZTYPE: 3, ZVALUE: "person-b@example.com" },
      ]);
      await expect(read("anonymous.sqlite", "DROP INDEX Z_CallRecord_UNIQUE_unique_id; ALTER TABLE ZCALLRECORD DROP COLUMN ZUNIQUE_ID"))
        .rejects.toThrow(/the store ZCALLRECORD lacks columns this connector reads: ZUNIQUE_ID/u);
      artifact(home.dir, "macos15.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a call whose date is unset (0 or NULL) is refused or placed on a made-up time, or a date that is text lands", async () => {
    const home = openTestHome();
    try {
      const calls = [
        ...baseCalls().map((call) => (call.pk === 2 ? { ...call, date: 0 } : call.pk === 3 ? { ...call, override: { ZDATE: null } } : call)),
        { pk: 4, uniqueId: "SYNTH-CALL-0004", date: T0, handles: [{ value: PHONE_A }], override: { ZDATE: "yesterday" } },
      ];
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir, "unset.sqlite", calls)) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 3, refused: 1 });
      expect(landed.refusals).toEqual([{ kind: "file", key: "ZCALLRECORD Z_PK 4", violations: ["ZCALLRECORD row 4 ZDATE is not a number"] }]);
      const heads = home.heads(CALLS_SOURCE);
      expect(heads.map((head) => [head.key, head.start_ms, head.end_ms])).toEqual([
        ["SYNTH-CALL-0001", Date.parse("2026-09-20T08:00:00.250Z"), Date.parse("2026-09-20T08:01:01.750Z")],
        ["SYNTH-CALL-0002", null, null],
        ["SYNTH-CALL-0003", null, null],
      ]);
      artifact(home.dir, "unset-date.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const rows = await collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT), home.blobs));
      expect(rows.every((row) => row.device === "macbook-pro-0001" && /^ZCALLRECORD row \d+$/u.test(row.locator ?? ""))).toBe(true);
      artifact(home.dir, "parity.json", expectParity(rows, GOLDEN));
    } finally {
      home.close();
    }
  });

  it("a smaller snapshot lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(store(home.dir)) }, SNAPSHOT));
      const smaller = store(home.dir, "smaller.sqlite", baseCalls().slice(1));
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(smaller) }, { snapshot_taken_at: "2026-09-22T00:00:00.000Z" }));
      expect(landed).toMatchObject({ restated: 2, gone: 0, new: 0 });
      expect(home.heads(CALLS_SOURCE).map((head) => head.version === "gone")).toEqual([false, false, false]);
      artifact(home.dir, "heads.json", home.heads(CALLS_SOURCE));
    } finally {
      home.close();
    }
  });

  it("a changes delivery is read as less than it holds, or an older Mac's delta is not read", async () => {
    const home = openTestHome();
    try {
      const changes = macBundle(home, CALLS_SOURCE, new URL("./test/changes-bundle.zip", import.meta.url));
      expect(changes.facts.kind).toBe("changes");
      const path = join(home.dir, "changes.sqlite");
      writeFileSync(path, home.blobs.bytes(changes.files.find((file) => file.path === CALLHISTORY_FILE)!.blob));
      const db = new Database(path, { readonly: true });
      const held = Number((db.prepare("SELECT count(*) AS n FROM ZCALLRECORD").get() as { n: number }).n);
      db.close();
      const fromChanges = await home.land(callHistory, changes);
      expect(fromChanges).toMatchObject({ new: held, refused: 0 });

      const store = join(home.dir, "older.sqlite");
      createCallHistory(store, baseCalls());
      appendCalls(store, [{ pk: 4, uniqueId: "SYNTH-CALL-0004", date: T0 + 3600, duration: 5, handles: [{ value: PHONE_A }] }]);
      const deltaPath = join(home.dir, "delta.sqlite");
      sealDelta(store, deltaPath, 3);
      const facts = { snapshot_taken_at: "2026-09-21T01:00:00.000Z", kind: "delta", after: 3, through: 4 };
      const rows = await collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(deltaPath) }, facts), home.blobs));
      expect(rows.map((row) => row.key)).toEqual(["SYNTH-CALL-0004"]);
      artifact(home.dir, "changes.json", { changes: counts(fromChanges), delta: rows.length });
    } finally {
      home.close();
    }
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const home = openTestHome();
    try {
      const path = store(home.dir);
      const db = new Database(path);
      db.exec("DROP INDEX Z_CallRecord_UNIQUE_unique_id");
      db.close();
      appendCalls(path, [{ pk: 9, uniqueId: "SYNTH-CALL-0001", date: T0 + 9, duration: 2 }]);
      const landed = await home.land(callHistory, deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(path) }, SNAPSHOT));
      expect(landed).toMatchObject({ new: 3, duplicated: 1 });
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a column macOS adds stops the source or changes a call, a known column it drops is stated, or a call naming a handle the store lacks lands", async () => {
    const home = openTestHome();
    try {
      const calls = async (name: string, change?: string) => {
        const path = store(home.dir, name);
        if (change !== undefined) {
          const db = new Database(path);
          db.exec(change);
          db.close();
        }
        return collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(path) }, SNAPSHOT), home.blobs));
      };
      expect(await calls("drifted.sqlite", "ALTER TABLE ZCALLRECORD ADD COLUMN ZSYNTHETICNEWCOLUMN INTEGER")).toEqual(await calls("plain.sqlite"));
      expect((await calls("dropped.sqlite", "ALTER TABLE ZCALLRECORD DROP COLUMN ZNAME")).map((row) => row.content))
        .toEqual((await calls("named.sqlite")).map((row) => leftOut(row.content as Record<string, unknown>, ["ZNAME"], [])));
      const dangling = store(home.dir, "dangling.sqlite");
      const edit = new Database(dangling);
      edit.exec("DELETE FROM ZHANDLE WHERE Z_PK = 1");
      edit.close();
      const read = await collect(callHistory.read(deliver(home, CALLS_SOURCE, { [CALLHISTORY_FILE]: readFileSync(dangling) }, SNAPSHOT), home.blobs));
      expect(read.filter((row) => row.refused !== undefined).map((row) => `${row.key}: ${row.refused}`)).toEqual([
        "ZCALLRECORD Z_PK 1: ZCALLRECORD row 1 ZINITIATOR names handle 1, which the store does not hold",
      ]);
      expect(read.filter((row) => row.refused === undefined).map((row) => row.key)).toEqual((await calls("whole.sqlite")).map((row) => row.key).filter((key) => key !== "SYNTH-CALL-0001"));
    } finally {
      home.close();
    }
  });
});
