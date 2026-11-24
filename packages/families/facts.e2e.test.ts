import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { accountOf, daysOf, digest, sourceName, type DaySettings, type ExtractRow, type Json, type SourceRow } from "@lifestreamprotocol/core";
import { accountFaults, checkDayFile, DayFactError, renderDay, tableUnits, type DayDocument, type DayFileFact, type DayReader } from "./days.js";
import { collectionsFault, factId, OPS, type Collection, type DayFact, type DayInput, type DayLine, type Family, type Measure } from "./family.js";
import { buildLabels, labelsFrom } from "./shared/labels.js";
import { factsConform, insertKeepsFacts } from "./test/facts.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "test", "facts");
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const SOURCE = "example-tally:acct-aa01:mac-0001";
const SOURCE_ROW: SourceRow = { ...sourceName(SOURCE), vendor: "example", id: SOURCE, connector: "example-tally", options: {}, read_through_ms: null, added_ms: 0 };
const MINUTE = 60_000;
const at = (local: string) => Date.parse(`${local}-04:00`);


type Entry =
  | { kind: "call"; key: string; start_ms: number; end_ms: number; with: string; direction: "in" | "out"; service: string }
  | { kind: "sitting"; key: string; start_ms: number; end_ms: number; apps: [string, number][] }
  | { kind: "payment"; key: string; date: string; payee: string; amount: string; balance: string; currency: string };

const total: Measure["ops"] = OPS;
const COLLECTIONS: Record<string, Collection> = {
  calls: { keys: ["service", "direction"], measures: { minutes: { unit: "min", ops: total, time: "start", split: "clock", from: "derived" } } },
  screen_time: { keys: ["app"], measures: { minutes: { unit: "min", ops: total, time: "start", split: "whole", from: "stated" } } },
  payments: {
    keys: ["payee", "direction", "currency"],
    measures: {
      amount: { unit: "currency", ops: total, time: "start", split: "whole", from: "stated" },
      balance: { unit: "currency", ops: ["min", "max", "first", "last"], time: "start", split: "whole", from: "stated" },
    },
  },
};

function tallyDay(input: DayInput): { lines: DayLine[]; facts: DayFact[] } {
  const lines: DayLine[] = [];
  const facts: DayFact[] = [];
  for (const extract of input.extracts) {
    const entry = extract.content as unknown as Entry;
    const record = { source: SOURCE, kind: entry.kind, key: entry.key };
    const line = lines.push(entry.kind === "payment"
      ? { family: "tally", unit: extract.unit, units: [extract.unit], start_ms: Date.parse(entry.date), end_ms: null, date_only: true, text: `${entry.amount} ${entry.currency} to ${entry.payee}`, record }
      : entry.kind === "call"
        ? { family: "tally", unit: extract.unit, units: [extract.unit], start_ms: entry.start_ms, end_ms: entry.end_ms, text: `Call ${entry.direction === "out" ? "to" : "from"} ${entry.with}`, record }
        : { family: "tally", unit: extract.unit, units: [extract.unit], start_ms: entry.start_ms, end_ms: entry.end_ms, text: `At the Mac: ${entry.apps.map(([app]) => app).join(", ")}`, record }) - 1;
    if (entry.kind === "call") {
      facts.push({
        of: "calls", id: factId("calls", `${SOURCE}/${entry.key}`), time_ms: entry.start_ms, start_ms: entry.start_ms, end_ms: entry.end_ms,
        keys: { service: entry.service, direction: entry.direction }, measures: { minutes: (entry.end_ms - entry.start_ms) / MINUTE },
        who: [{ handle: entry.with, role: entry.direction === "out" ? "receiver" : "sender" }], from: { units: [extract.unit], record, alone: true }, lines: [line],
      });
    } else if (entry.kind === "sitting") {
      for (const [app, minutes] of entry.apps) {
        facts.push({
          of: "screen_time", id: factId("screen_time", `${extract.unit}/${app}`), time_ms: entry.start_ms, start_ms: entry.start_ms, end_ms: entry.end_ms,
          keys: { app }, measures: { minutes }, who: [], from: { units: [extract.unit], accounts: [accountOf(SOURCE)] }, lines: [line],
        });
      }
    } else {
      const day = Date.parse(entry.date);
      facts.push({
        of: "payments", id: factId("payments", `${SOURCE}/${entry.key}`), time_ms: day, start_ms: day, end_ms: day, date_only: true,
        keys: { payee: entry.payee, direction: entry.amount.startsWith("-") ? "out" : "in", currency: entry.currency },
        measures: { amount: entry.amount, balance: entry.balance }, who: [], from: { units: [extract.unit], record, alone: true }, lines: [line],
      });
    }
  }
  return { lines, facts };
}

