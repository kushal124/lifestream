import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RELEASE, sha256 } from "@lifestreamprotocol/core";
import { describe as group, expect, expectTypeOf, it } from "vitest";
import { ContractError } from "./search-contract.js";
import { contractVersion, day, object, pageETag, PAGES, text, When, type AnswerOf, type PageContract } from "./pages.js";

const ROW = { id: "person:a", name: "Person A", named: true, face: false, photo: null, when: { kind: "day", day: "2026-11-20" }, line: null, find: ["person a", "+15550000001"] };
const FRAME = { position: "12:1763700000000", today: "2026-11-21" };
const MONTH = { days: Array.from({ length: 30 }, (_, index) => ({ day: `2026-10-${String(index + 1).padStart(2, "0")}`, count: index })), count: 435, calls: { count: 0, words: "No calls" }, line: "41 messages", before: { day: "2026-08-06", joiner: " · before that, " } };
const LINE = { who: "person:a", name: "Person A", text: "Synthetic line", forwarded: false, at_ms: 1700000000000, mine: false, n: 12 };
const HISTORIES = [
  { kind: "weeks", weeks: [{ start: "2026-11-09", count: 0, day: null }, { start: "2026-11-16", count: 4, day: "2026-11-17" }], marked: 1 },
  { kind: "years", years: [{ year: "2025", count: 30, day: "2025-03-14" }, { year: "2026", count: 2, day: "2026-11-17" }], total: 32, marked: 0 },
  { kind: "facts", total: 5, first: "2021-03-14" },
] as const;

const ANSWERS = {
  people: {
    ...FRAME,
    you: { ...ROW, id: "person:you", name: "You", line: "You", when: null },
    counts: { people: 41, groups: 1 },
    most: [{ id: "person:a", line: "41 messages" }],
    sections: [{ key: "month:2026-11", title: null, rows: [ROW] }, { key: "none", title: "No messages yet", rows: [{ ...ROW, id: "person:b", when: null, line: "Contact card" }] }],
    ai: [],
    new: [{ id: "person:a", line: "New · 3 messages" }],
    businesses: { line: "1 to accept", offered: [{ id: "person:b", name: "Shop B", named: true, photo: null, why: "Listed as a business on WhatsApp", handles: [{ id: "phone:+15550000002", words: "+1 555 000 0002" }] }] },
    organise: { count: 2, line: "2 to organise", queue: ["person:b"], organised: 40, often: 3 },
    groups: { yours: [{ chat: "chat:g1", title: "Group One", photo: null, when: { kind: "month", month: "2026-10" }, line: null, find: ["group one"] }], quiet: [], quiet_line: null },
    counting: false,
  },
  person: {
    ...FRAME,
    became: null,
    me: false,
    head: {
      name: "Person A", named: true, full_name: "Person A Synthetic", photo: null, chips: [{ kind: "birthday", month: 3, day: 5 }, { kind: "profile", network: "github", words: "person-a", href: null }],
      since: { kind: "at", at_ms: 1700000000000 }, relationship: null, work: null, entity: "business", entity_by: "you",
    },
    handles: [{ id: "phone:+15550000001", kind: "phone", network: null, words: "+1 555 000 0001", from: "Contacts", own: false }],
    month: MONTH,
    history: HISTORIES[0],
    talk: { day: "2026-11-20", chat: "chat:a", title: "Person A", group: false, network: "WhatsApp", lines: [LINE], folded: [{ line: "2 messages", lines: [LINE, { ...LINE, forwarded: true, n: 13 }] }], focus: "a12" },
    where: [
      { chat: "chat:a", title: "WhatsApp", group: false, network: "WhatsApp", when: { kind: "at", at_ms: 1700000000000 }, count: 41, line: "41 messages", quiet: false },
      { chat: null, title: "Mail", group: false, network: "Mail", when: null, count: 3, line: "3 mails", quiet: false },
      { chat: "chat:g1", title: "Group One", group: true, network: "WhatsApp", when: { kind: "at", at_ms: 1700000000000 }, count: 2, line: "2 messages", quiet: true },
    ],
    suggestions_line: "2 suggestions",
    edit: {
      call: "Person A", full_name: "Person A Synthetic", name_from: "WhatsApp", record_id: "slug-a", face: false, reach: "WhatsApp and Mail",
      last: { kind: "at", at_ms: 1700000000000 }, much: "41 messages · 3 mails", mails: { from: 2, to: 1, newest: [{ family: "mail", title: "Synthetic subject", from: "Person A", day: "2026-11-02" }] },
      record: null, details: { work: null, birthday: null, profiles: [{ network: "instagram", value: "person.a" }], cleared: [] },
      suggestions: [
        { id: "s1", kind: "same", value: "person-a2", reasons: [{ reason: "named", count: 1 }], ticked: false, other: { id: "person:person-a2", name: "Person A", photo: null, named: true, face: true } },
        { id: "s2", kind: "work", value: "Synthetic Work", reasons: [{ reason: "cards", count: 2 }], ticked: true, other: null },
      ],
      also_called: [], names_seen: [], joined: [],
    },
    counting: true,
  },
  group: {
    ...FRAME,
    head: { title: "Group One", photo: null, line: "WhatsApp group · 2 people", since: null, word: "rule", quiet: true, why: { words: "You last wrote", since: { kind: "day", day: "2026-08-06" } } },
    total: 41,
    writers: [{ id: "person:a", name: "Person A", named: true, photo: "photo-a", share: "30 messages" }, { id: "person:b", name: "Person B", named: false, photo: null, share: "4 messages" }],
    yours: "17%",
    talk: null,
    counting: false,
  },
  peopleFind: { ...FRAME, rows: [ROW], profiles: [{ network: "instagram", value: "person.a" }, { network: "x", value: "person.a" }] },
} as const;

