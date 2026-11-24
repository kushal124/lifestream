import { canonical, DETAIL_TYPES, DETAIL_WORDS, hides, isDetailType, TYPES, type DetailType, type Json, type Level, type Type } from "@lifestreamprotocol/core";
import { AccessError, parseAccess, resolve, widens, type Access, type Allow, type DraftAccess, type DraftAllow, type End, type Reach, type Window } from "@lifestreamprotocol/privacy";
import { emptyAccess, type Existing } from "./access.js";
import { capital, differenceOf, hideChoiceWords, kindReads, limitWords, listed, readsShort, SCREEN, seesOf, summaryOf, widenedWords, type Bolded, type KindReads, type Words } from "./access-words.js";


export type Version = number;
export type Switch = "on" | "off" | "some";
export type HideChoice = "names" | "all" | "none" | "custom";
export type Mode = "but" | "only";

export type Edit =
  | { mode: Mode }
  | { window: Window }
  | { type: Type; on: boolean }
  | { type: Type; window: Window }
  | { account: string; on: boolean }
  | { account: string; window: Window }
  | { hide: HideChoice }
  | { detail: DetailType; hidden: boolean };

export interface Limit {
  value: { window: Window } | { mixed: true };
  words: string;
}

export type DetailState = "hidden" | "shown" | "fixed";

export type Time = { choice: "all" | "since"; window: null; words: string } | { choice: "past"; window: { past_ms: number }; words: string };

export interface AccessView {
  sentence: Bolded;
  summary: string;
  reads: string;
  mode: Mode;
  modes: { mode: Mode; words: string }[];
  mode_line: string;
  window: Limit;
  times: Time[];
  categories: {
    type: Type; name: string; icon: string; line: string | null; state: Switch; limit: Limit | null; reads: KindReads | null; differs: string | null;
    accounts: { account: string; name: string; line: string | null; state: Switch; limit: Limit | null }[];
  }[];
  hide: {
    choice: HideChoice; words: string;
    choices: HideOption[];
    types: { type: DetailType; name: string; state: DetailState; subtypes: { type: DetailType; name: string; state: DetailState }[] }[];
  } | null;
  widens: boolean;
  widening: Bolded | null;
  screen: string | null;
}

export interface HideOption {
  level: HideChoice;
  words: string;
  line: string | null;
  selected: boolean;
}

export type ReadsByKind = Partial<Record<Type, number>>;

export interface EditorAccount extends Existing {
  name: string;
  line: string | null;
  screen: boolean;
}

export interface EditorSources {
  accounts: readonly EditorAccount[];
}

export interface EditorReader {
  name: string;
  zone: string;
  chat: boolean;
}

export class EditError extends Error {
  override name = "EditError";
}

const DAY_MS = 24 * 3_600_000;
const MODES: readonly { mode: Mode; words: string; line: string }[] = [
  { mode: "but", words: "Everything but", line: "Everything you leave checked, and new connectors as you add them." },
  { mode: "only", words: "Only these", line: "Only what you check, nothing new." },
];
const OPEN: Pick<Allow, "reach"> = { reach: { all: true, but: [] } };
const HOUR_MS = 3_600_000;
const TIMES: Time[] = [
  { choice: "all", window: null, words: "All time" },
  ...([[365 * DAY_MS, "Past year"], [30 * DAY_MS, "Past 30 days"], [7 * DAY_MS, "Past 7 days"], [DAY_MS, "Past 24 hours"], [HOUR_MS, "Past hour"]] as const)
    .map(([past_ms, words]): Time => ({ choice: "past", window: { past_ms }, words })),
  { choice: "since", window: null, words: "Since a date…" },
];
const HIDE_LINES: Readonly<Record<HideChoice, string | null>> = {
  none: "It sees names, numbers and addresses as they are",
  names: "Phone numbers, addresses and account numbers are blanks",
  all: "People are “a person”, and the details are blanks",
  custom: null,
};
const HIDE_CHOICES: readonly { level: HideChoice; words: string }[] = [
  ...(["none", "names", "all"] as const).map((level) => ({ level, words: hideChoiceWords(level) })),
  { level: "custom", words: "Choose…" },
];
const DETAIL_NAMES: Partial<Record<DetailType, string>> = { word: "Words you listed", "number.government": "ID numbers", "number.tax": "Tax IDs" };
const TYPE_ORDER = Object.keys(TYPES) as Type[];

