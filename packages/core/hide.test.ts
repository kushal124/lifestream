import { describe, expect, it, vi } from "vitest";
import {
  bracketHeld, DETAIL_TYPES, DETAIL_WORDS, detailKey, emptyTable, heldMarks, hideDetails, HideError, hides, restoreDetails, wantedOf, wants,
  type DetailType, type Entry, type Level, type Marked, type Owner, type PlaceholderTable,
} from "./hide.js";
import type { Mark } from "./types.js";
import { readWords } from "./words.js";

function at(text: string, words: string, type: DetailType, extra: Partial<Mark> = {}, occurrence = 1): Mark {
  let start = -1;
  for (let seen = 0; seen < occurrence; seen += 1) {
    start = text.indexOf(words, start + 1);
    if (start === -1) throw new Error(`fixture: ${JSON.stringify(words)} is not in ${JSON.stringify(text)} ${occurrence} times`);
  }
  return { start, end: start + words.length, type, ...extra };
}

const one = (text: string, marks: Mark[], level: Level = "all", table: PlaceholderTable = emptyTable("ask:test"), owner: Owner | null = null) =>
  hideDetails([{ text, marks }], level, table, owner);

const LEVELS: Level[] = ["all", "names", "none", ["number.bank"], []];

describe("hideDetails", () => {
  it("hides the spec's example under all: one person by both her names, her address and her phone", () => {
    const text = "From: Ada Example <ada@example.com>\nCall me on +15550000142. — Ada";
    const hidden = one(text, [
      at(text, "Ada Example", "person"), at(text, "ada@example.com", "email"), at(text, "+15550000142", "phone"), at(text, "Ada", "person", {}, 2),
    ]);
    expect(hidden.texts).toEqual(["From: [[Person 1]] <[[Email 1]]>\nCall me on [[Phone 1]]. — [[Person 1]]"]);
    expect(hidden.table.entries.map(({ placeholder, detail }) => `${placeholder} = ${detail}`)).toEqual([
      "[[Person 1]] = Ada Example", "[[Email 1]] = ada@example.com", "[[Phone 1]] = +15550000142",
    ]);
    expect(hidden.counts).toEqual({ person: 2, email: 1, phone: 1 });
    expect(hidden.table.next).toEqual({ person: 2, email: 2, phone: 2 });
  });

  it("gives one person one placeholder by `who`, and her account its own", () => {
    const text = "Ada Example wrote; ada replied as adaex.";
    const hidden = one(text, [
      at(text, "Ada Example", "person", { who: "p-1", shown: "Ada Example" }), at(text, "ada", "person", { who: "p-1" }), at(text, "adaex", "account", { who: "p-1" }),
    ]);
    expect(hidden.texts).toEqual(["[[Person 1]] wrote; [[Person 1]] replied as [[Account 1]]."]);
  });

  it("gives two people who share a first name two placeholders, and a phone two people share one, however it is spelled", () => {
    const text = "Ada met Ada. Call +1 555 000 0001 or 15550000001 or (555) 000-0001; not 555 000 0002.";
    const hidden = one(text, [
      at(text, "Ada", "person", { who: "p-1" }), at(text, "Ada", "person", { who: "p-2" }, 2),
      at(text, "+1 555 000 0001", "phone", { who: "p-1" }), at(text, "15550000001", "phone", { who: "p-2" }), at(text, "(555) 000-0001", "phone"), at(text, "555 000 0002", "phone"),
    ]);
    expect(hidden.texts).toEqual(["[[Person 1]] met [[Person 2]]. Call [[Phone 1]] or [[Phone 1]] or [[Phone 1]]; not [[Phone 2]]."]);
  });

  it("joins a single name to the one fuller name of the call that holds it, seen before or after, and never to two", () => {
    const before = "Ada said hi. Then ADA  example arrived.";
    expect(one(before, [at(before, "Ada", "person"), at(before, "ADA  example", "person")]).texts).toEqual(["[[Person 1]] said hi. Then [[Person 1]] arrived."]);
    const two = "Ada Example and Ada Stranger met; Ada left.";
    expect(one(two, [at(two, "Ada Example", "person"), at(two, "Ada Stranger", "person"), at(two, "Ada", "person", {}, 3)]).texts)
      .toEqual(["[[Person 1]] and [[Person 2]] met; [[Person 3]] left."]);
    const first = one("Ada Example called.", [{ start: 0, end: 11, type: "person" }], "all", emptyTable("grant:g-1"));
    const later = one("Ada called.", [{ start: 0, end: 3, type: "person" }], "all", first.table);
    expect(later.texts).toEqual(["[[Person 2]] called."]);
    const beside = "Ada: a photo. Then Ada Example: Ada Example wrote.";
    const widened = one(beside, [at(beside, "Ada", "person", {}, 2), at(beside, "Ada Example", "person", {}, 2)]);
    expect(widened.texts).toEqual(["[[Person 1]]: a photo. Then [[Person 1]]: [[Person 1]] wrote."]);
    expect(restoreDetails(widened.texts[0]!, widened.table).text).toBe("Ada Example: a photo. Then Ada Example: Ada Example wrote.");
    const last = "Ada Example left; Ada Example came.";
    const lastFirst = one(last, [at(last, "Example", "person"), at(last, "Ada Example", "person", {}, 2)]);
    expect(restoreDetails(lastFirst.texts[0]!, lastFirst.table).text).toBe(last);
    const both = "Ada Example: hi. Ada Example wrote.";
    const taken = one(both, [at(both, "Ada", "person"), at(both, "Example", "person"), at(both, "Ada Example", "person", {}, 2)]);
    expect(taken.texts).toEqual(["[[Person 1]]: hi. [[Person 1]] wrote."]);
    const shared = "Ada Example: hi. Ada Example wrote. Ada Stranger came.";
    const sharedOut = one(shared, [at(shared, "Ada", "person"), at(shared, "Example", "person"), at(shared, "Ada Example", "person", {}, 2), at(shared, "Ada Stranger", "person")]);
    expect(sharedOut.texts).toEqual(["[[Person 1]]: hi. [[Person 1]] wrote. [[Person 2]] came."]);
    expect(sharedOut.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Person 1]]", "[[Person 2]]"]);
    const titled = "Dr. Ada Example wrote. Dr. Ada Example's photo.";
    const title = one(titled, [at(titled, "Dr. Ada Example", "person"), at(titled, "Ada", "person", {}, 2)]);
    expect(title.texts).toEqual(["[[Person 1]] wrote. [[Person 1]]'s photo."]);
    expect(restoreDetails(title.texts[0]!, title.table).text).toBe(titled);
    const known = "Ada Example wrote. Ada Example: hi";
    const marks = [at(known, "Ada Example", "person", { who: "p-1" }), at(known, "Ada", "person", {}, 2)];
    expect(one(known, marks).texts).toEqual(["[[Person 1]] wrote. [[Person 1]]: hi"]);
    const entries: Entry[] = [{ placeholder: "[[Person 1]]", type: "person", detail: "Bo Example", who: "p-2" }, { placeholder: "[[Person 2]]", type: "person", detail: "Dr Ada Example" }, { placeholder: "[[Person 3]]", type: "person", detail: "Ada", who: "p-1" }];
    const held: PlaceholderTable = { scope: "grant:g-2", entries, next: { person: 4 } };
    const wholeTable = hideDetails([{ text: known, marks }], "all", held, null);
    const partTable = hideDetails([{ text: known, marks }], "all", { ...held, entries: entries.filter((entry) => wants(wantedOf([{ text: known, marks }]), entry)) }, null);
    expect(wholeTable.texts).toEqual(["[[Person 3]] wrote. [[Person 3]]: hi"]);
    expect(partTable.texts).toEqual(wholeTable.texts);
    const apart = "Ada\nExample came. Ada Example left.";
    expect(one(apart, [at(apart, "Ada", "person"), at(apart, "Ada Example", "person")]).texts).toEqual(["[[Person 1]]\nExample came. [[Person 1]] left."]);
    const call = hideDetails([{ text: "Ada", marks: [{ start: 0, end: 3, type: "person" }] }, { text: "Ada Example", marks: [{ start: 0, end: 11, type: "person", who: "p-1" }] }], "all", emptyTable("ask:t"), null);
    expect(call.texts).toEqual(["[[Person 1]]", "[[Person 1]]"]);
  });

  it("answers each text's spans over the text it was given: each span's words, replaced by its placeholder, give the hidden text, for names grouped across texts and a held placeholder", () => {
    const held: PlaceholderTable = { scope: "ask:s", entries: [{ placeholder: "[[Person 5]]", type: "person", detail: "Bo Example", who: "p-2" }], next: { person: 6 } };
    const first = "Ada said hi to Bo Example.";
    const second = "Ada Example called +15550000001; Bo Example did not.";
    const hidden = hideDetails([
      { text: first, marks: [at(first, "Ada", "person"), at(first, "Bo Example", "person", { who: "p-2" })] },
      { text: second, marks: [at(second, "Ada Example", "person"), at(second, "+15550000001", "phone"), at(second, "Bo Example", "person", { who: "p-2" })] },
    ], "all", held, null);
    const replaced = (text: string, spans: readonly { start: number; end: number; placeholder: string }[]) => {
      let out = "";
      let from = 0;
      for (const span of spans) {
        out += text.slice(from, span.start) + span.placeholder;
        from = span.end;
      }
      return out + text.slice(from);
    };
    expect([replaced(first, hidden.spans[0]!), replaced(second, hidden.spans[1]!)]).toEqual(hidden.texts);
    expect(hidden.texts).toEqual(["[[Person 6]] said hi to [[Person 5]].", "[[Person 6]] called [[Phone 1]]; [[Person 5]] did not."]);
    expect(hidden.spans[0]).toEqual([{ start: 0, end: 3, placeholder: "[[Person 6]]" }, { start: 15, end: 25, placeholder: "[[Person 5]]" }]);
  });

  it("numbers afresh in every table, so a receiver cannot follow a person across asks", () => {
    const first = "Ada wrote to Bo.";
    const second = "Bo wrote to Ada.";
    const a = one(first, [at(first, "Ada", "person", { who: "p-1" }), at(first, "Bo", "person", { who: "p-2" })], "all", emptyTable("ask:a"));
    const b = one(second, [at(second, "Bo", "person", { who: "p-2" }), at(second, "Ada", "person", { who: "p-1" })], "all", emptyTable("ask:b"));
    expect(a.texts).toEqual(["[[Person 1]] wrote to [[Person 2]]."]);
    expect(b.texts).toEqual(["[[Person 1]] wrote to [[Person 2]]."]);
    expect(b.table.entries.find((entry) => entry.who === "p-1")!.placeholder).toBe("[[Person 2]]");
  });

  it("makes the owner [[Person 0]], whatever they are called, holds them in every table of a call with an owner, and moves no counter", () => {
    const owner: Owner = { who: "p-owner", shown: "Owen Example" };
    const text = "Owen and Ada.";
    const hidden = one(text, [at(text, "Owen", "person", { who: "p-owner" }), at(text, "Ada", "person", { who: "p-1" })], "all", emptyTable("ask:o"), owner);
    expect(hidden.texts).toEqual(["[[Person 0]] and [[Person 1]]."]);
    expect(hidden.table.next).toEqual({ person: 2 });
    expect(restoreDetails("[[Person 0]] thanked [[Person 1]].", hidden.table).text).toBe("Owen Example thanked Ada.");
    const unnamed = one("Ada called.", [{ start: 0, end: 3, type: "person", who: "p-1" }], "all", emptyTable("ask:p"), owner);
    expect(unnamed.table.entries).toEqual([
      { placeholder: "[[Person 0]]", type: "person", detail: "Owen Example", who: "p-owner", shown: "Owen Example" },
      { placeholder: "[[Person 1]]", type: "person", detail: "Ada", who: "p-1" },
    ]);
    expect(restoreDetails("[[person 0]] called back", unnamed.table)).toMatchObject({ text: "Owen Example called back", unknown: [] });
    expect(one("Owen", [{ start: 0, end: 4, type: "person", who: "p-owner" }], "all", unnamed.table, owner).table.entries).toHaveLength(2);
    expect(one("Ada", [], "none", emptyTable("ask:q"), owner).table.entries).toHaveLength(1);
    expect(one("Ada", [], "all", emptyTable("ask:q"), null).table.entries).toEqual([]);
  });

  it("reads a text's [[Person 0]] alike in a scope's first call and its second: the owner is held before the text is read", () => {
    const owner: Owner = { who: "p-owner", shown: "Owen Example" };
    const text = "Notes for [[Person 0]], also spelled Person 0, and Ada.";
    const marks = [at(text, "Ada", "person", { who: "p-1" })];
    const first = one(text, marks, "all", emptyTable("ask:s"), owner);
    const second = one(text, marks, "all", first.table, owner);
    expect(first.texts[0]).not.toContain("Person 0");
    expect(first.texts).toEqual(second.texts);
    expect(first.counts).toEqual(second.counts);
    expect(second.table).toEqual(first.table);
  });

  it("puts the owner back by their name now, after they renamed themselves", () => {
    const first = one("Cy called.", [{ start: 0, end: 2, type: "person", who: "p-1" }], "all", emptyTable("ask:r"), { who: "p-owner", shown: "Ada Example" });
    expect(restoreDetails("[[Person 0]] said", first.table).text).toBe("Ada Example said");
    const renamed = one("Bo called.", [{ start: 0, end: 2, type: "person", who: "p-2" }], "all", first.table, { who: "p-owner", shown: "Ada Sample" });
    expect(restoreDetails("[[Person 0]] said", renamed.table).text).toBe("Ada Sample said");
    expect(renamed.table.entries.filter((entry) => entry.placeholder === "[[Person 0]]")).toHaveLength(1);
  });

  it("hides what a list names: a type alone under a list of its subtypes, never an order number a rule typed", () => {
    const text = "IBAN GB00EXAMPLE0001, ref 7741, order 99812, phone 5550001";
    const marks = [at(text, "GB00EXAMPLE0001", "number.bank"), at(text, "7741", "number"), at(text, "99812", "number.order"), at(text, "5550001", "phone")];
    expect(one(text, marks, ["number.bank"]).texts).toEqual(["IBAN [[Number 1]], ref [[Number 2]], order 99812, phone 5550001"]);
    expect(one(text, marks, ["number"]).texts).toEqual(["IBAN [[Number 1]], ref [[Number 2]], order [[Number 3]], phone 5550001"]);
    expect(one(text, marks, "names").texts).toEqual(["IBAN [[Number 1]], ref [[Number 2]], order [[Number 3]], phone [[Phone 1]]"]);
    expect(hides(["number.card"], "number")).toBe(true);
    expect(hides(["number.card"], "number.bank")).toBe(false);
    expect(hides("names", "person")).toBe(false);
    expect(hides("all", "ref")).toBe(false);
  });

  it("gives one value marked as two types one placeholder, the type minted first, hidden when the level hides either, and puts it back exactly", () => {
    const password = "my password is ABCDE1234F";
    const tax = "PAN: ABCDE1234F";
    const marked: Marked[] = [{ text: password, marks: [at(password, "ABCDE1234F", "secret")] }, { text: tax, marks: [at(tax, "ABCDE1234F", "number.tax")] }];
    const both = hideDetails(marked, "all", emptyTable("chat:c-1"), null);
    expect(both.texts).toEqual(["my password is [[Secret 1]]", "PAN: [[Secret 1]]"]);
    expect(both.table.entries).toEqual([{ placeholder: "[[Secret 1]]", type: "secret", detail: "ABCDE1234F" }]);
    expect(both.texts.map((text) => restoreDetails(text, both.table).text)).toEqual([password, tax]);
    const first = hideDetails([marked[1]!], "all", emptyTable("chat:c-1"), null);
    const second = hideDetails([marked[0]!], "all", first.table, null);
    expect([...first.texts, ...second.texts]).toEqual(["PAN: [[Number 1]]", "my password is [[Number 1]]"]);
    expect(second.table.entries).toHaveLength(1);
    expect(restoreDetails(second.texts[0]!, second.table).text).toBe(password);
    expect(hideDetails(marked, ["secret"], emptyTable("chat:c-1"), null).texts).toEqual(["my password is [[Secret 1]]", "PAN: [[Secret 1]]"]);
    expect(hideDetails(marked, ["number.tax"], emptyTable("chat:c-1"), null).texts).toEqual(["my password is [[Secret 1]]", "PAN: [[Secret 1]]"]);
    expect(hideDetails([marked[0]!], ["number.tax"], first.table, null).texts).toEqual(["my password is [[Number 1]]"]);
    expect(hideDetails(marked, ["email"], emptyTable("chat:c-1"), null).texts).toEqual([password, tax]);
  });

  it("never sends plain a value its scope's table holds, under any type the level leaves, but a person, who keeps the level's rule", () => {
    const tax = "PAN: ABCDE1234F";
    const password = "my netbanking password is ABCDE1234F";
    const read1 = hideDetails([{ text: tax, marks: [at(tax, "ABCDE1234F", "number.tax")] }, { text: password, marks: [at(password, "ABCDE1234F", "secret")] }], ["secret"], emptyTable("grant:g-1"), null);
    expect(read1.texts).toEqual(["PAN: [[Number 1]]", "my netbanking password is [[Number 1]]"]);
    const read2 = hideDetails([{ text: tax, marks: [at(tax, "ABCDE1234F", "number.tax")] }], ["secret"], read1.table, null);
    expect(read2.texts).toEqual(["PAN: [[Number 1]]"]);
    expect(read2.table).toEqual(read1.table);
    const line = "Ada Example wrote from adaex";
    const marks = [at(line, "Ada Example", "person", { who: "p-ada" }), at(line, "adaex", "account")];
    const before = one(line, marks, "all", emptyTable("chat:c-2"));
    expect(before.texts).toEqual(["[[Person 1]] wrote from [[Account 1]]"]);
    expect(one(line, marks, "names", before.table).texts).toEqual(["Ada Example wrote from [[Account 1]]"]);
    expect(one(tax, [at(tax, "ABCDE1234F", "number.tax")], "none", read1.table).texts).toEqual([tax]);
  });

  it("never sends plain a value its scope hid where no mark finds it now, by its words, and so in a table taken in part", () => {
    const first = one("RAVI wrote the plan", [{ start: 0, end: 4, type: "person" }], "all", emptyTable("chat:c-9"));
    expect(first.texts).toEqual(["[[Person 1]] wrote the plan"]);
    const second: Marked[] = [{ text: "Thanks RAVI, and Ravi's notes; ravi, Ravindra and XRAVI stay.", marks: [] }];
    const again = hideDetails(second, "all", first.table, null);
    expect(again.texts).toEqual(["Thanks [[Person 1]], and [[Person 1]]'s notes; [[Person 1]], Ravindra and XRAVI stay."]);
    expect(again.table).toEqual(first.table);
    expect(again.counts).toEqual({ person: 3 });
    const joined = "See example.com/ravi, C:\\Users\\ravi, ravi@example.com, ravi_ex, ravi.example, ?u=ravi and #ravi; ravi.";
    expect(hideDetails([{ text: joined, marks: [] }], "all", first.table, null).texts).toEqual([joined.replace(/ravi\.$/u, "[[Person 1]].")]);
    const hazel = one("Hazel wrote", [{ start: 0, end: 5, type: "person" }], "all", emptyTable("chat:c-14"));
    expect(hideDetails([{ text: "HAZEL called; hazel eyes", marks: [] }], "all", hazel.table, null).texts).toEqual(["[[Person 1]] called; hazel eyes"]);
    const bramble = one("Bramble wrote", [{ start: 0, end: 7, type: "person" }], "all", emptyTable("chat:c-16"));
    expect(hideDetails([{ text: "BRAMBLE called; bramble too", marks: [] }], "all", bramble.table, null).texts).toEqual(["[[Person 1]] called; [[Person 1]] too"]);
    const token = one("ran zorbix twice", [at("ran zorbix twice", "zorbix", "account")], "all", emptyTable("chat:c-15"));
    expect(hideDetails([{ text: "Zorbix and ZORBIX; zorbix", marks: [] }], "all", token.table, null).texts).toEqual(["Zorbix and ZORBIX; [[Account 1]]"]);
    const small = one("ravi ko bula lena", [at("ravi ko bula lena", "ravi", "person")], "all", emptyTable("chat:c-17"));
    expect(hideDetails([{ text: "Ravi came, RAVI paid; example.com/Ravi", marks: [] }], "all", small.table, null).texts).toEqual(["[[Person 1]] came, [[Person 1]] paid; example.com/Ravi"]);
    const tokenPerson = one("ran zorbix twice", [at("ran zorbix twice", "zorbix", "person")], "all", emptyTable("chat:c-20"));
    expect(hideDetails([{ text: "Zorbix and ZORBIX; zorbix", marks: [] }], "all", tokenPerson.table, null).texts).toEqual(["Zorbix and ZORBIX; [[Person 1]]"]);
    const smallHazel = one("ask hazel", [at("ask hazel", "hazel", "person")], "all", emptyTable("chat:c-18"));
    expect(hideDetails([{ text: "Hazel and HAZEL called", marks: [] }], "all", smallHazel.table, null).texts).toEqual(["[[Person 1]] and [[Person 1]] called"]);
    const rose = one("ask rose", [at("ask rose", "rose", "person")], "all", emptyTable("chat:c-19"));
    expect(hideDetails([{ text: "a Rose and a rose", marks: [] }], "all", rose.table, null).texts).toEqual(["a Rose and a rose"]);
    expect(hideDetails([{ text: "example.com/RAVI", marks: [] }], "all", first.table, null).texts).toEqual(["example.com/[[Person 1]]"]);
    const exact: PlaceholderTable = { scope: "chat:c-12", entries: [{ placeholder: "[[Secret 1]]", type: "secret", detail: "abcde1234f" }], next: { secret: 2 } };
    expect(hideDetails([{ text: "abcde1234f, ABCDE1234F", marks: [] }], "all", exact, null).texts).toEqual(["[[Secret 1]], ABCDE1234F"]);
    const held: PlaceholderTable = {
      scope: "chat:c-10",
      entries: [
        { placeholder: "[[Person 1]]", type: "person", detail: "Ravi Example", who: "p-ravi" }, { placeholder: "[[Phone 1]]", type: "phone", detail: "+1 555 000 0142" },
        { placeholder: "[[Email 1]]", type: "email", detail: "person-a@example.com" }, { placeholder: "[[Account 1]]", type: "account", detail: "@ravi_ex" },
      ],
      next: { person: 2, phone: 2, email: 2, account: 2 },
    };
    const text = "Ravi Example called from +1 555 000 0142 (person-a@example.com) as @ravi_ex; Ravi Examples and 2+1 555 000 0142 did not. Bo Ravi Example came.";
    const marks = [at(text, "Bo Ravi Example", "person")];
    const found = hideDetails([{ text, marks }], "all", held, null);
    expect(found.texts).toEqual(["[[Person 1]] called from [[Phone 1]] ([[Email 1]]) as [[Account 1]]; Ravi Examples and 2+1 555 000 0142 did not. [[Person 2]] came."]);
    expect(found.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Person 1]]", "[[Phone 1]]", "[[Email 1]]", "[[Account 1]]", "[[Person 2]]"]);
    expect(hideDetails([{ text, marks }], "names", held, null).texts[0]).toBe("Ravi Example called from [[Phone 1]] ([[Email 1]]) as [[Account 1]]; Ravi Examples and 2+1 555 000 0142 did not. Bo Ravi Example came.");
    expect(hideDetails([{ text, marks }], "none", held, null).texts[0]).toBe(text);
    expect(hideDetails([{ text, marks: [], quoted: true }], "all", held, null).texts[0]).toBe(text);
    const plain: PlaceholderTable = { scope: "chat:c-11", entries: [{ placeholder: "[[Person 1]]", type: "person", detail: "Rose" }, { placeholder: "[[Account 1]]", type: "account", detail: "will" }], next: { person: 2, account: 2 } };
    expect(hideDetails([{ text: "Rose will bring a rose", marks: [] }], "all", plain, null).texts).toEqual(["Rose will bring a rose"]);
    const call: Marked[] = [{ text: "Ada Example wrote. Later Ada Example came.", marks: [{ start: 0, end: 11, type: "person" }] }, { text: "Ada Example, again", marks: [] }];
    expect(hideDetails(call, "all", emptyTable("ask:c"), null).texts).toEqual(["[[Person 1]] wrote. Later [[Person 1]] came.", "[[Person 1]], again"]);
    const many: Entry[] = [...held.entries];
    for (let index = 0; index < 10_000; index += 1) many.push({ placeholder: `[[Person ${index + 2}]]`, type: "person", detail: `Name${index} Example${index}` });
    const big: PlaceholderTable = { ...held, entries: many, next: { ...held.next, person: 10_002 } };
    const asked: Marked[] = [{ text: `${text} Name7 Example7 too.`, marks }];
    const wanted = wantedOf(asked);
    const part = many.filter((entry) => wants(wanted, entry));
    expect(part.map((entry) => entry.placeholder)).toEqual(["[[Person 1]]", "[[Phone 1]]", "[[Email 1]]", "[[Account 1]]", "[[Person 9]]"]);
    const whole = hideDetails(asked, "all", big, null);
    expect(hideDetails(asked, "all", { ...big, entries: part }, null).texts).toEqual(whole.texts);
    expect(whole.texts[0]!.endsWith("[[Person 10002]] came. [[Person 9]] too.")).toBe(true);
  });

  it("sends plain a word the never list names, though its scope's table holds it: the person's explicit choice wins", () => {
    const first = one("Lifestream wrote the plan", [{ start: 0, end: 10, type: "person" }], "all", emptyTable("chat:c-13"));
    expect(first.texts).toEqual(["[[Person 1]] wrote the plan"]);
    const text = "Lifestream and LIFESTREAM ship for Ada Example";
    const marks = [at(text, "Ada Example", "person")];
    const second = hideDetails([{ text, marks }], "all", first.table, null, ["lifestream"]);
    expect(second.texts).toEqual(["Lifestream and LIFESTREAM ship for [[Person 2]]"]);
    expect(second.table.entries.map((entry) => entry.placeholder)).toEqual(["[[Person 1]]", "[[Person 2]]"]);
    expect(restoreDetails("[[Person 1]]", second.table).text).toBe("Lifestream");
    expect(hideDetails([{ text, marks }], "all", first.table, null).texts).toEqual(["[[Person 1]] and [[Person 1]] ship for [[Person 2]]"]);
    const held: PlaceholderTable = { scope: "grant:g-2", entries: [{ placeholder: "[[Number 1]]", type: "number.tax", detail: "ABCDE1234F" }], next: { number: 2 } };
    const tax = "PAN: ABCDE1234F";
    expect(hideDetails([{ text: tax, marks: [at(tax, "ABCDE1234F", "number.tax")] }], ["secret"], held, null, ["abcde1234f"]).texts).toEqual([tax]);
  });

  it("finds a value the scope hid where it stands in a text it does not hide, a picture's read words, by the rule a text's are found by (`heldMarks`)", () => {
    const first = one("Quorvel Exampleton wrote", [{ start: 0, end: 18, type: "person", who: "p-q" }], "all", emptyTable("chat:c-20"));
    const read = "Quorvel Exampleton\nQUORVEL EXAMPLETON sent 4417 to quorvel.exampleton@example.com";
    const pictures: Marked[] = [{ text: read, marks: [at(read, "4417", "number")] }];
    const held = heldMarks(pictures, "all", first.table);
    expect(held).toEqual([[at(read, "Quorvel Exampleton", "person", { who: "p-q" }), at(read, "QUORVEL EXAMPLETON", "person", { who: "p-q" })]]);
    expect(hideDetails(pictures, "all", first.table, null).texts).toEqual(["[[Person 1]]\n[[Person 1]] sent [[Number 1]] to quorvel.exampleton@example.com"]);
    const call: Marked[] = [{ text: "PAN ABCDE1234F", marks: [at("PAN ABCDE1234F", "ABCDE1234F", "number.tax")] }, { text: "card: ABCDE1234F", marks: [] }];
    expect(heldMarks(call, "all", emptyTable("ask:p"))[1]).toEqual([at("card: ABCDE1234F", "ABCDE1234F", "number.tax")]);
    expect(heldMarks(pictures, "names", first.table)).toEqual([[]]);
    expect(heldMarks(pictures, "all", first.table, ["quorvel exampleton"])).toEqual([[]]);
    expect(heldMarks([{ text: read, marks: [], quoted: true }], "all", first.table)).toEqual([[]]);
    expect(heldMarks(pictures, "none", first.table)).toEqual([[]]);
  });

  it("leaves the writer's own words as written (`leave`): no value found there by its words, no placeholder shape hidden there, and no number given whose bare spelling stands there", () => {
    const faces: Entry[] = [{ placeholder: "[[Person 1]]", type: "person", detail: "", face: { x: 0, y: 0, width: 10, height: 10 } }];
    const table: PlaceholderTable = { scope: "ask:p-2", entries: [...faces, { placeholder: "[[Person 2]]", type: "person", detail: "Ravi Example", who: "p-ravi" }], next: { person: 3 } };
    const own = "Describe [[Person 1]] beside Ravi Example; call a new face Person 4. ";
    const text = `${own}Record: [[Person 1]] met Ravi Example and Bo.`;
    const marked: Marked[] = [{ text, marks: [at(text, "Bo", "person")], leave: [{ start: 0, end: own.length }] }];
    const hidden = hideDetails(marked, "all", table, null);
    expect(hidden.texts).toEqual([`${own}Record: [[Word 1]] met [[Person 2]] and [[Person 5]].`]);
    const four = `${own}Record: Ada, Bo and Cy.`;
    const counted = hideDetails([{ text: four, marks: [at(four, "Ada", "person"), at(four, "Bo", "person"), at(four, "Cy", "person")], leave: [{ start: 0, end: own.length }] }], "all", table, null);
    expect(counted.texts).toEqual([`${own}Record: [[Person 5]], [[Person 6]] and [[Person 7]].`]);
    expect(heldMarks([{ text: own, marks: [], leave: [{ start: 0, end: own.length }] }], "all", table)).toEqual([[]]);
    expect(wantedOf([{ text: own, marks: [], leave: [{ start: 0, end: own.length }] }]).words).toEqual(new Set());
    const stated = hideDetails([{ text: own, marks: [at(own, "Ravi Example", "person", { who: "p-ravi" })], leave: [{ start: 0, end: own.length }] }], "all", table, null);
    expect(stated.texts).toEqual(["Describe [[Person 1]] beside [[Person 2]]; call a new face Person 4. "]);
    expect(() => hideDetails([{ text: own, marks: [], leave: [{ start: 0, end: own.length + 1 }] }], "all", table, null)).toThrow(HideError);
  });

  it("joins two types only where both types' rules find one value, and never a person, a ref or a face to another type", () => {
    const text = "secret abcde1234f, PAN ABCDE1234F, Rose wrote Rose";
    const marks = [at(text, "abcde1234f", "secret"), at(text, "ABCDE1234F", "number.tax"), at(text, "Rose", "person"), at(text, "Rose", "word", {}, 2)];
    expect(one(text, marks).texts).toEqual(["secret [[Secret 1]], PAN [[Number 1]], [[Person 1]] wrote [[Word 1]]"]);
    const digits = "call +1 555 000 0142, account 15550000142, ref 5550000142";
    const numbers = [at(digits, "+1 555 000 0142", "phone"), at(digits, "15550000142", "number.bank"), at(digits, "5550000142", "number.order", {}, 2)];
    expect(one(digits, numbers).texts).toEqual(["call [[Phone 1]], account [[Phone 1]], ref [[Number 1]]"]);
  });

  it("keys a value by its fold, not its type: found again under another crossing type and under another fold, from a table in part", () => {
    expect(detailKey("account", "Main  Street")).toBe(detailKey("address", "main street"));
    expect(detailKey("person", "main street")).not.toBe(detailKey("account", "main street"));
    expect(wantedOf([{ text: "AB-12", marks: [{ start: 0, end: 5, type: "number" }] }]).keys.size).toBe(5);
    expect(wantedOf([{ text: "Ada", marks: [{ start: 0, end: 3, type: "person" }] }]).keys.size).toBe(1);
    const held: PlaceholderTable = { scope: "chat:keys", entries: [{ placeholder: "[[Account 1]]", type: "account", detail: "Hope Street Example" }], next: { account: 2 } };
    const text = "meet at hope street example";
    const marks = [at(text, "hope street example", "address")];
    expect(held.entries.filter((entry) => wants(wantedOf([{ text, marks }]), entry))).toEqual(held.entries);
    expect(hideDetails([{ text, marks }], "all", held, null).texts).toEqual(["meet at [[Account 1]]"]);
    const number: PlaceholderTable = { scope: "chat:keys", entries: [{ placeholder: "[[Number 1]]", type: "number.bank", detail: "15550000142" }], next: { number: 2 } };
    const phone = "call +1 555 000 0142";
    const phoneMarks = [at(phone, "+1 555 000 0142", "phone")];
    expect(number.entries.filter((entry) => wants(wantedOf([{ text: phone, marks: phoneMarks }]), entry))).toEqual(number.entries);
    expect(hideDetails([{ text: phone, marks: phoneMarks }], "all", number, null).texts).toEqual(["call [[Number 1]]"]);
    const words: PlaceholderTable = { scope: "chat:keys", entries: [{ placeholder: "[[Account 1]]", type: "account", detail: "Ada Example" }, { placeholder: "[[Secret 1]]", type: "secret", detail: "Zx-9" }], next: { account: 2, secret: 2 } };
    const both = "Ada Example and zx-9";
    expect(hideDetails([{ text: both, marks: [at(both, "Ada Example", "person"), at(both, "zx-9", "word")] }], "all", words, null).texts).toEqual(["[[Person 1]] and [[Word 1]]"]);
  });

  it("takes, of a value held as two other types, the earlier type's entry (account before word), whichever was added first", () => {
    const held: PlaceholderTable = {
      scope: "chat:order",
      entries: [{ placeholder: "[[Word 1]]", type: "word", detail: "AB12" }, { placeholder: "[[Account 1]]", type: "account", detail: "AB12" }],
      next: { word: 2, account: 2 },
    };
    const text = "id AB12";
    expect(hideDetails([{ text, marks: [at(text, "AB12", "number")] }], "all", held, null).texts).toEqual(["id [[Account 1]]"]);
  });

  it("reads a text the same given its words read by the caller (`readWords`), and reads anew a reading of another text", () => {
    const text = "Ada Example wrote to ada@example.com; Ada Example again, ADA EXAMPLE";
    const marks = [at(text, "Ada Example", "person")];
    const table: PlaceholderTable = { scope: "chat:read", entries: [{ placeholder: "[[Email 1]]", type: "email", detail: "ada@example.com" }], next: { email: 2 } };
    const plain = hideDetails([{ text, marks }], "all", table, null);
    expect(hideDetails([{ text, marks, reading: readWords(text) }], "all", table, null)).toEqual(plain);
    expect(hideDetails([{ text, marks, reading: readWords("another text") }], "all", table, null)).toEqual(plain);
    expect(wantedOf([{ text, marks, reading: readWords(text) }])).toEqual(wantedOf([{ text, marks }]));
    expect(heldMarks([{ text, marks, reading: readWords(text) }], "all", table)).toEqual(heldMarks([{ text, marks }], "all", table));
  });

  it("makes every ref a handle under every level, one handle per ref", () => {
    for (const level of LEVELS) {
      const text = "see whatsapp:a:b/1 and whatsapp:a:b/2, again whatsapp:a:b/1";
      const hidden = one(text, [at(text, "whatsapp:a:b/1", "ref"), at(text, "whatsapp:a:b/2", "ref"), at(text, "whatsapp:a:b/1", "ref", {}, 2)], level);
      expect(hidden.texts).toEqual(["see r1 and r2, again r1"]);
      expect(hidden.table.next).toEqual({ ref: 3 });
    }
  });

  it("leaves shapes that are no placeholder as written under every level, and back again", () => {
    const text = "run [[ -f x ]] then [[bin]] at x[[1]], see [[wiki link]], [[Personal notes]], [[Linked list]] and [[Placeholder]]";
    for (const level of LEVELS) {
      const hidden = one(text, [], level);
      expect(hidden.texts).toEqual([text]);
      expect(restoreDetails(hidden.texts[0]!, hidden.table)).toMatchObject({ text, unknown: [] });
    }
  });

  it("hides a placeholder the record wrote itself under any level that hides, and leaves it under none", () => {
    const text = "the note says [[Person 1]] and [[ person of interest ]], not [[Personal notes]]";
    expect(one(text, [], "all").texts).toEqual(["the note says [[Word 1]] and [[Word 2]], not [[Personal notes]]"]);
    expect(one(text, [], ["number.bank"]).texts).toEqual(["the note says [[Word 1]] and [[Word 2]], not [[Personal notes]]"]);
    expect(one(text, [{ start: 14, end: 26, type: "word" }], ["number.bank"]).texts).toEqual(["the note says [[Word 1]] and [[Word 2]], not [[Personal notes]]"]);
    expect(one(text, [], "none").texts).toEqual([text]);
    expect(one(text, [], []).texts).toEqual([text]);
  });

  it("hides an older placeholder's exact bare spelling, and gives no number whose bare spelling stands readable", () => {
    const table: PlaceholderTable = { scope: "chat:c-1", entries: [{ placeholder: "[[Person 1]]", type: "person", detail: "Ada" }], next: { person: 2, number: 7 } };
    const text = "Person 1 wore Number 7 and Number 8; person 1 again; Bo paid 4417";
    const hidden = one(text, [at(text, "Bo", "person"), at(text, "4417", "number")], "all", table);
    expect(hidden.texts).toEqual(["[[Word 1]] wore Number 7 and Number 8; person 1 again; [[Person 2]] paid [[Number 9]]"]);
    expect(hidden.counts).toEqual({ word: 1, person: 1, number: 1 });
    expect(hidden.table.next).toMatchObject({ person: 3, number: 10, word: 2 });
  });

  it("reads the shapes of every run left readable, between marks, at a text's ends and two in one run, and none a mark covers", () => {
    const table: PlaceholderTable = { scope: "chat:c-1", entries: [{ placeholder: "[[Person 1]]", type: "person", detail: "Ada" }], next: { person: 2, number: 7 } };
    const text = "Person 1 met Bo [[Person 1]]; Bo said Number 7, then Cy at [[Number 9]] Number 8 paid 4417 and Person 1";
    const marks = [at(text, "Bo", "person"), at(text, "Cy", "person"), at(text, "4417", "number")];
    expect(one(text, marks, "all", table).texts).toEqual(["[[Word 1]] met [[Person 2]] [[Word 2]]; [[Person 2]] said Number 7, then [[Person 3]] at [[Word 3]] Number 8 paid [[Number 9]] and [[Word 1]]"]);
    const covered = one(text, [...marks, at(text, "said Number 7", "secret")], "all", table);
    expect(covered.texts).toEqual(["[[Word 1]] met [[Person 2]] [[Word 2]]; [[Person 2]] [[Secret 1]], then [[Person 3]] at [[Word 3]] Number 8 paid [[Number 9]] and [[Word 1]]"]);
    expect(covered.table.next).toMatchObject({ number: 10, word: 4 });
  });

  it("refuses marks it cannot hide whole", () => {
    const text = "Ada Example";
    expect(() => one(text, [{ start: 0, end: 7, type: "person" }, { start: 4, end: 11, type: "person" }])).toThrow(HideError);
    expect(() => one(text, [{ start: 0, end: 12, type: "person" }])).toThrow(HideError);
    expect(() => one(text, [{ start: 0, end: 3, type: "face" }])).toThrow(HideError);
    expect(() => hideDetails([{ text, marks: [{ start: 0, end: 3, type: "person" }], quoted: true }], "all", emptyTable("ask:q"), null)).toThrow(HideError);
  });

  it("passes a quote as the model wrote it, placeholders and all, and numbers past every spelling it shows", () => {
    const table: PlaceholderTable = { scope: "ask:q", entries: [{ placeholder: "[[Person 1]]", type: "person", detail: "Ada" }], next: { person: 2 } };
    const quote: Marked = { text: "[[Person 1]] met [[Person 9]]; Person 2 too", marks: [], quoted: true };
    const hidden = hideDetails([quote, { text: "Bo", marks: [{ start: 0, end: 2, type: "person" }] }], "all", table, null);
    expect(hidden.texts).toEqual(["[[Person 1]] met [[Person 9]]; Person 2 too", "[[Person 10]]"]);
  });

  it("never matches a face's entry by a name, and numbers after the faces", () => {
    const faces: Entry[] = [
      { placeholder: "[[Person 1]]", type: "person", detail: "", face: { x: 0, y: 0, width: 10, height: 10 } },
      { placeholder: "[[Person 2]]", type: "person", detail: "", face: { x: 20, y: 0, width: 10, height: 10 } },
    ];
    const hidden = one("Ada", [{ start: 0, end: 3, type: "person" }], "all", { scope: "ask:p", entries: faces, next: { person: 3 } });
    expect(hidden.texts).toEqual(["[[Person 3]]"]);
  });

  it("answers the same given only the entries `wantedOf` names and every counter as given the whole table, and puts back the same", () => {
    const owner: Owner = { who: "p-owner", shown: "Owen Example" };
    const whole: Entry[] = [{ placeholder: "[[Person 0]]", type: "person", detail: "Owen Example", who: "p-owner", shown: "Owen Example" }];
    whole.push(...Array.from({ length: 2_000 }, (_, index): Entry => ({ placeholder: `[[Person ${index + 1}]]`, type: "person", detail: `Name${index} Example`, who: `p-${index}` })));
    whole.push({ placeholder: "[[Email 1]]", type: "email", detail: "person-a@example.com" }, { placeholder: "[[Phone 1]]", type: "phone", detail: "+1 555 000 0142" });
    whole.push({ placeholder: "[[Word 1]]", type: "word", detail: "[[Person 3]]" });
    const table: PlaceholderTable = { scope: "grant:g-1", entries: whole, next: { person: 2_001, email: 2, phone: 2, word: 2 } };
    const text = "Name7 Example wrote to PERSON-A@example.com and Ada from 555-000-0142; Person 12 replied; the note said [[Person 3]]";
    const marks = [at(text, "Name7 Example", "person", { who: "p-7" }), at(text, "PERSON-A@example.com", "email"), at(text, "Ada", "person", { who: "p-new" }), at(text, "555-000-0142", "phone")];
    const marked: Marked[] = [{ text, marks }];
    const wanted = wantedOf(marked);
    const usable = whole.filter((entry) => wants(wanted, entry));
    const named = Array.from({ length: 100 }, (_, index) => `[[Person ${index + 1}]]`);
    expect(usable.map((entry) => entry.placeholder)).toEqual(["[[Person 0]]", ...named, "[[Email 1]]", "[[Phone 1]]", "[[Word 1]]"]);
    const all = hideDetails(marked, "all", table, owner);
    const part = hideDetails(marked, "all", { ...table, entries: usable }, owner);
    expect(part.texts).toEqual(all.texts);
    expect(all.texts).toEqual(["[[Person 8]] wrote to [[Email 1]] and [[Person 2001]] from [[Phone 1]]; [[Word 2]] replied; the note said [[Word 1]]"]);
    expect(part.table.next).toEqual(all.table.next);
    expect(part.table.entries.slice(usable.length)).toEqual(all.table.entries.slice(whole.length));
    const reply = "[[Person 0]] and [[ person 8 ]] wrote; Person 12 too; [[Phone 1]]";
    const needed = whole.filter((entry) => wants(wantedOf([{ text: reply, marks: [] }]), entry));
    const { table: partTable, ...fromPart } = restoreDetails(reply, { ...table, entries: needed });
    const { table: wholeTable, ...fromWhole } = restoreDetails(reply, table);
    expect(fromPart).toEqual(fromWhole);
    expect(fromWhole.text).toBe("Owen Example and Name7 Example wrote; Name11 Example too; +1 555 000 0142");
    expect(partTable.next).toEqual(wholeTable.next);
    const secrets: PlaceholderTable = { scope: "chat:c-1", entries: [...whole, { placeholder: "[[Secret 1]]", type: "secret", detail: "ABCDE1234F" }], next: { ...table.next, secret: 2 } };
    const pan = "PAN ABCDE1234F";
    const panMarked: Marked[] = [{ text: pan, marks: [at(pan, "ABCDE1234F", "number.tax")] }];
    const panUsable = secrets.entries.filter((entry) => wants(wantedOf(panMarked), entry));
    expect(panUsable.map((entry) => entry.placeholder)).toEqual(["[[Person 0]]", "[[Secret 1]]"]);
    const panWhole = hideDetails(panMarked, ["secret"], secrets, owner);
    expect(hideDetails(panMarked, ["secret"], { ...secrets, entries: panUsable }, owner).texts).toEqual(panWhole.texts);
    expect(panWhole.texts).toEqual(["PAN [[Secret 1]]"]);
  });
});

