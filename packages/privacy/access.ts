import { accountOf, DETAIL_TYPES, hides, isDetailType, LEVEL_NAMES, TYPES, type DetailType, type Json, type Level, type RecordRef, type Type } from "@lifestreamprotocol/core";

export type Reach =
  | { all: true; but: Type[] }
  | { type: Type; but: string[] }
  | { account: string; but: [] };

export type Window = null | { since_ms: number } | { past_ms: number };

export interface Allow {
  reach: Reach;
  window: Window;
  until_ms: number | null;
}

export interface Access {
  allow: Allow[];
  items: [];
  not: [];
  only: [];
  window: Window;
  hide: Level;
  shown: [];
}

export type End = { until_ms: number | null } | { lasts_ms: number };
export type DraftAllow = Omit<Allow, "until_ms"> & End;
export interface DraftAccess extends Omit<Access, "allow"> {
  allow: DraftAllow[];
}

export class AccessError extends Error {
  override name = "AccessError";
}

export function parseAccess(value: unknown): Access {
  return parsed(value, false) as Access;
}

export function parseDraft(value: unknown): DraftAccess {
  return parsed(value, true);
}

export function resolve(draft: DraftAccess, now_ms: number): Access {
  return { ...draft, allow: draft.allow.map((allow) => fixedEnd(allow, now_ms)) };
}

export function untilAt(end: End, now_ms: number): number | null {
  return "lasts_ms" in end ? now_ms + end.lasts_ms : end.until_ms;
}

function fixedEnd(entry: DraftAllow, now_ms: number): Allow {
  if (!("lasts_ms" in entry)) return entry;
  const { lasts_ms: _span, ...rest } = entry;
  return { ...rest, until_ms: untilAt(entry, now_ms) };
}

function parsed(value: unknown, draft: boolean): DraftAccess {
  const access = exact(value, ["allow", "items", "not", "only", "window", "hide", "shown"], "an access");
  return {
    allow: list(access.allow, "allow").map((each, at) => allowOf(each, `allow ${at}`, draft)),
    items: empty(access.items, "items"),
    not: empty(access.not, "not"),
    only: empty(access.only, "only"),
    window: windowOf(access.window, "window"),
    hide: levelOf(access.hide, "hide"),
    shown: empty(access.shown, "shown"),
  };
}

export type LineMember = "allow" | "window" | "hide";
export interface Line {
  number: number;
  member: LineMember;
  index: number;
}

export function numbered(access: Access): Line[] {
  const lines: Line[] = [];
  const add = (member: LineMember, count: number) => {
    for (let index = 0; index < count; index++) lines.push({ number: lines.length + 1, member, index });
  };
  add("allow", access.allow.length);
  add("window", access.window === null ? 0 : 1);
  add("hide", 1);
  return lines;
}

export interface Thing {
  accounts: readonly string[];
  start_ms: number | null;
}

export interface Gate {
  readonly open_line: number | null;
  readonly since_ms: number | null;
  readonly window_line: number | null;
  readonly allows: readonly { line: number; reach: Reach; since_ms: number | null }[];
  readonly category: (account: string) => Type | null;
}

export function compile(access: Access, now_ms: number, category: (account: string) => Type | null): Gate | null {
  if (full(access)) return null;
  const live = access.allow.map((allow, index) => ({ allow, line: index + 1 })).filter(({ allow }) => !ended(allow.until_ms, now_ms));
  const open = access.window === null ? live.find(({ allow }) => isOpen(allow)) : undefined;
  return {
    open_line: open?.line ?? null,
    since_ms: placed(access.window, now_ms),
    window_line: access.window === null ? null : access.allow.length + 1,
    allows: live.map(({ allow, line }) => ({ line, reach: allow.reach, since_ms: placed(allow.window, now_ms) })),
    category,
  };
}

export type Why = "allowed" | "unresolved" | "window" | "no-line";

