import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { networkOf, senderOf, type Env } from "./index.js";
import LIMITS from "./limits.json";

const ID = "6f1c2a8e-3b4d-4e5f-9a7b-1c2d3e4f5a6b";
const OTHER_ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TEXT = "The Gmail card says broken since this morning.";
const EMAIL = "person-a@example.com";
const ADDRESS = "203.0.113.7";
const TEAM = "lifestream-test";
const AUD = "0f".repeat(32);
const KID = "access-key-1";
const CERTS = (team: string): string => `https://${team}.cloudflareaccess.com/cdn-cgi/access/certs`;
const SIGNING = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } as const;
const ACCESS_KEY = await crypto.subtle.generateKey(SIGNING, true, ["sign", "verify"]);
const OTHER_KEY = await crypto.subtle.generateKey(SIGNING, true, ["sign", "verify"]);
const ACCESS_JWK = { ...(await crypto.subtle.exportKey("jwk", ACCESS_KEY.publicKey)), kid: KID, alg: "RS256", use: "sig" };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const SCHEMA = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");

interface Fakes {
  readonly env: Env;
  readonly db: DatabaseSync;
  readonly shots: Map<string, { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string | undefined }>;
  readonly puts: string[];
  readonly limited: string[];
  failing: "db" | "shots" | null;
}

interface Vars {
  readonly CLOSED?: string;
  readonly BUDGET?: string;
  readonly ACCESS_TEAM?: string;
  readonly ACCESS_AUD?: string;
}

function fakes(vars: Vars = {}): Fakes {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const shots = new Map<string, { readonly bytes: Uint8Array<ArrayBuffer>; readonly type: string | undefined }>();
  const puts: string[] = [];
  const limited: string[] = [];
  const counts = new Map<string, number>();
  const state: { failing: "db" | "shots" | null } = { failing: null };
  const statement = (sql: string, values: readonly (string | number)[] = []) => ({
    bind: (...bound: (string | number)[]) => statement(sql, bound),
    first: async () => {
      if (state.failing === "db") throw new Error("D1 is down");
      return db.prepare(sql).get(...values) ?? null;
    },
    all: async () => {
      if (state.failing === "db") throw new Error("D1 is down");
      return { results: db.prepare(sql).all(...values), success: true, meta: {} };
    },
    run: async () => {
      if (state.failing === "db") throw new Error("D1 is down");
      const { changes } = db.prepare(sql).run(...values);
      return { results: [], success: true, meta: { changes: Number(changes) } };
    },
  });
  const objectOf = (key: string) => {
    const kept = shots.get(key);
    if (kept === undefined) return null;
    return { key, body: new Blob([kept.bytes]).stream(), httpMetadata: { contentType: kept.type } };
  };
  const bucket = {
    put: async (key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }) => {
      if (state.failing === "shots") throw new Error("R2 is down");
      puts.push(key);
      shots.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType });
      return { key };
    },
    get: async (key: string) => objectOf(key),
    head: async (key: string) => objectOf(key),
  };
  const limiter = (name: string, most: number) => ({
    limit: async ({ key }: { key: string }) => {
      limited.push(key);
      const count = (counts.get(`${name} ${key}`) ?? 0) + 1;
      counts.set(`${name} ${key}`, count);
      return { success: count <= most };
    },
  });
  const env = {
    DB: { prepare: (sql: string) => statement(sql) },
    SHOTS: bucket,
    ADDRESS: limiter("ADDRESS", 3),
    NETWORK: limiter("NETWORK", 10),
    CLOSED: vars.CLOSED ?? "false",
    BUDGET: vars.BUDGET ?? "500",
    ACCESS_TEAM: vars.ACCESS_TEAM ?? TEAM,
    ACCESS_AUD: vars.ACCESS_AUD ?? AUD,
  } as unknown as Env;
  return Object.assign(state, { env, db, shots, puts, limited });
}

