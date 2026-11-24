import { isObject, type Adapters, type Json, type JsonObject, type MessageFact, type MessageImages, type MessageLabel } from "@lifestreamprotocol/connect/sdk";
import { canonicalEmail, canonicalPhone, participantHandle } from "@lifestreamprotocol/core";
import { decodeAttributedBody } from "./typedstream.js";

type Part = MessageFact["parts"][number];
type Party = MessageFact["from"];

export const imessageMessages: NonNullable<Adapters["messages"]> = {
  version: "1",
  kinds: ["msg"],
  owner: "account",
  message: ({ version }) => isObject(version.content) ? readIMessage(version.content) : null,
  images: ({ version }) => imagesOf(version.content),
  group: isGroup,
  members: (chat) => chat.split(",").map((id): Party => ({ id, kind: id.startsWith("+") ? "phone" : id.includes("@") ? "email" : "raw" })),
  labels: { kinds: ["chat", "chat-state"] },
  label: ({ version }) => labelOf(version.content),
  self: (account) => canonicalPhone(account) ?? canonicalEmail(account),
};

const BLOB_REF = /^sha256:[0-9a-f]{64}$/u;

function imagesOf(content: Json): MessageImages | null {
  if (!isObject(content)) return null;
  const blobs = (Array.isArray(content.attachments) ? content.attachments : []).flatMap((attachment) => {
    if (!isObject(attachment) || typeof attachment.hash !== "string" || !BLOB_REF.test(attachment.hash)) return [];
    const mime = typeof attachment.mime_type === "string" ? attachment.mime_type.toLowerCase() : null;
    const extension = typeof attachment.transfer_name === "string" ? /\.([^./\\]+)$/u.exec(attachment.transfer_name)?.[1]?.toLowerCase() : undefined;
    return mime?.startsWith("image/") === true || (mime === null && extension !== undefined && IMAGE_EXTENSIONS.has(extension)) ? [attachment.hash] : [];
  });
  return blobs.length === 0 ? null : { blobs, sender: imageSender(content) };
}

function imageSender(content: JsonObject): MessageImages["sender"] {
  if (content.type !== "imessage.msg") return null;
  if (isObject(content.flags) && number(content.flags.is_from_me) === 1) return null;
  const sender = handleOf(content.sender);
  if (sender === null) return null;
  const recipients = Array.isArray(content.recipients) ? content.recipients.flatMap((value) => handleOf(value) ?? []) : [];
  const parties = new Set([sender, ...recipients].map((party) => participantHandle(party.value)));
  return parties.size === 1 && sender.kind !== "raw" ? { kind: sender.kind, value: sender.value } : null;
}

function handleOf(value: Json | undefined): { kind: "phone" | "email" | "raw"; value: string } | null {
  if (!isObject(value) || typeof value.canonical !== "string" || value.canonical === "") return null;
  const phone = value.kind === "phone" ? canonicalPhone(value.canonical) : null;
  if (phone !== null) return { kind: "phone", value: phone };
  const email = value.kind === "email" ? canonicalEmail(value.canonical) : null;
  if (email !== null) return { kind: "email", value: email };
  return { kind: "raw", value: participantHandle(value.canonical) };
}

function labelOf(content: Json): MessageLabel | null {
  if (!isObject(content)) return null;
  if (content.type === "imessage.chat" && Array.isArray(content.participants)) {
    const ids = [...new Set(content.participants.flatMap((each) => party(each)?.id ?? []))].sort(compare);
    return ids.length > 0 && isGroup(ids.join(",")) ? { names: [], chat: ids.join(",") } : null;
  }
  if (content.type !== "imessage.chat-state" || typeof content.chat_guid !== "string" || !isObject(content.state)) return null;
  const name = typeof content.state.display_name === "string" ? content.state.display_name.trim() : "";
  return name === "" ? null : { names: [], named: [content.chat_guid, name] };
}

function isGroup(chat: string): boolean {
  return new Set(chat.split(",").filter(Boolean).map(participantHandle)).size > 1;
}

const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"];

