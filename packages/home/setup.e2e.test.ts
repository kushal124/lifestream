import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { StreamsReport } from "./streams-report.js";
import { serveDoor } from "./door.js";
import { startHome } from "./home.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { basicInstant, openSealing } from "./inbox.js";
import { askHome } from "./socket.js";
import { effective } from "./settings.js";
import { editSettings, testSocket } from "./test/folder.js";
import { FAKES, LOOK_MS, makeRoot, OWN_SOURCES, readHome, REPO, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { DEVICE } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const MAC = "macbook-pro-0001";
const OTHER_MAC = "mac-mini-bb01";
const PHONE = "iphone-17-pro-aa01";
const STATION = "chrome-0a1b2c3d";
const GMAIL_ID = "gmail:person-a@example.com:cloud";

describe("device names and setup marks", () => {
  const roots: string[] = [];
  const summary: Record<string, unknown> = {};
  const artifact = (part: Record<string, unknown>) => Object.assign(summary, part);

  afterAll(() => {
    mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
    writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "setup.json"), `${JSON.stringify(summary, null, 2)}\n`);
    for (const root of roots) removeRoot(root);
  });

  it("names a device without moving its unit, keeps one mark per Mac and step, and reports both for the Mac asking", async () => {
    const root = makeRoot("lifestream-setup-", { sources: {} });
    roots.push(root);
    const principals = openHomeFolder(root);
    const reader = randomBytes(32).toString("base64url");
    mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: reader, now_ms: 0 });
    mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [`screen:local:${MAC}`], now_ms: 0 });
    mintPrincipal(principals, { unit: PHONE, kind: "phone", scopes: ["deliver", "read"], sources: [`location:local:${PHONE}`], now_ms: 0 });
    mintPrincipal(principals, { unit: STATION, kind: "extension", scopes: ["station"], now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    const port = door.port;
    editSettings(root, { "door.port": port });
    const home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const socket = testSocket(root);
    const verb = (name: string, ...args: string[]) => askHome(socket, name, args);
    const refusal = (name: string, ...args: string[]) => verb(name, ...args).then(() => "accepted", (error: Error) => error.message);
    const report = async (...args: string[]) => await verb("connectors", ...args) as StreamsReport;
    const served = async (query: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/connectors${query}`, { headers: { authorization: `Bearer ${reader}` } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const meta = (prefix: string) => readHome(root, (db) => db.prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key").all(`${prefix}%`)) as { key: string; value: string }[];
    try {
      await verb("device", "add", MAC, "--model", "MacBook Pro");
      await verb("device", "add", PHONE, "--model", "iPhone 17 Pro");
      const sources = () => readHome(root, (db) => db.prepare("SELECT id FROM sources ORDER BY id").pluck().all()) as string[];
      const units = () => readPrincipals(principals).principals.map((principal) => principal.unit).sort();
      const phonesNamed = (report: StreamsReport) => report.devices.filter((row) => row.kind === "phone").map(({ unit, name }) => [unit, name]);
      const before = { sources: sources(), units: units() };

      expect(phonesNamed(await report())).toEqual([[PHONE, "iPhone 17 Pro"]]);

      expect(await verb("device", "name", MAC, "Person A's MacBook Pro")).toEqual({ unit: MAC, name: "Person A's MacBook Pro" });
      expect(await verb("device", "name", PHONE, "  iPhone  ")).toEqual({ unit: PHONE, name: "iPhone" });
      await verb("device", "name", STATION, "Chrome · Work");
      await verb("device", "name", MAC, "Person A's Mac");
      const refused = {
        unknown: await refusal("device", "name", "iphone-zz99", "Old phone"),
        empty: await refusal("device", "name", PHONE, "   "),
        lines: await refusal("device", "name", PHONE, "two\nlines"),
        long: await refusal("device", "name", PHONE, "x".repeat(65)),
        skip_phone: await refusal("setup", "skip", PHONE, "iphone"),
        skip_step: await refusal("setup", "skip", MAC, "Skip Me"),
        skip_unknown: await refusal("setup", "skip", "macbook-pro-ffff", "iphone"),
      };
      expect(refused.unknown).toMatch(/no device iphone-zz99/u);
      expect(refused.empty).toMatch(/Type a name\./u);
      expect(refused.lines).toMatch(/A name is one line of text\./u);
      expect(refused.long).toMatch(/A name is at most 64 characters\./u);
      expect(refused.skip_phone).toMatch(/no Mac iphone-17-pro-aa01/u);
      expect(refused.skip_step).toMatch(/not a step's name/u);
      expect(refused.skip_unknown).toMatch(/no Mac macbook-pro-ffff/u);

      const named = await report();
      expect(phonesNamed(named)).toEqual([[PHONE, "iPhone"]]);
      expect({ sources: sources(), units: units() }).toEqual(before);
      expect(meta("name:")).toEqual([
        { key: `name:${STATION}`, value: "Chrome · Work" }, { key: `name:${PHONE}`, value: "iPhone" }, { key: `name:${MAC}`, value: "Person A's Mac" },
      ].sort((a, b) => a.key.localeCompare(b.key)));

      const first = await verb("setup", "skip", MAC, "iphone") as { at_ms: number };
      const second = await verb("setup", "skip", MAC, "iphone") as { at_ms: number };
      expect(second).toEqual(first);
      await verb("setup", "skip", MAC, "browser");
      expect(meta("setup:")).toEqual([{ key: `setup:${MAC}:browser`, value: expect.any(String) }, { key: `setup:${MAC}:iphone`, value: String(first.at_ms) }]);
      const events = readHome(root, (db) => db.prepare("SELECT kind, key, detail FROM events WHERE kind IN ('setup-skip', 'device-name') ORDER BY seq").all()) as { kind: string; key: string; detail: string }[];
      expect(events.filter((event) => event.kind === "setup-skip").map((event) => JSON.parse(event.detail).step)).toEqual(["iphone", "browser"]);

      expect((await report()).setup?.at).toBeNull();
      expect(await verb("setup", "at", MAC, "browser")).toEqual({ unit: MAC, at: "browser" });
      expect(await verb("setup", "at", MAC, "accounts")).toEqual({ unit: MAC, at: "accounts" });
      expect(await refusal("setup", "at", MAC, "Not A Screen")).toMatch(/not a screen's name/u);
      expect(meta("setup-at:")).toEqual([{ key: `setup-at:${MAC}`, value: "accounts" }]);

      const marks = { skipped: ["browser", "iphone"], at: "accounts", you: false };
      expect((await report()).setup).toEqual(marks);
      expect((await report("--unit", MAC)).setup).toEqual(marks);
      expect((await report("--unit", OTHER_MAC)).setup).toEqual({ skipped: [], at: null, you: false });
      expect(await refusal("connectors", "on", GMAIL_ID, "--unit", MAC)).toMatch(/takes no --unit/u);
      const door = { plain: await served(""), named: await served(`?unit=${MAC}`), other: await served(`?unit=${OTHER_MAC}`), bad: await served("?unit=Not%20a%20unit") };
      expect([door.plain.body.setup, door.named.body.setup, door.other.body.setup]).toEqual([marks, marks, { skipped: [], at: null, you: false }]);
      expect(phonesNamed(door.plain.body as unknown as StreamsReport)).toEqual(phonesNamed(named));
      expect([door.bad.status, door.bad.body.code]).toEqual([422, "BAD_PARAMETER"]);

      mintPrincipal(principals, { unit: OTHER_MAC, kind: "mac", scopes: ["deliver"], sources: [`screen:local:${OTHER_MAC}`], now_ms: 0 });
      expect((await report()).setup).toBeNull();
      expect((await report("--unit", MAC)).setup).toEqual(marks);
      expect((await served("")).body.setup).toBeNull();

      artifact({ names: meta("name:"), setup: marks, refused, events });
    } finally {
      await home.stop();
      await door.close();
    }
  });

  it("names a phone by the name it stated at pairing, through the one writer of a name", async () => {
    const root = makeRoot("lifestream-setup-pair-", { sources: {} });
    roots.push(root);
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    const port = door.port;
    editSettings(root, { "door.port": port });
    const home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const socket = testSocket(root);
    const verb = (name: string, ...args: string[]) => askHome(socket, name, args);
    const report = async () => await verb("connectors") as StreamsReport;
    const nameOf = async (unit: string) => (await report()).devices.find((row) => row.unit === unit)?.name;
    const pass = () => randomBytes(32).toString("base64url");
    const pair = async (body: Record<string, unknown>) => {
      const { code } = await verb("pair", "--account", "person-a@example.com") as { code: string };
      const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, { method: "POST", headers: { ...DEVICE.phone, "content-type": "application/json" },
        body: JSON.stringify({ code, kind: "phone", model: "iPhone 17 Pro", account: "person-a@example.com", ...body }) });
      return { status: response.status, body: await response.json() as { unit: string } };
    };
    try {
      const firstPass = pass();
      const renamed = await pair({ pass: firstPass, name: "  Person A's iPhone  " });
      expect(renamed.status).toBe(200);
      const first = renamed.body.unit;
      expect((await nameOf(first))).toBe("Person A's iPhone");
      const events = readHome(root, (db) => db.prepare("SELECT key, detail FROM events WHERE kind = 'device-name' ORDER BY seq").all()) as { key: string; detail: string }[];
      expect(events.map(({ key, detail }) => [key, JSON.parse(detail).name])).toEqual([[first, "Person A's iPhone"]]);

      const odd = await pair({ pass: pass(), name: "two\nlines", new: true });
      expect(odd.status).toBe(200);
      expect((await nameOf(odd.body.unit))).toBe("iPhone 17 Pro");

      await verb("device", "name", first, "Kitchen phone");
      const retried = await pair({ pass: firstPass, name: "Person A's iPhone" });
      expect([retried.status, retried.body.unit]).toEqual([200, first]);
      expect((await nameOf(first))).toBe("Kitchen phone");
      artifact({ paired_names: { renamed: "Person A's iPhone", odd: "iPhone 17 Pro" } });
    } finally {
      await home.stop();
      await door.close();
    }
  });

  it("turns a row off before anything of it arrived, and every source of it as it appears; on again, what waited imports", async () => {
    const root = makeRoot("lifestream-setup-off-", { sources: {} });
    roots.push(root);
    const principals = openHomeFolder(root);
    const SCREEN = `screen:local:${MAC}`;
    const MESSAGES = `imessage:person-a@example.com:${MAC}`;
    const MAC_TIMELINE = `screen-time:person-a@example.com:${MAC}`;
    const PHONE_TIMELINE = `screen-time:local:${PHONE}`;
    const CHATGPT = "chatgpt:person-a@example.com:browser";
    const FIRST_PROFILE = `chrome:default:${MAC}`;
    const SECOND_PROFILE = `chrome:profile-2:${MAC}`;
    const { token: macToken } = mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [SCREEN, MESSAGES, MAC_TIMELINE, FIRST_PROFILE, SECOND_PROFILE], now_ms: 0 });
    const { token: phoneToken } = mintPrincipal(principals, { unit: PHONE, kind: "phone", scopes: ["deliver"], sources: [PHONE_TIMELINE], now_ms: 0 });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    const port = door.port;
    editSettings(root, { "door.port": port });
    const home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const socket = testSocket(root);
    const verb = (name: string, ...args: string[]) => askHome(socket, name, args);
    const said = async (...args: string[]) => {
      const lines: string[] = [];
      await askHome(socket, "connectors", args, (line) => lines.push(line));
      return lines.join("\n");
    };
    const off = () => effective(root).settings.sources.off;
    const rows = async () => Object.fromEntries((await verb("connectors") as StreamsReport).connectors
      .filter((connector) => ["screen", "imessage", "screen-time", "chatgpt"].includes(connector.id))
      .map((connector) => [connector.id, { on: connector.on, sources: connector.copies.map(({ id, on }) => ({ id, on })) }]));
    const answered = async (token: string, device: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "lifestream-device": device, "content-type": "application/json" }, body: "{}",
      });
      return Object.keys((await response.json() as { sources: Record<string, unknown> }).sources).sort();
    };
    const state = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) as string;
    const ended = (since: number) => readHome(root, (db) => db.prepare("SELECT 1 FROM jobs WHERE kind = 'import' AND key = ? AND state = 'done' AND ended_ms >= ?").get(CHATGPT, since)) !== undefined;
    try {
      expect(await said("off", "imessage")).toBe("imessage is off");
      await verb("connectors", "off", "screen-time");
      await verb("connectors", "off", "chatgpt");
      expect(await said("off", SECOND_PROFILE)).toBe(`${SECOND_PROFILE} is off`);
      const refused = await verb("connectors", "off", "not-a-row").then(() => "accepted", (error: Error) => error.message);
      expect(refused).toMatch(/is neither a connector/u);
      expect(off()).toEqual(["chatgpt", SECOND_PROFILE, "imessage", "screen-time"]);
      expect((await verb("connectors") as StreamsReport).off).toEqual(off());
      const before = await rows();
      expect(before).toEqual({
        screen: { on: true, sources: [{ id: SCREEN, on: true }] }, imessage: { on: false, sources: [] }, "screen-time": { on: false, sources: [{ id: PHONE_TIMELINE, on: false }] },
        "chatgpt": { on: false, sources: [] },
      });

      const passed = (unit: string) => readPrincipals(principals).principals.find((principal) => principal.unit === unit)!.sources;
      expect(await answered(macToken, DEVICE.mac["lifestream-device"])).toEqual([]);
      await verb("setup", "skip", MAC, "found");
      const macAnswered = await answered(macToken, DEVICE.mac["lifestream-device"]);
      const phoneAnswered = await answered(phoneToken, "phone/1.0");
      expect(macAnswered).toContain(SCREEN);
      expect(macAnswered).toContain(FIRST_PROFILE);
      expect(macAnswered).toEqual(passed(MAC).filter((id) => ![MESSAGES, MAC_TIMELINE, SECOND_PROFILE].includes(id)).sort());
      expect(phoneAnswered).not.toContain(PHONE_TIMELINE);
      expect(phoneAnswered).toEqual(passed(PHONE).filter((id) => id !== PHONE_TIMELINE && !OWN_SOURCES.includes(id)).sort());

      await verb("source", "add", CHATGPT, "--connector", "fake-rows", "--options", JSON.stringify({ lane: "chatgpt-browser" }));
      const at = Date.now();
      const kept = await ship(root, { source: CHATGPT, fetched_ms: at - 1_000, rows: [{ kind: "note", key: "c1", content: { text: "synthetic", at: at - 1_000 }, at: at - 1_000 }] });
      await until("the off source's import ran", () => ended(at) && state(kept) === "sealed");
      expect((await rows())["chatgpt"]).toEqual({ on: false, sources: [{ id: CHATGPT, on: false }] });

      expect(await said("on", CHATGPT)).toBe(`${CHATGPT} stays off: chatgpt is off`);
      await verb("connectors", "off", CHATGPT);
      expect(off()).toEqual(["chatgpt", CHATGPT, SECOND_PROFILE, "imessage", "screen-time"]);
      expect(await said("on", "chatgpt")).toBe("chatgpt is on\nChatGPT is chosen: no browser runs the extension now, and each hears it as it comes");
      expect(off()).toEqual([CHATGPT, SECOND_PROFILE, "imessage", "screen-time"]);
      expect(await said("on", CHATGPT)).toBe(`${CHATGPT} is on`);
      expect(off()).toEqual([SECOND_PROFILE, "imessage", "screen-time"]);
      expect((await verb("connectors") as StreamsReport).off).toEqual([SECOND_PROFILE, "imessage", "screen-time"]);
      await until("what waited imported", () => state(kept) === "imported");
      const after = await rows();
      expect(after["chatgpt"]).toEqual({ on: true, sources: [{ id: CHATGPT, on: true }] });
      artifact({ rows_off: { off: ["chatgpt", SECOND_PROFILE, "imessage", "screen-time"], before, refused, mac_answered: macAnswered, phone_answered: phoneAnswered, after } });
    } finally {
      await home.stop();
      await door.close();
    }
  });

  it("answers a Mac paired at Set up with no source until its person moves past Found, and a Mac that has shipped as before", async () => {
    const root = makeRoot("lifestream-setup-found-", { sources: {} });
    roots.push(root);
    const principals = openHomeFolder(root);
    const { token: fresh } = mintPrincipal(principals, { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [`screen:local:${MAC}`], now_ms: 0 });
    const { principal: oldPass, token: old } = mintPrincipal(principals, { unit: OTHER_MAC, kind: "mac", scopes: ["deliver"], sources: [`screen:local:${OTHER_MAC}`], now_ms: 0 });
    const at = new Date(Date.now() - 60_000).toISOString();
    const sealing = openSealing(openHomeFolder(root), { source: `screen:local:${OTHER_MAC}`, name: basicInstant(at), feeder: "fake-rows", fetched_at: at });
    sealing.seal({}, undefined, { pass: oldPass.id, sealed_at: at, custody: { [`screen:local:${OTHER_MAC}`]: { seal: 1 } } });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    const port = door.port;
    editSettings(root, { "door.port": port });
    const home = await startHome(root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, log: () => undefined });
    const answered = async (token: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac, "content-type": "application/json" }, body: "{}",
      });
      return Object.keys((await response.json() as { sources: Record<string, unknown> }).sources).sort();
    };
    const passed = (unit: string) => [...readPrincipals(principals).principals.find((principal) => principal.unit === unit)!.sources].sort();
    try {
      const held = await answered(fresh);
      const shipped = await answered(old);
      await askHome(testSocket(root), "setup", ["skip", MAC, "iphone"]);
      const otherStep = await answered(fresh);
      await askHome(testSocket(root), "setup", ["skip", MAC, "found"]);
      const released = await answered(fresh);
      expect({ held, otherStep, released, shipped }).toEqual({ held: [], otherStep: [], released: passed(MAC), shipped: passed(OTHER_MAC) });
      expect(released).toContain(`screen:local:${MAC}`);
      artifact({ found: { held, released, shipped } });
    } finally {
      await home.stop();
      await door.close();
    }
  });
});
