import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { accountOf } from "@lifestreamprotocol/core";
import { UNTIMED } from "./search-scan.js";


export const FACTS_TABLES = [
  "fact", "fact_measure", "fact_line", "entry_fact", "fact_rival",
  "combos", "combo_keys", "crews", "crew_members", "totals", "tally", "day_total", "facts_owed", "line_accounts", "entry_states",
] as const;

export const FACTS_SCHEMA = `
-- The facts layer. One row per fact a day's statement stands for, owned by that day; fid kept through every move.
CREATE TABLE fact (
  fid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, of TEXT NOT NULL, combo INTEGER NOT NULL, crew INTEGER NOT NULL,
  day TEXT NOT NULL, time_ms INTEGER NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, date_only INTEGER NOT NULL,
  source TEXT NOT NULL,             -- '' for none
  record TEXT, unit TEXT NOT NULL, item TEXT, accounts TEXT
) STRICT;
-- A collection's facts over a time range, with all a count reads of each: its walk reads the index alone (measured, I8c:
-- 100,000 rows in 49 ms against 185 ms when each row is looked up in the table, at 47 MB more a million facts).
CREATE INDEX fact_of ON fact(of, time_ms, combo, crew, source, date_only, day, id, start_ms, end_ms);
-- A combination's facts in time order (a combination is of one collection), and a crew's of one collection (a crew is of none).
CREATE INDEX fact_combo ON fact(combo, time_ms);
CREATE INDEX fact_crew ON fact(crew, of, time_ms);
-- A day's, for the writer; a day's of one collection, for a count whose gate cuts that day; a record's.
CREATE INDEX fact_day ON fact(day, of);
CREATE INDEX fact_record ON fact(record) WHERE record IS NOT NULL;
CREATE TABLE fact_measure (fid INTEGER NOT NULL, measure TEXT NOT NULL, value ANY NOT NULL, PRIMARY KEY (fid, measure)) STRICT, WITHOUT ROWID;
-- The lines that print a fact while it has a row: of the day that holds it and of each day whose claim lost; atom: its n.
CREATE TABLE fact_line (fid INTEGER NOT NULL, day TEXT NOT NULL, atom INTEGER NOT NULL, PRIMARY KEY (day, atom, fid)) STRICT, WITHOUT ROWID;
CREATE INDEX fact_line_fid ON fact_line(fid);
CREATE TABLE entry_fact (slot INTEGER NOT NULL, fid INTEGER NOT NULL, PRIMARY KEY (slot, fid)) STRICT, WITHOUT ROWID;
CREATE INDEX entry_fact_fid ON entry_fact(fid);
CREATE TABLE line_accounts (day TEXT NOT NULL, atom INTEGER NOT NULL, accounts TEXT NOT NULL, PRIMARY KEY (day, atom)) STRICT, WITHOUT ROWID;
CREATE TABLE entry_states (slot INTEGER PRIMARY KEY, accounts TEXT NOT NULL, who TEXT, chat TEXT) STRICT;
-- Each claim a day's file makes on a fact that another day's statement holds (it lost, or was taken from): the statement
-- as that file states it (Claim, JSON, its lines among it), owned by the claiming day. When the holder's stamp falls, or its
-- file no longer claims the fact, the newest claim standing takes it from here, no file read again (Arbiter.reconcile).
CREATE TABLE fact_rival (id TEXT NOT NULL, day TEXT NOT NULL, claim TEXT NOT NULL, PRIMARY KEY (id, day)) STRICT, WITHOUT ROWID;
CREATE INDEX fact_rival_day ON fact_rival(day);

-- Each distinct set of key values a collection's facts state, as one number: keys is each key and its value's id in names,
-- ordered by key (key and id joined by char(31), pairs by char(30); '' for none). Kept once no fact states it: it holds ids alone.
CREATE TABLE combos (id INTEGER PRIMARY KEY, of TEXT NOT NULL, keys TEXT NOT NULL, UNIQUE (of, keys)) STRICT;
CREATE TABLE combo_keys (of TEXT NOT NULL, key TEXT NOT NULL, name INTEGER NOT NULL, combo INTEGER NOT NULL, PRIMARY KEY (of, key, name, combo)) STRICT, WITHOUT ROWID;
-- Each distinct set of handles a fact names (each once, in order, joined by char(30)), as one number; a fact naming none is
-- crew 0. n: the tally rows that name it; gone once none does and no fact names it, at the end of the write, so an erased
-- handle leaves no crew.
CREATE TABLE crews (id INTEGER PRIMARY KEY, handles TEXT NOT NULL UNIQUE, n INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE TABLE crew_members (handle TEXT NOT NULL, crew INTEGER NOT NULL, PRIMARY KEY (handle, crew)) STRICT, WITHOUT ROWID;
-- A collection's facts naming a crew (crew 0: none) under a combination, resting on the same accounts, every day: the sum of
-- the tally rows' n of that collection, crew, combination and accounts, with the first and the last day a tally row of them is
-- of. Gone with its last tally row.
CREATE TABLE totals (of TEXT NOT NULL, crew INTEGER NOT NULL, combo INTEGER NOT NULL, accounts TEXT NOT NULL, n INTEGER NOT NULL, first TEXT NOT NULL, last TEXT NOT NULL,
  PRIMARY KEY (of, crew, combo, accounts)) STRICT, WITHOUT ROWID;
CREATE INDEX totals_combo ON totals(of, combo, crew);
-- A day's facts of a collection by combination, crew, source ('' for none) and the accounts they rest on (their stated
-- accounts, else their record's, joined by char(30); '' for none): how many, the first and last time_ms, the first and
-- last start_ms. Owned by the day of the facts' time, as the facts are.
CREATE TABLE tally (of TEXT NOT NULL, day TEXT NOT NULL, combo INTEGER NOT NULL, crew INTEGER NOT NULL, source TEXT NOT NULL, accounts TEXT NOT NULL,
  n INTEGER NOT NULL, t INTEGER NOT NULL, u INTEGER NOT NULL, start_min INTEGER NOT NULL, start_max INTEGER NOT NULL,
  PRIMARY KEY (of, day, combo, crew, source, accounts)) STRICT, WITHOUT ROWID;
-- A combination's cells and a crew's, in day order, with all a count reads of each: its walk reads the index alone
-- (measured: 91,000 cells of one crew over ten years, 1,727 pages read cold against 22,576 when each is looked up in the table).
CREATE INDEX tally_combo ON tally(of, combo, day, n, t, u, start_min, start_max);
CREATE INDEX tally_crew ON tally(of, crew, day, n, t, u, start_min, start_max);
-- A day's rows, for the writer's recount of one day (FactsLayer.tally): read and removed by the day alone.
CREATE INDEX tally_day ON tally(day);
-- A day's facts of a collection by source and accounts alone: what a count with no filter reads, one row a day, source
-- and accounts.
CREATE TABLE day_total (of TEXT NOT NULL, day TEXT NOT NULL, source TEXT NOT NULL, accounts TEXT NOT NULL, n INTEGER NOT NULL, t INTEGER NOT NULL, u INTEGER NOT NULL,
  start_min INTEGER NOT NULL, start_max INTEGER NOT NULL, PRIMARY KEY (of, day, source, accounts)) STRICT, WITHOUT ROWID;
CREATE INDEX day_total_day ON day_total(day);
-- The days whose facts the layer has not read since it was made again in place (rebuildFacts): every collection is building
-- while one is listed.
CREATE TABLE facts_owed (day TEXT PRIMARY KEY) STRICT, WITHOUT ROWID;
`;

