import { erasedOf, firstStart, kindsOf, LONG, newestReread, planRepair, planUndo, readRereads, readVersion, versionReader, type RepairAt, type RepairPlan, type RepairSpec, type Reread, type UndoSpec } from "./records.js";
import { accountOf, selects, type SourceSelector } from "./sources.js";
import { COLUMNS, columnsOf, type Sql } from "./sql.js";
import { StoredReads } from "./stored.js";
import { derived, enrichment, extract, tables, type ReadDerived, type ReadTables } from "./tables.js";
import type { DayUnit, EnrichmentRow, ExtractRow, Head, RecordRef, SourceRow, Statement, StatementFilter, Version, View } from "./types.js";

const PAGE = 512;

export type HeadAfter = Pick<Head, "key" | "start_ms">;

export type ExtractSelect = { unit: string } | { day: string } | { start_ms: number; end_ms: number };

export type ExtractAfter = Pick<ExtractRow, "unit" | "start_ms">;

export interface OpenView extends View {
  readonly tables: ReadTables;
  readonly derived: ReadDerived;
  readonly stored: StoredReads;
  position(): string;
  statementAt(seq: number): (RecordRef & { version: string }) | undefined;
  heads(source: string, kind: string, range?: Range, after?: HeadAfter): Iterable<Head>;
  records(source: string, kind: string, range?: Range, after?: HeadAfter): Iterable<{ head: Head; version: Version }>;
  byStart(source: string, kind: string, after?: HeadAfter): Iterable<Head>;
  readonly next: Generation;
  horizon(through_ms: number, family: string, rows: Generation, reread: number): View;
  blobsOf(version: string): string[];
  erasures(source: string): Set<string>;
  linked(source: string, kind: string, after?: string): Iterable<{ head: Head; blobs: string[] }>;
  extractPage(family: string, select: ExtractSelect, after: ExtractAfter | null, limit: number): (ExtractRow & { items: string[] })[];
  extractReadings(family: string, prefix?: string): Iterable<{ unit: string; reading: string; code: string }>;
  dayUnits(family: string, unit: string): (Omit<DayUnit, "family" | "unit"> & { day: string })[];
  rereads(after: number, limit: number): Reread[];
  newestReread(): number;
  holds(blob: string): boolean;
  kinds(source: string): string[];
  count(source: string, kind: string): number | null;
  planRepair(spec: RepairSpec, after?: RepairAt | null): RepairPlan<RepairAt>;
  planUndo(run: number, spec?: Partial<UndoSpec>): RepairPlan<number>;
  close(): void;
}

type Range = { start_ms?: number; end_ms?: number };

export type Generation = Pick<View, "extract" | "extracts" | "extractsUnder">;

interface StatementRow extends Omit<Statement, "late"> {
  late: number;
}

const statement = (row: StatementRow): Statement => ({ ...row, late: row.late === 1 });

type ExtractTable = "extracts" | "extracts_next";

export class ReadView implements OpenView {
  readonly tables: ReadTables;
  readonly derived: ReadDerived;
  readonly stored: StoredReads;
  #open = true;
  #sources: Map<string, SourceRow> | undefined;
  readonly #version: (id: string) => Version;

