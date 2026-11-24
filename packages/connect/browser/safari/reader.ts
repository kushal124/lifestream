import { appleInstant, each, isObject, openDeliveredSqlite, ordered, refuse, requireColumns, rowJson, spanOf, tryInstant, unitOf, type Delivery, type Json, type JsonObject, type Reader, type ReaderOutput, type ReaderView, type Sqlite } from "@lifestreamprotocol/connect/sdk";

export const PAGE_VISIT = "page-visit";
export const TAB = "tab";
export const TOMBSTONE = "tombstone";
export const HISTORY_FILE = "history.sqlite";
export const TABS_FILE = "cloudtabs.sqlite";

const VISITED_ITEM = ["id", "url", "domain_expansion"];

const HISTORY_TABLES: Record<string, string[]> = {
  history_visits: ["id", "history_item", "visit_time"],
  history_items: VISITED_ITEM,
  history_tombstones: ["id", "start_time", "end_time", "url"],
};
const TABS_TABLES: Record<string, string[]> = {
  cloud_tabs: ["tab_uuid", "device_uuid", "last_viewed_time"],
  cloud_tab_devices: ["device_uuid"],
  cloud_tab_close_requests: ["tab_uuid"],
};

interface Tombstone {
  id: string;
  start: number;
  end: number;
  url: string | null;
}

export const safariHistory: Reader = {
  name: "safari-history",
  kinds: { [PAGE_VISIT]: visitGuard, [TAB]: tabGuard, [TOMBSTONE]: tombstoneGuard },
  async *read(delivery, files, view) {
    const device = unitOf(delivery.source);
    const stores = [HISTORY_FILE, TABS_FILE].flatMap((path) => delivery.files.filter((file) => file.path === path));
    yield* each(stores, (file) => file.path, async function* (file) {
      const db = await openDeliveredSqlite(files, file);
      try {
        yield* file.path === HISTORY_FILE ? history(db, delivery, device, view) : cloudTabs(db, device);
      } finally {
        db.close();
      }
    });
  },
};

async function* history(db: Sqlite, delivery: Delivery, device: string, view: ReaderView | undefined): AsyncGenerator<ReaderOutput> {
  requireColumns(db, HISTORY_FILE, HISTORY_TABLES);
  const own: Stated = { tombstones: [], keys: new Set() };
  yield* tombstones(db, device, own);
  const later = view === undefined ? [] : laterTombstones(view, delivery, own.keys);
  yield* each(db.rows("history_visits", "id"), (part) => part.where, function* (part) {
    const visit = part.read();
    const locator = `history_visits row ${String(visit.id)}`;
    const item = db.get(`SELECT ${VISITED_ITEM.join(", ")} FROM history_items WHERE id = ?`, visit.history_item ?? null);
    const time = appleInstant(visit.visit_time, "apple-s", `${locator} visit_time`);
    const key = `${String(visit.id)}:${String(visit.visit_time)}`;
    if (time !== undefined && names(later, item?.url, visit.visit_time as number) !== undefined) {
      yield { kind: PAGE_VISIT, key, content: null, gone: true, device, locator };
      return;
    }
    yield {
      kind: PAGE_VISIT, key,
      content: { type: "safari.visit", visit: rowJson(visit), item: item === undefined ? null : rowJson(item) },
      ...(time === undefined ? {} : { time }), device, locator,
    };
  });
  yield* deletions(db, delivery.source, device, view, own.tombstones);
}

interface Stated {
  tombstones: Tombstone[];
  keys: Set<string>;
}

function laterTombstones(view: ReaderView, delivery: Delivery, own: Set<string>): Tombstone[] {
  const later: Tombstone[] = [];
  for (const head of view.heads(delivery.source, TOMBSTONE)) {
    if (head.stated_ms <= delivery.stated_ms || own.has(head.key)) continue;
    const tombstone = matching((view.version(head.version).content as { tombstone: JsonObject }).tombstone);
    if (tombstone !== undefined) later.push(tombstone);
  }
  return later;
}

function matching(row: { id?: unknown; start_time?: unknown; end_time?: unknown; url?: unknown }): Tombstone | undefined {
  if (typeof row.url !== "string" && row.url !== null) return undefined;
  return { id: String(row.id), start: row.start_time as number, end: row.end_time as number, url: row.url };
}

function names(tombstones: Tombstone[], url: unknown, at: number): Tombstone | undefined {
  return tombstones.find((tombstone) => (tombstone.url === null || tombstone.url === url) && at >= tombstone.start && at <= tombstone.end);
}

async function* cloudTabs(tabs: Sqlite, device: string): AsyncGenerator<ReaderOutput> {
  requireColumns(tabs, TABS_FILE, TABS_TABLES);
  yield* each(tabs.rows("cloud_tabs", "tab_uuid"), (part) => part.where, function* (part) {
    const tab = part.read();
    const locator = `cloud_tabs ${String(tab.tab_uuid)}`;
    const owner = tabs.get("SELECT * FROM cloud_tab_devices WHERE device_uuid = ?", tab.device_uuid ?? null);
    const closing = tabs.all("SELECT * FROM cloud_tab_close_requests WHERE tab_uuid = ?", tab.tab_uuid ?? null).map(rowJson);
    const time = appleInstant(tab.last_viewed_time, "apple-s", `${locator} last_viewed_time`);
    yield {
      kind: TAB, key: typeof tab.tab_uuid === "string" ? tab.tab_uuid : "",
      content: { type: "safari.tab", tab: rowJson(tab), device: owner === undefined ? null : rowJson(owner), close_requests: ordered(closing) },
      ...(time === undefined ? {} : { time }), device, locator,
    };
  });
}

