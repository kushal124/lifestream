export { artifact, collect, temp } from "../../test/drive.js";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { BlobStore, Delivery, Guard, HomeDb, JsonObject, Landed, ReaderOutput } from "@lifestreamprotocol/core";
import type { Fixture } from "../../test/drive.js";

export const PHONE = "15550000001";
export const MAC_UNIT = "macbook-pro-0001";
export const PHONE_UNIT = "iphone-aa01";
export const MAC_SOURCE = `whatsapp:${PHONE}:${MAC_UNIT}`;
export const PHONE_SOURCE = `whatsapp:${PHONE}:${PHONE_UNIT}`;
export const DELTA_AFTER = 9;
export const DELTA_THROUGH = 12;

const SCHEMA = `
CREATE TABLE ZWAPROFILEPUSHNAME (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZPUSHNAME VARCHAR);
CREATE TABLE ZWACHATSESSION (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCONTACTJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR,
  ZPARTNERNAME VARCHAR, ZSESSIONTYPE INTEGER, ZFLAGS INTEGER, ZARCHIVED INTEGER, ZHIDDEN INTEGER, ZREMOVED INTEGER,
  ZMESSAGECOUNTER INTEGER, ZUNREADCOUNT INTEGER, ZIDENTITYVERIFICATIONSTATE INTEGER, ZIDENTITYVERIFICATIONEPOCH INTEGER,
  ZLASTMESSAGEDATE TIMESTAMP, ZLASTMESSAGETEXT VARCHAR, ZLOCATIONSHARINGENDDATE TIMESTAMP, ZETAG VARCHAR,
  ZSAVEDINPUT VARCHAR, ZSPOTLIGHTSTATUS INTEGER, ZCONTACTABID INTEGER, ZGROUPINFO INTEGER, ZLASTMESSAGE INTEGER,
  ZPROPERTIES BLOB
);
CREATE TABLE ZWAGROUPINFO (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZCHATSESSION INTEGER, ZLASTMESSAGEOWNER INTEGER,
  ZPICTUREPATH VARCHAR, ZSTATE INTEGER, ZCREATIONDATE TIMESTAMP, ZSUBJECTTIMESTAMP TIMESTAMP, ZCREATORJID VARCHAR,
  ZOWNERJID VARCHAR, ZSUBJECTOWNERJID VARCHAR, ZSOURCEJID VARCHAR, ZPICTUREID VARCHAR
);
CREATE TABLE ZWAMEDIAITEM (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZFILESIZE INTEGER, ZMEDIAORIGIN INTEGER,
  ZMOVIEDURATION FLOAT, ZASPECTRATIO FLOAT, ZHACCURACY FLOAT, ZLATITUDE FLOAT, ZLONGITUDE FLOAT,
  ZMEDIAURLDATE TIMESTAMP, ZAUTHORNAME VARCHAR, ZCOLLECTIONNAME VARCHAR, ZMEDIAURL VARCHAR, ZTITLE VARCHAR,
  ZVCARDNAME VARCHAR, ZVCARDSTRING VARCHAR, ZMEDIAKEY BLOB, ZMESSAGE INTEGER, ZMEDIALOCALPATH VARCHAR,
  ZTHUMBNAILLOCALPATH VARCHAR, ZXMPPTHUMBPATH VARCHAR, ZCLOUDSTATUS INTEGER, ZMETADATA BLOB
);
CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMEMBERJID VARCHAR, ZCONTACTIDENTIFIER VARCHAR);
CREATE TABLE ZWAMESSAGE (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZSORT INTEGER, ZDOCID VARCHAR, ZSPOTLIGHTSTATUS INTEGER,
  ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZLASTSESSION INTEGER, ZMEDIAITEM INTEGER, ZMESSAGEINFO INTEGER,
  ZPARENTMESSAGE INTEGER, ZSTANZAID VARCHAR, ZTEXT VARCHAR, ZFROMJID VARCHAR, ZTOJID VARCHAR, ZPUSHNAME VARCHAR,
  ZMESSAGEDATE TIMESTAMP, ZSENTDATE TIMESTAMP, ZMESSAGETYPE INTEGER, ZGROUPEVENTTYPE INTEGER, ZFLAGS INTEGER,
  ZMESSAGESTATUS INTEGER, ZMESSAGEERRORSTATUS INTEGER, ZISFROMME INTEGER, ZSTARRED INTEGER, ZMEDIASECTIONID VARCHAR,
  ZPHASH VARCHAR, ZENCRETRYCOUNT INTEGER, ZFILTEREDRECIPIENTCOUNT INTEGER, ZCHILDMESSAGESDELIVEREDCOUNT INTEGER,
  ZCHILDMESSAGESPLAYEDCOUNT INTEGER, ZCHILDMESSAGESREADCOUNT INTEGER, ZDATAITEMVERSION INTEGER
);
CREATE INDEX Z_WAMESSAGE_CHATSESSION ON ZWAMESSAGE (ZCHATSESSION);
CREATE TABLE ZWAMESSAGEINFO (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZMESSAGE INTEGER, ZRECEIPTINFO BLOB);
CREATE TABLE ZWAPROFILEPICTUREITEM (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZTHUMBNAILDATA BLOB);
`;

