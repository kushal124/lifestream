import dgram from "node:dgram";
import { mkdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join } from "node:path";
import { crc32 } from "node:zlib";
import {
  chromeSites, credentialText, fakeImap, FakeRelay, LENT, loginRefused, memorySecrets, NeedsYou, NotYet, oauthCredential, ownExport, pollCall, refusedWith, roadsOf, secretFieldOf,
  type Acquirer, type Connector, type Entry, type KeptPoll, type OAuthCredential, type Secrets,
} from "@lifestreamprotocol/connect";
import type { Dependencies, FakeMailbox, FakePage, Files, Fixture, ImapConnection, ItemOf, Provider as Fake, Scenario, Site, SiteAnswer } from "@lifestreamprotocol/connect/sdk";
import { UNDATED, type JsonObject } from "@lifestreamprotocol/core";
import { copyOf } from "./catalog.js";
import { checkoutLanding, inspectLanding, landDelivery, landImport, readerOf, type Landing, type Skipped } from "./fixture-day.js";
import { errorText } from "./jobs.js";
import { borrowTrialWorker, discardTrialWorker, releaseTrialWorker } from "./folders.js";
import type { Loaded } from "./registry.js";
import type { Settings } from "./settings.js";
import { monthsIn } from "./through.js";

const MAC = "macbook-pro-0001";
export const N = 12;
export const WALK_CALLS = 50;
export const START_MS = Date.UTC(2026, 8, 15, 12);
export const LIMIT_S = 30;
export const CASE_MS = 15_000;
export const RUN_MS = 120_000;
const CURSOR_SLACK = 16;
const NEW_RULE = "an item is new when the scenario adds it after the run's first fetch, whatever time its record states";
const OLD_RULE = "an item is old when the source held it at the run's first fetch, the scenario's first `old`, whatever time its record states";
export const NOTHING_NEW_RULE = "a fetch that finds nothing new returns `files: []` and its cursor, and the home seals nothing; only an impediment is a `NotYet`";
export const WHO_RULE = "a Chrome site's first lane has `who` exactly when the site declares `chrome.probe: null`, and its other lanes have none: the home reads whose account Chrome holds by the probe, and by the first lane's `who` where it has none";
export const STAMPED_RULE = "an item added after a fetch is new though it states the very time of the newest item that fetch sealed: an acquirer judges new by what it sealed, never by time alone";
export const START_RULE = "a page stays within the start the home lent it: it lands nothing its source dates before `lent.start_ms`, the UTC midnight of the stream's start";
export const FETCH_START_RULE = "a fetch stays within the start the home lent it, as a page does: it lands nothing its source dates before `lent.start_ms`, an item new to the source but dated before the start, or one dated before it and edited since, among them";
export const EARLIER_RULE = "a start moved earlier reads what the old start left out: the next calls land every item its source dates from `lent.start_ms` up to `lent.from_ms`, the start the cursor was left under, whichever call, fetch or page, sees the move first";
export const LATER_RULE = "a start moved later lands nothing its source dates before it, and the walk ends at it with `left: 0`";
export const BACK_RULE = "a start moved later and then back earlier reads the gap: an acquirer compares `lent.start_ms` with `lent.from_ms`, the start its cursor was left under, and keeps no start of its own";
export const MONTHS_RULE = "an acquirer that says `months: true` answers `months` on the first page of each walk and on no other, every item of its source by the UTC month the page dates it by; one that does not say it answers none";
export const ANSWERED_RULE = "a call says `answered: false` exactly when it made no request of the provider, so the home moves the copy's contact only on an answer";

export interface AcquirerFakes {
  readonly provider?: (scenario: Scenario) => Fake;
  readonly mailbox?: (scenario: Scenario) => FakeMailbox;
  readonly site?: (scenario: Scenario) => Site;
  readonly files?: (scenario: Scenario) => Files;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly item?: ItemOf;
  readonly dated?: Dated;
  readonly fixtures?: Readonly<Record<string, Fixture>>;
  readonly immutable?: true;
}

export type Dated = (scenario: Scenario, n: number) => number | null;

export interface ProvedAcquirer {
  readonly name: string;
  readonly settings: JsonObject;
}

export interface Limits {
  readonly case_ms: number;
  readonly run_ms: number;
}

export interface ProveAsk {
  readonly prove: {
    readonly dir: string;
    readonly work: string;
    readonly settings: Settings;
    readonly acquirers?: readonly ProvedAcquirer[];
  };
}

export type ProofEvent =
  | { proof: "case"; name: string; of?: string }
  | { proof: "acquirers"; names: string[] }
  | { proof: "fault"; text: string }
  | { proof: "line"; text: string }
  | { proof: "done"; ids: string[]; polls: boolean };

export interface Proved {
  readonly faults: string[];
  readonly lines: string[];
  readonly ids: string[];
  readonly polls: boolean;
}


export async function proveAcquirers(proof: ProveAsk["prove"] & { readonly acquirers: readonly ProvedAcquirer[]; readonly limits?: Limits }): Promise<{ faults: string[]; lines: string[] }> {
  const { limits, ...prove } = proof;
  const { faults, lines } = await runProof({ prove }, limits);
  return { faults, lines };
}

const seconds = (ms: number) => (ms % 60_000 === 0 && ms >= 60_000 ? `${ms / 60_000} minute${ms === 60_000 ? "" : "s"}` : `${ms / 1000} s`);

const HANGS = {
  "the run": "the run's child never began it",
  "the folder": "its module, test/fixture.ts or an acquirer's factory never returned: a home's start would hang on the folder the same way",
  "the fixtures": "a fixture, a reader or an adapter never returned: on a home its import or its family's extract would hang the same way",
  "each fixture alone": "a fixture or its reader never returned, over its whole delivery or one with a file spoiled: on a home its import would hang the same way",
  case: "a call waiting on what the run never answers (a request outside `fetch`, a wait outside `sleep`) hangs a home's poll the same way",
} as const;

export function runProof(ask: ProveAsk, limits: Limits = { case_ms: CASE_MS, run_ms: RUN_MS }): Promise<Proved> {
  return new Promise((done) => {
    const faults: string[] = [];
    const lines: string[] = [];
    const deadline = Date.now() + limits.run_ms;
    const worker = borrowTrialWorker(true, [ask.prove.dir]);
    const { child } = worker;
    let current: { name: string; of?: string } = { name: "the run" };
    const announced: string[] = [];
    const begun = new Set<string>();
    let out = "";
    let err = "";
    let ended = false;
    let timer: NodeJS.Timeout | undefined;
    const end = (fault?: string, declared: { ids: string[]; polls: boolean } = { ids: [], polls: false }) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      child.stdout?.off("data", onOut);
      child.stderr?.off("data", onErr);
      child.off("error", onError);
      child.off("close", onClose);
      child.stdin?.off("error", onStdinError);
      if (fault === undefined) releaseTrialWorker(worker);
      else discardTrialWorker(worker);
      if (fault !== undefined) {
        const at = current.of === undefined ? current.name : `${current.of} ${current.name}`;
        faults.push(`${current.of === undefined ? "" : `acquirers.${current.of}: `}${current.name}: ${fault}`);
        if (current.of !== undefined) lines.push(`${current.of} the cases after ${current.name}: not run (the run ended at ${current.name})`);
        for (const name of announced) if (!begun.has(name)) lines.push(`${name}: not run (the run ended at ${at})`);
      }
      done({ faults, lines, ...declared });
    };
    const arm = () => {
      clearTimeout(timer);
      const left = deadline - Date.now();
      const hangs = current.of !== undefined ? HANGS.case : HANGS[current.name as keyof typeof HANGS] ?? HANGS.case;
      timer = left < limits.case_ms
        ? setTimeout(() => end(`the run passed its ${seconds(limits.run_ms)} and was killed`), Math.max(0, left))
        : setTimeout(() => end(`did not end in ${seconds(limits.case_ms)} and was killed: ${hangs}`), limits.case_ms);
    };
    const read = (line: string) => {
      let event: ProofEvent;
      try {
        event = JSON.parse(line) as ProofEvent;
      } catch {
        return;
      }
      if (typeof event !== "object" || event === null || !("proof" in event)) return;
      if (event.proof === "case") {
        current = { name: event.name, ...(event.of === undefined ? {} : { of: event.of }) };
        if (event.of !== undefined) begun.add(event.of);
        arm();
      } else if (event.proof === "acquirers") announced.push(...event.names);
      else if (event.proof === "fault") faults.push(event.text);
      else if (event.proof === "line") lines.push(event.text);
      else end(undefined, { ids: event.ids, polls: event.polls });
    };
    const onOut = (chunk: Buffer) => {
      out += chunk.toString("utf8");
      for (let at = out.indexOf("\n"); at >= 0; at = out.indexOf("\n")) {
        read(out.slice(0, at));
        out = out.slice(at + 1);
        if (ended) return;
      }
    };
    const onErr = (chunk: Buffer) => { err += chunk.toString("utf8"); };
    const onError = (error: Error) => end(`could not be run: ${error.message}`);
    const onStdinError = () => undefined;
    const onClose = (code: number | null) => {
      if (code === 13) end(`it awaits a promise nothing settles: ${current.of === undefined ? "it never ends, and on a home it never would" : "its call never ends, and on a home its poll never would"}`);
      else end(`ended with ${code === null ? "a kill" : code} before it finished: ${err.trim().split("\n").findLast((each) => /\w*Error\b/u.test(each)) ?? err.trim().split("\n").at(-1) ?? "no word"}`);
    };
    arm();
    child.stdout!.on("data", onOut);
    child.stderr!.on("data", onErr);
    child.on("error", onError);
    child.on("close", onClose);
    child.stdin!.on("error", onStdinError);
    child.stdin!.write(`${JSON.stringify(ask)}\n`);
  });
}


const connected: string[] = [];

export function guardConnections(): void {
  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    const target = targetOf(args);
    connected.push(target);
    process.nextTick(() => this.destroy(Object.assign(new Error(`connect ECONNREFUSED ${target}: lifestream connectors test refuses every connection it does not answer itself`), { code: "ECONNREFUSED" })));
    return this;
  } as typeof net.Socket.prototype.connect;
  const refusedDatagram = function (this: dgram.Socket, ...args: unknown[]) {
    const port = args.find((each) => typeof each === "number");
    const host = args.find((each, index) => index > 0 && typeof each === "string");
    const target = `udp ${typeof host === "string" ? host : "localhost"}:${String(port ?? "?")}`;
    connected.push(target);
    const callback = args.findLast((each) => typeof each === "function") as ((error: Error) => void) | undefined;
    const error = Object.assign(new Error(`ECONNREFUSED ${target}: lifestream connectors test refuses every connection it does not answer itself`), { code: "ECONNREFUSED" });
    process.nextTick(() => (callback === undefined ? this.emit("error", error) : callback(error)));
  };
  dgram.Socket.prototype.send = refusedDatagram as typeof dgram.Socket.prototype.send;
  dgram.Socket.prototype.connect = refusedDatagram as typeof dgram.Socket.prototype.connect;
}

