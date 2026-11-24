import { renameSync } from "node:fs";
import { needWith, NeedsYou, type Place, type Secrets } from "../seams.js";
import type { SiteAccount } from "./setup.js";

/** What an acquirer asks of an errand on a station: its name, the origins it works on, what it fills and sends, and how long it runs. */
export interface ErrandSpec {
  /** The errand's name, by which the home hands a later errand of the same name the one it kept open for the person. */
  readonly name: string;
  /** The origins its tabs and requests reach, which it holds on its station while it runs. */
  readonly origins: readonly string[];
  /** The names of the secrets the station types or sends for it, each resolved by the home. */
  readonly secrets?: readonly string[];
  /** The names of the page's cookies whose values its requests send as headers. */
  readonly cookies?: readonly string[];
  /** How long it runs before the station ends it, whatever is in flight. */
  readonly deadline_ms: number;
}

/** A value the station holds from an earlier answer of the errand, sent by the name it was held under and never shown to the acquirer. */
export interface Held {
  /** The name the value was held under. */
  readonly held: string;
  /** Text sent before the value, as `Bearer `. */
  readonly prefix?: string;
}

/** A secret the home holds, typed or sent by its name, its value never shown to the acquirer. */
export interface Secret {
  /** The secret's name. */
  readonly secret: string;
}

/** A value the page reads from its own cookie as it sends the request, which never reaches the station. */
export interface Cookie {
  /** The cookie's name. */
  readonly cookie: string;
  /** Text sent before the cookie's value. */
  readonly prefix?: string;
}

/** A header's or a field's value: plain text, or one the station or the home puts in without the acquirer seeing it. */
export type Value = string | Held | Secret | Cookie;

/** One request a page makes of its site. */
interface PageAsk {
  /** Its URL, read against the page's own. */
  readonly url: string;
  /** Its method, `GET` when absent. */
  readonly method?: "GET" | "POST";
  /** Its body, when it sends one. */
  readonly body?: string;
  /** Its headers, by name. */
  readonly headers?: Readonly<Record<string, Value>>;
}

/** A request whose answer is read as JSON. */
type JsonRequest = PageAsk & {
  /** Reads the answer as JSON. */
  readonly as: "json";
  /** Holds the value at a path of the answer under a name for later requests to send, answering only that it was held. */
  readonly hold?: {
    /** The name the value is held under. */
    readonly name: string;
    /** The dotted path of the value in the answer. */
    readonly path: string;
  };
  /** A JSON answer is kept as no file and takes no file's name. */
  readonly name?: never;
};

/** A request whose answer the errand keeps as a file on the home. */
type FileRequest = PageAsk & {
  /** Keeps the answer as a file. */
  readonly as: "file";
  /** The file's name in the errand. */
  readonly name: string;
  /** A file holds no value for later requests. */
  readonly hold?: never;
};

/** One request a tab's page makes, its answer read as JSON or kept as a file. */
export type PageRequest = JsonRequest | FileRequest;

/** A file an errand kept on the home, as the door counted it. */
export interface FileRef {
  /** The file's name in the errand. */
  readonly name: string;
  /** Its size in bytes. */
  readonly bytes: number;
  /** Its SHA-256 in hex. */
  readonly sha256: string;
  /** Where it lies on the home's volume, when it does, so `Errand.move` can take it. */
  readonly path?: string;
}

/** The answer to one request a page made, in that request's own slot of the call. */
export interface PageResponse {
  /** The HTTP status, 0 when no answer came. */
  readonly status: number;
  /** The URL that answered, after any redirect. */
  readonly url: string;
  /** The answer read as JSON, when it was JSON. */
  readonly json?: unknown;
  /** The file the errand kept the answer as, for a file request. */
  readonly file?: FileRef;
  /** The name a value of the answer was held under, for a hold request that found it. */
  readonly held?: string;
  /** Why no answer came. */
  readonly error?: {
    /** The station's code for it, as `PAGE_ERROR`, `TOO_LARGE` or `ORIGIN_REFUSED`. */
    readonly code: string;
    /** The station's words for it. */
    readonly message: string;
  };
}

