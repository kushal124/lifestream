import type { JsonObject } from "@lifestreamprotocol/core";

const API = "https://public-api.granola.ai";
const MCP = "https://mcp.granola.ai/mcp";
const AUTH = "https://mcp-auth.granola.ai";
const FILES = "https://files.granola.example.com";
const DAY = 86_400_000;

export interface FakeLine {
  speaker: JsonObject;
  text: string;
  start_time: string;
  end_time: string;
}

export interface FakeNote {
  id: string;
  uuid: string | null;
  title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  attendees: { name: string | null; email: string }[];
  calendar: { start: string; end: string } | null;
  summary: string;
  private_notes: string | null;
  transcript: FakeLine[];
  attachments: { id: string; bytes: Buffer }[];
  summarised: boolean;
}

export function fakeGranola(account: string, key: string) {
  const notes = new Map<string, FakeNote>();
  const requests: { at: number; url: string }[] = [];
  const refreshes: string[] = [];
  let serial = 0;
  let signs = 0;
  const world = {
    clock: Date.UTC(2026, 9, 27, 9, 0, 0),
    notes,
    requests,
    refreshes,
    limitAfter: Number.POSITIVE_INFINITY,
    revoked: false,
    tooLarge: new Set<string>(),
    refusedCursors: new Set<string>(),
    onList: undefined as ((page: number, url: URL) => void) | undefined,
    listPages: 0,
    plan: "free" as "free" | "business",
    mcpPage: 100,
    sse: false,
    moved: new Set<string>(),
    failing: new Set<string>(),
    listShape: "granola" as "granola" | "bare",
    unreadable: new Set<string>(),
    mcpAccount: account,
    access: new Map<string, number>(),
    refresh: "refresh-synthetic-0",
    toolCalls: [] as { name: string; arguments: JsonObject }[],

    now: () => world.clock,
    sleep: async (ms: number) => {
      world.clock += ms;
    },
    note(fields: Partial<FakeNote> & { title: string }): FakeNote {
      const at = new Date(world.clock).toISOString();
      const n = ++serial;
      const note: FakeNote = {
        id: `not_${String(n).padStart(14, "0")}`, uuid: `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-${String(n).padStart(12, "0")}`, created_at: at, updated_at: at, deleted_at: null,
        attendees: [{ name: "Person A", email: account }, { name: "Person B", email: "person-b@example.com" }], calendar: null, summary: `### Synthetic summary ${n}\n- a point`, private_notes: null,
        transcript: [], attachments: [], summarised: true, ...fields,
      };
      notes.set(note.id, note);
      return note;
    },
    edit(note: FakeNote, change: Partial<FakeNote> = {}) {
      Object.assign(note, change, { updated_at: new Date(world.clock).toISOString() });
    },
    tick(ms = 60_000) {
      world.clock += ms;
    },
    signin(expires_ms: number): string {
      const access = `access-synthetic-${++signs}`;
      world.access.set(access, expires_ms);
      world.refresh = `refresh-synthetic-${signs}`;
      return JSON.stringify({ client_id: "client-synthetic-1", refresh_token: world.refresh, access_token: access, expires_ms });
    },
    fetch: (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      requests.push({ at: world.clock, url: url.href });
      if (url.origin === API) return api(url, new Headers(init?.headers));
      if (url.origin === FILES) return attachment(url);
      if (url.href === MCP) return mcp(new Headers(init?.headers), JSON.parse(String(init?.body)) as JsonObject);
      if (url.origin === AUTH) return auth(url, String(init?.body ?? ""));
      throw new Error(`the fake was asked for ${url.origin}`);
    }) as typeof globalThis.fetch,
  };

  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const order = (a: FakeNote, b: FakeNote) => (a.created_at > b.created_at ? -1 : a.created_at < b.created_at ? 1 : a.id < b.id ? -1 : 1);
  const ms = (iso: string) => Date.parse(iso);

  function noteJson(note: FakeNote, transcript: boolean): JsonObject {
    return {
      id: note.id, object: "note", title: note.title, owner: { name: "Person A", email: account }, created_at: note.created_at, updated_at: note.updated_at, deleted_at: note.deleted_at,
      web_url: note.uuid === null ? `https://notes.granola.ai/t/${note.id}` : `https://notes.granola.ai/d/${note.uuid}`,
      calendar_event: note.calendar === null ? null : {
        event_title: note.title, invitees: note.attendees.map((each) => ({ email: each.email })), organiser: account, calendar_event_id: `event-${note.id}`,
        scheduled_start_time: note.calendar.start, scheduled_end_time: note.calendar.end,
      },
      attachments: note.attachments.map((each) => ({ id: each.id, object: "attachment", type: "image", url: `${FILES}/${note.id}/${each.id}?signature=${++serial}`, width: 640, height: 480 })),
      attendees: note.attendees, folder_membership: [], space_membership: [],
      summary_text: note.summary.replace(/[#-]\s?/gu, ""), summary_markdown: note.summary,
      private_notes_text: note.private_notes, private_notes_markdown: note.private_notes,
      ...(transcript ? { transcript: note.transcript as unknown as JsonObject[] } : {}),
    };
  }

  function api(url: URL, headers: Headers): Response {
    if (headers.get("authorization") !== `Bearer ${key}` || world.revoked) return json({ message: "Unauthorized" }, 401);
    if (requests.filter((each) => each.url.startsWith(API)).length > world.limitAfter) return json({ message: "Too many requests" }, 429);
    const path = url.pathname;
    if (path === "/v1/notes") {
      const cursor = url.searchParams.get("cursor");
      if (cursor !== null && world.refusedCursors.delete(cursor)) return json({ message: "Invalid cursor" }, 400);
      const size = Math.min(Number(url.searchParams.get("page_size") ?? "10"), 30);
      const updated = url.searchParams.get("updated_after");
      const after = url.searchParams.get("created_after");
      const before = url.searchParams.get("created_before");
      const listed = [...notes.values()].filter((note) => note.deleted_at === null)
        .filter((note) => (updated === null || ms(note.updated_at) > ms(updated)) && (after === null || ms(note.created_at) > ms(after)) && (before === null || ms(note.created_at) < ms(before)))
        .sort(order);
      const last = cursor === null ? undefined : (JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { c: string; i: string });
      const rest = last === undefined ? listed : listed.filter((note) => note.created_at < last.c || (note.created_at === last.c && note.id > last.i));
      const page = rest.slice(0, size);
      const more = rest.length > size;
      world.listPages++;
      world.onList?.(world.listPages, url);
      const tail = page.at(-1);
      return json({
        notes: page.map((note) => ({ id: note.id, object: "note", title: note.title, owner: { name: "Person A", email: account }, created_at: note.created_at, updated_at: note.updated_at })),
        hasMore: more, cursor: more && tail !== undefined ? Buffer.from(JSON.stringify({ c: tail.created_at, i: tail.id })).toString("base64url") : null,
      });
    }
    const one = /^\/v1\/notes\/([\w-]+)(\/transcript)?$/u.exec(path);
    const note = one === null ? undefined : notes.get(one[1]!);
    if (note === undefined || !note.summarised) return json({ message: "Not found" }, 404);
    if (one![2] !== undefined) {
      const size = Number(url.searchParams.get("page_size") ?? "100");
      const from = Number(url.searchParams.get("cursor") ?? "0");
      const lines = note.transcript.slice(from, from + size);
      const more = from + size < note.transcript.length;
      return json({ transcript: lines, hasMore: more, cursor: more ? String(from + size) : null });
    }
    const inline = url.searchParams.get("include") === "transcript";
    if (inline && world.tooLarge.has(note.id)) return json({ message: "Payload too large" }, 413);
    return json(noteJson(note, inline));
  }

  function attachment(url: URL): Response {
    const [, id, name] = url.pathname.split("/");
    const bytes = notes.get(id!)?.attachments.find((each) => each.id === name)?.bytes;
    return bytes === undefined ? new Response("missing", { status: 404 }) : new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });
  }

  const LIST_ARGUMENTS = new Set(["cursor", "custom_end", "custom_start", "end_date", "folder_id", "from_date", "involvement", "limit", "max_participants", "start_date", "time_range", "to_date", "updated_after", "workspace_only"]);
  const escape = (text: string) => text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
  const meetingAt = (note: FakeNote) => note.calendar?.start ?? note.created_at;

  function meetingElement(note: FakeNote, detail: boolean, stamped = detail): string {
    const people = note.attendees.map((each, index) => `${each.name ?? each.email}${index === 0 ? " (note creator)" : ""} (${each.email})`).join(", ");
    const at = world.moved.has(note.uuid ?? "") ? `meeting_time="${meetingAt(note)}"` : `meeting_at="${meetingAt(note)}"`;
    const id = !detail && world.unreadable.has(note.uuid ?? "") ? "" : `id="${note.uuid}" `;
    const updated = world.listShape === "bare" ? "" : ` updated_at="${note.updated_at}"`;
    const times = detail ? ` created_at="${note.created_at}"${updated}` : stamped ? updated : "";
    const attributes = `${id}title="${escape(note.title)}" date="${new Date(meetingAt(note)).toUTCString()}" ${at}${times} captured_by_me="true" listed_as_participant="true" is_workspace_visible="false" url="https://notes.granola.ai/d/${note.uuid}"`;
    const inner = `<known_participants>${escape(people)}</known_participants>${detail ? `${note.private_notes === null ? '<private_notes status="empty" />' : `<private_notes>${escape(note.private_notes)}</private_notes>`}<summary>${escape(note.summary)}</summary>` : ""}`;
    return `<meeting ${attributes}>${inner}</meeting>`;
  }

  function mcp(headers: Headers, message: JsonObject): Response {
    const token = (headers.get("authorization") ?? "").replace(/^Bearer /u, "");
    const expires = world.access.get(token);
    if (expires === undefined || expires <= world.clock) return json({ error: "invalid_token" }, 401);
    if (message.method === "notifications/initialized") return new Response(null, { status: 202 });
    const answer = (result: JsonObject, extra: Record<string, string> = {}) => {
      const body = { jsonrpc: "2.0", id: message.id, result };
      if (world.sse) return new Response(`event: message\ndata: ${JSON.stringify(body)}\n\n`, { status: 200, headers: { "content-type": "text/event-stream", ...extra } });
      return json(body, 200, extra);
    };
    if (message.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "granola-synthetic", version: "1" } }, { "mcp-session-id": "session-synthetic-1" });
    if (headers.get("mcp-session-id") !== "session-synthetic-1") return json({ error: "no session" }, 400);
    const params = message.params as { name: string; arguments: JsonObject };
    world.toolCalls.push({ name: params.name, arguments: params.arguments });
    const text = (body: string, isError = false) => answer({ content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });
    const meetings = [...notes.values()].filter((note) => note.deleted_at === null && note.uuid !== null);
    switch (params.name) {
      case "get_account_info":
        return text(`<account_info><email>${world.mcpAccount}</email><mcp_plan>${world.plan}</mcp_plan></account_info>`);
      case "list_meetings": {
        const args = params.arguments;
        if (Object.keys(args).some((name) => !LIST_ARGUMENTS.has(name))) return text("Invalid arguments for tool list_meetings.", true);
        const updatedAfter = typeof args.updated_after === "string" ? ms(args.updated_after) : null;
        const stamped = updatedAfter !== null && world.listShape === "granola";
        const cursor = typeof args.cursor === "string" ? args.cursor : null;
        if (cursor !== null && world.refusedCursors.delete(cursor)) return text("The cursor is invalid or expired.", true);
        const floor = world.plan === "free" ? world.clock - 30 * DAY : Number.NEGATIVE_INFINITY;
        const from = Math.max(ms(String(args.from_date)), floor);
        const to = ms(String(args.to_date));
        const listed = meetings.filter((note) => ms(meetingAt(note)) >= from && ms(meetingAt(note)) < to && (updatedAfter === null || ms(note.updated_at) > updatedAfter)).sort((a, b) => (meetingAt(a) > meetingAt(b) ? -1 : meetingAt(a) < meetingAt(b) ? 1 : 0));
        const offset = cursor === null ? 0 : Number(cursor.slice(1));
        const page = listed.slice(offset, offset + world.mcpPage);
        const more = offset + world.mcpPage < listed.length;
        const notice = ms(String(args.from_date)) < floor ? "<access_notice>Your plan includes meetings from the last 30 days.</access_notice>\n" : "";
        return text(`<requested_range start="${String(args.from_date)}" end="${String(args.to_date)}" />\n${notice}<meetings_data count="${page.length}">${page.map((note) => meetingElement(note, false, stamped)).join("")}</meetings_data>\n<pagination has_more="${more}" total_count="${listed.length}" remaining_count="${Math.max(0, listed.length - offset - page.length)}"${more ? ` next_cursor="m${offset + world.mcpPage}"` : ""} />\nUse get_meetings to read a meeting's summary.`);
      }
      case "get_meetings": {
        const ids = params.arguments.meeting_ids as string[];
        if (ids.length > 10) return text("At most 10 meetings at a time.", true);
        const failed = ids.filter((id) => world.failing.delete(id));
        if (failed.length > 0) return text("Something went wrong reading these meetings.", true);
        const found = ids.map((id) => meetings.find((note) => note.uuid === id)).filter((note) => note !== undefined);
        return text(`Answer the user from these meetings only.\n<meetings_data count="${found.length}">${found.map((note) => meetingElement(note, true)).join("")}</meetings_data>`);
      }
      default:
        return text(`Upgrade to a paid plan to use ${params.name}.`, true);
    }
  }

  function auth(url: URL, body: string): Response {
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({ issuer: AUTH, token_endpoint: `${AUTH}/oauth/token`, registration_endpoint: `${AUTH}/oauth/register`, device_authorization_endpoint: `${AUTH}/oauth/device_authorization` });
    }
    if (url.pathname === "/oauth/token") {
      const form = new URLSearchParams(body);
      refreshes.push(form.get("refresh_token") ?? "");
      if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== world.refresh) return json({ error: "invalid_grant" }, 400);
      const access = `access-synthetic-${++signs}`;
      world.access.set(access, world.clock + 6 * 3_600_000);
      world.refresh = `refresh-synthetic-${signs}`;
      return json({ access_token: access, refresh_token: world.refresh, token_type: "Bearer", expires_in: 21600 });
    }
    return json({ error: "not_found" }, 404);
  }

  return world;
}

export type FakeGranola = ReturnType<typeof fakeGranola>;