function targetOf(args: readonly unknown[]): string {
  const [first, second] = Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
  if (typeof first === "object" && first !== null) {
    const options = first as { host?: string; port?: number | string; path?: string };
    return options.path ?? `${options.host ?? "localhost"}:${String(options.port ?? "?")}`;
  }
  if (typeof first === "number" || (typeof first === "string" && /^\d+$/u.test(first))) return `${typeof second === "string" ? second : "localhost"}:${String(first)}`;
  return String(first);
}

export function connections(): readonly string[] {
  return connected;
}

export function resetConnections(): void {
  connected.length = 0;
}

export interface AcquirerContext {
  readonly folder: Entry & { readonly digest?: string };
  readonly fakes: AcquirerFakes | null;
  readonly registry: Loaded;
  readonly work: string;
  readonly settings: Settings;
  readonly skipped?: Skipped;
}

export function acquirerSink(name: string, emit: (event: ProofEvent) => void): Sink {
  return {
    case: (each) => emit({ proof: "case", name: each, of: name }),
    fault: (text) => emit({ proof: "fault", text: `acquirers.${name}: ${text}` }),
    line: (text) => emit({ proof: "line", text: `${name} ${text}` }),
  };
}

export async function proveAcquirer(context: AcquirerContext, proved: ProvedAcquirer, sink: Sink): Promise<void> {
  connected.length = 0;
  direct.length = 0;
  const exported = context.folder.connectors.find((each) => each.id === proved.name && ownExport(each) !== null && !Object.hasOwn(context.folder.acquirers ?? {}, proved.name));
  if (exported !== undefined) return guarded(() => importsIn(context, exported, sink));
  const connector = context.folder.connectors.find((each) => (each.acquirers ?? []).includes(proved.name));
  const factory = context.folder.acquirers?.[proved.name];
  if (connector === undefined || factory === undefined) throw new Error(`${proved.name} is no acquirer a connector of the folder names`);
  let acquirer: Acquirer;
  try {
    acquirer = factory({ ...proved.settings, work: context.work, zone: context.settings.day.zone, unit: MAC } as never);
  } catch (error) {
    sink.fault(`not built from its blocks and the fixture's settings: ${errorText(error).split("\n")[0]}`);
    return;
  }
  const built: Built = { ...proved, connector, factory };
  const input = inputOf(built);
  const whoFault = whoFaultOf(context.folder.connectors, connector, proved.name, acquirer);
  if (whoFault !== null) sink.fault(whoFault);
  const fake = input === "a folder poll" ? "files" : input === "a Chrome site" ? "site" : "provider";
  const template = { "a folder poll": "folder", "a Chrome site": "browser", provider: "api" }[input];
  if (context.fakes?.[fake] === undefined && (fake !== "provider" || context.fakes?.mailbox === undefined)) {
    sink.fault(`its acquirer would meet its first input in Lifestream: export \`${fake}\` from test/fixture.ts (templates/${template})${fake === "provider" ? ", or `mailbox` for one that reads mail over IMAP" : ""}`);
    return;
  }
  if (typeof context.fakes.item !== "function") {
    sink.fault(`its walks are read by the items they land: export \`item\` from test/fixture.ts, which item of the scenario a record it lands is, by its kind and key (ItemOf; templates/${template})`);
    return;
  }
  if (acquirer.page !== undefined && typeof context.fakes.dated !== "function") {
    sink.fault(`its history is walked from the start the home lends its \`page\`: export \`dated\` from test/fixture.ts, when its fake dates item n of the scenario, in ms since the epoch (templates/${template})`);
    return;
  }
  if (input !== "a folder poll" && typeof context.fakes.dated !== "function") {
    sink.fault(`its fetch is held to land an item stamped at the very time of the newest it sealed: export \`dated\` from test/fixture.ts, when its fake dates item n of the scenario, in ms since the epoch, at \`scenario.stamped[n]\` where the scenario stamps it (templates/${template})`);
    return;
  }
  await guarded(() => walks(context, built, input === "a Chrome site" ? "site" : input === "a folder poll" ? "folder" : "provider", sink));
}

function whoFaultOf(connectors: readonly Connector[], connector: Connector, name: string, acquirer: Acquirer): string | null {
  const origin = connector.chrome?.origin;
  const site = origin === undefined ? undefined : chromeSites(connectors).find((each) => each.origin === origin);
  const asked = site !== undefined && site.probe === null && site.lanes[0] === name;
  if (acquirer.who !== undefined && !asked) {
    const why = site === undefined ? `${connector.id} is no Chrome site` : site.probe !== null ? `${site.id} declares a \`chrome.probe\`` : `${site.lanes[0]} is its site's first lane, not ${name}`;
    return `who: it has \`who\`, and ${why}, so the home never asks it (${WHO_RULE})`;
  }
  if (acquirer.who === undefined && asked) return `who: it has no \`who\`, and ${site.id} declares \`chrome.probe: null\`, so the home never learns whose account Chrome holds (${WHO_RULE})`;
  return null;
}

async function guarded(work: () => Promise<void>): Promise<void> {
  const global = globalThis.fetch;
  globalThis.fetch = (request) => {
    direct.push(request instanceof Request ? request.url : String(request));
    return Promise.reject(new Error("a request through the global fetch: every request goes through the `fetch` the acquirer is built with"));
  };
  try {
    await work();
  } finally {
    globalThis.fetch = global;
  }
}

function inputOf({ connector }: Built): "a Chrome site" | "a folder poll" | "provider" {
  if (connector.chrome !== undefined || connector.sources.some((source) => roadsOf(source).includes("chrome"))) return "a Chrome site";
  if (Object.values(connector.fields ?? {}).some((field) => field.kind === "path")) return "a folder poll";
  return "provider";
}

const direct: string[] = [];

export interface Sink {
  case(name: string): void;
  fault(text: string): void;
  line(text: string): void;
}

interface Built extends ProvedAcquirer {
  readonly connector: Connector;
  readonly factory: (settings: never, dependencies?: Dependencies) => Acquirer;
}


function scratchHome(context: AcquirerContext): { home: Landing; release(): void } {
  const checked = checkoutLanding(context.registry, context.settings);
  mkdirSync(join(checked.home.folder.root, "work"));
  return checked;
}

async function reachesTheDay(context: AcquirerContext, proved: Pick<Built, "connector">, home: Landing, sealed: readonly string[], sink: Sink): Promise<void> {
  sink.case("reaches the day");
  const sources = new Map(sealed.map((source) => [source, readerOf(proved.connector, source)]));
  const inspected = await inspectLanding(home, context.folder, sources, context.skipped === undefined ? {} : { skipped: context.skipped });
  for (const fault of inspected.faults) sink.fault(`reaches the day: ${fault}`);
  if (inspected.faults.length > 0) return;
  sink.line(`reaches the day: run, ${inspected.records} record${inspected.records === 1 ? "" : "s"} read to ${inspected.days} day${inspected.days === 1 ? "" : "s"} and search`);
  const dated = inspected.lines.filter((line) => DAY_LINE.test(line));
  const first = dated[0]?.slice(0, 10);
  const shown = [
    ...dated.filter((line) => line.startsWith(`${first} `)).slice(0, SHOWN_LINES),
    ...inspected.lines.filter((line) => line.startsWith("search ")).slice(0, 1),
    ...inspected.lines.filter((line) => line.startsWith("open ")).slice(0, 1),
  ];
  for (const line of shown) sink.line(`reaches the day: ${line}`);
}

const DAY_LINE = /^\d{4}-\d{2}-\d{2} /u;
const SHOWN_LINES = 6;

async function seen(context: AcquirerContext, proved: Pick<Built, "connector">, home: Landing, sources: readonly string[]): Promise<string[]> {
  const read = new Map([...new Set(sources)].map((source) => [source, readerOf(proved.connector, source)]));
  return (await inspectLanding(home, context.folder, read)).lines;
}

function changeLines(before: readonly string[], after: readonly string[]): string[] {
  const out = before.filter((line) => !after.includes(line)).map((line) => `- ${line}`);
  const into = after.filter((line) => !before.includes(line)).map((line) => `+ ${line}`);
  const all = [...out, ...into];
  return all.length > SHOWN_LINES ? [...all.slice(0, SHOWN_LINES), `… and ${all.length - SHOWN_LINES} more lines`] : all;
}

function ledgerChanges(before: Ledger, after: Ledger): Pick<Walk, "added" | "changed"> {
  const added: Held[] = [];
  const changed: { before: Held; after: Held }[] = [];
  for (const [key, held] of after) {
    const was = before.get(key);
    if (was === undefined) added.push(held);
    else if (held.versions.length > was.versions.length) changed.push({ before: was, after: held });
  }
  return { added, changed };
}

const IMMUTABLE = "test/fixture.ts exports `immutable`: its source's items never change once captured";

function editFault(landed: Pick<Walk, "added" | "changed">, edited: number, after: string, immutable: boolean): string | null {
  if (immutable) {
    const landedAny = [...landed.added, ...landed.changed.map(({ after: held }) => held)];
    return landedAny.length === 0 ? null : `edits: item ${edited} edited, ${after} landed ${landedAny.length} record${landedAny.length === 1 ? "" : "s"} new or as another version${itemsIn(landedAny).size > 0 ? ` (${listed(itemsIn(landedAny))})` : ""}: ${IMMUTABLE}, so an edit lands nothing`;
  }
  const changed = landed.changed.map(({ after: held }) => held);
  const versioned = changed.filter((held) => held.versions.at(-1) !== "gone");
  const gone = changed.filter((held) => held.versions.at(-1) === "gone");
  const others = (records: readonly Held[]) => [...itemsIn(records)].filter((n) => n !== edited);
  const unitemed = changed.filter((each) => each.item === null).length;
  const said = [
    ...(itemsIn(versioned).has(edited) ? [] : ["landed no new version of it"]),
    ...(others(versioned).length > 0 ? [`landed new versions of ${listed(others(versioned))}`] : []),
    ...(others(gone).length > 0 ? [`stated records of ${listed(others(gone))} gone`] : []),
    ...(unitemed > 0 ? [`changed ${unitemed} record${unitemed === 1 ? "" : "s"} of no item`] : []),
    ...(landed.added.length > 0 ? [`landed ${landed.added.length} new records`] : []),
  ];
  return said.length === 0 ? null : `edits: item ${edited} edited, ${after} ${said.join(", ")}: the edited item lands a new version, and nothing else does`;
}

