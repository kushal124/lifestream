import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect } from "vitest";
import { canonical, importSubject, openHome, openHomeFolder, parse, versionId, type BlobStore, type Delivery, type HomeDb, type Instant, type Json, type JsonObject, type Landed, type ReaderOutput } from "@lifestreamprotocol/core";
import { declarations } from "../index.js";
import { productsOf } from "../products.js";
import type { Acquirer, Reader, Secrets } from "../seams.js";
import type { Fixture, FixtureDelivery, Spoiled } from "../sdk.js";
import { fileSha256 } from "../shared/chunks.js";
import { instantMs, rfc3339 } from "../shared/delivery.js";
import { LENT, pollCall, type KeptPoll } from "../shared/poll-run.js";
import { BYTES_LIMIT, openZip } from "../shared/zip.js";

function vendorIn(source: string): string {
  const product = source.slice(0, source.indexOf(":"));
  return productsOf(declarations()).products[product]?.vendor ?? product;
}

export const MiB = 1024 * 1024;
export const CONNECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARED = join(CONNECT_ROOT, "shared");
const KEEP = process.env.LIFESTREAM_KEEP_ARTIFACTS === "1";

const temps: string[] = [];
const open: { close(): void }[] = [];
let emptyDbTemplate: string | undefined;
function emptyDbPath(): string {
  if (emptyDbTemplate !== undefined && existsSync(emptyDbTemplate)) return emptyDbTemplate;
  const dir = mkdtempSync(join(tmpdir(), "connect-template-"));
  openHome(openHomeFolder(dir), "migrate").close();
  emptyDbTemplate = join(dir, "home.db");
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  return emptyDbTemplate;
}
afterEach(() => {
  for (const db of open.splice(0)) db.close();
  for (const dir of temps.splice(0)) {
    if (KEEP) process.stdout.write(`kept ${dir}\n`);
    else rmSync(dir, { recursive: true, force: true });
  }
});

