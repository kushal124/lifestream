import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { GONE, selects, type DaySettings, type Head, type HomeFolder, type OpenView, type RecordRef, type SourceRow, type Statement, type Version } from "@lifestreamprotocol/core";
import { kindsRead, RENDERER_VERSION, textFamilyOf, type Change, type DayDocument, type DayFileFact, type Family, type NameSpan } from "@lifestreamprotocol/families";
import { dayFile, readDayHead } from "./derive.js";
import { failpoint } from "./failpoint.js";
import type { Index } from "./index-file.js";
import { errorText, homeFault, type HelperEnv } from "./jobs.js";
import { searchQueue } from "./marking.js";
import { readerOf, type Inputs } from "./registry.js";
import { buildingFileOf, SearchIndex, searchFileOf, statementName, type AtomEntry, type IndexedDay, type IndexPosition, type RecordEntry, type Texts } from "./search-index.js";


const CHUNK_STATEMENTS = 2_000;
const RUN_STATEMENTS = 50_000;
export const RUN_DAYS = 200;
const RUN_MS = 60_000;
const HELD_WAIT_MS = 10_000;
const DATE_PRECISIONS: ReadonlySet<string> = new Set(["day", "month", "year"]);

export function isDated(time: { precision: string } | undefined): boolean {
  return time !== undefined && DATE_PRECISIONS.has(time.precision);
}

export function textFamilies(families: readonly Family[]): Family[] {
  return families.filter((family) => family.text !== undefined);
}

export function searchInputs(families: readonly Family[]): Inputs {
  return textFamilies(families).flatMap((family) => {
    const { kinds, follows } = family.text!;
    const read = family.inputs.map((input) => ({ sources: input.sources, kinds: input.kinds.filter((kind) => kinds.includes(kind)) })).filter((input) => input.kinds.length > 0);
    return [...read, ...(follows ?? []).map((follow) => ({ sources: follow.sources, kinds: [...follow.kinds] }))];
  });
}

export function textsOf(sources: readonly SourceRow[], families: readonly Family[]): Texts {
  const kinds = [...new Set(families.flatMap((family) => family.text!.kinds))].sort();
  const owners: Record<string, string> = {};
  const ids = sources.map((source) => source.id).sort();
  const rows = new Map(sources.map((source) => [source.id, source]));
  for (const id of ids) {
    for (const kind of kinds) {
      const family = textFamilyOf(families, rows.get(id)!, kind);
      if (family === undefined) continue;
      const folder = family.adapters?.find((given) => given.product === rows.get(id)!.product && kindsRead(given.adapter).includes(kind))?.digest;
      owners[`${id}\0${kind}`] = `${family.name}/${family.text!.version}${folder === undefined ? "" : `/${folder}`}`;
    }
  }
  return { sources: ids, owners };
}

export interface SearchData {
  cursor: Omit<SearchChunk, "statement">;
}

type SearchChunk = IndexPosition;

export interface SearchResult {
  statements: number;
  reread: number;
  put: number;
  removed: number;
  refused: number;
  days: number;
  more: boolean;
  held: boolean;
  refusal?: string;
  read_ms: number;
  write_ms: number;
  commit_ms: number;
}

type SearchEnv = Pick<HelperEnv, "folder" | "machine" | "registry" | "db" | "blobs"> & { day: DaySettings };

