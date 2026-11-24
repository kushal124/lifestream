import type { DaySettings } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import type { DayAtom, DayFileFact } from "../days.js";
import { QUIET_TITLE, type Conversation } from "./family.js";
import { foldedIn, groupTalk, lastTalk, saidIn, saidOf, talkDays, talkRuns, talkText, type Spoken, type TalkChat, type Talker } from "./talk.js";

const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const K = "phone:+15550000401";
const L = "phone:+15550000402";
const DIRECT = "whatsapp:15550000401@s.whatsapp.net";
const GROUP = "whatsapp:120363000000000041@g.us";
const IMESSAGE = "imessage:+15550000401";
const MINUTE = 60_000;
const at = (day: string, hour: number, minute = 0) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);

const chats = (...listed: [string, boolean, number][]): Map<string, TalkChat> => new Map(listed.map(([key, group, last_ms]) => [key, { key, group, last_ms }]));
const them = (more: Partial<Talker> = {}): Talker => ({
  handles: [{ id: K }], chats: [{ key: DIRECT }, { key: GROUP }], last_ms: null, ...more,
});
const line = (chat: string, at_ms: number, text: string, who: "me" | string): Spoken => ({
  chat, at_ms, n: 0, from: who === "me" ? [] : [who], mine: who === "me", name: who === "me" ? "the user" : text.slice(0, text.indexOf(":")), text, forwarded: false,
});
const texts = (said: readonly Spoken[] | undefined) => (said ?? []).map((each) => each.text);

describe("Last talked", () => {
  it("is your one-to-one chat before a newer group post", () => {
    const day = "2026-10-02";
    const talk = lastTalk(them(), chats([DIRECT, false, 0], [GROUP, true, 0]), [{ day, said: [
      line(DIRECT, at(day, 10), "lunch?", K), line(DIRECT, at(day, 10, 1), "yes", "me"), line(GROUP, at(day, 15), "later, to the group", K),
    ] }]);
    expect(talk?.chat, "a group post is not you talking").toBe(DIRECT);
    expect(texts(talk?.runs.at(-1))).toEqual(["lunch?", "yes"]);
  });

  it("with no one-to-one that day, keeps only their lines and yours in a group they spoke in, never someone else's line", () => {
    const day = "2026-10-02";
    const talk = lastTalk(them(), chats([DIRECT, false, 0], [GROUP, true, 0]), [{ day, said: [
      line(GROUP, at(day, 10), "who's in?", L), line(GROUP, at(day, 10, 1), "me", K), line(GROUP, at(day, 10, 2), "me too", "me"),
    ] }]);
    expect(talk?.chat).toBe(GROUP);
    expect(talk?.runs.at(-1)?.map((each) => [each.text, each.mine]), "never someone else's line").toEqual([["me", false], ["me too", true]]);
  });

  it("finds no talk in a group they never spoke in that day, though you did", () => {
    const day = "2026-10-02";
    expect(lastTalk(them(), chats([GROUP, true, 0]), [{ day, said: [line(GROUP, at(day, 10), "who's in?", L), line(GROUP, at(day, 10, 1), "me", "me")] }])).toBeNull();
  });

  it("reads the day of the newest one-to-one chat first, so a newer email never hides an older chat", () => {
    const older = "2026-09-20";
    const newer = "2026-10-01";
    const person = them({ chats: [{ key: IMESSAGE }], days: { [older]: 2, [newer]: 1 }, last_ms: at(newer, 9) });
    const known = chats([IMESSAGE, false, at(older, 18)]);
    const days = talkDays(person, known, SETTINGS);
    expect(days, "the chat's day, then their newest day of anything, then the day of their last contact").toEqual([older, newer]);
    const files = { [older]: [line(IMESSAGE, at(older, 18), "see you", K)], [newer]: [] };
    const talk = lastTalk(person, known, days.map((day) => ({ day, said: files[day as keyof typeof files] })));
    expect([talk?.day, talk?.chat, texts(talk?.runs.at(-1))]).toEqual([older, IMESSAGE, ["see you"]]);
  });

  it("names at most three days, and skips a day the caller holds no file for", () => {
    const person = them({ chats: [{ key: DIRECT }], days: { "2026-09-01": 1 }, last_ms: at("2026-09-10", 9) });
    expect(talkDays(person, chats([DIRECT, false, at("2026-08-01", 9)]), SETTINGS)).toEqual(["2026-08-01", "2026-09-01", "2026-09-10"]);
    const talk = lastTalk(person, chats([DIRECT, false, 0]), [
      { day: "2026-09-01", said: [line(DIRECT, at("2026-09-01", 9), "from the second day", K)] },
      { day: "2026-09-10", said: [line(DIRECT, at("2026-09-10", 9), "from the third day", K)] },
    ]);
    expect(talk?.day, "the first day had no file, so the next one answers").toBe("2026-09-01");
    expect(lastTalk(person, chats([DIRECT, false, 0]), [
      { day: "2026-08-01", said: [] }, { day: "2026-09-01", said: [] }, { day: "2026-09-10", said: [] },
      { day: "2026-09-11", said: [line(DIRECT, at("2026-09-11", 9), "a fourth day", K)] },
    ]), "a fourth day is never read").toBeNull();
    expect(talkDays(them({ chats: [] }), chats(), SETTINGS), "no chat, no days, no contact: no day").toEqual([]);
  });

  it("splits a chat's lines into runs at a gap over 30 minutes, the newest run last", () => {
    const day = "2026-10-02";
    const said = [
      line(DIRECT, at(day, 9), "morning", K), line(DIRECT, at(day, 9, 30), "half an hour on", "me"),
      line(DIRECT, at(day, 10, 1), "31 minutes on", K), line(DIRECT, at(day, 10, 2), "and again", "me"),
    ];
    expect(talkRuns(said).map(texts)).toEqual([["morning", "half an hour on"], ["31 minutes on", "and again"]]);
    expect(lastTalk(them(), chats([DIRECT, false, 0]), [{ day, said }])?.runs.map(texts)).toEqual([["morning", "half an hour on"], ["31 minutes on", "and again"]]);
  });

  it("is the whole group's last run for a group, every member's line in it", () => {
    const day = "2026-10-02";
    const talk = groupTalk(GROUP, [{ day, said: [line(DIRECT, at(day, 11), "elsewhere", K), line(GROUP, at(day, 10), "who's in?", L), line(GROUP, at(day, 10, 1), "me", K)] }]);
    expect([talk?.chat, texts(talk?.runs.at(-1))]).toEqual([GROUP, ["who's in?", "me"]]);
  });
});

