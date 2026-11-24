import { isObject, type Json } from "@lifestreamprotocol/core";
import { connectorName, roadsOf, siteFormOf, type Connector, type Probe } from "../declaration.js";
import { NeedsYou, type Acquirer } from "../seams.js";
import { needsOf, StationFailed, type Cookie, type DoorStations, type Held, type Stations, type Tab } from "./station.js";

export interface ChromeSite {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly signin?: string;
  readonly form?: true;
  readonly probe: Probe | null;
  readonly who?: NonNullable<Acquirer["who"]>;
  readonly lanes: readonly string[];
}

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly form?: true;
  readonly signed_in: boolean | null;
  readonly account: SiteAccount | null;
  readonly allowed?: false;
}

export type SiteAccount = ({ readonly email: string } | { readonly name: string }) & { readonly verdict: Verdict };

export const VERDICTS = ["read", "not-read", "offered"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** Each account a lane's sources hold, by its id, true where the person reads it and false where they turned it off. */
export type Accounts = Readonly<Record<string, boolean>>;

export function verdictOf(accounts: Accounts, id: string): Verdict {
  const on = accounts[id];
  if (on !== undefined) return on ? "read" : "not-read";
  return Object.keys(accounts).length === 0 ? "read" : "offered";
}

/** The account a site's page is signed in to: the provider's id for it, and the email or the name the person knows it by. */
export type Who =
  | {
    /** The provider's id for the account, which names its source. */
    readonly id: string;
    /** The email the provider gives for the account, by which the home names it to the person. */
    readonly email: string;
  }
  | {
    /** The provider's id for the account, which names its source. */
    readonly id: string;
    /** The account's name, where the provider gives no email. */
    readonly name: string;
  };

export function whoWords(who: Who): string {
  return "email" in who ? who.email : who.name;
}

export function whoNamed(who: Who): { email: string } | { name: string } {
  return "email" in who ? { email: who.email } : { name: who.name };
}

/** The name the station holds the session token a connector's probe reads under, which later requests send as a held header. */
export const TOKEN = "token";

/** Reads one answer through a site's page as a sign-in read needs it: its status, its JSON or bytes, or the name a value of it is held under. */
export type PageRead = (request: { readonly url: string; readonly headers?: Readonly<Record<string, string | Held | Cookie>>; readonly hold?: { readonly name: string; readonly path: string } }) =>
  Promise<{ readonly status: number; readonly json?: Json; readonly held?: string; readonly bytes?: Buffer; readonly failed?: string }>;

/** Reads through a tab's page, each answer read as JSON. */
export function tabRead(tab: Tab): PageRead {
  return async (request) => {
    const [answer] = await tab.fetch([{ ...request, as: "json" }]);
    return { status: answer!.status, ...(answer!.json === undefined ? {} : { json: answer!.json as Json }), ...(answer!.held === undefined ? {} : { held: answer!.held }),
      ...(answer!.error === undefined ? {} : { failed: `${answer!.error.code}: ${answer!.error.message}` }) };
  };
}

export interface Answered {
  readonly status: number;
  readonly url: string;
  readonly failed?: string;
}

export async function signedInAs(probe: Probe, read: PageRead): Promise<
  { readonly in: Who | null; readonly answered: Answered; readonly bytes?: Buffer } | { readonly out: Answered } | { readonly unknown: Answered }> {
  const who = probe.who;
  const named = (answer: Awaited<ReturnType<PageRead>>, url: string) => {
    if (answer.status === 401) return { out: { status: 401, url } };
    const [id, known] = who === undefined ? [] : [idOf(valueAt(answer.json, who.id)), valueAt(answer.json, "email" in who ? who.email : who.name)];
    const found: Who | null = who === undefined || answer.status !== 200 || id === undefined || typeof known !== "string" || known === "" ? null
      : "email" in who ? { id, email: known } : { id, name: known };
    return { in: found, answered: { status: answer.status, url }, ...(found === null || answer.bytes === undefined ? {} : { bytes: answer.bytes }) };
  };
  if ("cookie" in probe) {
    if (who?.url === undefined) throw new Error(`a cookie probe (${probe.cookie}) names no who.url to read whose it is`);
    const answer = await read({ url: who.url, headers: { Authorization: { cookie: probe.cookie, prefix: "Bearer " } } });
    return answer.status === 200 || answer.status === 401 ? named(answer, who.url)
      : { unknown: { status: answer.status, url: who.url, ...(answer.failed === undefined ? {} : { failed: answer.failed }) } };
  }
  const failed = (answer: { status: number }) => (signedOut(answer.status) ? { out: { status: answer.status, url: probe.url } } : { unknown: { status: answer.status, url: probe.url } });
  if (who?.url === undefined) {
    const answer = await read({ url: probe.url });
    return answer.status === 200 && valueAt(answer.json, probe.has) !== undefined ? named(answer, probe.url) : failed(answer);
  }
  const session = await read({ url: probe.url, hold: { name: TOKEN, path: probe.has } });
  if (session.held === undefined) return failed(session);
  return named(await read({ url: who.url, ...(who.bearer === true ? { headers: { Authorization: { held: TOKEN, prefix: "Bearer " } } } : {}) }), who.url);
}

function idOf(value: Json | undefined): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : undefined;
}