export const FACTS_FORMAT = createHash("sha256").update(FACTS_SCHEMA).digest("hex").slice(0, 16);

const FACTS_META = ["slack", "untimed", "span"] as const;

export interface Claim {
  of: string;
  time_ms: number;
  start_ms: number;
  end_ms: number;
  date_only: 0 | 1;
  unit: string;
  record: string | null;
  item: string | null;
  source: string | null;
  accounts: string[] | null;
  keys: [string, string][];
  who: string[];
  measures: [string, number][];
  lines: number[];
}

export interface Cite {
  cite: true;
  lines: number[];
}

type Get = (sql: string) => Database.Statement;

export function comboKeys(keys: string): [string, number][] {
  return keys === "" ? [] : keys.split("\x1e").map((pair) => {
    const cut = pair.indexOf("\x1f");
    return [pair.slice(0, cut), Number(pair.slice(cut + 1))];
  });
}

export function rebuildFacts(db: Database.Database): void {
  for (const table of FACTS_TABLES) db.exec(`DROP TABLE IF EXISTS ${table}`);
  db.exec(FACTS_SCHEMA);
  db.exec("DELETE FROM unmarked_values");
  db.exec("DELETE FROM names WHERE role = 'value'");
  for (const key of FACTS_META) db.prepare("DELETE FROM meta WHERE key = ?").run(key);
  db.exec("INSERT INTO facts_owed (day) SELECT day FROM days WHERE inputs <> ''");
  db.prepare("INSERT INTO meta (key, value) VALUES ('states_owed', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(String(UNTIMED));
  db.exec("UPDATE meta SET value = (SELECT value FROM meta WHERE key = 'entries') WHERE key = 'unstated'");
  db.prepare("INSERT INTO meta (key, value) VALUES ('facts_format', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(FACTS_FORMAT);
  db.prepare("INSERT INTO meta (key, value) VALUES ('facts_build', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(factsBuild());
}

export function factsBuild(): string {
  return randomUUID();
}

export class FactsLayer {
  readonly #loose = new Map<string, number>();
  readonly #crews = new Set<number>();
  readonly #span = new Map<string, number>();
  readonly #moved = new Map<number, { n: number; detail: number }>();
  readonly #keys = new Map<number, [string, number][]>();

  constructor(private readonly get: Get, private readonly value: (value: string) => number, private readonly structure: (key: string) => boolean) {}

  release(day: string): void {
    for (const { fid, id } of this.get("SELECT fid, id FROM fact WHERE day = ?").all(day) as { fid: number; id: string }[]) this.#loose.set(id, fid);
    this.get("DELETE FROM fact_line WHERE day = ?").run(day);
    this.get("DELETE FROM line_accounts WHERE day = ?").run(day);
  }

  stateLines(day: string, lines: readonly { n: number; accounts?: readonly string[] }[]): void {
    const stated = this.get("INSERT INTO line_accounts (day, atom, accounts) VALUES (?, ?, ?)");
    for (const line of lines) if (line.accounts !== undefined) stated.run(day, line.n, [...new Set(line.accounts)].sort().join("\x1e"));
  }

  loose(id: string): boolean {
    return this.#loose.has(id);
  }

  unseat(id: string): void {
    const fid = this.get("SELECT fid FROM fact WHERE id = ?").pluck().get(id) as number | undefined;
    if (fid !== undefined) this.#loose.set(id, fid);
  }

  install(id: string, day: string, claim: Claim): void {
    const combo = this.#combo(claim.of, claim.keys);
    const crew = this.#crew(claim.who);
    const held = this.get("SELECT fid, combo FROM fact WHERE id = ?").get(id) as { fid: number; combo: number } | undefined;
    const row = {
      id, of: claim.of, combo, crew, day, time_ms: claim.time_ms, start_ms: claim.start_ms, end_ms: claim.end_ms, date_only: claim.date_only,
      source: claim.source ?? "", record: claim.record, unit: claim.unit, item: claim.item, accounts: claim.accounts === null ? null : claim.accounts.join("\x1e"),
    };
    let fid: number;
    if (held === undefined) {
      fid = Number(this.get(`INSERT INTO fact (id, of, combo, crew, day, time_ms, start_ms, end_ms, date_only, source, record, unit, item, accounts)
        VALUES (@id, @of, @combo, @crew, @day, @time_ms, @start_ms, @end_ms, @date_only, @source, @record, @unit, @item, @accounts)`).run(row).lastInsertRowid);
    } else {
      fid = held.fid;
      this.get(`UPDATE fact SET of = @of, combo = @combo, crew = @crew, day = @day, time_ms = @time_ms, start_ms = @start_ms, end_ms = @end_ms,
        date_only = @date_only, source = @source, record = @record, unit = @unit, item = @item, accounts = @accounts WHERE fid = @fid`).run({ ...row, fid });
      this.get("DELETE FROM fact_measure WHERE fid = ?").run(fid);
    }
    const was = held?.combo;
    this.#loose.delete(id);
    if (was !== combo) {
      this.#count(combo, 1);
      if (was !== undefined) this.#count(was, -1);
    }
    const measure = this.get("INSERT OR IGNORE INTO fact_measure (fid, measure, value) VALUES (?, ?, ?)");
    for (const [name, value] of claim.measures) measure.run(fid, name, value);
    this.#lines(fid, day, claim.lines);
    for (const { day: rival, claim: kept } of this.get("SELECT day, claim FROM fact_rival WHERE id = ?").all(id) as { day: string; claim: string }[]) {
      this.#lines(fid, rival, (JSON.parse(kept) as Claim | Cite).lines);
    }
    if (claim.date_only === 0) this.#span.set(claim.of, Math.max(this.#span.get(claim.of) ?? 0, claim.end_ms - claim.start_ms));
  }

  rival(id: string, day: string, lines: readonly number[]): void {
    const fid = this.get("SELECT fid FROM fact WHERE id = ?").pluck().get(id) as number | undefined;
    if (fid !== undefined) this.#lines(fid, day, lines);
  }

  fid(id: string): number | undefined {
    return this.get("SELECT fid FROM fact WHERE id = ?").pluck().get(id) as number | undefined;
  }

  settle(unstated: (of: string, slots: readonly number[]) => void): void {
    for (const fid of this.#loose.values()) {
      const gone = this.get("DELETE FROM fact WHERE fid = ? RETURNING of, combo").get(fid) as { of: string; combo: number } | undefined;
      if (gone === undefined) continue;
      this.#count(gone.combo, -1);
      unstated(gone.of, this.get("DELETE FROM entry_fact WHERE fid = ? RETURNING slot").pluck().all(fid) as number[]);
      for (const table of ["fact_measure", "fact_line"]) this.get(`DELETE FROM ${table} WHERE fid = ?`).run(fid);
    }
    this.#loose.clear();
    this.#counted();
    if (this.#span.size === 0) return;
    const held = JSON.parse(this.get("SELECT value FROM meta WHERE key = 'span'").pluck().get() as string | undefined ?? "{}") as Record<string, number>;
    let grew = false;
    for (const [of, ms] of this.#span) {
      if ((held[of] ?? -1) >= ms) continue;
      held[of] = ms;
      grew = true;
    }
    this.#span.clear();
    if (grew) {
      const sorted = Object.fromEntries(Object.entries(held).sort(([a], [b]) => (a < b ? -1 : 1)));
      this.get("INSERT INTO meta (key, value) VALUES ('span', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(JSON.stringify(sorted));
    }
  }

  tally(day: string): void {
    const before = new Map<string, number>();
    for (const row of this.get("SELECT of, crew, combo, accounts, count(*) AS rows, sum(n) AS n FROM tally WHERE day = ? GROUP BY of, crew, combo, accounts").all(day) as KeyedRow[]) {
      before.set(pairKey(row), row.n);
      if (row.crew !== 0) {
        this.get("UPDATE crews SET n = n - ? WHERE id = ?").run(row.rows, row.crew);
        this.#crews.add(row.crew);
      }
    }
    this.get("DELETE FROM tally WHERE day = ?").run(day);
    this.get("DELETE FROM day_total WHERE day = ?").run(day);
    const tallies = new Map<string, Tallied>();
    const totals = new Map<string, Tallied>();
    for (const fact of this.get("SELECT of, combo, crew, source, accounts, record, time_ms, start_ms FROM fact WHERE day = ?").all(day) as HeldFact[]) {
      const accounts = factAccounts(fact.accounts, fact.record);
      tallied(tallies, [fact.of, fact.combo, fact.crew, fact.source, accounts], fact);
      tallied(totals, [fact.of, fact.source, accounts], fact);
    }
    const tally = this.get("INSERT INTO tally (of, day, combo, crew, source, accounts, n, t, u, start_min, start_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const { key: [of, combo, crew, source, accounts], n, t, u, start_min, start_max } of tallies.values()) tally.run(of, day, combo, crew, source, accounts, n, t, u, start_min, start_max);
    const total = this.get("INSERT INTO day_total (of, day, source, accounts, n, t, u, start_min, start_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const { key: [of, source, accounts], n, t, u, start_min, start_max } of totals.values()) total.run(of, day, source, accounts, n, t, u, start_min, start_max);
    const after = new Map<string, number>();
    for (const row of this.get("SELECT of, crew, combo, accounts, count(*) AS rows, sum(n) AS n FROM tally WHERE day = ? GROUP BY of, crew, combo, accounts").all(day) as KeyedRow[]) {
      after.set(pairKey(row), row.n);
      if (row.crew !== 0) this.get("UPDATE crews SET n = n + ? WHERE id = ?").run(row.rows, row.crew);
    }
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const [of, crew, combo, accounts] = pairOf(key);
      const was = before.get(key) ?? 0;
      const is = after.get(key) ?? 0;
      const row = this.get("SELECT n, first, last FROM totals WHERE of = ? AND crew = ? AND combo = ? AND accounts = ?").get(of, crew, combo, accounts) as { n: number; first: string; last: string } | undefined;
      const n = (row?.n ?? 0) - was + is;
      if (n === 0) {
        this.get("DELETE FROM totals WHERE of = ? AND crew = ? AND combo = ? AND accounts = ?").run(of, crew, combo, accounts);
        continue;
      }
      let first = row?.first ?? day;
      let last = row?.last ?? day;
      if (is > 0) {
        if (day < first) first = day;
        if (day > last) last = day;
      } else {
        if (first === day) first = this.#edge(of, crew, combo, accounts, "first");
        if (last === day) last = this.#edge(of, crew, combo, accounts, "last");
      }
      this.get(`INSERT INTO totals (of, crew, combo, accounts, n, first, last) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (of, crew, combo, accounts) DO UPDATE SET n = excluded.n, first = excluded.first, last = excluded.last`).run(of, crew, combo, accounts, n, first, last);
    }
  }

  prune(): void {
    for (const crew of this.#crews) {
      if (this.get("SELECT 1 FROM fact WHERE crew = ? LIMIT 1").pluck().get(crew) !== undefined) continue;
      const gone = this.get("DELETE FROM crews WHERE id = ? AND n = 0 RETURNING handles").pluck().get(crew) as string | undefined;
      if (gone !== undefined) for (const handle of gone.split("\x1e")) this.get("DELETE FROM crew_members WHERE handle = ? AND crew = ?").run(handle, crew);
    }
    this.#crews.clear();
  }

  #edge(of: string, crew: number, combo: number, accounts: string, which: "first" | "last"): string {
    return this.get(`SELECT day FROM tally WHERE of = ? AND crew = ? AND combo = ? AND accounts = ? ORDER BY day ${which === "first" ? "ASC" : "DESC"} LIMIT 1`).pluck().get(of, crew, combo, accounts) as string;
  }

  held(id: string, day: string): Claim {
    const row = this.get("SELECT fid, of, combo, crew, time_ms, start_ms, end_ms, date_only, unit, record, item, source, accounts FROM fact WHERE id = ?").get(id) as
      Omit<Claim, "keys" | "who" | "measures" | "lines" | "source" | "accounts"> & { fid: number; combo: number; crew: number; source: string; accounts: string | null };
    const keys = this.get("SELECT keys FROM combos WHERE id = ?").pluck().get(row.combo) as string;
    const spelled = this.get("SELECT name FROM names WHERE id = ?").pluck();
    const handles = row.crew === 0 ? "" : this.get("SELECT handles FROM crews WHERE id = ?").pluck().get(row.crew) as string;
    return {
      of: row.of, time_ms: row.time_ms, start_ms: row.start_ms, end_ms: row.end_ms, date_only: row.date_only, unit: row.unit, record: row.record, item: row.item,
      source: row.source === "" ? null : row.source,
      accounts: row.accounts === null ? null : row.accounts.split("\x1e"),
      keys: comboKeys(keys).map(([key, name]) => [key, spelled.get(name) as string]),
      who: handles === "" ? [] : handles.split("\x1e"),
      measures: (this.get("SELECT measure, value FROM fact_measure WHERE fid = ? ORDER BY measure").all(row.fid) as { measure: string; value: number }[]).map(({ measure, value }) => [measure, value]),
      lines: this.get("SELECT atom FROM fact_line WHERE fid = ? AND day = ? ORDER BY atom").pluck().all(row.fid, day) as number[],
    };
  }

  #count(combo: number, more: 1 | -1): void {
    let keys = this.#keys.get(combo);
    if (keys === undefined) {
      keys = comboKeys(this.get("SELECT keys FROM combos WHERE id = ?").pluck().get(combo) as string | undefined ?? "");
      this.#keys.set(combo, keys);
    }
    for (const [key, name] of keys) {
      const moved = this.#moved.get(name) ?? { n: 0, detail: 0 };
      moved.n += more;
      if (!this.structure(key)) moved.detail += more;
      this.#moved.set(name, moved);
    }
  }

  #counted(): void {
    for (const [name, moved] of this.#moved) {
      if (moved.n === 0 && moved.detail === 0) continue;
      const held = this.get("SELECT n, detail FROM names WHERE id = ?").get(name) as { n: number; detail: number } | undefined;
      if (held === undefined) continue;
      const left = { n: held.n + moved.n, detail: held.detail + moved.detail };
      if (held.detail === 0 && left.detail > 0) this.get("INSERT OR IGNORE INTO unmarked_values (name) VALUES (?)").run(name);
      if (held.detail > 0 && left.detail === 0) this.get("DELETE FROM unmarked_values WHERE name = ?").run(name);
      this.get("UPDATE names SET n = ?, detail = ? WHERE id = ?").run(left.n, left.detail, name);
      if (left.n === 0) this.get("DELETE FROM names WHERE id = ? AND role = 'value'").run(name);
    }
    this.#moved.clear();
  }

  #lines(fid: number, day: string, lines: readonly number[]): void {
    const line = this.get("INSERT OR IGNORE INTO fact_line (fid, day, atom) VALUES (?, ?, ?)");
    for (const atom of lines) line.run(fid, day, atom);
  }

  #combo(of: string, pairs: readonly [string, string][]): number {
    const keys = pairs.map(([key, value]) => [key, this.value(value)] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, name]) => `${key}\x1f${name}`).join("\x1e");
    const held = this.get("SELECT id FROM combos WHERE of = ? AND keys = ?").pluck().get(of, keys) as number | undefined;
    if (held !== undefined) return held;
    const id = Number(this.get("INSERT INTO combos (of, keys) VALUES (?, ?)").run(of, keys).lastInsertRowid);
    for (const [key, name] of comboKeys(keys)) this.get("INSERT INTO combo_keys (of, key, name, combo) VALUES (?, ?, ?, ?)").run(of, key, name, id);
    return id;
  }

  #crew(who: readonly string[]): number {
    const handles = [...new Set(who)].sort().join("\x1e");
    if (handles === "") return 0;
    const held = this.get("SELECT id FROM crews WHERE handles = ?").pluck().get(handles) as number | undefined;
    if (held !== undefined) return held;
    const id = Number(this.get("INSERT INTO crews (handles) VALUES (?)").run(handles).lastInsertRowid);
    for (const handle of handles.split("\x1e")) this.get("INSERT INTO crew_members (handle, crew) VALUES (?, ?)").run(handle, id);
    this.#crews.add(id);
    return id;
  }
}

