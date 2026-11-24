import { describe, expect, it } from "vitest";
import type { CalendarAdapter, CalendarEvent, Reminder } from "@lifestreamprotocol/core";
import { AT_MS, recordOf, statedOf } from "../test/stated.js";
import { calendarFaults } from "./faults.js";

const MIDNIGHT = Date.UTC(2026, 10, 2);
const EVENT: CalendarEvent = {
  title: "Synthetic review", start_ms: AT_MS, end_ms: AT_MS + 3_600_000, date_only: false, zone: "Europe/London", status: "CONFIRMED",
  organizer: null, attendees: 2, response: "ACCEPTED", video: false, location: null, repeats: null,
};
const REMINDER: Reminder = { title: "Synthetic errand", due: { start_ms: MIDNIGHT, end_ms: null, date_only: true }, completed: false, completed_ms: null, list: null, flagged: false };
const HELD: Partial<CalendarAdapter> = { keys: "held" };

const event = (changed: Partial<CalendarEvent>, key = "event-1:calendar-1") => calendarFaults(statedOf(HELD, "event", { value: { ...EVENT, ...changed }, modified: 1 }, recordOf(key)));
const reminder = (due: Reminder["due"]) => calendarFaults(statedOf(HELD, "reminder", { value: { ...REMINDER, due }, modified: 1 }, recordOf("reminder-1:list-1")));

describe("calendarFaults", () => {
  it("passes an event and a reminder that keep every rule", () => {
    expect(event({})).toEqual([]);
    expect(event({ date_only: true, start_ms: MIDNIGHT, end_ms: MIDNIGHT + 86_400_000, zone: null, status: null, response: "NEEDS-ACTION" })).toEqual([]);
    expect(reminder(REMINDER.due)).toEqual([]);
    expect(calendarFaults(statedOf<CalendarAdapter>({ keys: "name" }, "event", { value: EVENT, modified: 1 }, recordOf("event-1")))).toEqual([]);
  });

  it("names each rule an event breaks", () => {
    expect(event({ zone: "Europe/Londn" })).toEqual(["`zone` is an IANA zone name, such as `Europe/London`: `Europe/Londn` is none"]);
    expect(event({ status: "cancelled" })).toEqual(["`status` is iCalendar's word in upper case, such as `CANCELLED`: `cancelled` is none"]);
    expect(event({ response: "accepted" })).toEqual(["`response` is iCalendar's word in upper case, such as `ACCEPTED`: `accepted` is none"]);
    expect(event({ end_ms: AT_MS - 1 })).toEqual([`\`end_ms\` is at or after \`start_ms\`: ${AT_MS - 1} is before ${AT_MS}`]);
    expect(event({ date_only: true, end_ms: null })).toEqual([`a date-only \`start_ms\` is its date's midnight in UTC: ${AT_MS} is 2026-11-02T09:30:00.000Z`]);
    expect(event({}, "event-1")).toEqual(["with `keys: \"held\"` a record's key is `<name>:<holder>`, the holder holding no `:`: `event-1` names no event"]);
  });

  it("names each rule a reminder's due breaks", () => {
    expect(reminder({ start_ms: MIDNIGHT + 1, end_ms: null, date_only: true })).toEqual([`a date-only \`due.start_ms\` is its date's midnight in UTC: ${MIDNIGHT + 1} is 2026-11-02T00:00:00.001Z`]);
    expect(reminder({ start_ms: AT_MS, end_ms: AT_MS - 60_000, date_only: false })).toEqual([`\`due.end_ms\` is at or after \`start_ms\`: ${AT_MS - 60_000} is before ${AT_MS}`]);
  });
});
