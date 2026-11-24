import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { FakeRelay, type SiteRequest } from "../test/station.js";
import { declarations } from "../index.js";
import { NeedsYou } from "../seams.js";
import { browserAcquirer, type Recipe } from "./browser.js";
import { chromeSites, survey, tabRead, verdictOf, whoIs, type ChromeSite, type Verdict } from "./setup.js";
import type { SiteConnector } from "./site-lane.js";
import { stationsOver } from "./station.js";

const TOKEN = "drive-token-synthetic";
const SECRET_TOKEN = "access-token-synthetic";

const CATALOG: ChromeSite[] = [
  { id: "notes", name: "Notes", origin: "https://notes.example", probe: { url: "/api/account", has: "uuid", who: { id: "uuid", email: "email_address" } }, lanes: ["notes-browser"] },
  { id: "chat", name: "Chat", origin: "https://chat.example", probe: { url: "/api/auth/session", has: "accessToken", who: { url: "/api/me", id: "id", email: "email", bearer: true } }, lanes: ["chat-browser"] },
  { id: "music", name: "Music", origin: "https://music.example", probe: null, lanes: [] },
  { id: "mail", name: "Mail", origin: "https://mail.example", probe: { url: "/api/me", has: "id" }, lanes: [] },
  { id: "bank", name: "Bank", origin: "https://bank.example", probe: { url: "/api/me", has: "id" }, lanes: [] },
];

const FIRST = (): Verdict => "read";

function site(request: SiteRequest): { status: number; body?: unknown } {
  switch (request.url.origin) {
    case "https://notes.example":
      return { status: 200, body: { uuid: "account-0001", email_address: "person-a@example.com" } };
    case "https://chat.example":
      return { status: 200, body: {} };
    case "https://mail.example":
      return { status: 401, body: { error: "signed out" } };
    default:
      return { status: 503 };
  }
}

