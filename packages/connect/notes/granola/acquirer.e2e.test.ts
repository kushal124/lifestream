import { describe, expect, it } from "vitest";
import { canonical, type JsonObject } from "@lifestreamprotocol/core";
import { NeedsYou, NotYet, type Acquirer } from "../../seams.js";
import { Refused } from "../../shared/refused.js";
import { issuerOf, routeNamed } from "../../declaration.js";
import { artifact, memorySecrets, openTestHome, poll, type PollRecord, type TestHome } from "../../test/drive.js";
import { granolaApiAcquirer, type GranolaApiState } from "./api.js";
import { granolaMcpAcquirer, granolaMcpSignedIn, placeOf, QUEUE, QUEUED, SEEN, type GranolaMcpState } from "./mcp.js";
import { granola as meetings } from "./connector.js";
import { granola } from "./reader.js";
import { fakeGranola, type FakeGranola, type FakeNote } from "./test/fake.js";
import { rfc3339 } from "../../shared/delivery.js";
import { ACCOUNT, SOURCE } from "./test/fixtures.js";

const KEY = "grn_synthetic_0001";
const ISSUER = issuerOf(routeNamed(meetings, "granola-mcp", "device"));
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const LIVE = new AbortController().signal;

function apiRoute(options: { per_poll?: number } = {}) {
  const fake = fakeGranola(ACCOUNT, KEY);
  const secrets = memorySecrets({ granola: KEY });
  const acquirer = granolaApiAcquirer({ account: ACCOUNT, key: "granola", ...options }, { fetch: fake.fetch, now: fake.now, sleep: fake.sleep });
  return { fake, secrets, acquirer, home: openTestHome(), record: { state: null, deliveries: [] } as PollRecord, calls: [] as JsonObject[] };
}

async function call(route: { fake: FakeGranola; home: TestHome; acquirer: Acquirer; record: PollRecord; secrets: ReturnType<typeof memorySecrets>; calls: JsonObject[] }, which: "fetch" | "page" = "fetch") {
  const delivery = await poll(route.home, route.acquirer, route.record, route.secrets, route.fake.clock, which);
  route.calls.push(route.record.facts!);
  return delivery === undefined ? undefined : { delivery, landed: await route.home.land(granola, delivery) };
}

async function untilDone(route: Parameters<typeof call>[0], which: "fetch" | "page"): Promise<number> {
  for (let calls = 1; calls < 100; calls++) {
    await call(route, which);
    if (which === "fetch" ? route.record.next?.more === undefined : route.record.left === 0) return calls;
    route.fake.tick(which === "page" ? MINUTE : 0);
  }
  throw new Error(`the ${which} never ended`);
}

const titles = (home: TestHome) => Object.fromEntries(home.heads(SOURCE, ["note"]).map((head) => [head.key, ((head.content as { note: { title: string } }).note).title]));
const stateOf = (record: PollRecord) => record.state as unknown as GranolaApiState;
const held = (record: PollRecord, part: string): Record<string, unknown> =>
  Object.fromEntries([...(record.memory?.get(part) ?? [])].map(([key, value]) => [key, JSON.parse(value) as unknown]));

