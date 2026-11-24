import Database from "better-sqlite3";

export type Statement = Database.Statement<unknown[], unknown>;

export class Moved {
  readonly statements = new Map<string, { source: string; kind: string; stated_ms: number; linked_ms: number | null }>();
  readonly heads = new Map<string, { source: string; kind: string }>();
  readonly rereads = new Map<string, { source: string; kind: string } | { family: string }>();
  reread = 0;
  readonly read = new Map<string, { before: number | null; after: number }>();
  readonly deliveries = new Set<string>();
  readonly imported = new Set<string>();
  readonly custody = new Set<string>();
  readonly sources = new Set<string>();
  readonly pending: { family: string; item: string; reply_key: string | null; unit: string }[] = [];
  readonly resets = new Set<string>();
  readonly rendered = new Set<string>();
  readonly extracts = new Set<string>();
  readonly events = new Set<string>();
  readonly cursors = new Set<string>();
  rereadsRead = false;
  history = false;

  statement(source: string, kind: string, stated_ms: number, linked: boolean): void {
    const linked_ms = linked ? stated_ms : null;
    const known = this.statements.get(`${source}\0${kind}`);
    if (known === undefined) this.statements.set(`${source}\0${kind}`, { source, kind, stated_ms, linked_ms });
    else {
      known.stated_ms = Math.max(known.stated_ms, stated_ms);
      if (linked_ms !== null) known.linked_ms = Math.max(known.linked_ms ?? linked_ms, linked_ms);
    }
  }

  head(source: string, kind: string): void {
    this.heads.set(`${source}\0${kind}`, { source, kind });
  }

  rereadOf(seq: number, of: { source: string; kind: string } | { family: string }): void {
    this.rereads.set("family" in of ? `\0${of.family}` : `${of.source}\0${of.kind}`, of);
    this.reread = Math.max(this.reread, seq);
  }

  clear(): void {
    for (const each of [this.statements, this.heads, this.rereads, this.read, this.deliveries, this.imported, this.custody, this.sources, this.resets, this.rendered, this.extracts, this.events, this.cursors]) each.clear();
    this.pending.length = 0;
    this.reread = 0;
    this.rereadsRead = false;
    this.history = false;
  }
}

export const COLUMNS = {
  versions: "id, text, kind, key, start_ms, end_ms, offset_min, precision",
  statements: "seq, source, kind, key, version, stated_ms, run, device, locator, origin, late",
  heads: "source, kind, key, version, stated_ms, since_ms, start_ms, end_ms",
  rereads: "seq, source, kind, key, family, unit",
  sources: "id, product, vendor, account, copy, connector, options, read_through_ms, added_ms",
  devices: "unit, model, added_ms, retired_ms",
  polls: "acquirer, next_ms, paged_ms, page_next_ms, held_ms, pages",
  backfills: "source, acquirer, left, unit, start_ms, recent, last",
  deliveries: "id, source, sealed_ms, stated_ms, facts, state, run, failures, error, pass, seal, lost, refused, read_by",
  runs: "id, kind, subject, started_ms, ended_ms, outcome, counts, changed_paths, error",
  cursors: "name, seq, reread, at_ms, fingerprint, generation",
  jobs: "id, kind, key, connector, lane, state, not_before_ms, attempts, requeue, progress, created_ms, started_ms, ended_ms, error",
  controls: "target, reason, at_ms, by",
  attempts: "target, source, outcome, reason, facts, detail, since_ms, at_ms, contact_ms, fails",
  extracts: "family, unit, reading, code, content, start_ms, end_ms, days, items, seq",
  enrichments: "family, item, prompt, input_hash, reply_key, reused_from, content, state",
} as const;

export function columnsOf(table: keyof typeof COLUMNS, alias: string): string {
  return COLUMNS[table].split(", ").map((column) => `${alias}.${column}`).join(", ");
}

const SHAPED = /\bSELECT\s+(?:DISTINCT\s+)?\*|\b\w+\.\*|\bINSERT\s+(?:OR\s+\w+\s+)?INTO\s+\w+\s+(?:VALUES|SELECT)\b/iu;

export class Sql {
  readonly #cache = new Map<string, Statement>();
  state: "idle" | "commit" | "view" = "idle";
  readonly moved = new Moved();

  constructor(readonly db: Database.Database) {}

  q(text: string): Statement {
    let statement = this.#cache.get(text);
    if (statement === undefined) {
      if (SHAPED.test(text)) throw new Error(`a statement names its columns, so a column a newer release added changes nothing: ${text}`);
      statement = this.db.prepare(text);
      this.#cache.set(text, statement);
    }
    return statement;
  }

  get<T>(text: string, ...params: unknown[]): T | undefined {
    return this.on(() => this.q(text).get(...params)) as T | undefined;
  }

  all<T>(text: string, ...params: unknown[]): T[] {
    return this.on(() => this.q(text).all(...params)) as T[];
  }

  run(text: string, ...params: unknown[]): Database.RunResult {
    return this.on(() => this.q(text).run(...params));
  }

  on<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw homeError(error);
    }
  }

  writing(): void {
    if (this.state !== "commit") throw new Error("this write belongs inside db.commit()");
  }
}

export const HOME_DB = "home.db";
export const LEDGER_DB = "replies.db";
export type StorageOrigin = typeof HOME_DB | typeof LEDGER_DB;

export type SqliteError = Error & { name: "SqliteError"; code: string };

export function isSqliteError(error: unknown): error is SqliteError {
  const shape = error as { name?: unknown; code?: unknown } | null;
  return typeof shape === "object" && shape !== null && shape.name === "SqliteError" && typeof shape.code === "string";
}

export function homeError(error: unknown, database: StorageOrigin = HOME_DB): unknown {
  if (isSqliteError(error) || damaged(error)) Object.assign(error as object, { database });
  return error;
}

export function damaged(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^(?:SQLITE_(?:CORRUPT|NOTADB)|STORE_(?:KEY|PLAIN)$)/u.test(code);
}

export function marks(count: number): string {
  return new Array<string>(count).fill("?").join(", ");
}
