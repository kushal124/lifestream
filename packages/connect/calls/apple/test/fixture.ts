import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { Fixture } from "../../../test/drive.js";

export const CALLS_UNIT = "macbook-pro-0001";
export const CALLS_SOURCE = `apple-calls:person-a@example.com:${CALLS_UNIT}`;
export const T0 = 811_584_000;
export const PHONE_A = "+15550000001";
export const PHONE_B = "+15550000002";

const LATER_COLUMNS = ", ZCOMMUNICATIONTRUSTSCORE INTEGER, ZREMINDERUUID BLOB, ZNEEDEDSCANNOUNCEMENT INTEGER, ZORIGINATINGUITYPE INTEGER, ZORIGINATINGDEVICENAME VARCHAR";
const CALL_RECORD =
  "CREATE TABLE ZCALLRECORD ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZANSWERED INTEGER, ZAUTOANSWEREDREASON INTEGER, ZCALLDIRECTORYIDENTITYTYPE INTEGER, ZCALL_CATEGORY INTEGER, ZCALLTYPE INTEGER, ZDISCONNECTED_CAUSE INTEGER, ZFACE_TIME_DATA INTEGER, ZFILTERED_OUT_REASON INTEGER, ZHANDLE_TYPE INTEGER, ZHASMESSAGE INTEGER, ZJUNKCONFIDENCE INTEGER, ZNUMBER_AVAILABILITY INTEGER, ZORIGINATED INTEGER, ZREAD INTEGER, ZSCREENSHARINGTYPE INTEGER, ZUSEDEMERGENCYVIDEOSTREAMING INTEGER, ZVERIFICATIONSTATUS INTEGER, ZWASEMERGENCYCALL INTEGER, ZINITIATOR INTEGER, ZDATE TIMESTAMP, ZDURATION FLOAT, ZADDRESS VARCHAR, ZBLOCKEDBYEXTENSION VARCHAR, ZBLOCKEDBYEXTENSIONNAME VARCHAR, ZIDENTITYEXTENSION VARCHAR, ZISO_COUNTRY_CODE VARCHAR, ZJUNKIDENTIFICATIONCATEGORY VARCHAR, ZLOCATION VARCHAR, ZNAME VARCHAR, ZSERVICE_PROVIDER VARCHAR, ZUNIQUE_ID VARCHAR, ZCONVERSATIONID BLOB, ZIMAGEURL VARCHAR, ZLOCALPARTICIPANTUUID BLOB, ZOUTGOINGLOCALPARTICIPANTUUID BLOB, ZPARTICIPANTGROUPUUID BLOB";

export const OLDER_LACKS = ["ZORIGINATINGUITYPE", "ZORIGINATINGDEVICENAME"];
export const MACOS_15_LACKS = [
  "ZINITIATOR", "ZCOMMUNICATIONTRUSTSCORE", "ZNEEDEDSCANNOUNCEMENT", "ZBLOCKEDBYEXTENSIONNAME", "ZREMINDERUUID",
  ...OLDER_LACKS,
];

export interface StoreShape {
  without?: readonly string[];
}

function callRecord({ without = [] }: StoreShape): string {
  return `${without.reduce((table, column) => table.replace(new RegExp(`, ${column} [A-Z]+`, "u"), ""), `${CALL_RECORD}${LATER_COLUMNS}`)})`;
}

