import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import {
  BlobError, civilDay, countMember, dayBounds, emptyLanded, homeBlobFault, hostFault, importSubject, isObject, outOfRoom, OWNER_REQUEST, parse, REST, SecretError, sha256, sourceName, type AttemptRow, type BlobReader, type BlobStore, type Delivery, type DeliveryFile, type DeliveryRow, type Guard, type Holding, type HomeFolder, type Json, type KeptFile, type JsonObject, type Landed, type MemoryChanges, type OpenView, type PollRow, type PollWrite, type ReadTables, type ReaderOutput, type SourceRow, type Tx,
} from "@lifestreamprotocol/core";
import {
  imports as declaredImports, byDoor, callMemory, chromeSites, cursorText, isLibrary, LabelerUnavailable, NeedsYou, NotYet, offline, sealedFacts, StationFailed, stationsOver, unitOf, vendorOf, whoNamed, whoWords,
  type Accounts, type Acquirer, type Connector, type Fetched, type FetchedFile, type LabelSince, type Lent, type Reader, type Remembered, type WaitReason,
} from "@lifestreamprotocol/connect";
import { PHOTO_KIND, snapshotOf } from "@lifestreamprotocol/families";
import { accountsOf, catalogOf, laneSources, switchOf } from "./catalog.js";
import { readerFor, type Registry } from "./registry.js";
import { waitsOnFolder } from "./folders.js";
import { failpoint } from "./failpoint.js";
import { lengthsOf, measured } from "./stored.js";
import { laneOf, ownerProductOf, ownerSource, type OwnerProduct } from "./devices.js";
import { phoneShare } from "./phone.js";
import { indexedQuiet, passAhead, quietOf } from "./quiet.js";
import { basicInstant, basicMs, type Custody, deliveredFile, deliveriesOf, deliveryAt, deliveryDirectory, inboxLane, isMember, type Lane, lanes, manifestOf, openSealing, readDelivery, receiptOf, removeDelivery, type Received, type SealedDelivery, timestampMs } from "./inbox.js";
import { aboutOf, latest, needsMet, outcomesOf, record, targetOf, type Ended } from "./attempts.js";
import { REST_OF, stateOfNeed } from "./health.js";
import { covers, errorText, historyGate, jobError, LANE, POLL_PARKED, restRefusal, type HelperEnv, type Kind, type Main, type Slice, type Task } from "./jobs.js";
import { deviceOf, readPrincipals, type Principal } from "./principals.js";
import { connectorOf, connectorSettings } from "./settings.js";
import { startOf } from "./start.js";
import { CATCH_UP, POLL_STARTED, RETRY_MS, retryOf } from "./status.js";
import { POLL_REFRESH } from "./refresh-now.js";
import { admitImport, besideOf, failedLook, fileOfPath, goneOf, importFiles, importKindOf, importImported, importSources, isVoid, listingOf, lookImport, readerFacts, linedKinds, widest, tallied, type Looked, type Tally } from "./imports.js";
import { readReceipt } from "./sweep.js";
import { applyThrough, countedOf, gapOf, leftOf, markLost, monthsIn, stateLeft, stateMonths, waitingOf, type Gap, type Value } from "./through.js";
import { SENDING_MS } from "./stated.js";


export const ORDERED_ROWS = 30_000;
export const ORDERED_BYTES = 64 * 1024 * 1024;

const SLICE_MS = 100;
export const CHUNK_ROWS = 2_000;
const CHUNK_MS = 50;

export interface Indexed {
  id: string;
  sealed_ms: number;
  stated_ms: number;
  facts: JsonObject;
  sources: string[];
  feeder: string;
  fetched_at: string;
  pass: string | null;
  custody: Custody;
  received: Received;
  bytes: number;
  looked?: Looked;
}

export function routes(sources: readonly SourceRow[], passes: readonly Principal[], lane: string, delivery: { pass: string | null; facts: JsonObject }): string[] {
  const sealer = passes.find((row) => row.id === delivery.pass);
  const kind = sealer === undefined ? null : deviceOf(sealer);
  const inKindLane = kind !== null && laneOf(kind, sealer!.unit) === lane;
  const carried = new Set(inKindLane ? sealer!.sources : [lane]);
  const delivered = new Set(passes.flatMap((row) => row.sources));
  return sources
    .filter((source) => (carried.has(source.id) && (!inKindLane || (typeof source.options.lane === "string" && phoneShare(delivery.facts, source.id) === "lines")))
      || (source.options.lane === lane && source.options.import === undefined && !delivered.has(source.id)))
    .map((source) => source.id).sort();
}

function feeds(sources: readonly SourceRow[], passes: readonly Principal[], lane: string, delivery: { pass: string | null; facts: JsonObject }, registry?: Registry): string[] {
  const stated = delivery.pass === null ? statedSources(delivery.facts, registry).map((source) => source.id) : [];
  return stated.length > 0 ? [...new Set(stated)].sort() : routes(sources, passes, lane, delivery);
}

function passesOf(folder: HomeFolder): Principal[] {
  return readPrincipals(folder).principals;
}

const STOPPED = "stopped:";
const STOPPED_KEPT = 10;

function stoppedRun(tx: Tx, feeder: string, fetched_at: string): void {
  tx.tables.meta.set(`${STOPPED}${feeder}`, JSON.stringify([...stoppedRuns(tx, feeder), fetched_at].slice(-STOPPED_KEPT)));
}

function stoppedRuns(tx: Tx, feeder: string): string[] {
  return JSON.parse(tx.tables.meta.get(`${STOPPED}${feeder}`) ?? "[]") as string[];
}

function runAt(tx: Tx, feeder: string, now: number): string {
  return new Date(Math.max(now, ...stoppedRuns(tx, feeder).map((at) => Date.parse(at) + 1))).toISOString();
}

function voided(tx: Tx, delivery: Indexed, shipment: readonly DeliveryRow[]): boolean {
  if (delivery.pass !== null) return false;
  if (shipment.some((row) => row.state === "superseded")) return true;
  const runs = stoppedRuns(tx, delivery.feeder);
  if (!runs.includes(delivery.fetched_at)) return false;
  const left = runs.filter((each) => each !== delivery.fetched_at);
  if (left.length === 0) tx.tables.meta.delete(`${STOPPED}${delivery.feeder}`);
  else tx.tables.meta.set(`${STOPPED}${delivery.feeder}`, JSON.stringify(left));
  return true;
}

export function index(main: Pick<Main, "now" | "settings" | "registry" | "folder">, tx: Tx, delivery: Indexed): number {
  const lane = splitId(delivery.id)[0];
  const stated = delivery.pass === null ? statedSources(delivery.facts) : [];
  holdStated(main, tx, lane, stated);
  const imported = importKindOf(delivery.facts) === null ? null
    : admitImport(tx, main.registry.connectors, delivery, lane, delivery.looked ?? null, main.now(), (delivery.looked?.device ?? null) === null ? [] : passesOf(main.folder));
  if (imported?.again === true || imported?.relook === true) lookAtInbox(tx, main.now());
  const sources = [...new Set([...delivery.sources, ...stated.map((source) => source.id), ...imported?.sources ?? []])].sort();
  if (sources.length === 0) return 0;
  const shipment = tx.tables.deliveries.shipment(delivery.id);
  const isVoid = voided(tx, delivery, shipment);
  if (shipment.length === 0 && !isVoid) tx.tables.inbox.grew(lane, delivery.sealed_ms, delivery.bytes);
  let added = 0;
  const paging = pageOf(main, delivery);
  const months = monthsIn(delivery.facts.months);
  const progressed = paging === null ? [] : stated.length > 0 ? stated.map((source) => source.id) : sources.length === 1 ? sources : [];
  for (const source of sources) {
    const stated = delivery.custody[source];
    const row = {
      id: delivery.id, source, sealed_ms: delivery.sealed_ms, stated_ms: imported?.sources.includes(source) === true ? imported.stated_ms : delivery.stated_ms, facts: delivery.facts,
      pass: delivery.pass, seal: stated?.seal ?? null, lost: stated?.lost === undefined ? null : stated.lost as unknown as Json,
    };
    if (!tx.tables.deliveries.add(row)) continue;
    if (quietOf({ ...row, run: null }) !== undefined) indexedQuiet(tx, main.now());
    if (isVoid) {
      tx.tables.deliveries.move(delivery.id, source, { move: "supersede" });
      continue;
    }
    added++;
    tx.tables.events.append({ at_ms: main.now(), kind: "delivery", key: delivery.id, detail: { source } });
    if (paging !== null && progressed.includes(source) && !pagedTo(tx.tables, source, paging)) {
      tx.tables.backfills.paged({ source, ...paging, at_ms: delivery.sealed_ms, delivery: delivery.id });
    }
    if (months !== null && (delivery.pass !== null || progressed.includes(source))) stateMonths(tx, source, { months, counted_ms: delivery.stated_ms });
    const left = delivery.pass === null ? null : leftOf(delivery.facts);
    if (left !== null) stateLeft(tx, source, { ...left, stated_ms: delivery.stated_ms, from: "delivery" });
  }
  for (const [source, received] of Object.entries(delivery.received)) {
    applyThrough(tx, source, { value: { read_through_ms: delivery.stated_ms, stated_ms: delivery.stated_ms }, received, at_ms: delivery.sealed_ms }, main.now());
  }
  return added;
}

function pagedTo(read: Pick<ReadTables, "backfills">, source: string, page: { acquirer: string; start_ms: number | null }): boolean {
  const row = read.backfills.get(source);
  return row !== undefined && row.acquirer === page.acquirer && row.start_ms === page.start_ms && row.left === 0;
}

interface Paging {
  acquirer: string;
  left: number | null;
  unit: [string, string] | null;
  start_ms: number | null;
}

function pageOf(main: Pick<Main, "registry">, delivery: Indexed): Paging | null {
  const { facts } = delivery;
  const start_ms = facts.start_ms;
  if (delivery.pass !== null || facts.history !== true || !Object.hasOwn(facts, "left") || !(start_ms === null || (typeof start_ms === "number" && Number.isSafeInteger(start_ms)))) return null;
  const left = facts.left;
  if (left !== null && !(typeof left === "number" && Number.isSafeInteger(left) && left >= 0)) return null;
  const connector = catalogOf(main.registry.connectors).ofAcquirer(delivery.feeder);
  const unit = connector === undefined ? undefined : unitOf(connector);
  return { acquirer: delivery.feeder, left, unit: unit === undefined ? null : [unit[0], unit[1]], start_ms };
}

export function lookAtInbox(tx: Tx, now: number): void {
  if (tx.tables.jobs.enqueue({ kind: "index-inbox", key: "inbox", connector: null, lane: LANE.polls, not_before_ms: now, now_ms: now }) === "dead") {
    throw new Error("the inbox look (index-inbox inbox) is dead: it runs again once revived");
  }
}

export function indexNudged(main: Pick<Main, "folder" | "now" | "settings" | "registry">, tx: Tx, id: string): number {
  const [lane, name] = splitId(id);
  const delivery = readDelivery(main.folder, lane, name);
  if (delivery === null) return 0;
  if (unlisted(tx.tables, main.registry, delivery.id, delivery.facts)) {
    lookAtInbox(tx, main.now());
    return 0;
  }
  const sources = feeds(tx.tables.sources.list(), passesOf(main.folder), lane, delivery);
  if (sources.length === 0 && importKindOf(delivery.facts) === null) throw new Error(`delivery ${id} feeds no source: its lane ${lane} routes to none`);
  return index(main, tx, indexed(delivery, sources));
}

export function kindsOf(registry: Pick<Registry, "connectors" | "readers">): readonly declaredImports.ImportKind[] {
  return declaredImports.importKinds(registry.connectors, registry.readers);
}