describe("granola-api: each of these is impossible", () => {
  it("a note edited after the cursor keeps its head, one left out of a list goes, a note read again writes a version, or a second holds more than 4 requests", async () => {
    const route = apiRoute();
    const { fake, home } = route;
    const a = fake.note({ title: "Synthetic standup" });
    fake.tick();
    fake.note({ title: "Synthetic retro" });
    fake.tick();
    expect(await call(route)).toBeUndefined();
    expect(route.calls[0]!.notes).toBe(0);
    await untilDone(route, "page");
    expect(Object.values(titles(home)).sort()).toEqual(["Synthetic retro", "Synthetic standup"]);

    fake.tick(5 * MINUTE);
    fake.edit(a, { title: "Synthetic standup, edited" });
    fake.tick(5 * MINUTE);
    const edited = await call(route);
    expect(edited!.landed.changed).toBe(1);
    expect(Object.values(titles(home)).sort()).toEqual(["Synthetic retro", "Synthetic standup, edited"]);
    fake.tick(5 * MINUTE);
    expect(await call(route)).toBeUndefined();
    expect(home.heads(SOURCE).every((head) => !head.gone)).toBe(true);

    const times = fake.requests.filter((each) => each.url.startsWith("https://public-api.granola.ai")).map((each) => each.at);
    for (let index = 4; index < times.length; index++) expect(times[index]! - times[index - 4]!).toBeGreaterThanOrEqual(1000);
    artifact(home.dir, "edits.json", { requests: fake.requests, state: route.record.state, heads: home.heads(SOURCE) });
  });

  it("a fetch lands a note created before the start and edited since, or a start moved earlier never reads it", async () => {
    const { fake, home, record, secrets, acquirer } = apiRoute();
    const start = fake.clock - 30 * DAY;
    const earlier = start - 30 * DAY;
    const old = fake.note({ title: "Synthetic old meeting", created_at: rfc3339(start - 10 * DAY), updated_at: rfc3339(start - 10 * DAY) });
    fake.note({ title: "Synthetic recent meeting" });
    fake.tick();
    const at = async (which: "fetch" | "page", start_ms: number) => {
      const delivery = await poll(home, acquirer, record, secrets, fake.clock, which, start_ms);
      if (delivery !== undefined) await home.land(granola, delivery);
    };
    await at("fetch", start);
    await at("page", start);
    expect(record.left).toBe(0);
    expect(Object.values(titles(home))).toEqual(["Synthetic recent meeting"]);
    fake.tick(5 * MINUTE);
    fake.edit(old, { title: "Synthetic old meeting, edited" });
    fake.tick(15 * MINUTE);
    fake.requests.length = 0;
    await at("fetch", start);
    const listed = fake.requests.map((each) => new URL(each.url)).filter((url) => url.pathname === "/v1/notes");
    expect(listed.map((url) => url.searchParams.get("created_after"))).toEqual([rfc3339(start - 1)]);
    expect(Object.values(titles(home))).toEqual(["Synthetic recent meeting"]);
    await at("fetch", earlier);
    await at("page", earlier);
    expect(record.left).toBe(0);
    expect(Object.values(titles(home)).sort()).toEqual(["Synthetic old meeting, edited", "Synthetic recent meeting"]);
    artifact(home.dir, "started.json", { requests: fake.requests, state: record.state, heads: home.heads(SOURCE) });
  });

  it("a note edited on a page already read while later pages are read is lost, or two notes updated at the cursor's instant lose one", async () => {
    const route = apiRoute();
    const { fake, home } = route;
    await call(route);
    const notes: FakeNote[] = [];
    for (let n = 0; n < 35; n++) {
      notes.push(fake.note({ title: `Synthetic meeting ${n}` }));
      fake.tick(1000);
    }
    const newest = notes.at(-1)!;
    const listedBefore = fake.listPages;
    fake.onList = (page) => {
      if (page === listedBefore + 2) fake.edit(newest, { title: "Synthetic meeting, edited mid-walk" });
    };
    await call(route);
    fake.onList = undefined;
    expect(titles(home)[newest.uuid!]).toBe("Synthetic meeting 34");
    fake.tick(5 * MINUTE);
    await call(route);
    expect(titles(home)[newest.uuid!]).toBe("Synthetic meeting, edited mid-walk");
    expect(Object.keys(titles(home))).toHaveLength(35);

    fake.tick(30 * MINUTE);
    fake.edit(notes[0]!, { title: "Synthetic meeting 0, edited" });
    fake.tick(15 * MINUTE);
    await call(route);
    expect(stateOf(route.record).cursor_ms).toBe(Date.parse(notes[0]!.updated_at));
    Object.assign(notes[1]!, { title: "Synthetic meeting 1, edited at the same instant", updated_at: notes[0]!.updated_at });
    fake.tick(5 * MINUTE);
    await call(route);
    expect(titles(home)[notes[1]!.uuid!]).toBe("Synthetic meeting 1, edited at the same instant");
    artifact(home.dir, "walk.json", { states: route.record.state, heads: home.heads(SOURCE, ["note"]) });
  });

  it("a call stopped at its bound mid-listing loses a note or passes its bound, or a 404 note fails the call, goes unnamed or never lands", async () => {
    const route = apiRoute({ per_poll: 12 });
    const { fake, home } = route;
    await call(route);
    const made = Array.from({ length: 40 }, (_, n) => {
      fake.tick(1000);
      return fake.note({ title: `Synthetic note ${n}` });
    });
    const pending = made[17]!;
    pending.summarised = false;
    fake.tick(MINUTE);
    const calls = await untilDone(route, "fetch");
    expect(calls).toBeGreaterThan(3);
    for (const delivery of route.record.deliveries) expect(delivery.facts.requests as number).toBeLessThanOrEqual(12);
    expect(Object.keys(titles(home)).sort()).toEqual(made.filter((note) => note !== pending).map((note) => note.uuid!).sort());
    expect(route.calls.flatMap((facts) => (facts.skipped as string[] | undefined) ?? [])).toContain(pending.id);

    fake.tick(5 * MINUTE);
    fake.edit(pending, { summarised: true });
    fake.tick(MINUTE);
    await untilDone(route, "fetch");
    expect(titles(home)[pending.uuid!]).toBe("Synthetic note 17");
    artifact(home.dir, "bound.json", { facts: route.record.deliveries.map((delivery) => delivery.facts), heads: home.heads(SOURCE, ["note"]) });
  });

  it("a backfill loses a note sharing a creation instant across a page break, a cursor refused between them included", async () => {
    const route = apiRoute();
    const { fake, home } = route;
    const made: FakeNote[] = [];
    for (let n = 0; n < 33; n++) {
      if (n >= 5) fake.tick(1000);
      made.push(fake.note({ title: `Synthetic old note ${n}` }));
    }
    fake.tick(MINUTE);
    await call(route);
    await call(route, "page");
    expect(route.record.left).toBeNull();
    const oldest = stateOf(route.record).backfill!.oldest_ms!;
    fake.refusedCursors.add(stateOf(route.record).backfill!.cursor!);
    const asked: URL[] = [];
    fake.onList = (_page, url) => asked.push(url);
    fake.tick(MINUTE);
    await untilDone(route, "page");
    fake.onList = undefined;
    expect([asked[0]!.searchParams.get("created_before"), asked[0]!.searchParams.get("cursor")]).toEqual([rfc3339(oldest + 1), null]);
    expect(Object.keys(titles(home)).sort()).toEqual(made.map((note) => note.uuid!).sort());
    expect(stateOf(route.record).backfill!.before_ms).toBe(Date.parse(made[0]!.created_at) + 1);
  });

  it("a 413 note's transcript loses a page, or a 429 loses what finished or lets the next call come within 10 seconds", async () => {
    const route = apiRoute();
    const { fake, home } = route;
    await call(route);
    for (let n = 0; n < 4; n++) {
      fake.tick(1000);
      fake.note({ title: `Synthetic short meeting ${n}` });
    }
    fake.tick(1000);
    const start = fake.clock;
    const long = fake.note({
      title: "Synthetic long meeting",
      transcript: Array.from({ length: 250 }, (_, n) => ({ speaker: { source: n % 2 === 0 ? "microphone" : "speaker" }, text: `synthetic line ${n}`, start_time: new Date(start + n * 1000).toISOString(), end_time: new Date(start + n * 1000 + 900).toISOString() })),
    });
    fake.tooLarge.add(long.id);
    fake.tick(MINUTE);
    fake.limitAfter = fake.requests.filter((each) => each.url.startsWith("https://public-api.granola.ai")).length + 6;
    const stopped = await call(route);
    expect(stopped!.delivery.facts).toMatchObject({ notes: 1, stopped: "rate-limit" });
    expect(route.record.next?.backoff_ms).toBeGreaterThanOrEqual(fake.clock + 10_000);
    const transcript = home.heads(SOURCE, ["transcript"]).find((head) => head.key === long.uuid)!.content as { transcript: { text: string }[] };
    expect(transcript.transcript.map((each) => each.text)).toEqual(long.transcript.map((each) => each.text));

    fake.limitAfter = 0;
    fake.tick(10_000);
    const waiting = await call(route).catch((error: unknown) => error);
    expect(waiting).toBeInstanceOf(NotYet);
    expect((waiting as NotYet).backoff_ms).toBeGreaterThanOrEqual(fake.clock + 10_000);
    expect(route.record.deliveries).toHaveLength(1);

    fake.limitAfter = Number.POSITIVE_INFINITY;
    fake.tick(10_000);
    await untilDone(route, "fetch");
    expect(Object.values(titles(home)).sort()).toEqual(["Synthetic long meeting", ...[0, 1, 2, 3].map((n) => `Synthetic short meeting ${n}`)]);
    artifact(home.dir, "limits.json", { requests: fake.requests, facts: route.record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a note whose transcript and attachments take the call past its bound never lands, or a note begins past the bound", async () => {
    const route = apiRoute({ per_poll: 5 });
    const { fake, home } = route;
    await call(route);
    const short = fake.note({ title: "Synthetic short meeting" });
    fake.tick(1000);
    const start = fake.clock;
    const long = fake.note({
      title: "Synthetic long meeting",
      transcript: Array.from({ length: 250 }, (_, n) => ({ speaker: { source: "microphone" }, text: `synthetic line ${n}`, start_time: new Date(start + n * 1000).toISOString(), end_time: new Date(start + n * 1000 + 900).toISOString() })),
      attachments: [{ id: "att-synthetic-1", bytes: Buffer.from("synthetic image 1") }, { id: "att-synthetic-2", bytes: Buffer.from("synthetic image 2") }],
    });
    fake.tooLarge.add(long.id);
    fake.tick(MINUTE);
    const first = await call(route);
    expect(first!.delivery.facts).toMatchObject({ notes: 1, requests: 8, stopped: "budget" });
    expect(route.record.next?.more).toBe(true);
    const transcript = home.heads(SOURCE, ["transcript"]).find((head) => head.key === long.uuid)!.content as { transcript: { text: string }[] };
    expect(transcript.transcript.map((each) => each.text)).toEqual(long.transcript.map((each) => each.text));
    expect(titles(home)).toEqual({ [long.uuid!]: "Synthetic long meeting" });
    await untilDone(route, "fetch");
    expect(titles(home)[short.uuid!]).toBe("Synthetic short meeting");
    for (const delivery of route.record.deliveries.slice(2)) expect(delivery.facts.requests as number).toBeLessThanOrEqual(5);
    artifact(home.dir, "note-past-bound.json", { facts: route.record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a revoked key lands anything or asks anything but a sign-in, or a note with no UUID becomes two records when edited", async () => {
    const route = apiRoute();
    const { fake, home } = route;
    await call(route);
    const bare = fake.note({ title: "Synthetic unlinked note", uuid: null });
    fake.tick(MINUTE);
    await call(route);
    fake.tick(5 * MINUTE);
    fake.edit(bare, { title: "Synthetic unlinked note, edited" });
    fake.tick(MINUTE);
    await call(route);
    expect(home.heads(SOURCE).map(({ kind, key }) => `${kind} ${key}`)).toEqual([`note ${bare.id}`]);
    expect(titles(home)[bare.id]).toBe("Synthetic unlinked note, edited");

    fake.revoked = true;
    fake.tick(5 * MINUTE);
    const sealed = route.record.deliveries.length;
    const refused = await call(route).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NeedsYou);
    expect((refused as NeedsYou).reason).toBe("signed-out");
    expect(route.record.deliveries).toHaveLength(sealed);
  });
});

function mcpRoute(options: { per_poll?: number; expires_in?: number } = {}) {
  const fake = fakeGranola(ACCOUNT, KEY);
  const secrets = memorySecrets({ "granola.signin": fake.signin(fake.clock + (options.expires_in ?? 6 * 3_600_000)) });
  const acquirer = granolaMcpAcquirer({ account: ACCOUNT, signin: "granola.signin", ...options }, ISSUER, { fetch: fake.fetch, now: fake.now });
  return { fake, secrets, acquirer, home: openTestHome(), record: { state: null, deliveries: [] } as PollRecord, calls: [] as JsonObject[] };
}

describe("granola-mcp: each of these is impossible", () => {
  it("a call refreshes while the token lives, a refresh leaves the vault without the rotated JSON when the delivery is sealed, or the check names no account", async () => {
    const route = mcpRoute();
    const { fake, home, secrets } = route;
    fake.sse = true;
    for (let n = 0; n < 3; n++) {
      fake.note({ title: `Synthetic meeting ${n}` });
      fake.tick(DAY);
    }
    secrets.values["granola.signin"] = fake.signin(fake.clock + 6 * 3_600_000);
    await call(route);
    expect(fake.refreshes).toEqual([]);
    expect(home.heads(SOURCE).map((head) => (head.content as { meeting: { title: string } }).meeting.title).sort()).toEqual(["Synthetic meeting 0", "Synthetic meeting 1", "Synthetic meeting 2"]);

    fake.tick(6 * 3_600_000 - 4 * MINUTE);
    const rotatedAt: number[] = [];
    const watched = { ...secrets, rotate: (name: string, value: string) => { rotatedAt.push(route.record.deliveries.length); secrets.rotate(name, value); } };
    await poll(home, route.acquirer, route.record, watched, fake.clock);
    expect(fake.refreshes).toEqual(["refresh-synthetic-2"]);
    expect(rotatedAt).toEqual([1]);
    const sealed = JSON.parse(secrets.values["granola.signin"]!) as { refresh_token: string; access_token: string; expires_ms: number };
    expect(sealed).toMatchObject({ refresh_token: "refresh-synthetic-3", access_token: "access-synthetic-3", expires_ms: fake.clock + 6 * 3_600_000 });

    const check = granolaMcpSignedIn(ISSUER, { fetch: fake.fetch, now: fake.now });
    const fresh = fake.signin(fake.clock + 2 * MINUTE);
    const checked = await check({ fields: {}, credential: fresh, signal: LIVE }) as { account?: string; credential: string };
    expect(checked.account).toBe(ACCOUNT);
    expect(JSON.parse(checked.credential)).toMatchObject({ refresh_token: fake.refresh, access_token: `access-synthetic-${fake.refresh.split("-").at(-1)}` });
    fake.access.clear();
    fake.refresh = "refresh-synthetic-revoked";
    expect(((await check({ fields: {}, credential: fresh, signal: LIVE }).catch((error: unknown) => error)) as NeedsYou).reason).toBe("signed-out");

    const echoed = "access-synthetic-echoed";
    const answering = (body: string) => (async (input: string | URL | Request, init?: RequestInit) => {
      const sent = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { id?: number; params?: { name?: string } };
      if (sent.params?.name !== "get_account_info") return fake.fetch(input as string, init);
      return new Response(body.replaceAll("<id>", String(sent.id)), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;
    const bodies = [
      `{"jsonrpc":"2.0","id":<id>,"result":{"content":[{"type":"text","text":"${echoed}`,
      `{"jsonrpc":"2.0","id":<id>,"result":{"token":"${echoed}","token":"${echoed}"}}`,
      `{"jsonrpc":"2.0","id":<id>,"error":{"code":"${echoed}","message":"${echoed}"}}`,
      `{"jsonrpc":"2.0","id":<id>,"error":{"code":{"token":"${echoed}"},"message":"${echoed}"}}`,
      `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32603,"message":"${echoed}"}}`,
    ];
    const said: string[] = [];
    for (const body of bodies) {
      const credential = fake.signin(fake.clock + 6 * 3_600_000);
      const refused = await granolaMcpSignedIn(ISSUER, { fetch: answering(body), now: fake.now })({ fields: {}, credential, signal: LIVE }).catch((error: unknown) => error);
      said.push(refused instanceof Refused ? refused.message : String(refused));
    }
    expect(said).toEqual([
      "granola-mcp: Granola's answer to tools/call get_account_info does not read",
      "granola-mcp: Granola's answer to tools/call get_account_info does not read",
      "answer-00001.json: the server answered error",
      "answer-00001.json: the server answered error",
      "answer-00001.json: the server answered error -32603",
    ]);
    artifact(home.dir, "refresh.json", { refreshes: fake.refreshes.length, calls: fake.toolCalls.length, heads: home.heads(SOURCE).length, refusals: said.length });
  });

  it("a first listing past its bound starts over, loses a meeting or reads one twice, or a free plan's notice goes unnamed", async () => {
    const route = mcpRoute({ per_poll: 3 });
    const { fake, home } = route;
    fake.plan = "business";
    fake.mcpPage = 10;
    const made = Array.from({ length: 25 }, (_, n) => {
      const note = fake.note({ title: `Synthetic history ${n}` });
      fake.tick(2 * DAY + 3600_000);
      return note;
    });
    await call(route);
    expect(route.record.next?.more).toBe(true);
    const cursor = (route.record.state as unknown as GranolaMcpState).listing?.cursor;
    if (cursor !== null && cursor !== undefined) fake.refusedCursors.add(cursor);
    await untilDone(route, "fetch");
    for (const delivery of route.record.deliveries) expect(delivery.facts.calls as number).toBeLessThanOrEqual(3);
    expect(home.heads(SOURCE).map((head) => head.key).sort()).toEqual(made.map((note) => note.uuid!).sort());
    const read = fake.toolCalls.filter((each) => each.name === "get_meetings").flatMap((each) => each.arguments.meeting_ids as string[]);
    expect(read.sort()).toEqual(made.map((note) => note.uuid!).sort());
    expect((route.record.state as unknown as GranolaMcpState).reached).toBe(true);

    fake.tick(5 * MINUTE);
    const before = fake.toolCalls.length;
    await call(route);
    expect(fake.toolCalls.slice(before).map((each) => each.name)).toEqual(["list_meetings", "list_meetings"]);
    const recent = made.filter((note) => Date.parse(note.created_at) >= fake.clock - 30 * DAY).map((note) => note.uuid!).sort();
    expect(Object.keys(held(route.record, SEEN)).sort()).toEqual(recent);

    const free = mcpRoute();
    free.fake.note({ title: "Synthetic older meeting" });
    free.fake.tick(40 * DAY);
    free.fake.note({ title: "Synthetic recent meeting" });
    free.fake.tick(DAY);
    await call(free);
    expect(free.record.deliveries[0]!.facts.notices).toEqual(["Your plan includes meetings from the last 30 days."]);
    expect(free.home.heads(SOURCE).map((head) => (head.content as { meeting: JsonObject }).meeting.title)).toEqual(["Synthetic recent meeting"]);
    artifact(home.dir, "first-listing.json", { calls: fake.toolCalls, facts: route.record.deliveries.map((delivery) => delivery.facts) });
  });

  it("an edit in the window goes unread, a list with no updated_at reads nothing or reads twice, or a list none of whose meetings reads passes in silence", async () => {
    const route = mcpRoute();
    const { fake, home } = route;
    fake.plan = "business";
    const notes = [fake.note({ title: "Synthetic meeting A" })];
    fake.tick(DAY);
    notes.push(fake.note({ title: "Synthetic meeting B" }));
    fake.tick(DAY);
    await call(route);
    const meeting = (head: { content: unknown }) => (head.content as { meeting: { title: string } }).meeting.title;
    expect(home.heads(SOURCE).map(meeting).sort()).toEqual(["Synthetic meeting A", "Synthetic meeting B"]);
    for (const listed of fake.toolCalls.filter((each) => each.name === "list_meetings")) expect(listed.arguments.updated_after).toBe("1970-01-01T00:00:00Z");

    fake.tick(5 * MINUTE);
    fake.edit(notes[0]!, { title: "Synthetic meeting A, its summary rewritten" });
    let before = fake.toolCalls.length;
    await call(route);
    const readNow = () => fake.toolCalls.slice(before).filter((each) => each.name === "get_meetings").flatMap((each) => each.arguments.meeting_ids as string[]);
    expect(readNow()).toEqual([notes[0]!.uuid]);
    expect(home.heads(SOURCE).map(meeting).sort()).toEqual(["Synthetic meeting A, its summary rewritten", "Synthetic meeting B"]);


    fake.listShape = "bare";
    fake.tick(5 * MINUTE);
    const late = fake.note({ title: "Synthetic meeting C" });
    before = fake.toolCalls.length;
    await call(route);
    expect(readNow().sort()).toEqual([...notes, late].map((note) => note.uuid!).sort());
    expect(route.record.deliveries.at(-1)!.facts.meetings).toBe(3);
    expect(home.heads(SOURCE).map(meeting)).toContain("Synthetic meeting C");
    expect(held(route.record, SEEN)).toEqual({});
    fake.tick(5 * MINUTE);
    fake.edit(late, { title: "Synthetic meeting C, its summary rewritten" });
    await call(route);
    expect(home.heads(SOURCE).map(meeting)).toContain("Synthetic meeting C, its summary rewritten");

    fake.listShape = "granola";
    fake.mcpPage = 2;
    fake.unreadable.add(notes[0]!.uuid!);
    fake.tick(5 * MINUTE);
    fake.edit(notes[1]!, { title: "Synthetic meeting B, read beside a bad element" });
    await call(route);
    expect(route.record.deliveries.at(-1)!.facts.unread).toBe(1);
    expect(home.heads(SOURCE).map(meeting)).toContain("Synthetic meeting B, read beside a bad element");

    for (const note of [...notes, late]) fake.unreadable.add(note.uuid!);
    fake.tick(5 * MINUTE);
    const deliveries = route.record.deliveries.length;
    await expect(call(route)).rejects.toThrow("granola-mcp: list_meetings answered 3 meetings and none reads: its shape has moved");
    expect(route.record.deliveries.length).toBe(deliveries);

    artifact(home.dir, "list-shapes.json", { calls: fake.toolCalls, facts: route.record.deliveries.map((delivery) => delivery.facts) });
  });

  it("a meeting whose get_meetings batch fails is dropped: one older than the 30-day window, failed during the first walk, is never read", async () => {
    const route = mcpRoute();
    const { fake, home } = route;
    fake.plan = "business";
    const old = fake.note({ title: "Synthetic old meeting" });
    fake.tick(40 * DAY);
    const recent = fake.note({ title: "Synthetic recent meeting" });
    fake.tick(DAY);
    fake.failing.add(old.uuid!);
    await call(route);
    expect(route.record.deliveries).toHaveLength(0);
    expect((route.calls.at(-1)!.skipped as string[]).sort()).toEqual([recent.uuid, old.uuid].sort());
    expect(Object.keys(held(route.record, QUEUED)).sort()).toEqual([old.uuid, recent.uuid].sort());
    expect(home.heads(SOURCE)).toEqual([]);
    fake.tick(5 * MINUTE);
    await call(route);
    const listed = fake.toolCalls.filter((each) => each.name === "list_meetings").at(-1)!.arguments;
    expect(Date.parse(String(listed.from_date))).toBeGreaterThan(Date.parse(old.created_at));
    expect(home.heads(SOURCE).map((head) => (head.content as { meeting: { title: string } }).meeting.title).sort()).toEqual(["Synthetic old meeting", "Synthetic recent meeting"]);
    expect(held(route.record, QUEUE)).toEqual({});
    expect(held(route.record, QUEUED)).toEqual({});
    artifact(home.dir, "failed-batch.json", { calls: fake.toolCalls, facts: route.calls });
  });

  it("the queue is read in another order than it was listed in, or a batch that failed is not read first at the next call", async () => {
    const route = mcpRoute({ per_poll: 3 });
    const { fake } = route;
    fake.plan = "business";
    const notes = Array.from({ length: 21 }, (_, n) => {
      fake.tick(HOUR);
      return fake.note({ title: `Synthetic meeting ${n}` });
    });
    fake.tick(HOUR);
    const listed = notes.map((note) => note.uuid!).reverse();
    expect(listed).not.toEqual([...listed].sort());
    fake.failing.add(listed[3]!);
    const batches = (from: number) => fake.toolCalls.slice(from).filter((each) => each.name === "get_meetings").map((each) => each.arguments.meeting_ids as string[]);
    await call(route);
    expect(batches(0)).toEqual([listed.slice(0, 10), listed.slice(10, 20)]);
    expect(Object.values(held(route.record, QUEUE))).toEqual([...listed.slice(0, 10), listed[20]].map((id) => expect.objectContaining({ id })));
    expect(held(route.record, QUEUED)).toEqual(Object.fromEntries([...listed.slice(0, 10).map((id, at) => [id, placeOf(at)]), [listed[20], placeOf(20)]]));
    const before = fake.toolCalls.length;
    fake.tick(5 * MINUTE);
    await call(route);
    expect(batches(before)).toEqual([listed.slice(0, 10), [listed[20]]]);
    expect(held(route.record, QUEUE)).toEqual({});
    expect((route.record.state as GranolaMcpState).queue_next).toBeUndefined();
  });
});

describe("granola-mcp's cursor and memory", () => {
  it("grows the cursor with the first listing's meetings, reads one again after it, or writes memory on a call that found nothing new (N and 4N)", async () => {
    const history = async (count: number) => {
      const route = mcpRoute({ per_poll: 10_000 });
      const { fake } = route;
      fake.plan = "business";
      for (let n = 0; n < count; n++) {
        fake.note({ title: `Synthetic meeting ${n}` });
        fake.tick(MINUTE);
      }
      await call(route);
      expect([route.record.next?.more, route.record.deliveries.at(-1)!.facts.meetings]).toEqual([undefined, count]);
      const cursor = Buffer.byteLength(canonical(route.record.state!));
      expect([Object.keys(held(route.record, SEEN)).length, (route.record.state as unknown as GranolaMcpState).reached]).toEqual([count, true]);
      fake.tick(5 * MINUTE);
      const before = fake.toolCalls.length;
      await call(route);
      expect(fake.toolCalls.slice(before).filter((each) => each.name === "get_meetings")).toEqual([]);
      expect(route.record.changes).toEqual({ cleared: [], entries: [] });
      return { count, cursor };
    };
    const n = await history(1_000);
    const n4 = await history(4_000);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(openTestHome().dir, "bounded.json", { n, n4 });
  });
});
