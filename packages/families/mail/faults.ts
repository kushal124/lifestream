import { BLOB_HASH, type MailAdapter, type MailItem } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";

export function mailFaults({ member, value }: Stated<MailAdapter>): string[] {
  if (member !== "mail" || value === null || typeof value !== "object") return [];
  const { blob } = value as MailItem;
  return blob === null || (typeof blob === "string" && BLOB_HASH.test(blob)) ? [] : [`\`blob\` is \`sha256:\` and 64 lower-case hex digits: ${quoted(blob)} is none`];
}
