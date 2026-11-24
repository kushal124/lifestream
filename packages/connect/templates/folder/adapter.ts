import { isObject, type InputRecord, type Note, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";
import { NOTE } from "./reader.js";

export const titleOf = (path: string): string => (path.split("/").at(-1) ?? path).replace(/\.md$/iu, "");

function note(record: InputRecord): Note | null {
  const content = record.version.content;
  if (!isObject(content) || typeof content.path !== "string" || typeof content.text !== "string") return null;
  const title = titleOf(content.path);
  const text = content.text.trim() === "" ? title : `${title}\n${content.text}`;
  return { shape: "note", title, text, locked: false, trashed: false, marked: false };
}

export const notes: NotesAdapter = { version: "1", kinds: [NOTE], note };
