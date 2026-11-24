import { createHash } from "node:crypto";
import { constants, copyFileSync, createReadStream, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { vendorOf, type Connector, type Entry } from "@lifestreamprotocol/connect";
import { HOME_STORE, openHome, scratchFolder, type Adapter, type BlobStore, type Head, type HomeDb, type HomeFolder, type InputRecord, type JobRow, type JsonObject, type OpenView, type Tx } from "@lifestreamprotocol/core";
import { absentMembers, accountFaults, LABELS_FAMILY, renderDay, statedFaults, textFamilyOf, type DayDocument, type Family, type LabelUnits, type RenderedDay } from "@lifestreamprotocol/families";
import { copyOf } from "./catalog.js";
import { extractCursor, extractKind } from "./derive.js";
import { declaredOf, releaseAdmitted } from "./folders.js";
import { importKind, indexKind, indexNudged } from "./import.js";
import { filesAt, sealImport } from "./import-file.js";
import { answerImport, heldImports, importIdOf, importSources, type HeldImport } from "./imports.js";
import { basicInstant, inboxLane, openSealing, type SealDisk } from "./inbox.js";
import { errorText, LANE, type HelperEnv, type Main, type Running, type Slice } from "./jobs.js";
import { chatOpen, recordOpen } from "./open-in.js";
import { families, feedersOf } from "./registry-home.js";
import { readerOf as familyReaderOf, type Loaded } from "./registry.js";
import type { Settings } from "./settings.js";

export interface Delivered {
  readonly source: string;
  readonly lane?: string;
  readonly facts: JsonObject;
  readonly files: Readonly<Record<string, unknown>>;
  readonly heads?: unknown;
}

export interface Skipped {
  readonly heads: ReadonlySet<string>;
  readonly held: Map<string, Set<string>>;
  readonly read: Set<string>;
}

export function skippedOf(given: unknown): { skipped: Skipped; faults: string[] } {
  const heads = new Set<string>();
  const faults: string[] = [];
  if (given !== undefined && !Array.isArray(given)) faults.push("test/fixture.ts: its skipped is no list: export `skipped` as the heads its adapters read as nothing on purpose, each `<kind> <key>`");
  for (const head of Array.isArray(given) ? given as unknown[] : []) {
    if (typeof head === "string" && /^\S+ \S/u.test(head)) heads.add(head);
    else faults.push(`test/fixture.ts: its skipped holds ${JSON.stringify(head)}, no head: each is \`<kind> <key>\`, as \`test\`'s search lines name a record`);
  }
  return { skipped: { heads, held: new Map(), read: new Set() }, faults };
}

export function unheld(skipped: Skipped): string[] {
  const faults = [...skipped.heads].filter((head) => !skipped.held.has(head)).map((head) => `test/fixture.ts: its skipped names ${head}, which nothing the run landed holds`);
  const wholly = new Map<string, { connector: string; kind: string; keys: string[] }>();
  for (const [head, connectors] of skipped.held) {
    const [kind, key] = [head.slice(0, head.indexOf(" ")), head.slice(head.indexOf(" ") + 1)];
    for (const connector of connectors) {
      const own = `${connector} ${kind}`;
      if (!skipped.read.has(own)) wholly.set(own, { connector, kind, keys: [...(wholly.get(own)?.keys ?? []), key] });
    }
  }
  for (const { connector, kind, keys } of wholly.values()) {
    const named = `${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}`;
    faults.push(`test/fixture.ts: its skipped names every ${kind} record of ${connector} the run landed (${named}), so none reached its family: skipped names the records an adapter leaves out on purpose, never a whole kind; land a ${kind} record its adapter reads, in a fixture or a fake`);
  }
  return faults;
}

export type Fixture = (folder: string) => Delivered;

export interface Landing {
  readonly folder: HomeFolder;
  readonly db: HomeDb;
  readonly read: HomeDb;
  readonly blobs: BlobStore;
  readonly registry: Loaded;
  readonly settings: Settings;
}

export interface Landed {
  readonly delivery: string;
  readonly run: number | null;
}

export type Landable = Buffer | { readonly file: string };

const CARRIED = "blobs";
const SCRATCH_DISK: SealDisk = { platform: "darwin", flush: () => undefined };

export function written(folder: string): Record<string, Buffer> {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
  const files = readdirSync(folder).filter((name) => name !== CARRIED).flatMap((name) => (statSync(join(folder, name)).isDirectory() ? walk(join(folder, name)) : [join(folder, name)]));
  return Object.fromEntries(files.map((path) => [relative(folder, path), readFileSync(path)]));
}

export async function landDelivery(home: Landing, reader: string, delivery: Delivered, folder: string, files: Readonly<Record<string, Landable>>, at_ms = Date.now()): Promise<Landed> {
  const { registry } = home;
  const { source, lane = source, facts } = delivery;
  const fetched_at = new Date(at_ms).toISOString();
  const name = basicInstant(fetched_at);
  const sealing = openSealing(home.folder, { source: lane, name, feeder: "conformance", fetched_at }, SCRATCH_DISK);
  const carried = join(folder, CARRIED);
  for (const hex of existsSync(carried) ? readdirSync(carried) : []) {
    const bytes = readFileSync(join(carried, hex));
    if (!await inboxLane(home.folder, lane).store(hex, (async function* () { yield bytes; })(), bytes.length)) throw new Error(`${folder}: a carried blob ${hex} is not its bytes' hash`);
  }
  for (const [path, given] of Object.entries(files)) {
    if (Buffer.isBuffer(given)) sealing.put(path, given);
    else await sealing.adopt(path, given.file, await measured(given.file));
  }
  sealing.seal(facts);
  return {
    delivery: `${lane}/${name}`,
    run: await importSource(home, source, (tx, main) => {
      if (tx.tables.sources.get(source) === undefined) {
        tx.tables.sources.add({ id: source, vendor: vendorOf(registry.connectors, source), connector: reader, options: lane === source ? {} : { lane }, added_ms: Date.now() });
      }
      indexNudged(main, tx, `${lane}/${name}`);
    }),
  };
}

export async function landImport(home: Landing, kind: string, path: string, at_ms = Date.now(), options: { account?: string; adopt?: boolean } = {}): Promise<LandedImport> {
  const { account, adopt = false } = options;
  const id = await sealImport(home.folder, home.registry, kind, filesAt(path, adopt), at_ms, SCRATCH_DISK);
  await lookHere(home);
  const readMeta = () => home.db.commit((tx) => {
    const of = importIdOf(tx.tables.meta, id);
    return {
      held: of === null ? null : { id: of, ...heldImports(tx.tables.meta)[of]! },
      sources: importSources(tx.tables.meta, id),
    };
  });
  let state = readMeta();
  if (account !== undefined && state.held !== null && state.held.account === null && state.held.ended !== true) {
    home.db.commit((tx) => answerImport(tx, state.held!.id, account));
    await lookHere(home);
    state = readMeta();
  }
  const runs: Record<string, number | null> = {};
  for (const source of state.sources) runs[source] = await importSource(home, source);
  return { delivery: id, import: state.held, runs };
}

export interface LandedImport {
  readonly delivery: string;
  readonly import: (HeldImport & { readonly id: string }) | null;
  readonly runs: Readonly<Record<string, number | null>>;
}

function parts(home: Landing): { main: Main; env: HelperEnv } {
  const { folder, read, blobs, registry, settings } = home;
  const main = { folder, settings, registry, blobs, ending: 0, now: () => Date.now(), log: () => undefined } as unknown as Main;
  const env = {
    folder, settings, registry, db: read, blobs, signal: new AbortController().signal,
    committed: async () => undefined, reading: () => undefined,
  } as unknown as HelperEnv;
  return { main, env };
}

async function lookHere(home: Landing): Promise<void> {
  const { db } = home;
  const { main, env } = parts(home);
  for (;;) {
    const now = Date.now();
    const { job, begun } = db.commit((tx) => {
      tx.tables.jobs.enqueue({ kind: "index-inbox", key: "inbox", lane: LANE.polls, not_before_ms: now, now_ms: now });
      const job = tx.tables.jobs.take(now, undefined, [...new Set(tx.tables.jobs.open().filter((each) => each.kind !== "index-inbox").map((each) => `${each.kind}:${each.key}`)), "kind:import", "kind:poll"])!;
      return { job, begun: indexKind.begin!(main, tx, job)! };
    });
    const running: Running<typeof begun.state> = { job, state: begun.state };
    let queued = false;
    try {
      const slices: Slice[] = [];
      const steps = indexKind.helper(env, { job: job.id, kind: "index-inbox", key: "inbox", lane: job.lane, now_ms: now, data: begun.data });
      let next = await steps.next();
      for (; next.done !== true; next = await steps.next()) slices.push(...indexKind.chunk!(main, running, next.value));
      queued = db.commit((tx) => {
        for (const slice of slices) slice.work(tx);
        indexKind.done(main, tx, running, next.value);
        tx.tables.jobs.finish(job.id, Date.now());
        return tx.tables.jobs.get("index-inbox", "inbox")?.state === "queued";
      });
    } catch (error) {
      db.commit((tx) => tx.tables.jobs.finish(job.id, Date.now()));
      throw error;
    }
    if (!queued) return;
  }
}

async function importSource(home: Landing, source: string, before?: (tx: Tx, main: Main) => void): Promise<number | null> {
  const { db } = home;
  const { main, env } = parts(home);
  const now = Date.now();
  const started = db.commit((tx) => {
    before?.(tx, main);
    tx.tables.jobs.enqueue({ kind: "import", key: source, lane: LANE.live, not_before_ms: now, now_ms: now });
    const job = tx.tables.jobs.take(now, undefined, [...new Set(tx.tables.jobs.open().filter((each) => each.kind !== "import" || each.key !== source).map((each) => `${each.kind}:${each.key}`)), "kind:index-inbox", "kind:poll"])!;
    const begun = importKind.begin!(main, tx, job);
    if (begun === null) {
      tx.tables.jobs.finish(job.id, Date.now());
      return null;
    }
    return { job, begun };
  });
  if (started === null) return null;
  const { job, begun } = started;
  const running: Running<typeof begun.state> = { job, state: begun.state };
  try {
    const slices: Slice[] = [];
    const steps = importKind.helper(env, { job: job.id, kind: "import", key: source, lane: job.lane, now_ms: now, data: begun.data });
    let next = await steps.next();
    for (; next.done !== true; next = await steps.next()) slices.push(...importKind.chunk!(main, running, next.value));
    db.commit((tx) => {
      for (const slice of slices) slice.work(tx);
      importKind.done(main, tx, running, next.value);
      tx.tables.jobs.finish(job.id, Date.now());
    });
  } catch (error) {
    db.commit((tx) => {
      importKind.failed!(main, tx, job, running.state, errorText(error));
      tx.tables.jobs.finish(job.id, Date.now());
    });
  }
  return running.state.run;
}

async function measured(file: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    digest.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: digest.digest("hex"), bytes };
}

