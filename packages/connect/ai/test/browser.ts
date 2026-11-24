import type { Fixture } from "../../test/drive.js";
import type { Signals } from "../../shared/station.js";
import { PAGE_FILE_BYTES, type Site, type SiteAnswer, type SiteRequest } from "../../test/station.js";
import { CHATGPT_ACCOUNT, CLAUDE_ACCOUNT, chatgptConversation, chatgptHeads, node, written } from "./fixtures.js";

export const CLAUDE_BROWSER_SOURCE = `claude:${CLAUDE_ACCOUNT}:browser`;
export const CHATGPT_BROWSER_SOURCE = `chatgpt:${CHATGPT_ACCOUNT}:browser`;
const ORGANIZATION = "99999999-9999-4999-8999-999999999999";
const ACCESS_TOKEN = "access-token-synthetic";

class Queue {
  readonly #queued: { pattern: RegExp; answers: SiteAnswer[] }[] = [];

  queue(pattern: RegExp, ...answers: SiteAnswer[]): void {
    this.#queued.push({ pattern, answers });
  }

  next(url: URL): SiteAnswer | undefined {
    const at = this.#queued.findIndex((entry) => entry.pattern.test(url.pathname + url.search) && entry.answers.length > 0);
    return at < 0 ? undefined : this.#queued[at]!.answers.shift();
  }
}


export interface ClaudeMessage {
  uuid: string;
  parent: string | null;
  sender: "human" | "assistant";
  text: string;
  at: string;
}

export interface ClaudeChat {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  messages: ClaudeMessage[];
  drift?: boolean;
}

export class ClaudeSite extends Queue implements Site {
  account = CLAUDE_ACCOUNT;
  email = "person-a@example.com";
  signedOut = false;
  signals: Partial<Signals> = {};
  chats: ClaudeChat[] = [claudeChat(1, "2026-09-04T10:00:00.000001Z"), claudeChat(2, "2026-09-05T10:00:00.000001Z"), claudeChat(3, "2026-09-06T10:00:00.000001Z")];

