import { createHash, randomBytes } from "node:crypto";
import { NeedsYou } from "../seams.js";
import { readJson } from "./json.js";
import { attempt, refuse, Refused } from "./refused.js";

export const REFRESH_WITHIN_MS = 5 * 60_000;
const SLOW_DOWN_MS = 5_000;
const DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const UNUSED_REDIRECT = "http://127.0.0.1/";

/** An OAuth authorization server and what a sign-in asks it for. */
export interface OAuthIssuer {
  /** The authorization server's address, under which it publishes its metadata. */
  issuer: string;
  /** The scope asked for. */
  scope: string;
  /** The resource asked for, sent with each token request. */
  resource?: string;
}

/** A sign-in's tokens and the client they were issued to, as the vault keeps it. */
export interface OAuthCredential {
  /** The id of the client the tokens were issued to, sent with each refresh when it is not empty. */
  client_id: string;
  /** The secret of a client the person made at the provider, sent with each refresh. */
  client_secret?: string;
  /** The address the credential is refreshed at, kept for a sign-in by a client the person made. */
  token_endpoint?: string;
  /** The token traded for a new access token. */
  refresh_token: string;
  /** The token each request carries as its bearer. */
  access_token: string;
  /** The instant, in Unix milliseconds, the access token expires. */
  expires_ms: number;
}

export interface OAuthClient {
  authorize: string;
  token: string;
  params?: Readonly<Record<string, string>>;
  client_id: string;
  client_secret: string;
}

export interface ClientGrant {
  verifier: string;
  state: string;
  redirect: string;
}

export type Redirected = { code: string } | { error: string };

export interface DeviceAttempt {
  client_id: string;
  device_code: string;
}

export interface DeviceCode {
  code: string;
  open: string;
  interval_ms: number;
  expires_ms: number;
  attempt: DeviceAttempt;
}

export type DevicePolled =
  | { state: "pending"; interval_ms: number }
  | { state: "denied" }
  | { state: "expired" }
  | { state: "approved"; credential: OAuthCredential };

/** Renews a credential at its provider, returning the renewed one or throwing NeedsYou when the provider no longer takes the sign-in. */
export type Refresher = (credential: OAuthCredential, dependencies: OAuthDependencies) => Promise<OAuthCredential>;

/** What an OAuth exchange reaches the network and the clock through. */
export interface OAuthDependencies {
  /** Aborts the exchange's requests. */
  signal: AbortSignal;
  /** The fetch the exchange sends through, the global `fetch` when absent. */
  fetch?: typeof globalThis.fetch;
  /** The clock, in Unix milliseconds, `Date.now` when absent. */
  now?: () => number;
}

export interface OAuthMetadata {
  issuer: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  registration_endpoint?: string;
}

export async function oauthMetadata(issuer: string, dependencies: OAuthDependencies): Promise<OAuthMetadata> {
  const base = endpoint(issuer, "the issuer");
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/$/u, "");
  const url = new URL(`/.well-known/oauth-authorization-server${path}`, base.origin);
  const answer = await call(dependencies, url, { method: "GET", headers: { accept: "application/json" } }, "the metadata");
  if (!answer.ok) refuse(`${issuer}'s metadata answered HTTP ${answer.status}`);
  const body = answer.body ?? refuse(`${issuer}'s metadata is not a JSON object`);
  if (body.issuer !== issuer) refuse(`${issuer}'s metadata names another issuer`);
  const named = (member: string): string | undefined => {
    const value = body[member];
    if (value === undefined) return undefined;
    if (typeof value !== "string") refuse(`${issuer}'s metadata states ${member} as no address`);
    return endpoint(value, member).href;
  };
  const token = named("token_endpoint") ?? refuse(`${issuer}'s metadata states no token_endpoint`);
  const device = named("device_authorization_endpoint");
  const registration = named("registration_endpoint");
  return { issuer, token_endpoint: token, ...(device === undefined ? {} : { device_authorization_endpoint: device }), ...(registration === undefined ? {} : { registration_endpoint: registration }) };
}

