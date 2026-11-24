import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { basename, dirname, join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { accountOf, canonical, CHECKPOINT_PAGES, civilDay, hideDetails, openHandedFolder, openHomeFolder, sha256, trySharedLock, wantedOf, type Json, type Marked } from "@lifestreamprotocol/core";
import { callsLock, fakeTransport, openLedger, runCall } from "@lifestreamprotocol/model";
import { openMarks, passagesOf } from "@lifestreamprotocol/privacy";
import { keyedFolder } from "@lifestreamprotocol/core/test/keyed";
import { machine } from "./machine.js";
import { marksFileOf } from "./marking.js";
import { callCopiesAt } from "./pick.js";
import { preparedDirOf, preparedFileOf } from "./prepared.js";
import { SearchIndex, searchFileOf } from "./search-index.js";
import { ask, askHome } from "./socket.js";
import { count, filesUnder, inFlight, left, MINUTE, note, quiet, sharded, SOURCE } from "./test/erasures.js";
import { artifact, hex, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship, shipFiles } from "./test/harness-deliveries.js";
import { startHere } from "./test/harness-home.js";
import { context, land, messages, openTestHome, removeDir, T0, tempDir, writeFolder, type TestHome } from "./test/ops-support.js";
import { INTENT_META, recordFailure, resumeErasure, standingIntent } from "./verbs/erase.js";
import { exactTerms, searchOf } from "./test/record-reads.js";
import { testSocket } from "./test/folder.js";

const accountAccess = (account: string): Json => ({ allow: [{ reach: { account, but: [] }, window: null, until_ms: null }], items: [], not: [], only: [], window: null, hide: "names", shown: [] });
const READER = "p-1a2b3c4d";
function found(root: string, word: string): number {
  const index = SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine().dir));
  if (index === undefined) return 0;
  try {
    const answer = searchOf(index, { terms: exactTerms(word), order: "relevance", limit: 50 });
    return "hits" in answer ? answer.hits.length : 0;
  } finally {
    index.close();
  }
}

