import { randomBytes } from "node:crypto";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { serveDoor } from "./door.js";
import { startHome } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { SOON_MS } from "./import.js";
import { askHome } from "./socket.js";
import type { StreamsReport } from "./streams-report.js";
import { RETRY_MS, type Need, type Notice } from "./status.js";
import { editSettings, testSocket } from "./test/folder.js";
import { artifact, FAKES, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { DEVICE } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const MINUTE = 60_000;
const POLLED = "apple-notes:local:poll";
const BLOCKED = "gmail:person-b@example.com:cloud";
const REFRESH = 10 * MINUTE;
const RETRY = RETRY_MS;

describe("a need's one act, pressed through the door", () => {
  it("Try now on a stopped poll runs it at once and keeps it Stopped until the result; an import stops at its second failure, across a revive, and Skip it lets its later deliveries in; any other press is NOT_OFFERED", async () => {
    let now = Date.UTC(2026, 9, 20, 9, 0);
    const clock = () => now;
    const root = makeRoot("lifestream-act-", { sources: { [POLLED]: "fake-rows", [BLOCKED]: "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "10m" } } });
    const outage = join(root, "outage");
    const hold = join(root, "poll-hold");
    const failing = join(root, "connector-fails");
    writeFileSync(outage, "");
    editSettings(root, { "connectors.fake-poll": { refresh: "10m", fail_while: outage, hold, busy_while: join(root, "busy"), offline_while: join(root, "offline") } });
    const principals = openHomeFolder(root);
    const passes = { reader: randomBytes(32).toString("base64url"), mac: randomBytes(32).toString("base64url") };
    mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: passes.reader, now_ms: 0 });
    mintPrincipal(principals, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["screen:local:macbook-pro-0001"], token: passes.mac, now_ms: 0 });
    let home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock, log: () => undefined, tickMs: TICK_MS });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, clock, registry: FAKES });
    onTestFinished(async () => {
      await door.close();
      await home.stop();
      removeRoot(root);
    });
    const url = `http://127.0.0.1:${door.port}`;
    const seen: Record<string, unknown> = {};
    const status = async (step: string): Promise<{ needs: Need[]; notices: Notice[] }> => {
      const response = await fetch(`${url}/v1/status`, { headers: { authorization: `Bearer ${passes.reader}` } });
      expect(response.status).toBe(200);
      const found = (await response.json()) as { needs: Need[]; notices: Notice[] };
      seen[step] = { needs: found.needs, notices: found.notices };
      return found;
    };
    const needs = async (step: string): Promise<Need[]> => (await status(step)).needs;
    const need = async (step: string, id: string) => (await needs(step)).find((each) => each.id === id);
    const notice = async (step: string, id: string) => (await status(step)).notices.find((each) => each.id === id)?.what;
    const press = async (step: string, body: unknown, pass = passes.reader, headers: Record<string, string> = {}) => {
      const response = await fetch(`${url}/v1/act`, { method: "POST", headers: { authorization: `Bearer ${pass}`, "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      const answer = { status: response.status, body: (await response.json()) as Record<string, unknown> };
      seen[`press: ${step}`] = { body, answer };
      return answer;
    };
    const poll = () => readHome(root, (db) => db.prepare("SELECT next_ms, outcome, reason, detail, contact_ms FROM polls JOIN attempts ON target = 'fetch:' || acquirer WHERE acquirer = 'fake-poll' ORDER BY at_ms DESC LIMIT 1").get()) as
      { next_ms: number; outcome: string; reason: string | null; detail: string | null; contact_ms: number | null } | undefined;
    const polls = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-poll' AND state IN ('queued', 'running')").pluck().get()) as number;
    const OUTAGE = "synthetic outage: the provider did not answer";
    const ended = async (what: string): Promise<{ kind: string; key: string; detail: Record<string, unknown> }> => {
      const head = readHome(root, (db) => db.prepare("SELECT seq, at_ms FROM events ORDER BY seq DESC LIMIT 1").get()) as { seq: number; at_ms: number };
      const following = new AbortController();
      const response = await fetch(`${url}/v1/feed?from=${head.seq}:${head.at_ms}`, { headers: { authorization: `Bearer ${passes.reader}` }, signal: following.signal });
      const reader = response.body!.getReader();
      const text = new TextDecoder();
      let read = "";
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) throw new Error(`the feed ended before ${what}`);
          read += text.decode(chunk.value, { stream: true });
          const events = read.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as { kind?: string; key: string; detail: Record<string, unknown> });
          const found = events.find((event) => event.kind === "attempt" && event.key === "fetch:fake-poll");
          if (found !== undefined) {
            seen[`feed: ${what}`] = found;
            return found as { kind: string; key: string; detail: Record<string, unknown> };
          }
        }
      } finally {
        following.abort();
      }
    };

    await until("the first poll failed", () => poll()?.outcome === "fail" && poll()!.detail === OUTAGE);
    const firstFailed = now;
    expect(poll()!.next_ms).toBe(now + RETRY);
    const id = `fetch:fake-poll:${POLLED}`;
    const key = "poll:fake-poll";
    expect(await need("a first failure", id)).toBeUndefined();
    for (let turn = 0; turn < 4; turn++) {
      const before = poll()!.next_ms;
      now = before;
      await until(`failure ${turn + 2}`, () => poll()!.next_ms > before);
    }
    expect(await need("three refreshes failing", id)).toMatchObject({
      id, state: "broken", words: "Couldn’t read Notes", since_ms: firstFailed, next_ms: poll()!.next_ms, connector: "fake-poll",
      acts: [{ do: "try", label: "Try now", need: key }],
    });
    now += 3 * MINUTE;
    expect((await need("three minutes on", id))?.next_ms).toBe(poll()!.next_ms);

    expect(await press("skip on a poll", { need: key, do: "skip" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    expect(await press("no such need", { need: "poll:nope", do: "try" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    expect(await press("a Mac's pass", { need: key, do: "try" }, passes.mac, DEVICE.mac)).toMatchObject({ status: 403, body: { code: "PRINCIPAL_SCOPE" } });
    expect(await press("no act named", { need: key, do: "fix" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await press("read naming no source", { need: key, do: "read" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await press("try naming a source", { need: key, do: "try", of: "claude:user-synthetic0001:browser" })).toMatchObject({ status: 422, body: { code: "BAD_REQUEST" } });
    expect(await press("read on a need that offers none", { need: key, do: "read", of: "claude:user-synthetic0001:browser" }))
      .toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    expect(polls()).toBe(0);

    const failed = ended("the failed try's end");
    expect(await press("try that fails", { need: key, do: "try" })).toEqual({ status: 200, body: { acted: "queued" } });
    expect(await failed).toMatchObject({ kind: "attempt", key: "fetch:fake-poll", detail: { outcome: "fail" } });
    expect(await need("the try failed", id)).toMatchObject({ next_ms: poll()!.next_ms, acts: [{ do: "try", label: "Try now", need: key }] });

    writeFileSync(hold, "");
    const healing = ended("the healing try's end");
    expect(await press("try", { need: key, do: "try" })).toEqual({ status: 200, body: { acted: "queued" } });
    await until("the try's fetch began", () => existsSync(`${hold}.held`));
    expect([poll()!.outcome, poll()!.detail]).toEqual(["fail", OUTAGE]);
    expect(await need("trying", id)).toBeUndefined();
    expect(await press("try again while trying", { need: key, do: "try" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    rmSync(outage);
    rmSync(hold);
    expect(await healing).toMatchObject({ kind: "attempt", key: "fetch:fake-poll", detail: { outcome: "ok" } });
    expect(poll()).toMatchObject({ outcome: "ok", contact_ms: now });
    await until("no poll queued after it", () => polls() === 0);
    expect(await need("healed", id)).toBeUndefined();
    expect(await press("try on a need gone", { need: key, do: "try" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });

    writeFileSync(outage, "");
    const healed = now;
    expect(poll()!.next_ms).toBe(healed + REFRESH);
    now += 3 * REFRESH + MINUTE;
    await until("a poll failed again", () => poll()?.outcome === "fail" && poll()!.next_ms === now + RETRY);
    const failedAgain = now;
    expect(await need("failed once again", id)).toBeUndefined();
    for (let turn = 0; turn < 3; turn++) {
      const before = poll()!.next_ms;
      now = before;
      await until(`failure again ${turn + 2}`, () => poll()!.next_ms > before);
    }
    expect(await need("stopped again", id)).toMatchObject({
      words: "Couldn’t read Notes", since_ms: failedAgain, next_ms: poll()!.next_ms, acts: [{ do: "try", label: "Try now", need: key }],
    });
    const busy = join(root, "busy");
    writeFileSync(busy, "");
    rmSync(outage);
    const pollEvents = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'attempt' AND key = 'fetch:fake-poll'").pluck().get()) as number;
    const waits: number[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const before = poll()!.next_ms;
      now = before;
      await until(`wait ${turn + 1} ended`, () => poll()!.next_ms > before);
      expect([poll()!.outcome, poll()!.reason]).toEqual(["wait", "chrome"]);
      waits.push(pollEvents());
    }
    expect([waits[1]! - waits[0]!, waits[2]! - waits[1]!]).toEqual([0, 0]);
    expect(await need("waiting", id)).toBeUndefined();
    rmSync(busy);
    const offline = join(root, "offline");
    writeFileSync(offline, "");
    now += 4 * REFRESH;
    const asked = now;
    await until("the poll found no internet", () => poll()!.reason === "offline");
    expect(poll()!.next_ms).toBe(asked + SOON_MS);
    expect(await need("offline", id)).toBeUndefined();
    rmSync(offline);
    now = asked + SOON_MS;
    await until("the poll went on online", () => poll()!.outcome === "ok" && poll()!.contact_ms === asked + SOON_MS);

    await askHome(testSocket(root), "pause", ["poll:fake-poll", "--reason", "a test"]);
    expect(await need("paused", id)).toBeUndefined();

    const note = (key: string, at: number) => ({ kind: "note", key, content: { text: key, at }, at });
    const importHold = join(root, "import-hold");
    writeFileSync(failing, "");
    const shipped = now;
    const first = await ship(root, { source: BLOCKED, fetched_ms: now - 2 * MINUTE, rows: [note("n1", now - 2 * MINUTE), { hold: importHold } as never, { fault_if: failing } as never] });
    const failures = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'import-failed'").pluck().get()) as number;
    const delivery = (id: string) => readHome(root, (db) => db.prepare("SELECT state, run, error FROM deliveries WHERE id = ?").get(id)) as { state: string; run: number | null; error: string | null } | undefined;
    const state = (id: string) => delivery(id)?.state;
    const blocked = `job:import:${BLOCKED}`;
    const report = async () => (await (await fetch(`${url}/v1/connectors`, { headers: { authorization: `Bearer ${passes.reader}` } })).json()) as StreamsReport;
    await until("import failure 1", () => failures() === 1);
    expect(await need("one import failure", blocked)).toBeUndefined();
    now += MINUTE;
    await until("import failure 2", () => failures() === 2);
    const operator = (tries: number) => `${BLOCKED} is blocked at ${first} after ${tries} tries (run import ${BLOCKED} to retry, drop job import ${BLOCKED} to give it up): ${delivery(first)!.error}`;
    expect(await need("two import failures", blocked)).toMatchObject({
      id: blocked, state: "broken", reason: "import", words: "Couldn’t import new items", line: "Notes", since_ms: shipped, acts: [{ do: "skip", label: "Skip it", need: blocked }],
    });
    expect(await notice("two import failures", blocked)).toBe(operator(2));
    expect((await report()).needs.find((each) => each.id === blocked)?.copy).toBe(BLOCKED);
    for (let tries = 3; tries <= 5; tries++) {
      now += 31 * MINUTE;
      await until(`import failure ${tries}`, () => failures() === tries);
    }
    await until("the import dead", () => readHome(root, (db) => db.prepare("SELECT state FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(BLOCKED)) === "dead");
    const later = await ship(root, { source: BLOCKED, fetched_ms: now - MINUTE, rows: [note("n2", now - MINUTE), { kind: "note", key: "n3", content: { text: "n3" } }] });
    await until("the later delivery indexed", () => state(later) === "sealed");
    expect(await need("dead", blocked)).toMatchObject({
      state: "broken", words: "Couldn’t import new items", line: "Notes", since_ms: shipped, next_ms: null, acts: [{ do: "skip", label: "Skip it", need: blocked }],
    });
    expect(await notice("dead", blocked)).toBe(operator(5));
    expect(await press("try on a dead import", { need: blocked, do: "try" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    const sock = testSocket(root);
    await askHome(sock, "connectors", ["off", BLOCKED]);
    expect(await need("turned off", blocked)).toBeUndefined();
    await askHome(sock, "connectors", ["on", BLOCKED]);
    expect(await need("on again", blocked)).toMatchObject({ state: "broken", next_ms: null });
    writeFileSync(importHold, "");
    rmSync(`${importHold}.held`, { force: true });
    await home.stop();
    home = await startHome(root, { stopGraceMs: 50, registry: FAKES, clock, log: () => undefined, tickMs: TICK_MS });
    await until("the revived import reading", () => existsSync(`${importHold}.held`));
    expect(await need("revived, reading", blocked)).toMatchObject({ since_ms: shipped, acts: [{ do: "skip", label: "Skip it", need: blocked }] });
    expect(await press("skip while reading", { need: blocked, do: "skip" })).toEqual({ status: 200, body: { acted: "already" } });
    expect(state(first)).toBe("importing");
    rmSync(importHold);
    await until("import failure 6", () => failures() === 6);
    expect(await need("revived, failed", blocked)).toMatchObject({ since_ms: shipped });
    expect(await notice("revived, failed", blocked)).toBe(operator(6));
    expect(await notice("nothing unread yet", `unread:${BLOCKED}`)).toBeUndefined();
    expect(await press("skip", { need: blocked, do: "skip" })).toEqual({ status: 200, body: { acted: "skipped" } });
    await until("the later delivery imported", () => state(later) === "imported");
    expect(state(first)).toBe("dead");
    expect(await need("skipped", blocked)).toBeUndefined();
    expect(await press("skip again", { need: blocked, do: "skip" })).toMatchObject({ status: 409, body: { code: "NOT_OFFERED" } });
    const unread = `unread:${BLOCKED}`;
    expect((await status("given up, a row refused")).notices.find((each) => each.id === unread)).toEqual({
      id: unread, since_ms: readHome(root, (db) => db.prepare("SELECT sealed_ms FROM deliveries WHERE id = ?").pluck().get(later)),
      what: `${BLOCKED}: 2\u00a0deliveries hold input this code could not read; newest ${later}: 1\u00a0row or file refused (the next release reads them again; run import ${BLOCKED} now)`,
    });

    await home.stop();
    const mute = createServer((connection) => connection.once("data", () => connection.destroy()));
    await new Promise<void>((resolve) => mute.listen(testSocket(root).path, resolve));
    try {
      expect(await press("a home that never answers", { need: blocked, do: "skip" })).toMatchObject({ status: 503, body: { code: "OUTCOME_UNKNOWN", again: false } });
    } finally {
      await new Promise<void>((resolve) => mute.close(() => resolve()));
    }
    expect(await press("no home", { need: blocked, do: "skip" })).toMatchObject({ status: 503, body: { code: "NOT_NOW" } });

    artifact(root, "act", seen);
  });

  it("an erasure's act is relayed from a device, or taken with no erasure standing", async () => {
    const root = makeRoot("lifestream-act-erasure-", { sources: {} });
    const principals = openHomeFolder(root);
    const reader = randomBytes(32).toString("base64url");
    mintPrincipal(principals, { unit: "reader-0001", scopes: ["read"], token: reader, now_ms: 0 });
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined, registry: FAKES });
    onTestFinished(async () => {
      await door.close();
      await home.stop();
      removeRoot(root);
    });
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/act`, {
      method: "POST", headers: { authorization: `Bearer ${reader}`, "content-type": "application/json" }, body: JSON.stringify({ need: "erasure", do: "try" }),
    });
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 409, body: expect.objectContaining({ code: "NOT_OFFERED", message: "an erasure is run again from the terminal: lifestream act erasure try" }),
    });
    await expect(askHome(testSocket(root), "act", ["erasure", "try"])).rejects.toMatchObject({ status: 409, code: "NOT_OFFERED", words: "no erasure stands" });
  });
});
