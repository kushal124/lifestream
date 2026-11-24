import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonical, digest, type ExtractRow, type Json } from "@lifestreamprotocol/core";
import type { Family, Fed, Given } from "../family.js";

export interface Pin {
  family: string;
  key: { code: string; adapters: Record<string, string> };
  rows: number;
  digest: string;
}

export type PinnedRow = Pick<ExtractRow, "unit" | "reading" | "content" | "start_ms" | "end_ms" | "days">;

export function pin(
  family: Family,
  adapters: Partial<Fed>,
  rows: readonly PinnedRow[],
  options: { file?: string; update?: boolean } = {},
): void {
  const file = options.file ?? fileURLToPath(new URL(`../${family.name}/test/pin.json`, import.meta.url));
  const update = options.update ?? process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
  const now: Pin = { family: family.name, key: keyOf(family, adapters), rows: rows.length, digest: digestOf(rows) };
  const stored = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Pin) : undefined;
  const sameKey = stored !== undefined && canonical(stored.key as unknown as Json) === canonical(now.key as unknown as Json);
  if (sameKey && stored.digest === now.digest) return;
  if (sameKey) {
    throw new Error(
      `the ${family.name} family's output on its test data moved, and neither its code (${now.key.code}) nor an adapter's version did: ` +
      `bump the ${family.name} family's code, or the version of the adapter whose reading changed, then write its pin again (LIFESTREAM_UPDATE_GOLDEN=1)`,
    );
  }
  if (update) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
    return;
  }
  throw new Error(stored === undefined
    ? `the ${family.name} family has no pin at ${file}: run its test with LIFESTREAM_UPDATE_GOLDEN=1 and commit the pin`
    : `the ${family.name} family's pin is stale (its code or an adapter's version moved): run its test with LIFESTREAM_UPDATE_GOLDEN=1 and commit the pin`);
}

function keyOf(family: Family, adapters: Partial<Fed>): Pin["key"] {
  const versions: Record<string, string> = {};
  const named = Object.entries(adapters).flatMap(([name, list]) => (list as readonly Given[]).map((given) => [`${name}/${given.product}`, given.adapter.version] as const));
  for (const [name, version] of named.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
    if (versions[name] !== undefined && versions[name] !== version) throw new TypeError(`two adapters handed as ${name}, at versions ${versions[name]} and ${version}`);
    versions[name] = version;
  }
  return { code: family.code, adapters: versions };
}

function digestOf(rows: readonly PinnedRow[]): string {
  const sorted = [...rows].sort((left, right) => (left.unit < right.unit ? -1 : left.unit > right.unit ? 1 : 0));
  return digest(sorted.map(({ unit, reading, content, start_ms, end_ms, days }) => ({ unit, reading, content, start_ms, end_ms, days })));
}
