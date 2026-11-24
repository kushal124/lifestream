import { artifact, temp } from "../test/drive.js";
import type { JsonObject } from "@lifestreamprotocol/core";
import { describe, expect, it } from "vitest";
import { appleInstant, statedAt } from "./delivery.js";
import { fingerprint } from "./fingerprint.js";
import { Refused } from "./refused.js";

const ms = (text: string): number => Date.parse(text);

function words(read: () => unknown): string {
  try {
    read();
    return "accepted";
  } catch (error) {
    if (error instanceof Refused) return error.message;
    throw error;
  }
}

describe("the delivery statement time: each of these is impossible", () => {
  it("a delivery that states no statement time is accepted", () => {
    const dir = temp();
    const refused = [
      {},
      { kind: "delta", after: 1, through: 2 },
      { snapshot_taken_at: "2026-10-03 14:00", fetched_at: "2026-10-03T14:00:00Z" },
      { exported_at: 1_759_500_000_000 },
      { created_at: "2026-02-30T10:00:00Z" },
      { fetched_at: "20261003T140000Z" },
      { fetched_at: "2026-10-03T14:00:00" },
    ].map((facts) => words(() => statedAt(facts)));
    const none = "the delivery states no snapshot_taken_at, exported_at, created_at, fetched_at";
    const unread = (fact: string, value: string) => `facts.${fact} must be a full RFC 3339 instant, not ${value}`;
    expect(refused).toEqual([
      none,
      none,
      unread("snapshot_taken_at", '"2026-10-03 14:00"'),
      unread("exported_at", "1759500000000"),
      unread("created_at", '"2026-02-30T10:00:00Z"'),
      unread("fetched_at", '"20261003T140000Z"'),
      unread("fetched_at", '"2026-10-03T14:00:00"'),
    ]);
    artifact(dir, "no-time.json", refused);
  });

  it("the statement time is read from the wrong fact, or to the wrong millisecond", () => {
    const dir = temp();
    const cases: [JsonObject, number][] = [
      [{ fetched_at: "2026-10-03T14:00:05Z", created_at: "2026-10-03T13:59:00.250+05:30", exported_at: "2025-08-01T00:00:00Z", snapshot_taken_at: "2026-10-03T14:00:00.5Z" }, ms("2026-10-03T14:00:00.500Z")],
      [{ fetched_at: "2026-10-03T14:00:05Z", created_at: "2026-10-03T13:59:00.250+05:30", exported_at: "2025-08-01T00:00:00Z" }, ms("2025-08-01T00:00:00Z")],
      [{ fetched_at: "2026-10-03T14:00:05Z", created_at: "2026-10-03T13:59:00.250+05:30" }, ms("2026-10-03T08:29:00.250Z")],
      [{ fetched_at: "2026-10-03T14:00:05.123456789-04:00" }, ms("2026-10-03T18:00:05.123Z")],
    ];
    const read = cases.map(([facts]) => statedAt(facts));
    expect(read).toEqual(cases.map(([, expected]) => expected));
    artifact(dir, "stated.json", read);
  });
});

describe("an Apple store's date: each of these is impossible", () => {
  it("an unset date (0 or NULL) is a time, a date is read to the wrong millisecond, or text is read", () => {
    const dir = temp();
    const read = [
      appleInstant(0, "apple-s", "row 1 ZDATE"),
      appleInstant(0n, "apple-ns", "row 1 date"),
      appleInstant(null, "apple-s", "row 1 ZDATE"),
      appleInstant(811_584_000.25, "apple-s", "row 1 ZDATE"),
      appleInstant(811_584_000n, "apple-s", "row 1 ZDATE"),
      appleInstant(811_584_000_250_000_000n, "apple-ns", "row 1 date"),
    ].map((time) => time?.start_ms ?? null);
    expect(read).toEqual([null, null, null, ms("2026-09-20T08:00:00.250Z"), ms("2026-09-20T08:00:00Z"), ms("2026-09-20T08:00:00.250Z")]);
    const refused = [
      words(() => appleInstant("yesterday", "apple-s", "row 2 ZDATE")),
      words(() => appleInstant(Buffer.from([1]), "apple-ns", "row 3 date")),
    ];
    expect(refused).toEqual(["row 2 ZDATE is not a number", "row 3 date is not a number"]);
    artifact(dir, "apple-dates.json", { read, refused });
  });
});

describe("key fingerprints: each of these is impossible", () => {
  it("one identity fingerprints two ways, or two identities alike", () => {
    const dir = temp();
    const line = { account: "fake-account-01", date: "2026-09-03", amount: "12.50", narration: "FAKE SHOP 0001", balance: 1000.5 };
    const same = fingerprint({ balance: 1000.5, narration: "FAKE SHOP 0001", amount: "12.50", date: "2026-09-03", account: "fake-account-01" });
    expect(fingerprint(line)).toBe(same);
    expect(fingerprint(line)).toMatch(/^sha256:[0-9a-f]{64}$/u);
    const others = [
      { ...line, amount: "12.5" },
      { ...line, balance: 1000.25 },
      { ...line, narration: "FAKE SHOP 0001 " },
      { ...line, narration: "CAFÉ" },
      { ...line, narration: "CAFÉ" },
      [line],
    ].map(fingerprint);
    expect(new Set([fingerprint(line), ...others]).size).toBe(others.length + 1);
    expect(fingerprint({ value: 1.0 })).toBe(fingerprint({ value: 1 }));
    const refused = [
      () => fingerprint({ value: Number.NaN }),
      () => fingerprint({ text: "lone \ud800 surrogate" }),
      () => fingerprint({ "é": 1, "é": 2 }),
    ].map(words);
    expect(refused).toEqual([
      "non-finite number NaN at $.value",
      "string has a lone surrogate at $.text",
      expect.stringMatching(/^two member names are equal under NFC at /u),
    ]);
    artifact(dir, "fingerprints.json", { line: fingerprint(line), others, refused });
  });
});
