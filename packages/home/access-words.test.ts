import { describe, expect, it } from "vitest";
import type { Access, DraftAccess } from "@lifestreamprotocol/privacy";
import { defaultAccess, fullAccess } from "./access.js";
import { countedOf } from "./hiding.js";
import { DETAIL_WORDS, TYPES } from "@lifestreamprotocol/core";
import {
  addsOf, agentReads, agentText, amountOf, askedLine, askLine, callLine, cameKinds, CHAT_ERASED, changeWords, chatHeadOf, chatLine, choicesOf, counted, defaultOf, DETAIL_NOUNS, differenceOf,
  disconnectingOf, droppedWords, erasedHead, figureOf, goneWords, headOf, heldWords, itemsKeptWords, keepsOf, keptAbout, keptLine, keptRows, kindReads, limitWords, narrowedWords, neverReadOf, NOUNS,
  onceOf, outcomeOf, phraseText, pickLine, pickWords, placeOf, plainOf, quietOf, readCount, readLine, repeatWords, requestWords, saidOf, sawOf, saysTitle, sentenceOf, SHOW_EARLIER, showOf, signingInLine, signInHead, signInNotice,
  signInOver, spanWords, summaryOf, thingsTitle, todayWords, toldWords, undroppableWords, underLine, underOf, unshownWords, wantsOf, whyOf, widenedWords, type CallSeen, type ClockPhrase, type Words,
} from "./access-words.js";

const DAY_MS = 24 * 3_600_000;
const NOW = Date.UTC(2026, 10, 14, 12, 0);
const TIME_WORD = /\b(?:today|yesterday|tomorrow|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{4})\b|\d{1,2}:\d{2}/u;
const NAMED: Words = {
  account: (account) => account,
  product: (product) => product,
  address: () => null,
  zone: "UTC",
};

describe("the words of an access", () => {
  it("say the spec's sentences for the default, a full access, a limited one and none", () => {
    expect(sentenceOf(defaultAccess(), "Claude", NAMED)).toBe("Claude reads everything but Health and Money. Details hidden, names shown.");
    expect(summaryOf(defaultAccess(), NAMED)).toBe("Everything but Health and Money · details hidden");
    expect(sentenceOf(fullAccess("names"), "Claude", NAMED)).toBe("Claude reads everything. Details hidden, names shown.");
    expect(summaryOf(fullAccess("names"), NAMED)).toBe("Everything · details hidden");
    expect(sentenceOf(fullAccess("none"), "Chat", NAMED, { chat: true })).toBe("Chat reads everything.");
    expect(summaryOf({ ...fullAccess("none"), window: { past_ms: DAY_MS } }, NAMED, { chat: true })).toBe("Everything · past 24 hours");
    expect(changeWords({ name: "Chat", what: "granted", by: "person", device: "this iPhone", access: fullAccess("none"), before: null, wants: null, about: null }, NAMED, { chat: true }))
      .toEqual({ words: "You allowed Chat", line: "You, on this iPhone · Everything" });
    const limited: Access = {
      ...defaultAccess(),
      allow: (["mail", "plans"] as const).map((type) => ({ reach: { type, but: [] }, window: { past_ms: 30 * DAY_MS }, until_ms: null })),
    };
    expect(sentenceOf(limited, "Hermes", NAMED)).toBe("Hermes reads Mail and Calendar from the past 30 days. Details hidden, names shown.");
    expect(summaryOf(limited, NAMED)).toBe("Mail and Calendar · past 30 days · details hidden");
    const windowed: Access = { ...defaultAccess(), allow: [limited.allow[0]!], window: { past_ms: 7 * DAY_MS } };
    expect(sentenceOf(windowed, "Hermes", NAMED)).toBe("Hermes reads Mail from the past 7 days. Details hidden, names shown.");
    expect(summaryOf(windowed, NAMED)).toBe("Mail · past 7 days · details hidden");
    const mixed: Access = { ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }, { reach: { type: "messages", but: [] }, window: { past_ms: 30 * DAY_MS }, until_ms: null }], hide: "all" };
    expect(sentenceOf(mixed, "Hermes", NAMED)).toBe("Hermes reads Mail from all time and Messages from the past 30 days. Names and details hidden.");
    expect(summaryOf(mixed, NAMED)).toBe("Mail from all time and Messages from the past 30 days · names and details hidden");
    expect(sentenceOf(null, "Claude", NAMED)).toBe("Claude reads nothing yet.");
    expect(summaryOf(null, NAMED)).toBe("Reads nothing");
    expect(sentenceOf({ ...defaultAccess(), allow: [] }, "Claude", NAMED)).toBe("Claude reads nothing yet.");
    expect(summaryOf({ ...defaultAccess(), allow: [] }, NAMED)).toBe("Reads nothing");
    expect([todayWords(defaultAccess(), NAMED), todayWords(null, NAMED)]).toEqual(["Today it reads everything but Health and Money.", "Today it reads nothing."]);
  });

  it("say overlapping grants as a person would: a reach inside another once, limits once per reach, an expiry by its time (Astra, round 3: 6)", () => {
    const CHAT = "whatsapp:phone-01";
    const WORK = "gmail:work-aa";
    const BARE = "notes-x:local-01";
    const home = [{ account: CHAT, category: "messages" as const }, { account: WORK, category: "mail" as const }, { account: BARE, category: null }];
    const names: Words = { ...NAMED, account: (account) => ({ [CHAT]: "WhatsApp", [WORK]: "Work Gmail", [BARE]: "Notes X" })[account] ?? account };
    const grant = (reach: Access["allow"][number]["reach"], window: Access["window"] = null, until_ms: number | null = null): Access["allow"][number] => ({ reach, window, until_ms });
    const at = { accounts: home, now_ms: NOW };
    const say = (access: Access, summary: string) => {
      expect(summaryOf(access, names, at)).toBe(summary);
      return sentenceOf(access, "Claude", names, at);
    };
    const split: Access = { ...defaultAccess(), allow: [
      grant({ all: true, but: ["messages", "health", "money"] }), grant({ type: "messages", but: [CHAT] }),
      grant({ account: CHAT, but: [] }, { past_ms: 7 * DAY_MS }), grant({ account: CHAT, but: [] }, { past_ms: 7 * DAY_MS }, NOW + 22 * 3_600_000),
    ] };
    expect(say(split, "Everything but Health and Money, WhatsApp only from the past 7 days · details hidden")).toBe("Claude reads everything but Health and Money, WhatsApp only from the past 7 days. Details hidden, names shown.");
    expect(say({ ...split, window: { past_ms: DAY_MS } }, "Everything but Health and Money · past 24 hours · details hidden")).toBe("Claude reads everything but Health and Money from the past 24 hours. Details hidden, names shown.");
    const health: Access = { ...defaultAccess(), allow: [grant({ all: true, but: ["health", "money"] }), grant({ type: "health", but: [] }, null, NOW + 2 * 3_600_000)] };
    expect(say(health, "Everything but Money, Health only until 14:00 · details hidden")).toBe("Claude reads everything but Money, Health only until 14:00. Details hidden, names shown.");
    expect(say({ ...health, allow: [health.allow[0]!, grant({ type: "health", but: [] }, null, NOW + DAY_MS)] }, "Everything but Money, Health only until 15 Nov 12:00 · details hidden"))
      .toBe("Claude reads everything but Money, Health only until 15 Nov 12:00. Details hidden, names shown.");
    expect(say({ ...defaultAccess(), allow: [grant({ all: true, but: ["health", "money"] }), grant({ account: CHAT, but: [] }, null, NOW + 3_600_000)] }, "Everything but Health and Money · details hidden"))
      .toBe("Claude reads everything but Health and Money. Details hidden, names shown.");
    expect(say({ ...defaultAccess(), allow: [grant({ all: true, but: ["mail", "health", "money"] }), grant({ type: "mail", but: [WORK] })] }, "Everything but Health, Money and Work Gmail · details hidden"))
      .toBe("Claude reads everything but Health, Money and Work Gmail. Details hidden, names shown.");
    expect(say({ ...defaultAccess(), allow: [grant({ all: true, but: ["mail"] }), grant({ account: BARE, but: [] })] }, "Everything but Mail, plus Notes X · details hidden"))
      .toBe("Claude reads everything but Mail, plus Notes X. Details hidden, names shown.");
    expect(say({ ...defaultAccess(), allow: [grant({ type: "mail", but: [] }, { past_ms: 7 * DAY_MS }), grant({ type: "mail", but: [] }, { since_ms: Date.UTC(2026, 0, 1) }, NOW + 3_600_000)] },
      "Mail from the past 7 days and since 1 Jan 2026 until 13:00 · details hidden"))
      .toBe("Claude reads Mail from the past 7 days and since 1 Jan 2026 until 13:00. Details hidden, names shown.");
    expect(say({ ...defaultAccess(), allow: [grant({ type: "mail", but: [] }), grant({ type: "health", but: [] }, null, NOW)] }, "Mail · details hidden")).toBe("Claude reads Mail. Details hidden, names shown.");
  });

  it("print a Settings row", () => {
    expect(summaryOf({ ...fullAccess("none"), window: { since_ms: Date.UTC(2026, 0, 1) } }, NAMED)).toBe("Everything · since 1 Jan 2026 · nothing hidden");
    const overlapping: Access = { ...defaultAccess(), allow: [
      { reach: { all: true, but: ["health", "money"] }, window: null, until_ms: null },
      { reach: { type: "mail", but: [] }, window: null, until_ms: NOW + 1 },
      { reach: { account: "whoop:band-01", but: [] }, window: null, until_ms: null },
      { reach: { account: "gmail:work-aa", but: [] }, window: null, until_ms: null },
    ] };
    const home = [{ account: "whoop:band-01", category: "health" as const }, { account: "gmail:work-aa", category: "mail" as const }];
    expect(summaryOf(overlapping, NAMED, { accounts: home })).toBe("Everything but Health and Money, plus whoop:band-01 · details hidden");
    expect(summaryOf(overlapping, NAMED)).toBe("Everything but Health and Money, plus whoop:band-01, plus gmail:work-aa · details hidden");
    expect(summaryOf({ ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }, { reach: { type: "mail", but: [] }, window: { past_ms: DAY_MS }, until_ms: null }] }, NAMED)).toBe("Mail · details hidden");
    expect([30 * 60_000, 3_600_000, DAY_MS, 2 * DAY_MS, 36 * 3_600_000].map(spanWords)).toEqual(["30 minutes", "1 hour", "24 hours", "2 days", "36 hours"]);
  });
});

