import { isObject, type AiAdapter, type AiTurn, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export const aiAdapter: AiAdapter = {
  version: "1",
  kinds: ["msg", "chat"],
  copy: "cloud",
  gist: true,
  turn({ version }: InputRecord): AiTurn | null {
    const content = version.content;
    const message = object(isObject(content) ? content.message : undefined);
    const sender = message?.sender;
    if (message === undefined || (sender !== "human" && sender !== "assistant")) return null;
    const blocks = (Array.isArray(message.content) ? message.content : []).flatMap((value) => {
      const block = object(value);
      return block === undefined ? [] : [block];
    });
    const blockWords = blocks.flatMap((block) =>
      block.type === "text" && typeof block.text === "string" ? [block.text] : block.type === "voice_note" ? ["[voice note]"] : []);
    const tools: string[] = [];
    const documents: string[] = [];
    for (const block of blocks) {
      if (block.type !== "tool_use") continue;
      const name = text(block.name) ?? "a tool";
      const title = text(object(block.input)?.title);
      if (name === "artifacts" && title !== null) pushNew(documents, title);
      else if (name !== "artifacts") pushNew(tools, name);
    }
    const joined = blockWords.join("\n");
    return {
      role: sender === "human" ? "user" : "assistant",
      words: joined.trim() !== "" ? joined : typeof message.text === "string" ? message.text : "",
      attachments: [
        ...(Array.isArray(message.attachments) ? message.attachments : []).flatMap((value) => {
          const file = object(value);
          return file === undefined ? [] : [{ name: text(file.file_name) ?? "unnamed file", mime: text(file.file_type), text: text(file.extracted_content) }];
        }),
        ...(Array.isArray(message.files) ? message.files : []).flatMap((value) => {
          const file = object(value);
          return file === undefined ? [] : [{ name: text(file.file_name) ?? "unnamed file", mime: null, text: null }];
        }),
      ],
      images: 0,
      tools,
      documents,
    };
  },
  title({ version }: InputRecord): string | null {
    const content = version.content;
    const value = isObject(content) ? content.name : undefined;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  },
};

function pushNew(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

function object(value: Json | undefined): JsonObject | undefined {
  return isObject(value) ? value : undefined;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
