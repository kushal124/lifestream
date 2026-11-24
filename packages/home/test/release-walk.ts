import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FOLDERS, type Connector } from "@lifestreamprotocol/connect";
import { guardConnections, proveAcquirers, resetConnections } from "../conformance-acquirers.js";
import { builtOf, proveInChild, type FolderCheck } from "../conformance.js";
import { unstrippable } from "../folders.js";
import { repoRoot } from "../programs.js";
import { effectiveOf } from "../settings.js";

const CONNECT = join(repoRoot(), "packages", "connect");

export interface ReleaseAcquirer {
  readonly folder: string;
  readonly name: string;
}

export function releaseAcquirers(): ReleaseAcquirer[] {
  return FOLDERS.flatMap(({ folder, module }) => Object.keys((module as { acquirers?: object }).acquirers ?? {}).map((name) => ({ folder, name })));
}

function fixtureFiles(dir: string, folders: ReadonlySet<string>): string[] {
  const own = join(dir, "test", "fixture.ts");
  const inner = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "test" && entry.name !== "node_modules" && !folders.has(join(dir, entry.name)))
    .flatMap((entry) => fixtureFiles(join(dir, entry.name), folders));
  return [...(existsSync(own) ? [own] : []), ...inner];
}

async function fixtureOf(folder: string, connector: Connector): Promise<{ path: string; module: NonNullable<FolderCheck["fixture"]> } | null> {
  const folders = new Set(FOLDERS.map((each) => join(CONNECT, each.folder)).filter((each) => each !== join(CONNECT, folder)));
  const reads = new Set(connector.sources.map((source) => source.read));
  for (const path of fixtureFiles(join(CONNECT, folder), folders)) {
    const module = (await import(pathToFileURL(path).href)) as NonNullable<FolderCheck["fixture"]>;
    if (Object.keys(module.fixtures ?? {}).some((read) => reads.has(read))) return { path, module };
  }
  return null;
}

export async function walkRelease({ folder, name }: ReleaseAcquirer, inline = false): Promise<{ faults: string[]; lines: string[] }> {
  const module = FOLDERS.find((each) => each.folder === folder)!.module as { connectors: readonly Connector[] };
  const connector = module.connectors.find((each) => (each.acquirers ?? []).includes(name))!;
  const stripped = unstrippable(join(CONNECT, folder));
  if (stripped !== null) return { faults: [`${folder}: ${stripped}: a home strips a folder's types and compiles nothing, as it would the release's`], lines: [] };
  const fixture = await fixtureOf(folder, connector);
  if (fixture === null) return { faults: [`${folder}: no test/fixture.ts in it states a fixture of ${connector.id}'s readers, whose fakes walk ${name}`], lines: [] };
  const scratch = mkdtempSync(join(tmpdir(), `release-walk-${name}-`));
  try {
    const dir = join(scratch, name);
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
    writeFileSync(join(dir, "index.ts"), `export * from ${JSON.stringify(join(CONNECT, folder, "index.ts"))};\n`);
    writeFileSync(join(dir, "test", "fixture.ts"), `export * from ${JSON.stringify(fixture.path)};\n`);
    const work = join(scratch, "work");
    mkdirSync(work);
    const settings = effectiveOf({ "day.zone": "UTC", unit: "macbook-pro-0001" }, "the release walk").settings;
    const acquirers = [{ name, settings: builtOf(connector, name, { work, fixture: fixture.module }) }];
    if (!inline) return await proveAcquirers({ dir, work, settings, acquirers });
    resetConnections();
    const faults: string[] = [];
    const lines: string[] = [];
    await proveInChild({ prove: { dir, work, settings, acquirers } }, (event) => {
      if (event.proof === "fault") faults.push(event.text);
      else if (event.proof === "line") lines.push(event.text);
    });
    return { faults, lines };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] === "--all") {
    guardConnections();
    const walked: Record<string, { faults: string[]; lines: string[] }> = {};
    for (const acquirer of releaseAcquirers()) walked[acquirer.name] = await walkRelease(acquirer, true);
    process.stdout.write(JSON.stringify(walked), () => process.exit(0));
  } else {
    const [folder, name] = process.argv.slice(2) as [string, string];
    process.stdout.write(JSON.stringify(await walkRelease({ folder, name })));
  }
}
