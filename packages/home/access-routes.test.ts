import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import type { IncomingMessage } from "node:http";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Connector } from "@lifestreamprotocol/connect";
import { canonical, openHomeFolder, type DaySettings, type Json, type JsonObject, type SourceRow, type Type } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { openLedger, type AccessChange, type AccessRequest, type Ledger, type ReaderCall } from "@lifestreamprotocol/model";
import type { Access, DraftAccess } from "@lifestreamprotocol/privacy";
import { defaultAccess, emptyAccess, fullAccess } from "./access.js";
import { ACCESS_NOT_STARTED, allowWant, personIn, type Cursor, type HeldHistory, type PersonWriting, type Proposed } from "./access-ledger.js";
import { HISTORY_PAGE, offeredOf, openPersonAccess, pageOf, type Asker, type HistoryPage, type SignInRead } from "./access-routes.js";
import { narrowedWords, phraseText, plainOf, signInSays, type Words } from "./access-words.js";
import { makeRef } from "./refs.js";
import type { SignInAnswer, SignInHeld } from "./agents.js";
import type { PublicState } from "./funnel.js";
import { Refusal, refuse } from "./refusal.js";
import { connectors, families } from "./registry-home.js";
import { effective } from "./settings.js";
import { writeFolder } from "./test/folder.js";
import { as, blocked, DOWNLOAD, ENABLE, guideDoorReplies, ORIGIN, routes, serve } from "./test/guide-door.js";
import { clientFixture } from "./test/harness-root.js";
import { wordsAt } from "./test/support.js";
import { cameOf } from "./way-out.js";

const NOW = Date.UTC(2026, 10, 14, 9, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WORDS: Words = {
  account: (account) => account,
  product: (product) => product,
  address: () => null,
  zone: "UTC",
};
const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };
const label = (pass: string) => (pass === "p-phone001" ? "iPhone" : null);
const HISTORY_READER = { name: "Hermes", chat: false };
const SESSION_DAY = (ms: number) => ({ day: new Date(ms).toISOString().slice(0, 10), words: new Date(ms).toISOString().slice(5, 10) });

function rowOf(id: string, connector: string): SourceRow {
  const [product = "", account = "", copy = ""] = id.split(":");
  return { id, product, vendor: "example", account, copy, connector, options: {}, read_through_ms: null, added_ms: 0 };
}

function call(seq: number, session: number, at_ms: number): ReaderCall {
  return { seq, id: `call-${seq.toString(16).padStart(16, "0")}`, at_ms, reader: "p-0000aaaa", session, access_version: 1, tool: "search", sent: { query: `q${seq}` }, read: null, result: "answered", code: null, words: null, ms: 5, withheld: [], came: { mail: 1 }, outbound: [] };
}

function change(seq: number, at_ms: number, what: AccessChange["what"] = "narrowed"): AccessChange {
  return { seq, at_ms, reader: "p-0000aaaa", version: seq, what, by: "person", device: "p-phone001", request: null, lines: defaultAccess() as never, about: null };
}

function held(calls: ReaderCall[], changes: AccessChange[], older = 0, days: Record<string, number> = {}): HeldHistory {
  return { calls, changes, requests: [], versions: { 1: defaultAccess() as never }, befores: {}, older, counts: {}, scanned: null, days };
}

describe("the accounts the editor offers", () => {
  const family = (reads: string[]): Pick<Family, "name" | "inputs"> => ({ name: "example", inputs: [{ sources: { product: reads }, kinds: ["entry"], role: "evidence" }] });

  it("give a local account whose name another shares the device its data arrives from as its line, so no two read alike", () => {
    const connector = (id: string, name: string, arrives: string): Connector => ({ id, product: id, name, vendor: "example", type: "notes", sources: [{ id: `${id}:local:<unit>`, read: `${id}-read`, arrives }] }) as unknown as Connector;
    const offered = offeredOf(
      [rowOf("mac-notes:local:macbook-pro-0001", "mac-notes-read"), rowOf("phone-notes:local:iphone-aa01", "phone-notes-read"), rowOf("journal:local:iphone-aa01", "journal-read")],
      [connector("mac-notes", "Notes", "mac"), connector("phone-notes", "Notes", "phone"), connector("journal", "Journal", "phone")], [family(["mac-notes", "phone-notes", "journal"])],
    );
    expect(offered.map((each) => [each.account, each.name, each.line])).toEqual([
      ["journal:local", "Journal", null], ["mac-notes:local", "Notes", "Mac"], ["phone-notes:local", "Notes", "iPhone"],
    ]);
  });

  it("give an account whose evidence sources declare two types the one TYPES lists first, whatever its source ids", () => {
    const connector = (id: string, type: Type, copy: string): Connector => ({ id, product: "example-log", name: "Log", vendor: "example", type, sources: [{ id: `example-log:<account>:${copy}`, read: `${id}-read`, arrives: "upload" }] }) as unknown as Connector;
    const connectors = [connector("example-notes", "notes", "a"), connector("example-chat", "messages", "b")];
    const flipped = [connector("example-notes", "notes", "b"), connector("example-chat", "messages", "a")];
    const rows = [rowOf("example-log:person-a@example.com:a", "example-notes-read"), rowOf("example-log:person-a@example.com:b", "example-chat-read")];
    const swapped = [rowOf("example-log:person-a@example.com:a", "example-chat-read"), rowOf("example-log:person-a@example.com:b", "example-notes-read")];
    expect(offeredOf(rows, connectors, [family(["example-log"])]).map((each) => each.category)).toEqual(["messages"]);
    expect(offeredOf(swapped, flipped, [family(["example-log"])]).map((each) => each.category)).toEqual(["messages"]);
  });
});

describe("a home's accounts read only as labels", () => {
  const DIR = mkdtempSync(join(tmpdir(), "lifestream-access-offered-"));
  writeFolder(DIR);
  const FAMILIES = families(effective(DIR).settings, DIR);
  const CONNECTORS = connectors();
  const ROWS = [
    rowOf("gmail:person-a@example.com:cloud", "gmail"), rowOf("whatsapp:+15550000001:iphone-aa01", "whatsapp-db"), rowOf("location:local:iphone-aa01", "location-ios-bundle"),
    rowOf("people:local:macbook-pro-0001", "people-home"), rowOf("places:local:macbook-pro-0001", "places-home"), rowOf("devices:local:macbook-pro-0001", "devices-home"),
    rowOf("stations:local:macbook-pro-0001", "stations-home"), rowOf("google-maps:person-a@example.com:lookup", "google-place-names"),
  ];
  const TAKEOUT = rowOf("google-maps:person-a@example.com:export", "google-my-activity");
  const LABELS = ["People", "Places", "Devices", "Stations", "people:local", "places:local", "devices:local", "stations:local"];

  afterAll(() => rmSync(DIR, { recursive: true, force: true }));

  const served = async (rows: readonly SourceRow[], reading: readonly Pick<Family, "name" | "inputs">[] = FAMILIES) => {
    const offered = offeredOf(rows, CONNECTORS, reading);
    const person = openPersonAccess({
      writer: { person: async <T>(asked: PersonWriting) => ("waiting" in asked ? [] : { access: undefined, own: undefined, open: undefined, tally: null, kinds: null, today: null, last: null }) as T },
      signIns: { waiting: async () => ({ requests: [{ id: "sign-in-1", name: "Example agent", checked: true, host: null, choices: [], at_ms: NOW, until_ms: NOW + HOUR }] }), read: async () => ({ answered: null, granted: null }), answer: async () => ({ state: "denied", name: "Example agent", at_ms: NOW, device: null, granted: null }) },
      offered: async () => offered,
      readers: () => [{ id: "p-0000aaaa", name: "Example agent", kind: "agent", how: "", via: "pass", from: null, app: null, anywhere: false, made_ms: 0, disconnected_ms: null, listed: true }],
      disconnect: async () => undefined, address: unasked, key: unasked,
      describe: async () => ({ described: [] }),
      device: () => null,
      clock: () => NOW,
      day: () => DAY,
    });
    const asker = { pass: { id: "p-phone001", kind: "phone" }, ask: false, widen: true } as unknown as Asker;
    const waiting = await person.waiting(asker, { method: "GET" } as IncomingMessage);
    const own = await person.own("p-0000aaaa", { reader: "p-0000aaaa", version: 1, lines: defaultAccess() as unknown as Json, covers: [], at_ms: NOW });
    for (const words of [waiting.requests[0]!.sentence, own.text]) for (const label of LABELS) expect(words).not.toContain(label);
    return { offered: offered.map((each) => [each.account, each.category]), outside: own.outside };
  };

  it("offers, names and lists outside only the accounts a family reads as evidence, with or without Google Maps' Takeout, in any order", async () => {
    const bare = await served(ROWS);
    expect(bare).toEqual({ offered: [["gmail:person-a@example.com", "mail"], ["location:local", "places"], ["whatsapp:+15550000001", "messages"]], outside: [] });
    expect(await served([TAKEOUT, ...ROWS])).toEqual(bare);
    expect(await served([...ROWS, TAKEOUT].reverse())).toEqual(bare);
  });

  it("gives Google Maps the category of its Takeout once a family reads it as evidence, whatever the order of its sources", async () => {
    const maps: Pick<Family, "name" | "inputs"> = { name: "maps", inputs: [{ sources: { product: ["google-maps"], copy: ["export"] }, kinds: ["place-view"], role: "evidence" }] };
    const read = await served([TAKEOUT, ...ROWS], [...FAMILIES, maps]);
    expect(read.offered).toContainEqual(["google-maps:person-a@example.com", "web"]);
    expect(await served([...ROWS, TAKEOUT].reverse(), [...FAMILIES, maps])).toEqual(read);
    expect((await served(ROWS, [...FAMILIES, maps])).offered).not.toContainEqual(expect.arrayContaining(["google-maps:person-a@example.com"]));
  });
});

