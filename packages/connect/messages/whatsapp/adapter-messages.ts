import { isObject, type Adapters, type Json, type JsonObject, type MessageFact, type MessageImages, type MessageLabel } from "@lifestreamprotocol/connect/sdk";
import { canonicalJid } from "@lifestreamprotocol/core";

type Part = MessageFact["parts"][number];

export const whatsappMessages: NonNullable<Adapters["messages"]> = {
  version: "2",
  kinds: ["msg"],
  owner: "account",
  message: ({ version }) => isObject(version.content) ? readWhatsApp(version.key, version.content) : null,
  images: ({ version }) => imagesOf(version.key, version.content),
  group: (chat) => chat.endsWith("@g.us"),
  members: (chat) => chat.endsWith("@g.us") ? [] : [{ id: chat, kind: "jid" }],
  keyed: "chat",
  shown: (chat, aliases) => chat.endsWith("@s.whatsapp.net") ? aliases().find((alias) => alias.endsWith("@lid")) ?? chat : chat,
  labels: { kinds: ["chat", "pushname", "business"], ids: "jid" },
  label: ({ version }) => labelOf(version.kind, version.key, version.content),
  labelText: ({ version }) => labelText(version.kind, version.content),
  labelId: (handle) => handle.kind === "jid" ? handle.value : handle.kind === "phone" ? `${handle.value.slice(1)}@s.whatsapp.net` : null,
  self: (account) => /^\d+$/u.test(account) ? canonicalJid(`${account}@s.whatsapp.net`) : null,
};

const IMAGES = new Set([1, 15, 20]);
const BLOB_REF = /^sha256:[0-9a-f]{64}$/u;

function imagesOf(key: string, content: Json): MessageImages | null {
  if (!isObject(content) || content.type !== "whatsapp.msg" || !isObject(content.message) || !IMAGES.has(content.message.ZMESSAGETYPE as number)) return null;
  const file = Array.isArray(content.blobs) ? content.blobs.find((blob) => isObject(blob) && blob.role === FILE_ROLE) : undefined;
  if (!isObject(file) || typeof file.hash !== "string" || !BLOB_REF.test(file.hash)) return null;
  return { blobs: [file.hash], sender: imageSender(key, content, content.message) };
}

function imageSender(key: string, content: JsonObject, message: JsonObject): MessageImages["sender"] {
  const session = typeof content.session_jid === "string" ? content.session_jid : "";
  if (/@(?:lid\.)?status$|@broadcast$/u.test(session)) return null;
  const colon = key.indexOf(":");
  const chat = colon > 0 ? key.slice(0, colon) : "";
  if (chat.endsWith("@g.us") || canonicalJid(chat) === null || number(message.ZISFROMME) === 1) return null;
  const from = typeof message.ZFROMJID === "string" && message.ZFROMJID !== "" ? message.ZFROMJID : null;
  const id = canonicalJid(from === null || from.endsWith("@g.us") ? chat : from);
  return id === null ? null : { kind: "jid", value: id };
}

function labelOf(kind: string, key: string, content: Json): MessageLabel | null {
  if (!isObject(content)) return null;
  if (kind === "business" && content.type === "whatsapp.business") {
    const level = content.ZVERIFICATIONLEVEL;
    if (typeof level !== "number" || !Number.isSafeInteger(level)) return { names: [] };
    const ids = [...new Set([content.ZJID, content.ZPHONENUMBERJID].flatMap((value) => typeof value === "string" ? canonicalJid(value) ?? [] : []))];
    const name = named(content.ZNAME);
    return { names: [], business: { ids, level, ...(name === null ? {} : { name }) } };
  }
  if (kind === "pushname" && content.type === "whatsapp.pushname") {
    const id = typeof content.ZJID === "string" ? canonicalJid(content.ZJID) ?? content.ZJID.trim() : null;
    const name = named(content.ZPUSHNAME);
    return id === null || name === null ? { names: [] } : { names: [], pushName: [id, name] };
  }
  if (kind !== "chat" || content.type !== "whatsapp.chat" || !isObject(content.chat)) return null;
  const shell = content.chat;
  const partner = named(shell.ZPARTNERNAME);
  if (key.endsWith("@g.us")) return { names: partner === null ? [] : [[key, partner]], archived: typeof shell.ZARCHIVED === "number" && shell.ZARCHIVED !== 0 };
  const ids = [...new Set([key, shell.ZCONTACTJID, shell.ZCONTACTIDENTIFIER].flatMap((value) => typeof value === "string" ? canonicalJid(value) ?? [] : []))];
  const lids = ids.filter((id) => id.endsWith("@lid"));
  const phones = ids.filter((id) => id.endsWith("@s.whatsapp.net"));
  return {
    names: partner === null ? [] : ids.map((id) => [id, partner] as const),
    ...(lids.length === 1 && phones.length === 1 ? { pair: [lids[0]!, phones[0]!] as const } : {}),
  };
}

