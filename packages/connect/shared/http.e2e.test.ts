import { describe, expect, it } from "vitest";
import type { JsonObject } from "@lifestreamprotocol/core";
import { NeedsYou, NotYet } from "../seams.js";
import { artifact, memorySecrets, temp } from "../test/drive.js";
import { afterStop, answered, isStop, LIMIT_MS, request, Stopped, type Budget, type Stop } from "./http.js";
import { credentialText, oauthCredential, type OAuthCredential, type Refresher } from "./oauth.js";

const T0 = Date.UTC(2026, 9, 28, 9, 0, 0);
const API = "https://api.example.com/v1/items";
const HOUR = 3_600_000;

function provider(...answers: { status: number; headers?: Record<string, string>; body?: string }[]) {
  const seen: { url: string; bearer: string | null }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), bearer: new Headers(init?.headers).get("authorization") });
    const next = answers.shift() ?? { status: 200 };
    return new Response(next.body ?? "{\"secret-body\":\"a private provider text\"}", { status: next.status, headers: next.headers ?? {} });
  }) as typeof globalThis.fetch;
  return { seen, fetch };
}

function refresher(refuse = false): Refresher & { handed: OAuthCredential[] } {
  const handed: OAuthCredential[] = [];
  const refresh = (async (credential: OAuthCredential) => {
    handed.push(credential);
    if (refuse) throw new NeedsYou("signed-out", "the provider no longer accepts this sign-in");
    return { ...credential, refresh_token: `refresh-synthetic-r${handed.length}`, access_token: `access-synthetic-r${handed.length}`, expires_ms: T0 + HOUR };
  }) as unknown as Refresher & { handed: OAuthCredential[] };
  refresh.handed = handed;
  return refresh;
}

const SIGNED: OAuthCredential = { client_id: "client-synthetic", refresh_token: "refresh-synthetic-1", access_token: "access-synthetic-1", expires_ms: T0 + 6 * HOUR };

