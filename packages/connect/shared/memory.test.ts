import { CURSOR_BYTES, type JsonObject, type MemoryChanges } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { NeedsYou, NotYet, type Acquirer, type Fetched, type Lent } from "../seams.js";
import { LENT, lending, memorySecrets, NO_MEMORY, openTestHome, poll, type PollRecord } from "../test/drive.js";
import { byBytes, callMemory, cursorText, LIST_LIMIT, type Remembered } from "./memory.js";

function committed(parts: Record<string, Record<string, string>>): Remembered & { asked: number } {
  const reader = {
    asked: 0,
    get: (part: string, key: string) => parts[part]?.[key],
    after: (part: string, after: string | null, limit: number) => {
      reader.asked += 1;
      return Object.entries(parts[part] ?? {}).filter(([key]) => after === null || byBytes(key, after) > 0).sort(([a], [b]) => byBytes(a, b)).slice(0, limit);
    },
  };
  return reader;
}

const NONE: MemoryChanges = { cleared: [], entries: [] };

describe("a call's memory", () => {
  it("reads its own puts, and lists nothing it dropped or cleared", () => {
    const memory = callMemory(committed({ seen: { a: "1", b: "2", c: "3" }, owed: { x: "true" } }));
    memory.put("seen", "d", { at: 4 });
    memory.drop("seen", "b");
    memory.clear("owed");
    expect(memory.get("seen", "d")).toEqual({ at: 4 });
    expect(memory.get("seen", "a")).toBe(1);
    expect(memory.get("seen", "b")).toBeUndefined();
    expect(memory.get("owed", "x")).toBeUndefined();
    expect(memory.list("seen")).toEqual([["a", 1], ["c", 3], ["d", { at: 4 }]]);
    expect(memory.list("owed")).toEqual([]);
    memory.put("owed", "y", 1);
    expect(memory.list("owed")).toEqual([["y", 1]]);
  });

  it("keeps a value as it was put, and hands each read its own copy", () => {
    const memory = callMemory(null);
    const value = { ids: [1, 2] };
    memory.put("seen", "a", value);
    value.ids.push(3);
    const read = memory.get("seen", "a") as { ids: number[] };
    read.ids.push(4);
    expect(memory.get("seen", "a")).toEqual({ ids: [1, 2] });
    expect(() => memory.put("seen", "b", { at: Number.NaN })).toThrow();
  });

  it("lists by UTF-8 bytes, as the table orders, where UTF-16 would not", () => {
    const wide = "\u{ff5e}";
    const astral = "\u{1f600}";
    expect(wide < astral).toBe(false);
    const memory = callMemory(committed({ seen: { [astral]: "1", b: "2" } }));
    memory.put("seen", wide, 3);
    memory.put("seen", "a", 4);
    expect(memory.list("seen").map(([key]) => key)).toEqual(["a", "b", wide, astral]);
    expect(memory.list("seen", "b", 1).map(([key]) => key)).toEqual([wide]);
    expect(memory.list("seen", wide).map(([key]) => key)).toEqual([astral]);
  });

  it("orders every pair of keys as their UTF-8 bytes compare", () => {
    const keys = ["", "a", "ab", "b", "Z", "é", "\u{7ff}", "\u{800}", "\u{d7ff}", "\u{e000}", "\u{ff5e}", "\u{ffff}", "\u{10000}", "\u{1f600}", "\u{1f600}a", "\u{10ffff}", "a\u{1f600}", "a\u{ffff}"];
    const sign = (n: number) => Math.sign(n);
    const differ = keys.flatMap((a) => keys.filter((b) => sign(byBytes(a, b)) !== sign(Buffer.compare(Buffer.from(a), Buffer.from(b)))).map((b) => [a, b]));
    expect(differ).toEqual([]);
  });

  it("pages past what it dropped, and answers at most 1,000", () => {
    const seen: Record<string, string> = {};
    for (let n = 0; n < 2_500; n += 1) seen[`k${String(n).padStart(5, "0")}`] = String(n);
    const reader = committed({ seen });
    const memory = callMemory(reader);
    for (let n = 0; n < 1_200; n += 1) memory.drop("seen", `k${String(n).padStart(5, "0")}`);
    const first = memory.list("seen", undefined, 5_000);
    expect([first.length, first[0]?.[0], first.at(-1)?.[0]]).toEqual([LIST_LIMIT, "k01200", "k02199"]);
    expect(memory.list("seen", "k02199").map(([key]) => key)).toEqual(Object.keys(seen).slice(2_200));
    expect(memory.list("seen", undefined, 2).map(([key]) => key)).toEqual(["k01200", "k01201"]);
    expect(() => memory.list("seen", undefined, 0)).toThrow(RangeError);
  });

  it("gives one change a key, its clears first, each against what was committed", () => {
    const memory = callMemory(committed({ seen: { a: "1", b: "2" }, media: { m: "true" } }));
    memory.put("seen", "a", 5);
    memory.put("seen", "a", 6);
    memory.put("seen", "b", 2);
    memory.put("seen", "n", 1);
    memory.drop("seen", "n");
    memory.drop("seen", "absent");
    memory.put("media", "early", true);
    memory.clear("media");
    memory.put("media", "late", true);
    memory.clear("empty");
    expect(memory.end()).toEqual({ cleared: ["media"], entries: [["media", "late", "true"], ["seen", "a", "6"]] });
  });

  it("changes nothing where a call puts back what was committed", () => {
    const memory = callMemory(committed({ seen: { a: '{"at":1,"title":"x"}' } }));
    memory.put("seen", "a", { title: "x", at: 1 });
    memory.drop("seen", "gone");
    expect(memory.end()).toEqual(NONE);
  });

  it("puts back what it cleared, and drops a cleared key once", () => {
    const memory = callMemory(committed({ seen: { a: "1", b: "2" } }));
    memory.clear("seen");
    memory.put("seen", "a", 1);
    memory.drop("seen", "b");
    expect(memory.end()).toEqual({ cleared: ["seen"], entries: [["seen", "a", "1"]] });
  });

  it("refuses a read or change after its call ended, and a key no table keeps", () => {
    const memory = callMemory(null);
    expect(() => memory.put("seen", "\ud800", 1)).toThrow(TypeError);
    expect(() => memory.put("", "a", 1)).toThrow(TypeError);
    memory.end();
    expect(() => memory.put("seen", "a", 1)).toThrow(/ended/u);
    expect(() => memory.get("seen", "a")).toThrow(/ended/u);
  });

  it("reads home.db's entries in the order it lists them", () => {
    const home = openTestHome();
    const keys = ["b", "a", "\u{ff5e}", "\u{1f600}", "é", "Z", "a0"];
    home.db.commit((tx) => tx.tables.polls.leave("acq", { source: "test:x", state: "{}", start_ms: null, changes: { cleared: [], entries: keys.map((key) => ["seen", key, "1"] as const) } }));
    const view = home.db.view();
    try {
      const table: Remembered = {
        get: (part, key) => view.tables.polls.remembered("acq", part, key),
        after: (part, after, limit) => view.tables.polls.rememberedAfter("acq", part, after, limit),
      };
      const fromTable = callMemory(table).list("seen").map(([key]) => key);
      const overlay = callMemory(null);
      for (const key of keys) overlay.put("seen", key, 1);
      expect(overlay.list("seen").map(([key]) => key)).toEqual(fromTable);
      expect(callMemory(table).list("seen", "a", 2).map(([key]) => key)).toEqual(fromTable.slice(fromTable.indexOf("a") + 1, fromTable.indexOf("a") + 3));
    } finally {
      view.close();
    }
  });
});

