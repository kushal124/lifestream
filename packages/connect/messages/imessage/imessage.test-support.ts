export { artifact, collect, temp } from "../../test/drive.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { BlobStore, Delivery, Guard, HomeDb, JsonObject, Landed, ReaderOutput } from "@lifestreamprotocol/core";
import type { Fixture } from "../../test/drive.js";

export const ACCOUNT = "person-a@example.com";
export const MAC_UNIT = "macbook-pro-0001";
export const PHONE_UNIT = "iphone-aa01";
export const MAC_SOURCE = `imessage:${ACCOUNT}:${MAC_UNIT}`;
export const PHONE_SOURCE = `imessage:${ACCOUNT}:${PHONE_UNIT}`;
export const DELTA_AFTER = 107;
export const DELTA_THROUGH = 110;
export const DATE = 800_000_000_123_456_789n;
const SECOND = 1_000_000_000n;
const LOCAL = "/Users/synthetic/Library/Messages";
export const BUSINESS_CHAT = "any;-;urn:biz:00000000-0000-0000-0000-000000000000";
export const GROUP_CHAT = "iMessage;+;chat000000000000000001";

const SCHEMA = `
CREATE TABLE _SqliteDatabaseProperties (key TEXT, value TEXT, UNIQUE(key));
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY AUTOINCREMENT UNIQUE, id TEXT NOT NULL, country TEXT, service TEXT NOT NULL, uncanonicalized_id TEXT);
CREATE TABLE chat (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, style INTEGER, state INTEGER, account_id TEXT,
  properties BLOB, chat_identifier TEXT, service_name TEXT, room_name TEXT, account_login TEXT, is_archived INTEGER DEFAULT 0,
  last_addressed_handle TEXT, display_name TEXT, group_id TEXT, is_filtered INTEGER, successful_query INTEGER,
  last_read_message_timestamp INTEGER DEFAULT 0
);
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT NOT NULL, text TEXT, replace INTEGER DEFAULT 0,
  service_center TEXT, handle_id INTEGER DEFAULT 0, subject TEXT, country TEXT, attributedBody BLOB, version INTEGER DEFAULT 0,
  type INTEGER DEFAULT 0, service TEXT, account TEXT, account_guid TEXT, error INTEGER DEFAULT 0, date INTEGER,
  date_read INTEGER, date_delivered INTEGER, is_delivered INTEGER DEFAULT 0, is_finished INTEGER DEFAULT 0,
  is_emote INTEGER DEFAULT 0, is_from_me INTEGER DEFAULT 0, is_empty INTEGER DEFAULT 0, is_delayed INTEGER DEFAULT 0,
  is_auto_reply INTEGER DEFAULT 0, is_prepared INTEGER DEFAULT 0, is_read INTEGER DEFAULT 0, is_system_message INTEGER DEFAULT 0,
  is_sent INTEGER DEFAULT 0, has_dd_results INTEGER DEFAULT 0, is_played INTEGER DEFAULT 0, was_downgraded INTEGER DEFAULT 0,
  did_notify_recipient INTEGER DEFAULT 0, cache_roomnames TEXT, associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0, message_summary_info BLOB, date_edited INTEGER DEFAULT 0,
  date_retracted INTEGER DEFAULT 0, flags INTEGER DEFAULT 0
);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY AUTOINCREMENT, guid TEXT UNIQUE NOT NULL, created_date INTEGER DEFAULT 0, filename TEXT,
  uti TEXT, mime_type TEXT, transfer_state INTEGER DEFAULT 0, is_outgoing INTEGER DEFAULT 0, transfer_name TEXT, total_bytes INTEGER DEFAULT 0
);
CREATE TABLE chat_message_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, message_date INTEGER DEFAULT 0, PRIMARY KEY (chat_id, message_id));
CREATE TABLE chat_handle_join (chat_id INTEGER REFERENCES chat (ROWID) ON DELETE CASCADE, handle_id INTEGER REFERENCES handle (ROWID) ON DELETE CASCADE, UNIQUE(chat_id, handle_id));
CREATE TABLE message_attachment_join (message_id INTEGER REFERENCES message (ROWID) ON DELETE CASCADE, attachment_id INTEGER REFERENCES attachment (ROWID) ON DELETE CASCADE, UNIQUE(message_id, attachment_id));
CREATE TABLE sync_chat_slice (ROWID INTEGER PRIMARY KEY AUTOINCREMENT, service_name TEXT, chat_id TEXT, slice BLOB);
CREATE INDEX chat_message_join_idx_message_id_only ON chat_message_join (message_id);
CREATE INDEX message_attachment_join_idx_message_id ON message_attachment_join (message_id);
CREATE INDEX chat_handle_join_idx_handle_id ON chat_handle_join (handle_id);
INSERT INTO _SqliteDatabaseProperties (key, value) VALUES ('_ClientVersion', '19201'), ('counter_in_all', '9');
`;