describe("the words of an ask, a limit and the history", () => {
  const HOUR = 3_600_000;
  const WORDS: Words = {
    ...NAMED,
    account: (account) => (account === "gmail:work-aa" ? "work Gmail" : account),
    product: (product) => (product === "whatsapp" ? "WhatsApp" : product),
    address: (account) => (account === "gmail:work-aa" ? "person-a@work.example.com" : null),
  };
  const mail: Access = { ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }] };

  it("word a want as the card's head and its line under", () => {
    const product = { read: { product: "whatsapp" }, window: null } as const;
    expect(wantsOf(product, HOUR, WORDS)).toBe("all of WhatsApp for 1 hour");
    expect(headOf("Instinct", wantsOf(product, HOUR, WORDS))).toBe("Instinct asks to see all of WhatsApp for 1 hour");
    expect(askLine(wantsOf(product, HOUR, WORDS))).toBe("asks to see all of WhatsApp for 1 hour");
    const chats = [{ account: "whatsapp:15550000001", category: "messages" as const }, { account: "whatsapp:15550000002", category: "messages" as const }, { account: "gmail:work-aa", category: "mail" as const }];
    expect(underOf(product, { ...WORDS, address: (account) => account.split(":")[1]! }, chats), "the product's accounts of today, each by its address").toBe("15550000001 and 15550000002");
    expect(underOf(product, WORDS, []), "no account of the product: no line").toBeNull();
    const account = { read: { account: "gmail:work-aa" }, window: null } as const;
    expect(headOf("ChatGPT", wantsOf(account, HOUR, WORDS))).toBe("ChatGPT asks to see your work Gmail for 1 hour");
    expect(underOf(account, WORDS, chats)).toBe("person-a@work.example.com");
    const everything = { read: "everything", window: { since_ms: Date.UTC(2026, 0, 1) } } as const;
    expect(headOf("ChatGPT", wantsOf(everything, null, WORDS))).toBe("ChatGPT asks to see everything since 1 Jan 2026");
    expect(underOf(everything, WORDS, chats)).toBeNull();
    expect(wantsOf({ read: { category: "health" }, window: { past_ms: DAY_MS } }, HOUR, WORDS)).toBe("Health from the past 24 hours for 1 hour");
    expect(underOf({ read: { category: "health" }, window: null }, WORDS, chats)).toBeNull();
  });

  it("say what Chat's change adds and what stays hidden, its buttons and an ask's outcome", () => {
    const health: Access = { ...mail, allow: [...mail.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };
    const adds = (before: Access | null, after: Access, accounts: { account: string; category: "mail" | "health" | null }[] = []) => addsOf(differenceOf(before, after, accounts), WORDS);
    expect(adds(mail, health)).toEqual(["Health"]);
    expect(chatHeadOf("Hermes", differenceOf(mail, health, []), WORDS)).toBe("Let Hermes also read Health?");
    expect([chatLine(adds(mail, health)), chatLine([])], "Chat's proposal headed on its agent's row").toEqual(["Chat proposes Health", "Chat proposes more"]);
    expect([CHAT_ERASED, erasedHead("Claude")]).toEqual(["What this asked for was erased.", "What Claude asked for was erased."]);
    expect(keepsOf(differenceOf(mail, health, []), health)).toBe("Details stay hidden.");
    expect(widenedWords("Hermes", differenceOf(mail, health, []), WORDS)).toEqual([
      { text: "Hermes would also see " }, { text: "Health", bold: true }, { text: ". Nothing changes until you allow it." },
    ]);
    const shown: Access = { ...health, hide: "none" };
    expect(adds(mail, shown)).toEqual(["Health", "Nothing hidden"]);
    expect(chatHeadOf("Hermes", differenceOf(mail, shown, []), WORDS)).toBe("Let Hermes read more?");
    expect(plainOf(widenedWords("Hermes", differenceOf(mail, shown, []), WORDS))).toBe("Hermes would see more. Nothing changes until you allow it.");
    expect(keepsOf(differenceOf(mail, shown, []), shown)).toBeNull();
    expect(adds(health, mail)).toEqual([]);
    const open: Access = { ...mail, allow: [{ reach: { all: true, but: ["health"] }, window: null, until_ms: null }] };
    const one: Access = { ...open, allow: [...open.allow, { reach: { account: "gmail:person-a@example.com", but: [] }, window: null, until_ms: null }] };
    expect(adds(open, one, [{ account: "gmail:person-a@example.com", category: "mail" }])).toEqual([]);
    expect(adds(open, one)).toHaveLength(1);
    expect(choicesOf("agent", 3 * HOUR)).toEqual([{ answer: "once", words: "Allow for 3 hours" }, { answer: "always", words: "Always allow" }, { answer: "no", words: "Don’t allow" }]);
    expect(choicesOf("chat", null)).toEqual([{ answer: "always", words: "Allow" }, { answer: "no", words: "Don’t allow" }]);
    expect([defaultOf("agent", HOUR), defaultOf("agent", null), defaultOf("chat", HOUR)]).toEqual(["once", "always", "always"]);
    const worded = (phrase: ClockPhrase | null) => {
      expect(phrase?.flatMap((part) => (part.kind === "words" ? [part.words] : [])).join(" ") ?? "").not.toMatch(TIME_WORD);
      return phrase === null ? null : phraseText(phrase, NOW, "UTC");
    };
    const outcome = (state: Parameters<typeof outcomeOf>[0]["state"], answered_ms: number | null, device: string | null, until_ms: number | null = null) => worded(outcomeOf({ state, answered_ms, device, name: "Claude", until_ms }, NOW));
    expect(outcome("allowed", NOW - 40 * 60_000, "iPhone")).toBe("Allowed on iPhone, 11:20");
    expect(outcome("allowed", NOW - 22 * HOUR, "Mac")).toBe("Allowed on Mac, 13 Nov 14:00");
    expect(outcome("allowed", NOW, "Mac", NOW + HOUR), "an hour's answer says its end").toBe("Allowed until 13:00");
    expect(outcome("allowed", NOW - 2 * HOUR, null, NOW - HOUR), "an hour that ended says when it ended, never the answer's time").toBe("Allowed, ended 11:00");
    expect([outcome("declined", NOW, null), outcome("lapsed", null, null), outcome("open", null, null)]).toEqual(["Not allowed, 12:00", "This request is over.", null]);
    expect([worded(outcomeOf({ state: "replaced", answered_ms: NOW, device: null, name: "Claude", by: "chat" }, NOW)), worded(outcomeOf({ state: "replaced", answered_ms: NOW, device: null, name: "Claude", by: "agent" }, NOW))], "a closed card says why")
      .toEqual(["Claude’s access changed since. Ask Chat again.", "Claude asked again."]);
    expect([outcome("approved", NOW - 40 * 60_000, "iPhone"), outcome("denied", NOW, "Mac"), outcome("wrong", NOW, "iPhone")], "a sign-in's answer reads as a request's, a refusal where and when as an allow")
      .toEqual(["Allowed on iPhone, 11:20", "Not allowed on Mac, 12:00", "Wrong number, so Claude wasn’t let in. Start the sign-in again in Claude."]);
  });

  it("read an ask for always with no duration, Always its default; Once grants its duration, 1 hour for one that asked always", () => {
    const read = { read: { category: "health" as const }, window: null };
    expect([onceOf(null), onceOf(3 * HOUR)]).toEqual([HOUR, 3 * HOUR]);
    expect([wantsOf(read, null, WORDS), wantsOf(read, HOUR, WORDS)]).toEqual(["Health", "Health for 1 hour"]);
    expect([defaultOf("agent", null), defaultOf("agent", HOUR)]).toEqual(["always", "once"]);
    expect(choicesOf("agent", null)[0]).toEqual({ answer: "once", words: `Allow for ${spanWords(onceOf(null))}` });
  });

  it("tell the agent what became of its request and its drop, and why a want is held", () => {
    const wants = "Health for 1 hour";
    expect((["open", "allowed", "declined", "lapsed", "dropped"] as const).map((state) => requestWords(state, wants))).toEqual([
      "Your request (Health for 1 hour) waits for your person's answer.", "Your request (Health for 1 hour) was allowed.", "Your request (Health for 1 hour) was declined.",
      "Your request (Health for 1 hour) lapsed with no answer.", "Your request (Health for 1 hour) was dropped.",
    ]);
    expect(heldWords(NOW, NOW + 24 * HOUR, "UTC")).toBe("Declined on 14 Nov. You can ask again after 15 Nov 12:00.");
    expect(heldWords(NOW, null, "UTC")).toBe("Declined twice. Your person can change your access in Lifestream.");
    expect([droppedWords(2), droppedWords("everything"), droppedWords("request")]).toEqual(["Dropped line 2.", "Dropped everything you read.", "Dropped your request."]);
    expect([undroppableWords(4, null, 3), undroppableWords(2, "window", 3), undroppableWords(3, "hide", 3)]).toEqual([
      "Your access has no line 4: its lines are 1 to 3.",
      "Line 2 limits the time you read: dropping it would widen your access. Drop a line that allows a read.",
      "Line 3 says what stays hidden: dropping it would widen your access. Drop a line that allows a read.",
    ]);
    expect(agentText(["1. Mail · all time", "2. names hidden"], [], false, requestWords("allowed", wants)).split("\n").slice(-2))
      .toEqual(["Your request (Health for 1 hour) was allowed.", "Ask for more, or drop a line, with `access`."]);
  });

  it("word a narrowing from the one reading the sentence and the row word, each changed grant with its limits, by what went when it went whole", () => {
    const mail = (window: Access["window"], until_ms: number | null = null): Access => ({ ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window, until_ms }] });
    expect(plainOf(narrowedWords("Hermes", mail({ past_ms: 30 * DAY_MS }), mail({ past_ms: DAY_MS }), WORDS, { now_ms: NOW }))).toBe("Saved. Hermes now sees only Mail from the past 24 hours.");
    expect(plainOf(narrowedWords("Hermes", mail(null), mail(null, NOW + HOUR), WORDS, { now_ms: NOW }))).toBe("Saved. Hermes now sees only Mail until 13:00.");
    expect(plainOf(narrowedWords("Hermes", mail(null), mail(null, NOW), WORDS, { now_ms: NOW }))).toBe("Saved. Hermes now sees nothing.");
    expect(plainOf(narrowedWords("Hermes", mail(null), { ...mail(null), hide: "all" }, WORDS, { now_ms: NOW }))).toBe("Saved. Hermes now hides names and details.");
    expect(plainOf(narrowedWords("Hermes", mail(null), mail(null), WORDS, { now_ms: NOW }))).toBe("Saved. Hermes sees as before.");
    const home = [{ account: "whatsapp:15550000001", category: "messages" as const }, { account: "gmail:work-aa", category: "mail" as const }, { account: "whoop:band-01", category: "health" as const }];
    const off: Access = { ...defaultAccess(), allow: [{ reach: { all: true, but: ["messages", "health", "money"] }, window: null, until_ms: null }] };
    expect(narrowedWords("Claude", defaultAccess(), off, WORDS, { accounts: home, now_ms: NOW }), "one kind off: what went").toEqual([
      { text: "Saved. Claude no longer sees your " }, { text: "messages", bold: true }, { text: "." },
    ]);
    const week: Access = { ...defaultAccess(), allow: [{ reach: { all: true, but: ["mail", "health", "money"] }, window: null, until_ms: null }, { reach: { type: "mail", but: [] }, window: { past_ms: 7 * DAY_MS }, until_ms: null }] };
    expect(plainOf(narrowedWords("Claude", defaultAccess(), week, WORDS, { accounts: home, now_ms: NOW })), "a kind still read for less: what it sees now").toMatch(/^Saved\. Claude now sees only /u);
  });

  it("count an agent's reads: its last, today's, all since its first, and each of seven days; a kind's in thirty days", () => {
    const start = (day: number) => Date.UTC(2026, 10, day);
    const days = [8, 9, 10, 11, 12, 13, 14].map((day) => ({ day: `2026-11-${String(day).padStart(2, "0")}`, start_ms: start(day), n: day === 14 ? 1204 : day === 13 ? 3 : 0 }));
    const reads = agentReads({ last_ms: NOW - 80 * 60_000, total: 1207, first_ms: Date.UTC(2026, 9, 28, 9), days }, "UTC");
    expect(reads).toEqual({
      last_ms: NOW - 80 * 60_000, last: "10:40", line: "Read 10:40 · 1,204 reads today", short: "Read 10:40 · 1,204 today", today: 1204, total: 1207, since: "1,207 reads since 28 Oct",
      days: days.map((each) => ({ day: each.day, words: new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: "UTC" }).format(each.start_ms), n: each.n })),
    });
    expect(agentReads({ last_ms: start(13) + HOUR, total: 3, first_ms: start(13), days: days.map((each) => (each.day === "2026-11-14" ? { ...each, n: 0 } : each)) }, "UTC"))
      .toMatchObject({ last: "Yesterday", line: "Read yesterday", today: 0, since: "3 reads since 13 Nov" });
    expect(agentReads({ last_ms: start(2), total: 1, first_ms: start(2), days }, "UTC")).toMatchObject({ last: "2 Nov", line: "Read 2 Nov · 1,204 reads today", since: "1 read since 2 Nov" });
    expect(agentReads({ last_ms: null, total: 0, first_ms: null, days: days.map((each) => ({ ...each, n: 0 })) }, "UTC")).toMatchObject({ last: null, line: "Hasn’t read yet", since: null });
    expect([kindReads(0), kindReads(1), kindReads(1204)]).toEqual([{ n: 0, words: "No reads in 30 days" }, { n: 1, words: "1 read in 30 days" }, { n: 1204, words: "1,204 reads in 30 days" }]);
  });

  it("fill one of an ask's own buttons, No when an erasure left only No, and word a sign-in that ended", () => {
    expect(choicesOf("agent", HOUR, true)).toEqual([{ answer: "no", words: "Don’t allow" }]);
    for (const [by, for_ms] of [["agent", HOUR], ["agent", null], ["chat", null]] as const) {
      for (const erased of [false, true]) expect(choicesOf(by, for_ms, erased).map((each) => each.answer)).toContain(defaultOf(by, for_ms, erased));
    }
    expect(defaultOf("chat", null, true)).toBe("no");
    expect([signInOver("Claude"), signInOver(null)]).toEqual(["This sign-in is over. Start it again in Claude.", "This sign-in is over. Start it again in the app."]);
  });

  it("word what a change adds, not the grant that replaced the old one (Astra 5)", () => {
    const all = (but: ("health" | "money" | "mail")[], window: Access["window"] = null, until_ms: number | null = null): Access["allow"][number] => ({ reach: { all: true, but }, window, until_ms });
    const before: Access = { ...defaultAccess(), allow: [all(["health", "money"])] };
    const after: Access = { ...defaultAccess(), allow: [all(["money"])] };
    const difference = differenceOf(before, after, []);
    expect(difference.reads).toEqual([{ reach: { type: "health", but: [] }, window: null, until_ms: null }]);
    expect(addsOf(difference, WORDS)).toEqual(["Health"]);
    expect(chatHeadOf("Hermes", difference, WORDS)).toBe("Let Hermes also read Health?");
    const work = [{ account: "gmail:work-aa", category: "mail" as const }, { account: "gmail:home-bb", category: "mail" as const }];
    const one: Access = { ...defaultAccess(), allow: [{ reach: { account: "gmail:work-aa", but: [] }, window: null, until_ms: null }] };
    expect(addsOf(differenceOf(one, { ...one, allow: [{ reach: { type: "mail", but: [] }, window: null, until_ms: null }] }, work), WORDS)).toEqual(["Mail but work Gmail"]);
    const day: Access = { ...defaultAccess(), allow: [{ reach: { type: "mail", but: [] }, window: { past_ms: DAY_MS }, until_ms: null }] };
    const week: Access = { ...day, allow: [{ reach: { type: "mail", but: [] }, window: { past_ms: 7 * DAY_MS }, until_ms: NOW + HOUR }] };
    expect(addsOf(differenceOf(day, week, []), WORDS)).toEqual(["Mail from the past 7 days until 14 Nov 13:00"]);
    expect(addsOf(differenceOf(before, { ...before, allow: [all([])] }, []), WORDS)).toEqual(["Everything"]);
    const lifted = differenceOf({ ...before, window: { past_ms: DAY_MS } }, before, []);
    expect(addsOf(lifted, WORDS)).toEqual(["All time"]);
    expect(addsOf(differenceOf({ ...before, window: { past_ms: DAY_MS } }, { ...before, window: { past_ms: 7 * DAY_MS } }, []), WORDS)).toEqual(["Past 7 days"]);
    expect(chatHeadOf("Hermes", lifted, WORDS)).toBe("Let Hermes read more?");
  });

  it("word a category's lifted exclusion as the accounts it adds, never the accounts it already read (Astra, round 3: 2)", () => {
    const A = "gmail:person-a@example.com";
    const B = "gmail:person-b@example.com";
    const home = [{ account: A, category: "mail" as const }, { account: B, category: "mail" as const }];
    const mail = (but: string[], window: Access["window"] = null): Access => ({ ...defaultAccess(), allow: [{ reach: { type: "mail", but }, window, until_ms: null }] });
    const difference = differenceOf(mail([A]), mail([]), home);
    expect(difference.reads).toEqual([{ reach: { account: A, but: [] }, window: null, until_ms: null }]);
    expect(addsOf(difference, WORDS)).toEqual(["Gmail:person-a@example.com"]);
    expect(differenceOf(mail([A, B]), mail([B]), home).reads).toEqual([{ reach: { account: A, but: [] }, window: null, until_ms: null }]);
    expect(addsOf(differenceOf(mail([A], { past_ms: DAY_MS }), mail([]), home), WORDS)).toEqual(["Mail"]);
  });

  it("say what stays hidden by the access's hiding", () => {
    const health: Access = { ...mail, allow: [...mail.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] };
    expect(keepsOf(differenceOf(mail, health, []), health)).toBe("Details stay hidden.");
    const phones: Access = { ...health, hide: ["phone"] };
    expect(keepsOf(differenceOf(phones, { ...phones, allow: mail.allow }, []), phones)).toBe("Some details stay hidden.");
    expect(keepsOf(differenceOf(mail, { ...mail, hide: "all" }, []), { ...mail, hide: "all" })).toBe("Names and details stay hidden.");
    const open: Access = { ...health, hide: "none" };
    expect(keepsOf(differenceOf(open, { ...open, allow: mail.allow }, []), open)).toBeNull();
  });

  it("word a limit's windows and expiries, mixed too", () => {
    expect(limitWords([], "UTC")).toBe("All time");
    expect(limitWords([{ window: { past_ms: DAY_MS }, until_ms: NOW + HOUR }], "UTC")).toBe("Past 24 hours until 14 Nov 13:00");
    expect(limitWords([{ window: null, until_ms: null }, { window: { since_ms: Date.UTC(2026, 0, 1) }, until_ms: NOW + HOUR }], "UTC")).toBe("All time for most, since 1 Jan 2026 until 14 Nov 13:00 for some");
  });

  it("word a draft's relative end by its span, never as an instant, and never as one end with an absolute one", () => {
    const HOUR = 3_600_000;
    const draft: DraftAccess = {
      ...defaultAccess(), hide: "all",
      allow: [{ reach: { type: "health", but: [] }, window: null, lasts_ms: HOUR }, { reach: { type: "mail", but: [] }, window: null, until_ms: NOW + HOUR }],
    };
    expect(sentenceOf(draft, "Hermes", NAMED, { now_ms: NOW })).toBe("Hermes reads Health for 1 hour and Mail until 13:00. Names and details hidden.");
    expect(summaryOf(draft, NAMED, { now_ms: NOW })).toBe("Health for 1 hour and Mail until 13:00 · names and details hidden");
    expect(sentenceOf(draft, "Hermes", NAMED, { now_ms: NOW + 30 * DAY_MS })).toBe("Hermes reads Health for 1 hour. Names and details hidden.");
    expect(limitWords([{ window: null, lasts_ms: HOUR }], "UTC")).toBe("All time for 1 hour");
    expect(limitWords([{ window: null, lasts_ms: HOUR }, { window: null, until_ms: NOW + HOUR }, { window: null, until_ms: null }], "UTC")).toBe("All time for most, all time for 1 hour and all time until 14 Nov 13:00 for some");
  });

  it("never hide a relative end beneath an instant: the write starts it later, so it may outlast the instant", () => {
    const HOUR = 3_600_000;
    const mail = { type: "mail" as const, but: [] };
    const both: DraftAccess = { ...defaultAccess(), allow: [{ reach: mail, window: null, until_ms: NOW + HOUR }, { reach: mail, window: null, lasts_ms: HOUR }] };
    expect(sentenceOf(both, "Hermes", NAMED, { now_ms: NOW })).toContain("for 1 hour");
    expect(summaryOf(both, NAMED, { now_ms: NOW })).toContain("for 1 hour");
    const within: DraftAccess = { ...defaultAccess(), allow: [{ reach: mail, window: null, until_ms: NOW + HOUR / 2 }, { reach: mail, window: null, lasts_ms: HOUR }] };
    expect(sentenceOf(within, "Hermes", NAMED, { now_ms: NOW })).not.toContain("until");
  });

  const base = { sent: {}, read: null, result: "answered" as const, code: null, words: null, came: {}, counts: {}, withheld: [] };
  const day: Access = { ...mail, window: { past_ms: DAY_MS } };
  const line = (call: Partial<CallSeen> & { tool: string }) => callLine({ ...base, ...call }, day, "Orbit", WORDS);

  it("name a read by the question it asked, a later page by its first page's question, never Read on or Browsed", () => {
    expect(line({ tool: "search", sent: { cursor: "[[Ref 3]]" }, read: { query: "running shoes", cursor: "c-2", limit: 20 } }).words).toBe("Searched for “running shoes”");
    expect(line({ tool: "read", sent: { cursor: "[[Ref 4]]" }, read: { from: "2026-11-16", to: "2026-11-16", cursor: "c-3" } }).words).toBe("Read your day, 16 Nov");
    expect(line({ tool: "read", sent: { from: "2026-11-14", to: "2026-11-16" } }).words).toBe("Read your days, 14 – 16 Nov");
    expect(line({ tool: "read", sent: { from: "2026-10-30", to: "2026-11-02" } }).words).toBe("Read your days, 30 Oct – 2 Nov");
    expect(line({ tool: "search", sent: { from: "2026-11-14", to: "2026-11-16" } }).words).toBe("Looked through 14 – 16 Nov");
    expect(line({ tool: "search_people", sent: { cursor: "[[Ref 5]]" }, read: { name: "Person A", cursor: "c-4" } }).words).toBe("Looked up “Person A”");
    expect(line({ tool: "read", sent: { ref: ["ref-1", "ref-2"] } }).words).toBe("Read 2 things");
    expect(line({ tool: "count", sent: { of: "workouts in October" }, words: countedOf("count", { total: { n: 14 } }) }).line, "the count's number, kept with its end").toBe("Only a number came back: 14");
    expect([countedOf("count", { total: { n: 1.5 } }), countedOf("count", { found: null }), countedOf("search", { total: { n: 3 } })], "only a whole count's total is kept").toEqual([null, null, null]);
    expect(line({ tool: "count", sent: { of: "workouts in October" } })).toMatchObject({ words: "Counted “workouts in October”", line: "Only a number came back", opens: false, icon: "info" });
    expect(line({ tool: "search", sent: { query: "x".repeat(80) } }).words).toBe(`Searched for “${"x".repeat(59)}…”`);
    expect(line({ tool: "search", sent: { query: "dinner\n\tSaturday‮⁦ at  eight" } }).words, "one line, no break or direction mark").toBe("Searched for “dinner Saturday at eight”");
    expect(line({ tool: "search", sent: { query: `${"x".repeat(58)}😀😀😀` } }).words, "cut by code point, never inside a pair").toBe(`Searched for “${"x".repeat(58)}😀…”`);
    expect(line({ tool: "search", sent: { query: "‮\n" } }).words).toBe("Looked through your records");
    for (const tool of ["search", "read", "search_people", "count", "access", "feedback"]) {
      expect(line({ tool, sent: { cursor: "[[Ref 9]]" } }).words, tool).not.toMatch(/Read on|Browsed/u);
    }
  });

  it("count what came back with each plural right at one, the kinds by count, the top three", () => {
    expect(line({ tool: "search_people", sent: { name: "Person A" }, came: { person: 1 } })).toMatchObject({ words: "Looked up “Person A”", line: "1 person", icon: "person", opens: true, tone: "plain" });
    expect(line({ tool: "read", sent: { ref: "ref-1" }, came: { record: 1 } }).line).toBe("1 thing");
    expect(line({ tool: "search", sent: { query: "dentist" }, came: { mail: 1 } }).line).toBe("1 email");
    expect(line({ tool: "search", sent: { query: "flight confirmation" } }).line).toBe("Nothing found");
    expect(line({ tool: "search", sent: { query: "q" }, came: null }).line, "a read from before what came back was kept claims nothing").toBeNull();
    expect(line({ tool: "search", sent: { query: "running shoes" }, came: { messages: 40, mail: 30, photos: 26 } }).line).toBe("96 things: 40 messages, 30 emails, 26 photos");
    expect(line({ tool: "read", sent: { from: "2026-11-16", to: "2026-11-16" }, came: { plans: 9, messages: 8, places: 5, notes: 1 } }).line, "the top three of four").toBe("23 things: 9 events, 8 messages, 5 places");
    expect(readCount(1)).toBe("1 read");
    expect(cameKinds({ messages: 40 })).toEqual([{ kind: "messages", name: "Messages", icon: "message", n: 40, words: "40 messages" }]);
    expect(Object.keys(NOUNS).sort(), "a noun for every type, a line, a person and a record").toEqual([...Object.keys(TYPES), "line", "person", "record"].sort());
    expect(counted(1_204, NOUNS["device-activity"])).toBe("1,204 moments on screen");
  });

  it("say what was kept from it: details by count, names never counted as details", () => {
    expect(keptLine({ person: 2, phone: 18 })).toBe("18 details kept from it");
    expect(keptRows({ person: 2, phone: 18, address: 9, "number.bank": 3, number: 1 })).toEqual([
      { type: "names", name: "Names", value: "Shown as “a person”" },
      { type: "phone", name: "Phone numbers", value: "18" },
      { type: "address", name: "Addresses", value: "9" },
      { type: "number", name: "Account numbers", value: "4" },
    ]);
    expect(keptLine({ person: 3 })).toBe("names kept from it");
    expect(keptLine({ person: 1 })).toBe("name kept from it");
    expect(keptLine({ account: 2, face: 1 }), "accounts and faces are names").toBe("names kept from it");
    expect(keptLine({ phone: 1 })).toBe("1 detail kept from it");
    expect(keptLine({})).toBeNull();
    expect(line({ tool: "search", sent: { query: "q" }, came: { messages: 2 }, counts: { person: 1, email: 30, phone: 1 } }).kept).toBe("31 details kept from it");
    expect(Object.keys(DETAIL_NOUNS).sort()).toEqual(DETAIL_WORDS.map((each) => each.type).concat("ref").sort());
    expect(keptAbout("Orbit")).toBe("Orbit got these back as blanks.");
    expect(unshownWords([{ line: "window", n: 4, least: false }], day, WORDS)).toBe("4 more matched but weren’t shown: older than it sees");
  });

  it("word a refusal in the person's words, an unknown code as Stopped", () => {
    expect(line({ tool: "search", sent: { query: "bank statement" }, read: { query: "bank statement", families: ["money"] }, result: "refused", code: "OUTSIDE_ACCESS" }))
      .toMatchObject({ words: "Tried to search “bank statement”", line: "Stopped: Orbit can’t see Money", tone: "refused", icon: "close" });
    expect(line({ tool: "search", sent: { query: "q", products: ["whatsapp"] }, result: "refused", code: "WITHHELD" }).line).toBe("Stopped: Orbit can’t see WhatsApp");
    expect(line({ tool: "search", sent: { query: "q", families: ["calendar", "money"] }, result: "refused", code: "OUTSIDE_ACCESS" }).line).toBe("Stopped: Orbit can’t see Calendar or Money");
    expect(line({ tool: "read", sent: { ref: "ref-1" }, result: "refused", code: "OUTSIDE_ACCESS" }).line).toBe("Stopped: outside what Orbit can see");
    expect(line({ tool: "count", sent: { of: "runs" }, result: "refused", code: "TOO_BROAD" }).line).toBe("Stopped: it asked for too much at once");
    expect(line({ tool: "search", sent: { query: "q" }, result: "refused", code: "INDEX_BUILDING" })).toMatchObject({ line: "Lifestream wasn’t ready", tone: "plain", words: "Searched for “q”" });
    expect(line({ tool: "search", sent: { query: "q" }, result: "refused", code: "NO_SUCH_CODE" })).toMatchObject({ line: "Stopped", tone: "refused" });
    expect(line({ tool: "search", sent: { query: "q" }, result: "refused", code: null }).line).toBe("Stopped");
    expect(line({ tool: "search", sent: { query: "q" }, result: "running" }).line).toBe("Didn’t finish");
  });

  it("word a repeat as every hour only when every gap is about an hour", () => {
    const at = (hour: number, minute: number) => Date.UTC(2026, 10, 16, hour, minute);
    const read = (at_ms: number) => ({ at_ms, tool: "read", sent: { from: "2026-11-16", to: "2026-11-16" }, read: null, came: { messages: 8, mail: 6, plans: 4 } });
    expect(repeatWords([at(7, 40), at(8, 40), at(9, 40), at(10, 40)].map(read), WORDS))
      .toEqual({ words: "Read your day, every hour", line: "4 times, 07:40 – 10:40 · 18 things each: messages, emails, events", icon: "sync" });
    const uneven = repeatWords([at(7, 40), at(8, 40), at(9, 10), at(10, 40)].map(read), WORDS);
    expect(uneven.words).toBe("Read your day");
    expect(uneven.line).toMatch(/^4 times, 07:40 – 10:40 · /u);
    expect(repeatWords([{ ...read(at(7, 40)), came: { messages: 2 } }, read(at(8, 40))], WORDS).line).toBe("2 times, 07:40 – 08:40 · up to 18 things each: messages, emails, events");
  });

  it("word a read's page: its line, its figure, why it could, and its Show", () => {
    const now = Date.UTC(2026, 10, 16, 12);
    expect(readLine(Date.UTC(2026, 10, 16, 6, 10), Date.UTC(2026, 10, 16, 6, 11), 3, now, "UTC")).toBe("Today, 06:10 – 06:11 · asked for more 3 times");
    expect(readLine(Date.UTC(2026, 10, 15, 21, 14), Date.UTC(2026, 10, 15, 21, 14), 1, now, "UTC")).toBe("Yesterday, 21:14 · asked for more once");
    expect(readLine(Date.UTC(2026, 10, 9, 8), Date.UTC(2026, 10, 9, 8), 0, now, "UTC")).toBe("9 Nov, 08:00");
    expect([sawOf(96), sawOf(1)]).toEqual([{ n: 96, words: "things it saw" }, { n: 1, words: "thing it saw" }]);
    expect([showOf(96), showOf(1), showOf(0)]).toEqual([{ words: "Show the 96 things", n: 96 }, { words: "Show the 1 thing", n: 1 }, null]);
    expect([thingsTitle(96), goneWords(4), goneWords(1), goneWords(0), itemsKeptWords(1024)])
      .toEqual(["The 96 things", "4 of them are no longer in Lifestream.", "1 of them is no longer in Lifestream.", null, "The first 1,024 are kept."]);
    const year: Access = { ...defaultAccess(), window: { past_ms: 365 * DAY_MS }, hide: "all" };
    const why = whyOf(year, "Orbit", WORDS, { at_ms: Date.UTC(2026, 10, 16, 6, 10), now_ms: now });
    expect(why).toEqual([
      { text: "At 06:10 Orbit could see " }, { text: "everything but Health and Money", bold: true }, { text: ", from the " }, { text: "past year", bold: true },
      { text: ", with names and details hidden." },
    ]);
    expect(plainOf(whyOf(year, "Orbit", WORDS, { at_ms: Date.UTC(2026, 10, 14, 6, 10), now_ms: now })!)).toMatch(/^At 06:10 on 14 Nov Orbit could see /u);
    expect(whyOf(null, "Orbit", WORDS, { at_ms: now }), "the access of that time was erased").toBeNull();
  });

  it("make the figure's sentence of runs that rebuild it, and the quiet one", () => {
    const said = saidOf("Orbit", { messages: 41, mail: 30, photos: 26 }, ["health", "money"]);
    expect(plainOf(said)).toBe("Mostly your messages and email. Nothing from Health or Money: Orbit can’t see them.");
    expect(said.filter((run) => run.bold === true).map((run) => run.text)).toEqual(["messages", "email", "Health", "Money"]);
    expect(said.every((run, index) => index === 0 || run.bold !== said[index - 1]!.bold), "no two runs alike side by side").toBe(true);
    expect(plainOf(saidOf("Orbit", { messages: 60, mail: 30 }, ["health"]))).toBe("Mostly your messages. Nothing from Health: Orbit can’t see it.");
    expect(plainOf(saidOf("Orbit", { mail: 3 }, ["health", "money", "device-activity", "web"]))).toBe("Mostly your email. Nothing from Health or Money, and 2 more: Orbit can’t see them.");
    expect(saidOf("Orbit", {}, ["health", "money", "device-activity", "web"]).slice(-2), "at most two shut-out kinds by name").toEqual([{ text: "Money", bold: true }, { text: ", and 2 more: Orbit can’t see them." }]);
    expect(plainOf(saidOf("Orbit", {}, []))).toBe("");
    const now = Date.UTC(2026, 10, 16, 12);
    expect(quietOf({ at_ms: Date.UTC(2026, 10, 15, 20, 31), words: "Searched for “book club”" }, now, "UTC")).toEqual([
      { text: "Last read " }, { text: "yesterday 20:31", bold: true }, { text: ": it searched for “book club”." },
    ]);
    const reads = agentReads({ last_ms: now - HOUR, total: 128, first_ms: now - 3 * DAY_MS, days: [{ day: "2026-11-16", start_ms: Date.UTC(2026, 10, 16), n: 128 }] }, "UTC");
    expect(figureOf(reads, said)).toMatchObject({ today: 128, words: "reads today", said });
    expect(neverReadOf("ChatGPT", now - DAY_MS, now, "UTC")).toEqual({
      title: "ChatGPT hasn’t read anything yet",
      line: "Connected yesterday. When it reads, each read shows here: what it searched for, what it saw, and what was kept from it.",
    });
    expect(SHOW_EARLIER).toBe("Show earlier");
  });

  it("word the list's amount and place, the ask, the sign-in and the disconnect", () => {
    const now = Date.UTC(2026, 10, 16, 12);
    const reads = (today: number, last_ms: number | null) => agentReads({ last_ms, total: 1204, first_ms: Date.UTC(2026, 9, 28), days: [{ day: "2026-11-15", start_ms: Date.UTC(2026, 10, 15), n: 3 }, { day: "2026-11-16", start_ms: Date.UTC(2026, 10, 16), n: today }] }, "UTC");
    expect(amountOf(reads(128, now - HOUR), null, "UTC")).toBe("128 reads today");
    expect(amountOf(reads(0, Date.UTC(2026, 10, 15, 20)), null, "UTC")).toBe("Last read yesterday");
    expect(amountOf(reads(0, null), null, "UTC")).toBe("Hasn’t read yet");
    expect(amountOf(reads(0, null), Date.UTC(2026, 10, 14), "UTC")).toBe("Disconnected 14 Nov · its history stays");
    expect(reads(128, Date.UTC(2026, 10, 16, 10, 40)).short).toBe("Read 10:40 · 128 today");
    expect([placeOf({ kind: "agent", via: "pass", from: null }), placeOf({ kind: "agent", via: "sign-in", from: "claude.ai" }), placeOf({ kind: "agent", via: "sign-in", from: null }), placeOf({ kind: "chat", via: null, from: null })])
      .toEqual(["Key", "claude.ai", "Signed in", "Lifestream"]);
    expect(askedLine(Date.UTC(2026, 10, 16, 6, 20), Date.UTC(2026, 10, 17, 6, 20))).toEqual([
      { kind: "words", words: "Asked" }, { kind: "time", time: { kind: "clock", at_ms: Date.UTC(2026, 10, 16, 6, 20) } },
      { kind: "words", words: "· the ask ends" }, { kind: "time", time: { kind: "clock", at_ms: Date.UTC(2026, 10, 17, 6, 20) } },
    ]);
    expect(phraseText(askedLine(Date.UTC(2026, 10, 16, 6, 20), Date.UTC(2026, 10, 17, 6, 20)), now, "UTC")).toBe("Asked 06:20 · the ask ends 17 Nov 06:20");
    expect(phraseText(underLine("To plan your training week", Date.UTC(2026, 10, 16, 6, 20)), now, "UTC")).toBe("“To plan your training week” · asked 06:20");
    expect(phraseText(underLine(null, Date.UTC(2026, 10, 15, 21, 5)), now, "UTC")).toBe("Asked 15 Nov 21:05");
    expect(saysTitle("Orbit")).toBe("Orbit says");
    expect(signingInLine("chatgpt.com", Date.UTC(2026, 10, 16, 10, 52))).toEqual([{ kind: "words", words: "Signing in from chatgpt.com ·" }, { kind: "time", time: { kind: "clock", at_ms: Date.UTC(2026, 10, 16, 10, 52) } }]);
    expect(phraseText(signingInLine("chatgpt.com", Date.UTC(2026, 10, 16, 10, 52)), now, "UTC")).toBe("Signing in from chatgpt.com · 10:52");
    expect(signingInLine("chatgpt.com", Date.UTC(2026, 10, 16, 10, 52), "From chatgpt.com"), "a guide's sign-in says where it comes from, calmly").toEqual([{ kind: "words", words: "From chatgpt.com" }]);
    expect([pickWords("ChatGPT"), pickLine("ChatGPT")]).toEqual(["Pick the number ChatGPT shows", "The number is the yes. A wrong one turns ChatGPT away."]);
    expect([signInHead("ChatGPT"), signInNotice("ChatGPT")]).toEqual(["ChatGPT wants to read your Lifestream", "ChatGPT wants to read your Lifestream. Pick the number it shows."]);
    expect(disconnectingOf("Orbit", { via: "pass", made_ms: Date.UTC(2026, 9, 28) }, "Health", 1204, "UTC")).toEqual({
      head: "Disconnect Orbit?",
      line: "Orbit stops reading at once. Nothing in Lifestream is deleted.",
      stops: [
        { icon: "streams", name: "Its reads", line: "From now on Orbit can’t see your Lifestream" },
        { icon: "link", name: "Its key", line: "The key made 28 Oct stops working" },
        { icon: "needs-you", name: "Its ask for Health", line: "Turned down" },
      ],
      stays: [
        { icon: "time", name: "Its history here", line: "1,204 reads, to look back on" },
        { icon: "ai-apps", name: "What Orbit already read", line: "That stays with Orbit. Ask its maker to delete it." },
      ],
      confirm: "Disconnect Orbit",
    });
    expect(disconnectingOf("ChatGPT", { via: "sign-in", from: "chatgpt.com" }, null, 0, "UTC").stops.map((each) => each.line)).toEqual(["From now on ChatGPT can’t see your Lifestream", "The sign-in from chatgpt.com stops working"]);
  });

  it("write each access act and each change as a name and a line: who, where, what it means", () => {
    const health = { request: { read: { category: "health" } }, reason: "Your sleep." };
    const want = { want: { read: { category: "health" }, window: null }, for_ms: 3_600_000 };
    for (const [sent, read, words] of [
      [null, null, "Read its access"],
      [health, want, "Asked to see Health for 1 hour"],
      [{ ...health, for: "always" }, { ...want, for_ms: null }, "Asked to see Health"],
      [health, null, "Asked to see more"],
      [{ drop: 1, version: 4 }, null, "Gave up Mail"],
      [{ drop: 3, version: 4 }, null, "Gave up part of what it sees"],
      [{ drop: "everything" }, null, "Gave up everything"],
      [{ drop: "request" }, null, "Took back its ask"],
    ] as const) expect(line({ tool: "access", sent, read }), words).toMatchObject({ words, line: null, opens: false });
    const change = { name: "Orbit", by: "person" as const, device: "this Mac", access: null, before: null, wants: "Health for 1 hour", about: null };
    const names: Access = { ...defaultAccess(), hide: "all" };
    expect(changeWords({ ...change, what: "narrowed", before: defaultAccess(), access: names }, WORDS)).toEqual({ words: "You hid names from Orbit", line: "You, on this Mac · it sees “a person” where a name was" });
    expect(changeWords({ ...change, what: "narrowed", device: "your iPhone", before: defaultAccess(), access: mail }, WORDS)).toEqual({ words: "You narrowed what Orbit sees", line: "You, on your iPhone · Mail · details hidden" });
    expect(changeWords({ ...change, what: "widened", before: mail, access: { ...mail, allow: [...mail.allow, { reach: { type: "health", but: [] }, window: null, until_ms: null }] } }, WORDS))
      .toEqual({ words: "You let Orbit see Health", line: "You, on this Mac" });
    expect(changeWords({ ...change, what: "widened", before: names, access: defaultAccess() }, WORDS).words).toBe("You let Orbit see names");
    expect(changeWords({ ...change, what: "allowed" }, WORDS)).toEqual({ words: "You allowed Health for 1 hour", line: "You, on this Mac" });
    expect(changeWords({ ...change, what: "declined" }, WORDS)).toEqual({ words: "You didn’t allow it", line: "You, on this Mac" });
    expect(changeWords({ ...change, what: "narrowed", by: "chat", device: null, before: defaultAccess(), access: mail }, WORDS)).toEqual({ words: "Chat narrowed it", line: "In a conversation · Mail · details hidden" });
    expect(changeWords({ ...change, what: "narrowed", by: "agent", device: null, before: { ...mail, allow: [...mail.allow, { reach: { type: "plans", but: [] }, window: null, until_ms: null }] }, access: mail }, WORDS))
      .toEqual({ words: "It gave up Calendar", line: null });
    expect(changeWords({ ...change, what: "requested", by: "agent", device: null, reason: "To plan your training week", open: true }, WORDS))
      .toEqual({ words: "Asked to see Health for 1 hour", line: "“To plan your training week” · waiting for you" });
    expect(changeWords({ ...change, what: "requested", by: "chat", device: null, wants: null }, WORDS).words).toBe("Chat asked to see more");
    expect(changeWords({ ...change, what: "removed" }, WORDS)).toEqual({ words: "You disconnected Orbit", line: "You, on this Mac" });
    expect(changeWords({ ...change, what: "joined", by: "home", device: null, about: { account: "gmail:work-aa" } }, WORDS)).toEqual({ words: "Work Gmail added when you connected it", line: null });
    expect(changeWords({ ...change, what: "erased", about: { lines: [3] } }, WORDS).words).toBe("An erase removed part of what it sees");
    expect([changeWords({ ...change, what: "replaced", about: { changed: true } }, WORDS).words, changeWords({ ...change, what: "replaced", by: "agent", device: null }, WORDS).words])
      .toEqual(["Chat’s proposal closed: the access changed", "Asked again"]);
    expect((["declined", "allowed", "lapsed", "replaced"] as const).map(toldWords)).toEqual(["Was told: not allowed", "Was told: allowed", "Was told: expired", "Was told: over"]);
  });
});