function releaseBeside(folder: Pick<Entry, "connectors">): ReturnType<typeof releaseAdmitted>["entries"] {
  const own = new Set(folder.connectors.map((connector) => connector.id));
  return releaseAdmitted().entries.filter((each) => !each.entry.connectors.some((connector) => own.has(connector.id)));
}

export function familiesWith(settings: Settings, root: string, folder: Pick<Entry, "connectors" | "adapters"> & { readonly digest?: string }): Family[] {
  return families(settings, root, [
    ...releaseBeside(folder).map((each) => ({ connectors: each.entry.connectors, ...(each.entry.adapters === undefined ? {} : { adapters: each.entry.adapters }) })),
    { connectors: folder.connectors, ...(folder.adapters === undefined ? {} : { adapters: folder.adapters }), ...(folder.digest === undefined ? {} : { digest: folder.digest }) },
  ]);
}

export function landingRegistry(work: string, folder: Entry & { readonly digest?: string }, settings: Settings): Loaded {
  const release = releaseBeside(folder);
  const connectors = declaredOf([...release.map((each) => each.entry), folder]);
  const read = new Set<string>();
  const stated: StatedBySource = new Map();
  const adapters = watched(folder.adapters, read, stated);
  const own = { ...folder, ...(adapters === undefined ? {} : { adapters }) };
  const registry: Loaded = {
    connectors, readers: [...release.flatMap((each) => each.entry.readers), ...folder.readers], families: familiesWith(settings, work, own), feeders: feedersOf(connectors),
    adapters: Object.assign({}, ...release.map((each) => each.entry.adapters ?? {}), adapters ?? {}), code: "conformance",
  };
  readBy.set(registry, read);
  statedBy.set(registry, stated);
  return registry;
}

