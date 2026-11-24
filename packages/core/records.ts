import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { countAsks } from "./asks-left.js";
import { changedPaths, FormatError, versionId } from "./format.js";
import { accountOf } from "./sources.js";
import { COLUMNS, columnsOf, type Sql } from "./sql.js";
import { ENDS, fillHeld, forgotKind, heldAt, heldMark, movePassed, passed, type HeldAt, type HeldMark } from "./held.js";
import type { Earliest, Holding, Named, Stored } from "./stored.js";
import { startMinute, windowOf, type Counted, type Window } from "./tally.js";
import { CONSUMED, GONE, type BlobReader, type Guard, type Instant, type Json, type Landed, type RecordRef, type ReaderOutput, type Version } from "./types.js";

export const OWNER_REQUEST = "owner:request:";

export function walkPlace(family: string): string {
  return `walk:${family}`;
}

export function importSubject(source: string, delivery: string): string {
  return `${source} ${delivery}`;
}

export interface DeliveryRef {
  id: string;
  source: string;
  stated_ms: number;
  history?: boolean;
  reread?: boolean;
}

export interface Projection {
  content: Json;
  time?: Instant | null;
  blobs?: string[];
  kind?: string;
  key?: string;
}

export interface ErasureSpec {
  records: RecordRef[];
  items?: { family: string; item: string }[];
  units?: { family: string; unit: string }[];
  reason: string;
  at_ms: number;
}

export interface ForgetSpec {
  sources: { source: string; kinds?: string[] }[];
  blobs?: string[];
}

export interface Erased {
  records: number;
  statements: number;
  versions: string[];
  blobs: string[];
  enrichments: number;
  extracts: { family: string; unit: string }[];
  days: string[];
}

export interface RepairSpec {
  source: string;
  kinds?: string[];
  fix(head: Version): Projection | typeof GONE | "keep";
  run?: number;
}

export interface HeadAt {
  version: string;
  seq: number;
}

export interface RepairFix {
  record: RecordRef;
  from: HeadAt;
  to: { id: string; text: string; time?: Instant; blobs: string[] } | typeof GONE;
  kind?: string;
  key?: string;
  paths: string[];
}

export interface RepairAt {
  kind: string;
  key: string;
}

export type RepairStep<At = unknown> = { at: At } & (
  | { fix: RepairFix }
  | { left: "kept" | "moved" | "own" }
  | { refused: RecordRef; why: string }
);

export interface RepairPlan<At = unknown> {
  steps: RepairStep<At>[];
  next: At | null;
  examples: { record: RecordRef; before: Json | typeof GONE; after: Json | typeof GONE; kind?: string; key?: string }[];
}

export interface PlanTally {
  counts: { heads: number; changed: number; gone: number; kept: number; moved: number; refused: number };
  changedPaths: Record<string, number>;
  refusals: Landed["refusals"];
}

const EXAMPLES = 10;
const PAGE = 512;
const BLOB = /^sha256:[0-9a-f]{64}$/;
const COMPRESS_OVER = 4096;
const PRECISIONS = new Set(["ms", "s", "minute", "day", "month", "year"]);

export interface VersionRow {
  id: string;
  text: string | Buffer;
  kind: string;
  key: string;
  start_ms: number | null;
  end_ms: number | null;
  offset_min: number | null;
  precision: string | null;
}

export function storedText(text: string): string | Buffer {
  if (text.length <= COMPRESS_OVER / 3 || (text.length <= COMPRESS_OVER && Buffer.byteLength(text) <= COMPRESS_OVER)) return text;
  return zstdCompressSync(Buffer.from(text, "utf8"));
}

export function readText(stored: string | Buffer): string {
  return typeof stored === "string" ? stored : zstdDecompressSync(stored).toString("utf8");
}

export function toVersion(row: VersionRow): Version {
  const text = readText(row.text);
  const version: Version = { id: row.id, kind: row.kind, key: row.key, content: (JSON.parse(text) as { content: Json }).content, text };
  const time = instantOf(row);
  if (time) version.time = time;
  return version;
}

export function instantOf(row: Pick<VersionRow, "start_ms" | "end_ms" | "offset_min" | "precision">): Instant | undefined {
  if (row.start_ms === null) return undefined;
  const instant: Instant = { start_ms: row.start_ms, precision: row.precision as Instant["precision"] };
  if (row.end_ms !== null) instant.end_ms = row.end_ms;
  if (row.offset_min !== null) instant.offset_min = row.offset_min;
  return instant;
}

export class MissingVersion extends Error {
  override name = "MissingVersion";

  constructor(readonly id: string) {
    super(`a record points at content the home does not hold (version ${id}): run lifestream verify`);
  }
}

export function readVersion(sql: Sql, id: string): Version {
  const row = sql.get<VersionRow>(`SELECT ${COLUMNS.versions} FROM versions WHERE id = ?`, id);
  if (row === undefined) throw new MissingVersion(id);
  return toVersion(row);
}

const NEAR_ROWS = 8;

export function versionReader(sql: Sql): (id: string) => Version {
  type Placed = VersionRow & { row: number };
  let last = 0;
  let near = false;
  return (id) => {
    if (near) {
      const next = sql.get<Placed>(`SELECT rowid AS row, ${COLUMNS.versions} FROM versions NOT INDEXED WHERE rowid > ? AND rowid <= ? AND id = ?`, last, last + NEAR_ROWS, id);
      if (next !== undefined) {
        last = next.row;
        return toVersion(next);
      }
    }
    const found = sql.get<Placed>(`SELECT rowid AS row, ${COLUMNS.versions} FROM versions WHERE id = ?`, id);
    if (found === undefined) throw new MissingVersion(id);
    near = found.row > last && found.row - last <= NEAR_ROWS;
    last = found.row;
    return toVersion(found);
  };
}

export function emptyLanded(): Landed {
  return {
    new: 0, restated: 0, changed: 0, late: 0, gone: 0, erased: 0, refused: 0, duplicated: 0, replayed: 0,
    changedPaths: {}, refusals: [],
  };
}

