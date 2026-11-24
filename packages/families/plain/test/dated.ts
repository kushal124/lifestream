import { addDays, instant, type DaySettings, type JsonObject, type LineAdapter, type ReaderOutput } from "@lifestreamprotocol/core";
import type { DayDocument } from "../../days.js";
import type { Given } from "../../family.js";
import { buildLabels } from "../../shared/labels.js";
import { TestHome } from "../../test/drive.js";
import { plainFamily } from "../family.js";

export const LOG = "example-log:local:test";
export const DATE = "2026-09-03";
export const ZONES: readonly DaySettings[] = [
  { zone: "America/Los_Angeles", day_start_hour: 4 },
  { zone: "Pacific/Kiritimati", day_start_hour: 4 },
  { zone: "UTC", day_start_hour: 4 },
];

export const lineAdapter: LineAdapter = {
  version: "1",
  kinds: ["line"],
  line({ version }) {
    const content = version.content as JsonObject;
    return { text: content.words as string, ...(typeof content.title === "string" ? { title: content.title } : {}) };
  },
};

export const given: Given<LineAdapter> = { product: "example-log", name: "Example log", vendor: "example", type: "notes", adapter: lineAdapter };

export const ROWS: readonly ReaderOutput[] = [
  { kind: "line", key: "film", content: { words: "a synthetic film", title: "Watched" }, time: instant(DATE, "date") },
  { kind: "line", key: "noon", content: { words: "a timed line" }, time: { start_ms: Date.UTC(2026, 8, 3, 12, 0), precision: "ms" } },
];

export function datedDays(): { zone: string; days: Record<string, DayDocument>; text: Record<string, string> }[] {
  const labels = buildLabels({ people: [], contacts: [], places: [] });
  return ZONES.map((settings) => {
    const home = new TestHome("families-plain-dated-", { families: [plainFamily([given])], settings });
    try {
      home.deliver(LOG, Date.UTC(2026, 8, 4), ROWS);
      const rendered = [-1, 0, 1].map((step) => addDays(DATE, step)).map((day) => [day, home.render(day, labels)] as const);
      return {
        zone: settings.zone,
        days: Object.fromEntries(rendered.map(([day, files]) => [day, JSON.parse(files.json) as DayDocument])),
        text: Object.fromEntries(rendered.map(([day, files]) => [day, files.txt])),
      };
    } finally {
      home.close();
    }
  });
}