describe("hideDetails' work", () => {
  const call = (people: number): Marked[] => {
    let text = "";
    const marks: Mark[] = [];
    const write = (words: string, type: DetailType | null) => {
      if (type !== null) marks.push({ start: text.length, end: text.length + words.length, type });
      text += words;
    };
    for (let index = 0; index < people; index += 1) {
      write(`First${index} Last${index}`, "person");
      write(" ", null);
      write("person-a@example.com", "email");
      write(" wrote, then ", null);
      write(`First${index}`, "person");
      write(" said hello. ", null);
      write(`First${index}`, "person");
      write(` Last${index}'s note. Later First${index} Last${index} came.\n`, null);
    }
    return [{ text, marks }];
  };

  const work = (texts: Marked[]): number => {
    let count = 0;
    const methods = ["filter", "map", "flatMap", "forEach", "some", "every", "find", "findIndex", "includes", "indexOf", "reduce"] as const;
    const array = Array.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
    const kept = methods.map((name) => [name, array[name]!] as const);
    const normalize = vi.spyOn(String.prototype, "normalize");
    for (const [name, original] of kept) {
      array[name] = function (this: unknown[], ...args: unknown[]) {
        count += this.length;
        return original.apply(this, args);
      };
    }
    try {
      hideDetails(texts, "all", emptyTable("ask:work"), null);
    } finally {
      for (const [name, original] of kept) array[name] = original;
    }
    count += normalize.mock.calls.length;
    normalize.mockRestore();
    return count;
  };

  it("grows as the call's marks, never as their square", () => {
    const small = call(200);
    const hidden = hideDetails(small, "all", emptyTable("ask:work"), null);
    expect(hidden.texts[0]!.startsWith("[[Person 1]] [[Email 1]] wrote, then [[Person 1]] said hello. [[Person 1]]'s note. Later [[Person 1]] came.\n[[Person 2]] [[Email 1]]")).toBe(true);
    expect(hidden.table.next).toEqual({ person: 201, email: 2 });
    expect(work(call(400))).toBeLessThanOrEqual(2.2 * work(small));
  });
});

