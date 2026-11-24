import { isObject, type InputRecord, type Note, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

function note(record: InputRecord): Note | null {
  const content = record.version.content;
  if (!isObject(content) || typeof content.text !== "string" || content.text === "") return null;
  return { shape: "note", title: content.text.split("\n")[0]!, text: content.text, locked: false, trashed: false, marked: false };
}

export const notes: NotesAdapter = { version: "1", kinds: [NOTE], note };
