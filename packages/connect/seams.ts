import { type BlobReader, type Delivery, type Guard, type Json, type JsonObject, type Months, type ReaderOutput, type Secrets } from "@lifestreamprotocol/core";
import type { NeedReason, WaitReason } from "./declaration.js";
import type { Dependencies } from "./shared/dependencies.js";
import type { ImportAccount } from "./shared/import-account.js";
import type { Member } from "./shared/members.js";
import type { Accounts, Who } from "./shared/setup.js";
import type { Errand, Stations, Tab } from "./shared/station.js";

export type { Secrets };

/** Reads one source's deliveries into the rows the home lands as its records. */
export interface Reader {
  /** The name a declared source's `read` gives this reader, by which the home finds it for every delivery of that source. */
  name: string;
  /** Each kind of record it states, with the guard the home runs over a row's content as the row lands. */
  kinds: Record<string, Guard>;
  /** Reads one delivery into rows as an async generator, with `view` the records the home holds, this delivery's own among them when it is read again. */
  read(delivery: Delivery, files: BlobReader, view?: ReaderView): AsyncIterable<ReaderOutput>;
  /** Each table of another app's SQLite store it reads, with every column it knows, beyond which the home's report lists the columns a delivery holds as unread. */
  columns?: Readonly<Record<string, readonly string[]>>;
  /** Where the person's own export of this connector names its account, read before any row, so the home knows whose it is without asking. */
  account?: ImportAccount | readonly ImportAccount[];
  /** Reads what the person's own export states of itself before any row, from the provider's own evidence, given the anchor the home keeps for the account or null before its first export. */
  states?(members: readonly Member[], anchor: string | null): Promise<ImportStated>;
}

/** What a reader may read of the records its home already holds. */
export interface ReaderView {
  /** The head of one record, or undefined when the home holds none. */
  head(ref: { readonly source: string; readonly kind: string; readonly key: string }): ViewHead | undefined;
  /** The head of each record of one kind a source holds. */
  heads(source: string, kind: string): Iterable<ViewHead>;
  /** Each record of one kind a source holds, with its current version, timed within the range when one is given. */
  records(source: string, kind: string, range?: { readonly start_ms?: number; readonly end_ms?: number }): Iterable<{ readonly head: ViewHead; readonly version: ViewVersion }>;
  /** The version a head names by its id. */
  version(id: string): ViewVersion;
}

/** Where one held record stands: its key, its current version and when that was stated. */
export interface ViewHead {
  /** The record's key within its source and kind. */
  readonly key: string;
  /** The id of the record's current version, or "gone" when its source removed it. */
  readonly version: string;
  /** The statement time of the delivery that stated the current version, in ms since the epoch. */
  readonly stated_ms: number;
}

/** One version of a held record, as a reader reads it. */
export interface ViewVersion {
  /** The record's content as its reader stated it. */
  readonly content: Json;
}

/** What a person's export states of itself, from the provider's own evidence. */
export interface ImportStated {
  /** When the export was made by the provider's evidence, in ms since the epoch, which the home states its records at in place of when it took the file in. */
  readonly time_ms?: number;
  /** A value the account keeps across its exports, which the home keeps from the first export and hands back to `states` for every later one. */
  readonly anchor?: string;
}

/** A file an acquirer fetched, by its path in the delivery, held as bytes or lying in a local file. */
export type FetchedFile =
  | {
    /** The file's path within the delivery. */
    path: string;
    /** The file's content, held in memory. */
    bytes: Buffer;
  }
  | {
    /** The file's path within the delivery. */
    path: string;
    /** A local file holding the content, which the home moves into the delivery when it lies inside the home's folder and copies when it lies outside, and which the acquirer keeps until the delivery is sealed. */
    file: string;
  };

/** Fetches from a provider what the home seals as one delivery a call. */
export interface Acquirer {
  /** The poll's name, under which the home keeps its cursor, its memory and its schedule, and by which its connector lists it. */
  name: string;
  /** The source the home seals its deliveries under, and the one they feed unless their facts state sources of their own. */
  source: string;
  /** The names of the secrets it reads or rotates beyond those its connector's fields name, which the home answers its calls with besides those. */
  secrets?: readonly string[];
  /** Fetches what is new since the cursor at the connector's refresh, given the cursor or null on the first call. */
  fetch(state: JsonObject | null, secrets: Secrets, lent: Lent): Promise<FetchedNew>;
  /** Fetches one batch of history behind the oldest it has read at the backfill's pace, sharing the cursor with `fetch`. */
  page?(state: JsonObject | null, secrets: Secrets, lent: Lent): Promise<FetchedPage>;
  /** That the first page of each walk answers the whole source counted by month (`FetchedPage.months`), so the home prices a start from that count and waits for it. */
  months?: true;
  /** Reads whose account a Chrome site's open page is signed in to, for a site whose connector declares no probe, so setup names the account before the first poll. */
  who?(page: OpenPage): Promise<Who>;
}

