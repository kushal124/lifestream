import { isObject, type InputRecord, type Note, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

function note(record: InputRecord): Note | null {
  const content = record.version.content;
  const row = isObject(content) ? content.notes : undefined;
  if (!isObject(row) || typeof row.title !== "string") return null;
  const text = typeof row.body === "string" && row.body !== "" ? `${row.title}\n${row.body}` : row.title;
  return { shape: "note", title: row.title, text, locked: false, trashed: false, marked: false };
}

export const notes: NotesAdapter = { version: "1", kinds: [NOTE], note };
