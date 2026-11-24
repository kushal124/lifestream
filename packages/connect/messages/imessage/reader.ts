import { appleInstant, archive, blobIndex, consuming, each, isObject, matches, openDeliveredSqlite, ordered, refuse, requireColumns, rowJson, unitOf, wholeFiles, type BlobReader, type Delivery, type DeliveryFile, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Sqlite, type SqliteRow, type SqliteValue } from "@lifestreamprotocol/connect/sdk";
import { canonicalEmail, canonicalPhone } from "@lifestreamprotocol/core";

export const MESSAGES_FILE = "messages.db";
export const ATTACHMENTS_FILE = "attachments.json";

const REQUIRED: Record<string, readonly string[]> = {
  message: ["guid", "text", "attributedBody", "date", "handle_id", "service", "is_from_me", "associated_message_type",
    "associated_message_guid", "message_summary_info", "date_edited", "date_retracted"],
  chat: ["guid", "style"],
  handle: ["id"],
  chat_message_join: ["chat_id", "message_id"],
  chat_handle_join: ["chat_id", "handle_id"],
  attachment: ["filename", "mime_type", "transfer_name"],
  message_attachment_join: ["message_id", "attachment_id"],
};
const FLAGS = [
  "flags", "did_notify_recipient", "is_archive", "is_audio_message", "is_auto_reply", "is_corrupt", "is_critical",
  "is_delayed", "is_delivered", "is_emote", "is_empty", "is_expirable", "is_forward", "is_from_me", "is_kt_verified",
  "is_pending_satellite_send", "is_prepared", "is_sent", "is_service_message", "is_sos", "is_spam", "is_stewie",
  "is_system_message", "was_data_detected", "was_deduplicated", "was_delivered_quietly", "was_detonated", "was_downgraded",
] as const;
const CHAT_STATE = [
  "account_id", "account_login", "cloudkit_record_id", "display_name", "engram_id", "group_id", "is_archived",
  "is_blackholed", "is_deleting_incoming_messages", "is_filtered", "is_pending_review", "is_recovered",
  "last_addressed_sim_id", "last_read_message_timestamp", "original_group_id", "properties", "room_name",
  "server_change_token", "state", "successful_query", "syndication_date", "syndication_type",
] as const;
const COLUMNS: Record<string, readonly string[]> = {
  message: ["ROWID", "guid", "text", "replace", "service_center", "handle_id", "subject", "country", "attributedBody",
    "version", "type", "service", "account", "account_guid", "error", "date", "date_read", "date_delivered", "is_delivered",
    "is_finished", "is_emote", "is_from_me", "is_empty", "is_delayed", "is_auto_reply", "is_prepared", "is_read",
    "is_system_message", "is_sent", "has_dd_results", "is_service_message", "is_forward", "was_downgraded", "is_archive",
    "cache_has_attachments", "cache_roomnames", "was_data_detected", "was_deduplicated", "is_audio_message", "is_played",
    "date_played", "item_type", "other_handle", "group_title", "group_action_type", "share_status", "share_direction",
    "is_expirable", "expire_state", "message_action_type", "message_source", "associated_message_guid",
    "associated_message_type", "balloon_bundle_id", "payload_data", "expressive_send_style_id",
    "associated_message_range_location", "associated_message_range_length", "time_expressive_send_played",
    "message_summary_info", "ck_sync_state", "ck_record_id", "ck_record_change_tag", "destination_caller_id", "is_corrupt",
    "reply_to_guid", "sort_id", "is_spam", "has_unseen_mention", "thread_originator_guid", "thread_originator_part",
    "syndication_ranges", "synced_syndication_ranges", "was_delivered_quietly", "did_notify_recipient", "date_retracted",
    "date_edited", "was_detonated", "part_count", "is_stewie", "is_sos", "is_critical", "bia_reference_id", "is_kt_verified",
    "fallback_hash", "associated_message_emoji", "is_pending_satellite_send", "needs_relay", "schedule_type",
    "schedule_state", "sent_or_received_off_grid", "date_recovered", "is_time_sensitive", "ck_chat_id", "index_state", "flags"],
  chat: ["ROWID", "guid", "style", "chat_identifier", "service_name", "service", "last_addressed_handle", "ck_sync_state",
    ...CHAT_STATE],
  handle: ["ROWID", "id", "country", "service", "uncanonicalized_id", "person_centric_id"],
  chat_message_join: ["chat_id", "message_id", "message_date", "index_state"],
  chat_handle_join: ["chat_id", "handle_id"],
  attachment: ["ROWID", "guid", "created_date", "start_date", "filename", "uti", "mime_type", "transfer_state", "is_outgoing",
    "user_info", "transfer_name", "total_bytes", "is_sticker", "sticker_user_info", "attribution_info", "hide_attachment",
    "ck_sync_state", "ck_server_change_token_blob", "ck_record_id", "original_guid", "is_commsafety_sensitive",
    "emoji_image_content_identifier", "emoji_image_short_description", "preview_generation_state"],
  message_attachment_join: ["message_id", "attachment_id"],
};
const NANOSECONDS_FLOOR = 1_000_000_000_000_000n;