async function* searchRun(env: SearchEnv, data: SearchData): AsyncGenerator<SearchChunk, SearchResult, undefined> {
  const result: SearchResult = { statements: 0, reread: 0, put: 0, removed: 0, refused: 0, days: 0, more: false, held: false, read_ms: 0, write_ms: 0, commit_ms: 0 };
  const began = performance.now();
  const late = () => performance.now() - began >= RUN_MS;
  const look = env.db.view();
  let sources: SourceRow[];
  let index: SearchIndex;
  try {
    sources = look.sources();
    const rereads = look.newestReread();
    const fits = (at: IndexPosition, building: boolean): boolean => {
      if (at.reread > rereads) return false;
      if (at.seq === 0) return true;
      if (!building && data.cursor.seq === 0) return false;
      const stated = look.statementAt(at.seq);
      return stated !== undefined && statementName(stated) === at.statement;
    };
    index = SearchIndex.write(env.folder, searchFileOf(env.folder.root, env.machine), fits, rereads, env.day);
  } finally {
    look.close();
  }
  try {
    let publish = false;
    const families = textFamilies(env.registry.families);
    index.follow(textsOf(sources, families));
    const view = env.db.view();
    try {
      const entries = entryReader(env, view, families, result);
      for (const told of records(view, index, families, entries, data.cursor, result, late)) {
        failpoint("search.indexed");
        yield told;
      }
    } finally {
      view.close();
    }
    publish = !result.more && index.building;
    let unlisted = false;
    if (!result.more) {
      const read = days(env.folder, index, result, began, RUN_DAYS, (records) => {
        result.reread += records.length;
        const now = env.db.view();
        try {
          const fresh = entryReader(env, now, families, result);
          return records.flatMap((record) => {
            const head = now.head(record);
            const entry = head === undefined || head.version === GONE ? null : fresh.entry(record, head, now.version(head.version));
            return entry === null ? [] : [entry];
          });
        } finally {
          now.close();
        }
      });
      if (read === "unreadable") unlisted = true;
      else result.more = read;
    }
    if (!result.more) {
      const again = env.db.view();
      try {
        result.more = readAgain(again, index, entryReader(env, again, families, result), result, late);
      } finally {
        again.close();
      }
    }
    if (!result.more) result.held = unlisted || index.factsOwed(1).length > 0;
    const publishing = performance.now();
    if (publish) index.finish();
    const spent = index.spent();
    result.write_ms = Math.round(spent.write_ms);
    result.commit_ms = Math.round(spent.commit_ms + performance.now() - publishing);
    result.read_ms = Math.max(0, Math.round(performance.now() - began) - result.write_ms - result.commit_ms);
    return result;
  } finally {
    index.close();
  }
}

interface EntryReader {
  familyOf(source: string, kind: string): Family | undefined;
  entry(record: RecordRef, head: Head, version: Version): RecordEntry | null;
  moved(statements: readonly Statement[]): RecordRef[];
}

function entryReader(env: SearchEnv, view: OpenView, families: readonly Family[], result: SearchResult): EntryReader {
  const rows = new Map(view.sources().map((row) => [row.id, row]));
  const chosen = new Map<string, Family | undefined>();
  const familyOf = (source: string, kind: string): Family | undefined => {
    const name = `${source}\0${kind}`;
    if (!chosen.has(name)) {
      const row = rows.get(source);
      chosen.set(name, row === undefined ? undefined : textFamilyOf(families, row, kind));
    }
    return chosen.get(name);
  };
  return {
    familyOf,
    entry(record, head, version) {
      const family = familyOf(record.source, record.kind);
      if (family === undefined) return null;
      let text;
      try {
        text = family.text!.of(record, version, env.blobs, view);
      } catch (error) {
        if (homeFault(error)) throw error;
        result.refused++;
        result.refusal ??= `${record.source} ${record.kind} ${record.key}: ${errorText(error)}`;
        return null;
      }
      if (text === null) return null;
      return {
        record, family: family.name, version: version.id, start_ms: head.start_ms, end_ms: head.end_ms,
        title: text.title ?? "", text: text.text, who: text.who ?? [], link: text.link ?? null,
        ...(isDated(version.time) ? { dated: true } : {}),
      };
    },
    moved(statements) {
      const version = (id: string | undefined): Version | undefined => id === undefined || id === GONE ? undefined : view.version(id);
      return families.flatMap((family) => family.text!.follows ?? []).flatMap((follow) => {
        const changes: Change[] = [];
        for (const statement of statements) {
          const row = rows.get(statement.source);
          if (row === undefined || !follow.kinds.includes(statement.kind) || !selects(follow.sources, row)) continue;
          const record = { source: statement.source, kind: statement.kind, key: statement.key };
          const before = version(view.history(record).filter((each) => each.seq < statement.seq).at(-1)?.version);
          const after = version(statement.version);
          changes.push({ record, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) });
        }
        return changes.length === 0 ? [] : follow.moved(changes, view);
      });
    },
  };
}

