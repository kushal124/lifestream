import { describe, expect, it } from "vitest";
import {
  cutAt, editDistance, FILLER, markedIn, matchesRaw, matchTermsOf, plainOf, readQuery, RECORD_SPELLING, RECORD_WORDS, SCREEN_SPELLING, SCREEN_WORDS, skeletonOf, snippetAt, spansOf, spellingsOf, termsOf, wordsOfTerms,
  type SpellingRule, type Vocabulary,
} from "./search-words.js";


const HELD: Record<string, number> = {
  example: 40, examples: 6, exam: 3, sample: 12, notebook: 30, notebooks: 2, notable: 5, ice: 9, cream: 7, history: 25,
  histories: 1, lighthouse: 4, light: 30, house: 50, harbour: 8, harbor: 3, travel: 20, gravel: 2, unravel: 1, bicycle: 6,
  cycle: 9, flight: 15, refund: 4, rocket: 2, rockets: 1,
};

function mapVocabulary(held: Record<string, number>): Vocabulary {
  const count = (form: string, prefix: boolean) => {
    const words = form.split(" ");
    if (words.length > 1) return Math.min(...words.map((word) => held[word] ?? 0));
    return prefix ? Object.entries(held).filter(([word]) => word.startsWith(form)).reduce((sum, [, n]) => sum + n, 0) : held[form] ?? 0;
  };
  return {
    held: (form, most, prefix = false) => Math.min(most, count(form, prefix)),
    has: (word) => (held[word] ?? 0) > 0,
    ofSkeleton: (skeleton, most) => Object.keys(held).filter((word) => skeletonOf(word) === skeleton).slice(0, most),
    starting: (first, most) => Object.keys(held).filter((word) => word.startsWith(first)).slice(0, most),
    left: () => Infinity,
  };
}

function meteredVocabulary(held: Record<string, number>, budget: number): Vocabulary & { spent: () => number } {
  const sorted = Object.keys(held).sort();
  const skeletons = new Map<string, string[]>();
  for (const word of sorted) skeletons.set(skeletonOf(word), [...(skeletons.get(skeletonOf(word)) ?? []), word]);
  let spent = 0;
  const walk = <T>(rows: readonly T[], most: number): T[] => {
    spent += Math.min(rows.length, Math.max(0, most) + 1);
    return rows.slice(0, Math.max(0, most));
  };
  const entries = (n: number) => Array.from({ length: n }, (_, at) => at);
  return {
    held: (form, most, prefix = false) => {
      const words = form.split(" ");
      const n = words.length > 1 ? Math.min(...words.map((word) => held[word] ?? 0))
        : prefix ? sorted.filter((word) => word.startsWith(form)).reduce((sum, word) => sum + held[word]!, 0) : held[form] ?? 0;
      return walk(entries(n), most).length;
    },
    has: (word) => {
      spent += 1;
      return Object.hasOwn(held, word);
    },
    ofSkeleton: (skeleton, most) => walk(skeletons.get(skeleton) ?? [], most),
    starting: (first, most) => walk(sorted.filter((word) => word >= first && word < String.fromCodePoint(first.codePointAt(0)! + 1)), most),
    left: () => budget - spent,
    spent: () => spent,
  };
}

const terms = (typed: string) => termsOf(typed).map(({ text, quoted, negated, or }) => ({ text, quoted, negated, or }));

