import { existsSync } from "node:fs";
import { emptyLanded, importSubject, isSettled, type DeliveryRow, type HomeFolder, type ReadTables, type Tx } from "@lifestreamprotocol/core";
import { iosDomainOf } from "@lifestreamprotocol/connect";
import { switchOf } from "./catalog.js";
import { importEnded, type ImportProgress } from "./import.js";
import { deliveryAt, manifestOf, readSealed, removeDelivery, timestampMs } from "./inbox.js";
import { connectorOfJob, covers, LANE, type HelperEnv, type Kind, type Main } from "./jobs.js";
import { phoneShare } from "./phone.js";
import { readerFor } from "./registry.js";
import { hear, leftOf, stateLeft } from "./through.js";

export const HEARTBEATS = 500;
const BATCH = 500;
const TURNS = 64;
export const QUIET_KEY = "rows";
export const LEFT_FOLDED = "through:left-folded";

type Row = Pick<DeliveryRow, "source" | "facts" | "seal" | "stated_ms" | "run">;
type Settling = Pick<Main, "now" | "registry" | "settings">;

export function quietOf(row: Row): { through: number | null } | undefined {
  if (row.seal !== null) return undefined;
  const share = phoneShare(row.facts, row.source);
  if (share !== "lines" && row.run !== null && iosDomainOf(row.source) === null) return undefined;
  if (share === "sat-out") return { through: null };
  if (share === "none") return { through: row.stated_ms };
  const through = timestampMs(row.facts.read_through);
  return through === null ? undefined : { through };
}

function settle(main: Settling, tx: Tx, row: DeliveryRow, through: number | null): void {
  if (row.state === "sealed") {
    if (through !== null) tx.tables.sources.advance(row.source, through);
    tx.tables.deliveries.move(row.id, row.source, { move: "pass" });
    return;
  }
  const reread = isSettled(row);
  const subject = importSubject(row.source, row.id);
  let run = reread ? tx.tables.runs.unfinished("import", subject, row.run)?.id ?? null : row.run!;
  if (run === null) run = tx.tables.runs.start({ kind: "import", subject, started_ms: main.now() });
  else tx.tables.runs.resume(run);
  if (!reread) tx.tables.deliveries.move(row.id, row.source, { move: "begin", run });
  const job = tx.tables.jobs.get("import", row.source);
  if (job !== undefined && (job.progress as ImportProgress | null)?.run === run) tx.tables.jobs.progress(job.id, null);
  importEnded(main, tx, { run, id: row.id, source: row.source, history: reread, reread }, emptyLanded(), [], {}, through, null, 0);
}

export function passAhead(main: Settling, tx: Tx, source: string, unread: DeliveryRow | undefined): DeliveryRow | undefined {
  const first = tx.tables.deliveries.ahead(source, 1);
  const rows = first[0] === undefined ? (unread === undefined ? [] : [unread])
    : quietOf(first[0]) === undefined ? first : tx.tables.deliveries.ahead(source, HEARTBEATS);
  for (const row of rows) {
    const quiet = quietOf(row);
    if (quiet === undefined) return row;
    settle(main, tx, row, quiet.through);
  }
  return undefined;
}

type Mark = Pick<DeliveryRow, "id" | "pass" | "stated_ms" | "sealed_ms">;

interface Marks {
  indexed: number;
  folded_to: string;
  drain: { source: string; after: Mark | null; behind: boolean };
  clear?: { after: string; left: number };
}

const MARKS = "quiet:marks";
export const QUIET_DONE = "quiet:done";
export const QUIET_INDEXED = "quiet:indexed";

const indexedOf = (meta: ReadTables["meta"]): number => Number(meta.get(QUIET_INDEXED) ?? 0);

export function indexedQuiet(tx: Tx, now: number): void {
  tx.tables.meta.set(QUIET_INDEXED, String(indexedOf(tx.tables.meta) + 1));
  tx.tables.meta.delete(QUIET_DONE);
  tx.tables.jobs.enqueue({ kind: "quiet", key: QUIET_KEY, connector: null, lane: LANE.polls, not_before_ms: now, now_ms: now });
}

function marksOf(meta: ReadTables["meta"]): Marks {
  const kept = meta.get(MARKS);
  return kept === undefined ? { indexed: indexedOf(meta), folded_to: "", drain: { source: "", after: null, behind: false } } : JSON.parse(kept) as Marks;
}

