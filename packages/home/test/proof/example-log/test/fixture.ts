import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { feeds, rfc3339, type Files, type ItemOf, type Scenario } from "@lifestreamprotocol/connect/sdk";

export const SOURCE = "example-log:local:macbook-pro-0001";

export const ENTRIES = [
  { id: "l-1", at: "2026-09-28T10:00:00.000Z", title: "Synthetic entry one", text: "the first line" },
  { id: "l-2", at: "2026-09-28T10:10:00.000Z", text: "the second line" },
];

export const fixture = (folder: string) => {
  const text = `${ENTRIES.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  writeFileSync(join(folder, "entries.ndjson"), text);
  const whole = text.slice(0, Math.floor(Buffer.byteLength(text) / 2)).split("\n").length - 1;
  const heads = ENTRIES.map((entry) => `entry ${entry.id}`);
  return { source: SOURCE, facts: { fetched_at: "2026-09-28T11:00:00.000Z", ...feeds(SOURCE, "example-log") }, files: { "entries.ndjson": { alone: heads, prefix: heads.slice(0, whole) } } };
};

export const fixtures = { "example-log": fixture };
export const settings = { file: "/nonexistent/example-log.ndjson", unit: "macbook-pro-0001" };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const entryLine = (scenario: Scenario, n: number, edited = false) =>
  JSON.stringify({ id: `l-${n}`, at: rfc3339(scenario.start_ms + (n < scenario.old ? -DAY : 0) + n * MINUTE), text: edited ? `synthetic entry ${n}, edited` : `synthetic entry ${n}` });

export const files = (scenario: Scenario): Files => ({
  "example-log.ndjson": `${[
    ...Array.from({ length: scenario.items }, (_, n) => n).filter((n) => !scenario.removed.includes(n)).map((n) => entryLine(scenario, n)),
    ...scenario.edited.map((n) => entryLine(scenario, n, true)),
  ].join("\n")}\n`,
});

export const item: ItemOf = ({ key }) => {
  const n = /^l-(\d+)$/u.exec(key)?.[1];
  return n === undefined ? null : Number(n);
};