function removalVerdict(landed: Pick<Walk, "added" | "changed">, removed: number, its: readonly string[], ledger: Ledger, ofFolder: boolean): { fault: string } | { gone: number } {
  const gone = landed.changed.filter(({ after }) => after.versions.at(-1) === "gone").map(({ after }) => after);
  const other = landed.added.length + landed.changed.length - gone.length;
  const wrong = gone.filter((each) => each.item !== removed);
  const left = its.map((key) => ledger.get(key)!).filter((each) => each.versions.at(-1) !== "gone");
  if (other > 0) return { fault: `removals: one item removed changed ${other} other records: a removal changes nothing else` };
  if (ofFolder && gone.length === 0) return { fault: "removals: a file deleted from the folder was never stated gone: a folder poll states a removal, a path its memory holds (lent.memory) that its walk no longer finds" };
  if (wrong.length > 0) return { fault: `removals: item ${removed} removed, and ${wrong.length} record${wrong.length === 1 ? "" : "s"} of ${wrong.every((each) => each.item === null) ? "no item" : listed(itemsIn(wrong))} went gone: only the removed item goes` };
  if (gone.length > 0 && left.length > 0) {
    const named = left.slice(0, 3).map((each) => `${each.kind} ${each.key}`).join(", ") + (left.length > 3 ? ", …" : "");
    return { fault: `removals: item ${removed} removed, and ${left.length} of its ${its.length} records still live (${named}): a removal states every record of the removed item gone` };
  }
  return { gone: gone.length };
}

const liveOf = (ledger: Ledger, removed: number) => [...ledger].filter(([, each]) => each.item === removed && each.versions.at(-1) !== "gone").map(([key]) => key);

interface Held {
  readonly kind: string;
  readonly key: string;
  readonly versions: readonly string[];
  readonly item: number | null;
}

type Ledger = ReadonlyMap<string, Held>;

interface Answer {
  readonly status: number;
  readonly retry_s?: number;
  readonly error?: string;
}

interface Run {
  readonly home: Landing;
  readonly kept: KeptPoll;
  readonly acquirer: Acquirer;
  readonly secrets: Secrets & { values: Record<string, string> };
  scenario: Scenario;
  readonly item: ItemOf;
  clock: number;
  requests: number;
  answer: ((n: number, url: URL, grant: string | null) => Answer | undefined) | undefined;
  signin?: URL;
  start_ms: number | null;
  readonly relay?: FakeRelay;
  token?: string;
  readonly refreshes: { sent: string | null; answered: string | null }[];
  sealed_ms: number;
  readonly sealings: { source: string; facts: JsonObject; files: number }[];
  unimported?: string;
  misread?: string;
  contact?: string;
  ledger: Ledger;
  readonly folder?: Placed;
}

function datesOf(dated: Dated, scenario: Scenario, items = scenario.old): number[] | string {
  const dates: number[] = [];
  for (let n = 0; n < items; n++) {
    let at: unknown;
    try {
      at = dated(scenario, n);
    } catch (error) {
      return `its dated threw on item ${n}: ${errorText(error).split("\n")[0]}`;
    }
    if (typeof at !== "number" || !Number.isFinite(at)) return `its dated names ${JSON.stringify(at)} for item ${n}: \`dated\` is when its fake dates an item, in ms since the epoch`;
    dates.push(at);
  }
  return dates;
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const midnightOf = (day: string) => Date.parse(`${day}T00:00:00Z`);

interface Cut {
  readonly old: number;
  readonly start_ms: number;
  readonly earliest_ms: number;
  readonly dates: readonly number[];
  readonly before: number;
}

function cutOf(dated: Dated): Cut | string | null {
  for (let old = N; old <= 256 * N; old *= 4) {
    const dates = datesOf(dated, scenarioOf(old, { items: old }));
    if (typeof dates === "string") return dates;
    const start_ms = midnightOf(dayOf(dates[Math.floor(old / 2)]!));
    const before = dates.filter((at) => at < start_ms).length;
    if (before > 0) return { old, start_ms, earliest_ms: midnightOf(dayOf(Math.min(...dates))), dates, before };
  }
  return null;
}

function startOf(dated: Dated | undefined, scenario: Scenario): number | null | string {
  if (dated === undefined || scenario.old === 0) return null;
  const dates = datesOf(dated, scenario);
  return typeof dates === "string" ? dates : midnightOf(dayOf(Math.min(...dates)));
}

function scenarioOf(old: number, more: Partial<Scenario> = {}): Scenario {
  return { items: 2 * old, old, edited: [], removed: [], start_ms: START_MS, ...more };
}

function secretsOf(acquirer: Built, fakes: AcquirerFakes | null): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [given, value] of Object.entries(fakes?.secrets ?? {})) {
    const field = acquirer.connector.fields?.[given];
    const built = acquirer.settings[given];
    values[field?.kind === "secret" ? (typeof built === "string" ? built : field.secret) : given] = value;
  }
  return values;
}

const endpointOf = (url: URL) => `${url.origin}${url.pathname}`;

const signedOutSite = (signin: URL) => `a signed-out site, every page sent to ${signin.href}, a sign-in there refused, no session held and every request answered 401`;

const SIGNED_OUT = "its discovery documents answered as before, every refresh 400 invalid_grant and every other request 401";
const signedOutProvider = (_: number, url: URL, grant: string | null): Answer | undefined =>
  url.pathname.startsWith("/.well-known/") ? undefined : grant === "refresh_token" ? { status: 400, error: "invalid_grant" } : { status: 401 };

async function sentToken(request: Request): Promise<string | null> {
  return new URLSearchParams(await request.text()).get("refresh_token");
}

async function answeredToken(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { refresh_token?: unknown };
    return typeof body.refresh_token === "string" ? body.refresh_token : null;
  } catch {
    return null;
  }
}


interface Walk {
  readonly calls: number;
  readonly answered: number;
  readonly sealed: number;
  readonly requests: number;
  readonly waits: readonly { how: "NotYet" | "backoff_ms"; until: number }[];
  readonly error?: unknown;
  readonly overrun: boolean;
  readonly added: readonly Held[];
  readonly changed: readonly { before: Held; after: Held }[];
  readonly cursor_bytes: number;
}