interface Prepared {
  kind: string;
  key: string;
  id: string;
  text?: string;
  content?: Json;
  time?: Instant;
  blobs: string[];
  device: string | null;
  locator: string | null;
}

interface HeadState {
  version: string;
  stated_ms: number;
}

const LONG_MS = 86_400_000;
export const LONG = `end_ms - start_ms > ${LONG_MS}`;

class Kinds {
  readonly #of = new Map<string, { source: string; kind: string; span: { day_ms: number } | null; live: number }>();
  #at: HeldAt | null | undefined;
  #passed = 0;

  constructor(private readonly sql: Sql) {}

  #get(source: string, kind: string) {
    const id = `${source}\0${kind}`;
    let moved = this.#of.get(id);
    if (moved === undefined) this.#of.set(id, (moved = { source, kind, span: null, live: 0 }));
    return moved;
  }

  span(source: string, kind: string, time: Instant | undefined): void {
    const length = time?.end_ms === undefined ? 0 : time.end_ms - time.start_ms;
    const moved = this.#get(source, kind);
    const known = moved.span ?? { day_ms: 0 };
    moved.span = { day_ms: length > LONG_MS ? known.day_ms : Math.max(known.day_ms, length) };
  }

  live(source: string, kind: string, key: string, was: Counted | null, now: Counted | null): void {
    const change = (now !== null && now.version !== GONE ? 1 : 0) - (was !== null && was.version !== GONE ? 1 : 0);
    if (change === 0) return;
    this.#get(source, kind).live += change;
    const at = this.#at === undefined ? (this.#at = heldAt(this.sql)) : this.#at;
    if (at !== null && at.source === source && at.kind === kind && passed(at, key)) this.#passed += change;
  }

  flush(): void {
    for (const { source, kind, span, live } of this.#of.values()) {
      if (span !== null) {
        this.sql.run(
          `INSERT INTO spans (source, kind, day_ms, live, oldest_ms, newest_ms, newest_dated)
           VALUES (@source, @kind, @day_ms, @live, ${ENDS.oldest_ms}, ${ENDS.newest_ms}, ${ENDS.newest_dated})
           ON CONFLICT (source, kind) DO UPDATE SET day_ms = max(day_ms, excluded.day_ms), live = live + excluded.live,
             oldest_ms = excluded.oldest_ms, newest_ms = excluded.newest_ms, newest_dated = excluded.newest_dated`,
          { source, kind, day_ms: span.day_ms, live },
        );
      } else {
        this.sql.run(
          `UPDATE spans SET live = live + @live, oldest_ms = ${ENDS.oldest_ms}, newest_ms = ${ENDS.newest_ms}, newest_dated = ${ENDS.newest_dated}
           WHERE source = @source AND kind = @kind`,
          { source, kind, live },
        );
      }
    }
    if (this.#passed !== 0) movePassed(this.sql, this.#at!, this.#passed);
  }
}

export class Records {
  #window: Window | null | undefined;
  #kinds: Kinds;

  constructor(private readonly sql: Sql, private readonly stored: Stored) {
    this.#kinds = new Kinds(sql);
  }

