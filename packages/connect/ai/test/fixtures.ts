import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fixture, Spoiled } from "../../test/drive.js";
import { writeZip } from "../../test/zip.js";

export type Files = Record<string, Buffer>;

export const CHATGPT_ACCOUNT = "user-synthetic0001";
export const CHATGPT_SOURCE = `chatgpt:${CHATGPT_ACCOUNT}:export`;
export const CLAUDE_ACCOUNT = "11111111-1111-4111-8111-111111111111";
export const CLAUDE_SOURCE = `claude:${CLAUDE_ACCOUNT}:cloud`;

const CONVERSATION_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const CONVERSATION_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONVERSATION_C = "cccccccc-0000-4000-8000-00000000000c";
const ROOT = "client-created-root";
const PHOTO = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("synthetic png bytes")]);
const DAT = Buffer.from("%PDF-1.4 synthetic attachment");

export function node(id: string, parent: string, createTime: number, role: string, parts: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    parent,
    children: [],
    message: {
      id,
      author: { role, name: null, metadata: {} },
      create_time: createTime,
      update_time: null,
      content: { content_type: "text", parts },
      status: "finished_successfully",
      end_turn: role === "assistant" ? true : null,
      weight: 1,
      metadata: {},
      recipient: "all",
      channel: null,
      ...extra,
    },
  };
}

export function chatgptConversation(id: string, title: string, update: number, nodes: Record<string, unknown>[]): Record<string, unknown> {
  const mapping: Record<string, unknown> = { [ROOT]: { id: ROOT, message: null, parent: null, children: [] } };
  for (const entry of nodes) mapping[entry.id as string] = entry;
  return {
    title,
    create_time: 1754000000.25,
    update_time: update,
    mapping,
    moderation_results: [],
    current_node: nodes.at(-1)!.id,
    plugin_ids: null,
    conversation_id: id,
    conversation_template_id: null,
    gizmo_id: null,
    is_archived: false,
    safe_urls: [],
    default_model_slug: "synthetic-model",
    id,
  };
}

export function chatgptExport(version: "first" | "later" = "first"): Files {
  const a = chatgptConversation(CONVERSATION_A, "Synthetic planning", 1754000100.5, [
    node("a0000000-0000-4000-8000-000000000001", ROOT, 1754000001.123456, "user", ["Synthetic question about a list.", { content_type: "image_asset_pointer", asset_pointer: "file-service://file-AbC123", size_bytes: PHOTO.length }], {
      metadata: { attachments: [{ id: "file_00aa11", name: "synthetic.pdf", mime_type: "application/pdf" }, { id: "file-Missing1", name: "voice.wav" }] },
    }),
    node("a0000000-0000-4000-8000-000000000002", "a0000000-0000-4000-8000-000000000001", 1754000002.5, "assistant", ["Thinking about it."], {
      content: { content_type: "thoughts", thoughts: [{ summary: "Synthetic step", content: "Synthetic reasoning." }], source_analysis_msg_id: "x" },
    }),
    node("a0000000-0000-4000-8000-000000000003", "a0000000-0000-4000-8000-000000000002", 1754000003, "assistant", ["A synthetic answer."]),
  ]);
  const b = chatgptConversation(CONVERSATION_B, version === "first" ? "Synthetic recipe" : "Synthetic recipe, renamed", version === "first" ? 1754000200 : 1754100200, [
    node("b0000000-0000-4000-8000-000000000001", ROOT, 1754000150.75, "user", ["Synthetic recipe question."]),
    ...(version === "later" ? [node("b0000000-0000-4000-8000-000000000002", "b0000000-0000-4000-8000-000000000001", 1754100150, "assistant", ["A later synthetic reply."])] : []),
  ]);
  const c = chatgptConversation(CONVERSATION_C, "Synthetic shard two", 1754000300, [
    node("c0000000-0000-4000-8000-000000000001", ROOT, 1754000299, "user", ["Synthetic question in shard two."]),
  ]);
  return {
    "user.json": Buffer.from(JSON.stringify({ id: CHATGPT_ACCOUNT, email: "person-a@example.com", chatgpt_plus_user: false })),
    "conversations-000.json": Buffer.from(JSON.stringify(version === "first" ? [a, {}, b] : [{}, b])),
    "conversations-001.json": Buffer.from(JSON.stringify([c])),
    "file-AbC123-synthetic.png": PHOTO,
    "file_00aa11.dat": DAT,
    "chat.html": Buffer.from("<html>synthetic</html>"),
  };
}