export function imessageBlobs(content: Json): string[] {
  const attachments = isObject(content) && Array.isArray(content.attachments) ? content.attachments : [];
  const blobs: string[] = [];
  for (const attachment of attachments) {
    const hash = isObject(attachment) ? attachment.hash : undefined;
    if (typeof hash === "string" && !blobs.includes(hash)) blobs.push(hash);
  }
  return blobs;
}

export const imessageConnector: Reader = {
  name: "imessage-db",
  kinds: { msg: msgGuard, chat: chatGuard, "chat-state": chatStateGuard },
  read,
  columns: COLUMNS,
};

async function* read(delivery: Delivery, files: BlobReader): AsyncGenerator<ReaderOutput> {
  const unit = unitOf(delivery.source);
  let read: Member[] = [];
  yield* consuming(delivery, archive(delivery, files, async function* (members) {
    const messages = delivered(members, MESSAGES_FILE) ?? refuse(`the delivery carries no ${MESSAGES_FILE}`);
    const indexFile = delivered(members, ATTACHMENTS_FILE);
    const index = indexFile === undefined ? undefined : blobIndex(files.bytes(indexFile.blob));
    const db = await openDeliveredSqlite(files, messages);
    try {
      yield* store(db, index, unit);
    } finally {
      db.close();
    }
    read = wholeFiles(members, (member) => member.file === messages || member.file === indexFile);
  }), () => read);
}

interface Handle extends JsonObject {
  raw: string;
  canonical: string;
  kind: "phone" | "email" | "raw";
}

async function* store(db: Sqlite, index: Map<string, { blob: string; size: number }> | undefined, unit: string): AsyncGenerator<ReaderOutput> {
  const tables = db.tables();
  if (!tables.includes("_SqliteDatabaseProperties")) refuse("the file has no _SqliteDatabaseProperties table");
  requireColumns(db, "the file", REQUIRED);
  clientVersion(db);
  const messageColumns = db.columns("message");
  const flagColumns = FLAGS.filter((column) => messageColumns.includes(column));
  const chatColumns = db.columns("chat");
  const serviceColumn = chatColumns.includes("service_name") ? "service_name" : chatColumns.includes("service") ? "service" : refuse("chat has neither service_name nor service");
  const stateColumns = CHAT_STATE.filter((column) => chatColumns.includes(column));

  const newest = new Map<bigint, bigint>();

  yield* each(db.rows("message", "ROWID"), (part) => part.where, function* (part) {
    const row = part.read();
    const rowid = row.ROWID as bigint;
    const guid = text(row.guid, `message row ${rowid}.guid`);
    const where = `message ${guid}`;
    const date = integer(row.date, `${where}.date`);
    const time = nanoseconds(date, `${where}.date`);
    const fromMe = integer(row.is_from_me, `${where}.is_from_me`);
    if (fromMe !== 0n && fromMe !== 1n) refuse(`${where}.is_from_me is not 0 or 1`);
    const senderRow = fromMe === 0n ? db.get("SELECT id FROM handle WHERE ROWID = ?", row.handle_id ?? null) : undefined;
    const sender = senderRow === undefined ? null : handle(senderRow.id, `${where} sender`);
    const participants = handles(
      db.all(
        `SELECT h.id FROM chat_message_join cmj JOIN chat_handle_join chj ON chj.chat_id = cmj.chat_id
           JOIN handle h ON h.ROWID = chj.handle_id WHERE cmj.message_id = ?`,
        rowid,
      ),
      `${where} participant`,
    );
    const attachments = ordered(
      db.all(
        `SELECT a.filename, a.mime_type, a.transfer_name FROM message_attachment_join maj
           JOIN attachment a ON a.ROWID = maj.attachment_id WHERE maj.message_id = ?`,
        rowid,
      ).map((attachment, ordinal) => {
        const at = `${where} attachment ${ordinal}`;
        const tail = attachmentTail(text(attachment.filename, `${at}.filename`));
        const entry = tail === null ? undefined : index?.get(tail);
        return {
          hash: entry?.blob ?? null,
          bytes: entry?.size ?? null,
          mime_type: nullableText(attachment.mime_type, `${at}.mime_type`),
          transfer_name: nullableText(attachment.transfer_name, `${at}.transfer_name`),
        };
      }),
    );
    const flags: SqliteRow = {};
    for (const column of flagColumns) flags[column] = row[column]!;
    const content: JsonObject = {
      type: "imessage.msg",
      guid,
      sender,
      recipients: sender === null ? participants : participants.filter((other) => other.canonical !== sender.canonical || other.kind !== sender.kind),
      text: nullableText(row.text, `${where}.text`),
      attributedBody: bytes(row.attributedBody, `${where}.attributedBody`),
      date: date === null ? null : cell(date),
      service: text(row.service, `${where}.service`),
      flags: rowJson(flags),
      associated_message_type: nullableInteger(row.associated_message_type, `${where}.associated_message_type`),
      associated_message_guid: nullableText(row.associated_message_guid, `${where}.associated_message_guid`),
      message_summary_info: bytes(row.message_summary_info, `${where}.message_summary_info`),
      date_edited: nullableInteger(row.date_edited, `${where}.date_edited`),
      date_retracted: nullableInteger(row.date_retracted, `${where}.date_retracted`),
      attachments,
    };
    const hashes = imessageBlobs(content);

    yield {
      kind: "msg",
      key: guid,
      content,
      ...(time === undefined ? {} : { time }),
      ...(hashes.length === 0 ? {} : { blobs: hashes }),
      device: unit,
      locator: `message row ${rowid}`,
    };

    for (const member of db.all("SELECT chat_id FROM chat_message_join WHERE message_id = ?", rowid)) {
      const chat = member.chat_id as bigint;
      const held = newest.get(chat);
      if (date !== null && (held === undefined || date > held)) newest.set(chat, date);
    }
  });

  yield* each(db.rows("chat", "ROWID"), (part) => part.where, function* (part) {
    const row = part.read();
    const rowid = row.ROWID as bigint;
    const guid = text(row.guid, `chat row ${rowid}.guid`);
    const where = `chat ${guid}`;
    const date = newest.get(rowid);
    const time = date === undefined ? undefined : nanoseconds(date, `${where} newest member date`);
    yield {
      kind: "chat",
      key: guid,
      content: {
        type: "imessage.chat",
        guid,
        style: cell(integer(row.style, `${where}.style`) ?? refuse(`${where}.style is not an integer`)),
        service: text(row[serviceColumn], `${where}.${serviceColumn}`),
        participants: handles(
          db.all("SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.ROWID = chj.handle_id WHERE chj.chat_id = ?", rowid),
          `${where} participant`,
        ),
      },
      ...(time === undefined ? {} : { time }),
      device: unit,
      locator: `chat row ${rowid}`,
    };
    const state: SqliteRow = {};
    for (const column of stateColumns) state[column] = row[column]!;
    yield {
      kind: "chat-state",
      key: `${unit}:${guid}`,
      content: { type: "imessage.chat-state", chat_guid: guid, unit_id: unit, state: rowJson(state) },
      device: unit,
      locator: `chat row ${rowid}`,
    };
  });
}

