import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, readTables } from "./index.js";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const A = "whatsapp:+15550000001:macbook-pro-0001";
const B = "imessage:person-a@example.com:macbook-pro-0001";

describe("what a consumer still owes", () => {
  const dirs: string[] = [];
  const artifact: Record<string, unknown> = {};
  afterAll(() => {
    for (const dir of dirs) {
      writeFileSync(join(dir, "owed.json"), `${JSON.stringify(artifact, null, 2)}\n`);
      if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") rmSync(dir, { recursive: true, force: true });
    }
  });

  const home = (): { path: string; raw: Database.Database } => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-owed-"));
    dirs.push(dir);
    const path = join(dir, "home.db");
    openHome(openHomeFolder(dirname(path)), "migrate").close();
    return { path, raw: new Database(path) };
  };

  const planned = <T>(path: string, read: (tables: ReturnType<typeof readTables>) => T, args: readonly unknown[]): { answer: T; plans: string[] } => {
    const db = new Database(path, { readonly: true });
    try {
      const prepared: string[] = [];
      const seen = new Proxy(db, {
        get(target, name) {
          if (name === "prepare") return (text: string) => (prepared.push(text), target.prepare(text));
          const value = Reflect.get(target, name, target) as unknown;
          return typeof value === "function" ? (value as (...each: unknown[]) => unknown).bind(target) : value;
        },
      });
      const answer = read(readTables(seen));
      const plans = prepared.map((text) => (db.prepare(`EXPLAIN QUERY PLAN ${text}`).all(...args) as { detail: string }[]).map((row) => row.detail).join("; "));
      return { answer, plans };
    } finally {
      db.close();
    }
  };

  it("reads the latest end of a family's units owed their first plan, a woken, a set-aside or another family's unit not among them, by one seek", () => {
    const { path, raw } = home();
    const owed = (units: { family?: string; unit: string; end_ms: number | null; woken?: 1; error?: string }[]) => {
      raw.exec("DELETE FROM dirty_units");
      for (const each of units) {
        raw.prepare("INSERT INTO dirty_units (family, unit, end_ms, woken, error) VALUES (?, ?, ?, ?, ?)")
          .run(each.family ?? "messages", each.unit, each.end_ms, each.woken ?? 0, each.error ?? null);
      }
      return planned(path, (tables) => tables.dirty.newestOwed("messages"), ["messages"]);
    };
    const none = owed([]);
    const woken = owed([{ unit: "u1", end_ms: NOW, woken: 1 }, { unit: "u2", end_ms: NOW - 20 * 86_400_000 }]);
    const endless = owed([{ unit: "u1", end_ms: null }, { unit: "u2", end_ms: NOW }]);
    const aside = owed([{ unit: "u1", end_ms: NOW, error: "synthetic plan error" }, { family: "mail", unit: "m1", end_ms: NOW }]);
    raw.close();
    expect([none.answer, woken.answer, endless.answer, aside.answer]).toEqual([undefined, NOW - 20 * 86_400_000, Number.MAX_SAFE_INTEGER, undefined]);
    expect(woken.plans).toHaveLength(1);
    expect(woken.plans[0]).toMatch(/^SEARCH dirty_units USING (?:COVERING )?INDEX dirty_units_urgency \(family=\? AND woken=\?\)$/u);
    artifact.newestOwed = { answers: [none.answer, woken.answer, endless.answer, aside.answer], plans: woken.plans };
  });

  it("says whether a source states a kind past a cursor: never at it, of another kind or of another source; by one seek", () => {
    const { path, raw } = home();
    const state = (source: string, kind: string, key: string) => (raw.prepare(
      "INSERT INTO statements (source, kind, key, version, stated_ms, run, origin, late) VALUES (?, ?, ?, ?, ?, 1, 'source', 0)",
    ).run(source, kind, key, `sha256:${key}`, NOW).lastInsertRowid as number);
    const first = state(A, "msg", "m1");
    state(A, "chat", "c1");
    state(B, "msg", "i1");
    raw.close();
    const past = (source: string, kind: string, seq: number) => planned(path, (tables) => tables.statements.after(source, kind, seq), [source, kind, seq]);
    const answers = [past(A, "msg", 0), past(A, "msg", first), past(A, "pushname", 0), past(B, "msg", first)];
    expect(answers.map((each) => each.answer)).toEqual([true, false, false, true]);
    expect(answers[0]!.plans).toHaveLength(1);
    expect(answers[0]!.plans[0]).toMatch(/^SEARCH statements USING (?:COVERING )?INDEX statements_source \(source=\? AND kind=\? AND seq>\?\)$/u);
    artifact.statementsAfter = { answers: answers.map((each) => each.answer), plans: answers[0]!.plans };
  });
});
