import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openFeed, type FeedReads, type Page, type Position } from "./feed.js";

class Response extends EventEmitter {
  written: string[] = [];
  full = false;
  destroyed = false;
  status: number | null = null;
  statusCode = 200;
  writeHead(status: number): this {
    this.status = status;
    return this;
  }
  write(text: string): boolean {
    this.written.push(text);
    return !this.full;
  }
  end(): void {
    this.emit("close");
  }
  destroy(): void {
    this.destroyed = true;
  }
  closed(): void {
    this.emit("close");
  }
  drain(): void {
    this.full = false;
    this.emit("drain");
  }
  events(): string[] {
    return this.written.filter((text) => text.startsWith("id: ")).map((text) => text.split("\n")[0]!.slice(4));
  }
  beats(): number {
    return this.written.filter((text) => text === ":\n\n").length;
  }
}

function home(): FeedReads & { add(kind?: string): void; holdHead(): () => void; holdPage(): () => void; paging(): boolean; pages(): number } {
  const events: (Position & { kind: string })[] = [];
  let held: Promise<void> | null = null;
  let heldPage: Promise<void> | null = null;
  let waiting = false;
  let pages = 0;
  return {
    add: (kind = "day") => { events.push({ seq: events.length + 1, at_ms: 1_000 + events.length, kind }); },
    holdHead() {
      let release!: () => void;
      held = new Promise<void>((resolve) => { release = resolve; });
      return () => { held = null; release(); };
    },
    holdPage() {
      let release!: () => void;
      heldPage = new Promise<void>((resolve) => { release = resolve; });
      return () => { heldPage = null; release(); };
    },
    paging: () => waiting,
    pages: () => pages,
    async head() {
      if (held !== null) await held;
      const last = events.at(-1);
      return last === undefined ? { seq: 0, at_ms: 0 } : { seq: last.seq, at_ms: last.at_ms };
    },
    async page(after: Position): Promise<Page | undefined> {
      pages += 1;
      if (heldPage !== null) {
        waiting = true;
        await heldPage;
        waiting = false;
      }
      return { rows: events.filter((event) => event.seq > after.seq).map((event) => ({ ...event, key: `${event.kind}-${event.seq}`, detail: null })) };
    },
  };
}

const request = (from?: string) => ({ url: from === undefined ? "/v1/feed" : `/v1/feed?from=${from}`, headers: {} }) as unknown as IncomingMessage;