type Value = string | number | bigint | Buffer | null;

function insert(db: Database.Database, table: string, row: Record<string, Value>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

interface Message {
  rowid: number;
  guid: string;
  chats: number[];
  date: bigint;
  handle?: number;
  fromMe?: number;
  text?: string | null;
  body?: Buffer | null;
  associated?: [number, string | null];
  summary?: Buffer | null;
  edited?: bigint;
  retracted?: bigint;
  extra?: Record<string, Value>;
}

function message(db: Database.Database, input: Message): void {
  insert(db, "message", {
    ROWID: input.rowid, guid: input.guid, text: input.text === undefined ? `synthetic message ${input.rowid}` : input.text,
    handle_id: input.handle ?? 0, attributedBody: input.body ?? null, service: input.chats[0] === 12 ? "SMS" : "iMessage",
    account: `e:${ACCOUNT}`, date: input.date, date_read: input.fromMe === 1 ? 0 : input.date + SECOND,
    date_delivered: input.date + 1n, is_delivered: 1, is_finished: 1, is_from_me: input.fromMe ?? 0, is_read: input.fromMe === 1 ? 0 : 1,
    is_sent: input.fromMe ?? 0, is_played: 0, was_downgraded: input.rowid % 2, did_notify_recipient: 0,
    associated_message_type: input.associated?.[0] ?? 0, associated_message_guid: input.associated?.[1] ?? null,
    message_summary_info: input.summary ?? null, date_edited: input.edited ?? 0, date_retracted: input.retracted ?? 0,
    flags: 5, ...input.extra,
  });
  for (const chat of input.chats) insert(db, "chat_message_join", { chat_id: chat, message_id: input.rowid, message_date: input.date });
}

function attachment(db: Database.Database, root: string, rowid: number, messageRowid: number, filename: string, bytes: string | null): void {
  insert(db, "attachment", {
    ROWID: rowid, guid: `SYNTH-ATTACHMENT-${rowid}`, filename, mime_type: rowid % 2 === 0 ? "image/heic" : null,
    transfer_name: filename.split("/").pop()!, total_bytes: bytes?.length ?? 0,
  });
  insert(db, "message_attachment_join", { message_id: messageRowid, attachment_id: rowid });
  const at = filename.indexOf("Attachments/");
  if (bytes !== null && at !== -1) {
    const path = join(root, filename.slice(at));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
}

function chat(db: Database.Database, rowid: number, guid: string, style: number, handles: number[], read: bigint): void {
  insert(db, "chat", {
    ROWID: rowid, guid, style, state: 3, account_id: "SYNTH-ACCOUNT", properties: Buffer.from([0x62, 0x70, rowid]),
    chat_identifier: guid.split(";").pop()!, service_name: guid.startsWith("SMS") ? "SMS" : "iMessage", room_name: style === 43 ? guid.split(";").pop()! : null,
    account_login: `E:${ACCOUNT}`, is_archived: 0, last_addressed_handle: "+15550000001", display_name: style === 43 ? "Synthetic Group" : "",
    group_id: `SYNTH-GROUP-${rowid}`, is_filtered: 0, successful_query: 1, last_read_message_timestamp: read,
  });
  for (const handle of handles) insert(db, "chat_handle_join", { chat_id: rowid, handle_id: handle });
}

export interface LiveStore {
  db: string;
  attachments: string;
}

export function macStore(dir: string): LiveStore {
  mkdirSync(dir, { recursive: true });
  const live: LiveStore = { db: join(dir, "chat.db"), attachments: join(dir, "attachments") };
  const db = new Database(live.db);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  const handles: [number, string][] = [
    [1, "+1 (555) 000-0002"], [2, "PERSON-B@EXAMPLE.COM"], [3, "XX-TESTBRAND(smsfp)"], [4, "+15550000003"],
    [5, "55555"], [6, "mailto:Person-C@Example.com"], [7, "person-d@"], [8, "15550000002"],
  ];
  for (const [rowid, id] of handles) insert(db, "handle", { ROWID: rowid, id, country: "us", service: rowid === 3 ? "SMS" : "iMessage", uncanonicalized_id: null });
  chat(db, 10, BUSINESS_CHAT, 45, [1], 700_000_000_000_000_001n);
  chat(db, 11, GROUP_CHAT, 43, [1, 2, 4, 6, 7, 8], 0n);
  chat(db, 12, "SMS;-;XX-TESTBRAND(smsfp)", 45, [3, 5], 800_000_100_000_000_000n);
  chat(db, 13, "iMessage;-;person-e@example.com", 45, [2], 0n);
  message(db, { rowid: 100, guid: "SYNTH-MSG-PLAIN", chats: [10], date: DATE, handle: 1 });
  message(db, { rowid: 101, guid: "SYNTH-MSG-TAP", chats: [10], date: DATE + SECOND, handle: 1, associated: [2001, "p:0/SYNTH-MSG-PLAIN"] });
  message(db, { rowid: 102, guid: "SYNTH-MSG-EDIT", chats: [10], date: DATE + 2n * SECOND, fromMe: 1, body: Buffer.from([0x04, 0x0b, 0xff]), summary: Buffer.from("synthetic edit summary"), edited: DATE + 2n * SECOND + 500_000_000n });
  message(db, { rowid: 103, guid: "SYNTH-MSG-UNSEND", chats: [10], date: DATE + 3n * SECOND, fromMe: 1, retracted: DATE + 3n * SECOND + 1n, text: null });
  message(db, { rowid: 104, guid: "SYNTH-MSG-ATTACH", chats: [11], date: DATE + 4n * SECOND + 999_999n, fromMe: 1 });
  attachment(db, live.attachments, 20, 104, `${LOCAL}/Attachments/ab/01/SYNTH-A/synthetic.heic`, "synthetic attachment bytes\n");
  attachment(db, live.attachments, 21, 104, `${LOCAL}/Attachments/ab/02/SYNTH-B/purged.bin`, null);
  attachment(db, live.attachments, 22, 104, "/private/var/folders/synthetic/transcoding/outside.mov", "synthetic outside bytes\n");
  attachment(db, live.attachments, 23, 104, `~/Library/Messages/Attachments/ab/01/SYNTH-A/synthetic.heic`, "synthetic attachment bytes\n");
  message(db, { rowid: 105, guid: "SYNTH-MSG-RAW", chats: [12], date: DATE + 5n * SECOND, handle: 3, text: "synthetic sender-name line" });
  message(db, { rowid: 106, guid: "SYNTH-MSG-GROUP", chats: [11], date: DATE + 6n * SECOND, handle: 2 });
  message(db, { rowid: 107, guid: "SYNTH-MSG-ORPHAN-HANDLE", chats: [11, 12], date: DATE + 7n * SECOND, handle: 99, text: "synthetic café \u{1F600}" });
  insert(db, "sync_chat_slice", { ROWID: 1, service_name: "iMessage", chat_id: GROUP_CHAT, slice: Buffer.alloc(64, 0x5a) });
  db.exec("COMMIT");
  db.close();
  return live;
}

export function laterTraffic(live: LiveStore): void {
  const db = new Database(live.db);
  db.exec("BEGIN");
  insert(db, "handle", { ROWID: 9, id: "+15550000009", country: "us", service: "iMessage", uncanonicalized_id: null });
  chat(db, 14, "iMessage;-;+15550000009", 45, [9], 0n);
  message(db, { rowid: 108, guid: "SYNTH-MSG-LATER-1", chats: [10], date: DATE + 100n * SECOND, handle: 1 });
  message(db, { rowid: 109, guid: "SYNTH-MSG-LATER-2", chats: [11], date: DATE + 101n * SECOND, fromMe: 1 });
  attachment(db, live.attachments, 24, 109, `${LOCAL}/Attachments/cd/03/SYNTH-C/later.jpg`, "synthetic later attachment\n");
  message(db, { rowid: 110, guid: "SYNTH-MSG-LATER-3", chats: [14], date: DATE + 102n * SECOND, handle: 9 });
  db.prepare("UPDATE chat SET last_read_message_timestamp = ? WHERE ROWID = 10").run(DATE + 100n * SECOND);
  db.exec("COMMIT");
  db.close();
}

export function phoneStore(dir: string): LiveStore {
  mkdirSync(dir, { recursive: true });
  const live: LiveStore = { db: join(dir, "sms.db"), attachments: join(dir, "attachments") };
  const db = new Database(live.db);
  db.exec(SCHEMA);
  db.exec("ALTER TABLE message ADD COLUMN is_preview_sent INTEGER DEFAULT 0");
  db.exec("BEGIN");
  insert(db, "handle", { ROWID: 31, id: "+15550000002", country: "us", service: "iMessage", uncanonicalized_id: "+1 (555) 000-0002" });
  chat(db, 41, BUSINESS_CHAT, 45, [31], 0n);
  message(db, { rowid: 500, guid: "SYNTH-MSG-PLAIN", chats: [41], date: DATE - 789n, handle: 31, extra: { is_preview_sent: 1 } });
  message(db, { rowid: 501, guid: "SYNTH-MSG-EDIT", chats: [41], date: DATE + 2n * SECOND, fromMe: 1, text: "synthetic edited row, as the phone holds it" });
  db.exec("COMMIT");
  db.close();
  return live;
}


export function attachmentIndex(path: string, root: string): Buffer {
  const db = new Database(path, { readonly: true });
  const entries: Record<string, { sha256: string; bytes: number }> = {};
  for (const { filename } of db.prepare("SELECT filename FROM attachment WHERE filename IS NOT NULL").all() as { filename: string }[]) {
    const at = filename.indexOf("Attachments/");
    if (at === -1) continue;
    const tail = filename.slice(at);
    if (!existsSync(join(root, tail))) continue;
    const bytes = readFileSync(join(root, tail));
    entries[tail] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
  }
  db.close();
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]!]));
  return Buffer.from(`${JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries: sorted })}\n`);
}

