import { baseOf, isCommonWord, isEverydayWord, isFamilyWord, isGivenName, isPlainWord, type DetailType } from "@lifestreamprotocol/core";
import { plainish, STOPS } from "./cues.js";
import type { PassageMark } from "./detector.js";
import { CODE_WORDS, CURRENCY_CODES, CURRENCY_NAMES, CURRENCY_SIGNS, ID_WORDS, isBold, isDate, isSenderMailbox, MASK, OF_ORGANISATION, ORGANISATIONS, PLACE_ENDS, SECRET_WORDS, STREET_WORD } from "./forms.js";
import { ID_NAMES, idLabelBefore } from "./rules.js";

interface Span {
  start: number;
  end: number;
}

export function fitted(passage: string, marks: readonly PassageMark[], named: readonly Span[]): PassageMark[] {
  const words = atWords(passage);
  const seen = new Set<string>();
  return joined(passage, marks.flatMap((mark) => lined(passage, mark)).flatMap((mark) => spaced(passage, mark)).flatMap((mark) => slashed(passage, mark)).flatMap((mark) => atWorded(passage, mark, words))).flatMap(({ mark, pieces }) => {
    const joinable = pieces.length > 1 && (!/^(?:number|phone)$/u.test(baseOf(mark.type)) || (pieces.some((piece) => own(passage, piece, named) === null) && !pieces.some((piece) => amountPiece(passage, piece))));
    const whole = joinable ? own(passage, mark, named) : null;
    return whole !== null ? [whole] : pieces.flatMap((piece) => own(passage, piece, named) ?? other(passage, piece, named) ?? []);
  }).filter((mark) => !seen.has(`${mark.start}:${mark.end}:${mark.type}`) && seen.add(`${mark.start}:${mark.end}:${mark.type}`));
}

const WORD = /[\p{L}\p{M}]+(?:['’][\p{L}\p{M}]+)*/gu;
const CAPITAL_IN = /\p{Lu}/u;
const CAPITALISED = /^\p{Lu}/u;
const LETTER_IN = /\p{L}/u;
const INITIAL_END = /(?:^|\s)\p{Lu}\.$/u;
const covered = (named: readonly Span[], span: Span) => named.some((name) => name.start < span.end && span.start < name.end);

function lined(passage: string, mark: PassageMark): PassageMark[] {
  if (!/^(?:number|phone|secret|email|account)$/u.test(baseOf(mark.type)) || !passage.slice(mark.start, mark.end).includes("\n")) return [mark];
  const pieces: PassageMark[] = [];
  let start = mark.start;
  for (const line of passage.slice(mark.start, mark.end).split("\n")) {
    if (line.trim() !== "") pieces.push({ ...mark, start, end: start + line.length });
    start += line.length + 1;
  }
  return pieces;
}

function spaced(passage: string, mark: PassageMark): PassageMark[] {
  const text = passage.slice(mark.start, mark.end);
  if (baseOf(mark.type) !== "secret" || !/\S\s+\S/u.test(text) || cued(passage, mark) || SECRET_START.test(text.trim())) return [mark];
  return [...text.matchAll(/\S+/gu)].map((word) => ({ ...mark, start: mark.start + word.index, end: mark.start + word.index + word[0].length }));
}

function slashed(passage: string, mark: PassageMark): PassageMark[] {
  if (baseOf(mark.type) !== "person" || !/\/|\s@/u.test(passage.slice(mark.start, mark.end))) return [mark];
  const pieces: PassageMark[] = [];
  let start = mark.start;
  for (let at = mark.start; at <= mark.end; at += 1) {
    const handle = at < mark.end && passage[at] === "@" && at > start && /\s/u.test(passage[at - 1]!);
    if (at < mark.end && passage[at] !== "/" && !handle) continue;
    if (at > start) pieces.push({ ...mark, start, end: at });
    start = handle ? at : at + 1;
  }
  return pieces;
}

function parted(words: string): boolean {
  return /[\p{L}\p{N}]/u.test(words) && !/^\s+[\p{L}\p{M}]+\s*$|^\s*[\p{L}\p{M}]+\s+$/u.test(words);
}

function atWords(passage: string): (Span & { type: DetailType })[] {
  if (!passage.includes("@")) return [];
  return [...passage.matchAll(/(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]*[\p{L}\p{N}_]@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)*/gu)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length, type: /@[^@]+\.\p{L}{2,}$/u.test(match[0]) ? "email" : "account" }));
}

