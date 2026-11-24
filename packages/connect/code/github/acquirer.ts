import { createHash } from "node:crypto";
import { afterStop, answered, feeds, isObject, isStop, movedEarlier, readJson, Refused, request, retryAfter, rfc3339, Stopped, utf8, type Acquirer, type Budget, type FetchedFile, type Json, type JsonObject, type Memory, type Secrets, type Stop } from "@lifestreamprotocol/connect/sdk";
import { PULL_FORMAT, PULL_MANIFEST, type Page } from "./reader.js";

function refuse(message: string): never {
  throw new Refused(`github-api: ${message}`);
}

export const API = "https://api.github.com";
const PER_POLL = 400;
const RESERVE = 500;
const PER_PAGE = 100;

export interface GithubApiSettings {
  login: string;
  token: string;
  per_poll?: number;
  reserve?: number;
}

export interface GithubApiState {
  polled_ms: number;
  issues: string | null;
  issues_held: string[];
}

export interface RepoEntry extends JsonObject {
  full_name: string;
  pushed_at: string | null;
  reading?: { branch: string; head: string; what: "compare" | "commits"; next: string };
}

export interface CommentsEntry extends JsonObject {
  issue?: string;
  issue_held?: string[];
  review?: string;
  review_held?: string[];
}

interface Reached {
  at: string | null;
  held: readonly string[];
}

export const REPO = "repo";
export const branchesOf = (id: string): string => `branch:${id}`;
export const COMMENTS = "comments";

export interface GithubApiDependencies {
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

export function githubApiAcquirer(settings: GithubApiSettings, dependencies: GithubApiDependencies = {}): Acquirer {
  const perPoll = settings.per_poll ?? PER_POLL;
  const reserve = settings.reserve ?? RESERVE;
  const secret = settings.token;
  const now = dependencies.now ?? Date.now;
  const login = settings.login;
  const source = `github:${login}:cloud`;
  return {
    name: "github-api",
    source,
    secrets: [secret],
    async fetch(state, secrets, lent) {
      if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/u.test(login)) refuse("login must be a GitHub login");
      if (!Number.isSafeInteger(perPoll) || perPoll < 8) refuse("per_poll must be a whole number, 8 or more");
      if (!Number.isSafeInteger(reserve) || reserve < 0) refuse("reserve must be a whole number");
      const previous = state as GithubApiState | null;
      const at = now();
      const fetchedAt = rfc3339(at);
      const token = secretOf(secrets, secret);
      const api = new Session(dependencies, token, { left: perPoll }, reserve);
      const since = lent.start_ms === null ? null : rfc3339(lent.start_ms, "s");
      const earlier = movedEarlier(lent) !== null;
      if (earlier) lent.memory.clear(COMMENTS);
      const next: GithubApiState = earlier || previous === null ? { polled_ms: at, issues: since, issues_held: [] } : { polled_ms: at, issues: previous.issues ?? since, issues_held: previous.issues_held };
      let stopped: Stop | undefined;
      const skipped: string[] = [];
      try {
        const user = await api.page("user", "/user");
        const stated = isObject(user.body) ? user.body.login : undefined;
        if (stated !== login) refuse(`the token belongs to ${JSON.stringify(stated ?? null)}, not ${JSON.stringify(login)}`);
        await issues(api, next, lent.memory, since);
        await commits(api, login, lent.memory, skipped, since);
      } catch (error) {
        if (!(error instanceof Stopped)) throw error;
        stopped = error.stop;
      }
      const after = afterStop(stopped, api.fresh, next as unknown as JsonObject, "GitHub");
      const stop = stopped === undefined ? {} : { stopped: stopped.stop === "limit" ? { reason: "rate-limit", resume_at: rfc3339(stopped.retry_ms) } : { reason: stopped.stop } };
      const manifest = { format: PULL_FORMAT, complete: true, account: login, fetched_at: fetchedAt, requests: api.requests, ...stop, pages: api.pages };
      const facts = { fetched_at: fetchedAt, account: login, pages: api.pages.length, requests: api.requests, ...stop, ...(skipped.length === 0 ? {} : { skipped }), ...feeds(source, "github-api") };
      if (!api.fresh) return { files: [], facts, state: next as unknown as JsonObject, ...after };
      return {
        files: [...api.files, { path: PULL_MANIFEST, bytes: Buffer.from(`${JSON.stringify(manifest)}\n`) }],
        facts,
        state: next as unknown as JsonObject,
        ...after,
      };
    },
  };
}