export interface Decision {
  allowed: boolean;
  line: number | null;
  why: Why;
}

const UNRESOLVED: Decision = { allowed: false, line: null, why: "unresolved" };
const NO_LINE: Decision = { allowed: false, line: null, why: "no-line" };

export function decide(gate: Gate, thing: Thing | null): Decision {
  if (thing === null || thing.accounts.length === 0) return gate.open_line === null ? UNRESOLVED : { allowed: true, line: gate.open_line, why: "allowed" };
  if (!inside(gate.since_ms, thing.start_ms)) return { allowed: false, line: gate.window_line, why: "window" };
  const holding = gate.allows.filter((allow) => inside(allow.since_ms, thing.start_ms));
  const reached = (allow: (typeof holding)[number], account: string) => reaches(allow.reach, account, gate.category);
  if (!thing.accounts.every((account) => holding.some((allow) => reached(allow, account)))) return NO_LINE;
  const whole = holding.find((allow) => thing.accounts.every((account) => reached(allow, account)));
  return { allowed: true, line: whole?.line ?? null, why: "allowed" };
}

export function earliest(gate: Gate, accounts: readonly string[]): number | null | undefined {
  const at = [Number.MIN_SAFE_INTEGER, ...new Set([gate.since_ms, ...gate.allows.map((allow) => allow.since_ms)].filter((since) => since !== null))].sort((left, right) => left - right);
  const first = at.find((start_ms) => decide(gate, { accounts, start_ms }).allowed);
  return first === Number.MIN_SAFE_INTEGER ? null : first;
}

export function opensAt(gate: Gate): number | null {
  const starts = gate.allows.map((allow) => allow.since_ms);
  const first = starts.length === 0 || starts.includes(null) ? null : Math.min(...(starts as number[]));
  if (gate.since_ms === null) return first;
  return first === null ? gate.since_ms : Math.max(first, gate.since_ms);
}

export interface HomeAccount {
  readonly account: string;
  readonly category: Type | null;
}

export function widens(before: unknown, after: unknown, accounts: readonly HomeAccount[]): boolean {
  const was = accessOrNull(before);
  const now = accessOrNull(after);
  if (was === null || now === null) return true;
  const category = categoryOf(accounts);
  const narrows = now.allow.every((allow) => was.allow.some((wider) => allowWithin(allow, wider, category)))
    && windowWithin(now.window, was.window)
    && hiddenWithin(was.hide, now.hide);
  return !narrows;
}

export interface ErasedIds {
  records?: readonly RecordRef[];
  accounts?: readonly string[];
}

export interface Scrubber {
  access(lines: Json): { lines: Json; went: Json | null };
  names(value: Json): boolean;
}

export function scrub(erased: ErasedIds): Scrubber {
  const records = new Set((erased.records ?? []).map(refKey));
  const accounts = new Set(erased.accounts ?? []);
  const allowGone = (reach: Reach) => {
    if ("all" in reach) return false;
    if ("type" in reach) return reach.but.some((account) => accounts.has(account));
    return accounts.has(reach.account);
  };
  const named = (value: Json): boolean => {
    if (typeof value === "string") return accounts.has(value) || (value.split(":").length === 3 && accounts.has(accountOf(value)));
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(named);
    const { source, kind, key } = value;
    if (typeof source === "string" && typeof kind === "string" && typeof key === "string" && records.has(refKey({ source, kind, key }))) return true;
    return Object.values(value).some(named);
  };
  return {
    access(lines) {
      const access = parseAccess(lines);
      const went: number[] = [];
      const allow = access.allow.filter((each, index) => {
        if (!allowGone(each.reach)) return true;
        went.push(index + 1);
        return false;
      });
      return went.length === 0 ? { lines, went: null } : { lines: { ...access, allow } as unknown as Json, went: { lines: went } };
    },
    names(value) {
      const access = accessOrNull(value);
      return access === null ? named(value) : access.allow.some((allow) => allowGone(allow.reach));
    },
  };
}

