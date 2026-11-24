import type { Chunk } from "@lifestreamprotocol/core";
import type { Kind } from "./jobs.js";

export const TALLY_KEY = "start-minutes";
const HANDED = 64;

export const tallyKind: Kind<Chunk[], Chunk[], undefined, undefined> = {
  dies: true,
  begin(main, tx) {
    const mark = tx.tally.mark();
    if (mark !== null && "complete" in mark) return null;
    const chunks = tx.tally.chunks(main.settings.day);
    if (chunks.length === 0) {
      tx.tally.complete();
      return null;
    }
    return { data: chunks, state: undefined };
  },
  async *helper(_env, task) {
    for (let at = 0; at < task.data.length; at += HANDED) yield task.data.slice(at, at + HANDED);
    return undefined;
  },
  chunk: (_main, _running, chunks) => chunks.map((chunk) => ({ work: (tx) => tx.tally.rebuild(chunk) })),
  done(_main, tx) {
    tx.tally.complete();
  },
};

export const HELD_KEY = "live";
const HELD_META = "held:live";
const TURNS = 64;

export const heldKind: Kind<undefined, true, undefined, { done: boolean }> = {
  dies: true,
  begin(_main, tx) {
    const mark = tx.records.heldMark();
    return mark !== null && "complete" in mark ? null : { data: undefined, state: { done: false } };
  },
  async *helper(env) {
    for (let turn = 0; turn < TURNS; turn++) {
      yield true;
      await env.committed();
      const view = env.db.view();
      try {
        const raw = view.tables.meta.get(HELD_META);
        const mark = raw === undefined ? null : JSON.parse(raw) as { complete?: string };
        if (mark !== null && "complete" in mark) return undefined;
      } finally {
        view.close();
      }
    }
    return undefined;
  },
  chunk: (_main, running) => running.state.done ? [] : [{
    work: (tx) => {
      if (tx.records.fillHeld()) running.state.done = true;
    },
  }],
  done(main, tx, running) {
    const mark = tx.records.heldMark();
    if (mark === null || !("complete" in mark)) running.again = { at_ms: main.now(), lane: running.job.lane };
  },
};

export const LEFT_KEY = "asks";

export const leftKind: Kind<undefined, true, undefined, { done: boolean }> = {
  dies: true,
  begin(_main, tx) {
    return tx.tables.asks.filling() ? { data: undefined, state: { done: false } } : null;
  },
  async *helper(env) {
    for (let turn = 0; turn < TURNS; turn++) {
      yield true;
      await env.committed();
      const view = env.db.view();
      try {
        if (!view.tables.asks.filling()) return undefined;
      } finally {
        view.close();
      }
    }
    return undefined;
  },
  chunk: (_main, running) => running.state.done ? [] : [{
    work: (tx) => {
      if (tx.tables.asks.fill()) running.state.done = true;
    },
  }],
  done(main, tx, running) {
    if (tx.tables.asks.filling()) running.again = { at_ms: main.now(), lane: running.job.lane };
  },
};
