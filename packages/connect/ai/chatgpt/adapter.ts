import { isObject, type AiAdapter, type AiTurn, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export const aiAdapter: AiAdapter = {
  version: "1",
  kinds: ["msg", "chat"],
  copy: "export",
  gist: true,
  turn({ version }: InputRecord): AiTurn | null {
    const content = version.content;
    const node = object(isObject(content) ? content.node : undefined);
    const message = object(node?.message);
    const role = object(message?.author)?.role;
    const body = object(message?.content);
    const type = body?.content_type;
    if (message === undefined || body === undefined) return null;
    if (role !== "user" && role !== "assistant") return null;
    if (type !== "text" && type !== "multimodal_text") return null;
    if (message.recipient !== undefined && message.recipient !== null && message.recipient !== "all") return null;
    if (message.channel === "analysis") return null;
    const metadata = object(message.metadata) ?? {};
    if (metadata.is_visually_hidden_from_conversation === true) return null;
    const parts = Array.isArray(body.parts) ? body.parts : [];
    return {
      role,
      words: parts.flatMap(words).join("\n"),
      attachments: (Array.isArray(metadata.attachments) ? metadata.attachments : []).flatMap((value) => {
        const file = object(value);
        const mime = text(file?.mime_type);
        if (file === undefined || mime?.toLowerCase().startsWith("image/") === true) return [];
        return [{ name: text(file.name) ?? "unnamed file", mime, text: null }];
      }),
      images: parts.filter(isImage).length,
      tools: [],
      documents: [],
    };
  },
  title({ version }: InputRecord): string | null {
    const content = version.content;
    const value = isObject(content) ? content.title : undefined;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  },
};

function words(part: Json): string[] {
  if (typeof part === "string") return part === "" ? [] : [part];
  const value = object(part);
  if (value === undefined) return [];
  if (typeof value.text === "string") return [value.text];
  const type = text(value.content_type) ?? text(value.type);
  if (type === "audio_asset_pointer") return ["[audio]"];
  if (type === "real_time_user_audio_video_asset_pointer") return ["[audio and video]"];
  return [];
}

function isImage(part: Json): boolean {
  const value = object(part);
  const type = text(value?.content_type) ?? text(value?.type) ?? "";
  return typeof value?.asset_pointer === "string" && type.includes("image");
}

function object(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
