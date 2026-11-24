import { BelowFloor, PassRefused, Superseded, type Link } from "./station.js";
import { ACTS, type ExchangeAnswer, type FileRef, type HomeNamed, type Result, type StationInfo } from "./wire.js";

export interface Pairing {
  readonly url: string;
  readonly pass: string;
}

export interface LinkOptions {
  readonly version: string;
  readonly fetch?: typeof fetch;
  readonly before?: () => Promise<unknown>;
}

const device = (version: string): Record<string, string> => ({ "lifestream-device": `extension/${version}` });

interface Refused {
  readonly code?: string;
  readonly message?: string;
  readonly floor?: unknown;
}

async function refused(response: Response, on?: "exchange"): Promise<never> {
  const body = await response.text().catch(() => "");
  let parsed: Refused | null = null;
  try {
    parsed = JSON.parse(body) as Refused;
  } catch {
  }
  if (response.status === 426) throw new BelowFloor(String(parsed?.floor ?? "a newer version"));
  if (response.status === 409 && parsed?.code === "SUPERSEDED") throw new Superseded(parsed.message ?? "a later start of this station serves its pairing");
  const said = parsed === null ? body.slice(0, 200) : `${parsed.code ?? response.status}: ${parsed.message ?? ""}`;
  if (on === "exchange" && response.status === 401) throw new PassRefused(`the home refused this station's pass (${said})`);
  throw new Error(`the home answered ${response.status} (${said})`);
}

async function act(fetching: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  if (!passMayGo(url)) throw new PlainHttp(PLAIN_WORDS);
  const send = unredirected(fetching);
  const response = await send(url, init);
  if (response.status !== 503) return response;
  const said = (await Promise.resolve().then(() => response.clone().json()).catch(() => null)) as { code?: unknown; again?: unknown } | null;
  return said?.code === "OUTCOME_UNKNOWN" && said.again === true ? send(url, init) : response;
}

function unredirected(send: typeof fetch): typeof fetch {
  return (url, init) => send(url, { ...init, redirect: "error" });
}

export class PlainHttp extends Error {}

export function plainReaches(host: string): boolean {
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return true;
  const octets = host.split(".");
  if (octets.length !== 4 || !octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)) return false;
  return Number(octets[0]) === 100 && Number(octets[1]) >= 64 && Number(octets[1]) <= 127;
}

const PLAIN_WORDS = "Type your Mac’s Tailscale address, which starts with 100., or an address that starts with https://. Its name on this Wi-Fi would send the pairing code unprotected.";

export function passMayGo(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  return parsed.protocol === "https:" || (parsed.protocol === "http:" && plainReaches(parsed.hostname));
}

export function doorUrl(typed: string): string {
  const trimmed = typed.trim().replace(/\/+$/u, "");
  const url = new URL(/^[a-z]+:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`not a web address: ${url.protocol}`);
  if (url.username !== "" || url.password !== "") throw new Error("a door's address names no user");
  if (url.protocol === "http:" && !plainReaches(url.hostname)) throw new PlainHttp(PLAIN_WORDS);
  if (url.protocol === "http:" && url.port === "") url.port = "4680";
  return url.origin;
}

export function onThisMac(door: string): boolean {
  const host = new URL(door).hostname;
  return host === "127.0.0.1" || host === "localhost";
}

export function doorPermission(door: string): string | null {
  const url = new URL(door);
  return onThisMac(door) ? null : `${url.protocol}//${url.hostname}/*`;
}