export function applyEdit(access: Access, edit: Edit, sources: EditorSources, now_ms: number): Access;
export function applyEdit(access: DraftAccess, edit: Edit, sources: EditorSources, now_ms: number): DraftAccess;
export function applyEdit(access: DraftAccess, edit: Edit, sources: EditorSources, now_ms: number): DraftAccess {
  const home = homeOf(sources);
  if ("mode" in edit) return { ...access, allow: tidy(edit.mode === "only" ? onlyThese(access.allow, home, now_ms) : everythingBut(access.allow, home, now_ms)) };
  if ("type" in edit) {
    if ("on" in edit && edit.on) return { ...access, allow: tidy(typeOn(access.allow, edit.type, home, now_ms)) };
    const type = edit.type;
    if ("on" in edit) return { ...access, allow: tidy(typeOff(access.allow, type, home, now_ms)) };
    if (stateOfType(access.allow, type, home, now_ms) === "off") throw new EditError(turnOnWords(TYPES[type].name));
    return { ...access, allow: tidy(typeWindow(access.allow, type, edit.window, home, now_ms)) };
  }
  if ("account" in edit) {
    const account = home.account(edit.account);
    if ("on" in edit && edit.on) return { ...access, allow: tidy(accountOn(access.allow, account, now_ms)) };
    if ("on" in edit) return { ...access, allow: tidy(accountOff(access.allow, account, home, now_ms)) };
    if (stateOfAccount(access.allow, account, now_ms) === "off") throw new EditError(turnOnWords(account.name));
    return { ...access, allow: tidy(accountWindow(access.allow, account, edit.window, home, now_ms)) };
  }
  if ("window" in edit) return { ...access, window: edit.window };
  if ("hide" in edit) return { ...access, hide: edit.hide === "custom" ? customOf(access.hide) : edit.hide };
  return { ...access, hide: detailEdit(access.hide, edit.detail, edit.hidden) };
}

function turnOnWords(name: string): string {
  return `Turn ${name} on to set how far back.`;
}

export function viewOf(access: DraftAccess, saved: Access | null, sources: EditorSources, now_ms: number, reader: EditorReader, reads: ReadsByKind | null = null): AccessView {
  const home = homeOf(sources);
  const words = wordsOf(home, reader.zone);
  const allow = access.allow;
  const categories = TYPE_ORDER.filter((type) => home.of(type).length > 0).map((type) => {
    const accounts = home.of(type).map((account) => ({
      account: account.account, name: account.name, line: account.line, state: stateOfAccount(allow, account, now_ms),
      limit: limitOf(allow.filter((grant) => live(grant, now_ms) && touchesAccount(grant.reach, account)), reader.zone),
    }));
    const state = stateOfType(allow, type, home, now_ms);
    const off = accounts.filter((account) => account.state === "off").map((account) => account.name);
    const part = accounts.filter((account) => account.state === "some").map((account) => `part of ${account.name}`);
    const limit = limitOf(allow.filter((grant) => live(grant, now_ms) && home.of(type).some((account) => touchesAccount(grant.reach, account))), reader.zone);
    return {
      type, name: TYPES[type].name, icon: TYPES[type].icon, state, accounts,
      line: state === "some" ? `${capital(listed([...off, ...part]))} not read` : null,
      limit,
      reads: reads === null ? null : kindReads(reads[type] ?? 0),
      differs: differsOf(accounts.map((account) => account.state !== "off"), limit, access.window),
    };
  });
  const effective = effectiveHidden(access.hide);
  const resolved = resolve(access, now_ms);
  const wider = saved === null || widens(saved, resolved, sources.accounts);
  return {
    sentence: seesOf(access, reader.name, words, { accounts: sources.accounts, now_ms, chat: reader.chat }),
    summary: summaryOf(access, words, { accounts: sources.accounts, now_ms, chat: reader.chat }),
    reads: readsShort(access, words, { accounts: sources.accounts, now_ms, chat: reader.chat }),
    mode: modeOf(allow, now_ms),
    modes: MODES.map(({ mode, words: modeWords }) => ({ mode, words: modeWords })),
    mode_line: MODES.find(({ mode }) => mode === modeOf(allow, now_ms))!.line,
    window: limitOf([{ reach: OPEN.reach, window: access.window, until_ms: null }], reader.zone)!,
    times: TIMES,
    categories,
    hide: reader.chat ? null : {
      choice: choiceOf(access.hide), words: hideChoiceWords(access.hide),
      choices: HIDE_CHOICES.map(({ level, words: choiceWords }) => ({ level, words: choiceWords, line: HIDE_LINES[level], selected: level === choiceOf(access.hide) })),
      types: DETAIL_WORDS.map((row) => ({
        type: row.type, name: DETAIL_NAMES[row.type] ?? capital(row.many), state: effective.has(row.type) ? "hidden" as const : "shown" as const,
        subtypes: row.subtypes.map((sub) => ({ type: sub.type, name: DETAIL_NAMES[sub.type] ?? capital(sub.many), state: effective.has(row.type) ? "fixed" as const : effective.has(sub.type) ? "hidden" as const : "shown" as const })),
      })),
    },
    widens: wider,
    widening: saved !== null && wider ? widenedWords(reader.name, differenceOf(saved, resolved, sources.accounts), words) : null,
    screen: screenReached(access, home, now_ms) && (saved === null || !screenReached(saved, home, now_ms)) ? SCREEN : null,
  };
}

