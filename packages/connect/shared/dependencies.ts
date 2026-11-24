import type { JsonObject } from "@lifestreamprotocol/core";
import type { Signals } from "./station.js";

/** What an acquirer's factory is built with: its connector's fields as they run, and what the home lends every acquirer. */
export type AcquirerSettings<F extends object = Record<never, never>> = F & {
  /** The acquirer's own folder, read when it runs and never when it is built, where its fetched files wait until the home seals them: the home's `tools/<name>-work`, kept between calls, on a plain home, and on an encrypted one the machine's `scratch/<name>-work`, emptied when the home starts. */
  readonly work: string;
  /** The home's day zone, as an IANA name, in which the home's days begin and end. */
  readonly zone: string;
  /** The home machine's unit, which names a source of the home's own. */
  readonly unit: string;
};

/** What an acquirer or a sign-in check reaches the world through, which the home lends and a conformance run hands as fakes, `fetch`, `now` and `sleep` the real ones when absent. */
export interface Dependencies {
  /** Makes every HTTP request the acquirer sends. */
  readonly fetch?: typeof globalThis.fetch;
  /** Reads the clock, in ms since the epoch. */
  readonly now?: () => number;
  /** Waits a number of ms. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Opens every IMAP session the acquirer reads mail through, over TLS, logged in once its client connects. */
  readonly imap?: (connection: ImapConnection) => ImapClient | Promise<ImapClient>;
}

/** Where an IMAP session connects and whom it logs in as. */
export interface ImapConnection {
  /** The server's host name. */
  readonly host: string;
  /** The server's TLS port. */
  readonly port: number;
  /** The account the session logs in as. */
  readonly account: string;
  /** The account's password, an app password where the provider asks for one. */
  readonly password: string;
}

/** One IMAP session, as the home's IMAP client answers it. */
export interface ImapClient {
  /** Connects and logs in, throwing an error with `authenticationFailed` true when the server refuses the login. */
  connect(): Promise<void>;
  /** Logs out and ends the session. */
  logout(): Promise<void>;
  /** Ends the session at once, without a word to the server. */
  close(): void;
  /** Lists every mailbox the account holds. */
  list(): Promise<readonly ImapMailbox[]>;
  /** Opens a mailbox read-only, answering its UIDVALIDITY and UIDNEXT. */
  mailboxOpen(path: string, options: { readOnly: true }): Promise<{ uidValidity: bigint | number; uidNext: number }>;
  /** Searches the open mailbox by a UID set and, when given, a day messages were received on or after, answering their UIDs or false when the server refused it. */
  search(query: { uid: string; since?: Date }, options: { uid: true }): Promise<number[] | false>;
  /** Fetches the messages of the open mailbox in a UID set, each with what the query asks. */
  fetch(range: string, query: ImapQuery | ImapSizeQuery, options: { uid: true }): AsyncIterable<ImapMessage>;
}

/** One mailbox an account lists. */
export interface ImapMailbox {
  /** Its path, in the account's language. */
  path: string;
  /** The special use the server flags it with (RFC 6154), as `\All`, `\Junk` or `\Trash`, none when absent. */
  specialUse?: string;
}

/** A fetch of each message's whole source with Gmail's ids, labels and received time. */
export interface ImapQuery {
  /** Asks each message's UID. */
  uid: true;
  /** Asks each message's bytes. */
  source: true;
  /** Asks each message's thread id. */
  threadId: true;
  /** Asks each message's labels. */
  labels: true;
  /** Asks when the server received each message. */
  internalDate: true;
}

/** A fetch of each message's size, and when asked, the time the server received it. */
export interface ImapSizeQuery {
  /** Asks each message's UID. */
  uid: true;
  /** Asks each message's size in bytes. */
  size: true;
  /** Asks when the server received each message. */
  internalDate?: true;
}

/** One message as a fetch answers it, with what its query asked. */
export interface ImapMessage {
  /** Its UID in its mailbox. */
  uid: number;
  /** Its size in bytes. */
  size?: number;
  /** Its id across the account's mailboxes, Gmail's X-GM-MSGID. */
  emailId?: string;
  /** Its thread's id, Gmail's X-GM-THRID. */
  threadId?: string;
  /** Its labels, Gmail's X-GM-LABELS. */
  labels?: Set<string>;
  /** When the server received it. */
  internalDate?: Date;
  /** Its bytes, as the server holds them. */
  source?: Buffer;
}

/** A fake IMAP account a mail acquirer reads through its `imap` in a conformance run, its mailboxes by their paths. */
export type FakeMailbox = Readonly<Record<string, FakeFolder>>;

/** One mailbox of a fake IMAP account. */
export interface FakeFolder {
  /** The special use the server flags it with, as `\All`, `\Junk` or `\Trash`, none when absent. */
  specialUse?: string;
  /** Its UIDVALIDITY, which a server changes when it numbers the mailbox's messages anew. */
  uidValidity: number;
  /** Its UIDNEXT, the UID its next message takes. */
  uidNext: number;
  /** Its messages, each with its UID and source, its size the source's length. */
  messages: ImapMessage[];
}

