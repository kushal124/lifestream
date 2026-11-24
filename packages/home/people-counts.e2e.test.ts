import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, MESSAGES_COLLECTIONS, type DayFileFact } from "@lifestreamprotocol/families";
import { ceilingOf, PeopleCounts, type Admission, type CountAsk, type CountContext, type PeopleMap, type Subject } from "./counting.js";
import { SearchIndex, type FactsRead } from "./search-index.js";
import { admit, ALWAYS, resolve } from "./count.js";
import { countAsked, countedBy, peopleCountsOf } from "./test/record-reads.js";
import { rowsCounted } from "./work.js";
import { makeRef, personRef } from "./refs.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const DAY_MS = 86_400_000;
const NOW_MS = D("2026-10-30", "12:00");
const dir = mkdtempSync(join(tmpdir(), "lifestream-people-counts-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MESSAGES_COLLECTIONS }));
const BOTH = { person: ["calls", "messages"], chat: ["messages"] };
const NO_RANGE: Omit<CountContext, "people"> = { collections: COLLECTIONS, settings: SETTINGS, now_ms: NOW_MS };
const dayOf = (at: number) => new Date(at).toISOString().slice(0, 10);

let serial = 0;
const message = (at: number, chat: string, sent: boolean, who: readonly string[], searchable = true): DayFileFact => {
  const key = `m${serial++}`;
  return {
    id: `messages:${key.padStart(24, "0")}`, family: "messages", of: "messages", time_ms: at, start_ms: at, end_ms: at,
    keys: { chat, direction: sent ? "sent" : "received", product: "whatsapp", searchable: searchable ? "yes" : "no" }, measures: {},
    who: [...new Set(who)].sort().map((handle) => ({ handle, role: sent ? "receiver" as const : "sender" as const })),
    from: { units: [`messages/${key}`], record: { source: "wa:local:a", kind: "msg", key }, alone: true }, lines: [],
  };
};
const call = (at: number, minutes: number, who: readonly string[]): DayFileFact => {
  const key = `c${serial++}`;
  return {
    id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: at, start_ms: at, end_ms: at + minutes * 60_000,
    keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes },
    who: who.map((handle) => ({ handle, role: "receiver" as const })), from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
  };
};

function indexOf(name: string, days: ReadonlyMap<string, DayFileFact[]>): SearchIndex {
  const file = join(dir, name, "index.db");
  const built = SearchIndex.write(openHomeFolder(dirname(file)), file, () => true, 0, SETTINGS);
  built.records([], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, facts] of days) built.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + DAY_MS }, facts } });
  built.finish();
  built.close();
  return SearchIndex.read(openHomeFolder(dirname(file)), file)!;
}

function add(days: Map<string, DayFileFact[]>, fact: DayFileFact): void {
  const day = dayOf(fact.time_ms);
  days.set(day, [...days.get(day) ?? [], fact]);
}

function peopleOf(persons: Record<string, { name: string; handles: string[] }>): PeopleMap {
  return {
    version: "people-1",
    idOf: (id) => (persons[id] !== undefined ? id : Object.entries(persons).find(([, person]) => person.handles.includes(id))?.[0]),
    person: (id) => persons[id],
    find: (name) => Object.keys(persons).filter((id) => persons[id]!.name.toLowerCase().includes(name.toLowerCase())),
  };
}

function oracle(index: SearchIndex, people: PeopleMap, params: Record<string, string>): { total: number; rows: unknown[][]; columns: string[] } {
  const context: CountContext = { ...NO_RANGE, people: () => people, budget: { fetch: Number.MAX_SAFE_INTEGER } };
  const { person, chat, ...rest } = params;
  const ask = countAsked({
    limit: "100", ...rest,
    ...(person === undefined ? {} : { person: personRef({ id: person, handles: people.person(person)?.handles ?? [] }) }),
    ...(chat === undefined ? {} : { chat: makeRef("chat", { key: chat }) }),
  }, COLLECTIONS);
  const said = countedBy(index, ask, context, "facts");
  if ("refused" in said) throw new Error(`the oracle was refused: ${said.message}`);
  return { total: said.total.reduce((sum, { n }) => sum + n, 0), rows: said.groups.map(({ keys, n }) => [...keys, n]), columns: [...ask.by, "n"] };
}
function oracleReach(index: SearchIndex, people: PeopleMap, filter: Record<string, string>, collections: readonly string[]): Record<string, [number, string, string]> {
  const reach: Record<string, [number, string, string]> = {};
  for (const of of collections) {
    const { total } = oracle(index, people, { of, ...filter });
    if (total === 0) continue;
    const byDay = oracle(index, people, { of, ...filter, by: "day" });
    const days = byDay.rows.map((row) => String(row[byDay.columns.indexOf("day")])).sort();
    reach[of] = [total, days[0]!, days.at(-1)!];
  }
  return reach;
}