describe("What a day file says", () => {
  const day = "2026-10-02";
  const atom = (n: number, chat: string, start_ms: number | null, text: string, title = "Chat"): DayAtom => ({
    n, family: "messages", unit: "u", units: ["u"], start_ms, end_ms: null, local_start: null, local_end: null, flags: [], text, block: { key: chat, title },
  });
  const fact = (n: number, direction: "sent" | "received", senders: string[]): DayFileFact => ({
    id: `f${n}`, family: "messages", of: "messages", time_ms: 0, start_ms: 0, end_ms: 0, keys: { chat: GROUP, direction }, measures: {},
    who: senders.map((handle) => ({ handle, role: direction === "sent" ? "receiver" : "sender" })), from: { units: ["u"], alone: true } as DayFileFact["from"], lines: [n],
  });

  it("joins each line to its fact: the sender's handle, yours, and none for a line no fact states", () => {
    const file = {
      atoms: [atom(1, GROUP, at(day, 10), "Person L: who's in?"), atom(2, GROUP, at(day, 10, 1), "the user: me"), atom(3, GROUP, at(day, 10, 2), "Person L reacted"),
        atom(4, "whatsapp:120363000000000042@g.us", null, "Group Quiet · 4 messages", QUIET_TITLE), { ...atom(5, GROUP, at(day, 11), "a call"), family: "calls" }],
      facts: [fact(1, "received", [L]), fact(2, "sent", [K, L])],
    };
    expect(saidIn(file).map((each) => [each.name, each.text, each.mine, each.from, each.n])).toEqual([
      ["Person L", "who's in?", false, [L], 1], ["the user", "me", true, [], 2], ["", "Person L reacted", false, [], 3],
    ]);
    expect(foldedIn(file, new Set(["whatsapp:120363000000000042@g.us"]))).toEqual([{ chat: "whatsapp:120363000000000042@g.us", line: "Group Quiet · 4 messages", n: 4 }]);
    expect(foldedIn(file, new Set([GROUP])), "a quiet line of a chat that is not theirs").toEqual([]);
  });

  it("reads a folded chat's conversation as lines, the sender's handle and yours", () => {
    const conversation = { title: "Group Quiet", messages: [
      { line: { family: "messages", unit: "u", units: ["u"], start_ms: at(day, 9), end_ms: null, text: "Person K: hello" }, fact: { source: "s", key: "k1", at: at(day, 9), from: { id: "15550000401@s.whatsapp.net", kind: "phone" } } },
      { line: { family: "messages", unit: "u", units: ["u"], start_ms: at(day, 9, 1), end_ms: null, text: "the user: hi" }, fact: { source: "s", key: "k2", at: at(day, 9, 1), from: { id: "", kind: "me" } } },
    ] } as unknown as Conversation;
    expect(saidOf(GROUP, conversation, 7).map((each) => [each.text, each.mine, each.from, each.n]), "a heard line opens at its chat's quiet line").toEqual([["hello", false, [K], 7], ["hi", true, [], 7]]);
  });

  it("cleans a line's words as a conversation shows them: forwarded marked, asides and events gone, media named with its length", () => {
    expect(talkText("(forwarded) see this")).toEqual({ text: "see this", forwarded: true });
    expect(talkText("sure (reply to Person L) (edited)")).toEqual({ text: "sure", forwarded: false });
    expect(talkText("ok (to Group One)")).toEqual({ text: "ok", forwarded: false });
    expect(talkText("[system event: synthetic]")).toEqual({ text: "", forwarded: false });
    expect(talkText("[group event] hi")).toEqual({ text: "hi", forwarded: false });
    expect(talkText("[photo]")).toEqual({ text: "Photo", forwarded: false });
    expect(talkText("[voice note, 72 s]")).toEqual({ text: "Voice note · 1:12", forwarded: false });
    expect(talkText("[video, 5 s: a synthetic clip]")).toEqual({ text: "Video · 0:05 · a synthetic clip", forwarded: false });
    expect(talkText("[contact card: Person K]")).toEqual({ text: "Contact card · Person K", forwarded: false });
    expect(talkText("(forwarded) [document: synthetic.pdf]")).toEqual({ text: "Document · synthetic.pdf", forwarded: true });
    expect(talkText("plain words, (kept) [kept]")).toEqual({ text: "plain words, (kept) [kept]", forwarded: false });
  });

  it("reads each line's words cleaned, with its day-file line number", () => {
    const file = { atoms: [atom(9, DIRECT, at(day, 10), "Person K: (forwarded) [photo, 3 s]")], facts: [] };
    expect(saidIn(file).map((each) => [each.text, each.forwarded, each.n])).toEqual([["Photo · 0:03", true, 9]]);
  });
});