const CALL_SCHEMA = `
CREATE TABLE ZWAAGGREGATECALLEVENT (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZINCOMING INTEGER, ZMISSED INTEGER, ZMISSEDREASON INTEGER,
  ZVIDEO INTEGER, ZFIRSTDATE, ZLINKTOKEN VARCHAR
);
CREATE TABLE ZWACDCALLEVENT (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZBYTESRECEIVED INTEGER, ZBYTESSENT INTEGER,
  ZISBOTGROUPCALL INTEGER, ZISLIGHTWEIGHT INTEGER, ZOUTCOME INTEGER, Z1CALLEVENTS INTEGER, Z_FOK_1CALLEVENTS INTEGER,
  ZDATE, ZDURATION FLOAT, ZCALLIDSTRING VARCHAR, ZGROUPCALLCREATORUSERJIDSTRING VARCHAR, ZGROUPJIDSTRING VARCHAR,
  ZREMINDERID VARCHAR, ZSCHEDULEDID VARCHAR
);
CREATE TABLE ZWACDCALLEVENTPARTICIPANT (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZOUTCOME INTEGER, Z1PARTICIPANTS INTEGER,
  Z_FOK_1PARTICIPANTS INTEGER, ZJIDSTRING VARCHAR
);
CREATE INDEX Z_WACDCALLEVENTPARTICIPANT_PARTICIPANTS ON ZWACDCALLEVENTPARTICIPANT (Z1PARTICIPANTS);
`;

const GROUP = "15550000001-1700000000@g.us";

type Value = string | number | bigint | Buffer | null;

function insert(db: Database.Database, table: string, row: Record<string, Value>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...Object.values(row));
}

interface Chat {
  pk: number;
  jid: string;
  identifier?: string | null;
  group?: number | null;
  last: number;
}

function chat(db: Database.Database, input: Chat): void {
  insert(db, "ZWACHATSESSION", {
    Z_PK: input.pk, Z_ENT: 6, Z_OPT: 3, ZCONTACTJID: input.jid, ZCONTACTIDENTIFIER: input.identifier ?? null,
    ZPARTNERNAME: `Synthetic Chat ${input.pk}`, ZSESSIONTYPE: input.group == null ? 0 : 1, ZFLAGS: 0, ZARCHIVED: 0,
    ZHIDDEN: 0, ZREMOVED: 0, ZMESSAGECOUNTER: 2, ZUNREADCOUNT: input.pk % 3, ZIDENTITYVERIFICATIONSTATE: 0,
    ZIDENTITYVERIFICATIONEPOCH: 0, ZLASTMESSAGEDATE: input.last, ZLASTMESSAGETEXT: "synthetic last line",
    ZLOCATIONSHARINGENDDATE: 0, ZETAG: `SYNTH-ETAG-${input.pk}`, ZSAVEDINPUT: null, ZSPOTLIGHTSTATUS: 1,
    ZCONTACTABID: 100 + input.pk, ZGROUPINFO: input.group ?? null, ZLASTMESSAGE: null, ZPROPERTIES: Buffer.from([1, input.pk]),
  });
}

