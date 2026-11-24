import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { isObject, type FileKind, type HomeFolder, type KeptFile, type LevelName } from "@lifestreamprotocol/core";
import type { Sealed } from "@lifestreamprotocol/privacy";
import { DEVICE_KINDS, isDeviceKind, type DeviceKind } from "./devices.js";
import { isSegment } from "./inbox.js";
import { refuse, Refusal, starting } from "./refusal.js";


export const PRINCIPALS_FORMAT = "org.lifestreamprotocol.principals/1";
export const SCOPES = ["deliver", "read", "station", "drive", "call", "find", "admit", "run"] as const;
export type Scope = (typeof SCOPES)[number];
export type PassKind = DeviceKind | "agent";
export const AGENT_UNIT = "agent";
export const GRANT_APPS = ["grok-bot", "instinct"] as const;
export type GrantApp = (typeof GRANT_APPS)[number];

export interface AgentGrant {
  readonly name: string;
  readonly via: "sign-in" | "pass";
  readonly from: string | null;
  readonly checked: boolean;
  readonly client_id: string | null;
  readonly resource: string | null;
  readonly request?: string;
  readonly anywhere?: true;
  readonly own?: true;
  readonly app?: GrantApp;
}

export interface Principal {
  readonly id: string;
  readonly unit: string;
  readonly scopes: Scope[];
  readonly sources: string[];
  readonly token_sha256: string;
  readonly minted_at: string;
  readonly revoked_at: string | null;
  readonly suspended_at: string | null;
  readonly kind: PassKind | null;
  readonly account: string | null;
  readonly retired_at?: string;
  readonly agent?: AgentGrant;
  readonly expires_at?: string;
  readonly family_sha256?: string;
  readonly refresh_sha256?: string;
  readonly turn?: { readonly id: string; readonly chat: string | null; readonly level: LevelName | null; readonly pick: LevelName | null };
}

export interface PrincipalsFile {
  readonly format: typeof PRINCIPALS_FORMAT;
  readonly principals: Principal[];
}

const ID = /^p-[0-9a-f]{8}$/u;
const HEX = /^[0-9a-f]{64}$/u;
const TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const MEMBERS = ["id", "unit", "scopes", "sources", "token_sha256", "minted_at", "revoked_at", "suspended_at", "kind", "account"];

export class PrincipalsError extends Error {
  constructor(message: string) {
    super(`[PRINCIPALS] ${message}`);
    this.name = "PrincipalsError";
  }
}

function bad(message: string): never {
  throw new PrincipalsError(message);
}

