import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DaySettings } from "@lifestreamprotocol/core";
import { CALLS_COLLECTIONS, healthFamily, MONEY_COLLECTIONS, type DayFileFact } from "@lifestreamprotocol/families";
import { notNow } from "./refusal.js";
import { SearchIndex, type RecordEntry } from "./search-index.js";
import type { Admission, CountAnswer, CountContext, PeopleMap } from "./counting.js";
import { admit, ALWAYS } from "./count.js";
import { countAsked, readsOfIndex, countOf, shown } from "./test/record-reads.js";
import { openHomeFolder } from "@lifestreamprotocol/core";


const SETTINGS: DaySettings = { zone: "UTC", day_start_hour: 0 };
const D = (day: string, time = "00:00") => Date.parse(`${day}T${time}:00Z`);
const MIN = 60_000;
const dir = mkdtempSync(join(tmpdir(), "lifestream-count-also-"));
let index: SearchIndex;

const ADA = ["+15550000001", "ada@example.com"];
const PEOPLE: PeopleMap = {
  version: "people-1",
  idOf: (id) => (id === "person:ada" || ADA.includes(id) ? "person:ada" : undefined),
  person: (id) => (id === "person:ada" ? { name: "Ada Example", handles: ADA } : undefined),
  find: (name) => ("ada example".includes(name.toLowerCase()) ? ["person:ada"] : []),
};
const COLLECTIONS = new Map(Object.entries({ ...CALLS_COLLECTIONS, ...MONEY_COLLECTIONS, ...healthFamily([]).collections }));
const FAMILIES: Record<string, string[]> = { payments: ["money"], calls: ["calls"], days: ["health"], workouts: ["health"] };
const REGISTRY = ["calls", "health", "mail", "messages", "money"];
const SOURCES: Record<string, { id: string; product: string; read_through_ms: number | null }[]> = { money: [{ id: "bank:acct:a", product: "bank", read_through_ms: D("2026-10-31", "18:00") }] };
const context = (over: Partial<CountContext> = {}): CountContext => ({
  collections: COLLECTIONS, settings: SETTINGS, now_ms: D("2026-10-30", "12:00"), people: () => PEOPLE,
  families: REGISTRY, familiesOf: (of) => FAMILIES[of] ?? [], sources: (family) => SOURCES[family] ?? [], ...over,
});

const payment = (key: string, day: string, payee: string, amount: string): DayFileFact => ({
  id: `payments:${key.padStart(24, "0")}`, family: "money", of: "payments", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { payee, direction: "debit", currency: "EUR" }, measures: { amount }, who: [], from: { units: [`money/${key}`], record: { source: "bank:acct:a", kind: "payment", key }, alone: true }, lines: [],
});
const call = (key: string, start: number, minutes: number, who: string[]): DayFileFact => ({
  id: `calls:${key.padStart(24, "0")}`, family: "calls", of: "calls", time_ms: start, start_ms: start, end_ms: start + minutes * MIN,
  keys: { service: "whatsapp", direction: "outgoing", outcome: "connected" }, measures: { minutes },
  who: who.map((handle) => ({ handle, role: "receiver" as const })), from: { units: [`calls/${key}`], record: { source: "wa:local:a", kind: "call", key }, alone: true }, lines: [],
});
const night = (day: string, asleep: number, inBed: number): DayFileFact => ({
  id: `days:${`${day}watch`.replace(/\W/gu, "").padStart(24, "0").slice(-24)}`, family: "health", of: "days", time_ms: D(day), start_ms: D(day), end_ms: D(day), date_only: true,
  keys: { instrument: "Watch" }, measures: { asleep_min: asleep, in_bed_min: inBed, steps: 8000 }, who: [], from: { units: [`health/${day}`], instrument: "Watch" }, lines: [],
});
const record = (family: string, source: string, kind: string, key: string, at: number, text: string, who: string[] = []): RecordEntry => ({
  record: { source, kind, key }, family, version: "v1", start_ms: at, end_ms: null, title: "", text, who, link: null,
});