const readBy = new WeakMap<Loaded, ReadonlySet<string>>();
type StatedBySource = Map<string, Map<string, Set<string>>>;
const statedBy = new WeakMap<Loaded, StatedBySource>();
const STATED_SHOWN = 5;
const SOURCELESS = "";

function statedOf(registry: Loaded, sources: ReadonlySet<string>): string[] {
  const held = statedBy.get(registry);
  if (held === undefined) return [];
  const members = new Map<string, Set<string>>();
  for (const source of [SOURCELESS, ...sources]) {
    for (const [member, each] of held.get(source) ?? []) members.set(member, new Set([...members.get(member) ?? [], ...each]));
  }
  return [...members].flatMap(([member, each]) => [
    ...[...each].slice(0, STATED_SHOWN).map((fault) => `${member}: ${fault}`),
    ...(each.size > STATED_SHOWN ? [`${member}: ${each.size - STATED_SHOWN} more values like these break its family's rules`] : []),
  ]);
}

function sourceOf(args: readonly unknown[]): string {
  const isSource = (arg: unknown): arg is { id: string } => {
    const source = arg as { id?: unknown; product?: unknown; account?: unknown } | null | undefined;
    return typeof source?.id === "string" && typeof source.product === "string" && typeof source.account === "string";
  };
  const given = args.find((arg) => isRecord(arg) || isSource(arg));
  return isRecord(given) ? given.source.id : isSource(given) ? given.id : SOURCELESS;
}

function isRecord(given: unknown): given is InputRecord {
  const record = given as { source?: { id?: unknown }; version?: { id?: unknown; key?: unknown } } | null | undefined;
  return typeof record?.source?.id === "string" && typeof record.version?.key === "string";
}

