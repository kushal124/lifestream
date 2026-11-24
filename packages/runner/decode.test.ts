import { describe, expect, it } from "vitest";
import { DECODE, KINDS, marksOf, readsLabels, Unspelled, type Token } from "./decode.js";
import { END_OF_TEXT, tokenizerOf } from "./test/synthetic-tokenizer.js";

const tokenizer = tokenizerOf([" Ada", " Example", " Rose"]);

function tokensOf(passage: string): { tokens: Token[]; texts: string[] } {
  const { ids, tokens } = tokenizer.encode(passage, { add_special_tokens: false });
  return { tokens: tokens.map((text: string, index: number) => ({ text, added: ids[index] === END_OF_TEXT })), texts: tokens };
}

const LABELS = ["O", ...Object.keys(KINDS).flatMap((kind) => ["B", "I", "E", "S"].map((tag) => `${tag}-${kind}`))];

function scored(count: number, rows: Readonly<Record<number, Readonly<Record<string, number>>>>): Float32Array {
  const scores = new Float32Array(count * LABELS.length).fill(-20);
  for (let token = 0; token < count; token++) {
    for (const [label, score] of Object.entries(rows[token] ?? { O: 0 })) {
      expect(LABELS).toContain(label);
      scores[token * LABELS.length + LABELS.indexOf(label)] = score;
    }
  }
  return scores;
}

const labelled = (count: number, at: Readonly<Record<number, string>>): Float32Array => scored(count, Object.fromEntries(Object.entries(at).map(([index, label]) => [index, { [label]: 0 }])));

const marked = (passage: string, marks: { start: number; end: number; type: string }[]) => marks.map((mark) => [passage.slice(mark.start, mark.end), mark.type]);

