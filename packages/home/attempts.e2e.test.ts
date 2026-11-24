import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import type { Home } from "./home.js";
import { basicInstant, openSealing } from "./inbox.js";
import { askHome } from "./socket.js";
import { ranOf, SCRIPT, type Answer } from "./test/clock-fakes.js";
import { artifact, makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { homeWithDoor } from "./test/harness-home.js";
import { testSocket } from "./test/folder.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const REGISTRY = fileURLToPath(new URL("./test/clock-fakes.ts", import.meta.url));
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MINUTE = 60_000;
const LANE = "apple-notes:local:clock";

type AttemptRow = { target: string; source: string; outcome: string; reason: string | null; facts: string; since_ms: number; at_ms: number; contact_ms: number | null; fails: number };

async function started(root: string, script: Record<"fetch" | "page", Answer[]>) {
  writeFileSync(join(root, SCRIPT), JSON.stringify(script));
  const clock = { now: T0 };
  const logged: string[] = [];
  const home: Home = await homeWithDoor(root, { registry: REGISTRY, clock: () => clock.now + ranOf(root).length, log: (line) => logged.push(line), tickMs: TICK_MS });
  const ran = () => ranOf(root).filter((each) => each.name === "fake-clock");
  const pending = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE kind = 'poll' AND key = 'fake-clock' AND state <> 'done'").pluck().get()) as number;
  const rows = (target: string) => readHome(root, (db) => db.prepare("SELECT target, source, outcome, reason, facts, since_ms, at_ms, contact_ms, fails FROM attempts WHERE target = ? ORDER BY source").all(target)) as AttemptRow[];
  const row = (target: string, source = LANE) => rows(target).find((each) => each.source === source);
  const events = (target: string) => readHome(root, (db) => db.prepare("SELECT detail FROM events WHERE kind = 'attempt' AND key = ? ORDER BY seq").pluck().all(target)) as string[];
  const settled = async (count: number, what: string) => {
    try {
      await until(what, () => ran().length >= count && pending() === 0);
    } catch (error) {
      throw new Error(`${(error as Error).message}; ran ${JSON.stringify(ran().slice(-4))}; the log's end ${logged.slice(-10).join("\n")}`);
    }
    expect(ran().length, what).toBe(count);
  };
  return { home, clock, ran, rows, row, events, settled, sock: testSocket(root) };
}

describe("what runs writes what it did", () => {
  it("a failing fetch or page is not recorded with its since and its count, no internet restarts a failure, a repeated wait moves the feed, an empty answer seals or is no contact, or no internet moves the contact", async () => {
    const root = makeRoot("lifestream-attempts-", { clocks: true, sources: { [LANE]: "fake-rows", "apple-notes:local:hand": "fake-hand" }, settings: { "connectors.fake-clock": { refresh: "10m" } } });
    const at = await started(root, {
      fetch: [{}, { fail: "the provider broke" }, { wait: "the network is down", reason: "offline" }, { fail: "the provider broke" }, { empty: true }, { wait: "the network is down", reason: "offline" }, { wait: "the network is down", reason: "offline" }],
      page: [{ fail: "the page broke" }, { fail: "the page broke" }, { left: 0 }],
    });
    const deliveries = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ?").pluck().get(LANE)) as number;
    const seen: Record<string, unknown> = {};
    try {
      await at.settled(2, "the first fetch, then the first page");
      const read = at.row("fetch:fake-clock")!;
      expect(read).toMatchObject({ outcome: "ok", reason: null, fails: 0 });
      expect(read.contact_ms).toBe(read.at_ms);
      expect(at.row("page:fake-clock")).toMatchObject({ outcome: "fail", reason: "failing", fails: 1 });
      const pageFailed = at.row("page:fake-clock")!.since_ms;

      at.clock.now = T0 + 2 * MINUTE;
      await at.settled(3, "the second page");
      expect(at.row("page:fake-clock")).toMatchObject({ outcome: "fail", fails: 2, since_ms: pageFailed });
      at.clock.now = T0 + 4 * MINUTE;
      await at.settled(4, "the third page, which reads");
      expect(at.row("page:fake-clock")).toMatchObject({ outcome: "ok", fails: 0 });
      seen.page = at.events("page:fake-clock").map((detail) => JSON.parse(detail) as unknown);
      const failing = { source: LANE, outcome: "fail", reason: "failing" };
      expect(seen.page).toEqual([failing, failing, { source: LANE, outcome: "ok", reason: null }]);

      at.clock.now = T0 + 10 * MINUTE;
      await at.settled(5, "the second fetch, which fails");
      const failed = at.row("fetch:fake-clock")!;
      expect(failed).toMatchObject({ outcome: "fail", reason: "failing", fails: 1, contact_ms: read.contact_ms });
      expect(JSON.parse(failed.facts)).toEqual({});
      at.clock.now = T0 + 15 * MINUTE;
      await at.settled(6, "the third fetch, which finds no internet");
      expect(at.row("fetch:fake-clock")).toMatchObject({ outcome: "wait", reason: "offline", fails: 1, since_ms: failed.since_ms, contact_ms: read.contact_ms });
      at.clock.now = T0 + 20 * MINUTE;
      await at.settled(7, "the fourth fetch, which fails again");
      expect(at.row("fetch:fake-clock")).toMatchObject({ outcome: "fail", fails: 2, since_ms: failed.since_ms, contact_ms: read.contact_ms });

      const sealed = deliveries();
      at.clock.now = T0 + 25 * MINUTE;
      await at.settled(8, "the fetch that answers nothing new");
      const empty = at.row("fetch:fake-clock")!;
      expect([deliveries(), empty.outcome, empty.fails, empty.contact_ms === empty.at_ms]).toEqual([sealed, "ok", 0, true]);

      at.clock.now = T0 + 35 * MINUTE;
      await at.settled(9, "the fetch that finds no internet");
      expect(at.row("fetch:fake-clock")).toMatchObject({ outcome: "wait", reason: "offline", fails: 0, contact_ms: empty.contact_ms });
      const offline = at.row("fetch:fake-clock")!.since_ms;
      at.clock.now = T0 + 45 * MINUTE;
      await at.settled(10, "the fetch that finds no internet again");
      expect(at.row("fetch:fake-clock")).toMatchObject({ outcome: "wait", since_ms: offline, contact_ms: empty.contact_ms });

      seen.fetch = at.events("fetch:fake-clock").map((detail) => (JSON.parse(detail) as { outcome: string }).outcome);
      expect(seen.fetch).toEqual(["ok", "fail", "wait", "fail", "ok", "wait"]);
      expect(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'held:live'").pluck().get()) as string).toMatch(/"complete"/u);
      seen.rows = [...at.rows("fetch:fake-clock"), ...at.rows("page:fake-clock")];
    } finally {
      artifact(root, "attempts", seen);
      await at.home.stop();
      removeRoot(root);
    }
  });

  it("one account's need lands on another copy, or another account's read clears it", async () => {
    const A = "apple-notes:account-a:clock";
    const B = "apple-notes:account-b:clock";
    const root = makeRoot("lifestream-attempts-accounts-", { clocks: true, sources: {}, settings: { "connectors.fake-clock": { refresh: "10m" } } });
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => {
      tx.tables.sources.add({ id: A, vendor: vendorOf(declarations(), A), connector: "fake-rows", options: { lane: LANE, email: "person-a@example.com" }, added_ms: 0 });
      tx.tables.sources.add({ id: B, vendor: vendorOf(declarations(), B), connector: "fake-rows", options: { lane: LANE, email: "person-b@example.com" }, added_ms: 0 });
    });
    db.close();
    const at = await started(root, {
      fetch: [{ need: "signed-out", facts: { account: "person-a@example.com" } }, { facts: { sources: [{ id: B, connector: "fake-rows" }] } }],
      page: [{ left: 0 }, { left: 0 }, { left: 0 }],
    });
    try {
      await until("the first fetch", () => at.row("fetch:fake-clock", A) !== undefined);
      expect(at.rows("fetch:fake-clock").map(({ source, outcome, reason }) => [source, outcome, reason])).toEqual([[A, "need", "signed-out"]]);
      const need = at.row("fetch:fake-clock", A)!;
      at.clock.now = T0 + 5 * MINUTE;
      await until("the second fetch", () => at.row("fetch:fake-clock", B) !== undefined);
      expect(at.rows("fetch:fake-clock").map(({ source, outcome, reason, since_ms }) => [source, outcome, reason, since_ms])).toEqual([
        [A, "need", "signed-out", need.since_ms], [B, "ok", null, expect.any(Number)],
      ]);
      artifact(root, "accounts", at.rows("fetch:fake-clock"));
    } finally {
      await at.home.stop();
      removeRoot(root);
    }
  });

  it("a paused connector's poll, import or later copy runs, its pause names no author, or a history pause holds its fetches or runs its pages", async () => {
    const root = makeRoot("lifestream-attempts-pause-", { clocks: true, sources: { [LANE]: "fake-rows" }, settings: { "connectors.fake-clock": { refresh: "10m" } } });
    const at = await started(root, { fetch: [], page: [] });
    const later = "apple-notes:local:later";
    const jobs = () => readHome(root, (db) => db.prepare("SELECT kind, key, connector, state FROM jobs WHERE kind IN ('poll', 'import') ORDER BY kind, key").all()) as { kind: string; key: string; connector: string | null; state: string }[];
    const state = () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE source = ?").pluck().get(later)) as string | undefined;
    try {
      await expect(askHome(at.sock, "pause", ["pause:fake-clock"])).rejects.toThrow(/--reason is required/u);
      expect(await askHome(at.sock, "pause", ["pause:fake-clock", "--reason", "a test holds it"])).toEqual({ paused: "pause:fake-clock", by: "terminal" });
      expect(readHome(root, (db) => db.prepare("SELECT target, by, reason FROM controls").all())).toEqual([{ target: "pause:fake-clock", by: "terminal", reason: "a test holds it" }]);
      expect(readHome(root, (db) => db.prepare("SELECT key, detail FROM events WHERE kind = 'pause'").all())).toEqual([{ key: "pause:fake-clock", detail: JSON.stringify({ by: "terminal", reason: "a test holds it" }) }]);

      const sealing = openSealing(openHomeFolder(root), { source: later, name: basicInstant(new Date(T0).toISOString()), feeder: "device", fetched_at: new Date(T0).toISOString() });
      await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(`${JSON.stringify({ kind: "note", key: "later-1", content: { text: "later" }, at: T0 })}\n`); })());
      sealing.seal({});
      await askHome(at.sock, "source", ["add", later, "--connector", "fake-rows"]);
      await until("the later copy's import queued", () => jobs().some((job) => job.kind === "import" && job.key === later));
      at.clock.now = T0 + MINUTE;
      await until("the poll queued", () => jobs().some((job) => job.kind === "poll" && job.state === "queued"));
      const held = jobs();
      expect(held).toEqual(expect.arrayContaining([
        { kind: "poll", key: "fake-clock", connector: "fake-clock", state: "queued" }, { kind: "import", key: later, connector: "fake-clock", state: "queued" },
      ]));
      expect([at.ran().length, state()]).toEqual([0, "sealed"]);

      await askHome(at.sock, "resume", ["pause:fake-clock"]);
      await until("the poll ran, its job ended, and the later copy imported", () => at.ran().length > 0 && state() === "imported" && !jobs().some((job) => job.kind === "poll" && job.state !== "done"));

      expect(await askHome(at.sock, "connectors", ["backfill", "fake-clock", "pause", "--reason", "a test holds its history"])).toEqual({ paused: "pause:fake-clock:history", by: "terminal" });
      const before = at.ran().length;
      at.clock.now = T0 + 30 * MINUTE;
      await until("the fetch at its refresh", () => at.ran().length > before);
      await until("nothing more queued", () => !jobs().some((job) => job.kind === "poll" && job.state !== "done"));
      expect(at.ran().slice(before).map((each) => each.call)).toEqual(["fetch"]);
      artifact(root, "pause", { held, ran: at.ran() });
    } finally {
      await at.home.stop();
      removeRoot(root);
    }
  });
});