export function reachesScreen(access: DraftAccess, sources: EditorSources, now_ms: number): boolean {
  return screenReached(access, homeOf(sources), now_ms);
}

function screenReached(access: DraftAccess, home: Home, now_ms: number): boolean {
  return home.all.some((account) => account.screen && stateOfAccount(access.allow, account, now_ms) !== "off");
}

export function parseEdit(value: unknown): Edit {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EditError("an edit is an object");
  const edit = value as Record<string, unknown>;
  const keys = Object.keys(edit).sort().join(",");
  const on = () => bool(edit.on, "on");
  switch (keys) {
    case "mode": return MODES.some((each) => each.mode === edit.mode) ? { mode: edit.mode as Mode } : fail("mode is but or only");
    case "window": return { window: windowOf(edit.window) };
    case "on,type": return { type: typeOf(edit.type), on: on() };
    case "type,window": return { type: typeOf(edit.type), window: windowOf(edit.window) };
    case "account,on": return { account: text(edit.account, "account"), on: on() };
    case "account,window": return { account: text(edit.account, "account"), window: windowOf(edit.window) };
    case "hide": return ["names", "all", "none", "custom"].includes(edit.hide as string) ? { hide: edit.hide as HideChoice } : fail("hide is names, all, none or custom");
    case "detail,hidden": return { detail: detailOf(edit.detail), hidden: bool(edit.hidden, "hidden") };
    default: return fail(`an edit has no members ${keys === "" ? "(none)" : keys}`);
  }
}


interface Home {
  readonly all: readonly EditorAccount[];
  of(type: Type): readonly EditorAccount[];
  readonly bare: readonly EditorAccount[];
  find(account: string): EditorAccount | undefined;
  account(account: string): EditorAccount;
}

function homeOf(sources: EditorSources): Home {
  const by = new Map(sources.accounts.map((account) => [account.account, account] as const));
  return {
    all: sources.accounts,
    of: (type) => sources.accounts.filter((account) => account.category === type),
    bare: sources.accounts.filter((account) => account.category === null),
    find: (account) => by.get(account),
    account(account) {
      const found = by.get(account);
      if (found === undefined) throw new EditError(`${account} isn’t connected anymore.`);
      if (found.category === null) throw new EditError(`${account} has no category: the editor does not offer it`);
      return found;
    },
  };
}


function live(entry: End, now_ms: number): boolean {
  return "lasts_ms" in entry || entry.until_ms === null || now_ms < entry.until_ms;
}

function touchesAccount(reach: Reach, account: Existing): boolean {
  if ("all" in reach) return reach.but.length === 0 || (account.category !== null && !reach.but.includes(account.category));
  if ("type" in reach) return account.category === reach.type && !reach.but.includes(account.account);
  return reach.account === account.account;
}

function stateOfAccount(allow: readonly DraftAllow[], account: Existing, now_ms: number): Switch {
  return allow.some((grant) => live(grant, now_ms) && touchesAccount(grant.reach, account)) ? "on" : "off";
}

