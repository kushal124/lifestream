import type { Tx } from "@lifestreamprotocol/core";
import { ANCHOR } from "./imports.js";

const SPOTIFY_EXPORT = "spotify-export";

export function upgradeImports(tx: Tx): string[] {
  const meta = tx.tables.meta;
  const moved: string[] = [];
  for (const source of tx.tables.sources.list()) {
    const { archive, ...options } = source.options as Record<string, unknown>;
    if (archive === undefined) continue;
    tx.tables.sources.restate(source.id, { ...options, import: archive } as never);
    moved.push(`source ${source.id}`);
  }
  const cursor = tx.tables.polls.cursor(SPOTIFY_EXPORT);
  if (cursor !== undefined && meta.get(`${ANCHOR}${cursor.source}`) === undefined) {
    const first = (JSON.parse(cursor.state) as { first?: unknown }).first;
    if (typeof first === "string") {
      meta.set(`${ANCHOR}${cursor.source}`, first);
      moved.push(`anchor ${cursor.source}`);
    }
  }
  return moved;
}
