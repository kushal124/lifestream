import { canonicalEmail, fold as foldDetail, isAscii, isCommonWord, isEverydayWord, isFamilyWord, isGivenName, isPlaceName, isPlainWord, phoneOfJid, readingOf, runsOf, type DetailType, type Mark, type Owner, type Reading } from "@lifestreamprotocol/core";
import { alike, cuedNames, gap, HONORIFICS, ROLES, indexer, plainish, runAt, STOPS, tokensOf, type Token } from "./cues.js";
import { isFaith, OF_ORGANISATION as OF, ORGANISATIONS, PLACE_ENDS as PLACES, PREDICATE_STARTS } from "./forms.js";
import { idType } from "./rules.js";

export interface NamedPerson {
  who: string;
  is: "human" | "business" | "bot";
  shown: string;
  names: readonly string[];
  accounts: readonly string[];
}

export interface NameTable {
  version: string;
  owner: Owner | null;
  people: readonly NamedPerson[];
}

export interface NameMatcher {
  marks(text: string, reading?: Reading): Mark[];
  whoOf(id: string): string | undefined;
  isOf(who: string): NamedPerson["is"] | undefined;
  personOf(who: string): string;
}

const PREFIXED: ReadonlySet<string> = new Set(["phone", "email", "jid"]);

interface Hit {
  type: "person" | Exclude<ReturnType<typeof idType>, "phone">;
  who?: string;
  shown?: string;
  form?: "title" | "unshouted";
  none?: true;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const DIGIT_RUN = /(?<![\p{L}\p{N}])\+?\(?\d+\)?(?:[ .-]?\(?\d+\)?)*/gu;
const WORDLIKE = /[\p{L}\p{N}]/u;
const LETTER = /\p{L}/u;
const GROUP = /\+?\(?\d+\)?/gu;
const fold = (text: string) => {
  let ascii = true;
  let spaced = text.length > 0 && text.charCodeAt(0) !== 0x20 && text.charCodeAt(text.length - 1) !== 0x20;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code > 0x7e) ascii = false;
    else if (code < 0x20 || (code === 0x20 && text.charCodeAt(index + 1) === 0x20)) spaced = false;
  }
  if (ascii && spaced) return text.toLowerCase();
  return (ascii ? text : text.normalize("NFC")).toLowerCase().replace(/\s+/gu, " ").trim();
};

const CALENDAR = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

export interface Words {
  plain: (word: string) => boolean;
  common: (word: string) => boolean;
  everyday: (word: string) => boolean;
  given: (word: string) => boolean;
  place: (phrase: string) => boolean;
}

export const BUNDLED: Words = { plain: isPlainWord, common: isCommonWord, everyday: isEverydayWord, given: isGivenName, place: isPlaceName };

let compiled: { table: NameTable; version: string; matcher: NameMatcher } | null = null;

export type Sealed = { readonly people: ReadonlySet<string>; readonly handles: readonly string[] } | { readonly except: ReadonlySet<string> };

export interface Sealing {
  detail(type: string, text: string, who?: string): boolean;
  marks(text: string): Mark[];
}

export interface Seal extends Sealing {
  readonly only: boolean;
  person(who: string): boolean;
  readonly typed: Sealing;
}

export function sealsAny(sealed: Sealed | undefined): sealed is Sealed {
  return sealed !== undefined && ("except" in sealed || sealed.people.size > 0 || sealed.handles.length > 0);
}

export const NAMING: readonly DetailType[] = ["person", "account", "phone", "email", "number.payment"];
const naming = new Set<string>(NAMING);

const seals = new WeakMap<Sealed, { table: NameTable; version: string; seal: Seal }>();

const holders = new WeakMap<NameTable, ReadonlyMap<string, string | null>>();

export function ownNames(table: NameTable, who: string): string[] {
  let held = holders.get(table);
  if (held === undefined) {
    const owner = table.owner?.who;
    const by = new Map<string, string | null>();
    for (const person of table.people) {
      if (person.is !== "human") continue;
      for (const name of person.names) {
        const key = fold(name);
        if (key === "") continue;
        const was = by.get(key);
        by.set(key, was === undefined || person.who === owner ? person.who : was === owner || was === person.who ? was : null);
      }
    }
    holders.set(table, (held = by));
  }
  return (table.people.find((person) => person.who === who)?.names ?? []).filter((name) => held.get(fold(name)) === who);
}

