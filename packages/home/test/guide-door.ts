import type { IncomingMessage } from "node:http";
import type { DaySettings, Json } from "@lifestreamprotocol/core";
import { defaultAccess } from "../access.js";
import { openPersonAccess, type AddressAsked, type Asker, type KeyAsked, type ReaderEntry } from "../access-routes.js";
import { ADDRESS_NOT_READY } from "../access-words.js";
import type { SignInAnswer, SignInHeld } from "../agents.js";
import type { PublicState } from "../funnel.js";
import { Refusal, refuse } from "../refusal.js";

export const ORIGIN = "https://macbook-pro-0001.tail0000.ts.net";
export const DOWNLOAD = "https://tailscale.com/download/mac";
export const ENABLE = "https://login.tailscale.com/f/funnel?node=nFAKE0001";
const NOW = Date.UTC(2026, 10, 14, 9, 0);
const DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };
const PASS = "synthetic-pass-0001";

export const SIGN_IN = "c2lnbi1pbi0wMDAwMDAwMQ";
const ALLOWED: SignInAnswer = { state: "approved", name: "ChatGPT", at_ms: NOW - 60_000, device: "p-phone001" };
const CONNECTED: SignInHeld = { answered: ALLOWED, granted: { reader: "p-0000dddd", access: defaultAccess() } };

export const READERS: ReaderEntry[] = [
  { id: "p-0000aaaa", name: "ChatGPT", kind: "agent", how: "", via: "sign-in", from: "chatgpt.com", app: null, anywhere: false, made_ms: NOW - 3 * 60_000, disconnected_ms: null, listed: true },
  { id: "p-0000bbbb", name: "Example tool", kind: "agent", how: "", via: "pass", from: null, app: null, anywhere: false, made_ms: NOW - 2 * 60_000, disconnected_ms: null, listed: true },
  { id: "p-0000cccc", name: "Instinct", kind: "agent", how: "", via: "pass", from: null, app: "instinct", anywhere: true, made_ms: NOW - 60_000, disconnected_ms: null, listed: true },
  { id: "p-0000eeee", name: "Grok Bot", kind: "agent", how: "", via: "pass", from: null, app: "grok-bot", anywhere: true, made_ms: NOW - 60_000, disconnected_ms: NOW, listed: true },
];

export function routes(state: PublicState, origin: string | null = ORIGIN, held: SignInHeld | null = null, readers: readonly ReaderEntry[] = READERS) {
  const asked: { address: (AddressAsked | null)[]; keys: KeyAsked[] } = { address: [], keys: [] };
  const person = openPersonAccess({
    writer: { person: async <T>() => ({}) as T },
    signIns: {
      waiting: async () => ({ requests: [] }),
      read: async () => held ?? refuse(404, "AGENT_REQUEST_GONE", "This sign-in is over. Start it again in the app."),
      answer: async () => (held?.answered ? { ...held.answered, granted: held.granted } : refuse(404, "AGENT_REQUEST_GONE", "This sign-in is over. Start it again in the app.")),
    },
    offered: async () => [], readers: () => readers, disconnect: async () => undefined, describe: async () => ({ described: [] }), device: (pass) => (pass === "p-phone001" ? "iPhone" : null), clock: () => NOW, day: () => DAY,
    address: async (sent) => {
      asked.address.push(sent);
      return state;
    },
    key: async (key) => {
      asked.keys.push(key);
      if (key.app !== "another" && origin === null) refuse(409, "ADDRESS_NOT_READY", ADDRESS_NOT_READY);
      return { reader: "p-0000cccc", name: key.app === "another" ? key.name! : key.app === "grok-bot" ? "Grok Bot" : "Instinct", pass: PASS, origin };
    },
  });
  return { person, asked };
}

export function as(kind: "phone" | "mac", over: Partial<Asker> = {}): Asker {
  return { pass: { id: kind === "phone" ? "p-phone001" : "p-mac00001", kind }, ask: false, widen: true, ...over } as unknown as Asker;
}

export async function serve(person: ReturnType<typeof routes>["person"], asker: Asker, method: "GET" | "POST", path: string, body: Json = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    return { status: 200, body: (await person.serve(asker, { method } as IncomingMessage, new URL(`http://home${path}`), async () => body as never))[1] as Record<string, unknown> };
  } catch (error) {
    if (error instanceof Refusal) return { status: error.status, body: { code: error.code, message: error.words } };
    throw error;
  }
}

