import { describe, expect, it } from "vitest";
import { fold, readWords } from "@lifestreamprotocol/core";
import { compileNames, phonesIn, sealOf, type NameTable } from "./names.js";

describe("the phone scan", () => {
  it("tries at most 15 spans from each group of a run of 20,000, and still finds a contact's phone inside it", () => {
    const groups = Array.from({ length: 20_000 }, (_, index) => String(10 + (index % 90)));
    groups.splice(10_000, 0, "555", "000", "0142");
    const run = groups.join(" ");
    const tried = { spans: 0 };
    const marks = phonesIn(run, 0, new Map([[`phone:${fold("phone", "+15550000142")}`, "p-ada"]]), tried);
    expect(tried.spans).toBeLessThanOrEqual(15 * groups.length);
    expect(marks).toHaveLength(1);
    expect(run.slice(marks[0]!.start, marks[0]!.end)).toMatch(/555 000 0142$/u);
    expect(marks[0]!.who).toBe("p-ada");
    const matcher = compileNames({ version: "names-test-1", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["+15550000142"] }] });
    const text = `Readings: ${run}.`;
    expect(matcher.marks(text).map((mark) => [text.slice(mark.end - 12, mark.end), mark.who])).toEqual([["555 000 0142", "p-ada"]]);
  });
});

describe("a text's words read by the caller", () => {
  it("marks the same as the matcher reading the text itself, and a reading of another text is read anew", () => {
    const matcher = compileNames({ version: "reading-1", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["+15550000142", "ada@example.com"] }] });
    const text = "Dear Ada, Ada Exampleton wrote from ada@example.com; call +1 555 000 0142. İstanbul trip with ADA EXAMPLE";
    const plain = matcher.marks(text);
    expect(plain.length).toBeGreaterThan(3);
    expect(matcher.marks(text, readWords(text))).toEqual(plain);
    expect(matcher.marks(text, readWords("another text"))).toEqual(plain);
  });
});

describe("a one-word name", () => {
  it("matches alone only when it holds a letter: a table naming \"2\" hides no 2 in a text", () => {
    const matcher = compileNames({ version: "names-test-2", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada 2", names: ["Ada 2", "2", "Ada"], accounts: [] }] });
    const text = "Ada 2 had 2 tickets; Ada left at 2.";
    expect(matcher.marks(text).map((mark) => text.slice(mark.start, mark.end))).toEqual(["Ada 2", "Ada"]);
  });
});

describe("an account of no letter or digit", () => {
  it("compiles, matches nothing, and leaves the person's name and phone matched", () => {
    const matcher = compileNames({ version: "names-test-signs", owner: null, people: [{ who: "p-1", is: "human", shown: "Zorvath Quillby", names: ["Zorvath Quillby"], accounts: ["@--", "+15550000001"] }] });
    const text = "call Zorvath Quillby on +1 555 000 0001 or --";
    expect(matcher.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.type])).toEqual([["+1 555 000 0001", "phone"], ["Zorvath Quillby", "person"]]);
  });
});

describe("a handle a day names a person by", () => {
  it("is the person People holds it for, by phone, email, a WhatsApp id or a network's; one two people hold, or no one, stays the handle", () => {
    const matcher = compileNames({ version: "names-test-handles", owner: { who: "p-me", shown: "Owner Example" }, people: [
      { who: "p-sam", is: "human", shown: "Sam Wren", names: ["Sam Wren"], accounts: ["+15550000013", "sam-wren@example.com", "7c1d@lid"] },
      { who: "p-ida", is: "human", shown: "Ida Wren", names: ["Ida Wren"], accounts: ["+15550000014", "telegram:ida-wren"] },
      { who: "p-bo", is: "human", shown: "Bo Wren", names: ["Bo Wren"], accounts: ["+15550000014"] },
    ] });
    const asked = ["p-sam", "p-me", "phone:+15550000013", "email:sam-wren@example.com", "jid:7c1d@lid", "telegram:ida-wren", "phone:+15550000014", "phone:+15550000099"];
    expect(asked.map((who) => matcher.personOf(who))).toEqual(["p-sam", "p-me", "p-sam", "p-sam", "p-sam", "p-ida", "phone:+15550000014", "phone:+15550000099"]);
  });
});

