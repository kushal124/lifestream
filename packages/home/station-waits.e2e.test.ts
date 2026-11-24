import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { canonical, openHome, openHomeFolder, type HomeDb, type JobRow, type JsonObject } from "@lifestreamprotocol/core";
import { byDoor, offline, runErrand, StationFailed, stationsOver, type Acquirer, type Lent } from "@lifestreamprotocol/connect";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { pollKind, queuedFor, unparkPoll } from "./import.js";
import type { HelperEnv, Main } from "./jobs.js";
import { STARTING } from "./refusal.js";
import { CLOSED } from "./stations.js";
import { effective } from "./settings.js";
import { FAKE_CONNECTORS } from "./test/fakes.js";
import { artifact, makeRoot, readHome, removeRoot } from "./test/harness-root.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const SOURCE = "apple-notes:local:poll";
const ERRAND = "errand-1";

const LET_GO = "errand errand-1 ended while the call ran";
const SILENT = "no answer from station chrome-5550aa01 within 90000 ms: whether the call ran is not known";

type Mode = "starting" | "cut" | "refused" | "reset" | "closed" | "interrupted" | "silent";

async function controlledDoor() {
  const state: { mode: Mode; asked: string[] } = { mode: "starting", asked: [] };
  const json = (response: ServerResponse, status: number, body: JsonObject, headers: Record<string, string> = {}) =>
    response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
  const listen = async (server: Server) => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    request.resume();
    request.on("end", () => {
      state.asked.push(`${request.method} ${request.url}`);
      if (state.mode === "starting") return json(response, 503, { code: "NOT_NOW", message: STARTING }, { "retry-after": "5" });
      if (state.mode === "cut") {
        const body = JSON.stringify({ code: "NOT_NOW", message: STARTING });
        response.writeHead(503, { "content-type": "application/json", "content-length": String(body.length) });
        response.write(body.slice(0, 8));
        return void setImmediate(() => request.socket.destroy());
      }
      if (state.mode === "refused") return json(response, 403, { code: "PRINCIPAL_SCOPE", message: "the pass drives no station" });
      if (request.method === "POST" && request.url === "/v1/errands") return json(response, 200, { errand: ERRAND, extension: null });
      if (request.method === "DELETE") return json(response, 200, {});
      if (state.mode === "reset") return request.socket.resetAndDestroy();
      if (state.mode === "closed") return json(response, 200, { id: "c-1", ok: false, error: { code: "NOT_NOW", message: CLOSED } });
      return json(response, 200, { id: "c-1", ok: false, error: { code: "INTERRUPTED", message: state.mode === "silent" ? SILENT : LET_GO } });
    });
  });
  const url = await listen(server);
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const gone = createServer();
  const goneUrl = await listen(gone);
  await new Promise<void>((resolve) => gone.close(() => resolve()));
  return { url, goneUrl, state };
}

async function run(db: HomeDb, root: string, door: string, marked: string, body: (lent: Lent, state: JsonObject | null) => Promise<JsonObject>, facts: JsonObject = {}) {
  const seen: { handed: JsonObject | null; listed: string[] } = { handed: null, listed: [] };
  const acquirer: Acquirer = {
    name: "fake-poll", source: SOURCE, secrets: [],
    async fetch(state, _secrets, lent) {
      seen.handed = state;
      seen.listed = lent!.memory.list("seen").map(([key]) => key);
      lent!.memory.put("seen", marked, true);
      return { files: [], facts, state: await body(lent!, state) };
    },
  };
  const now = Date.now();
  const registry = { connectors: FAKE_CONNECTORS, readers: [{ name: "fake-rows" }], families: [], acquirers: [acquirer], labelers: [], code: "test" };
  const main = { folder: openHomeFolder(root), settings: effective(root).settings, now: () => now, room: "ok", stated: null, ending: 0, registry, log: () => undefined, polled: () => undefined } as unknown as Main;
  const job = { id: 1, kind: "poll", key: "fake-poll", connector: "fake-poll", lane: 1 } as JobRow;
  const begun = db.commit((tx) => {
    unparkPoll(tx, acquirer);
    queuedFor(tx, "fake-poll", ["fetch"]);
    return pollKind.begin!(main, tx, job);
  });
  if (begun === null) throw new Error("the run made no call");
  const env = { folder: openHomeFolder(root), registry, db, secrets: () => ({ get: () => undefined, rotate: () => undefined }), stations: { door, pass: "synthetic-drive-pass" }, signal: new AbortController().signal } as unknown as HelperEnv;
  const task = { job: 1, kind: "poll", key: "fake-poll", lane: 1, now_ms: now, data: begun.data };
  try {
    const result = (await pollKind.helper(env, task).next()).value as Parameters<typeof pollKind.done>[3];
    db.commit((tx) => pollKind.done(main, tx, { job, state: begun.state }, result));
    return { ...seen, end: { outcome: result.end.outcome, reason: result.end.reason ?? null, detail: result.end.detail ?? null } };
  } catch (error) {
    db.commit((tx) => pollKind.failed!(main, tx, job, begun.state, (error as Error).message));
    return { ...seen, end: { outcome: "fail", reason: null, detail: (error as Error).message } };
  }
}

const kept = (db: HomeDb, root: string) => ({
  ...db.commit((tx) => ({
    cursor: tx.tables.polls.cursor("fake-poll") ?? null,
    memory: tx.tables.polls.rememberedAfter("fake-poll", "seen", null, 100),
  })),
  row: readHome(root, (read) => read.prepare("SELECT outcome, reason, fails FROM attempts WHERE target = 'fetch:fake-poll'").get()) as { outcome: string; reason: string | null; fails: number },
});

