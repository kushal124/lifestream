import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { civilDay, homeSecrets, type JsonObject } from "@lifestreamprotocol/core";
import type { Home, HomeOptions } from "./home.js";
import { ask, askHome, type HomeSocket } from "./socket.js";
import type { ConnectorReport, StreamsReport } from "./streams-report.js";
import { FAKE_FILE } from "./test/signin-registry.js";
import { openWith, readVault, recoveryKey } from "./vault.js";
import { artifact, ChildHome, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { homeWithDoor } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";

const { fakeGranola } = (await import(new URL("../connect/notes/granola/test/fake.ts", import.meta.url).href)) as typeof import("../connect/notes/granola/test/fake.js");
type FakeGranola = ReturnType<typeof fakeGranola>;
const { fakeGmail, mail } = (await import(new URL("../connect/mail/gmail/test/fake.ts", import.meta.url).href)) as typeof import("../connect/mail/gmail/test/fake.js");
type FakeGmail = ReturnType<typeof fakeGmail>;
type Folder = import("../connect/mail/gmail/test/fake.js").Folder;

const REGISTRY = fileURLToPath(new URL("./test/signin-registry.ts", import.meta.url));
const ALL_MAIL = "[Gmail]/All Mail";
const ACCOUNT_A = "person-a@example.com";
const ACCOUNT_B = "person-b@example.com";
const KEY_A = "grn_synthetic_0001";
const KEY_B = "grn_synthetic_bb07";
const SOURCE_A = `granola:${ACCOUNT_A}:cloud`;
const SOURCE_B = `granola:${ACCOUNT_B}:cloud`;
const TOKENS: Readonly<Record<string, string>> = { ghp_synthetic_a: "person-a", ghp_synthetic_b: "person-b" };

class Providers {
  readonly worlds: { a: FakeGranola; b: FakeGranola };
  readonly #keys: Readonly<Record<string, FakeGranola>>;
  readonly #codes = new Map<string, "pending" | "denied" | "expired" | FakeGranola>();
  onApi: ((key: string | null) => void) | undefined;
  readonly api: string[] = [];
  readonly auth: string[] = [];
  delay_ms = 0;
  registration_closed = false;
  github_status: number | undefined;
  expires_in = 21_600;
  readonly inbox: Folder = { uidValidity: 77, uidNext: 1, messages: [], specialUse: "\\All" };
  readonly gmail: FakeGmail = fakeGmail({ [ALL_MAIL]: this.inbox });
  #refreshes = 0;
  #held: { at: number; reach: () => void; released: Promise<void> } | undefined;
  #serial = 0;
  readonly #server = createServer((request, response) => void this.#answer(request, response));
  url = "";

  constructor() {
    this.worlds = { a: fakeGranola(ACCOUNT_A, KEY_A), b: fakeGranola(ACCOUNT_B, KEY_B) };
    for (const world of Object.values(this.worlds)) world.clock = Date.now();
    this.#keys = { [KEY_A]: this.worlds.a, [KEY_B]: this.worlds.b };
  }

  async #imap({ op, args, session }: { op: string; args: unknown[]; session: { account: string; password: string } }): Promise<JsonObject> {
    const client = this.gmail.client;
    try {
      switch (op) {
        case "connect":
          await (await this.gmail.imap({ host: "imap.gmail.com", port: 993, ...session })).connect();
          return {};
        case "logout":
          await client.logout();
          return {};
        case "close":
          client.close();
          return {};
        case "list":
          return { value: [...(await client.list())] as unknown as JsonObject[] };
        case "mailboxOpen": {
          const opened = await client.mailboxOpen(args[0] as string, { readOnly: true });
          return { value: { uidValidity: Number(opened.uidValidity), uidNext: opened.uidNext } };
        }
        case "search": {
          const query = args[0] as { uid: string; since?: string };
          const found = await client.search({ uid: query.uid, ...(query.since === undefined ? {} : { since: new Date(query.since) }) }, { uid: true });
          return { value: found };
        }
        case "fetch": {
          const messages: JsonObject[] = [];
          for await (const message of client.fetch(args[0] as string, args[1] as never, { uid: true })) {
            messages.push(JSON.parse(JSON.stringify({ ...message, labels: message.labels === undefined ? undefined : [...message.labels], internalDate: message.internalDate?.toISOString(), source: message.source?.toString("base64") })) as JsonObject);
          }
          return { value: messages };
        }
        default:
          throw new Error(`no IMAP call ${op}`);
      }
    } catch (error) {
      const members = Object.fromEntries(["authenticationFailed", "serverResponseCode", "response", "responseStatus", "responseText", "code"].flatMap((name) => (name in (error as object) ? [[name, (error as Record<string, unknown>)[name]]] : [])));
      return { error: { message: (error as Error).message, members: JSON.parse(JSON.stringify(members)) as JsonObject } };
    }
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return port;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  answer(device_code: string, with_: "denied" | "expired" | FakeGranola): void {
    this.#codes.set(device_code, with_);
  }

  hold(at: number): { reached: () => boolean; release: () => void } {
    this.#refreshes = 0;
    let release!: () => void;
    let arrived = false;
    const released = new Promise<void>((resolve) => { release = resolve; });
    this.#held = { at, reach: () => { arrived = true; }, released };
    return { reached: () => arrived, release };
  }

  #tokens(world: FakeGranola): { access_token: string; refresh_token: string; token_type: string; expires_in: number } {
    const access = `access-signin-${++this.#serial}`;
    world.access.set(access, world.clock + this.expires_in * 1000);
    world.refresh = `refresh-signin-${this.#serial}`;
    return { access_token: access, refresh_token: world.refresh, token_type: "Bearer", expires_in: this.expires_in };
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", this.url);
    const headers = new Headers(Object.entries(request.headers).flatMap(([name, value]) => (typeof value === "string" ? [[name, value] as [string, string]] : [])));
    const send = async (answer: Response) => {
      const bytes = Buffer.from(await answer.arrayBuffer());
      response.writeHead(answer.status, Object.fromEntries([...answer.headers].filter(([name]) => name === "content-type" || name === "mcp-session-id")));
      response.end(bytes);
    };
    const json = (value: unknown, status = 200) => send(new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } }));
    const form = new URLSearchParams(body);
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname.startsWith("/oauth/")) {
      this.auth.push(url.pathname);
      if (this.delay_ms > 0) await new Promise((resolve) => setTimeout(resolve, this.delay_ms));
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return json({ issuer: this.url, token_endpoint: `${this.url}/oauth/token`, registration_endpoint: `${this.url}/oauth/register`, device_authorization_endpoint: `${this.url}/oauth/device` });
    }
    if (url.pathname === "/oauth/register") {
      const redirects = (JSON.parse(body) as { redirect_uris?: unknown }).redirect_uris;
      if (!Array.isArray(redirects) || redirects.length === 0 || this.registration_closed) return json({ error: "invalid_client_metadata", error_description: "redirect_uris must be an array" }, 400);
      return json({ client_id: `client-synthetic-${++this.#serial}`, token_endpoint_auth_method: "none" }, 201);
    }
    if (url.pathname === "/oauth/device") {
      const code = `device-synthetic-${++this.#serial}`;
      this.#codes.set(code, "pending");
      return json({ device_code: code, user_code: "SYNT-HETC", verification_uri: `${this.url}/activate`, expires_in: 300, interval: 5 });
    }
    if (url.pathname === "/oauth/token" && form.get("grant_type") === "refresh_token") {
      const world = Object.values(this.worlds).find((each) => each.refresh === form.get("refresh_token"));
      if (world === undefined) return json({ error: "invalid_grant" }, 400);
      const held = this.#held;
      if (held !== undefined && ++this.#refreshes === held.at) {
        held.reach();
        await held.released;
      }
      return json(this.#tokens(world));
    }
    if (url.pathname === "/oauth/token") {
      const state = this.#codes.get(form.get("device_code") ?? "");
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:device_code" || state === undefined) return json({ error: "invalid_grant" }, 400);
      if (state === "pending") return json({ error: "authorization_pending" }, 400);
      if (state === "denied") return json({ error: "access_denied" }, 400);
      if (state === "expired") return json({ error: "expired_token" }, 400);
      return json(this.#tokens(state));
    }
    if (url.pathname === "/mcp") {
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /u, "");
      const world = Object.values(this.worlds).find((each) => each.access.has(token)) ?? this.worlds.a;
      return send(await world.fetch("https://mcp.granola.ai/mcp", { method: "POST", headers, body }));
    }
    if (url.pathname.startsWith("/api/")) {
      const path = `${url.pathname.slice("/api".length)}${url.search}`;
      this.api.push(path);
      this.onApi?.(headers.get("authorization"));
      const key = (headers.get("authorization") ?? "").replace(/^Bearer /u, "");
      const world = this.#keys[key];
      if (world === undefined) return json({ message: `Unauthorized: ${key}` }, 401);
      return send(await world.fetch(`https://public-api.granola.ai${path}`, { headers }));
    }
    if (url.pathname === "/imap") return json(await this.#imap(JSON.parse(body) as never));
    if (url.pathname === "/github/user") {
      const token = (headers.get("authorization") ?? "").replace(/^Bearer /u, "");
      if (this.github_status !== undefined) return json({ message: `API rate limit exceeded for ${token}` }, this.github_status);
      const login = TOKENS[token];
      return login === undefined ? json({ message: `Bad credentials: ${token}` }, 401) : json({ login, id: 1, node_id: "U_synthetic" });
    }
    return json({ error: "not_found" }, 404);
  }
}

