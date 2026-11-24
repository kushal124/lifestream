import { readFileSync } from "node:fs";
import { feeds, rfc3339, type Acquirer } from "@lifestreamprotocol/connect/sdk";

export interface ExampleLogSettings {
  file?: string;
  lines?: number;
  blank?: boolean;
  unit: string;
  now?: () => number;
}

export function exampleLogAcquirer(settings: ExampleLogSettings): Acquirer {
  const source = `example-log:local:${settings.unit}`;
  const now = settings.now ?? Date.now;
  return {
    name: "example-log",
    source,
    async fetch(state) {
      if (settings.file === undefined) throw new Error("name the log file: lifestream connectors set example-log file <path>");
      const lines = readFileSync(settings.file, "utf8").split("\n").filter((line) => settings.blank === true || line.trim() !== "");
      const from = typeof state?.read === "number" ? state.read : 0;
      const taken = lines.slice(from, from + (settings.lines ?? 500));
      return {
        files: taken.length === 0 ? [] : [{ path: "entries.ndjson", bytes: Buffer.from(`${taken.join("\n")}\n`) }],
        facts: { fetched_at: rfc3339(now()), ...feeds(source, "example-log") }, state: { read: from + taken.length },
      };
    },
  };
}
