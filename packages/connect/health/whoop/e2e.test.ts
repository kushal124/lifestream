import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, canonical, civilDay, parse, type JsonObject, type Landed, type MemoryChanges } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, fetchedBytes, goldenSets, memorySecrets, openTestHome, parityOf, temp, type TestHome } from "../../test/drive.js";
import { byBytes, callMemory, cursorText } from "../../shared/memory.js";
import { FakeRelay } from "../../test/station.js";
import { Refused } from "../../shared/refused.js";
import type { Accounts } from "../../shared/setup.js";
import { stationsOver } from "../../shared/station.js";
import { HOME_FACTS, NeedsYou, NotYet, type Fetched, type Lent, type Secrets } from "../../seams.js";
import { browserAcquirer, type BrowserSettings } from "../../shared/browser.js";
import { whoIs } from "../../shared/setup.js";
import { FIRST_DAY, whoopAcquirer, type WhoopSettings } from "./acquirer.js";
import { whoop } from "./connector.js";
import { recipes } from "./recipe.js";
import { whoopConnector } from "./reader.js";
import { appCapture, APP_SLEEP, capture, during, longStress, FAKE_EMAIL, FAKE_FIRST_DAY, FAKE_PASSWORD, SOURCE, USER, wallMs, WHOOP_SETS, type Files } from "./test/fixtures.js";
import { fakeWhoop, type FakeWhoop } from "./test/fake.js";

const KINDS = Object.keys(whoopConnector.kinds);
const GOLDEN = goldenSets(new URL("./test/parity.golden.json", import.meta.url));
const T0 = Date.UTC(2026, 7, 2);
const HOUR = 3_600_000;
const ZONE = "Asia/Kolkata";
const LONG = {
  start: wallMs("2026-07-30", "02:48:50", ZONE),
  edge: Date.parse("2026-07-31T19:15:35.500Z"),
  labels: [wallMs("2026-07-30", "18:30:00", ZONE), wallMs("2026-07-31", "09:30:00", ZONE)],
  points: [wallMs("2026-07-30", "02:49:50", ZONE), wallMs("2026-07-30", "18:30:05", ZONE), wallMs("2026-07-31", "09:30:12.340", ZONE), Date.parse("2026-07-31T19:15:35.500Z")],
};

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function home(): TestHome {
  const made = openTestHome("connect-whoop");
  homes.push(made);
  return made;
}

async function read(at: TestHome, files: Files, stated_ms = T0) {
  return collect(whoopConnector.read(deliver(at, SOURCE, files, {}, stated_ms), at.blobs));
}

describe("whoop connector", () => {
  it("the parity golden differs", async () => {
    const at = home();
    const report: JsonObject = {};
    for (const [name, options] of Object.entries(WHOOP_SETS)) {
      const actual = parityOf(await read(at, capture(options)));
      expect(actual, name).toEqual(parityOf(GOLDEN[name]!));
      report[name] = { rows: actual.length };
    }
    artifact(at.dir, "parity.json", report);
  });

  it("a synthetic delivery lands different heads than expected", async () => {
    const report: JsonObject = {};
    for (const [name, options] of Object.entries(WHOOP_SETS)) {
      const at = home();
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, capture(options), {}, T0));
      const landedHeads = at.heads(SOURCE, KINDS);
      const wanted = parityOf(GOLDEN[name]!);
      expect(landed.new, name).toBe(wanted.length);
      expect(landed.refused + landed.duplicated + landed.changed + landed.late + landed.gone, name).toBe(0);
      expect(landedHeads.map((head) => [head.kind, head.key, head.version]), name).toEqual(wanted.map((row) => [row.kind, row.key, row.id]));
      report[name] = { landed: counts(landed), heads: landedHeads as unknown as JsonObject[] };
      artifact(at.dir, "heads.json", report[name]);
    }
  });

  it("a replay of the same delivery writes anything", async () => {
    const at = home();
    const delivery = deliver(at, SOURCE, capture(), {}, T0);
    await at.land(whoopConnector, delivery);
    const again = await at.land(whoopConnector, delivery);
    expect(again.restated).toBe(11);
    expect(again.new + again.changed + again.late + again.duplicated).toBe(0);
    artifact(at.dir, "replay.json", counts(again));
  });

  it("a smaller snapshot lands a gone", async () => {
    const at = home();
    await at.land(whoopConnector, deliver(at, SOURCE, capture(), {}, T0));
    const official = await at.land(whoopConnector, deliver(at, SOURCE, capture({ private: false }), {}, T0 + HOUR));
    const unplaced = await at.land(whoopConnector, deliver(at, SOURCE, capture({ official: false, private: "unplaced" }), {}, T0 + 2 * HOUR));
    expect([official.gone, unplaced.gone]).toEqual([0, 0]);
    expect(at.heads(SOURCE, KINDS)).toHaveLength(11);
    artifact(at.dir, "smaller.json", { official: counts(official), unplaced: counts(unplaced) });
  });

  it("a duplicated key in one delivery goes unreported", async () => {
    const at = home();
    const landed = await at.land(whoopConnector, deliver(at, SOURCE, capture({ duplicateCycle: true }), {}, T0));
    expect(landed.duplicated).toBe(1);
    expect(landed.new).toBe(11);
    artifact(at.dir, "duplicated.json", counts(landed));
  });

  it("a ticking segment style goes unnamed in the changed paths", async () => {
    const at = home();
    await at.land(whoopConnector, deliver(at, SOURCE, capture({ official: false }), {}, T0));
    const restyled = await at.land(whoopConnector, deliver(at, SOURCE, capture(WHOOP_SETS.restyled), {}, T0 + HOUR));
    expect(restyled.changed).toBe(2);
    expect(restyled.changedPaths).toEqual({ "content.segment_styles[]": 2 });
    expect(restyled.restated).toBe(4);
    artifact(at.dir, "segment-styles.json", counts(restyled));
  });

  it("moved plot positions tick a sample", async () => {
    const at = home();
    await at.land(whoopConnector, deliver(at, SOURCE, capture({ official: false }), {}, T0));
    const moved = await at.land(whoopConnector, deliver(at, SOURCE, capture(WHOOP_SETS["positions-moved"]), {}, T0 + HOUR));
    expect(moved.restated).toBe(6);
    expect(moved.changed + moved.new).toBe(0);
    artifact(at.dir, "positions.json", counts(moved));
  });

  it("a re-scored recovery lands as anything but a change of its record", async () => {
    const at = home();
    await at.land(whoopConnector, deliver(at, SOURCE, capture(), {}, T0));
    const rescored = await at.land(whoopConnector, deliver(at, SOURCE, capture(WHOOP_SETS.rescored), {}, T0 + HOUR));
    expect(rescored.changed).toBe(1);
    expect(rescored.changedPaths).toEqual({ "content.score.recovery_score": 1, "content.updated_at": 1 });
    const late = await at.land(whoopConnector, deliver(at, SOURCE, capture(), {}, T0 + HOUR / 2));
    expect(late.late).toBe(1);
    const recovery = at.heads(SOURCE, ["recovery"])[0]!;
    expect((recovery.content as { content: { score: { recovery_score: number } } }).content.score.recovery_score).toBe(55);
    artifact(at.dir, "rescore.json", { rescored: counts(rescored), late: counts(late) });
  });

  it("a capture that disagrees with its own manifest or its source lands anything", async () => {
    const at = home();
    const files = capture();
    const cases: Record<string, Files> = {
      tampered: { ...files, "official/cycles-00001.json": Buffer.from("{}\n") },
      unlisted: { ...files, "official/unlisted.json": Buffer.from("{}\n") },
      "endpoint collision": capture({ nonidenticalEndpoint: true }),
      "half-empty day": capture({ private: "half-empty" }),
    };
    const refused: Record<string, string> = {};
    for (const [name, broken] of Object.entries(cases)) {
      await expect(at.land(whoopConnector, deliver(at, SOURCE, broken, {}, T0)), name).rejects.toThrow(Refused);
      refused[name] = await (async () => {
        try {
          await at.land(whoopConnector, deliver(at, SOURCE, broken, {}, T0));
          return "";
        } catch (error) {
          return (error as Error).message;
        }
      })();
    }
    await expect(at.land(whoopConnector, deliver(at, "whoop:10000002:cloud", files, {}, T0))).rejects.toThrow(/states user 10000001; the source's user is 10000002/u);
    expect(at.heads(SOURCE, KINDS)).toEqual([]);
    artifact(at.dir, "refused.json", refused);
  });
});

type Polled = { cursor: JsonObject; memory: Record<string, Record<string, string>> };
type Called = Omit<Fetched, "state"> & { state: Polled; changes: MemoryChanges; more?: true };
type Paged = Called & { left: number | null };

const placeOf = (polled: Polled, user = USER): JsonObject => parse(polled.memory.account![user]!) as JsonObject;
const owedOf = (polled: Polled, user = USER): string[] =>
  Object.entries(polled.memory[`stress:${user}`] ?? {}).sort(([a, x], [b, y]) => Number(x) - Number(y) || byBytes(a, b)).map(([day]) => day);
const owing = (polled: Polled, days: readonly string[], asked_ms: number, user = USER): Polled =>
  ({ ...polled, memory: { ...polled.memory, [`stress:${user}`]: Object.fromEntries(days.map((day) => [day, canonical(asked_ms)])) } });
const PASSWORD_SECRET = "lifestream-whoop-password";
const DAY_MS = 86_400_000;
const kept = () => memorySecrets({ [PASSWORD_SECRET]: FAKE_PASSWORD });

