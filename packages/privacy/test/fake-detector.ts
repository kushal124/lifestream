import type { DetailType } from "@lifestreamprotocol/core";
import type { Detector, DetectorModel, DetectorState, FindFor, PassageMark } from "../detector.js";

export const MODEL: DetectorModel = { id: "fake-filter", file: "sha256:00", decode: "1" };

export interface FakeDetector extends Detector {
  readonly calls: string[][];
  readonly by: FindFor[];
  set(state: DetectorState): void;
  hold(): (lost?: Error) => void;
  fail(): void;
  spoil(bad: readonly unknown[]): void;
  unread(text: string): void;
}

export function fakeDetector(words: Readonly<Record<string, DetailType>>, model: DetectorModel = MODEL): FakeDetector {
  let state: DetectorState = { state: "ready", model };
  let held: Promise<void> | null = null;
  let failing = false;
  let spoiled: readonly unknown[] = [];
  const unreadable: string[] = [];
  const calls: string[][] = [];
  const by: FindFor[] = [];
  const pattern = Object.keys(words).length === 0 ? null : new RegExp(`(?<![\\p{L}\\p{N}])(?:${Object.keys(words).map((word) => word.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  const typeOf = new Map(Object.entries(words).map(([word, type]) => [word.toLowerCase(), type]));
  return {
    calls,
    by,
    state: () => state,
    set(next) {
      state = next;
      if (next.state === "ready") model = next.model;
    },
    hold() {
      let release!: (lost?: Error) => void;
      held = new Promise<void>((resolve, reject) => {
        release = (lost) => (lost === undefined ? resolve() : reject(lost));
      });
      held.catch(() => undefined);
      return (lost) => release(lost);
    },
    fail() {
      failing = true;
    },
    spoil(bad) {
      spoiled = bad;
    },
    unread(text) {
      unreadable.push(text);
    },
    async find(passages, placedFor) {
      const answering = model;
      calls.push([...passages]);
      by.push(placedFor ?? "hide");
      const holding = held;
      held = null;
      if (holding !== null) await holding;
      if (failing) {
        failing = false;
        throw new Error("the fake detector failed, as scripted");
      }
      const marks = passages.map((passage): PassageMark[] => pattern === null ? [] : [...passage.matchAll(pattern)].map((match) => ({ start: match.index, end: match.index + match[0].length, type: typeOf.get(match[0].toLowerCase())! })));
      const bad = spoiled as PassageMark[];
      spoiled = [];
      return { model: answering, marks: marks.map((found, index) => (unreadable.some((text) => passages[index]!.includes(text)) ? null : [...found, ...bad])) };
    },
  };
}
