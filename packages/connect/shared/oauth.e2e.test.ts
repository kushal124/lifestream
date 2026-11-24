import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NeedsYou } from "../seams.js";
import { artifact, memorySecrets, temp } from "../test/drive.js";
import { Refused } from "./refused.js";
import { isStop, request, type Stop } from "./http.js";
import type { Secrets } from "../seams.js";
import { createHash } from "node:crypto";
import {
  clientAuthorize, clientExchange, clientGrant, clientRefresher, credentialText, deviceStart, devicePoll, oauthCredential, oauthFresh, oauthMetadata, oauthRefresher, oauthTokens, redirectedTo,
  ANSWER_BYTES, type DeviceAttempt, type OAuthClient, type OAuthCredential, type OAuthIssuer, type Refresher,
} from "./oauth.js";

const T0 = Date.UTC(2026, 9, 27, 9, 0, 0);
const HOUR = 3_600_000;
const LIVE = new AbortController().signal;

class FakeIssuer {
  readonly seen: { path: string; form: Record<string, string> }[] = [];
  device: "pending" | "slow" | "denied" | "expired" | "approved" = "pending";
  refresh: "rotate" | "keep" | "invalid" | "broken" | "echo" = "rotate";
  registration: "open" | "closed" = "open";
  issuerOverride: string | undefined;
  tokenOverride: string | undefined;
  onRequest: ((path: string) => void) | undefined;
  serial = 0;
  readonly #server: Server;
  url = "";

  constructor() {
    this.#server = createServer((request, response) => void this.#answer(request, response));
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this.url;
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  get tokenRequests(): number {
    return this.seen.filter((each) => each.path === "/oauth/token").length;
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString("utf8");
    const path = new URL(request.url ?? "/", this.url).pathname;
    const form = request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(text)) : text === "" ? {} : (JSON.parse(text) as Record<string, string>);
    this.seen.push({ path, form });
    this.onRequest?.(path);
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (path === "/.well-known/oauth-authorization-server") {
      return send(200, {
        issuer: this.issuerOverride ?? this.url, token_endpoint: this.tokenOverride ?? `${this.url}/oauth/token`,
        device_authorization_endpoint: `${this.url}/oauth/device`, registration_endpoint: `${this.url}/oauth/register`,
        grant_types_supported: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"], token_endpoint_auth_methods_supported: ["none"],
      });
    }
    if (path === "/oauth/register") {
      const asked = form as Record<string, unknown>;
      const redirects = asked.redirect_uris;
      if (!Array.isArray(redirects) || redirects.length === 0) return send(400, { error: "invalid_client_metadata", error_description: "redirect_uris must be an array" });
      if (asked.token_endpoint_auth_method !== "none" || this.registration === "closed") return send(400, { error: "invalid_client_metadata", error_description: `client ${String(asked.client_name)} is not allowed` });
      return send(201, { client_id: `client-synthetic-${++this.serial}`, client_name: (form as Record<string, unknown>).client_name, token_endpoint_auth_method: "none" });
    }
    if (path === "/oauth/device") {
      if (!form.client_id?.startsWith("client-synthetic-")) return send(401, { error: "invalid_client" });
      return send(200, { device_code: "device-code-synthetic", user_code: "ABCD-EFGH", verification_uri: "https://issuer.example.com/device", verification_uri_complete: "https://issuer.example.com/device?code=ABCD-EFGH", expires_in: 300, interval: 5 });
    }
    if (path === "/oauth/token") {
      if (form.grant_type === "urn:ietf:params:oauth:grant-type:device_code") {
        if (form.device_code !== "device-code-synthetic") return send(400, { error: "invalid_grant" });
        if (this.device === "approved") return send(200, { access_token: "access-synthetic-1", refresh_token: "refresh-synthetic-1", token_type: "Bearer", expires_in: 21600 });
        const error = { pending: "authorization_pending", slow: "slow_down", denied: "access_denied", expired: "expired_token" }[this.device];
        return send(400, { error, error_description: "device-code-synthetic is not yet approved" });
      }
      if (form.grant_type === "refresh_token") {
        if (this.refresh === "invalid") return send(400, { error: "invalid_grant", error_description: `refresh token ${form.refresh_token} was revoked` });
        if (this.refresh === "broken") return send(200, { token_type: "Bearer" });
        if (this.refresh === "echo") return send(400, { error: form.refresh_token, error_description: "no such grant" });
        const n = ++this.serial;
        return send(200, { access_token: `access-synthetic-r${n}`, ...(this.refresh === "rotate" ? { refresh_token: `refresh-synthetic-r${n}` } : {}), token_type: "Bearer", expires_in: 21600 });
      }
    }
    send(404, { error: "not_found" });
  }
}

