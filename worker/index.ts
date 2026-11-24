import LIMITS from "./limits.json";

export interface Env {
  readonly DB: D1Database;
  readonly SHOTS: R2Bucket;
  readonly ADDRESS: RateLimit;
  readonly NETWORK: RateLimit;
  readonly CLOSED: string;
  readonly BUDGET: string;
  readonly ACCESS_TEAM: string;
  readonly ACCESS_AUD: string;
}

type Route = "reports" | "list" | "shot" | "none";
type Kind = "answer" | "connector" | "app";
type Refused = { readonly status: 400 | 413 | 415; readonly error: "bad" | "large" | "kind" };
type Picture = { readonly bytes: ArrayBuffer; readonly type: "image/jpeg" | "image/png" };

interface Said {
  readonly v: 1;
  readonly id: string;
  readonly text: string;
  readonly email: string | null;
  readonly about: string;
  readonly device: string;
  readonly attached: Partial<Record<Kind, string>>;
}

interface Row {
  readonly id: string;
  readonly at_ms: number;
  readonly report: string;
  readonly shot: number;
}

const KINDS: readonly Kind[] = ["answer", "connector", "app"];
const PARTS: ReadonlySet<string> = new Set(["report", "screenshot", ...KINDS]);
const REPORT_FIELDS: ReadonlySet<string> = new Set(["v", "id", "text", "email", "about", "device"]);
const ABOUTS: ReadonlyMap<string, string> = new Map([["menu", "Menu"], ["chat", "Chat answer"], ["connector", "Connector card"]]);
const DEVICES: ReadonlyMap<string, string> = new Map([["mac", "Mac"], ["phone", "iPhone"]]);
const KIND_WORDS: Readonly<Record<Kind, string>> = { answer: "This answer", connector: "This connector", app: "App details" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHOT_PATH = /^\/list\/([0-9a-f-]{36})\.jpg$/u;
const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const FROM_A_HOME = "X-Lifestream-Report";
const FROM_A_PAGE: readonly string[] = ["Origin", "Sec-Fetch-Site"];
const ACCESS_JWT = "Cf-Access-Jwt-Assertion";
const ACCESS_TEAM = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const ACCESS_AUD = /^[0-9a-f]{64}$/u;
const CERTS_FRESH_MS = 3_600_000;
const CERTS_REFETCH_MS = 60_000;
const SIGNING = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/gu;
const LIST_POLICY = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const SHOT_POLICY = "default-src 'none'; sandbox";
const KEPT = { kept: true } as const;
const KEEP_WITHIN_BUDGET = `INSERT INTO reports (id, at_ms, report, shot) SELECT ?, ?, ?, ?
  WHERE (SELECT COUNT(*) FROM reports WHERE at_ms > ?) < ? ON CONFLICT(id) DO NOTHING`;

const BAD: Refused = { status: 400, error: "bad" };
const LARGE: Refused = { status: 413, error: "large" };
const NOT_A_PICTURE: Refused = { status: 415, error: "kind" };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const [route, answering] = routeOf(request.method, url.pathname);
    const response = await answering(request, env, url).catch(() => json(502, { error: "again" }));
    console.log(JSON.stringify({ route, status: response.status, ms: Date.now() - started }));
    return response;
  },
} satisfies ExportedHandler<Env>;

type Handler = (request: Request, env: Env, url: URL) => Promise<Response>;

function routeOf(method: string, path: string): readonly [Route, Handler] {
  if (method === "POST" && path === "/v1/reports") return ["reports", keep];
  if (method === "GET" && path === "/list") return ["list", accessed(list)];
  if (method === "GET" && SHOT_PATH.test(path)) return ["shot", accessed(shot)];
  return ["none", async () => new Response("Not found", { status: 404 })];
}

function accessed(handler: Handler): Handler {
  return async (request, env, url) => (await admitted(request.headers.get(ACCESS_JWT), env))
    ? handler(request, env, url)
    : new Response("Forbidden", { status: 403 });
}