describe("restoreDetails", () => {
  const table: PlaceholderTable = {
    scope: "ask:r",
    entries: [
      { placeholder: "[[Person 1]]", type: "person", detail: "ADA EXAMPLE", who: "p-1", shown: "Ada Example" },
      { placeholder: "[[Person 12]]", type: "person", detail: "Bo", who: "p-2" },
      { placeholder: "[[Number 1]]", type: "number", detail: "4417" },
      { placeholder: "[[Email 1]]", type: "email", detail: "person-a@example.com" },
      { placeholder: "[[Person 13]]", type: "person", detail: "", face: { x: 1, y: 2, width: 3, height: 4 } },
    ],
    next: { person: 14, number: 2, email: 2 },
  };

  it("puts back every spelling of a held placeholder, and answers the marks of what it put back", () => {
    const restored = restoreDetails("[[Person 1]], [[person-1]], [[PERSON_1]], [[ Person 1 ]] and [[Person1]] met [[Person 12]] at [[email 1]]", table);
    expect(restored.text).toBe("Ada Example, Ada Example, Ada Example, Ada Example and Ada Example met Bo at person-a@example.com");
    expect(restored.unknown).toEqual([]);
    expect(restored.marks.map((mark) => restored.text.slice(mark.start, mark.end))).toEqual(["Ada Example", "Ada Example", "Ada Example", "Ada Example", "Ada Example", "Bo", "person-a@example.com"]);
    expect(restored.marks[0]).toEqual({ start: 0, end: 11, type: "person", who: "p-1", shown: "Ada Example", placeholder: "[[Person 1]]" });
    expect(restored.marks[5]).toEqual({ start: 71, end: 73, type: "person", who: "p-2", placeholder: "[[Person 12]]" });
  });

  it("puts a single name back as it was written, never as a fuller name", () => {
    const hidden = one("the dev team", [{ start: 4, end: 7, type: "person", who: "p-dev" }]);
    expect(restoreDetails(hidden.texts[0]!, hidden.table).text).toBe("the dev team");
  });

  it("leaves a face's placeholder for the family that asked", () => {
    expect(restoreDetails("[[person 13]] holds a cake", table)).toMatchObject({ text: "[[Person 13]] holds a cake", unknown: [], marks: [] });
  });

  it("marks each detail it put back with its placeholder as the model wrote it, writes a face's as main does and leaves an unknown one as written", () => {
    const text = "[[Person 1]] and [[person 1]] wrote to [[Email 1]] and [[email 1]]; [[Person 13]], [[person 13]] and [[Person 9]] watched.";
    const restored = restoreDetails(text, table);
    expect(restored.text).toBe("Ada Example and Ada Example wrote to person-a@example.com and person-a@example.com; [[Person 13]], [[Person 13]] and [[Person 9]] watched.");
    expect(restored.marks.map((mark) => [restored.text.slice(mark.start, mark.end), mark.placeholder])).toEqual([
      ["Ada Example", "[[Person 1]]"], ["Ada Example", "[[person 1]]"], ["person-a@example.com", "[[Email 1]]"], ["person-a@example.com", "[[email 1]]"],
    ]);
    expect(restored.unknown).toEqual(["[[Person 9]]"]);
  });

  it("refuses an unknown placeholder, puts back a held one written bare, and leaves ordinary words", () => {
    const text = "[[Person 9]] and [[Person 1 and 2]] met Person 12; Number 7 and number 1 priority and Person-12, in [[Personal notes]]";
    const restored = restoreDetails(text, table);
    expect(restored.unknown).toEqual(["[[Person 9]]", "[[Person 1 and 2]]"]);
    expect(restored.text).toBe("[[Person 9]] and [[Person 1 and 2]] met Bo; Number 7 and number 1 priority and Person-12, in [[Personal notes]]");
    expect(restored.marks).toEqual([{ start: 40, end: 42, type: "person", who: "p-2", placeholder: "Person 12" }]);
    expect(restoreDetails("First Meeting With Person 1", table)).toMatchObject({ text: "First Meeting With Ada Example", unknown: [] });
    expect(restoreDetails("Person 13 holds a cake", table)).toMatchObject({ text: "[[Person 13]] holds a cake", unknown: [], marks: [] });
    expect(restoreDetails("Number 7 on a shirt", table)).toMatchObject({ text: "Number 7 on a shirt", unknown: [] });
  });

  it("never gives a number whose bare spelling stood readable in an earlier call, so a bare spelling held is only ever its placeholder", () => {
    const first = one("Person 1 said hi", [], "all");
    expect(first.texts).toEqual(["Person 1 said hi"]);
    expect(first.table.next).toMatchObject({ person: 2 });
    const later = one("Ada said hi", [{ start: 0, end: 3, type: "person" }], "all", first.table);
    expect(later.texts).toEqual(["[[Person 2]] said hi"]);
    expect(restoreDetails("Person 1 and Person 2", later.table).text).toBe("Person 1 and Ada");
    const plain = one("Person 1 said hi", [], "none");
    expect(plain.texts).toEqual(["Person 1 said hi"]);
    expect(plain.table.next).toMatchObject({ person: 2 });
    const quoted = hideDetails([{ text: "Person 1 said hi", marks: [], quoted: true }, { text: "Ada", marks: [{ start: 0, end: 3, type: "person" }] }], "all", emptyTable("ask:q"), null);
    expect(quoted.texts).toEqual(["Person 1 said hi", "[[Person 2]]"]);
    const written = restoreDetails("Number 7 on the list", table);
    expect(written).toMatchObject({ text: "Number 7 on the list", unknown: [] });
    expect(written.table.next).toMatchObject({ number: 8 });
  });

  it("reads no run of more than six digits as a bare spelling, nor more than nine as a placeholder, so no counter is pushed past what it can number", () => {
    const long = one("Account 9007199254740993 and Number 48213 and Phone 1234567", [], "all");
    expect(long.table.next).toEqual({ number: 48_214 });
    const restored = restoreDetails("[[Person 12345678901]] and Person 1234567", table);
    expect(restored).toMatchObject({ text: "[[Person 12345678901]] and Person 1234567", unknown: ["[[Person 12345678901]]"] });
    expect(restored.table.next).toEqual(table.next);
    expect(restoreDetails("[[Person 1234567]]", table).table.next).toEqual(table.next);
  });

  it("brackets each bare spelling the table holds, and nothing else", () => {
    expect(bracketHeld("Person 1 and Person 13, [[Person 1]], Person 99, person 12 and Person-12", table))
      .toBe("[[Person 1]] and [[Person 13]], [[Person 1]], Person 99, person 12 and Person-12");
  });

  it("never gives an unknown placeholder's number to a real detail afterwards", () => {
    const small: PlaceholderTable = { scope: "ask:u", entries: [{ placeholder: "[[Person 1]]", type: "person", detail: "Ada" }], next: { person: 2 } };
    const restored = restoreDetails("[[Person 9]] and [[Persons 3 and 4]]", small);
    expect(restored.table.next).toEqual({ person: 10 });
    expect(one("Bo", [{ start: 0, end: 2, type: "person" }], "all", restored.table).texts).toEqual(["[[Person 10]]"]);
  });
});