  #begin(): void {
    this.sql.writing();
    this.#window = undefined;
    this.#kinds = new Kinds(this.sql);
    this.stored.begin();
  }

  land(run: number, delivery: DeliveryRef, rows: Iterable<ReaderOutput>, guards: Record<string, Guard>, store: Holding, stated?: (record: { kind: string; key: string; time?: Instant }) => void): Landed {
    this.#begin();
    const { source, stated_ms } = delivery;
    if (!Number.isSafeInteger(stated_ms)) throw new Error(`delivery ${delivery.id}: stated_ms ${stated_ms} is not integer milliseconds`);
    const landed = emptyLanded();
    if (delivery.history === true) this.sql.moved.history = true;
    const erased = erasedOf(this.sql, source);
    const pending = new Map<string, Prepared>();
    for (const row of rows) {
      if (row.kind === CONSUMED && row.refused === undefined) {
        if (typeof row.key === "string" && row.key !== "" && landed.consumed?.includes(row.key) !== true) (landed.consumed ??= []).push(row.key);
        continue;
      }
      const record = `${row.kind}\0${row.key}`;
      if (erased.has(record)) {
        landed.erased++;
        continue;
      }
      const prepared = prepare(row, guards);
      if (Array.isArray(prepared)) {
        refuse(landed, row, prepared);
        continue;
      }
      if (pending.has(record)) landed.duplicated++;
      pending.set(record, prepared);
    }
    for (const row of pending.values()) {
      this.#landOne(run, delivery, row, landed, store);
      if (row.id !== GONE) stated?.(row);
    }
    this.#kinds.flush();
    this.stored.flush();
    return landed;
  }

  #landOne(run: number, delivery: DeliveryRef, row: Prepared, landed: Landed, store: Holding): void {
    const sql = this.sql;
    const { source, stated_ms } = delivery;
    const reread = delivery.reread === true;
    const head = sql.get<HeadState>("SELECT version, stated_ms FROM heads WHERE source = ? AND kind = ? AND key = ?", source, row.kind, row.key);
    const by = head !== undefined && head.stated_ms === stated_ms ? this.#headBy(row, head.version, run, delivery) : undefined;
    const repeat = by !== undefined;
    if (head !== undefined && head.version === row.id) {
      if (this.#link({ id: row.id, kind: row.kind, key: row.key }, row.blobs, true, store)) this.#want(source, row.kind, row.key, row.id, store);
      if (stated_ms > head.stated_ms) {
        this.#restate(source, row.kind, row.key, stated_ms);
        landed.restated++;
      } else if (repeat) landed.duplicated++;
      else landed.restated++;
      return;
    }
    const late = head !== undefined && (stated_ms < head.stated_ms || (reread && !repeat && stated_ms === head.stated_ms));
    if (repeat ? by !== run && (head!.version === GONE || this.#statedByDelivery(row, delivery)) : this.#stated(source, row, stated_ms)) {
      if (row.text !== undefined && sql.get("SELECT 1 FROM versions WHERE id = ?", row.id) !== undefined) this.#link({ id: row.id, kind: row.kind, key: row.key }, row.blobs, true, store);
      if (repeat) landed.duplicated++;
      else landed.replayed++;
      return;
    }
    const time = row.text === undefined ? row.time : this.#putVersion(source, row.id, row.text, row.kind, row.key, row.time, row.blobs, store);
    this.#state(source, row.kind, row.key, row.id, stated_ms, run, row.device, row.locator, "source", late, head?.version ?? null);
    if (repeat) landed.duplicated++;
    else if (late) landed.late++;
    else if (row.id === GONE) landed.gone++;
    else if (head === undefined) landed.new++;
    else {
      landed.changed++;
      if (head.version !== GONE) count(landed.changedPaths, changedPaths(this.#content(head.version), row.content!));
    }
    if (late) return;
    this.#moveHead(source, row.kind, row.key, row.id, stated_ms, stated_ms, time, store);
    this.#kinds.span(source, row.kind, time);
  }

  #stated(source: string, row: Prepared, stated_ms: number): boolean {
    return this.sql.get(
      "SELECT 1 FROM statements WHERE kind = ? AND key = ? AND source = ? AND stated_ms = ? AND version = ? AND origin = 'source' LIMIT 1",
      row.kind, row.key, source, stated_ms, row.id,
    ) !== undefined;
  }

  starts(): { source: string; kind: string; start_ms: number | undefined }[] {
    return this.sql.all<{ source: string; kind: string }>("SELECT source, kind FROM spans")
      .map((row) => ({ ...row, start_ms: firstStart(this.sql, row.source, row.kind) }));
  }

  start(source: string, kind: string): number | undefined {
    return firstStart(this.sql, source, kind);
  }

  heldMark(): HeldMark | null {
    return heldMark(this.sql);
  }

  fillHeld(): boolean {
    return fillHeld(this.sql);
  }

  top(): number {
    return this.sql.get<{ seq: number }>("SELECT coalesce(max(seq), 0) AS seq FROM statements")!.seq;
  }

  newestReread(): number {
    return newestReread(this.sql);
  }

  pruneRereads(through: number): number {
    this.sql.writing();
    return this.sql.run("DELETE FROM rereads WHERE seq <= ?", through).changes;
  }

  #headBy(row: Prepared, version: string, run: number, delivery: DeliveryRef): number | undefined {
    const set = this.sql.get<{ run: number; ours: number }>(
      `SELECT s.run, r.kind = 'import' AND r.subject = ? AS ours FROM (SELECT run FROM statements INDEXED BY statements_record
         WHERE kind = ? AND key = ? AND source = ? AND stated_ms = ? AND version = ? AND late = 0 ORDER BY seq DESC LIMIT 1) s
       LEFT JOIN runs r ON r.id = s.run`,
      `${delivery.source} ${delivery.id}`, row.kind, row.key, delivery.source, delivery.stated_ms, version,
    );
    return set !== undefined && (set.run === run || (delivery.reread === true && set.ours === 1)) ? set.run : undefined;
  }

  #statedByDelivery(row: Prepared, delivery: DeliveryRef): boolean {
    return this.sql.get(
      `SELECT 1 FROM statements s INDEXED BY statements_record JOIN runs r ON r.id = s.run
       WHERE s.kind = ? AND s.key = ? AND s.source = ? AND s.stated_ms = ? AND s.version = ? AND s.origin = 'source'
         AND r.kind = 'import' AND r.subject = ? LIMIT 1`,
      row.kind, row.key, delivery.source, delivery.stated_ms, row.id, `${delivery.source} ${delivery.id}`,
    ) !== undefined;
  }

  rereadUnits(family: string, units: Iterable<string>): number {
    return this.#unitRereads(family, units, true);
  }

  carryUnits(family: string, units: Iterable<string>): number {
    return this.#unitRereads(family, units, false);
  }

  #unitRereads(family: string, units: Iterable<string>, due: boolean): number {
    this.sql.writing();
    let count = 0;
    for (const unit of new Set(units)) {
      const seq = Number(this.sql.run("INSERT INTO rereads (family, unit) VALUES (?, ?)", family, unit).lastInsertRowid);
      if (due) this.sql.moved.rereadOf(seq, { family });
      else this.sql.moved.reread = Math.max(this.sql.moved.reread, seq);
      count++;
    }
    return count;
  }

  blobsArrived(blobs: Iterable<string>, store: Pick<Holding, "stored">): number {
    this.sql.writing();
    this.stored.begin();
    let records = 0;
    for (const blob of new Set(blobs)) {
      this.stored.arrived(blob, store);
      const wanting = this.sql.all<RecordRef>("DELETE FROM wanted_blobs WHERE blob = ? RETURNING source, kind, key", blob);
      for (const source of new Set(wanting.map((record) => record.source))) this.#unwanted(source, [blob]);
      for (const record of wanting) {
        const seq = Number(this.sql.run("INSERT INTO rereads (source, kind, key) VALUES (?, ?, ?)", record.source, record.kind, record.key).lastInsertRowid);
        this.sql.moved.rereadOf(seq, { source: record.source, kind: record.kind });
        records++;
      }
    }
    this.stored.flush();
    return records;
  }

  erase(spec: ErasureSpec): Erased {
    this.#begin();
    const sql = this.sql;
    let records = 0;
    let statements = 0;
    const stated = new Map<string, Earliest>();
    for (const record of spec.records) {
      const { source, kind, key } = record;
      const erased = sql.run(
        "INSERT INTO erasures (account, kind, key, at_ms, reason) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
        accountOf(source), kind, key, spec.at_ms, spec.reason,
      ).changes;
      records += erased === 1 || sql.get("SELECT 1 FROM heads WHERE source = ? AND kind = ? AND key = ?", source, kind, key) !== undefined ? 1 : 0;
      for (const { version, seq } of sql.all<{ version: string; seq: number }>("SELECT version, min(seq) AS seq FROM statements WHERE kind = ? AND key = ? AND source = ? GROUP BY version", kind, key, source)) {
        if (version !== GONE) earliest(stated, version, { seq, source });
      }
      statements += sql.run("DELETE FROM statements WHERE kind = ? AND key = ? AND source = ?", kind, key, source).changes;
      this.#dropHead(source, kind, key);
      this.#unwanted(source, sql.all<{ blob: string }>("DELETE FROM wanted_blobs WHERE source = ? AND kind = ? AND key = ? RETURNING blob", source, kind, key).map((row) => row.blob));
      sql.run("DELETE FROM rereads WHERE source = ? AND kind = ? AND key = ?", source, kind, key);
    }
    this.#kinds.flush();
    let enrichments = 0;
    for (const { family, item } of spec.items ?? []) {
      enrichments += sql.run("DELETE FROM enrichments WHERE family = ? AND item = ?", family, item).changes;
      countAsks(sql, -1, "asks", "family = ? AND item = ?", family, item);
      sql.run("DELETE FROM asks WHERE family = ? AND item = ?", family, item);
      sql.run("DELETE FROM item_routes WHERE family = ? AND item = ?", family, item);
    }
    sql.run("DELETE FROM meta WHERE key LIKE ?", `${walkPlace("")}%`);
    sql.run(
      "UPDATE meta SET value = json_set(value, '$.act', NULL, '$.id', NULL, '$.undoable', json('false')) WHERE substr(key, 1, length(?)) = ? AND json_valid(value)",
      OWNER_REQUEST, OWNER_REQUEST,
    );
    sql.run("DELETE FROM meta WHERE substr(key, 1, length(?)) = ? AND NOT json_valid(value)", OWNER_REQUEST, OWNER_REQUEST);
    const dropped = this.#dropUnstated(stated);
    this.stored.erased();
    this.stored.flush();
    return { records, statements, enrichments, ...dropped, ...this.#quoted(spec.units ?? []) };
  }

  forget(spec: ForgetSpec): Erased {
    this.sql.writing();
    this.stored.begin();
    const sql = this.sql;
    let records = 0;
    let statements = 0;
    const stated = new Map<string, Earliest>();
    for (const { source, kinds } of spec.sources) {
      for (const kind of kinds ?? kindsOf(sql, source)) {
        for (const { version, seq } of sql.all<{ version: string; seq: number }>("SELECT version, min(seq) AS seq FROM statements WHERE source = ? AND kind = ? GROUP BY version", source, kind)) {
          if (version !== GONE) earliest(stated, version, { seq, source });
        }
        statements += sql.run("DELETE FROM statements WHERE source = ? AND kind = ?", source, kind).changes;
        records += this.#dropKind(source, kind);
        this.#unwanted(source, sql.all<{ blob: string }>("DELETE FROM wanted_blobs WHERE source = ? AND kind = ? RETURNING blob", source, kind).map((row) => row.blob));
        sql.run("DELETE FROM rereads WHERE source = ? AND kind = ?", source, kind);
      }
    }
    const dropped = this.#dropUnstated(stated, spec.blobs);
    this.stored.erased();
    this.stored.flush();
    return { records, statements, enrichments: 0, ...dropped, extracts: [], days: [] };
  }

  #quoted(units: readonly { family: string; unit: string }[]): Pick<Erased, "extracts" | "days"> {
    const sql = this.sql;
    const extracts: Erased["extracts"] = [];
    const days = new Set<string>();
    for (const { family, unit } of units) {
      sql.moved.rereadOf(Number(sql.run("INSERT INTO rereads (family, unit) VALUES (?, ?)", family, unit).lastInsertRowid), { family });
      sql.run("DELETE FROM extracts_next WHERE family = ? AND unit = ?", family, unit);
      sql.run("DELETE FROM extracts_aside WHERE family = ? AND unit = ?", family, unit);
      for (const { day } of sql.all<{ day: string }>("SELECT day FROM day_units WHERE family = ? AND unit = ?", family, unit)) days.add(day);
      const row = sql.get<{ days: string }>("DELETE FROM extracts WHERE family = ? AND unit = ? RETURNING days", family, unit);
      if (row === undefined) continue;
      sql.moved.extracts.add(family);
      for (const day of JSON.parse(row.days) as string[]) days.add(day);
      extracts.push({ family, unit });
    }
    for (const day of days) sql.run("INSERT INTO dirty_days (day) VALUES (?) ON CONFLICT DO UPDATE SET marks = marks + 1, error = NULL", day);
    return { extracts, days: [...days].sort() };
  }

  applyRepair(run: number, plan: Pick<RepairPlan, "steps">, store: Holding): Landed {
    this.#begin();
    const landed = emptyLanded();
    for (const step of plan.steps) {
      if (!("fix" in step)) continue;
      const { fix } = step;
      const { source, kind, key } = fix.record;
      const head = this.sql.get<HeadState>("SELECT version, stated_ms FROM heads WHERE source = ? AND kind = ? AND key = ?", source, kind, key);
      if (head === undefined || head.version !== fix.from.version || headAt(this.sql, fix.record).seq !== fix.from.seq) {
        refuse(landed, fix.record, ["the head moved since the plan read it"]);
        continue;
      }
      const to = fix.to;
      const target = { source, kind: fix.kind ?? kind, key: fix.key ?? key };
      const moves = target.kind !== kind || target.key !== key;
      const there = moves ? destination(this.sql, target, head.stated_ms) : null;
      const taken = there === "stated" && headAt(this.sql, target).run === run;
      if (there !== null && !taken) {
        const named = target.key === key ? target.kind : `${target.kind} ${target.key}`;
        refuse(landed, fix.record, [there === "erased" ? `the ${named} record is erased` : `the source states it as ${named} since the plan read it`]);
        continue;
      }
      if (moves) {
        this.#state(source, kind, key, GONE, head.stated_ms, run, null, null, "repair", false, head.version);
        this.#moveHead(source, kind, key, GONE, head.stated_ms, head.stated_ms, undefined, store);
      }
      if (taken || to === GONE) {
        if (!moves) {
          this.#state(source, kind, key, GONE, head.stated_ms, run, null, null, "repair", false, head.version);
          this.#moveHead(source, kind, key, GONE, head.stated_ms, head.stated_ms, undefined, store);
        }
        landed.gone++;
        continue;
      }
      const time = this.#putVersion(source, to.id, to.text, target.kind, target.key, to.time, to.blobs, store);
      this.#state(source, target.kind, target.key, to.id, head.stated_ms, run, null, null, "repair", false, moves ? null : head.version);
      this.#moveHead(source, target.kind, target.key, to.id, head.stated_ms, head.stated_ms, time, store);
      landed.changed++;
      count(landed.changedPaths, fix.paths);
      this.#kinds.span(source, target.kind, time);
    }
    this.#kinds.flush();
    this.stored.flush();
    return landed;
  }

  #putVersion(source: string, id: string, text: string, kind: string, key: string, time: Instant | undefined, blobs: string[], store: Holding): Instant | undefined {
    const body = storedText(text);
    const named = this.stored.rowid();
    const put = this.sql.run(
      `INSERT INTO versions (${named === null ? "" : "rowid, "}id, text, kind, key, start_ms, end_ms, offset_min, precision) VALUES (${named === null ? "" : "?, "}?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      ...(named === null ? [] : [named]), id, body, kind, key, time?.start_ms ?? null, time?.end_ms ?? null, time?.offset_min ?? null, time?.precision ?? null,
    );
    if (put.changes === 0) {
      this.#link({ id, kind, key }, blobs, true, store);
      return instantOf(this.sql.get<VersionRow>("SELECT start_ms, end_ms, offset_min, precision FROM versions WHERE id = ?", id)!);
    }
    const rowid = Number(put.lastInsertRowid);
    this.stored.versionStored(rowid, source, typeof body === "string" ? Buffer.byteLength(body) : body.length);
    this.#link({ id, kind, key, rowid, owner: source }, blobs, false, store);
    return time;
  }

  #link(version: Named, blobs: string[], stored: boolean, store: Holding): boolean {
    const { id, kind, key } = version;
    let gained = false;
    for (const blob of blobs) {
      if (this.sql.run("INSERT OR IGNORE INTO version_blobs (version, blob) VALUES (?, ?)", id, blob).changes === 0) continue;
      gained = true;
      this.stored.linked(blob, version, store);
    }
    if (!gained || !stored) return gained;
    for (const row of this.sql.all<{ seq: number; source: string }>(
      "INSERT INTO rereads (source, kind, key) SELECT DISTINCT source, kind, key FROM statements WHERE kind = ? AND key = ? AND version = ? RETURNING seq, source", kind, key, id,
    )) this.sql.moved.rereadOf(row.seq, { source: row.source, kind });
    return gained;
  }

  #state(
    source: string, kind: string, key: string, version: string, stated_ms: number, run: number,
    device: string | null, locator: string | null, origin: "source" | "repair", late: boolean, replaced: string | null,
  ): void {
    this.sql.run(
      "INSERT INTO statements (source, kind, key, version, stated_ms, run, device, locator, origin, late) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      source, kind, key, version, stated_ms, run, device, locator, origin, late ? 1 : 0,
    );
    const links = (id: string | null) => id !== null && id !== GONE && this.sql.get("SELECT 1 FROM version_blobs WHERE version = ? LIMIT 1", id) !== undefined;
    this.sql.moved.statement(source, kind, stated_ms, links(version) || links(replaced));
  }


  #restate(source: string, kind: string, key: string, stated_ms: number): void {
    this.sql.run("UPDATE heads SET stated_ms = ? WHERE source = ? AND kind = ? AND key = ?", stated_ms, source, kind, key);
  }

  #moveHead(source: string, kind: string, key: string, version: string, stated_ms: number, since_ms: number, time: Instant | undefined, store: Pick<BlobReader, "has">): void {
    const before = this.sql.get<Counted>("SELECT version, start_ms, (SELECT precision FROM versions WHERE id = heads.version) AS precision FROM heads WHERE source = ? AND kind = ? AND key = ?", source, kind, key) ?? null;
    this.sql.run(
      `INSERT INTO heads (source, kind, key, version, stated_ms, since_ms, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, kind, key) DO UPDATE SET version = excluded.version, stated_ms = excluded.stated_ms,
         since_ms = excluded.since_ms, start_ms = excluded.start_ms, end_ms = excluded.end_ms`,
      source, kind, key, version, stated_ms, since_ms, time?.start_ms ?? null, time?.end_ms ?? null,
    );
    if (before !== null && before.version !== GONE) {
      this.#unwanted(source, this.sql.all<{ blob: string }>(
        "DELETE FROM wanted_blobs WHERE source = ? AND kind = ? AND key = ? AND blob NOT IN (SELECT blob FROM version_blobs WHERE version = ?) RETURNING blob",
        source, kind, key, version,
      ).map((row) => row.blob));
    }
    if (version !== GONE) this.#want(source, kind, key, version, store);
    const now = { version, start_ms: time?.start_ms ?? null, precision: time?.precision ?? null };
    this.#tally(source, kind, before, now);
    this.#kinds.live(source, kind, key, before, now);
    this.sql.moved.head(source, kind);
  }

  #want(source: string, kind: string, key: string, version: string, store: Pick<BlobReader, "has">): void {
    for (const blob of blobsOf(this.sql, version)) {
      if (store.has(blob)) continue;
      if (this.sql.run("INSERT OR IGNORE INTO wanted_blobs (blob, source, kind, key) VALUES (?, ?, ?, ?)", blob, source, kind, key).changes === 0) continue;
      this.sql.run(`INSERT OR IGNORE INTO lost_files (source, blob, claim, sealed_ms)
        SELECT s.source, vb.blob, d.id, d.sealed_ms FROM statements s INDEXED BY statements_record
          JOIN version_blobs vb ON vb.version = s.version AND vb.blob = ?
          JOIN deliveries d INDEXED BY deliveries_losses ON d.source = s.source AND d.run = s.run AND d.lost IS NOT NULL
        WHERE s.kind = ? AND s.key = ? AND s.source = ? ORDER BY d.sealed_ms LIMIT 1`, blob, kind, key, source);
    }
  }

  #unwanted(source: string, blobs: readonly string[]): void {
    for (const blob of new Set(blobs)) {
      this.sql.run("DELETE FROM lost_files WHERE source = ? AND blob = ? AND NOT EXISTS (SELECT 1 FROM wanted_blobs WHERE blob = ? AND source = ?)", source, blob, blob, source);
    }
  }

  #dropHead(source: string, kind: string, key: string): void {
    const gone = this.sql.get<Counted>("DELETE FROM heads WHERE source = ? AND kind = ? AND key = ? RETURNING version, start_ms, (SELECT precision FROM versions WHERE id = version) AS precision", source, kind, key);
    if (gone === undefined) return;
    this.#tally(source, kind, gone, null);
    this.#kinds.live(source, kind, key, gone, null);
    this.sql.moved.head(source, kind);
  }

  #dropKind(source: string, kind: string): number {
    const heads = this.sql.run("DELETE FROM heads WHERE source = ? AND kind = ?", source, kind).changes;
    this.sql.run("DELETE FROM start_minutes WHERE source = ? AND kind = ?", source, kind);
    forgotKind(this.sql, source, kind);
    if (heads > 0) this.sql.moved.head(source, kind);
    return heads;
  }

  #tally(source: string, kind: string, was: Counted | null, now: Counted | null): void {
    const window = this.#window === undefined ? (this.#window = windowOf((key) => this.sql.get<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)?.value)) : this.#window;
    const [from, to] = [startMinute(was ?? undefined, window), startMinute(now ?? undefined, window)];
    if (from === to) return;
    if (from !== null) {
      const left = this.sql.get<{ records: number }>(
        "UPDATE start_minutes SET records = records - 1 WHERE source = ? AND kind = ? AND minute = ? RETURNING records", source, kind, from,
      );
      if (left?.records === 0) this.sql.run("DELETE FROM start_minutes WHERE source = ? AND kind = ? AND minute = ?", source, kind, from);
    }
    if (to !== null) {
      this.sql.run(
        "INSERT INTO start_minutes (source, kind, minute, records) VALUES (?, ?, ?, 1) ON CONFLICT (source, kind, minute) DO UPDATE SET records = records + 1",
        source, kind, to,
      );
    }
  }

  #content(id: string): Json {
    return readVersion(this.sql, id).content;
  }

  #dropUnstated(stated: ReadonlyMap<string, Earliest>, copies: Iterable<string> = []): { versions: string[]; blobs: string[] } {
    const sql = this.sql;
    const versions: string[] = [];
    const candidates = new Set<string>(copies);
    const moved = new Set<string>(candidates);
    for (const [id, gone] of stated) {
      const row = sql.get<{ rowid: number; kind: string; key: string; bytes: number }>("SELECT rowid, kind, key, octet_length(text) AS bytes FROM versions WHERE id = ?", id);
      if (row === undefined) continue;
      const survivor = sql.get<Earliest>("SELECT seq, source FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND version = ? ORDER BY seq LIMIT 1", row.kind, row.key, id) ?? null;
      const owned = this.stored.unstated(row.rowid, row.bytes, gone, survivor);
      if (survivor !== null) {
        if (owned) for (const blob of blobsOf(sql, id)) moved.add(blob);
        continue;
      }
      for (const blob of blobsOf(sql, id)) {
        candidates.add(blob);
        moved.add(blob);
      }
      sql.run("DELETE FROM version_blobs WHERE version = ?", id);
      sql.run("DELETE FROM versions WHERE id = ?", id);
      versions.push(id);
    }
    this.stored.recount(moved);
    const blobs = [...candidates].filter((blob) => sql.get("SELECT 1 FROM version_blobs WHERE blob = ? LIMIT 1", blob) === undefined);
    return { versions, blobs: blobs.sort() };
  }
}

export function planRepair(sql: Sql, spec: RepairSpec, after: RepairAt | null = null, limit = PAGE): RepairPlan<RepairAt> {
  const plan: RepairPlan<RepairAt> = { steps: [], next: null, examples: [] };
  const kinds = [...new Set(spec.kinds ?? kindsOf(sql, spec.source))].sort();
  for (const kind of kinds) {
    if (after !== null && kind < after.kind) continue;
    let key = after !== null && kind === after.kind ? after.key : "";
    for (;;) {
      const wanted = limit - plan.steps.length;
      const page = sql.all<VersionRow>(
        `SELECT ${columnsOf("versions", "v")} FROM heads h JOIN versions v ON v.id = h.version
         WHERE h.source = ? AND h.kind = ? AND h.key > ? AND h.version <> 'gone' ORDER BY h.key LIMIT ?`,
        spec.source, kind, key, wanted,
      );
      for (const row of page) planHead(sql, spec, plan, row);
      if (plan.steps.length >= limit) {
        plan.next = plan.steps.at(-1)!.at;
        return plan;
      }
      if (page.length < wanted) break;
      key = page.at(-1)!.key;
    }
  }
  return plan;
}

function planHead(sql: Sql, spec: RepairSpec, plan: RepairPlan<RepairAt>, row: VersionRow): void {
  const before = toVersion(row);
  const record = { source: spec.source, kind: before.kind, key: before.key };
  const at = { kind: before.kind, key: before.key };
  const refuse = (why: string) => plan.steps.push({ at, refused: record, why });
  let result: ReturnType<RepairSpec["fix"]>;
  try {
    result = spec.fix(before);
  } catch (error) {
    refuse(`the fix threw: ${(error as Error).message}`);
    return;
  }
  if (result === "keep") {
    plan.steps.push({ at, left: "kept" });
    return;
  }
  const head = headAt(sql, record);
  if (spec.run !== undefined && head.run === spec.run) {
    plan.steps.push({ at, left: "own" });
    return;
  }
  const from = { version: before.id, seq: head.seq };
  if (result === GONE) {
    addFix(plan, at, { record, from, to: GONE, paths: [] }, before.content, GONE);
    return;
  }
  const kind = result.kind ?? before.kind;
  const key = result.key ?? before.key;
  if (typeof key !== "string" || key === "") {
    refuse("the fix's key is no string, or empty");
    return;
  }
  const moves = kind !== before.kind || key !== before.key;
  const there = !moves ? null
    : destination(sql, { source: spec.source, kind, key }, sql.get<HeadState>("SELECT version, stated_ms FROM heads WHERE source = ? AND kind = ? AND key = ?", spec.source, before.kind, before.key)!.stated_ms);
  if (there === "erased") {
    refuse(`the ${key === before.key ? kind : `${kind} ${key}`} record is erased`);
    return;
  }
  const taken = moves && plan.steps.some((step) => "fix" in step && step.fix.to !== GONE && step.fix.record.source === spec.source
    && (step.fix.kind ?? step.fix.record.kind) === kind && (step.fix.key ?? step.fix.record.key) === key);
  if (there === "stated" || taken) {
    addFix(plan, at, { record, from, to: GONE, paths: [] }, before.content, GONE);
    return;
  }
  let id: string, text: string;
  try {
    ({ id, text } = versionId(kind, key, result.content));
  } catch (error) {
    refuse(`the fix's content: ${(error as Error).message}`);
    return;
  }
  if (result.time !== undefined && result.time !== null && !isInstant(result.time)) {
    refuse("the fix's time is not integer milliseconds with a precision");
    return;
  }
  if (id === before.id) {
    if (result.time !== undefined && !sameInstant(result.time ?? undefined, before.time)) refuse("the fix changes the time and keeps the content; a version's time follows its content");
    else plan.steps.push({ at, left: "kept" });
    return;
  }
  const to: RepairFix["to"] = { id, text, blobs: result.blobs ?? blobsOf(sql, before.id) };
  const time = result.time === undefined ? before.time : result.time ?? undefined;
  if (time !== undefined) to.time = time;
  addFix(plan, at, { record, from, to, ...(kind === before.kind ? {} : { kind }), ...(key === before.key ? {} : { key }), paths: changedPaths(before.content, result.content) }, before.content, result.content);
}