const startOn = (root: string, slot: Buffer | null, more: Partial<HomeOptions> = {}) => homeWithDoor(root, { registry: REGISTRY, slot, tickMs: TICK_MS, log: () => undefined, ...more });

async function open(prefix: string, clocks: boolean, options: Partial<HomeOptions> = {}) {
  const fake = new Providers();
  const root = makeRoot(prefix, { sources: {}, clocks });
  writeFileSync(join(root, FAKE_FILE), JSON.stringify({ port: await fake.start() }));
  let home: Home | null = null;
  onTestFinished(async () => {
    await home?.stop();
    await fake.close();
    removeRoot(root);
  });
  home = await startOn(root, null, options);
  const sock = testSocket(root);
  const slot = randomBytes(32);
  const made = (await ask(sock, { verb: "vault-init", slot_key: slot.toString("base64"), store: "keychain-login" })) as { recovery: string };
  await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
  const vault = openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery))!.key;
  const stop = async () => {
    await home?.stop();
    home = null;
  };
  const restart = async (handed: Buffer | null = slot) => {
    await stop();
    home = await startOn(root, handed, options);
    return home;
  };
  return { root, sock, home, fake, vault, slot, stop, restart };
}

function config(root: string): Record<string, string> {
  const each = (dir: string): [string, string][] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? each(join(dir, entry.name)) : [[join(dir, entry.name), readFileSync(join(dir, entry.name), "base64")] as [string, string]]);
  return Object.fromEntries(each(join(root, "config")));
}