async function issues(api: Session, state: GithubApiState, memory: Memory, start: string | null): Promise<void> {
  const fresh = new Set<string>();
  const comments = async (repo: string, which: "issue" | "review"): Promise<void> => {
    if (fresh.has(`${which} ${repo}`)) return;
    const entry = (memory.get(COMMENTS, repo) as CommentsEntry | undefined) ?? {};
    const what = which === "issue" ? "issue-comments" : "review-comments";
    const list = which === "issue" ? "issues" : "pulls";
    const held = which === "issue" ? "issue_held" : "review_held";
    await since(api, what, (from) => `/repos/${repo}/${list}/comments?sort=updated&direction=asc&per_page=${PER_PAGE}${from}`, { at: entry[which] ?? start, held: entry[held] ?? [] }, (reached) => {
      entry[which] = reached.at!;
      entry[held] = [...reached.held];
      memory.put(COMMENTS, repo, entry);
    });
    fresh.add(`${which} ${repo}`);
  };
  const path = (from: string) => `/issues?filter=all&state=all&sort=updated&direction=asc&per_page=${PER_PAGE}${from}`;
  await since(api, "issues", path, { at: state.issues, held: state.issues_held }, (reached) => {
    state.issues = reached.at;
    state.issues_held = [...reached.held];
  }, async (item, where) => {
    const repo = repositoryOf(item, where);
    await comments(repo, "issue");
    if (item.pull_request === undefined) return;
    await comments(repo, "review");
    const number = Number.isSafeInteger(item.number) ? (item.number as number) : refuse(`${where} states no number`);
    await api.all("reviews", `/repos/${repo}/pulls/${number}/reviews?per_page=${PER_PAGE}`);
  });
}

async function since(
  api: Session,
  what: Page,
  path: (since: string) => string,
  from: Reached,
  keep: (reached: Reached) => void,
  each?: (item: JsonObject, where: string) => Promise<void>,
): Promise<void> {
  const sealed = new Set(from.held);
  let reached = from.at;
  let held = new Set(from.held);
  let link: string | undefined;
  for (;;) {
    const asked = reached;
    const page = await api.page(what, link ?? path(asked === null ? "" : `&since=${encodeURIComponent(asked)}`));
    if (!Array.isArray(page.body)) refuse(`${page.file}: the ${what} list is not an array`);
    for (const [index, value] of page.body.entries()) {
      const where = `${page.file}[${index}]`;
      const item = isObject(value) ? value : refuse(`${where} is not an object`);
      const updated = typeof item.updated_at === "string" ? item.updated_at : refuse(`${where} states no updated_at`);
      const id = typeof item.id === "number" || typeof item.id === "string" ? String(item.id) : refuse(`${where} states no id`);
      if (from.at === null || updated > from.at || (updated === from.at && !sealed.has(id))) api.fresh = true;
      await each?.(item, where);
      if (reached === null || updated > reached) {
        reached = updated;
        held = new Set([id]);
      } else if (updated === reached && !held.has(id)) held.add(id);
      else continue;
      keep({ at: reached, held: [...held] });
    }
    if (page.next === undefined) return;
    link = reached === asked ? page.next : undefined;
  }
}