export interface UndoSpec {
  through: number;
  after?: number;
  by?: number;
}

export function planUndo(sql: Sql, run: number, spec: UndoSpec, limit = PAGE): RepairPlan<number> {
  const plan: RepairPlan<number> = { steps: [], next: null, examples: [] };
  const statements = sql.all<{ seq: number; source: string; kind: string; key: string }>(
    "SELECT seq, source, kind, key FROM statements WHERE run = ? AND late = 0 AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
    run, spec.after ?? 0, spec.through, limit,
  );
  for (const statement of statements) {
    const { seq: at, source, kind, key } = statement;
    const record = { source, kind, key };
    const span = sql.get<{ first: number; last: number }>(
      "SELECT min(seq) AS first, max(seq) AS last FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND source = ? AND run = ? AND late = 0 AND seq <= ?",
      kind, key, source, run, spec.through,
    )!;
    if (span.first !== at) continue;
    const last = { version: sql.get<{ version: string }>("SELECT version FROM statements WHERE seq = ?", span.last)!.version, seq: span.last };
    const head = sql.get<HeadState>("SELECT version, stated_ms FROM heads WHERE source = ? AND kind = ? AND key = ?", source, kind, key);
    const newest = headAt(sql, record);
    if (spec.by !== undefined && newest.run === spec.by) {
      plan.steps.push({ at, left: "own" });
      continue;
    }
    if (head === undefined || head.version !== last.version || newest.seq !== last.seq) {
      plan.steps.push({ at, left: "moved" });
      continue;
    }
    const previous = sql.get<{ version: string }>(
      "SELECT version FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND source = ? AND late = 0 AND seq < ? ORDER BY seq DESC LIMIT 1",
      kind, key, source, span.first,
    );
    const target = previous?.version ?? GONE;
    if (target === head.version) {
      plan.steps.push({ at, left: "kept" });
      continue;
    }
    const before = head.version === GONE ? GONE : readVersion(sql, head.version).content;
    if (target === GONE) {
      addFix(plan, at, { record, from: last, to: GONE, paths: [] }, before, GONE);
      continue;
    }
    const version = readVersion(sql, target);
    const to: RepairFix["to"] = { id: version.id, text: version.text, blobs: blobsOf(sql, version.id) };
    if (version.time) to.time = version.time;
    addFix(plan, at, { record, from: last, to, paths: before === GONE ? [] : changedPaths(before, version.content) }, before, version.content);
  }
  if (statements.length === limit) plan.next = statements.at(-1)!.seq;
  return plan;
}

