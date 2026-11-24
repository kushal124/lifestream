import { describe, expect, it } from "vitest";
import type { DaySettings, SourceRow } from "@lifestreamprotocol/core";
import { collectionsFault } from "../family.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { mailFamily, type MailDayContent, type MailEntry } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const MAIL = mailFamily({ books: FED.labels })(FED.mail);
const OWNER = "person-a@example.com";
const BOX = `gmail:${OWNER}:macbook-pro-0001`;
const SOURCES = new Map<string, SourceRow>([[BOX, {
  id: BOX, product: "gmail", vendor: "google", account: OWNER, copy: "macbook-pro-0001", connector: "gmail", options: {}, read_through_ms: null, added_ms: 0,
}]]);
const at = (local: string) => Date.parse(`${local}-04:00`);

function mail(key: string, local: string, said: Partial<MailEntry>): MailEntry {
  return {
    key, at_ms: at(local), route: "read", junk: null, draft: false, from: null, to: [], subject: "", attachments: [], invitation: null,
    body: null, unreadable: null, pack: null, ...said,
  };
}

function box(mails: MailEntry[]): Content {
  const content: MailDayContent = { source: BOX, mails };
  return { unit: `${BOX}/2026-10-25`, content, start_ms: mails[0]!.at_ms, end_ms: mails.at(-1)!.at_ms };
}

const B = { address: "person-b@example.com", name: "B" };
const C = { address: "person-c@example.com", name: null };
const ME = { address: OWNER, name: "Me" };
const MAILS = [
  mail("m1", "2026-10-25T09:00", { from: B, to: [ME, C], subject: "Lunch", body: "Friday?" }),
  mail("m2", "2026-10-25T09:30", { from: ME, to: [B], subject: "Re: Lunch", body: "Yes" }),
  mail("m3", "2026-10-25T10:00", { from: ME, to: [C], subject: "Plans", draft: true }),
  mail("m4", "2026-10-25T11:00", { unreadable: "its bytes are not in the blob store" }),
];
const input = (contents: readonly Content[] = [box(MAILS)]) => dayInput(MAIL, "2026-10-25", contents, SETTINGS, { sources: SOURCES });
const facts = (contents?: readonly Content[]) => MAIL.day(input(contents)).facts;

describe("mail facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([MAIL])).toEqual([]);
  });

  it("an email is one mail whichever copy its record holds: its id is its mailbox and key, never its words", () => {
    const pulled = facts([box([mail("m1", "2026-10-25T09:00", { from: B, to: [ME], subject: "Lunch", body: "Friday?" })])]);
    const exported = facts([box([mail("m1", "2026-10-25T09:00", { from: B, to: [ME], subject: "Lunch", body: "Friday? Sent from my phone" })])]);
    expect(pulled).toHaveLength(1);
    expect(exported[0]!.id).toBe(pulled[0]!.id);
  });

  it("a draft prints and is no one's mail; a mail that could not be read still counts, with no keys", () => {
    const projection = MAIL.day(input());
    expect(projection.lines).toHaveLength(4);
    expect(projection.facts.map((fact) => fact.from.record?.key)).toEqual(["m1", "m2", "m4"]);
    const unread = projection.facts.find((fact) => fact.from.record?.key === "m4")!;
    expect([unread.keys, unread.who]).toEqual([{}, []]);
  });

  it("its people are raw handles with their roles, the mailbox's own address left out", () => {
    const [received, sent] = facts();
    expect(received!.keys).toEqual({ direction: "received", title: "Lunch" });
    expect(received!.who).toEqual([{ handle: "email:person-b@example.com", role: "sender" }, { handle: "email:person-c@example.com", role: "receiver" }]);
    expect(sent!.keys).toEqual({ direction: "sent", title: "Re: Lunch" });
    expect(sent!.who).toEqual([{ handle: "email:person-b@example.com", role: "receiver" }]);
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(MAIL, [input()])).toEqual([]);
    const earlier = mail("m0", "2026-10-25T08:00", { from: C, to: [ME], subject: "Morning" });
    expect(insertKeepsFacts(MAIL, input(), input([box([earlier, ...MAILS])]))).toEqual([]);
  });
});
