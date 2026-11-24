import type { Fixture } from "../../../test/drive.js";
import { credentialText, type ItemOf, type Provider, type Scenario } from "../../../sdk.js";
import { ACCOUNT, apiFixture, exportFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "gcal-api": apiFixture,
  "gcal-export": exportFixture,
};

const CLIENT = { id: "client-synthetic", secret: "client-secret-synthetic", token: "https://oauth2.googleapis.com/token" };
const CALENDARS = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const HOUR = 3_600_000;
const SECOND = 1_000;

export const settings = { account: ACCOUNT };
export const secrets: Readonly<Record<string, string>> = {
  signin: credentialText({
    client_id: CLIENT.id, client_secret: CLIENT.secret, token_endpoint: CLIENT.token,
    refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: Date.parse("2100-01-01T00:00:00.000Z"),
  }),
};

function eventsOf(scenario: Scenario) {
  const events = [];
  for (let n = 0; n < scenario.items; n++) {
    const created = dated(scenario, n);
    const id = `evt${String(n).padStart(4, "0")}`;
    if (scenario.removed.includes(n)) {
      events.push({ kind: "calendar#event", id, status: "cancelled", updated: new Date(scenario.start_ms + (scenario.items + 2) * SECOND).toISOString() });
      continue;
    }
    const edited = scenario.edited.includes(n);
    const updated = edited ? scenario.start_ms + (scenario.items + 1) * SECOND : created;
    events.push({
      kind: "calendar#event", id, status: "confirmed", iCalUID: `${id}@google.com`, summary: `Synthetic event ${n}${edited ? ", edited" : ""}`,
      created: new Date(created).toISOString(), updated: new Date(updated).toISOString(), sequence: edited ? 1 : 0,
      organizer: { email: ACCOUNT, self: true },
      start: { dateTime: new Date(created).toISOString() }, end: { dateTime: new Date(created + HOUR).toISOString() },
    });
  }
  return events;
}

export function provider(scenario: Scenario): Provider {
  const events = eventsOf(scenario);
  return async (request) => {
    const url = new URL(request.url);
    if (url.href === CLIENT.token) return refreshed(request);
    if (!/^Bearer access-synthetic-\d+$/u.test(request.headers.get("authorization") ?? "")) return Response.json({ error: { code: 401 } }, { status: 401 });
    if (`${url.origin}${url.pathname}` === CALENDARS) return Response.json({ kind: "calendar#calendarList", items: [{ id: "primary", accessRole: "owner" }] });
    if (`${url.origin}${url.pathname}` !== EVENTS) return Response.json({ error: { code: 404 } }, { status: 404 });
    const token = url.searchParams.get("syncToken");
    const held = token === null ? null : /^sync-(\d+)-(\d+)$/u.exec(token);
    if (token !== null && held === null) return Response.json({ error: { code: 410 } }, { status: 410 });
    const since = held === null ? null : { ms: Number(held[1]), listed: Number(held[2]) };
    const ordered = [...events].sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated) || (a.id < b.id ? -1 : 1));
    const atNewest = (ms: number) => ordered.filter((each) => Date.parse(each.updated) === ms);
    const listed = since === null ? ordered : ordered.filter((each) => Date.parse(each.updated) > since.ms || (Date.parse(each.updated) === since.ms && atNewest(since.ms).indexOf(each) >= since.listed));
    const newest = Math.max(since?.ms ?? 0, ...events.map((each) => Date.parse(each.updated)));
    return Response.json({ kind: "calendar#events", items: listed, nextSyncToken: `sync-${newest}-${atNewest(newest).length}` });
  };
}

async function refreshed(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  if (request.method !== "POST" || form.get("grant_type") !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  if (form.get("client_id") !== CLIENT.id || form.get("client_secret") !== CLIENT.secret) return Response.json({ error: "invalid_client" }, { status: 401 });
  const n = /^refresh-synthetic-(\d+)$/u.exec(form.get("refresh_token") ?? "")?.[1];
  if (n === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const next = Number(n) + 1;
  return Response.json({ access_token: `access-synthetic-${next}`, refresh_token: `refresh-synthetic-${next}`, token_type: "Bearer", expires_in: 3_600 });
}

export const dated = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old + 1) * SECOND);

export const item: ItemOf = ({ key }) => {
  const n = /^evt(\d{4})@google\.com$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
