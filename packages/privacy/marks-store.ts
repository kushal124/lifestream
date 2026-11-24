import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { isDetailType, type HomeFolder, type StoreKind } from "@lifestreamprotocol/core";
import type { DetectorModel, PassageMark } from "./detector.js";

export interface Kept {
  marks: PassageMark[];
  current: boolean;
}

export interface MarksStore {
  readonly id: string;
  readonly epoch: string;
  read(digests: readonly string[], model: DetectorModel): Map<string, Kept>;
  write(model: DetectorModel, passages: ReadonlyMap<string, readonly PassageMark[]>, epoch: string): boolean;
  dropOthers(model: DetectorModel): Promise<number>;
  forget(digests: readonly string[]): number;
  close(): void;
}

const SCHEMA = 2;
const WRITE_WAIT_MS = 100;
const FORGET_WAIT_MS = 5_000;
const DROP_CHUNK = 1_000;

export const MARKS_STORE: StoreKind = { role: "marks", remade: true };
type Database = ReturnType<HomeFolder["store"]>;

interface Row {
  digest: string;
  model: string;
  file: string;
  decode: string;
  marks: string;
}

interface Open {
  db: Database;
  id: string;
  dev: number;
  ino: number;
  rows(digests: readonly string[]): Row[];
  epoch(): string;
  put(digest: string, model: DetectorModel, marks: string): void;
  others(model: DetectorModel): number;
  gone(digests: readonly string[]): number;
}

export function openMarks(folder: HomeFolder, path: string): MarksStore {
  mkdirSync(dirname(path), { recursive: true });
  let open = opened(folder, path);
  const now = (): Open => {
    const at = statSync(path, { throwIfNoEntry: false });
    if (at === undefined || at.dev !== open.dev || at.ino !== open.ino) {
      open.db.close();
      open = opened(folder, path);
    }
    return open;
  };
  const guarded = <T>(work: (file: Open) => T): T => {
    try {
      return work(now());
    } catch (error) {
      if (!damaged(error)) throw error;
      open.db.close();
      open = afresh(folder, path);
      return work(open);
    }
  };
  return {
    get id() {
      return now().id;
    },
    get epoch() {
      return guarded((file) => file.epoch());
    },
    read(digests, model) {
      return guarded(({ rows }) => {
        const kept = new Map<string, Kept>();
        for (const row of rows(digests)) {
          const current = row.model === model.id && row.file === model.file && row.decode === model.decode;
          if (kept.get(row.digest)?.current === true) continue;
          kept.set(row.digest, { marks: parsed(row.marks), current });
        }
        return kept;
      });
    },
    write(model, passages, epoch) {
      try {
        return guarded((file) => file.db.transaction(() => {
          if (file.epoch() !== epoch) return false;
          for (const [digest, marks] of passages) file.put(digest, model, JSON.stringify(marks.map((mark) => [mark.start, mark.end, mark.type])));
          return true;
        }).immediate());
      } catch (error) {
        if (busy(error)) return false;
        throw error;
      }
    },
    async dropOthers(model) {
      let gone = 0;
      for (;;) {
        const chunk = guarded(({ others }) => others(model));
        gone += chunk;
        if (chunk < DROP_CHUNK) return gone;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    },
    forget(digests) {
      return guarded(({ gone }) => gone(digests));
    },
    close() {
      open.db.close();
    },
  };
}

function opened(folder: HomeFolder, path: string): Open {
  try {
    return start(folder, path);
  } catch (error) {
    if (!damaged(error)) throw error;
    return afresh(folder, path);
  }
}

function afresh(folder: HomeFolder, path: string): Open {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  return start(folder, path);
}

function start(folder: HomeFolder, path: string): Open {
  const db = folder.store(MARKS_STORE, path, { timeout: WRITE_WAIT_MS });
  try {
    const id = patiently(db, () => db.transaction(() => {
      const schema = db.pragma("user_version", { simple: true }) as number;
      if (schema !== SCHEMA) {
        db.exec("DROP TABLE IF EXISTS marks");
        db.exec("DROP TABLE IF EXISTS store");
        db.exec("CREATE TABLE store (id TEXT NOT NULL, forgets INTEGER NOT NULL)");
        db.prepare("INSERT INTO store (id, forgets) VALUES (?, 0)").run(randomUUID());
        db.exec("CREATE TABLE marks (digest TEXT NOT NULL, model TEXT NOT NULL, file TEXT NOT NULL, decode TEXT NOT NULL, marks TEXT NOT NULL, PRIMARY KEY (digest, model, file, decode))");
        db.pragma(`user_version = ${SCHEMA}`);
      }
      return (db.prepare("SELECT id FROM store").get() as { id: string }).id;
    }).immediate());
    const select = db.prepare("SELECT digest, model, file, decode, marks FROM marks WHERE digest IN (SELECT value FROM json_each(?)) ORDER BY rowid");
    const put = db.prepare("INSERT OR REPLACE INTO marks (digest, model, file, decode, marks) VALUES (?, ?, ?, ?, ?)");
    const others = db.prepare(`DELETE FROM marks WHERE rowid IN (SELECT rowid FROM marks WHERE NOT (model = ? AND file = ? AND decode = ?) LIMIT ${DROP_CHUNK})`);
    const gone = db.prepare("DELETE FROM marks WHERE digest IN (SELECT value FROM json_each(?))");
    const forgot = db.prepare("UPDATE store SET forgets = forgets + 1");
    const epoch = db.prepare("SELECT id || ':' || forgets FROM store").pluck();
    const at = statSync(path);
    return {
      db,
      id,
      dev: at.dev,
      ino: at.ino,
      rows: (digests) => select.all(JSON.stringify([...new Set(digests)])) as Row[],
      put: (digest, model, marks) => void put.run(digest, model.id, model.file, model.decode, marks),
      others: (model) => others.run(model.id, model.file, model.decode).changes,
      epoch: () => epoch.get() as string,
      gone: (digests) => patiently(db, () => db.transaction(() => {
        forgot.run();
        return gone.run(JSON.stringify([...new Set(digests)])).changes;
      }).immediate()),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

function patiently<T>(db: Database, work: () => T): T {
  db.pragma(`busy_timeout = ${FORGET_WAIT_MS}`);
  try {
    return work();
  } finally {
    db.pragma(`busy_timeout = ${WRITE_WAIT_MS}`);
  }
}

function parsed(text: string): PassageMark[] {
  const rows = JSON.parse(text) as [number, number, string][];
  return rows.flatMap(([start, end, type]) => (isDetailType(type) ? [{ start, end, type }] : []));
}

function busy(error: unknown): boolean {
  return error instanceof Error && "code" in error && /^SQLITE_BUSY/u.test(String((error as { code: unknown }).code));
}

function damaged(error: unknown): boolean {
  return error instanceof Error && "code" in error && /^SQLITE_(CORRUPT|NOTADB)/u.test(String((error as { code: unknown }).code));
}