const ADA = ["phone:+15550000001", "jid:15550000001@s.whatsapp.net"];
const RAJ = "phone:+15550000002";
const BOB = "phone:+15550000003";
const ADA_CHAT = "whatsapp:15550000001@s.whatsapp.net";
const RAJ_CHAT = "whatsapp:15550000002@s.whatsapp.net";
const GROUP = "whatsapp:120363000000000001@g.us";
const GROUP2 = "whatsapp:120363000000000002@g.us";
const PEOPLE = peopleOf({
  "person:ada": { name: "Ada Example", handles: ADA },
  "person:raj": { name: "Raj Example", handles: [RAJ] },
  "person:bob": { name: "Bob Example", handles: [BOB] },
});

function manyChats(): Map<string, DayFileFact[]> {
  const days = new Map<string, DayFileFact[]>();
  for (let d = 0; d < 40; d++) {
    const at = D("2026-09-20") + d * DAY_MS + 9 * 3_600_000;
    add(days, message(at, ADA_CHAT, d % 2 === 0, [ADA[d % 2]!], d % 3 !== 0));
    add(days, message(at + 60_000, RAJ_CHAT, d % 2 === 1, [RAJ]));
    add(days, message(at + 120_000, GROUP, true, d % 4 === 0 ? [...ADA, RAJ, BOB] : [ADA[0]!, RAJ, BOB]));
    add(days, message(at + 180_000, GROUP, false, [d % 3 === 0 ? ADA[1]! : BOB]));
    if (d % 5 === 0) add(days, message(at + 240_000, GROUP2, false, [ADA[1]!]));
    if (d % 7 === 0) add(days, call(at + 300_000, 5 + d, [ADA[0]!]));
  }
  add(days, message(D("2026-11-02", "10:00"), ADA_CHAT, false, [ADA[0]!]));
  add(days, message(D("2026-11-03", "10:00"), GROUP, true, [...ADA, RAJ, BOB]));
  add(days, call(D("2026-11-04", "10:00"), 30, [ADA[1]!]));
  add(days, call(D("2026-11-05", "10:00"), 10, [RAJ]));
  return days;
}

