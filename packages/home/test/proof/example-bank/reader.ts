import { createHash } from "node:crypto";
import { each, instantOf, isObject, refuse, sourceName, utf8, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";

export const TXN = "txn";
const HEADER = "date,narration,debit,credit,closing_balance,currency";
const AMOUNT = /^(?:0|[1-9]\d*)\.\d{2}$/u;

const txn: Guard = (content) => {
  if (!isObject(content) || content.type !== "example-bank.txn") return ["a line is { type: example-bank.txn, … }"];
  const problems: string[] = [];
  if (typeof content.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(content.date)) problems.push("date is not a YYYY-MM-DD day");
  for (const member of ["closing_balance", content.debit === undefined ? "credit" : "debit"]) {
    if (typeof content[member] !== "string" || !AMOUNT.test(content[member] as string)) problems.push(`${member} is not a two-place decimal`);
  }
  return problems;
};

export const exampleBank: Reader = {
  name: "example-bank",
  kinds: { [TXN]: txn },
  account: { file: "*.csv", text: (text) => /^account,(\d+)$/u.exec(text.split("\n")[0]?.trim() ?? "")?.[1] },
  async *read(delivery, files) {
    if (delivery.files.length !== 1 || !delivery.files[0]!.path.toLowerCase().endsWith(".csv")) refuse("a statement is one .csv file");
    yield* each(delivery.files, (file) => file.path, async function* (file) {
      const where = file.path;
      const [first = "", header = "", ...lines] = utf8(files.bytes(file.blob), where).split("\n").filter((line) => line.trim() !== "");
      const account = /^account,(\d+)$/u.exec(first.trim())?.[1] ?? refuse(`${where} names no account on its first line`);
      if (account !== sourceName(delivery.source).account) refuse(`${where} states account ${account}; the source is ${delivery.source}`);
      if (header.trim() !== HEADER) refuse(`${where}'s header is not ${HEADER}`);
      yield* each(lines.map((line, at) => ({ line, index: at })), ({ index }) => `${where} line ${index + 3}`, ({ line, index }): ReaderOutput[] => {
        const [date = "", narration = "", debit = "", credit = "", closing = "", currency = ""] = line.trim().split(",");
        if ((debit === "") === (credit === "")) refuse(`${where} line ${index + 3} states not exactly one of a debit or a credit`);
        const key = createHash("sha256").update([date, debit, credit, closing].join("|")).digest("hex").slice(0, 12);
        return [{
          kind: TXN, key, content: { type: "example-bank.txn", date, narration, ...(debit === "" ? { credit } : { debit }), closing_balance: closing, currency },
          time: instantOf(date, "date", `${where} line ${index + 3} date`), locator: `${where}:line ${index + 3}`,
        }];
      });
    });
  },
};