describe("a name the owner shares", () => {
  it("is the owner's, whoever else holds it; a name two others share stays nobody's", () => {
    const people = [
      { who: "p-friend", is: "human" as const, shown: "Ada Stranger", names: ["Ada Stranger", "Ada", "Zuri"], accounts: [] },
      { who: "p-owner", is: "human" as const, shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: [] },
      { who: "p-other", is: "human" as const, shown: "Zuri Other", names: ["Zuri Other", "Zuri"], accounts: [] },
    ];
    const text = "Hi Ada, Zuri and Ada Stranger send their love.";
    const marked = (owner: { who: string; shown: string } | null, version: string) =>
      compileNames({ version, owner, people }).marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null]);
    expect(marked({ who: "p-owner", shown: "Ada Example" }, "names-test-3")).toEqual([["Ada", "p-owner"], ["Zuri", null], ["Ada Stranger", "p-friend"]]);
    expect(compileNames({ version: "names-test-4", owner: { who: "p-owner", shown: "Ada Example" }, people: [...people].reverse() }).marks("Ada").map((mark) => mark.who)).toEqual(["p-owner"]);
    expect(marked(null, "names-test-5")[0]).toEqual(["Ada", null]);
  });
});

describe("a one-word name that is also a word", () => {
  const people = (names: string[]) => names.map((name, index) => ({ who: `p-${index}`, is: "human" as const, shown: `${name} Example`, names: [`${name} Example`, name], accounts: [] }));
  const marked = (version: string, names: string[], text: string) => compileNames({ version, owner: null, people: people(names) }).marks(text).map((mark) => text.slice(mark.start, mark.end));

  it("matches alone as a name is written: an everyday word in Title Case, a rare given name in any case but CAPITALS, a common word only under a cue", () => {
    expect(marked("names-test-6", ["Max"], "max 2 people; Max came; MAX 30")).toEqual(["Max"]);
    expect(marked("names-test-7", ["Prem"], "prem ko bula lena; Prem aaya; PREM 30")).toEqual(["prem", "Prem"]);
    expect(marked("names-test-8", ["Rose"], "a rose for you; Rose came")).toEqual([]);
    expect(marked("names-test-9", ["Zuri"], "zuri, Zuri, ZURI")).toEqual(["zuri", "Zuri", "ZURI"]);
  });

  it("in CAPITALS in a line written otherwise, as a bank's or a form's line writes a payee", () => {
    const lines = ["Rs 500 credited to a/c XX1234 by ZURI on 12-11-26", "Sent ₹500 to ZURI", "Money received from ZURI", "First Name ZURI Last Name EXAMPLETON", "| 12 Nov | ZURI | 500 |"];
    for (const [index, line] of lines.entries()) expect(marked(`names-test-9c-${index}`, ["Zuri"], line)).toContain("ZURI");
  });

  it("a word of the dictionary never after an article; written small, only in a sentence written small but its first word, joined by `_` to no plain word", () => {
    expect(marked("names-test-9d", ["Mac"], "The device with the mac address; \"mac_address\": \"x\"; Mac came\nmac ko bula lena\n[9:41 AM] Zuri: mac aaya\nBtw mac is coming")).toEqual(["Mac", "mac", "Zuri", "mac", "mac"]);
    expect(marked("names-test-9f", ["Prem"], "Kal prem aayega\nHaan, prem ko bol diya\nOk will ask prem\nAsk Prem about the prem")).toEqual(["prem", "prem", "prem", "Prem"]);
    expect(marked("names-test-9g", ["Prem"], "prem_kumar\nprem_exampleton\n@prem_k\nprem_bday.jpg\nprem_notes")).toEqual(["prem", "prem", "prem", "prem"]);
  });

  it("naming a faith or its follower: a name where People holds it alone, never after an article", () => {
    expect(marked("names-test-9e", ["Christian", "Christian Exampleton"], "a non-denominational Christian chaplain, as a Christian; Christian Exampleton came; Dear Christian,")).toEqual(["Christian Exampleton", "Christian"]);
    const alone = (version: string, text: string) => compileNames({ version, owner: null, people: [{ who: "p-c", is: "human", shown: "Christian", names: ["Christian"], accounts: [] }] }).marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null]);
    expect(alone("names-test-9h", "Christian came over. Christian's birthday. Christian Smith")).toEqual([["Christian", "p-c"], ["Christian", "p-c"], ["Christian Smith", "p-c"]]);
  });

  it("found by a cue where its own form refused it, is still its person's", () => {
    const text = "Payee: MAX";
    expect(compileNames({ version: "names-test-9i", owner: null, people: people(["Max"]) }).marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null])).toEqual([["MAX", "p-0"]]);
  });

  it("matches alone in Title Case when it is a Hinglish word that is a given name too, never as the word written small", () => {
    expect(marked("names-test-9b", ["Naya", "Bina"], "Naya aa rahi hai, kuch naya nahi; Bina bola, bina bataye")).toEqual(["Naya", "Bina"]);
  });
});

