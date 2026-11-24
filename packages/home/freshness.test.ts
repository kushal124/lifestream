import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import type { Connector } from "@lifestreamprotocol/connect";
import { openHome, openHomeFolder, sourceName, type DaySettings } from "@lifestreamprotocol/core";
import type { Family } from "@lifestreamprotocol/families";
import { nameKey } from "./devices.js";
import { FRESH_MS, freshnessOf, freshnessWords, freshReadOf, freshSourcesOf, type Freshened } from "./freshness.js";
import { keptKey } from "./through.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.parse("2026-11-04T12:00:00Z");
const CLOCK: DaySettings = { zone: "UTC", day_start_hour: 0 };
const PHONE = "phone-0001";
const OLD_PHONE = "phone-0002";
const MAC = "macbook-pro-0001";
const CHAT = `whatsapp:+15550000001:${PHONE}`;
const OLD_CHAT = `whatsapp:+15550000001:${OLD_PHONE}`;
const QUIET = `apple-health:local:${PHONE}`;
const NEVER = `apple-notes:local:${MAC}`;
const MAIL = "gmail:person-a@example.com:cloud";
const CALENDAR = "google-calendar:person-a@example.com:cloud";
const HANDED = "bank:acct-0001:upload";
const HIDDEN = "secret-app:local:cloud";

const connector = (id: string, product: string, name: string, arrives: string, more: Partial<Connector> = {}): Connector =>
  ({ id, product, name, sources: [{ id: `${product}:<account>:<unit>`, read: `${id}-reader`, arrives }], ...more }) as unknown as Connector;

const CONNECTORS: Connector[] = [
  connector("whatsapp", "whatsapp", "WhatsApp", "phone"),
  connector("apple-health", "apple-health", "Health", "phone"),
  connector("apple-notes", "apple-notes", "Notes", "mac"),
  connector("gmail", "gmail", "Gmail", "poll", { acquirers: ["gmail-fetch"] }),
  connector("google-calendar", "google-calendar", "Calendar", "poll", { acquirers: ["calendar-fetch"], counts: ["event"] }),
  connector("bank", "bank", "Bank", "upload"),
  connector("secret-app", "secret-app", "Secret", "poll", { hidden: true }),
];

const family = (name: string, products: string[]): Pick<Family, "name" | "inputs"> =>
  ({ name, inputs: [{ role: "evidence", sources: { product: products }, kinds: [] }] }) as unknown as Pick<Family, "name" | "inputs">;
const FAMILIES = [family("messages", ["whatsapp", "gmail"]), family("health", ["apple-health"]), family("notes", ["apple-notes", "secret-app"]),
  family("calendar", ["google-calendar"]), family("money", ["bank"])];

