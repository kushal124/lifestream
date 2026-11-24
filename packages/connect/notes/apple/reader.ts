import { appleInstant, blobIndex, each, isObject, openDeliveredSqlite, ordered, refuse, requireColumns, rowJson, span, unitOf, type Guard, type Instant, type Json, type JsonObject, type Reader, type Sqlite, type SqliteRow } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
export const NOTES_FILE = "notes.sqlite";
export const MEDIA_INDEX_FILE = "media.json";

const OBJECTS = "ZICCLOUDSYNCINGOBJECT";
const NOTE_TEXT = ["ZIDENTIFIER", "ZTITLE1", "ZSNIPPET", "ZPASSWORDHINT"];
const NOTE_NUMERIC = ["ZCREATIONDATE3", "ZMODIFICATIONDATE1"];
const NOTE_INTEGER = [
  "ZISPINNED", "ZISPASSWORDPROTECTED", "ZMARKEDFORDELETION", "ZHASCHECKLIST", "ZHASCHECKLISTINPROGRESS", "ZHASEMPHASIS",
  "ZHASSYSTEMTEXTATTACHMENTS", "ZPAPERSTYLETYPE", "ZISSYSTEMPAPER", "ZCRYPTOITERATIONCOUNT",
];
const NOTE_BLOB = ["ZCRYPTOSALT", "ZCRYPTOWRAPPEDKEY", "ZCRYPTOINITIALIZATIONVECTOR", "ZCRYPTOTAG"];
const NOTE_COLUMNS = [...NOTE_TEXT, ...NOTE_NUMERIC, ...NOTE_INTEGER, ...NOTE_BLOB];
const BODY_COLUMNS = ["ZDATA", "ZCRYPTOINITIALIZATIONVECTOR", "ZCRYPTOTAG"];
const FOLDER_COLUMNS = ["ZIDENTIFIER", "ZTITLE2", "ZFOLDERTYPE"];
const ATTACHMENT_COLUMNS = ["ZIDENTIFIER", "ZTYPEUTI", "ZTITLE", "ZURLSTRING", "ZCREATIONDATE", "ZMODIFICATIONDATE", "ZFILESIZE", "ZMARKEDFORDELETION"];
const MEDIA_COLUMNS = ["ZIDENTIFIER", "ZFILENAME", "ZGENERATION1"];
const ENTITIES = { note: "ICNote", folder: "ICFolder", attachment: "ICAttachment", media: "ICMedia", account: "ICAccount" } as const;

const REQUIRED: Record<string, string[]> = {
  [OBJECTS]: ["Z_PK", "Z_ENT", ...NOTE_COLUMNS, "ZFOLDER", ...FOLDER_COLUMNS, "ZPARENT", ...ATTACHMENT_COLUMNS, "ZNOTE", "ZMEDIA", ...MEDIA_COLUMNS, "ZACCOUNT6"],
  ZICNOTEDATA: ["Z_PK", "ZNOTE", ...BODY_COLUMNS],
  Z_PRIMARYKEY: ["Z_ENT", "Z_NAME"],
};