  constructor(
    private readonly sql: Sql,
    readonly through: number,
    private readonly release: () => void,
  ) {
    this.tables = tables(sql);
    this.derived = derived(sql);
    this.stored = new StoredReads(sql, () => this.#check());
    this.#version = versionReader(sql);
  }

  get snapshot(): object {
    return this;
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.release();
  }

  head(ref: RecordRef): Head | undefined {
    this.#check();
    return this.sql.get<Head>(`SELECT ${COLUMNS.heads} FROM heads WHERE source = ? AND kind = ? AND key = ?`, ref.source, ref.kind, ref.key);
  }

  position(): string {
    this.#check();
    const newest = this.sql.get<{ seq: number; at_ms: number }>("SELECT seq, at_ms FROM events ORDER BY seq DESC LIMIT 1");
    return newest === undefined ? "0:0" : `${newest.seq}:${newest.at_ms}`;
  }

  statementAt(seq: number): (RecordRef & { version: string }) | undefined {
    this.#check();
    return this.sql.get<RecordRef & { version: string }>("SELECT source, kind, key, version FROM statements WHERE seq = ?", seq);
  }

  *heads(source: string, kind: string, range?: Range, resume?: HeadAfter): Iterable<Head> {
    if (range === undefined) {
      let after = resume?.key ?? "";
      for (;;) {
        this.#check();
        const page = this.sql.all<Head>(
          `SELECT ${COLUMNS.heads} FROM heads WHERE source = ? AND kind = ? AND key > ? AND version <> 'gone' ORDER BY key LIMIT ?`,
          source, kind, after, PAGE,
        );
        yield* page;
        if (page.length < PAGE) return;
        after = page[page.length - 1]!.key;
      }
    }
    this.#check();
    const span = this.sql.get<{ day_ms: number }>("SELECT day_ms FROM spans WHERE source = ? AND kind = ?", source, kind)?.day_ms ?? 0;
    const start = range.start_ms ?? Number.MIN_SAFE_INTEGER;
    const end = range.end_ms ?? Number.MAX_SAFE_INTEGER;
    const shortFrom = Math.max(start - span, Number.MIN_SAFE_INTEGER);
    let cursor: [number, string] = resume === undefined || resume.start_ms === null ? [Number.MIN_SAFE_INTEGER, ""] : [resume.start_ms, resume.key];
    for (;;) {
      this.#check();
      const from: [number, string] = cursor[0] >= shortFrom ? cursor : [shortFrom, ""];
      const page = this.sql.all<Head>(
        `SELECT ${COLUMNS.heads} FROM heads INDEXED BY heads_time WHERE source = ? AND kind = ? AND version <> 'gone'
           AND start_ms < ? AND (start_ms >= ? OR end_ms > ?) AND (end_ms IS NULL OR NOT (${LONG})) AND (start_ms, key) > (?, ?)
         UNION ALL
         SELECT ${COLUMNS.heads} FROM heads INDEXED BY heads_long WHERE source = ? AND kind = ? AND version <> 'gone' AND ${LONG}
           AND start_ms < ? AND end_ms > ? AND (start_ms, key) > (?, ?)
         ORDER BY start_ms, key LIMIT ?`,
        source, kind, end, start, start, from[0], from[1],
        source, kind, end, start, cursor[0], cursor[1], PAGE,
      );
      yield* page;
      if (page.length < PAGE) return;
      const last = page[page.length - 1]!;
      cursor = [last.start_ms!, last.key];
    }
  }

  *records(source: string, kind: string, range?: Range, after?: HeadAfter): Iterable<{ head: Head; version: Version }> {
    for (const head of this.heads(source, kind, range, after)) yield { head, version: this.version(head.version) };
  }

  *byStart(source: string, kind: string, after?: HeadAfter): Iterable<Head> {
    for (let key = after?.key ?? ""; after === undefined || after.start_ms === null;) {
      this.#check();
      const page = this.sql.all<Head>(
        `SELECT ${COLUMNS.heads} FROM heads INDEXED BY heads_time WHERE source = ? AND kind = ? AND version <> 'gone' AND start_ms IS NULL AND key > ?
         ORDER BY key LIMIT ?`, source, kind, key, PAGE,
      );
      yield* page;
      if (page.length < PAGE) break;
      key = page[page.length - 1]!.key;
    }
    for (let cursor: [number, string] = after === undefined || after.start_ms === null ? [Number.MIN_SAFE_INTEGER, ""] : [after.start_ms, after.key]; ;) {
      this.#check();
      const page = this.sql.all<Head>(
        `SELECT ${COLUMNS.heads} FROM heads INDEXED BY heads_time WHERE source = ? AND kind = ? AND version <> 'gone' AND (start_ms, key) > (?, ?)
         ORDER BY start_ms, key LIMIT ?`, source, kind, cursor[0], cursor[1], PAGE,
      );
      yield* page;
      if (page.length < PAGE) return;
      const last = page[page.length - 1]!;
      cursor = [last.start_ms!, last.key];
    }
  }

  keyedUnder(source: string, kind: string, prefix: string): Head[] {
    this.#check();
    return this.sql.all<Head>(
      `SELECT ${COLUMNS.heads} FROM heads WHERE source = ? AND kind = ? AND key >= ? AND key < ? AND version <> 'gone' ORDER BY key`,
      source, kind, prefix, beyond(prefix),
    );
  }

  erasedUnder(source: string, kind: string, prefix: string): boolean {
    this.#check();
    return this.sql.get("SELECT 1 FROM erasures WHERE account = ? AND kind = ? AND key >= ? AND key < ? LIMIT 1", accountOf(source), kind, prefix, beyond(prefix)) !== undefined;
  }

  erasures(source: string): Set<string> {
    this.#check();
    return erasedOf(this.sql, source);
  }

  naming(blob: string): Version[] {
    this.#check();
    return this.sql.all<{ version: string }>("SELECT version FROM version_blobs WHERE blob = ? ORDER BY version", blob)
      .map((row) => readVersion(this.sql, row.version));
  }

  blobsOf(version: string): string[] {
    this.#check();
    return this.sql.all<{ blob: string }>("SELECT blob FROM version_blobs WHERE version = ? ORDER BY blob", version).map((row) => row.blob);
  }

  *linked(source: string, kind: string, after = ""): Iterable<{ head: Head; blobs: string[] }> {
    for (;;) {
      this.#check();
      const page = this.sql.all<Head & { linked: string }>(
        `SELECT ${columnsOf("heads", "h")}, json_group_array(b.blob) AS linked FROM heads h JOIN version_blobs b ON b.version = h.version
           WHERE h.source = ? AND h.kind = ? AND h.key > ? AND h.version <> 'gone' GROUP BY h.key ORDER BY h.key LIMIT ?`,
        source, kind, after, PAGE,
      );
      for (const { linked, ...head } of page) yield { head, blobs: (JSON.parse(linked) as string[]).sort() };
      if (page.length < PAGE) return;
      after = page[page.length - 1]!.key;
    }
  }

  version(id: string): Version {
    this.#check();
    return this.#version(id);
  }

  *statements(after: number, filter: StatementFilter = {}): Iterable<Statement> {
    if (filter.sources === undefined) {
      let from = after;
      for (;;) {
        this.#check();
        const rows = this.sql
          .all<StatementRow>(`SELECT ${COLUMNS.statements} FROM statements WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT ?`, from, this.through, PAGE)
          .map(statement);
        yield* rows;
        if (rows.length < PAGE) return;
        from = rows[rows.length - 1]!.seq;
      }
    }
    const page = (source: string, kind: string, from: number): Statement[] => {
      this.#check();
      return this.sql
        .all<StatementRow>(
          `SELECT ${COLUMNS.statements} FROM statements INDEXED BY statements_source WHERE source = ? AND kind = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?`,
          source, kind, from, this.through, PAGE,
        )
        .map(statement);
    };
    const streams = filter.sources.flatMap((source) =>
      (filter.kinds ?? kindsOf(this.sql, source)).map((kind) => ({ source, kind, rows: page(source, kind, after), at: 0 })));
    for (;;) {
      let next: (typeof streams)[number] | undefined;
      for (const stream of streams) {
        if (stream.at === stream.rows.length && stream.rows.length === PAGE) {
          stream.rows = page(stream.source, stream.kind, stream.rows[PAGE - 1]!.seq);
          stream.at = 0;
        }
        const row = stream.rows[stream.at];
        if (row !== undefined && (next === undefined || row.seq < next.rows[next.at]!.seq)) next = stream;
      }
      if (next === undefined) return;
      yield next.rows[next.at++]!;
    }
  }

  history(ref: RecordRef): Statement[] {
    this.#check();
    return this.sql
      .all<StatementRow>(
        `SELECT ${COLUMNS.statements} FROM statements INDEXED BY statements_record WHERE kind = ? AND key = ? AND source = ? AND seq <= ? ORDER BY seq`,
        ref.kind, ref.key, ref.source, this.through,
      )
      .map(statement);
  }

  sources(selector?: SourceSelector): SourceRow[] {
    const all = [...this.#sourceRows().values()];
    return selector === undefined ? all : all.filter((row) => selects(selector, row));
  }

  source(id: string): SourceRow | undefined {
    return this.#sourceRows().get(id);
  }

  #sourceRows(): Map<string, SourceRow> {
    this.#check();
    return this.#sources ??= new Map(this.tables.sources.list().map((row) => [row.id, row]));
  }

  since(source: string, kinds: readonly string[]): number | undefined {
    this.#check();
    const starts = kinds.map((kind) => firstStart(this.sql, source, kind)).filter((start) => start !== undefined);
    return starts.length === 0 ? undefined : Math.min(...starts);
  }

  extract(family: string, unit: string): ExtractRow | undefined {
    return this.#extract("extracts", family, unit);
  }

  extracts(family: string, range?: Range): Iterable<ExtractRow> {
    return this.#extracts("extracts", family, range);
  }

  extractsUnder(family: string, prefix: string): Iterable<ExtractRow> {
    return this.#extractsUnder("extracts", family, prefix);
  }

  get next(): Generation {
    return {
      extract: (family, unit) => this.#extract("extracts_next", family, unit),
      extracts: (family, range) => this.#extracts("extracts_next", family, range),
      extractsUnder: (family, prefix) => this.#extractsUnder("extracts_next", family, prefix),
    };
  }

  horizon(through_ms: number, family: string, rows: Generation, reread: number): View {
    const before = (range: Range | undefined): Range | undefined =>
      range === undefined ? undefined : { ...range, end_ms: Math.min(range.end_ms ?? Number.MAX_SAFE_INTEGER, through_ms) };
    return {
      through: this.through,
      snapshot: this,
      head: (ref) => this.head(ref),
      heads: (source, kind, range) => this.heads(source, kind, before(range)),
      records: (source, kind, range) => this.records(source, kind, before(range)),
      version: (id) => this.version(id),
      keyedUnder: (source, kind, prefix) => this.keyedUnder(source, kind, prefix),
      erasedUnder: (source, kind, prefix) => this.erasedUnder(source, kind, prefix),
      naming: (blob) => this.naming(blob),
      statements: (after, filter) => this.statements(after, filter),
      history: (ref) => this.history(ref),
      sources: (selector) => this.sources(selector),
      source: (id) => this.source(id),
      since: (source, kinds) => this.since(source, kinds),
      extract: (of, unit) => (of === family ? rows : this).extract(of, unit),
      extracts: (of, range) => (of === family ? rows : this).extracts(of, range),
      extractsUnder: (of, prefix) => (of === family ? rows : this).extractsUnder(of, prefix),
      extractsOn: (of, day) => this.extractsOn(of, day),
      unitsPending: (of) => this.#unitsPending(of, of === family ? reread : this.#extractReread(of)),
      enrichment: (of, item, prompt) => this.enrichment(of, item, prompt),
    };
  }

  unitsPending(family: string): boolean {
    return this.#unitsPending(family, this.#extractReread(family));
  }

  #extractReread(family: string): number {
    this.#check();
    return this.sql.get<{ reread: number }>("SELECT reread FROM cursors WHERE name = ?", `extract:${family}`)?.reread ?? 0;
  }

