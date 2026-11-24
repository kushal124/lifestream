import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Connector } from "@lifestreamprotocol/connect";
import { plainFolder, writeDurably, type DaySettings, type HomeFolder } from "@lifestreamprotocol/core";
import { folderTsconfig, runFolder, typeCheck, typesOf } from "../conformance.js";
import { clashOf, connectorsFolder, declaredGeneration, folderDigest, folderStamp, GONE, homeFolders, installedFile, installedOf, loading, type DeclaredGeneration, type Generation, type Installed, type Named } from "../folders.js";
import { machine, type Machine } from "../machine.js";
import { fromRelease, releaseFolder, repoRoot } from "../programs.js";
import { jobLabel, launchd } from "../release.js";
import { blockOf, effective, effectiveOf, planned, runsAt } from "../settings.js";
import { folderHere, homeSocket, notBuiltKeyed } from "../lifecycle.js";
import { askHome, NoHomeError } from "../socket.js";
import { DOOR_AWAY, Refusal } from "../refusal.js";
import { fail, VerbError } from "./context.js";
import { catalogOf, switchOf } from "../catalog.js";
import { HomeFile } from "../home-file.js";
import { CLI, typed } from "../cli-name.js";
import { previewFolder, type AskedSecret, type Preview } from "../folder-preview.js";
import { secretInput } from "../secret-input.js";
import { RELEASE_KINDS, templatePages, templatesFolder } from "../templates.js";

export const FOLDER_ACTIONS: ReadonlySet<string> = new Set(["new", "test", "preview", "install", "remove"]);
export const FOLDER_USAGE = "connectors new [<kind> <id>] [--into <folder>] | connectors test <id|folder> | connectors preview <id|folder> [<path>] [--set <field>=<value>…] | connectors install <id|folder> | connectors remove <id|folder>";

const WORD = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PREVIEW_UNIT = "this-mac";
const START_MS = 120_000;
const ASK_STEPS_MS = [15, 30, 60, 120, 250, 500, 1_000] as const;
const DOOR_MS = 30_000;
const pascal = (text: string) => text.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join("");
const camel = (text: string) => pascal(text).replace(/^./u, (first) => first.toLowerCase());

export class FolderFailed extends VerbError {
  constructor(message: string, readonly answer: unknown) {
    super(message);
  }
}

export interface FolderContext {
  readonly root: string | null;
  readonly cwd: string;
  readonly out: (line: string) => void;
  readonly machine?: Machine;
  readonly restart?: () => boolean;
  readonly input?: (secret: AskedSecret) => Promise<string>;
}

export async function folderVerb(ctx: FolderContext, args: readonly string[]): Promise<unknown> {
  const [action, ...given] = args;
  const sets: string[] = [];
  const rest: string[] = [];
  for (let at = 0; at < given.length; at++) {
    if (given[at] !== "--set") rest.push(given[at]!);
    else if (action !== "preview" || given[at + 1] === undefined) fail(`usage: ${CLI} ${FOLDER_USAGE}`);
    else sets.push(given[++at]!);
  }
  const into = rest.indexOf("--into");
  const named = into < 0 ? undefined : rest[into + 1];
  const words = into < 0 ? rest : rest.filter((_, index) => index !== into && index !== into + 1);
  if (into >= 0 && (action !== "new" || named === undefined)) fail(`usage: ${CLI} ${FOLDER_USAGE}`);
  if (action === "new" && words.length === 0 && into < 0) {
    for (const line of [`usage: ${CLI} connectors new <kind> <id>, a kind one of:`, ...kindLines()]) ctx.out(line);
    return { kinds: homeKinds() };
  }
  if (action === "new" && words.length === 2) return made(ctx, words[0]!, words[1]!, named);
  if (action === "test" && words.length === 1) return tested(ctx, await folderOf(ctx, words[0]!, "test"));
  if (action === "preview" && (words.length === 1 || words.length === 2)) return await previewed(ctx, words[0]!, await folderOf(ctx, words[0]!, "preview"), sets, words[1]);
  if (action === "install" && words.length === 1) return await installed(ctx, await folderOf(ctx, words[0]!, "install"));
  if (action === "remove" && words.length === 1) return await removed(ctx, await folderOf(ctx, words[0]!, "remove"));
  return fail(`usage: ${CLI} ${FOLDER_USAGE}`);
}

