import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  canonical, sha256, tally, type BlobReader, type Json, type Landed, type PlanTally, type Projection, type ReadTables, type RepairAt, type RepairPlan,
  type RepairStep, type Tx, type Version,
} from "@lifestreamprotocol/core";
import { failpoint } from "./failpoint.js";
import { hookModule } from "./folders.js";
import { LANE, type HelperEnv, type Kind, type Slice, type Task } from "./jobs.js";
import { forgetPeopleUndo } from "./people-draft.js";
import { sdkModule } from "./programs.js";


export type Fix = (head: Version, files: BlobReader) => Projection | "gone" | "keep";

export interface FixModule {
  path: string;
  sha256: string;
}

export type RepairSettings =
  | { source: string; kinds: string[]; reason: string; fix: FixModule; at: RepairAt | null }
  | { undo: number; through: number; at: number };

export type RunCounts = PlanTally["counts"] & { refusals: Landed["refusals"] };

const RUN_MS = 60_000;
const SLICE_MS = 100;
const REFUSALS = 10;

function settingsKey(run: number): string {
  return `repair:${run}`;
}

export function repairUnderWay(tables: Pick<ReadTables, "meta">, run: number): RepairSettings | undefined {
  const text = tables.meta.get(settingsKey(run));
  return text === undefined ? undefined : (JSON.parse(text) as RepairSettings);
}

function writeSettings(tx: Tx, run: number, settings: RepairSettings): void {
  tx.tables.meta.set(settingsKey(run), canonical(settings as unknown as Json));
}

export function queueRepair(tx: Tx, now: number, run: { kind: "repair" | "undo"; subject: string }, settings: RepairSettings): number {
  const id = tx.tables.runs.start({ kind: run.kind, subject: run.subject, started_ms: now });
  writeSettings(tx, id, settings);
  tx.tables.runs.count(id, { counts: emptyCounts(), changed_paths: {} });
  tx.tables.jobs.enqueue({ kind: "repair", key: String(id), lane: LANE.backfill, not_before_ms: now, now_ms: now });
  return id;
}

function touchesPeople(tx: Tx, settings: RepairSettings): boolean {
  let subject = "source" in settings ? settings.source : tx.tables.runs.get(settings.undo)?.subject;
  const seen = new Set<string>();
  while (subject !== undefined && /^run \d+$/u.test(subject) && !seen.has(subject)) {
    seen.add(subject);
    subject = tx.tables.runs.get(Number(subject.slice("run ".length)))?.subject;
  }
  return subject?.split(" ")[0]?.startsWith("people:") === true;
}

export function stopRepair(tx: Tx, run: number, now: number, why: string): boolean {
  if (repairUnderWay(tx.tables, run) === undefined) return false;
  tx.tables.meta.delete(settingsKey(run));
  const row = tx.tables.runs.get(run);
  tx.tables.runs.end(run, { ended_ms: now, outcome: "failed", error: why, ...(row?.counts == null ? {} : { counts: row.counts }), ...(row?.changed_paths == null ? {} : { changed_paths: row.changed_paths }) });
  const job = tx.tables.jobs.get("repair", String(run));
  if (job !== undefined && job.state !== "running" && job.state !== "done") tx.tables.jobs.finish(job.id, now);
  return true;
}

export async function readFix(path: string): Promise<FixModule & { fix: Fix }> {
  const module = { path, sha256: sha256(readFileSync(path)) };
  return { ...module, fix: await loadFix(module) };
}

async function loadFix(module: FixModule): Promise<Fix> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(module.path);
  } catch (error) {
    throw new Error(`the fix module ${module.path} cannot be read (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}): put it back, or undo the run`);
  }
  const now = sha256(bytes);
  if (now !== module.sha256) {
    throw new Error(`the fix module ${module.path} is not the one the repair began with (${module.sha256}, now ${now}): put that one back, or undo the run`);
  }
  hookModule(module.path, sdkModule());
  const loaded = (await import(`${pathToFileURL(module.path).href}?${now.slice("sha256:".length)}`)) as { fix?: unknown; default?: unknown };
  const fix = loaded.fix ?? loaded.default;
  if (typeof fix !== "function") throw new Error(`${module.path} exports no fix function`);
  return fix as Fix;
}

function emptyCounts(): RunCounts {
  return { heads: 0, changed: 0, gone: 0, kept: 0, moved: 0, refused: 0, refusals: [] };
}

interface RepairData {
  run: number;
  settings: RepairSettings;
}

interface RepairChunk {
  steps: RepairStep[];
  next: unknown;
}

interface RepairState {
  run: number;
  counts: RunCounts;
  changedPaths: Record<string, number>;
  sliceFixes: number;
}

