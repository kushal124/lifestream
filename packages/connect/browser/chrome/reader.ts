import { each, fingerprint, instantOf, isObject, openDeliveredSqlite, refuse, requireColumns, rowJson, span, unitOf, type Instant, type Json, type JsonObject, type Reader, type SqliteValue } from "@lifestreamprotocol/connect/sdk";

export const PAGE_VISIT = "page-visit";
export const SEARCH = "search";
export const DOWNLOAD = "download";
export const CHROME_FILE = "history.sqlite";

const UNIX_FROM_CHROME_US = 11_644_473_600_000_000n;

const VISITED_URL = ["id", "url", "title", "hidden"];

const REQUIRED: Record<string, string[]> = {
  visits: ["id", "url", "visit_time", "visit_duration"],
  urls: [...VISITED_URL, "visit_count", "typed_count", "last_visit_time"],
  keyword_search_terms: ["keyword_id", "url_id", "term", "normalized_term"],
  downloads: ["id", "guid", "start_time", "end_time"],
  downloads_url_chains: ["id", "chain_index", "url"],
};
const PER_VISIT = [
  { table: "visit_source", column: "id", member: "visit_source" },
  { table: "context_annotations", column: "visit_id", member: "context_annotations" },
  { table: "content_annotations", column: "visit_id", member: "content_annotations" },
] as const;

export const chromeHistory: Reader = {
  name: "chrome-history",
  kinds: { [PAGE_VISIT]: visitGuard, [SEARCH]: searchGuard, [DOWNLOAD]: downloadGuard },
  async *read(delivery, files) {
    const file = delivery.files.find((entry) => entry.path === CHROME_FILE);
    if (file === undefined) return;
    const device = unitOf(delivery.source);
    const db = await openDeliveredSqlite(files, file);
    try {
      requireColumns(db, CHROME_FILE, REQUIRED);
      const tables = new Set(db.tables());
      yield* each(db.rows("visits", "id"), (part) => part.where, function* (part) {
        const visit = part.read();
        const id = visit.id as bigint;
        const locator = `visits row ${id}`;
        const url = db.get(`SELECT ${VISITED_URL.map((column) => `"${column}"`).join(", ")} FROM urls WHERE id = ?`, visit.url ?? null);
        const content: JsonObject = { type: "chrome.visit", visit: rowJson(visit), url: url === undefined ? null : rowJson(url) };
        for (const { table, column, member } of PER_VISIT) {
          const found = tables.has(table) ? db.get(`SELECT * FROM ${table} WHERE ${column} = ?`, id) : undefined;
          content[member] = found === undefined ? null : rowJson(found);
        }
        yield { kind: PAGE_VISIT, key: `${id}:${String(visit.visit_time)}`, content, ...lasting(visit.visit_time, visit.visit_duration, locator), device, locator };
      });
      yield* each(db.rows("keyword_search_terms", "rowid"), (part) => part.where, function* (part) {
        const term = part.read();
        const locator = `keyword_search_terms url ${String(term.url_id)} keyword ${String(term.keyword_id)}`;
        const url = db.get("SELECT * FROM urls WHERE id = ?", term.url_id ?? null);
        const { rowid: _rowid, ...row } = term;
        const stated = rowJson(row);
        const key = fingerprint({ keyword_id: stated.keyword_id ?? null, term: stated.term ?? null, url: typeof url?.url === "string" ? url.url : null });
        const time = url === undefined ? undefined : chromeInstant(url.last_visit_time, locator);
        yield {
          kind: SEARCH, key,
          content: { type: "chrome.search", term: stated, url: url === undefined ? null : rowJson(url) },
          ...(time === undefined ? {} : { time }), device, locator,
        };
      });
      yield* each(db.rows("downloads", "id"), (part) => part.where, function* (part) {
        const download = part.read();
        const locator = `downloads row ${String(download.id)}`;
        const chain = db.all("SELECT * FROM downloads_url_chains WHERE id = ? ORDER BY chain_index", download.id!);
        const slices = tables.has("downloads_slices") ? db.all("SELECT * FROM downloads_slices WHERE download_id = ? ORDER BY offset", download.id!) : [];
        yield {
          kind: DOWNLOAD, key: typeof download.guid === "string" ? download.guid : "",
          content: { type: "chrome.download", download: rowJson(download), url_chain: chain.map(rowJson), slices: slices.map(rowJson) },
          ...lasting(download.start_time, subtract(download.end_time, download.start_time), locator), device, locator,
        };
      });
    } finally {
      db.close();
    }
  },
};