/** A page of a Chrome site open in the person's Chrome, which `who` reads the account through. */
export interface OpenPage {
  /** The errand that holds the page open. */
  readonly errand: Errand;
  /** The tab the page is open in. */
  readonly tab: Tab;
}

/** A sign-in route's check in code, one call with the credential the person gave and what the home lends it, answering the account the provider names and the credential as the home should keep it. */
export type SignedIn = (values: SignInGiven, dependencies?: Dependencies) => Promise<SignInChecked>;

/** What the person gave a sign-in route, which its check reads. */
export interface SignInGiven {
  /** The connector's fields as the home settles them for this sign-in, what the person filled in beside the credential among them. */
  readonly fields: Readonly<JsonObject>;
  /** The secret the person typed, or the token the provider answered its sign-in with. */
  readonly credential: string;
  /** Aborts when the person or the home gives up on the sign-in, after which the check stops what it asks the provider. */
  readonly signal: AbortSignal;
}

/** What a sign-in route's check answers when the provider accepts the credential. */
export interface SignInChecked {
  /** The account the provider names for the credential, when it names one. */
  readonly account?: string;
  /** The credential as the home keeps it in its vault. */
  readonly credential: string;
}

/** What one call of an acquirer answers, which the home seals as one delivery and whose cursor it keeps. */
export type Fetched = {
  /** The files fetched, sealed into the delivery, where a fetch with none seals nothing. */
  files: FetchedFile[];
  /** What the delivery states of itself, sealed with it beside its files. */
  facts: JsonObject;
  /** The cursor after this call, which the home keeps with the call's changes of the poll's memory and hands to the next call. */
  state: JsonObject;
  /** False when the call asked nothing of the provider, so the home leaves the copy's last contact where it was. */
  answered?: false;
  /** When the provider lets the next call in, in ms since the epoch, before which the home calls neither `fetch` nor `page` and records a provider-limit wait. */
  backoff_ms?: number;
};

/** What one call of an acquirer's `fetch` answers. */
export interface FetchedNew extends Fetched {
  /** True to be called again at once. */
  more?: true;
  /** The soonest the home calls `fetch` again, in ms since the epoch. */
  next_ms?: number;
}

/** What one call of an acquirer's `page` answers. */
export interface FetchedPage extends Fetched {
  /** What the backfill still owes in the connector's unit, or null while the provider cannot count it. */
  left: number | null;
  /** The soonest the home calls `page` again, in ms since the epoch. */
  next_ms?: number;
  /** The whole source counted by month, above and below the start, answered by an acquirer that says `months` on the first page of each walk and on a page asked while its cursor has not counted. */
  months?: Months;
}

export const HOME_FACTS = ["history", "left", "start_ms", "months"] as const;

/** What the home lends one call of a poll besides its secrets. */
export interface Lent {
  /** The stations the home's door holds, on which a call runs errands in the person's Chrome. */
  readonly stations: Stations;
  /** Each account the poll's sources hold, true where the person reads it and false where they turned it off. */
  readonly accounts: Accounts;
  /** The instant, in ms since the epoch, below which the call reads nothing for every source of the poll, or null to read all of it. */
  readonly start_ms: number | null;
  /** The start the cursor in `state` was left under, null when it was left reading all and undefined when the poll holds no cursor yet. */
  readonly from_ms: number | null | undefined;
  /** The poll's memory as the last call that left a cursor left it, with this call's own changes. */
  readonly memory: Memory;
}

/** The start the cursor was left under when this call's start is earlier, the end of the gap from `lent.start_ms` the call reads, and null when the start did not move earlier. */
export function movedEarlier({ start_ms, from_ms }: Pick<Lent, "start_ms" | "from_ms">): number | null {
  return from_ms === null || from_ms === undefined || (start_ms ?? -Infinity) >= from_ms ? null : from_ms;
}

