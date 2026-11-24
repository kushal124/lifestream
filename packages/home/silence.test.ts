import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { moving } from "./silence.js";

const SILENT_MS = 5 * 60_000;

function fed(): { body: AsyncIterable<string>; send(chunk: string): void; end(): void; close(): void } {
  let give!: (result: IteratorResult<string>) => void;
  let fail!: (error: Error) => void;
  const next = () => new Promise<IteratorResult<string>>((resolve, reject) => { give = resolve; fail = reject; });
  return {
    body: { [Symbol.asyncIterator]: () => ({ next, return: async () => ({ done: true, value: undefined }) }) },
    send: (chunk) => give({ done: false, value: chunk }),
    end: () => give({ done: true, value: undefined }),
    close: () => fail(new Error("closed")),
  };
}

describe("a body is let go for something other than its silence, or a silent one is kept", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("never lets go of a body that keeps moving, however long it takes in all, and times nothing once it has ended", async () => {
    const sender = fed();
    const letGo = vi.fn();
    const chunks = moving(sender.body, SILENT_MS, letGo);
    for (const chunk of ["a", "b", "c", "d"]) {
      const next = chunks.next();
      await vi.advanceTimersByTimeAsync(SILENT_MS - 1);
      sender.send(chunk);
      expect(await next).toEqual({ done: false, value: chunk });
    }
    const last = chunks.next();
    await vi.advanceTimersByTimeAsync(SILENT_MS - 1);
    sender.end();
    expect((await last).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SILENT_MS);
    expect(letGo).not.toHaveBeenCalled();
  });

  it("times nothing while the reader works on a chunk, nor once the reader has stopped", async () => {
    const sender = fed();
    const letGo = vi.fn();
    const chunks = moving(sender.body, SILENT_MS, letGo);
    const first = chunks.next();
    await vi.advanceTimersByTimeAsync(0);
    sender.send("a");
    await first;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * SILENT_MS);
    expect(letGo).not.toHaveBeenCalled();
    await chunks.return(undefined);
    expect(vi.getTimerCount()).toBe(0);
    expect(letGo).not.toHaveBeenCalled();
  });

  it("lets go once of a body whose next chunk has not come for the silence, and times nothing after its wait has ended", async () => {
    const sender = fed();
    const letGo = vi.fn(() => sender.close());
    const chunks = moving(sender.body, SILENT_MS, letGo);
    const first = chunks.next();
    await vi.advanceTimersByTimeAsync(0);
    sender.send("a");
    await first;
    const second = chunks.next().then(() => "a chunk", (error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(SILENT_MS - 1);
    expect(letGo).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(letGo).toHaveBeenCalledTimes(1);
    expect(await second).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * SILENT_MS);
    expect(letGo).toHaveBeenCalledTimes(1);
  });
});