interface Sent {
  readonly report?: Record<string, unknown> | string | null;
  readonly parts?: readonly (readonly [string, string | Blob])[];
  readonly address?: string;
  readonly length?: string | null | ((bytes: number) => string);
  readonly headers?: Record<string, string | null>;
}

function report(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { v: 1, id: ID, text: TEXT, email: EMAIL, about: "connector", device: "mac", ...fields };
}

async function request(sent: Sent = {}): Promise<Request> {
  const form = new FormData();
  const said = sent.report === undefined ? report() : sent.report;
  if (said !== null) form.append("report", typeof said === "string" ? said : JSON.stringify(said));
  for (const [name, value] of sent.parts ?? []) form.append(name, value);
  const encoded = new Request("https://feedback.example.test/v1/reports", { method: "POST", body: form });
  const body = await encoded.arrayBuffer();
  const headers = new Headers({
    "Content-Type": encoded.headers.get("Content-Type") ?? "",
    "CF-Connecting-IP": sent.address ?? ADDRESS,
    "X-Lifestream-Report": "1",
  });
  const length = sent.length === undefined ? String(body.byteLength) : typeof sent.length === "function" ? sent.length(body.byteLength) : sent.length;
  if (length !== null) headers.set("Content-Length", length);
  for (const [name, value] of Object.entries(sent.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return new Request("https://feedback.example.test/v1/reports", { method: "POST", body, headers });
}

async function send(fakes: Fakes, sent: Sent = {}): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers; readonly request: Request }> {
  const made = await request(sent);
  const response = await worker.fetch(made, fakes.env);
  return { status: response.status, body: await response.json(), headers: response.headers, request: made };
}

function rows(fakes: Fakes): { id: string; at_ms: number; report: string; shot: number }[] {
  return fakes.db.prepare("SELECT id, at_ms, report, shot FROM reports ORDER BY at_ms").all() as { id: string; at_ms: number; report: string; shot: number }[];
}

function base64url(bytes: string | Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

interface Token {
  readonly claims?: Record<string, unknown>;
  readonly header?: Record<string, unknown>;
  readonly key?: CryptoKey;
}

async function token(made: Token = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", kid: KID, typ: "JWT", ...made.header };
  const claims = { aud: [AUD], iss: `https://${TEAM}.cloudflareaccess.com`, email: "maker@example.com", iat: now, nbf: now, exp: now + 3600, ...made.claims };
  const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = await crypto.subtle.sign(SIGNING.name, made.key ?? ACCESS_KEY.privateKey, new TextEncoder().encode(signed));
  return `${signed}.${base64url(new Uint8Array(signature))}`;
}

async function admitted(made: Token = {}): Promise<Record<string, string>> {
  return { "Cf-Access-Jwt-Assertion": await token(made) };
}

async function get(fakes: Fakes, path: string, headers?: Record<string, string>): Promise<Response> {
  return worker.fetch(new Request(`https://feedback.example.test${path}`, { headers: headers ?? await admitted() }), fakes.env);
}

let logged: unknown[][] = [];
let fetched: string[] = [];
beforeEach(() => {
  logged = [];
  fetched = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = input instanceof Request ? input.url : String(input);
    fetched.push(url);
    return Response.json({ keys: [ACCESS_JWK] });
  });
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args); });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("POST /v1/reports keeps a report", () => {
  it("stores the report, its attachments by kind and its screenshot, and a repeat of its id with another screenshot keeps the first, with no second put and no budget asked", async () => {
    const store = fakes({ BUDGET: "1" });
    const parts = [["answer", "Question: [[Person 1]]?"], ["app", "Release 4812"], ["screenshot", new Blob([JPEG], { type: "image/jpeg" })]] as const;
    const first = await send(store, { parts });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ kept: true });
    const repeat = await send(store, { parts: [["answer", "Another question"], ["screenshot", new Blob([PNG])]], address: "198.51.100.1" });
    expect(repeat.status).toBe(200);
    expect(repeat.body).toEqual({ kept: true });
    expect(store.puts).toEqual([`shots/${ID}.jpg`]);
    expect(store.shots.get(`shots/${ID}.jpg`)?.type).toBe("image/jpeg");
    const kept = rows(store);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.id).toBe(ID);
    expect(kept[0]?.shot).toBe(1);
    expect(JSON.parse(kept[0]?.report ?? "")).toEqual({ ...report(), attached: { answer: "Question: [[Person 1]]?", app: "Release 4812" } });
    expect([...store.shots.keys()]).toEqual([`shots/${ID}.jpg`]);
    expect(store.shots.get(`shots/${ID}.jpg`)?.bytes).toEqual(JPEG);
  });

  it("keeps the person's words and email exactly as sent, a report with no reply, and a PNG screenshot", async () => {
    const store = fakes();
    const words = "  Two lines,\nwith <b>tags</b> & émoji 🙂 kept  ";
    expect((await send(store, { report: report({ text: words, email: null }), parts: [["screenshot", new Blob([PNG])]] })).status).toBe(201);
    const kept = JSON.parse(rows(store)[0]?.report ?? "") as { text: string; email: string | null };
    expect(kept.text).toBe(words);
    expect(kept.email).toBeNull();
    expect(store.shots.get(`shots/${ID}.jpg`)?.type).toBe("image/png");
  });

  it("answers 503 closed while CLOSED is set, with the body unread and nothing kept", async () => {
    const store = fakes({ CLOSED: "true" });
    const answer = await send(store);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: "closed" });
    expect(answer.headers.get("Retry-After")).toBe("21600");
    expect(answer.request.bodyUsed).toBe(false);
    expect(rows(store)).toEqual([]);
  });

  it.each(["", "abc", "0", "-1", "1.5", "NaN", "1e3", " 500"])("answers 503 closed to every report while BUDGET is %j, not a positive integer", async (budget) => {
    const store = fakes({ BUDGET: budget });
    const answer = await send(store);
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ error: "closed" });
    expect(answer.request.bodyUsed).toBe(false);
    expect(rows(store)).toEqual([]);
  });

  it.each([
    ["without X-Lifestream-Report", { "X-Lifestream-Report": null }],
    ["with X-Lifestream-Report other than 1", { "X-Lifestream-Report": "true" }],
    ["carrying Origin", { Origin: "https://elsewhere.example" }],
    ["carrying Origin null", { Origin: "null" }],
    ["carrying Sec-Fetch-Site", { "Sec-Fetch-Site": "cross-site" }],
    ["carrying Sec-Fetch-Site same-origin", { "Sec-Fetch-Site": "same-origin" }],
  ] as const)("answers 403 forbidden to a report %s, as a web page's form would send, with the body unread and nothing kept", async (_name, headers) => {
    const store = fakes();
    const answer = await send(store, { headers, parts: [["screenshot", new Blob([JPEG])]] });
    expect(answer.status).toBe(403);
    expect(answer.body).toEqual({ error: "forbidden" });
    expect(answer.request.bodyUsed).toBe(false);
    expect(store.limited).toEqual([]);
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it("answers no preflight: OPTIONS on /v1/reports is 404 with no CORS header", async () => {
    const store = fakes();
    const answer = await worker.fetch(new Request("https://feedback.example.test/v1/reports", {
      method: "OPTIONS",
      headers: { Origin: "https://elsewhere.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "x-lifestream-report" },
    }), store.env);
    expect(answer.status).toBe(404);
    expect([...answer.headers.keys()].filter((name) => name.startsWith("access-control-"))).toEqual([]);
  });

  it("answers 413 large to a body longer than its Content-Length, reading no further, with nothing put and nothing inserted", async () => {
    const store = fakes();
    const answer = await send(store, { length: (bytes) => String(bytes - 1), parts: [["screenshot", new Blob([JPEG])]] });
    expect(answer.status).toBe(413);
    expect(answer.body).toEqual({ error: "large" });
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it("answers 411 without a Content-Length and 413 over the body limit, with the body unread, nothing put and nothing inserted", async () => {
    const store = fakes();
    const unstated = await send(store, { length: null, parts: [["screenshot", new Blob([JPEG])]] });
    expect(unstated.status).toBe(411);
    expect(unstated.request.bodyUsed).toBe(false);
    const oversized = await send(store, { length: String(LIMITS.body_bytes + 1), parts: [["screenshot", new Blob([JPEG])]] });
    expect(oversized.status).toBe(413);
    expect(oversized.body).toEqual({ error: "large" });
    expect(oversized.request.bodyUsed).toBe(false);
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
    expect(store.limited).toEqual([]);
  });

  it.each([
    ["no report part", { report: null }],
    ["a report that is not JSON", { report: "{v: 1" }],
    ["a report that is a list", { report: "[1]" }],
    ["an id that is not a UUID", { report: report({ id: "report-1" }) }],
    ["an id that is a UUID of another version", { report: report({ id: "6f1c2a8e-3b4d-1e5f-9a7b-1c2d3e4f5a6b" }) }],
    ["v that is not 1", { report: report({ v: 2 }) }],
    ["an empty text", { report: report({ text: "" }) }],
    ["an email that is not text", { report: report({ email: 5 }) }],
    ["an unknown about", { report: report({ about: "toast" }) }],
    ["an unknown device", { report: report({ device: "watch" }) }],
    ...["constructor", "__proto__", "toString", "hasOwnProperty"].flatMap((inherited) => [
      [`about ${inherited}`, { report: report({ about: inherited }) }],
      [`device ${inherited}`, { report: report({ device: inherited }) }],
    ] as const),
    ["a field the report does not have", { report: report({ name: "Person A" }) }],
    ["a missing field", { report: { v: 1, id: ID, text: TEXT, about: "menu", device: "mac" } }],
    ["two parts of one kind", { parts: [["answer", "one"], ["answer", "two"]] }],
    ["a part of no kind", { parts: [["voice", "hello"]] }],
    ["a screenshot sent as text", { parts: [["screenshot", "ffd8ff"]] }],
  ] as const)("answers 400 bad for %s, with nothing put and nothing inserted", async (_name, sent: Sent) => {
    const store = fakes();
    const answer = await send(store, { ...sent, parts: sent.parts ?? [["screenshot", new Blob([JPEG])]] });
    expect(answer.status).toBe(400);
    expect(answer.body).toEqual({ error: "bad" });
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it.each([
    ["a text over its limit", { report: report({ text: "a".repeat(LIMITS.text_chars + 1) }) }],
    ["an email over its limit", { report: report({ email: `${"a".repeat(LIMITS.email_chars - 11)}@example.com` }) }],
    ["an attachment over its limit", { parts: [["app", "a".repeat(LIMITS.attachment_bytes + 1)]] }],
    ["a screenshot over its size", { parts: [["screenshot", new Blob([JPEG, new Uint8Array(LIMITS.screenshot_bytes)])]] }],
  ] as const)("answers 413 large for %s, with nothing put and nothing inserted", async (_name, sent: Sent) => {
    const store = fakes();
    const answer = await send(store, sent);
    expect(answer.status).toBe(413);
    expect(answer.body).toEqual({ error: "large" });
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it("takes a text of exactly its limit counted in characters, not bytes", async () => {
    const store = fakes();
    expect((await send(store, { report: report({ text: "é".repeat(LIMITS.text_chars) }) })).status).toBe(201);
  });

  it("answers 415 kind for a screenshot neither JPEG nor PNG by its first bytes, with nothing put and nothing inserted", async () => {
    const store = fakes();
    for (const bytes of [GIF, new Uint8Array(0)]) {
      const answer = await send(store, { parts: [["screenshot", new Blob([bytes], { type: "image/jpeg" })]] });
      expect(answer.status).toBe(415);
      expect(answer.body).toEqual({ error: "kind" });
    }
    expect(store.puts).toEqual([]);
    expect(rows(store)).toEqual([]);
  });

  it("answers 429 slow to the fourth report in a minute from one IPv6 /64, and takes another /64", async () => {
    const store = fakes();
    const addresses = ["2001:db8:1:2::a", "2001:db8:1:2:ffff::1", "2001:0db8:0001:0002:0:0:0:b"];
    for (const [at, address] of addresses.entries()) {
      expect((await send(store, { address, report: report({ id: at === 0 ? ID : `6f1c2a8e-3b4d-4e5f-9a7b-1c2d3e4f5a6${at}` }) })).status).toBe(201);
    }
    const fourth = await send(store, { address: "2001:db8:1:2::c", report: report({ id: OTHER_ID }) });
    expect(fourth.status).toBe(429);
    expect(fourth.body).toEqual({ error: "slow" });
    expect(fourth.headers.get("Retry-After")).toBe("60");
    expect(rows(store)).toHaveLength(3);
    expect((await send(store, { address: "2001:db8:1:3::a", report: report({ id: OTHER_ID }) })).status).toBe(201);
  });

  it("answers 429 slow to the eleventh report in a minute from one IPv6 /48 across ten /64s, and takes another /48", async () => {
    const store = fakes();
    const idOf = (at: number): string => `6f1c2a8e-3b4d-4e5f-9a7b-1c2d3e4f5${String(at).padStart(3, "0")}`;
    for (let at = 0; at < 10; at += 1) {
      expect((await send(store, { address: `2001:db8:7:${at.toString(16)}::1`, report: report({ id: idOf(at) }) })).status).toBe(201);
    }
    const eleventh = await send(store, { address: "2001:db8:7:ff::1", report: report({ id: idOf(10) }) });
    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ error: "slow" });
    expect(rows(store)).toHaveLength(10);
    expect((await send(store, { address: "2001:db8:8:ff::1", report: report({ id: idOf(10) }) })).status).toBe(201);
  });

  it("keys the limiters by the whole IPv4 address, and by the IPv6 /64 and /48", () => {
    expect(senderOf("203.0.113.7")).toBe("203.0.113.7");
    expect(senderOf("2001:db8:1:2::a")).toBe("2001:db8:1:2::/64");
    expect(senderOf("2001:0DB8:0001:0002:0003:0004:0005:0006")).toBe("2001:db8:1:2::/64");
    expect(senderOf("::1")).toBe("0:0:0:0::/64");
    expect(senderOf(null)).toBe("unknown");
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("2001:db8:1:2::a")).toBe("2001:db8:1::/48");
    expect(networkOf("2001:0DB8:0001:ffff:0003:0004:0005:0006")).toBe("2001:db8:1::/48");
    expect(networkOf(null)).toBe("unknown");
  });

  it("answers 429 full to the budget's next report in a day, counting only the last 24 h", async () => {
    const store = fakes({ BUDGET: "500" });
    const now = Date.now();
    const insert = store.db.prepare("INSERT INTO reports (id, at_ms, report, shot) VALUES (?, ?, '{}', 0)");
    for (let at = 0; at < 499; at += 1) insert.run(`recent-${at}`, now - 1_000 - at);
    for (let at = 0; at < 10; at += 1) insert.run(`old-${at}`, now - 86_400_000 - 60_000 - at);
    expect((await send(store)).status).toBe(201);
    const full = await send(store, { report: report({ id: OTHER_ID }), address: "198.51.100.2", parts: [["screenshot", new Blob([JPEG])]] });
    expect(full.status).toBe(429);
    expect(full.body).toEqual({ error: "full" });
    expect(full.headers.get("Retry-After")).toBe("3600");
    expect(store.puts).toEqual([]);
    expect(rows(store).filter((row) => row.id === OTHER_ID)).toEqual([]);
  });

  it("answers 502 again when D1 or R2 fails, and keeps no row whose screenshot was not put", async () => {
    for (const failing of ["db", "shots"] as const) {
      const store = fakes();
      store.failing = failing;
      const answer = await send(store, { parts: [["screenshot", new Blob([JPEG])]] });
      expect(answer.status).toBe(502);
      expect(answer.body).toEqual({ error: "again" });
      expect(rows(store)).toEqual([]);
    }
  });
});

describe("the list", () => {
  it("draws every text the person or their home wrote as typed, escaped, with the page's policy and no script", async () => {
    const store = fakes();
    const typed = "<b>bold</b> <script>alert(1)</script> <img src=x onerror=alert(2)> [link](javascript:alert(3)) \"q\" 'a' & done";
    const parts = [["answer", "<script>steps()</script>"], ["connector", "<b>Gmail</b>"], ["app", "<iframe src=x>"]] as const;
    expect((await send(store, { report: report({ text: typed, email: "<b>@example.com" }), parts })).status).toBe(201);
    const page = await get(store, "/list");
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Security-Policy")).toBe(
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    const html = await page.text();
    expect(html).not.toMatch(/<script|<b>|<img src=x|<iframe|onerror=alert\(2\)>|<a href="javascript/iu);
    const shown = (text: string): string => text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
    for (const text of [typed, "<b>@example.com", "<script>steps()</script>", "<b>Gmail</b>", "<iframe src=x>"]) expect(html).toContain(shown(text));
    expect(html).toContain("This answer");
    expect(html).toContain("This connector");
    expect(html).toContain("App details");
    expect(html).toContain("Reply to");
  });

  it("draws newest first, 50 to a page, with Older, No reply, the screenshot, and a dropped screenshot's words", async () => {
    const store = fakes();
    const insert = store.db.prepare("INSERT INTO reports (id, at_ms, report, shot) VALUES (?, ?, ?, ?)");
    const said = (text: string) => JSON.stringify({ ...report({ text, email: null }), attached: {} });
    for (let at = 0; at < 55; at += 1) insert.run(`00000000-0000-4000-8000-0000000000${String(at).padStart(2, "0")}`, 1_000_000 + at, said(`report number ${at}`), 0);
    insert.run(ID, 2_000_000, said("with a screenshot"), 1);
    insert.run(OTHER_ID, 2_000_001, said("screenshot dropped"), 1);
    store.shots.set(`shots/${ID}.jpg`, { bytes: JPEG, type: "image/jpeg" });
    const first = await (await get(store, "/list")).text();
    expect(first.indexOf("screenshot dropped")).toBeLessThan(first.indexOf("with a screenshot"));
    expect(first).toContain(`<img src="/list/${ID}.jpg" alt="Screenshot">`);
    expect(first).toContain("Screenshot deleted after 90 days");
    expect(first).toContain("No reply");
    expect(first.match(/<article>/gu)).toHaveLength(50);
    expect(first).not.toContain("report number 6<");
    expect(first).toContain('<a href="/list?before=1000007&amp;id=00000000-0000-4000-8000-000000000007">Older</a>');
    const second = await (await get(store, "/list?before=1000007&id=00000000-0000-4000-8000-000000000007")).text();
    expect(second.match(/<article>/gu)).toHaveLength(7);
    expect(second).toContain("report number 0");
    expect(second).not.toContain("Older");
  });

  it("pages by (at_ms, id), so reports of one millisecond across a page's edge are each drawn once", async () => {
    const store = fakes();
    const insert = store.db.prepare("INSERT INTO reports (id, at_ms, report, shot) VALUES (?, ?, ?, 0)");
    const ids = Array.from({ length: 53 }, (_, at) => `00000000-0000-4000-8000-0000000000${String(at).padStart(2, "0")}`);
    for (const [at, id] of ids.entries()) insert.run(id, at < 5 ? 900_000 : 1_000_000, JSON.stringify({ ...report({ id, text: `report ${id}` }), attached: {} }));
    const drawnIds = (html: string): string[] => [...html.matchAll(/report (0{8}-[0-9a-f-]{27})/gu)].map((match) => match[1] ?? "");
    const first = await (await get(store, "/list")).text();
    const older = /href="\/list\?before=(\d+)&amp;id=([0-9a-f-]{36})"/u.exec(first);
    expect(older?.[1]).toBe("900000");
    const second = await (await get(store, `/list?before=${older?.[1]}&id=${older?.[2]}`)).text();
    const both = [...drawnIds(first), ...drawnIds(second)];
    expect(drawnIds(first)).toHaveLength(50);
    expect(both.sort()).toEqual([...ids].sort());
  });

  it("answers 400 to a cursor with one half, or a half malformed", async () => {
    const store = fakes();
    for (const query of ["?before=5", `?id=${ID}`, `?before=x&id=${ID}`, "?before=5&id=report-1"]) {
      expect((await get(store, `/list${query}`)).status).toBe(400);
    }
  });

  it("draws every row it can when one stored row cannot be drawn", async () => {
    const store = fakes();
    const insert = store.db.prepare("INSERT INTO reports (id, at_ms, report, shot) VALUES (?, ?, ?, 0)");
    insert.run(ID, 2_000, JSON.stringify({ ...report({ text: "drawn after" }), attached: {} }));
    insert.run(OTHER_ID, 1_500, "not json");
    insert.run("00000000-0000-4000-8000-000000000001", 1_000, JSON.stringify({ ...report({ text: "drawn before", device: 5 }), attached: {} }));
    const page = await get(store, "/list");
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("drawn after");
    expect(html.match(/This report could not be drawn\./gu)).toHaveLength(2);
  });

  it("sets the person's words apart from the page and shows bidi controls as marks", async () => {
    const store = fakes();
    const controls = "\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069";
    expect((await send(store, { report: report({ text: `fine ${controls} done`, email: "a\u202e@example.com" }), parts: [["app", `x\u2067y`]] })).status).toBe(201);
    const html = await (await get(store, "/list")).text();
    expect(html).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/u);
    for (const mark of ["202A", "202B", "202C", "202D", "202E", "2066", "2067", "2068", "2069"]) expect(html).toContain(`<span class="mark">[U+${mark}]</span>`);
    expect(html).toMatch(/\.said \{[^}]*border: 1px dashed/u);
  });

  it("answers a screenshot's bytes with its type and a sandboxing policy, and 404 for one not kept", async () => {
    const store = fakes();
    expect((await send(store, { parts: [["screenshot", new Blob([PNG])]] })).status).toBe(201);
    const picture = await get(store, `/list/${ID}.jpg`);
    expect(picture.status).toBe(200);
    expect(picture.headers.get("Content-Type")).toBe("image/png");
    expect(picture.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(picture.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(PNG);
    expect((await get(store, `/list/${OTHER_ID}.jpg`)).status).toBe(404);
  });

  it("answers 403 on /list and a screenshot to Access's email header with no JWT", async () => {
    const store = fakes();
    expect((await send(store, { parts: [["screenshot", new Blob([JPEG])]] })).status).toBe(201);
    const forged = { "Cf-Access-Authenticated-User-Email": "maker@example.com" };
    for (const path of ["/list", "/list?before=5&id=" + ID, `/list/${ID}.jpg`]) {
      expect((await get(store, path, forged)).status).toBe(403);
      expect((await get(store, path, {})).status).toBe(403);
    }
  });

  it.each([
    ["a wrong aud", { claims: { aud: ["ab".repeat(32)] } }],
    ["a wrong iss", { claims: { iss: "https://elsewhere.cloudflareaccess.com" } }],
    ["a signature by another key under Access's kid", { key: OTHER_KEY.privateKey }],
    ["an expired exp", { claims: { exp: Math.floor(Date.now() / 1000) - 10 } }],
    ["no exp", { claims: { exp: undefined } }],
    ["an nbf to come", { claims: { nbf: Math.floor(Date.now() / 1000) + 600 } }],
    ["alg HS256", { header: { alg: "HS256" } }],
    ["alg none", { header: { alg: "none" } }],
    ["an unknown kid", { header: { kid: "access-key-9" } }],
  ] as const)("answers 403 on /list and a screenshot to a JWT with %s", async (_name, made: Token) => {
    const store = fakes();
    expect((await send(store, { parts: [["screenshot", new Blob([JPEG])]] })).status).toBe(201);
    expect((await get(store, "/list", await admitted(made))).status).toBe(403);
    expect((await get(store, `/list/${ID}.jpg`, await admitted(made))).status).toBe(403);
    expect((await get(store, "/list", { "Cf-Access-Jwt-Assertion": `${await token(made)}x` })).status).toBe(403);
  });

  it("answers 403 to a good JWT while ACCESS_TEAM or ACCESS_AUD is still a placeholder, asking Access nothing", async () => {
    for (const vars of [{ ACCESS_TEAM: "<team name>" }, { ACCESS_AUD: "<application audience tag>" }, { ACCESS_TEAM: "" }, { ACCESS_AUD: "" }]) {
      expect((await get(fakes(vars), "/list")).status).toBe(403);
    }
    expect(fetched).toEqual([]);
  });

  it("answers 200 to a good JWT, an aud of one string too, and fetches a team's certs once for the isolate", async () => {
    const team = "lifestream-certs-once";
    const store = fakes({ ACCESS_TEAM: team });
    const iss = `https://${team}.cloudflareaccess.com`;
    expect((await get(store, "/list", await admitted({ claims: { iss } }))).status).toBe(200);
    expect((await get(store, "/list", await admitted({ claims: { iss, aud: AUD } }))).status).toBe(200);
    expect(fetched).toEqual([CERTS(team)]);
  });

  it("answers 404 for every other route", async () => {
    const store = fakes();
    expect((await get(store, "/")).status).toBe(404);
    expect((await get(store, "/v1/reports")).status).toBe(404);
    expect((await worker.fetch(new Request("https://feedback.example.test/list", { method: "POST", headers: await admitted() }), store.env)).status).toBe(404);
  });
});

describe("the log", () => {
  it("writes one line per request of route, status and ms, and never the text, the email, an attachment, the id or the address", async () => {
    const store = fakes();
    const attachment = "Model: attachment-words-only";
    const address = "2001:db8:aaaa:bbbb::1";
    await send(store, { address, parts: [["app", attachment], ["screenshot", new Blob([JPEG])]] });
    await send(store, { address, parts: [["app", attachment]] });
    await send(store, { address: "203.0.113.99", report: report({ v: 2 }) });
    await send(fakes({ CLOSED: "true" }));
    await get(store, "/list");
    await get(store, `/list/${ID}.jpg`);
    await get(store, "/list", {});
    await get(store, "/nowhere");
    expect(logged).toHaveLength(8);
    const lines = logged.map((args) => {
      expect(args).toHaveLength(1);
      return JSON.parse(String(args[0])) as Record<string, unknown>;
    });
    for (const line of lines) expect(Object.keys(line).sort()).toEqual(["ms", "route", "status"]);
    expect(lines.map(({ route, status }) => [route, status])).toEqual([
      ["reports", 201], ["reports", 200], ["reports", 400], ["reports", 503], ["list", 200], ["shot", 200], ["list", 403], ["none", 404],
    ]);
    const written = logged.flat().map(String).join("\n");
    for (const secret of [TEXT, EMAIL, attachment, ID, address, "2001:db8:aaaa:bbbb", "203.0.113.99", ADDRESS]) expect(written).not.toContain(secret);
  });
});
