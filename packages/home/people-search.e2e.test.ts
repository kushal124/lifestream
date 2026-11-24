import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it, vi } from "vitest";
import { DAYS_MARK, openHome, openHomeFolder, sha256, type DaySettings, type ExtractRow, type Json, type JsonObject } from "@lifestreamprotocol/core";
import { buildLabels, CALLS_COLLECTIONS, healthFamily, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, renderDay, sameIdOf, tableUnits, type DayAtom, type DayDocument, type DayFileFact, type Family, type PersonDetail, type Searched } from "@lifestreamprotocol/families";
import { ErasableStreams } from "./erasable-streams.js";
import { BRIEF_LINES, briefOf } from "./brief.js";
import { HomeFile } from "./home-file.js";
import { HOME_FILE, HOME_FORMAT } from "./lifecycle.js";
import { isNear, PEOPLE_SEARCH_MATCHES, peopleSearchOf, type Elsewhere, type PeopleSearchCounts, type PeopleSearchInput } from "./people.js";
import { PeopleCounts, type CountContext, type Reach, type Subject } from "./counting.js";
import { makeRef, personRef as refOf, readRef } from "./refs.js";
import { answerOf as contractOf } from "./search-contract.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { Refusal } from "./refusal.js";
import { openReads, type Reply } from "./reads.js";
import { peoplePlace } from "./people-search.js";
import { GIVEN_MOST, NEXT_CHARS, sealed } from "./cursor-text.js";
import type { Registry } from "./registry.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import type { Settings } from "./settings.js";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "12:00") => Date.parse(`${day}T${time}:00Z`);
const dir = mkdtempSync(join(tmpdir(), "lifestream-who-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));


const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function person(id: string, name: string, handles: string[], over: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id, name, call_name: name.split(" ")[0]!, full_name: name, show: "full_name", by: "card", person: null, entity: "person", entity_by: "home", relationship: null, me: false,
    hidden: false, organised: false, card: true, photo: null, score: 1, networks: [], chats: [], received: 0, sent: 0, mails_from: 0, mails_to: 0, first_ms: null,
    last_ms: null, last_30: 0, days_count: 0, last_day: 0, days: {}, suggestions: [], names_seen: [], also_called: [], record: null,
    handles: handles.map((handle) => ({ id: handle, kind: handle.slice(0, handle.indexOf(":")), network: null, words: handle, from: null })), ...over,
  } as PersonDetail;
}
function searchedOf(detail: PersonDetail): Searched {
  return {
    id: detail.id, words: [...new Set([detail.name, detail.full_name ?? "", ...detail.names_seen, ...detail.also_called.map(({ name }) => name)].flatMap((name) => fold(name).split(/[^\p{L}\p{N}]+/u)).filter(Boolean))],
    values: detail.handles.map((handle) => fold(handle.id.slice(handle.id.indexOf(":") + 1))),
    phones: detail.handles.flatMap((handle) => (handle.kind === "phone" ? [handle.id.slice("phone:+".length)] : [])),
  };
}

const T1 = person("person:tushar-a", "Tushar Example", ["phone:+15550000101"]);
const T2 = person("person:tushar-b", "Tushar Sample", ["phone:+15550000102", "email:tushar@example.com"]);
const ADA = person("person:ada", "Ada Lovelace-Example", ["phone:+15550000001"], { names_seen: ["Addie"] });
const EVERYONE = [ADA, T1, T2];

function input(reach: Record<string, Reach>, elsewhere: Elsewhere[] = [], everyone: readonly PersonDetail[] = EVERYONE): PeopleSearchInput & PeopleSearchCounts & { asked: string[]; reached: string[] } {
  const asked: string[] = [];
  const reached: string[] = [];
  const byId = new Map(everyone.map((each) => [each.id, each]));
  return {
    asked, reached,
    searched: everyone.map(searchedOf),
    person: (id) => byId.get(id),
    idOf: (id) => (byId.has(id) ? id : everyone.find((each) => each.handles.some((handle) => handle.id === id))?.id),
    chats: [{ key: "whatsapp:120363@g.us", group: true, label: "Tushar's birthday" }, { key: "whatsapp:15550000101@s.whatsapp.net", group: false, label: "Tushar Example" }],
    reach: (of) => {
      reached.push("person" in of ? of.person : of.chat);
      return { reach: reach["person" in of ? of.person : of.chat] ?? {}, chats: [] };
    },
    touch: (of) => of.map((each) => Object.values(reach["person" in each ? each.person : each.chat] ?? {}).reduce((sum, [n]) => sum + n, 0)),
    counted(count) {
      return count({ touch: (of) => this.touch(of), reach: (of) => this.reach(of) });
    },
    elsewhere: (name, words) => {
      asked.push(`${name}:${words}`);
      return elsewhere.filter((each) => words || each.as !== "words");
    },
  };
}

const answerOf = (asked: Parameters<typeof peopleSearchOf>[0], given: PeopleSearchInput & PeopleSearchCounts) => peopleSearchOf(asked, given);

describe("search_people", () => {
  const REACH: Record<string, Reach> = {
    "person:tushar-a": { messages: [40, "2019-02-01", "2021-06-30"], calls: [3, "2019-03-01", "2020-01-01"] },
    "person:tushar-b": { messages: [400, "2024-03-04", "2026-11-13"] },
    "person:ada": { calls: [2, "2025-01-01", "2025-02-01"] },
  };

  it("W8 of many matches, only the page's reach is read, the most in touch first; the rest are left to the next page", () => {
    const many = Array.from({ length: PEOPLE_SEARCH_MATCHES + 3 }, (_, at) => person(`person:sam-${at}`, `Sam Example${at}`, [`phone:+155500002${String(at).padStart(2, "0")}`]));
    const reach = Object.fromEntries(many.map((each, at) => [each.id, { messages: [at + 1, "2026-10-01", "2026-10-02"] as [number, string, string] }]));
    const given = input(reach, [], many);
    const answer = peopleSearchOf({ name: "sam" }, given)!;
    const expected = many.map((each) => each.id).reverse().slice(0, PEOPLE_SEARCH_MATCHES);
    expect(answer.matches.map((match) => match.id)).toEqual(expected);
    expect(answer.next).toBeDefined();
    expect(given.reached).toEqual(expected);
  });

  it("W11 a read that spends its budget answers capped: those it did not count after those it did, in People's order, with no reach", () => {
    const many = Array.from({ length: 6 }, (_, at) => person(`person:sam-${at}`, `Sam Example${at}`, [`phone:+155500003${String(at).padStart(2, "0")}`]));
    const reach = Object.fromEntries(many.map((each, at) => [each.id, { messages: [at + 1, "2026-10-01", "2026-10-02"] as [number, string, string] }]));
    const given = input(reach, [], many);
    const answer = answerOf({ name: "sam" }, { ...given, touch: (of) => of.map((_, at) => (at < 3 ? at + 1 : undefined)) })!;
    expect(answer.matches.map((match) => [match.id, match.capped])).toEqual([
      ["person:sam-2", undefined], ["person:sam-1", undefined], ["person:sam-0", undefined],
      ["person:sam-3", true], ["person:sam-4", true], ["person:sam-5", true],
    ]);
    expect(answer.capped).toBe(true);
    expect(given.reached).toEqual(["person:sam-2", "person:sam-1", "person:sam-0"]);
    expect(answer.matches.slice(3).every((match) => Object.keys(match.reach).length === 0 && match.chats.length === 0)).toBe(true);
    const out = answerOf({ name: "sam" }, { ...given, reach: () => undefined })!;
    expect(out.capped).toBe(true);
    expect(out.matches.every((match) => match.capped === true && Object.keys(match.reach).length === 0)).toBe(true);
    expect(peopleSearchOf({ name: "sam" }, given)!.capped).toBeUndefined();
  });

  it("S4 ten a page: next holds every match given, those given with no counts too; nothing is given twice and the walk ends", () => {
    const many = Array.from({ length: PEOPLE_SEARCH_MATCHES + 3 }, (_, at) => person(`person:sam-${at}`, `Sam Example${at}`, [`phone:+155500004${String(at).padStart(2, "0")}`]));
    const reach = Object.fromEntries(many.map((each, at) => [each.id, { messages: [at + 1, "2026-10-01", "2026-10-02"] as [number, string, string] }]));
    const given = input(reach, [], many);
    const ids = (answer: ReturnType<typeof peopleSearchOf>) => answer!.matches.map((match) => match.id);
    const first = peopleSearchOf({ name: "sam" }, given)!;
    expect(first.next).toEqual({ given: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12] });
    const second = peopleSearchOf({ name: "sam", page: first.next! }, given)!;
    expect(ids(second)).toEqual(["person:sam-2", "person:sam-1", "person:sam-0"]);
    expect(second.next).toBeUndefined();
    expect([...ids(first), ...ids(second)].sort()).toEqual(many.map((each) => each.id).sort());
    const capped = answerOf({ name: "sam" }, { ...given, touch: (of) => given.touch(of).map((n, at) => (at < 3 ? n : undefined)) })!;
    expect(capped.capped).toBe(true);
    expect(capped.matches.filter((match) => match.capped === true).map((match) => match.id)).toEqual(many.slice(3, PEOPLE_SEARCH_MATCHES).map((each) => each.id));
    expect(capped.next).toEqual({ given: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] });
    const after = peopleSearchOf({ name: "sam", page: capped.next! }, given)!;
    expect(ids(after)).toEqual(many.slice(PEOPLE_SEARCH_MATCHES).map((each) => each.id).reverse());
    expect(after.capped).toBeUndefined();
    expect(after.next).toBeUndefined();
    const out = { ...given, touch: (of: readonly ({ person: string } | { chat: string })[]) => of.map(() => undefined) };
    const pages: string[][] = [];
    let page: ReturnType<typeof peopleSearchOf>;
    let next: { given: number[] } | undefined;
    do {
      page = answerOf({ name: "sam", ...(next === undefined ? {} : { page: next }) }, out)!;
      pages.push(ids(page));
      next = page.next;
    } while (next !== undefined && pages.length < 5);
    expect(pages).toEqual([many.slice(0, PEOPLE_SEARCH_MATCHES).map((each) => each.id), many.slice(PEOPLE_SEARCH_MATCHES).map((each) => each.id), []]);
    expect(page!.capped).toBeUndefined();
    const unread = { ...given, reach: () => undefined };
    const one = answerOf({ id: many[0]!.id }, unread)!;
    expect(one).toMatchObject({ capped: true, next: { given: [0] } });
    expect(answerOf({ id: many[0]!.id, page: one.next! }, unread)).toEqual({ matches: [], resolved: one.resolved });
    const words = input(reach, [{ as: "payee", family: "money", n: 2 }], many);
    expect(peopleSearchOf({ name: "sam" }, words)!.elsewhere).toBeDefined();
    expect(peopleSearchOf({ name: "sam", page: first.next! }, words)!.elsewhere).toBeUndefined();
  });

  it("S11 past GIVEN_MOST given, People's order from a place: every match once, the cursor never growing with the walk (R5b)", () => {
    const many = Array.from({ length: GIVEN_MOST + 25 }, (_, at) => person(`person:sam-${at}`, `Sam Example${at}`, [`phone:+15550${String(at).padStart(6, "0")}`]));
    const reach = Object.fromEntries(many.map((each, at) => [each.id, { messages: [(at * 7919) % 1000 + 1, "2026-10-01", "2026-10-02"] as [number, string, string] }]));
    const given = input(reach, [], many);
    const ids: string[] = [];
    let page: ReturnType<typeof peopleSearchOf> = peopleSearchOf({ name: "sam" }, given)!;
    let held = 0;
    for (let n = 0; n < 60; n++) {
      ids.push(...page!.matches.map((match) => match.id));
      if (page!.next === undefined) break;
      held = Math.max(held, page!.next.given.length);
      page = peopleSearchOf({ name: "sam", page: page!.next }, given);
    }
    expect(ids).toHaveLength(many.length);
    expect(new Set(ids).size).toBe(many.length);
    expect(held).toBeLessThanOrEqual(GIVEN_MOST + PEOPLE_SEARCH_MATCHES);
  });

  it("S12 a sparse cursor far down People's order stays far under NEXT_CHARS (Sol's 27,000 contacts)", () => {
    const sparse = sealed("people", peoplePlace({ given: [...Array.from({ length: 10 }, (_, n) => n), 27_000] }), { name: "x".repeat(200) }, { index: "f", facts: "b", resolved: "r".repeat(22) });
    expect(sparse.length).toBeLessThan(Math.ceil((211 * 4) / 3) + 70);
    const widest = sealed("people", peoplePlace({ given: Array.from({ length: GIVEN_MOST + PEOPLE_SEARCH_MATCHES }, (_, n) => n * 3_000_000), place: 1_000_000_000, chats: 1_000 }), { name: "x".repeat(200) }, { index: "f", facts: "b", resolved: "r".repeat(22) });
    expect(widest.length).toBeLessThan(NEXT_CHARS);
  });

  it("S10 thirteen chats a name takes and no person: all thirteen come, twelve on the first page, the last on the next, each once", () => {
    const shops = Array.from({ length: 13 }, (_, at) => ({ key: `whatsapp:155500005${String(at).padStart(2, "0")}@s.whatsapp.net`, group: false, label: `Example Bakery ${at}` }));
    const reach = Object.fromEntries(shops.map((chat, at) => [chat.key, { messages: [at + 1, "2026-10-01", "2026-10-02"] as [number, string, string] }]));
    const given = { ...input(reach), chats: shops };
    const keys = (answer: ReturnType<typeof peopleSearchOf>) => (answer!.elsewhere ?? []).flatMap((each) => (each.as === "chat" ? [each.chat] : []));
    const first = peopleSearchOf({ name: "bakery" }, given)!;
    expect(first.matches).toEqual([]);
    expect(keys(first)).toEqual(shops.slice(0, 12).map((chat) => chat.key));
    expect(first.next).toEqual({ given: [], chats: 12 });
    const second = peopleSearchOf({ name: "bakery", page: first.next! }, given)!;
    expect(keys(second)).toEqual([shops[12]!.key]);
    expect(second.elsewhere).toEqual([{ as: "chat", chat: shops[12]!.key, n: 13, first: "2026-10-01", last: "2026-10-02" }]);
    expect(second.next).toBeUndefined();
    expect(new Set([...keys(first), ...keys(second)]).size).toBe(13);
    expect(given.asked).toEqual(["bakery:true"]);
  });

  it("S11 a chat the name titles, come between pages, is part of what the ask resolved to: the cursor expires, none given twice or passed over", () => {
    const shops = Array.from({ length: 13 }, (_, at) => ({ key: `whatsapp:155500005${String(at).padStart(2, "0")}@s.whatsapp.net`, group: false, label: `Example Bakery ${at}` }));
    const given = { ...input({}), chats: shops };
    const resolved: string[] = [];
    const first = peopleSearchOf({ name: "bakery" }, given, (digest) => resolved.push(digest))!;
    expect(first.next).toEqual({ given: [], chats: 12 });
    peopleSearchOf({ name: "bakery", page: first.next! }, given, (digest) => resolved.push(digest));
    expect(resolved[1]).toBe(resolved[0]);
    const arrived = { ...given, chats: [{ key: "whatsapp:15550000600@s.whatsapp.net", group: false, label: "Example Bakery new" }, ...shops] };
    peopleSearchOf({ name: "bakery", page: first.next! }, arrived, (digest) => resolved.push(digest));
    expect(resolved[2]).not.toBe(resolved[0]);
    peopleSearchOf({ name: "bakery", page: first.next! }, { ...given, chats: [{ key: "whatsapp:15550000700@s.whatsapp.net", group: false, label: "Example Garage" }, ...shops] }, (digest) => resolved.push(digest));
    expect(resolved[3]).toBe(resolved[0]);
  });

  it("W12 a count not made is no number: a group not counted, or its messages not among the counts, shows no messages; a match not counted is not counted in the note", () => {
    const counted = input({ ...REACH, "whatsapp:120363@g.us": { messages: [7, "2026-01-01", "2026-02-01"] } });
    const group = (chats: { chat: string; messages: number }[]) => answerOf({ name: "birthday" }, { ...counted, reach: (of) => ({ reach: counted.reach(of)!.reach, chats }) })!.matches[0]!;
    expect(group([{ chat: "whatsapp:120363@g.us", messages: 7 }]).chats).toEqual([{ chat: "whatsapp:120363@g.us", title: "Tushar's birthday", messages: 7 }]);
    expect(group([{ chat: "whatsapp:120363@g.us", messages: 0 }]).chats[0]!.messages).toBe(0);
    expect(group([]).chats).toEqual([{ chat: "whatsapp:120363@g.us", title: "Tushar's birthday" }]);
    const uncounted = answerOf({ name: "birthday" }, { ...counted, touch: (of) => of.map(() => undefined) })!;
    expect(uncounted.capped).toBe(true);
    expect(uncounted.matches[0]).toMatchObject({ capped: true, reach: {}, chats: [{ chat: "whatsapp:120363@g.us", title: "Tushar's birthday" }] });
    expect(uncounted.matches[0]!.chats[0]).not.toHaveProperty("messages");
    const note = answerOf({ name: "tushar" }, { ...counted, touch: (of) => of.map((_, at) => (at === 0 ? 43 : undefined)) })!;
    expect(note.capped).toBe(true);
    expect(note.note).toBe("three match, two of them contacts that share the name: person:tushar-a in touch 2019-02-01 → 2021-06-30, person:tushar-b not counted, whatsapp:120363@g.us not counted");
    expect(note.note).not.toContain("no contact held");
  });

  it("W1 two contacts of one name are both listed, tied, most in touch first, the note naming each's span by id", () => {
    const answer = peopleSearchOf({ name: "tushar" }, input(REACH))!;
    expect(answer.matches.map((match) => [match.id, match.tied])).toEqual([
      ["person:tushar-b", ["person:tushar-a"]], ["person:tushar-a", ["person:tushar-b"]], ["whatsapp:120363@g.us", undefined],
    ]);
    expect(answer.matches[2]).toMatchObject({ kind: "group", name: "Tushar's birthday" });
    expect(answer.note).toBe("three match, two of them contacts that share the name: person:tushar-b in touch 2024-03-04 → 2026-11-13, person:tushar-a 2019-02-01 → 2021-06-30, whatsapp:120363@g.us no contact held");
    for (const name of ["Tushar Sam", "Tushar S"]) {
      const surname = peopleSearchOf({ name }, input(REACH))!;
      expect(surname.matches.filter((match) => match.kind === "person").map((match) => match.id), name).toEqual(["person:tushar-b"]);
      expect(surname.matches[0]!.tied, name).toBeUndefined();
    }
  });

  it("W2 a near spelling finds a person, names the name it took, and is never added to a name that matches", () => {
    expect(isNear("tushr", "tushar")).toBe(true);
    expect(isNear("tuhsar", "tushar")).toBe(true);
    expect(isNear("tush", "tushar")).toBe(false);
    const near = peopleSearchOf({ name: "Tushr Sampel" }, input(REACH))!;
    expect(near.matches.map((match) => [match.id, match.near])).toEqual([["person:tushar-b", ["sample", "tushar"]]]);
    expect(peopleSearchOf({ name: "ada" }, input(REACH))!.matches.map((match) => [match.id, match.near])).toEqual([["person:ada", undefined]]);
    expect(peopleSearchOf({ name: "addie" }, input(REACH))!.matches.map((match) => match.id)).toEqual(["person:ada"]);
  });

  it("W3 a number, however grouped, and an address find their person; an id answers that one person", () => {
    expect(peopleSearchOf({ name: "+1 555 000 0102" }, input(REACH))!.matches.map((match) => match.id)).toEqual(["person:tushar-b"]);
    expect(peopleSearchOf({ name: "tushar@example.com" }, input(REACH))!.matches.map((match) => match.id)).toEqual(["person:tushar-b"]);
    const one = peopleSearchOf({ id: "phone:+15550000101" }, input(REACH))!;
    expect(one.matches).toMatchObject([{ id: "person:tushar-a", kind: "person", name: "Tushar Example", also: ["Tushar"], handles: ["phone:+15550000101"], reach: REACH["person:tushar-a"] }]);
    expect(peopleSearchOf({ id: "person:nobody" }, input(REACH))).toBeUndefined();
  });

  it("W5 a word that names no person answers elsewhere, with its words; a person matched whole leaves the words out", () => {
    const ELSE: Elsewhere[] = [{ as: "payee", family: "money", n: 3, first: "2026-01-02", last: "2026-03-04" }, { as: "words", family: "messages", n: 14, first: "2020-01-05", last: "2020-08-17" }];
    const none = input(REACH, ELSE);
    expect(peopleSearchOf({ name: "Acme" }, none)).toEqual({ matches: [], elsewhere: ELSE, resolved: expect.any(String) });
    const whole = input(REACH, ELSE);
    expect(peopleSearchOf({ name: "Tushar Sample" }, whole)!.elsewhere).toEqual([ELSE[0]]);
    expect(whole.asked).toEqual(["Tushar Sample:false"]);
    expect(peopleSearchOf({ name: "Tush" }, input(REACH, ELSE))!.elsewhere).toEqual(ELSE);
  });

  it("W7 tied means the same name whole; a word of one or two letters matches a name word or an address only whole", () => {
    const A = person("person:a", "Person A", ["phone:+15550000201"]);
    const C = person("person:c", "Person C", ["email:person-c@example.com"]);
    const OWNER = person("person:owner", "Owen Example", ["email:person-a@example.com"], { me: true });
    const D1 = person("person:d1", "Person D", ["phone:+15550000301"]);
    const D2 = person("person:d2", "Person D", ["phone:+15550000302"]);
    const AL = person("person:al", "Al Example", ["phone:+15550000401"]);
    const ALEX = person("person:alex", "Sam Sample", ["email:alex@example.com"]);
    const among = (name: string, everyone: PersonDetail[]) => peopleSearchOf({ name }, input({}, [], everyone))!;
    const a = among("Person A", [A, C, OWNER]);
    expect(a.matches.map((match) => [match.id, match.tied])).toEqual([["person:a", undefined]]);
    expect(a.note).toBeUndefined();
    const d = among("Person D", [D1, D2, A]);
    expect(d.matches.map((match) => [match.id, match.tied])).toEqual([["person:d1", ["person:d2"]], ["person:d2", ["person:d1"]]]);
    expect(d.note).toMatch(/^two contacts go by this name/u);
    expect(among("Person", [A, D1, D2].map((each) => ({ ...each, call_name: each.full_name! }))).matches.filter((match) => match.tied !== undefined).map((match) => match.id))
      .toEqual([]);
    expect(among("Al", [AL, ALEX]).matches.map((match) => match.id)).toEqual(["person:al"]);
    expect(among("Ale", [AL, ALEX]).matches.map((match) => match.id)).toEqual(["person:alex"]);
    expect(among("person-c", [A, C]).matches.map((match) => match.id)).toEqual(["person:c"]);
    expect(among("+1 555 000 0201", [A, C]).matches.map((match) => match.id)).toEqual(["person:a"]);
  });

  it("W10 a name Also called tells is listed in also and matched as any name, two called it are tied; You alone is me", () => {
    const PIM = person("person:a", "Person A", ["phone:+15550000201"], { also_called: [{ name: "Pim", from: "Contacts" }], names_seen: ["Person A Work"] });
    const BEAR = person("person:riley", "Riley Example", ["phone:+15550000021"], { also_called: [{ name: "Big Riley", from: "You added" }, { name: "Bear", from: "Contacts" }] });
    const TEDDY = person("person:teddy", "Teddy Example", ["phone:+15550000022"], { also_called: [{ name: "Bear", from: "You added" }] });
    const YOU = person("person:sam", "Sam Example", [], { me: true, also_called: [{ name: "Sammy", from: "You added" }] });
    const among = (asked: { name: string } | { id: string }) => peopleSearchOf(asked, input({}, [], [PIM, BEAR, TEDDY, YOU]))!;
    expect(among({ name: "pim" }).matches.map((match) => [match.id, match.also, match.me])).toEqual([["person:a", ["Person", "Pim", "Person A Work"], undefined]]);
    expect(among({ name: "Big Riley" }).matches.map((match) => [match.id, match.also])).toEqual([["person:riley", ["Riley", "Big Riley", "Bear"]]]);
    expect(among({ name: "bear" }).matches.map((match) => [match.id, match.tied])).toEqual([["person:riley", ["person:teddy"]], ["person:teddy", ["person:riley"]]]);
    expect(among({ name: "sammy" }).matches.map((match) => [match.id, match.also, match.me])).toEqual([["person:sam", ["Sam", "Sammy"], true]]);
    expect(among({ id: "person:sam" }).matches.map((match) => match.me)).toEqual([true]);
    expect(among({ name: "example" }).matches.filter((match) => match.me).map((match) => match.id)).toEqual(["person:sam"]);
  });

  it("W14 one person by a nickname, a full name or a name a source gave is one entry, with every name and handle of theirs", () => {
    const WREN = person("person:wren", "Wren Quillby", ["phone:+15550000301", "email:wren@example.com"], { name: "Birdie", call_name: "Birdie", names_seen: ["Wrennie Q"] });
    for (const name of ["birdie", "Wren Quillby", "wrennie", "wren@example.com", "555 000 0301"]) {
      const answer = peopleSearchOf({ name }, input({}, [], [WREN, T1]))!;
      expect(answer.matches.map((match) => [match.id, match.name, match.also, match.handles]), name).toEqual([
        ["person:wren", "Birdie", ["Wren Quillby", "Wrennie Q"], ["phone:+15550000301", "email:wren@example.com"]],
      ]);
    }
  });

  it("W15 entries likely one human list each other in same, by the signal: a full name, a face named so, a sender's name", () => {
    const CARD = person("phone:+15550000501", "Quinn Example", ["phone:+15550000501"], { by: "contact" });
    const MAILER = person("email:quinn.e@example.com", "quinn.e@example.com", ["email:quinn.e@example.com"],
      { call_name: "quinn.e@example.com", full_name: null, show: "name", by: "none", card: false, names_seen: ["Quinn Example"] });
    const ROWAN = person("phone:+15550000502", "Rowan Example", ["phone:+15550000502"], { by: "contact" });
    const FACE = person("person:rowan-face", "Rowan Example", [], { call_name: "Rowan Example", full_name: null, show: "name", by: "registry", card: false, record: { dismissed: [] } as never });
    const TWIN = person("phone:+15550000503", "Rowan Example", ["phone:+15550000503"], { by: "contact" });
    const NAMESAKE = person("phone:+15550000504", "Quinn Sample", ["phone:+15550000504"], { by: "contact" });
    const FIRST = person("phone:+15550000505", "Sky", ["phone:+15550000505"], { call_name: "Sky", full_name: null, show: "name", by: "contact" });
    const SIGNER = person("email:sky@example.com", "sky@example.com", ["email:sky@example.com"], { call_name: "sky@example.com", full_name: null, show: "name", by: "none", card: false, names_seen: ["Sky Example"] });
    const YOU = person("person:you", "Quinn Example", ["email:you@example.com"], { me: true });
    const everyone = [CARD, MAILER, ROWAN, FACE, TWIN, NAMESAKE, FIRST, SIGNER, YOU];
    const sameOf = (id: string, among = everyone) => peopleSearchOf({ id }, input({}, [], among))!.matches[0]!.same;
    expect(sameOf("phone:+15550000501")).toEqual([{ id: "email:quinn.e@example.com", by: "sender" }]);
    expect(sameOf("email:quinn.e@example.com")).toEqual([{ id: "phone:+15550000501", by: "sender" }]);
    const byName = peopleSearchOf({ name: "Quinn Example" }, input({}, [], everyone))!;
    expect(byName.matches.filter((match) => !match.me).map((match) => [match.id, match.same])).toEqual([
      ["phone:+15550000501", [{ id: "email:quinn.e@example.com", by: "sender" }]], ["email:quinn.e@example.com", [{ id: "phone:+15550000501", by: "sender" }]],
    ]);
    expect(byName.matches.find((match) => match.me)?.same).toBeUndefined();
    expect(sameOf("person:rowan-face")).toEqual([{ id: "phone:+15550000502", by: "face" }, { id: "phone:+15550000503", by: "face" }]);
    expect(sameOf("phone:+15550000502")).toEqual([{ id: "person:rowan-face", by: "face" }, { id: "phone:+15550000503", by: "name" }]);
    for (const id of ["phone:+15550000504", "phone:+15550000505", "email:sky@example.com"]) expect(sameOf(id), id).toBeUndefined();
    const declined = { ...CARD, record: { dismissed: [sameIdOf(CARD.id, MAILER.id)] } as never };
    expect(sameOf("phone:+15550000501", [declined, MAILER])).toBeUndefined();
    expect(sameOf("email:quinn.e@example.com", [declined, MAILER])).toBeUndefined();
  });

  it("W16 same names no one: each entry is the other's id and the signal's kind", () => {
    const CARD = person("phone:+15550000501", "Quinn Example", ["phone:+15550000501"], { by: "contact" });
    const MAILER = person("email:quinn.e@example.com", "quinn.e@example.com", ["email:quinn.e@example.com"],
      { call_name: "quinn.e@example.com", full_name: null, show: "name", by: "none", card: false, names_seen: ["Quinn Example"] });
    const [match] = peopleSearchOf({ id: CARD.id }, input({}, [], [CARD, MAILER]))!.matches;
    expect(match!.same).toEqual([{ id: MAILER.id, by: "sender" }]);
    expect(match!.same!.flatMap((entry) => Object.keys(entry))).toEqual(["id", "by"]);
  });

  it("W6 a tied note and elsewhere name no one: a tied contact's name stands only in its own match", () => {
    const answer = peopleSearchOf({ name: "tushar" }, input(REACH, [{ as: "words", family: "messages", n: 2, first: "2020-01-01", last: "2020-01-02" }]))!;
    const { matches, ...rest } = answer;
    const text = JSON.stringify(rest);
    for (const name of ["Tushar", "Example", "Sample"]) expect(text.includes(name), name).toBe(false);
    const b = matches.find((match) => match.id === "person:tushar-b")!;
    expect(JSON.stringify({ ...b, name: "", also: [], chats: [] }).includes("Sample")).toBe(false);
  });
});


