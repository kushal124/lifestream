import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonical, parse, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, fetchedBytes, LENT, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../test/drive.js";
import { FakeRelay } from "../test/station.js";
import { NeedsYou, NotYet, type Acquirer, type Lent } from "../seams.js";
import { byBytes, callMemory } from "../shared/memory.js";
import { Refused } from "../shared/refused.js";
import { chromeSites, survey } from "../shared/setup.js";
import { stationsOver } from "../shared/station.js";
import { declarations } from "../index.js";
import type { BrowserSettings, BrowserState } from "../shared/browser.js";
import { chatgptBrowserAcquirer } from "./chatgpt/browser-acquirer.js";
import { chatgptBrowserConnector } from "./chatgpt/browser-reader.js";
import { claudeBrowserAcquirer } from "./claude/browser-acquirer.js";
import { claudeBrowserConnector } from "./claude/browser-reader.js";
import { claudeConnector } from "./claude/reader.js";
import { CHATGPT_ACCOUNT, CLAUDE_ACCOUNT } from "./test/fixtures.js";
import { CHATGPT_BROWSER_SOURCE, ChatgptSite, type ClaudeChat, type GptChat, claudeChat, ClaudeSite, CLAUDE_BROWSER_SOURCE, GPT_MEDIA, gptConversation } from "./test/browser.js";

const NOW = Date.parse("2026-09-10T12:00:00Z");
const LIST_END = [2_000, 5_000, 10_000];
const SECONDS = NOW / 1000;
const DAY_S = 86_400;
const WEEK_MS = 7 * 86_400_000;
const KINDS = ["chat", "msg"];
const SECRETS = memorySecrets({});

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function home(): TestHome {
  const made = openTestHome("connect-ai-browser");
  homes.push(made);
  return made;
}

function lane(relay: FakeRelay, settings: Partial<BrowserSettings> = {}, start_ms: number | null = NOW - WEEK_MS) {
  const slept: number[] = [];
  relay.start_ms = start_ms;
  const full: BrowserSettings = { work: temp("connect-ai-work-"), ...settings };
  const dependencies = { relay, sleep: async (ms: number) => void slept.push(ms), now: () => NOW };
  return { settings: full, dependencies, slept };
}