const unasked = async (): Promise<never> => {
  throw new Error("no address or key is asked here");
};

describe("a waiting sign-in and its guide", () => {
  const SIGN_INS = [
    { id: "sign-in-1", name: "ChatGPT", checked: true, host: "chatgpt.com", choices: [], at_ms: NOW, until_ms: NOW + HOUR },
    { id: "sign-in-2", name: "Muse", checked: false, host: "muse.example.com", choices: [], at_ms: NOW, until_ms: NOW + HOUR },
    { id: "sign-in-3", name: "Meta assistant", checked: false, host: "agent.meta.ai", choices: [], at_ms: NOW, until_ms: NOW + HOUR },
    { id: "sign-in-4", name: "Local tool", checked: false, host: null, choices: [], at_ms: NOW, until_ms: NOW + HOUR },
  ];
  const person = openPersonAccess({
    writer: { person: async <T>(asked: PersonWriting) => ("waiting" in asked ? [] : { access: undefined, own: undefined, open: undefined, tally: null, kinds: null, today: null, last: null }) as T },
    signIns: { waiting: async () => ({ requests: SIGN_INS }), read: async () => ({ answered: null, granted: null }), answer: async () => ({ state: "denied", name: "ChatGPT", at_ms: NOW, device: null, granted: null }) },
    offered: async () => [],
    readers: () => [
      { id: "p-0000aaaa", name: "ChatGPT", kind: "agent", how: "", via: "sign-in", from: "chatgpt.com", app: null, anywhere: false, made_ms: 0, disconnected_ms: null, listed: true },
      { id: "p-0000bbbb", name: "Example agent", kind: "agent", how: "", via: "pass", from: null, app: null, anywhere: false, made_ms: 0, disconnected_ms: null, listed: true },
    ],
    disconnect: async () => undefined, address: unasked, key: unasked,
    describe: async () => ({ described: [] }),
    device: () => null,
    clock: () => NOW,
    day: () => DAY,
  });
  const phone = { pass: { id: "p-phone001", kind: "phone" }, ask: false, widen: true } as unknown as Asker;

  it("names a sign-in from a guide's host by the guide, and says calmly where it comes from", async () => {
    const [chatgpt, , muse] = (await person.waiting(phone, { method: "GET" } as IncomingMessage)).requests;
    expect(chatgpt).toMatchObject({
      app: "chatgpt", name: "ChatGPT", head: "ChatGPT wants to read your Lifestream", over_line: [{ kind: "words", words: "From chatgpt.com" }],
      pick: "Pick the number ChatGPT shows", pick_line: "The number is the yes. A wrong one turns ChatGPT away.",
      notice: "ChatGPT wants to read your Lifestream. Pick the number it shows.",
    });
    expect(muse, "an unchecked name from Muse's host takes Muse's name and words").toMatchObject({
      app: "muse", name: "Muse", head: "Muse wants to read your Lifestream", over_line: [{ kind: "words", words: "From agent.meta.ai, where Muse runs" }],
      notice: "Muse wants to read your Lifestream. Pick the number it shows.",
    });
  });

  it("keeps an unchecked \"Muse\" from another host, and one with no host, as they sign in: no app, never the calm words", async () => {
    const [, other, , local] = (await person.waiting(phone, { method: "GET" } as IncomingMessage)).requests;
    expect(other).toMatchObject({ app: null, name: "Muse", checked: false, host: "muse.example.com", over_line: wordsAt("Signing in from muse.example.com ·", NOW) });
    expect(phraseText(other!.over_line, NOW, "UTC")).not.toContain("where Muse runs");
    expect(local).toMatchObject({ app: null, name: "Local tool", over_line: wordsAt("Signing in ·", NOW), notice: "Local tool wants to read your Lifestream. Pick the number it shows." });
    expect([other, local].map((card) => signInSays(card!.name, card!.checked, card!.host)), "the sign-in page's line, the home's: it says what the app claims").toEqual([
      "says it is Muse, sending access to muse.example.com", "says it is Local tool, an app on the computer you are signing in from",
    ]);
    expect(signInSays("ChatGPT", true, "chatgpt.example"), "a name its metadata proved, from a host no guide has").toBe("from chatgpt.example");
  });

  it("answers the guides only to the person, with the readers and the default access drawn for each app", async () => {
    const held = await person.guides(phone);
    expect(held.readers.map((each) => each.id)).toEqual(["p-0000aaaa", "p-0000bbbb"]);
    expect(held.sees("Grok Bot")).toMatchObject({ access: defaultAccess(), view: { sentence: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Grok Bot") })]) } });
    const chat = { pass: { id: "p-mac00001", kind: "mac" }, ask: true, widen: false } as unknown as Asker;
    await expect(person.guides(chat)).rejects.toMatchObject({ status: 403, code: "PERSON_ONLY" });
  });
});

describe("the address and a key", () => {
  it("says the address on with the line, off with its url when Tailscale knows it, and asks the home once for each", async () => {
    const on = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    expect((await serve(on.person, as("mac"), "GET", "/v1/agents/address")).body).toEqual({
      state: "on", url: `${ORIGIN}/mcp`, line: "Lifestream’s agent address is now on the internet. Only agents you say yes to can read.",
    });
    expect((await serve(on.person, as("phone"), "POST", "/v1/agents/address", { on: true })).body).toMatchObject({ state: "on" });
    expect(on.asked.address).toEqual([null, { reader: null }]);
    const off = routes({ state: "off", origin: ORIGIN, why: null, open: null });
    expect((await serve(off.person, as("mac"), "GET", "/v1/agents/address")).body).toEqual({ state: "off", url: `${ORIGIN}/mcp` });
    expect(await serve(off.person, as("mac"), "POST", "/v1/agents/address", { on: false }), "the address turns itself off, never by an app").toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(off.asked.address).toEqual([null]);
    expect((await serve(routes({ state: "off", origin: null, why: null, open: null }).person, as("mac"), "GET", "/v1/agents/address")).body).toEqual({ state: "off", url: null });
  });

  it("words each fix for the asking device, with an act on the Mac and words alone on the iPhone, but Allow Funnel on both", async () => {
    const fix = async (state: PublicState, kind: "mac" | "phone", method: "GET" | "POST" = "GET") =>
      (await serve(routes(state).person, as(kind), method, "/v1/agents/address", method === "POST" ? { on: true } : {})).body;
    expect(await fix(blocked("Install Tailscale on this Mac", DOWNLOAD), "mac")).toEqual({ state: "fix", url: null, words: "Your address needs Tailscale on this Mac.", act: { label: "Get Tailscale", to: "web", url: DOWNLOAD } });
    expect(await fix(blocked("Install Tailscale on this Mac", DOWNLOAD), "phone")).toEqual({ state: "fix", url: null, words: "Needs Tailscale on your Mac.", act: null });
    expect(await fix(blocked("Sign in to Tailscale", "https://login.tailscale.com/a/fake0001"), "mac")).toMatchObject({ words: "Sign in to Tailscale to get your address.", act: { label: "Sign in", to: "web", url: "https://login.tailscale.com/a/fake0001" } });
    expect(await fix(blocked("Sign in to Tailscale"), "mac")).toMatchObject({ act: { label: "Sign in", to: "tailscale", url: null } });
    expect(await fix(blocked("Sign in to Tailscale"), "phone")).toMatchObject({ words: "Sign in to Tailscale on your Mac.", act: null });
    for (const why of ["Open Tailscale on this Mac", "Turn on Tailscale"]) {
      expect(await fix(blocked(why), "mac")).toMatchObject({ words: "Open Tailscale to get your address.", act: { label: "Open Tailscale", to: "tailscale", url: null } });
      expect(await fix(blocked(why), "phone")).toMatchObject({ words: "Open Tailscale on your Mac.", act: null });
    }
    for (const kind of ["mac", "phone"] as const) {
      expect(await fix(blocked("Allow Funnel in Tailscale"), kind), `${kind}: a look turns it on`).toEqual({
        state: "fix", url: null, words: "Allow Funnel in Tailscale to put your address on the internet.", act: { label: "Allow Funnel", to: "turn-on", url: null },
      });
      expect(await fix(blocked("Allow Funnel in Tailscale", ENABLE), kind, "POST"), `${kind}: a turn-on opens Tailscale's page`).toMatchObject({ act: { label: "Allow Funnel", to: "web", url: ENABLE } });
    }
  });

  it("never shows Tailscale's own words: a taken address says the home's, and anything else one line", async () => {
    const words = async (state: PublicState) => (await serve(routes(state).person, as("mac"), "GET", "/v1/agents/address")).body;
    expect(await words({ state: "taken", origin: null, why: "Tailscale already serves something else at this address", open: null }))
      .toEqual({ state: "fix", url: null, words: "Tailscale already serves something else at this address.", act: null });
    expect(await words({ state: "taken", origin: null, why: "Tailscale serves something else at this address, and Funnel is on for it: check Tailscale's serve settings", open: null }))
      .toMatchObject({ words: "Tailscale serves something else at this address, and Funnel is on for it: check Tailscale's serve settings.", act: null });
    for (const why of ["Tailscale did not answer: spawn EACCES", "Tailscale did not turn Funnel on: backend error 0x51", "Tailscale did not say what it serves: it said nothing"]) {
      const said = await words(blocked(why));
      expect(said, why).toEqual({ state: "fix", url: null, words: "Tailscale did not answer. Open Tailscale on your Mac.", act: null });
    }
  });

  it("answers the address and keys only to the person: an Ask chat or the MCP relay is PERSON_ONLY, and the home is never asked", async () => {
    const { person, asked } = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    for (const asker of [as("mac", { ask: true, widen: false }), as("mac", { widen: false })]) {
      for (const [method, path, body] of [["GET", "/v1/agents/address", {}], ["POST", "/v1/agents/address", { on: true }], ["POST", "/v1/agents/keys", { app: "instinct", access: defaultAccess() as unknown as Json }]] as const) {
        expect(await serve(person, asker, method, path, body), `${method} ${path}`).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
      }
    }
    expect([asked.address, asked.keys]).toEqual([[], []]);
  });

  it("makes a key from the iPhone only for Instinct, whose guide it shows whole", async () => {
    const { person, asked } = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    const access = defaultAccess() as unknown as Json;
    expect(await serve(person, as("phone"), "POST", "/v1/agents/keys", { app: "grok-bot", access })).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    expect(await serve(person, as("phone"), "POST", "/v1/agents/keys", { app: "another", name: "Example tool", access })).toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    const made = await serve(person, as("phone"), "POST", "/v1/agents/keys", { app: "instinct", access });
    expect(made.status).toBe(200);
    expect(asked.keys).toEqual([{ app: "instinct", name: null, access: defaultAccess(), device: "p-phone001" }]);
  });

  it("gives each app its rows: Grok Bot's header, Instinct's address and key, Another agent's loopback rows and the internet address when it is known", async () => {
    const access = defaultAccess() as unknown as Json;
    const on = routes({ state: "on", origin: ORIGIN, why: null, open: null }).person;
    expect((await serve(on, as("mac"), "POST", "/v1/agents/keys", { app: "grok-bot", access })).body).toEqual({
      reader: "p-0000cccc", name: "Grok Bot",
      rows: [
        { label: "Name", text: "Lifestream" }, { label: "Server URL", text: `${ORIGIN}/mcp` },
        { label: "Header name", text: "Authorization" }, { label: "Header value", text: "Bearer synthetic-pass-0001" },
      ],
      connected: { reader: "p-0000cccc", line: "It sees everything but Health and Money. Change it any time in Agents." },
    });
    expect((await serve(on, as("phone"), "POST", "/v1/agents/keys", { app: "instinct", access })).body).toMatchObject({
      rows: [{ label: "Address", text: `${ORIGIN}/mcp` }, { label: "Key", text: "synthetic-pass-0001" }],
    });
    const another = await serve(on, as("mac"), "POST", "/v1/agents/keys", { app: "another", name: "  Example tool ", access });
    expect((another.body.rows as { label: string }[]).map((row) => row.label)).toEqual(["Address", "Key", "Claude Code", "From the internet"]);
    expect(another.body).toMatchObject({ name: "Example tool", rows: [{ text: "http://127.0.0.1:4681/mcp" }, { text: "synthetic-pass-0001" }, { text: expect.stringContaining("claude mcp add --transport http lifestream http://127.0.0.1:4681/mcp") }, { text: `${ORIGIN}/mcp` }] });
    const loopback = routes({ state: "blocked", origin: null, why: "Install Tailscale on this Mac", open: DOWNLOAD }, null).person;
    const alone = await serve(loopback, as("mac"), "POST", "/v1/agents/keys", { app: "another", name: "Example tool", access });
    expect([alone.status, (alone.body.rows as { label: string }[]).map((row) => row.label)], "with no Tailscale, the loopback rows alone").toEqual([200, ["Address", "Key", "Claude Code"]]);
  });

  it("refuses an unknown app, a missing or surplus name, or an access that does not parse, and never asks the home", async () => {
    const { person, asked } = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    const access = defaultAccess() as unknown as Json;
    for (const body of [
      { app: "claude", access }, { app: "another", access }, { app: "another", name: "  ", access }, { app: "another", name: "x".repeat(201), access },
      { app: "instinct", name: "Instinct", access }, { app: "instinct", access: { allow: "everything" } }, { app: "instinct" }, { app: "instinct", access, extra: true },
    ]) {
      expect(await serve(person, as("mac"), "POST", "/v1/agents/keys", body as Json), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    }
    for (const body of [{}, { on: "yes" }, { on: true, extra: 1 }, { on: false, reader: "p-0000bbbb" }, { on: true, reader: "Example tool" }, { on: true, reader: 5 }, { on: true, reader: "p-0000aaaa" }]) {
      expect(await serve(person, as("mac"), "POST", "/v1/agents/address", body as Json), JSON.stringify(body)).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    }
    expect([asked.address, asked.keys]).toEqual([[], []]);
  });

  it("turns the address on for a key from the Mac alone, for a key that stands, and asks the home with its reader", async () => {
    const { person, asked } = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    expect((await serve(person, as("mac"), "POST", "/v1/agents/address", { on: true, reader: "p-0000bbbb" })).body).toMatchObject({ state: "on" });
    expect(await serve(person, as("phone"), "POST", "/v1/agents/address", { on: true, reader: "p-0000bbbb" }), "a key on the Mac is turned on from the Mac").toMatchObject({ status: 403, body: { code: "PERSON_ONLY" } });
    expect(await serve(person, as("mac"), "POST", "/v1/agents/address", { on: true, reader: "p-0000eeee" }), "a disconnected key").toMatchObject({ status: 404, body: { code: "AGENT_UNKNOWN" } });
    expect((await serve(person, as("phone"), "POST", "/v1/agents/address", { on: true })).status).toBe(200);
    expect(asked.address).toEqual([{ reader: "p-0000bbbb" }, { reader: null }]);
  });

  it("are the canned replies both apps read: the address on, off and each kind of fix, each key, and their refusals", async () => {
    for (const reply of await guideDoorReplies()) {
      const fixture = clientFixture(`agents/guide-door/${reply.name}`, reply.written);
      expect(fixture.held, `homelink/Tests/Fixtures/agents/guide-door/${reply.name}.json is this answer: LIFESTREAM_FIXTURES=write writes it`).toBe(fixture.written);
    }
  });

  it("drafts a key's access with no reader and no version, named for its app", async () => {
    const { person } = routes({ state: "on", origin: ORIGIN, why: null, open: null });
    const access = defaultAccess() as unknown as Json;
    const drawn = await serve(person, as("phone"), "POST", "/v1/agents/edit", { target: { key: "grok-bot" }, access, expect: null, edit: { type: "health", on: true } as unknown as Json });
    expect(drawn.status).toBe(200);
    expect(drawn.body).toMatchObject({ expect: null, narrowed: null, saved: null, view: { sentence: expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining("Grok Bot") })]) } });
    expect(drawn.body.access).not.toEqual(defaultAccess());
    expect(await serve(person, as("mac"), "POST", "/v1/agents/edit", { target: { key: "instinct" }, access, expect: 1, edit: null })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await serve(person, as("mac"), "POST", "/v1/agents/edit", { target: { key: "claude" }, access, expect: null, edit: null })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
  });
});

describe("a history page", () => {
  it("puts a change between two calls of one session inline, one outside a session in its own group, and counts a session whole across pages", () => {
    const calls = [call(7, 2, NOW), call(6, 2, NOW - MINUTE), call(5, 2, NOW - 2 * MINUTE), call(4, 1, NOW - HOUR), call(3, 1, NOW - HOUR - MINUTE), call(2, 1, NOW - HOUR - 2 * MINUTE)];
    const changes = [change(9, NOW - 30_000), change(8, NOW - 2 * HOUR, "granted")];
    const first = pageOf(held(calls, changes, 2), { call: null, change: null, carry: null }, 6, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(first.sessions.map((each) => [each.key, each.calls, each.lines.length])).toEqual([["s-2", 3, 4], ["s-1", 4, 2]]);
    expect(first.sessions[0]!.lines[1]).toMatchObject({ kind: "change", words: "You narrowed what Hermes sees", line: "You, on iPhone · Everything but Health and Money · details hidden" });
    expect(first.next?.words).toBe("Show earlier");
    const before = JSON.parse(Buffer.from(first.next!.before, "base64url").toString("utf8")) as { call: number; change: number; carry: { session: number; calls: number } };
    expect(before).toMatchObject({ call: 3, change: 9, carry: { session: 1, calls: 2 } });
    const second = pageOf(held([call(2, 1, NOW - HOUR - 2 * MINUTE), call(1, 1, NOW - HOUR - 3 * MINUTE)], [change(8, NOW - 2 * HOUR, "granted")]), before as never, 6, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(second.sessions.map((each) => [each.key, each.calls])).toEqual([["s-1", 4], ["c-8", 0]]);
    expect(second.next).toBeNull();
  });

  it("folds a long run of a session into one line the home words, its reads inside it, and keeps a change between two runs in sight", () => {
    const calls = Array.from({ length: 14 }, (_, n) => ({ ...call(14 - n, 1, NOW - n * MINUTE), ...(n % 3 === 2 ? { tool: "read", sent: { from: "2026-11-13", to: "2026-11-13" } } : {}) }));
    const page = pageOf(held(calls, [change(20, NOW - 8 * MINUTE - 30_000)]), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    const lines = page.sessions[0]!.lines;
    expect(page.sessions[0]).toMatchObject({ calls: 14, reads: "14 reads" });
    expect(lines.map((each) => each.kind)).toEqual(["call", "call", "call", "call", "call", "fold", "change", "fold"]);
    expect(lines[0]).toMatchObject({ words: "Searched for “q14”", line: "1 email", took_ms: 5 });
    expect(lines[5]).toMatchObject({ kind: "fold", n: 4, icon: "more", words: "4 more reads", line: "Read your day 2 · Searched for 2" });
    expect(lines[7]).toMatchObject({ kind: "fold", n: 5, words: "5 more reads", line: "Searched for 4 · Read your day 1" });
    expect((lines[7] as { lines: unknown[] }).lines).toHaveLength(5);
    const short = pageOf(held(calls.slice(0, 8), []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(short.sessions[0]!.lines.every((each) => each.kind === "call"), "a short session folds nothing").toBe(true);
  });

  it("folds a long session once: its first page draws the head and opens the fold, a later page continues it with the whole run's tally", () => {
    const calls = Array.from({ length: 20 }, (_, n) => {
      const each = call(20 - n, 1, NOW - n * MINUTE);
      return n % 4 === 1 ? { ...each, tool: "read", sent: { ref: ["r1"] } } : n % 4 === 3 ? { ...each, tool: "read", sent: { ref: ["r1", "r2"] } } : each;
    });
    const first = pageOf(held(calls.slice(0, 13), [], 8), { call: null, change: null, carry: null }, 12, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(first.sessions.map((each) => [each.key, each.calls, each.reads])).toEqual([["s-1", 20, "20 reads"]]);
    const opened = first.sessions[0]!.lines;
    expect(opened.map((each) => each.kind)).toEqual(["call", "call", "call", "call", "call", "fold"]);
    expect(opened[5], "an act ending in a number tallies by its kind").toMatchObject({ kind: "fold", n: 7, words: "7 more reads", line: "Read things 4 · Searched for 3", continues: false });
    const second = pageOf(held(calls.slice(12), []), JSON.parse(Buffer.from(first.next!.before, "base64url").toString("utf8")) as Cursor, 12, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(second.sessions.map((each) => [each.key, each.calls])).toEqual([["s-1", 20]]);
    expect(second.sessions[0]!.lines, "no second head: the run goes on").toHaveLength(1);
    expect(second.sessions[0]!.lines[0]).toMatchObject({ kind: "fold", n: 15, words: "15 more reads", line: "Read things 8 · Searched for 7", continues: true });
    expect((second.sessions[0]!.lines[0] as { lines: unknown[] }).lines, "the lines of this page alone").toHaveLength(8);
  });

  it("carries a long run's tally in a cursor the dashboard takes, whatever kinds of call the run holds", () => {
    const kinds: { tool: string; sent: Json }[] = [
      { tool: "search", sent: { query: "q" } }, { tool: "search", sent: { chat: "chat-1" } }, { tool: "search", sent: {} },
      { tool: "read", sent: { from: "2026-11-13", to: "2026-11-13" } }, { tool: "read", sent: { from: "2026-11-12", to: "2026-11-13" } },
      { tool: "read", sent: {} }, { tool: "read", sent: { ref: "r1", history: true } }, { tool: "read", sent: { ref: ["r1", "r2"] } }, { tool: "read", sent: { chat: "chat-1" } },
      { tool: "search_people", sent: { name: "Person 3" } }, { tool: "search_people", sent: { id: "person-3" } }, { tool: "search_people", sent: {} },
      { tool: "count", sent: { of: "runs" } }, { tool: "feedback", sent: {} },
      { tool: "access", sent: {} }, { tool: "access", sent: { request: { read: { category: "health" } } } }, { tool: "access", sent: { drop: 1 } },
      { tool: "access", sent: { drop: "everything" } }, { tool: "access", sent: { drop: "request" } }, { tool: "describe", sent: {} },
    ];
    const calls = Array.from({ length: 600 }, (_, n) => ({ ...call(600 - n, 1, NOW - n * 1000), ...kinds[n % kinds.length]! }));
    const first = pageOf(held(calls.slice(0, 501), [], 99), { call: null, change: null, carry: null }, 500, WORDS, label, SESSION_DAY, HISTORY_READER);
    const before = first.next!.before;
    expect(before, "within the dashboard's cap on a cursor, every kind of call in the run").toMatch(/^[A-Za-z0-9._:~-]{1,512}$/u);
    const second = pageOf(held(calls.slice(500), []), JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as Cursor, 500, WORDS, label, SESSION_DAY, HISTORY_READER);
    const continued = second.sessions[0]!.lines[0]!;
    expect(continued, "the whole run's tally, each kind of call counted once per call").toMatchObject({
      kind: "fold", continues: true, n: 595, words: "595 more reads", line: "Read more 30 · Read a thing’s versions 30 · Read things 30",
    });
  });

  it("puts a session that crosses midnight on the day of its last read, and counts its reads only", () => {
    const midnight = Date.UTC(2026, 10, 14);
    const calls = [call(3, 1, midnight + 5 * MINUTE), { ...call(2, 1, midnight - 5 * MINUTE), result: "refused" as const }, call(1, 1, midnight - 10 * MINUTE)];
    const page = pageOf(held(calls, []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(page.sessions.map((each) => [each.day.day, each.calls, each.reads, each.lines.length])).toEqual([["2026-11-14", 2, "2 reads", 3]]);
  });

  it("joins a search's later pages into its one row: the pages' kinds summed, more counted, the session's reads one", () => {
    const search = (seq: number, at_ms: number, cursor: string | null, came: Record<string, number>): ReaderCall => ({
      ...call(seq, 1, at_ms), read: { query: "running shoes", ...(cursor === null ? {} : { cursor, limit: 20 }) }, sent: cursor === null ? { query: "running shoes" } : { cursor }, came,
    });
    const calls = [search(4, NOW, "c3", { mail: 2 }), search(3, NOW - MINUTE, "c2", { messages: 3 }), search(2, NOW - 2 * MINUTE, "c1", { messages: 5 }), search(1, NOW - 3 * MINUTE, null, { messages: 10 })];
    const page = pageOf(held(calls, []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(page.sessions.map((each) => [each.calls, each.reads])).toEqual([[1, "1 read"]]);
    expect(page.sessions[0]!.lines).toEqual([expect.objectContaining({ kind: "call", id: calls[3]!.id, words: "Searched for “running shoes”", line: "20 things: 18 messages, 2 emails", more: 3 })]);
    const again = [{ ...search(5, NOW + MINUTE, null, { mail: 1 }) }, ...calls];
    expect(pageOf(held(again, []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER).sessions[0]!.lines.map((line) => line.kind === "call" ? line.more : null),
      "the same question asked anew is a read of its own").toEqual([0, 3]);
  });

  it("folds reads of one question, each its own session on one day, into one repeat", () => {
    const day = (seq: number, at_ms: number): ReaderCall => ({ ...call(seq, seq, at_ms), tool: "read", sent: { from: "2026-11-14", to: "2026-11-14" }, came: { messages: 8, plans: 9 } });
    const calls = [day(4, NOW + 3 * HOUR), day(3, NOW + 2 * HOUR), day(2, NOW + HOUR), day(1, NOW)];
    const page = pageOf(held(calls, []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(page.sessions.map((each) => [each.key, each.calls, each.reads])).toEqual([["s-4", 4, "4 reads"]]);
    expect(page.sessions[0]!.lines).toEqual([expect.objectContaining({ kind: "fold", n: 4, icon: "sync", words: "Read your day, every hour", line: "4 times, 09:00 – 12:00 · 17 things each: events, messages" })]);
    const lined = (reads: ReaderCall[]) => pageOf(held(reads, []), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER).sessions.flatMap((each) => each.lines.map((line) => [line.kind, line.kind === "fold" ? line.n : 1]));
    expect(lined(calls.slice(1)), "three in a row are one fold").toEqual([["fold", 3]]);
    expect(lined(calls.slice(2)), "two are two rows").toEqual([["call", 1], ["call", 1]]);
  });

  it("gives a reader with no calls a history of its changes, each a group of its own", () => {
    const page = pageOf(held([], [change(2, NOW), change(1, NOW - HOUR, "granted")]), { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER);
    expect(page.sessions.map((each) => [each.key, each.calls, each.lines[0]!.kind])).toEqual([["c-2", 0, "change"], ["c-1", 0, "change"]]);
  });
});

describe("a want allowed", () => {
  const existing = [{ account: "whatsapp:15550000001", category: "messages" as const }, { account: "whatsapp:15550000002", category: "messages" as const }, { account: "gmail:person-a@example.com", category: "mail" as const }];
  const base: Access = { ...defaultAccess(), hide: "all", window: { past_ms: 30 * 24 * HOUR } };

  it("adds one allow per account of the product on the home, for its duration from the write, keeping every other line", () => {
    const after = allowWant(base, { read: { product: "whatsapp" }, window: null }, HOUR, existing);
    expect(after.allow.slice(1)).toEqual([
      { reach: { account: "whatsapp:15550000001", but: [] }, window: null, lasts_ms: HOUR },
      { reach: { account: "whatsapp:15550000002", but: [] }, window: null, lasts_ms: HOUR },
    ]);
    expect(allowWant(base, { read: { category: "mail" }, window: null }, null, existing).allow.at(-1)).toEqual({ reach: { type: "mail", but: [] }, window: null, until_ms: null });
    expect({ ...after, allow: base.allow }).toEqual(base);
  });
});

describe("a narrowing's line", () => {
  it("says the part that changed, as it is now", () => {
    const access: Access = { ...defaultAccess() };
    expect(plainOf(narrowedWords("Instinct", access, { ...access, window: { past_ms: 24 * HOUR } }, WORDS))).toBe("Saved. Instinct now sees the past 24 hours.");
    expect(plainOf(narrowedWords("Hermes", access, { ...access, allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }] }, WORDS))).toBe("Saved. Hermes now sees only Mail.");
    expect(plainOf(narrowedWords("Claude", access, { ...access, hide: "all" }, WORDS))).toBe("Saved. Claude now hides names and details.");
    expect(plainOf(narrowedWords("Claude", access, { ...access, allow: [] }, WORDS))).toBe("Saved. Claude now sees nothing.");
  });

  it("says a changed grant with its own limits", () => {
    const mail = (past_ms: number): Access => ({ ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window: { past_ms }, until_ms: null }] });
    expect(plainOf(narrowedWords("Hermes", mail(30 * 24 * HOUR), mail(24 * HOUR), WORDS, { now_ms: NOW }))).toBe("Saved. Hermes now sees only Mail from the past 24 hours.");
  });
});


const READER = "p-0000bbbb";
const EXISTING = [{ account: "gmail:person-a@example.com", category: "mail" as const }];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ledgerAt(moved = true): { ledger: Ledger; path: string } {
  const root = mkdtempSync(join(tmpdir(), "home-access-routes-"));
  roots.push(root);
  const path = join(root, "replies", "replies.db");
  const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
  if (moved) ledger.access.move([], NOW - 3 * HOUR);
  return { ledger, path };
}

function raw(path: string, statement: string): void {
  const db = new Database(path);
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

const person = (at_ms: number) => ({ at_ms, by: "person" as const, device: "p-phone001" });
const NARROW: Access = { ...defaultAccess(), window: { past_ms: 24 * HOUR } };
const WIDE: Access = { ...NARROW, allow: [...NARROW.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };

function propose(ledger: Ledger, access: Access, expected: number, now_ms = NOW, reader = READER): Proposed {
  return personIn(ledger, { propose: { reader, access, expect: expected, by: "chat", device: null, existing: EXISTING, now_ms } }) as Proposed;
}
function history(ledger: Ledger, cursor: Cursor, limit = HISTORY_PAGE): { held: HeldHistory; page: ReturnType<typeof pageOf> } {
  const held = personIn(ledger, { history: { reader: READER, cursor, limit, day: DAY, kind: null, now_ms: NOW } }) as HeldHistory;
  return { held, page: pageOf(held, cursor, limit, WORDS, label, SESSION_DAY, HISTORY_READER) };
}
function cursorIn(page: Pick<HistoryPage, "next">): Cursor {
  return JSON.parse(Buffer.from(page.next!.before, "base64url").toString("utf8")) as Cursor;
}
function called(ledger: Ledger, at_ms: number, reaches?: (lines: Json) => readonly string[]): void {
  const begun = ledger.access.begin({ reader: READER, tool: "search", sent: { query: "dinner" }, read: null, at_ms, ...(reaches === undefined ? {} : { reaches }) });
  ledger.access.end(begun.id, { result: "answered", words: null, ms: 5, withheld: [] });
}

describe("Chat's proposal sent again", () => {
  it("answers the narrowing that made the access and the access before it, though a request's row stands at its version since", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW));
      const first = propose(ledger, NARROW, 1);
      expect([first.change?.what, first.before, first.version]).toEqual(["narrowed", defaultAccess(), 2]);
      expect(propose(ledger, WIDE, 2, NOW + 1).request?.state).toBe("open");
      const again = propose(ledger, NARROW, 1, NOW + 2);
      expect([again.change?.seq, again.change?.what, again.before, again.version]).toEqual([first.change!.seq, "narrowed", defaultAccess(), 2]);
    } finally {
      ledger.close();
    }
  });

  it("skips a source that joined since, and Undo is made from the version now", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW));
      const first = propose(ledger, NARROW, 1);
      called(ledger, NOW + 1, () => ["whatsapp:15550000001"]);
      expect(ledger.access.changes(READER, { limit: 1 })[0]).toMatchObject({ what: "joined", version: 3 });
      const again = propose(ledger, NARROW, 1, NOW + 2);
      expect([again.change?.seq, again.before, again.version]).toEqual([first.change!.seq, defaultAccess(), 3]);
    } finally {
      ledger.close();
    }
  });

  it("answers no change when the access proposed is the one saved but no narrowing made it, and writes nothing", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: WIDE as never, covers: [] }, person(NOW));
      ledger.access.remove(READER, 1, person(NOW + 1));
      ledger.access.change(READER, { from: 0, what: "granted", lines: NARROW as never, covers: [] }, person(NOW + 2));
      const rows = ledger.access.changes(READER, { limit: 10 }).length;
      expect(propose(ledger, NARROW, 0, NOW + 3)).toEqual({ change: null, request: null, before: null, version: 3 });
      expect(propose(ledger, emptyAccess(), 0, NOW + 3, "p-0000cccc")).toEqual({ change: null, request: null, before: null, version: 0 });
      expect([ledger.access.changes(READER, { limit: 10 }).length, ledger.access.get(READER)?.version, ledger.access.get("p-0000cccc")]).toEqual([rows, 3, undefined]);
    } finally {
      ledger.close();
    }
  });

  it("answers no change when the person's own narrowing made the access Chat proposes as it is", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW));
      ledger.access.change(READER, { from: 1, what: "narrowed", lines: NARROW as never, covers: [] }, person(NOW + 1));
      expect(propose(ledger, NARROW, 2, NOW + 2)).toEqual({ change: null, request: null, before: null, version: 2 });
    } finally {
      ledger.close();
    }
  });

  it("answers the request the person allowed when Chat sends its widening again after the answer", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: NARROW as never, covers: [] }, person(NOW));
      const asked = propose(ledger, WIDE, 1).request!;
      personIn(ledger, { answer: { id: asked.id, answer: "always", expect: 1, access: null, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW + 1 } });
      const again = propose(ledger, WIDE, 2, NOW + 2);
      expect([again.change, again.request?.id, again.request?.state, again.version]).toEqual([null, asked.id, "allowed", 2]);
      expect(ledger.access.get(READER)?.version).toBe(2);
    } finally {
      ledger.close();
    }
  });
});

