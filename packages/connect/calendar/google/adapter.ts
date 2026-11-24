import { ics, instant, isObject, type CalendarAdapter, type InputRecord } from "@lifestreamprotocol/connect/sdk";

const FREQUENCIES: Record<string, string> = {
  SECONDLY: "every second", MINUTELY: "every minute", HOURLY: "hourly", DAILY: "daily", WEEKLY: "weekly", MONTHLY: "monthly", YEARLY: "yearly",
};

export const calendarAdapter: CalendarAdapter = {
  version: "2",
  kinds: ["event"],
  authority: "own",
  keys: "name",
  units: "account",

  event({ source, version }: InputRecord) {
    const content = version.content;
    const vevent = isObject(content) && typeof content.content === "string" ? ics.readEvent(content.content) : null;
    if (vevent === null || version.time === undefined) return null;
    const property = (name: string) => vevent.find((item) => item.name === name);
    const text = (name: string) => {
      const value = property(name)?.value;
      return value === undefined || value === "" ? null : ics.unescapeText(value);
    };
    const time = version.time;
    const date_only = time.precision === "day";
    const start = property("DTSTART");
    const attendees = vevent.filter((item) => item.name === "ATTENDEE");
    const self = source.account.toLowerCase();
    const rule = /(?:^|;)FREQ=([A-Z]+)/iu.exec(property("RRULE")?.value ?? "")?.[1];
    return {
      modified: basicUtc(property("LAST-MODIFIED")?.value) ?? Number.NEGATIVE_INFINITY,
      rank: source.copy === "export" ? 0 : 1,
      value: {
        title: text("SUMMARY") ?? "",
        start_ms: time.start_ms,
        end_ms: time.end_ms ?? null,
        date_only,
        zone: date_only ? null : start?.params.TZID ?? (start?.value.endsWith("Z") === true ? "UTC" : null),
        status: property("STATUS")?.value.toUpperCase() ?? null,
        organizer: partyOf(property("ORGANIZER")),
        attendees: attendees.length,
        response: attendees.find((attendee) => partyOf(attendee)!.address === self)?.params.PARTSTAT?.toUpperCase() ?? null,
        video: property("X-GOOGLE-CONFERENCE") !== undefined || /https:\/\/meet\.google\.com\//u.test(property("DESCRIPTION")?.value ?? ""),
        location: text("LOCATION"),
        repeats: rule === undefined ? null : (FREQUENCIES[rule.toUpperCase()] ?? rule.toLowerCase()),
      },
    };
  },

  words({ version }: InputRecord) {
    const content = version.content;
    const properties = isObject(content) && typeof content.content === "string" ? ics.readEvent(content.content) : null;
    if (properties === null) return null;
    const value = (name: string) => {
      const found = properties.find((item) => item.name === name)?.value;
      return found === undefined ? null : ics.unescapeText(found);
    };
    return {
      title: value("SUMMARY"),
      text: [value("LOCATION"), value("DESCRIPTION")].filter((part) => part !== null).join("\n"),
      who: properties.filter((item) => item.name === "ORGANIZER" || item.name === "ATTENDEE").map((item) => partyOf(item)!.address),
    };
  },
};

function partyOf(property: ics.IcsProperty | undefined): { address: string; name: string | null } | null {
  if (property === undefined) return null;
  return {
    address: ics.unescapeText(property.value.replace(/^mailto:/iu, "")).toLowerCase(),
    name: property.params.CN === undefined ? null : ics.unescapeText(property.params.CN),
  };
}

function basicUtc(value: string | undefined): number | null {
  if (value === undefined || !/^\d{8}T\d{6}Z$/u.test(value)) return null;
  try {
    return instant(value, "ical").start_ms;
  } catch {
    return null;
  }
}