function synthetic(n: number, update: number): GptChat {
  return { id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Synthetic chat ${n}`, update };
}

const PLACE: JsonObject = { first_ms: NOW - WEEK_MS };

type Parts = Partial<Record<"seen" | "media" | "owed" | "listed" | "walked", Record<string, Json>>>;

function begun(...accounts: (readonly [account: string, place: JsonObject, parts?: Parts])[]): PollRecord {
  const memory = new Map<string, Map<string, string>>([["account", new Map(accounts.map(([account, place]) => [account, canonical(place)]))]]);
  for (const [account, , parts = {}] of accounts) {
    for (const [part, entries] of Object.entries(parts)) {
      if (Object.keys(entries).length > 0) memory.set(`${part}:${account}`, new Map(Object.entries(entries).map(([key, value]) => [key, canonical(value)])));
    }
  }
  return { state: { polled_ms: NOW - 3_600_000 }, from_ms: NOW - WEEK_MS, memory, deliveries: [] };
}
const claudeBegun = (): PollRecord => begun([CLAUDE_ACCOUNT, PLACE]);
const chatgptBegun = (): PollRecord => begun([CHATGPT_ACCOUNT, PLACE]);
const owedOf = (listed: Record<string, string>): Record<string, Json> => Object.fromEntries(Object.entries(listed).map(([id, at]) => [id, { at }]));

interface Held {
  place: BrowserState;
  seen: Record<string, string>;
  owed: Record<string, { at: string; tries?: number }>;
  media: string[];
  listed: Record<string, string>;
  walked: Record<string, string>;
}

function held(record: PollRecord, account?: string): Held {
  const places = record.memory?.get("account") ?? new Map<string, string>();
  if (account === undefined) expect(places.size).toBe(1);
  const which = account ?? [...places.keys()][0]!;
  const part = (name: string): Record<string, never> => Object.fromEntries([...(record.memory?.get(`${name}:${which}`) ?? [])].map(([key, value]) => [key, parse(value) as never]));
  return { place: parse(places.get(which)!) as unknown as BrowserState, seen: part("seen"), owed: part("owed"), media: Object.keys(part("media")).sort(), listed: part("listed"), walked: part("walked") };
}

const remembered = (record: PollRecord): string => JSON.stringify([...(record.memory ?? [])].map(([part, entries]) => [part, [...entries]]));

function lentOver(record: PollRecord): Lent {
  const entries = (part: string) => [...(record.memory?.get(part) ?? [])].sort(([a], [b]) => byBytes(a, b));
  return {
    ...LENT,
    memory: callMemory({
      get: (part, key) => record.memory?.get(part)?.get(key),
      after: (part, after, limit) => entries(part).filter(([key]) => after === null || byBytes(key, after) > 0).slice(0, limit),
    }),
  };
}

const relays = new WeakMap<Acquirer, FakeRelay>();
const lend = (acquirer: Acquirer, dependencies: { relay: FakeRelay }): Acquirer => {
  const lent = dependencies.relay.lend(acquirer);
  relays.set(lent, dependencies.relay);
  return lent;
};

async function polled(at: TestHome, acquirer: ReturnType<typeof claudeBrowserAcquirer>, connector: typeof claudeBrowserConnector, record: PollRecord, call: "fetch" | "page" = "fetch") {
  const delivery = await poll(at, acquirer, record, SECRETS, NOW, call, relays.get(acquirer)?.start_ms ?? null);
  if (delivery === undefined) return undefined;
  return { delivery, landed: await at.land(connector, delivery) };
}

describe("claude browser", () => {
  it("a conversation the browser read lands in another shape than the export's (two reads unmerged, a null parent left out)", async () => {
    const at = home();
    const site = new ClaudeSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay);
    const record = claudeBegun();
    const first = await polled(at, lend(claudeBrowserAcquirer(settings, dependencies), dependencies), claudeBrowserConnector, record);
    expect(first!.landed).toMatchObject({ new: 9, refused: 0 });
    expect(first!.delivery.files.map((file) => file.path).sort()).toEqual(["account.json", ...site.chats.flatMap((chat) => [`conversations/${chat.uuid}.messages.json`, `conversations/${chat.uuid}.text.json`])].sort());
    expect(claudeBrowserAcquirer(settings, dependencies).source).toBe("claude-browser");
    expect(first!.delivery.facts).toMatchObject({ account: CLAUDE_ACCOUNT, sources: [{ id: CLAUDE_BROWSER_SOURCE, connector: "claude-browser", email: "person-a@example.com" }] });
    expect(first!.delivery.source).toBe(CLAUDE_BROWSER_SOURCE);
    expect(record.state).toEqual({ polled_ms: NOW });
    expect(held(record, CLAUDE_ACCOUNT).place).toEqual({ first_ms: expect.any(Number) });
    expect(relay.errands).toEqual([{ name: "claude-browser", origins: ["https://claude.ai"], deadline_ms: 1_800_000 }]);
    expect(relay.waits).toEqual([60_000]);
    expect(relay.open).toBe(0);
    const heads = at.heads(CLAUDE_BROWSER_SOURCE, KINDS);
    const chat = site.chats[0]!;
    const human = heads.find((head) => head.key === `${chat.uuid}:${chat.messages[0]!.uuid}`)!;
    const message = (human.content as { type: string; message: JsonObject }).message;
    expect((human.content as JsonObject).type).toBe("claude.msg");
    expect(message).toMatchObject({ text: "Synthetic question 1.", parent_message_uuid: null, index: 0, sync_sources: [] });
    expect(message.content).toEqual([expect.objectContaining({ type: "text", text: "Synthetic question 1." })]);
    expect(heads.find((head) => head.key === `${chat.uuid}:${chat.messages[1]!.uuid}`)!.content).toMatchObject({ message: { parent_message_uuid: chat.messages[0]!.uuid, stop_reason: "stop_sequence" } });
    expect(heads.find((head) => head.kind === "chat" && head.key === chat.uuid)!.content).toEqual({
      type: "claude.shell", conversation_uuid: chat.uuid, name: chat.name, summary: "", created_at: chat.created_at, updated_at: chat.updated_at,
    });
    expect(claudeBrowserConnector.kinds).toBe(claudeConnector.kinds);
    artifact(at.dir, "heads.json", heads);
  });

  it("a message only the plain read holds is lost", async () => {
    const at = home();
    const site = new ClaudeSite();
    const { settings, dependencies } = lane(new FakeRelay(site));
    const begun = claudeBegun();
    const fetched = await lend(claudeBrowserAcquirer(settings, dependencies), dependencies).fetch(begun.state, SECRETS, lentOver(begun));
    const files = Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));
    const chat = site.chats[0]!.uuid;
    const rendered = JSON.parse(files[`conversations/${chat}.messages.json`]!.toString()) as { chat_messages: JsonObject[] };
    const left = rendered.chat_messages[0]!.uuid as string;
    const short = { ...files, [`conversations/${chat}.messages.json`]: Buffer.from(JSON.stringify({ ...rendered, chat_messages: rendered.chat_messages.slice(1) })) };
    await at.land(claudeBrowserConnector, deliver(at, CLAUDE_BROWSER_SOURCE, short, fetched.facts));
    const kept = at.heads(CLAUDE_BROWSER_SOURCE, ["msg"]).find((head) => head.key === `${chat}:${left}`);
    expect(kept?.content).toMatchObject({ message: { uuid: left, content: null, text: expect.any(String) } });
    expect(at.heads(CLAUDE_BROWSER_SOURCE, ["msg"]).filter((head) => head.key.startsWith(`${chat}:`))).toHaveLength(rendered.chat_messages.length);
  });

  it("a delivery of another account lands anything, or two reads that list other messages refuse more than their conversation", async () => {
    const at = home();
    const site = new ClaudeSite();
    const { settings, dependencies } = lane(new FakeRelay(site));
    const begun = claudeBegun();
    const fetched = await lend(claudeBrowserAcquirer(settings, dependencies), dependencies).fetch(begun.state, SECRETS, lentOver(begun));
    const files = Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));
    const other = "claude:22222222-2222-4222-8222-000000000000:browser";
    await expect(at.land(claudeBrowserConnector, deliver(at, other, files, fetched.facts))).rejects.toThrow(/account.json states .*; the source is claude:2222/u);
    await expect(at.land(claudeBrowserConnector, deliver(at, `claude:${CLAUDE_ACCOUNT}:cloud`, files, fetched.facts))).rejects.toThrow(Refused);
    const chat = site.chats[0]!.uuid;
    const plain = JSON.parse(files[`conversations/${chat}.text.json`]!.toString()) as { chat_messages: JsonObject[] };
    const drifted = { ...files, [`conversations/${chat}.text.json`]: Buffer.from(JSON.stringify({ ...plain, chat_messages: plain.chat_messages.slice(1) })) };
    expect(at.heads(CLAUDE_BROWSER_SOURCE, KINDS)).toEqual([]);
    const others = site.chats.slice(1).map((each) => each.uuid).sort();
    for (const [name, delivered, why] of [
      ["drifted", drifted, /the rendered read holds .*, which the plain read does not/u],
      ["half", (({ [`conversations/${chat}.text.json`]: _, ...half }) => half)(files), /one read of two/u],
    ] as const) {
      const scratch = home();
      const landed = await scratch.land(claudeBrowserConnector, deliver(scratch, CLAUDE_BROWSER_SOURCE, delivered, fetched.facts));
      expect(landed.refusals, name).toEqual([{ kind: "file", key: `conversations/${chat}`, violations: [expect.stringMatching(why)] }]);
      expect(scratch.heads(CLAUDE_BROWSER_SOURCE, ["chat"]).map((head) => head.key), name).toEqual(others);
    }
  });

  it("a poll fetches what has not changed, or more than its cap, or skips a backlog, or lists again before its backlog is done", async () => {
    const at = home();
    const site = new ClaudeSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { max_conversations: 2 });
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record = claudeBegun();
    const fetchedIds = (index: number) => record.deliveries[index]!.files.filter((file) => file.path.endsWith(".text.json")).map((file) => file.path.slice(14, 50)).sort();

    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(fetchedIds(0)).toEqual([site.chats[1]!.uuid, site.chats[2]!.uuid].sort());
    expect(record.deliveries[0]!.facts).toMatchObject({ listed: 3, conversations: 2, skipped: 0, more: true });
    expect(Object.keys(held(record).owed)).toEqual([site.chats[0]!.uuid]);
    expect(record.next).toEqual({ more: true });
    const lists = () => relay.requested.filter((path) => path.includes("chat_conversations?limit=")).length;
    const listedBefore = lists();
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(fetchedIds(1)).toEqual([site.chats[0]!.uuid]);
    expect(lists()).toBe(listedBefore);
    expect(held(record).owed).toEqual({});
    expect(record.next).toEqual({});

    expect(await polled(at, acquirer, claudeBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ conversations: 0, more: false });
    expect(record.changes).toEqual({ cleared: [], entries: [] });
    site.chats[0] = { ...site.chats[0]!, name: "Synthetic browser chat 1, renamed", updated_at: "2026-09-09T10:00:00.000001Z" };
    site.chats.push(claudeChat(4, "2026-09-07T10:00:00.000001Z"));
    const third = await polled(at, acquirer, claudeBrowserConnector, record);
    expect(fetchedIds(2)).toEqual([site.chats[0]!.uuid, site.chats[3]!.uuid].sort());
    expect(third!.landed).toMatchObject({ new: 3, changed: 1, refused: 0 });
    expect(Object.keys(held(record).seen).sort()).toEqual(site.chats.map((chat) => chat.uuid).sort());
    artifact(at.dir, "polls.json", { facts: record.deliveries.map((delivery) => delivery.facts), state: record.state, memory: held(record), requested: relay.requested });
  });

  it("a 429 fails the poll at once, or a limit that never clears loses what was fetched or holds the lane by anything but the provider's hold", async () => {
    const at = home();
    const site = new ClaudeSite();
    const { settings, dependencies, slept } = lane(new FakeRelay(site));
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record = claudeBegun();
    site.queue(/chat_conversations\?limit/u, { status: 429, body: { type: "error" } });
    site.queue(new RegExp(`${site.chats[2]!.uuid}\\?tree=True&rendering`, "u"), { status: 429 }, { status: 429 });
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(slept).toEqual([5_000, 5_000, 10_000]);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 3, more: false });

    site.chats[2] = { ...site.chats[2]!, updated_at: "2026-09-09T10:00:00.000001Z" };
    site.chats[1] = { ...site.chats[1]!, updated_at: "2026-09-08T10:00:00.000001Z" };
    site.queue(new RegExp(`${site.chats[1]!.uuid}\\?tree=True&rendering`, "u"), ...Array.from({ length: 6 }, () => ({ status: 429 })));
    slept.length = 0;
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(slept).toEqual([5_000, 10_000, 20_000, 40_000, 80_000]);
    expect(record.deliveries[1]!.facts).toMatchObject({ conversations: 1, more: true });
    expect(record.next).toEqual({ backoff_ms: NOW + 30 * 60_000 });
    expect(held(record).seen[site.chats[1]!.uuid]).toBe("2026-09-05T10:00:00.000001Z");
    site.chats[1] = { ...site.chats[1]!, drift: true };
    site.queue(new RegExp(`${site.chats[0]!.uuid}\\?tree=True$`, "u"), { status: 500 }, { status: 500 }, { status: 500 });
    site.chats[0] = { ...site.chats[0]!, updated_at: "2026-09-07T10:00:00.000001Z" };
    const third = await polled(at, acquirer, claudeBrowserConnector, record);
    expect(record.deliveries[2]!.facts).toMatchObject({ listed: 0, conversations: 1, skipped: 0, more: false });
    expect(third!.landed).toMatchObject({ refused: 0, new: 1 });
    expect(await polled(at, acquirer, claudeBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ conversations: 0, skipped: 1, more: false });
    expect(record.deliveries).toHaveLength(3);
    artifact(at.dir, "limited.json", { slept, facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a conversation refused (403) while signed in says sign in, or stops the stream", async () => {
    const at = home();
    const site = new ClaudeSite();
    const { settings, dependencies, slept } = lane(new FakeRelay(site));
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record = claudeBegun();
    const refused = site.chats[1]!.uuid;
    site.queue(new RegExp(`${refused}\\?tree=True&rendering`, "u"), { status: 403, body: { type: "error", error: { type: "permission_error" } } });
    const first = await polled(at, acquirer, claudeBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 2, skipped: 1, more: false });
    expect(first!.landed).toMatchObject({ refused: 0, new: 6 });
    expect(slept).toEqual([]);
    expect(held(record).seen[refused]).toBeUndefined();
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(record.deliveries[1]!.facts).toMatchObject({ conversations: 1, skipped: 0 });
    expect(at.heads(CLAUDE_BROWSER_SOURCE, ["chat"]).map((head) => head.key).sort()).toEqual(site.chats.map((chat) => chat.uuid).sort());
    artifact(at.dir, "refused.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a sign-in read the provider failed (a 5xx) says sign in, or one it refused (a 403) does not", async () => {
    const failing = new ClaudeSite();
    failing.queue(/^\/api\/account$/u, ...Array.from({ length: 3 }, () => ({ status: 503, body: { type: "error" } })));
    const plain = lane(new FakeRelay(failing));
    const failed = await lend(claudeBrowserAcquirer(plain.settings, plain.dependencies), plain.dependencies).fetch(null, SECRETS, LENT).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(NeedsYou);
    expect((failed as Error).message).toBe("Claude answered 503 to its sign-in read /api/account");
    expect(plain.slept).toEqual([5_000, 10_000]);
    const refusing = new ClaudeSite();
    refusing.queue(/^\/api\/account$/u, { status: 403, body: { type: "error", error: { type: "permission_error" } } });
    const person = lane(new FakeRelay(refusing));
    const signedOut = await lend(claudeBrowserAcquirer(person.settings, person.dependencies), person.dependencies).fetch(null, SECRETS, LENT).catch((error: unknown) => error);
    expect(signedOut).toBeInstanceOf(NeedsYou);
    expect((signedOut as NeedsYou).reason).toBe("signed-out");
  });

  it("a first fetch fetches history, a page fetches a conversation from before the week, or one updated since the first call is missed", async () => {
    const at = home();
    const site = new ClaudeSite();
    site.chats.push(claudeChat(5, "2026-08-01T10:00:00.000001Z"));
    const { settings, dependencies } = lane(new FakeRelay(site));
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record: PollRecord = { state: null, deliveries: [] };
    const fetchedIds = (index: number) => record.deliveries[index]!.files.filter((file) => file.path.endsWith(".text.json")).map((file) => file.path.slice(14, 50)).sort();
    expect(await polled(at, acquirer, claudeBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ listed: 3, conversations: 0, more: false });
    expect(Object.keys(held(record).owed).sort()).toEqual(site.chats.slice(0, 3).map((chat) => chat.uuid).sort());
    expect(held(record).place).toEqual({ first_ms: NOW });
    expect(record.from_ms).toBe(NOW - WEEK_MS);
    await polled(at, acquirer, claudeBrowserConnector, record, "page");
    expect(fetchedIds(0)).toEqual(site.chats.slice(0, 3).map((chat) => chat.uuid).sort());
    expect(record.left).toBe(0);
    expect(held(record).owed).toEqual({});
    site.chats[3] = { ...site.chats[3]!, updated_at: "2026-09-10T13:00:00.000001Z" };
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(fetchedIds(1)).toEqual([site.chats[3]!.uuid]);
    artifact(at.dir, "first-week.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a signed-out browser, an account the stream does not read, a page asking for a password, or an extension refusal is a plain failure, not the person's, names where the person acts, or says it with a domain, a status code or the station", async () => {
    const reasons: string[] = [];
    const words: string[] = [];
    const places: string[] = [];
    const polledBefore = begun([CLAUDE_ACCOUNT, { first_ms: NOW }]);
    const attempt = async (change: (site: ClaudeSite, relay: FakeRelay) => void) => {
      const site = new ClaudeSite();
      const relay = new FakeRelay(site);
      relay.accounts = { [CLAUDE_ACCOUNT]: true };
      change(site, relay);
      const { settings, dependencies } = lane(relay);
      const failure = await lend(claudeBrowserAcquirer(settings, dependencies), dependencies).fetch(polledBefore.state, SECRETS, lentOver(polledBefore)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NeedsYou);
      expect((failure as Error).message).toMatch(/^needs you: /u);
      reasons.push((failure as NeedsYou).reason);
      words.push((failure as NeedsYou).says);
      const at = (failure as NeedsYou).at;
      places.push(`${at?.site} ${at?.open ?? "-"} ${at?.errand ?? "-"} open:${relay.open}`);
    };
    await attempt((site) => void (site.signedOut = true));
    await attempt((site) => {
      site.account = "22222222-2222-4222-8222-000000000000";
      site.email = "person-b@example.com";
    });
    await attempt((site) => void (site.signals = { password: true }));
    await attempt((site) => void (site.signals = { captcha: true, verify: true }));
    await attempt((_site, relay) => void relay.refusals.push({ op: "open", code: "SITE_NOT_ALLOWED" }));
    expect(reasons).toEqual(["signed-out", "other-account", "password", "confirm", "extension"]);
    expect(words).toEqual([
      "Sign in to Claude in Chrome",
      "Chrome is signed in to Claude as person-b@example.com",
      "Claude asks for your password. Sign in to Claude in Chrome.",
      "Claude shows a CAPTCHA. Solve it in Chrome.",
      "Lifestream's Chrome extension isn't allowed on this site. Click Lifestream's icon in Chrome's toolbar, then Allow.",
    ]);
    expect(places).toEqual([
      "claude.ai https://claude.ai/ - open:0", "claude.ai https://claude.ai/ - open:0",
      "claude.ai - errand-1 open:1", "claude.ai - errand-1 open:1", "claude.ai - - open:0",
    ]);
  });
});

describe("a stream's accounts", () => {
  const OTHER = "22222222-2222-4222-8222-000000000000";

  it("a page that read no conversation, sealed with no file, is refused for the account file it lacks", async () => {
    const at = home();
    for (const [connector, source] of [[claudeBrowserConnector, CLAUDE_BROWSER_SOURCE], [chatgptBrowserConnector, CHATGPT_BROWSER_SOURCE]] as const) {
      const landed = await at.land(connector, deliver(at, source, {}, { history: true, left: 0, start_ms: null }, NOW));
      expect(landed.refusals, connector.name).toEqual([]);
      expect(at.heads(source, KINDS), connector.name).toEqual([]);
    }
  });

  it("reads an account whose source is off, or reads an offered account before it is chosen, or offers the first account of a new stream", async () => {
    const at = home();
    const site = new ClaudeSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record = claudeBegun();
    await polled(at, acquirer, claudeBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 3, sources: [{ id: CLAUDE_BROWSER_SOURCE, email: "person-a@example.com" }] });
    const read = record.state;
    const kept = remembered(record);
    const first = held(record, CLAUDE_ACCOUNT);
    relay.accounts = { [CLAUDE_ACCOUNT]: true };
    site.account = OTHER;
    site.email = "person-b@example.com";
    const asked = relay.requested.length;
    const offered = await poll(at, acquirer, record, SECRETS, NOW).catch((error: unknown) => error);
    expect(offered).toBeInstanceOf(NeedsYou);
    expect(offered).toMatchObject({ reason: "other-account", account: { id: OTHER, email: "person-b@example.com" }, says: "Chrome is signed in to Claude as person-b@example.com" });
    expect((offered as NeedsYou).at).toEqual({ site: "claude.ai", open: "https://claude.ai/" });
    expect(relay.requested.slice(asked)).toEqual(["/api/account"]);
    expect(record.state).toBe(read);
    expect(remembered(record)).toBe(kept);
    relay.accounts = { [CLAUDE_ACCOUNT]: true, [OTHER]: false };
    const waited = await poll(at, acquirer, record, SECRETS, NOW).catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect([(waited as NotYet).reason, (waited as NotYet).facts]).toEqual(["chrome", { account: "person-b@example.com" }]);
    expect(record.deliveries).toHaveLength(1);
    expect(record.state).toBe(read);
    expect(remembered(record)).toBe(kept);
    relay.accounts = { [CLAUDE_ACCOUNT]: true, [OTHER]: true };
    expect(await polled(at, acquirer, claudeBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ account: OTHER, listed: 3, conversations: 0, sources: [{ id: `claude:${OTHER}:browser`, email: "person-b@example.com" }] });
    await polled(at, acquirer, claudeBrowserConnector, record, "page");
    expect(record.deliveries[1]!.facts).toMatchObject({ account: OTHER, conversations: 3, sources: [{ id: `claude:${OTHER}:browser`, email: "person-b@example.com" }] });
    expect([...record.memory!.get("account")!.keys()].sort()).toEqual([CLAUDE_ACCOUNT, OTHER].sort());
    expect(held(record, CLAUDE_ACCOUNT)).toEqual(first);
    expect(Object.keys(held(record, OTHER).seen)).toHaveLength(3);
    expect(record.state).toEqual({ polled_ms: NOW });
    artifact(at.dir, "accounts.json", { facts: record.deliveries.map((delivery) => delivery.facts), state: record.state, memory: remembered(record) });
  });

  it("seeds a second account from the export, or leaves a stream's first poll unseeded", async () => {
    const at = home();
    const site = new ClaudeSite();
    const relay = new FakeRelay(site);
    const exported = temp("connect-ai-export-");
    writeFileSync(join(exported, "conversations.json"), JSON.stringify(site.chats.map((chat) => ({ uuid: chat.uuid, updated_at: chat.updated_at }))));
    const { settings, dependencies } = lane(relay, { pace_ms: 0, seed: [exported] });
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const seen = Object.fromEntries(site.chats.map((chat) => [chat.uuid, chat.updated_at]));
    const record = begun([CLAUDE_ACCOUNT, { first_ms: NOW }, { seen }]);
    site.account = OTHER;
    site.email = "person-b@example.com";
    relay.accounts = { [CLAUDE_ACCOUNT]: true, [OTHER]: true };
    expect(await polled(at, acquirer, claudeBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ account: OTHER, listed: 3, conversations: 0 });
    expect(record.facts).not.toHaveProperty("seeded");
    expect(Object.keys(held(record, OTHER).owed)).toHaveLength(3);
    expect(held(record, OTHER).seen).toEqual({});
    site.account = CLAUDE_ACCOUNT;
    relay.accounts = {};
    const fresh: PollRecord = { state: null, deliveries: [] };
    await polled(at, acquirer, claudeBrowserConnector, fresh);
    expect(fresh.facts).toMatchObject({ seeded: 3, conversations: 0 });
    expect(held(fresh).seen).toEqual(seen);
  });

  it("lets one account's wait or need land on another's copy", async () => {
    const at = home();
    const site = new ClaudeSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
    const record: PollRecord = { state: null, deliveries: [] };
    relay.accounts = { [CLAUDE_ACCOUNT]: true, [OTHER]: true };
    site.account = OTHER;
    site.email = "person-b@example.com";
    await polled(at, acquirer, claudeBrowserConnector, record);
    site.account = CLAUDE_ACCOUNT;
    site.email = "person-a@example.com";
    await polled(at, acquirer, claudeBrowserConnector, record);
    site.queue(/chat_conversations\?limit/u, ...Array.from({ length: 6 }, () => ({ status: 429 })));
    const waited = await poll(at, acquirer, record, SECRETS, NOW).catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect((waited as NotYet).facts).toMatchObject({ account: CLAUDE_ACCOUNT, sources: [{ id: CLAUDE_BROWSER_SOURCE }] });
    artifact(at.dir, "accounts.json", { state: record.state, facts: (waited as NotYet).facts });
  });

  it("states no email, or hands the home ChatGPT's token or session through who", async () => {
    const at = home();
    const site = new ChatgptSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const record: PollRecord = { state: null, deliveries: [] };
    expect(await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ account: CHATGPT_ACCOUNT, sources: [{ id: CHATGPT_BROWSER_SOURCE, connector: "chatgpt-browser", email: "person-a@example.com" }] });
    const kept = [JSON.stringify(record.facts), JSON.stringify(record.state), remembered(record)].join("\n");
    expect(kept).toContain("person-a@example.com");
    expect(kept).not.toContain("access-token-synthetic");
    expect(kept).not.toContain("session-token-synthetic");
    site.account = "user-someone-else";
    site.email = "person-b@example.com";
    relay.accounts = { [CHATGPT_ACCOUNT]: true };
    const offered = await poll(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), record, SECRETS, NOW).catch((error: unknown) => error);
    expect(offered).toMatchObject({ reason: "other-account", account: { id: "user-someone-else", email: "person-b@example.com" } });
  });
});

describe("chatgpt browser", () => {
  it("a superset node refuses the delivery, or a media file the browser fetched links nothing", async () => {
    const at = home();
    const site = new ChatgptSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay);
    const record = chatgptBegun();
    const first = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(first!.landed).toMatchObject({ new: 16, refused: 0 });
    expect(relay.errands).toEqual([{ name: "chatgpt-browser", origins: ["https://chatgpt.com"], deadline_ms: 1_800_000 }]);
    const delivery = first!.delivery;
    expect(delivery.files.map((file) => file.path).filter((path) => !path.startsWith("conversations/")).sort()).toEqual(["file-CdE456.dat", "file_00bb22.dat", "me.json"]);
    expect(site.downloads.sort()).toEqual(["file-CdE456", "file-Gone789", "file_00bb22"]);
    const chat = site.main[0]!;
    const heads = at.heads(CHATGPT_BROWSER_SOURCE, KINDS);
    const blob = (path: string) => delivery.files.find((file) => file.path === path)!.blob;
    expect(at.blobs.bytes(blob("file_00bb22.dat"))).toEqual(GPT_MEDIA.file_00bb22);
    const rows = await collect(chatgptBrowserConnector.read(delivery, at.blobs));
    const user = rows.find((row) => row.key === `${chat.id}:10000000-0000-4000-8000-000000000001`)!;
    expect(user.blobs).toEqual([blob("file-CdE456.dat"), blob("file_00bb22.dat")]);
    expect(user.content).toMatchObject({ type: "chatgpt.msg", conversation_id: chat.id, node: { id: "10000000-0000-4000-8000-000000000001" } });
    const tool = rows.find((row) => row.key === `${chat.id}:10000000-0000-4000-8000-000000000002`)!;
    expect(tool.time).toEqual(user.time);
    expect(heads.find((head) => head.kind === "chat" && head.key === chat.id)!.content).toEqual({
      type: "chatgpt.shell", conversation_id: chat.id, title: chat.title, update_time: chat.update, current_node: "10000000-0000-4000-8000-000000000003",
    });
    expect(held(record).media).toEqual(["file-CdE456", "file_00bb22"]);
    expect(delivery.facts).toMatchObject({ media: 2 });

    site.main[0] = { ...chat, title: "Synthetic browser chat 1, renamed", update: chat.update + 1_000 };
    const second = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(second!.delivery.files.map((file) => file.path).sort()).toEqual([`conversations/${chat.id}.json`, "me.json"]);
    expect(second!.landed).toMatchObject({ changed: 1, restated: 3, refused: 0 });
    expect(site.downloads.filter((id) => id === "file_00bb22")).toHaveLength(1);
    artifact(at.dir, "heads.json", heads);
  });

  it("an empty list page ends the list unconfirmed, or an archived or project conversation is never listed", async () => {
    const at = home();
    const site = new ChatgptSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies, slept } = lane(relay, { pace_ms: 0 });
    const empty = { status: 200, body: { items: [], total: 999 } };
    site.queue(/^\/backend-api\/conversations\?offset=0&limit=28&order=updated$/u, empty, empty, empty);
    const record = chatgptBegun();
    await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    const fetched = record.deliveries[0]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path).sort();
    expect(fetched).toEqual([...site.main, ...site.archived, ...site.projects["g-p-synthetic0001"]!].map((chat) => `conversations/${chat.id}.json`).sort());
    expect(slept).toEqual([...LIST_END, ...LIST_END, ...LIST_END]);
    expect(relay.requested.filter((path) => path.includes("snorlax"))).toEqual(["/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0", "/backend-api/gizmos/snorlax/sidebar?conversations_per_gizmo=0&cursor=1"]);
    expect(relay.requested.filter((path) => path.includes("is_archived=true"))).toEqual([
      ...[0, 28, 28, 28, 28].map((offset) => `/backend-api/conversations?offset=${offset}&limit=28&order=updated&is_archived=true`),
      "/backend-api/conversations?offset=56&limit=28&order=updated&is_archived=true",
    ]);
    artifact(at.dir, "requests.json", relay.requested);
  });

  it("an empty page with conversations after it ends a first read, or an answer that is no list is read as its end", async () => {
    const outcomes: Record<string, unknown> = {};
    const answers: Record<string, () => unknown[]> = {
      "an empty page before conversations": () => Array.from({ length: 1 + LIST_END.length }, () => ({ status: 200, body: { items: [], total: 999 } })),
      "a 200 with no items": () => [{ status: 200, body: { detail: "synthetic" } }],
    };
    for (const [name, queued] of Object.entries(answers)) {
      const at = home();
      const site = new ChatgptSite();
      site.main = Array.from({ length: 40 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Synthetic chat ${n}`, update: 1789000000 + n * 60 }));
      const relay = new FakeRelay(site);
      const { settings, dependencies } = lane(relay, { pace_ms: 0 });
      site.queue(/^\/backend-api\/conversations\?offset=0&limit=28&order=updated$/u, ...(queued() as Parameters<ChatgptSite["queue"]>[1][]));
      const record = chatgptBegun();
      const failed = await lend(chatgptBrowserAcquirer(settings, dependencies), dependencies).fetch(record.state, SECRETS, lentOver(record)).catch((error: unknown) => error);
      expect([failed instanceof Error, failed instanceof NotYet, relay.requested.some((path) => path.startsWith("/backend-api/conversation/"))], name).toEqual([true, false, false]);
      outcomes[name] = (failed as Error).message;
      await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
      expect(record.deliveries[0]!.facts, name).toMatchObject({ conversations: site.main.length + site.archived.length + site.projects["g-p-synthetic0001"]!.length });
    }
    expect(outcomes).toEqual({
      "an empty page before conversations": "chatgpt.com listed no conversations at offset 0 and some after it: the list's end is not confirmed",
      "a 200 with no items": "chatgpt.com answered a conversations page with no items list",
    });
    artifact(home().dir, "unconfirmed-end.json", outcomes);
  });

  it("a later poll pages the whole list again, or stops before the conversation that changed", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.main = Array.from({ length: 100 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Synthetic chat ${n}`, update: 1789000000 + n * 60 }));
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0, max_conversations: 200 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record = chatgptBegun();
    await polled(at, acquirer, chatgptBrowserConnector, record);
    const mainPages = () => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && !path.includes("is_archived"));
    expect(new Set(mainPages()).size).toBe(6);
    relay.requested.length = 0;
    site.main[97] = { ...site.main[97]!, update: 1789030000 };
    record.state = { ...record.state, polled_ms: NOW - 3_600_000 };
    await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(mainPages()).toEqual([0, 28, 56].map((offset) => `/backend-api/conversations?offset=${offset}&limit=28&order=updated`));
    expect(record.deliveries[1]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path)).toEqual([`conversations/${site.main[97]!.id}.json`]);
  });

  it("a poll whose time runs out mid-list, or that the provider keeps limiting, goes on next time from the page it reached", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.main = Array.from({ length: 70 }, (_, n) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `Synthetic chat ${n}`, update: 1789000000 + n * 60 }));
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0, max_conversations: 200 });
    const mainPages = () => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && !path.includes("is_archived"));
    const record = chatgptBegun();
    let clock = 0;
    const late = { ...dependencies, now: () => (clock++ === 0 ? NOW : NOW + 3 * 60 * 60_000) };
    expect(await polled(at, lend(chatgptBrowserAcquirer(settings, late), late), chatgptBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ listed: 28, listing: "time", conversations: 0, more: true });
    expect(mainPages()).toEqual(["/backend-api/conversations?offset=0&limit=28&order=updated"]);

    relay.requested.length = 0;
    site.queue(/^\/backend-api\/conversations\?offset=56&limit=28&order=updated$/u, ...Array.from({ length: 6 }, () => ({ status: 429 })));
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const limited = await polled(at, acquirer, chatgptBrowserConnector, record).catch((error: unknown) => error);
    expect(mainPages()[0]).toBe("/backend-api/conversations?offset=28&limit=28&order=updated");
    expect((limited as NotYet).backoff_ms).toBe(NOW + 30 * 60_000);
    expect(record.deliveries).toHaveLength(0);
    expect(Object.keys(held(record).listed)).toHaveLength(56);
    expect(held(record).place.listing).toEqual({ next: { list: 0, offset: 56, quiet: 0 } });

    relay.requested.length = 0;
    await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(mainPages()[0]).toBe("/backend-api/conversations?offset=56&limit=28&order=updated");
    expect(record.deliveries[0]!.facts).toMatchObject({ listed: 72, conversations: 72, more: false });
    expect(held(record).place.listing).toBeUndefined();
    expect(held(record).listed).toEqual({});
    artifact(at.dir, "resumed.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a fetch of much that is new lands nothing until it has fetched it all, or a piece stopped for time waits for the cadence to go on", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.main = Array.from({ length: 5 }, (_, n) => synthetic(n, SECONDS - (n + 1) * 3600));
    site.archived = [];
    site.projects = {};
    const relay = new FakeRelay(site);
    let clock = NOW;
    relay.start_ms = NOW - WEEK_MS;
    const settings: BrowserSettings = { work: temp("connect-ai-work-"), pace_ms: 20_000, piece_ms: 30_000 };
    const dependencies = { relay, sleep: async (ms: number) => void (clock += ms), now: () => clock };
    const built = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const said: (true | undefined)[] = [];
    const acquirer: Acquirer = { ...built, fetch: async (...args) => { const got = await built.fetch(...args); said.push(got.more); return got; } };
    const record = chatgptBegun();
    const fetched = (index: number) => record.deliveries[index]!.files.filter((file) => file.path.startsWith("conversations/")).length;

    const pieces: { fetched: number; listed: unknown; backlog: number; more: true | undefined }[] = [];
    for (let piece = 0; piece === 0 || (piece < 6 && said.at(-1) === true); piece++) {
      await polled(at, acquirer, chatgptBrowserConnector, record);
      pieces.push({ fetched: fetched(piece), listed: record.deliveries[piece]!.facts.listed, backlog: Object.keys(held(record).owed).length, more: said.at(-1) });
    }
    expect(pieces).toEqual([
      { fetched: 1, listed: 5, backlog: 4, more: true },
      { fetched: 3, listed: 0, backlog: 1, more: true },
      { fetched: 1, listed: 0, backlog: 0, more: undefined },
    ]);
    artifact(at.dir, "pieces.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a first fetch lists past the week, fetches history, or misses the week's conversation on a later page, archived or in a project; a page takes more than ten, older before newer, or lists again; a later fetch walks the history again, or misses a conversation updated since", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.main = Array.from({ length: 70 }, (_, n) => synthetic(n, n < 40 ? SECONDS - (n + 1) * 3600 : SECONDS - 8 * DAY_S - n * 60));
    site.archived = [synthetic(100, SECONDS - 2 * DAY_S), synthetic(101, SECONDS - 30 * DAY_S)];
    site.projects = { "g-p-synthetic0001": [synthetic(200, SECONDS - 3 * DAY_S), synthetic(201, SECONDS - 60 * DAY_S)], "g-p-synthetic0002": [] };
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0, max_conversations: 30 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record: PollRecord = { state: null, deliveries: [] };
    const lists = (archived: boolean) => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && path.includes("is_archived") === archived);
    const fetched = (index: number) => record.deliveries[index]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path.slice(14, 50));

    expect(await polled(at, acquirer, chatgptBrowserConnector, record)).toBeUndefined();
    expect(lists(false)).toEqual([0, 28].map((offset) => `/backend-api/conversations?offset=${offset}&limit=28&order=updated`));
    expect(lists(true)).toEqual(["/backend-api/conversations?offset=0&limit=28&order=updated&is_archived=true"]);
    expect(record.facts).toMatchObject({ listed: 42, conversations: 0, more: false });
    expect(record.next).toEqual({});
    const first = held(record);
    expect(record.from_ms).toBe(NOW - WEEK_MS);
    expect(Object.keys(first.owed)).toHaveLength(42);

    relay.requested.length = 0;
    const lefts: (number | null | undefined)[] = [];
    for (let page = 1; page <= 5; page++) {
      await polled(at, acquirer, chatgptBrowserConnector, record, "page");
      lefts.push(record.left);
    }
    expect(lists(false)).toEqual([]);
    expect([0, 1, 2, 3, 4].map(fetched)).toEqual([
      ...[0, 10, 20, 30].map((from) => site.main.slice(from, from + 10).map((chat) => chat.id)), [site.archived[0]!.id, site.projects["g-p-synthetic0001"]![0]!.id],
    ]);
    expect(lefts).toEqual([32, 22, 12, 2, 0]);
    expect(record.from_ms).toBe(NOW - WEEK_MS);
    expect(held(record).owed).toEqual({});
    expect(Object.keys(held(record).seen)).toHaveLength(42);

    site.main[60] = { ...site.main[60]!, update: SECONDS + 600 };
    site.main.push(synthetic(300, SECONDS + 1200));
    relay.requested.length = 0;
    await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(lists(false)).toEqual([0, 28].map((offset) => `/backend-api/conversations?offset=${offset}&limit=28&order=updated`));
    expect(fetched(5)).toEqual([site.main[70]!.id, site.main[60]!.id]);
    artifact(at.dir, "first-week.json", { facts: record.deliveries.map((delivery) => delivery.facts), lefts, from_ms: record.from_ms });
  });

  it("moving the start earlier weeks after the first poll fetches anything older than the new start, stops at pages the cursor holds before reaching it (in one page or across two), leaves the walk to the fetch, or walks the whole history again after", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.main = Array.from({ length: 100 }, (_, n) => synthetic(n, n < 60 ? SECONDS - (n + 1) * 3600 : SECONDS - 8 * DAY_S - (n - 60) * DAY_S));
    site.archived = [];
    site.projects = {};
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const seen = Object.fromEntries(site.main.slice(0, 60).map((chat) => [chat.id, iso(chat)]));
    const record = begun([CHATGPT_ACCOUNT, { first_ms: NOW }, { seen }]);
    const fetchedIn = (index: number) => record.deliveries[index]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path.slice(14, 50)).sort();
    const mainLists = (relay: FakeRelay) => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && !path.includes("is_archived")).length;

    const quiet = new FakeRelay(site);
    const week = lane(quiet, { pace_ms: 0 });
    expect(await polled(at, lend(chatgptBrowserAcquirer(week.settings, week.dependencies), week.dependencies), chatgptBrowserConnector, record)).toBeUndefined();
    expect(mainLists(quiet)).toBe(2);
    expect(record.from_ms).toBe(NOW - WEEK_MS);
    expect(record.changes).toEqual({ cleared: [], entries: [] });

    const deep = new FakeRelay(site);
    const thirty = lane(deep, { pace_ms: 0 }, NOW - 30 * 86_400_000);
    const later = NOW + 40 * 86_400_000;
    const on = { ...thirty.dependencies, now: () => later };
    const widened = lend(chatgptBrowserAcquirer(thirty.settings, on), on);
    expect(await polled(at, widened, chatgptBrowserConnector, record)).toBeUndefined();
    expect(mainLists(deep)).toBe(2);
    expect(held(record).place).toMatchObject({ first_ms: NOW, whole: true });
    expect(record.from_ms).toBe(NOW - 30 * 86_400_000);
    let clock = 0;
    const late = { ...thirty.dependencies, now: () => (clock++ === 0 ? later : later + 3 * 60 * 60_000) };
    const listing = await polled(at, lend(chatgptBrowserAcquirer(thirty.settings, late), late), chatgptBrowserConnector, record, "page");
    expect([listing?.delivery.files, listing?.delivery.facts.history, listing?.delivery.facts.left]).toEqual([[], true, null]);
    expect(record.left).toBeNull();
    expect(record.deliveries).toHaveLength(1);
    expect(held(record).place.history_listing).toEqual({ next: { list: 0, offset: 28, quiet: 0 } });
    expect(Object.keys(held(record).walked)).toHaveLength(28);
    const within = site.main.slice(60).filter((chat) => chat.update * 1000 >= NOW - 30 * 86_400_000);
    expect(within.length).toBe(23);
    const lefts: (number | null | undefined)[] = [];
    for (let page = 0; page < 3; page++) {
      await polled(at, widened, chatgptBrowserConnector, record, "page");
      lefts.push(record.left);
    }
    expect(lefts).toEqual([13, 3, 0]);
    expect([1, 2, 3].flatMap(fetchedIn).sort()).toEqual(within.map((chat) => chat.id).sort());
    expect(record.from_ms).toBe(NOW - 30 * 86_400_000);
    expect(held(record).place).not.toHaveProperty("whole");
    expect(held(record).place).not.toHaveProperty("history_listing");
    expect(held(record).walked).toEqual({});

    const after = new FakeRelay(site);
    const kept = lane(after, { pace_ms: 0 }, NOW - 30 * 86_400_000);
    const still = { ...kept.dependencies, now: () => later };
    expect(await polled(at, lend(chatgptBrowserAcquirer(kept.settings, still), still), chatgptBrowserConnector, record)).toBeUndefined();
    expect(mainLists(after)).toBe(2);
    const owed = await polled(at, lend(chatgptBrowserAcquirer(kept.settings, still), still), chatgptBrowserConnector, record, "page");
    expect([owed?.delivery.files, owed?.delivery.facts.left]).toEqual([[], 0]);
    expect(record.left).toBe(0);
    expect(record.deliveries).toHaveLength(5);
  });

  it("moving the start later fetches history below the new start, or counts it as left", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    site.main = Array.from({ length: 12 }, (_, n) => synthetic(n, n < 6 ? SECONDS - 3 * DAY_S - n * 60 : SECONDS - 10 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const backlog = Object.fromEntries(site.main.map((chat) => [chat.id, iso(chat)]));
    const first_ms = NOW - 2 * 86_400_000;
    const record = { ...begun([CHATGPT_ACCOUNT, { first_ms }, { owed: owedOf(backlog) }]), from_ms: NOW - 30 * 86_400_000 };
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record, "page");
    const fetched = record.deliveries[0]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path.slice(14, 50)).sort();
    expect(fetched).toEqual(site.main.slice(0, 6).map((chat) => chat.id).sort());
    expect(relay.requested.filter((path) => path.startsWith("/backend-api/conversation/"))).toHaveLength(6);
    expect(record.left).toBe(0);
    expect(held(record).place).toMatchObject({ first_ms });
    expect(held(record).owed).toEqual({});
    artifact(at.dir, "narrowed.json", { fetched, state: record.state, memory: held(record) });
  });

  it("a first call takes its cursor from the exports, and fetches only what they lack or hold older, or reaches past the week", async () => {
    const at = home();
    const site = new ChatgptSite();
    const [one, two] = site.main as [GptChat, GptChat];
    const [three] = site.archived as [GptChat];
    site.projects["g-p-synthetic0001"] = [{ ...site.projects["g-p-synthetic0001"]![0]!, update: SECONDS - 60 * DAY_S }];
    const exported = temp("connect-ai-export-");
    writeFileSync(join(exported, "conversations-000.json"), JSON.stringify([
      { conversation_id: one.id, update_time: one.update + 3.25 },
      { id: two.id, update_time: two.update },
      { conversation_id: three.id, update_time: three.update - 600 },
    ]));
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0, seed: [exported] });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record: PollRecord = { state: null, deliveries: [] };
    expect(await polled(at, acquirer, chatgptBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ seeded: 3, conversations: 0 });
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    const fetched = record.deliveries[0]!.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path).sort();
    expect(fetched).toEqual([`conversations/${three.id}.json`]);
    expect(record.left).toBe(0);
    expect(record.from_ms).toBe(NOW - WEEK_MS);
  });

  it("a cursor with a mixed backlog and media loses a conversation, fetches one twice, or a page takes more than ten, stops for a piece, or lists anew", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    const first_ms = NOW - 2 * 86_400_000;
    site.main = Array.from({ length: 30 }, (_, n) => synthetic(n, n < 14 ? SECONDS - (n + 1) * 3600 : SECONDS - 3 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const of = (from: number, to: number) => Object.fromEntries(site.main.slice(from, to).map((chat) => [chat.id, iso(chat)]));
    let clock = NOW;
    const relay = new FakeRelay(site);
    relay.start_ms = NOW - WEEK_MS;
    const settings: BrowserSettings = { work: temp("connect-ai-work-") };
    const dependencies = { relay, sleep: async (ms: number) => void (clock += ms), now: () => clock };
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const ids = (delivery: { files: { path: string }[] }) => delivery.files.filter((file) => file.path.startsWith("conversations/")).map((file) => file.path.slice(14, 50));
    const once = (record: PollRecord) => {
      const all = record.deliveries.flatMap(ids);
      expect(all.length, "a conversation fetched twice").toBe(new Set(all).size);
      return new Set(all);
    };

    const mixed = begun([CHATGPT_ACCOUNT, { first_ms }, { seen: of(25, 30), media: { "file-Old000": true }, owed: owedOf({ ...of(0, 3), ...of(14, 25) }) }]);
    const lists = () => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && !path.includes("is_archived"));
    await polled(at, acquirer, chatgptBrowserConnector, mixed);
    expect(ids(mixed.deliveries[0]!).sort()).toEqual(site.main.slice(0, 3).map((chat) => chat.id).sort());
    expect(lists()).toEqual([]);
    for (let fetch = 0; fetch < 4 && (fetch === 0 || mixed.next?.more === true); fetch++) await polled(at, acquirer, chatgptBrowserConnector, mixed);
    expect(mixed.next).toEqual({});
    expect(Object.keys(held(mixed).owed).sort()).toEqual(Object.keys(of(14, 25)).sort());
    const fetches = mixed.deliveries.length;
    const lefts: (number | null | undefined)[] = [];
    for (let page = 0; page < 2; page++) {
      const before = clock;
      await polled(at, acquirer, chatgptBrowserConnector, mixed, "page");
      lefts.push(mixed.left);
      if (page === 0) expect(clock - before).toBe(9 * 5_000);
    }
    expect(mixed.deliveries.slice(fetches).map((delivery) => ids(delivery))).toEqual([site.main.slice(14, 24).map((chat) => chat.id), [site.main[24]!.id]]);
    expect(lefts).toEqual([1, 0]);
    expect([...once(mixed)].sort()).toEqual(site.main.slice(0, 25).map((chat) => chat.id).sort());
    expect(held(mixed).place).toMatchObject({ first_ms });
    expect(held(mixed).media).toContain("file-Old000");

    artifact(at.dir, "mixed.json", { facts: mixed.deliveries.map((delivery) => delivery.facts), lefts });
  });

  it("a page drains the backlog while the whole walk's list is still open and says nothing is left, ending a walk it never finished", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    const first_ms = NOW - 2 * 86_400_000;
    site.main = Array.from({ length: 40 }, (_, n) => synthetic(n, SECONDS - 3 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const of = (from: number, to: number) => Object.fromEntries(site.main.slice(from, to).map((chat) => [chat.id, iso(chat)]));
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 }, NOW - 30 * 86_400_000);
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record = begun([
      CHATGPT_ACCOUNT, { whole: true, history_listing: { next: { list: 0, offset: 28, quiet: 0 } }, first_ms },
      { seen: of(0, 25), owed: owedOf(of(25, 28)), walked: of(0, 28) },
    ]);
    record.from_ms = NOW - 30 * 86_400_000;
    const lists = () => relay.requested.filter((path) => path.startsWith("/backend-api/conversations?") && !path.includes("is_archived"));
    const lefts: (number | null | undefined)[] = [];
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    lefts.push(record.left);
    expect(lists()).toEqual([]);
    expect(held(record).place.history_listing).toEqual({ next: { list: 0, offset: 28, quiet: 0 } });
    expect(held(record).walked).toEqual(of(0, 28));
    for (let page = 0; page < 2; page++) {
      await polled(at, acquirer, chatgptBrowserConnector, record, "page");
      lefts.push(record.left);
    }
    expect(lists()[0]).toBe("/backend-api/conversations?offset=28&limit=28&order=updated");
    expect(lefts).toEqual([null, 2, 0]);
    expect(Object.keys(held(record).seen).sort()).toEqual(site.main.map((chat) => chat.id).sort());
    expect(held(record).place).not.toHaveProperty("whole");
    expect(held(record).walked).toEqual({});
    artifact(at.dir, "open-walk.json", { lefts, facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a conversation the provider failed (a 503) on the last owed ends the walk without it, or a page tries more than ten", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    const first_ms = NOW - 2 * 86_400_000;
    site.main = Array.from({ length: 12 }, (_, n) => synthetic(n, SECONDS - 3 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const backlog = Object.fromEntries(site.main.map((chat) => [chat.id, iso(chat)]));
    const record = begun([CHATGPT_ACCOUNT, { first_ms }, { owed: owedOf(backlog) }]);
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const asked = (chat: GptChat) => relay.requested.filter((path) => path === `/backend-api/conversation/${chat.id}`).length;
    for (const chat of site.main.slice(0, 3)) site.queue(new RegExp(`^/backend-api/conversation/${chat.id}$`, "u"), { status: 404 });
    site.queue(new RegExp(`^/backend-api/conversation/${site.main[11]!.id}$`, "u"), ...Array.from({ length: 3 }, () => ({ status: 503 })));
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 7, skipped: 3 });
    expect(record.left).toBe(2);
    expect(asked(site.main[10]!)).toBe(0);
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    expect(record.deliveries[1]!.facts).toMatchObject({ conversations: 1, skipped: 1 });
    expect(record.left).toBe(1);
    expect(held(record).owed).toEqual({ [site.main[11]!.id]: { at: backlog[site.main[11]!.id], tries: 1 } });
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    expect(record.left).toBe(0);
    expect(held(record).owed).toEqual({});
    expect(Object.keys(held(record).seen).sort()).toEqual(site.main.slice(3).map((chat) => chat.id).sort());
    expect(site.main.slice(0, 3).map(asked)).toEqual([1, 1, 1]);
    artifact(at.dir, "outcomes.json", { facts: record.deliveries.map((delivery) => delivery.facts), requested: relay.requested });
  });

  it("history the provider keeps failing (a lasting 500) is owed for ever, keeps older history from being read, or is asked again once let go", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    const first_ms = NOW - 2 * 86_400_000;
    site.main = Array.from({ length: 12 }, (_, n) => synthetic(n, SECONDS - 3 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const backlog = Object.fromEntries(site.main.map((chat) => [chat.id, iso(chat)]));
    const record = begun([CHATGPT_ACCOUNT, { first_ms }, { owed: owedOf(backlog) }]);
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const asked = (chat: GptChat) => relay.requested.filter((path) => path === `/backend-api/conversation/${chat.id}`).length;
    for (const chat of site.main.slice(0, 10)) site.queue(new RegExp(`^/backend-api/conversation/${chat.id}$`, "u"), ...Array.from({ length: 30 }, () => ({ status: 500 })));
    const lefts: (number | null | undefined)[] = [];
    const calls: JsonObject[] = [];
    for (let page = 1; page <= 5; page++) {
      await polled(at, acquirer, chatgptBrowserConnector, record, "page");
      lefts.push(record.left);
      calls.push(record.facts!);
    }
    expect(calls.map((facts) => facts.conversations)).toEqual([0, 2, 0, 0, 0]);
    expect(calls.map((facts) => facts.skipped)).toEqual([10, 8, 10, 2, 0]);
    expect(record.deliveries.map((delivery) => delivery.files.length > 0)).toEqual([false, true, false, false, false]);
    expect(lefts).toEqual([12, 10, 2, 0, 0]);
    expect(site.main.slice(0, 10).map(asked)).toEqual(Array.from({ length: 10 }, () => 9));
    expect(held(record).owed).toEqual({});
    expect(Object.keys(held(record).seen).sort()).toEqual(site.main.slice(10).map((chat) => chat.id).sort());
    artifact(at.dir, "lasting.json", { lefts, calls });
  });

  it("a new conversation a fetch failed is lost once newer ones read push it below where the list ends, or is owed for ever", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    site.main = Array.from({ length: 60 }, (_, n) => synthetic(n, SECONDS - (n + 1) * 3600));
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record = chatgptBegun();
    const asked = (chat: GptChat) => relay.requested.filter((path) => path === `/backend-api/conversation/${chat.id}`).length;
    site.queue(new RegExp(`^/backend-api/conversation/${site.main[58]!.id}$`, "u"), ...Array.from({ length: 3 }, () => ({ status: 500 })));
    site.queue(new RegExp(`^/backend-api/conversation/${site.main[59]!.id}$`, "u"), ...Array.from({ length: 30 }, () => ({ status: 500 })));
    const calls: JsonObject[] = [];
    for (let fetch = 1; fetch <= 4; fetch++) {
      await polled(at, acquirer, chatgptBrowserConnector, record);
      calls.push(record.facts!);
    }
    expect(calls.map((facts) => facts.conversations)).toEqual([58, 1, 0, 0]);
    expect(calls.map((facts) => facts.skipped)).toEqual([2, 1, 1, 0]);
    expect(record.deliveries).toHaveLength(2);
    expect(held(record).seen[site.main[58]!.id]).toBeDefined();
    expect(held(record).seen[site.main[59]!.id]).toBeUndefined();
    expect([asked(site.main[58]!), asked(site.main[59]!)]).toEqual([4, 9]);
    expect(held(record).owed).toEqual({});
    artifact(at.dir, "fetch-owed.json", { calls, requested: relay.requested });
  });

  it("a provider that keeps limiting holds one call alone, seals an empty page, or loses the walk's place", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    const first_ms = NOW - 2 * 86_400_000;
    site.main = Array.from({ length: 3 }, (_, n) => synthetic(n, SECONDS - 3 * DAY_S - n * 60));
    const iso = (chat: GptChat): string => new Date(chat.update * 1000).toISOString();
    const backlog = Object.fromEntries(site.main.map((chat) => [chat.id, iso(chat)]));
    const record = begun([CHATGPT_ACCOUNT, { first_ms }, { owed: owedOf(backlog) }]);
    const { settings, dependencies } = lane(new FakeRelay(site), { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const limited = (chat: GptChat) => site.queue(new RegExp(`^/backend-api/conversation/${chat.id}$`, "u"), ...Array.from({ length: 6 }, () => ({ status: 429 })));
    limited(site.main[0]!);
    const waited = await polled(at, acquirer, chatgptBrowserConnector, record, "page").catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect((waited as NotYet).backoff_ms).toBe(NOW + 30 * 60_000);
    expect((waited as NotYet).next_ms).toBeUndefined();
    expect(record.deliveries).toHaveLength(0);
    expect(held(record).owed).toEqual(owedOf(backlog));
    limited(site.main[1]!);
    await polled(at, acquirer, chatgptBrowserConnector, record, "page");
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 1 });
    expect(record.next).toEqual({ backoff_ms: NOW + 30 * 60_000 });
    expect(record.left).toBe(2);
    site.queue(/^\/backend-api\/conversations\?offset=0&/u, ...Array.from({ length: 6 }, () => ({ status: 429 })));
    const listing = await polled(at, acquirer, chatgptBrowserConnector, record).catch((error: unknown) => error);
    expect((listing as NotYet).backoff_ms).toBe(NOW + 30 * 60_000);
    expect(record.deliveries).toHaveLength(1);
    artifact(at.dir, "held.json", { state: record.state, memory: held(record), facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("one fetch the page could not make (a reset connection) fails the whole poll, or is left out before it is asked again", async () => {
    const at = home();
    const site = new ChatgptSite();
    const relay = new FakeRelay(site);
    const { settings, dependencies, slept } = lane(relay, { pace_ms: 0 });
    const [oldest, second] = site.main as [GptChat, GptChat];
    site.queue(new RegExp(`^/backend-api/conversation/${second.id}$`, "u"), { status: 0, failed: true });
    site.queue(new RegExp(`^/backend-api/conversation/${oldest.id}$`, "u"), ...Array.from({ length: 3 }, () => ({ status: 0, failed: true as const })));
    const record = chatgptBegun();
    const first = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(slept).toEqual([...LIST_END, ...LIST_END, 5_000, 5_000, 10_000]);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 3, skipped: 1, more: false });
    expect(first!.landed).toMatchObject({ refused: 0, new: 12 });
    expect(first!.delivery.files.some((file) => file.path.includes(oldest.id))).toBe(false);
    await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(record.deliveries[1]!.facts).toMatchObject({ conversations: 1, skipped: 0 });

    const older = new FakeRelay(new ChatgptSite());
    const again = lane(older, { pace_ms: 0 });
    older.refusals = [{ op: "fetch", code: "PAGE_ERROR" }];
    const begun = chatgptBegun();
    const fetched = await lend(chatgptBrowserAcquirer(again.settings, again.dependencies), again.dependencies).fetch(begun.state, SECRETS, lentOver(begun));
    expect(fetched.facts).toMatchObject({ conversations: 4 });
    expect(again.slept[0]).toBe(5_000);
    artifact(at.dir, "page-error.json", { slept, facts: record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a conversation its connector would refuse is sealed, stopping every later import of the source", async () => {
    const at = home();
    const site = new ChatgptSite();
    const { settings, dependencies } = lane(new FakeRelay(site), { pace_ms: 0 });
    const broken = gptConversation(site.main[0]!);
    (broken.mapping as Record<string, unknown>)["not-a-uuid"] = { id: "not-a-uuid", parent: null, children: [], message: { id: "not-a-uuid", create_time: 1789000000 } };
    site.queue(new RegExp(`^/backend-api/conversation/${site.main[0]!.id}$`, "u"), { status: 200, body: broken }, { status: 200, body: "<html>synthetic error page</html>" });
    const record = chatgptBegun();
    const first = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 3, skipped: 1, more: false });
    expect(first!.delivery.files.some((file) => file.path.includes(site.main[0]!.id))).toBe(false);
    expect(await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ conversations: 0, skipped: 1 });
    const third = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(record.deliveries[1]!.facts).toMatchObject({ conversations: 1, skipped: 0 });
    expect(third!.landed).toMatchObject({ new: 4, refused: 0 });
  });

  it("a signed-out browser, or an account the stream does not read, is a plain failure, not the person's", async () => {
    for (const [change, reason] of [[(site: ChatgptSite) => void (site.signedOut = true), "signed-out"], [(site: ChatgptSite) => void (site.account = "user-someone-else"), "other-account"]] as const) {
      const site = new ChatgptSite();
      change(site);
      const relay = new FakeRelay(site);
      relay.accounts = { [CHATGPT_ACCOUNT]: true };
      const { settings, dependencies } = lane(relay);
      const record = chatgptBegun();
      const failure = await lend(chatgptBrowserAcquirer(settings, dependencies), dependencies).fetch(record.state, SECRETS, lentOver(record)).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(NeedsYou);
      expect((failure as NeedsYou).reason).toBe(reason);
    }
  });

  it("the survey's look at ChatGPT's sign-in and its reader's disagree: a page behind a bot check (its requests answered 403 by the check) reads as signed out at the survey, while the reader waits on the person and, the check passed, reads it signed in", async () => {
    const chatgpt = chromeSites(declarations()).find((site) => site.id === "chatgpt")!;
    class Checked extends ChatgptSite {
      checking = false;
      override answer(request: Parameters<ChatgptSite["answer"]>[0]) {
        return this.checking ? { status: 403, body: Buffer.from("<!DOCTYPE html><title>Just a moment...</title>") } : super.answer(request);
      }
    }
    const look = async (state: string, change: (site: Checked) => void) => {
      const site = new Checked();
      change(site);
      const { sites: [probed] } = await survey(stationsOver("https://door.example", "drive-token-synthetic", { fetch: new FakeRelay(site).fetch }), [chatgpt], () => "read");
      const relay = new FakeRelay(site);
      relay.accounts = { [CHATGPT_ACCOUNT]: true };
      const { settings, dependencies } = lane(relay);
      const record = chatgptBegun();
      const read = await lend(chatgptBrowserAcquirer(settings, dependencies), dependencies).fetch(record.state, SECRETS, lentOver(record))
        .then(() => "read", (error: unknown) => (error instanceof NeedsYou ? `needs ${error.reason}` : `failed ${String(error)}`));
      const said = probed!.signed_in === true ? "signed in" : probed!.signed_in === false ? "signed out" : "not known";
      return { state, survey: said, reader: read };
    };
    const looks = [
      await look("signed in", () => undefined),
      await look("signed out", (site) => void (site.signedOut = true)),
      await look("asks for a password", (site) => void (site.signals = { password: true })),
      await look("behind a bot check", (site) => {
        site.signals = { captcha: true };
        site.checking = true;
      }),
    ];
    expect(looks).toEqual([
      { state: "signed in", survey: "signed in", reader: "read" },
      { state: "signed out", survey: "signed out", reader: "needs signed-out" },
      { state: "asks for a password", survey: "signed out", reader: "needs password" },
      { state: "behind a bot check", survey: "not known", reader: "needs confirm" },
    ]);
    artifact(temp("connect-ai-signin-"), "looks.json", looks);
  });

  it("a media file of another account (403 user_mismatch on its link) says sign in, or stops the stream", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    site.mismatched.add("file-CdE456");
    const relay = new FakeRelay(site);
    const { settings, dependencies } = lane(relay, { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record = chatgptBegun();
    const first = await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 2, skipped: 0, more: false, media: 1 });
    expect(first!.landed).toMatchObject({ new: 8, refused: 0 });
    expect(at.heads(CHATGPT_BROWSER_SOURCE, ["chat"]).map((head) => head.key).sort()).toEqual(site.main.map((chat) => chat.id).sort());
    expect(first!.delivery.files.map((file) => file.path).filter((path) => path.endsWith(".dat"))).toEqual(["file_00bb22.dat"]);
    expect(held(record).media).toEqual(["file_00bb22"]);
    expect(site.downloads.filter((id) => id === "file-CdE456")).toHaveLength(1);

    relay.requested.length = 0;
    expect(await polled(at, acquirer, chatgptBrowserConnector, record)).toBeUndefined();
    expect(record.facts).toMatchObject({ conversations: 0, skipped: 0 });
    expect(relay.requested.filter((path) => path.includes("/files/download/"))).toEqual([]);

    const refusing = new ChatgptSite();
    refusing.linksRefused.add("file_00bb22");
    const lanes = lane(new FakeRelay(refusing));
    const sealed = chatgptBegun();
    const delivery = await poll(at, lend(chatgptBrowserAcquirer(lanes.settings, lanes.dependencies), lanes.dependencies), sealed, SECRETS, NOW);
    expect(delivery!.files.map((file) => file.path).filter((path) => path.endsWith(".dat"))).toEqual(["file-CdE456.dat"]);
    expect(held(sealed).media).toEqual(["file-CdE456"]);
    artifact(at.dir, "mismatch.json", { facts: record.deliveries.map((delivery) => delivery.facts), downloads: site.downloads });
  });

  it("an oversized media file stops the stream", async () => {
    const at = home();
    const site = new ChatgptSite();
    site.archived = [];
    site.projects = {};
    site.oversized.add("file_00bb22");
    const { settings, dependencies, slept } = lane(new FakeRelay(site), { pace_ms: 0 });
    const record = chatgptBegun();
    const first = await polled(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), chatgptBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 2, skipped: 0, more: false });
    expect(first!.landed).toMatchObject({ new: 8, refused: 0 });
    expect(first!.delivery.files.map((file) => file.path).filter((path) => path.endsWith(".dat"))).toEqual(["file-CdE456.dat"]);
    expect(held(record).media).toEqual(["file-CdE456"]);
    expect(slept).toEqual([...LIST_END, ...LIST_END]);
    artifact(at.dir, "oversized.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a session that lapses mid-poll is named this poll, or never", async () => {
    const listing = new ChatgptSite();
    listing.queue(/^\/backend-api\/conversations\?/u, { status: 401, body: { detail: "Unauthorized" } });
    const plain = lane(new FakeRelay(listing));
    const failed = await lend(chatgptBrowserAcquirer(plain.settings, plain.dependencies), plain.dependencies).fetch(null, SECRETS, LENT).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(NeedsYou);
    expect((failed as Error).message).toMatch(/answered 401 listing conversations/u);

    const at = home();
    const site = new ChatgptSite();
    let lapse = true;
    const answer = site.answer.bind(site);
    site.answer = (request) => {
      const answered = answer(request);
      if (lapse && request.url.pathname.startsWith("/backend-api/conversation/")) site.signedOut = true;
      return answered;
    };
    const { settings, dependencies } = lane(new FakeRelay(site), { pace_ms: 0 });
    const acquirer = lend(chatgptBrowserAcquirer(settings, dependencies), dependencies);
    const record = chatgptBegun();
    await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(record.deliveries[0]!.facts).toMatchObject({ conversations: 1, skipped: 3, more: false });
    expect(Object.keys(held(record).seen)).toHaveLength(1);
    const next = await poll(at, acquirer, record, SECRETS, NOW).catch((error: unknown) => error);
    expect(next).toBeInstanceOf(NeedsYou);
    expect((next as NeedsYou).reason).toBe("signed-out");
    expect((next as NeedsYou).says).toBe("Sign in to ChatGPT in Chrome");
    lapse = false;
    site.signedOut = false;
    await polled(at, acquirer, chatgptBrowserConnector, record);
    expect(record.deliveries.at(-1)!.facts).toMatchObject({ conversations: 3, skipped: 0 });
    expect(at.heads(CHATGPT_BROWSER_SOURCE, ["chat"])).toHaveLength(4);
    artifact(at.dir, "lapsed.json", record.deliveries.map((delivery) => delivery.facts));
  });

  it("a delivery of another account lands anything", async () => {
    const at = home();
    const { settings, dependencies } = lane(new FakeRelay(new ChatgptSite()), { max_conversations: 1 });
    const begun = chatgptBegun();
    const fetched = await lend(chatgptBrowserAcquirer(settings, dependencies), dependencies).fetch(begun.state, SECRETS, lentOver(begun));
    const files = Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));
    await expect(at.land(chatgptBrowserConnector, deliver(at, "chatgpt:user-someone-else:browser", files, fetched.facts))).rejects.toThrow(/me.json states user-synthetic0001; the source is chatgpt:user-someone-else:browser/u);
    await expect(at.land(chatgptBrowserConnector, deliver(at, `chatgpt:${CHATGPT_ACCOUNT}:export`, files, fetched.facts))).rejects.toThrow(Refused);
    expect(at.heads(CHATGPT_BROWSER_SOURCE, KINDS)).toEqual([]);
  });

  it("a conversation file it cannot read refuses more than itself", async () => {
    const at = home();
    const { settings, dependencies } = lane(new FakeRelay(new ChatgptSite()));
    const begun = chatgptBegun();
    const fetched = await lend(chatgptBrowserAcquirer(settings, dependencies), dependencies).fetch(begun.state, SECRETS, lentOver(begun));
    const files = Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));
    const conversations = Object.keys(files).filter((path) => path.startsWith("conversations/")).sort();
    expect(conversations.length).toBeGreaterThan(1);
    const landed = await at.land(chatgptBrowserConnector, deliver(at, CHATGPT_BROWSER_SOURCE, { ...files, [conversations[0]!]: Buffer.from("{\"conversation_id\":") }, fetched.facts));
    expect(landed.refusals).toEqual([{ kind: "file", key: conversations[0], violations: [expect.stringMatching(/JSON/u)] }]);
    expect(at.heads(CHATGPT_BROWSER_SOURCE, ["chat"])).toHaveLength(conversations.length - 1);
    artifact(at.dir, "refused.json", counts(landed));
  });
});

describe("a browser lane's cursor and memory", () => {
  const chats = (prefix: string, count: number): ClaudeChat[] =>
    Array.from({ length: count }, (_, n) => {
      const id = (last: string) => `${prefix}${n.toString(16).padStart(7, "0")}-0000-4000-8000-00000000000${last}`;
      const at = new Date(NOW - 3 * 86_400_000 + n * 1_000).toISOString();
      return {
        uuid: id("0"), name: `Synthetic browser chat ${n}`, created_at: at, updated_at: at,
        messages: [
          { uuid: id("a"), parent: null, sender: "human", text: `Synthetic question ${n}.`, at },
          { uuid: id("b"), parent: id("a"), sender: "assistant", text: `Synthetic answer ${n}.`, at },
        ],
      };
    });

  it("grows the cursor with history, fetches what it has after it, or writes memory on a call that found nothing new (N and 4N conversations in two accounts)", async () => {
    const OTHER = "22222222-2222-4222-8222-000000000000";
    const accounts = [[CLAUDE_ACCOUNT, "person-a@example.com", "a"], [OTHER, "person-b@example.com", "b"]] as const;
    const history = async (total: number) => {
      const at = home();
      const site = new ClaudeSite();
      const relay = new FakeRelay(site);
      relay.accounts = { [CLAUDE_ACCOUNT]: true, [OTHER]: true };
      const { settings, dependencies } = lane(relay, { pace_ms: 0, max_conversations: total });
      const acquirer = lend(claudeBrowserAcquirer(settings, dependencies), dependencies);
      const record = begun([CLAUDE_ACCOUNT, PLACE], [OTHER, PLACE]);
      const on = (account: string, email: string, prefix: string) => {
        site.account = account;
        site.email = email;
        site.chats = chats(prefix, total / 2);
      };
      for (const [account, email, prefix] of accounts) {
        on(account, email, prefix);
        await poll(at, acquirer, record, SECRETS, NOW);
        expect(record.deliveries.at(-1)!.facts).toMatchObject({ account, conversations: total / 2, more: false });
      }
      const cursor = Buffer.byteLength(canonical(record.state!));
      for (const [account, email, prefix] of accounts) {
        on(account, email, prefix);
        relay.requested.length = 0;
        expect(await poll(at, acquirer, record, SECRETS, NOW)).toBeUndefined();
        expect(relay.requested.filter((path) => /chat_conversations\/[^?]+\?tree/u.test(path))).toEqual([]);
        expect(record.changes).toEqual({ cleared: [], entries: [] });
        expect(Object.keys(held(record, account).seen)).toHaveLength(total / 2);
      }
      return { total, cursor, seen: accounts.map(([account]) => Object.keys(held(record, account).seen).length) };
    };
    const n = await history(500);
    const n4 = await history(2_000);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(home().dir, "bounded.json", { n, n4 });
  });

  it("a call that read a conversation, then waits on the provider's limit, marks it read or its media fetched", async () => {
    const at = home();
    const quiet = (): ChatgptSite => {
      const site = new ChatgptSite();
      site.archived = [];
      site.projects = {};
      return site;
    };
    const site = quiet();
    site.queue(/^\/backend-api\/estuary\/content/u, ...Array.from({ length: 12 }, () => ({ status: 429 })));
    const { settings, dependencies } = lane(new FakeRelay(site), { pace_ms: 0 });
    const record = chatgptBegun();
    const waited = await poll(at, lend(chatgptBrowserAcquirer(settings, dependencies), dependencies), record, SECRETS, NOW).catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect((waited as NotYet).reason).toBe("provider-limit");
    expect(record.deliveries).toHaveLength(0);
    expect([...new Set(record.changes!.entries.map(([part]) => part))]).toEqual([`owed:${CHATGPT_ACCOUNT}`]);
    expect([held(record).seen, held(record).media]).toEqual([{}, []]);
    expect(Object.keys(held(record).owed).sort()).toEqual(site.main.map((chat) => chat.id).sort());
    const again = lane(new FakeRelay(quiet()), { pace_ms: 0 });
    await poll(at, lend(chatgptBrowserAcquirer(again.settings, again.dependencies), again.dependencies), record, SECRETS, NOW);
    expect(Object.keys(held(record).seen).sort()).toEqual(site.main.map((chat) => chat.id).sort());
    expect(held(record).media).toContain("file_00bb22");
    expect(held(record).owed).toEqual({});
    artifact(at.dir, "wait-marks.json", { changes: record.changes, memory: held(record) });
  });
});
