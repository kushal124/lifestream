import { describe, expect, it } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { Refusal } from "./refusal.js";
import type { Call } from "./socket.js";
import { openTurns, TURN_BUDGET_MS } from "./turns.js";

const SLOW = 1_000;

function fakeTurns() {
  const at = { now: 10_000, cpu: 0 };
  const lines: JsonObject[] = [];
  const turns = openTurns({ log: (line) => lines.push(line), slow_ms: SLOW, now: () => at.now, cpu: () => at.cpu });
  const spend = (ms: number, cpu = ms) => {
    at.now += ms;
    at.cpu += cpu;
  };
  const slow = () => lines.filter((line) => line.slow !== undefined);
  const asked = () => lines.filter((line) => line.request !== undefined);
  return { at, lines, turns, spend, slow, asked };
}

function callOf(sent_ms: number | null): Call & { begun: number } {
  const call = { left: new AbortController().signal, sent_ms, begun: 0, began: () => { call.begun++; } };
  return call;
}

describe("a turn", () => {
  it("logs a turn under the mark, misses one over it, or names no cpu, no part or no failure", () => {
    const { turns, spend, slow } = fakeTurns();
    expect(turns.run("quick", () => { spend(SLOW); return "kept"; })).toBe("kept");
    expect(slow()).toEqual([]);
    turns.run("tick", (part) => {
      spend(5);
      part("controls");
      spend(400, 300);
      part("polls");
      spend(700, 100);
    });
    expect(slow()).toEqual([{ slow: 1_105, of: "tick", cpu_ms: 405, controls_ms: 400, polls_ms: 700 }]);
    expect(() => turns.run("verb drop", (part) => {
      part("work");
      spend(1_200, 10);
      throw new Error("a synthetic failure");
    })).toThrow("a synthetic failure");
    expect(slow().at(-1)).toEqual({ slow: 1_200, of: "verb drop", cpu_ms: 10, work_ms: 1_200, failed: true });
  });

  it("counts a turn inside a turn twice, or loses the inner turn's own line", () => {
    const { turns, spend, slow } = fakeTurns();
    turns.run("people act", (part) => {
      part("draft");
      spend(600);
      part("land");
      spend(100);
      turns.run("people", (inner) => {
        inner("work");
        spend(1_100, 900);
        inner("commit");
        spend(300, 0);
      });
      spend(500);
    });
    expect(slow()).toEqual([
      { slow: 1_400, of: "people", cpu_ms: 900, work_ms: 1_100, commit_ms: 300 },
      { slow: 1_200, of: "people act", cpu_ms: 1_200, draft_ms: 600, land_ms: 600 },
    ]);
  });

  it("counts a turn over the budget by its wall clock, misses one over by its work, or carries counts into the next line", () => {
    const { turns, spend } = fakeTurns();
    turns.run("tick", () => spend(TURN_BUDGET_MS * 5, TURN_BUDGET_MS));
    turns.run("tick", () => spend(TURN_BUDGET_MS * 2, TURN_BUDGET_MS * 2));
    turns.run("tick", () => spend(TURN_BUDGET_MS * 3, TURN_BUDGET_MS * 3));
    turns.run("helper chunk", () => {
      spend(TURN_BUDGET_MS + 1);
      turns.run("import chunk", () => spend(TURN_BUDGET_MS * 4));
    });
    expect(turns.line().over).toEqual({
      tick: { count: 2, max_ms: TURN_BUDGET_MS * 3 },
      "helper chunk": { count: 1, max_ms: TURN_BUDGET_MS + 1 },
      "import chunk": { count: 1, max_ms: TURN_BUDGET_MS * 4 },
    });
    expect(turns.line().over).toEqual({});
  });
});

