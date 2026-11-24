import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Connector, Field, Reader } from "@lifestreamprotocol/connect";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECT = join(ROOT, "packages", "connect");
const FOLDERS_FILE = join(CONNECT, "folders.ts");
const KNOWN_STORES = "macos-app/Sources/Shipping/Stores/KnownStores.swift";
const STORE_FIXTURES = "macos-app/Tests/Fixtures/stores";
const NOT_FOLDERS = new Set(["shared", "templates", "imports"]);
const ENTRY = /^export const connectors\b/mu;

export function releaseFolders(connect = CONNECT): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "test" || entry.name.startsWith(".")) continue;
      if (dir === connect && NOT_FOLDERS.has(entry.name)) continue;
      const path = join(dir, entry.name);
      const index = join(path, "index.ts");
      if (existsSync(index) && ENTRY.test(readFileSync(index, "utf8"))) found.push(relative(connect, path).split(sep).join("/"));
      walk(path);
    }
  };
  walk(connect);
  return found.sort();
}

export function foldersFile(folders: readonly string[]): string {
  const name = (folder: string) => `folder_${folder.replace(/[^a-z0-9]+/gu, "_")}`;
  return [
    ...folders.map((folder) => `import * as ${name(folder)} from "./${folder}/index.js";`),
    "",
    "export const FOLDERS = [",
    ...folders.map((folder) => `  { folder: ${JSON.stringify(folder)}, module: ${name(folder)} },`),
    "] as const satisfies readonly { readonly folder: string; readonly module: object }[];",
    "",
  ].join("\n");
}

export function kindsTable(connectors: readonly Connector[], readers: readonly Reader[]): string {
  const by = new Map<string, Set<string>>();
  for (const reader of readers) {
    const stating = connectors.filter((connector) => connector.sources.some((source) => source.read === reader.name)).map((connector) => connector.id);
    for (const kind of Object.keys(reader.kinds)) by.set(kind, new Set([...by.get(kind) ?? [], ...stating]));
  }
  const rows = [...by].sort(([a], [b]) => a.localeCompare(b)).map(([kind, ids]) => `| \`${kind}\` | ${[...ids].sort().join(", ")} |`);
  return ["| Kind | Stated by |", "|---|---|", ...rows].join("\n");
}

export function connectorRows(connectors: readonly Connector[]): string[] {
  const code = (value: unknown) => `\`${typeof value === "string" ? value : JSON.stringify(value)}\``;
  const bounds = (each: { min?: string | number; max?: string | number }) => each.min !== undefined && each.max !== undefined ? `${code(each.min)} to ${code(each.max)}`
    : each.min !== undefined ? `${code(each.min)} or more` : each.max !== undefined ? `up to ${code(each.max)}` : "";
  const row = (id: string, member: string, kind: string, value: unknown, bound: string, meaning: string) =>
    `| ${code(id)} | ${code(member)} | ${kind} | ${value === undefined ? "" : code(value)} | ${bound} | ${meaning} |`;
  const field = (id: string, name: string, each: Field) => each.kind === "secret"
    ? row(id, name, "secret", each.secret, "a secret's name", each.label)
    : each.kind === "choice" ? row(id, name, "choice", each.default, Object.keys(each.options).map(code).join(", "), each.label)
      : row(id, name, each.kind, each.default, each.kind === "toggle" ? "`true` or `false`" : each.kind === "number" || each.kind === "duration" ? bounds(each) : "", each.label);
  return [...connectors].sort((a, b) => a.id.localeCompare(b.id)).flatMap((connector) => [
    ...connector.refresh === undefined ? [] : [row(connector.id, "refresh", "duration", connector.refresh.default, bounds(connector.refresh), "the least time between two reads of what is new")],
    ...connector.backfill === undefined ? [] : [
      row(connector.id, "start", "start", undefined, "`all` or a day", "the day before which it loads nothing, the home's `history.start` when unset"),
      ...connector.backfill.pace === undefined ? [] : [row(connector.id, "pace", "duration", connector.backfill.pace.default, bounds(connector.backfill.pace), "the least time between two history pages")],
    ],
    ...Object.entries(connector.fields ?? {}).map(([name, each]) => field(connector.id, name, each)),
  ]);
}

function pagesOf(folder: string, folders: readonly string[], connect = CONNECT): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(connect, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "test" && entry.name !== "node_modules" && !folders.includes(path)) walk(path);
      } else if (entry.name.endsWith(".md") && !["README.md", "SKILL.md"].includes(entry.name)) found.push(path);
    }
  };
  walk(folder);
  return found.sort();
}

function declaring(connect = CONNECT): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(connect, dir), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "test" || entry.name === "node_modules" || (dir === "" && NOT_FOLDERS.has(entry.name))) continue;
      const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (existsSync(join(connect, path, "connector.ts"))) found.push(path);
      walk(path);
    }
  };
  walk("");
  return found;
}

export function pagesList(folders: readonly string[], connect = CONNECT): string {
  const outside = declaring(connect).filter((dir) => !folders.some((folder) => dir === folder || dir.startsWith(`${folder}/`)));
  const links = [...folders, ...outside].sort().flatMap((folder) => pagesOf(folder, folders, connect).map((page) => `[${dirname(page)}](${page})`));
  const lines: string[] = [];
  let line = "- Connectors, by folder:";
  for (const [index, link] of links.entries()) {
    const word = `${link}${index === links.length - 1 ? "." : ","}`;
    if (`${line} ${word}`.length > 120) {
      lines.push(line);
      line = `  ${word}`;
    } else line = `${line} ${word}`;
  }
  return [...lines, line].join("\n");
}

