import { isObject, type AiAdapter, type AiLine, type InputRecord, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";

type AiSaid = NonNullable<ReturnType<NonNullable<AiAdapter["said"]>>>;
type SourceRecords = Parameters<NonNullable<AiAdapter["session"]>>[1];

const CALLS = new Set(["function_call", "custom_tool_call", "web_search_call"]);
const INJECTED = /^\s*(?:<[A-Za-z_][\w-]*>|# AGENTS\.md instructions)/u;
const MAX_DEPTH = 8;

export const aiAdapter: AiAdapter = {
  version: "1",
  kinds: ["agent-turn"],
  session({ version }: InputRecord, records: SourceRecords) {
    if (lineOf(version.content) === null) return null;
    const id = root(records, logOf(version.key));
    return { id, cwd: text(meta(records, id)?.cwd) };
  },
  line({ version }: InputRecord, session: string, records: SourceRecords): AiLine | null {
    const line = lineOf(version.content);
    if (line === null) return null;
    const log = logOf(version.key);
    const thread = threadOf(log);
    const agent = thread === session ? {} : { agent: thread };
    const payload = isObject(line.payload) ? line.payload : undefined;
    if (thread === session && line.type === "turn_context" && payload !== undefined) return { ...agent, cwd: text(payload.cwd) };
    if (line.type !== "response_item" || payload === undefined) return agent;
    if (CALLS.has(text(payload.type) ?? "")) return { ...agent, tools: [version.key], files: patchedFiles(payload) };
    if (payload.type !== "message" || payload.role !== "user" || !personThread(meta(records, log) ?? meta(records, thread))) return agent;
    const parts = Array.isArray(payload.content) ? payload.content.filter(isObject) : [];
    const words = parts.flatMap((part) => part.type === "input_text" && typeof part.text === "string" ? [part.text] : []).join("\n");
    if (INJECTED.test(words)) return agent;
    return { ...agent, typed: { words, images: parts.filter((part) => part.type === "input_image").length } };
  },
  said({ version }: InputRecord): AiSaid | null {
    const line = lineOf(version.content);
    const payload = line !== null && isObject(line.payload) ? line.payload : undefined;
    if (line?.type !== "response_item" || payload?.type !== "message" || (payload.role !== "user" && payload.role !== "assistant")) return null;
    const type = payload.role === "user" ? "input_text" : "output_text";
    const words = (Array.isArray(payload.content) ? payload.content.filter(isObject) : [])
      .flatMap((part) => part.type === type && typeof part.text === "string" ? [part.text] : []).join("\n");
    return payload.role === "user" && INJECTED.test(words) ? null : { words };
  },
};

function logOf(key: string): string {
  return key.slice(0, key.lastIndexOf(":"));
}

function threadOf(log: string): string {
  const cut = log.indexOf("_");
  return cut < 0 ? log : log.slice(0, cut);
}

const metas = new WeakMap<SourceRecords, Map<string, JsonObject | null>>();

function meta(records: SourceRecords, log: string): JsonObject | null {
  let cache = metas.get(records);
  if (cache === undefined) metas.set(records, (cache = new Map()));
  if (cache.has(log)) return cache.get(log)!;
  const content = records.version("agent-turn", `${log}:1`)?.content;
  const line = lineOf(content);
  const found = line !== null && line.type === "session_meta" && isObject(line.payload) ? line.payload : null;
  cache.set(log, found);
  return found;
}

function parentOf(found: JsonObject | null): string | null {
  if (found === null) return null;
  const spawn = isObject(found.source) && isObject(found.source.subagent) ? found.source.subagent.thread_spawn : undefined;
  return text(found.parent_thread_id) ?? (isObject(spawn) ? text(spawn.parent_thread_id) : null);
}

function root(records: SourceRecords, log: string): string {
  let thread = threadOf(log);
  let found = meta(records, log);
  const seen = new Set([thread]);
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = parentOf(found);
    if (parent === null || seen.has(parent)) break;
    seen.add(parent);
    thread = parent;
    found = meta(records, parent);
  }
  return thread;
}

function personThread(found: JsonObject | null): boolean {
  if (found === null) return true;
  return (found.thread_source === undefined || found.thread_source === "user") && parentOf(found) === null;
}

function patchedFiles(payload: JsonObject): string[] {
  if (payload.name !== "apply_patch") return [];
  let patch = text(payload.input);
  if (patch === null && typeof payload.arguments === "string") {
    try {
      const parsed = JSON.parse(payload.arguments) as unknown;
      patch = isObject(parsed as Json) ? text((parsed as JsonObject).input) : null;
    } catch {
      patch = null;
    }
  }
  if (patch === null) return [];
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gmu)].map((match) => match[1]!.trim());
}

function lineOf(content: unknown): JsonObject | null {
  const line = isObject(content) ? content.line : undefined;
  return isObject(line) ? line : null;
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