export function tally(steps: readonly RepairStep[]): PlanTally {
  const tallied: PlanTally = { counts: { heads: 0, changed: 0, gone: 0, kept: 0, moved: 0, refused: 0 }, changedPaths: {}, refusals: [] };
  const { counts } = tallied;
  for (const step of steps) {
    if ("left" in step && step.left === "own") continue;
    counts.heads++;
    if ("fix" in step) {
      if (step.fix.to === GONE) counts.gone++;
      else counts.changed++;
      count(tallied.changedPaths, step.fix.paths);
    } else if ("refused" in step) {
      counts.refused++;
      if (tallied.refusals.length < EXAMPLES) tallied.refusals.push({ kind: step.refused.kind, key: step.refused.key, violations: [step.why] });
    } else counts[step.left as "kept" | "moved"]++;
  }
  return tallied;
}

export function erasedOf(sql: Sql, source: string): Set<string> {
  return new Set(sql.all<{ kind: string; key: string }>("SELECT kind, key FROM erasures WHERE account = ?", accountOf(source)).map((row) => `${row.kind}\0${row.key}`));
}

export type Reread = { seq: number } & ({ record: RecordRef } | { family: string; unit: string });

export function newestReread(sql: Sql): number {
  return sql.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'rereads'")?.seq ?? 0;
}

