import { join } from "node:path";
import { notNow, RETRY_SOON_S } from "./refusal.js";
import { ERASING_WORDS } from "./readers.js";

export class ErasableStreams {
  readonly #open = new Map<string, Set<Open>>();

  async send(from: StreamOf, send: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const key = keyOf(from);
    let close!: () => void;
    const open: Open = { cut: new AbortController(), done: new Promise<void>((resolve) => { close = resolve; }) };
    const held = this.#open.get(key) ?? new Set<Open>();
    this.#open.set(key, held.add(open));
    try {
      if (open.cut.signal.aborted) notNow("busy", ERASING_WORDS, RETRY_SOON_S);
      try {
        await send(open.cut.signal);
      } catch (error) {
        if (!open.cut.signal.aborted) throw error;
      }
    } finally {
      held.delete(open);
      if (held.size === 0 && this.#open.get(key) === held) this.#open.delete(key);
      close();
    }
  }

  async cut(removed: Removed): Promise<number> {
    const keys = removed.all === true ? [...this.#open.keys()]
      : [...new Set([...(removed.blobs ?? []).map((blob) => keyOf({ blob })), ...(removed.days ?? []).map((day) => keyOf({ day })), ...removed.people === true ? [keyOf({ people: true })] : []])];
    const open = keys.flatMap((key) => [...this.#open.get(key) ?? []]);
    for (const each of open) each.cut.abort(new Error("an erasure removes what this stream sends"));
    await Promise.all(open.map((each) => each.done));
    return open.length;
  }
}

export type StreamOf = { blob: string } | { day: string } | { people: true };

export interface Removed {
  blobs?: readonly string[];
  days?: readonly string[];
  people?: boolean;
  all?: boolean;
}

export const CUT_MOST = 10_000;

export const DOOR_LOCK = join("door", "streams.lock");

const keyOf = (from: StreamOf): string => ("blob" in from ? `blob ${from.blob}` : "day" in from ? `day ${from.day}` : "people");

interface Open {
  cut: AbortController;
  done: Promise<void>;
}
