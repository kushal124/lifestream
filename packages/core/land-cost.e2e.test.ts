import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256, versionId } from "./format.js";
import { openHome, type HomeDb } from "./home-db.js";
import { openHomeFolder } from "./home-folder.js";
import type { Guard, Landed, ReaderOutput } from "./types.js";

const ROWS = 122_000;
const CHANGED = 1_600;
const SLICE = 2_000;
const T1 = Date.UTC(2026, 8, 1);
const ARTIFACT = join(tmpdir(), "core-land-cost.json");
const RESTATED_FRAMES_PER_ROW = 1.25;
const FRAME = 4096 + 24;
const guards: Record<string, Guard> = { msg: (content) => (typeof content === "object" && content !== null ? [] : ["not an object"]) };

function message(n: number, status: number): ReaderOutput {
  const stanza = sha256(`stanza ${n}`).slice(7, 27).toUpperCase();
  const at = 800_000_000 + n * 37;
  return {
    kind: "msg",
    key: stanza,
    content: {
      Z_PK: n, Z_ENT: 9, Z_OPT: 3, ZCHATSESSION: n % 300, ZISFROMME: n % 2, ZMESSAGESTATUS: status, ZMESSAGETYPE: 0,
      ZFLAGS: 0, ZSTARRED: 0, ZMESSAGEDATE: at, ZSENTDATE: at - 1, ZFROMJID: n % 2 ? null : `1555000${String(n % 9000).padStart(4, "0")}@s.whatsapp.net`,
      ZTOJID: null, ZSTANZAID: stanza, ZPUSHNAME: null, ZGROUPMEMBER: null, ZMEDIAITEM: n % 20 === 0 ? n : null,
      ZTEXT: `synthetic message ${n} with a few words of filler text to reach a typical length`,
    },
    time: { start_ms: (978_307_200 + at) * 1000, precision: "s" },
    locator: `ZWAMESSAGE/${n}`,
  };
}

function rows(statusOf: (n: number) => number): ReaderOutput[] {
  return Array.from({ length: ROWS }, (_, n) => message(n, statusOf(n)));
}

describe("land cost", () => {
  it("a restated row writes its head's leaf and nothing more", () => {
    const dir = mkdtempSync(join(tmpdir(), "core-land-cost-"));
    const path = join(dir, "home.db");
    const db = openHome(openHomeFolder(dirname(path)), "migrate");
    try {
      const prepare = timed(() => {
        for (const row of rows(() => 8)) versionId(row.kind, row.key, row.content);
      });
      const fresh = phase(db, path, T1, rows(() => 8));
      const restated = phase(db, path, T1 + 86_400_000, rows(() => 8));
      const changed = phase(db, path, T1 + 2 * 86_400_000, rows((n) => (n % 76 === 0 && n / 76 < CHANGED ? 13 : 8)));
      const result = {
        rows: ROWS,
        slice_rows: SLICE,
        build_rows_and_version_ids_ms_per_row: round(prepare / ROWS),
        new: report(fresh),
        restated: report(restated),
        changed: {
          ...report(changed),
          changed_ms_per_row_over_restated: round((changed.ms - restated.ms * ((ROWS - CHANGED) / ROWS)) / CHANGED),
          changed_wal_frames_per_row_over_restated: round((frames(changed) - frames(restated) * ((ROWS - CHANGED) / ROWS)) / CHANGED),
        },
        home_db_bytes: statSync(path).size,
        sqlite: "3.53.4 (better-sqlite3 13.0.3), WAL, synchronous=FULL",
      };
      writeFileSync(ARTIFACT, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`land cost: ${ARTIFACT}`);
      expect(fresh.landed).toMatchObject({ new: ROWS });
      expect(restated.landed).toMatchObject({ restated: ROWS });
      expect(changed.landed).toMatchObject({ restated: ROWS - CHANGED, changed: CHANGED, changedPaths: { ZMESSAGESTATUS: CHANGED } });
      expect([fresh, restated, changed].map(frames).every(Number.isInteger)).toBe(true);
      expect(result.restated.wal_frames_per_row).toBeLessThan(RESTATED_FRAMES_PER_ROW);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

interface Phase {
  ms: number;
  slices: number[];
  wal_bytes: number;
  writes: number;
  checkpoint_ms: number;
  landed: Omit<Landed, "refusals" | "kinds">;
}

function phase(db: HomeDb, path: string, stated_ms: number, all: ReaderOutput[]): Phase {
  db.checkpoint("truncate");
  const total: Omit<Landed, "refusals" | "kinds"> = { new: 0, restated: 0, changed: 0, late: 0, gone: 0, erased: 0, refused: 0, duplicated: 0, replayed: 0, changedPaths: {} };
  const slices: number[] = [];
  let wal = 0;
  let writes = 0;
  let checkpoint = 0;
  const run = db.commit((tx) => tx.tables.runs.start({ kind: "import", subject: "whatsapp:+15550000001:macbook-pro-0001", started_ms: stated_ms }));
  for (let at = 0; at < all.length; at += SLICE) {
    const sliceStarted = performance.now();
    const landed = db.commit((tx) =>
      tx.records.land(run, { id: `snapshot@${stated_ms}`, source: "whatsapp:+15550000001:macbook-pro-0001", stated_ms }, all.slice(at, at + SLICE), guards, { has: () => true }),
    );
    slices.push(performance.now() - sliceStarted);
    const written = walSize(path);
    wal += written;
    if (written > 0) writes++;
    checkpoint += timed(() => db.checkpoint("truncate"));
    for (const [name, value] of Object.entries(landed)) {
      if (name === "refusals" || name === "kinds") continue;
      if (name === "changedPaths") {
        for (const [p, n] of Object.entries(value as Record<string, number>)) total.changedPaths[p] = (total.changedPaths[p] ?? 0) + n;
      } else (total as unknown as Record<string, number>)[name]! += value as number;
    }
  }
  const ms = slices.reduce((sum, slice) => sum + slice, 0);
  return { ms, slices, wal_bytes: wal, writes, checkpoint_ms: checkpoint, landed: total };
}

function report(result: Phase) {
  const perRow = result.ms / ROWS;
  const sorted = [...result.slices].sort((a, b) => a - b);
  return {
    ms_total: Math.round(result.ms),
    ms_per_row: round(perRow),
    rows_per_100ms_slice: Math.floor(100 / perRow),
    slice_ms_p50: round(sorted[Math.floor(sorted.length / 2)]!),
    slice_ms_max: round(sorted[sorted.length - 1]!),
    wal_bytes_per_row: Math.round(result.wal_bytes / ROWS),
    wal_bytes_total: result.wal_bytes,
    wal_frames_per_row: round(frames(result) / ROWS),
    checkpoint_ms_per_row: round(result.checkpoint_ms / ROWS),
  };
}

function frames(result: Phase): number {
  return (result.wal_bytes - 32 * result.writes) / FRAME;
}

function walSize(path: string): number {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

function timed(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