describe("the query language", () => {
  it("W1 reads each form: words, a phrase, an exclusion, either", () => {
    expect(terms("flight refund")).toEqual([
      { text: "flight", quoted: false, negated: false, or: false },
      { text: "refund", quoted: false, negated: false, or: false },
    ]);
    expect(terms('"window seat" trip')).toEqual([
      { text: "window seat", quoted: true, negated: false, or: false },
      { text: "trip", quoted: false, negated: false, or: false },
    ]);
    expect(terms('trip -cancelled -"red eye"')).toEqual([
      { text: "trip", quoted: false, negated: false, or: false },
      { text: "cancelled", quoted: false, negated: true, or: false },
      { text: "red eye", quoted: true, negated: true, or: false },
    ]);
    expect(terms("refund OR credit")).toEqual([
      { text: "refund", quoted: false, negated: false, or: false },
      { text: "credit", quoted: false, negated: false, or: true },
    ]);
    expect(terms("OR refund")).toEqual([{ text: "refund", quoted: false, negated: false, or: false }]);
    expect(terms("refund -- ... credit")).toEqual([
      { text: "refund", quoted: false, negated: false, or: false },
      { text: "credit", quoted: false, negated: false, or: false },
    ]);
    expect(terms('"window seat')).toEqual([{ text: "window seat", quoted: true, negated: false, or: false }]);
    expect(wordsOfTerms(termsOf('refund OR credit "window seat" -cancelled'))!.match).toBe('(("refund" OR "credit") AND "window seat") NOT ("cancelled")');
    expect(wordsOfTerms(termsOf("-cancelled"))).toBeNull();
    expect(wordsOfTerms(termsOf('say "hi""'))!.match).toBe('"say" AND "hi"');
  });

  it("W4 reads a last word as a prefix only in a box, from three characters, never a quoted, excluded or joined spelling", () => {
    expect(wordsOfTerms(termsOf("cof"))!.match).toBe('"cof"');
    expect(wordsOfTerms(termsOf("cof"), true)!.match).toBe('"cof"*');
    expect(wordsOfTerms(termsOf("co"), true)!.match).toBe('"co"');
    expect(wordsOfTerms(termsOf('"cof"'), true)!.match).toBe('"cof"');
    expect(wordsOfTerms(termsOf("coffee -tea"), true)!.match).toBe('("coffee"*) NOT ("tea")');
    expect(wordsOfTerms([...termsOf("cof"), { text: "coffee", quoted: true, negated: false, or: true, at: 0, variant: true }], true)!.match).toBe('("cof"* OR "coffee")');
    expect(wordsOfTerms(termsOf("flight cof"), true)!.marks).toEqual([{ word: "flight", prefix: false }, { word: "cof", prefix: true }]);
    expect(wordsOfTerms(termsOf("flight cof"))!.marks).toEqual([{ word: "flight", prefix: false }, { word: "cof", prefix: false }]);
    expect(wordsOfTerms(termsOf("flight cof"))!.terms!.required.flat().map((term) => term.prefix)).toEqual([false, false]);
    expect(readQuery("cof", RECORD_WORDS, true).typing).toBe(true);
    expect(readQuery("cof", RECORD_WORDS).typing).toBe(false);
  });
});

describe("the word handling", () => {
  it("W2 leaves filler out of a query of three plain words or more, and says so", () => {
    const read = readQuery("what did I pay for the flight", RECORD_WORDS);
    expect(read.terms.map((term) => term.text)).toEqual(["pay", "flight"]);
    expect(read.without).toEqual(["what", "did", "i", "for", "the"]);
    expect(readQuery("the flight", RECORD_WORDS).without).toEqual([]);
    expect(readQuery('"the who" -the flight', RECORD_WORDS).terms.map((term) => term.text)).toEqual(["the who", "the", "flight"]);
    expect(readQuery('"the who" the flight', RECORD_WORDS).terms.map((term) => term.text)).toEqual(["the who", "the", "flight"]);
    expect(readQuery('"the who" the flight trip', RECORD_WORDS).terms.map((term) => term.text)).toEqual(["the who", "flight", "trip"]);
    expect(readQuery("this OR that flight trip", RECORD_WORDS).terms.map((term) => term.text)).toEqual(["this", "that", "flight", "trip"]);
    expect(readQuery("what was that", RECORD_WORDS)).toMatchObject({ without: [] });
    expect(readQuery("what was that", RECORD_WORDS).terms).toHaveLength(3);
    expect(readQuery("trip to the", RECORD_WORDS, true).terms.map((term) => term.text)).toEqual(["trip", "the"]);
    expect(readQuery("what did I pay", { ...RECORD_WORDS, filler: false }).without).toEqual([]);
    expect([...FILLER]).toContain("remember");
  });

  it("W3 reads an alias on its index's side alone, and never the only word wanted", () => {
    expect(readQuery("tweet about rockets", SCREEN_WORDS)).toMatchObject({ without: ["about"], as: { tweet: ["x.com", "twitter.com"] } });
    expect(readQuery("tweet about rockets", SCREEN_WORDS).terms.map((term) => term.text)).toEqual(["rockets"]);
    expect(readQuery("tweet rockets", SCREEN_WORDS).terms.map((term) => term.text)).toEqual(["rockets"]);
    expect(readQuery("tweet", SCREEN_WORDS)).toMatchObject({ as: {} });
    expect(readQuery("tweet", SCREEN_WORDS).terms.map((term) => term.text)).toEqual(["tweet"]);
    expect(readQuery('"tweet" rockets', SCREEN_WORDS).as).toEqual({});
    expect(readQuery("tweet rockets", RECORD_WORDS)).toMatchObject({ as: {} });
    expect(readQuery("tweet rockets", RECORD_WORDS).terms.map((term) => term.text)).toEqual(["tweet", "rockets"]);
  });

  it("W8 marks a term where it stands, folded as the index folds it", () => {
    const text = "Café LIGHT house, then the Lighthouse";
    expect(spansOf(text, { words: ["cafe"], prefix: false })).toEqual([{ start: 0, end: 4 }]);
    expect(spansOf(text, { words: ["light", "house"], prefix: false })).toEqual([{ start: 5, end: 16 }]);
    expect(spansOf(text, { words: ["light"], prefix: true }).map((span) => text.slice(span.start, span.end))).toEqual(["LIGHT", "Lighthouse"]);
    expect(markedIn(text, [{ word: "lighthouse", prefix: false }, { word: "cafe", prefix: false }]).map((span) => text.slice(span.start, span.end))).toEqual(["Café", "Lighthouse"]);
  });
});