export function parsePrincipals(text: string, where: string): PrincipalsFile {
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) { return bad(`${where}: ${(error as Error).message}`); }
  if (!isObject(value)) bad(`${where}: the file is a JSON object`);
  if (value.format !== PRINCIPALS_FORMAT) bad(`${where}: format must be ${PRINCIPALS_FORMAT}`);
  if (!Array.isArray(value.principals)) bad(`${where}: principals must be an array`);
  const ids = new Set<string>();
  const principals = value.principals.map((row: unknown, index: number): Principal => {
    const label = `${where}: principals[${index}]`;
    if (!isObject(row) || MEMBERS.some((member) => !Object.hasOwn(row, member))) bad(`${label} must state ${MEMBERS.join(", ")}`);
    const id = nonEmpty(row.id, `${label}.id`);
    if (!ID.test(id)) bad(`${label}.id must be p- and eight hex digits`);
    if (ids.has(id)) bad(`${label}.id ${id} is repeated`);
    ids.add(id);
    const scopes = strings(row.scopes, `${label}.scopes`);
    if (scopes.length === 0 || scopes.some((scope) => !(SCOPES as readonly string[]).includes(scope)) || new Set(scopes).size !== scopes.length)
      bad(`${label}.scopes must be distinct names from ${SCOPES.join(", ")}`);
    const sources = strings(row.sources, `${label}.sources`);
    if (sources.some((source) => !isSegment(source)) || new Set(sources).size !== sources.length) bad(`${label}.sources must be distinct source ids`);
    if (scopes.includes("deliver") === (sources.length === 0)) bad(`${label}: deliver names sources; read names none`);
    const hash = nonEmpty(row.token_sha256, `${label}.token_sha256`);
    if (!HEX.test(hash)) bad(`${label}.token_sha256 must be 64 lowercase hex digits`);
    if (row.revoked_at !== null && typeof row.revoked_at !== "string") bad(`${label}.revoked_at must be an instant or null`);
    const suspended = row.suspended_at;
    if (suspended !== null && typeof suspended !== "string") bad(`${label}.suspended_at must be an instant or null`);
    const unit = nonEmpty(row.unit, `${label}.unit`);
    const kind = row.kind;
    if (kind !== null && kind !== "agent" && !isDeviceKind(kind)) bad(`${label}.kind must be one of ${[...DEVICE_KINDS, "agent"].join(", ")}, or null`);
    const only = (["admit", "find"] as const).find((scope) => scopes.includes(scope));
    if (only !== undefined && (kind !== null || scopes.length !== 1)) bad(`${label}: ${only} is a reader's pass's one scope`);
    if ((scopes.includes("run") || kind === "runner") && (kind !== "runner" || scopes.join() !== "run")) bad(`${label}: run is a runner's pass's one scope`);
    const account = row.account;
    if (account !== null && (typeof account !== "string" || account === "")) bad(`${label}.account must be an account or null`);
    const granted = kind === "agent" ? agentMembers(row, scopes, label) : undefined;
    if (kind !== "agent" && GRANT_MEMBERS.some((member) => Object.hasOwn(row, member))) bad(`${label}: only an agent's row states ${GRANT_MEMBERS.join(", ")}`);
    if (Object.hasOwn(row, "retired_at") && (!isDeviceKind(kind) || typeof row.retired_at !== "string" || Number.isNaN(Date.parse(row.retired_at))))
      bad(`${label}.retired_at is an instant, on a device's row alone`);
    return {
      ...row, id, unit, scopes: scopes as Scope[], sources, token_sha256: hash,
      minted_at: nonEmpty(row.minted_at, `${label}.minted_at`), revoked_at: row.revoked_at, suspended_at: suspended, kind, account, ...granted,
    };
  });
  return { ...value, format: PRINCIPALS_FORMAT, principals };
}

const GRANT_MEMBERS = ["agent", "expires_at", "family_sha256", "refresh_sha256"];

function agentMembers(row: Record<string, unknown>, scopes: readonly string[], label: string): Pick<Principal, "agent" | "expires_at" | "family_sha256" | "refresh_sha256"> {
  if (scopes.join() !== "read") bad(`${label}: an agent's pass reads, and nothing else`);
  const agent = row.agent;
  if (!isObject(agent)) bad(`${label}.agent must state who the agent is`);
  const name = nonEmpty(agent.name, `${label}.agent.name`);
  if (agent.via !== "sign-in" && agent.via !== "pass") bad(`${label}.agent.via must be sign-in or pass`);
  const nullable = (value: unknown, member: string) => {
    if (value !== null && (typeof value !== "string" || value === "")) bad(`${label}.agent.${member} must be a string or null`);
    return value as string | null;
  };
  if (typeof agent.checked !== "boolean") bad(`${label}.agent.checked must be true or false`);
  const granted: AgentGrant = {
    ...agent, name, via: agent.via, from: nullable(agent.from, "from"), checked: agent.checked, client_id: nullable(agent.client_id, "client_id"), resource: nullable(agent.resource, "resource"),
  };
  if (agent.via === "pass") {
    if (["expires_at", "family_sha256", "refresh_sha256"].some((member) => Object.hasOwn(row, member))) bad(`${label}: a copied pass never expires and has no refresh family`);
    if (Object.hasOwn(agent, "request")) bad(`${label}.agent: a copied pass was granted for no request`);
    if (Object.hasOwn(agent, "anywhere") && agent.anywhere !== true) bad(`${label}.agent.anywhere is true when it is stated`);
    if (Object.hasOwn(agent, "own") && agent.own !== true) bad(`${label}.agent.own is true when it is stated`);
    if (Object.hasOwn(agent, "app") && !(GRANT_APPS as readonly unknown[]).includes(agent.app)) bad(`${label}.agent.app is one of ${GRANT_APPS.join(", ")} when it is stated`);
    return { agent: granted };
  }
  if (Object.hasOwn(agent, "anywhere") || Object.hasOwn(agent, "own")) bad(`${label}.agent: a sign-in states no anywhere and is never the home's own`);
  if (Object.hasOwn(agent, "app")) bad(`${label}.agent: a sign-in states no app: its host names it`);
  if (granted.client_id === null || granted.resource === null) bad(`${label}.agent: a sign-in names its client_id and resource`);
  nonEmpty(agent.request, `${label}.agent.request`);
  const expires = nonEmpty(row.expires_at, `${label}.expires_at`);
  if (Number.isNaN(Date.parse(expires))) bad(`${label}.expires_at must be an instant`);
  const family = nonEmpty(row.family_sha256, `${label}.family_sha256`);
  const refresh = nonEmpty(row.refresh_sha256, `${label}.refresh_sha256`);
  if (!HEX.test(family) || !HEX.test(refresh)) bad(`${label}: family_sha256 and refresh_sha256 are 64 lowercase hex digits`);
  return { agent: granted, expires_at: expires, family_sha256: family, refresh_sha256: refresh };
}

