import { randomBytes } from "node:crypto";
import { artifact, collect, lending, LENT, openTestHome, poll, type PollRecord, type TestHome } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { byBytes, callMemory } from "../../shared/memory.js";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { canonical, homeSecrets } from "@lifestreamprotocol/core";
import { NeedsYou, type Lent, type Secrets } from "../../seams.js";
import { CALENDAR, gcalApiAcquirer, uidsOf, UNRESOLVED, type CalendarEntry, type GcalApiSettings, type GcalApiState } from "./acquirer.js";
import { gcalApi } from "./reader.js";

const ACCOUNT = "person-a@example.com";
const SOURCE = `google-calendar:${ACCOUNT}:cloud`;
const TOKEN_URI = "https://oauth2.example.com/token";
const T0 = Date.UTC(2026, 8, 7, 4, 0, 0);
const MINUTE = 60_000;
const CREDENTIAL = JSON.stringify({ client_id: "client-0001", client_secret: "client-secret-0001", token_endpoint: TOKEN_URI, refresh_token: "rt-1", access_token: "at-1", expires_ms: 0 });
const HOUR = 60 * 60_000;

function fakeGoogle(calendars: string[], pageSize = 2) {
  let issued = 1;
  const valid = new Set(["rt-1"]);
  let access = "";
  const logs = new Map(calendars.map((calendar) => [calendar, [] as JsonObject[]]));
  const expired = new Set<string>();
  const failing = new Set<string>();
  const requests: string[] = [];
  let duringList: (() => void) | undefined;
  let allowance: number | undefined;
  const fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (url.href === TOKEN_URI) {
      const form = new URLSearchParams(String(init!.body));
      requests.push(`token ${form.get("refresh_token")}`);
      const given = form.get("refresh_token")!;
      if (form.get("grant_type") !== "refresh_token" || form.get("client_id") !== "client-0001" || form.get("client_secret") !== "client-secret-0001" || !valid.has(given)) {
        return Response.json({ error: "invalid_grant", error_description: "a private provider text" }, { status: 400 });
      }
      valid.delete(given);
      const next = `rt-${++issued}`;
      valid.add(next);
      access = `at-${issued}`;
      return Response.json({ access_token: access, refresh_token: next, expires_in: 3599 });
    }
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${access}`) return new Response("a private provider text", { status: 401 });
    duringList?.();
    const calendar = decodeURIComponent(url.pathname.split("/")[4]!);
    const log = logs.get(calendar)!;
    requests.push(`list ${calendar} ${[...url.searchParams].filter(([name]) => name !== "maxResults").map(([name, value]) => `${name}=${value}`).join("&")}`);
    if (failing.has(calendar)) return new Response("a private provider text", { status: 500 });
    if (allowance !== undefined && allowance-- === 0) {
      allowance = undefined;
      return new Response("a private provider text", { status: 429, headers: { "retry-after": "120" } });
    }
    const sync = url.searchParams.get("syncToken");
    if (sync !== null && expired.has(sync)) return Response.json({ error: { code: 410 } }, { status: 410 });
    const offset = Number(url.searchParams.get("pageToken") ?? "0");
    const changes = sync !== null ? log.slice(Number(sync.split(":")[1])).filter((item) => item.quiet !== true) : full(log, url.searchParams);
    const items = changes.slice(offset, offset + pageSize);
    const more = offset + pageSize < changes.length;
    return Response.json({ kind: "calendar#events", items, ...(more ? { nextPageToken: String(offset + pageSize) } : { nextSyncToken: `${calendar}:${log.length}` }) });
  }) as typeof globalThis.fetch;
  const full = (log: JsonObject[], query: URLSearchParams): JsonObject[] => {
    const newest = new Map<string, JsonObject>();
    for (const item of log) if (item.quiet !== true) newest.set(item.id as string, item);
    const timeMin = query.get("timeMin");
    return [...newest.values()].filter((item) => item.status === "cancelled"
      ? query.get("showDeleted") === "true"
      : timeMin === null || (item.end as { date: string }).date > timeMin.slice(0, 10));
  };
  return {
    fetch,
    requests,
    expired,
    failing,
    valid,
    add(calendar: string, id: string, day: number) {
      const date = `2026-09-${String(day).padStart(2, "0")}`;
      logs.get(calendar)!.push({ kind: "calendar#event", id, status: "confirmed", iCalUID: `${id}@google.com`, summary: `synthetic ${id}`, start: { date }, end: { date: `2026-09-${String(day + 1).padStart(2, "0")}` } });
    },
    edit(calendar: string, id: string, summary: string) {
      const log = logs.get(calendar)!;
      const last = [...log].reverse().find((item) => item.id === id)!;
      log.push({ ...last, summary });
    },
    cancel(calendar: string, id: string, instance?: { of: string; date: string }) {
      logs.get(calendar)!.push({ kind: "calendar#event", id, status: "cancelled", ...(instance === undefined ? {} : { recurringEventId: instance.of, originalStartTime: { date: instance.date } }) });
    },
    instance(calendar: string, series: string, date: string, summary: string) {
      const id = `${series}_${date.replaceAll("-", "")}`;
      logs.get(calendar)!.push({ kind: "calendar#event", id, status: "confirmed", iCalUID: `${series}@google.com`, summary, recurringEventId: series, originalStartTime: { date }, start: { date }, end: { date: `${date.slice(0, 8)}${String(Number(date.slice(8)) + 1).padStart(2, "0")}` } });
      return id;
    },
    quiet(calendar: string) {
      logs.get(calendar)!.push({ quiet: true });
    },
    limitAfter(answered: number) {
      allowance = answered;
    },
    onNextList(work: () => void) {
      duringList = () => {
        duringList = undefined;
        work();
      };
    },
  };
}

const SETTINGS: GcalApiSettings = { account: ACCOUNT, signin: "gcal-signin", calendars: ["primary", "second"] };
const FLOOR = Date.UTC(2026, 0, 1);

const VAULT_KEY = randomBytes(32);

function secretStore(dir: string): () => Secrets {
  writeFileSync(join(dir, "gcal-signin"), CREDENTIAL, { mode: 0o600 });
  return () => homeSecrets(dir, { key: VAULT_KEY });
}

const keys = (record: PollRecord, home: TestHome): Promise<string[][]> =>
  Promise.all(record.deliveries.map(async (delivery) => (await collect(gcalApi.read(delivery, home.blobs))).map((row) => row.key)));

const held = (record: PollRecord, part: string): Record<string, Json> =>
  Object.fromEntries([...(record.memory?.get(part) ?? [])].sort(([a], [b]) => byBytes(a, b)).map(([key, value]) => [key, JSON.parse(value) as Json]));
const tokens = (record: PollRecord): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(held(record, CALENDAR)).map(([calendar, entry]) => [calendar, (entry as CalendarEntry).token]));
const remembered = (record: PollRecord): Record<string, Record<string, Json>> => Object.fromEntries([...(record.memory?.keys() ?? [])].map((part) => [part, held(record, part)]));
const MEMORY = (): Lent => ({ ...LENT, memory: callMemory(null) });

describe("gcal-api acquirer: each of these is impossible", () => {
  it("a crash between rotating a secret and sealing loses it", async () => {
    const home = openTestHome();
    const google = fakeGoogle(SETTINGS.calendars);
    google.add("primary", "evt1", 8);
    const store = secretStore(home.dir);
    let clock = T0;
    const acquirer = lending(gcalApiAcquirer(SETTINGS, { fetch: google.fetch, now: () => clock }), FLOOR);
    let onDisk: string | undefined;
    const held = (): string => JSON.parse(store().get("gcal-signin")!).refresh_token as string;
    google.onNextList(() => (onDisk = readFileSync(join(home.dir, "gcal-signin"), "utf8").startsWith("lifestream-sealed:v1:") ? held() : "plain"));
    const fetched = await acquirer.fetch(null, store(), MEMORY());
    expect(onDisk).toBe("rt-2");
    expect(JSON.parse(store().get("gcal-signin")!)).toEqual({ client_id: "client-0001", client_secret: "client-secret-0001", token_endpoint: TOKEN_URI, refresh_token: "rt-2", access_token: "at-2", expires_ms: T0 + 3_599_000 });
    expect(fetched.files.length).toBeGreaterThan(0);
    expect(google.valid.has("rt-1")).toBe(false);
    const record: PollRecord = { state: null, deliveries: [] };
    clock += MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect(held()).toBe("rt-2");
    expect(await keys(record, home)).toEqual([["evt1@google.com"]]);
    clock += HOUR;
    await poll(home, acquirer, record, store(), clock);
    expect(held()).toBe("rt-3");
    const forgetful: Secrets = { get: (service) => (service === "gcal-signin" ? JSON.stringify({ ...JSON.parse(CREDENTIAL), refresh_token: "rt-2" }) : store().get(service)), rotate() {} };
    const error = await acquirer.fetch(record.state, forgetful, MEMORY()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NeedsYou);
    expect((error as NeedsYou).reason).toBe("signed-out");
    expect(String(error)).not.toMatch(/private/u);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record) });
  });

  it("a poll fetches what the previous one sealed", async () => {
    const home = openTestHome();
    const google = fakeGoogle(SETTINGS.calendars);
    for (const [index, id] of ["evt1", "evt2", "evt3"].entries()) google.add("primary", id, 8 + index);
    google.add("second", "evt4", 12);
    const store = secretStore(home.dir);
    let clock = T0;
    const acquirer = lending(gcalApiAcquirer(SETTINGS, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), clock);
    google.add("primary", "evt5", 14);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect(await keys(record, home)).toEqual([["evt1@google.com", "evt2@google.com", "evt3@google.com", "evt4@google.com"], ["evt5@google.com"]]);
    for (const delivery of record.deliveries) await home.land(gcalApi, delivery);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(["evt1@google.com", "evt2@google.com", "evt3@google.com", "evt4@google.com", "evt5@google.com"]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a provider cursor goes backward", async () => {
    const home = openTestHome();
    const google = fakeGoogle(SETTINGS.calendars);
    google.add("primary", "evt1", 8);
    google.add("second", "evt2", 9);
    const store = secretStore(home.dir);
    let clock = T0;
    const acquirer = lending(gcalApiAcquirer(SETTINGS, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), clock);
    const first = structuredClone(record.state);
    const kept = structuredClone(record.memory);
    expect(tokens(record)).toEqual({ primary: "primary:1", second: "second:1" });

    google.add("primary", "evt3", 10);
    google.failing.add("second");
    clock += 5 * MINUTE;
    await expect(poll(home, acquirer, record, store(), clock)).rejects.toThrow(/second answered HTTP 500$/u);
    expect([record.state, record.memory]).toEqual([first, kept]);
    google.failing.clear();
    clock += MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect(tokens(record)).toEqual({ primary: "primary:2", second: "second:1" });

    google.expired.add("primary:2");
    google.add("primary", "evt4", 11);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    const full = "showDeleted=true&timeMin=2026-01-01T00:00:00Z";
    expect(google.requests.filter((request) => request.startsWith("list primary"))).toEqual([
      `list primary ${full}`,
      "list primary syncToken=primary:1",
      "list primary syncToken=primary:1",
      "list primary syncToken=primary:2",
      `list primary ${full}`,
      `list primary ${full}&pageToken=2`,
      "list primary syncToken=primary:3",
    ]);
    expect(await keys(record, home)).toEqual([["evt1@google.com", "evt2@google.com"], ["evt3@google.com"], ["evt1@google.com", "evt3@google.com", "evt4@google.com"]]);
    const manifest = JSON.parse(home.blobs.text(record.deliveries[2]!.files.find((file) => file.path === "pull.json")!.blob)) as { time_min?: string; warnings?: string[] };
    expect(manifest.time_min).toBe("2026-01-01T00:00:00Z");
    expect(manifest.warnings).toEqual(["calendar primary's sync token expired; it was listed in full from 2026-01-01T00:00:00Z"]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });

  it("a start moved earlier once every calendar is synced never reads what it adds, or one moved later keeps the sync tokens of the old start", async () => {
    const home = openTestHome();
    const google = fakeGoogle(SETTINGS.calendars);
    google.add("primary", "evt1", 8);
    google.add("primary", "evt2", 12);
    google.add("second", "evt3", 9);
    const store = secretStore(home.dir);
    let clock = T0;
    const record: PollRecord = { state: null, deliveries: [] };
    const acquirer = gcalApiAcquirer(SETTINGS, { fetch: google.fetch, now: () => clock });
    const at = (start: string) => Date.parse(`${start}T00:00:00Z`);
    await poll(home, acquirer, record, store(), clock, "fetch", at("2026-09-10"));
    expect(record.from_ms).toBe(Date.UTC(2026, 8, 10));
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock, "fetch", at("2026-01-01"));
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock, "fetch", at("2026-01-01"));
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock, "fetch", at("2026-09-10"));
    expect(await keys(record, home)).toEqual([["evt2@google.com"], ["evt1@google.com", "evt2@google.com", "evt3@google.com"], ["evt2@google.com"]]);
    expect(google.requests.filter((request) => request.startsWith("list primary"))).toEqual([
      "list primary showDeleted=true&timeMin=2026-09-10T00:00:00Z",
      "list primary showDeleted=true&timeMin=2026-01-01T00:00:00Z",
      "list primary syncToken=primary:2",
      "list primary showDeleted=true&timeMin=2026-09-10T00:00:00Z",
    ]);
    const warnings = (delivery: number) => (JSON.parse(home.blobs.text(record.deliveries[delivery]!.files.find((file) => file.path === "pull.json")!.blob)) as { warnings?: string[] }).warnings;
    expect(warnings(1)).toEqual(["primary", "second"].map((calendar) => `the start moved: calendar ${calendar} was listed in full from 2026-01-01T00:00:00Z`));
    expect(warnings(2)).toEqual(["primary", "second"].map((calendar) => `the start moved: calendar ${calendar} was listed in full from 2026-09-10T00:00:00Z`));
    expect(Object.keys(record.state!)).toEqual(["polled_ms"]);
    expect(record.from_ms).toBe(Date.UTC(2026, 8, 10));
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });

  it("a sync answer lands an event that ends before the start: one added since with an old date, or an old one edited", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary"]);
    google.add("primary", "evt1", 8);
    google.add("primary", "evt2", 12);
    const store = secretStore(home.dir);
    let clock = T0;
    const record: PollRecord = { state: null, deliveries: [] };
    const acquirer = gcalApiAcquirer({ ...SETTINGS, calendars: ["primary"] }, { fetch: google.fetch, now: () => clock });
    const start = Date.UTC(2026, 8, 10);
    await poll(home, acquirer, record, store(), clock, "fetch", start);
    google.edit("primary", "evt1", "synthetic evt1, edited");
    google.add("primary", "evt3", 5);
    google.edit("primary", "evt2", "synthetic evt2, edited");
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock, "fetch", start);
    expect(google.requests.filter((request) => request.startsWith("list primary"))).toEqual([
      "list primary showDeleted=true&timeMin=2026-09-10T00:00:00Z", "list primary syncToken=primary:2", "list primary syncToken=primary:2&pageToken=2",
    ]);
    expect(await keys(record, home)).toEqual([["evt2@google.com"], ["evt2@google.com"]]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, sealed: await keys(record, home) });
  });

  it("a sync token's expiry loses an edit to a past event, or a deletion", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary"]);
    google.add("primary", "evt1", 8);
    google.add("primary", "evt2", 9);
    const store = secretStore(home.dir);
    let clock = T0;
    const settings = { ...SETTINGS, calendars: ["primary"] };
    const acquirer = lending(gcalApiAcquirer(settings, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), clock);
    clock += 30 * 24 * 60 * MINUTE;
    google.edit("primary", "evt1", "synthetic evt1, moved");
    google.cancel("primary", "evt2");
    google.expired.add("primary:2");
    await poll(home, acquirer, record, store(), clock);
    for (const delivery of record.deliveries) await home.land(gcalApi, delivery);
    expect(home.heads(SOURCE).map((head) => [head.key, head.gone ? "gone" : "live"])).toEqual([["evt1@google.com", "live"], ["evt2@google.com", "gone"]]);
    expect(JSON.stringify(home.heads(SOURCE)[0]!.content)).toContain("moved");
    expect(google.requests.filter((request) => request.startsWith("list"))).toEqual([
      "list primary showDeleted=true&timeMin=2026-01-01T00:00:00Z",
      "list primary syncToken=primary:2",
      "list primary showDeleted=true&timeMin=2026-01-01T00:00:00Z",
    ]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a cancellation that names only Google's event id deletes nothing", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary"]);
    google.add("primary", "evt1", 8);
    google.add("primary", "series1", 10);
    const changed = google.instance("primary", "series1", "2026-09-17", "synthetic changed instance");
    const store = secretStore(home.dir);
    let clock = T0;
    const settings = { ...SETTINGS, calendars: ["primary"] };
    const acquirer = lending(gcalApiAcquirer(settings, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), clock);
    google.cancel("primary", "evt1");
    google.cancel("primary", changed, { of: "series1", date: "2026-09-17" });
    google.cancel("primary", "series1_20260924", { of: "series1", date: "2026-09-24" });
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    for (const delivery of record.deliveries) await home.land(gcalApi, delivery);
    const heads = Object.fromEntries(home.heads(SOURCE).map((head) => [head.key, head.gone ? "gone" : "live"]));
    expect(heads).toEqual({
      "evt1@google.com": "gone",
      "series1@google.com": "live",
      "series1@google.com:20260917": "gone",
      "series1@google.com:20260924": "gone",
    });
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a cancelled occurrence listed before its series in one pull deletes nothing", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary"]);
    google.cancel("primary", "series2_20260924", { of: "series2", date: "2026-09-24" });
    google.add("primary", "evt1", 8);
    google.add("primary", "series2", 10);
    const store = secretStore(home.dir);
    const settings = { ...SETTINGS, calendars: ["primary"] };
    const acquirer = lending(gcalApiAcquirer(settings, { fetch: google.fetch, now: () => T0 }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), T0);
    expect(google.requests.filter((request) => request.startsWith("list"))).toEqual([
      "list primary showDeleted=true&timeMin=2026-01-01T00:00:00Z",
      "list primary showDeleted=true&timeMin=2026-01-01T00:00:00Z&pageToken=2",
    ]);
    expect(await keys(record, home)).toEqual([["series2@google.com:20260924", "evt1@google.com", "series2@google.com"]]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });

  it("a limit part way through a calendar loses its pages read or lists it from its start again, or a cancellation before the stop loses its series' UID", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary"]);
    google.cancel("primary", "series2_20260924", { of: "series2", date: "2026-09-24" });
    for (const [index, id] of ["evt1", "evt2", "evt3"].entries()) google.add("primary", id, 8 + index);
    google.add("primary", "series2", 12);
    const store = secretStore(home.dir);
    let clock = T0;
    const settings = { ...SETTINGS, calendars: ["primary"] };
    const acquirer = lending(gcalApiAcquirer(settings, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    google.limitAfter(1);
    await poll(home, acquirer, record, store(), clock);
    expect(record.next).toEqual({ backoff_ms: clock + 120_000 });
    const full = "showDeleted=true&timeMin=2026-01-01T00:00:00Z";
    expect((record.state as unknown as GcalApiState).listing).toEqual({ calendar: "primary", query: { showDeleted: "true", timeMin: "2026-01-01T00:00:00Z" }, page_token: "2" });
    expect(held(record, UNRESOLVED)).toEqual({ series2: true });
    clock += 3 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect((record.state as unknown as GcalApiState).listing).toBeUndefined();
    expect(held(record, UNRESOLVED)).toEqual({});
    expect(held(record, CALENDAR)).toEqual({});
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect(google.requests.filter((request) => request.startsWith("list"))).toEqual([
      `list primary ${full}`,
      `list primary ${full}&pageToken=2`,
      `list primary ${full}&pageToken=2`,
      `list primary ${full}&pageToken=4`,
      `list primary ${full}`,
      `list primary ${full}&pageToken=2`,
      `list primary ${full}&pageToken=4`,
      "list primary syncToken=primary:5",
    ]);
    expect(await keys(record, home)).toEqual([
      ["evt1@google.com"],
      ["evt2@google.com", "evt3@google.com", "series2@google.com"],
      ["series2@google.com:20260924", "evt1@google.com", "evt2@google.com", "evt3@google.com", "series2@google.com"],
    ]);
    for (const delivery of record.deliveries) await home.land(gcalApi, delivery);
    expect(home.heads(SOURCE).find((head) => head.key === "series2@google.com:20260924")?.gone).toBe(true);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });
});

describe("gcal-api acquirer, every calendar: each of these is impossible", () => {
  const EVERY: GcalApiSettings = { ...SETTINGS, calendars: [] };

  function withList(entries: { id: string; role?: string; hidden?: true }[], later: string[] = []) {
    const google = fakeGoogle([...entries.map((entry) => entry.id), ...later]);
    let failing = false;
    const fetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/users/me/calendarList")) return google.fetch(input, init);
      google.requests.push(`calendarList ${[...url.searchParams].filter(([name]) => name !== "maxResults").map(([name, value]) => `${name}=${value}`).join("&")}`);
      if (failing) return new Response("a private provider text", { status: 503 });
      const shown = entries.filter((entry) => entry.hidden !== true || url.searchParams.get("showHidden") === "true");
      const offset = Number(url.searchParams.get("pageToken") ?? "0");
      const items = shown.slice(offset, offset + 2).map((entry) => ({ kind: "calendar#calendarListEntry", id: entry.id, accessRole: entry.role ?? "owner", ...(entry.hidden ? { hidden: true } : {}) }));
      return Response.json({ kind: "calendar#calendarList", items, ...(offset + 2 < shown.length ? { nextPageToken: String(offset + 2) } : {}) });
    }) as typeof globalThis.fetch;
    return { ...google, fetch, failList: (on: boolean) => (failing = on) };
  }

  it("a hidden calendar, one on the list's second page, or one added later is never read; a free/busy one refuses the poll", async () => {
    const home = openTestHome();
    const entries: { id: string; role?: string; hidden?: true }[] = [
      { id: "primary" }, { id: "family-0001@group.calendar.google.com", role: "writer", hidden: true },
      { id: "busy-0001@group.calendar.google.com", role: "freeBusyReader" }, { id: "holidays-0001@group.v.calendar.google.com", role: "reader" },
    ];
    const google = withList(entries, ["trips-0001@group.calendar.google.com"]);
    google.add("primary", "evt1", 8);
    google.add("family-0001@group.calendar.google.com", "evt2", 9);
    google.add("holidays-0001@group.v.calendar.google.com", "evt3", 10);
    google.failing.add("busy-0001@group.calendar.google.com");
    const store = secretStore(home.dir);
    let clock = T0;
    const acquirer = lending(gcalApiAcquirer(EVERY, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), clock);
    entries.push({ id: "trips-0001@group.calendar.google.com" });
    google.add("trips-0001@group.calendar.google.com", "evt4", 11);
    clock += 5 * MINUTE;
    await poll(home, acquirer, record, store(), clock);
    for (const delivery of record.deliveries) await home.land(gcalApi, delivery);
    expect(home.heads(SOURCE).map((head) => head.key)).toEqual(["evt1@google.com", "evt2@google.com", "evt3@google.com", "evt4@google.com"]);
    expect(google.requests.filter((request) => request.startsWith("calendarList"))).toEqual([
      "calendarList showHidden=true", "calendarList showHidden=true&pageToken=2",
      "calendarList showHidden=true", "calendarList showHidden=true&pageToken=2", "calendarList showHidden=true&pageToken=4",
    ]);
    expect(google.requests.some((request) => request.startsWith("list busy"))).toBe(false);
    expect(Object.keys(record.state!)).toEqual(["polled_ms"]);
    expect(Object.keys(tokens(record))).toEqual([
      "family-0001@group.calendar.google.com", "holidays-0001@group.v.calendar.google.com", "primary", "trips-0001@group.calendar.google.com",
    ]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), heads: home.heads(SOURCE) });
  });

  it("a calendar list Google fails to answer seals a poll of no calendars", async () => {
    const home = openTestHome();
    const google = withList([{ id: "primary" }]);
    google.add("primary", "evt1", 8);
    const store = secretStore(home.dir);
    let clock = T0;
    const acquirer = lending(gcalApiAcquirer(EVERY, { fetch: google.fetch, now: () => clock }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    google.failList(true);
    const error = await poll(home, acquirer, record, store(), clock).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Refused);
    expect(String(error)).toMatch(/the calendar list answered HTTP 503$/u);
    expect([record.state, record.deliveries]).toEqual([null, []]);
    google.failList(false);
    clock += MINUTE;
    await poll(home, acquirer, record, store(), clock);
    expect(await keys(record, home)).toEqual([["evt1@google.com"]]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });

  it("a named list is read as every calendar", async () => {
    const home = openTestHome();
    const google = withList([{ id: "primary" }, { id: "second" }]);
    google.add("primary", "evt1", 8);
    google.add("second", "evt2", 9);
    const store = secretStore(home.dir);
    const acquirer = lending(gcalApiAcquirer({ ...SETTINGS, calendars: ["second"] }, { fetch: google.fetch, now: () => T0 }), FLOOR);
    const record: PollRecord = { state: null, deliveries: [] };
    await poll(home, acquirer, record, store(), T0);
    expect(await keys(record, home)).toEqual([["evt2@google.com"]]);
    expect(google.requests.filter((request) => !request.startsWith("token"))).toEqual(["list second showDeleted=true&timeMin=2026-01-01T00:00:00Z"]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record), sealed: await keys(record, home) });
  });
});

describe("gcal-api's cursor and memory", () => {
  it("grows the cursor with history, fetches what it has after it, writes memory on a call that found nothing new, or loses the UID a cancellation after it needs (N and 4N events with series and cancellations)", async () => {
    const calendars = ["primary", "second"];
    const history = async (total: number) => {
      const home = openTestHome();
      const google = fakeGoogle(calendars, 2_500);
      for (let n = 0; n < total; n++) {
        const calendar = calendars[n % 2]!;
        google.add(calendar, `evt${n}`, 8 + (n % 20));
        if (n % 10 === 0) google.instance(calendar, `evt${n}`, "2026-09-28", `synthetic changed instance ${n}`);
        if (n % 25 === 1) google.cancel(calendar, `evt${n}`);
      }
      const store = secretStore(home.dir);
      let clock = T0;
      const acquirer = lending(gcalApiAcquirer(SETTINGS, { fetch: google.fetch, now: () => clock }), FLOOR);
      const record: PollRecord = { state: null, deliveries: [] };
      await poll(home, acquirer, record, store(), clock);
      expect(record.next).toEqual({});
      const cursor = Buffer.byteLength(canonical(record.state!));
      const ids = calendars.map((calendar) => Object.keys(held(record, uidsOf(calendar))).length);
      expect(ids.reduce((a, b) => a + b)).toBe(total + total / 10 - total / 25);
      clock += 5 * MINUTE;
      let from = google.requests.length;
      const sealed = record.deliveries.length;
      await poll(home, acquirer, record, store(), clock);
      expect(google.requests.slice(from).filter((request) => request.startsWith("list"))).toEqual(calendars.map((calendar) => expect.stringMatching(new RegExp(`^list ${calendar} syncToken=${calendar}:\\d+$`, "u"))));
      expect(record.deliveries.length).toBe(sealed);
      expect(record.changes).toEqual({ cleared: [], entries: [] });
      google.cancel("primary", "evt0");
      google.cancel("primary", "evt10_20260921", { of: "evt10", date: "2026-09-21" });
      clock += 5 * MINUTE;
      from = google.requests.length;
      await poll(home, acquirer, record, store(), clock);
      expect(await keys({ ...record, deliveries: record.deliveries.slice(-1) }, home)).toEqual([["evt0@google.com", "evt10@google.com:20260921"]]);
      expect([held(record, uidsOf("primary")).evt0, held(record, uidsOf("primary")).evt10]).toEqual([undefined, "evt10@google.com"]);
      return { total, cursor, ids, requests: google.requests.length };
    };
    const n = await history(2_000);
    const n4 = await history(8_000);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(openTestHome().dir, "bounded.json", { n, n4 });
  });

  it("a sync token Google moved on an empty answer is lost, or a calendar that left the list loses its token or its ids", async () => {
    const home = openTestHome();
    const google = fakeGoogle(["primary", "second"]);
    google.add("primary", "evt1", 8);
    google.add("second", "evt2", 9);
    const store = secretStore(home.dir);
    let clock = T0;
    const record: PollRecord = { state: null, deliveries: [] };
    const reading = (calendars: string[]) => lending(gcalApiAcquirer({ ...SETTINGS, calendars }, { fetch: google.fetch, now: () => clock }), FLOOR);
    await poll(home, reading(["primary", "second"]), record, store(), clock);
    google.quiet("primary");
    clock += 5 * MINUTE;
    await poll(home, reading(["primary", "second"]), record, store(), clock);
    expect(record.changes).toEqual({ cleared: [], entries: [[CALENDAR, "primary", canonical({ token: "primary:2" })]] });
    clock += 5 * MINUTE;
    await poll(home, reading(["primary"]), record, store(), clock);
    expect([tokens(record), held(record, uidsOf("second"))]).toEqual([{ primary: "primary:2", second: "second:1" }, { evt2: "evt2@google.com" }]);
    clock += 5 * MINUTE;
    const from = google.requests.length;
    await poll(home, reading(["primary", "second"]), record, store(), clock);
    expect(google.requests.slice(from).filter((request) => request.startsWith("list second"))).toEqual(["list second syncToken=second:1"]);
    artifact(home.dir, "polls.json", { requests: google.requests, state: record.state, memory: remembered(record) });
  });
});