describe("an erasure on a running home", () => {
  const roots: string[] = [];
  const homeOn = (root: string) => startHere(root, { tickMs: TICK_MS, log: () => undefined });

  afterAll(() => {
    for (const root of roots) removeRoot(root);
  });

  it("an erasure of a note already stated gone, before its family read the gone, leaves its text in the extract and the day file", async () => {
    const root = makeRoot("lifestream-erasure-gone-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const home = await homeOn(root);
    const text = "a synthetic note the owner deletes";
    const days = (): string => filesUnder(join(root, "days")).filter((file) => !file.startsWith("."))
      .map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");
    const extracts = (): string => readHome(root, (db) => (db.prepare("SELECT content FROM extracts WHERE family = 'notes'").pluck().all() as string[]).join("\n"));
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", text, at), note("n2", "a note that stays", at + 1_000)] });
    await until("the day printed the note", () => quiet(root) && days().includes(text));
    await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
    await ship(root, { source: SOURCE, fetched_ms: at + 2 * MINUTE, rows: [{ kind: "note", key: "n1", content: null, gone: true }] });
    await until("the gone imported", () => count(root, "SELECT count(*) FROM heads WHERE key = 'n1' AND version = 'gone'") === 1);
    const kept = () => Object.fromEntries((readHome(root, (db) => db.prepare("SELECT key, value FROM meta WHERE key LIKE 'owner:request:%'").all()) as { key: string; value: string }[])
      .map(({ key, value }) => [key, JSON.parse(value) as Record<string, unknown>]));
    const hiddenSpots = () => count(root, "SELECT count(*) FROM heads WHERE kind = 'hidden' AND version != 'gone'");
    const hide = { of: "places", kind: "hide", request: "request-before-erasure", latitude: 0.5, longitude: 0.5 };
    const hidden = await ask(sock, { verb: "owner-act", device: "dashboard-synthetic", action: hide }) as { id: string; position: string };
    expect(kept()["owner:request:request-before-erasure"]).toMatchObject({ of: "places", kind: "hide", id: hidden.id });
    const erased = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { records: number; units: number };
    expect(kept()).toEqual({
      "owner:request:request-before-erasure": { of: "places", act: null, kind: "hide", id: null, undoable: false, position: hidden.position, at_ms: expect.any(Number) },
    });
    expect(await ask(sock, { verb: "owner-act", device: "dashboard-synthetic", action: hide }), "a resend after an erasure states nothing again")
      .toEqual({ act: null, id: null, position: hidden.position });
    expect(hiddenSpots()).toBe(1);
    expect(await ask(sock, { verb: "owner-act", device: "dashboard-synthetic", action: { of: "places", kind: "unhide", request: "request-after-erasure", key: hidden.id.slice("hidden:".length) } }))
      .toMatchObject({ act: null, id: hidden.id });
    expect(hiddenSpots()).toBe(0);
    await askHome(sock, "resume", ["kind:extract"]);
    await until("the home caught up", () => quiet(root));
    const after = { erased, extracts: extracts(), days: days() };
    artifact(root, "erase-gone", after);
    expect(left(root, "n1")).toMatchObject({ statements: 0, heads: 0, erasures: 1 });
    expect(after.extracts).not.toContain(text);
    expect(after.days).not.toContain(text);
    expect(after.days).toContain("a note that stays");
    await home.stop();
  });

  it("an erasure whose day had not rendered again before the home stopped leaves the erased text in a day file, or loses the other note's line", async () => {
    const root = makeRoot("lifestream-erasure-restart-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    let home = await homeOn(root);
    const text = "a synthetic note the owner erases";
    const days = (): string => filesUnder(join(root, "days")).filter((file) => !file.startsWith("."))
      .map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", text, at), note("n2", "a note that stays", at + 1_000)] });
    await until("the day printed both notes", () => quiet(root) && days().includes(text) && days().includes("a note that stays"));
    await askHome(sock, "pause", ["kind:render", "--reason", "a test"]);
    await askHome(sock, "erase", ["notes", "n1", "--apply"]);
    await until("the extract read the erasure", () => count(root, "SELECT count(*) FROM jobs WHERE kind != 'render' AND state IN ('queued', 'running')") === 0);
    await home.stop();
    home = await homeOn(root);
    await askHome(sock, "resume", ["kind:render"]);
    await until("the day rendered again", () => quiet(root) && days().includes("a note that stays"));
    const after = days();
    artifact(root, "erase-restart", { days: after });
    expect(after).not.toContain(text);
    expect(after).toContain("a note that stays");
    await home.stop();
  });

  it("an erased day left with nothing renders as a completed empty day, which the search index reads as its replacement", async () => {
    const root = makeRoot("lifestream-erasure-empty-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    const sock = testSocket(root);
    const home = await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    const day = civilDay(at, { zone: "UTC", day_start_hour: 4 });
    const index = () => {
      const db = new Database(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!), { readonly: true });
      try {
        return db.prepare("SELECT inputs FROM days WHERE day = ?").get(day) as { inputs: string } | undefined;
      } finally {
        db.close();
      }
    };
    const listed = () => readHome(root, (db) => db.prepare("SELECT inputs FROM days WHERE day = ?").pluck().get(day) as string | undefined);
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "the one note of its day", at)] });
    await until("the index read the day", () => quiet(root) && existsSync(searchFileOf(root, process.env.LIFESTREAM_MACHINE_DIR!)) && index()?.inputs === listed());
    const before = listed();
    await askHome(sock, "erase", ["notes", "n1", "--apply"]);
    await until("the empty day rendered and read", () => quiet(root) && listed() !== undefined && index()?.inputs === listed());
    expect(existsSync(join(root, "days", `${day}.day.json`))).toBe(true);
    expect(readFileSync(join(root, "days", `${day}.day.json`), "utf8")).not.toContain("the one note of its day");
    expect(listed()).not.toBe(before);
    expect(index()).toEqual({ inputs: listed() });
    await home.stop();
  });

  it("an erasure leaves the error text of a set-aside unit", async () => {
    const root = makeRoot("lifestream-erasure-aside-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const home = await homeOn(root);
    const aside = () => count(root, "SELECT count(*) FROM extracts_aside WHERE family = 'notes'");
    const served = () => count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'");
    const at = Date.UTC(2026, 5, 1, 12);
    await ship(root, { source: SOURCE, fetched_ms: Date.now() - 2 * 60 * MINUTE, rows: [note("n1", "a note with a build", at)] });
    await until("the first unit built", () => quiet(root) && served() === 1);
    await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60 * MINUTE, rows: [note("n1", "a note with a build", at, { extract_throw: true }), note("n2", "a note with none", at + 24 * 60 * MINUTE, { extract_throw: true })] });
    await until("both units set aside", () => quiet(root) && aside() === 2);
    await askHome(sock, "pause", ["kind:extract", "--reason", "a test"]);
    await askHome(sock, "erase", ["notes", "n1", "--apply"]);
    expect(aside()).toBe(1);
    await askHome(sock, "erase", ["notes", "n2", "--apply"]);
    expect(aside()).toBe(0);
    await askHome(sock, "resume", ["kind:extract"]);
    await until("the home caught up", () => quiet(root));
    expect({ aside: aside(), served: served() }).toEqual({ aside: 0, served: 0 });
    await home.stop();
  });

  it("an erasure while its family rebuilds is published by the rebuild, or kept in its next generation", async () => {
    const root = makeRoot("lifestream-erasure-walk-", { sources: { [SOURCE]: "fake-rows" }, helpers: 3 });
    roots.push(root);
    const sock = testSocket(root);
    const gate = join(root, "walk-gate");
    await homeOn(root);
    const text = "a synthetic note the owner deletes mid-rebuild";
    const stored = (table: string): string => readHome(root, (db) => (db.prepare(`SELECT content FROM ${table} WHERE family = 'notes'`).pluck().all() as string[]).join("\n"));
    const days = (): string => filesUnder(join(root, "days")).map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");
    const at = Date.UTC(2026, 8, 1, 10, 0);
    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", text, at), note("n2", "a note that stays", at + MINUTE), note("n3", "the held note", at + 8 * 24 * 60 * MINUTE, { hold: gate })] });
    await until("the day printed the note", () => quiet(root) && days().includes(text));
    writeFileSync(gate, "");
    await askHome(sock, "rebuild", ["extracts", "--family", "notes"]);
    await until("the rebuild held with the note in its next generation", () => existsSync(`${gate}.held`) && stored("extracts_next").includes(text));
    const erased = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { records: number; units: number };
    expect({ served: stored("extracts").includes(text), next: stored("extracts_next").includes(text) }).toEqual({ served: false, next: false });
    rmSync(gate);
    await until("the rebuild walked again and published", () => quiet(root) && count(root, "SELECT seq FROM cursors WHERE name = 'rebuild:notes'") === 0);
    const after = { erased, served: stored("extracts"), next: count(root, "SELECT count(*) FROM extracts_next"), days: days() };
    artifact(root, "erase-walk", after);
    expect(after.served).not.toContain(text);
    expect(after.served).toContain("a note that stays");
    expect(after.next).toBe(0);
    expect(after.days).not.toContain(text);
    expect(left(root, "n1")).toMatchObject({ statements: 0, heads: 0, erasures: 1 });
  });

  it("a planner that read a unit before the unit went writes its asks back", async () => {
    const root = makeRoot("lifestream-erasure-unit-gone-", { sources: { [SOURCE]: "fake-rows" }, defaults: false, helpers: 3 });
    roots.push(root);
    const hold = join(root, "plan-hold");
    writeFileSync(hold, "");
    await homeOn(root);
    const at = Date.now() - 10 * MINUTE;
    const pending = () => count(root, "SELECT count(*) FROM asks WHERE family = 'notes' AND state = 'pending'");
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note with a photo", at, { photo: true, plan_hold: hold })] });
    await until("the plan holding", () => existsSync(`${hold}.held`));
    await ship(root, { source: SOURCE, fetched_ms: at + 2 * MINUTE, rows: [{ kind: "note", key: "n1", content: null, gone: true }] });
    await until("the unit gone", () => count(root, "SELECT count(*) FROM extracts WHERE family = 'notes'") === 0);
    rmSync(hold);
    await until("the home caught up", () => quiet(root));
    const after = { pending: pending(), marks: count(root, "SELECT count(*) FROM dirty_units WHERE family = 'notes'") };
    artifact(root, "unit-gone-planner", after);
    expect(after).toEqual({ pending: 0, marks: 0 });
  });

  it("an erasure says each receiver the thing went to and when before --apply, and what it keeps; after it no placeholder entry or ref of it stands, and the outbound rows do", async () => {
    const root = makeRoot("lifestream-erasure-outbound-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note with a photo", at, { photo: true }), note("n2", "a note that stays", at + 1_000)] });
    await until("the caption", () => count(root, "SELECT count(*) FROM enrichments WHERE item = 'photo:n1' AND state = 'done'") === 1);
    await until("the home caught up", () => quiet(root) && inFlight(root) === 0);
    const key = readLedger(root, (db) => db.prepare("SELECT key FROM requests WHERE unit = 'photo:n1'").pluck().get() as string)!;
    const day = readHome(root, (db) => JSON.parse(db.prepare("SELECT days FROM extracts WHERE family = 'notes'").pluck().get() as string) as string[])[0]!;
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    const sent_ms = Date.now();
    try {
      ledger.outbound.write({ at_ms: sent_ms, receiver: "OpenAI", route: "codex", by: null, what: "ask", tool: null, level: "all", counts: { person: 1 }, chars: 200, pictures: 1, key, attempt: 1 });
      ledger.outbound.write({
        at_ms: sent_ms, receiver: "Vault App", route: null, by: "p-agent", what: "read", tool: "search", level: "names", counts: { email: 1 }, chars: 90, pictures: 0, key: null, attempt: null,
        refs: [{ source: SOURCE, kind: "note", key: "n1" }, { source: SOURCE, kind: "note", key: "n2" }],
      });
      ledger.outbound.write({ at_ms: sent_ms, receiver: "Anthropic", route: null, by: "p-reader", what: "read", tool: "day", level: "all", counts: {}, chars: 400, pictures: 0, key: null, attempt: null, refs: [{ day }] });
      const ada: Marked[] = [{ text: "Ada Example", marks: [{ start: 0, end: 11, type: "person", who: "p-1" }] }];
      for (const scope of [`ask:${key}`, "chat:c1", "grant:p-agent"]) {
        const part = ledger.placeholders.part(scope, wantedOf(ada));
        ledger.placeholders.save(part, hideDetails(ada, "all", part.table, null).table);
      }
    } finally {
      ledger.close();
    }
    const today = civilDay(sent_ms, { zone: "UTC", day_start_hour: 4 });

    const print = await askHome(sock, "erase", ["notes", "n1"]) as { applied: boolean; sent: unknown; keeps: string };
    expect(print.applied).toBe(false);
    expect(print.sent).toEqual([
      { receiver: "Anthropic", days: [today], what: ["read"] }, { receiver: "OpenAI", days: [today], what: ["ask"] }, { receiver: "Vault App", days: [today], what: ["read"] },
    ]);
    expect(print.keeps).toEqual([
      "Delete it on your devices and at the provider too: each device's next delivery brings a copy into the inbox, where it is never shown.",
      "A delivery that holds it inside a larger file stays, unless you add --purge-deliveries.",
      "Each outbound row stays, with its receiver, time and counts; nothing in it names the thing any more.",
      "Chat starts a new context, and every agent sees new numbers.",
      "A kept answer of Ask's stays as it was said: its words and the titles it cited stay, and what it cited opens nothing.",
      "The search and screen indexes keep the erased words' bytes, found by no search, until their segments merge.",
      "On the disk: home.db's free space that was never written over, such as whole pages freed by ordinary work before the erasure, "
        + "until they are reused; the drive's freed blocks and its own copies; and any copy of the folder.",
      "Ask's Codex keeps its own log of tool answers for up to 10 days; it trims it itself.",
    ]);
    const applied = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { run: number; logs_kept: string[]; ms: Record<string, unknown> };
    const receipts = readHome(root, (db) => ({
      runs: db.prepare("SELECT id, subject FROM runs WHERE kind = 'erase'").all(),
      events: db.prepare("SELECT key FROM events WHERE kind = 'erase'").pluck().all(),
    }));
    expect(receipts).toEqual({ runs: [{ id: applied.run, subject: "notes" }], events: [String(applied.run)] });
    expect(JSON.stringify(receipts)).not.toContain("n1");
    expect(applied.logs_kept).toEqual([]);
    expect(Object.keys(applied.ms)).toEqual(["plan", "calls", "commit", "logs", "parts"]);
    expect(Object.keys(applied.ms.parts as object)).toEqual(["records", "ledger", "search", "blobs", "purge", "deliveries"]);

    const after = readLedger(root, (db) => ({
      rows: db.prepare("SELECT seq, receiver, what, key, counts FROM outbound ORDER BY seq").all(),
      refs: db.prepare("SELECT outbound, source, kind, key, day FROM outbound_refs ORDER BY outbound, rowid").all(),
      entries: db.prepare("SELECT scope, placeholder FROM placeholder_entries ORDER BY scope").all(),
      tables: db.prepare("SELECT scope, next FROM placeholder_tables ORDER BY scope").all(),
      epoch: db.prepare("SELECT value FROM meta WHERE key = 'forget'").pluck().get(),
      erasing: db.prepare("SELECT count(*) FROM meta WHERE key = 'erasing'").pluck().get(),
    }))!;
    artifact(root, "erase-outbound", { print, after });
    expect(after.rows).toEqual([
      { seq: 1, receiver: "OpenAI", what: "ask", key: null, counts: '{"person":1}' },
      { seq: 2, receiver: "Vault App", what: "read", key: null, counts: '{"email":1}' },
      { seq: 3, receiver: "Anthropic", what: "read", key: null, counts: "{}" },
    ]);
    expect(after.refs).toEqual([{ outbound: 2, source: SOURCE, kind: "note", key: "n2", day: null }, { outbound: 3, source: null, kind: null, key: null, day }]);
    expect(after.entries).toEqual([]);
    expect(after.tables).toEqual([{ scope: "chat:c1", next: '{"person":2}' }, { scope: "grant:p-agent", next: '{"person":2}' }]);
    expect(after.epoch).toBe("2");
    expect(after.erasing).toBe(0);
  });

  it("an erasure leaves no kept mark of the thing's passages, its own words' and its day's lines', and keeps those of a note that stays", async () => {
    const root = makeRoot("lifestream-erasure-marks-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note Ada Example wrote", at), note("n2", "a note that stays", at - 3 * 24 * 60 * MINUTE)] });
    const machine = process.env.LIFESTREAM_MACHINE_DIR!;
    const texts = (key: string): string[] => {
      const index = SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine));
      if (index === undefined) return [];
      try {
        return index.textsOf([{ source: SOURCE, kind: "note", key }], []);
      } finally {
        index.close();
      }
    };
    await until("the index holds both notes", () => quiet(root) && texts("n1").some((text) => text.includes("Ada Example")) && texts("n2").length > 0);
    const digests = (list: readonly string[]) => [...new Set(list.flatMap((text) => passagesOf(text).map((passage) => sha256(text.slice(passage.start, passage.end)))))];
    const erased = digests(texts("n1"));
    const stays = digests(texts("n2")).filter((digest) => !erased.includes(digest));
    const store = openMarks(openHomeFolder(root), marksFileOf(root, machine));
    const model = { id: "privacy-filter", file: "sha256:0f0f", decode: "1" };
    try {
      store.write(model, new Map([...erased, ...stays].map((digest) => [digest, []])), store.epoch);
      expect(store.read(erased, model).size).toBe(erased.length);
      await askHome(sock, "erase", ["notes", "n1", "--apply"]);
      const after = { erased: store.read(erased, model).size, stays: store.read(stays, model).size };
      artifact(root, "erase-marks", { texts: { n1: erased.length, n2: stays.length }, after });
      expect(after).toEqual({ erased: 0, stays: stays.length });
      expect(stays.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("a newer delivery that states an erased note again stores its file or its bytes, beyond any erasure's reach", async () => {
    const root = makeRoot("lifestream-erasure-stored-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    const own = Buffer.from("a synthetic photo only the erased note names");
    const shared = Buffer.from("a synthetic photo a later note names too");
    const carried = "synthetic bytes the erased note carries";
    const blob = (bytes: Buffer | string) => `sha256:${hex(Buffer.from(bytes))}`;
    const rows = (...list: object[]) => Buffer.from(`${list.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const n1 = { ...note("n1", "a synthetic note the owner erases", at), blobs: [blob(own), blob(shared)] };
    const n2 = { ...note("n2", "a synthetic note with bytes of its own", at + 1_000), stores: carried };
    const stored = () => Object.fromEntries(([["own", own], ["shared", shared], ["carried", carried]] as const)
      .map(([name, bytes]) => [name, existsSync(sharded(join(root, "blobs"), hex(Buffer.from(bytes))))]));
    const imported = (id: string) => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(id)) === "imported";
    const first = await shipFiles(root, SOURCE, at + MINUTE, { "rows.ndjson": rows(n1, n2), "own.bin": own, "shared.bin": shared }, { transit: true });
    await until("the first export imported", () => imported(first) && quiet(root));
    expect(stored()).toEqual({ own: true, shared: true, carried: true });
    for (const key of ["n1", "n2"]) await askHome(sock, "erase", ["notes", key, "--apply"]);
    expect(stored()).toEqual({ own: false, shared: false, carried: false });
    const n3 = { ...note("n3", "a synthetic note that stays", at + 2_000), blobs: [blob(shared)] };
    const second = await shipFiles(root, SOURCE, at + 2 * MINUTE, { "rows.ndjson": rows(n1, n2, n3), "own.bin": own, "shared.bin": shared }, { transit: true });
    await until("the second export imported", () => imported(second) && quiet(root));
    const counts = JSON.parse(readHome(root, (db) => db.prepare("SELECT r.counts FROM deliveries d JOIN runs r ON r.id = d.run WHERE d.id = ?").pluck().get(second)) as string) as { erased: number; new: number };
    expect([counts.erased, counts.new]).toEqual([2, 1]);
    expect(stored()).toEqual({ own: false, shared: true, carried: false });
    expect([left(root, "n1"), left(root, "n2")].map(({ heads, erasures }) => ({ heads, erasures }))).toEqual([{ heads: 0, erasures: 1 }, { heads: 0, erasures: 1 }]);
    expect(count(root, "SELECT count(*) FROM heads WHERE key = 'n3'")).toBe(1);
    artifact(root, "erase-stored", { counts, stored: stored() });
  });

  it("a planner that read a note before its erasure asks its photo after", async () => {
    const root = makeRoot("lifestream-erasure-planner-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const hold = join(root, "plan-hold");
    writeFileSync(hold, "");
    await homeOn(root);
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note with a photo", at, { photo: true, plan_hold: hold })] });
    await until("the plan holding", () => existsSync(`${hold}.held`));
    const erased = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { records: number };
    expect(erased.records).toBe(1);
    rmSync(hold);
    await ship(root, { source: SOURCE, fetched_ms: at + 2 * MINUTE, rows: [note("n2", "a later note", at + MINUTE, { photo: true })] });
    await until("the later caption", () => count(root, "SELECT count(*) FROM enrichments WHERE item = 'photo:n2' AND state = 'done'") === 1);
    await until("the home caught up", () => quiet(root) && inFlight(root) === 0);
    expect(left(root, "n1")).toEqual({ statements: 0, heads: 0, erasures: 1, enrichments: 0, requests: 0 });
    artifact(root, "erase-planner", { erased, after: left(root, "n1"), later: left(root, "n2") });
  });

  it("an erasure that names nothing stops a running import, or one with work erases beside its helpers", async () => {
    const root = makeRoot("lifestream-erasure-unheld-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const stops: (string | undefined)[] = [];
    const home = await startHere(root, { tickMs: TICK_MS, log: (line) => {
      if (!line.includes("\"stopped\":\"the home is held\"")) return;
      stops.push((JSON.parse(line) as { job?: string }).job);
    } });
    const hold = join(root, "import-hold");
    const importing = () => count(root, "SELECT count(*) FROM jobs WHERE kind = 'import' AND key = ? AND state = 'running'", SOURCE);
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at, rows: [note("n1", "a note the owner erases", at)] });
    await until("n1 imported", () => quiet(root) && count(root, "SELECT count(*) FROM heads WHERE key = 'n1'") === 1);
    writeFileSync(hold, "");
    await ship(root, { source: SOURCE, fetched_ms: at + MINUTE, rows: [{ hold }, note("n2", "a later note", at + MINUTE)] });
    await until("the import holding", () => existsSync(`${hold}.held`));
    for (const rest of [["--apply"], ["--purge-deliveries"], ["--purge-deliveries", "--apply"]]) {
      await expect(askHome(sock, "erase", ["notes", "absent", ...rest])).rejects.toThrow("names no record for absent");
    }
    expect({ stops, importing: importing() }).toEqual({ stops: [], importing: 1 });
    const erased = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { records: number };
    expect({ records: erased.records, import_stopped: stops.includes("import") }).toEqual({ records: 1, import_stopped: true });
    rmSync(hold);
    await until("n2 imported after the erasure", () => quiet(root) && count(root, "SELECT count(*) FROM heads WHERE key = 'n2'") === 1);
    expect(left(root, "n1")).toMatchObject({ statements: 0, heads: 0, erasures: 1 });
    artifact(root, "erase-unheld", { erased, stops });
    await home.stop();
  });

  it("an erasure misses a day that still prints a unit that moved, its files, its row, its search atoms and its marks, and the dry run misses who received that day", async () => {
    const other = "apple-notes:local:device-b";
    const root = makeRoot("lifestream-erasure-moved-", { sources: { [SOURCE]: "fake-rows", [other]: "fake-rows" }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const noonA = Date.UTC(2026, 9, 20, 12);
    const [dayA, dayB] = ["2026-10-20", "2026-10-21"];
    const text = "zqxmovednote at the lighthouse";
    const dayFiles = (day: string) => [".day.json", ".day.txt", ".day.lines.json"].filter((suffix) => existsSync(join(root, "days", `${day}${suffix}`)));
    const printed = (day: string) => (existsSync(join(root, "days", `${day}.day.txt`)) ? readFileSync(join(root, "days", `${day}.day.txt`), "utf8") : "");
    await ship(root, { source: SOURCE, fetched_ms: Date.now() - 10 * MINUTE, rows: [note("n1", text, noonA)] });
    await ship(root, { source: other, fetched_ms: Date.now() - 10 * MINUTE, rows: [note("n2", "a note that stays on its day", noonA + MINUTE)] });
    await until("day A printed both notes", () => quiet(root) && printed(dayA).includes(text) && printed(dayA).includes("a note that stays"));
    const ref = { source: SOURCE, kind: "note", key: "n1" };
    const textsOf = (days: string[]) => {
      const index = SearchIndex.read(openHomeFolder(root), searchFileOf(root, machine().dir));
      if (index === undefined) return [];
      try {
        return index.textsOf([ref], days);
      } finally {
        index.close();
      }
    };
    await until("the index holds the note", () => quiet(root) && found(root, "zqxmovednote") > 0);
    const digests = [...new Set(textsOf([dayA]).flatMap((each) => passagesOf(each).map((passage) => sha256(each.slice(passage.start, passage.end)))))];

    await askHome(sock, "pause", ["kind:render", "--reason", "a test"]);
    await ship(root, { source: SOURCE, fetched_ms: Date.now() - 5 * MINUTE, rows: [note("n1", text, noonA + 24 * 60 * MINUTE)] });
    const unitA = `${SOURCE}/${dayA}`;
    await until("the note's unit on day A gone, the rest caught up", () => count(root, "SELECT count(*) FROM extracts WHERE family = 'notes' AND unit = ?", unitA) === 0
      && count(root, "SELECT count(*) FROM jobs WHERE kind != 'render' AND state IN ('queued', 'running')") === 0);
    expect(printed(dayA)).toContain(text);
    expect(count(root, "SELECT count(*) FROM day_units WHERE family = 'notes' AND unit = ?", unitA)).toBe(1);
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    try {
      ledger.outbound.write({ at_ms: Date.now(), receiver: "Day Reader", route: null, by: "p-reader", what: "read", tool: "day", level: "all", counts: {}, chars: 400, pictures: 0, key: null, attempt: null, refs: [{ day: dayA }] });
    } finally {
      ledger.close();
    }
    const store = openMarks(openHomeFolder(root), marksFileOf(root, machine().dir));
    const model = { id: "privacy-filter", file: "sha256:0f0f", decode: "1" };
    try {
      store.write(model, new Map(digests.map((digest) => [digest, []])), store.epoch);
      const print = await askHome(sock, "erase", ["notes", "n1"]) as { sent: { receiver: string }[] };
      expect(print.sent.map((each) => each.receiver)).toContain("Day Reader");
      const applied = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { days: string[] };
      expect(applied.days).toEqual([dayA, dayB]);
      const after = { files: dayFiles(dayA), row: count(root, "SELECT count(*) FROM days WHERE day = ?", dayA), found: found(root, "zqxmovednote"), marks: store.read(digests, model).size };
      artifact(root, "erase-moved", { print, applied, after });
      expect(after).toEqual({ files: [], row: 0, found: 0, marks: 0 });
      expect(digests.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
    await askHome(sock, "resume", ["kind:render"]);
    await until("day A rendered again", () => quiet(root) && printed(dayA).includes("a note that stays"));
    expect(printed(dayA)).not.toContain(text);
    expect(printed(dayB)).not.toContain(text);
  });

  it("an erasure of a record leaves an agent's access as it is, and no value in People's or Places' memo, or the jobs never answer again", async () => {
    const root = makeRoot("lifestream-erasure-access-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a synthetic note the owner erases", at), note("n2", "a note that stays", at + 1_000)] });
    const dirs = (["people", "places"] as const).map((name) => ({ name, dir: preparedDirOf(root, machine().dir, name) }));
    const files = () => dirs.map(({ name, dir }) => ({ prepared: existsSync(preparedFileOf(dir, name)), memo: existsSync(join(dir, "memo.db")) }));
    await until("both prepared, each with its memo", () => quiet(root) && files().every((each) => each.prepared && each.memo));
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: accountAccess(accountOf(SOURCE)), covers: [] }, { at_ms: at, by: "person", device: "pass-phone-a" });
    } finally {
      ledger.close();
    }
    for (const kind of ["people", "places"]) await askHome(sock, "pause", [`kind:${kind}`, "--reason", "a test"]);
    await askHome(sock, "erase", ["notes", "n1", "--apply"]);
    expect(files()).toEqual([{ prepared: false, memo: false }, { prepared: false, memo: false }]);
    const reader = openLedger(openHomeFolder(root), { mode: "write" });
    let access: unknown;
    try {
      access = { lines: reader.access.get(READER)?.lines, last: reader.access.changes(READER, { limit: 1 })[0]?.what };
    } finally {
      reader.close();
    }
    expect(access).toEqual({ lines: accountAccess(accountOf(SOURCE)), last: "granted" });
    for (const kind of ["people", "places"]) await askHome(sock, "resume", [`kind:${kind}`]);
    await until("both prepared again", () => quiet(root) && files().every((each) => each.prepared));
    artifact(root, "erase-access", { access, files: files() });
  });

  it("an access line the scrub refuses lets the erasure remove a day file, a blob, a search entry or a prepared file under records that stand", async () => {
    const root = makeRoot("lifestream-erasure-refused-", { sources: { [SOURCE]: "fake-rows" }, settings: { "families.notes": { text: "1" } } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    const own = Buffer.from("a synthetic photo only the refused erasure's note names");
    const text = "zqxrefusednote by the harbour";
    const n1 = { ...note("n1", text, at), blobs: [`sha256:${hex(own)}`] };
    const delivery = await shipFiles(root, SOURCE, at + MINUTE, { "rows.ndjson": Buffer.from(`${JSON.stringify(n1)}\n`), "own.bin": own }, { transit: true });
    const dirs = (["people", "places"] as const).map((name) => preparedFileOf(preparedDirOf(root, machine().dir, name), name));
    const days = (): string => filesUnder(join(root, "days")).filter((file) => !file.startsWith(".")).map((file) => readFileSync(join(root, "days", file), "utf8")).join("\n");
    const stands = () => ({
      blob: existsSync(sharded(join(root, "blobs"), hex(own))), day: days().includes(text), found: found(root, "zqxrefusednote") > 0,
      prepared: dirs.map((file) => existsSync(file)), heads: count(root, "SELECT count(*) FROM heads WHERE key = 'n1'"),
    });
    const all = { blob: true, day: true, found: true, prepared: [true, true], heads: 1 };
    await until("the note everywhere", () => readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(delivery)) === "imported"
      && quiet(root) && JSON.stringify(stands()) === JSON.stringify(all));
    const ledger = openLedger(openHomeFolder(root), { mode: "write" });
    try {
      ledger.access.change(READER, { from: 0, what: "granted", lines: { not: "an access" }, covers: [] }, { at_ms: at, by: "person", device: "pass-phone-a" });
    } finally {
      ledger.close();
    }
    await expect(askHome(sock, "erase", ["notes", "n1", "--apply"])).rejects.toThrow();
    const after = stands();
    const intent = JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'erasure'").pluck().get() as string)) as Record<string, unknown>;
    artifact(root, "erase-refused", { after, intent });
    expect(after).toEqual(all);
    expect(count(root, "SELECT count(*) FROM erasures")).toBe(0);
    expect(intent).toMatchObject({ family: "notes", thing: "n1", step: "access", error: expect.any(String), failed_ms: expect.any(Number) });
  });

  it("an erasure writes while a model call holds calls.lock, goes on without the lock, says nothing while it waits, or a call sends while it holds the lock", async () => {
    const root = makeRoot("lifestream-erasure-barrier-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const ledgerPath = join(root, "replies", "replies.db");
    await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note with a photo", at, { photo: true }), note("n2", "a note that stays", at + 1_000)] });
    await until("the caption answered", () => count(root, "SELECT count(*) FROM enrichments WHERE state = 'done'") === 1 && quiet(root) && inFlight(root) === 0);
    const key = readLedger(root, (db) => db.prepare("SELECT key FROM requests WHERE unit = ?").pluck().get("photo:n1")) as string;
    const standing = () => ({
      intent: count(root, "SELECT count(*) FROM meta WHERE key = 'erasure'"),
      erasing: readLedger(root, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'erasing'").pluck().get()),
      heads: count(root, "SELECT count(*) FROM heads WHERE key = 'n1'"),
    });

    const call = trySharedLock(callsLock(ledgerPath))!;
    const said: string[] = [];
    const applying = askHome(sock, "erase", ["notes", "n1", "--apply"], (line) => said.push(line));
    let settled = false;
    void applying.finally(() => { settled = true; }).catch(() => undefined);
    await until("the erasure says it waits", () => said.includes("waiting for model calls to end") || settled);
    expect({ said, settled, ...standing() }).toEqual({ said: ["waiting for model calls to end"], settled: false, intent: 0, erasing: 0, heads: 1 });

    const hold = join(root, "erasure-hold");
    writeFileSync(hold, "");
    const env = { failpoint: process.env.LIFESTREAM_FAILPOINT, hold: process.env.LIFESTREAM_HOLD };
    process.env.LIFESTREAM_FAILPOINT = "erase.held";
    process.env.LIFESTREAM_HOLD = hold;
    onTestFinished(() => {
      for (const [name, value] of [["LIFESTREAM_FAILPOINT", env.failpoint], ["LIFESTREAM_HOLD", env.hold]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    call.release();
    await until("the erasure holds calls.lock", () => existsSync(`${hold}.hits`) || settled);
    let sends = 0;
    const fake = fakeTransport({ reply: "a synthetic caption" });
    const busy = await runCall({
      folder: openHomeFolder(dirname(dirname(ledgerPath))), key, route: { transport: "fake", timeout_ms: 30_000 }, copies: join(root, "calls"),
      transport: () => ({ ...fake, send: (...args: Parameters<typeof fake.send>) => { sends++; return fake.send(...args); } }),
    });
    expect({ outcome: busy.outcome, sent: busy.sent, sends }).toEqual({ outcome: "busy", sent: false, sends: 0 });
    rmSync(hold);
    const applied = await applying as { records: number; ms: Record<string, unknown> };
    artifact(root, "erase-barrier", { said, busy, applied });
    expect(applied).toMatchObject({ applied: true, records: 1, ms: { calls: expect.any(Number) } });
    expect(standing()).toEqual({ intent: 0, erasing: 0, heads: 0 });
    expect(left(root, "n1")).toMatchObject({ erasures: 1, requests: 0 });
  });

  it("an erasure whose client left while it waited for a model call goes on, writes, or keeps the home held", async () => {
    const root = makeRoot("lifestream-erasure-left-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", "a note the owner erases", at), note("n2", "a note that stays", at + 1_000)] });
    await until("the notes landed", () => quiet(root) && count(root, "SELECT count(*) FROM heads WHERE key IN ('n1', 'n2')") === 2);
    const standing = () => ({
      intent: count(root, "SELECT count(*) FROM meta WHERE key = 'erasure'"),
      erasing: readLedger(root, (db) => db.prepare("SELECT count(*) FROM meta WHERE key = 'erasing'").pluck().get()),
      heads: count(root, "SELECT count(*) FROM heads WHERE key = 'n1'"),
      erasures: count(root, "SELECT count(*) FROM erasures"),
    });

    const call = trySharedLock(callsLock(join(root, "replies", "replies.db")))!;
    onTestFinished(() => call.release());
    const said: string[] = [];
    const leaving = new AbortController();
    const applying = ask(sock, { verb: "erase", args: ["notes", "n1", "--apply"], cwd: root, by: "terminal" }, (line) => said.push(line), undefined, leaving.signal)
      .then(() => "answered", () => "left");
    await until("the erasure says it waits", () => said.includes("waiting for model calls to end"));

    leaving.abort();
    expect(await applying).toBe("left");
    await until("the home is held no more", async () => {
      await askHome(sock, "erase", ["notes", "n2", "--purge-deliveries"]);
      return true;
    });
    call.release();
    const after = standing();
    artifact(root, "erase-left", { said, after });
    expect(after).toEqual({ intent: 0, erasing: 0, heads: 1, erasures: 0 });
  });

  it("a running home's erasure leaves the erased text in a page it freed whole, or in home.db's log", async () => {
    const root = makeRoot("lifestream-erasure-bytes-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    await homeOn(root);
    const TOKEN = "zqxsecureverbtoken";
    const text = `${TOKEN} `.repeat(Math.floor(3_990 / (TOKEN.length + 1)));
    const at = Date.now() - 30 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at + 1_000, rows: [note("n1", text, at), note("n2", "a note that stays", at + 1_000)] });
    await until("the notes landed", () => quiet(root) && count(root, "SELECT count(*) FROM heads WHERE key IN ('n1', 'n2')") === 2);
    expect(count(root, "SELECT count(*) FROM versions WHERE key = 'n1' AND typeof(text) = 'text' AND length(CAST(text AS BLOB)) > 4_000")).toBe(1);
    const holding = () => ["home.db", "home.db-wal"].filter((file) => existsSync(join(root, file)) && readFileSync(join(root, file)).includes(Buffer.from(TOKEN)));
    expect(holding()).not.toEqual([]);

    const erased = await askHome(sock, "erase", ["notes", "n1", "--apply"]) as { records: number; logs_kept: string[] };
    const after = { logs_kept: erased.logs_kept, holding: holding() };
    artifact(root, "erase-bytes", after);
    expect(erased.records).toBe(1);
    expect(after).toEqual({ logs_kept: [], holding: [] });
  });

  it("an erasure begun while the copier's copy is out waits for that copy, the hold sends no other, and its truncate empties home.db's log", async () => {
    const root = makeRoot("lifestream-erasure-copy-", { sources: { [SOURCE]: "fake-rows" } });
    roots.push(root);
    const sock = testSocket(root);
    const copyHold = join(root, "copier-hold");
    const importHold = join(root, "import-hold");
    const kept = { failpoint: process.env.LIFESTREAM_FAILPOINT, hold: process.env.LIFESTREAM_HOLD };
    process.env.LIFESTREAM_FAILPOINT = "copier.copied";
    process.env.LIFESTREAM_HOLD = copyHold;
    const stops: string[] = [];
    let home: Awaited<ReturnType<typeof startHere>> | undefined;
    onTestFinished(async () => {
      rmSync(copyHold, { force: true });
      rmSync(importHold, { force: true });
      await home?.stop();
      for (const [name, value] of [["LIFESTREAM_FAILPOINT", kept.failpoint], ["LIFESTREAM_HOLD", kept.hold]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
    home = await startHere(root, { tickMs: TICK_MS, log: (line) => {
      if (line.includes("\"stopped\":\"the home is held\"")) stops.push(line);
    } });
    const copies = () => existsSync(`${copyHold}.hits`) ? readFileSync(`${copyHold}.hits`, "utf8").trim().split("\n").length : 0;
    const at = Date.now() - 10 * MINUTE;
    await ship(root, { source: SOURCE, fetched_ms: at, rows: [note("n1", "a note the owner erases", at)] });
    await until("n1 imported", () => quiet(root) && count(root, "SELECT count(*) FROM heads WHERE key = 'n1'") === 1);
    writeFileSync(importHold, "");
    await ship(root, { source: SOURCE, fetched_ms: at + MINUTE, rows: [{ hold: importHold }, note("n2", "a later note", at + MINUTE)] });
    await until("the import holding", () => existsSync(`${importHold}.held`));

    writeFileSync(copyHold, "");
    const before = copies();
    const filler = new Database(join(root, "home.db"));
    filler.pragma("wal_autocheckpoint = 0");
    filler.prepare("INSERT INTO meta (key, value) VALUES ('test-filler', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run("a".repeat((CHECKPOINT_PAGES + 64) * 4096));
    filler.close();
    await until("the copier held after its copy", () => copies() > before);
    const erasing = askHome(sock, "erase", ["notes", "n1", "--apply"]) as Promise<{ records: number; logs_kept: string[] }>;
    await until("the hold stopped the import", () => stops.length > 0);
    const held = copies() - before;
    rmSync(copyHold);
    const erased = await erasing;
    rmSync(importHold);
    const after = { records: erased.records, logs_kept: erased.logs_kept, held };
    artifact(root, "erase-copy-out", after);
    expect(after).toEqual({ records: 1, logs_kept: [], held: 1 });
  });
});

describe("a killed call's copies", () => {
  const killedCall = (copies: string): string => {
    mkdirSync(join(copies, "a-killed-call"), { recursive: true });
    writeFileSync(join(copies, "a-killed-call", "attachment-0.jpg"), "synthetic copy of an attachment");
    return join(copies, "a-killed-call");
  };
  const erasedM1 = async (home: TestHome): Promise<void> => {
    const ctx = context(home, { families: [messages] });
    onTestFinished(() => ctx.close());
    land(home.db, { source: "imessage:local:mac-0001", stated_ms: T0, name: "d1", rows: [{ kind: "msg", key: "m1", content: { chat: "c1", date: "2026-09-01", text: "a synthetic message" } }] });
    home.db.commit((tx) => tx.tables.meta.set(INTENT_META, canonical({ family: "messages", thing: "m1", reason: null, purge: false, deliveries: [], at_ms: T0 })));
    expect(await resumeErasure(ctx, standingIntent(ctx)!)).toMatchObject({ applied: true, records: 1 });
  };

  it("a plain home's start leaves them at <machine>/calls/<home id>/", async () => {
    const root = makeRoot("lifestream-call-copies-start-", { sources: { [SOURCE]: "fake-rows" } });
    onTestFinished(() => removeRoot(root));
    const copies = callCopiesAt(root, machine().dir);
    onTestFinished(() => removeDir(copies));
    expect(existsSync(killedCall(copies))).toBe(true);
    await startHere(root, { tickMs: TICK_MS, log: () => undefined });
    expect(existsSync(copies)).toBe(false);
  });

  it("a plain home's erasure leaves them at <machine>/calls/<home id>/", async () => {
    const root = tempDir("erasure-plain-copies");
    onTestFinished(() => removeDir(root));
    writeFolder(root);
    const home = openTestHome(root);
    onTestFinished(() => home.close());
    const copies = callCopiesAt(root, machine().dir);
    onTestFinished(() => removeDir(copies));
    killedCall(copies);
    await erasedM1(home);
    expect(existsSync(copies)).toBe(false);
  });

  it("a keyed home's erasure leaves a call's work in scratch, or empties another program's work", async () => {
    const root = tempDir("erasure-keyed-copies");
    onTestFinished(() => removeDir(root));
    writeFolder(root);
    const folder = keyedFolder(root, machine().dir);
    const home = openTestHome(root, folder);
    onTestFinished(() => home.close());
    const calls = join(machine().dir, "scratch", "call");
    const call = openHandedFolder(folder.handOver(["files"], "call")).work("call");
    writeFileSync(join(call.path, "attachment-0.jpg"), "synthetic copy of an attachment");
    const read = folder.work("read");
    onTestFinished(() => read.empty());
    writeFileSync(join(read.path, "copy.jpg"), "synthetic copy of a read");
    expect(readdirSync(calls)).toContain(basename(call.path));
    await erasedM1(home);
    expect(existsSync(calls)).toBe(false);
    expect(readdirSync(read.path)).toEqual(["copy.jpg"]);
  });
});

describe("an erasure's intent", () => {
  it("a failed try's error stays in a page its intent's rewrite or delete freed", async () => {
    const root = tempDir("erasure-intent-bytes");
    onTestFinished(() => removeDir(root));
    writeFolder(root);
    const home = openTestHome(root);
    const ctx = context(home, { families: [messages] });
    onTestFinished(() => {
      ctx.close();
      home.close();
    });
    const mac = "imessage:local:mac-0001";
    land(home.db, { source: mac, stated_ms: T0, name: "d1", rows: [{ kind: "msg", key: "m1", content: { chat: "c1", date: "2026-09-01", text: "a synthetic message" } }] });
    const holds = (token: string): boolean => {
      expect(home.db.checkpoint("truncate", 1_000).busy).toBe(0);
      return ["home.db", "home.db-wal"].some((file) => existsSync(join(root, file)) && readFileSync(join(root, file)).includes(Buffer.from(token)));
    };
    const deliveries = Array.from({ length: 80 }, (_, index) => `${mac}/synthetic-delivery-${String(index).padStart(4, "0")}`);
    const stands = (thing: string) => home.db.commit((tx) => tx.tables.meta.set(INTENT_META, canonical({ family: "messages", thing, reason: null, purge: true, deliveries, at_ms: T0 })));

    stands("m1");
    recordFailure(ctx, "calls", new Error("zqxfirsterror: a synthetic failure"));
    expect(holds("zqxfirsterror")).toBe(true);
    recordFailure(ctx, "calls", new Error("zqxseconderror: a synthetic failure"));
    const rewritten = holds("zqxfirsterror");
    expect(await resumeErasure(ctx, standingIntent(ctx)!)).toMatchObject({ applied: true, records: 1 });
    const applied = holds("zqxseconderror");
    stands("m-none");
    recordFailure(ctx, "plan", new Error("zqxthirderror: a synthetic failure"));
    expect(holds("zqxthirderror")).toBe(true);
    expect(await resumeErasure(ctx, standingIntent(ctx)!)).toBeNull();
    const ended = holds("zqxthirderror");
    expect({ rewritten, applied, ended }).toEqual({ rewritten: false, applied: false, ended: false });
  });
});
