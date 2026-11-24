import { attempt, basicInstant, each, fingerprint, instant, isObject, openDeliveredSqlite, ordered, refuse, Refused, refusedFile, requireColumns, rowJson, span, together, tryInstant, unitOf, type Guard, type Instant, type JsonObject, type Reader, type ReaderOutput, type Sqlite, type SqliteRow } from "@lifestreamprotocol/connect/sdk";

export const EVENT = "event";
export const REMINDER = "reminder";
export const CALENDAR_FILE = "calendar.sqlite";
const REMINDER_ENTITY = 3n;

const ITEM_POINTERS = [
  "ROWID", "calendar_id", "orig_item_id", "location_id", "client_location_id", "start_location_id", "end_location_id",
  "organizer_id", "self_attendee_id", "suggested_event_info_id", "error_id", "image_id", "color_id",
];
const CALENDAR_COLUMNS = [
  "UUID", "external_id", "title", "type", "color", "symbolic_color_name", "supported_entity_types", "notes", "locale",
  "sharing_status", "sharing_invitation_response", "shared_owner_name", "shared_owner_address", "invitation_status",
  "self_identity_email", "self_identity_phone_number", "owner_identity_email", "owner_identity_phone_number",
  "published_URL", "is_published", "subscription_id", "subcal_url", "subcal_account_id", "pubcal_account_id", "max_attendees",
];
const STORE_COLUMNS = [
  "name", "type", "external_id", "persistent_id", "owner_name", "constraint_path", "creator_bundle_id",
  "delegated_account_owner_store_id", "app_group_id",
];
const KEY_COLUMNS = ["unique_identifier", "calendar_id", "orig_item_id", "orig_date", "all_day", "summary", "start_date", "end_date"];
const LOCATION_OWNERS = ["ROWID", "item_owner_id", "alarm_owner_id", "start_loc_owner_id", "end_loc_owner_id", "client_loc_owner_id"];
const PARTICIPANT_POINTERS = ["ROWID", "owner_id", "identity_id"];

const REQUIRED: Record<string, string[]> = {
  CalendarItem: ["ROWID", "unique_identifier", "entity_type", "calendar_id", "orig_item_id", "orig_date", "all_day", "start_date", "start_tz", "end_date"],
  Calendar: ["ROWID", "store_id", "UUID", "title"],
  Store: ["ROWID", "name", "type"],
  _SqliteDatabaseProperties: ["key", "value"],
};

const OWNED: { member: string; table: string; owner: string; drop: string[] }[] = [
  { member: "participants", table: "Participant", owner: "owner_id", drop: PARTICIPANT_POINTERS },
  { member: "recurrences", table: "Recurrence", owner: "owner_id", drop: ["ROWID", "owner_id"] },
  { member: "exception_dates", table: "ExceptionDate", owner: "owner_id", drop: ["ROWID", "owner_id"] },
  { member: "alarms", table: "Alarm", owner: "calendaritem_owner_id", drop: ["ROWID", "calendaritem_owner_id", "calendar_owner_id", "location_id", "orig_alarm_id"] },
  { member: "attachments", table: "Attachment", owner: "owner_id", drop: ["ROWID", "owner_id", "file_id"] },
  { member: "conferences", table: "Conference", owner: "owner_id", drop: ["ROWID", "owner_id"] },
  { member: "categories", table: "CategoryLink", owner: "owner_id", drop: ["ROWID", "owner_id", "category_id"] },
  { member: "actions", table: "EventAction", owner: "event_id", drop: ["ROWID", "event_id"] },
  { member: "contacts", table: "Contact", owner: "owner_id", drop: ["ROWID", "owner_id"] },
];
const POINTED: { member: string; pointer: string; table: string; drop: string[] }[] = [
  { member: "location", pointer: "location_id", table: "Location", drop: LOCATION_OWNERS },
  { member: "start_location", pointer: "start_location_id", table: "Location", drop: LOCATION_OWNERS },
  { member: "end_location", pointer: "end_location_id", table: "Location", drop: LOCATION_OWNERS },
  { member: "client_location", pointer: "client_location_id", table: "Location", drop: LOCATION_OWNERS },
  { member: "organizer", pointer: "organizer_id", table: "Participant", drop: PARTICIPANT_POINTERS },
  { member: "self_attendee", pointer: "self_attendee_id", table: "Participant", drop: PARTICIPANT_POINTERS },
  { member: "suggestion", pointer: "suggested_event_info_id", table: "SuggestedEventInfo", drop: ["ROWID", "owner_id"] },
  { member: "error", pointer: "error_id", table: "Error", drop: ["ROWID", "store_owner_id", "calendar_owner_id", "calendaritem_owner_id"] },
  { member: "image", pointer: "image_id", table: "Image", drop: ["ROWID", "store_id"] },
  { member: "color", pointer: "color_id", table: "Color", drop: ["ROWID", "store_id"] },
];
const MEMBERS = ["type", "item", "calendar", "store", ...POINTED.map((each) => each.member), ...OWNED.map((each) => each.member)];