function unlisted(read: Pick<ReadTables, "meta">, registry: Pick<Registry, "connectors" | "readers">, id: string, facts: JsonObject): boolean {
  const kind = importKindOf(facts);
  const declared = kind === null ? undefined : declaredImports.importKind(kindsOf(registry), kind);
  if (declared === undefined || isVoid(read.meta, id)) return false;
  return listingOf(read.meta, id)?.hash !== declaredImports.listingHash(declared);
}


interface Look {
  began_ms: number;
  busy: string[];
  clear: boolean;
}

interface IndexCounts {
  found: number;
  waiting: number;
  unrouted: number;
  unreadable: number;
  removed: string[];
}

async function* indexHelper(env: HelperEnv, task: Task<Look>): AsyncGenerator<Indexed[], IndexCounts, undefined> {
  const counts: IndexCounts = { found: 0, waiting: 0, unrouted: 0, unreadable: 0, removed: [] };
  let page: Indexed[] = [];
  const passes = passesOf(env.folder);
  const delivered = new Set(passes.flatMap((pass) => {
    const kind = deviceOf(pass);
    const lane = kind === null ? null : laneOf(kind, pass.unit);
    return lane === null ? pass.sources : [...pass.sources, lane];
  }));
  const busy = new Set(task.data.busy);
  const clearable = new Set(task.data.clear ? [...env.registry.acquirers ?? [], ...env.registry.labelers ?? []].map((feeder) => feeder.source).filter((lane) => !delivered.has(lane) && !busy.has(lane)) : []);
  const leftovers: string[] = [];
  for (const lane of lanes(env.folder, { unreadable: () => counts.unreadable++ })) {
    const view = env.db.view();
    try {
      const sources = view.sources();
      for (const name of deliveriesOf(env.folder, lane)) {
        const id = `${lane}/${name}`;
        const rows = view.tables.deliveries.shipment(id);
        const have = new Set(rows.map((row) => row.source));
        const listed = rows.length > 0 && !unlisted(view.tables, env.registry, id, rows[0]!.facts);
        if (rows.length > 0 && listed && feeds(sources, passes, lane, rows[0]!).every((source) => have.has(source)) && importSources(view.tables.meta, id).every((source) => have.has(source))) continue;
        if (rows.length > 0 && rows[0]!.facts.transit === true && receiptOf(env.folder, deliveryDirectory(env.folder, lane, name)).exists()) continue;
        let delivery: SealedDelivery | null;
        try {
          delivery = readDelivery(env.folder, lane, name);
        } catch {
          counts.unreadable++;
          continue;
        }
        if (delivery === null) {
          const begun = basicMs(name);
          if (clearable.has(lane) && begun !== null && begun < task.data.began_ms && !manifestOf(env.folder, deliveryDirectory(env.folder, lane, name)).exists()) leftovers.push(id);
          else counts.waiting++;
          continue;
        }
        let fed: string[];
        try {
          fed = feeds(sources, passes, lane, delivery, env.registry);
        } catch {
          counts.unreadable++;
          continue;
        }
        let looked: Looked | undefined;
        if (unlisted(view.tables, env.registry, id, delivery.facts)) {
          const directory = deliveryDirectory(env.folder, lane, name);
          const own = new Map(delivery.files.map((file) => [file.blob, deliveredFile(env.folder, directory, file.path)] as const));
          const kind = declaredImports.importKind(kindsOf(env.registry), importKindOf(delivery.facts)!)!;
          env.reading(0);
          try {
            looked = await lookImport(kind, delivery, deliveryReader(env.blobs, inboxLane(env.folder, lane), own), view.tables.meta, listingOf(view.tables.meta, id), {
              present: (path) => deliveredFile(env.folder, directory, path).exists(), progress: (listed) => env.reading(listed),
            });
          } catch (error) {
            if (env.signal.aborted || hostFault(error) || homeBlobFault(error)) throw error;
            counts.unreadable++;
            looked = failedLook(kind, delivery, error);
          } finally {
            env.reading(null);
          }
          failpoint("import.listed");
        }
        fed = [...new Set([...fed, ...importSources(view.tables.meta, id)])].sort();
        if (fed.length === 0 && looked === undefined) {
          counts.unrouted++;
          continue;
        }
        counts.found++;
        page.push({ ...indexed(delivery, fed.filter((source) => !have.has(source))), ...(looked === undefined ? {} : { looked }) });
      }
    } finally {
      view.close();
    }
    if (page.length >= 100) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
  for (const id of leftovers) removeDelivery(env.folder, deliveryAt(env.folder, id));
  counts.removed = leftovers;
  return counts;
}

interface Candidate extends Gap {
  source: string;
}

function lostCandidates(tx: Tx, now: number): Candidate[] {
  return tx.tables.sources.list().flatMap((row) => {
    const waiting = waitingOf(tx.tables.meta, row.id);
    const gap = waiting === undefined || now - waiting.since_ms < SENDING_MS ? undefined : gapOf(tx.tables, row.id, waiting.received);
    return gap === undefined ? [] : [{ source: row.id, ...gap }];
  });
}

export const indexKind: Kind<Look, Indexed[], IndexCounts, Candidate[]> = {
  dies: true,
  begin(main, tx) {
    const sources = new Map<string, string>([
      ...(main.registry.acquirers ?? []).map((acquirer): [string, string] => [`poll:${acquirer.name}`, acquirer.source]),
      ...(main.registry.labelers ?? []).map((labeler): [string, string] => [`label:${labeler.name}`, labeler.source]),
    ]);
    const busy = tx.tables.jobs.open().filter((job) => job.state === "running").flatMap((job) => sources.get(`${job.kind}:${job.key}`) ?? []);
    return { data: { began_ms: main.now(), busy: [...new Set(busy)], clear: main.ending === 0 }, state: lostCandidates(tx, main.now()) };
  },
  helper: indexHelper,
  chunk: (main, _running, chunk) => [{ work: (tx) => { for (const delivery of chunk) index(main, tx, delivery); } }],
  done(main, tx, running, counts) {
    if (counts.removed.length > 0) main.log({ inbox: "leftovers", removed: counts.removed.length, ids: counts.removed });
    for (const { source, pass, seal } of running.state) {
      const waiting = waitingOf(tx.tables.meta, source);
      const gap = waiting === undefined ? undefined : gapOf(tx.tables, source, waiting.received);
      if (gap?.pass !== pass || gap.seal !== seal || !markLost(tx, source, gap, main.now())) continue;
      main.log({ through: "seal lost", pass, seal });
    }
  },
};


interface ImportData {
  id: string;
  source: string;
  connector: string;
  today: { start_ms: number; end_ms: number } | null;
  reread: boolean;
  catchUp: CatchUp;
}

type CatchUp = "whole" | "fetched" | null;

interface Ordered {
  newest_first: boolean;
}

export interface ImportProgress extends Partial<Ordered> {
  run: number;
  delivery: string;
  counts: Omit<Landed, "refusedMembers">;
  members?: [string, number][];
  tally?: Tally;
}

type Refusing = Pick<Landed, "refused" | "refusals" | "refusedMembers">;

function published(state: Pick<ImportState, "run" | "id" | "counts" | "kept" | "tally">, newest_first: Ordered["newest_first"]): ImportProgress {
  const { refusedMembers, ...counts } = state.counts;
  const refusing: Refusing = state.kept !== null && state.kept.refusing.refused > counts.refused ? state.kept.refusing : { refused: counts.refused, refusals: counts.refusals, ...(refusedMembers === undefined ? {} : { refusedMembers }) };
  return {
    run: state.run, delivery: state.id, counts: { ...counts, refused: refusing.refused, refusals: refusing.refusals }, newest_first,
    ...(refusing.refusedMembers === undefined || refusing.refusedMembers.size === 0 ? {} : { members: [...refusing.refusedMembers] }),
    ...(state.tally === null ? {} : { tally: widest(state.kept?.tally, state.tally) }),
  };
}

export function filesBeside(folder: HomeFolder, others: readonly { id: string; gone: ReadonlySet<string> }[]): { file: DeliveryFile; at: KeptFile }[] {
  return others.flatMap(({ id: other, gone }) => {
    const [lane, name] = splitId(other);
    const directory = deliveryDirectory(folder, lane, name);
    const held = readDelivery(folder, lane, name);
    if (held === null) return [];
    const files = importFiles(held.files.filter((file) => !gone.has(fileOfPath(file.path)))).map(({ path, blob, size, at }) => ({ file: { path: `${other}/${path}`, blob, size }, at: deliveredFile(folder, directory, at) }));
    const copied = (readReceipt(folder, directory)?.copied ?? []).filter(isMember).map((path) => ({ path, at: deliveredFile(folder, directory, path) })).filter((each) => each.at.exists()).map(({ path, at }) => {
      const bytes = at.read()!;
      return { file: { path: `${other}/${path}`, blob: sha256(bytes), size: bytes.length }, at };
    });
    return [...files.filter((each) => each.at.exists()), ...copied];
  });
}

interface ImportChunk extends Ordered {
  rows: ReaderOutput[];
  arrived?: string[];
  lengths?: Record<string, number>;
}

async function* importHelper(env: HelperEnv, task: Task<ImportData>): AsyncGenerator<ImportChunk, ImportResult, undefined> {
  const { id, source, connector: name, today, reread, catchUp } = task.data;
  try {
    return yield* importDelivery(env, id, source, name, today, catchUp);
  } catch (error) {
    if (reread && !env.signal.aborted && isGone(error)) return { read_through_ms: 0, held: [], caught_up: 0, gone: `${id}: ${errorText(error)}` };
    if (reread && !env.signal.aborted && jobError(error).database === undefined && !outOfRoom(error)) return { read_through_ms: 0, held: [], caught_up: 0, fault: `${id}: ${errorText(error)}` };
    if (!(error instanceof Error)) throw new Error(`${id}: ${String(error)}`);
    error.message = `${id}: ${error.message}`;
    throw error;
  }
}

async function* importDelivery(
  env: HelperEnv, id: string, source: string, name: string, today: ImportData["today"], catchUp: CatchUp,
): AsyncGenerator<ImportChunk, ImportResult> {
  const [lane, dirName] = splitId(id);
  const sealed = readDelivery(env.folder, lane, dirName);
  if (sealed === null) throw inputGone(`${id} is not sealed in the inbox`);
  const stated = sealed.pass === null ? statedSources(sealed.facts).map((each) => each.id) : [];
  if (stated.length > 0 && !stated.includes(source)) return { read_through_ms: 0, held: [], caught_up: 0 };
  const { pass: _pass, stamped_ms: _stamped, custody: _custody, received: _received, feeder: _feeder, fetched_at: _fetched, ...read } = sealed;
  let imported = false;
  let facts = read.facts;
  let others: { id: string; gone: ReadonlySet<string> }[] = [];
  let gone = new Set<string>();
  const view = env.db.view();
  try {
    imported = importKindOf(read.facts) !== null;
    if (imported) {
      facts = readerFacts(view.tables.meta, id, read.facts, env.settings.day.zone, source);
      others = besideOf(view.tables.meta, id, source).map((other) => ({ id: other, gone: new Set(goneOf(view.tables.meta, other)) }));
      gone = new Set(goneOf(view.tables.meta, id));
    }
  } finally {
    view.close();
  }
  const directory = deliveryDirectory(env.folder, lane, dirName);
  const swept = imported ? new Set(readReceipt(env.folder, directory)?.removed ?? []) : new Set<string>();
  const kept = !imported ? read.files : read.files.filter((file) => {
    if (gone.has(fileOfPath(file.path))) return false;
    if (deliveredFile(env.folder, directory, file.path).exists()) return true;
    if (swept.has(file.path)) return false;
    throw inputGone(`${file.path} is not in the inbox, and no receipt of the sweep's names it removed`);
  });
  const files = imported ? importFiles(kept).map(({ path, blob, size }) => ({ path, blob, size })) : kept;
  const beside = filesBeside(env.folder, others);
  const delivery: Delivery = { ...read, facts: beside.length === 0 ? facts : { ...facts, beside: beside.map(({ file }) => ({ ...file })) }, files, source };
  const transit = delivery.facts.transit === true || imported;
  const own = new Map(transit ? kept.map((file) => [file.blob, deliveredFile(env.folder, directory, file.path)] as const) : []);
  const reader = deliveryReader(env.blobs, inboxLane(env.folder, lane), own, new Map(beside.map((held) => [held.file.blob, held.at] as const)));
  const caught = catchUpOf(catchUp, source, reader);
  for (const file of transit ? [] : delivery.files) {
    if (!env.blobs.has(file.blob)) {
      const delivered = deliveredFile(env.folder, directory, file.path);
      if (!delivered.exists()) throw inputGone(`${file.path} is neither in the inbox nor in blobs/`);
      await env.blobs.putKept(delivered, { expect: file.blob, ...mediaOf(file.path) });
      caught.stored(file.blob, file.size);
    }
    reader.held.add(file.blob);
  }
  await reader.storeCarried();
  failpoint("import.blob");
  if (reader.held.size > 0) {
    yield { rows: [], newest_first: false, arrived: [...reader.held], lengths: lengthsOf(env.blobs, reader.held) };
    reader.held.clear();
  }
  let before: OpenView | undefined = env.db.view();
  let connector: Reader | undefined;
  let erased: ReadonlySet<string>;
  try {
    const row = before.tables.sources.get(source);
    connector = row === undefined ? undefined : readerFor(env.registry, row);
    erased = before.erasures(source);
  } finally {
    if (catchUp === null && (connector?.read.length ?? 0) < 3) {
      before.close();
      before = undefined;
    }
  }
  if (connector === undefined) throw new Error(`no connector ${name} reads ${source}`);
  let ended: { rest: Rest | null; fell: Counted | null };
  try {
    ended = yield* readRows(env, connector, delivery, reader, before, today, caught, erased);
  } finally {
    before?.close();
  }
  const { rest, fell } = ended;
  return {
    read_through_ms: delivery.stated_ms, held: [...reader.held], lengths: lengthsOf(env.blobs, reader.held), caught_up: caught.bytes(),
    ...(rest === null ? {} : { rest }), ...(fell === null ? {} : { fell }),
    ...(imported ? { beside: others.map((other) => other.id) } : {}),
  };
}

function catchUpOf(catchUp: CatchUp, source: string, reader: Pick<ReturnType<typeof deliveryReader>, "brought">) {
  const counted = new Map<string, number>();
  return {
    stored(hash: string, bytes: number): void {
      if (catchUp === "whole") counted.set(hash, bytes);
    },
    row(row: ReaderOutput, before: OpenView | undefined): void {
      if (catchUp === null || before === undefined || !Array.isArray(row.blobs)) return;
      if (catchUp === "fetched") {
        const snapshot = snapshotOf(row.key);
        const head = snapshot === null ? undefined : before.head({ source, kind: PHOTO_KIND, key: snapshot });
        if (head === undefined || head.version === "gone") return;
      }
      for (const blob of row.blobs) {
        if (typeof blob !== "string" || counted.has(blob) || !BLOB.test(blob)) continue;
        const bytes = reader.brought(blob);
        if (bytes !== null && !before.holds(blob)) counted.set(blob, bytes);
      }
    },
    bytes: (): number => [...counted.values()].reduce((sum, bytes) => sum + bytes, 0),
  };
}
type CatchUpCount = ReturnType<typeof catchUpOf>;

interface ImportResult {
  read_through_ms: number;
  held: string[];
  lengths?: Record<string, number>;
  caught_up: number;
  rest?: Rest;
  quiet?: number;
  fault?: string;
  gone?: string;
  fell?: Counted;
  beside?: string[];
}

interface Rest {
  refused: string;
}

function readFault(error: unknown): boolean {
  return homeBlobFault(error) || outOfRoom(error) || hostFault(error) || jobError(error).database !== undefined;
}

async function* floored(env: HelperEnv, read: () => AsyncIterable<ReaderOutput>, keep: (row: ReaderOutput) => Promise<ReaderOutput>, end: (rest: Rest) => void): AsyncGenerator<ReaderOutput> {
  let yielded = 0;
  let rows: AsyncIterator<ReaderOutput> | undefined;
  try {
    env.reading(0);
    rows = read()[Symbol.asyncIterator]();
    for (;;) {
      env.signal.throwIfAborted();
      env.reading(yielded);
      const next = await rows.next();
      env.reading(null);
      if (next.done === true) return;
      const row = await keep(next.value);
      yielded++;
      yield row;
    }
  } catch (error) {
    if (env.signal.aborted || readFault(error)) throw error;
    end({ refused: restRefusal(yielded, error) });
  } finally {
    env.reading(yielded);
    try {
      await rows?.return?.();
    } catch {
    }
    env.reading(null);
  }
}

const counted = (count: number): string => count.toLocaleString("en-US");

async function* readRows(
  env: HelperEnv, connector: Reader, delivery: Delivery, reader: ReturnType<typeof deliveryReader>, before: OpenView | undefined, today: ImportData["today"],
  caught: CatchUpCount, erased: ReadonlySet<string>,
): AsyncGenerator<ImportChunk, { rest: Rest | null; fell: Counted | null }> {
  const keep = async (row: ReaderOutput): Promise<ReaderOutput> => {
    if (erased.has(recordOf(row))) {
      delete row.bytes;
      delete row.streamed;
      return row;
    }
    if (row.bytes !== undefined) {
      for (const bytes of row.bytes) {
        const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const hash = sha256(buffer);
        const mediaType = row.media?.[hash];
        if (!env.blobs.has(hash)) caught.stored(hash, buffer.byteLength);
        reader.held.add(env.blobs.put(buffer, mediaType === undefined ? {} : { mediaType }));
      }
      delete row.bytes;
    }
    if (row.streamed !== undefined) {
      for (const each of row.streamed) {
        const mediaType = row.media?.[each.hash];
        if (!env.blobs.has(each.hash)) {
          caught.stored(each.hash, each.size);
          await env.blobs.putChunks(each.chunks, each.size, { expect: each.hash, ...(mediaType === undefined ? {} : { mediaType }) });
        }
        reader.held.add(each.hash);
      }
      delete row.streamed;
    }
    caught.row(row, before);
    if (Array.isArray(row.blobs)) for (const blob of row.blobs) if (BLOB.test(blob)) await reader.store(blob, row.media?.[blob]);
    return row;
  };
  let rest: Rest | null = null;
  const read = () => floored(env, () => connector.read(delivery, reader, before), keep, (ended) => { rest ??= ended; });
  let fell: Counted | null = null;
  const measure = (chunk: ImportChunk): ImportChunk => {
    const arrived = [...(chunk.arrived ?? []), ...reader.held];
    reader.held.clear();
    const named = chunk.rows.flatMap((row) => (Array.isArray(row.blobs) ? row.blobs : []));
    return { ...chunk, ...(arrived.length === 0 ? {} : { arrived }), lengths: lengthsOf(env.blobs, [...named, ...arrived]) };
  };
  if (today === null) for await (const chunk of streamed(read())) yield measure(chunk);
  else for await (const chunk of todayFirst(read, today, ORDERED, (counted) => { fell = counted; })) yield measure(rest === null ? chunk : { ...chunk, newest_first: false });
  return { rest, fell };
}

const BLOB = /^sha256:[0-9a-f]{64}$/u;

const DUE = Symbol("due");

function dueBy<T>(pending: Promise<T>, due_ms: number): Promise<T | typeof DUE> {
  let timer: NodeJS.Timeout | undefined;
  const due = new Promise<typeof DUE>((resolve) => { timer = setTimeout(() => resolve(DUE), Math.max(0, due_ms - Date.now())); });
  return Promise.race([pending, due]).finally(() => clearTimeout(timer));
}

export async function* streamed(rows: AsyncIterable<ReaderOutput>, skip: (row: ReaderOutput) => boolean = () => false): AsyncGenerator<ImportChunk> {
  const iterator = rows[Symbol.asyncIterator]();
  let chunk: ReaderOutput[] = [];
  let due_ms = 0;
  let pending: Promise<IteratorResult<ReaderOutput>> | undefined;
  try {
    for (;;) {
      pending ??= iterator.next();
      const next = chunk.length === 0 ? await pending : await dueBy(pending, due_ms);
      if (next === DUE) {
        yield { rows: chunk, newest_first: false };
        chunk = [];
        continue;
      }
      pending = undefined;
      if (next.done === true) break;
      if (skip(next.value)) continue;
      if (chunk.length === 0) due_ms = Date.now() + CHUNK_MS;
      chunk.push(next.value);
      if (chunk.length >= CHUNK_ROWS || Date.now() >= due_ms) {
        yield { rows: chunk, newest_first: false };
        chunk = [];
      }
    }
    if (chunk.length > 0) yield { rows: chunk, newest_first: false };
  } finally {
    if (pending === undefined) await iterator.return?.();
    else {
      void pending.catch(() => undefined);
      void iterator.return?.().catch(() => undefined);
    }
  }
}

export interface Counted {
  rows: number;
  bytes: number;
}

const ORDERED: Counted = { rows: ORDERED_ROWS, bytes: ORDERED_BYTES };

const sizeOf = (row: ReaderOutput): number => JSON.stringify(row).length;

export async function* todayFirst(
  read: () => AsyncGenerator<ReaderOutput>, today: { start_ms: number; end_ms: number }, caps: Counted, fell: (counted: Counted) => void,
): AsyncGenerator<ImportChunk> {
  const first = read();
  let rows = 0;
  let bytes = 0;
  const fallBack = async function* (): AsyncGenerator<ImportChunk> {
    await first.return(undefined);
    fell({ rows, bytes });
    yield* streamed(read());
  };
  const held: ReaderOutput[] = [];
  let next = await first.next();
  while (next.done !== true && held.length < caps.rows) {
    held.push(next.value);
    rows++;
    bytes += sizeOf(next.value);
    if (bytes > caps.bytes) break;
    next = await first.next();
  }
  if (bytes > caps.bytes) {
    held.length = 0;
    next = { done: true, value: undefined };
    return yield* fallBack();
  }
  if (next.done === true) return yield* chunked(newestFirst(held.splice(0), today), true);
  const todays = new Map<string, { row: ReaderOutput; size: number } | null>();
  bytes = 0;
  const isToday = (row: ReaderOutput) => row.time !== undefined && row.time.start_ms >= today.start_ms && row.time.start_ms < today.end_ms;
  const note = (row: ReaderOutput): boolean => {
    const record = recordOf(row);
    const was = todays.get(record);
    if (!isToday(row) && was === undefined) return true;
    if (was === undefined) bytes += record.length;
    else if (was !== null) bytes -= was.size;
    const size = isToday(row) ? sizeOf(row) : 0;
    todays.set(record, isToday(row) ? { row, size } : null);
    bytes += size;
    return todays.size <= caps.rows && bytes <= caps.bytes;
  };
  const noted = (row: ReaderOutput): boolean => {
    if (note(row)) return true;
    todays.clear();
    return false;
  };
  let over = !held.splice(0).every(noted);
  while (!over && next.done !== true) {
    rows++;
    over = !noted(next.value);
    if (!over) next = await first.next();
  }
  if (over) {
    next = { done: true, value: undefined };
    return yield* fallBack();
  }
  const landed = new Set<string>();
  {
    const kept = [...todays.values()].flatMap((each) => (each === null ? [] : [each.row]));
    todays.clear();
    for (const row of kept) landed.add(recordOf(row));
    yield* chunked(newestFirst(kept, today), false);
  }
  yield* streamed(read(), (row) => landed.has(recordOf(row)));
}

const recordOf = (row: ReaderOutput): string => `${row.kind}\u0000${row.key}`;

function* chunked(rows: readonly ReaderOutput[], newest_first: boolean): Generator<ImportChunk> {
  for (let start = 0; start < rows.length; start += CHUNK_ROWS) yield { rows: rows.slice(start, start + CHUNK_ROWS), newest_first };
}

export function newestFirst(rows: readonly ReaderOutput[], today: { start_ms: number; end_ms: number }): ReaderOutput[] {
  const last = new Map<string, ReaderOutput>();
  for (const row of rows) last.set(recordOf(row), row);
  const placed = rows.map((row, index) => {
    const start = last.get(recordOf(row))!.time?.start_ms;
    const rank = start === undefined ? 0 : start >= today.start_ms && start < today.end_ms ? 1 : 2;
    return { row, index, rank, start: start ?? 0 };
  });
  placed.sort((a, b) => a.rank - b.rank || b.start - a.start || a.index - b.index);
  return placed.map((each) => each.row);
}

export const importKind: Kind<ImportData, ImportChunk, ImportResult, ImportState> = {
  dies: true,
  helper: importHelper,
  begin(main, tx, job) {
    const source = job.key;
    const sourceRow = tx.tables.sources.get(source);
    if (switchOf(main.registry.connectors, main.settings.sources.off).source(sourceRow ?? { id: source })) return null;
    const connector = sourceRow === undefined ? undefined : readerFor(main.registry, sourceRow);
    if (sourceRow !== undefined && connector === undefined && waitsOnFolder(main.folder.root, (key) => tx.tables.meta.get(key), sourceRow.connector)) return null;
    const unread = tx.tables.deliveries.waiting(source) === undefined ? tx.tables.deliveries.unread(source, main.registry.code) : undefined;
    const next = passAhead(main, tx, source, unread);
    if (next === undefined) return null;
    const reread = next === unread;
    if (sourceRow === undefined) throw new Error(`${next.id}: no source ${source} is added`);
    if (connector === undefined) throw new Error(`${next.id}: source ${source} names connector ${sourceRow.connector}, which this release lacks`);
    const saved = job.progress as ImportProgress | null;
    const subject = importSubject(source, next.id);
    const relisted = !reread && tx.tables.runs.ended("import", subject);
    let run = reread ? tx.tables.runs.unfinished("import", subject, next.run)?.id ?? null
      : next.run !== null && tx.tables.runs.get(next.run)?.outcome === "ok" ? null : next.run;
    if (run === null) run = tx.tables.runs.start({ kind: "import", subject, started_ms: main.now() });
    else tx.tables.runs.resume(run);
    if (!reread) tx.tables.deliveries.move(next.id, source, { move: "begin", run });
    const resumed = saved?.run === run ? saved : null;
    if (resumed === null) tx.tables.jobs.progress(job.id, { run, delivery: next.id, counts: emptyLanded() } satisfies ImportProgress as never);
    const sealer = next.pass === null ? null : passesOf(main.folder).find((principal) => principal.id === next.pass)?.kind ?? null;
    const imported = importKindOf(next.facts) !== null;
    const today = !reread && !imported && sealer === "mac" ? dayBounds(civilDay(main.now(), main.settings.day), main.settings.day) : null;
    const library = isLibrary(main.registry.connectors, source);
    const catchUp: CatchUp = reread || relisted ? null : next.facts.history === true || (library && sealer === "mac") ? "whole"
      : library && sealer === "phone" ? "fetched" : null;
    const counts: Landed = resumed === null ? emptyLanded() : { ...resumed.counts, refused: 0, refusals: [] };
    return {
      data: { id: next.id, source, connector: sourceRow.connector, today: today === null ? null : { start_ms: today.start_ms, end_ms: today.end_ms }, reread, catchUp },
      state: {
        run, id: next.id, source, stated_ms: next.stated_ms, history: reread || relisted || next.facts.history === true, reread, relisted, failures: next.failures,
        counts, before: landedRows(counts), guards: connector.kinds, sliceRows: 500,
        tally: imported ? { days: {}, kinds: {} } : null,
        seen: new Set(),
        lined: imported ? linedKinds(main.registry.families, sourceRow) : new Set(),
        kept: resumed === null ? null : {
          refusing: { refused: resumed.counts.refused, refusals: resumed.counts.refusals, ...(resumed.members === undefined ? {} : { refusedMembers: new Map(resumed.members) }) },
          tally: resumed.tally ?? null,
        },
      },
    };
  },
  chunk(main, running, chunk) {
    const { state } = running;
    const store = measured(main.blobs, chunk.lengths);
    const slices: Slice[] = chunk.arrived === undefined ? [] : [{ work: (tx) => void tx.records.blobsArrived(chunk.arrived!, store) }];
    for (let start = 0; start < chunk.rows.length; ) {
      const rows = chunk.rows.slice(start, start + state.sliceRows);
      start += rows.length;
      slices.push({
        work(tx) {
          const began = performance.now();
          const counting = state.tally === null ? undefined : tallied(state.tally, state.seen, main.settings.day, (kind) => state.lined.has(kind));
          const landed = tx.records.land(state.run, { id: state.id, source: state.source, stated_ms: state.stated_ms, history: state.history, reread: state.reread || state.relisted }, rows, state.guards, store, counting);
          add(state.counts, landed);
          tx.tables.jobs.progress(running.job.id, published(state, chunk.newest_first) as never);
          state.sliceRows = sliceTarget(state.sliceRows, (performance.now() - began) / Math.max(1, rows.length));
        },
        after: () => failpoint("home.slice"),
      });
    }
    return slices;
  },
  done(main, tx, running, result) {
    const { state } = running;
    const now = main.now();
    const { read_through_ms: readThrough, held, lengths, caught_up, fault, gone, fell } = result;
    const rest = result.quiet === undefined ? result.rest : { refused: `the read stopped after ${counted(result.quiet)} rows; ${counted(landedRows(state.counts) - state.before)} landed` };
    const code = main.registry.code;
    if (rest !== undefined) {
      add(state.counts, tx.records.land(state.run, { id: state.id, source: state.source, stated_ms: state.stated_ms }, [{ kind: REST, key: state.id, content: null, refused: rest.refused }], state.guards, main.blobs));
      main.log({ import: "rest-refused", run: state.run });
    }
    const { changedPaths, refusals, consumed: _consumed, refusedMembers: _members, ...counts } = state.counts;
    if (fault !== undefined) {
      tx.tables.deliveries.move(state.id, state.source, { move: "reread", code, error: fault });
      tx.tables.runs.end(state.run, { ended_ms: now, outcome: "failed", error: fault, counts: { ...counts, refusals: refusals as never }, changed_paths: changedPaths });
      tx.tables.events.append({ at_ms: now, kind: "import-failed", key: state.id, detail: { source: state.source, run: state.run, reread: true, error: fault } });
      return;
    }
    if (gone !== undefined) {
      if (tx.tables.deliveries.get(state.id, state.source)?.state === "dead") tx.tables.deliveries.move(state.id, state.source, { move: "supersede", why: gone });
      else tx.tables.deliveries.move(state.id, state.source, { move: "reread", code, refused: 0, error: gone });
      tx.tables.runs.end(state.run, { ended_ms: now, outcome: "failed", error: gone, counts: { ...counts, refusals: refusals as never }, changed_paths: changedPaths });
      tx.tables.events.append({ at_ms: now, kind: "input-gone", key: state.id, detail: { source: state.source, run: state.run, reason: gone } });
      return;
    }
    if (fell !== undefined) main.log({ import: state.id, today_first: "connector order", rows: fell.rows, bytes: fell.bytes });
    importEnded(main, tx, state, state.counts, held, measured(main.blobs, lengths), readThrough, rest?.refused ?? null, caught_up, undefined, state.tally === null ? null : widest(state.kept?.tally, state.tally));
    if (result.beside !== undefined && state.counts.refused > 0 && besideOf(tx.tables.meta, state.id, state.source).some((other) => !result.beside!.includes(other))) {
      tx.tables.deliveries.move(state.id, state.source, { move: "unread" });
    }
  },
  failed(main, tx, _job, state, error) {
    if (state === undefined) return;
    const now = main.now();
    tx.tables.runs.end(state.run, { ended_ms: now, outcome: "failed", error });
    const row = tx.tables.deliveries.get(state.id, state.source);
    if (state.reread) tx.tables.deliveries.move(state.id, state.source, { move: "reread", code: main.registry.code, error });
    else if (row?.state === "importing" && row.run === state.run) tx.tables.deliveries.move(state.id, state.source, { move: "fail", error });
    tx.tables.events.append({ at_ms: now, kind: "import-failed", key: state.id, detail: { source: state.source, error } });
  },
  quiet: ({ state }, rows) => (!state.reread && state.failures === 0 ? null : { read_through_ms: state.stated_ms, held: [], caught_up: 0, quiet: rows }),
};

interface ImportState {
  run: number;
  id: string;
  source: string;
  stated_ms: number;
  history: boolean;
  reread: boolean;
  relisted: boolean;
  failures: number;
  counts: Landed;
  before: number;
  guards: Record<string, Guard>;
  sliceRows: number;
  tally: Tally | null;
  seen: Set<number>;
  lined: ReadonlySet<string>;
  kept: { refusing: Refusing; tally: Tally | null } | null;
}

export function importEnded(
  main: Pick<Main, "now" | "registry" | "settings">, tx: Tx, state: Pick<ImportState, "run" | "id" | "source" | "history" | "reread">, landed: Landed,
  held: readonly string[], store: Pick<Holding, "stored">, readThrough: number | null, error: string | null, caught_up: number, requested: Pick<Requested, "id" | "undoable"> = { id: null, undoable: false },
  tally: Tally | null = null,
): string | null {
  const now = main.now();
  const { changedPaths, refusals, consumed: _consumed, refusedMembers: _members, ...counts } = landed;
  tx.records.blobsArrived(held, store);
  if (caught_up > 0) tx.tables.meta.set(CATCH_UP, String(Number(tx.tables.meta.get(CATCH_UP) ?? 0) + caught_up));
  tx.moved.history ||= state.history;
  if (readThrough !== null) tx.tables.sources.advance(state.source, readThrough);
  const read = { refused: counts.refused, error, code: main.registry.code };
  tx.tables.deliveries.move(state.id, state.source, state.reread ? { move: "reread", ...read } : { move: "land", run: state.run, ...read });
  tx.tables.runs.end(state.run, { ended_ms: now, outcome: "ok", counts: { ...counts, refusals: refusals as never }, changed_paths: changedPaths });
  const seq = tx.tables.events.append({ at_ms: now, kind: "import", key: state.id, detail: { source: state.source, run: state.run, ...(state.reread ? { reread: true } : {}), ...counts } });
  const facts = tx.tables.deliveries.get(state.id, state.source)?.facts;
  if (facts !== undefined && importKindOf(facts) !== null) importImported(tx, state.id, state.source, landed, tally);
  const of = ownerProductOf(ownerSource(state.source, main.settings.unit)?.connector);
  if (state.reread || typeof facts?.request !== "string" || of === null) return null;
  const position = `${seq}:${now}`;
  tx.tables.meta.set(`${OWNER_REQUEST}${facts.request}`, JSON.stringify({ of, act: state.id, kind: typeof facts.action === "string" ? facts.action : null, ...requested, position, at_ms: now } satisfies Requested));
  return position;
}

export interface Requested {
  of: OwnerProduct;
  act: string | null;
  kind: string | null;
  id: string | null;
  undoable: boolean;
  position: string;
  at_ms: number;
}

export function landSealed(
  main: Pick<Main, "now" | "settings" | "registry" | "blobs" | "folder">, tx: Tx, delivery: Indexed, source: string, rows: readonly ReaderOutput[], guards: Record<string, Guard>,
  requested: Pick<Requested, "id" | "undoable">,
): string | null {
  index(main, tx, delivery);
  const run = tx.tables.runs.start({ kind: "import", subject: importSubject(source, delivery.id), started_ms: main.now() });
  const state = { run, id: delivery.id, source, history: false, reread: false };
  const landed = tx.records.land(run, { id: delivery.id, source, stated_ms: delivery.stated_ms }, rows, guards, main.blobs);
  const held = [...new Set(rows.flatMap((row) => row.blobs ?? []))].filter((blob) => main.blobs.has(blob));
  return importEnded(main, tx, state, landed, held, main.blobs, delivery.stated_ms, null, 0, requested);
}

export function sealedIndexed(folder: HomeFolder, tx: Tx, id: string): Indexed | null {
  const [lane, name] = splitId(id);
  const delivery = readDelivery(folder, lane, name);
  return delivery === null ? null : indexed(delivery, feeds(tx.tables.sources.list(), passesOf(folder), lane, delivery));
}

export function sliceTarget(rows: number, perRow_ms: number): number {
  return Math.max(50, Math.min(CHUNK_ROWS, Math.round(0.7 * rows + 0.3 * (SLICE_MS / Math.max(perRow_ms, 0.001)))));
}

function landedRows(landed: Landed): number {
  return CASES.reduce((sum, key) => sum + (key === "refused" ? 0 : landed[key]), 0);
}

const CASES = ["new", "restated", "changed", "late", "gone", "erased", "refused", "duplicated", "replayed"] as const;

function add(into: Landed, landed: Landed): void {
  for (const key of CASES) into[key] = (into[key] ?? 0) + landed[key];
  for (const [path, count] of Object.entries(landed.changedPaths)) into.changedPaths[path] = (into.changedPaths[path] ?? 0) + count;
  for (const refusal of landed.refusals) if (into.refusals.length < 10 || refusal.kind === REST) into.refusals.push(refusal);
  for (const file of landed.consumed ?? []) if (into.consumed?.includes(file) !== true) (into.consumed ??= []).push(file);
  for (const [member, count] of landed.refusedMembers ?? []) countMember(into, member, count);
}

export function deliveryReader(blobs: BlobStore, carried: Lane, own: ReadonlyMap<string, KeptFile> = new Map(), beside: ReadonlyMap<string, KeptFile> = new Map()): BlobReader & {
  store(hash: string, mediaType?: string): Promise<boolean>; storeCarried(): Promise<number>; held: Set<string>; brought(hash: string): number | null;
} {
  const held = new Set<string>();
  const fileOf = (hash: string) => own.get(hash) ?? beside.get(hash) ?? carried.blob(hash);
  const located = (hash: string): KeptFile => {
    const at = fileOf(hash);
    if (at.exists()) return at;
    if (own.has(hash)) throw inputGone(`the delivery's file ${hash} is neither in blobs/ nor at ${at.path}`);
    throw new BlobError("BLOB_NOT_FOUND", `blob ${hash} is neither in blobs/ nor ${beside.has(hash) ? `at ${at.path}` : `carried in lane ${carried.source}`}`);
  };
  const read = (hash: string): Buffer => {
    if (blobs.has(hash)) return blobs.bytes(hash);
    const file = located(hash);
    const bytes = file.read() ?? gone(file);
    if (sha256(bytes) !== hash) throw new BlobError("BLOB_HASH_MISMATCH", `${own.has(hash) || beside.has(hash) ? "the delivery's file" : "carried blob"} ${hash} does not hash to its name`);
    return bytes;
  };
  const text = (hash: string): string => {
    const bytes = read(hash);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BlobError("BLOB_NOT_TEXT", `blob ${hash} is not UTF-8 text`);
    }
  };
  return {
    held,
    brought(hash) {
      try {
        return fileOf(hash).stat()?.size ?? null;
      } catch {
        return null;
      }
    },
    async store(hash, mediaType) {
      if (!blobs.has(hash)) {
        if (!fileOf(hash).exists()) return false;
        await blobs.putKept(fileOf(hash), { expect: hash, ...(mediaType === undefined ? {} : { mediaType }) });
      }
      held.add(hash);
      return true;
    },
    async storeCarried() {
      let stored = 0;
      for (const { blob, file } of carried.blobs()) {
        if (!blobs.has(blob)) {
          await blobs.putKept(file, { expect: blob });
          stored++;
        }
        held.add(blob);
      }
      return stored;
    },
    has: (hash) => blobs.has(hash) || fileOf(hash).exists(),
    bytes: read,
    text,
    prefix: (hash, bytes) => (blobs.has(hash) ? blobs.prefix(hash, bytes) : prefixOf(located(hash), bytes)),
    async materialise(hash) {
      return blobs.has(hash) ? blobs.materialise(hash) : located(hash).materialise();
    },
  };
}