function refusalOf(work: () => unknown): [number, string] | null {
  try {
    work();
    return null;
  } catch (error) {
    if (error instanceof Refusal) return [error.status, error.code];
    throw error;
  }
}

describe("a write before the move", () => {
  it("is refused by its own code, and writes nothing; a read still answers", () => {
    const { ledger } = ledgerAt(false);
    try {
      const writes: PersonWriting[] = [
        { save: { reader: READER, access: NARROW, expect: 0, widen: true, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW } },
        { propose: { reader: READER, access: NARROW, expect: 0, by: "chat", device: null, existing: EXISTING, now_ms: NOW } },
        { narrow: { reader: READER, access: NARROW, expect: 0, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW } },
        { answer: { id: "rq-0000000000000000", answer: "no", expect: null, access: null, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW } },
      ];
      for (const each of writes) expect(refusalOf(() => personIn(ledger, each)), Object.keys(each)[0]).toEqual([409, ACCESS_NOT_STARTED]);
      expect([ledger.access.all(), ledger.access.changes(READER, { limit: 1 }), ledger.access.requests(READER, NOW)]).toEqual([[], [], []]);
      expect(personIn(ledger, { reader: { reader: READER, now_ms: NOW } })).toEqual({ access: undefined, own: undefined, own_until: null, open: undefined, tally: null, kinds: null, today: null, last: null });
    } finally {
      ledger.close();
    }
  });
});

