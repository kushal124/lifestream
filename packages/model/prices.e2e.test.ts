import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { openHomeFolder, Schema } from "@lifestreamprotocol/core";
import { afterAll, describe, expect, it } from "vitest";
import { ledgerSchema, openLedger, type Ledger } from "./ledger.js";

const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

const dir = mkdtempSync(join(tmpdir(), "model-prices-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let files = 0;
function fresh(): string {
  const folder = join(dir, `home-${files++}`, "replies");
  mkdirSync(folder, { recursive: true });
  return join(folder, "replies.db");
}

let keys = 0;
function reply(ledger: Ledger, prompt: string, model: string, cost: number | undefined, at: number) {
  const key = `request-${keys++}`;
  ledger.request({
    key, family: "photos", unit: `photo:synthetic-${keys}`, revision: key, model, effort: "low",
    prompt: { name: prompt, version: 1, text: "Caption this synthetic photo.", type: "text" },
    input_hash: `sha256:input-${keys}`, body: "a synthetic body", attachments: [],
  }, at);
  const begun = ledger.beginAttempt(key, at, "fake");
  if (!("attempt" in begun)) throw new Error(`the attempt of ${key} was refused`);
  expect(ledger.land(begun.attempt, { text: "a synthetic caption", model, transport: "fake", ...(cost === undefined ? {} : { cost }) }, at)).toBe(true);
  return begun.attempt;
}

const days = (path: string): string[] => {
  const db = new Database(path, { readonly: true });
  try {
    return db.prepare("SELECT DISTINCT day FROM prices ORDER BY day").pluck().all() as string[];
  } finally {
    db.close();
  }
};

describe("a prompt's price, kept", () => {
  it("is the mean of the window's priced replies of its prompt and model, an unpriced reply, a second land and an old day left out", () => {
    const path = fresh();
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    try {
      reply(ledger, "caption", "model-a", 0.002, T0);
      const at = T0 + 20 * DAY_MS;
      const twice = reply(ledger, "caption", "model-a", 0.004, at);
      reply(ledger, "caption", "model-b", 0.01, at);
      reply(ledger, "caption", "model-a", undefined, at);
      expect(ledger.land(twice, { text: "a synthetic caption", model: "model-a", transport: "fake", cost: 0.04 }, at)).toBe(false);
      expect(ledger.fail(twice, "a synthetic failure", at, { cost: 0.04 })).toBe(false);
      const rates = ledger.rates(at);
      expect(rates.price("caption", "model-a")).toBeCloseTo(0.003, 12);
      expect(rates.price("caption", "model-b")).toBeCloseTo(0.01, 12);
      expect(rates.price("caption", "model-c")).toBeNull();
      expect(rates.price("tag", "model-a")).toBeNull();
      const later = T0 + 31 * DAY_MS;
      expect(ledger.rates(later).price("caption", "model-a")).toBeCloseTo(0.004, 12);
      reply(ledger, "caption", "model-a", 0.006, later);
      expect(days(path)).toEqual(["2026-10-21", "2026-11-01"]);
      expect(ledger.rates(later).price("caption", "model-a")).toBeCloseTo(0.005, 12);
    } finally {
      ledger.close();
    }
  });

  it("is made by the migration from the replies a ledger of the release before holds, in the window alone", () => {
    const path = fresh();
    const before = new Schema({
      name: ledgerSchema.name, file: ledgerSchema.file, base: ledgerSchema.base, baseline: ledgerSchema.baseline,
      migrations: ledgerSchema.migrations.slice(0, 4 - ledgerSchema.base), small: [...ledgerSchema.small].filter((table) => table !== "prices"), foreignKeys: true,
    });
    const now = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    const db = new Database(path);
    try {
      expect(before.open(db, "migrate")).toMatchObject({ to: 4 });
      db.prepare("INSERT INTO prompts (hash, version, text) VALUES ('sha256:prompt-a', 'v1', 'Caption this synthetic photo.')").run();
      const request = db.prepare(`INSERT INTO requests (key, unit, model, effort, transport, prompt_hash, input_hash, body, attachments, requested, prompt, prompt_version)
        VALUES (?, 'photo:synthetic-1', ?, 'low', '', 'sha256:prompt-a', 'sha256:input-a', 'a synthetic body', '[]', ?, ?, 1)`);
      const attempt = db.prepare("INSERT INTO attempts (key, state, started, finished, cost_usd, transport) VALUES (?, ?, ?, ?, ?, 'fake')");
      const rows: [string, string | null, string, number, number | null][] = [
        ["in-a", "caption", "replied", now - 2 * DAY_MS, 0.002],
        ["in-b", "caption", "replied", now - 1 * DAY_MS, 0.004],
        ["in-other", "caption", "replied", now - 1 * DAY_MS, 0.01],
        ["out", "caption", "replied", now - 40 * DAY_MS, 0.5],
        ["failed", "caption", "failed", now - 1 * DAY_MS, 0.5],
        ["unpriced", "caption", "replied", now - 1 * DAY_MS, null],
        ["no-name", null, "replied", now - 1 * DAY_MS, 0.5],
      ];
      for (const [key, prompt, state, at, cost] of rows) {
        request.run(key, key === "in-other" ? "model-b" : "model-a", iso(at), prompt);
        attempt.run(key, state, iso(at), iso(at), cost);
      }
    } finally {
      db.close();
    }
    const ledger = openLedger(openHomeFolder(dirname(dirname(path))), { mode: "migrate" });
    try {
      expect(days(path)).toEqual([iso(now - 2 * DAY_MS).slice(0, 10), iso(now - DAY_MS).slice(0, 10)]);
      expect(ledger.rates(now).price("caption", "model-a")).toBeCloseTo(0.003, 12);
      expect(ledger.rates(now).price("caption", "model-b")).toBeCloseTo(0.01, 12);
    } finally {
      ledger.close();
    }
  });
});
