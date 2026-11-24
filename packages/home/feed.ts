import type { IncomingMessage, ServerResponse } from "node:http";
import type Database from "better-sqlite3";
import type { HomeFile } from "./home-file.js";


export interface Position {
  seq: number;
  at_ms: number;
}

export function holds(db: Database.Database, place: Position): boolean {
  if (place.seq === 0) return place.at_ms === 0 && ((db.prepare("SELECT min(seq) FROM events").pluck().get() as number | null) ?? 1) <= 1;
  return db.prepare("SELECT at_ms FROM events WHERE seq = ?").pluck().get(place.seq) === place.at_ms;
}

export function newest(db: Database.Database): Position {
  return (db.prepare("SELECT seq, at_ms FROM events ORDER BY seq DESC LIMIT 1").get() as Position | undefined) ?? { seq: 0, at_ms: 0 };
}

export type FeedRead = "head" | { after: Position };

export type Page = { rows: Row[] } | { reset: Position };

interface Row {
  seq: number;
  at_ms: number;
  kind: string;
  key: string;
  detail: string | null;
}

export interface FeedReads {
  head(): Promise<Position | undefined>;
  page(after: Position): Promise<Page | undefined>;
}

export function readFeed(file: HomeFile, asked: FeedRead): Position | Page | undefined {
  if (asked === "head") return file.read(newest);
  const place = asked.after;
  return file.read((db) => db.transaction((): Page => holds(db, place)
    ? { rows: db.prepare("SELECT seq, at_ms, kind, key, detail FROM events WHERE seq > ? ORDER BY seq LIMIT ?").all(place.seq, SPAN) as Row[] }
    : { reset: newest(db) })());
}

export type Unwatch = () => void;

export interface Feed {
  follow(request: IncomingMessage, response: ServerResponse, still: () => boolean): Promise<void>;
  watch(kinds: readonly string[], woken: () => void): Promise<Unwatch | null>;
  following(): number;
  close(): void;
}

export type Beat = (tick: () => void) => () => void;

interface Reader {
  readonly response: ServerResponse;
  readonly still: () => boolean;
  place: Position | null;
  blocked: boolean;
  full: NodeJS.Timeout | null;
  closed: boolean;
}

const POLL_MS = 250;
const KEEPALIVE_MS = 15_000;
const BLOCKED_MS = 60_000;
const BEAT: Beat = (tick) => {
  const every = setInterval(tick, KEEPALIVE_MS);
  return () => clearInterval(every);
};
const SPAN = 500;
const POSITION = /^(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15})$/u;

interface Watcher {
  readonly kinds: ReadonlySet<string>;
  readonly woken: () => void;
}