const message = (key: string, at: number, handle: string, chat: string, direction: "sent" | "received"): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
  keys: { chat, direction, product: "whatsapp", searchable: "yes" }, measures: {}, who: [{ handle, role: direction === "sent" ? "receiver" : "sender" }],
  from: { units: [`u/${key}`], record: { source: "whatsapp:acct:a", kind: "msg", key }, alone: true }, lines: [],
});
const call = (key: string, at: number, handle: string): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: at, start_ms: at, end_ms: at + 600_000,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes: 10 }, who: [{ handle, role: "receiver" }],
  from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});
const payment = (key: string, day: string, payee: string): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day, "00:00"), start_ms: D(day, "00:00"), end_ms: D(day, "00:00"), date_only: true,
  keys: { payee, direction: "debit", currency: "EUR" }, measures: { amount: "5.00" }, who: [], from: { units: [`money/${key}`], record: { source: "bank:a:a", kind: "payment", key }, alone: true }, lines: [],
});
const T1_CHAT = "whatsapp:15550000101@s.whatsapp.net";
const SHOP = "phone:+15550000199";
const SHOP_CHAT = "whatsapp:15550000199@s.whatsapp.net";
const T2_CHAT = "whatsapp:15550000102@s.whatsapp.net";
const DAYS: Record<string, DayFileFact[]> = {
  "2021-06-01": [message("m1", D("2021-06-01"), "phone:+15550000101", T1_CHAT, "received"), call("c1", D("2021-06-01", "13:00"), "phone:+15550000101")],
  "2021-06-30": [message("m2", D("2021-06-30"), "phone:+15550000101", T1_CHAT, "sent")],
  "2026-11-01": [
    message("m3", D("2026-11-01"), "phone:+15550000102", T2_CHAT, "received"), message("m4", D("2026-11-01", "12:05"), "phone:+15550000102", T2_CHAT, "sent"),
    message("m5", D("2026-11-01", "12:10"), "email:tushar@example.com", "whatsapp:120363@g.us", "received"), payment("p1", "2026-11-01", "ACME CABS"),
  ],
  "2026-11-02": [message("m6", D("2026-11-02"), "phone:+15550000102", T2_CHAT, "received"), payment("p2", "2026-11-02", "Acme Cabs Ltd")],
  "2026-10-20": [message("m7", D("2026-10-20"), SHOP, SHOP_CHAT, "sent"), message("m8", D("2026-10-20", "12:30"), SHOP, SHOP_CHAT, "received")],
  "2026-10-22": [message("m9", D("2026-10-22"), SHOP, SHOP_CHAT, "received")],
};