const note: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join() !== "attachments,body,folder,note,type") {
    return ["members must be exactly type, note, body, folder, attachments"];
  }
  const problems: string[] = [];
  if (content.type !== "apple.note") problems.push("type must be apple.note");
  const record = content.note;
  if (!isObject(record) || Object.keys(record).sort().join() !== [...NOTE_COLUMNS].sort().join()) problems.push(`note must state exactly ${NOTE_COLUMNS.join(", ")}`);
  else {
    if (typeof record.ZIDENTIFIER !== "string" || record.ZIDENTIFIER === "") problems.push("note ZIDENTIFIER must be non-empty text");
    for (const column of NOTE_TEXT) if (record[column] !== null && typeof record[column] !== "string") problems.push(`note ${column} must be text or null`);
    for (const column of NOTE_NUMERIC) if (record[column] !== null && typeof record[column] !== "number") problems.push(`note ${column} must be a number or null`);
    for (const column of NOTE_INTEGER) if (!nullableInteger(record[column])) problems.push(`note ${column} must be an integer or null`);
    for (const column of NOTE_BLOB) if (!nullableBytes(record[column])) problems.push(`note ${column} must be bytes or null`);
  }
  if (content.body !== null && !(isObject(content.body) && Object.keys(content.body).sort().join() === [...BODY_COLUMNS].sort().join() &&
    BODY_COLUMNS.every((column) => nullableBytes((content.body as JsonObject)[column])))) problems.push("body must be the note's data row or null");
  if (content.folder !== null && !(isObject(content.folder) && Object.keys(content.folder).sort().join() === "ZFOLDERTYPE,ZIDENTIFIER,ZTITLE2,parent" &&
    typeof content.folder.ZIDENTIFIER === "string" && nullableInteger(content.folder.ZFOLDERTYPE))) problems.push("folder must be a folder or null");
  if (!Array.isArray(content.attachments)) problems.push("attachments must be an array");
  else {
    for (const [index, attachment] of content.attachments.entries()) {
      if (!isObject(attachment) || Object.keys(attachment).sort().join() !== [...ATTACHMENT_COLUMNS, "media"].sort().join() ||
        typeof attachment.ZIDENTIFIER !== "string") {
        problems.push(`attachments[${index}] must state its columns and media`);
        continue;
      }
      const media = attachment.media;
      if (media !== null && !(isObject(media) && Object.keys(media).sort().join() === "ZFILENAME,ZGENERATION1,ZIDENTIFIER,bytes,hash" &&
        ((media.hash === null && media.bytes === null) || (typeof media.hash === "string" && /^[0-9a-f]{64}$/u.test(media.hash) && nullableInteger(media.bytes) && media.bytes !== null)))) {
        problems.push(`attachments[${index}] media must state its columns, and its file's hash and bytes or neither`);
      }
    }
  }
  return problems;
};

export function noteBlobs(content: Json): string[] {
  const attachments = isObject(content) && Array.isArray(content.attachments) ? content.attachments : [];
  const blobs = new Set<string>();
  for (const attachment of attachments) {
    const media = isObject(attachment) ? attachment.media : undefined;
    if (isObject(media) && typeof media.hash === "string") blobs.add(`sha256:${media.hash}`);
  }
  return [...blobs].sort();
}

