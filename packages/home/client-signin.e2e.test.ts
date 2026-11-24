import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { homeSecrets, openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { startHome, type Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { effective } from "./settings.js";
import { ask, askHome, type HomeSocket } from "./socket.js";
import type { StreamsReport } from "./streams-report.js";
import { CLIENT_FAKE_FILE } from "./test/client-registry.js";
import { releaseFolder } from "./test/fed.js";
import { artifact, ChildHome, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { DEVICE } from "./test/support.js";
import { openWith, readVault, recoveryKey } from "./vault.js";
import { testSocket } from "./test/folder.js";

const REGISTRY = fileURLToPath(new URL("./test/client-registry.ts", import.meta.url));
const ACCOUNT = "person-a@example.com";
const SOURCE = `google-calendar:${ACCOUNT}:cloud`;
const CLIENT = { client_id: "client-0001.apps.example.com", client_secret: "client-secret-0001" };
const OTHER_CLIENT = { client_id: "client-bb07.apps.example.com", client_secret: "client-secret-bb07" };
const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
const START = { connector: "google-calendar", route: "gcal-api" };

class FakeGoogle {
  readonly clients = new Map([[CLIENT.client_id, CLIENT.client_secret], [OTHER_CLIENT.client_id, OTHER_CLIENT.client_secret]]);
  readonly #codes = new Map<string, { client_id: string; challenge: string; redirect: string }>();
  readonly #refresh = new Set<string>();
  readonly #access = new Set<string>();
  readonly seen: string[] = [];
  check = 200;
  #serial = 0;
  readonly #server = createServer((request, response) => void this.#answer(request, response));
  url = "";

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return port;
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }

  consent(open: string, allow = true): string {
    const url = new URL(open);
    const query = Object.fromEntries(url.searchParams);
    expect(`${url.origin}${url.pathname}`).toBe(`${this.url}/o/oauth2/v2/auth`);
    expect(query).toEqual({
      response_type: "code", client_id: expect.any(String), redirect_uri: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u), scope: SCOPE, state: expect.any(String),
      code_challenge: expect.stringMatching(/^[\w-]{43}$/u), code_challenge_method: "S256", access_type: "offline", prompt: "consent",
    });
    const back = new URL(query.redirect_uri!);
    back.searchParams.set("state", query.state!);
    if (!allow) {
      back.searchParams.set("error", "access_denied");
      return back.href;
    }
    const code = `4/code-${++this.#serial}`;
    this.#codes.set(code, { client_id: query.client_id!, challenge: query.code_challenge!, redirect: query.redirect_uri! });
    back.searchParams.set("code", code);
    back.searchParams.set("scope", SCOPE);
    return back.href;
  }

  #tokens(refresh: boolean): JsonObject {
    const n = ++this.#serial;
    this.#access.add(`ya29.access-${n}`);
    if (refresh) this.#refresh.add(`1//refresh-${n}`);
    return { access_token: `ya29.access-${n}`, expires_in: 3599, token_type: "Bearer", scope: SCOPE, ...(refresh ? { refresh_token: `1//refresh-${n}` } : {}) };
  }

  async #answer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const url = new URL(request.url ?? "/", this.url);
    const json = (body: unknown, status = 200): void => void response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    if (url.pathname === "/token") {
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const grant = form.get("grant_type");
      this.seen.push(`token ${grant}`);
      if (this.clients.get(form.get("client_id") ?? "") !== form.get("client_secret")) return json({ error: "invalid_client" }, 401);
      if (grant === "authorization_code") {
        const issued = this.#codes.get(form.get("code") ?? "");
        this.#codes.delete(form.get("code") ?? "");
        const verified = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (issued === undefined || issued.client_id !== form.get("client_id") || issued.redirect !== form.get("redirect_uri") || issued.challenge !== verified) return json({ error: "invalid_grant" }, 400);
        return json(this.#tokens(true));
      }
      if (grant === "refresh_token" && this.#refresh.has(form.get("refresh_token") ?? "")) return json(this.#tokens(false));
      return json({ error: "invalid_grant" }, 400);
    }
    const bearer = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
    this.seen.push(url.pathname);
    if (!this.#access.has(bearer)) return json({ error: { code: 401 } }, 401);
    if (url.pathname === "/google/calendar/v3/calendars/primary" && this.check !== 200) return json({ error: { code: this.check, status: "PERMISSION_DENIED" } }, this.check);
    if (url.pathname === "/google/calendar/v3/calendars/primary") return json({ kind: "calendar#calendar", id: ACCOUNT, summary: ACCOUNT, timeZone: "UTC" });
    if (url.pathname === "/google/calendar/v3/users/me/calendarList") return json({ items: [{ id: ACCOUNT, accessRole: "owner" }] });
    if (url.pathname === `/google/calendar/v3/calendars/${encodeURIComponent(ACCOUNT)}/events`) {
      const items = url.searchParams.has("syncToken") ? [] : [{ kind: "calendar#event", id: "evt1", status: "confirmed", iCalUID: "evt1@google.com", summary: "Synthetic planning", start: { date: "2026-11-10" }, end: { date: "2026-11-11" } }];
      return json({ kind: "calendar#events", items, nextSyncToken: "sync-1" });
    }
    return json({ error: "not_found" }, 404);
  }
}

async function open(prefix: string) {
  const google = new FakeGoogle();
  const root = makeRoot(prefix, { sources: {}, clocks: false });
  writeFileSync(join(root, CLIENT_FAKE_FILE), JSON.stringify({ port: await google.start() }));
  const door = await doorHere(root, { registry: pathToFileURL(REGISTRY) });
  const at: { home: Home | null } = { home: null };
  onTestFinished(async () => {
    await at.home?.stop();
    await google.close();
    removeRoot(root);
  });
  const start = async (slot: Buffer | null) => {
    at.home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, slot, tickMs: TICK_MS, log: () => undefined });
  };
  await start(null);
  const sock = testSocket(root);
  const slot = randomBytes(32);
  const made = (await ask(sock, { verb: "vault-init", slot_key: slot.toString("base64"), store: "keychain-login" })) as { recovery: string };
  await ask(sock, { verb: "vault-confirm", recovery: made.recovery });
  const key = openWith(readVault(root)!, "recovery", recoveryKey.parse(made.recovery))!.key;
  const principals = openHomeFolder(root);
  const pass = (unit: string, kind: "mac" | "phone" | null) => {
    const { token } = mintPrincipal(principals, { unit, ...(kind === null ? {} : { kind }), scopes: ["read"], now_ms: Date.now() });
    return { authorization: `Bearer ${token}`, "content-type": "application/json", ...(kind === null ? {} : DEVICE[kind]) };
  };
  const passes = { mac: pass(effective(root).settings.unit, "mac"), phone: pass("synthetic-iphone-5a49", "phone"), reader: pass("reader", null) };
  const vault = () => homeSecrets(join(root, "config", "secrets"), { key });
  return {
    root, sock, google, passes,
    doorRoutes: async () => ((await (await fetch(`${door.url}/v1/connectors`, { headers: passes.reader })).json()) as StreamsReport).connectors.find((each) => each.id === "google-calendar")!.routes,
    secrets: (): Record<string, string> => Object.fromEntries(vault().list().map((each) => [each.name, vault().get(each.name)!])),
    seal: (name: string, value: string) => vault().set(name, value),
    door: async (path: string, headers: Record<string, string>, body: unknown) => {
      const response = await fetch(`${door.url}/v1/signin/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
      return { status: response.status, body: (await response.json()) as JsonObject };
    },
    async restart(locked = false) {
      await at.home?.stop();
      rmSync(sock.path, { force: true });
      await start(locked ? null : slot);
    },
    async stop() {
      await at.home!.stop();
      at.home = null;
    },
    slot,
  };
}

const written = (root: string): JsonObject => {
  const file = JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as JsonObject;
  return Object.fromEntries(Object.entries(file).filter(([key]) => key === "connectors.google-calendar" || key.startsWith("clients.")));
};
const routesOf = async (sock: HomeSocket) => ((await askHome(sock, "connectors")) as StreamsReport).connectors.find((each) => each.id === "google-calendar")!.routes;
const headsOf = (root: string) => readHome(root, (db) => db.prepare("SELECT key FROM heads WHERE source = ? ORDER BY key").pluck().all(SOURCE)) as string[];

describe("a client sign-in: each of these is impossible", () => {
  it("C1 C2 C3 C4 C5 by the home's listener: a bad address, a sign-in before the browser came back, the client or the credential sealed otherwise, a report that lies, Calendar not polling, the client asked again, the loser left", async () => {
    const home = await open("lifestream-client-listener-");
    const { root, sock, google } = home;
    const client = { id: "google", name: "Google", held: false, before: [...releaseFolder("calendar/google").clients[0]!.before] };
    const routes = [["gcal-api", "gcal-api", "client", client], ["gcal-again", "gcal-api", "client", client]];
    expect((await routesOf(sock)).map((route) => [route.id, route.acquirer, route.way, route.client])).toEqual(routes);
    expect((await home.doorRoutes()).map((route) => [route.id, route.acquirer, route.way, route.client])).toEqual(routes);

    expect(await ask(sock, { verb: "client-start", ...START })).toEqual({ refused: "Make your Google client, then type its client ID and secret.", field: "client_id" });
    expect(await ask(sock, { verb: "client-start", ...START, client: { client_id: CLIENT.client_id, client_secret: " " } })).toEqual({ refused: "Type your Google client secret.", field: "client_secret" });
    expect(google.seen).toEqual([]);

    const started = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject; listening: boolean; expires_ms: number };
    expect(started.listening).toBe(true);
    expect(new URL(started.open).searchParams.get("client_id")).toBe(CLIENT.client_id);
    expect(started.attempt).toMatchObject({ client: { id: "google", ...CLIENT }, redirect: new URL(started.open).searchParams.get("redirect_uri") });
    const finish = () => ask(sock, { verb: "client-finish", ...START, attempt: started.attempt });
    expect(await finish()).toEqual({ state: "pending" });
    const browser = await fetch(google.consent(started.open));
    expect([browser.status, await browser.text()]).toEqual([200, expect.stringContaining("You can close this page.")]);
    expect(await finish()).toEqual({ state: "signed_in", account: ACCOUNT, source: SOURCE });
    expect(google.seen.slice(0, 2)).toEqual(["token authorization_code", "/google/calendar/v3/calendars/primary"]);

    const sealed = home.secrets();
    expect(Object.keys(sealed).sort()).toEqual(["client.google.1", "google-calendar.signin.1"]);
    expect(JSON.parse(sealed["client.google.1"]!)).toEqual(CLIENT);
    expect(JSON.parse(sealed["google-calendar.signin.1"]!)).toEqual({
      ...CLIENT, token_endpoint: `${google.url}/token`, refresh_token: expect.stringMatching(/^1\/\/refresh-/u), access_token: expect.stringMatching(/^ya29\./u), expires_ms: expect.any(Number),
    });
    expect(written(root)).toEqual({ "clients.google": "client.google.1", "connectors.google-calendar": { route: "gcal-api", account: ACCOUNT, signin: "google-calendar.signin.1" } });
    expect((await routesOf(sock)).map((route) => route.client?.held)).toEqual([true, true]);

    await askHome(sock, "run", ["poll", "gcal-api"]);
    await until("Calendar's event landed", () => headsOf(root).length > 0);
    expect(headsOf(root)).toEqual(["evt1@google.com"]);

    const again = (await ask(sock, { verb: "client-start", connector: "google-calendar", route: "gcal-again" })) as { open: string; attempt: JsonObject };
    expect(again.attempt.client).toEqual({ id: "google" });
    expect(new URL(again.open).searchParams.get("client_id")).toBe(CLIENT.client_id);
    await fetch(google.consent(again.open));
    expect(await ask(sock, { verb: "client-finish", connector: "google-calendar", route: "gcal-again", attempt: again.attempt })).toMatchObject({ state: "signed_in", account: ACCOUNT });
    expect(Object.keys(home.secrets()).sort()).toEqual(["client.google.1", "google-calendar.signin.2"]);
    expect(written(root)).toEqual({ "clients.google": "client.google.1", "connectors.google-calendar": { route: "gcal-again", account: ACCOUNT, signin: "google-calendar.signin.2" } });

    const twice = await Promise.all([0, 1].map(async () => {
      const each = (await ask(sock, { verb: "client-start", ...START, client: OTHER_CLIENT })) as { open: string; attempt: JsonObject };
      await fetch(google.consent(each.open));
      return each;
    }));
    for (const each of twice) expect(await ask(sock, { verb: "client-finish", ...START, attempt: each.attempt })).toMatchObject({ state: "signed_in" });
    expect(Object.keys(home.secrets()).sort()).toEqual(["client.google.3", "google-calendar.signin.4"]);
    expect(JSON.parse(home.secrets()["client.google.3"]!)).toEqual(OTHER_CLIENT);
    expect(written(root)).toEqual({ "clients.google": "client.google.3", "connectors.google-calendar": { route: "gcal-api", account: ACCOUNT, signin: "google-calendar.signin.4" } });
    artifact(root, "client-signin-listener", { seen: google.seen, secrets: Object.keys(home.secrets()), written: written(root) });
  });

  it("C6 C7 through the door: a phone's start on the home's listener or another port than its own, a bad pasted address writing anything, a reading pass starting anything, a refusal not passed through, a locked vault asking Google", async () => {
    const home = await open("lifestream-client-door-");
    const { root, google, passes } = home;
    expect(await home.door("client/start", passes.reader, { ...START, client: CLIENT })).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(await home.door("client/start", passes.phone, { connector: "google-calendar" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await home.door("client/start", passes.phone, START)).toEqual({ status: 200, body: { refused: "Make your Google client, then type its client ID and secret.", field: "client_id" } });

    const mac = await home.door("client/start", passes.mac, { ...START, client: CLIENT });
    expect(mac.body.listening).toBe(true);
    const own = await home.door("client/start", passes.phone, { ...START, client: CLIENT, port: 50_123 });
    expect([own.body.listening, new URL(own.body.open as string).searchParams.get("redirect_uri")]).toEqual([false, "http://127.0.0.1:50123"]);
    const pasted = await home.door("client/start", passes.phone, { ...START, client: CLIENT });
    expect(pasted.body.listening).toBe(false);
    const port = Number(new URL(new URL(pasted.body.open as string).searchParams.get("redirect_uri")!).port);
    expect(port).toBeGreaterThanOrEqual(49_152);

    const finish = (address?: string) => home.door("client/finish", passes.phone, { ...START, attempt: pasted.body.attempt, ...(address === undefined ? {} : { address }) });
    const before = { written: written(root), secrets: home.secrets() };
    const other = new URL(google.consent(own.body.open as string));
    expect(await finish(other.href)).toEqual({ status: 200, body: { refused: "That address is of another sign-in. Copy the whole address your browser ended on, or start again.", field: "address" } });
    expect(await finish("the page did not load")).toMatchObject({ status: 200, body: { field: "address" } });
    expect(await finish(google.consent(pasted.body.open as string, false))).toEqual({ status: 200, body: { refused: "You did not allow it at Google. Start it again." } });
    expect(await finish()).toEqual({ status: 200, body: { state: "pending" } });
    expect({ written: written(root), secrets: home.secrets() }).toEqual(before);
    expect(await finish(google.consent(pasted.body.open as string))).toEqual({ status: 200, body: { state: "signed_in", account: ACCOUNT, source: SOURCE } });
    expect(written(root)).toEqual({ "clients.google": "client.google.1", "connectors.google-calendar": { route: "gcal-api", account: ACCOUNT, signin: "google-calendar.signin.1" } });

    await home.restart(true);
    const asked = google.seen.length;
    expect(await home.door("client/start", passes.phone, { ...START, client: CLIENT })).toEqual({ status: 200, body: { refused: "Unlock Lifestream on your Mac first." } });
    expect(await home.door("client/finish", passes.phone, { ...START, attempt: pasted.body.attempt, address: "http://127.0.0.1:1/?state=x&code=y" })).toEqual({ status: 200, body: { refused: "Unlock Lifestream on your Mac first." } });
    expect(google.seen.length).toBe(asked);
    artifact(root, "client-signin-door", { seen: google.seen, written: written(root) });
  });

  it("C10 a code is sent once: the listener's finish refused, the address pasted after it asks Google nothing and says how the first ended; a code Google will not take said in words", async () => {
    const home = await open("lifestream-client-spent-");
    const { root, sock, google, passes } = home;
    const exchanges = () => google.seen.filter((each) => each === "token authorization_code").length;
    const before = { written: written(root), secrets: home.secrets() };

    google.check = 403;
    const started = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject };
    const address = google.consent(started.open);
    expect((await fetch(address)).status).toBe(200);
    const first = { refused: "Google refused your calendar. Turn on the Google Calendar API in your Cloud project, under APIs & Services, then try again in a minute. Start it again." };
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt })).toEqual(first);
    expect(exchanges()).toBe(1);
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt, address })).toEqual(first);
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt })).toEqual(first);
    expect(exchanges()).toBe(1);
    expect({ written: written(root), secrets: home.secrets() }).toEqual(before);

    google.check = 200;
    const again = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject };
    const back = google.consent(again.open);
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: again.attempt, address: back })).toEqual({ state: "signed_in", account: ACCOUNT, source: SOURCE });
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: again.attempt, address: back })).toEqual({ refused: "Google Calendar is signed in by this sign-in already." });
    expect(exchanges()).toBe(2);

    const pasted = await home.door("client/start", passes.phone, { ...START });
    const forged = new URL(google.consent(pasted.body.open as string));
    forged.searchParams.set("code", "4/code-spent");
    const refused = { refused: "Google did not take the sign-in's code: a code is taken once, and for a few minutes. Start it again." };
    expect(await home.door("client/finish", passes.phone, { ...START, attempt: pasted.body.attempt, address: forged.href })).toEqual({ status: 200, body: refused });
    expect(await home.door("client/finish", passes.phone, { ...START, attempt: pasted.body.attempt, address: forged.href })).toEqual({ status: 200, body: refused });
    expect(exchanges()).toBe(3);
    artifact(root, "client-signin-spent", { seen: google.seen, written: written(root) });
  });

  it("C9 the sign-in retires the old client and token: their members and their vault items go once it commits, never before", async () => {
    const home = await open("lifestream-client-retired-");
    const { root, sock, google } = home;
    await home.stop();
    const path = join(root, "config", "settings.json");
    const before = { account: ACCOUNT, client: "google-calendar.client", token: "google-calendar.token", calendars: ["primary"] };
    writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")) as JsonObject, "connectors.google-calendar": before }));
    await home.restart();
    home.seal("google-calendar.client", JSON.stringify(CLIENT));
    home.seal("google-calendar.token", JSON.stringify({ refresh_token: "1//refresh-old" }));

    expect(await ask(sock, { verb: "client-start", ...START })).toMatchObject({ field: "client_id" });
    expect([Object.keys(home.secrets()).sort(), written(root)]).toEqual([["google-calendar.client", "google-calendar.token"], { "connectors.google-calendar": before }]);

    const started = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject };
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt, address: google.consent(started.open) })).toMatchObject({ state: "signed_in", account: ACCOUNT });
    expect(Object.keys(home.secrets()).sort()).toEqual(["client.google.1", "google-calendar.signin.1"]);
    expect(written(root)).toEqual({ "clients.google": "client.google.1", "connectors.google-calendar": { account: ACCOUNT, calendars: ["primary"], route: "gcal-api", signin: "google-calendar.signin.1" } });
  });

  it("C8 a home killed between sealing the client and the commit leaves a generation the next sign-in does not remove, or names anything but fresh ones", async () => {
    const home = await open("lifestream-client-sealed-");
    const { root, sock, google, slot } = home;
    await home.stop();
    const child = new ChildHome(root);
    child.start("signin.sealed", { env: { LIFESTREAM_TEST_REGISTRY: pathToFileURL(REGISTRY).href }, slot });
    try {
      await child.ready();
      const started = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject };
      const address = google.consent(started.open);
      expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt, address }).catch((error: unknown) => error)).toBeInstanceOf(Error);
      expect(await child.exited()).toEqual({ code: null, signal: "SIGKILL" });
    } finally {
      child.kill();
    }
    expect([Object.keys(home.secrets()), written(root)]).toEqual([["client.google.1"], {}]);

    rmSync(sock.path, { force: true });
    await home.restart();
    const started = (await ask(sock, { verb: "client-start", ...START, client: CLIENT })) as { open: string; attempt: JsonObject };
    expect(await ask(sock, { verb: "client-finish", ...START, attempt: started.attempt, address: google.consent(started.open) })).toMatchObject({ state: "signed_in" });
    expect(Object.keys(home.secrets()).sort()).toEqual(["client.google.2", "google-calendar.signin.1"]);
    expect(written(root)).toEqual({ "clients.google": "client.google.2", "connectors.google-calendar": { route: "gcal-api", account: ACCOUNT, signin: "google-calendar.signin.1" } });
    artifact(root, "client-signin-sealed", { secrets: Object.keys(home.secrets()), written: written(root) });
  });
});