export function prefixOf(file: KeptFile, bytes: number): Buffer {
  const opened = file.opened() ?? gone(file);
  try {
    const head = Buffer.alloc(bytes);
    return head.subarray(0, opened.read(head, 0));
  } finally {
    opened.close();
  }
}

function gone(file: KeptFile): never {
  throw inputGone(`${file.path} left the inbox while it was read`);
}

const MEDIA: Record<string, string> = {
  ".db": "application/vnd.sqlite3", ".sqlite": "application/vnd.sqlite3", ".sqlite3": "application/vnd.sqlite3",
  ".json": "application/json", ".jsonl": "application/x-ndjson", ".ndjson": "application/x-ndjson",
  ".txt": "text/plain", ".csv": "text/csv", ".xml": "text/xml", ".eml": "text/plain", ".ics": "text/calendar", ".vcf": "text/vcard",
  ".html": "text/html", ".segb": "application/vnd.apple.segb",
};

function mediaOf(path: string): { mediaType?: string } {
  if (path.endsWith("-wal")) return { mediaType: "application/vnd.sqlite3.wal" };
  const type = MEDIA[extname(path).toLowerCase()];
  return type === undefined ? {} : { mediaType: type };
}


export type Call = "fetch" | "page";

export function siteNeed(connectors: readonly Connector[], lane: string, row: Pick<AttemptRow, "outcome" | "reason" | "facts"> | undefined): boolean {
  if (row?.outcome !== "need" || !chromeSites(connectors).some((site) => site.lanes.includes(lane))) return false;
  return row.reason === "signed-out" || row.reason === "password" || (row.reason === "extension" && row.facts.code === "SITE_NOT_ALLOWED");
}

