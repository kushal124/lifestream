import { describe, expect, it } from "vitest";
import { ErasableStreams, type StreamOf } from "./erasable-streams.js";

function open(streams: ErasableStreams, from: StreamOf) {
  let release!: () => void;
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const state = { cut: false, closed: false };
  const done = streams.send(from, (signal) => new Promise<void>((resolve, reject) => {
    started();
    release = resolve;
    signal.addEventListener("abort", () => {
      state.cut = true;
      setImmediate(() => reject(signal.reason as Error));
    }, { once: true });
  })).finally(() => { state.closed = true; });
  return { begun, done, state, release: () => release() };
}

describe("the door's open streams across an erasure", () => {
  it("cuts the streams of the blobs, days and People it names, each closed before the cut answers, and leaves the rest", async () => {
    const streams = new ErasableStreams();
    const blob = open(streams, { blob: "sha256:" + "a".repeat(64) });
    const day = open(streams, { day: "2026-09-28" });
    const otherDay = open(streams, { day: "2026-09-29" });
    const card = open(streams, { people: true });
    await Promise.all([blob.begun, day.begun, otherDay.begun, card.begun]);
    const cut = await streams.cut({ blobs: ["sha256:" + "a".repeat(64)], days: ["2026-09-28"], people: true });
    expect(cut).toBe(3);
    expect([blob.state, day.state, card.state]).toEqual([{ cut: true, closed: true }, { cut: true, closed: true }, { cut: true, closed: true }]);
    expect(otherDay.state).toEqual({ cut: false, closed: false });
    await Promise.all([blob.done, day.done, card.done]);
    otherDay.release();
    await otherDay.done;
  });

  it("cuts every stream open when told all, and none twice", async () => {
    const streams = new ErasableStreams();
    const each = [open(streams, { blob: "sha256:" + "b".repeat(64) }), open(streams, { day: "2026-09-30" }), open(streams, { people: true })];
    await Promise.all(each.map((stream) => stream.begun));
    expect(await streams.cut({ all: true })).toBe(3);
    expect(each.map((stream) => stream.state)).toEqual(each.map(() => ({ cut: true, closed: true })));
    expect(await streams.cut({ all: true })).toBe(0);
  });
});