interface Message {
  pk: number;
  chat: number | null;
  stanza: string;
  date: number | bigint;
  from: string | null;
  to: string | null;
  fromMe?: number;
  media?: number | null;
  member?: number | null;
  parent?: number | null;
  text?: string | null;
}

function message(db: Database.Database, input: Message): void {
  insert(db, "ZWAMESSAGE", {
    Z_PK: input.pk, Z_ENT: 9, Z_OPT: 4, ZSORT: input.pk, ZDOCID: input.pk * 7, ZSPOTLIGHTSTATUS: 0,
    ZCHATSESSION: input.chat, ZGROUPMEMBER: input.member ?? null, ZLASTSESSION: null, ZMEDIAITEM: input.media ?? null,
    ZMESSAGEINFO: null, ZPARENTMESSAGE: input.parent ?? null, ZSTANZAID: input.stanza,
    ZTEXT: input.text === undefined ? `synthetic message ${input.pk}` : input.text, ZFROMJID: input.from, ZTOJID: input.to,
    ZPUSHNAME: input.fromMe === 1 ? null : "Synthetic Sender", ZMESSAGEDATE: input.date,
    ZSENTDATE: typeof input.date === "bigint" ? input.date : input.date === 0 ? 0 : input.date + 0.25,
    ZMESSAGETYPE: input.media == null ? 0 : 1, ZGROUPEVENTTYPE: 0, ZFLAGS: 0, ZMESSAGESTATUS: input.fromMe === 1 ? 8 : 6,
    ZMESSAGEERRORSTATUS: 0, ZISFROMME: input.fromMe ?? 0, ZSTARRED: input.pk === 3 ? 1 : null, ZMEDIASECTIONID: null,
    ZPHASH: null, ZENCRETRYCOUNT: 0, ZFILTEREDRECIPIENTCOUNT: 0, ZCHILDMESSAGESDELIVEREDCOUNT: input.pk % 2,
    ZCHILDMESSAGESPLAYEDCOUNT: 0, ZCHILDMESSAGESREADCOUNT: 0, ZDATAITEMVERSION: 3,
  });
  insert(db, "ZWAMESSAGEINFO", { Z_PK: input.pk, Z_ENT: 10, Z_OPT: 1, ZMESSAGE: input.pk, ZRECEIPTINFO: Buffer.from([input.pk]) });
}

interface Media {
  pk: number;
  message: number;
  local: string | null;
  thumbnail?: string | null;
  xmpp?: string | null;
}

function media(db: Database.Database, root: string, input: Media): void {
  for (const pointer of [input.local, input.thumbnail]) {
    if (pointer == null) continue;
    const path = join(root, pointer);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `synthetic media bytes for ${pointer}\n`);
  }
  insert(db, "ZWAMEDIAITEM", {
    Z_PK: input.pk, Z_ENT: 8, Z_OPT: 2, ZFILESIZE: 41, ZMEDIAORIGIN: 0, ZMOVIEDURATION: 0, ZASPECTRATIO: 1.5,
    ZHACCURACY: 0, ZLATITUDE: 0, ZLONGITUDE: 0, ZMEDIAURLDATE: 800_000_000.5, ZAUTHORNAME: null, ZCOLLECTIONNAME: null,
    ZMEDIAURL: `https://media.example.invalid/${input.pk}`, ZTITLE: null, ZVCARDNAME: null, ZVCARDSTRING: null,
    ZMEDIAKEY: Buffer.from([0x01, 0x02, 0xff, input.pk]), ZMESSAGE: input.message, ZMEDIALOCALPATH: input.local,
    ZTHUMBNAILLOCALPATH: input.thumbnail ?? null, ZXMPPTHUMBPATH: input.xmpp ?? null, ZCLOUDSTATUS: 2,
    ZMETADATA: Buffer.from("synthetic metadata"),
  });
}

