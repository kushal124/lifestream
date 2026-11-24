import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type Guard, type HomeDb, type ReaderOutput } from "@lifestreamprotocol/core";
import { tallied, widest, type Tally } from "./imports.js";
import { makeRoot, removeRoot } from "./test/harness-root.js";

const SOURCE = "notes:synthetic-user-0001:export";
const OLDER = Date.UTC(2026, 9, 1, 12);
const NEWER = OLDER + 86_400_000;
const DAY = { zone: "UTC", day_start_hour: 0 };
const GUARDS: Record<string, Guard> = { note: () => [] };
const at = Date.UTC(2020, 0, 2, 9);
const note = (key: string): ReaderOutput => ({ kind: "note", key, content: { text: key }, time: { start_ms: at, precision: "s" } });

const opened: { root: string; db: HomeDb }[] = [];
afterEach(() => {
  for (const { root, db } of opened.splice(0)) {
    db.close();
    removeRoot(root);
  }
});

function home(): HomeDb {
  const root = makeRoot("lifestream-import-tally-", { sources: {} });
  const db = openHome(openHomeFolder(root), "migrate");
  opened.push({ root, db });
  return db;
}

describe("an import's tally", () => {
  it("counts a record once a run: held from an older delivery, repeated across two slices, and read again by a resumed attempt", () => {
    const db = home();
    const run = (id: string, stated_ms: number) => db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: `${SOURCE} ${id}`, started_ms: stated_ms }));
    const older = run("older", OLDER);
    db.commit((tx) => tx.records.land(older, { id: "older", source: SOURCE, stated_ms: OLDER }, [note("k")], GUARDS, { has: () => true }));
    const newer = run("newer", NEWER);
    const attempt = (slices: ReaderOutput[][]): Tally => {
      const tally: Tally = { days: {}, kinds: {} };
      const seen = new Set<number>();
      for (const rows of slices) {
        db.commit((tx) => tx.records.land(newer, { id: "newer", source: SOURCE, stated_ms: NEWER }, rows, GUARDS, { has: () => true }, tallied(tally, seen, DAY, () => true)));
      }
      return tally;
    };
    const slices = [[note("k"), note("j")], [note("k")]];
    const first = attempt(slices);
    expect(first).toEqual({ days: { "2020-01-02": 2 }, kinds: { note: 2 }, lines: { "2020-01-02": 2 } });
    expect(widest(first, attempt(slices))).toEqual({ days: { "2020-01-02": 2 }, kinds: { note: 2 }, lines: { "2020-01-02": 2 } });
  });
});