const blockOf = (root: string, id: string): JsonObject | undefined => (JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as Record<string, JsonObject>)[`connectors.${id}`];
const secretsOf = (root: string, vault: Buffer) => homeSecrets(join(root, "config", "secrets"), { key: vault });
const names = (root: string, vault: Buffer) => secretsOf(root, vault).list().map((each) => each.name);
const SIGNED_OUT_API = { state: "needs-you", reason: "signed-out", words: "Sign in to Granola again", acts: [{ do: "signin", label: "Sign in", of: "granola-api" }] };
const connectorRow = async (sock: HomeSocket, id: string): Promise<ConnectorReport> => ((await askHome(sock, "connectors")) as StreamsReport).connectors.find((each) => each.id === id)!;
const pollJob = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = ?").pluck().get(acquirer)) as string | undefined;
const pollRow = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT c.state, c.source FROM polls p LEFT JOIN poll_cursors c USING (acquirer) WHERE p.acquirer = ?").get(acquirer)) as
  { state: string | null; source: string | null } | undefined;
const cursorRow = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT state, source FROM poll_cursors WHERE acquirer = ?").get(acquirer)) as { state: string; source: string } | undefined;
const fetchNeed = (acquirer: string) => (need: { id: string }): boolean => need.id === `fetch:${acquirer}` || need.id.startsWith(`fetch:${acquirer}:`);
const fetchSaid = (root: string, acquirer: string) => readHome(root, (db) => db.prepare("SELECT outcome, reason, detail FROM attempts WHERE target = ? ORDER BY at_ms DESC LIMIT 1").get(`fetch:${acquirer}`)) as
  { outcome: string; reason: string | null; detail: string | null } | undefined;
const queuedOf = (root: string, acquirer: string): string[] => {
  const kept = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(`poll-queued:${acquirer}`)) as string | undefined;
  return kept === undefined ? [] : JSON.parse(kept) as string[];
};
const okOf = (root: string, acquirer: string, call: "fetch" | "page" = "fetch") => readHome(root, (db) => db.prepare("SELECT max(at_ms) FROM attempts WHERE target = ? AND outcome = 'ok'").pluck().get(`${call}:${acquirer}`)) as number | null;
const parkedOf = (root: string, acquirer: string): { paged_ms: number | null; state: unknown; source: string | null } | undefined => {
  const kept = readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(`poll-parked:${acquirer}`)) as string | undefined;
  if (kept === undefined) return undefined;
  const cursor = cursorRow(root, acquirer);
  return { ...(JSON.parse(kept) as { paged_ms: number | null }), state: cursor === undefined ? null : JSON.parse(cursor.state) as unknown, source: cursor?.source ?? null };
};
const keptOf = (root: string, acquirer: string): { state: unknown; source: string } | undefined => {
  const cursor = cursorRow(root, acquirer);
  return cursor === undefined ? undefined : { state: JSON.parse(cursor.state) as unknown, source: cursor.source };
};
const cursorOf = (root: string): number | undefined => (keptOf(root, "granola-api")?.state as { cursor_ms?: number } | undefined)?.cursor_ms;
const firstListed = (world: FakeGranola): unknown => world.toolCalls.find((call) => call.name === "list_meetings")?.arguments.from_date;
const EPOCH = new Date(0).toISOString();
const polledAs = (root: string, acquirer: string, source: string, since: number) => {
  const row = pollRow(root, acquirer);
  return row?.source === source && ((okOf(root, acquirer) ?? 0) >= since || (okOf(root, acquirer, "page") ?? 0) >= since);
};

const apiSignIn = (sock: HomeSocket, values: JsonObject) => ask(sock, { verb: "account-connect", connector: "granola", route: "granola-api", values });

async function deviceSignIn(sock: HomeSocket, fake: Providers, world: FakeGranola | "denied" | "expired"): Promise<JsonObject> {
  const route = { connector: "granola", route: "granola-mcp" };
  const started = (await ask(sock, { verb: "device-start", ...route })) as { attempt: { device_code: string }; interval_ms: number };
  fake.answer(started.attempt.device_code, world);
  return (await ask(sock, { verb: "device-poll", ...route, attempt: started.attempt, interval_ms: started.interval_ms })) as JsonObject;
}

