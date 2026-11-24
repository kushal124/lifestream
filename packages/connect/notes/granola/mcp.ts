import { createHash } from "node:crypto";
import { afterStop, answered, attempt, credentialText, feeds, movedEarlier, NeedsYou, oauthCredential, oauthFresh, oauthRefresher, Refused, request, rfc3339, Stopped, textHead, utf8, type Acquirer, type Budget, type FetchedFile, type Json, type JsonObject, type Memory, type OAuthIssuer, type Refresher, type Secrets, type SignedIn, type Stop } from "@lifestreamprotocol/connect/sdk";
import { attributesOf, holdsMeetings, MCP_FORMAT, meetingSources, PULL_MANIFEST, readMeeting, rpcAnswer, textsOf, toolText, type Media } from "./answers.js";

function refuse(message: string): never {
  throw new Refused(`granola-mcp: ${message}`);
}

const PROTOCOL = "2025-06-18";
const PER_POLL = 40;
const BATCH = 10;
const WINDOW_MS = 30 * 86_400_000;
const EMAIL = /^[^\s@]+@[^\s@]+$/u;
const EVER = "1970-01-01T00:00:00Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const TOOL_ARGUMENTS = {
  list: (listing: Listing): JsonObject => ({ from_date: listing.from, to_date: listing.to, updated_after: EVER, ...(listing.cursor === null ? {} : { cursor: listing.cursor }) }),
  get: (ids: readonly string[]): JsonObject => ({ meeting_ids: [...ids] }),
};

export interface GranolaMcpSettings {
  account: string;
  signin: string;
  per_poll?: number;
}

export interface GranolaMcpDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

interface Listing {
  from: string;
  to: string;
  cursor: string | null;
  unread: number;
  window: boolean;
}

export interface GranolaMcpState {
  reached?: true;
  listing?: Listing;
  queue_next?: number;
}

export interface Queued extends JsonObject {
  id: string;
  updated_at: string | null;
}

export const SEEN = "seen";
export const QUEUE = "queue";
export const QUEUED = "queued";
export const LISTED = "listed";