function stateOfType(allow: readonly DraftAllow[], type: Type, home: Home, now_ms: number): Switch {
  const states = home.of(type).map((account) => stateOfAccount(allow, account, now_ms));
  if (states.length > 0 && states.every((state) => state === "on")) return "on";
  if (states.every((state) => state === "off")) {
    return states.length === 0 && allow.some((grant) => live(grant, now_ms) && opensType(grant.reach, type)) ? "on" : "off";
  }
  return "some";
}

function opensType(reach: Reach, type: Type): boolean {
  return ("all" in reach && !reach.but.includes(type)) || ("type" in reach && reach.type === type);
}

function opensNew(allow: readonly DraftAllow[], now_ms: number): boolean {
  return allow.some((grant) => live(grant, now_ms) && ("all" in grant.reach || "type" in grant.reach) && TYPE_ORDER.some((type) => opensType(grant.reach, type)));
}

function differsOf(reading: readonly boolean[], limit: Limit | null, window: Window): string | null {
  if (reading.length > 1) {
    const on = reading.filter(Boolean).length;
    return on === reading.length ? `${reading.length} accounts` : `${on} of ${reading.length} accounts`;
  }
  if (limit === null) return null;
  if ("mixed" in limit.value) return limit.words;
  return same(limit.value.window, null) || same(limit.value.window, window) ? null : limit.words;
}

function limitOf(grants: readonly DraftAllow[], zone: string): Limit | null {
  if (grants.length === 0) return null;
  const windows = unique(grants.map((grant) => grant.window));
  return { value: windows.length === 1 ? { window: windows[0]! } : { mixed: true }, words: limitWords(grants.map(limitsOf), zone) };
}


type Rewrite = (grant: DraftAllow) => DraftAllow[] | null;

function rewrite(allow: readonly DraftAllow[], now_ms: number, change: Rewrite): DraftAllow[] {
  return allow.flatMap((grant) => (live(grant, now_ms) ? change(grant) ?? [grant] : [grant]));
}

function allWithout(grant: DraftAllow, type: Type, home: Home): DraftAllow[] {
  const reach = grant.reach as Extract<Reach, { all: true }>;
  return [
    { ...grant, reach: { all: true, but: [...reach.but, type] } },
    ...(reach.but.length === 0 ? home.bare.map((account): DraftAllow => ({ ...grant, reach: { account: account.account, but: [] } })) : []),
  ];
}

function typeOff(allow: readonly DraftAllow[], type: Type, home: Home, now_ms: number): DraftAllow[] {
  return rewrite(allow, now_ms, (grant) => {
    const reach = grant.reach;
    if ("all" in reach) return reach.but.includes(type) ? null : allWithout(grant, type, home);
    if ("type" in reach) return reach.type === type ? [] : null;
    return home.find(reach.account)?.category === type ? [] : null;
  });
}

function accountOff(allow: readonly DraftAllow[], account: EditorAccount, home: Home, now_ms: number): DraftAllow[] {
  const type = account.category!;
  return rewrite(allow, now_ms, (grant) => {
    const reach = grant.reach;
    if (!touchesAccount(reach, account)) return null;
    if ("all" in reach) return [...allWithout(grant, type, home), { ...grant, reach: { type, but: [account.account] } }];
    if ("type" in reach) return [{ ...grant, reach: { type, but: [...reach.but, account.account] } }];
    return [];
  });
}

type Limits = { window: Window } & End;
const ALWAYS: Limits = { window: null, until_ms: null };

function limitsOf(grant: DraftAllow): Limits {
  return "lasts_ms" in grant ? { window: grant.window, lasts_ms: grant.lasts_ms } : { window: grant.window, until_ms: grant.until_ms };
}

function typeOn(allow: readonly DraftAllow[], type: Type, home: Home, now_ms: number): DraftAllow[] {
  const accounts = home.of(type);
  const state = (account: EditorAccount) => stateOfAccount(allow, account, now_ms);
  if (accounts.length > 0 && accounts.every((account) => state(account) === "on")) return [...allow];
  const oneByOne = () => accounts.reduce((next, account) => accountOn(next, account, now_ms), [...allow]);
  const grants = allow.filter((grant) => live(grant, now_ms));
  if (grants.some((grant) => "type" in grant.reach && grant.reach.type === type)) return oneByOne();
  const touched = accounts.filter((account) => state(account) !== "off");
  const typed = (limits: readonly Limits[], next: DraftAllow[]) => [...next, ...limits.map((each): DraftAllow => ({ reach: { type, but: touched.map((account) => account.account) }, ...each }))];
  const leaving = grants.filter((grant) => "all" in grant.reach && grant.reach.but.includes(type));
  if (leaving.length > 0) {
    const lift = new Set(touched.length === 0 ? leaving.filter((grant) => (grant.reach as { but: Type[] }).but.length > 1) : []);
    const lifted = rewrite(allow, now_ms, (grant) => (lift.has(grant) ? [{ ...grant, reach: { all: true, but: (grant.reach as { but: Type[] }).but.filter((each) => each !== type) } }] : null));
    const beside = leaving.filter((grant) => !lift.has(grant)).map(limitsOf);
    return beside.length === 0 ? lifted : typed(beside, lifted);
  }
  return opensNew(allow, now_ms) ? typed([ALWAYS], [...allow]) : oneByOne();
}

