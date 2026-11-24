import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const whoop = {
  id: "whoop", product: "whoop", name: "WHOOP", vendor: "whoop", type: "health", noun: ["reading", "readings"], counts: ["sample"],
  gives: "Your sleeps, strain and heart rate.",
  records: "Your cycles, sleeps, stress and heart rate, as WHOOP reads them.",
  sources: [{ id: "whoop:<account>:cloud", read: "whoop-capture", arrives: "chrome", feeders: ["whoop"] }],
  acquirers: ["whoop"],
  refresh: { default: "1h", min: "1m" },
  backfill: { unit: ["day", "days"], about: "Collects the days WHOOP already holds, a batch at a time." },
  fields: {
    email: { kind: "email", label: "WHOOP email" },
    password: { kind: "secret", label: "WHOOP password", secret: "lifestream-whoop-password" },
    timezone: { kind: "zone", label: "Time zone", about: "The time zone WHOOP's days are read in. Lifestream’s, unless you pick one." },
    heart_rate_step: { kind: "choice", label: "Heart rate resolution", options: { "6s": "Every 6 seconds", "1m": "Every minute", "10m": "Every 10 minutes" }, default: "1m",
      about: "How often a heart rate reading is kept." },
  },
  chrome: {
    origin: "https://app.whoop.com",
    signin: { origin: "https://id.whoop.com", recipe: "whoop-sign-in" },
    probe: { cookie: "whoop-auth-token", who: { url: "https://api.prod.whoop.com/users-service/v2/bootstrap/?accountType=users&apiVersion=7", id: "user.id", email: "account.email" } },
  },
} satisfies Connector;