function lane(fake: FakeWhoop, options: { start_ms?: number | null; accounts?: Accounts; settings?: Partial<WhoopSettings>; block?: Partial<WhoopSettings> } = {}) {
  const relay = new FakeRelay(fake);
  const answers: string[] = [];
  const wire: typeof globalThis.fetch = async (input, init) => {
    const response = await relay.fetch(input, init);
    answers.push(await response.clone().text());
    return response;
  };
  const start_ms = options.start_ms ?? null;
  const block = options.block ?? { email: FAKE_EMAIL, password: PASSWORD_SECRET, timezone: ZONE, ...options.settings };
  const acquirer = whoopAcquirer({ password: PASSWORD_SECRET, work: join(temp(), "whoop-work"), ...block }, { now: () => fake.now, sleep: async () => undefined });
  const called = async <T extends Fetched>(polled: Polled | null, secrets: Secrets, call: (state: JsonObject | null, lent: Lent) => Promise<T>) => {
    const held = polled?.memory ?? {};
    const memory = callMemory({
      get: (part, key) => held[part]?.[key],
      after: (part, after, limit) => Object.entries(held[part] ?? {}).filter(([key]) => after === null || byBytes(key, after) > 0).sort(([a], [b]) => byBytes(a, b)).slice(0, limit),
    });
    const lent: Lent = { stations: stationsOver("https://door.example", "drive-token-synthetic", { fetch: wire, secrets }), accounts: options.accounts ?? {}, start_ms, from_ms: polled === null ? undefined : start_ms, memory };
    const fetched = await call(polled?.cursor ?? null, lent);
    const cursor = parse(cursorText(fetched.state)) as JsonObject;
    const changes = memory.end();
    const after: Polled["memory"] = Object.fromEntries(Object.entries(held).map(([part, entries]) => [part, { ...entries }]));
    for (const part of changes.cleared) delete after[part];
    for (const [part, key, value] of changes.entries) {
      const entries = (after[part] ??= {});
      if (value === null) delete entries[key];
      else entries[key] = value;
      if (Object.keys(entries).length === 0) delete after[part];
    }
    return { ...fetched, state: { cursor, memory: after }, changes };
  };
  return {
    relay, answers,
    fetch: (polled: Polled | null, secrets: Secrets = kept()): Promise<Called> => called(polled, secrets, (state, lent) => acquirer.fetch(state, secrets, lent)),
    page: (polled: Polled | null, secrets: Secrets = kept()): Promise<Paged> => called(polled, secrets, (state, lent) => acquirer.page!(state, secrets, lent)),
  };
}

function signedIn(at: number, rescore?: { day: string; at: number }): FakeWhoop {
  const fake = fakeWhoop(ZONE, rescore);
  fake.now = at;
  fake.signIn();
  return fake;
}

const daysFrom = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const ending = <T>(call: Promise<T>): Promise<T | Error> => call.catch((error: unknown) => error as Error);

const filesOf = (fetched: Fetched): Files => Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));

const heartAsks = (fetched: Fetched): { file: string; start: string; end: string; readings: number; url: string }[] => {
  const { heart_rate } = JSON.parse(filesOf(fetched)["app/manifest.json"]!.toString("utf8")) as { heart_rate: { file: string; readings: number; request_url: string }[] };
  return heart_rate.map(({ file, readings, request_url }) => {
    const { searchParams } = new URL(request_url);
    return { file, start: searchParams.get("start")!, end: searchParams.get("end")!, readings, url: request_url };
  });
};

const heartDays = (at: TestHome, step: number, zone = ZONE): Record<string, number> => {
  const days: Record<string, number> = {};
  for (const head of at.heads(SOURCE, ["sample"]).filter((one) => one.key.startsWith(`hr${step}:`))) {
    const day = civilDay(head.start_ms!, { zone, day_start_hour: 0 });
    days[day] = (days[day] ?? 0) + 1;
  }
  return days;
};

