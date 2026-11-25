import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as tlsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { hideDetails, openHomeFolder, wantedOf, type Marked } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { ASK_READER, defaultAccess, fullAccess } from "./access.js";
import { ACCESS_S, DISCONNECTED_REFRESH, EXCHANGE_MS, NOTE_MOST, NOTE_TOOL_MOST, NOTES_A_DAY, REQUEST_MS, WAITING_MOST, type Added, type Granted, type Listed, type Note, type Tokens, type Waiting } from "./agents.js";
import { runCli } from "./cli.js";
import { serveDoor } from "./door.js";
import { keepPublic, noteReach, publicOff, publicOn, reachIdle, type Kept, type PublicState } from "./funnel.js";
import { startHome, type Home } from "./home.js";
import { adopt } from "./lifecycle.js";
import { machine } from "./machine.js";
import { hashToken, mintPrincipal, readPrincipals, writePrincipals } from "./principals.js";
import { homeOf, loadRegistry } from "./registry.js";
import { effective } from "./settings.js";
import { ask, askHome, type HomeSocket } from "./socket.js";
import { FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { DEVICE, REPO, wordsAt, wordsOnly } from "./test/support.js";

const report: Record<string, unknown> = {};
afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "agents.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const PHONE_UNIT = "iphone-17-pro-aa01";
const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const RESOURCE = "https://macbook-pro-0001.tail0000.ts.net/mcp";
const DNS = "macbook-pro-0001.tail0000.ts.net";
const ORIGIN = `https://${DNS}`;
const OURS = "http://127.0.0.1:4683";
const ENABLE = "https://login.tailscale.com/f/funnel?node=nFAKE0001";
const SELF = { DNSName: `${DNS}.`, CapMap: { https: null, funnel: null } };
const OTHER = { "/v1/": { Proxy: "http://127.0.0.1:4680" } };
const TAKEN = "Tailscale already serves something else at this address";
const FUNNEL_ON = "Tailscale serves something else at this address, and Funnel is on for it: check Tailscale's serve settings";
const TAKEN_LINE = "Tailscale serves something else at its address";

interface Answer { status: number; body: Record<string, unknown> }

async function running(prefix: string, steps: Record<string, unknown>, random?: (bytes: number) => Buffer) {
  let now = Date.UTC(2026, 9, 28, 9, 0);
  const clock = () => now;
  const root = makeRoot(prefix, { sources: {} });
  const dir = mkdtempSync(join(tmpdir(), "lifestream-agents-machine-"));
  const tailscale = join(dir, "fake-tailscale", "tailscale");
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: TEST_UNIT, tailscale }));
  const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
  await adopt(root, { machine: at, now: clock });
  const principals = openHomeFolder(root);
  const pass = () => randomBytes(32).toString("base64url");
  const passes = { reader: pass(), phone: pass(), extension: pass() };
  mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: 0 });
  mintPrincipal(principals, { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${PHONE_UNIT}`], token: passes.phone, now_ms: 0 });
  mintPrincipal(principals, { unit: "chrome-0001", kind: "extension", scopes: ["station"], token: passes.extension, now_ms: 0 });
  const logs: string[] = [];
  const start = () => startHome(root, { lookMs: LOOK_MS, registry: FAKES, clock, machine: at, log: (line) => logs.push(line), tickMs: TICK_MS, stopGraceMs: 50, ...(random === undefined ? {} : { random }) });
  const lines: string[] = [];
  const door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { lookMs: LOOK_MS, log: (line) => lines.push(line), clock, registry: FAKES, machine: at });
  editSettings(root, { "door.port": door.port });
  let home: Home = await start();
  onTestFinished(async () => {
    await door.close();
    await home.stop();
    removeRoot(root);
    rmSync(dir, { recursive: true, force: true });
  });
  const lan = (JSON.parse(lines.find((line) => line.includes('"door":"open"'))!) as { lan: number }).lan;
  const url = `http://127.0.0.1:${door.port}`;
  const sock = testSocket(root, at.dir);
  const token = (reader: string) => readFileSync(join(dir, reader, "door-token"), "utf8").trim();
  const mcp = token("mcp");
  let asked = 0;

  const call = async (step: string, method: string, path: string, bearer: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`${url}${path}`, {
      method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    });
    const text = await response.text();
    const answer: Answer = { status: response.status, body: text === "" ? {} : JSON.parse(text) as Record<string, unknown> };
    steps[`${(asked += 1).toString().padStart(3, "0")} ${step}`] = { method, path, status: answer.status, ...(typeof answer.body.code === "string" ? { code: answer.body.code } : {}) };
    return answer;
  };
  const overLan = (path: string, bearer: string): Promise<Answer> => new Promise((resolve, reject) => {
    const asking = tlsRequest({ host: "127.0.0.1", port: lan, method: "GET", path, headers: { authorization: `Bearer ${bearer}` }, rejectUnauthorized: false, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown> }));
    });
    asking.on("error", reject);
    asking.end();
  });
  const phone = { authorization: passes.phone, headers: DEVICE.phone };
  const request = async (step: string, card: { name: string; checked: boolean; host: string | null } = { name: "Claude", checked: true, host: "claude.ai" }) =>
    call(step, "POST", "/v1/agents/request", mcp, card);
  const waiting = async (step: string) => (await call(step, "GET", "/v1/agents/waiting", phone.authorization, undefined, phone.headers)).body.requests as Waiting[];
  const answer = (step: string, id: string, pick: string | "deny") => call(step, "POST", "/v1/agents/answer", phone.authorization, { id, answer: pick }, phone.headers);
  const state = async (step: string, id: string) => (await call(step, "GET", `/v1/agents/request/${id}`, mcp)).body.state;
  const grant = (step: string, id: string, asked: { client_id: string; resource: string } = { client_id: CLIENT, resource: RESOURCE }) =>
    call(step, "POST", "/v1/agents/grant", mcp, { id, ...asked });
  const refresh = (step: string, refresh_token: string, asked: { client_id: string; resource: string } = { client_id: CLIENT, resource: RESOURCE }) =>
    call(step, "POST", "/v1/agents/refresh", mcp, { refresh_token, ...asked });
  const me = (step: string, bearer: string, headers: Record<string, string> = {}) => call(step, "GET", "/v1/me", bearer, undefined, headers);
  const signIn = async (step: string, card?: { name: string; checked: boolean; host: string | null }) => {
    const made = await request(`${step}: request`, card);
    expect(made.status).toBe(200);
    const { id, code } = made.body as { id: string; code: string };
    expect((await answer(`${step}: the page's code`, id, code)).body).toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    const granted = await grant(`${step}: grant`, id);
    expect(granted.status).toBe(200);
    return { id, grant: (granted.body as unknown as Granted).grant, tokens: granted.body as unknown as Tokens };
  };
  const revokedEvents = (pass: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'pass-revoked' AND key = ?").pluck().get(pass) as number);
  return {
    root, dir, at, sock, url, logs, passes, mcp, principals, phone, call, overLan, request, waiting, answer, state, grant, refresh, me, signIn, token, revokedEvents,
    tick: (ms: number) => { now += ms; },
    async restart(between: () => void = () => undefined) {
      await home.stop();
      between();
      home = await start();
    },
  };
}