/** What a page shows that only the person can answer. */
export interface Signals {
  /** It shows a CAPTCHA. */
  readonly captcha: boolean;
  /** It asks for a one-time code. */
  readonly otp: boolean;
  /** It shows a password field. */
  readonly password: boolean;
  /** It asks the person to confirm it is them. */
  readonly verify: boolean;
}

/** How a call finds elements on a page, each match visible. */
export type Locator =
  | {
    /** The element's accessible role. */
    readonly role: string;
    /** Its accessible name, matched as a part of the name in any case unless `exact`. */
    readonly name?: string;
    /** Matches the name whole and in its case. */
    readonly exact?: boolean;
  }
  | {
    /** A form field's label, matched as a part of it in any case. */
    readonly label: string;
  }
  | {
    /** Text the element shows, matched as a part of it in any case. */
    readonly text: string;
  }
  | {
    /** A CSS selector. */
    readonly css: string;
  };

/** What a wait waits for: an element, a URL, an element gone, or the first of several elements. */
export type WaitFor =
  | Locator
  | {
    /** A regular expression the tab's URL matches. */
    readonly url: string;
  }
  | {
    /** An element no longer on the page. */
    readonly gone: Locator;
  }
  | {
    /** Several elements, any one of which ends the wait. */
    readonly any: readonly Locator[];
  };

/** A page as the station reads it for an acquirer. */
export interface Outline {
  /** The page's URL. */
  readonly url: string;
  /** The page's title. */
  readonly title?: string;
  /** Its visible elements one to a line, each with its handle, role, name and state. */
  readonly lines?: string;
  /** What the page shows that only the person can answer. */
  readonly signals: Signals;
  /** The page's words as it shows them, only when asked for. */
  readonly text?: string;
}

/** An element a find matched. */
export interface Found {
  /** The station's handle on the element while the page lasts. */
  readonly ref: string;
  /** The element's accessible role. */
  readonly role: string;
  /** The element's accessible name. */
  readonly name: string;
  /** Whether it is checked, for one that can be. */
  readonly checked?: boolean;
}

/** A tab an errand opened in the person's Chrome. */
export interface Tab {
  /** The id of the errand the tab is in. */
  readonly errand: string;
  /** Reads the page, with its words when asked. */
  snapshot(options?: { text?: boolean }): Promise<Outline>;
  /** Makes requests from inside the page, as the page itself would, answering each in its own slot in order. */
  fetch(requests: readonly PageRequest[]): Promise<PageResponse[]>;
  /** Goes to a URL, answering the origin the tab reached. */
  goto(url: string): Promise<string>;
  /** Every visible element the locator matches. */
  find(target: Locator): Promise<Found[]>;
  /** Clicks the one element the locator finds, answering the origin the tab is on after. */
  click(target: Locator): Promise<string>;
  /** Types text, or a secret by its name, into the one element the locator finds. */
  fill(target: Locator, value: string | Secret): Promise<void>;
  /** Picks an option of the one element the locator finds, answering the option picked. */
  select(target: Locator, option: string): Promise<string>;
  /** Waits up to `ms` for what is wanted, answering the page as it then stands. */
  wait(wanted: WaitFor, ms: number): Promise<Outline>;
}

/** Work a station does for an acquirer in the person's Chrome: its tabs and the files it keeps. */
export interface Errand {
  /** The id the station and the home know the errand by, which a need names to keep its tab for the person. */
  readonly id: string;
  /** Opens a tab at a URL of the errand's origins. */
  open(url: string): Promise<Tab>;
  /** Reads the bytes of a file the errand kept. */
  file(name: string): Promise<Uint8Array>;
  /** Moves a file the errand kept on the home's volume to a path on the same volume. */
  move(name: string, path: string): void;
}

/** The stations the home's door holds, on which an acquirer runs errands in the person's Chrome. */
export interface Stations {
  /** Opens an errand on a station, runs `body` with it and ends it after, unless `body` throws a need whose place is the errand's tab, which stays open for the person. */
  using<T>(spec: ErrandSpec, body: (errand: Errand) => Promise<T>): Promise<T>;
}

export interface DoorStations extends Stations {
  offer(sites: readonly OfferedSite[]): Promise<Record<string, boolean | null>>;
  sites(): Promise<readonly HeldSite[]>;
  present(): Promise<readonly string[]>;
  refused(): Promise<readonly RefusedStation[]>;
  listed(): Promise<readonly string[]>;
}

