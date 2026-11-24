import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, utimesSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, version } from "esbuild";
import { bundleName, repoRoot } from "../programs.js";
import { connectDigest } from "../registry.js";

const ROOT = realpathSync(repoRoot());
const STANDALONE = [
  "packages/home/writer.ts", "packages/home/copier.ts", "packages/home/scanner.ts",
  "packages/model/call-main.ts", "packages/runner/leash.ts", "packages/runner/test/fake-runner.ts",
  "packages/connect/sdk.ts", "packages/home/trial.ts", "packages/home/test/programs-child.ts",
];
const PROGRAMS = [
  "packages/home/test/child.ts", "packages/home/test/cli-child.ts", "packages/home/test/door-child.ts", "packages/home/test/dashboard-home.ts", "packages/home/test/video-home.ts",
  "packages/home/test/stations-inproc.ts", "packages/home/test/release-walk.ts",
  "packages/home/door-main.ts", "packages/home/helper.ts",
  "packages/home/reader.ts", "packages/home/registry-home.ts",
  "mcp/test/home.ts", "mcp/test/registry.ts", "mcp/test/lifestream.ts",
  "tools/inventory.ts",
];
const TEST = join(ROOT, "packages", "home", "test");
const PACKAGES = [...["core", "connect", "families", "model", "privacy", "home", "runner"].map((name) => join(ROOT, "packages", name)), join(ROOT, "mcp", "test")];
const EXTRA_INPUTS = [join(ROOT, "tools", "inventory.ts")];
const TSCONFIG = join(ROOT, "tsconfig.json");
const LOADED = /\.(?:[cm]?[jt]s|json|txt)$/u;
const META_URL = ["import", "meta", "url"].join(".");
const META_URL_USE = new RegExp(`${META_URL.replaceAll(".", "\\.")}(?!\\s*===)`, "g");
const DAY_MS = 86_400_000;

function inputs(folder: string, into: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules" && entry.name !== ".build") inputs(path, into);
    } else if (LOADED.test(entry.name) && !entry.name.endsWith(".test.ts")) into.push(path);
  }
  return into;
}

export async function testDist(): Promise<{ dist: string; built: boolean }> {
  const registries = readdirSync(TEST).filter((name) => name.endsWith(".ts") && /^export default /mu.test(readFileSync(join(TEST, name), "utf8")));
  const standalone = STANDALONE.map((path) => join(ROOT, path)).sort();
  const shared = [...new Set([...PROGRAMS.map((path) => join(ROOT, path)), ...registries.map((name) => join(TEST, name))])].sort();
  const entries = [...standalone, ...shared].sort();
  const digest = createHash("sha256").update(`esbuild ${version} split-v5\n${entries.map((path) => relative(ROOT, path)).join("\n")}\n`);
  for (const path of [TSCONFIG, ...EXTRA_INPUTS, ...PACKAGES.flatMap((folder) => inputs(folder)).sort()]) digest.update(`${relative(ROOT, path)}\n`).update(readFileSync(path));
  const parent = join(ROOT, ".build", "test-dist");
  const dist = join(parent, digest.digest("hex").slice(0, 16));
  let built = false;
  if (existsSync(dist)) {
    utimesSync(dist, new Date(), new Date());
  } else {
    mkdirSync(parent, { recursive: true });
    const temp = mkdtempSync(`${dist}.`);
    const plugin = {
      name: "test-bundle",
      setup(on: Parameters<NonNullable<Parameters<typeof build>[0]["plugins"]>[number]["setup"]>[0]) {
        on.onResolve({ filter: /^[^./]/ }, ({ path }) => path.startsWith("@lifestreamprotocol/") ? undefined : { path, external: true });
        on.onLoad({ filter: /\.(?:mjs|ts)$/ }, ({ path }) => {
          const at = relative(temp, path).split(sep).join("/");
          return { contents: readFileSync(path, "utf8").replace(META_URL_USE, `new URL(${JSON.stringify(at)}, ${META_URL}).href`), loader: path.endsWith(".ts") ? "ts" : "js" };
        });
      },
    };
    const common = {
      outdir: temp, outExtension: { ".js": ".mjs" },
      bundle: true, sourcemap: false, platform: "node" as const, format: "esm" as const, target: "node22", logLevel: "silent" as const,
      define: { LIFESTREAM_TEST_BUNDLE: "true", LIFESTREAM_CONNECT: JSON.stringify(connectDigest(join(ROOT, "packages", "connect"))) }, plugins: [plugin],
    };
    try {
      await Promise.all([
        build({ ...common, entryPoints: Object.fromEntries(standalone.map((path) => [bundleName(path), path])), splitting: false }),
        build({ ...common, entryPoints: Object.fromEntries(shared.map((path) => [bundleName(path), path])), splitting: true, chunkNames: "chunk-[hash]" }),
      ]);
      renameSync(temp, dist);
      built = true;
    } catch (error) {
      rmSync(temp, { recursive: true, force: true });
      if (!existsSync(dist)) throw error;
    }
  }
  for (const name of readdirSync(parent)) {
    const path = join(parent, name);
    if (path !== dist && (statSync(path, { throwIfNoEntry: false })?.mtimeMs ?? Infinity) < Date.now() - DAY_MS) rmSync(path, { recursive: true, force: true });
  }
  return { dist, built };
}

export async function setup(): Promise<void> {
  if (process.env.LIFESTREAM_TEST_DIST !== undefined) return;
  const started = performance.now();
  const { dist, built } = await testDist();
  process.env.LIFESTREAM_TEST_DIST = dist;
  process.stdout.write(` Test bundles  ${relative(ROOT, dist)} ${built ? "built" : "found"} in ${((performance.now() - started) / 1000).toFixed(2)} s\n`);
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const { dist } = await testDist();
  process.stdout.write(`${dist}\n`);
}
