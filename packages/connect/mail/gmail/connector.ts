import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const gmail = {
  id: "gmail", product: "gmail", name: "Gmail", vendor: "google", type: "mail", noun: ["email", "emails"], counts: ["mailmsg"],
  gives: "Every email, sent and received, with its labels.",
  records: "Every email in All Mail, with its labels and attachments.",
  sources: [{ id: "gmail:<account>:cloud", read: "gmail", arrives: ["poll", "upload"], feeders: ["gmail-imap", "gmail-takeout"] }],
  acquirers: ["gmail-imap"],
  refresh: { default: "5m", min: "1m" },
  backfill: { unit: ["email", "emails"], about: "Catches up on your mailbox, newest first." },
  processing: { mail: works.MAIL },
  fields: {
    account: { kind: "email", label: "Gmail address", account: true },
    password: { kind: "secret", label: "App password", secret: "gmail.password" },
    spam: { kind: "toggle", label: "Include Spam", default: false, about: "From when you turn it on." },
    trash: { kind: "toggle", label: "Include Trash", default: false, about: "From when you turn it on." },
  },
  signin: [{
    acquirer: "gmail-imap", way: "key", fields: ["account", "password"], label: "Use an app password",
    steps: [
      { title: "Turn on 2-Step Verification", words: "In your Google account, under Security.", open: { label: "Open Google account", url: "https://myaccount.google.com/security" } },
      { title: "Make an app password", words: "At myaccount.google.com/apppasswords. Name it Lifestream.", open: { label: "Open app passwords", url: "https://myaccount.google.com/apppasswords" } },
    ],
    note: "Signs in with an app password, never your Google password.",
    refused: "Google refused this password. Make a new app password and paste it here.",
  }],
  export: { recognise: ["Takeout/Mail/**/*.mbox"], product: { id: "mail", name: "Mail" } },
  open: { record: { kinds: ["mailmsg"], url: "https://mail.google.com/mail/?authuser={account}#all/{key|hex}" } },
} satisfies Connector;
