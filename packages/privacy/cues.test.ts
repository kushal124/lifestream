import { describe, expect, it } from "vitest";
import { cuedNames, plainish, tokensOf, type CueTable } from "./cues.js";
import { compileNames } from "./names.js";

const PLAIN = new Set(["team", "customer", "note", "service", "front", "office", "support", "access", "control", "your", "the", "statement", "record", "verify", "movie", "book", "rose", "grace", "smith", "start", "date", "completed", "none", "will", "max", "stat", "help", "us", "name", "bank", "is", "agent", "yes", "thank", "you"]);
const TABLE: CueTable = { plain: (word) => PLAIN.has(word.toLowerCase()), named: (word) => word.toLowerCase() === "rose", family: (word) => word.toLowerCase() === "smith" };
const cued = (text: string) => cuedNames(text, TABLE).map((each) => `${each.cue} ${text.slice(each.start, each.end)}`);

describe("a name found by its cue", () => {
  it("after an honorific, the honorific left: Dr. Exampleton, Shri A. Testwala, Mr Smith", () => {
    expect(cued("Seen by Dr. Exampleton today; Shri A. Testwala and Mr Smith signed.")).toEqual(["honorific Exampleton", "honorific A. Testwala", "honorific Smith"]);
  });

  it("before a word of address: a family name no plain word, or one People holds", () => {
    expect(cued("Testwala ji ne bola, Smith uncle bhi aaye")).toEqual(["address Testwala", "address Smith"]);
    expect(cued("Yes Sir, Thank you Sir")).toEqual([]);
  });

  it("after a salutation, its first word no plain word or a name People holds: not Hi Team, not Dear Customer", () => {
    expect(cued("Dear Zuri Exampleton,\nHi Rose, Hi Team, Dear Customer")).toEqual(["salutation Zuri Exampleton", "salutation Rose"]);
  });

  it("after a label: on its line, alone on the next, after a cell's bar, or a role written small in a sentence, a comma after it or not", () => {
    expect(cued("Passenger: ZURI EXAMPLETON\nFirst Name: Zuri\n**Account Holder Name:** Ada Testwala\nPaid to\nADA TESTWALA\n| Last Name | Exampleton |\nmy landlord Zuri is asking\nthe defendant, Zuri Exampleton, denied it")).toEqual([
      "label ZURI EXAMPLETON", "label Zuri", "label Ada Testwala", "label ADA TESTWALA", "label Exampleton", "label-weak Zuri", "label-weak Zuri Exampleton",
    ]);
  });

  it("is no label's value when the label is no person's, the value goes on in a sentence, or a cell is a header or a status", () => {
    expect(cued("Company Name: Exampleworks\nContact: Customer Support team\n| Start Date | Completed |\nCustomer Service\nContact Us\nAgent Stats: 0")).toEqual([]);
  });

  it("as a chat's speaker after the line's time, or indented with no time, never You or a form's key", () => {
    expect(cued("[12/03/26, 9:41 AM] Rose: aaja\n9:42 PM Zuri Exampleton: ok\n[12/03/26, 9:43 AM] You: done\n  Zuri: hi\nAttachments: none\nNote: call back")).toEqual([
      "speaker Rose", "speaker Zuri Exampleton", "speaker-untimed Zuri",
    ]);
  });

  it("as a display name before an address, or in brackets after a payment address, or in a statement's UPI line, never a brand's", () => {
    expect(cued("From: Zuri Exampleton <zuri@example.com>\nFrom: Exampleworks <noreply@exampleworks.com>\nFrom: Zorbly <alerts@example.org>\nfrom zuri.e@okexample (ZURI EXAMPLETON) on 1 Nov\n12-10-2026  UPI/ADA TESTWALA/123456789012")).toEqual([
      "display Zuri Exampleton", "display ZURI EXAMPLETON", "display ADA TESTWALA",
    ]);
  });

  it("as a signature after a sign-off, wholly a name and no desk; and in a declaration", () => {
    expect(cued("Warm regards,\nZuri Exampleton\n\nWarm regards,\nFront Office\n\nI, Ada Testwala, agree.")).toEqual(["signature Zuri Exampleton", "declaration Ada Testwala"]);
  });

  it("in brackets after a payment address found from its `@`: each address of a run, none with no name before its `@`, and the pattern's own matches", () => {
    const text = "paid zuri@ok@example (ZURI EXAMPLETON) and @okexample (ADA TESTWALA), x+y.z*1@ok-bank.in   (Ada Testwala)\nzuri@okexample(Zuri Exampleton)";
    expect(cued(text)).toEqual(["display ZURI EXAMPLETON", "display Ada Testwala", "display Zuri Exampleton"]);
    const after = [...text.matchAll(/(?<![\w.*+-])[\w.*+-]+@[\w.-]+[ \t]*\(/gu)].map((match) => match.index + match[0].length);
    expect(after).toHaveLength(3);
    expect(cued(text).map((each) => text.indexOf(each.slice("display ".length)))).toEqual(after);
  });

  it("as a signature on the line after a wholly sign-off line only: at the text's start, after a blank line, never a sign-off inside a line or one with a carriage return", () => {
    expect(cued("Thanks & regards,\n\n  Zuri Exampleton\nsaid thanks,\nAda Testwala\nCheers\r\nAda Testwala\nBest\nAda Testwala")).toEqual(["signature Zuri Exampleton", "signature Ada Testwala"]);
  });

  it("stops at a screen's next column and a possessive, and takes no word joined to small words", () => {
    expect(cued("Name: Zuri Exampleton  Fwd\nDear Zuri's team\nDear Mother-in-law,\nName: Zuri Example-Smith")).toEqual(["salutation Zuri", "label Zuri Exampleton", "label Zuri Example-Smith"]);
  });
});

describe("the words as the cues read them", () => {
  it("each word is letters and marks joined by an apostrophe or a hyphen, read past emoji, digits and lone surrogates", () => {
    const text = "D'Example-Smith's 𝐀𝐁c 😀Ada é\u0301 -x x- '' a'-b ’s Ada’s 🎉\uD800 \uDC00x \u0301abc O'' Ma- R2D2 J. K";
    expect(tokensOf(text).map((token) => [token.start, token.word, token.kind])).toEqual([
      [0, "D'Example-Smith", "title"], [18, "𝐀𝐁c", "title"], [26, "Ada", "title"], [30, "é\u0301", "other"], [34, "x", "other"],
      [36, "x", "other"], [42, "a", "other"], [45, "b", "other"], [48, "s", "other"], [50, "Ada", "title"], [61, "x", "other"],
      [63, "\u0301abc", "other"], [68, "O", "initial"], [72, "Ma", "title"], [76, "R", "initial"], [78, "D", "initial"], [81, "J", "initial"], [84, "K", "initial"],
    ]);
  });
});

describe("a plain word", () => {
  it("is plain inflected too: the list holds no plurals or past tenses", () => {
    const plain = (word: string) => PLAIN.has(word);
    expect(["statements", "records", "verified", "movies", "booking", "Exampleton"].map((word) => plainish(word, plain))).toEqual([true, true, true, true, true, false]);
  });
});

describe("the name table's names, with the cues", () => {
  const people = [
    { who: "p-ada", is: "human" as const, shown: "Ada Smith", names: ["Ada Smith", "Ada"], accounts: [] },
    { who: "p-rose", is: "human" as const, shown: "Rose Testwala", names: ["Rose Testwala", "Rose", "P", "Dr"], accounts: [] },
  ];
  const matcher = compileNames({ version: "cues-test-1", owner: null, people });
  const marked = (text: string) => matcher.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null, mark.shown ?? null]);

  it("goes on from a known given name over the words after it that are no plain words, written alike; keeps its who only where People knows no other family name", () => {
    expect(marked("Ada Exampleton came; ADA EXAMPLETON paid; Ada E. left; Ada S. left; Ada Smith stayed; Ada Will Call Today\n1. ADA SMITH M 46 CNF")).toEqual([
      ["Ada Exampleton", null, null], ["ADA EXAMPLETON", null, null], ["Ada E.", null, null], ["Ada S.", "p-ada", null], ["Ada Smith", "p-ada", "Ada Smith"], ["Ada", "p-ada", null], ["ADA SMITH", "p-ada", "Ada Smith"],
    ]);
    const one = compileNames({ version: "cues-test-1b", owner: null, people: [{ who: "p-noor", is: "human", shown: "Noor", names: ["Noor"], accounts: [] }] });
    const text = "Noor Exampleton came; Noor E. left";
    expect(one.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null])).toEqual([["Noor Exampleton", "p-noor"], ["Noor E.", "p-noor"]]);
  });

  it("goes on over a plain word in Title Case where the sentence around it is written small, never in a heading's run of capitals", () => {
    expect(marked("we welcome Ada Salmon to the team. Ada Cooper, the lead, agreed\nNotes For Ada Salmon Fishing Trip")).toEqual([
      ["Ada Salmon", null, null], ["Ada Cooper", null, null], ["Ada", "p-ada", null],
    ]);
  });

  it("goes on over a family name however common a word it is: Brown, King, White, Young", () => {
    expect(marked("we welcome Ada Brown to the team; Ada King joined. Ada White, Ada Young and Ada Green agreed")).toEqual([
      ["Ada Brown", null, null], ["Ada King", null, null], ["Ada White", null, null], ["Ada Young", null, null], ["Ada Green", null, null],
    ]);
  });

  it("never goes on over a verb that starts the predicate after a known name, a family name or not: Will, May, Can, Did, Thanks", () => {
    expect(marked("Ada Will call you tomorrow. Ada May come too; Ada Can help\nAda Thanks for this. Ada Did say so; Ada Should know")).toEqual([
      ["Ada", "p-ada", null], ["Ada", "p-ada", null], ["Ada", "p-ada", null], ["Ada", "p-ada", null], ["Ada", "p-ada", null], ["Ada", "p-ada", null],
    ]);
    const one = compileNames({ version: "cues-test-1c", owner: null, people: [{ who: "p-noor", is: "human", shown: "Noor", names: ["Noor"], accounts: [] }] });
    const text = "Noor Will call you; we welcome Noor Salmon to the team";
    expect(one.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null])).toEqual([["Noor", "p-noor"], ["Noor Salmon", "p-noor"]]);
  });

  it("stops where another person's own name starts, goes on over a name several share, and keeps the owner the owner only in their own fuller name", () => {
    const table = compileNames({
      version: "cues-test-2", owner: { who: "p-owner", shown: "Ada Example" }, people: [
        { who: "p-owner", is: "human", shown: "Ada Example", names: ["Ada Example", "Ada"], accounts: [] },
        { who: "p-zuri", is: "human", shown: "Zuri Testwala", names: ["Zuri Testwala", "Zuri"], accounts: [] },
        { who: "p-noor", is: "human", shown: "Noor Testwala", names: ["Noor Testwala", "Noor"], accounts: [] },
        { who: "p-noor2", is: "human", shown: "Noor Otherwala", names: ["Noor Otherwala", "Noor"], accounts: [] },
      ],
    });
    const text = "Ada Zuri came. Zuri Noor Exampleton paid. Ada Example Zorbly. Ada Zorbly.";
    expect(table.marks(text).map((mark) => [text.slice(mark.start, mark.end), mark.who ?? null, mark.shown ?? null])).toEqual([
      ["Ada", "p-owner", null], ["Zuri", "p-zuri", null], ["Zuri Noor Exampleton", null, null], ["Ada Example Zorbly", "p-owner", null], ["Ada Zorbly", null, null],
    ]);
  });

  it("finds no person in a cue's name People holds as a bot or a business", () => {
    const table = compileNames({
      version: "cues-test-3", owner: null, people: [
        { who: "p-bot", is: "bot", shown: "Zorbot", names: ["Zorbot"], accounts: [] },
        { who: "p-shop", is: "business", shown: "Zorbly Stores", names: ["Zorbly Stores", "Zorbly"], accounts: [] },
      ],
    });
    const text = "  09:02 Zorbot: a synthetic reply\n  09:03 Zuri Exampleton: thanks\n  Zorbly: 3 new";
    expect(table.marks(text).map((mark) => text.slice(mark.start, mark.end))).toEqual(["Zuri Exampleton"]);
  });

  it("takes a given name of the list where a cue asks for a name's word, though it is a rarer word, never a month", () => {
    const text = "Dear Maria,\nHi August,\nDear Customer,";
    expect(marked(text)).toEqual([["Maria", null, null]]);
  });

  it("gives a cue's name that is a plain-word name People holds its who: Rose the speaker, not the rose in a sentence", () => {
    expect(marked("[12/03/26, 9:41 AM] Rose: a rose for you")).toEqual([["Rose", "p-rose", null]]);
  });

  it("leaves a one-word name inside a host to the host", () => {
    expect(marked("see www.ada.example, mail ada.smith@example.com, and Ada")).toEqual([["ada", "p-ada", null], ["Ada", "p-ada", null]]);
  });

  it("never matches a one-letter name or an honorific alone", () => {
    expect(marked("Plan A, then P, then Dr Exampleton")).toEqual([["Exampleton", null, null]]);
  });
});
