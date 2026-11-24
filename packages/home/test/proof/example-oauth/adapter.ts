import { isObject, type InputRecord, type Note, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

function note(record: InputRecord): Note | null {
  const content = record.version.content;
  if (!isObject(content) || typeof content.title !== "string") return null;
  const text = typeof content.text === "string" && content.text !== "" ? `${content.title}\n${content.text}` : content.title;
  return { shape: "note", title: content.title, text, locked: false, trashed: false, marked: false };
}

export const notes: NotesAdapter = { version: "1", kinds: [NOTE], note };
