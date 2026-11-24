import { each, fingerprint, instant, isObject, openDeliveredSqlite, ordered, requireColumns, rowJson, span, together, tryInstant, unitOf, type DeliveryFile, type Guard, type Instant, type JsonObject, type Reader, type ReaderOutput, type Sqlite, type SqliteRow } from "@lifestreamprotocol/connect/sdk";

export const REMINDER = "reminder";
export const STORE_FILE = /^Data-[A-Za-z0-9-]+\.sqlite$/u;

const BOOKKEEPING = new Set([
  "ZCKDIRTYFLAGS", "ZCKNEEDSINITIALFETCHFROMCLOUD", "ZCKNEEDSTOBEFETCHEDFROMCLOUD", "ZCKCLOUDSTATE", "ZCKSERVERRECORDDATA",
  "ZCKSERVERSHAREDATA", "ZSPOTLIGHTINDEXCOUNT", "ZRESOLUTIONTOKENMAP", "ZRESOLUTIONTOKENMAP_V2_JSON", "ZRESOLUTIONTOKENMAP_V3_JSONDATA",
  "ZDUEDATERESOLUTIONTOKENASNONCE", "ZDAPUSHKEY", "ZDASYNCTOKEN", "ZEFFECTIVEMINIMUMSUPPORTEDAPPVERSION", "ZMINIMUMSUPPORTEDAPPVERSION",
  "ZLASTBANNERPRESENTATIONDATE",
]);
const CORE_DATA = /^Z_|^Z\d/u;
const POINTERS = new Set([
  "ZACCOUNT", "ZLIST", "ZPARENTREMINDER", "ZSHAREDTOMEREMINDERPLACEHOLDER", "ZALARM", "ZTRIGGER", "ZHASHTAGLABEL", "ZOWNER",
  "ZPARENTLIST", "ZPARENTLIST1", "ZPARENTACCOUNT", "ZPARENTACCOUNT1",
  "ZREMINDER", "ZREMINDER1", "ZREMINDER2", "ZREMINDER3", "ZREMINDER4", "ZREMINDER5",
]);
const BY_ROW = ["ZREMINDER", "ZREMINDER1", "ZREMINDER2", "ZREMINDER3", "ZREMINDER4", "ZREMINDER5"];
const BY_IDENTIFIER = ["ZREMINDERIDENTIFIER", "ZREMINDERIDENTIFIER1"];
const LIST_COLUMNS = [
  "ZIDENTIFIER", "ZCKIDENTIFIER", "ZEXTERNALIDENTIFIER", "ZNAME", "ZCOLOR", "ZBADGEEMBLEM", "ZISGROUP", "ZSMARTLISTTYPE",
  "ZSHARINGSTATUS", "ZSHAREDOWNERNAME", "ZSHAREDOWNERADDRESS", "ZSHAREDOWNERIDENTIFIER", "ZMARKEDFORDELETION", "ZDAISREADONLY", "ZDAISIMMUTABLE",
];
const ACCOUNT_COLUMNS = ["ZIDENTIFIER", "ZCKIDENTIFIER", "ZCKUSERRECORDNAME", "ZEXTERNALIDENTIFIER", "ZNAME", "ZTYPE", "ZINACTIVE", "ZPERSONID"];
const KEY_COLUMNS = ["ZIDENTIFIER", "ZCKIDENTIFIER", "ZTITLE", "ZCREATIONDATE", "ZACCOUNT"];

const REQUIRED: Record<string, string[]> = {
  ZREMCDREMINDER: ["Z_PK", "ZIDENTIFIER", "ZCKIDENTIFIER", "ZLIST", "ZACCOUNT", "ZPARENTREMINDER", "ZTITLE", "ZCREATIONDATE", "ZDUEDATE", "ZALLDAY", "ZTIMEZONE"],
  ZREMCDBASELIST: ["Z_PK", "Z_ENT", "ZIDENTIFIER", "ZNAME", "ZPARENTLIST"],
  ZREMCDOBJECT: ["Z_PK", "Z_ENT", "ZIDENTIFIER", "ZCKUSERRECORDNAME"],
  Z_PRIMARYKEY: ["Z_ENT", "Z_NAME"],
};
const MEMBERS = ["account", "alerts", "list", "objects", "parent", "reminder", "type"];

