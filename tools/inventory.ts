import { closeSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { HEADER_BYTES, layoutOf, nameKey, SEGMENT, VECTOR_SEGMENT } from "../packages/core/sealed.js";

export type Tree = "folder" | "machine" | "spool";
export type FileClass = "keyed-store" | "sealed" | "mac-encrypted" | "plain" | "scratch" | "unclassified";
export type FlagKind = "canary" | "sqlite-header" | "hash-named-blob" | "unclassified";

export interface Row {
  readonly tree: Tree;
  readonly pattern: RegExp;
  readonly reason: string;
}

export interface Listed {
  readonly tree: Tree;
  readonly path: string;
  readonly bytes: number;
  readonly class: FileClass;
  readonly why: string;
  readonly canaries: readonly string[];
}

export interface Flag {
  readonly kind: FlagKind;
  readonly tree: Tree;
  readonly path: string;
  readonly detail: string;
}

export interface Inventory {
  readonly folder: string;
  readonly machine: string;
  readonly spool: string | null;
  readonly counts: Readonly<Record<FileClass, number>>;
  readonly scratch: readonly string[];
  readonly flags: readonly Flag[];
  readonly files: readonly Listed[];
}

export interface InventoryInput {
  readonly folder: string;
  readonly machine: string;
  readonly spool?: string;
  readonly canaries?: readonly string[];
  readonly blobs?: readonly string[];
}

export const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "latin1");

const LOCK_FILES = /^(home\.lock|stop\.lock|replies\/calls\.lock|door\/streams\.lock)(-journal)?$/u;
const MACHINE_LOCK = /^release\.lock(-journal)?$/u;
const STORE_MEMORY = /^ship\/ledger\/[^/]+\/[^/]+\/memory-[^/]+(-journal|-wal|-shm)?$/u;
const PHOTO_ENTRIES = /^ship\/photos\/[0-9a-f]{64}\/entries\.sqlite(-journal|-wal|-shm)?$/u;
const MAC_KEYED_NAME = /^ship\/photos\/[0-9a-f]{64}\/blobs\/[0-9a-f]{64}$/u;
const MAC_OWN = (tree: Tree, path: string) => tree === "spool" || (tree === "machine" && path.startsWith("ship/"));
const LOG_MARK = 0x80;
const LOG_HEADER = 33;
const LOG_LENGTH = 4;
const LOG_SEAL = 12 + 16;
const LOG_RECORD = 16 * 1024 * 1024 + LOG_SEAL;

