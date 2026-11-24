import { keptText as keptName, openArchiveFile, TEXT_KEPT_BYTES, type Connector } from "@lifestreamprotocol/connect";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { flush, isRead, isUnread, isWaiting, type BlobStore, type DeliveryRow, type HomeFolder, type ReadTables, type Tx } from "@lifestreamprotocol/core";
import { deliveredFile, deliveriesOf, deliveryAt, deliveryDirectory, inboxLane, isMember, lanes, type Manifest, type ManifestFile, manifestOf, newMember, readSealed, receiptOf, removeDelivery, removeMembers } from "./inbox.js";
import { consumedOf, fileOfPath, goneOf, GONE, heldImports, importIdOf, importKindOf, isVoid, letGoOf, listingOf, routedSources, type KeptListing, type Whose } from "./imports.js";
import { switchOf } from "./catalog.js";
import { failpoint } from "./failpoint.js";
import type { Kind } from "./jobs.js";


export interface Receipt {
  swept_ms: number;
  done: boolean;
  removed: string[];
  kept: string[];
  copied?: string[];
}

export interface SweepReport {
  deliveries: number;
  files: number;
  bytes: number;
  kept: number;
  superseded: number;
  superseded_bytes: number;
  import_files: number;
  import_bytes: number;
  void: number;
  lane_blobs: number;
  lane_bytes: number;
  unreadable: string[];
  ms: number;
}

export const sweepKind: Kind<readonly string[], ImportFound[], SweepReport, undefined> = {
  dies: true,
  begin: (main) => ({ data: main.settings.sources.off, state: undefined }),
  async *helper(env, task) {
    const read = <T>(work: (tables: ReadTables) => T): T => {
      const view = env.db.view();
      try {
        return work(view.tables);
      } finally {
        view.close();
      }
    };
    const steps = sweepSteps({ folder: env.folder, read, blobs: env.blobs, now_ms: task.now_ms, off: task.data, connectors: env.registry.connectors });
    for (let step = steps.next(); ; step = steps.next()) {
      if (step.done === true) return step.value;
      yield step.value;
      await env.committed();
    }
  },
  chunk: (main, _running, found) => [{ work: (tx) => letGoImports(main.folder, tx, found) }],
  done(main, tx, running, result) {
    tx.tables.events.append({ at_ms: main.now(), kind: "sweep", key: running.job.key, detail: result as never });
    main.log({ sweep: running.job.key, ms: result.ms, deliveries: result.deliveries, files: result.files, bytes: result.bytes });
  },
};

interface SweepInput { folder: HomeFolder; read: <T>(work: (tables: ReadTables) => T) => T; blobs: BlobStore; now_ms: number; off: readonly string[]; connectors: readonly Connector[] }

export function sweepInbox(input: SweepInput & { commit: <T>(work: (tx: Tx) => T) => T }): SweepReport {
  const steps = sweepSteps(input);
  for (let step = steps.next(); ; step = steps.next()) {
    if (step.done === true) return step.value;
    const found = step.value;
    input.commit((tx) => letGoImports(input.folder, tx, found));
  }
}

