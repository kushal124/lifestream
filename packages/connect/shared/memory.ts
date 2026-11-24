import { canonical, CURSOR_BYTES, parse, type JsonObject, type MemoryChanges, type MemoryEntry } from "@lifestreamprotocol/core";
import type { Memory } from "../seams.js";

export const LIST_LIMIT = 1_000;

export interface Remembered {
  get(part: string, key: string): string | undefined;
  after(part: string, after: string | null, limit: number): readonly (readonly [key: string, value: string])[];
}

export interface CallMemory extends Memory {
  end(): MemoryChanges;
}

interface Changed {
  cleared: boolean;
  keys: Map<string, string | null>;
}

export function callMemory(committed: Remembered | null): CallMemory {
  const parts = new Map<string, Changed>();
  let ended = false;

  function open(part: string, key?: string): void {
    if (ended) throw new Error("this call's memory has ended: a poll's memory is read and changed only during its call");
    if (!part.isWellFormed() || part === "") throw new TypeError(`a part of a poll's memory is a name: ${JSON.stringify(part)}`);
    if (key !== undefined && !key.isWellFormed()) throw new TypeError(`a key of a poll's memory is text: ${JSON.stringify(key)} has a lone surrogate`);
  }

  function changed(part: string): Changed {
    let held = parts.get(part);
    if (held === undefined) parts.set(part, (held = { cleared: false, keys: new Map() }));
    return held;
  }

  function text(part: string, key: string): string | undefined {
    const held = parts.get(part);
    if (held?.keys.has(key)) return held.keys.get(key) ?? undefined;
    return held?.cleared ? undefined : committed?.get(part, key);
  }

  function before(part: string, key: string): string | undefined {
    return parts.get(part)?.cleared ? undefined : committed?.get(part, key);
  }

  return {
    get(part, key) {
      open(part, key);
      const value = text(part, key);
      return value === undefined ? undefined : parse(value);
    },
    put(part, key, value) {
      open(part, key);
      const written = canonical(value);
      if (before(part, key) === written) changed(part).keys.delete(key);
      else changed(part).keys.set(key, written);
    },
    drop(part, key) {
      open(part, key);
      if (before(part, key) === undefined) parts.get(part)?.keys.delete(key);
      else changed(part).keys.set(key, null);
    },
    clear(part) {
      open(part);
      const held = changed(part);
      held.keys.clear();
      if (!held.cleared && (committed?.after(part, null, 1).length ?? 0) > 0) held.cleared = true;
    },
    list(part, after, limit = LIST_LIMIT) {
      open(part, after);
      if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`a list of a poll's memory asks for at least one entry: ${limit}`);
      const most = Math.min(limit, LIST_LIMIT);
      const held = parts.get(part);
      const found: (readonly [string, string])[] = [];
      if (committed !== null && held?.cleared !== true) {
        let from = after ?? null;
        for (;;) {
          const page = committed.after(part, from, most);
          for (const entry of page) if (held?.keys.has(entry[0]) !== true) found.push(entry);
          if (found.length >= most || page.length < most) break;
          from = page[page.length - 1]![0];
        }
      }
      for (const [key, value] of held?.keys ?? []) {
        if (value !== null && (after === undefined || byBytes(key, after) > 0)) found.push([key, value]);
      }
      return found.sort(([a], [b]) => byBytes(a, b)).slice(0, most).map(([key, value]) => [key, parse(value)] as const);
    },
    end() {
      ended = true;
      const names = [...parts.keys()].sort(byBytes);
      return {
        cleared: names.filter((part) => parts.get(part)!.cleared),
        entries: names.flatMap((part) =>
          [...parts.get(part)!.keys].sort(([a], [b]) => byBytes(a, b)).map(([key, value]): MemoryEntry => [part, key, value])),
      };
    },
  };
}

export function byBytes(a: string, b: string): number {
  const length = Math.min(a.length, b.length);
  for (let at = 0; at < length; at += 1) {
    const x = a.charCodeAt(at);
    const y = b.charCodeAt(at);
    if (x !== y) return codePointRank(x) - codePointRank(y);
  }
  return a.length - b.length;
}

function codePointRank(unit: number): number {
  if (unit >= 0xe000) return unit - 0x800;
  if (unit >= 0xd800) return unit + 0x2000;
  return unit;
}

export function cursorText(state: JsonObject): string {
  const text = canonical(state);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CURSOR_BYTES) {
    throw new Error(
      `the cursor is ${bytes} bytes, over its bound of ${CURSOR_BYTES}: a field whose size follows how many items the provider holds, ` +
        "or how many a call read, belongs in the poll's memory (lent.memory, packages/connect/SKILL.md)",
    );
  }
  return text;
}