describe("today's chips", () => {
  it("count the reads that saw each kind, never the things they saw", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.end(ledger.access.begin({ reader: READER, tool: "search", sent: {}, read: null, at_ms: NOW - MINUTE }).id, { result: "answered", words: null, ms: 1, withheld: [], came: { messages: 40, mail: 2 } });
      const held = personIn(ledger, { reader: { reader: READER, now_ms: NOW, tally: { days: [NOW - HOUR], kinds_ms: null, today_ms: NOW - HOUR } } }) as { today: Record<string, number> };
      expect(held.today).toEqual({ messages: 1, mail: 1 });
    } finally {
      ledger.close();
    }
  });
});

describe("an agent's reads, counted from its calls", () => {
  it("tallies each day from its start, all since the first and the last, reads only: never a refused, failed or unfinished call, nor access or feedback", () => {
    const { ledger } = ledgerAt();
    try {
      const call = (at_ms: number, tool = "search", result: "answered" | "refused" | "failed" | null = "answered") => {
        const begun = ledger.access.begin({ reader: READER, tool, sent: {}, read: null, at_ms });
        if (result !== null) ledger.access.end(begun.id, { result, words: null, ms: 1, withheld: [] });
      };
      const at = [NOW - 9 * 24 * HOUR, NOW - 2 * 24 * HOUR, NOW - 2 * 24 * HOUR + MINUTE, NOW - HOUR, NOW];
      for (const at_ms of at) call(at_ms);
      call(NOW + MINUTE, "search", "refused");
      call(NOW + MINUTE, "read", "failed");
      call(NOW + MINUTE, "read", null);
      call(NOW + MINUTE, "access");
      call(NOW + MINUTE, "feedback");
      ledger.access.begin({ reader: "p-0000cccc", tool: "search", sent: {}, read: null, at_ms: NOW });
      const days = [3, 2, 1, 0].map((back) => Date.UTC(2026, 10, 14 - back));
      expect(ledger.access.tally(READER, days)).toEqual({ total: 5, first_ms: at[0], last_ms: NOW, within: [0, 2, 0, 2] });
      expect(ledger.access.tally("p-0000dddd", days)).toEqual({ total: 0, first_ms: null, last_ms: null, within: [0, 0, 0, 0] });
    } finally {
      ledger.close();
    }
  });

  it("counts the reads in a window by each kind that came back, from each read's own count, and nothing of a read older than the window", () => {
    const { ledger } = ledgerAt();
    try {
      const read = (at_ms: number, came: Record<string, number>, result: "answered" | "refused" = "answered") =>
        ledger.access.end(ledger.access.begin({ reader: READER, tool: "read", sent: {}, read: null, at_ms }).id, { result, words: null, ms: 1, withheld: [], came });
      read(NOW - 40 * 24 * HOUR, { mail: 2 });
      read(NOW - HOUR, { mail: 2, messages: 1 });
      read(NOW, { messages: 4, line: 1 });
      read(NOW, { health: 1 }, "refused");
      expect(ledger.access.kinds(READER, NOW - 30 * 24 * HOUR)).toEqual({ mail: 1, messages: 2, line: 1 });
      ledger.access.end(ledger.access.begin({ reader: READER, tool: "read", sent: {}, read: null, at_ms: NOW - 2 * HOUR }).id, { result: "answered", words: null, ms: 1, withheld: [] });
      expect(ledger.access.kinds(READER, NOW - 30 * 24 * HOUR), "a read in the window with no kinds kept: no count claimed").toBeNull();
      expect(ledger.access.kinds(READER, NOW - HOUR)).toEqual({ mail: 1, messages: 2, line: 1 });
    } finally {
      ledger.close();
    }
  });
});