describe("whoop acquirer", () => {
  it("a day's stress WHOOP fails (a 5xx after the retries) holds back the cycles, sleeps and heart rate read beside it, or leaves no word of which day", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const { fetch } = lane(fake);
    fake.answering = { "/health-service/v2/stress-bff/2026-08-03": 500 };
    const polled = await fetch(null);
    fake.answering = {};
    const manifest = JSON.parse(fetchedBytes(polled.files.find((file) => file.path === "app/manifest.json")!).toString("utf8")) as JsonObject;
    const stressed = (manifest.stress as JsonObject[]).map((entry) => entry.date);
    expect([stressed.includes("2026-08-03"), manifest.stress_failed, (manifest.cycles as JsonObject[]).length > 0, (manifest.heart_rate as JsonObject[]).length > 0])
      .toEqual([false, [{ date: "2026-08-03", status: 500 }], true, true]);
    expect([polled.facts.app_stress_days, polled.facts.app_stress_failed]).toEqual([stressed.length, 1]);
    const again = await fetch(polled.state);
    const next = JSON.parse(fetchedBytes(again.files.find((file) => file.path === "app/manifest.json")!).toString("utf8")) as JsonObject;
    expect([(next.stress as JsonObject[]).some((entry) => entry.date === "2026-08-03"), next.stress_failed]).toEqual([true, undefined]);
    artifact(home().dir, "stress-failed.json", { failed: manifest.stress_failed, stressed });
  });

  it("a day's stress WHOOP fails past its window is never asked again, asked at any read but the day's first, asked once answered, or crowds out the days owed behind it", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const { fetch, page } = lane(fake, { start_ms: fake.now - 60 * DAY_MS });
    const asks = (from: number, day: string): number => fake.requests.slice(from).filter((path) => path === `/health-service/v2/stress-bff/${day}`).length;
    fake.answering = { "/health-service/v2/stress-bff/2026-07-27": 500 };
    const first = await fetch(null);
    expect(owedOf(first.state)).toEqual(["2026-07-27"]);
    expect(first.state.cursor).toEqual({ polled_ms: fake.now });
    fake.now = wallMs("2026-08-03", "11:00:00", ZONE);
    let from = fake.requests.length;
    const later = await fetch(first.state);
    expect([asks(from, "2026-07-27"), owedOf(later.state), later.changes.entries.map(([part]) => part)]).toEqual([0, ["2026-07-27"], ["account", `sealed:${USER}`]]);
    fake.now = wallMs("2026-08-04", "10:00:00", ZONE);
    from = fake.requests.length;
    const failing = await fetch(later.state);
    expect((failing.facts.date_range as { start: string }).start).toBe("2026-07-28");
    expect([asks(from, "2026-07-27") > 0, owedOf(failing.state)]).toEqual([true, ["2026-07-27"]]);
    fake.answering = {};
    fake.now = wallMs("2026-08-05", "10:00:00", ZONE);
    const answered = await fetch(failing.state);
    const manifest = JSON.parse(fetchedBytes(answered.files.find((file) => file.path === "app/manifest.json")!).toString("utf8")) as JsonObject;
    expect([(manifest.stress as JsonObject[]).some((entry) => entry.date === "2026-07-27"), owedOf(answered.state), answered.state.memory[`stress:${USER}`]]).toEqual([true, [], undefined]);
    fake.now = wallMs("2026-08-06", "10:00:00", ZONE);
    from = fake.requests.length;
    await fetch(answered.state);
    expect(asks(from, "2026-07-27")).toBe(0);
    fake.answering = { "/health-service/v2/stress-bff/2026-07-20": 500 };
    const walked = await page(answered.state);
    fake.answering = {};
    expect(owedOf(walked.state)).toEqual(["2026-07-20"]);
    const owed = Array.from({ length: 40 }, (_, index) => addDays("2026-05-01", index));
    fake.answering = { "/health-service/v2/stress-bff/2026-05-01": 500 };
    fake.now = wallMs("2026-08-07", "10:00:00", ZONE);
    from = fake.requests.length;
    const many = await fetch(owing(walked.state, owed, fake.now - 86_400_000));
    fake.answering = {};
    expect([owed.filter((day) => asks(from, day) > 0).length, owedOf(many.state)]).toEqual([36, [...owed.slice(36), "2026-05-01"]]);
    fake.answering = { "/health-service/v2/stress-bff/2026-05-02": 500 };
    fake.now = wallMs("2026-10-20", "10:00:00", ZONE);
    from = fake.requests.length;
    const away = await fetch(owing(many.state, ["2026-05-02"], fake.now - 86_400_000));
    expect([away.more, asks(from, "2026-05-02") > 0]).toEqual([true, true]);
    from = fake.requests.length;
    const going = await fetch(away.state);
    fake.answering = {};
    expect([going.more, asks(from, "2026-05-02"), owedOf(going.state)]).toEqual([true, 0, ["2026-05-02"]]);
    artifact(home().dir, "stress-owed.json", { first: owedOf(first.state), many: owedOf(many.state) });
  });

  it("a value from the cookie reaches the home (facts, state, a message, a sealed file), or a read goes out without it", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const token = fake.token!;
    const { fetch, answers } = lane(fake);
    const polled = await fetch(null);
    const sealed = polled.files.map((file) => fetchedBytes(file).toString("latin1"));
    fake.answering = { "/core-details-bff/v0/cycles/details": 500 };
    const failing = await ending(fetch(polled.state));
    fake.answering = {};
    const said = [JSON.stringify(polled.facts), JSON.stringify(polled.state), (failing as Error).message, ...sealed, ...answers];
    expect(said.filter((each) => each.includes(token))).toEqual([]);
    expect([polled.facts.account, polled.facts.sources]).toEqual([USER, [{ id: SOURCE, connector: "whoop-capture", email: FAKE_EMAIL }]]);
    expect((failing as Error).message).toBe("/core-details-bff/v0/cycles/details answered HTTP 500");
    expect(fake.requests.length).toBeGreaterThan(4);
    const at = home();
    artifact(at.dir, "cookie.json", { facts: polled.facts, state: polled.state, files: polled.files.length, answers: answers.length });
  });

  it("a poll with no cookie, or a 401 mid-walk, is the person's need, seals a day or moves the cursor; a 403 reads as a lapsed session", async () => {
    const fake = signedIn(wallMs("2026-09-20", "10:00:00", ZONE));
    const { fetch, page } = lane(fake, { start_ms: fake.now - 60 * DAY_MS });
    const first = await fetch(null);
    const token = fake.token;
    fake.token = undefined;
    fake.stays = true;
    const asked = fake.requests.length;
    const none = await ending(fetch(first.state));
    expect([none instanceof NotYet && none.reason, (none as NotYet).state, fake.requests.slice(asked)]).toEqual(["retrying", undefined, ["/users-service/v2/bootstrap/"]]);
    fake.token = token;
    fake.stays = false;
    fake.answering = { "/health-service/v2/stress-bff/2026-09-10": 401 };
    const lapsed = await ending(page(first.state));
    expect([lapsed instanceof NotYet && lapsed.reason, (lapsed as NotYet).state, (lapsed as NotYet).facts?.sources]).toEqual(["retrying", undefined, [{ id: SOURCE, connector: "whoop-capture", email: FAKE_EMAIL }]]);
    fake.answering = { "/health-service/v2/stress-bff/2026-09-10": 401, "/health-service/v2/stress-bff/2026-09-11": 429, "/health-service/v2/stress-bff/2026-09-12": 503 };
    const stressed = fake.requests.length;
    const mixed = await ending(page(first.state));
    expect([mixed instanceof NotYet && mixed.reason, (mixed as NotYet).state, (mixed as Error).message.startsWith("not yet: /health-service/v2/stress-bff/2026-09-10 answered 401")]).toEqual(["retrying", undefined, true]);
    expect(fake.requests.slice(stressed).filter((path) => path === "/health-service/v2/stress-bff/2026-09-11")).toHaveLength(1);
    fake.answering = { "/core-details-bff/v0/cycles/details": 403 };
    const forbidden = await ending(page(first.state));
    expect([forbidden instanceof NotYet, forbidden instanceof Refused, (forbidden as Error).message]).toEqual([false, true, "/core-details-bff/v0/cycles/details answered HTTP 403"]);
    fake.answering = {};
    const paged = await page(first.state);
    expect(paged.facts.date_range).toEqual({ start: "2026-08-08", end: "2026-09-12", timezone: ZONE });
    const at = home();
    artifact(at.dir, "signed-out.json", { none: (none as Error).message, lapsed: (lapsed as Error).message, mixed: (mixed as Error).message, forbidden: (forbidden as Error).message });
  });

  it("a cycles answer names another user, in a cycle or a recovery inside it, and the call seals", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    fake.cycles_user = "10000002";
    const refused = await ending(lane(fake).fetch(null));
    expect([refused instanceof Refused, (refused as Error).message]).toEqual([true, expect.stringMatching(/^the cycles answer to \?.+\.records\[0\]\.cycle\.user_id states user_id 10000002, expected 10000001$/u)]);
    expect(fake.requests).toEqual(["/users-service/v2/bootstrap/", "/core-details-bff/v0/cycles/details"]);
    const nested = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    nested.recovery_user = "10000002";
    const inside = await ending(lane(nested).fetch(null));
    expect([inside instanceof Refused, (inside as Error).message]).toEqual([true, expect.stringMatching(/\.recovery\.user_id states user_id 10000002, expected 10000001$/u)]);
    expect(nested.requests).toEqual(["/users-service/v2/bootstrap/", "/core-details-bff/v0/cycles/details"]);
    const at = home();
    artifact(at.dir, "other-user.json", { refused: (refused as Error).message, inside: (inside as Error).message });
  });

  it("a long absence makes one call outlast its bound, or the days between are skipped", async () => {
    const fake = signedIn(wallMs("2026-07-25", "10:00:00", ZONE));
    const { fetch } = lane(fake, { settings: { heart_rate_step: "10m" } });
    const first = await fetch(null);
    fake.now = wallMs("2026-10-13", "10:00:00", ZONE);
    const calls: { range: { start: string; end: string }; more: boolean }[] = [];
    let state = first.state;
    for (let call = 0; call < 5; call++) {
      const fetched = await fetch(state);
      state = fetched.state;
      calls.push({ range: fetched.facts.date_range as { start: string; end: string }, more: fetched.more === true });
      if (fetched.more !== true) break;
    }
    expect(calls).toEqual([
      { range: { start: "2026-07-25", end: "2026-08-29", timezone: ZONE }, more: true },
      { range: { start: "2026-08-29", end: "2026-10-03", timezone: ZONE }, more: true },
      { range: { start: "2026-10-03", end: "2026-10-13", timezone: ZONE }, more: false },
    ]);
    expect(calls.slice(1).every((each, index) => each.range.start <= addDays(calls[index]!.range.end, 1))).toBe(true);
    expect(placeOf(state).until_ms).toBe(fake.now);
    const at = home();
    artifact(at.dir, "absence.json", { calls });
  });

  it("the window cursor goes backward", async () => {
    const fake = signedIn(wallMs("2026-08-05", "10:00:00", ZONE));
    const { fetch } = lane(fake);
    const first = await fetch(null);
    expect(placeOf(first.state).reached_day).toBe("2026-07-29");
    fake.now = wallMs("2026-08-04", "10:00:00", ZONE);
    const back = await fetch(first.state);
    expect(placeOf(back.state).until_ms).toBe(placeOf(first.state).until_ms);
    expect(back.facts.date_range).toEqual({ start: "2026-08-04", end: "2026-08-04", timezone: ZONE });
    fake.now = wallMs("2026-08-20", "10:00:00", ZONE);
    const resumed = await fetch(back.state);
    expect(resumed.facts.date_range).toEqual({ start: "2026-08-05", end: "2026-08-20", timezone: ZONE });
    expect(placeOf(resumed.state).until_ms).toBe(fake.now);
    const at = home();
    artifact(at.dir, "cursor.json", { first: first.state, back: back.state, resumed: resumed.state, ranges: [first.facts.date_range, back.facts.date_range, resumed.facts.date_range] });
  });

  it("a bare block does not run, or a fresh lane's fetch reads anything but today's window", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const unnamed = lane(fake, { block: { zone: ZONE, password: PASSWORD_SECRET } });
    const refused = await ending(unnamed.fetch(null));
    expect([refused instanceof Refused, (refused as Error).message, unnamed.relay.errands.length]).toEqual([true, "the block names no email, which WHOOP's sign-in asks for", 0]);
    const bare = lane(fake, { start_ms: null, block: { zone: ZONE, email: FAKE_EMAIL, password: PASSWORD_SECRET } });
    const first = await bare.fetch(null);
    expect(first.facts.date_range).toEqual({ start: "2026-07-27", end: "2026-08-03", timezone: ZONE });
    expect(first.more).toBeUndefined();
    expect(HOME_FACTS.filter((fact) => Object.hasOwn(first.facts, fact))).toEqual([]);
    expect(placeOf(first.state).reached_day).toBe("2026-07-27");
    const at = home();
    artifact(at.dir, "bare-lane.json", { range: first.facts.date_range, state: first.state });
  });

  it("a fresh lane's fetch, or one whose last read reached behind the start, reads a day before the stream's start", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const { fetch } = lane(fake, { start_ms: Date.parse("2026-07-31T00:00:00Z") });
    const first = await fetch(null);
    expect([first.facts.date_range, placeOf(first.state).reached_day]).toEqual([{ start: "2026-07-31", end: "2026-08-03", timezone: ZONE }, "2026-07-31"]);
    fake.now = wallMs("2026-10-13", "10:00:00", ZONE);
    const later = lane(fake, { start_ms: Date.parse("2026-10-10T00:00:00Z") });
    const absent = await later.fetch(first.state);
    expect(absent.facts.date_range).toEqual({ start: "2026-10-10", end: "2026-10-13", timezone: ZONE });
  });

  it("the history walk ends at a break in wearing the band, never reaches its first day, asks heart rate or stress of a step with no cycle, loses a reading the account holds, miscounts its days left, reads a day twice, or a replay of its pages writes anything", async () => {
    const today = "2027-01-20";
    const fake = signedIn(wallMs(today, "10:00:00", ZONE));
    fake.absent = { "2026-08-20": 100 };
    const read = new Map<string, number>();
    const at = home();
    const { fetch, page, relay } = lane(fake, { start_ms: null, settings: { heart_rate_step: "10m" } });
    type Seen = { call: string; range: { start: string; end: string }; reached: unknown; left: number | null | undefined; cycles: number; heart: number; stress: number; landed: ReturnType<typeof counts> | null };
    const seen: Seen[] = [];
    const take = async (call: "fetch" | "page", fetched: Called & { left?: number | null }) => {
      const files = Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)]));
      for (const path of Object.keys(files)) {
        const day = /^app\/stress-(.+)\.json$/u.exec(path)?.[1];
        if (day !== undefined) read.set(day, (read.get(day) ?? 0) + 1);
      }
      expect(HOME_FACTS.filter((fact) => Object.hasOwn(fetched.facts, fact)), "an acquirer's facts state what only the home may").toEqual([]);
      const manifest = JSON.parse(files["app/manifest.json"]!.toString("utf8")) as { cycles: { records: number }[]; heart_rate: unknown[]; stress: unknown[] };
      let landed: Landed | undefined;
      if (manifest.cycles.some((entry) => entry.records > 0)) {
        const delivery = deliver(at, SOURCE, files, fetched.facts, Date.parse(fetched.facts.snapshot_taken_at as string) + seen.length * 1000);
        landed = await at.land(whoopConnector, delivery);
        const replay = await at.land(whoopConnector, delivery);
        expect(replay.new + replay.changed + replay.late + replay.duplicated + replay.gone, `${call} ${seen.length} replay`).toBe(0);
      }
      seen.push({
        call, range: fetched.facts.date_range as Seen["range"], reached: placeOf(fetched.state).reached_day, left: "left" in fetched ? fetched.left : undefined,
        cycles: manifest.cycles.reduce((all, entry) => all + entry.records, 0), heart: manifest.heart_rate.length, stress: manifest.stress.length, landed: landed === undefined ? null : counts(landed),
      });
      return fetched.state;
    };
    let state = await take("fetch", await fetch(null));
    for (let turn = 0; turn < 200 && seen.at(-1)!.left !== 0; turn++) state = await take("page", await page(state));
    const pages = seen.slice(1);
    expect(placeOf(state).reached_day).toBe(FIRST_DAY);
    expect(pages.every((each, index) => each.range.end < seen[index]!.range.start)).toBe(true);
    expect(pages.map((each) => each.left)).toEqual(pages.map((each) => daysFrom(FIRST_DAY, each.range.start) - 1));
    const firstEmpty = pages.findIndex((each) => each.cycles === 0);
    expect(pages.slice(firstEmpty).some((each) => each.cycles > 0)).toBe(true);
    const cycles = at.heads(SOURCE, ["cycle"]).map((head) => head.key);
    expect([cycles[0], cycles.includes("20260819"), cycles.includes("20261128"), cycles.some((key) => key >= "20260820" && key < "20261128")]).toEqual(["20260722", true, true, false]);
    expect(pages.filter((each) => each.cycles === 0).every((each) => each.heart === 0 && each.stress === 0)).toBe(true);
    expect(pages.filter((each) => each.cycles > 0).every((each) => each.heart === daysFrom(each.range.start, each.range.end) && each.stress === each.heart)).toBe(true);
    const holds = fake.readings(600_000);
    const samples = at.heads(SOURCE, ["sample"]);
    const landedAt = (prefix: string) => samples.filter((head) => head.key.startsWith(prefix)).map((head) => head.start_ms!).sort((a, b) => a - b);
    expect([holds.heart.length > 0, holds.stress.length > 0]).toEqual([true, true]);
    expect(landedAt("hr600:")).toEqual(holds.heart);
    expect(landedAt("stress:")).toEqual(holds.stress);
    expect([...read].filter(([day, times]) => day !== today && times > 1)).toEqual([]);
    const after = await fetch(state);
    expect(after.facts.date_range).toEqual({ start: today, end: today, timezone: ZONE });
    const asked = fake.requests.length;
    const done = await page(after.state);
    expect(done.left).toBe(0);
    expect(fake.requests.slice(asked)).toEqual(["/users-service/v2/bootstrap/"]);
    expect(relay.errands.map((errand) => errand.name)).toEqual(seen.map(() => "whoop").concat("whoop", "whoop"));
    artifact(at.dir, "walk-back.json", { calls: seen.filter((each) => each.call === "fetch" || each.cycles > 0 || each.left === 0), pages: pages.length, after: after.facts.date_range });
  });

  it("WHOOP's rate limit refuses the call as a broken answer, seals an empty delivery, or holds one call alone", async () => {
    const fake = signedIn(wallMs("2026-09-20", "10:00:00", ZONE));
    const { fetch, page } = lane(fake, { start_ms: fake.now - 60 * DAY_MS });
    const first = await fetch(null);
    fake.answering = { "/core-details-bff/v0/cycles/details": 429 };
    const asked = fake.requests.length;
    const paged = await ending(page(first.state));
    expect(paged).toBeInstanceOf(NotYet);
    expect([(paged as NotYet).reason, (paged as NotYet).backoff_ms, (paged as NotYet).next_ms, (paged as NotYet).state]).toEqual(["provider-limit", fake.now + 3_600_000, undefined, undefined]);
    expect(fake.requests.slice(asked).filter((path) => path === "/core-details-bff/v0/cycles/details")).toHaveLength(12);
    const fetched = await ending(fetch(first.state));
    expect((fetched as NotYet).backoff_ms).toBe(fake.now + 3_600_000);
    fake.answering = {};
    expect((await page(first.state)).left).toBe(17);
    const at = home();
    artifact(at.dir, "limited.json", { page: (paged as NotYet).message, fetch: (fetched as NotYet).message });
  });

  it("a page past the start reads a day before it, counts its days wrong, or a start moved earlier after done leaves the page silent", async () => {
    const fake = signedIn(wallMs("2026-09-20", "10:00:00", ZONE));
    const { fetch, page } = lane(fake, { start_ms: fake.now - 60 * DAY_MS });
    let state = (await fetch(null)).state;
    const pages: { range: unknown; left: number | null }[] = [];
    for (let turn = 0; turn < 4 && pages.at(-1)?.left !== 0; turn++) {
      const paged = await page(state);
      state = paged.state;
      pages.push({ range: paged.facts.date_range, left: paged.left });
    }
    expect(placeOf(state).reached_day).toBe("2026-07-22");
    expect(pages).toEqual([
      { range: { start: "2026-08-08", end: "2026-09-12", timezone: ZONE }, left: 17 },
      { range: { start: "2026-07-22", end: "2026-08-07", timezone: ZONE }, left: 0 },
    ]);
    const again = await lane(fake, { start_ms: null }).page(state);
    expect(again.facts.date_range).toEqual({ start: "2026-06-16", end: "2026-07-21", timezone: ZONE });
    expect([again.left, placeOf(again.state).reached_day]).toEqual([daysFrom(FIRST_DAY, "2026-06-16") - 1, "2026-06-16"]);
    const at = home();
    artifact(at.dir, "floor.json", { pages, again: { range: again.facts.date_range, left: again.left } });
  });

  it("a stored version of a cycle lacks a child WHOOP holds for it, a cycle cut at either edge of a read's window", async () => {
    const at = home();
    const fake = signedIn(wallMs("2026-08-28", "00:00:00", ZONE));
    fake.late = ["2026-08-29"];
    fake.long = { "2026-08-18": 3, "2026-08-26": 3 };
    const { fetch, page } = lane(fake, { start_ms: fake.now - 60 * DAY_MS, settings: { heart_rate_step: "10m" } });
    type Cycle = { cycle: { during: string }; sleeps: { activity_id: string }[]; recovery: unknown; workouts: { activity_id: string }[]; v2_activities: { id: string }[] };
    const lacks = (stated: Cycle, held: Cycle): string[] => [
      ...held.sleeps.filter((one) => !stated.sleeps.some((each) => each.activity_id === one.activity_id)).map((one) => `sleep ${one.activity_id}`),
      ...(held.recovery !== null && stated.recovery === null ? ["recovery"] : []),
      ...held.workouts.filter((one) => !stated.workouts.some((each) => each.activity_id === one.activity_id)).map((one) => `workout ${one.activity_id}`),
      ...held.v2_activities.filter((one) => !stated.v2_activities.some((each) => each.id === one.id)).map((one) => `activity ${one.id}`),
    ];
    const tally = { fetches: 0, pages: 0, versions: 0 };
    const lacking: string[] = [];
    const take = async (fetched: Called): Promise<Polled> => {
      const delivery = deliver(at, SOURCE, Object.fromEntries(fetched.files.map((file) => [file.path, fetchedBytes(file)])), fetched.facts, fake.now);
      const rows = await collect(whoopConnector.read(delivery, at.blobs));
      for (const row of rows.filter((one) => one.kind === "cycle")) {
        tally.versions++;
        lacking.push(...lacks((row.content as { content: Cycle }).content, fake.whole(row.key) as unknown as Cycle).map((what) => `${row.key} stated at ${new Date(fake.now).toISOString()} lacks ${what}`));
      }
      await at.land(whoopConnector, delivery, rows);
      return fetched.state;
    };
    const head = (key: string) => (at.heads(SOURCE, ["cycle"]).find((one) => one.key === key)?.content as { content: Cycle } | undefined)?.content;
    const closing: Record<number, string> = { 25: "20260826", 49: "20260829" };
    const closed: Record<string, { head: unknown; open: boolean }> = {};
    const whole: Record<string, { head: unknown; open: boolean }> = {};
    let state: Polled | null = null;
    for (let hour = 0; hour < 3 * 24; hour++) {
      fake.now = wallMs("2026-08-28", "00:00:00", ZONE) + hour * HOUR;
      state = await take(await fetch(state));
      tally.fetches++;
      const key = closing[hour];
      if (key === undefined) continue;
      closed[key] = { head: head(key), open: head(key)?.cycle.during.endsWith(",)") ?? true };
      whole[key] = { head: fake.whole(key), open: false };
    }
    expect(Object.keys(closed)).toEqual(["20260826", "20260829"]);
    expect(closed).toEqual(whole);
    for (let turn = 0; turn < 4; turn++) {
      fake.now += 60_000;
      const paged = await page(state);
      state = await take(paged);
      tally.pages++;
      if (paged.left === 0) break;
    }
    for (const one of at.heads(SOURCE, ["cycle"]).filter((each) => !each.gone)) {
      lacking.push(...lacks((one.content as { content: Cycle }).content, fake.whole(one.key) as unknown as Cycle).map((what) => `head ${one.key} lacks ${what}`));
    }
    expect(lacking).toEqual([]);
    expect({ ...tally, versions: tally.versions > 0, cutAtStart: fake.cuts.start > 0, cutAtEnd: fake.cuts.end > 0, spans: fake.cuts.spans > 0 })
      .toEqual({ fetches: 72, pages: 2, versions: true, cutAtStart: true, cutAtEnd: true, spans: true });
    const heads = at.heads(SOURCE, ["cycle"]).map((one) => one.key);
    expect([heads[0], heads.at(-1), heads.length]).toEqual([FAKE_FIRST_DAY.replaceAll("-", ""), "20260830", daysFrom(FAKE_FIRST_DAY, "2026-08-30") - 4]);
    expect(heads).toEqual(expect.arrayContaining(["20260818", "20260826"]));
    artifact(at.dir, "cut-cycles.json", { ...tally, cuts: fake.cuts, heads: heads.length });
  });

  it("a re-ask of a cycle over its own span is trusted when it answers no such cycle or another span", async () => {
    const own = new Date(wallMs("2026-07-26", "00:30:00", ZONE)).toISOString().replace(".000Z", "Z");
    const refused: Record<string, string> = {};
    const answers: Record<string, (records: { cycle: { id: number; during: string } }[]) => unknown[]> = {
      "no such cycle": (records) => records.filter((record) => record.cycle.id !== 20260726),
      "another span": (records) => records.map((record) => (record.cycle.id === 20260726 ? { ...record, cycle: { ...record.cycle, during: during(wallMs("2026-07-26", "00:30:00", ZONE), wallMs("2026-07-27", "01:30:00", ZONE)) } } : record)),
    };
    for (const [name, alter] of Object.entries(answers)) {
      const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
      const answer = fake.answer;
      fake.answer = (request) => {
        const answered = answer(request);
        if (request.url.searchParams.get("startTime") !== own) return answered;
        return { ...answered, body: { records: alter((answered.body as { records: { cycle: { id: number; during: string } }[] }).records) } };
      };
      const ended = await ending(lane(fake).fetch(null));
      expect([ended instanceof Refused, fake.cuts.spans], name).toEqual([true, 1]);
      refused[name] = (ended as Error).message;
    }
    expect(refused).toEqual({
      "no such cycle": "the ask of cycle 20260726 over its own span answered no such cycle",
      "another span": "the ask of cycle 20260726 over its own span answered it over another span",
    });
    const at = home();
    artifact(at.dir, "re-ask.json", refused);
  });

  it("the walk ends at a step whose only cycle began before it, or leaves that cycle unstated", async () => {
    const fake = signedIn(wallMs("2026-11-12", "10:00:00", ZONE));
    fake.long = { [FAKE_FIRST_DAY]: 75 };
    const at = home();
    const { fetch, page } = lane(fake, { start_ms: null, settings: { heart_rate_step: "10m" } });
    let state = (await fetch(null)).state;
    const steps: unknown[] = [];
    let stated: JsonObject | undefined;
    for (let turn = 0; turn < 8 && (placeOf(state).reached_day as string) >= FAKE_FIRST_DAY; turn++) {
      const paged = await page(state);
      state = paged.state;
      steps.push(paged.facts.date_range);
      const delivery = deliver(at, SOURCE, Object.fromEntries(paged.files.map((file) => [file.path, fetchedBytes(file)])), paged.facts, fake.now);
      const row = (await collect(whoopConnector.read(delivery, at.blobs))).find((one) => one.kind === "cycle" && one.key === "20260722");
      if (row !== undefined) stated = (row.content as { content: JsonObject }).content;
    }
    expect((placeOf(state).reached_day as string) < FAKE_FIRST_DAY).toBe(true);
    expect(stated).toEqual(fake.whole("20260722"));
    artifact(at.dir, "walk-long-cycle.json", { steps: steps as JsonObject[] });
  });

  it("the overlap days land late or changed where they should be restated", async () => {
    const rescore = { day: "2026-08-02", at: wallMs("2026-08-03", "12:00:00", ZONE) };
    const fake = signedIn(0, rescore);
    const { fetch } = lane(fake);
    const at = home();
    let state: Polled | null = null;
    const polls: { range: unknown; landed: Landed }[] = [];
    for (const [day, clock] of [["2026-08-03", "10:00:00"], ["2026-08-03", "14:00:00"], ["2026-08-04", "09:00:00"]] as const) {
      fake.now = wallMs(day, clock, ZONE);
      const poll = await fetch(state);
      state = poll.state;
      const files = Object.fromEntries(poll.files.map((file) => [file.path, fetchedBytes(file)]));
      const stated = Date.parse(poll.facts.snapshot_taken_at as string);
      polls.push({ range: poll.facts.date_range, landed: await at.land(whoopConnector, deliver(at, SOURCE, files, poll.facts, stated)) });
    }
    expect(polls.map((poll) => poll.range)).toEqual([
      { start: "2026-07-27", end: "2026-08-03", timezone: ZONE },
      { start: "2026-08-03", end: "2026-08-03", timezone: ZONE },
      { start: "2026-07-28", end: "2026-08-04", timezone: ZONE },
    ]);
    for (const { landed } of polls) expect(landed.late + landed.refused + landed.duplicated + landed.gone).toBe(0);
    expect(polls[1]!.landed.restated).toBeGreaterThan(0);
    const rescoredPaths = polls.slice(1).reduce((total, poll) => total + (poll.landed.changedPaths["content.recovery.recovery_score"] ?? 0), 0);
    expect(rescoredPaths).toBe(1);
    expect(polls[2]!.landed.restated).toBeGreaterThan(100);
    artifact(at.dir, "overlap.json", polls.map((poll) => ({ range: poll.range, landed: counts(poll.landed) })));
  });

  it("a day a later read reaches from another window lands a second set of heart rate, WHOOP's instants following the ask's start", async () => {
    const at = home();
    const fake = signedIn(0);
    fake.grid = (start) => ((start / 1000) % 59) * 1000;
    const { fetch } = lane(fake);
    const midnight = new Date(wallMs("2026-08-03", "00:00:00", ZONE)).toISOString();
    const reads: JsonObject[] = [];
    const asked: (string | undefined)[] = [];
    let state: Polled | null = null;
    for (const [day, clock] of [["2026-08-03", "05:00:00"], ["2026-08-03", "23:59:30"], ["2026-08-04", "05:00:00"]] as const) {
      fake.now = wallMs(day, clock, ZONE);
      const read = await fetch(state);
      state = read.state;
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, filesOf(read), read.facts, fake.now));
      expect(landed.refused, `${day} ${clock}`).toBe(0);
      asked.push(heartAsks(read).find((ask) => ask.start === midnight)?.url);
      reads.push({ range: read.facts.date_range as JsonObject, asks: heartAsks(read).map(({ start, end, readings }) => ({ start, end, readings })), landed: counts(landed), days: heartDays(at, 60) });
    }
    expect(reads.map((read) => (read.range as { start: string }).start)).toEqual(["2026-07-27", "2026-08-03", "2026-07-28"]);
    expect(heartDays(at, 60)).toEqual({
      "2026-07-27": 1440, "2026-07-28": 1440, "2026-07-29": 1440, "2026-07-30": 1440, "2026-07-31": 1440, "2026-08-01": 1440, "2026-08-02": 1440, "2026-08-03": 1440, "2026-08-04": 300,
    });
    expect([asked[0], new Set(asked).size]).toEqual([expect.stringContaining("metrics-service"), 1]);
    artifact(at.dir, "heart-rate-days.json", { reads, days: heartDays(at, 60) });
  });

  it("a zone's change cuts a day at a wrong hour, a midnight that is not there or comes twice leaves a gap between two asks, the open day is asked short, or a reading on a midnight lands twice or refuses its day", async () => {
    const report: JsonObject = {};
    const cases = [
      { zone: "America/New_York", today: "2026-11-03", day: "2026-11-01", start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:59:59.999Z", readings: 150 },
      { zone: "America/New_York", today: "2026-03-10", day: "2026-03-08", start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T03:59:59.999Z", readings: 138 },
      { zone: "America/Havana", today: "2026-03-10", day: "2026-03-08", start: "2026-03-08T05:00:00.000Z", end: "2026-03-09T03:59:59.999Z", readings: 138 },
      { zone: "America/Havana", today: "2026-11-03", day: "2026-11-01", start: "2026-11-01T04:00:00.000Z", end: "2026-11-02T04:59:59.999Z", readings: 150 },
    ];
    for (const { zone, today, day, start, end, readings } of cases) {
      const name = `${zone} ${day}`;
      const at = home();
      const fake = fakeWhoop(zone);
      fake.first = "2025-10-01";
      fake.now = wallMs(today, "10:00:00", zone);
      fake.signIn();
      const read = await lane(fake, { settings: { timezone: zone, heart_rate_step: "10m" } }).fetch(null);
      const asks = heartAsks(read);
      expect(asks.length, name).toBe(8);
      expect(asks.find((ask) => ask.start === start)?.end, name).toBe(end);
      expect(asks.slice(1).filter((ask, index) => Date.parse(ask.start) !== Date.parse(asks[index]!.end) + 1), name).toEqual([]);
      expect(civilDay(Date.parse(asks.at(-1)!.end), { zone, day_start_hour: 0 }), name).toBe(today);
      expect(civilDay(Date.parse(asks.at(-1)!.end) + 1, { zone, day_start_hour: 0 }), name).toBe(addDays(today, 1));
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, filesOf(read), read.facts, fake.now));
      expect(landed.refusals.filter((refusal) => refusal.key.includes("heart-rate")), name).toEqual([]);
      const days = heartDays(at, 600, zone);
      expect(days[day], name).toBe(readings);
      expect(Object.values(days).reduce((all, each) => all + each, 0), name).toBe(asks.reduce((all, ask) => all + ask.readings, 0));
      report[name] = { asks: asks.map((ask) => [ask.start, ask.end, ask.readings]), days };
    }
    artifact(home().dir, "heart-rate-zone-change.json", report);
  });

  it("a page's step or a long absence's call asks a day twice or leaves one out, names two asks alike, or seals an ask its manifest does not hold", async () => {
    const at = home();
    const fake = signedIn(wallMs("2026-09-20", "10:00:00", ZONE));
    const { fetch, page, relay } = lane(fake, { start_ms: fake.now - 60 * DAY_MS, settings: { heart_rate_step: "10m" } });
    const metrics = (from: number): number => fake.requests.slice(from).filter((path) => path.startsWith("/metrics-service/")).length;
    const take = async <T extends Fetched>(name: string, call: () => Promise<T>) => {
      const from = fake.requests.length;
      const read = await call();
      const { start, end } = read.facts.date_range as { start: string; end: string };
      const asks = heartAsks(read);
      expect([asks.length, new Set(asks.map((ask) => ask.file)).size, metrics(from)], name).toEqual([daysFrom(start, end), daysFrom(start, end), daysFrom(start, end)]);
      expect(asks.filter((ask) => !read.files.some((file) => file.path === `app/${ask.file}`)), name).toEqual([]);
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, filesOf(read), read.facts, fake.now));
      expect([landed.refused, landed.duplicated], name).toEqual([0, 0]);
      return { read, seen: { name, range: read.facts.date_range as JsonObject, asks: asks.length, asked: fake.requests.length - from, landed: counts(landed) } };
    };
    const first = await take("first read", () => fetch(null));
    const walked = await take("page", () => page(first.read.state));
    fake.now = wallMs("2026-10-30", "10:00:00", ZONE);
    const away = await take("catch-up", () => fetch(walked.read.state));
    expect([walked.seen.asks, away.seen.asks, away.read.more]).toEqual([36, 36, true]);
    const days = heartDays(at, 600);
    expect([days["2026-08-08"], days["2026-09-12"], days["2026-09-19"], days["2026-10-24"]]).toEqual([144, 144, 144, 144]);
    expect(relay.errands).toHaveLength(3);
    const batches = relay.fetches.map((paths) => paths.filter((path) => path.startsWith("/metrics-service/")).length).filter((asks) => asks > 0);
    expect([Math.max(...batches), batches.reduce((all, asks) => all + asks, 0)]).toEqual([12, first.seen.asks + 36 + 36]);
    artifact(at.dir, "heart-rate-page.json", { calls: [first.seen, walked.seen, away.seen], batches });
  });

  it("an errand reaches beyond WHOOP's page, its sign-in and its API, fills a secret but the password, or has no deadline; an account turned off is read, or one with no source read unasked", async () => {
    const fake = signedIn(wallMs("2026-08-03", "10:00:00", ZONE));
    const read = lane(fake);
    await read.fetch(null);
    expect(read.relay.errands).toEqual([{ name: "whoop", origins: ["https://app.whoop.com", "https://id.whoop.com", "https://api.prod.whoop.com"], secrets: ["lifestream-whoop-password"], cookies: ["whoop-auth-token"], deadline_ms: 600_000 }]);
    const asked = fake.requests.length;
    const off = await ending(lane(fake, { accounts: { "10000002": true, [USER]: false } }).fetch(null));
    expect([off instanceof NotYet && off.reason, (off as NotYet).facts]).toEqual(["chrome", { account: FAKE_EMAIL }]);
    const offered = await ending(lane(fake, { accounts: { "10000002": true } }).fetch(null));
    expect([offered instanceof NeedsYou && offered.reason, (offered as NeedsYou).account]).toEqual(["other-account", { id: USER, email: FAKE_EMAIL }]);
    expect(fake.requests.slice(asked)).toEqual(["/users-service/v2/bootstrap/", "/users-service/v2/bootstrap/"]);
    const at = home();
    artifact(at.dir, "errand.json", { errand: read.relay.errands[0] as unknown as JsonObject, off: (off as Error).message, offered: (offered as Error).message });
  });
});

