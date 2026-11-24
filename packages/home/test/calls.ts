import type { DaySettings, OpenView, Type } from "@lifestreamprotocol/core";
import type { Family, Networks } from "@lifestreamprotocol/families";
import type { Access } from "@lifestreamprotocol/privacy";
import { Call, type CallStores, type Reader } from "../call.js";
import type { Carries } from "../reads.js";
import { HomeFile } from "../home-file.js";
import type { PeopleMap } from "../counting.js";
import { screenHold, type Fresh, type HeldDays } from "../index-file.js";
import { openPrepared, PEOPLE, type PreparedRead } from "../prepared.js";
import { peopleMapOf } from "../people-search.js";
import { presenceAttached, type PresenceSource } from "../presence.js";
import type { SearchIndex } from "../search-index.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { dirname } from "node:path";

export interface CallOf {
  now_ms: number;
  epoch?: number | null;
  budget?: number;
  index?: SearchIndex | "none" | "busy";
  screen?: string | "none" | "busy";
  people?: PeopleMap;
  home?: string;
  peopleFile?: string;
  peopleTables?: Tables;
  places?: readonly { slug: string; name: string; days?: number }[];
  placesTables?: Tables;
  view?: OpenView;
  presence?: PresenceSource;
  settings?: DaySettings;
  chat?: (asked: string) => string;
  fresh?: (seq: number, held: HeldDays) => Fresh | undefined;
  asOf?: (seq: number, zone: string) => string | null;
  families?: readonly Family[];
  reader?: Reader;
  access?: Access;
  category?: (account: string) => Type | null;
  screenAccounts?: ReadonlyMap<string, readonly string[]>;
}

export type Tables = Readonly<Record<string, Readonly<Record<string, unknown>>>>;

function tablesOf(tables: Tables): PreparedRead {
  return {
    position: "0", db: undefined as never, etag: () => undefined, answer: () => undefined, value: <V>(table: string, key: string) => tables[table]?.[key] as V | undefined,
    rows: () => [], meta: () => undefined,
  };
}

function fileOf(value: unknown): PreparedRead {
  return {
    position: "0", db: undefined as never, etag: () => undefined, answer: () => undefined, value: <V>() => value as V, rows: () => [], meta: () => undefined,
  };
}

export function callOf(over: CallOf): Call {
  const stores: CallStores = {
    view: () => {
      if (over.view !== undefined) return { read: over.view, end: () => undefined };
      const held = over.home === undefined ? undefined : new HomeFile(openHomeFolder(dirname(over.home))).open();
      return held === undefined ? undefined : { read: held.view, end: held.end };
    },
    index: (within) => (over.index === undefined ? "none" : typeof over.index === "string" ? over.index : over.index.hold(presenceAttached(over.presence), within)),
    screen: () => (over.screen === undefined ? "none" : over.screen === "none" || over.screen === "busy" ? over.screen : screenHold(openHomeFolder(dirname(over.screen)), over.screen)),
    prepared: (which) => {
      if (which === "people" && over.peopleFile !== undefined) return openPrepared(openHomeFolder(dirname(over.peopleFile)), over.peopleFile, PEOPLE.format);
      if (which === "people" && over.peopleTables !== undefined) return { read: tablesOf(over.peopleTables), end: () => undefined };
      if (which === "places" && over.placesTables !== undefined) return { read: tablesOf(over.placesTables), end: () => undefined };
      if (which === "people") return over.people === undefined ? undefined : { read: fileOf(undefined), end: () => undefined };
      return over.places === undefined ? undefined : { read: fileOf({ places: over.places }), end: () => undefined };
    },
    damaged: () => undefined,
    presence: over.presence,
    peopleMap: (file) => (over.peopleFile === undefined && over.peopleTables === undefined ? over.people! : peopleMapOf(file)),
    labels: () => {
      throw new Error("a test's call reads no labels");
    },
    chat: (asked) => (over.chat ?? ((written: string) => written))(asked),
    settings: () => over.settings ?? { zone: "UTC", day_start_hour: 0 },
    families: over.families ?? [],
    networks: { of: () => undefined, products: [] } as unknown as Networks,
    screenAccounts: () => over.screenAccounts ?? new Map(),
    categories: () => over.category ?? (() => null),
  };
  const step: Carries = structuredClone(over.access === undefined ? {} : { access: over.access });
  const { fresh, asOf } = over;
  return new (class extends Call {
    override fresh(seq: number, held: HeldDays): Fresh | undefined {
      return fresh === undefined ? super.fresh(seq, held) : (this.index(), fresh(seq, held));
    }
    override asOf(seq: number, zone: string): string | null {
      return asOf === undefined ? super.asOf(seq, zone) : asOf(seq, zone);
    }
  })(stores, over.now_ms, over.epoch ?? null, over.budget ?? Infinity, new Set(), over.reader ?? "person", step.access, step.sealed);
}

export function onCall<T>(over: CallOf, work: (call: Call) => T): T {
  const call = callOf(over);
  let answer: T;
  try {
    answer = work(call);
  } catch (error) {
    call.end();
    throw error;
  }
  if (answer instanceof Promise) return answer.finally(() => call.end()) as T;
  call.end();
  return answer;
}