describe("what came back, by the person's kinds", () => {
  const MAIL = "gmail:person-a@example.com";
  const CHATS = "whatsapp:15550000001";
  const ACCOUNTS = [{ account: MAIL, category: "mail" as const }, { account: CHATS, category: "messages" as const }];
  const message = (key: string) => makeRef("record", { source: `${CHATS}:iphone-aa01`, kind: "msg", key });
  const line = (m: number, family: string) => ({ ref: makeRef("line", { day: "2026-11-13", same: "0123456789abcdef", m, unit: `u-${m}`, item: null }), family, text: "a line" });
  const conversation = (key: string) => makeRef("chat", { key });

  it("counts a search's hits once each, by their own kind: messages in conversations are Messages, an atoms-layer hit the kind of its family, never a conversation, a person or a place named beside them", () => {
    const answer = {
      person: [{ asked: "Ada", name: "Ada", ref: makeRef("person", { handle: "15550000002" }) }],
      record: { total: 15, hits: [
        ...Array.from({ length: 12 }, (_, n) => ({ ref: message(`m-${n}`), family: "messages", chat: conversation(`c-${n % 3}`) })),
        { ...line(1, "mail"), chat: conversation("c-0") }, line(2, "calendar"), line(3, "physical"),
      ] },
      goto: { people: [{ ref: makeRef("person", { handle: "15550000003" }), name: "Ada" }], places: [{ ref: makeRef("place", { id: "cafe" }), name: "A cafe" }], day: null, month: null },
    };
    expect(cameOf("search", answer, ACCOUNTS)).toEqual({ messages: 12, mail: 1, plans: 1, line: 1 });
  });

  it("counts a day read for the kinds its lines came from, and the asked ref of a line read as nothing", () => {
    const day = { what: "lines", span: { from: "2026-11-13", to: "2026-11-13" }, lines: [line(1, "mail"), line(2, "mail"), line(3, "messages"), { text: "a line with no ref" }] };
    expect(cameOf("read", day, ACCOUNTS)).toEqual({ mail: 2, messages: 1 });
    const opened = { what: "line", ref: line(9, "mail").ref, day: "2026-11-13", rev: "r1", lines: [line(4, "messages")] };
    expect(cameOf("read", opened, ACCOUNTS)).toEqual({ messages: 1 });
  });
});

