import { describe, expect, it } from "vitest";
import { canonical, type Delivery } from "@lifestreamprotocol/connect/sdk";
import { NeedsYou, NotYet, type Acquirer } from "../../seams.js";
import type { Scenario } from "../../shared/dependencies.js";
import { artifact, lending, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { AT_INSTANT, AT_NEWEST, exampleApiAcquirer } from "./acquirer.js";
import { exampleApi } from "./reader.js";
import { editedAt, provider, secrets, SOURCE, settings } from "./test/fixture.js";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const HOUR = 3_600_000;

const scenario = (items: number, old = 0, edited: readonly number[] = []): Scenario => ({ items, old, edited, removed: [], start_ms: NOW });

function example(start: Scenario, page?: number) {
  const queued: (Response | null)[] = [];
  const requested: URL[] = [];
  const at = { scenario: start };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requested.push(new URL(request.url));
    return queued.shift() ?? provider(at.scenario, page)(request);
  };
  const acquirer = exampleApiAcquirer({ ...settings, work: temp("example-api-work-"), zone: "UTC", unit: "macbook-pro-0001" }, { fetch, now: () => NOW, sleep: async () => undefined });
  return { at, queued, requested, acquirer };
}

const SECRETS = () => memorySecrets({ ...secrets });

const fresh = (): PollRecord => ({ state: null, deliveries: [] });

async function call(home: TestHome, acquirer: Acquirer, record: PollRecord, kind: "fetch" | "page" = "fetch", vault = SECRETS()): Promise<Delivery | null> {
  const delivery = await poll(home, acquirer, record, vault, NOW, kind);
  if (delivery === undefined) return null;
  await home.land(exampleApi, delivery);
  return delivery;
}

const paths = (delivery: Delivery | null): string[] => delivery?.files.map((file) => file.path) ?? [];
const keys = (record: PollRecord, part: string): string[] => [...(record.memory?.get(part)?.keys() ?? [])].sort();

async function history(home: TestHome, acquirer: Acquirer, record: PollRecord): Promise<(number | null)[]> {
  const lefts: (number | null)[] = [];
  for (let left: number | null = null; left !== 0;) {
    await call(home, acquirer, record, "page");
    left = record.left ?? null;
    lefts.push(left);
  }
  return lefts;
}

