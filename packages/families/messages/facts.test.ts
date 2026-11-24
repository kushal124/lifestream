import { describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { collectionsFault } from "../family.js";
import { FED } from "../test/fed.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { messagesFamily, type ChatDay } from "./family.js";
import type { Fact } from "./read.js";

const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const MESSAGES = messagesFamily({ books: FED.labels })(FED.messages);
const MAC = "imessage:person-a@example.com:macbook-pro-0001";
const PHONE = "imessage:person-a@example.com:iphone-0042";
const WA = "whatsapp:15550000000:macbook-pro-0001";
const at = (local: string) => Date.parse(`${local}-04:00`);

function chatDay(network: string, chat: string, messages: Fact[]): Content {
  const content: ChatDay = { network, chat, day: "2026-10-25", messages };
  return { unit: `2026-10-25:${network}:${chat}`, content, start_ms: messages[0]!.at, end_ms: messages.at(-1)!.at };
}

const ONE = "+15550000001";
const GROUP = "+15550000001,+15550000002";
const WA_GROUP = "120363000000000001@g.us";
const MEMBER = "15550000003@s.whatsapp.net";

const RECORD: Content[] = [
  chatDay("imessage", ONE, [
    { source: MAC, key: "G1", at: at("2026-10-25T09:00"), from: { id: ONE, kind: "phone" }, text: "Running late" },
    { source: MAC, key: "G2", at: at("2026-10-25T09:05"), from: { id: "me", kind: "me" }, parts: [{ what: "photo" }] },
    { source: MAC, key: "G3", at: at("2026-10-25T09:06"), from: { id: ONE, kind: "phone" }, parts: [{ what: "voice note", seconds: 4 }] },
    { source: MAC, key: "G4", at: at("2026-10-25T09:07"), from: { id: "me", kind: "me" }, parts: [{ what: "sticker" }] },
    { source: MAC, key: "G5", at: at("2026-10-25T09:08"), from: { id: ONE, kind: "phone" }, parts: [{ what: "reaction: love" }], reply_to: "G1" },
  ]),
  chatDay("imessage", GROUP, [
    { source: MAC, key: "G6", at: at("2026-10-25T10:00"), from: { id: "me", kind: "me" }, text: "Dinner at 8?" },
  ]),
  chatDay("whatsapp", WA_GROUP, [
    { source: WA, key: `${WA_GROUP}:W1`, at: at("2026-10-25T11:00"), from: { id: MEMBER, kind: "jid" }, text: "On my way" },
    { source: WA, key: `${WA_GROUP}:W2`, at: at("2026-10-25T11:01"), from: { id: WA_GROUP, kind: "system" }, parts: [{ what: "group event, kind 1: subject changed" }] },
    { source: WA, key: `${WA_GROUP}:W3`, at: at("2026-10-25T11:02"), from: { id: MEMBER, kind: "jid" }, parts: [{ what: "group event, kind 77: group settings changed" }] },
  ]),
];
const input = (contents: readonly Content[] = RECORD, day = "2026-10-25") => dayInput(MESSAGES, day, contents, SETTINGS);
const facts = (contents?: readonly Content[]) => MESSAGES.day(input(contents)).facts;
const byKey = (contents: readonly Content[] | undefined, key: string) => {
  const projection = MESSAGES.day(input(contents));
  return projection.facts.find((fact) => fact.from.record?.key === key);
};

describe("messages facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([MESSAGES])).toEqual([]);
  });

  it("two copies of one message with different words are one message, stated from the copy shown, its id whichever copy that is", () => {
    const words: Fact = { source: MAC, key: "G1", at: at("2026-10-25T09:00"), from: { id: ONE, kind: "phone" }, text: "Running late" };
    const other: Fact = { source: PHONE, key: "G1", at: at("2026-10-25T09:00"), from: { id: ONE, kind: "phone" }, text: "Running late, sorry" };
    const both = [chatDay("imessage", ONE, [words]), chatDay("imessage", GROUP, [other])];
    const stated = facts(both);
    expect(stated).toHaveLength(1);
    const richer = MESSAGES.day(input(both));
    expect(richer.lines).toHaveLength(1);
    expect(richer.lines[stated[0]!.lines[0]!]!.record?.source).toBe(stated[0]!.from.record?.source);
    const { text: _text, ...bare } = other;
    const withdrawn: Fact = { ...bare, withdrawn: true, parts: [{ what: "message deleted" }] };
    const gone = facts([chatDay("imessage", ONE, [words]), chatDay("imessage", GROUP, [withdrawn])]);
    expect(gone).toHaveLength(1);
    expect(gone[0]!.from.record?.source).toBe(PHONE);
    expect(gone[0]!.keys["searchable"]).toBe("no");
    expect(new Set([stated[0]!.id, gone[0]!.id, facts([chatDay("imessage", ONE, [words])])[0]!.id]).size).toBe(1);
  });

  it("a photo, a voice note and a sticker are messages with no words: counted, never searchable", () => {
    expect(["G1", "G2", "G3", "G4"].map((key) => byKey(undefined, key)?.keys["searchable"])).toEqual(["yes", "no", "no", "no"]);
    expect(byKey(undefined, "G2")!.keys).toEqual({ chat: `imessage:${ONE}`, direction: "sent", product: "imessage", searchable: "no" });
  });

  it("a reaction and a group event print their lines and are no message", () => {
    const projection = MESSAGES.day(input());
    expect(projection.lines).toHaveLength(9);
    for (const key of ["G5", `${WA_GROUP}:W2`, `${WA_GROUP}:W3`]) expect(byKey(undefined, key)).toBeUndefined();
    expect(projection.facts).toHaveLength(6);
    for (const fact of projection.facts) expect(projection.lines[fact.lines[0]!]!.record?.key).toBe(fact.from.record?.key);
  });

  it("its people are raw handles with their roles: who sent what the owner received, whom the chat names for what the owner sent", () => {
    expect(byKey(undefined, "G1")!.who).toEqual([{ handle: "phone:+15550000001", role: "sender" }]);
    expect(byKey(undefined, "G6")!.who).toEqual([{ handle: "phone:+15550000001", role: "receiver" }, { handle: "phone:+15550000002", role: "receiver" }]);
    const member = byKey(undefined, `${WA_GROUP}:W1`)!;
    expect(member.who).toEqual([{ handle: "phone:+15550000003", role: "sender" }]);
    expect(member.keys).toEqual({ chat: `whatsapp:${WA_GROUP}`, direction: "received", product: "whatsapp", searchable: "yes" });
  });

  it("holds to F1's conformance: order, one day's statement and an inserted line", () => {
    expect(factsConform(MESSAGES, [input()])).toEqual([]);
    const earlier = chatDay("imessage", "+15550000009", [{ source: MAC, key: "G0", at: at("2026-10-25T08:00"), from: { id: "+15550000009", kind: "phone" }, text: "Morning" }]);
    expect(insertKeepsFacts(MESSAGES, input(), input([earlier, ...RECORD]))).toEqual([]);
  });
});