const DAYS: Record<string, DayFileFact[]> = {
  "2026-09-20": [],
  "2026-10-01": [night("2026-10-01", 398, 433)],
  "2026-10-02": [payment("p1", "2026-10-02", "ACME CABS LIMITED", "50.00"), night("2026-10-02", 397, 432)],
  "2026-10-03": [call("c1", D("2026-10-03", "09:00"), 10, [ADA[0]!]), night("2026-10-03", 399, 434)],
  "2026-10-04": [],
  "2026-10-05": [payment("p2", "2026-10-05", "ACME CABS LIMITED", "20.00"), payment("p3", "2026-10-05", "SYNTHETIC GROCER", "9.00")],
  "2026-10-07": [],
};

beforeAll(() => {
  index = SearchIndex.write(openHomeFolder(dirname(join(dir, "index.db"))), join(dir, "index.db"), () => true, 0, SETTINGS);
  index.records([
    record("money", "bank:acct:a", "payment", "p1", D("2026-10-02"), "UPI-ACME CABS LIMITED-ride"),
    record("money", "bank:acct:a", "payment", "p2", D("2026-10-05"), "UPI-ACME CABS LIMITED-ride"),
    record("money", "bank:acct:a", "payment", "p3", D("2026-10-05"), "POS SYNTHETIC GROCER"),
    record("mail", "mail:person-a@example.com", "message", "m1", D("2026-10-03", "21:13"), "Alert: EUR 7.00 debited from account ending 0002 to ACME CABS"),
    record("mail", "mail:person-a@example.com", "message", "m2", D("2026-10-07", "08:00"), "Your ACME CABS receipt"),
    record("mail", "mail:person-a@example.com", "message", "m3", D("2026-09-20", "08:00"), "Your ACME CABS receipt"),
    record("mail", "mail:person-a@example.com", "message", "m4", D("2026-10-04", "08:00"), "The weekly newsletter"),
    record("messages", "wa:local:a", "msg", "w1", D("2026-10-04", "10:06"), "see you at the gym", [ADA[0]!]),
  ], [], { position: { seq: 1, statement: "s-1", reread: 0 } });
  for (const [day, facts] of Object.entries(DAYS)) {
    index.day(day, { inputs: `in-${day}`, mtime_us: 1, atoms: [], facts: { window: { start_ms: D(day), end_ms: D(day) + 86_400_000 }, facts } });
  }
});

afterAll(() => {
  index.close();
  rmSync(dir, { recursive: true, force: true });
});

type Shown = { counted?: string; also?: string[]; total: Record<string, unknown> };
const run = (params: Record<string, string>, over: Partial<CountContext> = {}): Shown => {
  const answer = shown(countOf(index, countAsked(params, COLLECTIONS), context(over))) as unknown as Shown & { total: Record<string, unknown> | Record<string, unknown>[] };
  return { ...answer, total: Array.isArray(answer.total) ? answer.total[0]! : answer.total };
};
const OCTOBER = { from: "2026-10-01", to: "2026-10-31" };