const PASSES: FileKind = { role: "principals" };

function passesFile(folder: HomeFolder): KeptFile {
  return folder.file(PASSES, join(folder.root, "config", "principals.json"));
}

function textOf(folder: HomeFolder): string | null {
  return passesFile(folder).read()?.toString("utf8") ?? null;
}

export function readPrincipals(folder: HomeFolder): PrincipalsFile {
  const text = textOf(folder);
  return text === null ? { format: PRINCIPALS_FORMAT, principals: [] } : parsePrincipals(text, passesFile(folder).path);
}

export function heldRunners(folder: HomeFolder): Set<string> {
  return new Set(readPrincipals(folder).principals.filter((row) => row.kind === "runner" && row.revoked_at === null).map((row) => row.unit));
}

export function writePrincipals(folder: HomeFolder, file: PrincipalsFile): void {
  const text = JSON.stringify(file);
  parsePrincipals(text, "write");
  passesFile(folder).write(Buffer.from(`${text}\n`));
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface Mint {
  readonly unit: string;
  readonly scopes: readonly Scope[];
  readonly sources?: readonly string[];
  readonly kind?: PassKind | null;
  readonly account?: string | null;
  readonly granted?: Pick<Principal, "agent" | "expires_at" | "family_sha256" | "refresh_sha256">;
  readonly token?: string;
  readonly now_ms: number;
  readonly first?: (id: string) => void;
}

export function mintIn(file: PrincipalsFile, input: Mint, random: (bytes: number) => Buffer = randomBytes): { file: PrincipalsFile; principal: Principal; token: string } {
  const token = input.token ?? random(32).toString("base64url");
  if (!TOKEN.test(token)) bad("a token is 32 random bytes, base64url");
  if (input.unit.length === 0) bad("a principal names a unit");
  const digest = hashToken(token);
  if (file.principals.some((row) => row.token_sha256 === digest)) bad("this token is already a principal");
  let id: string;
  do id = `p-${random(4).toString("hex")}`; while (file.principals.some((row) => row.id === id));
  input.first?.(id);
  const principal: Principal = {
    id, unit: input.unit, scopes: [...new Set(input.scopes)], sources: [...new Set(input.sources ?? [])],
    token_sha256: digest, minted_at: new Date(input.now_ms).toISOString(), revoked_at: null, suspended_at: null, kind: input.kind ?? null,
    account: input.account ?? null, ...input.granted,
  };
  return { file: { ...file, principals: [...file.principals, principal] }, principal, token };
}

export function mintPrincipal(folder: HomeFolder, input: Mint, random: (bytes: number) => Buffer = randomBytes): { principal: Principal; token: string } {
  const minted = mintIn(readPrincipals(folder), input, random);
  writePrincipals(folder, minted.file);
  return { principal: minted.principal, token: minted.token };
}

export const DRIVE_UNIT = "home";

export function mintOwn(folder: HomeFolder, scope: "drive" | "call", now_ms: number, random: (bytes: number) => Buffer = randomBytes): string {
  const file = readPrincipals(folder);
  const others = file.principals.filter((row) => !(row.unit === DRIVE_UNIT && row.scopes.join() === scope));
  const minted = mintIn({ ...file, principals: others }, { unit: DRIVE_UNIT, scopes: [scope], now_ms }, random);
  writePrincipals(folder, minted.file);
  return minted.token;
}

export function mintOwnPair(folder: HomeFolder, now_ms: number, random: (bytes: number) => Buffer = randomBytes): { drive: string; call: string } {
  const file = readPrincipals(folder);
  const others = file.principals.filter((row) => !(row.unit === DRIVE_UNIT && (row.scopes.join() === "drive" || row.scopes.join() === "call")));
  const drive = mintIn({ ...file, principals: others }, { unit: DRIVE_UNIT, scopes: ["drive"], now_ms }, random);
  const call = mintIn(drive.file, { unit: DRIVE_UNIT, scopes: ["call"], now_ms }, random);
  writePrincipals(folder, call.file);
  return { drive: drive.token, call: call.token };
}

export function passOf(folder: HomeFolder, token: string): Principal | undefined {
  const hash = hashToken(token);
  return readPrincipals(folder).principals.find((row) => row.token_sha256 === hash);
}

export function widenIn(file: PrincipalsFile, id: string, scopes: readonly Scope[], sources: readonly string[]): { file: PrincipalsFile; principal: Principal; changed: boolean } {
  const row = file.principals.find((principal) => principal.id === id) ?? bad(`no principal ${id}`);
  const added = sources.filter((source) => !row.sources.includes(source));
  const granted = [...scopes, ...(added.length > 0 ? ["deliver" as const] : [])].filter((scope, index, all) => !row.scopes.includes(scope) && all.indexOf(scope) === index);
  if (added.length === 0 && granted.length === 0) return { file, principal: row, changed: false };
  const grown: Principal = { ...row, scopes: [...row.scopes, ...granted], sources: [...row.sources, ...added] };
  return { file: { ...file, principals: file.principals.map((principal) => principal.id === id ? grown : principal) }, principal: grown, changed: true };
}

export function widen(folder: HomeFolder, id: string, scopes: readonly Scope[], sources: readonly string[]): Principal {
  const widened = widenIn(readPrincipals(folder), id, scopes, sources);
  if (widened.changed) writePrincipals(folder, widened.file);
  return widened.principal;
}

export function stateAccount(folder: HomeFolder, id: string, account: string): Principal {
  const file = readPrincipals(folder);
  const row = file.principals.find((principal) => principal.id === id) ?? bad(`no principal ${id}`);
  const stated: Principal = { ...row, account };
  writePrincipals(folder, { ...file, principals: file.principals.map((principal) => principal.id === id ? stated : principal) });
  return stated;
}

export function retireUnit(folder: HomeFolder, unit: string, retired_ms: number): string[] {
  const file = readPrincipals(folder);
  const due = file.principals.filter((row) => row.unit === unit && isDeviceKind(row.kind) && row.retired_at === undefined).map((row) => row.id);
  if (due.length === 0) return [];
  const retired_at = new Date(retired_ms).toISOString();
  writePrincipals(folder, { ...file, principals: file.principals.map((row) => due.includes(row.id) ? { ...row, retired_at } : row) });
  return due;
}

export function replacedAt(pass: Principal, passes: readonly Principal[], firstSealed: (id: string) => number | null, retired_ms: number | null): number | null {
  if (pass.kind === null || pass.kind === "agent") return null;
  const minted = Date.parse(pass.minted_at);
  let at = retired_ms;
  for (const later of passes) {
    if (later.unit !== pass.unit || later.kind !== pass.kind || Date.parse(later.minted_at) <= minted) continue;
    const sealed = firstSealed(later.id);
    if (sealed !== null && (at === null || sealed < at)) at = sealed;
  }
  return at;
}

export interface PhonePass {
  readonly pass: Principal;
  readonly first_ms: number | null;
  readonly newest_ms: number | null;
  readonly replaced_ms: number | null;
  readonly state: "live" | "replaced" | "revoked";
}

export function phonePasses(db: Database.Database, principals: readonly Principal[]): PhonePass[] {
  const passes = principals.filter((row) => row.kind === "phone");
  const sealedBy = db.prepare(`SELECT
    (SELECT sealed_ms FROM deliveries WHERE pass = @pass AND seal IS NOT NULL ORDER BY sealed_ms LIMIT 1) AS first_ms,
    (SELECT sealed_ms FROM deliveries WHERE pass = @pass AND seal IS NOT NULL ORDER BY sealed_ms DESC LIMIT 1) AS newest_ms`);
  const retiredOf = db.prepare("SELECT retired_ms FROM devices WHERE unit = ?").pluck();
  const sealed = new Map(passes.map((row) => [row.id, sealedBy.get({ pass: row.id }) as { first_ms: number | null; newest_ms: number | null }]));
  return passes.map((pass) => {
    const replaced_ms = replacedAt(pass, passes, (id) => sealed.get(id)?.first_ms ?? null, (retiredOf.get(pass.unit) as number | null | undefined) ?? null);
    return {
      pass, ...sealed.get(pass.id)!, replaced_ms,
      state: pass.revoked_at !== null ? "revoked" : replaced_ms === null ? "live" : "replaced",
    };
  });
}

export function revokeIn(file: PrincipalsFile, id: string, now_ms: number): { file: PrincipalsFile; principal: Principal } {
  const row = file.principals.find((principal) => principal.id === id) ?? bad(`no principal ${id}`);
  if (row.revoked_at !== null) bad(`principal ${id} was revoked at ${row.revoked_at}`);
  const revoked = { ...row, revoked_at: new Date(now_ms).toISOString() };
  return { file: { ...file, principals: file.principals.map((principal) => principal.id === id ? revoked : principal) }, principal: revoked };
}

export function revokePrincipal(folder: HomeFolder, id: string, now_ms: number): Principal {
  const revoked = revokeIn(readPrincipals(folder), id, now_ms);
  writePrincipals(folder, revoked.file);
  return revoked.principal;
}

export function readFromAnywhere(folder: HomeFolder, id: string): Principal {
  const file = readPrincipals(folder);
  const row = file.principals.find((principal) => principal.id === id) ?? bad(`no principal ${id}`);
  if (row.kind !== "agent" || row.agent?.via !== "pass" || row.agent.own === true || row.revoked_at !== null) bad(`principal ${id} is no agent's copied pass that stands`);
  if (row.agent.anywhere === true) return row;
  const widened: Principal = { ...row, agent: { ...row.agent, anywhere: true } };
  writePrincipals(folder, { ...file, principals: file.principals.map((principal) => principal.id === id ? widened : principal) });
  return widened;
}

export function resumePrincipal(folder: HomeFolder, id: string): Principal {
  const file = readPrincipals(folder);
  const row = file.principals.find((principal) => principal.id === id) ?? bad(`no principal ${id}`);
  if (row.suspended_at === null) bad(`principal ${id} is not suspended`);
  const resumed = { ...row, suspended_at: null };
  writePrincipals(folder, { ...file, principals: file.principals.map((principal) => principal.id === id ? resumed : principal) });
  return resumed;
}

export type Reach = "loopback" | "tailscale" | "lan";

export function authenticate(folder: HomeFolder, header: string | undefined, reach: Reach, at: { now_ms: number; public: boolean; turns?: TurnPasses }): Principal {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/u.exec(header) : null;
  const turn = at.turns === undefined || match === null ? null : at.turns.of(match[1]!);
  if (turn === undefined) refuse(401, "PRINCIPAL_UNKNOWN", "this turn's pass has ended: it lived while its request did");
  const supplied = createHash("sha256").update(match?.[1] ?? "").digest();
  const text = textOf(folder) ?? starting();
  let found: Principal | undefined;
  for (const principal of parsePrincipals(text, passesFile(folder).path).principals) {
    const named = turn === null ? timingSafeEqual(Buffer.from(principal.token_sha256, "hex"), supplied) : principal.id === turn.id;
    if (named && principal.revoked_at === null && principal.suspended_at === null && match !== null) found = turn === null ? principal : { ...principal, turn: { id: turn.turn, chat: turn.chat, level: turn.level, pick: turn.pick } };
  }
  if (found === undefined) refuse(401, "PRINCIPAL_UNKNOWN", "no principal holds this token");
  if (found.expires_at !== undefined && at.now_ms >= Date.parse(found.expires_at)) refuse(401, "PRINCIPAL_UNKNOWN", "this access has expired: renew it");
  if (at.public && found.agent?.via !== "sign-in" && found.agent?.anywhere !== true) refuse(401, "PRINCIPAL_UNKNOWN", "only a sign-in's access, or a pass made to read from anywhere, reads through the public address");
  if ((found.kind === null || found.kind === "agent") && reach === "lan") refuse(403, "PRINCIPAL_SCOPE", "a reader's pass reads from the home's own Mac or over Tailscale, never from the Wi-Fi");
  return found;
}

const TURN = /^turn\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})$/u;

