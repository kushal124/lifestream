import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import * as sdk from "./sdk.js";
import { temp } from "./test/drive.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const PINNED = JSON.parse(readFileSync(join(HERE, "test", "sdk-surface.json"), "utf8")) as { exports: string[]; connector: string[]; acquirer: string[] };
const parsedFiles = new Map<string, ts.SourceFile>();

function cachedHost(options: ts.CompilerOptions, mutablePrefix?: string): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    const cacheable = mutablePrefix === undefined || !fileName.startsWith(mutablePrefix);
    const key = `${fileName}\0${typeof languageVersion === "number" ? languageVersion : languageVersion.languageVersion}`;
    if (cacheable) {
      const hit = parsedFiles.get(key);
      if (hit !== undefined) return hit;
    }
    const source = realGetSourceFile(fileName, languageVersion, onError, shouldCreate);
    if (cacheable && source !== undefined) parsedFiles.set(key, source);
    return source;
  };
  return host;
}

const SDK_FILE = join(HERE, "sdk.ts");
const INPUTS_FILE = join(ROOT, "packages", "core", "inputs", "index.ts");
let sharedProgram: ts.Program | undefined;

function projectProgram(): ts.Program {
  if (sharedProgram !== undefined) return sharedProgram;
  const config = ts.parseJsonConfigFileContent(ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config, ts.sys, ROOT);
  const options = { ...config.options, noEmit: true };
  sharedProgram = ts.createProgram([SDK_FILE, INPUTS_FILE], options, cachedHost(options));
  return sharedProgram;
}

function surface(): { exports: string[]; connector: string[]; acquirer: string[] } {
  const program = projectProgram();
  const checker = program.getTypeChecker();
  const module = checker.getSymbolAtLocation(program.getSourceFile(SDK_FILE)!)!;
  const exports = checker.getExportsOfModule(module);
  const members = (name: string) => {
    const type = checker.getDeclaredTypeOfSymbol(checker.getAliasedSymbol(exports.find((each) => each.name === name)!));
    return checker.getPropertiesOfType(type).map((member) => `${member.name}${(member.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : ""}`).sort();
  };
  return { exports: exports.map((each) => each.name).sort(), connector: members("Connector"), acquirer: members("Acquirer") };
}

let faultsFolder: string | undefined;
let faultsWritten = new Set<string>();
let previousFaultsProgram: ts.Program | undefined;
let checkedWhole = false;

