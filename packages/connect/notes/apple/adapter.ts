import { isObject, type InputRecord, type Note, type NotesAdapter } from "@lifestreamprotocol/connect/sdk";
import { readNoteBody, stated, unmarked } from "./body.js";

const TRASH_FOLDER = 1;

export const notesAdapter: NotesAdapter = {
  version: "1",
  kinds: ["note"],
  copies: "edited-last",
  note: ({ version }: InputRecord): Note | null => {
    const content = version.content;
    if (!isObject(content) || content.type !== "apple.note" || !isObject(content.note)) return null;
    const note = content.note;
    const body = isObject(content.body) ? content.body : null;
    const locked = note.ZISPASSWORDPROTECTED === 1 || (body?.ZCRYPTOTAG !== null && body?.ZCRYPTOTAG !== undefined);
    let text = "";
    if (!locked) {
      const data = body?.ZDATA;
      const attachments = Array.isArray(content.attachments) ? content.attachments.filter(isObject) : [];
      const read = isObject(data) && typeof data.$bytes64 === "string" ? readNoteBody(Buffer.from(data.$bytes64, "base64"), attachments) : null;
      text = read !== null && "text" in read ? read.text : stated(note.ZSNIPPET) ?? "";
    }
    return {
      shape: "note",
      title: stated(note.ZTITLE1) ?? stated(text.split("\n").map(unmarked).find((line) => line !== "")) ?? "Untitled note",
      text, locked,
      trashed: isObject(content.folder) && content.folder.ZFOLDERTYPE === TRASH_FOLDER,
      marked: note.ZMARKEDFORDELETION === 1,
    };
  },
};