async function walks(context: AcquirerContext, proved: Built, input: "provider" | "site" | "folder", sink: Sink): Promise<void> {
  const runs: Run[] = [];
  const site = input === "site";
  const folder = input === "folder";
  const field = folder ? pathFieldOf(proved.connector) : undefined;
  const ofFolder = field?.folder === true;
  const poll = ofFolder ? "a folder poll" : "a poll of a file";
  const reads = ofFolder ? "the files of its folder" : "its file";
  let baseRelease: (() => void) | undefined;
  let scratchRelease: (() => void) | undefined;
  const open = (scenario: Scenario, start_ms?: number): Run => {
    if (baseRelease !== undefined) {
      scratchRelease?.();
      scratchRelease = undefined;
    }
    const { home, release } = scratchHome(context);
    if (baseRelease === undefined) baseRelease = release;
    else scratchRelease = release;
    const placed = field === undefined ? undefined : placedFor(field, join(home.folder.root, "folder"), context.fakes!.files!(scenario));
    const fakes = new Map<Scenario, Fake>();
    const mailboxes = new Map<Scenario, ReturnType<typeof fakeImap>>();
    const mailboxOf = (connection: ImapConnection) => {
      if (context.fakes?.mailbox === undefined) {
        connected.push(`${connection.host}:${connection.port}`);
        throw new Error("a connection through `imap`, and test/fixture.ts exports no `mailbox` to answer it");
      }
      if (!mailboxes.has(run.scenario)) {
        const mailbox = fakeImap({ ...context.fakes.mailbox(run.scenario) });
        mailbox.before = (command) => {
          run.requests++;
          const own = run.answer?.(run.requests, new URL(`imap://${connection.host}:${connection.port}/${command}`), null);
          if (own === undefined) return;
          if (own.status === 401 && command === "connect") throw loginRefused(connection.password);
          throw own.status === 429 ? refusedWith("THROTTLED", "Request throttled. Try again later.") : refusedWith("UNAVAILABLE", `Server answered ${own.status}`);
        };
        mailboxes.set(run.scenario, mailbox);
      }
      return mailboxes.get(run.scenario)!.imap(connection);
    };
    const sites = new Map<Scenario, Site>();
    const siteOf = (run: Run) => {
      if (!sites.has(run.scenario)) sites.set(run.scenario, context.fakes!.site!(run.scenario));
      return sites.get(run.scenario)!;
    };
    const dependencies: Dependencies = {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        if (site || folder) {
          direct.push(request.url);
          throw new Error(site ? "a request outside the station: a site's every request is the station's (`pull`)" : `a request from ${poll}, which reads ${reads} and requests nothing`);
        }
        if (context.fakes!.provider === undefined) {
          direct.push(request.url);
          throw new Error("a request through `fetch`, and test/fixture.ts exports no `provider` to answer it");
        }
        run.requests++;
        const url = new URL(request.url);
        const grant = request.method === "POST" ? new URLSearchParams(await request.clone().text()).get("grant_type") : null;
        const own = run.answer?.(run.requests, url, grant);
        if (own !== undefined) return Response.json(own.error === undefined ? {} : { error: own.error }, { status: own.status, headers: own.retry_s === undefined ? {} : { "retry-after": String(own.retry_s) } });
        if (!fakes.has(run.scenario)) fakes.set(run.scenario, context.fakes!.provider!(run.scenario));
        if (run.token === undefined || endpointOf(url) !== run.token) return await fakes.get(run.scenario)!(request);
        const sent = await sentToken(request.clone());
        const response = await fakes.get(run.scenario)!(request);
        run.refreshes.push({ sent, answered: response.ok ? await answeredToken(response.clone()) : null });
        return response;
      },
      now: () => run.clock,
      sleep: async (ms) => {
        run.clock += ms;
      },
      imap: (connection) => {
        if (site || folder) {
          connected.push(`${connection.host}:${connection.port}`);
          throw new Error(site ? "a connection outside the station: a site's every request is the station's (`pull`)" : `a connection from ${poll}, which reads ${reads} and connects to nothing`);
        }
        return mailboxOf(connection);
      },
    };
    const at = placed === undefined ? {} : { [placed.field]: placed.path };
    const built = proved.factory({ ...proved.settings, ...at, work: join(home.folder.root, "work"), zone: context.settings.day.zone, unit: MAC } as never, dependencies);
    const relay = site ? new FakeRelay(delegated(() => siteOf(run), (n, url) => run.answer?.(n, url, null), () => ++run.requests, () => run.signin)) : undefined;
    const start = start_ms ?? startOf(context.fakes!.dated, scenario);
    const run: Run = {
      home, kept: { state: null }, scenario, item: context.fakes!.item!, clock: START_MS, requests: 0, answer: undefined, sealed_ms: 0, ledger: new Map(), refreshes: [], sealings: [],
      start_ms: typeof start === "string" ? null : start, ...(typeof start === "string" ? { misread: start } : {}),
      secrets: memorySecrets(secretsOf(proved, context.fakes)),
      acquirer: relay === undefined ? built : relay.lend(built),
      ...(relay === undefined ? {} : { relay }),
      ...(placed === undefined ? {} : { folder: placed }),
    };
    runs.push(run);
    return run;
  };
  const say = (line: string) => sink.line(line);
  const fail = (fault: string) => sink.fault(fault);
  let stopped = false;
  const ended = (name: string, call: "fetch" | "page", run: Run, walk: Walk): boolean => {
    if (stopped) return false;
    if (direct.length > 0) {
      stopped = true;
      fail(site
        ? `${name}: it requests ${direct[0]} outside the station: a site's every request is the station's (\`pull\`), made in the person's Chrome`
        : folder
          ? `${name}: it requests ${direct[0]}: ${poll} reads ${reads} and requests nothing`
          : `${name}: it requests ${direct[0]} through the global fetch, a direct call: every request goes through the \`fetch\` it is built with (Dependencies.fetch; \`request\`'s fetch option)`);
      return false;
    }
    if (connected.length > 0) {
      stopped = true;
      fail(folder
        ? `${name}: it connects to ${connected[0]}, refused: ${poll} reads ${reads} and connects to nothing`
        : `${name}: it connects to ${connected[0]} outside ${site ? "the station" : "`fetch` and `imap`"}, refused: every request goes through ${site ? "the station (`pull`)" : "the `fetch` it is built with (Dependencies.fetch; `request`'s fetch option), every IMAP session through its `imap` (Dependencies.imap) and the fixture's `mailbox`"}, and the run refuses every other connection`);
      return false;
    }
    if (run.unimported !== undefined) return (stopped = true), fail(`${name}: what it sealed does not import: ${run.unimported}`), false;
    if (run.misread !== undefined) return (stopped = true), fail(`${name}: test/fixture.ts: ${run.misread}`), false;
    if (walk.error !== undefined) return fail(`${name}: its ${call} threw ${threw(walk.error)}`), false;
    if (walk.overrun) return fail(`${name}: its ${call} walk still ${call === "fetch" ? "said `more`" : "owed history (`left` not 0)"} after ${WALK_CALLS} calls: a walk ends`), false;
    return true;
  };
  const begin = (name: string) => sink.case(name);
  if (field !== undefined && !field.folder) {
    const count = Object.keys(context.fakes!.files!(scenarioOf(N))).length;
    if (count !== 1) return fail(`its \`${field.name}\` takes one file, and \`files(scenario)\` writes ${count}: a poll of a file is handed the scenario's one file`);
  }
  try {
    const twice = (walk: Walk) => walk.changed.filter(({ after }) => after.versions.at(-1) !== "gone").length + walk.added.filter((each) => distinct(each.versions) > 1).length;
    const itemRecords = (records: readonly Held[]) => records.filter((each) => each.item !== null).length;
    const begun = async (name: string, old: number, start_ms?: number): Promise<{ run: Run; first: Walk } | undefined> => {
      const run = open(scenarioOf(old, { items: old }), start_ms);
      const first = await walk(run, "fetch");
      if (!ended(name, "fetch", run, first)) return undefined;
      run.scenario = scenarioOf(old);
      return { run, first };
    };
    let cutting: Cut | string | null | undefined;
    const cutFor = (name: string): Cut | undefined => {
      if (context.fakes!.dated === undefined) return say(`${name}: not run (no \`dated\` in test/fixture.ts)`), undefined;
      if (field !== undefined && Object.values(context.fakes!.files!(scenarioOf(N))).every((value) => statedOf(value) === null)) {
        return say(`${name}: not run (\`files(scenario)\` states no file's \`modified_ms\`: ${ofFolder ? "its files are" : "its file is"} written at the run's clock, after every start)`), undefined;
      }
      const known = cutting !== undefined;
      cutting ??= cutOf(context.fakes!.dated);
      if (cutting === null) return say(`${name}: not run (its fake dates the old items on one day, up to ${256 * N} of them: no day's start falls among them)`), undefined;
      if (typeof cutting !== "string" && cutting.start_ms > START_MS) {
        return say(`${name}: not run (its fake dates old items after the run's clock, ${new Date(START_MS).toISOString()}: the home lends no start after today)`), undefined;
      }
      if (typeof cutting === "string") {
        if (known) return say(`${name}: not run (test/fixture.ts's \`dated\` threw)`), undefined;
        begin(name);
        return fail(`${name}: test/fixture.ts: ${cutting}`), undefined;
      }
      begin(name);
      return cutting;
    };
    const walkBack = async (name: string, run: Run): Promise<boolean> => {
      run.clock += 60_000;
      const fetched = await walk(run, "fetch");
      if (!ended(name, "fetch", run, fetched)) return false;
      return run.acquirer.page === undefined || ended(name, "page", run, await walk(run, "page"));
    };
    const heldOf = (run: Run) => itemsIn([...run.ledger.values()].filter((each) => each.versions.at(-1) !== "gone"));
    const wholeFetch = "no `page`: its first fetch reads its history whole, so a start moved later has nothing left to stop";
    const keepsItsStart = async (): Promise<void> => {
      const name = "keeps to its start";
      const cut = cutFor(name);
      if (cut === undefined) return;
      const day = dayOf(cut.start_ms);
      const started = await begun(name, cut.old, cut.start_ms);
      if (started === undefined) return;
      const pages = await walk(started.run, "page");
      if (!ended(name, "page", started.run, pages)) return;
      const below = [...itemsIn(pages.added)].filter((n) => n < cut.old && cut.dates[n]! < cut.start_ms);
      if (below.length > 0) fail(`${name}: lent the start ${day}, its ${pages.answered} pages landed ${listed(below)}, which its fake dates before it: ${START_RULE}`);
      else say(`${name}: run, lent ${day} over ${cut.old} old items, ${cut.before} of them dated before it: ${pages.answered} page${pages.answered === 1 ? "" : "s"} landed none of those`);
    };
    const fetchKeepsItsStart = async (): Promise<void> => {
      const name = "a fetch keeps to its start";
      const cut = cutFor(name);
      if (cut === undefined) return;
      const day = dayOf(cut.start_ms);
      const started = await begun(name, cut.old, cut.start_ms);
      if (started === undefined) return;
      const { run, first } = started;
      const added = 2 * cut.old;
      const edited = range(0, cut.old).find((n) => cut.dates[n]! < cut.start_ms)!;
      run.scenario = scenarioOf(cut.old, { items: added + 1, stamped: { [added]: cut.earliest_ms }, edited: [edited] });
      run.clock += 60_000;
      const fetched = await walk(run, "fetch");
      if (!ended(name, "fetch", run, fetched)) return;
      const dates: (number | null)[] = [];
      for (const n of range(0, added + 1)) {
        try {
          dates.push(context.fakes!.dated!(run.scenario, n));
        } catch (error) {
          return fail(`${name}: test/fixture.ts: its dated threw on item ${n}: ${errorText(error).split("\n")[0]}`);
        }
      }
      const before = (n: number) => {
        const at = dates[n];
        return typeof at === "number" && at < cut.start_ms;
      };
      const below = [
        ...[...itemsIn(first.added)].filter((n) => n < cut.old && cut.dates[n]! < cut.start_ms),
        ...[...itemsIn([...fetched.added, ...fetched.changed.map(({ after }) => after)])].filter(before),
      ];
      if (below.length > 0) return fail(`${name}: lent the start ${day}, its fetches landed ${listed(below)}, which its fake dates before it: ${FETCH_START_RULE}`);
      const among = [...(before(added) ? [`item ${added}, added after its first fetch`] : []), ...(before(edited) ? [`item ${edited}, edited after it`] : [])];
      say(`${name}: run, lent ${day}: its fetches landed none of the ${range(0, added + 1).filter(before).length} items its fake dates before it${among.length === 0 ? "" : `, ${among.join(" and ")}, among them`}`);
    };
    const readsWhenEarlier = async (): Promise<void> => {
      const name = "reads the gap when its start moves earlier";
      const cut = cutFor(name);
      if (cut === undefined) return;
      const started = await begun(name, cut.old, cut.start_ms);
      if (started === undefined) return;
      const { run, first } = started;
      if (run.acquirer.page === undefined && ![...itemsIn(first.added)].some((n) => n < cut.old)) return say(`${name}: not run (no \`page\`, and its first fetch landed none of the old items: it reads no history)`);
      if (run.acquirer.page !== undefined && !ended(name, "page", run, await walk(run, "page"))) return;
      run.start_ms = cut.earliest_ms;
      if (!(await walkBack(name, run))) return;
      const held = heldOf(run);
      const gap = range(0, cut.old).filter((n) => cut.dates[n]! >= cut.earliest_ms && cut.dates[n]! < cut.start_ms);
      const missed = gap.filter((n) => !held.has(n));
      const moved = `${dayOf(cut.start_ms)} moved to ${dayOf(cut.earliest_ms)}`;
      if (missed.length > 0) fail(`${name}: lent ${moved}, it never landed ${listed(missed)}, which its fake dates between them: ${EARLIER_RULE}`);
      else say(`${name}: run, ${moved}: the ${gap.length} item${gap.length === 1 ? "" : "s"} dated between them landed`);
    };
    const keepsWhenLater = async (): Promise<void> => {
      const name = "lands nothing older when its start moves later";
      if (base.acquirer.page === undefined) return say(`${name}: not run (${wholeFetch})`);
      const cut = cutFor(name);
      if (cut === undefined) return;
      const started = await begun(name, cut.old, cut.earliest_ms);
      if (started === undefined) return;
      const { run } = started;
      if (!ended(name, "page", run, await walk(run, "page", 1))) return;
      run.start_ms = cut.start_ms;
      const pages = await walk(run, "page");
      if (!ended(name, "page", run, pages)) return;
      const below = [...itemsIn([...pages.added, ...pages.changed.map(({ after }) => after)])].filter((n) => n < cut.old && cut.dates[n]! < cut.start_ms);
      const moved = `${dayOf(cut.earliest_ms)} for one page, then ${dayOf(cut.start_ms)}`;
      if (below.length > 0) fail(`${name}: lent ${moved}, its ${pages.answered} page${pages.answered === 1 ? "" : "s"} after the move landed ${listed(below)}, which its fake dates before it: ${LATER_RULE}`);
      else say(`${name}: run, ${moved}: ${pages.answered} page${pages.answered === 1 ? "" : "s"} after the move landed none of the ${cut.before} items dated before it, ending at \`left: 0\``);
    };
    const readsTheGap = async (): Promise<void> => {
      const name = "reads the gap when its start moves later, then back";
      if (base.acquirer.page === undefined) return say(`${name}: not run (${wholeFetch})`);
      const cut = cutFor(name);
      if (cut === undefined) return;
      const started = await begun(name, cut.old, cut.earliest_ms);
      if (started === undefined) return;
      const { run } = started;
      if (!ended(name, "page", run, await walk(run, "page", 1))) return;
      run.start_ms = cut.start_ms;
      if (!ended(name, "page", run, await walk(run, "page"))) return;
      run.start_ms = cut.earliest_ms;
      if (!(await walkBack(name, run))) return;
      const held = heldOf(run);
      const owed = range(0, cut.old).filter((n) => cut.dates[n]! >= cut.earliest_ms);
      const missed = owed.filter((n) => !held.has(n));
      const moved = `${dayOf(cut.earliest_ms)} for one page, ${dayOf(cut.start_ms)} to the walk's end, then ${dayOf(cut.earliest_ms)} again`;
      if (missed.length > 0) fail(`${name}: lent ${moved}, it never landed ${listed(missed)}, which its fake dates from ${dayOf(cut.earliest_ms)} on: ${BACK_RULE}`);
      else say(`${name}: run, ${moved}: all ${owed.length} old items landed`);
    };
    const countsItsMonths = ({ run, walk: pages, first: before, fetch, from }: { run: Run; walk: Walk; first: Walk; fetch: Walk; from: number }): void => {
      const name = "counts its months";
      const paged = run.sealings.slice(from);
      const answering = paged.flatMap((each, at) => (Object.hasOwn(each.facts, "months") ? [at + 1] : []));
      const says = run.acquirer.months === true;
      if (!says && answering.length === 0) return;
      begin(name);
      if (!says) return fail(`${name}: its page ${answering[0]} answered \`months\`, and it does not say \`months: true\`: ${MONTHS_RULE}`);
      if (answering[0] !== 1) return fail(`${name}: it says \`months: true\`, and the first of its ${paged.length} pages answered none: ${MONTHS_RULE}`);
      if (answering.length > 1) return fail(`${name}: pages ${answering.join(", ")} of its walk answered \`months\`, the first alone does: ${MONTHS_RULE}`);
      const months = monthsIn(paged[0]!.facts.months);
      if (months === null) return fail(`${name}: its first page's \`months\` is ${JSON.stringify(paged[0]!.facts.months).slice(0, 120)}: \`{ "<YYYY-MM>" | "undated": [items, bytes | null] }\``);
      const dated = context.fakes!.dated;
      if (dated === undefined) return say(`${name}: not run (no \`dated\` in test/fixture.ts to read its items' months by)`);
      const landed = new Set([...itemsIn(before.added), ...itemsIn(fetch.added), ...itemsIn(pages.added)]);
      const wanted = new Map<string, number>();
      for (const n of landed) {
        const at = dated(run.scenario, n);
        const month = at === null ? UNDATED : new Date(at).toISOString().slice(0, 7);
        wanted.set(month, (wanted.get(month) ?? 0) + 1);
      }
      const differ = [...new Set([...Object.keys(months), ...wanted.keys()])].sort()
        .filter((month) => (months[month]?.[0] ?? 0) !== (wanted.get(month) ?? 0))
        .map((month) => `${month}: counted ${months[month]?.[0] ?? 0}, landed ${wanted.get(month) ?? 0}`);
      if (differ.length > 0) fail(`${name}: its first page's months and the items its walks landed differ (${differ.slice(0, 4).join("; ")}): ${MONTHS_RULE}`);
      else say(`${name}: run, its first page counted ${landed.size} items in ${wanted.size} month${wanted.size === 1 ? "" : "s"}, as its walks landed them; its other ${paged.length - 1} pages answered none`);
    };
    const landsAtSealedTime = async (): Promise<void> => {
      const name = "lands at a sealed time";
      const dated = context.fakes!.dated;
      if (dated === undefined) return say(`${name}: not run (${poll} and no \`dated\` in test/fixture.ts)`);
      begin(name);
      const stamped = await begun(name, N);
      if (stamped === undefined) return;
      const { run, first: old } = stamped;
      const fetched = await walk(run, "fetch");
      if (!ended(name, "fetch", run, fetched)) return;
      const dates = datesOf(dated, run.scenario, run.scenario.items);
      if (typeof dates === "string") return fail(`${name}: test/fixture.ts: ${dates}`);
      const sealed = [...itemsIn([...old.added, ...fetched.added])];
      if (sealed.length === 0) return fail(`${name}: its first fetches landed no item`);
      const newest = Math.max(...sealed.map((n) => dates[n]!));
      const added = run.scenario.items;
      run.scenario = scenarioOf(N, { items: added + 1, stamped: { [added]: newest } });
      const at = new Date(newest).toISOString();
      let stated: unknown;
      try {
        stated = dated(run.scenario, added);
      } catch (error) {
        return fail(`${name}: test/fixture.ts: its dated threw on item ${added}, which the scenario stamps at ${at}: ${errorText(error).split("\n")[0]}`);
      }
      if (stated === null) return say(`${name}: not run (test/fixture.ts's \`dated\` names no time for item ${added}, stamped at ${at}: its source holds one item at a time)`);
      if (stated !== newest) {
        return fail(`${name}: test/fixture.ts: its dated names ${JSON.stringify(stated)} for item ${added}, which the scenario stamps at ${at}: a fake dates an item \`scenario.stamped\` names at that time, or \`dated\` names null where its source holds one item at a time`);
      }
      run.clock += 60_000;
      const next = await walk(run, "fetch");
      if (!ended(name, "fetch", run, next)) return;
      if (!itemsIn(next.added).has(added)) fail(`${name}: item ${added}, added after its last fetch and stamped ${at}, the time of the newest item that fetch sealed, never landed: ${STAMPED_RULE}`);
      else if (twice(next) > 0) fail(`${name}: ${twice(next)} records landed a second version with nothing changed: an item lands once`);
      else say(`${name}: run, item ${added} stamped ${at}, the newest sealed item's time, landed`);
    };
    begin("lands new");
    const started = await begun("lands new", N);
    if (started === undefined) return;
    const { run: base, first } = started;
    const fresh = await walk(base, "fetch");
    if (!ended("lands new", "fetch", base, fresh)) return;
    const landedOld = itemsIn(first.added);
    const landedNew = itemsIn(fresh.added);
    const added = range(N, 2 * N);
    const missed = added.filter((n) => !landedNew.has(n));
    const early = [...landedNew].filter((n) => n < N);
    const whole = folder && base.acquirer.page === undefined;
    const arrived = `the ${N} ${ofFolder ? "files" : "items"} added after its first fetch`;
    if (missed.length === N) {
      const instead = early.length > 0 ? `; it landed old ${listed(early)} instead, which the source held at its first fetch`
        : fresh.added.length > 0 ? `: the ${fresh.added.length} records it landed are no item's, as test/fixture.ts's \`item\` names them` : "";
      fail(`lands new: none of ${arrived} landed${instead} (${NEW_RULE})`);
      return;
    }
    if (missed.length > 0) {
      fail(`lands new: ${N - missed.length} of ${arrived} landed, ${listed(missed)} missed (${NEW_RULE})`);
      return;
    }
    const unread = range(0, N).filter((n) => !landedOld.has(n));
    if (whole && unread.length > 0) {
      fail(ofFolder
        ? `lands new: its first fetch, the folder holding the scenario's ${N} old files, landed ${N - unread.length} of them, ${listed(unread)} missed: a folder poll's fetch walks the whole folder, every file from the stream's start (lent.start_ms) with it`
        : `lands new: its first fetch, the file holding the scenario's ${N} old items, landed ${N - unread.length} of them, ${listed(unread)} missed: a poll of a file reads the whole of it, every item from the stream's start (lent.start_ms) with it`);
    }
    else if (early.length > 0) fail(`lands new: its fetch after the items were added landed old ${listed(early)}, which the source held at its first fetch: a fetch lands what was added since the last, the old items are history's (${OLD_RULE})`);
    else if (twice(fresh) > 0) fail(`lands new: ${twice(fresh)} records landed a second version with nothing changed: an item lands once`);
    else {
      const calls = first.calls + fresh.calls;
      const records = itemRecords(fresh.added) + (whole ? itemRecords(first.added) : 0);
      const written = ofFolder ? Object.keys(context.fakes!.files!(base.scenario)).length : 2 * N;
      const said = whole
        ? `${N} ${ofFolder ? "files" : "items"} there at its first fetch and ${N} added after it, ${records} record${records === 1 ? "" : "s"}`
        : `${N} items added after its first fetch, ${records} record${records === 1 ? "" : "s"}`;
      say(`lands new: run, ${calls} call${calls === 1 ? "" : "s"}, ${said}${written !== 2 * N ? ` (\`files(scenario)\` wrote ${written} files for its ${2 * N} items)` : ""}`);
    }
    await landsAtSealedTime();
    const acquirer = base.acquirer;
    const calls = acquirer.page === undefined ? ["fetch"] as const : ["fetch", "page"] as const;

    let history: { run: Run; walk: Walk; first: Walk; fetch: Walk; from: number } | undefined;
    let walked = acquirer.page === undefined;
    let bounded: { first: Walk; fetch: Walk; page?: Walk } | undefined;
    const atN = { first, fetch: fresh, page: undefined as Walk | undefined };
    if (acquirer.page === undefined) {
      say(!folder ? "lands history: not run (no `page`: it has no history behind what `fetch` reads)"
        : `lands history: not run (${poll}: its fetch ${ofFolder ? "walks the whole folder" : "reads the whole file"}, so no history lies behind it)`);
    }
    else {
      for (let old = N; old <= 256 * N; old *= 4) {
        begin("lands history");
        let run = base;
        let before = first;
        let after = fresh;
        if (old !== N) {
          const scaled = await begun("lands history", old);
          if (scaled === undefined) break;
          ({ run, first: before } = scaled);
          after = await walk(run, "fetch");
          if (!ended("lands history", "fetch", run, after)) break;
        }
        const from = run.sealings.length;
        const pages = await walk(run, "page");
        if (!ended("lands history", "page", run, pages)) break;
        if (old === N) {
          atN.page = pages;
          walked = true;
        }
        if (old === 4 * N) bounded = { first: before, fetch: after, page: pages };
        if (pages.answered >= 2 || old === 256 * N) {
          history = { run, walk: pages, first: before, fetch: after, from };
          break;
        }
      }
      if (history !== undefined) {
        const { run, walk: pages, first: before, fetch } = history;
        const { old, items } = run.scenario;
        const paged = itemsIn(pages.added);
        const landed = new Set([...itemsIn(before.added), ...paged]);
        const late = [...paged].filter((n) => n >= old);
        const unpaged = range(0, old).filter((n) => !landed.has(n));
        const together = new Set([...landed, ...itemsIn(fetch.added)]);
        if (pages.answered < 2) say(`lands history: not run (one page held all ${old} old items: two pages were never asked)`);
        else if (late.length > 0) fail(`lands history: ${pages.answered} pages landed ${listed(late)}, added after its first fetch: history is what the source held at the first fetch, what was added after it the fetch's (${OLD_RULE})`);
        else if (unpaged.length > 0) fail(`lands history: ${pages.answered} pages landed ${old - unpaged.length} of the ${old} old items, ${listed(unpaged)} missed (${OLD_RULE})`);
        else if (twice(pages) > 0) fail(`lands history: ${twice(pages)} records landed a second version with nothing changed: an item lands once`);
        else if (together.size !== items) fail(`lands history: the walks together landed ${together.size} of the scenario's ${items} items, ${listed(range(0, items).filter((n) => !together.has(n)))} never`);
        else say(`lands history: run, ${pages.answered} pages, ${landed.size} items`);
        countsItsMonths(history);
      }
      await keepsItsStart();
    }
    await fetchKeepsItsStart();
    await readsWhenEarlier();
    await keepsWhenLater();
    await readsTheGap();

    if (walked) {
      begin("replays");
      base.clock += 60_000;
      const sealedBefore = base.sealings.length;
      const again = await walk(base, "fetch", 1);
      const fetched = ended("replays", "fetch", base, again);
      const fetchSealed = base.sealings.length - sealedBefore;
      const waited = again.waits.some((each) => each.how === "NotYet");
      const paged = acquirer.page === undefined || !fetched ? undefined : await walk(base, "page", 1);
      if (fetched && (paged === undefined || ended("replays", "page", base, paged))) {
        const landed = [again, ...(paged === undefined ? [] : [paged])].reduce((sum, each) => sum + each.added.length + each.changed.length, 0);
        const resealed = (from: number) => base.sealings.slice(from).reduce((sum, each) => sum + each.files, 0);
        const unchanged = "a file whose bytes did not change seals nothing (the poll's memory holds each file's digest)";
        const at = site ? "site" : folder ? (ofFolder ? "folder" : "file") : "provider";
        if (landed > 0) fail(`replays: ${landed} records landed again, new or as another version, with nothing changed at the ${at}`);
        else if (fetchSealed > 0 && !ofFolder) fail(`replays: nothing changed at the ${at}, and its fetch sealed ${fetchSealed === 1 ? "a delivery" : `${fetchSealed} deliveries`}: ${NOTHING_NEW_RULE}`);
        else if (waited) fail(`replays: nothing changed at the ${at}, and its fetch threw \`NotYet\`: ${NOTHING_NEW_RULE}`);
        else if (base.folder === undefined) say(`replays: run, no new version`);
        else if (ofFolder && resealed(sealedBefore) > 0) fail(`replays: nothing changed in the folder, and its fetch sealed ${resealed(sealedBefore)} files again: ${unchanged}`);
        else {
          touch(base.folder);
          base.clock += 60_000;
          const touchedFrom = base.sealings.length;
          const touched = await walk(base, "fetch");
          if (ended("replays", "fetch", base, touched)) {
            const landedAgain = touched.added.length + touched.changed.length;
            const again = ofFolder ? resealed(touchedFrom) : 0;
            if (landedAgain > 0 || again > 0) {
              fail(ofFolder
                ? `replays: every file touched, its bytes the same, and its fetch sealed ${again} files again${landedAgain > 0 ? `, ${landedAgain} records landing another version` : ""}: ${unchanged}`
                : `replays: the file touched, its bytes the same, and ${landedAgain} records landed another version: nothing in it changed`);
            } else say(`replays: run, ${ofFolder ? "nothing sealed, nor with every file touched" : "no new version, nor with the file touched"}`);
          }
        }
      }
    }

    const edited = base.scenario.items - 1;
    const removed = base.scenario.old;
    const shownNow = () => seen(context, proved, base.home, base.sealings.map((each) => each.source));
    const immutable = context.fakes?.immutable === true;
    let beforeRemoval: string[] | undefined;
    begin("edits");
    const beforeEdit = await shownNow();
    base.scenario = scenarioOf(N, { edited: [edited] });
    base.clock += 60_000;
    const edit = await walk(base, "fetch");
    if (ended("edits", "fetch", base, edit)) {
      const fault = editFault(edit, edited, "its fetch", immutable);
      if (fault !== null) fail(fault);
      else if (immutable) say(`edits: run, the edited item landed nothing new (${IMMUTABLE})`);
      else {
        beforeRemoval = await shownNow();
        say("edits: run, the edited item landed one new version");
        const lines = changeLines(beforeEdit, beforeRemoval);
        for (const line of lines.length > 0 ? lines : ["the day and search read the same after it: its adapter shows none of what changed"]) say(`edits: ${line}`);
      }
    }
    begin("removals");
    beforeRemoval ??= await shownNow();
    base.scenario = scenarioOf(N, { edited: [edited], removed: [removed] });
    base.clock += 60_000;
    const its = liveOf(base.ledger, removed);
    const removal = await walk(base, "fetch");
    if (ended("removals", "fetch", base, removal)) {
      const verdict = removalVerdict(removal, removed, its, base.ledger, ofFolder);
      if ("fault" in verdict) fail(verdict.fault);
      else {
        say(`removals: run, ${verdict.gone === 0 ? "nothing changed: the source states no removals" : "the removed item went gone"}`);
        if (verdict.gone > 0) for (const line of changeLines(beforeRemoval, await shownNow())) say(`removals: ${line}`);
      }
    }

    begin("cursor stays bounded");
    const large = bounded === undefined ? await begun("cursor stays bounded", 4 * N) : undefined;
    if (large !== undefined) {
      const { run } = large;
      const fetch = await walk(run, "fetch");
      const fetched = ended("cursor stays bounded", "fetch", run, fetch);
      const page = acquirer.page === undefined || !fetched ? undefined : await walk(run, "page");
      if (fetched && (page === undefined || ended("cursor stays bounded", "page", run, page))) bounded = { first: large.first, fetch, ...(page === undefined ? {} : { page }) };
    }
    if (bounded !== undefined) {
      const pairs: { walk: string; small: number; large: number; items: readonly [number, number] }[] = [
        { walk: "first fetch", small: atN.first.cursor_bytes, large: bounded.first.cursor_bytes, items: [N, 4 * N] },
        { walk: "fetch", small: atN.fetch.cursor_bytes, large: bounded.fetch.cursor_bytes, items: [2 * N, 8 * N] },
      ];
      if (atN.page !== undefined && bounded.page !== undefined) pairs.push({ walk: "page", small: atN.page.cursor_bytes, large: bounded.page.cursor_bytes, items: [2 * N, 8 * N] });
      const grown = pairs.find(({ small, large }) => large - small > Math.max(CURSOR_SLACK, small / 4));
      if (grown !== undefined) {
        fail(`cursor stays bounded: its cursor after the ${grown.walk} walk is ${grown.small} bytes at ${grown.items[0]} items and ${grown.large} at ${grown.items[1]}: a field that grows with the items belongs in the poll's memory (lent.memory)`);
      } else say(`cursor stays bounded: run, ${Math.max(...pairs.map(({ small }) => small))} bytes at ${2 * N} items, ${Math.max(...pairs.map(({ large }) => large))} at ${8 * N}`);
    }

    if (site) say("waits out a limit: not run (a site's requests are the station's: Chrome meets the site's limits, and the lane's pace waits them out)");
    else if (folder) say(`waits out a limit: not run (${poll} requests nothing: no provider's limit to wait out)`);
    else {
      const limited: string[] = [];
      for (const call of ["first", ...calls] as const) {
        const label = call === "first" ? "first fetch walk" : `${call} walk`;
        const name = `waits out a limit (${label})`;
        begin(name);
        let run: Run;
        let owed: number[];
        if (call === "first") {
          run = open(scenarioOf(N, { items: N }));
          owed = [...landedOld];
        } else {
          const limiting = await begun(name, N);
          if (limiting === undefined) continue;
          run = limiting.run;
          if (call === "page") {
            const fetched = await walk(run, "fetch");
            if (!ended(name, "fetch", run, fetched)) continue;
          }
          const before = itemsIn(limiting.first.added);
          owed = call === "fetch" ? added : range(0, N).filter((n) => !before.has(n));
        }
        const at = Math.min(3, (call === "first" ? first : call === "fetch" ? fresh : atN.page ?? fresh).requests);
        if (at === 0) {
          limited.push(`${label} (it requests nothing)`);
          continue;
        }
        let retry_ms: number | undefined;
        run.answer = (n) => {
          if (n !== at || retry_ms !== undefined) return undefined;
          retry_ms = run.clock + LIMIT_S * 1000;
          return { status: 429, retry_s: LIMIT_S };
        };
        const limit = await walk(run, call === "first" ? "fetch" : call);
        if (!ended(name, call === "first" ? "fetch" : call, run, limit)) continue;
        const wait = limit.waits[0];
        const unlanded = owed.filter((n) => !itemsIn(limit.added).has(n));
        if (retry_ms === undefined) fail(`${name}: its walk made fewer than ${at} requests`);
        else if (wait === undefined) fail(`${name}: met a 429 at its request ${at} and carried no wait: a limit throws \`NotYet\` with \`backoff_ms\`, or seals what it finished with \`backoff_ms\` (afterStop)`);
        else if (wait.until < retry_ms) fail(`${name}: its wait ends ${Math.round((retry_ms - wait.until) / 1000)} s before the provider's Retry-After`);
        else if (unlanded.length > 0) fail(`${name}: after the 429 at its request ${at}, ${unlanded.length} of the ${owed.length} items it owed never landed (${listed(unlanded)}): the call after the wait goes on from the kept state`);
        else if (twice(limit) > 0) fail(`${name}: ${twice(limit)} records landed twice across the wait: the call after it goes on from the kept state`);
        else if (call !== "first") limited.push(`${label} (${wait.how})`);
        else {
          run.answer = undefined;
          run.scenario = scenarioOf(N);
          const next = await walk(run, "fetch");
          if (!ended(name, "fetch", run, next)) continue;
          const lost = added.filter((n) => !itemsIn(next.added).has(n));
          if (lost.length > 0) fail(`${name}: after the 429 at its first fetch's request ${at}, ${lost.length} of the ${N} items added later never landed at its next fetch (${listed(lost)}): the cursor its first call began goes with the wait (afterStop keeps it in \`NotYet\`'s state)`);
          else limited.push(`${label} (${wait.how})`);
        }
      }
      if (limited.length === calls.length + 1) say(`waits out a limit: run, ${limited.join(", ")}`);
    }

    const signs = site || (proved.connector.signin?.length ?? 0) > 0 || Object.values(proved.connector.fields ?? {}).some((field) => field.kind === "secret");
    if (folder) say(`signs out: not run (${poll} reads the Mac's own files: nothing to sign in to)`);
    else if (!signs) say("signs out: not run (no sign-in route, no secret field)");
    else {
      begin("signs out");
      const run = open(scenarioOf(N));
      const signin = site ? signInPageOf(proved.connector) : undefined;
      run.answer = site ? () => ({ status: 401 }) : signedOutProvider;
      if (signin !== undefined) run.signin = signin;
      const answers: string[] = [];
      const reasons = new Set<string>();
      for (const call of calls) {
        const signed = await walk(run, call, 1);
        if (stopped || direct.length > 0 || connected.length > 0 || run.unimported !== undefined) {
          ended("signs out", call, run, signed);
          break;
        }
        const error = signed.error;
        if (error instanceof NeedsYou && (site || error.reason === "signed-out") && signed.sealed === 0) {
          reasons.add(error.reason);
          continue;
        }
        answers.push(`its ${call} ${error === undefined ? `${signed.sealed > 0 ? "sealed a delivery" : "returned"}` : `threw ${threw(error)}`}`);
      }
      if (answers.length > 0) {
        fail(site
          ? `signs out: ${signedOutSite(signin!)}, and ${answers.join("; ")}: a signed-out site throws \`NeedsYou\`, nothing sealed`
          : `signs out: ${SIGNED_OUT}, and ${answers.join("; ")}: a sign-in refused throws \`NeedsYou\` \`signed-out\` (afterStop), nothing sealed`);
      } else if (!stopped && direct.length === 0 && connected.length === 0 && run.unimported === undefined) {
        say(`signs out: run, ${signin === undefined ? "" : `${signedOutSite(signin)}: `}NeedsYou ${[...reasons].join(", ")}`);
      }
    }

    const route = proved.connector.signin?.find((each) => each.way === "client");
    if (site || folder) {
    } else if (route === undefined) say("refreshes: not run (no `client` sign-in route)");
    else {
      begin("refreshes");
      await refreshes(proved, secretFieldOf(proved.connector, route), open, walk, ended, sink, { stopped: () => stopped || direct.length > 0 || connected.length > 0 });
    }

    const contact = runs.find((each) => each.contact !== undefined)?.contact;
    if (contact !== undefined) {
      begin("says its contact");
      fail(`says its contact: ${contact}: ${ANSWERED_RULE}`);
    }

    if (!stopped && direct.length === 0 && connected.length === 0) await reachesTheDay(context, proved, base.home, [...new Set(base.sealings.map((each) => each.source))], sink);
  } finally {
    scratchRelease?.();
    baseRelease?.();
  }

  async function walk(run: Run, call: "fetch" | "page", most = WALK_CALLS): Promise<Walk> {
    if (run.folder !== undefined) place(run.folder, context.fakes!.files!(run.scenario), run.clock);
    if (run.relay !== undefined) run.relay.start_ms = run.start_ms;
    run.requests = 0;
    let calls = 0;
    let sealed = 0;
    let answered = 0;
    const waits: { how: "NotYet" | "backoff_ms"; until: number }[] = [];
    let error: unknown;
    let going = true;
    while (going && calls < most && direct.length === 0 && connected.length === 0 && run.unimported === undefined) {
      calls++;
      try {
        const asked = run.requests;
        const walked = call === "page" && run.kept.left === 0;
        const delivered = await pollCall(run.acquirer, run.kept, run.secrets, call, (sealing) => seal(run, proved, sealing), { ...LENT, start_ms: run.start_ms });
        if (delivered === true) sealed++;
        answered++;
        const none = run.requests === asked;
        if (input === "provider" && !walked && none !== (run.kept.next?.answered === false)) {
          run.contact ??= none ? `its ${call} made no request and did not say \`answered: false\`` : `its ${call} made ${run.requests - asked} request${run.requests - asked === 1 ? "" : "s"} and said \`answered: false\``;
        }
      } catch (thrown) {
        run.clock += 1_000;
        const until = thrown instanceof NotYet ? thrown.backoff_ms ?? thrown.next_ms : undefined;
        if (until === undefined) {
          error = thrown;
          break;
        }
        waits.push({ how: "NotYet", until });
        run.clock = Math.max(run.clock, until);
        continue;
      }
      run.clock += 1_000;
      const backoff = run.kept.next?.backoff_ms;
      if (backoff !== undefined) {
        waits.push({ how: "backoff_ms", until: backoff });
        run.clock = Math.max(run.clock, backoff);
        continue;
      }
      going = call === "fetch" ? run.kept.next?.more === true : run.kept.left !== 0;
    }
    const before = run.ledger;
    run.ledger = ledgerOf(run.home, (kind, key) => itemOf(run, kind, key));
    const { added, changed } = ledgerChanges(before, run.ledger);
    return {
      calls, answered, sealed, requests: run.requests, waits, ...(error === undefined ? {} : { error }), overrun: going && calls >= most && most === WALK_CALLS && error === undefined,
      added, changed, cursor_bytes: Buffer.byteLength(JSON.stringify(run.kept.state ?? {}), "utf8"),
    };
  }
}

