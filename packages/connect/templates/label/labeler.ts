import { asJson, feeds } from "@lifestreamprotocol/connect/sdk";
import { versionId } from "@lifestreamprotocol/core";
import type { Labeler } from "../../labeler.js";
import { MONTH, monthLine, MONTHS_FILE, type Month } from "./reader.js";

const NOTE = "note";

export interface ExampleLabelSettings {
  unit: string;
}

export function exampleLabelLabeler(settings: ExampleLabelSettings): Labeler {
  const source = `example:local:${settings.unit}`;
  return {
    name: "example-label",
    source,
    inputs: [{ sources: {}, kinds: [NOTE] }],
    async label(view) {
      const counts = new Map<string, number>();
      for (const each of view.sources()) {
        for (const head of each.id === source ? [] : view.heads(each.id, NOTE)) {
          if (head.start_ms === null) continue;
          const key = new Date(head.start_ms).toISOString().slice(0, 7);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      const held = new Map([...view.heads(source, MONTH)].map((head) => [head.key, head.version]));
      const lines: string[] = [];
      for (const [key, notes] of [...counts].sort()) {
        const content: Month = { notes };
        if (held.get(key) !== versionId(MONTH, key, asJson(content)).id) lines.push(monthLine(key, content));
      }
      for (const key of [...held.keys()].sort()) if (!counts.has(key)) lines.push(monthLine(key, "gone"));
      if (lines.length === 0) return null;
      return { files: [{ path: MONTHS_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }], facts: feeds(source, "example-label") };
    },
  };
}