describe("the people search route", () => {
  const root = join(dir, "home");
  const machine = join(dir, "machine");
  mkdirSync(join(root, "days"), { recursive: true });
  writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: "home-test", created: "2026-10-01T00:00:00Z" }));
  const home = openHome(openHomeFolder(root), "migrate");
  home.commit((tx) => tx.tables.meta.set(DAYS_MARK, "test"));
  home.close();
  const families = [{ name: "calls", collections: CALLS_COLLECTIONS }, { name: "messages", collections: MESSAGES_COLLECTIONS }, { name: "money", collections: MONEY_COLLECTIONS }, { name: "notes" }, { name: "ai" }] as unknown as Family[];
  const reads = openReads({
    folder: openHomeFolder(root), home: new HomeFile(openHomeFolder(root)), blobs: undefined as never, settings: () => ({ day: SETTINGS }) as Settings,
    registry: { connectors: [], readers: [], families } as unknown as Registry,
    streams: { feed: undefined as never, serves: async () => false, card: async () => undefined, open: new ErasableStreams(), checked: (_name, read) => read() },
  });
  const now_ms = D("2026-11-13");
  const asked = (path: string, url: string) => {
    const reply = reads.reply(path)!({ url, now_ms, held: { machine } as never }) as Reply;
    return JSON.parse(String(reply.body)) as Record<string, any>;
  };
  const searched = (query: string) => {
    const body = asked("/v1/people/search", `/v1/people/search?${query}`);
    contractOf("/v1/people/search", 200, body);
    return body;
  };
  const refused = (query: string): [number, string] => {
    try {
      asked("/v1/people/search", `/v1/people/search?${query}`);
    } catch (error) {
      if (error instanceof Refusal) return [error.status, error.code];
      throw error;
    }
    throw new Error(`answered ${query}`);
  };
  const personRef = (id: string) => refOf({ id, handles: [...EVERYONE, ...SAMS].find((each) => each.id === id)?.handles.map((handle) => handle.id) ?? [] });
  const chatRef = (key: string) => makeRef("chat", { key });
  const SAMS = Array.from({ length: 12 }, (_, at) => person(`person:sam-${at}`, `Sam Example${at}`, [`phone:+155500005${String(at).padStart(2, "0")}`]));
  const peopleRows = (everyone: readonly PersonDetail[]) => new Map<string, Map<string, JsonObject>>([
    ["answer", new Map([["list", { people: [], chats: [{ key: T2_CHAT, group: false, label: "Tushar Sample" }, { key: "whatsapp:120363@g.us", group: true, label: "Weekend plans" }, { key: SHOP_CHAT, group: false, label: "Lighthouse Bakery" }] } as unknown as JsonObject]])],
    ["person", new Map(everyone.map((each) => [each.id, { person: each } as unknown as JsonObject]))],
    ["alias", new Map(everyone.flatMap((each) => [each.id, ...each.handles.map((handle) => handle.id)].map((id) => [id, { id: each.id }] as [string, JsonObject])))],
    ["names", new Map([["all", { people: everyone.map(searchedOf) } as unknown as JsonObject]])],
  ]);

  it("W4 reach is what /v1/count counts of each person, with their first and last day; elsewhere counts a payee and the words", () => {
    const built = SearchIndex.write(openHomeFolder(root), searchFileOf(root, machine), () => true, 0, SETTINGS);
    built.records([
      { record: { source: "notes:a", kind: "note", key: "n1" }, family: "notes", version: "v1", start_ms: D("2020-01-05"), end_ms: null, title: "", text: "a ride with Acme to the airport", who: [], link: null },
      { record: { source: "notes:a", kind: "note", key: "n2" }, family: "notes", version: "v1", start_ms: D("2020-08-17"), end_ms: null, title: "", text: "acme again", who: [], link: null },
      { record: { source: "ask:local:home-test", kind: "turn", key: "a1" }, family: "ai", version: "v1", start_ms: D("2026-11-03"), end_ms: null, title: "", text: "acme cabs, you said", who: [], link: null },
    ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
    for (const [day, facts] of Object.entries(DAYS)) built.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day, "00:00"), end_ms: D(day, "00:00") + 86_400_000 }, facts } });
    built.finish();
    writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, { rows: peopleRows([...EVERYONE, ...SAMS]), position: "1:1" });

    const found = searched("name=tushar");
    expect(found.matches.map((match: any) => [match.ref, match.reach])).toEqual([
      [personRef("person:tushar-b"), { messages: [4, "2026-11-01", "2026-11-02"] }],
      [personRef("person:tushar-a"), { calls: [1, "2021-06-01", "2021-06-01"], messages: [2, "2021-06-01", "2021-06-30"] }],
    ]);
    for (const [id, of] of [["person:tushar-b", "messages"], ["person:tushar-a", "messages"], ["person:tushar-a", "calls"]] as const) {
      const counted = asked("/v1/count", `/v1/count?of=${of}&person=${encodeURIComponent(personRef(id))}`);
      expect((counted.total as { n: number }).n, `${id} ${of}`).toBe(found.matches.find((match: any) => match.ref === personRef(id)).reach[of][0]);
    }
    expect(found.elsewhere).toBeUndefined();
    expect(searched("name=acme")).toMatchObject({
      matches: [], elsewhere: [{ as: "payee", family: "money", n: 2, first: "2026-11-01", last: "2026-11-02" }, { as: "words", family: "notes", n: 2, first: "2020-01-05", last: "2020-08-17" }],
    });
    expect(reads.prepared("/v1/people")!({ url: "/v1/people?q=tushar", now_ms, held: { machine } })).toBeUndefined();
    expect(JSON.parse(String(reads.prepared("/v1/people")!({ url: "/v1/people?id=person%3Aada", now_ms, held: { machine } })!.body)).person.name).toBe("Ada Lovelace-Example");
  });

  it("P1 a name two people go by is PERSON_UNKNOWN on search and count alike, with the same matches; one no one has, the same", async () => {
    const refusedBy = async (route: "/v1/search" | "/v1/count", url: string) => {
      try {
        await reads.reply(route)!({ url, now_ms, held: { machine } as never });
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        const body = { code: error.code, message: error.words, ...error.extra };
        contractOf(route, error.status, body);
        return { status: error.status, ...body };
      }
      throw new Error(`answered ${url}`);
    };
    const searched = await refusedBy("/v1/search", "/v1/search?lists=record&person=tushar");
    const counted = await refusedBy("/v1/count", "/v1/count?of=messages&person=tushar");
    expect(searched).toMatchObject({ status: 404, code: "PERSON_UNKNOWN" });
    expect(counted).toEqual(searched);
    expect((searched as { matches?: { ref: string }[] }).matches?.map((match) => match.ref).sort()).toEqual([personRef("person:tushar-a"), personRef("person:tushar-b")].sort());
    const nobody = [await refusedBy("/v1/search", "/v1/search?lists=record&person=Nobody%20Example"), await refusedBy("/v1/count", "/v1/count?of=messages&person=Nobody%20Example")];
    expect(nobody[1]).toEqual(nobody[0]);
    expect(nobody[0]).toMatchObject({ status: 404, code: "PERSON_UNKNOWN", message: expect.stringContaining("search_people") });
  });

  it("W9 search_people reads the tallies and People alone: no fact's keys are walked to rank, resolve a chat or a value", () => {
    const run = statements(() => {
      const group = searched("name=weekend");
      expect(group.matches.map((match: any) => [match.ref, match.kind, match.reach, match.chats])).toEqual([
        [chatRef("whatsapp:120363@g.us"), "group", { messages: [1, "2026-11-01", "2026-11-01"] }, [{ chat: chatRef("whatsapp:120363@g.us"), title: "Weekend plans", messages: 1 }]],
      ]);
      expect(searched("name=tushar").matches.map((match: any) => match.ref)).toEqual([personRef("person:tushar-b"), personRef("person:tushar-a")]);
      expect(searched("name=acme").elsewhere).toContainEqual({ as: "payee", family: "money", n: 2, first: "2026-11-01", last: "2026-11-02" });
      searched(`id=${chatRef("whatsapp:120363@g.us")}`);
    });
    expect(run.length).toBeGreaterThan(0);
    const walks = run.flatMap(({ sql, plan }) => plan.filter((detail) => /\b(fact_of|fact_combo|fact_crew|fact_day)\b/u.test(detail) || /^SCAN (f|fact)\b/u.test(detail) && /\bfact\b/u.test(sql))
      .map((detail) => `${detail}\n${sql}`));
    expect(walks).toEqual([]);
  });

  it("W13 search_people's counts, its order, each shown match's reach and elsewhere's sizes, are one read of the index and one read of its facts, on one meter", () => {
    let facts = 0;
    const hold = SearchIndex.prototype.hold;
    const reads = vi.spyOn(SearchIndex.prototype, "hold").mockImplementation(function (this: SearchIndex, attached, within) {
      const held = hold.call(this, attached, within);
      return { ...held, read: { ...held.read, facts: (each, inside) => (facts++, held.read.facts(each, inside)) } };
    });
    try {
      for (const query of ["name=tushar", "name=weekend", "name=acme", `id=${personRef("person:tushar-b")}`]) {
        const url = `/v1/people/search?${query}`;
        reads.mockClear();
        facts = 0;
        const answer = asked("/v1/people/search", url);
        expect(answer.capped, url).toBeUndefined();
        expect(reads.mock.calls, url).toHaveLength(1);
        expect(facts, url).toBe(1);
      }
    } finally {
      reads.mockRestore();
    }
  });

  it("S1 /v1/people/search answers its contract: refs, handles as written, each chat with its count, reach a count with no range", () => {
    const found = searched("name=tushar");
    const [a, b] = [personRef("person:tushar-a"), personRef("person:tushar-b")];
    expect(found.matches.map((match: any) => [match.ref, match.kind, match.reach, match.tied])).toEqual([
      [b, "person", { messages: [4, "2026-11-01", "2026-11-02"] }, [a]],
      [a, "person", { calls: [1, "2021-06-01", "2021-06-01"], messages: [2, "2021-06-01", "2021-06-30"] }, [b]],
    ]);
    for (const [id, of] of [["person:tushar-b", "messages"], ["person:tushar-a", "messages"], ["person:tushar-a", "calls"]] as const) {
      const counted = asked("/v1/count", `/v1/count?of=${of}&person=${encodeURIComponent(personRef(id))}`);
      expect((counted.total as { n: number }).n, `${id} ${of}`).toBe(found.matches.find((match: any) => match.ref === personRef(id)).reach[of][0]);
    }
    expect(found.matches[0].handles).toEqual(["+15550000102", "tushar@example.com"]);
    expect(found.matches[0].chats).toEqual([{ chat: chatRef(T2_CHAT), title: "Tushar Sample", messages: 3 }, { chat: chatRef("whatsapp:120363@g.us"), title: "Weekend plans", messages: 1 }]);
    expect(found.note).toBe("two contacts go by this name; each match's `reach` says when it was in touch");
    expect(found.note).not.toMatch(/person\.|chat\.|tushar/u);
    expect(found).not.toHaveProperty("next");
    expect(found).not.toHaveProperty("capped");
  });

  it("S2 id: a person's or a chat's ref is that one; with a name, of another kind or not the door's, BAD_PARAMETER; no one's, BAD_PARAMETER naming it", () => {
    expect(searched(`id=${personRef("person:tushar-a")}`).matches.map((match: any) => match.ref)).toEqual([personRef("person:tushar-a")]);
    expect(searched(`id=${chatRef("whatsapp:120363@g.us")}`).matches).toEqual([{
      ref: chatRef("whatsapp:120363@g.us"), kind: "group", name: "Weekend plans",
      chats: [{ chat: chatRef("whatsapp:120363@g.us"), title: "Weekend plans", messages: 1 }], reach: { messages: [1, "2026-11-01", "2026-11-01"] },
    }]);
    expect(refused(`name=tushar&id=${personRef("person:tushar-a")}`)).toEqual([422, "BAD_PARAMETER"]);
    expect(refused("id=person%3Atushar-a")).toEqual([422, "BAD_PARAMETER"]);
    expect(refused(`id=${makeRef("place", { id: "home" })}`)).toEqual([422, "BAD_PARAMETER"]);
    expect(refused("")).toEqual([422, "BAD_PARAMETER"]);
    expect(refused(`id=${personRef("person:nobody")}`)).toEqual([422, "BAD_PARAMETER"]);
  });

  it("S3 S6 elsewhere: a payee and the words, Ask's own answers counted nowhere; a look of the words refused is capped with no count", () => {
    expect(searched("name=acme")).toMatchObject({
      matches: [], elsewhere: [{ as: "payee", family: "money", n: 2, first: "2026-11-01", last: "2026-11-02" }, { as: "words", family: "notes", n: 2, first: "2020-01-05", last: "2020-08-17" }],
    });
    const hold = SearchIndex.prototype.hold;
    const reads = vi.spyOn(SearchIndex.prototype, "hold").mockImplementation(function (this: SearchIndex, attached, within) {
      const held = hold.call(this, attached, within);
      return { ...held, read: { ...held.read, search: () => {
        throw new Refusal(422, "TOO_BROAD", "too many to count");
      } } };
    });
    try {
      expect(searched("name=acme").elsewhere).toEqual([{ as: "payee", family: "money", n: 2, first: "2026-11-01", last: "2026-11-02" }, { as: "words", capped: true }]);
    } finally {
      reads.mockRestore();
    }
  });

  it("S4 S5 a name of thirteen: ten a page, next the other three, every match once; a cursor after People moved, with another name, or not the door's is refused", () => {
    const first = searched("name=sam");
    expect(first.matches).toHaveLength(10);
    expect(typeof first.next).toBe("string");
    const second = searched(`cursor=${first.next}`);
    expect(second.matches).toHaveLength(3);
    expect(second).not.toHaveProperty("next");
    expect([...first.matches, ...second.matches].map((match: any) => match.ref).sort()).toEqual([...SAMS.map((each) => personRef(each.id)), personRef("person:tushar-b")].sort());
    expect(searched(`name=sam&cursor=${first.next}`)).toEqual(second);
    expect(refused(`name=tushar&cursor=${first.next}`)).toEqual([422, "BAD_PARAMETER"]);
    expect(refused("cursor=abc")).toEqual([422, "BAD_PARAMETER"]);
    expect(refused(`cursor=${sealed("count", [1], { of: "calls" }, {})}`)).toEqual([422, "BAD_PARAMETER"]);
    writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, { rows: peopleRows([...EVERYONE, ...SAMS]), position: "2:2" });
    expect(searched(`cursor=${first.next}`)).toEqual(second);
    writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, { rows: peopleRows([...EVERYONE, ...SAMS.slice(1)]), position: "3:3" });
    expect(refused(`cursor=${first.next}`)).toEqual([409, "CURSOR_EXPIRED"]);
  });

  it("S7 a record indexed between pages moves no cursor: next goes on; People moved still expires it", () => {
    const first = searched("name=sam");
    expect(first.matches).toHaveLength(10);
    const file = searchFileOf(root, machine);
    const revision = SearchIndex.read(openHomeFolder(dirname(file)), file)!.revision();
    const writer = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, SETTINGS);
    writer.records([
      { record: { source: "notes:a", kind: "note", key: "n3" }, family: "notes", version: "v1", start_ms: D("2026-11-12"), end_ms: null, title: "", text: "a quiet harbour at dawn", who: [], link: null },
    ], [], { position: { seq: 2, statement: "s-2", reread: 0 } });
    writer.close();
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)!.revision()).not.toBe(revision);
    const second = searched(`cursor=${first.next}`);
    expect(second.matches).toHaveLength(2);
    expect(second).not.toHaveProperty("next");
    const refs = [...first.matches, ...second.matches].map((match: any) => match.ref);
    expect(new Set(refs).size).toBe(12);
    writePrepared(openHomeFolder(root), preparedFileOf(preparedDirOf(root, machine, "people"), "people"), PEOPLE, { rows: peopleRows([...EVERYONE, ...SAMS.slice(2)]), position: "4:4" });
    expect(refused(`cursor=${first.next}`)).toEqual([409, "CURSOR_EXPIRED"]);
  });

  it("S8 a chat that is no group, titled with a name no person goes by, is in elsewhere by its ref with its messages", () => {
    const found = searched("name=bakery");
    expect(found.matches).toEqual([]);
    expect(found.elsewhere).toEqual([{ as: "chat", ref: chatRef(SHOP_CHAT), n: 3, first: "2026-10-20", last: "2026-10-22" }]);
    const byChat = asked("/v1/count", "/v1/count?of=messages&by=chat&limit=10");
    expect(JSON.stringify(byChat)).toContain(SHOP_CHAT);
    expect(searched("name=tushar%20sample").elsewhere).toBeUndefined();
  });

  it("S9 the real meter spent on the second subject: the first keeps its numbers, every match comes once, and the walk ends", () => {
    const index = SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine))!;
    const everyone = [...EVERYONE, ...SAMS.slice(2)];
    const byId = new Map(everyone.map((each) => [each.id, each]));
    const context: CountContext = { collections: new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MESSAGES_COLLECTIONS })), settings: SETTINGS, now_ms, people: () => undefined };
    const subject = (of: { person: string } | { chat: string }): Subject => ("chat" in of ? of : { person: of.person, handles: byId.get(of.person)!.handles.map((handle) => handle.id) });
    const real = (budget: number): PeopleSearchInput => ({
      searched: everyone.map(searchedOf), person: (id) => byId.get(id), idOf: (id) => (byId.has(id) ? id : undefined), chats: [],
      counted: (count) => index.snapshot({}, (read) => read.facts((facts) => {
        const counts = new PeopleCounts(facts, context, { person: ["calls", "messages"], chat: ["messages"] }, budget);
        return count({ touch: (of) => counts.touch(of.map(subject)), reach: (of) => counts.reach(subject(of)) });
      })),
      elsewhere: () => [],
    });
    const subjects = [subject({ person: T2.id }), subject({ person: SAMS[2]!.id })];
    const budget = Array.from({ length: 400 }, (_, at) => at + 1).find((each) => index.snapshot({}, (read) => read.facts((facts) => new PeopleCounts(facts, context, { person: ["calls", "messages"], chat: ["messages"] }, each).touch(subjects)[0] !== undefined)))!;
    expect(index.snapshot({}, (read) => read.facts((facts) => new PeopleCounts(facts, context, { person: ["calls", "messages"], chat: ["messages"] }, budget).touch(subjects)))[1]).toBeUndefined();
    const pages: ReturnType<typeof peopleSearchOf>[] = [];
    let next: { given: number[] } | undefined;
    do {
      const page = peopleSearchOf({ name: "sam", ...(next === undefined ? {} : { page: next }) }, real(budget))!;
      pages.push(page);
      next = page.next;
    } while (next !== undefined && pages.length < 10);
    expect(next).toBeUndefined();
    expect(pages[0]!.capped).toBe(true);
    expect(pages[0]!.matches[0]).toMatchObject({ id: T2.id, reach: { messages: [4, "2026-11-01", "2026-11-02"] } });
    expect(pages[0]!.matches[0]!.capped).toBeUndefined();
    expect(pages[0]!.matches.slice(1).every((match) => match.capped === true)).toBe(true);
    const ids = pages.flatMap((page) => page!.matches.map((match) => match.id));
    expect(ids.sort()).toEqual(everyone.filter((each) => each.id === T2.id || each.id.startsWith("person:sam-")).map((each) => each.id).sort());
  });

  it("S12 a person's ref holds a handle: People built again from cold opens the same person; a handle a split moved opens who holds it now; none, no one", async () => {
    const file = preparedFileOf(preparedDirOf(root, machine, "people"), "people");
    const { ref } = searched("name=tushar%20example").matches.find((match: any) => match.name === "Tushar Example");
    expect(readRef(ref, "ref", ["person"]).parts).toEqual({ handle: "phone:+15550000101" });
    const opened = () => searched(`id=${encodeURIComponent(ref)}`).matches.map((match: any) => [match.ref, match.name]);
    const read = () => asked("/v1/read", `/v1/read?ref=${encodeURIComponent(ref)}`);
    const filtered = async () => (JSON.parse(String((await (reads.reply("/v1/search")!({ url: `/v1/search?lists=record&person=${encodeURIComponent(ref)}`, now_ms, held: { machine } as never }) as Promise<Reply>)).body)) as Record<string, any>).person;
    writePrepared(openHomeFolder(dirname(file)), file, PEOPLE, { rows: peopleRows([ADA, person("person:tushar-x", "Tushar Example", ["phone:+15550000101"]), T2]), position: "6:6" });
    expect(opened()).toEqual([[ref, "Tushar Example"]]);
    expect(read()).toMatchObject({ what: "people", match: { ref, name: "Tushar Example" } });
    expect(await filtered()).toEqual([{ asked: ref, ref, name: "Tushar Example" }]);
    writePrepared(openHomeFolder(dirname(file)), file, PEOPLE, { rows: peopleRows([ADA, person("person:tushar-x", "Tushar Example", ["email:tushar-x@example.com"]), person("person:other", "Other Example", ["phone:+15550000101"]), T2]), position: "7:7" });
    expect(opened()).toEqual([[ref, "Other Example"]]);
    expect(read()).toMatchObject({ what: "people", match: { name: "Other Example" } });
    writePrepared(openHomeFolder(dirname(file)), file, PEOPLE, { rows: peopleRows([ADA, T2]), position: "8:8" });
    expect(refused(`id=${encodeURIComponent(ref)}`)).toEqual([422, "BAD_PARAMETER"]);
    expect(read()).toMatchObject({ what: "gone", ref });
    writePrepared(openHomeFolder(dirname(file)), file, PEOPLE, { rows: peopleRows([...EVERYONE, ...SAMS.slice(2)]), position: "9:9" });
  });
});