/** What a poll remembers of single items, one small entry an item in parts the acquirer names, whose changes commit only with the cursor a call leaves. */
export interface Memory {
  /** The value under a key of a part, this call's changes included, or undefined when it holds none. */
  get(part: string, key: string): Json | undefined;
  /** Keeps a value under a key of a part. */
  put(part: string, key: string, value: Json): void;
  /** Removes a key from a part. */
  drop(part: string, key: string): void;
  /** Removes every entry of a part. */
  clear(part: string): void;
  /** A part's entries in the byte order of their keys, after `after` when given, at most `limit` and never more than 1,000. */
  list(part: string, after?: string, limit?: number): (readonly [key: string, value: Json])[];
}

/** A poll's call that cannot go on until the person acts, which the home records as the copy's attempt and words from its reason. */
export class NeedsYou extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "NeedsYou";
  }

  /** Where the person acts on it, when the call says. */
  readonly at: Place | undefined;
  /** The cursor the poll keeps while it waits, with this call's changes of the poll's memory. */
  readonly state: JsonObject | undefined;
  /** The soonest the home makes this call again, in ms since the epoch. */
  readonly next_ms: number | undefined;
  /** The account Chrome is signed in to, which the home offers the person to read. */
  readonly account: Who | undefined;
  /** What the home words the need from, beside its reason. */
  readonly facts: JsonObject | undefined;
  /** False when no request reached the provider, so the home leaves the copy's last contact where it was. */
  readonly answered: false | undefined;

  constructor(
    /** Why the call cannot go on, which the home words for the person and acts on. */
    readonly reason: NeedReason,
    message: string,
    options: {
      readonly at?: Place | undefined;
      readonly state?: JsonObject | undefined;
      readonly next_ms?: number | undefined;
      readonly account?: Who | undefined;
      readonly facts?: JsonObject | undefined;
      readonly answered?: false | undefined;
    } = {},
  ) {
    super(`needs you: ${message}`);
    this.name = "NeedsYou";
    this.at = options.at;
    this.state = options.state;
    this.next_ms = options.next_ms;
    this.account = options.account;
    this.facts = options.facts;
    this.answered = options.answered;
  }

  /** What the call said of the need, which the home keeps as the attempt's detail for whoever runs it. */
  get says(): string {
    return this.message.replace(/^needs you: /u, "");
  }
}

export function needWith(need: NeedsYou, change: { readonly at?: Place; readonly facts?: JsonObject }): NeedsYou {
  return new NeedsYou(need.reason, need.says, { at: need.at, state: need.state, next_ms: need.next_ms, account: need.account, facts: need.facts, answered: need.answered, ...change });
}

/** Where the person acts on a need. */
export interface Place {
  /** The host of the site the need is on. */
  readonly site: string;
  /** A page the person opens in their own window to act, which the home offers as an Open button. */
  readonly open?: string;
  /** The station errand whose tab waits for the person, kept open for them. */
  readonly errand?: string;
}

/** A poll's call held by something that ends without the person, after which the home calls again with the cursor it kept. */
export class NotYet extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "NotYet";
  }

  /** The cursor the poll keeps while it waits, with this call's changes of the poll's memory. */
  readonly state: JsonObject | undefined;
  /** The soonest the home makes this call again, in ms since the epoch. */
  readonly next_ms: number | undefined;
  /** When the provider lets the next call in, in ms since the epoch, before which the home calls neither `fetch` nor `page`. */
  readonly backoff_ms: number | undefined;
  /** What the home words the wait from, beside its reason. */
  readonly facts: JsonObject | undefined;

  constructor(
    /** What the call waits on, which the home words for the person. */
    readonly reason: WaitReason,
    /** What the call said of the wait, which the home keeps as the attempt's detail for whoever runs it. */
    readonly detail: string,
    options: { readonly state?: JsonObject | undefined; readonly next_ms?: number | undefined; readonly backoff_ms?: number | undefined; readonly facts?: JsonObject | undefined } = {},
  ) {
    super(`not yet: ${detail}`);
    this.name = "NotYet";
    this.state = options.state;
    this.next_ms = options.next_ms;
    this.backoff_ms = options.backoff_ms;
    this.facts = options.facts;
  }
}

export function waitWith(wait: NotYet, change: { readonly facts?: JsonObject }): NotYet {
  return new NotYet(wait.reason, wait.detail, { state: wait.state, next_ms: wait.next_ms, backoff_ms: wait.backoff_ms, facts: wait.facts, ...change });
}
