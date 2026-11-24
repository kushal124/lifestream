import { appleInstant, archive, consuming, each, instantOf, isObject, matches, openDeliveredSqlite, ordered, refuse, requireColumns, rowJson, span, unitOf, wholeFiles, type DeliveryFile, type Guard, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Sqlite, type SqliteRow } from "@lifestreamprotocol/connect/sdk";

export const CALL = "call";
export const CALLHISTORY_FILE = "callhistory.sqlite";

const INTEGER = [
  "ZANSWERED", "ZAUTOANSWEREDREASON", "ZCALLDIRECTORYIDENTITYTYPE", "ZCALL_CATEGORY", "ZCALLTYPE", "ZDISCONNECTED_CAUSE",
  "ZFACE_TIME_DATA", "ZFILTERED_OUT_REASON", "ZHANDLE_TYPE", "ZHASMESSAGE", "ZJUNKCONFIDENCE", "ZNUMBER_AVAILABILITY",
  "ZORIGINATED", "ZREAD", "ZSCREENSHARINGTYPE", "ZUSEDEMERGENCYVIDEOSTREAMING", "ZVERIFICATIONSTATUS", "ZWASEMERGENCYCALL",
  "ZCOMMUNICATIONTRUSTSCORE", "ZNEEDEDSCANNOUNCEMENT", "ZORIGINATINGUITYPE",
];
const TEXT = [
  "ZADDRESS", "ZBLOCKEDBYEXTENSION", "ZBLOCKEDBYEXTENSIONNAME", "ZIDENTITYEXTENSION", "ZISO_COUNTRY_CODE",
  "ZJUNKIDENTIFICATIONCATEGORY", "ZLOCATION", "ZNAME", "ZSERVICE_PROVIDER", "ZUNIQUE_ID", "ZIMAGEURL", "ZORIGINATINGDEVICENAME",
];
const BLOB = ["ZCONVERSATIONID", "ZLOCALPARTICIPANTUUID", "ZOUTGOINGLOCALPARTICIPANTUUID", "ZPARTICIPANTGROUPUUID", "ZREMINDERUUID"];
const NUMERIC = ["ZDATE", "ZDURATION"];
const STATED = [...INTEGER, ...NUMERIC, ...TEXT, ...BLOB];
const BOOKKEEPING = ["Z_PK", "Z_ENT", "Z_OPT"];
const INITIATOR = "ZINITIATOR";
const HANDLE = ["ZTYPE", "ZNORMALIZEDVALUE", "ZVALUE"];
const MEDIA = ["ZEMERGENCYMEDIATYPE", "ZASSETID"];
const JOIN = "Z_2REMOTEPARTICIPANTHANDLES";
const MEDIA_TABLE = "ZEMERGENCYMEDIAITEM";

const TABLES: [string, string[]][] = [
  ["ZCALLRECORD", [...STATED, ...BOOKKEEPING, INITIATOR]],
  ["ZHANDLE", [...HANDLE, "Z_PK", "Z_ENT", "Z_OPT"]],
  [JOIN, ["Z_2REMOTEPARTICIPANTCALLS", "Z_4REMOTEPARTICIPANTHANDLES"]],
  [MEDIA_TABLE, [...MEDIA, "Z_PK", "Z_ENT", "Z_OPT", "ZUPLOADEDFORCALL"]],
];

const MEMBERS = ["call", "emergency_media", "handles", "initiator", "type"];
const IDENTITY: Readonly<Record<string, readonly string[]>> = {
  ZCALLRECORD: ["Z_PK", "ZUNIQUE_ID"],
  ZHANDLE: ["Z_PK"],
  [JOIN]: ["Z_2REMOTEPARTICIPANTCALLS", "Z_4REMOTEPARTICIPANTHANDLES"],
};

const call: Guard = (content) => {
  if (!isObject(content) || !["call", "handles", "type"].every((member) => member in content) || !Object.keys(content).every((member) => MEMBERS.includes(member))) {
    return ["members must be type, call, handles and, where the store has them, initiator and emergency_media"];
  }
  const problems: string[] = [];
  if (content.type !== "apple.call") problems.push("type must be apple.call");
  const record = content.call;
  if (!isObject(record)) problems.push("call must be an object");
  else {
    const unread = Object.keys(record).filter((column) => !STATED.includes(column));
    if (unread.length > 0) problems.push(`call states columns this connector does not read: ${unread.join(", ")}`);
    for (const column of INTEGER) if (column in record && !nullableInteger(record[column])) problems.push(`call ${column} must be an integer or null`);
    for (const column of TEXT) if (column in record && !nullableText(record[column])) problems.push(`call ${column} must be text or null`);
    for (const column of BLOB) if (column in record && record[column] !== null && !bytes(record[column])) problems.push(`call ${column} must be bytes or null`);
    if (typeof record.ZUNIQUE_ID !== "string" || record.ZUNIQUE_ID === "") problems.push("call ZUNIQUE_ID must be non-empty text");
    if ("ZDATE" in record && record.ZDATE !== null && typeof record.ZDATE !== "number") problems.push("call ZDATE must be a number, or null");
    if ("ZDURATION" in record && record.ZDURATION !== null && !(typeof record.ZDURATION === "number" && record.ZDURATION >= 0)) problems.push("call ZDURATION must be a number from zero, or null");
  }
  if ("initiator" in content && content.initiator !== null && !handle(content.initiator ?? null)) problems.push("initiator must be a handle or null");
  if (!Array.isArray(content.handles) || !content.handles.every(handle)) problems.push("handles must be handles");
  if ("emergency_media" in content && !(Array.isArray(content.emergency_media) && content.emergency_media.every(media))) problems.push("emergency_media must be media items");
  return problems;
};

