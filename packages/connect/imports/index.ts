import { createHash } from "node:crypto";
import type { BlobReader, Delivery } from "@lifestreamprotocol/core";
import { connectorIcon, ownExport, roadsOf, type Connector, type GuideStep, type KindExport } from "../declaration.js";
import type { ImportStated, Reader } from "../seams.js";
import { accountsNamed, type AccountsNamed } from "../shared/import-account.js";
import { archiveFile, keptText, listed, type Member } from "../shared/members.js";
import { matches } from "../shared/patterns.js";
import { Refused } from "../shared/refused.js";
import { googleTakeout } from "./google-takeout/import.js";
import { iphoneBackup } from "./iphone-backup/import.js";
import { kindReads, memberOf, ownReads, type ImportProduct, type ImportRead } from "./reads.js";

export { googleTakeout } from "./google-takeout/import.js";
export { iphoneBackup } from "./iphone-backup/import.js";
export { memberOf, type ImportProduct, type ImportRead } from "./reads.js";

export interface Import {
  readonly kind: string;
  readonly name: string;
  of(connector: Connector): boolean;
  readonly root?: string;
  readonly icon: string;
  readonly takes: string;
  readonly wait: string;
  readonly file: string;
  readonly ask: string;
  readonly accounts: string;
  readonly asks?: Readonly<Record<string, string>>;
  readonly guide: readonly GuideStep[];
  named(members: readonly Member[]): Promise<AccountsNamed>;
  stamp?(file: string, members: readonly Member[]): Promise<string | null>;
  states?(file: string, members: readonly Member[]): Promise<ImportStated | null>;
  device?(members: readonly Member[]): Promise<ImportDevice | null>;
}

export interface ImportDevice {
  readonly device: string;
  readonly accounts: readonly string[];
  readonly model: string;
  readonly model_name: string;
  readonly serial4: string | null;
}

export const IMPORTS: readonly Import[] = [googleTakeout, iphoneBackup];

export type Resolved = { readonly products: readonly { readonly id: string; readonly named: readonly string[] }[] } | { readonly refused: string };

export type Stated = { readonly time_ms: number | null; readonly anchor?: string } | { readonly refused: string };

export interface ImportKind {
  readonly id: string;
  readonly name: string;
  readonly icon: string;
  readonly takes: string;
  readonly wait: string | null;
  readonly file: string;
  readonly guide: readonly GuideStep[];
  readonly ask: string;
  readonly vendor: string;
  whose(product: string): { readonly vendor: string; readonly ask: string };
  readonly root?: string;
  readonly reads: readonly ImportRead[];
  readonly products: readonly ImportProduct[];
  readonly recognise: readonly string[];
  readonly leaves: readonly string[];
  resolve(members: readonly Member[]): Promise<Resolved>;
  stamp(file: string, members: readonly Member[]): Promise<string | null>;
  states(file: string, members: readonly Member[], anchor: string | null): Promise<Stated>;
  device(members: readonly Member[]): Promise<ImportDevice | null>;
}

async function refusedAs<T>(read: () => Promise<T>): Promise<T | { refused: string }> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message };
    throw error;
  }
}

export function importOf(connector: Connector): Import | null {
  if (connector.export === undefined || !("product" in connector.export)) return null;
  return IMPORTS.find((kind) => kind.of(connector)) ?? null;
}

function heldProducts(kind: ImportKind, members: readonly Member[]): string[] {
  return [...new Set(members.flatMap((member) => kind.reads.filter((read) => matches(read.members, member.name)).map((read) => read.of)))].sort();
}

const sortedBy = <T extends { id: string }>(values: Iterable<T>): T[] => [...values].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

function kindOfImport(declared: Import, connectors: readonly Connector[]): ImportKind | null {
  const fed = connectors.flatMap((connector) => (importOf(connector) === declared ? [{ connector, product: (connector.export as KindExport).product }] : []));
  const reads = fed.flatMap(({ connector, product }) => kindReads(declared, connector, product));
  if (reads.length === 0) return null;
  const products = sortedBy(fed.map(({ connector, product }): ImportProduct => {
    const noun = connector.noun ?? product.noun;
    const folder = reads.find((read) => read.of === product.id)!.folder;
    return { id: product.id, name: product.name, ...(folder === undefined ? {} : { folder }), ...(noun === undefined ? {} : { noun }) };
  }));
  const vendors = new Map(fed.map(({ connector, product }) => [product.id, declared.asks === undefined ? declared.accounts : connector.vendor]));
  const kind: ImportKind = {
    id: declared.kind, name: declared.name, icon: declared.icon, takes: declared.takes, wait: declared.wait, file: declared.file, guide: declared.guide, ask: declared.ask, vendor: declared.accounts,
    whose: (product) => {
      const vendor = vendors.get(product) ?? declared.accounts;
      return { vendor, ask: declared.asks?.[vendor] ?? declared.ask };
    },
    ...(declared.root === undefined ? {} : { root: declared.root }),
    reads, products, recognise: [...new Set(reads.map((read) => read.members))], leaves: [],
    resolve: (members) => refusedAs(async () => {
      const named = await declared.named(members);
      if ("refused" in named) return named;
      return { products: heldProducts(kind, members).map((id) => ({ id, named: named.named })) };
    }),
    stamp: async (file, members) => (declared.stamp === undefined ? null : declared.stamp(file, members)),
    states: (file, members) => refusedAs(async () => {
      const stated = declared.states === undefined ? null : await declared.states(file, members);
      return stated === null ? { time_ms: null } : { time_ms: stated.time_ms ?? null, ...(stated.anchor === undefined ? {} : { anchor: stated.anchor }) };
    }),
    device: async (members) => (declared.device === undefined ? null : declared.device(members)),
  };
  return kind;
}

