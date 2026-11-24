import { each, instantOf, isObject, openDeliveredSqlite, refuse, requireColumns, rowJson, spanOf, unitOf, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const NOTE = "note";
export const STORE = "store.sqlite";
const COLUMNS = { note: ["id", "title", "body", "created", "modified"] } as const;

const note: Guard = (content) =>
  isObject(content) && content.type === "example-store.note" && isObject(content.note) && typeof content.note.id === "string" ? [] : ["a note is { type: example-store.note, note: its row }"];

export const exampleStore: Reader = {
  name: "example-store",
  kinds: { [NOTE]: note },
  columns: COLUMNS,
  async *read(delivery, files) {
    const store = delivery.files.find((file) => file.path === STORE) ?? refuse(`the delivery carries no ${STORE}`);
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, store);
    try {
      requireColumns(db, STORE, COLUMNS);
      yield* each(db.rows("note", "rowid", { columns: [...COLUMNS.note] }), (part) => part.where, (part): ReaderOutput[] => {
        const { rowid: _rowid, ...stated } = part.read();
        const row = rowJson(stated);
        const where = `note row ${String(row.id)}`;
        if (typeof row.id !== "string" || row.id === "") refuse(`${where} states no id`);
        if (typeof row.created !== "number") refuse(`${where} states no created time`);
        const created = instantOf(row.created, "unix-s", `${where} created`);
        const modified = typeof row.modified === "number" ? instantOf(row.modified, "unix-s", `${where} modified`) : created;
        return [{
          kind: NOTE, key: row.id, content: { type: "example-store.note", note: row },
          time: modified.start_ms > created.start_ms ? spanOf(created, modified, where) : created, device, locator: where,
        }];
      });
    } finally {
      db.close();
    }
  },
};
