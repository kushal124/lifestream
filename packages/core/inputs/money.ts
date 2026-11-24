import type { Adapter, InputRecord } from "./adapter.js";

/** One line of a bank statement, a debit or a credit, which the day prints on its date and chains to the lines before it by balance. */
export type Txn = {
  /** The statement's date for the line, as `YYYY-MM-DD`, on which the line prints with no clock. */
  date: string;
  /** The account's balance after the line, as a decimal string with two places such as `1234.50`, by which the family finds lines missing between two. */
  closing_balance: string;
  /** The currency's code as the statement writes it, which the line prints after the amount. */
  currency: string;
  /** The statement's description of the line, which the day prints, search finds and the payee is read from. */
  narration: string;
} & ({
  /** The amount taken out, as a decimal string with two places. */
  debit: string;
  /** A debit carries no credit. */
  credit?: undefined;
} | {
  /** The amount paid in, as a decimal string with two places. */
  credit: string;
  /** A credit carries no debit. */
  debit?: undefined;
});

/** How a bank's statement records become the money lines of a day. */
export interface MoneyAdapter extends Adapter {
  /** One record read as its statement line, or null for one that is no line, where absent the record's content is read as the line itself. */
  txn?(record: InputRecord): Txn | null;
}
