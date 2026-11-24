import { isObject, type Dictation, type InputRecord, type Json, type JsonObject, type VoiceAdapter } from "@lifestreamprotocol/connect/sdk";

const PAGE_CAP = 80;

export const wisprFlowVoice: VoiceAdapter = {
  version: "1",
  kinds: ["dictation"],
  dictation({ version }: InputRecord): Dictation | null {
    const content = version.content;
    if (!isObject(content) || content.type !== "wispr-flow.dictation" || !isObject(content.History)) return null;
    const row = content.History;
    const words = firstText(row, ["editedText", "pastedText", "formattedText", "asrText"]);
    return words === null ? null : { words, app: text(row.app), page: pageOf(text(row.url)) };
  },
};

function pageOf(url: string | null): string | null {
  if (url === null) return null;
  let page: string;
  try {
    const parsed = new URL(url);
    page = `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/u, "")}`;
  } catch {
    page = url;
  }
  return page === "" ? null : clip(page, PAGE_CAP);
}

function firstText(object: JsonObject, members: string[]): string | null {
  for (const member of members) {
    const value = text(object[member]);
    if (value !== null && value.trim() !== "") return value;
  }
  return null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function clip(value: string, length: number): string {
  if (value.length <= length) return value;
  const code = value.charCodeAt(length - 1);
  return value.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
