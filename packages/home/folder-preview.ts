import { constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, statfsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { callMemory, cursorText, LENT, memorySecrets, ownExport, roadsOf, sealedFacts, secretFieldOf, withRoadDefaults, type Acquirer, type Connector, type Entry, type FetchedFile } from "@lifestreamprotocol/connect";
import { daysOf, type HomeFolder, type Json, type JsonObject, type Work } from "@lifestreamprotocol/core";
import { renderDay } from "@lifestreamprotocol/families";
import { dayLines, inspectLanding, labelsOf, landDelivery, landImport, readerOf, scratchLanding, type Landable, type Landing, type LandedImport } from "./fixture-day.js";
import { HOME_DEPENDENCIES } from "./dependencies.js";
import { readDelivery } from "./inbox.js";
import { importFolder, loadGeneration } from "./folders.js";
import { errorText } from "./jobs.js";
import { checkMember, connectorSettings, effectiveOf, SettingsError, type Settings } from "./settings.js";
import { CLI } from "./cli-name.js";
import { fail, VerbError } from "./verbs/context.js";
import type { Days } from "./verbs/connectors-folder.js";

export const DAY_LINES = 20;
const PREVIEW = "connector-preview";
export const REFUSALS_NAMED = 3;
export const SECRET_WORDS = "a secret is never typed on the command line, where shell history and the process list keep it: `-` reads it from standard input";

export interface PreviewDisk {
  clone(from: string, to: string): void;
  free(dir: string): number;
}

const DISK: PreviewDisk = {
  clone: (from, to) => copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE),
  free: (dir) => {
    const stat = statfsSync(dir);
    return stat.bavail * stat.bsize;
  },
};

export interface PreviewOptions {
  readonly home?: HomeFolder;
  readonly folder: string;
  readonly path?: string;
  readonly sets: readonly string[];
  readonly cwd: string;
  readonly days: Days;
  readonly unit: string;
  readonly out: (line: string) => void;
  readonly disk?: PreviewDisk;
  readonly input: (secret: AskedSecret) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
  readonly signals?: NodeJS.EventEmitter;
}

export interface PreviewedAcquirer {
  readonly name: string;
  readonly ran: boolean;
  readonly why?: string;
  readonly deliveries?: readonly { readonly source: string; readonly bytes: number; readonly run: number | null }[];
  readonly ms?: number;
}

export interface Preview {
  readonly folder: string;
  readonly acquirers: readonly PreviewedAcquirer[];
  readonly kinds: readonly { readonly kind: string; readonly records: number; readonly first: string | null; readonly last: string | null }[];
  readonly refused: number;
  readonly faults: readonly string[];
}

