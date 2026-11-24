import { accountOf, addDays, civilDay, digest, type DaySettings, type OpenView, type RecordRef, type Type } from "@lifestreamprotocol/core";
import { findPeople, handleOfId, searchedBy, spelledId, type Family, type Labels, type Networks, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { compile, decide, earliest, type Access, type Gate, type Thing, type Why } from "@lifestreamprotocol/privacy";
import { PeopleCounts, type CountContext, type PeopleMap, type PeopleShown, type ShownPerson } from "./counting.js";
import { asOfIn, freshOf, type Fresh, type HeldDays, type ScreenRead } from "./index-file.js";
import { namesOf } from "./people.js";
import { sealedPeople, type SealedPeople } from "./people-search.js";
import { damaged, type PreparedRead } from "./prepared.js";
import { presenceIn, presenceOver, type Presence, type PresenceSource, type PresenceTables } from "./presence.js";
import { personRef } from "./refs.js";
import { refused, type Building } from "./refusal.js";
import type { SearchGate } from "./record-search.js";
import type { FactsRead, RecordRead } from "./search-index.js";
import { ALWAYS, collectionsOf, notBuilding } from "./count.js";
import { READ_TOO_BROAD, Work } from "./work.js";

export type Store = "view" | "index" | "screen" | "people" | "places" | "after";

interface Held<T> {
  read: T;
  end(): void;
}

export interface CallStores {
  view(): Held<OpenView> | undefined;
  index(within: Work): Held<RecordRead> | "none" | "busy";
  screen(): Held<ScreenRead> | "none" | "busy";
  prepared(which: "people" | "places"): Held<PreparedRead> | undefined;
  damaged(which: "people" | "places"): void;
  readonly presence: PresenceSource | undefined;
  peopleMap(file: PreparedRead): PeopleMap;
  labels(view: OpenView): Labels;
  chat(asked: string, labels: () => Labels): string;
  settings(): DaySettings;
  readonly families: readonly Family[];
  readonly networks: Networks;
  screenAccounts(view: () => OpenView): ReadonlyMap<string, readonly string[]>;
  categories(view: () => OpenView): (account: string) => Type | null;
}

export class StoreDamaged extends Error {
  constructor(readonly which: "people" | "places", cause: unknown) {
    super(`${which}'s file is damaged`, { cause });
  }
}

export type Reader = "person" | "model";

export const READER_HEADER = "lifestream-reader";

export const ANSWER_CHARS: Readonly<Record<Reader, number>> = { model: 20_000, person: 64_000 };

const LISTING = "The home is listing its days: try again in a moment.";
export const OUTSIDE_WORDS = "Outside your access.";

export function outsideAccess(): never {
  return refused("OUTSIDE_ACCESS", OUTSIDE_WORDS);
}

export function chatUnknown(): never {
  return refused("BAD_PARAMETER", "`chat` names no chat the home holds now. Find it with `search_people`.");
}

export function tooBroad(): never {
  return refused("TOO_BROAD", READ_TOO_BROAD);
}

export type WithheldBy = Partial<Record<Exclude<Why, "allowed">, number>>;

export interface KeptOut {
  by: WithheldBy;
  capped: boolean;
}

export type ServedRef = (ref: string) => boolean;

export class Call implements SearchGate, PeopleShown {
  readonly meter: Work;
  readonly row = ALWAYS;
  readonly log: { screen_ms?: number; withheld?: KeptOut } = {};
  readonly gate: Gate | undefined;
  readonly #withheld: WithheldBy = {};
  #capped = false;
  #quiet = false;
  #counts: PeopleCounts | undefined;
  readonly #shown = new Map<string, ShownPerson>();
  readonly opens = new Map<Store, number>();
  readonly #ends: (() => void)[] = [];
  readonly #held = new Map<Store, unknown>();
  #after: OpenView | undefined;
  #where: { at: Presence | undefined } | undefined;
  #presence: PresenceSource | undefined;
  #judged: { whole: Presence; kept: Presence; withheld: PresenceTables["pieces"] } | undefined;
  #map: { people: PeopleMap | undefined } | undefined;
  #labels: Labels | undefined;
  #category: ((account: string) => Type | null) | undefined;
  readonly #floors = new Map<string | null, number | null | undefined>();

  readonly #stores: CallStores;

  constructor(
    stores: CallStores,
    readonly now_ms: number,
    readonly epoch: number | null,
    budget: number,
    readonly missing: ReadonlySet<"people" | "places"> = new Set(),
    readonly reader: Reader = "person",
    access?: Access,
    readonly sealed?: SealedPeople,
  ) {
    this.#stores = stores;
    this.meter = new Work(budget);
    this.gate = access === undefined ? undefined : compile(access, now_ms, (account) => (this.#category ??= stores.categories(() => this.view()))(account)) ?? undefined;
  }

  judge(thing: Thing | null, tally: boolean): boolean {
    const { allowed, why } = decide(this.gate!, thing);
    if (!allowed && tally && why !== "allowed") this.#count(why, 1);
    return allowed;
  }

  #count(why: Exclude<Why, "allowed">, n: number): void {
    if (!this.#quiet) this.#withheld[why] = (this.#withheld[why] ?? 0) + n;
  }

  allows(stated: string | null, start_ms: number | null, tally: boolean): boolean {
    const accounts = accountsIn(stated);
    const floor = this.floorOf(stated);
    const allowed = floor === null || (floor !== undefined && start_ms !== null && start_ms >= floor);
    if (!allowed && tally) this.judge(stated === null ? null : { accounts, start_ms }, true);
    return allowed;
  }

  serves(accounts: readonly string[], start_ms: number | null): boolean {
    return this.gate === undefined || this.judge({ accounts, start_ms }, true);
  }

  servesRecord(record: Pick<RecordRef, "source">, start_ms: number | null): boolean {
    return this.serves([accountOf(record.source)], start_ms);
  }

  servesScreen(machine: string, at_ms: number): boolean {
    return this.serves(this.gate === undefined ? [] : this.screenAccounts().get(machine) ?? [], at_ms);
  }

  guard(refs: readonly string[], served: ServedRef): void {
    if (this.gate === undefined) return;
    this.#quiet = true;
    try {
      for (const given of refs) if (!served(given)) throw new Error(`a withheld ref left the engine: ${given}`);
    } finally {
      this.#quiet = false;
    }
  }

  quietly<T>(run: () => T): T {
    const was = this.#quiet;
    this.#quiet = true;
    try {
      return run();
    } finally {
      this.#quiet = was;
    }
  }

  peopleCounts(within?: FactsRead): PeopleCounts {
    if (this.#counts !== undefined) return this.#counts;
    const read = this.index();
    notBuilding(read);
    const collections = collectionsOf(this.families);
    const presence = this.presence();
    const context: CountContext = {
      collections, settings: read.clock, now_ms: this.now_ms, people: () => this.peopleIfReady(),
      ...(presence === undefined ? {} : { presence }), ...(this.gate === undefined ? {} : { gate: this }),
    };
    const chats = collections.get("messages")?.keys.includes("chat") === true ? ["messages"] : [];
    const counted = (facts: FactsRead) => new PeopleCounts(facts, context, { person: [...collections.keys()].filter((of) => facts.people(of)), chat: chats });
    return this.#counts = within === undefined ? read.facts(counted) : counted(within);
  }

  shown(id: string): ShownPerson | undefined {
    const person = this.peopleIfReady()?.person(id);
    if (person === undefined) return undefined;
    if (this.gate === undefined) return { name: person.name, handles: person.handles, involved: true };
    let shown = this.#shown.get(id);
    if (shown === undefined) {
      const reach = this.peopleCounts().reach({ person: id, handles: person.handles });
      shown = { name: person.name, handles: reach?.handles ?? [], involved: reach === undefined ? undefined : Object.values(reach.reach).some(([n]) => n > 0) };
      this.#shown.set(id, shown);
    }
    return shown;
  }

  named(asked: string): string | undefined {
    const id = this.peopleIfReady()?.idOf(asked);
    if (id === undefined || this.gate === undefined) return id;
    const shown = this.shown(id);
    if (shown === undefined) return undefined;
    if (shown.involved === undefined) tooBroad();
    if (!shown.involved) return undefined;
    return asked === id || [asked, spelledId(asked)].some((handle) => handle !== null && shown.handles.includes(handle)) ? id : undefined;
  }

  found(name: string): string[] {
    const ids = this.peopleIfReady()?.find(name) ?? [];
    if (this.gate === undefined) return ids;
    return ids.filter((id) => {
      const byName = this.searched(id, false);
      if (byName === undefined || (findPeople([byName], name).length === 0 && findPeople([this.searched(id, true)!], name).length === 0)) return false;
      const involved = this.shown(id)?.involved;
      return involved ?? tooBroad();
    });
  }

  names(id: string): readonly string[] {
    return namesOf(this.peopleFileIfReady()?.value<{ person: PersonDetail }>("person", id)?.person, this.gate === undefined);
  }

  searched(id: string, handles: boolean): Searched | undefined {
    const person = this.peopleIfReady()?.person(id);
    if (person === undefined) return undefined;
    const shown = handles ? this.shown(id) : undefined;
    const held = !handles ? [] : shown?.involved === undefined ? person.handles : shown.handles;
    return searchedBy(id, this.names(id), held.flatMap((handle) => handleOfId(handle) ?? []));
  }

  personRef(id: string): string {
    return personRef({ id, handles: this.shown(id)?.handles ?? [] });
  }

  chatInvolved(key: string): boolean | undefined {
    if (this.gate === undefined) return true;
    const messages = this.peopleCounts().reach({ chat: key });
    return messages === undefined ? undefined : Object.values(messages.reach).some(([n]) => n > 0);
  }

  damaged(which: "people" | "places"): void {
    this.#stores.damaged(which);
  }

  floorOf(stated: string | null): number | null | undefined {
    if (!this.#floors.has(stated)) this.#floors.set(stated, earliest(this.gate!, accountsIn(stated)));
    return this.#floors.get(stated);
  }

  whole(stated: string, from_ms: number, to_ms: number): boolean | undefined {
    const first = this.#why(stated, from_ms);
    return first === this.#why(stated, to_ms) ? first === "allowed" : undefined;
  }

  tell(stated: string, start_ms: number, n: number): void {
    const why = this.#why(stated, start_ms);
    if (why !== "allowed") this.#count(why, n);
  }

  #why(stated: string, start_ms: number): Why {
    return this.allows(stated, start_ms, false) ? "allowed" : decide(this.gate!, { accounts: accountsIn(stated), start_ms }).why;
  }

  walked(capped: boolean): void {
    if (capped) this.#capped = true;
  }

  get outside(): boolean {
    return Object.keys(this.#withheld).length > 0;
  }

  keptOut(): KeptOut | undefined {
    return this.outside ? { by: { ...this.#withheld }, capped: this.#capped } : undefined;
  }

  screenAccounts(): ReadonlyMap<string, readonly string[]> {
    return this.#stores.screenAccounts(() => this.view());
  }

  get answerChars(): number {
    return ANSWER_CHARS[this.reader];
  }

  get families(): readonly Family[] {
    return this.#stores.families;
  }

  get networks(): Networks {
    return this.#stores.networks;
  }

  view(): OpenView {
    return this.#once("view", () => {
      const held = this.#stores.view();
      if (held === undefined) throw new Error("this call reads no home.db");
      return held;
    });
  }

  index(): RecordRead {
    const read = this.#index();
    if (read === "none") return this.#building("words", "the search index is being built");
    if (read === "busy") return refused("NOT_NOW", "the search index is being written");
    return read;
  }

  indexIfReady(): RecordRead | undefined {
    const read = this.#index();
    return read === "none" || read === "busy" ? undefined : read;
  }

  clock(): DaySettings {
    return this.indexIfReady()?.clock ?? this.#stores.settings();
  }

  screen(): ScreenRead {
    const read = this.screenIfReady();
    if (read === "none") return this.#building("screen", "the screen index is being built");
    if (read === "busy") return refused("NOT_NOW", "the screen index is being written");
    return read;
  }

  screenIfReady(): ScreenRead | "none" | "busy" {
    const held = this.#once<ScreenRead | "none" | "busy">("screen", () => {
      const opened = this.#stores.screen();
      return typeof opened === "string" ? { read: opened, end: () => undefined } : opened;
    });
    return held;
  }

  people(): PeopleMap {
    return this.peopleIfReady() ?? this.#building("people", "your people are being prepared");
  }

  peopleIfReady(): PeopleMap | undefined {
    this.#map ??= { people: (() => {
      const file = this.peopleFileIfReady();
      return file === undefined ? undefined : this.#stores.peopleMap(file);
    })() };
    return this.#map.people;
  }

  peopleFileIfReady(): PreparedRead | undefined {
    return this.#prepared("people");
  }

  placesIfReady(): PreparedRead | undefined {
    return this.#prepared("places");
  }

  presence(): PresenceSource | undefined {
    const source = this.#stores.presence;
    if (source === undefined || this.gate === undefined) return source;
    return this.#presence ??= {
      file: source.file,
      held: (version, load) => this.#allowedPieces(source.held(version, load)),
      ...(source.damaged === undefined ? {} : { damaged: () => source.damaged!() }),
    };
  }

  where(): Presence {
    return this.whereIfReady() ?? this.#building("places", "where you were is being prepared");
  }

  whereIfReady(): Presence | undefined {
    this.#where ??= { at: (() => {
      const read = this.indexIfReady();
      return read === undefined ? undefined : presenceIn(read, this.presence());
    })() };
    return this.#where.at;
  }

  #allowedPieces(whole: Presence): Presence {
    if (this.#judged?.whole === whole) return this.#judged.kept;
    const clock = this.clock();
    const days = new Set<string>();
    const withheld: PresenceTables["pieces"] = [];
    const pieces = whole.pieces.filter((piece) => {
      const [start_ms, end_ms, , , , accounts] = piece;
      if (decide(this.gate!, { accounts, start_ms }).allowed) return true;
      withheld.push(piece);
      for (let day = civilDay(start_ms, clock), last = civilDay(Math.max(start_ms, end_ms - 1), clock); day <= last; day = addDays(day, 1)) days.add(day);
      return false;
    });
    const placed = whole.placed.filter(([day]) => !days.has(day));
    const held = new Set([...pieces.flatMap(([, , known, guessed]) => [known, guessed]), ...placed.map(([, area]) => area)]);
    const tables: PresenceTables = {
      version: withheld.length === 0 ? whole.version : digest({ presence: whole.version, kept: pieces.map(([start_ms]) => start_ms) }),
      areas: whole.areas.filter((area) => held.has(area.id)), pieces, placed,
    };
    const kept = withheld.length === 0 ? whole : presenceOver(tables);
    this.#judged = { whole, kept, withheld };
    return kept;
  }

  stayServed(start_ms: number, end_ms: number, tally = false): boolean {
    if (this.gate === undefined) return true;
    const where = this.whereIfReady();
    if (where === undefined || where.between(start_ms, end_ms).length === 0) return false;
    const withheld = (this.#judged?.withheld ?? []).find(([from, to]) => from < end_ms && to > start_ms);
    if (withheld !== undefined && tally) this.judge({ accounts: withheld[5], start_ms: withheld[0] }, true);
    return withheld === undefined;
  }

  fresh(seq: number, held: HeldDays): Fresh | undefined {
    const clock = this.index().clock;
    const after = this.#afterView();
    if (after === undefined) return undefined;
    return freshOf(seq, held, after, civilDay(this.now_ms, clock), clock.zone) ?? refused("NOT_NOW", LISTING);
  }

  asOf(seq: number, zone: string): string | null {
    const after = this.#afterView();
    if (after === undefined) return null;
    const stated = asOfIn(seq, after, zone);
    if (stated !== null || seq === 0) return stated;
    const later = this.#stores.view();
    if (later === undefined) return null;
    this.opens.set("after", (this.opens.get("after") ?? 0) + 1);
    this.#ends.push(later.end);
    this.#after = later.read;
    return asOfIn(seq, later.read, zone);
  }

  labels(): Labels {
    return this.#labels ??= this.#stores.labels(this.view());
  }

  chat(asked: string): string {
    const key = this.#stores.chat(asked, () => this.labels());
    const read = this.index();
    if (read.building() !== null) return key;
    const held = read.facts((facts) => facts.point<{ id: number }>("SELECT id FROM names WHERE role = 'value' AND name = ?", [key]));
    return held !== undefined ? key : chatUnknown();
  }

  end(): void {
    for (const end of this.#ends.splice(0).reverse()) {
      try {
        end();
      } catch {
      }
    }
  }

  #index(): RecordRead | "none" | "busy" {
    return this.#once<RecordRead | "none" | "busy">("index", () => {
      const opened = this.#stores.index(this.meter);
      return typeof opened === "string" ? { read: opened, end: () => undefined } : opened;
    });
  }

  #prepared(which: "people" | "places"): PreparedRead | undefined {
    if (this.missing.has(which)) return undefined;
    return this.#once<PreparedRead | undefined>(which, () => {
      let held: Held<PreparedRead> | undefined;
      try {
        held = this.#stores.prepared(which);
      } catch (error) {
        if (busyError(error)) refused("NOT_NOW", which === "people" ? "your people are being written" : "your places are being written");
        if (damaged(error)) throw new StoreDamaged(which, error);
        throw error;
      }
      if (held === undefined) return { read: undefined, end: () => undefined };
      const read = guardedRead(which, held.read);
      return { read: which === "people" && this.sealed !== undefined ? sealedPeople(read, this.sealed) : read, end: held.end };
    });
  }

  #afterView(): OpenView | undefined {
    if (this.#after !== undefined) return this.#after;
    const held = this.#once<OpenView | undefined>("after", () => this.#stores.view() ?? { read: undefined, end: () => undefined });
    this.#after = held;
    return held;
  }

  #building(building: Building, words: string): never {
    return refused("INDEX_BUILDING", words, { building: [building] });
  }

  #once<T>(store: Store, open: () => Held<T>): T {
    if (this.#held.has(store)) return this.#held.get(store) as T;
    this.opens.set(store, (this.opens.get(store) ?? 0) + 1);
    const held = open();
    this.#held.set(store, held.read);
    this.#ends.push(held.end);
    return held.read;
  }
}

function busyError(error: unknown): boolean {
  return error instanceof Error && "code" in error && /^SQLITE_BUSY/u.test(String((error as { code: unknown }).code));
}

function guardedRead(which: "people" | "places", read: PreparedRead): PreparedRead {
  const guard = <A extends unknown[], R>(run: (...args: A) => R) => (...args: A): R => {
    try {
      return run(...args);
    } catch (error) {
      if (damaged(error)) throw new StoreDamaged(which, error);
      throw error;
    }
  };
  return {
    position: read.position, db: read.db,
    etag: guard((table: string, key: string) => read.etag(table, key)),
    answer: guard((table: string, key: string, gzip: boolean, position: string) => read.answer(table, key, gzip, position)),
    value: <V>(table: string, key: string) => guard(() => read.value<V>(table, key))(),
    rows: <V>(table: string) => guard(() => read.rows<V>(table))(),
    meta: guard((key: string) => read.meta(key)),
  };
}

function accountsIn(stated: string | null): string[] {
  return stated === null ? [] : stated.split("\x1e").filter((account) => account !== "");
}