function clientVersion(db: Sqlite): string {
  const columns = db.columns("_SqliteDatabaseProperties");
  const rows = columns.includes("key") && columns.includes("value")
    ? db.all("SELECT value AS version FROM _SqliteDatabaseProperties WHERE key = '_ClientVersion'")
    : columns.includes("_ClientVersion")
      ? db.all("SELECT _ClientVersion AS version FROM _SqliteDatabaseProperties WHERE _ClientVersion IS NOT NULL")
      : refuse("_SqliteDatabaseProperties cannot state _ClientVersion");
  if (rows.length !== 1) refuse(`_SqliteDatabaseProperties states ${rows.length} _ClientVersion rows, not one`);
  const version = rows[0]!.version;
  if ((typeof version !== "string" && typeof version !== "bigint" && typeof version !== "number") || String(version) === "") {
    refuse("_SqliteDatabaseProperties._ClientVersion is empty");
  }
  return String(version);
}


function handle(value: SqliteValue | undefined, where: string): Handle {
  const raw = text(value, where);
  const phone = canonicalPhone(raw);
  if (phone !== null) return { raw, canonical: phone, kind: "phone" };
  const email = canonicalEmail(raw);
  return email === null ? { raw, canonical: raw, kind: "raw" } : { raw, canonical: email, kind: "email" };
}

function handles(rows: SqliteRow[], where: string): Handle[] {
  const distinct = new Map<string, Handle>();
  rows.forEach((row, ordinal) => {
    const found = handle(row.id, `${where} ${ordinal}`);
    distinct.set(`${found.kind}\u0000${found.canonical}\u0000${found.raw}`, found);
  });
  return ordered([...distinct.values()]);
}

function attachmentTail(filename: string): string | null {
  const normalized = filename.replaceAll("\\", "/");
  const at = normalized.indexOf("Attachments/");
  return at === -1 ? null : normalized.slice(at);
}


function nanoseconds(value: bigint | null, where: string): Instant | undefined {
  if (value !== null && value > 0n && value < NANOSECONDS_FLOOR) refuse(`${where} ${value} is not a nanosecond date`);
  return appleInstant(value, "apple-ns", where);
}

