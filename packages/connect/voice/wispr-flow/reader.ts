import { createHash } from "node:crypto";
import { blobRef, each, instant, isObject, openDeliveredSqlite, refuse, requireColumns, rowJson, TimeError, unitOf, type Guard, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput, type SqliteRow } from "@lifestreamprotocol/connect/sdk";

export const DICTATION = "dictation";
export const WISPR_FILE = "flow.sqlite";
export const HISTORY = "History";
const EMPTY_ID_KEY = "no-transcript-id";

const AUDIO_TEXT = new Set(["opusChunks"]);
const READ = { [HISTORY]: ["transcriptEntityId", "timestamp"] };
const SEQUELIZE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}(?:\.\d+)?) \+00:00$/u;
const PAGE = 32;

const dictation: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join() !== `${HISTORY},type`) return [`members must be exactly type, ${HISTORY}`];
  const problems: string[] = [];
  if (content.type !== "wispr-flow.dictation") problems.push("type must be wispr-flow.dictation");
  const row = content[HISTORY];
  if (!isObject(row)) return [...problems, `${HISTORY} must be the row's columns`];
  if (typeof row.transcriptEntityId !== "string") problems.push("transcriptEntityId must be text");
  const time = timeOf(row);
  if (typeof time === "string") problems.push(time);
  for (const [column, value] of Object.entries(row)) {
    if (value === null || typeof value === "string" || typeof value === "number") continue;
    if (!blobRef(value)) problems.push(`${column} must be text, a number, null, or a blob's hash and bytes`);
  }
  return problems;
};

export const wisprFlow: Reader = {
  name: "wispr-flow-mac",
  kinds: { [DICTATION]: dictation },
  async *read(delivery, files) {
    const store = delivery.files.find((entry) => entry.path === WISPR_FILE);
    if (store === undefined) refuse(`the delivery carries no ${WISPR_FILE}`);
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, store);
    try {
      requireColumns(db, WISPR_FILE, READ);
      if (db.columns(HISTORY).some((column) => ["rowid", "_rowid_", "oid"].includes(column.toLowerCase()))) refuse(`${HISTORY} names a rowid alias as a column`);
      yield* each(db.rows(HISTORY, "rowid", { page: PAGE }), (part) => part.where, function* (part) {
        const stated = part.read();
        const { rowid, ...columns } = stated;
        yield row(columns, rowid, device);
      });
    } finally {
      db.close();
    }
  },
};

function row(columns: SqliteRow, rowid: unknown, device: string): ReaderOutput {
  const history: JsonObject = {};
  const bytes: Buffer[] = [];
  const media: Record<string, string> = {};
  for (const [column, value] of Object.entries(columns)) {
    const held = Buffer.isBuffer(value) ? value : AUDIO_TEXT.has(column) && typeof value === "string" ? Buffer.from(value, "utf8") : undefined;
    if (held === undefined) {
      Object.assign(history, rowJson({ [column]: value }));
      continue;
    }
    const hash = `sha256:${createHash("sha256").update(held).digest("hex")}`;
    history[column] = { hash, bytes: held.length };
    if (!bytes.some((other) => other.equals(held))) bytes.push(held);
    if (!Buffer.isBuffer(value)) media[hash] = "application/json";
  }
  const content: JsonObject = { type: "wispr-flow.dictation", [HISTORY]: history };
  const time = timeOf(history);
  const blobs = rowBlobs(content);
  return {
    kind: DICTATION,
    key: typeof history.transcriptEntityId === "string" ? history.transcriptEntityId || EMPTY_ID_KEY : "",
    content,
    ...(typeof time === "string" || time === undefined ? {} : { time }),
    ...(blobs.length === 0 ? {} : { blobs, bytes, media }),
    device,
    locator: `${HISTORY} row ${String(rowid)}`,
  };
}

export function rowBlobs(content: Json): string[] {
  const history = isObject(content) ? content[HISTORY] : undefined;
  if (!isObject(history)) return [];
  const hashes = new Set<string>();
  for (const value of Object.values(history)) if (blobRef(value)) hashes.add(value.hash);
  return [...hashes];
}

function timeOf(history: JsonObject): Instant | string | undefined {
  const stated = history.timestamp;
  if (stated === null || stated === undefined) return undefined;
  const spelled = typeof stated === "string" ? SEQUELIZE_UTC.exec(stated) : null;
  if (spelled === null) return `timestamp ${JSON.stringify(stated)} is not Sequelize's 'YYYY-MM-DD HH:MM:SS.sss +00:00'`;
  const west = history.timezoneOffsetMinutes;
  if (west !== null && west !== undefined && !(typeof west === "number" && Number.isSafeInteger(west))) return "timezoneOffsetMinutes must be an integer or null";
  try {
    return instant(`${spelled[1]}T${spelled[2]}Z`, "rfc3339", typeof west === "number" ? { offset: offset(-west) } : {});
  } catch (error) {
    if (error instanceof TimeError) return `timestamp ${JSON.stringify(stated)} with timezoneOffsetMinutes ${String(west)}: ${error.message}`;
    throw error;
  }
}

function offset(east: number): string {
  const sign = east < 0 ? "-" : "+";
  const abs = Math.abs(east);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