const place = (ctx: FolderContext, path: string) => (isAbsolute(path) ? path : resolve(ctx.cwd, path));
const homeOf = (ctx: FolderContext): string => ctx.root ?? fail("this machine holds no home: name one with --root <path>");
const machineOf = (ctx: FolderContext): Machine => ctx.machine ?? machine();

function files(dir: string, under = ""): string[] {
  return readdirSync(join(dir, under)).flatMap((name) => (statSync(join(dir, under, name)).isDirectory() ? files(dir, join(under, name)) : [join(under, name)]));
}

export function draftsFolder(root: string): string {
  return join(connectorsFolder(root), ".drafts");
}


const homeKinds = (): string[] => readdirSync(templatesFolder(), { withFileTypes: true }).filter((entry) => entry.isDirectory() && !RELEASE_KINDS.has(entry.name)).map((entry) => entry.name).sort();

export function kindLines(): string[] {
  const kinds = homeKinds();
  const width = Math.max(...kinds.map((kind) => kind.length));
  return kinds.map((kind) => `  ${kind.padEnd(width)}  ${firstSentence(join(templatesFolder(), kind, `${kind}.md`), kind)}`);
}

function firstSentence(page: string, kind: string): string {
  const text = existsSync(page) ? readFileSync(page, "utf8").split("\n").filter((line) => !line.startsWith("#")).join(" ").replace(/\s+/gu, " ").trim() : "";
  const sentence = /^.*?\.(?=\s|$)/u.exec(text)?.[0] ?? text;
  const bare = sentence.replace(new RegExp(`^The \`${kind}\` kind's template(?: \\([^)]*\\))?: `, "u"), "");
  return bare === "" ? `a ${kind} connector` : bare;
}

export function guidePath(at: Machine): string {
  return fromRelease() ? join(at.dir, "current", "packages", "connect", "SKILL.md") : join(repoRoot(), "packages", "connect", "SKILL.md");
}

export function connectorsHelp(at: Machine): string[] {
  const verbs: [string, string][] = [
    ["new <kind> <id>", "drafts it in <root>/connectors/.drafts/<id>, which no start loads; <id> is the product's own words, its id for good"],
    ["test <id>", "runs it over its fixtures in a scratch home: its faults, else the lines a day shows"],
    ["preview <id> [<path>] --set <field>=<value>", "reads your real input into a scratch home, before install: an export you downloaded at <path>; a secret as --set <field>=-, from standard input"],
    ["install <id>", "tests it beside the home's folders, installs it, restarts the home and answers once it runs"],
    ["reread <id>", "reads its source again from the start, its records kept"],
    ["remove <id>", "takes it out of the home, kept in connectors/.removed; its records stay"],
    ["show <id>", "its settings, how each sign-in signs in (an OAuth route's whole address), and each source's last poll"],
    ["refresh <id>", "reads what is new now, as its stream's Refresh does: a Mac's copy asked of the Mac"],
  ];
  const width = Math.max(...verbs.map(([verb]) => verb.length));
  return [
    "",
    "A connector of your own, from draft to installed:",
    ...verbs.map(([verb, does]) => `  ${CLI} connectors ${verb.padEnd(width)}  ${does}`),
    "",
    "The kinds a home folder can be:",
    ...kindLines(),
    "",
    "preview reads an export at the path you name, a folder the person picks, an address, and a key or a link given on standard input; an OAuth sign-in, a Chrome site or a Mac app's store meets its real input once installed and allowed, and test prints what the same code lands from the folder's own scenario, as the day and search show it.",
    "",
    `An installed connector's fields are set in the Lifestream app's Streams, or by ${CLI} connectors set <id> <field> <value> [<field> <value>…]: fields that change together go in one set; each call polls at once.`,
    "",
    `What Chat's model reads of it: ${CLI} agents call lists the tools and their arguments; ${CLI} agents call <tool> '<json arguments>' prints one's answer.`,
    "",
    `The guide: ${guidePath(at)}`,
  ];
}


