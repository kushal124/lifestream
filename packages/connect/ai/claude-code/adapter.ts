import { isObject, type AiAdapter, type AiLine, type InputRecord, type JsonObject } from "@lifestreamprotocol/connect/sdk";

type AiSaid = NonNullable<ReturnType<NonNullable<AiAdapter["said"]>>>;

const EDITS: Record<string, string> = { Edit: "file_path", MultiEdit: "file_path", Write: "file_path", NotebookEdit: "notebook_path" };

export const aiAdapter: AiAdapter = {
  version: "1",
  kinds: ["agent-turn"],
  folder: true,
  session({ version }: InputRecord) {
    const line = lineOf(version.content);
    return line !== null && typeof line.sessionId === "string" && line.sessionId !== "" ? { id: line.sessionId } : null;
  },
  line({ version }: InputRecord): AiLine | null {
    const line = lineOf(version.content);
    if (line === null) return null;
    const own = line.isSidechain !== true && text(line.cwd) !== null ? { cwd: text(line.cwd) } : {};
    const agent = typeof line.agentId === "string" && line.agentId !== "" ? { agent: line.agentId } : {};
    const parts = contentParts(line);
    if (line.type === "assistant") {
      const tools: string[] = [];
      const files: string[] = [];
      parts.forEach((part, index) => {
        if (part.type !== "tool_use") return;
        tools.push(text(part.id) ?? `${version.key}#${index}`);
        const member = EDITS[text(part.name) ?? ""];
        const path = member === undefined || !isObject(part.input) ? null : text(part.input[member]);
        if (path !== null) files.push(path);
      });
      return { ...own, ...agent, tools, files };
    }
    return { ...own, ...agent, typed: typed(line, parts) };
  },
  said({ version }: InputRecord): AiSaid | null {
    const line = lineOf(version.content);
    if (line === null) return null;
    const parts = contentParts(line);
    const cwd = text(line.cwd);
    if (line.type === "assistant") return { words: parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n"), cwd };
    const prompt = typed(line, parts);
    return prompt === null ? null : { ...prompt, cwd };
  },
};

function typed(line: JsonObject, parts: JsonObject[]): { words: string; images: number } | null {
  if (line.type !== "user" || line.isMeta === true) return null;
  if (line.toolUseResult !== undefined || parts.some((part) => part.type === "tool_result")) return null;
  const human = isObject(line.origin) && line.origin.kind === "human";
  if (!human && line.isSidechain === true && line.parentUuid === null && typeof line.agentId === "string") return null;
  if (!human && (line.origin !== undefined || line.promptSource !== undefined)) return null;
  if (line.isCompactSummary === true) return null;
  const message = isObject(line.message) ? line.message : undefined;
  const words = typeof message?.content === "string"
    ? message.content
    : parts.flatMap((part) => part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
  const command = /<command-name>([^<]*)<\/command-name>/u.exec(words);
  if (command !== null) {
    const name = command[1]!.trim();
    const args = /<command-args>([^<]*)<\/command-args>/u.exec(words)?.[1]?.trim() ?? "";
    return { words: `${name.startsWith("/") ? name : `/${name}`}${args === "" ? "" : ` ${args}`}`, images: 0 };
  }
  if (/^\s*<local-command-/u.test(words)) return null;
  return { words, images: parts.filter((part) => part.type === "image").length };
}

function lineOf(content: unknown): JsonObject | null {
  const line = isObject(content) ? content.line : undefined;
  return isObject(line) ? line : null;
}

function contentParts(line: JsonObject): JsonObject[] {
  const message = line.message;
  const content = isObject(message) ? message.content : undefined;
  return Array.isArray(content) ? content.filter(isObject) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
