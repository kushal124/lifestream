import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import type { Fixture } from "../../../test/drive.js";
import { API_FORMAT, MCP_FORMAT, PULL_MANIFEST } from "../answers.js";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `granola:${ACCOUNT}:cloud`;
export const UUID_1 = "11111111-aaaa-4bbb-8ccc-000000000001";
export const UUID_2 = "22222222-aaaa-4bbb-8ccc-000000000002";
export const UUID_3 = "33333333-aaaa-4bbb-8ccc-000000000003";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export function line(start: string, end: string, text: string, me = true): JsonObject {
  return { speaker: me ? { source: "microphone", attribution: "me" } : { source: "speaker", attribution: "them", diarization_label: "Speaker 2" }, text, start_time: start, end_time: end };
}

export function apiNote(id: string, uuid: string | null, fields: Partial<Record<string, Json>> = {}): JsonObject {
  return {
    id, object: "note", title: `Synthetic meeting ${id.slice(-2)}`, owner: { name: "Person A", email: ACCOUNT },
    created_at: "2026-10-20T09:00:00.000Z", updated_at: "2026-10-20T10:00:00.000Z", deleted_at: null,
    web_url: uuid === null ? `https://notes.granola.ai/t/${id}` : `https://notes.granola.ai/d/${uuid}`,
    calendar_event: null, attachments: [], attendees: [{ name: "Person A", email: ACCOUNT }, { name: "Person B", email: "person-b@example.com" }],
    folder_membership: [], space_membership: [], summary_text: "A synthetic summary.", summary_markdown: "### A synthetic summary", private_notes_text: null, private_notes_markdown: null,
    ...fields,
  } as JsonObject;
}

export interface PulledNote {
  note: JsonObject;
  pages?: Json[][];
  attachments?: Record<string, Buffer>;
}

export function apiPull(notes: PulledNote[], account = ACCOUNT): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const named = (path: string, bytes: Buffer) => {
    files[path] = bytes;
    return { file: path, sha256: sha(bytes), bytes: bytes.length };
  };
  const listed = notes.map(({ note, pages, attachments }) => {
    const id = note.id as string;
    return {
      id, ...named(`notes/${id}.json`, Buffer.from(JSON.stringify(note))),
      transcript: (pages ?? []).map((page, index) => named(`notes/${id}/transcript-${String(index + 1).padStart(4, "0")}.json`, Buffer.from(JSON.stringify({ transcript: page, hasMore: index + 1 < pages!.length, cursor: null })))),
      attachments: Object.entries(attachments ?? {}).map(([name, bytes]) => ({ id: name, ...named(`notes/${id}/attachments/${name}`, bytes) })),
    };
  });
  files[PULL_MANIFEST] = Buffer.from(`${JSON.stringify({ format: API_FORMAT, complete: true, account, fetched_at: "2026-10-27T09:00:00.000Z", requests: notes.length, notes: listed })}\n`);
  return files;
}

export function meetingElement(uuid: string, fields: { title?: string; at?: string; updated?: string; notes?: string | null; summary?: string; moved?: true } = {}): string {
  const at = fields.at ?? "2026-10-26T22:30:00.000+05:30";
  return `<meeting id="${uuid}" title="${fields.title ?? "Synthetic sync &amp; review"}" date="Oct 26, 2026 10:30 PM GMT+5:30" ${fields.moved === true ? "meeting_time" : "meeting_at"}="${at}" `
    + `created_at="2026-10-26T17:00:00.000Z" updated_at="${fields.updated ?? "2026-10-26T18:00:00.000Z"}" captured_by_me="true" listed_as_participant="true" is_workspace_visible="false" url="https://notes.granola.ai/d/${uuid}">`
    + `<known_participants>Person A (note creator) (${ACCOUNT}), Person B (person-b@example.com)</known_participants>`
    + `${fields.notes === undefined || fields.notes === null ? '<private_notes status="empty" />' : `<private_notes>${fields.notes}</private_notes>`}`
    + `<summary>${fields.summary ?? "### Synthetic summary\n- a point &lt;5 min"}</summary></meeting>`;
}

export interface Answered {
  tool: string;
  text: string;
  error?: true;
  media?: "json" | "sse";
}

export function mcpPull(answers: Answered[], account = ACCOUNT): Record<string, Buffer> {
  const files: Record<string, Buffer> = {};
  const listed = answers.map((answer, index) => {
    const rpc = index + 2;
    const message = JSON.stringify({ jsonrpc: "2.0", id: rpc, result: { content: [{ type: "text", text: answer.text }], ...(answer.error === true ? { isError: true } : {}) } });
    const media = answer.media ?? "json";
    const bytes = Buffer.from(media === "sse" ? `event: message\ndata: ${message}\n\n` : message);
    const file = `answer-${String(index + 1).padStart(5, "0")}.${media === "json" ? "json" : "sse"}`;
    files[file] = bytes;
    return { file, sha256: sha(bytes), bytes: bytes.length, media, rpc, tool: answer.tool, arguments: {} };
  });
  files[PULL_MANIFEST] = Buffer.from(`${JSON.stringify({ format: MCP_FORMAT, complete: true, account, fetched_at: "2026-10-27T09:00:00.000Z", calls: answers.length, answers: listed })}\n`);
  return files;
}

export function meetingsText(elements: string[]): string {
  return `Answer only from these meetings.\n<meetings_data count="${elements.length}">${elements.join("")}</meetings_data>`;
}

export const granolaFixture: Fixture = (folder) => {
  const files = apiPull([
    { note: apiNote("not_00000000000001", UUID_1, { transcript: [line("2026-10-20T09:01:00.000Z", "2026-10-20T09:02:00.000Z", "Synthetic opening."), line("2026-10-20T09:02:00.000Z", "2026-10-20T09:30:00.000Z", "Synthetic close.", false)] }) },
    {
      note: apiNote("not_00000000000002", UUID_2, { attachments: [{ id: "att_00000000000001", object: "attachment", type: "image", url: "https://files.granola.example.com/a?signature=1", width: 640, height: 480 }] }),
      attachments: { att_00000000000001: Buffer.from("synthetic image bytes") },
    },
    {
      note: apiNote("not_00000000000003", UUID_3),
      pages: [[line("2026-10-21T09:00:00.000Z", "2026-10-21T09:10:00.000Z", "Synthetic first page.")], [line("2026-10-21T09:10:00.000Z", "2026-10-21T09:45:00.000Z", "Synthetic second page.", false)]],
    },
  ]);
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), bytes);
  }
  const both = (uuid: string) => [`note ${uuid}`, `transcript ${uuid}`];
  return {
    source: SOURCE, facts: {},
    files: {
      [PULL_MANIFEST]: "trust",
      "notes/not_00000000000001.json": { alone: both(UUID_1) },
      "notes/not_00000000000002.json": { alone: [`note ${UUID_2}`] },
      "notes/not_00000000000002/attachments/att_00000000000001": { alone: [`note ${UUID_2}`] },
      "notes/not_00000000000003.json": { alone: both(UUID_3) },
      "notes/not_00000000000003/transcript-0001.json": { alone: both(UUID_3) },
      "notes/not_00000000000003/transcript-0002.json": { alone: both(UUID_3) },
    },
  };
};
