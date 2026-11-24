import type { FakeElement, FakePage, Site, SiteAnswer, SiteRequest } from "../../../test/station.js";
import { during, FAKE_EMAIL, FAKE_FIRST_DAY, FAKE_PASSWORD, graphPoint, offsetAt, sleepEvents, clockAt, USER, wallMs } from "./fixtures.js";

export const APP = "https://app.whoop.com";
export const ID = "https://id.whoop.com";
export const API = "https://api.prod.whoop.com";
export const SIGN_IN = `${ID}/us/en/sign-in/?for=${encodeURIComponent(APP)}`;
export const COOKIE = "whoop-auth-token";

export interface FakeWhoop extends Site {
  now: number;
  requests: string[];
  token: string | undefined;
  honoured: string | undefined;
  user: string;
  email: string;
  cycles_user: string;
  recovery_user: string | undefined;
  late: string[];
  first: string;
  long: Record<string, number>;
  absent: Record<string, number>;
  grid: ((start: number) => number) | undefined;
  readonly cuts: { start: number; end: number; spans: number };
  password: string;
  code: boolean;
  stays: boolean;
  signins: number;
  answering: Record<string, number>;
  readonly fields: { email: FakeElement; password: FakeElement };
  signIn(): string;
  whole(key: string): Record<string, unknown> | undefined;
  readings(stepMs: number): { heart: number[]; stress: number[] };
}

const STEP_MS = 30 * 60_000;
const ZONE_DAY_MS = 86_400_000;

export function fakeWhoop(zone: string, rescore?: { day: string; at: number }): FakeWhoop {
  let issued = 0;
  const email: FakeElement = { role: "textbox", name: "Email" };
  const password: FakeElement = { role: "textbox", name: "Password" };
  const site: FakeWhoop = {
    now: 0,
    requests: [],
    token: undefined,
    honoured: undefined,
    user: USER,
    email: FAKE_EMAIL,
    cycles_user: USER,
    recovery_user: undefined,
    late: [],
    first: FAKE_FIRST_DAY,
    long: {},
    absent: {},
    grid: undefined,
    cuts: { start: 0, end: 0, spans: 0 },
    answering: {},
    password: FAKE_PASSWORD,
    code: false,
    stays: false,
    signins: 0,
    fields: { email, password },
    whole: (() => {
      let cachedKey = "";
      let cachedMap = new Map<string, HeldCycle>();
      return (key: string) => {
        const nextKey = JSON.stringify([site.now, site.first, site.cycles_user, site.late, site.long, site.absent, site.cuts]);
        if (nextKey !== cachedKey) {
          cachedKey = nextKey;
          cachedMap = new Map(heldCycles(site, zone, site.now, rescore).map((cycle) => [cycle.day.replaceAll("-", ""), cycle]));
        }
        return cachedMap.get(key)?.record(site.now, () => true);
      };
    })(),
    readings(stepMs) {
      const instants = (each: number) => {
        const out: number[] = [];
        for (let at = Math.ceil(wallMs(site.first, "00:30:00", zone) / each) * each; at <= site.now; at += each) if (!away(site, at, zone)) out.push(at);
        return out;
      };
      return { heart: instants(stepMs), stress: instants(STEP_MS) };
    },
    signIn() {
      site.token = `fake-whoop-session-${++issued}`;
      site.honoured = site.token;
      return site.token;
    },
    cookies: (origin) => (origin === APP && site.token !== undefined ? { [COOKIE]: site.token, "whoop-auth-expiry": String(site.now + ZONE_DAY_MS) } : {}),
    page(url: URL): FakePage | undefined {
      if (url.origin === APP) return site.token === undefined && !site.stays ? { elements: [], redirect: SIGN_IN } : { title: "WHOOP", elements: [{ role: "heading", name: "Today" }] };
      if (url.origin !== ID) return undefined;
      if (url.pathname.endsWith("/verify/")) return { title: "WHOOP", elements: [{ role: "heading", name: "Enter your code" }, { role: "textbox", name: "Code" }], signals: { otp: true } };
      const signIn = (): string | void => {
        if (email.value !== site.email || password.value !== site.password) return;
        if (site.code) return `${ID}/us/en/verify/`;
        site.signins++;
        site.signIn();
        return `${APP}/`;
      };
      return { title: "WHOOP", elements: [{ role: "heading", name: "Sign In" }, email, password, { role: "button", name: "Sign In", click: signIn }], signals: { password: true } };
    },
    answer(request: SiteRequest): SiteAnswer {
      const url = request.url;
      if (url.origin !== API) return { status: 404 };
      const path = url.pathname;
      site.requests.push(path);
      const answering = site.answering[path];
      if (answering !== undefined) return { status: answering, body: { message: "synthetic" } };
      const bearer = request.headers.Authorization?.replace(/^Bearer /u, "");
      if (bearer === undefined || bearer !== site.honoured) return { status: 401, body: { message: "unauthorized" } };
      const stress = /^\/health-service\/v2\/stress-bff\/(\d{4}-\d{2}-\d{2})$/u.exec(path);
      if (stress !== null) return { status: 200, body: fakeStress(stress[1]!, site, zone) };
      if (path === "/users-service/v2/bootstrap/") return { status: 200, body: { user: { id: Number(site.user) }, account: { id: 70000001, user_id: Number(site.user), email: site.email } } };
      if (path === "/core-details-bff/v0/cycles/details") return { status: 200, body: fakeCycles(url, site, zone, rescore) };
      if (path === "/sleep-service/v1/sleep-events") return { status: 200, body: fakeSleepEvents(url.searchParams.get("activityId")!, zone) };
      if (path === `/metrics-service/v1/metrics/user/${site.user}`) {
        const metrics = fakeMetrics(url, site, zone);
        return metrics === null ? { status: 400, body: { message: "window too wide" } } : { status: 200, body: metrics };
      }
      return { status: 404, body: { message: "no such route" } };
    },
  };
  return site;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * ZONE_DAY_MS).toISOString().slice(0, 10);
}