export function readRereads(sql: Sql, after: number, limit: number): Reread[] {
  return sql
    .all<{ seq: number; source: string | null; kind: string | null; key: string | null; family: string | null; unit: string | null }>(
      `SELECT ${COLUMNS.rereads} FROM rereads WHERE seq > ? ORDER BY seq LIMIT ?`, after, limit,
    )
    .map((row) => row.family === null
      ? { seq: row.seq, record: { source: row.source!, kind: row.kind!, key: row.key! } }
      : { seq: row.seq, family: row.family, unit: row.unit! });
}

function destination(sql: Sql, { source, kind, key }: RecordRef, stated_ms: number): "erased" | "stated" | null {
  if (sql.get("SELECT 1 FROM erasures WHERE account = ? AND kind = ? AND key = ?", accountOf(source), kind, key) !== undefined) return "erased";
  const head = sql.get<HeadState>("SELECT version, stated_ms FROM heads WHERE source = ? AND kind = ? AND key = ?", source, kind, key);
  return head !== undefined && (head.version !== GONE || head.stated_ms > stated_ms) ? "stated" : null;
}

function headAt(sql: Sql, { source, kind, key }: RecordRef): { seq: number; run: number | null } {
  return sql.get<{ seq: number; run: number }>(
    "SELECT seq, run FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND source = ? AND late = 0 ORDER BY seq DESC LIMIT 1", kind, key, source,
  ) ?? { seq: 0, run: null };
}

