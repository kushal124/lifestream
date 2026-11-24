import type { OpenView } from "@lifestreamprotocol/core";
import { SCREEN_ACCOUNT } from "@lifestreamprotocol/families";
import type { MachineSources } from "./screen-source.js";

const SCREEN_FAMILY = "screen";
const A_PAGE = 32;

export interface SittingSpan {
  unit: string;
  start_ms: number;
  end_ms: number;
}

export interface MachineSitting extends SittingSpan {
  summarised: boolean;
}

export function firstMsOf(unit: string): number {
  return Number(unit.slice(unit.lastIndexOf("/") + 1));
}

const ownerOf = (unit: string): string => unit.slice(0, unit.lastIndexOf("/"));

export interface Sittings {
  holding(machine: string, day: string, from_ms: number, to_ms: number): SittingSpan[];
  reach(day: string, at_ms: number): number;
  machines(): readonly string[];
}

export class MachineSittings implements Sittings {
  readonly #view: OpenView;
  readonly #sources: MachineSources;
  readonly #days = new Map<string, MachineSitting[]>();

  constructor(view: OpenView, sources: MachineSources) {
    this.#view = view;
    this.#sources = sources;
  }

  holding(machine: string, day: string, from_ms: number, to_ms: number): SittingSpan[] {
    return this.#day(machine, day).filter((sitting) => sitting.start_ms <= to_ms && from_ms <= sitting.end_ms);
  }

  on(machine: string, day: string): readonly MachineSitting[] {
    return this.#day(machine, day);
  }

  machines(): readonly string[] {
    return this.#sources.machines();
  }

  reach(day: string, at_ms: number): number {
    return this.#sources.machines().reduce((most, machine) => this.holding(machine, day, at_ms, at_ms).reduce((end, sitting) => Math.max(end, sitting.end_ms + 1), most), at_ms);
  }

  #day(machine: string, day: string): MachineSitting[] {
    const key = `${machine}\u001f${day}`;
    const held = this.#days.get(key);
    if (held !== undefined) return held;
    const read: MachineSitting[] = [];
    const recorded = this.#sources.of(machine).length > 0;
    for (let after: string | null = null; recorded; ) {
      const rows = this.#view.extractPage(SCREEN_FAMILY, { day }, after === null ? null : { unit: after, start_ms: null }, A_PAGE);
      for (const row of rows) {
        if (row.start_ms === null || ownerOf(row.unit) !== machine) continue;
        const summarised = this.#view.enrichment(SCREEN_FAMILY, row.unit, SCREEN_ACCOUNT)?.state === "done";
        read.push({ unit: row.unit, start_ms: row.start_ms, end_ms: row.end_ms ?? row.start_ms, summarised });
      }
      if (rows.length < A_PAGE) break;
      after = rows.at(-1)!.unit;
    }
    this.#days.set(key, read);
    return read;
  }
}