export async function deviceStart(issuer: OAuthIssuer, client_name: string, dependencies: OAuthDependencies): Promise<DeviceCode> {
  const now = dependencies.now ?? Date.now;
  const metadata = await oauthMetadata(issuer.issuer, dependencies);
  const registration = metadata.registration_endpoint ?? refuse(`${issuer.issuer} states no registration_endpoint: no client can be registered`);
  const device = metadata.device_authorization_endpoint ?? refuse(`${issuer.issuer} states no device_authorization_endpoint`);
  const registered = await call(dependencies, new URL(registration), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name, redirect_uris: [UNUSED_REDIRECT], grant_types: [DEVICE_GRANT, "refresh_token"], token_endpoint_auth_method: "none", scope: issuer.scope }),
  }, "the registration");
  if (!registered.ok) refuse(`${issuer.issuer} refused to register a client (HTTP ${registered.status}${error(registered.body)})`);
  const client_id = text(registered.body?.client_id) ?? refuse(`${issuer.issuer}'s registration states no client_id`);
  const asked = await call(dependencies, new URL(device), form({ client_id, scope: issuer.scope, resource: issuer.resource }), "the device authorization");
  if (!asked.ok) refuse(`${issuer.issuer} refused a device code (HTTP ${asked.status}${error(asked.body)})`);
  const body = asked.body ?? refuse(`${issuer.issuer}'s device authorization is not a JSON object`);
  const device_code = text(body.device_code) ?? refuse(`${issuer.issuer} stated no device_code`);
  const code = text(body.user_code) ?? refuse(`${issuer.issuer} stated no user_code`);
  const open = text(body.verification_uri_complete) ?? text(body.verification_uri) ?? refuse(`${issuer.issuer} stated no verification_uri`);
  endpoint(open, "verification_uri");
  const expires = seconds(body.expires_in) ?? refuse(`${issuer.issuer} stated no expires_in for its device code`);
  return { code, open, interval_ms: (seconds(body.interval) ?? DEFAULT_INTERVAL_MS / 1000) * 1000, expires_ms: now() + expires * 1000, attempt: { client_id, device_code } };
}

export async function devicePoll(issuer: OAuthIssuer, attempt: DeviceAttempt, interval_ms: number, dependencies: OAuthDependencies): Promise<DevicePolled> {
  const now = dependencies.now ?? Date.now;
  const metadata = await oauthMetadata(issuer.issuer, dependencies);
  const asked_ms = now();
  const answer = await call(dependencies, new URL(metadata.token_endpoint), form({ grant_type: DEVICE_GRANT, device_code: attempt.device_code, client_id: attempt.client_id, resource: issuer.resource }), "the token request");
  if (answer.ok) return { state: "approved", credential: oauthTokens(answer.body, { client_id: attempt.client_id, refresh_token: "" }, asked_ms, issuer.issuer) };
  switch (answer.body?.error) {
    case "authorization_pending":
      return { state: "pending", interval_ms };
    case "slow_down":
      return { state: "pending", interval_ms: interval_ms + SLOW_DOWN_MS };
    case "access_denied":
      return { state: "denied" };
    case "expired_token":
      return { state: "expired" };
    default:
      return refuse(`${issuer.issuer}'s token request answered HTTP ${answer.status}${error(answer.body)}`);
  }
}

/** Returns the credential as it is while its access token has more than five minutes left, and otherwise the refresher's renewal of it. */
export async function oauthFresh(credential: OAuthCredential, refresher: Refresher, dependencies: OAuthDependencies): Promise<OAuthCredential> {
  const now = dependencies.now ?? Date.now;
  if (credential.expires_ms - now() > REFRESH_WITHIN_MS) return credential;
  return refresher(credential, dependencies);
}

/** A refresher for an issuer that publishes OAuth server metadata, finding its token endpoint there at each renewal. */
export function oauthRefresher(issuer: OAuthIssuer): Refresher {
  return async (credential, dependencies) => {
    const metadata = await oauthMetadata(issuer.issuer, dependencies);
    return tokenRefresher(metadata.token_endpoint, issuer.issuer, { resource: issuer.resource })(credential, dependencies);
  };
}

