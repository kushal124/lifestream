import { canonicalEmail, canonicalJid, canonicalPhone, phoneOfJid, textHead, type Handle } from "@lifestreamprotocol/core";
import type { RecordRead, RecordText } from "../family.js";

export const TEXT_BYTES = 64 * 1024;
export const TITLE_CHARS = 512;
export const BLOB_BYTES = 256 * 1024;

export function count(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

export function recordText(parts: { title?: string | null | undefined; text?: string | null | undefined; who?: readonly (string | Handle)[]; link?: string | null | undefined }): RecordText | null {
  const title = textHead(parts.title?.trim() ?? "", TITLE_CHARS);
  const text = cutBytes(parts.text?.trim() ?? "", TEXT_BYTES);
  if (title === "" && text === "") return null;
  const who = whoIds(parts.who ?? []);
  const link = parts.link?.trim() ?? "";
  return { ...(title === "" ? {} : { title }), text, ...(who.length === 0 ? {} : { who }), ...(link === "" ? {} : { link }) };
}

export function recordRead(parts: {
  title?: string | null | undefined; text?: string | null | undefined; from?: string | Handle | null; to?: readonly (string | Handle)[];
  who?: readonly (string | Handle)[]; link?: string | null | undefined;
}): RecordRead | null {
  const title = parts.title?.trim() ?? "";
  const text = parts.text?.trim() ?? "";
  if (title === "" && text === "") return null;
  const from = parts.from === undefined ? undefined : parts.from === null ? null : whoIds([parts.from])[0];
  const to = parts.to === undefined ? [] : whoIds(parts.to).filter((id) => id !== from);
  const who = whoIds(parts.who ?? []);
  const link = parts.link?.trim() ?? "";
  return {
    ...(title === "" ? {} : { title }), text, ...(from === undefined ? {} : { from }), ...(to.length === 0 ? {} : { to }),
    ...(who.length === 0 ? {} : { who }), ...(link === "" ? {} : { link }),
  };
}

function whoIds(ids: readonly (string | Handle)[]): string[] {
  const out: string[] = [];
  const add = (id: string | null) => {
    if (id !== null && id !== "" && !out.includes(id)) out.push(id);
  };
  for (const id of ids) {
    if (typeof id !== "string") {
      add(id.value);
      continue;
    }
    const jid = canonicalJid(id);
    if (jid !== null) {
      add(jid);
      add(phoneOfJid(jid));
      continue;
    }
    add(canonicalPhone(id) ?? canonicalEmail(id) ?? id.trim());
  }
  return out;
}

function cutBytes(text: string, bytes: number): string {
  if (text.length * 3 <= bytes || Buffer.byteLength(text, "utf8") <= bytes) return text;
  const encoded = Buffer.from(text, "utf8");
  let end = bytes;
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  return encoded.subarray(0, end).toString("utf8");
}
