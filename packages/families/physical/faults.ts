import type { Activity, Fix, Motion, Report, Visit, Vigilance, Witness } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";
import { agrees, SLACK_MS } from "./phone.js";

const MODES: readonly Activity["mode"][] = ["walk", "cycle", "road_vehicle", "flight"];

export function physicalFaults({ member, record, value }: Stated<Witness>): string[] {
  if (value === null || typeof value !== "object") return [];
  switch (member) {
    case "fix":
    case "motion": {
      const { at_ms } = value as Fix | Motion;
      const time = record?.version.time?.start_ms;
      return record === null || agrees(record.version, at_ms)
        ? []
        : [`a ${member}'s \`at_ms\` is its record's time, within ${SLACK_MS / 60_000} minutes: ${at_ms} is ${time === undefined ? "stated of a record that states no time" : `${Math.round((at_ms - time) / 60_000)} minutes from ${time}`}`];
    }
    case "visit": {
      const visit = value as Visit;
      return visit.end_ms >= visit.start_ms ? [] : [`a visit's \`end_ms\` is at or after its \`start_ms\`: ${visit.end_ms} is before ${visit.start_ms}`];
    }
    case "activity": {
      const activity = value as Activity;
      return [
        ...(activity.end_ms > activity.start_ms ? [] : [`an activity's \`end_ms\` is after its \`start_ms\`: ${activity.end_ms} is not after ${activity.start_ms}`]),
        ...(MODES.includes(activity.mode) ? [] : [`\`mode\` is one of ${MODES.map((mode) => `\`${mode}\``).join(", ")}: ${quoted(activity.mode)} is none`]),
      ];
    }
    case "report":
      return (Array.isArray((value as Report).items) ? (value as Report).items : []).flatMap((item) =>
        typeof item.value === "number" && !(item.scale > 0) ? [`a number answer's \`scale\` is more than 0, the value printed as \`value/scale\`: ${item.id}'s is ${String(item.scale)}`] : []);
    case "vigilance":
      return (Array.isArray((value as Vigilance).trials) ? (value as Vigilance).trials : []).flatMap((trial) =>
        trial.outcome === "response" && !(trial.rt_ms >= 0) ? [`a response's \`rt_ms\` is 0 or more: ${String(trial.rt_ms)} is not`] : []);
    default:
      return [];
  }
}