const item: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join() !== [...MEMBERS].sort().join()) return [`members must be exactly ${MEMBERS.join(", ")}`];
  const problems: string[] = [];
  if (content.type !== "apple.calendar-item") problems.push("type must be apple.calendar-item");
  if (!isObject(content.item)) problems.push("item must be the row's stated columns");
  for (const member of ["calendar", "store", ...POINTED.map((each) => each.member)]) {
    if (content[member] !== null && !isObject(content[member])) problems.push(`${member} must be an object or null`);
  }
  for (const { member } of OWNED) {
    if (!Array.isArray(content[member]) || !content[member].every(isObject)) problems.push(`${member} must be an array of objects`);
  }
  return problems;
};

export const appleCalendar: Reader = {
  name: "calendar-mac",
  kinds: { [EVENT]: item, [REMINDER]: item },
  async *read(delivery, files) {
    const store = delivery.files.find((entry) => entry.path === CALENDAR_FILE) ?? refuse(`the delivery carries no ${CALENDAR_FILE}`);
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, store);
    try {
      checkSchema(db);
      const declared = new Set(db.tables());
      const repeats = new Map<string, number>();
      const unkeyed = new Set<string>();
      for await (const part of db.rows("CalendarItem", "ROWID", { columns: KEY_COLUMNS })) {
        const key = attempt(() => placed(db, part.read()).key);
        if (key instanceof Refused) {
          unkeyed.add(part.where);
          yield refusedFile(part.where, key.message);
        } else repeats.set(key, (repeats.get(key) ?? 0) + 1);
      }
      const release = together(repeats);
      yield* each(db.rows("CalendarItem", "ROWID"), (part) => part.where, function* (part) {
        if (unkeyed.has(part.where)) return;
        const row = part.read();
        const { key, calendar } = placed(db, row);
        const account = calendar !== undefined && typeof calendar.store_id === "bigint" ? db.get("SELECT * FROM Store WHERE ROWID = ?", calendar.store_id) : undefined;
        const content: JsonObject = {
          type: "apple.calendar-item",
          item: stated(row, ITEM_POINTERS),
          calendar: calendar === undefined ? null : named(calendar, CALENDAR_COLUMNS),
          store: account === undefined ? null : named(account, STORE_COLUMNS),
        };
        for (const { member, pointer, table, drop } of POINTED) {
          const target = row[pointer];
          const found = declared.has(table) && typeof target === "bigint" && target > 0n ? db.get(`SELECT * FROM "${table}" WHERE ROWID = ?`, target) : undefined;
          content[member] = found === undefined ? null : table === "Participant" ? participant(db, found) : stated(found, drop);
        }
        for (const { member, table, owner, drop } of OWNED) {
          const children = declared.has(table) ? db.all(`SELECT * FROM "${table}" WHERE "${owner}" = ? ORDER BY ROWID`, row.ROWID as bigint) : [];
          content[member] = ordered(children.map((child) => owned(db, declared, table, child, drop)));
        }
        const read: ReaderOutput = {
          kind: row.entity_type === REMINDER_ENTITY ? REMINDER : EVENT,
          key,
          content,
          ...timed(row),
          device,
          locator: `CalendarItem row ${String(row.ROWID)}`,
        };
        yield* release.row(read);
      });
      yield* release.rest();
    } finally {
      db.close();
    }
  },
};

function placed(db: Sqlite, row: SqliteRow): { key: string; calendar: SqliteRow | undefined } {
  const series = typeof row.orig_item_id === "bigint" && row.orig_item_id > 0n
    ? db.get("SELECT * FROM CalendarItem WHERE ROWID = ?", row.orig_item_id) ?? row
    : undefined;
  const calendar = typeof row.calendar_id === "bigint" ? db.get("SELECT * FROM Calendar WHERE ROWID = ?", row.calendar_id) : undefined;
  return { key: `${meetingKey(row, series)}:${calendarName(calendar)}`, calendar };
}

