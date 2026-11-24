import type { HomeFolder } from "@lifestreamprotocol/core";
import type { Index, IndexCursor } from "./index-file.js";
import type { Kind, Running } from "./jobs.js";
import type { MarkQueue } from "./marking.js";
import { SCREEN_INDEX } from "./screen-job.js";
import { RECORD_INDEX } from "./search.js";


export const INDEXES: readonly Index[] = [RECORD_INDEX as Index, SCREEN_INDEX as Index];

export function indexNamed(name: string): Index | undefined {
  return INDEXES.find((index) => index.name === name);
}

export function markingQueues(folder: HomeFolder, machine: string): MarkQueue[] {
  return INDEXES.map((index) => index.unmarked(folder, machine));
}

interface IndexData {
  cursor: IndexCursor;
}

interface IndexRunState {
  generation: number;
}

function indexOf(key: string): Index {
  const index = indexNamed(key);
  if (index === undefined) throw new Error(`no index ${key}`);
  return index;
}

function current(cursor: { generation: number } | undefined, running: Running<IndexRunState>): boolean {
  if ((cursor?.generation ?? 0) === running.state.generation) return true;
  running.stale = true;
  return false;
}

export const indexKind: Kind<IndexData, IndexCursor, unknown, IndexRunState> = {
  dies: true,
  helper: (env, task) => indexOf(task.key).take(env, task.data.cursor),
  begin(_main, tx, job) {
    const cursor = tx.tables.cursors.get(indexOf(job.key).name);
    return { data: { cursor: { seq: cursor?.seq ?? 0, reread: cursor?.reread ?? 0 } }, state: { generation: cursor?.generation ?? 0 } };
  },
  chunk(main, running, chunk) {
    const name = indexOf(running.job.key).name;
    return [{
      work(tx) {
        if (!current(tx.tables.cursors.get(name), running)) return;
        tx.tables.cursors.move(name, { seq: chunk.seq, reread: chunk.reread, at_ms: main.now() });
      },
    }];
  },
  done(main, tx, running, result) {
    const index = indexOf(running.job.key);
    if (!current(tx.tables.cursors.get(index.name), running)) return;
    const now = main.now();
    const settled = index.settled(result);
    const wakes = [
      ...(settled.more ? [now] : []),
      ...(settled.again_in_ms === null ? [] : [now + settled.again_in_ms]),
      ...(settled.again_at_ms === null ? [] : [Math.max(settled.again_at_ms, now)]),
    ];
    if (wakes.length > 0) running.again = { at_ms: Math.min(...wakes), lane: running.job.lane };
    if (settled.counts === null) return;
    const run = tx.tables.runs.start({ kind: "index", subject: index.name, started_ms: running.job.started_ms ?? now });
    tx.tables.runs.end(run, { ended_ms: now, outcome: "ok", counts: settled.counts });
  },
};