export function factAccounts(stated: string | null, record: string | null): string {
  if (stated !== null) return stated;
  return record === null ? "" : accountOf(record.slice(0, record.indexOf("\0")));
}

interface HeldFact {
  of: string;
  combo: number;
  crew: number;
  source: string;
  accounts: string | null;
  record: string | null;
  time_ms: number;
  start_ms: number;
}

interface Tallied {
  key: (string | number)[];
  n: number;
  t: number;
  u: number;
  start_min: number;
  start_max: number;
}

function tallied(into: Map<string, Tallied>, key: (string | number)[], fact: HeldFact): void {
  const name = JSON.stringify(key);
  const held = into.get(name);
  if (held === undefined) {
    into.set(name, { key, n: 1, t: fact.time_ms, u: fact.time_ms, start_min: fact.start_ms, start_max: fact.start_ms });
    return;
  }
  held.n += 1;
  held.t = Math.min(held.t, fact.time_ms);
  held.u = Math.max(held.u, fact.time_ms);
  held.start_min = Math.min(held.start_min, fact.start_ms);
  held.start_max = Math.max(held.start_max, fact.start_ms);
}

interface KeyedRow {
  of: string;
  crew: number;
  combo: number;
  accounts: string;
  rows: number;
  n: number;
}

function pairKey(row: Pick<KeyedRow, "of" | "crew" | "combo" | "accounts">): string {
  return `${row.of}\0${row.crew}\0${row.combo}\0${row.accounts}`;
}

function pairOf(key: string): [string, number, number, string] {
  const [of, crew, combo, accounts] = key.split("\0") as [string, string, string, string];
  return [of, Number(crew), Number(combo), accounts];
}
