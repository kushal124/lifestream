import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { BLOCKS, civilDay, openHome, openHomeFolder, type DaySettings, type FileCursor, type FileSlab } from "@lifestreamprotocol/core";
import { effective } from "../settings.js";
import { STORED_AT } from "../stored.js";
import { readHome } from "./harness-root.js";

export interface FileCount {
  source: string;
  version: number;
  bytes: number;
}

export interface Count {
  text: Record<string, number>;
  files: Record<string, number>;
  days: Record<string, number>;
  rows: Record<string, FileCount>;
}

const add = (sums: Record<string, number>, key: string, bytes: number): void => {
  sums[key] = (sums[key] ?? 0) + bytes;
};

const nonzero = (sums: Record<string, number>): Record<string, number> => Object.fromEntries(Object.entries(sums).filter(([, bytes]) => bytes !== 0).sort());

export function recount(root: string, day: DaySettings): Count {
  return readHome(root, (db) => {
    const versions = db.prepare(`SELECT v.rowid AS rowid, v.id AS id, octet_length(v.text) AS bytes,
        (SELECT s.source FROM statements s WHERE s.version = v.id ORDER BY s.seq LIMIT 1) AS owner,
        (SELECT r.started_ms FROM statements s JOIN runs r ON r.id = s.run WHERE s.version = v.id ORDER BY s.seq LIMIT 1) AS started_ms
      FROM versions v`).all() as { rowid: number; id: string; bytes: number; owner: string | null; started_ms: number }[];
    const byId = new Map(versions.map((version) => [version.id, version]));
    const text: Record<string, number> = {};
    const days: Record<string, number> = {};
    for (const version of versions) {
      if (version.owner === null) continue;
      add(text, version.owner, version.bytes);
      add(days, `${civilDay(version.started_ms, day)} ${version.owner}`, version.bytes);
    }
    const rows: Record<string, FileCount> = {};
    for (const { blob, version } of db.prepare("SELECT blob, version FROM version_blobs").all() as { blob: string; version: string }[]) {
      const naming = byId.get(version)!;
      const hex = blob.slice("sha256:".length);
      const path = join(root, "blobs", hex.slice(0, 2), hex.slice(2, 4), hex);
      if (naming.owner === null || !existsSync(path)) continue;
      const known = rows[blob];
      if (known === undefined || naming.rowid < known.version) rows[blob] = { source: naming.owner, version: naming.rowid, bytes: statSync(path).size };
    }
    const files: Record<string, number> = {};
    for (const row of Object.values(rows)) add(files, row.source, row.bytes);
    const today = civilDay(Date.now(), day);
    const firstRun = db.prepare("SELECT started_ms FROM runs ORDER BY id LIMIT 1").pluck().get() as number | undefined;
    const first = firstRun === undefined ? today : [civilDay(firstRun, day), today].sort()[0]!;
    for (const [blob, row] of Object.entries(rows)) {
      const hex = blob.slice("sha256:".length);
      const written = civilDay(Math.floor(statSync(join(root, "blobs", hex.slice(0, 2), hex.slice(2, 4), hex)).mtimeMs), day);
      add(days, `${written < first ? first : written > today ? today : written} ${row.source}`, row.bytes);
    }
    return { text: nonzero(text), files: nonzero(files), days: nonzero(days), rows };
  });
}

export function counted(root: string): Count {
  return readHome(root, (db) => {
    const text: Record<string, number> = {};
    const files: Record<string, number> = {};
    const days: Record<string, number> = {};
    for (const row of db.prepare("SELECT day, source, text, files FROM stored_days").all() as { day: string; source: string; text: number; files: number }[]) {
      add(text, row.source, row.text);
      add(files, row.source, row.files);
      add(days, `${row.day} ${row.source}`, row.text + row.files);
    }
    const rows = Object.fromEntries((db.prepare("SELECT blob, source, version, bytes FROM stored_files").all() as (FileCount & { blob: string })[])
      .map(({ blob, ...row }) => [blob, row]));
    return { text: nonzero(text), files: nonzero(files), days: nonzero(days), rows };
  });
}

export function fillMark(root: string): { complete: string } | { M: number; blocks: number; after: string | null; erasures: number; slab_ms: number } {
  return JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'stored:fill'").pluck().get() as string)) as never;
}

export const complete = (root: string): boolean => "complete" in fillMark(root);

export function upgrade(root: string): number {
  const db = new Database(join(root, "home.db"));
  try {
    return db.transaction(() => {
      const M = db.prepare("SELECT coalesce(max(rowid), 0) FROM versions").pluck().get() as number;
      for (const table of ["stored_days", "stored_files", "own_days"]) db.prepare(`DELETE FROM ${table}`).run();
      db.prepare("DELETE FROM meta WHERE key = 'stored:rest'").run();
      db.prepare("DELETE FROM events WHERE kind = 'stored'").run();
      db.prepare("UPDATE meta SET value = ? WHERE key = 'stored:fill'").run(JSON.stringify({ M, blocks: 0, after: null, erasures: 0, slab_ms: 0 }));
      return M;
    })();
  } finally {
    db.close();
  }
}

export function fillPart(root: string, share: number): { blocks: number; after: string | null } {
  const db = openHome(openHomeFolder(root), "migrate");
  try {
    const blobs = openHomeFolder(root).blobs(join(root, "blobs"));
    const view = db.view();
    const reads = (() => {
      try {
        const map = view.stored.ownerMap({ settings: effective(root).settings.day, now_ms: Date.now() });
        if (map === null) throw new Error("the home's fill is complete: upgrade it first");
        view.stored.mapBatch(map, Number.POSITIVE_INFINITY);
        const texts = Array.from({ length: Math.floor(BLOCKS * share) }, (_, step) => view.stored.text(map, step)!);
        const end = `sha256:${Math.floor(0x10000 * share).toString(16).padStart(4, "0")}`;
        const files: FileSlab[] = [];
        for (let at: FileCursor = { after: null }; at.after === null || at.after < end;) {
          const slab: FileSlab = view.stored.files(map, blobs, at)!;
          files.push(slab);
          at = { after: slab.through, ...(slab.naming === undefined ? {} : { naming: slab.naming }) };
        }
        return { texts, files };
      } finally {
        view.close();
      }
    })();
    db.commit((tx) => {
      for (const slab of reads.texts) if (!tx.stored.countText(slab)) throw new Error(`text slab ${slab.step} refused`);
      for (const slab of reads.files) if (!tx.stored.countFiles(slab)) throw new Error(`the file slab after ${slab.from} refused`);
      tx.tables.meta.set(STORED_AT, String(Date.now()));
    });
    const mark = fillMark(root) as { blocks: number; after: string | null };
    return { blocks: mark.blocks, after: mark.after };
  } finally {
    db.close();
  }
}
