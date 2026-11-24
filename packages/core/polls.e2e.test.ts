import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CURSOR_BYTES, openHome, openHomeFolder, type HomeDb, type MemoryChanges } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "core-polls-"));
const found: Record<string, unknown> = {};
afterAll(() => {
  writeFileSync(join(tmpdir(), "core-polls.json"), `${JSON.stringify(found, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

let files = 0;
function fresh(): HomeDb {
  return openHome(openHomeFolder(mkdtempSync(join(dir, `home-${files++}-`))), "migrate");
}
const none: MemoryChanges = { cleared: [], entries: [] };
const A = "poll-a";
const SOURCE = "provider:person-a@example.com:cloud";

describe("a poll's clocks, cursor and memory", () => {
  it("a clock written rewrites the cursor, the start it was left under or the memory, or a read of the clocks carries the cursor", () => {
    const db = fresh();
    db.commit((tx) => {
      tx.tables.polls.put({ acquirer: A, next_ms: 1 });
      tx.tables.polls.leave(A, { source: SOURCE, state: '{"since_ms":5}', start_ms: 1_767_225_600_000, changes: { cleared: [], entries: [["seen", "c1", "7"]] } });
      tx.tables.polls.put({ acquirer: A, next_ms: 2, paged_ms: 3, pages: true });
    });
    const read = db.view();
    expect(read.tables.polls.get(A)).toEqual({ acquirer: A, next_ms: 2, paged_ms: 3, page_next_ms: null, held_ms: null, pages: true });
    expect(read.tables.polls.cursor(A)).toEqual({ source: SOURCE, state: '{"since_ms":5}', start_ms: 1_767_225_600_000 });
    expect(read.tables.polls.remembered(A, "seen", "c1")).toBe("7");
    read.close();
    db.commit((tx) => tx.tables.polls.delete(A));
    const parked = db.view();
    expect(parked.tables.polls.get(A)).toBeUndefined();
    expect(parked.tables.polls.cursor(A)).toEqual({ source: SOURCE, state: '{"since_ms":5}', start_ms: 1_767_225_600_000 });
    expect(parked.tables.polls.remembered(A, "seen", "c1")).toBe("7");
    expect(parked.tables.polls.holding()).toEqual([A]);
    parked.close();
    db.close();
  });

  it("a cursor of 16,385 bytes is written, or a refused one leaves a change of its call behind; text no JSON parses is altered", () => {
    const db = fresh();
    const atBound = `"${"é".repeat(CURSOR_BYTES / 2 - 1)}"`;
    expect(Buffer.byteLength(atBound)).toBe(CURSOR_BYTES);
    db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: atBound, start_ms: null, changes: { cleared: [], entries: [["seen", "c1", "1"]] } }));
    const over = `${atBound} `;
    expect(over.length).toBeLessThan(CURSOR_BYTES);
    expect(() => db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: over, start_ms: null, changes: { cleared: ["seen"], entries: [["seen", "c2", "2"]] } })))
      .toThrow(/CHECK constraint failed/u);
    const read = db.view();
    expect(read.tables.polls.cursor(A)?.state).toBe(atBound);
    expect(read.tables.polls.rememberedAfter(A, "seen", null, 10)).toEqual([["c1", "1"]]);
    read.close();
    db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: "not json {", start_ms: null, changes: none }));
    const poisoned = db.view();
    expect(poisoned.tables.polls.cursor(A)).toEqual({ source: SOURCE, state: "not json {", start_ms: null });
    expect(poisoned.tables.polls.remembered(A, "seen", "c1")).toBe("1");
    poisoned.close();
    db.close();
  });

  it("`leave` with another stamp keeps an entry of the old one, or with the same stamp loses one it did not change; a clear lands after a put", () => {
    const db = fresh();
    expect(db.commit((tx) => tx.tables.polls.leave(A, {
      source: SOURCE, state: "{}", start_ms: null,
      changes: { cleared: [], entries: [["seen", "c1", "1"], ["seen", "c2", "2"], ["owed", "c3", "3"], ["media", "m1", "true"]] },
    }))).toBe(4);
    expect(db.commit((tx) => tx.tables.polls.leave(A, {
      source: SOURCE, state: '{"n":1}', start_ms: null,
      changes: { cleared: ["owed"], entries: [["owed", "c4", "4"], ["seen", "c2", null], ["seen", "c1", "10"]] },
    }))).toBe(4);
    expect(db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: '{"n":1}', start_ms: null, changes: { cleared: ["owed"], entries: [["seen", "gone", null]] } }))).toBe(1);
    db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: '{"n":1}', start_ms: null, changes: { cleared: [], entries: [["owed", "c4", "4"]] } }));
    const same = db.view();
    expect(same.tables.polls.rememberedAfter(A, "seen", null, 10)).toEqual([["c1", "10"]]);
    expect(same.tables.polls.rememberedAfter(A, "owed", null, 10)).toEqual([["c4", "4"]]);
    expect(same.tables.polls.remembered(A, "media", "m1")).toBe("true");
    same.close();
    const other = "provider:person-b@example.com:cloud";
    expect(db.commit((tx) => tx.tables.polls.leave(A, { source: other, state: "{}", start_ms: null, changes: { cleared: [], entries: [["seen", "d1", "1"]] } }))).toBe(4);
    const read = db.view();
    expect(read.tables.polls.cursor(A)).toEqual({ source: other, state: "{}", start_ms: null });
    expect(read.tables.polls.remembered(A, "seen", "c1")).toBeUndefined();
    expect(read.tables.polls.remembered(A, "media", "m1")).toBeUndefined();
    expect(read.tables.polls.remembered(A, "owed", "c4")).toBeUndefined();
    expect(read.tables.polls.rememberedAfter(A, "seen", null, 10)).toEqual([["d1", "1"]]);
    read.close();
    db.close();
  });

  it("`rememberedAfter` pages out of the bytes' order when a key holds a character outside ASCII, or skips or repeats a key", () => {
    const db = fresh();
    const keys = ["b", "a", "Z", "é", "～", "\u{1F600}", "a\u0000z", "ä", "ab", ""];
    db.commit((tx) => tx.tables.polls.leave(A, { source: SOURCE, state: "{}", start_ms: null, changes: { cleared: [], entries: keys.map((key, at) => ["seen", key, String(at)] as const) } }));
    const bytes = [...keys].sort((x, y) => Buffer.compare(Buffer.from(x), Buffer.from(y)));
    expect(bytes.indexOf("～")).toBeLessThan(bytes.indexOf("\u{1F600}"));
    const read = db.view();
    const paged: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = read.tables.polls.rememberedAfter(A, "seen", after, 3);
      if (page.length === 0) break;
      for (const [key, value] of page) {
        expect(value).toBe(String(keys.indexOf(key)));
        paged.push(key);
      }
      after = page.at(-1)![0];
    }
    read.close();
    expect(paged).toEqual(bytes);
    found.paged = paged.map((key) => Buffer.from(key).toString("hex"));
    db.close();
  });

  it("`forget` leaves a poll's clocks, cursor or an entry, or takes another poll's; `holding` names one with no cursor", () => {
    const db = fresh();
    const B = "poll-b";
    db.commit((tx) => {
      for (const acquirer of [A, B]) {
        tx.tables.polls.put({ acquirer, next_ms: 1 });
        tx.tables.polls.leave(acquirer, { source: SOURCE, state: "{}", start_ms: null, changes: { cleared: [], entries: [["seen", "c1", "1"]] } });
      }
      tx.tables.polls.put({ acquirer: "poll-clocks-only", next_ms: 1 });
    });
    const before = db.view();
    expect(before.tables.polls.holding()).toEqual([A, B]);
    before.close();
    db.commit((tx) => tx.tables.polls.forget(A));
    const read = db.view();
    expect(read.tables.polls.get(A)).toBeUndefined();
    expect(read.tables.polls.cursor(A)).toBeUndefined();
    expect(read.tables.polls.remembered(A, "seen", "c1")).toBeUndefined();
    expect(read.tables.polls.holding()).toEqual([B]);
    expect(read.tables.polls.get(B)).toBeDefined();
    expect(read.tables.polls.remembered(B, "seen", "c1")).toBe("1");
    expect(read.tables.polls.list().map((row) => row.acquirer)).toEqual([B, "poll-clocks-only"]);
    read.close();
    db.close();
  });
});