interface Counts {
  folded: number;
  fold_rows: number;
  fold_ms: number;
  settled: number;
  held: number;
  rows: number;
  directories: number;
  kept: number;
  left: number;
}

function sourceAfter(tx: Tx, after: string): string | undefined {
  return tx.tables.sources.list().map((row) => row.id).filter((id) => id > after).sort()[0];
}

function fold(tx: Tx, marks: Marks, counts: Counts, now: number): void {
  const began = performance.now();
  const next = tx.tables.deliveries.newestLeft(marks.folded_to);
  if (next === undefined) tx.tables.meta.set(LEFT_FOLDED, String(now));
  else {
    const left = next.row === undefined ? null : leftOf(next.row.facts);
    if (left !== null) {
      stateLeft(tx, next.source, { ...left, stated_ms: next.row!.stated_ms, from: "delivery" });
      counts.folded++;
    }
    counts.fold_rows += next.rows;
    marks.folded_to = next.source;
  }
  counts.fold_ms += Math.round(performance.now() - began);
}

function drainOf(main: Settling, tx: Tx, source: string, paused: ReadonlySet<string>): "settle" | "count" | null {
  if (tx.tables.jobs.get("import", source)?.state === "running") return null;
  if (covers(paused, { kind: "import", key: source, connector: connectorOfJob(main.registry, tx.tables, "import", source) }) !== null) return "count";
  const row = tx.tables.sources.get(source)!;
  return switchOf(main.registry.connectors, main.settings.sources.off).source(row) || readerFor(main.registry, row) === undefined ? "settle" : null;
}

function drain(main: Settling, tx: Tx, marks: Marks, counts: Counts): void {
  const paused = new Set(tx.tables.controls.list().map((control) => control.target));
  for (let read = 0; read < BATCH; ) {
    const at = marks.drain;
    const source = tx.tables.sources.get(at.source) === undefined ? sourceAfter(tx, at.source) : at.source;
    if (source === undefined) {
      marks.clear = { after: "", left: 0 };
      return;
    }
    if (source !== at.source) Object.assign(at, { source, after: null, behind: false });
    const does = drainOf(main, tx, source, paused);
    const limit = BATCH - read;
    const rows = does === null ? [] : tx.tables.deliveries.waitingAfter(source, at.after, limit);
    read += rows.length;
    for (const row of rows) {
      const quiet = quietOf(row);
      if (quiet !== undefined && does === "settle") {
        settle(main, tx, row, at.behind ? null : quiet.through);
        counts.settled++;
        continue;
      }
      if (quiet !== undefined) counts.held++;
      at.behind = true;
    }
    if (rows.length === limit) {
      const { id, pass, stated_ms, sealed_ms } = rows.at(-1)!;
      at.after = { id, pass, stated_ms, sealed_ms };
      return;
    }
    const next = sourceAfter(tx, source);
    if (next === undefined) {
      marks.clear = { after: "", left: 0 };
      return;
    }
    marks.drain = { source: next, after: null, behind: false };
  }
}

interface Held {
  running: Set<string>;
  named: Set<string>;
}

function heldBy(jobs: ReadTables["jobs"]): Held {
  const held: Held = { running: new Set(), named: new Set() };
  for (const job of jobs.open()) {
    if (job.kind !== "import") continue;
    if (job.state === "running") held.running.add(job.key);
    const delivery = (job.progress as ImportProgress | null)?.delivery;
    if (delivery !== undefined) held.named.add(`${delivery}\0${job.key}`);
  }
  return held;
}

const clearable = (row: DeliveryRow, held: Held): boolean =>
  isSettled(row) && quietOf(row) !== undefined && !held.running.has(row.source) && !held.named.has(`${row.id}\0${row.source}`);

interface Cleared {
  to: string | null;
  rows: Pick<DeliveryRow, "id" | "source">[];
  directories: number;
  kept: number;
  left: number;
}

