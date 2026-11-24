import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { afterAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { CALL_SLACK_MS } from "./errand.js";
import { Refusal } from "./refusal.js";
import { CLOSED, openStations, serveStations } from "./stations.js";
import { until } from "./test/harness-root.js";

const report: Record<string, unknown> = {};
const UNIT = "chrome-5550bb01";
const DEVICE = { "lifestream-device": "extension/1.0.0" };

afterAll(() => {
  const directory = join(tmpdir(), "lifestream-home-ops-e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "errand-states.json"), `${JSON.stringify(report, null, 2)}\n`);
});

type Handed = { id: string; errand: string; op: string };
type Line = { errand: string; op: string; ok: boolean; code?: string };

async function open(idleMs: number, presenceMs = 30_000) {
  const state = mkdtempSync(join(tmpdir(), "lifestream-errand-states-"));
  const alone = await serveStations(state, { port: 0, presence_ms: presenceMs, idle_ms: idleMs, sweep_ms: 50, poll_ms: 100 });
  const relay = JSON.parse(readFileSync(join(state, "relay.json"), "utf8")) as { code: string; drive_token: string };
  const pass = randomBytes(32).toString("base64url");
  const paired = await fetch(`${alone.url}/v1/pair`, { method: "POST", headers: { ...DEVICE, "content-type": "application/json" }, body: JSON.stringify({ code: relay.code, pass, kind: "extension", unit: UNIT }) });
  expect(paired.status).toBe(200);
  const station = {
    boot: "boot-1",
    errands: new Set<string>(),
    holding: new Map<string, Handed>(),
    handed: [] as Handed[],
  };
  const exchange = async (results: unknown[] = []): Promise<Handed[]> => {
    for (const result of results) station.holding.delete((result as { id: string }).id);
    const response = await fetch(`${alone.url}/v1/stations/exchange`, {
      method: "POST", headers: { authorization: `Bearer ${pass}`, ...DEVICE, "content-type": "application/json" },
      body: JSON.stringify({ results, station: { unit: UNIT, version: "1.0.0", slots: 4, errands: [...station.errands], boot: station.boot, running: [...station.holding.keys()], opened: [] } }),
    });
    expect(response.status).toBe(200);
    const { calls } = (await response.json()) as { calls: Handed[] };
    for (const call of calls) {
      if (!station.holding.has(call.id)) station.handed.push({ id: call.id, errand: call.errand, op: call.op });
      station.holding.set(call.id, call);
    }
    return calls;
  };
  const awaitCall = async (what: string, which: (call: Handed) => boolean): Promise<Handed> => {
    let found: Handed | undefined;
    await until(what, async () => {
      await exchange();
      found = [...station.holding.values()].find(which);
      return found !== undefined;
    });
    return found!;
  };
  const answerCall = (call: Handed, value: unknown = { done: true }) => exchange([{ id: call.id, ok: true, value }]);
  const drive = (method: string, path: string, body?: unknown) =>
    fetch(`${alone.url}${path}`, { method, headers: { authorization: `Bearer ${relay.drive_token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const code = async (response: Response): Promise<string | undefined> => {
    const read = (await response.json()) as { ok?: boolean; error?: { code: string }; code?: string };
    return response.status === 200 ? read.error?.code : read.code;
  };
  const begin = async (origin: string, deadline_ms = 60_000): Promise<string> => {
    const begun = drive("POST", "/v1/errands", { spec: { name: "states", origins: [origin], deadline_ms }, station: UNIT, wait_ms: 15 * 60_000 });
    const call = await awaitCall(`the begin on ${origin} is handed`, (each) => each.op === "begin" && !station.errands.has(each.errand));
    station.errands.add(call.errand);
    await answerCall(call, { begun: true });
    const answered = (await (await begun).json()) as { errand?: string };
    expect(answered.errand).toBe(call.errand);
    return call.errand;
  };
  const make = (errand: string, op: unknown) => {
    const made = { settled: false, code: undefined as string | undefined, message: undefined as string | undefined, ok: false };
    const answered = drive("POST", `/v1/errands/${errand}/calls`, op);
    const done = answered.then(async (response) => {
      const read = (await response.json()) as { ok: boolean; error?: { code: string; message: string } };
      Object.assign(made, { settled: true, ok: read.ok, code: read.error?.code, message: read.error?.message });
    });
    return { made, done, admitted: answered.then(() => undefined) };
  };
  const transcript = (): Line[] => {
    const file = join(state, "transcript.jsonl");
    return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Line) : [];
  };
  await exchange();
  const close = async () => {
    await alone.close();
    rmSync(state, { recursive: true, force: true });
  };
  return { alone, station, exchange, awaitCall, answerCall, drive, code, begin, make, transcript, close, state, pass };
}

describe("an errand's steps at the door", () => {
  it("walks begin, calls, close and ended, and refuses a call after the end without handing it to the station", async () => {
    const door = await open(60_000);
    try {
      const errand = await door.begin("https://walk.example");
      for (const op of ["snapshot", "find"]) {
        const call = door.make(errand, { op, tab: 1, ...(op === "find" ? { target: { role: "button" } } : {}) });
        await door.answerCall(await door.awaitCall(`the ${op} is handed`, (each) => each.op === op));
        await call.done;
        expect(call.made).toMatchObject({ ok: true });
      }
      const deleted = door.drive("DELETE", `/v1/errands/${errand}`);
      const end = await door.awaitCall("the end is handed", (each) => each.op === "end" && each.errand === errand);
      door.station.errands.delete(errand);
      await door.answerCall(end, { ended: true });
      expect((await deleted).status).toBe(200);

      const late = await door.drive("POST", `/v1/errands/${errand}/calls`, { op: "snapshot", tab: 1 });
      expect(await door.code(late)).toBe("NO_ERRAND");
      await door.exchange();
      const handed = door.station.handed.filter((each) => each.errand === errand).map((each) => each.op);
      expect(handed).toEqual(["begin", "snapshot", "find", "end"]);
      const lines = door.transcript().filter((line) => line.errand === errand).map((line) => [line.op, line.ok, line.code ?? null]);
      expect(lines).toEqual([["begin", true, null], ["snapshot", true, null], ["find", true, null], ["end", true, null]]);
      report.walk = { handed, lines };
    } finally {
      await door.close();
    }
  });

  it("refuses a call made after close began, and holds the origins through two closes until the station answers the one end", async () => {
    const door = await open(300);
    try {
      const errand = await door.begin("https://closing.example");
      const end = await door.awaitCall("the idle close hands the end", (each) => each.op === "end" && each.errand === errand);

      const late = door.make(errand, { op: "snapshot", tab: 1 });
      await until("the call made while the end is on its way is answered", () => late.made.settled);
      expect(late.made).toMatchObject({ ok: false, code: "NO_ERRAND" });

      let endAnswered = false;
      let deleteAnsweredFirst = false;
      const deleted = door.drive("DELETE", `/v1/errands/${errand}`).then((response) => {
        deleteAnsweredFirst = !endAnswered;
        return response.status;
      });
      const busy = await door.drive("POST", "/v1/errands", { spec: { name: "states", origins: ["https://closing.example"], deadline_ms: 60_000 }, station: UNIT, wait_ms: 0 });
      expect({ status: busy.status, code: await door.code(busy) }).toEqual({ status: 409, code: "BUSY" });
      await door.exchange();
      door.station.errands.delete(errand);
      endAnswered = true;
      await door.answerCall(end, { ended: true });
      expect(await deleted).toBe(200);
      expect(deleteAnsweredFirst).toBe(false);

      const next = await door.begin("https://closing.example");
      const handed = door.station.handed.filter((each) => each.errand === errand).map((each) => each.op);
      expect(handed).toEqual(["begin", "end"]);
      expect(door.transcript().filter((line) => line.errand === errand && line.op === "end").map((line) => [line.ok, line.code ?? null])).toEqual([[true, null]]);
      report.closing = { handed, next, lines: door.transcript().filter((line) => line.errand === errand) };
    } finally {
      await door.close();
    }
  });

  it("refuses a call past the deadline, frees its origins, and ends it at its DELETE with one end", async () => {
    const door = await open(60_000);
    try {
      const errand = await door.begin("https://deadline.example", 1_000);
      await until("a call is refused past the deadline", async () => {
        const probe = await door.drive("POST", `/v1/errands/${errand}/calls`, { op: "nothing" });
        return (await door.code(probe)) === "NO_ERRAND";
      });
      const next = await door.begin("https://deadline.example");

      const deleted = door.drive("DELETE", `/v1/errands/${errand}`);
      const end = await door.awaitCall("the end is handed", (each) => each.op === "end" && each.errand === errand);
      door.station.errands.delete(errand);
      await door.answerCall(end, { ended: true });
      expect((await deleted).status).toBe(200);
      const handed = door.station.handed.filter((each) => each.errand === errand).map((each) => each.op);
      expect(handed).toEqual(["begin", "end"]);
      report.deadline = { handed, next, lines: door.transcript().filter((line) => line.errand === errand) };
    } finally {
      await door.close();
    }
  });

  it("never hands a call that ended while it waited to be handed: one failed NO_STATION while its station was away is not run when it returns", async () => {
    vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
    onTestFinished(() => { vi.useRealTimers(); });
    const door = await open(60_000);
    try {
      const errand = await door.begin("https://queued.example");
      const { made, done, admitted } = door.make(errand, { op: "click", target: "#go" });
      await admitted;
      vi.setSystemTime(Date.now() + 30_000);
      await done;
      expect(made.code).toBe("NO_STATION");
      expect(made.message).toMatch(/has not been seen for/u);
      await door.exchange();
      expect(door.station.handed.filter((each) => each.errand === errand).map((each) => each.op)).toEqual(["begin"]);
    } finally {
      await door.close();
    }
  });

  it("ends an errand a station that started again dropped: refuses its calls, frees its origins, keeps its files until its DELETE and sends no end", async () => {
    const door = await open(60_000);
    try {
      const errand = await door.begin("https://dropped.example");
      const bytes = randomBytes(1_024);
      const files = `${door.alone.url}/v1/stations/files/${errand}/export.zip`;
      const station = { authorization: `Bearer ${door.pass}`, ...DEVICE };
      expect((await fetch(`${files}?part=0`, { method: "PUT", headers: station, body: bytes })).status).toBe(201);
      expect((await fetch(`${files}?done=1`, { method: "POST", headers: station })).status).toBe(200);

      door.station.boot = "boot-2";
      door.station.errands.delete(errand);
      await door.exchange();

      const late = door.make(errand, { op: "snapshot", tab: 1 });
      await until("the call on the dropped errand is answered", () => late.made.settled);
      expect(late.made).toMatchObject({ ok: false, code: "NO_ERRAND" });
      const next = await door.begin("https://dropped.example");
      const file = await door.drive("GET", `/v1/errands/${errand}/files/export.zip`);
      expect(file.status).toBe(200);
      expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
      let ended: number | undefined;
      void door.drive("DELETE", `/v1/errands/${errand}`).then((response) => {
        ended = response.status;
      });
      await until("the dropped errand's DELETE is answered, with no end to wait on", () => ended !== undefined);
      expect(ended).toBe(200);
      await door.exchange();
      const handed = door.station.handed.filter((each) => each.errand === errand).map((each) => each.op);
      expect(handed).toEqual(["begin"]);
      report.dropped = { handed, next, lines: door.transcript().filter((line) => line.errand === errand) };

      const beginning = door.drive("POST", "/v1/errands", { spec: { name: "states", origins: ["https://unbegun.example"], deadline_ms: 60_000 }, station: UNIT, wait_ms: 15 * 60_000 });
      const call = await door.awaitCall("the begin is handed", (each) => each.op === "begin" && each.errand !== next && !door.station.errands.has(each.errand));
      let refused: { status: number; code: string | undefined } | undefined;
      void door.drive("DELETE", `/v1/errands/${call.errand}`).then(async (response) => {
        refused = { status: response.status, code: await door.code(response) };
      });
      await until("the DELETE of an errand not begun is answered", () => refused !== undefined);
      expect(refused).toEqual({ status: 409, code: "NO_ERRAND" });
      door.station.errands.add(call.errand);
      await door.answerCall(call, { begun: true });
      expect(((await (await beginning).json()) as { errand?: string }).errand).toBe(call.errand);
      await door.exchange();
      expect(door.station.handed.filter((each) => each.errand === call.errand).map((each) => each.op)).toEqual(["begin"]);
    } finally {
      await door.close();
    }
  });

  it("answers a call in flight and an end on its way NOT_NOW when the door stops", async () => {
    const door = await open(60_000);
    let closed = false;
    try {
      const calling = await door.begin("https://calling.example");
      const ending = await door.begin("https://ending.example");
      door.make(calling, { op: "wait", tab: 1, for: { role: "button" }, ms: 15 * 60_000 }).done.catch(() => undefined);
      await door.awaitCall("the wait is handed", (each) => each.op === "wait" && each.errand === calling);
      const deleted = door.drive("DELETE", `/v1/errands/${ending}`).catch(() => null);
      await door.awaitCall("the end is handed", (each) => each.op === "end" && each.errand === ending);

      await door.alone.close();
      closed = true;
      await deleted;
      await until("the call and the end are answered", () => {
        const lines = door.transcript();
        return lines.some((line) => line.errand === calling && line.op === "wait") && lines.some((line) => line.errand === ending && line.op === "end");
      });
      const lines = door.transcript().filter((line) => line.op === "wait" || line.op === "end");
      expect(lines.map((line) => [line.errand, line.op, line.code ?? null])).toEqual(expect.arrayContaining([[calling, "wait", "NOT_NOW"], [ending, "end", "NOT_NOW"]]));
      report.stopping = { lines };
    } finally {
      if (closed) rmSync(door.state, { recursive: true, force: true });
      else await door.close();
    }
  });
});

async function ownDoor() {
  const files = mkdtempSync(join(tmpdir(), "lifestream-errand-close-"));
  let now = 1_800_000_000_000;
  const stations = openStations({
    files: { folder: openHomeFolder(files), dir: join(files, "files") }, home: { version: "test", generation: null }, needs: () => [], opened: () => undefined, acted: () => undefined,
    chosen: () => [], clock: () => now, poll_ms: 100,
  });
  const arrived: string[] = [];
  const server = createServer((request, response) => void (async () => {
    request.once("end", () => arrived.push(`${request.method} ${request.url}`));
    try {
      const half = stations.half(request.method, new URL(request.url ?? "/", "http://door").pathname);
      await stations.serve(half === "peer" ? { peer: UNIT } : { drive: true }, request, response);
    } catch (error) {
      const refusal = error instanceof Refusal ? error : new Refusal(500, "FAILED", String(error));
      response.writeHead(refusal.status, { "content-type": "application/json", ...(refusal.retryAfter === undefined ? {} : { "retry-after": String(refusal.retryAfter) }) })
        .end(JSON.stringify({ code: refusal.code, message: refusal.words }));
    }
  })());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    stations.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(files, { recursive: true, force: true });
  });
  const errands = new Set<string>();
  const holding = new Map<string, Handed>();
  const exchange = async (results: unknown[] = []): Promise<Handed[]> => {
    for (const result of results) holding.delete((result as { id: string }).id);
    const response = await fetch(`${url}/v1/stations/exchange`, {
      method: "POST", headers: { ...DEVICE, "content-type": "application/json" },
      body: JSON.stringify({ results, station: { unit: UNIT, version: "1.0.0", slots: 4, errands: [...errands], boot: "boot-1", running: [...holding.keys()], opened: [] } }),
    });
    const { calls } = (await response.json()) as { calls: Handed[] };
    for (const call of calls) holding.set(call.id, call);
    return calls;
  };
  const awaitCall = async (what: string, which: (call: Handed) => boolean): Promise<Handed> => {
    let found: Handed | undefined;
    await until(what, async () => {
      await exchange();
      found = [...holding.values()].find(which);
      return found !== undefined;
    });
    return found!;
  };
  const drive = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const begin = async (origin: string, deadline_ms = 60_000): Promise<string> => {
    const begun = drive("POST", "/v1/errands", { spec: { name: "closing", origins: [origin], deadline_ms }, station: UNIT, wait_ms: 15 * 60_000 });
    const call = await awaitCall(`the begin on ${origin} is handed`, (each) => each.op === "begin" && !errands.has(each.errand));
    errands.add(call.errand);
    await exchange([{ id: call.id, ok: true, value: { begun: true } }]);
    return ((await (await begun).json()) as { errand: string }).errand;
  };
  return { stations, exchange, awaitCall, drive, begin, arrived, turn: (ms: number) => void (now += ms) };
}

describe("the door's own close", () => {
  it("answers a call in flight and a begin waiting for a station NOT_NOW in its close words, and a call of an errand let go past its deadline INTERRUPTED", async () => {
    const door = await ownDoor();
    await door.exchange();
    const late = await door.begin("https://late.example", 1_000);
    const lateCall = door.drive("POST", `/v1/errands/${late}/calls`, { op: "wait", tab: 1, for: { role: "button" }, ms: 15 * 60_000 });
    await door.awaitCall("the late wait is handed", (each) => each.op === "wait" && each.errand === late);
    door.turn(1_000 + CALL_SLACK_MS + 1);
    expect((await door.drive("GET", `/v1/errands/${late}/files/none`)).status).toBe(404);
    expect(await (await lateCall).json()).toMatchObject({ ok: false, error: { code: "INTERRUPTED" } });

    const held = await door.begin("https://held.example");
    const call = door.drive("POST", `/v1/errands/${held}/calls`, { op: "wait", tab: 1, for: { role: "button" }, ms: 15 * 60_000 });
    await door.awaitCall("the wait is handed", (each) => each.op === "wait" && each.errand === held);
    const begins = door.arrived.filter((each) => each === "POST /v1/errands").length;
    const waiting = door.drive("POST", "/v1/errands", { spec: { name: "waiting", origins: ["https://held.example"], deadline_ms: 60_000 }, station: UNIT, wait_ms: 15 * 60_000 });
    await until("the waiting begin is read", () => door.arrived.filter((each) => each === "POST /v1/errands").length > begins);
    door.stations.close();
    const [called, begun] = await Promise.all([call, waiting]);
    expect(await called.json()).toEqual({ id: expect.any(String), ok: false, error: { code: "NOT_NOW", message: CLOSED } });
    expect([begun.status, begun.headers.get("retry-after"), await begun.json()]).toEqual([503, "5", { code: "NOT_NOW", message: CLOSED }]);
  });
});
