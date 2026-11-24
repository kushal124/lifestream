import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { addDays, digest, instant, type Json, type ReaderOutput, type DaySettings } from "@lifestreamprotocol/core";
import { DayReadError, type DayDocument } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import { moneyFamily, type DateRun } from "./family.js";
import { PROOF_BANK } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { shuffled, TestHome } from "../test/drive.js";

const MONEY = moneyFamily(PROOF_BANK);
const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const NEW_YORK: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const BANK = "example-bank:00000000001234:export";
const STATEMENT_A = Date.UTC(2026, 8, 16);
const STATEMENT_B = Date.UTC(2026, 9, 1);

interface Entry { date: string; direction: "debit" | "credit"; cents: number; narration: string }

const ENTRIES: Entry[] = [
  { date: "2026-09-01", direction: "credit", cents: 5_000_00, narration: "SALARY SYNTHETIC EMPLOYER" },
  { date: "2026-09-01", direction: "debit", cents: 250_00, narration: "UPI-SHOP ONE-shop1@fakebank-PAYMENT" },
  { date: "2026-09-03", direction: "debit", cents: 1_200_50, narration: "POS 0000XXXXXX0001 SYNTHETIC GROCER" },
  { date: "2026-09-03", direction: "debit", cents: 99_00, narration: "UPI-STREAMING-stream@fakebank-SUBSCRIPTION" },
  { date: "2026-09-03", direction: "credit", cents: 99_00, narration: "REFUND STREAMING" },
  { date: "2026-09-12", direction: "debit", cents: 2_000_00, narration: "ATW-0000XXXXXX0001-SYNTHETIC ATM" },
  { date: "2026-09-14", direction: "debit", cents: 75_25, narration: "UPI-CAFE-cafe@fakebank-COFFEE" },
  { date: "2026-09-20", direction: "credit", cents: 300_00, narration: "NEFT CR-PERSON B-SYNTHETIC" },
  { date: "2026-09-28", direction: "debit", cents: 600_00, narration: "AUTO DEBIT SYNTHETIC INSURANCE" },
];

function lines(entries: readonly Entry[] = ENTRIES): (Entry & { balance: number })[] {
  let balance = 10_000_00;
  return entries.map((entry) => ({ ...entry, balance: (balance += entry.direction === "credit" ? entry.cents : -entry.cents) }));
}

function money(cents: number): string {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
}

function txn(line: Entry & { balance: number }, narration = line.narration): ReaderOutput {
  const amount = money(line.cents);
  const reference = `REF${line.balance}`;
  const identity = { date: line.date, value_date: line.date, debit: line.direction === "debit" ? amount : "", credit: line.direction === "credit" ? amount : "", reference, closing: money(line.balance) };
  return {
    kind: "txn", key: digest(identity).slice(7, 19), time: instant(line.date, "date"),
    content: { type: "bank.txn", date: line.date, value_date: line.date, [line.direction]: amount, currency: "INR", reference, narration, closing_balance: money(line.balance) },
  };
}

const all = lines();
const statementA = all.filter((line) => line.date <= "2026-09-15").map((line) => txn(line));
const statementB = all.filter((line) => line.date >= "2026-09-10").map((line) => txn(line, line.date === "2026-09-14" ? "UPI-CAFE-cafe@fakeba" : line.narration));

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(settings: DaySettings = NEW_YORK): TestHome {
  const home = new TestHome("families-money-", { families: [MONEY], settings: settings });
  home.addSource(BANK, "example-bank");
  homes.push(home);
  return home;
}

function runOf(home: TestHome, date: string): DateRun {
  return home.extracts("money").find((row) => row.unit === `${BANK}/${date}`)!.content as unknown as DateRun;
}

function golden(name: string, text: string): void {
  const path = new URL(name, GOLDEN);
  if (UPDATE) writeFileSync(path, text);
  expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}