describe("a connector's declared sign-in: each of these is impossible", () => {
  it("a key sign-in Granola refuses seals or writes anything; its check runs after a seal or from anything but the declaration; GitHub's token of another login connects", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-key-", false);
    const before = config(root);
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: "grn_synthetic_revoked" })).toEqual({ refused: "Granola did not accept this API key.", field: "key" });
    expect(await apiSignIn(sock, { account: " ", key: KEY_A })).toEqual({ refused: "Type your Granola email.", field: "account" });
    expect(await apiSignIn(sock, { account: "not-an-email", key: KEY_A })).toEqual({ refused: "Type your Granola email.", field: "account" });
    expect(config(root)).toEqual(before);

    const checked: { key: string | null; sealed: string[] }[] = [];
    fake.onApi = (key) => checked.push({ key, sealed: names(root, vault) });
    const accepted = await apiSignIn(sock, { account: " Person-A@Example.com ", key: ` ${KEY_A}\n` });
    expect(accepted).toEqual({ account: ACCOUNT_A, source: SOURCE_A });
    expect(checked).toEqual([{ key: `Bearer ${KEY_A}`, sealed: [] }]);
    expect(fake.api).toEqual(["/v1/notes?page_size=1", "/v1/notes?page_size=1"]);
    expect([names(root, vault), secretsOf(root, vault).get("granola.1")]).toEqual([["granola.1"], KEY_A]);
    expect(blockOf(root, "granola")).toEqual({ account: ACCOUNT_A, route: "granola-api", key: "granola.1" });

    const github = (values: JsonObject) => ask(sock, { verb: "account-connect", connector: "github", route: "github-api", values });
    expect(await github({ login: "person-a", token: "ghp_synthetic_b" })).toEqual({ refused: "That token is person-b's, not person-a's.", field: "login" });
    expect(await github({ login: "person-a", token: "ghp_synthetic_revoked" })).toEqual({ refused: "GitHub refused this token. Check it reads Contents, Issues and Pull requests, then paste it again.", field: "token" });
    expect([blockOf(root, "github"), names(root, vault)]).toEqual([undefined, ["granola.1"]]);
    expect(await github({ login: "Person-A", token: "ghp_synthetic_a" })).toEqual({ account: "person-a", source: "github:person-a:cloud" });
    expect([blockOf(root, "github"), secretsOf(root, vault).get("github.1")]).toEqual([{ login: "person-a", route: "github-api", token: "github.1" }, "ghp_synthetic_a"]);
    await expect(askHome(sock, "connectors", ["set", "granola", "route", "granola-mcp"])).rejects.toThrow(/written by its sign-in alone/u);

    const [granolaRow, githubRow] = [await connectorRow(sock, "granola"), await connectorRow(sock, "github")];
    expect([granolaRow.route, granolaRow.routes.map((route) => [route.acquirer, route.way, route.fields, route.sets])]).toEqual(["granola-api", [["granola-mcp", "device", [], ["account", "signin"]], ["granola-api", "key", ["account", "key"], ["account", "key"]]]]);
    expect([githubRow.route, githubRow.routes]).toEqual(["github-api", [{ id: "github-api", acquirer: "github-api", way: "key", label: "Use an access token", steps: [expect.objectContaining({ title: "Make a token" })], note: "Reads only; the token can change nothing.", fields: ["login", "token"], sets: ["login", "token"], client: null }]]);
    artifact(root, "signin-key", { granola: { route: granolaRow.route, routes: granolaRow.routes }, github: { route: githubRow.route, routes: githubRow.routes } });
  });

  it("a device sign-in denied, expired or failing after its token exchange writes anything; one approved seals other than one JSON secret or writes another account", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-device-", false);
    const before = config(root);
    const route = { connector: "granola", route: "granola-mcp" };
    fake.registration_closed = true;
    expect(await ask(sock, { verb: "device-start", ...route })).toEqual({ refused: "Granola refused to register a client (HTTP 400, invalid_client_metadata)." });
    fake.registration_closed = false;
    const started = (await ask(sock, { verb: "device-start", ...route })) as { code: string; open: string; interval_ms: number; expires_ms: number; attempt: { client_id: string; device_code: string } };
    expect(started).toEqual({ code: "SYNT-HETC", open: `${fake.url}/activate`, interval_ms: 5_000, expires_ms: expect.any(Number), attempt: { client_id: expect.stringMatching(/^client-synthetic-/u), device_code: expect.stringMatching(/^device-synthetic-/u) } });
    expect(await ask(sock, { verb: "device-poll", ...route, attempt: started.attempt, interval_ms: started.interval_ms })).toEqual({ state: "pending", interval_ms: 5_000 });
    expect(await deviceSignIn(sock, fake, "denied")).toEqual({ state: "denied" });
    expect(await deviceSignIn(sock, fake, "expired")).toEqual({ state: "expired" });
    expect(config(root)).toEqual(before);
    fake.worlds.b.mcpAccount = "nobody";
    expect(await deviceSignIn(sock, fake, fake.worlds.b)).toEqual({ refused: expect.stringMatching(/states no email/u) });
    expect(config(root)).toEqual(before);

    expect(await deviceSignIn(sock, fake, fake.worlds.a)).toEqual({ state: "signed_in", account: ACCOUNT_A, source: SOURCE_A });
    expect(names(root, vault)).toEqual(["granola.signin.1"]);
    expect(JSON.parse(secretsOf(root, vault).get("granola.signin.1")!)).toEqual({
      client_id: expect.stringMatching(/^client-synthetic-/u), refresh_token: fake.worlds.a.refresh, access_token: expect.stringMatching(/^access-signin-/u), expires_ms: expect.any(Number),
    });
    expect(blockOf(root, "granola")).toEqual({ route: "granola-mcp", account: ACCOUNT_A, signin: "granola.signin.1" });
    artifact(root, "signin-device", { started: { ...started, attempt: "held by the sheet" }, block: blockOf(root, "granola") });
  });

  it("the route not running is built, polls or holds a need, draws Pace or a backfill status; switching routes loses a cursor or keeps another route's credential; another account's history is read from anywhere but the start; an earlier account loses its parked cursor", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-switch-", true);
    fake.worlds.a.note({ title: "Synthetic planning" });
    fake.worlds.b.note({ title: "Synthetic review" });

    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("A's API poll worked", () => okOf(root, "granola-api") !== null);
    const apiFirst = cursorOf(root)!;
    expect(pollRow(root, "granola-api")?.source).toBe(SOURCE_A);
    fake.worlds.a.revoked = true;
    await askHome(sock, "connectors", ["set", "granola", "refresh", "1m"]);
    await until("A's API poll needs the person", () => fetchSaid(root, "granola-api")?.outcome === "need");
    expect(((await askHome(sock, "connectors")) as StreamsReport).needs.find(fetchNeed("granola-api"))).toMatchObject(SIGNED_OUT_API);

    expect(await deviceSignIn(sock, fake, fake.worlds.a)).toMatchObject({ state: "signed_in", account: ACCOUNT_A });
    await until("the API route's last run ended", () => ["done", undefined].includes(pollJob(root, "granola-api")));
    const asked = fake.api.length;
    expect([blockOf(root, "granola"), names(root, vault)]).toEqual([{ route: "granola-mcp", account: ACCOUNT_A, signin: "granola.signin.1", refresh: "1m" }, ["granola.signin.1"]]);
    await until("A's MCP poll worked", () => okOf(root, "granola-mcp") !== null);
    const mcpA = keptOf(root, "granola-mcp")!;
    const onMcp = await connectorRow(sock, "granola");
    expect([firstListed(fake.worlds.a), pollRow(root, "granola-api"), cursorOf(root), parkedOf(root, "granola-api")?.source, fake.api.length]).toEqual([EPOCH, undefined, apiFirst, SOURCE_A, asked]);
    expect(((await askHome(sock, "connectors")) as StreamsReport).needs.filter(fetchNeed("granola-api"))).toEqual([]);
    expect([onMcp.route, onMcp.history, onMcp.members.find((each) => each.key === "pace")?.panel, onMcp.members.find((each) => each.key === "start")?.panel]).toEqual(["granola-mcp", null, null, "backfill"]);

    fake.worlds.a.revoked = false;
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("the API route runs again", () => pollRow(root, "granola-api") !== undefined);
    expect([cursorOf(root), keptOf(root, "granola-mcp"), pollRow(root, "granola-mcp")]).toEqual([apiFirst, mcpA, undefined]);
    const onApi = await connectorRow(sock, "granola");
    expect([onApi.route, onApi.members.find((each) => each.key === "pace")?.panel]).toEqual(["granola-api", "backfill"]);

    const toB = Date.now();
    expect(await deviceSignIn(sock, fake, fake.worlds.b)).toMatchObject({ state: "signed_in", account: ACCOUNT_B });
    expect([blockOf(root, "granola"), names(root, vault)]).toEqual([{ route: "granola-mcp", account: ACCOUNT_B, signin: "granola.signin.2", refresh: "1m" }, ["granola.signin.2"]]);
    await until("B's MCP poll worked", () => polledAs(root, "granola-mcp", SOURCE_B, toB));
    const mcpB = keptOf(root, "granola-mcp")!;
    expect([firstListed(fake.worlds.b), cursorOf(root), parkedOf(root, "granola-api")?.source]).toEqual([EPOCH, apiFirst, SOURCE_A]);

    const back = Date.now();
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("A's API poll ran again", () => polledAs(root, "granola-api", SOURCE_A, back));
    expect([cursorOf(root), keptOf(root, "granola-mcp")]).toEqual([apiFirst, mcpB]);

    const switched = Date.now();
    expect(await apiSignIn(sock, { account: ACCOUNT_B, key: KEY_B })).toEqual({ account: ACCOUNT_B, source: SOURCE_B });
    await until("B's API poll worked", () => polledAs(root, "granola-api", SOURCE_B, switched));
    expect(cursorOf(root)!).toBeGreaterThanOrEqual(switched);
    expect(keptOf(root, "granola-mcp")).toEqual(mcpB);
    artifact(root, "signin-switch", { api_first: apiFirst, mcp_a: mcpA, now: { api: pollRow(root, "granola-api"), mcp: parkedOf(root, "granola-mcp") }, api_requests: fake.api });
  });

  it("the journey: a device sign-in's first poll makes no source, the report shows another route running, or the day file lacks the meeting's line", async () => {
    const { root, sock, home, fake } = await open("lifestream-signin-journey-", true);
    const at = fake.worlds.a.clock;
    fake.worlds.a.note({ title: "Synthetic planning" });
    expect(await deviceSignIn(sock, fake, fake.worlds.a)).toEqual({ state: "signed_in", account: ACCOUNT_A, source: SOURCE_A });
    const day = civilDay(at, home.settings.day);
    const dayFile = join(root, "days", `${day}.day.txt`);
    await until("the source made from the first poll's facts", () => readHome(root, (db) => db.prepare("SELECT 1 FROM sources WHERE id = ?").get(SOURCE_A)) !== undefined);
    await until("the day prints the meeting", () => existsSync(dayFile) && readFileSync(dayFile, "utf8").includes("Synthetic planning"));
    const text = readFileSync(dayFile, "utf8");
    expect(text).toContain("Person B");
    const row = await connectorRow(sock, "granola");
    expect([row.route, row.copies.map((copy) => copy.id), pollRow(root, "granola-api"), okOf(root, "granola-mcp") !== null]).toEqual(["granola-mcp", [SOURCE_A], undefined, true]);
    const heads = readHome(root, (db) => db.prepare("SELECT kind, key, version FROM heads WHERE source = ? ORDER BY key").all(SOURCE_A));
    expect(heads).toHaveLength(1);
    artifact(root, "signin-journey", { heads, report: row });
    writeFileSync(join(root, "artifacts", "signin-journey.day.txt"), text);
  });

  it("a route signed out before its first poll worked holds no need, is worded for Chrome or sent to the extension; a sign-in again leaves its need, its failure or its wait", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-need-", true);
    fake.worlds.a.note({ title: "Synthetic planning" });
    await askHome(sock, "pause", ["pause:granola:history", "--reason", "the test holds the history"]);
    let requests = 0;
    fake.onApi = () => {
      if (++requests === 2) fake.worlds.a.revoked = true;
    };
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("the first poll needs the person", () => fetchSaid(root, "granola-api")?.outcome === "need");
    const report = (await askHome(sock, "connectors")) as StreamsReport;
    const row = report.connectors.find((each) => each.id === "granola")!;
    expect([okOf(root, "granola-api"), report.needs.find(fetchNeed("granola-api"))]).toEqual([null, expect.objectContaining(SIGNED_OUT_API)]);
    expect([row.set_up, row.health.state, row.health.words, row.health.acts]).toEqual([true, "needs-you", "Sign in to Granola again", SIGNED_OUT_API.acts]);

    await askHome(sock, "pause", ["poll:granola-api", "--reason", "the test holds the poll"]);
    await askHome(sock, "resume", ["pause:granola:history"]);
    await until("the clock queued the poll for its page", () => queuedOf(root, "granola-api").includes("page"));

    fake.onApi = undefined;
    fake.worlds.a.revoked = false;
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    const after = ((await askHome(sock, "connectors")) as StreamsReport).needs;
    expect([after.some(fetchNeed("granola-api")), fetchSaid(root, "granola-api"), queuedOf(root, "granola-api")]).toEqual([false, undefined, ["fetch", "page"]]);
    await askHome(sock, "resume", ["poll:granola-api"]);
    await until("the poll worked", () => okOf(root, "granola-api") !== null);
    expect([names(root, vault), blockOf(root, "granola")?.key]).toEqual([["granola.2"], "granola.2"]);
    artifact(root, "signin-need", { need: report.needs.find(fetchNeed("granola-api")), health: row.health });
  });

  it("a sign-in request past its one deadline answers anything but Granola not answering, or writes anything; hops each inside it, together past it, finish", async () => {
    const { root, sock, fake } = await open("lifestream-signin-deadline-", false, { signinMs: 1_500 });
    const before = config(root);
    fake.delay_ms = 600;
    expect(await ask(sock, { verb: "device-start", connector: "granola", route: "granola-mcp" })).toEqual({ refused: "Granola did not answer. Try again in a moment." });
    expect(fake.auth.slice(0, 2)).toEqual(["/.well-known/oauth-authorization-server", "/oauth/register"]);
    fake.delay_ms = 0;
    const started = (await ask(sock, { verb: "device-start", connector: "granola", route: "granola-mcp" })) as { attempt: { device_code: string }; interval_ms: number };
    fake.answer(started.attempt.device_code, fake.worlds.a);
    fake.expires_in = 60;
    fake.delay_ms = 600;
    const asked = fake.auth.length;
    expect(await ask(sock, { verb: "device-poll", connector: "granola", route: "granola-mcp", attempt: started.attempt, interval_ms: started.interval_ms })).toEqual({ refused: "Granola did not answer. Try again in a moment." });
    expect(fake.auth.slice(asked, asked + 2)).toEqual(["/.well-known/oauth-authorization-server", "/oauth/token"]);
    expect(config(root)).toEqual(before);
  });

  it("a sign-in's request against a locked vault asks Granola anything or writes anything", async () => {
    const { root, sock, fake, restart } = await open("lifestream-signin-locked-", false);
    await restart(null);
    const before = config(root);
    const route = { connector: "granola", route: "granola-mcp" };
    const attempt = { client_id: "client-synthetic-0", device_code: "device-synthetic-0" };
    const answers = [
      await ask(sock, { verb: "device-start", ...route }),
      await ask(sock, { verb: "device-poll", ...route, attempt, interval_ms: 5_000 }),
      await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A }),
    ];
    expect(answers).toEqual(Array(3).fill({ refused: "Unlock Lifestream on your Mac first." }));
    expect([fake.auth, fake.api, config(root)]).toEqual([[], [], before]);
  });

  it("a home started again with a route parked runs it, holds a row or a need of it, or loses its cursor", async () => {
    const { root, sock, fake, restart } = await open("lifestream-signin-restart-", true);
    fake.worlds.a.note({ title: "Synthetic planning" });
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("A's API poll worked", () => okOf(root, "granola-api") !== null);
    const apiFirst = cursorOf(root)!;
    expect(await deviceSignIn(sock, fake, fake.worlds.a)).toMatchObject({ state: "signed_in", account: ACCOUNT_A });
    await until("A's MCP poll worked", () => okOf(root, "granola-mcp") !== null);
    const asked = fake.api.length;
    const mcpA = keptOf(root, "granola-mcp")!;
    await restart();
    const row = await connectorRow(sock, "granola");
    expect([row.route, keptOf(root, "granola-mcp"), pollRow(root, "granola-api"), cursorOf(root), fake.api.length]).toEqual(["granola-mcp", mcpA, undefined, apiFirst, asked]);
    expect(((await askHome(sock, "connectors")) as StreamsReport).needs.filter(fetchNeed("granola-api"))).toEqual([]);
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("the API route runs again", () => pollRow(root, "granola-api") !== undefined);
    expect(cursorOf(root)).toBe(apiFirst);
  });

  it("a home killed between the seal and the block write leaves the old account anything but polling on its cursor, or the next sign-in to another account anything but whole", async () => {
    const { root, sock, fake, vault, slot, stop, restart } = await open("lifestream-signin-sealed-", false);
    fake.worlds.a.note({ title: "Synthetic planning" });
    fake.worlds.b.note({ title: "Synthetic review" });
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toMatchObject({ account: ACCOUNT_A });
    await until("A's API poll worked", () => okOf(root, "granola-api") !== null);
    const apiFirst = cursorOf(root)!;
    await stop();

    const child = new ChildHome(root);
    child.start("signin.sealed", { env: { LIFESTREAM_TEST_REGISTRY: pathToFileURL(REGISTRY).href }, slot });
    try {
      await child.ready();
      expect(await apiSignIn(sock, { account: ACCOUNT_B, key: KEY_B }).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    } finally {
      child.kill();
    }
    expect([blockOf(root, "granola"), names(root, vault), secretsOf(root, vault).get("granola.2")]).toEqual([{ account: ACCOUNT_A, route: "granola-api", key: "granola.1" }, ["granola.1", "granola.2"], KEY_B]);
    expect([cursorOf(root), pollRow(root, "granola-api")?.source]).toEqual([apiFirst, SOURCE_A]);
    const left = { block: blockOf(root, "granola"), secrets: names(root, vault), poll: pollRow(root, "granola-api") };

    rmSync(sock.path, { force: true });
    await restart();
    const resumed = Date.now();
    await askHome(sock, "run", ["poll", "granola-api"]);
    await until("A's API poll ran again", () => polledAs(root, "granola-api", SOURCE_A, resumed));
    expect(cursorOf(root)).toBe(apiFirst);

    const signed = Date.now();
    expect(await apiSignIn(sock, { account: ACCOUNT_B, key: KEY_B })).toEqual({ account: ACCOUNT_B, source: SOURCE_B });
    expect([blockOf(root, "granola"), names(root, vault), secretsOf(root, vault).get("granola.3")]).toEqual([{ account: ACCOUNT_B, route: "granola-api", key: "granola.3" }, ["granola.3"], KEY_B]);
    await until("B's API poll worked", () => polledAs(root, "granola-api", SOURCE_B, signed));
    expect(cursorOf(root)).toBeGreaterThanOrEqual(signed);
    artifact(root, "signin-kill-sealed", { left, after: { block: blockOf(root, "granola"), secrets: names(root, vault), poll: pollRow(root, "granola-api") } });
  });

  it("an old poll's refresh, held while the person signs in to another account, touches the new account's secret, asks the old account anything after or lands any of it", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-held-", false);
    fake.worlds.a.note({ title: "Synthetic planning" });
    fake.worlds.b.note({ title: "Synthetic review" });
    fake.expires_in = 60;
    const held = fake.hold(2);
    expect(await deviceSignIn(sock, fake, fake.worlds.a)).toMatchObject({ state: "signed_in", account: ACCOUNT_A });
    await until("A's poll's refresh held", held.reached);
    fake.expires_in = 21_600;
    expect(await deviceSignIn(sock, fake, fake.worlds.b)).toMatchObject({ state: "signed_in", account: ACCOUNT_B });
    const sealedB = secretsOf(root, vault).get("granola.signin.2");
    expect([blockOf(root, "granola"), names(root, vault)]).toEqual([{ route: "granola-mcp", account: ACCOUNT_B, signin: "granola.signin.2" }, ["granola.signin.2"]]);
    const askedA = [...fake.worlds.a.toolCalls];
    held.release();
    const headsOf = (source: string) => readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? ORDER BY key").pluck().all(source)) as string[];
    await until("B's meeting landed", () => headsOf(SOURCE_B).length > 0);
    expect([names(root, vault), secretsOf(root, vault).get("granola.signin.2")]).toEqual([["granola.signin.2"], sealedB]);
    expect(fake.worlds.a.toolCalls).toEqual(askedA);
    expect(askedA.map((call) => call.name).filter((name) => name !== "get_account_info")).toEqual([]);
    expect(readHome(root, (db) => db.prepare("SELECT id FROM sources WHERE id LIKE 'granola:%' ORDER BY id").pluck().all())).toEqual([SOURCE_B]);
    const landed = headsOf(SOURCE_B);
    expect(landed).toHaveLength(1);
    artifact(root, "signin-held", { secrets: names(root, vault), sources: [SOURCE_B], landed, asked_a: askedA });
  });
});

