import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { duration, makeUnder, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { connectorName, roadsOf, type Connector } from "../declaration.js";
import { needWith, NeedsYou, NotYet, waitWith, type Fetched, type FetchedFile, type Lent, type Memory, type OpenPage, type Secrets } from "../seams.js";
import { readJson, utf8 } from "./json.js";
import { signInAgain, signInParams, signInSecrets, type Recipes } from "./recipe.js";
import { Refused } from "./refused.js";
import { siteCookies, siteOrigins, verdictOf, whoNamed, whoWords, type PageRead, type Who } from "./setup.js";
import { Limited, PageReads, runErrand, type Errand, type Held, type PageResponse, type Tab, type Value } from "./station.js";

/** A connector read as a site in the person's Chrome, its `chrome` block and its `refresh` declared. */
export type SiteConnector = Connector & Required<Pick<Connector, "chrome" | "refresh">>;

/** What a site lane takes from the world, each the real one when absent. */
export interface SiteDependencies {
  /** Waits a number of ms. */
  sleep?: (ms: number) => Promise<void>;
  /** Reads the clock, in ms since the epoch. */
  now?: () => number;
}

/** One acquirer's reading of a site in the person's Chrome, which `onSite` makes ready to run. */
export interface SiteLane {
  /** The name of the lane's errand, the acquirer's own. */
  readonly name: string;
  /** The site's connector, whose `chrome` block names its origins, its sign-in and its probe. */
  readonly site: SiteConnector;
  /** The connector's settings as they run, which hold the sign-in's values. */
  readonly block: {
    /** The lane's folder, emptied as each call starts, where the files a call keeps wait for the home to seal them. */
    readonly work: string;
  };
  /** How long one call's errand runs before the station ends it. */
  readonly deadline_ms: number;
  /** The lane's clock and its waits. */
  readonly dependencies: SiteDependencies;
  /** The recipes the site's sign-in names, by their names. */
  readonly recipes?: Recipes;
  /** Reads whose account the page is signed in to, first in every call and in `who`. */
  begin(pull: Pull): Promise<Who>;
}

/** One call's visit to the site as one account, handed to the code that reads it. */
export interface SiteVisit<State> {
  /** What the call reads the site's pages through and keeps its files in. */
  readonly pull: Pull;
  /** When the call began, in ms since the epoch. */
  readonly started: number;
  /** The provider's id for the account the page is signed in to. */
  readonly account: string;
  /** The id of the account's source. */
  readonly source: string;
  /** The facts naming the account and its source, for every delivery of the call, which the lane adds to any wait or need the call throws. */
  readonly own: JsonObject;
  /** The state the last call left for this account, or null before its first. */
  readonly previous: State | null;
  /** True when the lane has read no account before. */
  readonly first: boolean;
  /** The poll's memory, kept apart for this account. */
  readonly memory: Memory;
  /** Keeps the state the next call for this account starts from, answering the cursor the call returns. */
  leave(next: State): JsonObject;
}

/** A site lane ready to run: its clock, its two calls and the wait it throws when the site limits it. */
export interface OnSite {
  /** The lane's clock, in ms since the epoch. */
  readonly now: () => number;
  /** The lane's wait. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Runs one call on the site, opening its errand, signing in again where the site declares a sign-in and reading whose account it is, then hands `call` the visit when the person reads that account. */
  visit<State, T extends Fetched>(secrets: Secrets, lent: Lent, call: (visit: SiteVisit<State>) => Promise<T>): Promise<T>;
  /** Reads whose account an open page of the site is signed in to. */
  who(page: OpenPage): Promise<Who>;
  /** When a site that limits the lane lets it in again, one refresh from now, in ms since the epoch. */
  heldUntil(): number;
  /** The wait a call throws when the site kept answering 429, carrying the cursor the call leaves. */
  held(state?: JsonObject): NotYet;
}

const ACCOUNT = "account";

function accountMemory(memory: Memory, account: string): Memory {
  const own = (part: string): string => `${part}:${account}`;
  return {
    get: (part, key) => memory.get(own(part), key),
    put: (part, key, value) => memory.put(own(part), key, value),
    drop: (part, key) => memory.drop(own(part), key),
    clear: (part) => memory.clear(own(part)),
    list: (part, after, limit) => memory.list(own(part), after, limit),
  };
}

function owned(error: unknown, own: JsonObject): unknown {
  if (error instanceof NotYet) return waitWith(error, { facts: { ...own, ...error.facts } });
  if (error instanceof NeedsYou) return needWith(error, { facts: { ...own, ...error.facts } });
  return error;
}

/** Makes a site lane ready to run. */
export function onSite(lane: SiteLane): OnSite {
  const { site, block, dependencies } = lane;
  const recipes = lane.recipes ?? {};
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const name = connectorName(site);
  const signsIn = site.chrome.signin?.recipe !== undefined;
  const copy = site.sources.find((source) => roadsOf(source).includes("chrome"));
  if (copy === undefined) throw new Error(`${site.id} declares no source on the chrome road`);
  const heldUntil = (): number => now() + duration(site.refresh.default);
  const held = (state?: JsonObject): NotYet => new NotYet("provider-limit", `${name} answered 429 through every wait`, { state, backoff_ms: heldUntil() });
  const lapsed = (where: string): NotYet => new NotYet("retrying", `${where} answered 401: ${name}'s session lapsed since the page loaded, and the next call signs in again`);

  return {
    now, sleep, heldUntil, held,
    who: ({ errand, tab }) => lane.begin(new Pull(errand, tab, name, null, sleep)),
    async visit<State, T extends Fetched>(secrets: Secrets, lent: Lent, call: (visit: SiteVisit<State>) => Promise<T>): Promise<T> {
      const params = signInParams(site, recipes, block);
      const named = signInSecrets(site, recipes, params);
      rmSync(block.work, { recursive: true, force: true });
      makeUnder(dirname(block.work), block.work);
      const scratch = mkdtempSync(join(block.work, "poll-"));
      const started = now();
      const spec = { name: lane.name, origins: siteOrigins({ origin: site.chrome.origin, signin: site.chrome.signin?.origin, probe: site.chrome.probe }), ...(named.length === 0 ? {} : { secrets: named }), ...siteCookies(site.chrome.probe), deadline_ms: lane.deadline_ms };
      try {
        return await runErrand(lent.stations, spec, async (errand) => {
          const tab = await errand.open(`${site.chrome.origin}/`);
          await signInAgain(tab, site, { params, secrets, recipes });
          const pull = new Pull(errand, tab, name, scratch, sleep, signsIn ? lapsed : undefined);
          const who = await lane.begin(pull).catch((error: unknown) => {
            throw signsIn && error instanceof NeedsYou && error.reason === "signed-out" ? lapsed("whose account it is") : error;
          });
          const verdict = verdictOf(lent.accounts, who.id);
          if (verdict === "not-read") throw new NotYet("chrome", `Chrome is signed in to ${name} as an account turned off`, { facts: { account: whoWords(who) } });
          if (verdict === "offered") throw new NeedsYou("other-account", `Chrome is signed in to ${name} as ${whoWords(who)}`, { account: who });
          const source = copy.id.replace("<account>", who.id);
          const own: JsonObject = { account: who.id, sources: [{ id: source, connector: copy.read, ...whoNamed(who) }] };
          try {
            const previous = (lent.memory.get(ACCOUNT, who.id) ?? null) as State | null;
            return await call({
              pull, started, account: who.id, source, own, previous,
              first: previous === null && lent.memory.list(ACCOUNT, undefined, 1).length === 0,
              memory: accountMemory(lent.memory, who.id),
              leave: (next) => {
                lent.memory.put(ACCOUNT, who.id, next as unknown as Json);
                return { polled_ms: started };
              },
            });
          } catch (error) {
            throw owned(error instanceof Limited ? held() : error, own);
          }
        });
      } catch (error) {
        rmSync(scratch, { recursive: true, force: true });
        throw error instanceof Limited ? held() : error;
      }
    },
  };
}

/** Reads a response's body as JSON, or undefined when it is not JSON. */
export function readBody(bytes: Buffer, where: string): Json | undefined {
  try {
    return readJson(utf8(bytes, where), where);
  } catch (error) {
    if (error instanceof Refused) return undefined;
    throw error;
  }
}

/** What one call of a site lane reads the site through, keeping each file it fetches for the call's delivery. */
export class Pull extends PageReads {
  /** The files the call kept, for its delivery. */
  readonly kept: FetchedFile[] = [];
  /** Ids the call has asked the site for already, which its code keeps so it asks for each once. */
  readonly asked = new Set<string>();

  constructor(
    errand: Errand,
    tab: Tab,
    product: string,
    private readonly scratch: string | null,
    sleep: (ms: number) => Promise<void>,
    private readonly lapsed?: (where: string) => NotYet,
  ) {
    super(errand, tab, product, sleep, lapsed === undefined ? {} : { ends: [401] });
  }

  protected override async answered(requests: Parameters<PageReads["answered"]>[0]): Promise<PageResponse[]> {
    const answers = await super.answered(requests);
    const refused = this.lapsed === undefined ? -1 : answers.findIndex((answer) => answer.status === 401);
    if (refused >= 0) throw this.lapsed!(new URL(requests[refused]!.url, "https://site.invalid").pathname);
    return answers;
  }

  /** Asks the site through the page for one answer read as JSON. */
  async json(url: string, options: { headers?: Record<string, string | Held>; hold?: { name: string; path: string } } = {}): Promise<PageResponse> {
    return (await this.jsons([{ url, ...options }]))[0]!;
  }

  /** Asks the site through the page for several answers read as JSON, in order. */
  async jsons(requests: readonly { url: string; headers?: Record<string, string | Held>; hold?: { name: string; path: string } }[]): Promise<PageResponse[]> {
    return this.answered(requests.map((request) => ({ ...request, as: "json" as const })));
  }

  /** Reads one answer through the page as a sign-in read needs it. */
  readonly read: PageRead = async (request) => {
    const headers: Record<string, Value> | undefined = request.headers === undefined ? undefined : { ...request.headers };
    if (request.hold !== undefined) {
      const [answer] = await this.answered([{ url: request.url, as: "json", hold: request.hold, ...(headers === undefined ? {} : { headers }) }]);
      return { status: answer!.status, ...(answer!.held === undefined ? {} : { held: answer!.held }) };
    }
    const [answer] = await this.files([{ url: request.url, ...(headers === undefined ? {} : { headers }) }]);
    const json = answer!.bytes === undefined ? undefined : readBody(answer!.bytes, request.url);
    return { status: answer!.status, ...(answer!.bytes === undefined ? {} : { bytes: answer!.bytes }), ...(json === undefined ? {} : { json }), ...(answer!.error === undefined ? {} : { failed: answer!.error }) };
  };

  /** Keeps a fetched file at its path in the call's delivery, keeping nothing when `who` reads. */
  keep(path: string, bytes: Buffer): void {
    if (this.scratch === null) return;
    const file = join(this.scratch, path);
    makeUnder(this.scratch, dirname(file));
    writeFileSync(file, bytes);
    this.kept.push({ path, file });
  }

  /** Waits a number of ms on the lane's clock. */
  async wait(ms: number): Promise<void> {
    await this.sleep(ms);
  }
}
