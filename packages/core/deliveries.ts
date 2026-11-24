import type Database from "better-sqlite3";
import { Sql } from "./sql.js";

export type DeliveryState = "sealed" | "importing" | "imported" | "failed" | "dead" | "superseded";

export const STOPPED_FAILURES = 2;
export const WAITING = "('sealed', 'importing', 'failed')";
export const UNREAD = "(refused > 0 OR state = 'dead')";
export const SETTLED = "('imported', 'superseded', 'dead')";
export const STOPPED = `state IN ('failed', 'importing') AND failures >= ${STOPPED_FAILURES}`;

type Of<K extends keyof DeliveryFields> = Readonly<Pick<DeliveryFields, K>>;
interface DeliveryFields {
  state: string;
  failures: number;
  refused: number;
  read_by: string | null;
}

export const isWaiting = (row: Of<"state">): boolean => row.state === "sealed" || row.state === "importing" || row.state === "failed";
export const isSettled = (row: Of<"state">): boolean => !isWaiting(row);
export const isRead = (row: Of<"state">): boolean => row.state === "imported" || row.state === "superseded";
export const isUnread = (row: Of<"state" | "refused">): boolean => row.refused > 0 || row.state === "dead";
export const isStopped = (row: Of<"state" | "failures">): boolean =>
  (row.state === "failed" || row.state === "importing") && row.failures >= STOPPED_FAILURES;

export type DeliveryMove =
  | { move: "begin"; run: number }
  | { move: "land"; run: number; refused: number; error: string | null; code: string }
  | { move: "pass" }
  | { move: "fail"; error: string }
  | { move: "supersede"; why?: string }
  | { move: "give-up"; code: string; refused?: number }
  | { move: "reread"; code: string; refused?: number; error?: string | null }
  | { move: "unread" }
  | { move: "relist" }
  | { move: "purge"; why: string };

export class DeliveryRefused extends Error {
  constructor(readonly id: string, readonly source: string, readonly state: DeliveryState | null, readonly move: DeliveryMove["move"]) {
    super(state === null ? `delivery ${id} of ${source} is not indexed: no ${move}` : `delivery ${id} of ${source} is ${state}: no ${move}`);
    this.name = "DeliveryRefused";
  }
}

type Held = Of<"failures" | "refused" | "read_by"> & { readonly state: DeliveryState };
interface Change {
  state: DeliveryState;
  set: { run?: number | null; failures?: number; error?: string | null; refused?: number; read_by?: string | null };
}

function decide(row: Held, move: DeliveryMove): Change | null {
  const at = (...states: DeliveryState[]) => states.includes(row.state);
  switch (move.move) {
    case "begin":
      return at("sealed", "failed", "importing") ? { state: "importing", set: { run: move.run } } : null;
    case "land":
      return at("sealed", "importing") ? { state: "imported", set: { run: move.run, refused: move.refused, error: move.error, read_by: move.code } } : null;
    case "pass":
      return at("sealed") ? { state: "imported", set: {} } : null;
    case "fail":
      return at("importing") ? { state: "failed", set: { failures: row.failures + 1, error: move.error } } : null;
    case "supersede":
      return at("sealed", "importing", "failed", "dead") ? { state: "superseded", set: { refused: 0, ...(move.why === undefined ? {} : { error: move.why }) } } : null;
    case "give-up":
      return isWaiting(row) || (at("imported") && isUnread(row))
        ? { state: "dead", set: { read_by: move.code, ...(move.refused === undefined ? {} : { refused: move.refused }) } } : null;
    case "reread":
      return at("imported", "dead")
        ? { state: row.state === "dead" && move.refused === 0 && (move.error ?? null) === null ? "imported" : row.state, set: { read_by: move.code, ...(move.refused === undefined ? {} : { refused: move.refused }), ...(move.error === undefined ? {} : { error: move.error }) } }
        : null;
    case "unread":
      return at("imported", "dead") && isUnread(row) && row.read_by !== null ? { state: row.state, set: { read_by: null } } : null;
    case "relist":
      return at("imported") && !isUnread(row) ? { state: "sealed", set: { read_by: null, run: null } } : null;
    case "purge":
      return { state: row.state, set: { error: move.why } };
  }
}