function pushname(db: Database.Database, pk: number, jid: string | null, name: string | null): void {
  insert(db, "ZWAPROFILEPUSHNAME", { Z_PK: pk, Z_ENT: 12, Z_OPT: 1, ZJID: jid, ZPUSHNAME: name });
}

export function businessStore(path: string): string {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(`
CREATE TABLE ZWABIZVERIFIEDNAMEDATA (
  Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZVERIFICATIONLEVEL INTEGER, ZEXPIRES TIMESTAMP, ZJID VARCHAR,
  ZNAME VARCHAR, ZPHONENUMBERJID VARCHAR, ZCERTIFICATEDETAILS BLOB
);
CREATE TABLE ZWABIZPROFILEDATA (Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZJID VARCHAR, ZADDRESS VARCHAR, ZEMAIL VARCHAR);
INSERT INTO ZWABIZVERIFIEDNAMEDATA VALUES
  (1, 20, 1, 3, NULL, '90000000000041@LID', 'Example Shop', '15550000041@s.whatsapp.net', X'00'),
  (2, 20, 1, 1, NULL, '90000000000042@lid', 'Synthetic Studio', NULL, X'01'),
  (3, 20, 1, 2, NULL, '90000000000043@lid', NULL, '15550000043@s.whatsapp.net', NULL),
  (4, 20, 1, 3, NULL, NULL, 'Nobody Listed', NULL, NULL);
INSERT INTO ZWABIZPROFILEDATA VALUES (1, 21, 1, '90000000000041@lid', '1 Example Street', 'shop@example.com');
`);
  db.close();
  return path;
}

export interface LiveStore {
  chats: string;
  calls: string;
  media: string;
}