export function sealSnapshot(live: LiveStore, out: string): Record<string, string> {
  mkdirSync(out, { recursive: true });
  const files = { "messages.db": join(out, "messages.db"), "attachments.json": join(out, "attachments.json") };
  vacuumInto(live.db, files["messages.db"]);
  writeFileSync(files["attachments.json"], attachmentIndex(files["messages.db"], live.attachments));
  return files;
}

export function sealDelta(live: LiveStore, out: string, after: number): Record<string, string> {
  mkdirSync(out, { recursive: true });
  const files = { "messages.db": join(out, "messages.db"), "attachments.json": join(out, "attachments.json") };
  vacuumInto(live.db, files["messages.db"]);
  const db = new Database(files["messages.db"]);
  const keep: [string, string][] = [
    ["message", `ROWID > ${after}`],
    ["chat_message_join", "message_id IN (SELECT ROWID FROM message)"],
    ["message_attachment_join", "message_id IN (SELECT ROWID FROM message)"],
    ["attachment", "ROWID IN (SELECT attachment_id FROM message_attachment_join)"],
    ["chat", "ROWID IN (SELECT chat_id FROM chat_message_join)"],
    ["chat_handle_join", "chat_id IN (SELECT ROWID FROM chat)"],
    ["handle", "ROWID IN (SELECT handle_id FROM chat_handle_join UNION SELECT handle_id FROM message)"],
    ["sync_chat_slice", "FALSE"],
  ];
  for (const [table, predicate] of keep) db.exec(`DELETE FROM ${table} WHERE NOT ((${predicate}) IS TRUE)`);
  db.exec("VACUUM");
  db.close();
  writeFileSync(files["attachments.json"], attachmentIndex(files["messages.db"], live.attachments));
  return files;
}

