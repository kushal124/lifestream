import { each, instantOf, isObject, openDeliveredSqlite, refuse, requireColumns, rowJson, spanOf, unitOf, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
export const STORE = "example.sqlite";
const COLUMNS = { notes: ["id", "title", "body", "created", "modified"] } as const;

const note: Guard = (content) => {
  if (!isObject(content) || content.type !== "example.note" || !isObject(content.notes)) return ["a note is { type: example.note, notes: its row }"];
  return typeof content.notes.id === "string" && content.notes.id !== "" ? [] : ["notes.id must be non-empty text"];
};

export const exampleMacApp: Reader = {
  name: "example-mac-app",
  kinds: { [NOTE]: note },
  columns: COLUMNS,
  async *read(delivery, files) {
    const store = delivery.files.find((file) => file.path === STORE) ?? refuse(`the delivery carries no ${STORE}`);
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, store);
    try {
      requireColumns(db, STORE, COLUMNS);
      yield* each(db.rows("notes", "rowid", { columns: [...COLUMNS.notes] }), (part) => part.where, (part): ReaderOutput[] => {
        const { rowid: _rowid, ...stated } = part.read();
        const row = rowJson(stated);
        const where = `notes row ${String(row.id)}`;
        if (typeof row.created !== "number") refuse(`${where} states no created time`);
        const created = instantOf(row.created, "unix-s", `${where} created`);
        const modified = typeof row.modified === "number" ? instantOf(row.modified, "unix-s", `${where} modified`) : created;
        return [{
          kind: NOTE, key: typeof row.id === "string" ? row.id : "", content: { type: "example.note", notes: row },
          time: modified.start_ms > created.start_ms ? spanOf(created, modified, where) : created, device, locator: where,
        }];
      });
    } finally {
      db.close();
    }
  },
};