function noteStated(stated: StatedBySource, at: string, family: string, member: string, adapter: object, args: readonly unknown[], out: unknown): void {
  if (out === null || out === undefined) return;
  const record = isRecord(args[0]) ? args[0] : null;
  let faults: string[];
  try {
    faults = statedFaults(family, { adapter: adapter as Adapter, member, record, value: out });
  } catch (error) {
    faults = [`states a value its family's rules cannot read: ${errorText(error).split("\n")[0]}`];
  }
  if (faults.length === 0) return;
  const named = `${at}.${member}`;
  const of = sourceOf(args);
  const source = stated.get(of) ?? new Map<string, Set<string>>();
  const held = source.get(named) ?? new Set<string>();
  for (const fault of faults) held.add(record === null ? fault : `${record.version.kind} ${record.version.key}: ${fault}`);
  source.set(named, held);
  stated.set(of, source);
}

const readKey = (source: string, version: string) => `${source}\0${version}`;

function watched(adapters: Entry["adapters"], read: Set<string>, stated: StatedBySource): Entry["adapters"] {
  if (adapters === undefined) return undefined;
  const watch = (adapter: object, id: string, family: string): object => {
    const copy = Object.create(Object.getPrototypeOf(adapter) as object | null) as object;
    const wrapped = (fn: (...args: unknown[]) => unknown, member: string) => function (...args: unknown[]): unknown {
      const out = fn.apply(adapter, args);
      noteStated(stated, `adapters.${id}.${family}`, family, member, adapter, args, out);
      const record = args[0] as { source?: { id?: unknown }; version?: { id?: unknown } } | undefined;
      if (out !== null && out !== undefined && typeof record?.source?.id === "string" && typeof record.version?.id === "string") read.add(readKey(record.source.id, record.version.id));
      return out;
    };
    for (const key of Reflect.ownKeys(adapter)) {
      const described = Object.getOwnPropertyDescriptor(adapter, key)!;
      const own = "get" in described || "set" in described
        ? { ...described, ...(described.get === undefined ? {} : { get: described.get.bind(adapter) }), ...(described.set === undefined ? {} : { set: described.set.bind(adapter) }) }
        : typeof described.value === "function" ? { ...described, value: wrapped(described.value as (...args: unknown[]) => unknown, String(key)) } : described;
      Object.defineProperty(copy, key, own);
    }
    for (const [member, read] of Object.entries(absentMembers(family))) {
      if (Reflect.get(adapter, member) !== undefined) continue;
      Object.defineProperty(copy, member, {
        value: (input: never): unknown => {
          const out = read(input);
          noteStated(stated, `adapters.${id}.${family}`, family, member, adapter, [input], out);
          return out;
        },
        configurable: true, writable: true,
      });
    }
    for (let proto = Object.getPrototypeOf(adapter) as object | null; proto !== null && proto !== Object.prototype; proto = Object.getPrototypeOf(proto) as object | null) {
      for (const key of Reflect.ownKeys(proto)) {
        const value = Reflect.get(adapter, key) as unknown;
        if (key !== "constructor" && !Object.hasOwn(copy, key) && typeof value === "function") Object.defineProperty(copy, key, { value: wrapped(value as (...args: unknown[]) => unknown, String(key)), configurable: true, writable: true });
      }
    }
    return copy;
  };
  return Object.fromEntries(Object.entries(adapters).map(([id, given]) => [id, Object.fromEntries(Object.entries(given).map(([family, adapter]) => [family, typeof adapter === "object" && adapter !== null ? watch(adapter, id, family) : adapter]))]));
}

let emptyHomeTemplate: string | undefined;

function emptyHomeDb(): string {
  if (emptyHomeTemplate !== undefined && existsSync(emptyHomeTemplate)) return emptyHomeTemplate;
  const dir = mkdtempSync(join(tmpdir(), "lifestream-landing-template-"));
  openHome(scratchFolder(dir), "migrate").close();
  emptyHomeTemplate = join(dir, "home.db");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return emptyHomeTemplate;
}

interface PooledHome {
  readonly root: string;
  readonly folder: HomeFolder;
  readonly db: HomeDb;
  readonly read: HomeDb;
  readonly resetter: ReturnType<HomeFolder["store"]>;
  readonly deleteSql: string;
  readonly insertMeta: { run(key: string, value: string): unknown };
  readonly initialMeta: readonly { key: string; value: string }[];
}

const HOME_POOL: PooledHome[] = [];
const HOME_POOL_MAX = 3;

function destroyPooledHome(pooled: PooledHome): void {
  try { pooled.resetter.close(); } catch {}
  try { pooled.read.close(); } catch {}
  try { pooled.db.close(); } catch {}
  rmSync(pooled.root, { recursive: true, force: true });
}