export async function previewFolder(options: PreviewOptions): Promise<Preview> {
  const work = scratchOf(options.home);
  const scratch = work.path;
  const stop = new AbortController();
  const signalled = (signal: NodeJS.Signals) => stop.abort(new VerbError(`preview stopped (${signal}): nothing was kept, the scratch home is removed`));
  const stopped = new Promise<never>((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
  stopped.catch(() => undefined);
  const signals = options.signals ?? process;
  signals.on("SIGINT", signalled).on("SIGTERM", signalled);
  let clear: (text: string) => string = (text) => text;
  const out = (line: string) => options.out(clear(line));
  try {
    const previewed = previewIn(scratch, { ...options, out }, stop.signal, (secret, value) => (clear = clearing(secret, value)));
    previewed.catch(() => undefined);
    return cleared(await Promise.race([previewed, stopped]), clear);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const said = clear(message);
    if (said === message) throw error;
    throw error instanceof VerbError ? new VerbError(said) : new Error(said);
  } finally {
    signals.off("SIGINT", signalled).off("SIGTERM", signalled);
    work.empty();
  }
}

function scratchOf(home: HomeFolder | undefined): Work {
  if (home !== undefined) return home.work(PREVIEW);
  const path = mkdtempSync(join(tmpdir(), `lifestream-${PREVIEW}-`));
  return { path, empty: () => rmSync(path, { recursive: true, force: true }) };
}

async function previewIn(scratch: string, options: PreviewOptions, signal: AbortSignal, secretRead: (secret: AskedSecret, value: string) => void): Promise<Preview> {
  const { folder, out } = options;
  const disk = options.disk ?? DISK;
  const { entry, digest } = await loaded(folder, scratch);
  signal.throwIfAborted();
  const { blocks: sets, secret } = blocksOf(entry.connectors, options.sets, options.cwd);
  let given: Record<string, string> = {};
  if (secret !== undefined) {
    const value = await options.input(secret);
    secretRead(secret, value);
    given = { [secret.name]: value };
  }
  signal.throwIfAborted();
  const settings = effectiveOf({
    "day.zone": options.days.zone, "day.day_start_hour": options.days.day_start_hour, unit: options.unit,
    ...Object.fromEntries([...sets].map(([id, block]) => [`connectors.${id}`, block])),
  }, "the preview").settings;
  mkdirSync(join(scratch, "home", "work"), { recursive: true });
  const home = scratchLanding(join(scratch, "home"), { ...entry, ...(digest === undefined ? {} : { digest }) }, settings);
  const base = options.fetch ?? globalThis.fetch;
  const fetch: typeof globalThis.fetch = (input, init) => base(input, { ...init, signal: init?.signal == null ? signal : AbortSignal.any([init.signal, signal]) });
  try {
    const faults: string[] = [];
    const acquirers: PreviewedAcquirer[] = [];
    const sources = new Map<string, string>();
    let at_ms = Date.now();
    const hour = `${String(options.days.day_start_hour).padStart(2, "0")}:00`;
    out(`Days in ${options.days.zone}, each from ${hour} (${options.days.from}):`);
    for (const connector of entry.connectors) {
      for (const name of connector.acquirers ?? []) {
        const factory = entry.acquirers?.[name];
        if (factory === undefined) continue;
        const its = secret !== undefined && secret.connector === connector.id ? secret : undefined;
        const why = notRun(connector, name, sets.get(connector.id) ?? {}, its?.member);
        if (why !== null) {
          acquirers.push({ name, ran: false, why });
          out(`${name}: not run (${why})`);
          continue;
        }
        const ran = await runOnce(home, connector, name, factory, settings, its === undefined ? {} : { ...given }, disk, () => (at_ms += 1_000), fetch, signal);
        acquirers.push(ran.acquirer);
        for (const delivery of ran.acquirer.deliveries ?? []) sources.set(delivery.source, readerOf(connector, delivery.source));
        faults.push(...ran.faults);
        for (const line of ran.lines) out(line);
      }
    }
    for (const connector of entry.connectors.filter((each) => ownExport(each) !== null && !Object.hasOwn(entry.acquirers ?? {}, each.id))) {
      if (options.path === undefined) {
        const why = `name the export you downloaded: ${CLI} connectors preview ${basename(folder)} <path>`;
        acquirers.push({ name: connector.id, ran: false, why });
        out(`${connector.id}: not run (${why})`);
        continue;
      }
      const ran = await importOnce(home, connector, pathOf(options.path, options.cwd, homedir()), disk, () => (at_ms += 1_000));
      acquirers.push(ran.acquirer);
      for (const delivery of ran.acquirer.deliveries ?? []) sources.set(delivery.source, readerOf(connector, delivery.source));
      faults.push(...ran.faults);
      for (const line of ran.lines) out(line);
    }
    if (!acquirers.some((each) => each.ran)) {
      const stores = entry.connectors.filter((connector) => connector.mac?.store !== undefined).map((connector) => `${connector.id}: ${storeWords(connector)}`);
      fail(`${basename(folder)} has nothing preview can read before install: ${[...acquirers.map((each) => `${each.name}: ${each.why}`), ...stores].join("; ") || "no acquirer"}`);
    }
    faults.push(...(await inspectLanding(home, entry, sources, { lines: false })).faults);
    signal.throwIfAborted();
    const read = readBack(home, entry, acquirers, settings);
    for (const line of read.lines) out(line);
    for (const fault of faults) out(fault);
    return { folder, acquirers, kinds: read.kinds, refused: read.refused, faults };
  } finally {
    home.read.close();
    home.db.close();
  }
}

export function clearing(secret: Pick<AskedSecret, "member">, value: string): (text: string) => string {
  const spellings = new Set([value, encodeURIComponent(value), encodeURI(value), JSON.stringify(value).slice(1, -1)]);
  try {
    spellings.add(new URL(value).href);
  } catch {
  }
  const each = [...spellings].filter((spelling) => spelling.length > 0).sort((a, b) => b.length - a.length);
  return (text) => each.reduce((said, spelling) => said.replaceAll(spelling, `<${secret.member}>`), text);
}

function cleared<T>(value: T, clear: (text: string) => string): T {
  if (typeof value === "string") return clear(value) as T;
  if (Array.isArray(value)) return value.map((each) => cleared(each, clear)) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, each]) => [clear(key), cleared(each, clear)])) as T;
  return value;
}