export function chatgptShard(count: number, from = 0): Buffer {
  const parts: string[] = [];
  for (let index = from; index < from + count; index++) {
    const hex = index.toString(16).padStart(12, "0");
    const id = `dddddddd-0000-4000-8000-${hex}`;
    parts.push(JSON.stringify(chatgptConversation(id, `Synthetic ${index}`, 1754000000 + index, [
      node(`d0000000-0000-4000-8000-${hex}`, ROOT, 1754000000 + index, "user", [`Synthetic filler ${"x".repeat(2000)} ${index}`]),
    ])));
  }
  return Buffer.from(`[${parts.join(",")}]`);
}


function claudeMessage(uuid: string, parent: string | null, text: string, created: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uuid,
    text,
    content: [{ start_timestamp: created, stop_timestamp: created, type: "text", text, citations: [] }],
    sender: "human",
    created_at: created,
    updated_at: created,
    attachments: [],
    files: [],
    parent_message_uuid: parent,
    ...extra,
  };
}

function claudeConversation(uuid: string, name: string, created: string, updated: string, messages: unknown[]): Record<string, unknown> {
  return { uuid, name, summary: "", created_at: created, updated_at: updated, account: { uuid: CLAUDE_ACCOUNT }, chat_messages: messages };
}

export interface ClaudeExport {
  manifestName: string;
  manifest: Buffer;
  archives: Record<string, Files>;
}

export function claudeExport(version: "first" | "later" = "first"): ClaudeExport {
  const signature = version === "first" ? "sig-synthetic-1" : "sig-synthetic-2";
  const a = claudeConversation("22222222-2222-4222-8222-222222222222", version === "first" ? "Synthetic chat" : "Synthetic chat, renamed", "2026-08-31T09:00:00.000001Z", version === "first" ? "2026-08-31T10:01:00.000002Z" : "2026-09-02T10:01:00.000002Z", [
    claudeMessage("44444444-4444-4444-8444-444444444444", null, "Synthetic first turn.", "2026-08-31T10:00:00.000001Z"),
    claudeMessage("55555555-5555-4555-8555-555555555555", "44444444-4444-4444-8444-444444444444", "", "2026-08-31T10:00:05.123456Z", {
      sender: "assistant",
      content: [
        { type: "thinking", thinking: "Synthetic thought.", signature },
        { type: "tool_use", name: "synthetic_tool", input: { query: "synthetic" } },
        { type: "tool_result", name: "synthetic_tool", content: [{ type: "text", text: "Synthetic result.", uuid: version === "first" ? "66666666-6666-4666-8666-000000000001" : "66666666-6666-4666-8666-000000000002" }] },
        { type: "text", text: "Synthetic answer." },
      ],
    }),
  ]);
  const b = version === "first"
    ? claudeConversation("33333333-3333-4333-8333-333333333333", "Synthetic second chat", "2024-03-01T09:00:00.000001Z", "2023-07-01T00:00:00Z", [
        claudeMessage("77777777-7777-4777-8777-777777777777", "00000000-0000-4000-8000-000000000000", "Synthetic question.", "2024-03-01T09:00:01.000001Z"),
      ])
    : claudeConversation("33333333-3333-4333-8333-333333333333", "", "2024-03-01T09:00:00.000001Z", "2026-09-02T00:00:00.000001Z", []);
  const archives: Record<string, Files> = {
    "data-0001.zip": {
      "conversations.json": Buffer.from(JSON.stringify([a])),
      "users.json": Buffer.from(JSON.stringify([{ uuid: CLAUDE_ACCOUNT, full_name: "Person A", email_address: "person-a@example.com" }])),
      "projects.json": Buffer.from("[]"),
    },
    "data-0002.zip": { "conversations.json": Buffer.from(JSON.stringify([b])) },
  };
  const manifestName = "manifest-synthetic.json";
  const manifest = Buffer.from(JSON.stringify({
    created_at: version === "first" ? "2026-09-01T11:00:00.000001Z" : "2026-09-03T11:00:00.000001Z",
    total_files: 2,
    data_files: [{ filename: "data-0001.zip", category: "conversations" }, { filename: "data-0002.zip", category: "conversations" }],
  }));
  return { manifestName, manifest, archives };
}


