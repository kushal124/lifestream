import type { JsonObject, Secrets } from "@lifestreamprotocol/core";
import { NeedsYou, NotYet } from "../seams.js";
import { credentialText, oauthCredential, oauthFresh, type OAuthCredential, type Refresher } from "./oauth.js";

/** Why `request` came back with no response to read. */
export type Stop =
  | {
    /** The provider refused the sign-in after one renewal, or the home holds no usable sign-in. */
    stop: "signed-out";
    /** False when the home holds no usable sign-in, rather than the provider refusing one. */
    answered?: false;
  }
  | {
    /** The provider is limiting requests. */
    stop: "limit";
    /** The instant, in Unix milliseconds, before which the provider takes no request. */
    retry_ms: number;
  }
  | {
    /** The call has spent its budget, so the request was not sent. */
    stop: "budget";
  };

/** The requests one call may still make, shared by every request of the call. */
export interface Budget {
  /** How many requests remain, which each request lowers by one, down to zero. */
  left: number;
  /** While true, a request is sent even with none left, so a unit of work already begun can finish. */
  pass?: boolean;
}

/** How `request` sends: the call's budget, the provider's limit rule, the transport and clock, and the sign-in it carries. */
export type RequestOptions = {
  /** The call's budget, which each request spends; without one, requests are not counted. */
  budget?: Budget;
  /** The provider's own reading of a limited answer beyond a 429, giving the instant it takes requests again, or null for an answer that is not limited. */
  limited?: (response: Response, now_ms: number) => number | null;
  /** The fetch that sends the request, the global `fetch` when absent. */
  fetch?: typeof globalThis.fetch;
  /** The clock, in Unix milliseconds, `Date.now` when absent. */
  now?: () => number;
  /** Aborts the request and its renewals, which otherwise give up after 60 seconds. */
  signal?: AbortSignal;
} & (
  | {
    /** Without a refresher the request carries no bearer token. */
    refresher?: undefined;
  }
  | {
    /** Renews the sealed OAuth credential when it is about to expire and once after a 401. */
    refresher: Refresher;
    /** The vault the credential is read from and a renewed one is rotated into. */
    secrets: Secrets;
    /** The name the credential is sealed under in the vault. */
    secret: string;
  }
);

export const LIMIT_MS = 60_000;
const TIMEOUT_MS = 60_000;

/** Sends one request, spending the budget and carrying the sealed sign-in as its bearer token, and returns the response or the stop that kept it from being read. */
export async function request(url: string | URL, init: RequestInit, options: RequestOptions): Promise<Response | Stop> {
  if (options.budget !== undefined) {
    if (options.budget.left <= 0 && options.budget.pass !== true) return { stop: "budget" };
    options.budget.left = Math.max(0, options.budget.left - 1);
  }
  const now = options.now ?? Date.now;
  const transport = options.fetch ?? globalThis.fetch;
  const send = (bearer: string | undefined) => transport(url, {
    ...init,
    headers: { ...headersOf(init.headers), ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }) },
    signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });
  const signed = options.refresher === undefined ? undefined : options;
  let credential: OAuthCredential | undefined;
  if (signed !== undefined) {
    const held = await signedOut(() => keep(signed, oauthCredential(signed.secrets.get(signed.secret) ?? "", signed.secret), (each) => oauthFresh(each, signed.refresher, dependencies(signed))));
    if (isStop(held)) return held;
    credential = held;
  }
  let response = await send(credential?.access_token);
  if (response.status === 401 && signed !== undefined && credential !== undefined) {
    await response.body?.cancel();
    const held = credential;
    const renewed = await signedOut(() => keep(signed, held, (each) => signed.refresher(each, dependencies(signed))));
    if (isStop(renewed)) return renewed;
    response = await send(renewed.access_token);
  }
  if (response.status === 401) {
    await response.body?.cancel();
    return { stop: "signed-out" };
  }
  const limit = options.limited?.(response, now()) ?? (response.status === 429 ? retryAfter(response, now()) ?? now() + LIMIT_MS : null);
  if (limit !== null) {
    await response.body?.cancel();
    return { stop: "limit", retry_ms: limit };
  }
  return response;
}

/** Whether an answer is a stop rather than the value asked for. */
export function isStop<T extends object>(answer: T | Stop): answer is Stop {
  return typeof (answer as Partial<Stop>).stop === "string";
}

/** The error that carries a stop out of code that expects a response, thrown by `answered`. */
export class Stopped extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "Stopped";
  }

  constructor(
    /** The stop the request met. */
    readonly stop: Stop,
  ) {
    super(`stopped: ${stop.stop}`);
    this.name = "Stopped";
  }
}

/** Returns the response, or throws the stop as `Stopped`. */
export function answered(answer: Response | Stop): Response {
  if (isStop(answer)) throw new Stopped(answer);
  return answer;
}

/** Turns the stop a call met into its ending: when the call read nothing to seal it throws NotYet for a limit or NeedsYou for a lost sign-in, and otherwise it returns the limit's wait, or that another call is due. */
export function afterStop(stop: Stop | undefined, somethingToSeal: boolean, state: JsonObject | undefined, provider: string): { more?: true; backoff_ms?: number } {
  if (stop === undefined) return {};
  const kept = state === undefined ? {} : { state };
  if (stop.stop === "limit") {
    if (!somethingToSeal) throw new NotYet("provider-limit", `${provider} is limiting requests`, { ...kept, backoff_ms: stop.retry_ms });
    return { backoff_ms: stop.retry_ms };
  }
  if (stop.stop === "signed-out" && !somethingToSeal) {
    if (stop.answered === false) throw new NeedsYou("signed-out", `no ${provider} sign-in is sealed`, { ...kept, answered: false });
    throw new NeedsYou("signed-out", `${provider} no longer accepts this sign-in`, kept);
  }
  return { more: true };
}

async function signedOut(read: () => Promise<OAuthCredential>): Promise<OAuthCredential | Stop> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NeedsYou && error.reason === "signed-out") return error.answered === false ? { stop: "signed-out", answered: false } : { stop: "signed-out" };
    throw error;
  }
}

async function keep(options: { secrets: Secrets; secret: string }, held: OAuthCredential, renew: (held: OAuthCredential) => Promise<OAuthCredential>): Promise<OAuthCredential> {
  const fresh = await renew(held);
  if (fresh !== held) options.secrets.rotate(options.secret, credentialText(fresh));
  return fresh;
}

function dependencies(options: RequestOptions) {
  return { signal: options.signal ?? AbortSignal.timeout(TIMEOUT_MS), ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.now === undefined ? {} : { now: options.now }) };
}

function headersOf(headers: RequestInit["headers"]): Record<string, string> {
  return headers === undefined ? {} : Object.fromEntries(new Headers(headers).entries());
}

/** The instant, in Unix milliseconds, that a response's `Retry-After` header names as seconds or as a date, or undefined when it names none. */
export function retryAfter(response: Response, now_ms: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (/^\d+$/u.test(value)) return now_ms + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(date, now_ms) : undefined;
}