function schema(shape: StoreShape): string[] {
  return [
    "CREATE TABLE ZCALLDBPROPERTIES ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTIMER_ALL FLOAT, ZTIMER_INCOMING FLOAT, ZTIMER_LAST FLOAT, ZTIMER_LIFETIME FLOAT, ZTIMER_OUTGOING FLOAT )",
    callRecord(shape),
    "CREATE TABLE ZEMERGENCYMEDIAITEM ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZEMERGENCYMEDIATYPE INTEGER, ZUPLOADEDFORCALL INTEGER, ZASSETID VARCHAR )",
    "CREATE TABLE ZHANDLE ( Z_PK INTEGER PRIMARY KEY, Z_ENT INTEGER, Z_OPT INTEGER, ZTYPE INTEGER, ZNORMALIZEDVALUE VARCHAR, ZVALUE VARCHAR )",
    "CREATE TABLE Z_2REMOTEPARTICIPANTHANDLES ( Z_2REMOTEPARTICIPANTCALLS INTEGER, Z_4REMOTEPARTICIPANTHANDLES INTEGER, PRIMARY KEY (Z_2REMOTEPARTICIPANTCALLS, Z_4REMOTEPARTICIPANTHANDLES) )",
    "CREATE TABLE Z_METADATA (Z_VERSION INTEGER PRIMARY KEY, Z_UUID VARCHAR(255), Z_PLIST BLOB)",
    "CREATE TABLE Z_MODELCACHE (Z_CONTENT BLOB)",
    "CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER)",
    ...(shape.without?.includes("ZINITIATOR") === true ? [] : ["CREATE INDEX ZCALLRECORD_ZINITIATOR_INDEX ON ZCALLRECORD (ZINITIATOR)"]),
    "CREATE INDEX ZEMERGENCYMEDIAITEM_ZUPLOADEDFORCALL_INDEX ON ZEMERGENCYMEDIAITEM (ZUPLOADEDFORCALL)",
    "CREATE INDEX Z_2REMOTEPARTICIPANTHANDLES_Z_4REMOTEPARTICIPANTHANDLES_INDEX ON Z_2REMOTEPARTICIPANTHANDLES (Z_4REMOTEPARTICIPANTHANDLES, Z_2REMOTEPARTICIPANTCALLS)",
    "CREATE UNIQUE INDEX Z_CallRecord_UNIQUE_unique_id ON ZCALLRECORD (ZUNIQUE_ID COLLATE BINARY ASC)",
    "CREATE INDEX Z_CallRecord_byDateIndex ON ZCALLRECORD (ZDATE COLLATE BINARY ASC)",
  ];
}

export interface Handle {
  value: string;
  type?: number;
}

export interface Call {
  pk: number;
  uniqueId: string | null;
  date: number;
  duration?: number;
  originated?: 0 | 1;
  answered?: 0 | 1;
  read?: 0 | 1;
  service?: string;
  handles?: Handle[];
  initiator?: Handle;
  emergencyMedia?: { type: number; assetId: string }[];
  override?: Record<string, unknown>;
}

export function createCallHistory(path: string, calls: Call[], options: StoreShape = {}): void {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    for (const statement of schema(options)) db.exec(statement);
    db.exec("INSERT INTO Z_PRIMARYKEY VALUES (1, 'CallDBProperties', 0, 1), (2, 'CallRecord', 0, 0), (3, 'EmergencyMediaItem', 0, 0), (4, 'Handle', 0, 0)");
    db.exec("INSERT INTO ZCALLDBPROPERTIES VALUES (1, 1, 1, 0.0, 0.0, 0.0, 0.0, 0.0)");
  } finally {
    db.close();
  }
  appendCalls(path, calls);
}