function made(ctx: FolderContext, kind: string, id: string, into: string | undefined): { kind: string; id: string; folder: string } {
  const templates = templatesFolder();
  const kinds = readdirSync(templates, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  if (kind === "line") fail(`line is not a way data arrives: pick one (${kinds.filter((each) => !RELEASE_KINDS.has(each)).join(", ")}) and state a line in its adapter (its page, "No family fits")`);
  if (!kinds.includes(kind)) fail(`<kind> is one of ${kinds.filter((each) => !RELEASE_KINDS.has(each)).join(", ")}: ${CLI} connectors new prints what each is`);
  if (!WORD.test(id)) fail("<id> is lowercase words joined by hyphens: acme-notes");
  const target = into === undefined ? join(draftsFolder(homeOf(ctx)), id) : place(ctx, into);
  const at = target.split(sep).lastIndexOf("connect");
  const release = at > 0 && target.split(sep)[at - 1] === "packages" && existsSync(join(target.split(sep).slice(0, at + 1).join(sep), "sdk.ts"));
  if (RELEASE_KINDS.has(kind) && !release) fail(`a ${kind} connector is the release's alone: name a folder under packages/connect with --into`);
  if (existsSync(target)) fail(`${target} is there already`);
  const token = `example-${kind}`;
  const name = id.split("-").map((word) => word[0]!.toUpperCase() + word.slice(1)).join(" ");
  const renamed = (text: string) => text
    .replaceAll(token, id).replaceAll(pascal(token), pascal(id)).replaceAll(camel(token), camel(id))
    .replace(/(?<![\w@./-])example(?:-[a-z]+)?(?=[:"`])(?!\.com)/gu, id)
    .replace(/\bExample\b/gu, name);
  const source = join(templates, kind);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, filter: (path) => release || basename(path) !== "e2e.test.ts" });
  for (const path of files(target)) writeFileSync(join(target, path), renamed(readFileSync(join(target, path), "utf8")));
  renameSync(join(target, `${kind}.md`), join(target, `${id}.md`));
  if (!release) {
    const types = fromRelease() ? typesOf(join(machineOf(ctx).dir, "current"), true) : typesOf(repoRoot(), false);
    writeFileSync(join(target, "tsconfig.json"), `${JSON.stringify(folderTsconfig(types), null, 2)}\n`);
  }
  const drafted = into === undefined;
  const live = !drafted && ctx.root !== null && isInstalled(ctx.root, target);
  const by = drafted ? id : typed(target);
  ctx.out(release
    ? `${kind} ${id} at ${target}; then run npx tsx tools/connectors.ts`
    : live
      ? `${kind} ${id} at ${target}; the home loads it at its next start. ${CLI} connectors test ${by} checks it`
      : `${kind} ${id} drafted at ${target}${drafted ? ", which no start loads" : ""}. ${CLI} connectors test ${by} checks it; ${CLI} connectors install ${by} installs it`);
  return { kind, id, folder: target };
}


function isInstalled(root: string, folder: string): boolean {
  const home = connectorsFolder(root);
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : resolve(path));
  return !basename(folder).startsWith(".") && real(dirname(resolve(folder))) === real(home);
}

async function declared(ctx: FolderContext, root: string, folders: readonly Named[]): Promise<DeclaredGeneration> {
  try {
    return await declaredGeneration({ root, machineDir: machineOf(ctx).dir, folders });
  } catch (error) {
    return fail((error as Error).message);
  }
}

async function holderOf(ctx: FolderContext, root: string, id: string): Promise<string | undefined> {
  const names = homeFolders(root);
  const now = (await running(ctx, root))?.folders.find((each) => each.ids.includes(id))?.name;
  if (now !== undefined && names.includes(now)) return now;
  return Object.entries(readInstalled(root)).find(([name, install]) => names.includes(name) && install.ids.includes(id))?.[0];
}

async function folderOf(ctx: FolderContext, word: string, verb: "test" | "preview" | "install" | "remove"): Promise<string> {
  const root = ctx.root;
  if (WORD.test(word) && root !== null) {
    const draft = join(draftsFolder(root), word);
    if (verb !== "remove" && existsSync(draft)) return draft;
    const holder = await holderOf(ctx, root, word);
    if (holder !== undefined) {
      const from = verb === "remove" ? undefined : readInstalled(root)[holder]?.from;
      return from !== undefined && existsSync(from) ? from : join(connectorsFolder(root), holder);
    }
    if (homeFolders(root).includes(word)) return join(connectorsFolder(root), word);
    if (verb === "remove" && existsSync(draft)) fail(`${word} is a draft, never installed: nothing to remove`);
  }
  const path = place(ctx, word);
  if (existsSync(path)) {
    if (verb === "remove" && (root === null || !isInstalled(root, path))) fail(`${path} is not a folder of the home's connectors/: remove takes an installed connector's id or folder`);
    return path;
  }
  return fail(WORD.test(word)
    ? `no draft or installed connector ${word}${root === null ? "" : ` in ${root}`}: ${CLI} connectors new <kind> ${word} drafts one`
    : `no folder ${path}`);
}


interface Declared {
  readonly ids: readonly string[];
  readonly polls: boolean;
}

export interface Days extends DaySettings {
  readonly from: string;
}

export const RELEASE_DAYS: Days = { zone: "UTC", day_start_hour: runsAt(null, "day.day_start_hour") as number, from: "no home's settings" };

export function daysOf(root: string | null): Days {
  if (root === null) return RELEASE_DAYS;
  const zone = runsAt(root, "day.zone");
  const hour = runsAt(root, "day.day_start_hour") as number;
  return zone === null ? { zone: "UTC", day_start_hour: hour, from: "the home names no day zone yet" } : { zone: zone as string, day_start_hour: hour, from: "this home's settings" };
}

export async function conformanceOf(folder: string, days: Days = RELEASE_DAYS): Promise<{ faults: string[]; lines: string[] } & Declared> {
  if (!existsSync(join(folder))) fail(`no folder ${folder}`);
  const settings = effectiveOf({ "day.zone": days.zone, "day.day_start_hour": days.day_start_hour, unit: "macbook-pro-0001" }, "the conformance run").settings;
  const [{ faults: typed }, run] = await Promise.all([
    typeCheck(folder, fromRelease() ? typesOf(releaseFolder(), true) : typesOf(repoRoot(), false)),
    runFolder({ folder, settings }),
  ]);
  const hour = `${String(days.day_start_hour).padStart(2, "0")}:00`;
  return { faults: [...typed, ...run.faults], lines: run.lines.length === 0 ? [] : [`Days in ${days.zone}, each from ${hour} (${days.from}):`, ...run.lines], ids: run.ids, polls: run.polls };
}

async function tested(ctx: FolderContext, folder: string): Promise<{ folder: string; passed: boolean; faults: string[]; lines: string[]; owed: string[] } & Declared> {
  const run = await conformanceOf(folder, daysOf(ctx.root));
  const named = run.ids.length > 0 ? run.ids.join(", ") : basename(folder);
  const owed = templatePages(folder).map(({ page, kind }) => `before install: ${page} is still the ${kind} template's page; write what ${named} reads (its source, its kinds and keys, what its proof holds), templates/${kind}/${kind}.md's sections its shape`);
  for (const fault of run.faults) ctx.out(fault);
  if (run.faults.length > 0) throw new FolderFailed(`${named} fails the conformance run: ${run.faults.length} fault${run.faults.length === 1 ? "" : "s"}`, { folder, passed: false, ...run, owed });
  for (const line of [...run.lines, ...owed]) ctx.out(line);
  ctx.out(`${named} passes the conformance run`);
  return { folder, passed: true, ...run, owed };
}


async function previewed(ctx: FolderContext, word: string, folder: string, sets: readonly string[], path: string | undefined): Promise<Preview> {
  const unit = ctx.root === null ? null : runsAt(ctx.root, "unit");
  const input = ctx.input ?? ((secret: AskedSecret) => secretInput({
    label: secret.label, macApp: machineOf(ctx).macApp,
    piped: `printf '%s' "<${secret.label}>" | ${CLI} connectors preview ${typed(word)}${sets.map((set) => ` --set ${typed(set)}`).join("")}`,
  }));
  const preview = await previewFolder({ ...(ctx.root === null ? {} : { home: folderHere(ctx.root) }), folder, sets, ...(path === undefined ? {} : { path }), cwd: ctx.cwd, days: daysOf(ctx.root), unit: typeof unit === "string" ? unit : PREVIEW_UNIT, out: ctx.out, input });
  if (preview.faults.length > 0) throw new FolderFailed(`${basename(folder)} did not read its input whole: ${preview.faults.length} fault${preview.faults.length === 1 ? "" : "s"}`, preview);
  ctx.out(`Nothing was kept: the scratch home is removed. ${CLI} connectors install ${typed(word)} installs it`);
  return preview;
}


function readInstalled(root: string): Installed {
  try {
    return installedOf(root);
  } catch (error) {
    return fail((error as Error).message);
  }
}

function writeInstalled(root: string, installed: Installed): void {
  const sorted = Object.fromEntries(Object.entries(installed).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(connectorsFolder(root), { recursive: true });
  writeDurably(installedFile(root), `${JSON.stringify(sorted, null, 2)}\n`);
}


type TurnedOff = Record<string, string[]>;

const turnedOffFile = (root: string) => join(connectorsFolder(root), ".removed", "sources-off.json");

function readTurnedOff(root: string): TurnedOff {
  const path = turnedOffFile(root);
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as TurnedOff;
  } catch (error) {
    return fail(`${path} is not JSON (${(error as Error).message}): it names the sources a remove turned off; remove the file, and turn them on with ${CLI} connectors on <source>`);
  }
}

function writeTurnedOff(root: string, turned: TurnedOff): void {
  const sorted = Object.fromEntries(Object.entries(turned).filter(([, ids]) => ids.length > 0).sort(([a], [b]) => a.localeCompare(b)));
  mkdirSync(dirname(turnedOffFile(root)), { recursive: true });
  writeDurably(turnedOffFile(root), `${JSON.stringify(sorted, null, 2)}\n`);
}

function landedOf(folder: HomeFolder, connectors: readonly Connector[], off: readonly string[]): { id: string; owner: string }[] {
  const bare = switchOf([], off);
  const catalog = catalogOf(connectors);
  const reads = new Set(connectors.flatMap((connector) => connector.sources.flatMap((source) => [source.read, ...source.feeders ?? []])));
  const held = new HomeFile(folder, 5_000).view((view) => view.tables.sources.list()) ?? [];
  return held.flatMap((source) => {
    const owner = reads.has(source.connector) ? catalog.of(source)?.id : undefined;
    return owner === undefined || bare.source(source) ? [] : [{ id: source.id, owner }];
  });
}


export function restartHome(): boolean {
  if (!fromRelease() || process.platform !== "darwin") return false;
  return launchd().restart(jobLabel("home"));
}

function restarted(ctx: FolderContext): boolean | string {
  try {
    return (ctx.restart ?? restartHome)();
  } catch (error) {
    return `the home did not restart (${(error as Error).message}): launchctl kickstart -k gui/${process.getuid?.() ?? 0}/${jobLabel("home")} starts it`;
  }
}

async function running(ctx: FolderContext, root: string): Promise<Generation | null> {
  try {
    return await askHome(homeSocket(root, machineOf(ctx).dir), "generation", [], () => undefined, 5_000) as Generation | null;
  } catch (error) {
    if (error instanceof NoHomeError || error instanceof Refusal) return null;
    throw error;
  }
}

async function started(ctx: FolderContext, root: string, before: string | null, holds: (generation: Generation) => boolean): Promise<Generation | null> {
  const deadline = Date.now() + START_MS;
  let step = 0;
  for (;;) {
    const now = await running(ctx, root);
    if (now !== null && now.start !== before && holds(now)) return now;
    if (Date.now() >= deadline) return null;
    const wait = ASK_STEPS_MS[Math.min(step++, ASK_STEPS_MS.length - 1)]!;
    await delay(Math.min(wait, Math.max(0, deadline - Date.now())));
  }
}

async function followed(ctx: FolderContext, root: string, start: string): Promise<"followed" | "away" | "lagging"> {
  const deadline = Date.now() + DOOR_MS;
  let step = 0;
  for (;;) {
    let away = false;
    try {
      const report = await askHome(homeSocket(root, machineOf(ctx).dir), "status", ["--json"], () => undefined, Math.max(1, deadline - Date.now())) as { generation?: unknown };
      if (report.generation === start) return "followed";
    } catch (error) {
      if (!(error instanceof Refusal || error instanceof NoHomeError)) throw error;
      away = error instanceof Refusal && error.words === DOOR_AWAY;
    }
    if (Date.now() >= deadline) return away ? "away" : "lagging";
    const wait = ASK_STEPS_MS[Math.min(step++, ASK_STEPS_MS.length - 1)]!;
    await delay(Math.min(wait, Math.max(0, deadline - Date.now())));
  }
}

const LAGGING = `the door still reads the home before its restart: ${CLI} status says the home's own in a moment`;
const AWAY = `the door isn't answering yet: it reads the home as it runs now once it does, and ${CLI} status says when`;

function clashWords(root: string, installed: Installed, fault: readonly [string, string], whole: boolean): string {
  const [member, reason] = fault;
  const clash = clashOf(root, reason);
  if (clash === null) return `${member}: ${reason}`;
  if (clash.what === "connector" && whole && homeFolders(root).includes(clash.holder)) return heldWords(clash.holder, clash.name, installed[clash.holder]?.from);
  return clash.words;
}

function heldWords(holder: string, id: string, from: string | undefined): string {
  return from === undefined
    ? `connectors/${holder} holds ${id}: edit connectors/${holder} and install that, or remove it first`
    : `connectors/${holder} holds ${id} (installed from ${from}): install from there, edit connectors/${holder} and install that, or remove it first`;
}

function renamedWords(name: string, gone: readonly string[], ids: readonly string[]): string {
  const was = gone.join(", ");
  return `connectors/${name} declares ${was}, set up in this home, and this folder declares ${ids.join(", ")} instead: a connector's id holds its settings, its sign-in and its poll memory, which stay under ${was}. `
    + `Keep the id ${gone[0]}, or run ${CLI} connectors remove ${gone[0]}, then install this folder as a new connector and set it up again`;
}

async function installed(ctx: FolderContext, folder: string): Promise<{ installed: string; connectors: readonly string[]; runs: boolean }> {
  const root = homeOf(ctx);
  const { ids, polls } = await tested(ctx, folder);
  const home = connectorsFolder(root);
  const records = readInstalled(root);
  const turned = readTurnedOff(root);
  const names = homeFolders(root);
  const real = realpathSync(folder);
  const recorded = Object.entries(records).find(([name, install]) => install.from === real && names.includes(name))?.[0];
  const rule = isInstalled(root, folder) ? "itself" : recorded !== undefined ? "recorded" : "new";
  const name = rule === "itself" ? basename(folder) : recorded ?? ids[0]!;
  if (rule === "new" && names.includes(name)) fail(heldWords(name, name, records[name]?.from));
  const before = await running(ctx, root);
  if (rule !== "new") {
    const was = [...new Set([...records[name]?.ids ?? [], ...before?.folders.find((each) => each.name === name)?.ids ?? []])];
    const sealed = plainFolder(root) === null;
    const gone = was.filter((id) => !ids.includes(id) && (sealed || Object.keys(blockOf(root, id)).length > 0));
    if (gone.length > 0) fail(renamedWords(name, gone, ids));
  }
  const prospective = await declared(ctx, root, [...names.filter((each) => each !== name).map((each) => ({ name: each, path: join(home, each) })), { name, path: folder }]);
  const refused = prospective.refused.find((each) => each.name === name);
  if (refused !== undefined) fail(refused.faults.map((fault) => clashWords(root, records, fault, rule === "new")).join("\n"));
  const target = join(home, name);
  if (rule !== "itself") {
    const staged = join(home, `.installing-${name}`);
    const old = join(home, `.replaced-${name}`);
    rmSync(staged, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
    cpSync(folder, staged, { recursive: true, dereference: true });
    loading(root, name, folderStamp(staged));
    if (existsSync(target)) renameSync(target, old);
    renameSync(staged, target);
    rmSync(old, { recursive: true, force: true });
  } else loading(root, name, folderStamp(target));
  const from = rule === "new" ? (isKept(root, real) ? draftOf(root, name) : real) : records[name]?.from;
  writeInstalled(root, { ...records, [name]: { ...(from === undefined ? {} : { from }), ids } });
  const back = ids.flatMap((id) => turned[id] ?? []);
  if (back.length > 0) {
    planned(root, { "sources.off": effective(root).settings.sources.off.filter((id) => !back.includes(id)) }).write();
    writeTurnedOff(root, Object.fromEntries(Object.entries(turned).filter(([id]) => !ids.includes(id))));
  }
  const said = ids.join(", ");
  const restart = restarted(ctx);
  if (restart !== true) {
    loading(root, name, null);
    ctx.out(`installed ${said} at ${target}; ${restart === false ? "start the home again to load it" : `${restart} with the folder`}`);
    return { installed: target, connectors: ids, runs: false };
  }
  ctx.out(`installed ${said} at ${target}; the home is restarting to load it`);
  const digest = folderDigest(target);
  const now = await started(ctx, root, before?.start ?? null, (generation) => generation.folders.some((each) => each.name === name && each.digest === digest) || generation.refused.some((each) => each.name === name));
  if (now === null) fail(`the home has not started again in ${START_MS / 1000} s: ${CLI} status says why`);
  const unloaded = now.refused.find((each) => each.name === name);
  if (unloaded !== undefined) fail(`the home did not load ${name}: ${unloaded.faults.map(([member, reason]) => `${member}: ${reason}`).join("; ")}`);
  const door = await followed(ctx, root, now.start);
  if (door !== "followed") ctx.out(door === "away" ? AWAY : LAGGING);
  const again = polls && rule !== "new" ? `; if you changed how it reads, ${CLI} connectors reread ${ids[0]} reads its source again from the start` : "";
  ctx.out(`installed ${said}; the home runs it${again}`);
  const working = await folderOf(ctx, name, "install").catch(() => null);
  if (working !== null && realpathSync(working) !== real) ctx.out(`${CLI} connectors install ${name} installs ${typed(working)}, your working copy, not ${typed(folder)}`);
  return { installed: target, connectors: ids, runs: true };
}

function isKept(root: string, real: string): boolean {
  const removed = join(connectorsFolder(root), ".removed");
  return existsSync(removed) && dirname(real) === realpathSync(removed);
}

function draftOf(root: string, id: string): string | undefined {
  const draft = join(draftsFolder(root), id);
  return existsSync(draft) ? realpathSync(draft) : undefined;
}

function aside(root: string, name: string): string {
  const removed = join(connectorsFolder(root), ".removed");
  mkdirSync(removed, { recursive: true });
  const to = join(removed, `${name}-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  renameSync(join(connectorsFolder(root), name), to);
  return to;
}

async function removed(ctx: FolderContext, folder: string): Promise<{ removed: string; kept: string; connectors: readonly string[]; runs: boolean }> {
  const root = homeOf(ctx);
  notBuiltKeyed(root, "connectors remove");
  const name = basename(folder);
  const records = readInstalled(root);
  const turned = readTurnedOff(root);
  const read = (await declared(ctx, root, [{ name, path: folder }])).folders[0];
  const ids = read?.ids ?? records[name]?.ids ?? [name];
  const off = effective(root).settings.sources.off;
  const landed = landedOf(folderHere(root), read?.connectors ?? [], off);
  const plan = landed.length === 0 ? null : planned(root, { "sources.off": [...off, ...landed.map((source) => source.id)].sort() });
  loading(root, name, GONE);
  const kept = aside(root, name);
  delete records[name];
  writeInstalled(root, records);
  if (plan !== null) {
    writeTurnedOff(root, { ...turned, ...Object.fromEntries(ids.map((id) => [id, [...new Set([...turned[id] ?? [], ...landed.filter((source) => source.owner === id).map((source) => source.id)])].sort()])) });
    plan.write();
  }
  const stay = `Its records stay in Lifestream and leave your days and search once the rebuild ends. ${CLI} connectors install ${typed(kept)} brings it back with them.`;
  const said = ids.join(", ");
  const before = await running(ctx, root);
  const restart = restarted(ctx);
  if (restart !== true) {
    loading(root, name, null);
    ctx.out(`removed ${said}, kept at ${kept}; ${restart === false ? "start the home again to leave it out" : `${restart} without the folder`}. ${stay}`);
    return { removed: name, kept, connectors: ids, runs: false };
  }
  ctx.out(`removed ${said}, kept at ${kept}; the home is restarting without it`);
  const now = await started(ctx, root, before?.start ?? null, (generation) => ![...generation.folders, ...generation.refused].some((each) => each.name === name));
  if (now === null) fail(`the home has not started again in ${START_MS / 1000} s: ${CLI} status says why`);
  const door = await followed(ctx, root, now.start);
  if (door !== "followed") ctx.out(door === "away" ? AWAY : LAGGING);
  ctx.out(`removed ${said}; the home runs without it. ${stay}`);
  return { removed: name, kept, connectors: ids, runs: true };
}