export function openFeed(reads: FeedReads, log: (line: string) => void = () => undefined, beat: Beat = BEAT, added: () => void = () => undefined): Feed {
  const readers = new Set<Reader>();
  const watchers = new Set<Watcher>();
  let mark: Position | null = null;
  let marking: Promise<void> | null = null;
  let marks = 0;
  let timer: NodeJS.Timeout | undefined;
  let keepalive: (() => void) | undefined;
  let failing: string | null = null;
  let polling = false;
  let ended = false;

  const cut = (reader: Reader): void => {
    reader.closed = true;
    reader.response.destroy();
  };

  const send = (reader: Reader, text: string): void => {
    if (reader.closed || reader.response.write(text)) return;
    reader.blocked = true;
    reader.full ??= setTimeout(() => cut(reader), BLOCKED_MS);
  };

  const beatAll = (): void => {
    for (const reader of [...readers]) {
      if (reader.closed) continue;
      let admitted = false;
      try { admitted = reader.still(); } catch {}
      if (!admitted) cut(reader);
      else if (!reader.blocked) send(reader, ":\n\n");
    }
  };

  const reset = (reader: Reader, to: Position): void => {
    reader.place = { ...to };
    send(reader, `id: ${to.seq}:${to.at_ms}\nevent: reset\ndata: ${JSON.stringify(to)}\n\n`);
  };

  const pump = async (reader: Reader, at: Position): Promise<void> => {
    if (reader.closed) return;
    if (reader.place === null) { reader.place = { ...at }; return; }
    const place = reader.place;
    if (place.seq === at.seq) {
      if (place.at_ms !== at.at_ms) reset(reader, at);
      return;
    }
    while (!reader.blocked && !reader.closed) {
      const page = await reads.page({ ...place });
      if (page === undefined || reader.closed) return;
      if ("reset" in page) { reset(reader, page.reset); return; }
      for (const row of page.rows) {
        place.seq = row.seq;
        place.at_ms = row.at_ms;
        send(reader, `id: ${row.seq}:${row.at_ms}\ndata: {"seq":${row.seq},"at_ms":${row.at_ms},"kind":${JSON.stringify(row.kind)},` +
          `"key":${JSON.stringify(row.key)},"detail":${row.detail ?? "null"}}\n\n`);
      }
      if (page.rows.length < SPAN || place.seq >= at.seq) return;
    }
  };

  const wake = (kinds: ReadonlySet<string> | "all"): void => {
    for (const watcher of [...watchers]) {
      if (kinds === "all" || [...watcher.kinds].some((kind) => kinds.has(kind))) watcher.woken();
    }
  };

  const scan = async (at: Position): Promise<void> => {
    const era = marks;
    while (mark !== null && watchers.size > 0) {
      if (mark.seq === at.seq) {
        if (mark.at_ms === at.at_ms) return;
        mark = { ...at };
        return wake("all");
      }
      const page = await reads.page({ ...mark });
      if (page === undefined || era !== marks) return;
      if ("reset" in page) {
        mark = { ...page.reset };
        return wake("all");
      }
      const last = page.rows.at(-1);
      if (last !== undefined) mark = { seq: last.seq, at_ms: last.at_ms };
      wake(new Set(page.rows.map((row) => row.kind)));
      if (page.rows.length < SPAN || mark.seq >= at.seq) return;
    }
  };

  const unmark = (): void => {
    mark = null;
    marking = null;
    marks++;
  };

  const quiet = (): void => {
    if (watchers.size === 0) unmark();
    if (readers.size === 0 && watchers.size === 0) stop();
  };

  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    try {
      const following = [...readers];
      let at: Position | undefined;
      try {
        at = await reads.head();
        if (failing !== null) log(JSON.stringify({ at: new Date().toISOString(), feed: "readable" }));
        failing = null;
      } catch (error) {
        const message = (error as Error).message;
        if (failing !== message) log(JSON.stringify({ at: new Date().toISOString(), feed: "unreadable", message }));
        failing = message;
        return;
      }
      if (at === undefined) return;
      await Promise.all([
        ...following.filter((reader) => !reader.blocked && !reader.closed).map(async (reader) => {
          try { await pump(reader, at); } catch {}
        }),
        scan(at).catch(() => undefined),
      ]);
    } finally {
      polling = false;
    }
  };

  const stop = (): void => {
    clearInterval(timer);
    keepalive?.();
    timer = undefined; keepalive = undefined;
  };

  return {
    following: () => readers.size,
    async follow(request, response, still) {
      const url = new URL(request.url ?? "/", "http://door");
      const stated = typeof request.headers["last-event-id"] === "string" ? request.headers["last-event-id"] : url.searchParams.get("from");
      const match = stated === null ? null : POSITION.exec(stated.trim());
      if (stated !== null && match === null) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: "FEED_POSITION", message: "a position is <seq>:<at_ms>" }));
        return;
      }
      const head = match === null ? await reads.head().catch(() => undefined) : undefined;
      const reader: Reader = {
        response, still, blocked: false, full: null, closed: response.destroyed,
        place: match !== null ? { seq: Number(match[1]), at_ms: Number(match[2]) } : head === undefined ? null : { ...head },
      };
      if (reader.closed) return;
      if (ended) {
        response.end();
        return;
      }
      let admitted = false;
      try { admitted = still(); } catch {}
      if (!admitted) {
        response.statusCode = 403;
        response.destroy();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      response.write("retry: 1000\n\n");
      readers.add(reader);
      added();
      response.on("drain", () => {
        reader.blocked = false;
        if (reader.full !== null) clearTimeout(reader.full);
        reader.full = null;
        void poll();
      });
      response.on("close", () => {
        reader.closed = true;
        if (reader.full !== null) clearTimeout(reader.full);
        readers.delete(reader);
        quiet();
      });
      timer ??= setInterval(() => void poll(), POLL_MS);
      keepalive ??= beat(beatAll);
      void poll();
    },
    async watch(kinds, woken) {
      if (ended) return null;
      const watcher: Watcher = { kinds: new Set(kinds), woken };
      const unwatch: Unwatch = () => {
        if (watchers.delete(watcher)) quiet();
      };
      watchers.add(watcher);
      if (mark === null) {
        if (marking === null) {
          const era = marks;
          const placing: Promise<void> = reads.head().then((head) => {
            if (head !== undefined && era === marks && watchers.size > 0) mark = { ...head };
          }, () => undefined).finally(() => {
            if (marking === placing) marking = null;
          });
          marking = placing;
        }
        await marking;
      }
      if (mark === null || ended || !watchers.has(watcher)) {
        unwatch();
        return null;
      }
      timer ??= setInterval(() => void poll(), POLL_MS);
      return unwatch;
    },
    close() {
      ended = true;
      stop();
      for (const reader of readers) { reader.closed = true; reader.response.end(); }
      readers.clear();
      watchers.clear();
      unmark();
    },
  };
}