describe("Chat's open proposal, once the access moves on", () => {
  it("is closed by any new version of its reader's access, so it never waits unanswerable", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: NARROW as never, covers: [] }, person(NOW));
      const asked = propose(ledger, WIDE, 1).request!;
      expect(personIn(ledger, { waiting: { readers: [READER], now_ms: NOW } })).toHaveLength(1);
      personIn(ledger, { narrow: { reader: READER, access: { ...NARROW, hide: "all" }, expect: 1, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW + 1 } });
      expect(ledger.access.request(asked.id, NOW + 2)?.state).toBe("replaced");
      expect(ledger.access.changes(READER, { limit: 2 }), "History gives the proposal its ending").toMatchObject([{ what: "replaced", request: asked.id, by: "person", about: { changed: true } }, { what: "narrowed" }]);
      expect(personIn(ledger, { waiting: { readers: [READER], now_ms: NOW + 2 } })).toEqual([]);
      const answered = personIn(ledger, { answer: { id: asked.id, answer: "always", expect: 1, access: null, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW + 3 } }) as { request: AccessRequest };
      expect([answered.request.state, ledger.access.get(READER)?.version], "Allow on a closed card writes nothing and is not refused").toEqual(["replaced", 2]);
    } finally {
      ledger.close();
    }
  });
});

describe("the list's Disconnected", () => {
  it("holds an agent the person disconnected or the home disconnected after it read, never one the home refused before it read or one taken off the list, and tallies only those it lists", () => {
    const { ledger } = ledgerAt();
    try {
      for (const reader of [READER, "p-0000cccc", "p-0000dddd", "p-0000eeee"]) ledger.access.change(reader, { from: 0, what: "granted", lines: NARROW as never, covers: [] }, person(NOW));
      ledger.access.remove(READER, 1, person(NOW + 1));
      ledger.access.change("p-0000aaaa", { from: 0, what: "granted", lines: NARROW as never, covers: [] }, person(NOW));
      ledger.access.end(ledger.access.begin({ reader: "p-0000aaaa", tool: "search", sent: {}, read: null, at_ms: NOW }).id, { result: "answered", words: null, ms: 1, withheld: [], came: {} });
      ledger.access.remove("p-0000aaaa", 1, { at_ms: NOW + 1, by: "home", device: null });
      ledger.access.remove("p-0000cccc", 1, { at_ms: NOW + 1, by: "home", device: null });
      ledger.access.remove("p-0000dddd", 1, person(NOW + 1));
      ledger.access.unlist("p-0000dddd", NOW + 2);
      const held = personIn(ledger, { list: { connected: ["p-0000eeee"], disconnected: [READER, "p-0000aaaa", "p-0000cccc", "p-0000dddd", "p-0000ffff"], now_ms: NOW + 3, tally: { days: [NOW], kinds_ms: null } } });
      expect(Object.keys(held as object).sort(), "an agent removed before the ledger kept a row is listed, and one the home disconnected after it read").toEqual(["p-0000aaaa", "p-0000bbbb", "p-0000eeee", "p-0000ffff"]);
    } finally {
      ledger.close();
    }
  });
});

describe("one road for a narrowing, the person's and Chat's", () => {
  it("writes a narrowing at the version it was drawn from, answers what was before, and never writes a widening", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW));
      const narrow = (access: Access, expect: number) => personIn(ledger, { narrow: { reader: READER, access, expect, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW } });
      expect(narrow(fullAccess("names"), 1), "a widening is not a narrowing: nothing written").toBeNull();
      expect(ledger.access.get(READER)?.version).toBe(1);
      expect(narrow(NARROW, 1)).toEqual({ before: defaultAccess(), version: 2 });
      expect(ledger.access.changes(READER, { limit: 1 })[0]).toMatchObject({ what: "narrowed", by: "person", device: "p-phone001", version: 2 });
      expect(refusalOf(() => narrow({ ...NARROW, hide: "all" }, 1)), "drawn from a version since changed").toEqual([409, "ACCESS_CHANGED"]);
    } finally {
      ledger.close();
    }
  });
});

describe("a request whose want an erasure cleared", () => {
  function erased(): { ledger: Ledger; id: string } {
    const { ledger, path } = ledgerAt();
    ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW));
    const asked = ledger.access.ask(READER, { from: 1, want: { read: { account: "gmail:person-a@example.com" }, window: null }, want_key: "sha256:want", reason: "the mail", for_ms: HOUR }, { at_ms: NOW, by: "agent", device: null });
    raw(path, `UPDATE access_requests SET want = NULL, want_key = NULL WHERE id = '${asked.id}'`);
    return { ledger, id: asked.id };
  }
  const answer = (ledger: Ledger, id: string, said: "no" | "always"): PersonWriting => ({
    answer: { id, answer: said, expect: said === "no" ? null : 1, access: null, by: "person", device: "p-phone001", existing: EXISTING, now_ms: NOW + 1 },
  });

  it("is dismissed by No", () => {
    const { ledger, id } = erased();
    try {
      expect((personIn(ledger, answer(ledger, id, "no")) as { request: AccessRequest }).request.state).toBe("declined");
      expect(ledger.access.get(READER)?.version).toBe(1);
    } finally {
      ledger.close();
    }
  });

  it("refuses an approval by its own code, and writes nothing", () => {
    const { ledger, id } = erased();
    try {
      expect(refusalOf(() => personIn(ledger, answer(ledger, id, "always")))).toEqual([409, "AGENT_REQUEST_ERASED"]);
      expect(ledger.access.request(id, NOW + 1)?.state).toBe("open");
    } finally {
      ledger.close();
    }
  });
});