export function blocked(why: string, open: string | null = null): PublicState {
  return { state: "blocked", origin: null, why, open };
}

export async function guideDoorReplies(): Promise<{ name: string; written: unknown }[]> {
  const access = defaultAccess() as unknown as Json;
  const on: PublicState = { state: "on", origin: ORIGIN, why: null, open: null };
  const noTailscale = blocked("Install Tailscale on this Mac", DOWNLOAD);
  const cases: [string, PublicState, string | null, Asker, "GET" | "POST", string, Json | null, (SignInHeld | null)?, ReaderEntry[]?][] = [
    ["address-on", on, ORIGIN, as("mac"), "GET", "/v1/agents/address", null],
    ["address-off", { state: "off", origin: ORIGIN, why: null, open: null }, null, as("mac"), "GET", "/v1/agents/address", null],
    ["address-fix-turn-on", blocked("Allow Funnel in Tailscale"), null, as("mac"), "GET", "/v1/agents/address", null],
    ["address-fix-allow", blocked("Allow Funnel in Tailscale", ENABLE), null, as("phone"), "POST", "/v1/agents/address", { on: true }],
    ["address-fix-mac", noTailscale, null, as("mac"), "GET", "/v1/agents/address", null],
    ["address-fix-phone", noTailscale, null, as("phone"), "GET", "/v1/agents/address", null],
    ["address-fix-other", blocked("Tailscale did not answer: spawn EACCES"), null, as("phone"), "GET", "/v1/agents/address", null],
    ["address-person-only", on, ORIGIN, as("mac", { ask: true, widen: false }), "POST", "/v1/agents/address", { on: true }],
    ["address-bad", on, ORIGIN, as("mac"), "POST", "/v1/agents/address", { on: "yes" }],
    ["keys-grok-bot", on, ORIGIN, as("mac"), "POST", "/v1/agents/keys", { app: "grok-bot", access }],
    ["keys-instinct", on, ORIGIN, as("phone"), "POST", "/v1/agents/keys", { app: "instinct", access }],
    ["keys-another", on, ORIGIN, as("mac"), "POST", "/v1/agents/keys", { app: "another", name: "Example tool", access }],
    ["keys-another-loopback", noTailscale, null, as("mac"), "POST", "/v1/agents/keys", { app: "another", name: "Example tool", access }],
    ["keys-not-ready", blocked("Allow Funnel in Tailscale"), null, as("phone"), "POST", "/v1/agents/keys", { app: "instinct", access }],
    ["keys-phone-refused", on, ORIGIN, as("phone"), "POST", "/v1/agents/keys", { app: "grok-bot", access }],
    ["keys-bad", on, ORIGIN, as("mac"), "POST", "/v1/agents/keys", { app: "another", access }],
    ["edit-key", on, ORIGIN, as("phone"), "POST", "/v1/agents/edit", { target: { key: "instinct" }, access, expect: null, edit: { type: "health", on: true } }],
    ["signin-finishing", on, ORIGIN, as("mac"), "GET", `/v1/agents/signins/${SIGN_IN}`, null, { answered: ALLOWED, granted: null }],
    ["signin-connected", on, ORIGIN, as("mac"), "GET", `/v1/agents/signins/${SIGN_IN}`, null, CONNECTED],
    ["signin-gone", on, ORIGIN, as("phone"), "GET", `/v1/agents/signins/${SIGN_IN}`, null],
    ["answer-connected", on, ORIGIN, as("phone"), "POST", "/v1/agents/answer", { id: SIGN_IN, answer: "482915" }, CONNECTED],
    ["address-on-reader", on, ORIGIN, as("mac"), "POST", "/v1/agents/address", { on: true, reader: "p-0000bbbb" }],
    ["address-reader-phone", on, ORIGIN, as("phone"), "POST", "/v1/agents/address", { on: true, reader: "p-0000bbbb" }],
    ["address-reader-sign-in", on, ORIGIN, as("mac"), "POST", "/v1/agents/address", { on: true, reader: "p-0000aaaa" }],
  ];
  const replies: { name: string; written: unknown }[] = [];
  for (const [name, state, origin, asker, method, path, request, held = null, readers = READERS] of cases) {
    const answer = await serve(routes(state, origin, held, readers).person, asker, method, path, request ?? {});
    replies.push({ name, written: { route: `${method} ${path.replace(SIGN_IN, "<id>")}`, request, status: answer.status, answer: answer.body } });
  }
  return replies;
}
