import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isObject, writeDurably, type GrowingFile, type GrowingKind, type HomeFolder, type Json, type JsonObject, type Tx } from "@lifestreamprotocol/core";
import type { AccessBy, AccessLog, PlaceholderTables } from "@lifestreamprotocol/model";
import { AccessError, parseAccess, type Access } from "@lifestreamprotocol/privacy";
import { defaultAccess, reachesOf, type Existing } from "./access.js";
import { ADDRESS_NOT_READY, AGENT_GONE, ANYWHERE_KEY_ONLY, signInOver, signInSays } from "./access-words.js";
import { appOfHost, KEY_APPS, nameOf, signInFrom, type KeyApp } from "./agent-guides.js";
import { noteReach, publicOff, publicOn, publicOrigin, publicStatus, type PublicState } from "./funnel.js";
import { errorText } from "./job-error.js";
import { rememberRevoked } from "./lifecycle.js";
import type { Machine } from "./machine.js";
import { AGENT_UNIT, grantTable, hashToken, mintPrincipal, passOf, readFromAnywhere, readPrincipals, revokePrincipal, writePrincipals, type AgentGrant, type GrantApp, type Principal } from "./principals.js";
import { refuse } from "./refusal.js";


export const REQUEST_MS = 10 * 60_000;
export const EXCHANGE_MS = 90_000;
export const WAITING_MOST = 16;
export const ACCESS_S = 3_600;
export const NOTE_CATEGORIES = ["missing", "wrong", "confusing", "slow", "error", "other"] as const;
export const NOTE_MOST = 2_000;
export const NOTE_TOOL_MOST = 64;
export const NOTES_A_DAY = 500;
const DAY_MS = 24 * 60 * 60_000;
const CARD_MOST = 200;
const REFRESH = /^([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/u;

export interface Card {
  readonly name: string;
  readonly checked: boolean;
  readonly host: string | null;
}

export type RequestState = "waiting" | "approved" | "denied" | "wrong" | "gone";

export interface SignInAnswer {
  readonly state: "approved" | "denied" | "wrong";
  readonly name: string;
  readonly at_ms: number;
  readonly device: string | null;
}

export interface SignInGranted {
  readonly reader: string;
  readonly access: Access;
}

export interface SignInHeld {
  readonly answered: SignInAnswer | null;
  readonly granted: SignInGranted | null;
}

export interface SignInAnswered extends SignInAnswer {
  readonly granted: SignInGranted | null;
}

export interface SignInRequested {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly line: string;
}

export interface Waiting extends Card {
  readonly id: string;
  readonly choices: number[];
  readonly at_ms: number;
  readonly until_ms: number;
}

export interface Tokens {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_in: number;
}

export interface Granted extends Tokens {
  readonly grant: string;
}

export interface Asked {
  readonly client_id: string;
  readonly resource: string;
}

export interface Listed {
  readonly id: string;
  readonly name: string;
  readonly via: AgentGrant["via"];
  readonly from: string | null;
  readonly checked: boolean;
  readonly anywhere: boolean;
  readonly minted_at: string;
}

export interface MintedKey {
  readonly reader: string;
  readonly name: string;
  readonly pass: string;
  readonly origin: string | null;
}

export interface Note {
  readonly at: string;
  readonly pass: string;
  readonly who: string;
  readonly category: (typeof NOTE_CATEGORIES)[number];
  readonly tool: string | null;
  readonly message: string;
}

interface Request extends Card {
  readonly id: string;
  readonly number: number;
  readonly choices: number[];
  readonly at_ms: number;
  answered: SignInAnswer | null;
  access: Access | null;
  granted: string | null;
  revoked: boolean;
}

export interface AgentsOptions {
  readonly folder: HomeFolder;
  readonly machine: Machine;
  readonly commit: <T>(work: (tx: Tx) => T) => T;
  readonly tables: Pick<PlaceholderTables, "drop">;
  readonly access: Pick<AccessLog, "get" | "change" | "remove">;
  readonly existing: () => readonly Existing[];
  readonly now: () => number;
  readonly random?: (bytes: number) => Buffer;
  readonly log?: (line: JsonObject) => void;
}

export const AGENT_NOTES: GrowingKind = { role: "agent-notes", grows: true };

export const DISCONNECTED_REFRESH = `${AGENT_GONE} Sign in again.`;
export const AGENT_CALLS = ["request", "state", "grant", "refresh", "revoke", "waiting", "signin", "answer", "feedback", "disconnect", "address", "key"] as const;
export type AgentCall = (typeof AGENT_CALLS)[number];

export class Agents {
  readonly #requests = new Map<string, Request>();
  readonly #principals: HomeFolder;
  readonly #notes: GrowingFile;
  readonly #random: (bytes: number) => Buffer;

  constructor(readonly options: AgentsOptions) {
    this.#principals = options.folder;
    this.#notes = options.folder.file(AGENT_NOTES, join(options.folder.root, "agents", "feedback.jsonl"));
    this.#random = options.random ?? randomBytes;
  }

  call(call: unknown, body: unknown, pass?: unknown): object | Promise<object> {
    const said = isObject(body) ? body : {};
    if (call === "feedback") {
      if (typeof pass !== "string" || pass === "") throw new TypeError("a note names the pass the door took it from");
      return this.#feedback(pass, said);
    }
    if (call === "request") return this.#request(said);
    if (call === "state") return this.#state(said.id);
    if (call === "grant") return this.#grant(said.id, said);
    if (call === "refresh") return this.#refresh(said.refresh_token, said);
    if (call === "revoke") return this.#revokeSignIn(said);
    if (call === "waiting") return this.waiting();
    if (call === "signin") return this.signIn(said.id);
    if (call === "answer") return this.answer(said.id, said.answer, said.access, said.device);
    if (call === "disconnect") return this.disconnect(said.id, typeof said.device === "string" ? said.device : null);
    if (call === "address") return this.address(said.on, said.reader);
    if (call === "key") return this.#key(said);
    throw new TypeError(`agent calls ${AGENT_CALLS.join(", ")}`);
  }

  waiting(): { requests: Waiting[] } {
    this.#prune();
    return {
      requests: [...this.#requests.values()].filter((request) => request.answered === null).sort((a, b) => a.at_ms - b.at_ms)
        .map(({ id, name, checked, host, choices, at_ms }) => ({ id, name, checked, host, choices: [...choices], at_ms, until_ms: at_ms + REQUEST_MS })),
    };
  }

  signIn(id: unknown): SignInHeld {
    this.#prune();
    const request = typeof id === "string" ? this.#requests.get(id) : undefined;
    if (request === undefined || this.#ended(request)) refuse(404, "AGENT_REQUEST_GONE", signInOver(null));
    return { answered: request.answered, granted: grantedOf(request) };
  }

  answer(id: unknown, pick: unknown, access?: unknown, device?: unknown): SignInAnswered {
    if (typeof id !== "string" || id === "" || !(pick === "deny" || (Number.isInteger(pick) && (pick as number) >= 10 && (pick as number) <= 99))) {
      refuse(422, "BAD_REQUEST", "an answer names the request's id and the number tapped, from 10 to 99, or deny");
    }
    if (pick === "deny" && access !== undefined) refuse(422, "BAD_REQUEST", "a denied sign-in carries no access");
    if (device !== undefined && device !== null && (typeof device !== "string" || device === "")) refuse(422, "BAD_REQUEST", "an answer's device is the pass that answered it");
    const chosen = access === undefined ? null : accessOf(access);
    this.#prune();
    const request = this.#requests.get(id);
    if (request === undefined) refuse(404, "AGENT_REQUEST_GONE", signInOver(null));
    if (request.answered === null) {
      const state = pick === "deny" ? "denied" : pick === request.number ? "approved" : "wrong";
      request.answered = { state, name: request.name, at_ms: this.options.now(), device: typeof device === "string" ? device : null };
      if (state === "approved") request.access = chosen;
    }
    return { ...request.answered, granted: grantedOf(request) };
  }

  notes(): Note[] {
    return notesIn(this.#notes.read()?.toString("utf8") ?? "").reverse();
  }

  list(): Listed[] {
    return readPrincipals(this.#principals).principals.filter((row) => row.kind === "agent" && row.revoked_at === null && row.agent?.own !== true).map(listed);
  }

  add(name: string, door: string, anywhere: boolean, access: Access, app: GrantApp | null): Added {
    const { principal, token } = this.#copied(name, anywhere, { access, app, device: null });
    const current = join(this.options.machine.dir, "current");
    const desktop = {
      mcpServers: {
        lifestream: { command: join(current, "node"), args: [join(current, "mcp", "server.mjs"), "--stdio"], env: { LIFESTREAM_PASS: token, LIFESTREAM_DOOR: door, LIFESTREAM_MACHINE_DIR: this.options.machine.dir } },
      },
    };
    return {
      agent: listed(principal), url: MCP_URL, pass: token,
      claude_desktop: JSON.stringify(desktop, null, 2),
      claude_code: claudeCodeLine(MCP_URL),
    };
  }

  callPass(): { pass: string; agent: Listed } {
    const file = join(this.options.machine.dir, "agents-call", "door-token");
    const held = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
    const row = held === "" ? undefined : passOf(this.#principals, held);
    if (row !== undefined && row.kind === "agent" && row.agent?.own === true && row.revoked_at === null && row.suspended_at === null) return { pass: held, agent: listed(row) };
    const { principal, token } = this.#copied(CALL_AGENT, false, { access: defaultAccess(), app: null, device: null, own: true });
    mkdirSync(dirname(file), { recursive: true });
    writeDurably(file, `${token}\n`, 0o600);
    return { pass: token, agent: listed(principal) };
  }

  #copied(name: string, anywhere: boolean, made: { access: Access; app: GrantApp | null; device: string | null; own?: true }): { principal: Principal; token: string } {
    const named = cardOf({ name, checked: false, host: null }).name;
    const { access, app, device, own } = made;
    const now = this.options.now();
    return mintPrincipal(this.#principals, {
      unit: AGENT_UNIT, kind: "agent", scopes: ["read"], now_ms: now, first: (id) => this.#granted(id, access, now, device),
      granted: { agent: {
        name: named, via: "pass", from: null, checked: false, client_id: null, resource: null,
        ...(anywhere ? { anywhere: true as const } : {}), ...(own === true ? { own: true as const } : {}), ...(app === null ? {} : { app }),
      } },
    }, this.#random);
  }

  async address(on: unknown, reader?: unknown): Promise<PublicState> {
    if (on !== undefined && typeof on !== "boolean") refuse(422, "BAD_REQUEST", "an address is turned on or off: on is true or false");
    if (reader !== undefined && (on !== true || typeof reader !== "string")) refuse(422, "BAD_REQUEST", "a reader is named only to turn the address on for it");
    const { machine } = this.options;
    if (on === undefined) return publicStatus(machine);
    if (typeof reader === "string") this.#copiedPass(reader);
    const state = await (on ? publicOn : publicOff)(machine, (each) => this.#noted(each));
    if (typeof reader === "string" && state.state === "on") readFromAnywhere(this.#principals, this.#copiedPass(reader).id);
    return state;
  }

  settleAddress(): Promise<PublicState> | null {
    const { machine } = this.options;
    if (publicOrigin(machine) === null || this.#connecting() || this.list().some(fromInternet)) return null;
    this.options.log?.({ reach: "off", why: "no agent reads from the internet" });
    return publicOff(machine, (state) => this.#noted(state));
  }

  #connecting(): boolean {
    this.#prune();
    return [...this.#requests.values()].some((request) => request.answered === null || (request.answered.state === "approved" && request.granted === null && !this.#ended(request)));
  }

  #ended(request: Request): boolean {
    if (request.revoked) return true;
    const { answered } = request;
    return answered?.state === "approved" && request.granted === null && this.options.now() - answered.at_ms >= EXCHANGE_MS;
  }

  #settleSoon(): void {
    void this.settleAddress()?.catch((error: unknown) => this.options.log?.({ reach: "not turned off", error: errorText(error) }));
  }

  #noted(state: PublicState | null): void {
    const now = this.options.now();
    this.options.commit((tx) => noteReach(tx.tables.meta, state, now));
  }

  #copiedPass(id: string): Principal {
    const row = readPrincipals(this.#principals).principals.find((each) => each.id === id && each.kind === "agent" && each.revoked_at === null && each.agent?.own !== true);
    if (row === undefined) refuse(404, "AGENT_UNKNOWN", AGENT_GONE);
    if (row.agent?.via !== "pass") refuse(422, "BAD_REQUEST", ANYWHERE_KEY_ONLY);
    return row;
  }

  #key(said: Record<string, unknown>): MintedKey {
    const { app, name, access, device } = said;
    if (!(KEY_APPS as readonly unknown[]).includes(app)) refuse(422, "BAD_REQUEST", `a key is made for one of ${KEY_APPS.join(", ")}`);
    const keyed = app as KeyApp;
    if ((keyed === "another") !== (typeof name === "string")) refuse(422, "BAD_REQUEST", "another agent's key is named, and only its key");
    if (device !== null && (typeof device !== "string" || device === "")) refuse(422, "BAD_REQUEST", "a key's device is the pass that made it");
    const granted = accessOf(access);
    const origin = publicOrigin(this.options.machine);
    const guided = keyed === "another" ? null : keyed;
    if (guided !== null && origin === null) refuse(409, "ADDRESS_NOT_READY", ADDRESS_NOT_READY);
    const { principal, token } = this.#copied(guided === null ? name as string : nameOf(guided), guided !== null, { access: granted, app: guided, device: device as string | null });
    return { reader: principal.id, name: principal.agent!.name, pass: token, origin };
  }

  #granted(id: string, access: Access, now_ms: number, device: string | null): void {
    this.options.access.change(id, { from: 0, what: "granted", lines: access as unknown as Json, covers: reachesOf(access, this.options.existing(), now_ms) }, { at_ms: now_ms, by: "person", device });
  }

  disconnect(id: unknown, device: string | null = null): Listed {
    const row = readPrincipals(this.#principals).principals.find((each) => each.id === id && each.kind === "agent" && each.revoked_at === null);
    if (row === undefined) refuse(404, "AGENT_UNKNOWN", AGENT_GONE);
    this.#revoke(row, "person", device);
    return listed(row);
  }

  #request(card: unknown): SignInRequested {
    const { name: said, checked, host } = cardOf(card);
    const app = appOfHost(host);
    const name = app === null ? said : nameOf(app);
    this.#prune();
    const waiting = [...this.#requests.values()].filter((request) => request.answered === null);
    if (waiting.length >= WAITING_MOST) refuse(429, "AGENTS_WAITING", "Too many sign-ins are waiting. Answer them, or wait ten minutes.");
    const taken = new Set(waiting.map((request) => request.number));
    const free = Array.from({ length: 90 }, (_, index) => index + 10).filter((number) => !taken.has(number));
    const number = free[randomInt(free.length)]!;
    const others = Array.from({ length: 90 }, (_, index) => index + 10).filter((each) => each !== number);
    const choices = [number, ...[0, 1].map(() => others.splice(randomInt(others.length), 1)[0]!)];
    for (let at = choices.length - 1; at > 0; at -= 1) {
      const swap = randomInt(at + 1);
      [choices[at], choices[swap]] = [choices[swap]!, choices[at]!];
    }
    let id: string;
    do id = this.#random(16).toString("base64url"); while (this.#requests.has(id));
    this.#requests.set(id, { id, name, checked, host, number, choices, at_ms: this.options.now(), answered: null, access: null, granted: null, revoked: false });
    return { id, number, name, line: app === null || host === null ? signInSays(name, checked, host) : signInFrom(app, host) };
  }

  #state(id: unknown): { state: RequestState } {
    this.#prune();
    const request = typeof id === "string" ? this.#requests.get(id) : undefined;
    return { state: request === undefined || this.#ended(request) ? "gone" : request.answered?.state ?? "waiting" };
  }

  #grant(id: unknown, asked: unknown): Granted {
    const { client_id, resource } = askedOf(asked);
    this.#prune();
    const request = typeof id === "string" ? this.#requests.get(id) : undefined;
    if (request === undefined || request.answered?.state !== "approved" || this.#ended(request)) refuse(409, "AGENT_NOT_APPROVED", "This sign-in was not approved, or it ended.");
    if (request.granted !== null) {
      this.#revokeSignIn({ grant: request.granted });
      refuse(409, "AGENT_GRANTED", "This sign-in was granted already: that grant is revoked.");
    }
    const { device } = request.answered;
    const access = this.#random(32).toString("base64url");
    const family = this.#random(16).toString("base64url");
    const turn = this.#random(32).toString("base64url");
    const now = this.options.now();
    const { principal } = mintPrincipal(this.#principals, {
      unit: AGENT_UNIT, kind: "agent", scopes: ["read"], token: access, now_ms: now, first: (id) => this.#granted(id, request.access ?? defaultAccess(), now, device),
      granted: {
        agent: { name: request.name, via: "sign-in", from: request.host, checked: request.checked, client_id, resource, request: request.id },
        expires_at: new Date(now + ACCESS_S * 1_000).toISOString(), family_sha256: hashToken(family), refresh_sha256: hashToken(turn),
      },
    }, this.#random);
    request.granted = principal.id;
    return { grant: principal.id, access_token: access, refresh_token: `${family}.${turn}`, expires_in: ACCESS_S };
  }

  #refresh(token: unknown, asked: unknown): Tokens {
    const invalid = (): never => refuse(400, "INVALID_GRANT", "This refresh token is not good: sign in again.");
    const { client_id, resource } = askedOf(asked);
    const parts = typeof token === "string" ? REFRESH.exec(token) : null;
    if (parts === null) return invalid();
    const family = createHash("sha256").update(parts[1]!).digest();
    const file = readPrincipals(this.#principals);
    let row: Principal | undefined;
    for (const each of file.principals) {
      if (each.family_sha256 !== undefined && timingSafeEqual(Buffer.from(each.family_sha256, "hex"), family)) row = each;
    }
    if (row !== undefined && row.revoked_at !== null) refuse(400, "INVALID_GRANT", DISCONNECTED_REFRESH);
    if (row === undefined || row.suspended_at !== null) return invalid();
    if (!timingSafeEqual(Buffer.from(row.refresh_sha256!, "hex"), createHash("sha256").update(parts[2]!).digest())) {
      this.#revoke(row, "home");
      return invalid();
    }
    if (row.agent?.client_id !== client_id || row.agent.resource !== resource) return invalid();
    const access = this.#random(32).toString("base64url");
    const turn = this.#random(32).toString("base64url");
    const renewed: Principal = {
      ...row, token_sha256: hashToken(access), refresh_sha256: hashToken(turn), expires_at: new Date(this.options.now() + ACCESS_S * 1_000).toISOString(),
    };
    writePrincipals(this.#principals, { ...file, principals: file.principals.map((each) => each.id === row!.id ? renewed : each) });
    return { access_token: access, refresh_token: `${parts[1]}.${turn}`, expires_in: ACCESS_S };
  }

  #revokeSignIn(by: { grant?: unknown; request?: unknown }): Record<string, never> {
    const { grant, request } = by;
    const named = (row: Principal) => typeof grant === "string" ? row.id === grant : typeof request === "string" && row.agent?.request === request;
    const row = typeof grant === "string" || typeof request === "string" ? readPrincipals(this.#principals).principals.find(named) : undefined;
    if (row?.kind === "agent" && row.agent?.via === "sign-in" && row.revoked_at === null) this.#revoke(row, "home");
    const held = typeof grant !== "string" && typeof request === "string" ? this.#requests.get(request) : undefined;
    if (held !== undefined) held.revoked = true;
    return {};
  }

  #feedback(pass: string, said: Record<string, unknown>): { outcome: "saved" | "full" } {
    const { category, message, tool } = said;
    if (typeof category !== "string" || !(NOTE_CATEGORIES as readonly string[]).includes(category)) refuse(422, "BAD_REQUEST", `a note's category is one of ${NOTE_CATEGORIES.join(", ")}`);
    if (typeof message !== "string" || message.trim() === "" || message.length > NOTE_MOST) refuse(422, "BAD_REQUEST", `a note's message is 1 to ${NOTE_MOST} characters`);
    if (!(tool === undefined || tool === null || (typeof tool === "string" && tool.length <= NOTE_TOOL_MOST))) refuse(422, "BAD_REQUEST", `a note's tool is a name of at most ${NOTE_TOOL_MOST} characters`);
    const now = this.options.now();
    const kept = this.#notes.read()?.toString("utf8") ?? null;
    const today = notesIn(kept ?? "").filter((note) => note.pass === pass && Date.parse(note.at) > now - DAY_MS).length;
    if (today >= NOTES_A_DAY) return { outcome: "full" };
    const row = readPrincipals(this.#principals).principals.find((each) => each.id === pass);
    const note: Note = {
      at: new Date(now).toISOString(), pass, who: row?.agent?.name ?? row?.unit ?? pass, category: category as Note["category"],
      tool: typeof tool === "string" && tool !== "" ? tool : null, message,
    };
    this.#notes.append(Buffer.from(`${kept !== null && kept !== "" && !kept.endsWith("\n") ? "\n" : ""}${JSON.stringify(note)}\n`));
    return { outcome: "saved" };
  }

  #revoke(row: Principal, by: AccessBy = "person", device: string | null = null): void {
    const now = this.options.now();
    rememberRevoked(this.options.machine, this.options.folder.root, [row.id]);
    revokePrincipal(this.#principals, row.id, now);
    const held = this.options.access.get(row.id);
    if (held !== undefined) this.options.access.remove(row.id, held.version, { at_ms: now, by, device });
    this.options.tables.drop(grantTable(row.id));
    this.options.commit((tx) => tx.tables.events.append({ at_ms: now, kind: "pass-revoked", key: row.id, detail: { unit: row.unit } }));
    for (const request of this.#requests.values()) if (request.granted === row.id) request.revoked = true;
    this.#settleSoon();
  }

  #prune(): void {
    const now = this.options.now();
    for (const [id, request] of this.#requests) if (now - (request.answered?.at_ms ?? request.at_ms) >= REQUEST_MS) this.#requests.delete(id);
  }
}

function notesIn(text: string): Note[] {
  const notes: Note[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      const note = JSON.parse(line) as unknown;
      if (isObject(note) && typeof note.at === "string" && typeof note.pass === "string" && typeof note.message === "string") notes.push(note as unknown as Note);
    } catch {}
  }
  return notes;
}

function grantedOf(request: Request): SignInGranted | null {
  return request.granted === null ? null : { reader: request.granted, access: request.access ?? defaultAccess() };
}

function fromInternet(agent: Listed): boolean {
  return agent.via === "sign-in" || agent.anywhere;
}

function listed(row: Principal): Listed {
  const { name, via, from, checked, anywhere } = row.agent!;
  return { id: row.id, name, via, from, checked, anywhere: anywhere === true, minted_at: row.minted_at };
}

function accessOf(value: unknown): Access {
  try {
    return parseAccess(value);
  } catch (error) {
    if (error instanceof AccessError) refuse(422, "BAD_REQUEST", error.message);
    throw error;
  }
}

export const MCP_URL = "http://127.0.0.1:4681/mcp";

export const CALL_AGENT = "lifestream agents call";

export function claudeCodeLine(url: string): string {
  return `printf 'Paste your Lifestream pass: ' && read -rs LIFESTREAM_PASS && echo && claude mcp add --transport http lifestream ${url} --header "Authorization: Bearer $LIFESTREAM_PASS"; unset LIFESTREAM_PASS`;
}

export interface Added {
  readonly agent: Listed;
  readonly url: string;
  readonly pass: string;
  readonly claude_desktop: string;
  readonly claude_code: string;
}

function cardOf(card: unknown): Card {
  const { name, checked, host } = (typeof card === "object" && card !== null ? card : {}) as Record<string, unknown>;
  const shown = typeof name === "string" ? name.trim() : "";
  if (shown === "" || shown.length > CARD_MOST) refuse(422, "BAD_REQUEST", `an agent's name is 1 to ${CARD_MOST} characters`);
  if (typeof checked !== "boolean") refuse(422, "BAD_REQUEST", "checked is true or false");
  if (host !== null && (typeof host !== "string" || host === "" || host.length > CARD_MOST)) refuse(422, "BAD_REQUEST", "host is where the access goes, or null");
  return { name: shown, checked, host };
}

function askedOf(asked: unknown): Asked {
  const { client_id, resource } = (typeof asked === "object" && asked !== null ? asked : {}) as Record<string, unknown>;
  if (typeof client_id !== "string" || client_id === "" || typeof resource !== "string" || resource === "") refuse(422, "BAD_REQUEST", "a grant names its client_id and resource");
  return { client_id, resource };
}
