import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Acquirer, Lent, Secrets } from "../seams.js";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { valueAt, type Accounts, type SiteAccount } from "../shared/setup.js";
import { stationsOver, type ErrandSpec, type Signals } from "../shared/station.js";
import type { FakeElement, FakePage, Site, SiteAnswer, SiteRequest } from "../shared/dependencies.js";
import { NO_MEMORY } from "../shared/poll-run.js";

export type { FakeElement, FakePage, Site, SiteAnswer, SiteRequest };

export const PAGE_FILE_BYTES = 32 * 1024 * 1024;

export interface Refusal {
  op: string;
  code: string;
}

const NONE: Signals = { captcha: false, otp: false, password: false, verify: false };

function bodyBytes(body: SiteAnswer["body"]): Buffer {
  if (body === undefined) return Buffer.alloc(0);
  if (typeof body === "string") return Buffer.from(body, "utf8");
  if (body instanceof Uint8Array) return Buffer.from(body);
  return Buffer.from(JSON.stringify(body));
}
const REF_TOKEN = "5ca1ab";

export class FakeRelay {
  readonly errands: ErrandSpec[] = [];
  readonly waits: (number | undefined)[] = [];
  readonly requested: string[] = [];
  readonly fetches: string[][] = [];
  open = 0;
  refusals: Refusal[] = [];
  readonly filled = new Map<string, string>();
  offered: { id: string; signed_in: boolean | null; account?: SiteAccount | null }[] = [];
  offeredFor: string | undefined;
  readonly named: (string | undefined)[] = [];
  readonly chosen = new Set<string>();
  readonly busy = new Set<string>();
  readonly #files = new Map<string, string>();
  readonly #held = new Map<string, string>();
  readonly #dir = mkdtempSync(join(tmpdir(), "connect-door-files-"));
  #written = 0;
  #url = "about:blank";

  constructor(
    private readonly site: Site,
    private readonly token = "drive-token-synthetic",
  ) {}

  accounts: Accounts = {};
  start_ms: number | null = null;

  lend(acquirer: Acquirer): Acquirer {
    const lent = (secrets: Secrets, given: Lent | undefined): Lent => ({
      stations: stationsOver("https://door.example", this.token, { fetch: this.fetch, secrets }), accounts: this.accounts,
      start_ms: this.start_ms, from_ms: given?.from_ms, memory: given?.memory ?? NO_MEMORY,
    });
    const page = acquirer.page;
    return {
      ...acquirer, fetch: (state, secrets, given?: Lent) => acquirer.fetch(state, secrets, lent(secrets, given)),
      ...(page === undefined ? {} : { page: (state: JsonObject | null, secrets: Secrets, given?: Lent) => page.call(acquirer, state, secrets, lent(secrets, given)) }),
    };
  }

