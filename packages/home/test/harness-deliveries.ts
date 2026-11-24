import { openHomeFolder, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { nudges } from "../nudges.js";
import { basicInstant, inboxLane, openSealing } from "../inbox.js";
import { keeperOf } from "./harness-root.js";

export interface Planned {
  source: string;
  fetched_ms: number;
  rows: JsonObject[];
  carried?: Record<string, Buffer>;
  facts?: JsonObject;
}

export async function ship(at: string | HomeFolder, delivery: Planned, nudge: boolean | { machineDir: string } = true): Promise<string> {
  const folder = typeof at === "string" ? openHomeFolder(at) : at;
  const { root } = folder;
  for (const [hex, bytes] of Object.entries(delivery.carried ?? {})) {
    await inboxLane(folder, delivery.source).store(hex, (async function* () { yield bytes; })(), bytes.length);
  }
  const fetched_at = new Date(delivery.fetched_ms).toISOString();
  const name = basicInstant(fetched_at);
  const sealing = openSealing(folder, { source: delivery.source, name, feeder: "fake-rows", fetched_at });
  if (delivery.rows.length > 0) {
    const text = `${delivery.rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    await sealing.write("rows.ndjson", (async function* () { yield Buffer.from(text); })());
  }
  sealing.seal(delivery.facts ?? {});
  const id = `${delivery.source}/${name}`;
  if (nudge !== false) keeperOf(root, nudges, nudge === true ? undefined : nudge.machineDir).owe(id);
  return id;
}

export async function shipFiles(root: string, source: string, fetched_ms: number, files: Record<string, Buffer>, facts: JsonObject = {}): Promise<string> {
  const fetched_at = new Date(fetched_ms).toISOString();
  const name = basicInstant(fetched_at);
  const sealing = openSealing(openHomeFolder(root), { source, name, feeder: "fake-rows", fetched_at });
  for (const [path, bytes] of Object.entries(files)) await sealing.write(path, (async function* () { yield bytes; })());
  sealing.seal(facts);
  keeperOf(root, nudges).owe(`${source}/${name}`);
  return `${source}/${name}`;
}