export const ALLOWED_PLAIN: readonly Row[] = [
  { tree: "folder", pattern: /^(HOME|RETIRED)\.json$/u, reason: "security 3.8: says what the folder is" },
  { tree: "folder", pattern: LOCK_FILES, reason: "security 3.8: a lock file is an empty SQLite file" },
  { tree: "folder", pattern: /^config\/(vault|reseal)\.json$/u, reason: "security 3.8: wrapped keys, and a move's progress" },
  { tree: "folder", pattern: /^config\/door-tls\.pem$/u, reason: "security 3.8: the Wi-Fi certificate and its TLS key, a named gap" },
  { tree: "folder", pattern: /^config\/door-notice\.pem$/u, reason: "security 3.8: the notice key only says the home is locked" },
  { tree: "folder", pattern: /^config\/settings\.json$/u, reason: "security 3.8: the day, the unit and the door's address, read before any key is held; every other setting is sealed" },
  { tree: "folder", pattern: /^logs\//u, reason: "security 3.8: routes, ids and faults with bounded reasons, never content" },
  { tree: "folder", pattern: /^config\/stores\.json$/u, reason: "the stores' schema versions and the vault key's id, which a release's check reads with no key" },
  { tree: "folder", pattern: /^connectors\/[^/]+\//u, reason: "the code of home connectors, which holds no record" },
  { tree: "folder", pattern: /^connectors\/README\.md$/u, reason: "the home's guide to its connectors, fixed text and paths" },
  { tree: "machine", pattern: /^(codex|claude)\//u, reason: "security 3.8: each maker's program owns its sign-in, named now and sealed later" },
  { tree: "machine", pattern: /^run\//u, reason: "security 3.8: the sockets and the dashboard's start key, live only while the jobs run" },
  { tree: "machine", pattern: /^vaults\/[^/]+\.json$/u, reason: "wrapped keys, the vault's copy on the Mac" },
  { tree: "machine", pattern: /^(machine\.json|home-id|home)$/u, reason: "this Mac's program overrides, the pointed home's id and its folder's path, read before any key is held" },
  { tree: "machine", pattern: /^[a-z-]+\/door-token$/u, reason: "a program's own pass to the door (the dashboard's, the MCP server's, the call agent's), no record" },
  { tree: "machine", pattern: /^mcp\/public\.json$/u, reason: "the MCP server's public address" },
  { tree: "machine", pattern: /^revoked\//u, reason: "pass ids only" },
  { tree: "machine", pattern: /^(models|runner)\//u, reason: "downloaded model files and the runner's state" },
  { tree: "machine", pattern: /^generations\//u, reason: "copies of home connectors' code and which process runs them" },
  { tree: "folder", pattern: /^connectors\/\.loading\.json$/u, reason: "which home connector is loading, by name and stamp" },
  { tree: "folder", pattern: /^connectors\/\.installed\.json$/u, reason: "each installed home connector's name, source path and ids: code metadata, no record" },
  { tree: "machine", pattern: /^extension\//u, reason: "the unpacked Chrome extension a release places, code like releases/" },
  { tree: "machine", pattern: /^mac-files\.json$/u, reason: "the Mac's form and its key's id, read before any key is held" },
  { tree: "spool", pattern: /^\.writer\.lock$/u, reason: "an empty lock file" },
  { tree: "spool", pattern: /^runtime\.json$/u, reason: "the recorder's state, counts, times and a gap's reason code; read by the watcher and live-status" },
  { tree: "spool", pattern: /^resources\/(watch|recorder|diagnostics)-\d{4}-\d{2}-\d{2}\.jsonl$/u, reason: "CPU, energy, counts and fault codes per minute" },
  { tree: "machine", pattern: STORE_MEMORY, reason: "a store memory: table names, integer row numbers, keyed fingerprints, sizes, seal numbers, keyed hashes, keyed meta values" },
  { tree: "machine", pattern: PHOTO_ENTRIES, reason: "the photo entries: a SQLite file whose values are encrypted one by one, its keys keyed names, its kinds and order plain" },
  { tree: "machine", pattern: /^command\.json$/u, reason: "the lifestream command's link and the shell lines it wrote" },
  { tree: "machine", pattern: MACHINE_LOCK, reason: "a release's lock file, an empty SQLite file" },
];

export const STORE_ROLES: readonly Row[] = [
  { tree: "folder", pattern: /^home\.db$/u, reason: "the record" },
  { tree: "folder", pattern: /^replies\/replies\.db$/u, reason: "the model ledger" },
  { tree: "folder", pattern: /^door\/(stated|custody)\.db$/u, reason: "the door's caches" },
  { tree: "machine", pattern: /^search\/[^/]+\/(index|screen|screen\.building)\.db$/u, reason: "the search and screen indexes" },
  { tree: "machine", pattern: /^privacy\/[^/]+\/marks\.db$/u, reason: "hiding's marks" },
  { tree: "machine", pattern: /^(places|people)\/[^/]+\/(places|people|memo)\.db$/u, reason: "the prepared places and people" },
  { tree: "machine", pattern: /^faces\/[^/]+\/memo\.db$/u, reason: "the faces memo" },
];

const STORE_LOGS = /-(wal|shm|journal)$/u;
const SEALED_TREE = /^(replies\/)?blobs\/k[1-9][0-9]*\//u;
const HEX_NAME = /^(sha256[:-])?[0-9a-f]{64}$/u;
const CHUNK = 1024 * 1024;

function walk(top: string, at: string, out: { path: string; kind: "file" | "other"; bytes: number }[]): void {
  let names: string[];
  try {
    names = readdirSync(at);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names.sort()) {
    const full = join(at, name);
    const stat = lstatSync(full);
    if (stat.isDirectory()) walk(top, full, out);
    else out.push({ path: relative(top, full).split(sep).join("/"), kind: stat.isFile() ? "file" : "other", bytes: stat.size });
  }
}

function scan(file: string, canaries: readonly Buffer[]): { head: Buffer; found: Set<number> } {
  const found = new Set<number>();
  const keep = Math.max(0, ...canaries.map((canary) => canary.length - 1));
  const fd = openSync(file, "r");
  try {
    let carried = Buffer.alloc(0);
    let head = Buffer.alloc(0);
    const chunk = Buffer.alloc(CHUNK);
    for (;;) {
      const read = readSync(fd, chunk, 0, CHUNK, null);
      if (read === 0) break;
      const window = Buffer.concat([carried, chunk.subarray(0, read)]);
      if (head.length < SQLITE_HEADER.length) head = Buffer.concat([head, chunk.subarray(0, Math.min(read, SQLITE_HEADER.length - head.length))]);
      canaries.forEach((canary, index) => { if (!found.has(index) && window.includes(canary)) found.add(index); });
      carried = keep === 0 ? Buffer.alloc(0) : Buffer.from(window.subarray(Math.max(0, window.length - keep)));
    }
    return { head, found };
  } finally {
    closeSync(fd);
  }
}

function sealedLayout(head: Buffer, bytes: number, path: string): string | null {
  if (head[0] !== HEADER_BYTES) return `its first byte is ${head[0] ?? "missing"}, not the sealed header's ${HEADER_BYTES}`;
  const fits = [SEGMENT, VECTOR_SEGMENT].some((segment) => {
    try {
      layoutOf(bytes, segment, path);
      return true;
    } catch {
      return false;
    }
  });
  return fits ? null : `its ${bytes} bytes are no sealed layout`;
}

function logLayout(file: string, bytes: number): string | null {
  if (bytes < LOG_HEADER) return null;
  const fd = openSync(file, "r");
  try {
    const length = Buffer.alloc(LOG_LENGTH);
    for (let at = LOG_HEADER, record = 0; at < bytes; record += 1) {
      if (at + LOG_LENGTH > bytes) return null;
      readSync(fd, length, 0, LOG_LENGTH, at);
      const declared = length.readUInt32BE(0);
      if (declared < LOG_SEAL) return `its record ${record} is shorter than its nonce and tag`;
      if (declared > LOG_RECORD) return `its record ${record} declares more bytes than a record holds`;
      at += LOG_LENGTH + declared;
    }
    return null;
  } finally {
    closeSync(fd);
  }
}

function macEncrypted(file: string, path: string, head: Buffer, bytes: number): { class: FileClass; why: string } {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (nameKey(name) !== undefined) return { class: "unclassified", why: "the Mac's own file, but named as the home's sealed files are" };
  if (head[0] === LOG_MARK) {
    const wrong = logLayout(file, bytes);
    return wrong === null ? { class: "mac-encrypted", why: "the Mac's encrypted log: its mark, and records that walk to its end" } : { class: "unclassified", why: `the Mac's log mark, but ${wrong}` };
  }
  const wrong = sealedLayout(head, bytes, path);
  return wrong === null ? { class: "mac-encrypted", why: "the Mac's file encrypted whole: the sealed header and layout" } : { class: "unclassified", why: `the Mac's own file, plain or damaged: ${wrong}` };
}

function rowOf(rows: readonly Row[], tree: Tree, path: string): Row | undefined {
  return rows.find((row) => row.tree === tree && row.pattern.test(path));
}

function classify(tree: Tree, file: string, path: string, head: Buffer, bytes: number): { class: FileClass; why: string } {
  if (tree === "machine" && path.startsWith("scratch/")) return { class: "scratch", why: "security 3.7: the one plain place for working copies" };
  if (MAC_OWN(tree, path)) {
    const plain = rowOf(ALLOWED_PLAIN, tree, path);
    return plain === undefined ? macEncrypted(file, path, head, bytes) : { class: "plain", why: plain.reason };
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (nameKey(name) !== undefined || SEALED_TREE.test(path)) {
    const wrong = sealedLayout(head, bytes, path);
    return wrong === null ? { class: "sealed", why: "a sealed name, and the sealed header" } : { class: "unclassified", why: `a sealed name, but ${wrong}` };
  }
  const store = rowOf(STORE_ROLES, tree, path.replace(STORE_LOGS, ""));
  if (store !== undefined) {
    return head.equals(SQLITE_HEADER)
      ? { class: "unclassified", why: `${store.reason}, but plain: it holds a SQLite header` }
      : { class: "keyed-store", why: `${store.reason}${STORE_LOGS.test(path) ? ", its log" : ""}, with no SQLite header` };
  }
  const plain = rowOf(ALLOWED_PLAIN, tree, path);
  if (plain !== undefined) return { class: "plain", why: plain.reason };
  return { class: "unclassified", why: "no store role, no sealed name and no row of what stays plain" };
}

function sqliteAllowed(tree: Tree, path: string): boolean {
  if (tree === "folder") return LOCK_FILES.test(path);
  return tree === "machine" && [MACHINE_LOCK, STORE_MEMORY, PHOTO_ENTRIES].some((pattern) => pattern.test(path));
}

export function inventory(input: InventoryInput): Inventory {
  const canaries = (input.canaries ?? []).filter((canary) => canary !== "");
  const needles = canaries.map((canary) => Buffer.from(canary, "utf8"));
  const blobs = new Set((input.blobs ?? []).map((blob) => blob.replace(/^sha256:/u, "").toLowerCase()));
  const files: Listed[] = [];
  const flags: Flag[] = [];
  const counts: Record<FileClass, number> = { "keyed-store": 0, sealed: 0, "mac-encrypted": 0, plain: 0, scratch: 0, unclassified: 0 };
  const scratch: string[] = [];
  const tops: [Tree, string][] = [["folder", input.folder], ["machine", input.machine], ...(input.spool === undefined ? [] : [["spool", input.spool] as [Tree, string]])];
  for (const [tree, top] of tops) {
    const found: { path: string; kind: "file" | "other"; bytes: number }[] = [];
    walk(top, top, found);
    for (const entry of found) {
      const flag = (kind: FlagKind, detail: string) => flags.push({ kind, tree, path: entry.path, detail });
      for (const canary of canaries) if (entry.path.includes(canary)) flag("canary", `its path holds ${JSON.stringify(canary)}`);
      if (entry.kind === "other") {
        const placed: FileClass = tree !== "machine" ? "unclassified" : entry.path.startsWith("run/") ? "plain" : entry.path.startsWith("scratch/") ? "scratch" : "unclassified";
        files.push({ tree, path: entry.path, bytes: entry.bytes, class: placed, why: "not a regular file", canaries: [] });
        counts[placed] += 1;
        if (placed === "scratch") scratch.push(entry.path);
        if (placed === "unclassified") flag("unclassified", "not a regular file, outside run/ and scratch/");
        continue;
      }
      const { head, found: hits } = scan(join(top, entry.path), needles);
      const { class: fileClass, why } = classify(tree, join(top, entry.path), entry.path, head, entry.bytes);
      const held = [...hits].sort((a, b) => a - b).map((index) => canaries[index]!);
      files.push({ tree, path: entry.path, bytes: entry.bytes, class: fileClass, why, canaries: held });
      counts[fileClass] += 1;
      if (fileClass === "scratch") {
        scratch.push(entry.path);
        continue;
      }
      for (const canary of held) flag("canary", `holds ${JSON.stringify(canary)} outside scratch`);
      if (head.equals(SQLITE_HEADER) && !sqliteAllowed(tree, entry.path)) flag("sqlite-header", "a SQLite header on a file that is not a lock file, a store memory or the photo entries");
      const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
      const bare = name.replace(/^sha256[:-]/u, "");
      if (blobs.has(bare)) flag("hash-named-blob", "named by the SHA-256 of a blob the home holds");
      else if (HEX_NAME.test(name) && !SEALED_TREE.test(entry.path) && !(tree === "machine" && MAC_KEYED_NAME.test(entry.path))) flag("hash-named-blob", "named by 64 hex characters outside a keyed blob tree");
      if (fileClass === "unclassified") flag("unclassified", why);
    }
  }
  return { folder: input.folder, machine: input.machine, spool: input.spool ?? null, counts, scratch, flags, files };
}

export const USAGE = "usage: npx tsx tools/inventory.ts --folder <home folder> --machine <machine directory> [--spool <the Mac's spool>] [--canary <text>]… [--blob <sha256>]…";

export function runInventory(argv: readonly string[], print: (line: string) => void, fail: (line: string) => void): number {
  let values: { folder?: string; machine?: string; spool?: string; canary?: string[]; blob?: string[] };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { folder: { type: "string" }, machine: { type: "string" }, spool: { type: "string" }, canary: { type: "string", multiple: true }, blob: { type: "string", multiple: true } },
      strict: true, allowPositionals: false,
    }));
  } catch (error) {
    fail(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  if (values.folder === undefined || values.machine === undefined) {
    fail(USAGE);
    return 2;
  }
  const report = inventory({ folder: values.folder, machine: values.machine, ...(values.spool === undefined ? {} : { spool: values.spool }), canaries: values.canary ?? [], blobs: values.blob ?? [] });
  print(JSON.stringify(report, null, 2));
  return report.flags.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = runInventory(process.argv.slice(2), (line) => console.log(line), (line) => console.error(line));
}
