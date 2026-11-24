import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withRoadDefaults, type Client, type Connector, type SignIn } from "@lifestreamprotocol/connect";
import { acquirers, connectorsWith, feedersOf } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { releaseFolder } from "./fed.js";

const calendar = releaseFolder("calendar/google");

export const CLIENT_FAKE_FILE = "client-fake.json";

const GOOGLE_API = "https://www.googleapis.com";

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const { port } = JSON.parse(readFileSync(join(folder, CLIENT_FAKE_FILE), "utf8")) as { port: number };
  const fake = `http://127.0.0.1:${port}`;
  const moved = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.origin === GOOGLE_API) return globalThis.fetch(`${fake}/google${url.pathname}${url.search}`, init);
    if (url.origin === fake) return globalThis.fetch(url, init);
    throw new Error(`the client sign-in tests' fetch was asked for ${url.origin}`);
  }) as typeof globalThis.fetch;
  const google: Client = { ...calendar.clients[0]!, authorize: `${fake}/o/oauth2/v2/auth`, token: `${fake}/token` };
  const declared = calendar.connectors[0]!;
  const route = declared.signin![0] as Extract<SignIn, { way: "client" }>;
  const checked = { ...route, check: { ...route.check!, url: `${fake}/google/calendar/v3/calendars/primary` } };
  const connector: Connector = withRoadDefaults({
    ...declared,
    signin: [{ ...checked, id: "gcal-api" }, { ...checked, id: "gcal-again", label: "Sign in with Google again" }],
  });
  const declarations = [connector];
  const factories = { "gcal-api": (each: Parameters<typeof calendar.gcalApiAcquirer>[0]) => calendar.gcalApiAcquirer(each, { fetch: moved }) } as never;
  return {
    connectors: connectorsWith(declarations), readers: [...calendar.readers], feeders: feedersOf(declarations), families: [],
    acquirers: acquirers(declarations, factories, settings, home), signins: {}, clients: [google],
  };
}