describe("a cue's name over an id", () => {
  it("is the id's: People's user name after a salutation stays an account", () => {
    const matcher = compileNames({ version: "names-test-10", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example"], accounts: ["Zorbly42x"] }] });
    const text = "Dear Zorbly42x, Dear Zuri Exampleton,";
    expect(matcher.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.type])).toEqual([["Zorbly42x", "account"], ["Zuri Exampleton", "person"]]);
  });
});

describe("a given name of the list", () => {
  const marked = (people: Parameters<typeof compileNames>[0]["people"], version: string, text: string) => compileNames({ version, owner: null, people }).marks(text).map((mark) => text.slice(mark.start, mark.end));

  it("is a name wherever it stands in Title Case when it is no word, with the family name after it; a word, a small or a CAPITAL one is not", () => {
    expect(marked([], "names-test-11", "met Zuri at the gate. Lena Exampleton paid, Lena E. left; zuri, ZURI; told Grace; Rose Exampleton came")).toEqual(["Zuri", "Lena Exampleton", "Lena E."]);
  });

  it("is no name when it names a faith, alone or after a faith's word (\"Sunni Islam\"), and is in a full name (\"Islam Mahmoud\")", () => {
    expect(marked([], "names-test-11b", "raised in the traditions of Sunni Islam, a follower of Shia Islam; Islam is a faith; met Islam Mahmoud")).toEqual(["Islam Mahmoud"]);
  });

  it("is no name where it names a place or its last words, but is with a family name after it", () => {
    expect(marked([], "names-test-12", "made in India, flew to Georgia, then Santa Clara. Georgia Exampleton paid")).toEqual(["Georgia Exampleton"]);
  });

  it("is no name where People holds it as a bot: the home's own assistant speaking in a day", () => {
    const text = "Claude: a synthetic reply. Ask Claude Code later.";
    expect(marked([], "names-test-13", text)).toEqual(["Claude", "Claude"]);
    expect(marked([{ who: "assistant:claude", is: "bot", shown: "Claude", names: ["Claude"], accounts: [] }, { who: "assistant:claude-code", is: "bot", shown: "Claude Code", names: ["Claude Code"], accounts: [] }], "names-test-14", text)).toEqual([]);
  });
});

describe("a contact named as an assistant is", () => {
  const bots = [{ who: "assistant:claude", is: "bot" as const, shown: "Claude", names: ["Claude"], accounts: [] }, { who: "assistant:claude-code", is: "bot" as const, shown: "Claude Code", names: ["Claude Code"], accounts: [] }];
  const human = { who: "p-claude", is: "human" as const, shown: "Claude Exampleton", names: ["Claude Exampleton", "Claude"], accounts: [] };
  const text = "  09:02 Claude: a synthetic reply\nMet Claude Exampleton today. Ask Claude Code later.";

  it("the person People holds, whichever the table lists first; a bot's longer name stays the bot's", () => {
    for (const [version, people] of [["names-test-15", [human, ...bots]], ["names-test-16", [...bots, human]]] as const) {
      expect(compileNames({ version, owner: null, people }).marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null])).toEqual([["Claude", "p-claude"], ["Claude Exampleton", "p-claude"]]);
    }
  });
});