export function macStore(dir: string): LiveStore {
  mkdirSync(dir, { recursive: true });
  const live: LiveStore = { chats: join(dir, "ChatStorage.sqlite"), calls: join(dir, "CallHistory.sqlite"), media: join(dir, "Message") };
  const db = new Database(live.chats);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  insert(db, "ZWAGROUPINFO", {
    Z_PK: 1, Z_ENT: 7, Z_OPT: 2, ZCHATSESSION: 4, ZLASTMESSAGEOWNER: 6, ZPICTUREPATH: "Media/Profile/group.thumb",
    ZSTATE: 2, ZCREATIONDATE: 700_000_000.25, ZSUBJECTTIMESTAMP: 700_000_100.5, ZCREATORJID: "15550000006@s.whatsapp.net",
    ZOWNERJID: "15550000006@s.whatsapp.net", ZSUBJECTOWNERJID: "90000000000007@lid", ZSOURCEJID: GROUP, ZPICTUREID: "SYNTH-PICTURE-1",
  });
  chat(db, { pk: 1, jid: "15550000002@s.whatsapp.net", identifier: "90000000000002@lid", last: 800_000_010.125 });
  chat(db, { pk: 2, jid: "90000000000003@LID", last: 800_000_020.5 });
  chat(db, { pk: 3, jid: "15550000004@s.whatsapp.net", identifier: "15550000004@s.whatsapp.net", last: 800_000_030.9996 });
  chat(db, { pk: 4, jid: GROUP, group: 1, last: 800_000_041 });
  chat(db, { pk: 5, jid: "0@s.whatsapp.net", last: 0 });
  chat(db, { pk: 6, jid: "15550000009@s.whatsapp.net", last: 790_000_000 });
  insert(db, "ZWAGROUPMEMBER", { Z_PK: 1, Z_ENT: 11, Z_OPT: 1, ZMEMBERJID: "15550000006@s.whatsapp.net", ZCONTACTIDENTIFIER: null });
  insert(db, "ZWAGROUPMEMBER", { Z_PK: 2, Z_ENT: 11, Z_OPT: 1, ZMEMBERJID: "90000000000007@lid", ZCONTACTIDENTIFIER: null });
  media(db, live.media, { pk: 1, message: 1, local: "Media/15550000002/a.jpg", thumbnail: "Media/15550000002/a.thumb", xmpp: "Media/15550000002/a.xmpp" });
  media(db, live.media, { pk: 2, message: 6, local: "Media/15550000001-1700000000/b.opus" });
  message(db, { pk: 1, chat: 1, stanza: "SYNTH-1", date: 800_000_000n, from: "15550000002@s.whatsapp.net", to: "15550000001@s.whatsapp.net", media: 1 });
  message(db, { pk: 2, chat: 1, stanza: "SYNTH-2", date: 800_000_010.125, from: "15550000001@s.whatsapp.net", to: "15550000002@s.whatsapp.net", fromMe: 1, parent: 1 });
  message(db, { pk: 3, chat: 2, stanza: "SYNTH-3", date: 800_000_020.5, from: "90000000000003@lid", to: "15550000001@s.whatsapp.net" });
  message(db, { pk: 4, chat: 3, stanza: "SYNTH:4:colon", date: 800_000_030.9996, from: "15550000004@s.whatsapp.net", to: "15550000001@s.whatsapp.net", text: "synthetic café line" });
  message(db, { pk: 5, chat: 4, stanza: "SYNTH-5", date: 800_000_040.25, from: GROUP, to: null, member: 1 });
  message(db, { pk: 6, chat: 4, stanza: "SYNTH-6", date: 800_000_041, from: GROUP, to: null, member: 2, media: 2 });
  message(db, { pk: 7, chat: null, stanza: "SYNTH-5", date: 800_000_050, from: GROUP, to: null, text: null });
  message(db, { pk: 8, chat: 999, stanza: "SYNTH-8", date: 800_000_060, from: "15550000005@s.whatsapp.net", to: null, member: 998 });
  message(db, { pk: 9, chat: 5, stanza: "SYNTH-9", date: 0, from: "0@s.whatsapp.net", to: "15550000001@s.whatsapp.net" });
  pushname(db, 1, "15550000002@s.whatsapp.net", "Synthetic Peer B");
  pushname(db, 2, "90000000000003@LID", "Synthetic Peer C");
  pushname(db, 3, "15550000004@s.whatsapp.net", null);
  pushname(db, 4, "", "Synthetic Nobody");
  pushname(db, 5, "0@s.whatsapp.net", "Synthetic Service");
  pushname(db, 6, "15550000006@s.whatsapp.net", "Synthetic Member \u{1F600}");
  insert(db, "ZWAPROFILEPICTUREITEM", { Z_PK: 1, Z_ENT: 13, Z_OPT: 1, ZJID: "15550000002@s.whatsapp.net", ZTHUMBNAILDATA: Buffer.alloc(64, 0x5a) });
  db.exec("COMMIT");
  db.close();

  const calls = new Database(live.calls);
  calls.exec(CALL_SCHEMA);
  insert(calls, "ZWAAGGREGATECALLEVENT", { Z_PK: 10, Z_ENT: 2, Z_OPT: 1, ZINCOMING: 1, ZMISSED: 0, ZMISSEDREASON: 0, ZVIDEO: 1, ZFIRSTDATE: 799_999_999.5, ZLINKTOKEN: "SYNTH-LINK-1" });
  insert(calls, "ZWAAGGREGATECALLEVENT", { Z_PK: 20, Z_ENT: 2, Z_OPT: 1, ZINCOMING: 0, ZMISSED: 1, ZMISSEDREASON: 2, ZVIDEO: 0, ZFIRSTDATE: 800_000_003n, ZLINKTOKEN: null });
  const call = (pk: number, aggregate: number, date: number | bigint, id: string) =>
    insert(calls, "ZWACDCALLEVENT", {
      Z_PK: pk, Z_ENT: 3, Z_OPT: 1, ZBYTESRECEIVED: pk * 100, ZBYTESSENT: pk * 50, ZISBOTGROUPCALL: 0, ZISLIGHTWEIGHT: 0,
      ZOUTCOME: pk, Z1CALLEVENTS: aggregate, Z_FOK_1CALLEVENTS: 0, ZDATE: date, ZDURATION: pk === 1 ? 120.5 : 0.25,
      ZCALLIDSTRING: id, ZGROUPCALLCREATORUSERJIDSTRING: pk === 3 ? "15550000002@s.whatsapp.net" : null,
      ZGROUPJIDSTRING: pk === 3 ? GROUP : null, ZREMINDERID: null, ZSCHEDULEDID: pk === 1 ? "SYNTH-SCHEDULE-1" : null,
    });
  call(1, 10, 800_000_000n, "SYNTH-CALL-1");
  call(2, 20, 800_000_003.5, "SYNTH-CALL-2");
  call(3, 10, 800_000_100n, "SYNTH-CALL-3");
  const participants: [number, number | null, string | null][] = [
    [100, 2, "15550000003@s.whatsapp.net"],
    [101, 1, "15550000002@s.whatsapp.net"],
    [102, 1, "15550000002@s.whatsapp.net"],
    [103, 1, "90000000000007@lid"],
    [104, 30, "15550000002@s.whatsapp.net"],
    [105, 1, null],
    [106, null, "15550000008@s.whatsapp.net"],
  ];
  for (const [pk, outcome, jid] of participants) {
    insert(calls, "ZWACDCALLEVENTPARTICIPANT", { Z_PK: pk, Z_ENT: 4, Z_OPT: 1, ZOUTCOME: outcome, Z1PARTICIPANTS: 10, Z_FOK_1PARTICIPANTS: 0, ZJIDSTRING: jid });
  }
  calls.close();
  return live;
}