const GMAIL = "person-g@example.com";
const APP_PASSWORD = "abcdefghijklmnop";
const gmailIn = (sock: HomeSocket, values: JsonObject) => ask(sock, { verb: "account-connect", connector: "gmail", route: "gmail-imap", values });
const pollNow = (sock: HomeSocket, acquirer: string) => askHome(sock, "run", ["poll", acquirer]);
const signedOut = (name: string, acquirer: string) => ({ state: "needs-you", reason: "signed-out", words: `Sign in to ${name} again`, acts: [{ do: "signin", label: "Sign in", of: acquirer }] });
const lastOk = (root: string, acquirer: string): number => okOf(root, acquirer) ?? 0;

describe("Gmail's sign-in, the declared checks, and what none may say: each of these is impossible", () => {
  it("Gmail: an app password refused seals, writes or names another row; one typed in groups is sealed with its spaces; a login cut or past the deadline writes anything or leaves its session open", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-gmail-", true, { signinMs: 1_500 });
    fake.gmail.password = APP_PASSWORD;
    for (let uid = 1; uid <= 3; uid++) mail(fake.inbox, uid, uid);
    const before = config(root);
    expect(await gmailIn(sock, { account: GMAIL, password: "zzzz yyyy xxxx wwww" })).toEqual({ refused: "Google refused this password. Make a new app password and paste it here.", field: "password" });
    expect(fake.gmail.logins).toEqual([{ account: GMAIL, password: "zzzzyyyyxxxxwwww" }]);
    fake.gmail.login = "cut";
    expect(await gmailIn(sock, { account: GMAIL, password: APP_PASSWORD })).toEqual({ refused: "Gmail did not answer. Try again in a moment." });
    fake.gmail.login = "hang";
    const closed = fake.gmail.closes;
    expect(await gmailIn(sock, { account: GMAIL, password: APP_PASSWORD })).toEqual({ refused: "Gmail did not answer. Try again in a moment." });
    await until("the check's session closed", () => fake.gmail.closes > closed);
    expect(config(root)).toEqual(before);
    fake.gmail.login = "ok";
    expect(await gmailIn(sock, { account: GMAIL, password: "abcd efgh ijkl mnop" })).toEqual({ account: GMAIL, source: `gmail:${GMAIL}:cloud` });
    expect([names(root, vault), secretsOf(root, vault).get("gmail.password.1"), blockOf(root, "gmail")]).toEqual([["gmail.password.1"], APP_PASSWORD, { account: GMAIL, route: "gmail-imap", password: "gmail.password.1" }]);
    await until("Gmail's poll worked", () => okOf(root, "gmail-imap") !== null);
    expect(fake.gmail.logins.at(-1)).toEqual({ account: GMAIL, password: APP_PASSWORD });
    artifact(root, "signin-gmail", { block: blockOf(root, "gmail"), logins: fake.gmail.logins.length, closes: fake.gmail.closes, cursor: JSON.parse(cursorRow(root, "gmail-imap")!.state) as unknown });
  });

  it("Gmail: a poll Google answers NO to holds anything but 'Sign in to Gmail again' with its act, or holds a password need", async () => {
    const { root, sock, fake, vault } = await open("lifestream-signin-gmail-need-", true);
    fake.gmail.password = APP_PASSWORD;
    expect(await gmailIn(sock, { account: GMAIL, password: APP_PASSWORD })).toMatchObject({ account: GMAIL });
    await until("Gmail's poll worked", () => okOf(root, "gmail-imap") !== null);
    fake.gmail.password = "revokedrevokedxx";
    await pollNow(sock, "gmail-imap");
    await until("Gmail's poll needs the person", () => fetchSaid(root, "gmail-imap")?.outcome === "need");
    const report = (await askHome(sock, "connectors")) as StreamsReport;
    expect(report.needs.find(fetchNeed("gmail-imap"))).toMatchObject(signedOut("Gmail", "gmail-imap"));
    expect(report.needs.filter((need) => need.id.startsWith("password:"))).toEqual([]);
    fake.gmail.password = "newpasswordnewpw";
    expect(await gmailIn(sock, { account: GMAIL, password: "newpasswordnewpw" })).toMatchObject({ account: GMAIL });
    expect(names(root, vault)).toEqual(["gmail.password.2"]);
    await until("Gmail's poll works again", () => fetchSaid(root, "gmail-imap")?.outcome === "ok");
    artifact(root, "signin-gmail-need", { need: report.needs.find(fetchNeed("gmail-imap")) });
  });

  it("a declared check runs from anything but its declaration, or an answer it does not know says more than its status or writes anything", async () => {
    const { root, sock, fake } = await open("lifestream-signin-declared-", false);
    const before = config(root);
    const github = (values: JsonObject) => ask(sock, { verb: "account-connect", connector: "github", route: "github-api", values });
    fake.github_status = 403;
    const limited = (await github({ login: "person-a", token: "ghp_synthetic_a" })) as { refused: string; field?: string };
    expect([limited.refused.includes("403"), limited.refused.includes("ghp_synthetic_a"), limited.refused.includes("rate limit"), limited.field]).toEqual([true, false, false, undefined]);
    expect(config(root)).toEqual(before);
    fake.github_status = undefined;
    expect(await github({ login: "person-a", token: "ghp_synthetic_revoked" })).toEqual({ refused: "GitHub refused this token. Check it reads Contents, Issues and Pull requests, then paste it again.", field: "token" });
    expect(await github({ login: "person-a", token: "ghp_synthetic_b" })).toEqual({ refused: "That token is person-b's, not person-a's.", field: "login" });
    expect(await github({ login: "Person-A", token: "ghp_synthetic_a" })).toEqual({ account: "person-a", source: "github:person-a:cloud" });
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: "grn_synthetic_revoked" })).toEqual({ refused: "Granola did not accept this API key.", field: "key" });
    expect(await apiSignIn(sock, { account: ACCOUNT_A, key: KEY_A })).toEqual({ account: ACCOUNT_A, source: SOURCE_A });
    artifact(root, "signin-declared", { limited: limited.refused, github: blockOf(root, "github"), granola: blockOf(root, "granola") });
  });

  it("a password, user name, code, attempt, token, code's words or provider's text reaches a log line, the settings, the report or a refusal", async () => {
    const lines: string[] = [];
    const { root, sock, fake } = await open("lifestream-signin-secrecy-", true, { log: (line) => lines.push(line) });
    const answers: JsonObject[] = [];
    const said = async (asked: Promise<unknown>) => {
      const answer = (await asked.catch((error: unknown) => ({ error: (error as Error).message }))) as JsonObject;
      answers.push(answer);
      return answer;
    };
    fake.gmail.password = APP_PASSWORD;
    await said(gmailIn(sock, { account: GMAIL, password: "synthsecretgmailx" }));
    await said(gmailIn(sock, { account: GMAIL, password: APP_PASSWORD }));
    await until("Gmail's poll worked", () => lastOk(root, "gmail-imap") > 0);
    fake.gmail.password = "rotatedawaygmail";
    await pollNow(sock, "gmail-imap");
    await until("Gmail's poll needs the person", () => fetchSaid(root, "gmail-imap")?.outcome === "need");
    await said(ask(sock, { verb: "account-connect", connector: "github", route: "github-api", values: { login: "person-q", token: "ghp_synthetic_secret" } }));
    await said(apiSignIn(sock, { account: "person-q@example.com", key: "grn_synthetic_secret" }));
    const lined = (await said(ask(sock, { verb: "account-connect", connector: "github", route: "github-api", values: { login: "person-q", token: "ghp_synthetic_line\nbreak" } }))) as { field?: string };
    expect(lined.field).toBe("token");
    const written = [...lines, readFileSync(join(root, "config", "settings.json"), "utf8"), JSON.stringify(await askHome(sock, "connectors"))].join("\n");
    const refusals = JSON.stringify(answers.filter((answer) => "refused" in answer || "error" in answer));
    const secret = ["synthsecretgmailx", APP_PASSWORD, "rotatedawaygmail", "ghp_synthetic_secret", "grn_synthetic_secret", "ghp_synthetic_line", "Invalid credentials", "refused: ", "Bad credentials", "Unauthorized", "rate limit"];
    expect([secret.filter((each) => written.includes(each)), secret.filter((each) => refusals.includes(each))]).toEqual([[], []]);
    artifact(root, "signin-secrecy", { refusals: JSON.parse(refusals) as unknown, lines: lines.length });
  });
});