function kindOfOwn(connector: Connector, readers: ReadonlyMap<string, Reader>): ImportKind | null {
  const own = ownExport(connector);
  if (own === null) return null;
  const reads = ownReads(connector);
  if (reads.length === 0) return null;
  const reader = readers.get(reads[0]!.connector);
  const noun = connector.noun;
  const kind: ImportKind = {
    id: connector.id, name: own.name ?? (onlyExport(connector) ? connector.name : `${connector.name} export`), icon: connectorIcon(connector),
    takes: own.takes ?? `${connector.name} sends a download you ask for`, wait: own.wait ?? null, file: own.file ?? "zip", guide: own.guide, ask: `Whose ${connector.name} is this?`, vendor: connector.vendor,
    whose: () => ({ vendor: connector.vendor, ask: kind.ask }),
    reads, products: [{ id: connector.product, name: connector.name, ...(noun === undefined ? {} : { noun }) }],
    recognise: [...new Set(reads.map((read) => read.members))], leaves: own.leaves ?? [],
    resolve: (members) => refusedAs(async () => {
      const held = heldProducts(kind, members);
      if (held.length === 0) return { products: [] };
      const named = reader?.account === undefined ? { named: [] } : await accountsNamed(members, reader.account);
      if ("refused" in named) return named;
      return { products: held.map((id) => ({ id, named: named.named })) };
    }),
    stamp: async () => null,
    states: (_file, members, anchor) => refusedAs(async () => {
      if (reader?.states === undefined) return { time_ms: null };
      const stated = await reader.states(members, anchor);
      return { time_ms: stated.time_ms ?? null, ...(stated.anchor === undefined ? {} : { anchor: stated.anchor }) };
    }),
    device: async () => null,
  };
  return kind;
}

function onlyExport(connector: Connector): boolean {
  return connector.sources.every((source) => roadsOf(source).every((road) => road === "upload"));
}

const made = new WeakMap<readonly Connector[], WeakMap<readonly Reader[], readonly ImportKind[]>>();

export function importKinds(connectors: readonly Connector[], readers: readonly Reader[]): readonly ImportKind[] {
  let byReaders = made.get(connectors);
  if (byReaders === undefined) made.set(connectors, byReaders = new WeakMap());
  let kinds = byReaders.get(readers);
  if (kinds === undefined) {
    const named = new Map(readers.map((reader) => [reader.name, reader]));
    const several = IMPORTS.flatMap((declared) => kindOfImport(declared, connectors) ?? []);
    const own = sortedBy(connectors.flatMap((connector) => kindOfOwn(connector, named) ?? []));
    byReaders.set(readers, kinds = [...several, ...own]);
  }
  return kinds;
}

export function importKind(kinds: readonly ImportKind[], id: string): ImportKind | undefined {
  return kinds.find((kind) => kind.id === id);
}

export function isOfKind(kind: Pick<ImportKind, "recognise">, names: Iterable<string>): boolean {
  for (const name of names) if (kind.recognise.some((pattern) => matches(pattern, name))) return true;
  return false;
}

export interface HandedFile {
  readonly name: string;
  readonly blob: string;
  readonly size: number;
}

export async function recognisedKind(kinds: readonly ImportKind[], file: HandedFile, files: BlobReader): Promise<ImportKind | null> {
  const delivery: Delivery = { id: file.blob, source: "", sealed_ms: 0, stated_ms: 0, facts: {}, files: [{ path: file.name, blob: file.blob, size: file.size }] };
  const { found: names } = await listed(delivery, files, async (members) => members.map((member) => member.name));
  const named = mostClaimed(kinds, names, (pattern) => !onlyAType(pattern));
  if (named !== null) return named;
  if (names.some((name) => kinds.some((kind) => kind.leaves.some((pattern) => matches(pattern, name))))) return null;
  return names.length === 1 ? mostClaimed(kinds, names, onlyAType) : null;
}

const onlyAType = (pattern: string): boolean => /^\*\.[^*/]+$/u.test(pattern);