function* sweepSteps(input: SweepInput): Generator<ImportFound[], SweepReport, undefined> {
  const { folder, read, blobs, now_ms } = input;
  const began = performance.now();
  const isOff = switchOf(input.connectors, input.off).source;
  const offs = new Map<string, boolean>();
  const off = (source: string): boolean => {
    let known = offs.get(source);
    if (known === undefined) offs.set(source, known = isOff(read((tables) => tables.sources.get(source)) ?? { id: source }));
    return known;
  };
  const report: SweepReport = { deliveries: 0, files: 0, bytes: 0, kept: 0, superseded: 0, superseded_bytes: 0, import_files: 0, import_bytes: 0, void: 0, lane_blobs: 0, lane_bytes: 0, unreadable: [], ms: 0 };
  const held = (hex: string, bytes: number) => blobs.has(`sha256:${hex}`) && blobs.size(`sha256:${hex}`) === bytes;
  const sweptThrough = new Map<string, number>();
  const superseded: { directory: string; sources: string[]; stated_ms: number }[] = [];
  const imported: ImportFound[] = [];
  const unreadLanes = new Set<string>();
  for (const source of lanes(folder, { unreadable: (why) => report.unreadable.push(why) })) {
    for (const name of deliveriesOf(folder, source)) {
      const directory = deliveryDirectory(folder, source, name);
      try {
        const manifest = readSealed(folder, directory);
        if (manifest === null) continue;
        const id = `${source}/${name}`;
        const kind = importKindOf(manifest.facts);
        if (kind !== null) {
          const known = read((tables) => ({ void: isVoid(tables.meta, id), read: tables.deliveries.shipment(id).every(isRead) }));
          if (!known.void) {
            imported.push({ id, directory, manifest, receipt: readReceipt(folder, directory) });
          } else if (known.read) {
            manifestOf(folder, directory).remove();
            removeDelivery(folder, directory);
            report.void++;
          }
          continue;
        }
        const rows = read((tables) => tables.deliveries.shipment(id));
        if (rows.length === 0 || !rows.every(isRead)) unreadLanes.add(source);
        const receipt = readReceipt(folder, directory);
        if (rows.length === 0) continue;
        const stated = Math.max(...rows.map((row) => row.stated_ms));
        if (receipt?.done === true) {
          for (const row of rows) sweptThrough.set(row.source, Math.max(sweptThrough.get(row.source) ?? 0, stated));
          continue;
        }
        if (rows.every((row) => row.state === "superseded")) {
          superseded.push({ directory, sources: rows.map((row) => row.source), stated_ms: stated });
          continue;
        }
        const transit = manifest.facts.transit === true;
        const done = (row: DeliveryRow) => isRead(row) || (!transit && off(row.source));
        if (!rows.every(done)) continue;
        if (transit && rows.some((row) => row.refused > 0)) continue;
        const removes = transit ? (entry: ManifestFile) => !keptText(entry) : (entry: ManifestFile) => held(entry.sha256, entry.bytes);
        const swept = sweepDelivery(folder, directory, manifest, removes, now_ms, receipt);
        report.deliveries++;
        report.files += swept.removed;
        report.bytes += swept.bytes;
        report.kept += swept.kept;
        for (const row of rows) sweptThrough.set(row.source, Math.max(sweptThrough.get(row.source) ?? 0, stated));
      } catch (error) {
        report.unreadable.push(`${source}/${name}: ${(error as Error).message}`);
      }
    }
  }
  yield* sweepImports(folder, imported, read, now_ms, report);
  for (const older of superseded) {
    if (!older.sources.some((source) => (sweptThrough.get(source) ?? -Infinity) > older.stated_ms)) continue;
    report.superseded_bytes += directoryBytes(older.directory);
    manifestOf(folder, older.directory).remove();
    removeDelivery(folder, older.directory);
    report.superseded++;
  }
  for (const source of lanes(folder)) {
    if (unreadLanes.has(source)) continue;
    for (const { blob, file } of inboxLane(folder, source).blobs()) {
      const stat = file.stat();
      if (stat === undefined || !held(blob.slice("sha256:".length), stat.size)) continue;
      file.remove();
      report.lane_blobs++;
      report.lane_bytes += freed(stat);
    }
  }
  report.ms = Math.round(performance.now() - began);
  return report;
}

export interface ImportFound {
  id: string;
  directory: string;
  manifest: Manifest;
  receipt: Receipt | null;
}

interface ImportDelivery extends ImportFound {
  import: string;
  account: string | null;
  unit?: string | null;
  rows: DeliveryRow[];
  listing: KeptListing;
  let_go: string[];
  consumed: ReadonlyMap<string, readonly string[] | null>;
}

const readAll = (rows: readonly DeliveryRow[]): boolean => rows.length > 0 && rows.every(isRead);

function claimantsOf(listing: KeptListing, whose: Whose, path: string): string[] {
  return [...new Set(routedSources(listing, whose).filter((route) => route.files.includes(path)).map((route) => route.id))];
}

function consumedFile(each: ImportDelivery, path: string): boolean {
  const file = each.listing.files.find((entry) => entry.path === path);
  if (file === undefined || file.refused !== undefined || (file.unclaimed ?? 0) > 0) return false;
  if (each.listing.products.some((product) => !product.reads && product.files.includes(path))) return false;
  const claimants = claimantsOf(each.listing, each, path);
  if (claimants.length === 0) return false;
  return claimants.every((source) => {
    const row = each.rows.find((candidate) => candidate.source === source);
    return row !== undefined && isRead(row) && row.refused === 0 && each.consumed.get(source)?.includes(path) === true;
  });
}

