import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { isSqliteError, sha256, type HomeFolder, type Json } from "@lifestreamprotocol/core";
import { FIND_PASSAGES } from "@lifestreamprotocol/model";
import { openMarks, passagesOf, type Detector, type DetectorModel, type Hider, type MarksStore, type PassageMark } from "@lifestreamprotocol/privacy";
import { errorText } from "./jobs.js";
import { readHome } from "./lifecycle.js";
import { busy, ScreenIndex } from "./screen-index.js";
import { SearchIndex, type Against, type Unmarked } from "./search-index.js";


export interface MarkingProgress {
  marked: number;
  total: number;
  line: string;
}

export interface MarkQueue {
  file: string;
  yields?: true;
  rests?: true;
  open(mode: "mark" | "read"): QueueFile | undefined;
}

export interface QueueFile {
  unmarked(against: Against & { model: string }, most: number): Unmarked[];
  marked(rows: readonly Pick<Unmarked, "of" | "n">[]): void;
  markCounts(against: Against): { entries: number; unmarked: number };
  close(): void;
}

export function searchQueue(folder: HomeFolder, file: string): MarkQueue {
  return { file, open: (mode) => (mode === "mark" ? SearchIndex.marking(folder, file) : SearchIndex.read(folder, file)) };
}

export function screenQueue(folder: HomeFolder, file: string, waitMs?: number): MarkQueue {
  return { file, yields: true, rests: true, open: (mode) => (mode === "mark" ? ScreenIndex.marking(folder, file) : ScreenIndex.read(folder, file, waitMs)) };
}

export interface MarkingInputs {
  queues: readonly MarkQueue[];
  hider: Pick<Hider, "mark">;
  detector: Pick<Detector, "state">;
  marks: Pick<MarksStore, "id" | "epoch" | "dropOthers">;
  chosen(): boolean;
  resting?: () => Promise<boolean>;
  log(line: Record<string, Json>): void;
  rest_ms?: number;
  look_ms?: number;
  now?: () => number;
}

export interface Marking {
  poke(): Promise<void>;
  stop(): Promise<void>;
}

const REST_MS = 60_000;
const LOOK_MS = 2_000;

export function openMarking(inputs: MarkingInputs): Marking {
  const now = inputs.now ?? Date.now;
  const restMs = inputs.rest_ms ?? REST_MS;
  const lookMs = inputs.look_ms ?? LOOK_MS;
  let running: Promise<void> | null = null;
  let stopped = false;
  let next = 0;
  let dropped: string | null = null;
  let wasBusy = "";
  let wasResting = false;

  async function run(): Promise<number> {
    let batches = 0;
    let entries = 0;
    let found = 0;
    const ended = (why: string, at: number, more: Record<string, Json> = {}): number => {
      if (batches > 0 || why !== "done") inputs.log({ marks: why, batches, entries, found, ...more });
      return at;
    };
    const held = new Map<MarkQueue, { file: QueueFile; dev: number; ino: number }>();
    const fileNow = (queue: MarkQueue): QueueFile | undefined => {
      const at = statSync(queue.file, { throwIfNoEntry: false });
      const kept = held.get(queue);
      if (kept !== undefined && at !== undefined && at.dev === kept.dev && at.ino === kept.ino) return kept.file;
      kept?.file.close();
      held.delete(queue);
      const file = at === undefined ? undefined : queue.open("mark");
      if (file !== undefined) held.set(queue, { file, dev: at!.dev, ino: at!.ino });
      return file;
    };
    const busy = new Set<MarkQueue>();
    const unrested = new Set<MarkQueue>();
    let rests: { now: boolean; at: number } | undefined;
    const resting = async (): Promise<boolean> => {
      if (inputs.resting === undefined) return true;
      if (rests === undefined || now() - rests.at >= restMs) rests = { now: await inputs.resting(), at: now() };
      return rests.now;
    };
    const onQueue = <T>(queue: MarkQueue, work: () => T): T | undefined => {
      try {
        return work();
      } catch (error) {
        if (!(queue.yields === true && isSqliteError(error) && error.code === "SQLITE_BUSY")) throw error;
        busy.add(queue);
        return undefined;
      }
    };
    try {
      for (;;) {
        if (batches > 0) await new Promise<void>((resolve) => setImmediate(resolve));
        if (stopped || !inputs.chosen()) return ended("done", now());
        const state = inputs.detector.state();
        if (state.state !== "ready") return ended("done", now());
        const model = markKey(state.model);
        const epoch = inputs.marks.epoch;
        let taken: Unmarked[] = [];
        let from: { queue: MarkQueue; file: QueueFile } | undefined;
        for (const queue of inputs.queues) {
          if (busy.has(queue) || unrested.has(queue)) continue;
          const read = onQueue(queue, () => {
            const file = fileNow(queue);
            return file === undefined ? undefined : { file, taken: batchOf(file.unmarked({ store: inputs.marks.id, model }, FIND_PASSAGES)) };
          });
          if (read === undefined || read.taken.length === 0) continue;
          if (queue.rests === true && !(await resting())) {
            unrested.add(queue);
            continue;
          }
          taken = read.taken;
          from = { queue, file: read.file };
          break;
        }
        if (from === undefined && busy.size === 0 && unrested.size > 0) {
          const at = now() + restMs;
          if (wasResting && batches === 0) return at;
          wasResting = true;
          return ended("resting", at);
        }
        if (from?.queue.rests === true) wasResting = false;
        if (from === undefined && busy.size > 0) {
          const which = [...busy].map((queue) => queue.file).join("\n");
          const at = now() + lookMs;
          if (which === wasBusy && batches === 0) return at;
          wasBusy = which;
          return ended("busy", at, { queues: [...busy].map((queue) => queue.file.split("/").at(-1)!) });
        }
        wasBusy = "";
        if (from === undefined) {
          if (dropped !== model) {
            const gone = await inputs.marks.dropOthers(state.model);
            dropped = model;
            if (gone > 0) inputs.log({ marks: "old model's rows dropped", rows: gone });
          }
          return ended("done", now() + lookMs);
        }
        const marked = await inputs.hider.mark(taken.flatMap((entry) => entry.texts), epoch);
        if ("wait" in marked) return ended("waiting", now(), { why: marked.wait });
        if ("again" in marked) return ended("again", now() + restMs, { why: marked.again });
        const settled = onQueue(from.queue, () => {
          from.file.marked(taken);
          return true;
        });
        if (settled === undefined) continue;
        batches += 1;
        entries += taken.length;
        found += marked.found;
      }
    } finally {
      for (const { file } of held.values()) file.close();
    }
  }

  return {
    poke() {
      if (running !== null) return running;
      if (stopped || now() < next) return Promise.resolve();
      running = run().then((at) => {
        next = at;
      }, (error: unknown) => {
        next = now() + restMs;
        if (!stopped) inputs.log({ marks: "failed", error: errorText(error) });
      }).finally(() => {
        running = null;
      });
      return running;
    },
    async stop() {
      stopped = true;
      await running;
    },
  };
}