function resetPooledHome(pooled: PooledHome): void {
  const { resetter, deleteSql, insertMeta, initialMeta, root } = pooled;
  resetter.pragma("foreign_keys = OFF");
  resetter.exec("BEGIN IMMEDIATE");
  try {
    resetter.exec(deleteSql);
    for (const row of initialMeta) insertMeta.run(row.key, row.value);
    resetter.exec("COMMIT");
  } catch (error) {
    if (resetter.inTransaction) resetter.exec("ROLLBACK");
    throw error;
  } finally {
    resetter.pragma("foreign_keys = ON");
  }
  for (const name of readdirSync(root)) {
    if (name !== "home.db" && name !== "home.db-wal" && name !== "home.db-shm") rmSync(join(root, name), { recursive: true, force: true });
  }
}

function openPooledHome(): PooledHome {
  while (HOME_POOL.length > 0) {
    const existing = HOME_POOL.pop()!;
    try {
      resetPooledHome(existing);
      return existing;
    } catch {
      destroyPooledHome(existing);
    }
  }
  const root = mkdtempSync(join(tmpdir(), "lifestream-pooled-home-"));
  copyFileSync(emptyHomeDb(), join(root, "home.db"), constants.COPYFILE_FICLONE);
  const folder = scratchFolder(root);
  const db = openHome(folder, "write");
  const read = openHome(folder, "read");
  const resetter = folder.store(HOME_STORE, join(root, "home.db"));
  const tables = resetter.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'").pluck().all() as string[];
  const hasSequence = resetter.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'").pluck().get() !== undefined;
  const deleteSql = [...tables.map((table) => `DELETE FROM "${table}";`), ...(hasSequence ? ["DELETE FROM sqlite_sequence;"] : []), "DELETE FROM meta;"].join("\n");
  const insertMeta = resetter.prepare("INSERT INTO meta (key, value) VALUES (?, ?)");
  const initialMeta = resetter.prepare("SELECT key, value FROM meta").all() as { key: string; value: string }[];
  const pooled: PooledHome = { root, folder, db, read, resetter, deleteSql, insertMeta, initialMeta };
  process.once("exit", () => destroyPooledHome(pooled));
  return pooled;
}

export function checkoutLanding(registry: Loaded, settings: Settings): { home: Landing; release(): void } {
  const pooled = openPooledHome();
  let released = false;
  return {
    home: { folder: pooled.folder, db: pooled.db, read: pooled.read, blobs: pooled.folder.blobs(join(pooled.root, "blobs")), registry, settings },
    release() {
      if (released) return;
      released = true;
      if (HOME_POOL.length < HOME_POOL_MAX) HOME_POOL.push(pooled);
      else destroyPooledHome(pooled);
    },
  };
}

export function scratchLanding(root: string, folder: Entry & { readonly digest?: string }, settings: Settings, registry = landingRegistry(root, folder, settings)): Landing {
  const target = join(root, "home.db");
  const copied = !existsSync(target);
  if (copied) copyFileSync(emptyHomeDb(), target, constants.COPYFILE_FICLONE);
  const home = scratchFolder(root);
  const db = openHome(home, copied ? "write" : "migrate");
  const read = openHome(home, "read");
  return { folder: home, db, read, blobs: home.blobs(join(root, "blobs")), registry, settings };
}

export function labelsOf(view: OpenView): LabelUnits {
  return (unit) => {
    const row = view.extract(LABELS_FAMILY, unit);
    return row === undefined ? undefined : { reading: row.reading, code: row.code, content: row.content };
  };
}

export interface FixtureDay {
  readonly faults: string[];
  readonly stated: string[];
  readonly lines: string[];
}

export async function fixtureDay(options: {
  readonly work: string;
  readonly folder: Entry & { readonly digest?: string };
  readonly fixtures: Readonly<Record<string, Fixture>>;
  readonly settings: Settings;
  readonly skipped?: Skipped;
}): Promise<FixtureDay> {
  const { folder, settings } = options;
  const faults: string[] = [];
  const checked = checkoutLanding(landingRegistry(options.work, folder, settings), settings);
  const { home } = checked;
  const { read } = home;
  try {
    const sources = new Map<string, string>();
    let at_ms = Date.now();
    for (const reader of folder.readers) {
      const fixture = options.fixtures[reader.name];
      if (fixture === undefined) continue;
      const dir = mkdtempSync(join(options.work, "fixture-"));
      const stated = fixture(dir);
      await landDelivery(home, reader.name, stated, dir, written(dir), at_ms += 1_000);
      sources.set(stated.source, reader.name);
    }
    const view = read.view();
    try {
      const landed = new Set(recordsOf(view, folder, sources).map((head) => head.source));
      for (const [source, reader] of sources) if (!landed.has(source)) faults.push(`fixtures.${reader}: its delivery lands nothing`);
    } finally {
      view.close();
    }
    const inspected = await inspectLanding(home, folder, sources, options.skipped === undefined ? {} : { skipped: options.skipped });
    return { faults: [...faults, ...inspected.faults], stated: inspected.stated, lines: inspected.lines };
  } finally {
    checked.release();
  }
}