const issuers: FakeIssuer[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const issuer of issuers.splice(0)) await issuer.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function listening(answer: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => answer(request, response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function fakeIssuer(): Promise<{ fake: FakeIssuer; issuer: OAuthIssuer }> {
  const fake = new FakeIssuer();
  issuers.push(fake);
  const url = await fake.start();
  return { fake, issuer: { issuer: url, scope: "openid email offline_access", resource: "https://mcp.example.com/mcp" } };
}

const API = "https://api.example.com/v1/me";

async function bearer(secrets: Secrets, secret: string, refresher: Refresher, now: () => number): Promise<string | Stop> {
  let sent: string | undefined;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== API) return globalThis.fetch(input, init);
    sent = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /u, "");
    return new Response("{}");
  }) as typeof globalThis.fetch;
  const answer = await request(API, { method: "GET" }, { budget: { left: 1 }, refresher, secrets, secret, fetch, now, signal: LIVE });
  return isStop(answer) ? answer : sent!;
}

async function thrown(call: () => Promise<unknown>): Promise<Error | null> {
  try {
    await call();
    return null;
  } catch (error) {
    return error as Error;
  }
}

describe("oauth: each of these is impossible", () => {
  it("metadata naming another issuer, or an endpoint a token would travel in the clear to, is used", async () => {
    const { fake, issuer } = await fakeIssuer();
    expect((await oauthMetadata(issuer.issuer, { signal: LIVE })).token_endpoint).toBe(`${fake.url}/oauth/token`);
    fake.issuerOverride = "https://another-issuer.example.com";
    expect((await thrown(() => oauthMetadata(issuer.issuer, { signal: LIVE })))?.message).toMatch(/names another issuer/u);
    fake.issuerOverride = undefined;
    fake.tokenOverride = "http://tokens.example.com/oauth/token";
    const clear = await thrown(() => oauthMetadata(issuer.issuer, { signal: LIVE }));
    expect(clear).toBeInstanceOf(Refused);
    expect(clear?.message).toMatch(/token_endpoint is not an https address/u);
    expect((await thrown(() => oauthMetadata("http://issuer.example.com", { signal: LIVE })))?.message).toMatch(/not an https address/u);
  });

  it("a device sign-in reads approved before the person answers, loses slow_down, misreads a denial or an expiry, or counts its expiry from elsewhere", async () => {
    const { fake, issuer } = await fakeIssuer();
    let clock = T0;
    const now = () => clock;
    const code = await deviceStart(issuer, "Lifestream home", { now, signal: LIVE });
    const registered = fake.seen.find((each) => each.path === "/oauth/register")!.form as unknown as Record<string, unknown>;
    expect(registered).toMatchObject({ client_name: "Lifestream home", redirect_uris: ["http://127.0.0.1/"], token_endpoint_auth_method: "none", grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"] });
    expect(fake.seen.find((each) => each.path === "/oauth/device")!.form).toEqual({ client_id: code.attempt.client_id, scope: issuer.scope, resource: issuer.resource });
    expect(code).toEqual({ code: "ABCD-EFGH", open: "https://issuer.example.com/device?code=ABCD-EFGH", interval_ms: 5000, expires_ms: T0 + 300_000, attempt: { client_id: "client-synthetic-1", device_code: "device-code-synthetic" } });
    const started = fake.seen.length;

    const answers = [];
    answers.push(await devicePoll(issuer, code.attempt, code.interval_ms, { now, signal: LIVE }));
    fake.device = "slow";
    answers.push(await devicePoll(issuer, code.attempt, code.interval_ms, { now, signal: LIVE }));
    fake.device = "denied";
    answers.push(await devicePoll(issuer, code.attempt, 10_000, { now, signal: LIVE }));
    fake.device = "expired";
    answers.push(await devicePoll(issuer, code.attempt, 10_000, { now, signal: LIVE }));
    fake.device = "approved";
    clock = T0 + 60_000;
    answers.push(await devicePoll(issuer, code.attempt, 10_000, { now, signal: LIVE }));
    expect(answers).toEqual([
      { state: "pending", interval_ms: 5000 },
      { state: "pending", interval_ms: 10_000 },
      { state: "denied" },
      { state: "expired" },
      { state: "approved", credential: { client_id: "client-synthetic-1", refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: T0 + 60_000 + 21_600_000 } },
    ]);
    expect(fake.seen.slice(started).map((each) => each.path)).toEqual(Array(5).fill(["/.well-known/oauth-authorization-server", "/oauth/token"]).flat());
    for (const each of fake.seen.filter((seen) => seen.path === "/oauth/token")) {
      expect(each.form).toEqual({ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: "device-code-synthetic", client_id: "client-synthetic-1", resource: issuer.resource });
    }
    const unknown = await thrown(() => devicePoll(issuer, { ...code.attempt, device_code: "device-code-forged" }, 5000, { now, signal: LIVE }));
    expect(unknown?.message).toMatch(/HTTP 400, invalid_grant/u);
    expect(unknown?.message).not.toMatch(/device-code/u);
    const other = await fakeIssuer();
    for (const token_endpoint of ["http://tokens.example.com/oauth/token", `${other.fake.url}/oauth/token`]) {
      const asked = fake.tokenRequests;
      const forged = { ...code.attempt, token_endpoint } as DeviceAttempt;
      expect(await devicePoll(issuer, forged, 5000, { now, signal: LIVE })).toMatchObject({ state: "approved" });
      expect([fake.tokenRequests, other.fake.seen.length]).toEqual([asked + 1, 0]);
    }
    artifact(temp(), "device.json", { seen: fake.seen, answers });
  });

  it("a call refreshes while the token lives, uses one about to expire, leaves the vault without the rotated JSON, or loses the old refresh token", async () => {
    const { fake, issuer } = await fakeIssuer();
    const refresher = oauthRefresher(issuer);
    let clock = T0;
    const now = () => clock;
    const signed: OAuthCredential = { client_id: "client-synthetic-1", refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: T0 + 6 * HOUR };
    const secrets = memorySecrets({ "provider.signin": credentialText(signed) });
    const rotations: string[] = [];
    const watched = { ...secrets, rotate: (name: string, value: string) => { rotations.push(value); secrets.rotate(name, value); } };

    clock = T0 + 6 * HOUR - 5 * 60_000 - 1;
    expect(await bearer(watched, "provider.signin", refresher, now)).toBe("access-synthetic-1");
    expect(fake.seen).toEqual([]);
    expect(rotations).toEqual([]);

    clock = T0 + 6 * HOUR - 5 * 60_000;
    expect(await bearer(watched, "provider.signin", refresher, now)).toBe("access-synthetic-r1");
    expect(rotations).toHaveLength(1);
    expect(oauthCredential(secrets.values["provider.signin"]!, "the vault")).toEqual({ client_id: "client-synthetic-1", refresh_token: "refresh-synthetic-r1", access_token: "access-synthetic-r1", expires_ms: clock + 21_600_000 });
    expect(fake.seen.at(-1)!.form).toEqual({ grant_type: "refresh_token", refresh_token: "refresh-synthetic-1", client_id: "client-synthetic-1", resource: issuer.resource });

    fake.refresh = "keep";
    clock += 6 * HOUR - 60_000;
    expect(await bearer(watched, "provider.signin", refresher, now)).toBe("access-synthetic-r2");
    expect([rotations.length, oauthCredential(secrets.values["provider.signin"]!, "the vault").refresh_token]).toEqual([2, "refresh-synthetic-r1"]);
    artifact(temp(), "refresh.json", { seen: fake.seen, rotations: rotations.map((each) => JSON.parse(each) as unknown) });
  });

  it("a sealed value that is no JSON object is anything but signed-out, hands the refresher anything or rotates; a provider's own refresher is not handed the credential or its answer not rotated, or a client named \"\" is lost", async () => {
    let clock = T0;
    const now = () => clock;
    const handed: OAuthCredential[] = [];
    const own: Refresher = async (credential, dependencies) => {
      handed.push(credential);
      return oauthTokens({ access_token: `access-synthetic-own${handed.length}`, expires_in: 3600 }, credential, (dependencies.now ?? Date.now)(), "the provider");
    };
    const sealedNone = [" refresh-synthetic-bare\n", '"refresh-synthetic-quoted"', "42", '["refresh-synthetic-listed"]', "true", "null"];
    const needs: unknown[] = [];
    for (const sealed of sealedNone) {
      const secrets = memorySecrets({ "provider.signin": sealed });
      const refused = await bearer(secrets, "provider.signin", own, now);
      needs.push([typeof refused === "string" ? refused : refused.stop, secrets.values["provider.signin"] === sealed]);
    }
    expect([needs, handed.length]).toEqual([Array(sealedNone.length).fill(["signed-out", true]), 0]);
    const secrets = memorySecrets({ "provider.signin": credentialText({ client_id: "", refresh_token: "refresh-synthetic-own", access_token: "access-synthetic-spent", expires_ms: 0 }) });
    expect(await bearer(secrets, "provider.signin", own, now)).toBe("access-synthetic-own1");
    expect(handed).toEqual([{ client_id: "", refresh_token: "refresh-synthetic-own", access_token: "access-synthetic-spent", expires_ms: 0 }]);
    const rotated = { client_id: "", refresh_token: "refresh-synthetic-own", access_token: "access-synthetic-own1", expires_ms: T0 + HOUR };
    expect([JSON.parse(secrets.values["provider.signin"]!), oauthCredential(secrets.values["provider.signin"]!, "the vault")]).toEqual([rotated, rotated]);
    clock = T0 + 30 * 60_000;
    expect(await bearer(secrets, "provider.signin", own, now)).toBe("access-synthetic-own1");
    expect([handed.length, secrets.values["provider.signin"]]).toEqual([1, credentialText(rotated)]);
    artifact(temp(), "credential.json", { none: needs.length, handed: handed.length, rotated: secrets.values["provider.signin"] === credentialText(rotated) });
  });

  it("a refused refresh is anything but signed-out or changes the vault, a broken answer is used, or a message carries a token or an error code OAuth does not name", async () => {
    const { fake, issuer } = await fakeIssuer();
    const refresher = oauthRefresher(issuer);
    const now = () => T0;
    const expired: OAuthCredential = { client_id: "client-synthetic-1", refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: T0 - 1 };
    const sealed = credentialText(expired);
    const secrets = memorySecrets({ "provider.signin": sealed });

    fake.refresh = "invalid";
    expect(await bearer(secrets, "provider.signin", refresher, now)).toEqual({ stop: "signed-out" });
    const refused = await thrown(() => refresher(expired, { now, signal: LIVE }));
    expect(refused).toBeInstanceOf(NeedsYou);
    expect((refused as NeedsYou).reason).toBe("signed-out");
    expect(secrets.values["provider.signin"]).toBe(sealed);

    fake.refresh = "broken";
    const broken = await thrown(() => oauthFresh(expired, refresher, { now, signal: LIVE }));
    expect(broken).toBeInstanceOf(Refused);
    expect(broken?.message).toMatch(/states no access_token/u);
    expect(secrets.values["provider.signin"]).toBe(sealed);

    fake.refresh = "echo";
    const echoed = await thrown(() => oauthFresh(expired, refresher, { now, signal: LIVE }));
    expect([echoed instanceof Refused, echoed?.message]).toEqual([true, `${fake.url}'s refresh answered HTTP 400`]);

    fake.registration = "closed";
    const unregistered = await thrown(() => deviceStart(issuer, "Lifestream home", { now, signal: LIVE }));
    expect([unregistered instanceof Refused, unregistered?.message]).toEqual([true, `${fake.url} refused to register a client (HTTP 400, invalid_client_metadata)`]);

    expect(await bearer(memorySecrets({}), "provider.signin", refresher, now)).toEqual({ stop: "signed-out", answered: false });
    const none = await thrown(async () => oauthCredential("", "provider.signin"));
    expect((none as NeedsYou).reason).toBe("signed-out");
    const garbled = await thrown(() => bearer(memorySecrets({ "provider.signin": JSON.stringify({ refresh_token: "refresh-synthetic-1" }) }), "provider.signin", refresher, now));
    expect(garbled?.message).toBe("provider.signin holds no sign-in: it lacks client_id, refresh_token, access_token or expires_ms");
    for (const error of [refused, broken, echoed, unregistered, none, garbled]) expect(error?.message).not.toMatch(/synthetic-\d|refresh-synthetic|access-synthetic/u);
  });

  it("a request of a call carries a deadline of its own: the caller's deadline passing during the third hop leaves that hop to finish", async () => {
    const { fake, issuer } = await fakeIssuer();
    const deadline = new AbortController();
    fake.onRequest = (path) => {
      if (path === "/oauth/device") deadline.abort(new DOMException("the sign-in's deadline passed", "TimeoutError"));
    };
    const cut = await thrown(() => deviceStart(issuer, "Lifestream home", { signal: deadline.signal }));
    expect(cut?.name).toBe("TimeoutError");
    expect(fake.seen.map((each) => each.path)).toEqual(["/.well-known/oauth-authorization-server", "/oauth/register", "/oauth/device"]);
    fake.onRequest = undefined;
    expect((await deviceStart(issuer, "Lifestream home", { signal: LIVE })).code).toBe("ABCD-EFGH");
  });

  it("a POST that carries a credential follows a redirect, or an answer's body is read past 1 MiB", async () => {
    const reached: string[] = [];
    const elsewhere = await listening((request, response) => {
      reached.push(request.url ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 }));
    });
    const moving = await listening((_request, response) => response.writeHead(307, { location: `${elsewhere}/token` }).end());
    const client: OAuthClient = { authorize: "https://accounts.example.com/auth", token: `${moving}/token`, params: {}, client_id: "client-0001", client_secret: "client-secret-0001" };
    const moved = await thrown(() => clientExchange(client, clientGrant("http://127.0.0.1:50123"), "code-synthetic-1", "Example", { signal: LIVE }));
    expect([moved?.name, reached]).toEqual(["TypeError", []]);

    const big = ANSWER_BYTES + 1;
    const stated = await listening((_request, response) => response.writeHead(200, { "content-type": "application/json", "content-length": String(big) }).end("x".repeat(big)));
    const endless = await listening((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(64 * 1024);
      const more = (): void => {
        while (!response.destroyed && response.write(chunk));
        if (!response.destroyed) response.once("drain", more);
      };
      more();
    });
    for (const server of [stated, endless]) {
      const capped = await thrown(() => clientExchange({ ...client, token: `${server}/token` }, clientGrant("http://127.0.0.1:50123"), "code-synthetic-1", "Example", { signal: LIVE }));
      expect(capped).toBeInstanceOf(Refused);
      expect(capped?.message).toBe(`the code exchange answered more than ${ANSWER_BYTES} bytes`);
    }
    const atCap = await listening((_request, response) => {
      const body = JSON.stringify({ access_token: "a", refresh_token: "r", expires_in: 60 });
      response.writeHead(200, { "content-type": "application/json" }).end(body.padEnd(ANSWER_BYTES, " "));
    });
    expect((await clientExchange({ ...client, token: `${atCap}/token` }, clientGrant("http://127.0.0.1:50123"), "code-synthetic-1", "Example", { signal: LIVE })).refresh_token).toBe("r");
  });

  it("a client sign-in's round trip loses a member, reads another sign-in's address, exchanges without the verifier or the secret, or a third refresh fails after a rotation and an answer with none", async () => {
    const TOKEN = "https://oauth2.example.com/token";
    const client: OAuthClient = { authorize: "https://accounts.example.com/auth", token: TOKEN, params: { access_type: "offline", prompt: "consent", state: "overridden" }, client_id: "client-0001", client_secret: "client-secret-0001" };
    const seen: Record<string, string>[] = [];
    let challenge = "";
    let issued = 0;
    const live = new Set<string>();
    const rotations: boolean[] = [true, false, true];
    const fetch = (async (input: string | URL, init?: RequestInit) => {
      expect(String(input)).toBe(TOKEN);
      const form = Object.fromEntries(new URLSearchParams(String(init!.body)));
      seen.push(form);
      if (form.client_id !== client.client_id || form.client_secret !== client.client_secret) return Response.json({ error: "invalid_client" }, { status: 401 });
      if (form.grant_type === "authorization_code") {
        if (form.code !== "code-synthetic-1" || createHash("sha256").update(form.code_verifier ?? "").digest("base64url") !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        live.add("refresh-synthetic-1");
        return Response.json({ access_token: "access-synthetic-1", refresh_token: "refresh-synthetic-1", expires_in: 60 });
      }
      if (!live.has(form.refresh_token!)) return Response.json({ error: "invalid_grant" }, { status: 400 });
      issued++;
      const rotate = rotations.shift()!;
      if (rotate) {
        live.delete(form.refresh_token!);
        live.add(`refresh-synthetic-${issued + 1}`);
      }
      return Response.json({ access_token: `access-synthetic-${issued + 1}`, expires_in: 60, ...(rotate ? { refresh_token: `refresh-synthetic-${issued + 1}` } : {}) });
    }) as typeof globalThis.fetch;

    const grant = clientGrant("http://127.0.0.1:50123");
    const open = new URL(clientAuthorize(client, "scope.read", grant));
    challenge = open.searchParams.get("code_challenge")!;
    expect(Object.fromEntries(open.searchParams)).toEqual({
      access_type: "offline", prompt: "consent", response_type: "code", client_id: "client-0001", redirect_uri: "http://127.0.0.1:50123", scope: "scope.read", state: grant.state,
      code_challenge: createHash("sha256").update(grant.verifier).digest("base64url"), code_challenge_method: "S256",
    });
    const back = (query: string) => `http://127.0.0.1:50123/?${query}`;
    expect(redirectedTo(back(`state=${grant.state}&code=code-synthetic-1&scope=scope.read`), grant.state)).toEqual({ code: "code-synthetic-1" });
    expect(redirectedTo(back(`state=${grant.state}&error=access_denied`), grant.state)).toEqual({ error: "access_denied" });
    expect(redirectedTo(back(`state=${grant.state}&error=some_private_word`), grant.state)).toEqual({ error: "refused" });
    expect((await thrown(async () => redirectedTo(back("state=another&code=code-synthetic-9"), grant.state)))?.message).toBe("that address is of another sign-in");
    expect((await thrown(async () => redirectedTo("not an address", grant.state)))?.message).toBe("that is not the address your browser ended on");

    let clock = T0;
    const now = () => clock;
    const refused = await thrown(() => clientExchange(client, grant, "code-synthetic-2", "Example", { signal: LIVE, fetch, now }));
    expect(refused?.message).toBe("Example did not take the sign-in's code: a code is taken once, and for a few minutes");
    const credential = await clientExchange(client, grant, "code-synthetic-1", "Example", { signal: LIVE, fetch, now });
    expect(credential).toEqual({ client_id: "client-0001", client_secret: "client-secret-0001", token_endpoint: TOKEN, refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: T0 + 60_000 });
    expect(seen.at(-1)).toEqual({ grant_type: "authorization_code", code: "code-synthetic-1", redirect_uri: "http://127.0.0.1:50123", code_verifier: grant.verifier, client_id: "client-0001", client_secret: "client-secret-0001" });

    const secrets = memorySecrets({ "example.signin.1": credentialText(credential) });
    const api = (async () => new Response("{}")) as typeof globalThis.fetch;
    const both = (async (input: string | URL, init?: RequestInit) => (String(input) === TOKEN ? fetch(input, init) : api(input, init))) as typeof globalThis.fetch;
    const held = () => JSON.parse(secrets.values["example.signin.1"]!) as OAuthCredential;
    const refreshes: string[] = [];
    for (const step of ["rotated", "none", "third"]) {
      clock += HOUR;
      const answer = await request("https://api.example.com/v1/me", { method: "GET" }, { refresher: clientRefresher("Example"), secrets, secret: "example.signin.1", fetch: both, now, signal: LIVE });
      expect(isStop(answer)).toBe(false);
      refreshes.push(`${step}: ${held().refresh_token}`);
      expect(held()).toMatchObject({ client_id: "client-0001", client_secret: "client-secret-0001", token_endpoint: TOKEN, expires_ms: clock + 60_000 });
    }
    expect(refreshes).toEqual(["rotated: refresh-synthetic-2", "none: refresh-synthetic-2", "third: refresh-synthetic-4"]);

    const asked = seen.length;
    const bare = memorySecrets({ "example.signin.1": credentialText({ client_id: "client-0001", refresh_token: "refresh-synthetic-4", access_token: "a", expires_ms: 0 }) });
    expect(await request("https://api.example.com/v1/me", { method: "GET" }, { refresher: clientRefresher("Example"), secrets: bare, secret: "example.signin.1", fetch: both, now, signal: LIVE })).toEqual({ stop: "signed-out", answered: false });
    expect(seen.length).toBe(asked);
    artifact(temp(), "client.json", { refreshes, forms: seen.map((form) => form.grant_type) });
  });
});

