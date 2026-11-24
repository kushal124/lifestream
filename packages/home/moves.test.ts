import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder, type HomeDb, type OpenView } from "@lifestreamprotocol/core";
import type { Change, Family } from "@lifestreamprotocol/families";
import { touchedChunk } from "./derive.js";

const SOURCE = "apple-notes:local:device-a";
const RECORD = { source: SOURCE, kind: "note", key: "n1" };
const STATEMENTS = 4_500;
const T0 = Date.UTC(2026, 8, 1);

describe("a record's moves since the cursor", () => {
  let dir: string;
  let db: HomeDb;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "home-moves-"));
    db = openHome(openHomeFolder(dir), "migrate");
    db.commit((tx) => {
      const run = tx.tables.runs.start({ kind: "import", subject: SOURCE, started_ms: T0 });
      for (let index = 0; index < STATEMENTS; index++) {
        const stated_ms = T0 + index;
        tx.records.land(run, { id: `${SOURCE}@${stated_ms}`, source: SOURCE, stated_ms }, [{ kind: "note", key: RECORD.key, content: { text: `version ${index}` } }], { note: () => [] }, { has: () => true });
      }
      tx.tables.runs.end(run, { ended_ms: T0, outcome: "ok", counts: {} });
    });
  });
  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("are read by the chunk that holds their statements, each once, in order (M1, M2, M3)", () => {
    const view = db.view();
    try {
      let reads = 0;
      const counted = new Proxy(view, {
        get(target, name) {
          if (name === "version") return (id: string) => { reads++; return target.version(id); };
          const value = Reflect.get(target, name, target) as unknown;
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as OpenView;
      const handed: Change[] = [];
      const family = { name: "notes", touched: (changes: readonly Change[]) => { handed.push(...changes); return []; } } as unknown as Family;
      const statements = view.statements(0, { sources: [SOURCE], kinds: ["note"] })[Symbol.iterator]();
      const chunks: { statements: number; reads: number }[] = [];
      let cursor = 0;
      let reread = 0;
      for (;;) {
        const before = reads;
        const chunk = touchedChunk(family, () => true, counted, statements, cursor, reread, [], new Set(), new Set());
        chunks.push({ statements: chunk.statements, reads: reads - before });
        ({ cursor, reread } = chunk);
        if (!chunk.full) break;
      }
      expect(chunks.map((chunk) => chunk.statements)).toEqual([2_000, 2_000, 500]);
      for (const chunk of chunks) expect(chunk.reads).toBeLessThanOrEqual(chunk.statements + 1);
      expect(handed).toHaveLength(STATEMENTS);
      expect(handed.map((change) => (change.after?.content as { text: string }).text)).toEqual(Array.from({ length: STATEMENTS }, (_, index) => `version ${index}`));
      expect(handed.slice(1).every((change, index) => change.before?.id === handed[index]!.after?.id)).toBe(true);
      expect(handed[0]!.before).toBeUndefined();
    } finally {
      view.close();
    }
  });
});
