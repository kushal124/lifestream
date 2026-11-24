import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleBank = {
  id: "example-bank", product: "example-bank", name: "Example Bank", vendor: "example", type: "money", noun: ["transaction", "transactions"],
  records: "Every transaction in your statements, with its closing balance.",
  sources: [{ id: "example-bank:<account>:export", read: "example-bank", arrives: "upload" }],
  fields: {
    since: { kind: "date", label: "Statements since" },
    nickname: { kind: "text", label: "Account name", placeholder: "Everyday account" },
  },
  export: {
    recognise: ["*.csv"],
    name: "Example Bank statement",
    takes: "A statement you download from Example Bank",
    guide: [{ words: "On Example Bank's Statements page, download a statement as CSV.", open: { label: "Open Example Bank", url: "https://bank.example.com/statements" } }],
  },
} satisfies Connector;