/** A refresher that trades the refresh token at a known token endpoint, sending the client's id and secret and the extra fields that have a value, with the provider's name in its messages. */
export function tokenRefresher(token_endpoint: string, provider: string, extra: Readonly<Record<string, string | undefined>> = {}): Refresher {
  return async (credential, dependencies) => {
    const now = dependencies.now ?? Date.now;
    const asked_ms = now();
    const fields = { grant_type: "refresh_token", refresh_token: credential.refresh_token, client_id: credential.client_id || undefined, client_secret: credential.client_secret, ...extra };
    const answer = await call(dependencies, endpoint(token_endpoint, "the token endpoint"), form(fields), "the refresh");
    if (answer.ok) return oauthTokens(answer.body, credential, asked_ms, provider);
    if (answer.body?.error === "invalid_grant" || answer.status === 401) throw new NeedsYou("signed-out", `${provider} no longer accepts this sign-in`);
    return refuse(`${provider}'s refresh answered HTTP ${answer.status}${error(answer.body)}`);
  };
}

/** A refresher for a credential that carries its own token endpoint, as a sign-in by a client the person made does, with the provider's name in its messages. */
export function clientRefresher(provider: string): Refresher {
  return (credential, dependencies) => {
    if (credential.token_endpoint === undefined) throw new NeedsYou("signed-out", `${provider}'s sign-in holds no token endpoint`, { answered: false });
    return tokenRefresher(credential.token_endpoint, provider)(credential, dependencies);
  };
}

export function clientGrant(redirect: string): ClientGrant {
  return { verifier: randomBytes(32).toString("base64url"), state: randomBytes(16).toString("base64url"), redirect };
}

export function clientAuthorize(client: Pick<OAuthClient, "authorize" | "params" | "client_id">, scope: string, grant: ClientGrant): string {
  const url = endpoint(client.authorize, "the authorization endpoint");
  for (const [name, value] of Object.entries(client.params ?? {})) url.searchParams.set(name, value);
  const standard = {
    response_type: "code", client_id: client.client_id, redirect_uri: grant.redirect, scope, state: grant.state,
    code_challenge: createHash("sha256").update(grant.verifier).digest("base64url"), code_challenge_method: "S256",
  };
  for (const [name, value] of Object.entries(standard)) url.searchParams.set(name, value);
  return url.href;
}

export function redirectedTo(address: string, state: string): Redirected {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return refuse("that is not the address your browser ended on");
  }
  const query = url.searchParams;
  if (query.get("state") !== state) refuse("that address is of another sign-in");
  const error = query.get("error");
  if (error !== null) return { error: NAMED.has(error) ? error : "refused" };
  const code = query.get("code");
  return code === null || code === "" ? refuse("that address carries no sign-in") : { code };
}

export async function clientExchange(client: OAuthClient, grant: ClientGrant, code: string, provider: string, dependencies: OAuthDependencies): Promise<OAuthCredential> {
  const now = dependencies.now ?? Date.now;
  const asked_ms = now();
  const token_endpoint = endpoint(client.token, "the token endpoint").href;
  const answer = await call(dependencies, new URL(token_endpoint), form({
    grant_type: "authorization_code", code, redirect_uri: grant.redirect, code_verifier: grant.verifier, client_id: client.client_id, client_secret: client.client_secret,
  }), "the code exchange");
  if (!answer.ok && answer.body?.error === "invalid_grant") refuse(`${provider} did not take the sign-in's code: a code is taken once, and for a few minutes`);
  if (!answer.ok) refuse(`${provider} refused the sign-in's code (HTTP ${answer.status}${error(answer.body)})`);
  return oauthTokens(answer.body, { client_id: client.client_id, client_secret: client.client_secret, token_endpoint, refresh_token: "" }, asked_ms, provider);
}