async function loaded(folder: string, scratch: string): Promise<{ entry: Entry; digest?: string }> {
  const root = join(scratch, "admit");
  const name = basename(folder);
  mkdirSync(join(root, "connectors"), { recursive: true });
  cpSync(folder, join(root, "connectors", name), { recursive: true, dereference: true });
  const generation = await loadGeneration({ root, machineDir: join(scratch, "machine") });
  const refused = generation.refused.find((each) => each.name === name);
  if (refused !== undefined) {
    fail(`${name} does not load: ${refused.faults.map(([member, reason]) => `${member}: ${reason}`).join("; ")}. ${CLI} connectors test ${name} says each fault`);
  }
  const at = generation.folders.find((each) => each.name === name)!;
  const module = (await importFolder(at.entry, generation.store, generation.sdk)) as Entry;
  return { entry: { ...module, connectors: module.connectors.map(withRoadDefaults) }, ...(at.digest === undefined ? {} : { digest: at.digest }) };
}

export interface AskedSecret {
  readonly connector: string;
  readonly member: string;
  readonly label: string;
  readonly name: string;
}

export function blocksOf(connectors: readonly Connector[], words: readonly string[], cwd: string, home: string = homedir()): { blocks: Map<string, JsonObject>; secret?: AskedSecret } {
  const blocks = new Map<string, JsonObject>();
  let secret: AskedSecret | undefined;
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0) fail(`--set takes <field>=<value>: ${JSON.stringify(word)}`);
    const member = word.slice(0, at);
    const holders = connectors.filter((connector) => connector.fields?.[member] !== undefined);
    if (holders.length === 0) {
      const fields = [...new Set(connectors.flatMap((connector) => Object.keys(connector.fields ?? {})))];
      fail(`${member} is no field of ${connectors.map((each) => each.id).join(", ")}: ${fields.length === 0 ? "it declares none" : `its fields are ${fields.join(", ")}`}`);
    }
    for (const connector of holders) {
      const field = connector.fields![member]!;
      const text = word.slice(at + 1);
      if (field.kind === "secret") {
        if (text !== "-") fail(`${member}: ${SECRET_WORDS} (--set ${member}=-)`);
        if (secret !== undefined && (secret.connector !== connector.id || secret.member !== member)) fail(`${member}: one secret a preview, from its one standard input, and ${secret.member} is read already`);
        secret = { connector: connector.id, member, label: field.label, name: field.secret };
        continue;
      }
      const value: Json = field.kind === "path" ? pathOf(text, cwd, home) : WORDS_KINDS.has(field.kind) ? text : parsed(text);
      try {
        checkMember(connector, member, value, []);
      } catch (error) {
        if (error instanceof SettingsError) fail(error.message);
        throw error;
      }
      blocks.set(connector.id, { ...blocks.get(connector.id), [member]: value });
    }
  }
  return { blocks, ...(secret === undefined ? {} : { secret }) };
}

function pathOf(text: string, cwd: string, home: string): string {
  if (text === "~") return home;
  if (text.startsWith("~/")) return join(home, text.slice(2));
  return isAbsolute(text) ? text : resolve(cwd, text);
}

const WORDS_KINDS: ReadonlySet<string> = new Set(["path", "email", "text", "date", "zone", "choice", "duration"]);

