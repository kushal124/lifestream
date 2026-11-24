import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startHome } from "./home.js";
import { artifact, FAKES, LOOK_MS, makeRoot, readHome, steppedClock, TICK_MS, until } from "./test/harness-root.js";
import { statusOf } from "./test/harness-status.js";
import { count, derivedHomes } from "./test/derived.js";


describe("derived work: what a commit made due is found from what it moved, never requested by a writer", () => {
  const { roots } = derivedHomes();

  it("a poll dies in a network outage", async () => {
    const outage = mkdtempSync(join(tmpdir(), "lifestream-derived-outage-"));
    const hold = join(outage, "outage");
    const attempts = join(outage, "attempts");
    writeFileSync(hold, "");
    const root = makeRoot("lifestream-derived-poll-", { sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "1s", fail_while: hold, attempts } } });
    roots.push(root);
    const clock = steppedClock(root, "fake-poll", 1_000);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: clock.now, log: () => undefined });
    try {
      const tried = () => (existsSync(attempts) ? statSync(attempts).size : 0);
      const job = () => readHome(root, (db) => db.prepare("SELECT state, attempts FROM jobs WHERE kind = 'poll' AND key = 'fake-poll'").get()) as { state: string; attempts: number };
      const poll = () => readHome(root, (db) => db.prepare("SELECT outcome, reason, detail, contact_ms FROM attempts WHERE target = 'fetch:fake-poll'").get()) as { outcome: string; reason: string | null; detail: string | null; contact_ms: number | null };
      await clock.stepUntil("six polls failed in the outage", () => tried() >= 6);
      expect(job().state).not.toBe("dead");
      expect(job().attempts).toBe(0);
      expect(poll()).toEqual({ outcome: "fail", reason: "failing", detail: "synthetic outage: the provider did not answer", contact_ms: null });
      const during = statusOf(root, { now_ms: clock.now() }) as { needs: { id: string }[] };
      expect(during.needs.find((need) => need.id === "fetch:fake-poll:apple-notes:local:poll")).toBeUndefined();
      rmSync(hold);
      await clock.nextTurn();
      await until("the outage over, a poll delivered", () => count(root, "SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:poll' AND state = 'imported'") >= 1);
      expect(poll().outcome).toBe("ok");
      const after = statusOf(root, { now_ms: clock.now() }) as { needs: { id: string }[] };
      expect(after.needs.filter((need) => need.id === "fetch:fake-poll:apple-notes:local:poll")).toEqual([]);
      artifact(root, "poll-outage", { tried: tried(), job: job(), poll: poll(), during: during.needs, after: after.needs });
      rmSync(outage, { recursive: true, force: true });
    } finally {
      await home.stop();
    }
  });

  it("a poll with nothing yet keeps what it did and is no failure", async () => {
    const counted = mkdtempSync(join(tmpdir(), "lifestream-derived-asked-"));
    const attempts = join(counted, "attempts");
    const root = makeRoot("lifestream-derived-asked-", { sources: { "apple-notes:local:poll": "fake-rows" }, clocks: true, settings: { "connectors.fake-poll": { refresh: "3s", ask_first: true, attempts } } });
    roots.push(root);
    const clock = steppedClock(root, "fake-poll", 3_000);
    const home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, lookMs: LOOK_MS, registry: FAKES, clock: clock.now, log: () => undefined });
    try {
      const poll = () => readHome(root, (db) => db.prepare("SELECT c.state, a.outcome, a.reason, a.contact_ms FROM poll_cursors c JOIN attempts a ON a.target = 'fetch:' || c.acquirer WHERE c.acquirer = 'fake-poll'").get()) as { state: string; outcome: string; reason: string | null; contact_ms: number | null } | undefined;
      const needs = async () => (statusOf(root, { now_ms: clock.now() }) as { needs: { id: string }[] }).needs.filter((need) => need.id === "fetch:fake-poll:apple-notes:local:poll");
      await until("the poll asked", () => poll()?.outcome === "wait");
      expect(JSON.parse(poll()!.state)).toEqual({ cursor: 0, asked: true });
      expect([poll()!.reason, poll()!.contact_ms !== null]).toEqual(["provider-making", true]);
      expect(count(root, "SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:poll'")).toBe(0);
      expect(await needs()).toEqual([]);
      await clock.nextTurn();
      await until("a poll delivered", () => count(root, "SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:poll' AND state = 'imported'") >= 1);
      const tries = readFileSync(attempts, "utf8").length;
      expect(tries).toBeGreaterThanOrEqual(2);
      expect(JSON.parse(poll()!.state)).toMatchObject({ asked: true });
      expect(poll()!.outcome).toBe("ok");
      expect(count(root, "SELECT count(*) FROM deliveries WHERE source = 'apple-notes:local:poll'")).toBe(tries - 1);
      expect(await needs()).toEqual([]);
      rmSync(counted, { recursive: true, force: true });
    } finally {
      await home.stop();
    }
  });
});