export const callHistory: Reader = {
  name: "callhistory-mac",
  kinds: { [CALL]: call },
  columns: Object.fromEntries(TABLES),
  async *read(delivery, files) {
    const device = unitOf(delivery.source);
    let read: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, async function* (members): AsyncGenerator<ReaderOutput> {
      const file = delivered(members, CALLHISTORY_FILE) ?? refuse(`the delivery carries no ${CALLHISTORY_FILE}`);
      const db = await openDeliveredSqlite(files, file);
      try {
        const shape = shapeOf(db);
        yield* each(db.rows("ZCALLRECORD", "Z_PK"), (part) => part.where, function* (part) {
          const row = part.read();
          const pk = row.Z_PK as bigint;
          const locator = `ZCALLRECORD row ${pk}`;
          const record = pick(row, shape.call);
          const initiator = !shape.initiated || row.ZINITIATOR === null ? null : db.get("SELECT * FROM ZHANDLE WHERE Z_PK = ?", row.ZINITIATOR!);
          if (initiator === undefined) refuse(`${locator} ZINITIATOR names handle ${String(row.ZINITIATOR)}, which the store does not hold`);
          const handles = db.all(
            `SELECT joined.Z_4REMOTEPARTICIPANTHANDLES AS named, handle.* FROM ${JOIN} AS joined
               LEFT JOIN ZHANDLE AS handle ON handle.Z_PK = joined.Z_4REMOTEPARTICIPANTHANDLES
              WHERE joined.Z_2REMOTEPARTICIPANTCALLS = ?`,
            pk,
          );
          const dangling = handles.find((found) => found.Z_PK === null);
          if (dangling !== undefined) refuse(`${locator} names remote handle ${String(dangling.named)}, which the store does not hold`);
          const media = shape.media === null ? {} : { emergency_media: emergencyMedia(db, pk, shape.media) };
          yield {
            kind: CALL,
            key: typeof record.ZUNIQUE_ID === "string" ? record.ZUNIQUE_ID : "",
            content: {
              type: "apple.call",
              call: record,
              ...(shape.initiated ? { initiator: initiator === null ? null : pick(initiator, shape.handle) } : {}),
              handles: ordered(handles.map((found) => pick(found, shape.handle))),
              ...media,
            },
            ...timed(row, locator),
            device,
            locator,
          };
        });
      } finally {
        db.close();
      }
      read = wholeFiles(members, (member) => member.file === file);
    }), () => read);
  },
};

function delivered(members: readonly Member[], name: string): DeliveryFile | undefined {
  const member = members.find((found) => matches(name, found.name));
  if (member === undefined) return undefined;
  return member.file ?? refuse(`${member.where} is inside an archive: hand its folder`);
}

interface Shape {
  call: string[];
  handle: string[];
  media: string[] | null;
  initiated: boolean;
}

function shapeOf(db: Sqlite): Shape {
  const media = db.columns(MEDIA_TABLE).length > 0;
  requireColumns(db, "the store", media ? { ...IDENTITY, [MEDIA_TABLE]: ["ZUPLOADEDFORCALL"] } : IDENTITY);
  const read = (table: string, known: string[]) => {
    const declared = db.columns(table);
    return known.filter((column) => declared.includes(column));
  };
  return {
    call: read("ZCALLRECORD", STATED),
    handle: read("ZHANDLE", HANDLE),
    media: media ? read(MEDIA_TABLE, MEDIA) : null,
    initiated: db.columns("ZCALLRECORD").includes(INITIATOR),
  };
}

function emergencyMedia(db: Sqlite, call: bigint, columns: string[]): JsonObject[] {
  return ordered(db.all(`SELECT * FROM ${MEDIA_TABLE} WHERE ZUPLOADEDFORCALL = ?`, call).map((found) => pick(found, columns)));
}

function pick(row: SqliteRow, columns: string[]): JsonObject {
  return rowJson(Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}

function timed(row: SqliteRow, where: string): { time?: Instant } {
  const start = appleInstant(row.ZDATE, "apple-s", `${where} ZDATE`);
  if (start === undefined) return {};
  const length = typeof row.ZDURATION === "number" || typeof row.ZDURATION === "bigint" ? Number(row.ZDURATION) : 0;
  if (length <= 0) return { time: start };
  const end = instantOf(Number(row.ZDATE) + length, "apple-s", `${where} ZDATE + ZDURATION`);
  return { time: end.start_ms > start.start_ms ? span(start, end) : start };
}

function nullableInteger(value: Json | undefined): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^-?\d+$/u.test(value));
}

function bytes(value: Json | undefined): boolean {
  return isObject(value) && Object.keys(value).join() === "$bytes64" && typeof value.$bytes64 === "string";
}

function nullableText(value: Json | undefined): boolean {
  return value === null || typeof value === "string";
}

function handle(value: Json): boolean {
  return isObject(value) && Object.keys(value).every((column) => HANDLE.includes(column)) && (!("ZTYPE" in value) || nullableInteger(value.ZTYPE)) &&
    (!("ZNORMALIZEDVALUE" in value) || nullableText(value.ZNORMALIZEDVALUE)) && (!("ZVALUE" in value) || nullableText(value.ZVALUE));
}

function media(value: Json): boolean {
  return isObject(value) && Object.keys(value).every((column) => MEDIA.includes(column)) &&
    (!("ZEMERGENCYMEDIATYPE" in value) || nullableInteger(value.ZEMERGENCYMEDIATYPE)) && (!("ZASSETID" in value) || nullableText(value.ZASSETID));
}