export const appleNotes: Reader = {
  name: "notes-mac",
  kinds: { [NOTE]: note },
  async *read(delivery, files) {
    const store = delivery.files.find((entry) => entry.path === NOTES_FILE);
    if (store === undefined) refuse(`the delivery carries no ${NOTES_FILE}`);
    const indexFile = delivery.files.find((entry) => entry.path === MEDIA_INDEX_FILE);
    const index = indexFile === undefined ? new Map<string, { blob: string; size: number }>() : blobIndex(files.bytes(indexFile.blob));
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, store);
    try {
      requireColumns(db, NOTES_FILE, REQUIRED);
      const entities = readEntities(db);
      const object = (pk: Json | bigint, entity: bigint, what: string, where: string): SqliteRow => {
        const row = db.get(`SELECT * FROM ${OBJECTS} WHERE Z_PK = ? AND Z_ENT = ?`, BigInt(pk as number | bigint), entity);
        if (row === undefined) refuse(`${where} names ${what} ${String(pk)}, which the store does not hold`);
        return row;
      };
      yield* each(db.rows(OBJECTS, "Z_PK"), (part) => part.where, function* (part) {
        const row = part.read();
        if (row.Z_ENT !== entities.note) return;
        const pk = row.Z_PK as bigint;
        const locator = `${ENTITIES.note} row ${pk}`;
        const record = pick(row, NOTE_COLUMNS);
        const bodies = db.all("SELECT * FROM ZICNOTEDATA WHERE ZNOTE = ? ORDER BY Z_PK", pk);
        if (bodies.length > 1) refuse(`${locator} has ${bodies.length} body rows`);
        let folder: JsonObject | null = null;
        if (row.ZFOLDER !== null) {
          const found = object(row.ZFOLDER as bigint, entities.folder, "folder", `${locator} ZFOLDER`);
          const parent = found.ZPARENT === null ? null : object(found.ZPARENT as bigint, entities.folder, "parent folder", `${locator} folder ZPARENT`);
          folder = { ...pick(found, FOLDER_COLUMNS), parent: parent === null ? null : (parent.ZIDENTIFIER as string | null) };
        }
        const attachments: JsonObject[] = [];
        for (const attachment of db.all(`SELECT * FROM ${OBJECTS} WHERE Z_ENT = ? AND ZNOTE = ? ORDER BY Z_PK`, entities.attachment, pk)) {
          const where = `${locator} attachment ${String(attachment.Z_PK)}`;
          let media: JsonObject | null = null;
          if (attachment.ZMEDIA !== null) {
            const found = object(attachment.ZMEDIA as bigint, entities.media, "media", `${where} ZMEDIA`);
            const account = found.ZACCOUNT6 === null ? null : object(found.ZACCOUNT6 as bigint, entities.account, "account", `${where} media ZACCOUNT6`);
            const stated = pick(found, MEDIA_COLUMNS);
            const file = mediaLocator(account?.ZIDENTIFIER, stated);
            const entry = file === null ? undefined : index.get(file);
            media = { ...stated, hash: entry === undefined ? null : entry.blob.slice("sha256:".length), bytes: entry === undefined ? null : entry.size };
          }
          attachments.push({ ...pick(attachment, ATTACHMENT_COLUMNS), media });
        }
        const content: JsonObject = {
          type: "apple.note",
          note: record,
          body: bodies.length === 0 ? null : pick(bodies[0]!, BODY_COLUMNS),
          folder,
          attachments: ordered(attachments),
        };
        const blobs = noteBlobs(content);
        yield {
          kind: NOTE,
          key: typeof record.ZIDENTIFIER === "string" ? record.ZIDENTIFIER : "",
          content,
          ...timed(row, locator),
          ...(blobs.length === 0 ? {} : { blobs }),
          device,
          locator,
        };
      });
    } finally {
      db.close();
    }
  },
};

function mediaLocator(account: unknown, media: JsonObject): string | null {
  const parts = [account, media.ZIDENTIFIER, media.ZGENERATION1, media.ZFILENAME];
  if (!parts.every((part): part is string => typeof part === "string" && part.length > 0 && !part.includes("/") && !part.includes("\0"))) return null;
  const [owner, identifier, generation, filename] = parts;
  return `Accounts/${owner}/Media/${identifier}/${generation}/${filename}`;
}

function readEntities(db: Sqlite): Record<keyof typeof ENTITIES, bigint> {
  const entity = (name: string): bigint => {
    const rows = db.all("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = ?", name);
    if (rows.length !== 1 || typeof rows[0]!.Z_ENT !== "bigint") refuse(`Z_PRIMARYKEY names ${rows.length} entities called ${name}; one is needed`);
    return rows[0]!.Z_ENT;
  };
  return {
    note: entity(ENTITIES.note),
    folder: entity(ENTITIES.folder),
    attachment: entity(ENTITIES.attachment),
    media: entity(ENTITIES.media),
    account: entity(ENTITIES.account),
  };
}

function pick(row: SqliteRow, columns: string[]): JsonObject {
  return rowJson(Object.fromEntries(columns.map((column) => [column, row[column] ?? null])));
}

function timed(row: SqliteRow, where: string): { time?: Instant } {
  const created = appleInstant(row.ZCREATIONDATE3, "apple-s", `${where} ZCREATIONDATE3`);
  const modified = appleInstant(row.ZMODIFICATIONDATE1, "apple-s", `${where} ZMODIFICATIONDATE1`);
  if (created === undefined) return modified === undefined ? {} : { time: modified };
  if (modified === undefined || modified.start_ms <= created.start_ms) return { time: created };
  return { time: span(created, modified) };
}

function nullableInteger(value: Json | undefined): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value)) || (typeof value === "string" && /^-?\d+$/u.test(value));
}

function nullableBytes(value: Json | undefined): boolean {
  return value === null || (isObject(value) && Object.keys(value).join() === "$bytes64" && typeof value.$bytes64 === "string");
}