describe("the near spellings", () => {
  const EVERY_KIND: SpellingRule = { rare: 10, skeleton: true, edits: true, distance: true, splits: true, counted: 1_000 };
  const RULES: [string, SpellingRule][] = [["every kind", EVERY_KIND], ["record", RECORD_SPELLING], ["screen", SCREEN_SPELLING]];
  const WORDS = ["exampel", "notebuck", "icecream", "histroy", "lighthose", "harbur", "travle", "bicylce", "flihgt", "refnud", "zzzzzz"];

  it("W5 gives a word the same candidates over two vocabularies that hold the same words, by every rule", () => {
    for (const [name, rule] of RULES) {
      for (const word of WORDS) {
        const plain = spellingsOf(word, mapVocabulary(HELD), rule);
        const metered = spellingsOf(word, meteredVocabulary(HELD, 100_000), rule);
        expect(metered, `${name} ${word}`).toEqual(plain);
      }
    }
  });

  it("W5 the one generator finds each kind, the most held first", () => {
    const vocabulary = mapVocabulary(HELD);
    expect(spellingsOf("exampel", vocabulary, EVERY_KIND)).toEqual(["example"]);
    expect(skeletonOf("notebuck")).not.toBe(skeletonOf("notebook"));
    expect(spellingsOf("notebuck", vocabulary, EVERY_KIND)).toEqual(["notebook"]);
    expect(skeletonOf("icecream")).toBe(skeletonOf("cream"));
    expect(spellingsOf("icecream", vocabulary, EVERY_KIND)).toEqual(["cream", "ice cream"]);
    expect(spellingsOf("harbur", vocabulary, EVERY_KIND)).toEqual(["harbour", "harbor"]);
    expect(spellingsOf("history", vocabulary, EVERY_KIND)).toEqual([]);
    expect(spellingsOf("hst", vocabulary, EVERY_KIND)).toEqual([]);
    expect(spellingsOf("rocke", mapVocabulary({ ...HELD, rocker: 1 }), EVERY_KIND, { prefix: true })).toEqual([]);
  });

  it("W6 each index's measured half stays its own", () => {
    const vocabulary = mapVocabulary(HELD);
    expect(spellingsOf("histroy", vocabulary, RECORD_SPELLING)).toEqual(["history"]);
    expect(spellingsOf("notebuck", vocabulary, RECORD_SPELLING)).toEqual([]);
    expect(spellingsOf("icecream", vocabulary, RECORD_SPELLING)).toEqual(["cream"]);
    expect(spellingsOf("harbor", vocabulary, RECORD_SPELLING)).toEqual(["harbour"]);
    expect(spellingsOf("notebuck", vocabulary, SCREEN_SPELLING)).toEqual(["notebook"]);
    expect(spellingsOf("icecream", vocabulary, SCREEN_SPELLING)).toEqual(["ice cream"]);
    expect(spellingsOf("harbor", vocabulary, SCREEN_SPELLING)).toEqual([]);
    expect(spellingsOf("travle", vocabulary, SCREEN_SPELLING)).toEqual(["travel"]);
    expect(editDistance("fravel", "travel", 2)).toBe(1);
    expect(spellingsOf("fravel", mapVocabulary({ travel: 3 }), SCREEN_SPELLING)).toEqual([]);
    expect(spellingsOf("fravel", mapVocabulary({ travel: 3 }), EVERY_KIND)).toEqual(["travel"]);
    expect(RECORD_WORDS.spelling).toBe(RECORD_SPELLING);
    expect(SCREEN_WORDS.spelling).toBe(SCREEN_SPELLING);
  });

  it("W7 a vocabulary out of rows gives none, and one with rows never spends past them, its walks' look past counted", () => {
    expect(spellingsOf("histroy", meteredVocabulary(HELD, 10), RECORD_SPELLING)).toEqual([]);
    const tight = meteredVocabulary(HELD, 11);
    expect(spellingsOf("histroy", tight, RECORD_SPELLING)).toEqual(["history"]);
    expect(tight.spent()).toBeLessThanOrEqual(11);
    for (const [name, rule] of RULES) {
      for (let budget = 0; budget <= 300; budget++) {
        for (const word of WORDS) {
          const each = meteredVocabulary(HELD, budget);
          spellingsOf(word, each, rule);
          expect(each.spent(), `${name} ${word} budget ${budget}`).toBeLessThanOrEqual(budget);
        }
      }
    }
  });
});