/** What a fixture's fake source holds in one conformance run: items numbered from 0, the first `old` of them there before the run's first fetch. */
export interface Scenario {
  /** How many items the source holds, each by the same number in every scenario of a run. */
  readonly items: number;
  /** How many of the first items the source held before the run, dated before `start_ms` as the provider would date them, the rest added after. */
  readonly old: number;
  /** The numbers of the items changed since the run began, each a new version of itself. */
  readonly edited: readonly number[];
  /** The numbers of the items gone from the source. */
  readonly removed: readonly number[];
  /** When the run starts by its own clock, in ms since the epoch, which dates an item old or new. */
  readonly start_ms: number;
  /** Items the run dates itself, by number, each at its time in ms since the epoch, which the fake and `dated` give it in place of their own. */
  readonly stamped?: Readonly<Record<number, number>>;
}

/** Which item of the scenario a record an acquirer landed is, by its kind and key, or null for a record no item makes. */
export type ItemOf = (record: { readonly kind: string; readonly key: string }) => number | null;

/** A fake provider over HTTP, answering each request the acquirer's `fetch` makes. */
export type Provider = (request: Request) => Response | Promise<Response>;

/** The files a fixture writes for a folder poll or an export, by their paths, each its content or its content and when it was last written. */
export type Files = Readonly<Record<string, string | Uint8Array | {
  /** The file's content, text written as UTF-8. */
  readonly bytes: string | Uint8Array;
  /** When the file was last written, in ms since the epoch, by which a folder poll dates it. */
  readonly modified_ms?: number;
}>>;

/** One request a page made of a fake site. */
export interface SiteRequest {
  /** The URL asked for. */
  url: URL;
  /** The request's method. */
  method: string;
  /** The request's body, when it sends one. */
  body?: string;
  /** The request's headers, with the values the station put in. */
  headers: Record<string, string>;
}

/** A fake site's answer to one request. */
export interface SiteAnswer {
  /** The HTTP status it answers with. */
  status: number;
  /** What the page's fetch receives: a string as its text, bytes as they are, any other value as its JSON. */
  body?: unknown;
  /** The page's fetch got no answer, as on a reset connection. */
  failed?: true;
  /** Where the site redirected the request, which the answer names as its URL. */
  redirect?: string;
}

/** One element of a fake page, as the station's outline and finds read it. */
export interface FakeElement {
  /** Its accessible role, as a role locator matches it. */
  role: string;
  /** Its accessible name, which role and text locators match. */
  name: string;
  /** A form field's label, which a label locator matches. */
  label?: string;
  /** Whether a checkbox or radio is checked, which a click changes. */
  checked?: boolean;
  /** A heading's level, shown in the outline. */
  level?: number;
  /** What a fill or a select left in it. */
  value?: string | undefined;
  /** Runs when it is clicked, answering a URL the tab then goes to, if any. */
  click?: () => string | void;
  /** A link's target, which a css locator `a[href*="…"]` matches. */
  href?: string;
}

/** One page of a fake site, as its tab shows it. */
export interface FakePage {
  /** The page's title. */
  title?: string;
  /** The page's elements, in order. */
  elements: FakeElement[];
  /** What the page shows that asks the person to act, beside what the whole site shows. */
  signals?: Partial<Signals>;
  /** Where opening the page sends the tab instead. */
  redirect?: string;
}

/** A fake site a Chrome recipe's acquirer reads through the in-memory station in a conformance run. */
export interface Site {
  /** Answers one request a page makes of the site. */
  answer(request: SiteRequest): SiteAnswer;
  /** What every page of the site shows that asks the person to act. */
  signals?: Partial<Signals>;
  /** The page at a URL, or undefined for an empty one. */
  page?(url: URL): FakePage | undefined;
  /** The cookies the site's pages hold at an origin, by name. */
  cookies?(origin: string): Readonly<Record<string, string>>;
  /** Whether a page at `page` gets an answer to a request across origins, false failing it as a browser does. */
  cors?(page: string, url: URL): boolean;
}

/** Writes one reader's small valid delivery into a folder and says what it wrote. */
export type Fixture = (folder: string) => FixtureDelivery;

/** One reader's small valid delivery, which the conformance test lands whole and then with each file spoiled in turn. */
export interface FixtureDelivery {
  /** The source the delivery is of. */
  source: string;
  /** The lane the delivery arrives on when another source's lane carries it, its own source's when absent. */
  lane?: string;
  /** The facts the delivery is sealed with. */
  facts: JsonObject;
  /** Each file the fixture wrote, by its path in the delivery, with what spoiling it costs. */
  files: Readonly<Record<string, Spoiled>>;
  /** Heads, each a kind and a key, that the whole delivery lands besides those its files name. */
  heads?: readonly string[];
}

/** What one file of a fixture costs when it is cut to its first half or is no file, or `trust` when the rest of the delivery is lost with it. */
export type Spoiled = "trust" | {
  /** The heads only this file holds, each a kind and a key, lost when it is spoiled. */
  alone: readonly string[];
  /** Those of its heads whose values lie whole in the file's first half, which still land when it is cut there. */
  prefix?: readonly string[];
  /** Heads the file's first half lands that the whole file does not. */
  cut?: readonly string[];
};