/** Reads whose account the page is signed in to by its connector's probe, answering the account and the bytes of the answer that named it, and throws `NeedsYou` when the page is signed out. */
export async function whoIs(product: string, probe: Probe, read: PageRead): Promise<{ who: Who; bytes?: Buffer }> {
  const found = await signedInAs(probe, read);
  if ("out" in found) throw new NeedsYou("signed-out", `Sign in to ${product} in Chrome`);
  if ("unknown" in found) throw new Error(`${product} answered ${found.unknown.status} to its sign-in read ${found.unknown.url}${found.unknown.failed === undefined ? "" : ` (${found.unknown.failed})`}`);
  if (found.in === null) throw new Error(`${product} answered ${found.answered.status} to ${found.answered.url}, naming no account`);
  return { who: found.in, ...(found.bytes === undefined ? {} : { bytes: found.bytes }) };
}

export function chromeSites(connectors: readonly Connector[], acquirers: readonly Acquirer[] = []): ChromeSite[] {
  const sites = new Map<string, { id: string; name: string; origin: string; signin?: string; form?: true; probe: ChromeSite["probe"]; who?: NonNullable<ChromeSite["who"]>; lanes: string[] }>();
  for (const connector of connectors) {
    if (connector.chrome === undefined) continue;
    const { origin, probe, signin } = connector.chrome;
    const site = sites.get(origin) ?? { id: connector.id, name: connectorName(connector), origin, probe, lanes: [] };
    if (site.signin === undefined && signin !== undefined) site.signin = signin.origin;
    if (siteFormOf(connector).length > 0) site.form = true;
    const elsewhere = connector.sources.filter((source) => !roadsOf(source).includes("chrome")).flatMap((source) => [source.read, ...(source.feeders ?? [])]);
    site.lanes.push(...(connector.acquirers ?? []).filter((name) => !elsewhere.includes(name)));
    sites.set(origin, site);
  }
  for (const site of sites.values()) {
    const first = site.probe === null ? acquirers.find((acquirer) => acquirer.name === site.lanes[0]) : undefined;
    if (first?.who !== undefined) site.who = (page) => first.who!(page);
  }
  return [...sites.values()];
}

const PROBE_MS = 60_000;

const PROBE_TRIES = 3;

export function signedOut(status: number): boolean {
  return status === 200 || status === 401 || status === 403;
}

export function valueAt(value: Json | undefined, path: string): Json | undefined {
  let node: Json | undefined = value;
  for (const part of path.split(".")) node = isObject(node) ? node[part] : undefined;
  return node;
}

export async function signedIn(stations: Stations, site: ChromeSite): Promise<{ signed_in: boolean | null; who: Who | null; allowed?: false }> {
  const { probe, who: lane } = site;
  if (probe === null && lane === undefined) return { signed_in: null, who: null };
  for (let tried = 1; ; tried += 1) {
    try {
      return await stations.using({ name: `probe:${site.id}`, origins: siteOrigins(site), ...siteCookies(site.probe), deadline_ms: PROBE_MS }, async (errand) => {
        const tab = await errand.open(`${site.origin}/`);
        const page = await tab.snapshot();
        if (site.signin !== undefined && new URL(page.url).origin === site.signin) return { signed_in: false, who: null };
        const asks = needsOf(page.signals, site.name);
        if (asks !== null) return { signed_in: asks.reason === "password" ? false : null, who: null };
        if (probe === null) {
          try {
            return { signed_in: true, who: await lane!({ errand, tab }) };
          } catch (error) {
            if (error instanceof StationFailed) throw error;
            return { signed_in: error instanceof NeedsYou && error.reason === "signed-out" ? false : null, who: null };
          }
        }
        const found = await signedInAs(probe, tabRead(tab));
        return "in" in found ? { signed_in: true, who: found.in } : { signed_in: "out" in found ? false : null, who: null };
      });
    } catch (error) {
      if (error instanceof StationFailed && error.code === "INTERRUPTED" && tried < PROBE_TRIES) continue;
      if (error instanceof StationFailed) return { signed_in: null, who: null, ...(error.code === "SITE_NOT_ALLOWED" ? { allowed: false as const } : {}) };
      throw error;
    }
  }
}

export function siteOrigins(site: { readonly origin: string; readonly signin?: string | undefined; readonly probe: Probe | null }): string[] {
  const who = site.probe?.who?.url;
  const reads = who === undefined || !/^https?:\/\//u.test(who) ? [] : [new URL(who).origin];
  return [...new Set([site.origin, ...(site.signin === undefined ? [] : [site.signin]), ...reads])];
}

export function siteCookies(probe: Probe | null): { readonly cookies?: readonly string[] } {
  return probe !== null && "cookie" in probe ? { cookies: [probe.cookie] } : {};
}

export async function survey(stations: DoorStations, sites: readonly ChromeSite[], verdict: (site: ChromeSite, id: string) => Verdict): Promise<{ sites: readonly Site[]; changed: Record<string, boolean | null> }> {
  const found: Site[] = [];
  for (const site of sites) {
    const { signed_in, who, allowed } = await signedIn(stations, site);
    found.push({
      id: site.id, name: site.name, origin: site.origin, ...(site.form ? { form: true as const } : {}),
      signed_in, account: who === null ? null : { ...whoNamed(who), verdict: verdict(site, who.id) }, ...(allowed === false ? { allowed } : {}),
    });
  }
  return { sites: found, changed: await stations.offer(found) };
}