function atWorded(passage: string, mark: PassageMark, words: readonly (Span & { type: DetailType })[]): PassageMark[] {
  const base = baseOf(mark.type);
  if (base === "link") return [mark];
  const over = words.filter((word) => word.start < mark.end && mark.start < word.end);
  if (over.length === 0 || ((base === "email" || base === "account" || base === "secret") && over.every((word) => mark.start <= word.start && word.end <= mark.end))) return [mark];
  const out: PassageMark[] = [];
  let start = mark.start;
  for (const word of over) {
    if (parted(passage.slice(start, word.start))) out.push({ ...mark, start, end: word.start });
    out.push(word);
    start = word.end;
  }
  if (parted(passage.slice(start, mark.end))) out.push({ ...mark, start, end: mark.end });
  return out;
}

function joined(passage: string, marks: readonly PassageMark[]): { mark: PassageMark; pieces: PassageMark[] }[] {
  const sorted = [...marks].sort((left, right) => left.start - right.start || right.end - left.end);
  const out: { mark: PassageMark; pieces: PassageMark[] }[] = [];
  const open = new Map<DetailType, { mark: PassageMark; pieces: PassageMark[] }>();
  for (const mark of sorted) {
    const base = baseOf(mark.type);
    const last = open.get(base);
    const parted = (between: string) => (base === "person" ? between === " " : /^[ \t,.\-/()]{1,3}$/u.test(between));
    if (last !== undefined && base !== "link" && (mark.start <= last.mark.end || parted(passage.slice(last.mark.end, mark.start)))) {
      last.mark = { ...last.mark, end: Math.max(last.mark.end, mark.end) };
      last.pieces.push(mark);
    } else {
      const group = { mark, pieces: [mark] };
      out.push(group);
      open.set(base, group);
    }
  }
  return out;
}

function own(passage: string, mark: PassageMark, named: readonly Span[]): PassageMark | null {
  const base = baseOf(mark.type);
  if (base === "link") return mark;
  if (base === "person") {
    const handle = handleOf(passage, mark);
    if (handle !== null) return handle;
  }
  const span = base === "person" ? spilled(passage, trim(passage, mark.start, mark.end, base)) : trim(passage, mark.start, mark.end, base);
  if (span === null) return null;
  const text = passage.slice(span.start, span.end);
  if (base === "number" || base === "phone") {
    const core = digitsCore(passage, span) ?? digitsCore(passage, asWritten(passage, span));
    if (core === null) return null;
    const mask = masked(passage, core);
    if (mask !== null) return { start: Math.min(span.start, mask.start), end: Math.max(span.end, mask.end), type: "number" };
    if (base === "phone") return digits(text) >= 7 && digits(text) <= 15 && !notANumber(passage, core) ? { ...mark, ...core } : null;
    const number = numbered(passage, core) ?? (spacedCode(text) ? span : null);
    return number === null ? null : { ...mark, start: Math.min(span.start, number.start), end: Math.max(span.end, number.end) };
  }
  const ok = base === "person" ? person(passage, span, text, named)
    : base === "address" ? address(text)
    : base === "secret" ? secret(passage, span, text)
    : base === "email" ? /[^@\s]@[^@\s]/u.test(text) && !isSenderMailbox(text)
    : true;
  return ok ? { ...mark, ...span } : null;
}