const page = (today: boolean, device: boolean): PageContract<unknown> => ({
  route: "/v1/page/demo", shape: object({ position: text(), today: day }) as never, today, device, moves: today ? ["today"] : [], settled: null, models: false,
});

group("PAGES' shapes", () => {
  it("parse an answer of each People page", () => {
    for (const name of ["people", "person", "group", "peopleFind"] as const) expect(PAGES[name].shape.parse(ANSWERS[name])).toEqual(ANSWERS[name]);
  });

  it("parse each form of a person's history, and refuse one of no form", () => {
    for (const history of HISTORIES) expect(PAGES.person.shape.parse({ ...ANSWERS.person, history })).toMatchObject({ history });
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, history: { kind: "days", days: [] } })).toThrow("$.history.kind: wants one of weeks, years, facts");
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, history: { ...HISTORIES[1], years: HISTORIES[1].years.slice(1) } })).toThrow("$.history.years: wants");
  });

  it("refuse a kind said by no one the contract names, and a same suggestion's other side without its face", () => {
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, head: { ...ANSWERS.person.head, entity_by: "model" } })).toThrow('$.head.entity_by: wants one of "you", "home"');
    const { face: _face, ...faceless } = ANSWERS.person.edit.suggestions[0].other;
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, edit: { ...ANSWERS.person.edit, suggestions: [{ ...ANSWERS.person.edit.suggestions[0], other: faceless }] } }))
      .toThrow(new ContractError("$.edit.suggestions[0].other.face", "is missing"));
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, month: { ...MONTH, before: "2026-08-06" } })).toThrow("$.month.before: wants an object");
  });

  it("hold Edit's members: mails not read yet as null, a suggestion's other side, never a missing one", () => {
    const edit = ANSWERS.person.edit;
    expect(PAGES.person.shape.parse({ ...ANSWERS.person, edit: { ...edit, mails: { ...edit.mails, newest: null } } })).toMatchObject({ edit: { mails: { newest: null } } });
    const { other: _other, ...bare } = edit.suggestions[0];
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, edit: { ...edit, suggestions: [bare] } })).toThrow(new ContractError("$.edit.suggestions[0].other", "is missing"));
  });

  it("refuse a month of other than 30 days", () => {
    expect(() => PAGES.person.shape.parse({ ...ANSWERS.person, month: { ...MONTH, days: MONTH.days.slice(1) } })).toThrow("$.month.days: wants 30 to 30 members, has 29");
  });

  it("refuse a nullable member left out: absent is null, said", () => {
    const { you: _you, ...without } = ANSWERS.people;
    expect(() => PAGES.people.shape.parse(without)).toThrow(new ContractError("$.you", "is missing"));
  });

  it("refuse a member no page states", () => {
    expect(() => PAGES.peopleFind.shape.parse({ ...ANSWERS.peopleFind, total: 1 })).toThrow(new ContractError("$.total", "is no member of this shape"));
  });

  it("hold a time as a When, never a number standing for none", () => {
    expect(When.parse({ kind: "at", at_ms: 1 })).toEqual({ kind: "at", at_ms: 1 });
    expect(() => When.parse({ kind: "day" })).toThrow(new ContractError("$.day", "is missing"));
    expect(() => When.parse({ kind: "week", week: "2026-W47" })).toThrow("$.kind: wants one of day, month, at");
    expect(() => PAGES.peopleFind.shape.parse({ ...ANSWERS.peopleFind, rows: [{ ...ROW, when: 0 }] })).toThrow("$.rows[0].when: wants an object, has 0");
  });

  it("type a settled page's counting and leave it off a page with none", () => {
    expectTypeOf<AnswerOf<"people">["counting"]>().toEqualTypeOf<boolean>();
    expectTypeOf<AnswerOf<"people">["you"]>().toEqualTypeOf<{ id: string; name: string; named: boolean; face: boolean; photo: string | null; when: When | null; line: string | null; find: string[] } | null>();
    expectTypeOf<keyof AnswerOf<"peopleFind">>().toEqualTypeOf<"position" | "today" | "rows" | "profiles">();
    expectTypeOf<AnswerOf<"people">["counts"]>().toEqualTypeOf<{ people: number; groups: number }>();
    expectTypeOf<AnswerOf<"person">["head"]["entity_by"]>().toEqualTypeOf<"you" | "home" | null>();
  });
});

