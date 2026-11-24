import { describe, expect, it } from "vitest";
import type { MessagePart, MessagesAdapter } from "@lifestreamprotocol/core";
import { BLOB, HEX, recordOf, statedOf } from "../test/stated.js";
import { messagesFaults } from "./faults.js";

const CHAT = "15550000001@s.whatsapp.net";
const MESSAGE = { chat: CHAT, from: { id: CHAT, kind: "jid" }, text: "Synthetic hello", parts: [] as MessagePart[], forwarded: false, edited: false, withdrawn: false, reply_to: null };
const KEYED: Partial<MessagesAdapter> = { keyed: "chat" };
const message = (changed: object, key = `${CHAT}:message-1`) => messagesFaults(statedOf(KEYED, "message", { ...MESSAGE, ...changed }, recordOf(key)));

describe("messagesFaults", () => {
  it("passes a message and its images that keep every rule", () => {
    expect(message({ parts: [{ what: "photo", blob: BLOB, media_type: "image/jpeg", ask: "caption" }, { what: "location", lat: 51.5, lon: -0.12 }] })).toEqual([]);
    expect(messagesFaults(statedOf({}, "message", { ...MESSAGE, chat: "a:b" }, recordOf("message-1")))).toEqual([]);
    expect(messagesFaults(statedOf<MessagesAdapter>({}, "images", { blobs: [BLOB], sender: null }))).toEqual([]);
  });

  it("names each rule a message breaks", () => {
    expect(message({ parts: [{ what: "photo", blob: HEX }] })).toEqual([`\`parts[0].blob\` is \`sha256:\` and 64 lower-case hex digits: \`${HEX}\` is none`]);
    expect(message({ parts: [{ what: "location", lat: 51.5 }] })).toEqual(["`parts[0]` states `lat` and `lon` together or neither: it states only `lat`"]);
    expect(message({}, "message-1")).toEqual([`with \`keyed: "chat"\` a message's key is \`<chat>:<id>\`, its chat the message's own and holding no \`:\`: key \`message-1\` and chat \`${CHAT}\` are not`]);
    expect(message({ chat: "group:1" }, "group:1:message-1")).toEqual(["with `keyed: \"chat\"` a message's key is `<chat>:<id>`, its chat the message's own and holding no `:`: key `group:1:message-1` and chat `group:1` are not"]);
    expect(messagesFaults(statedOf<MessagesAdapter>({}, "images", { blobs: [HEX], sender: null }))).toEqual([`each of \`blobs\` is \`sha256:\` and 64 lower-case hex digits: \`${HEX}\` is none`]);
  });
});