function synthDay(day: string, seed: number): DayDocument {
  const atoms: DayAtom[] = [];
  const add = (family: string, text: string, over: Partial<DayAtom> = {}) => {
    const n = atoms.length + 1;
    const start_ms = D(day, "00:00") + n * 60_000;
    atoms.push({ n, family, unit: `${family}/${n}`, units: [`${family}/${n}`], start_ms, end_ms: null, local_start: `0${Math.floor(n / 60) % 10}:${String(n % 60).padStart(2, "0")}`, local_end: null, flags: [], text, ...over });
  };
  for (let at = 0; at < 9; at++) add("physical", `At Place ${at + seed}`);
  for (let chat = 0; chat < 12; chat++) {
    for (let line = 0; line <= chat; line++) {
      add("messages", `Person ${chat}: synthetic line ${line}`, { names: [{ start: 0, end: `Person ${chat}`.length, who: `phone:+1555000${chat}` }], block: { key: `chat-${chat}`, title: `Person ${chat}`, names: [{ start: 0, end: `Person ${chat}`.length, who: `phone:+1555000${chat}` }] } });
    }
  }
  for (let at = 0; at < 3; at++) add("calls", `Call with Person ${at}, 10 min`, { names: [{ start: 10, end: 18, who: `phone:+1555000${at}` }] });
  for (let at = 0; at < 7; at++) add("mail", `Synthetic subject ${at}\nbody`);
  for (let at = 0; at < 6; at++) add("screen", `Reading synthetic page ${at}`);
  for (let chat = 0; chat < 4; chat++) for (let turn = 0; turn < 3; turn++) add("ai", `the user: question ${turn}`, { block: { key: `ai-${chat}`, title: `Assistant · Topic ${chat}` } });
  for (let at = 0; at < 5; at++) add("calendar", `Event ${at}`);
  for (let at = 0; at < 20; at++) add("photos", `photo ${at}`);
  add("health", "Slept 7h", { flags: ["heading"], start_ms: null, local_start: null });
  add("listening", "Played a synthetic song");
  add("web", "Visited a synthetic page");
  add("notes", "A synthetic note");
  const health = atoms.at(-4)!.n;
  for (let at = 0; at < 6; at++) add("money", `SYNTHETIC SHOP ${at} 5.00`);
  const money = atoms.filter((atom) => atom.family === "money").map((atom) => atom.n);
  const facts: DayFileFact[] = [
    { id: "days:000000000000000000000001", family: "health", of: "days", time_ms: D(day, "00:00"), start_ms: D(day, "00:00"), end_ms: D(day, "00:00"), date_only: true, keys: { instrument: "Watch" }, measures: { steps: 9000, asleep_min: 420 }, who: [], from: { units: ["h/1"], instrument: "Watch" }, lines: [health] },
    { id: "workouts:000000000000000000000001", family: "health", of: "workouts", time_ms: D(day), start_ms: D(day), end_ms: D(day, "13:00"), keys: { sport: "running", instrument: "Watch" }, measures: { minutes: 60, km: 10 }, who: [], from: { units: ["h/2"] }, lines: [] },
    ...Array.from({ length: 6 }, (_, at): DayFileFact => ({ ...payment(`p${at}`, day, `Synthetic Shop ${at}`), lines: [at === 5 ? 999 : money[at]!] })),
  ];
  return { day, zone: "UTC", day_start_hour: 0, window: { start_ms: D(day, "00:00"), end_ms: D(day, "00:00") + 86_400_000 }, renderer: "9", inputs: sha256(`in-${day}-${seed}`), counts: { total: atoms.length, per_family: {} }, coverage: [], atoms, facts };
}