async function seal(run: Omit<Run, "acquirer">, proved: Built, { files, facts, source }: { files: Readonly<Record<string, Buffer>>; facts: JsonObject; source: string }): Promise<true> {
  run.sealed_ms = Math.max(run.clock, run.sealed_ms + 1_000);
  run.sealings.push({ source, facts, files: Object.keys(files).length });
  const landed = await landDelivery(run.home, readerOf(proved.connector, source), { source, facts, files }, join(run.home.folder.root, "carried"), files, run.sealed_ms);
  const view = run.home.read.view();
  try {
    const row = view.tables.deliveries.get(landed.delivery, source);
    if (landed.run === null || row?.state !== "imported") run.unimported ??= `its delivery of ${source} is ${row?.state ?? "not indexed"}${row?.error ? `: ${row.error}` : ""}`;
  } finally {
    view.close();
  }
  return true;
}

function delegated(current: () => Site, answer: (n: number, url: URL) => Answer | undefined, count: () => number, signin: () => URL | undefined): Site {
  return {
    answer(request): SiteAnswer {
      const own = answer(count(), request.url);
      return own === undefined ? current().answer(request) : { status: own.status, body: { error: own.error ?? "signed out" } };
    },
    get signals() {
      return current().signals ?? {};
    },
    page: (url) => {
      const to = signin();
      return to === undefined ? current().page?.(url) : signedOutPage(current(), to, url);
    },
    cookies: (origin) => (signin() === undefined ? current().cookies?.(origin) ?? {} : {}),
    cors: (page, url) => current().cors?.(page, url) ?? true,
  };
}