interface Certs {
  readonly at_ms: number;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

const certsByTeam = new Map<string, Certs>();

async function admitted(token: string | null, env: Env): Promise<boolean> {
  if (token === null || !ACCESS_TEAM.test(env.ACCESS_TEAM) || !ACCESS_AUD.test(env.ACCESS_AUD)) return false;
  const [head = "", body = "", signature = "", ...rest] = token.split(".");
  if (rest.length > 0) return false;
  const header = jsonOf(head);
  const claims = jsonOf(body);
  const bytes = bytesOfBase64Url(signature);
  if (header === null || claims === null || bytes === null) return false;
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return false;
  const key = await accessKey(env.ACCESS_TEAM, header["kid"]);
  if (key === null) return false;
  if (!(await crypto.subtle.verify(SIGNING.name, key, bytes, new TextEncoder().encode(`${head}.${body}`)))) return false;
  return claimsHold(claims, env, Date.now() / 1000);
}

function claimsHold(claims: Record<string, unknown>, env: Env, nowSeconds: number): boolean {
  const { iss, aud, exp, nbf } = claims;
  const audiences = Array.isArray(aud) ? aud : [aud];
  return iss === issuerOf(env.ACCESS_TEAM)
    && audiences.includes(env.ACCESS_AUD)
    && typeof exp === "number" && exp > nowSeconds
    && (nbf === undefined || (typeof nbf === "number" && nbf <= nowSeconds));
}

function issuerOf(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

async function accessKey(team: string, kid: string): Promise<CryptoKey | null> {
  const now = Date.now();
  const cached = certsByTeam.get(team);
  const stale = cached === undefined || now - cached.at_ms > CERTS_FRESH_MS
    || (!cached.keys.has(kid) && now - cached.at_ms > CERTS_REFETCH_MS);
  const certs = stale ? await fetchedCerts(team, now) : cached;
  return certs.keys.get(kid) ?? null;
}

async function fetchedCerts(team: string, now: number): Promise<Certs> {
  const answer = await fetch(`${issuerOf(team)}/cdn-cgi/access/certs`);
  if (!answer.ok) throw new Error(`Access certs answered ${answer.status}`);
  const { keys } = await answer.json<{ keys?: unknown }>();
  const imported = new Map<string, CryptoKey>();
  for (const jwk of Array.isArray(keys) ? keys : []) {
    if (typeof jwk !== "object" || jwk === null) continue;
    const { kid, kty } = jwk as { kid?: unknown; kty?: unknown };
    if (typeof kid !== "string" || kty !== "RSA") continue;
    imported.set(kid, await crypto.subtle.importKey("jwk", jwk as JsonWebKey, SIGNING, false, ["verify"]));
  }
  const certs = { at_ms: now, keys: imported };
  certsByTeam.set(team, certs);
  return certs;
}

function jsonOf(part: string): Record<string, unknown> | null {
  const bytes = bytesOfBase64Url(part);
  if (bytes === null) return null;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function bytesOfBase64Url(part: string): Uint8Array<ArrayBuffer> | null {
  if (part === "" || !/^[A-Za-z0-9_-]+$/u.test(part)) return null;
  try {
    const binary = atob(part.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(part.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

async function keep(request: Request, env: Env): Promise<Response> {
  if (!fromAHome(request.headers)) return json(403, { error: "forbidden" });
  const budget = budgetOf(env.BUDGET);
  if (env.CLOSED === "true" || budget === null) return json(503, { error: "closed" }, { "Retry-After": "21600" });
  const length = request.headers.get("Content-Length") ?? "";
  if (!/^\d+$/u.test(length)) return json(411, { error: "length" });
  if (Number(length) > LIMITS.body_bytes) return json(LARGE.status, { error: LARGE.error });
  const address = request.headers.get("CF-Connecting-IP");
  // external: Cloudflare's rate limit binding counts per location, so it brakes one sender and bounds no total
  for (const [limiter, key] of [[env.ADDRESS, senderOf(address)], [env.NETWORK, networkOf(address)]] as const) {
    if (!(await limiter.limit({ key })).success) return json(429, { error: "slow" }, { "Retry-After": "60" });
  }
  const body = await bodyWithin(request, Number(length));
  if (body === null) return json(LARGE.status, { error: LARGE.error });
  const form = await new Response(body, { headers: { "Content-Type": request.headers.get("Content-Type") ?? "" } }).formData().catch(() => null);
  if (form === null) return json(BAD.status, { error: BAD.error });
  const read = await readReport(form);
  if ("status" in read) return json(read.status, { error: read.error });
  const { said, picture } = read;
  if (await isKept(env, said.id)) return json(200, KEPT);
  const now = Date.now();
  const written = await env.DB.prepare(KEEP_WITHIN_BUDGET)
    .bind(said.id, now, JSON.stringify(said), picture === null ? 0 : 1, now - DAY_MS, budget).run();
  if (written.meta.changes === 0) {
    return (await isKept(env, said.id)) ? json(200, KEPT) : json(429, { error: "full" }, { "Retry-After": "3600" });
  }
  if (picture !== null) await putShot(env, said.id, picture);
  return json(201, KEPT);
}

function fromAHome(headers: Headers): boolean {
  return headers.get(FROM_A_HOME) === "1" && FROM_A_PAGE.every((name) => !headers.has(name));
}

function budgetOf(budget: string): number | null {
  return /^[1-9]\d{0,8}$/u.test(budget) ? Number(budget) : null;
}

async function bodyWithin(request: Request, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = request.body?.getReader();
  for (let read = await reader?.read(); read !== undefined && !read.done; read = await reader?.read()) {
    const chunk: Uint8Array = read.value;
    total += chunk.byteLength;
    if (total > limit) {
      await reader?.cancel();
      return null;
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

async function isKept(env: Env, id: string): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS kept FROM reports WHERE id = ?").bind(id).first()) !== null;
}

async function putShot(env: Env, id: string, picture: Picture): Promise<void> {
  try {
    await env.SHOTS.put(shotKey(id), picture.bytes, { httpMetadata: { contentType: picture.type } });
  } catch (error) {
    await env.DB.prepare("DELETE FROM reports WHERE id = ?").bind(id).run();
    throw error;
  }
}

async function readReport(form: FormData): Promise<{ readonly said: Said; readonly picture: Picture | null } | Refused> {
  const names = [...form.keys()];
  if (names.some((name) => !PARTS.has(name)) || new Set(names).size !== names.length) return BAD;
  const reportPart = form.get("report");
  if (reportPart === null) return BAD;
  const fields = parsed(await textOf(reportPart));
  if (fields === null) return BAD;
  const { v, id, text, email, about, device } = fields;
  if (v !== 1 || typeof id !== "string" || !UUID_V4.test(id)) return BAD;
  if (typeof text !== "string" || text.length === 0 || (email !== null && typeof email !== "string")) return BAD;
  if (typeof about !== "string" || !ABOUTS.has(about) || typeof device !== "string" || !DEVICES.has(device)) return BAD;
  if ([...text].length > LIMITS.text_chars || (email !== null && [...email].length > LIMITS.email_chars)) return LARGE;
  const attached: Partial<Record<Kind, string>> = {};
  for (const kind of KINDS) {
    const part = form.get(kind);
    if (part === null) continue;
    if (bytesOf(part) > LIMITS.attachment_bytes) return LARGE;
    attached[kind] = await textOf(part);
  }
  const said: Said = { v, id, text, email, about, device, attached };
  const screenshot = form.get("screenshot");
  if (screenshot === null) return { said, picture: null };
  if (typeof screenshot === "string") return BAD;
  if (screenshot.size > LIMITS.screenshot_bytes) return LARGE;
  const bytes = await screenshot.arrayBuffer();
  const type = pictureType(new Uint8Array(bytes, 0, Math.min(8, bytes.byteLength)));
  return type === null ? NOT_A_PICTURE : { said, picture: { bytes, type } };
}

function parsed(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const fields = value as Record<string, unknown>;
    const keys = Object.keys(fields);
    return keys.length === REPORT_FIELDS.size && keys.every((key) => REPORT_FIELDS.has(key)) ? fields : null;
  } catch {
    return null;
  }
}

async function textOf(part: File | string): Promise<string> {
  return typeof part === "string" ? part : part.text();
}

function bytesOf(part: File | string): number {
  return typeof part === "string" ? new TextEncoder().encode(part).byteLength : part.size;
}

function pictureType(head: Uint8Array): Picture["type"] | null {
  const starts = (magic: readonly number[]): boolean => magic.every((byte, at) => head[at] === byte);
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  return null;
}

export function senderOf(address: string | null): string {
  return prefixOf(address, 4);
}

export function networkOf(address: string | null): string {
  return prefixOf(address, 3);
}

function prefixOf(address: string | null, groupsKept: 3 | 4): string {
  if (address === null || address === "") return "unknown";
  if (!address.includes(":")) return address;
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const before = head === "" ? [] : head.split(":");
  const after = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = [...before, ...Array<string>(Math.max(0, 8 - before.length - after.length)).fill("0"), ...after];
  return `${groups.slice(0, groupsKept).map((group) => group.replace(/^0+(?=.)/u, "")).join(":")}::/${groupsKept * 16}`;
}

function shotKey(id: string): string {
  return `shots/${id}.jpg`;
}

async function shot(_request: Request, env: Env, url: URL): Promise<Response> {
  const id = SHOT_PATH.exec(url.pathname)?.[1] ?? "";
  const object = UUID_V4.test(id) ? await env.SHOTS.get(shotKey(id)) : null;
  if (object === null) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": SHOT_POLICY,
      "Cross-Origin-Resource-Policy": "same-origin",
    },
  });
}

async function list(_request: Request, env: Env, url: URL): Promise<Response> {
  const before = url.searchParams.get("before");
  const beforeId = url.searchParams.get("id");
  if ((before === null) !== (beforeId === null)) return new Response("Bad request", { status: 400 });
  if (before !== null && (!/^\d+$/u.test(before) || !UUID_V4.test(beforeId ?? ""))) return new Response("Bad request", { status: 400 });
  const query = before === null
    ? env.DB.prepare("SELECT id, at_ms, report, shot FROM reports ORDER BY at_ms DESC, id DESC LIMIT ?").bind(PAGE_SIZE + 1)
    : env.DB.prepare("SELECT id, at_ms, report, shot FROM reports WHERE (at_ms, id) < (?, ?) ORDER BY at_ms DESC, id DESC LIMIT ?")
      .bind(Number(before), beforeId ?? "", PAGE_SIZE + 1);
  const { results } = await query.all<Row>();
  const rows = results.slice(0, PAGE_SIZE);
  const kept = await Promise.all(rows.map(async (row) => row.shot === 1 && (await env.SHOTS.head(shotKey(row.id))) !== null));
  const older = results.length > PAGE_SIZE ? rows[rows.length - 1] ?? null : null;
  return new Response(page(rows, kept, older), {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": LIST_POLICY,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function page(rows: readonly Row[], kept: readonly boolean[], older: Row | null): string {
  const reports = rows.length === 0 ? "<p>No reports.</p>" : rows.map((row, at) => drawnOrNoted(row, kept[at] === true)).join("\n");
  const next = older === null ? "" : `<p><a href="/list?before=${older.at_ms}&amp;id=${escaped(older.id)}">Older</a></p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Feedback</title>
<style>
body { font: 15px/1.5 -apple-system, system-ui, sans-serif; max-width: 760px; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
article { border-top: 1px solid #ddd; padding: 1rem 0; }
.from { color: #6e6e73; font-size: 13px; }
.said { white-space: pre-wrap; overflow-wrap: anywhere; background: #fbf6e4; border: 1px dashed #b8a25c; padding: 0.25rem 0.5rem; }
span.said { padding: 0 0.25rem; }
pre.said { font: 12px/1.45 ui-monospace, monospace; padding: 0.5rem 0.75rem; margin: 0; }
.mark { color: #b3261e; font: 11px ui-monospace, monospace; }
h2 { font-size: 13px; margin: 0.75rem 0 0.25rem; }
img { max-width: 100%; border: 1px solid #ddd; margin-top: 0.75rem; }
</style>
</head>
<body>
<h1>Feedback</h1>
${reports}
${next}
</body>
</html>
`;
}

function drawnOrNoted(row: Row, shotKept: boolean): string {
  try {
    return drawn(row, shotKept);
  } catch {
    return `<article>\n<p class="from">${escaped(String(row.id))}</p>\n<p>This report could not be drawn.</p>\n</article>`;
  }
}

function drawn(row: Row, shotKept: boolean): string {
  const said = JSON.parse(row.report) as Said;
  const when = new Date(row.at_ms).toISOString().replace("T", " ").slice(0, 16);
  const from = [DEVICES.get(said.device) ?? said.device, ABOUTS.get(said.about) ?? said.about].map(escaped).join(" · ");
  const reply = said.email === null || said.email === ""
    ? "<p>No reply</p>"
    : `<p>Reply to <span class="said">${shown(said.email)}</span></p>`;
  const attachments = KINDS.flatMap((kind) => {
    const text = said.attached[kind];
    return text === undefined ? [] : [`<h2>${KIND_WORDS[kind]}</h2>\n<pre class="said">${shown(text)}</pre>`];
  });
  const picture = row.shot === 0
    ? []
    : [shotKept ? `<img src="/list/${escaped(row.id)}.jpg" alt="Screenshot">` : "<p>Screenshot deleted after 90 days</p>"];
  return [
    "<article>",
    `<p class="from">${when} UTC · ${from}</p>`,
    `<div class="said">${shown(said.text)}</div>`,
    reply,
    ...attachments,
    ...picture,
    "</article>",
  ].join("\n");
}

function shown(text: string): string {
  return escaped(text).replace(BIDI, (control) => `<span class="mark">[U+${control.codePointAt(0)?.toString(16).toUpperCase()}]</span>`);
}

function escaped(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => `&#${character.charCodeAt(0)};`);
}

function json(status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