function parsed(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

const testWords = (connector: Connector) => `${CLI} connectors test ${connector.id} runs it over its own scenario (test/fixture.ts) and prints what it lands as the day and search show it`;

function storeWords(connector: Connector): string {
  return `the Mac app reads its store once installed and allowed on this Mac (Set up › Allow): ${CLI} connectors test ${connector.id} prints its fixture's store as the day and search show it`;
}

function notRun(connector: Connector, acquirer: string, block: JsonObject, secret: string | undefined): string | null {
  const routes = (connector.signin ?? []).filter((each) => each.acquirer === acquirer);
  const route = routes.find((each) => each.way === "key") ?? routes[0];
  if (route !== undefined && route.way !== "key") {
    return `it signs in by OAuth (${route.label}), which only the installed home does; once installed and signed in, ${CLI} connectors show ${connector.id} says its first poll. ${testWords(connector)}`;
  }
  if (connector.chrome !== undefined || connector.sources.some((source) => roadsOf(source).includes("chrome"))) {
    return `its input is a site in your Chrome, read through the extension once installed and turned on. ${testWords(connector)}`;
  }
  const secrets = route !== undefined ? [secretFieldOf(connector, route)]
    : connector.signin === undefined ? Object.entries(connector.fields ?? {}).filter(([, field]) => field.kind === "secret").map(([member]) => member) : [];
  const missing = secrets.filter((member) => member !== secret);
  if (missing.length > 1) return `it reads ${missing.length} secrets (${missing.map((member) => `\`${member}\``).join(", ")}), and a preview takes one, from standard input: install, then set them up`;
  if (missing.length === 1) return `give its secret \`${missing[0]}\` as --set ${missing[0]}=-, read from standard input and held in this preview's memory alone`;
  const { unset } = connectorSettings(connector, block);
  if (unset.length > 0) return `name ${unset.map((field) => `\`${field}\``).join(" and ")}: --set ${unset.map((field) => `${field}=<value>`).join(" --set ")}`;
  return null;
}

async function runOnce(
  home: Landing, connector: Connector, name: string, factory: (settings: never, dependencies?: { fetch?: typeof globalThis.fetch }) => Acquirer, settings: Settings,
  secrets: Record<string, string>, disk: PreviewDisk, instant: () => number, fetch: typeof globalThis.fetch, signal: AbortSignal,
): Promise<{ acquirer: PreviewedAcquirer; faults: string[]; lines: string[] }> {
  const work = join(home.folder.root, "work", name);
  mkdirSync(work, { recursive: true });
  const { built } = connectorSettings(connector, settings.connectors[connector.id]);
  const started = Date.now();
  const lines: string[] = [];
  const faults: string[] = [];
  const deliveries: { source: string; bytes: number; run: number | null }[] = [];
  const said = (ms: number) => ({ name, ran: true, deliveries, ms });
  let acquirer: Acquirer;
  try {
    acquirer = factory({ ...built, work, zone: settings.day.zone, unit: settings.unit } as never, { ...HOME_DEPENDENCIES, fetch });
  } catch (error) {
    faults.push(`acquirers.${name}: not built from its settings: ${errorText(error).split("\n")[0]}`);
    return { acquirer: said(Date.now() - started), faults, lines };
  }
  const memory = callMemory(null);
  let fetched: Awaited<ReturnType<Acquirer["fetch"]>>;
  let facts: JsonObject | null;
  try {
    fetched = await acquirer.fetch(null, memorySecrets(secrets), { ...LENT, memory });
    cursorText(fetched.state);
    facts = sealedFacts(name, "fetch", fetched, null);
  } catch (error) {
    signal.throwIfAborted();
    faults.push(`acquirers.${name}: its fetch threw: ${errorText(error).split("\n")[0]}`);
    return { acquirer: said(Date.now() - started), faults, lines };
  } finally {
    memory.end();
  }
  signal.throwIfAborted();
  if (facts === null) lines.push(`${name}: nothing to read: its fetch answered no file`);
  else {
    const stated = Array.isArray(fetched.facts.sources) && fetched.facts.sources.length === 1 ? (fetched.facts.sources[0] as { id?: unknown }).id : undefined;
    const source = typeof stated === "string" ? stated : acquirer.source;
    const files: Record<string, Landable> = {};
    let bytes = 0;
    for (const [index, file] of fetched.files.entries()) {
      if (files[file.path] !== undefined) {
        faults.push(`acquirers.${name}: it fetched ${file.path} twice`);
        return { acquirer: said(Date.now() - started), faults, lines };
      }
      const given = landable(home.folder.root, file, join(home.folder.root, "handed", String(index)), disk);
      bytes += Buffer.isBuffer(given) ? given.length : statSync(given.file).size;
      files[file.path] = given;
    }
    const landed = await landDelivery(home, readerOf(connector, source), { source, facts, files }, join(home.folder.root, "carried"), files, instant());
    const view = home.read.view();
    try {
      const row = view.tables.deliveries.get(landed.delivery, source);
      if (landed.run === null || row?.state !== "imported") faults.push(`acquirers.${name}: its delivery of ${source} is ${row?.state ?? "not indexed"}${row?.error ? `: ${row.error.split("\n")[0]}` : ""}`);
    } finally {
      view.close();
    }
    deliveries.push({ source, bytes, run: landed.run });
  }
  const ms = Date.now() - started;
  const more = "more" in fetched && fetched.more === true ? "; it says there is more, which a home reads at its next call" : "";
  for (const delivery of deliveries) lines.push(`${name}: one delivery of ${delivery.source}, ${size(delivery.bytes)}, read in ${seconds(ms)}${more}`);
  return { acquirer: said(ms), faults, lines };
}

async function importOnce(home: Landing, connector: Connector, path: string, disk: PreviewDisk, instant: () => number): Promise<{ acquirer: PreviewedAcquirer; faults: string[]; lines: string[] }> {
  const name = connector.id;
  const started = Date.now();
  const lines: string[] = [];
  const faults: string[] = [];
  const deliveries: { source: string; bytes: number; run: number | null }[] = [];
  if (!existsSync(path)) fail(`${path} is no file or folder: name the export you downloaded`);
  const folder = statSync(path).isDirectory();
  const handed = folder ? path : (landable(home.folder.root, { path: basename(path), file: path }, join(home.folder.root, "handed", basename(path)), disk) as { file: string }).file;
  let landed: LandedImport;
  try {
    landed = await landImport(home, connector.id, handed, instant(), { adopt: !folder });
  } catch (error) {
    faults.push(`${name}: its import threw: ${errorText(error).split("\n")[0]}`);
    return { acquirer: { name, ran: true, deliveries, ms: Date.now() - started }, faults, lines };
  }
  const held = landed.import;
  if (held?.ended === true) lines.push(`${name}: refused: ${held.refused ?? "this isn't its export"}`);
  else if (held !== null && held.account === null) lines.push(`${name}: the home would ask whose it is: ${held.refused ?? "the file names no account"}`);
  const view = home.read.view();
  try {
    const bytes = (readDelivery(home.folder, ...splitDelivery(landed.delivery))?.files ?? []).reduce((sum, file) => sum + file.size, 0);
    for (const [source, run] of Object.entries(landed.runs)) {
      const row = view.tables.deliveries.get(landed.delivery, source);
      if (run === null || row?.state !== "imported") faults.push(`${name}: its delivery of ${source} is ${row?.state ?? "not indexed"}${row?.error ? `: ${row.error.split("\n")[0]}` : ""}`);
      deliveries.push({ source, bytes, run });
    }
  } finally {
    view.close();
  }
  const ms = Date.now() - started;
  for (const delivery of deliveries) lines.push(`${name}: one delivery of ${delivery.source}, ${size(delivery.bytes)}, read in ${seconds(ms)}`);
  return { acquirer: { name, ran: true, deliveries, ms }, faults, lines };
}

const splitDelivery = (id: string): [string, string] => [id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)];

function landable(root: string, file: FetchedFile, into: string, disk: PreviewDisk): Landable {
  if ("bytes" in file) return file.bytes;
  const within = relative(root, file.file);
  if (within !== "" && !within.startsWith("..") && !isAbsolute(within)) return { file: file.file };
  mkdirSync(join(into, ".."), { recursive: true });
  try {
    disk.clone(file.file, into);
    return { file: into };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM") throw error;
  }
  const needed = statSync(file.file).size;
  const free = disk.free(join(into, ".."));
  if (free < needed) {
    fail(`${file.file} is ${size(needed)}, its disk cannot clone it into the scratch home (${tmpdir()}), and that disk has ${size(free)} free: free ${size(needed - free)} there, or move the file onto that disk`);
  }
  copyFileSync(file.file, into);
  return { file: into };
}

function readBack(home: Landing, entry: Entry, acquirers: readonly PreviewedAcquirer[], settings: Settings): Pick<Preview, "kinds" | "refused"> & { lines: string[] } {
  const delivered = acquirers.flatMap((each) => each.deliveries ?? []);
  const sources = new Set(delivered.map((each) => each.source));
  const ownKinds = [...new Set(entry.readers.flatMap((reader) => Object.keys(reader.kinds)))];
  const lines: string[] = [];
  const view = home.read.view();
  try {
    const kinds = new Map<string, { records: number; first: string | null; last: string | null }>();
    for (const source of sources) {
      for (const kind of ownKinds) {
        for (const head of view.heads(source, kind)) {
          if (head.version === "gone") continue;
          const held = kinds.get(kind) ?? { records: 0, first: null, last: null };
          const time = view.version(head.version)?.time;
          const days = time === undefined ? [] : daysOf(time, settings.day);
          if (days.length > 0) {
            held.first = held.first === null || days[0]! < held.first ? days[0]! : held.first;
            held.last = held.last === null || days.at(-1)! > held.last ? days.at(-1)! : held.last;
          }
          held.records++;
          kinds.set(kind, held);
        }
      }
    }
    const counted = [...kinds].sort(([a], [b]) => a.localeCompare(b)).map(([kind, held]) => ({ kind, ...held }));
    for (const each of counted) {
      const span = each.first === null ? ", no day" : each.first === each.last ? `, on ${each.first}` : `, ${each.first} to ${each.last}`;
      lines.push(`${count(each.records)} ${each.kind}${span}`);
    }
    if (counted.length === 0) lines.push("no record landed");

    let refused = 0;
    const named: string[] = [];
    for (const { run } of delivered) {
      const counts = ((run === null ? undefined : view.tables.runs.get(run)?.counts) ?? {}) as { refused?: number; refusals?: { kind: string; key: string; violations: string[] }[] };
      refused += counts.refused ?? 0;
      for (const refusal of counts.refusals ?? []) if (named.length < REFUSALS_NAMED) named.push(`${refusal.kind} ${refusal.key}: ${refusal.violations.join("; ")}`);
    }
    lines.push(refused === 0 ? "refused: none" : `refused ${count(refused)}, the first ${named.length}: ${named.join(" | ")}`);

    const days = home.db.commit((tx) => tx.derived.extracts.days()).sort();
    const labels = labelsOf(view);
    const printed = (day: string): string[] | null => {
      try {
        const lines = dayLines(day, renderDay(day, home.registry.families, view, settings.day, labels), sources);
        return lines.length === 0 ? null : lines;
      } catch {
        return null;
      }
    };
    const first = firstPrinting(days, printed);
    const last = first === null ? null : firstPrinting([...days].reverse().filter((day) => day > first.day), printed);
    if (first === null) lines.push("no day prints a line of it");
    for (const [label, shown] of [["First day", first], ["Last day", last]] as const) {
      if (shown === null) continue;
      lines.push(`${label}, ${shown.day}:`);
      lines.push(...shown.lines.slice(0, DAY_LINES));
      if (shown.lines.length > DAY_LINES) lines.push(`… and ${count(shown.lines.length - DAY_LINES)} more lines of ${shown.day}`);
    }
    return { kinds: counted, refused, lines };
  } finally {
    view.close();
  }
}

function firstPrinting(days: readonly string[], printed: (day: string) => string[] | null): { day: string; lines: string[] } | null {
  for (const day of days) {
    const lines = printed(day);
    if (lines !== null) return { day, lines };
  }
  return null;
}

const count = (n: number) => n.toLocaleString("en-US");
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  for (; value >= 1024 && unit < units.length - 1; unit++) value /= 1024;
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