function bench() {
  const reads = home();
  let tick: (() => void) | null = null;
  const feed = openFeed(reads, () => undefined, (each) => {
    tick = each;
    return () => { tick = null; };
  });
  return {
    reads, feed,
    beat: () => tick?.(),
    follow: async (still: () => boolean, from?: string) => {
      const response = new Response();
      await feed.follow(request(from), response as unknown as ServerResponse, still);
      return response;
    },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("a feed follower whose pass is no longer good", () => {
  it("is ended at the next beat, and no event is written after it", async () => {
    const at = bench();
    at.reads.add();
    let admitted = true;
    const reader = await at.follow(() => admitted, "0:0");
    await vi.advanceTimersByTimeAsync(250);
    expect(reader.events()).toEqual(["1:1000"]);
    at.beat();
    expect(reader.beats()).toBe(1);
    admitted = false;
    at.beat();
    expect(reader.destroyed).toBe(true);
    at.reads.add();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reader.events()).toEqual(["1:1000"]);
    expect(reader.beats()).toBe(1);
    reader.closed();
    expect(at.feed.following()).toBe(0);
    at.feed.close();
  });

  it("writes nothing of a page in flight at the beat that ends it, though its socket's close has not come yet", async () => {
    const at = bench();
    at.reads.add();
    let admitted = true;
    const reader = await at.follow(() => admitted, "0:0");
    await vi.advanceTimersByTimeAsync(250);
    expect(reader.events()).toEqual(["1:1000"]);
    const release = at.reads.holdPage();
    at.reads.add();
    await vi.advanceTimersByTimeAsync(250);
    expect(at.reads.paging()).toBe(true);
    admitted = false;
    at.beat();
    expect(reader.destroyed).toBe(true);
    release();
    await vi.advanceTimersByTimeAsync(250);
    expect(reader.events()).toEqual(["1:1000"]);
    reader.closed();
    at.feed.close();
  });

  it("a check that throws admits no one", async () => {
    const at = bench();
    const reader = await at.follow(() => { throw new Error("the passes file cannot be read"); }, "0:0");
    expect(reader.destroyed).toBe(true);
    expect(reader.status).toBe(null);
  });

  it("never opens the stream when its pass is revoked while the first head read waits", async () => {
    const at = bench();
    at.reads.add();
    const release = at.reads.holdHead();
    let admitted = true;
    const following = at.follow(() => admitted);
    admitted = false;
    release();
    const reader = await following;
    expect(reader.status).toBe(null);
    expect(reader.written).toEqual([]);
    expect(reader.destroyed).toBe(true);
    expect(reader.statusCode).toBe(403);
    expect(at.feed.following()).toBe(0);
  });
});

describe("a feed reader that stops reading", () => {
  it("is sent no keep-alive while full, ended once full for a minute, and resumes from its position", async () => {
    const at = bench();
    at.reads.add();
    const reader = await at.follow(() => true, "0:0");
    await vi.advanceTimersByTimeAsync(250);
    expect(reader.events()).toEqual(["1:1000"]);
    reader.full = true;
    at.reads.add();
    await vi.advanceTimersByTimeAsync(250);
    expect(reader.events()).toEqual(["1:1000", "2:1001"]);
    const before = reader.written.length;
    for (let beat = 0; beat < 3; beat++) at.beat();
    expect(reader.written.length).toBe(before);
    await vi.advanceTimersByTimeAsync(59_000);
    reader.drain();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader.destroyed).toBe(false);
    at.beat();
    expect(reader.beats()).toBe(1);
    reader.full = true;
    at.reads.add();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reader.destroyed).toBe(true);
    reader.closed();
    expect(at.feed.following()).toBe(0);
    at.reads.add();
    const again = await at.follow(() => true, "3:1002");
    await vi.advanceTimersByTimeAsync(250);
    expect(again.events()).toEqual(["4:1003"]);
    at.feed.close();
  });
});

describe("a watch in the door's own process", () => {
  it("wakes at an event of its kinds after it began, never at another kind's or an earlier one's", async () => {
    const at = bench();
    at.reads.add("people");
    let woken = 0;
    const unwatch = await at.feed.watch(["people"], () => { woken += 1; });
    expect(unwatch).not.toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    expect(woken).toBe(0);
    at.reads.add("places");
    at.reads.add("day");
    await vi.advanceTimersByTimeAsync(250);
    expect(woken).toBe(0);
    at.reads.add("people");
    await vi.advanceTimersByTimeAsync(250);
    expect(woken).toBe(1);
    unwatch!();
    at.reads.add("people");
    await vi.advanceTimersByTimeAsync(250);
    expect(woken, "an unwatched watch is never woken").toBe(1);
    at.feed.close();
  });

  it("reads each page once for every watch, however many there are", async () => {
    const at = bench();
    const woken = { people: 0, places: 0 };
    const unwatches = await Promise.all([
      ...Array.from({ length: 5 }, () => at.feed.watch(["people"], () => { woken.people += 1; })),
      ...Array.from({ length: 3 }, () => at.feed.watch(["places"], () => { woken.places += 1; })),
    ]);
    const before = at.reads.pages();
    at.reads.add("people");
    at.reads.add("places");
    await vi.advanceTimersByTimeAsync(250);
    expect([at.reads.pages() - before, woken.people, woken.places]).toEqual([1, 5, 3]);
    for (const unwatch of unwatches) unwatch!();
    at.feed.close();
  });

  it("is placed at one head read however many watch at once, and none is placed once the feed has closed", async () => {
    const at = bench();
    const release = at.reads.holdHead();
    let woken = 0;
    const placing = [at.feed.watch(["people"], () => { woken += 1; }), at.feed.watch(["people"], () => { woken += 1; })];
    at.reads.add("people");
    release();
    const unwatches = await Promise.all(placing);
    expect(unwatches.every((unwatch) => unwatch !== null)).toBe(true);
    at.reads.add("people");
    await vi.advanceTimersByTimeAsync(250);
    expect(woken, "each woken once, by the event after both were placed").toBe(2);
    at.feed.close();
    expect(await at.feed.watch(["people"], () => undefined)).toBeNull();
  });
});
