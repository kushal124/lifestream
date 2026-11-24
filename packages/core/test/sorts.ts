import type Database from "better-sqlite3";

export function spillingSort(db: Database.Database, during: () => void = () => undefined): number {
  db.pragma("temp_store = FILE");
  db.pragma("cache_size = 20");
  db.exec("CREATE TABLE IF NOT EXISTS sorted (a TEXT)");
  const insert = db.prepare("INSERT INTO sorted VALUES (hex(randomblob(48)))");
  db.transaction(() => {
    for (let row = 0; row < 40_000; row++) insert.run();
  })();
  const rows = db.prepare("SELECT a FROM sorted ORDER BY a").pluck().iterate();
  let count = 0;
  try {
    for (const _ of rows) {
      if (count++ === 0) during();
    }
  } finally {
    rows.return?.();
  }
  return count;
}
