import { appleInstant, archive, blobIndex, consuming, each, inOrder, isObject, listedBlobs, matches, openDeliveredSqlite, ordered, refuse, requireColumns, rowJson, unitOf, wholeFiles, type BlobReader, type Delivery, type DeliveryFile, type Instant, type Json, type JsonObject, type Member, type Reader, type ReaderOutput, type Sqlite, type SqliteRow, type SqliteValue } from "@lifestreamprotocol/connect/sdk";
import { canonicalJid } from "@lifestreamprotocol/core";

export const CHATS_FILE = "chats.sqlite";
export const CALLS_FILE = "calls.sqlite";
export const MEDIA_FILE = "media.json";
export const BUSINESS_FILE = "business.sqlite";

const MESSAGE_COLUMNS = [
  "ZSTANZAID", "ZTEXT", "ZFROMJID", "ZTOJID", "ZPUSHNAME", "ZMESSAGEDATE", "ZSENTDATE", "ZMESSAGETYPE",
  "ZGROUPEVENTTYPE", "ZFLAGS", "ZMESSAGESTATUS", "ZMESSAGEERRORSTATUS", "ZISFROMME", "ZSTARRED",
  "ZMEDIASECTIONID", "ZPHASH", "ZENCRETRYCOUNT", "ZFILTEREDRECIPIENTCOUNT", "ZCHILDMESSAGESDELIVEREDCOUNT",
  "ZCHILDMESSAGESPLAYEDCOUNT", "ZCHILDMESSAGESREADCOUNT", "ZDATAITEMVERSION",
] as const;
const MEDIA_COLUMNS = [
  "ZFILESIZE", "ZMEDIAORIGIN", "ZMOVIEDURATION", "ZASPECTRATIO", "ZHACCURACY", "ZLATITUDE", "ZLONGITUDE",
  "ZMEDIAURLDATE", "ZAUTHORNAME", "ZCOLLECTIONNAME", "ZMEDIAURL", "ZTITLE", "ZVCARDNAME", "ZVCARDSTRING", "ZMEDIAKEY",
] as const;
const CHAT_COLUMNS = [
  "ZCONTACTJID", "ZCONTACTIDENTIFIER", "ZPARTNERNAME", "ZSESSIONTYPE", "ZFLAGS", "ZARCHIVED", "ZHIDDEN", "ZREMOVED",
  "ZMESSAGECOUNTER", "ZUNREADCOUNT", "ZIDENTITYVERIFICATIONSTATE", "ZIDENTITYVERIFICATIONEPOCH", "ZLASTMESSAGEDATE",
  "ZLASTMESSAGETEXT", "ZLOCATIONSHARINGENDDATE", "ZETAG", "ZSAVEDINPUT",
] as const;
const GROUP_COLUMNS = [
  "ZSTATE", "ZCREATIONDATE", "ZSUBJECTTIMESTAMP", "ZCREATORJID", "ZOWNERJID", "ZSUBJECTOWNERJID", "ZSOURCEJID", "ZPICTUREID",
] as const;
const CALL_COLUMNS = [
  "ZBYTESRECEIVED", "ZBYTESSENT", "ZISBOTGROUPCALL", "ZISLIGHTWEIGHT", "ZOUTCOME", "ZDATE", "ZDURATION", "ZCALLIDSTRING",
  "ZGROUPCALLCREATORUSERJIDSTRING", "ZGROUPJIDSTRING", "ZREMINDERID", "ZSCHEDULEDID",
] as const;
const AGGREGATE_COLUMNS = ["ZINCOMING", "ZMISSED", "ZMISSEDREASON", "ZVIDEO", "ZFIRSTDATE", "ZLINKTOKEN"] as const;
const PARTICIPANT_COLUMNS = ["ZOUTCOME", "ZJIDSTRING"] as const;
const BUSINESS_COLUMNS = ["ZJID", "ZPHONENUMBERJID", "ZNAME", "ZVERIFICATIONLEVEL"] as const;

