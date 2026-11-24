import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Acquirer, Client, Connector, Reader, Labeler, SignedIn } from "@lifestreamprotocol/connect";
import { selects, type Adapters, type HomeFolder, type SourceRow, type SourceSelector } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { generationCode } from "./folders.js";
import { registryImport } from "./programs.js";
import type { Settings } from "./settings.js";

export interface Registry {
  connectors: readonly Connector[];
  readers: readonly Reader[];
  families: readonly Family[];
  acquirers?: readonly Acquirer[];
  signins?: Readonly<Record<string, SignedIn>>;
  clients?: readonly Client[];
  adapters?: Readonly<Record<string, Adapters>>;
  labelers?: readonly Labeler[];
  feeders?: Readonly<Record<string, string>>;
  code?: string;
  placesSearch?: { secret: string; endpoint: string };
  faceEngine?: string;
}

export function readerFor(registry: Registry, source: Pick<SourceRow, "connector">): Reader | undefined {
  const name = registry.feeders?.[source.connector] ?? source.connector;
  return registry.readers.find((reader) => reader.name === name);
}

export interface RegistryHome {
  readonly root: string;
  folder(): HomeFolder;
}

export type RegistryModule = { default: (settings: Settings, home: RegistryHome) => Registry | Promise<Registry> };

export type Loaded = Registry & { readonly code: string };

declare const LIFESTREAM_CONNECT: string | undefined;
let connect: string | undefined;

export function homeOf(folder: HomeFolder): RegistryHome {
  return { root: folder.root, folder: () => folder };
}

export async function loadRegistry(module: string, settings: Settings, home: RegistryHome): Promise<Loaded> {
  const loaded = (await import(registryImport(module))) as Partial<RegistryModule>;
  if (typeof loaded.default !== "function") throw new TypeError(`${module} has no default export building the registry`);
  const registry = await loaded.default(settings, home);
  const lists = [
    ["connector", registry.connectors.map((each) => each.id)],
    ["reader", registry.readers.map((each) => each.name)],
    ["family", registry.families.map((each) => each.name)],
    ["acquirer", (registry.acquirers ?? []).map((each) => each.name)],
    ["labeler", (registry.labelers ?? []).map((each) => each.name)],
  ] as const;
  for (const [what, names] of lists) {
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name)) throw new TypeError(`two of the registry's ${what}s are named ${name}`);
      seen.add(name);
    }
  }
  if (registry.code !== undefined) return registry as Loaded;
  connect ??= typeof LIFESTREAM_CONNECT === "string" ? LIFESTREAM_CONNECT : connectDigest(fileURLToPath(new URL("../connect/", import.meta.url)));
  const folders = generationCode(home.root);
  return { ...registry, code: folders === "" ? connect : `sha256:${createHash("sha256").update(`${connect}\n${folders}`).digest("hex")}` };
}

export function connectDigest(folder: string): string {
  const files = (readdirSync(folder, { recursive: true }) as string[])
    .map((path) => path.split(sep).join("/"))
    .filter((path) => path.endsWith(".ts") && !/\.test(?:-support)?\.ts$/u.test(path) && !path.split("/").some((part) => part === "test" || part === "node_modules"))
    .sort();
  const hash = createHash("sha256");
  for (const path of files) hash.update(`${path}\u0000`).update(readFileSync(join(folder, path))).update("\u0000");
  return `sha256:${hash.digest("hex")}`;
}

export type Inputs = readonly { sources: SourceSelector; kinds: readonly string[]; linked?: true }[];

export function readerOf(inputs: Inputs, sources: readonly SourceRow[]): (source: string, kind?: string) => boolean {
  const read = new Map<string, Set<string>>();
  for (const row of sources) {
    const kinds = inputs.filter((input) => selects(input.sources, row)).flatMap((input) => input.kinds);
    if (kinds.length > 0) read.set(row.id, new Set(kinds));
  }
  return (source, kind) => {
    const kinds = read.get(source);
    return kinds !== undefined && (kind === undefined || kinds.has(kind));
  };
}