export function heardNeed(connectors: readonly Connector[], lane: string, row: Pick<AttemptRow, "outcome" | "reason" | "facts"> | undefined): boolean {
  return siteNeed(connectors, lane, row) && row!.reason !== "extension";
}

export function siteNeedsMet(tx: Tx, connectors: readonly Connector[], lane: string, target: string, about: readonly string[], now: number): void {
  needsMet(tx, outcomesOf(tx.tables, lane, (row) => siteNeed(connectors, lane, row) && !(row.target === target && about.includes(row.source))), now);
}

export function chromeCame(tx: Tx, connectors: readonly Connector[], chosen: readonly string[], granted: ReadonlySet<string>, now: number, paused: ReadonlySet<string>): void {
  for (const site of chromeSites(connectors)) {
    if (!chosen.includes(site.id)) continue;
    for (const lane of site.lanes) {
      const last = latest(tx.tables, targetOf("fetch", lane));
      const refused = last?.outcome === "need" && last.reason === "extension" && last.facts.code === "SITE_NOT_ALLOWED";
      if ((last?.outcome === "wait" && last.reason === "chrome") || (refused && granted.has(site.id))) queuePoll(tx, connectors, lane, now, paused, ["fetch"]);
    }
  }
}

interface PollData {
  acquirer: string;
  cursor: string | null;
  fetched_at: string;
  accounts: Accounts;
  call: Call;
  start_ms: number | null;
  from_ms: number | null | undefined;
}