export interface TurnPasses {
  open(principal: Pick<Principal, "id">, of: { chat: string; level: LevelName; pick?: LevelName | null } | null, relayed: string): { turn: string; token: string };
  forget(turn: string): void;
  pin(turn: string, level: LevelName): void;
  of(token: string): { turn: string; id: string; chat: string | null; level: LevelName | null; pick: LevelName | null } | null | undefined;
  relayed(turn: string): string | null;
}

export function turnPasses(): TurnPasses {
  const live = new Map<string, { secret: Buffer; id: string; chat: string | null; level: LevelName | null; pick: LevelName | null; relayed: string | null }>();
  const digest = (secret: string): Buffer => createHash("sha256").update(secret).digest();
  return {
    open(principal, of, relayed) {
      const turn = randomBytes(8).toString("hex");
      const secret = randomBytes(32).toString("base64url");
      live.set(turn, { secret: digest(secret), id: principal.id, chat: of?.chat ?? null, level: of?.level ?? null, pick: of?.pick ?? null, relayed });
      return { turn, token: `turn.${turn}.${secret}` };
    },
    forget: (turn) => { live.delete(turn); },
    pin(turn, level) {
      const held = live.get(turn);
      if (held !== undefined && held.chat !== null) held.level = level;
    },
    of(token) {
      const parts = TURN.exec(token);
      if (parts === null) return null;
      const held = live.get(parts[1]!);
      if (held === undefined || !timingSafeEqual(held.secret, digest(parts[2]!))) return undefined;
      return { turn: parts[1]!, id: held.id, chat: held.chat, level: held.level, pick: held.pick };
    },
    relayed(turn) {
      const held = live.get(turn);
      if (held === undefined) return null;
      const said = held.relayed;
      held.relayed = null;
      return said;
    },
  };
}

