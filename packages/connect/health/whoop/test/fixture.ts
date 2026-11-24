import type { Fixture } from "../../../test/drive.js";
import type { ItemOf, Scenario, Site } from "../../../sdk.js";
import { API, fakeWhoop } from "./fake.js";
import { FAKE_EMAIL, FAKE_PASSWORD, USER, whoopFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "whoop-capture": whoopFixture,
};

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const FIRST_READING_MS = 6 * 3_600_000;
const SCENARIO_ZONE = "UTC";
const METRICS = `/metrics-service/v1/metrics/user/${USER}`;

export const settings = { email: FAKE_EMAIL };
export const secrets: Readonly<Record<string, string>> = { password: FAKE_PASSWORD };

const readingMs = (start_ms: number, n: number) => Math.floor(start_ms / DAY_MS) * DAY_MS + FIRST_READING_MS + n * MINUTE_MS;

export const dated = (scenario: Scenario, n: number): number | null => (scenario.stamped?.[n] === undefined ? readingMs(scenario.start_ms, n) : null);

export function site(scenario: Scenario): Site {
  const whoop = fakeWhoop(SCENARIO_ZONE);
  whoop.now = scenario.start_ms;
  whoop.first = new Date(scenario.start_ms - DAY_MS).toISOString().slice(0, 10);
  whoop.signIn();
  const readings: { time: number; data: number }[] = [];
  for (let n = 0; n < scenario.items; n++) {
    if (!scenario.removed.includes(n)) readings.push({ time: readingMs(scenario.start_ms, n), data: 50 + (n % 40) + (scenario.edited.includes(n) ? 1 : 0) });
  }
  return {
    answer(request) {
      if (request.url.origin !== API || request.url.pathname !== METRICS) return whoop.answer(request);
      const from = Date.parse(request.url.searchParams.get("start")!);
      const to = Date.parse(request.url.searchParams.get("end")!);
      return { status: 200, body: { name: "heart_rate", start: from, values: readings.filter((each) => each.time >= from && each.time <= to) } };
    },
    page: (url) => whoop.page!(url),
    cookies: (origin) => whoop.cookies!(origin),
  };
}

export const item: ItemOf = ({ kind, key }) => {
  const stated = kind === "sample" ? /^hr\d+:(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/u.exec(key) : null;
  if (stated === null) return null;
  const [year, month, day, hour, minute, second] = stated.slice(1).map(Number) as [number, number, number, number, number, number];
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return (ms - Math.floor(ms / DAY_MS) * DAY_MS - FIRST_READING_MS) / MINUTE_MS;
};