describe("the request loop: each of these is impossible", () => {
  it("a 401 is a stop before one refresh and one retry, a second 401 or a refused refresh is anything but signed-out, or the refreshed credential is not in the vault", async () => {
    const once = provider({ status: 401 }, { status: 200 });
    const secrets = memorySecrets({ "provider.signin": credentialText(SIGNED) });
    const fresh = refresher();
    const budget: Budget = { left: 5 };
    const answer = await request(API, { method: "GET" }, { budget, refresher: fresh, secrets, secret: "provider.signin", fetch: once.fetch, now: () => T0 });
    expect(isStop(answer) ? answer : answer.status).toBe(200);
    expect(once.seen.map((each) => each.bearer)).toEqual(["Bearer access-synthetic-1", "Bearer access-synthetic-r1"]);
    expect(fresh.handed).toHaveLength(1);
    expect(oauthCredential(secrets.values["provider.signin"]!, "the vault")).toMatchObject({ refresh_token: "refresh-synthetic-r1", access_token: "access-synthetic-r1" });
    expect(budget.left).toBe(4);

    const twice = provider({ status: 401 }, { status: 401 });
    const again = refresher();
    expect(await request(API, { method: "GET" }, { budget: { left: 5 }, refresher: again, secrets, secret: "provider.signin", fetch: twice.fetch, now: () => T0 })).toEqual({ stop: "signed-out" });
    expect([twice.seen.length, again.handed.length]).toEqual([2, 1]);

    const sealed = secrets.values["provider.signin"];
    const refused = provider({ status: 401 });
    expect(await request(API, { method: "GET" }, { budget: { left: 5 }, refresher: refresher(true), secrets, secret: "provider.signin", fetch: refused.fetch, now: () => T0 })).toEqual({ stop: "signed-out" });
    expect([refused.seen.length, secrets.values["provider.signin"]]).toEqual([1, sealed]);

    const none = provider();
    expect(await request(API, { method: "GET" }, { budget: { left: 5 }, refresher: refresher(), secrets: memorySecrets({}), secret: "provider.signin", fetch: none.fetch })).toEqual({ stop: "signed-out", answered: false });
    expect(none.seen).toEqual([]);

    const keyed = provider({ status: 401 });
    expect(await request(API, { method: "GET", headers: { authorization: "Bearer key-synthetic" } }, { budget: { left: 5 }, fetch: keyed.fetch })).toEqual({ stop: "signed-out" });
    artifact(temp(), "signed-out.json", { once: once.seen, twice: twice.seen, refused: refused.seen, keyed: keyed.seen });
  });

  it("a 429 is a failure or the response, its Retry-After is lost, or one naming none waits less than a minute", async () => {
    const date = new Date(T0 + 90_000).toUTCString();
    const limited = provider({ status: 429, headers: { "retry-after": "120" } }, { status: 429, headers: { "retry-after": date } }, { status: 429 });
    const options = { budget: { left: 5 }, fetch: limited.fetch, now: () => T0 };
    expect(await request(API, {}, options)).toEqual({ stop: "limit", retry_ms: T0 + 120_000 });
    expect(await request(API, {}, options)).toEqual({ stop: "limit", retry_ms: T0 + 90_000 });
    expect(await request(API, {}, options)).toEqual({ stop: "limit", retry_ms: T0 + LIMIT_MS });
    expect(LIMIT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("a provider's own limit (GitHub's 403 with no request left) is the response, or an ordinary 403 is a stop", async () => {
    const reset = T0 / 1000 + 600;
    const github = provider({ status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }, { status: 403, headers: { "x-ratelimit-remaining": "40" } });
    const limited = (response: Response): number | null =>
      response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0" ? Number(response.headers.get("x-ratelimit-reset")) * 1000 : null;
    const options = { budget: { left: 5 }, fetch: github.fetch, now: () => T0, limited };
    expect(await request(API, {}, options)).toEqual({ stop: "limit", retry_ms: reset * 1000 });
    const forbidden = await request(API, {}, options);
    expect(isStop(forbidden) ? forbidden : forbidden.status).toBe(403);
  });

  it("a spent budget makes the request", async () => {
    const counted = provider({ status: 200 }, { status: 200 });
    const budget: Budget = { left: 1 };
    expect(isStop(await request(API, {}, { budget, fetch: counted.fetch }))).toBe(false);
    expect(await request(API, {}, { budget, fetch: counted.fetch })).toEqual({ stop: "budget" });
    expect(counted.seen).toHaveLength(1);
    expect(() => answered({ stop: "budget" })).toThrow(Stopped);
  });

  it("a stop loses the work its call finished, a call that finished nothing seals anything, or a message carries a token or a body", async () => {
    const cursor: JsonObject = { page: 3 };
    const at = (stop: Stop, finished: boolean) => {
      try {
        return afterStop(stop, finished, cursor, "Synthetic");
      } catch (error) {
        return error;
      }
    };
    expect(at({ stop: "limit", retry_ms: T0 + 120_000 }, true)).toEqual({ backoff_ms: T0 + 120_000 });
    expect(at({ stop: "budget" }, true)).toEqual({ more: true });
    expect(at({ stop: "signed-out" }, true)).toEqual({ more: true });
    expect(afterStop(undefined, true, cursor, "Synthetic")).toEqual({});
    const waited = at({ stop: "limit", retry_ms: T0 + 120_000 }, false) as NotYet;
    expect([waited instanceof NotYet, waited.reason, waited.backoff_ms, waited.state]).toEqual([true, "provider-limit", T0 + 120_000, cursor]);
    const needed = at({ stop: "signed-out" }, false) as NeedsYou;
    expect([needed instanceof NeedsYou, needed.reason, needed.state, needed.answered]).toEqual([true, "signed-out", cursor, undefined]);
    const unasked = at({ stop: "signed-out", answered: false }, false) as NeedsYou;
    expect([unasked instanceof NeedsYou, unasked.reason, unasked.state, unasked.answered]).toEqual([true, "signed-out", cursor, false]);
    expect(at({ stop: "budget" }, false)).toEqual({ more: true });
    for (const error of [waited, needed, new Stopped({ stop: "signed-out" })]) expect(error.message).not.toMatch(/synthetic-|private/u);
  });
});