describe("agents", () => {
  it("an agent's pass does more than GET the read routes and /v1/me, or reads from the Wi-Fi; a copied pass's lines say other than its answer, put the pass inside a command a shell keeps, or name a command the Mac lacks", async () => {
    const steps: Record<string, unknown> = {};
    report.gate = steps;
    const at = await running("lifestream-agents-gate-", steps);
    const lines: string[] = [];
    const added = await askHome(at.sock, "agents", ["add", "Hermes"], (line) => lines.push(line)) as Added;
    expect(added.agent).toMatchObject({ name: "Hermes", via: "pass", from: null, checked: false });
    expect(lines).toEqual([
      `a pass for Hermes, ${added.agent.id}: shown once, stored nowhere`,
      `pass: ${added.pass}`,
      `Claude Code: run this, then paste the pass: ${added.claude_code}`,
      "Claude Desktop: add this to its claude_desktop_config.json:",
      ...added.claude_desktop.split("\n"),
    ]);
    expect(added.claude_code).not.toContain(added.pass);
    const bin = mkdtempSync(join(tmpdir(), "lifestream-claude-"));
    onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nfor each in \"$@\"; do printf '%s\\n' \"$each\"; done\n");
    chmodSync(join(bin, "claude"), 0o755);
    const pasted = spawnSync("bash", ["-c", `${added.claude_code}; echo "left:$LIFESTREAM_PASS"`], { input: `${added.pass}\n`, encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
    expect([pasted.status, pasted.stdout.split("\n").slice(1)]).toEqual([0, ["mcp", "add", "--transport", "http", "lifestream", "http://127.0.0.1:4681/mcp", "--header", `Authorization: Bearer ${added.pass}`, "left:", ""]]);
    const current = join(at.dir, "current");
    expect(JSON.parse(added.claude_desktop)).toEqual({
      mcpServers: { lifestream: { command: join(current, "node"), args: [join(current, "mcp", "server.mjs"), "--stdio"], env: { LIFESTREAM_PASS: added.pass, LIFESTREAM_DOOR: at.url, LIFESTREAM_MACHINE_DIR: at.dir } } },
    });
    const signed = await at.signIn("sign-in");

    for (const [who, pass, resource] of [["copied", added.pass, null], ["signed in", signed.tokens.access_token, RESOURCE]] as const) {
      const alone = await at.call(`${who}: count alone`, "POST", "/v1/count", pass, { args: {} });
      const besideReader = await at.call(`${who}: count beside a reader's pass`, "POST", "/v1/count", pass, { args: {} }, { "lifestream-server": at.passes.reader });
      expect([alone.status, alone.body.code, besideReader.status, besideReader.body.code], `${who} alone`).toEqual([403, "THROUGH_SERVER", 403, "THROUGH_SERVER"]);
      expect((await at.call(`${who}: count`, "POST", "/v1/count", pass, { args: {} }, { "lifestream-server": at.mcp })).status, `${who} reads`).not.toBe(403);
      expect((await at.call(`${who}: status`, "GET", "/v1/status", pass, undefined, { "lifestream-server": at.mcp })).body.code, `${who} reads by POST alone`).toBe("PRINCIPAL_SCOPE");
      expect((await at.me(`${who}: me`, pass)).body).toEqual({ id: expect.any(String), kind: "agent", resource });
      const refused = [
        await at.call(`${who}: act`, "POST", "/v1/act", pass, { need: "fetch:fake-poll", do: "try" }),
        await at.call(`${who}: Ask's chats`, "GET", "/v1/ask/chats", pass),
        await at.call(`${who}: Ask`, "POST", "/v1/ask", pass, { message: "hello" }),
        await at.call(`${who}: a setting`, "POST", "/v1/settings", pass, { connector: "whatsapp", member: "refresh", value: "10m" }),
        await at.call(`${who}: a people edit`, "POST", "/v1/owner/act", pass, { of: "people", request: "r-1", kind: "name" }),
        await at.call(`${who}: a delivery`, "PUT", "/v1/acquisitions/apple-notes:local:poll/20261028T090000Z", pass, {}),
        await at.call(`${who}: an exchange`, "POST", "/v1/exchange", pass, {}),
        await at.call(`${who}: the wanted photos`, "GET", "/v1/photos/wanted?source=photos:local:macbook-pro-0001", pass),
        await at.call(`${who}: the stations`, "GET", "/v1/stations", pass),
        await at.call(`${who}: a request`, "POST", "/v1/agents/request", pass, { name: "Claude", checked: true, host: "claude.ai" }),
        await at.call(`${who}: the waiting`, "GET", "/v1/agents/waiting", pass),
      ];
      expect(refused.map((each) => [each.status, each.body.code]), `${who} is refused all but reads`).toEqual(refused.map(() => [403, "PRINCIPAL_SCOPE"]));
      const lan = await at.overLan("/v1/status", pass);
      expect([lan.status, lan.body.code], `${who} from the Wi-Fi`).toEqual([403, "PRINCIPAL_SCOPE"]);
      steps[`${who}: status from the Wi-Fi`] = { status: lan.status, code: lan.body.code };
    }
    const mcp = readPrincipals(at.principals).principals.find((row) => row.token_sha256 === hashToken(at.mcp))!;
    expect(mcp).toMatchObject({ unit: "mcp", kind: null, scopes: ["admit"], revoked_at: null });
    expect((await at.me("mcp: me", at.mcp)).body).toEqual({ id: mcp.id, kind: null, resource: null });
    expect((await at.call("mcp: status", "GET", "/v1/status", at.mcp)).status).toBe(403);
    await at.restart();
    expect(at.token("mcp"), "a restart keeps the MCP server's pass").toBe(at.mcp);
  });

  it("only a pass that may widen reads the waiting or answers (a reader's is the person's, but may not widen); a pass without admit, or a phone's, asks for a request", async () => {
    const steps: Record<string, unknown> = {};
    report.answerers = steps;
    const at = await running("lifestream-agents-answerers-", steps);
    const made = await at.request("request");
    const { id, code } = made.body as { id: string; code: string };
    const copied = (await askHome(at.sock, "agents", ["add", "Hermes"]) as Added).pass;
    for (const [who, pass, headers, code] of [["reader", at.passes.reader, {}, "PERSON_ONLY"], ["agent", copied, {}, "PRINCIPAL_SCOPE"], ["extension", at.passes.extension, DEVICE.extension, "PRINCIPAL_SCOPE"]] as const) {
      const read = await at.call(`${who}: waiting`, "GET", "/v1/agents/waiting", pass, undefined, headers);
      const answered = await at.call(`${who}: answer`, "POST", "/v1/agents/answer", pass, { id, answer: code }, headers);
      expect([read.status, read.body.code, answered.status, answered.body.code], who).toEqual([403, code, 403, code]);
    }
    for (const [who, pass, headers] of [["reader", at.passes.reader, {}], ["phone", at.passes.phone, DEVICE.phone]] as const) {
      const asked = await at.call(`${who}: request`, "POST", "/v1/agents/request", pass, { name: "Claude", checked: true, host: "claude.ai" }, headers);
      const granted = await at.call(`${who}: grant`, "POST", "/v1/agents/grant", pass, { id, client_id: CLIENT, resource: RESOURCE }, headers);
      expect([asked.status, granted.status], who).toEqual([403, 403]);
    }
    expect(await at.state("still waiting", id)).toBe("waiting");
    const card = (await at.waiting("phone: waiting")).find((each) => each.id === id)!;
    const mac = (await askHome(at.sock, "agents", ["waiting"]) as { requests: Waiting[] }).requests;
    expect(mac).toEqual([card]);
    expect(card).toMatchObject({ name: "Claude", checked: true, host: "claude.ai", until_ms: Date.UTC(2026, 9, 28, 9, 0) + REQUEST_MS });
    expect(card, "the one who answers never sees the code: only the page does").not.toHaveProperty("choices");
    expect(JSON.stringify([card, mac])).not.toContain(`"${code}"`);
  });

  it("a grant is made before the page's code is answered; a wrong code, Don't allow, ten minutes or a restart leaves a request standing", async () => {
    const steps: Record<string, unknown> = {};
    report.answers = steps;
    const at = await running("lifestream-agents-answers-", steps);
    const ask = async (step: string) => (await at.request(step)).body as { id: string; code: string };

    const early = await ask("early: request");
    expect([(await at.grant("early: grant before any answer", early.id)).body.code, await at.state("early: state", early.id)]).toEqual(["AGENT_NOT_APPROVED", "waiting"]);

    const wrong = await ask("wrong: request");
    const other = wrong.code === "000000" ? "000001" : "000000";
    expect((await at.answer("wrong: another code", wrong.id, other)).body).toEqual({ state: "wrong", version: null, outcome: wordsOnly("Wrong code, so Claude wasn’t let in. Start the sign-in again in Claude."), reader: null, connected: null });
    expect(await at.state("wrong: state", wrong.id)).toBe("wrong");
    expect((await at.grant("wrong: grant", wrong.id)).body.code).toBe("AGENT_NOT_APPROVED");
    const again = await at.answer("wrong: answered again", wrong.id, wrong.code);
    expect([again.status, again.body, await at.state("wrong: state again", wrong.id)]).toEqual([200, { state: "wrong", version: null, outcome: wordsOnly("Wrong code, so Claude wasn’t let in. Start the sign-in again in Claude."), reader: null, connected: null }, "wrong"]);
    const signIn = (step: string, id: string) => at.call(step, "GET", `/v1/agents/signins/${id}`, at.passes.phone, undefined, DEVICE.phone);
    expect((await signIn("wrong: read on the Mac after the iPhone answered", wrong.id)).body, "a sign-in answered elsewhere says what became of it")
      .toEqual({ id: wrong.id, state: "wrong", outcome: wordsOnly("Wrong code, so Claude wasn’t let in. Start the sign-in again in Claude."), reader: null, connected: null });

    const denied = await ask("deny: request");
    expect(await askHome(at.sock, "agents", ["answer", "--", denied.id, "deny"])).toEqual({ state: "denied", version: null, outcome: wordsAt("Not allowed on Mac,", expect.any(Number)), reader: null, connected: null });
    expect([await at.state("deny: state", denied.id), (await at.grant("deny: grant", denied.id)).body.code]).toEqual(["denied", "AGENT_NOT_APPROVED"]);
    expect(await askHome(at.sock, "agents", ["answer", "--", denied.id, denied.code])).toEqual({ state: "denied", version: null, outcome: wordsAt("Not allowed on Mac,", expect.any(Number)), reader: null, connected: null });

    const late = await ask("late: request");
    expect((await signIn("late: still waiting", late.id)).body).toEqual({ id: late.id, state: "waiting", outcome: null, reader: null, connected: null });
    at.tick(REQUEST_MS);
    const over = await signIn("late: read once the home's clock passed its end", late.id);
    expect([over.status, over.body], "over by the home's clock, never the device's: gone").toEqual([200, { id: late.id, state: "gone", outcome: null, reader: null, connected: null }]);
    expect(await at.state("late: ten minutes on", late.id)).toBe("gone");
    const tooLate = await at.answer("late: the page's code", late.id, late.code);
    expect([tooLate.status, tooLate.body.code, (await at.grant("late: grant", late.id)).body.code]).toEqual([404, "AGENT_REQUEST_GONE", "AGENT_NOT_APPROVED"]);
    expect(await at.waiting("late: waiting")).toEqual([]);

    const restarted = await ask("restart: request");
    expect((await at.answer("restart: the page's code", restarted.id, restarted.code)).body).toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    expect((await signIn("restart: read before the restart", restarted.id)).body).toEqual({ id: restarted.id, state: "approved", outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    await at.restart();
    expect([await at.state("restart: state", restarted.id), (await at.grant("restart: grant", restarted.id)).body.code]).toEqual(["gone", "AGENT_NOT_APPROVED"]);
    expect((await signIn("restart: read after the restart", restarted.id)).body, "a restart reads as gone, never as waiting").toEqual({ id: restarted.id, state: "gone", outcome: null, reader: null, connected: null });
    expect(readPrincipals(at.principals).principals.filter((row) => row.kind === "agent")).toEqual([]);
  });

  it("a sign-in reads Connected only once the other app exchanged its code, gone once its code can no longer be exchanged or its reader is disconnected; the sign-in page's name and line are the home's, calm only from a guide's own host", async () => {
    const steps: Record<string, unknown> = {};
    report.connected = steps;
    const at = await running("lifestream-agents-connected-", steps);
    const read = (step: string, id: string) => at.call(step, "GET", `/v1/agents/signins/${id}`, at.passes.phone, undefined, DEVICE.phone);

    const pages = [
      [{ name: "Claude", checked: true, host: "claude.ai" }, "Claude", "From claude.ai"],
      [{ name: "Meta AI", checked: false, host: "agent.meta.ai" }, "Muse", "From agent.meta.ai, where Muse runs"],
      [{ name: "Muse", checked: false, host: "agent.example" }, "Muse", "says it is Muse, sending access to agent.example"],
      [{ name: "ChatGPT", checked: false, host: "chatgpt.com.example.com" }, "ChatGPT", "says it is ChatGPT, sending access to chatgpt.com.example.com"],
      [{ name: "ChatGPT", checked: true, host: "chatgpt.example" }, "ChatGPT", "from chatgpt.example"],
      [{ name: "Local", checked: false, host: null }, "Local", "says it is Local, an app on the computer you are signing in from"],
    ] as const;
    for (const [card, name, line] of pages) {
      const made = await at.request(`page: ${card.name} from ${card.host}`, card);
      expect([made.status, made.body.name, made.body.line], `${card.name} from ${card.host}`).toEqual([200, name, line]);
      await at.answer(`page: ${card.name} from ${card.host}, turned away so the next one fits`, made.body.id as string, "deny");
    }

    const made = (await at.request("connect: request")).body as { id: string; code: string };
    expect((await at.answer("connect: the page's code", made.id, made.code)).body, "the yes alone holds no reader").toMatchObject({ state: "approved", reader: null, connected: null });
    expect((await read("connect: finishing", made.id)).body, "approved, the other app not yet holding its access: finishing").toMatchObject({ state: "approved", reader: null, connected: null });
    const granted = await at.grant("connect: the other app exchanges its code", made.id);
    const reader = (granted.body as unknown as Granted).grant;
    const connected = { reader, line: expect.stringMatching(/^It sees .+\. Change it any time in Agents\.$/u) };
    expect((await read("connect: connected", made.id)).body, "Connected, with the line of the access it was granted").toEqual({
      id: made.id, state: "approved", outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader, connected,
    });
    expect((await at.answer("connect: answered again after the exchange", made.id, made.code)).body, "a lost reply's retry says Connected too").toMatchObject({ state: "approved", reader, connected });

    const lapsed = (await at.request("lapse: request")).body as { id: string; code: string };
    await at.answer("lapse: the page's code", lapsed.id, lapsed.code);
    at.tick(EXCHANGE_MS - 1);
    expect((await read("lapse: finishing", lapsed.id)).body).toMatchObject({ state: "approved", reader: null });
    at.tick(1);
    expect((await read("lapse: the code can no longer be exchanged", lapsed.id)).body, "Finishing ends: the guide says it did not finish").toMatchObject({ state: "gone", reader: null, connected: null });
    expect([await at.state("lapse: the sign-in page", lapsed.id), (await at.grant("lapse: exchanged too late", lapsed.id)).body.code]).toEqual(["gone", "AGENT_NOT_APPROVED"]);
    expect((await read("connect: connected past the exchange's time", made.id)).body, "a reader that holds its access stays Connected").toMatchObject({ state: "approved", reader });

    expect((await at.call("connect: disconnected", "POST", `/v1/agents/${reader}/disconnect`, at.passes.phone, {}, DEVICE.phone)).status).toBe(200);
    expect((await read("connect: its reader disconnected", made.id)).body, "a revoked grant never reads Connected").toMatchObject({ state: "gone", reader: null, connected: null });
  });

  it("each waiting sign-in has a 6-digit code nobody who answers sees, a fourth waits, or an answered request keeps its place", async () => {
    const steps: Record<string, unknown> = {};
    report.places = steps;
    const at = await running("lifestream-agents-places-", steps);
    const made: { id: string; code: string }[] = [];
    for (let each = 0; each < WAITING_MOST; each += 1) made.push((await at.request(`request ${each + 1}`, { name: `Agent ${each + 1}`, checked: false, host: null })).body as { id: string; code: string });
    expect(made.every((each) => /^[0-9]{6}$/u.test(each.code))).toBe(true);
    const cards = await at.waiting("all waiting");
    expect(cards.map((card) => card.id)).toEqual(made.map((each) => each.id));
    for (const card of cards) expect(card).not.toHaveProperty("choices");
    const crowded = await at.request("one more");
    expect([crowded.status, crowded.body.code]).toEqual([429, "AGENTS_WAITING"]);
    await at.answer("one answered", made[0]!.id, "deny");
    expect((await at.request("one more, once one is answered")).status).toBe(200);
  });

  it("a second grant leaves the first standing; an expired token reads; a refresh leaves the old token reading or renews another client's; an earlier refresh token renews, also after a restart", async () => {
    const steps: Record<string, unknown> = {};
    report.tokens = steps;
    const at = await running("lifestream-agents-tokens-", steps);

    const twice = await at.signIn("twice");
    const second = await at.grant("twice: second grant", twice.id);
    expect([second.status, second.body.code]).toEqual([409, "AGENT_GRANTED"]);
    expect((await at.me("twice: first access", twice.tokens.access_token)).status).toBe(401);
    expect((await at.refresh("twice: first refresh", twice.tokens.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect(at.revokedEvents(twice.grant), "a second grant's revoke is an event").toBe(1);

    const replayed = await at.signIn("replay");
    const renewed = (await at.refresh("replay: turn 1", replayed.tokens.refresh_token)).body as unknown as Tokens;
    const older = readFileSync(join(at.principals.root, "config", "principals.json"), "utf8");
    expect((await at.refresh("replay: the previous refresh, again", replayed.tokens.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.refresh("replay: the newest refresh, after the replay", renewed.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.me("replay: the newest access, after the replay", renewed.access_token)).status).toBe(401);
    expect(at.revokedEvents(replayed.grant), "a refresh replay's revoke is an event").toBe(1);
    await at.restart(() => writeFileSync(join(at.principals.root, "config", "principals.json"), older));
    expect((await at.me("replay: the newest access, after the older file is put back", renewed.access_token)).status).toBe(401);
    expect((await at.refresh("replay: the newest refresh, after the older file is put back", renewed.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect(readPrincipals(at.principals).principals.find((row) => row.id === replayed.grant)!.revoked_at).not.toBeNull();

    const { tokens } = await at.signIn("claude", { name: "Claude", checked: true, host: "claude.ai" });
    expect(tokens.expires_in).toBe(ACCESS_S);
    const row = () => readPrincipals(at.principals).principals.find((each) => each.kind === "agent" && each.revoked_at === null)!;
    expect(row()).toMatchObject({ unit: "agent", scopes: ["read"], agent: { name: "Claude", via: "sign-in", from: "claude.ai", checked: true, client_id: CLIENT, resource: RESOURCE } });
    expect((await at.me("claude: reads", tokens.access_token)).status).toBe(200);
    at.tick(ACCESS_S * 1_000);
    const expired = await at.me("claude: an hour on", tokens.access_token);
    expect([expired.status, expired.body.code]).toEqual([401, "PRINCIPAL_UNKNOWN"]);

    expect((await at.refresh("claude: another client", tokens.refresh_token, { client_id: "https://example.com/client", resource: RESOURCE })).body.code).toBe("INVALID_GRANT");
    expect((await at.refresh("claude: another resource", tokens.refresh_token, { client_id: CLIENT, resource: "https://example.com/mcp" })).body.code).toBe("INVALID_GRANT");
    const turns: Tokens[] = [tokens];
    for (let turn = 1; turn <= 4; turn += 1) {
      const renewed = await at.refresh(`claude: turn ${turn}`, turns.at(-1)!.refresh_token);
      expect(renewed.status).toBe(200);
      turns.push(renewed.body as unknown as Tokens);
    }
    const [first, ...rest] = turns;
    expect(new Set(turns.map((each) => each.access_token)).size).toBe(turns.length);
    expect(new Set(turns.map((each) => each.refresh_token)).size).toBe(turns.length);
    expect(new Set(rest.map((each) => each.refresh_token.split(".")[0])).size).toBe(1);
    expect(rest[0]!.refresh_token.split(".")[0]).toBe(first!.refresh_token.split(".")[0]);
    const now = turns.at(-1)!;
    expect((await at.me("claude: the newest access", now.access_token)).status).toBe(200);
    expect((await at.me("claude: the access before it, within its hour", turns.at(-2)!.access_token)).status).toBe(401);

    await at.restart();
    expect((await at.refresh("claude: the previous refresh, after a restart", turns.at(-2)!.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.refresh("claude: the newest refresh, after the replay", now.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.me("claude: the newest access, after the replay", now.access_token)).status).toBe(401);

    const back = await at.signIn("back");
    const backTurns: Tokens[] = [back.tokens];
    for (let turn = 1; turn <= 3; turn += 1) backTurns.push((await at.refresh(`back: turn ${turn}`, backTurns.at(-1)!.refresh_token)).body as unknown as Tokens);
    await at.restart();
    expect((await at.refresh("back: three turns back", backTurns[0]!.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.refresh("back: the newest", backTurns.at(-1)!.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.me("back: the newest access", backTurns.at(-1)!.access_token)).status).toBe(401);
    expect(readPrincipals(at.principals).principals.filter((each) => each.kind === "agent").map((each) => each.revoked_at === null)).toEqual([false, false, false, false]);

    const later = await at.signIn("a newer release's member");
    const raw = () => JSON.parse(readFileSync(join(at.principals.root, "config", "principals.json"), "utf8")) as { principals: { id: string; agent?: Record<string, unknown> }[] };
    const written = raw();
    writeFileSync(join(at.principals.root, "config", "principals.json"), `${JSON.stringify({ ...written, principals: written.principals.map((row) => row.id === later.grant ? { ...row, agent: { ...row.agent, approved_on: { unit: PHONE_UNIT } } } : row) }, null, 2)}\n`);
    expect((await at.refresh("a newer release's member: refresh", later.tokens.refresh_token)).status).toBe(200);
    const kept = raw().principals.find((row) => row.id === later.grant)!;
    steps["a newer release's member: after the refresh"] = { approved_on: kept.agent?.approved_on ?? null };
    expect(kept.agent).toMatchObject({ name: "Claude", via: "sign-in", request: later.id, approved_on: { unit: PHONE_UNIT } });
  });

  it("Lifestream-Reach: public takes a copied pass without --anywhere, the dashboard's or a phone's; a sign-in's grant or a pass from anywhere reads only with it or only without it; --anywhere is not what the grant states", async () => {
    const steps: Record<string, unknown> = {};
    report.reach = steps;
    const at = await running("lifestream-agents-reach-", steps);
    const PUBLIC = { "lifestream-reach": "public" };
    const lines: string[] = [];
    const added = await askHome(at.sock, "agents", ["add", "Hermes"]) as Added;
    const copied = added.pass;
    const vault = await askHome(at.sock, "agents", ["add", "--anywhere", "--", "Vault App"], (line) => lines.push(line)) as Added;
    const signed = await at.signIn("sign-in");
    steps["--anywhere: the answer's agent"] = vault.agent;
    expect([added.agent.anywhere, vault.agent.anywhere]).toEqual([false, true]);
    expect(lines[0]).toBe(`a pass for Vault App, ${vault.agent.id}, from anywhere: shown once, stored nowhere`);
    const rows = readPrincipals(at.principals).principals.filter((row) => row.kind === "agent");
    expect(rows.map((row) => [row.agent!.name, row.agent!.anywhere ?? null])).toEqual([["Hermes", null], ["Vault App", true], ["Claude", null]]);
    expect(((await askHome(at.sock, "agents", ["list"])) as { agents: Listed[] }).agents.map((each) => [each.name, each.anywhere]))
      .toEqual([["Hermes", false], ["Vault App", true], ["Claude", false]]);
    await expect(askHome(at.sock, "agents", ["list", "--anywhere"])).rejects.toThrow(/--anywhere is add's alone/u);
    for (const [who, pass, headers] of [["copied", copied, {}], ["dashboard", at.token("dashboard"), {}], ["phone", at.passes.phone, DEVICE.phone], ["mcp", at.mcp, {}]] as const) {
      const refused = await at.call(`${who}: status, public`, "GET", "/v1/status", pass, undefined, { ...headers, ...PUBLIC });
      const asked = await at.me(`${who}: me, public`, pass, { ...headers, ...PUBLIC });
      expect([refused.status, refused.body.code, asked.status], who).toEqual([401, "PRINCIPAL_UNKNOWN", 401]);
      expect((await at.me(`${who}: me`, pass, headers)).status, `${who} without the header`).toBe(200);
    }
    const server = { "lifestream-server": at.mcp };
    expect([401, 403]).not.toContain((await at.call("sign-in: count, public", "POST", "/v1/count", signed.tokens.access_token, { args: {} }, { ...PUBLIC, ...server })).status);
    expect((await at.me("sign-in: me, public", signed.tokens.access_token, PUBLIC)).body).toMatchObject({ kind: "agent" });
    expect([401, 403]).not.toContain((await at.call("sign-in: count", "POST", "/v1/count", signed.tokens.access_token, { args: {} }, server)).status);
    expect([401, 403]).not.toContain((await at.call("anywhere: count, public", "POST", "/v1/count", vault.pass, { args: {} }, { ...PUBLIC, ...server })).status);
    expect((await at.me("anywhere: me, public", vault.pass, PUBLIC)).body).toEqual({ id: vault.agent.id, kind: "agent", resource: null });
    expect([401, 403]).not.toContain((await at.call("anywhere: count", "POST", "/v1/count", vault.pass, { args: {} }, server)).status);
    expect((await at.call("anywhere: act, public", "POST", "/v1/act", vault.pass, { need: "fetch:fake-poll", do: "try" }, PUBLIC)).status).toBe(403);
    expect((await at.overLan("/v1/status", vault.pass)).status).toBe(403);
    expect(await askHome(at.sock, "agents", ["disconnect", vault.agent.id])).toEqual({});
    expect((await at.me("anywhere removed: me, public", vault.pass, PUBLIC)).status).toBe(401);

    const file = readPrincipals(at.principals);
    const restated = (name: string, anywhere: unknown) => () => writePrincipals(at.principals, { ...file, principals: file.principals.map((row) =>
      row.agent?.name === name ? { ...row, agent: { ...row.agent, anywhere } as unknown as NonNullable<typeof row.agent> } : row) });
    expect(restated("Claude", true)).toThrow(/a sign-in states no anywhere/u);
    expect(restated("Hermes", false)).toThrow(/anywhere is true when it is stated/u);
    expect(restated("Hermes", "yes")).toThrow(/anywhere is true when it is stated/u);
  });

  it("after agents disconnect the agent reads or refreshes; a suspended grant refreshes; the list shows a disconnected agent", async () => {
    const steps: Record<string, unknown> = {};
    report.remove = steps;
    const at = await running("lifestream-agents-remove-", steps);
    const added = await askHome(at.sock, "agents", ["add", "Hermes"]) as Added;
    const claude = await at.signIn("claude", { name: "Claude", checked: true, host: "claude.ai" });
    const code = await at.signIn("code", { name: "Claude Code", checked: false, host: null });
    const listed = async (step: string) => {
      const answer = await askHome(at.sock, "agents") as { agents: Listed[]; public: PublicState };
      steps[step] = answer.agents.map(({ name, via, from, checked }) => ({ name, via, from, checked }));
      return answer.agents;
    };
    const before = await listed("the list");
    expect(before.map(({ name, via, from, checked }) => ({ name, via, from, checked }))).toEqual([
      { name: "Hermes", via: "pass", from: null, checked: false },
      { name: "Claude", via: "sign-in", from: "claude.ai", checked: true },
      { name: "Claude Code", via: "sign-in", from: null, checked: false },
    ]);
    const claudeId = before[1]!.id;
    const ada: Marked[] = [{ text: "Ada Example", marks: [{ start: 0, end: 11, type: "person", who: "p-ada" }] }];
    const ledger = openLedger(openHomeFolder(at.root), { mode: "write" });
    onTestFinished(() => ledger.close());
    const served = ledger.placeholders.part(`grant:${claudeId}`, wantedOf(ada));
    expect(ledger.placeholders.save(served, hideDetails(ada, "all", served.table, null).table)).toMatchObject({ saved: true });
    const inFlight = ledger.placeholders.part(`grant:${claudeId}`, wantedOf(ada));
    expect(inFlight.table.entries).not.toEqual([]);

    for (const each of before) {
      expect(ledger.access.get(each.id), `${each.name} is minted with the default access`).toMatchObject({ version: 1, lines: defaultAccess() });
      expect(ledger.access.changes(each.id, { limit: 10 }).map(({ what, by, version }) => ({ what, by, version }))).toEqual([{ what: "granted", by: "person", version: 1 }]);
    }
    expect(readPrincipals(at.principals).principals.find((row) => row.id === claudeId)!.agent).not.toHaveProperty("level");
    await expect(askHome(at.sock, "agents", ["level", "--", claudeId, "none"]), "agents level is gone").rejects.toThrow(/usage/u);

    expect(await askHome(at.sock, "agents", ["disconnect", claudeId])).toEqual({});
    expect(at.revokedEvents(claudeId), "a removal is an event").toBe(1);
    expect(ledger.access.get(claudeId), "a disconnected agent's access goes with its pass").toBeUndefined();
    expect(ledger.access.changes(claudeId, { limit: 1 })[0]).toMatchObject({ what: "removed", by: "person", version: 2, lines: null });
    expect(ledger.placeholders.part(`grant:${claudeId}`, wantedOf(ada))).toMatchObject({ table: { entries: [] }, version: -1 });
    expect(ledger.placeholders.save(inFlight, hideDetails(ada, "all", inFlight.table, null).table)).toEqual({ dropped: true });
    expect((await at.me("removed: reads", claude.tokens.access_token)).status).toBe(401);
    expect((await at.refresh("removed: refresh", claude.tokens.refresh_token)).body, "a disconnected agent's refresh says so").toMatchObject({ code: "INVALID_GRANT", message: DISCONNECTED_REFRESH });
    expect(await askHome(at.sock, "agents", ["disconnect", before[0]!.id])).toEqual({});
    expect((await at.me("removed copied pass: reads", added.pass)).status).toBe(401);
    expect((await listed("after two removed")).map((each) => each.name)).toEqual(["Claude Code"]);

    const file = readPrincipals(at.principals);
    writePrincipals(at.principals, { ...file, principals: file.principals.map((row) => row.agent?.name === "Claude Code" ? { ...row, suspended_at: new Date(0).toISOString() } : row) });
    expect((await at.refresh("suspended: refresh", code.tokens.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect((await at.me("suspended: reads", code.tokens.access_token)).status).toBe(401);
    const resumed = readPrincipals(at.principals);
    writePrincipals(at.principals, { ...resumed, principals: resumed.principals.map((row) => ({ ...row, suspended_at: null })) });
    expect((await at.refresh("resumed: refresh", code.tokens.refresh_token)).status, "a suspension ends nothing: resumed, it renews").toBe(200);
  });

  it("a revoke by the grant's id or by its request, after a restart, leaves it standing; a request revoked before its grant is granted; a revoke ends a pass no sign-in made, or appends no event", async () => {
    const steps: Record<string, unknown> = {};
    report.revoke = steps;
    const at = await running("lifestream-agents-revoke-", steps);
    const signed = await at.signIn("sign-in");
    const copied = await askHome(at.sock, "agents", ["add", "Hermes"]) as Added;
    await at.restart();
    const revoke = (step: string, grant: unknown) => at.call(step, "POST", "/v1/agents/revoke", at.mcp, { grant });
    expect([(await revoke("revoke after a restart", signed.grant)).status, (await revoke("revoke again", signed.grant)).status]).toEqual([200, 200]);
    expect((await at.me("revoked: reads", signed.tokens.access_token)).status).toBe(401);
    expect((await at.refresh("revoked: refresh", signed.tokens.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect(at.revokedEvents(signed.grant), "one revoke, one event").toBe(1);
    const phone = readPrincipals(at.principals).principals.find((row) => row.kind === "phone")!;
    const mcp = readPrincipals(at.principals).principals.find((row) => row.token_sha256 === hashToken(at.mcp))!;
    for (const [who, id] of [["copied", copied.agent.id], ["phone", phone.id], ["mcp", mcp.id], ["unknown", "p-00000000"], ["no id", 7]] as const) {
      expect((await revoke(`revoke the ${who}`, id)).body, who).toEqual({});
    }
    expect((await at.me("copied: reads", copied.pass)).status).toBe(200);
    expect((await at.call("phone: reads", "GET", "/v1/status", at.passes.phone, undefined, DEVICE.phone)).status).toBe(200);
    expect((await at.me("mcp: me", at.mcp)).status).toBe(200);
    const lost = await at.signIn("lost");
    const other = await at.signIn("other");
    await at.restart();
    const byRequest = (step: string, request: unknown) => at.call(step, "POST", "/v1/agents/revoke", at.mcp, { request });
    expect([(await byRequest("revoke by the request", lost.id)).status, (await byRequest("by the request again", lost.id)).status]).toEqual([200, 200]);
    expect((await at.me("revoked by its request: reads", lost.tokens.access_token)).status).toBe(401);
    expect((await at.refresh("revoked by its request: refresh", lost.tokens.refresh_token)).body.code).toBe("INVALID_GRANT");
    expect(at.revokedEvents(lost.grant), "one revoke by request, one event").toBe(1);
    expect((await at.me("another sign-in: reads", other.tokens.access_token)).status, "a revoke by request ends that request's grant alone").toBe(200);
    expect((await byRequest("revoke by an unknown request", "never-made-request-0001")).body).toEqual({});
    const early = (await at.request("early: request")).body as { id: string; code: string };
    await at.answer("early: the page's code", early.id, early.code);
    expect((await byRequest("early: revoke by the request", early.id)).status).toBe(200);
    const refused = await at.grant("early: grant", early.id);
    expect([refused.status, refused.body.code]).toEqual([409, "AGENT_NOT_APPROVED"]);
  });

  it("a request id that begins with - is answered from a phone, over the typed socket call, or by agents answer --; a name that begins with - is added", async () => {
    const steps: Record<string, unknown> = {};
    report.dash = steps;
    const dashed = (bytes: number) => {
      const made = randomBytes(bytes);
      made[0] = 0xf8 | (made[0]! & 0x03);
      return made;
    };
    const at = await running("lifestream-agents-dash-", steps, dashed);
    const ask1 = (await at.request("phone: request")).body as { id: string; code: string };
    expect(ask1.id.startsWith("-")).toBe(true);
    expect((await at.waiting("phone: waiting")).map((each) => each.id)).toContain(ask1.id);
    expect((await at.answer("phone: the page's code", ask1.id, ask1.code)).body).toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    expect(await at.state("phone: state", ask1.id)).toBe("approved");

    const ask2 = (await at.request("socket: request")).body as { id: string; code: string };
    expect(await ask(at.sock, { verb: "agent", call: "answer", body: { id: ask2.id, answer: "deny" } })).toEqual({ state: "denied", at_ms: expect.any(Number), device: null, name: "Claude", granted: null });

    const ask3 = (await at.request("mac: request")).body as { id: string; code: string };
    expect(await askHome(at.sock, "agents", ["answer", "--", ask3.id, ask3.code])).toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on Mac,", expect.any(Number)), reader: null, connected: null });
    const granted = await at.grant("mac: grant", ask3.id);
    expect(granted.status).toBe(200);
    expect((await at.me("mac: reads", (granted.body as unknown as Tokens).access_token)).status).toBe(200);

    const added = await askHome(at.sock, "agents", ["add", "--", "-Hermes"]) as Added;
    expect(added.agent.name).toBe("-Hermes");
    expect(await askHome(at.sock, "agents", ["disconnect", "--", added.agent.id])).toEqual({});
    expect((await at.me("removed: reads", added.pass)).status).toBe(401);
  });

  it("a note from a pass the door does not take, or one that does not read, or malformed, is kept; an agent cannot leave one; a 501st in a day at one pass is kept, or counts against another; a torn last line spoils the next; a note is answered before it is on disk; agents list runs Tailscale", async () => {
    const steps: Record<string, unknown> = {};
    report.notes = steps;
    const at = await running("lifestream-agents-notes-", steps);
    const file = join(at.root, "agents", "feedback.jsonl");
    const kept = () => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
    const note = (step: string, pass: string | null, body: unknown, headers: Record<string, string> = {}) => at.call(step, "POST", "/v1/feedback", pass, body, headers);
    const PHOTOS = { category: "missing", message: "A filter by chat for photos would have saved three searches.", tool: "photos" };
    const copied = await askHome(at.sock, "agents", ["add", "Hermes"]) as Added;
    const signed = await at.signIn("sign-in", { name: "Claude", checked: true, host: "claude.ai" });
    const gone = await askHome(at.sock, "agents", ["add", "Gone"]) as Added;
    await askHome(at.sock, "agents", ["disconnect", gone.agent.id]);

    const refused = [
      await note("no pass", null, PHOTOS), await note("an unknown pass", "synthetic-unknown-pass".padEnd(43, "u"), PHOTOS), await note("a removed agent", gone.pass, PHOTOS),
      await note("a copied pass at the public address", copied.pass, PHOTOS, { "lifestream-reach": "public" }),
      await note("the MCP server's own pass", at.mcp, PHOTOS), await note("the extension's pass", at.passes.extension, PHOTOS, DEVICE.extension),
    ];
    expect(refused.map((each) => each.status)).toEqual([401, 401, 401, 401, 403, 403]);
    const malformed = [
      { category: "praise", message: "Nice." }, { message: "No category." }, { category: "missing", message: "" }, { category: "missing", message: "   " },
      { category: "other", message: "x".repeat(NOTE_MOST + 1) }, { category: "other", message: "A tool name too long.", tool: "t".repeat(NOTE_TOOL_MOST + 1) },
      { category: "other", message: 7 },
    ];
    for (const [index, body] of malformed.entries()) {
      const answered = await note(`malformed ${index + 1}`, copied.pass, body);
      expect([answered.status, answered.body.code], JSON.stringify(body).slice(0, 80)).toEqual([422, "BAD_REQUEST"]);
    }
    expect(existsSync(file), "nothing refused is kept").toBe(false);

    const T0 = new Date(Date.UTC(2026, 9, 28, 9, 0)).toISOString();
    const ids = Object.fromEntries(readPrincipals(at.principals).principals.map((row) => [row.unit === "agent" ? row.agent!.name : row.unit, row.id]));
    expect((await note("copied: a note", copied.pass, PHOTOS)).body).toEqual({ outcome: "saved" });
    expect(kept().map((line) => JSON.parse(line) as Note)).toEqual([{ at: T0, pass: copied.agent.id, who: "Hermes", ...PHOTOS }]);
    const long = { category: "confusing", message: "m".repeat(NOTE_MOST), tool: "t".repeat(NOTE_TOOL_MOST) };
    expect((await note("sign-in: the longest note, at the public address", signed.tokens.access_token, long, { "lifestream-reach": "public" })).body).toEqual({ outcome: "saved" });
    expect((await note("reader: a note with no tool", at.passes.reader, { category: "slow", message: "The day took long to read." })).body).toEqual({ outcome: "saved" });
    expect((await note("phone: a note", at.passes.phone, { category: "error", message: "A read failed.", tool: null }, DEVICE.phone)).body).toEqual({ outcome: "saved" });
    expect(kept().slice(1).map((line) => JSON.parse(line) as Note)).toEqual([
      { at: T0, pass: signed.grant, who: "Claude", ...long },
      { at: T0, pass: ids["reader-0001"], who: "reader-0001", category: "slow", tool: null, message: "The day took long to read." },
      { at: T0, pass: ids[PHONE_UNIT], who: PHONE_UNIT, category: "error", tool: null, message: "A read failed." },
    ]);

    expect(NOTES_A_DAY).toBe(500);
    for (let each = 2; each <= NOTES_A_DAY; each += 1) expect((await note(`copied: note ${each}`, copied.pass, { ...PHOTOS, message: `note ${each}` })).body, `note ${each}`).toEqual({ outcome: "saved" });
    expect(kept().filter((line) => (JSON.parse(line) as Note).pass === copied.agent.id)).toHaveLength(NOTES_A_DAY);
    const before = kept().length;
    expect((await note("copied: the 501st", copied.pass, { ...PHOTOS, message: "one too many" })).body).toEqual({ outcome: "full" });
    expect(kept().length, "a full answer keeps nothing").toBe(before);
    expect((await note("sign-in: after the copied pass is full", signed.tokens.access_token, PHOTOS)).body).toEqual({ outcome: "saved" });
    at.tick(24 * 60 * 60_000);
    expect((await note("copied: a day on", copied.pass, { ...PHOTOS, message: "a day on" })).body).toEqual({ outcome: "saved" });

    writeFileSync(file, `${readFileSync(file, "utf8")}{"at":"2026-10-29T09:00:00.000Z","pass":"${copied.agent.id}","who":"Her`);
    const whole = kept().length - 1;
    expect((await note("copied: after a torn line", copied.pass, { ...PHOTOS, message: "after the torn line" })).body).toEqual({ outcome: "saved" });
    const lines: string[] = [];
    const listed = await askHome(at.sock, "agents", ["notes"], (line) => lines.push(line)) as { notes: Note[] };
    steps["agents notes"] = { lines: lines.length, newest: listed.notes[0]?.message ?? null };
    expect(listed.notes).toHaveLength(whole + 1);
    expect(listed.notes.slice(0, 2).map((each) => each.message), "newest first").toEqual(["after the torn line", "a day on"]);
    expect(listed.notes.at(-1)!.message).toBe(PHOTOS.message);
    expect(lines[0]).toBe(`2026-10-29T09:00:00.000Z Hermes missing (photos): after the torn line`);
    expect(JSON.parse(kept().at(-1)!)).toMatchObject({ message: "after the torn line" });

    const spoof = { category: "other", message: "\u001b[2J\rsaved: all clear\u007f\u009b", tool: "\u0007day" };
    expect((await note("copied: control characters", copied.pass, spoof)).body).toEqual({ outcome: "saved" });
    const printed: string[] = [];
    const answer = await askHome(at.sock, "agents", ["notes"], (line) => printed.push(line)) as { notes: Note[] };
    expect(answer.notes[0]).toMatchObject(spoof);
    expect(printed[0]).toBe("2026-10-29T09:00:00.000Z Hermes other (\\u0007day): \\u001b[2J\\u000dsaved: all clear\\u007f\\u009b");
    expect(printed.join("\n")).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u);

    const { folder, world, ran } = tailscaleOf(at, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    const listLines: string[] = [];
    const list = await askHome(at.sock, "agents", ["list"], (line) => listLines.push(line)) as Record<string, unknown>;
    expect(listLines, "agents list prints nothing: the Mac reads its answer alone").toEqual([]);
    expect(list).toEqual({ agents: (await askHome(at.sock, "agents") as { agents: Listed[] }).agents });
    expect((list.agents as Listed[]).map((each) => each.name)).toEqual(["Hermes", "Claude"]);
    steps["agents list, then agents"] = { ran: ran().map((args) => args.join(" ")) };
    expect(ran().length, "agents ran Tailscale, so the fake records its runs").toBeGreaterThan(0);
    const after = ran().length;
    await askHome(at.sock, "agents", ["list"]);
    expect(ran().length, "agents list runs no Tailscale").toBe(after);
  });

  it("agents public blocks with other words or page, writes no origin on an empty :443, changes another handler, or asks Tailscale to change anything by status", async () => {
    const steps: Record<string, unknown> = {};
    report.public = steps;
    const at = await running("lifestream-agents-public-", steps);
    const { folder, world, publicFile, set, serving, ran, publicOf } = tailscaleOf(at, steps);

    expect(await publicOf("no tailscale", "status")).toEqual({ state: "blocked", origin: null, why: "Install Tailscale on this Mac", open: "https://tailscale.com/download/mac" });
    set({});
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);

    set({ down: true });
    expect(await publicOf("tailscale's app not running", "status")).toEqual({ state: "blocked", origin: null, why: "Open Tailscale on this Mac", open: null });
    set({ status: { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake0001", Self: {} } });
    expect(await publicOf("signed out", "on")).toEqual({ state: "blocked", origin: null, why: "Sign in to Tailscale", open: "https://login.tailscale.com/a/fake0001" });
    set({ status: { BackendState: "Stopped", AuthURL: "", Self: SELF } });
    expect(await publicOf("turned off", "status")).toEqual({ state: "blocked", origin: null, why: "Turn on Tailscale", open: null });
    set({ status: { BackendState: "Running", AuthURL: "", Self: { DNSName: `${DNS}.`, CapMap: {} } } });
    expect(await publicOf("funnel not allowed: status", "status")).toEqual({ state: "blocked", origin: null, why: "Allow Funnel in Tailscale", open: null });
    expect(await publicOf("funnel not allowed: on", "on")).toEqual({ state: "blocked", origin: null, why: "Allow Funnel in Tailscale", open: ENABLE });
    expect([serving(), existsSync(publicFile)]).toEqual([{}, false]);

    set({ allow: true });
    expect(await publicOf("empty: on", "on")).toEqual({ state: "on", origin: ORIGIN, why: null, open: null });
    expect(JSON.parse(readFileSync(publicFile, "utf8"))).toEqual({ origin: ORIGIN });
    expect(serving()).toEqual(ours());
    const changing = ran().length;
    expect(await publicOf("on: status", "status")).toEqual({ state: "on", origin: ORIGIN, why: null, open: null });
    expect(await publicOf("on: on again", "on")).toEqual({ state: "on", origin: ORIGIN, why: null, open: null });
    expect(ran().slice(changing).filter((args) => args[0] === "funnel"), "status and an on already on change nothing").toEqual([]);
    expect(await publicOf("on: off", "off")).toEqual({ state: "off", origin: ORIGIN, why: null, open: null });
    expect([serving(), existsSync(publicFile)]).toEqual([{}, false]);

    const door = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: OTHER } } };
    set({ allow: true, serve: door });
    expect(await publicOf("taken: on", "on")).toEqual({ state: "taken", origin: null, why: TAKEN, open: null });
    expect([serving(), existsSync(publicFile)]).toEqual([door, false]);

    set({ status: { BackendState: "Running", AuthURL: "", Self: { DNSName: `${DNS}.`, CapMap: { https: null } } }, serve: ours() });
    expect(await publicOf("funnel no longer allowed: off", "off")).toEqual({ state: "blocked", origin: null, why: "Allow Funnel in Tailscale", open: null });
    expect(serving()).toEqual({});

    const offs = ran().filter((args) => args.includes("off"));
    expect(offs.length, "each off above ran").toBeGreaterThan(0);
    expect(offs.every((args) => args.includes("--set-path=/")), "every removal names our path: Tailscale's off with none removes every mount").toBe(true);
    expect(ran().every((args) => !args.includes("reset")), "nothing is ever reset whole").toBe(true);
  });

  it("off or a rollback removes another program's mount on :443, or leaves it on the internet without saying so: Funnel is the port's, and stays on while that mount does", async () => {
    const steps: Record<string, unknown> = {};
    report.shared = steps;
    const at = await running("lifestream-agents-shared-", steps);
    const { folder, world, publicFile, set, serving, ran, publicOf } = tailscaleOf(at, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    const taken = { state: "taken", origin: null, why: FUNNEL_ON, open: null };
    const removals = (from: number) => ran().slice(from).filter((args) => args.includes("off"));

    const beside = { ...ours(), Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: OURS }, ...OTHER } } } };
    const left = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: OTHER } }, AllowFunnel: { [`${DNS}:443`]: true } };
    set({ allow: true, serve: beside });
    writeFileSync(publicFile, JSON.stringify({ origin: ORIGIN }));
    expect(await publicOf("beside: off", "off")).toEqual(taken);
    expect([serving(), existsSync(publicFile)]).toEqual([left, false]);
    expect(await publicOf("beside: status", "status")).toEqual(taken);

    set({ allow: true, race: OTHER });
    expect(await publicOf("race: on", "on")).toEqual(taken);
    expect([serving(), existsSync(publicFile)]).toEqual([left, false]);

    const theirs = { "/": { Proxy: "http://127.0.0.1:4690" } };
    const replaced = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: theirs } }, AllowFunnel: { [`${DNS}:443`]: true } };
    set({ allow: true, race: theirs });
    let from = ran().length;
    expect(await publicOf("replaced in on: on", "on")).toEqual(taken);
    expect(await publicOf("replaced in on: off", "off")).toEqual(taken);
    expect([serving(), existsSync(publicFile), removals(from)]).toEqual([replaced, false, []]);

    set({ allow: true, serve: ours(), later: { after: 1, handlers: theirs } });
    writeFileSync(publicFile, JSON.stringify({ origin: ORIGIN }));
    from = ran().length;
    expect(await publicOf("replaced in off: off", "off")).toEqual(taken);
    expect([serving(), existsSync(publicFile), removals(from)]).toEqual([replaced, false, []]);

    set({ allow: true, race: OTHER, failFrom: 4 });
    expect(await publicOf("race, the last look failed: on", "on")).toEqual({ ...taken, why: `${FUNNEL_ON}. Lifestream could not confirm what Tailscale serves now` });
    expect([serving(), existsSync(publicFile)]).toEqual([left, false]);
  });
  it("the home keeps the switch: off runs nothing; an emptied :443, or ours with Funnel off, is set again; another's handler or Tailscale signed out changes nothing and leaves the switch on; freed, it is set again", async () => {
    const steps: Record<string, unknown> = {};
    report.keep = steps;
    const keeping = await running("lifestream-agents-keep-", steps);
    const { folder, world, publicFile, set, serving, ran, publicOf } = tailscaleOf(keeping, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    const keep = async (step: string) => {
      const before = ran().length;
      let kept: Kept | null = null;
      await keepPublic(keeping.at, { live: () => true, note: (each) => { kept = each; } });
      steps[step] = { kept, ran: ran().slice(before).map((args) => args.join(" ")) };
      return { kept, ran: ran().slice(before) };
    };
    const on = { state: "on", origin: ORIGIN, why: null, open: null };

    set({ allow: true });
    expect(await keep("switch off")).toEqual({ kept: { restored: null, state: null }, ran: [] });

    expect(await publicOf("on", "on")).toEqual(on);
    expect((await keep("on: a quiet look")).ran.filter((args) => args[0] !== "status" && args[0] !== "serve")).toEqual([]);
    set({ allow: true, serve: {} });
    const restored = await keep("emptied");
    expect(restored.kept).toEqual({ restored: "empty", state: on });
    expect(restored.ran.filter((args) => args[0] === "funnel")).toEqual([["funnel", "--bg", "--yes", "--https=443", OURS]]);
    expect(serving()).toEqual(ours());
    expect(await publicOf("emptied: status", "status")).toEqual(on);

    const funnelOff = ours();
    delete funnelOff.AllowFunnel;
    set({ allow: true, serve: funnelOff });
    expect((await keep("funnel off")).kept).toEqual({ restored: "funnel-off", state: on });
    expect(serving()).toEqual(ours());

    const theirs = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:4690" } } } } };
    set({ allow: true, serve: theirs });
    const taken = await keep("taken");
    expect(taken.kept).toEqual({ restored: null, state: { state: "taken", origin: null, why: TAKEN, open: null } });
    expect(taken.ran.every((args) => args.join(" ").endsWith("--json")), "only reads").toBe(true);
    expect([serving(), existsSync(publicFile)]).toEqual([theirs, true]);

    set({ status: { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake0001", Self: {} } });
    const out = await keep("signed out");
    expect(out.kept).toEqual({ restored: null, state: { state: "blocked", origin: null, why: "Sign in to Tailscale", open: "https://login.tailscale.com/a/fake0001" } });
    expect(out.ran).toEqual([["status", "--json"]]);
    expect(existsSync(publicFile)).toBe(true);

    set({ allow: true });
    expect((await keep("freed")).kept).toEqual({ restored: "empty", state: on });
    expect([serving(), JSON.parse(readFileSync(publicFile, "utf8"))]).toEqual([ours(), { origin: ORIGIN }]);
    expect(ran().every((args) => !args.includes("off") && !args.includes("reset")), "the keeping never removes anything").toBe(true);

    const before = ran().length;
    let noted = false;
    await keepPublic(keeping.at, { live: () => false, note: () => { noted = true; } });
    expect([noted, ran().length]).toEqual([false, before]);
  });

  it("one turn at a time: an off asked while a keeping's funnel --bg is held ends with nothing served, no public.json and no need; one asked while a keeping's look is held leaves no need; an on that finds the address taken leaves the switch as it was", async () => {
    const steps: Record<string, unknown> = {};
    report.turns = steps;
    const home = await running("lifestream-agents-turns-", steps);
    const { folder, world, publicFile, set, serving, publicOf } = tailscaleOf(home, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    const held = join(folder, "held");
    const release = join(folder, "release");
    const meta = new Map<string, string>();
    const tables = { get: (key: string) => meta.get(key), set: (key: string, value: string) => void meta.set(key, value), delete: (key: string) => void meta.delete(key) };
    let keptState: PublicState | null = null;
    const keeper = { live: () => true, note: (kept: Kept) => { keptState = kept.state; noteReach(tables, kept.state, 0); } };
    const note = (state: PublicState | null) => void noteReach(tables, state, 0);
    const off = { state: "off", origin: ORIGIN, why: null, open: null };
    const theirs = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: OTHER } } };

    set({ allow: true });
    expect(await publicOf("on", "on")).toMatchObject({ state: "on" });
    set({ allow: true, serve: {}, hold: "funnel" });
    const keeping = keepPublic(home.at, keeper);
    await until("the keeping's funnel --bg is held", () => existsSync(held));
    const turnedOff = publicOff(home.at, note);
    expect(existsSync(publicFile)).toBe(false);
    writeFileSync(release, "");
    await keeping;
    expect(keptState).toMatchObject({ state: "off" });
    expect(await turnedOff).toEqual(off);
    expect([serving(), existsSync(publicFile), [...meta.keys()]]).toEqual([{}, false, []]);

    rmSync(held);
    rmSync(release);
    writeFileSync(publicFile, JSON.stringify({ origin: ORIGIN }));
    set({ allow: true, serve: theirs, hold: "serve" });
    const looking = keepPublic(home.at, keeper);
    await until("the keeping's serve status is held", () => existsSync(held));
    const offAfter = publicOff(home.at, note);
    writeFileSync(release, "");
    await looking;
    expect(keptState).toEqual({ state: "taken", origin: null, why: TAKEN, open: null });
    expect(await offAfter).toEqual({ state: "taken", origin: null, why: TAKEN, open: null });
    expect([serving(), existsSync(publicFile), [...meta.keys()]]).toEqual([theirs, false, []]);

    rmSync(held);
    rmSync(release);
    set({ allow: true, serve: {}, hold: "funnel" });
    const turningOn = publicOn(home.at, note);
    await until("the on's funnel --bg is held", () => existsSync(held));
    const offLater = publicOff(home.at, note);
    writeFileSync(release, "");
    expect(await turningOn, "an off asked during the on: the on answers what stands").toEqual(off);
    expect(await offLater).toEqual(off);
    expect([serving(), existsSync(publicFile), [...meta.keys()]]).toEqual([{}, false, []]);

    rmSync(held);
    rmSync(release);
    writeFileSync(publicFile, JSON.stringify({ origin: ORIGIN }));
    set({ allow: true, serve: {}, hold: "funnel" });
    const keptAgain = keepPublic(home.at, keeper);
    await until("the keeping's funnel --bg is held again", () => existsSync(held));
    let ended = false;
    const queued = publicOn(home.at, note).then((state) => { ended = true; return state; });
    let idle = false;
    const idled = reachIdle(home.at).then(() => { idle = true; });
    writeFileSync(release, "");
    await idled;
    expect([idle, ended]).toEqual([true, true]);
    await keptAgain;
    expect(keptState).toMatchObject({ state: "on" });
    expect(await queued).toMatchObject({ state: "on" });
    rmSync(publicFile);
    set({ allow: true, serve: theirs });

    const reach = async () => ((await home.call("status", "GET", "/v1/status", home.passes.reader)).body as unknown as { needs: { id: string; line: string | null }[] }).needs
      .filter((need) => need.id === "reach").map((need) => need.line);
    expect(await publicOf("taken, the switch off: on", "on")).toMatchObject({ state: "taken" });
    expect([existsSync(publicFile), await reach()]).toEqual([false, []]);
    writeFileSync(publicFile, JSON.stringify({ origin: ORIGIN }));
    expect(await publicOf("taken, the switch on: on", "on")).toMatchObject({ state: "taken" });
    expect([existsSync(publicFile), await reach()]).toEqual([true, [TAKEN_LINE]]);
    expect(await publicOf("taken: off", "off")).toMatchObject({ state: "taken" });
    expect([existsSync(publicFile), await reach()]).toEqual([false, []]);
  });

  it("the home looks at its start and every five minutes: restored is a log line, never a need; taken or blocked is the need reach, its line what to do, until a look finds it on; a set Tailscale failed silently is a log line alone; off clears it", async () => {
    const steps: Record<string, unknown> = {};
    report.kept = steps;
    const home = await running("lifestream-agents-kept-", steps);
    const { folder, world, set, publicOf } = tailscaleOf(home, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    const reach = async () => ((await home.call("status", "GET", "/v1/status", home.passes.reader)).body as unknown as { needs: { id: string; state: string; words: string; line: string | null; acts: unknown[] }[] }).needs
      .filter((need) => need.id === "reach").map((need) => [need.state, need.words, need.line, need.acts]);
    const logged = (words: string) => home.logs.filter((line) => line.includes(words)).length;
    const untilNeed = (what: string, want: unknown) => until(what, async () => JSON.stringify(await reach()) === JSON.stringify(want));
    await askHome(home.sock, "agents", ["add", "--anywhere", "Hermes"]);

    set({ allow: true });
    expect(await publicOf("on", "on")).toMatchObject({ state: "on" });

    await home.restart(() => set({ allow: true, serve: {} }));
    await until("the start's look sets ours again", () => logged('"reach":"restored"') === 1);
    expect(home.logs.find((line) => line.includes('"reach":"restored"'))).toMatch(/"found":"empty"/u);
    expect(await reach()).toEqual([]);

    set({ allow: true, serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: OTHER } } } });
    home.tick(5 * 60_000);
    const taken = [["needs-you", "Agents can't reach Lifestream from the internet", TAKEN_LINE, []]];
    await untilNeed("the five-minute look finds it taken", taken);

    set({ status: { BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/fake0001", Self: {} } });
    home.tick(5 * 60_000);
    await untilNeed("the look finds Tailscale signed out", [["needs-you", "Agents can't reach Lifestream from the internet", "Sign in to Tailscale", [{ do: "open", label: "Open Tailscale", url: "https://login.tailscale.com/a/fake0001" }]]]);

    set({ allow: true });
    home.tick(5 * 60_000);
    await until("the look sets ours again", () => logged('"reach":"restored"') === 2);
    expect(await reach()).toEqual([]);

    set({ allow: true, serve: {}, failSet: true });
    home.tick(5 * 60_000);
    await until("the look logs the set it could not make", () => logged('"reach":"not kept"') === 1);
    expect(home.logs.find((line) => line.includes('"reach":"not kept"'))).toMatch(/"why":"Tailscale did not turn Funnel on: it said nothing"/u);
    expect(await reach()).toEqual([]);

    set({ allow: true, serve: { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: OTHER } } } });
    home.tick(5 * 60_000);
    await untilNeed("the look finds it taken again", taken);
    expect(await publicOf("off", "off")).toMatchObject({ state: "taken" });
    expect(await reach()).toEqual([]);
  });

  it("the address route: only the person's Mac or iPhone asks; Funnel not allowed is turn-on to a look and its page to a turn-on; Tailscale's own words never reach the person", async () => {
    const steps: Record<string, unknown> = {};
    report.address = steps;
    const at = await running("lifestream-agents-address-", steps);
    const macPass = randomBytes(32).toString("base64url");
    mintPrincipal(at.principals, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["machine:local:macbook-pro-0001"], token: macPass, now_ms: 0 });
    const mac = (step: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}) => at.call(step, method, "/v1/agents/address", macPass, body, { ...DEVICE.mac, ...headers });
    const phone = (step: string, method: "GET" | "POST", body?: unknown) => at.call(step, method, "/v1/agents/address", at.passes.phone, body, DEVICE.phone);
    const copied = (await askHome(at.sock, "agents", ["add", "Hermes"]) as Added).pass;
    const { folder, world, set, serving, publicFile } = tailscaleOf(at, steps);

    for (const [who, pass, headers, code] of [
      ["a reader's pass", at.token("dashboard"), {}, "PERSON_ONLY"], ["the MCP relay", macPass, { ...DEVICE.mac, "lifestream-server": at.mcp }, "PERSON_ONLY"],
      ["an agent", copied, {}, "PRINCIPAL_SCOPE"], ["an extension", at.passes.extension, DEVICE.extension, "PRINCIPAL_SCOPE"],
    ] as const) {
      const looked = await at.call(`${who}: look`, "GET", "/v1/agents/address", pass, undefined, headers);
      const turned = await at.call(`${who}: turn on`, "POST", "/v1/agents/address", pass, { on: true }, headers);
      const keyed = await at.call(`${who}: key`, "POST", "/v1/agents/keys", pass, { app: "another", name: "Example tool", access: defaultAccess() }, headers);
      expect([looked.status, looked.body.code, turned.status, turned.body.code, keyed.status, keyed.body.code], who).toEqual([403, code, 403, code, 403, code]);
    }
    expect(existsSync(publicFile), "no refused ask turned the address on").toBe(false);

    expect((await mac("no tailscale: the Mac", "GET")).body).toEqual({ state: "fix", url: null, words: "Your address needs Tailscale on this Mac.", act: { label: "Get Tailscale", to: "web", url: "https://tailscale.com/download/mac" } });
    expect((await phone("no tailscale: the iPhone", "GET")).body).toEqual({ state: "fix", url: null, words: "Needs Tailscale on your Mac.", act: null });
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);

    set({ status: { BackendState: "Running", AuthURL: "", Self: { DNSName: `${DNS}.`, CapMap: {} } } });
    const allow = { label: "Allow Funnel", to: "turn-on", url: null };
    expect((await mac("funnel not allowed: a look", "GET")).body).toEqual({ state: "fix", url: null, words: "Allow Funnel in Tailscale to put your address on the internet.", act: allow });
    expect((await phone("funnel not allowed: the iPhone's look", "GET")).body).toMatchObject({ act: allow });
    expect((await phone("funnel not allowed: a turn-on", "POST", { on: true })).body).toMatchObject({ state: "fix", act: { label: "Allow Funnel", to: "web", url: ENABLE } });
    set({ down: true });
    expect((await mac("not running", "GET")).body).toMatchObject({ words: "Open Tailscale to get your address.", act: { label: "Open Tailscale", to: "tailscale", url: null } });
    set({ allow: true, failFrom: 1 });
    const silent = await mac("tailscale says something of its own", "GET");
    expect([silent.status, silent.body]).toEqual([200, { state: "fix", url: null, words: "Tailscale did not answer. Open Tailscale on your Mac.", act: null }]);

    set({ allow: true });
    expect((await mac("off, signed in: its address shows before the copy", "GET")).body).toEqual({ state: "off", url: `${ORIGIN}/mcp` });
    const on = { state: "on", url: `${ORIGIN}/mcp`, line: "Lifestream’s agent address is now on the internet. Only agents you say yes to can read." };
    expect((await phone("the iPhone turns it on", "POST", { on: true })).body).toEqual(on);
    expect([serving(), JSON.parse(readFileSync(publicFile, "utf8"))]).toEqual([ours(), { origin: ORIGIN }]);
    expect((await mac("the Mac looks", "GET")).body).toEqual(on);
    expect((await mac("an app never turns it off", "POST", { on: false })).status).toBe(422);
    expect((await mac("on is true", "POST", { on: "yes" })).status).toBe(422);
    expect([serving(), existsSync(publicFile)], "the address stays on").toEqual([ours(), true]);
  });

  it("a guide's key: minted with the access drawn and its app, only with the address on, read through the public address; a second key of the same app revokes none; the iPhone makes only Instinct's", async () => {
    const steps: Record<string, unknown> = {};
    report.keys = steps;
    const at = await running("lifestream-agents-keys-", steps);
    const macPass = randomBytes(32).toString("base64url");
    mintPrincipal(at.principals, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["machine:local:macbook-pro-0001"], token: macPass, now_ms: 0 });
    const key = (step: string, body: Record<string, unknown>, from: "mac" | "phone" = "mac") =>
      at.call(step, "POST", "/v1/agents/keys", from === "mac" ? macPass : at.passes.phone, body, from === "mac" ? DEVICE.mac : DEVICE.phone);
    const agents = () => readPrincipals(at.principals).principals.filter((row) => row.kind === "agent" && row.agent?.own !== true);
    const PUBLIC = { "lifestream-reach": "public" };
    const access = { ...defaultAccess(), hide: "all" };
    const { folder, world, set } = tailscaleOf(at, steps);

    const before = agents().length;
    const early = await key("instinct with no address", { app: "instinct", access }, "phone");
    expect([early.status, early.body.code, agents().length]).toEqual([409, "ADDRESS_NOT_READY", before]);
    const loopback = await key("another agent with no Tailscale", { app: "another", name: "Example tool", access });
    expect([loopback.status, (loopback.body.rows as { label: string; text: string }[]).map((row) => [row.label, row.label === "Key" ? "" : row.text.slice(0, 26)])]).toEqual([200, [
      ["Address", "http://127.0.0.1:4681/mcp"], ["Key", ""], ["Claude Code", "printf 'Paste your Lifestr"],
    ]]);
    expect(agents().find((row) => row.id === loopback.body.reader)!.agent).toEqual({ name: "Example tool", via: "pass", from: null, checked: false, client_id: null, resource: null });
    for (const app of ["grok-bot", "another"]) {
      const refused = await key(`the iPhone asks for ${app}`, { app, access, ...(app === "another" ? { name: "Example tool" } : {}) }, "phone");
      expect([refused.status, refused.body.code], app).toEqual([403, "PERSON_ONLY"]);
    }

    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    set({ allow: true });
    expect((await at.call("turn the address on", "POST", "/v1/agents/address", at.passes.phone, { on: true }, DEVICE.phone)).body).toMatchObject({ state: "on" });
    const ran = (JSON.parse(readFileSync(join(folder, "calls.json"), "utf8")) as string[][]).length;
    const first = await key("instinct", { app: "instinct", access }, "phone");
    expect(first.status).toBe(200);
    const made = first.body as { reader: string; name: string; rows: { label: string; text: string }[]; connected: { reader: string; line: string } };
    const pass = made.rows.find((row) => row.label === "Key")!.text;
    expect(made).toMatchObject({ name: "Instinct", rows: [{ label: "Address", text: `${ORIGIN}/mcp` }, { label: "Key" }], connected: { reader: made.reader } });
    expect(made.connected.line).toMatch(/^It sees .+\. Change it any time in Agents\.$/u);
    expect((JSON.parse(readFileSync(join(folder, "calls.json"), "utf8")) as string[][]).length, "a key runs no Tailscale").toBe(ran);
    expect(agents().find((row) => row.id === made.reader)!.agent).toEqual({ name: "Instinct", via: "pass", from: null, checked: false, client_id: null, resource: null, anywhere: true, app: "instinct" });
    const ledger = openLedger(openHomeFolder(at.root), { mode: "read" });
    onTestFinished(() => ledger.close());
    expect(ledger.access.get(made.reader)).toMatchObject({ version: 1, lines: access });
    expect((await at.me("instinct's key, public", pass, PUBLIC)).body).toEqual({ id: made.reader, kind: "agent", resource: null });

    const grok = await key("grok bot", { app: "grok-bot", access });
    expect((grok.body.rows as { label: string; text: string }[]).map((row) => row.label)).toEqual(["Name", "Server URL", "Header name", "Header value"]);
    const fresh = await key("grok bot, the first never read", { app: "grok-bot", access });
    const again = await key("instinct again, on another device, before the first key read", { app: "instinct", access });
    const live = agents().filter((row) => row.revoked_at === null).map((row) => row.agent!.name).sort();
    expect(live, "every key made stands: the person disconnects one they don't hold").toEqual(["Example tool", "Grok Bot", "Grok Bot", "Instinct", "Instinct"]);
    expect((await at.me("the first key, public, still", pass, PUBLIC)).status, "a key already pasted keeps reading").toBe(200);
    expect((await at.me("the second key, public", (again.body.rows as { label: string; text: string }[])[1]!.text, PUBLIC)).status).toBe(200);
    expect([grok.body.reader, fresh.body.reader].map((id) => agents().find((row) => row.id === id)!.revoked_at)).toEqual([null, null]);

    for (const body of [{ app: "claude", access }, { app: "another", access }, { app: "instinct", name: "Instinct", access }, { app: "instinct", access: { allow: "everything" } }]) {
      expect((await key(`refused: ${JSON.stringify(body).slice(0, 40)}`, body)).status, JSON.stringify(body)).toBe(422);
    }
  });

  it("the address stays on from a turn-on until the last internet agent's disconnect, never under a sign-in in flight; the look never turns it off, nor does an app; From the internet turns a key on for it only once the address is on", async () => {
    const steps: Record<string, unknown> = {};
    report.internet = steps;
    const at = await running("lifestream-agents-internet-", steps);
    const macPass = randomBytes(32).toString("base64url");
    mintPrincipal(at.principals, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["machine:local:macbook-pro-0001"], token: macPass, now_ms: 0 });
    const address = (step: string, body: Record<string, unknown>, from: "mac" | "phone" = "mac") =>
      at.call(step, "POST", "/v1/agents/address", from === "mac" ? macPass : at.passes.phone, body, from === "mac" ? DEVICE.mac : DEVICE.phone);
    const disconnect = (step: string, id: string) => at.call(step, "POST", `/v1/agents/${id}/disconnect`, at.passes.phone, {}, DEVICE.phone);
    const agents = () => readPrincipals(at.principals).principals.filter((row) => row.kind === "agent" && row.agent?.own !== true);
    const { folder, world, set, serving, ran, publicFile } = tailscaleOf(at, steps);
    writeFileSync(join(folder, "tailscale"), fakeTailscale(world, join(folder, "calls.json")));
    chmodSync(join(folder, "tailscale"), 0o755);
    set({ allow: true });
    const offs = () => ran().filter((args) => args.join(" ") === "serve --https=443 --set-path=/ off").length;
    const looked = async (what: string, ms: number) => {
      const before = ran().length;
      at.tick(ms);
      await until(what, () => ran().length > before);
      await reachIdle(at.at);
    };

    expect((await address("copy: on", { on: true })).body).toMatchObject({ state: "on" });
    const claude = await at.signIn("claude signs in");
    const muse = await at.signIn("muse signs in", { name: "Meta AI", checked: false, host: "agent.meta.ai" });
    expect(agents().find((row) => row.id === muse.grant)!.agent!.name, "a sign-in from an app's own host is listed by the app's name").toBe("Muse");
    await looked("the look ten minutes on, the turn-on aged", REQUEST_MS);
    expect(existsSync(publicFile), "agents read from the internet: it stays on").toBe(true);

    expect((await disconnect("muse disconnected", muse.grant)).status).toBe(200);
    expect([existsSync(publicFile), offs()], "Claude still reads from the internet").toEqual([true, 0]);
    const asking = (await at.request("chatgpt asks", { name: "ChatGPT", checked: true, host: "chatgpt.com" })).body as { id: string };
    expect((await disconnect("claude disconnected under a sign-in", claude.grant)).status).toBe(200);
    await reachIdle(at.at);
    expect([existsSync(publicFile), offs()], "a sign-in waits: the last disconnect leaves it on").toEqual([true, 0]);
    await looked("the look after the sign-in ended", REQUEST_MS);
    expect([await at.state("chatgpt's sign-in, ended", asking.id), existsSync(publicFile), offs()], "the sign-in over and no agent: the look leaves it on").toEqual(["gone", true, 0]);
    expect((await address("an app turns it off", { on: false })).status).toBe(422);
    await looked("the look an hour on", 60 * 60_000);
    expect([existsSync(publicFile), offs()], "no timer: on until the last internet agent goes").toEqual([true, 0]);
    const quick = await at.signIn("a sign-in after the copy");
    expect((await disconnect("disconnected at once", quick.grant)).status).toBe(200);
    await reachIdle(at.at);
    expect([existsSync(publicFile), offs(), serving()], "the only internet agent gone: off").toEqual([false, 1, {}]);
    expect(at.logs.some((line) => line.includes('"reach":"off"'))).toBe(true);

    expect((await address("instinct's guide turns it on", { on: true }, "phone")).body).toMatchObject({ state: "on" });
    const instinct = (await at.call("instinct's key", "POST", "/v1/agents/keys", at.passes.phone, { app: "instinct", access: defaultAccess() }, DEVICE.phone)).body as { reader: string; rows: { label: string; text: string }[] };
    const tool = (await at.call("another agent's key", "POST", "/v1/agents/keys", macPass, { app: "another", name: "Example tool", access: defaultAccess() }, DEVICE.mac)).body as { reader: string; rows: { label: string; text: string }[] };
    const toolPass = tool.rows.find((row) => row.label === "Key")!.text;
    const PUBLIC = { "lifestream-reach": "public" };
    expect((await at.me("the tool's key, public, before", toolPass, PUBLIC)).status, "a loopback key").toBe(401);

    const refused = [
      await address("from the internet, on the iPhone", { on: true, reader: tool.reader }, "phone"),
      await address("from the internet, for a disconnected sign-in", { on: true, reader: claude.grant }),
      await address("from the internet, turned off", { on: false, reader: tool.reader }),
    ].map((answer) => [answer.status, answer.body.code]);
    expect(refused).toEqual([[403, "PERSON_ONLY"], [404, "AGENT_UNKNOWN"], [422, "BAD_REQUEST"]]);
    expect(agents().find((row) => row.id === tool.reader)!.agent!.anywhere, "nothing refused turned the key on").toBeUndefined();
    expect((await disconnect("instinct disconnected before the copy", instinct.reader)).status).toBe(200);
    await reachIdle(at.at);
    expect([existsSync(publicFile), offs()], "the tool reads on the Mac alone: instinct gone, it is off").toEqual([false, 2]);
    set({});
    expect((await address("from the internet, Funnel not allowed", { on: true, reader: tool.reader })).body).toMatchObject({ state: "fix" });
    expect(agents().find((row) => row.id === tool.reader)!.agent!.anywhere, "an on that failed turns the key on for nothing").toBeUndefined();
    set({ allow: true });
    expect((await address("from the internet, copied", { on: true, reader: tool.reader })).body).toMatchObject({ state: "on" });
    expect(agents().find((row) => row.id === tool.reader)!.agent).toMatchObject({ name: "Example tool", via: "pass", anywhere: true });
    expect((await at.me("the tool's key, public, after", toolPass, PUBLIC)).body).toEqual({ id: tool.reader, kind: "agent", resource: null });
    await looked("the look with the tool reading", REQUEST_MS);
    expect(existsSync(publicFile), "the tool reads from the internet").toBe(true);

    const before = offs();
    expect((await disconnect("the last one disconnected", tool.reader)).status).toBe(200);
    await reachIdle(at.at);
    expect([existsSync(publicFile), offs(), serving()], "the last internet agent gone: off").toEqual([false, before + 1, {}]);
  });

  it("agents add with no home running settles the access first: the next start starts, the agent holds the default access and Chat a full one", async () => {
    const root = makeRoot("lifestream-agents-stopped-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const dir = mkdtempSync(join(tmpdir(), "lifestream-agents-stopped-machine-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
    const lines: string[] = [];
    expect(await runCli(["agents", "add", "Hermes", "--root", root], { machine: at, registry: await loadRegistry(FAKES, effective(root).settings, homeOf(openHomeFolder(root))), write: (text) => lines.push(text) }), lines.join("")).toBe(0);
    const hermes = readPrincipals(openHomeFolder(root)).principals.find((row) => row.kind === "agent")!.id;
    const home = await startHome(root, { stopGraceMs: 50, lookMs: LOOK_MS, registry: FAKES, machine: at, log: () => undefined, tickMs: TICK_MS });
    onTestFinished(() => home.stop());
    const ledger = openLedger(openHomeFolder(root), { mode: "read" });
    onTestFinished(() => ledger.close());
    expect(ledger.access.get(hermes)).toMatchObject({ version: 1, lines: defaultAccess() });
    expect(ledger.access.get(ASK_READER)).toMatchObject({ version: 1, lines: fullAccess("none") });
  });

  it("agents call with no home running mints a pass or asks the MCP server, or says no way to start it; help agents leaves it out", async () => {
    const root = makeRoot("lifestream-agents-call-", { sources: {} });
    onTestFinished(() => removeRoot(root));
    const dir = mkdtempSync(join(tmpdir(), "lifestream-agents-call-machine-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
    const lines: string[] = [];
    const principals = join(root, "config", "principals.json");
    const passes = () => existsSync(principals) ? readFileSync(principals, "utf8") : null;
    const before = passes();
    const status = await runCli(["agents", "call", "day", '{"date":"2026-11-08"}', "--root", root], { machine: at, write: (text) => lines.push(text) });
    expect(status).toBe(1);
    expect(lines.join("")).toBe(`no home runs on ${root}: lifestream agents call reads it through the running home's door and the MCP server; start the home (open Lifestream, or lifestream serve), then ask again\n`);
    expect(passes()).toBe(before);
    expect(existsSync(join(dir, "agents-call"))).toBe(false);
    const help: string[] = [];
    expect(await runCli(["help", "agents"], { write: (text) => help.push(text) })).toBe(0);
    expect(help.join("")).toContain("agents call [<tool> [<json arguments>]]");
  });
});

function tailscaleOf(at: { dir: string; sock: HomeSocket }, steps: Record<string, unknown>) {
  const folder = join(at.dir, "fake-tailscale");
  const calls = join(folder, "calls.json");
  const world = join(folder, "state.json");
  const set = (state: Record<string, unknown>) => {
    mkdirSync(folder, { recursive: true });
    writeFileSync(world, JSON.stringify({ status: { BackendState: "Running", AuthURL: "", Self: SELF }, serve: {}, ...state }));
  };
  const ran = () => existsSync(calls) ? JSON.parse(readFileSync(calls, "utf8")) as string[][] : [];
  set({});
  return {
    folder, world, set, ran,
    publicFile: join(at.dir, "mcp", "public.json"),
    serving: () => (JSON.parse(readFileSync(world, "utf8")) as { serve: Record<string, unknown> }).serve,
    async publicOf(step: string, action: "on" | "off" | "status") {
      const before = ran().length;
      const state = await askHome(at.sock, "agents", ["public", action]) as PublicState;
      steps[step] = { state, ran: ran().slice(before).map((args) => args.join(" ")) };
      return state;
    },
  };
}

function ours(): Record<string, unknown> {
  return { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { "/": { Proxy: OURS } } } }, AllowFunnel: { [`${DNS}:443`]: true } };
}

function fakeTailscale(world: string, calls: string): string {
  return `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.TAILSCALE_BE_CLI !== "1") { process.stderr.write("The Tailscale GUI failed to start: The operation couldn\\u2019t be completed. (Tailscale.CLIError error 3.)\\n"); process.exit(0); }
const ran = fs.existsSync(${JSON.stringify(calls)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(calls)}, "utf8")) : [];
fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify([...ran, args]));
const holding = JSON.parse(fs.readFileSync(${JSON.stringify(world)}, "utf8"));
if (holding.hold === args[0]) {
  delete holding.hold;
  fs.writeFileSync(${JSON.stringify(world)}, JSON.stringify(holding));
  fs.writeFileSync(${JSON.stringify(join(dirname(world), "held"))}, "");
  while (!fs.existsSync(${JSON.stringify(join(dirname(world), "release"))})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const state = JSON.parse(fs.readFileSync(${JSON.stringify(world)}, "utf8"));
const serve = state.serve;
const save = () => {
  for (const key of ["Web", "TCP", "AllowFunnel"]) if (serve[key] && Object.keys(serve[key]).length === 0) delete serve[key];
  fs.writeFileSync(${JSON.stringify(world)}, JSON.stringify(state));
};
const notAllowed = () => {
  process.stdout.write("\\nFunnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         ${ENABLE}\\n\\n");
  setInterval(() => undefined, 1000);
};
if (state.down) { process.stderr.write("failed to connect to local Tailscale service; is Tailscale running?\\n"); process.exit(1); }
const words = args.join(" ");
const host = String(state.status.Self.DNSName || "").replace(/\\.$/, "") + ":443";
const off = /^(serve|funnel) (?:--yes )?--https=443(?: --set-path=(\\S+))? off$/.exec(words);
if (words === "status --json") { process.stdout.write(JSON.stringify(state.status)); process.exit(0); }
else if (words === "serve status --json") {
  state.reads = (state.reads ?? 0) + 1;
  if (state.failFrom && state.reads >= state.failFrom) {
    save();
    process.stderr.write("failed to connect to local Tailscale service; is Tailscale running?\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(serve));
  if (state.later && state.reads === state.later.after) {
    serve.Web = { ...serve.Web, [host]: { Handlers: { ...serve.Web?.[host]?.Handlers, ...state.later.handlers } } };
    delete state.later;
  }
  save();
  process.exit(0);
}
else if (off !== null && off[1] === "funnel" && !state.allow) notAllowed();
else if (off !== null) {
  const handlers = serve.Web?.[host]?.Handlers ?? {};
  const mounts = off[2] === undefined ? Object.keys(handlers) : [off[2]];
  if (mounts.length === 0 || mounts.some((mount) => handlers[mount] === undefined)) {
    process.stderr.write("error: failed to remove web serve: handler does not exist\\n\\n");
    process.exit(1);
  }
  for (const mount of mounts) delete handlers[mount];
  if (Object.keys(handlers).length === 0) {
    delete serve.Web?.[host]; delete serve.TCP?.["443"]; delete serve.AllowFunnel?.[host];
  }
  save();
  process.exit(0);
} else if (words === "funnel --bg --yes --https=443 ${OURS}") {
  if (!state.allow) notAllowed();
  else if (state.failSet) process.exit(1);
  else {
    serve.TCP = { ...serve.TCP, 443: { HTTPS: true } };
    serve.Web = { ...serve.Web, [host]: { Handlers: { ...serve.Web?.[host]?.Handlers, "/": { Proxy: "${OURS}" }, ...state.race } } };
    serve.AllowFunnel = { ...serve.AllowFunnel, [host]: true };
    delete state.race;
    save();
    process.stdout.write("Available on the internet:\\n\\nhttps://" + host.replace(/:443$/, "") + "/\\n|-- proxy ${OURS}\\n\\nFunnel started and running in the background.\\n");
    process.exit(0);
  }
} else {
  process.stderr.write("the fake knows no " + words + "\\n");
  process.exit(2);
}
`;
}
