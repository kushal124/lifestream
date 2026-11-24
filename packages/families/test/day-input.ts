import { digest, type DaySettings, type ExtractRow, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { tableUnits } from "../days.js";
import type { DayInput, Family } from "../family.js";
import { buildLabels, labelsFrom, type DayLabels } from "../shared/labels.js";

export interface Content { unit: string; content: unknown; start_ms: number | null; end_ms: number | null }

export function dayInput(family: Family, day: string, contents: readonly Content[], settings: DaySettings, options: { sources?: ReadonlyMap<string, SourceRow>; labels?: DayLabels } = {}): DayInput {
  const extracts = contents.map((each, seq): ExtractRow => {
    const row: ExtractRow = {
      family: family.name, unit: each.unit, reading: digest(each.content as Json), code: family.code, content: each.content as Json,
      start_ms: each.start_ms, end_ms: each.end_ms, days: [], seq,
    };
    return { ...row, days: family.days(row, settings) };
  }).filter((row) => row.days.includes(day)).sort((left, right) => (left.unit < right.unit ? -1 : 1));
  const labels = labelsFrom(tableUnits(options.labels ?? buildLabels({ people: [], contacts: [], places: [] })), settings);
  return { day, settings, extracts, enrichments: new Map(), labels, sources: options.sources ?? new Map(), device: (unit) => unit };
}
