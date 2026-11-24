import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { credentialText, feeds, type Fixture, type ItemOf, type Provider, type Scenario } from "@lifestreamprotocol/connect/sdk";

export const ACCOUNT = "person-a@example.com";
export const SOURCE = `example-oauth:${ACCOUNT}:cloud`;
export const CLIENT = { id: "client-synthetic", secret: "client-secret-synthetic", token: "https://example.com/oauth/token" };
export const settings = { account: ACCOUNT, signin: "example-oauth.signin" };
export const signin = (n: number, expires_ms: number): string => credentialText({
  client_id: CLIENT.id, client_secret: CLIENT.secret, token_endpoint: CLIENT.token,
  refresh_token: `refresh-synthetic-${n}`, access_token: `access-synthetic-${n}`, expires_ms,
});
export const secrets: Readonly<Record<string, string>> = { "example-oauth.signin": signin(1, Date.parse("2100-01-01T00:00:00.000Z")) };
export const EXPIRES_IN = 3_600;
export const PAGE = 10;

const HOUR = 3_600_000;
const SECOND = 1_000;

export interface Note {
  id: string;
  title: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export function note(n: number, created: number, updated = created): Note {
  const edited = updated > created ? ", edited" : "";
  return { id: `note-${n}`, title: `Synthetic note ${n}`, text: `Synthetic text ${n}${edited}.`, created_at: new Date(created).toISOString(), updated_at: new Date(updated).toISOString() };
}

export const editedAt = (scenario: Scenario): number => scenario.start_ms + scenario.items * SECOND;

export function notesOf(scenario: Scenario): Note[] {
  const notes: Note[] = [];
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    notes.push(note(n, createdAt(scenario, n), dated(scenario, n)));
  }
  return notes;
}

export function provider(scenario: Scenario, page = PAGE): Provider {
  const notes = notesOf(scenario).sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));
  return async (request) => {
    const url = new URL(request.url);
    if (url.href === CLIENT.token) return refreshed(request);
    if (!/^Bearer access-synthetic-\d+$/u.test(request.headers.get("authorization") ?? "")) return Response.json({ error: "unauthorized" }, { status: 401 });
    if (url.host !== "api.example.com") return Response.json({ error: "not found" }, { status: 404 });
    if (url.pathname === "/v1/me") return Response.json({ email: ACCOUNT });
    if (url.pathname !== "/v1/notes") return Response.json({ error: "not found" }, { status: 404 });
    const since = Number(url.searchParams.get("updated_since") ?? -Infinity);
    const before = Number(url.searchParams.get("updated_before") ?? Infinity);
    const from = Number(url.searchParams.get("after") ?? 0);
    const matching = notes.filter((each) => Date.parse(each.updated_at) >= since && Date.parse(each.updated_at) < before);
    const next = from + page < matching.length ? String(from + page) : null;
    return Response.json({ notes: matching.slice(from, from + page), next, remaining: Math.max(0, matching.length - from - page) });
  };
}

async function refreshed(request: Request): Promise<Response> {
  const form = new URLSearchParams(await request.text());
  if (request.method !== "POST" || form.get("grant_type") !== "refresh_token") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  if (form.get("client_id") !== CLIENT.id || form.get("client_secret") !== CLIENT.secret) return Response.json({ error: "invalid_client" }, { status: 401 });
  const n = /^refresh-synthetic-(\d+)$/u.exec(form.get("refresh_token") ?? "")?.[1];
  if (n === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
  const next = Number(n) + 1;
  return Response.json({ access_token: `access-synthetic-${next}`, refresh_token: `refresh-synthetic-${next}`, token_type: "Bearer", expires_in: EXPIRES_IN });
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old) * SECOND);

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? editedAt(scenario) : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^note-(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};

const SAMPLE: Scenario = { items: 2, old: 2, edited: [], removed: [], start_ms: Date.parse("2026-09-10T12:00:00.000Z") };

export const fixture: Fixture = (folder) => {
  mkdirSync(join(folder, "notes"));
  for (const each of notesOf(SAMPLE)) writeFileSync(join(folder, "notes", `${each.id}.json`), JSON.stringify(each));
  return {
    source: SOURCE,
    facts: { fetched_at: new Date(SAMPLE.start_ms).toISOString(), ...feeds(SOURCE, "example-oauth") },
    files: Object.fromEntries(notesOf(SAMPLE).map((each) => [`notes/${each.id}.json`, { alone: [`note ${each.id}`] }])),
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-oauth": fixture };