describe("the person's snippet", () => {
  it("H9 is plain text: Markdown's marks and a tag's words, white space as one space", () => {
    expect(plainOf("**bold** and *it* `code` _under_ snake_case")).toBe("bold and it code under snake_case");
    expect(plainOf('look <AsyncImage query="harbor lights" alt=\'night\'/> here')).toBe("look harbor lights night here");
    expect(plainOf("# Plan\n> quoted\n- one\n2. two [the link](https://example.com/x)")).toBe("Plan quoted one two the link");
  });

  it("H9 starts at most 24 characters before its match, at a word's start, and runs to 140", () => {
    const text = `${"filler words before ".repeat(10)}the harbor at dusk ${"and more words after ".repeat(10)}`;
    const cut = cutAt(text, markedIn(text, [{ word: "harbor", prefix: false }]));
    expect(cut.startsWith("…")).toBe(true);
    expect(cut.indexOf("«harbor»")).toBeLessThanOrEqual(1 + 24);
    expect(cut.replace(/[«»…]/gu, "").length).toBeLessThanOrEqual(140);
    expect(cut.endsWith("…")).toBe(true);
    expect(cutAt("short harbor", markedIn("short harbor", [{ word: "harbor", prefix: false }]))).toBe("short «harbor»");
  });

  it("H9 a model's passage is cut as today: its marks and offsets stand", () => {
    const text = "**Person A** booked the harbor tour";
    const at = text.indexOf("harbor");
    expect(snippetAt(text, [{ start: at, end: at + 6 }])).toBe("**Person A** booked the «harbor» tour");
  });
});

describe("a value matched whole", () => {
  it("H15 `=Home` matches Home and never Home Again", () => {
    const [term] = matchTermsOf("=Home");
    expect(matchTermsOf("=Home")).toHaveLength(1);
    expect([matchesRaw("Home", term!), matchesRaw("home", term!), matchesRaw("Home Again", term!)]).toEqual([true, true, false]);
    expect(matchesRaw("Home Again", matchTermsOf("Home")[0]!)).toBe(true);
  });

  it("H15 `=-A OR B` is one whole value, neither negated nor two", () => {
    const terms = matchTermsOf("=-A OR B");
    expect(terms.map(({ text, negated, whole }) => ({ text, negated, whole }))).toEqual([{ text: "-A OR B", negated: false, whole: true }]);
    expect([matchesRaw("-A OR B", terms[0]!), matchesRaw("A", terms[0]!), matchesRaw("B", terms[0]!)]).toEqual([true, false, false]);
  });
});
