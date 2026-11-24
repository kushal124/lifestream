import type { JsonObject } from "@lifestreamprotocol/core";
import { errorText } from "./jobs.js";
import { ask, NoHomeError, type HomeSocket } from "./socket.js";

const NUDGE_ANSWER_MS = 10_000;
const NUDGE_FIRST_MS = 1_000;
const NUDGE_LAST_MS = 60_000;
export const NUDGES_OWED = 256;

export interface Nudges {
  owe(id?: string): void;
  owing(): (string | null)[];
  close(): void;
}

export function nudges(socket: HomeSocket, log: (line: JsonObject) => void, answerMs = NUDGE_ANSWER_MS, firstMs = NUDGE_FIRST_MS): Nudges {
  const owed = new Map<string, { tries: number; error: string | null; at_ms: number; sending: AbortController | null; again: boolean }>();
  const LOOK = "";
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  type Owed = typeof owed extends Map<string, infer T> ? T : never;
  const said = (state: string, key: string, each: Owed, error?: string) =>
    log({ nudge: state, delivery: key === LOOK ? null : key, tries: each.tries, ...(error === undefined ? {} : { error }) });
  const arm = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed) return;
    let next = Infinity;
    for (const each of owed.values()) if (!each.sending) next = Math.min(next, each.at_ms);
    if (next !== Infinity) timer = setTimeout(due, Math.max(0, next - Date.now()));
  };
  const due = () => {
    timer = undefined;
    const now = Date.now();
    for (const [key, each] of owed) if (!each.sending && each.at_ms <= now) send(key, each);
    arm();
  };
  const drop = (key: string) => {
    owed.get(key)?.sending?.abort();
    owed.delete(key);
  };
  const send = (key: string, each: Owed) => {
    const sending = new AbortController();
    each.sending = sending;
    each.again = false;
    each.tries++;
    ask(socket, { verb: "sealed", ...(key === LOOK ? {} : { delivery: key }) }, undefined, answerMs, sending.signal).then(() => {
      if (sending.signal.aborted) return;
      if (each.tries > 1) said("answered", key, each);
      owed.delete(key);
      if (each.again) start(key);
    }, (error: unknown) => {
      if (sending.signal.aborted) return;
      each.sending = null;
      if (error instanceof NoHomeError && error.absent) {
        if (each.tries > 1) said("dropped", key, each, errorText(error));
        owed.delete(key);
        return;
      }
      const text = errorText(error);
      if (each.tries === 1 || text !== each.error) said("failed", key, each, text);
      each.error = text;
      each.at_ms = Date.now() + Math.min(NUDGE_LAST_MS, firstMs * 2 ** (each.tries - 1));
      arm();
    });
  };
  const start = (key: string) => {
    const each = { tries: 0, error: null, at_ms: Date.now(), sending: null, again: false };
    owed.set(key, each);
    send(key, each);
  };
  const owe = (id?: string): void => {
    if (closed) return;
    const key = id ?? LOOK;
    const held = owed.get(key);
    if (held !== undefined) {
      if (held.sending) held.again = true;
      return;
    }
    if (key !== LOOK && owed.size - (owed.has(LOOK) ? 1 : 0) >= NUDGES_OWED) {
      for (const each of [...owed.keys()]) if (each !== LOOK) drop(each);
      arm();
      owe();
      return;
    }
    start(key);
  };
  return {
    owe,
    owing: () => [...owed.keys()].map((key) => (key === LOOK ? null : key)),
    close() {
      closed = true;
      for (const key of [...owed.keys()]) drop(key);
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