function* records(
  view: OpenView, index: SearchIndex, families: readonly Family[], entries: EntryReader, cursor: SearchData["cursor"], result: SearchResult, late: () => boolean,
): Generator<SearchChunk> {
  const all = view.sources();
  const reads = readerOf(searchInputs(families), all);
  const sources = all.map((source) => source.id).filter((id) => reads(id));
  const kinds = [...new Set(searchInputs(families).flatMap((input) => input.kinds))];
  let at = index.position()!;
  if (at.seq !== cursor.seq || at.reread !== cursor.reread) yield index.told()!;
  let untold = false;
  const statements = view.statements(at.seq, { sources, kinds })[Symbol.iterator]();
  for (;;) {
    const named = new Map<string, RecordRef>();
    const again = new Set<string>();
    const nameOf = (record: RecordRef) => `${record.source}\0${record.kind}\0${record.key}`;
    const note = (record: RecordRef) => named.set(nameOf(record), record);
    const stated = new Map<string, string | null>();
    let count = 0;
    let last: Statement | undefined;
    const slice: Statement[] = [];
    while (count < CHUNK_STATEMENTS) {
      const next = statements.next();
      if (next.done === true) break;
      const statement: Statement = next.value;
      count++;
      last = statement;
      slice.push(statement);
      if (entries.familyOf(statement.source, statement.kind) === undefined) continue;
      note(statement);
      const name = nameOf(statement);
      stated.set(name, stated.has(name) && stated.get(name) !== statement.version ? null : statement.version);
    }
    for (const record of entries.moved(slice)) {
      note(record);
      again.add(nameOf(record));
    }
    const rereads = view.rereads(at.reread, CHUNK_STATEMENTS);
    for (const each of rereads) {
      if ("family" in each || entries.familyOf(each.record.source, each.record.kind) === undefined) continue;
      note(each.record);
      stated.set(nameOf(each.record), null);
    }
    const full = count >= CHUNK_STATEMENTS;
    const through = full ? last : view.statementAt(view.through);
    const position: IndexPosition = {
      seq: full ? last!.seq : view.through, statement: through === undefined ? null : statementName(through), reread: rereads.at(-1)?.seq ?? at.reread,
    };
    if (named.size === 0 && position.seq === at.seq && position.reread === at.reread) {
      if (untold) yield index.told()!;
      return;
    }
    const indexed = index.versions([...named.values()]);
    const puts: RecordEntry[] = [];
    const removes: RecordRef[] = [];
    for (const [name, record] of named) {
      if (!again.has(name) && stated.get(name) != null && indexed.get(name) === stated.get(name)) continue;
      const head = view.head(record);
      if (head !== undefined && head.version !== GONE && !again.has(name) && indexed.get(name) === head.version) continue;
      const entry = head === undefined || head.version === GONE ? null : entries.entry(record, head, view.version(head.version));
      if (entry !== null) puts.push(entry);
      else if (indexed.has(name)) removes.push(record);
    }
    const final = !full && rereads.length < CHUNK_STATEMENTS;
    const ending = final || result.statements + count >= RUN_STATEMENTS || late();
    index.records(puts, removes, { position }, ending);
    result.statements += count;
    result.put += puts.length;
    result.removed += removes.length;
    at = position;
    untold = !ending;
    if (!ending) continue;
    yield position;
    result.more = !final;
    return;
  }
}

