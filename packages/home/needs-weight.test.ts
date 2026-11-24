import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { DISMISSED, listed, stampOf } from "./connectors.js";
import type { Raised } from "./streams-report.js";

const raised = (id: string, state: Raised["state"], given: Partial<Raised> = {}): Raised =>
  ({ id, state, reason: null, words: id, since_ms: null, next_ms: null, acts: [], detail: null, connector: null, copy: null, unit: null, at: null, ...given });

const metaDb = (kept: Readonly<Record<string, string>> = {}) => {
  const db = new Database(":memory:");
  onTestFinished(() => {
    db.close();
  });
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  for (const [id, stamp] of Object.entries(kept)) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(`${DISMISSED}${id}`, stamp);
  return db;
};

describe("a need's weight", () => {
  it("is stopped when something is not kept now and advice otherwise; the banner's is the home's own stop; banner, then stopped, then advice", () => {
    const needs = listed(null,
      [raised("encrypt", "needs-you"), raised("signed-out", "needs-you", { connector: "whoop" })],
      [raised("room:mac-0001", "broken", { unit: "mac-0001" }), raised("failing", "broken", { connector: "gmail" })],
      [raised("disk:full", "broken")]);
    expect(needs.map(({ id, weight, banner }) => [id, weight, banner])).toEqual([
      ["disk:full", "stopped", true],
      ["room:mac-0001", "stopped", false],
      ["failing", "stopped", false],
      ["encrypt", "advice", false],
      ["signed-out", "advice", false],
    ]);
  });

  it("weighs files Lifestream couldn't read as advice: nothing stops being kept, so the person may dismiss it", () => {
    const lost = raised("lost:google-takeout:person-a@example.com:export", "broken", { reason: "missing-file", connector: "google-takeout", copy: "google-takeout:person-a@example.com:export", since_ms: 1_000 });
    const failing = raised("failing", "broken", { reason: "failing", connector: "gmail" });
    const db = metaDb({ [lost.id]: stampOf(lost), failing: stampOf(failing) });
    expect(listed(db, [lost, failing]).map(({ id, weight, banner, dismissed }) => [id, weight, banner, dismissed])).toEqual([
      ["failing", "stopped", false, false],
      [lost.id, "advice", false, true],
    ]);
  });

  it("keeps an advice dismissed while its stamp stands, never a stopped one, and shows it again when it gets worse or comes back", () => {
    const low = raised("room:mac-0001", "needs-you", { unit: "mac-0001", since_ms: 1_000 });
    const full = { ...low, state: "broken" as const, since_ms: 2_000 };
    const lowAgain = { ...low, since_ms: 3_000 };
    const db = metaDb({ [low.id]: stampOf(low), "disk:full": stampOf(raised("disk:full", "broken")) });
    expect([low, full, lowAgain].map((need) => listed(db, [need])[0]!.dismissed)).toEqual([true, false, false]);
    expect(listed(db, [raised("disk:full", "broken")])[0]!.dismissed).toBe(false);
  });
});
