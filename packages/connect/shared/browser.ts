import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { movedEarlier, type Acquirer, type Fetched, type Lent, type Memory, type Secrets } from "../seams.js";
import { rfc3339, instantMs } from "./delivery.js";
import { readJson, utf8 } from "./json.js";
import { LIST_LIMIT } from "./memory.js";
import { Refused } from "./refused.js";
import type { Who } from "./setup.js";
import type { Recipes } from "./recipe.js";
import { onSite, type Pull, type SiteConnector, type SiteDependencies, type SiteVisit } from "./site-lane.js";
import { Limited } from "./station.js";

/** What a conversation site's acquirer is built with. */
export interface BrowserSettings {
  /** The acquirer's folder, emptied as each call starts, where the conversations a call fetches wait for the home to seal them. */
  work: string;
  /** The most conversations one fetch reads, 150 when absent. */
  max_conversations?: number;
  /** How long a fetch goes on reading conversations after its first before it stops and asks to be called again, 30 seconds when absent. */
  piece_ms?: number;
  /** The wait between two conversations, the recipe's own when absent. */
  pace_ms?: number;
  /** How long one call's errand runs at most, 30 minutes when absent, a call ending its listing or reading at four fifths of it. */
  deadline_ms?: number;
  /** Folders of the person's own exports of the site, whose conversations the first call counts as read, so it fetches only those updated since. */
  seed?: readonly string[];
}

export interface BrowserState {
  listing?: Place;
  history_listing?: Place;
  first_ms: number;
  whole?: true;
}

export interface Place {
  next?: Json;
}

interface OwedEntry {
  at: string;
  tries?: number;
}

/** What the acquirer has fetched of conversations' media, so a call fetches each medium once. */
export interface FetchedMedia {
  /** Whether this call or an earlier one whose delivery was sealed fetched the medium. */
  fetched(id: string): boolean;
  /** Records that this call fetched the medium, remembered once its delivery is sealed. */
  took(id: string): void;
}

/** One page of the site's list of conversations. */
export interface ListPage {
  /** Each conversation listed, by its id and the time it was last updated. */
  readonly items: readonly (readonly [string, string])[];
  /** Where the next page starts, which the cursor keeps when a call stops listing, or null when the list ends. */
  readonly next: Json | null;
}

/** How the conversation site's acquirer reads one site in the person's Chrome: the account, the list of conversations and each conversation. */
export interface Recipe {
  /** The name of the acquirer it makes, which is also the source it seals under. */
  name: string;
  /** The site's connector, whose `chrome` block names its origins, its sign-in and its probe. */
  site: SiteConnector;
  /** The wait between two conversations, unless the settings give their own. */
  pace_ms: number;
  /** The recipes the site's sign-in names, by their names. */
  recipes?: Recipes;
  /** Reads whose account the page is signed in to, before anything is listed. */
  begin(pull: Pull): Promise<Who>;
  /** Lists the site's conversations page by page from where a stopped listing left off, given the update time the call knows for an id and which times are older than the floor. */
  list(pull: Pull, known: (id: string) => string | undefined, from: Json | undefined, old: (at: string) => boolean): AsyncIterable<ListPage>;
  /** Reads one folder of the person's export of the site, each conversation by its id and the time it was last updated. */
  exported(directory: string): Iterable<readonly [string, string]>;
  /** Reads one conversation into the call's files, fetching its media through `media`, and answers what came of it. */
  conversation(pull: Pull, id: string, media: FetchedMedia): Promise<Outcome>;
}

/** What reading one conversation came to. */
export type Outcome =
  /** It was read and its files kept. */
  | "read"
  /** The site no longer gives it, so no call asks for it again. */
  | "gone"
  /** It could not be read now, so a later call tries it again, three tries in all. */
  | "later";

/** What a page's answer that brought no conversation means: later for a page error, a timeout, a server error or a refused session, and gone otherwise. */
export function unread(answer: { status: number; error?: string }): Exclude<Outcome, "read"> {
  if (answer.status === 0) return answer.error === undefined || answer.error === "PAGE_ERROR" ? "later" : "gone";
  return answer.status >= 500 || [401, 403, 408].includes(answer.status) ? "later" : "gone";
}

const MAX_CONVERSATIONS = 150;
const PAGE_CONVERSATIONS = 10;
const PIECE_MS = 30_000;
const DEADLINE_MS = 30 * 60_000;
const OWED_TRIES = 3;