const reminder: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join() !== MEMBERS.join()) return [`members must be exactly ${MEMBERS.join(", ")}`];
  const problems: string[] = [];
  if (content.type !== "apple.reminder") problems.push("type must be apple.reminder");
  const record = content.reminder;
  if (!isObject(record)) problems.push("reminder must be the row's stated columns");
  else if (!["ZIDENTIFIER", "ZCKIDENTIFIER", "ZTITLE", "ZCREATIONDATE"].some((column) => column in record)) {
    problems.push("reminder states no identifier, title or creation date to name it by");
  }
  for (const member of ["list", "account"]) if (content[member] !== null && !isObject(content[member])) problems.push(`${member} must be an object or null`);
  if (content.parent !== null && typeof content.parent !== "string") problems.push("parent must be the parent reminder's name or null");
  for (const member of ["objects", "alerts"]) {
    if (!Array.isArray(content[member]) || !content[member].every(isObject)) problems.push(`${member} must be an array of objects`);
  }
  return problems;
};

export const appleReminders: Reader = {
  name: "reminders-mac",
  kinds: { [REMINDER]: reminder },
  async *read(delivery, files) {
    const stores = delivery.files.filter((file) => STORE_FILE.test(file.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (stores.length === 0) return;
    const device = unitOf(delivery.source);
    const opened: { file: DeliveryFile; db: Sqlite }[] = [];
    try {
      yield* each(stores, (file) => file.path, async (file) => {
        opened.push({ file, db: await openDeliveredSqlite(files, file) });
        return [];
      });
      for (const { file, db } of opened) requireColumns(db, file.path, REQUIRED);
      const copies = new Map<string, number>();
      const unkeyed = new Set<string>();
      for (const { file, db } of opened) {
        const keyed = each(db.rows("ZREMCDREMINDER", "Z_PK", { columns: KEY_COLUMNS }), (part) => `${file.path} ${part.where}`, (part) => {
          const row = part.read();
          const key = keyOf(row, objectRow(db, row.ZACCOUNT));
          copies.set(key, (copies.get(key) ?? 0) + 1);
          return [];
        });
        for await (const refusal of keyed) {
          unkeyed.add(refusal.key);
          yield refusal;
        }
      }
      const release = together(copies);
      for (const { file, db } of opened) for await (const row of readStore(db, file, device, unkeyed)) yield* release.row(row);
      yield* release.rest();
    } finally {
      for (const { db } of opened) db.close();
    }
  },
};

function readStore(db: Sqlite, file: DeliveryFile, device: string, unkeyed: ReadonlySet<string>): AsyncGenerator<ReaderOutput> {
  const entities = new Map<bigint, string>(db.all("SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY").map((row) => [row.Z_ENT as bigint, String(row.Z_NAME)]));
  const objectColumns = db.columns("ZREMCDOBJECT");
  const byRow = BY_ROW.filter((column) => objectColumns.includes(column));
  const byIdentifier = BY_IDENTIFIER.filter((column) => objectColumns.includes(column));
  const declared = new Set(db.tables());
  const object = (pk: unknown): SqliteRow | undefined => objectRow(db, pk);
  const entity = (row: SqliteRow): string | null => (typeof row.Z_ENT === "bigint" ? entities.get(row.Z_ENT) ?? null : null);

  return each(db.rows("ZREMCDREMINDER", "Z_PK"), (part) => `${file.path} ${part.where}`, function* (part) {
    if (unkeyed.has(`${file.path} ${part.where}`)) return;
    const row = part.read();
    const locator = `${file.path} ZREMCDREMINDER row ${String(row.Z_PK)}`;
    const list = typeof row.ZLIST === "bigint" ? db.get("SELECT * FROM ZREMCDBASELIST WHERE Z_PK = ?", row.ZLIST) : undefined;
    const parentList = list !== undefined && typeof list.ZPARENTLIST === "bigint" ? db.get("SELECT ZIDENTIFIER FROM ZREMCDBASELIST WHERE Z_PK = ?", list.ZPARENTLIST) : undefined;
    const account = object(row.ZACCOUNT);
    const parent = typeof row.ZPARENTREMINDER === "bigint" ? db.get("SELECT * FROM ZREMCDREMINDER WHERE Z_PK = ?", row.ZPARENTREMINDER) : undefined;

    const related: SqliteRow[] = [];
    const named = [...byRow.map((column) => `"${column}" = ?`), ...byIdentifier.map((column) => `"${column}" = ?`)];
    if (named.length > 0) {
      const params = [...byRow.map(() => row.Z_PK as bigint), ...byIdentifier.map(() => row.ZIDENTIFIER ?? null)];
      related.push(...db.all(`SELECT * FROM ZREMCDOBJECT WHERE ${named.join(" OR ")} ORDER BY Z_PK`, ...params));
    }
    const objects = related.map((each) => {
      const out: JsonObject = { entity: entity(each), ...stated(each) };
      const trigger = object(each.ZTRIGGER);
      if (trigger !== undefined) out.trigger = { entity: entity(trigger), ...stated(trigger) };
      const label = declared.has("ZREMCDHASHTAGLABEL") && typeof each.ZHASHTAGLABEL === "bigint"
        ? db.get("SELECT * FROM ZREMCDHASHTAGLABEL WHERE Z_PK = ?", each.ZHASHTAGLABEL) : undefined;
      if (label !== undefined) out.label = stated(label);
      return out;
    });
    const alerts = declared.has("ZREMCDDUEDATEDELTAALERT") && row.ZIDENTIFIER !== null
      ? db.all("SELECT * FROM ZREMCDDUEDATEDELTAALERT WHERE ZREMINDERIDENTIFIER = ? ORDER BY Z_PK", row.ZIDENTIFIER ?? null).map(stated)
      : [];

    const content: JsonObject = {
      type: "apple.reminder",
      reminder: stated(row),
      list: list === undefined ? null : { entity: entity(list), ...pick(list, LIST_COLUMNS), ...(parentList === undefined ? {} : { parent: nameOf(parentList) }) },
      account: account === undefined ? null : { entity: entity(account), ...pick(account, ACCOUNT_COLUMNS) },
      parent: parent === undefined ? null : nameOf(parent),
      objects: ordered(objects),
      alerts: ordered(alerts),
    };
    yield { kind: REMINDER, key: keyOf(row, account), content, ...timed(row), device, locator };
  });
}

function objectRow(db: Sqlite, pk: unknown): SqliteRow | undefined {
  return typeof pk === "bigint" && pk > 0n ? db.get("SELECT * FROM ZREMCDOBJECT WHERE Z_PK = ?", pk) : undefined;
}

function keyOf(row: SqliteRow, account: SqliteRow | undefined): string {
  return `${nameOf(row)}:${accountName(account)}`;
}

function nameOf(row: SqliteRow): string {
  const uuid = uuidOf(row.ZIDENTIFIER);
  if (uuid !== undefined) return uuid;
  if (typeof row.ZCKIDENTIFIER === "string" && row.ZCKIDENTIFIER.length > 0) return row.ZCKIDENTIFIER;
  if (row.ZTITLE != null || row.ZCREATIONDATE != null) return fingerprint(rowJson({ ZTITLE: row.ZTITLE ?? null, ZCREATIONDATE: row.ZCREATIONDATE ?? null }));
  return "";
}

function accountName(account: SqliteRow | undefined): string {
  const user = account?.ZCKUSERRECORDNAME;
  const name = typeof user === "string" && user.length > 0 ? user : uuidOf(account?.ZIDENTIFIER) ?? "";
  return name.replaceAll("%", "%25").replaceAll(":", "%3A");
}

function uuidOf(id: unknown): string | undefined {
  if (!Buffer.isBuffer(id) || id.length !== 16) return undefined;
  const hex = id.toString("hex").toUpperCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timed(row: SqliteRow): { time?: Instant } {
  const due = typeof row.ZDUEDATE === "number" ? row.ZDUEDATE : typeof row.ZDUEDATE === "bigint" ? Number(row.ZDUEDATE) : undefined;
  const at = due === undefined ? undefined : tryInstant(due, "apple-s");
  if (at === undefined) return {};
  if (row.ZALLDAY === 1n) {
    const date = instant(new Date(at.start_ms).toISOString().slice(0, 10), "date");
    return { time: span(date, date) };
  }
  return typeof row.ZTIMEZONE === "string" && row.ZTIMEZONE.length > 0 ? { time: at } : {};
}

function stated(row: SqliteRow): JsonObject {
  const kept: SqliteRow = {};
  for (const [column, value] of Object.entries(row)) {
    if (value !== null && !CORE_DATA.test(column) && !BOOKKEEPING.has(column) && !POINTERS.has(column)) kept[column] = value;
  }
  return rowJson(kept);
}

function pick(row: SqliteRow, columns: string[]): JsonObject {
  const kept: SqliteRow = {};
  for (const column of columns) if (row[column] != null) kept[column] = row[column]!;
  return rowJson(kept);
}
