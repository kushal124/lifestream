import { isObject, type InputRecord, type MessageFact, type MessagesAdapter } from "@lifestreamprotocol/connect/sdk";
import { MSG } from "./reader.js";

const group = (chat: string): boolean => chat.startsWith("g-");

function message(record: InputRecord): MessageFact | null {
  const content = record.version.content;
  if (!isObject(content) || typeof content.chat !== "string" || typeof content.from !== "string") return null;
  const from: MessageFact["from"] = content.from === "me" ? { id: "me", kind: "me" } : { id: content.from, kind: "network" };
  return {
    chat: content.chat, from, text: typeof content.text === "string" ? content.text : null, parts: [],
    forwarded: false, edited: false, withdrawn: false, reply_to: null,
  };
}

export const messages: MessagesAdapter = {
  version: "1",
  kinds: [MSG],
  message,
  group,
  members: (chat) => (group(chat) ? [] : [{ id: chat, kind: "network" }]),
};
