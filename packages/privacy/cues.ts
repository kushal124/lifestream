import { isRoleMailbox } from "./forms.js";

export interface CueTable {
  plain: (word: string) => boolean;
  named: (word: string) => boolean;
  family: (word: string) => boolean;
}

export interface Cued {
  start: number;
  end: number;
  cue: "label-weak" | "speaker-untimed" | "honorific" | "address" | "salutation" | "label" | "speaker" | "display" | "signature" | "declaration";
}

export interface Token {
  start: number;
  end: number;
  word: string;
  kind: "title" | "caps" | "initial" | "other";
}

const UPPER = /^\p{Lu}/u;
const LOWER = /\p{Ll}/u;
const CAPITAL_IN = /\p{Lu}/u;
const ALL_UPPER = /^[\p{Lu}\p{M}'’-]+$/u;
const POSSESSIVE = /.['’][sS]$/u;
const JOINED_SMALL = /-\p{Ll}/u;

export const HONORIFICS = new Set(["mr", "mrs", "ms", "mx", "miss", "dr", "prof", "shri", "shree", "sri", "smt", "shrimati", "kumari", "sh"]);
const ADDRESS = new Set(["ji", "uncle", "aunty", "auntie", "aunt", "sir", "madam", "bhai", "bhaiya", "bhaiyya", "didi", "saab", "sahab", "saheb", "sahib"]);
const SALUTATIONS = new Set(["dear", "hi", "hello", "hey", "hii", "namaste", "hiya", "greetings"]);
const NOT_SPEAKERS = new Set(["you", "me", "user", "assistant", "system", "bot", "ai", "model", "human", "the user"]);
export const STOPS = new Set([...HONORIFICS, ...ADDRESS, ...SALUTATIONS]);

const LABEL_WORDS = [
  "name", "names", "surname", "passenger", "passengers", "guest", "guests", "beneficiary", "payee", "nominee", "landlord", "tenant",
  "applicant", "co-applicant", "borrower", "co-borrower", "sender", "recipient", "receiver", "shipper", "consignor", "consignee",
  "seller", "buyer", "patient", "doctor", "physician", "prescriber", "consultant", "policyholder", "policy holder", "account holder",
  "cardholder", "card holder", "insured", "claimant", "witness", "employee", "customer", "client", "guardian", "father", "mother",
  "spouse", "husband", "wife", "emergency contact", "contact person", "attn", "attention", "author", "approved by", "prepared by",
  "signed by", "requested by", "reviewed by", "issued to", "delivered by", "delivery partner", "driver", "agent", "advisor", "adviser",
  "manager", "coordinator", "volunteer", "student", "teacher", "instructor", "trainer", "plaintiff", "defendant", "requestor",
  "requester", "assignee", "reporter", "paid to", "member", "traveller", "traveler", "candidate", "contact", "owner",
];
export const ROLES: ReadonlySet<string> = new Set(LABEL_WORDS.filter((label) => !label.includes(" ") && label !== "name" && label !== "names" && label !== "surname"));
const NOT_PERSON_NAME = new Set([
  "company", "business", "bank", "product", "branch", "file", "host", "domain", "project", "brand", "store", "merchant", "shop", "app",
  "device", "network", "street", "place", "city", "town", "village", "item", "plan", "course", "school", "college", "university",
  "hospital", "clinic", "organization", "organisation", "org", "event", "team", "group", "channel", "model", "document", "field", "user",
  "wifi", "ssid", "server", "vendor", "supplier", "firm", "entity", "institution", "insurer", "provider", "service", "package",
  "medicine", "drug", "test", "scheme", "fund", "policy", "vehicle", "flight", "train", "hotel", "property", "building", "society",
  "campaign", "game", "song", "album", "book", "pet", "card", "employer", "country", "state", "district", "area", "locality",
  "venue", "restaurant", "folder", "table", "column", "screen", "display", "variable", "function", "class", "key", "tag", "region",
]);
const LABELS = new Map<string, string[][]>();
for (const label of LABEL_WORDS) {
  const words = label.split(" ");
  const last = words.pop()!;
  LABELS.set(last, [...(LABELS.get(last) ?? []), words].sort((x, y) => y.length - x.length));
}
const STATED = /^(?:\*\*)?[ \t]*[:|](?!\/)[ \t]*(?:\*\*)?[ \t]*/u;
const SIGN_OFF_LINE = /(?<![^\n])[ \t]*(?:(?:thanks|thank you|many thanks)(?:[ \t]*(?:&|and)[ \t]*regards)?|(?:best|kind|warm|warmest|with)?[ \t]*regards|best|sincerely|yours[ \t]+(?:sincerely|faithfully|truly)|cheers|warmly)[ \t]*[,.!]?[ \t]*(?![^\n])/giu;
const SPEAKER = /^([ \t]*)(?:(\[[^\]\n]{0,30}\d:\d\d[^\]\n]{0,12}\][ \t]*|\d{1,2}:\d{2}(?::\d{2})?(?:[ \t]*[AaPp][Mm])?[ \t]+))?(?=\S)/gmu;
const DISPLAY = /[ \t]<[^\s<>@]+@[^\s<>]+>/gu;
const PAID_DOMAIN = /[\w.-]+[ \t]*\(/y;
const UPI = /\bUPI[/-]/gu;
const DECLARATION = /(?:^|[.!?]\s+|\n\s*)I, /gu;

export function tokensOf(text: string): Token[] {
  const tokens: Token[] = [];
  for (let at = 0; at < text.length;) {
    const width = letterAt(text, at);
    if (width === 0) {
      const code = text.charCodeAt(at);
      at += code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
      continue;
    }
    const start = at;
    at = lettersEnd(text, at);
    for (;;) {
      const code = text.charCodeAt(at);
      if (!(code === 0x27 || code === 0x2019 || code === 0x2d) || letterAt(text, at + 1) === 0) break;
      at = lettersEnd(text, at + 1);
    }
    const found = text.slice(start, at);
    const word = POSSESSIVE.test(found) ? found.slice(0, -2) : found;
    let end = start + word.length;
    let kind: Token["kind"] = "other";
    if (UPPER.test(word)) {
      if (word.length === 1 || (word.length === 2 && word.codePointAt(0)! > 0xffff)) {
        kind = "initial";
        if (text[end] === ".") end += 1;
      } else if (JOINED_SMALL.test(word)) kind = "other";
      else kind = LOWER.test(word) ? "title" : ALL_UPPER.test(word) ? "caps" : "other";
    }
    tokens.push({ start, end, word, kind });
  }
  return tokens;
}

function paidIds(text: string): number[] {
  const out: number[] = [];
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let start = at;
    while (start > 0 && paidCharacter(text.charCodeAt(start - 1))) start -= 1;
    if (start === at) continue;
    PAID_DOMAIN.lastIndex = at + 1;
    if (!PAID_DOMAIN.test(text)) continue;
    out.push(PAID_DOMAIN.lastIndex);
    at = PAID_DOMAIN.lastIndex - 1;
  }
  return out;
}

