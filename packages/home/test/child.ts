import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startHome } from "../home.js";

const root = process.argv[2]!;
mkdirSync(join(root, "logs"), { recursive: true });
if (process.env.LIFESTREAM_FAILPOINT === "storage") {
  const exec = Database.prototype.exec;
  const gone = join(root, "disk-gone");
  let writes = 0;
  Database.prototype.exec = function (this: Database.Database, sql: string) {
    if (sql === "BEGIN IMMEDIATE" && this.name.endsWith("home.db") && existsSync(gone) && writes++ >= Number(readFileSync(gone, "utf8") || 0)) {
      throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR");
    }
    return exec.call(this, sql);
  };
}
if (process.env.LIFESTREAM_FAILPOINT === "storage-verb") {
  const prepare = Database.prototype.prepare;
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    if (this.name.endsWith("home.db") && sql.includes("FROM enrichments WHERE family = ? AND item = ? ORDER BY item, prompt")) throw new Database.SqliteError("disk I/O error", "SQLITE_IOERR");
    return prepare.call(this, sql);
  } as typeof prepare;
}
const stopping = new AbortController();
process.once("SIGTERM", () => stopping.abort());
let home: Awaited<ReturnType<typeof startHome>>;
try {
  home = await startHome(root, {
    registry: new URL(process.env.LIFESTREAM_TEST_REGISTRY ?? new URL("./fakes.ts", import.meta.url).href),
    tickMs: Number(process.argv[3]),
    lookMs: 10,
    stopGraceMs: 50,
    log: (line) => appendFileSync(join(root, "logs", "home.log"), `${line}\n`),
    signal: stopping.signal,
    ...(process.env.LIFESTREAM_TEST_FEEDBACK_URL === undefined ? {} : { feedbackUrl: process.env.LIFESTREAM_TEST_FEEDBACK_URL }),
  });
} catch (error) {
  if (stopping.signal.aborted) process.exit(0);
  throw error;
}
if (stopping.signal.aborted) void home.stop();
else stopping.signal.addEventListener("abort", () => void home.stop(), { once: true });
void home.stopped.then(() => process.exit(stopping.signal.aborted ? 0 : 1));