export function markingProgress(queues: readonly MarkQueue[], marks: Pick<MarksStore, "id">, model: DetectorModel | null): MarkingProgress | null {
  const counts = { entries: 0, unmarked: 0 };
  for (const queue of queues) {
    try {
      const read = queue.open("read");
      if (read === undefined) continue;
      try {
        const each = read.markCounts({ store: marks.id, model: model === null ? null : markKey(model) });
        counts.entries += each.entries;
        counts.unmarked += each.unmarked;
      } finally {
        read.close();
      }
    } catch (error) {
      if (busy(error)) return null;
      throw error;
    }
  }
  const marked = counts.entries - counts.unmarked;
  const share = counts.entries === 0 ? 100 : Math.floor((marked * 100) / counts.entries);
  return { marked, total: counts.entries, line: `Marked ${share}% of your record` };
}

export function marksFileOf(root: string, machine: string): string {
  return join(machine, "privacy", readHome(root).id, "marks.db");
}

export function forgetMarks(folder: HomeFolder, file: string, texts: readonly string[]): number {
  if (!existsSync(file)) return 0;
  const store = openMarks(folder, file);
  try {
    return store.forget(texts.flatMap((text) => passagesOf(text).map((passage) => sha256(text.slice(passage.start, passage.end)))));
  } finally {
    store.close();
  }
}

export type ValueMarks = { marks: PassageMark[]; current: boolean } | "unmarked";

export function valueMarks(store: Pick<MarksStore, "read">, model: DetectorModel, values: readonly string[]): Map<string, ValueMarks> {
  const cut = new Map([...new Set(values)].map((value) => [value, passagesOf(value).map((passage) => ({ ...passage, digest: sha256(value.slice(passage.start, passage.end)) }))]));
  const kept = store.read([...new Set([...cut.values()].flat().map((passage) => passage.digest))], model);
  const answer = new Map<string, ValueMarks>();
  for (const [value, passages] of cut) {
    if (passages.some((passage) => !kept.has(passage.digest))) {
      answer.set(value, "unmarked");
      continue;
    }
    answer.set(value, {
      marks: passages.flatMap((passage) => kept.get(passage.digest)!.marks.map((mark) => ({ ...mark, start: passage.start + mark.start, end: passage.start + mark.end }))),
      current: passages.every((passage) => kept.get(passage.digest)!.current),
    });
  }
  return answer;
}

function markKey(model: DetectorModel): string {
  return JSON.stringify([model.id, model.file, model.decode]);
}

function batchOf(rows: readonly Unmarked[]): Unmarked[] {
  const taken: Unmarked[] = [];
  let passages = 0;
  for (const row of rows) {
    const more = row.texts.reduce((sum, text) => sum + passagesOf(text).length, 0);
    if (taken.length > 0 && passages + more > FIND_PASSAGES) break;
    taken.push(row);
    passages += more;
  }
  return taken;
}
