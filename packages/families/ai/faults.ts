import { BLOB_HASH, type AiAdapter, type AiTurn } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";

export function aiFaults({ member, value }: Stated<AiAdapter>): string[] {
  if (member !== "turn" || value === null || typeof value !== "object") return [];
  const audio = (value as AiTurn).voice?.audio;
  return audio === undefined || (typeof audio === "string" && BLOB_HASH.test(audio)) ? [] : [`\`voice.audio\` is \`sha256:\` and 64 lower-case hex digits: ${quoted(audio)} is none`];
}
