
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  admit, backfillFaults, chromeFaults, declarations, formOf, imports, ownExport, providers, recipes, roadsOf, routeId, runningOf, setsOf, signinFaults, withRoadDefaults,
  type Where,
  type Acquirer, type Admitted, type Whose, type Connector, type Entry, type Field, type Provider,
} from "@lifestreamprotocol/connect";
import { duration, selects, sourceName, TYPES, type Json, type JsonObject, type SourceParts, type SourceSelector } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import {
  acquirerSink, connections, proveAcquirer, runProof,
  type AcquirerFakes, type Limits, type ProofEvent, type ProveAsk, type Proved, type ProvedAcquirer,
} from "./conformance-acquirers.js";
import { familiesWith, fixtureDay, landingRegistry, skippedOf, unheld, type Fixture } from "./fixture-day.js";
import { countFaults, fixtureProofs } from "./fixture-proof.js";
import { folderDigest, importFolder, oneDoor, releaseAdmitted, SDK_SPECIFIER, trial } from "./folders.js";
import { errorText } from "./jobs.js";
import { repoRoot, sdkModule } from "./programs.js";
import { connectorSettings, type Settings } from "./settings.js";

const MAC = "macbook-pro-0001";


export const ROAD_WORDS = /(?<![-\w])(?:on|from) (?:this|your) (?:Mac|iPhone)\b|(?<![-\w])(?:through|in) Chrome\b/iu;
export const SENTENCE = (text: string) => /^[A-Z0-9"“]/u.test(text) && /[.?]$/u.test(text) && !/\b(?:we|our|us)\b/iu.test(text) && !text.includes("!");
export const LABEL = (text: string) => /^[A-Z0-9]/u.test(text) && !/[.]$/u.test(text);
export const RECORDS_MAX = 64;
export const SENSOR_RECORDS_MAX = 2 * RECORDS_MAX;
export const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const filled = (pattern: string) => pattern.replace("<product>", "chrome").replace("<account>", "person-a@example.com").replace("<unit>", MAC).replace("<home>", MAC);

export interface World {
  root: string;
  sourceName: (id: string) => Pick<SourceParts, "product" | "copy">;
  readers: ReadonlySet<string>;
  acquirers: ReadonlySet<string>;
  icons: NonNullable<Where["icons"]>;
  pages: ReadonlyMap<string, string | null>;
  pageless?: (id: string) => string;
  listed: ReadonlySet<string>;
  paged: ReadonlySet<string>;
  signins: ReadonlySet<string>;
  recipes: Readonly<Record<string, { readonly origins: readonly string[] }>>;
  landed?: ReadonlyMap<string, ReadonlySet<string>>;
  families: readonly Pick<Family, "name" | "works">[];
}


export function importConformance(kinds: readonly imports.ImportKind[], world: Pick<World, "icons">): string[] {
  const failures: string[] = [];
  const fail = (kind: string, member: string, what: string) => failures.push(`${kind}.${member}: ${what}`);
  const seen = new Set<string>();
  for (const declared of kinds) {
    const kind = declared.id;
    if (seen.has(kind)) fail(kind, "kind", "two declarations share it");
    seen.add(kind);
    if (!world.icons.has(declared.icon)) fail(kind, "icon", `${declared.icon} is not in design/icons.json`);
    if (declared.name.endsWith(".")) fail(kind, "name", `"${declared.name}" is no label: no full stop`);
    if (!LABEL(declared.takes)) fail(kind, "takes", `"${declared.takes}" is no label: capital first, no full stop`);
    if (!SENTENCE(declared.ask)) fail(kind, "ask", `"${declared.ask}" is no sentence: sentence case, its full stop, no "we"`);
    if (declared.guide.length === 0) fail(kind, "guide", "no step");
    for (const [at, step] of declared.guide.entries()) {
      if (!SENTENCE(step.words)) fail(kind, `guide.${at + 1}`, `"${step.words}" is no sentence: sentence case, its full stop, no "we"`);
      if (step.open !== undefined && !LABEL(step.open.label)) fail(kind, `guide.${at + 1}.open.label`, `"${step.open.label}" is no label: capital first, no full stop`);
      if (step.open !== undefined && !step.open.url.startsWith("https://")) fail(kind, `guide.${at + 1}.open.url`, `${step.open.url} is not https`);
    }
    if (declared.guide.filter((step) => step.open !== undefined).length > 1) fail(kind, "guide", "more than one step has a button");
    const products = new Set<string>();
    for (const product of declared.products) {
      if (products.has(product.id)) fail(kind, `products.${product.id}`, "two products share the id");
      products.add(product.id);
      if (!/^[a-z0-9-]+$/u.test(product.id)) fail(kind, `products.${product.id}`, "an id is lowercase, words joined by hyphens");
      if (product.noun !== undefined && product.noun.some((word) => word !== word.toLowerCase())) fail(kind, `products.${product.id}.noun`, "a noun is lower case");
    }
  }
  return failures;
}

export function conformance(connectors: readonly Connector[], world: World): string[] {
  const failures: string[] = [];
  const fail = (id: string, member: string, what: string) => failures.push(`${id}.${member}: ${what}`);
  const seen = { ids: new Set<string>(), patterns: new Map<string, string>(), feeders: new Map<string, string>() };
  const declaredBy = new Map<string, string[]>();
  for (const connector of connectors) {
    const { id } = connector;
    if (seen.ids.has(id)) fail(id, "id", "two declarations share it");
    seen.ids.add(id);
    const declared: string | undefined = connector.type;
    if (declared !== undefined && !Object.hasOwn(TYPES, declared)) fail(id, "type", `${declared} is not in core's TYPES`);
    if (connector.icon !== undefined && !world.icons.has(connector.icon)) fail(id, "icon", `${connector.icon} is not in design/icons.json`);
    const patterns = new Set<string>();
    for (const [index, source] of connector.sources.entries()) {
      const at = `sources[${index}]`;
      if (!world.readers.has(source.read)) fail(id, `${at}.read`, `no provider's module exports the reader ${source.read}`);
      declaredBy.set(source.read, [...new Set([...declaredBy.get(source.read) ?? [], id])]);
      try {
        world.sourceName(filled(source.id));
      } catch (error) {
        fail(id, `${at}.id`, `${source.id} does not parse as a source name: ${(error as Error).message}`);
      }
      const product = source.id.split(":")[0]!;
      if (product !== "<product>" && product !== connector.product && connector.products?.[product] === undefined) {
        fail(id, `${at}.id`, `${product} is neither its product nor one its products declare`);
      }
      patterns.add(source.id);
      for (const feeder of source.feeders ?? []) {
        const reader = seen.feeders.get(feeder);
        if (reader !== undefined && reader !== source.read) fail(id, `${at}.feeders`, `${feeder} maps to ${reader} and to ${source.read}`);
        seen.feeders.set(feeder, source.read);
      }
    }
    for (const pattern of patterns) {
      const other = seen.patterns.get(pattern);
      if (other !== undefined) fail(id, "sources", `${pattern} is ${other}'s too`);
      seen.patterns.set(pattern, id);
    }
    for (const acquirer of connector.acquirers ?? []) if (!world.acquirers.has(acquirer)) fail(id, "acquirers", `no provider's module exports the acquirer ${acquirer}`);
    const inside = (member: string, bounded: { default: string; min?: string; max?: string }) => {
      const ms = (word: string | undefined) => {
        try {
          return word === undefined ? undefined : duration(word);
        } catch {
          return null;
        }
      };
      const [value, min, max] = [bounded.default, bounded.min, bounded.max].map(ms);
      if (value === null || min === null || max === null) return fail(id, member, "a duration that does not read (30s, 10m, 1h, 2d)");
      if ((min !== undefined && value! < min) || (max !== undefined && value! > max)) fail(id, member, `its default ${bounded.default} is outside its bounds`);
    };
    if (connector.refresh !== undefined) inside("refresh", connector.refresh);
    if (connector.backfill?.pace !== undefined) inside("backfill.pace", connector.backfill.pace);
    if (connector.mac?.sensor === true && connector.backfill !== undefined) fail(id, "backfill", "a sensor records from now on and has no backfill");
    const landed = world.landed?.get(id);
    const paged = (connector.acquirers ?? []).some((acquirer) => world.paged.has(acquirer));
    for (const [member, what] of backfillFaults(connector, paged, landed ?? new Set())) if (member !== "counts") fail(id, member, what);
    if (landed !== undefined) for (const [member, what] of countFaults(connector, landed)) fail(id, member, what);
    for (const [member, what] of signinFaults(connector, world.signins)) fail(id, member, what);
    for (const [member, what] of chromeFaults(connector)) fail(id, member, what);
    const signin = connector.chrome?.signin;
    if (signin?.recipe !== undefined) {
      const recipe = world.recipes[signin.recipe];
      if (recipe === undefined) fail(id, "chrome.signin.recipe", `${signin.recipe} names no recipe`);
      else if (!recipe.origins.includes(signin.origin)) fail(id, "chrome.signin.recipe", `${signin.recipe} reaches none of ${signin.origin}`);
    }
    const account = Object.entries(connector.fields ?? {}).find(([, field]) => "account" in field && field.account === true)?.[0];
    const form = formOf(connector);
    for (const field of form) {
      const kind = connector.fields?.[field]?.kind;
      if (kind === "zone" || (connector.signin ?? []).some((route) => setsOf(route, connector).includes(field))) fail(id, "form", `${field} is a ${kind === "zone" ? "zone, the home's day zone until set" : "sign-in's field"}: no form holds it`);
    }
    for (const [index, route] of (connector.signin ?? []).entries()) {
      const at = `signin[${index}]`;
      const sets = setsOf(route, connector);
      for (const field of sets) if (connector.fields?.[field] === undefined) fail(id, `${at}.sets`, `${field} is none of ${id}'s fields`);
      if (account !== undefined && !sets.includes(account)) fail(id, `${at}.sets`, `${account}, the account, is not written by its sign-in`);
      for (const field of route.way === "key" ? route.fields : [route.field]) if (!sets.includes(field)) fail(id, `${at}.sets`, `${field} is taken by its sign-in but not written`);
      if (!LABEL(route.label)) fail(id, `${at}.label`, `"${route.label}" is no label: sentence case, no full stop`);
      for (const [member, text] of [...(route.about === undefined ? [] : [["about", route.about]]), ...(route.refused === undefined ? [] : [["refused", route.refused]]),
        ...(route.note === undefined ? [] : [["note", route.note]]), ...(route.steps ?? []).map((step, index) => [`steps[${index}].words`, step.words])]) {
        if (!SENTENCE(text!)) fail(id, `${at}.${member}`, `"${text}" is no sentence: sentence case, its full stop, no "we"`);
      }
      for (const [index, step] of (route.steps ?? []).entries()) {
        if (step.title !== undefined && !LABEL(step.title)) fail(id, `${at}.steps[${index}].title`, `"${step.title}" is no label: sentence case, no full stop`);
        if (step.open !== undefined && !LABEL(step.open.label)) fail(id, `${at}.steps[${index}].open.label`, `"${step.open.label}" is no label: capital first, no full stop`);
        if (step.open !== undefined && !step.open.url.startsWith("https://")) fail(id, `${at}.steps[${index}].open.url`, `${step.open.url} is not https`);
      }
    }
    const name = connector.name;
    const type = declared === undefined ? undefined : TYPES[declared as keyof typeof TYPES]?.name;
    const said: [string, string][] = [["records", connector.records], ...(connector.gives === undefined ? [] : [["gives", connector.gives] as [string, string]]),
      ...(connector.before ?? []).map((line, index) => [`before[${index}]`, line] as [string, string])];
    for (const [member, text] of said) {
      if (!SENTENCE(text)) fail(id, member, `"${text}" is no sentence: sentence case, its full stop, no "we"`);
      if (!member.startsWith("before") && ROAD_WORDS.test(text)) fail(id, member, `"${text}" names a road, which the page says`);
    }
    if (connector.records.split(/[.?] (?=[A-Z])/u).length > 2) fail(id, "records", "more than two sentences");
    const most = connector.mac?.sensor === true ? SENSOR_RECORDS_MAX : RECORDS_MAX;
    if (connector.records.length > most) fail(id, "records", `${connector.records.length} characters, ${connector.records.length - most} over the ${most} of ${most === RECORDS_MAX ? "one line" : "two lines"} under its name in the stream's dialog`);
    if (connector.gives !== undefined && new RegExp(`(?<![\\w-])${literal(name)}(?![\\w-])`, "u").test(connector.gives)) fail(id, "gives", `says ${name}, which its name says`);
    if (connector.gives !== undefined && connector.gives === connector.records) fail(id, "gives", "says its records again: no gives");
    if (connector.gives !== undefined && type !== undefined && new RegExp(`\\b${type}\\b`, "iu").test(connector.gives)) fail(id, "gives", `names its type, ${type}`);
    if ((connector.before?.length ?? 0) > 2) fail(id, "before", "more than two sentences");
    if (connector.noun?.some((word) => word !== word.toLowerCase()) === true) fail(id, "noun", `"${connector.noun.join(", ")}" is not in lower case`);
    if (connector.refresh?.label !== undefined && !LABEL(connector.refresh.label)) fail(id, "refresh.label", `"${connector.refresh.label}" is no label: sentence case, no full stop`);
    for (const [field, each] of Object.entries(connector.fields ?? {})) {
      if (!LABEL(each.label)) fail(id, `fields.${field}.label`, `"${each.label}" is no label: sentence case, no full stop`);
      if (each.about !== undefined && !SENTENCE(each.about)) fail(id, `fields.${field}.about`, `"${each.about}" is no sentence: sentence case, its full stop, no "we"`);
      const options = each.kind === "choice" ? Object.entries(each.options).flatMap(([key, option]) => (typeof option === "string" ? [[key, option]] : [[key, option[0]], [key, option[1]]])) : [];
      for (const [key, words] of options) if (!LABEL(words!)) fail(id, `fields.${field}.options.${key}`, `"${words}" is no label: sentence case, no full stop`);
    }
    if (connector.export !== undefined) {
      if (!connector.sources.some((source) => roadsOf(source).includes("upload"))) fail(id, "export", "only a connector a person hands an export of (a road upload) has an export");
      if (ownExport(connector) === null && imports.importOf(connector) === null) fail(id, "export.recognise", "its members lie under no one import kind's root");
    }
    for (const [work, each] of Object.entries(connector.processing ?? {})) {
      if (!LABEL(each.label)) fail(id, `processing.${work}.label`, `"${each.label}" is no label: sentence case, no full stop`);
      if (!SENTENCE(each.about)) fail(id, `processing.${work}.about`, `"${each.about}" is no sentence: sentence case, its full stop, no "we"`);
      if (each.noun.length !== 2 || each.noun.some((word) => word === "" || word !== word.toLowerCase())) fail(id, `processing.${work}.noun`, `"${each.noun.join(", ")}" is not one and many in lower case`);
      if (each.text_chars !== undefined && !(Number.isSafeInteger(each.text_chars) && each.text_chars > 0)) fail(id, `processing.${work}.text_chars`, `${each.text_chars} is no count of characters`);
    }
    const named = connector.sources.flatMap((source) => {
      try {
        return [{ parts: world.sourceName(filled(source.id)), anyCopy: source.id.split(":")[2]!.includes("<") }];
      } catch {
        return [];
      }
    });
    const reaches = (selector: SourceSelector, { parts, anyCopy }: (typeof named)[number]) => {
      const held: SourceSelector = { ...selector };
      if (anyCopy) delete held.copy;
      return selects(held, parts);
    };
    const asked = new Map<string, string[]>();
    for (const family of world.families) {
      for (const [work, sources] of Object.entries(family.works ?? {})) {
        if (named.some((source) => reaches(sources, source))) asked.set(work, [...asked.get(work) ?? [], family.name]);
      }
    }
    for (const [work, families] of asked) if (connector.processing?.[work] === undefined) fail(id, `processing.${work}`, `the ${families.join(" and ")} family asks it of its sources: declare it`);
    for (const work of Object.keys(connector.processing ?? {})) if (!asked.has(work)) fail(id, `processing.${work}`, "no family asks it of its sources");
    const collects = connector.backfill?.about;
    if (connector.backfill !== undefined && (collects === undefined || !SENTENCE(collects))) {
      fail(id, "backfill.about", collects === undefined ? "none: say what its backfill collects" : `"${collects}" is no sentence: sentence case, its full stop, no "we"`);
    }
    const page = world.pages.get(id);
    if (page === null || page === undefined) fail(id, "page", world.pageless?.(id) ?? "no connector.ts declares it");
    else if (!existsSync(join(world.root, page))) fail(id, "page", `${page} is not there`);
    else if (!world.listed.has(page)) fail(id, "page", `packages/connect/SKILL.md does not list ${page}`);
  }
  for (const reader of world.readers) {
    const by = declaredBy.get(reader) ?? [];
    if (by.length !== 1) fail(`<${reader}>`, "read", `declared by ${by.length === 0 ? "no connector" : by.join(" and ")}`);
  }
  return failures;
}


export function blocksOf(connector: Connector, work: string): JsonObject[] {
  const synthetic = (field: Field): Json => field.kind === "email" ? "person-a@example.com" : field.kind === "path" ? join(work, "synthetic") : field.kind === "zone" ? "UTC"
    : field.kind === "list" ? [] : field.kind === "duration" ? "1h" : "person-a";
  const filled: JsonObject = Object.fromEntries(formOf(connector).map((name) => [name, synthetic(connector.fields![name]!)]));
  return connector.signin === undefined ? [filled] : connector.signin.map((route) => ({ ...filled, route: routeId(route) }));
}

export function pagedAcquirers(connectors: readonly Connector[], work: string, provided: readonly Provider[] = providers()): Set<string> {
  const paged = new Set<string>();
  const factories: Readonly<Record<string, (settings: never) => Acquirer>> = Object.assign({}, ...provided.map((provider) => provider.acquirers ?? {}));
  const build = (name: string, settings: JsonObject) => {
    try {
      if (factories[name]?.({ ...settings, work, zone: "UTC", unit: MAC } as never).page !== undefined) paged.add(name);
    } catch {
    }
  };
  for (const connector of connectors) {
    for (const block of blocksOf(connector, work)) for (const name of runningOf(connector, block)) build(name, connectorSettings(connector, block).built);
  }
  const named = new Set(connectors.flatMap((connector) => connector.acquirers ?? []));
  for (const name of Object.keys(factories)) if (!named.has(name)) build(name, {});
  return paged;
}



export const SDK_TYPES = "connect/sdk.d.ts";

export function typesOf(release: string, emitted: boolean): { readonly paths: Readonly<Record<string, readonly string[]>>; readonly typeRoots: string } {
  const sdk = emitted ? join(release, "dist", "types", SDK_TYPES) : join(release, "packages", "connect", "sdk.ts");
  return { paths: { [SDK_SPECIFIER]: [sdk] }, typeRoots: join(release, "node_modules", "@types") };
}

export function folderTsconfig(types: ReturnType<typeof typesOf>): JsonObject {
  return {
    compilerOptions: {
      target: "es2023", lib: ["es2023"], module: "esnext", moduleResolution: "bundler",
      strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
      allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true,
      types: ["node"], typeRoots: [types.typeRoots], paths: types.paths as JsonObject,
    },
    exclude: ["**/node_modules", "**/.*"],
  };
}

const ERASABLE_ONLY = 1294;
const ERASABLE_RULE = "(a home runs a folder's TypeScript with its types erased, compiling nothing: a constructor parameter property is a field declared in the class and set in the constructor, an enum a const object, a namespace a module)";

const TYPECHECK_CACHE_MAX = 64;
const cachedSourceFiles = new Map<string, { mtimeMs: number; size: number; file: import("typescript").SourceFile }>();
const cachedTypeChecks = new Map<string, { faults: string[]; external: string[]; own: string[] }>();
const cachedPrograms = new Map<string, import("typescript").Program>();

export async function typeCheck(folder: string, types: ReturnType<typeof typesOf>): Promise<{ faults: string[]; files: string[] }> {
  const ts = (await import("typescript")).default;
  const config = ts.parseJsonConfigFileContent(folderTsconfig(types), ts.sys, folder);
  const own = (file: string) => {
    const path = relative(folder, file);
    return path !== "" && !path.startsWith("..") && !isAbsolute(path);
  };
  let cacheKey: string | undefined;
  if (config.errors.length === 0) {
    const hash = createHash("sha256");
    let allOwn = true;
    for (const file of [...config.fileNames].sort()) {
      const rel = relative(folder, file);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        allOwn = false;
        break;
      }
      hash.update(`${rel}\u0000`).update(readFileSync(file)).update("\u0000");
    }
    if (allOwn) {
      const sdkFiles = Object.values(types.paths).flat().map((file) => {
        const stat = statSync(file, { throwIfNoEntry: false });
        return stat === undefined ? null : [file, stat.mtimeMs, stat.size];
      });
      hash.update(JSON.stringify([types, sdkFiles]));
      cacheKey = hash.digest("hex");
      const hit = cachedTypeChecks.get(cacheKey);
      if (hit !== undefined) return { faults: [...hit.faults], files: [...hit.external, ...hit.own.map((rel) => join(folder, rel))] };
    }
  }
  const host = ts.createCompilerHost(config.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (shouldCreateNewSourceFile || own(fileName)) return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    const stat = statSync(fileName, { throwIfNoEntry: false });
    if (stat === undefined) return originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    const key = `${typeof languageVersionOrOptions === "number" ? languageVersionOrOptions : languageVersionOrOptions.languageVersion}:${fileName}`;
    const cached = cachedSourceFiles.get(key);
    if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.file;
    const file = originalGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile);
    if (file !== undefined) cachedSourceFiles.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, file });
    return file;
  };
  const programKey = JSON.stringify(types);
  const program = ts.createProgram(config.fileNames, config.options, host, cachedPrograms.get(programKey));
  cachedPrograms.set(programKey, program);
  const said = (diagnostic: import("typescript").Diagnostic) => {
    const message = `${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}${diagnostic.code === ERASABLE_ONLY ? ` ${ERASABLE_RULE}` : ""}`;
    if (diagnostic.file === undefined || diagnostic.start === undefined) return `tsconfig: ${message}`;
    const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${relative(folder, diagnostic.file.fileName)}:${line + 1}:${character + 1} ${message}`;
  };
  const files = program.getSourceFiles().filter((file) => own(file.fileName));
  const doors = files.flatMap((file) => ts.preProcessFile(file.text, true, true).importedFiles.flatMap(({ fileName, pos }) => {
    const refused = oneDoor(fileName);
    if (refused === null) return [];
    const { line, character } = file.getLineAndCharacterOfPosition(pos);
    return [`${relative(folder, file.fileName)}:${line + 1}:${character + 1} imports ${refused}`];
  }));
  const faults = [
    ...doors,
    ...[
      ...config.errors, ...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(),
      ...files.flatMap((file) => [...program.getSyntacticDiagnostics(file), ...program.getSemanticDiagnostics(file)]),
    ].filter((diagnostic) => diagnostic.file === undefined || own(diagnostic.file.fileName)).map(said),
  ];
  const allFiles = program.getSourceFiles().map((file) => file.fileName);
  if (cacheKey !== undefined && doors.length === 0 && files.length === config.fileNames.length) {
    if (cachedTypeChecks.size >= TYPECHECK_CACHE_MAX) cachedTypeChecks.delete(cachedTypeChecks.keys().next().value!);
    cachedTypeChecks.set(cacheKey, {
      faults: [...faults],
      external: allFiles.filter((file) => !own(file)),
      own: files.map((file) => relative(folder, file.fileName)),
    });
  }
  return { faults, files: allFiles };
}



export interface FolderCheck {
  readonly dir: string;
  readonly folder: string;
  readonly whose: Whose;
  readonly module: unknown;
  readonly fixture: ({ readonly fixtures?: Readonly<Record<string, unknown>>; readonly settings?: JsonObject; readonly skipped?: unknown } & AcquirerFakes) | null;
  readonly admitted: Admitted;
  readonly world: Pick<World, "icons" | "sourceName" | "recipes" | "families">;
  readonly listed?: { readonly root: string; readonly pages: ReadonlySet<string> };
  readonly work: string;
  readonly pageOf?: (connector: Connector) => string | null;
}

export function checkFolder(check: FolderCheck): string[] {
  const admitted = admit(check.module, { folder: check.folder, whose: check.whose, admitted: check.admitted, icons: check.world.icons });
  if ("faults" in admitted) return admitted.faults.map(([member, reason]) => `${member}: ${reason}`);
  const entry = admitted.entry;
  const connectors = entry.connectors.map(withRoadDefaults);
  const root = check.listed?.root ?? check.dir;
  const page = (connector: Connector) => {
    const own = [`${connector.id}.md`, `${basename(check.folder)}.md`].find((name) => existsSync(join(check.dir, name)));
    return own === undefined ? null : relative(root, join(check.dir, own));
  };
  const pages = new Map(connectors.map((connector) => [connector.id, (check.pageOf ?? page)(connector)]));
  const world: World = {
    ...check.world, root, readers: new Set(entry.readers.map((reader) => reader.name)), acquirers: new Set(Object.keys(entry.acquirers ?? {})),
    pages, listed: check.listed?.pages ?? new Set([...pages.values()].filter((each) => each !== null)),
    ...(check.pageOf === undefined ? { pageless: (id: string) => `no ${id}.md or ${basename(check.folder)}.md in the folder: its page says what it reads, its kinds and keys` } : {}),
    paged: pagedAcquirers(connectors, check.work, [entry as Provider]), signins: new Set(Object.keys(entry.signins ?? {})),
  };
  const failures = conformance(connectors, world);
  const fixtures = check.fixture?.fixtures ?? {};
  for (const reader of entry.readers) if (!Object.hasOwn(fixtures, reader.name)) failures.push(`fixtures.${reader.name}: no fixture in test/fixture.ts`);
  for (const [name, factory] of Object.entries(entry.acquirers ?? {})) {
    const connector = connectors.find((each) => (each.acquirers ?? []).includes(name));
    try {
      factory({ ...builtOf(connector, name, check), work: check.work, zone: "UTC", unit: MAC } as never);
    } catch (error) {
      failures.push(`acquirers.${name}: not built from its blocks and the fixture's settings: ${(error as Error).message.split("\n")[0]}`);
    }
  }
  return [...failures, ...(check.whose === "home" ? uploadFaults(connectors) : [])];
}

