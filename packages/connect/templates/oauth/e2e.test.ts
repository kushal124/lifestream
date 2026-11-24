import { describe, expect, it } from "vitest";
import { canonical, type Delivery } from "@lifestreamprotocol/connect/sdk";
import { NeedsYou, NotYet, type Acquirer } from "../../seams.js";
import { oauthCredential } from "../../shared/oauth.js";
import type { Scenario } from "../../shared/dependencies.js";
import { artifact, lending, memorySecrets, openTestHome, poll, temp, type PollRecord, type TestHome } from "../../test/drive.js";
import { AT_INSTANT, AT_NEWEST, exampleOauthAcquirer } from "./acquirer.js";
import { exampleOauth } from "./reader.js";
import { CLIENT, EXPIRES_IN, editedAt, provider, secrets, signin, SOURCE, settings } from "./test/fixture.js";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const HOUR = 3_600_000;

const scenario = (items: number, old = 0, edited: readonly number[] = []): Scenario => ({ items, old, edited, removed: [], start_ms: NOW });

function example(start: Scenario, page?: number) {
  const queued: (Response | null)[] = [];
  const requested: { url: URL; sent: string }[] = [];
  const at = { scenario: start, now: NOW };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const form = new URLSearchParams(await request.clone().text());
    requested.push({ url: new URL(request.url), sent: request.headers.get("authorization") ?? form.get("refresh_token") ?? "" });
    return queued.shift() ?? provider(at.scenario, page)(request);
  };
  const acquirer = exampleOauthAcquirer({ ...settings, work: temp("example-oauth-work-"), zone: "UTC", unit: "macbook-pro-0001" }, { fetch, now: () => at.now, sleep: async () => undefined });
  return { at, queued, requested, acquirer };
}

const SECRETS = () => memorySecrets({ ...secrets });

const fresh = (): PollRecord => ({ state: null, deliveries: [] });

async function call(home: TestHome, acquirer: Acquirer, record: PollRecord, kind: "fetch" | "page" = "fetch", vault = SECRETS()): Promise<Delivery | null> {
  const delivery = await poll(home, acquirer, record, vault, NOW, kind);
  if (delivery === undefined) return null;
  await home.land(exampleOauth, delivery);
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

describe("example oauth: each of these is impossible", () => {
  it("a first fetch reads history as new, history misses an old note or lands one twice, or a note is timed by when it arrived", async () => {
    const home = openTestHome();
    const { acquirer, requested } = example(scenario(25, 23));
    const record = fresh();
    expect(paths(await call(home, acquirer, record))).toEqual(["notes/note-23.json", "notes/note-24.json"]);
    expect(await history(home, acquirer, record)).toEqual([13, 3, 0]);
    const heads = home.heads(SOURCE);
    expect(heads).toHaveLength(25);
    expect(heads.find((head) => head.key === "note-0")!.start_ms).toBe(NOW - 23 * HOUR);
    expect(new Set(requested.map(({ url }) => url.origin))).toEqual(new Set(["https://api.example.com"]));
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

  it("a limit with nothing read seals or fails, or a limit after a page loses it", async () => {
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
  });

  it("an expired sign-in is sent as it stands, its rotated refresh token is dropped or not sent next, or a refused one is anything but signed out", async () => {
    const home = openTestHome();
    const { at, queued, requested, acquirer } = example(scenario(0));
    const record = fresh();
    const vault = memorySecrets({ [settings.signin]: signin(1, NOW - 1) });
    await call(home, acquirer, record, "fetch", vault);
    expect(requested.map(({ url, sent }) => `${url.href.split("?")[0]} ${sent}`)).toEqual([`${CLIENT.token} refresh-synthetic-1`, "https://api.example.com/v1/notes Bearer access-synthetic-2"]);
    const kept = oauthCredential(vault.values[settings.signin]!, settings.signin);
    expect([kept.refresh_token, kept.access_token, kept.expires_ms, kept.token_endpoint]).toEqual(["refresh-synthetic-2", "access-synthetic-2", NOW + EXPIRES_IN * 1000, CLIENT.token]);
    at.now = NOW + 10 * 60_000;
    at.scenario = scenario(3);
    requested.length = 0;
    expect(paths(await call(home, acquirer, record, "fetch", vault))).toHaveLength(3);
    expect(requested.map(({ sent }) => sent)).toEqual(["Bearer access-synthetic-2"]);
    at.now = NOW + 2 * 3_600_000;
    requested.length = 0;
    await call(home, acquirer, record, "fetch", vault);
    expect(requested.map(({ sent }) => sent)).toEqual(["refresh-synthetic-2", "Bearer access-synthetic-3"]);
    at.now += 2 * 3_600_000;
    const before = vault.values[settings.signin];
    queued.push(Response.json({ error: "invalid_grant" }, { status: 400 }));
    const refused = await call(home, acquirer, record, "fetch", vault).catch((error: unknown) => error);
    expect([refused instanceof NeedsYou, (refused as NeedsYou).reason, vault.values[settings.signin]]).toEqual([true, "signed-out", before]);
    queued.push(Response.json({}, { status: 401 }), Response.json({ error: "invalid_grant" }, { status: 400 }));
    const revoked = await call(home, acquirer, record, "fetch", memorySecrets({ ...secrets })).catch((error: unknown) => error);
    expect([revoked instanceof NeedsYou, (revoked as NeedsYou).reason]).toEqual([true, "signed-out"]);
    requested.length = 0;
    const missing = await call(home, acquirer, record, "fetch", memorySecrets({})).catch((error: unknown) => error);
    expect([missing instanceof NeedsYou, (missing as NeedsYou).answered, requested]).toEqual([true, false, []]);
    expect(record.deliveries).toHaveLength(1);
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

describe("example oauth's cursor and memory", () => {
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