interface PollEnd extends Ended {
  stated: string[];
  accounts: string[];
}

interface PollResult {
  delivery: Indexed | null;
  sources?: StatedSource[];
  through?: Value;
  left?: Left;
  end: PollEnd;
  stood?: true;
  soon?: true;
  more?: true;
  next_ms?: number;
  held_ms?: number;
}

interface Left {
  state: string;
  start_ms: number | null;
  changes: MemoryChanges;
}

function remembered(db: HelperEnv["db"], acquirer: string): Remembered {
  const read = <T>(work: (tables: ReadTables) => T): T => {
    const view = db.view();
    try {
      return work(view.tables);
    } finally {
      view.close();
    }
  };
  return {
    get: (part, key) => read((tables) => tables.polls.remembered(acquirer, part, key)),
    after: (part, after, limit) => read((tables) => tables.polls.rememberedAfter(acquirer, part, after, limit)),
  };
}

function handed(acquirer: string, text: string): JsonObject | null {
  let state: Json;
  try {
    state = parse(text);
  } catch (error) {
    throw new Error(`the cursor of ${acquirer} is no JSON: ${errorText(error)}`);
  }
  if (!isObject(state)) throw new Error(`the cursor of ${acquirer} is no JSON object`);
  return Object.keys(state).length === 0 ? null : state;
}

export const SOON_MS = 60_000;
const HOME_WAITS: readonly WaitReason[] = ["offline", "chrome", "vault", "disk", "power", "metered", "door"];

const homeWait = (reason: WaitReason, detail: string): PollEnd => ({ outcome: "wait", reason, detail, answered: false, stated: [], accounts: [] });
const statedIn = (facts: JsonObject): string[] => (Array.isArray(facts.sources) ? facts.sources.flatMap((each) => {
  const id = (each as { id?: unknown } | null)?.id;
  return typeof id === "string" ? [id] : [];
}) : []);
const accountIn = (facts: JsonObject): string[] => (typeof facts.account === "string" ? [facts.account] : []);