function recordsOf(view: OpenView, folder: Entry, sources: ReadonlyMap<string, string>) {
  const kindsOf = (reader: string) => Object.keys(folder.readers.find((each) => each.name === reader)?.kinds ?? {});
  return [...sources].flatMap(([source, reader]) => kindsOf(reader).flatMap((kind) => [...view.heads(source, kind)].filter((head) => head.version !== "gone")));
}

export interface Inspected extends FixtureDay {
  readonly records: number;
  readonly days: number;
}

export async function inspectLanding(
  home: Landing, folder: Entry, sources: ReadonlyMap<string, string>, options: { readonly lines?: boolean; readonly skipped?: Skipped } = {},
): Promise<Inspected> {
  const skipped = options.skipped;
  const { db, read, blobs, registry, settings } = home;
  const built = registry.families;
  const adapted = readBy.get(registry) ?? new Set<string>();
  const faults: string[] = [];
  const lines: string[] = [];
  const say = (...each: string[]) => {
    if (options.lines !== false) lines.push(...each);
  };
  const landed = (() => {
    const view = read.view();
    try {
      return recordsOf(view, folder, sources);
    } finally {
      view.close();
    }
  })();
  const kinds = [...new Set(landed.map((head) => head.kind))].sort();
  if (Object.keys(folder.adapters ?? {}).length === 0 && kinds.length > 0) {
    faults.push(`adapters: none, and it lands ${kinds.join(", ")}: no day prints them and no search finds them; give each kind its family's adapter, or a plain line`);
  }

  await extractAll(home);
  const { aside, days } = db.commit((tx) => ({
    aside: tx.derived.extracts.aside.list(),
    days: tx.derived.extracts.days().sort(),
  }));
  for (const row of aside) faults.push(`${adapterOf(folder, row.family)}: threw on its unit ${row.unit}: ${row.error.split("\n")[0]}`);

  const view = read.view();
  try {
    const labels = labelsOf(view);
    const ours = new Set(sources.keys());
    const roleUnits = unitsByRole(built, folder, registry.connectors, view, landed);
    const throughUnits = new Set([...roleUnits.values()].flat());
    const shownUnits = new Set<string>();
    const printed = new Set<string>();
    const lined = new Map<string, string[]>();
    let printing = 0;
    for (const day of days) {
      let rendered: RenderedDay;
      try {
        rendered = renderDay(day, built, view, settings.day, labels);
      } catch (error) {
        faults.push(`days.${day}: does not render: ${errorText(error).split("\n")[0]}`);
        continue;
      }
      const doc = JSON.parse(rendered.json) as DayDocument;
      const shownLines = JSON.parse(rendered.lines) as number[][];
      const shown = new Set(shownLines.flat());
      faults.push(...accountFaults(doc).map((fault) => `days.${fault}`));
      const its = dayLinesOf(day, doc, shownLines, rendered.txt, ours, throughUnits);
      if (its.length > 0) printing++;
      say(...its);
      for (const atom of doc.atoms) {
        const visible = shown.has(atom.n);
        if (visible) {
          for (const unit of atom.units) shownUnits.add(familyUnit(atom.family, unit));
        }
        if (atom.record === undefined || !ours.has(atom.record.source)) continue;
        const key = recordKey(atom.record);
        if (visible) printed.add(key);
        const text = [atom.block?.title, atom.text].filter((each) => each !== undefined && each !== "").join(" · ");
        if (text !== "") {
          const held = lined.get(key) ?? [];
          if (!held.includes(text)) held.push(text);
          lined.set(key, held);
        }
      }
    }
    if (printing === 0) say("(no line on any day)");
    const chats = new Set<string>();
    const opensNowhere = new Set<string>();
    const unread = new Map<string, { kind: string; keys: string[] }>();
    for (const head of landed) {
      const row = view.source(head.source)!;
      const family = textFamilyOf(built, row, head.kind);
      const version = view.version(head.version)!;
      let words: string | null = null;
      let threw = false;
      try {
        const text = family?.text?.of(head, version, blobs, view) ?? null;
        words = text === null ? null : [text.title, text.text, ...(text.who ?? []), text.link].filter((each) => each !== undefined && each !== "").join(" · ");
      } catch (error) {
        threw = true;
        faults.push(`${adapterOf(folder, family?.name ?? "line")}: its search text of ${head.kind} ${head.key} throws: ${errorText(error).split("\n")[0]}`);
      }
      const key = recordKey(head);
      const own = words !== null && words !== "";
      const found = own ? words! : (lined.get(key) ?? []).join(" · ");
      const reached = found !== "" || printed.has(key) || adapted.has(readKey(head.source, head.version)) || (roleUnits.get(key) ?? []).some((unit) => shownUnits.has(unit));
      const nothing = !threw && !reached;
      const connector = registry.connectors.find((each) => each.product === row.product && folder.connectors.some((own) => own.id === each.id));
      const owner = connector?.id ?? row.product;
      const skip = skipped?.heads.has(`${head.kind} ${head.key}`) === true;
      if (reached) skipped?.read.add(`${owner} ${head.kind}`);
      if (skip) {
        const held = skipped!.held.get(`${head.kind} ${head.key}`) ?? new Set<string>();
        skipped!.held.set(`${head.kind} ${head.key}`, held.add(owner));
        if (!nothing) faults.push(`test/fixture.ts: its skipped names ${head.kind} ${head.key}, and its adapter reads it: ${printed.has(key) ? "a day prints it" : found !== "" ? "search finds it" : "it reads it into its family"}`);
      }
      const counted = connector !== undefined && connector.counted_by === undefined && (connector.counts ?? [head.kind]).includes(head.kind)
        && adaptersOf(folder, connector.id, head.kind).includes(`adapters.${connector.id}.web`);
      const skippedWords = `(read as nothing, as test/fixture.ts's skipped says${counted ? "; its stream counts these too: see `counted_by`" : ""})`;
      say(`search ${head.kind} ${head.key}: ${found === "" ? (skip && nothing ? skippedWords : "(no words)") : `${found.replace(/\s+/gu, " ").slice(0, 120)}${own ? "" : " (its day line's words)"}`}`);
      if (nothing && !skip) {
        for (const member of adaptersOf(folder, connector?.id, head.kind)) {
          const held = unread.get(member) ?? { kind: head.kind, keys: [] };
          held.keys.push(head.key);
          unread.set(member, held);
        }
      }
      const open = recordOpen(connector, head.kind, { account: row.account, key: head.key, content: version.content });
      const messages = connector === undefined ? undefined : folder.adapters?.[connector.id]?.messages;
      if (open !== null) say(`open ${head.kind} ${head.key}: ${open.label} ${open.href}`);
      else if (connector !== undefined && !(connector.open?.chat !== undefined && messages?.kinds.includes(head.kind) === true)
        && !opensNowhere.has(`${connector.id} ${head.kind}`)) {
        opensNowhere.add(`${connector.id} ${head.kind}`);
        say(connector.open?.record?.kinds.includes(head.kind) === true
          ? `open ${head.kind}: none for ${head.key}: its connector's open.record template takes a part this record has no value for (an {account} its source names none of, a {content.<path>} its content states no text or number at, a |hex of no decimal), or the address it fills is no https, imessage: or sms: address, or names a user or a password`
          : `open ${head.kind}: none: ${connector.id} declares no open.record naming ${head.kind}, so no record of it opens at ${connector.name}; its page from the record's key, account and content is connector.ts \`open: { record: { kinds: ["${head.kind}"], url: "https://…/{key}" } }\`, {content.<path>} a value its content states (alone, the whole address), a part cut by |before:<c>, |after:<c> or |hex`);
      }
      if (messages !== undefined && connector?.open?.chat !== undefined && messages.kinds.includes(head.kind)) {
        try {
          const chat = messages.message({ source: row, version })?.chat;
          if (chat !== undefined && !chats.has(chat)) {
            chats.add(chat);
            const opened = chatOpen(connector, chat, messages.group(chat));
            if (opened !== null) say(`open chat ${chat}: ${opened.label} ${opened.href}`);
          }
        } catch {
        }
      }
    }
    for (const [member, { kind, keys }] of unread) {
      const named = `${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}`;
      faults.push(`${member}: reads ${keys.length} ${kind} record${keys.length === 1 ? "" : "s"} as nothing (${named}): no day prints ${keys.length === 1 ? "it" : "them"} and no search finds ${keys.length === 1 ? "it" : "them"} (one its adapter leaves out on purpose, test/fixture.ts names in \`export const skipped = ["<kind> <key>"]\`)`);
    }
    const stated = statedOf(registry, ours);
    return { faults: [...faults, ...stated], stated, lines, records: landed.length, days: printing };
  } finally {
    view.close();
  }
}

