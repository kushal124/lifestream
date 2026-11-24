import { createHash } from "node:crypto";
import { addDays, civilDay, dayBounds, duration, instant, onSite, refuse, rfc3339, whoIs, type Acquirer, type Fetched, type FetchedFile, type FileAnswer, type Json, type JsonObject, type Lent, type Memory, type Pull, type Secrets, type SiteDependencies, type SiteVisit, type Value } from "@lifestreamprotocol/connect/sdk";
import { APP_FORMAT } from "./app.js";
import { whoop } from "./connector.js";
import { recipes } from "./recipe.js";
import { zoneOffset } from "./graph.js";
import { covers, cycleWindow, everyUserId } from "./parts.js";

export const WHOOP_API = "https://api.prod.whoop.com";
const CYCLE_SLICE_DAYS = 30;
const HEART_RATE_BATCH = 12;
const REACH_DAYS = 36;
export const FIRST_DAY = "2015-01-01";
const FORWARD_DAYS = 36;
const DEADLINE_MS = 10 * 60_000;
const OVERLAP_DAYS = 7;
const DAY_START_HOUR = 4;
const DEFAULT_STEP = "1m";
const STEPS = ["6s", "1m", "10m"];
const SESSION: Readonly<Record<string, Value>> = { Authorization: { cookie: whoop.chrome.probe.cookie, prefix: "Bearer " } };

export interface WhoopSettings {
  work: string;
  email?: string;
  password: string;
  timezone?: string;
  zone?: string;
  heart_rate_step?: string;
}

const STRESS = "stress";
const SEALED = "sealed";
const ANSWERS = "answers";

export interface WhoopState extends JsonObject {
  until_ms: number;
  polled_ms: number;
  reached_day?: string;
}

interface Settled {
  timezone: string;
  hr_step_s: number;
}

interface Days {
  start: string;
  end: string;
}

function daysBetween(from: string, to: string): number {
  return Math.max(0, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000));
}

function settle(settings: WhoopSettings): Settled {
  const step = settings.heart_rate_step ?? DEFAULT_STEP;
  if (!STEPS.includes(step)) refuse("heart_rate_step must be 6s, 1m or 10m");
  const timezone = settings.timezone ?? settings.zone ?? refuse("timezone names no zone, and the home lent none");
  zoneOffset(timezone, 0);
  return { timezone, hr_step_s: duration(step) / 1000 };
}

interface Session {
  readonly settled: Settled;
  readonly at: number;
  readonly prior: Partial<WhoopState>;
  readonly capture: Capture;
  readonly own: JsonObject;
  readonly floor: string;
  readonly memory: Memory;
  left(earliest: string): boolean;
  owed(): string[];
  seal(range: Days): FetchedFile[];
  facts(range: Days): JsonObject;
  leave(next: WhoopState): JsonObject;
}

