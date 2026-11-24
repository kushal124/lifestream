import {
  accountField, cappedBody, checkAddress, clientAuthorize, CREDENTIAL, clientExchange, clientGrant, connectorName, deviceStart as oauthStart, devicePoll as oauthPoll, credentialText, issuerOf, NeedsYou, oauthCredential,
  offline, redirectedTo, Refused, ROUTE, routeId, runningOf, secretFieldOf, signinSets,
  type Check, type Client, type ClientGrant, type Connector, type DeviceAttempt, type SignIn, type SignedIn,
} from "@lifestreamprotocol/connect";
import { accountName, isObject, SecretError, SourceNameError, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { HOME_DEPENDENCIES } from "../dependencies.js";
import { failpoint } from "../failpoint.js";
import { needsMet, outcomesOf } from "../attempts.js";
import { nameKey } from "../devices.js";
import { queuePoll } from "../import.js";
import { blockOf, connectorSettings, effective, plannedBlock, SettingsError } from "../settings.js";
import { VerbError, type VerbContext } from "./context.js";

export const SIGNIN_MS = 20_000;

export interface SignInRefusal {
  refused: string;
  field?: string;
}

export interface Sealing {
  sealable(): unknown;
  seal(secret: string, value: string): unknown;
  names(): readonly string[];
  read(secret: string): string | undefined;
  remove(secret: string): unknown;
}

export interface SignedInAs {
  account: string;
  source: string;
}

const CLIENT_NAME = "Lifestream";
const GENERATION = "secret-generation:";
const DEFAULT_INTERVAL_MS = 5_000;

class SignInRefused extends VerbError {
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

function refuse(words: string, field?: string): never {
  throw new SignInRefused(words, field);
}

const unanswered = (connector: Connector): string => `${connectorName(connector)} did not answer. Try again in a moment.`;

async function answering<T>(ctx: VerbContext, within_ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T | SignInRefusal> {
  try {
    return await work(AbortSignal.timeout(within_ms));
  } catch (error) {
    if (error instanceof SignInRefused) return { refused: error.message, ...(error.field === undefined ? {} : { field: error.field }) };
    if (error instanceof SecretError && error.reason === "locked") return { refused: unlockWords(ctx) };
    if (error instanceof VerbError || error instanceof SecretError) return { refused: error.message };
    throw error;
  }
}

function unlockWords(ctx: VerbContext): string {
  const view = ctx.db.view();
  try {
    const name = view.tables.meta.get(nameKey(ctx.settings.unit)) ?? view.tables.devices.get(ctx.settings.unit)?.model ?? "your Mac";
    return `Unlock Lifestream on ${name} first.`;
  } finally {
    view.close();
  }
}

export function accountConnect(ctx: VerbContext, request: JsonObject, vault: Sealing, within_ms = SIGNIN_MS): Promise<SignedInAs | SignInRefusal> {
  return answering(ctx, within_ms, async (signal) => {
    vault.sealable();
    const { connector, route, check } = await routeAsked(ctx, request, ["key"]);
    const values = isObject(request.values) ? request.values : {};
    const row = (name: string, label: string): string => {
      const value = values[name];
      return typeof value === "string" && value.trim() !== "" ? value : refuse(`Type your ${label}.`, name);
    };
    const secret = secretFieldOf(connector, route);
    const fields: Record<string, string> = {};
    for (const field of route.fields) {
      const value = row(field, labelOf(connector, field));
      if (field !== secret) fields[field] = value.trim();
    }
    return signIn(ctx, { connector, route, check, vault, signal }, { fields, credential: values[secret] as string });
  });
}

export function deviceStart(ctx: VerbContext, request: JsonObject, vault: Sealing, within_ms = SIGNIN_MS): Promise<{ code: string; open: string; interval_ms: number; expires_ms: number; attempt: DeviceAttempt } | SignInRefusal> {
  return answering(ctx, within_ms, async (signal) => {
    vault.sealable();
    const { connector, route } = await routeAsked(ctx, request, ["device"]);
    const code = await asking(connector, () => oauthStart(issuerOf(route), CLIENT_NAME, { now: ctx.now, signal }));
    return { code: code.code, open: code.open, interval_ms: code.interval_ms, expires_ms: code.expires_ms, attempt: code.attempt };
  });
}

export function devicePoll(ctx: VerbContext, request: JsonObject, vault: Sealing, within_ms = SIGNIN_MS): Promise<{ state: "pending"; interval_ms: number } | { state: "denied" | "expired" } | ({ state: "signed_in" } & SignedInAs) | SignInRefusal> {
  return answering(ctx, within_ms, async (signal) => {
    vault.sealable();
    const { connector, route, check } = await routeAsked(ctx, request, ["device"]);
    const held = request.attempt as Partial<DeviceAttempt> | null | undefined;
    if (typeof held?.client_id !== "string" || typeof held.device_code !== "string") return refuse("This sign-in has ended: start it again.");
    const attempt: DeviceAttempt = { client_id: held.client_id, device_code: held.device_code };
    const waited = typeof request.interval_ms === "number" && Number.isSafeInteger(request.interval_ms) && request.interval_ms > 0 ? request.interval_ms : DEFAULT_INTERVAL_MS;
    const polled = await asking(connector, () => oauthPoll(issuerOf(route), attempt, waited, { now: ctx.now, signal }));
    if (polled.state !== "approved") return polled;
    return { state: "signed_in" as const, ...await signIn(ctx, { connector, route, check, vault, signal }, { fields: {}, credential: credentialText(polled.credential) }) };
  });
}

async function routeAsked<W extends SignIn["way"]>(ctx: VerbContext, request: JsonObject, ways: readonly W[]): Promise<{ connector: Connector; route: Extract<SignIn, { way: W }>; check: SignedIn }> {
  const { connectors, signins } = await ctx.registry();
  const connector = connectors.find((each) => each.id === request.connector) ?? refuse(`This release has no connector ${String(request.connector)}.`);
  const route = connector.signin?.find((each) => routeId(each) === request.route);
  if (route === undefined || !(ways as readonly string[]).includes(route.way)) return refuse(`${connectorName(connector)} has no such way to sign in.`);
  const field = secretFieldOf(connector, route);
  const declared = route.way === "device" ? undefined : route.check;
  const check: SignedIn = declared === undefined ? signins?.[routeId(route)] ?? refuse(`${connectorName(connector)} cannot check a sign-in in this release.`)
    : route.way === "key" ? (values) => declaredCheck(connector, declared, field, values.credential, values.signal)
      : async (values) => {
        const { account } = await declaredCheck(connector, declared, field, oauthCredential(values.credential, field).access_token, values.signal);
        return { ...(account === undefined ? {} : { account }), credential: values.credential };
      };
  return { connector, route: route as Extract<SignIn, { way: W }>, check };
}

const CLIENT_MS = 10 * 60_000;
const UNHEARD = { from: 49_152, to: 65_535 };

interface ClientKeys {
  client_id: string;
  client_secret: string;
}

interface ClientAttempt extends ClientGrant {
  client: { id: string } & Partial<ClientKeys>;
  expires_ms: number;
}

const LOOPBACK = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/u;

export function clientStart(ctx: VerbContext, request: JsonObject, vault: Sealing, listen: (state: string) => Promise<number>, within_ms = SIGNIN_MS): Promise<{ open: string; attempt: JsonObject; expires_ms: number; listening: boolean } | SignInRefusal> {
  return answering(ctx, within_ms, async () => {
    vault.sealable();
    const { connector, route } = await routeAsked(ctx, request, ["client"]);
    const client = await clientOf(ctx, connector, route);
    const typed = isObject(request.client) ? keysTyped(client, request.client) : undefined;
    const keys = typed ?? heldKeys(ctx, vault, client.id) ?? refuse(`Make your ${client.name} client, then type its client ID and secret.`, "client_id");
    const port = request.port;
    if (port !== undefined && !(Number.isSafeInteger(port) && (port as number) > 0 && (port as number) <= 65_535)) refuse("This device named no port to listen on.");
    const fresh = clientGrant("");
    const local = port === undefined && request.local !== false;
    const at = port !== undefined ? port as number : local ? await listen(fresh.state) : UNHEARD.from + Math.floor(Math.random() * (UNHEARD.to - UNHEARD.from + 1));
    const grant: ClientGrant = { ...fresh, redirect: `http://127.0.0.1:${at}` };
    const expires_ms = ctx.now() + CLIENT_MS;
    const attempt: ClientAttempt = { client: typed === undefined ? { id: client.id } : { id: client.id, ...typed }, ...grant, expires_ms };
    return { open: clientAuthorize({ ...client, client_id: keys.client_id }, route.scope, grant), attempt: attempt as unknown as JsonObject, expires_ms, listening: local };
  });
}

export function routeLines(connector: Connector, clients: readonly Client[]): string[] {
  const checked = (check: Check | undefined, sent: string) => (check === undefined ? "checked in code (the module's signins)"
    : `checked by GET ${check.url === CREDENTIAL ? "of the link typed, its own credential" : `${check.url}, ${sent} as Authorization: Bearer`}${check.account === undefined ? "" : `, its account at ${check.account}`}`);
  return (connector.signin ?? []).map((route) => {
    const head = `sign-in ${routeId(route)} (${route.way}, "${route.label}")`;
    if (route.way === "key") return `${head}: types ${route.fields.join(", ")}; ${checked(route.check, "the secret")}`;
    if (route.way === "device") return `${head}: OAuth's device grant at ${route.issuer}, asking ${route.scope}${route.resource === undefined ? "" : ` for ${route.resource}`}`;
    const client = clients.find((each) => each.id === route.client);
    if (client === undefined) return `${head}: names the client ${route.client}, which this release does not declare`;
    const params = Object.entries(client.params ?? {}).map(([name, value]) => `${name}=${value}`).join(", ");
    return `${head}: opens ${client.authorize}, asking ${route.scope}${params === "" ? "" : `, with ${params}`}; ${checked(route.check, "the access token")}`;
  });
}

export interface ClientCatches {
  caught(state: string): string | undefined;
  spent(state: string): string | undefined;
  spend(state: string, words: string): void;
}

export function clientFinish(ctx: VerbContext, request: JsonObject, vault: Sealing, catches: ClientCatches, within_ms = SIGNIN_MS): Promise<{ state: "pending" } | ({ state: "signed_in" } & SignedInAs) | SignInRefusal> {
  return answering(ctx, within_ms, async (signal) => {
    vault.sealable();
    const { connector, route, check } = await routeAsked(ctx, request, ["client"]);
    const client = await clientOf(ctx, connector, route);
    const attempt = attemptOf(request.attempt, client) ?? refuse("This sign-in has ended: start it again.");
    if (attempt.expires_ms <= ctx.now()) refuse("This sign-in has ended: start it again.");
    const spent = catches.spent(attempt.state);
    if (spent !== undefined) refuse(spent);
    const sent = typeof request.address === "string" && request.address.trim() !== "" ? request.address : undefined;
    const address = sent ?? catches.caught(attempt.state);
    if (address === undefined) return { state: "pending" as const };
    let said: ReturnType<typeof redirectedTo>;
    try {
      said = redirectedTo(address, attempt.state);
    } catch (error) {
      if (error instanceof Refused) return refuse(`${sentence(error.message)} Copy the whole address your browser ended on, or start again.`, "address");
      throw error;
    }
    if ("error" in said) refuse(said.error === "access_denied" ? `You did not allow it at ${client.name}. Start it again.` : `${client.name} did not sign you in. Start it again.`);
    const typed = attempt.client.client_id === undefined ? undefined : { client_id: attempt.client.client_id, client_secret: attempt.client.client_secret! };
    const keys = typed ?? heldKeys(ctx, vault, client.id) ?? refuse(`Type your ${client.name} client again: start the sign-in again.`, "client_id");
    const grant: ClientGrant = { verifier: attempt.verifier, state: attempt.state, redirect: attempt.redirect };
    let answered = false;
    try {
      const credential = await asking(connector, () => clientExchange({ ...client, ...keys }, grant, said.code, client.name, { now: ctx.now, signal }));
      answered = true;
      const kept = typed === undefined ? undefined : { id: client.id, value: JSON.stringify(typed) };
      const done = { state: "signed_in" as const, ...await signIn(ctx, { connector, route, check, vault, signal }, { fields: {}, credential: credentialText(credential), ...(kept === undefined ? {} : { client: kept }) }) };
      catches.spend(attempt.state, `${connectorName(connector)} is signed in by this sign-in already.`);
      return done;
    } catch (error) {
      const refusal = error instanceof SignInRefused || error instanceof VerbError || error instanceof SecretError;
      if (!answered && (!refusal || (error as Error).message === unanswered(connector))) throw error;
      if (!refusal) {
        catches.spend(attempt.state, "This sign-in ended. Start it again.");
        throw error;
      }
      const words = startAgain(error.message);
      catches.spend(attempt.state, words);
      return refuse(words, error instanceof SignInRefused ? error.field : undefined);
    }
  });
}

function startAgain(words: string): string {
  return `${sentence(words.replace(/\s*(?:Try|Start) (?:it )?again[^.]*\.$/u, ""))} Start it again.`;
}

async function clientOf(ctx: VerbContext, connector: Connector, route: Extract<SignIn, { way: "client" }>): Promise<Client> {
  const { clients } = await ctx.registry();
  return clients?.find((each) => each.id === route.client) ?? refuse(`${connectorName(connector)} signs in with a client this release does not declare.`);
}

function keysTyped(client: Client, typed: JsonObject): ClientKeys {
  const part = (name: keyof ClientKeys, words: string): string => {
    const value = typed[name];
    return typeof value === "string" && value.trim() !== "" ? value.trim() : refuse(`Type your ${client.name} ${words}.`, name);
  };
  return { client_id: part("client_id", "client ID"), client_secret: part("client_secret", "client secret") };
}

function heldKeys(ctx: VerbContext, vault: Sealing, id: string): ClientKeys | undefined {
  const name = heldClients(ctx)[id];
  const sealed = name === undefined ? undefined : vault.read(name);
  if (sealed === undefined) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(sealed);
  } catch {
    return undefined;
  }
  return isObject(value) && typeof value.client_id === "string" && typeof value.client_secret === "string" ? { client_id: value.client_id, client_secret: value.client_secret } : undefined;
}

function heldClients(ctx: VerbContext): Readonly<Record<string, string>> {
  return effective(ctx.folder).settings.clients;
}

function attemptOf(held: unknown, client: Client): ClientAttempt | undefined {
  if (!isObject(held) || !isObject(held.client) || held.client.id !== client.id) return undefined;
  const { verifier, state, redirect, expires_ms } = held;
  if (typeof verifier !== "string" || typeof state !== "string" || typeof redirect !== "string" || !LOOPBACK.test(redirect) || typeof expires_ms !== "number") return undefined;
  const { client_id, client_secret } = held.client;
  const typed = typeof client_id === "string" && typeof client_secret === "string" ? { client_id, client_secret } : undefined;
  if (typed === undefined && (client_id !== undefined || client_secret !== undefined)) return undefined;
  return { client: { id: client.id, ...typed }, verifier, state, redirect, expires_ms };
}

export async function declaredCheck(connector: Connector, check: Check, field: string, credential: string, signal: AbortSignal): Promise<{ account?: string; credential: string }> {
  const name = connectorName(connector);
  const token = credential.trim();
  if (/[^\x20-\x7e]/u.test(token)) refuse(`Type your ${labelOf(connector, field)} again: it holds a character that cannot be sent.`, field);
  const asked = checkAddress(check, token);
  if ("refused" in asked && check.url !== CREDENTIAL) refuse(`${name}'s connector declares a check address Lifestream does not ask.`);
  if ("refused" in asked) refuse(asked.refused === "address" ? `Type your ${labelOf(connector, field)} again: it is an address starting https://.` : `Type your ${labelOf(connector, field)} again, with no name or password before its address.`, field);
  const headers = { ...(asked.bearer ? { authorization: `Bearer ${token}` } : {}), accept: check.account === undefined ? "*/*" : "application/json", "user-agent": "lifestream-home" };
  const response = await fetch(asked.url, { method: "GET", headers, redirect: "manual", signal });
  const bytes = await cappedBody(response, `${name}'s check`);
  if (response.status >= 300 && response.status < 400) {
    if (asked.bearer) refuse(`${name} answered the check by sending it to another address, which Lifestream does not follow.`);
    refuse(`Type your ${labelOf(connector, field)} again: ${name} sends it on to another address, which Lifestream does not follow.`, field);
  }
  if (response.status === 401) throw new NeedsYou("signed-out", `${name} refused the credential`);
  if (response.status === 403 && check.forbidden !== undefined) refuse(check.forbidden);
  if (!response.ok) refuse(`${name} answered the check with HTTP ${response.status}. Try again in a moment.`);
  if (check.account === undefined) return { credential: token };
  let body: unknown;
  try {
    body = JSON.parse(bytes.toString("utf8"));
  } catch {
    body = undefined;
  }
  const stated = check.account.split(".").reduce<unknown>((at, member) => (isObject(at) ? at[member] : undefined), body);
  if (typeof stated !== "string" || stated.trim() === "") refuse(`${name} did not say whose account this is.`);
  return { account: stated, credential: token };
}

interface Signing {
  connector: Connector;
  route: SignIn;
  check: SignedIn;
  vault: Sealing;
  signal: AbortSignal;
}

interface Typed {
  fields: Readonly<Record<string, string>>;
  credential: string;
  client?: { id: string; value: string };
}

async function signIn(ctx: VerbContext, { connector, route, check, vault, signal }: Signing, typed: Typed): Promise<SignedInAs> {
  const name = connectorName(connector);
  const field = accountField(connector) ?? refuse(`${name} has no account to sign in to.`);
  const kept = blockOf(ctx.folder, connector.id);
  const secretField = secretFieldOf(connector, route);
  const sets = [ROUTE, ...Object.keys(typed.fields)];
  const block = { ...kept, ...typed.fields, [ROUTE]: routeId(route) };
  planned(ctx.folder, connector, block, sets);
  const fields = connectorSettings(connector, block).fields;
  for (const [member, declared] of Object.entries(connector.fields ?? {})) if (declared.kind === "zone" && fields[member] === undefined) fields[member] = ctx.settings.day.zone;
  const row = route.way === "key" ? { name: secretField, label: labelOf(connector, secretField) } : undefined;
  const checked = await asking(connector, () => check({ fields, credential: typed.credential, signal }, HOME_DEPENDENCIES), row, route.refused);
  const stated = checked.account === undefined ? undefined : accountOf(connector, field, checked.account);
  const own = typed.fields[field] === undefined ? undefined : accountOf(connector, field, typed.fields[field]);
  if (stated !== undefined && own !== undefined && stated.toLowerCase() !== own.toLowerCase()) {
    refuse(`That ${labelOf(connector, secretField)} is ${stated}'s, not ${own}'s.`, field);
  }
  const account = stated ?? own ?? refuse(`${name} did not say whose account this is.`);
  const fresh = await freshName(ctx, declaredOf(connector, secretField), vault, await namedBy(ctx, connector, connectorSettings(connector, kept).fields));
  const client = typed.client === undefined ? undefined : { ...typed.client, fresh: await freshName(ctx, clientSecret(typed.client.id), vault, Object.values(heldClients(ctx))) };
  const next: JsonObject = { ...block, [field]: account, [secretField]: fresh };
  for (const other of connector.signin ?? []) if (secretFieldOf(connector, other) !== secretField) delete next[secretFieldOf(connector, other)];
  const retired = retiredOf(connector, kept, vault);
  for (const member of Object.keys(retired)) delete next[member];
  const plan = planned(ctx.folder, connector, next, [...sets, field, secretField], client === undefined ? {} : { [`clients.${client.id}`]: client.fresh });
  if (signal.aborted) refuse(unanswered(connector));
  if (client !== undefined) sealUnder(ctx, clientSecret(client.id), client.fresh, client.value, vault);
  sealUnder(ctx, declaredOf(connector, secretField), fresh, checked.credential, vault);
  const running = plan.write();
  ctx.settingsChanged?.();
  await settled(ctx, connector, kept, running.fields, [route.acquirer], vault, route.way === "client" ? [route.client] : [], Object.values(retired));
  return { account, source: sourceOf(connector, route.acquirer, account) };
}

function retiredOf(connector: Connector, kept: JsonObject, vault: Sealing): Record<string, string> {
  const declared = new Set(connectorSettings(connector, kept).members.map((each) => each.member));
  const held = new Set(vault.names());
  return Object.fromEntries(Object.entries(kept).flatMap(([member, value]) => (!declared.has(member) && typeof value === "string" && held.has(value) ? [[member, value]] : [])));
}

export function sealField(ctx: VerbContext, request: JsonObject, vault: Sealing, within_ms = SIGNIN_MS): Promise<{ sealed: true } | SignInRefusal> {
  return answering(ctx, within_ms, async () => {
    vault.sealable();
    const { connectors } = await ctx.registry();
    const connector = connectors.find((each) => each.id === request.connector) ?? refuse(`This release has no connector ${String(request.connector)}.`);
    const member = typeof request.member === "string" ? request.member : "";
    if (connector.fields?.[member]?.kind !== "secret") refuse(`${connectorName(connector)} has no secret ${member} to type.`);
    if (signinSets(connector).has(member)) refuse(`${connectorName(connector)}'s ${labelOf(connector, member)} is set by signing in.`, member);
    const value = request.value;
    if (typeof value !== "string" || value.trim() === "") return refuse(`Type your ${labelOf(connector, member)}.`, member);
    const kept = blockOf(ctx.folder, connector.id);
    const fresh = await freshName(ctx, declaredOf(connector, member), vault, await namedBy(ctx, connector, connectorSettings(connector, kept).fields));
    const block = { ...kept, [member]: fresh };
    const plan = planned(ctx.folder, connector, block, [member]);
    sealUnder(ctx, declaredOf(connector, member), fresh, value, vault);
    const running = plan.write();
    ctx.settingsChanged?.();
    await settled(ctx, connector, kept, running.fields, runningOf(connector, block), vault);
    return { sealed: true as const };
  });
}

async function namedBy(ctx: VerbContext, connector: Connector, fields: JsonObject): Promise<Set<string>> {
  const { connectors } = await ctx.registry();
  const blocks = connectors.flatMap((each) => secretsOf(each, each.id === connector.id ? fields : connectorSettings(each, ctx.settings.connectors[each.id]).fields));
  return new Set([...blocks, ...Object.values(heldClients(ctx))]);
}

function declaredOf(connector: Connector, member: string): string {
  return (connector.fields![member] as { secret: string }).secret;
}

const clientSecret = (id: string): string => `client.${id}`;

async function freshName(ctx: VerbContext, declared: string, vault: Sealing, named: Iterable<string>): Promise<string> {
  const view = ctx.db.view();
  let issued: number;
  try {
    issued = Number(view.tables.meta.get(`${GENERATION}${declared}`) ?? 0);
  } finally {
    view.close();
  }
  const names = [...vault.names(), ...named];
  return `${declared}.${Math.max(issued, ...names.map((each) => generationOf(declared, each) ?? 0)) + 1}`;
}

function sealUnder(ctx: VerbContext, declared: string, fresh: string, value: string, vault: Sealing): void {
  ctx.db.commit((tx) => tx.tables.meta.set(`${GENERATION}${declared}`, String(generationOf(declared, fresh))));
  vault.seal(fresh, value);
  failpoint("signin.sealed");
}

async function settled(ctx: VerbContext, connector: Connector, kept: JsonObject, fields: JsonObject, acquirers: readonly string[], vault: Sealing, clients: readonly string[] = [], retired: readonly string[] = []): Promise<void> {
  const registry = await ctx.registry();
  const named = await namedBy(ctx, connector, fields);
  const superseded = new Set([...secretsOf(connector, connectorSettings(connector, kept).fields), ...retired]);
  const ofClient = (name: string) => clients.some((id) => name === clientSecret(id) || generationOf(clientSecret(id), name) !== null);
  for (const each of vault.names().filter((name) => superseded.has(name) || ours(connector, name) || ofClient(name))) if (!named.has(each)) vault.remove(each);
  const now = ctx.now();
  ctx.db.commit((tx) => {
    const paused = new Set(tx.tables.controls.list().map((control) => control.target));
    for (const acquirer of acquirers) {
      if (tx.tables.polls.get(acquirer) === undefined) continue;
      needsMet(tx, outcomesOf(tx.tables, acquirer, (each) => each.reason === "signed-out" || each.reason === "password"), now);
      queuePoll(tx, registry.connectors, acquirer, now, paused, ["fetch"]);
    }
  });
}

function secretsOf(connector: Connector, fields: JsonObject): string[] {
  return Object.entries(connector.fields ?? {}).flatMap(([member, field]) => (field.kind === "secret" && typeof fields[member] === "string" ? [fields[member] as string] : []));
}

function ours(connector: Connector, name: string): boolean {
  return Object.values(connector.fields ?? {}).some((field) => field.kind === "secret" && (name === field.secret || generationOf(field.secret, name) !== null));
}

function generationOf(declared: string, name: string): number | null {
  const n = name.startsWith(`${declared}.`) ? name.slice(declared.length + 1) : "";
  return /^[1-9]\d*$/u.test(n) ? Number(n) : null;
}

function planned(folder: HomeFolder, connector: Connector, block: JsonObject, sets: readonly string[], also: JsonObject = {}): ReturnType<typeof plannedBlock> {
  try {
    return plannedBlock(folder, connector, block, sets, {}, [], also);
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    const member = sets.find((each) => error.message.startsWith(`connectors.${connector.id}.${each} `));
    if (member === undefined || member === ROUTE) throw error;
    return refuse(`Type your ${labelOf(connector, member)}.`, member);
  }
}

async function asking<T>(connector: Connector, call: () => Promise<T>, row?: { name: string; label: string }, refused?: string): Promise<T> {
  const name = connectorName(connector);
  try {
    return await call();
  } catch (error) {
    if (error instanceof NeedsYou) return refuse(row === undefined ? `${name} did not accept the sign-in. Start it again.` : refused ?? `${name} did not accept this ${row.label}.`, row?.name);
    if (error instanceof Refused) return refuse(sentence(error.message.replace(/^[\w-]+: /u, "").replace(/^https?:\/\/[^\s']+/u, name)));
    if (notAnswered(error)) return refuse(unanswered(connector));
    throw error;
  }
}

function notAnswered(error: unknown): boolean {
  return (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) || offline(error);
}

function accountOf(connector: Connector, field: string, value: string): string {
  if (connector.fields?.[field]?.kind !== "email") return value.trim();
  try {
    return accountName(value);
  } catch (error) {
    if (error instanceof SourceNameError) return refuse(`Type your ${labelOf(connector, field)}.`, field);
    throw error;
  }
}

function sourceOf(connector: Connector, acquirer: string, account: string): string {
  const source = connector.sources.find((each) => each.read === acquirer || (each.feeders ?? []).includes(acquirer)) ?? connector.sources[0]!;
  return source.id.replace("<account>", account);
}

function labelOf(connector: Connector, field: string): string {
  return wordOf(connector, connector.fields?.[field]?.label ?? field);
}

function wordOf(connector: Connector, label: string): string {
  const first = label.split(" ")[0]!;
  return first === first.toUpperCase() || first === connectorName(connector).split(" ")[0] ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
}

const sentence = (words: string): string => `${words.charAt(0).toUpperCase()}${words.slice(1)}${/[.!?]$/u.test(words) ? "" : "."}`;