function accountOn(allow: readonly DraftAllow[], account: EditorAccount, now_ms: number): DraftAllow[] {
  if (stateOfAccount(allow, account, now_ms) === "on") return [...allow];
  const leaving = allow.filter((grant) => live(grant, now_ms) && "type" in grant.reach && grant.reach.type === account.category && grant.reach.but.includes(account.account));
  if (leaving.length > 0) {
    return rewrite(allow, now_ms, (grant) => (leaving.includes(grant) ? [{ ...grant, reach: { type: account.category!, but: (grant.reach as { but: string[] }).but.filter((each) => each !== account.account) } }] : null));
  }
  return [...allow, { reach: { account: account.account, but: [] }, ...ALWAYS }];
}

function typeWindow(allow: readonly DraftAllow[], type: Type, window: Window, home: Home, now_ms: number): DraftAllow[] {
  return rewrite(allow, now_ms, (grant) => {
    const reach = grant.reach;
    if ("all" in reach) return reach.but.includes(type) ? null : [...allWithout(grant, type, home), { reach: { type, but: [] }, ...limitsOf(grant), window }];
    if ("type" in reach) return reach.type === type ? [{ ...grant, window }] : null;
    return home.find(reach.account)?.category === type ? [{ ...grant, window }] : null;
  });
}

function accountWindow(allow: readonly DraftAllow[], account: EditorAccount, window: Window, home: Home, now_ms: number): DraftAllow[] {
  const type = account.category!;
  const own = (grant: DraftAllow): DraftAllow => ({ reach: { account: account.account, but: [] }, ...limitsOf(grant), window });
  return rewrite(allow, now_ms, (grant) => {
    const reach = grant.reach;
    if (!touchesAccount(reach, account)) return null;
    if ("all" in reach) return [...allWithout(grant, type, home), { ...grant, reach: { type, but: [account.account] } }, own(grant)];
    if ("type" in reach) return [{ ...grant, reach: { type, but: [...reach.but, account.account] } }, own(grant)];
    return [{ ...grant, window }];
  });
}

function modeOf(allow: readonly DraftAllow[], now_ms: number): Mode {
  return allow.some((grant) => live(grant, now_ms) && "all" in grant.reach) ? "but" : "only";
}

function onlyThese(allow: readonly DraftAllow[], home: Home, now_ms: number): DraftAllow[] {
  return rewrite(allow, now_ms, (grant) => {
    const reach = grant.reach;
    if (!("all" in reach)) return null;
    const types = TYPE_ORDER.filter((type) => home.of(type).length > 0 && !reach.but.includes(type));
    return [
      ...types.map((type): DraftAllow => ({ ...grant, reach: { type, but: [] } })),
      ...(reach.but.length === 0 ? home.bare.map((account): DraftAllow => ({ ...grant, reach: { account: account.account, but: [] } })) : []),
    ];
  });
}

function everythingBut(allow: readonly DraftAllow[], home: Home, now_ms: number): DraftAllow[] {
  if (modeOf(allow, now_ms) === "but") return [...allow];
  const whole = (type: Type): Limits | null => {
    const touching = allow.filter((grant) => live(grant, now_ms) && home.of(type).some((account) => touchesAccount(grant.reach, account)));
    if (touching.length !== 1) return null;
    const reach = touching[0]!.reach;
    return "type" in reach && reach.but.length === 0 ? limitsOf(touching[0]!) : null;
  };
  const groups = new Map<string, { limits: Limits; types: Type[] }>();
  for (const type of TYPE_ORDER.filter((each) => home.of(each).length > 0)) {
    const limits = whole(type);
    if (limits === null) continue;
    const key = JSON.stringify(limits);
    groups.set(key, { limits, types: [...groups.get(key)?.types ?? [], type] });
  }
  const largest = [...groups.values()].sort((a, b) => b.types.length - a.types.length)[0] ?? { limits: ALWAYS, types: [] };
  const folded = new Set(largest.types);
  const kept = allow.filter((grant) => !(live(grant, now_ms) && "type" in grant.reach && folded.has(grant.reach.type)));
  const but = TYPE_ORDER.filter((type) => home.of(type).length > 0 && !folded.has(type));
  return [{ reach: { all: true, but }, ...largest.limits }, ...kept];
}