describe("a number says what it cannot see", () => {
  it("S1 S2 a payee's sum names the other family's things the same words reach in the range, with their count and first and last day", () => {
    const answer = run({ of: "payments", measure: "amount", "match.payee": "acme", ...OCTOBER });
    expect(answer.total).toMatchObject({ n: 2, sum: "70.00 EUR" });
    expect(answer.also).toEqual([expect.stringMatching(/^the record also holds 2 mail entries the same words reach in the range, 2026-10-03 → 2026-10-07: the same kind of thing, held elsewhere: read it, add what these rows do not already hold, and give the whole first$/u)]);
    expect(answer.also!.join(" ")).not.toMatch(/money|2026-09-20/u);
    expect(answer.counted).toBe("counted from payments as bank:acct:a states them, read to 2026-10-31");
    expect([answer.counted, ...answer.also!].join(" ")).not.toMatch(/nothing else|not in this number/u);
  });

  it("S2 a filter no other family matches, a count of everything and a structure key alone name nothing else", () => {
    expect(run({ of: "payments", "match.payee": "grocer", ...OCTOBER }).also).toBeUndefined();
    expect(run({ of: "payments", ...OCTOBER }).also).toBeUndefined();
    expect(run({ of: "payments", "match.direction": "debit", ...OCTOBER }).also).toBeUndefined();
    const { familiesOf: _families, ...unsaid } = context();
    expect((shown(countOf(index, countAsked({ of: "payments", "match.payee": "acme", ...OCTOBER }, COLLECTIONS), unsaid)) as Shown).also).toBeUndefined();
  });

  it("S7 the families also looks in are the home's registry's: one the registry does not configure is never named", () => {
    expect(run({ of: "payments", "match.payee": "acme", ...OCTOBER }, { families: ["money", "messages"] }).also).toBeUndefined();
    expect(run({ of: "payments", "match.payee": "acme", ...OCTOBER }, { families: ["mail", "money"] }).also?.length).toBe(1);
    const { families: _registry, ...unsaid } = context();
    expect((shown(countOf(index, countAsked({ of: "payments", "match.payee": "acme", ...OCTOBER }, COLLECTIONS), unsaid)) as Shown).also).toBeUndefined();
  });

  it("S3 a person's count names the person's things in another family", () => {
    const answer = run({ of: "calls", person: ADA[0]!, ...OCTOBER });
    expect(answer.total).toMatchObject({ n: 1 });
    expect(answer.also).toEqual(["the record also holds 1 messages entry the same person reaches in the range, 2026-10-04 → 2026-10-04: the same kind of thing, held elsewhere: read it, add what these rows do not already hold, and give the whole first"]);
  });

  it("S4 a count read in steps names nothing else; the same ask counted plain names the mails", async () => {
    const ask = countAsked({ of: "payments", "match.payee": "acme", ...OCTOBER }, COLLECTIONS);
    const reads = readsOfIndex(index, context());
    const candidates = await reads.resolve(ask, {});
    const stepped = await reads.count(ask, admit(candidates, ALWAYS) as Admission, null) as CountAnswer;
    expect(stepped.also).toBeUndefined();
    expect(run({ of: "payments", "match.payee": "acme", ...OCTOBER }).also).toHaveLength(1);
  });

  it("S5 S8 a number says what it counted from: each source read to its own read-through, else the day of its last matching fact", () => {
    expect(run({ of: "payments", measure: "amount", "match.payee": "acme", ...OCTOBER }).counted)
      .toBe("counted from payments as bank:acct:a states them, read to 2026-10-31");
    expect(run({ of: "payments", "match.payee": "acme", from: "2026-10-01", to: "2026-10-03" }).counted)
      .toBe("counted from payments as bank:acct:a states them, read to 2026-10-31");
    expect(run({ of: "payments", "match.payee": "acme", ...OCTOBER }, { sources: () => [] }).counted)
      .toBe("counted from payments as bank:acct:a states them, last matching fact 2026-10-05");
    expect(run({ of: "payments", "match.payee": "acme", ...OCTOBER }, { sources: () => notNow("starting", "Lifestream is starting.") }).counted)
      .toBe("counted from payments as bank:acct:a states them, last matching fact 2026-10-05");
    expect(run({ of: "days", measure: "asleep_min", from: "2026-10-01", to: "2026-10-03" }).counted)
      .toBe("counted from days as Watch states them, last matching fact 2026-10-03");
    expect(run({ of: "payments", "match.payee": "nobody", ...OCTOBER }).counted).toBe("counted from payments: no source states one in the range under these filters");
  });

  it("S6 a measure with a sibling reading states each in words in its total; one with none states no words", () => {
    const avg = run({ of: "days", measure: "asleep_min", op: "avg", from: "2026-10-01", to: "2026-10-03" });
    expect(avg.total).toMatchObject({ avg: 398, in_bed_min: 433, said: "avg: asleep 6 h 38 min; in bed 7 h 13 min" });
    const sum = run({ of: "days", measure: "in_bed_min", op: "sum", from: "2026-10-01", to: "2026-10-03" });
    expect(sum.total).toMatchObject({ said: "sum: in bed 21 h 39 min; asleep 19 h 54 min" });
    expect(run({ of: "days", measure: "steps", from: "2026-10-01", to: "2026-10-03" }).total).not.toHaveProperty("said");
  });
});