const LOSES = `INSERT OR IGNORE INTO lost_files (source, blob, claim, sealed_ms)
  SELECT w.source, w.blob, d.id, d.sealed_ms FROM deliveries d
    CROSS JOIN statements s INDEXED BY statements_run ON s.run = d.run AND s.source = d.source
    CROSS JOIN version_blobs vb ON vb.version = s.version
    CROSS JOIN wanted_blobs w ON w.blob = vb.blob AND w.source = s.source AND w.kind = s.kind AND w.key = s.key
  WHERE d.id = ? AND d.source = ? AND d.lost IS NOT NULL`;

export function moveDelivery(sql: Sql, id: string, source: string, move: DeliveryMove): void {
  sql.writing();
  const row = sql.get<Held>("SELECT state, failures, refused, read_by FROM deliveries WHERE id = ? AND source = ?", id, source);
  const change = row === undefined ? null : decide(row, move);
  if (change === null) throw new DeliveryRefused(id, source, row?.state ?? null, move.move);
  const columns = Object.keys(change.set) as (keyof Change["set"])[];
  sql.run(
    `UPDATE deliveries SET ${["state", ...columns].map((column) => `${column} = ?`).join(", ")} WHERE id = ? AND source = ?`,
    change.state, ...columns.map((column) => change.set[column]), id, source,
  );
  sql.moved.deliveries.add(source);
  if (move.move === "land") sql.run(LOSES, id, source);
  if (change.state === "imported" && row!.state !== "imported") sql.moved.imported.add(source);
  if (isSettled(change)) for (const seal of sealsOf(sql, id)) advance(sql, seal.pass, seal.source);
}

export function unreadAgain(sql: Sql, source: string): number {
  sql.writing();
  const changes = sql.run(
    `UPDATE deliveries INDEXED BY deliveries_unread SET read_by = NULL WHERE source = ? AND ${UNREAD} AND read_by IS NOT NULL`, source,
  ).changes;
  if (changes > 0) sql.moved.deliveries.add(source);
  return changes;
}


const SETTLED_SEAL = `SELECT 1 AS settled FROM deliveries INDEXED BY deliveries_seal WHERE pass = ? AND source = ? AND seal = ? AND state IN ${SETTLED} LIMIT 1`;

export const sealHeld = (sql: Sql, pass: string, source: string, seal: number): boolean =>
  sql.get("SELECT 1 FROM deliveries INDEXED BY deliveries_seal WHERE pass = ? AND source = ? AND seal = ? LIMIT 1", pass, source, seal) !== undefined;
const sealSettled = (sql: Sql, pass: string, source: string, seal: number): boolean => sql.get(SETTLED_SEAL, pass, source, seal) !== undefined;
export const importedOf = (sql: Sql, pass: string, source: string): number =>
  sql.get<{ imported: number }>("SELECT imported FROM custody WHERE pass = ? AND source = ?", pass, source)?.imported ?? 0;
const keepImported = (sql: Sql, pass: string, source: string, imported: number): void => {
  sql.moved.custody.add(source);
  sql.run("INSERT INTO custody (pass, source, imported) VALUES (?, ?, ?) ON CONFLICT (pass, source) DO UPDATE SET imported = excluded.imported", pass, source, imported);
};

function advance(sql: Sql, pass: string, source: string): void {
  const from = importedOf(sql, pass, source);
  let imported = from;
  while (sealSettled(sql, pass, source, imported + 1)) imported++;
  if (imported !== from) keepImported(sql, pass, source, imported);
}

const sealsOf = (sql: Sql, id: string) => sql.all<{ pass: string; source: string; seal: number }>(
  "SELECT pass, source, seal FROM deliveries WHERE id = ? AND seal IS NOT NULL AND pass IS NOT NULL", id,
);