function mostClaimed(kinds: readonly ImportKind[], names: readonly string[], counted: (pattern: string) => boolean): ImportKind | null {
  let best: { kind: ImportKind; claimed: number } | null = null;
  for (const kind of kinds) {
    const patterns = kind.recognise.filter(counted);
    const claimed = names.filter((name) => patterns.some((pattern) => matches(pattern, name))).length;
    if (claimed > (best?.claimed ?? 0)) best = { kind, claimed };
  }
  return best?.kind ?? null;
}

export function leftOnly(kind: Pick<ImportKind, "recognise" | "leaves">, names: readonly string[]): boolean {
  return !isOfKind(kind, names) && isOfKind({ recognise: kind.leaves }, names);
}

export function listingHash(kind: ImportKind): string {
  return createHash("sha256").update(JSON.stringify({ reads: kind.reads, products: kind.products })).digest("hex").slice(0, 16);
}

export function sourceOf(read: Pick<ImportRead, "product" | "copy">, account: string, unit: string | null = null): string {
  if (read.copy !== UNIT) return `${read.product}:${account}:${read.copy}`;
  if (unit === null) throw new TypeError(`a row of ${read.product} feeds the unit of the device its import is of, and none was given`);
  return `${read.product}:${account}:${unit}`;
}

export const UNIT = "<unit>";

export interface ListedProduct {
  readonly id: string;
  readonly name: string;
  readonly reads: boolean;
  readonly files: readonly string[];
  readonly unclaimed: number;
  readonly activity: "json" | "html" | null;
}

export interface ListedRoute extends ImportRead {
  readonly files: readonly string[];
}

export interface Listing {
  readonly kind: string;
  readonly files: readonly { readonly path: string; readonly bytes: number; readonly refused?: string; readonly unclaimed?: number }[];
  readonly products: readonly ListedProduct[];
  readonly routes: readonly ListedRoute[];
}

const slug = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");

export async function listImport<T = undefined>(
  kind: ImportKind, delivery: Delivery, files: BlobReader,
  options: { present?: (path: string) => boolean; progress?: (listed: number) => void; look?: (members: readonly Member[]) => Promise<T> } = {},
): Promise<{ listing: Listing; found: T }> {
  const present = options.present ?? (() => true);
  const kept = delivery.files.filter((file) => present(file.path));
  const look = options.look ?? (async () => undefined as T);
  const { files: listedFiles, found } = await listed({ ...delivery, files: kept }, files, look, options.progress);
  const byFile = new Map<string, number>();
  const refused = new Map<string, string>();
  for (const file of listedFiles) {
    const at = archiveFile(file.path);
    byFile.set(at, (byFile.get(at) ?? 0) + file.bytes);
    if (file.refused !== undefined) refused.set(at, file.refused);
  }
  const products = new Map<string, { id: string; name: string; reads: boolean; files: Set<string>; unclaimed: number; activity: "json" | "html" | null }>();
  const routes = new Map<ImportRead, Set<string>>();
  const unclaimed = new Map<string, number>();
  const product = (id: string, name: string, reads: boolean) => {
    const held = products.get(id) ?? { id, name, reads, files: new Set<string>(), unclaimed: 0, activity: null as "json" | "html" | null };
    products.set(id, held);
    return held;
  };
  for (const file of listedFiles) {
    for (const member of file.members) {
      const at = archiveFile(file.path);
      const claiming = kind.reads.filter((read) => matches(read.members, member.name));
      for (const read of claiming) routes.set(read, (routes.get(read) ?? new Set<string>()).add(at));
      const under = memberOf({ kind: kind.id, ...(kind.root === undefined ? {} : { root: kind.root }) }, member.name);
      if (kind.root === undefined) {
        for (const read of claiming) product(read.of, kind.products.find((each) => each.id === read.of)?.name ?? read.of, true).files.add(at);
        continue;
      }
      if (under === null) continue;
      const declared = kind.products.find((each) => each.folder === under.folder);
      const held = product(declared?.id ?? slug(under.folder), declared?.name ?? under.folder, kind.reads.some((read) => read.folder === under.folder));
      held.files.add(at);
      if (/(?:^|\/)MyActivity\.json$/u.test(under.path)) held.activity = "json";
      else if (held.activity === null && /(?:^|\/)MyActivity\.html$/u.test(under.path)) held.activity = "html";
      if (held.reads && claiming.length === 0 && !keptText(member.name, member.size)) {
        held.unclaimed++;
        unclaimed.set(at, (unclaimed.get(at) ?? 0) + 1);
      }
    }
  }
  const listing: Listing = {
    kind: kind.id,
    files: [...byFile].sort(([left], [right]) => left.localeCompare(right)).map(([path, bytes]) => ({
      path, bytes, ...(refused.has(path) ? { refused: refused.get(path)! } : {}), ...(unclaimed.has(path) ? { unclaimed: unclaimed.get(path)! } : {}),
    })),
    products: sortedBy(products.values()).map((held) => ({ ...held, files: [...held.files].sort() })),
    routes: kind.reads.filter((read) => routes.has(read)).map((read) => ({ ...read, files: [...routes.get(read)!].sort() })),
  };
  return { listing, found };
}