const SCHEMA: Record<string, readonly string[]> = {
  ZWAMESSAGE: [...MESSAGE_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "ZSORT", "ZDOCID", "ZSPOTLIGHTSTATUS", "ZCHATSESSION",
    "ZGROUPMEMBER", "ZLASTSESSION", "ZMEDIAITEM", "ZMESSAGEINFO", "ZPARENTMESSAGE"],
  ZWAMEDIAITEM: [...MEDIA_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "ZMESSAGE", "ZMEDIALOCALPATH", "ZTHUMBNAILLOCALPATH",
    "ZXMPPTHUMBPATH", "ZCLOUDSTATUS", "ZMETADATA"],
  ZWACHATSESSION: [...CHAT_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "ZSPOTLIGHTSTATUS", "ZCONTACTABID", "ZGROUPINFO",
    "ZLASTMESSAGE", "ZPROPERTIES"],
  ZWAGROUPINFO: [...GROUP_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "ZCHATSESSION", "ZLASTMESSAGEOWNER", "ZPICTUREPATH"],
  ZWAPROFILEPUSHNAME: ["Z_PK", "Z_ENT", "Z_OPT", "ZJID", "ZPUSHNAME"],
};
const CALL_SCHEMA: Record<string, readonly string[]> = {
  ZWACDCALLEVENT: [...CALL_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "Z1CALLEVENTS", "Z_FOK_1CALLEVENTS"],
  ZWAAGGREGATECALLEVENT: [...AGGREGATE_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT"],
  ZWACDCALLEVENTPARTICIPANT: [...PARTICIPANT_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "Z1PARTICIPANTS", "Z_FOK_1PARTICIPANTS"],
};
const BUSINESS_SCHEMA: Record<string, readonly string[]> = {
  ZWABIZVERIFIEDNAMEDATA: [...BUSINESS_COLUMNS, "Z_PK", "Z_ENT", "Z_OPT", "ZEXPIRES", "ZCERTIFICATEDETAILS"],
};
const POINTER_COLUMNS = ["ZMEDIALOCALPATH", "ZXMPPTHUMBPATH", "ZTHUMBNAILLOCALPATH"] as const;
const MEMBER_JID_COLUMNS = ["ZMEMBERJID", "ZCONTACTJID", "ZJID", "ZCONTACTIDENTIFIER"] as const;

export const whatsappConnector: Reader = {
  name: "whatsapp-db",
  kinds: { msg: msgGuard, chat: chatGuard, pushname: pushnameGuard, call: callGuard, business: businessGuard },
  read,
  columns: { ...SCHEMA, ...CALL_SCHEMA, ...BUSINESS_SCHEMA },
};

async function* read(delivery: Delivery, files: BlobReader): AsyncGenerator<ReaderOutput> {
  const device = unitOf(delivery.source);
  let read: Member[] = [];
  yield* consuming(delivery, archive(delivery, files, async function* (members) {
    const chats = delivered(members, CHATS_FILE);
    const indexFile = chats === undefined ? undefined : delivered(members, MEDIA_FILE);
    const media = indexFile === undefined ? undefined : blobIndex(files.bytes(indexFile.blob));
    const stores = [
      { file: chats, read: (db: Sqlite) => chatStore(db, media, device, delivery.facts.kind === "delta") },
      { file: delivered(members, CALLS_FILE), read: (db: Sqlite) => callStore(db, device) },
      { file: delivered(members, BUSINESS_FILE), read: (db: Sqlite) => businessStore(db, device) },
    ].filter((store): store is typeof store & { file: DeliveryFile } => store.file !== undefined);
    yield* each(stores, ({ file }) => file.path, async function* ({ file, read }) {
      const db = await openDeliveredSqlite(files, file);
      try {
        yield* read(db);
      } finally {
        db.close();
      }
    });
    const opened = new Set<DeliveryFile | undefined>([indexFile, ...stores.map((store) => store.file)]);
    read = wholeFiles(members, (member) => opened.has(member.file));
  }), () => read);
}

interface Chat {
  key: string;
  contactJid: string;
}

async function* chatStore(db: Sqlite, media: Map<string, { blob: string; size: number }> | undefined, device: string, lookupOnly: boolean): AsyncGenerator<ReaderOutput> {
  requireColumns(db, "the file", SCHEMA);
  const memberColumns = db.columns("ZWAGROUPMEMBER");
  const memberJid = MEMBER_JID_COLUMNS.find((column) => memberColumns.includes(column));
  if (memberJid === undefined) refuse(`ZWAGROUPMEMBER declares none of ${MEMBER_JID_COLUMNS.join(", ")}`);

  const chats = new Map<bigint, Chat | null>();
  const chatOf = (pk: bigint): Chat | null => {
    let chat = chats.get(pk);
    if (chat === undefined) {
      const row = db.get("SELECT ZCONTACTJID, ZCONTACTIDENTIFIER FROM ZWACHATSESSION WHERE Z_PK = ?", pk);
      chat = row === undefined ? null : { key: canonicalChat(row.ZCONTACTJID!, row.ZCONTACTIDENTIFIER!, pk), contactJid: row.ZCONTACTJID as string };
      chats.set(pk, chat);
    }
    return chat;
  };
  const newest = new Map<bigint, { raw: number; time: Instant | undefined }>();

  yield* each(db.rows("ZWAMESSAGE", "Z_PK"), (part) => part.where, function* (part) {
    const row = part.read();
    const pk = row.Z_PK as bigint;
    const where = `ZWAMESSAGE row ${pk}`;
    const stanza = text(row.ZSTANZAID, `${where}.ZSTANZAID`);
    const chatPk = integer(row.ZCHATSESSION, `${where}.ZCHATSESSION`);
    const chat = chatPk === null ? null : chatOf(chatPk);
    const from = chat === null ? colonFree(text(row.ZFROMJID, `${where}.ZFROMJID`), `${where}.ZFROMJID`) : undefined;
    const key = chat === null ? `unattached:${from}:${stanza}` : `${chat.key}:${stanza}`;
    const time = appleInstant(row.ZMESSAGEDATE, "apple-s", `${where}.ZMESSAGEDATE`);

    let mediaItem: JsonObject | null = null;
    const blobs: { hash: string; bytes: number; role: string }[] = [];
    const mediaPk = integer(row.ZMEDIAITEM, `${where}.ZMEDIAITEM`);
    if (mediaPk !== null) {
      const item = db.get("SELECT * FROM ZWAMEDIAITEM WHERE Z_PK = ?", mediaPk) ?? refuse(`${where} names ZWAMEDIAITEM ${mediaPk}, which the file does not hold`);
      mediaItem = project(item, MEDIA_COLUMNS);
      for (const column of POINTER_COLUMNS) {
        const pointer = item[column];
        if (pointer === null || pointer === "") continue;
        if (typeof pointer !== "string") refuse(`ZWAMEDIAITEM ${mediaPk}.${column} is not text`);
        const entry = media?.get(pointer);
        if (entry !== undefined) blobs.push({ hash: entry.blob, bytes: entry.size, role: `ZWAMEDIAITEM.${column}` });
      }
      blobs.sort((left, right) => compare(left.role, right.role) || compare(left.hash, right.hash));
    }

    const memberPk = integer(row.ZGROUPMEMBER, `${where}.ZGROUPMEMBER`);
    let groupMemberJid: string | null = null;
    if (memberPk !== null) {
      const member = db.get(`SELECT "${memberJid}" AS jid FROM ZWAGROUPMEMBER WHERE Z_PK = ?`, memberPk);
      if (member === undefined && chat !== null) refuse(`${where} names ZWAGROUPMEMBER ${memberPk}, which the file does not hold`);
      groupMemberJid = member === undefined ? null : nullableText(member.jid, `ZWAGROUPMEMBER ${memberPk}.${memberJid}`);
    }

    const parentPk = integer(row.ZPARENTMESSAGE, `${where}.ZPARENTMESSAGE`);
    let parentStanza: string | null = null;
    let lostParent: JsonObject = {};
    if (parentPk !== null) {
      const parent = db.get("SELECT ZSTANZAID FROM ZWAMESSAGE WHERE Z_PK = ?", parentPk);
      if (parent !== undefined) parentStanza = text(parent.ZSTANZAID, `ZWAMESSAGE row ${parentPk}.ZSTANZAID`);
      else if (lookupOnly) return;
      else lostParent = project(row, ["ZPARENTMESSAGE"]);
    }

    const content: JsonObject = {
      type: "whatsapp.msg",
      message: project(row, MESSAGE_COLUMNS),
      session_jid: chat === null ? from! : sessionJid(chat.contactJid, row, where),
      parent_stanza_id: parentStanza,
      ...lostParent,
      media_item: mediaItem,
      group_member_jid: groupMemberJid,
      blobs,
    };
    const linked = listedBlobs(content);
    yield {
      kind: "msg",
      key,
      content,
      ...(time === undefined ? {} : { time }),
      ...(linked.length === 0 ? {} : { blobs: linked }),
      device,
      locator: where,
    };

    if (chatPk !== null && chat !== null) {
      const raw = Number(row.ZMESSAGEDATE);
      const held = newest.get(chatPk);
      if (held === undefined || raw > held.raw) newest.set(chatPk, { raw, time });
    }
  });

  yield* each(db.rows("ZWACHATSESSION", "Z_PK"), (part) => part.where, function* (part) {
    const row = part.read();
    const pk = row.Z_PK as bigint;
    const where = `ZWACHATSESSION row ${pk}`;
    if (typeof row.ZCONTACTJID !== "string" || row.ZCONTACTJID === "") return;
    const groupPk = integer(row.ZGROUPINFO, `${where}.ZGROUPINFO`);
    const group = groupPk === null ? null : (db.get("SELECT * FROM ZWAGROUPINFO WHERE Z_PK = ?", groupPk) ?? refuse(`${where} names ZWAGROUPINFO ${groupPk}, which the file does not hold`));
    const time = newest.get(pk)?.time;
    yield {
      kind: "chat",
      key: chatOf(pk)!.key,
      content: { type: "whatsapp.chat", chat: project(row, CHAT_COLUMNS), group_info: group === null ? null : project(group, GROUP_COLUMNS) },
      ...(time === undefined ? {} : { time }),
      device,
      locator: where,
    };
  });

  yield* each(db.rows("ZWAPROFILEPUSHNAME", "Z_PK"), (part) => part.where, function* (part) {
    const row = part.read();
    const where = `ZWAPROFILEPUSHNAME row ${row.Z_PK as bigint}`;
    const jid = nullableText(row.ZJID, `${where}.ZJID`);
    const name = nullableText(row.ZPUSHNAME, `${where}.ZPUSHNAME`);
    if (jid === null || jid === "" || name === null || name === "") return;
    yield { kind: "pushname", key: jidKey(jid), content: { type: "whatsapp.pushname", ZJID: jid, ZPUSHNAME: name }, device, locator: where };
  });
}

async function* callStore(db: Sqlite, device: string): AsyncGenerator<ReaderOutput> {
  requireColumns(db, "the file", CALL_SCHEMA);
  yield* each(db.rows("ZWACDCALLEVENT", "Z_PK"), (part) => part.where, function* (part) {
    const event = part.read();
    const where = `ZWACDCALLEVENT row ${event.Z_PK as bigint}`;
    const callId = text(event.ZCALLIDSTRING, `${where}.ZCALLIDSTRING`);
    const aggregatePk = integer(event.Z1CALLEVENTS, `${where}.Z1CALLEVENTS`) ?? refuse(`${where} names no aggregate`);
    const aggregate = db.get("SELECT * FROM ZWAAGGREGATECALLEVENT WHERE Z_PK = ?", aggregatePk) ?? refuse(`${where} names ZWAAGGREGATECALLEVENT ${aggregatePk}, which the file does not hold`);
    const participants = db
      .all("SELECT * FROM ZWACDCALLEVENTPARTICIPANT WHERE Z1PARTICIPANTS = ?", aggregatePk)
      .map((participant) => project(participant, PARTICIPANT_COLUMNS));
    const time = appleInstant(event.ZDATE, "apple-s", `${where}.ZDATE`);
    yield {
      kind: "call",
      key: callId,
      content: {
        type: "whatsapp.call",
        call: project(event, CALL_COLUMNS),
        aggregate: project(aggregate, AGGREGATE_COLUMNS),
        participants: ordered(participants),
      },
      ...(time === undefined ? {} : { time }),
      device,
      locator: where,
    };
  });
}

async function* businessStore(db: Sqlite, device: string): AsyncGenerator<ReaderOutput> {
  requireColumns(db, "the file", BUSINESS_SCHEMA);
  yield* each(db.rows("ZWABIZVERIFIEDNAMEDATA", "Z_PK"), (part) => part.where, function* (part) {
    const row = part.read();
    const where = `ZWABIZVERIFIEDNAMEDATA row ${row.Z_PK as bigint}`;
    const jid = nullableText(row.ZJID, `${where}.ZJID`);
    if (jid === null || jid === "") return;
    nullableText(row.ZPHONENUMBERJID, `${where}.ZPHONENUMBERJID`);
    nullableText(row.ZNAME, `${where}.ZNAME`);
    integer(row.ZVERIFICATIONLEVEL, `${where}.ZVERIFICATIONLEVEL`);
    yield { kind: "business", key: colonFree(jidKey(jid), `${where}.ZJID`), content: { type: "whatsapp.business", ...project(row, BUSINESS_COLUMNS) }, device, locator: where };
  });
}


const LID = /@lid$/iu;
const PHONE_JID = /@s\.whatsapp\.net$/iu;

function canonicalChat(session: SqliteValue, identifier: SqliteValue, pk: bigint): string {
  const jid = text(session, `ZWACHATSESSION row ${pk}.ZCONTACTJID`);
  let key = jid;
  if (LID.test(jid)) key = jidKey(jid);
  else if (PHONE_JID.test(jid)) key = typeof identifier === "string" && LID.test(identifier) ? jidKey(identifier) : jidKey(jid);
  return colonFree(key, `ZWACHATSESSION row ${pk} key`);
}

function jidKey(value: string): string {
  return canonicalJid(value) ?? value;
}

function sessionJid(contactJid: string, row: SqliteRow, where: string): string {
  if (!/@(?:lid|s\.whatsapp\.net)$/iu.test(contactJid)) return contactJid;
  const fromMe = row.ZISFROMME;
  if (typeof fromMe !== "bigint" && typeof fromMe !== "number") refuse(`${where}.ZISFROMME is not a number`);
  return Number(fromMe) !== 0 ? text(row.ZTOJID, `${where}.ZTOJID`) : text(row.ZFROMJID, `${where}.ZFROMJID`);
}

function colonFree(value: string, where: string): string {
  if (value.includes(":")) refuse(`${where} ${JSON.stringify(value)} holds a colon, which would make its key ambiguous`);
  return value;
}


function project(row: SqliteRow, columns: readonly string[]): JsonObject {
  const picked: SqliteRow = {};
  for (const column of columns) picked[column] = row[column]!;
  return rowJson(picked);
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

function delivered(members: readonly Member[], name: string): DeliveryFile | undefined {
  const member = members.find((found) => matches(name, found.name));
  if (member === undefined) return undefined;
  return member.file ?? refuse(`${member.where} is inside an archive: hand its folder`);
}


function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}


type Check = (value: Json | undefined) => boolean;

const nullableString: Check = (value) => value === null || typeof value === "string";
const nonEmptyString: Check = (value) => typeof value === "string" && value.length > 0;
const number: Check = (value) => typeof value === "number" && Number.isFinite(value);
const nullableNumber: Check = (value) => value === null || number(value);
const nullableInteger: Check = (value) => value === null || (typeof value === "number" && Number.isSafeInteger(value));
const BLOB = /^sha256:[0-9a-f]{64}$/u;

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

function columns(names: readonly string[]): Check {
  const members = Object.fromEntries(names.map((name) => [name, () => true]));
  return (value) => exact(value, members, "").length === 0;
}

const isBlobs: Check = (value) => {
  if (!Array.isArray(value)) return false;
  const refs = value as JsonObject[];
  const shaped = refs.every((ref) =>
    exact(ref, {
      hash: (hash) => typeof hash === "string" && BLOB.test(hash),
      bytes: (bytes) => typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0,
      role: nonEmptyString,
    }, "blob").length === 0,
  );
  return shaped && refs.every((ref, index) => index === 0 || (compare(String(refs[index - 1]!.role), String(ref.role)) || compare(String(refs[index - 1]!.hash), String(ref.hash))) <= 0);
};

function msgGuard(content: Json): string[] {
  const lostParent = isObject(content) && "ZPARENTMESSAGE" in content;
  return exact(content, {
    type: (value) => value === "whatsapp.msg",
    message: columns(MESSAGE_COLUMNS),
    session_jid: nullableString,
    ...(lostParent
      ? { parent_stanza_id: (value: Json | undefined) => value === null, ZPARENTMESSAGE: (value: Json | undefined) => typeof value === "number" || typeof value === "string" }
      : { parent_stanza_id: nullableString }),
    media_item: (value) => value === null || columns(MEDIA_COLUMNS)(value),
    group_member_jid: nullableString,
    blobs: isBlobs,
  }, "msg");
}

function chatGuard(content: Json): string[] {
  return exact(content, {
    type: (value) => value === "whatsapp.chat",
    chat: columns(CHAT_COLUMNS),
    group_info: (value) => value === null || columns(GROUP_COLUMNS)(value),
  }, "chat");
}

function pushnameGuard(content: Json): string[] {
  return exact(content, { type: (value) => value === "whatsapp.pushname", ZJID: nonEmptyString, ZPUSHNAME: nonEmptyString }, "pushname");
}

function businessGuard(content: Json): string[] {
  return exact(content, {
    type: (value) => value === "whatsapp.business", ZJID: nonEmptyString, ZPHONENUMBERJID: nullableString, ZNAME: nullableString, ZVERIFICATIONLEVEL: nullableInteger,
  }, "business");
}

function callGuard(content: Json): string[] {
  const shape = exact(content, {
    type: (value) => value === "whatsapp.call",
    call: columns(CALL_COLUMNS),
    aggregate: columns(AGGREGATE_COLUMNS),
    participants: (value) => Array.isArray(value) && value.every(columns(PARTICIPANT_COLUMNS)),
  }, "call");
  if (shape.length > 0) return shape;
  const call = (content as JsonObject).call as JsonObject;
  const aggregate = (content as JsonObject).aggregate as JsonObject;
  const participants = (content as JsonObject).participants as JsonObject[];
  const violations = [
    ...exact(call, {
      ZBYTESRECEIVED: nullableInteger, ZBYTESSENT: nullableInteger, ZISBOTGROUPCALL: nullableInteger, ZISLIGHTWEIGHT: nullableInteger,
      ZOUTCOME: nullableInteger, ZDATE: nullableNumber, ZDURATION: nullableNumber, ZCALLIDSTRING: nonEmptyString,
      ZGROUPCALLCREATORUSERJIDSTRING: nullableString, ZGROUPJIDSTRING: nullableString, ZREMINDERID: nullableString, ZSCHEDULEDID: nullableString,
    }, "call.call"),
    ...exact(aggregate, {
      ZINCOMING: nullableInteger, ZMISSED: nullableInteger, ZMISSEDREASON: nullableInteger, ZVIDEO: nullableInteger,
      ZFIRSTDATE: nullableNumber, ZLINKTOKEN: nullableString,
    }, "call.aggregate"),
    ...participants.flatMap((participant, index) =>
      exact(participant, { ZOUTCOME: nullableInteger, ZJIDSTRING: nullableString }, `call.participants[${index}]`),
    ),
  ];
  if (violations.length === 0 && !inOrder(participants)) violations.push("call.participants are not in order");
  return violations;
}