export function whoopAcquirer(settings: WhoopSettings, dependencies: SiteDependencies = {}): Acquirer {
  const lane = onSite({
    name: "whoop", site: whoop, block: settings, deadline_ms: DEADLINE_MS, dependencies, recipes,
    begin: async (pull) => (await whoIs(whoop.name, whoop.chrome.probe, pull.read)).who,
  });

  function errand<T extends Fetched>(secrets: Secrets, lent: Lent, call: (at: Session) => Promise<T>): Promise<T> {
    const settled = settle(settings);
    return lane.visit<WhoopState, T>(secrets, lent, (visit) => call(sessionOf(settled, visit, lent)));
  }

  function sessionOf(settled: Settled, visit: SiteVisit<WhoopState>, lent: Lent): Session {
    const at = visit.started;
    const prior: Partial<WhoopState> = visit.previous ?? {};
    const capture = new Capture(visit.pull, settled, visit.account, at, visit.memory);
    const day = lent.start_ms === null ? FIRST_DAY : civilDay(lent.start_ms, { zone: settled.timezone, day_start_hour: 0 });
    const floor = day < FIRST_DAY ? FIRST_DAY : day;
    const stamp = rfc3339(at);
    return {
      settled, at, prior, capture, own: visit.own, floor, memory: visit.memory,
      left: (earliest) => earliest > floor,
      owed: () => owedDays(visit.memory).slice(0, FORWARD_DAYS),
      seal: (range) => capture.seal({ format: APP_FORMAT, started_at: stamp, finished_at: stamp, complete: true, date_range: { ...range, timezone: settled.timezone }, hr_step_s: settled.hr_step_s }),
      facts: (range) => ({ snapshot_taken_at: stamp, date_range: { ...range, timezone: settled.timezone }, ...capture.counts(), ...visit.own }),
      leave: visit.leave,
    };
  }

  return {
    name: "whoop",
    source: "whoop",
    fetch: (_state, secrets, lent) => errand(secrets, lent, async (session) => {
      const { settled, at, prior, capture, floor, owed, seal, facts, leave, memory } = session;
      const previous = typeof prior.until_ms === "number" ? prior.until_ms : undefined;
      const forward = window(at, previous, settled, floor);
      const today = civilDay(at, { zone: settled.timezone, day_start_hour: 0 });
      await capture.cycles(forward);
      await capture.sleepStages();
      await capture.heartRate(forward);
      await capture.stress(forward, firstRead(at, typeof prior.polled_ms === "number" ? prior.polled_ms : undefined, settled) ? owed() : []);
      const reached = prior.reached_day === undefined || forward.start < prior.reached_day ? forward.start : prior.reached_day;
      const short = forward.end < today;
      const until = short ? Math.max(previous ?? 0, midnight(addDays(forward.end, 1), settled.timezone) - 1) : Math.max(previous ?? at, at);
      const next: WhoopState = { until_ms: until, polled_ms: at, reached_day: reached };
      const more = short ? { more: true as const } : {};
      const answers = capture.digest(forward);
      if (memory.get(SEALED, ANSWERS) === answers) return { files: [], facts: facts(forward), state: leave(next), ...more };
      memory.put(SEALED, ANSWERS, answers);
      return { files: seal(forward), facts: facts(forward), state: leave(next), ...more };
    }),
    page: (_state, secrets, lent) => errand(secrets, lent, async (session) => {
      const { settled, at, prior, capture, own, floor, left, seal, facts, leave } = session;
      const reached = prior.reached_day ?? civilDay(at, { zone: settled.timezone, day_start_hour: 0 });
      const walked = {
        ...(typeof prior.until_ms === "number" ? { until_ms: prior.until_ms } : {}), ...(typeof prior.polled_ms === "number" ? { polled_ms: prior.polled_ms } : {}),
      } as WhoopState;
      if (!left(reached)) return { files: [], facts: own, state: leave({ ...walked, reached_day: reached }), left: 0 };
      const end = addDays(reached, -1);
      const start = addDays(end, 1 - REACH_DAYS);
      const back: Days = { start: start < floor ? floor : start, end };
      if ((await capture.cycles(back)) > 0) {
        await capture.sleepStages();
        await capture.heartRate(back);
        await capture.stress(back);
      }
      const done = !left(back.start);
      const next: WhoopState = { ...walked, reached_day: back.start };
      return { files: seal(back), facts: facts(back), state: leave(next), left: done ? 0 : daysBetween(floor, back.start) };
    }),
  };
}

function owedDays(memory: Memory): string[] {
  const owed: { day: string; asked: number }[] = [];
  for (let page = memory.list(STRESS); page.length > 0; page = memory.list(STRESS, page.at(-1)![0])) {
    for (const [day, asked] of page) owed.push({ day, asked: asked as number });
  }
  return owed.sort((a, b) => a.asked - b.asked || (a.day < b.day ? -1 : 1)).map((each) => each.day);
}

function firstRead(at: number, previous: number | undefined, settings: Settled): boolean {
  const civil = { zone: settings.timezone, day_start_hour: DAY_START_HOUR };
  return previous === undefined || previous < dayBounds(civilDay(at, civil), civil).start_ms;
}

function window(at: number, previous: number | undefined, settings: Settled, start: string): Days {
  const calendar = { zone: settings.timezone, day_start_hour: 0 };
  const today = civilDay(at, calendar);
  const reached = previous === undefined ? today : civilDay(previous, calendar);
  const caught = reached < today ? reached : today;
  const begin = start < today ? start : today;
  const from = caught < begin ? begin : caught;
  const bound = addDays(from, FORWARD_DAYS - 1);
  const back = firstRead(at, previous, settings) ? addDays(from, -OVERLAP_DAYS) : from;
  const scoring = addDays(today, -OVERLAP_DAYS);
  const floor = from < scoring ? from : scoring;
  const earliest = back > floor ? back : floor;
  return { start: earliest < begin ? begin : earliest, end: bound < today ? bound : today };
}

