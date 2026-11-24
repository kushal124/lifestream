import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { digest, openHome, openHomeFolder, openMemo, type Memo } from "./index.js";

const dir = mkdtempSync(join(tmpdir(), "core-memo-"));
const found: Record<string, unknown> = {};
let files = 0;

afterAll(() => {
  writeFileSync(join(tmpdir(), "core-memo.json"), `${JSON.stringify(found, null, 2)}\n`);
  rmSync(dir, { recursive: true, force: true });
});

const fresh = (): string => join(dir, `memo-${++files}`, "memo.db");

function ask<T>(memo: Memo, space: string, keys: readonly string[], value: (key: string) => T | undefined): { made: string[]; answer: Record<string, T> } {
  const made: string[] = [];
  const answer = memo.values(space, keys, (key) => {
    made.push(key);
    return value(key);
  });
  return { made, answer: Object.fromEntries(answer) };
}

function within<T>(path: string, version: string, work: (memo: Memo) => T): T {
  const memo = openMemo(openHomeFolder(dirname(path)), path, version);
  try {
    return work(memo);
  } finally {
    memo.close();
  }
}

const doc = (key: string) => ({ key, words: `synthetic value of ${key}`, list: [1, 2, { b: true, a: null }] });

describe("the memo", () => {
  it("a value outliving its version, in the space asked or any other", () => {
    const path = fresh();
    const v1 = within(path, "v1", (memo) => [ask(memo, "chat", ["a", "b"], doc), ask(memo, "mail", ["x"], doc)]);
    const again = within(path, "v1", (memo) => [ask(memo, "chat", ["a", "b"], doc).made, ask(memo, "mail", ["x"], doc).made]);
    const v2 = within(path, "v2", (memo) => [ask(memo, "chat", ["a", "b"], doc).made, ask(memo, "mail", ["x"], doc).made]);
    const back = within(path, "v1", (memo) => [ask(memo, "chat", ["a", "b"], doc).made, ask(memo, "mail", ["x"], doc).made]);
    found.version = { v1: v1.map((call) => call.made), again, v2, back };
    expect(found.version).toEqual({
      v1: [["a", "b"], ["x"]],
      again: [[], []],
      v2: [["a", "b"], ["x"]],
      back: [["a", "b"], ["x"]],
    });
  });

  it("an unasked key surviving the call that did not ask it", () => {
    const calls = within(fresh(), "v1", (memo) => [
      ask(memo, "s", ["a", "b", "c"], doc).made,
      ask(memo, "s", ["a"], doc).made,
      ask(memo, "s", ["a", "b", "c"], doc).made,
      ask(memo, "s", [], doc).made,
      ask(memo, "s", ["a"], doc).made,
    ]);
    found.unasked = calls;
    expect(calls).toEqual([["a", "b", "c"], [], ["b", "c"], [], ["a"]]);
  });

  it("a throwing make leaving half its writes, or a value that is not JSON kept", () => {
    const boom = new Error("synthetic failure in make");
    const result = within(fresh(), "v1", (memo) => {
      const first = ask(memo, "s", ["kept", "other"], doc).made;
      expect(() => memo.values("s", ["kept", "b", "c", "d"], (key) => {
        if (key === "d") throw boom;
        return doc(key);
      })).toThrow(boom);
      expect(() => memo.values("s", ["kept", "e"], (key) => ({ key, at: new Date(0) }))).toThrow(/not a JSON value/u);
      return { first, after: ask(memo, "s", ["kept", "other", "b", "c", "e"], doc).made };
    });
    found.throwing = result;
    expect(result).toEqual({ first: ["kept", "other"], after: ["b", "c", "e"] });
  });

  it("undefined kept or answered, and null not kept", () => {
    const value = (key: string) => (key === "none" ? undefined : key === "null" ? null : doc(key));
    const calls = within(fresh(), "v1", (memo) => [ask(memo, "s", ["none", "null", "a"], value), ask(memo, "s", ["none", "null", "a"], value)]);
    found.undefined = calls;
    expect(calls).toEqual([
      { made: ["none", "null", "a"], answer: { null: null, a: doc("a") } },
      { made: ["none"], answer: { null: null, a: doc("a") } },
    ]);
  });

  it("a corrupt file refusing to open, or a damaged page failing every call after", () => {
    const garbage = fresh();
    within(garbage, "v1", () => undefined);
    writeFileSync(garbage, "this is not a database\n".repeat(200));
    const notDb = [within(garbage, "v1", (memo) => ask(memo, "s", ["a", "b"], doc).made), within(garbage, "v1", (memo) => ask(memo, "s", ["a", "b"], doc).made)];

    const damaged = fresh();
    const keys = Array.from({ length: 200 }, (_, n) => `key-${n}`);
    within(damaged, "v1", (memo) => ask(memo, "s", keys, doc));
    expect(existsSync(`${damaged}-wal`)).toBe(false);
    const page = readFileSync(damaged).readUInt16BE(16);
    const size = statSync(damaged).size;
    expect(size).toBeGreaterThan(4 * page);
    const fd = openSync(damaged, "r+");
    try {
      writeSync(fd, Buffer.alloc(size - 2 * page, 0xa5), 0, size - 2 * page, 2 * page);
    } finally {
      closeSync(fd);
    }
    const { broken, next } = within(damaged, "v1", (memo) => ({ broken: ask(memo, "s", keys, doc), next: ask(memo, "s", keys, doc).made }));
    const after = within(damaged, "v1", (memo) => ask(memo, "s", keys, doc).made);

    found.corrupt = { notDb, damaged: { made: broken.made.length, answered: Object.keys(broken.answer).length, next, after } };
    expect(notDb).toEqual([["a", "b"], []]);
    expect(found.corrupt).toMatchObject({ damaged: { made: 200, answered: 200, next: [], after: [] } });
    expect(broken.answer["key-7"]).toEqual(doc("key-7"));
  });

  it("two opens of one file in turn seeing other values, or a hit making again", () => {
    const path = fresh();
    expect(existsSync(join(path, ".."))).toBe(false);
    const value = (key: string) => ({ z: key, a: [3, 2, 1], m: { y: "é", x: -0.5 } });
    const first = within(path, "v1", (memo) => ask(memo, "s-1", ["a", "b", "a"], value));
    const second = within(path, "v1", (memo) => ask(memo, "s-1", ["b", "a"], () => {
      throw new Error("a hit made again");
    }));
    found.reopen = { first, second };
    expect(first.made).toEqual(["a", "b"]);
    expect(second).toEqual({ made: [], answer: first.answer });
    expect(Object.keys(second.answer)).toEqual(["b", "a"]);
  });

  it("a space name that is not letters, digits and `-` taken", () => {
    const path = fresh();
    within(path, "v1", (memo) => ask(memo, "s", ["a"], doc));
    const refused = within(path, "v1", (memo) => ["", "a b", "s.t", "é", "meta", 'x"; DROP TABLE meta; --', "space:s"].map((space) => {
      try {
        memo.values(space, [], doc);
        return { space, refused: false };
      } catch (error) {
        return { space, refused: (error as Error).message.startsWith("a memo space is named in letters, digits and") };
      }
    }));
    const after = within(path, "v1", (memo) => ask(memo, "s", ["a"], doc).made);
    found.spaces = { refused, after };
    expect(refused.filter((one) => !one.refused).map((one) => one.space)).toEqual(["meta"]);
    expect(after).toEqual([]);
  });

  it("the keys of a family's extracts listed out of order, cut at a page's end, or read from their content", () => {
    const path = join(dir, "home.db");
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    const units = Array.from({ length: 600 }, (_, n) => `chat-${String(n).padStart(4, "0")}:2026-09-01`);
    const row = (family: string, unit: string, code: string) => ({
      family, unit, reading: digest([unit]), code, content: ["synthetic line"], start_ms: null, end_ms: null, days: ["2026-09-01"], seq: 1,
    });
    db.commit((tx) => {
      for (const unit of [...units].reverse()) tx.derived.extracts.put(row("messages", unit, "4"));
      for (const unit of ["thread-a", "thread-b"]) tx.derived.extracts.put(row("mail", unit, "2"));
    });
    const view = db.view();
    const messages = [...view.extractReadings("messages")];
    const mail = [...view.extractReadings("mail")];
    const prefixed = [...view.extractReadings("messages", "chat-059")];
    view.close();
    db.close();
    const raw = new Database(path, { readonly: true });
    const plan = raw.prepare("EXPLAIN QUERY PLAN SELECT unit, reading, code FROM extracts WHERE family = ? AND unit > ? ORDER BY unit LIMIT ?")
      .all("messages", "", 512).map((step) => (step as { detail: string }).detail);
    raw.close();
    found.readings = { messages: messages.length, first: messages[0], last: messages.at(-1), mail, prefixed: prefixed.length, plan };
    expect(prefixed.map((each) => each.unit)).toEqual(units.filter((unit) => unit.startsWith("chat-059")));
    expect(messages).toEqual(units.map((unit) => ({ unit, reading: digest([unit]), code: "4" })));
    expect(mail).toEqual([{ unit: "thread-a", reading: digest(["thread-a"]), code: "2" }, { unit: "thread-b", reading: digest(["thread-b"]), code: "2" }]);
    expect(plan).toEqual([expect.stringContaining("USING COVERING INDEX extracts_reading")]);
  });
});
