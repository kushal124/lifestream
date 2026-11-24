import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FOLDERS = ["packages", "tools", "extension"];
const SKIPPED = new Set(["node_modules", ".build", "dist"]);
const IMPORT =
  /import\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*(?:\*\s+as\s+\w+\s*)?from\s*["']([^"']+)["']|export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?)\s*from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/gu;
const NAMED_EXPORT_FROM = /export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/gu;
const STAR_EXPORT_FROM = /export\s+\*\s+from\s*["']([^"']+)["']/gu;
const NAMESPACE_EXPORT_FROM = /export\s+\*\s+as\s+([\w$]+)\s+from\s*["']([^"']+)["']/gu;
const DECLARATION =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum|abstract class)\s+([A-Za-z_$][\w$]*)/gu;

export interface Graph {
  readonly files: readonly string[];
  readonly importers: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface Hub {
  readonly file: string;
  readonly tests: number;
  readonly importers: number;
}

export const isTest = (file: string): boolean => file.endsWith(".test.ts");

export function buildGraph(root: string): Graph {
  const files = FOLDERS.flatMap((folder) => walk(root, folder));
  const known = new Set(files);
  const source = new Map(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));
  const entries = packageEntries(root);
  const entryFiles = new Set(entries.values());

  const relativeTarget = (from: string, specifier: string): string | undefined => {
    const base = normalize(join(dirname(from), specifier));
    return [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.mjs$/u, ".mts"), `${base}.ts`, `${base}/index.ts`]
      .find((candidate) => known.has(candidate));
  };
  const target = (from: string, specifier: string): string | undefined =>
    specifier.startsWith(".") ? relativeTarget(from, specifier) : entries.get(specifier);

  const exporters = new Map<string, Map<string, string>>();
  for (const entry of entryFiles) {
    const text = source.get(entry) ?? "";
    const byName = new Map<string, string>();
    for (const [, body = "", specifier = ""] of text.matchAll(NAMED_EXPORT_FROM)) {
      const file = target(entry, specifier);
      if (file === undefined) continue;
      for (const name of names(body, "exported")) byName.set(name, file);
    }
    for (const [, name = "", specifier = ""] of text.matchAll(NAMESPACE_EXPORT_FROM)) {
      const file = target(entry, specifier);
      if (file !== undefined) byName.set(name, file);
    }
    for (const [, specifier = ""] of text.matchAll(STAR_EXPORT_FROM)) {
      const file = target(entry, specifier);
      if (file === undefined) continue;
      for (const [, name = ""] of (source.get(file) ?? "").matchAll(DECLARATION)) {
        if (!byName.has(name)) byName.set(name, file);
      }
    }
    exporters.set(entry, byName);
  }

  const importers = new Map<string, Set<string>>();
  const edge = (imported: string, importer: string): void => {
    let set = importers.get(imported);
    if (set === undefined) importers.set(imported, (set = new Set()));
    set.add(importer);
  };
  for (const [file, text] of source) {
    for (const [, defaultName, body, fromSpecifier, exportSpecifier, dynamicSpecifier, bareSpecifier] of text.matchAll(IMPORT)) {
      const specifier = fromSpecifier ?? exportSpecifier ?? dynamicSpecifier ?? bareSpecifier ?? "";
      const imported = target(file, specifier);
      if (imported === undefined) continue;
      const byName = exporters.get(imported);
      if (byName === undefined || fromSpecifier === undefined || defaultName !== undefined || !body || entryFiles.has(file)) {
        edge(imported, file);
        continue;
      }
      for (const name of names(body, "local")) edge(byName.get(name) ?? imported, file);
    }
  }
  return { files, importers };
}

export function reachedTests(graph: Graph, changed: readonly string[]): string[] {
  const seen = new Set(changed);
  const queue = [...changed];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    for (const importer of graph.importers.get(next) ?? []) {
      if (seen.has(importer)) continue;
      seen.add(importer);
      queue.push(importer);
    }
  }
  return [...seen].filter(isTest).sort();
}

export function hubs(graph: Graph, count: number): Hub[] {
  return graph.files
    .filter((file) => !isTest(file))
    .map((file) => ({ file, tests: reachedTests(graph, [file]).length, importers: graph.importers.get(file)?.size ?? 0 }))
    .sort((a, b) => b.tests - a.tests || b.importers - a.importers || a.file.localeCompare(b.file))
    .slice(0, count);
}

export function runReach(root: string, args: readonly string[], cwd: string, out: (line: string) => void, err: (line: string) => void): number {
  const graph = buildGraph(root);
  const total = graph.files.filter(isTest).length;
  if (args[0] === "--hubs") {
    const count = args[1] === undefined ? 15 : Number(args[1]);
    if (!Number.isInteger(count) || count < 1 || args.length > 2) {
      err("usage: npx tsx tools/reach.ts --hubs [n]");
      return 2;
    }
    const rows = hubs(graph, count);
    const width = String(total).length;
    for (const hub of rows) {
      out(`${String(hub.tests).padStart(width)} tests  ${String(hub.importers).padStart(width)} importers  ${hub.file}`);
    }
    out(`of ${total} test files`);
    return 0;
  }
  if (args.length === 0 || args.some((arg) => arg.startsWith("-"))) {
    err("usage: npx tsx tools/reach.ts <file…> | --hubs [n]");
    return 2;
  }
  const known = new Set(graph.files);
  const changed = args.map((arg) => relative(root, resolve(cwd, arg)));
  const unknown = changed.filter((file) => !known.has(file));
  if (unknown.length > 0) {
    for (const file of unknown) err(`reach: ${file} is no module of the graph`);
    return 1;
  }
  const tests = reachedTests(graph, changed);
  for (const test of tests) out(test);
  out(`${tests.length} of ${total} test files`);
  return 0;
}

function walk(root: string, folder: string): string[] {
  let entries;
  try {
    entries = readdirSync(join(root, folder), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : walk(root, path);
    return /\.(?:ts|mts|mjs|js)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function packageEntries(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  let folders;
  try {
    folders = readdirSync(join(root, "packages"), { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return entries;
  }
  for (const folder of folders) {
    let manifest: { name?: string; exports?: Record<string, unknown> | string };
    try {
      manifest = JSON.parse(readFileSync(join(root, "packages", folder.name, "package.json"), "utf8")) as typeof manifest;
    } catch {
      continue;
    }
    if (manifest.name === undefined) continue;
    const exports = typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports ?? { ".": "./index.ts" };
    for (const [key, value] of Object.entries(exports)) {
      const path = typeof value === "string" ? value : exportPath(value);
      if (path !== undefined) entries.set(manifest.name + key.slice(1), normalize(join("packages", folder.name, path)));
    }
  }
  return entries;
}

function exportPath(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const conditions = value as Record<string, unknown>;
  const path = conditions.import ?? conditions.default;
  return typeof path === "string" ? path : undefined;
}

function names(body: string, side: "local" | "exported"): string[] {
  return body.split(",").map((part) => {
    const bare = part.trim().replace("type ", "");
    const [imported = "", local] = bare.split(" as ");
    return (side === "local" || local === undefined ? imported : local).trim();
  }).filter((name) => name !== "");
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = runReach(root, process.argv.slice(2), process.cwd(), (line) => console.log(line), (line) => console.error(line));
}
