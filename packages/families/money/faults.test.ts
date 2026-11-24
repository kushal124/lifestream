import { describe, expect, it } from "vitest";
import type { MoneyAdapter } from "@lifestreamprotocol/core";
import { statedOf } from "../test/stated.js";
import { moneyFaults } from "./faults.js";

const TXN = { date: "2026-11-02", debit: "1250.00", closing_balance: "0.50", currency: "XTS", narration: "SYNTHETIC GROCER" };
const txn = (changed: Record<string, unknown>) => moneyFaults(statedOf<MoneyAdapter>({}, "txn", { ...TXN, ...changed }));

describe("moneyFaults", () => {
  it("passes a debit and a credit that keep every rule", () => {
    expect(txn({})).toEqual([]);
    expect(txn({ debit: undefined, credit: "0.00" })).toEqual([]);
  });

  it("names each rule a line breaks", () => {
    expect(txn({ debit: "1,250.00" })).toEqual(["`debit` is an amount of two decimals with no sign, thousands mark or leading zero, such as `1250.00`: `1,250.00` is none"]);
    expect(txn({ closing_balance: "-3.00" })).toEqual(["`closing_balance` is an amount of two decimals with no sign, thousands mark or leading zero, such as `1250.00`: `-3.00` is none"]);
    expect(txn({ date: "02/11/2026" })).toEqual(["`date` is the line's date as `YYYY-MM-DD`: `02/11/2026` is none"]);
    expect(txn({ credit: "5.00" })).toEqual(["a line states exactly one of `debit` and `credit`: it states both"]);
    expect(txn({ debit: undefined })).toEqual(["a line states exactly one of `debit` and `credit`: it states neither"]);
  });
});