function labelText(kind: string, content: Json): { title: string | null; who: string[] } | null {
  if (!isObject(content)) return null;
  if (kind === "business" && content.type === "whatsapp.business") {
    return { title: named(content.ZNAME), who: [content.ZJID, content.ZPHONENUMBERJID].flatMap((value) => typeof value === "string" ? [value] : []) };
  }
  if (kind === "pushname" && content.type === "whatsapp.pushname") return { title: named(content.ZPUSHNAME), who: typeof content.ZJID === "string" ? [content.ZJID] : [] };
  if (kind !== "chat" || content.type !== "whatsapp.chat" || !isObject(content.chat)) return null;
  const shell = content.chat;
  const group = typeof shell.ZCONTACTJID === "string" && shell.ZCONTACTJID.endsWith("@g.us");
  const ids = group ? [] : [shell.ZCONTACTJID, shell.ZCONTACTIDENTIFIER].flatMap((value) => typeof value === "string" && canonicalJid(value) !== null ? [value] : []);
  return { title: named(shell.ZPARTNERNAME), who: ids };
}

function named(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

const FORWARDED = 256;
const FILE_ROLE = "ZWAMEDIAITEM.ZMEDIALOCALPATH";
const CALL_LOG = 59;
const NOTICE = "notice";

function readWhatsApp(key: string, content: JsonObject): MessageFact | null {
  if (content.type !== "whatsapp.msg") return null;
  const session = text(content.session_jid);
  if (session !== null && /@(?:lid\.)?status$|@broadcast$/u.test(session)) return null;
  const colon = key.indexOf(":");
  const chat = colon > 0 ? key.slice(0, colon) : "";
  const message = content.message;
  if (chat === "" || chat === "unattached" || !isObject(message)) return null;
  const type = number(message.ZMESSAGETYPE) ?? 0;
  if (type === CALL_LOG) return null;
  const group = chat.endsWith("@g.us");
  const from = number(message.ZISFROMME) === 1 ? { id: "me", kind: "me" as const } : sender(chat, group, content, message);
  const media = isObject(content.media_item) ? content.media_item : null;
  const blob = Array.isArray(content.blobs)
    ? content.blobs.find((value): value is JsonObject => isObject(value) && value.role === FILE_ROLE && typeof value.hash === "string")?.hash as string | undefined
    : undefined;
  const words = text(message.ZTEXT);
  const parts = partsOf(type, words, media, blob, message.ZGROUPEVENTTYPE);
  if (parts.length === 1 && parts[0]!.what === NOTICE) return null;
  const parent = text(content.parent_stanza_id);
  return {
    chat, from, text: type === 14 ? null : words, parts,
    forwarded: ((number(message.ZFLAGS) ?? 0) & FORWARDED) !== 0,
    edited: false,
    withdrawn: type === 14,
    reply_to: parent === null ? null : `${chat}:${parent}`,
  };
}

function sender(chat: string, group: boolean, content: JsonObject, message: JsonObject): MessageFact["from"] {
  const member = group ? text(content.group_member_jid) : null;
  if (member !== null) return jid(member);
  const fromJid = text(message.ZFROMJID);
  if (fromJid === null || fromJid.endsWith("@g.us")) return group ? { id: chat, kind: "system" } : jid(chat);
  return jid(fromJid);
}

const GROUP_EVENTS: Readonly<Record<number, string>> = {
  1: "subject changed", 56: "subject changed", 57: "description changed", 58: "description changed",
  26: "disappearing messages timer", 42: "group settings changed", 77: "group settings changed", 80: "group settings changed",
};

function partsOf(type: number, words: string | null, media: JsonObject | null, blob: string | undefined, event: Json | undefined): Part[] {
  const file = (part: Part): Part[] => [blob === undefined ? { what: part.what } : { ...part, blob }];
  switch (type) {
    case 0: return [];
    case 1: case 20: return file({ what: "photo", media_type: "image/jpeg", ask: "caption" });
    case 2: case 43: return file({ what: "video", media_type: "video/mp4" });
    case 3: {
      const seconds = Math.round(number(media?.ZMOVIEDURATION) ?? 0);
      return file({ what: "voice note", media_type: "audio/ogg", ask: "transcript", format: "ogg", ...(seconds > 0 ? { seconds } : {}) });
    }
    case 4: {
      const card = text(media?.ZVCARDSTRING);
      const said = [text(media?.ZVCARDNAME) ?? vcardName(card), ...vcardPhones(card)].filter((each): each is string => each !== null);
      return [{ what: said.length === 0 ? "contact card" : `contact card: ${said.join(", ")}` }];
    }
    case 5: {
      const lat = number(media?.ZLATITUDE);
      const lon = number(media?.ZLONGITUDE);
      return [lat === null || lon === null ? { what: "location" } : { what: "location", lat, lon }];
    }
    case 6: case 12: {
      const kind = number(event);
      if (kind === null) return [{ what: "group event" }];
      const meaning = GROUP_EVENTS[kind];
      return [{ what: `group event, kind ${kind}${meaning === undefined ? "" : `: ${meaning}`}` }];
    }
    case 7: {
      const title = text(media?.ZTITLE);
      return title !== null ? [{ what: `link preview: "${title}"` }] : words === null ? [{ what: "link" }] : [];
    }
    case 8: {
      const title = text(media?.ZTITLE);
      return file({ what: title === null ? "document" : `document: "${title}"`, media_type: "application/octet-stream" });
    }
    case 14: return [{ what: "message deleted" }];
    case 15: return file({ what: "sticker", media_type: "image/webp" });
    default: {
      const mime = text(media?.ZVCARDSTRING);
      if (mime !== null && /^(?:image|video|audio)\/[\w.+-]+$/u.test(mime)) {
        const what = mime.startsWith("image/") ? "photo" : mime.startsWith("video/") ? "video" : "voice note";
        return file({ what, media_type: mime, ...(what === "photo" ? { ask: "caption" as const } : {}) });
      }
      return words === null ? [{ what: NOTICE }] : [];
    }
  }
}

function jid(value: string): MessageFact["from"] {
  return { id: canonicalJid(value) ?? value.trim(), kind: "jid" };
}

function vcardName(card: string | null): string | null {
  const match = card === null ? null : /^FN[^:\n]*:(.+)$/mu.exec(card);
  return match?.[1]?.trim() || null;
}

function vcardPhones(card: string | null): string[] {
  if (card === null) return [];
  const unfolded = card.replace(/\r?\n[ \t]/gu, "");
  const phones = unfolded.split(/\r?\n/u).map(telValue).filter((each): each is string => each !== undefined && each !== "");
  return [...new Set(phones)];
}

function telValue(line: string): string | undefined {
  const name = /^(?:[\w-]+\.)?TEL(?=[;:])/iu.exec(line);
  if (name === null) return undefined;
  let quoted = false;
  for (let at = name[0].length; at < line.length; at++) {
    if (line[at] === '"') quoted = !quoted;
    else if (line[at] === ":" && !quoted) return line.slice(at + 1).trim().replace(/^tel:/iu, "");
  }
  return undefined;
}

function number(value: Json | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
