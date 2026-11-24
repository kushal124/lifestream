import { credentialText, rfc3339, type Files, type ItemOf, type Provider, type Scenario } from "@lifestreamprotocol/connect/sdk";
import { PAGE } from "../acquirers.js";

export const KEY = "key-synthetic";
export const TOKEN = "https://auth.example.com/oauth/token";
const CLIENT = { id: "client-synthetic", secret: "client-secret-synthetic" };
const HOUR = 3_600_000;

export const secrets: Readonly<Record<string, string>> = {
  key: KEY,
  signin: credentialText({
    client_id: CLIENT.id, client_secret: CLIENT.secret, token_endpoint: TOKEN, refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1",
    expires_ms: Date.parse("2100-01-01T00:00:00.000Z"),
  }),
};

interface Note {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export function notesOf(scenario: Scenario): Note[] {
  const removed = new Set(scenario.removed);
  const edited = new Set(scenario.edited);
  return Array.from({ length: scenario.items }, (_, n) => n).filter((n) => !removed.has(n)).map((n) => {
    const created = rfc3339(createdAt(scenario, n));
    const updated = rfc3339(dated(scenario, n));
    return { id: `note-${String(n).padStart(4, "0")}`, title: `Synthetic note ${n}${edited.has(n) ? " (edited)" : ""}`, created_at: created, updated_at: updated };
  });
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? scenario.start_ms + (n - scenario.old) * HOUR;

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? scenario.start_ms + scenario.items * HOUR : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^note-(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};

export function provider(scenario: Scenario): Provider {
  const notes = notesOf(scenario).sort((left, right) => left.updated_at.localeCompare(right.updated_at) || left.id.localeCompare(right.id));
  return async (asked) => {
    const url = new URL(asked.url);
    if (`${url.origin}${url.pathname}` === TOKEN) return refreshed(asked);
    const authorization = asked.headers.get("authorization");
    if (authorization !== null && authorization !== `Bearer ${KEY}` && !/^Bearer access-synthetic-\d+$/u.test(authorization)) return Response.json({}, { status: 401 });
    if (url.pathname !== "/v1/notes") return Response.json({}, { status: 404 });
    const since = Number(url.searchParams.get("updated_since") ?? -Infinity);
    const before = Number(url.searchParams.get("updated_before") ?? Infinity);
    const from = Number(url.searchParams.get("after") ?? 0);
    const matching = notes.filter((note) => Date.parse(note.updated_at) >= since && Date.parse(note.updated_at) < before);
    const next = from + PAGE < matching.length ? String(from + PAGE) : null;
    return Response.json({ notes: matching.slice(from, from + PAGE), next, remaining: Math.max(0, matching.length - from - PAGE) });
  };
}

async function refreshed(asked: Request): Promise<Response> {
  const form = new URLSearchParams(await asked.text());
  if (form.get("grant_type") !== "refresh_token" || form.get("client_id") !== CLIENT.id || form.get("client_secret") !== CLIENT.secret) return Response.json({ error: "invalid_client" }, { status: 401 });
  const n = /^refresh-synthetic-(\d+)$/u.exec(form.get("refresh_token") ?? "")?.[1];
  if (n === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
  return Response.json({ access_token: `access-synthetic-${Number(n) + 1}`, refresh_token: `refresh-synthetic-${Number(n) + 1}`, token_type: "Bearer", expires_in: 3_600 });
}

export function files(scenario: Scenario): Files {
  return Object.fromEntries(notesOf(scenario).map((note) => [`notes/${note.id}.json`, JSON.stringify(note)]));
}

export const fixtures = {};
