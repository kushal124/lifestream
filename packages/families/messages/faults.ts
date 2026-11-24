import { BLOB_HASH, type MessageFact, type MessageImages, type MessagesAdapter } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";

const HASH_RULE = "is `sha256:` and 64 lower-case hex digits";

export function messagesFaults({ adapter, member, record, value }: Stated<MessagesAdapter>): string[] {
  if (value === null || typeof value !== "object") return [];
  if (member === "images") {
    const { blobs } = value as MessageImages;
    return (Array.isArray(blobs) ? blobs : []).filter((blob) => typeof blob !== "string" || !BLOB_HASH.test(blob)).map((blob) => `each of \`blobs\` ${HASH_RULE}: ${quoted(blob)} is none`);
  }
  if (member !== "message") return [];
  const message = value as MessageFact;
  const faults: string[] = [];
  (Array.isArray(message.parts) ? message.parts : []).forEach((part, index) => {
    if (part.blob !== undefined && (typeof part.blob !== "string" || !BLOB_HASH.test(part.blob))) faults.push(`\`parts[${index}].blob\` ${HASH_RULE}: ${quoted(part.blob)} is none`);
    if ((part.lat === undefined) !== (part.lon === undefined)) faults.push(`\`parts[${index}]\` states \`lat\` and \`lon\` together or neither: it states only \`${part.lat === undefined ? "lon" : "lat"}\``);
  });
  const key = record?.version.key;
  if (adapter.keyed === "chat" && key !== undefined && typeof message.chat === "string") {
    if (message.chat.includes(":") || !key.startsWith(`${message.chat}:`)) {
      faults.push(`with \`keyed: "chat"\` a message's key is \`<chat>:<id>\`, its chat the message's own and holding no \`:\`: key ${quoted(key)} and chat ${quoted(message.chat)} are not`);
    }
  }
  return faults;
}