export function laterTraffic(live: LiveStore): void {
  const db = new Database(live.chats);
  db.exec("BEGIN");
  chat(db, { pk: 7, jid: "15550000008@s.whatsapp.net", last: 800_000_220 });
  media(db, live.media, { pk: 3, message: 11, local: "Media/15550000001-1700000000/c.jpg" });
  message(db, { pk: 10, chat: 1, stanza: "SYNTH-10", date: 800_000_200, from: "15550000002@s.whatsapp.net", to: "15550000001@s.whatsapp.net", parent: 2 });
  message(db, { pk: 11, chat: 4, stanza: "SYNTH-11", date: 800_000_210, from: GROUP, to: null, member: 1, media: 3 });
  message(db, { pk: 12, chat: 7, stanza: "SYNTH-12", date: 800_000_220, from: "15550000001@s.whatsapp.net", to: "15550000008@s.whatsapp.net", fromMe: 1 });
  db.prepare("UPDATE ZWACHATSESSION SET ZUNREADCOUNT = 5, ZLASTMESSAGEDATE = 800000200 WHERE Z_PK = 1").run();
  pushname(db, 7, "15550000008@s.whatsapp.net", "Synthetic Peer H");
  db.exec("COMMIT");
  db.close();
}

export function phoneStore(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "ChatStorage.sqlite");
  const db = new Database(path);
  db.exec(SCHEMA);
  db.exec("BEGIN");
  chat(db, { pk: 11, jid: "15550000002@s.whatsapp.net", identifier: "90000000000002@lid", last: 800_000_010.125 });
  chat(db, { pk: 12, jid: GROUP, group: 21, last: 800_000_040.25 });
  insert(db, "ZWAGROUPINFO", {
    Z_PK: 21, Z_ENT: 7, Z_OPT: 2, ZCHATSESSION: 12, ZLASTMESSAGEOWNER: null, ZPICTUREPATH: null, ZSTATE: 1,
    ZCREATIONDATE: 700_000_000.25, ZSUBJECTTIMESTAMP: null, ZCREATORJID: "15550000006@s.whatsapp.net",
    ZOWNERJID: null, ZSUBJECTOWNERJID: null, ZSOURCEJID: GROUP, ZPICTUREID: null,
  });
  insert(db, "ZWAGROUPMEMBER", { Z_PK: 31, Z_ENT: 11, Z_OPT: 1, ZMEMBERJID: "15550000006@s.whatsapp.net", ZCONTACTIDENTIFIER: null });
  media(db, join(dir, "unshipped-media"), { pk: 41, message: 101, local: "Media/15550000002/a.jpg" });
  message(db, { pk: 101, chat: 11, stanza: "SYNTH-1", date: 800_000_000.000001, from: "15550000002@s.whatsapp.net", to: "15550000001@s.whatsapp.net", media: 41 });
  message(db, { pk: 102, chat: 11, stanza: "SYNTH-2", date: 800_000_010.125, from: "15550000001@s.whatsapp.net", to: "15550000002@s.whatsapp.net", fromMe: 1, parent: 101 });
  message(db, { pk: 103, chat: 12, stanza: "SYNTH-5", date: 800_000_040.25, from: GROUP, to: null, member: 31 });
  pushname(db, 1, "15550000002@S.WHATSAPP.NET", "Synthetic Peer B");
  db.exec("COMMIT");
  db.close();
  return path;
}