export function newPass(): string {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

export async function pair(base: string, code: string, unit: string, options: Omit<LinkOptions, "before">): Promise<{ pairing: Pairing; unit: string }> {
  const send = options.fetch ?? fetch;
  const pass = newPass();
  const response = await act(send, `${base}/v1/pair`, {
    method: "POST",
    headers: { ...device(options.version), "content-type": "application/json" },
    body: JSON.stringify({ code: code.trim(), pass, kind: "extension", model: "Chrome", unit }),
  });
  if (!response.ok) return refused(response);
  const answer = (await response.json()) as { unit?: unknown };
  return { pairing: { url: base, pass }, unit: typeof answer.unit === "string" ? answer.unit : unit };
}

export type Asked = "waiting" | "absent" | { readonly says: string };

export interface Connected {
  readonly pairing: Pairing;
  readonly unit: string;
}

export async function ask(base: string, pass: string, unit: string, options: Omit<LinkOptions, "before">): Promise<Connected | Asked> {
  const send = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await act(send, `${base}/v1/pair`, {
      method: "POST",
      headers: { ...device(options.version), "content-type": "application/json" },
      body: JSON.stringify({ connect: true, pass, kind: "extension", unit }),
    });
  } catch {
    return "absent";
  }
  const answer = (await response.json().catch(() => ({}))) as { unit?: unknown; message?: unknown };
  if (response.status === 200) return { pairing: { url: base, pass }, unit: typeof answer.unit === "string" ? answer.unit : unit };
  if (response.status === 202) return "waiting";
  return typeof answer.message === "string" && answer.message !== "" ? { says: answer.message } : "absent";
}

function answerOf(body: unknown): ExchangeAnswer {
  const answer = body as Partial<Record<keyof ExchangeAnswer, unknown>> | null;
  const home = answer?.home as Partial<Record<keyof HomeNamed, unknown>> | undefined;
  const lists = answer !== null && [answer.calls, answer.needs, answer.sites, answer.chosen].every(Array.isArray);
  if (!lists || typeof home?.version !== "string" || !(typeof home.generation === "number" || home.generation === null)
    || !(answer!.chosen as unknown[]).every((id) => typeof id === "string")) {
    throw new Error("the home's answer to an exchange is not of its shape");
  }
  const { calls, needs, sites, chosen, reload } = answer as ExchangeAnswer;
  if (!needs.every((need) => typeof need?.id === "string" && typeof need.words === "string" && Array.isArray(need.acts))) {
    throw new Error("the home's answer to an exchange is not of its shape");
  }
  const taken = needs.map((need) => ({ ...need, acts: need.acts.filter((act) => ACTS.includes(act.do)) }));
  return { home: { version: home.version, generation: home.generation }, calls, needs: taken, sites, chosen, ...(reload === true ? { reload } : {}) };
}

export function httpLink(pairing: Pairing, options: LinkOptions): Link {
  const send = unredirected(options.fetch ?? fetch);
  const base = pairing.url.replace(/\/+$/u, "");
  const headers = { authorization: `Bearer ${pairing.pass}`, ...device(options.version) };
  const allowed = passMayGo(base);
  const unsent = `this station's pairing names ${base}, where the pass would cross the network in clear: pair it again`;

  return {
    async exchange(station: StationInfo, results: readonly Result[], signal: AbortSignal): Promise<ExchangeAnswer> {
      if (!allowed) throw new PassRefused(unsent);
      await options.before?.();
      const response = await send(`${base}/v1/stations/exchange`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ station, results }),
        signal,
      });
      if (!response.ok) return refused(response, "exchange");
      return answerOf(await response.json());
    },
    async put(errand: string, name: string, parts: AsyncIterable<Uint8Array>): Promise<FileRef> {
      if (!allowed) throw new Error(unsent);
      const path = `${base}/v1/stations/files/${encodeURIComponent(errand)}/${name.split("/").map(encodeURIComponent).join("/")}`;
      let count = 0;
      for await (const part of parts) {
        const response = await send(`${path}?part=${count}`, {
          method: "PUT",
          headers: { ...headers, "content-type": "application/octet-stream" },
          body: part as Uint8Array<ArrayBuffer>,
        });
        if (!response.ok) await refused(response);
        count++;
      }
      const done = await send(`${path}?done=${count}`, { method: "POST", headers });
      if (!done.ok) return refused(done);
      return (await done.json()) as FileRef;
    },
  };
}