async function* tombstones(db: Sqlite, device: string, own: Stated): AsyncGenerator<ReaderOutput> {
  yield* each(db.rows("history_tombstones", "id"), (part) => part.where, function* (part) {
    const row = part.read();
    const locator = `history_tombstones row ${String(row.id)}`;
    if (typeof row.start_time !== "number" || typeof row.end_time !== "number") refuse(`${locator} states a span that is not two numbers`);
    if (row.url !== null && typeof row.url !== "string" && !Buffer.isBuffer(row.url)) refuse(`${locator} states a url that is neither text, bytes nor null`);
    const start = tryInstant(row.start_time, "apple-s");
    const end = tryInstant(row.end_time, "apple-s");
    const time = start === undefined || end === undefined ? undefined : spanOf(start, end, `${locator} span`);
    const key = `${String(row.id)}:${String(row.start_time)}`;
    yield { kind: TOMBSTONE, key, content: { type: "safari.tombstone", tombstone: rowJson(row) }, ...(time === undefined ? {} : { time }), device, locator };
    own.keys.add(key);
    const tombstone = matching(row);
    if (tombstone !== undefined) own.tombstones.push(tombstone);
  });
}

async function* deletions(db: Sqlite, source: string, device: string, view: ReaderView | undefined, tombstones: Tombstone[]): AsyncGenerator<ReaderOutput> {
  if (tombstones.length === 0) return;
  if (view === undefined) refuse("a tombstone names visits by URL and time, and the home gave no view of the visits it holds");
  const earliest = Math.min(...tombstones.map((tombstone) => tombstone.start));
  const latest = Math.max(...tombstones.map((tombstone) => tombstone.end));
  const range = { ...bound("start_ms", earliest), ...bound("end_ms", latest, 1) };
  for (const { head, version } of view.records(source, PAGE_VISIT, range)) {
    const content = version.content as JsonObject;
    const visit = isObject(content.visit) ? content.visit : undefined;
    const url = isObject(content.item) && typeof content.item.url === "string" ? content.item.url : undefined;
    if (visit === undefined || typeof visit.visit_time !== "number" || typeof visit.id !== "number") continue;
    const at = visit.visit_time;
    const named = names(tombstones, url, at);
    if (named === undefined) continue;
    if (db.get("SELECT 1 AS held FROM history_visits WHERE id = ? AND visit_time = ?", visit.id ?? null, at) !== undefined) continue;
    yield { kind: PAGE_VISIT, key: head.key, content: null, gone: true, device, locator: `history_tombstones row ${named.id}` };
  }
}

function bound(edge: "start_ms" | "end_ms", seconds: number, pad = 0): Record<string, number> {
  const at = tryInstant(seconds, "apple-s");
  return at === undefined ? {} : { [edge]: at.start_ms + pad };
}

function visitGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "item,type,visit") return ["members must be exactly type, visit, item"];
  const problems: string[] = [];
  if (content.type !== "safari.visit") problems.push("type must be safari.visit");
  if (!isObject(content.visit) || typeof content.visit.id !== "number" || (content.visit.visit_time !== null && typeof content.visit.visit_time !== "number")) {
    problems.push("visit must state an integer id and a numeric or null visit_time");
  }
  if (content.item !== null && !(isObject(content.item) && Object.keys(content.item).sort().join() === [...VISITED_ITEM].sort().join())) {
    problems.push(`item must be null or exactly ${VISITED_ITEM.join(", ")}`);
  }
  return problems;
}

function tombstoneGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "tombstone,type") return ["members must be exactly type, tombstone"];
  const problems: string[] = [];
  if (content.type !== "safari.tombstone") problems.push("type must be safari.tombstone");
  const row = content.tombstone;
  if (!isObject(row) || typeof row.id !== "number" || typeof row.start_time !== "number" || typeof row.end_time !== "number") {
    problems.push("tombstone must state an integer id and a numeric start_time and end_time");
  } else if (row.url !== null && typeof row.url !== "string" && !(isObject(row.url) && typeof row.url.$bytes64 === "string")) {
    problems.push("tombstone url must be text, null or $bytes64");
  }
  return problems;
}

function tabGuard(content: Json): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "close_requests,device,tab,type") {
    return ["members must be exactly type, tab, device, close_requests"];
  }
  const problems: string[] = [];
  if (content.type !== "safari.tab") problems.push("type must be safari.tab");
  if (!isObject(content.tab) || typeof content.tab.tab_uuid !== "string" || content.tab.tab_uuid === "" || typeof content.tab.url !== "string") {
    problems.push("tab must state a non-empty tab_uuid and its url");
  }
  if (content.device !== null && !isObject(content.device ?? null)) problems.push("device must be a row or null");
  if (!Array.isArray(content.close_requests) || !content.close_requests.every(isObject)) problems.push("close_requests must be rows");
  return problems;
}
