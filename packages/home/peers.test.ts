import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { openPeers, type Statement } from "./peers.js";

type Call = { readonly id: string; readonly op: string };
type Result = { readonly id: string; readonly ok: boolean };

function opened(boot = "boot-1") {
  const peers = openPeers<Statement, Call, Result, object>({
    noun: "station", poll_ms: 60_000,
    interrupted: (id) => ({ id, ok: false }),
  });
  const settled = new Map<string, Result>();
  const { peer } = peers.arrive("chrome-00000001", { boot, running: [] }, () => ({}));
  const hand = (id: string, op = "click") => peers.hand(peer, { id, op }, (result) => settled.set(id, result));
  return { peers, peer, hand, settled };
}

const held = () => new EventEmitter() as unknown as ServerResponse;

describe("a hand of calls", () => {
  it("queues nothing again when another hand took its call since: the call is handed twice, never three times", () => {
    const { peers, peer, hand } = opened();
    hand("c-1");
    const first = peers.take(peer);
    expect(first.calls.map((call) => call.id)).toEqual(["c-1"]);
    peers.arrive(peer.unit, { boot: "boot-1", running: [] }, () => ({}));
    expect(peers.rehand(peer)).toEqual(["c-1"]);
    const second = peers.take(peer);
    expect(second.calls.map((call) => call.id)).toEqual(["c-1"]);
    expect(second.id).not.toBe(first.id);
    expect(peers.giveBack(peer, first)).toEqual([{ id: "c-1", why: "taken" }]);
    expect(peers.queued(peer)).toBe(0);
    expect(peers.take(peer).calls).toEqual([]);
  });

  it("never queues again a call that ended while its hand was out", () => {
    const { peers, peer, hand, settled } = opened();
    hand("c-1");
    const taken = peers.take(peer);
    peers.end(peer, "c-1", { id: "c-1", ok: false });
    expect(settled.get("c-1")).toEqual({ id: "c-1", ok: false });
    expect(peers.giveBack(peer, taken)).toEqual([{ id: "c-1", why: "ended" }]);
    expect(peers.queued(peer)).toBe(0);
  });

  it("gives its own calls back first, in their order, and only once however often it is given back", () => {
    const { peers, peer, hand } = opened();
    hand("c-1");
    hand("c-2");
    const taken = peers.take(peer);
    hand("c-3");
    expect(peers.giveBack(peer, taken)).toEqual([]);
    expect(peers.giveBack(peer, taken)).toEqual([{ id: "c-1", why: "taken" }, { id: "c-2", why: "taken" }]);
    expect(peers.take(peer).calls.map((call) => call.id)).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("fences a hand that answered a waiting exchange as one taken from the queue", async () => {
    const { peers, peer, hand } = opened();
    const waiting = peers.wait(peer, held());
    hand("c-1");
    const first = await waiting;
    expect(first.calls.map((call) => call.id)).toEqual(["c-1"]);
    peers.arrive(peer.unit, { boot: "boot-1", running: [] }, () => ({}));
    expect(peers.rehand(peer)).toEqual(["c-1"]);
    const second = peers.take(peer);
    expect(second.calls.map((call) => call.id)).toEqual(["c-1"]);
    expect(peers.giveBack(peer, first)).toEqual([{ id: "c-1", why: "taken" }]);
    expect(peers.queued(peer)).toBe(0);
  });

  it("lets a wait on a response already gone take the next hand from the live exchange waiting", async () => {
    const { peers, peer, hand } = opened();
    const live = peers.wait(peer, held());
    const gone = peers.wait(peer, Object.assign(held(), { destroyed: true }));
    hand("c-1");
    expect((await gone).calls).toEqual([]);
    expect((await live).calls.map((call) => call.id)).toEqual(["c-1"]);
  });

  it("queues again only a call the peer neither holds nor has queued, and says which", () => {
    const { peers, peer, hand } = opened();
    hand("c-1");
    hand("c-2");
    peers.take(peer);
    hand("c-3");
    peers.arrive(peer.unit, { boot: "boot-1", running: ["c-2"] }, () => ({}));
    expect(peers.rehand(peer)).toEqual(["c-1"]);
    expect(peers.take(peer).calls.map((call) => call.id)).toEqual(["c-3", "c-1"]);
  });
});

describe("what settles and what a new start retires", () => {
  it("answers a result that settled nothing: one for a call that ended, one delivered twice, one never handed", () => {
    const { peers, peer, hand, settled } = opened();
    hand("c-1");
    hand("c-2");
    peers.take(peer);
    peers.end(peer, "c-2", { id: "c-2", ok: false });
    const late = peers.settle(peer, [{ id: "c-1", ok: true }, { id: "c-2", ok: true }, { id: "c-1", ok: true }, { id: "c-9", ok: true }]);
    expect(late).toEqual([{ id: "c-2", ok: true }, { id: "c-1", ok: true }, { id: "c-9", ok: true }]);
    expect(settled.get("c-1")).toEqual({ id: "c-1", ok: true });
    expect(settled.get("c-2")).toEqual({ id: "c-2", ok: false });
  });

  it("answers the calls a new start retired: those handed to the old start that the new one does not hold, never one still queued", () => {
    const { peers, peer, hand, settled } = opened();
    hand("c-1");
    hand("c-2");
    peers.take(peer);
    hand("c-3");
    const first = peers.arrive(peer.unit, { boot: "boot-1", running: [] }, () => ({}));
    expect(first.retired).toEqual([]);
    const again = peers.arrive(peer.unit, { boot: "boot-2", running: ["c-2"] }, () => ({}));
    expect(again).toMatchObject({ again: true, retired: ["c-1"] });
    expect(settled.get("c-1")).toEqual({ id: "c-1", ok: false });
    expect(peers.pending(peer).map((call) => call.id)).toEqual(["c-2", "c-3"]);
  });
});