describe("the brief", () => {
  it("B1 at most 40 lines, each citing atoms the day holds, every part there, a chat's line starting with its span", () => {
    const day = synthDay("2026-11-01", 0);
    const brief = briefOf(day);
    const held = new Set(day.atoms.map((atom) => atom.n));
    expect(brief.lines.length).toBeLessThanOrEqual(BRIEF_LINES);
    for (const line of brief.lines) {
      expect(line.atoms.length, line.text).toBeGreaterThan(0);
      for (const n of line.atoms) expect(held.has(n), `${line.text} cites ${n}`).toBe(true);
    }
    expect([...new Set(brief.lines.map((line) => line.part))]).toEqual(["where", "people", "mail", "screen", "ai", "calendar", "days", "workouts", "money", "photos", "rest"]);
    expect(brief.lines.find((line) => line.part === "people")).toMatchObject({ text: "01:16–01:27 Person 11: 12 messages" });
    const where = brief.lines.filter((line) => line.part === "where");
    expect(where.at(-1)).toMatchObject({ text: "and 4 more", atoms: [6, 7, 8, 9] });
    expect(brief.lines.find((line) => line.part === "photos")!.text).toBe("20 photos");
    expect(brief.lines.find((line) => line.part === "days")!.text).toBe("the day: steps 9000 asleep_min 420 (instrument Watch)");
    const money = day.atoms.filter((atom) => atom.family === "money").map((atom) => atom.n);
    expect(brief.lines.filter((line) => line.part === "money")).toEqual([
      { part: "money", text: "payment: Synthetic Shop 0 debit amount 5.00 EUR", atoms: [money[0]] },
      { part: "money", text: "payment: Synthetic Shop 1 debit amount 5.00 EUR", atoms: [money[1]] },
      { part: "money", text: "payment: Synthetic Shop 2 debit amount 5.00 EUR", atoms: [money[2]] },
      { part: "money", text: "and 3 more", atoms: money },
    ]);
    expect(brief.lines.filter((line) => line.part === "rest").map((line) => line.text)).toEqual(["listening: 1 line", "and 2 more"]);
  });

  it("B1 a quiet day's brief is its few lines", () => {
    const day = synthDay("2026-11-02", 1);
    const quiet = { ...day, atoms: day.atoms.filter((atom) => atom.family === "physical").slice(0, 2), facts: [] };
    expect(briefOf(quiet).lines.map((line) => [line.text, line.atoms])).toEqual([["00:01 At Place 1", [1]], ["00:02 At Place 2", [2]]]);
  });
});