export function firstStart(sql: Sql, source: string, kind: string): number | undefined {
  return sql.get<{ start_ms: number }>(
    "SELECT start_ms FROM heads INDEXED BY heads_time WHERE source = ? AND kind = ? AND version <> 'gone' AND start_ms IS NOT NULL ORDER BY start_ms LIMIT 1",
    source, kind,
  )?.start_ms;
}

export function kindsOf(sql: Sql, source: string): string[] {
  return sql.all<{ kind: string }>(
    `WITH RECURSIVE walk(kind) AS (
       SELECT min(kind) FROM statements WHERE source = ?
       UNION ALL
       SELECT (SELECT min(kind) FROM statements WHERE source = ? AND kind > walk.kind) FROM walk WHERE walk.kind IS NOT NULL
     ) SELECT kind FROM walk WHERE kind IS NOT NULL`,
    source, source,
  ).map((row) => row.kind);
}

function sameInstant(left: Instant | undefined, right: Instant | undefined): boolean {
  return left?.start_ms === right?.start_ms && left?.end_ms === right?.end_ms && left?.offset_min === right?.offset_min && left?.precision === right?.precision;
}

function earliest(stated: Map<string, Earliest>, version: string, at: Earliest): void {
  const known = stated.get(version);
  if (known === undefined || at.seq < known.seq) stated.set(version, at);
}