function vacuumInto(source: string, target: string): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(target);
  db.close();
}

export function bigStore(path: string, messages: number, bytes: number): void {
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  insert(db, "handle", { ROWID: 1, id: "+15550000002", country: "us", service: "iMessage", uncanonicalized_id: null });
  chat(db, 1, "iMessage;-;+15550000002", 45, [1], 0n);
  db.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${messages})
    INSERT INTO message (ROWID, guid, text, handle_id, service, date, is_from_me)
    SELECT x, 'SYNTH-BIG-' || x, hex(randomblob(${Math.ceil(bytes / 2)})), 1, 'iMessage', ${DATE} + x * 1000000000, 0 FROM n;
    INSERT INTO chat_message_join (chat_id, message_id, message_date) SELECT 1, ROWID, date FROM message;
  `);
  db.exec("COMMIT");
  db.close();
}


export const fixture: Fixture = (folder) => {
  const live = macStore(mkdtempSync(join(tmpdir(), "imessage-fixture-")));
  sealSnapshot(live, folder);
  rmSync(dirname(live.db), { recursive: true, force: true });
  return {
    source: MAC_SOURCE, facts: { snapshot_taken_at: "2026-10-03T05:00:00.000Z" }, files: { "messages.db": "trust", "attachments.json": "trust" },
    heads: [
      "chat SMS;-;XX-TESTBRAND(smsfp)", "chat any;-;urn:biz:00000000-0000-0000-0000-000000000000",
      "chat iMessage;+;chat000000000000000001", "chat iMessage;-;person-e@example.com",
      "chat-state macbook-pro-0001:SMS;-;XX-TESTBRAND(smsfp)",
      "chat-state macbook-pro-0001:any;-;urn:biz:00000000-0000-0000-0000-000000000000",
      "chat-state macbook-pro-0001:iMessage;+;chat000000000000000001",
      "chat-state macbook-pro-0001:iMessage;-;person-e@example.com", "msg SYNTH-MSG-ATTACH", "msg SYNTH-MSG-EDIT",
      "msg SYNTH-MSG-GROUP", "msg SYNTH-MSG-ORPHAN-HANDLE", "msg SYNTH-MSG-PLAIN", "msg SYNTH-MSG-RAW", "msg SYNTH-MSG-TAP",
      "msg SYNTH-MSG-UNSEND",
    ],
  };
};


export async function deliver(blobs: BlobStore, source: string, stated_ms: number, files: Record<string, string>, facts: JsonObject = {}): Promise<Delivery> {
  const sealed: Delivery["files"] = [];
  for (const [path, local] of Object.entries(files)) {
    sealed.push({ path, blob: await blobs.putFile(local, path.endsWith(".db") ? { mediaType: "application/vnd.sqlite3" } : {}), size: statSync(local).size });
  }
  return { id: `${source}/${stated_ms}`, source, sealed_ms: stated_ms, stated_ms, facts, files: sealed };
}

export function land(home: HomeDb, delivery: Delivery, rows: Iterable<ReaderOutput>, guards: Record<string, Guard>): Landed {
  return home.commit((tx) => {
    const run = tx.tables.runs.start({ kind: "import", subject: delivery.id, started_ms: delivery.stated_ms });
    const landed = tx.records.land(run, delivery, rows, guards, { has: () => true });
    tx.tables.runs.end(run, { ended_ms: delivery.stated_ms, outcome: "ok", counts: landed as unknown as JsonObject });
    return landed;
  });
}

export interface LandedHead {
  kind: string;
  key: string;
  version: string;
  stated_ms: number;
  start_ms: number | null;
  precision: string | null;
}

export function heads(home: HomeDb, source: string, kinds: string[]): LandedHead[] {
  const view = home.view();
  try {
    return kinds.flatMap((kind) =>
      [...view.records(source, kind)].map(({ head, version }) => ({
        kind, key: head.key, version: head.version, stated_ms: head.stated_ms, start_ms: head.start_ms,
        precision: version.time?.precision ?? null,
      })),
    );
  } finally {
    view.close();
  }
}