describe("a request", () => {
  it("logs no line, more than one, or a wait not from its send to its begin", async () => {
    const { turns, spend, asked } = fakeTurns();
    const call = callOf(9_000);
    const answer = turns.request("status", call, async (begun) => {
      spend(50);
      begun.began();
      begun.began();
      spend(20, 15);
      await Promise.resolve();
      spend(200, 0);
      return { ok: true };
    });
    await expect(answer).resolves.toEqual({ ok: true });
    expect(call.begun).toBe(2);
    expect(asked()).toEqual([{ request: "status", queued_ms: 1_050, ran_ms: 220, cpu_ms: 65, answer: "ok" }]);
  });

  it("names the act's parts on its line, counts their time again, or loses a refusal's code", async () => {
    const { turns, spend, asked, slow } = fakeTurns();
    const act = (call: Call) => new Promise((settle) => {
      call.began();
      settle(turns.run("people act", (part) => {
        part("draft");
        spend(300);
        part("seal");
        spend(100, 20);
        part("land");
        turns.run("people", (inner) => {
          inner("work");
          spend(400);
        });
        return { act: "synthetic" };
      }));
    });
    await turns.request("owner-act", callOf(null), (call) => {
      spend(5);
      return act(call);
    });
    expect(asked().at(-1)).toEqual({ request: "owner-act", queued_ms: null, ran_ms: 800, cpu_ms: 725, draft_ms: 300, seal_ms: 100, land_ms: 0, work_ms: 400, answer: "ok" });
    expect(slow()).toEqual([]);
    const refused = turns.request("owner-act", callOf(10_000), async () => { throw new Refusal(503, "NOT_NOW", "Your home is busy.", 5); });
    await expect(refused).rejects.toThrow("Your home is busy.");
    expect(asked().at(-1)).toEqual({ request: "owner-act", queued_ms: null, ran_ms: null, cpu_ms: 0, answer: "NOT_NOW" });
    const thrown = turns.request("drop", callOf(10_000), () => { throw new TypeError("a synthetic bad request"); });
    await expect(thrown).rejects.toThrow("a synthetic bad request");
    expect(asked().at(-1)).toMatchObject({ request: "drop", answer: "error" });
  });
});

describe("a request held, then run under another", () => {
  it("logs an act drained under a later request on its own line, its parts and its cpu, never the later one's", async () => {
    const { turns, spend, asked } = fakeTurns();
    let queued: Call | undefined;
    let settle: (answer: unknown) => void = () => undefined;
    const first = turns.request("owner-act", callOf(9_000), (call) => {
      queued = call;
      return new Promise((resolve) => { settle = resolve; });
    });
    spend(50);
    await turns.request("owner-act", callOf(10_000), async (call) => {
      call.began();
      spend(5);
      queued!.began();
      settle(turns.run("people act", (part) => {
        part("draft");
        spend(300, 200);
        part("land");
        spend(100, 50);
        return { act: "first" };
      }, queued));
      spend(10);
      return { act: "second" };
    });
    await first;
    expect(asked()).toHaveLength(2);
    expect(asked()).toEqual(expect.arrayContaining([
      { request: "owner-act", queued_ms: 1_055, ran_ms: 410, cpu_ms: 250, draft_ms: 300, land_ms: 100, answer: "ok" },
      { request: "owner-act", queued_ms: 50, ran_ms: 415, cpu_ms: 15, answer: "ok" },
    ]));
  });

  it("logs a request answered at arrival with its wait and no run", () => {
    const { turns, asked, at } = fakeTurns();
    turns.answeredAtArrival("owner-act", at.now - 12_000, "NOT_NOW");
    turns.answeredAtArrival(null, null, "error");
    expect(asked()).toEqual([{ request: "owner-act", queued_ms: 12_000, ran_ms: null, answer: "NOT_NOW" }, { request: null, queued_ms: null, ran_ms: null, answer: "error" }]);
  });
});

describe("the layer line", () => {
  it("drops a field it had, counts a drain's wait as a copy, misses the copier's copies, or carries a window into the next", () => {
    const { turns } = fakeTurns();
    turns.committed(4, 1);
    turns.committed(8, 2);
    turns.checkpointed(30, { busy: 0, log: 10, checkpointed: 10 });
    turns.checkpointed(null, { busy: 1, log: 20, checkpointed: 5 });
    turns.copied(400);
    turns.copied(250);
    turns.polled({ bytes: 100, rows: 2 });
    turns.polled(null);
    const line = turns.line();
    expect(line).toEqual({
      commits: 2, p50_ms: 4, p99_ms: 8, max_ms: 8, due: { p50_ms: 1, p99_ms: 2, max_ms: 2 },
      checkpoints: 1, checkpoint_max_ms: 30, copies: 2, copy_max_ms: 400, truncate: { busy: 1, log: 20, checkpointed: 5 }, polls: { calls: 2, cursor_bytes: 100, memory_rows: 2 },
      over: {}, loop: { p99_ms: expect.any(Number), max_ms: expect.any(Number) },
    });
    expect(turns.line()).toMatchObject({ commits: 0, p50_ms: null, checkpoints: 0, checkpoint_max_ms: 0, copies: 0, copy_max_ms: 0, polls: { calls: 0, cursor_bytes: 0, memory_rows: 0 }, over: {} });
  });
});