describe("a name that stands as no person's", () => {
  const people = [
    { who: "p-zuri", is: "human" as const, shown: "Zuri Exampleton", names: ["Zuri Exampleton", "Zuri"], accounts: [] },
    { who: "p-role", is: "human" as const, shown: "Driver", names: ["Driver"], accounts: [] },
  ];
  const marked = (version: string, text: string) => compileNames({ version, owner: null, people }).marks(text).map((mark) => text.slice(mark.start, mark.end));

  it("is no name: an organisation's or a place's first words, a god's, a piece of a code", () => {
    expect(marked("names-test-17", "Zuri Hospital, Zuri & Associates, ZURI SECURITIES LIMITED, Zuri Town, Bank of Zuri, Lord Zuri, GPT-6-Zuri, PAY*ZURI; Lena Clinic")).toEqual([]);
  });

  it("is a name beside them otherwise: written in a sentence, a small noun after it, a full name People holds, a file's name", () => {
    expect(marked("names-test-18", "Zuri went to the hospital; Zuri Exampleton Hospital; Mary-Zuri came; Zuri_notes.pdf; met Zuri, Lena")).toEqual(["Zuri", "Zuri Exampleton", "Zuri", "Zuri", "Zuri", "Lena"]);
  });

  it("is no name where a contact is saved under a role, but under a cue or in a fuller name", () => {
    expect(marked("names-test-19", "Driver Information:\nDriver: Lena Exampleton\nthe Driver was late")).toEqual(["Lena Exampleton"]);
  });
});

describe("a name running into a place", () => {
  const people = [
    { who: "p-el", is: "human" as const, shown: "El Exampleton", names: ["El"], accounts: [] },
    { who: "p-clara", is: "human" as const, shown: "Clara", names: ["Clara"], accounts: [] },
    { who: "p-virginia", is: "human" as const, shown: "Virginia Exampleton", names: ["Virginia Exampleton", "Virginia"], accounts: [] },
    { who: "p-place", is: "human" as const, shown: "Santa Clara", names: ["Santa Clara"], accounts: [] },
  ];
  const marked = (version: string, table: typeof people, text: string) => compileNames({ version, owner: null, people: table }).marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null]);

  it("is the place's: a name People holds or the list's, alone or with the word written alike before or after it, that is a place's name of two words", () => {
    expect(marked("names-test-20", people.slice(0, 3), "We flew to El Salvador, then Santa Clara, Virginia Beach and Al Ain. VIRGINIA BEACH, SANTA CLARA.")).toEqual([]);
  });

  it("is a name beside a place otherwise: alone, before one written otherwise, or a full name People holds that is a place's words", () => {
    expect(marked("names-test-21", people.slice(0, 3), "El said Clara met Virginia in El Salvador; Virginia beach-combs; santa Clara")).toEqual([["El", "p-el"], ["Clara", "p-clara"], ["Virginia", "p-virginia"], ["Virginia", "p-virginia"], ["Clara", "p-clara"]]);
    expect(marked("names-test-22", people, "Santa Clara called")).toEqual([["Santa Clara", "p-place"]]);
  });
});

describe("a text read twice", () => {
  it("gives the same marks the second time, and a caller's change to the first reaches no later reader", () => {
    const names = compileNames({ version: "names-test-23", owner: null, people: [{ who: "p-ada", is: "human", shown: "Ada Exampleton", names: ["Ada Exampleton", "Ada"], accounts: ["+15550000142"] }] });
    const text = "Ada Exampleton called from 555 000 0142; Lena Exampleton too.";
    const first = names.marks(text);
    const copy = first.map((mark) => ({ ...mark }));
    first[0]!.end = 1;
    first.pop();
    expect(names.marks(text)).toEqual(copy);
    expect(names.marks("Ada")).toEqual([{ start: 0, end: 3, type: "person", who: "p-ada" }]);
    expect(names.marks(text)).toEqual(copy);
  });
});