describe("the detector's decoding", () => {
  it("places each mark on its detail's characters: the space a token carries left out, a character of several bytes, of two UTF-16 units, or after an added token", () => {
    const passage = "Hi Ada Example, नमस्ते Rose <|endoftext|> 😀 Ada";
    const { tokens, texts } = tokensOf(passage);
    const ada = texts.indexOf("ĠAda");
    const rose = texts.indexOf("ĠRose");
    const last = texts.lastIndexOf("ĠAda");
    expect(tokens[texts.indexOf("<|endoftext|>")]!.added).toBe(true);
    const marks = marksOf(passage, tokens, LABELS, labelled(tokens.length, { [ada]: "B-private_person", [ada + 1]: "E-private_person", [rose]: "S-private_person", [last]: "S-private_person" }));
    expect(marked(passage, marks)).toEqual([["Ada Example", "person"], ["Rose", "person"], ["Ada", "person"]]);
    expect(marks.at(-1)).toEqual({ start: passage.length - 3, end: passage.length, type: "person" });
  });

  it("widens a span a token cut inside a character to the whole character, and then to its word", () => {
    const passage = "Call नमस्ते now";
    const { tokens } = tokensOf(passage);
    const marks = marksOf(passage, tokens, LABELS, labelled(tokens.length, { 6: "B-private_address", 7: "I-private_address", 8: "E-private_address" }));
    expect(marked(passage, marks)).toEqual([["नमस्ते", "address"]]);
  });

  it("joins tokens as the reference decoder does, each kind its type, and drops a date and a span under two characters", () => {
    const passage = "!#$%&()*+,-./:;<";
    const { tokens } = tokensOf(passage);
    expect(tokens).toHaveLength(16);
    const marks = marksOf(passage, tokens, LABELS, labelled(16, {
      0: "I-private_email", 1: "E-private_email",
      2: "I-account_number", 3: "I-account_number", 4: "I-secret", 5: "E-secret",
      6: "B-private_url", 7: "I-private_url", 8: "B-private_url", 9: "E-private_url",
      10: "B-private_date", 11: "E-private_date", 12: "S-private_phone",
      13: "B-private_phone", 14: "S-private_address", 15: "S-private_address",
    }));
    expect(marked(passage, marks)).toEqual([["!#", "email"], ["$%", "number"], ["&(", "secret"], [")*", "link"], ["+,", "link"]]);
    expect(Object.entries(KINDS)).toEqual([
      ["private_person", "person"], ["private_email", "email"], ["private_phone", "phone"], ["private_address", "address"], ["private_url", "link"],
      ["account_number", "number"], ["secret", "secret"], ["private_date", null],
    ]);
  });

  it("widens a mark that ends inside a word to the whole word, keeps two it widens over one word two, and keeps the edges of one in a script without spaces", () => {
    const account = "Pay 9663 now";
    const cut = marksOf(account, tokensOf(account).tokens, LABELS, labelled(account.length, { 4: "B-account_number", 5: "I-account_number", 6: "E-account_number" }));
    expect(marked(account, cut)).toEqual([["9663", "number"]]);
    const handle = "to od_customercare@example.com";
    const inside = marksOf(handle, tokensOf(handle).tokens, LABELS, labelled(handle.length, { 9: "B-private_email", 10: "E-private_email" }));
    expect(marked(handle, inside)).toEqual([["customercare", "email"]]);
    const caps = "VPA (PRAJAPITA BRAHMA) on";
    const shredded = marksOf(caps, tokensOf(caps).tokens, LABELS, labelled(caps.length, {
      5: "B-account_number", 6: "I-account_number", 7: "I-account_number", 8: "I-account_number", 9: "I-account_number", 10: "E-account_number",
      11: "B-private_email", 12: "I-private_email", 13: "E-private_email", 15: "B-private_person", 16: "E-private_person",
    }));
    expect(marked(caps, shredded)).toEqual([["PRAJAPITA", "number"], ["PRAJAPITA", "email"], ["BRAHMA", "person"]]);
    const city = "東京タワー";
    const unspaced = marksOf(city, tokensOf(city).tokens, LABELS, labelled(Buffer.byteLength(city), { 0: "B-private_address", 1: "I-private_address", 2: "I-private_address", 3: "I-private_address", 4: "I-private_address", 5: "E-private_address" }));
    expect(marked(city, unspaced)).toEqual([["東京", "address"]]);
  });

  it("refuses tokens that do not spell the passage, and scores for another count of tokens", () => {
    const { tokens } = tokensOf("Hi Ada");
    expect(() => marksOf("Hi Ada!", tokens, LABELS, labelled(tokens.length, {}))).toThrow(Unspelled);
    expect(() => marksOf("Hi Ada", [...tokens, { text: "x", added: false }], LABELS, labelled(tokens.length, {}))).toThrow(Unspelled);
    expect(() => marksOf("Hi Ada", tokens, LABELS, labelled(tokens.length - 1, {}))).toThrow(Unspelled);
    const good = labelled(tokens.length, {});
    expect(() => marksOf("Hi Ada", tokens, LABELS, good)).not.toThrow();
    expect(() => marksOf("Hi Ada", tokens, LABELS, good.subarray(1))).toThrow(Unspelled);
    expect(readsLabels(["O", "B-private_person", "S-secret"])).toBe(true);
    expect(readsLabels(["O", "B-private_pet"])).toBe(false);
    expect(readsLabels(["O", "X-secret"])).toBe(false);
  });

  it("reads a person from the best path BIOES allows: a broken run goes, a whole span stays, a fragment with a digit stays", () => {
    const unsure = { "I-private_person": 0, O: -1.5, "B-private_person": -3, "E-private_person": -3, "S-private_person": -3 };
    const broken = "Hi Lu ok";
    const run = { 3: unsure, 4: unsure };
    expect(marked(broken, marksOf(broken, tokensOf(broken).tokens, LABELS, scored(broken.length, run)))).toEqual([]);
    expect(marked(broken, marksOf(broken, tokensOf(broken).tokens, LABELS, scored(broken.length, { 3: { "B-private_person": 0, O: -1.5 }, 4: { "E-private_person": 0, O: -1.5 } })))).toEqual([["Lu", "person"]]);
    const long = "Hi Lucinda ok";
    const inside = Object.fromEntries([4, 5, 6, 7, 8].map((index) => [index, { "I-private_person": 0, O: -0.5 }]));
    expect(marked(long, marksOf(long, tokensOf(long).tokens, LABELS, scored(long.length, { ...inside, 3: { "B-private_person": 0 }, 9: { "E-private_person": 0 } })))).toEqual([["Lucinda", "person"]]);
    const { tokens } = tokensOf("Hi Ada");
    expect(marked("Hi Ada", marksOf("Hi Ada", tokens, LABELS, labelled(tokens.length, { 2: "S-private_person" })))).toEqual([["Ada", "person"]]);
    const code = "pin K7 ok";
    const digits = { 4: unsure, 5: unsure };
    expect(marked(code, marksOf(code, tokensOf(code).tokens, LABELS, scored(code.length, digits)))).toEqual([["K7", "person"]]);
  });

  it("marks every other type as each token's best label gives it, a broken run too", () => {
    const passage = "to a@example.com ok";
    const unsure = { "I-private_email": 0, O: -1.5, "B-private_email": -3, "E-private_email": -3, "S-private_email": -3 };
    const run = Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 3, unsure]));
    expect(marked(passage, marksOf(passage, tokensOf(passage).tokens, LABELS, scored(passage.length, run)))).toEqual([["a@example.com", "email"]]);
    const both = "Al a@example.com";
    const person = { "I-private_person": 0, O: -1.5, "B-private_person": -3, "E-private_person": -3, "S-private_person": -3 };
    const rows = { 0: person, 1: person, ...Object.fromEntries(Array.from({ length: 13 }, (_, index) => [index + 3, unsure])) };
    expect(marked(both, marksOf(both, tokensOf(both).tokens, LABELS, scored(both.length, rows)))).toEqual([["a@example.com", "email"]]);
  });

  it("never lets another kind take a name's tokens on the person path", () => {
    const passage = " Rose Ada Rose";
    const { tokens } = tokensOf(passage);
    expect(tokens).toHaveLength(3);
    const rows = { 0: { "B-private_address": 0, O: -2 }, 1: { "S-private_person": 0, "I-private_address": -0.1, O: -3 }, 2: { "E-private_address": 0, O: -2 } };
    expect(marked(passage, marksOf(passage, tokens, LABELS, scored(3, rows)))).toEqual([["Rose", "address"], ["Ada", "person"], ["Rose", "address"]]);
  });

  it("keeps the best labels' person spans inside a path person span that holds a digit", () => {
    const passage = "Hi Bo 7 ok";
    const rows = { 3: { "B-private_person": 0, O: -3 }, 4: { "E-private_person": 0, "I-private_person": -0.1, O: -3 }, 5: { "I-private_person": 0, O: -3 }, 6: { "S-private_person": 0, "E-private_person": -0.1, O: -3 } };
    expect(marked(passage, marksOf(passage, tokensOf(passage).tokens, LABELS, scored(passage.length, rows)))).toEqual([["Bo", "person"]]);
    const broken = { 3: { "I-private_person": 0, "B-private_person": -0.1, O: -3 }, 4: { "I-private_person": 0, O: -3 }, 5: { O: 0, "I-private_person": -0.5 }, 6: { "I-private_person": 0, "E-private_person": -0.1, O: -3 } };
    expect(marked(passage, marksOf(passage, tokensOf(passage).tokens, LABELS, scored(passage.length, broken)))).toEqual([["Bo", "person"]]);
  });

  it("never loses a whole person span of the best labels, over generated scores", () => {
    const words = tokenizerOf([" Ada", " Rose", " Example", " 77"]);
    let seed = 7;
    const random = (): number => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    const raised = LABELS.flatMap((label, index) => (/private_(?:person|address)$/u.test(label) ? [index] : []));
    let whole = 0;
    for (let grid = 0; grid < 3_000; grid++) {
      const count = 1 + Math.floor(random() * 6);
      const chosen = Array.from({ length: count }, () => [" Ada", " Rose", " Example", " 77"][Math.floor(random() * 4)]!);
      const passage = chosen.join("");
      const { ids, tokens: texts } = words.encode(passage, { add_special_tokens: false });
      expect(texts).toHaveLength(count);
      const tokens = texts.map((text: string, index: number) => ({ text, added: ids[index] === END_OF_TEXT }));
      const scores = new Float32Array(count * LABELS.length);
      const best: string[] = [];
      for (let token = 0; token < count; token++) {
        const row = scores.subarray(token * LABELS.length, (token + 1) * LABELS.length);
        for (let label = 0; label < LABELS.length; label++) row[label] = random() * 4 - 2 + (raised.includes(label) ? random() * 4 : 0);
        const most = Math.max(...row);
        const total = most + Math.log(row.reduce((sum, value) => sum + Math.exp(value - most), 0));
        for (let label = 0; label < LABELS.length; label++) row[label] = row[label]! - total;
        best.push(LABELS[row.indexOf(Math.max(...row))]!);
      }
      const marks = marksOf(passage, tokens, LABELS, scores);
      const at = chosen.map((_, index) => chosen.slice(0, index).join("").length);
      for (let from = 0; from < count; from++) {
        let to = from;
        if (best[from] === "B-private_person") {
          while (best[to + 1] === "I-private_person") to++;
          if (best[++to] !== "E-private_person") continue;
        } else if (best[from] !== "S-private_person") continue;
        whole++;
        for (let character = at[from]! + 1; character < at[to]! + chosen[to]!.length; character++) {
          if (passage[character] === " ") continue;
          expect(marks.some((mark) => mark.type === "person" && mark.start <= character && character < mark.end), `${passage}: ${best.join(" ")}`).toBe(true);
        }
      }
      expect(marks).toEqual([...marks].sort((a, b) => a.start - b.start || a.end - b.end));
    }
    expect(whole).toBeGreaterThan(500);
  });

  it("decodes a passage of one token, and one of none", () => {
    const { tokens } = tokensOf(" Ada");
    expect(tokens).toHaveLength(1);
    expect(marked(" Ada", marksOf(" Ada", tokens, LABELS, scored(1, { 0: { "B-private_person": 0, "S-private_person": -1, O: -2 } })))).toEqual([["Ada", "person"]]);
    expect(marked(" Ada", marksOf(" Ada", tokens, LABELS, scored(1, { 0: { "I-private_person": 0, O: -1 } })))).toEqual([]);
    expect(marksOf("", [], LABELS, new Float32Array(0))).toEqual([]);
  });

  it("is version 3, so no mark of the last decoding stands under this one", () => {
    expect(DECODE).toBe("3");
  });
});
