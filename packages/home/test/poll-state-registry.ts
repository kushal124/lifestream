import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, parse, type JsonObject } from "@lifestreamprotocol/core";
import { callMemory, stations, type Acquirer, type Lent, type Memory, type Stations } from "@lifestreamprotocol/connect";
import { admittedSet, declaredOf } from "../folders.js";
import { acquirers, connectorsWith, feedersOf } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";

export const CALLS_FILE = "poll-state-calls.jsonl";

export interface CallLine {
  call: "fetch" | "page";
  errand: string | null;
  cursor_bytes: number | null;
  changed: Record<string, { added: number; changed: number; dropped: number; cleared?: true }>;
  entries: Record<string, number>;
  threw?: string;
}

function countOf(memory: Memory, part: string): number {
  let count = 0;
  let after: string | undefined;
  for (;;) {
    const page = memory.list(part, after);
    count += page.length;
    if (page.length < 1_000) return count;
    after = page[page.length - 1]![0];
  }
}

function recorded(acquirer: Acquirer, folder: string): Acquirer {
  const run = async <T extends { state: JsonObject }>(call: CallLine["call"], lent: Lent, make: (lent: Lent) => Promise<T>): Promise<T> => {
    const outer = lent.memory;
    const inner = callMemory({
      get: (part, key) => {
        const value = outer.get(part, key);
        return value === undefined ? undefined : canonical(value);
      },
      after: (part, after, limit) => outer.list(part, after ?? undefined, limit).map(([key, value]) => [key, canonical(value)] as const),
    });
    let errand: string | null = null;
    const ran: Stations = { using: (spec, body) => lent.stations.using(spec, (begun) => {
      errand = begun.id;
      return body(begun);
    }) };
    const ended = (state: JsonObject | undefined, threw?: string): void => {
      const { cleared, entries } = inner.end();
      const changed: CallLine["changed"] = {};
      const of = (part: string) => (changed[part] ??= { added: 0, changed: 0, dropped: 0 });
      for (const part of cleared) {
        of(part).cleared = true;
        outer.clear(part);
      }
      for (const [part, key, value] of entries) {
        const had = outer.get(part, key) !== undefined;
        if (value === null) {
          of(part).dropped++;
          outer.drop(part, key);
        } else {
          of(part)[had ? "changed" : "added"]++;
          outer.put(part, key, parse(value));
        }
      }
      const line: CallLine = {
        call, errand, cursor_bytes: state === undefined ? null : Buffer.byteLength(canonical(state), "utf8"), changed,
        entries: Object.fromEntries(Object.keys(changed).map((part) => [part, countOf(outer, part)])), ...(threw === undefined ? {} : { threw }),
      };
      appendFileSync(join(folder, CALLS_FILE), `${JSON.stringify(line)}\n`);
    };
    try {
      const answer = await make({ ...lent, memory: inner, stations: ran });
      ended(answer.state);
      return answer;
    } catch (error) {
      const state = (error as { state?: JsonObject } | null)?.state;
      ended(state, String(error));
      throw error;
    }
  };
  return {
    ...acquirer,
    fetch: (state, secrets, lent) => run("fetch", lent, (lending) => acquirer.fetch(state, secrets, lending)),
    ...(acquirer.page === undefined ? {} : { page: (state, secrets, lent) => run("page", lent, (lending) => acquirer.page!(state, secrets, lending)) }),
  };
}

export default async function registry(settings: Settings, home: RegistryHome): Promise<Registry> {
  const folder = home.root;
  const own = (await admittedSet(folder)).filter((each) => each.whose === "home").map((each) => each.entry);
  const declared = declaredOf(own);
  const factories: Record<string, (settings: never) => Acquirer> = {};
  for (const [name, make] of own.flatMap((entry) => Object.entries(entry.acquirers ?? {}))) factories[name] = (each: never) => recorded(make(each), folder);
  return {
    connectors: connectorsWith(declared), readers: [...own.flatMap((entry) => entry.readers), ...stations.readers], feeders: feedersOf(declared), families: [],
    acquirers: acquirers(declared, factories, settings, home),
  };
}