describe("the seal", () => {
  const people: NameTable = { version: "seal-1", owner: { who: "p-owner", shown: "Owner Example" }, people: [
    { who: "p-owner", is: "human", shown: "Owner Example", names: ["Owner Example"], accounts: [] },
    { who: "p-ada", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: ["+15550000001", "ada@okaxis"] },
    { who: "p-rose", is: "human", shown: "Rose Example", names: ["Rose Example"], accounts: ["+15550000002"] },
  ] };

  it("under only, the in face seals a value only when it names someone outside the list: a person People holds, a phone or an address; a value nothing marks is no one's", () => {
    const seal = sealOf(people, { except: new Set(["p-rose"]) })!;
    const typed = (type: string, text: string) => seal.typed.detail(type, text);
    expect(["me", "Book club", "Zed Nobody", "Rose Example", "Owner Example", "+15550000002"].map((text) => typed(text.startsWith("+") ? "phone" : "person", text))).toEqual([false, false, false, false, false, false]);
    expect([typed("person", "Ada Example"), typed("phone", "+15550000001"), typed("phone", "+15550000777"), typed("email", "stranger@example.com")]).toEqual([true, true, true, true]);
    expect(seal.typed.marks("Book club with Rose Example and Zed Nobody")).toEqual([]);
    expect(seal.detail("person", "Zed Nobody")).toBe(true);
  });

  it("with a sealed list, the in face is the out face", () => {
    const seal = sealOf(people, { people: new Set(["p-ada"]), handles: [] })!;
    expect(seal.typed.detail).toBe(seal.detail);
    expect(["Ada", "Ada Example", "Zed Nobody", "Rose"].map((text) => seal.typed.detail("person", text))).toEqual(["Ada", "Ada Example", "Zed Nobody", "Rose"].map((text) => seal.detail("person", text)));
  });

  it("seals a sealed person's payment address", () => {
    const seal = sealOf(people, { people: new Set(["p-ada"]), handles: [] })!;
    expect([seal.detail("number.payment", "ada@okaxis"), seal.detail("number.payment", "rose@okaxis")]).toEqual([true, false]);
  });

  it("judges a who given as a handle by the person holding it: sealed under nothing with her, open under only her, and a handle no one holds alone sealed under only", () => {
    const ada = "phone:+15550000001";
    const nothingWith = sealOf(people, { people: new Set(["p-ada"]), handles: ["+15550000777"] })!;
    expect([nothingWith.person(ada), nothingWith.person("p-ada"), nothingWith.person("phone:+15550000002"), nothingWith.person("phone:+15550000777")]).toEqual([true, true, false, true]);
    expect([nothingWith.detail("person", "Qadie", ada), nothingWith.detail("person", "+15550000001", ada), nothingWith.detail("person", "Qadie", "phone:+15550000002")]).toEqual([true, true, false]);
    const onlyAda = sealOf(people, { except: new Set(["p-ada"]) })!;
    expect([onlyAda.person(ada), onlyAda.person("p-ada"), onlyAda.person("phone:+15550000002"), onlyAda.person("phone:+15550000777")]).toEqual([false, false, true, true]);
    for (const face of [onlyAda, onlyAda.typed]) expect([face.detail("person", "Qadie", ada), face.detail("phone", "+15550000001", ada), face.detail("person", "Qadie", "phone:+15550000002")]).toEqual([false, false, true]);
  });

  it("finds a handle the list holds on its word and handle edges, never inside another word or handle", () => {
    const seal = sealOf(people, { people: new Set(), handles: ["ada", "+15550000777"] })!;
    const text = "Flew to Canada with @ada, ada.smith, ada@example.com, bob.ada and ADA; rang +15550000777 and +155500007770";
    expect(seal.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.start])).toEqual([["ada", 21], ["ADA", text.indexOf("ADA")], ["+15550000777", text.indexOf("+15550000777")]]);
  });
});