export interface OfferedSite {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly form?: true;
  readonly signed_in: boolean | null;
  readonly account: SiteAccount | null;
  readonly allowed?: false;
}

export type Choosing = "allowing" | null;

export type HeldSite = Omit<OfferedSite, "account" | "allowed"> & {
  readonly origins: readonly string[];
  readonly chosen: boolean;
  readonly checking: boolean;
  readonly choosing: Choosing;
  readonly stations: readonly { readonly unit: string; readonly signed_in: boolean | null; readonly account: SiteAccount | null; readonly allowed?: boolean }[];
};

export interface RefusedStation {
  readonly unit: string;
  readonly version: string;
  readonly development: boolean;
  readonly since_ms: number;
}

export const EXTENSION_IDS: readonly string[] = ["bioodomopbikaidodldikkkinnpfddin", "bdiidhddmofblpjlbgkckhjfcbgfnfem"];

export function extensionOf(origin: string | undefined): string | null {
  const id = origin?.startsWith("chrome-extension://") ? origin.slice("chrome-extension://".length) : undefined;
  return id !== undefined && EXTENSION_IDS.includes(id) ? id : null;
}

/** A station call that failed, with the station's code. */
export class StationFailed extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "StationFailed";
  }

  constructor(
    /** The station's code, as `NOT_FOUND`, `TIMEOUT` or `SECRET_REFUSED`. */
    readonly code: string,
    message: string,
    /** The page as the station saw it when the call failed, when it read it. */
    readonly snapshot?: Outline,
  ) {
    super(message);
    this.name = "StationFailed";
  }
}

const WAIT_MS = 60_000;

const EXTENSION_REFUSED: Readonly<Record<string, string>> = {
  SITE_NOT_ALLOWED: "Lifestream's Chrome extension isn't allowed on this site. Click Lifestream's icon in Chrome's toolbar, then Allow.",
};

export interface StationsOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly secrets?: Secrets;
  readonly site?: string;
  readonly station?: string;
  readonly survey?: number;
  readonly wait_ms?: number;
}

function refusalIn(text: string): { code?: string; message?: string } {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== "object") return {};
    const { code, message } = value as Record<string, unknown>;
    return { ...(typeof code === "string" ? { code } : {}), ...(typeof message === "string" ? { message } : {}) };
  } catch {
    return {};
  }
}

