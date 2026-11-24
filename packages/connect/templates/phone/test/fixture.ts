import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bundle, entry, INSTALL, UNIT, type SyntheticBundle } from "../../../ios-app/phone.test-support.js";
import type { Fixture } from "../../../test/drive.js";
import { DOMAIN } from "../reader.js";

export const SOURCE = `example:local:${UNIT}`;

export function written(sequence: number, written_at: string, text: string, kind = "note"): object {
  return entry(DOMAIN, kind, sequence, new Date(Date.parse(written_at) + 60_000).toISOString(), { text, written_at });
}

export function shipment(name: string, created_at: string, entries: (object | string)[]): SyntheticBundle {
  return bundle(name, created_at, { [DOMAIN]: entries });
}

export const FIRST = (): SyntheticBundle => shipment("first", "2026-10-03T09:00:00.250+05:30", [
  written(1, "2026-10-03T02:10:00.000Z", "Synthetic phone note one."),
  written(2, "2026-10-03T02:20:00.000Z", "Synthetic phone note two."),
]);

export const fixture: Fixture = (folder) => {
  const made = FIRST();
  mkdirSync(join(folder, "bundle"));
  for (const member of made.members) writeFileSync(join(folder, member.name.startsWith("blobs/") ? member.name : `bundle/${member.name}`), member.bytes);
  return {
    source: SOURCE, lane: `phone:${UNIT}`, facts: { bundle_id: made.bundle_id, created_at: made.created_at },
    files: Object.fromEntries(made.members.map((member) => [`bundle/${member.name}`, "trust" as const])),
    heads: [`note ${INSTALL}:1`, `note ${INSTALL}:2`],
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-phone": fixture };
