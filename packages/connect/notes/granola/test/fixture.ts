import type { Fixture } from "../../../test/drive.js";
import type { ItemOf, Provider, Scenario } from "../../../sdk.js";
import { fakeGranola } from "./fake.js";
import { ACCOUNT, granolaFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "granola": granolaFixture,
};

const KEY = "key-synthetic";
const ACCESS_UNTIL = Date.UTC(2030, 0, 1);
const HOUR = 3_600_000;
const SECOND = 1_000;
const pad = (n: number, width: number) => String(n).padStart(width, "0");
const uuidOf = (n: number) => `${pad(n, 8)}-aaaa-4bbb-8ccc-${pad(n, 12)}`;

export const settings = { account: ACCOUNT };
export const secrets: Readonly<Record<string, string>> = {
  key: KEY,
  signin: JSON.stringify({ client_id: "client-synthetic-1", refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: ACCESS_UNTIL }),
};

export function provider(scenario: Scenario): Provider {
  const world = fakeGranola(ACCOUNT, KEY);
  world.clock = scenario.start_ms;
  world.plan = "business";
  world.signin(ACCESS_UNTIL);
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    const created = dated(scenario, n);
    const edited = scenario.edited.includes(n);
    const updated = edited ? scenario.start_ms + (scenario.items + 1) * SECOND : created;
    world.note({
      id: `not_${pad(n, 14)}`, uuid: uuidOf(n), title: `Synthetic meeting ${n}${edited ? ", edited" : ""}`,
      created_at: new Date(created).toISOString(), updated_at: new Date(updated).toISOString(), summary: `### Synthetic summary ${n}\n- a point`,
    });
  }
  return async (request) => world.fetch(request.url, { method: request.method, headers: request.headers, ...(request.method === "GET" ? {} : { body: await request.text() }) });
}

export const dated = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export const item: ItemOf = ({ key }) => {
  const n = /^\d{8}-aaaa-4bbb-8ccc-(\d{12})$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