describe("whoop's cursor and memory", () => {
  it("grows the cursor with the days whose stress WHOOP owes, asks one again at a read but the day's first, writes memory there beyond the account's place and its sealed answers, or gives one up (N and 4N days of failed stress)", async () => {
    const today = "2026-09-20";
    const stressOf = (path: string): string | undefined => /^\/health-service\/v2\/stress-bff\/(.+)$/u.exec(path)?.[1];
    const history = async (days: number) => {
      const fake = signedIn(wallMs(today, "10:00:00", ZONE));
      const floor = addDays(today, 1 - days);
      fake.first = addDays(floor, -3);
      for (let day = floor; day < today; day = addDays(day, 1)) fake.answering[`/health-service/v2/stress-bff/${day}`] = 500;
      const { fetch, page } = lane(fake, { start_ms: Date.parse(`${floor}T00:00:00Z`), settings: { heart_rate_step: "10m" } });
      let state = (await fetch(null)).state;
      for (let turn = 0; turn < 20; turn++) {
        const paged = await page(state);
        state = paged.state;
        if (paged.left === 0) break;
      }
      expect([placeOf(state).reached_day, owedOf(state).length]).toEqual([floor, days - 1]);
      const cursor = Buffer.byteLength(canonical(state.cursor));
      fake.now += HOUR;
      let from = fake.requests.length;
      const later = await fetch(state);
      expect([fake.requests.slice(from).flatMap((path) => stressOf(path) ?? []), later.changes]).toEqual([[today], { cleared: [], entries: [["account", USER, expect.any(String)], [`sealed:${USER}`, "answers", expect.any(String)]] }]);
      fake.answering = {};
      state = later.state;
      const owed = owedOf(state);
      const asked = new Map<string, number>();
      let mornings = 0;
      for (; mornings < 20 && owedOf(state).length > 0; mornings++) {
        fake.now += 24 * HOUR;
        from = fake.requests.length;
        state = (await fetch(state)).state;
        for (const day of fake.requests.slice(from).flatMap((path) => stressOf(path) ?? [])) asked.set(day, (asked.get(day) ?? 0) + 1);
      }
      expect([owedOf(state), state.memory[`stress:${USER}`], mornings <= Math.ceil(owed.length / 36)]).toEqual([[], undefined, true]);
      expect(owed.filter((day) => !asked.has(day))).toEqual([]);
      return { days, cursor, owed: owed.length, mornings };
    };
    const n = await history(25);
    const n4 = await history(100);
    expect(Math.abs(n4.cursor - n.cursor)).toBeLessThanOrEqual(64);
    expect(Math.max(n.cursor, n4.cursor)).toBeLessThan(16_384);
    artifact(home().dir, "bounded.json", { n, n4 });
  });
});