export function granolaMcpAcquirer(settings: GranolaMcpSettings, issuer: OAuthIssuer, dependencies: GranolaMcpDependencies = {}): Acquirer {
  const now = dependencies.now ?? Date.now;
  const source = `granola:${settings.account}:cloud`;
  const server = serverOf(issuer);
  const refresher = oauthRefresher(issuer);
  return {
    name: "granola-mcp",
    source,
    async fetch(state, secrets, lent) {
      if (typeof settings.account !== "string" || !EMAIL.test(settings.account)) refuse("account must be the Granola account's email");
      const perPoll = settings.per_poll ?? PER_POLL;
      if (!Number.isSafeInteger(perPoll) || perPoll < 2) refuse("per_poll must be a whole number, 2 or more");
      const at = now();
      const previous = state as unknown as GranolaMcpState | null;
      const next: GranolaMcpState = structuredClone(previous ?? {});
      const memory = lent.memory;
      if (lent.from_ms !== undefined && lent.start_ms !== lent.from_ms) {
        delete next.listing;
        memory.clear(LISTED);
        if (movedEarlier(lent) !== null) delete next.reached;
      }
      const session = new McpSession(dependencies, server, { refresher, secrets, secret: settings.signin }, { left: perPoll });
      const notices: string[] = [];
      const skipped: string[] = [];
      let read = 0;
      let unread = 0;
      let listedThisCall = false;
      let stopped: Stop | undefined;
      const failed = new Map<string, readonly [place: string, meeting: Queued]>();
      const enqueue = (meeting: Queued) => {
        const place = placeOf(next.queue_next ?? 0);
        next.queue_next = (next.queue_next ?? 0) + 1;
        memory.put(QUEUE, place, meeting);
        memory.put(QUEUED, meeting.id, place);
      };
      try {
        for (;;) {
          for (let batch = queued(memory); batch.length > 0; batch = queued(memory)) {
            const answer = await session.tool("get_meetings", TOOL_ARGUMENTS.get(batch.map(([, { id }]) => id)));
            for (const [place, { id }] of batch) {
              memory.drop(QUEUE, place);
              memory.drop(QUEUED, id);
            }
            if (answer.error) {
              skipped.push(...batch.map(([, { id }]) => id));
              for (const [place, meeting] of batch) failed.set(meeting.id, [place, meeting]);
            } else {
              const answered = answeredUpdates(answer.text);
              for (const [, { id, updated_at: listed }] of batch) {
                if (!answered.has(id)) continue;
                read++;
                const updated = listed ?? answered.get(id);
                if (updated === null || updated === undefined) memory.drop(SEEN, id);
                else memory.put(SEEN, id, updated);
              }
            }
          }
          if (next.listing === undefined) {
            if (listedThisCall) break;
            next.listing = startListing(next, lent.start_ms, at);
          }
          const listing = next.listing;
          const answer = await session.tool("list_meetings", TOOL_ARGUMENTS.list(listing));
          if (answer.error) {
            if (listing.cursor === null) refuse(`list_meetings answered an error: ${clip(answer.text)}`);
            listing.cursor = null;
            continue;
          }
          if (!holdsMeetings(answer.text)) refuse("list_meetings answered no meetings_data: its shape has moved");
          notices.push(...textsOf(answer.text, "access_notice"));
          for (const [index, element] of meetingSources(answer.text).entries()) {
            const meeting = attempt(() => readMeeting(element, `list_meetings meeting ${index}`).attributes);
            const attributes = meeting instanceof Refused ? undefined : meeting;
            const id = attributes?.id !== undefined && UUID.test(attributes.id) ? attributes.id : undefined;
            if (attributes === undefined || id === undefined) {
              unread++;
              listing.unread++;
              continue;
            }
            const updated = attributes.updated_at ?? null;
            memory.put(LISTED, id, true);
            if ((updated === null || memory.get(SEEN, id) !== updated) && memory.get(QUEUED, id) === undefined && !failed.has(id)) enqueue({ id, updated_at: updated });
          }
          const pagination = attributesOf(answer.text, "pagination");
          if (pagination?.has_more === "true") {
            listing.cursor = pagination.next_cursor ?? refuse("list_meetings has more and states no next_cursor");
            continue;
          }
          if (memory.list(LISTED, undefined, 1).length === 0 && listing.unread > 0) refuse(`list_meetings answered ${listing.unread} meetings and none reads: its shape has moved`);
          if (listing.window) for (const [id] of every(memory, SEEN)) if (memory.get(LISTED, id) === undefined) memory.drop(SEEN, id);
          memory.clear(LISTED);
          next.reached = true;
          delete next.listing;
          listedThisCall = true;
        }
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        stopped = error.stop;
      }
      for (const [id, [place, meeting]] of failed) {
        memory.put(QUEUE, place, meeting);
        memory.put(QUEUED, id, place);
      }
      if (memory.list(QUEUE, undefined, 1).length === 0) delete next.queue_next;
      const after = afterStop(stopped, read > 0, next as unknown as JsonObject, "Granola");
      const fetchedAt = rfc3339(at);
      const stop = stopped === undefined ? {} : { stopped: stopped.stop === "limit" ? "rate-limit" : stopped.stop };
      const manifest = { format: MCP_FORMAT, complete: true, account: settings.account, fetched_at: fetchedAt, calls: session.calls, ...stop, answers: session.answers };
      const said = [...new Set(notices)];
      return {
        files: read === 0 ? [] : [...session.files, { path: PULL_MANIFEST, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) }],
        facts: {
          fetched_at: fetchedAt, account: settings.account, meetings: read, calls: session.calls, ...stop,
          ...(said.length === 0 ? {} : { notices: said }), ...(skipped.length === 0 ? {} : { skipped }), ...(unread === 0 ? {} : { unread }),
          ...feeds(source, "granola-mcp"),
        },
        state: next as unknown as JsonObject,
        ...after,
      };
    },
  };
}

function startListing(state: GranolaMcpState, floor: number | null, at: number): Listing {
  const to = rfc3339(at + 86_400_000);
  if (state.reached === true) return { from: rfc3339(Math.max(at - WINDOW_MS, floor ?? 0)), to, cursor: null, unread: 0, window: true };
  return { from: rfc3339(floor ?? 0), to, cursor: null, unread: 0, window: false };
}

function queued(memory: Memory): (readonly [place: string, meeting: Queued])[] {
  return memory.list(QUEUE, undefined, BATCH) as unknown as (readonly [string, Queued])[];
}

export function placeOf(n: number): string {
  return String(n).padStart(16, "0");
}

function* every(memory: Memory, part: string): Generator<readonly [string, Json]> {
  for (let page = memory.list(part); page.length > 0; page = memory.list(part, page.at(-1)![0])) yield* page;
}

function answeredUpdates(text: string): Map<string, string | null> {
  const answered = new Map<string, string | null>();
  for (const [index, element] of meetingSources(text).entries()) {
    const meeting = attempt(() => readMeeting(element, `get_meetings meeting ${index}`).attributes);
    if (!(meeting instanceof Refused) && meeting.id !== undefined) answered.set(meeting.id, meeting.updated_at ?? null);
  }
  return answered;
}

interface ToolAnswer {
  error: boolean;
  text: string;
}