export function stationsOver(door: string, pass: string, options: StationsOptions = {}): DoorStations {
  const request = options.fetch ?? globalThis.fetch;
  const base = door.replace(/\/+$/u, "");
  const headers = { authorization: `Bearer ${pass}`, "content-type": "application/json" };
  const noDoor = (error: unknown) => new StationFailed("NO_DOOR", `no door answers at ${base}: ${error instanceof Error ? error.message : String(error)}`);
  async function call<T>(method: string, path: string, body: unknown, as: (response: Response) => Promise<T>): Promise<T> {
    let response: Response;
    try {
      response = await request(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw noDoor(error);
    }
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        throw noDoor(error);
      }
      const refused = refusalIn(text);
      throw new StationFailed(refused.code ?? "BAD_CALL", refused.message ?? `the door answered ${response.status}`);
    }
    try {
      return await as(response);
    } catch (error) {
      throw noDoor(error);
    }
  }
  const read = <T>(method: string, path: string, body?: unknown): Promise<T> => call(method, path, body, async (response) => (await response.json()) as T);
  const resolved = <T>(value: T): T => {
    if (value === null || typeof value !== "object" || !("secret" in value)) return value;
    const name = (value as Secret).secret;
    const given = options.secrets?.get(name);
    if (given === undefined || given === "") throw new StationFailed("SECRET_REFUSED", `the home holds no secret "${name}"`);
    return { secret: name, value: given } as T;
  };
  const headersOf = (given: Readonly<Record<string, unknown>> | undefined) =>
    given === undefined ? undefined : Object.fromEntries(Object.entries(given).map(([key, value]) => [key, resolved(value)]));
  return {
    offer: async (sites) => (await read<{ changed?: Record<string, boolean | null> }>("PUT", "/v1/sites", { sites, ...(options.station === undefined ? {} : { station: options.station }), ...(options.survey === undefined ? {} : { survey: options.survey }) })).changed ?? {},
    sites: async () => (await read<{ sites: HeldSite[] }>("GET", "/v1/sites")).sites,
    listed: async () => (await read<{ asked: string[] }>("POST", "/v1/sites")).asked,
    present: async () => (await read<{ stations: { unit: string; present: boolean }[] }>("GET", "/v1/stations")).stations.filter((station) => station.present).map((station) => station.unit),
    refused: async () => (await read<{ refused: RefusedStation[] }>("GET", "/v1/stations")).refused,
    async using(spec, body) {
      const { errand: id } = await read<{ errand: string }>("POST", "/v1/errands", { spec, wait_ms: options.wait_ms ?? WAIT_MS, ...(options.site === undefined ? {} : { site: options.site }), ...(options.station === undefined ? {} : { station: options.station }) });
      const path = `/v1/errands/${encodeURIComponent(id)}`;
      const kept = new Map<string, string>();
      const note = (file: FileRef | undefined): void => {
        if (file?.path !== undefined) kept.set(file.name, file.path);
      };
      async function op(sent: object): Promise<unknown> {
        const result = await read<{ ok: boolean; value?: unknown; error?: { code: string; message: string; snapshot?: Outline } }>("POST", `${path}/calls`, sent);
        if (!result.ok) throw new StationFailed(result.error?.code ?? "BAD_CALL", result.error?.message ?? "the station refused the call", result.error?.snapshot);
        return result.value;
      }
      const errand: Errand = {
        id,
        async open(url) {
          const { tab } = (await op({ op: "open", url })) as { tab: number };
          return {
            errand: id,
            snapshot: async (options = {}) => (await op(options.text === true ? { op: "snapshot", tab, text: true } : { op: "snapshot", tab })) as Outline,
            fetch: async (requests) => {
              const sent = requests.map((one) => ({ ...one, ...(one.headers === undefined ? {} : { headers: headersOf(one.headers) }) }));
              const answers = (await op({ op: "fetch", tab, requests: sent })) as PageResponse[];
              for (const answer of answers) note(answer.file);
              return answers;
            },
            goto: async (url) => ((await op({ op: "goto", tab, url })) as { url: string }).url,
            find: async (target) => (await op({ op: "find", tab, target })) as Found[],
            click: async (target) => ((await op({ op: "click", tab, target })) as { url: string }).url,
            fill: async (target, value) => void (await op({ op: "fill", tab, target, value: resolved(value) })),
            select: async (target, option) => ((await op({ op: "select", tab, target, option })) as { selected: string }).selected,
            wait: async (wanted, ms) => (await op({ op: "wait", tab, for: wanted, ms })) as Outline,
          };
        },
        file: (name) => call("GET", `${path}/files/${name.split("/").map(encodeURIComponent).join("/")}`, undefined, async (response) => new Uint8Array(await response.arrayBuffer())),
        move(name, to) {
          const from = kept.get(name) ?? (() => { throw new StationFailed("BAD_CALL", `the errand kept no file "${name}" on the home's volume`); })();
          renameSync(from, to);
          kept.delete(name);
        },
      };
      let left = false;
      try {
        return await body(errand);
      } catch (error) {
        left = error instanceof NeedsYou && error.at?.errand === id;
        throw error;
      } finally {
        if (!left) await call("DELETE", path, undefined, async () => undefined).catch(() => undefined);
      }
    },
  };
}

export async function runErrand<T>(stations: Stations, spec: ErrandSpec, body: (errand: Errand) => Promise<T>): Promise<T> {
  try {
    return await stations.using(spec, body);
  } catch (error) {
    const origin = spec.origins[0];
    const site = origin === undefined ? spec.name : new URL(origin).host;
    const code = (error as { code?: unknown }).code;
    const says = typeof code === "string" ? EXTENSION_REFUSED[code] : undefined;
    if (says !== undefined) {
      throw new NeedsYou("extension", says, { at: { site }, answered: false, facts: { code: code as string } });
    }
    if (error instanceof NeedsYou && error.at === undefined) {
      throw needWith(error, { at: error.reason === "extension" || origin === undefined ? { site } : { site, open: `${origin}/` } });
    }
    throw error;
  }
}