async function commits(api: Session, login: string, memory: Memory, skipped: string[], since: string | null): Promise<void> {
  const listed = new Map<string, { full_name: string; default_branch: string | null; pushed_at: string | null }>();
  for (const page of await api.all("repos", `/user/repos?affiliation=owner,collaborator,organization_member&sort=full_name&per_page=${PER_PAGE}`)) {
    if (!Array.isArray(page.body)) refuse(`${page.file}: the repository list is not an array`);
    for (const [index, value] of page.body.entries()) {
      const repo = isObject(value) ? value : refuse(`${page.file}[${index}] is not an object`);
      const id = typeof repo.id === "number" || typeof repo.id === "string" ? String(repo.id) : refuse(`${page.file}[${index}] states no id`);
      const full = typeof repo.full_name === "string" && /^[^/\s]+\/[^/\s]+$/u.test(repo.full_name) ? repo.full_name : refuse(`${page.file}[${index}] states no full_name`);
      listed.set(id, { full_name: full, default_branch: typeof repo.default_branch === "string" ? repo.default_branch : null, pushed_at: typeof repo.pushed_at === "string" ? repo.pushed_at : null });
    }
  }
  for (const [id] of every(memory, REPO)) {
    if (listed.has(id)) continue;
    memory.drop(REPO, id);
    memory.clear(branchesOf(id));
  }
  for (const [id, repo] of [...listed].sort(([, a], [, b]) => (a.full_name < b.full_name ? -1 : 1))) {
    const known = memory.get(REPO, id) as RepoEntry | undefined;
    if (known !== undefined && known.pushed_at === repo.pushed_at && known.full_name === repo.full_name) continue;
    const entry: RepoEntry = { ...(known ?? { pushed_at: null }), full_name: repo.full_name };
    const branches = branchesOf(id);
    try {
      if (repo.pushed_at === null) continue;
      const pages = await api.all("branches", `/repos/${repo.full_name}/branches?per_page=${PER_PAGE}`, true);
      if (pages === null) {
        skipped.push(repo.full_name);
        continue;
      }
      const heads = new Map<string, string>();
      for (const page of pages) {
        if (!Array.isArray(page.body)) refuse(`${page.file}: the branch list is not an array`);
        for (const [index, value] of page.body.entries()) {
          const branch = isObject(value) && typeof value.name === "string" && isObject(value.commit) && typeof value.commit.sha === "string" ? value : refuse(`${page.file}[${index}] states no name and head`);
          heads.set(branch.name as string, (branch.commit as JsonObject).sha as string);
        }
      }
      const main = repo.default_branch === null ? undefined : heads.get(repo.default_branch);
      const cut = entry.reading?.branch;
      for (const name of [...heads.keys()].sort((a, b) => (a === cut ? -1 : b === cut ? 1 : a < b ? -1 : 1))) {
        const head = heads.get(name)!;
        const old = memory.get(branches, name) as string | undefined;
        if (old === head) continue;
        await branch(api, login, repo.full_name, entry, name, head, old, name === repo.default_branch ? undefined : main, since);
        memory.put(branches, name, head);
      }
      for (const [name] of every(memory, branches)) if (!heads.has(name)) memory.drop(branches, name);
      delete entry.reading;
      entry.pushed_at = repo.pushed_at;
    } finally {
      memory.put(REPO, id, entry);
    }
  }
}

function* every(memory: Memory, part: string): Generator<readonly [string, Json]> {
  for (let page = memory.list(part); page.length > 0; page = memory.list(part, page.at(-1)![0])) yield* page;
}

async function branch(api: Session, login: string, repo: string, entry: RepoEntry, name: string, head: string, old: string | undefined, main: string | undefined, since: string | null): Promise<void> {
  api.fresh = true;
  const keep = (what: "compare" | "commits") => (next: string | undefined) => {
    if (next !== undefined) entry.reading = { branch: name, head, what, next };
    else if (entry.reading?.branch === name) delete entry.reading;
  };
  const reading = entry.reading;
  if (reading?.branch === name) {
    if (reading.head === head) {
      await api.chain(reading.what, reading.next, keep(reading.what));
      return;
    }
    delete entry.reading;
  }
  const compare = (base: string) => api.chain("compare", `/repos/${repo}/compare/${base}...${head}?per_page=${PER_PAGE}`, keep("compare"), true);
  if (old !== undefined && (await compare(old))) return;
  if (main !== undefined && (main === head || (await compare(main)))) return;
  await api.chain("commits", `/repos/${repo}/commits?sha=${head}&author=${encodeURIComponent(login)}${since === null ? "" : `&since=${encodeURIComponent(since)}`}&per_page=${PER_PAGE}`, keep("commits"));
}

