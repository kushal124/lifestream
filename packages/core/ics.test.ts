import { describe, expect, it } from "vitest";
import { IcsError, isDate, parseCalendar, properties, readComponent, readEvent, readProperty, single, timedText, timeValue, unescapeText, type IcsProperty, type IcsTime } from "./ics.js";

const ZONE = [
  "BEGIN:VTIMEZONE", "TZID:America/New_York",
  "BEGIN:DAYLIGHT", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "TZNAME:EDT", "DTSTART:19700308T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "END:DAYLIGHT",
  "BEGIN:STANDARD", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "TZNAME:EST", "DTSTART:19701101T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "END:STANDARD",
  "END:VTIMEZONE",
];

const EVENT = [
  "BEGIN:VEVENT", "UID:event-1@example.com",
  "DTSTART;TZID=America/New_York:20260706T090000", "DTEND;TZID=America/New_York:20260706T100000",
  "SUMMARY:A synthetic planning meeting whose title runs past the seventy-five", "  octet fold — ünïcödé",
  "DESCRIPTION:Line one\\nLine two\\; done\\, and a backslash \\\\ here",
  "RRULE:FREQ=WEEKLY;BYDAY=MO", "RRULE:FREQ=MONTHLY;BYMONTHDAY=1",
  "RDATE;VALUE=DATE:20260801,20260802", "EXDATE;TZID=America/New_York:20260713T090000", "EXDATE:20260720T130000Z",
  "ORGANIZER;CN=\"Person ^'B^', Lead; Room: 1\":mailto:person-b@example.com",
  "ATTENDEE;CN=Person C;DELEGATED-TO=\"mailto:person-d@example.com\",\"mailto:person-e@example.com\";PARTSTAT=ACCEPTED:mailto:person-c@example.com",
  "X-GOOGLE-CONFERENCE:https://meet.example.com/abc",
  "X-APPLE-NOISE:1",
  "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT15M", "END:VALARM",
  "END:VEVENT",
];

const ALL_DAY = ["BEGIN:VEVENT", "UID:event-2@example.com", "DTSTART;VALUE=DATE:20260710", "DTEND;VALUE=DATE:20260713", "SUMMARY:A synthetic trip", "END:VEVENT"];

function calendar(eol: string, final: string, ...components: string[][]): Buffer {
  return Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", ...ZONE, ...components.flat(), "END:VCALENDAR"].join(eol) + final);
}

const byName = (props: IcsProperty[], name: string) => props.filter((property) => property.name === name);

function thrown(read: () => unknown): Error {
  try {
    read();
  } catch (error) {
    return error as Error;
  }
  throw new Error("nothing was thrown");
}

