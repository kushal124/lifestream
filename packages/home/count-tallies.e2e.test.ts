import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, MESSAGES_COLLECTIONS, MONEY_COLLECTIONS, type DayFileFact } from "@lifestreamprotocol/families";
import { ceilingOf, countWhole, type Admission, type CountContext, type PeopleMap } from "./counting.js";
import { makeRef } from "./refs.js";
import type { SearchGate } from "./record-search.js";
import { Refusal } from "./refusal.js";
import { SearchIndex } from "./search-index.js";
import { admit, ALWAYS, resolve } from "./count.js";
import { rowsCounted } from "./work.js";
import { countAsked, countedBy, countOf, shown } from "./test/record-reads.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const DAY_MS = 86_400_000;
const dir = mkdtempSync(join(tmpdir(), "lifestream-tallies-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const ADA = ["+15550000001", "15550000001@s.whatsapp.net"];
const RAJ = ["+15550000002"];
const BOB = ["+15550000003"];
const STRANGER = "+15550000099";
const GROUP = "whatsapp:120363000000000001@g.us";
const GROUP_REF = makeRef("chat", { key: GROUP });
const CHATS = ["whatsapp:15550000001@s.whatsapp.net", "whatsapp:15550000002@s.whatsapp.net", GROUP];

function peopleOf(merged: boolean): PeopleMap {
  const persons: Record<string, { name: string; handles: string[] }> = {
    "person:ada": { name: "Ada Example", handles: merged ? [...ADA, ...BOB] : ADA },
    "person:raj": { name: "Raj Example", handles: RAJ },
    ...merged ? {} : { "person:bob": { name: "Bob Example", handles: BOB } },
  };
  return {
    version: merged ? "people-2" : "people-1",
    idOf: (id) => (persons[id] !== undefined ? id : Object.entries(persons).find(([, person]) => person.handles.includes(id))?.[0]),
    person: (id) => persons[id],
    find: (name) => Object.keys(persons).filter((id) => persons[id]!.name.toLowerCase().includes(name.toLowerCase())),
  };
}
const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MONEY_COLLECTIONS, ...MESSAGES_COLLECTIONS }));

function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const message = (key: string, at: number, chat: string, sent: boolean, who: string[], source = "wa:local:a"): DayFileFact => ({
  id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
  keys: { chat, direction: sent ? "sent" : "received", product: "whatsapp", searchable: key.endsWith("0") ? "no" : "yes" }, measures: {},
  who: who.map((handle) => ({ handle, role: sent ? "receiver" as const : "sender" as const })), from: { units: [`messages/${key}`], record: { source, kind: "msg", key }, alone: true }, lines: [],
});
const call = (key: string, start: number, minutes: number, who: string[]): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + minutes * 60_000,
  keys: { service: "whatsapp", direction: "outgoing", outcome: minutes > 3 ? "connected" : "missed" }, measures: { minutes },
  who: who.map((handle) => ({ handle, role: "receiver" as const })), from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});
const payment = (key: string, day: string, payee: string, amount: string, currency: string): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { payee, direction: "debit", currency }, measures: { amount }, who: [], from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
});

function home(first: string, days: number, n: number, seed: number): Map<string, DayFileFact[]> {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const out = new Map<string, DayFileFact[]>();
  const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);
  for (let d = 0; d < days; d++) {
    const day = dayOf(D(first) + d * DAY_MS);
    const facts: DayFileFact[] = out.get(day) ?? [];
    out.set(day, facts);
    for (let i = 0; i < n; i++) {
      const at = D(day) + Math.floor(next() * (DAY_MS - 3_600_000));
      const key = `${seed}m${d}x${i}`;
      const chat = pick(CHATS);
      const sent = next() < 0.4;
      const members = chat === GROUP ? (next() < 0.5 ? [...ADA, RAJ[0]!, BOB[0]!] : [ADA[0]!, RAJ[0]!]) : chat === CHATS[0] ? [pick(ADA)] : [RAJ[0]!];
      const who = sent ? members : chat === GROUP ? [pick([ADA[1]!, RAJ[0]!, BOB[0]!, STRANGER])] : members;
      facts.push(message(key, at, chat, sent, next() < 0.1 ? [] : who, next() < 0.3 ? "wa:phone:b" : "wa:local:a"));
    }
    if (d % 3 === 0) facts.push(call(`${seed}c${d}`, D(day, "10:00"), 1 + Math.floor(next() * 20), [pick([...ADA, ...RAJ, ...BOB])]));
    if (d % 2 === 0) facts.push(payment(`${seed}p${d}`, day, pick(["ACME CABS", "CORNER BAKERY", "SYNTHETIC GROCER"]), `${1 + Math.floor(next() * 90)}.50`, pick(["EUR", "INR"])));
    if (d % 4 === 1 && d + 1 < days) facts.push(call(`${seed}x${d}`, D(day, "23:40"), 60, [RAJ[0]!]));
  }
  return out;
}

