import type { CalendarAdapter, CalendarCopy, CalendarEvent, Reminder } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";
import { heldName, knownZone, midnightOf } from "./family.js";

const ICALENDAR_WORD = /^[A-Z]+(?:-[A-Z]+)*$/u;

interface Times {
  readonly start_ms: number;
  readonly end_ms: number | null;
  readonly date_only: boolean;
}

export function calendarFaults({ adapter, member, record, value }: Stated<CalendarAdapter>): string[] {
  if ((member !== "event" && member !== "reminder") || value === null || typeof value !== "object") return [];
  const faults: string[] = [];
  const key = record?.version.key;
  if (adapter.keys === "held" && key !== undefined && heldName(key) === "") {
    faults.push(`with \`keys: "held"\` a record's key is \`<name>:<holder>\`, the holder holding no \`:\`: ${quoted(key)} names no event`);
  }
  if (member === "reminder") {
    const due = (value as CalendarCopy<Reminder>).value?.due;
    return [...faults, ...(due === null || due === undefined ? [] : timeFaults(due, "`due."))];
  }
  const event = (value as CalendarCopy<CalendarEvent>).value;
  if (event === null || typeof event !== "object") return faults;
  faults.push(...timeFaults(event, "`"));
  if (event.zone !== null && (typeof event.zone !== "string" || knownZone(event.zone) === null)) {
    faults.push(`\`zone\` is an IANA zone name, such as \`Europe/London\`: ${quoted(event.zone)} is none`);
  }
  for (const [name, word] of [["status", event.status], ["response", event.response]] as const) {
    if (word !== null && (typeof word !== "string" || !ICALENDAR_WORD.test(word))) {
      faults.push(`\`${name}\` is iCalendar's word in upper case, such as \`${name === "status" ? "CANCELLED" : "ACCEPTED"}\`: ${quoted(word)} is none`);
    }
  }
  return faults;
}

function timeFaults(time: Times, at: string): string[] {
  const faults: string[] = [];
  if (time.end_ms !== null && time.end_ms < time.start_ms) faults.push(`${at}end_ms\` is at or after \`start_ms\`: ${time.end_ms} is before ${time.start_ms}`);
  if (time.date_only && midnightOf(time.start_ms) !== time.start_ms) {
    faults.push(`a date-only ${at}start_ms\` is its date's midnight in UTC: ${time.start_ms} is ${Number.isFinite(time.start_ms) ? new Date(time.start_ms).toISOString() : "no time"}`);
  }
  return faults;
}