describe("a cursor's bound", () => {
  it("takes 16,384 bytes of canonical JSON and refuses one more", () => {
    const at = { pad: "x".repeat(CURSOR_BYTES - '{"pad":""}'.length) };
    expect(Buffer.byteLength(cursorText(at))).toBe(CURSOR_BYTES);
    expect(() => cursorText({ pad: `${at.pad}x` })).toThrow(/16385 bytes, over its bound of 16384.*poll's memory/u);
    expect(() => cursorText({ pad: "é".repeat(CURSOR_BYTES / 2) })).toThrow(/over its bound/u);
  });
});

function scripted(calls: ((state: JsonObject | null, lent: Lent) => Fetched | never)[]): Acquirer {
  let n = 0;
  return {
    name: "scripted",
    source: "test:scripted",
    fetch: async (state, _secrets, lent) => calls[n++]!(state, lent),
  };
}

const AT = { fetched_at: "2026-11-13T10:00:00Z" };
const file = (path: string) => ({ path, bytes: Buffer.from(path) });

describe("the driver's poll", () => {
  it("commits a call's changes with its cursor, and hands the next call what it left", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: null, deliveries: [] };
    let handed: unknown;
    const acquirer = scripted([
      (_, lent) => {
        lent.memory.put("seen", "c1", 1);
        lent.memory.put("seen", "c2", 2);
        return { files: [file("c1.json"), file("c2.json")], facts: AT, state: { since_ms: 2 } };
      },
      (state, lent) => {
        handed = [state, lent.memory.list("seen")];
        lent.memory.put("seen", "c1", 1);
        return { files: [], facts: AT, state: { since_ms: 2 } };
      },
    ]);
    expect(await poll(home, acquirer, record, memorySecrets({}), 0)).toBeDefined();
    expect([record.state, record.changes, record.memory]).toEqual([
      { since_ms: 2 }, { cleared: [], entries: [["seen", "c1", "1"], ["seen", "c2", "2"]] }, new Map([["seen", new Map([["c1", "1"], ["c2", "2"]])]]),
    ]);
    expect(await poll(home, acquirer, record, memorySecrets({}), 0)).toBeUndefined();
    expect(handed).toEqual([{ since_ms: 2 }, [["c1", 1], ["c2", 2]]]);
    expect(record.changes).toEqual(NONE);
  });

  it("commits a wait's changes with the cursor it carries, and drops them with none", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: { since_ms: 1 }, deliveries: [] };
    const acquirer = scripted([
      (_, lent) => {
        lent.memory.put("bytes", "2026-11-13", 500);
        throw new NotYet("offline", "the network went", { state: { since_ms: 1, listed: 3 } });
      },
      (_, lent) => {
        lent.memory.put("seen", "c9", 9);
        throw new NotYet("chrome", "Chrome restarted");
      },
      (_, lent) => {
        lent.memory.put("seen", "c9", 9);
        throw new NeedsYou("signed-out", "sign in again");
      },
      (_, lent) => {
        lent.memory.put("seen", "c9", 9);
        throw new Error("the provider answered 500");
      },
    ]);
    await expect(poll(home, acquirer, record, memorySecrets({}), 0)).rejects.toThrow(NotYet);
    expect([record.state, record.changes]).toEqual([{ since_ms: 1, listed: 3 }, { cleared: [], entries: [["bytes", "2026-11-13", "500"]] }]);
    for (const thrown of [NotYet, NeedsYou, Error]) {
      await expect(poll(home, acquirer, record, memorySecrets({}), 0)).rejects.toThrow(thrown);
      expect([record.state, record.changes, record.memory]).toEqual([{ since_ms: 1, listed: 3 }, NONE, new Map([["bytes", new Map([["2026-11-13", "500"]])]])]);
    }
    expect(record.deliveries).toEqual([]);
  });

  it("fails a call whose cursor is over its bound before anything is sealed", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: { since_ms: 1 }, deliveries: [] };
    const grown = { since_ms: 2, seen: Object.fromEntries(Array.from({ length: 2_000 }, (_, n) => [`conversation-${n}`, n])) };
    const acquirer = scripted([
      (_, lent) => {
        lent.memory.put("seen", "c1", 1);
        return { files: [file("c1.json")], facts: AT, state: grown };
      },
      () => {
        throw new NotYet("offline", "the network went", { state: grown });
      },
    ]);
    await expect(poll(home, acquirer, record, memorySecrets({}), 0)).rejects.toThrow(/over its bound of 16384/u);
    await expect(poll(home, acquirer, record, memorySecrets({}), 0)).rejects.toThrow(/over its bound of 16384/u);
    expect([record.state, record.memory, record.deliveries]).toEqual([{ since_ms: 1 }, undefined, []]);
  });

  it("hands a cursor of no fields as none, as the first call's, with the memory the call before left", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: null, deliveries: [] };
    const handed: (JsonObject | null)[] = [];
    const acquirer = scripted([
      (state, lent) => {
        handed.push(state);
        lent.memory.put("seen", "c1", 1);
        return { files: [], facts: AT, state: {} };
      },
      (state, lent) => {
        handed.push(state);
        expect(lent.memory.get("seen", "c1")).toBe(1);
        return { files: [], facts: AT, state: {} };
      },
    ]);
    await poll(home, acquirer, record, memorySecrets({}), 0);
    await poll(home, acquirer, record, memorySecrets({}), 0);
    expect(handed).toEqual([null, null]);
  });

  it("hands the call the cursor parsed from the text it kept, never the object the last call returned", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: null, deliveries: [] };
    const returned: JsonObject = { since_ms: 1 };
    const acquirer = scripted([() => ({ files: [], facts: AT, state: returned })]);
    await poll(home, acquirer, record, memorySecrets({}), 0);
    returned.since_ms = 99;
    expect(record.state).toEqual({ since_ms: 1 });
  });

  it("lends the poll's memory through `lending`, and none where a test calls the acquirer itself", async () => {
    const home = openTestHome();
    const record: PollRecord = { state: null, deliveries: [] };
    const acquirer = lending(scripted([
      (_, lent) => {
        lent.memory.put("seen", "c1", 1);
        return { files: [], facts: AT, state: {} };
      },
      (_, lent) => {
        lent.memory.put("seen", "c2", 2);
        return { files: [], facts: AT, state: {} };
      },
    ]), null);
    await poll(home, acquirer, record, memorySecrets({}), 0);
    expect(record.memory?.get("seen")?.get("c1")).toBe("1");
    expect(LENT.memory).toBe(NO_MEMORY);
    await expect(acquirer.fetch(null, memorySecrets({}), LENT)).rejects.toThrow(/lends no poll memory.*`poll`/u);
  });
});
