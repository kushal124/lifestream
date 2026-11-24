import { describe, expect, it } from "vitest";
import { sourceName, type DaySettings, type ExtractRow, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { calendarFamily, type CalendarEvent } from "./calendar/family.js";
import { callsFamily, type Call } from "./calls/family.js";
import { checkDayFile, DayLineError, renderDay, tableUnits, type DayDocument, type DayReader } from "./days.js";
import { linesOnly, type DayLine, type Family, type NameSpan } from "./family.js";
import { mailFamily, type MailDayContent, type MailEntry } from "./mail/family.js";
import { messagesFamily, messagesUnit, type ChatDay } from "./messages/family.js";
import { printed, type Named } from "./shared/cast.js";
import { buildLabels, labelsFrom } from "./shared/labels.js";
import { cardParts, readCard } from "./shared/people.js";
import { FED } from "./test/fed.js";

const BOOKS = { books: FED.labels };
const messages = messagesFamily(BOOKS)(FED.messages);
const calls = callsFamily({ ...BOOKS, messages: FED.messages })(FED.calls);
const mail = mailFamily(BOOKS)(FED.mail);
const calendar = calendarFamily(BOOKS)(FED.calendar);

const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const DAY = "2026-10-07";
const at = (clock: string) => Date.parse(`${DAY}T${clock}:00Z`);
const BOOK = "apple-contacts:local:iphone-aa01";
const MAIL_SOURCE = "gmail:person-me@example.com:cloud";
const ROSE = "15550000001@s.whatsapp.net";
const WILL = "15550000002@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";

function card(key: string, ...lines: string[]) {
  return readCard({ source: BOOK, key }, 0, cardParts({ type: "contacts.card", card: `BEGIN:VCARD\r\nVERSION:3.0\r\n${lines.map((line) => `${line}\r\n`).join("")}END:VCARD\r\n` })!);
}

const LABELS = buildLabels({
  contacts: [
    card("rose", "FN:Rose", "TEL:+15550000001"),
    card("will", "FN:Will", "TEL:+15550000002"),
    card("ada", "FN:Ada Example", "TEL:+15550000003", "EMAIL:ada@example.com"),
    card("bill", "FN:Bill", "EMAIL:bill@example.com"),
  ],
  people: [{
    record: {
      slug: "person-me", name: "Person Me", full_name: null, show: "name", entity: "person", relationship: null, hidden: false, me: true,
      anchor: { kind: "email", value: "person-me@example.com" }, handles: [], excluded: [], dismissed: [], also_called: [], merged_into: null,
    },
    since: new Map(), me_since: null, merged_since: null,
  }],
  places: [],
});
const labels = labelsFrom(tableUnits(LABELS), SETTINGS);
const idOf = (handle: string) => labels.person(handle)!.id;

function extract(family: Family, unit: string, content: unknown, start_ms: number | null, end_ms: number | null): ExtractRow {
  const row = { family: family.name, unit, reading: `reading-${unit}`, code: family.code, content: content as Json, start_ms, end_ms, days: [] as string[], seq: 0 };
  return { ...row, days: family.days(row, SETTINGS) };
}

const chat = (id: string, said: ChatDay["messages"]): ChatDay => ({ network: "whatsapp", chat: id, day: DAY, messages: said });
const MESSAGES = [
  extract(messages, messagesUnit({ day: DAY, network: "whatsapp", chat: ROSE }), chat(ROSE, [
    { source: "whatsapp:15550000000:iphone-aa01", key: `${ROSE}:R1`, at: at("10:00"), from: { id: ROSE, kind: "jid" }, text: "I will call you about the bill" },
    { source: "whatsapp:15550000000:iphone-aa01", key: `${ROSE}:R2`, at: at("10:05"), from: { id: "me", kind: "me" }, text: "Sure", reply_to: `${ROSE}:R1` },
  ]), at("10:00"), at("10:05")),
  extract(messages, messagesUnit({ day: DAY, network: "whatsapp", chat: GROUP }), chat(GROUP, [
    { source: "whatsapp:15550000000:iphone-aa01", key: `${GROUP}:G1`, at: at("11:00"), from: { id: ROSE, kind: "jid" }, text: "Will you come?" },
    { source: "whatsapp:15550000000:iphone-aa01", key: `${GROUP}:G2`, at: at("11:01"), from: { id: WILL, kind: "jid" }, text: "Yes" },
  ]), at("11:00"), at("11:01")),
];
const CALL: Call = {
  source: "apple-calls:local:iphone-aa01", service: "phone", direction: "incoming", outcome: "connected",
  start_ms: at("12:00"), end_ms: at("12:02"), parties: [{ id: "+15550000002", kind: "phone" }],
};
const CALLS = [extract(calls, "apple:call-1", CALL, CALL.start_ms, CALL.end_ms)];
const entry = (key: string, clock: string, from: MailEntry["from"], to: MailEntry["to"], subject: string): MailEntry => ({
  key, at_ms: at(clock), route: "read", junk: null, draft: false, from, to, subject, attachments: [], invitation: null, body: "See you there", unreadable: null, pack: null,
});
const MAIL: MailDayContent = {
  source: MAIL_SOURCE,
  mails: [
    entry("m1", "13:00", { address: "ada@example.com", name: "Ada Example" }, [{ address: "person-me@example.com", name: null }, { address: "bill@example.com", name: "Bill" }], "Lunch"),
    entry("m2", "13:30", { address: "carol@example.com", name: "carol@example.com" }, [], "Hello"),
  ],
};
const MAILS = [extract(mail, `${MAIL_SOURCE}/${DAY}`, MAIL, at("13:00"), at("13:30"))];
const EVENT: CalendarEvent = {
  source: "google-calendar:person-me@example.com:cloud", key: "event-1", title: "Planning", start_ms: at("15:00"), end_ms: at("16:00"), date_only: false,
  zone: "UTC", status: "CONFIRMED", organizer: { address: "ada@example.com", name: "A. Example" }, attendees: 2, response: null, video: false, location: null, repeats: null,
};
const EVENTS = [extract(calendar, "google-calendar:person-me@example.com:event-1", EVENT, EVENT.start_ms, EVENT.end_ms)];

function reader(byFamily: ReadonlyMap<string, readonly ExtractRow[]>): DayReader {
  const sources: SourceRow[] = [MAIL_SOURCE].map((id) => ({ id, ...sourceName(id), vendor: "synthetic", connector: "synthetic", options: {}, read_through_ms: null, added_ms: 0 }));
  return {
    extractsOn: (family, day) => (byFamily.get(family) ?? []).filter((row) => row.days.includes(day)),
    enrichment: () => undefined,
    sources: () => sources,
    since: () => undefined,
  };
}

function render(families: readonly Family[], byFamily: ReadonlyMap<string, readonly ExtractRow[]>): DayDocument {
  const rendered = renderDay(DAY, families, reader(byFamily), SETTINGS, tableUnits(LABELS));
  const document = JSON.parse(rendered.json) as DayDocument;
  expect(checkDayFile(document)).toEqual([]);
  return document;
}

const said = (text: string, names: readonly NameSpan[] | undefined) => (names ?? []).map(({ start, end, who }) => [text.slice(start, end), who]);

describe("the names a day printed", () => {
  it("a family that prints a person's name states no span for it, an ordinary word's too, or states one where no name was printed", () => {
    const day = render([messages, calls, mail, calendar], new Map([[messages.name, MESSAGES], [calls.name, CALLS], [mail.name, MAILS], [calendar.name, EVENTS]]));
    const rose = idOf(ROSE);
    const will = idOf(WILL);
    const ada = idOf("ada@example.com");
    const byText = new Map(day.atoms.map((atom) => [atom.text, atom]));
    const atom = (text: string) => {
      expect(byText.has(text), `${text} among ${[...byText.keys()].join(" | ")}`).toBe(true);
      return byText.get(text)!;
    };

    const first = atom("Rose: I will call you about the bill");
    expect(said(first.text, first.names)).toEqual([["Rose", rose]]);
    expect(said(first.block!.title, first.block!.names)).toEqual([["Rose", rose]]);
    const reply = atom("the user: Sure (reply to Rose, 10:00)");
    expect(said(reply.text, reply.names)).toEqual([["Rose", rose]]);
    const group = atom("Will: Yes");
    expect(said(group.text, group.names)).toEqual([["Will", will]]);
    expect(said(group.block!.title, group.block!.names)).toEqual([["Rose", rose], ["Will", will]]);
    const asked = atom("Rose: Will you come?");
    expect(said(asked.text, asked.names)).toEqual([["Rose", rose]]);
    const call = atom("Phone call with Will, they called, 2 min");
    expect(said(call.text, call.names)).toEqual([["Will", will]]);
    const lunch = atom("Mail from Ada Example to the user, Bill: “Lunch” — See you there");
    expect(said(lunch.text, lunch.names)).toEqual([["Ada Example", ada], ["Bill", idOf("bill@example.com")]]);
    expect(atom("Mail from carol@example.com: “Hello” — See you there").names).toBeUndefined();
    const event = atom("Event “Planning”, organised by Ada Example, 2 attendees");
    expect(said(event.text, event.names)).toEqual([["Ada Example", ada]]);
  });

  it("a span drifts as the day lays out its words, or a span the day cannot keep is printed", () => {
    const rose: Named = { name: "Rose", by: "contact", person: null, who: "phone:+15550000001" };
    const ada: Named = { name: "Ada  Example", by: "contact", person: null, who: "email:ada@example.com" };
    const family = (lines: (input: { day: string }) => DayLine[]): Family => ({
      name: "notes", type: "notes", code: "1", inputs: [], touched: () => [], extract: () => null,
      days: () => [DAY], day: linesOnly(lines),
    });
    const row: ExtractRow = { family: "notes", unit: "n1", reading: "r", code: "1", content: {}, start_ms: at("09:00"), end_ms: null, days: [DAY], seq: 0 };
    const title = printed`  ${rose}\n and  ${ada} `;
    const laid = render([family(() => [{
      family: "notes", unit: "n1", units: ["n1"], start_ms: at("09:00"), end_ms: null,
      ...printed`\r\n  ${rose} wrote:   \r\n\r\n  to ${ada}\t \n`,
      block: { key: "k", title: title.text, names: title.names },
    }])], new Map([["notes", [row]]]));
    const [one] = laid.atoms;
    expect(one!.text).toBe("Rose wrote:\n\n  to Ada  Example");
    expect(said(one!.text, one!.names)).toEqual([["Rose", rose.who], ["Ada  Example", ada.who]]);
    expect(one!.block!.title).toBe("Rose and Ada Example");
    expect(said(one!.block!.title, one!.block!.names)).toEqual([["Rose", rose.who], ["Ada Example", ada.who]]);

    const broken = (names: NameSpan[]) => () => render([family(() => [{ family: "notes", unit: "n1", units: ["n1"], start_ms: at("09:00"), end_ms: null, text: "Rose wrote", names }])], new Map([["notes", [row]]]));
    for (const names of [
      [{ start: 0, end: 11, who: "p" }],
      [{ start: 4, end: 6, who: "p" }],
      [{ start: 0, end: 4, who: "p" }, { start: 2, end: 6, who: "q" }],
      [{ start: 5, end: 10, who: "p" }, { start: 0, end: 4, who: "q" }],
      [{ start: 0, end: 4, who: "" }],
      [{ start: 2, end: 2, who: "p" }],
    ]) expect(broken(names), JSON.stringify(names)).toThrow(DayLineError);
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`);
    const long = printed`${rose}: ${words(100_000).join("  \r\n")}\t${ada}\r\n\r\n ${words(100_000).join(" 　")} ${rose} `;
    const [far] = render([family(() => [{ family: "notes", unit: "n1", units: ["n1"], start_ms: at("09:00"), end_ms: null, ...long }])], new Map([["notes", [row]]])).atoms;
    expect(far!.text).toBe(`Rose: ${words(100_000).join("\n")}\tAda  Example\n\n ${words(100_000).join(" 　")} Rose`);
    expect(said(far!.text, far!.names)).toEqual([["Rose", rose.who], ["Ada  Example", ada.who], ["Rose", rose.who]]);
    const plain = render([family(() => [{ family: "notes", unit: "n1", units: ["n1"], start_ms: at("09:00"), end_ms: null, ...printed`no one here`, block: { key: "k", title: "Notes", names: [] } }])], new Map([["notes", [row]]]));
    expect(Object.keys(plain.atoms[0]!)).not.toContain("names");
    expect(Object.keys(plain.atoms[0]!.block!)).toEqual(["key", "title"]);
  });
});