export function needsOf(signals: Signals | undefined, name: string, at?: Place): NeedsYou | null {
  const where = at === undefined ? {} : { at };
  if (signals?.captcha === true) return new NeedsYou("confirm", `${name} shows a CAPTCHA. Solve it in Chrome.`, where);
  if (signals?.verify === true) return new NeedsYou("confirm", `${name} wants to confirm it's you. Confirm it in Chrome.`, where);
  if (signals?.otp === true) return new NeedsYou("confirm", `${name} asks for a one-time code. Type it in Chrome.`, where);
  if (signals?.password === true) return new NeedsYou("password", `${name} asks for your password. Sign in to ${name} in Chrome.`, where);
  return null;
}

export async function checkPage(tab: Tab, name: string, site: string): Promise<void> {
  const needs = needsOf((await tab.snapshot()).signals, name, { site, errand: tab.errand });
  if (needs !== null) throw needs;
}

const RETRY_WAIT_MS = 5_000;
const LIMITED_TRIES = 6;
const FAILED_TRIES = 3;

/** The site kept answering 429 through every wait, which a site lane turns into a wait for the site. */
export class Limited extends Error {
  /** The error's name, by which it is known across copies of the class. */
  override name = "Limited";

  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === "Limited";
  }
}

/** One file's answer through the page. */
export interface FileAnswer {
  /** The HTTP status, 0 when no answer came. */
  readonly status: number;
  /** The file's bytes, when it answered 200. */
  readonly bytes?: Buffer;
  /** The station's code for why no answer came. */
  readonly error?: string;
}

/** Reads a site's answers through a page of an errand, waiting and asking again while the site limits it or fails for a moment. */
export class PageReads {
  #named = 0;

  constructor(
    protected readonly errand: Errand,
    protected readonly tab: Tab,
    /** The site's name as the person knows it, in the words of the error thrown when the site keeps limiting it. */
    readonly product: string,
    protected readonly sleep: (ms: number) => Promise<void>,
    private readonly options: {
      /** Statuses answered at once, with no wait and no asking again. */
      readonly ends?: readonly number[];
    } = {},
  ) {}

  /** Fetches files through the page, answering each one's status, and its bytes when it came. */
  async files(requests: readonly { url: string; headers?: Readonly<Record<string, Value>> }[]): Promise<FileAnswer[]> {
    const answers = await this.answered(requests.map((request) => ({ ...request, as: "file" as const })));
    return Promise.all(answers.map(async (answer) =>
      answer.status === 200 && answer.file !== undefined ? { status: 200, bytes: Buffer.from(await this.errand.file(answer.file.name)) }
        : { status: answer.status, ...(answer.error === undefined ? {} : { error: answer.error.code }) }));
  }

  protected async answered(requests: readonly (JsonRequest | Omit<FileRequest, "name">)[]): Promise<PageResponse[]> {
    let limited = 0;
    let failed = 0;
    for (;;) {
      let answers: PageResponse[];
      try {
        answers = await this.tab.fetch(requests.map((request) => request.as === "file" ? { ...request, name: `pull/${++this.#named}` } : request));
      } catch (error) {
        if (!(error instanceof StationFailed && error.code === "PAGE_ERROR" && ++failed < FAILED_TRIES)) throw error;
        await this.sleep(RETRY_WAIT_MS * 2 ** (failed - 1));
        continue;
      }
      if (answers.some((answer) => this.options.ends?.includes(answer.status) === true)) return answers;
      if (answers.some((answer) => answer.status === 429)) {
        if (++limited >= LIMITED_TRIES) throw new Limited(`${this.product} kept answering 429`);
        await this.sleep(RETRY_WAIT_MS * 2 ** (limited - 1));
        continue;
      }
      if (answers.some((answer) => answer.status >= 500 || answer.error?.code === "PAGE_ERROR") && ++failed < FAILED_TRIES) {
        await this.sleep(RETRY_WAIT_MS * 2 ** (failed - 1));
        continue;
      }
      return answers;
    }
  }
}