class Capture {
  readonly #manifest: Record<"cycles" | "sleep_events" | "heart_rate" | "stress", JsonObject[]> = { cycles: [], sleep_events: [], heart_rate: [], stress: [] };
  readonly #stressFailed: { date: string; status: number }[] = [];
  readonly #sleeps = new Map<string, string>();
  readonly #whole = new Set<string>();
  #readings = 0;
  private readonly pull: Pull;
  private readonly settled: Settled;
  private readonly user: string;
  private readonly at: number;
  private readonly memory: Memory;

  constructor(pull: Pull, settled: Settled, user: string, at: number, memory: Memory) {
    this.pull = pull;
    this.settled = settled;
    this.user = user;
    this.at = at;
    this.memory = memory;
  }

  async cycles(days: Days): Promise<number> {
    const zone = this.settled.timezone;
    const urls: string[] = [];
    for (let start = days.start; start <= days.end; start = addDays(start, CYCLE_SLICE_DAYS)) {
      const last = addDays(start, CYCLE_SLICE_DAYS - 1) < days.end ? addDays(start, CYCLE_SLICE_DAYS - 1) : days.end;
      urls.push(cyclesUrl(this.user, midnight(start, zone), midnight(addDays(last, 1), zone)));
    }
    const answered = await this.#cycles(urls);
    const cut = new Map<string, string>();
    for (const { url, records } of answered) {
      for (const record of records) {
        const id = idOf(record);
        const span = spanOf(record, this.at, url);
        if (covers(cycleWindow(new URL(url), url), span)) this.#whole.add(id);
        else if (!cut.has(id)) cut.set(id, cyclesUrl(this.user, Math.floor(span.start / 1000) * 1000, Math.ceil(span.end / 1000) * 1000));
      }
    }
    const again = [...cut].filter(([id]) => !this.#whole.has(id));
    for (const [index, { url, records }] of (await this.#cycles(again.map(([, url]) => url))).entries()) {
      const id = again[index]![0];
      const record = records.find((one) => idOf(one) === id) ?? refuse(`the ask of cycle ${id} over its own span answered no such cycle`);
      if (!covers(cycleWindow(new URL(url), url), spanOf(record, this.at, url))) refuse(`the ask of cycle ${id} over its own span answered it over another span`);
      this.#whole.add(id);
    }
    return answered.reduce((total, { records }) => total + records.length, 0);
  }

  async #cycles(urls: readonly string[]): Promise<{ url: string; records: unknown[] }[]> {
    return (await this.#read(urls)).map((bytes, index) => {
      const url = urls[index]!;
      const answer = object(json(bytes));
      const records = answer?.records;
      if (answer === undefined || !Array.isArray(records)) refuse("a cycles answer states no records array");
      everyUserId(answer as Json, this.user, `the cycles answer to ${new URL(url).search}`);
      const listed = this.#manifest.cycles;
      listed.push({ ...this.#put(`cycles-${String(listed.length + 1).padStart(5, "0")}.json`, bytes), request_url: url, records: records.length });
      for (const record of records) {
        const sleeps = object(record)?.sleeps;
        for (const raw of Array.isArray(sleeps) ? sleeps : []) {
          const sleep = object(raw);
          if (typeof sleep?.activity_id === "string" && typeof sleep.timezone_offset === "string") this.#sleeps.set(sleep.activity_id, sleep.timezone_offset);
        }
      }
      return { url, records };
    });
  }

  async sleepStages(): Promise<void> {
    const sleeps = [...this.#sleeps];
    const urls = sleeps.map(([id]) => `${WHOOP_API}/sleep-service/v1/sleep-events?apiVersion=7&activityId=${id}`);
    for (const [index, bytes] of (await this.#read(urls)).entries()) {
      const [id, offset] = sleeps[index]!;
      this.#manifest.sleep_events.push({ ...this.#put(`sleep-events-${id}.json`, bytes), request_url: urls[index]!, activity_id: id, timezone_offset: offset });
    }
  }

  async heartRate(days: Days): Promise<void> {
    const step = this.settled.hr_step_s;
    const zone = this.settled.timezone;
    const asks: { url: string; name: string }[] = [];
    for (let day = days.start; day <= days.end; day = addDays(day, 1)) {
      const from = midnight(day, zone);
      const to = midnight(addDays(day, 1), zone) - 1;
      const url = new URL(`${WHOOP_API}/metrics-service/v1/metrics/user/${this.user}`);
      url.searchParams.set("apiVersion", "7");
      url.searchParams.set("name", "heart_rate");
      url.searchParams.set("order", "t");
      url.searchParams.set("step", String(step));
      url.searchParams.set("start", new Date(from).toISOString());
      url.searchParams.set("end", new Date(to).toISOString());
      asks.push({ url: url.toString(), name: `heart-rate-${basic(from)}-${basic(to)}-step${step}.json` });
    }
    for (let at = 0; at < asks.length; at += HEART_RATE_BATCH) {
      const batch = asks.slice(at, at + HEART_RATE_BATCH);
      for (const [index, bytes] of (await this.#read(batch.map((ask) => ask.url))).entries()) {
        const values = object(json(bytes))?.values;
        const readings = Array.isArray(values) ? values.length : 0;
        this.#readings += readings;
        this.#manifest.heart_rate.push({ ...this.#put(batch[index]!.name, bytes), request_url: batch[index]!.url, step, readings });
      }
    }
  }

  async stress(days: Days, owed: readonly string[] = []): Promise<void> {
    const dates: string[] = [];
    for (let day = days.start; day <= days.end; day = addDays(day, 1)) dates.push(day);
    dates.push(...owed.filter((day) => day < days.start || day > days.end));
    const urls = dates.map((day) => `${WHOOP_API}/health-service/v2/stress-bff/${day}?apiVersion=7`);
    for (const [index, answer] of (await this.#answers(urls)).entries()) {
      const date = dates[index]!;
      if (answer.status >= 500) {
        this.#stressFailed.push({ date, status: answer.status });
        this.memory.put(STRESS, date, this.at);
      } else {
        this.#manifest.stress.push({ ...this.#put(`stress-${date}.json`, this.#body(answer, urls[index]!)), request_url: urls[index]!, date });
        this.memory.drop(STRESS, date);
      }
    }
  }

  digest(range: Days): string {
    const answers = { range, ...this.#manifest, stress_failed: this.#stressFailed };
    return createHash("sha256").update(JSON.stringify(answers)).digest("hex");
  }

  counts(): JsonObject {
    return { app_cycles: this.#whole.size, app_sleep_events: this.#manifest.sleep_events.length, app_hr_readings: this.#readings, app_stress_days: this.#manifest.stress.length,
      ...(this.#stressFailed.length === 0 ? {} : { app_stress_failed: this.#stressFailed.length }) };
  }

  seal(head: JsonObject): FetchedFile[] {
    const manifest = { ...head, ...this.#manifest, ...(this.#stressFailed.length === 0 ? {} : { stress_failed: this.#stressFailed }) };
    this.pull.keep("app/manifest.json", Buffer.from(`${JSON.stringify(manifest)}\n`));
    return this.pull.kept;
  }

  async #read(urls: readonly string[]): Promise<Buffer[]> {
    return (await this.#answers(urls)).map((answer, index) => this.#body(answer, urls[index]!));
  }

  async #answers(urls: readonly string[]): Promise<FileAnswer[]> {
    return urls.length === 0 ? [] : this.pull.files(urls.map((url) => ({ url, headers: SESSION })));
  }

  #body(answer: FileAnswer, url: string): Buffer {
    if (answer.status !== 200 || answer.bytes === undefined) refuse(`${new URL(url).pathname} answered HTTP ${answer.status}`);
    return answer.bytes;
  }

  #put(name: string, bytes: Buffer): JsonObject {
    this.pull.keep(`app/${name}`, bytes);
    return { file: name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
}

function cyclesUrl(user: string, from: number, to: number): string {
  const url = new URL(`${WHOOP_API}/core-details-bff/v0/cycles/details`);
  url.searchParams.set("apiVersion", "7");
  url.searchParams.set("id", user);
  url.searchParams.set("startTime", new Date(from).toISOString().replace(".000Z", "Z"));
  url.searchParams.set("endTime", new Date(to).toISOString().replace(".000Z", "Z"));
  url.searchParams.set("limit", "100");
  return url.toString();
}

function idOf(record: unknown): string {
  return String(object(object(record)?.cycle)?.id);
}

function spanOf(record: unknown, now: number, url: string): { start: number; end: number } {
  const during = object(object(record)?.cycle)?.during;
  const [, start, end] = (typeof during === "string" ? /^\['([^']+)',(?:'([^']+)')?\)$/u.exec(during) : null) ?? [];
  const span = { start: Date.parse(start ?? ""), end: end === undefined ? now : Date.parse(end) };
  return Number.isNaN(span.start) || Number.isNaN(span.end) ? refuse(`the cycles answer to ${new URL(url).search} states a cycle whose during is no span`) : span;
}

function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function basic(ms: number): string {
  return rfc3339(ms).replace(/[-:]/gu, "");
}

function midnight(day: string, zone: string): number {
  return instant(`${day}T00:00:00`, "local", { zone }).start_ms;
}
