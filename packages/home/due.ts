import { canonical, civilDay, digest, selects, sourceName, type CalendarAdapter, type DaySettings, type HomeFolder, type JobRow, type Json, type SourceRow, type Tx } from "@lifestreamprotocol/core";
import type { Labeler } from "@lifestreamprotocol/connect";
import { LABELS_FAMILY, ownProducts, RENDERER_VERSION, type Family, type Given } from "@lifestreamprotocol/families";
import { openLedger, type Ledger, type Outcome } from "@lifestreamprotocol/model";
import {
  extractCursor, fingerprintKey, keptFingerprint, listDays, putBack, rebuildCursor, rebuildExtracts, walkFloor, type DaysRead, type Listed,
} from "./derive.js";
import { failpoint } from "./failpoint.js";
import { HANDED, HANDED_INPUTS, HANDED_KEY } from "./handed.js";
import { connectorOfJob, LANE, LIVE_MS, RECENT_MS, type Running } from "./jobs.js";
import { isWho, PEOPLE_FAMILIES, peopleProducts, whoProducts } from "./people.js";
import { PLACES_FAMILIES, placesReads } from "./places.js";
import { readerOf, type Inputs, type Loaded } from "./registry.js";
import { SCREEN_INDEX, SCREEN_KINDS } from "./screen-job.js";
import { screenRoles } from "./screen-source.js";
import { RECORD_INDEX, searchInputs } from "./search.js";
import type { Settings } from "./settings.js";
import { judgeThrough } from "./through.js";

export interface DueHome {
  readonly folder: HomeFolder;
  readonly settings: Settings;
  readonly registry: Loaded;
  readonly families: ReadonlyMap<string, Family>;
  now(): number;
  running(job: number): Running | undefined;
}

interface Consumer {
  cursor: string;
  kind: string;
  key: string;
  inputs: Inputs;
  family?: Family;
  own?: string;
  events?: readonly string[];
  forward?: boolean;
}

const PAGE = 500;

const REBUILD = rebuildCursor("");

export const LEDGER_CURSOR = "ledger";

export function familyFingerprint(family: Family, day: Pick<DaySettings, "zone" | "day_start_hour">): string {
  const { inputs, adapters, borrowed } = builtUnder(family);
  return digest({ code: family.code, inputs, adapters, borrowed, zone: day.zone, day_start_hour: day.day_start_hour });
}

function builtUnder(family: Family): { inputs: string[]; adapters: string[]; borrowed: string[] } {
  return {
    inputs: family.inputs.map((input) => canonical([input.sources as Json, [...input.kinds].sort(), input.role])).sort(),
    adapters: held(family.adapters ?? []),
    borrowed: Object.entries(family.borrowed ?? {}).map(([name, list]) => canonical([name, held(list)])).sort(),
  };
}

export const FINGERPRINT_PARTS = ["code", "inputs", "adapters", "borrowed", "zone", "day_start"] as const;
export type FingerprintPart = (typeof FINGERPRINT_PARTS)[number];

export function fingerprintParts(family: Family, day: Pick<DaySettings, "zone" | "day_start_hour">): Record<FingerprintPart, string> {
  const { inputs, adapters, borrowed } = builtUnder(family);
  return { code: family.code, inputs: canonical(inputs), adapters: canonical(adapters), borrowed: canonical(borrowed), zone: day.zone, day_start: String(day.day_start_hour) };
}

export function rebuildBegan(tx: Tx, family: string, generation: number, reason: readonly string[]): void {
  if ((tx.tables.cursors.get(rebuildCursor(family))?.seq ?? 0) === 0) return;
  tx.tables.meta.set(fingerprintKey(family), JSON.stringify({ ...keptFingerprint(tx, family), reason, generation }));
}

export function labelerFingerprint(reading: NonNullable<Labeler["reading"]>, families: readonly Family[]): string {
  const borrowed = [...new Set(reading.borrows)].sort().map((name) => canonical([name, held(families.find((family) => family.name === name)?.adapters ?? [])]));
  return digest({ code: reading.code, borrowed });
}

