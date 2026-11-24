import { detailKey, LEVEL_NAMES, valueWord, type BaseType, type Box, type Drawn, type Entry, type LevelName, type PlaceholderTable, type Wanted } from "@lifestreamprotocol/core";
import type { Conn } from "./ledger.js";
import type { NewOutbound } from "./outbound.js";

export interface TablePart {
  table: PlaceholderTable;
  epoch: number;
  version: number;
}

export type Saved = { saved: true; seq: number | null } | { stale: true } | { erased: true } | { dropped: true };

const BATCH = 200;

export const DROPPED = -1;

export interface PlaceholderTables {
  part(scope: string, wanted: Wanted): TablePart;
  save(read: TablePart, answered: PlaceholderTable, outbound?: NewOutbound): Saved;
  faces(scope: string): Drawn[];
  drop(scope: string): void;
  keptLevel(scope: string): LevelName | null;
  keepLevel(scope: string, level: LevelName, first: boolean): LevelName;
  epoch(): Epoch;
  beginErasure(): void;
  endErasure(): void;
}

export interface Epoch {
  epoch: number;
  erasing: boolean;
}

export const READER_SCOPES = ["chat:", "grant:"] as const;

const ENTRY = "placeholder, type, detail, who, shown, face";

interface EntryRow {
  placeholder: string;
  type: string;
  detail: string;
  who: string | null;
  shown: string | null;
  face: string | null;
}

