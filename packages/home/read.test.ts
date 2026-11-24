import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { peopleMatchOf, type PeopleSearchMatch } from "./people.js";
import { onePlaceOf, stretchOf } from "./read.js";
import { personRef, readRef } from "./refs.js";
import { Refusal } from "./refusal.js";
import { onePlace, peopleMatch } from "./search-contract.js";

const ADA: PeopleSearchMatch = {
  id: "person:person-a", kind: "person", name: "Person A", also: ["Ada"], tied: ["person:person-b"], same: [{ id: "person:person-c", by: "face" }],
  handles: ["jid:15550000142@s.whatsapp.net"], me: true,
  chats: [{ chat: "whatsapp:15550000142@s.whatsapp.net", title: "Person A", messages: 12 }, { chat: "whatsapp:15550000199@s.whatsapp.net", title: "Uncounted" }],
  reach: { messages: [12, "2026-10-01", "2026-10-11"] },
};

describe("a person's or a chat's ref, as People answers it", () => {
  const HANDLES: Record<string, string[]> = { "person:person-b": ["phone:+15550000002"], "person:person-c": [] };
  const refOf = (id: string) => personRef({ id, handles: HANDLES[id] ?? [] });

  it("leaves every person a ref of a handle of theirs, every chat a ref of its kind, and a chat not counted out", () => {
    const match = peopleMatch.parse(peopleMatchOf(ADA, refOf));
    expect(readRef(match.ref)).toEqual({ kind: "person", parts: { handle: "jid:15550000142@s.whatsapp.net" } });
    expect(match.tied!.map((ref) => readRef(ref))).toEqual([{ kind: "person", parts: { handle: "phone:+15550000002" } }]);
    expect(match.same!.map((each) => [readRef(each.ref), each.why])).toEqual([[{ kind: "person", parts: { handle: "person:person-c" } }, "a face named with a name of the other's"]]);
    expect(match.chats!.map((chat) => [readRef(chat.chat), chat.messages])).toEqual([[{ kind: "chat", parts: { key: "whatsapp:15550000142@s.whatsapp.net" } }, 12]]);
    expect(match).toMatchObject({ the_user: true, reach: ADA.reach });
  });

  it("gives a group its chat's ref", () => {
    const group = peopleMatchOf({ ...ADA, id: "whatsapp:120363000000000001@g.us", kind: "group", me: undefined } as unknown as PeopleSearchMatch, refOf);
    expect(readRef(peopleMatch.parse(group).ref)).toEqual({ kind: "chat", parts: { key: "whatsapp:120363000000000001@g.us" } });
  });
});

describe("a place's ref, as Places answers it", () => {
  it("is Places' place with the contract's members alone", () => {
    const fixture = JSON.parse(readFileSync(new URL("./test/contract/read-place.json", import.meta.url), "utf8")) as { place: Record<string, unknown> };
    const answered = { ...fixture.place, position: "12:1793500000000", shown_on: ["2026-10-31"] };
    expect(onePlace.parse(onePlaceOf(answered))).toEqual(fixture.place);
  });
});

describe("a stretch `from` and `to` alone name", () => {
  const INDIA = { zone: "Asia/Kolkata", day_start_hour: 4 };
  const at = (instant: string) => Date.parse(instant);

  it("is a day's whole when a day is given alone, either end; an instant alone reads to its day's end, or from its day's start", () => {
    expect(stretchOf({ from: "2026-11-02" }, INDIA)).toMatchObject({
      from: "2026-11-02", to: "2026-11-02", from_ms: at("2026-11-02T04:00+05:30"), to_ms: at("2026-11-03T04:00+05:30"), whole: true, stated: { from: "2026-11-02", to: "2026-11-02" },
    });
    expect(stretchOf({ to: "2026-11-02" }, INDIA)).toMatchObject({ from: "2026-11-02", to: "2026-11-02", whole: true });
    expect(stretchOf({ from: "2026-11-02T09:00" }, INDIA)).toMatchObject({
      from_ms: at("2026-11-02T09:00+05:30"), to_ms: at("2026-11-03T04:00+05:30"), whole: false, stated: { from: "2026-11-02T09:00+05:30", to: "2026-11-03T04:00+05:30" },
    });
    expect(stretchOf({ to: "2026-11-02T09:00Z" }, INDIA)).toMatchObject({ from_ms: at("2026-11-02T04:00+05:30"), to_ms: at("2026-11-02T09:00Z"), whole: false });
  });

  it("reads a home-local time in the home's zone, two days given as both ends whole, and refuses a `to` not after `from`", () => {
    expect(stretchOf({ from: "2026-11-02T01:30", to: "2026-11-02T02:00" }, INDIA)).toMatchObject({ from: "2026-11-01", to: "2026-11-01", from_ms: at("2026-11-02T01:30+05:30") });
    expect(stretchOf({ from: "2026-11-01", to: "2026-11-03", families: ["notes"] }, INDIA)).toMatchObject({ from: "2026-11-01", to: "2026-11-03", whole: true, families: ["notes"] });
    expect(() => stretchOf({ from: "2026-11-03", to: "2026-11-01" }, INDIA)).toThrow(Refusal);
    expect(() => stretchOf({ from: "2026-11-02T10:00", to: "2026-11-02T10:00" }, INDIA)).toThrow(Refusal);
  });
});