describe("an ask answered Once", () => {
  const LATER = NOW + 3 * HOUR;
  function asked(want: Json, for_ms: number | null): { ledger: Ledger; id: string } {
    const { ledger } = ledgerAt();
    ledger.access.change(READER, { from: 0, what: "granted", lines: emptyAccess() as never, covers: [] }, person(NOW));
    const request = ledger.access.ask(READER, { from: 1, want, want_key: `sha256:${canonical(want)}`, reason: "", for_ms }, { at_ms: NOW, by: "agent", device: null });
    return { ledger, id: request.id };
  }
  const once = (id: string, access: DraftAccess | null = null): PersonWriting => ({
    answer: { id, answer: "once", expect: 1, access, by: "person", device: "p-phone001", existing: EXISTING, now_ms: LATER },
  });

  it("grants a read with no `for` for its hour, from the answer", () => {
    const want = { read: { category: "mail" }, window: null };
    const { ledger, id } = asked(want as unknown as Json, null);
    try {
      personIn(ledger, once(id));
      const lines = ledger.access.get(READER)!.lines as unknown as Access;
      expect(lines.allow.map((each) => each.until_ms)).toEqual([LATER + HOUR]);
    } finally {
      ledger.close();
    }
  });

  it("starts the duration of the proposal at the answer, and keeps an end the person chose", () => {
    const want = { read: { account: "gmail:person-a@example.com" }, window: null };
    const { ledger, id } = asked(want as unknown as Json, 2 * HOUR);
    try {
      const drawn = allowWant(emptyAccess(), want, 2 * HOUR, EXISTING);
      const chosen = { reach: { type: "mail" as const, but: [] }, window: null, until_ms: NOW + 30 * MINUTE + 4 * HOUR };
      personIn(ledger, once(id, { ...drawn, allow: [...drawn.allow, chosen] }));
      expect((ledger.access.get(READER)!.lines as unknown as Access).allow.map((each) => each.until_ms)).toEqual([LATER + 2 * HOUR, chosen.until_ms]);
    } finally {
      ledger.close();
    }
  });

  it("names the grant's end though the person's draft also changed a line with no end, and no end for an Always", () => {
    const want = { read: { account: "gmail:person-a@example.com" }, window: null };
    const had: Access = { ...emptyAccess(), allow: [{ reach: { type: "notes", but: [] }, window: null, until_ms: null }] };
    const proposal = allowWant(had, want, 2 * HOUR, EXISTING);
    const edited: DraftAccess = { ...proposal, allow: proposal.allow.map((each) => ({ ...each, window: { past_ms: 24 * HOUR } })) };
    const endOf = (answer: "once" | "always", draft: DraftAccess | null) => {
      const { ledger } = ledgerAt();
      try {
        ledger.access.change(READER, { from: 0, what: "granted", lines: had as never, covers: [] }, person(NOW));
        const request = ledger.access.ask(READER, { from: 1, want: want as never, want_key: "sha256:mail", reason: "", for_ms: 2 * HOUR }, { at_ms: NOW, by: "agent", device: null });
        const answered = personIn(ledger, { answer: { id: request.id, answer, expect: 1, access: draft, by: "person", device: "p-phone001", existing: EXISTING, now_ms: LATER } }) as { until_ms: number | null };
        const own = personIn(ledger, { reader: { reader: READER, now_ms: LATER + 3 * HOUR } }) as { own_until: number | null };
        return [answered.until_ms, own.own_until];
      } finally {
        ledger.close();
      }
    };
    expect(endOf("once", edited)).toEqual([LATER + 2 * HOUR, LATER + 2 * HOUR]);
    expect(endOf("once", null)).toEqual([LATER + 2 * HOUR, LATER + 2 * HOUR]);
    expect(endOf("always", null)).toEqual([null, null]);
  });

  it("writes the request's grant at the answer plus its duration, a grant the person had ending there kept, by Once, Always and an edited draft alike", () => {
    const want = { read: { account: "gmail:person-a@example.com" }, window: null };
    const had: Access = { ...emptyAccess(), allow: [{ reach: { type: "notes", but: [] }, window: null, until_ms: LATER + 2 * HOUR }] };
    const proposal = allowWant(had, want, 2 * HOUR, EXISTING);
    const edited: DraftAccess = { ...proposal, allow: proposal.allow.map((each) => ({ ...each, window: { past_ms: 24 * HOUR } })) };
    const written = (answer: "once" | "always", draft: DraftAccess | null) => {
      const { ledger } = ledgerAt();
      try {
        ledger.access.change(READER, { from: 0, what: "granted", lines: had as never, covers: [] }, person(NOW));
        const request = ledger.access.ask(READER, { from: 1, want: want as never, want_key: "sha256:mail", reason: "", for_ms: 2 * HOUR }, { at_ms: NOW, by: "agent", device: null });
        personIn(ledger, { answer: { id: request.id, answer, expect: 1, access: draft, by: "person", device: "p-phone001", existing: EXISTING, now_ms: LATER } });
        return ledger.access.get(READER)!.lines as unknown as Access;
      } finally {
        ledger.close();
      }
    };
    const lines = written("once", null);
    expect(lines.allow).toEqual([had.allow[0], { reach: { account: "gmail:person-a@example.com", but: [] }, window: null, until_ms: LATER + 2 * HOUR }]);
    expect(written("once", proposal), "Once with the proposal").toEqual(lines);
    expect(written("always", proposal), "Always with the proposal: the draft sent").toEqual(lines);
    expect(written("once", edited), "an edited draft").toEqual({ ...lines, allow: lines.allow.map((each) => ({ ...each, window: { past_ms: 24 * HOUR } })) });
    expect(written("always", null).allow.at(-1)).toEqual({ reach: { account: "gmail:person-a@example.com", but: [] }, window: null, until_ms: null });
  });
});

describe("a history read from the ledger", () => {
  function session(after: number): Ledger {
    const { ledger } = ledgerAt();
    ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW - 2 * HOUR));
    for (let n = 1; n <= 52; n++) {
      called(ledger, NOW + n * MINUTE);
      if (n === after) ledger.access.change(READER, { from: 1, what: "narrowed", lines: NARROW as never, covers: [] }, person(NOW + n * MINUTE + 30_000));
    }
    return ledger;
  }
  const keys = (page: Pick<HistoryPage, "sessions">) => page.sessions.map((each) => [each.key, each.calls, each.lines.map((line) => line.kind).filter((kind) => kind === "change").length]);

  it("counts a session whole when the next page starts with a change inside it, and puts that change inline", () => {
    const ledger = session(2);
    try {
      const first = history(ledger, { call: null, change: null, carry: null });
      expect(keys(first.page)).toEqual([["s-1", 52, 0]]);
      const second = history(ledger, cursorIn(first.page));
      expect(keys(second.page)).toEqual([["s-1", 52, 1], [expect.stringMatching(/^c-/u), 0, 1]]);
    } finally {
      ledger.close();
    }
  });

  it("puts a change at a page's last place inline when the call beyond the page is of its session", () => {
    const ledger = session(3);
    try {
      const first = history(ledger, { call: null, change: null, carry: null });
      expect(first.page.sessions.map((each) => each.key)).toEqual(["s-1"]);
      expect(keys(first.page)).toEqual([["s-1", 52, 1]]);
      const second = history(ledger, cursorIn(first.page));
      expect(keys(second.page)).toEqual([["s-1", 52, 0], [expect.stringMatching(/^c-/u), 0, 1]]);
    } finally {
      ledger.close();
    }
  });

  it("reaches its first row past a reader's newest 100,000, and reads a call's access at its version", () => {
    const { ledger, path } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW - HOUR));
      called(ledger, NOW - HOUR + 1);
      const lines = canonical(defaultAccess() as unknown as Json).replaceAll("'", "''");
      raw(path, `WITH RECURSIVE n(i) AS (SELECT 2 UNION ALL SELECT i + 1 FROM n WHERE i < 100060)
        INSERT INTO access_changes (at_ms, reader, version, what, by, device, request, lines, about) SELECT ${NOW} + i, '${READER}', i, 'joined', 'home', NULL, NULL, '${lines}', '"gmail:person-a@example.com"' FROM n`);
      expect(history(ledger, { call: null, change: null, carry: null }).held.versions).toEqual({ 1: defaultAccess() });
      const oldest = history(ledger, { call: 0, change: 30, carry: null });
      expect(oldest.held.changes.map((each) => each.seq).at(-1)).toBe(1);
      expect(oldest.page.sessions.map((each) => each.key)).toHaveLength(29);
    } finally {
      ledger.close();
    }
  });
});

describe("an agent's last reads and a page of one kind", () => {
  it("are its answered reads alone, by the predicate its count uses; a page of one kind holds only the calls that saw it", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW - HOUR));
      const ended = (tool: string, at_ms: number, result: "answered" | "refused" | "failed" | null, came?: Record<string, number>) => {
        const begun = ledger.access.begin({ reader: READER, tool, sent: { query: `at ${at_ms}` }, read: null, at_ms });
        if (result !== null) ledger.access.end(begun.id, { result, words: null, ms: 5, withheld: [], ...(came === undefined ? {} : { came }) });
      };
      ended("search", NOW + 1, "answered", { mail: 2 });
      ended("read", NOW + 2, "answered", { messages: 1, mail: 1 });
      ended("search", NOW + 3, "answered", {});
      ended("search", NOW + 4, "refused");
      ended("search", NOW + 5, "failed");
      ended("access", NOW + 6, "answered");
      ended("search", NOW + 7, null);
      ended("search", NOW + 8, "refused", { health: 1 });
      const recent = personIn(ledger, { recent: { reader: READER, limit: 3, day: DAY } }) as HeldHistory;
      expect(recent.calls.map((each) => [each.at_ms, each.result]), "never refused, failed, unfinished or the access call").toEqual([[NOW + 3, "answered"], [NOW + 2, "answered"], [NOW + 1, "answered"]]);
      expect(ledger.access.tally(READER, []).total, "the count See all says").toBe(3);
      const mail = personIn(ledger, { history: { reader: READER, cursor: { call: null, change: null, carry: null }, limit: 50, day: DAY, kind: "mail", now_ms: NOW + 9 } }) as HeldHistory;
      expect([mail.calls.map((each) => each.at_ms), mail.changes], "the calls that saw mail, and no change under a filter").toEqual([[NOW + 2, NOW + 1], []]);
    } finally {
      ledger.close();
    }
  });
});