function clearOut(folder: HomeFolder, batch: readonly DeliveryRow[], held: Held, to: string | null): Cleared {
  const quiet = new Set(batch.filter((row) => clearable(row, held)));
  const whole = new Set([...quiet].map((row) => row.id));
  for (const row of batch) if (!quiet.has(row)) whole.delete(row.id);
  const kept = new Set<string>();
  let directories = 0;
  for (const id of whole) {
    const directory = deliveryAt(folder, id);
    let listed: number | null;
    try {
      listed = readSealed(folder, directory)?.files.length ?? null;
    } catch {
      listed = NaN;
    }
    if (listed !== null && listed !== 0) {
      kept.add(id);
      continue;
    }
    if (listed === 0) manifestOf(folder, directory).remove();
    if (existsSync(directory)) directories++;
    removeDelivery(folder, directory);
  }
  const rows = [...quiet].filter((row) => !kept.has(row.id)).map(({ id, source }) => ({ id, source }));
  return { to, rows, directories, kept: kept.size, left: batch.filter((row) => quietOf(row) !== undefined).length - rows.length };
}

function cleared(tx: Tx, step: Cleared, counts: Counts, now: number): boolean {
  const held = heldBy(tx.tables.jobs);
  const heard = new Map<string, number>();
  let left = step.left;
  for (const { id, source } of step.rows) {
    const row = tx.tables.deliveries.get(id, source);
    if (row === undefined) continue;
    if (!clearable(row, held) || !tx.tables.deliveries.remove(id, source)) {
      left++;
      continue;
    }
    counts.rows++;
    heard.set(source, Math.max(heard.get(source) ?? row.sealed_ms, row.sealed_ms));
  }
  for (const [source, at_ms] of heard) hear(tx, source, at_ms);
  counts.directories += step.directories;
  counts.kept += step.kept;
  counts.left += left;
  const marks = marksOf(tx.tables.meta);
  const walked = (marks.clear?.left ?? 0) + left;
  if (step.to === null) {
    tx.tables.meta.delete(MARKS);
    if (indexedOf(tx.tables.meta) !== marks.indexed) return false;
    if (walked === 0) tx.tables.meta.set(QUIET_DONE, String(now));
    return true;
  }
  tx.tables.meta.set(MARKS, JSON.stringify({ ...marks, clear: { after: step.to, left: walked } } satisfies Marks));
  return false;
}

function turn(main: Settling, tx: Tx, counts: Counts): void {
  const marks = marksOf(tx.tables.meta);
  if (tx.tables.meta.get(LEFT_FOLDED) === undefined) fold(tx, marks, counts, main.now());
  else drain(main, tx, marks, counts);
  tx.tables.meta.set(MARKS, JSON.stringify(marks));
}

interface Run {
  counts: Counts;
  done: boolean;
}

type Step = Cleared | null;

async function* quietHelper(env: HelperEnv): AsyncGenerator<Step, undefined, undefined> {
  for (let at = 0; at < TURNS; at++) {
    await env.committed();
    let view = env.db.view();
    let clear: Marks["clear"];
    try {
      clear = marksOf(view.tables.meta).clear;
    } finally {
      view.close();
    }
    if (clear === undefined) {
      yield null;
      continue;
    }
    const step: Cleared = { to: clear.after, rows: [], directories: 0, kept: 0, left: 0 };
    while (step.to !== null && step.rows.length === 0) {
      view = env.db.view();
      let batch: DeliveryRow[];
      let held: Held;
      try {
        batch = view.tables.deliveries.walk(step.to, BATCH);
        held = heldBy(view.tables.jobs);
      } finally {
        view.close();
      }
      const read = clearOut(env.folder, batch, held, batch.length < BATCH ? null : batch.at(-1)!.id);
      Object.assign(step, { to: read.to, rows: read.rows, directories: step.directories + read.directories, kept: step.kept + read.kept, left: step.left + read.left });
    }
    yield step;
    if (step.to === null) return undefined;
  }
  return undefined;
}

export const quietKind: Kind<undefined, Step, undefined, Run> = {
  dies: true,
  begin() {
    return { data: undefined, state: { counts: { folded: 0, fold_rows: 0, fold_ms: 0, settled: 0, held: 0, rows: 0, directories: 0, kept: 0, left: 0 }, done: false } };
  },
  helper: quietHelper,
  chunk: (main, running, step) => [{
    work(tx) {
      if (running.state.done) return;
      if (step === null) turn(main, tx, running.state.counts);
      else running.state.done = cleared(tx, step, running.state.counts, main.now());
    },
  }],
  done(main, _tx, running) {
    main.log({ quiet: { ...running.state.counts } });
    if (!running.state.done) running.again = { at_ms: main.now(), lane: running.job.lane };
  },
};
