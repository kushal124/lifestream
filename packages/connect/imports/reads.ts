import { roadsOf, type Connector, type DeclaredSource, type ImportProductOf } from "../declaration.js";
import { FOLDERS } from "../google/my-activity/reader.js";
import type { Import } from "./index.js";

export interface ImportRead {
  readonly of: string;
  readonly members: string;
  readonly folder?: string;
  readonly product: string;
  readonly copy: string;
  readonly connector: string;
}

export interface ImportProduct {
  readonly id: string;
  readonly name: string;
  readonly folder?: string;
  readonly noun?: readonly [string, string];
}

function readerOf(connector: Connector, source: DeclaredSource): string {
  const acquired = new Set(connector.acquirers ?? []);
  return (source.feeders ?? []).find((feeder) => !acquired.has(feeder)) ?? source.read;
}

export function kindReads(kind: Import, connector: Connector, product: ImportProductOf): ImportRead[] {
  if (kind.root === undefined) return uploadReads(connector, product.id);
  const under = new RegExp(`^${literal(kind.root ?? "")}([^/*]+)/(.+)$`, "u");
  return (connector.export?.recognise ?? []).map((pattern): ImportRead => {
    const [, folder, members] = kind.root === undefined ? [] : under.exec(pattern) ?? [];
    if (folder === undefined || members === undefined) throw new TypeError(`connector ${connector.id} recognises ${pattern}, which is no ${kind.name} product's folder`);
    const source = connector.sources.find((each) => {
      const named = each.id.split(":")[0]!;
      return roadsOf(each).includes("upload") && (named === "<product>" || vendorIn(connector, named) === kind.accounts);
    });
    if (source === undefined) throw new TypeError(`connector ${connector.id} recognises ${pattern}, but none of its sources on the upload road is an account of ${kind.name}'s company`);
    const [named, , copy] = source.id.split(":") as [string, string, string];
    return { of: product.id, members: pattern, folder, product: named === "<product>" ? activityProduct(members) : named, copy, connector: readerOf(connector, source) };
  });
}

export function ownReads(connector: Connector): ImportRead[] {
  return uploadReads(connector, connector.product);
}

function uploadReads(connector: Connector, of: string): ImportRead[] {
  const source = connector.sources.find((each) => roadsOf(each).includes("upload"));
  if (source === undefined) throw new TypeError(`connector ${connector.id} declares an export, but no source on the upload road for it to feed`);
  const [product, , copy] = source.id.split(":") as [string, string, string];
  return (connector.export?.recognise ?? []).map((members) => ({ of, members, product, copy, connector: readerOf(connector, source) }));
}

export function patternsUnder(connector: Connector, root: string): boolean {
  const patterns = connector.export?.recognise ?? [];
  return patterns.length > 0 && patterns.every((pattern) => pattern.startsWith(root));
}

function vendorIn(connector: Connector, product: string): string | undefined {
  return product === connector.product ? connector.vendor : connector.products?.[product]?.vendor;
}

const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

function activityProduct(members: string): string {
  const folder = members.split("/")[0];
  const found = Object.entries(FOLDERS).find(([, folders]) => folders.includes(folder ?? ""));
  if (found === undefined) throw new TypeError(`no My Activity product reads the folder ${folder ?? members}`);
  return found[0];
}

export function memberOf(kind: Pick<Import, "kind" | "root">, name: string): { folder: string; path: string } | null {
  if (kind.root === undefined) return null;
  let under = members.get(kind.kind);
  if (under === undefined) members.set(kind.kind, under = new RegExp(`(?:^|/)${literal(kind.root)}([^/]+)/(.+)$`, "iu"));
  const match = under.exec(name);
  return match === null ? null : { folder: match[1]!, path: match[2]! };
}
const members = new Map<string, RegExp>();