function accessOrNull(value: unknown): Access | null {
  try {
    return parseAccess(value);
  } catch {
    return null;
  }
}

function ended(until_ms: number | null, now_ms: number): boolean {
  return until_ms !== null && now_ms >= until_ms;
}

function full(access: Access): boolean {
  const [allow, ...rest] = access.allow;
  return allow !== undefined && rest.length === 0 && isOpen(allow) && access.window === null;
}

function isOpen(allow: Allow): boolean {
  return "all" in allow.reach && allow.reach.but.length === 0 && allow.window === null && allow.until_ms === null;
}

function placed(window: Window, now_ms: number): number | null {
  if (window === null) return null;
  return "since_ms" in window ? window.since_ms : now_ms - window.past_ms;
}

function inside(since_ms: number | null, start_ms: number | null): boolean {
  return since_ms === null || (start_ms !== null && start_ms >= since_ms);
}

function reaches(reach: Reach, account: string, category: (account: string) => Type | null): boolean {
  if ("all" in reach) {
    if (reach.but.length === 0) return true;
    const type = category(account);
    return type !== null && !reach.but.includes(type);
  }
  if ("type" in reach) return category(account) === reach.type && !reach.but.includes(account);
  return account === reach.account;
}

function refKey(ref: RecordRef): string {
  return JSON.stringify([ref.source, ref.kind, ref.key]);
}

export function categoryOf(accounts: readonly HomeAccount[]): (account: string) => Type | null {
  const categories = new Map(accounts.map(({ account, category }) => [account, category] as const));
  return (account) => categories.get(account) ?? null;
}

export function allowWithin(allow: Allow, wider: Allow, category: (account: string) => Type | null): boolean {
  return reachWithin(allow.reach, wider.reach, category) && windowWithin(allow.window, wider.window) && untilWithin(allow.until_ms, wider.until_ms);
}

export function reachWithin(reach: Reach, wider: Reach, category: (account: string) => Type | null): boolean {
  if ("all" in wider) {
    if (wider.but.length === 0) return true;
    if ("all" in reach) return superset(reach.but, wider.but);
    if ("type" in reach) return !wider.but.includes(reach.type);
    const type = category(reach.account);
    return type !== null && !wider.but.includes(type);
  }
  if ("type" in wider) {
    if ("type" in reach) return reach.type === wider.type && superset(reach.but, wider.but);
    return "account" in reach && category(reach.account) === wider.type && !wider.but.includes(reach.account);
  }
  return "account" in reach && reach.account === wider.account;
}

export function windowWithin(window: Window, wider: Window): boolean {
  if (wider === null) return true;
  if (window === null) return false;
  if ("since_ms" in window && "since_ms" in wider) return window.since_ms >= wider.since_ms;
  if ("past_ms" in window && "past_ms" in wider) return window.past_ms <= wider.past_ms;
  return false;
}

export function untilWithin(until_ms: number | null, wider: number | null): boolean {
  return wider === null || (until_ms !== null && until_ms <= wider);
}

export function hiddenWithin(before: Level, after: Level): boolean {
  return DETAIL_TYPES.every((type) => !hides(before, type) || hides(after, type));
}

function superset(more: readonly string[], fewer: readonly string[]): boolean {
  return fewer.every((value) => more.includes(value));
}

function fail(message: string): never {
  throw new AccessError(message);
}

function exact(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`${where} is an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where} has no member ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where} has ${key}`);
  return value as Record<string, unknown>;
}

function list(value: unknown, where: string): unknown[] {
  return Array.isArray(value) ? value : fail(`${where} is a list`);
}

function empty(value: unknown, where: string): [] {
  return list(value, where).length === 0 ? [] : fail(`${where} must be empty`);
}

function text(value: unknown, where: string): string {
  return typeof value === "string" && value !== "" ? value : fail(`${where} is a text`);
}

