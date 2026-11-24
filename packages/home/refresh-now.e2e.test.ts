import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { runCli } from "./cli.js";
import { serveDoor } from "./door.js";
import type { Home } from "./home.js";
import { POLL_REFRESH } from "./refresh-now.js";
import { effective } from "./settings.js";
import { serveSocket, askHome } from "./socket.js";
import type { StreamsReport } from "./streams-report.js";
import clockRegistry, { ranOf, SCRIPT } from "./test/clock-fakes.js";
import { fakeDeclarations } from "./test/fakes.js";
import { FAKES, LOOK_MS, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { homeWithDoor } from "./test/harness-home.js";
import { DEVICE, makeHome, makeHomeDb } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { homeOf } from "./registry.js";
import { testSocket } from "./test/folder.js";

const REGISTRY = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const HOUR = 3_600_000;
const MAC = "macbook-pro-0001";
const AIR = "macbook-air-bb17";

describe("Refresh now through the home's queue", () => {
  it("fetches once, now, moving no clock; two presses are one; a back-off begun since calls nothing; the row says the back-off (H1-H4)", async () => {
    const root = makeRoot("lifestream-refresh-now-", { clocks: true, sources: { "apple-notes:local:clock": "fake-rows" }, settings: { "connectors.fake-clock": { refresh: "1h" } } });
    onTestFinished(() => removeRoot(root));
    writeFileSync(join(root, SCRIPT), JSON.stringify({ fetch: [], page: [{ left: 5 }] }));
    const now = T0;
    const clock = () => now + ranOf(root).length;
    const options = { registry: REGISTRY, clock, log: () => undefined, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50 };
    const ran = () => ranOf(root).map(({ call, n }) => `${call} ${n}`);
    const row = () => readHome(root, (db) => db.prepare("SELECT next_ms, paged_ms, held_ms FROM polls WHERE acquirer = 'fake-clock'").get()) as { next_ms: number; paged_ms: number | null; held_ms: number | null };
    const jobs = () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().all()) as string[];
    const intent = () => readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(`${POLL_REFRESH}fake-clock`)) as string | undefined;
    const press = async (json = false) => {
      const lines: string[] = [];
      const status = await runCli(["connectors", "refresh", "fake-clock", "--root", root, ...json ? ["--json"] : []], {
        write: (text) => lines.push(text), registry: { code: "code-test", ...clockRegistry(effective(root).settings, homeOf(openHomeFolder(root))) }, now: clock,
      });
      expect(status).toBe(0);
      const text = lines.join("").trim();
      return json ? { answer: JSON.parse(text) as unknown } : { said: text };
    };
    let home: Home = await homeWithDoor(root, options);
    await until("the first fetch and page", () => ran().length === 2 && jobs().length === 0);
    expect(ran()).toEqual(["fetch 1", "page 1"]);
    const before = row();
    await home.stop();

    expect(await press()).toEqual({ said: "fake-clock: a fetch queued" });
    expect(await press()).toEqual({ said: "fake-clock: Refreshing" });
    expect(await press(true)).toEqual({ answer: { state: "blocked", blocked: { reason: "running", words: "Refreshing", until_ms: null } } });
    expect([jobs(), intent(), row().next_ms]).toEqual([["queued"], "queued", before.next_ms]);

    home = await homeWithDoor(root, options);
    await until("the refresh's fetch", () => ran().length === 3 && jobs().length === 0 && intent() === undefined);
    expect(ran()).toEqual(["fetch 1", "page 1", "fetch 2"]);
    expect(row()).toEqual(before);
    await home.stop();

    expect((await press(true)).answer).toEqual({ state: "queued" });
    const held = T0 + 2 * HOUR;
    const db = new Database(join(root, "home.db"));
    db.prepare("UPDATE polls SET held_ms = ? WHERE acquirer = 'fake-clock'").run(held);
    db.close();
    home = await homeWithDoor(root, options);
    await until("the refresh's run, calling nothing", () => jobs().length === 0 && intent() === undefined);
    expect(ran()).toHaveLength(3);
    expect(row()).toEqual({ ...before, held_ms: held });

    const report = await askHome(testSocket(root), "connectors") as StreamsReport;
    const refresh_now = report.connectors.find((each) => each.id === "fake-clock")!.refresh_now;
    expect(refresh_now).toMatchObject({ act: { do: "refresh", label: "Check now", of: "fake-clock" }, blocked: { reason: "held", until_ms: held }, asked: [] });
    expect(refresh_now!.blocked!.words).toMatch(/^Notes asked to wait until /u);
    expect(await askHome(testSocket(root), "connectors", ["refresh", "fake-clock"])).toMatchObject({ state: "blocked", blocked: { reason: "held", until_ms: held } });
    expect([jobs(), intent()]).toEqual([[], undefined]);
    await home.stop();
  });
});