export function readerOf(connector: Connector, source: string): string {
  return (connector.sources.find((each) => copyOf(each.id, source)) ?? connector.sources[0]!).read;
}

const recordKey = (record: { readonly source: string; readonly kind: string; readonly key: string }) => `${record.source}\0${record.kind}\0${record.key}`;

const familyUnit = (family: string, unit: string) => `${family}\0${unit}`;

function unitsByRole(families: readonly Family[], folder: Entry, connectors: readonly Connector[], view: OpenView, landed: readonly Head[]): Map<string, string[]> {
  const units = new Map<string, string[]>();
  for (const head of landed) {
    const row = view.source(head.source);
    const connector = connectors.find((each) => each.product === row?.product && folder.connectors.some((own) => own.id === each.id));
    const version = view.version(head.version);
    if (connector === undefined || version === undefined) continue;
    for (const [name, adapter] of Object.entries(folder.adapters?.[connector.id] ?? {})) {
      const { role, kinds } = adapter as { role?: unknown; kinds?: unknown };
      const family = families.find((each) => each.name === name);
      if (typeof role !== "string" || !Array.isArray(kinds) || !kinds.includes(head.kind) || family === undefined) continue;
      const touched = family.touched([{ record: { source: head.source, kind: head.kind, key: head.key }, after: version }], view);
      units.set(recordKey(head), [...units.get(recordKey(head)) ?? [], ...touched.map((each) => familyUnit(name, each.unit))]);
    }
  }
  return units;
}