export function mediaIndex(chats: string, root: string): Buffer {
  const db = new Database(chats, { readonly: true });
  const entries: Record<string, { sha256: string; bytes: number }> = {};
  for (const row of db.prepare("SELECT ZMEDIALOCALPATH AS a, ZXMPPTHUMBPATH AS b, ZTHUMBNAILLOCALPATH AS c FROM ZWAMEDIAITEM").all() as Record<string, string | null>[]) {
    for (const pointer of Object.values(row)) {
      if (pointer === null || pointer === "" || !existsSync(join(root, pointer))) continue;
      const bytes = readFileSync(join(root, pointer));
      entries[pointer] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    }
  }
  db.close();
  const sorted = Object.fromEntries(Object.keys(entries).sort().map((key) => [key, entries[key]!]));
  return Buffer.from(`${JSON.stringify({ format: "org.lifestreamprotocol.blob-index/1", entries: sorted })}\n`);
}

export function sealSnapshot(live: LiveStore, out: string, withCalls = true): Record<string, string> {
  mkdirSync(out, { recursive: true });
  const files: Record<string, string> = { "chats.sqlite": join(out, "chats.sqlite"), "media.json": join(out, "media.json") };
  vacuumInto(live.chats, files["chats.sqlite"]!);
  writeFileSync(files["media.json"]!, mediaIndex(files["chats.sqlite"]!, live.media));
  if (withCalls) {
    files["calls.sqlite"] = join(out, "calls.sqlite");
    vacuumInto(live.calls, files["calls.sqlite"]);
  }
  return files;
}

