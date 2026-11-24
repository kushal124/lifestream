import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture, ItemOf, Scenario, Site, SiteAnswer, SiteRequest } from "@lifestreamprotocol/connect/sdk";

export const ACCOUNT = "user-0001";
export const EMAIL = "person-a@example.com";
export const SOURCE = `example:${ACCOUNT}:browser`;
export const settings = {};
export const secrets: Readonly<Record<string, string>> = {};

const HOUR = 3_600_000;
const SECOND = 1_000;

export interface SiteNote {
  id: string;
  title: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export const note = (n: number, created_at: string, updated_at = created_at): SiteNote => ({
  id: `note-${String(n).padStart(3, "0")}`, title: `Synthetic note ${n}`, text: `Synthetic text ${n}${updated_at > created_at ? ", edited" : ""}.`, created_at, updated_at,
});

export const editedAt = (scenario: Scenario): number => scenario.start_ms + scenario.items * SECOND;

export function notesOf(scenario: Scenario): SiteNote[] {
  const notes: SiteNote[] = [];
  for (let n = 0; n < scenario.items; n++) {
    if (scenario.removed.includes(n)) continue;
    notes.push(note(n, new Date(createdAt(scenario, n)).toISOString(), new Date(dated(scenario, n)).toISOString()));
  }
  return notes;
}

export class ExampleBrowserSite implements Site {
  signedOut = false;
  notes: SiteNote[] = [note(1, "2026-09-04T10:00:00.000Z"), note(2, "2026-09-05T10:00:00.000Z", "2026-09-06T10:00:00.000Z")];

  answer({ url }: SiteRequest): SiteAnswer {
    if (this.signedOut) return { status: 401, body: { error: "signed out" } };
    if (url.pathname === "/api/me") return { status: 200, body: { id: ACCOUNT, email: EMAIL } };
    if (url.pathname === "/api/notes") {
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      const listed = [...this.notes].sort((left, right) => right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id)).slice(offset, offset + limit);
      return { status: 200, body: { items: listed.map((each) => ({ id: each.id, updated_at: each.updated_at })) } };
    }
    const one = this.notes.find((each) => url.pathname === `/api/notes/${each.id}`);
    return one === undefined ? { status: 404, body: { error: "not found" } } : { status: 200, body: one };
  }
}

export function site(scenario: Scenario): Site {
  const site = new ExampleBrowserSite();
  site.notes = notesOf(scenario);
  return site;
}

const createdAt = (scenario: Scenario, n: number): number => scenario.stamped?.[n] ?? (n < scenario.old ? scenario.start_ms - (scenario.old - n) * HOUR : scenario.start_ms + (n - scenario.old) * SECOND);

export const dated = (scenario: Scenario, n: number): number => (scenario.edited.includes(n) ? editedAt(scenario) : createdAt(scenario, n));

export const item: ItemOf = ({ key }) => {
  const n = /^note-(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};

export const fixture: Fixture = (folder) => {
  const { notes } = new ExampleBrowserSite();
  mkdirSync(join(folder, "notes"));
  writeFileSync(join(folder, "account.json"), JSON.stringify({ id: ACCOUNT, email: EMAIL }));
  for (const each of notes) writeFileSync(join(folder, "notes", `${each.id}.json`), JSON.stringify(each));
  return {
    source: SOURCE, facts: { fetched_at: "2026-09-10T12:00:00.000Z" },
    files: { "account.json": "trust", ...Object.fromEntries(notes.map((each) => [`notes/${each.id}.json`, { alone: [`note ${each.id}`] }])) },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-browser": fixture };