export function zipped(members: Files, name: string): Files {
  const dir = mkdtempSync(join(tmpdir(), "ai-export-"));
  try {
    const path = join(dir, name);
    writeZip(path, Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: "deflate" as const })));
    return { [name]: readFileSync(path) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function inFolder(members: Files, folder: string): Files {
  return Object.fromEntries(Object.entries(members).map(([name, bytes]) => [`${folder}/${name}`, bytes]));
}

export function chatgptHanded(version: "first" | "later" = "first", form: "zip" | "folder" = "zip", extra: Files = {}): Files {
  const files = { ...chatgptExport(version), ...extra };
  return form === "zip" ? zipped(files, "chatgpt-export.zip") : inFolder(files, "chatgpt-export");
}

export function claudeOffered(version: "first" | "later" = "first"): Files {
  const { archives } = claudeExport(version);
  const conversations = (name: string) => JSON.parse(archives[name]!["conversations.json"]!.toString()) as unknown[];
  return { ...archives["data-0001.zip"]!, "conversations.json": Buffer.from(JSON.stringify([...conversations("data-0001.zip"), ...conversations("data-0002.zip")])) };
}

export function claudeHanded(version: "first" | "later" = "first", form: "zip" | "folder" = "zip"): Files {
  return form === "zip" ? zipped(claudeOffered(version), "data-batch-0000.zip") : inFolder(claudeOffered(version), "data-batch-0000");
}

export function claudeParts(version: "first" | "later" = "first"): { batch: Files; conversations: Files; light: Files } {
  const { archives } = claudeExport(version);
  const users = archives["data-0001.zip"]!["users.json"]!;
  return {
    batch: zipped({
      "users.json": users,
      "memories.json": Buffer.from(JSON.stringify([{ conversations_memory: "Synthetic memory.", account_uuid: CLAUDE_ACCOUNT }])),
      "projects/synthetic-project/project.json": Buffer.from(JSON.stringify({ uuid: "88888888-8888-4888-8888-888888888881", name: "Synthetic project" })),
      "design_chats/synthetic-design.json": Buffer.from(JSON.stringify({ uuid: "88888888-8888-4888-8888-888888888882", name: "Synthetic design" })),
      "conversations.json": archives["data-0001.zip"]!["conversations.json"]!,
    }, "data-synthetic-batch-0000.zip"),
    conversations: zipped({ "conversations.json": archives["data-0002.zip"]!["conversations.json"]! }, "data-synthetic-conversations-0001.zip"),
    light: zipped({
      "users.json": users,
      "login_history.json": Buffer.from(JSON.stringify([{ created_at: "2026-08-31T09:00:00Z", ip_address: "192.0.2.1", user_agent: "Synthetic browser" }])),
    }, "light_metadata-000.zip"),
  };
}


export function written(folder: string, files: Files): void {
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
  }
}

export function chatgptHeads(conversation: Record<string, unknown>): string[] {
  const id = (conversation.id ?? conversation.conversation_id) as string;
  const mapping = conversation.mapping as Record<string, { message: unknown }>;
  return [...Object.entries(mapping).filter(([, node]) => node.message !== null).map(([node]) => `msg ${id}:${node}`), `chat ${id}`];
}

function shard(elements: Record<string, unknown>[]): Spoiled {
  const half = Math.floor(Buffer.byteLength(JSON.stringify(elements)) / 2);
  let end = 1;
  const prefix: string[] = [];
  for (const element of elements) {
    end += Buffer.byteLength(JSON.stringify(element));
    if (end <= half && Object.keys(element).length > 0) prefix.push(...chatgptHeads(element));
    end += 1;
  }
  return { alone: elements.filter((element) => Object.keys(element).length > 0).flatMap(chatgptHeads), prefix };
}

export const chatgptFixture: Fixture = (folder) => {
  const files = chatgptExport("first");
  written(folder, files);
  const elements = (name: string) => JSON.parse(files[name]!.toString()) as Record<string, unknown>[];
  return {
    source: CHATGPT_SOURCE,
    facts: { exported_at: "2026-09-01T00:00:00.000Z" },
    files: {
      "user.json": "trust",
      "conversations-000.json": shard(elements("conversations-000.json")),
      "conversations-001.json": shard(elements("conversations-001.json")),
      "file-AbC123-synthetic.png": { alone: [] },
      "file_00aa11.dat": { alone: [] },
      "chat.html": { alone: [] },
    },
  };
};

export const claudeFixture: Fixture = (folder) => {
  const exported = claudeExport("first");
  written(folder, { [exported.manifestName]: exported.manifest });
  for (const [name, members] of Object.entries(exported.archives)) {
    writeZip(join(folder, name), Object.entries(members).map(([member, bytes]) => ({ name: member, bytes, method: "deflate" as const })));
  }
  const [a, b] = ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  return {
    source: CLAUDE_SOURCE,
    facts: { exported_at: "2026-09-01T11:00:00.000Z" },
    files: {
      [exported.manifestName]: { alone: [] },
      "data-0001.zip": { alone: [`chat ${a}`, `msg ${a}:44444444-4444-4444-8444-444444444444`, `msg ${a}:55555555-5555-4555-8555-555555555555`] },
      "data-0002.zip": { alone: [`msg ${b}:77777777-7777-4777-8777-777777777777`, `chat ${b}`] },
    },
  };
};

export const CHATGPT_SETS = { first: "first", later: "later" } as const;
export const CLAUDE_SETS = { first: "first", later: "later" } as const;