async function* pollHelper(env: HelperEnv, task: Task<PollData>): AsyncGenerator<never, PollResult, undefined> {
  const { acquirer: name, cursor, fetched_at, accounts, call, start_ms, from_ms } = task.data;
  const acquirer = (env.registry.acquirers ?? []).find((each) => each.name === name);
  if (acquirer === undefined) throw new Error(`no acquirer is named ${name}`);
  if (call === "page" && acquirer.page === undefined) throw new Error(`acquirer ${name} reads no page of history`);
  const held = env.secrets();
  const site = chromeSites(env.registry.connectors).find((each) => each.lanes.includes(name));
  const state = cursor === null ? null : handed(name, cursor);
  const memory = callMemory(cursor === null ? null : remembered(env.db, name));
  const lent: Lent = { stations: stationsOver(env.stations.door, env.stations.pass, { secrets: held, ...(site === undefined ? {} : { site: site.id }) }), accounts, start_ms, from_ms: cursor === null ? undefined : from_ms ?? null, memory };
  const leaving = (given: JsonObject | undefined): { left?: Left } => {
    if (given === undefined) {
      memory.end();
      return {};
    }
    const text = cursorText(given);
    return { left: { state: text, start_ms, changes: memory.end() } };
  };
  let fetched: Fetched & { more?: true; left?: number | null; next_ms?: number };
  try {
    fetched = call === "page" ? await acquirer.page!(state, held, lent) : await acquirer.fetch(state, held, lent);
  } catch (error) {
    const kept = leaving(error instanceof NeedsYou || error instanceof NotYet ? error.state : undefined);
    if (error instanceof NeedsYou) {
      const offered = error.account;
      const facts: JsonObject = { ...error.facts, ...(error.at ?? (site === undefined ? {} : { site: new URL(site.origin).host })), ...(offered === undefined ? {} : { offered: { id: offered.id, ...whoNamed(offered) } }) };
      const end: PollEnd = {
        outcome: stateOfNeed(error.reason) === "broken" ? "fail" : "need", reason: error.reason, facts, detail: error.says, answered: error.answered !== false,
        stated: statedIn(facts), accounts: offered === undefined ? accountIn(facts) : [offered.id, whoWords(offered)],
      };
      return { delivery: null, ...kept, end, ...(error.next_ms === undefined ? {} : { next_ms: error.next_ms }) };
    }
    if (error instanceof SecretError && error.reason === "locked") return { delivery: null, ...kept, end: homeWait("vault", "a secret was asked while the vault is locked") };
    if (site !== undefined && error instanceof StationFailed && error.code === "NO_STATION") return { delivery: null, ...kept, end: homeWait("chrome", `no present station has ${site.id} chosen`) };
    if (error instanceof StationFailed && error.code === "BUSY") return { delivery: null, ...kept, end: homeWait("chrome", "every present station that chose its site is busy"), stood: true };
    if (offline(error)) return { delivery: null, ...kept, end: homeWait(byDoor(error) ? "door" : "offline", errorText(error)), stood: true, soon: true };
    if (error instanceof StationFailed && error.code === "INTERRUPTED") return { delivery: null, ...kept, end: homeWait("chrome", errorText(error)), stood: true, soon: true };
    if (!(error instanceof NotYet)) throw error;
    const facts = error.facts ?? {};
    return {
      delivery: null, ...kept,
      end: { outcome: "wait", reason: error.reason, facts, detail: error.detail, answered: !HOME_WAITS.includes(error.reason), stated: statedIn(facts), accounts: accountIn(facts) },
      ...(error.next_ms === undefined ? {} : { next_ms: error.next_ms }), ...(error.backoff_ms === undefined ? {} : { held_ms: error.backoff_ms }),
    };
  }
  const left = leaving(fetched.state);
  const sources = statedSources(fetched.facts, env.registry);
  const facts = sealedFacts(name, call, fetched, start_ms);
  const after = {
    ...(call === "fetch" && fetched.more === true ? { more: true as const } : {}), ...(fetched.next_ms === undefined ? {} : { next_ms: fetched.next_ms }),
    ...(fetched.backoff_ms === undefined ? {} : { held_ms: fetched.backoff_ms }),
  };
  const answered = fetched.answered !== false;
  const read: PollEnd = fetched.backoff_ms === undefined
    ? { outcome: "ok", reason: null, answered, stated: statedIn(fetched.facts), accounts: accountIn(fetched.facts) }
    : { outcome: "wait", reason: "provider-limit", detail: `${name} holds further calls until ${new Date(fetched.backoff_ms).toISOString()}`, answered, stated: statedIn(fetched.facts), accounts: accountIn(fetched.facts) };
  if (facts === null) {
    const [read_through_ms, stated_ms] = [timestampMs(fetched.facts.read_through), timestampMs(fetched.facts.snapshot_taken_at)];
    const through = read_through_ms === null || stated_ms === null ? {} : { through: { read_through_ms, stated_ms } };
    return { delivery: null, sources, ...left, end: read, ...after, ...through };
  }
  env.signal.throwIfAborted();
  const delivery = await seal(env, acquirer.source, acquirer.name, fetched_at, fetched.files, facts);
  failpoint("poll.sealed");
  return { delivery, ...left, end: read, ...after };
}

interface PollRun {
  call: Call;
  queued: Call[];
  fetched_at: string;
  source: string;
  resets: string | null;
  refresh?: true;
}

export const POLL_RUN = "poll-run:";

type KeptRun = PollRun & { began_ms: number };

export function runOf(read: Pick<ReadTables, "meta">, acquirer: string): KeptRun | undefined {
  const kept = read.meta.get(`${POLL_RUN}${acquirer}`);
  return kept === undefined ? undefined : JSON.parse(kept) as KeptRun;
}

export const POLL_READ = "poll-read:";

export interface LastRead {
  call: Call;
  at_ms: number;
}

export interface PollStatus {
  now: { state: "running"; call: Call; began_ms: number } | { state: "queued"; calls: Call[] } | null;
  read: LastRead | null;
  last: { call: Call; at_ms: number; outcome: string } | null;
}

export function pollStatus(read: Pick<ReadTables, "meta" | "jobs" | "attempts">, acquirer: string): PollStatus {
  const run = runOf(read, acquirer);
  const job = read.jobs.get("poll", acquirer)?.state;
  const calls = queuedOf(read, acquirer);
  const now = run !== undefined ? { state: "running" as const, call: run.call, began_ms: run.began_ms }
    : job === "queued" || job === "running" || calls.length > 0 ? { state: "queued" as const, calls } : null;
  const kept = read.meta.get(`${POLL_READ}${acquirer}`);
  const lastRead = kept === undefined ? null : JSON.parse(kept) as LastRead;
  const newest = (["fetch", "page"] as const).flatMap((call) => {
    const row = latest(read, targetOf(call, acquirer));
    return row === undefined ? [] : [{ call, at_ms: row.at_ms, outcome: row.outcome }];
  }).sort((a, b) => b.at_ms - a.at_ms)[0];
  return { now, read: lastRead, last: newest ?? (lastRead === null ? null : { ...lastRead, outcome: "ok" }) };
}

export function pollsCut(main: Pick<Main, "registry" | "now">, tx: Tx): string[] {
  const now = main.now();
  const built = new Map((main.registry.acquirers ?? []).map((acquirer) => [acquirer.name, acquirer] as const));
  const paused = new Set(tx.tables.controls.list().map((control) => control.target));
  const cut: string[] = [];
  for (const name of tx.tables.meta.under(POLL_RUN)) {
    const run = runOf(tx.tables, name)!;
    tx.tables.meta.delete(`${POLL_RUN}${name}`);
    const acquirer = built.get(name);
    if (acquirer === undefined) continue;
    const target = targetOf(run.call, name);
    const about = aboutOf(laneSources(main.registry.connectors, tx.tables.sources.list(), run.source, tx.tables.deliveries.fedBy(run.source)), { stated: [], accounts: [] });
    const before = (about.length === 0 ? [""] : about).map((source) => tx.tables.attempts.get(target, source)).find((row) => row?.facts.interrupted === true);
    const cuts = before === undefined ? 1 : (typeof before.facts.cuts === "number" ? before.facts.cuts : 1) + 1;
    const what = run.call === "page" ? "page of history" : "fetch";
    const detail = `the home stopped while this ${what} ran (begun ${new Date(run.began_ms).toISOString()})${cuts > 1 ? `, ${cuts} times in a row` : ""}; it runs again now`;
    record(tx, target, about, { outcome: "wait", reason: "door", facts: { interrupted: true, cuts, began_ms: run.began_ms }, detail, answered: false }, now);
    if (run.refresh === true) tx.tables.meta.set(`${POLL_REFRESH}${name}`, "queued");
    queuePoll(tx, main.registry.connectors, name, now, paused, run.queued);
    cut.push(name);
  }
  return cut;
}

const POLL_QUEUED = "poll-queued:";

export const BY_HAND: readonly Call[] = ["fetch", "page"];

export function queuedFor(tx: Tx, acquirer: string, calls: readonly Call[]): void {
  const kept = tx.tables.meta.get(`${POLL_QUEUED}${acquirer}`);
  const queued = new Set<Call>([...(kept === undefined ? [] : JSON.parse(kept) as Call[]), ...calls]);
  tx.tables.meta.set(`${POLL_QUEUED}${acquirer}`, JSON.stringify((["fetch", "page"] as const).filter((call) => queued.has(call))));
}

function queuedOf(read: Pick<ReadTables, "meta">, acquirer: string): Call[] {
  const kept = read.meta.get(`${POLL_QUEUED}${acquirer}`);
  return kept === undefined ? [] : JSON.parse(kept) as Call[];
}

function takeQueued(tx: Tx, acquirer: string): Call[] {
  const queued = queuedOf(tx.tables, acquirer);
  tx.tables.meta.delete(`${POLL_QUEUED}${acquirer}`);
  return queued;
}

const POLL_RESETS = "poll-resets:";

function wasReset(tx: Tx, acquirer: string, run: PollRun | null | undefined): boolean {
  return run !== null && run !== undefined && (tx.tables.meta.get(`${POLL_RESETS}${acquirer}`) ?? null) !== run.resets;
}

function countReset(tx: Tx, acquirer: string): void {
  tx.tables.meta.set(`${POLL_RESETS}${acquirer}`, String(Number(tx.tables.meta.get(`${POLL_RESETS}${acquirer}`) ?? "0") + 1));
}

type Parked = Pick<PollRow, "paged_ms">;

export function parkPoll(tx: Tx, acquirer: string): void {
  const row = tx.tables.polls.get(acquirer);
  if (row === undefined) return;
  tx.tables.meta.set(`${POLL_PARKED}${acquirer}`, JSON.stringify({ paged_ms: row.paged_ms } satisfies Parked));
  tx.tables.polls.delete(acquirer);
  tx.tables.attempts.delete(targetOf("fetch", acquirer));
  tx.tables.attempts.delete(targetOf("page", acquirer));
  tx.tables.meta.delete(`${POLL_STARTED}${acquirer}`);
  tx.tables.meta.delete(`${POLL_QUEUED}${acquirer}`);
  tx.tables.meta.delete(`${POLL_REFRESH}${acquirer}`);
  const job = tx.tables.jobs.get("poll", acquirer);
  if (job?.state === "queued") tx.tables.jobs.delete(job.id);
  countReset(tx, acquirer);
}

export function unparkPoll(tx: Tx, acquirer: Pick<Acquirer, "name" | "page">): void {
  const pages = acquirer.page !== undefined;
  const row = tx.tables.polls.get(acquirer.name);
  if (row !== undefined) {
    if (row.pages !== pages) tx.tables.polls.put({ ...row, pages });
    return;
  }
  const kept = tx.tables.meta.get(`${POLL_PARKED}${acquirer.name}`);
  tx.tables.meta.delete(`${POLL_PARKED}${acquirer.name}`);
  const parked = kept === undefined ? null : JSON.parse(kept) as Parked;
  tx.tables.polls.put({ acquirer: acquirer.name, next_ms: 0, paged_ms: parked?.paged_ms ?? null, page_next_ms: null, held_ms: null, pages });
}

export function pageAgain(tx: Tx, acquirer: string): void {
  const row = tx.tables.polls.get(acquirer);
  if (row !== undefined) tx.tables.polls.put({ ...row, paged_ms: null, page_next_ms: null });
  tx.tables.backfills.restart(acquirer);
}

export function rereadPoll(tx: Tx, acquirer: Pick<Acquirer, "name" | "page">, now: number): void {
  const held_ms = tx.tables.polls.get(acquirer.name)?.held_ms ?? null;
  countReset(tx, acquirer.name);
  tx.tables.polls.forget(acquirer.name);
  tx.tables.backfills.restart(acquirer.name);
  tx.tables.polls.put({ acquirer: acquirer.name, next_ms: now, paged_ms: null, page_next_ms: null, held_ms, pages: acquirer.page !== undefined });
}

export function fetchDue(row: PollRow | undefined, now: number): boolean {
  return Math.max(row?.next_ms ?? 0, row?.held_ms ?? 0) <= now;
}

export interface PageTurn {
  due: boolean;
  overdue: boolean;
}