function tallyFamily(day: (input: DayInput) => { lines: DayLine[]; facts: DayFact[] } = tallyDay, collections = COLLECTIONS): Family {
  return {
    name: "tally", type: null, code: "1",
    inputs: [{ sources: { product: ["example-tally"] }, kinds: ["call", "sitting", "payment"], role: "evidence" }],
    touched: () => [], extract: () => null,
    days: (extract, settings) => {
      const entry = extract.content as unknown as Entry;
      return entry.kind === "payment" ? [entry.date] : daysOf({ start_ms: entry.start_ms, end_ms: entry.end_ms, precision: "ms" }, settings);
    },
    day, collections,
  };
}

const TALLY = tallyFamily();


const ENTRIES: Entry[] = [
  { kind: "call", key: "c1", start_ms: at("2026-10-25T03:40"), end_ms: at("2026-10-25T04:40"), with: "+15550000001", direction: "out", service: "phone" },
  { kind: "sitting", key: "s1", start_ms: at("2026-10-25T09:00"), end_ms: at("2026-10-25T10:00"), apps: [["Mail", 25], ["Editor", 30], ["Browser", 5]] },
  { kind: "call", key: "c2", start_ms: at("2026-10-25T14:00"), end_ms: at("2026-10-25T14:30"), with: "+15550000002", direction: "in", service: "whatsapp" },
  { kind: "payment", key: "p1", date: "2026-10-25", payee: "Shop 4", amount: "-12.50", balance: "987.50", currency: "USD" },
];
const EARLIER: Entry = { kind: "call", key: "c0", start_ms: at("2026-10-25T08:00"), end_ms: at("2026-10-25T08:05"), with: "+15550000003", direction: "in", service: "phone" };

function rows(entries: readonly Entry[], family = TALLY): ExtractRow[] {
  return entries.map((entry, seq) => {
    const row: ExtractRow = { family: "tally", unit: `tally/${entry.key}`, reading: digest(entry as unknown as Json), code: "1", content: entry as unknown as Json, start_ms: null, end_ms: null, days: [], seq };
    return { ...row, days: family.days(row, SETTINGS) };
  });
}

const LABELS = buildLabels({ people: [], contacts: [], places: [] });

function render(day: string, entries: readonly Entry[] = ENTRIES, family = TALLY) {
  const all = rows(entries, family);
  const reader: DayReader = { extractsOn: (_family, on) => all.filter((row) => row.days.includes(on)), enrichment: () => undefined, sources: () => [SOURCE_ROW], since: (source) => (source === SOURCE ? 0 : undefined) };
  return renderDay(day, [family], reader, SETTINGS, tableUnits(LABELS));
}

const doc = (day: string, entries?: readonly Entry[], family?: Family) => JSON.parse(render(day, entries, family).json) as DayDocument;

function input(day: string, entries: readonly Entry[] = ENTRIES): DayInput {
  const extracts = rows(entries).filter((row) => row.days.includes(day)).sort((left, right) => (left.unit < right.unit ? -1 : 1));
  return { day, settings: SETTINGS, extracts, enrichments: new Map(), labels: labelsFrom(tableUnits(LABELS), SETTINGS), sources: new Map(), device: (unit) => unit };
}

const fixture = (day: string) => join(FIXTURE, `${day}.day.json`);