const scratch = mkdtempSync(join(tmpdir(), "lifestream-freshness-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let homes = 0;
function home(): Database.Database {
  const dir = join(scratch, `h${++homes}`);
  mkdirSync(dir);
  openHome(openHomeFolder(dir), "migrate").close();
  const db = new Database(join(dir, "home.db"));
  const source = db.prepare("INSERT INTO sources (id, product, vendor, account, copy, connector, options, added_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  for (const id of [CHAT, OLD_CHAT, QUIET, NEVER, MAIL, CALENDAR, HANDED, HIDDEN]) {
    const { product, account, copy } = sourceName(id);
    source.run(id, product, product, account, copy, `${product}-reader`, id === MAIL ? JSON.stringify({ email: "person-a@example.com" }) : "{}", NOW - 30 * 24 * HOUR);
  }
  const device = db.prepare("INSERT INTO devices (unit, model, added_ms, retired_ms) VALUES (?, ?, ?, ?)");
  device.run(PHONE, "iPhone", NOW - 30 * 24 * HOUR, null);
  device.run(OLD_PHONE, "iPhone", NOW - 60 * 24 * HOUR, NOW - 30 * 24 * HOUR);
  device.run(MAC, "MacBook Pro", NOW - 30 * 24 * HOUR, null);
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(nameKey(PHONE), "Phone");
  return db;
}

let deliveries = 0;
const delivered = (db: Database.Database, source: string, sealed_ms: number): void => {
  db.prepare("INSERT INTO deliveries (id, source, sealed_ms, stated_ms, facts, state) VALUES (?, ?, ?, ?, '{}', 'imported')").run(`d-${++deliveries}`, source, sealed_ms, sealed_ms);
};
const heard = (db: Database.Database, source: string, heard_ms: number): void => {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(keptKey(source), JSON.stringify({ applied: null, left: null, heard_ms }));
};
const attempt = (db: Database.Database, target: string, source: string, outcome: string, reason: string | null, contact_ms: number | null): void => {
  db.prepare("INSERT INTO attempts (target, source, outcome, reason, facts, since_ms, at_ms, contact_ms) VALUES (?, ?, ?, ?, '{}', ?, ?, ?)")
    .run(target, source, outcome, reason, contact_ms ?? NOW, contact_ms ?? NOW, contact_ms);
};
const span = (db: Database.Database, source: string, kind: string, newest_ms: number, dated = false): void => {
  db.prepare("INSERT INTO spans (source, kind, live, oldest_ms, newest_ms, newest_dated) VALUES (?, ?, 1, ?, ?, ?)").run(source, kind, newest_ms - 24 * HOUR, newest_ms, dated ? 1 : 0);
};
const head = (db: Database.Database, source: string, kind: string, key: string, start_ms: number): void => {
  db.prepare("INSERT INTO versions (id, text, kind, key, start_ms, precision) VALUES (?, '{}', ?, ?, ?, 'minute')").run(`v-${key}`, kind, key, start_ms);
  db.prepare("INSERT INTO heads (source, kind, key, version, stated_ms, since_ms, start_ms) VALUES (?, ?, ?, ?, ?, ?, ?)").run(source, kind, key, `v-${key}`, start_ms, start_ms, start_ms);
};

describe("each source's last synced and last item", () => {
  it("a device's source is synced by its own last delivery or the read-through it stated, whichever is later; one that never sent is never synced", () => {
    const db = home();
    delivered(db, CHAT, NOW - 2 * HOUR);
    delivered(db, QUIET, NOW - 3 * HOUR);
    heard(db, QUIET, NOW - 5 * MINUTE);
    const fresh = freshnessOf(db, { connectors: CONNECTORS, now_ms: NOW, read: freshReadOf(db) });
    expect(fresh.get(CHAT)).toMatchObject({ road: "phone", synced_ms: NOW - 2 * HOUR, heard_ms: NOW - 2 * HOUR });
    expect(fresh.get(QUIET)).toMatchObject({ road: "phone", synced_ms: NOW - 5 * MINUTE });
    expect(fresh.get(NEVER)).toMatchObject({ road: "mac", synced_ms: null, item_ms: null });
  });

  it("a polled source is synced when its own acquirer last reached the provider; a wait on the door and another acquirer's contact are no sync", () => {
    const db = home();
    attempt(db, "fetch:gmail-fetch", MAIL, "ok", null, NOW - 40 * MINUTE);
    attempt(db, "page:gmail-fetch", MAIL, "wait", "door", NOW - MINUTE);
    attempt(db, "fetch:calendar-fetch", MAIL, "ok", null, NOW - MINUTE);
    delivered(db, MAIL, NOW - 2 * MINUTE);
    expect(freshnessOf(db, { connectors: CONNECTORS, now_ms: NOW, read: freshReadOf(db) }).get(MAIL)).toMatchObject({ road: "poll", synced_ms: NOW - 40 * MINUTE, heard_ms: NOW - 2 * MINUTE });
  });

  it("a future event is not the last item, the newest one at or before now is; a dated item says so", () => {
    const db = home();
    span(db, CALENDAR, "event", NOW + 48 * HOUR);
    span(db, CALENDAR, "reminder", NOW + 72 * HOUR);
    head(db, CALENDAR, "event", "e-past", NOW - 3 * HOUR);
    head(db, CALENDAR, "event", "e-future", NOW + 48 * HOUR);
    span(db, HANDED, "payment", Date.parse("2026-11-01T00:00:00Z"), true);
    const fresh = freshnessOf(db, { connectors: CONNECTORS, now_ms: NOW, read: freshReadOf(db) });
    expect(fresh.get(CALENDAR)).toMatchObject({ item_ms: NOW - 3 * HOUR, item_dated: false });
    expect(fresh.get(HANDED)).toMatchObject({ road: "upload", item_ms: Date.parse("2026-11-01T00:00:00Z"), item_dated: true });
  });

  it("a read lists only sources switched on, of a live device and a shown connector, each named by its connector and where it is read, with the families it feeds", () => {
    const db = home();
    const listed = freshSourcesOf(db, { connectors: CONNECTORS, families: FAMILIES, off: ["apple-health"], now_ms: NOW });
    expect(listed.map((each) => [each.id, each.name, each.device, each.families])).toEqual([
      [NEVER, "Notes, MacBook Pro", { unit: MAC, name: "MacBook Pro" }, ["notes"]],
      [HANDED, "Bank, acct-0001", null, ["money"]],
      [MAIL, "Gmail, person-a@example.com", null, ["messages"]],
      [CALENDAR, "Calendar, person-a@example.com", null, ["calendar"]],
      [CHAT, "WhatsApp, Phone", { unit: PHONE, name: "Phone" }, ["messages"]],
    ]);
  });
});

describe("the freshness line", () => {
  const words = (sources: Freshened[]) => freshnessWords(sources, { now_ms: NOW, clock: CLOCK });
  const source = (name: string, synced_ms: number | null, item_ms: number | null, item_dated = false): Freshened =>
    ({ name, device: null, synced_ms, item_ms, item_dated });
  const on = (unit: string, device: string) => (name: string, synced_ms: number | null, item_ms: number | null): Freshened =>
    ({ name: `${name}, ${device}`, device: { unit, name: device }, synced_ms, item_ms, item_dated: false });

  it("sources synced in the last 15 minutes are only counted; none at all is no line", () => {
    expect(words([source("Notes, Mac", NOW - FRESH_MS, NOW - HOUR), source("WhatsApp, Phone", NOW, NOW - 5 * MINUTE)])).toBe("All 2 sources synced in the last 15 min.");
    expect(words([source("Notes, Mac", NOW - MINUTE, null)])).toBe("The one source synced in the last 15 min.");
    expect(words([])).toBeUndefined();
  });

  it("a lagging source is spelled out with both times, the oldest sync first, a day not today in full, a dated item as its day, one never synced first", () => {
    expect(words([
      source("Notes, Mac", NOW - MINUTE, NOW - HOUR),
      source("WhatsApp, Phone", NOW - 89 * MINUTE, NOW - 90 * MINUTE),
      source("Gmail, person-a@example.com", null, null),
      source("Bank, acct-0001", Date.parse("2026-11-02T18:04:00Z"), Date.parse("2026-11-01T00:00:00Z"), true),
    ])).toBe("Synced in the last 15 min: 1 source. Not since: Gmail, person-a@example.com (never synced); "
      + "Bank, acct-0001 (last synced 2026-11-02 18:04, last item 2026-11-01); WhatsApp, Phone (last synced 10:31, last item 10:30).");
    expect(words([source("WhatsApp, Phone", NOW - HOUR, null)])).toBe("Not synced in the last 15 min: WhatsApp, Phone (last synced 11:00, last item none).");
  });

  it("past eight lagging entries, the rest are counted by their sources with the latest time none of them synced since", () => {
    const lagging = Array.from({ length: 10 }, (_, n) => source(`Source ${n}`, NOW - (60 - n) * MINUTE, null));
    expect(words(lagging)).toBe(`Not synced in the last 15 min: ${lagging.slice(0, 8).map((each) => `${each.name} (last synced ${new Date(each.synced_ms!).toISOString().slice(11, 16)}, last item none)`).join("; ")}; and 2 more not synced since 11:09.`);
  });

  it("a device's sources are one entry, its newest sync and its last item; a fresh device's sources only counted", () => {
    const phone = on(PHONE, "iPhone"), mac = on(MAC, "MacBook Pro");
    const sources = [
      ...Array.from({ length: 11 }, (_, n) => phone(`Source ${n}`, NOW - (62 + n) * MINUTE, NOW - (63 + n) * MINUTE)),
      ...Array.from({ length: 25 }, (_, n) => mac(`Source ${n}`, NOW - (n % 3) * MINUTE, NOW - 2 * MINUTE)),
      source("Gmail, person-a@example.com", NOW - 40 * MINUTE, NOW - 50 * MINUTE),
    ];
    expect(words(sources)).toBe("Synced in the last 15 min: 25 sources. Not since: iPhone (11 sources, last synced 10:58, last item 10:57); "
      + "Gmail, person-a@example.com (last synced 11:20, last item 11:10).");
    expect(words(sources.slice(11, 36))).toBe("All 25 sources synced in the last 15 min.");
  });

  it("a source that lags its own device is the exception spelled out; a device left with one source names it", () => {
    const phone = on(PHONE, "iPhone"), mac = on(MAC, "MacBook Pro");
    expect(words([
      mac("Input", NOW - MINUTE, NOW - MINUTE),
      mac("Machine", NOW - 2 * MINUTE, NOW - 2 * MINUTE),
      mac("Screen Time", NOW - 3 * HOUR, NOW - 3 * HOUR),
      phone("Location", NOW - 2 * HOUR, NOW - 2 * HOUR),
      phone("Motion", null, null),
    ])).toBe("Synced in the last 15 min: 2 sources. Not since: Motion, iPhone (never synced); Screen Time, MacBook Pro (last synced 09:00, last item 09:00); "
      + "Location, iPhone (last synced 10:00, last item 10:00).");
  });
});