  answer({ url }: SiteRequest): SiteAnswer {
    const queued = this.next(url);
    if (queued !== undefined) return queued;
    if (this.signedOut && url.pathname.startsWith("/api/")) return { status: 401, body: { type: "error", error: { type: "permission_error" } } };
    if (url.pathname === "/api/account") return { status: 200, body: { uuid: this.account, email_address: this.email, full_name: "Person A" } };
    if (url.pathname === "/api/organizations") {
      return { status: 200, body: [{ uuid: "88888888-8888-4888-8888-888888888888", capabilities: ["api"] }, { uuid: ORGANIZATION, capabilities: ["chat", "claude_pro"], name: "Synthetic" }] };
    }
    if (url.pathname === `/api/organizations/${ORGANIZATION}/chat_conversations`) {
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const listed = [...this.chats].sort((left, right) => right.updated_at < left.updated_at ? -1 : 1).slice(offset, offset + limit);
      return { status: 200, body: listed.map((chat) => ({ ...shell(chat), current_leaf_message_uuid: chat.messages.at(-1)?.uuid ?? null })) };
    }
    const one = new RegExp(`^/api/organizations/${ORGANIZATION}/chat_conversations/([^/]+)$`, "u").exec(url.pathname);
    const chat = this.chats.find((each) => each.uuid === one?.[1]);
    if (chat === undefined) return { status: 404, body: { type: "error", error: { type: "not_found_error" }, request_id: "req-synthetic" } };
    const rendered = url.searchParams.get("rendering_mode") === "messages";
    const messages = chat.messages.map((message, index) => ({
      uuid: message.uuid,
      text: rendered ? "" : message.text,
      ...(rendered ? { content: [{ start_timestamp: message.at, stop_timestamp: message.at, type: "text", text: message.text, citations: [] }] } : {}),
      sender: message.sender,
      index,
      created_at: message.at,
      updated_at: message.at,
      truncated: false,
      attachments: [],
      files: [],
      sync_sources: [],
      ...(message.parent === null ? {} : { parent_message_uuid: message.parent }),
      ...(message.sender === "assistant" ? { stop_reason: "stop_sequence" } : {}),
    }));
    if (chat.drift === true && !rendered) messages.push({ ...messages[0]!, uuid: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", index: messages.length });
    return { status: 200, body: { ...shell(chat), settings: { enabled_web_search: true }, is_starred: false, is_archived: false, platform: "CLAUDE_AI", current_leaf_message_uuid: chat.messages.at(-1)!.uuid, chat_messages: messages } };
  }
}

function shell(chat: ClaudeChat) {
  return { uuid: chat.uuid, name: chat.name, summary: "", model: "synthetic-model", created_at: chat.created_at, updated_at: chat.updated_at, project_uuid: null };
}

export function claudeChat(n: number, updated: string): ClaudeChat {
  const id = (last: string) => `c000000${n}-0000-4000-8000-00000000000${last}`;
  const at = updated.replace("T10:", "T09:");
  return {
    uuid: id("0"),
    name: `Synthetic browser chat ${n}`,
    created_at: at,
    updated_at: updated,
    messages: [
      { uuid: id("a"), parent: null, sender: "human", text: `Synthetic question ${n}.`, at },
      { uuid: id("b"), parent: id("a"), sender: "assistant", text: `Synthetic answer ${n}.`, at },
    ],
  };
}


export interface GptChat {
  id: string;
  title: string;
  update: number;
}

export const GPT_MEDIA = { "file_00bb22": Buffer.from("synthetic image bytes"), "file-CdE456": Buffer.from("%PDF-1.4 synthetic upload") };

export class ChatgptSite extends Queue implements Site {
  account = CHATGPT_ACCOUNT;
  email = "person-a@example.com";
  signedOut = false;
  signals: Partial<Signals> = {};
  main: GptChat[] = [gptChat(1, 1789000100), gptChat(2, 1789000200)];
  archived: GptChat[] = [gptChat(3, 1789000300)];
  projects: Record<string, GptChat[]> = { "g-p-synthetic0001": [gptChat(4, 1789000400)], "g-p-synthetic0002": [] };
  readonly downloads: string[] = [];
  readonly linksRefused = new Set<string>();
  readonly mismatched = new Set<string>();
  readonly oversized = new Set<string>();

  answer({ url, headers }: SiteRequest): SiteAnswer {
    const queued = this.next(url);
    if (queued !== undefined) return queued;
    if (url.pathname === "/api/auth/session") return { status: 200, body: this.signedOut ? {} : { accessToken: ACCESS_TOKEN, sessionToken: "session-token-synthetic", user: { email: this.email } } };
    if (this.signedOut || headers.Authorization !== `Bearer ${ACCESS_TOKEN}`) return { status: 401, body: { detail: "Unauthorized" } };
    if (url.pathname === "/backend-api/me") return { status: 200, body: { object: "user", id: this.account, email: this.email, name: "Person A" } };
    if (url.pathname === "/backend-api/conversations") {
      const list = url.searchParams.get("is_archived") === "true" ? this.archived : this.main;
      const offset = Number(url.searchParams.get("offset"));
      const items = [...list].sort((left, right) => right.update - left.update).slice(offset, offset + Number(url.searchParams.get("limit")));
      return { status: 200, body: { items: items.map(listItem), total: 999, limit: 28, offset } };
    }
    if (url.pathname === "/backend-api/gizmos/snorlax/sidebar") {
      const names = Object.keys(this.projects);
      const page = Number(url.searchParams.get("cursor") ?? "0");
      const gizmo = names[page];
      return { status: 200, body: { items: gizmo === undefined ? [] : [{ gizmo: { gizmo: { id: gizmo }, files: [] }, conversations: { items: [] } }], cursor: page + 1 < names.length ? String(page + 1) : null } };
    }
    const project = /^\/backend-api\/gizmos\/([^/]+)\/conversations$/u.exec(url.pathname);
    if (project !== null) return { status: 200, body: { items: (this.projects[project[1]!] ?? []).map(listItem), cursor: null } };
    const one = /^\/backend-api\/conversation\/([^/]+)$/u.exec(url.pathname);
    if (one !== null) {
      const chat = [...this.main, ...this.archived, ...Object.values(this.projects).flat()].find((each) => each.id === one[1]);
      return chat === undefined ? { status: 404, body: { detail: "Can't load conversation" } } : { status: 200, body: gptConversation(chat) };
    }
    const download = /^\/backend-api\/files\/download\/([^/]+)$/u.exec(url.pathname);
    if (download !== null) {
      this.downloads.push(download[1]!);
      if (this.mismatched.has(download[1]!)) return { status: 403, body: { detail: "user_mismatch" } };
      if (!(download[1]! in GPT_MEDIA)) return { status: 404, body: { detail: "File not found" } };
      return { status: 200, body: { status: "success", download_url: `https://chatgpt.com/backend-api/estuary/content?id=${download[1]}&sig=synthetic`, file_name: "synthetic.bin", mime_type: null, file_size_bytes: null } };
    }
    if (url.pathname === "/backend-api/estuary/content") {
      const id = url.searchParams.get("id") as keyof typeof GPT_MEDIA;
      if (this.oversized.has(id)) return { status: 200, body: Buffer.alloc(PAGE_FILE_BYTES + 1) };
      return this.linksRefused.has(id) ? { status: 403, body: { detail: "Forbidden" } } : { status: 200, body: GPT_MEDIA[id] };
    }
    return { status: 404, body: { detail: "Not Found" } };
  }
}

export function gptChat(n: number, update: number): GptChat {
  return { id: `${"abcdef0123"[n]!.repeat(8)}-0000-4000-8000-00000000000${n}`, title: `Synthetic browser chat ${n}`, update };
}

function listItem(chat: GptChat) {
  return { id: chat.id, title: chat.title, create_time: new Date(1789000000 * 1000).toISOString(), update_time: new Date(chat.update * 1000).toISOString(), mapping: null, current_node: null, is_archived: false };
}

export function gptConversation(chat: GptChat): Record<string, unknown> {
  const n = chat.id.slice(-1);
  const user = `${n}0000000-0000-4000-8000-000000000001`;
  const tool = `${n}0000000-0000-4000-8000-000000000002`;
  const reply = `${n}0000000-0000-4000-8000-000000000003`;
  const asked = 1789000000 + Number(n) * 10;
  const conversation = chatgptConversation(chat.id, chat.title, chat.update, [
    node(user, "client-created-root", asked, "user", [`Synthetic browser question ${n}.`, { content_type: "image_asset_pointer", asset_pointer: "sediment://file_00bb22", size_bytes: 21 }], {
      metadata: { attachments: [{ id: "file-CdE456", name: "synthetic.pdf", mime_type: "application/pdf" }, { id: "file-Gone789", name: "gone.pdf" }] },
    }),
    node(tool, user, 0, "assistant", [], { create_time: null, recipient: "python", content: { content_type: "code", language: "python", text: "print('synthetic')" } }),
    node(reply, tool, asked + 5, "assistant", [`Synthetic browser answer ${n}.`]),
  ]);
  const mapping = conversation.mapping as Record<string, Record<string, unknown>>;
  mapping["synthetic-anchor"] = { id: "synthetic-anchor", message: null, parent: tool, children: [] };
  const { id: _, ...browser } = conversation;
  return { ...browser, owner: null, is_starred: null, gizmo_type: null, memory_scope: "global_enabled" };
}


const FETCHED = { fetched_at: "2026-09-10T12:00:00.000Z" };

function kept(site: Site, path: string): Buffer {
  const answer = site.answer({ url: new URL(path, "https://site.example"), method: "GET", headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  return Buffer.from(JSON.stringify(answer.body));
}

export const chatgptBrowserFixture: Fixture = (folder) => {
  const site = new ChatgptSite();
  const chats = [...site.main, ...site.archived];
  const files: Record<string, Buffer> = { "me.json": kept(site, "/backend-api/me") };
  for (const chat of chats) files[`conversations/${chat.id}.json`] = kept(site, `/backend-api/conversation/${chat.id}`);
  written(folder, files);
  return {
    source: CHATGPT_BROWSER_SOURCE,
    facts: FETCHED,
    files: { "me.json": "trust", ...Object.fromEntries(chats.map((chat) => [`conversations/${chat.id}.json`, { alone: chatgptHeads(gptConversation(chat)) }])) },
  };
};

export const claudeBrowserFixture: Fixture = (folder) => {
  const site = new ClaudeSite();
  const files: Record<string, Buffer> = { "account.json": kept(site, "/api/account") };
  const spoiled: Record<string, { alone: string[] }> = {};
  for (const chat of site.chats) {
    const at = `/api/organizations/${ORGANIZATION}/chat_conversations/${chat.uuid}`;
    files[`conversations/${chat.uuid}.messages.json`] = kept(site, `${at}?rendering_mode=messages&render_all_tools=true`);
    files[`conversations/${chat.uuid}.text.json`] = kept(site, at);
    const heads = [...chat.messages.map((message) => `msg ${chat.uuid}:${message.uuid}`), `chat ${chat.uuid}`];
    spoiled[`conversations/${chat.uuid}.messages.json`] = { alone: heads };
    spoiled[`conversations/${chat.uuid}.text.json`] = { alone: heads };
  }
  written(folder, files);
  return { source: CLAUDE_BROWSER_SOURCE, facts: FETCHED, files: { "account.json": "trust", ...spoiled } };
};
