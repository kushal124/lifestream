import { describe, expect, it } from "vitest";
import { instant, type DaySettings } from "@lifestreamprotocol/core";
import { dayFacts } from "../days.js";
import { collectionsFault } from "../family.js";
import { factsConform, insertKeepsFacts } from "../test/facts.js";
import { dayInput, type Content } from "../test/day-input.js";
import { moneyFamily, payeeOf, type DateRun, type StatementLine } from "./family.js";

const SETTINGS: DaySettings = { zone: "America/Los_Angeles", day_start_hour: 4 };
const MONEY = moneyFamily([]);
const INR = "example-bank:00000000001234:export";
const USD = "example-card:00000000005678:export";

function run(source: string, date: string, lines: StatementLine[]): Content {
  const content: DateRun = { date, opening: null, lines, breaks: lines.map(() => null) };
  const start_ms = instant(date, "date").start_ms;
  return { unit: `${source}/${date}`, content, start_ms, end_ms: start_ms + 86_400_000 };
}

const line = (key: string, direction: "debit" | "credit", amount: string, balance: string, currency: string, narration: string): StatementLine =>
  ({ key, direction, amount, balance, currency, narration });

const RECORD: Content[] = [
  run(INR, "2026-09-03", [
    line("t1", "debit", "1200.50", "13549.50", "INR", "POS 0000XXXXXX0001 SYNTHETIC GROCER"),
    line("t2", "debit", "99.00", "13450.50", "INR", "UPI-STREAMING-stream@fakebank-SUBSCRIPTION"),
  ]),
  run(USD, "2026-09-03", [line("c1", "debit", "0.10", "100.20", "USD", "EXAMPLE CAFE")]),
];
const input = (day: string, contents: readonly Content[] = RECORD) => dayInput(MONEY, day, contents, SETTINGS);

describe("money facts", () => {
  it("declares collections that hold together", () => {
    expect(collectionsFault([MONEY])).toEqual([]);
  });

  it("a payment is date-only, on its statement date in every zone, never the evening before", () => {
    const projection = MONEY.day(input("2026-09-03"));
    expect(projection.facts).toHaveLength(3);
    for (const fact of projection.facts) {
      expect(fact.date_only).toBe(true);
      expect(fact.time_ms).toBe(Date.UTC(2026, 8, 3));
    }
    expect(dayFacts(MONEY, projection, "2026-09-03", SETTINGS, (index) => index)).toHaveLength(3);
    expect(dayFacts(MONEY, projection, "2026-09-02", SETTINGS, (index) => index)).toEqual([]);
  });

  it("an amount is a decimal string in its own currency: two currencies are two totals, never one", () => {
    const facts = MONEY.day(input("2026-09-03")).facts;
    const totals = new Map<string, bigint>();
    for (const fact of facts) {
      expect(typeof fact.measures["amount"]).toBe("string");
      const currency = fact.keys["currency"]!;
      totals.set(currency, (totals.get(currency) ?? 0n) + BigInt((fact.measures["amount"] as string).replace(".", "")));
    }
    expect(Object.fromEntries(totals)).toEqual({ INR: 129950n, USD: 10n });
    expect(facts.map((fact) => [fact.keys["currency"], fact.measures["amount"], fact.measures["balance"]])).toEqual([
      ["INR", "1200.50", "13549.50"], ["INR", "99.00", "13450.50"], ["USD", "0.10", "100.20"],
    ]);
  });

  it("the payee and the rail are read from the narration, as the bank spelled them", () => {
    expect(MONEY.day(input("2026-09-03")).facts.map((fact) => fact.keys)).toEqual([
      { payee: "SYNTHETIC GROCER", account: "bank", direction: "debit", channel: "POS", currency: "INR" },
      { payee: "STREAMING", account: "bank", direction: "debit", channel: "UPI", currency: "INR" },
      { payee: "EXAMPLE CAFE", account: "bank", direction: "debit", currency: "USD" },
    ]);
    expect(payeeOf("UPI-SHOP ONE-shop1@fakebank-PAYMENT")).toEqual({ payee: "SHOP ONE", channel: "UPI" });
    expect(payeeOf("NEFT CR-EXMP0000001-PERSON B-SYNTHETIC")).toEqual({ payee: "PERSON B", channel: "NEFT" });
    expect(payeeOf("IMPS-612345678901-PERSON C-EXMP-XXXXXXX1234")).toEqual({ payee: "PERSON C", channel: "IMPS" });
    expect(payeeOf("ATW-0000XXXXXX0001-SYNTHETIC ATM")).toEqual({ payee: "SYNTHETIC ATM", channel: "ATW" });
    expect(payeeOf("SALARY SYNTHETIC EMPLOYER")).toEqual({ payee: "SALARY SYNTHETIC EMPLOYER", channel: null });
    expect(payeeOf("UPIX STORE")).toEqual({ payee: "UPIX STORE", channel: null });
    expect(payeeOf("0000123456")).toEqual({ payee: null, channel: null });
  });

  it("holds to F1's conformance: order and an inserted line", () => {
    expect(factsConform(MONEY, ["2026-09-02", "2026-09-03"].map((day) => input(day)))).toEqual([]);
    const more = [run(INR, "2026-09-03", [line("t0", "credit", "5.00", "14750.00", "INR", "REFUND"), ...(RECORD[0]!.content as DateRun).lines]), RECORD[1]!];
    expect(insertKeepsFacts(MONEY, input("2026-09-03"), input("2026-09-03", more))).toEqual([]);
  });
});