  #keep(name: string, bytes: Buffer): { name: string; bytes: number; sha256: string; path: string } {
    const path = join(this.#dir, String(this.errands.length), String(this.#written++));
    mkdirSync(join(this.#dir, String(this.errands.length)), { recursive: true });
    writeFileSync(path, bytes);
    this.#files.set(name, path);
    return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), path };
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (init?.headers === undefined || (init.headers as Record<string, string>).authorization !== `Bearer ${this.token}`) {
      return json(401, { code: "BAD_CALL", message: "the drive pass is wrong" });
    }
    const method = init.method ?? "GET";
    if (url.pathname === "/v1/sites" && method === "PUT") {
      const put = JSON.parse(String(init.body)) as { sites: FakeRelay["offered"]; station?: string };
      const before = new Map(this.offered.map((site) => [site.id, site]));
      this.offered = put.sites.map((site) => (site.signed_in === null ? { ...site, signed_in: before.get(site.id)?.signed_in ?? null, account: before.get(site.id)?.account ?? null } : site));
      this.offeredFor = put.station;
      const moved = (site: FakeRelay["offered"][number]) => (before.get(site.id)?.signed_in ?? null) !== site.signed_in || JSON.stringify(before.get(site.id)?.account ?? null) !== JSON.stringify(site.account ?? null);
      const changed = put.station === undefined ? {} : Object.fromEntries(this.offered.filter(moved).map((site) => [site.id, site.signed_in]));
      return json(200, { sites: this.offered.length, changed });
    }
    if (url.pathname === "/v1/sites" && method === "GET") return json(200, { sites: this.offered.map((site) => ({ ...site, chosen: this.chosen.has(site.id) })) });
    if (method === "POST" && url.pathname === "/v1/errands") {
      const { spec, wait_ms, station } = JSON.parse(String(init.body)) as { spec: ErrandSpec; wait_ms?: number; station?: string };
      this.errands.push(spec);
      this.named.push(station);
      this.waits.push(wait_ms);
      if (spec.origins.some((origin) => this.busy.has(origin))) return json(409, { code: "BUSY", message: `the station is busy with ${spec.origins.join(", ")}` });
      this.#files.clear();
      this.#held.clear();
      this.#url = "about:blank";
      this.open++;
      return json(200, { errand: `errand-${this.errands.length}`, station: { unit: "chrome-00000001", version: "0.0.0", slots: 4, errands: [], boot: "boot-0", running: [] } });
    }
    const errand = /^\/v1\/errands\/([^/]+)(\/.*)?$/u.exec(url.pathname);
    if (errand === null) return json(404, { code: "BAD_CALL", message: "no such route" });
    if (method === "DELETE") {
      this.open--;
      rmSync(join(this.#dir, String(this.errands.length)), { recursive: true, force: true });
      return json(200, {});
    }
    if (method === "GET" && errand[2]?.startsWith("/files/") === true) {
      const name = errand[2].slice("/files/".length).split("/").map(decodeURIComponent).join("/");
      const path = this.#files.get(name);
      return path === undefined ? json(404, { code: "BAD_CALL", message: `no file ${name}` }) : new Response(readFileSync(path));
    }
    const op = JSON.parse(String(init.body)) as { op: string; url?: string; requests?: { url: string; method?: string; body?: string; as: string; name?: string; headers?: Record<string, unknown>; hold?: { name: string; path: string } }[] };
    const refused = this.refusals.findIndex((refusal) => refusal.op === op.op);
    if (refused >= 0) {
      const [refusal] = this.refusals.splice(refused, 1);
      return json(200, { id: "call", ok: false, error: { code: refusal!.code, message: `the station refused ${op.op}` } });
    }
    const spec = this.errands.at(-1)!;
    const origin = spec.origins[0]!;
    const outside = (target: URL) => !spec.origins.includes(target.origin);
    if (op.op === "open" || op.op === "goto") {
      const target = new URL(op.url!);
      if (outside(target)) return json(200, { id: "call", ok: false, error: { code: "ORIGIN_REFUSED", message: `${target.origin} is not the errand's` } });
      this.#url = target.href;
      const sent = this.page().redirect;
      if (sent !== undefined) {
        const landed = new URL(sent, target);
        this.#url = landed.href;
        if (outside(landed)) return json(200, { id: "call", ok: false, error: { code: "ORIGIN_REFUSED", message: `the tab went to ${landed.origin}, outside the errand's origins` } });
      }
      const reached = new URL(this.#url).origin;
      return json(200, { id: "call", ok: true, value: op.op === "open" ? { tab: 1, url: reached } : { url: reached } });
    }
    if (op.op === "snapshot") return json(200, { id: "call", ok: true, value: this.#outline((op as { text?: boolean }).text === true) });
    if (["find", "click", "fill", "select", "wait"].includes(op.op)) return json(200, this.#act(op as unknown as PageOp, spec));
    if (op.op !== "fetch") return json(200, { id: "call", ok: false, error: { code: "BAD_CALL", message: `${op.op} is not faked` } });
    const admitted: { request: NonNullable<typeof op.requests>[number]; target: URL; headers: Record<string, string> }[] = [];
    const names = new Set<string>();
    for (const request of op.requests!) {
      const target = new URL(request.url, origin);
      if (outside(target)) return json(200, { id: "call", ok: false, error: { code: "ORIGIN_REFUSED", message: `${target.origin} is not the errand's` } });
      if (request.hold !== undefined && request.as === "file") return json(200, { id: "call", ok: false, error: { code: "BAD_CALL", message: "a request kept as a file holds no value" } });
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (typeof value === "string") headers[name] = value;
        else if ("secret" in (value as object)) {
          const given = value as { secret: string; value?: string };
          if (!(spec.secrets ?? []).includes(given.secret) || typeof given.value !== "string") return json(200, { id: "call", ok: false, error: { code: "SECRET_REFUSED", message: `the errand's spec does not name secret "${given.secret}"` } });
          this.filled.set(given.secret, given.value);
          headers[name] = given.value;
        } else if ("cookie" in (value as object)) {
          const { cookie, prefix } = value as { cookie: string; prefix?: string };
          if (!(spec.cookies ?? []).includes(cookie)) return json(200, { id: "call", ok: false, error: { code: "BAD_CALL", message: `cookie "${cookie}" is not the errand's` } });
          const jar = this.#url.startsWith("http") ? this.site.cookies?.(new URL(this.#url).origin) ?? {} : {};
          if (jar[cookie] !== undefined) headers[name] = `${prefix ?? ""}${jar[cookie]}`;
        } else {
          const held = value as { held: string; prefix?: string };
          const kept = this.#held.get(held.held);
          if (kept === undefined) return json(200, { id: "call", ok: false, error: { code: "BAD_CALL", message: `no value is held as "${held.held}"` } });
          headers[name] = `${held.prefix ?? ""}${kept}`;
        }
      }
      if (request.as === "file" && (this.#files.has(request.name!) || names.has(request.name!))) return json(200, { id: "call", ok: false, error: { code: "BAD_CALL", message: `the errand already has a file "${request.name}"` } });
      if (request.as === "file") names.add(request.name!);
      admitted.push({ request, target, headers });
    }
    this.fetches.push(admitted.map(({ target }) => target.pathname));
    const answers: unknown[] = [];
    const page = this.#url.startsWith("http") ? new URL(this.#url).origin : null;
    for (const { request, target, headers } of admitted) {
      if (page !== null && page !== target.origin && this.site.cors?.(page, target) === false) {
        answers.push({ status: 0, url: target.href, error: { code: "PAGE_ERROR", message: "Failed to fetch" } });
        continue;
      }
      this.requested.push(target.pathname + target.search);
      const answer = this.site.answer({ url: target, method: request.method ?? "GET", ...(request.body === undefined ? {} : { body: request.body }), headers });
      const bytes = bodyBytes(answer.body);
      const alone = (code: string, message: string) => answers.push({ status: 0, url: target.href, error: { code, message } });
      if (answer.failed === true) {
        alone("PAGE_ERROR", "Failed to fetch");
        continue;
      }
      if (answer.redirect !== undefined && outside(new URL(answer.redirect))) {
        alone("ORIGIN_REFUSED", `the request was redirected to ${new URL(answer.redirect).origin}`);
        continue;
      }
      const url = answer.redirect ?? target.href;
      if (request.as === "file") {
        if (bytes.length > PAGE_FILE_BYTES) {
          alone("TOO_LARGE", `the body is over ${PAGE_FILE_BYTES} bytes`);
          continue;
        }
        answers.push({ status: answer.status, url, file: this.#keep(request.name!, bytes) });
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(bytes.toString());
      } catch {
        parsed = undefined;
      }
      if (request.hold !== undefined) {
        const value = valueAt(parsed as Json | undefined, request.hold.path);
        if (typeof value === "string") {
          this.#held.set(request.hold.name, value);
          answers.push({ status: answer.status, url, held: request.hold.name });
        } else answers.push({ status: answer.status, url });
        continue;
      }
      answers.push(parsed === undefined ? { status: answer.status, url } : { status: answer.status, url, json: parsed });
    }
    return json(200, { id: "call", ok: true, value: answers });
  };

  page(): FakePage {
    return (this.#url.startsWith("http") ? this.site.page?.(new URL(this.#url)) : undefined) ?? { elements: [] };
  }

  #outline(text = false): { url: string; title: string; lines: string; signals: Signals; text?: string } {
    const page = this.page();
    const lines = page.elements
      .flatMap((element, index) => element.role === "text" ? [] : [`[${REF_TOKEN}:e${index}] ${element.role} "${element.name}"${element.checked === undefined ? "" : element.checked ? " checked" : " unchecked"}${element.level === undefined ? "" : ` level=${element.level}`}${element.href === undefined ? "" : ` -> ${element.href}`}`])
      .join("\n");
    const outline = { url: this.#url, title: page.title ?? "Synthetic", lines, signals: { ...NONE, ...this.site.signals, ...page.signals } };
    return text ? { ...outline, text: page.elements.map((element) => element.label ?? element.name).join(" ") } : outline;
  }

  #act(op: PageOp, spec: ErrandSpec): unknown {
    const failed = (code: string, message: string) => ({ id: "call", ok: false, error: { code, message, snapshot: this.#outline() } });
    const ok = (value: unknown) => ({ id: "call", ok: true, value });
    const page = this.page();
    if (op.op === "wait") {
      const wanted = op.for!;
      const done =
        wanted.url !== undefined
          ? new RegExp(wanted.url, "u").test(this.#url)
          : wanted.gone !== undefined
            ? !page.elements.some((element) => matches(element, wanted.gone!))
            : wanted.any !== undefined
              ? wanted.any.some((one) => page.elements.some((element) => matches(element, one)))
              : page.elements.some((element) => matches(element, wanted));
      return done ? ok(this.#outline()) : failed("TIMEOUT", "the wait did not finish in time");
    }
    const found = page.elements.map((element, index) => ({ element, index })).filter(({ element }) => matches(element, op.target!));
    if (op.op === "find") {
      return ok(found.map(({ element, index }) => ({ ref: `e${index}`, role: element.role, name: element.name, ...(element.checked === undefined ? {} : { checked: element.checked }) })));
    }
    if (found.length === 0) return failed("NOT_FOUND", "no element matches the locator");
    if (found.length > 1) return failed("AMBIGUOUS", `${found.length} elements match the locator`);
    const element = found[0]!.element;
    if (op.op === "click") {
      if (element.role === "checkbox") element.checked = element.checked !== true;
      if (element.role === "radio") element.checked = true;
      const next = element.click?.();
      if (typeof next === "string") this.#url = new URL(next, this.#url).href;
      return ok({ url: new URL(this.#url).origin });
    }
    if (op.op === "select") {
      element.value = op.option!;
      return ok({ selected: op.option });
    }
    const value = op.value!;
    if (typeof value === "string") element.value = value;
    else {
      if (!(spec.secrets ?? []).includes(value.secret) || typeof value.value !== "string" || value.value === "") return failed("SECRET_REFUSED", `the errand's spec does not name secret "${value.secret}"`);
      this.filled.set(value.secret, value.value);
      element.value = value.value;
    }
    return ok({ filled: true });
  }
}

type Locator = { role?: string; name?: string; exact?: boolean; label?: string; text?: string; css?: string };
type PageOp = { op: string; target?: Locator; value?: string | { secret: string; value?: string }; option?: string; for?: Locator & { url?: string; gone?: Locator; any?: Locator[] } };

const named = (actual: string, wanted: string | undefined, exact: boolean | undefined): boolean =>
  wanted === undefined || (exact === true ? actual === wanted : actual.toLowerCase().includes(wanted.toLowerCase()));

function matches(element: FakeElement, target: Locator): boolean {
  if (target.css !== undefined) {
    const wanted = /^a\[href\*="([^"]+)"\]$/u.exec(target.css)?.[1];
    if (wanted === undefined) throw new Error(`the fake station reads no css selector but a[href*="…"]: ${target.css}`);
    return element.role === "link" && element.href !== undefined && element.href.includes(wanted);
  }
  if (target.label !== undefined) return element.label !== undefined && named(element.label, target.label, false);
  if (target.text !== undefined) return named(element.name, target.text, false);
  return element.role === target.role && named(element.name, target.name, target.exact);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