function fakeWindow(day: string, zone: string): { start: number; end: number } {
  return { start: wallMs(shiftDay(day, -1), "22:00:00", zone), end: wallMs(day, "22:00:00", zone) };
}

function shown(day: string, now: number, zone: string): number[] {
  const { start, end } = fakeWindow(day, zone);
  const out: number[] = [];
  for (let at = Math.ceil(start / STEP_MS) * STEP_MS; at <= Math.min(end, now); at += STEP_MS) out.push(at);
  return out;
}

function step(at: number): number {
  return Math.floor(at / STEP_MS);
}

function offsetText(minutes: number): string {
  const magnitude = Math.abs(minutes);
  return `${minutes < 0 ? "-" : "+"}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
}

function fakeStress(day: string, site: FakeWhoop, zone: string): Record<string, unknown> {
  const { start } = fakeWindow(day, zone);
  const points = shown(day, site.now, zone).filter((at) => !away(site, at, zone));
  if (points.length === 0) return { overlay_group_list: [] };
  if (points.length < 4) throw new Error(`the fake band shows too little stress for ${day} yet`);
  const last = points.at(-1)!;
  const span = last - start;
  const offset = offsetAt(zone, last);
  const position = (at: number) => (at - start) / span;
  const score = (at: number) => (step(at) % 30) / 10;
  return {
    last_updated_display: clockAt(last, offset),
    typeform_url: "https://api.prod.whoop.com/url-mapping-service/v1/STRESS_FEEDBACK" +
      `?stressScore=${score(last).toFixed(1)}&stressScoreTimestamp=${encodeURIComponent(new Date(last).toISOString())}`,
    overlay_group_list: [{ label: { id: `label-${day}`, text: "Stress" } }],
    extended24_hour_graph: {
      graph: {
        plane: { bottom_xaxis: { labels: [start, points.at(-3)!, points.at(-2)!].map((at) => ({ label: clockAt(at, offset), position: position(at) })) } },
        plots: [{
          type: "LINE_PLOT",
          plot: { id: "stress", segments: [{ style: "SYNTHETIC", points: points.map((at) => graphPoint(position(at), score(at), clockAt(at, offset), "stress")) }] },
        }],
      },
    },
  };
}


interface HeldCycle {
  readonly day: string;
  readonly start: number;
  readonly end: number;
  readonly record: (now: number, keep: (from: number, to: number) => boolean) => Record<string, unknown>;
}

function heldCycles(site: FakeWhoop, zone: string, now: number, rescore?: { day: string; at: number }): HeldCycle[] {
  const held: HeldCycle[] = [];
  for (let day = site.first; wallMs(day, "00:30:00", zone) <= now;) {
    const away = site.absent[day];
    if (away !== undefined) {
      day = shiftDay(day, away);
      continue;
    }
    const next = shiftDay(day, site.long[day] ?? 1);
    const start = wallMs(day, "00:30:00", zone);
    const end = wallMs(next, "00:30:00", zone);
    const wake = wallMs(day, "06:00:00", zone);
    const scored = wake + 5 * 60_000;
    const late = site.late.includes(day) || site.long[day] !== undefined;
    const id = day.replaceAll("-", "");
    const sleepId = `00000000-0000-4000-8000-0000${id}`;
    const owned = day;
    held.push({
      day, start, end,
      record: (at, keep) => {
        const closed = end <= at;
        const timezone_offset = offsetText(offsetAt(zone, start));
        const rescored = rescore?.day === owned && at >= rescore.at;
        const sleep = wake <= at && keep(start, wake);
        const workouts = [[wake + 3_600_000, wake + 7_200_000], ...(late ? [[end - 25 * 60_000, end - 10 * 60_000]] : [])]
          .filter(([from, to]) => to! <= at && keep(from!, to!));
        const activity = wake + 7_200_000 <= at && keep(wake + 3_600_000, wake + 7_200_000);
        return {
          cycle: {
            id: Number(id), user_id: Number(site.cycles_user), created_at: new Date(start).toISOString(),
            updated_at: new Date(closed ? end : Math.min(at, scored)).toISOString(), during: during(start, closed ? end : null),
            timezone_offset: timezone_offset.replace(":", ""), days: `['${day}','${next}')`, data_state: closed ? "complete" : "pending",
            scaled_strain: 4.5, day_strain: 4.4, day_kilojoules: 8000, day_avg_heart_rate: 70, day_max_heart_rate: 120,
            sleep_need: null, predicted_end: new Date(end).toISOString(), intensity_score: null,
          },
          recovery: sleep && scored <= at ? {
            activity_id: sleepId, user_id: Number(site.recovery_user ?? site.cycles_user), state: "complete", recovery_score: rescored ? 55 : 50,
            resting_heart_rate: 55, hrv_rmssd: 0.05, hr_baseline: 60, skin_temp_celsius: 33.5, spo2: 98,
            algo_version: "synthetic-1", history_size: 10, responded: false, calibrating: false, normal: true,
            survey_response_id: null, prob_covid: null, rhr_component: null, hrv_component: null, recovery_rate: null,
            created_at: new Date(scored).toISOString(), updated_at: new Date(rescored ? rescore!.at : scored).toISOString(),
            activity_version: 1,
          } : null,
          sleeps: sleep ? [{
            activity_id: sleepId, user_id: Number(site.cycles_user), during: during(start, wake), timezone_offset, state: "complete",
            score: 88, is_nap: false, time_in_bed: 19_800_000, light_sleep_duration: 10_800_000,
            slow_wave_sleep_duration: 5_400_000, rem_sleep_duration: 3_600_000, wake_duration: 1_800_000,
            cycles_count: 4, disturbances: 2, in_sleep_efficiency: 0.9, respiratory_rate: 15,
            debt_pre: 0.5, debt_post: 0.25, need_from_strain: 0.5, credit_from_naps: 0,
            created_at: new Date(scored).toISOString(), updated_at: new Date(scored).toISOString(),
            activity_version: 1, source: "synthetic",
          }] : [],
          workouts: workouts.map(([from, to], index) => ({
            activity_id: `1000000${index}-0000-4000-8000-0000${id}`, during: during(from!, to!),
            timezone_offset, score: 3.5, sport_id: 9999, kilojoules: 900, average_heart_rate: 110, max_heart_rate: 140,
            msk_score: null, total_steps: null, zone_durations_v2: { zone0_to50_duration: 0 }, source: "synthetic",
          })),
          v2_activities: activity ? [{
            id: `20000000-0000-4000-8000-0000${id}`, cycle_id: Number(id), user_id: Number(site.cycles_user),
            type: "walking", translated_type: "Walking", during: during(wake + 3_600_000, wake + 7_200_000),
          }] : [],
        };
      },
    });
    day = next;
  }
  return held;
}

function fakeCycles(url: URL, site: FakeWhoop, zone: string, rescore?: { day: string; at: number }): { records: Record<string, unknown>[] } {
  const from = Date.parse(url.searchParams.get("startTime")!);
  const to = Date.parse(url.searchParams.get("endTime")!);
  const limit = Number(url.searchParams.get("limit") ?? "31");
  const overlaps = (start: number, end: number) => start <= to && end >= from;
  const kept = (start: number, end: number) => {
    if (end < from) site.cuts.start++;
    else if (start > to) site.cuts.end++;
    return overlaps(start, end);
  };
  const held = heldCycles(site, zone, site.now, rescore);
  if (held.some((cycle) => cycle.start === from)) site.cuts.spans++;
  const records = held
    .filter((cycle) => overlaps(cycle.start, Math.min(cycle.end, site.now)))
    .slice(0, limit)
    .map((cycle) => cycle.record(site.now, kept));
  return { records: records.reverse() };
}

function fakeSleepEvents(activityId: string, zone: string): Record<string, unknown>[] {
  const day = `${activityId.slice(-8, -4)}-${activityId.slice(-4, -2)}-${activityId.slice(-2)}`;
  return sleepEvents(wallMs(day, "00:00:00", zone));
}

function away(site: FakeWhoop, at: number, zone: string): boolean {
  if (at < wallMs(site.first, "00:30:00", zone)) return true;
  return Object.entries(site.absent).some(([day, days]) => at >= wallMs(day, "00:30:00", zone) && at < wallMs(shiftDay(day, days), "00:30:00", zone));
}

function fakeMetrics(url: URL, site: FakeWhoop, zone: string): { name: string; start: number; values: { time: number; data: number }[] } | null {
  const from = Date.parse(url.searchParams.get("start")!);
  const to = Date.parse(url.searchParams.get("end")!);
  if (to - from > 8 * 86_400_000) return null;
  const stepMs = Number(url.searchParams.get("step") ?? "60") * 1000;
  const values: { time: number; data: number }[] = [];
  for (let at = site.grid === undefined ? Math.ceil(from / stepMs) * stepMs : from + site.grid(from); at <= Math.min(to, site.now); at += stepMs) {
    if (!away(site, at, zone)) values.push({ time: at, data: 50 + (step(at) % 40) });
  }
  return { name: "heart_rate", start: from, values };
}