export function chromeInstant(value: SqliteValue | undefined, locator: string): Instant | undefined {
  if (typeof value !== "bigint" && typeof value !== "number") return refuse(`${locator} states a time that is not an integer`);
  const microseconds = BigInt(value);
  if (microseconds === 0n) return undefined;
  return instantOf(`${microseconds - UNIX_FROM_CHROME_US}e-6`, "unix-s", `${locator} time`);
}

function lasting(start: SqliteValue | undefined, length: SqliteValue | bigint | undefined, locator: string): { time?: Instant } {
  const began = chromeInstant(start, locator);
  if (began === undefined) return {};
  const microseconds = typeof length === "bigint" || typeof length === "number" ? BigInt(length) : 0n;
  if (microseconds <= 0n) return { time: began };
  const ended = chromeInstant(BigInt(start as bigint | number) + microseconds, locator)!;
  return { time: ended.start_ms > began.start_ms ? span(began, ended) : began };
}

function subtract(end: SqliteValue | undefined, start: SqliteValue | undefined): bigint | undefined {
  if ((typeof end !== "bigint" && typeof end !== "number") || (typeof start !== "bigint" && typeof start !== "number")) return undefined;
  return BigInt(end) === 0n ? undefined : BigInt(end) - BigInt(start);
}

function visitGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "content_annotations,context_annotations,type,url,visit,visit_source") {
    return ["members must be exactly type, visit, url, visit_source, context_annotations, content_annotations"];
  }
  const problems: string[] = [];
  if (content.type !== "chrome.visit") problems.push("type must be chrome.visit");
  if (!isObject(content.visit) || !integer(content.visit.id) || !integer(content.visit.url) || !integer(content.visit.visit_time)) {
    problems.push("visit must state integer id, url and visit_time");
  }
  if (content.url !== null && !(isObject(content.url) && Object.keys(content.url).sort().join() === [...VISITED_URL].sort().join())) {
    problems.push(`url must be null or exactly ${VISITED_URL.join(", ")}`);
  }
  for (const member of ["visit_source", "context_annotations", "content_annotations"]) {
    if (content[member] !== null && !isObject(content[member] ?? null)) problems.push(`${member} must be a row or null`);
  }
  return problems;
}

function searchGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "term,type,url") return ["members must be exactly type, term, url"];
  const problems: string[] = [];
  if (content.type !== "chrome.search") problems.push("type must be chrome.search");
  if (!isObject(content.term) || !integer(content.term.keyword_id) || !integer(content.term.url_id) || typeof content.term.term !== "string") {
    problems.push("term must state integer keyword_id and url_id, and its text");
  }
  if (content.url !== null && !(isObject(content.url) && integer(content.url.id))) problems.push("url must be a row or null");
  return problems;
}

function downloadGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "download,slices,type,url_chain") {
    return ["members must be exactly type, download, url_chain, slices"];
  }
  const problems: string[] = [];
  if (content.type !== "chrome.download") problems.push("type must be chrome.download");
  if (!isObject(content.download) || typeof content.download.guid !== "string" || content.download.guid === "") {
    problems.push("download must state a non-empty guid");
  }
  if (!Array.isArray(content.url_chain) || !content.url_chain.every((link) => isObject(link) && typeof link.url === "string")) {
    problems.push("url_chain must be rows stating a url");
  }
  if (!Array.isArray(content.slices) || !content.slices.every(isObject)) problems.push("slices must be rows");
  return problems;
}

function integer(value: Json | undefined): boolean {
  return (typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && /^-?\d+$/u.test(value));
}