export function foldersTree(modules: readonly { folder: string; connectors: readonly Connector[] }[]): string {
  const lines = modules.map(({ folder, connectors }) => `${`${folder}/`.padEnd(27)} ${connectors.map((connector) => connector.name).join(", ")}`.trimEnd());
  return ["```", ...lines, "```"].join("\n");
}

export function storeFixtures(stores: Readonly<Record<string, unknown>>): Record<string, string> {
  return Object.fromEntries(Object.keys(stores).sort().map((id) => [`${id}.json`, `${JSON.stringify(stores[id], null, 2)}\n`]));
}

interface Block {
  readonly file: string;
  readonly start: string;
  readonly end: string;
  readonly text: string;
}

const marks = (what: string) => ({
  start: `<!-- ${what}: written by tools/connectors.ts, never by hand. -->`,
  end: `<!-- /${what} -->`,
});

async function blocks(): Promise<Block[]> {
  const connect = await import(pathToFileURL(join(CONNECT, "index.ts")).href) as typeof import("@lifestreamprotocol/connect");
  const { FOLDERS } = await import(pathToFileURL(FOLDERS_FILE).href) as typeof import("../packages/connect/folders.js");
  const declared = connect.declarations();
  const readers = connect.providers().flatMap((provider) => provider.readers);
  const modules = FOLDERS.map(({ folder, module }) => ({ folder, connectors: (module as { connectors: readonly Connector[] }).connectors }));
  return [
    { file: "packages/connect/SKILL.md", ...marks("The kinds"), text: kindsTable(declared, readers) },
    { file: "docs/operating/config.md", ...marks("The connectors' settings"), text: ["| Connector | Member | Kind | Default | Bounds | Meaning |", "|---|---|---|---|---|---|", ...connectorRows(declared)].join("\n") },
    { file: "packages/connect/SKILL.md", ...marks("The connectors' pages"), text: pagesList(FOLDERS.map((each) => each.folder)) },
    { file: "packages/connect/README.md", ...marks("The release folders"), text: foldersTree(modules) },
  ];
}

function placed(source: string, block: Block): string | null {
  const start = source.indexOf(`${block.start}\n`);
  const end = source.indexOf(block.end, start);
  if (start < 0 || end < 0) return null;
  return `${source.slice(0, start + block.start.length + 1)}${block.text}\n${source.slice(end)}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes("--check");
  const stale: string[] = [];
  const folders = foldersFile(releaseFolders());
  const current = existsSync(FOLDERS_FILE) ? readFileSync(FOLDERS_FILE, "utf8") : "";
  if (current !== folders) {
    if (check) stale.push("packages/connect/folders.ts is not the release folders'");
    else writeFileSync(FOLDERS_FILE, folders);
  }
  for (const block of await blocks()) {
    const path = join(ROOT, block.file);
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const next = placed(source, block);
    if (next === null) stale.push(`${block.file} holds no block between ${block.start} and ${block.end}`);
    else if (next !== source) {
      if (check) stale.push(`${block.file}: the block between ${block.start} and ${block.end} is not what the declarations make`);
      else writeFileSync(path, next);
    }
  }
  const connect = await import(pathToFileURL(join(CONNECT, "index.ts")).href) as typeof import("@lifestreamprotocol/connect");
  const { declaredStores, knownStoresSwift } = await import(pathToFileURL(join(ROOT, "packages", "home", "stores.ts")).href) as typeof import("../packages/home/stores.js");
  const known = knownStoresSwift(connect.declarations());
  const knownPath = join(ROOT, KNOWN_STORES);
  if (existsSync(dirname(knownPath)) && (existsSync(knownPath) ? readFileSync(knownPath, "utf8") : "") !== known) {
    if (check) stale.push(`${KNOWN_STORES} is not the release's stores'`);
    else writeFileSync(knownPath, known);
  }
  const fixtures = join(ROOT, STORE_FIXTURES);
  if (existsSync(fixtures)) {
    const made = storeFixtures(declaredStores(connect.declarations()).stores);
    const held = readdirSync(fixtures).filter((name) => name.endsWith(".json"));
    for (const name of held.filter((each) => made[each] === undefined)) {
      if (check) stale.push(`${STORE_FIXTURES}/${name} is no release store's`);
      else rmSync(join(fixtures, name));
    }
    for (const [name, text] of Object.entries(made)) {
      const path = join(fixtures, name);
      if ((existsSync(path) ? readFileSync(path, "utf8") : "") === text) continue;
      if (check) stale.push(`${STORE_FIXTURES}/${name} is not the release's store`);
      else writeFileSync(path, text);
    }
  }
  const words = spawnSync(process.execPath, [...process.execArgv, join(ROOT, "tools", "phone-words.ts"), ...(check ? ["--check"] : [])], { cwd: ROOT, encoding: "utf8" });
  if (words.status !== 0) stale.push(`tools/phone-words.ts: ${(words.stderr || words.stdout).trim()}`);
  for (const line of stale) process.stderr.write(`connectors: ${line}\n`);
  if (stale.length > 0) {
    if (check) process.stderr.write("connectors: run npx tsx tools/connectors.ts\n");
    return 1;
  }
  if (!check) process.stdout.write("connectors: wrote the release folders' blocks\n");
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
