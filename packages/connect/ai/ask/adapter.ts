import { isObject, type AiAdapter, type AiTurn, type InputRecord } from "@lifestreamprotocol/connect/sdk";

const CITATION = /[ \t]*\[r[0-9]+\]/gu;

export const aiAdapter: AiAdapter = {
  version: "2",
  kinds: ["msg", "chat"],
  voice: true,
  turn({ version }: InputRecord): AiTurn | null {
    const content = version.content;
    if (!isObject(content)) return null;
    const role = content.role;
    if ((role !== "user" && role !== "assistant") || typeof content.text !== "string") return null;
    if (role === "assistant") return { role, words: content.text.replace(CITATION, ""), attachments: [], images: 0, tools: [], documents: [] };
    const images = Array.isArray(content.photos) ? content.photos.length : 0;
    const voice = isObject(content.voice) && typeof content.voice.audio === "string" && typeof content.voice.ms === "number" ? { audio: content.voice.audio, ms: content.voice.ms } : null;
    return { role, words: content.text, attachments: [], images, tools: [], documents: [], ...(voice === null ? {} : { voice }) };
  },
  title({ version }: InputRecord): string | null {
    const content = version.content;
    const value = isObject(content) ? content.title : undefined;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  },
};
