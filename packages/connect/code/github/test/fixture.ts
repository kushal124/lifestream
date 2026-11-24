import type { Fixture } from "../../../test/drive.js";
import type { ItemOf, Provider, Scenario } from "../../../sdk.js";
import { githubFixture, issue, LOGIN, user } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "github-api": githubFixture,
};

const TOKEN = "token-synthetic";
const API = "https://api.github.com";
const HOUR = 3_600_000;
const SECOND = 1_000;
const PAGE = 100;

export const settings = { login: LOGIN };
export const secrets: Readonly<Record<string, string>> = { token: TOKEN };

const stamp = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z");

function issuesOf(scenario: Scenario) {
  const issues = [];
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    issues.push({ ...issue(`I_fake${n}`, LOGIN, stamp(createdAt(scenario, n)), { number: n + 1, title: `synthetic issue ${n}${scenario.edited.includes(n) ? ", edited" : ""}` }), id: 9000 + n, updated_at: stamp(dated(scenario, n)) });
  }
  return issues.sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : a.id - b.id));
}

export function provider(scenario: Scenario): Provider {
  const issues = issuesOf(scenario);
  const answer = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "0", ...headers } });
  return (request) => {
    const url = new URL(request.url);
    if (url.origin !== API) return answer({ message: "Not Found" }, 404);
    if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) return answer({ message: "Bad credentials" }, 401);
    if (url.pathname === "/user") return answer(user(LOGIN));
    if (url.pathname === "/user/repos" || url.pathname.endsWith("/comments")) return answer([]);
    if (url.pathname !== "/issues") return answer({ message: "Not Found" }, 404);
    const since = url.searchParams.get("since");
    const listed = issues.filter((each) => since === null || each.updated_at >= since);
    const page = Number(url.searchParams.get("page") ?? "1");
    const headers: Record<string, string> = {};
    if (page * PAGE < listed.length) {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      headers.link = `<${next.href}>; rel="next"`;
    }
    return answer(listed.slice((page - 1) * PAGE, page * PAGE), 200, headers);
  };
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? scenario.start_ms + (scenario.items + 1) * SECOND : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^I_fake(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
