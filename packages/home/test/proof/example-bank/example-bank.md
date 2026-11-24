# Example Bank (a proof connector)

A home connector of the proof: money, a statement the person hands in, and a
`date` field. Synthetic: no bank of this name exists, and no release holds this folder.

Source: `example-bank:<account>:export`, the account number the statement's first line states. Reader: `example-bank`,
with no acquirer: the statement, one CSV under the name the bank gives it, is an import of its own kind (`export`,
templates/export/export.md), and the reader's `account` rule reads its first line before any row.

| Kind | Key | Content | Time |
|---|---|---|---|
| `txn` | 12 hex digits of the SHA-256 of the date, debit, credit and closing balance, joined by `\|` | `{ type: "example-bank.txn", date, narration, debit \| credit, closing_balance, currency }` | the line's date, a calendar day |

The money family reads a line's content as its own (`adapters`, index.ts), and prints it under `Example Bank …<last four>`.