const fileOf = (name: string) => join(dir, name, "index.db");

function indexOf(name: string, days: ReadonlyMap<string, DayFileFact[]>): { index: SearchIndex; write(day: string, facts: DayFileFact[] | null): void; forget(day: string): void } {
  const built = SearchIndex.write(openHomeFolder(dirname(fileOf(name))), fileOf(name), () => true, 0, SETTINGS);
  built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  built.finish();
  const index = SearchIndex.write(openHomeFolder(dirname(fileOf(name))), fileOf(name), () => true, 0, SETTINGS);
  const write = (day: string, list: DayFileFact[] | null) => {
    index.day(day, list === null ? null : { inputs: `in-${day}-${list.length}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts: list } });
  };
  for (const [day, list] of days) write(day, list);
  return { index, write, forget: (day) => index.forget([], [day]) };
}

const context = (people: PeopleMap, over: Partial<CountContext> = {}): CountContext => ({ collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-30", "12:00"), people: () => people, ...over });

function statements(work: () => unknown): { sql: string; plan: string[]; args: unknown[]; rows: number }[] {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const originals = Object.fromEntries((["get", "all"] as const).map((name) => [name, statement[name]!]));
  const found: { sql: string; plan: string[]; args: unknown[]; rows: number }[] = [];
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: Database.Statement, ...args: unknown[]) {
      const out = original.apply(this, args);
      if (!/^\s*(EXPLAIN|PRAGMA|BEGIN|COMMIT|ROLLBACK)/u.test(this.source) && this.reader) {
        const plan = (originals.all!.apply(this.database.prepare(`EXPLAIN QUERY PLAN ${this.source}`), args) as { detail: string }[]).map((row) => row.detail);
        found.push({ sql: this.source, plan, args, rows: Array.isArray(out) ? out.length : out === undefined ? 0 : 1 });
      }
      return out;
    };
  }
  try {
    work();
  } finally {
    Object.assign(statement, originals);
  }
  return found;
}

function answerOf(index: SearchIndex, params: Record<string, string | string[]>, ctx: CountContext): unknown {
  try {
    return JSON.parse(JSON.stringify(shown(countOf(index, countAsked(params, COLLECTIONS), ctx)), (key, value: unknown) => (key === "ref" || key === "next" ? undefined : typeof value === "string" && /^eyJ[\w-]+$/u.test(value) ? "<handle>" : value)));
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.code, message: error.message, ...error.extra as object };
    throw error;
  }
}

function asks(seed: number, first: string, last: string, n: number): Record<string, string | string[]>[] {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const bys: Record<string, string[][]> = {
    messages: [[], ["day"], ["week"], ["month"], ["year"], ["weekday"], ["chat"], ["direction"], ["person"], ["person", "chat"], ["month", "direction"], ["searchable", "person"]],
    calls: [[], ["day"], ["person"], ["outcome"], ["week", "person"]],
    payments: [[], ["month"], ["currency"], ["payee"], ["payee", "currency"]],
  };
  const filters: Record<string, Record<string, string | string[]>[]> = {
    messages: [{}, { person: ADA[0]! }, { person: [ADA[0]!, RAJ[0]!] }, { person: BOB[0]! }, { chat: GROUP_REF }, { "match.direction": "sent" }, { "match.direction": "-sent" },
      { person: RAJ[0]!, "match.chat": "120363" }, { person: STRANGER }, { "match.chat": "nothing-like-this" }],
    calls: [{}, { person: RAJ[0]! }, { "match.outcome": "-missed" }],
    payments: [{}, { "match.payee": "acme OR bakery" }, { "match.currency": "INR" }],
  };
  const days = Math.round((D(last) - D(first)) / DAY_MS);
  const dayAt = (at: number) => new Date(D(first) + at * DAY_MS).toISOString().slice(0, 10);
  return Array.from({ length: n }, () => {
    const of = pick(["messages", "messages", "messages", "calls", "payments"]);
    const by = pick(bys[of]!);
    const from = Math.floor(next() * days), span = Math.floor(next() * days);
    const range = pick([{}, { from: dayAt(from) }, { from: dayAt(from), to: dayAt(Math.min(days, from + span)) }, { to: dayAt(from) }]);
    return { of, ...by.length === 0 ? {} : { by }, ...pick(filters[of]!), ...range };
  });
}
const TALLY_SQL = /\bFROM (tally|day_total|totals)\b/u;

function askFor(params: Record<string, string | string[]>) {
  return countAsked(params, COLLECTIONS);
}

function bothWays(index: SearchIndex, params: Record<string, string | string[]>, ctx: CountContext): void {
  const ask = askFor(params);
  expect(countedBy(index, ask, ctx, "chosen"), JSON.stringify(params)).toEqual(countedBy(index, ask, ctx, "facts"));
}

function same(index: SearchIndex, list: readonly Record<string, string | string[]>[], people: PeopleMap): number {
  let fromThem = 0;
  for (const params of list) {
    let fromTallies: unknown;
    const run = statements(() => {
      fromTallies = answerOf(index, params, context(people));
    });
    bothWays(index, params, context(people));
    if (!(fromTallies as { refused?: string }).refused) {
      expect(run.some(({ sql }) => TALLY_SQL.test(sql)), JSON.stringify(params)).toBe(true);
      expect(run.filter(({ sql }) => /contrib0/u.test(sql)).map(({ sql }) => sql), JSON.stringify(params)).toEqual([]);
      fromThem++;
    }
  }
  return fromThem;
}

function totalsHold(file: string): void {
  const raw = new Database(file, { readonly: true });
  try {
    expect(raw.prepare("SELECT of, crew, combo, accounts, n, first, last FROM totals ORDER BY of, crew, combo, accounts").all())
      .toEqual(raw.prepare("SELECT of, crew, combo, accounts, sum(n) AS n, min(day) AS first, max(day) AS last FROM tally GROUP BY of, crew, combo, accounts ORDER BY of, crew, combo, accounts").all());
  } finally {
    raw.close();
  }
}

describe("the day tallies", () => {
  it("T1 T2 T6 a count from the tallies is the facts' count, field by field, through rewrites, a moved fact, an erasure and a People merge", () => {
    const days = home("2026-10-01", 20, 30, 7);
    const pair = indexOf("t1", days);
    const people = peopleOf(false);
    try {
      expect(same(pair.index, asks(1, "2026-09-28", "2026-10-25", 120), people)).toBeGreaterThan(90);

      const rewritten = [...days.get("2026-10-05")!.slice(5)];
      rewritten[0] = { ...rewritten[0]!, keys: { ...rewritten[0]!.keys, direction: "sent" } };
      pair.write("2026-10-05", rewritten);
      const moved = days.get("2026-10-07")![0]!;
      pair.write("2026-10-08", [...days.get("2026-10-08")!, { ...moved, time_ms: D("2026-10-08", "09:00"), start_ms: D("2026-10-08", "09:00"), end_ms: D("2026-10-08", "09:00") }]);
      pair.write("2026-10-25", [message("late1", D("2026-10-25", "08:00"), GROUP, true, [...ADA, RAJ[0]!])]);
      expect(same(pair.index, asks(2, "2026-09-28", "2026-10-26", 80), people)).toBeGreaterThan(50);

      pair.forget("2026-10-10");
      expect(answerOf(pair.index, { of: "messages", from: "2026-10-09", to: "2026-10-11" }, context(people))).not.toHaveProperty("refused");
      same(pair.index, asks(3, "2026-09-28", "2026-10-26", 60), people);
      expect(same(pair.index, asks(4, "2026-10-11", "2026-10-25", 40).map((each) => ({ ...each, from: "2026-10-11" })), people)).toBeGreaterThan(20);
      pair.write("2026-10-10", days.get("2026-10-10")!);

      const merged = peopleOf(true);
      expect(same(pair.index, asks(5, "2026-09-28", "2026-10-26", 80), merged)).toBeGreaterThan(50);
      const ada = answerOf(pair.index, { of: "messages", person: ADA[0]!, by: "person" }, context(merged)) as { total: { n: number }; rows: unknown[][] };
      const raw = new Database(fileOf("t1"), { readonly: true });
      const hers = raw.prepare(`SELECT count(DISTINCT f.id) FROM fact f JOIN crew_members w ON w.crew = f.crew WHERE f.of = 'messages' AND w.handle IN (${[...ADA, ...BOB].map(() => "?").join(", ")})`).pluck().get(...ADA, ...BOB);
      expect(ada.total.n).toBe(hers);
      expect(ada.rows.find((row) => row[0] === "Ada Example")?.[1]).toBe(hers);

      pair.write("2026-10-25", null);
      pair.forget("2026-10-25");
      expect(raw.prepare("SELECT count(*) FROM crews c WHERE NOT EXISTS (SELECT 1 FROM tally t WHERE t.crew = c.id)").pluck().get()).toBe(0);
      expect(raw.prepare("SELECT count(*) FROM crew_members m WHERE NOT EXISTS (SELECT 1 FROM crews c WHERE c.id = m.crew)").pluck().get()).toBe(0);
      expect(raw.prepare("SELECT (SELECT sum(n) FROM tally) - (SELECT count(*) FROM fact)").pluck().get()).toBe(0);
      expect(raw.prepare("SELECT (SELECT sum(n) FROM day_total) - (SELECT count(*) FROM fact)").pluck().get()).toBe(0);
      raw.close();
    } finally {
      pair.index.close();
    }
  });

  it("T3 a count from the tallies reads its range of one index, and as many rows on a home with ten times the facts outside it", () => {
    const october = home("2026-10-01", 10, 200, 11);
    const before = home("2026-01-01", 270, 70, 12);
    const small = indexOf("t3-small", october).index;
    const large = indexOf("t3-large", new Map([...before, ...october])).index;
    const people = peopleOf(false);
    const asked = [
      { of: "messages", from: "2026-10-01", to: "2026-10-09", by: "chat" },
      { of: "messages", from: "2026-10-01", to: "2026-10-09", by: "person" },
      { of: "messages", from: "2026-10-01", to: "2026-10-09", by: "week" },
      { of: "messages", from: "2026-10-02", to: "2026-10-08", person: ADA[0]!, by: "day" },
      { of: "messages", from: "2026-10-02", to: "2026-10-08", chat: GROUP_REF, by: "person" },
      { of: "messages", from: "2026-10-02", to: "2026-10-08", "match.direction": "-sent", by: "chat" },
    ];
    try {
      for (const params of asked) {
        const reads = (index: SearchIndex) => {
          const run = statements(() => answerOf(index, params, context(people)));
          for (const { sql, plan } of run) {
            const scans = plan.filter((detail) => /^SCAN (tally|day_total|totals|fact|fact_measure|crew_members|combo_keys|f|w|k|t)\b/u.test(detail));
            expect(scans, `${JSON.stringify(params)}\n${sql}\n${plan.join("\n")}`).toEqual([]);
          }
          return run.filter(({ sql, args }) => TALLY_SQL.test(sql) && !args.includes("9999-12-31")).map(({ rows }) => rows).sort((a, b) => a - b);
        };
        expect(reads(large), JSON.stringify(params)).toEqual(reads(small));
        bothWays(large, params, context(people));
      }
    } finally {
      small.close();
      large.close();
    }
  });

  it("T5 a count past its row budget is TOO_BROAD, naming a from that fits; inside it, answered; nothing admitted, never refused", () => {
    const pair = indexOf("t5", home("2026-10-01", 20, 40, 21));
    const people = peopleOf(false);
    const bound = { fetch: 600 };
    try {
      const broad = answerOf(pair.index, { of: "messages", by: "item" }, context(people, { budget: bound })) as { refused?: string; message?: string };
      expect(broad.refused).toBe("TOO_BROAD");
      const run = statements(() => answerOf(pair.index, { of: "calls", measure: "minutes", op: "sum", by: "day" }, context(people, { budget: { fetch: 50 } })));
      expect(run.filter(({ sql }) => /contrib0/u.test(sql))).toEqual([]);
      const narrow = answerOf(pair.index, { of: "messages", by: "item", from: "2026-10-19", to: "2026-10-20" }, context(people, { budget: bound })) as { refused?: string };
      expect(narrow.refused).toBeUndefined();
      const named = (broad.message ?? "").match(/from=(\d{4}-\d{2}-\d{2})/u)?.[1];
      expect(named).toBeDefined();
      expect((answerOf(pair.index, { of: "messages", by: "item", from: named! }, context(people, { budget: bound })) as { refused?: string }).refused).toBeUndefined();
      expect(answerOf(pair.index, { of: "messages", by: "item", "match.chat": "nothing-like-this" }, context(people, { budget: { fetch: 1 } }))).toMatchObject({ total: { n: 0 } });
      expect(answerOf(pair.index, { of: "messages", by: "chat" }, context(people, { budget: { fetch: 10 } }))).toMatchObject({ refused: "TOO_BROAD" });
    } finally {
      pair.index.close();
    }
  });

  it("T5b a population nothing was admitted to reads no fact: not its rows, not what else it says (held, a span), chosen or over the fact rows", () => {
    const pair = indexOf("t5b", home("2026-10-01", 20, 40, 22));
    const people = peopleOf(false);
    try {
      for (const params of [{ of: "messages", by: "item", "match.chat": "nothing-like-this" }, { of: "calls", measure: "minutes", op: "sum", "match.chat": "nothing-like-this" }]) {
        let answer: unknown;
        const ran = statements(() => (answer = answerOf(pair.index, params, context(people, { budget: { fetch: 1 } }))));
        expect(answer).toMatchObject({ total: { n: 0 } });
        expect(ran.filter(({ sql }) => /\bFROM fact\b/u.test(sql))).toEqual([]);
        let facts: unknown;
        const read = statements(() => (facts = countedBy(pair.index, askFor(params), context(people, { budget: { fetch: 1 } }), "facts")));
        expect(facts).toMatchObject({ total: [], groups: [], held: {} });
        expect(read.filter(({ sql }) => /\bFROM fact\b/u.test(sql))).toEqual([]);
      }
    } finally {
      pair.index.close();
    }
  });

  it("T4 a file of format 10 is never opened: a reader finds no index, an erasure removes it, the writer builds one anew", () => {
    const pair = indexOf("t4", home("2026-10-01", 5, 10, 31));
    pair.index.close();
    const file = fileOf("t4");
    const raw = new Database(file);
    raw.prepare("UPDATE meta SET value = '10' WHERE key = 'format'").run();
    raw.close();
    expect(SearchIndex.read(openHomeFolder(dirname(file)), file)).toBeUndefined();
    expect(SearchIndex.marking(openHomeFolder(dirname(file)), file)).toBeUndefined();
    expect(SearchIndex.existing(openHomeFolder(dirname(file)), file)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    const rebuilt = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, SETTINGS);
    try {
      expect(rebuilt.building).toBe(true);
      expect(rebuilt.position()).toMatchObject({ seq: 0 });
    } finally {
      rebuilt.close();
    }
  });

  it("T7 every total is the sum of its tally rows through writes, a rewrite, moved facts and erasures; a crew no tally names has no total", () => {
    const days = home("2026-10-01", 16, 25, 71);
    const pair = indexOf("t7", days);
    const file = fileOf("t7");
    const next = random(72);
    const list = [...days.keys()].sort();
    const held = new Map([...days].map(([day, facts]) => [day, [...facts]]));
    const pick = <T>(of: readonly T[]): T => of[Math.floor(next() * of.length)]!;
    try {
      totalsHold(file);
      for (let step = 0; step < 40; step++) {
        const day = pick(list);
        const facts = held.get(day) ?? [];
        const op = pick(["again", "fewer", "rekeyed", "moved", "erased", "back"] as const);
        if (op === "again") pair.write(day, facts);
        else if (op === "fewer") {
          const kept = facts.filter(() => next() < 0.7);
          held.set(day, kept);
          pair.write(day, kept);
        } else if (op === "rekeyed" && facts.length > 0) {
          const at = Math.floor(next() * facts.length);
          const fact = facts[at]!;
          const rekeyed = [...facts];
          rekeyed[at] = { ...fact, keys: { ...fact.keys, direction: fact.keys["direction"] === "sent" ? "received" : "sent" }, who: [{ handle: STRANGER, role: "sender" }] };
          held.set(day, rekeyed);
          pair.write(day, rekeyed);
        } else if (op === "moved" && facts.length > 0) {
          const to = pick(list.filter((each) => each !== day));
          const fact = facts[0]!;
          const time = fact.date_only === true ? D(to) : D(to, "12:00") + step;
          const moved = { ...fact, time_ms: time, start_ms: time, end_ms: fact.date_only === true ? time : time + (fact.end_ms - fact.start_ms) };
          held.set(day, facts.slice(1));
          held.set(to, [...held.get(to) ?? [], moved]);
          pair.write(to, held.get(to)!);
        } else if (op === "erased") {
          pair.forget(day);
          held.set(day, []);
        } else if (op === "back") {
          held.set(day, [...days.get(day)!].filter((fact) => ![...held].some(([other, facts]) => other !== day && facts.some((each) => each.id === fact.id))));
          pair.write(day, held.get(day)!);
        }
        totalsHold(file);
      }
      for (const day of list) pair.forget(day);
      totalsHold(file);
      const raw = new Database(file, { readonly: true });
      expect(raw.prepare("SELECT count(*) FROM totals").pluck().get()).toBe(0);
      expect(raw.prepare("SELECT count(*) FROM crews").pluck().get()).toBe(0);
      raw.close();
    } finally {
      pair.index.close();
    }
  });

  it("T7 a fact naming two handles of one person is one crew: the person's crews' totals sum to the facts naming them, in all and in one chat", () => {
    const pair = indexOf("t7-person", home("2026-10-01", 10, 30, 73));
    try {
      totalsHold(fileOf("t7-person"));
      const raw = new Database(fileOf("t7-person"), { readonly: true });
      const hers = JSON.stringify(ADA);
      const both = raw.prepare(`SELECT count(*) FROM crews c WHERE (SELECT count(*) FROM crew_members m WHERE m.crew = c.id AND m.handle IN (SELECT value FROM json_each(?))) = 2`).pluck().get(hers) as number;
      expect(both).toBeGreaterThan(0);
      const crews = "SELECT DISTINCT crew FROM crew_members WHERE handle IN (SELECT value FROM json_each(@hers))";
      const summed = raw.prepare(`SELECT sum(t.n) FROM totals t WHERE t.of = 'messages' AND t.crew IN (${crews})`).pluck().get({ hers });
      const facts = raw.prepare(`SELECT count(DISTINCT f.id) FROM fact f JOIN crew_members w ON w.crew = f.crew WHERE f.of = 'messages' AND w.handle IN (SELECT value FROM json_each(@hers))`).pluck().get({ hers });
      expect(summed).toBe(facts);
      const chat = raw.prepare("SELECT id FROM names WHERE role = 'value' AND name = ?").pluck().get(GROUP) as number;
      const inChat = raw.prepare(`SELECT sum(t.n) FROM totals t WHERE t.of = 'messages' AND t.crew IN (${crews})
        AND t.combo IN (SELECT combo FROM combo_keys WHERE of = 'messages' AND key = 'chat' AND name = @chat)`).pluck().get({ hers, chat });
      const factsInChat = raw.prepare(`SELECT count(DISTINCT f.id) FROM fact f JOIN crew_members w ON w.crew = f.crew JOIN combo_keys k ON k.combo = f.combo AND k.of = f.of AND k.key = 'chat'
        WHERE f.of = 'messages' AND k.name = @chat AND w.handle IN (SELECT value FROM json_each(@hers))`).pluck().get({ hers, chat });
      expect(factsInChat).toBeGreaterThan(0);
      expect(inChat).toBe(factsInChat);
      raw.close();
    } finally {
      pair.index.close();
    }
  });

  it("T8 an unfiltered count by a key over every day the collection holds reads its groups from the kept totals, never a day's tally; a filtered one its tally alone; at ten days and at 280", () => {
    const october = home("2026-10-01", 10, 200, 81);
    const small = indexOf("t8-small", october).index;
    const large = indexOf("t8-large", new Map([...home("2026-01-01", 270, 70, 82), ...october])).index;
    const people = peopleOf(false);
    const oracle = context(people, { budget: { fetch: Number.MAX_SAFE_INTEGER } });
    const CELLS_SQL = /\bSELECT day, combo, crew, source, n, t, u FROM tally\b/u;
    const KEPT_SQL = /\bSELECT combo, crew, n FROM totals\b/u;
    const asked = [
      { of: "messages", by: "chat" },
      { of: "messages", from: "2025-01-01", by: "person" },
      { of: "messages", by: ["person", "chat"] },
      { of: "messages", person: ADA[0]!, by: "chat" },
      { of: "messages", chat: GROUP_REF, by: "person" },
      { of: "messages", "match.direction": "-sent", by: "chat" },
      { of: "calls", by: "outcome" },
    ];
    try {
      for (const params of asked) {
        const reads = (index: SearchIndex, file: string) => {
          const run = statements(() => answerOf(index, params, context(people)));
          if (Object.keys(params).every((name) => ["of", "from", "by"].includes(name))) {
            expect(run.filter(({ sql }) => CELLS_SQL.test(sql)).map(({ sql }) => sql), JSON.stringify(params)).toEqual([]);
          }
          const kept = run.filter(({ sql }) => KEPT_SQL.test(sql)).reduce((sum, { rows }) => sum + rows, 0);
          if (!Object.keys(params).every((name) => ["of", "from", "by"].includes(name))) {
            expect(kept, JSON.stringify(params)).toBe(0);
            return 1;
          }
          const raw = new Database(file, { readonly: true });
          try {
            expect(kept, JSON.stringify(params)).toBeLessThanOrEqual(raw.prepare("SELECT count(*) FROM totals WHERE of = ?").pluck().get(params.of) as number);
          } finally {
            raw.close();
          }
          return kept;
        };
        expect(reads(small, fileOf("t8-small")), JSON.stringify(params)).toBeGreaterThan(0);
        expect(reads(large, fileOf("t8-large")), JSON.stringify(params)).toBeGreaterThan(0);
        expect(countedBy(small, askFor(params), context(people), "chosen")).toEqual(countedBy(small, askFor(params), oracle, "facts"));
        expect(countedBy(large, askFor(params), context(people), "chosen")).toEqual(countedBy(large, askFor(params), oracle, "facts"));
      }
      const part = { of: "messages", from: "2026-10-02", by: "chat" };
      expect(statements(() => answerOf(small, part, context(people))).some(({ sql }) => CELLS_SQL.test(sql))).toBe(true);
      expect(countedBy(small, askFor(part), context(people), "chosen")).toEqual(countedBy(small, askFor(part), oracle, "facts"));
    } finally {
      small.close();
      large.close();
    }
  });

  it("T9 a count by person asks People's map once a handle, however many crews name it", () => {
    const pair = indexOf("t9", home("2026-10-01", 10, 60, 91));
    const asked = new Map<string, number>();
    const people = peopleOf(false);
    const counting: PeopleMap = { ...people, idOf: (id) => {
      asked.set(id, (asked.get(id) ?? 0) + 1);
      return people.idOf(id);
    } };
    try {
      const raw = new Database(fileOf("t9"), { readonly: true });
      const crews = raw.prepare("SELECT count(*) FROM crews WHERE handles LIKE '%' || char(30) || '%'").pluck().get() as number;
      raw.close();
      expect(crews).toBeGreaterThan(1);
      const params = { of: "messages", from: "2026-10-01", to: "2026-10-10", by: "person" };
      expect(countedBy(pair.index, askFor(params), context(counting), "chosen")).toEqual(countedBy(pair.index, askFor(params), context(people), "facts"));
      expect(asked.size).toBeGreaterThan(1);
      expect([...asked].filter(([, times]) => times > 1)).toEqual([]);
    } finally {
      pair.index.close();
    }
  });
  it("T10 a first or last past its row budget names the range from the end that holds it: the oldest days for first, the newest for last", () => {
    const pair = indexOf("t10", home("2026-10-01", 20, 2, 41));
    const people = peopleOf(false);
    const fitsOf = (op: string, fetch: number): { from: string; to: string } | "answered" | undefined => {
      try {
        countOf(pair.index, countAsked({ of: "calls", measure: "minutes", op }, COLLECTIONS), context(people, { budget: { fetch } }));
        return "answered";
      } catch (error) {
        if (!(error instanceof Refusal) || error.code !== "TOO_BROAD") throw error;
        return (error.extra as { fits?: { from: string; to: string } }).fits;
      }
    };
    try {
      let fetch = 1;
      while (fitsOf("first", fetch) === undefined) fetch = Math.ceil(fetch * 1.25);
      expect(fitsOf("first", fetch)).not.toBe("answered");
      expect(fitsOf("last", fetch)).not.toBe("answered");
      const last = fitsOf("last", fetch) as { from: string; to: string };
      expect(last.to >= "2026-10-20").toBe(true);
      expect(last.from > "2026-10-01").toBe(true);
      const first = fitsOf("first", fetch) as { from: string; to: string };
      expect(first.from).toBe("2026-10-01");
      expect(first.to < "2026-10-20").toBe(true);
      const asked = answerOf(pair.index, { of: "calls", measure: "minutes", op: "first", ...first }, context(people, { budget: { fetch } })) as { refused?: string; total: { first_day?: string } };
      expect(asked.refused).toBeUndefined();
      expect(JSON.stringify(asked.total)).toContain("2026-10-01");
    } finally {
      pair.index.close();
    }
  });

  it("T11 each walk stopped in turn: at its budget answered, one row fewer TOO_BROAD, its fits whole days from the end the count reads, asked over them at that budget the record's number", () => {
    const pair = indexOf("t11", home("2026-10-01", 20, 30, 51));
    const people = peopleOf(false);
    const unbounded = context(people, { budget: { fetch: Number.MAX_SAFE_INTEGER } });
    const FACTS = /\bFROM fact INDEXED BY fact_of WHERE of = \? AND time_ms >= \?/u;
    const walks: [string, RegExp, Record<string, string>][] = [
      ["the facts, newest first", FACTS, { of: "calls", measure: "minutes", op: "sum", by: "day" }],
      ["the facts, oldest first", FACTS, { of: "calls", measure: "minutes", op: "first" }],
      ["the days' totals", /\bFROM day_total WHERE of = \? AND day >= \?/u, { of: "messages", from: "2026-10-02", by: "day" }],
      ["every cell", /\bFROM tally WHERE of = \? AND day >= \?/u, { of: "messages", from: "2026-10-02", by: "chat" }],
      ["a combination's cells", /\btally INDEXED BY tally_combo\b/u, { of: "messages", from: "2026-10-02", "match.direction": "sent", by: "day" }],
      ["a crew's cells", /\btally INDEXED BY tally_crew\b/u, { of: "messages", from: "2026-10-02", person: ADA[0]!, by: "day" }],
      ["the kept totals", /\bFROM totals WHERE of = \?/u, { of: "messages", by: "chat" }],
    ];
    try {
      for (const [walk, read, params] of walks) {
        const before = rowsCounted();
        const whole = answerOf(pair.index, params, unbounded);
        const rows = rowsCounted() - before;
        expect(whole, walk).not.toMatchObject({ refused: expect.anything() });
        const answers = (fetch: number) => !("refused" in (answerOf(pair.index, params, context(people, { budget: { fetch } })) as object));
        let [low, high] = [1, 4 * rows];
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (answers(middle)) high = middle;
          else low = middle + 1;
        }
        expect(answerOf(pair.index, params, context(people, { budget: { fetch: low } })), walk).toEqual(whole);
        const budget = low - 1;
        let refused: { refused?: string; message?: string; fits?: { from: string; to: string } } = {};
        const counted = rowsCounted();
        const ran = statements(() => (refused = answerOf(pair.index, params, context(people, { budget: { fetch: budget } })) as typeof refused));
        expect(refused, walk).toMatchObject({ refused: "TOO_BROAD" });
        expect(refused, walk).not.toHaveProperty("budget");
        expect(rowsCounted() - counted, walk).toBeLessThanOrEqual(ceilingOf(budget) + 20);
        expect(ran.some(({ sql, rows: read_ }) => read.test(sql) && read_ > 0), walk).toBe(true);
        const fits = refused.fits!;
        expect(fits, `${walk}: ${refused.message}`).toBeDefined();
        expect(refused.message, walk).toContain(`from=${fits.from} to=${fits.to}`);
        if (params.op === "first") expect(fits.from, walk).toBe(params.from ?? "2026-10-01");
        else expect(fits.to, walk).toBe(params.to ?? "2026-10-30");
        const over = { ...params, ...fits };
        expect(answerOf(pair.index, over, context(people, { budget: { fetch: budget } })), walk).toEqual(answerOf(pair.index, over, unbounded));
      }
    } finally {
      pair.index.close();
    }
  });

  it("T12 held from the tallies is read through meters of its own, its filter resolved there: a count whose own reads take its whole budget answers, held stated", () => {
    const pair = indexOf("t12", home("2026-10-01", 20, 30, 61));
    const people = peopleOf(false);
    try {
      for (const filter of [{ "match.direction": "sent" }, { person: ADA[0]! }, { "match.direction": "-received" }]) {
        const label = JSON.stringify(filter);
        const asked = countAsked({ of: "messages", by: "item", ...filter }, COLLECTIONS);
        const counted = (fetch: number, held: boolean) => pair.index.snapshot({}, (open) => open.facts((read) => {
          const ctx = context(people, { budget: { fetch } });
          try {
            return countWhole(read, asked, ctx, admit(resolve(read, asked, ctx), ALWAYS) as Admission, (run) => {
              const population = run.populationOf();
              const items = population.items(undefined, 1_000).length;
              return held ? { items, ...population.edges() } : { items };
            });
          } catch (error) {
            if (error instanceof Refusal && error.code === "TOO_BROAD") return "refused";
            throw error;
          }
        }));
        const whole = counted(Number.MAX_SAFE_INTEGER, true);
        expect(whole, label).toMatchObject({ first: expect.any(String), last: expect.any(String) });
        let [low, high] = [1, 100_000];
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          if (counted(middle, false) !== "refused") high = middle;
          else low = middle + 1;
        }
        expect(counted(low - 1, false), label).toBe("refused");
        expect(counted(low, true), label).toEqual(whole);
      }
    } finally {
      pair.index.close();
    }
  });

  it("T13 a broad count stopped near its budget reads at most the request's ceiling, its refusal and the proof of its fits together", () => {
    const days = new Map<string, DayFileFact[]>();
    for (let d = 0; d < 20; d++) {
      const day = `2026-10-${String(d + 1).padStart(2, "0")}`;
      days.set(day, Array.from({ length: 150 }, (_, i) => call(`t13d${d}x${i}`, D(day) + i * 9 * 60_000, 1 + (i % 7), [RAJ[0]!])));
    }
    const pair = indexOf("t13", days);
    const people = peopleOf(false);
    const params = { of: "calls", measure: "minutes", op: "sum", by: "day", from: "2026-10-01", to: "2026-10-20" };
    try {
      const answers = (fetch: number) => !("refused" in (answerOf(pair.index, params, context(people, { budget: { fetch } })) as object));
      let [low, high] = [1, 100_000];
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (answers(middle)) high = middle;
        else low = middle + 1;
      }
      const budget = low - 1;
      expect(budget).toBeGreaterThan(20 * 256);
      const before = rowsCounted();
      const refused = answerOf(pair.index, params, context(people, { budget: { fetch: budget } })) as { fits?: { from: string; to: string } };
      const rows = rowsCounted() - before;
      expect(refused).toMatchObject({ refused: "TOO_BROAD", message: expect.stringContaining(`past ${budget} rows`), fits: { to: "2026-10-20" } });
      expect(refused.fits!.from <= "2026-10-03").toBe(true);
      expect(ceilingOf(budget)).toBe(budget + Math.ceil(budget / 20));
      expect(rows).toBeLessThanOrEqual(ceilingOf(budget) + 20);
      expect(answerOf(pair.index, { ...params, ...refused.fits! }, context(people, { budget: { fetch: budget } }))).not.toMatchObject({ refused: expect.anything() });
    } finally {
      pair.index.close();
    }
  });

  it("T14 a crew's cells and a combination's are read from their index alone, never a look-up in the tally a cell, gated or not", () => {
    const pair = indexOf("t14", home("2026-10-01", 10, 60, 91));
    const people = peopleOf(false);
    const open: SearchGate = { allows: () => true, floorOf: () => null, whole: () => true, tell: () => undefined };
    const walks: [string, Record<string, string>][] = [
      ["tally_crew", { of: "messages", person: ADA[0]!, by: "year" }],
      ["tally_combo", { of: "messages", "match.direction": "sent", by: "day" }],
    ];
    try {
      for (const gate of [undefined, open]) {
        for (const [index, params] of walks) {
          const label = `${index}${gate === undefined ? "" : ", gated"}`;
          const run = statements(() => answerOf(pair.index, params, context(people, gate === undefined ? {} : { gate })))
            .filter(({ sql }) => sql.includes(`tally INDEXED BY ${index}`));
          expect(run.reduce((sum, { rows }) => sum + rows, 0), label).toBeGreaterThan(0);
          for (const { sql, plan } of run) expect(plan, `${label}\n${sql}`).toEqual([expect.stringMatching(new RegExp(`^SEARCH tally USING COVERING INDEX ${index} `, "u"))]);
        }
      }
    } finally {
      pair.index.close();
    }
  });
});
