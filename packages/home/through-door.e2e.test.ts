import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { serveDoor } from "./door.js";
import { startHome, type Home } from "./home.js";
import { readSealed } from "./inbox.js";
import { mintPrincipal } from "./principals.js";
import { askHome, serveSocket } from "./socket.js";
import { fakeDeclarations } from "./test/fakes.js";
import { editSettings, testSocket } from "./test/folder.js";
import { FAKES, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { acquisitionBundle, DEVICE, healthLine, INSTALL_TWO, phoneBundle } from "./test/support.js";
import { COAST_SOURCE, HOUR, MAC_SOURCE, MINUTE, PHONE_OTHER, PHONE_SOURCE, stated, value } from "./test/through.js";
import { keptKey, waitingKey, type Value } from "./through.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const MAC_UNIT = "macbook-pro-0001";
const OTHER_MAC = "macbook-air-bb01";
const PHONE_UNIT = "iphone-aa01";
const PHONE_LANE = `phone:${PHONE_UNIT}`;
const MOTION = `motion:local:${PHONE_UNIT}`;
const MACHINE = `machine:local:${MAC_UNIT}`;
const NOTES = `apple-notes:local:${MAC_UNIT}`;
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };

type Answer = { status: number; body: Record<string, unknown> };

async function call(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<Answer> {
  const response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function folder(prefix: string): string {
  const root = makeRoot(prefix, { sources: { [MAC_SOURCE]: "fake-rows", [COAST_SOURCE]: "fake-rows", [MACHINE]: "fake-rows", [PHONE_SOURCE]: "fake-rows", [PHONE_OTHER]: "fake-rows" } });
  onTestFinished(() => removeRoot(root));
  return root;
}

interface Pass {
  readonly id: string;
  readonly headers: Record<string, string>;
}

function pass(root: string, unit: string, kind: "mac" | "phone", sources: readonly string[]): Pass {
  const { principal, token } = mintPrincipal(openHomeFolder(root), { unit, kind, scopes: ["deliver"], sources: [...sources], now_ms: Date.now() });
  return { id: principal.id, headers: { authorization: `Bearer ${token}`, ...DEVICE[kind] } };
}

interface Door {
  readonly url: string;
  readonly logs: string[];
  close(): Promise<void>;
}

async function door(root: string): Promise<Door> {
  const logs: string[] = [];
  const served = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: (line) => logs.push(line), floors: FLOORS, registry: FAKES, connectors: fakeDeclarations() });
  editSettings(root, { "door.port": served.port });
  let closed = false;
  const close = async () => {
    if (!closed) await served.close();
    closed = true;
  };
  onTestFinished(close);
  return { url: `http://127.0.0.1:${served.port}`, logs, close };
}

async function recording(root: string): Promise<JsonObject[]> {
  const heard: JsonObject[] = [];
  const server = await serveSocket(testSocket(root).path, async (request) => {
    heard.push(request);
    return null;
  });
  onTestFinished(() => server.close());
  return heard;
}

const exchange = (at: Door, by: Pass, body: Record<string, unknown>): Promise<Answer> =>
  call(at.url, "POST", "/v1/exchange", { ...by.headers, "content-type": "application/json" }, JSON.stringify(body));

const told = (heard: readonly JsonObject[]): JsonObject[] => heard.filter((request) => request.verb === "through").map((request) => request.values as JsonObject);

function waitingSince(root: string, by: Pass): number | null {
  const db = new Database(join(root, "door", "stated.db"), { readonly: true });
  try {
    return (db.prepare("SELECT waiting_since_ms FROM stated WHERE pass = ?").pluck().get(by.id) as number | null | undefined) ?? null;
  } finally {
    db.close();
  }
}

const leftOut = (at: Door): JsonObject[] => at.logs.map((line) => JSON.parse(line) as JsonObject).filter((line) => line.left_out !== undefined);

function macBundle(source: string, seal: number, fetched_ms: number, manifest?: (stated: Record<string, unknown>) => Record<string, unknown>) {
  return acquisitionBundle({
    source, fetched_ms, files: [["rows.ndjson", Buffer.from(`${JSON.stringify({ time: fetched_ms })}\n`)]], custody: { [source]: { seal } },
    ...(manifest === undefined ? {} : { manifest }),
  });
}