describe("a poll whose door restarts under it", () => {
  it("waits as the home's own, writing no failure and keeping its cursor and memory, whether its door is gone, starting, or cuts or ends its errand's call", async () => {
    const root = makeRoot("lifestream-station-waits-", { sources: { [SOURCE]: "fake-rows" }, settings: { "connectors.fake-poll": {} } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    onTestFinished(() => db.close());
    const door = await controlledDoor();
    const calls: Record<string, unknown> = {};
    calls.good = await run(db, root, door.url, "item-1", async () => ({ n: 1 }));
    const before = kept(db, root);
    expect(before).toEqual({ cursor: { source: SOURCE, state: canonical({ n: 1 }), start_ms: null }, memory: [["item-1", "true"]], row: { outcome: "ok", reason: null, fails: 0 } });
    const errand = async (lent: Lent): Promise<JsonObject> =>
      runErrand(lent.stations!, { name: "synthetic-site", origins: ["https://site.example.com"], deadline_ms: 60_000 }, async (each) => {
        await each.open("https://site.example.com/");
        throw new Error("an errand's call answered");
      });
    const doors: [string, string, Mode, string][] = [
      ["gone", door.goneUrl, "starting", "door"], ["starting", door.url, "starting", "door"], ["cut", door.url, "cut", "door"], ["reset", door.url, "reset", "door"],
      ["closed", door.url, "closed", "door"], ["interrupted", door.url, "interrupted", "chrome"], ["silent", door.url, "silent", "chrome"],
    ];
    for (const [name, at, mode, reason] of doors) {
      door.state.mode = mode;
      calls[name] = await run(db, root, at, `item-${name}`, errand);
      expect((calls[name] as { end: { outcome: string; reason: string } }).end, name).toMatchObject({ outcome: "wait", reason });
      if (mode === "interrupted" || mode === "silent") expect((calls[name] as { end: { detail: string } }).end.detail, name).toBe(mode === "silent" ? SILENT : LET_GO);
      expect(kept(db, root), name).toEqual({ ...before, row: { outcome: "wait", reason, fails: 0 } });
    }
    expect(door.state.asked.filter((each) => each.startsWith("POST /v1/errands/") || each.startsWith("DELETE"))).toEqual([
      `POST /v1/errands/${ERRAND}/calls`, `DELETE /v1/errands/${ERRAND}`, `POST /v1/errands/${ERRAND}/calls`, `DELETE /v1/errands/${ERRAND}`,
      `POST /v1/errands/${ERRAND}/calls`, `DELETE /v1/errands/${ERRAND}`, `POST /v1/errands/${ERRAND}/calls`, `DELETE /v1/errands/${ERRAND}`,
    ]);
    calls.after = await run(db, root, door.url, "item-2", async (_lent, state) => ({ n: (state!.n as number) + 1 }));
    expect(calls.after).toMatchObject({ handed: { n: 1 }, listed: ["item-1"], end: { outcome: "ok" } });
    expect(kept(db, root)).toEqual({ cursor: { source: SOURCE, state: canonical({ n: 2 }), start_ms: null }, memory: [["item-1", "true"], ["item-2", "true"]], row: { outcome: "ok", reason: null, fails: 0 } });
    artifact(root, "station-waits", calls);
  });
});

describe("a refusal from the door", () => {
  it("whose body is cut mid-read is the door not carrying the call (NO_DOOR, the home's wait on its door); one whose body arrives whole keeps its code, the lane's own", async () => {
    const door = await controlledDoor();
    const failure = async () => stationsOver(door.url, "synthetic-drive-pass").sites().then(() => null, (error: unknown) => error);
    door.state.mode = "cut";
    const cut = await failure();
    expect(cut).toBeInstanceOf(StationFailed);
    expect({ code: (cut as StationFailed).code, offline: offline(cut), byDoor: byDoor(cut) }).toEqual({ code: "NO_DOOR", offline: true, byDoor: true });
    door.state.mode = "refused";
    const refused = await failure();
    expect({ code: (refused as StationFailed).code, message: (refused as Error).message, offline: offline(refused), byDoor: byDoor(refused) })
      .toEqual({ code: "PRINCIPAL_SCOPE", message: "the pass drives no station", offline: false, byDoor: false });
  });
});

describe("a poll that names its account", () => {
  it("makes its source with the name a site greets the person by when it shows no email, and names it again as the next poll says", async () => {
    const root = makeRoot("lifestream-station-named-", { sources: { [SOURCE]: "fake-rows" }, settings: { "connectors.fake-poll": {} } });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    onTestFinished(() => db.close());
    const door = await controlledDoor();
    const named = "apple-notes:customer-0001:poll";
    const options = () => db.commit((tx) => tx.tables.sources.get(named)?.options ?? null);
    const stating = (account: JsonObject) => ({ account: "customer-0001", sources: [{ id: named, connector: "fake-rows", ...account }] });
    await run(db, root, door.url, "item-1", async () => ({ n: 1 }), stating({ name: "Person A" }));
    expect(options()).toEqual({ lane: "fake-poll", name: "Person A" });
    await run(db, root, door.url, "item-2", async () => ({ n: 2 }), stating({ email: "person-a@example.com" }));
    expect(options()).toEqual({ lane: "fake-poll", email: "person-a@example.com" });
  });
});
