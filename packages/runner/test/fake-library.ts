import { createHash } from "node:crypto";
import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
import type { DetailType } from "@lifestreamprotocol/core";
import { embedAskOf, findPassages, type FindAnswer, type FindMark } from "@lifestreamprotocol/model";
import { embedAnswer } from "../embed.js";
import type { Row } from "../files.js";
import { Failed, type Library } from "../library.js";

export interface FakeScript {
  readonly words?: Readonly<Record<string, DetailType>>;
  readonly hold?: string;
  readonly unread?: string;
  readonly fetching?: string;
}

export function playedVector(text: string, dimensions: number): number[] {
  const values: number[] = [];
  for (let block = 0; values.length < dimensions; block++) {
    const hash = createHash("sha256").update(`${block}\n${text}`).digest();
    for (let at = 0; at < hash.length && values.length < dimensions; at++) values.push(hash[at]! / 127.5 - 1);
  }
  return values;
}

const held = (signal: AbortSignal): Promise<never> => new Promise((_, reject) => {
  signal.throwIfAborted();
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

function arrival(path: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const watcher = watch(dirname(path), () => {
      if (existsSync(path)) done();
    });
    const stop = (): void => {
      watcher.close();
      reject(signal.reason);
    };
    const done = (): void => {
      watcher.close();
      signal.removeEventListener("abort", stop);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
    if (existsSync(path)) done();
  });
}

export function fakeLibrary(script: FakeScript = {}): Library {
  const words = Object.keys(script.words ?? {});
  const pattern = words.length === 0 ? null
    : new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const typeOf = new Map(Object.entries(script.words ?? {}).map(([word, type]) => [word.toLowerCase(), type]));
  const marksOf = (passage: string): FindMark[] => pattern === null ? []
    : [...passage.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length, type: typeOf.get(match[0].toLowerCase())! }));
  return {
    async fetch(row: Row, progress, signal) {
      if (script.fetching === undefined) return;
      progress(Math.floor(row.bytes / 2));
      await arrival(script.fetching, signal);
    },
    remove: async () => undefined,
    async run(row, call, signal) {
      if (call.warm === true) return { text: "", model: row.id };
      if (row.library === "ollama" && row.embed !== undefined) {
        const ask = embedAskOf(call.input);
        if (ask === null || call.attachments.length > 0) throw new Failed("failed", `${row.id} embeds texts alone, and the call is no embedding`);
        const { dimensions, prompts } = row.embed;
        return { text: embedAnswer(ask.texts.map((text) => playedVector(prompts[ask.role] + text, dimensions)), dimensions), model: row.id };
      }
      if (row.library !== "detector") return call.input === "hold" ? held(signal) : { text: `seen: ${call.input}`, model: call.model };
      const passages = findPassages(call.input);
      if (passages === null) throw new Failed("unreadable", `${row.id} finds in a list of passages, and the call's input is none`);
      if (script.hold !== undefined && passages.some((passage) => passage.includes(script.hold!))) return held(signal);
      const found: FindAnswer = { file: row.key.file, decode: row.key.decode, marks: passages.map((passage) => (script.unread !== undefined && passage.includes(script.unread) ? null : marksOf(passage))) };
      return { text: JSON.stringify(found), model: row.id };
    },
    close: async () => undefined,
  };
}
