import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { LAPSE_MS, openLedger, type Came, type CallItem, type Ledger } from "@lifestreamprotocol/model";
import { resolve, type Access, type DraftAccess } from "@lifestreamprotocol/privacy";
import { defaultAccess, emptyAccess, fullAccess } from "./access.js";
import { ACCESS_NOT_STARTED, personIn, requestIn } from "./access-ledger.js";
import { moveAccess } from "./access-move.js";
import type { AccessChange, AccessDraft, AgentAsk, AgentRead, AgentRow, AnswerReply, HistoryPage, HistoryRead, ReadPage, SignInRead, ThingsPage, WaitingList } from "./access-routes.js";
import { ACCESS_UNSAVED, plainOf, SCREEN as SCREEN_LINE, signInOver, type AskWant } from "./access-words.js";
import type { Added, Granted } from "./agents.js";
import { serveDoor } from "./door.js";
import { startHome, type Home } from "./home.js";
import { adopt } from "./lifecycle.js";
import { machine } from "./machine.js";
import { peopleFileOf, readNameTable } from "./people.js";
import { mintPrincipal } from "./principals.js";
import { makeRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { askHome } from "./socket.js";
import { ship } from "./test/harness-deliveries.js";
import { clientFixture, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { PAGES, type Guide } from "./pages.js";
import { editSettings, TEST_UNIT, testSocket } from "./test/folder.js";
import { DEVICE, REPO, wordsAt, wordsOnly } from "./test/support.js";
import type { Citation } from "./search-contract.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const report: Record<string, unknown> = {};
afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "access-routes.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const FIXTURES = join(REPO, "homelink", "Tests", "Fixtures", "agents", "door");
const WRITE = process.env.LIFESTREAM_FIXTURES === "write";
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORK = "gmail:person-a@example.com";
const HOME_MAIL = "gmail:person-b@example.com";
const CHAT = "whatsapp:15550000001";
const WATCH = "whoop:person-a@example.com";
const SCREEN = "screen:local";
const NOTES = "apple-notes:local";
const SOURCES = {
  [`${WORK}:cloud`]: "gmail", [`${HOME_MAIL}:cloud`]: "gmail", [`${CHAT}:macbook-pro-0001`]: "whatsapp-db", [`${WATCH}:cloud`]: "whoop-capture",
  [`${SCREEN}:macbook-pro-0001`]: "screen-recorder", [`${NOTES}:poll`]: "fake-rows",
};
const CLIENT = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const RESOURCE = "https://macbook-pro-0001.tail0000.ts.net/mcp";

interface Answer { status: number; body: JsonObject }

const PAGE = "482915";

function pinned(answer: Answer): Answer {
  const list = answer.body as unknown as WaitingList;
  return { status: answer.status, body: { ...list, position: "1:0", requests: list.requests } as unknown as JsonObject };
}

function seeded(): (bytes: number) => Buffer {
  let state = 7;
  return (bytes) => Buffer.from(Array.from({ length: bytes }, () => (state = (state * 1_103_515_245 + 12_345) >>> 0) >>> 24));
}

function contract() {
  const files = new Map<string, string>();
  const names = new Map<string, string>();
  return {
    name(value: string, as: string) {
      names.set(value, as);
    },
    write(file: string, route: string, request: unknown, answer: Answer) {
      let text = JSON.stringify({ route, request: request ?? null, status: answer.status, answer: answer.body }, null, 2);
      for (const [value, as] of names) text = text.split(value).join(as);
      const seen = new Map<string, string>();
      text = text.replace(/\b(rq|call)-[0-9a-f]{16}\b|\bp-[0-9a-f]{8}\b/gu, (id, kind: string | undefined) => {
        if (!seen.has(id)) {
          const count = [...seen.keys()].filter((each) => each.startsWith(kind ?? "p-")).length + 1;
          seen.set(id, kind === undefined ? `p-${count.toString(16).padStart(8, "0")}` : `${kind}-${count.toString(16).padStart(16, "0")}`);
        }
        return seen.get(id)!;
      });
      expect(files.has(file), `one case, one file: ${file}`).toBe(false);
      files.set(file, `${text}\n`);
    },
    settle() {
      if (WRITE) {
        rmSync(FIXTURES, { recursive: true, force: true });
        mkdirSync(FIXTURES, { recursive: true });
        for (const [file, text] of files) writeFileSync(join(FIXTURES, `${file}.json`), text);
        return;
      }
      const held = existsSync(FIXTURES) ? readdirSync(FIXTURES).filter((file) => file.endsWith(".json")).sort() : [];
      expect(held, "homelink/Tests/Fixtures/agents/door/ holds these cases: LIFESTREAM_FIXTURES=write writes them").toEqual([...files.keys()].map((file) => `${file}.json`).sort());
      for (const [file, text] of files) expect(readFileSync(join(FIXTURES, `${file}.json`), "utf8"), `homelink/Tests/Fixtures/agents/door/${file}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(text);
    },
  };
}

async function running(steps: Record<string, unknown>) {
  let now = NOW;
  const clock = () => now;
  const root = makeRoot("lifestream-access-routes-", { sources: SOURCES, settings: {
    "families.messages": {}, "families.mail": {}, "families.health": {}, "families.ai": {}, "families.photos": {}, "families.voice": {}, "families.physical": {}, "families.notes": {},
  } });
  const dir = mkdtempSync(join(tmpdir(), "lifestream-access-machine-"));
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: TEST_UNIT, tailscale: join(dir, "no-tailscale") }));
  const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
  await adopt(root, { machine: at, now: clock });
  const principals = openHomeFolder(root);
  const pass = () => randomBytes(32).toString("base64url");
  const passes = { reader: pass(), phone: pass(), mac: pass(), extension: pass() };
  mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: 0 });
  mintPrincipal(principals, { unit: "iphone-17-pro-aa01", kind: "phone", scopes: ["deliver", "read"], sources: ["location:local:iphone-17-pro-aa01"], token: passes.phone, now_ms: 0 });
  mintPrincipal(principals, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [`${SCREEN}:macbook-pro-0001`], token: passes.mac, now_ms: 0 });
  mintPrincipal(principals, { unit: "chrome-0001", kind: "extension", scopes: ["station"], token: passes.extension, now_ms: 0 });
  const door = await serveDoor(root, { port: 0, lan_port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, clock, registry: FAKES, machine: at });
  editSettings(root, { "door.port": door.port });
  const home: Home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock, machine: at, log: () => undefined, tickMs: TICK_MS, random: seeded() });
  const people = peopleFileOf(root, at.dir);
  await until("People's first file", () => readNameTable(openHomeFolder(dirname(people)), people) !== undefined);
  const ledger: Ledger = openLedger(openHomeFolder(root), { mode: "write" });
  expect([ledger.access.all().map((each) => each.reader), ledger.access.moved()], "the start makes the move: Chat's access, and no agent's").toEqual([["ask"], NOW]);
  onTestFinished(async () => {
    ledger.close();
    await door.close();
    await home.stop();
    removeRoot(root);
    rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${door.port}`;
  const sock = testSocket(root, at.dir);
  const token = (reader: string) => readFileSync(join(dir, reader, "door-token"), "utf8").trim();
  let asked = 0;
  const call = async (step: string, method: string, path: string, bearer: string, body?: unknown, headers: Record<string, string> = {}): Promise<Answer> => {
    const response = await fetch(`${url}${path}`, {
      method, ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
    });
    const text = await response.text();
    const answer: Answer = { status: response.status, body: text === "" ? {} : JSON.parse(text) as JsonObject };
    steps[`${(asked += 1).toString().padStart(3, "0")} ${step}`] = { method, path, status: answer.status, ...(typeof answer.body.code === "string" ? { code: answer.body.code } : {}) };
    return answer;
  };
  const as = {
    phone: (step: string, method: string, path: string, body?: unknown) => call(step, method, path, passes.phone, body, DEVICE.phone),
    mac: (step: string, method: string, path: string, body?: unknown) => call(step, method, path, passes.mac, body, DEVICE.mac),
    reader: (step: string, method: string, path: string, body?: unknown) => call(step, method, path, passes.reader, body),
    chat: (step: string, method: string, path: string, body?: unknown) => call(step, method, path, passes.reader, body, { "lifestream-chat": "chat-1" }),
  };
  return { root, url, machineDir: at.dir, sock, ledger, passes, token, call, as, tick: (ms: number) => { now += ms; }, now: () => now };
}

type Running = Awaited<ReturnType<typeof running>>;

type Called = { tool?: string; read: JsonObject; sent?: JsonObject; counts?: Record<string, number>; refused?: { code: string; words: string } } & ({ came?: Came; items?: never } | { items: readonly CallItem[]; came?: never });

function called(at: Running, reader: string, call: Called): string {
  const tool = call.tool ?? "search";
  const begun = at.ledger.access.begin({ reader, tool, sent: call.sent ?? call.read, read: call.read, at_ms: at.now() });
  if (call.counts !== undefined) {
    at.ledger.outbound.write({ at_ms: at.now(), receiver: reader, route: "/mcp", by: null, what: "read", tool, level: "names", counts: call.counts, chars: 1, pictures: 0, key: null, attempt: null, refs: [], call: begun.id });
  }
  at.ledger.access.end(begun.id, {
    result: call.refused === undefined ? "answered" : "refused", ...(call.refused === undefined ? {} : { code: call.refused.code }), words: call.refused?.words ?? null, ms: 9, withheld: [],
    ...(call.items === undefined ? { came: call.came ?? {} } : { items: call.items }),
  });
  return begun.id;
}

function grant(at: Running, reader: string, access: Access): void {
  const now = at.ledger.access.get(reader);
  at.ledger.access.change(reader, { from: now?.version ?? 0, what: now === undefined ? "granted" : "widened", lines: access as never, covers: [] }, { at_ms: at.now(), by: "person", device: null });
}

const EXISTING = [{ account: WORK, category: "mail" }, { account: HOME_MAIL, category: "mail" }, { account: CHAT, category: "messages" }, { account: WATCH, category: "health" }] as const;

function ask(at: Running, reader: string, want: AskWant, for_ms: number | null, reason: string, at_ms = at.now()) {
  const made = requestIn(at.ledger, { reader, want, reason, for_ms, now_ms: at_ms });
  if (!("request" in made)) throw new Error(`the request was held: ${JSON.stringify(made)}`);
  return made.request;
}

describe("the person's routes of access", () => {
  it("answer every route in the contract files' shapes, refuse each by its status and code, never write over a change made since; one waiting list of sign-ins and requests, and one answer route for both", async () => {
    const steps: Record<string, unknown> = {};
    report.routes = steps;
    const at = await running(steps);
    const files = contract();
    const { as } = at;

    const unmoved = openLedger(openHomeFolder(mkdtempSync(join(tmpdir(), "lifestream-unmoved-"))), { mode: "migrate" });
    const early = refusedIn(() => personIn(unmoved, { save: { reader: "ask", access: fullAccess("none"), expect: 0, widen: true, by: "person", device: null, existing: EXISTING, now_ms: at.now() } }));
    expect([early.status, early.body.code]).toEqual([409, ACCESS_NOT_STARTED]);
    files.write("access-not-started", "POST /v1/agents/<id>/access", { access: fullAccess("none"), expect: 0 }, early);
    const earlyProposal = refusedIn(() => personIn(unmoved, { propose: { reader: "ask", access: fullAccess("none"), expect: 0, by: "chat", device: null, existing: EXISTING, now_ms: at.now() } }));
    expect([earlyProposal.status, earlyProposal.body.code]).toEqual([409, ACCESS_NOT_STARTED]);
    files.write("propose-not-started", "POST /v1/agents/<id>/propose", { access: fullAccess("none"), expect: 0 }, earlyProposal);
    expect([unmoved.access.all(), unmoved.access.moved()], "a write before the move writes nothing").toEqual([[], null]);
    unmoved.close();
    expect(moveAccess({ folder: openHomeFolder(at.root), access: at.ledger.access, existing: () => EXISTING, now_ms: at.now() }), "the start made the move").toBe(false);
    expect(at.ledger.access.get("ask")).toMatchObject({ version: 1, lines: fullAccess("none") });

    const add = async (name: string) => (await askHome(at.sock, "agents", ["add", name]) as Added).agent.id;
    const hermes = await add("Hermes");
    const instinct = await add("Instinct");
    const gpt = mintPrincipal(openHomeFolder(at.root), {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: at.now(), granted: { agent: { name: "ChatGPT", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    }).principal.id;
    expect(at.ledger.access.all().map((each) => [each.reader, each.version, each.lines]), "a copied pass mints with the default access; a pass written by hand has none")
      .toEqual([["ask", 1, fullAccess("none")], [hermes, 1, defaultAccess()], [instinct, 1, defaultAccess()]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    const none = await as.phone("nothing waiting", "GET", "/v1/agents/waiting");
    expect(pinned(none).body).toEqual({ position: "1:0", today: expect.any(String), requests: [], asks: [] });
    files.write("waiting-none", "GET /v1/agents/waiting", null, pinned(none));
    const request = await at.call("claude: request", "POST", "/v1/agents/request", at.token("mcp"), { name: "Claude", checked: true, host: "claude.ai" });
    const signIn = request.body as { id: string; code: string };
    files.name(signIn.id, "c2lnbi1pbi0wMDAwMDAwMQ");
    const waiting = await as.phone("waiting with a sign-in", "GET", "/v1/agents/waiting");
    const listed = waiting.body as unknown as WaitingList;
    expect(listed.asks).toEqual([]);
    expect(listed.requests).toEqual([expect.objectContaining({
      id: signIn.id, name: "Claude", checked: true, host: "claude.ai", access: defaultAccess(),
      sentence: "Claude reads everything but Health and Money. Details hidden, names shown.",
      head: "Claude wants to read your Lifestream", over: "This sign-in is over. Start it again in claude.ai.",
      over_line: wordsOnly("From claude.ai"), app: "claude", notice: "Claude wants to read your Lifestream. Type the code it shows.",
      pick: "Type the code Claude shows", pick_line: "The code is the yes. A wrong one turns Claude away.",
    })]);
    const unedited = await as.phone("the sign-in's access drawn, unedited", "POST", "/v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: null });
    expect(listed.requests[0]!.view, "the card draws the view the editor opens on, with no second call").toEqual((unedited.body as unknown as AccessDraft).view);
    files.write("waiting-sign-in", "GET /v1/agents/waiting", null, pinned(waiting));
    expect(pinned(await as.mac("the Mac app's pass on the waiting list", "GET", "/v1/agents/waiting")).body, "the Mac app reads the one list with its own pass").toEqual(pinned(waiting).body);
    expect(pinned({ status: 200, body: await askHome(at.sock, "agents", ["waiting"]) as JsonObject }).body, "the Mac's socket verb answers the route").toEqual(pinned(waiting).body);
    const browserWaiting = await as.reader("a browser reads the waiting list", "GET", "/v1/agents/waiting");
    expect([browserWaiting.status, browserWaiting.body.code]).toEqual([403, "PERSON_ONLY"]);
    expect((await as.chat("a turn reads the waiting list", "GET", "/v1/agents/waiting")).body.code).toBe("PERSON_ONLY");

    const signInDraft = await as.phone("sign-in draft: past 24 hours", "POST", "/v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: { window: { past_ms: 86_400_000 } } });
    expect(signInDraft.status).toBe(200);
    files.write("edit-sign-in", "POST /v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: { window: { past_ms: 86_400_000 } } }, signInDraft);
    const fromBrowser = await as.reader("sign-in draft from a browser", "POST", "/v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: null });
    expect(fromBrowser.status).toBe(200);
    files.write("edit-sign-in-browser", "POST /v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: null }, fromBrowser);
    const chosen = (signInDraft.body as unknown as AccessDraft).access;
    const fromBrowserAnswer = await as.reader("a browser answers", "POST", "/v1/agents/answer", { id: signIn.id, answer: signIn.code });
    expect([fromBrowserAnswer.status, fromBrowserAnswer.body.code]).toEqual([403, "PERSON_ONLY"]);
    files.write("answer-person-only", "POST /v1/agents/answer", { id: signIn.id, answer: PAGE }, fromBrowserAnswer);
    expect((await as.chat("a turn answers", "POST", "/v1/agents/answer", { id: signIn.id, answer: signIn.code })).body.code).toBe("PERSON_ONLY");
    const stillWaiting = await as.mac("the Mac reads a sign-in still waiting", "GET", `/v1/agents/signins/${signIn.id}`);
    expect(stillWaiting.body).toEqual({ id: signIn.id, state: "waiting", outcome: null, reader: null, connected: null } satisfies SignInRead);
    files.write("signin-waiting", "GET /v1/agents/signins/<id>", null, stillWaiting);
    const approved = await as.phone("the page's number, after Change", "POST", "/v1/agents/answer", { id: signIn.id, answer: signIn.code, access: chosen });
    expect(approved.body, "a sign-in's answer: its state, no version, the home's words").toEqual({ state: "approved", version: null, outcome: wordsAt("Allowed on iPhone,", expect.any(Number)), reader: null, connected: null } as unknown as AnswerReply);
    files.write("answer-sign-in", "POST /v1/agents/answer", { id: signIn.id, answer: PAGE, access: chosen }, approved);
    const elsewhere = await as.mac("the Mac reads the sign-in its card held, answered on the iPhone", "GET", `/v1/agents/signins/${signIn.id}`);
    expect(elsewhere.body, "what became of it, in the answer's own words").toEqual({ id: signIn.id, state: "approved", outcome: approved.body.outcome, reader: null, connected: null });
    files.write("signin-answered", "GET /v1/agents/signins/<id>", null, elsewhere);
    const gone = await as.mac("a sign-in the home no longer holds", "GET", "/v1/agents/signins/AAAAAAAAAAAAAAAAAAAAAA");
    expect([gone.status, gone.body], "over, by the home's clock: gone, never a refusal").toEqual([200, { id: "AAAAAAAAAAAAAAAAAAAAAA", state: "gone", outcome: null, reader: null, connected: null }]);
    files.write("signin-over", "GET /v1/agents/signins/<id>", null, gone);
    const answeredAgain = await as.phone("the sign-in answered again", "POST", "/v1/agents/answer", { id: signIn.id, answer: signIn.code });
    expect([answeredAgain.status, answeredAgain.body], "a retry after a lost reply writes nothing and answers the real state and outcome").toEqual([200, approved.body]);
    files.write("answer-sign-in-ended", "POST /v1/agents/answer", { id: signIn.id, answer: PAGE }, answeredAgain);
    const denying = (await at.call("local: request", "POST", "/v1/agents/request", at.token("mcp"), { name: "Local", checked: false, host: null })).body as { id: string; code: string };
    files.name(denying.id, "c2lnbi1pbi0wMDAwMDAwMg");
    const denyAccess = await as.phone("Don't allow, with an access", "POST", "/v1/agents/answer", { id: denying.id, answer: "deny", access: defaultAccess() });
    expect([denyAccess.status, denyAccess.body.code]).toEqual([422, "BAD_REQUEST"]);
    const denied = await as.phone("Don't allow", "POST", "/v1/agents/answer", { id: denying.id, answer: "deny" });
    expect(denied.body, "a refusal says where and when, as an allow does").toEqual({ state: "denied", version: null, outcome: wordsAt("Not allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    files.write("answer-sign-in-deny", "POST /v1/agents/answer", { id: denying.id, answer: "deny" }, denied);
    const mistaken = (await at.call("mistaken: request", "POST", "/v1/agents/request", at.token("mcp"), { name: "Mistaken", checked: false, host: null })).body as { id: string; code: string };
    files.name(mistaken.id, "c2lnbi1pbi0wMDAwMDAwMw");
    const other = mistaken.code === "000000" ? "000001" : "000000";
    const wrong = await as.mac("another code, on the Mac", "POST", "/v1/agents/answer", { id: mistaken.id, answer: other });
    expect(wrong.body).toEqual({ state: "wrong", version: null, outcome: wordsOnly("Wrong code, so Mistaken wasn’t let in. Start the sign-in again in Mistaken."), reader: null, connected: null });
    const wrongAgain = await as.mac("the right number after a wrong one", "POST", "/v1/agents/answer", { id: mistaken.id, answer: mistaken.code });
    expect([wrongAgain.status, wrongAgain.body], "a wrong code ends the sign-in: the right one after it changes nothing").toEqual([200, wrong.body]);
    files.write("answer-sign-in-wrong", "POST /v1/agents/answer", { id: mistaken.id, answer: PAGE }, wrong);
    const granted = await at.call("claude: grant", "POST", "/v1/agents/grant", at.token("mcp"), { id: signIn.id, client_id: CLIENT, resource: RESOURCE });
    const claude = (granted.body as unknown as Granted).grant;
    expect(at.ledger.access.get(claude), "a sign-in mints with the access its answer carried").toMatchObject({ version: 1, lines: chosen });
    const signedIn = (await as.reader("the sign-in's history", "GET", `/v1/agents/${claude}/history`)).body as unknown as HistoryPage;
    expect(signedIn.sessions.flatMap((each) => each.lines).map((each) => [each.words, each.kind === "change" ? each.line : null]), "the grant names the device that answered, as the answer's outcome does")
      .toEqual([["You allowed Claude", "You, on your iPhone · Everything but Health and Money · past 24 hours · details hidden"]]);

    const guideOf = (answer: Answer, app: string) => (answer.body.apps as unknown as Guide[]).find((each) => each.app === app)!;
    const macGuides = await as.mac("the guides, on the Mac", "GET", "/v1/agents/guides");
    expect(macGuides.status).toBe(200);
    expect(() => PAGES.agentGuides.shape.parse(macGuides.body), "the page's shape").not.toThrow();
    expect(guideOf(macGuides, "claude"), "the sign-in's reader connects Claude's guide").toMatchObject({ connected: claude, steps: [{ kind: "add", where: "In the sidebar", open: { to: "web" } }, { kind: "yes" }] });
    expect([guideOf(macGuides, "chatgpt").connected, guideOf(macGuides, "instinct").connected], "a key named Instinct by hand is no guide's").toEqual([null, null]);
    const phoneGuides = await as.phone("the guides, on the iPhone", "GET", "/v1/agents/guides");
    expect(guideOf(phoneGuides, "claude").steps[0], "the iPhone's first step is on a computer").toMatchObject({ where: "On a computer", open: null });
    expect(guideOf(phoneGuides, "grok-bot").steps.map((step) => step.kind)).toEqual(["elsewhere"]);
    expect(guideOf(phoneGuides, "instinct").steps.map((step) => step.kind)).toEqual(["message", "sees", "give"]);
    const guidesRead = (headers: Record<string, string> = {}) => fetch(`${at.url}/v1/agents/guides`, { headers: { authorization: `Bearer ${at.passes.phone}`, ...DEVICE.phone, ...headers } });
    const guidesTag = (await guidesRead()).headers.get("etag")!;
    expect((await guidesRead({ "if-none-match": guidesTag })).status, "the same guides: 304").toBe(304);
    for (const [step, asked] of [["a browser reads the guides", as.reader], ["a turn reads the guides", as.chat]] as const) {
      const refused = await asked(step, "GET", "/v1/agents/guides");
      expect([refused.status, refused.body.code], step).toEqual([403, "PERSON_ONLY"]);
    }
    const marked = (await as.phone("the list, each row with its mark", "GET", "/v1/agents")).body.readers as unknown as AgentRow[];
    expect(Object.fromEntries(marked.filter((row) => [claude, hermes, "ask"].includes(row.id)).map((row) => [row.id, row.mark])), "Claude's guide mark, Chat's, the default").toEqual({ [claude]: "claude", [hermes]: "ai-apps", ask: "chat" });
    const ended = await as.reader("a draft of an ended sign-in", "POST", "/v1/agents/edit", { target: { request: signIn.id }, access: defaultAccess(), expect: null, edit: null });
    expect([ended.status, ended.body.code, ended.body.message]).toEqual([404, "AGENT_REQUEST_GONE", signInOver(null)]);
    const wrongDraft = { target: { request: mistaken.id }, access: defaultAccess(), expect: null, edit: null };
    files.write("edit-sign-in-ended", "POST /v1/agents/edit", wrongDraft, await as.reader("a draft of a sign-in a wrong number ended", "POST", "/v1/agents/edit", wrongDraft));

    const noAccess = await as.reader("a reader with no access", "GET", `/v1/agents/${gpt}`);
    expect(noAccess.body, "no access: the empty access at version 0, never null").toMatchObject({ access: emptyAccess(), version: 0, view: { sentence: [{ text: "ChatGPT sees nothing yet." }], widens: false, screen: null } });
    files.write("reader-no-access", "GET /v1/agents/<id>", null, noAccess);
    const screenSent = { target: { reader: gpt }, access: emptyAccess(), expect: 0, edit: { type: "device-activity", on: true } };
    const screenDraft = await as.reader("Settings: the screen on, from no access", "POST", "/v1/agents/edit", screenSent);
    expect(screenDraft.body).toMatchObject({ expect: 0, view: { widens: true, screen: expect.any(String) } });
    files.write("edit-screen", "POST /v1/agents/edit", screenSent, screenDraft);

    for (const [id, access] of [[hermes, defaultAccess()], [instinct, defaultAccess()], [claude, chosen]] as const) {
      const saved = await as.phone(`${id}: saved again from the iPhone, unchanged`, "POST", `/v1/agents/${id}/access`, { access, expect: 1 });
      expect(saved.body).toMatchObject({ expect: 1 });
    }
    const chatGranted = await as.phone("Chat: its moved access saved again, unchanged", "POST", "/v1/agents/ask/access", { access: fullAccess("none"), expect: 1 });
    expect(chatGranted.body).toMatchObject({ expect: 1, view: { hide: null, sentence: [{ text: "Chat sees everything." }] } });
    expect(at.ledger.access.changes(hermes, { limit: 1 })[0]).toMatchObject({ what: "granted", by: "person", version: 1 });
    expect(at.ledger.access.changes("ask", { limit: 2 }).map((each) => [each.what, each.by])).toEqual([["granted", "home"]]);
    const chat = await as.reader("Chat whole", "GET", "/v1/agents/ask");
    expect(chat.body).toMatchObject({ id: "ask", name: "Chat", kind: "chat", version: 1, ask: null, view: { hide: null } });
    files.write("reader-chat", "GET /v1/agents/<id>", null, chat);
    const chatHide = { target: { reader: "ask" }, access: fullAccess("none"), expect: 1, edit: { hide: "all" } };
    const chatHideRefused = await as.phone("Chat's hiding in the editor", "POST", "/v1/agents/edit", chatHide);
    expect([chatHideRefused.status, chatHideRefused.body.code]).toEqual([422, "BAD_REQUEST"]);
    files.write("edit-chat-hide-refused", "POST /v1/agents/edit", chatHide, chatHideRefused);
    const chatSaveRefused = await as.phone("Chat's access saved with a hiding", "POST", "/v1/agents/ask/access", { access: fullAccess("names"), expect: 1 });
    expect([chatSaveRefused.status, chatSaveRefused.body.code, at.ledger.access.get("ask")?.version]).toEqual([422, "BAD_REQUEST", 1]);
    files.write("access-chat-hide-refused", "POST /v1/agents/<id>/access", { access: fullAccess("names"), expect: 1 }, chatSaveRefused);

    const hermesRead = (await as.reader("hermes whole", "GET", `/v1/agents/${hermes}`)).body as unknown as AgentRead;
    files.write("reader-agent", "GET /v1/agents/<id>", null, { status: 200, body: hermesRead as unknown as JsonObject });
    const editor = await add("Editor");
    let saved: { access: Access; expect: number } = { access: defaultAccess(), expect: 1 };
    let draft: DraftAccess = saved.access;
    const branches: [string, JsonObject | null, "draft" | "narrowed"][] = [
      ["draw", null, "draft"], ["window", { window: { past_ms: 30 * DAY } }, "narrowed"], ["type-on", { type: "health", on: true }, "draft"],
      ["type-window", { type: "mail", window: { past_ms: 7 * DAY } }, "narrowed"], ["account-on", { account: WATCH, on: false }, "draft"],
      ["account-window", { account: WORK, window: { since_ms: NOW - 90 * DAY } }, "draft"], ["account-off", { account: WORK, on: false }, "narrowed"],
      ["hide", { hide: "custom" }, "draft"],
      ["detail", { detail: "phone", hidden: false }, "draft"],
    ];
    const drawnBy = new Map<string, AccessDraft>();
    for (const [branch, edit, becomes] of branches) {
      const sent = { target: { reader: editor }, access: branch === "detail" ? draft : saved.access, expect: saved.expect, edit };
      const drawn = await as.reader(`edit: ${branch}`, "POST", "/v1/agents/edit", sent);
      expect(drawn.status, `${branch}: ${JSON.stringify(drawn.body)}`).toBe(200);
      files.write(`edit-${branch}`, "POST /v1/agents/edit", sent, drawn);
      const body = drawn.body as unknown as AccessDraft;
      expect(body.narrowed === null ? "draft" : "narrowed", `${branch}: a narrowing is saved at once, anything else stays a draft`).toBe(becomes);
      if (body.narrowed !== null) {
        expect(body.narrowed.undo, `${branch}: its Undo puts back the access it was drawn from`).toEqual({ access: saved.access, expect: saved.expect + 1 });
        expect([body.expect, at.ledger.access.get(editor)?.version]).toEqual([saved.expect + 1, saved.expect + 1]);
        saved = { access: body.access as Access, expect: body.expect! };
      }
      expect(body.view.widening === null, `${branch}: a widening draft says what it adds`).toBe(!body.view.widens);
      draft = body.access;
      drawnBy.set(branch, body);
    }
    expect(draft.hide, "Custom's draft, a type shown").not.toContain("phone");
    expect(drawnBy.get("account-off")!.view.categories.find((each) => each.type === "mail"), "a category with part off: some, and says which").toMatchObject({ state: "some", line: expect.stringMatching(/ not read$/u) });
    expect(drawnBy.get("type-on")!.view.widening).toEqual([{ text: "Editor would also see " }, { text: "Health", bold: true }, { text: ". Nothing changes until you allow it." }]);
    expect(at.ledger.access.changes(editor, { limit: 1 })[0], "the editor's narrowing, the person's").toMatchObject({ what: "narrowed", by: "person" });
    expect(at.ledger.access.get(hermes)?.version, "a draft writes nothing").toBe(1);
    const reset = await as.phone("the editor's access set back to the default", "POST", `/v1/agents/${editor}/access`, { access: defaultAccess(), expect: saved.expect });
    expect(reset.body).toMatchObject({ expect: saved.expect + 1 });
    saved = { access: defaultAccess(), expect: saved.expect + 1 };
    const narrowing = { target: { reader: editor }, access: saved.access, expect: saved.expect, edit: { type: "messages", on: false } };
    const turnedOff = await as.phone("the editor turns Messages off: saved at once", "POST", "/v1/agents/edit", narrowing);
    const narrowedBody = turnedOff.body as unknown as AccessDraft;
    expect(narrowedBody).toMatchObject({ expect: saved.expect + 1, narrowed: { words: [{ text: "Saved. Editor no longer sees your " }, { text: "messages", bold: true }, { text: "." }], undo: { access: saved.access, expect: saved.expect + 1 } }, view: { widens: false, widening: null } });
    files.write("edit-narrowed", "POST /v1/agents/edit", narrowing, turnedOff);
    const widening = { target: { reader: editor }, access: narrowedBody.access, expect: narrowedBody.expect, edit: { type: "health", on: true } };
    const waits = await as.phone("then Health on: a draft that waits for Allow", "POST", "/v1/agents/edit", widening);
    expect(waits.body).toMatchObject({ expect: narrowedBody.expect, narrowed: null, view: { widens: true, widening: [{ text: "Editor would also see " }, { text: "Health", bold: true }, { text: ". Nothing changes until you allow it." }] } });
    expect(at.ledger.access.get(editor)?.version, "a widening waits for Allow").toBe(narrowedBody.expect);
    files.write("edit-widening", "POST /v1/agents/edit", widening, waits);
    const undoSent = { access: narrowedBody.narrowed!.undo.access, expect: narrowedBody.narrowed!.undo.expect };
    const browserUndo = await as.reader("Undo from a browser", "POST", `/v1/agents/${editor}/access`, undoSent);
    expect([browserUndo.status, browserUndo.body.code], "an Undo puts back more: the person's devices alone").toEqual([403, "PERSON_ONLY"]);
    const undone = await as.phone("Undo: one call puts the access back", "POST", `/v1/agents/${editor}/access`, undoSent);
    expect(undone.body).toMatchObject({ access: saved.access, expect: undoSent.expect + 1, narrowed: null });
    expect(at.ledger.access.changes(editor, { limit: 1 })[0]).toMatchObject({ what: "widened", by: "person" });
    files.write("access-undo", "POST /v1/agents/<id>/access", undoSent, undone);
    const undoAgain = await as.phone("Undo again, after a lost reply", "POST", `/v1/agents/${editor}/access`, undoSent);
    expect([undoAgain.status, undoAgain.body.code, at.ledger.access.get(editor)?.version], "the version guards it: written once").toEqual([409, "ACCESS_CHANGED", undoSent.expect + 1]);
    for (const edit of [{ not: "person-alex", on: true }, { only: "person-sam", on: true }, { drop_shown: 0 }, { drop_item: 0 }]) {
      const later = await as.reader(`edit: ${Object.keys(edit)[0]}, no edit of the first release`, "POST", "/v1/agents/edit", { target: { reader: hermes }, access: hermesRead.access, expect: 1, edit });
      expect([later.status, later.body.code]).toEqual([422, "BAD_REQUEST"]);
    }
    const offHome = { target: { reader: hermes }, access: draft, expect: 1, edit: { account: "gmail:person-z@example.com", on: true } };
    expect((await as.reader("an account not on the home", "POST", "/v1/agents/edit", offHome)).body.code).toBe("BAD_REQUEST");

    const narrower: Access = { ...hermesRead.access, window: { past_ms: DAY } };
    const narrowed = await as.reader("save a narrowing from a browser", "POST", `/v1/agents/${hermes}/access`, { access: narrower, expect: 1 });
    expect(narrowed.body).toMatchObject({ access: narrower, expect: 2, view: { widens: false } });
    files.write("access-narrowed", "POST /v1/agents/<id>/access", { access: narrower, expect: 1 }, narrowed);
    expect(at.ledger.access.changes(hermes, { limit: 1 })[0]).toMatchObject({ what: "narrowed", by: "person", version: 2 });
    const again = await as.reader("the same save again, after a lost reply", "POST", `/v1/agents/${hermes}/access`, { access: narrower, expect: 2 });
    expect([again.status, at.ledger.access.get(hermes)?.version]).toEqual([200, 2]);
    const wider: Access = { ...narrower, allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }] };
    const browserWiden = await as.reader("a widening from a browser", "POST", `/v1/agents/${hermes}/access`, { access: wider, expect: 2 });
    expect([browserWiden.status, browserWiden.body.code]).toEqual([403, "PERSON_ONLY"]);
    files.write("access-person-only", "POST /v1/agents/<id>/access", { access: wider, expect: 2 }, browserWiden);
    const beside = await at.call("a widening with a server's pass beside the phone's", "POST", `/v1/agents/${hermes}/access`, at.passes.phone, { access: wider, expect: 2 }, { ...DEVICE.phone, "lifestream-server": at.token("mcp") });
    expect(beside.body.code).toBe("PERSON_ONLY");
    const chatWiden = await as.chat("a widening by Chat", "POST", `/v1/agents/${hermes}/access`, { access: wider, expect: 2 });
    expect(chatWiden.body.code).toBe("PERSON_ONLY");
    const stale = await as.phone("a save made from version 1", "POST", `/v1/agents/${hermes}/access`, { access: wider, expect: 1 });
    expect([stale.status, stale.body.code, at.ledger.access.get(hermes)?.version]).toEqual([409, "ACCESS_CHANGED", 2]);
    files.write("access-stale", "POST /v1/agents/<id>/access", { access: wider, expect: 1 }, stale);
    const staleEdit = { target: { reader: hermes }, access: draft, expect: 1, edit: null };
    files.write("edit-stale-refused", "POST /v1/agents/edit", staleEdit, await as.reader("an edit on a stale draft", "POST", "/v1/agents/edit", staleEdit));
    const overlapping: Access = {
      ...emptyAccess(), allow: [
        { reach: { all: true, but: ["health", "money"] }, window: null, until_ms: null },
        { reach: { type: "mail", but: [] }, window: { past_ms: 7 * DAY }, until_ms: NOW + 2 * HOUR },
        { reach: { account: WATCH, but: [] }, window: { past_ms: DAY }, until_ms: NOW + HOUR },
      ],
    };
    const widened = await as.phone("save overlapping grants from the iPhone", "POST", `/v1/agents/${hermes}/access`, { access: overlapping, expect: 2 });
    expect(widened.body).toMatchObject({ expect: 3, view: { widens: false } });
    expect(at.ledger.access.changes(hermes, { limit: 1 })[0]).toMatchObject({ what: "widened", by: "person", version: 3 });
    files.write("access-widened", "POST /v1/agents/<id>/access", { access: overlapping, expect: 2 }, widened);
    const mixed = await as.reader("hermes: overlapping grants, a mixed limit", "GET", `/v1/agents/${hermes}`);
    const mail = (mixed.body as unknown as AgentRead).view.categories.find((each) => each.type === "mail")!;
    expect(mail.limit?.value).toEqual({ mixed: true });
    files.write("reader-overlapping", "GET /v1/agents/<id>", null, mixed);
    files.write("access-unknown", "POST /v1/agents/<id>/access", { access: narrower, expect: 0 }, await as.phone("an agent that does not stand", "POST", "/v1/agents/p-00000000/access", { access: narrower, expect: 0 }));
    files.write("access-bad", "POST /v1/agents/<id>/access", { access: { allow: "everything" }, expect: 3 }, await as.phone("an access no parser takes", "POST", `/v1/agents/${hermes}/access`, { access: { allow: "everything" }, expect: 3 }));
    const later = { access: { ...overlapping, not: [{ id: "person-alex", handles: ["+15550000003"] }] }, expect: 3 };
    const laterRefused = await as.phone("an access that holds a not", "POST", `/v1/agents/${hermes}/access`, later);
    expect([laterRefused.status, laterRefused.body.code, laterRefused.body.message, at.ledger.access.get(hermes)?.version]).toEqual([422, "BAD_REQUEST", ACCESS_UNSAVED, 3]);
    files.write("access-later-refused", "POST /v1/agents/<id>/access", later, laterRefused);

    const instinctAccess = at.ledger.access.get(instinct)!.lines as unknown as Access;
    const pastDay: Access = { ...instinctAccess, window: { past_ms: DAY } };
    const proposed = await as.chat("Chat narrows Instinct", "POST", `/v1/agents/${instinct}/propose`, { access: pastDay, expect: 1 });
    expect(proposed.body).toMatchObject({
      kind: "narrowed", reader: instinct, words: [{ text: "Saved. Instinct now sees the " }, { text: "past 24 hours", bold: true }, { text: "." }],
      undo: { access: instinctAccess, expect: 2 },
    });
    expect(at.ledger.access.changes(instinct, { limit: 1 })[0]).toMatchObject({ what: "narrowed", by: "chat" });
    files.write("propose-narrowed", "POST /v1/agents/<id>/propose", { access: pastDay, expect: 1 }, proposed);
    const twice = await as.chat("Chat's narrowing again, after a lost reply", "POST", `/v1/agents/${instinct}/propose`, { access: pastDay, expect: 1 });
    expect([twice.body, at.ledger.access.get(instinct)?.version]).toEqual([proposed.body, 2]);
    const hermesNow = at.ledger.access.get(hermes)!;
    const asItIs = hermesNow.lines as unknown as Access;
    const lastRow = at.ledger.access.changes(hermes, { limit: 1 })[0]!.seq;
    const unchanged = await as.chat("Chat proposes Hermes's access as it is", "POST", `/v1/agents/${hermes}/propose`, { access: asItIs, expect: hermesNow.version });
    expect(unchanged.body).toEqual({ id: `${hermes}@${hermesNow.version}`, kind: "unchanged", reader: hermes, words: "Hermes already reads this." });
    expect([at.ledger.access.get(hermes)?.version, at.ledger.access.changes(hermes, { limit: 1 })[0]?.seq], "no change written").toEqual([hermesNow.version, lastRow]);
    files.write("propose-unchanged", "POST /v1/agents/<id>/propose", { access: asItIs, expect: hermesNow.version }, unchanged);
    const health: Access = { ...pastDay, allow: [...pastDay.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };
    const asked = await as.chat("Chat would widen Instinct", "POST", `/v1/agents/${instinct}/propose`, { access: health, expect: 2 });
    const chatAsk = asked.body as unknown as Extract<AccessChange, { kind: "asked" }>;
    expect(chatAsk).toMatchObject({ kind: "asked", snapshot: { by: "chat", head: "Let Instinct also read Health?", line: "Chat proposes Health", adds: ["Health"], keeps: "Details stay hidden.", reason: null,
      choices: [{ answer: "always", words: "Allow" }, { answer: "no", words: "Don’t allow" }], version: 2, proposed: health, state: "open" } });
    expect(plainOf(chatAsk.snapshot.today), "what it sees today, in the page's one voice").toBe("Today Instinct sees everything but Health and Money from the past 24 hours.");
    expect(at.ledger.access.get(instinct)?.version, "a widening is never applied by a proposal").toBe(2);
    files.write("propose-asked", "POST /v1/agents/<id>/propose", { access: health, expect: 2 }, asked);
    const askedTwice = await as.chat("Chat's widening again", "POST", `/v1/agents/${instinct}/propose`, { access: health, expect: 2 });
    expect((askedTwice.body as unknown as Extract<AccessChange, { kind: "asked" }>).id).toBe(chatAsk.id);
    expect(at.ledger.access.requests(instinct, at.now()).filter((each) => each.state === "open")).toHaveLength(1);
    files.write("ask-chat", "GET /v1/agents/asks/<id>", null, await as.reader("Chat's ask by id", "GET", `/v1/agents/asks/${chatAsk.id}`));
    const chatHides = await as.chat("Chat proposes a hiding for itself", "POST", "/v1/agents/ask/propose", { access: fullAccess("all"), expect: 1 });
    expect([chatHides.status, chatHides.body.code]).toEqual([422, "BAD_REQUEST"]);

    const lapsed = ask(at, claude, { read: { category: "plans" }, window: null }, HOUR, "An old plan.", NOW - 2 * DAY);
    const replaced = ask(at, claude, { read: { account: WORK }, window: null }, HOUR, "The work mailbox.");
    const open = ask(at, claude, { read: { product: "whatsapp" }, window: null }, HOUR, "Sam moved Saturday's dinner in a WhatsApp chat.");
    const calendar = ask(at, hermes, { read: { category: "plans" }, window: { since_ms: NOW - 30 * DAY } }, 3 * HOUR, "Your plans this month.");
    const dropped = ask(at, gpt, { read: "everything", window: { past_ms: DAY } }, HOUR, "Everything from today.");
    at.ledger.access.drop(gpt, 0, { at_ms: at.now(), by: "agent", device: null });
    const money = ask(at, gpt, { read: { category: "money" }, window: null }, HOUR, "Who paid for the dinner?");
    const byId = async (id: string) => (await as.phone(`ask ${id}`, "GET", `/v1/agents/asks/${id}`)).body as unknown as AgentAsk;
    const openAsk = await byId(open.id);
    expect(openAsk).toMatchObject({
      by: "agent", head: "Claude asks to see all of WhatsApp for 1 hour", line: "asks to see all of WhatsApp for 1 hour", under: "15550000001", reason: "Sam moved Saturday's dinner in a WhatsApp chat.",
      default: "once", choices: [{ answer: "once", words: "Allow for 1 hour" }, { answer: "always", words: "Always allow" }, { answer: "no", words: "Don’t allow" }], version: 1,
    });
    expect(await byId(money.id)).toMatchObject({ head: "ChatGPT asks to see Money for 1 hour", today: [{ text: "Today ChatGPT sees nothing." }], version: 0 });
    expect(await byId(calendar.id)).toMatchObject({ head: "Hermes asks to see Calendar since 15 Oct 2026 for 3 hours",
      choices: [{ answer: "once", words: "Allow for 3 hours" }, { answer: "always", words: "Always allow" }, { answer: "no", words: "Don’t allow" }], version: 3 });
    const claudeRead = await as.reader("claude whole, an ask open", "GET", `/v1/agents/${claude}`);
    expect((claudeRead.body as unknown as AgentRead).ask, "the reader's open ask, as its own read draws it").toEqual(openAsk);
    expect((claudeRead.body as unknown as AgentRead).ask!.until_ms).toBeGreaterThan(at.now());
    files.write("reader-ask", "GET /v1/agents/<id>", null, claudeRead);
    for (const [name, id] of [["ask-open", open.id], ["ask-replaced", replaced.id], ["ask-dropped", dropped.id], ["ask-lapsed", lapsed.id]] as const) {
      files.write(name, "GET /v1/agents/asks/<id>", null, await as.reader(`${name} by id`, "GET", `/v1/agents/asks/${id}`));
    }
    files.write("ask-unknown", "GET /v1/agents/asks/<id>", null, await as.reader("an ask the home never held", "GET", "/v1/agents/asks/rq-0000000000000000"));
    const own = (await askHome(at.sock, "agents-call", []) as { agent: { id: string } }).agent.id;
    const rows = (await as.reader("the list", "GET", "/v1/agents")).body.readers as unknown as AgentRow[];
    expect(rows.map((row) => row.id), "the home's own reader, lifestream agents call's, is never listed").not.toContain(own);
    expect(rows.map((row) => [row.name, row.has_ask])).toEqual([["Chat", false], ["Hermes", true], ["Instinct", true], ["ChatGPT", true], ["Claude", true], ["Editor", false]]);
    expect(rows[0], "the list's amount and place, the home's words").toMatchObject({ summary: "Hasn’t read yet", place: "Lifestream" });
    const unknownAnswer = await as.phone("a request answered with a sign-in's code", "POST", "/v1/agents/answer", { id: open.id, answer: PAGE });
    expect([unknownAnswer.status, unknownAnswer.body.code], "a code answers a sign-in alone").toEqual([404, "AGENT_REQUEST_GONE"]);

    const hermesNowRead = (await as.reader("hermes before the drafts", "GET", `/v1/agents/${hermes}`)).body as unknown as AgentRead;
    const drafted = (await at.call("a sign-in to draft", "POST", "/v1/agents/request", at.token("mcp"), { name: "Drafted", checked: false, host: null })).body as { id: string; code: string };
    const targets = [
      ["reader", { target: { reader: hermes }, access: hermesNowRead.access, expect: hermesNowRead.version, edit: null }],
      ["sign-in", { target: { request: drafted.id }, access: defaultAccess(), expect: null, edit: { mode: "but" } }],
      ["ask", { target: { request: open.id }, access: openAsk.proposed, expect: 1, edit: { type: "health", on: true } }],
    ] as const;
    const agentPass = (await askHome(at.sock, "agents", ["add", "Probe"]) as Added).pass;
    const signInRead = `/v1/agents/signins/${signIn.id}`;
    const signInBy = [
      await as.reader("a browser reads a sign-in", "GET", signInRead),
      await as.chat("a turn reads a sign-in", "GET", signInRead),
      await at.call("an agent's pass reads a sign-in", "GET", signInRead, agentPass, undefined, { "lifestream-server": at.token("mcp") }),
    ].map((each) => [each.status, each.body.code]);
    expect(signInBy, "a sign-in is read by the person alone, as the waiting list is").toEqual([[403, "PERSON_ONLY"], [403, "PERSON_ONLY"], [403, "PRINCIPAL_SCOPE"]]);
    for (const [target, sent] of targets) {
      for (const [who, draws] of [["phone", as.phone], ["Mac", as.mac], ["browser", as.reader], ["Chat", as.chat]] as const) {
        const drawn = await draws(`${target} draft from ${who}`, "POST", "/v1/agents/edit", sent);
        expect([drawn.status, drawn.body.code], `${target} from ${who}`).toEqual([200, undefined]);
      }
      const byAgent = await at.call(`${target} draft by an agent's pass`, "POST", "/v1/agents/edit", agentPass, sent, { "lifestream-server": at.token("mcp") });
      expect([byAgent.status, byAgent.body.code], `${target}: an agent's pass`).toEqual([403, "PRINCIPAL_SCOPE"]);
    }
    expect([at.ledger.access.get(claude)?.version, at.ledger.access.requests(claude, at.now()).find((each) => each.id === open.id)?.state], "a preview grants nothing").toEqual([1, "open"]);
    files.name(drafted.id, "c2lnbi1pbi0wMDAwMDAwNA");
    const both = await as.phone("waiting: a sign-in and the open requests", "GET", "/v1/agents/waiting");
    const bothList = both.body as unknown as WaitingList;
    expect(bothList.requests.map((each) => each.name)).toEqual(["Drafted"]);
    expect(bothList.asks.map((each) => each.id), "each open request, oldest first, as its own read draws it; the replaced and the dropped gone")
      .toEqual([chatAsk.id, open.id, calendar.id, money.id]);
    expect(bothList.asks.find((each) => each.id === open.id)).toEqual(openAsk);
    files.write("waiting", "GET /v1/agents/waiting", null, pinned(both));

    const askDraftSent = { target: { request: open.id }, access: openAsk.proposed, expect: 1, edit: { account: CHAT, window: { past_ms: 7 * DAY } } };
    files.write("edit-ask", "POST /v1/agents/edit", askDraftSent, await as.phone("an ask's draft", "POST", "/v1/agents/edit", askDraftSent));

    const answering = async (step: string, file: string | null, sent: JsonObject, by: "phone" | "mac" = "phone") => {
      const answered = await as[by](step, "POST", "/v1/agents/answer", sent);
      if (file !== null) files.write(file, "POST /v1/agents/answer", sent, answered);
      return answered;
    };
    const noWithAccess = await answering("No, with an access", null, { id: open.id, answer: "no", access: openAsk.proposed as unknown as JsonObject });
    expect([noWithAccess.status, noWithAccess.body.code]).toEqual([422, "BAD_REQUEST"]);
    const onceNoVersion = await answering("For 1 hour, with no version", null, { id: open.id, answer: "once" });
    expect([onceNoVersion.status, onceNoVersion.body.code]).toEqual([422, "BAD_REQUEST"]);
    const once = await answering("For 1 hour", "answer-once", { id: open.id, answer: "once", expect: 1 });
    expect(once.body).toEqual({ state: "allowed", version: 2, outcome: wordsAt("Allowed until", NOW + HOUR), reader: null, connected: null } as unknown as AnswerReply);
    expect((at.ledger.access.get(claude)!.lines as unknown as Access).allow.at(-1)).toEqual({ reach: { account: CHAT, but: [] }, window: null, until_ms: NOW + HOUR });
    expect(at.ledger.access.changes(claude, { limit: 1 })[0]).toMatchObject({ what: "allowed", by: "person", request: open.id });
    const onceAgain = await answering("For 1 hour again, after a lost reply", "answer-ended", { id: open.id, answer: "once", expect: 1 }, "mac");
    expect([onceAgain.status, onceAgain.body, at.ledger.access.get(claude)?.version], "an ended request answers its real state and writes nothing").toEqual([200, once.body, 2]);
    files.write("ask-allowed", "GET /v1/agents/asks/<id>", null, await as.reader("the allowed ask", "GET", `/v1/agents/asks/${open.id}`));
    const always = await answering("Allow on Chat's card, on the Mac", "answer-always", { id: chatAsk.id, answer: "always", expect: 2 }, "mac");
    expect(always.body).toEqual({ state: "allowed", version: 3, outcome: wordsAt("Allowed on Mac,", expect.any(Number)), reader: null, connected: null });
    expect(at.ledger.access.get(instinct)).toMatchObject({ version: 3, lines: health });
    const declinedAsk = ask(at, instinct, { read: { category: "money" }, window: null }, HOUR, "Your spending, to plan the month.");
    const no = await answering("No", "answer-no", { id: declinedAsk.id, answer: "no" });
    expect(no.body).toEqual({ state: "declined", version: 3, outcome: wordsAt("Not allowed on iPhone,", expect.any(Number)), reader: null, connected: null });
    expect(at.ledger.access.get(instinct)?.version, "a No leaves the access").toBe(3);
    expect(requestIn(at.ledger, { reader: instinct, want: { read: { category: "money" }, window: null }, reason: "Again.", for_ms: null, now_ms: at.now() }), "a No holds the same want a day")
      .toEqual({ held: { declined_ms: NOW, until_ms: NOW + DAY } });
    files.write("ask-declined", "GET /v1/agents/asks/<id>", null, await as.reader("the declined ask", "GET", `/v1/agents/asks/${declinedAsk.id}`));
    const calendarAsk = await byId(calendar.id);
    const edited = (await as.phone("Change on Hermes's request: Calendar for the past 7 days", "POST", "/v1/agents/edit",
      { target: { request: calendar.id }, access: calendarAsk.proposed, expect: calendarAsk.version, edit: { type: "plans", window: { past_ms: 7 * DAY } } })).body as unknown as AccessDraft;
    const editedSent = { id: calendar.id, answer: "always", expect: edited.expect, access: edited.access } as unknown as JsonObject;
    const editedAnswer = await answering("Allow the edited draft", "answer-edited", editedSent);
    expect(editedAnswer.body).toMatchObject({ state: "allowed", version: calendarAsk.version + 1 });
    expect(at.ledger.access.get(hermes)?.lines, "the person's draft is saved, resolved at the answer").toEqual(resolve(edited.access, at.now()));
    const unknown = await answering("a request the home never held", "answer-unknown", { id: "rq-0000000000000000", answer: "once", expect: 0 });
    expect([unknown.status, unknown.body.code]).toEqual([404, "AGENT_REQUEST_GONE"]);
    const erased = ask(at, instinct, { read: { account: WATCH }, window: null }, HOUR, "Your sleep, to plan the week.");
    const file = new Database(join(at.root, "replies", "replies.db"));
    try {
      file.prepare("UPDATE access_requests SET want = NULL, want_key = NULL WHERE id = ?").run(erased.id);
    } finally {
      file.close();
    }
    const erasedAsk = await as.reader("an ask an erasure took", "GET", `/v1/agents/asks/${erased.id}`);
    expect(erasedAsk.body).toMatchObject({ head: "What Instinct asked for was erased.", choices: [{ answer: "no", words: "Don’t allow" }], default: "no" });
    files.write("ask-erased", "GET /v1/agents/asks/<id>", null, erasedAsk);
    const erasedAllowed = await answering("Always on a request since erased", "answer-erased", { id: erased.id, answer: "always", expect: 3 });
    expect([erasedAllowed.status, erasedAllowed.body.code, at.ledger.access.get(instinct)?.version]).toEqual([409, "AGENT_REQUEST_ERASED", 3]);
    expect((await answering("No on a request since erased", null, { id: erased.id, answer: "no" })).body, "No still ends it").toMatchObject({ state: "declined" });

    const screenOn: Access = { ...emptyAccess(), allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }] };
    const screenAsk = await as.chat("Chat would turn the Screen on for ChatGPT", "POST", `/v1/agents/${gpt}/propose`, { access: screenOn, expect: 0 });
    expect(screenAsk.body).toMatchObject({ kind: "asked", snapshot: { by: "chat", head: "Let ChatGPT also read everything?", adds: ["Everything"], screen: SCREEN_LINE, proposed: screenOn, version: 0, state: "open" } });
    files.write("propose-asked-screen", "POST /v1/agents/<id>/propose", { access: screenOn, expect: 0 }, screenAsk);

    const gemini = mintPrincipal(openHomeFolder(at.root), {
      unit: "agent", kind: "agent", scopes: ["read"], now_ms: at.now(), granted: { agent: { name: "Gemini", via: "pass", from: null, checked: false, client_id: null, resource: null } },
    }).principal.id;
    const geminiAsk = ask(at, gemini, { read: { account: WORK }, window: null }, HOUR, "The work mailbox.");
    const fromNothing = await answering("For 1 hour, for an agent with no access", "answer-no-access", { id: geminiAsk.id, answer: "once", expect: 0 });
    expect(fromNothing.body).toMatchObject({ state: "allowed", version: 1 });
    const oneHour: Access = { ...emptyAccess(), allow: [{ reach: { account: WORK, but: [] }, window: null, until_ms: at.now() + HOUR }] };
    expect(at.ledger.access.get(gemini)?.lines).toEqual(oneHour);
    const homeMail = ask(at, gemini, { read: { account: HOME_MAIL }, window: null }, HOUR, "The home mailbox.");
    at.ledger.access.change(gemini, { from: 1, what: "narrowed", lines: emptyAccess() as never, covers: [] }, { at_ms: at.now(), by: "person", device: null });
    const staleAnswer = await answering("For 1 hour, drawn before a narrowing", "answer-stale", { id: homeMail.id, answer: "once", expect: 1 });
    expect([staleAnswer.status, staleAnswer.body.code, at.ledger.access.get(gemini)?.version, at.ledger.access.request(homeMail.id, at.now())?.state]).toEqual([409, "ACCESS_CHANGED", 2, "open"]);

    files.write("refused-agent", "GET /v1/agents", null, await at.call("an agent's pass reads the list", "GET", "/v1/agents", agentPass, undefined, { "lifestream-server": at.token("mcp") }));
    expect((await at.call("the extension reads the list", "GET", "/v1/agents", at.passes.extension, undefined, DEVICE.extension)).body.code).toBe("PRINCIPAL_SCOPE");
    const large = await as.phone("a body past the bound", "POST", "/v1/agents/edit", JSON.stringify({ target: { reader: hermes }, access: emptyAccess(), expect: 0, edit: null, pad: "x".repeat(2 << 20) }));
    expect([large.status, large.body.code]).toEqual([413, "BODY_TOO_LARGE"]);
    files.write("refused-too-large", "POST /v1/agents/edit", null, large);

    const pager = await add("Pager");
    grant(at, pager, defaultAccess());
    for (let n = 0; n < 56; n++) {
      if (n === 30) at.tick(45 * 60_000);
      const sent = n % 2 === 0 ? { query: `dinner ${n}` } : { from: "2026-11-13", to: "2026-11-13" };
      const begun = at.ledger.access.begin({ reader: pager, tool: n % 2 === 0 ? "search" : "read", sent, read: sent, at_ms: at.now() });
      if (n % 4 === 0) {
        const refs = [{ source: `${WORK}:cloud`, kind: "message", key: `m-${n}` }, ...(n % 8 === 0 ? [{ source: `${CHAT}:macbook-pro-0001`, kind: "message", key: `c-${n}` }] : [])];
        at.ledger.outbound.write({ at_ms: at.now(), receiver: pager, route: "/mcp", by: null, what: "read", tool: "search", level: "names", counts: { person: 2 }, chars: 1, pictures: 0, key: null, attempt: null, refs, call: begun.id });
      }
      const came = n % 4 !== 0 ? {} : n % 8 === 0 ? { mail: 1, messages: 1 } : { mail: 1 };
      at.ledger.access.end(begun.id, { result: n === 7 ? "refused" : "answered", words: n === 7 ? "Outside your access." : null, ms: 12, withheld: n === 52 ? [{ line: "no-line", n: 3, least: false }] : [], came });
      if (n === 40) {
        const now = at.ledger.access.get(pager)!;
        at.ledger.access.change(pager, { from: now.version, what: "narrowed", lines: { ...(now.lines as unknown as Access), window: { past_ms: DAY } } as never, covers: now.covers }, { at_ms: at.now(), by: "chat", device: null });
      }
      if (n === 49) {
        const asked = ask(at, pager, { read: { category: "health" }, window: null }, HOUR, "Your sleep this week.");
        at.ledger.access.answer(asked.id, { from: at.ledger.access.get(pager)!.version, answer: "declined" }, { at_ms: at.now(), by: "person", device: null });
      }
      at.tick(60_000);
    }
    const first = await as.reader("pager's history", "GET", `/v1/agents/${pager}/history`);
    const page = first.body as unknown as HistoryPage;
    expect(page.sessions[0]).toMatchObject({ key: "s-2", calls: 26 });
    expect(page.sessions[1], "a session's whole count of reads, its older calls on the next page too, never a refused call").toMatchObject({ key: "s-1", calls: 29, reads: "29 reads" });
    expect(page.sessions[0]!.lines.some((line) => line.kind === "change" && line.words.startsWith("Chat narrowed")), "a change stays in sight in a folded session").toBe(true);
    const reads = page.sessions.flatMap((each) => each.lines).flatMap((line) => (line.kind === "fold" ? line.lines : line.kind === "call" ? [line] : []));
    expect(reads.filter((line) => line.told !== null).map((line) => line.told)).toEqual(["Was told: not allowed"]);
    expect(page.sessions[0]!.lines.filter((line) => line.kind === "fold").map((line) => [line.words, line.kind === "fold" ? line.line : null]), "a long run folds into one line the home words")
      .toEqual([["2 more reads", expect.any(String)], ["9 more reads", expect.any(String)], ["10 more reads", expect.any(String)]]);
    expect(reads.find((line) => line.words === "Searched for “dinner 48”"), "a read in the agent's words, what came back by kind")
      .toMatchObject({ line: "2 things: 1 email, 1 message", tone: "plain", opens: true, took_ms: 12 });
    expect(reads.find((line) => line.words === "Searched for “dinner 52”")).toMatchObject({ tone: "plain", opens: true });
    expect(reads.find((line) => line.words === "Read your day, 13 Nov")).toMatchObject({ line: "Nothing found" });
    expect(page.next).toMatchObject({ words: "Show earlier" });
    expect([page.figure?.today, page.chips.map((chip) => [chip.kind, chip.n]), page.kind, page.empty], "the first page: today's figure, and a chip per kind of the reads that saw it")
      .toEqual([55, [["mail", 14], ["messages", 7]], null, null]);
    files.write("history", "GET /v1/agents/<id>/history", null, first);
    const list = await as.reader("the list, a reader with calls", "GET", "/v1/agents");
    const listRows = list.body.readers as unknown as AgentRow[];
    const pagerRow = listRows.find((row) => row.id === pager)!;
    expect(pagerRow.reads, "reads only: the refused call is no read").toMatchObject({ last_ms: at.ledger.access.calls(pager, { limit: 1 })[0]!.at_ms, today: 55, total: 55, since: "55 reads since 14 Nov" });
    expect(pagerRow.reads.days.map((each) => each.n), "seven days, today last").toEqual([0, 0, 0, 0, 0, 0, 55]);
    expect(pagerRow.reads.line).toMatch(/^Read \d\d:\d\d · 55 reads today$/u);
    expect(listRows.find((row) => row.id === instinct)?.reads).toMatchObject({ last_ms: null, last: null, line: "Hasn’t read yet", today: 0, total: 0, since: null });
    files.write("list", "GET /v1/agents", null, list);
    const pagerRead = await as.reader("pager whole: its reads, and each kind's in thirty days", "GET", `/v1/agents/${pager}`);
    const kinds = Object.fromEntries((pagerRead.body as unknown as AgentRead).view.categories.map((each) => [each.type, each.reads?.n]));
    expect(kinds, "a call counted once per kind it read, whatever its records").toMatchObject({ mail: 14, messages: 7, health: 0 });
    expect((pagerRead.body as unknown as AgentRead).reads).toEqual(pagerRow.reads);
    const recent = (pagerRead.body as unknown as AgentRead).recent;
    expect([recent.lines.map((line) => line.words), recent.all], "the last two reads, picked by the home, and its See all")
      .toEqual([["Read your day, 13 Nov", "Searched for “dinner 54”"], "See all 55 reads"]);
    expect((pagerRead.body as unknown as AgentRead).figure, "today's figure: its reads, the days and the sentence").toMatchObject({ today: 55, words: "reads today" });
    files.write("reader-reads", "GET /v1/agents/<id>", null, pagerRead);
    const earlier = await as.reader("pager's history, earlier", "GET", `/v1/agents/${pager}/history?before=${encodeURIComponent(page.next!.before)}`);
    const second = earlier.body as unknown as HistoryPage;
    expect(second.sessions.at(-1)).toMatchObject({ key: expect.stringMatching(/^c-/u) });
    expect(second.sessions.find((each) => each.key === "s-1")?.calls).toBe(29);
    expect(second.next).toBeNull();
    expect([second.figure, second.chips], "the figure and the chips come with the first page alone").toEqual([null, []]);
    const opened = page.sessions.find((each) => each.key === "s-1")!.lines.at(-1)!;
    const continued = second.sessions.find((each) => each.key === "s-1")!.lines[0]!;
    expect(opened, "the session's first page draws its head and opens its fold").toMatchObject({ kind: "fold", continues: false });
    expect(continued, "a later page continues the session's one fold, its tally the whole run's").toMatchObject({ kind: "fold", continues: true });
    if (opened.kind !== "fold" || continued.kind !== "fold") throw new Error("both are folds");
    expect(continued.n).toBe(opened.n + continued.lines.length);
    expect(second.sessions.find((each) => each.key === "s-1")!.lines.filter((line) => line.kind === "call"), "no second head on a later page").toEqual([]);
    files.write("history-earlier", "GET /v1/agents/<id>/history?before=", null, earlier);
    files.write("history-no-calls", "GET /v1/agents/<id>/history", null, await as.reader("a reader with no calls", "GET", `/v1/agents/${instinct}/history`));
    files.write("history-bad-cursor", "GET /v1/agents/<id>/history?before=", null, await as.reader("a cursor no page made", "GET", `/v1/agents/${instinct}/history?before=bm90LWEtY3Vyc29y`));
    const chatHistory = (await as.reader("Chat's history", "GET", "/v1/agents/ask/history")).body as unknown as HistoryPage;
    expect(chatHistory.sessions.map((each) => each.lines[0]!.kind === "change" ? each.lines[0]!.words : null)).toEqual(["Lifestream allowed Chat"]);

    const pagerNow = at.ledger.access.get(pager)!;
    const onlySent = { target: { reader: pager }, access: pagerNow.lines, expect: pagerNow.version, edit: { mode: "only" } };
    const onlyThese = await as.phone("Only these: the same rows, new kinds not read, saved at once", "POST", "/v1/agents/edit", onlySent);
    expect(onlyThese.body).toMatchObject({ view: { mode: "only" }, narrowed: { undo: { access: pagerNow.lines, expect: pagerNow.version + 1 } } });
    expect(at.ledger.access.get(pager)?.version, "a narrowing, saved at once").toBe(pagerNow.version + 1);
    files.write("edit-mode-only", "POST /v1/agents/edit", onlySent, onlyThese);
    const butSent = { target: { reader: pager }, access: (onlyThese.body as unknown as AccessDraft).access, expect: pagerNow.version + 1, edit: { mode: "but" } };
    const everythingBut = await as.phone("Everything but: new kinds read, waits for Allow", "POST", "/v1/agents/edit", butSent);
    expect(everythingBut.body).toMatchObject({ view: { mode: "but", widens: true }, narrowed: null });
    expect(at.ledger.access.get(pager)?.version, "a widening waits").toBe(pagerNow.version + 1);
    files.write("edit-mode-but", "POST /v1/agents/edit", butSent, everythingBut);
    const withDraftSent = { target: { reader: pager }, access: (everythingBut.body as unknown as AccessDraft).access, expect: pagerNow.version + 1, edit: { type: "mail", on: false } };
    const withDraft = await as.phone("a narrowing while a widening waits: saved at once, the widening still waits on top of it", "POST", "/v1/agents/edit", withDraftSent);
    const split = withDraft.body as unknown as AccessDraft;
    expect(split, "Mail off saved with its Undo, the widening a draft over the new saved access").toMatchObject({
      expect: pagerNow.version + 2, view: { mode: "but", widens: true }, narrowed: { words: [{ text: "Saved. Pager no longer sees your " }, { text: "email", bold: true }, { text: "." }], undo: { access: (onlyThese.body as unknown as AccessDraft).access, expect: pagerNow.version + 2 } },
    });
    expect(split.saved, "the access saved now, for Cancel to go back to").toMatchObject({ view: { mode: "only", widens: false } });
    expect(split.saved!.access.allow.some((allow) => "type" in allow.reach && allow.reach.type === "mail"), "Mail is off in what is saved").toBe(false);
    expect(at.ledger.access.changes(pager, { limit: 1 })[0], "the narrowing, a change of its own").toMatchObject({ what: "narrowed", by: "person", version: pagerNow.version + 2 });
    files.write("edit-narrowed-widening-waits", "POST /v1/agents/edit", withDraftSent, withDraft);
    const sentAgainEdit = await as.phone("the same narrowing sent again, after a lost reply", "POST", "/v1/agents/edit", withDraftSent);
    expect([sentAgainEdit.status, sentAgainEdit.body], "answered as the first was").toEqual([200, withDraft.body]);
    expect(at.ledger.access.get(pager)?.version, "written once").toBe(pagerNow.version + 2);
    const otherAgain = await as.phone("another narrowing from the old version", "POST", "/v1/agents/edit", { ...withDraftSent, edit: { type: "messages", on: false } });
    expect([otherAgain.status, otherAgain.body.code], "a different edit from the old version is a change since").toEqual([409, "ACCESS_CHANGED"]);
    const allowed = await as.phone("Allow saves the widening alone", "POST", `/v1/agents/${pager}/access`, { access: split.access, expect: split.expect });
    expect(allowed.body).toMatchObject({ expect: pagerNow.version + 3, view: { mode: "but", widens: false } });
    expect(at.ledger.access.changes(pager, { limit: 2 }).map((each) => each.what), "History names each: the narrowing, then the widening").toEqual(["widened", "narrowed"]);

    const fromBrowserGone = await as.reader("a browser disconnects", "POST", `/v1/agents/${pager}/disconnect`, {});
    expect([fromBrowserGone.status, fromBrowserGone.body.code]).toEqual([403, "PERSON_ONLY"]);
    files.write("disconnect-person-only", "POST /v1/agents/<id>/disconnect", {}, fromBrowserGone);
    const stillHere = await as.phone("Remove from the list, still connected", "POST", `/v1/agents/${pager}/unlist`, {});
    expect([stillHere.status, stillHere.body.code, stillHere.body.message]).toEqual([409, "AGENT_CONNECTED", "Disconnect Pager first."]);
    files.write("unlist-connected", "POST /v1/agents/<id>/unlist", {}, stillHere);
    const before = (await as.phone("Pager before Disconnect", "GET", `/v1/agents/${pager}`)).body as unknown as AgentRead;
    expect(before).toMatchObject({ state: "connected", disconnected: null, unlist: null, disconnect: {
      head: "Disconnect Pager?", line: "Pager stops reading at once. Nothing in Lifestream is deleted.", confirm: "Disconnect Pager",
      stops: [{ name: "Its reads", line: "From now on Pager can’t see your Lifestream" }, { name: "Its key" }],
      stays: [{ name: "Its history here", line: "55 reads, to look back on" }, { name: "What Pager already read", line: "That stays with Pager. Ask its maker to delete it." }],
    } });
    const disconnected = await as.phone("Disconnect Pager", "POST", `/v1/agents/${pager}/disconnect`, {});
    expect(disconnected.body).toMatchObject({ state: "disconnected", disconnected: "Disconnected 14 Nov", disconnect: null, unlist: { ask: "Remove Pager from the list?", line: "Its history stays in Lifestream." }, ask: null, reads: { total: 55 } });
    expect(at.ledger.access.get(pager), "its access is gone").toBeUndefined();
    expect(at.ledger.access.changes(pager, { limit: 1 })[0]).toMatchObject({ what: "removed", by: "person", device: expect.stringMatching(/^p-/u) });
    files.write("disconnect", "POST /v1/agents/<id>/disconnect", {}, disconnected);
    const sentAgain = await as.phone("Disconnect Pager again", "POST", `/v1/agents/${pager}/disconnect`, {});
    expect([sentAgain.status, sentAgain.body.state, sentAgain.body.disconnected], "a Disconnect sent again answers the agent, disconnected once").toEqual([200, "disconnected", "Disconnected 14 Nov"]);
    expect(at.ledger.access.changes(pager, { limit: 2 }).filter((each) => each.what === "removed")).toHaveLength(1);
    const chatGone = await as.phone("Disconnect Chat", "POST", "/v1/agents/ask/disconnect", {});
    expect([chatGone.status, chatGone.body.message]).toEqual([422, "Chat is Lifestream’s own: it is not disconnected."]);
    const chatOff = await as.phone("Remove Chat from the list", "POST", "/v1/agents/ask/unlist", {});
    expect([chatOff.status, chatOff.body.message]).toEqual([422, "Chat is Lifestream’s own: it stays on the list."]);
    const editGone = await as.phone("an edit of a disconnected agent", "POST", "/v1/agents/edit", { target: { reader: pager }, access: emptyAccess(), expect: 0, edit: null });
    expect([editGone.status, editGone.body.message]).toEqual([404, "This agent was disconnected."]);
    files.write("edit-disconnected", "POST /v1/agents/edit", { target: { reader: pager }, access: emptyAccess(), expect: 0, edit: null }, editGone);
    const withGone = await as.phone("the list with a disconnected agent", "GET", "/v1/agents");
    expect((withGone.body.readers as unknown as AgentRow[]).at(-1)).toMatchObject({ id: pager, state: "disconnected", summary: "Disconnected 14 Nov · its history stays", has_ask: false });
    files.write("list-disconnected", "GET /v1/agents", null, withGone);
    const keptHistory = (await as.phone("a disconnected agent's history", "GET", `/v1/agents/${pager}/history`)).body as unknown as HistoryPage;
    expect(keptHistory.sessions[0]!.lines[0]).toMatchObject({ kind: "change", words: "You disconnected Pager", line: "You, on this iPhone" });
    const unlisted = await as.phone("Remove from the list", "POST", `/v1/agents/${pager}/unlist`, {});
    expect((unlisted.body.readers as unknown as AgentRow[]).map((row) => row.id)).not.toContain(pager);
    files.write("unlist", "POST /v1/agents/<id>/unlist", {}, unlisted);
    expect((await as.phone("its history, off the list", "GET", `/v1/agents/${pager}/history`)).body, "off the list, its history stays").toMatchObject({ sessions: keptHistory.sessions });


    const NOTE_SOURCE = `${NOTES}:poll`;
    await ship(at.root, { source: NOTE_SOURCE, fetched_ms: at.now() - 60_000, rows: [], facts: { generate: { count: 6, start_ms: at.now() - 6 * HOUR, step_ms: HOUR, prefix: "thing" } } }, { machineDir: at.machineDir });
    await until("six notes in the home", () => readHome(at.root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND version <> 'gone'").pluck().get(NOTE_SOURCE)) === 6);
    const note = (n: number): CallItem => {
      const parts = { source: NOTE_SOURCE, kind: "note", key: `thing-${n}` };
      return { kind: "notes", ref: makeRef("record", parts), source: parts.source, rkind: parts.kind, key: parts.key, day: null };
    };
    const cited = new URLSearchParams([0, 1, 2, 3].map((n): [string, string] => ["ref", note(n).ref]));
    await until("each note's line indexed on its day, where a citation focuses", async () => {
      const described = await as.phone("the notes as citations", "GET", `/v1/describe?${cited}`);
      return described.status === 200 && (described.body.described as unknown as Citation[]).every((each) => "opens" in each && "focus" in each.opens);
    });
    const orbit = await add("Orbit");
    const shoes = { query: "running shoes" };
    const searched = called(at, orbit, { read: shoes, items: [note(0)], counts: { person: 2, phone: 3 } });
    for (const [n, cursor] of ["c1", "c2", "c3"].entries()) {
      at.tick(60_000);
      called(at, orbit, { read: { ...shoes, cursor, limit: 20 }, sent: { cursor }, items: [note(n + 1)], counts: { phone: 5 } });
    }
    const pages = await as.phone("Orbit's search and its three later pages", "GET", `/v1/agents/${orbit}/history`);
    const pagesLines = (pages.body as unknown as HistoryPage).sessions.flatMap((each) => each.lines).filter((line) => line.kind !== "change");
    expect(pagesLines, "a search and its later pages are one read").toEqual([expect.objectContaining({ kind: "call", id: searched, words: "Searched for “running shoes”", more: 3 })]);
    expect((pages.body as unknown as HistoryPage).sessions.map((each) => each.reads), "the session counts the one read, its grant a group of its own").toEqual(["1 read", null]);
    files.write("history-pages", "GET /v1/agents/<id>/history", null, pages);
    const joined = await as.phone("the joined read's page", "GET", `/v1/agents/${orbit}/reads/${searched}`);
    const joinedPage = joined.body as unknown as ReadPage;
    expect(joinedPage, "counted across all four pages").toMatchObject({ id: searched, reader: orbit, name: "Orbit", title: "Searched for “running shoes”", figure: { n: 4 }, show: { n: 4 } });
    expect(joinedPage.kept?.rows.map((row) => [row.type, row.value]), "kept from it, by type, across the pages").toEqual([["names", "Shown as “a person”"], ["phone", "18"]]);
    files.write("read-joined", "GET /v1/agents/<id>/reads/<call>", null, joined);
    const thingsOf = await as.phone("the joined read's things", "GET", `/v1/agents/${orbit}/reads/${searched}/things`);
    const shown = thingsOf.body as unknown as ThingsPage;
    expect([shown.gone, shown.next, shown.groups.map((group) => [group.kind, group.things.length])], "every page's things, opened unhidden").toEqual([null, null, [["notes", 4]]]);
    expect(shown.groups[0]!.things.map((thing) => thing.ref)).toEqual([0, 1, 2, 3].map((n) => note(n).ref));
    expect(shown.groups[0]!.things.map((thing) => thing.opens), "each thing opens its day at itself, as a citation does")
      .toEqual(shown.groups[0]!.things.map((thing, n) => ({ page: "days", day: thing.day, focus: `rec:${NOTE_SOURCE} note thing-${n}` })));
    files.write("things", "GET /v1/agents/<id>/reads/<call>/things", null, thingsOf);
    const byChat = await as.chat("Chat reads the person's things", "GET", `/v1/agents/${orbit}/reads/${searched}/things`);
    expect([byChat.status, byChat.body.code], "the person's own records: the person's pass alone").toEqual([403, "PERSON_ONLY"]);
    files.write("things-chat", "GET /v1/agents/<id>/reads/<call>/things", null, byChat);
    expect((await as.chat("Chat reads the read's page", "GET", `/v1/agents/${orbit}/reads/${searched}`)).status, "the read's page, as the agent's page").toBe(200);

    at.tick(2 * HOUR);
    const plain = called(at, orbit, { read: { query: "dinner" }, items: [note(4), note(5), note(0)], counts: { person: 1, email: 2 } });
    const orbitNow = at.ledger.access.get(orbit)!;
    const narrowedOrbit = await as.phone("Orbit narrowed to the past 24 hours", "POST", `/v1/agents/${orbit}/access`, { access: { ...(orbitNow.lines as unknown as Access), window: { past_ms: DAY } }, expect: orbitNow.version });
    expect(narrowedOrbit.status).toBe(200);
    const read = await as.phone("a read's page", "GET", `/v1/agents/${orbit}/reads/${plain}`);
    const readPage = read.body as unknown as ReadPage;
    expect(readPage).toMatchObject({ title: "Searched for “dinner”", figure: { n: 3 }, refused: null, show: { n: 3 } });
    expect(plainOf(readPage.why!), "why: the access in force at the read, not the narrowing after it").toMatch(/^At \d\d:\d\d Orbit could see everything but Health and Money/u);
    expect(plainOf(readPage.why!)).not.toContain("24 hours");
    files.write("read", "GET /v1/agents/<id>/reads/<call>", null, read);
    at.ledger.forget([], [{ source: NOTE_SOURCE, kind: "note", key: "thing-5" }]);
    const goneOf = await as.phone("a read's things, one since erased", "GET", `/v1/agents/${orbit}/reads/${plain}/things`);
    const goneThings = goneOf.body as unknown as ThingsPage;
    expect([goneThings.groups.flatMap((group) => group.things).length, goneThings.gone], "the rest stand, and the page says what went").toEqual([2, "1 of them is no longer in Lifestream."]);
    files.write("things-gone", "GET /v1/agents/<id>/reads/<call>/things", null, goneOf);
    const underHermes = await as.phone("Orbit's read under Hermes", "GET", `/v1/agents/${hermes}/reads/${plain}`);
    expect([underHermes.status, underHermes.body.code, underHermes.body.message], "a read of another agent never opens").toEqual([404, "READ_UNKNOWN", "This read isn’t in this agent’s history."]);
    files.write("read-unknown", "GET /v1/agents/<id>/reads/<call>", null, underHermes);
    expect((await as.phone("its things under Hermes", "GET", `/v1/agents/${hermes}/reads/${plain}/things`)).body.code).toBe("READ_UNKNOWN");
    at.tick(60_000);
    const stopped = called(at, orbit, { read: { query: "salary", families: ["money"] }, refused: { code: "OUTSIDE_ACCESS", words: "Outside your access." } });
    const refusedRead = await as.phone("a refused read's page", "GET", `/v1/agents/${orbit}/reads/${stopped}`);
    expect(refusedRead.body).toMatchObject({ refused: "Stopped: Orbit can’t see Money", figure: null, kept: null, show: null });
    files.write("read-refused", "GET /v1/agents/<id>/reads/<call>", null, refusedRead);
    const refusedHistory = await as.phone("a history with a refused read", "GET", `/v1/agents/${orbit}/history`);
    const refusedLine = (refusedHistory.body as unknown as HistoryPage).sessions[0]!.lines.find((line): line is HistoryRead => line.kind === "call" && line.id === stopped);
    expect(refusedLine, "a refusal in the person's words, opening to its page").toMatchObject({ tone: "refused", line: "Stopped: Orbit can’t see Money", opens: true });
    files.write("history-refused", "GET /v1/agents/<id>/history", null, refusedHistory);

    const sorter = await add("Sorter");
    const seen = new Set<string>();
    for (let n = 0; n < 60; n++) {
      const id = called(at, sorter, { read: { query: `sort ${n}` }, came: n % 3 === 0 ? { messages: 1, notes: 1 } : { notes: 1 } });
      if (n % 3 === 0) seen.add(id);
      at.tick(1_000);
    }
    const filtered: string[] = [];
    let kindPage = await as.phone("Sorter's history of messages", "GET", `/v1/agents/${sorter}/history?kind=messages`);
    expect([(kindPage.body as unknown as HistoryPage).kind, (kindPage.body as unknown as HistoryPage).chips.map((chip) => [chip.kind, chip.n])], "the filter in force, and a chip per kind").toEqual(["messages", [["notes", 60], ["messages", 20]]]);
    files.write("history-kind", "GET /v1/agents/<id>/history?kind=", null, kindPage);
    for (;;) {
      const body = kindPage.body as unknown as HistoryPage;
      filtered.push(...body.sessions.flatMap((each) => each.lines).flatMap((line) => (line.kind === "fold" ? line.lines : line.kind === "call" ? [line] : [])).map((line) => line.id));
      if (body.next === null) break;
      kindPage = await as.phone("Sorter's history of messages, earlier", "GET", `/v1/agents/${sorter}/history?kind=messages&before=${encodeURIComponent(body.next.before)}`);
    }
    expect([filtered.length, new Set(filtered).size, filtered.every((id) => seen.has(id))], "every read that saw messages, once each, and no other").toEqual([20, 20, true]);

    const hourly = await add("Hourly");
    for (let n = 0; n < 4; n++) {
      called(at, hourly, { tool: "read", read: { from: "2026-11-14", to: "2026-11-14" }, came: { messages: 8, plans: 9 } });
      at.tick(HOUR);
    }
    const repeats = await as.phone("four hourly reads of the day", "GET", `/v1/agents/${hourly}/history`);
    expect((repeats.body as unknown as HistoryPage).sessions.flatMap((each) => each.lines).filter((line) => line.kind !== "change"), "one row: every hour").toEqual([expect.objectContaining({ kind: "fold", n: 4, icon: "sync", words: "Read your day, every hour" })]);
    files.write("history-repeats", "GET /v1/agents/<id>/history", null, repeats);

    const asker = await add("Asker");
    called(at, asker, { read: { query: "flights" }, came: { mail: 2 } });
    const waitingAsk = ask(at, asker, { read: { category: "health" }, window: null }, HOUR, "Your sleep, to plan the trip.");
    const waitingHistory = await as.phone("a history with an ask waiting", "GET", `/v1/agents/${asker}/history`);
    expect((waitingHistory.body as unknown as HistoryPage).sessions.flatMap((each) => each.lines).find((line) => line.kind === "change"), "the waiting ask opens the ask")
      .toMatchObject({ tone: "waiting", ask: waitingAsk.id, icon: "needs-you" });
    files.write("history-waiting", "GET /v1/agents/<id>/history", null, waitingHistory);

    files.settle();
  });

  it("save the whole draft when an edit ends a held widening and narrows what is saved, so the ledger holds what the screen shows", async () => {
    const steps: Record<string, unknown> = {};
    report.wholeDraft = steps;
    const at = await running(steps);
    const { as } = at;
    const drafter = (await askHome(at.sock, "agents", ["add", "Drafter"]) as Added).agent.id;
    const week = { past_ms: 7 * DAY };
    grant(at, drafter, { ...emptyAccess(), allow: [{ reach: { type: "health", but: [] }, window: week, until_ms: null }, { reach: { type: "mail", but: [] }, window: week, until_ms: null }] });
    const mixedNow = at.ledger.access.get(drafter)!;
    const mixedSent = { target: { reader: drafter }, access: { ...emptyAccess(), allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }] }, expect: mixedNow.version, edit: { type: "mail", window: { past_ms: DAY } } };
    const whole = await as.phone("one edit that ends a draft's last widening and narrows what is saved: the whole draft saved", "POST", "/v1/agents/edit", mixedSent);
    const wholeDraft = whole.body as unknown as AccessDraft;
    expect(wholeDraft, "Health off too, never left readable behind a screen without it").toMatchObject({ expect: mixedNow.version + 1, view: { widens: false }, narrowed: { undo: { access: mixedNow.lines, expect: mixedNow.version + 1 } } });
    expect(at.ledger.access.get(drafter)?.lines, "the ledger holds what the screen shows").toEqual(resolve(wholeDraft.access, at.now()));
    expect(wholeDraft.saved?.access).toEqual(at.ledger.access.get(drafter)?.lines);
    const wholeAgain = await as.phone("the whole draft sent again, after a lost reply", "POST", "/v1/agents/edit", mixedSent);
    expect([wholeAgain.status, wholeAgain.body], "answered as the first was").toEqual([200, whole.body]);
  });

  it("draw an agent's ask the same on every read, and Change reads its grant live, not yet started", async () => {
    const steps: Record<string, unknown> = {};
    report.asks = steps;
    const at = await running(steps);
    const { as } = at;
    const hermes = (await askHome(at.sock, "agents", ["add", "Hermes"]) as Added).agent.id;
    grant(at, hermes, defaultAccess());
    const mail = ask(at, hermes, { read: { account: WORK }, window: null }, HOUR, "The work mailbox.");
    const first = (await as.phone("an ask with no for", "GET", `/v1/agents/asks/${mail.id}`)).body as unknown as AgentAsk;
    expect(first).toMatchObject({ head: "Hermes asks to see your Gmail (person-a@example.com) for 1 hour", default: "once", choices: [{ answer: "once", words: "Allow for 1 hour" }, { answer: "always", words: "Always allow" }, { answer: "no", words: "Don’t allow" }] });
    expect(first.proposed.allow.at(-1)).toEqual({ reach: { account: WORK, but: [] }, window: null, lasts_ms: HOUR });
    at.tick(2 * HOUR);
    const again = (await as.phone("the same ask, two hours on", "GET", `/v1/agents/asks/${mail.id}`)).body as unknown as AgentAsk;
    expect(again, "an unchanged ask draws one proposal").toEqual(first);
    const change = (await as.phone("Change on the ask, two hours on", "POST", "/v1/agents/edit", { target: { request: mail.id }, access: first.proposed, expect: first.version, edit: null })).body as unknown as AccessDraft;
    expect(change.access, "the draft keeps the proposal's own form").toEqual(first.proposed);
    const work = change.view.categories.find((each) => each.type === "mail")!.accounts.find((each) => each.account === WORK)!;
    expect(work.state, "Change reads the grant live: its hour starts at the answer").toBe("on");
    expect(work.limit?.words, "on through the default for good and the request for its hour").toBe("All time for most, all time for 1 hour for some");
  });

  it("answer the waiting list as a page: only the asks still open by the home's clock, each with editable, 304 on its ETag and another once one lapses", async () => {
    const steps: Record<string, unknown> = {};
    report.waitingPage = steps;
    const at = await running(steps);
    const { as } = at;
    const hermes = (await askHome(at.sock, "agents", ["add", "Hermes"]) as Added).agent.id;
    const probe = (await askHome(at.sock, "agents", ["add", "Probe"]) as Added).agent.id;
    grant(at, hermes, defaultAccess());
    grant(at, probe, defaultAccess());
    const lapsing = ask(at, hermes, { read: { account: WORK }, window: null }, HOUR, "The work mailbox.");
    at.tick(LAPSE_MS - HOUR);
    const open = ask(at, probe, { read: { account: HOME_MAIL }, window: null }, null, "The home mailbox.");
    const read = (headers: Record<string, string> = {}) => fetch(`${at.url}/v1/agents/waiting`, { headers: { authorization: `Bearer ${at.passes.phone}`, ...DEVICE.phone, ...headers } });
    const both = await as.phone("the waiting page, both asks open", "GET", "/v1/agents/waiting");
    expect(() => PAGES.agentsWaiting.shape.parse(both.body), "the page's shape").not.toThrow();
    const bothList = both.body as unknown as WaitingList;
    expect(bothList.asks.map((each) => [each.id, each.editable])).toEqual([[lapsing.id, true], [open.id, true]]);
    const etag = (await read()).headers.get("etag")!;
    expect((await read({ "if-none-match": etag })).status, "the same list: 304").toBe(304);

    at.tick(HOUR);
    const signIn = (await at.call("a sign-in", "POST", "/v1/agents/request", at.token("mcp"), { name: "Drafted", checked: false, host: null })).body as { id: string };
    const left = await as.phone("the waiting page, one ask lapsed by the home's clock", "GET", "/v1/agents/waiting");
    const leftList = left.body as unknown as WaitingList;
    expect(leftList.asks.map((each) => each.id), "the lapsed ask is left out by the home").toEqual([open.id]);
    expect(leftList.requests.map((each) => each.id)).toEqual([signIn.id]);
    expect((await read({ "if-none-match": etag })).status, "a lapsed ask moves the ETag").toBe(200);
    const steady = JSON.parse(JSON.stringify(pinned(left).body).replaceAll(open.id, "rq-0000000000000001").replaceAll(probe, "p-00000001").replaceAll(signIn.id, "c2lnbi1pbi0wMDAwMDAwMQ")) as JsonObject;
    const fixture = clientFixture("pages/agentsWaiting.full", steady);
    expect(fixture.held, "homelink/Tests/Fixtures/pages/agentsWaiting.full.json is this read: LIFESTREAM_FIXTURES=write writes it").toBe(fixture.written);
  });

  it("keep each grant's own end through Change on an ask: the person's instant and the request's span", async () => {
    const steps: Record<string, unknown> = {};
    report.ownGrants = steps;
    const at = await running(steps);
    const { as } = at;
    const had: Access = { ...emptyAccess(), allow: [{ reach: { account: HOME_MAIL, but: [] }, window: null, until_ms: NOW + 3 * HOUR / 2 }] };
    const hermes = (await askHome(at.sock, "agents", ["add", "Hermes"]) as Added).agent.id;
    grant(at, hermes, had);
    const request = ask(at, hermes, { read: { account: WORK }, window: null }, HOUR, "The work mailbox.");
    const drawn = (await as.phone("an ask for an hour beside a grant the person has", "GET", `/v1/agents/asks/${request.id}`)).body as unknown as AgentAsk;
    expect(drawn.proposed.allow, "the request's grant lasts its hour from the write; the person's keeps its instant").toEqual([...had.allow, { reach: { account: WORK, but: [] }, window: null, lasts_ms: HOUR }]);
    at.tick(HOUR / 2);
    const sent = { target: { request: request.id }, access: drawn.proposed, expect: drawn.version, edit: { type: "mail", window: { past_ms: DAY } } };
    const change = (await as.phone("Change on the ask: Mail limited to the past 24 hours", "POST", "/v1/agents/edit", sent)).body as unknown as AccessDraft;
    expect(change.access.allow, "the person's edit, each end as it was").toEqual([
      { reach: { account: HOME_MAIL, but: [] }, window: { past_ms: DAY }, until_ms: NOW + 3 * HOUR / 2 },
      { reach: { account: WORK, but: [] }, window: { past_ms: DAY }, lasts_ms: HOUR },
    ]);
  });
});

function refusedIn(work: () => unknown): Answer {
  try {
    work();
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, body: { code: error.code, message: error.words } };
    throw error;
  }
  throw new Error("the write was not refused");
}