export function tokenTag(header: string | undefined): string {
  const match = typeof header === "string" ? /^Bearer\s+(\S+)$/u.exec(header) : null;
  return match === null ? "none" : createHash("sha256").update(match[1]!).digest("hex").slice(0, 8);
}

export type HiddenReader =
  | { readonly pass: string; readonly agent: null; readonly turn?: { readonly table: `chat:${string}`; readonly level: LevelName }; readonly sealed?: Sealed }
  | { readonly pass: string; readonly agent: { readonly table: `grant:${string}`; readonly name: string; readonly shown?: readonly string[] }; readonly sealed?: Sealed };

export function hiddenReader(pass: Principal): HiddenReader {
  if (pass.kind !== "agent") {
    const turn = pass.turn;
    return { pass: pass.id, agent: null, ...(turn?.chat == null || turn.level === null ? {} : { turn: { table: `chat:${turn.chat}` as const, level: turn.level } }) };
  }
  return { pass: pass.id, agent: { table: grantTable(pass.id), name: pass.agent!.name } };
}

export function grantTable(id: string): `grant:${string}` {
  return `grant:${id}`;
}

export const SERVER_HEADER = "lifestream-server";

export function assertThroughServer(folder: HomeFolder, pass: Principal, server: string | string[] | undefined, reach: Reach, now_ms: number): void {
  if (pass.kind !== "agent") return;
  let beside: Principal | null = null;
  if (typeof server === "string" && reach === "loopback") {
    try {
      beside = authenticate(folder, `Bearer ${server}`, reach, { now_ms, public: false });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
    }
  }
  if (beside === null || !beside.scopes.includes("admit")) refuse(403, "THROUGH_SERVER", "An agent reads your record through Lifestream's MCP server");
}

export function deviceOf(pass: Pick<Principal, "kind">): DeviceKind | null {
  return pass.kind === null || pass.kind === "agent" ? null : pass.kind;
}

export function assertAllowed(principal: Principal, scope: Scope, source?: string): void {
  const allowed = principal.scopes.includes(scope) && (scope === "read" || (source !== undefined && principal.sources.includes(source)));
  if (!allowed) refuse(403, "PRINCIPAL_SCOPE", `principal ${principal.id} lacks ${scope}${source === undefined ? "" : ` for ${source}`}`);
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) bad(`${label} must be a non-empty string`);
  return value;
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) bad(`${label} must be an array of non-empty strings`);
  return value as string[];
}
