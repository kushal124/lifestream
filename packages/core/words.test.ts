import { describe, expect, it } from "vitest";
import { isAscii, isCommonWord, isEverydayWord, isFamilyWord, lowerAligned, readingOf, readWords, runsOf, textHead } from "./words.js";

describe("the word lists", () => {
  it("a family name that is a word is one, any case; a word that is none is not", () => {
    for (const word of ["king", "Price", "FLETCHER", "young"]) expect(isFamilyWord(word)).toBe(true);
    for (const word of ["complaint", "deductions", "keypad", "#", ""]) expect(isFamilyWord(word)).toBe(false);
  });

  it("an everyday word is common or a little less, a Hinglish given name among them, a rarer word not", () => {
    expect(isEverydayWord("will")).toBe(true);
    expect(isEverydayWord("diya")).toBe(true);
    expect(isCommonWord("diya")).toBe(false);
    expect(isEverydayWord("online")).toBe(false);
  });
});

describe("a text's runs and its fold", () => {
  const MIXED = "Ada's café, Ze\u0301 naïve 𝐀𝐁c 😀x \uD800y \uDC00z ٣٤ 中文 -- O'Neil 42nd \u0301lead";

  it("the runs are the pattern's matches, whatever the script, marks or surrogates", () => {
    for (const text of [MIXED, "", "plain ascii words 12 and 3", "😀", "x"]) {
      const runs = runsOf(text);
      const pairs: [number, number][] = [];
      for (let at = 0; at < runs.length; at += 2) pairs.push([runs[at]!, runs[at + 1]!]);
      expect(pairs).toEqual([...text.matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map((match) => [match.index, match.index + match[0].length]));
    }
  });

  it("a text lower-cased keeps its offsets, but where a capital I with a dot grows", () => {
    expect(lowerAligned("Ada ÉCOLE Σ")).toBe("ada école σ");
    expect(lowerAligned("İstanbul")).toBeNull();
  });

  it("a text read once (`readWords`) is its runs and its fold, handed on only to a reader of the same text", () => {
    const read = readWords(MIXED);
    expect([...read.runs]).toEqual([...runsOf(MIXED)]);
    expect(read.lower).toBe(lowerAligned(MIXED));
    expect(readingOf(MIXED, read)).toBe(read);
    expect(readingOf("İstanbul x", read)).toEqual(readWords("İstanbul x"));
    expect(readingOf("x")).toEqual(readWords("x"));
  });

  it("ASCII is read over the span asked only", () => {
    expect(isAscii("café", 0, 3)).toBe(true);
    expect(isAscii("café", 0, 4)).toBe(false);
  });
});

describe("a text cut to a length", () => {
  const PARTY = "\u{1F389}";
  const FLAG = "\u{1F1EE}\u{1F1F3}";
  const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}";

  it("ends on a character at every length around one of two units, never between its halves", () => {
    for (const text of [`ab${PARTY}cd`, `ab${FLAG}cd`, `ab${FAMILY}cd`, `${PARTY}${PARTY}${PARTY}`, `x${FLAG}${FAMILY}${PARTY}`]) {
      for (let units = 0; units <= text.length + 1; units += 1) {
        const head = textHead(text, units);
        expect([text, units, head.isWellFormed()]).toEqual([text, units, true]);
        expect(text.startsWith(head)).toBe(true);
        const [before, after] = [text.charCodeAt(units - 1), text.charCodeAt(units)];
        const split = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
        expect(head.length).toBe(Math.min(text.length, units) - (split ? 1 : 0));
      }
    }
  });

  it("an emoji at the cut is left out whole, the boundary one either side keeps or cuts it whole", () => {
    const text = `${"a".repeat(78)}${PARTY}b`;
    expect(textHead(text, 78)).toBe("a".repeat(78));
    expect(textHead(text, 79)).toBe("a".repeat(78));
    expect(textHead(text, 80)).toBe(`${"a".repeat(78)}${PARTY}`);
    expect(textHead(`a${FLAG}`, 3)).toBe("a\u{1F1EE}");
    expect(textHead(`a${FLAG}`, 4)).toBe("a\u{1F1EE}");
    expect(textHead(FAMILY, 3)).toBe("\u{1F468}\u200D");
    expect(textHead(FAMILY, 4)).toBe("\u{1F468}\u200D");
  });

  it("ASCII is cut as `slice` cuts it, a text no longer than asked is itself, and a half alone already there is kept", () => {
    expect(textHead("plain words", 5)).toBe("plain");
    expect(textHead("plain", 5)).toBe("plain");
    expect(textHead("plain", 0)).toBe("");
    expect(textHead("ab\uD83Ccd", 4)).toBe("ab\uD83Cc");
  });
});