const SIGN_IN_PATH = "/login";

function signInPageOf(connector: Connector): URL {
  const chrome = connector.chrome!;
  return chrome.signin === undefined ? new URL(SIGN_IN_PATH, chrome.origin) : new URL("/", chrome.signin.origin);
}

const onSignIn = (to: URL, url: URL) => url.origin === to.origin && url.pathname.startsWith(to.pathname);

function signedOutPage(site: Site, to: URL, url: URL): FakePage | undefined {
  if (!onSignIn(to, url)) return { elements: [], redirect: to.href };
  const shown = site.page?.(url);
  if (shown === undefined) return undefined;
  const refused = (click: () => string | void) => (): string | void => {
    const next = click();
    return next === undefined || onSignIn(to, new URL(next, url)) ? next : to.href;
  };
  return { ...shown, elements: shown.elements.map((element) => (element.click === undefined ? element : { ...element, click: refused(element.click) })) };
}


async function refreshes(
  proved: Built, field: string, open: (scenario: Scenario) => Run, walk: (run: Run, call: "fetch" | "page", most?: number) => Promise<Walk>,
  ended: (name: string, call: "fetch" | "page", run: Run, walk: Walk) => boolean, sink: Sink, state: { stopped: () => boolean },
): Promise<void> {
  const fail = (fault: string) => sink.fault(`refreshes: ${fault}`);
  const built = proved.settings[field];
  const declared = proved.connector.fields?.[field];
  const secret = typeof built === "string" ? built : declared?.kind === "secret" ? declared.secret : field;
  const run = open(scenarioOf(N));
  const sealed = run.secrets.values[secret];
  let credential: OAuthCredential;
  try {
    if (sealed === undefined) throw new Error("none");
    credential = oauthCredential(sealed, secret);
  } catch {
    fail(`the fixture's secrets hold no sign-in under ${secret} as the \`client\` route seals it: export \`secrets\` with its credential (credentialText)`);
    return;
  }
  if (credential.token_endpoint === undefined) {
    fail(`the fixture's sign-in under ${secret} holds no \`token_endpoint\`: a \`client\` route seals the endpoint it refreshes at`);
    return;
  }
  const endpoint = endpointOf(new URL(credential.token_endpoint));
  run.token = endpoint;
  const expire = () => {
    const now = oauthCredential(run.secrets.values[secret]!, secret);
    run.secrets.values[secret] = credentialText({ ...now, expires_ms: run.clock - 60_000 });
  };
  run.secrets.values[secret] = credentialText({ ...credential, expires_ms: run.clock - 60_000 });
  const first = await walk(run, "fetch");
  if (!ended("refreshes", "fetch", run, first)) return;
  if (run.refreshes.length === 0) {
    fail(`its access token had expired and it never asked ${endpoint}: a sign-in's credential is sent through \`request\` with its refresher (clientRefresher), which refreshes it; an acquirer never reads a token itself`);
    return;
  }
  if (first.added.length === 0) {
    fail(`it refreshed and landed nothing: the call goes on with the new access token`);
    return;
  }
  const rotated = run.refreshes.at(-1)!.answered;
  const kept = (() => {
    try {
      return oauthCredential(run.secrets.values[secret]!, secret).refresh_token;
    } catch {
      return null;
    }
  })();
  if (rotated !== null && kept !== rotated) {
    fail(`${endpoint} answered a new refresh token and the vault still holds ${kept === credential.refresh_token ? "the old one" : "another"}: the rotated refresh token is kept (\`request\` rotates the credential through the call's \`secrets\`)`);
    return;
  }
  expire();
  const asked = run.refreshes.length;
  const next = await walk(run, "fetch", 1);
  if (!ended("refreshes", "fetch", run, next)) return;
  const sent = run.refreshes[asked]?.sent;
  if (sent !== kept) {
    fail(sent === undefined ? `its next call, its access token expired, never asked ${endpoint}` : `its next refresh sent ${sent === credential.refresh_token ? "the spent refresh token" : "another refresh token"}, not the one the vault kept`);
    return;
  }
  run.answer = (_, url) => (endpointOf(url) === endpoint ? { status: 400, error: "invalid_grant" } : { status: 401 });
  const answers: string[] = [];
  const calls = run.acquirer.page === undefined ? ["fetch", "fetch"] as const : ["fetch", "page"] as const;
  for (const [index, call] of calls.entries()) {
    if (index === 1) expire();
    const refused = await walk(run, call, 1);
    if (state.stopped() || run.unimported !== undefined) {
      ended("refreshes", call, run, refused);
      return;
    }
    const error = refused.error;
    if (error instanceof NeedsYou && error.reason === "signed-out" && refused.sealed === 0) continue;
    answers.push(`its ${call} ${error === undefined ? (refused.sealed > 0 ? "sealed a delivery" : "returned") : `threw ${threw(error)}`}`);
  }
  if (answers.length > 0) {
    fail(`${endpoint} answered 400 invalid_grant and the API 401, and ${answers.join("; ")}: a refused refresh throws \`NeedsYou\` \`signed-out\` (the request loop's refresher does), nothing sealed`);
    return;
  }
  sink.line(`refreshes: run, refreshed and landed, the rotated refresh token kept and sent, invalid_grant signed out`);
}