function repositoryOf(item: JsonObject, where: string): string {
  const url = typeof item.repository_url === "string" ? item.repository_url : refuse(`${where} states no repository_url`);
  const match = /^https:\/\/api\.github\.com\/repos\/([^/\s?#]+\/[^/\s?#]+)$/u.exec(url) ?? refuse(`${where}: repository_url is not a repository on GitHub's API`);
  return match[1]!;
}

interface Sealed {
  file: string;
  body: Json;
  next: string | undefined;
}

class Session {
  readonly files: FetchedFile[] = [];
  readonly pages: JsonObject[] = [];
  requests = 0;
  fresh = false;
  #low: number | undefined;
  readonly #now: () => number;
  readonly dependencies: GithubApiDependencies;
  readonly token: string;
  readonly budget: Budget;
  readonly reserve: number;

  constructor(dependencies: GithubApiDependencies, token: string, budget: Budget, reserve: number) {
    this.dependencies = dependencies;
    this.token = token;
    this.budget = budget;
    this.reserve = reserve;
    this.#now = dependencies.now ?? Date.now;
  }

  all(what: Page, path: string): Promise<Sealed[]>;
  all(what: Page, path: string, missing: true): Promise<Sealed[] | null>;
  async all(what: Page, path: string, missing?: true): Promise<Sealed[] | null> {
    const pages: Sealed[] = [];
    for (let next: string | undefined = path; next !== undefined; ) {
      const page: Sealed | null = missing && pages.length === 0 ? await this.page(what, next, true) : await this.page(what, next);
      if (page === null) return null;
      pages.push(page);
      next = page.next;
    }
    return pages;
  }

  async chain(what: Page, path: string, keep: (next: string | undefined) => void, missing?: true): Promise<boolean> {
    for (let next: string | undefined = path, first = true; next !== undefined; first = false) {
      const page: Sealed | null = missing && first ? await this.page(what, next, true) : await this.page(what, next);
      if (page === null) return false;
      next = page.next;
      keep(next);
    }
    return true;
  }

  page(what: Page, path: string): Promise<Sealed>;
  page(what: Page, path: string, missing: true): Promise<Sealed | null>;
  async page(what: Page, path: string, missing?: true): Promise<Sealed | null> {
    if (this.#low !== undefined) throw new Stopped({ stop: "limit", retry_ms: this.#low });
    const url = new URL(path, API);
    if (url.origin !== API) refuse(`a next link leaves GitHub's API: ${url.origin}`);
    const headers = { authorization: `Bearer ${this.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "lifestream-home" };
    const answer = await request(url, { method: "GET", headers }, { budget: this.budget, limited, ...this.dependencies });
    if (!isStop(answer) || answer.stop !== "budget") this.requests++;
    const response = answered(answer);
    const remaining = header(response, "x-ratelimit-remaining");
    const reset = header(response, "x-ratelimit-reset");
    if (missing && [403, 404, 422, 451].includes(response.status)) return null;
    if (!response.ok) refuse(`${what} ${url.pathname} answered HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const file = `page-${String(this.pages.length + 1).padStart(5, "0")}.json`;
    const body = readJson(utf8(bytes, file), file);
    this.files.push({ path: file, bytes });
    this.pages.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, what, request: `${url.pathname}${url.search}` });
    if (remaining !== undefined && remaining <= this.reserve) this.#low = reset === undefined ? this.#now() + 60 * 60_000 : reset * 1000;
    return { file, body, next: nextLink(response.headers.get("link")) };
  }
}

function limited(response: Response, now_ms: number): number | null {
  const retry = retryAfter(response, now_ms);
  if (!(response.status === 429 || (response.status === 403 && (header(response, "x-ratelimit-remaining") === 0 || retry !== undefined)))) return null;
  const reset = header(response, "x-ratelimit-reset");
  return retry ?? (reset === undefined ? now_ms + 60_000 : reset * 1000);
}

function header(response: Response, name: string): number | undefined {
  const value = response.headers.get(name);
  if (value === null) return undefined;
  return /^\d+$/u.test(value.trim()) ? Number(value.trim()) : undefined;
}

function nextLink(link: string | null): string | undefined {
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>\s*;\s*rel="next"\s*$/u.exec(part);
    if (match !== null) return match[1];
  }
  return undefined;
}

function secretOf(secrets: Secrets, service: string): string {
  const value = secrets.get(service);
  if (value === undefined || value.trim().length === 0) refuse(`no secret is stored for ${service}`);
  return value.trim();
}