function snapshotOf(found: readonly ImportFound[], tables: ReadTables): ImportDelivery[] {
  const held = heldImports(tables.meta);
  return found.flatMap((each): ImportDelivery[] => {
    const listing = listingOf(tables.meta, each.id);
    const id = importIdOf(tables.meta, each.id);
    if (listing === null || id === null) return [];
    const rows = tables.deliveries.shipment(each.id);
    const consumed = new Map(rows.map((row) => [row.source, consumedOf(tables.meta, each.id, row.source)] as const));
    return [{ ...each, import: id, account: held[id]?.account ?? null, ...held[id]?.unit === undefined ? {} : { unit: held[id]!.unit }, rows, listing, let_go: letGoOf(tables.meta, each.id), consumed }];
  });
}

export function letGoImports(folder: HomeFolder, tx: Tx, found: readonly ImportFound[]): void {
  const imported = snapshotOf(found, tx.tables);
  const byImport = new Map<string, ImportDelivery[]>();
  for (const each of imported) byImport.set(each.import, [...(byImport.get(each.import) ?? []), each]);
  const awaited = (each: ImportDelivery, path: string): boolean => {
    const readers = new Set(claimantsOf(each.listing, each, path));
    const waits = (row: DeliveryRow) => isWaiting(row) || (row.state === "imported" && isUnread(row) && row.read_by === null);
    return (byImport.get(each.import) ?? []).some((other) => other !== each && other.rows.some((row) => readers.has(row.source) && waits(row)));
  };
  for (const each of imported) {
    const running = each.rows.some((row) => row.state === "sealed" || row.state === "importing");
    const gone = new Set(goneOf(tx.tables.meta, each.id));
    const before = gone.size;
    for (const file of each.listing.files) {
      if (gone.has(file.path)) continue;
      if (!each.manifest.files.some((entry) => fileOfPath(entry.file) === file.path && deliveredFile(folder, each.directory, entry.file).exists())) continue;
      if (each.let_go.includes(file.path) && !running) gone.add(file.path);
      else if (readAll(each.rows) && consumedFile(each, file.path) && !awaited(each, file.path)) gone.add(file.path);
    }
    if (gone.size > before) tx.tables.meta.set(`${GONE}${each.id}`, JSON.stringify([...gone].sort()));
  }
}

function* sweepImports(folder: HomeFolder, found: readonly ImportFound[], read: <T>(work: (tables: ReadTables) => T) => T, now_ms: number, report: SweepReport): Generator<ImportFound[], void, undefined> {
  if (found.length === 0) return;
  yield [...found];
  const marked = read((tables) => found.map((each) => goneOf(tables.meta, each.id)));
  found.forEach((each, at) => {
    try {
      const goes = new Set(marked[at]!.filter((path) => each.manifest.files.some((entry) => fileOfPath(entry.file) === path && deliveredFile(folder, each.directory, entry.file).exists())));
      if (goes.size === 0 && each.receipt?.done !== false) return;
      const swept = sweepImportFiles(folder, each, goes, now_ms);
      report.import_files += swept.files;
      report.import_bytes += swept.bytes;
    } catch (error) {
      report.unreadable.push(`${each.id}: ${(error as Error).message}`);
    }
  });
}

function sweepImportFiles(folder: HomeFolder, each: ImportFound, goes: ReadonlySet<string>, now_ms: number): { files: number; bytes: number } {
  const { directory, manifest, receipt } = each;
  const kept = (file: string) => deliveredFile(folder, directory, file);
  const going = manifest.files.filter((entry) => goes.has(fileOfPath(entry.file)) && kept(entry.file).exists() && !keptText(entry));
  const copied = new Set(receipt?.copied ?? []);
  for (const entry of going) {
    const held = kept(entry.file).materialise();
    let archive: ReturnType<typeof openArchiveFile>;
    try {
      archive = openArchiveFile(held.path);
    } catch (error) {
      held.dispose();
      throw error;
    }
    if (archive === null) {
      held.dispose();
      continue;
    }
    try {
      for (const member of archive.entries()) {
        if (member.directory || !keptName(member.name, member.size)) continue;
        const at = `members/${entry.file}/${member.name}`;
        if (!isMember(at)) continue;
        if (!kept(at).exists()) newMember(folder, directory, at).write(member.bytes(TEXT_KEPT_BYTES));
        copied.add(at);
      }
    } finally {
      archive.close();
      held.dispose();
    }
  }
  const leaving = new Set([...(receipt?.removed ?? []), ...going.map((entry) => entry.file)]);
  const removed = manifest.files.map((entry) => entry.file).filter((file) => leaving.has(file));
  const left = manifest.files.map((entry) => entry.file).filter((file) => !removed.includes(file));
  const mark: Receipt = { swept_ms: receipt?.swept_ms ?? now_ms, done: false, removed, kept: left, ...(copied.size > 0 ? { copied: [...copied].sort() } : {}) };
  writeReceipt(folder, directory, mark);
  failpoint("sweep.receipt");
  const bytes = going.reduce((sum, entry) => sum + (kept(entry.file).stat()?.size ?? 0), 0);
  removeMembers(folder, directory, going.map((entry) => entry.file));
  failpoint("sweep.removed");
  writeReceipt(folder, directory, { ...mark, done: true });
  return { files: new Set(going.map((entry) => fileOfPath(entry.file))).size, bytes };
}