describe("whoop sign-in again: each of these is impossible", () => {
  it("a signed-out page reads anything but signed in after the recipe, a signed-in one is typed into, or the password reaches anything but its field", async () => {
    const fake = fakeWhoop(ZONE);
    fake.now = wallMs("2026-08-03", "10:00:00", ZONE);
    const { fetch, relay, answers } = lane(fake);
    const polled = await fetch(null);
    expect([fake.signins, fake.fields.email.value, fake.fields.password.value]).toEqual([1, FAKE_EMAIL, FAKE_PASSWORD]);
    expect(polled.files.length).toBeGreaterThan(0);
    expect([...relay.filled]).toEqual([["lifestream-whoop-password", FAKE_PASSWORD]]);
    const said = [...answers, JSON.stringify(polled.facts), JSON.stringify(polled.state), ...polled.files.map((file) => fetchedBytes(file).toString("latin1"))];
    expect(said.filter((each) => each.includes(FAKE_PASSWORD))).toEqual([]);
    fake.fields.email.value = undefined;
    await fetch(polled.state);
    expect([fake.signins, fake.fields.email.value]).toEqual([1, undefined]);
    const at = home();
    artifact(at.dir, "sign-in-again.json", { signins: fake.signins, errands: relay.errands.length });
  });

  it("a site's declared sign-in, second origin or lapsed session works on WHOOP's own calls alone, and not on the browser lane given the same declaration", async () => {
    const fake = fakeWhoop(ZONE);
    fake.now = wallMs("2026-08-03", "10:00:00", ZONE);
    const relay = new FakeRelay(fake);
    const secrets = kept();
    const lent = (): Lent => ({ stations: stationsOver("https://door.example", "drive-token-synthetic", { fetch: (input, init) => relay.fetch(input, init), secrets }), accounts: {}, start_ms: null, from_ms: undefined, memory: callMemory(null) });
    const read = (block: object) => browserAcquirer({ work: join(temp(), "lane-work"), ...block } as BrowserSettings, { now: () => fake.now, sleep: async () => undefined }, {
      name: "whoop", site: whoop, pace_ms: 0, recipes,
      begin: async (pull) => (await whoIs("WHOOP", whoop.chrome.probe, pull.read)).who,
      async *list() {
        yield { items: [], next: null };
      },
      *exported() {},
      conversation: async () => "gone",
    });
    const unnamed = await ending(read({ password: PASSWORD_SECRET }).fetch(null, secrets, lent()));
    expect([unnamed instanceof Refused, relay.errands.length]).toEqual([true, 0]);
    const lane = read({ email: FAKE_EMAIL, password: PASSWORD_SECRET });
    const first = await lane.fetch(null, secrets, lent());
    expect([fake.signins, first.facts.sources, relay.errands]).toEqual([
      1, [{ id: SOURCE, connector: "whoop-capture", email: FAKE_EMAIL }],
      [{ name: "whoop", origins: ["https://app.whoop.com", "https://id.whoop.com", "https://api.prod.whoop.com"], secrets: ["lifestream-whoop-password"], cookies: ["whoop-auth-token"], deadline_ms: 1_800_000 }],
    ]);
    fake.token = undefined;
    fake.stays = true;
    const none = await ending(lane.fetch(first.state, secrets, lent()));
    expect([none instanceof NotYet && none.reason]).toEqual(["retrying"]);
    artifact(home().dir, "browser-lane-sign-in.json", { signins: fake.signins, errands: relay.errands.length, none: (none as Error).message });
  });

  it("a code asked after Sign In is answered by anything but the person, a refused password reads as anything but password, or no kept password as anything but its need", async () => {
    const coded = fakeWhoop(ZONE);
    coded.now = wallMs("2026-08-03", "10:00:00", ZONE);
    coded.code = true;
    const asked = lane(coded);
    const code = await ending(asked.fetch(null));
    expect([code instanceof NeedsYou && code.reason, (code as NeedsYou).at, asked.relay.open, coded.requests]).toEqual(["confirm", { site: "id.whoop.com", errand: "errand-1" }, 1, []]);

    const refused = fakeWhoop(ZONE);
    refused.now = coded.now;
    refused.password = "fake-password-changed";
    const wrong = await ending(lane(refused).fetch(null));
    expect([wrong instanceof NeedsYou && wrong.reason, (wrong as NeedsYou).facts]).toEqual(["password", { secret: "lifestream-whoop-password", company: "WHOOP", use: "sign-in" }]);

    const unkept = fakeWhoop(ZONE);
    unkept.now = coded.now;
    const none = await ending(lane(unkept).fetch(null, memorySecrets({})));
    expect([none instanceof NeedsYou && none.reason, (none as NeedsYou).says, (none as NeedsYou).answered, unkept.fields.email.value])
      .toEqual(["password", "WHOOP wants your password to sign in (lifestream-whoop-password)", false, undefined]);
    const at = home();
    artifact(at.dir, "sign-in-needs.json", { code: (code as Error).message, wrong: (wrong as Error).message, none: (none as Error).message });
  });
});