export function uploadFaults(connectors: readonly Connector[]): string[] {
  return connectors.flatMap((connector) => {
    if (connector.hidden === true || connector.sources.length === 0) return [];
    if (!connector.sources.every((source) => roadsOf(source).every((road) => road === "upload"))) return [];
    const kind = ownExport(connector) !== null || imports.importOf(connector) !== null;
    return kind ? [] : [`${connector.id}.export: a file handed over would reach no source: declare \`export: { recognise, guide }\` (templates/export)`];
  });
}

export function builtOf(connector: Connector | undefined, name: string, check: Pick<FolderCheck, "work" | "fixture">): JsonObject {
  const block = connector === undefined ? {} : blocksOf(connector, check.work).find((each) => runningOf(connector, each).includes(name)) ?? {};
  return { ...(connector === undefined ? {} : connectorSettings(connector, block).built), ...check.fixture?.settings };
}

const RUN_CACHE_MAX = 64;
const cachedRuns = new Map<string, Proved>();

export async function runFolder(options: { readonly folder: string; readonly settings: Settings; readonly limits?: Limits }): Promise<Proved> {
  const key = options.limits !== undefined ? undefined : (() => {
    try {
      return JSON.stringify([basename(options.folder), folderDigest(options.folder), options.settings]);
    } catch {
      return undefined;
    }
  })();
  if (key !== undefined) {
    const hit = cachedRuns.get(key);
    if (hit !== undefined) return structuredClone(hit);
  }
  const scratch = mkdtempSync(join(tmpdir(), "lifestream-connector-test-"));
  try {
    const dir = join(scratch, "connectors", basename(options.folder));
    cpSync(options.folder, dir, { recursive: true, dereference: true });
    const work = join(scratch, "work");
    mkdirSync(work);
    const proved = await runProof({ prove: { dir, work, settings: options.settings } }, options.limits);
    if (key !== undefined && proved.faults.length === 0) {
      if (cachedRuns.size >= RUN_CACHE_MAX) cachedRuns.delete(cachedRuns.keys().next().value!);
      cachedRuns.set(key, structuredClone(proved));
    }
    return proved;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const ENTRIES = ["index.ts", "index.mjs"] as const;

export async function proveInChild(ask: ProveAsk, emit: (event: ProofEvent) => void): Promise<void> {
  const { dir, work, settings, acquirers: named } = ask.prove;
  const fault = (text: string) => emit({ proof: "fault", text });
  const finish = (declared: { ids: string[]; polls: boolean } = { ids: [], polls: false }) => emit({ proof: "done", ...declared });
  emit({ proof: "case", name: "the folder" });
  const name = basename(dir);
  const entry = ENTRIES.map((file) => join(dir, file)).find((path) => existsSync(path));
  if (entry === undefined) return (fault("folder: holds no index.ts or index.mjs"), finish());
  const sdk = sdkModule();
  const tried = named === undefined ? (await trial({ name, entry, store: dir, sdk, lifestream: [] })).faults : [];
  if (tried.length > 0) return (tried.forEach(([member, reason]) => fault(`${member}: ${reason}`)), finish());
  let module: Entry;
  let fixture: FolderCheck["fixture"];
  const fixturePath = join(dir, "test", "fixture.ts");
  try {
    module = (await importFolder(entry, dir, sdk)) as Entry;
  } catch (error) {
    return (fault(`import: ${errorText(error).split("\n")[0]}`), finish());
  }
  try {
    fixture = existsSync(fixturePath) ? (await importFolder(fixturePath, dir, sdk)) as FolderCheck["fixture"] : null;
  } catch (error) {
    return (fault(`test/fixture.ts: does not import: ${errorText(error).split("\n")[0]}`), finish());
  }
  if (connections().length > 0) {
    return (fault(`the folder: it connects to ${connections()[0]} as it loads, refused: a folder reaches the world only through the \`fetch\` its acquirer is built with`), finish());
  }
  const digest = folderDigest(dir);
  const folder = { ...module, connectors: module.connectors.map(withRoadDefaults), digest };
  const { skipped, faults: unskipped } = skippedOf(fixture?.skipped);
  unskipped.forEach(fault);
  const declared = { ids: module.connectors.map((connector) => connector.id), polls: module.connectors.some((connector) => (connector.acquirers?.length ?? 0) > 0) };
  const names = named?.map((each) => each.name) ?? [
    ...Object.keys(module.acquirers ?? {}).filter((acquirer) => folder.connectors.some((connector) => (connector.acquirers ?? []).includes(acquirer))),
    ...folder.connectors.filter((connector) => ownExport(connector) !== null && !Object.hasOwn(module.acquirers ?? {}, connector.id)).map((connector) => connector.id),
  ];
  emit({ proof: "acquirers", names });
  if (named === undefined) {
    const own = { connectors: module.connectors, ...(module.adapters === undefined ? {} : { adapters: module.adapters }), digest };
    const admitted = Object.fromEntries(Object.entries(releaseAdmitted().admitted).map(([kind, held]) => [kind, new Map(held as Map<string, string>)])) as unknown as Admitted;
    const check: FolderCheck = {
      dir, folder: name, whose: "home", module, fixture, admitted, work,
      world: { icons: releaseIcons(), sourceName, recipes: recipes(), families: familiesWith(settings, work, own) },
    };
    const faults = checkFolder(check);
    if (faults.length > 0) return (faults.forEach(fault), finish(declared));
    emit({ proof: "case", name: "the fixtures" });
    const fixtures = (fixture?.fixtures ?? {}) as Readonly<Record<string, Fixture>>;
    const day = await fixtureDay({ work, settings, fixtures, folder, skipped });
    day.faults.forEach(fault);
    for (const line of day.lines) emit({ proof: "line", text: line });
    emit({ proof: "case", name: "each fixture alone" });
    (await fixtureProofs({ work, registry: landingRegistry(work, folder, settings), settings, connectors: folder.connectors, fixtures })).faults.forEach(fault);
    if (connections().length > 0) fault(`the fixtures: they connect to ${connections()[0]}, refused: a fixture, a reader or an adapter reads what it is handed and connects to nothing`);
  }
  const acquirers = named ?? names.map((acquirer): ProvedAcquirer => ({ name: acquirer, settings: builtOf(folder.connectors.find((each) => (each.acquirers ?? []).includes(acquirer)), acquirer, { work, fixture }) }));
  for (const acquirer of acquirers) {
    const context = { folder, fakes: fixture, registry: landingRegistry(work, folder, settings), work, settings, skipped };
    await proveAcquirer(context, acquirer, acquirerSink(acquirer.name, emit));
  }
  if (named === undefined) unheld(skipped).forEach(fault);
  finish(declared);
}

function releaseIcons(): ReadonlyMap<string, string | undefined> | ReadonlySet<string> {
  const path = join(repoRoot(), "design", "icons.json");
  if (existsSync(path)) {
    const { icons } = JSON.parse(readFileSync(path, "utf8")) as { icons: Record<string, { phosphor?: string }> };
    return new Map(Object.entries(icons).map(([key, icon]) => [key, icon.phosphor]));
  }
  return new Set([...declarations().map((connector: Connector) => connector.icon), ...imports.IMPORTS.map((kind) => kind.icon)].filter((icon): icon is string => icon !== undefined));
}