describe("search_people's counts, from the totals", () => {
  const index = indexOf("many", manyChats());
  const context: CountContext = { ...NO_RANGE, people: () => PEOPLE };
  const read = <T>(budget: number, work: (counts: PeopleCounts) => T) => peopleCountsOf(index, context, BOTH, budget, work);
  const ada: Subject = { person: "person:ada", handles: ADA };
  const raj: Subject = { person: "person:raj", handles: [RAJ] };

  it("P2 the order, the reach and the chats are a count with no range, over the fact rows; what is planned is left out", () => {
    const subjects: Subject[] = [ada, raj, { person: "person:bob", handles: [BOB] }, { chat: GROUP }, { chat: ADA_CHAT }];
    const touches = read(10_000, (counts) => counts.touch(subjects));
    const expected = subjects.map((subject) => ("chat" in subject ? oracle(index, PEOPLE, { of: "messages", chat: subject.chat }).total
      : oracle(index, PEOPLE, { of: "messages", person: subject.person }).total + oracle(index, PEOPLE, { of: "calls", person: subject.person }).total));
    expect(touches).toEqual(expected);
    expect(oracle(index, PEOPLE, { of: "messages", person: "person:ada", to: "2026-11-30" }).total).toBe(oracle(index, PEOPLE, { of: "messages", person: "person:ada" }).total + 2);

    const reached = read(10_000, (counts) => counts.reach(ada))!;
    expect(reached.reach).toEqual(oracleReach(index, PEOPLE, { person: "person:ada" }, ["calls", "messages"]));
    expect(reached.reach.messages![2]).toBe("2026-10-29");
    const byChat = oracle(index, PEOPLE, { of: "messages", person: "person:ada", by: "chat" });
    expect(new Map(reached.chats.map(({ chat, messages }) => [chat, messages])))
      .toEqual(new Map(byChat.rows.map((row) => [row[byChat.columns.indexOf("chat")], row[byChat.columns.indexOf("n")]])));
    expect(reached.chats.map(({ chat }) => chat).sort()).toEqual([ADA_CHAT, GROUP, GROUP2].sort());
    expect(read(10_000, (counts) => counts.reach(raj))!.reach).toEqual(oracleReach(index, PEOPLE, { person: "person:raj" }, ["calls", "messages"]));
    expect(read(10_000, (counts) => counts.reach(raj))!.reach.calls).toBeUndefined();

    const group = read(10_000, (counts) => counts.reach({ chat: GROUP }))!;
    expect(group).toEqual({ reach: oracleReach(index, PEOPLE, { chat: GROUP }, ["messages"]), chats: [{ chat: GROUP, messages: oracle(index, PEOPLE, { of: "messages", chat: GROUP }).total }] });
  });

  it("P3 two handles of one person on one fact count once", () => {
    const [both, first, second] = read(10_000, (counts) => counts.touch([ada, { person: "a", handles: [ADA[0]!] }, { person: "b", handles: [ADA[1]!] }]));
    expect(first! + second! - both!).toBe(10);
  });

  it("P4 a budget of a few rows answers capped: the subject it ran out in and those after are not counted", () => {
    const subjects: Subject[] = [raj, ada, { chat: GROUP }];
    const whole = read(10_000, (counts) => counts.touch(subjects));
    for (let budget = 1; budget < 200; budget++) {
      const { touches, capped, spent } = read(budget, (counts) => ({ touches: counts.touch(subjects), capped: counts.capped, spent: counts.spent }));
      expect(spent).toBeLessThanOrEqual(budget);
      const counted = touches.findIndex((each) => each === undefined);
      expect(touches.slice(0, counted < 0 ? undefined : counted)).toEqual(whole.slice(0, counted < 0 ? undefined : counted));
      if (counted >= 0) expect(touches.slice(counted).every((each) => each === undefined)).toBe(true);
      expect(capped).toBe(counted >= 0);
    }
    expect(read(3, (counts) => counts.reach(ada))).toBeUndefined();
  });

  it("P5 a plain size is the count of its filter and its first and last day, on the same meter; past it, capped", () => {
    const ask = countAsked({ of: "messages", limit: "1", "match.direction": "sent" }, COLLECTIONS);
    const sized = index.snapshot({}, (record) => record.facts((facts) => {
      const counts = new PeopleCounts(facts, context, BOTH, 10_000);
      return counts.size(ask, admitted(ask, context));
    }));
    const total = oracle(index, PEOPLE, { of: "messages", "match.direction": "sent" }).total;
    const byDay = oracle(index, PEOPLE, { of: "messages", "match.direction": "sent", by: "day" });
    const days = byDay.rows.map((row) => String(row[byDay.columns.indexOf("day")])).sort();
    expect(sized).toEqual({ n: total, first: days[0], last: days.at(-1) });
    const late = index.snapshot({}, (record) => record.facts((facts) => {
      const counts = new PeopleCounts(facts, context, BOTH, 40);
      counts.touch([ada, raj]);
      return counts.size(ask, admitted(ask, context));
    }));
    expect(late).toBe("capped");
  });

  it("P6 a subject counted before the meter ran out keeps its numbers: its reach and chats are given after", () => {
    const whole = read(10_000, (counts) => counts.reach(ada));
    const budget = Array.from({ length: 400 }, (_, at) => at + 1).find((each) => read(each, (counts) => counts.touch([ada])[0] !== undefined))!;
    const { touches, reached, capped } = read(budget, (counts) => ({ touches: counts.touch([ada, raj]), reached: counts.reach(ada), capped: counts.capped }));
    expect(touches[1]).toBeUndefined();
    expect(capped).toBe(true);
    expect(reached).toEqual(whole);
  });
});

const admitted = (ask: CountAsk, context: CountContext) => (read: FactsRead): Admission => admit(resolve(read, ask, context), ALWAYS) as Admission;


describe("a size whose filter's vocabulary is larger than the budget", () => {
  const days = new Map<string, DayFileFact[]>();
  for (let at = 0; at < 1_500; at++) add(days, message(D("2026-09-01") + (at % 50) * DAY_MS + at * 1_000, `whatsapp:1555${String(2_000_000 + at)}@s.whatsapp.net`, true, [BOB]));
  const index = indexOf("vocabulary", days);
  const context: CountContext = { ...NO_RANGE, people: () => PEOPLE };
  const chats: CountAsk = { of: "messages", op: "count", by: [], person: [], match: { chat: "nobody example" }, limit: 1 };

  it("P7 resolving and binding read on the answer's meter: past it, capped, the rows read within the budget and its proof margin", () => {
    const sized = (budget: number) => {
      const before = rowsCounted();
      const answer = index.snapshot({}, (record) => record.facts((facts) => {
        const counts = new PeopleCounts(facts, context, BOTH, budget);
        return { size: counts.size(chats, admitted(chats, context)), capped: counts.capped, spent: counts.spent };
      }));
      return { ...answer, rows: rowsCounted() - before };
    };
    const enough = sized(100_000);
    expect(enough).toMatchObject({ size: null, capped: false });
    expect(enough.rows).toBeGreaterThan(1_500);
    for (const budget of [300, 1_000]) {
      const small = sized(budget);
      expect(small.size, `${budget}`).toBe("capped");
      expect(small.capped).toBe(true);
      expect(small.rows, `${budget}`).toBeLessThanOrEqual(ceilingOf(budget));
    }
  });
});