describe("DETAIL_WORDS", () => {
  it("words every type and subtype a level names, but ref, one and many, each subtype under its own type", () => {
    const named = DETAIL_WORDS.flatMap((type) => [type.type, ...type.subtypes.map((subtype) => subtype.type)]);
    expect(new Set(named)).toEqual(new Set(DETAIL_TYPES.filter((type) => type !== "ref")));
    expect(named).toHaveLength(DETAIL_TYPES.length - 1);
    for (const words of DETAIL_WORDS.flatMap((type) => [type, ...type.subtypes])) {
      expect(words.one).toMatch(/^[a-z]/u);
      expect(words.many).toMatch(/^[a-z]/u);
      expect(words.many).not.toBe(words.one);
    }
    for (const type of DETAIL_WORDS) for (const subtype of type.subtypes) expect(subtype.type.startsWith(`${type.type}.`)).toBe(true);
    expect(DETAIL_WORDS.find((type) => type.type === "number")).toEqual({
      type: "number", one: "number", many: "numbers", subtypes: [
        { type: "number.bank", one: "bank number", many: "bank numbers" }, { type: "number.card", one: "card number", many: "card numbers" },
        { type: "number.government", one: "government id", many: "government ids" }, { type: "number.tax", one: "tax id", many: "tax ids" },
        { type: "number.payment", one: "payment address", many: "payment addresses" }, { type: "number.order", one: "order number", many: "order numbers" },
      ],
    });
    expect(DETAIL_WORDS.find((type) => type.type === "person")).toMatchObject({ one: "name", many: "names" });
  });
});