export function sealOf(table: NameTable, sealed: Sealed | undefined): Seal | null {
  if (!sealsAny(sealed)) return null;
  const held = seals.get(sealed);
  if (held?.table === table && held.version === table.version) return held.seal;
  const seal = compileSeal(table, sealed);
  seals.set(sealed, { table, version: table.version, seal });
  return seal;
}

function compileSeal(table: NameTable, sealed: Sealed): Seal {
  const only = "except" in sealed;
  const matcher = compileNames(table);
  const owner = table.owner?.who;
  const listed = only
    ? (who: string) => !sealed.except.has(who) && who !== owner
    : (who: string) => sealed.people.has(who);
  const words = new Set<string>();
  const handles = new Set<string>();
  const handle = (id: string) => {
    const key = idKey(id);
    if (key !== null) handles.add(key);
  };
  if (!only) {
    for (const each of table.people) {
      if (!sealed.people.has(each.who)) continue;
      for (const name of [each.shown, ...each.names]) {
        const key = fold(name);
        if (key === "") continue;
        words.add(key);
        for (const word of key.match(WORD) ?? []) words.add(word);
      }
      each.accounts.forEach(handle);
    }
    sealed.handles.forEach(handle);
  }
  const judged = new Map<string, boolean>();
  const judge = (who: string): boolean => {
    const of = matcher.personOf(who);
    if (only) return listed(of);
    const key = handleKey(who);
    return listed(who) || listed(of) || (key !== null && handles.has(key));
  };
  const person = (who: string): boolean => {
    const known = judged.get(who);
    if (known !== undefined) return known;
    const answer = judge(who);
    judged.set(who, answer);
    return answer;
  };
  const whoOf = (type: string, text: string): string | undefined => {
    if (type !== "person") return matcher.whoOf(text);
    return matcher.marks(text).find((mark) => mark.start === 0 && mark.end === text.length && mark.who !== undefined)?.who;
  };
  const named = (type: string, text: string): boolean => {
    if (only) return true;
    if (type === "person") return words.has(fold(text));
    const key = idKey(text);
    return (key !== null && handles.has(key)) || words.has(fold(text));
  };
  const detail = (type: string, text: string, who?: string): boolean => {
    if (!naming.has(type)) return false;
    const of = who ?? whoOf(type, text);
    return of === undefined ? named(type, text) : person(of) || (!only && type !== "person" && named(type, text));
  };
  const spelled = only ? [] : sealed.handles.filter((each) => each !== "").map((each) => ({ type: idType(each), at: handleAt(each) }));
  const sealing = (judged: Sealing["detail"]): Sealing => ({
    detail: judged,
    marks(text) {
      const found = matcher.marks(text).filter((mark) => judged(mark.type, text.slice(mark.start, mark.end), mark.who));
      for (const { type, at } of spelled) for (const each of text.matchAll(at)) found.push({ start: each.index, end: each.index + each[0].length, type });
      return found.sort((left, right) => left.start - right.start || right.end - left.end);
    },
  });
  const bearers = new Map<string, string[]>();
  if (only) {
    for (const each of table.people) {
      for (const name of new Set([each.shown, ...each.names].map(fold))) if (name !== "") bearers.set(name, [...bearers.get(name) ?? [], each.who]);
    }
  }
  const typed = (type: string, text: string, who?: string): boolean => {
    if (!naming.has(type)) return false;
    const of = who ?? whoOf(type, text);
    if (of !== undefined) return person(of);
    return type === "phone" || type === "email" || (type === "person" && (bearers.get(fold(text)) ?? []).some(person));
  };
  const out = sealing(detail);
  return { only, person, ...out, typed: only ? sealing(typed) : out };
}

