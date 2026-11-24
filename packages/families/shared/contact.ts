import { createHash } from "node:crypto";
import { isObject, sha256, type BlobReader, type Json } from "@lifestreamprotocol/core";

export interface ContactRef {
  readonly source: string;
  readonly key: string;
}

export interface ContactPhoto {
  readonly hash: string;
  readonly blob: boolean;
}

export function contactId({ source, key }: ContactRef): string {
  return createHash("sha256").update(`${source}\n${key}`).digest("hex");
}

export function contactCard(content: Json | undefined): string | null {
  return isObject(content) && typeof content.card === "string" ? content.card : null;
}

export function contactPhoto(content: Json | undefined): ContactPhoto | null {
  const named = namedPhoto(content);
  if (named !== null) return { hash: named.hash, blob: true };
  const card = contactCard(content);
  const inside = card === null ? null : cardPhoto(card);
  return inside === null ? null : { hash: sha256(inside.bytes), blob: false };
}

export function contactPhotoBytes(content: Json | undefined, blobs: Pick<BlobReader, "has" | "bytes">): { bytes: Buffer; type: string } | null {
  const named = namedPhoto(content);
  if (named !== null) return blobs.has(named.hash) ? { bytes: blobs.bytes(named.hash), type: named.type } : null;
  const card = contactCard(content);
  return card === null ? null : cardPhoto(card);
}

function namedPhoto(content: Json | undefined): { hash: string; type: string } | null {
  const photo = isObject(content) ? content.photo : undefined;
  if (!isObject(photo) || typeof photo.hash !== "string" || typeof photo.media_type !== "string") return null;
  return { hash: photo.hash, type: photo.media_type };
}

function cardPhoto(vcard: string): { bytes: Buffer; type: string } | null {
  for (const { name, value, parameters } of properties(vcard)) {
    if (name !== "PHOTO") continue;
    const uri = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/su.exec(value);
    if (uri !== null) {
      const bytes = uri[2]!.split(";").includes("base64") ? Buffer.from(uri[3]!.replace(/\s/gu, ""), "base64") : Buffer.from(uri[3]!.replace(/%([0-9a-f]{2})/giu, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16))), "latin1");
      return bytes.length === 0 ? null : { bytes, type: uri[1] || "application/octet-stream" };
    }
    const params = parameters.map((each) => each.toUpperCase());
    if (!params.some((each) => each === "ENCODING=B" || each === "ENCODING=BASE64" || each === "B")) continue;
    const type = params.find((each) => each.startsWith("TYPE="))?.slice(5).toLowerCase() ?? "jpeg";
    const bytes = Buffer.from(value.replace(/\s/gu, ""), "base64");
    return bytes.length === 0 ? null : { bytes, type: `image/${type === "jpg" ? "jpeg" : type}` };
  }
  return null;
}

export function* properties(vcard: string): Iterable<{ name: string; value: string; parameters: string[] }> {
  for (const line of vcard.replace(/\r\n[ \t]/gu, "").replace(/\n[ \t]/gu, "").replace(/\r\n/gu, "\n").split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const [property = "", ...parameters] = line.slice(0, colon).split(";");
    yield { name: property.replace(/^[^.]*\./u, "").toUpperCase(), value: line.slice(colon + 1).trim(), parameters };
  }
}