describe("setting up", () => {
  it("tells signed in, signed out and not known apart, and hands the home the account's email alone (1, 2, 3)", async () => {
    const relay = new FakeRelay({ answer: site });
    const stations = stationsOver("https://door.example", TOKEN, { fetch: relay.fetch });
    const { sites: found } = await survey(stations, [...CATALOG, { ...CATALOG[0]!, id: "notes-2", name: "Notes again", origin: "https://notes.example" }], FIRST);
    expect(found.map((one) => [one.id, one.signed_in])).toEqual([
      ["notes", true],
      ["chat", false],
      ["music", null],
      ["mail", false],
      ["bank", null],
      ["notes-2", true],
    ]);
    expect(relay.errands.map((errand) => errand.name)).toEqual(["probe:notes", "probe:chat", "probe:mail", "probe:bank", "probe:notes-2"]);
    expect(relay.errands.every((errand) => errand.origins.length === 1)).toBe(true);
    expect(relay.open).toBe(0);
    expect(relay.offered).toEqual(found);
    expect(found.map((one) => one.account)).toEqual([{ email: "person-a@example.com", verdict: "read" }, null, null, null, null, { email: "person-a@example.com", verdict: "read" }]);
    expect(JSON.stringify(found)).not.toContain("account-0001");
  });

  it("hands the home a token or the provider's id, names an account by anything but its email, or puts it without the home's verdict (2)", async () => {
    const asked: string[] = [];
    const relay = new FakeRelay({
      answer: (request) => {
        asked.push(`${request.url.pathname} ${request.headers.Authorization ?? "-"}`);
        if (request.url.pathname === "/api/auth/session") return { status: 200, body: { accessToken: SECRET_TOKEN, sessionToken: "session-token-synthetic", user: { email: "person-a@example.com" } } };
        if (request.url.pathname === "/api/me") return request.headers.Authorization === `Bearer ${SECRET_TOKEN}` ? { status: 200, body: { id: "user-0001", email: "person-b@example.com" } } : { status: 401 };
        return { status: 200, body: { uuid: "account-0001", email_address: "person-a@example.com" } };
      },
    });
    const lanes: Record<string, Record<string, boolean>> = { notes: { "account-0001": true }, chat: { "user-0009": true } };
    const verdicts: string[] = [];
    const { sites: found } = await survey(stationsOver("https://door.example", TOKEN, { fetch: relay.fetch }), CATALOG.slice(0, 2), (one, id) => {
      verdicts.push(`${one.id} ${id}`);
      return verdictOf(lanes[one.id]!, id);
    });
    expect(verdicts).toEqual(["notes account-0001", "chat user-0001"]);
    expect(found.map((one) => one.account)).toEqual([{ email: "person-a@example.com", verdict: "read" }, { email: "person-b@example.com", verdict: "offered" }]);
    expect(asked).toEqual(["/api/account -", "/api/auth/session -", `/api/me Bearer ${SECRET_TOKEN}`]);
    for (const leaked of [SECRET_TOKEN, "session-token-synthetic", "user-0001", "account-0001"]) expect(JSON.stringify(relay.offered)).not.toContain(leaked);
    expect([verdictOf({ a: true }, "a"), verdictOf({ a: false }, "a"), verdictOf({ a: true }, "b"), verdictOf({}, "b")]).toEqual(["read", "not-read", "offered", "read"]);
  });

  it("looks again at a site Chrome started again under, rather than reading it as not known (6)", async () => {
    const relay = new FakeRelay({ answer: site });
    relay.refusals.push({ op: "open", code: "INTERRUPTED" });
    const { sites: found } = await survey(stationsOver("https://door.example", TOKEN, { fetch: relay.fetch }), CATALOG.slice(0, 1), FIRST);
    expect({ signed_in: found[0]?.signed_in, begun: relay.errands.map((errand) => errand.name) }).toEqual({ signed_in: true, begun: ["probe:notes", "probe:notes"] });
  });

  it("reads a refused probe as not known, and one Chrome refused the site as not allowed there", async () => {
    const relay = new FakeRelay({ answer: site });
    relay.refusals.push({ op: "open", code: "SITE_NOT_ALLOWED" });
    const { sites: found } = await survey(stationsOver("https://door.example", TOKEN, { fetch: relay.fetch }), CATALOG.slice(0, 1), FIRST);
    expect([found[0]?.signed_in, found[0]?.allowed]).toEqual([null, false]);
    const other = new FakeRelay({ answer: site });
    other.refusals.push({ op: "open", code: "ORIGIN_REFUSED" });
    const { sites: refused } = await survey(stationsOver("https://door.example", TOKEN, { fetch: other.fetch }), CATALOG.slice(0, 1), FIRST);
    expect([refused[0]?.signed_in, "allowed" in refused[0]!]).toEqual([null, false]);
  });

  it("surveys the one station named, and puts what it found as that station's (4)", async () => {
    const relay = new FakeRelay({ answer: () => ({ status: 200, body: { uuid: "account-0001", accessToken: SECRET_TOKEN } }) });
    const { sites: found } = await survey(stationsOver("https://door.example", TOKEN, { fetch: relay.fetch, station: "chrome-5550aa01" }), CATALOG, FIRST);
    expect(relay.named.every((named) => named === "chrome-5550aa01")).toBe(true);
    expect(relay.offeredFor).toBe("chrome-5550aa01");
    expect(found.map((site) => Object.keys(site).sort())).toEqual(found.map(() => ["account", "id", "name", "origin", "signed_in"]));
    expect(JSON.stringify(relay.offered)).not.toContain(SECRET_TOKEN);
  });

  it("keeps what was last found of a site the station is busy with, and asks it of a station with no wait when told (6)", async () => {
    const relay = new FakeRelay({ answer: site });
    const stations = stationsOver("https://door.example", TOKEN, { fetch: relay.fetch, station: "chrome-5550aa01", wait_ms: 0 });
    expect((await survey(stations, CATALOG.slice(0, 2), FIRST)).changed).toEqual({ notes: true, chat: false });
    expect(relay.offered.map((one) => [one.id, one.signed_in])).toEqual([["notes", true], ["chat", false]]);
    relay.busy.add("https://notes.example");
    const { sites: found, changed } = await survey(stations, CATALOG.slice(0, 2), FIRST);
    expect(found.map((one) => [one.id, one.signed_in])).toEqual([["notes", null], ["chat", false]]);
    expect(relay.offered.map((one) => [one.id, one.signed_in])).toEqual([["notes", true], ["chat", false]]);
    expect(changed).toEqual({});
    expect(relay.waits.every((wait) => wait === 0)).toBe(true);
    const fresh = new FakeRelay({ answer: site });
    fresh.busy.add("https://notes.example");
    expect((await survey(stationsOver("https://door.example", TOKEN, { fetch: fresh.fetch }), CATALOG.slice(0, 1), FIRST)).sites[0]?.signed_in).toBeNull();
  });

  it("reads a who answered 401 as anything but signed out, or lets a cookie's session reach the home (7)", async () => {
    const COOKIE = "cookie-token-synthetic";
    const pulse: ChromeSite = {
      id: "pulse", name: "Pulse", origin: "https://app.pulse.example", signin: "https://id.pulse.example",
      probe: { cookie: "pulse-auth-token", who: { url: "https://api.pulse.example/users/me", id: "user.id", email: "account.email" } }, lanes: ["pulse"],
    };
    let signedIn = true;
    let me: { status: number; body?: unknown; failed?: true } | null = null;
    const asked: string[] = [];
    const relay = new FakeRelay({
      answer: (request) => {
        asked.push(`${request.url.href} ${request.headers.Authorization ?? "-"}`);
        if (request.url.origin === "https://chat.example") {
          return request.url.pathname === "/api/auth/session" ? { status: 200, body: { accessToken: SECRET_TOKEN } } : { status: 401 };
        }
        if (me !== null) return me;
        return request.headers.Authorization === `Bearer ${COOKIE}`
          ? { status: 200, body: { user: { id: 10000001 }, account: { id: 99, email: "person-a@example.com" } } }
          : { status: 401, body: { error: "no session" } };
      },
      page: (url) => (url.origin === pulse.origin && !signedIn ? { elements: [], redirect: "https://id.pulse.example/sign-in/" } : undefined),
      cookies: (origin) => (origin === pulse.origin && signedIn ? { "pulse-auth-token": COOKIE } : {}),
      cors: (page, url) => url.origin !== "https://api.pulse.example" || page === pulse.origin,
    });
    const stations = stationsOver("https://door.example", TOKEN, { fetch: relay.fetch });
    const verdicts: string[] = [];
    const surveyed = async () => (await survey(stations, [pulse, CATALOG[1]!], (one, id): Verdict => {
      verdicts.push(`${one.id} ${id}`);
      return "read";
    })).sites.map((one) => [one.id, one.signed_in, one.account !== null && "email" in one.account ? one.account.email : null]);
    expect(await surveyed()).toEqual([["pulse", true, "person-a@example.com"], ["chat", false, null]]);
    expect(verdicts).toEqual(["pulse 10000001"]);
    expect(asked.filter((line) => line.includes("pulse"))).toEqual([`https://api.pulse.example/users/me Bearer ${COOKIE}`]);
    expect(relay.errands[0]!.origins).toEqual(["https://app.pulse.example", "https://id.pulse.example", "https://api.pulse.example"]);
    expect(relay.errands.map((errand) => [errand.name, errand.cookies])).toEqual([["probe:pulse", ["pulse-auth-token"]], ["probe:chat", undefined]]);
    expect(JSON.stringify(relay.offered)).not.toContain(COOKIE);
    signedIn = false;
    asked.length = 0;
    expect(await surveyed()).toEqual([["pulse", false, null], ["chat", false, null]]);
    expect(asked.filter((line) => line.includes("pulse"))).toEqual([]);
    signedIn = true;
    me = { status: 503 };
    expect((await surveyed())[0]).toEqual(["pulse", null, null]);

    const lane = async () => stations.using({ name: "pulse", origins: ["https://app.pulse.example", "https://id.pulse.example", "https://api.pulse.example"], cookies: ["pulse-auth-token"], deadline_ms: 60_000 },
      async (errand) => whoIs("Pulse", pulse.probe!, tabRead(await errand.open(`${pulse.origin}/`))));
    me = null;
    expect((await lane()).who).toEqual({ id: "10000001", email: "person-a@example.com" });
    const outcomes: string[] = [];
    for (const answer of [{ status: 401 }, { status: 403 }, { status: 200, body: { user: {}, account: { email: "person-a@example.com" } } }, { status: 200, body: { user: { id: 1.5 }, account: { email: "person-a@example.com" } } }]) {
      me = answer;
      outcomes.push(await lane().then(() => "named", (error: Error) => (error instanceof NeedsYou ? `needs ${error.reason}` : "failed")));
    }
    expect(outcomes).toEqual(["needs signed-out", "failed", "failed", "failed"]);
    me = { status: 0, failed: true };
    expect(await lane().then(() => "named", (error: Error) => error.message))
      .toBe("Pulse answered 0 to its sign-in read https://api.pulse.example/users/me (PAGE_ERROR: Failed to fetch)");
    expect(relay.open).toBe(0);
  });

  it("names a site with no probe by its lane's own sign-in read at Set up, from its pages alone: no list, no item, no file, no poll touched (8)", async () => {
    const claude = declarations().find((each) => each.id === "claude")! as SiteConnector;
    const shop: SiteConnector = { ...claude, id: "shop", name: "Shop", chrome: { origin: "https://shop.example", probe: null }, acquirers: ["shop-browser"] };
    const root = mkdtempSync(join(tmpdir(), "connect-who-"));
    onTestFinished(() => rmSync(root, { recursive: true, force: true }));
    const work = join(root, "work");
    let signedIn = true;
    const asked: string[] = [];
    const relay = new FakeRelay({
      answer: (request) => {
        asked.push(request.url.pathname);
        if (request.url.pathname === "/account/hello") return signedIn ? { status: 200, body: { customer: "customer-0001", greeting: "Person A" } } : { status: 401 };
        return { status: 500, body: { error: "not for Set up" } };
      },
    });
    const recipe: Recipe = {
      name: "shop-browser", site: shop, pace_ms: 0,
      async begin(pull) {
        const page = await pull.json("/account/hello");
        if (page.status === 401) throw new NeedsYou("signed-out", "Sign in to Shop in Chrome");
        const body = page.json as { customer: string; greeting: string };
        pull.keep("account.json", Buffer.from(JSON.stringify(body)));
        return { id: body.customer, name: body.greeting };
      },
      async *list(pull) {
        await pull.json("/api/orders");
        throw new Error("Set up read the list");
      },
      *exported() {},
      async conversation(pull, id) {
        await pull.json(`/api/orders/${id}`);
        throw new Error("Set up read an item");
      },
    };
    const lane = browserAcquirer({ work }, {}, recipe);
    expect([typeof lane.who, browserAcquirer({ work }, {}, { ...recipe, site: claude }).who]).toEqual(["function", undefined]);
    const sites = chromeSites([shop], [lane]);
    expect(sites.map((site) => [site.id, site.probe, typeof site.who])).toEqual([["shop", null, "function"]]);
    const verdicts: string[] = [];
    const stations = stationsOver("https://door.example", TOKEN, { fetch: relay.fetch });
    const surveyed = async () => (await survey(stations, sites, (site, id) => {
      verdicts.push(`${site.id} ${id}`);
      return "read";
    })).sites.map((site) => [site.id, site.signed_in, site.account]);
    expect(await surveyed()).toEqual([["shop", true, { name: "Person A", verdict: "read" }]]);
    expect(verdicts).toEqual(["shop customer-0001"]);
    expect(relay.offered).toEqual([{ id: "shop", name: "Shop", origin: "https://shop.example", signed_in: true, account: { name: "Person A", verdict: "read" } }]);
    expect(JSON.stringify(relay.offered)).not.toContain("customer-0001");
    expect(asked).toEqual(["/account/hello"]);
    expect(existsSync(work)).toBe(false);
    expect([relay.errands.map((errand) => errand.name), relay.open]).toEqual([["probe:shop"], 0]);
    signedIn = false;
    expect(await surveyed()).toEqual([["shop", false, null]]);
    const before = relay.errands.length;
    expect((await survey(stations, chromeSites([shop]), () => "read")).sites.map((site) => [site.signed_in, site.account])).toEqual([[null, null]]);
    expect(relay.errands.length).toBe(before);
  });

  it("the declarations make ChatGPT, Claude and WHOOP, one lane each, no export request, hand export or archive's ask among them, WHOOP alone set up by a form (5)", () => {
    expect(chromeSites(declarations()).map((site) => [site.id, site.lanes, site.form ?? false])).toEqual([["chatgpt", ["chatgpt-browser"], false], ["claude", ["claude-browser"], false], ["whoop", ["whoop"], true]]);
  });
});