describe("the iCalendar reader: each of these is impossible", () => {
  it("a folded line read as two properties, or a VEVENT's text other than its bytes", () => {
    const bytes = calendar("\r\n", "", EVENT, ALL_DAY);
    const parsed = parseCalendar(bytes, "cal.ics");
    expect(parsed.events.map((event) => event.name)).toEqual(["VEVENT", "VEVENT"]);
    const event = parsed.events[0]!;
    expect(single(event, "SUMMARY", "event")!.value).toBe("A synthetic planning meeting whose title runs past the seventy-five octet fold — ünïcödé");
    expect(bytes.subarray(event.startByte, event.endByte).toString("utf8")).toBe(event.content);
    expect(event.content).toBe(`${EVENT.join("\r\n")}\r\n`);
    expect(readEvent("BEGIN:VEVENT\r\nSUMMARY:one\r\n\ttwo\r\nEND:VEVENT\r\n")!.map((property) => property.value)).toEqual(["onetwo"]);
    expect(thrown(() => readComponent(" BEGIN:VEVENT\r\n", "x")).message).toContain("does not begin with a BEGIN line");
  });

  it("a local time placed by anything but the file's VTIMEZONE, or a gap or fold read as an instant", () => {
    const parsed = parseCalendar(calendar("\r\n", "\r\n", EVENT), "cal.ics");
    const start = timeValue(single(parsed.events[0]!, "DTSTART", "e")!, "DTSTART");
    expect(start).toEqual({ form: "local", local: { year: 2026, month: 7, day: 6, hour: 9, minute: 0, second: 0 }, tzid: "America/New_York" });
    expect(timedText(start as Exclude<typeof start, { form: "date" }>, parsed.zones, "DTSTART")).toBe("2026-07-06T09:00:00-04:00");
    const winter = timeValue(readProperty("DTSTART;TZID=America/New_York:20261201T090000", "w"), "w");
    expect(timedText(winter as Exclude<typeof winter, { form: "date" }>, parsed.zones, "w")).toBe("2026-12-01T09:00:00-05:00");
    const at = (text: string) => () => {
      const value = timeValue(readProperty(`DTSTART;TZID=America/New_York:${text}`, "t"), "t");
      return timedText(value as Exclude<typeof value, { form: "date" }>, parsed.zones, "t");
    };
    expect(thrown(at("20260308T023000")).message).toContain("in a gap");
    expect(thrown(at("20261101T013000")).message).toContain("ambiguous in a fold");
    expect(thrown(at("20050715T090000")).message).toContain("before 2007");
    const elsewhere = timeValue(readProperty("DTSTART;TZID=Asia/Kolkata:20260706T090000", "k"), "k");
    expect(thrown(() => timedText(elsewhere as Exclude<typeof elsewhere, { form: "date" }>, parsed.zones, "k")).message).toContain("has no VTIMEZONE in this file");
    expect(timeValue(readProperty("DTSTART:20260706T130000Z", "u"), "u")).toEqual({ form: "utc", text: "2026-07-06T13:00:00Z" });
    expect(thrown(() => timeValue(readProperty("DTSTART:20260706T130000", "f"), "f")).message).toContain("floating local time");
  });

  it("an all-day DATE read as a time, or a DATE with a TZID read at all", () => {
    expect(timeValue(readProperty("DTSTART;VALUE=DATE:20260710", "d"), "d")).toEqual({ form: "date", date: "2026-07-10" });
    expect(timeValue(readProperty("DTSTART;value=date:20260710", "d"), "d")).toEqual({ form: "date", date: "2026-07-10" });
    expect(thrown(() => timeValue(readProperty("DTSTART;VALUE=DATE;TZID=America/New_York:20260710", "d"), "d")).message).toContain("VALUE=DATE carries a TZID");
    expect(thrown(() => timeValue(readProperty("DTSTART;VALUE=DATE:20260231", "d"), "d")).message).toContain("is not a calendar date");
    expect([isDate("2026-02-28"), isDate("2026-02-29"), isDate("20260228")]).toEqual([true, false, false]);
  });

  it("a parameter misread: quoted separators split, RFC 6868 escapes kept, a list lost, a parameter stated twice read", () => {
    const props = readEvent(`${EVENT.join("\r\n")}\r\n`)!;
    expect(byName(props, "ORGANIZER")[0]).toEqual({ name: "ORGANIZER", params: { CN: 'Person "B", Lead; Room: 1' }, value: "mailto:person-b@example.com" });
    expect(byName(props, "ATTENDEE")[0]!.params).toEqual({ CN: "Person C", "DELEGATED-TO": "mailto:person-d@example.com,mailto:person-e@example.com", PARTSTAT: "ACCEPTED" });
    expect(readProperty("ATTENDEE;cn=\"a^nb^^c\":mailto:x@example.com", "p").params).toEqual({ CN: "a\nb^c" });
    expect(thrown(() => readProperty("DTSTART;TZID=A;TZID=B:20260706T090000", "p")).message).toContain("parameter TZID appears twice");
    expect(thrown(() => readProperty("ATTENDEE;CN=\"open:mailto:x@example.com", "p")).message).toContain("no unquoted value separator");
    expect(thrown(() => readProperty("ATTENDEE;CN=\"a\"b:mailto:x@example.com", "p")).message).toContain("characters follow a quoted parameter");
    expect(thrown(() => readProperty("ATTENDEE;CN:mailto:x@example.com", "p")).message).toContain("has no equals sign");
    expect(thrown(() => readProperty("A LINE WITH NO COLON", "p")).message).toContain("a content line has no unquoted value separator");
    expect(thrown(() => readProperty("BAD NAME:value", "p")).message).toContain("malformed property name");
    expect(unescapeText(byName(props, "DESCRIPTION")[0]!.value)).toBe("Line one\nLine two; done, and a backslash \\ here");
    expect(unescapeText("keep \\x as written")).toBe("keep \\x as written");
  });

  it("a break of the other kind ending a line, or a file with no final break refused", () => {
    const crlf = parseCalendar(calendar("\r\n", "", EVENT), "cal.ics");
    for (const [eol, final] of [["\r\n", "\r\n"], ["\n", ""], ["\n", "\n"]] as const) {
      const parsed = parseCalendar(calendar(eol, final, EVENT), "cal.ics");
      expect(properties(parsed.events[0]!), JSON.stringify(eol + final)).toEqual(properties(crlf.events[0]!));
      expect(parsed.events[0]!.content).toBe(`${EVENT.join(eol)}${eol}`);
    }
    const event = readEvent("BEGIN:VEVENT\r\nSUMMARY:one\ntwo\r\nEND:VEVENT\r\n")!;
    expect(event).toEqual([{ name: "SUMMARY", params: {}, value: "one\ntwo" }]);
    expect(thrown(() => parseCalendar(calendar("\r\n", "").subarray(0, -3), "cut.ics")).message).toContain("closes no open component");
    expect(thrown(() => parseCalendar(Buffer.from([0x42, 0xff]), "bad.ics")).message).toContain("is not valid UTF-8");
    expect(thrown(() => parseCalendar(Buffer.from("BEGIN:VEVENT\r\nEND:VEVENT\r\n"), "ev.ics")).message).toContain("does not begin with a BEGIN:VCALENDAR line");
    expect(thrown(() => parseCalendar(Buffer.from(`${calendar("\r\n", "\r\n").toString("utf8")}\r\n`), "blank.ics")).message).toContain("a content line is outside a component");
  });

  it("a nested component's lines read as the event's, an X- property dropped, or a repeated recurrence line or its parameters lost", () => {
    const props = readEvent(`${EVENT.join("\r\n")}\r\n`)!;
    expect(props.map((property) => property.name)).toEqual([
      "UID", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION", "RRULE", "RRULE", "RDATE", "EXDATE", "EXDATE", "ORGANIZER", "ATTENDEE", "X-GOOGLE-CONFERENCE", "X-APPLE-NOISE",
    ]);
    expect(byName(props, "RRULE").map((property) => property.value)).toEqual(["FREQ=WEEKLY;BYDAY=MO", "FREQ=MONTHLY;BYMONTHDAY=1"]);
    expect(byName(props, "RDATE")).toEqual([{ name: "RDATE", params: { VALUE: "DATE" }, value: "20260801,20260802" }]);
    expect(byName(props, "EXDATE")).toEqual([
      { name: "EXDATE", params: { TZID: "America/New_York" }, value: "20260713T090000" },
      { name: "EXDATE", params: {}, value: "20260720T130000Z" },
    ]);
    const instance = readEvent("BEGIN:VEVENT\r\nUID:s@example.com\r\nRECURRENCE-ID;TZID=America/New_York:20260713T090000\r\nEND:VEVENT\r\n")!;
    expect(timeValue(instance[1]!, "RECURRENCE-ID")).toEqual({ form: "local", local: { year: 2026, month: 7, day: 13, hour: 9, minute: 0, second: 0 }, tzid: "America/New_York" });
    const component = readComponent(`${EVENT.join("\r\n")}\r\n`, "e");
    expect(component.children.map((child) => [child.name, properties(child).map((property) => property.name)])).toEqual([["VALARM", ["ACTION", "TRIGGER"]]]);
    expect(thrown(() => single(component, "RRULE", "e")).message).toContain("2 RRULE properties make the value ambiguous");
  });

  it("what does not read thrown as anything but a refusal, or readEvent throwing where its caller shows nothing", () => {
    const error = thrown(() => readProperty("A LINE WITH NO COLON", "cal.ics line 3"));
    expect(error).toBeInstanceOf(IcsError);
    expect((error as unknown as Record<symbol, unknown>)[Symbol.for("lifestream.refused")]).toBe(true);
    expect(error.message).toBe("cal.ics line 3: a content line has no unquoted value separator");
    for (const text of [
      "BEGIN:VEVENT\r\nUID:ev-3\r\n",
      "BEGIN:VEVENT\r\nBEGIN:VALARM\r\nEND:VEVENT\r\n",
      "BEGIN:VEVENT\r\nUID:ev-4\r\nNO COLON HERE\r\nEND:VEVENT\r\n",
      "BEGIN:VTODO\r\nUID:ev-5\r\nEND:VTODO\r\n",
      "UID:ev-6\r\n",
      "",
    ]) {
      expect(readEvent(text), JSON.stringify(text)).toBeNull();
    }
    expect(readEvent("BEGIN:VEVENT\nUID:ev-7\nEND:VEVENT")).toEqual([{ name: "UID", params: {}, value: "ev-7" }]);
  });

  it("an onset rule a real writer states refused or misread, or one no zone can turn by read at all", () => {
    expect(placed(EXCHANGE, "20260701T090000", "20261201T090000", "20260215T090000")).toEqual(["2026-07-01T09:00:00+01:00", "2026-12-01T09:00:00+00:00", "2026-02-15T09:00:00+00:00"]);
    expect(thrown(() => placed(EXCHANGE, "20260329T013000")).message).toContain("in a gap");
    expect(thrown(() => placed(EXCHANGE, "20261025T013000")).message).toContain("ambiguous in a fold");
    expect(placed(APPLE, "20261028T090000", "20260402T090000", "20261102T090000", "20070320T090000")).toEqual([
      "2026-10-28T09:00:00-04:00", "2026-04-02T09:00:00-04:00", "2026-11-02T09:00:00-05:00", "2007-03-20T09:00:00-04:00",
    ]);
    const said = zone("Test/Said", [
      ["DAYLIGHT", "-0500", "-0400", "19700308T020000", "freq=yearly;wkst=su;bymonth=3;byday=SU;bymonthday=8,9,10,11,12,13,14"],
      ["STANDARD", "-0400", "-0500", "19701101T020000", "FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"],
    ]);
    const plus = zone("Test/Plus", [
      ["DAYLIGHT", "-0500", "-0400", "19700308T020000", "FREQ=YEARLY;BYMONTH=3;BYDAY=+2SU"],
      ["STANDARD", "-0400", "-0500", "19701101T020000", "FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=20991231T000000Z"],
    ]);
    for (const stated of [said, plus]) {
      expect(placed(stated, "20260309T090000", "20261102T090000")).toEqual(["2026-03-09T09:00:00-04:00", "2026-11-02T09:00:00-05:00"]);
      expect(thrown(() => placed(stated, "20260308T023000")).message).toContain("in a gap");
    }
    const ended = zone("Test/Ended", [
      ["DAYLIGHT", "-0500", "-0400", "20240310T020000", "FREQ=YEARLY;UNTIL=20250309T070000Z;BYMONTH=3;BYDAY=2SU"],
      ["STANDARD", "-0400", "-0500", "20231105T020000", "FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"],
    ]);
    expect(placed(ended, "20250701T090000", "20260701T090000")).toEqual(["2025-07-01T09:00:00-04:00", "2026-07-01T09:00:00-05:00"]);
    const kept = zone("Test/Kept", [
      ["DAYLIGHT", "+0000", "+0100", "20240331T010000", "FREQ=YEARLY;UNTIL=20250330T010000Z;BYMONTH=3;BYDAY=-1SU"],
      ["STANDARD", "+0100", "+0000", "20241027T020000", "FREQ=YEARLY;UNTIL=20241027T010000Z;BYMONTH=10;BYDAY=-1SU"],
    ]);
    expect(placed(kept, "20241201T090000", "20250701T090000", "20271201T090000", "20300101T090000")).toEqual([
      "2024-12-01T09:00:00+00:00", "2025-07-01T09:00:00+01:00", "2027-12-01T09:00:00+01:00", "2030-01-01T09:00:00+01:00",
    ]);
    const refusal = (rule: string) => thrown(() => zone("Test/Bad", [["STANDARD", "-0400", "-0500", "19701101T020000", rule]])).message;
    expect(refusal("FREQ=MONTHLY;BYDAY=1SU")).toContain("FREQ=MONTHLY is not read");
    expect(refusal("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;BYHOUR=2")).toContain("BYHOUR cannot state a zone's onset");
    expect(refusal("FREQ=YEARLY;BYMONTH=3,11;BYDAY=1SU")).toContain("BYMONTH=3,11 turns the zone in more than one month");
    for (const part of ["COUNT=3", "BYSETPOS=1", "INTERVAL=2"]) {
      expect(refusal(`FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;${part}`), part).toContain(`${part === "INTERVAL=2" ? part : part.split("=")[0]} cannot state a zone's onset; it is read from FREQ=YEARLY, INTERVAL=1, UNTIL, WKST, BYMONTH, BYDAY and BYMONTHDAY`);
    }
    for (const end of ["20991231", "20250309T020000"]) {
      expect(refusal(`FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=${end}`), end).toContain(`UNTIL=${end} is no UTC time; RFC 5545 ends a zone's onset rule at one`);
    }
    expect(refusal("FREQ=YEARLY;BYDAY=-1SU")).toContain("with no BYMONTH");
    expect(refusal("FREQ=YEARLY;BYMONTH=11;BYDAY=6SU")).toContain("BYDAY=6SU is not a list of weekdays");
    expect(refusal("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;WKST=XX")).toContain("WKST=XX is not a weekday");
    expect(refusal("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;UNTIL=2020Z")).toContain("UNTIL: \"2020\" is not YYYYMMDDTHHMMSS");
    expect(refusal("FREQ=YEARLY;BYMONTH=11;BYDAY=1SU;BYMONTH=11")).toContain("the RRULE repeats BYMONTH");
    const fifth = zone("Test/Fifth", [
      ["DAYLIGHT", "+0000", "+0100", "20100201T020000", "FREQ=YEARLY;BYMONTH=2;BYDAY=5SU"],
      ["STANDARD", "+0100", "+0000", "20101001T020000", "FREQ=YEARLY;BYMONTH=10;BYDAY=SU"],
    ]);
    expect(thrown(() => placed(fifth, "20260701T090000")).message).toBe("z.ics VTIMEZONE Test/Fifth DAYLIGHT: the RRULE FREQ=YEARLY;BYMONTH=2;BYDAY=5SU names no day in 2025-02; a zone turns once a year by each rule");
    expect(thrown(() => placed(zone("Test/Weekly", [["STANDARD", "+0100", "+0000", "20101001T020000", "FREQ=YEARLY;BYMONTH=10;BYDAY=SU"]]), "20260701T090000")).message)
      .toContain("names 4 days in 2025-10");
  });
});

