import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DAYS_MARK, openHome, openHomeFolder, type HomeDb } from "@lifestreamprotocol/core";
import { renderDay } from "@lifestreamprotocol/families";
import { dayPath, listDays, readDays, type DaysRead } from "./derive.js";
import { artifact, makeRoot, readHome, removeRoot } from "./test/harness-root.js";

const DAYS = { zone: "UTC", day_start_hour: 4 };
const NOW = Date.UTC(2026, 9, 6, 12);
const [ONE, TWO, THREE, FOUR, FIVE] = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"] as const;

describe("the day list made exact with what the start read of the files", () => {
  let root: string;
  let db: HomeDb;
  const seen: Record<string, unknown> = {};

  const write = (day: string) => {
    mkdirSync(join(root, "days"), { recursive: true });
    const view = db.view();
    try {
      writeFileSync(dayPath(root, day, "json"), renderDay(day, [], view, DAYS, () => undefined).json);
    } finally {
      view.close();
    }
  };
  const apply = (read: DaysRead) => db.commit((tx) => listDays(tx, read, NOW));
  const rows = () => readHome(root, (home) => home.prepare("SELECT day FROM days ORDER BY day").pluck().all()) as string[];
  const mark = () => readHome(root, (home) => home.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(DAYS_MARK) ?? null);
  const newest = () => readHome(root, (home) => home.prepare("SELECT coalesce(max(seq), 0) FROM events").pluck().get()) as number;
  const told = (after: number) => readHome(root, (home) => home.prepare("SELECT key FROM events WHERE kind = 'day' AND seq > ? ORDER BY key").pluck().all(after)) as string[];
  const queued = () => readHome(root, (home) => home.prepare("SELECT day FROM dirty_days ORDER BY day").pluck().all()) as string[];

  beforeAll(() => {
    root = makeRoot("lifestream-day-list-", { sources: {} });
    db = openHome(openHomeFolder(root), "migrate");
  });

  afterAll(() => {
    artifact(root, "day-list", seen);
    db.close();
    removeRoot(root);
  });

  it("a day file with no row gets its row and a `day` event; a row with no file is deleted, with its own, and its day is owed again; rows already exact change nothing", () => {
    write(ONE);
    write(TWO);
    let since = newest();
    const first = apply(readDays(openHomeFolder(root)));
    expect(first).toEqual({ days: [ONE, TWO], changed: 2, unread: 0 });
    expect([rows(), told(since), mark() !== null, queued()]).toEqual([[ONE, TWO], [ONE, TWO], true, []]);
    rmSync(dayPath(root, TWO, "json"));
    since = newest();
    expect(apply(readDays(openHomeFolder(root)))).toEqual({ days: [ONE], changed: 1, unread: 0 });
    expect([rows(), told(since), queued()]).toEqual([[ONE], [TWO], [TWO]]);
    since = newest();
    expect(apply(readDays(openHomeFolder(root)))).toEqual({ days: [ONE], changed: 0, unread: 0 });
    expect([told(since), queued()]).toEqual([[], [TWO]]);
    seen.exact = { first, rows: rows(), queued: queued() };
  });

  it("a row whose file states no head is deleted and its day owed again", () => {
    write(FIVE);
    apply(readDays(openHomeFolder(root)));
    expect(rows()).toEqual([ONE, FIVE]);
    writeFileSync(dayPath(root, FIVE, "json"), "not a day file");
    const since = newest();
    expect(apply(readDays(openHomeFolder(root)))).toEqual({ days: [ONE, FIVE], changed: 1, unread: 0 });
    expect([rows(), told(since), queued()]).toEqual([[ONE], [FIVE], [TWO, FIVE]]);
    rmSync(dayPath(root, FIVE, "json"));
  });

  it("one head that cannot be read keeps its row and queues its day; the rest is made exact and the mark set", () => {
    rmSync(dayPath(root, ONE, "json"));
    mkdirSync(dayPath(root, ONE, "json"));
    write(THREE);
    const since = newest();
    const read = readDays(openHomeFolder(root));
    expect("unread" in read && read.unread).toEqual([ONE]);
    expect(apply(read)).toEqual({ days: [ONE, THREE], changed: 1, unread: 1 });
    expect([rows(), told(since), queued(), mark() !== null]).toEqual([[ONE, THREE], [THREE], [ONE, TWO, FIVE], true]);
    rmSync(dayPath(root, ONE, "json"), { recursive: true });
    seen.unread = { rows: rows(), queued: queued() };
  });

  it("a folder that cannot be read clears the mark, changes no row and marks no day", () => {
    const before = rows();
    const owed = queued();
    renameSync(join(root, "days"), join(root, "days.kept"));
    writeFileSync(join(root, "days"), "");
    try {
      const since = newest();
      const read = readDays(openHomeFolder(root));
      expect("error" in read).toBe(true);
      expect("error" in apply(read)).toBe(true);
      expect([rows(), told(since), mark(), queued()]).toEqual([before, [], null, owed]);
      seen.folder = read;
    } finally {
      rmSync(join(root, "days"));
      renameSync(join(root, "days.kept"), join(root, "days"));
    }
  });

  it("the start's transaction reads no file: what was read is applied with the folder gone", () => {
    db.commit((tx) => {
      for (const { day, marks } of tx.tables.dirty.nextDays(10, FIVE)) tx.tables.dirty.rendered(day, marks, false);
    });
    write(FOUR);
    const read = readDays(openHomeFolder(root));
    rmSync(join(root, "days"), { recursive: true });
    expect(apply(read)).toEqual({ days: [THREE, FOUR], changed: 2, unread: 0 });
    expect([rows(), mark() !== null, queued()]).toEqual([[THREE, FOUR], true, [ONE]]);
  });
});