describe("Refresh now through the door, to the Macs", () => {
  it("stamps every other Mac's copy of a store for two minutes; a recorder is no Mac's to ask (D1-D3)", async () => {
    const roots: string[] = [];
    const calls = (unit: string) => `apple-calls:local:${unit}`;
    const at = makeHome({
      mac: { kind: "mac", scopes: ["deliver"], sources: [calls(MAC), `screen:local:${MAC}`], unit: MAC },
      air: { kind: "mac", scopes: ["deliver"], sources: [calls(AIR), `screen:local:${AIR}`], unit: AIR },
      reader: { scopes: ["read"] },
      drive: { scopes: ["drive"] },
      station: { scopes: ["station"] },
    }, roots);
    onTestFinished(() => roots.forEach(removeRoot));
    makeHomeDb(join(at.root, "home.db")).close();
    const heard: JsonObject[] = [];
    let says: JsonObject = { state: "none" };
    const served = await serveSocket(testSocket(at.root).path, async (request) => {
      heard.push(request);
      return says;
    });
    onTestFinished(() => served.close());
    let now = Date.now();
    const door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, {
      lookMs: LOOK_MS, registry: FAKES, log: () => undefined, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, connectors: fakeDeclarations(), clock: () => now,
    });
    onTestFinished(() => door.close());
    const as = (who: string) => ({ authorization: `Bearer ${at.tokens[who]}`, ...(["reader", "drive", "station"].includes(who) ? {} : DEVICE.mac), "content-type": "application/json" });
    const call = async (who: string, path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${door.port}${path}`, { method: "POST", headers: as(who), body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as JsonObject };
    };
    const press = (who: string, connector: unknown = "apple-calls") => call(who, "/v1/refresh", { connector });
    const exchange = async (who: string) => {
      const answer = await call(who, "/v1/exchange", {});
      expect(answer.status, JSON.stringify(answer.body)).toBe(200);
      return answer.body.refresh ?? null;
    };
    expect([await exchange("mac"), await exchange("air")]).toEqual([null, null]);

    const first = now;
    expect(await press("reader")).toEqual({ status: 200, body: { state: "asked" } });
    expect(heard.at(-1)).toMatchObject({ verb: "connectors", args: ["--", "refresh", "apple-calls"] });
    expect(await exchange("mac")).toEqual({ [calls(MAC)]: first });
    expect(await exchange("air")).toEqual({ [calls(AIR)]: first });
    expect(await exchange("mac")).toEqual({ [calls(MAC)]: first });
    now += 60_000;
    expect(await press("mac")).toEqual({ status: 200, body: { state: "asked" } });
    expect(await exchange("mac")).toEqual({ [calls(MAC)]: first });
    expect(await exchange("air")).toEqual({ [calls(AIR)]: now });

    now = first + 2 * 60_000;
    expect(await exchange("mac")).toBeNull();
    expect(await exchange("air")).toEqual({ [calls(AIR)]: first + 60_000 });
    now = first + 3 * 60_000;
    expect(await exchange("air")).toBeNull();

    says = { state: "blocked", blocked: { reason: "paused", words: "Paused", until_ms: null } };
    expect(await press("reader")).toEqual({ status: 200, body: says });
    expect([await exchange("mac"), await exchange("air")]).toEqual([null, null]);
    says = { state: "queued" };
    expect(await press("reader")).toEqual({ status: 200, body: { state: "queued" } });
    expect(await exchange("air")).toEqual({ [calls(AIR)]: now });
    says = { state: "blocked", blocked: { reason: "held", words: "Notes asked to wait until 14:20", until_ms: 1 } };
    expect(await press("reader", "fake-poll")).toEqual({ status: 200, body: says });

    says = { state: "none" };
    now += 2 * 60_000;
    for (const who of ["reader", "mac"]) expect((await press(who, "screen")).body.code).toBe("NOT_OFFERED");
    expect([await exchange("mac"), await exchange("air")]).toEqual([null, null]);
    expect((await press("reader", "fake-poll")).body.code).toBe("NOT_OFFERED");
    expect([(await press("reader", 7)).status, (await press("reader", "no-such-connector")).status]).toEqual([422, 422]);

    expect(await press("drive")).toEqual({ status: 200, body: { state: "asked" } });
    expect(heard.at(-1)).toMatchObject({ verb: "connectors", args: ["--", "refresh", "apple-calls"], by: "you" });
    expect([await exchange("mac"), await exchange("air")]).toEqual([{ [calls(MAC)]: now }, { [calls(AIR)]: now }]);
    expect((await press("station")).status).toBe(403);
  });
});