function texts(value: unknown, where: string): string[] {
  const values = list(value, where).map((each) => text(each, where));
  return new Set(values).size === values.length ? values : fail(`${where} names each once`);
}

function ms(value: unknown, where: string): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fail(`${where} is milliseconds, a whole number`);
}

function account(value: unknown, where: string): string {
  const spelled = text(value, where);
  return /^[^:/\\\0]+:[^:/\\\0]+$/u.test(spelled) ? spelled : fail(`${where} is an account, <product>:<account>, with no slash, backslash or NUL`);
}

function typeOf(value: unknown, where: string): Type {
  return typeof value === "string" && Object.hasOwn(TYPES, value) ? (value as Type) : fail(`${where} is a category`);
}

function detailType(value: unknown, where: string): DetailType {
  return isDetailType(value) && value !== "ref" ? value : fail(`${where} is a detail type`);
}

const SPAN_MOST = 100 * 365 * 86_400_000;

function allowOf(value: unknown, where: string, draft: boolean): DraftAllow {
  const span = draft && typeof value === "object" && value !== null && Object.hasOwn(value, "lasts_ms");
  if (span && Object.hasOwn(value, "until_ms")) fail(`${where} has until_ms or lasts_ms, never both`);
  const entry = exact(value, ["reach", "window", span ? "lasts_ms" : "until_ms"], where);
  const allow = { reach: reachOf(entry.reach, `${where}'s reach`), window: windowOf(entry.window, `${where}'s window`) };
  if (!span) return { ...allow, until_ms: entry.until_ms === null ? null : ms(entry.until_ms, `${where}'s until_ms`) };
  const lasts_ms = ms(entry.lasts_ms, `${where}'s lasts_ms`);
  if (lasts_ms > SPAN_MOST) fail(`${where}'s lasts_ms is at most ${SPAN_MOST}, 100 years`);
  return lasts_ms > 0 ? { ...allow, lasts_ms } : fail(`${where}'s lasts_ms is more than 0`);
}

function reachOf(value: unknown, where: string): Reach {
  const keys = typeof value === "object" && value !== null ? Object.keys(value) : [];
  if (keys.includes("all")) {
    const reach = exact(value, ["all", "but"], where);
    if (reach.all !== true) fail(`${where}'s all is true`);
    const but = texts(reach.but, `${where}'s but`).map((each) => typeOf(each, `${where}'s but`));
    return { all: true, but };
  }
  if (keys.includes("type")) {
    const reach = exact(value, ["type", "but"], where);
    return { type: typeOf(reach.type, `${where}'s type`), but: texts(reach.but, `${where}'s but`).map((each) => account(each, `${where}'s but`)) };
  }
  if (keys.includes("account") && !keys.includes("conversation")) {
    const reach = exact(value, ["account", "but"], where);
    return { account: account(reach.account, `${where}'s account`), but: empty(reach.but, `${where}'s but`) };
  }
  return fail(`${where} is all, a type or an account`);
}

function windowOf(value: unknown, where: string): Window {
  if (value === null) return null;
  const keys = typeof value === "object" ? Object.keys(value) : [];
  if (keys.includes("since_ms")) return { since_ms: ms(exact(value, ["since_ms"], where).since_ms, `${where}'s since_ms`) };
  if (keys.includes("past_ms")) {
    const past_ms = ms(exact(value, ["past_ms"], where).past_ms, `${where}'s past_ms`);
    return past_ms > 0 ? { past_ms } : fail(`${where}'s past_ms is more than 0`);
  }
  return fail(`${where} is null, since_ms or past_ms`);
}

function levelOf(value: unknown, where: string): Level {
  if (typeof value === "string") return (LEVEL_NAMES as readonly string[]).includes(value) ? (value as Level) : fail(`${where} is all, names, none or a list of types`);
  const types = list(value, where).map((each) => detailType(each, where));
  return types.length > 0 && new Set(types).size === types.length ? types : fail(`${where} names each type once, and one at least`);
}
