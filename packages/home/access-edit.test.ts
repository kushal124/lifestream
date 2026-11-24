import { describe, expect, it } from "vitest";
import { TYPES as CATEGORIES, type Type } from "@lifestreamprotocol/core";
import { compile, decide, parseAccess, resolve, widens, type Access, type Allow, type DraftAccess, type DraftAllow, type Window } from "@lifestreamprotocol/privacy";
import { defaultAccess, fullAccess } from "./access.js";
import { applyEdit, EditError, parseEdit, reachesScreen, viewOf, type Edit, type EditorAccount, type EditorSources } from "./access-edit.js";
import { plainOf, SCREEN } from "./access-words.js";

const NOW = Date.UTC(2026, 10, 14, 12, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WORK = "gmail:work-aa";
const HOME = "gmail:home-bb";
const CHAT = "whatsapp:phone-01";
const SCREEN_ACCOUNT = "screen:macbook-pro-0001";
const WATCH = "health:watch-01";
const BARE = "notes-x:local-01";

function account(id: string, category: Type | null, name: string, extra: Partial<EditorAccount> = {}): EditorAccount {
  return { account: id, category, name, line: null, screen: false, ...extra };
}

const SOURCES: EditorSources = {
  accounts: [
    account(WORK, "mail", "Work Gmail", { line: "person-a@work.example.com" }),
    account(HOME, "mail", "Home Gmail"),
    account(CHAT, "messages", "WhatsApp"),
    account(SCREEN_ACCOUNT, "device-activity", "Screen", { screen: true }),
    account(WATCH, "health", "Apple Watch"),
    account(BARE, null, "Notes X"),
  ],
};
const READER = { name: "Hermes", zone: "UTC", chat: false };
const EMPTY: Access = { allow: [], items: [], not: [], only: [], window: null, hide: "names", shown: [] };
const CATEGORY = new Map(SOURCES.accounts.map((each) => [each.account, each.category] as const));

const grant = (reach: Allow["reach"], window: Window = null, until_ms: number | null = null): Allow => ({ reach, window, until_ms });
const access = (allow: Allow[], rest: Partial<Access> = {}): Access => ({ ...EMPTY, allow, ...rest });
const edit = (draft: Access, change: Edit, now_ms = NOW) => applyEdit(draft, change, SOURCES, now_ms);
const view = (draft: DraftAccess, saved: Access | null = null, now_ms = NOW) => viewOf(draft, saved, SOURCES, now_ms, READER);
const mailOf = (draft: DraftAccess) => view(draft).categories.find((category) => category.type === "mail")!;
const states = (draft: Access, now_ms = NOW) => Object.fromEntries(view(draft, null, now_ms).categories.flatMap((category) =>
  [[category.type, category.state], ...category.accounts.map((each) => [each.account, each.state])]));

const LATER = (Object.keys(CATEGORIES) as Type[]).map((type) => [`later-${type}:account-01`, type] as const);
const CATEGORY_LATER = new Map<string, Type | null>([...CATEGORY, ...LATER]);

function judged(draft: Access, thing: { accounts: string[]; start_ms: number | null } | null, now_ms: number): boolean {
  const gate = compile(draft, now_ms, (id) => CATEGORY_LATER.get(id) ?? null);
  return gate === null || decide(gate, thing).allowed;
}

const reached = (draft: Access, accountId: string, start_ms: number | null = NOW - 1, now_ms = NOW) => judged(draft, { accounts: [accountId], start_ms }, now_ms);
const unresolvedReached = (draft: Access, now_ms = NOW) => judged(draft, null, now_ms);

describe("Off removes the reach from every grant that gives it", () => {
  it("a category: every all, type, explicit and one-off grant, each other grant's window and expiry kept", () => {
    const draft = access([
      grant({ all: true, but: [] }, { past_ms: 7 * DAY }),
      grant({ type: "mail", but: [] }, null, NOW + HOUR),
      grant({ account: WORK, but: [] }, { past_ms: DAY }),
      grant({ account: CHAT, but: [] }, null, NOW + HOUR),
    ]);
    const after = edit(draft, { type: "mail", on: false });
    expect(after.allow).toEqual([
      grant({ all: true, but: ["mail"] }, { past_ms: 7 * DAY }),
      grant({ account: BARE, but: [] }, { past_ms: 7 * DAY }),
      grant({ account: CHAT, but: [] }, null, NOW + HOUR),
    ]);
    expect(states(after)).toMatchObject({ mail: "off", [WORK]: "off", [HOME]: "off", messages: "on" });
    expect(reached(after, BARE)).toBe(true);
    expect(reached(after, BARE, NOW - 8 * DAY)).toBe(false);
    expect(widens(draft, after, SOURCES.accounts)).toBe(false);
  });

  it("an account: every overlapping grant is split, each keeping its window and expiry (Astra 7)", () => {
    const draft = access([
      grant({ all: true, but: ["money"] }, { past_ms: 7 * DAY }),
      grant({ type: "mail", but: [] }, null, NOW + HOUR),
      grant({ account: WORK, but: [] }),
    ]);
    const after = edit(draft, { account: WORK, on: false });
    expect(after.allow).toEqual([
      grant({ all: true, but: ["mail", "money"] }, { past_ms: 7 * DAY }),
      grant({ type: "mail", but: [WORK] }, { past_ms: 7 * DAY }),
      grant({ type: "mail", but: [WORK] }, null, NOW + HOUR),
    ]);
    expect(states(after)).toMatchObject({ mail: "some", [WORK]: "off", [HOME]: "on" });
    expect(reached(after, HOME, NOW - 8 * DAY)).toBe(true);
    expect(reached(after, HOME, NOW - 8 * DAY, NOW + 2 * HOUR)).toBe(false);
  });

  it("leaves an ended grant as it is and reads it as nothing", () => {
    const draft = access([grant({ type: "mail", but: [] }, null, NOW - HOUR), grant({ account: WORK, but: [] }, null, NOW + HOUR)]);
    expect(states(draft)).toMatchObject({ mail: "some", [WORK]: "on", [HOME]: "off" });
    expect(states(draft, NOW + 2 * HOUR)).toMatchObject({ mail: "off", [WORK]: "off" });
    expect(edit(draft, { type: "mail", on: false }).allow).toEqual([draft.allow[0]]);
  });
});

describe("one effective state", () => {
  it("reads an account On while a live grant reaches it, and Off once its one-off ends", () => {
    const draft = access([grant({ account: CHAT, but: [] }, null, NOW + HOUR)]);
    expect(states(draft)[CHAT]).toBe("on");
    expect(states(draft, NOW + 2 * HOUR)[CHAT]).toBe("off");
  });

  it("reads a category Some while an explicit account grant is live beside its exclusion (Astra 7), and says what is off", () => {
    const draft = access([grant({ all: true, but: ["mail"] }), grant({ account: WORK, but: [] }, null, NOW + HOUR)]);
    const mail = mailOf(draft);
    expect(mail).toMatchObject({ state: "some", line: "Home Gmail not read", name: "Mail", icon: "mail" });
    expect(mail.accounts.map((each) => [each.account, each.state, each.line])).toEqual([[WORK, "on", "person-a@work.example.com"], [HOME, "off", null]]);
    expect(view(draft).categories.map((category) => category.type)).toEqual(["messages", "mail", "health", "device-activity"]);
  });

  it("On lifts the exclusion that left it out, and adds a grant only for what stays unreached", () => {
    expect(edit(defaultAccess(), { type: "health", on: true }).allow).toEqual([grant({ all: true, but: ["money"] })]);
    const closed = access([grant({ account: WORK, but: [] }, { past_ms: DAY })]);
    expect(edit(closed, { type: "mail", on: true }).allow).toEqual([grant({ account: WORK, but: [] }, { past_ms: DAY }), grant({ account: HOME, but: [] })]);
    const open = access([grant({ type: "messages", but: [] }), grant({ account: WORK, but: [] }, { past_ms: DAY })]);
    expect(edit(open, { type: "mail", on: true }).allow).toEqual([grant({ type: "messages", but: [] }), grant({ account: WORK, but: [] }, { past_ms: DAY }), grant({ type: "mail", but: [WORK] })]);
    const typed = access([grant({ type: "mail", but: [WORK] }, { past_ms: DAY })]);
    expect(edit(typed, { account: WORK, on: true }).allow).toEqual([grant({ type: "mail", but: [] }, { past_ms: DAY })]);
  });

  it("the last category left out of an `all` gains a grant of its own: the `all` keeps its shape (Astra 1)", () => {
    const draft = access([grant({ all: true, but: ["health"] }, { past_ms: 7 * DAY }, NOW + HOUR)]);
    const after = edit(draft, { type: "health", on: true });
    expect(after.allow).toEqual([grant({ all: true, but: ["health"] }, { past_ms: 7 * DAY }, NOW + HOUR), grant({ type: "health", but: [] }, { past_ms: 7 * DAY }, NOW + HOUR)]);
    expect(states(after)).toMatchObject({ health: "on", [WATCH]: "on" });
    expect(reached(after, BARE)).toBe(false);
    const open = access([grant({ all: true, but: ["health"] })]);
    expect(unresolvedReached(edit(open, { type: "health", on: true }))).toBe(false);
    expect(reached(edit(open, { type: "health", on: true }), BARE)).toBe(false);
  });

  it("keeps every grant and grants only what is not reached yet: a bounded part stays bounded (Astra 3)", () => {
    const mail = access([grant({ all: true, but: ["mail"] }, { past_ms: 7 * DAY }), grant({ account: WORK, but: [] }, { past_ms: DAY })]);
    expect(edit(mail, { type: "mail", on: true }).allow).toEqual([...mail.allow, grant({ type: "mail", but: [WORK] }, { past_ms: 7 * DAY })]);
    expect(reached(edit(mail, { type: "mail", on: true }), WORK, NOW - 2 * DAY)).toBe(false);
    expect(reached(edit(mail, { type: "mail", on: true }), HOME, NOW - 2 * DAY)).toBe(true);
  });
});

describe("a view offers no presets; the edits set only what they name", () => {
  it("Past 24 hours is the time menu's: the window keeps a Mail-only agent's sources (Astra 6)", () => {
    const mailOnly = access([grant({ type: "mail", but: [] })], { hide: "all" });
    const after = edit(mailOnly, { window: { past_ms: DAY } });
    expect(after).toEqual({ ...mailOnly, window: { past_ms: DAY } });
    expect(widens(mailOnly, after, SOURCES.accounts)).toBe(false);
    expect(Object.hasOwn(view(after), "presets"), "no Start from menu: the view has no presets").toBe(false);
    expect(Object.hasOwn(view(defaultAccess()), "presets")).toBe(false);
  });

  it("names what it reads in the kinds' words, never a preset's", () => {
    expect([view(defaultAccess()).reads, view(fullAccess("names")).reads]).toEqual(["Everything but Health and Money", "Everything"]);
  });

  it("has no preset edit: a preset is refused like any shape no edit has", () => {
    expect(() => parseEdit({ preset: "everything" })).toThrow(EditError);
    expect(() => parseEdit({ preset: "default" })).toThrow(EditError);
  });
});

describe("limits", () => {
  it("reads a mixed limit as mixed, naming each window and the part that ends", () => {
    const draft = access([grant({ all: true, but: [] }), grant({ account: WORK, but: [] }, { past_ms: DAY }, NOW + HOUR)]);
    const mail = mailOf(draft);
    expect(mail.limit).toEqual({ value: { mixed: true }, words: "All time for most, past 24 hours until 14 Nov 13:00 for some" });
    expect(mail.accounts[1]!.limit).toEqual({ value: { window: null }, words: "All time" });
    expect(mailOf(access([grant({ type: "mail", but: [] }, { past_ms: DAY }, NOW + HOUR)])).limit).toEqual({ value: { window: { past_ms: DAY } }, words: "Past 24 hours until 14 Nov 13:00" });
    expect(view(draft).window).toEqual({ value: { window: null }, words: "All time" });
  });

  it("a limit picked applies to every grant of the category, keeping expiries and unrelated grants", () => {
    const draft = access([grant({ all: true, but: [] }, null, NOW + 2 * HOUR), grant({ account: WORK, but: [] }, { past_ms: DAY }, NOW + HOUR), grant({ account: CHAT, but: [] }, { past_ms: DAY })]);
    const week = { past_ms: 7 * DAY };
    const after = edit(draft, { type: "mail", window: week });
    expect(after.allow).toEqual([
      grant({ all: true, but: ["mail"] }, null, NOW + 2 * HOUR),
      grant({ account: BARE, but: [] }, null, NOW + 2 * HOUR),
      grant({ type: "mail", but: [] }, week, NOW + 2 * HOUR),
      grant({ account: WORK, but: [] }, week, NOW + HOUR),
      grant({ account: CHAT, but: [] }, { past_ms: DAY }),
    ]);
    expect(mailOf(after).limit).toEqual({ value: { window: week }, words: "Past 7 days until 14 Nov 14:00 for most, past 7 days until 14 Nov 13:00 for some" });
    const account = edit(draft, { account: HOME, window: week });
    expect(account.allow).toEqual([
      grant({ all: true, but: ["mail"] }, null, NOW + 2 * HOUR),
      grant({ account: BARE, but: [] }, null, NOW + 2 * HOUR),
      grant({ type: "mail", but: [HOME] }, null, NOW + 2 * HOUR),
      grant({ account: HOME, but: [] }, week, NOW + 2 * HOUR),
      grant({ account: WORK, but: [] }, { past_ms: DAY }, NOW + HOUR),
      grant({ account: CHAT, but: [] }, { past_ms: DAY }),
    ]);
    expect(edit(draft, { window: { since_ms: Date.UTC(2026, 0, 1) } })).toEqual({ ...draft, window: { since_ms: Date.UTC(2026, 0, 1) } });
  });
});

describe("hiding", () => {
  it("Custom keeps the effective hiding of the choice before, as its list", () => {
    expect(edit(access([], { hide: "names" }), { hide: "custom" }).hide).toEqual(["email", "phone", "address", "place", "number", "secret", "link", "word"]);
    expect(edit(access([], { hide: "all" }), { hide: "custom" }).hide).toEqual(["person", "account", "email", "phone", "address", "place", "number", "secret", "link", "word", "face"]);
    expect(edit(access([], { hide: "none" }), { hide: "custom" }).hide).toBe("none");
    expect(edit(access([], { hide: ["phone"] }), { hide: "names" }).hide).toBe("names");
  });

  it("switches a type and a subtype, refuses a fixed one, and the last type off is Nothing hidden (Astra 11)", () => {
    const custom = access([], { hide: ["number"] });
    expect(() => edit(custom, { detail: "number.bank", hidden: false })).toThrow(EditError);
    const parts = edit(edit(custom, { detail: "number", hidden: false }), { detail: "number.card", hidden: true });
    expect(parts.hide).toEqual(["number.card"]);
    expect(edit(parts, { detail: "number", hidden: true }).hide).toEqual(["number"]);
    expect(edit(parts, { detail: "number.card", hidden: false }).hide).toBe("none");
    expect(edit(access([], { hide: "none" }), { detail: "phone", hidden: true }).hide).toEqual(["phone"]);
    const drawn = view(custom).hide!;
    expect(drawn).toMatchObject({ choice: "custom", words: "Some details" });
    const number = drawn.types.find((type) => type.type === "number")!;
    expect(number).toMatchObject({ name: "Numbers", state: "hidden" });
    expect(number.subtypes.every((sub) => sub.state === "fixed")).toBe(true);
    expect(view(parts).hide!.types.find((type) => type.type === "number")!.subtypes.map((sub) => [sub.type, sub.state]).slice(0, 2)).toEqual([["number.bank", "shown"], ["number.card", "hidden"]]);
    expect(view(access([], { hide: "names" })).hide).toMatchObject({ choice: "names", words: "Details" });
  });
});

describe("refusals", () => {
  it("refuses an account not on the home or with no category, a limit on what is off", () => {
    expect(() => edit(EMPTY, { account: "gmail:other-cc", on: true })).toThrow(EditError);
    expect(() => edit(EMPTY, { account: BARE, on: true })).toThrow(EditError);
    expect(() => edit(EMPTY, { type: "mail", window: null })).toThrow(EditError);
    expect(() => edit(EMPTY, { account: WORK, window: null })).toThrow(EditError);
  });

  it("parses every edit the door offers and refuses any other shape by name", () => {
    const edits: Edit[] = [
      { mode: "only" }, { mode: "but" }, { window: { past_ms: DAY } }, { type: "mail", on: true }, { type: "mail", window: { since_ms: 0 } },
      { account: WORK, on: false }, { account: WORK, window: null },
      { hide: "custom" }, { detail: "number.bank", hidden: true },
    ];
    for (const each of edits) expect(parseEdit(JSON.parse(JSON.stringify(each)))).toEqual(each);
    for (const bad of [null, [], {}, { preset: "all" }, { preset: "past_day" }, { window: { past_ms: 0 } }, { type: "mail" }, { type: "nope", on: true }, { account: WORK, on: true, window: null },
      { hide: "some" }, { detail: "ref", hidden: true }, { later: "yes" }, { mode: "all" }, { conversation: "c1", account: CHAT, on: true },
      { not: "p-alex", on: true }, { only: "p-sam", on: false }, { drop_shown: 0 }, { drop_item: 0 }]) {
      expect(() => parseEdit(bad)).toThrow(EditError);
    }
  });
});

describe("Everything but and Only these: one field, the same rows", () => {
  it("reads Everything but while an open grant takes every kind but some, and Only these when no grant does", () => {
    expect([view(defaultAccess()).mode, view(access([grant({ type: "mail", but: [] })])).mode, view(access([])).mode]).toEqual(["but", "only", "only"]);
    expect(view(defaultAccess()).modes).toEqual([{ mode: "but", words: "Everything but" }, { mode: "only", words: "Only these" }]);
    expect([view(defaultAccess()).mode_line, view(access([grant({ type: "mail", but: [] })])).mode_line], "the picked mode's meaning, under it")
      .toEqual(["Everything you leave checked, and new connectors as you add them.", "Only what you check, nothing new."]);
    expect(view(access([grant({ all: true, but: [] }, null, NOW - 1)])).mode, "an ended grant takes nothing").toBe("only");
  });

  it("Only these keeps every row as it was and stops new kinds: each kind read becomes its own open grant, its window and end kept, a narrowing", () => {
    const draft = access([grant({ all: true, but: ["health", "device-activity"] }, { past_ms: 7 * DAY }, NOW + HOUR), grant({ account: WATCH, but: [] })]);
    const after = edit(draft, { mode: "only" });
    expect(after.allow).toEqual([
      grant({ type: "messages", but: [] }, { past_ms: 7 * DAY }, NOW + HOUR), grant({ type: "mail", but: [] }, { past_ms: 7 * DAY }, NOW + HOUR), grant({ account: WATCH, but: [] }),
    ]);
    expect(states(after)).toEqual(states(draft));
    expect(view(after).mode).toBe("only");
    expect(reached(draft, "later-plans:account-01")).toBe(true);
    expect(reached(after, "later-plans:account-01"), "a new kind is no longer read").toBe(false);
    expect(reached(after, "later-mail:account-01"), "a new account of a kind it reads still is").toBe(true);
    expect([widens(draft, after, SOURCES.accounts), widens(after, draft, SOURCES.accounts)]).toEqual([false, true]);
    const everything = edit(access([grant({ all: true, but: [] })]), { mode: "only" });
    expect(everything.allow.map((each) => each.reach), "Everything to Only these keeps an account with no category").toContainEqual({ account: BARE, but: [] });
  });

  it("Everything but keeps every row as it was and reads new kinds: the kinds read whole fold into one open grant, the rest left out of it and kept, a widening", () => {
    const draft = access([grant({ type: "mail", but: [] }), grant({ type: "messages", but: [] }), grant({ account: WATCH, but: [] }), grant({ type: "device-activity", but: [] }, { past_ms: DAY })]);
    const after = edit(draft, { mode: "but" });
    expect(after.allow).toEqual([grant({ all: true, but: ["health", "device-activity"] }), grant({ account: WATCH, but: [] }), grant({ type: "device-activity", but: [] }, { past_ms: DAY })]);
    expect(states(after)).toEqual(states(draft));
    expect(view(after).mode).toBe("but");
    expect(reached(after, "later-plans:account-01"), "a new kind is read").toBe(true);
    expect(widens(draft, after, SOURCES.accounts)).toBe(true);
    expect(edit(after, { mode: "but" }).allow, "already Everything but: nothing moves").toEqual(after.allow);
    const nothing = edit(access([]), { mode: "but" });
    expect(nothing.allow, "from nothing: every kind there now left out, new kinds read").toEqual([grant({ all: true, but: ["messages", "mail", "health", "device-activity"] })]);
    expect(states(nothing)).toEqual(states(access([])));
  });
});

describe("the view's words and warnings", () => {
  it("offers Chat no hiding: each conversation keeps its own level, and its sentence and row say none", () => {
    const chat = viewOf(fullAccess("none"), fullAccess("none"), SOURCES, NOW, { name: "Chat", zone: "UTC", chat: true });
    expect(chat).toMatchObject({ hide: null, sentence: [{ text: "Chat sees everything." }], summary: "Everything" });
    expect(view(fullAccess("none")).hide).toMatchObject({ choice: "none" });
  });

  it("offers the hiding choices and the time limits in the home's words, so no device holds them", () => {
    const drawn = view(defaultAccess());
    expect(drawn.hide!.choices).toEqual([
      { level: "none", words: "Nothing", line: "It sees names, numbers and addresses as they are", selected: false },
      { level: "names", words: "Details", line: "Phone numbers, addresses and account numbers are blanks", selected: true },
      { level: "all", words: "Names and details", line: "People are “a person”, and the details are blanks", selected: false },
      { level: "custom", words: "Choose…", line: null, selected: false },
    ]);
    expect(view({ ...defaultAccess(), hide: ["phone"] }).hide!.choices.filter((choice) => choice.selected).map((choice) => choice.level), "a list of types is Choose…").toEqual(["custom"]);
    expect(drawn.times, "widest first, the date to pick last").toEqual([
      { choice: "all", window: null, words: "All time" },
      { choice: "past", window: { past_ms: 365 * DAY }, words: "Past year" }, { choice: "past", window: { past_ms: 30 * DAY }, words: "Past 30 days" },
      { choice: "past", window: { past_ms: 7 * DAY }, words: "Past 7 days" }, { choice: "past", window: { past_ms: DAY }, words: "Past 24 hours" },
      { choice: "past", window: { past_ms: HOUR }, words: "Past hour" },
      { choice: "since", window: null, words: "Since a date…" },
    ]);
  });

  it("says inline what differs in a kind: its accounts, or its own time", () => {
    const differs = (draft: DraftAccess) => Object.fromEntries(view(draft).categories.map((category) => [category.type, category.differs]));
    expect(differs(defaultAccess())).toMatchObject({ mail: "2 accounts", messages: null, "device-activity": null });
    expect(differs(edit(defaultAccess(), { account: HOME, on: false })).mail).toBe("1 of 2 accounts");
    expect(differs(edit(defaultAccess(), { type: "messages", window: { past_ms: 7 * DAY } })).messages).toBe("Past 7 days");
    expect(differs({ ...defaultAccess(), window: { past_ms: 7 * DAY } }).messages, "the access's own time is no difference").toBeNull();
  });

  it("names each of two accounts of one name by its own line, in the sentence as in its row", () => {
    const twice: EditorSources = { ...SOURCES, accounts: [...SOURCES.accounts, account("gmail:other-cc", "mail", "Work Gmail", { line: "person-b@work.example.com" })] };
    const drawn = viewOf(access([grant({ account: WORK, but: [] }), grant({ account: "gmail:other-cc", but: [] }), grant({ account: HOME, but: [] })]), null, twice, NOW, READER);
    expect(plainOf(drawn.sentence)).toBe("Hermes sees Work Gmail (person-a@work.example.com), Work Gmail (person-b@work.example.com) and Home Gmail.");
  });

  it("writes the draft's sentence and summary, and judges widening against the saved access", () => {
    const saved = access([grant({ type: "mail", but: [] })]);
    const wider = edit(saved, { type: "messages", on: true });
    const drawn = view(wider, saved);
    expect(drawn.sentence, "the kinds it sees in bold, the hiding left to its own row").toEqual([{ text: "Hermes sees " }, { text: "Mail", bold: true }, { text: " and " }, { text: "Messages", bold: true }, { text: "." }]);
    expect(drawn.summary).toBe("Mail and Messages · details hidden");
    expect(drawn.widens).toBe(true);
    expect(drawn.widening, "a widening waits for Allow, and says what it adds").toEqual([
      { text: "Hermes would also see " }, { text: "Messages", bold: true }, { text: ". Nothing changes until you allow it." },
    ]);
    const narrower = view(edit(saved, { type: "mail", window: { past_ms: DAY } }), saved);
    expect([narrower.widens, narrower.widening]).toEqual([false, null]);
    expect([view(saved, null).widens, view(saved, null).widening], "a sign-in's draft widens from nothing, and says nothing of it").toEqual([true, null]);
  });

  it("puts each kind's reads in thirty days on its row when the view has them, and none on a draft that has none", () => {
    const counted = viewOf(defaultAccess(), defaultAccess(), SOURCES, NOW, READER, { mail: 12, messages: 1 });
    const reads = Object.fromEntries(counted.categories.map((each) => [each.type, each.reads]));
    expect(reads.mail).toEqual({ n: 12, words: "12 reads in 30 days" });
    expect(reads.messages).toEqual({ n: 1, words: "1 read in 30 days" });
    expect(Object.values(reads).filter((each) => each?.n === 0).every((each) => each!.words === "No reads in 30 days")).toBe(true);
    expect(viewOf(defaultAccess(), null, SOURCES, NOW, READER).categories.every((each) => each.reads === null)).toBe(true);
  });

  it("names the hidden details in the person's words", () => {
    const names = view(defaultAccess()).hide!.types.flatMap((each) => [each, ...each.subtypes]).map((each) => each.name);
    expect(names).toEqual(expect.arrayContaining(["ID numbers", "Words you listed", "Tax IDs"]));
    expect(names.some((each) => /ids\b|Listed words|Government/u.test(each))).toBe(false);
  });

  it("never reads a narrowing that splits an open grant as widening: privacy places the pieces by the home's accounts", () => {
    const saved = defaultAccess();
    const after = edit(saved, { account: WORK, window: { past_ms: DAY } });
    expect(widens(saved, after, SOURCES.accounts)).toBe(false);
    expect(view(after, saved).widens).toBe(false);
    expect(widens(saved, edit(saved, { type: "health", on: true }), SOURCES.accounts)).toBe(true);
    expect(widens(saved, after, [])).toBe(true);
  });

  it("shows the screen's line when the draft reaches the screen and the saved access did not, whatever made it", () => {
    const saved = defaultAccess();
    expect(reachesScreen(saved, SOURCES, NOW)).toBe(true);
    const closed = access([grant({ type: "mail", but: [] })]);
    expect(view(edit(closed, { type: "device-activity", on: true }), closed).screen).toBe(SCREEN);
    expect(view(edit(saved, { type: "health", on: true }), saved).screen).toBeNull();
    expect(view(closed, closed).screen).toBeNull();
  });
});

describe("a draft's relative end", () => {
  const lasting = (reach: Allow["reach"], window: Window = null, lasts_ms = HOUR): DraftAllow => ({ reach, window, lasts_ms });
  const drafted = (allow: DraftAllow[], rest: Partial<DraftAccess> = {}): DraftAccess => ({ ...EMPTY, allow, ...rest });
  const late = NOW + 30 * DAY;

  it("is kept by a split: every piece of a relative grant an Off cuts lasts its span, on any clock", () => {
    const draft = drafted([lasting({ all: true, but: [] })]);
    for (const now_ms of [NOW, late]) {
      const off = applyEdit(draft, { account: WORK, on: false }, SOURCES, now_ms);
      expect(off.allow).toEqual([
        lasting({ all: true, but: ["mail"] }), lasting({ account: BARE, but: [] }), lasting({ type: "mail", but: [WORK] }),
      ]);
    }
  });

  it("is kept by a limit: a window set keeps each grant's own end, relative or absolute", () => {
    const draft = drafted([lasting({ all: true, but: ["health"] }), { reach: { account: WORK, but: [] }, window: null, until_ms: NOW + HOUR }]);
    const week = { past_ms: 7 * DAY };
    expect(applyEdit(draft, { type: "mail", window: week }, SOURCES, NOW).allow).toEqual([
      lasting({ all: true, but: ["mail", "health"] }), lasting({ type: "mail", but: [] }, week), { reach: { account: WORK, but: [] }, window: week, until_ms: NOW + HOUR },
    ]);
    expect(applyEdit(draft, { account: HOME, window: week }, SOURCES, NOW).allow).toEqual([
      lasting({ all: true, but: ["mail", "health"] }), lasting({ type: "mail", but: [HOME] }), lasting({ account: HOME, but: [] }, week),
      { reach: { account: WORK, but: [] }, window: null, until_ms: NOW + HOUR },
    ]);
    expect(applyEdit(draft, { window: { past_ms: DAY } }, SOURCES, NOW)).toEqual({ ...draft, window: { past_ms: DAY } });
  });

  it("is never joined with an account turned on beside it: that account gets its own grant", () => {
    expect(applyEdit(drafted([lasting({ account: WORK, but: [] })]), { account: HOME, on: true }, SOURCES, NOW).allow).toEqual([
      lasting({ account: WORK, but: [] }), grant({ account: HOME, but: [] }),
    ]);
  });

  it("reads live on any clock, as it is not yet started: its switch on, an Off cutting it", () => {
    const draft = drafted([lasting({ account: WORK, but: [] }), { reach: { account: HOME, but: [] }, window: null, until_ms: NOW + HOUR }]);
    expect(viewOf(draft, null, SOURCES, late, READER).categories.find((each) => each.type === "mail")!.accounts.map((each) => each.state)).toEqual(["on", "off"]);
    expect(applyEdit(draft, { type: "mail", on: false }, SOURCES, late).allow).toEqual([{ reach: { account: HOME, but: [] }, window: null, until_ms: NOW + HOUR }]);
  });

  it("is worded by its span, and the view judges widening on it resolved at the clock", () => {
    const draft = drafted([lasting({ account: WORK, but: [] }, { past_ms: DAY })]);
    const drawn = viewOf(draft, null, SOURCES, late, READER);
    expect(plainOf(drawn.sentence)).toBe("Hermes sees Work Gmail for 1 hour from the past 24 hours.");
    expect(drawn.summary).toBe("Work Gmail for 1 hour · past 24 hours · details hidden");
    expect(mailOf(draft).accounts[0]!.limit).toEqual({ value: { window: { past_ms: DAY } }, words: "Past 24 hours for 1 hour" });
    const mixed = drafted([lasting({ account: WORK, but: [] }), { reach: { account: HOME, but: [] }, window: null, until_ms: NOW + HOUR }]);
    expect(mailOf(mixed).limit!.words).toBe("All time for 1 hour for most, all time until 14 Nov 13:00 for some");
    const saved = access([grant({ account: WORK, but: [] }, null, NOW + HOUR)]);
    const hour = drafted([lasting({ account: WORK, but: [] })]);
    expect(viewOf(hour, saved, SOURCES, NOW, READER).widens).toBe(false);
    expect(viewOf(hour, saved, SOURCES, NOW + HOUR / 2, READER).widens).toBe(true);
    expect(widens(saved, resolve(hour, NOW + HOUR / 2), SOURCES.accounts)).toBe(true);
  });
});

describe("the view and the rule, case by case", () => {
  it("an unresolved thing is reached only through an open grant, never through every account on", () => {
    const whole = access([grant({ type: "mail", but: [] })]);
    expect(states(whole)[WORK]).toBe("on");
    expect(unresolvedReached(whole)).toBe(false);
    expect(unresolvedReached(access([grant({ all: true, but: [] }), grant({ account: CHAT, but: [] })]))).toBe(true);
  });

  it("an unresolved thing: only an open grant, with no window, allows it; no edit turns that on", () => {
    expect(unresolvedReached(access([grant({ all: true, but: [] })]))).toBe(true);
    expect(unresolvedReached(access([grant({ all: true, but: [] })], { window: { past_ms: DAY } }))).toBe(false);
    expect(unresolvedReached(defaultAccess())).toBe(false);
    for (const change of [{ type: "health", on: true }, { type: "money", on: true }] as Edit[]) {
      expect(unresolvedReached(edit(access([grant({ all: true, but: ["health"] }), grant({ type: "money", but: [] })]), change))).toBe(false);
    }
  });

  it("a record with no time is reached only where no window stands", () => {
    const draft = access([grant({ type: "mail", but: [] }), grant({ type: "messages", but: [] }, { past_ms: DAY })]);
    expect(reached(draft, WORK, null)).toBe(true);
    expect(reached(draft, CHAT, null)).toBe(false);
    expect(reached({ ...draft, window: { past_ms: 7 * DAY } }, WORK, null)).toBe(false);
    expect(reached(edit(draft, { type: "mail", window: { past_ms: DAY } }), WORK, null)).toBe(false);
  });

  it("an account connected later is reached through an open grant of its kind, never through an account grant", () => {
    const draft = access([grant({ type: "mail", but: [WORK] }), grant({ account: CHAT, but: [] })]);
    expect(reached(draft, "later-mail:account-01")).toBe(true);
    expect(reached(draft, "later-messages:account-01")).toBe(false);
  });

  it("a view says nothing of sources added later: the mode line says it", () => {
    expect(Object.keys(view(defaultAccess()))).not.toContain("later");
    expect(() => parseEdit({ later: true }), "the edit is gone").toThrow(EditError);
  });
});

describe("seeded cases over random accesses and edits", () => {
  const TYPES: Type[] = ["mail", "messages", "health", "device-activity", "money"];
  const ACCOUNTS = SOURCES.accounts.filter((each) => each.category !== null);
  const pick = <T>(random: () => number, values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
  const some = <T>(random: () => number, values: readonly T[]): T[] => values.filter(() => random() < 0.3);

  function randomGrant(random: () => number): Allow {
    const window = pick<Window>(random, [null, { past_ms: 2 * DAY }, { since_ms: NOW - 10 * DAY }]);
    const ends = pick(random, [null, null, NOW + HOUR, NOW - HOUR, NOW + 3 * HOUR]);
    const kind = pick(random, ["all", "all", "type", "account", "bare"]);
    if (kind === "all") return grant({ all: true, but: some(random, TYPES) }, window, ends);
    if (kind === "type") {
      const type = pick(random, TYPES);
      return grant({ type, but: some(random, ACCOUNTS.filter((each) => each.category === type).map((each) => each.account)) }, window, ends);
    }
    if (kind === "account") return grant({ account: pick(random, ACCOUNTS).account, but: [] }, window, ends);
    return grant({ account: BARE, but: [] }, window, ends);
  }

  function randomAccess(random: () => number): Access {
    return access(Array.from({ length: Math.floor(random() * 5) }, () => randomGrant(random)), {
      window: pick<Window>(random, [null, null, null, { past_ms: 7 * DAY }]),
    });
  }

  function randomEdit(random: () => number): Edit {
    const on = random() < 0.5;
    const window = pick<Window>(random, [null, { past_ms: DAY }, { since_ms: NOW - 3 * DAY }]);
    return pick<() => Edit>(random, [
      () => ({ type: pick(random, TYPES), on }), () => ({ account: pick(random, ACCOUNTS).account, on }),
      () => ({ type: pick(random, TYPES), window }), () => ({ account: pick(random, ACCOUNTS).account, window }),
    ])();
  }

  interface Place { account: string; later?: Type }
  const PLACES: Place[] = [
    ...SOURCES.accounts.map((each): Place => ({ account: each.account })),
    ...LATER.map(([id, type]): Place => ({ account: id, later: type })),
  ];
  const TIMES = [NOW - 1, NOW - 4 * DAY, NOW - 30 * DAY, null];
  const CLOCKS = [NOW, NOW + 2 * HOUR];

  function named(change: Edit, place: Place): boolean {
    if ("type" in change) return CATEGORY_LATER.get(place.account) === change.type;
    if ("account" in change) return place.account === change.account;
    return false;
  }

  function viewMatches(after: Access, context: string): void {
    const drawn = view(after);
    for (const category of drawn.categories) {
      for (const row of category.accounts) {
        const allowed = reached(after, row.account);
        expect(row.state, `${context} ${row.account}`).toBe(allowed ? "on" : "off");
      }
      const each = category.accounts.map((row) => row.state);
      expect(category.state, context).toBe(each.every((state) => state === "on") ? "on" : each.every((state) => state === "off") ? "off" : "some");
    }
  }

  function check(draft: Access, change: Edit): Access | null {
    let after: Access;
    try {
      after = edit(draft, change);
    } catch (error) {
      expect(error).toBeInstanceOf(EditError);
      return null;
    }
    expect(parseAccess(after)).toEqual(after);
    const context = JSON.stringify({ draft, change });
    viewMatches(after, context);
    for (const clock of CLOCKS) if (unresolvedReached(after, clock)) expect(unresolvedReached(draft, clock), context).toBe(true);
    const on = "on" in change ? change.on : null;
    for (const place of PLACES) {
      const where = `${context} at ${JSON.stringify(place)}`;
      const was = reached(draft, place.account);
      for (const clock of CLOCKS) {
        for (const time of TIMES) {
          const before = reached(draft, place.account, time, clock);
          const now = reached(after, place.account, time, clock);
          const why = `${where} ${time} ${clock}`;
          if (!named(change, place)) {
            expect(now, why).toBe(before);
          } else if (on === false) {
            expect(now, why).toBe(false);
          } else if ("window" in change) {
            const reachedAnyTime = reached({ ...draft, allow: draft.allow.map((each) => ({ ...each, window: null })) }, place.account, time, clock);
            const inside = change.window === null || (time !== null && ("since_ms" in change.window ? time >= change.window.since_ms : time >= clock - change.window.past_ms));
            expect(now, why).toBe(reachedAnyTime && inside);
          } else if (was && place.later === undefined) {
            expect(now, why).toBe(before);
          } else if (before) {
            expect(now, why).toBe(true);
          }
        }
      }
      if (on === true && place.later === undefined && named(change, place)) expect(reached(after, place.account), where).toBe(true);
    }
    if (on === false) expect(widens(draft, after, SOURCES.accounts), context).toBe(false);
    return after;
  }

  it("the view says what the rule reaches, an edit changes only what it names, an On keeps what was reached, an Off never widens", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    for (let round = 0; round < 120; round++) {
      let draft = randomAccess(random);
      for (let step = 0; step < 6; step++) draft = check(draft, randomEdit(random)) ?? draft;
    }
  });

  it("holds every edit to the same over the shapes the editor makes: a split open grant, a one-off, a type with an account out", () => {
    const shapes: Access[] = [
      access([grant({ account: CHAT, but: [] }, { past_ms: 2 * DAY }, NOW + HOUR)]),
      access([grant({ all: true, but: ["messages", "health", "money"] }), grant({ type: "messages", but: [CHAT] }), grant({ account: CHAT, but: [] }, { past_ms: 2 * DAY })]),
      access([grant({ type: "mail", but: [WORK] }), grant({ account: WORK, but: [] }, null, NOW + HOUR)]),
      { ...defaultAccess(), window: { past_ms: 7 * DAY } },
    ];
    const windows: Window[] = [null, { past_ms: DAY }];
    const edits: Edit[] = [
      ...TYPES.flatMap((type): Edit[] => [{ type, on: true }, { type, on: false }, ...windows.map((window) => ({ type, window }))]),
      ...ACCOUNTS.flatMap(({ account: id }): Edit[] => [{ account: id, on: true }, { account: id, on: false }, ...windows.map((window) => ({ account: id, window }))]),
    ];
    for (const shape of shapes) for (const change of edits) check(shape, change);
  });
});
