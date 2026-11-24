import { isObject, type Dictation, type InputRecord, type JsonObject, type VoiceAdapter } from "@lifestreamprotocol/connect/sdk";

export const aquaVoiceVoice: VoiceAdapter = {
  version: "1",
  kinds: ["dictation"],
  dictation({ version }: InputRecord): Dictation | null {
    const content = version.content;
    if (!isObject(content) || content.type !== "aqua-voice.dictation" || !isObject(content.dictation)) return null;
    const words = firstText(content.dictation, ["content", "rawText"]);
    return words === null ? null : { words, app: null, page: null };
  },
};

function firstText(object: JsonObject, members: string[]): string | null {
  for (const member of members) {
    const value = object[member];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}