describe("the brief of a day a fact runs into", () => {
  it("B3 a workout begun the day before is listed by its own day's brief, whole, and by no brief of the day it runs into", () => {
    const settings: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
    const at = (local: string) => Date.parse(`${local}-04:00`);
    const health = healthFamily([]);
    const content = {
      kind: "workout", record: { source: "whoop:1:cloud", key: "w1", kind: "workout" }, start_ms: at("2026-09-18T03:30"), end_ms: at("2026-09-18T04:30"),
      sport: "running", strain: 11.5, average_heart_rate: 140, max_heart_rate: 171, kilojoule: 2092, distance_m: 8000,
    };
    const row: ExtractRow = { family: "health", unit: "workout/whoop:1:cloud/w1", reading: "r-w1", code: health.code, content: content as unknown as Json, start_ms: content.start_ms, end_ms: content.end_ms, days: [], items: [], seq: 0 };
    const rows = [{ ...row, days: health.days(row, settings) }];
    expect(rows[0]!.days).toEqual(expect.arrayContaining(["2026-09-17", "2026-09-18"]));
    const reader = { extractsOn: (_family: string, on: string) => rows.filter((each) => each.days.includes(on)), enrichment: () => undefined, sources: () => [], since: () => undefined };
    const brief = (day: string) => {
      const document = JSON.parse(renderDay(day, [health], reader, settings, tableUnits(buildLabels({ people: [], contacts: [], places: [] }))).json) as DayDocument;
      return { document, workouts: briefOf(document).lines.filter((line) => line.part === "workouts").map((line) => line.text) };
    };
    const [began, ran] = [brief("2026-09-17"), brief("2026-09-18")];
    expect(began.workouts).toEqual([expect.stringContaining("minutes 60")]);
    expect(ran.workouts).toEqual([]);
    expect(ran.document.atoms.some((atom) => atom.start_ms === at("2026-09-18T04:00") && atom.end_ms === at("2026-09-18T04:30"))).toBe(true);
  });
});

function statements(work: () => unknown): { sql: string; plan: string[] }[] {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const originals = Object.fromEntries((["get", "all", "iterate"] as const).map((name) => [name, statement[name]!]));
  const found: { sql: string; plan: string[] }[] = [];
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: Database.Statement, ...args: unknown[]) {
      if (!/^\s*(EXPLAIN|PRAGMA|BEGIN|COMMIT|ROLLBACK|ATTACH|DETACH)/u.test(this.source) && this.reader) {
        const plan = (originals.all!.apply(this.database.prepare(`EXPLAIN QUERY PLAN ${this.source}`), args) as { detail: string }[]).map((row) => row.detail);
        found.push({ sql: this.source, plan });
      }
      return original.apply(this, args);
    };
  }
  try {
    work();
  } finally {
    Object.assign(statement, originals);
  }
  return found;
}