group("the ETag rule", () => {
  const ask = { today: "2026-11-21", device: "phone" } as const;

  it("moves with each input the page names, and with their order", () => {
    const today = page(true, false);
    const base = pageETag(today, ask, ["sha256:a", "sha256:b"], "sha256:contract");
    expect(pageETag(today, ask, ["sha256:a", "sha256:b"], "sha256:contract")).toBe(base);
    expect(pageETag(today, ask, ["sha256:a", "sha256:c"], "sha256:contract")).not.toBe(base);
    expect(pageETag(today, ask, ["sha256:c", "sha256:b"], "sha256:contract")).not.toBe(base);
    expect(pageETag(today, ask, ["sha256:b", "sha256:a"], "sha256:contract")).not.toBe(base);
    expect(pageETag(today, ask, ["sha256:a"], "sha256:contract")).not.toBe(base);
    expect(base).toMatch(/^"[0-9a-f]{64}"$/u);
  });

  it("moves with today only on a page that depends on it", () => {
    const next = { ...ask, today: "2026-11-22" };
    expect(pageETag(page(true, false), next, ["sha256:a"], "sha256:contract")).not.toBe(pageETag(page(true, false), ask, ["sha256:a"], "sha256:contract"));
    expect(pageETag(page(false, false), next, ["sha256:a"], "sha256:contract")).toBe(pageETag(page(false, false), ask, ["sha256:a"], "sha256:contract"));
  });

  it("moves with the asking device's kind only on a page that depends on it", () => {
    const mac = { ...ask, device: "mac" } as const;
    expect(pageETag(page(false, true), mac, ["sha256:a"], "sha256:contract")).not.toBe(pageETag(page(false, true), ask, ["sha256:a"], "sha256:contract"));
    expect(pageETag(page(false, true), { ...ask, device: null }, ["sha256:a"], "sha256:contract")).not.toBe(pageETag(page(false, true), ask, ["sha256:a"], "sha256:contract"));
    expect(pageETag(page(false, false), mac, ["sha256:a"], "sha256:contract")).toBe(pageETag(page(false, false), ask, ["sha256:a"], "sha256:contract"));
  });

  it("moves with the contract version, which is the digest of contract/pages.json", () => {
    expect(pageETag(page(false, false), ask, ["sha256:a"], "sha256:one")).not.toBe(pageETag(page(false, false), ask, ["sha256:a"], "sha256:two"));
    const file = readFileSync(fileURLToPath(new URL("./contract/pages.json", import.meta.url)), "utf8");
    expect(contractVersion()).toBe(sha256(file));
    expect(pageETag(PAGES.people, ask, ["sha256:a"])).toBe(pageETag(PAGES.people, ask, ["sha256:a"], sha256(file)));
  });

  it("moves with the home's release, so a rule fixed in an update reaches an answer whose inputs never change", () => {
    expect(pageETag(page(false, false), ask, ["sha256:a"], "sha256:contract", "release-one")).not.toBe(pageETag(page(false, false), ask, ["sha256:a"], "sha256:contract", "release-two"));
    expect(pageETag(PAGES.people, ask, ["sha256:a"])).toBe(pageETag(PAGES.people, ask, ["sha256:a"], contractVersion(), RELEASE));
  });
});