describe("money family: what must be impossible", () => {
  it("a statement line's search text holds its amounts, balance or reference, or a line with no narration has one", () => {
    const home = newHome();
    home.deliver(BANK, STATEMENT_A, statementA);
    const silent = txn({ date: "2026-09-29", direction: "debit", cents: 1_00, narration: " ", balance: 1_00 });
    home.deliver(BANK, STATEMENT_B, [...statementB, silent]);
    const keyOf = (line: Entry & { balance: number }) => txn(line).key;
    expect(Object.fromEntries(home.texts(MONEY).map(({ record, text }) => [record, text]))).toEqual({
      ...Object.fromEntries(all.map((line) => [`${BANK} txn ${keyOf(line)}`,
        { text: line.date === "2026-09-14" ? "UPI-CAFE-cafe@fakeba" : line.narration }])),
      [`${BANK} txn ${silent.key}`]: null,
    });
    home.artifact("texts.json", home.texts(MONEY));
  });

  it("an extract is written when nothing it reads changed (a re-download, a line on a far date)", () => {
    const home = newHome();
    const first = home.deliver(BANK, STATEMENT_A, statementA);
    expect(first.written).toEqual(["2026-09-01", "2026-09-03", "2026-09-12", "2026-09-14"].map((date) => `money ${BANK}/${date}`));
    const again = home.deliver(BANK, STATEMENT_A + 1, shuffled(statementA, 3));
    expect(again.landed.restated).toBe(statementA.length);
    expect(again.written).toEqual([]);
    expect(again.days).toEqual([]);
    const far = home.deliver(BANK, STATEMENT_B, [txn({ date: "2026-12-15", direction: "debit", cents: 10_00, narration: "SYNTHETIC FAR LINE", balance: 1_00 })]);
    expect(far.touched).toEqual([`money ${BANK}/2026-12-15`]);
    expect(far.written).toEqual([`money ${BANK}/2026-12-15`]);
    expect(far.days).toEqual(["2026-12-15"]);
    const shorter = home.deliver(BANK, STATEMENT_B + 1, [txn(all[5]!, "ATW-0000XXXXXX0001-SYNTH")]);
    expect(shorter.landed.changedPaths).toEqual({ narration: 1 });
    expect(shorter.touched).toEqual([`money ${BANK}/2026-09-12`, `money ${BANK}/2026-09-14`]);
    expect(shorter.written).toEqual([`money ${BANK}/2026-09-12`]);
    expect(shorter.days).toEqual(["2026-09-12"]);
    home.artifact("rewrites.json", { first: first.written, again: again.written, far: far.written, shorter: shorter.written });
  });

  it("units differ when the same data arrives in another order", () => {
    const orders = [
      [[STATEMENT_A, statementA], [STATEMENT_B, statementB]],
      [[STATEMENT_B, statementB], [STATEMENT_A, statementA]],
    ] as const;
    const results = orders.map((order, index) => {
      const home = newHome();
      for (const [at, rows] of order) home.deliver(BANK, at, shuffled(rows, index + 11));
      return {
        extracts: home.extracts("money").map(({ unit, reading, content, days }) => ({ unit, reading, content, days })),
        days: ["2026-09-03", "2026-09-14", "2026-09-20"].map((day) => home.render(day, LABELS)),
        home,
      };
    });
    expect(results[1]!.extracts).toEqual(results[0]!.extracts);
    expect(results[1]!.days).toEqual(results[0]!.days);
    expect(runOf(results[0]!.home, "2026-09-14").lines[0]!.narration).toBe("UPI-CAFE-cafe@fakeba");
    expect(runOf(results[0]!.home, "2026-09-03").lines.map((line) => line.narration)).toEqual([
      "POS 0000XXXXXX0001 SYNTHETIC GROCER", "UPI-STREAMING-stream@fakebank-SUBSCRIPTION", "REFUND STREAMING",
    ]);
    results[0]!.home.artifact("order.json", results[0]!.extracts as unknown as Json);
  });

  it("a bank line is shifted a day by the zone", () => {
    const zones: DaySettings[] = [
      { zone: "Pacific/Kiritimati", day_start_hour: 4 },
      { zone: "Pacific/Pago_Pago", day_start_hour: 0 },
      { zone: "Asia/Kolkata", day_start_hour: 4 },
      NEW_YORK,
    ];
    const seen: Json[] = [];
    for (const settings of zones) {
      const home = newHome(settings);
      home.deliver(BANK, STATEMENT_A, statementA);
      for (const day of ["2026-09-02", "2026-09-03", "2026-09-04"]) {
        const document = JSON.parse(home.render(day, LABELS).json) as DayDocument;
        const dated = document.atoms.map((atom) => [atom.flags.join(","), atom.text.slice(0, 9)]);
        seen.push({ zone: settings.zone, day, atoms: dated });
        expect(dated).toEqual(day === "2026-09-03" ? [["date_only", "−1200.50 "], ["date_only", "−99.00 IN"], ["date_only", "+99.00 IN"]] : []);
      }
      expect(home.extracts("money").every((row) => row.days.length === 1 && `${BANK}/${row.days[0]}` === row.unit)).toBe(true);
      const txt = home.render("2026-09-03", LABELS).txt.split("\n");
      expect(txt[txt.indexOf("On 2026-09-03, time unknown") + 1]).toBe("−1200.50 INR Example Bank …1234: POS 0000XXXXXX0001 SYNTHETIC GROCER (balance 13549.50)");
    }
    newHome().artifact("zones.json", seen);
  });

  it("a missing statement line goes unreported", () => {
    const home = newHome();
    const gappy = all.filter((_line, index) => index !== 1 && index !== 3).map((line) => txn(line));
    home.deliver(BANK, STATEMENT_A, gappy);
    expect(runOf(home, "2026-09-03").breaks).toEqual(["-250.00", "-99.00"]);
    const txt = home.render("2026-09-03", LABELS).txt;
    expect(txt).toContain("−1200.50 INR Example Bank …1234: POS 0000XXXXXX0001 SYNTHETIC GROCER (balance 13549.50) [the balance before it does not follow: -250.00 INR of lines missing]");
    expect(txt).toContain("+99.00 INR Example Bank …1234: REFUND STREAMING (balance 13549.50) [the balance before it does not follow: -99.00 INR of lines missing]");
    golden("2026-09-03.gappy.day.txt", txt);
    const filled = home.deliver(BANK, STATEMENT_B, [txn(all[1]!), txn(all[3]!)]);
    expect(filled.written).toEqual([`money ${BANK}/2026-09-01`, `money ${BANK}/2026-09-03`]);
    expect(runOf(home, "2026-09-03").breaks).toEqual([null, null, null]);
    expect(runOf(home, "2026-09-03").opening).toBe("14750.00");
    golden("2026-09-03.day.txt", home.render("2026-09-03", LABELS).txt);
    golden("extracts.golden.json", `${JSON.stringify(home.extracts("money").map(({ seq: _seq, ...row }) => row), null, 2)}\n`);
    home.artifact("chain.json", home.extracts("money").map((row) => row.content));
    pin(MONEY, { money: PROOF_BANK }, home.extracts("money"));
  });

  it("a balance the day returns to reports lines as missing", () => {
    const home = newHome();
    const day = (credit: number): Entry[] => [
      { date: "2026-09-05", direction: "credit", cents: credit, narration: "NEFT CR-PERSON C-SYNTHETIC" },
      { date: "2026-09-05", direction: "debit", cents: credit, narration: "REVERSAL NEFT CR-PERSON C" },
      { date: "2026-09-05", direction: "debit", cents: 100_00, narration: "UPI-SHOP TWO-shop2@fakebank-PAYMENT" },
      { date: "2026-09-05", direction: "debit", cents: 100_00, narration: "UPI-SHOP THREE-shop3@fakebank-PAYMENT" },
    ];
    const credit = Array.from({ length: 100 }, (_, extra) => 100_00 + extra).find((amount) => {
      const [first, , debit] = lines(day(amount));
      return txn(debit!).key < txn(first!).key;
    })!;
    const balanced = lines(day(credit));
    for (const order of [balanced, shuffled(balanced, 5), shuffled(balanced, 11)]) {
      const fresh = newHome();
      fresh.deliver(BANK, STATEMENT_A, order.map((line) => txn(line)));
      const run = runOf(fresh, "2026-09-05");
      expect(run.breaks).toEqual([null, null, null, null]);
      expect(run.lines.map((line) => line.balance)).toEqual([money(10_000_00 + credit), "10000.00", "9900.00", "9800.00"]);
      fresh.close();
    }
    home.deliver(BANK, STATEMENT_A, balanced.filter((_line, index) => index !== 1).map((line) => txn(line)));
    const gappy = runOf(home, "2026-09-05");
    expect(gappy.lines.map((line) => line.balance)).toEqual([money(10_000_00 + credit), "9900.00", "9800.00"]);
    expect(gappy.breaks).toEqual([null, money(-credit), null]);
    home.artifact("returning.json", { credit, gappy });
  });

  it("renderDay reads outside days()", () => {
    const home = newHome();
    home.deliver(BANK, STATEMENT_A, statementA);
    home.deliver(BANK, STATEMENT_B, statementB);
    const extracts = home.extracts("money");
    let atoms = 0;
    const reads: string[] = [];
    for (let day = "2026-08-30"; day <= "2026-10-02"; day = addDays(day, 1)) {
      const document = JSON.parse(home.render(day, LABELS, (reader) => ({
        ...reader,
        extractsOn: (family, asked) => {
          const rows = [...reader.extractsOn(family, asked)];
          reads.push(...rows.map((row) => `${asked} ${row.unit}`));
          return rows;
        },
      })).json) as DayDocument;
      for (const atom of document.atoms) expect(atom.units).toEqual([`${BANK}/${day}`]);
      atoms += document.atoms.length;
    }
    expect(atoms).toBe(all.length);
    expect(reads.every((read) => read.endsWith(`/${read.slice(0, 10)}`))).toBe(true);
    const stray = extracts.find((row) => row.unit.endsWith("/2026-09-01"))!;
    expect(() => home.render("2026-09-02", LABELS, (reader) => ({ ...reader, extractsOn: () => [stray] }))).toThrow(DayReadError);
    home.artifact("reads.json", reads);
  });
});