describe("example api: each of these is impossible", () => {
  it("a first fetch reads history as new, history misses an old note or lands one twice, or a note is timed by when it arrived", async () => {
    const home = openTestHome();
    const { acquirer, requested } = example(scenario(25, 23));
    const record = fresh();
    expect(paths(await call(home, acquirer, record))).toEqual(["notes/note-23.json", "notes/note-24.json"]);
    expect(await history(home, acquirer, record)).toEqual([13, 3, 0]);
    const heads = home.heads(SOURCE);
    expect(heads).toHaveLength(25);
    expect(heads.find((head) => head.key === "note-0")!.start_ms).toBe(NOW - 23 * HOUR);
    expect(new Set(requested.map((url) => url.origin))).toEqual(new Set(["https://api.example.com"]));
    artifact(home.dir, "heads.json", heads);
  });

  it("a fetch with nothing new seals a delivery or changes the poll's memory, or an edit is missed or lands twice", async () => {
    const home = openTestHome();
    const { at, acquirer } = example(scenario(3));
    const record = fresh();
    expect(paths(await call(home, acquirer, record))).toHaveLength(3);
    const cursor = record.state;
    expect(await call(home, acquirer, record)).toBeNull();
    expect([record.state, record.changes]).toEqual([cursor, { cleared: [], entries: [] }]);
    at.scenario = scenario(3, 0, [0, 2]);
    expect(paths(await call(home, acquirer, record))).toEqual(["notes/note-0.json", "notes/note-2.json"]);
    expect([keys(record, AT_INSTANT), keys(record, AT_NEWEST)]).toEqual([["note-0", "note-2"], []]);
    expect(await call(home, acquirer, record)).toBeNull();
    expect(home.heads(SOURCE).find((head) => head.key === "note-0")!.end_ms).toBe(editedAt(at.scenario));
  });

  it("a walk cut short by its budget starts over, skips a note, or forgets the notes it sealed at one instant", async () => {
    const home = openTestHome();
    const { at, acquirer } = example(scenario(0));
    const record = fresh();
    await call(home, acquirer, record);
    at.scenario = scenario(600, 0, Array.from({ length: 600 }, (_, n) => n));
    expect([(await call(home, acquirer, record))?.files.length, record.next?.more]).toEqual([500, true]);
    expect([(await call(home, acquirer, record))?.files.length, record.next?.more]).toEqual([100, undefined]);
    expect(keys(record, AT_INSTANT)).toHaveLength(600);
    expect(await call(home, acquirer, record)).toBeNull();
    expect(home.heads(SOURCE)).toHaveLength(600);
  });

  it("a limit with nothing read seals or fails, a limit after a page loses it, or a refused or missing key is anything but signed out", async () => {
    const home = openTestHome();
    const { at, queued, acquirer } = example(scenario(0));
    const record = fresh();
    await call(home, acquirer, record);
    at.scenario = scenario(25);
    queued.push(Response.json({}, { status: 429, headers: { "retry-after": "30" } }));
    const waited = await call(home, acquirer, record).catch((error: unknown) => error);
    expect(waited).toBeInstanceOf(NotYet);
    expect([(waited as NotYet).reason, (waited as NotYet).backoff_ms]).toEqual(["provider-limit", NOW + 30_000]);
    queued.push(null, Response.json({}, { status: 429, headers: { "retry-after": "30" } }));
    expect([paths(await call(home, acquirer, record)).length, record.next?.backoff_ms]).toEqual([10, NOW + 30_000]);
    expect(paths(await call(home, acquirer, record))).toHaveLength(15);
    expect(home.heads(SOURCE)).toHaveLength(25);
    queued.push(Response.json({}, { status: 401 }));
    const refused = await call(home, acquirer, record).catch((error: unknown) => error);
    expect([refused instanceof NeedsYou, (refused as NeedsYou).reason]).toEqual([true, "signed-out"]);
    const missing = await call(home, acquirer, record, "fetch", memorySecrets({})).catch((error: unknown) => error);
    expect([missing instanceof NeedsYou, (missing as NeedsYou).reason, (missing as NeedsYou).answered]).toEqual([true, "signed-out", false]);
  });

  it("a page reads below the home's floor", async () => {
    const home = openTestHome();
    const { acquirer } = example(scenario(23, 23));
    const floored = lending(acquirer, NOW - 10.5 * HOUR);
    const record = fresh();
    await call(home, floored, record);
    await history(home, floored, record);
    expect(home.heads(SOURCE).map((head) => head.key).sort()).toEqual(Array.from({ length: 10 }, (_, n) => `note-${n + 13}`).sort());
  });
});

describe("example api's cursor and memory", () => {
  it("grows the cursor with the notes at one instant, reads one again after them, or writes memory on a call that found nothing new (N and 4N)", async () => {
    const measured = async (count: number) => {
      const home = openTestHome();
      const { at, acquirer } = example(scenario(0), 100);
      const record = fresh();
      await call(home, acquirer, record);
      at.scenario = scenario(count, 0, Array.from({ length: count }, (_, n) => n));
      let sealed = 0;
      do sealed += (await call(home, acquirer, record))?.files.length ?? 0;
      while (record.next?.more === true);
      expect([sealed, keys(record, AT_INSTANT).length]).toEqual([count, count]);
      const cursor = Buffer.byteLength(canonical(record.state!));
      expect(await call(home, acquirer, record)).toBeNull();
      expect(record.changes).toEqual({ cleared: [], entries: [] });
      return { count, cursor };
    };
    const n = await measured(500);
    const n4 = await measured(2_000);
    expect(n4.cursor).toBe(n.cursor);
    expect(n.cursor).toBeLessThan(512);
    artifact(openTestHome().dir, "bounded.json", { n, n4 });
  });
});
