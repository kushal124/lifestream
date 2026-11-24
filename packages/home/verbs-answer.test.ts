import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CREDENTIAL, StationFailed, type Check, type Client, type Connector } from "@lifestreamprotocol/connect";
import { DOOR_AWAY, NOT_NOW, Refusal } from "./refusal.js";
import { fakeDeclarations } from "./test/fakes.js";
import { connectors } from "./verbs/connectors.js";
import type { VerbContext } from "./verbs/context.js";
import { declaredCheck, routeLines } from "./verbs/signin.js";
import type { RefreshAnswer } from "./wire.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

function context(over: Partial<VerbContext> = {}): { ctx: VerbContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    folder: openHomeFolder("/nonexistent/home"), by: "terminal", out: (line: string) => lines.push(line), now: () => Date.UTC(2026, 10, 15, 9),
    registry: async () => ({ connectors: fakeDeclarations(), families: [] }),
    db: { commit: () => { throw new Error("ran in the home's own lanes"); }, view: () => { throw new Error("ran in the home's own lanes"); } },
    ...over,
  } as unknown as VerbContext;
  return { ctx, lines };
}

const stations = (present: readonly string[] | Error) => () => ({
  present: async () => {
    if (present instanceof Error) throw present;
    return present;
  },
}) as unknown as ReturnType<NonNullable<VerbContext["stations"]>>;

describe("connectors check", () => {
  it("names the browsers it asks and where their finding shows; none while none runs the extension or the door does not answer", async () => {
    let surveyed = 0;
    const survey = async () => {
      surveyed++;
      return [];
    };
    const asked = context({ survey, stations: stations(["chrome-5550aa01", "chrome-5550aa02"]) });
    expect(await connectors(asked.ctx, ["check"])).toEqual({ checking: ["chrome-5550aa01", "chrome-5550aa02"] });
    expect([asked.lines, surveyed]).toEqual([["asking 2 browsers (chrome-5550aa01, chrome-5550aa02) which sites each is signed in to; lifestream connectors shows what each found once it answers"], 1]);
    const none = context({ survey, stations: stations([]) });
    expect([await connectors(none.ctx, ["check"]), none.lines, surveyed]).toEqual([{ checking: [] }, ["no browser runs the Lifestream extension now, so none is asked: each is asked as it connects, at the home's start and once a day"], 1]);
    const away = context({ survey, stations: stations(new StationFailed("NO_DOOR", "the door did not answer")) });
    expect([await connectors(away.ctx, ["check"]), away.lines, surveyed]).toEqual([{ checking: [] }, ["the door isn't answering, so no browser is asked now: the home asks each when the door first sees it, at its start and once a day"], 1]);
  });
});

describe("connectors refresh of a connector a Mac reads", () => {
  const pressed = (answer: RefreshAnswer | Refusal, by = "terminal") => {
    const asked: string[] = [];
    const { ctx, lines } = context({
      by,
      refreshAll: async (connector) => {
        asked.push(connector);
        if (answer instanceof Refusal) throw answer;
        return answer;
      },
    });
    return { run: () => connectors(ctx, ["refresh", "apple-calls"]), asked, lines };
  };

  it("is the stream's own Refresh at the terminal: the door's route, which asks the Mac, its answer in words", async () => {
    const asked = pressed({ state: "asked" });
    expect([await asked.run(), asked.asked, asked.lines]).toEqual([{ state: "asked" }, ["apple-calls"], ["apple-calls: your Mac is asked to read it now; lifestream connectors show apple-calls says what lands"]]);
    const blocked = pressed({ state: "blocked", blocked: { reason: "paused", words: "Paused", until_ms: null } });
    expect([await blocked.run(), blocked.lines]).toEqual([{ state: "blocked", blocked: { reason: "paused", words: "Paused", until_ms: null } }, ["apple-calls: Paused"]]);
    const none = pressed(new Refusal(409, "NOT_OFFERED", "nothing of apple-calls refreshes from here"));
    expect([await none.run(), none.lines]).toEqual([{ state: "none" }, ["apple-calls: no Mac reads it yet: set it up in the Lifestream app on your Mac, Calls › Set up"]]);
  });

  it("runs the home's own lanes, never the door again, pressed by the door's relay; and here, the Macs unasked, while the door does not answer", async () => {
    const relayed = pressed({ state: "asked" }, "you");
    await expect(relayed.run()).rejects.toThrow("ran in the home's own lanes");
    expect(relayed.asked).toEqual([]);
    const away = pressed(new Refusal(503, NOT_NOW, DOOR_AWAY));
    await expect(away.run()).rejects.toThrow("ran in the home's own lanes");
    expect(away.asked).toEqual(["apple-calls"]);
  });
});