function readIMessage(content: JsonObject): MessageFact | null {
  if (content.type !== "imessage.msg") return null;
  const flags = isObject(content.flags) ? content.flags : {};
  const fromMe = number(flags.is_from_me) === 1;
  const sender = party(content.sender);
  const recipients = Array.isArray(content.recipients) ? content.recipients.flatMap((value) => party(value) ?? []) : [];
  if (!fromMe && sender === null) return null;
  const participants = new Map<string, Party>();
  for (const each of [...(fromMe || sender === null ? [] : [sender]), ...recipients]) participants.set(each.id, each);
  if (participants.size === 0) return null;
  const chat = [...participants.keys()].sort(compare).join(",");
  const body = bare(text(content.text) ?? attributedText(content.attributedBody));
  const associated = number(content.associated_message_type);
  const target = text(content.associated_message_guid)?.replace(/^(?:p:\d+\/|bp:)/u, "") ?? null;
  let words = body;
  let parts = Array.isArray(content.attachments) ? content.attachments.flatMap((value) => isObject(value) ? [attachment(value)] : []) : [];
  if (nonZero(content.date_retracted)) {
    words = null;
    parts = [{ what: "message unsent" }];
  } else if (associated !== null && associated >= 2000 && associated < 4000) {
    const name = TAPBACKS[associated % 1000] ?? "reaction";
    words = null;
    parts = [{ what: `reaction: ${associated >= 3000 ? `removed ${name}` : name}` }];
  }
  return {
    chat, from: fromMe ? { id: "me", kind: "me" } : sender!, text: words, parts,
    forwarded: false,
    edited: nonZero(content.date_edited) && !nonZero(content.date_retracted),
    withdrawn: nonZero(content.date_retracted),
    reply_to: target,
  };
}

function party(value: Json | undefined): Party | null {
  if (!isObject(value) || typeof value.canonical !== "string" || value.canonical.trim() === "") return null;
  const spelling = value.canonical.trim();
  if (value.kind === "phone") {
    const phone = canonicalPhone(spelling);
    if (phone !== null) return { id: phone, kind: "phone" };
  }
  if (value.kind === "email") {
    const email = canonicalEmail(spelling);
    if (email !== null) return { id: email, kind: "email" };
  }
  return { id: participantHandle(spelling), kind: "raw" };
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "heic", "heif", "gif", "webp", "tiff"]);
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  caf: "m4a", "x-caf": "m4a", m4a: "m4a", "x-m4a": "m4a", mp4: "m4a", aac: "aac", mp3: "mp3", mpeg: "mp3",
  wav: "wav", "x-wav": "wav", ogg: "ogg", opus: "ogg",
};

function attachment(value: JsonObject): Part {
  const mime = text(value.mime_type)?.toLowerCase() ?? null;
  const name = text(value.transfer_name);
  const extension = name === null ? null : /\.([^./\\]+)$/u.exec(name)?.[1]?.toLowerCase() ?? null;
  const hash = text(value.hash);
  const with_ = (part: Part): Part => hash === null ? { what: part.what } : { ...part, blob: hash };
  if (mime?.startsWith("image/") === true || (mime === null && extension !== null && IMAGE_EXTENSIONS.has(extension))) {
    return with_({ what: "photo", media_type: mime ?? `image/${extension === "jpg" ? "jpeg" : extension}`, ask: "caption" });
  }
  if (mime?.startsWith("audio/") === true || extension === "caf" || (extension !== null && extension in AUDIO_FORMATS && mime === null)) {
    const format = AUDIO_FORMATS[extension ?? ""] ?? AUDIO_FORMATS[mime?.slice("audio/".length) ?? ""];
    const media_type = mime ?? (extension === "caf" ? "audio/x-caf" : `audio/${extension}`);
    return with_({ what: "voice note", media_type, ask: "transcript", ...(format === undefined ? {} : { format }) });
  }
  if (mime?.startsWith("video/") === true) return with_({ what: "video", media_type: mime });
  if (extension === "pluginpayloadattachment") return { what: "link preview" };
  if (mime === "application/pdf") return with_({ what: name === null ? "document" : `document: "${name}"`, media_type: mime });
  return with_({ what: `attachment (${mime ?? extension ?? "unknown"})`, media_type: mime ?? "application/octet-stream" });
}

function attributedText(value: Json | undefined): string | null {
  if (!isObject(value) || typeof value.$bytes64 !== "string") return null;
  const decoded = decodeAttributedBody(Buffer.from(value.$bytes64, "base64"));
  return "text" in decoded && decoded.text.trim().length > 0 ? decoded.text : null;
}

function bare(value: string | null): string | null {
  const stripped = value?.replace(/\uFFFC/gu, "").trim();
  return stripped === undefined || stripped.length === 0 ? null : stripped;
}

function nonZero(value: Json | undefined): boolean {
  if (typeof value === "number") return value !== 0;
  return typeof value === "string" && /^-?\d+$/u.test(value) && !/^-?0+$/u.test(value);
}

function number(value: Json | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return typeof value === "string" && /^-?\d+(?:\.\d+)?$/u.test(value) ? Number(value) : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
