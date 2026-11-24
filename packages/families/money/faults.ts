import type { MoneyAdapter, Txn } from "@lifestreamprotocol/core";
import { quoted, type Stated } from "../family.js";
import { MONEY_AMOUNT, MONEY_DATE } from "./family.js";

export function moneyFaults({ member, value }: Stated<MoneyAdapter>): string[] {
  if (member !== "txn" || value === null || typeof value !== "object") return [];
  const txn = value as Partial<Record<keyof Txn, unknown>>;
  const faults: string[] = [];
  const stated = (["debit", "credit"] as const).filter((side) => txn[side] !== undefined);
  if (stated.length !== 1) faults.push(`a line states exactly one of \`debit\` and \`credit\`: it states ${stated.length === 0 ? "neither" : "both"}`);
  for (const name of [...stated, "closing_balance"] as const) {
    if (typeof txn[name] !== "string" || !MONEY_AMOUNT.test(txn[name])) {
      faults.push(`\`${name}\` is an amount of two decimals with no sign, thousands mark or leading zero, such as \`1250.00\`: ${quoted(txn[name])} is none`);
    }
  }
  if (typeof txn.date !== "string" || !MONEY_DATE.test(txn.date)) faults.push(`\`date\` is the line's date as \`YYYY-MM-DD\`: ${quoted(txn.date)} is none`);
  return faults;
}