describe("a declared check", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((done) => (server === undefined ? done() : server.close(() => done())));
    server = undefined;
  });

  const provider = async (elsewhere = "/feeds/secret-a/calendar.ics") => {
    const heard: { url: string; headers: IncomingHttpHeaders }[] = [];
    server = createServer((request, response) => {
      heard.push({ url: request.url ?? "", headers: request.headers });
      if (request.url === "/moved") response.writeHead(302, { location: elsewhere }).end();
      else if (request.url?.includes("revoked") === true) response.writeHead(401).end();
      else response.writeHead(200, { "content-type": "text/calendar" }).end("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n");
    });
    await new Promise<void>((done) => server!.listen(0, "127.0.0.1", () => done()));
    return { at: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, heard };
  };
  const calendar = { id: "acme-calendar", name: "Acme Calendar", fields: { link: { kind: "secret", label: "Calendar link", secret: "acme-calendar.link" }, key: { kind: "secret", label: "API key", secret: "acme-calendar.key" } } } as unknown as Connector;
  const check = (url: string): Check => ({ url });
  const signal = () => new AbortController().signal;

  it("sends a link that is its own credential to itself alone, no header; refuses one that is no https address, or holds a name and password, before any request, never in its words", async () => {
    const { at, heard } = await provider();
    expect(await declaredCheck(calendar, check(CREDENTIAL), "link", ` ${at}/feeds/secret-a/calendar.ics `, signal())).toEqual({ credential: `${at}/feeds/secret-a/calendar.ics` });
    expect(heard.map(({ url, headers }) => [url, headers.authorization, headers.accept])).toEqual([["/feeds/secret-a/calendar.ics", undefined, "*/*"]]);
    for (const typed of ["webcal://calendar.example.com/feeds/secret-a.ics", "http://calendar.example.com/feeds/secret-a.ics", "a link"]) {
      await expect(declaredCheck(calendar, check(CREDENTIAL), "link", typed, signal())).rejects.toMatchObject({ message: "Type your calendar link again: it is an address starting https://.", field: "link" });
    }
    const refused = await declaredCheck(calendar, check(CREDENTIAL), "link", `http://person-a:secret-b@127.0.0.1:${new URL(at).port}/feeds/calendar.ics`, signal()).catch((error: unknown) => error);
    expect(refused).toMatchObject({ message: "Type your calendar link again, with no name or password before its address.", field: "link" });
    expect(JSON.stringify({ ...(refused as object), message: (refused as Error).message, cause: String((refused as Error).cause) })).not.toMatch(/secret-b|person-a/u);
    expect(heard).toHaveLength(1);
    await expect(declaredCheck(calendar, check(CREDENTIAL), "link", `${at}/feeds/revoked/calendar.ics`, signal())).rejects.toMatchObject({ name: "NeedsYou" });
  });

  it("follows no redirect, a link's to another origin or a bearer's: the credential reaches the address typed or declared alone", async () => {
    const other = await provider();
    const first = server!;
    const { at, heard } = await provider(`${other.at}/feeds/secret-a/calendar.ics?from=moved`);
    try {
      await expect(declaredCheck(calendar, check(CREDENTIAL), "link", `${at}/moved`, signal())).rejects.toMatchObject({ message: "Type your calendar link again: Acme Calendar sends it on to another address, which Lifestream does not follow.", field: "link" });
      await expect(declaredCheck(calendar, check(`${at}/moved`), "key", "k-1", signal())).rejects.toMatchObject({ message: "Acme Calendar answered the check by sending it to another address, which Lifestream does not follow." });
      expect(heard.map(({ url, headers }) => [url, headers.authorization])).toEqual([["/moved", undefined], ["/moved", "Bearer k-1"]]);
      expect(other.heard).toEqual([]);
    } finally {
      await new Promise<void>((done) => first.close(() => done()));
    }
  });

  it("sends the bearer to a check whose address names no credential", async () => {
    const { at, heard } = await provider();
    expect(await declaredCheck(calendar, check(`${at}/v1/me`), "key", "k-2", signal())).toEqual({ credential: "k-2" });
    expect(heard.map(({ url, headers }) => [url, headers.authorization])).toEqual([["/v1/me", "Bearer k-2"]]);
  });
});

describe("connectors show's sign-in lines", () => {
  it("says each route's way, and a client route's authorization endpoint with its scope and the client's parameters", () => {
    const client: Client = { id: "acme", name: "Acme", authorize: "https://accounts.example.com/o/oauth2/v2/auth", token: "https://accounts.example.com/token", params: { access_type: "offline" }, before: ["Make a client."] };
    const tasks = {
      id: "acme-tasks", name: "Acme Tasks",
      signin: [
        { acquirer: "acme-tasks", way: "client", field: "signin", client: "acme", scope: "tasks.readonly https://www.example.com/auth/userinfo.email", label: "Sign in with Acme", check: { url: "https://www.example.com/oauth2/v3/userinfo", account: "email" } },
        { id: "acme-tasks-key", acquirer: "acme-tasks", way: "key", fields: ["account", "key"], label: "Use a key", check: { url: CREDENTIAL } },
        { id: "acme-tasks-device", acquirer: "acme-tasks", way: "device", field: "signin", issuer: "https://auth.example.com", scope: "tasks", label: "Sign in on another device" },
      ],
    } as unknown as Connector;
    expect(routeLines(tasks, [client])).toEqual([
      "sign-in acme-tasks (client, \"Sign in with Acme\"): opens https://accounts.example.com/o/oauth2/v2/auth, asking tasks.readonly https://www.example.com/auth/userinfo.email, with access_type=offline;"
        + " checked by GET https://www.example.com/oauth2/v3/userinfo, the access token as Authorization: Bearer, its account at email",
      "sign-in acme-tasks-key (key, \"Use a key\"): types account, key; checked by GET of the link typed, its own credential",
      "sign-in acme-tasks-device (device, \"Sign in on another device\"): OAuth's device grant at https://auth.example.com, asking tasks",
    ]);
    expect(routeLines({ ...tasks, signin: [tasks.signin![0]!] } as Connector, [])).toEqual(["sign-in acme-tasks (client, \"Sign in with Acme\"): names the client acme, which this release does not declare"]);
    const { params: _params, ...plain } = client;
    expect(routeLines({ ...tasks, signin: [tasks.signin![0]!] } as Connector, [plain])).toEqual([
      "sign-in acme-tasks (client, \"Sign in with Acme\"): opens https://accounts.example.com/o/oauth2/v2/auth, asking tasks.readonly https://www.example.com/auth/userinfo.email;"
        + " checked by GET https://www.example.com/oauth2/v3/userinfo, the access token as Authorization: Bearer, its account at email",
    ]);
  });
});
