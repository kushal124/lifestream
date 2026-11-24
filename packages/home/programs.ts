import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

declare const LIFESTREAM_RELEASE: string | undefined;
declare const LIFESTREAM_TEST_BUNDLE: boolean | undefined;

const released = typeof LIFESTREAM_RELEASE === "string";

export function fromRelease(): boolean {
  return released;
}
const dist = () => dirname(realpathSync(process.argv[1]!));

export function releaseFolder(): string {
  return dirname(dist());
}
const here = (path: string) => new URL(path, import.meta.url);

export function repoRoot(): string {
  return fileURLToPath(here("../../"));
}

export function faceEngine(): string {
  return join(repoRoot(), "faces", ".build", "release", "face-engine");
}

export function bundleName(source: string): string {
  return relative(realpathSync(repoRoot()), realpathSync(source)).replace(/\.ts$/u, "").split(sep).join("~");
}

export function testBundle(source: string): string | undefined {
  const folder = released ? undefined : process.env.LIFESTREAM_TEST_DIST;
  return folder === undefined ? undefined : join(folder, `${bundleName(source)}.mjs`);
}

export function parkableRegistry(module?: string): boolean {
  if (module === undefined) return true;
  if (!module.startsWith("file:")) return false;
  try {
    const path = realpathSync(fileURLToPath(module));
    if (released) return path.startsWith(realpathSync(releaseFolder()));
    if (path.startsWith(realpathSync(repoRoot()))) return true;
    const folder = process.env.LIFESTREAM_TEST_DIST;
    return folder !== undefined && existsSync(folder) && path.startsWith(realpathSync(folder));
  } catch {
    return false;
  }
}

export function registryImport(module: string): string {
  if (typeof LIFESTREAM_TEST_BUNDLE !== "boolean" || !module.endsWith(".ts")) return module;
  const bundle = testBundle(fileURLToPath(module));
  if (bundle === undefined || !existsSync(bundle)) {
    throw new Error(`a program the test run bundled cannot load ${module}: a home a test starts names a registry of packages/home/test (a default export) or registry-home.ts, or starts without LIFESTREAM_TEST_DIST`);
  }
  return pathToFileURL(bundle).href;
}

export function checkoutProgram(source: string): string[] {
  const bundle = testBundle(source);
  return bundle !== undefined ? [bundle] : ["--import", "tsx", source];
}

export function threadProgram(name: "helper" | "reader" | "writer" | "copier" | "scanner"): { url: URL; execArgv?: string[] } {
  if (released) return { url: pathToFileURL(join(dist(), `${name}.mjs`)), execArgv: [] };
  const bundle = testBundle(fileURLToPath(here(`./${name}.ts`)));
  return bundle !== undefined ? { url: pathToFileURL(bundle), execArgv: [] } : { url: here(`./${name}.ts`), execArgv: ["--import", "tsx"] };
}

export function callCommand(): string[] {
  if (released) return [process.execPath, join(dist(), "call.mjs")];
  const model = createRequire(import.meta.url).resolve("@lifestreamprotocol/model");
  return [process.execPath, ...checkoutProgram(join(dirname(model), "call-main.ts"))];
}

export function homeCommand(): string[] {
  if (released) return [process.execPath, join(dist(), "home.mjs")];
  const bundle = testBundle(fileURLToPath(here("./test/cli-child.ts")));
  return bundle !== undefined ? [process.execPath, bundle] : [process.execPath, "--import", "tsx", fileURLToPath(here("./cli.ts"))];
}

export function sdkModule(): string {
  if (released) return join(dist(), "sdk.mjs");
  const source = join(repoRoot(), "packages", "connect", "sdk.ts");
  const bundle = testBundle(source);
  return bundle !== undefined && existsSync(bundle) ? bundle : source;
}

export function trialCommand(): string[] {
  if (released) return [process.execPath, join(dist(), "trial.mjs")];
  return [process.execPath, ...checkoutProgram(fileURLToPath(here("./trial.ts")))];
}

export function homeRegistryModule(): URL {
  return released ? pathToFileURL(join(dist(), "registry.mjs")) : here("./registry-home.ts");
}