const SAMS = Array.from({ length: 299 }, (_, at) => ({ person: `person:sam-${at}`, handles: [`phone:+1555${String(1_000_000 + at).padStart(7, "0")}`] }));
const SAM_GROUP = "whatsapp:120363000000000099@g.us";

function samsHome(group: number): Map<string, DayFileFact[]> {
  const days = new Map<string, DayFileFact[]>();
  for (const [at, sam] of SAMS.entries()) {
    const chat = `whatsapp:${sam.handles[0]!.slice("phone:+".length)}@s.whatsapp.net`;
    for (let i = 0; i < 3; i++) add(days, message(D("2026-07-01") + ((at * 7 + i * 31) % 100) * DAY_MS + 3_600_000, chat, i === 1, sam.handles));
  }
  const members = SAMS.slice(0, 5).flatMap((sam) => sam.handles);
  const facts: DayFileFact[] = [];
  for (let i = 0; i < group; i++) {
    const day = i % 100, who = Math.floor(i / 100) % 6;
    facts.push(message(D("2026-07-01") + day * DAY_MS + 7_200_000 + (i % 3_600_000), SAM_GROUP, who === 5, who === 5 ? members : [members[who]!]));
  }
  for (const fact of facts) add(days, fact);
  return days;
}

describe("search_people of a name 300 match", () => {
  const subjects: Subject[] = [...SAMS, { chat: SAM_GROUP }];
  const expectedRows = (index: SearchIndex): number => {
    const db = new Database(join(dir, index === small ? "sams-small" : "sams-large", "index.db"), { readonly: true });
    try {
      const n = (sql: string, ...args: unknown[]) => db.prepare(sql).pluck().get(...args) as number;
      const handles = JSON.stringify(SAMS.flatMap((sam) => sam.handles));
      const crews = n("SELECT count(*) FROM crew_members WHERE handle IN (SELECT value FROM json_each(?))", handles);
      const totals = n("SELECT count(*) FROM totals WHERE of IN ('calls', 'messages') AND crew IN (SELECT crew FROM crew_members WHERE handle IN (SELECT value FROM json_each(?)))", handles);
      const combos = n("SELECT count(*) FROM combo_keys k JOIN names v ON v.id = k.name WHERE k.of = 'messages' AND k.key = 'chat' AND v.role = 'value' AND v.name = ?", SAM_GROUP);
      const groupTotals = n("SELECT count(*) FROM totals WHERE of = 'messages' AND combo IN (SELECT k.combo FROM combo_keys k JOIN names v ON v.id = k.name WHERE k.of = 'messages' AND k.key = 'chat' AND v.role = 'value' AND v.name = ?)", SAM_GROUP);
      const theirs = "SELECT DISTINCT combo FROM totals WHERE of = 'messages' AND crew IN (SELECT crew FROM crew_members WHERE handle IN (SELECT value FROM json_each(?)))";
      const keys = n(`SELECT count(*) FROM (${theirs})`, handles);
      const chats = n(`SELECT count(DISTINCT name) FROM combo_keys WHERE of = 'messages' AND key = 'chat' AND combo IN (${theirs})`, handles);
      return crews + totals + 1 + combos + groupTotals + keys + chats;
    } finally {
      db.close();
    }
  };
  const small = indexOf("sams-small", samsHome(20_000));
  const large = indexOf("sams-large", samsHome(200_000));
  const touched = (index: SearchIndex) => peopleCountsOf(index, { ...NO_RANGE, people: () => PEOPLE }, BOTH, 100_000, (counts) => ({ touches: counts.touch(subjects), spent: counts.spent }));

  it("P1 the rows read are the candidates' crews and combinations, the same at 200,000 facts as at 20,000", () => {
    const [few, many] = [touched(small), touched(large)];
    expect(few.touches.at(-1)).toBe(20_000);
    expect(many.touches.at(-1)).toBe(200_000);
    expect(few.spent).toBe(expectedRows(small));
    expect(many.spent).toBe(few.spent);
    const people = peopleOf(Object.fromEntries(SAMS.map((sam) => [sam.person, { name: "Sam Example", handles: [...sam.handles] }])));
    expect(few.touches[5]).toBe(3);
    expect(few.touches[0]).toBe(oracle(small, people, { of: "messages", person: "person:sam-0" }).total);
  });
});