const BASE = Date.now() - HOUR;
const STARTED = Date.UTC(2025, 10, 1);
const at = (minutes: number, more: { left?: number; start_ms?: number | null } = {}): Value => value(BASE + minutes * MINUTE - MINUTE, BASE + minutes * MINUTE, more);

describe("the door takes a device's read-through", () => {
  it("D1: an exchange beside an upload counts the seal the upload made first", async () => {
    const root = folder("lifestream-through-d1-");
    const mac = pass(root, MAC_UNIT, "mac", [MAC_SOURCE]);
    const front = await door(root);
    const heard = await recording(root);
    const first = at(1);
    expect((await exchange(front, mac, {})).status).toBe(200);
    expect(waitingSince(root, mac)).not.toBeNull();
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: stated(first) } })).status).toBe(200);
    expect(waitingSince(root, mac)).toBeNull();
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: stated(first) } })).status).toBe(200);
    expect(waitingSince(root, mac)).not.toBeNull();
    await until("both relays of the first value told", () => told(heard).length === 2);
    const bundle = macBundle(MAC_SOURCE, 1, BASE, (manifest) => ({ ...manifest, received: { [MAC_SOURCE]: { [mac.id]: 9 } } }));
    expect((await call(front.url, "PUT", bundle.path, mac.headers, bundle.bytes)).status).toBe(201);
    const second = at(2, { left: 3, start_ms: STARTED });
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: stated(second) } })).status).toBe(200);
    expect(waitingSince(root, mac)).toBeNull();
    await until("the second value told", () => told(heard).length === 3);
    expect(told(heard)).toEqual([
      { [MAC_SOURCE]: { value: first, received: {} } },
      { [MAC_SOURCE]: { value: first, received: {} } },
      { [MAC_SOURCE]: { value: second, received: { [mac.id]: 1 } } },
    ]);
    const sealed = readSealed(openHomeFolder(root), join(root, "inbox", MAC_SOURCE, bundle.id.split("/")[1]!))!;
    expect(sealed.received).toBeUndefined();
  });

  it("D2: a value the door cannot take is left out, logged once, and the rest of the exchange is answered", async () => {
    const root = folder("lifestream-through-d2-");
    const mac = pass(root, MAC_UNIT, "mac", [MAC_SOURCE, COAST_SOURCE, MACHINE, NOTES]);
    editSettings(root, { "sources.off": [COAST_SOURCE] });
    const front = await door(root);
    const heard = await recording(root);
    const good = at(1);
    const through = {
      [MAC_SOURCE]: stated(good),
      [COAST_SOURCE]: stated(at(1)),
      [PHONE_SOURCE]: stated(at(1)),
      [MACHINE]: stated(value(Date.now(), Date.now() + 11 * MINUTE)),
      [NOTES]: stated(value(BASE + MINUTE, BASE)),
    };
    for (const grant of ["on", "off", "on"] as const) {
      const answer = await exchange(front, mac, { grants: { screen: grant }, through });
      expect([answer.status, answer.body.pass]).toEqual([200, mac.id]);
    }
    await until("the good value told at each exchange", () => told(heard).length === 3);
    expect(told(heard)).toEqual(Array.from({ length: 3 }, () => ({ [MAC_SOURCE]: { value: good, received: {} } })));
    await until("the grant told", () => heard.some((request) => request.verb === "stated"));
    expect(leftOut(front).map(({ through: source, left_out }) => [source, left_out]).sort()).toEqual([
      [COAST_SOURCE, "not-delivered"], [MACHINE, "clock-ahead"], [NOTES, "read-after-stated"], [PHONE_SOURCE, "not-delivered"],
    ].sort());
    await exchange(front, mac, { through: { [NOTES]: stated(at(2)) } });
    await until("the good value of the notes told", () => told(heard).length === 4);
    await exchange(front, mac, { through: { [NOTES]: stated(value(BASE + MINUTE, BASE)) } });
    expect(leftOut(front).filter(({ through: source }) => source === NOTES)).toHaveLength(2);
    const wire = stated(good);
    for (const bad of [
      [], { [MAC_SOURCE]: "now" }, { "not a source": wire }, { [MAC_SOURCE]: { ...wire, stated_at: undefined } },
      { [MAC_SOURCE]: { ...wire, read_through: "yesterday" } }, { [MAC_SOURCE]: { ...wire, left: -1 } }, { [MAC_SOURCE]: { ...wire, left: 1.5 } },
      { [MAC_SOURCE]: { ...wire, start_ms: "2025-11-01" } }, { [MAC_SOURCE]: { ...wire, owed: 1 } },
    ]) {
      const answer = await exchange(front, mac, { through: bad });
      expect([answer.status, answer.body.code]).toEqual([422, "BAD_REQUEST"]);
    }
    expect(told(heard)).toHaveLength(4);
  });

  it("D3: a pass replaced between two exchanges tells the first one's value and not the second's", async () => {
    const root = folder("lifestream-through-d3-");
    const old = pass(root, MAC_UNIT, "mac", [MAC_SOURCE]);
    const front = await door(root);
    const heard = await recording(root);
    expect((await exchange(front, old, { through: { [MAC_SOURCE]: stated(at(1)) } })).status).toBe(200);
    await until("the first pass's value told", () => told(heard).length === 1);
    const next = pass(root, MAC_UNIT, "mac", [MAC_SOURCE]);
    const bundle = macBundle(MAC_SOURCE, 1, BASE);
    expect((await call(front.url, "PUT", bundle.path, next.headers, bundle.bytes)).status).toBe(201);
    const replaced = await exchange(front, old, { through: { [MAC_SOURCE]: stated(at(3)) } });
    expect([replaced.status, typeof replaced.body.replaced]).toEqual([200, "string"]);
    expect((await exchange(front, old, { through: { [MAC_SOURCE]: "now" } })).status).toBe(422);
    expect((await exchange(front, next, { through: { [MAC_SOURCE]: stated(at(2)) } })).status).toBe(200);
    await until("the new pass's value told", () => told(heard).length === 2);
    expect(told(heard)).toEqual([
      { [MAC_SOURCE]: { value: at(1), received: {} } },
      { [MAC_SOURCE]: { value: at(2), received: { [next.id]: 1 } } },
    ]);
    expect(leftOut(front)).toEqual([]);
  });

  it("D4: a phone shipment's stamp states what was sealed of each source it is quiet for, for a pass not replaced", async () => {
    const root = folder("lifestream-through-d4-");
    const sources = [PHONE_LANE, PHONE_SOURCE, PHONE_OTHER, MOTION];
    const first = pass(root, PHONE_UNIT, "phone", sources);
    const front = await door(root);
    await recording(root);
    const ship = async (by: Pass, bundle: { id: string; bytes: Buffer }) => {
      const answer = await call(front.url, "PUT", `/v1/bundles/${bundle.id}`, by.headers, bundle.bytes);
      expect(answer.status, JSON.stringify(answer.body)).toBe(201);
      return readSealed(openHomeFolder(root), join(root, "inbox", PHONE_LANE, bundle.id))!.received;
    };
    expect(await ship(first, phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [PHONE_SOURCE]: { seal: 1 } }, satOut: [MOTION], second: 1 })))
      .toEqual({ [PHONE_OTHER]: {} });
    expect(await ship(first, phoneBundle({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [PHONE_OTHER]: { seal: 1 } }, second: 2 })))
      .toEqual({ [PHONE_SOURCE]: { [first.id]: 1 }, [MOTION]: {} });
    editSettings(root, { "sources.off": [MOTION] });
    expect(await ship(first, phoneBundle({ domains: { "location.jsonl": [2] }, custody: { [PHONE_SOURCE]: { seal: 2 } }, second: 3 })))
      .toEqual({ [PHONE_OTHER]: { [first.id]: 1 } });
    const second = pass(root, PHONE_UNIT, "phone", sources);
    expect(await ship(second, phoneBundle({ domains: { "location.jsonl": [1] }, custody: { [PHONE_SOURCE]: { seal: 1 } }, install: INSTALL_TWO, second: 4 })))
      .toEqual({ [PHONE_OTHER]: { [first.id]: 1 } });
    expect(await ship(first, phoneBundle({ entries: { "health.jsonl": [healthLine(2)] }, custody: { [PHONE_OTHER]: { seal: 2 } }, second: 5 }))).toBeUndefined();
    expect(await ship(second, phoneBundle({ entries: { "health.jsonl": [healthLine(1)] }, custody: { [PHONE_OTHER]: { seal: 1 } }, install: INSTALL_TWO, second: 6 })))
      .toEqual({ [PHONE_SOURCE]: { [first.id]: 2, [second.id]: 1 } });
  });

  it("D7: a value read under a seal the door has not received from the stating pass is left out, logged once, and taken once that seal is there", async () => {
    const root = folder("lifestream-through-d7-");
    const mac = pass(root, MAC_UNIT, "mac", [MAC_SOURCE]);
    const other = pass(root, OTHER_MAC, "mac", [MAC_SOURCE]);
    const front = await door(root);
    const heard = await recording(root);
    const under = (of: Value, seal: number) => ({ ...stated(of), seal });
    const first = macBundle(MAC_SOURCE, 1, BASE);
    expect((await call(front.url, "PUT", first.path, mac.headers, first.bytes)).status).toBe(201);
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: under(at(1), 2) } })).status).toBe(200);
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: under(at(1), 2) } })).status).toBe(200);
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: under(at(2), 1) } })).status).toBe(200);
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: stated(at(3)) } })).status).toBe(200);
    expect((await exchange(front, other, { through: { [MAC_SOURCE]: under(at(4), 1) } })).status).toBe(200);
    const second = macBundle(MAC_SOURCE, 2, BASE + MINUTE);
    expect((await call(front.url, "PUT", second.path, mac.headers, second.bytes)).status).toBe(201);
    expect((await exchange(front, mac, { through: { [MAC_SOURCE]: under(at(5), 2) } })).status).toBe(200);
    await until("the three values taken told", () => told(heard).length === 3);
    expect(told(heard)).toEqual([
      { [MAC_SOURCE]: { value: at(2), received: { [mac.id]: 1 } } },
      { [MAC_SOURCE]: { value: at(3), received: { [mac.id]: 1 } } },
      { [MAC_SOURCE]: { value: at(5), received: { [mac.id]: 2 } } },
    ]);
    expect(leftOut(front).map(({ through: source, pass: by, left_out }) => [source, by, left_out])).toEqual([
      [MAC_SOURCE, mac.id, "seal-ahead"], [MAC_SOURCE, other.id, "seal-ahead"],
    ]);
    for (const seal of [0, -1, 1.5, "2", null]) {
      const answer = await exchange(front, mac, { through: { [MAC_SOURCE]: { ...stated(at(6)), seal } } });
      expect([answer.status, answer.body.code]).toEqual([422, "BAD_REQUEST"]);
    }
    expect(told(heard)).toHaveLength(3);
  });
});

