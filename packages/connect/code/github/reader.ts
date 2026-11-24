import { each, instantOf, isObject, readJson, refuse, sourceName, utf8, type Guard, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const PULL_FORMAT = "org.lifestreamprotocol.github-api-pull/0.1";
export const PULL_MANIFEST = "pull.json";

export const PAGES = ["user", "repos", "branches", "commits", "compare", "issues", "issue-comments", "review-comments", "reviews"] as const;
export type Page = (typeof PAGES)[number];

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const HEX = /^[0-9a-f]{64}$/u;

function guard(types: readonly string[], id: "sha" | "node_id"): Guard {
  return (content) => {
    if (!isObject(content)) return ["content must be an object"];
    const out: string[] = [];
    if (Object.keys(content).sort().join(",") !== "content,type") out.push("content must hold exactly type and content");
    if (typeof content.type !== "string" || !types.includes(content.type)) out.push(`type must be ${types.join(" or ")}`);
    const item = content.content;
    if (!isObject(item)) out.push("content.content must be an object");
    else if (typeof item[id] !== "string" || item[id] === "") out.push(`content.content must state ${id}`);
    return out;
  };
}

export const githubApi: Reader = {
  name: "github-api",
  kinds: {
    commit: guard(["github.commit"], "sha"),
    pr: guard(["github.pr"], "node_id"),
    issue: guard(["github.issue"], "node_id"),
    review: guard(["github.review"], "node_id"),
    comment: guard(["github.issue-comment", "github.review-comment"], "node_id"),
  },
  async *read(delivery, files) {
    const { product, account, copy } = sourceName(delivery.source);
    if (product !== "github" || copy !== "cloud") refuse(`${delivery.source} is not a github:<login>:cloud source`);
    const byPath = new Map(delivery.files.map((file) => [file.path, file]));
    const manifestFile = byPath.get(PULL_MANIFEST) ?? refuse(`an API pull holds ${PULL_MANIFEST}`);
    const manifest = pullManifest(json(files.bytes(manifestFile.blob), PULL_MANIFEST));
    if (manifest.account !== account) refuse(`the pull states account ${JSON.stringify(manifest.account)}, not the source's ${JSON.stringify(account)}`);
    const listed = new Set(manifest.pages.map((page) => page.file));
    for (const path of byPath.keys()) if (path !== PULL_MANIFEST && !listed.has(path)) refuse(`${path} is in the delivery but not in ${PULL_MANIFEST}`);
    const held = manifest.pages.map((page, index) => {
      const file = byPath.get(page.file) ?? refuse(`the pull lists ${page.file}, which the delivery does not hold`);
      if (file.blob !== `sha256:${page.sha256}` || file.size !== page.bytes) refuse(`${page.file} does not match the hash and size the pull states`);
      if (index === 0 && page.what !== "user") refuse(`${page.file}: a pull's first page is the token's user`);
      if (index > 0 && page.what === "user") refuse(`${page.file}: the user page must be the pull's first`);
      return { page, body: () => json(files.bytes(file.blob), page.file) };
    });
    const [token, ...pages] = held;
    if (token !== undefined) {
      const body = token.body();
      if (!isObject(body) || body.login !== account) refuse(`${token.page.file}: the token belongs to ${JSON.stringify(isObject(body) ? body.login : null)}, not ${JSON.stringify(account)}`);
    }
    yield* each(pages, ({ page }) => page.file, ({ page, body }) => pageRows(page, body(), account));
  },
};

interface ManifestPage {
  file: string;
  sha256: string;
  bytes: number;
  what: Page;
}

function pullManifest(value: Json): { account: string; pages: ManifestPage[] } {
  if (!isObject(value)) refuse(`${PULL_MANIFEST} is not an object`);
  if (value.format !== PULL_FORMAT || value.complete !== true) refuse(`${PULL_MANIFEST} is not a complete ${PULL_FORMAT} pull`);
  if (typeof value.account !== "string" || value.account.length === 0) refuse(`${PULL_MANIFEST} states no account`);
  if (!Array.isArray(value.pages)) refuse(`${PULL_MANIFEST} lists no pages`);
  const seen = new Set<string>();
  const pages = value.pages.map((entry, index): ManifestPage => {
    const where = `${PULL_MANIFEST} page ${index}`;
    if (!isObject(entry)) refuse(`${where} is not an object`);
    const { file, sha256, bytes, what } = entry;
    if (typeof file !== "string" || file.length === 0 || file === PULL_MANIFEST || seen.has(file)) refuse(`${where} names no file, or one already listed`);
    seen.add(file);
    if (typeof sha256 !== "string" || !HEX.test(sha256)) refuse(`${where} states no sha256`);
    if (typeof bytes !== "number" || !Number.isSafeInteger(bytes) || bytes < 0) refuse(`${where} states no byte count`);
    if (typeof what !== "string" || !(PAGES as readonly string[]).includes(what)) refuse(`${where} states what ${JSON.stringify(what)}, which this connector does not read`);
    return { file, sha256, bytes, what: what as Page };
  });
  return { account: value.account, pages };
}

function pageRows(page: ManifestPage, body: Json, account: string): AsyncGenerator<ReaderOutput> {
  const where = page.file;
  if (page.what === "compare") {
    if (!isObject(body) || !Array.isArray(body.commits)) refuse(`${where}: a comparison states no commits array`);
    return each(body.commits.entries(), ([index]) => `${where} commits[${index}]`, ([index, item]) => commitRow(object(item, `${where} commits[${index}]`), account, `${where} commits[${index}]`));
  }
  if (!Array.isArray(body)) refuse(`${where}: the ${page.what} page is not an array`);
  return each(body.entries(), ([index]) => `${where}[${index}]`, function* ([index, value]) {
    const at = `${where}[${index}]`;
    const item = object(value, at);
    switch (page.what) {
      case "repos":
      case "branches":
        break;
      case "commits":
        yield* commitRow(item, account, at);
        break;
      case "issues":
        if (wroteBy(item, "user", account)) yield issueRow(item, at);
        break;
      case "issue-comments":
      case "review-comments":
        if (wroteBy(item, "user", account)) yield ownRow("comment", page.what === "issue-comments" ? "github.issue-comment" : "github.review-comment", item, stated(item.created_at, `${at} created_at`), at);
        break;
      case "reviews":
        if (wroteBy(item, "user", account)) yield ownRow("review", "github.review", item, item.submitted_at === null || item.submitted_at === undefined ? undefined : stated(item.submitted_at, `${at} submitted_at`), at);
        break;
      default:
        refuse(`${where}: a ${page.what} page`);
    }
  });
}

function* commitRow(item: JsonObject, account: string, at: string): Generator<ReaderOutput> {
  if (!wroteBy(item, "author", account)) return;
  const sha = typeof item.sha === "string" && SHA.test(item.sha) ? item.sha : refuse(`${at}: states no commit SHA`);
  const commit = object(item.commit, `${at} commit`);
  const author = object(commit.author, `${at} commit.author`);
  yield { kind: "commit", key: sha, content: { type: "github.commit", content: item }, time: stated(author.date, `${at} commit.author.date`), locator: at };
}

function issueRow(item: JsonObject, at: string): ReaderOutput {
  const pr = item.pull_request !== undefined;
  const repository = isObject(item.repository) ? { repository: identity(item.repository) } : {};
  return ownRow(pr ? "pr" : "issue", pr ? "github.pr" : "github.issue", { ...item, ...repository }, stated(item.created_at, `${at} created_at`), at);
}

function identity(repository: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const name of ["id", "node_id", "full_name"]) if (repository[name] !== undefined) out[name] = repository[name]!;
  return out;
}

function ownRow(kind: string, type: string, item: JsonObject, time: Instant | undefined, at: string): ReaderOutput {
  const key = typeof item.node_id === "string" && item.node_id.length > 0 ? item.node_id : refuse(`${at}: states no node_id`);
  return { kind, key, content: { type, content: item }, ...(time === undefined ? {} : { time }), locator: at };
}

function wroteBy(item: JsonObject, member: "user" | "author", account: string): boolean {
  const user = item[member];
  return isObject(user) && user.login === account;
}

function stated(value: Json | undefined, where: string): Instant {
  if (typeof value !== "string") refuse(`${where} is not a time`);
  return instantOf(value, "rfc3339", where);
}

function object(value: Json | undefined, where: string): JsonObject {
  if (!isObject(value)) refuse(`${where} is not an object`);
  return value;
}

function json(bytes: Buffer, where: string): Json {
  return readJson(utf8(bytes, where), where);
}