function tidy(allow: readonly DraftAllow[]): DraftAllow[] {
  const seen = new Set<string>();
  return allow.map(sorted).filter((grant) => {
    const key = canonical(grant as unknown as Json);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sorted(grant: DraftAllow): DraftAllow {
  const reach = grant.reach;
  if ("all" in reach) return { ...grant, reach: { all: true, but: TYPE_ORDER.filter((type) => reach.but.includes(type)) } };
  if ("type" in reach) return { ...grant, reach: { type: reach.type, but: [...new Set(reach.but)].sort() } };
  return grant;
}

function effectiveHidden(level: Level): Set<DetailType> {
  if (typeof level !== "string") return new Set(level);
  return new Set(DETAIL_WORDS.map((row) => row.type).filter((type) => hides(level, type)));
}

function customOf(level: Level): Level {
  const hidden = effectiveHidden(level);
  return hidden.size === 0 ? "none" : DETAIL_TYPES.filter((type) => hidden.has(type));
}

function detailEdit(level: Level, type: DetailType, hidden: boolean): Level {
  const set = effectiveHidden(level);
  const dot = type.indexOf(".");
  if (dot !== -1) {
    if (set.has(type.slice(0, dot) as DetailType)) throw new EditError(`${type} is fixed: its type is hidden`);
    if (hidden) set.add(type);
    else set.delete(type);
  } else {
    for (const each of [...set]) if (each.startsWith(`${type}.`)) set.delete(each);
    if (hidden) set.add(type);
    else set.delete(type);
  }
  return set.size === 0 ? "none" : DETAIL_TYPES.filter((each) => set.has(each));
}

function choiceOf(level: Level): HideChoice {
  return typeof level === "string" ? level : "custom";
}

export function personWords(sources: EditorSources, zone: string): Words {
  return wordsOf(homeOf(sources), zone);
}

export function agentWords(sources: EditorSources, zone: string): Words {
  const home = homeOf(sources);
  const product = (account: string) => account.slice(0, account.indexOf(":"));
  return {
    account: (account) => home.find(account)?.name ?? product(account),
    product: (name) => home.all.find((each) => product(each.account) === name)?.name ?? name,
    address: () => null,
    zone,
  };
}

function wordsOf(home: Home, zone: string): Words {
  const nameOf = (account: string) => {
    const found = home.find(account);
    if (found === undefined) return account;
    const shared = found.line !== null && home.all.some((other) => other !== found && other.name === found.name);
    return shared ? `${found.name} (${found.line})` : found.name;
  };
  return {
    account: nameOf,
    product: (product) => home.all.find((each) => each.account.split(":")[0] === product)?.name ?? product,
    address: (account) => home.find(account)?.line ?? null,
    zone,
  };
}


function fail(message: string): never {
  throw new EditError(message);
}

function bool(value: unknown, where: string): boolean {
  return typeof value === "boolean" ? value : fail(`${where} is true or false`);
}

function text(value: unknown, where: string): string {
  return typeof value === "string" && value !== "" ? value : fail(`${where} is a text`);
}

function typeOf(value: unknown): Type {
  return typeof value === "string" && Object.hasOwn(TYPES, value) ? (value as Type) : fail("type is a category");
}

function detailOf(value: unknown): DetailType {
  return isDetailType(value) && value !== "ref" ? value : fail("detail is a detail type");
}

function windowOf(value: unknown): Window {
  try {
    return parseAccess({ ...emptyAccess(), window: value }).window;
  } catch (error) {
    if (error instanceof AccessError) throw new EditError(error.message);
    throw error;
  }
}

function unique<T>(values: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const value of values) seen.set(JSON.stringify(value), value);
  return [...seen.values()];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