describe("whoop app capture", () => {
  const series = (zone: string, slices: readonly (readonly (readonly [string, number])[])[]): Files => {
    const files: Files = {};
    const heart_rate = slices.map((slice, index) => {
      const bytes = Buffer.from(JSON.stringify({ name: "heart_rate", values: slice.map(([at, data]) => ({ time: Date.parse(at), data })) }));
      const file = `heart-rate-${index}.json`;
      files[`app/${file}`] = bytes;
      return { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), step: 60, readings: slice.length, request_url: `https://api.prod.whoop.com/metrics-service/v1/metrics/user/${USER}?apiVersion=7&name=heart_rate&step=60` };
    });
    files["app/manifest.json"] = Buffer.from(JSON.stringify({ format: "org.lifestreamprotocol.whoop-app-snapshot/0.1", started_at: "2026-12-01T00:00:00Z", finished_at: "2026-12-01T00:00:00Z", complete: true, date_range: { start: "2026-10-01", end: "2026-11-30", timezone: zone }, hr_step_s: 60, cycles: [], sleep_events: [], heart_rate, stress: [] }));
    return files;
  };

  it("a reading beside the zone's change takes the wrong offset, on the hour or inside one", async () => {
    const at = home();
    const offsets = async (zone: string, instants: readonly string[]) => (await collect(whoopConnector.read(deliver(at, SOURCE, series(zone, [instants.map((each) => [each, 60] as const)]), {}, T0), at.blobs))).map((row) => row.time?.offset_min);
    expect(await offsets("America/New_York", ["2026-11-01T05:30:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:00:00Z", "2026-11-01T06:30:00Z"])).toEqual([-240, -240, -300, -300]);
    expect(await offsets("Australia/Lord_Howe", ["2026-10-03T14:59:00Z", "2026-10-03T15:00:00Z", "2026-10-03T15:29:00Z", "2026-10-03T15:30:00Z", "2026-10-03T16:00:00Z"])).toEqual([630, 630, 630, 660, 660]);
    artifact(at.dir, "zone-change.json", { zones: 2 });
  });

  it("an instant two slices read alike lands twice, or read differently lands from the later file, however far apart the two", async () => {
    const at = home();
    const read = (files: Files) => collect(whoopConnector.read(deliver(at, SOURCE, files, {}, T0), at.blobs));
    const alike = await read(series("UTC", [[["2026-11-01T05:00:00Z", 60], ["2026-11-01T05:01:00Z", 61]], [["2026-11-01T05:01:00Z", 61], ["2026-11-01T05:02:00Z", 62]]]));
    expect(alike.map((row) => row.locator)).toEqual(["heart-rate-0.json#values[0]", "heart-rate-0.json#values[1]", "heart-rate-1.json#values[1]"]);
    const differ = await read(series("UTC", [[["2026-11-01T05:00:00Z", 60], ["2026-11-01T05:01:00Z", 61]], [["2026-11-01T05:01:00Z", 70], ["2026-11-01T05:02:00Z", 62]], [["2026-11-01T05:03:00Z", 63]]]));
    expect(differ.map((row) => row.refused === undefined ? row.locator : [row.key, row.member, row.refused])).toEqual([
      "heart-rate-0.json#values[0]", "heart-rate-0.json#values[1]",
      ["app/heart-rate-1.json", "app/heart-rate-1.json", "app/heart-rate-1.json: two different readings at 20261101T050100.000Z in one delivery"],
      "heart-rate-2.json#values[0]",
    ]);
    const apart = await read(series("UTC", [[["2026-11-01T05:00:00Z", 60]], [["2026-11-01T05:01:00Z", 61]], [], [["2026-11-01T05:00:00Z", 70]], [["2026-11-01T05:00:00Z", 60], ["2026-11-01T05:02:00Z", 62]]]));
    expect(apart.map((row) => row.refused === undefined ? row.locator : [row.key, row.refused])).toEqual([
      "heart-rate-0.json#values[0]", "heart-rate-1.json#values[0]",
      ["app/heart-rate-3.json", "app/heart-rate-3.json: two different readings at 20261101T050000.000Z in one delivery"],
      "heart-rate-4.json#values[1]",
    ]);
    artifact(at.dir, "slices.json", { alike: alike.length, differ: differ.length, apart: apart.length });
  });

  it("a cycle answer is stored translated, a metrics reading lands on a graph key, or stages attach to another sleep", async () => {
    const at = home();
    const landed = await at.land(whoopConnector, deliver(at, SOURCE, appCapture(), {}, T0));
    const heads = at.heads(SOURCE, Object.keys(whoopConnector.kinds));
    const byKind = (kind: string) => heads.filter((head) => head.kind === kind);
    expect(byKind("cycle").map((head) => head.key).sort()).toEqual(["2000", "2001"]);
    const closed = byKind("cycle").find((head) => head.key === "2000")!;
    const stored = closed.content as { type: string; content: Record<string, unknown> };
    expect(stored.type).toBe("whoop.cycle-details");
    const page = JSON.parse(appCapture()["app/cycles-00001.json"]!.toString()) as { records: unknown[] };
    expect(stored.content).toEqual(page.records[0]);
    const stages = byKind("sleep-stages");
    expect(stages.map((head) => head.key)).toEqual([APP_SLEEP]);
    expect([stages[0]!.start_ms, stages[0]!.end_ms]).toEqual([Date.parse("2026-07-30T18:30:00.000Z"), Date.parse("2026-07-31T00:30:00.000Z")]);
    const samples = byKind("sample");
    expect(samples.filter((head) => head.key.startsWith("hr:")).length).toBe(0);
    expect(samples.filter((head) => head.key.startsWith("hr60:")).length).toBe(4);
    expect(samples.filter((head) => head.key.startsWith("stress:")).length).toBe(3);
    expect(landed.refused + landed.duplicated + landed.late).toBe(0);
    const replay = await at.land(whoopConnector, deliver(at, SOURCE, appCapture(), {}, T0));
    expect(replay.new + replay.changed).toBe(0);
    artifact(at.dir, "app-capture.json", { landed: counts(landed), replay: counts(replay), heads: heads.map((head) => `${head.kind}:${head.key}`).sort() });
  });

  it("the earlier of two pages' copies of one cycle wins, or a capture that cannot be trusted lands anything", async () => {
    const at = home();
    await at.land(whoopConnector, deliver(at, SOURCE, appCapture({ restatedStrain: 99 }), {}, T0));
    const closed = at.heads(SOURCE, ["cycle"]).find((head) => head.key === "2000")!;
    expect((closed.content as { content: { cycle: { scaled_strain: number } } }).content.cycle.scaled_strain).toBe(99);
    const refused: Record<string, string> = {};
    const otherLink = { ...longStress(LONG.start, LONG.edge, LONG.labels, LONG.points), typeform_url: `https://api.prod.whoop.com/url-mapping-service/v1/STRESS_FEEDBACK?stressScoreTimestamp=${encodeURIComponent(new Date(LONG.edge).toISOString())}&userId=10000002` };
    const cases: Record<string, Files> = {
      "another user nested": appCapture({ otherUser: true }),
      "another user in a stress link": appCapture({ stressDays: { "2026-07-31": otherLink } }),
      "another user in a misshapen file": appCapture({ sleepEvents: { user_id: 10000002 } }),
      tampered: { ...appCapture(), "app/cycles-00001.json": Buffer.from("{}\n") },
    };
    for (const [name, files] of Object.entries(cases)) {
      const other = home();
      await expect(other.land(whoopConnector, deliver(other, SOURCE, files, {}, T0)), name).rejects.toThrow(Refused);
      expect(other.heads(SOURCE, Object.keys(whoopConnector.kinds)), name).toEqual([]);
      refused[name] = "refused whole";
    }
    const away = home();
    expect((await away.land(whoopConnector, deliver(away, SOURCE, appCapture({ sleepOffset: "+01:00" }), {}, T0))).refused).toBe(0);
    expect(away.heads(SOURCE, ["sleep-stages"])[0]!.time?.offset_min).toBe(60);
    for (const noStress of [true, "graph"] as const) {
      const quiet = home();
      const landed = await quiet.land(whoopConnector, deliver(quiet, SOURCE, appCapture({ noStress }), {}, T0));
      expect(landed.new, String(noStress)).toBeGreaterThan(0);
      expect(quiet.heads(SOURCE, ["sample"]).filter((head) => head.key.startsWith("stress:")), String(noStress)).toEqual([]);
    }
    artifact(at.dir, "app-refused.json", { refused });
  });
  it("a page whose window does not cover a cycle states it, or is refused for it", async () => {
    const windows = {
      "the day after the closed cycle began": { start: "2026-08-01T00:00:00+05:30", end: "2026-08-01T23:59:59+05:30" },
      "the day before the closed cycle ended": { start: "2026-07-31T00:00:00+05:30", end: "2026-07-31T23:59:59+05:30" },
      "both, to before the snapshot": { start: "2026-07-31T00:00:00+05:30", end: "2026-08-01T12:00:00+05:30" },
    };
    const stated: Record<string, string[]> = {};
    for (const [name, cyclesWindow] of Object.entries(windows)) {
      const at = home();
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, appCapture({ cyclesWindow }), {}, T0));
      expect(landed.refused, name).toBe(0);
      stated[name] = at.heads(SOURCE, ["cycle"]).map((head) => head.key).sort();
    }
    expect(stated).toEqual({
      "the day after the closed cycle began": ["2001"],
      "the day before the closed cycle ended": [],
      "both, to before the snapshot": ["2000"],
    });
    const at = home();
    artifact(at.dir, "uncovered.json", stated);
  });
});

