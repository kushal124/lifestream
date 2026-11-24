import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { feeds, type Files, type Fixture } from "@lifestreamprotocol/connect/sdk";

export const ACCOUNT = "00001234";
export const SOURCE = `example-bank:${ACCOUNT}:export`;

export const STATEMENT = [
  `account,${ACCOUNT}`,
  "date,narration,debit,credit,closing_balance,currency",
  "2026-09-28,SYNTHETIC GROCER,12.50,,987.50,EUR",
  "2026-09-28,SYNTHETIC SALARY,,1000.00,1987.50,EUR",
].join("\n");

export const files = (): Files => ({ "statement-2026-09.csv": `${STATEMENT}\n` });

export const fixture: Fixture = (folder) => {
  const text = `${STATEMENT}\n`;
  writeFileSync(join(folder, "statement.csv"), text);
  const whole = text.slice(0, Math.floor(Buffer.byteLength(text) / 2)).split("\n").length - 3;
  const heads = ["txn ff486b3926cc", "txn 5daba24a17b4"];
  return { source: SOURCE, facts: feeds(SOURCE, "example-bank"), files: { "statement.csv": { alone: heads, prefix: heads.slice(0, Math.max(0, whole)) } } };
};

export const fixtures = { "example-bank": fixture };