function paidCharacter(code: number): boolean {
  return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f || code === 0x2e || code === 0x2a || code === 0x2b || code === 0x2d;
}

const LETTER_OR_MARK = /[\p{L}\p{M}]/uy;

function letterAt(text: string, at: number): number {
  if (at >= text.length) return 0;
  const code = text.charCodeAt(at);
  if (code < 0x80) return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ? 1 : 0;
  LETTER_OR_MARK.lastIndex = at;
  if (!LETTER_OR_MARK.test(text)) return 0;
  return LETTER_OR_MARK.lastIndex - at;
}

function lettersEnd(text: string, at: number): number {
  for (let width = letterAt(text, at); width > 0; width = letterAt(text, at)) at += width;
  return at;
}

export function cuedNames(text: string, table: CueTable, tokens: readonly Token[] = tokensOf(text)): Cued[] {
  const at = indexer(tokens);
  const found: Cued[] = [];
  const add = (from: number, to: number, cue: Cued["cue"]) => {
    if (to > from) found.push({ start: tokens[from]!.start, end: tokens[to - 1]!.end, cue });
  };
  const known = (word: string) => !plainish(word, table.plain) || table.named(word);
  const lower = (token: Token) => token.word.toLowerCase();
  const lowers = tokens.map(lower);

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    const word = lowers[i]!;
    if (HONORIFICS.has(word) && (token.kind === "title" || token.kind === "caps") && !(word === "miss" && token.kind !== "title")) {
      const next = i + 1;
      if (next < tokens.length && gap(text, token.end + (text[token.end] === "." ? 1 : 0), tokens[next]!.start)) {
        const end = runAt(text, tokens, next, () => true);
        if (end > next && (word !== "miss" || known(tokens[next]!.word))) add(next, end, "honorific");
      }
    }
    if (ADDRESS.has(word) && i > 0 && gap(text, tokens[i - 1]!.end, token.start)) {
      let from = i;
      for (let back = i - 1; back >= Math.max(0, i - 2); back -= 1) {
        const before = tokens[back]!;
        if ((before.kind !== "title" && before.kind !== "caps") || STOPS.has(lower(before))) break;
        if (table.plain(before.word) && !table.family(before.word) && !table.named(before.word)) break;
        if (back < i - 1 && !gap(text, before.end, tokens[back + 1]!.start)) break;
        from = back;
      }
      add(from, i, "address");
    }
    if (SALUTATIONS.has(word) && i + 1 < tokens.length && gap(text, token.end, tokens[i + 1]!.start)) {
      const next = i + 1;
      if (known(tokens[next]!.word)) add(next, runAt(text, tokens, next, () => true), "salutation");
    }
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const befores = LABELS.get(lowers[i]!);
    if (befores === undefined) continue;
    const before = befores.find((words) => words.every((word, k) => {
      const back = i - words.length + k;
      return back >= 0 && lower(tokens[back]!) === word && /^[ \t]+$/u.test(text.slice(tokens[back]!.end, tokens[back + 1]!.start));
    }));
    if (before === undefined) continue;
    const labelStart = tokens[i - before.length]!.start;
    if (before.length === 0 && (lower(tokens[i]!) === "name" || lower(tokens[i]!) === "names")) {
      let personal = true;
      for (let back = i - 1; back >= Math.max(0, i - 3) && /^[ \t]+$/u.test(text.slice(tokens[back]!.end, tokens[back + 1]!.start)); back -= 1) {
        if (NOT_PERSON_NAME.has(lower(tokens[back]!))) personal = false;
      }
      if (!personal) continue;
    }
    const labelEnd = tokens[i]!.end;
    const rest = text.slice(labelEnd, labelEnd + 400);
    const stated = STATED.exec(rest);
    const alone = /^[ \t]*(?:\*\*)?[ \t]*:?[ \t]*\n[ \t]*/u.exec(rest);
    const weak = /^,?[ \t](?=\p{Lu})/u.exec(rest);
    const skip = stated?.[0] ?? alone?.[0] ?? weak?.[0];
    if (skip === undefined) continue;
    if (alone !== null && stated === null && !/^[ \t*#>|-]*(?:[\p{L}'’]+[ \t]+){0,3}$/u.test(text.slice(text.lastIndexOf("\n", labelStart - 1) + 1, labelStart))) continue;
    const first = at(labelEnd + skip.length);
    if (first === -1 || tokens[first]!.start !== labelEnd + skip.length || HONORIFICS.has(lower(tokens[first]!))) continue;
    const end = runAt(text, tokens, first, () => true);
    if (end === first) continue;
    if (stated === null && alone === null) {
      if (CAPITAL_IN.test(tokens[i]!.word) || tokens[first]!.kind !== "title" || !known(tokens[first]!.word)) continue;
      add(first, end, "label-weak");
      continue;
    }
    if (!ends(text, tokens[end - 1]!.end)) continue;
    if (stated !== null && stated[0].includes("|") && !known(tokens[first]!.word)) continue;
    add(first, end, "label");
  }

  for (const match of text.matchAll(SPEAKER)) {
    const first = at(match.index + match[0].length);
    if (first === -1 || tokens[first]!.start !== match.index + match[0].length) continue;
    const timed = match[2] !== undefined;
    const indented = match[1]!.length > 0;
    if (!timed && !indented) continue;
    const end = runAt(text, tokens, first, () => true);
    if (end === first || text[tokens[end - 1]!.end] !== ":" || !/^[ \t]/u.test(text.slice(tokens[end - 1]!.end + 1))) continue;
    const spoken = text.slice(tokens[first]!.start, tokens[end - 1]!.end).toLowerCase();
    if (NOT_SPEAKERS.has(spoken)) continue;
    if (!timed && (!known(tokens[first]!.word) || tokens[first]!.kind === "caps" || HONORIFICS.has(lower(tokens[first]!)))) continue;
    add(first, end, timed ? "speaker" : "speaker-untimed");
  }

  for (const match of text.matchAll(DISPLAY)) {
    const last = at(match.index, true);
    if (last === -1 || tokens[last]!.end !== match.index) continue;
    let first = last;
    while (first > 0 && first > last - 3 && named(tokens[first - 1]!) && gap(text, tokens[first - 1]!.end, tokens[first]!.start) && alike(tokens[first - 1]!, tokens[last]!)) first -= 1;
    if (!named(tokens[first]!) || runAt(text, tokens, first, () => true) !== last + 1 || !/(?:^|\n|[:,"'][ \t]*)$/u.test(text.slice(Math.max(0, tokens[first]!.start - 3), tokens[first]!.start))) continue;
    if (organisation(tokens.slice(first, last + 1).map((token) => token.word), match[0])) continue;
    add(first, last + 1, "display");
  }
  for (const { after, close } of [...paidIds(text).map((after) => ({ after, close: ")" })), ...[...text.matchAll(UPI)].map((match) => ({ after: match.index + match[0].length, close: match[0].at(-1)! }))]) {
    const first = at(after);
    if (first === -1 || tokens[first]!.start !== after) continue;
    const end = runAt(text, tokens, first, () => true);
    if (end > first && text[tokens[end - 1]!.end] === close) add(first, end, "display");
  }

  for (const match of text.matchAll(SIGN_OFF_LINE)) {
    const lineEnd = text.indexOf("\n", match.index);
    const next = (lineEnd === -1 ? text.length : lineEnd) + 1;
    const rest = text.slice(next);
    const blank = /^(?:[ \t]*\n)*[ \t]*/u.exec(rest)![0].length;
    const first = at(next + blank);
    if (first !== -1 && tokens[first]!.start === next + blank && !HONORIFICS.has(lower(tokens[first]!))) {
      const end = runAt(text, tokens, first, () => true);
      if (end > first && known(tokens[first]!.word) && /^[ \t]*(?:\n|,|$)/u.test(text.slice(tokens[end - 1]!.end))) add(first, end, "signature");
    }
  }

  for (const match of text.matchAll(DECLARATION)) {
    const after = match.index + match[0].length;
    const first = at(after);
    if (first === -1 || tokens[first]!.start !== after) continue;
    const end = runAt(text, tokens, first, () => true);
    if (end > first && text[tokens[end - 1]!.end] === ",") add(first, end, "declaration");
  }
  return found;

  function named(token: Token): boolean {
    return (token.kind === "title" || token.kind === "caps" || token.kind === "initial") && !STOPS.has(lower(token));
  }
}


function organisation(words: readonly string[], address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  const labels = new Set(domain.split(/[^\p{L}\p{N}]+/u));
  if (words.some((word) => labels.has(word.toLowerCase()))) return true;
  return words.length === 1 && isRoleMailbox(address.trim().replace(/^<|>$/gu, ""));
}

export function plainish(word: string, plain: (word: string) => boolean): boolean {
  if (plain(word)) return true;
  const lower = word.toLowerCase();
  if (lower.length < 4) return false;
  for (const [ending, stems] of INFLECTIONS) {
    if (!lower.endsWith(ending)) continue;
    const stem = lower.slice(0, -ending.length);
    if (stems.some((add) => plain(stem + add))) return true;
  }
  return false;
}

const INFLECTIONS: readonly (readonly [string, readonly string[]])[] = [
  ["ies", ["y"]], ["es", ["", "e"]], ["s", [""]], ["ied", ["y"]], ["ed", ["", "e"]], ["ing", ["", "e"]],
];

export function alike(a: Token, b: Token): boolean {
  if (a.kind === "initial" || b.kind === "initial") return true;
  return (a.kind === "caps") === (b.kind === "caps");
}

export function indexer(tokens: readonly Token[]): (offset: number, before?: boolean) => number {
  return (offset, before = false) => {
    let low = 0;
    let high = tokens.length;
    if (before) {
      while (low < high) {
        const mid = (low + high) >> 1;
        if (tokens[mid]!.end <= offset) low = mid + 1;
        else high = mid;
      }
      return low - 1;
    }
    while (low < high) {
      const mid = (low + high) >> 1;
      if (tokens[mid]!.start < offset) low = mid + 1;
      else high = mid;
    }
    return low < tokens.length ? low : -1;
  };
}

export function gap(text: string, end: number, start: number): boolean {
  const between = text.slice(end, start);
  return between === " ";
}

function ends(text: string, end: number): boolean {
  return /^(?:$|[ \t]*(?:\n|[,;(<|*]|\s[-–]\s)|[ \t]{2,}|[.](?:\s|$))/u.test(text.slice(end, end + 4));
}

export function runAt(text: string, tokens: readonly Token[], from: number, take: (token: Token) => boolean, most = 4, initials = false): number {
  let end = from;
  let caps: boolean | undefined;
  let word = false;
  while (end < tokens.length && end < from + most) {
    const token = tokens[end]!;
    if (token.kind === "other" || STOPS.has(token.word.toLowerCase()) || !take(token)) break;
    if (end > from && !gap(text, tokens[end - 1]!.end, token.start)) break;
    if (token.kind !== "initial") {
      const isCaps = token.kind === "caps";
      if (caps !== undefined && caps !== isCaps) break;
      caps = isCaps;
      word = true;
    }
    end += 1;
  }
  while (end > from && tokens[end - 1]!.kind === "initial" && !tokens[end - 1]!.word.endsWith(".") && text[tokens[end - 1]!.end - 1] !== ".") end -= 1;
  return word || initials ? end : from;
}