export function pageTurns(
  main: Pick<Main, "room" | "stated"> & { registry: Pick<Registry, "connectors">; settings: Pick<Main["settings"], "history" | "connectors" | "sources"> },
  read: Pick<ReadTables, "polls" | "controls" | "devices" | "backfills" | "sources" | "deliveries" | "attempts" | "meta">, now: number,
): (acquirer: Pick<Acquirer, "name" | "source" | "page" | "months">) => PageTurn {
  const no: PageTurn = { due: false, overdue: false };
  const gate = historyGate(read, main.stated, main.room);
  const off = switchOf(main.registry.connectors, main.settings.sources.off);
  const sources = read.sources.list();
  return (acquirer) => {
    if (acquirer.page === undefined) return no;
    const connector = connectorOf(main.registry.connectors, acquirer.name);
    const backfill = connectorSettings(connector, main.settings.connectors[connector.id]).backfill;
    const pace = backfill?.pace_ms ?? null;
    if (pace === null || !gate.may(connector.id, "home")) return no;
    const standing = [latest(read, targetOf("fetch", acquirer.name)), latest(read, targetOf("page", acquirer.name))];
    if (standing.some((each) => heardNeed(main.registry.connectors, acquirer.name, each))) return no;
    const row = read.polls.get(acquirer.name);
    const paged = row?.paged_ms ?? null;
    const read_ = (standing[1]?.outcome ?? "ok") === "ok";
    const turn = Math.max(paged === null ? 0 : paged + (read_ ? pace : retryOf(pace)), row?.page_next_ms ?? 0);
    if (Math.max(turn, row?.held_ms ?? 0) > now) return no;
    const lane = laneSources(main.registry.connectors, sources, acquirer.source, read.deliveries.fedBy(acquirer.source));
    const fed = lane.filter((source) => !off.source(source));
    const page = { acquirer: acquirer.name, start_ms: startOf(main.settings, connector, now).ms };
    const settled = (source: SourceRow) => pagedTo(read, source.id, page) && (acquirer.months !== true || countedOf(read.meta, source.id) !== undefined);
    if (fed.length > 0 && reading(read, acquirer.name, lane, fed).every(settled)) return no;
    return { due: true, overdue: paged !== null && now >= paged + 2 * pace };
  };
}

function reading(read: Pick<ReadTables, "attempts">, acquirer: string, lane: readonly SourceRow[], fed: readonly SourceRow[]): readonly SourceRow[] {
  if (lane.length < 2) return fed;
  let newest: AttemptRow | undefined;
  for (const row of [...read.attempts.of(targetOf("fetch", acquirer)), ...read.attempts.of(targetOf("page", acquirer))]) {
    if ((row.source === "" || lane.some((source) => source.id === row.source)) && (newest === undefined || row.at_ms > newest.at_ms)) newest = row;
  }
  return newest === undefined || newest.source === "" ? fed : fed.filter((source) => source.id === newest!.source);
}

function callOf(main: Pick<Main, "registry" | "settings" | "room" | "stated">, tx: Tx, acquirer: Acquirer, now: number, queued: ReadonlySet<Call>): { call: Call | null; left: Call | null } {
  const row = tx.tables.polls.get(acquirer.name);
  if ((row?.held_ms ?? 0) > now) return { call: null, left: null };
  if (main.room === "full") return { call: null, left: null };
  const page = queued.has("page") ? pageTurns(main, tx.tables, now)(acquirer) : { due: false, overdue: false };
  if (page.due && (!queued.has("fetch") || !fetchDue(row, now) || page.overdue)) return { call: "page", left: queued.has("fetch") ? "fetch" : null };
  return { call: queued.has("fetch") ? "fetch" : null, left: null };
}

export const pollKind: Kind<PollData, never, PollResult, PollRun> = {
  dies: false,
  helper: pollHelper,
  begin(main, tx, job) {
    const name = job.key;
    const queued = takeQueued(tx, name);
    const acquirer = (main.registry.acquirers ?? []).find((each) => each.name === name);
    if (acquirer === undefined) {
      if (tx.tables.meta.get(`${POLL_PARKED}${name}`) !== undefined) return null;
      throw new Error(`no acquirer is named ${name}`);
    }
    const off = switchOf(main.registry.connectors, main.settings.sources.off);
    const sources = tx.tables.sources.list();
    const owed = tx.tables.meta.get(`${POLL_REFRESH}${name}`) !== undefined;
    if (off.poll(acquirer, sources, tx.tables.deliveries.fedBy)) {
      tx.tables.meta.delete(`${POLL_REFRESH}${name}`);
      return null;
    }
    const now = main.now();
    const { call, left } = callOf(main, tx, acquirer, now, new Set(queued));
    if (call === null) {
      tx.tables.meta.delete(`${POLL_REFRESH}${name}`);
      return null;
    }
    const refresh = owed && call === "fetch";
    if (refresh) tx.tables.meta.set(`${POLL_REFRESH}${name}`, "running");
    if (left !== null) {
      queuedFor(tx, name, [left]);
      tx.tables.jobs.enqueue({ kind: "poll", key: name, connector: job.connector, lane: job.lane, not_before_ms: now, now_ms: now });
    }
    const fetched_at = runAt(tx, name, now);
    const connector = connectorOf(main.registry.connectors, name);
    const cursor = tx.tables.polls.cursor(name);
    const kept = cursor?.source === acquirer.source ? cursor : undefined;
    const data = {
      acquirer: name, cursor: kept?.state ?? null, fetched_at, accounts: accountsOf(main.registry.connectors, sources, [acquirer.source], off, tx.tables.deliveries.fedBy), call,
      start_ms: startOf(main.settings, connector, now).ms, from_ms: kept?.start_ms,
    };
    const state: PollRun = { call, queued, fetched_at, source: acquirer.source, resets: tx.tables.meta.get(`${POLL_RESETS}${name}`) ?? null, ...(refresh ? { refresh: true as const } : {}) };
    tx.tables.meta.set(`${POLL_RUN}${name}`, JSON.stringify({ ...state, began_ms: now } satisfies KeptRun));
    return { data, state };
  },
  stopped(_main, tx, running) {
    tx.tables.meta.delete(`${POLL_RUN}${running.job.key}`);
    stoppedRun(tx, running.job.key, running.state.fetched_at);
    queuedFor(tx, running.job.key, running.state.queued);
    if (running.state.refresh === true) tx.tables.meta.set(`${POLL_REFRESH}${running.job.key}`, "queued");
  },
  done(main, tx, running, { delivery, sources, through, left, end, stood, soon, more, next_ms, held_ms }) {
    const now = main.now();
    const key = running.job.key;
    tx.tables.meta.delete(`${POLL_RUN}${key}`);
    if (wasReset(tx, key, running.state)) {
      if (delivery !== null) index(main, tx, delivery);
      return;
    }
    const rows = left === undefined ? 0 : tx.tables.polls.leave(key, { source: running.state.source, ...left });
    main.polled(left === undefined ? null : { bytes: Buffer.byteLength(left.state), rows });
    const refresh = running.state.refresh === true && running.state.call === "fetch";
    if (refresh) tx.tables.meta.delete(`${POLL_REFRESH}${key}`);
    const stated = delivery === null ? [] : statedIn(delivery.facts);
    const named = stated.length > 0 ? stated : delivery?.sources ?? [];
    if (delivery !== null) index(main, tx, delivery);
    if (sources !== undefined) holdStated(main, tx, key, sources);
    if (through !== undefined) for (const source of sources ?? []) applyThrough(tx, source.id, { value: through, received: {}, at_ms: now }, now);
    const about = named.length > 0 ? named : aboutOf(laneSources(main.registry.connectors, tx.tables.sources.list(), running.state.source, tx.tables.deliveries.fedBy(running.state.source)), end);
    const { stated: _stated, accounts: _accounts, ...ended_ } = end;
    const target = targetOf(running.state.call, key);
    record(tx, target, about, ended_, now);
    if (end.outcome === "ok" || delivery !== null) tx.tables.meta.set(`${POLL_READ}${key}`, JSON.stringify({ call: running.state.call, at_ms: now } satisfies LastRead));
    if (end.outcome === "ok" || named.length > 0 || end.stated.length > 0 || end.accounts.length > 0) siteNeedsMet(tx, main.registry.connectors, key, target, about, now);
    if (running.state.call === "page") {
      if (stood === true && soon === true) return pageSoon(tx, key, now + SOON_MS);
      paged(tx, key, now, stood === true ? {} : { next_ms, held_ms });
      return;
    }
    if (stood === true) return ended(main, tx, key, now, { ...(soon === true ? { at: now + SOON_MS } : {}), ...(refresh ? { refresh } : {}) });
    const heard = heardNeed(main.registry.connectors, key, { outcome: end.outcome, reason: end.reason, facts: end.facts ?? {} });
    ended(main, tx, key, now, { more, next_ms, held_ms, ...(end.outcome === "ok" || delivery !== null ? { read: true } : {}), ...(heard ? { heard } : {}), ...(refresh ? { refresh } : {}) });
  },
  failed(main, tx, job, state, error) {
    tx.tables.meta.delete(`${POLL_RUN}${job.key}`);
    if (wasReset(tx, job.key, state)) return;
    const now = main.now();
    const call = state?.call ?? "fetch";
    const refresh = state?.refresh === true && call === "fetch";
    if (refresh) tx.tables.meta.delete(`${POLL_REFRESH}${job.key}`);
    const lane = state?.source ?? (main.registry.acquirers ?? []).find((each) => each.name === job.key)?.source;
    const about = lane === undefined ? [] : aboutOf(laneSources(main.registry.connectors, tx.tables.sources.list(), lane, tx.tables.deliveries.fedBy(lane)), { stated: [], accounts: [] });
    record(tx, targetOf(call, job.key), about, { outcome: "fail", reason: "failing", detail: error, answered: false }, now);
    if (call === "page") return paged(tx, job.key, now, {});
    ended(main, tx, job.key, now, refresh ? { refresh } : {});
  },
};

function holdStated(main: Pick<Main, "now" | "settings" | "registry">, tx: Tx, lane: string, stated: readonly StatedSource[]): void {
  for (const { id, connector, email, name } of stated) {
    const held = tx.tables.sources.get(id);
    const named = email !== undefined ? { email } : name !== undefined ? { name } : {};
    if (held !== undefined) {
      if ((email !== undefined || name !== undefined) && (held.options.email !== email || held.options.name !== name)) {
        const { email: _email, name: _name, ...rest } = held.options;
        tx.tables.sources.restate(id, { ...rest, ...named });
      }
      continue;
    }
    const laneless = id === lane || sourceName(id).copy === "cloud" || ownerSource(id, main.settings.unit) !== null;
    tx.tables.sources.add({ id, vendor: vendorOf(main.registry.connectors, id), connector, options: laneless ? named : { lane, ...named }, added_ms: main.now() });
  }
}

type StatedSource = { id: string; connector: string; email?: string; name?: string };

function statedSources(facts: JsonObject, registry?: Registry): StatedSource[] {
  const listed = facts.sources;
  if (listed === undefined) return [];
  if (!Array.isArray(listed)) throw new Error("the poll's facts state sources that are not a list");
  return listed.map((each) => {
    const { id, connector, email, name } = (each ?? {}) as { id?: unknown; connector?: unknown; email?: unknown; name?: unknown };
    if (typeof id !== "string" || typeof connector !== "string") throw new Error("the poll's facts state a source without an id and a connector");
    if (email !== undefined && (typeof email !== "string" || email === "")) throw new Error(`the poll's facts state source ${id} with an email that is no text`);
    if (name !== undefined && (typeof name !== "string" || name === "" || email !== undefined)) throw new Error(`the poll's facts state source ${id} with a name that is no text, or beside an email`);
    if (registry === undefined) sourceName(id);
    else vendorOf(registry.connectors, id);
    if (registry !== undefined && readerFor(registry, { connector }) === undefined) throw new Error(`the poll's facts state source ${id} for connector ${connector}, which this release lacks`);
    return { id, connector, ...(email === undefined ? {} : { email }), ...(name === undefined ? {} : { name }) };
  });
}