function blobsOf(sql: Sql, version: string): string[] {
  return sql.all<{ blob: string }>("SELECT blob FROM version_blobs WHERE version = ?", version).map((row) => row.blob);
}

function addFix<At>(plan: RepairPlan<At>, at: At, fix: RepairFix, before: Json | typeof GONE, after: Json | typeof GONE): void {
  plan.steps.push({ at, fix });
  if (plan.examples.length < EXAMPLES) plan.examples.push({ record: fix.record, before, after, ...(fix.kind === undefined ? {} : { kind: fix.kind }), ...(fix.key === undefined ? {} : { key: fix.key }) });
}

function prepare(row: ReaderOutput, guards: Record<string, Guard>): Prepared | string[] {
  if (row.refused !== undefined) return [row.refused];
  if (typeof row.key !== "string" || row.key === "") return ["the key is empty"];
  const guard = Object.hasOwn(guards, row.kind) ? guards[row.kind] : undefined;
  if (guard === undefined) return [`kind '${row.kind}' is not one the connector states`];
  const base = { kind: row.kind, key: row.key, device: row.device ?? null, locator: row.locator ?? null };
  if (row.gone === true) return { ...base, id: GONE, blobs: [] };
  let violations: string[];
  try {
    violations = guard(row.content);
  } catch (error) {
    return [`the guard of '${row.kind}' threw: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`];
  }
  if (violations.length > 0) return violations;
  if (row.time !== undefined && !isInstant(row.time)) return ["time is not integer milliseconds with a precision"];
  const blobs = row.blobs ?? [];
  if (!Array.isArray(blobs)) return ["blobs is not a list"];
  const bad = blobs.find((blob) => !BLOB.test(blob));
  if (bad !== undefined) return [`blob '${bad}' is not 'sha256:' and 64 hex digits`];
  try {
    const { id, text } = versionId(row.kind, row.key, row.content);
    const prepared: Prepared = { ...base, id, text, content: row.content, blobs };
    if (row.time !== undefined) prepared.time = row.time;
    return prepared;
  } catch (error) {
    if (error instanceof FormatError) return [error.message];
    throw error;
  }
}

function isInstant(time: Instant): boolean {
  return (
    Number.isSafeInteger(time.start_ms) &&
    (time.end_ms === undefined || (Number.isSafeInteger(time.end_ms) && time.end_ms >= time.start_ms)) &&
    (time.offset_min === undefined || Number.isSafeInteger(time.offset_min)) &&
    PRECISIONS.has(time.precision)
  );
}

function refuse(landed: Landed, row: { kind: string; key: string; member?: unknown }, violations: string[]): void {
  landed.refused++;
  if (landed.refusals.length < EXAMPLES) landed.refusals.push({ kind: row.kind, key: row.key, violations });
  if (typeof row.member !== "string") return;
  const members = (landed.refusedMembers ??= new Map());
  members.set(row.member, (members.get(row.member) ?? 0) + 1);
}

export const REFUSED_MEMBERS = 500;

export function countMember(into: Pick<Landed, "refusedMembers">, member: string, count: number): void {
  const members = (into.refusedMembers ??= new Map());
  const had = members.get(member);
  if (had !== undefined) members.set(member, had + count);
  else if (members.size < REFUSED_MEMBERS) members.set(member, count);
}

function count(into: Record<string, number>, paths: string[]): void {
  for (const path of paths) into[path] = (into[path] ?? 0) + 1;
}
