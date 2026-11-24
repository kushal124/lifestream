import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleLog = {
  id: "example-log", product: "example-log", name: "Example Log", vendor: "example", type: "notes", icon: "recording", noun: ["entry", "entries"],
  records: "Every entry of your log, with its time.",
  sources: [{ id: "example-log:local:<home>", read: "example-log", arrives: "poll" }],
  acquirers: ["example-log"],
  refresh: { default: "15m", min: "5m" },
  open: { record: { kinds: ["entry"], url: "https://log.example.com/entries/{key}" } },
  fields: {
    file: { kind: "path", label: "Log file" },
    zone: { kind: "zone", label: "The log's clock" },
    lines: { kind: "number", label: "Entries a fetch reads", default: 500, min: 1, max: 5000 },
    blank: { kind: "toggle", label: "Keep blank entries", default: false },
    levels: { kind: "list", label: "Levels", default: [], empty: "Every level" },
  },
} satisfies Connector;
