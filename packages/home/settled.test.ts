import { describe, expect, it } from "vitest";
import { readSettled, type Counted, type Settling } from "./settled.js";
import { until } from "./test/harness-root.js";

type Answer = Counted & { readonly n: number };

function bench(options: { counting?: boolean; placed?: Promise<void>; feedClosed?: boolean } = {}) {
  let counting = options.counting ?? true;
  let reads = 0;
  let watching = 0;
  let bounded = 0;
  let woken: (() => void) | null = null;
  let ending: (() => void) | null = null;
  let stuck = false;
  let gate: Promise<boolean> | null = null;
  const signals: AbortSignal[] = [];
  const watched: string[][] = [];
  const settling: Settling = {
    feed: {
      watch: async (kinds, wake) => {
        watched.push([...kinds]);
        await options.placed;
        if (options.feedClosed === true) return null;
        watching += 1;
        woken = wake;
        return () => {
          watching -= 1;
          woken = null;
        };
      },
    },
    bound: (end) => {
      bounded += 1;
      ending = end;
      return () => {
        bounded -= 1;
        ending = null;
      };
    },
  };
  const read = (signal: AbortSignal): Promise<Answer> => {
    reads += 1;
    signals.push(signal);
    const n = reads;
    if (gate !== null) return gate.then((was) => ({ n, reply: was ? { counting: true as const } : {} }));
    if (stuck) {
      return new Promise<Answer>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason as Error), { once: true });
      });
    }
    return Promise.resolve({ n, reply: counting ? { counting: true as const } : {} });
  };
  const held = (pathname: string, query: string, signal = new AbortController().signal) => {
    let done = false;
    const holding = readSettled(pathname, new URLSearchParams(query), settling, read, signal).finally(() => { done = true; });
    return { holding, done: () => done };
  };
  return {
    held, watched,
    settle: () => { counting = false; },
    stick: () => { stuck = true; },
    hold: () => {
      let open = (_was: boolean): void => undefined;
      gate = new Promise<boolean>((resolve) => { open = resolve; });
      return () => {
        gate = null;
        open(counting);
      };
    },
    event: () => woken?.(),
    bound: () => ending?.(),
    reads: () => reads,
    open: () => [watching, bounded],
    watching: () => woken !== null,
    signals,
  };
}

describe("a read held until it no longer counts (settled=1)", () => {
  it("answers at once when its first read does not count, freeing its watch and its bound", async () => {
    const at = bench({ counting: false });
    expect(await at.held("/v1/people", "id=person:person-a&settled=1").holding).toEqual({ n: 1, reply: {} });
    await until("its watch and bound let go", () => at.open().every((each) => each === 0));
    expect([at.reads(), at.watched]).toEqual([1, [["people"]]]);
  });

  it("holds while its read counts, reads again at each of its job's events, and answers the first read that does not count", async () => {
    const at = bench();
    const read = at.held("/v1/places/photos", "slug=synthetic-a&settled=1");
    await until("the first read counted and the hold waits on the feed", () => at.reads() === 1 && at.watching());
    at.event();
    await until("it read again", () => at.reads() === 2);
    expect(read.done(), "the second read still counted").toBe(false);
    at.settle();
    at.event();
    expect(await read.holding).toEqual({ n: 3, reply: {} });
    await until("its watch and bound let go", () => at.open().every((each) => each === 0));
    expect(at.watched).toEqual([["places"]]);
  });

  it("loses no event that comes while a read runs: it reads again after it", async () => {
    const at = bench();
    const release = at.hold();
    const read = at.held("/v1/people", "settled=1");
    await until("the first read runs, the hold watching", () => at.reads() === 1 && at.watching());
    at.event();
    release();
    at.settle();
    expect(await read.holding).toEqual({ n: 2, reply: {} });
  });

  it("answers at its bound with the last answer it has, still counting", async () => {
    const at = bench();
    const read = at.held("/v1/places", "settled=1");
    await until("the hold waits on the feed", () => at.reads() === 1 && at.watching());
    at.bound();
    expect(await read.holding).toEqual({ n: 1, reply: { counting: true } });
    await until("its watch and bound let go", () => at.open().every((each) => each === 0));
  });

  it("answers at its bound though a read it started never ends, and lets that read go", async () => {
    const at = bench();
    const read = at.held("/v1/people/photos", "id=person:person-a&settled=1");
    await until("the hold waits on the feed", () => at.reads() === 1 && at.watching());
    at.stick();
    at.event();
    await until("it reads again, a read that does not end", () => at.reads() === 2);
    at.bound();
    expect(await read.holding).toEqual({ n: 1, reply: { counting: true } });
    expect(at.signals[1]!.aborted, "the read it raced is let go").toBe(true);
  });

  it("is let go when its reader leaves while held, reading nothing more", async () => {
    const at = bench();
    const leaving = new AbortController();
    const read = at.held("/v1/people", "settled=1", leaving.signal);
    await until("the hold waits on the feed", () => at.reads() === 1 && at.watching());
    leaving.abort(new Error("the reader left"));
    await expect(read.holding).rejects.toThrow("the reader left");
    await until("its watch and bound let go", () => at.open().every((each) => each === 0));
    expect(at.reads()).toBe(1);
  });

  it("is let go when its reader leaves before its watch is placed, reading nothing, and frees the watch once it is", async () => {
    let place = (): void => undefined;
    const at = bench({ placed: new Promise<void>((resolve) => { place = resolve; }) });
    const leaving = new AbortController();
    const read = at.held("/v1/people", "settled=1", leaving.signal);
    await until("the watch is asked for", () => at.watched.length === 1);
    leaving.abort(new Error("the reader left early"));
    await expect(read.holding).rejects.toThrow("the reader left early");
    place();
    await until("the watch placed late is let go, and the bound", () => at.open().every((each) => each === 0));
    expect(at.reads()).toBe(0);
  });

  it("holds a counting read to its bound when the feed can place no watch, so a reader never re-asks in a hot loop", async () => {
    const at = bench({ feedClosed: true });
    const read = at.held("/v1/people", "settled=1");
    let answered = false;
    void read.holding.then(() => { answered = true; }, () => undefined);
    await until("its one read is made", () => at.reads() === 1);
    expect(answered).toBe(false);
    at.bound();
    expect(await read.holding).toEqual({ n: 1, reply: { counting: true } });
    await until("its bound lets go", () => at.open()[1] === 0);
  });

  it("refuses a settled other than 1 or stated twice, 422 BAD_PARAMETER, and holds nothing without one or on another route", async () => {
    const at = bench();
    for (const query of ["settled=0", "settled=", "settled=yes", "settled=1&settled=1"]) {
      await expect(at.held("/v1/people", query).holding, query).rejects.toMatchObject({ status: 422, code: "BAD_PARAMETER" });
    }
    for (const [pathname, query] of [["/v1/people", "id=person:person-a"], ["/v1/status", "settled=1"], ["/v1/people/card", "settled=1"]] as const) {
      expect(await at.held(pathname, query).holding, `${pathname}?${query}`).toMatchObject({ reply: { counting: true } });
    }
    expect([at.watched, at.reads(), at.open()]).toEqual([[], 3, [0, 0]]);
  });
});