interface Placed {
  readonly field: string;
  readonly path: string;
  readonly dir: string;
  readonly written: Map<string, { readonly bytes: Buffer; readonly stated: number | null }>;
}

function pathFieldOf(connector: Connector): { name: string; folder: boolean } {
  const fields = Object.entries(connector.fields ?? {}).flatMap(([name, field]) => (field.kind === "path" ? [{ name, folder: field.folder === true }] : []));
  return fields.find((each) => each.folder) ?? fields[0]!;
}

function placedFor(field: { name: string; folder: boolean }, dir: string, files: Files): Placed {
  const paths = Object.keys(files);
  mkdirSync(dir, { recursive: true });
  return { field: field.name, path: !field.folder && paths.length === 1 ? join(dir, paths[0]!) : dir, dir, written: new Map() };
}

function place(folder: Placed, files: Files, now: number): void {
  for (const path of [...folder.written.keys()]) {
    if (path in files) continue;
    rmSync(join(folder.dir, path), { force: true });
    folder.written.delete(path);
  }
  for (const [path, value] of Object.entries(files)) {
    const bytes = bytesOf(value);
    const stated = statedOf(value);
    const held = folder.written.get(path);
    if (held !== undefined && held.bytes.equals(bytes) && held.stated === stated) continue;
    writeDated(join(folder.dir, path), value, now);
    folder.written.set(path, { bytes, stated });
  }
}