export function sealDelta(live: LiveStore, out: string, after: number): Record<string, string> {
  mkdirSync(out, { recursive: true });
  const files: Record<string, string> = { "chats.sqlite": join(out, "chats.sqlite"), "media.json": join(out, "media.json") };
  vacuumInto(live.chats, files["chats.sqlite"]!);
  const db = new Database(files["chats.sqlite"]!);
  const jids = [
    "SELECT ZFROMJID FROM ZWAMESSAGE", "SELECT ZTOJID FROM ZWAMESSAGE", "SELECT ZCONTACTJID FROM ZWACHATSESSION",
    "SELECT ZCONTACTIDENTIFIER FROM ZWACHATSESSION", "SELECT ZMEMBERJID FROM ZWAGROUPMEMBER", "SELECT ZCREATORJID FROM ZWAGROUPINFO",
    "SELECT ZOWNERJID FROM ZWAGROUPINFO", "SELECT ZSUBJECTOWNERJID FROM ZWAGROUPINFO", "SELECT ZSOURCEJID FROM ZWAGROUPINFO",
  ].join(" UNION ");
  const keep: [string, string][] = [
    ["ZWAMESSAGE", `Z_PK > ${after} OR Z_PK IN (SELECT ZPARENTMESSAGE FROM ZWAMESSAGE WHERE Z_PK > ${after} AND ZPARENTMESSAGE IS NOT NULL)`],
    ["ZWAMEDIAITEM", "Z_PK IN (SELECT ZMEDIAITEM FROM ZWAMESSAGE WHERE ZMEDIAITEM IS NOT NULL)"],
    ["ZWAMESSAGEINFO", "ZMESSAGE IN (SELECT Z_PK FROM ZWAMESSAGE)"],
    ["ZWACHATSESSION", "Z_PK IN (SELECT ZCHATSESSION FROM ZWAMESSAGE)"],
    ["ZWAGROUPINFO", "Z_PK IN (SELECT ZGROUPINFO FROM ZWACHATSESSION)"],
    ["ZWAGROUPMEMBER", "Z_PK IN (SELECT ZGROUPMEMBER FROM ZWAMESSAGE)"],
    ["ZWAPROFILEPUSHNAME", `ZJID IN (${jids})`],
    ["ZWAPROFILEPICTUREITEM", "FALSE"],
  ];
  for (const [table, predicate] of keep) db.exec(`DELETE FROM ${table} WHERE NOT ((${predicate}) IS TRUE)`);
  db.exec("VACUUM");
  db.close();
  writeFileSync(files["media.json"]!, mediaIndex(files["chats.sqlite"]!, live.media));
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
  chat(db, { pk: 1, jid: "15550000002@s.whatsapp.net", identifier: "90000000000002@lid", last: 800_000_000 });
  pushname(db, 1, "15550000002@s.whatsapp.net", "Synthetic Peer B");
  db.exec(`
    WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < ${messages})
    INSERT INTO ZWAMESSAGE (Z_PK, Z_ENT, Z_OPT, ZSORT, ZCHATSESSION, ZSTANZAID, ZTEXT, ZFROMJID, ZTOJID, ZMESSAGEDATE, ZISFROMME)
    SELECT x, 9, 1, x, 1, 'SYNTH-BIG-' || x, hex(randomblob(${Math.ceil(bytes / 2)})), '15550000002@s.whatsapp.net',
           '15550000001@s.whatsapp.net', 700000000 + x, 0 FROM n;
  `);
  db.exec("COMMIT");
  db.close();
}


export const fixture: Fixture = (folder) => {
  const live = macStore(mkdtempSync(join(tmpdir(), "whatsapp-fixture-")));
  sealSnapshot(live, folder);
  rmSync(dirname(live.chats), { recursive: true, force: true });
  const chats = [
    "msg 90000000000002@lid:SYNTH-1", "msg 90000000000002@lid:SYNTH-2", "msg 90000000000003@lid:SYNTH-3", "msg 15550000004@s.whatsapp.net:SYNTH:4:colon",
    "msg 15550000001-1700000000@g.us:SYNTH-5", "msg 15550000001-1700000000@g.us:SYNTH-6", "msg unattached:15550000001-1700000000@g.us:SYNTH-5",
    "msg unattached:15550000005@s.whatsapp.net:SYNTH-8", "msg 0@s.whatsapp.net:SYNTH-9",
    "chat 90000000000002@lid", "chat 90000000000003@lid", "chat 15550000004@s.whatsapp.net", "chat 15550000001-1700000000@g.us", "chat 0@s.whatsapp.net",
    "chat 15550000009@s.whatsapp.net",
    "pushname 15550000002@s.whatsapp.net", "pushname 90000000000003@lid", "pushname 0@s.whatsapp.net", "pushname 15550000006@s.whatsapp.net",
  ];
  return {
    source: MAC_SOURCE,
    facts: { snapshot_taken_at: "2026-10-03T05:00:00.000Z" },
    files: { "chats.sqlite": { alone: chats }, "media.json": "trust", "calls.sqlite": { alone: ["call SYNTH-CALL-1", "call SYNTH-CALL-2", "call SYNTH-CALL-3"] } },
  };
};


export async function deliver(blobs: BlobStore, source: string, stated_ms: number, files: Record<string, string>, facts: JsonObject = {}): Promise<Delivery> {
  const sealed: Delivery["files"] = [];
  for (const [path, local] of Object.entries(files)) {
    sealed.push({ path, blob: await blobs.putFile(local, path.endsWith(".sqlite") ? { mediaType: "application/vnd.sqlite3" } : {}), size: statSync(local).size });
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