async function* repairHelper(env: HelperEnv, task: Task<RepairData>): AsyncGenerator<RepairChunk, { more: boolean }, undefined> {
  const { run, settings } = task.data;
  const fix = "undo" in settings ? undefined : await loadFix(settings.fix);
  const began = performance.now();
  let at: unknown = settings.at;
  for (;;) {
    const view = env.db.view();
    let page: RepairPlan;
    try {
      page = "undo" in settings
        ? view.planUndo(settings.undo, { through: settings.through, after: at as number, by: run })
        : view.planRepair({ source: settings.source, kinds: settings.kinds, run, fix: (head) => fix!(head, env.blobs) }, at as RepairAt | null);
    } finally {
      view.close();
    }
    yield { steps: page.steps, next: page.next };
    if (page.next === null) return { more: false };
    at = page.next;
    if (performance.now() - began >= RUN_MS) return { more: true };
  }
}

export const repairKind: Kind<RepairData, RepairChunk, { more: boolean }, RepairState> = {
  dies: true,
  helper: repairHelper,
  begin(_main, tx, job) {
    const run = Number(job.key);
    const settings = repairUnderWay(tx.tables, run);
    if (settings === undefined) return null;
    const row = tx.tables.runs.get(run);
    if (row === undefined) throw new Error(`no run ${run}`);
    tx.tables.runs.resume(run);
    return {
      data: { run, settings },
      state: { run, counts: (row.counts as RunCounts | null) ?? emptyCounts(), changedPaths: (row.changed_paths as Record<string, number> | null) ?? {}, sliceFixes: 100 },
    };
  },
  chunk(main, running, chunk) {
    const { state } = running;
    const { steps } = chunk;
    const slices: Slice[] = [];
    for (let start = 0; start < steps.length;) {
      let end = start;
      let fixes = 0;
      while (end < steps.length && (fixes < state.sliceFixes || !("fix" in steps[end]!))) {
        if ("fix" in steps[end]!) fixes++;
        end++;
      }
      const part = steps.slice(start, end);
      const at = end === steps.length ? chunk.next ?? part.at(-1)!.at : part.at(-1)!.at;
      start = end;
      slices.push({
        work(tx) {
          const settings = repairUnderWay(tx.tables, state.run);
          if (settings === undefined) {
            running.stale = true;
            return;
          }
          const began = performance.now();
          const landed = tx.records.applyRepair(state.run, { steps: part }, main.blobs);
          if (fixes > 0 && touchesPeople(tx, settings)) forgetPeopleUndo(tx);
          if (fixes > 0) {
            const perFix = (performance.now() - began) / fixes;
            state.sliceFixes = Math.max(10, Math.min(5_000, Math.round(0.7 * state.sliceFixes + 0.3 * (SLICE_MS / Math.max(perFix, 0.001)))));
          }
          add(state, tally(part), landed);
          tx.tables.runs.count(state.run, { counts: state.counts, changed_paths: state.changedPaths });
          writeSettings(tx, state.run, { ...settings, at } as RepairSettings);
        },
        after: () => failpoint("repair.slice"),
      });
    }
    return slices;
  },
  done(main, tx, running, result) {
    const { state } = running;
    if (repairUnderWay(tx.tables, state.run) === undefined) return;
    const now = main.now();
    if (result.more) {
      running.again = { at_ms: now, lane: running.job.lane };
      return;
    }
    tx.tables.runs.end(state.run, { ended_ms: now, outcome: "ok", counts: state.counts, changed_paths: state.changedPaths });
    tx.tables.meta.delete(settingsKey(state.run));
    const row = tx.tables.runs.get(state.run)!;
    const { refusals: _refusals, ...counts } = state.counts;
    tx.tables.events.append({ at_ms: now, kind: row.kind, key: row.subject, detail: { run: state.run, ...counts } });
  },
  failed(main, tx, job, state, error) {
    const run = Number(job.key);
    if (repairUnderWay(tx.tables, run) === undefined) return;
    const row = tx.tables.runs.get(run);
    if (row === undefined) return;
    const counts = state?.counts ?? row.counts;
    const changed = state?.changedPaths ?? row.changed_paths;
    tx.tables.runs.end(run, { ended_ms: main.now(), outcome: "failed", error, ...(counts == null ? {} : { counts: counts }), ...(changed == null ? {} : { changed_paths: changed }) });
  },
};

function add(state: RepairState, read: PlanTally, landed: Landed): void {
  const { counts } = state;
  counts.heads += read.counts.heads;
  counts.kept += read.counts.kept;
  counts.moved += read.counts.moved;
  counts.changed += landed.changed;
  counts.gone += landed.gone;
  counts.refused += read.counts.refused + landed.refused;
  for (const refusal of [...read.refusals, ...landed.refusals]) if (counts.refusals.length < REFUSALS) counts.refusals.push(refusal);
  for (const [path, count] of Object.entries(landed.changedPaths)) state.changedPaths[path] = (state.changedPaths[path] ?? 0) + count;
}