export function queuePoll(tx: Tx, connectors: readonly Connector[], name: string, now: number, paused: ReadonlySet<string>, calls: readonly Call[]): void {
  queuedFor(tx, name, calls);
  const site = chromeSites(connectors).find((each) => each.lanes.includes(name));
  const connectorOf_ = (lane: string) => catalogOf(connectors).ofAcquirer(lane)?.id ?? null;
  const busy = (lane: string) => ["queued", "running"].includes(tx.tables.jobs.get("poll", lane)?.state ?? "done") && covers(paused, { kind: "poll", key: lane, connector: connectorOf_(lane) }) === null;
  if (site?.lanes.some((lane) => lane !== name && busy(lane)) === true) return;
  tx.tables.jobs.enqueue({ kind: "poll", key: name, connector: connectorOf_(name), lane: LANE.polls, not_before_ms: now, now_ms: now });
}

export interface PollDue {
  name: string;
  due_ms: number;
  calls: Call[];
}

export function pollsDue(
  main: Pick<Main, "room" | "stated"> & { registry: Pick<Registry, "connectors" | "acquirers">; settings: Pick<Main["settings"], "history" | "connectors" | "sources"> },
  read: Pick<ReadTables, "polls" | "controls" | "devices" | "backfills" | "sources" | "deliveries" | "attempts" | "jobs" | "meta">, now: number,
): PollDue[] {
  const acquirers = main.registry.acquirers ?? [];
  if (acquirers.length === 0) return [];
  const off = switchOf(main.registry.connectors, main.settings.sources.off);
  const sources = read.sources.list();
  const pageTurn = pageTurns(main, read, now);
  const due: PollDue[] = [];
  for (const acquirer of acquirers) {
    if (off.poll(acquirer, sources, read.deliveries.fedBy)) continue;
    const job = read.jobs.get("poll", acquirer.name);
    if (job !== undefined && job.state !== "done") continue;
    const poll = read.polls.get(acquirer.name);
    const asked = queuedOf(read, acquirer.name);
    const fetch = main.room !== "full" && fetchDue(poll, now);
    const page = pageTurn(acquirer).due;
    const calls = (["fetch", "page"] as const).filter((call) => asked.includes(call) || (call === "fetch" ? fetch : page));
    if (calls.length === 0) continue;
    due.push({ name: acquirer.name, due_ms: asked.length > 0 ? 0 : fetch ? poll?.next_ms ?? 0 : poll?.paged_ms ?? 0, calls });
  }
  return due;
}

function ended(
  main: Main, tx: Tx, key: string, now: number,
  end: { more?: true | undefined; next_ms?: number | undefined; held_ms?: number | undefined; at?: number; read?: true; heard?: true; refresh?: true },
): void {
  const previous = tx.tables.polls.get(key);
  const turn = end.at ?? nextTurn(main, key, now, end, end.read === true, end.heard === true);
  const kept = end.refresh === true && previous !== undefined && previous.next_ms > now ? previous.next_ms : null;
  tx.tables.polls.put({ ...previous, acquirer: key, next_ms: kept === null ? turn : Math.min(kept, turn), held_ms: end.held_ms ?? previous?.held_ms ?? null });
  if (tx.tables.meta.get(`${POLL_STARTED}${key}`) === undefined) tx.tables.meta.set(`${POLL_STARTED}${key}`, String(now));
}

function paged(tx: Tx, key: string, now: number, end: { next_ms?: number | undefined; held_ms?: number | undefined }): void {
  const previous: PollWrite = tx.tables.polls.get(key) ?? { acquirer: key, next_ms: 0 };
  tx.tables.polls.put({ ...previous, paged_ms: now, page_next_ms: end.next_ms ?? null, held_ms: end.held_ms ?? previous.held_ms ?? null });
}

function pageSoon(tx: Tx, key: string, at: number): void {
  const previous: PollWrite = tx.tables.polls.get(key) ?? { acquirer: key, next_ms: 0 };
  tx.tables.polls.put({ ...previous, page_next_ms: at });
}

export function nextTurn(main: Pick<Main, "registry" | "settings">, acquirer: string, now: number, next: { more?: true | undefined; next_ms?: number | undefined }, read: boolean, heard = false): number {
  const connector = connectorOf(main.registry.connectors, acquirer);
  const { refresh_ms } = connectorSettings(connector, main.settings.connectors[connector.id]);
  if (refresh_ms === null) return next.next_ms ?? (read ? now : now + RETRY_MS);
  const turn = read ? (next.more === true ? now : now + refresh_ms) : now + (heard ? refresh_ms : retryOf(refresh_ms));
  return Math.max(turn, next.next_ms ?? turn);
}


const LABELER_REST_MS = 5 * 60_000;

interface LabelData {
  labeler: string;
  since: LabelSince;
  fetched_at: string;
}

interface LabelResult {
  cursor: number;
  reread: number;
  delivery: Indexed | null;
  resting: { reason: LabelerUnavailable["reason"]; message: string } | null;
}

async function* labelHelper(env: HelperEnv, task: Task<LabelData>): AsyncGenerator<never, LabelResult, undefined> {
  const { labeler: name, since, fetched_at } = task.data;
  const labeler = (env.registry.labelers ?? []).find((each) => each.name === name);
  if (labeler === undefined) throw new Error(`no labeler is named ${name}`);
  const view = env.db.view();
  let labelling: ReturnType<typeof labeler.label>;
  let through: number;
  let rereadThrough: number;
  try {
    through = view.through;
    rereadThrough = view.newestReread();
    labelling = labeler.label(view, env.blobs, since, env.signal, env.secrets());
  } finally {
    view.close();
  }
  let output: Awaited<ReturnType<typeof labeler.label>>;
  let resting: LabelResult["resting"] = null;
  try {
    output = await labelling;
  } catch (error) {
    if (!(error instanceof LabelerUnavailable)) throw error;
    output = error.output;
    resting = { reason: error.reason, message: error.message };
  }
  env.signal.throwIfAborted();
  const delivery = output === null ? null : await seal(env, labeler.source, labeler.name, fetched_at, output.files, output.facts);
  return { cursor: through, reread: rereadThrough, delivery, resting };
}

export const labelKind: Kind<LabelData, never, LabelResult, string> = {
  dies: true,
  helper: labelHelper,
  begin(main, tx, job) {
    const source = main.registry.labelers?.find((labeler) => labeler.name === job.key)?.source;
    if (source !== undefined && switchOf(main.registry.connectors, main.settings.sources.off).source(tx.tables.sources.get(source) ?? { id: source })) return null;
    if (source !== undefined && (tx.tables.deliveries.next(source) !== undefined || tx.tables.deliveries.shipped(source)?.waiting === true)) return null;
    const cursor = tx.tables.cursors.get(`label:${job.key}`);
    const rested = source === undefined ? undefined : tx.tables.attempts.get(targetOf("label", job.key), source);
    const resting = rested !== undefined && rested.outcome !== "ok" && typeof rested.facts.rest === "string" ? rested.facts.rest as LabelerUnavailable["reason"] : undefined;
    const fetched_at = runAt(tx, job.key, main.now());
    const since: LabelSince = { seq: cursor?.seq ?? 0, reread: cursor?.reread ?? 0, ...(resting === undefined ? {} : { resting }) };
    return { data: { labeler: job.key, since, fetched_at }, state: fetched_at };
  },
  stopped(_main, tx, running) {
    stoppedRun(tx, running.job.key, running.state);
  },
  done(main, tx, running, outcome) {
    const { key } = running.job;
    const now = main.now();
    const about = labelCopies(main, key);
    if (outcome.resting === null) record(tx, targetOf("label", key), about, { outcome: "ok", reason: null, answered: true }, now);
    else {
      const { reason, message } = outcome.resting;
      if (reason === "refused") running.refused = true;
      const [rest, why] = REST_OF[reason];
      record(tx, targetOf("label", key), about, { outcome: rest, reason: why, facts: { rest: reason }, detail: message, answered: reason === "refused" }, now);
      running.again = { at_ms: now + LABELER_REST_MS, lane: running.job.lane };
      if (outcome.delivery === null) return;
    }
    tx.tables.cursors.move(`label:${key}`, { seq: outcome.cursor, reread: outcome.reread, at_ms: now });
    const owed = outcome.delivery?.facts.owed;
    if (typeof owed !== "number" || owed === 0) tx.tables.meta.delete(`${key}:now`);
    if (outcome.delivery !== null) index(main, tx, outcome.delivery);
  },
  failed(main, tx, job, _state, error) {
    record(tx, targetOf("label", job.key), labelCopies(main, job.key), { outcome: "fail", reason: "failing", detail: error, answered: false }, main.now());
  },
};

function labelCopies(main: Pick<Main, "registry">, labeler: string): string[] {
  const source = main.registry.labelers?.find((each) => each.name === labeler)?.source;
  return source === undefined ? [] : [source];
}

async function seal(env: HelperEnv, source: string, feeder: string, fetched_at: string, files: readonly FetchedFile[], facts: JsonObject): Promise<Indexed> {
  const name = basicInstant(fetched_at);
  const sealing = openSealing(env.folder, { source, name, feeder, fetched_at });
  const own = (path: string): boolean => {
    const within = relative(env.folder.root, path);
    return within !== "" && !within.startsWith("..") && !isAbsolute(within);
  };
  try {
    for (const file of files as readonly ({ path: string; bytes: Buffer } | { path: string; file: string })[]) {
      if (!("file" in file)) sealing.put(file.path, file.bytes);
      else if (!own(file.file)) await sealing.write(file.path, createReadStream(file.file));
      else {
        const digest = createHash("sha256");
        let bytes = 0;
        for await (const chunk of createReadStream(file.file) as AsyncIterable<Buffer>) {
          digest.update(chunk);
          bytes += chunk.byteLength;
        }
        await sealing.adopt(file.path, file.file, { sha256: digest.digest("hex"), bytes });
      }
    }
    sealing.seal(facts);
  } catch (error) {
    sealing.abandon();
    throw error;
  }
  const delivery = readDelivery(env.folder, source, name)!;
  const view: OpenView = env.db.view();
  try {
    return indexed(delivery, feeds(view.sources(), passesOf(env.folder), source, delivery, env.registry));
  } finally {
    view.close();
  }
}

export function indexed(delivery: SealedDelivery, sources: string[]): Indexed {
  return {
    id: delivery.id, sealed_ms: delivery.stamped_ms ?? delivery.sealed_ms, stated_ms: delivery.stated_ms, feeder: delivery.feeder, fetched_at: delivery.fetched_at, facts: delivery.facts, sources,
    pass: delivery.pass, custody: delivery.custody, received: delivery.received, bytes: delivery.files.reduce((sum, file) => sum + file.size, 0),
  };
}

export function present(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function inputGone(message: string): BlobError & { gone: true } {
  return Object.assign(new BlobError("BLOB_NOT_FOUND", message), { gone: true as const });
}

const isGone = (error: unknown): boolean => error instanceof BlobError && (error as { gone?: unknown }).gone === true;

function splitId(id: string): [string, string] {
  const at = id.indexOf("/");
  if (at <= 0 || at === id.length - 1) throw new TypeError(`${JSON.stringify(id)} is not a delivery id`);
  return [id.slice(0, at), id.slice(at + 1)];
}