const keptText = (entry: Pick<ManifestFile, "file" | "bytes">): boolean => keptName(entry.file, entry.bytes);

function sweepDelivery(folder: HomeFolder, directory: string, manifest: Manifest, removes: (entry: ManifestFile) => boolean, now_ms: number, receipt: Receipt | null) {
  const removable: ManifestFile[] = [];
  const kept: string[] = [];
  for (const entry of manifest.files) {
    if (!deliveredFile(folder, directory, entry.file).exists()) continue;
    if (removes(entry)) removable.push(entry);
    else kept.push(entry.file);
  }
  const removed = manifest.files.map((entry) => entry.file).filter((file) => !kept.includes(file));
  const mark: Receipt = { swept_ms: receipt?.swept_ms ?? now_ms, done: false, removed, kept };
  writeReceipt(folder, directory, mark);
  failpoint("sweep.receipt");
  const bytes = removable.reduce((sum, entry) => {
    const stat = deliveredFile(folder, directory, entry.file).stat();
    return sum + (stat === undefined ? 0 : freed(stat));
  }, 0);
  removeMembers(folder, directory, removable.map((entry) => entry.file));
  writeReceipt(folder, directory, { ...mark, done: true });
  return { removed: removable.length, bytes, kept: kept.length };
}

export async function rehydrate(input: { folder: HomeFolder; blobs: BlobStore; delivery: string }): Promise<{ delivery: string; written: number; bytes: number }> {
  const { folder } = input;
  const directory = deliveryAt(folder, input.delivery);
  const manifest = readSealed(folder, directory);
  if (manifest === null) throw new Error(`no sealed delivery ${input.delivery}`);
  let written = 0;
  let bytes = 0;
  for (const entry of manifest.files) {
    if (deliveredFile(folder, directory, entry.file).exists()) continue;
    const hash = `sha256:${entry.sha256}`;
    if (!input.blobs.has(hash)) throw new Error(`${input.delivery}: blobs/ lacks ${entry.file} (${hash})`);
    const file = newMember(folder, directory, entry.file);
    const hasher = createHash("sha256");
    let size = 0;
    const back = input.blobs.stream(hash) as AsyncIterable<Buffer>;
    try {
      await file.writing((async function* () {
        for await (const chunk of back) {
          hasher.update(chunk);
          size += chunk.length;
          yield chunk;
        }
        const actual = hasher.digest("hex");
        if (actual !== entry.sha256 || size !== entry.bytes) throw new Error(`${input.delivery}: ${entry.file} came back as sha256:${actual}, the manifest states ${hash}`);
      })());
    } catch (error) {
      file.remove();
      throw error;
    }
    written++;
    bytes += entry.bytes;
  }
  receiptOf(folder, directory).remove();
  flush(directory);
  return { delivery: input.delivery, written, bytes };
}

export function readReceipt(folder: HomeFolder, directory: string): Receipt | null {
  const bytes = receiptOf(folder, directory).read();
  return bytes === undefined ? null : JSON.parse(bytes.toString("utf8")) as Receipt;
}

function writeReceipt(folder: HomeFolder, directory: string, receipt: Receipt): void {
  receiptOf(folder, directory).write(Buffer.from(`${JSON.stringify(receipt)}\n`));
}

function directoryBytes(directory: string): number {
  let total = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const stat = statSync(join(entry.parentPath, entry.name));
    total += freed({ size: stat.size, links: stat.nlink });
  }
  return total;
}

function freed(stat: { size: number; links: number }): number {
  return stat.links === 1 ? stat.size : 0;
}