function readAgain(view: OpenView, index: SearchIndex, entries: EntryReader, result: SearchResult, late: () => boolean): boolean {
  for (const rereading of index.rereading()) {
    let after = rereading.after;
    for (;;) {
      if (late()) return true;
      const puts: RecordEntry[] = [];
      const removes: RecordRef[] = [];
      let last = after;
      for (const head of view.heads(rereading.source, rereading.kind, undefined, { key: after, start_ms: null })) {
        const record = { source: head.source, kind: head.kind, key: head.key };
        const entry = entries.entry(record, head, view.version(head.version));
        if (entry === null) removes.push(record);
        else puts.push(entry);
        last = head.key;
        if (puts.length + removes.length >= CHUNK_STATEMENTS) break;
      }
      const done = puts.length + removes.length < CHUNK_STATEMENTS;
      const indexed = index.versions(removes);
      const removed = removes.filter((record) => indexed.has(`${record.source}\0${record.kind}\0${record.key}`));
      index.records(puts, removed, { rereading: { ...rereading, after }, after: done ? null : last });
      result.reread += puts.length + removes.length;
      result.put += puts.length;
      result.removed += removed.length;
      if (done) break;
      after = last;
    }
  }
  return false;
}

export function days(folder: HomeFolder, index: SearchIndex, result: Pick<SearchResult, "days">, began: number, most = RUN_DAYS, reread?: (records: readonly RecordRef[]) => readonly RecordEntry[]): boolean | "unreadable" {
  let names: string[];
  try {
    names = folder.names(join(folder.root, "days"));
  } catch {
    return "unreadable";
  }
  const indexed = index.days();
  const files = new Map<string, number>();
  for (const name of names) {
    const day = /^(\d{4}-\d{2}-\d{2})\.day\.json$/u.exec(name)?.[1];
    if (day === undefined) continue;
    let modified_ms: number | undefined;
    try {
      modified_ms = dayFile(folder, day, "json").stat()?.modified_ms;
    } catch {
      return "unreadable";
    }
    if (modified_ms !== undefined) files.set(day, Math.round(modified_ms * 1000));
  }
  for (const [day, held] of indexed) if (!files.has(day) && held.inputs !== "") index.day(day, null);
  const moved = [...files].filter(([day, mtime_us]) => indexed.get(day)?.mtime_us !== mtime_us).sort(([a], [b]) => (a < b ? 1 : -1));
  let read = 0;
  const unread = new Map<string, number>();
  try {
    for (const [day, mtime_us] of moved) {
      if (read >= most || performance.now() - began >= RUN_MS) return true;
      const head = readDayHead(folder, day);
      if (head === null) {
        if (indexed.get(day)?.inputs !== "") index.day(day, null);
        continue;
      }
      if (head.renderer !== RENDERER_VERSION) {
        unread.set(day, mtime_us);
        continue;
      }
      const indexedDay = readDay(folder, day, head.inputs, mtime_us);
      if (indexedDay === null) continue;
      if (indexed.get(day)?.inputs === head.inputs) {
        index.touchDay(day, indexedDay);
        continue;
      }
      if (!index.day(day, indexedDay, reread)) continue;
      read++;
      result.days++;
    }
    const owed = index.factsOwed();
    const now = owed.length === 0 ? indexed : index.days();
    for (const day of owed) {
      if (read >= most || performance.now() - began >= RUN_MS) return true;
      const held = now.get(day);
      if (held === undefined || held.inputs === "") continue;
      const indexedDay = readDay(folder, day, held.inputs, held.mtime_us);
      if (indexedDay === null || !index.factsDay(day, indexedDay)) continue;
      read++;
      result.days++;
    }
    while (index.statesOwed()) {
      if (read >= most || performance.now() - began >= RUN_MS) return true;
      if (!index.fillStates()) break;
      read++;
    }
    return false;
  } finally {
    if (unread.size > 0) index.unread(unread);
  }
}