function meetingKey(row: SqliteRow, series: SqliteRow | undefined): string {
  const uid = text(series?.unique_identifier) ?? text(row.unique_identifier);
  const base = uid ?? fingerprint(rowJson({
    summary: row.summary ?? null, start_date: row.start_date ?? null, end_date: row.end_date ?? null, all_day: row.all_day ?? null,
  }));
  const original = seconds(row.orig_date);
  if (series === undefined || original === undefined) return base;
  const occurrence = tryInstant(original, "apple-s");
  if (occurrence === undefined) return base;
  const allDay = (series.all_day ?? row.all_day) === 1n;
  return `${base}:${allDay ? utcDate(occurrence.start_ms).replaceAll("-", "") : basicInstant(Math.floor(occurrence.start_ms / 1000) * 1000)}`;
}

function calendarName(calendar: SqliteRow | undefined): string {
  return (text(calendar?.external_id) ?? text(calendar?.UUID) ?? "").replaceAll("%", "%25").replaceAll(":", "%3A");
}

function timed(row: SqliteRow): { time?: Instant } {
  const startSeconds = seconds(row.start_date);
  const endSeconds = seconds(row.end_date);
  const start = startSeconds === undefined ? undefined : tryInstant(startSeconds, "apple-s");
  if (start === undefined) return {};
  const end = endSeconds === undefined ? undefined : tryInstant(endSeconds, "apple-s");
  if (row.all_day === 1n) {
    const first = instant(utcDate(start.start_ms), "date");
    const endMs = end === undefined ? start.start_ms : end.start_ms % 86_400_000 === 0 && end.start_ms > start.start_ms ? end.start_ms - 1 : end.start_ms;
    const last = instant(utcDate(endMs), "date");
    return { time: last.start_ms >= first.start_ms ? span(first, last) : first };
  }
  if (typeof row.start_tz !== "string" || row.start_tz === "_float") return {};
  return { time: end !== undefined && end.start_ms >= start.start_ms ? span(start, end) : start };
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : undefined;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function participant(db: Sqlite, row: SqliteRow): JsonObject {
  const out = stated(row, PARTICIPANT_POINTERS);
  const identity = typeof row.identity_id === "bigint" && row.identity_id > 0n ? db.get("SELECT * FROM Identity WHERE rowid = ?", row.identity_id) : undefined;
  if (identity !== undefined) out.identity = stated(identity, []);
  return out;
}

function owned(db: Sqlite, declared: Set<string>, table: string, row: SqliteRow, drop: string[]): JsonObject {
  if (table === "Participant") return participant(db, row);
  const out = stated(row, drop);
  const resolve = (member: string, pointer: string, target: string, without: string[]): void => {
    const id = row[pointer];
    const found = typeof id === "bigint" && id > 0n && declared.has(target) ? db.get(`SELECT * FROM "${target}" WHERE ROWID = ?`, id) : undefined;
    if (found !== undefined) out[member] = stated(found, without);
  };
  if (table === "Alarm") resolve("location", "location_id", "Location", LOCATION_OWNERS);
  if (table === "Attachment") resolve("file", "file_id", "AttachmentFile", ["ROWID", "store_id"]);
  if (table === "CategoryLink") resolve("category", "category_id", "Category", ["ROWID"]);
  return out;
}

function stated(row: SqliteRow, without: string[]): JsonObject {
  const kept: SqliteRow = {};
  for (const [column, value] of Object.entries(row)) if (value !== null && !without.includes(column)) kept[column] = value;
  return rowJson(kept);
}

function named(row: SqliteRow, columns: string[]): JsonObject {
  return stated(Object.fromEntries(columns.filter((column) => column in row).map((column) => [column, row[column]!])), []);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function checkSchema(db: Sqlite): void {
  requireColumns(db, CALENDAR_FILE, REQUIRED);
  for (const { table, owner } of OWNED) {
    const declared = db.columns(table);
    if (declared.length > 0 && !declared.includes(owner)) refuse(`${CALENDAR_FILE} ${table} lacks ${owner}, which names its item`);
  }
}