/** Makes the acquirer of a conversation site read in the person's Chrome, whose fetch reads the conversations updated since it last read and whose page walks back through older ones as history. */
export function browserAcquirer(settings: BrowserSettings, dependencies: SiteDependencies, recipe: Recipe): Acquirer {
  const max = settings.max_conversations ?? MAX_CONVERSATIONS;
  const piece = settings.piece_ms ?? PIECE_MS;
  const pace = settings.pace_ms ?? recipe.pace_ms;
  const deadline = settings.deadline_ms ?? DEADLINE_MS;
  const lane = onSite({ name: recipe.name, site: recipe.site, block: settings, deadline_ms: deadline, dependencies, ...(recipe.recipes === undefined ? {} : { recipes: recipe.recipes }), begin: (pull) => recipe.begin(pull) });
  const { now, sleep, held, heldUntil } = lane;

  function errand<T extends Fetched>(secrets: Secrets, lent: Lent, call: (at: Session) => Promise<T>): Promise<T> {
    return lane.visit<BrowserState, T>(secrets, lent, (visit: SiteVisit<BrowserState>) => {
      const { previous, started, memory } = visit;
      const first_ms = previous?.first_ms ?? started;
      const since_ms = lent.start_ms ?? 0;
      const whole = previous?.whole === true || (previous !== null && movedEarlier(lent) !== null);
      const old = (at: string): boolean => updated(at) !== 0 && updated(at) < since_ms;
      const seeded = previous === null && visit.first && settings.seed !== undefined ? seed(memory) : undefined;
      const owed = new Map<string, OwedEntry>();
      for (const [id, value] of entries(memory, OWED)) {
        const entry = value as unknown as OwedEntry;
        if (old(entry.at)) memory.drop(OWED, id);
        else owed.set(id, entry);
      }
      const read = new Map<string, string>();
      const took = new Set<string>();
      return call({
        pull: visit.pull, started, previous, memory, owed, since_ms, first_ms, whole, old, own: visit.own, leave: visit.leave,
        listing: previous?.listing, history_listing: previous?.history_listing, ...(seeded === undefined ? {} : { seeded }),
        seen: (id) => read.get(id) ?? (memory.get(SEEN, id) as string | undefined),
        read: (id, when) => void read.set(id, when),
        media: { fetched: (id) => took.has(id) || memory.get(MEDIA, id) !== undefined, took: (id) => void took.add(id) },
        took: () => took.size,
        sealed(answer) {
          for (const [id, when] of read) memory.put(SEEN, id, when);
          for (const id of took) memory.put(MEDIA, id, true);
          return answer;
        },
      });
    });
  }

  function seed(memory: Memory): number {
    const seen = new Map<string, string>();
    for (const directory of settings.seed ?? []) for (const [id, at] of recipe.exported(directory)) if (newer(at, seen.get(id))) seen.set(id, at);
    for (const [id, at] of seen) memory.put(SEEN, id, at);
    return seen.size;
  }

  async function listFrom(at: Session, known: (id: string) => string | undefined, from: Place | undefined, part: string): Promise<{ listed: Map<string, string>; next: Json | undefined; stopped: "time" | "limited" | null }> {
    const listed = new Map<string, string>();
    if (from !== undefined) {
      for (const [id, when] of entries(at.memory, part)) {
        if (at.old(when as string)) at.memory.drop(part, id);
        else listed.set(id, when as string);
      }
    }
    let next = from?.next;
    const ended = () => {
      at.memory.clear(part);
      return { listed, next: undefined, stopped: null };
    };
    const stopped = (why: "time" | "limited") => {
      for (const [id, when] of listed) at.memory.put(part, id, when);
      return { listed, next, stopped: why };
    };
    try {
      for await (const page of recipe.list(at.pull, known, next, at.old)) {
        for (const [id, when] of page.items) if (!at.old(when) && newer(when, listed.get(id))) listed.set(id, when);
        if (page.next === null) return ended();
        next = page.next;
        if (now() - at.started >= deadline * 0.8) return stopped("time");
      }
      return ended();
    } catch (error) {
      if (!(error instanceof Limited)) throw error;
      return stopped("limited");
    }
  }

  async function fetchEach(at: Session, queue: readonly (readonly [string, string])[], stop: (tried: number) => boolean) {
    let fetched = 0;
    let skipped = 0;
    const later = new Set<string>();
    let limited = false;
    let reached = queue.length;
    for (const [index, [id, when]] of queue.entries()) {
      if (stop(index) || now() - at.started >= deadline * 0.8) {
        reached = index;
        break;
      }
      if (index > 0 && pace > 0) await sleep(pace);
      try {
        const outcome = await recipe.conversation(at.pull, id, at.media);
        if (outcome === "read") {
          at.read(id, when);
          fetched++;
        } else {
          skipped++;
          if (outcome === "later") later.add(id);
        }
      } catch (error) {
        if (!(error instanceof Limited)) throw error;
        limited = true;
        reached = index;
        break;
      }
    }
    return { fetched, skipped, later, limited, reached };
  }

  const factsOf = (at: Session, own: JsonObject): JsonObject => ({
    fetched_at: rfc3339(at.started), ...at.own, ...own,
    ...(at.took() === 0 ? {} : { media: at.took() }),
    ...(at.seeded === undefined ? {} : { seeded: at.seeded }),
  });
  const placeOf = (at: Session, kept: { listing?: Place | undefined; history_listing?: Place | undefined; whole: boolean }): BrowserState => ({
    ...(kept.listing === undefined ? {} : { listing: kept.listing }),
    ...(kept.history_listing === undefined ? {} : { history_listing: kept.history_listing }),
    first_ms: at.first_ms,
    ...(kept.whole ? { whole: true as const } : {}),
  });
  const stoppedAt = (next: Json | undefined): Place => (next === undefined ? {} : { next });
  const owing = (at: Session, keep: (entry: OwedEntry) => boolean): (readonly [string, string])[] =>
    [...at.owed].filter(([, entry]) => keep(entry)).map(([id, entry]) => [id, entry.at] as const);
  const newestFirst = (entries: Iterable<readonly [string, string]>) =>
    [...entries].sort(([leftId, left], [rightId, right]) => updated(right) - updated(left) || (leftId < rightId ? -1 : 1));
  const inTurn = (at: Session, entries: readonly (readonly [string, string])[]) => [
    ...newestFirst(entries.filter(([id]) => at.owed.get(id)?.tries === undefined)), ...newestFirst(entries.filter(([id]) => at.owed.get(id)?.tries !== undefined)),
  ];
  const settle = (at: Session, tried: readonly (readonly [string, string])[], later: ReadonlySet<string>): void => {
    for (const [id] of tried) {
      const entry = at.owed.get(id)!;
      const tries = (entry.tries ?? 0) + 1;
      if (later.has(id) && tries < OWED_TRIES) {
        at.owed.set(id, { at: entry.at, tries });
        at.memory.put(OWED, id, { at: entry.at, tries });
      } else {
        at.owed.delete(id);
        at.memory.drop(OWED, id);
      }
    }
  };
  const owe = (at: Session, id: string, when: string): void => {
    at.owed.set(id, { at: when });
    at.memory.put(OWED, id, { at: when });
  };

  return {
    name: recipe.name,
    source: recipe.name,
    ...(recipe.site.chrome.probe === null ? { who: lane.who } : {}),
    fetch: (_state, secrets, lent) => errand(secrets, lent, async (at) => {
      const fresh = (when: string): boolean => updated(when) === 0 || updated(when) >= at.first_ms;
      let queue = owing(at, (entry) => fresh(entry.at) && entry.tries === undefined);
      let listed = 0;
      let listing = at.listing;
      if (queue.length === 0) {
        const read = await listFrom(at, (id) => at.owed.get(id)?.at ?? at.seen(id), listing, LISTED);
        listed = read.listed.size;
        if (read.stopped !== null) {
          listing = stoppedAt(read.next);
          const more = read.stopped === "time";
          const state = at.leave(placeOf(at, { listing, history_listing: at.history_listing, whole: at.whole }));
          if (!more) throw held(state);
          return at.sealed({ files: [], facts: factsOf(at, { listed, listing: read.stopped, conversations: 0, skipped: 0, more }), state, more: true as const });
        }
        listing = undefined;
        for (const [id, when] of read.listed) if (newer(when, at.seen(id)) && newer(when, at.owed.get(id)?.at)) owe(at, id, when);
        queue = owing(at, (entry) => fresh(entry.at));
      }
      const ordered = inTurn(at, queue);
      const done = await fetchEach(at, ordered, (tried) => tried >= max || (tried > 0 && now() - at.started >= piece));
      settle(at, ordered.slice(0, done.reached), done.later);
      const more = done.reached < ordered.length;
      const state = at.leave(placeOf(at, { listing, history_listing: at.history_listing, whole: at.whole }));
      if (done.limited && done.fetched === 0) throw held(state);
      return at.sealed({
        files: done.fetched === 0 ? [] : at.pull.kept, facts: factsOf(at, { listed, conversations: done.fetched, skipped: done.skipped, more }), state,
        ...(done.limited ? { backoff_ms: heldUntil() } : more ? { more: true as const } : {}),
      });
    }),
    page: (_state, secrets, lent) => errand(secrets, lent, async (at) => {
      const history = () => owing(at, (entry) => updated(entry.at) !== 0 && updated(entry.at) < at.first_ms);
      let history_listing = at.history_listing;
      let whole = at.whole;
      let listed = 0;
      const leave = () => at.leave(placeOf(at, { listing: at.listing, history_listing, whole }));
      if (whole && history().length === 0) {
        const read = await listFrom(at, () => undefined, history_listing, WALKED);
        listed = read.listed.size;
        for (const [id, when] of read.listed) if (newer(when, at.seen(id)) && newer(when, at.owed.get(id)?.at) && updated(when) !== 0 && updated(when) < at.first_ms) owe(at, id, when);
        if (read.stopped !== null) {
          history_listing = stoppedAt(read.next);
          if (read.stopped === "limited") throw held(leave());
          return at.sealed({ files: [], facts: factsOf(at, { listed, conversations: 0, skipped: 0 }), state: leave(), left: null });
        }
        history_listing = undefined;
        whole = false;
      }
      const queue = inTurn(at, history());
      const done = await fetchEach(at, queue, (tried) => tried >= PAGE_CONVERSATIONS);
      settle(at, queue.slice(0, done.reached), done.later);
      if (done.limited && done.fetched === 0) throw held(leave());
      const open = at.previous === null || at.listing !== undefined || whole;
      return at.sealed({
        files: done.fetched === 0 ? [] : at.pull.kept, facts: factsOf(at, { listed, conversations: done.fetched, skipped: done.skipped }), state: leave(),
        left: open ? null : history().length,
        ...(done.limited ? { backoff_ms: heldUntil() } : {}),
      });
    }),
  };
}