export function temp(prefix = "connect-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

export function artifact(dir: string, name: string, value: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, (_, item: unknown) => (typeof item === "bigint" ? item.toString() : item), 2)}\n`);
  return path;
}

export async function collect<T>(rows: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const row of rows) out.push(row);
  return out;
}

export async function readStoring(connector: Reader, delivery: Delivery, blobs: BlobStore): Promise<ReaderOutput[]> {
  const out: ReaderOutput[] = [];
  for await (const row of connector.read(delivery, blobs)) {
    for (const each of row.streamed ?? []) {
      const mediaType = row.media?.[each.hash];
      await blobs.putChunks(each.chunks, each.size, { expect: each.hash, ...(mediaType === undefined ? {} : { mediaType }) });
    }
    out.push(row);
  }
  return out;
}


export interface Head {
  kind: string;
  key: string;
  version: string;
  gone: boolean;
  stated_ms: number;
  start_ms: number | null;
  end_ms: number | null;
  content: Json | null;
  time: Instant | null;
}

export interface TestHome {
  readonly dir: string;
  readonly db: HomeDb;
  readonly blobs: BlobStore;
  land(connector: Reader, delivery: Delivery, rows?: Iterable<ReaderOutput>): Promise<Landed>;
  heads(source: string, kinds?: readonly string[]): Head[];
  readThrough(source: string): number | null;
  close(): void;
}

export function openTestHome(prefix = "connect-"): TestHome {
  const dir = temp(prefix);
  copyFileSync(emptyDbPath(), join(dir, "home.db"), constants.COPYFILE_FICLONE);
  const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
  const db = openHome(openHomeFolder(dir), "write");
  let raw: Database.Database | undefined;
  const closer = {
    close() {
      raw?.close();
      raw = undefined;
      db.close();
    },
  };
  open.push(closer);
  const known = new Set<string>();
  const read = <T>(work: (view: ReturnType<HomeDb["view"]>) => T): T => {
    const view = db.view();
    try {
      return work(view);
    } finally {
      view.close();
    }
  };
  return {
    dir,
    db,
    blobs,
    async land(connector, delivery, rows) {
      const list = rows ?? (await collect(connector.read(delivery, blobs)));
      return db.commit((tx) => {
        if (!known.has(delivery.source)) {
          known.add(delivery.source);
          if (tx.tables.sources.get(delivery.source) === undefined) tx.tables.sources.add({ id: delivery.source, vendor: vendorIn(delivery.source), connector: connector.name, added_ms: delivery.sealed_ms });
        }
        const run = tx.tables.runs.start({ kind: "import", subject: importSubject(delivery.source, delivery.id), started_ms: delivery.stated_ms });
        const landed = tx.records.land(run, delivery, list, connector.kinds, blobs);
        tx.tables.sources.advance(delivery.source, delivery.stated_ms);
        tx.tables.runs.end(run, { ended_ms: delivery.stated_ms, outcome: "ok", counts: counts(landed) });
        return landed;
      });
    },
    heads(source, kinds) {
      raw ??= new Database(join(dir, "home.db"), { readonly: true });
      const filter = kinds === undefined ? "" : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
      const rows = raw.prepare(`SELECT kind, key, version, stated_ms, start_ms, end_ms FROM heads WHERE source = ?${filter} ORDER BY kind, key`)
        .all(source, ...(kinds ?? [])) as { kind: string; key: string; version: string; stated_ms: number; start_ms: number | null; end_ms: number | null }[];
      return read((view) => rows.map((row) => {
        const version = row.version === "gone" ? undefined : view.version(row.version);
        return { ...row, gone: row.version === "gone", content: version?.content ?? null, time: version?.time ?? null };
      }));
    },
    readThrough: (source) => read((view) => view.tables.sources.get(source)?.read_through_ms ?? null),
    close() {
      closer.close();
      const at = open.indexOf(closer);
      if (at >= 0) open.splice(at, 1);
    },
  };
}

export function counts(landed: Landed): JsonObject {
  const { refusals, changedPaths, refusedMembers, ...rest } = landed;
  const members = refusedMembers === undefined ? {} : { refusedMembers: Object.fromEntries(refusedMembers) };
  return { ...rest, ...members, changedPaths, refusals: refusals.map((refusal) => ({ ...refusal })) } as unknown as JsonObject;
}

const MEDIA: Record<string, string> = {
  json: "application/json", txt: "text/plain", md: "text/markdown", jsonl: "application/x-ndjson", db: "application/vnd.sqlite3",
  sqlite: "application/vnd.sqlite3", eml: "text/plain", ics: "text/calendar", vcf: "text/vcard", xml: "text/xml", csv: "text/csv",
};

let sealed = 0;

export function deliver(home: TestHome | BlobStore, source: string, files: Record<string, Buffer | string>, facts: JsonObject = {}, stated_ms?: number): Delivery {
  const blobs = "put" in home ? home : home.blobs;
  const statedByFacts = statedAt(facts);
  const stated = stated_ms ?? statedByFacts ?? fail(`deliver(${source}): the facts state no time and no stated_ms was given`);
  const stated_facts = statedByFacts === undefined ? { fetched_at: rfc3339(stated), ...facts } : facts;
  const list = Object.entries(files).map(([path, bytes]) => {
    if (typeof bytes === "string") return { path, ...adopt(blobs, bytes) };
    const mediaType = MEDIA[path.slice(path.lastIndexOf(".") + 1).toLowerCase()];
    return { path, blob: blobs.put(bytes, mediaType === undefined ? {} : { mediaType }), size: bytes.length };
  });
  return { id: `${source}/${++sealed}`, source, sealed_ms: stated, stated_ms: stated, facts: stated_facts, files: list };
}

export function macBundle(home: TestHome, source: string, zip: URL): Delivery {
  const bundle = openZip(fileURLToPath(zip));
  try {
    const files: Record<string, Buffer> = {};
    let facts: JsonObject = {};
    for (const entry of bundle.entries()) {
      if (entry.name === "manifest.json") facts = (JSON.parse(entry.bytes().toString("utf8")) as { facts: JsonObject }).facts;
      else if (entry.name.startsWith("blobs/")) home.blobs.put(entry.bytes());
      else files[entry.name] = entry.bytes();
    }
    return deliver(home, source, files, facts);
  } finally {
    bundle.close();
  }
}

function statedAt(facts: JsonObject): number | undefined {
  for (const name of ["snapshot_taken_at", "exported_at", "created_at", "fetched_at"]) {
    const value = facts[name];
    if (typeof value === "string") return instantMs(value);
  }
  return undefined;
}


export interface PollRecord extends KeptPoll {
  deliveries: Delivery[];
}

export async function poll(home: TestHome, acquirer: Acquirer, record: PollRecord, secrets: Secrets, _now_ms: number, call: "fetch" | "page" = "fetch", start_ms: number | null = null): Promise<Delivery | undefined> {
  return await pollCall(acquirer, record, secrets, call, ({ files, facts, source }) => {
    const inbox = join(home.dir, "inbox", String(record.deliveries.length + 1));
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(dirname(join(inbox, path)), { recursive: true });
      writeFileSync(join(inbox, path), bytes);
    }
    const delivery = deliver(home, source, files, facts);
    record.deliveries.push(delivery);
    return delivery;
  }, { ...LENT, start_ms });
}

export { fetchedBytes, LENT, lending, memorySecrets, NO_MEMORY } from "../shared/poll-run.js";


export interface GoldenRow {
  kind: string;
  key: string;
  content: Json;
  time: Instant | null;
  locator?: string;
}

export interface Parity {
  kind: string;
  key: string;
  id: string;
  content: Json;
  time: Instant | null;
}

export function readGolden(url: URL | string): GoldenRow[] {
  return parse(readFileSync(url, "utf8")) as unknown as GoldenRow[];
}

export function goldenSets(url: URL | string): Record<string, GoldenRow[]> {
  const sets = parse(readFileSync(url, "utf8")) as unknown as { name: string; rows: GoldenRow[] }[];
  return Object.fromEntries(sets.map((set) => [set.name, set.rows]));
}

export function parityOf(rows: Iterable<{ kind: string; key: string; content: Json; time?: Instant | null }>): Parity[] {
  return sortParity([...rows].map((row) => ({ kind: row.kind, key: row.key, id: versionId(row.kind, row.key, row.content).id, content: row.content, time: row.time ?? null })));
}

export function expectParity(rows: Iterable<ReaderOutput>, golden: URL | string | readonly GoldenRow[]): Parity[] {
  const expected = parityOf(golden instanceof URL || typeof golden === "string" ? readGolden(golden) : golden);
  const actual = parityOf(rows);
  expect(actual.map((record) => `${record.kind}\0${record.key}`)).toEqual(expected.map((record) => `${record.kind}\0${record.key}`));
  for (const [index, record] of actual.entries()) {
    const wanted = expected[index]!;
    expect(canonical(record.content), `${record.kind} ${record.key} content`).toBe(canonical(wanted.content));
    expect(record.time, `${record.kind} ${record.key} time`).toEqual(wanted.time);
  }
  return actual;
}

function sortParity(records: Parity[]): Parity[] {
  return records.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function fail(message: string): never {
  throw new Error(message);
}


export const HEAP_MiB = 32;

const READ_MiB = HEAP_MiB / 2;

export function boundedRead<T extends object>(script: string, options: { cwd?: string } = {}): T & { heap: { imports_mib: number; cap_mib: number } } {
  const cwd = options.cwd ?? CONNECT_ROOT;
  const imports = join(dirname(script), `imports-${basename(script)}`);
  writeFileSync(imports, `globalThis.gc(); process.getBuiltinModule("node:fs").writeSync(1, String(process.memoryUsage().heapUsed)); process.exit(0);\n${readFileSync(script, "utf8")}`);
  const loaded = spawnSync(process.execPath, ["--expose-gc", "--single-threaded-gc", "--no-incremental-marking", "--import", "tsx", imports], { cwd, encoding: "utf8" });
  expect(loaded.status, `the read's imports did not load (${loaded.status ?? `signal ${loaded.signal}`}): ${loaded.stderr}`).toBe(0);
  const held = Number(loaded.stdout.trim().split(/\s+/u).at(-1));
  expect(Number.isFinite(held), `the read's imports reported no heap: ${loaded.stdout}`).toBe(true);
  const imports_mib = Math.ceil(held / MiB);
  const cap_mib = imports_mib + READ_MiB;
  const result = spawnSync(process.execPath, [`--max-old-space-size=${cap_mib}`, "--no-detect-ineffective-gcs-near-heap-limit", "--single-threaded-gc", "--no-incremental-marking", "--import", "tsx", script], { cwd, encoding: "utf8" });
  expect(result.status, `the read held more than ${READ_MiB} MiB past its imports' ${imports_mib} MiB (${result.status ?? `signal ${result.signal}`}): ${result.stderr}`).toBe(0);
  return Object.assign(JSON.parse(result.stdout.trim().split("\n").at(-1)!) as T, { heap: { imports_mib, cap_mib } });
}

