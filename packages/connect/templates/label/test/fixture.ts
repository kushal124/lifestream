import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { feeds } from "@lifestreamprotocol/connect/sdk";
import type { Fixture } from "../../../test/drive.js";
import { monthLine, MONTHS_FILE } from "../reader.js";

export const UNIT = "macbook-pro-0001";
export const SOURCE = `example:local:${UNIT}`;

export const fixture: Fixture = (folder) => {
  writeFileSync(join(folder, MONTHS_FILE), [monthLine("2026-08", { notes: 2 }), monthLine("2026-09", { notes: 1 })].map((line) => `${line}\n`).join(""));
  return {
    source: SOURCE, facts: { fetched_at: "2026-10-01T00:00:00.000Z", ...feeds(SOURCE, "example-label") },
    files: { [MONTHS_FILE]: { alone: ["month 2026-08", "month 2026-09"], prefix: ["month 2026-08"] } },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = { "example-label": fixture };