export function readDay(folder: HomeFolder, day: string, inputs: string, mtime_us: number): IndexedDay | null {
  const kept = dayFile(folder, day, "json");
  let file: Pick<DayDocument, "window" | "facts" | "renderer"> & { atoms?: unknown[] };
  try {
    const bytes = kept.read();
    if (bytes === undefined) return null;
    file = JSON.parse(bytes.toString("utf8")) as typeof file;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (file.renderer !== RENDERER_VERSION) return null;
  const still = () => {
    try {
      const modified_ms = kept.stat()?.modified_ms;
      return modified_ms !== undefined && Math.round(modified_ms * 1000) === mtime_us;
    } catch {
      return false;
    }
  };
  return { inputs, mtime_us, atoms: atomsOf(file), facts: { window: file.window, facts: file.facts ?? [] }, still };
}

export function atomsOf(file: { atoms?: unknown[]; facts?: readonly DayFileFact[] | undefined }): AtomEntry[] {
  const senders = new Map<number, Set<string>>();
  for (const fact of file.facts ?? []) {
    for (const { handle, role } of fact.who) {
      if (role !== "sender") continue;
      for (const n of fact.lines) senders.set(n, (senders.get(n) ?? new Set()).add(handle));
    }
  }
  return (file.atoms ?? []).map((raw) => {
    const atom = raw as {
      n: number; family: string; unit: string; item?: string; record?: RecordRef; start_ms: number | null; end_ms: number | null;
      text: string; names?: NameSpan[]; block?: { title: string; names?: NameSpan[] }; flags?: string[]; chat?: string; pictures?: number; accounts?: string[];
    };
    return {
      n: atom.n, family: atom.family, unit: atom.unit, start_ms: atom.start_ms, end_ms: atom.end_ms, text: atom.text,
      ...(atom.names === undefined ? {} : { names: atom.names }),
      ...(atom.item === undefined ? {} : { item: atom.item }),
      ...(atom.record === undefined ? {} : { record: atom.record }),
      ...(atom.flags?.includes("date_only") === true ? { dated: true } : {}),
      ...(atom.chat === undefined ? {} : { chat: atom.chat }),
      ...(atom.pictures === undefined ? {} : { pictures: atom.pictures }),
      ...(atom.block === undefined ? {} : { title: atom.block.title, ...(atom.block.names === undefined ? {} : { title_names: atom.block.names }) }),
      ...(senders.has(atom.n) ? { sender: [...senders.get(atom.n)!].sort() } : {}),
      ...(atom.accounts === undefined ? {} : { accounts: atom.accounts }),
    };
  });
}

export function recordBuilding(folder: HomeFolder, file: string, of: number): { done: number; of: number } | null {
  return existsSync(buildingFileOf(file)) ? { done: SearchIndex.progress(folder, file).read, of } : null;
}

export const RECORD_INDEX: Index<SearchResult> = {
  name: "search",
  fileOf: searchFileOf,
  take: (env, from) => searchRun({ folder: env.folder, machine: env.machine, registry: env.registry, db: env.db, blobs: env.blobs, day: env.settings.day }, { cursor: from }),
  settled(result) {
    const { more, held, refusal, ...counts } = result;
    const worked = counts.statements > 0 || counts.days > 0 || counts.reread > 0;
    return { more, again_in_ms: !more && held ? HELD_WAIT_MS : null, again_at_ms: null, counts: worked ? { ...counts, ...(refusal === undefined ? {} : { refusal }) } : null };
  },
  unmarked: (folder, machine) => searchQueue(folder, searchFileOf(folder.root, machine)),
  state(folder, file, of) {
    let index: SearchIndex | undefined;
    try {
      index = SearchIndex.read(folder, file);
      const seq = index?.position()?.seq ?? 0;
      return { seq, behind: Math.max(0, of - seq), building: recordBuilding(folder, file, of), bytes: index === undefined ? 0 : fileBytes(file) + fileBytes(`${file}-wal`) };
    } catch {
      return null;
    } finally {
      index?.close();
    }
  },
  build: (tx, now_ms) => tx.tables.cursors.reset("search", null, now_ms),
  forget(on, records, days) {
    const indexes = SearchIndex.existing(on.folder, searchFileOf(on.folder.root, on.machine));
    try {
      on.forgetMarks([...new Set(indexes.flatMap((index) => index.textsOf(records, days)))]);
      for (const index of indexes) index.forget(records, days);
      for (const index of indexes) if (!index.truncateLog(on.wait_ms)) on.kept.push(basename(index.file));
    } finally {
      for (const index of indexes) index.close();
    }
  },
};

function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