function cell(value: bigint): Json {
  return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
}

function text(value: SqliteValue | undefined, where: string): string {
  if (typeof value !== "string" || value.length === 0) refuse(`${where} is not non-empty text`);
  return value;
}

function nullableText(value: SqliteValue | undefined, where: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") refuse(`${where} is not text`);
  return value;
}

function integer(value: SqliteValue | undefined, where: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "bigint") refuse(`${where} is not an integer`);
  return value;
}

function nullableInteger(value: SqliteValue | undefined, where: string): Json {
  const read = integer(value, where);
  return read === null ? null : cell(read);
}

function bytes(value: SqliteValue | undefined, where: string): Json {
  if (value === null || value === undefined) return null;
  if (!Buffer.isBuffer(value)) refuse(`${where} is not a BLOB`);
  return { $bytes64: value.toString("base64") };
}

function delivered(members: readonly Member[], name: string): DeliveryFile | undefined {
  const member = members.find((found) => matches(name, found.name));
  if (member === undefined) return undefined;
  return member.file ?? refuse(`${member.where} is inside an archive: hand its folder`);
}


type Check = (value: Json | undefined) => boolean;

const nullableString: Check = (value) => value === null || typeof value === "string";
const nonEmptyString: Check = (value) => typeof value === "string" && value.length > 0;
const integral: Check = (value) =>
  (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && /^-?[1-9]\d{15,}$/u.test(value));
const nullableIntegral: Check = (value) => value === null || integral(value);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const inlineBytes: Check = (value) => isObject(value) && Object.keys(value).length === 1 && typeof value.$bytes64 === "string" && BASE64.test(value.$bytes64);
const nullableBytes: Check = (value) => value === null || inlineBytes(value);
const BLOB = /^sha256:[0-9a-f]{64}$/u;
const cellValue: Check = (value) => value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) || inlineBytes(value);
const cells: Check = (value) => isObject(value) && Object.values(value).every(cellValue);

function exact(value: Json | undefined, members: Record<string, Check>, where: string): string[] {
  if (!isObject(value)) return [`${where} is not an object`];
  const violations: string[] = [];
  const names = Object.keys(members);
  for (const name of Object.keys(value)) if (!names.includes(name)) violations.push(`${where}.${name} is not a member`);
  for (const [name, check] of Object.entries(members)) {
    if (!(name in value)) violations.push(`${where}.${name} is missing`);
    else if (!check(value[name])) violations.push(`${where}.${name} is not what the kind states`);
  }
  return violations;
}

const isHandle: Check = (value) =>
  exact(value, { raw: nonEmptyString, canonical: nonEmptyString, kind: (kind) => kind === "phone" || kind === "email" || kind === "raw" }, "handle").length === 0;

const isAttachment: Check = (value) => {
  if (!isObject(value)) return false;
  const shaped = exact(value, {
    hash: (hash) => hash === null || (typeof hash === "string" && BLOB.test(hash)),
    bytes: (size) => size === null || (typeof size === "number" && Number.isSafeInteger(size) && size >= 0),
    mime_type: nullableString,
    transfer_name: nullableString,
  }, "attachment").length === 0;
  return shaped && (value.hash === null) === (value.bytes === null);
};

function msgGuard(content: Json): string[] {
  return exact(content, {
    type: (value) => value === "imessage.msg",
    guid: nonEmptyString,
    sender: (value) => value === null || isHandle(value),
    recipients: (value) => Array.isArray(value) && value.every(isHandle),
    text: nullableString,
    attributedBody: nullableBytes,
    date: nullableIntegral,
    service: nonEmptyString,
    flags: cells,
    associated_message_type: nullableIntegral,
    associated_message_guid: nullableString,
    message_summary_info: nullableBytes,
    date_edited: nullableIntegral,
    date_retracted: nullableIntegral,
    attachments: (value) => Array.isArray(value) && value.every(isAttachment),
  }, "msg");
}

function chatGuard(content: Json): string[] {
  const violations = exact(content, {
    type: (value) => value === "imessage.chat",
    guid: nonEmptyString,
    style: integral,
    service: nonEmptyString,
    participants: (value) => Array.isArray(value) && value.every(isHandle),
  }, "chat");
  if (violations.length > 0) return violations;
  const participants = (content as JsonObject).participants as Handle[];
  const distinct = new Set(participants.map((one) => `${one.kind}\u0000${one.canonical}\u0000${one.raw}`));
  return distinct.size === participants.length ? [] : ["chat.participants name one handle twice"];
}

function chatStateGuard(content: Json): string[] {
  return exact(content, {
    type: (value) => value === "imessage.chat-state",
    chat_guid: nonEmptyString,
    unit_id: nonEmptyString,
    state: cells,
  }, "chat-state");
}
