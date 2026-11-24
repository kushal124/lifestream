import { instant, type DaySummary, type HealthAdapter, type HealthItem, type InstrumentWorkout, type Sample, type Stage } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";
import { COPY_SERIES, SLEEP_STAGES, usageHour } from "./family.js";
import { MEASURE } from "./lines.js";

export function healthFaults({ member, record, value }: Stated<HealthAdapter>): string[] {
  if (member !== "item" || value === null || typeof value !== "object") return [];
  const item = value as HealthItem;
  switch (item.item) {
    case "usage":
      return record === null || usageHour(record.version) !== null ? [] : [`a usage record's time spans exactly one hour: it states ${spanOf(record.version.time)}`];
    case "stage": {
      const { stage } = item as Stage;
      return SLEEP_STAGES.includes(stage) ? [] : [`\`stage\` is one of ${SLEEP_STAGES.map((word) => `\`${word}\``).join(", ")}: ${quoted(stage)} is none`];
    }
    case "sample": {
      const { series } = item as Sample;
      return series === undefined || (Number.isInteger(series) && series >= 0 && series < COPY_SERIES)
        ? []
        : [`\`series\` is a whole number counted from 0 for the finest: ${String(series)} is none`];
    }
    case "day-summary": {
      const { date } = item as DaySummary;
      try {
        instant(date, "date");
        return [];
      } catch {
        return [`\`date\` is the day it sums as \`YYYY-MM-DD\`: ${quoted(date)} is none`];
      }
    }
    case "instrument-workout": {
      const workout = item as InstrumentWorkout;
      return (["distance", "energy"] as const).flatMap((name) => {
        const stated = workout[name];
        return stated === null || stated === undefined || (typeof stated === "string" && MEASURE.test(stated))
          ? []
          : [`\`${name}\` is a number, a space and its unit, such as \`5.2 km\`: ${quoted(stated)} is none`];
      });
    }
    default:
      return [];
  }
}

function spanOf(time: { readonly start_ms: number; readonly end_ms?: number } | undefined): string {
  if (time === undefined) return "no time";
  return time.end_ms === undefined ? `${time.start_ms} with no end` : `${time.start_ms} to ${time.end_ms}`;
}