function handleAt(handle: string): RegExp {
  const spelled = handle.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_]|[\\p{L}\\p{N}][._+@-])${spelled}(?![\\p{L}\\p{N}_]|[._+@-][\\p{L}\\p{N}])`, "giu");
}

export function compileNames(table: NameTable, lists: Words | ((word: string) => boolean) = BUNDLED): NameMatcher {
  if (lists === BUNDLED && compiled?.table === table && compiled.version === table.version) return compiled.matcher;
  const words: Words = typeof lists === "function" ? { plain: lists, common: lists, everyday: lists, given: isGivenName, place: isPlaceName } : lists;
  const { plain, common, everyday, given, place } = words;
  const phrases = holder();
  const held = holder();
  const add = phrases.add;
  const ids = new Map<string, string | null>();
  const kinds = new Map(table.people.map((person) => [person.who, person.is]));
  const nameWords = new Set<string>();
  const fuller = new Map<string, Map<string, Set<string>>>();
  const families = new Set<string>();
  const notPeople = new Set<string>();
  for (const person of table.people) {
    if (person.is !== "human") {
      for (const name of [person.shown, ...person.names]) {
        const key = fold(name);
        if (key === "") continue;
        notPeople.add(key);
        if ((key.match(WORD) ?? []).length > 1) add(key, { type: "person", none: true });
      }
      continue;
    }
    for (const name of person.names) {
      const key = fold(name);
      const words = key.match(WORD) ?? [];
      if (words.length === 0) continue;
      for (const [index, word] of words.entries()) {
        nameWords.add(word);
        if (words.length > 1 && word === words.at(-1)) families.add(word);
        if (index + 1 < words.length) {
          const after = fuller.get(person.who) ?? new Map<string, Set<string>>();
          fuller.set(person.who, after.set(word, (after.get(word) ?? new Set()).add(words[index + 1]!)));
        }
      }
      if (words.length === 1) {
        const one = words[0]!;
        if (!LETTER.test(one) || [...one].length < 2 || HONORIFICS.has(one)) continue;
        if (common(one) || ROLES.has(one)) {
          held.add(one, { type: "person", who: person.who }, person.who === table.owner?.who);
          continue;
        }
        if (plainish(one, plain)) {
          add(key, { type: "person", who: person.who, form: given(one) && !everyday(one) ? "unshouted" : "title" }, person.who === table.owner?.who);
          continue;
        }
      }
      add(key, words.length === 1 ? { type: "person", who: person.who } : { type: "person", who: person.who, shown: person.shown }, person.who === table.owner?.who);
    }
    for (const account of person.accounts) {
      const id = idKey(account);
      if (id === null) continue;
      ids.set(id, ids.has(id) && ids.get(id) !== person.who ? null : person.who);
      const type = idType(account);
      if (type === "phone") continue;
      const key = fold(account.replace(/^@/u, ""));
      const words = key.match(WORD) ?? [];
      if (type === "account" && words.length === 1 && words[0] === key && common(key)) continue;
      add(key, { type, who: person.who });
    }
  }
  const first = new Map<string, number>();
  const pairs = new Set<string>();
  for (const key of phrases.map.keys()) {
    const runs = runsOf(key);
    const count = runs.length / 2;
    if (count === 0) continue;
    const word = key.slice(runs[0], runs[1]);
    first.set(word, Math.max(first.get(word) ?? 0, count));
    if (count >= 2) pairs.add(key.slice(0, runs[3]));
  }
  const firstLengths = new Set([...first.keys()].map((word) => word.length));
  const named = (word: string) => nameWords.has(fold(word)) || (given(word) && !common(word) && !CALENDAR.has(fold(word)) && !STOPS.has(fold(word)));
  const cueTable = { plain, named, family: (word: string) => families.has(fold(word)) };
  const alone = (word: string) => given(word) && !plainish(word, plain) && !CALENDAR.has(fold(word)) && !STOPS.has(fold(word));
  const matcher: NameMatcher = {
    marks: read,
    whoOf(id) {
      const key = idKey(id);
      return key === null ? undefined : (ids.get(key) ?? undefined);
    },
    isOf(who) {
      return kinds.get(who);
    },
    personOf(who) {
      if (kinds.has(who) || who === table.owner?.who) return who;
      const key = handleKey(who);
      return (key === null ? undefined : ids.get(key)) ?? who;
    },
  };
  function read(text: string, reading?: Reading): Mark[] {
    const { runs, lower } = readingOf(text, reading);
    const words = runs.length / 2;
    const marks: Mark[] = [];
    for (let at = 0; at < words;) {
      let taken = 0;
      const start = runs[2 * at]!;
      const wordEnd = runs[2 * at + 1]!;
      const ascii = lower !== null && isAscii(text, start, wordEnd);
      const most = ascii ? (firstLengths.has(wordEnd - start) ? first.get(lower.slice(start, wordEnd)) : undefined) : first.get(fold(text.slice(start, wordEnd)));
      if (most !== undefined) {
        const word = text.slice(start, wordEnd);
        let longest = Math.min(most, words - at);
        if (longest >= 2) {
          const second = runs[2 * at + 3]!;
          if (lower !== null && isAscii(text, start, second) && !pairs.has(fold(text.slice(start, second)))) longest = 1;
        }
        for (let count = longest; count >= 1; count -= 1) {
          const end = runs[2 * (at + count - 1) + 1]!;
          const hit = phrases.map.get(fold(text.slice(start, end)));
          if (hit === undefined || !writtenAs(word, hit.form)) continue;
          if (count === 1 && hit.shown === undefined && hit.type === "person" && !standsAlone(text, start, end, hit.form, plain, given)) continue;
          if (count === 1 && hit.shown === undefined && hit.type === "person" && inHost(text, start, end)) continue;
          if (hit.none === true) {
            taken = count;
            break;
          }
          marks.push({ start, end, type: hit.type, ...(hit.who === undefined ? {} : { who: hit.who }), ...(hit.shown === undefined ? {} : { shown: hit.shown }) });
          taken = count;
          break;
        }
      }
      at += Math.max(taken, 1);
    }
    for (const run of text.matchAll(DIGIT_RUN)) {
      if (!WORDLIKE.test(text[run.index + run[0].length] ?? "")) marks.push(...phonesIn(run[0], run.index, ids));
    }
    const tokens = tokensOf(text);
    const people = marks.filter((mark) => mark.type === "person");
    const found = [...cuedNames(text, cueTable, tokens), ...extended(text, tokens, people, plain, notPeople, fuller), ...listed(text, tokens, people, alone, plain, place)];
    return united(text, marks, found, held.map, phrases.map, notPeople, place);
  }
  if (lists === BUNDLED) compiled = { table, version: table.version, matcher };
  return matcher;
}

function listed(text: string, tokens: readonly Token[], people: readonly Mark[], alone: (word: string) => boolean, plain: (word: string) => boolean, place: (phrase: string) => boolean): { start: number; end: number }[] {
  const at = indexer(tokens);
  const held = new Set<Token>();
  for (const mark of people) {
    for (let k = at(mark.start); k !== -1 && k < tokens.length && tokens[k]!.start < mark.end; k += 1) held.add(tokens[k]!);
  }
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token.kind !== "title" || held.has(token) || !alone(token.word)) continue;
    if (isFaith(token.word) && !besideName(text, tokens, i, alone)) continue;
    const end = runAt(text, tokens, i, (each) => each === token || (!held.has(each) && (each.kind === "initial" || !plainish(each.word, plain))), 4, true);
    const run = fold(text.slice(token.start, tokens[end - 1]!.end));
    const before = tokens[i - 1];
    if (place(run) || (before !== undefined && before.kind === token.kind && gap(text, before.end, token.start) && place(`${fold(before.word)} ${run}`))) continue;
    out.push({ start: token.start, end: tokens[end - 1]!.end });
  }
  return out;
}

function besideName(text: string, tokens: readonly Token[], i: number, alone: (word: string) => boolean): boolean {
  const token = tokens[i]!;
  const near = (other: Token | undefined, from: number, to: number) => other !== undefined && other.kind === token.kind && gap(text, from, to);
  const before = tokens[i - 1];
  if (near(before, before?.end ?? 0, token.start) && isFaith(before!.word)) return false;
  const after = tokens[i + 1];
  const name = (other: Token) => alone(other.word) && !isFaith(other.word);
  return (near(after, token.end, after?.start ?? 0) && name(after!)) || (near(before, before?.end ?? 0, token.start) && name(before!));
}

const TITLE = /^\p{Lu}\p{Ll}/u;
const SHOUTED = /^\p{Lu}{2,}$/u;

function standsAlone(text: string, start: number, end: number, form: Hit["form"], plain: (word: string) => boolean, given: (word: string) => boolean): boolean {
  if (form === undefined) return true;
  const word = text.slice(start, end);
  if (SHOUTED.test(word)) return true;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(Math.max(lineStart, start - 200), start);
  let from = 0;
  for (const stop of before.matchAll(SENTENCE_END)) from = stop.index + stop[0].length;
  const sentence = before.slice(from);
  if (AFTER_ARTICLE.test(sentence)) return false;
  if (form !== "unshouted" || !WRITTEN_SMALL.test(word)) return true;
  const joined = [JOINED_BEFORE.exec(before)?.[1], JOINED_AFTER.exec(text.slice(end, end + 40))?.[1]];
  if (joined.some((other) => other !== undefined && [...other].length >= 2 && plainish(other, plain) && !given(other) && !isFamilyWord(other))) return false;
  return !CAPITALISED.test(sentence.replace(FIRST_WORD, ""));
}

const WRITTEN_SMALL = /^\p{Ll}+$/u;
const SENTENCE_END = /[.!?:][ \t]+/gu;
const CAPITALISED = /(?<![\p{L}\p{N}])(?!I(?![\p{L}]))\p{Lu}/u;
const FIRST_WORD = /^[^\p{L}\p{N}]*[\p{L}\p{N}'’]+/u;
const AFTER_ARTICLE = /(?<![\p{L}\p{N}'’])(?:[aA]n?|[tT]he)(?:[ \t]+\p{Ll}[\p{Ll}-]*){0,3}[ \t]+$/u;
const JOINED_BEFORE = /(\p{L}+)_$/u;
const JOINED_AFTER = /^_(\p{L}+)/u;

function writtenAs(word: string, form: Hit["form"]): boolean {
  if (form === "title") return TITLE.test(word);
  if (form === "unshouted") return !SHOUTED.test(word);
  return true;
}

interface Span {
  start: number;
  end: number;
  other?: true;
}

function extended(text: string, tokens: readonly Token[], people: readonly Mark[], plain: (word: string) => boolean, notPeople: ReadonlySet<string>, fuller: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>): Span[] {
  const at = indexer(tokens);
  const starts = new Map(people.filter((mark) => mark.who !== undefined).map((mark) => [mark.start, mark.who]));
  const out: Span[] = [];
  for (const person of people) {
    const last = at(person.end, true);
    if (last === -1 || tokens[last]!.end !== person.end || tokens[last]!.start < person.start) continue;
    const written = tokens[last]!;
    if (written.kind !== "title" && written.kind !== "caps") continue;
    const next = last + 1;
    if (next >= tokens.length || !gap(text, written.end, tokens[next]!.start)) continue;
    const take = (token: Token) => alike(token, written) && (starts.get(token.start) ?? person.who) === person.who && !notPeople.has(fold(token.word)) && !ORGANISATIONS.has(fold(token.word)) && !PLACES.has(fold(token.word)) && (token.kind === "initial" || !plainish(token.word, plain) || (surname(token.word) && inSentence(text, tokens, at(person.start), at(token.start))));
    const end = runAt(text, tokens, next, take, 3, true);
    if (end <= next) continue;
    const goesOn = person.who === undefined ? undefined : fuller.get(person.who)?.get(fold(written.word));
    const after = tokens[next]!;
    const theirs = goesOn === undefined || (after.kind === "initial" ? [...goesOn].some((word) => word.startsWith(fold(after.word))) : goesOn.has(fold(after.word)));
    out.push({ start: person.start, end: tokens[end - 1]!.end, ...(theirs ? {} : { other: true as const }) });
  }
  return out;
}

function surname(word: string): boolean {
  return isFamilyWord(word) && !PREDICATE_STARTS.has(fold(word));
}

function inSentence(text: string, tokens: readonly Token[], first: number, k: number): boolean {
  const token = tokens[k]!;
  if (token.kind !== "title") return false;
  const before = tokens[first - 1];
  if (before !== undefined && /^[ \t]+$/u.test(text.slice(before.end, tokens[first]!.start)) && before.kind !== "other" && !/['’]/u.test(before.word)) return false;
  const after = tokens[k + 1];
  const between = text.slice(token.end, after?.start ?? text.length);
  if (after === undefined || /\n/u.test(between)) return true;
  if (/^[ \t]+$/u.test(between)) return after.kind === "other" && /^\p{Ll}/u.test(after.word);
  return /^[,.;:!?()'’]/u.test(between);
}

function inHost(text: string, start: number, end: number): boolean {
  if (!((text[start - 1] === "." && /[\p{L}\p{N}]/u.test(text[start - 2] ?? "")) || (text[end] === "." && /[\p{L}\p{N}]/u.test(text[end + 1] ?? "")))) return false;
  const after = /^\S*/u.exec(text.slice(end))![0];
  return !after.includes("@");
}

function holder(): { map: Map<string, Hit>; add: (key: string, hit: Hit, ownName?: boolean) => void } {
  const map = new Map<string, Hit>();
  const owned = new Set<string>();
  return {
    map,
    add(key, hit, ownName = false) {
      if (owned.has(key)) return;
      const was = map.get(key);
      if (hit.none === true && was !== undefined) return;
      if (was?.none === true) {
        map.set(key, hit);
        if (ownName) owned.add(key);
        return;
      }
      if (ownName) owned.add(key);
      if (was === undefined || ownName) map.set(key, hit);
      else if (was.who !== hit.who) map.set(key, { type: was.type, ...(was.form === undefined ? {} : { form: was.form }) });
    },
  };
}

function united(text: string, marks: Mark[], found: readonly Span[], held: ReadonlyMap<string, Hit>, phrases: ReadonlyMap<string, Hit>, notPeople: ReadonlySet<string>, place: (phrase: string) => boolean): Mark[] {
  const ids = marks.filter((mark) => mark.type !== "person").sort((a, b) => a.start - b.start);
  const reach: number[] = [];
  for (const [index, id] of ids.entries()) reach.push(Math.max(id.end, reach[index - 1] ?? 0));
  const free = (span: { start: number; end: number }) => {
    let low = 0;
    let high = ids.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (ids[mid]!.start < span.end) low = mid + 1;
      else high = mid;
    }
    return low === 0 || reach[low - 1]! <= span.start;
  };
  const spans: { mark: Mark; found?: true; other?: true }[] = [
    ...marks.filter((mark) => mark.type === "person").map((mark) => ({ mark })),
    ...found.filter((span) => free(span) && !notPeople.has(fold(text.slice(span.start, span.end)))).map((span) => ({ mark: { start: span.start, end: span.end, type: "person" } as Mark, found: true as const, ...(span.other === true ? { other: true as const } : {}) })),
  ];
  spans.sort((a, b) => a.mark.start - b.mark.start || b.mark.end - a.mark.end);
  const out: Mark[] = [...ids];
  for (let at = 0; at < spans.length;) {
    let end = spans[at]!.mark.end;
    let next = at + 1;
    while (next < spans.length && spans[next]!.mark.start < end) end = Math.max(end, spans[next]!.mark.end), (next += 1);
    const group = spans.slice(at, next);
    const start = spans[at]!.mark.start;
    const tables = group.filter((each) => each.found !== true);
    const whole = tables.find((each) => each.mark.start === start && each.mark.end === end);
    const first = tables.find((each) => each.mark.start === start)?.mark;
    const alone = first?.who !== undefined && tables.every((each) => each.mark.who === undefined || each.mark.who === first.who) && !group.some((each) => each.other === true && each.mark.start === start);
    if (whole?.mark.shown === undefined && noPerson(text, start, end, place)) {
      at = next;
      continue;
    }
    if (whole !== undefined) out.push(whole.mark);
    else if (alone) out.push({ start, end, type: "person", who: first!.who! });
    else {
      const key = fold(text.slice(start, end));
      const named = phrases.get(key);
      const hit = held.get(key) ?? (named?.type === "person" && named.none !== true && named.shown === undefined && (key.match(WORD) ?? []).length === 1 ? named : undefined);
      out.push({ start, end, type: "person", ...(hit?.who === undefined ? {} : { who: hit.who }) });
    }
    at = next;
  }
  return out;
}

const DEITY = new Set(["lord", "god", "goddess"]);

const SPACED = /\s/u;
const SMALL = /\p{Ll}/u;
const CAPITAL = /^\p{Lu}/u;
const LAST_WORD = /\p{L}+$/u;
const PRIOR = /(?<![\p{L}\p{M}\p{N}])(\p{L}[\p{L}\p{M}]*)[ \t]$/u;
const FOLLOWING = /^[ \t](\p{L}[\p{L}\p{M}]*)(?![\p{L}\p{M}\p{N}])/u;
const NEXT_WORD = /^([ \t]*&[ \t]*|[ \t])(\p{L}+)/u;
const BEFORE_WORD = /(\p{L}+)[ \t]+(?:(of|OF)[ \t]+)?$/u;
const CODE_JOIN = /(?:\p{N}-|[\p{L}\p{N}]\*)$/u;

function noPerson(text: string, start: number, end: number, place: (phrase: string) => boolean): boolean {
  const word = text.slice(start, end);
  const caps = !SMALL.test(word);
  const last = LAST_WORD.exec(word)?.[0].toLowerCase() ?? "";
  if (SPACED.test(word) && (ORGANISATIONS.has(last) || PLACES.has(last))) return true;
  const words = (fold(word).match(WORD) ?? []).join(" ");
  if (words.includes(" ") && place(words)) return true;
  const spaceBefore = start > 0 && (text[start - 1] === " " || text[start - 1] === "\t");
  const spaceAfter = text[end] === " " || text[end] === "\t";
  const prior = spaceBefore ? PRIOR.exec(text.slice(Math.max(0, start - 30), start)) : null;
  if (prior !== null && alikeWritten(prior[1]!, word) && place(`${fold(prior[1]!)} ${words}`)) return true;
  const following = spaceAfter ? FOLLOWING.exec(text.slice(end, end + 30)) : null;
  if (following !== null && alikeWritten(following[1]!, word) && place(`${words} ${fold(following[1]!)}`)) return true;
  const next = spaceAfter || text[end] === "&" ? NEXT_WORD.exec(text.slice(end, end + 30)) : null;
  if (next !== null && CAPITAL.test(next[2]!) && (caps === !SMALL.test(next[2]!) || next[1]!.includes("&"))) {
    const after = next[2]!.toLowerCase();
    if (ORGANISATIONS.has(after) || PLACES.has(after)) return true;
  }
  const before = spaceBefore ? BEFORE_WORD.exec(text.slice(Math.max(0, start - 30), start)) : null;
  if (before !== null) {
    const was = before[1]!.toLowerCase();
    if (before[2] !== undefined && OF.has(was) && CAPITAL.test(before[1]!)) return true;
    if (before[2] === undefined && DEITY.has(was) && CAPITAL.test(before[1]!)) return true;
  }
  if ((text[start - 1] === "-" || text[start - 1] === "*") && CODE_JOIN.test(text.slice(Math.max(0, start - 2), start))) return true;
  return false;
}

function alikeWritten(word: string, name: string): boolean {
  return CAPITAL.test(word) && CAPITAL.test(name) && !SMALL.test(word) === !SMALL.test(name);
}

export function phonesIn(run: string, at: number, ids: ReadonlyMap<string, string | null>, tried?: { spans: number }): Mark[] {
  let all = 0;
  for (let index = 0; index < run.length && all < 7; index += 1) if (run.charCodeAt(index) >= 0x30 && run.charCodeAt(index) <= 0x39) all += 1;
  if (all < 7) return [];
  const groups = [...run.matchAll(GROUP)].map((group) => {
    const digits = group[0].replace(/\D/gu, "");
    return { start: group.index, end: group.index + group[0].length, digits: digits.length, spelled: digits };
  });
  const marks: Mark[] = [];
  for (let first = 0; first < groups.length;) {
    let reach = first - 1;
    for (let digits = 0; reach + 1 < groups.length && digits + groups[reach + 1]!.digits <= 15; reach += 1) digits += groups[reach + 1]!.digits;
    let digits = 0;
    for (let last = first; last <= reach; last += 1) digits += groups[last]!.digits;
    let taken = 0;
    for (let last = reach; last >= first; digits -= groups[last]!.digits, last -= 1) {
      if (tried !== undefined) tried.spans += 1;
      if (digits < 7) break;
      let start = groups[first]!.start;
      let end = groups[last]!.end;
      let joined = "";
      for (let group = first; group <= last; group += 1) joined += groups[group]!.spelled;
      const who = ids.get(`phone:${foldDetail("phone", joined)}`);
      if (who === undefined) continue;
      const spelled = run.slice(start, end);
      const opened = (spelled.match(/\(/gu) ?? []).length - (spelled.match(/\)/gu) ?? []).length;
      if (opened > 0 && run[start] === "(") start += 1;
      if (opened < 0 && run[end - 1] === ")") end -= 1;
      marks.push({ start: at + start, end: at + end, type: "phone", ...(who === null ? {} : { who }) });
      taken = last - first + 1;
      break;
    }
    first += Math.max(taken, 1);
  }
  return marks;
}

function handleKey(who: string): string | null {
  const colon = who.indexOf(":");
  return idKey(PREFIXED.has(who.slice(0, colon)) ? who.slice(colon + 1) : who);
}

function idKey(id: string): string | null {
  const type = idType(id);
  if (type === "email") return `email:${canonicalEmail(id)}`;
  if (type === "phone") {
    const phone = phoneOfJid(id) ?? id;
    return /\d/u.test(phone) ? `phone:${foldDetail("phone", phone)}` : null;
  }
  const name = fold(id.replace(/^@/u, ""));
  return name === "" ? null : `account:${name}`;
}