function other(passage: string, mark: PassageMark, named: readonly Span[]): PassageMark | null {
  if (baseOf(mark.type) === "email") return null;
  const span = trim(passage, mark.start, mark.end, "secret");
  if (span === null || passage.slice(span.start, span.end).includes("://")) return null;
  const pair = coordinates(passage, span);
  if (pair !== null) return { ...pair, type: "place" };
  const word = trim(passage, span.start, span.end, "account");
  if (word === null) return null;
  const text = passage.slice(word.start, word.end);
  const core = digitsCore(passage, span);
  if (core !== null && /^\p{N}+$/u.test(passage.slice(core.start, core.end)) && cued(passage, core)) return { ...core, type: "secret" };
  const mask = core === null ? null : masked(passage, core);
  if (mask !== null) return { ...mask, type: "number" };
  if (core !== null && notANumber(passage, core)) return null;
  if (atHandle(passage, word, text)) return { start: word.start - 1, end: word.end, type: "account" };
  if (/^[\p{Lu}\p{N}-]{5,}$/u.test(text) && labelled(passage, word)) return { ...word, type: "number" };
  if (core !== null && (!LETTER_IN.test(text) || /^[\p{Lu}\p{N}]+$/u.test(text))) {
    const number = numbered(passage, core);
    return number === null ? null : { ...number, type: "number" };
  }
  if (baseOf(mark.type) === "number" && machineKey(text)) return null;
  if (handle(passage, word, text)) return { ...word, type: "account" };
  if (/^[\p{L}\p{M}' .-]+$/u.test(text) && person(passage, word, text, named) && covered(named, word)) return { ...word, type: "person" };
  return null;
}

function handleOf(passage: string, mark: PassageMark): PassageMark | null {
  let { start, end } = mark;
  while (start < end && /[^\p{L}\p{M}\p{N}._]/u.test(passage[start]!)) start += 1;
  while (end > start && /[^\p{L}\p{M}\p{N}_]/u.test(passage[end - 1]!)) end -= 1;
  return end > start && atHandle(passage, { start, end }, passage.slice(start, end)) ? { start: start - 1, end, type: "account" } : null;
}

function atHandle(passage: string, span: Span, text: string): boolean {
  return /^[\p{L}\p{N}._]{2,}$/u.test(text) && passage[span.start - 1] === "@" && !/[\p{L}\p{N}._-]/u.test(passage[span.start - 2] ?? "");
}

function handle(passage: string, span: Span, text: string): boolean {
  if (!/^\p{L}[\p{L}\p{N}._]*[\p{L}\p{N}]$/u.test(text) || /\d\.\d+$/u.test(text) || /\.(?:com|org|net|io|in|co|edu|gov|dev|app|ai|uk|us)$/iu.test(text)) return false;
  if (/[\p{N}._]/u.test(text)) return true;
  return /^\p{Ll}{3,}$/u.test(text) && !plainish(text, isPlainWord) && /(?:^|[^\p{L}])\p{Lu}[\p{L}-]*:\s*[[(]?\s*$/u.test(passage.slice(Math.max(0, span.start - 30), span.start));
}

function trim(passage: string, start: number, end: number, base: DetailType): Span | null {
  const edge = base === "secret" ? /\s/u : base === "person" ? /[^\p{L}\p{M}\p{N}._]/u : /[^\p{L}\p{M}\p{N}]/u;
  while (start < end && edge.test(passage[start]!)) start += 1;
  while (end > start && edge.test(passage[end - 1]!)) end -= 1;
  if (base === "person") {
    while (start < end && /[._]/u.test(passage[start]!)) start += 1;
    while (end > start && /[._]/u.test(passage[end - 1]!) && !INITIAL_END.test(passage.slice(start, end))) end -= 1;
  }
  return end > start ? { start, end } : null;
}

function digitsCore(passage: string, span: Span): Span | null {
  const tokens = [...passage.slice(span.start, span.end).matchAll(/\S+/gu)];
  const first = tokens.findIndex((token) => /\p{N}/u.test(token[0]));
  if (first === -1) return null;
  const last = tokens.findLastIndex((token) => /\p{N}/u.test(token[0]));
  let start = span.start + tokens[first]!.index;
  let end = span.start + tokens[last]!.index + tokens[last]![0].length;
  while (start < end && /[^\p{L}\p{N}₹$€£¥]/u.test(passage[start]!)) start += 1;
  while (end > start && /[^\p{L}\p{N}]/u.test(passage[end - 1]!)) end -= 1;
  return end > start ? { start, end } : null;
}

const PAPERS: ReadonlySet<string> = new Set([...ID_NAMES, "neft", "rtgs", "upi", "vpa", "ifsc", "gst", "kyc", "otp", "cvv", "tds", "hra", "epf", "ppf", "nps", "avl", "lmt", "txn", "atm", "nri", "micr", "dob"].filter((word) => !isGivenName(word) && !isFamilyWord(word)));

const OF_WORD = `(?:${[...OF_ORGANISATION].map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}|${word.toUpperCase()}`).join("|")})\\s+(?:of|OF)`;
const OF_BEFORE = new RegExp(`(?:^|[^\\p{L}])${OF_WORD}\\s+$`, "u");
const OF_START = new RegExp(`^${OF_WORD}\\s`, "u");

const sentenceWord = (word: string) => isCommonWord(word) && !isGivenName(word) && !STOPS.has(word);

function spilled(passage: string, span: Span | null): Span | null {
  const text = span === null ? "" : passage.slice(span.start, span.end);
  if (span === null || CAPITAL_IN.test(text) || !/^[\p{L}\p{M}'’]+(?:\s+[\p{L}\p{M}'’]+)*$/u.test(text)) return span;
  const words = [...text.matchAll(WORD)];
  let first = 0;
  let last = words.length - 1;
  while (first <= last && sentenceWord(words[first]![0])) first += 1;
  while (last >= first && sentenceWord(words[last]![0])) last -= 1;
  if (words.length === 0 || (first === 0 && last === words.length - 1)) return span;
  if (first > last) return null;
  return { start: span.start + words[first]!.index, end: span.start + words[last]!.index + words[last]![0].length };
}

function person(passage: string, span: Span, text: string, named: readonly Span[]): boolean {
  if (/[\p{N}@/_=\\#$%&*+<>|~]/u.test(text) || /\.\p{L}/u.test(text)) return false;
  const words = text.match(WORD) ?? [];
  if (words.length === 0) return false;
  const next = /^(\s*&\s*|\s+)(\p{L}+)/u.exec(passage.slice(span.end, span.end + 24));
  const ending = (word: string) => CAPITALISED.test(word) && (ORGANISATIONS.has(word.toLowerCase()) || PLACE_ENDS.has(word.toLowerCase()));
  if ((ending(words.at(-1)!) && (words.length > 1 || ORGANISATIONS.has(words.at(-1)!.toLowerCase()))) || (next !== null && ending(next[2]!) && (next[1]!.includes("&") || CAPITALISED.test(words.at(-1)!))) || OF_BEFORE.test(passage.slice(Math.max(0, span.start - 20), span.start)) || OF_START.test(text)) return false;
  if (covered(named, span)) return true;
  if (!CAPITAL_IN.test(text) && words.some(sentenceWord)) return false;
  if (words.length === 1 && CAPITALISED.test(words[0]!) && isPlainWord(words[0]!) && !isGivenName(words[0]!) && !isFamilyWord(words[0]!)) return false;
  const paper = (word: string) => PAPERS.has(word.toLowerCase());
  if (words.some(paper) && words.every((word) => paper(word) || (isPlainWord(word) && !isGivenName(word)))) return false;
  const vowelless = (word: string) => /^[A-Za-z]+$/u.test(word) && !/[aeiouy]/iu.test(word);
  return !((words.length === 1 && [...words[0]!].length === 1) || words.every(vowelless));
}

const LABEL = new RegExp(`(?:^|[^\\p{L}])(?:${ID_WORDS.join("|")})\\.?\\s*[:#]?\\s*$`, "iu");

function labelled(passage: string, span: Span): boolean {
  return LABEL.test(passage.slice(Math.max(0, span.start - 30), span.start)) || idLabelBefore(passage, span.start);
}

const SIGNS = `[${CURRENCY_SIGNS.join("")}]`;
const CURRENCY_BEFORE = new RegExp(`(?:${SIGNS}|\\b(?:${CURRENCY_CODES.join("|")})\\.?)\\s*$`, "iu");
const CURRENCY_AFTER = new RegExp(`^\\s*(?:${SIGNS}|(?:${[...CURRENCY_CODES, ...CURRENCY_NAMES].join("|")})\\b)`, "iu");
const SIGN_START = new RegExp(`^${SIGNS}`, "u");
const CURRENCY_START = new RegExp(`^(?:${CURRENCY_CODES.join("|")}|${SIGNS})\\.?\\s*\\d`, "iu");

const MASKED = new RegExp(`${MASK}\\p{N}{3,}`, "u");
const MASK_BEFORE = new RegExp(`(?<![\\p{L}\\p{N}*•])${MASK}$`, "u");

function masked(passage: string, span: Span): Span | null {
  const before = passage[span.end] === "*" ? null : MASK_BEFORE.exec(passage.slice(Math.max(0, span.start - 40), span.start));
  const start = before === null || isBold(passage.slice(span.start - before[0].length, span.end), passage, span.start - before[0].length) ? span.start : span.start - before[0].length;
  return MASKED.test(passage.slice(start, span.end)) ? { start, end: span.end } : null;
}

function machineKey(text: string): boolean {
  return /^[\p{Ll}\p{N}]{4,}$/u.test(text) && (text.match(/\p{N}+|\p{Ll}+/gu) ?? []).length >= 4;
}

function numbered(passage: string, span: Span): Span | null {
  const written = asWritten(passage, span);
  const text = passage.slice(written.start, written.end);
  const count = digits(text);
  if (count < 3 && !(count >= 1 && /^[\p{Lu}\p{N}]{6,}$/u.test(text))) return null;
  if (notANumber(passage, span) || service(passage, written) || MONEY_BEFORE.test(passage.slice(Math.max(0, written.start - 24), written.start))) return null;
  if (machineKey(text) && !labelled(passage, written)) return null;
  return written;
}

const MONEY_BEFORE = /(?<![\p{L}])(?:rent|salary|price|cost|fees?|fare|amount|total|balance|budget|income|stipend|emi)\s*(?:is|was|of|:|=|-)?\s*(?:about|around|approx\.?|only)?\s*$/iu;

function service(passage: string, span: Span): boolean {
  const before = /(?<![\p{L}])(?:flight|train|bus|route)(?:\s*(?:no\.?|number|#))?(?:\s*\/\s*name)?\s*[:#]?\s*(?:[A-Z0-9]{2}\s?)?$/iu.exec(passage.slice(Math.max(0, span.start - 30), span.start));
  return before !== null && /^(?:[A-Z0-9]{2}\s?)?\d{1,5}[A-Z]?$/u.test(passage.slice(span.start, span.end));
}

function amountPiece(passage: string, piece: Span): boolean {
  const core = digitsCore(passage, piece);
  return core !== null && amountOrTime(passage, asWritten(passage, core));
}

function notANumber(passage: string, span: Span): boolean {
  const written = asWritten(passage, span);
  const text = passage.slice(written.start, written.end);
  return amountOrTime(passage, written) || (isDate(text) && !(/^\d{4}$/u.test(text) && labelled(passage, written))) || isVersion(text) || /\b(?:version|ver\.?)\s*$/iu.test(passage.slice(Math.max(0, written.start - 9), written.start));
}

function isVersion(text: string): boolean {
  const parts = /^v?(\d+(?:\.\d+){1,3})$/iu.exec(text);
  if (parts === null || (!/^v/iu.test(text) && parts[1]!.split(".").length !== 3)) return false;
  return parts[1]!.split(".").every((part) => part.length <= 4) && digits(text) < 7;
}

function asWritten(passage: string, span: Span): Span {
  let { start, end } = span;
  const digit = (at: number) => /[\p{L}\p{N}]/u.test(passage[at] ?? "");
  const separator = (at: number) => /[:./,-]/u.test(passage[at] ?? "") && !/[,.:]\s/u.test(passage.slice(at, at + 2));
  if (digit(start)) while (start > 0 && (digit(start - 1) || (separator(start - 1) && digit(start - 2)))) start -= 1;
  if (digit(end - 1)) while (end < passage.length && (digit(end) || (separator(end) && digit(end + 1)))) end += 1;
  return { start, end };
}

function amountOrTime(passage: string, span: Span): boolean {
  const text = passage.slice(span.start, span.end);
  if (CURRENCY_BEFORE.test(passage.slice(Math.max(0, span.start - 6), span.start)) || CURRENCY_AFTER.test(passage.slice(span.end, span.end + 10)) || CURRENCY_START.test(text)) return true;
  return /^\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/u.test(text) || /^\d*\.\d+$/u.test(text) || /^\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?$/u.test(text);
}

function address(text: string): boolean {
  if (!LETTER_IN.test(text) || /[₹$€£¥]/u.test(text) || machineKey(text)) return false;
  if (/\p{N}/u.test(text) && /\p{L}{2,}/u.test(text)) return true;
  return STREET_WORD.test(text) || (/\p{L}\s*,\s*\p{L}/u.test(text) && CAPITAL_IN.test(text));
}

const SECRET = `(?:${[...SECRET_WORDS].sort((left, right) => right.length - left.length).join("|")})`;
const SECRET_BEFORE = new RegExp(`${SECRET}\\W{0,12}(?:\\p{L}+\\W{1,3}){0,2}$`, "iu");
const SECRET_START = new RegExp(`^${SECRET}\\b`, "iu");
const SECRET_AFTER = new RegExp(`^\\W{0,3}(?:is\\s+(?:your|the)\\b|(?:${[...CODE_WORDS, "code"].join("|")})\\b)`, "iu");

function cued(passage: string, span: Span): boolean {
  return SECRET_BEFORE.test(passage.slice(Math.max(0, span.start - 40), span.start)) || SECRET_AFTER.test(passage.slice(span.end, span.end + 20));
}

const SECRET_NEXT = new RegExp(`(?<![\\p{L}])${SECRET}(?:\\s+is)?\\s*[:=#-]?\\s*["'\`(]?$`, "iu");

function secret(passage: string, span: Span, text: string): boolean {
  if (/^(?:https?|ftp)$/iu.test(text) || text.includes("://") || /^[/.:]/u.test(text)) return false;
  if ((passage.slice(Math.max(0, span.start - 3), span.start) === "://" && !/^[^/\s@]*@/u.test(passage.slice(span.start, span.start + 256))) || /^[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{Ll}{2,24}\//u.test(text)) return false;
  if (/\s/u.test(text) && !cued(passage, span) && !SECRET_START.test(text)) return false;
  if (/^\p{N}+$/u.test(text) && /(?:^|[^\p{L}\p{N}_])[\p{L}_][\p{L}\p{N}_]*\s*[=:]\s*["']?$/u.test(passage.slice(Math.max(0, span.start - 30), span.start)) && !SECRET_NEXT.test(passage.slice(Math.max(0, span.start - 30), span.start))) return false;
  if (SIGN_START.test(text) || CURRENCY_BEFORE.test(passage.slice(Math.max(0, span.start - 6), span.start))) return false;
  if (text.length < 4) return /^\p{N}{3}$/u.test(text) && SECRET_NEXT.test(passage.slice(Math.max(0, span.start - 30), span.start));
  if (/^\p{L}+$/u.test(text) && plainish(text, isPlainWord)) return SECRET_NEXT.test(passage.slice(Math.max(0, span.start - 30), span.start));
  if (/^[\p{N}:./,-]+$/u.test(text)) {
    const written = asWritten(passage, span);
    if (amountOrTime(passage, written) || isDate(passage.slice(written.start, written.end))) return cued(passage, span);
  }
  return true;
}

function spacedCode(text: string): boolean {
  return /^\p{Lu}[\p{Lu}\p{N}]*(?: [\p{Lu}\p{N}]+)* [\p{Lu}\p{N}]*\p{Lu}$/u.test(text) && /\p{N}/u.test(text);
}

function coordinates(passage: string, span: Span): Span | null {
  for (const match of passage.matchAll(/(?<!\d|\d\.)(?:[Ll]at(?:itude)?\.?\s*[:=]?\s*)?-?\d{1,2}\.\d{2,}°?(?:\s*[NS])?(?:\s*,\s*|\s+)(?:[Ll]ong?(?:itude)?\.?\s*[:=]?\s*)?-?\d{1,3}\.\d{2,}°?(?:\s*[EW])?(?!\d|\.\d)/gu)) {
    if (match.index < span.end && span.start < match.index + match[0].length) return { start: match.index, end: match.index + match[0].trimEnd().length };
  }
  return null;
}

function digits(text: string): number {
  return (text.match(/\p{N}/gu) ?? []).length;
}