const EXCHANGE: string[] = [
  "BEGIN:VTIMEZONE", "TZID:GMT Standard Time",
  "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0000", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=10", "END:STANDARD",
  "BEGIN:DAYLIGHT", "DTSTART:16010101T010000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0100", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=-1SU;BYMONTH=3", "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const APPLE: string[] = zone("America/New_York", [
  ["DAYLIGHT", "-0500", "-0400", "19870405T020000", "FREQ=YEARLY;UNTIL=20060402T070000Z;BYMONTH=4;BYDAY=1SU"],
  ["STANDARD", "-0400", "-0500", "19671029T020000", "FREQ=YEARLY;UNTIL=20061029T060000Z;BYMONTH=10;BYDAY=-1SU"],
  ["DAYLIGHT", "-0500", "-0400", "20070311T020000", "FREQ=YEARLY;BYMONTH=3;BYDAY=2SU"],
  ["STANDARD", "-0400", "-0500", "20071104T020000", "FREQ=YEARLY;BYMONTH=11;BYDAY=1SU"],
]);

function zone(tzid: string, onsets: [kind: string, from: string, to: string, start: string, rule: string][]): string[] {
  const lines = ["BEGIN:VTIMEZONE", `TZID:${tzid}`];
  for (const [kind, from, to, start, rule] of onsets) {
    lines.push(`BEGIN:${kind}`, `DTSTART:${start}`, `TZOFFSETFROM:${from}`, `TZOFFSETTO:${to}`, `RRULE:${rule}`, `END:${kind}`);
  }
  lines.push("END:VTIMEZONE");
  parseCalendar(Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR", ""].join("\r\n")), "z.ics");
  return lines;
}

function placed(zoneLines: string[], ...walls: string[]): string[] {
  const parsed = parseCalendar(Buffer.from(["BEGIN:VCALENDAR", "VERSION:2.0", ...zoneLines, "END:VCALENDAR", ""].join("\r\n")), "z.ics");
  const [tzid] = [...parsed.zones.keys()];
  return walls.map((wall) => timedText(timeValue(readProperty(`DTSTART;TZID=${tzid}:${wall}`, "t"), "t") as Exclude<IcsTime, { form: "date" }>, parsed.zones, "t"));
}