function adaptersOf(folder: Entry, connector: string | undefined, kind: string): string[] {
  if (connector === undefined) return [];
  return Object.entries(folder.adapters?.[connector] ?? {}).flatMap(([family, adapter]) => {
    const kinds = (adapter as { kinds?: unknown } | undefined)?.kinds;
    return Array.isArray(kinds) && kinds.includes(kind) ? [`adapters.${connector}.${family}`] : [];
  });
}

function dayLinesOf(day: string, doc: DayDocument, printed: readonly number[][], txt: string, sources: ReadonlySet<string>, units: ReadonlySet<string>): string[] {
  const ours = new Set(doc.atoms.filter((atom) => (atom.record !== undefined && sources.has(atom.record.source)) || atom.units.some((unit) => units.has(familyUnit(atom.family, unit)))).map((atom) => atom.n));
  return txt.split("\n").flatMap((text, index) => ((printed[index] ?? []).some((n) => ours.has(n)) ? [`${day} ${text}`] : []));
}

export function dayLines(day: string, rendered: Pick<RenderedDay, "json" | "txt" | "lines">, sources: ReadonlySet<string>, units: ReadonlySet<string> = new Set()): string[] {
  return dayLinesOf(day, JSON.parse(rendered.json) as DayDocument, JSON.parse(rendered.lines) as number[][], rendered.txt, sources, units);
}

function adapterOf(folder: Entry, family: string): string {
  const name = family === "plain" ? "line" : family;
  const id = Object.entries(folder.adapters ?? {}).find(([, given]) => Object.hasOwn(given, name))?.[0];
  return id === undefined ? `families.${family}` : `adapters.${id}.${name}`;
}

async function extractAll(home: Landing): Promise<void> {
  const { folder, db, read, blobs, registry, settings } = home;
  const main = { folder, settings, registry, blobs, families: new Map(registry.families.map((family) => [family.name, family])), now: () => Date.now(), log: () => undefined } as unknown as Main;
  const env = { folder, settings, registry, db: read, blobs, signal: new AbortController().signal, committed: async () => undefined, reading: () => undefined } as unknown as HelperEnv;
  const { active, idle, through } = (() => {
    const view = read.view();
    try {
      const all = view.sources();
      const hasRereads = view.rereads(0, 1).length > 0;
      const active: Family[] = [];
      const idle: Family[] = [];
      for (const family of registry.families) {
        const reads = familyReaderOf(family.inputs, all);
        if (hasRereads || all.some((source) => reads(source.id))) active.push(family);
        else idle.push(family);
      }
      return { active, idle, through: view.through };
    } finally {
      view.close();
    }
  })();
  const initNow = Date.now();
  db.commit((tx) => {
    for (const family of idle) {
      const cur = tx.tables.cursors.get(extractCursor(family.name));
      if (cur === undefined || cur.seq < through) tx.tables.cursors.move(extractCursor(family.name), { seq: through, at_ms: initNow });
    }
    for (const family of active) {
      if (tx.tables.cursors.get(extractCursor(family.name)) === undefined) tx.tables.cursors.move(extractCursor(family.name), { seq: 0, at_ms: 0 });
    }
  });
  let id = 0;
  for (const family of active) {
    for (let more = true; more;) {
      const now = Date.now();
      const job = { id: ++id, kind: "extract", key: family.name, lane: LANE.backfill, not_before_ms: now, started_ms: now } as unknown as JobRow;
      const begun = db.commit((tx) => extractKind.begin!(main, tx, job));
      if (begun === null) break;
      const running: Running<typeof begun.state> = { job, state: begun.state };
      const slices: Slice[] = [];
      const steps = extractKind.helper(env, { job: job.id, kind: "extract", key: family.name, lane: job.lane, now_ms: Date.now(), data: begun.data });
      let next = await steps.next();
      for (; next.done !== true; next = await steps.next()) slices.push(...extractKind.chunk!(main, running, next.value));
      const result = next.value;
      db.commit((tx) => {
        for (const slice of slices) slice.work(tx);
        extractKind.done(main, tx, running, result);
      });
      more = result.more;
    }
  }
}