describe("the home's writer takes what the door tells it", () => {
  const held = (root: string, source: string) => readHome(root, (db) => ({
    kept: db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(keptKey(source)) ?? null,
    waiting: db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(waitingKey(source)) ?? null,
    read_through_ms: db.prepare("SELECT read_through_ms FROM sources WHERE id = ?").pluck().get(source) ?? null,
  }));
  const start = (root: string) => startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, slot: null, log: () => undefined });

  it("D5: the same statement again changes nothing, across a home's restart and a door's, applied and waiting; a lost relay is the next exchange's", async () => {
    const root = folder("lifestream-through-d5-");
    const mac = pass(root, MAC_UNIT, "mac", [MAC_SOURCE, COAST_SOURCE, MACHINE]);
    let front = await door(root);
    let home: Home | null = await start(root);
    onTestFinished(async () => { await home?.stop(); });
    const restart = async () => {
      await home!.stop();
      home = await start(root);
      await front.close();
      front = await door(root);
    };
    let relays = 0;
    const relayed = async (values: Record<string, Value>) => {
      const mark = value(BASE + ++relays * 1_000);
      const through = Object.fromEntries([...Object.entries(values), [MACHINE, mark] as const].map(([source, each]) => [source, stated(each)]));
      expect((await exchange(front, mac, { through })).status).toBe(200);
      await until(`relay ${relays} committed`, () => held(root, MACHINE).read_through_ms === mark.read_through_ms);
    };

    const applied = at(1, { left: 5, start_ms: STARTED });
    await relayed({ [MAC_SOURCE]: applied });
    const once = held(root, MAC_SOURCE);
    expect(once.read_through_ms).toBe(applied.read_through_ms);
    expect(JSON.parse(once.kept as string)).toMatchObject({ applied: { read_through_ms: applied.read_through_ms, stated_ms: applied.stated_ms }, left: { left: 5, start_ms: STARTED, from: "value" } });
    expect(once.waiting).toBeNull();
    await relayed({ [MAC_SOURCE]: applied });
    await restart();
    await relayed({ [MAC_SOURCE]: applied });
    expect(held(root, MAC_SOURCE)).toEqual(once);

    await askHome(testSocket(root), "pause", ["kind:import", "--reason", "a test"]);
    const bundle = macBundle(MAC_SOURCE, 1, BASE);
    expect((await call(front.url, "PUT", bundle.path, mac.headers, bundle.bytes)).status).toBe(201);
    const waits = at(2);
    await relayed({ [MAC_SOURCE]: waits });
    const kept = held(root, MAC_SOURCE);
    expect(JSON.parse(kept.waiting as string)).toMatchObject({ value: waits, received: { [mac.id]: 1 } });
    const before = JSON.parse(once.kept as string) as { heard_ms: number };
    expect(JSON.parse(kept.kept as string)).toEqual({ ...before, heard_ms: expect.any(Number) as unknown });
    expect((JSON.parse(kept.kept as string) as { heard_ms: number }).heard_ms).toBeGreaterThanOrEqual(before.heard_ms);
    await relayed({ [MAC_SOURCE]: waits });
    await restart();
    await relayed({ [MAC_SOURCE]: waits });
    expect(held(root, MAC_SOURCE)).toEqual(kept);

    await home!.stop();
    home = null;
    const lost = at(3);
    expect((await exchange(front, mac, { through: { [COAST_SOURCE]: stated(lost) } })).status).toBe(200);
    const lostRelays = () => front.logs.map((line) => JSON.parse(line) as JsonObject).filter((line) => (line.told as JsonObject | undefined)?.verb === "through");
    await until("the relay to a home that is down logged", () => lostRelays().length === 1);
    home = await start(root);
    await relayed({ [COAST_SOURCE]: lost });
    expect(held(root, COAST_SOURCE).read_through_ms).toBe(lost.read_through_ms);

    await relayed({ [COAST_SOURCE]: at(5) });
    await relayed({ [COAST_SOURCE]: at(4) });
    const coast = held(root, COAST_SOURCE);
    expect([coast.read_through_ms, (JSON.parse(coast.kept as string) as { applied: { stated_ms: number } }).applied.stated_ms]).toEqual([at(5).read_through_ms, at(5).stated_ms]);
  });

  it("D6: the exchange answers while the home's writer holds the relay, and the relay lands after", async () => {
    const root = folder("lifestream-through-d6-");
    const mac = pass(root, MAC_UNIT, "mac", [MAC_SOURCE]);
    const front = await door(root);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const arrived: JsonObject[] = [];
    const committed: JsonObject[] = [];
    const server = await serveSocket(testSocket(root).path, async (request) => {
      if (request.verb !== "through") return null;
      arrived.push(request);
      await gate;
      committed.push(request);
      return null;
    });
    onTestFinished(() => server.close());
    const answer = await exchange(front, mac, { through: { [MAC_SOURCE]: stated(at(1)) } });
    expect(answer.status).toBe(200);
    await until("the relay reached the home", () => arrived.length === 1);
    expect(committed).toEqual([]);
    release();
    await until("the held relay committed", () => committed.length === 1);
    expect(told(committed)).toEqual([{ [MAC_SOURCE]: { value: at(1), received: {} } }]);
    expect(front.logs.map((line) => JSON.parse(line) as JsonObject).filter((line) => line.told !== undefined)).toEqual([]);
  });
});