function touch(folder: Placed): void {
  for (const path of folder.written.keys()) {
    const file = join(folder.dir, path);
    const at = new Date(Math.trunc(statSync(file).mtimeMs) + 60_000);
    utimesSync(file, at, at);
  }
}

function writeDated(file: string, value: Files[string], now?: number): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytesOf(value));
  const at = statedOf(value) ?? now;
  if (at !== undefined) utimesSync(file, new Date(at), new Date(at));
}

function bytesOf(value: Files[string]): Buffer {
  const bytes = typeof value === "string" || value instanceof Uint8Array ? value : value.bytes;
  return typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
}

function statedOf(value: Files[string]): number | null {
  return typeof value === "string" || value instanceof Uint8Array ? null : value.modified_ms ?? null;
}


async function importsIn(context: AcquirerContext, connector: Connector, sink: Sink): Promise<void> {
  if (context.fakes?.files === undefined) {
    sink.fault("its export would meet its first file in Lifestream: export `files` from test/fixture.ts, the download as the person hands it in (templates/export)");
    return;
  }
  sink.case("hands in");
  const fail = (fault: string) => sink.fault(fault);
  const { home, release } = scratchHome(context);
  try {
    const scenario = scenarioOf(N);
    const files = Object.entries(context.fakes.files(scenario));
    if (files.length === 0) {
      fail("hands in: the fixture's `files` wrote no file: the export holds what the person downloads");
      return;
    }
    const item = context.fakes.item;
    const run = { scenario, item: item ?? (() => null), clock: START_MS, ledger: new Map() as Ledger } as unknown as Omit<Run, "acquirer">;
    let exports = 0;
    let unimported: string | undefined;
    const hand = async (given: Scenario): Promise<{ error?: unknown; fed: string[]; asked: string | null; landed: Pick<Walk, "added" | "changed"> }> => {
      run.scenario = given;
      const at = join(home.folder.root, "handed", String(exports++));
      const written = Object.entries(context.fakes!.files!(given));
      for (const [path, value] of written) writeDated(join(at, "export", path), value);
      const handed = written.length === 1 ? join(at, "export", written[0]![0]) : join(at, `${connector.id}-export.zip`);
      if (written.length > 1) writeFileSync(handed, zipStored(written.map(([path, value]) => [path, bytesOf(value)])));
      let error: unknown;
      let fed: string[] = [];
      let asked: string | null = null;
      try {
        const landed = await landImport(home, connector.id, handed, START_MS + exports * 1_000);
        fed = Object.keys(landed.runs);
        if (landed.import !== null && landed.import.account === null) asked = landed.import.refused ?? "its export names no account";
        const view = home.read.view();
        try {
          for (const source of fed) {
            const row = view.tables.deliveries.get(landed.delivery, source);
            if (row?.state !== "imported") unimported ??= `its delivery of ${source} is ${row?.state ?? "not indexed"}${row?.error ? `: ${row.error}` : ""}`;
          }
        } finally {
          view.close();
        }
      } catch (thrown) {
        error = thrown;
      }
      const before = run.ledger;
      run.ledger = ledgerOf(home, (kind, key) => itemOf(run, kind, key));
      return { ...(error === undefined ? {} : { error }), fed, asked, landed: ledgerChanges(before, run.ledger) };
    };
    const ended = (name: string, handed: { error?: unknown }): boolean => {
      if (direct.length > 0) return fail(`${name}: it requests ${direct[0]}: an export's reader reads the file it is handed and requests nothing`), false;
      if (connected.length > 0) return fail(`${name}: it connects to ${connected[0]}, refused: an export's reader reads the file it is handed and connects to nothing`), false;
      if (handed.error !== undefined) return fail(`${name}: a newer export handed in, its import threw ${threw(handed.error)}`), false;
      if (unimported !== undefined) return fail(`${name}: what it handed in does not import: ${unimported}`), false;
      if (run.misread !== undefined) return fail(`${name}: test/fixture.ts: ${run.misread}`), false;
      return true;
    };

    const first = await hand(scenario);
    if (direct.length > 0) return fail(`hands in: it requests ${direct[0]}: an export's reader reads the file it is handed and requests nothing`);
    if (connected.length > 0) return fail(`hands in: it connects to ${connected[0]}, refused: an export's reader reads the file it is handed and connects to nothing`);
    const handedWords = files.length === 1 ? "one file" : `a .zip of ${files.length} files`;
    if (first.error !== undefined) return fail(`hands in: handed ${handedWords}, its import threw ${threw(first.error)}`);
    if (first.asked !== null) return fail(`hands in: handed ${handedWords}, the home asks whose it is (${first.asked}): its reader's \`account\` reads the account the download names`);
    const patterns = connector.sources.map((each) => each.id);
    if (first.fed.length !== 1) return fail(`hands in: handed ${handedWords}, it fed ${first.fed.length === 0 ? "no source" : first.fed.join(", ")}: an export feeds one of ${patterns.map((each) => `\`${each}\``).join(", ")}`);
    const source = first.fed[0]!;
    if (!patterns.some((pattern) => copyOf(pattern, source))) return fail(`hands in: it fed ${source}, none of ${connector.id}'s sources (${patterns.map((each) => `\`${each}\``).join(", ")})`);
    if (unimported !== undefined) return fail(`hands in: what it handed in does not import: ${unimported}`);
    if (run.misread !== undefined) return fail(`hands in: test/fixture.ts: ${run.misread}`);
    const landed = run.ledger.size;
    if (landed === 0) return fail(`hands in: its delivery of ${source} landed no record`);
    sink.line(`hands in: run, ${handedWords} handed in, one delivery of ${source}, ${landed} record${landed === 1 ? "" : "s"}`);

    sink.case("replays");
    const again = await hand(scenario);
    if (ended("replays", again)) {
      const relanded = again.landed.added.length + again.landed.changed.length;
      if (relanded > 0) fail(`replays: the same export handed in again landed ${relanded} records again, new or as another version: an export handed in twice lands nothing new`);
      else sink.line(`replays: run, the same export handed in again, ${again.fed.length === 0 ? "already in: nothing read" : "no new version"}`);
    }

    if (typeof item !== "function") {
      const why = "no `item` in test/fixture.ts: which item of the scenario a record is, by its kind and key (ItemOf), with `files(scenario)` writing the `edited` items changed and leaving the `removed` out; templates/export";
      sink.line(`edits: not run (${why})`);
      sink.line(`removals: not run (${why})`);
    } else {
      const edited = scenario.items - 1;
      const removed = scenario.old;
      const shownNow = () => seen(context, { connector }, home, [source]);
      const immutable = context.fakes?.immutable === true;
      let beforeRemoval: string[] | undefined;
      sink.case("edits");
      const beforeEdit = await shownNow();
      const edit = await hand(scenarioOf(N, { edited: [edited] }));
      if (ended("edits", edit)) {
        const fault = editFault(edit.landed, edited, "the export handed in after", immutable);
        if (fault !== null) fail(fault);
        else if (immutable) sink.line(`edits: run, the edited item landed nothing new (${IMMUTABLE})`);
        else {
          beforeRemoval = await shownNow();
          sink.line("edits: run, the edited item landed one new version");
          const lines = changeLines(beforeEdit, beforeRemoval);
          for (const line of lines.length > 0 ? lines : ["the day and search read the same after it: its adapter shows none of what changed"]) sink.line(`edits: ${line}`);
        }
      }
      sink.case("removals");
      beforeRemoval ??= await shownNow();
      const its = liveOf(run.ledger, removed);
      const removal = await hand(scenarioOf(N, { edited: [edited], removed: [removed] }));
      if (ended("removals", removal)) {
        const verdict = removalVerdict(removal.landed, removed, its, run.ledger, false);
        if ("fault" in verdict) fail(verdict.fault);
        else {
          sink.line(`removals: run, ${verdict.gone === 0 ? "nothing changed: the export states no removals" : "the removed item went gone"}`);
          if (verdict.gone > 0) for (const line of changeLines(beforeRemoval, await shownNow())) sink.line(`removals: ${line}`);
        }
      }
    }
    await reachesTheDay(context, { connector }, home, [source], sink);
  } finally {
    release();
  }
}

function zipStored(files: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [path, bytes] of files) {
    const name = Buffer.from(path, "utf8");
    const crc = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(bytes.length, 20);
    entry.writeUInt32LE(bytes.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes);
    central.push(entry, name);
    offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}


function ledgerOf(home: Landing, item: (kind: string, key: string) => number | null = () => null): Ledger {
  const view = home.read.view();
  try {
    const records = new Map<string, Held & { versions: string[] }>();
    for (const statement of view.statements(0)) {
      const key = `${statement.source}\0${statement.kind}\0${statement.key}`;
      const held = records.get(key) ?? { kind: statement.kind, key: statement.key, versions: [], item: item(statement.kind, statement.key) };
      if (held.versions.at(-1) !== statement.version) held.versions.push(statement.version);
      records.set(key, held);
    }
    return records;
  } finally {
    view.close();
  }
}

function itemOf(run: Omit<Run, "acquirer">, kind: string, key: string): number | null {
  let named: unknown;
  try {
    named = run.item({ kind, key });
  } catch (error) {
    run.misread ??= `its item threw on ${kind} ${key}: ${errorText(error).split("\n")[0]}`;
    return null;
  }
  if (named === null || named === undefined) return null;
  if (typeof named === "number" && Number.isInteger(named) && named >= 0 && named < run.scenario.items) return named;
  run.misread ??= `its item names ${JSON.stringify(named)} for ${kind} ${key}, while the scenario holds items 0 to ${run.scenario.items - 1}: \`item\` names the item a record is by the number its fake gave it, null for a record no item makes`;
  return null;
}

function itemsIn(records: readonly Held[]): Set<number> {
  return new Set(records.flatMap((each) => (each.item === null ? [] : [each.item])));
}

const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, at) => from + at);

function listed(items: Iterable<number>): string {
  const sorted = [...new Set(items)].sort((a, b) => a - b);
  const runs: string[] = [];
  for (let at = 0; at < sorted.length;) {
    let end = at;
    while (end + 1 < sorted.length && sorted[end + 1] === sorted[end]! + 1) end++;
    runs.push(end === at ? String(sorted[at]) : `${sorted[at]}–${sorted[end]}`);
    at = end + 1;
  }
  return `item${sorted.length === 1 ? "" : "s"} ${runs.length > 4 ? `${runs.slice(0, 4).join(", ")}, …` : runs.join(", ")}`;
}

function distinct(versions: readonly string[]): number {
  return new Set(versions).size;
}

function threw(error: unknown): string {
  if (error instanceof NeedsYou) return `NeedsYou ${error.reason} (${error.message.split("\n")[0]})`;
  if (error instanceof NotYet) return `NotYet ${error.reason} with no wait (${error.message.split("\n")[0]})`;
  return `"${errorText(error).split("\n")[0]}"`;
}