export interface ManifestAnswer {
  file: string;
  sha256: string;
  bytes: number;
  media: Media;
  rpc: number;
  tool: string;
  arguments: JsonObject;
}

type Auth = { refresher: Refresher; secrets: Secrets; secret: string } | { token: string; signal: AbortSignal };

class McpSession {
  readonly files: FetchedFile[] = [];
  readonly answers: ManifestAnswer[] = [];
  calls = 0;
  #id = 0;
  #session: string | undefined;
  #opened = false;
  readonly dependencies: GranolaMcpDependencies;
  readonly server: string;
  readonly auth: Auth;
  readonly budget: Budget;

  constructor(dependencies: GranolaMcpDependencies, server: string, auth: Auth, budget: Budget) {
    this.dependencies = dependencies;
    this.server = server;
    this.auth = auth;
    this.budget = budget;
  }

  async tool(name: string, args: JsonObject): Promise<ToolAnswer> {
    if (this.budget.left <= 0) throw new Stopped({ stop: "budget" });
    if (!this.#opened) await this.#open();
    this.calls++;
    const id = ++this.#id;
    const what = `tools/call ${name}`;
    const { bytes, media } = await this.#post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, what, this.budget);
    const file = `answer-${String(this.answers.length + 1).padStart(5, "0")}.${media === "json" ? "json" : "sse"}`;
    const answer = toolText(rpcOf(bytes, media, id, what), file);
    this.files.push({ path: file, bytes });
    this.answers.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, media, rpc: id, tool: name, arguments: args });
    return answer;
  }

  async #open(): Promise<void> {
    const id = ++this.#id;
    const opened = await this.#post({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "lifestream-home", version: "1" } } }, "initialize", { left: 1 });
    const answer = rpcOf(opened.bytes, opened.media, id, "initialize");
    if (answer.result === undefined) refuse("initialize answered no result");
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" }, "notifications/initialized", { left: 1 });
    this.#opened = true;
  }

  async #post(message: JsonObject, what: string, budget: Budget): Promise<{ bytes: Buffer; media: Media }> {
    const headers = {
      "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "lifestream-home",
      ...(this.#session === undefined ? {} : { "mcp-session-id": this.#session }), ...(this.#opened ? { "mcp-protocol-version": PROTOCOL } : {}),
      ...("token" in this.auth ? { authorization: `Bearer ${this.auth.token}` } : {}),
    };
    const init = { method: "POST", headers, body: JSON.stringify(message) };
    const response = answered(await request(this.server, init, "token" in this.auth ? { budget, signal: this.auth.signal, ...this.dependencies } : { budget, ...this.auth, ...this.dependencies }));
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) refuse(`${what} answered HTTP ${response.status}`);
    this.#session = response.headers.get("mcp-session-id") ?? this.#session;
    const type = response.headers.get("content-type") ?? "";
    return { bytes, media: type.startsWith("text/event-stream") ? "sse" : "json" };
  }
}

function rpcOf(bytes: Buffer, media: Media, id: number, what: string): JsonObject {
  const read = attempt(() => rpcAnswer(utf8(bytes, what), media, id, what));
  return read instanceof Refused ? refuse(`Granola's answer to ${what} does not read`) : read;
}

function clip(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 200 ? `${textHead(line, 200)}…` : line;
}

export function granolaMcpSignedIn(issuer: OAuthIssuer, dependencies: GranolaMcpDependencies = {}): SignedIn {
  const server = serverOf(issuer);
  const refresher = oauthRefresher(issuer);
  return async (values) => {
    const credential = await oauthFresh(oauthCredential(values.credential, "the sign-in"), refresher, { ...dependencies, signal: values.signal });
    const session = new McpSession(dependencies, server, { token: credential.access_token, signal: values.signal }, { left: 1 });
    const answer = await session.tool("get_account_info", {}).catch((error: unknown) => {
      if (!(error instanceof Stopped)) throw error;
      throw error.stop.stop === "signed-out" ? new NeedsYou("signed-out", "Granola no longer accepts this sign-in") : new Refused("granola-mcp: Granola asked to slow down; try again in a few seconds");
    });
    if (answer.error) refuse("Granola would not say whose account this is");
    const account = accountOf(answer.text) ?? refuse("get_account_info states no email");
    return { account, credential: credentialText(credential) };
  };
}

function serverOf(issuer: OAuthIssuer): string {
  return issuer.resource ?? refuse("its route declares no resource: the MCP server the token is for");
}

export function accountOf(text: string): string | undefined {
  const stated = attributesOf(text, "account")?.email ?? textsOf(text, "email")[0] ?? /"email"\s*:\s*"([^"]+)"/u.exec(text)?.[1];
  return stated !== undefined && EMAIL.test(stated.trim()) ? stated.trim() : undefined;
}