const SEEN = "seen";
const MEDIA = "media";
const OWED = "owed";
const LISTED = "listed";
const WALKED = "walked";

function* entries(memory: Memory, part: string): Generator<readonly [string, Json]> {
  for (let after: string | undefined; ;) {
    const page = memory.list(part, after);
    yield* page;
    if (page.length < LIST_LIMIT) return;
    after = page[page.length - 1]![0];
  }
}

interface Session {
  readonly pull: Pull;
  readonly started: number;
  readonly previous: BrowserState | null;
  readonly memory: Memory;
  readonly owed: Map<string, OwedEntry>;
  seen(id: string): string | undefined;
  read(id: string, when: string): void;
  readonly media: FetchedMedia;
  took(): number;
  readonly seeded?: number;
  readonly since_ms: number;
  readonly first_ms: number;
  readonly whole: boolean;
  readonly old: (at: string) => boolean;
  readonly listing: Place | undefined;
  readonly history_listing: Place | undefined;
  readonly own: JsonObject;
  leave(next: BrowserState): JsonObject;
  sealed<T extends Fetched>(answer: T): T;
}

/** Whether an update time is newer than the one known before it, any change counting when either time cannot be read. */
export function newer(at: string, before: string | undefined): boolean {
  if (before === undefined) return true;
  const [later, earlier] = [updated(at), updated(before)];
  return later === 0 || earlier === 0 ? at !== before : later > earlier;
}

/** Reads, in name order, each JSON file of a folder whose name the pattern matches. */
export function exportedFiles(directory: string, pattern: RegExp): Json[] {
  return readdirSync(directory).filter((name) => pattern.test(name)).sort().map((name) => readJson(utf8(readFileSync(join(directory, name)), name), name));
}

/** Whether every row a reading gives can be read with none refused. */
export function readable(rows: () => Iterable<unknown>): boolean {
  try {
    for (const _ of rows());
    return true;
  } catch (error) {
    if (error instanceof Refused) return false;
    throw error;
  }
}

function updated(at: string): number {
  return instantMs(at) ?? (/^\d+(?:\.\d+)?$/u.test(at) ? Number(at) * 1000 : 0);
}