export function adopt(blobs: BlobStore, path: string): { blob: string; size: number } {
  const hex = fileSha256(path);
  const size = statSync(path).size;
  const stored = join(blobs.root, hex.slice(0, 2), hex.slice(2, 4), hex);
  mkdirSync(dirname(stored), { recursive: true });
  renameSync(path, stored);
  chmodSync(stored, 0o444);
  return { blob: `sha256:${hex}`, size };
}

export { wholeReads } from "@lifestreamprotocol/core/test/whole-reads";


export function damageOverflow(path: string, table: string): void {
  const db = new Database(path);
  const size = db.pragma("page_size", { simple: true }) as number;
  const pages = db.prepare("SELECT pageno FROM dbstat WHERE name = ? AND pagetype = 'overflow'").all(table) as { pageno: number }[];
  db.close();
  if (pages.length === 0) throw new Error(`${table} runs onto no overflow page`);
  const fd = openSync(path, "r+");
  try {
    for (const { pageno } of pages) writeSync(fd, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, (pageno - 1) * size);
  } finally {
    closeSync(fd);
  }
}

export function* exportLines(bytes: number, chunk = 4 * MiB): Generator<Buffer> {
  let line = 0;
  for (let written = 0; written < bytes; ) {
    const parts: string[] = [];
    let size = 0;
    while (size < Math.min(chunk, bytes - written)) {
      const text = `{"type":"HKQuantityTypeIdentifierHeartRate","value":${60 + (line % 50)},"date":"2026-09-${String(1 + (line % 28)).padStart(2, "0")}","n":${line}}\n`;
      parts.push(text);
      size += text.length;
      line++;
    }
    const buffer = Buffer.from(parts.join(""), "utf8").subarray(0, Math.min(chunk, bytes - written));
    written += buffer.length;
    yield buffer;
  }
}

export function childScript(dir: string, body: string, name = "child.mts"): string {
  const path = join(dir, name);
  const here = pathToFileURL(SHARED).href;
  writeFileSync(path, body.replaceAll(`from "./`, `from "${here}/`).replaceAll(`import("./`, `import("${here}/`));
  return path;
}

export function pastWholeRead(): { size: number; chunks: () => Generator<Buffer>; hash: string } {
  const size = BYTES_LIMIT + 1;
  const block = Buffer.alloc(MiB, 7);
  function* chunks(): Generator<Buffer> {
    for (let left = size; left > 0; left -= MiB) yield left >= MiB ? block : block.subarray(0, left);
  }
  const digest = createHash("sha256");
  for (const chunk of chunks()) digest.update(chunk);
  return { size, chunks, hash: `sha256:${digest.digest("hex")}` };
}

export type { Fixture, FixtureDelivery, Spoiled };
export { writeZip, type FixtureMember } from "./zip.js";
