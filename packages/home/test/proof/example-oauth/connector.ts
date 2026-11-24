import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const exampleOauth = {
  id: "example-oauth", product: "example-oauth", name: "Example OAuth", vendor: "example", type: "notes", noun: ["note", "notes"],
  records: "Every note's title and text.",
  sources: [{ id: "example-oauth:<account>:cloud", read: "example-oauth", arrives: "poll" }],
  acquirers: ["example-oauth"],
  refresh: { default: "5m", min: "1m" },
  backfill: { about: "Collects the notes already in your account, a batch at a time." },
  fields: {
    account: { kind: "email", label: "Example email", account: true },
    token: { kind: "secret", label: "Example sign-in", secret: "example-oauth.signin" },
  },
  signin: [{
    acquirer: "example-oauth", way: "client", field: "token", client: "example", scope: "notes.read", label: "Sign in with Example",
    check: { url: "https://api.example.com/v1/me", account: "email" },
  }],
} satisfies Connector;