function held(list: readonly Given[]): string[] {
  return list.map((given) => {
    const word = (given.adapter as Partial<CalendarAdapter>).reminderWord;
    return canonical({
      product: given.product, name: given.name, vendor: given.vendor, type: given.type, digest: given.digest ?? null,
      adapter: { version: given.adapter.version, kinds: [...given.adapter.kinds].sort(), ...(typeof word === "string" ? { reminderWord: word } : {}) },
    });
  }).sort();
}

function productOf(source: string): string {
  return source.slice(0, source.indexOf(":"));
}
const NEVER = Number.MAX_SAFE_INTEGER;

export class Due {
  readonly #ledger: Ledger;
  readonly #consumers: readonly Consumer[];
  #looked = { version: -1, through: -1 };

  constructor(private readonly home: DueHome) {
    this.#ledger = openLedger(home.folder, { mode: "read" });
    const searched = searchInputs(home.registry.families);
    const screen = screenRoles(home.registry.families);
    this.#consumers = [
      ...home.registry.families.map((family) => ({ cursor: extractCursor(family.name), kind: "extract", key: family.name, inputs: family.inputs, family })),
      ...(home.registry.labelers ?? []).map((labeler) => ({
        cursor: `label:${labeler.name}`, kind: "label", key: labeler.name, inputs: labeler.inputs, own: labeler.source, ...(labeler.events === undefined ? {} : { events: labeler.events }),
      })),
      ...(searched.length === 0 ? [] : [{ cursor: RECORD_INDEX.name, kind: "index", key: RECORD_INDEX.name, inputs: searched }]),
      { cursor: HANDED, kind: HANDED, key: HANDED_KEY, inputs: HANDED_INPUTS },
      ...(screen === undefined ? [] : [{
        cursor: SCREEN_INDEX.name, kind: "index", key: SCREEN_INDEX.name, events: ["erase"], forward: true,
        inputs: [{ sources: screen.selector("frames", "prior"), kinds: SCREEN_KINDS }],
      }]),
    ];
  }

  close(): void {
    this.#ledger.close();
  }

  start(tx: Tx, read: DaysRead, parts: Record<string, number> = {}): Listed {
    const now = this.home.now();
    const { zone, day_start_hour } = this.home.settings.day;
    const timed = <T>(part: string, work: () => T): T => {
      const began = performance.now();
      try {
        return work();
      } finally {
        parts[`${part}_ms`] = Math.round(performance.now() - began);
      }
    };
    timed("fingerprints", () => {
      for (const family of this.home.registry.families) {
        const fingerprint = familyFingerprint(family, this.home.settings.day);
        const parts = fingerprintParts(family, this.home.settings.day);
        const kept = keptFingerprint(tx, family.name);
        if (tx.tables.cursors.get(extractCursor(family.name))?.fingerprint !== fingerprint) {
          const generation = rebuildExtracts(tx, family.name, now, fingerprint);
          const moved = kept?.parts === undefined ? [] : FINGERPRINT_PARTS.filter((part) => kept.parts![part] !== parts[part]);
          rebuildBegan(tx, family.name, generation, moved.length > 0 ? moved : ["unknown"]);
        }
        const keep = JSON.stringify({ ...keptFingerprint(tx, family.name), parts });
        if (keep !== tx.tables.meta.get(fingerprintKey(family.name))) tx.tables.meta.set(fingerprintKey(family.name), keep);
      }
      for (const labeler of this.home.registry.labelers ?? []) {
        if (labeler.reading === undefined) continue;
        const fingerprint = labelerFingerprint(labeler.reading, this.home.registry.families);
        if (tx.tables.cursors.get(`label:${labeler.name}`)?.fingerprint !== fingerprint) tx.tables.cursors.reset(`label:${labeler.name}`, fingerprint, now);
      }
    });
    timed("put_back", () => putBack(tx));
    const listed = timed("list", () => listDays(tx, read, now));
    const renderer = digest({ renderer: RENDERER_VERSION, zone, day_start_hour, families: this.home.registry.families.map((family) => family.name) });
    if (tx.tables.cursors.get("days")?.fingerprint !== renderer && "days" in listed) {
      tx.tables.dirty.days(listed.days);
      tx.tables.cursors.move("days", { at_ms: now, fingerprint: renderer });
    }
    timed("starts", () => {
      for (const { source, kind, start_ms } of tx.records.starts()) this.#start(tx, source, kind, start_ms, now);
    });
    timed("consumers", () => {
      for (const { kind, key } of this.#consumers) this.#enqueue(tx, kind, key, LANE.backfill, tx.tables.jobs.get(kind, key));
      for (const family of this.home.registry.families) {
        if ((tx.tables.cursors.get(rebuildCursor(family.name))?.seq ?? 0) > 0) this.#enqueue(tx, "walk", family.name, LANE.backfill, tx.tables.jobs.get("walk", family.name));
      }
    });
    timed("imports", () => {
      for (const source of tx.tables.sources.list()) this.#import(tx, source.id);
    });
    this.#enqueue(tx, "people", "people", LANE.live, tx.tables.jobs.get("people", "people"));
    this.#enqueue(tx, "places", "places", LANE.live, tx.tables.jobs.get("places", "places"));
    const place = tx.tables.cursors.get(LEDGER_CURSOR);
    const newest = this.#ledger.lastOutcome();
    if (place === undefined || newest < place.seq) {
      timed("asks", () => {
        for (const row of tx.tables.asks.pending()) this.#answered(tx, { ...row, reply_key: row.waits });
      });
      tx.tables.cursors.move(LEDGER_CURSOR, { seq: newest, at_ms: now });
    }
    timed("prune", () => this.#prune(tx));
    return listed;
  }

  after(tx: Tx): void {
    const { moved } = tx;
    const now = this.home.now();
    for (const source of new Set([...moved.deliveries, ...moved.custody])) judgeThrough(tx, source);
    for (const source of moved.deliveries) this.#import(tx, source);
    if (moved.sources.size > 0) this.#enqueue(tx, "index-inbox", "inbox", LANE.polls, tx.tables.jobs.get("index-inbox", "inbox"));
    let sources: SourceRow[] | undefined;
    const rows = () => (sources ??= tx.tables.sources.list());
    for (const consumer of this.#consumers) {
      const lane = this.#lane(tx, consumer, now, rows);
      if (lane !== undefined && consumer.forward === true) this.queueNow(tx, consumer.kind, consumer.key, lane);
      else if (lane !== undefined) this.#enqueue(tx, consumer.kind, consumer.key, lane, tx.tables.jobs.get(consumer.kind, consumer.key));
      else if (moved.reread > 0) this.#passed(tx, consumer, moved.reread, now);
    }
    this.#labels(tx, now);
    for (const name of moved.resets) {
      if (name.startsWith(REBUILD)) this.#enqueue(tx, "walk", name.slice(REBUILD.length), LANE.backfill, tx.tables.jobs.get("walk", name.slice(REBUILD.length)));
    }
    for (const [source, { before, after }] of moved.read) this.#read(tx, source, before, after, now);
    for (const { source, kind } of moved.heads.values()) this.#start(tx, source, kind, tx.records.start(source, kind), now);
    for (const row of moved.pending) this.#answered(tx, row);
    this.#days(tx, now);
    this.#plans(tx, now);
    this.#search(tx, now);
    this.#people(tx);
    this.#places(tx);
    if (moved.rereadsRead) this.#prune(tx);
  }

  #people(tx: Tx): void {
    const { moved } = tx;
    const products = peopleProducts(this.home.registry.families);
    const who = whoProducts(this.home.registry.families);
    const due = moved.events.has("erase") || [...moved.sources].some((source) => products.has(productOf(source))) || PEOPLE_FAMILIES.some((family) => moved.extracts.has(family))
      || [...moved.heads.values(), ...moved.rereads.values()].some((of) => "source" in of && isWho(productOf(of.source), of.kind))
      || [...moved.imported].some((source) => who.has(productOf(source)));
    if (due) this.#enqueue(tx, "people", "people", LANE.live, tx.tables.jobs.get("people", "people"));
  }

  #labels(tx: Tx, now: number): void {
    const { moved } = tx;
    if (moved.sources.size === 0) return;
    const labels = this.home.families.get(LABELS_FAMILY);
    if (labels === undefined) return;
    const own = new Set(ownProducts([...labels.borrowed?.messages ?? [], ...labels.borrowed?.mail ?? []]));
    if (![...moved.sources].some((source) => own.has(productOf(source)))) return;
    rebuildBegan(tx, LABELS_FAMILY, rebuildExtracts(tx, LABELS_FAMILY, now), ["own_account"]);
  }

  #places(tx: Tx): void {
    const { moved } = tx;
    const read = placesReads(this.home.settings.unit);
    if (PLACES_FAMILIES.some((family) => moved.extracts.has(family)) || moved.events.has("erase")
      || [...moved.heads.values()].some(({ source, kind }) => read.some((selector) => selector.kinds.includes(kind) && selects(selector.sources, sourceName(source))))) {
      this.#enqueue(tx, "places", "places", LANE.live, tx.tables.jobs.get("places", "places"));
    }
  }

  #search(tx: Tx, now: number): void {
    if (!this.#consumers.some((consumer) => consumer.cursor === RECORD_INDEX.name)) return;
    const days = [...tx.moved.rendered];
    if (days.length === 0) return;
    const recent = civilDay(now - RECENT_MS, this.home.settings.day);
    const lane = days.some((day) => day >= recent) ? LANE.live : LANE.backfill;
    this.#enqueue(tx, "index", RECORD_INDEX.name, lane, tx.tables.jobs.get("index", RECORD_INDEX.name));
  }

  watch(tx: Tx): void {
    const version = this.#ledger.dataVersion();
    const place = tx.tables.cursors.get(LEDGER_CURSOR)?.seq ?? 0;
    if (version === this.#looked.version && place === this.#looked.through) return;
    const items = this.#finished(place);
    for (const { family, item, revision: request, state, input_hash } of items) {
      if (family === null || !this.home.families.has(family)) continue;
      if (state === "replied") failpoint("reply.seen");
      for (const row of tx.tables.asks.woken(input_hash, request)) this.#wake(tx, row.family, row.unit);
      for (const row of tx.tables.asks.ofItem(family, item)) if (row.state === "pending") this.#wake(tx, family, row.unit);
    }
    const through = items.at(-1)?.seq ?? place;
    if (through !== place) tx.tables.cursors.move(LEDGER_CURSOR, { seq: through, at_ms: this.home.now() });
    this.#looked = { version, through };
  }

  #lane(tx: Tx, consumer: Consumer, now: number, rows: () => readonly SourceRow[]): number | undefined {
    const { moved } = tx;
    const { family, own } = consumer;
    let due = moved.resets.has(consumer.cursor);
    let live = false;
    let reader: ReturnType<typeof readerOf> | undefined;
    let whole: ReturnType<typeof readerOf> | undefined;
    const reads = (source: string, kind: string) => (reader ??= readerOf(consumer.inputs, rows()))(source, kind);
    const readsAll = (source: string, kind: string) => (whole ??= readerOf(consumer.inputs.filter((input) => input.linked !== true), rows()))(source, kind);
    for (const { source, kind, stated_ms, linked_ms } of moved.statements.values()) {
      if (!reads(source, kind)) continue;
      const at = readsAll(source, kind) ? stated_ms : linked_ms;
      if (at === null) continue;
      due = true;
      live ||= !moved.history && at >= now - LIVE_MS;
    }
    for (const reread of moved.rereads.values()) {
      if ("family" in reread ? reread.family !== family?.name : !reads(reread.source, reread.kind)) continue;
      due = true;
      live = true;
    }
    if (family === undefined) {
      for (const [name, { source, kind }] of moved.heads) {
        if (moved.statements.has(name) || !reads(source, kind)) continue;
        due = true;
        live = true;
      }
    }
    if (consumer.events?.some((kind) => moved.events.has(kind)) === true) {
      due = true;
      live = true;
    }
    const landed = own === undefined ? undefined : moved.read.get(own);
    if (landed !== undefined) {
      due = true;
      live ||= landed.after >= now - LIVE_MS;
    }
    else if (own !== undefined && !moved.deliveries.has(own) && tx.tables.jobs.get("import", own)?.state !== "running"
      && [...moved.statements.values()].some(({ source }) => source === own)) {
      due = true;
      live = true;
    }
    if (own !== undefined && moved.deliveries.size > 0) {
      const shipped = tx.tables.deliveries.shipped(own);
      if (shipped !== undefined && !shipped.waiting && shipped.sources.some((source) => moved.deliveries.has(source))) {
        due = true;
        live = true;
      }
    }
    if (family?.readThrough !== undefined && moved.read.size > 0) {
      const evidence = readerOf(family.inputs.filter((input) => input.role === "evidence"), rows());
      for (const [source, { after }] of moved.read) {
        if (!evidence(source)) continue;
        due = true;
        live ||= !moved.history && after >= now - LIVE_MS;
      }
    }
    if (!due) return undefined;
    return live ? LANE.live : LANE.backfill;
  }

  #passed(tx: Tx, consumer: Consumer, reread: number, now: number): void {
    const job = tx.tables.jobs.get(consumer.kind, consumer.key);
    if (job !== undefined && job.state !== "done") return;
    if ((tx.tables.cursors.get(consumer.cursor)?.reread ?? 0) < reread) tx.tables.cursors.move(consumer.cursor, { reread, at_ms: now });
  }

  #import(tx: Tx, source: string): void {
    const job = tx.tables.jobs.get("import", source);
    if (job?.state === "running") return;
    const waiting = tx.tables.deliveries.waiting(source);
    if (waiting !== undefined) this.#enqueue(tx, "import", source, waiting.live ? LANE.live : LANE.history, job, waiting.since_ms);
    else if (tx.tables.deliveries.unread(source, this.home.registry.code) !== undefined) this.#enqueue(tx, "import", source, LANE.history, job);
  }

  #start(tx: Tx, source: string, kind: string, start_ms: number | undefined, now: number): void {
    const name = `start:${source}:${kind}`;
    const seen = tx.tables.cursors.get(name)?.at_ms ?? NEVER;
    const start = start_ms ?? NEVER;
    if (start === seen) return;
    this.#moved(tx, seen, start, now);
    tx.tables.cursors.move(name, { at_ms: start });
  }

  #moved(tx: Tx, a: number, b: number, now: number): boolean {
    const { day } = this.home.settings;
    if (a !== NEVER && b !== NEVER && civilDay(a, day) === civilDay(b, day)) return false;
    this.#mark(tx, a, b, now);
    return true;
  }

  #read(tx: Tx, source: string, before: number | null, after: number, now: number): void {
    const { day } = this.home.settings;
    if (before === null) this.#mark(tx, this.#first(tx, source, after), after, now);
    else if (!this.#moved(tx, before, after, now)) return;
    const into = civilDay(after, day);
    if (into > civilDay(now, day) && tx.derived.days.page(into, into, undefined, 1).length === 0) tx.tables.dirty.days([into]);
  }

  #first(tx: Tx, source: string, after: number): number {
    const row = tx.tables.sources.get(source);
    if (row === undefined) return after;
    const kinds = new Set(this.home.registry.families.flatMap((family) =>
      family.inputs.filter((input) => input.role === "evidence" && selects(input.sources, row)).flatMap((input) => input.kinds)));
    let first = after;
    for (const kind of kinds) first = Math.min(first, tx.records.start(source, kind) ?? after);
    return first;
  }

  #mark(tx: Tx, a: number, b: number, now: number): void {
    const { day } = this.home.settings;
    const today = civilDay(now, day);
    const from = civilDay(Math.min(a, b), day);
    const to = civilDay(Math.max(a, b) === NEVER ? now : Math.max(a, b), day);
    if (from <= today && today <= to) tx.tables.dirty.days([today]);
    for (let after: string | undefined; ;) {
      const page = tx.derived.days.dates(from, to, after, PAGE);
      tx.tables.dirty.days(page.filter((each) => each !== today));
      if (page.length < PAGE) break;
      after = page.at(-1)!;
    }
  }

  #days(tx: Tx, now: number): void {
    const { day } = this.home.settings;
    const newest = tx.tables.dirty.newestDay(civilDay(now, day));
    if (newest === undefined) return;
    const job = tx.tables.jobs.get("render", "days");
    if (job?.state === "running") return;
    this.#enqueue(tx, "render", "days", newest >= civilDay(now - RECENT_MS, day) ? LANE.live : LANE.backfill, job);
  }

  #plans(tx: Tx, now: number): void {
    for (const { family, woken, end_ms } of tx.tables.dirty.urgent()) {
      if (this.home.families.get(family)?.plan === undefined) {
        tx.tables.dirty.clear(family);
        continue;
      }
      const job = tx.tables.jobs.get("plan", family);
      if (job?.state === "running") continue;
      this.#enqueue(tx, "plan", family, woken ? LANE.live : end_ms === null || end_ms >= now - RECENT_MS ? LANE.planning : LANE.backfill, job);
    }
  }

  #answered(tx: Tx, row: { family: string; item: string; reply_key: string | null; unit: string }): void {
    if (this.home.families.has(row.family) && this.#ledger.answered(row.family, row.item, row.reply_key)) this.#wake(tx, row.family, row.unit);
  }

  #finished(place: number): Outcome[] {
    const items: Outcome[] = [];
    for (let seq = place; ;) {
      const page = this.#ledger.outcomesAfter(seq, PAGE);
      items.push(...page);
      if (page.length < PAGE) break;
      seq = page.at(-1)!.seq;
    }
    return items;
  }

  #wake(tx: Tx, family: string, unit: string): void {
    tx.tables.dirty.wake(family, unit);
  }

  #prune(tx: Tx): void {
    let through = Number.MAX_SAFE_INTEGER;
    for (const { cursor } of this.#consumers) through = Math.min(through, tx.tables.cursors.get(cursor)?.reread ?? 0);
    for (const family of this.home.registry.families) through = Math.min(through, walkFloor(tx, family.name) ?? Number.MAX_SAFE_INTEGER);
    if (through > 0 && through < Number.MAX_SAFE_INTEGER) tx.records.pruneRereads(through);
  }

  queue(tx: Tx, kind: string, key: string, lane: number): void {
    this.#enqueue(tx, kind, key, lane, tx.tables.jobs.get(kind, key));
  }

  queueNow(tx: Tx, kind: string, key: string, lane: number): void {
    const job = tx.tables.jobs.get(kind, key);
    const now = this.home.now();
    if (job?.state === "queued" && job.attempts === 0 && job.not_before_ms > now) {
      tx.tables.jobs.enqueue({ kind, key, connector: job.connector, lane, not_before_ms: now, now_ms: now });
      return;
    }
    this.#enqueue(tx, kind, key, lane, job);
  }

  #enqueue(tx: Tx, kind: string, key: string, lane: number, job: JobRow | undefined, at_ms = Infinity): void {
    const running = job?.state === "running" ? this.home.running(job.id) : undefined;
    if (running !== undefined) {
      running.due = Math.min(running.due ?? lane, lane);
      tx.tables.jobs.urgent(job!.id, lane);
      return;
    }
    const now = this.home.now();
    tx.tables.jobs.enqueue({ kind, key, connector: connectorOfJob(this.home.registry, tx.tables, kind, key), lane, not_before_ms: job?.state === "queued" ? job.not_before_ms : Math.min(at_ms, now), now_ms: now });
  }
}