describe("facts: what must be impossible", () => {
  it("the fixture differs from renderDay of its record, or breaks the day file's shape", () => {
    for (const day of ["2026-10-24", "2026-10-25"]) {
      const { json } = render(day);
      if (UPDATE) {
        mkdirSync(FIXTURE, { recursive: true });
        writeFileSync(fixture(day), json);
      }
      expect(existsSync(fixture(day)), `${fixture(day)} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1 LIFESTREAM_TEST_HERE=1`).toBe(true);
      expect(json).toBe(readFileSync(fixture(day), "utf8"));
      expect(checkDayFile(JSON.parse(readFileSync(fixture(day), "utf8")))).toEqual([]);
    }
    const [before, after] = ["2026-10-24", "2026-10-25"].map((day) => JSON.parse(readFileSync(fixture(day), "utf8")) as DayDocument) as [DayDocument, DayDocument];
    const call = factId("calls", `${SOURCE}/c1`);
    const late = before.facts.find((fact) => fact.id === call)!;
    expect(late).toMatchObject({ time_ms: at("2026-10-25T03:40"), start_ms: at("2026-10-25T03:40"), end_ms: at("2026-10-25T04:40"), measures: { minutes: 60 } });
    expect(late.who).toEqual([{ handle: "+15550000001", role: "receiver" }]);
    expect("part" in late).toBe(false);
    expect(after.facts.some((fact) => fact.id === call)).toBe(false);
    const printed = after.atoms.find((atom) => atom.record?.key === "c1")!;
    expect([printed.start_ms, printed.end_ms]).toEqual([at("2026-10-25T04:00"), at("2026-10-25T04:40")]);
    expect(after.facts.some((fact) => fact.lines.includes(printed.n))).toBe(false);
    const apps = after.facts.filter((fact) => fact.of === "screen_time");
    expect(apps.map((fact) => [fact.keys.app, fact.measures.minutes])).toEqual(expect.arrayContaining([["Mail", 25], ["Editor", 30], ["Browser", 5]]));
    expect(new Set(apps.map((fact) => fact.lines.join()))).toEqual(new Set(["2"]));
    expect(after.atoms[1]!.text).toBe("At the Mac: Mail, Editor, Browser");
    const payment = after.facts.find((fact) => fact.of === "payments")!;
    expect(payment).toMatchObject({ date_only: true, measures: { amount: "-12.50", balance: "987.50" }, keys: { currency: "USD", direction: "out" } });
    expect(after.atoms[payment.lines[0]! - 1]!.flags).toEqual(["date_only"]);
  });

  it("the family breaks the conformance its facts hold to", () => {
    expect(factsConform(TALLY, ["2026-10-24", "2026-10-25", "2026-10-26"].map((day) => input(day)))).toEqual([]);
    expect(insertKeepsFacts(TALLY, input("2026-10-25"), input("2026-10-25", [...ENTRIES, EARLIER]))).toEqual([]);
    const numbered = tallyFamily((day) => {
      const projection = tallyDay(day);
      return { ...projection, facts: projection.facts.map((fact, index) => ({ ...fact, id: factId(fact.of, String(fact.lines[0])) + String(index) })) };
    });
    expect(insertKeepsFacts(numbered, input("2026-10-25"), input("2026-10-25", [...ENTRIES, EARLIER]))).not.toEqual([]);
    expect(factsConform(numbered, [input("2026-10-25")])).toEqual(["2026-10-25: a fact's id, time, provenance or lines move with the order of the extracts"]);
    const cut = tallyFamily((day) => {
      const projection = tallyDay(day);
      return { ...projection, facts: projection.facts.map((fact) => fact.of === "calls" && day.day === "2026-10-24" ? { ...fact, measures: { minutes: 50 } } : fact) };
    });
    expect(factsConform(cut, ["2026-10-24", "2026-10-25"].map((day) => input(day)))).toContain(`2026-10-25: ${factId("calls", `${SOURCE}/c1`)} is stated otherwise on another day`);
    const dropped = tallyFamily((day) => {
      const projection = tallyDay(day);
      return day.day === "2026-10-24" ? { ...projection, facts: projection.facts.filter((fact) => fact.of !== "calls") } : projection;
    });
    expect(factsConform(dropped, ["2026-10-24", "2026-10-25"].map((day) => input(day))))
      .toContain(`${factId("calls", `${SOURCE}/c1`)}: stated by no day, not by 2026-10-24, the one day of its time`);
  });

  it("a line or a fact that rests on no one record and states no accounts, or an account no source of the day has, passes the conformance", () => {
    expect(accountFaults(doc("2026-10-25"))).toEqual([]);
    const sitting = factId("screen_time", "tally/s1/Mail");
    const unstated = tallyFamily((day) => {
      const projection = tallyDay(day);
      return { lines: projection.lines.map(({ record: _record, ...line }) => line), facts: projection.facts.map((fact) => ({ ...fact, from: { units: fact.from.units } })) };
    });
    expect(accountFaults(doc("2026-10-25", ENTRIES, unstated))).toEqual(expect.arrayContaining([
      "2026-10-25 atom 2 (tally) states neither one record nor its accounts",
      `2026-10-25 fact ${sitting} (tally) states neither one record nor its accounts`,
    ]));
    const elsewhere = tallyFamily((day) => {
      const projection = tallyDay(day);
      return { ...projection, lines: projection.lines.map((line) => ({ ...line, accounts: ["example-other:acct-zz99"] })) };
    });
    expect(accountFaults(doc("2026-10-25", ENTRIES, elsewhere))).toContain("2026-10-25 atom 2 (tally) states account example-other:acct-zz99, which no evidence source of the day has");
  });

  it("a fact's place in the day file moves with a line inserted before it", () => {
    const one = doc("2026-10-25");
    const two = doc("2026-10-25", [...ENTRIES, EARLIER]);
    const strip = (facts: DayFileFact[]) => facts.map(({ lines: _lines, ...rest }) => rest);
    expect(strip(two.facts.filter((fact) => !fact.from.units.includes("tally/c0")))).toEqual(strip(one.facts));
    const cited = (document: DayDocument) => new Map(document.facts.map((fact) => [fact.id, fact.lines.map((n) => document.atoms[n - 1]!.text)]));
    const was = cited(one);
    for (const [id, texts] of cited(two)) if (was.has(id)) expect(texts).toEqual(was.get(id));
  });

  it("a fact across midnight is stated by two days, or in part", () => {
    const documents = ["2026-10-24", "2026-10-25"].map((day) => doc(day));
    expect(documents.map((document) => document.facts.filter((fact) => fact.of === "calls").map((fact) => fact.measures.minutes))).toEqual([[60], [30]]);
    const ids = documents.flatMap((document) => document.facts.map((fact) => fact.id));
    expect(new Set(ids).size).toBe(ids.length);
    const [before, after] = documents as [DayDocument, DayDocument];
    const borrowed = { ...after, facts: [...after.facts, { ...before.facts.find((fact) => fact.of === "calls")!, lines: [] }] };
    expect(checkDayFile(borrowed)).toContain(`$.facts[${after.facts.length}]'s time is not in the day: another day states it`);
  });

  it("a changed fact leaves the cited day's revision as it was", () => {
    const one = render("2026-10-25");
    const longer = ENTRIES.map((entry) => entry.kind === "call" && entry.key === "c2" ? { ...entry, end_ms: entry.end_ms + 10 * MINUTE } : entry);
    const two = render("2026-10-25", longer);
    expect(two.inputs).not.toBe(one.inputs);
    expect(JSON.parse(two.json).inputs).toBe(two.inputs);
    expect(render("2026-10-25").json).toBe(one.json);
  });

  it("a fact the contract refuses is written", () => {
    const breaking = (change: (fact: DayFact) => DayFact | null, of = "calls") => tallyFamily((day) => {
      const projection = tallyDay(day);
      return { ...projection, facts: projection.facts.map((fact) => fact.of === of ? change(fact) ?? fact : fact) };
    });
    const cases: [string, Family][] = [
      ["is of no collection its family declares", breaking((fact) => ({ ...fact, of: "texts", id: factId("texts", fact.id) }))],
      ["has no id of its collection", breaking((fact) => ({ ...fact, id: "calls-1" }))],
      ["states key person, which its collection does not declare", breaking((fact) => ({ ...fact, keys: { ...fact.keys, person: "Person A" } }))],
      ["states measure seconds, which its collection does not declare", breaking((fact) => ({ ...fact, measures: { seconds: 60 } }))],
      ["states minutes as no number", breaking((fact) => ({ ...fact, measures: { minutes: "60" } }))],
      ["has a time that is not its span's start", breaking((fact) => ({ ...fact, time_ms: fact.end_ms }))],
      ["holds a person with no handle", breaking((fact) => ({ ...fact, who: [{ handle: "", role: "sender" }] }))],
      ["cites a line its projection does not hold", breaking((fact) => ({ ...fact, lines: [99] }))],
      ["states amount, a currency, as no decimal string", breaking((fact) => ({ ...fact, measures: { ...fact.measures, amount: -12.5 } }), "payments")],
      ["states amount as -12.505 USD, finer than its minor unit", breaking((fact) => ({ ...fact, measures: { ...fact.measures, amount: "-12.505" } }), "payments")],
      ["states amount in \"Rs\", which is no currency code", breaking((fact) => ({ ...fact, keys: { ...fact.keys, currency: "Rs" } }), "payments")],
      ["is date-only but not one date at midnight UTC", breaking((fact) => ({ ...fact, time_ms: fact.time_ms + 1, start_ms: fact.time_ms + 1, end_ms: fact.time_ms + 1 }), "payments")],
      ["is stated twice", tallyFamily((day) => {
        const projection = tallyDay(day);
        return { ...projection, facts: [...projection.facts, projection.facts[0]!] };
      })],
    ];
    for (const [why, family] of cases) expect(() => render("2026-10-25", ENTRIES, family), why).toThrow(new RegExp(why.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    expect(() => render("2026-10-25", ENTRIES, cases[0]![1])).toThrow(DayFactError);
    const clocked = { ...COLLECTIONS, payments: { ...COLLECTIONS.payments!, measures: { ...COLLECTIONS.payments!.measures, amount: { ...COLLECTIONS.payments!.measures.amount!, split: "clock" as const } } } };
    expect(() => render("2026-10-25", ENTRIES, tallyFamily(tallyDay, clocked))).toThrow(/a currency, split by the clock/u);
  });

  it("collections declared across families disagree, and nothing says so", () => {
    const sleep = (readings: string[]): Measure => ({ unit: "min", ops: OPS, time: "end", split: "whole", from: "stated", readings });
    const health = (measures: Record<string, Measure>): Family => ({ ...tallyFamily(), name: "health", collections: { days: { keys: ["weekday"], measures } } });
    expect(collectionsFault([TALLY, health({ asleep_min: sleep(["days.in_bed_min"]), in_bed_min: sleep(["days.asleep_min"]) })])).toEqual([]);
    expect(collectionsFault([health({ asleep_min: sleep(["days.in_bed_min"]) })])).toEqual(["days.asleep_min names days.in_bed_min, which no family declares"]);
    expect(collectionsFault([health({ asleep_min: sleep(["days.in_bed_min"]), in_bed_min: sleep([]) })])).toEqual(["days.in_bed_min does not name days.asleep_min back as a reading"]);
    expect(collectionsFault([health({ steps: sleep([]) }), { ...health({ steps: sleep([]) }), name: "phone" }])).toEqual(["days.steps is stated by health and phone"]);
    expect(collectionsFault([health({ recovery: { ...sleep([]), ops: ["sum", "median" as never] } })])).toEqual(["days.recovery permits an op not in OPS, or one twice"]);
    expect(collectionsFault([health({ spend: { ...sleep([]), unit: "currency", split: "clock" } })])).toEqual(["days.spend is a currency split by the clock"]);
  });
});
