import Database from "better-sqlite3";

export interface FileLock {
  release(): void;
}

export function tryLock(path: string, wait_ms = 0): FileLock | null {
  return take(path, (db) => {
    db.pragma("locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
  }, wait_ms);
}

export function trySharedLock(path: string): FileLock | null {
  return take(path, (db) => {
    db.exec("BEGIN");
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  });
}

function take(path: string, begin: (db: Database.Database) => void, wait_ms = 0): FileLock | null {
  const db = new Database(path, { timeout: wait_ms });
  try {
    begin(db);
  } catch (error) {
    db.close();
    if ((error as { code?: string }).code === "SQLITE_BUSY") return null;
    throw error;
  }
  let held = true;
  return {
    release() {
      if (!held) return;
      held = false;
      db.exec("ROLLBACK");
      db.close();
    },
  };
}