/** Reads the credential sealed as JSON text under the name given, throwing NeedsYou when no readable object is sealed and Refused when one lacks a part. */
export function oauthCredential(sealed: string, where: string): OAuthCredential {
  const value = attempt(() => readJson(sealed, where));
  if (value instanceof Refused || typeof value !== "object" || value === null || Array.isArray(value)) throw new NeedsYou("signed-out", `no sign-in is sealed under ${where}`, { answered: false });
  const object = value as Record<string, unknown>;
  const client_id = object.client_id;
  const refresh_token = text(object.refresh_token);
  const access_token = text(object.access_token);
  const expires_ms = object.expires_ms;
  if (typeof client_id !== "string" || refresh_token === undefined || access_token === undefined || typeof expires_ms !== "number" || !Number.isSafeInteger(expires_ms)) {
    refuse(`${where} holds no sign-in: it lacks client_id, refresh_token, access_token or expires_ms`);
  }
  const client_secret = text(object.client_secret);
  const token_endpoint = text(object.token_endpoint);
  if ((object.client_secret !== undefined && client_secret === undefined) || (object.token_endpoint !== undefined && token_endpoint === undefined)) {
    refuse(`${where} holds no sign-in: its client_secret or token_endpoint is no text`);
  }
  return { client_id, ...clientParts({ client_secret, token_endpoint }), refresh_token, access_token, expires_ms };
}

/** The JSON text a credential is sealed as, which `oauthCredential` reads back. */
export function credentialText(credential: OAuthCredential): string {
  return JSON.stringify({
    client_id: credential.client_id, ...clientParts(credential),
    refresh_token: credential.refresh_token, access_token: credential.access_token, expires_ms: credential.expires_ms,
  });
}

export function oauthTokens(
  body: Record<string, unknown> | undefined, credential: Pick<OAuthCredential, "client_id" | "client_secret" | "token_endpoint" | "refresh_token">, asked_ms: number, provider: string,
): OAuthCredential {
  const access_token = text(body?.access_token) ?? refuse(`${provider}'s token answer states no access_token`);
  const refresh_token = text(body?.refresh_token) ?? text(credential.refresh_token) ?? refuse(`${provider}'s token answer states no refresh_token: ask for offline access`);
  const expires = seconds(body?.expires_in) ?? refuse(`${provider}'s token answer states no expires_in`);
  return { client_id: credential.client_id, ...clientParts(credential), refresh_token, access_token, expires_ms: asked_ms + expires * 1000 };
}

function clientParts(credential: { client_secret?: string | undefined; token_endpoint?: string | undefined }): Pick<OAuthCredential, "client_secret" | "token_endpoint"> {
  return {
    ...(credential.client_secret === undefined ? {} : { client_secret: credential.client_secret }),
    ...(credential.token_endpoint === undefined ? {} : { token_endpoint: credential.token_endpoint }),
  };
}

function endpoint(value: string, what: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return refuse(`${what} is no address`);
  }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) refuse(`${what} is not an https address`);
  return url;
}

function form(fields: Record<string, string | undefined>): RequestInit {
  const body = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) if (value !== undefined) body.set(name, value);
  return { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: body.toString() };
}

export const ANSWER_BYTES = 1024 * 1024;

export async function cappedBody(response: Response, what: string, cap = ANSWER_BYTES): Promise<Buffer> {
  const stated = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(stated) && stated > cap) {
    await response.body?.cancel().catch(() => undefined);
    refuse(`${what} answered more than ${cap} bytes`);
  }
  if (response.body === null) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => undefined);
      refuse(`${what} answered more than ${cap} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function call(dependencies: OAuthDependencies, url: URL, init: RequestInit, what: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> | undefined }> {
  const response = await (dependencies.fetch ?? globalThis.fetch)(url, { ...init, ...(init.method === "POST" ? { redirect: "error" as const } : {}), signal: dependencies.signal });
  const bytes = await cappedBody(response, what);
  let body: Record<string, unknown> | undefined;
  try {
    const value = readJson(bytes.toString("utf8"), what);
    body = typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    body = undefined;
  }
  return { ok: response.ok, status: response.status, body };
}

const NAMED = new Set([
  "invalid_request", "invalid_client", "invalid_grant", "unauthorized_client", "unsupported_grant_type", "invalid_scope",
  "authorization_pending", "slow_down", "access_denied", "expired_token",
  "invalid_redirect_uri", "invalid_client_metadata", "invalid_software_statement", "unapproved_software_statement",
]);

function error(body: Record<string, unknown> | undefined): string {
  const code = body?.error;
  return typeof code === "string" && NAMED.has(code) ? `, ${code}` : "";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function seconds(value: unknown): number | undefined {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