export function placeholdersOver(conn: Conn, outbound: (row: NewOutbound) => number): {
  tables: PlaceholderTables;
  startFaces(scope: string, faces: readonly Drawn[]): void;
  forget(keys: Iterable<string>): void;
} {
  const { sql, write } = conn;
  const epochRow = sql<{ epoch: number }>("SELECT CAST(value AS INTEGER) AS epoch FROM meta WHERE key = 'forget'");
  const moveEpoch = sql("INSERT INTO meta (key, value) VALUES ('forget', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
  const epochNow = () => epochRow.get()?.epoch ?? 0;
  const erasingRow = sql<{ one: number }>("SELECT 1 AS one FROM meta WHERE key = 'erasing'");
  const erasingNow = () => erasingRow.get() !== undefined;
  const markErasing = sql("INSERT INTO meta (key, value) VALUES ('erasing', '1') ON CONFLICT (key) DO NOTHING");
  const clearErasing = sql("DELETE FROM meta WHERE key = 'erasing'");
  const scopeRow = sql<{ next: string; version: number }>("SELECT next, version FROM placeholder_tables WHERE scope = ?");
  const byPlaceholder = sql<EntryRow & { at: number }>(`SELECT rowid AS at, ${ENTRY} FROM placeholder_entries WHERE scope = ? AND placeholder = ?`);
  const inList = (column: "key" | "word" | "who") => sql<EntryRow & { at: number }>(`SELECT rowid AS at, ${ENTRY} FROM placeholder_entries WHERE scope = ? AND ${column} IN (${new Array<string>(BATCH).fill("?").join(", ")})`);
  const byKey = inList("key");
  const byWord = inList("word");
  const byWho = inList("who");
  const faceRows = sql<{ placeholder: string; face: string }>("SELECT placeholder, face FROM placeholder_entries WHERE scope = ? AND face IS NOT NULL");
  const insert = sql("INSERT INTO placeholder_entries (scope, placeholder, type, detail, key, word, who, shown, face) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const gained = sql("UPDATE placeholder_entries SET who = ?, shown = ? WHERE scope = ? AND placeholder = ?");
  const upsert = sql(`INSERT INTO placeholder_tables (scope, next, version) VALUES (?, ?, 1)
    ON CONFLICT (scope) DO UPDATE SET next = excluded.next, version = version + 1`);
  const dropEntries = sql("DELETE FROM placeholder_entries WHERE scope = ?");
  const dropScope = sql("DELETE FROM placeholder_tables WHERE scope = ?");
  const tombstone = sql(`INSERT INTO placeholder_tables (scope, next, version) VALUES (?, '{}', ${DROPPED})
    ON CONFLICT (scope) DO UPDATE SET next = '{}', version = ${DROPPED}`);
  const emptyEntries = sql("DELETE FROM placeholder_entries WHERE scope >= ? AND scope < ?");
  const levelRow = sql<{ level: string }>("SELECT level FROM placeholder_levels WHERE scope = ?");
  const startLevel = sql("INSERT INTO placeholder_levels (scope, level) VALUES (?, ?) ON CONFLICT (scope) DO NOTHING");
  const pickLevel = sql("INSERT INTO placeholder_levels (scope, level) VALUES (?, ?) ON CONFLICT (scope) DO UPDATE SET level = excluded.level");
  const keptLevel = (scope: string): LevelName | null => {
    const level = levelRow.get(scope)?.level;
    return level === undefined ? null : level as LevelName;
  };

  const tables: PlaceholderTables = {
    part(scope, wanted) {
      const epoch = epochNow();
      const row = scopeRow.get(scope);
      const found = new Map<string, EntryRow & { at: number }>();
      const take = (rows: readonly (EntryRow & { at: number })[]) => {
        for (const each of rows) found.set(each.placeholder, each);
      };
      const takeAll = (statement: typeof byKey, values: ReadonlySet<string>) => {
        const batch: string[] = [];
        const flush = () => {
          if (batch.length === 0) return;
          while (batch.length < BATCH) batch.push(batch[0]!);
          take(statement.all(scope, ...batch));
          batch.length = 0;
        };
        for (const value of values) {
          batch.push(value);
          if (batch.length === BATCH) flush();
        }
        flush();
      };
      takeAll(byWho, wanted.who);
      takeAll(byKey, wanted.keys);
      takeAll(byWord, wanted.words);
      for (const placeholder of wanted.placeholders) take(byPlaceholder.all(scope, placeholder));
      const entries = [...found.values()].sort((left, right) => left.at - right.at).map(entryOf);
      return {
        table: { scope, entries, next: row === undefined ? {} : JSON.parse(row.next) as Partial<Record<BaseType, number>> },
        epoch,
        version: row?.version ?? 0,
      };
    },

    save(read, answered, row) {
      const { scope } = read.table;
      if (answered.scope !== scope) throw new TypeError(`a save of ${answered.scope} over a part of ${scope}`);
      return write((): Saved => {
        if (erasingNow() || epochNow() !== read.epoch) return { erased: true };
        const version = scopeRow.get(scope)?.version ?? 0;
        if (version === DROPPED || read.version === DROPPED) return { dropped: true };
        if (version !== read.version) return { stale: true };
        const held = new Map(read.table.entries.map((entry) => [entry.placeholder, entry]));
        let changed = JSON.stringify(sorted(answered.next)) !== JSON.stringify(sorted(read.table.next));
        for (const entry of answered.entries) {
          const before = held.get(entry.placeholder);
          if (before === undefined) {
            insert.run(scope, entry.placeholder, entry.type, entry.detail, detailKey(entry.type, entry.detail), valueWord(entry.detail), entry.who ?? null, entry.shown ?? null,
              entry.face === undefined ? null : JSON.stringify(entry.face));
            changed = true;
          } else if (before.who !== entry.who || before.shown !== entry.shown) {
            gained.run(entry.who ?? null, entry.shown ?? null, scope, entry.placeholder);
            changed = true;
          }
        }
        if (changed) upsert.run(scope, JSON.stringify(sorted(answered.next)));
        const seq = row === undefined ? null : outbound(row);
        return { saved: true, seq };
      });
    },

    faces(scope) {
      return faceRows.all(scope).map((row): Drawn => ({ placeholder: row.placeholder, box: JSON.parse(row.face) as Box }))
        .sort((left, right) => personNumber(left.placeholder) - personNumber(right.placeholder));
    },

    drop(scope) {
      write(() => {
        dropEntries.run(scope);
        tombstone.run(scope);
      });
    },

    keptLevel,

    keepLevel(scope, level, first) {
      if (!LEVEL_NAMES.includes(level)) throw new RangeError(`a conversation's level is ${LEVEL_NAMES.join(", ")}, not ${JSON.stringify(level)}`);
      return write(() => {
        (first ? startLevel : pickLevel).run(scope, level);
        return keptLevel(scope)!;
      });
    },

    epoch: () => ({ epoch: epochNow(), erasing: erasingNow() }),

    beginErasure() {
      write(() => {
        moveEpoch.run();
        markErasing.run();
      });
    },

    endErasure() {
      write(() => {
        moveEpoch.run();
        clearErasing.run();
      });
    },
  };

  return {
    tables,
    startFaces(scope, faces) {
      const row = scopeRow.get(scope);
      const next = row === undefined ? {} : JSON.parse(row.next) as Partial<Record<BaseType, number>>;
      for (const face of faces) insert.run(scope, face.placeholder, "person", "", detailKey("person", ""), valueWord(""), null, null, JSON.stringify(face.box));
      next.person = Math.max(next.person ?? 1, ...faces.map((face) => personNumber(face.placeholder) + 1));
      upsert.run(scope, JSON.stringify(sorted(next)));
    },
    forget(keys) {
      for (const key of keys) {
        dropEntries.run(`ask:${key}`);
        dropScope.run(`ask:${key}`);
      }
      for (const prefix of READER_SCOPES) emptyEntries.run(prefix, `${prefix.slice(0, -1)};`);
    },
  };
}

function entryOf(row: EntryRow): Entry {
  return {
    placeholder: row.placeholder, type: row.type as Entry["type"], detail: row.detail,
    ...(row.who === null ? {} : { who: row.who }), ...(row.shown === null ? {} : { shown: row.shown }),
    ...(row.face === null ? {} : { face: JSON.parse(row.face) as Box }),
  };
}

function personNumber(placeholder: string): number {
  const number = /^\[\[Person (\d+)\]\]$/u.exec(placeholder)?.[1];
  if (number === undefined) throw new TypeError(`a face's placeholder is [[Person N]], not ${JSON.stringify(placeholder)}`);
  return Number(number);
}

function sorted(next: PlaceholderTable["next"]): Record<string, number> {
  return Object.fromEntries(Object.entries(next).sort(([left], [right]) => left.localeCompare(right)));
}