describe("a day's count on its history section", () => {
  it("is the whole day's reads on every page that shows the day, whatever its sittings, its later pages joined, under a filter the kind's", () => {
    const { ledger } = ledgerAt();
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: defaultAccess() as never, covers: [] }, person(NOW - 14 * HOUR));
      const read = (at_ms: number, asked: JsonObject, came: Record<string, number>) =>
        ledger.access.end(ledger.access.begin({ reader: READER, tool: "search", sent: asked, read: asked, at_ms }).id, { result: "answered", words: null, ms: 1, withheld: [], came });
      read(NOW - 12 * HOUR, { query: "yesterday" }, { notes: 1 });
      read(NOW - 7 * HOUR, { query: "dinner" }, { messages: 1 });
      read(NOW - 7 * HOUR + 10 * MINUTE, { query: "lunch" }, { mail: 1 });
      read(NOW - 10 * MINUTE, { query: "shoes" }, { mail: 2 });
      read(NOW - 9 * MINUTE, { query: "shoes", cursor: "c1", limit: 20 }, { mail: 1 });
      const days = (page: Pick<HistoryPage, "sessions">) => page.sessions.map((each) => [each.day.day, each.day.reads]);
      const first = history(ledger, { call: null, change: null, carry: null }, 2);
      expect(days(first.page), "the evening's sitting alone on the page, the day's three reads counted").toEqual([["2026-11-14", "3 reads"]]);
      const second = history(ledger, cursorIn(first.page), 2);
      expect(days(second.page), "the morning's sitting says the same day's count").toEqual([["2026-11-14", "3 reads"]]);
      const mail = personIn(ledger, { history: { reader: READER, cursor: { call: null, change: null, carry: null }, limit: 50, day: DAY, kind: "mail", now_ms: NOW } }) as HeldHistory;
      expect(days(pageOf(mail, { call: null, change: null, carry: null }, 50, WORDS, label, SESSION_DAY, HISTORY_READER)), "under a filter, the day's reads that saw the kind")
        .toEqual([["2026-11-14", "2 reads"], ["2026-11-14", "2 reads"]]);
    } finally {
      ledger.close();
    }
  });
});

describe("the person's routes told apart by what an id is", () => {
  const person = (asked: (writing: PersonWriting) => unknown, signIn: string, answered: (id: string) => SignInAnswer | null = () => null) => openPersonAccess({
    writer: { person: async <T>(writing: PersonWriting) => asked(writing) as T },
    signIns: {
      waiting: async () => ({ requests: [{ id: signIn, name: "Example agent", checked: true, host: null, choices: [], at_ms: NOW, until_ms: NOW + HOUR }] }),
      read: async (id) => ({ answered: answered(id), granted: null }),
      answer: async () => ({ state: "denied", name: "Example agent", at_ms: NOW, device: null, granted: null }),
    },
    offered: async () => [],
    readers: () => [{ id: "ask", name: "Chat", kind: "chat", how: "", via: null, from: null, app: null, anywhere: false, made_ms: 0, disconnected_ms: null, listed: true }],
    disconnect: async () => undefined, address: unasked, key: unasked,
    describe: async () => ({ described: [] }),
    device: () => null,
    clock: () => NOW,
    day: () => DAY,
  });
  const PHONE = { pass: { id: "p-phone001", kind: "phone" }, ask: false, widen: true } as unknown as Asker;
  const get = async (routes: ReturnType<typeof person>, path: string) => {
    try {
      return (await routes.serve(PHONE, { method: "GET" } as IncomingMessage, new URL(`http://home${path}`), async () => ({})))[1];
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, code: error.code, message: error.words };
      throw error;
    }
  };
  const post = async (routes: ReturnType<typeof person>, path: string, body: Json) => {
    try {
      return (await routes.serve(PHONE, { method: "POST" } as IncomingMessage, new URL(`http://home${path}`), async () => body as never))[1];
    } catch (error) {
      if (error instanceof Refusal) return { status: error.status, code: error.code, message: error.words };
      throw error;
    }
  };

  it("draws a sign-in whose id begins as a request's does, never looking for it among the requests", async () => {
    const id = "rq-AbCdEfGhIjKlMnOpQrSt";
    const routes = person((writing) => { throw new Error(`no write is asked of a sign-in's draft: ${Object.keys(writing)[0]}`); }, id);
    const drawn = await post(routes, "/v1/agents/edit", { target: { request: id }, access: defaultAccess() as unknown as Json, expect: null, edit: null });
    expect(drawn).toMatchObject({ access: defaultAccess(), expect: null });
  });

  it("says what became of a sign-in that left the waiting list, in the home's words and on the home's clock: its reader once the other app holds its access, gone once the home holds it no more", async () => {
    const waiting = "AAAAAAAAAAAAAAAAAAAAAA";
    const allowed = "BBBBBBBBBBBBBBBBBBBBBB";
    const denied = "CCCCCCCCCCCCCCCCCCCCCC";
    const connected = "EEEEEEEEEEEEEEEEEEEEEE";
    const approved: SignInAnswer = { state: "approved", name: "Example agent", at_ms: NOW - MINUTE, device: "p-phone001" };
    const held: Record<string, SignInHeld> = {
      [waiting]: { answered: null, granted: null },
      [allowed]: { answered: approved, granted: null },
      [denied]: { answered: { state: "denied", name: "Example agent", at_ms: NOW - MINUTE, device: "p-phone001" }, granted: null },
      [connected]: { answered: approved, granted: { reader: "p-0000dddd", access: defaultAccess() } },
    };
    const routes = openPersonAccess({
      writer: { person: async () => { throw new Error("a sign-in is the home's memory, never the ledger's"); } },
      signIns: {
        waiting: async () => ({ requests: [] }),
        read: async (id) => (Object.hasOwn(held, id) ? held[id]! : refuse(404, "AGENT_REQUEST_GONE", "This sign-in is over. Start it again in the app.")),
        answer: async () => { throw new Error("nothing is answered"); },
      },
      offered: async () => [], readers: () => [], disconnect: async () => undefined, address: unasked, key: unasked, describe: async () => ({ described: [] }), device: label, clock: () => NOW, day: () => DAY,
    });
    const at = (id: string) => get(routes as never, `/v1/agents/signins/${id}`);
    expect(await at(waiting)).toEqual({ id: waiting, state: "waiting", outcome: null, reader: null, connected: null });
    const allowedRead = await at(allowed) as unknown as SignInRead;
    expect(allowedRead, "approved, and the other app has not yet exchanged its code: finishing").toEqual({ id: allowed, state: "approved", outcome: wordsAt("Allowed on iPhone,", NOW - MINUTE), reader: null, connected: null });
    expect(phraseText(allowedRead.outcome!, NOW, DAY.zone), "it reads as the home worded it").toBe("Allowed on iPhone, 08:59");
    const deniedRead = await at(denied) as unknown as SignInRead;
    expect(deniedRead).toEqual({ id: denied, state: "denied", outcome: wordsAt("Not allowed on iPhone,", NOW - MINUTE), reader: null, connected: null });
    expect(await at(connected), "the exchange minted its reader: connected, worded from the access it was granted").toEqual({
      id: connected, state: "approved", outcome: wordsAt("Allowed on iPhone,", NOW - MINUTE),
      reader: "p-0000dddd", connected: { reader: "p-0000dddd", line: "It sees everything but Health and Money. Change it any time in Agents." },
    });
    expect(phraseText(deniedRead.outcome!, NOW, DAY.zone)).toBe("Not allowed on iPhone, 08:59");
    const by = async (asker: Asker) => {
      try {
        return await routes.serve(asker, { method: "GET" } as IncomingMessage, new URL(`http://home/v1/agents/signins/${allowed}`), async () => ({}));
      } catch (error) {
        if (error instanceof Refusal) return [error.status, error.code];
        throw error;
      }
    };
    expect([await by({ ...PHONE, widen: false }), await by({ ...PHONE, ask: true, widen: false })], "a browser pass and Chat read no sign-in: the person's alone").toEqual([[403, "PERSON_ONLY"], [403, "PERSON_ONLY"]]);
    expect(await at("DDDDDDDDDDDDDDDDDDDDDD"), "one the home no longer holds, by its clock or after a restart: gone, never a refusal").toEqual({ id: "DDDDDDDDDDDDDDDDDDDDDD", state: "gone", outcome: null, reader: null, connected: null });
    expect(routes.routes("GET", "/v1/agents/signins/short"), "a sign-in's id is 22 characters").toBe(false);
  });

  it("refuses Chat's request answered with an access that hides, and writes nothing", async () => {
    const id = "rq-00000000000000aa";
    const writes: string[] = [];
    const routes = person((writing) => {
      writes.push(Object.keys(writing)[0]!);
      if ("ask" in writing) return { request: { id, reader: "ask" } };
      throw new Error("the answer is written");
    }, "sign-in-1");
    const hiding = { ...emptyAccess(), allow: [{ reach: { all: true, but: [] }, window: null, until_ms: null }], hide: "names" };
    expect(await post(routes, "/v1/agents/answer", { id, answer: "always", expect: 1, access: hiding as unknown as Json }))
      .toEqual({ status: 422, code: "BAD_REQUEST", message: "Each conversation hides what you pick in it." });
    expect(writes).toEqual(["ask"]);
  });
});