  #unitsPending(family: string, after: number): boolean {
    this.#check();
    return this.sql.get("SELECT 1 FROM rereads WHERE seq > ? AND family = ? LIMIT 1", after, family) !== undefined;
  }

  #extract(table: ExtractTable, family: string, unit: string): ExtractRow | undefined {
    this.#check();
    const row = this.sql.get<Parameters<typeof extract>[0]>(`SELECT ${COLUMNS.extracts} FROM ${table} WHERE family = ? AND unit = ?`, family, unit);
    return row && extract(row);
  }

  *#extracts(table: ExtractTable, family: string, range?: Range): Iterable<ExtractRow> {
    if (range === undefined) {
      let after = "";
      for (;;) {
        this.#check();
        const page = this.sql.all<Parameters<typeof extract>[0] & { unit: string }>(
          `SELECT ${COLUMNS.extracts} FROM ${table} WHERE family = ? AND unit > ? ORDER BY unit LIMIT ?`, family, after, PAGE,
        );
        yield* page.map(extract);
        if (page.length < PAGE) return;
        after = page[page.length - 1]!.unit;
      }
    }
    let cursor: [number, string] = [(range.start_ms ?? Number.MIN_SAFE_INTEGER) - 1, "\uffff"];
    for (;;) {
      this.#check();
      const page = this.sql.all<Parameters<typeof extract>[0] & { start_ms: number; unit: string }>(
        `SELECT ${COLUMNS.extracts} FROM ${table} WHERE family = ? AND start_ms IS NOT NULL AND start_ms < ? AND (start_ms, unit) > (?, ?) ORDER BY start_ms, unit LIMIT ?`,
        family, range.end_ms ?? Number.MAX_SAFE_INTEGER, cursor[0], cursor[1], PAGE,
      );
      yield* page.map(extract);
      if (page.length < PAGE) return;
      const last = page[page.length - 1]!;
      cursor = [last.start_ms, last.unit];
    }
  }

  *#extractsUnder(table: ExtractTable, family: string, prefix: string): Iterable<ExtractRow> {
    const bound = beyond(prefix);
    for (let after = prefix; ;) {
      this.#check();
      const page = this.sql.all<Parameters<typeof extract>[0] & { unit: string }>(
        `SELECT ${COLUMNS.extracts} FROM ${table} WHERE family = ? AND unit >= ? AND unit < ? ORDER BY unit LIMIT ?`, family, after, bound, PAGE,
      );
      yield* page.map(extract);
      if (page.length < PAGE) return;
      after = `${page[page.length - 1]!.unit}\0`;
    }
  }

  *extractReadings(family: string, prefix?: string): Iterable<{ unit: string; reading: string; code: string }> {
    for (let after = prefix ?? ""; ;) {
      this.#check();
      const page = prefix === undefined
        ? this.sql.all<{ unit: string; reading: string; code: string }>(
          "SELECT unit, reading, code FROM extracts WHERE family = ? AND unit >= ? ORDER BY unit LIMIT ?", family, after, PAGE)
        : this.sql.all<{ unit: string; reading: string; code: string }>(
          "SELECT unit, reading, code FROM extracts WHERE family = ? AND unit >= ? AND unit < ? ORDER BY unit LIMIT ?", family, after, beyond(prefix), PAGE);
      yield* page;
      if (page.length < PAGE) return;
      after = `${page[page.length - 1]!.unit}\0`;
    }
  }

  extractsOn(family: string, day: string): ExtractRow[] {
    this.#check();
    return this.sql
      .all<Parameters<typeof extract>[0]>(
        `SELECT ${columnsOf("extracts", "e")} FROM extract_days d CROSS JOIN extracts e ON e.family = d.family AND e.unit = d.unit
           WHERE d.family = ? AND d.day = ? ORDER BY d.unit`,
        family, day,
      )
      .map(extract);
  }

  extractPage(family: string, select: ExtractSelect, after: ExtractAfter | null, limit: number): (ExtractRow & { items: string[] })[] {
    this.#check();
    type Stored = Parameters<typeof extract>[0] & { items: string };
    let rows: Stored[];
    if ("unit" in select) {
      rows = this.sql.all<Stored>(`SELECT ${COLUMNS.extracts} FROM extracts WHERE family = ? AND unit = ?`, family, select.unit);
    } else if ("day" in select) {
      rows = this.sql.all<Stored>(
        `SELECT ${columnsOf("extracts", "e")} FROM extract_days d CROSS JOIN extracts e ON e.family = d.family AND e.unit = d.unit
           WHERE d.family = ? AND d.day = ? AND d.unit > ? ORDER BY d.unit LIMIT ?`,
        family, select.day, after?.unit ?? "", limit,
      );
    } else {
      const [start, unit] = after === null || after.start_ms === null ? [select.start_ms, ""] : [after.start_ms, after.unit];
      rows = this.sql.all<Stored>(
        `SELECT ${COLUMNS.extracts} FROM extracts WHERE family = ? AND start_ms >= ? AND start_ms < ? AND (start_ms, unit) > (?, ?)
           ORDER BY start_ms, unit LIMIT ?`,
        family, Math.max(select.start_ms, start), select.end_ms, start, unit, limit,
      );
    }
    return rows.map((row) => ({ ...extract(row), items: JSON.parse(row.items) as string[] }));
  }

  dayUnits(family: string, unit: string): (Omit<DayUnit, "family" | "unit"> & { day: string })[] {
    this.#check();
    return this.sql.all<{ day: string; reading: string; code: string; shown: number }>(
      "SELECT day, reading, code, shown FROM day_units WHERE family = ? AND unit = ? ORDER BY day", family, unit,
    ).map((row) => ({ day: row.day, reading: row.reading, code: row.code, shown: row.shown === 1 }));
  }

  rereads(after: number, limit: number): Reread[] {
    this.#check();
    return readRereads(this.sql, after, limit);
  }

  newestReread(): number {
    this.#check();
    return newestReread(this.sql);
  }

  holds(blob: string): boolean {
    this.#check();
    return this.sql.get("SELECT 1 FROM version_blobs WHERE blob = ? LIMIT 1", blob) !== undefined;
  }

  enrichment(family: string, item: string, prompt: string): EnrichmentRow | undefined {
    this.#check();
    const row = this.sql.get<Parameters<typeof enrichment>[0]>(
      `SELECT ${COLUMNS.enrichments} FROM enrichments WHERE family = ? AND item = ? AND prompt = ?`, family, item, prompt,
    );
    return row && enrichment(row);
  }

  kinds(source: string): string[] {
    this.#check();
    return kindsOf(this.sql, source);
  }

  count(source: string, kind: string): number | null {
    this.#check();
    const row = this.sql.get<{ live: number | null }>("SELECT live FROM spans WHERE source = ? AND kind = ?", source, kind);
    return row === undefined ? 0 : row.live;
  }

  planRepair(spec: RepairSpec, after: RepairAt | null = null): RepairPlan<RepairAt> {
    this.#check();
    return planRepair(this.sql, spec, after);
  }

  planUndo(run: number, spec: Partial<UndoSpec> = {}): RepairPlan<number> {
    this.#check();
    return planUndo(this.sql, run, { ...spec, through: spec.through ?? this.through });
  }

  #check(): void {
    if (!this.#open) throw new Error("this view is closed");
  }
}

function beyond(prefix: string): string {
  if (prefix === "") throw new RangeError("a seek by prefix needs a prefix");
  const last = [...prefix].at(-1)!;
  return prefix.slice(0, -last.length) + String.fromCodePoint(last.codePointAt(0)! + 1);
}