function faults(files: Readonly<Record<string, string>>): string[] {
  const folder = faultsFolder ??= temp("sdk-template-");
  const next = new Set(Object.keys(files));
  for (const old of faultsWritten) if (!next.has(old)) rmSync(join(folder, old), { force: true });
  faultsWritten = next;
  for (const [path, text] of Object.entries({ "package.json": '{ "type": "module" }\n', ...files })) {
    mkdirSync(dirname(join(folder, path)), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, skipLibCheck: true,
    target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, lib: ["lib.es2023.d.ts"],
    types: ["node"], typeRoots: [join(ROOT, "node_modules", "@types")],
    paths: { "@lifestreamprotocol/connect/sdk": [SDK_FILE] },
  };
  const roots = Object.keys(files).filter((path) => path.endsWith(".ts")).map((path) => join(folder, path));
  const program = ts.createProgram(roots, options, cachedHost(options, folder), previousFaultsProgram);
  previousFaultsProgram = program;
  const diagnostics = checkedWhole
    ? roots.flatMap((file) => ts.getPreEmitDiagnostics(program, program.getSourceFile(file)!))
    : ts.getPreEmitDiagnostics(program);
  checkedWhole = true;
  return diagnostics.map((diagnostic) => {
    const where = diagnostic.file === undefined ? "" : relative(diagnostic.file.fileName.startsWith(folder) ? folder : ROOT, diagnostic.file.fileName);
    const line = diagnostic.file === undefined || diagnostic.start === undefined ? 0 : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1;
    return `${where}:${line} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
  });
}

const ACQUIRER = `import { NeedsYou, isObject, request, tabRead, type Acquirer, type AcquirerSettings, type Dependencies, type OpenPage, type Who } from "@lifestreamprotocol/connect/sdk";

export interface ExampleFields {
  account: string;
  key: string;
  per_poll?: number;
}

export function exampleAcquirer(settings: AcquirerSettings<ExampleFields>, dependencies: Dependencies = {}): Acquirer {
  const fetch = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? (async () => {});
  const where: { work: string; zone: string; unit: string; per_poll: number } = { work: settings.work, zone: settings.zone, unit: settings.unit, per_poll: settings.per_poll ?? 50 };
  return {
    name: "example-api",
    source: \`example:\${settings.account}:cloud\`,
    async fetch(state, secrets) {
      await sleep(where.per_poll);
      const answer = await request("https://api.example.com/v1/notes", { headers: { authorization: \`Bearer \${secrets.get(settings.key) ?? ""}\` } }, { fetch, now });
      if (!(answer instanceof Response)) return { files: [], facts: {}, state: state ?? {}, backoff_ms: 60_000 };
      if (answer.status === 401) throw new NeedsYou("signed-out", "Example signed you out");
      return { files: [{ path: "notes.json", bytes: Buffer.from(await answer.text()) }], facts: {}, state: { since_ms: now() } };
    },
    async who(page: OpenPage): Promise<Who> {
      const answer = await tabRead(page.tab)({ url: "/api/me" });
      if (answer.status !== 200 || !isObject(answer.json) || typeof answer.json.id !== "string" || typeof answer.json.email !== "string") throw new NeedsYou("signed-out", "Example is signed out");
      return { id: answer.json.id, email: answer.json.email };
    },
  };
}
`;

const FIXTURE = `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Files, Fixture, FixtureDelivery, Provider, Scenario, Site, SiteAnswer, SiteRequest, Spoiled } from "@lifestreamprotocol/connect/sdk";

export const settings = { account: "person-a@example.com", key: "example-key" };
export const secrets: Readonly<Record<string, string>> = { "example-key": "key-synthetic" };

/** Item \`n\` of a scenario: the first \`old\` dated before the run's start, the edited ones a minute later, the removed ones absent. */
function notes(scenario: Scenario): { id: string; updated_ms: number }[] {
  return Array.from({ length: scenario.items }, (_, n) => n)
    .filter((n) => !scenario.removed.includes(n))
    .map((n) => ({ id: \`note-\${n}\`, updated_ms: scenario.start_ms + (n < scenario.old ? -86_400_000 : 0) + n + (scenario.edited.includes(n) ? 60_000 : 0) }));
}

const signed = (request: Request): boolean => request.headers.get("authorization") === "Bearer key-synthetic";

export function provider(scenario: Scenario): Provider {
  return async (request) => (signed(request) ? Response.json({ notes: notes(scenario) }) : new Response("{}", { status: 401 }));
}

export function files(scenario: Scenario): Files {
  return Object.fromEntries(notes(scenario).map((note) => [\`notes/\${note.id}.txt\`, \`Synthetic note \${note.updated_ms}.\`]));
}

export function site(scenario: Scenario): Site {
  return {
    answer({ url }: SiteRequest): SiteAnswer {
      if (url.pathname === "/api/me") return { status: 200, body: { id: "user-0001", email: settings.account } };
      return { status: 200, body: { items: notes(scenario) } };
    },
    page: () => ({ title: "Example", elements: [{ role: "button", name: "Sign out" }] }),
  };
}

const alone = (id: string): Spoiled => ({ alone: [\`note \${id}\`] });

export const fixture: Fixture = (folder): FixtureDelivery => {
  mkdirSync(join(folder, "notes"));
  writeFileSync(join(folder, "notes", "note-0.json"), "{}");
  return { source: "example:person-a@example.com:cloud", facts: { fetched_at: "2026-09-10T12:00:00.000Z" }, files: { "notes/note-0.json": alone("note-0") } };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-api": fixture };
`;

describe("the SDK", () => {
  it("exports exactly the pinned surface, and Connector and Acquirer hold exactly the pinned members", () => {
    expect(surface()).toEqual(PINNED);
  });

  it("leaves out a type of the families' input contracts, so an adapter's author cannot name a part of what its calls return", () => {
    const program = projectProgram();
    const checker = program.getTypeChecker();
    const contract = checker.getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(INPUTS_FILE)!)!).map((each) => each.name).sort();
    expect(contract).toContain("MessageParty");
    expect(contract.filter((name) => !PINNED.exports.includes(name))).toEqual([]);
  });

  it("serves contract 3, and every value it exports at run time is pinned", () => {
    expect(sdk.CONTRACTS).toEqual([3]);
    expect(Object.keys(sdk).filter((name) => !PINNED.exports.includes(name))).toEqual([]);
  });

  it("knows each error a home connector's own copy of the SDK throws by its name", async () => {
    vi.resetModules();
    const copy = await import("./sdk.js");
    const thrown = {
      TimeError: new copy.TimeError("spelling", "not an instant"),
      Limited: new copy.Limited("limited"),
      RecipeBroken: new copy.RecipeBroken("example-export", 1, "request", "NO_ELEMENT", "no button"),
    };
    for (const [name, error] of Object.entries(thrown)) {
      const home = sdk[name as keyof typeof thrown];
      expect([name, copy[name as keyof typeof thrown] === home]).toEqual([name, false]);
      expect([name, error instanceof home]).toEqual([name, true]);
      expect([name, Object.values(thrown).filter((other) => other instanceof home)]).toEqual([name, [error]]);
    }
  });

  it("types a template's acquirer and fixture module with nothing but its own exports, under a home folder's compiler options", () => {
    expect(faults({ "acquirer.ts": ACQUIRER, "test/fixture.ts": FIXTURE })).toEqual([]);
  });

  it("types an export folder's connector and reader, its kind's words, its account rule and its time, with nothing but its own exports", () => {
    const connector = `import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const example = {
  id: "example-export", product: "example", name: "Example", vendor: "example", records: "Every note.",
  sources: [{ id: "example:<account>:export", read: "example-export", arrives: "upload" }],
  export: { recognise: ["**/notes*.json"], guide: [{ words: "Download it.", open: { label: "Open Example", url: "https://example.com/" } }], leaves: ["**/*.pdf"] },
} satisfies Connector;
`;
    const reader = `import { archive, isObject, refuse, type ImportStated, type Member, type Reader } from "@lifestreamprotocol/connect/sdk";

export const example: Reader = {
  name: "example-export", kinds: {},
  read: (delivery, files) => archive(delivery, files, async function* () {}),
  account: { file: "account.json", json: (json) => (isObject(json) && typeof json.email === "string" ? json.email : refuse("names no one")) },
  async states(members: readonly Member[], anchor: string | null): Promise<ImportStated> {
    if (anchor !== null && members.length === 0) refuse("not the same account's");
    return { time_ms: 0, anchor: "first" };
  },
};
`;
    expect(faults({ "connector.ts": connector, "reader.ts": reader })).toEqual([]);
    expect(faults({ "connector.ts": connector.replace('guide: [{ words: "Download it.", open: { label: "Open Example", url: "https://example.com/" } }], ', ""), "reader.ts": reader }))
      .toEqual([expect.stringMatching(/^connector\.ts:\d+ /u)]);
  });

  it("asks a cast of a folder's own cursor or content type: an interface, a readonly array, an optional member; or lets through what JSON cannot hold", () => {
    const kept = `import { asJson, type Fetched, type JsonObject } from "@lifestreamprotocol/connect/sdk";

export interface Item {
  readonly asin: string;
  readonly price?: string;
}
export interface Place {
  readonly year: number;
  readonly page: number | null;
  readonly items: readonly Item[];
}
export const state: JsonObject = asJson<Place>({ year: 2026, page: null, items: [{ asin: "B000000001" }] });
export const fetched: Fetched = { files: [], facts: {}, state: asJson({ seen: ["a", "b"] as const }) };
`;
    expect(faults({ "acquirer.ts": kept })).toEqual([]);
    const held = (member: string) => `import { asJson } from "@lifestreamprotocol/connect/sdk";

interface Held {
  readonly ${member};
}
declare const value: Held;
export const state = asJson(value);
`;
    for (const member of ["at: Date", "count: bigint", "then: () => void", "maybe: string | undefined", "seen: Map<string, number>"]) {
      expect([member, faults({ "acquirer.ts": held(member) }).map((fault) => fault.slice(0, fault.indexOf(" ")))]).toEqual([member, ["acquirer.ts:7"]]);
    }
  });

  it("faults a template where it misuses each of the types, at the misuse: the settings, the dependencies, who, the scenario and each fake", () => {
    const misuses: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
      "acquirer.ts": [
        ["const where: { work: string; zone: string;", "const where: { work: string; zone: number;"],
        ["const now = dependencies.now ?? Date.now;", "const now = dependencies.now ?? Date.now;\n  dependencies.sleep?.(\"soon\");"],
        ["return { id: answer.json.id, email: answer.json.email };", "return { id: answer.json.id };"],
      ],
      "test/fixture.ts": [
        ["filter((n) => !scenario.removed.includes(n))", "filter((n) => scenario.removed !== n)"],
        ["? Response.json({ notes: notes(scenario) })", "? JSON.stringify({ notes: notes(scenario) })"],
        ["[`notes/${note.id}.txt`, `Synthetic note ${note.updated_ms}.`]", "[`notes/${note.id}.txt`, note.updated_ms]"],
        ["return { status: 200, body: { items: notes(scenario) } };", "return { body: { items: notes(scenario) } };"],
        ['"notes/note-0.json": alone("note-0")', '"notes/note-0.json": "whole"'],
      ],
    };
    const files: Record<string, string> = { "acquirer.ts": ACQUIRER, "test/fixture.ts": FIXTURE };
    for (const [path, swaps] of Object.entries(misuses)) {
      for (const [from, to] of swaps) {
        expect([path, from, files[path]!.includes(from)]).toEqual([path, from, true]);
        files[path] = files[path]!.replace(from, to);
      }
    }
    const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
    const misused = Object.entries(misuses).flatMap(([path, swaps]) => swaps.map(([, to]) => `${path}:${lineOf(files[path]!, files[path]!.indexOf(to) + to.length)}`));
    expect(faults(files).map((fault) => fault.slice(0, fault.indexOf(" "))).sort()).toEqual(misused.sort());
  });
});
