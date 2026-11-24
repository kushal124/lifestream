import { existsSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { flush, makeUnder, type Counts, type FileKind, type HomeFolder, type Json, type KeptFile, type Level, type PlaceholderTable } from "@lifestreamprotocol/core";
import type { Conn } from "./ledger.js";
import type { Saved, TablePart } from "./placeholders.js";

export interface SentPicture {
  jpeg: Uint8Array;
  recipe: Json;
}

export interface NewSentCopy {
  key: string;
  receiver: string;
  route: string;
  level: Level;
  body: string | null;
  pictures: SentPicture[];
  counts: Counts;
  detector: string | null;
}

export interface SentCopy extends Omit<NewSentCopy, "pictures"> {
  id: number;
  at_ms: number;
  pictures: Json[];
  written: string | null;
}

export type Made = { id: number } | Exclude<Saved, { saved: true }>;

export interface SentCopies {
  make(copy: NewSentCopy, now_ms: number, epoch: number, table?: { read: TablePart; answered: PlaceholderTable }): Made;
  get(id: number): SentCopy | undefined;
  files(id: number, count?: number): KeptFile[];
  drop(id: number): void;
  written(key: string, receiver: string, level: Level): string | undefined;
  sweep(now_ms: number, quiet_ms: number): number;
}

const COLUMNS = "id, key, receiver, route, level, body, pictures, counts, detector, written, at_ms";

const SENT_PICTURE: FileKind = { role: "sent-picture", remade: true };

export function sentOver(conn: Conn, home: HomeFolder, folder: string, ledger: {
  save: (read: TablePart, answered: PlaceholderTable) => Saved;
  epoch: () => { epoch: number; erasing: boolean };
}): {
  copies: SentCopies;
  landed(copy: number, written: string): void;
  ended(copy: number): void;
  forget(keys: Iterable<string>): void;
} {
  const { sql, write } = conn;
  const insert = sql(`INSERT INTO sent_copies (key, receiver, route, level, body, pictures, counts, detector, at_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const byId = sql<Record<string, unknown>>(`SELECT ${COLUMNS} FROM sent_copies WHERE id = ?`);
  const exists = sql("SELECT 1 FROM sent_copies WHERE id = ?");
  const byKey = sql<{ id: number }>("SELECT id FROM sent_copies WHERE key = ?");
  const remove = sql("DELETE FROM sent_copies WHERE id = ?");
  const keepWritten = sql("UPDATE sent_copies SET written = ? WHERE id = ?");
  const writtenFor = sql<{ written: string }>(`SELECT s.written FROM attempts a JOIN attempt_copies c ON c.attempt = a.id JOIN sent_copies s ON s.id = c.copy
    WHERE a.id = (SELECT max(id) FROM attempts WHERE key = ? AND state = 'replied') AND s.receiver = ? AND s.level = ? AND s.written IS NOT NULL`);
  const untaken = sql<{ id: number }>("SELECT id FROM sent_copies WHERE at_ms < ? AND id NOT IN (SELECT copy FROM attempt_copies)");
  const flying = sql<{ sent_copy: number }>("SELECT c.copy AS sent_copy FROM attempt_copies c JOIN attempts a ON a.id = c.attempt WHERE a.state = 'sending'");
  const takenAll = sql<{ sent_copy: number }>("SELECT DISTINCT copy AS sent_copy FROM attempt_copies");
  const pictureCount = sql<{ n: number }>("SELECT json_array_length(pictures) AS n FROM sent_copies WHERE id = ?");
  const folderOf = (id: number) => join(folder, String(id));
  const pictureOf = (id: number, n: number) => home.file(SENT_PICTURE, join(folderOf(id), `${n}.jpg`));
  const removeFiles = (id: number) => rmSync(folderOf(id), { recursive: true, force: true });
  const dropOne = (id: number) => {
    remove.run(id);
    removeFiles(id);
  };

  const copies: SentCopies = {
    make(copy, now, epoch, table) {
      const made = write((): Made => {
        const at = ledger.epoch();
        if (at.erasing || at.epoch !== epoch) return { erased: true };
        if (table !== undefined) {
          const saved = ledger.save(table.read, table.answered);
          if (!("saved" in saved)) return saved;
        }
        const level = levelText(copy.level);
        const recipes = copy.pictures.map((picture) => picture.recipe);
        const id = Number(insert.run(copy.key, copy.receiver, copy.route, level, copy.body, JSON.stringify(recipes), JSON.stringify(copy.counts), copy.detector, now).lastInsertRowid);
        return { id };
      });
      if (!("id" in made) || copy.pictures.length === 0) return made;
      try {
        makeUnder(dirname(folder), folderOf(made.id));
        copy.pictures.forEach((picture, n) => pictureOf(made.id, n).write(Buffer.from(picture.jpeg)));
      } catch (error) {
        write(() => dropOne(made.id));
        throw error;
      }
      return write((): Made => {
        if (exists.get(made.id) !== undefined) return made;
        removeFiles(made.id);
        return { erased: true };
      });
    },
    get: (id) => copyOf(byId.get(id)),
    files: (id, count) => Array.from({ length: count ?? pictureCount.get(id)?.n ?? 0 }, (_, n) => pictureOf(id, n)),
    drop: (id) => write(() => dropOne(id)),
    written: (key, receiver, level) => writtenFor.get(key, receiver, levelText(level))?.written,
    sweep: (now, quiet) => write(() => {
      const ids = untaken.all(now - quiet).map((row) => row.id);
      for (const id of ids) dropOne(id);
      const live = new Set(flying.all().map((row) => row.sent_copy));
      const taken = new Set(takenAll.all().map((row) => row.sent_copy));
      let names: string[] = [];
      try {
        names = readdirSync(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      for (const name of names) {
        const id = Number(name);
        if (!Number.isInteger(id) || exists.get(id) === undefined || (taken.has(id) && !live.has(id))) rmSync(join(folder, name), { recursive: true, force: true });
      }
      return ids.length;
    }),
  };

  return {
    copies,
    landed(id, written) {
      keepWritten.run(written, id);
      removeFiles(id);
    },
    ended: (id) => removeFiles(id),
    forget(keys) {
      let copied = false;
      for (const key of keys) {
        for (const { id } of byKey.all(key)) {
          copied = true;
          dropOne(id);
        }
      }
      if (copied && existsSync(folder)) flush(folder);
    },
  };
}

function levelText(level: Level): string {
  return typeof level === "string" ? level : JSON.stringify(level);
}

function copyOf(row: Record<string, unknown> | undefined): SentCopy | undefined {
  if (row === undefined) return undefined;
  const level = String(row.level);
  return {
    id: Number(row.id), key: String(row.key), receiver: String(row.receiver), route: String(row.route),
    level: level.startsWith("[") ? JSON.parse(level) as Level : level as Level,
    body: row.body === null ? null : String(row.body), pictures: JSON.parse(String(row.pictures)) as Json[],
    counts: JSON.parse(String(row.counts)) as Counts, detector: row.detector === null ? null : String(row.detector),
    written: row.written === null ? null : String(row.written), at_ms: Number(row.at_ms),
  };
}