export function appendCalls(path: string, calls: Call[]): void {
  const db = new Database(path);
  try {
    const declared = new Set((db.prepare("SELECT name FROM pragma_table_info('ZCALLRECORD')").all() as { name: string }[]).map((column) => column.name));
    let handle = Number((db.prepare("SELECT coalesce(max(Z_PK), 0) AS n FROM ZHANDLE").get() as { n: number }).n);
    let media = Number((db.prepare("SELECT coalesce(max(Z_PK), 0) AS n FROM ZEMERGENCYMEDIAITEM").get() as { n: number }).n);
    const insertHandle = db.prepare("INSERT INTO ZHANDLE (Z_PK, Z_ENT, Z_OPT, ZTYPE, ZNORMALIZEDVALUE, ZVALUE) VALUES (?, 4, 1, ?, ?, ?)");
    const link = db.prepare("INSERT INTO Z_2REMOTEPARTICIPANTHANDLES VALUES (?, ?)");
    const insertMedia = db.prepare("INSERT INTO ZEMERGENCYMEDIAITEM VALUES (?, 3, 1, ?, ?, ?)");
    db.exec("BEGIN");
    for (const call of calls) {
      let initiator: number | null = null;
      if (call.initiator !== undefined) {
        initiator = ++handle;
        insertHandle.run(initiator, call.initiator.type ?? 2, call.initiator.value, call.initiator.value);
      }
      const columns: Record<string, unknown> = {
        Z_PK: call.pk, Z_ENT: 2, Z_OPT: 1,
        ZANSWERED: call.answered ?? 0, ZAUTOANSWEREDREASON: 0, ZCALLDIRECTORYIDENTITYTYPE: 0,
        ZCALL_CATEGORY: 1, ZCALLTYPE: 1, ZDISCONNECTED_CAUSE: null, ZFACE_TIME_DATA: null,
        ZFILTERED_OUT_REASON: null, ZHANDLE_TYPE: 2, ZHASMESSAGE: null, ZJUNKCONFIDENCE: 0,
        ZNUMBER_AVAILABILITY: 0, ZORIGINATED: call.originated ?? 0, ZREAD: call.read ?? 1,
        ZSCREENSHARINGTYPE: 0, ZUSEDEMERGENCYVIDEOSTREAMING: 0, ZVERIFICATIONSTATUS: 4,
        ZWASEMERGENCYCALL: 0, ZINITIATOR: initiator, ZDATE: call.date, ZDURATION: call.duration ?? 0,
        ZADDRESS: call.handles?.[0]?.value ?? null, ZBLOCKEDBYEXTENSION: null, ZBLOCKEDBYEXTENSIONNAME: null,
        ZIDENTITYEXTENSION: null, ZISO_COUNTRY_CODE: "us", ZJUNKIDENTIFICATIONCATEGORY: null,
        ZLOCATION: "Synthetic Region", ZNAME: null, ZSERVICE_PROVIDER: call.service ?? "com.example.Telephony",
        ZUNIQUE_ID: call.uniqueId, ZCONVERSATIONID: null, ZIMAGEURL: null,
        ZLOCALPARTICIPANTUUID: Buffer.from("synthetic-line-a"), ZOUTGOINGLOCALPARTICIPANTUUID: Buffer.from("synthetic-line-a"),
        ZPARTICIPANTGROUPUUID: null, ZCOMMUNICATIONTRUSTSCORE: 4, ZREMINDERUUID: null,
        ZNEEDEDSCANNOUNCEMENT: null, ZORIGINATINGUITYPE: 0, ZORIGINATINGDEVICENAME: null,
        ...call.override,
      };
      const names = Object.keys(columns).filter((name) => declared.has(name));
      db.prepare(`INSERT INTO ZCALLRECORD (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`).run(...names.map((name) => columns[name]));
      for (const remote of call.handles ?? []) {
        const id = ++handle;
        insertHandle.run(id, remote.type ?? 2, remote.value, remote.value);
        link.run(call.pk, id);
      }
      for (const item of call.emergencyMedia ?? []) insertMedia.run(++media, item.type, call.pk, item.assetId);
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export function baseCalls(): Call[] {
  return [
    { pk: 1, uniqueId: "SYNTH-CALL-0001", date: T0 + 0.25, duration: 61.5, answered: 1, handles: [{ value: PHONE_A }], initiator: { value: PHONE_A } },
    { pk: 2, uniqueId: "SYNTH-CALL-0002", date: T0 + 600, duration: 0, answered: 0, read: 0, handles: [{ value: PHONE_B }], initiator: { value: PHONE_B } },
    {
      pk: 3, uniqueId: "SYNTH-CALL-0003", date: T0 + 1200, duration: 300, originated: 1, service: "com.example.FaceTime",
      handles: [{ value: PHONE_B }, { value: "person-b@example.com", type: 3 }],
      emergencyMedia: [{ type: 2, assetId: "SYNTH-ASSET-2" }, { type: 1, assetId: "SYNTH-ASSET-1" }],
    },
  ];
}

export function sealDelta(source: string, path: string, after: number): void {
  const db = new Database(source, { readonly: true });
  db.prepare("VACUUM INTO ?").run(path);
  db.close();
  const delta = new Database(path);
  delta.exec(`
    DELETE FROM ZCALLRECORD WHERE NOT (Z_PK > ${after});
    DELETE FROM Z_2REMOTEPARTICIPANTHANDLES WHERE NOT EXISTS (SELECT 1 FROM ZCALLRECORD AS kept WHERE kept.Z_PK = Z_2REMOTEPARTICIPANTCALLS);
    DELETE FROM ZHANDLE WHERE NOT (EXISTS (SELECT 1 FROM Z_2REMOTEPARTICIPANTHANDLES AS joined WHERE joined.Z_4REMOTEPARTICIPANTHANDLES = ZHANDLE.Z_PK)
      OR EXISTS (SELECT 1 FROM ZCALLRECORD AS kept WHERE kept.ZINITIATOR = ZHANDLE.Z_PK));
    DELETE FROM ZEMERGENCYMEDIAITEM WHERE NOT EXISTS (SELECT 1 FROM ZCALLRECORD AS kept WHERE kept.Z_PK = ZUPLOADEDFORCALL);
    VACUUM;
  `);
  delta.close();
}

export const fixture: Fixture = (folder) => {
  createCallHistory(join(folder, "callhistory.sqlite"), baseCalls());
  return {
    source: CALLS_SOURCE, facts: { snapshot_taken_at: "2026-09-21T00:00:00.000Z" }, files: { "callhistory.sqlite": "trust" },
    heads: [
      "call SYNTH-CALL-0001", "call SYNTH-CALL-0002", "call SYNTH-CALL-0003",
    ],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "callhistory-mac": fixture,
};