describe("whoop stress longer than a day", () => {
  it("a graph longer than a day lands a point on the wrong day, or is refused", async () => {
    const days = {
      start: wallMs("2026-07-26", "23:10:00", ZONE),
      edge: wallMs("2026-07-29", "21:40:12.340", ZONE),
      labels: [wallMs("2026-07-27", "04:00:00", ZONE), wallMs("2026-07-28", "07:00:00", ZONE), wallMs("2026-07-29", "11:00:00", ZONE)],
      points: [wallMs("2026-07-27", "01:00:00", ZONE), wallMs("2026-07-28", "07:00:00.010", ZONE), wallMs("2026-07-29", "20:00:30", ZONE), wallMs("2026-07-29", "21:40:12.340", ZONE)],
    };
    const at = home();
    const landed = await at.land(whoopConnector, deliver(at, SOURCE, appCapture({
      stressDays: { "2026-07-31": longStress(LONG.start, LONG.edge, LONG.labels, LONG.points), "2026-07-29": longStress(days.start, days.edge, days.labels, days.points) },
    }), {}, T0));
    expect(landed.refused).toBe(0);
    const stress = at.heads(SOURCE, ["sample"]).filter((head) => head.key.startsWith("stress:"));
    const placed = new Set(stress.map((head) => head.start_ms));
    expect(stress.length).toBe(3 + LONG.points.length + days.points.length);
    expect([...LONG.points, ...days.points].filter((ms) => !placed.has(ms))).toEqual([]);
    expect(stress.map((head) => head.key)).toContain("stress:20260730T130005.000Z");
    expect(stress.map((head) => head.key)).toContain("stress:20260731T040012.340Z");
    artifact(at.dir, "stress-long.json", { landed: counts(landed), stress: stress.map((head) => `${head.key} ${new Date(head.start_ms!).toISOString()}`).sort() });
  });

  it("a stress answer as WHOOP's website gives it, its update in lower case (\"12:45 am\") and its graph's clocks on 24 hours (\"02:10\"), is refused or lands other points", async () => {
    const app = longStress(LONG.start, LONG.edge, LONG.labels, LONG.points);
    const graph = JSON.stringify({ ...app, last_updated_display: null }).replace(/"(1[0-2]|[1-9]):([0-5]\d) ([AP])M"/gu, (_, hour: string, minute: string, half: string) =>
      `"${String((Number(hour) % 12) + (half === "P" ? 12 : 0)).padStart(2, "0")}:${minute}"`);
    const web = { ...(JSON.parse(graph) as Record<string, unknown>), last_updated_display: String(app.last_updated_display).replace(/ ([AP])M$/u, (_, half: string) => ` ${half.toLowerCase()}m`) };
    expect([String(web.last_updated_display), graph.includes(" AM\""), graph.includes(" PM\"")]).toEqual([expect.stringMatching(/ [ap]m$/u), false, false]);
    const lower = home();
    const upper = home();
    const landed = await lower.land(whoopConnector, deliver(lower, SOURCE, appCapture({ stressDays: { "2026-07-31": web } }), {}, T0));
    await upper.land(whoopConnector, deliver(upper, SOURCE, appCapture({ stressDays: { "2026-07-31": longStress(LONG.start, LONG.edge, LONG.labels, LONG.points) } }), {}, T0));
    const points = (at: TestHome) => at.heads(SOURCE, ["sample"]).filter((head) => head.key.startsWith("stress:")).map((head) => head.key).sort();
    expect([landed.refused, points(lower)]).toEqual([0, points(upper)]);
    artifact(lower.dir, "stress-web-clock.json", { landed: counts(landed), stress: points(lower) });
  });

  it("a file the reader cannot read stops the rest of its capture", async () => {
    const report: JsonObject = {};
    const cases: Record<string, { files: Files; refused: string; lands: string[] }> = {
      "stress axis": {
        files: appCapture({ stressDays: { "2026-07-31": longStress(LONG.start, LONG.edge, LONG.labels, LONG.points, ["6:45 PM"]) } }),
        refused: "app/stress-2026-07-31.json",
        lands: ["cycle:2000", "cycle:2001", "hr60:4", "sleep-stages:1", "stress:3"],
      },
      "broken during": {
        files: appCapture({ brokenDuring: "2026-07-31 to 2026-08-01" }),
        refused: "app/cycles-00001.json",
        lands: ["hr60:4", "sleep-stages:1", "stress:3"],
      },
      "a sleep event ending before it starts": {
        files: appCapture({ sleepEvents: [{ during: "['2026-07-30T20:00:00.000Z','2026-07-30T19:00:00.000Z')", type: "LIGHT" }] }),
        refused: `app/sleep-events-${APP_SLEEP}.json`,
        lands: ["cycle:2000", "cycle:2001", "hr60:4", "stress:3"],
      },
      "unbracketed during": {
        files: appCapture({ brokenDuring: "'2026-07-31T00:30:00.000Z','2026-08-01T00:30:00.000Z'" }),
        refused: "app/cycles-00001.json",
        lands: ["hr60:4", "sleep-stages:1", "stress:3"],
      },
    };
    for (const [name, { files, refused, lands }] of Object.entries(cases)) {
      const at = home();
      const landed = await at.land(whoopConnector, deliver(at, SOURCE, files, {}, T0));
      expect(landed.refusals.map((refusal) => [refusal.kind, refusal.key]), name).toEqual([["file", refused]]);
      const heads = at.heads(SOURCE, KINDS);
      const samples = (prefix: string) => `${prefix}:${heads.filter((head) => head.key.startsWith(`${prefix}:`)).length}`;
      const found = [...heads.filter((head) => head.kind === "cycle").map((head) => `cycle:${head.key}`), samples("hr60"), `sleep-stages:${heads.filter((head) => head.kind === "sleep-stages").length}`, samples("stress")];
      expect(found.filter((each) => !/:0$/u.test(each)), name).toEqual(lands);
      report[name] = { landed: counts(landed), refusals: landed.refusals as unknown as JsonObject[], heads: found };
    }
    expect((report["stress axis"] as { refusals: { violations: string[] }[] }).refusals[0]!.violations[0]).toMatch(/no whole-day placement of the stress axis/u);
    const at = home();
    artifact(at.dir, "file-refused.json", report);
  });
});
