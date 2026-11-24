import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { get } from "node:http";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { serveDoor } from "./door.js";
import { machine } from "./machine.js";
import { PEOPLE, preparedDirOf, preparedFileOf, writePrepared } from "./prepared.js";
import { mintPrincipal } from "./principals.js";
import type { Ran } from "./reader.js";
import { acquisitionBundle, cleanup, custodyKept, custodyRun, DEVICE, makeHome, NOW_MS, PHONE_SOURCE, PHONE_UNIT, phoneBundle, REPO } from "./test/support.js";
import { until } from "./test/harness-root.js";
import { testSocket } from "./test/folder.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";

const opened: string[] = [];
let ran: { file: string; sql: string; params: unknown[] }[] | null = null;
vi.mock("better-sqlite3", async (original) => {
  type Statement = Record<"get" | "all" | "run" | "iterate", (...params: unknown[]) => unknown>;
  const Real = ((await original()) as { default: new (...args: unknown[]) => { name: string; prepare(sql: string): Statement } }).default;
  class Counted extends Real {
    constructor(...args: unknown[]) {
      super(...args);
      if (typeof args[0] === "string") opened.push(args[0]);
    }
    override prepare(sql: string): Statement {
      const statement = super.prepare(sql);
      for (const method of ["get", "all", "run", "iterate"] as const) {
        const real = statement[method].bind(statement);
        statement[method] = (...params: unknown[]) => {
          ran?.push({ file: this.name, sql, params });
          return real(...params);
        };
      }
      return statement;
    }
  }
  return { default: Counted };
});

const report: Record<string, unknown> = {};
const roots: string[] = [];

afterEach(() => cleanup(roots));

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "knock.json"), `${JSON.stringify(report, null, 2)}\n`);
});

const UNIT = "macbook-pro-0001";
const PRODUCTS = ["screen", "machine", "input", "audio", "upload", "claude-code", "codex"].map((product) => `${product}:local:${UNIT}`);
const ACCOUNTS = ["imessage", "apple-calls", "apple-notes", "apple-calendar", "apple-reminders", "safari", "screen-time", "now-playing", "chrome", "aqua-voice", "wispr-flow", "whatsapp"]
  .map((product) => `${product}:person-a@example.com:${UNIT}`);
const SOURCES = [...PRODUCTS, ...ACCOUNTS];
const PHONES = ["iphone-17-pro-aa01", "iphone-14-bb02"];
const SEALS = 14;
const ASKS = 2_000;
const NOTES = `notes:local:${PHONE_UNIT}`;
const SEALED = PRODUCTS[1]!;
const GROWING = /\b(?:FROM|JOIN)\s+(deliveries|seals|sealed)\b(?:\s+(?:AS\s+)?(?!(?:WHERE|INDEXED|NOT|ON|JOIN|ORDER|GROUP|LIMIT|UNION)\b)(\w+))?/giu;
const WAITING_ON_PERSON = /\bUSING (?:COVERING )?INDEX (?:deliveries_unread|deliveries_lost)\b/u;

const ONE_ROW: Readonly<Record<string, RegExp>> = { deliveries: /\bseal=\?/u, seals: /\bname=\?/u, sealed: /\bname=\?/u };
const ONE_END = /\bUSING (?:COVERING )?INDEX (?:sealed_newest|seals_read|deliveries_seals)\b/u;

interface Planned {
  readonly file: "home.db" | "door/custody.db";
  readonly sql: string;
  readonly plan: string[];
}

function walks(plans: readonly Planned[]): { table: string; line: string; sql: string }[] {
  return plans.flatMap(({ sql, plan }) => growing(sql, plan).filter(({ table, line }) => line.startsWith("SEARCH")
    ? /\b(?:pass|lane)=\?/u.test(line) && !ONE_ROW[table]!.test(line) && !ONE_END.test(line)
    : !WAITING_ON_PERSON.test(line)).map((read) => ({ ...read, sql })));
}

function growing(sql: string, plan: readonly string[]): { table: string; line: string }[] {
  const names = new Map<string, string>();
  for (const [, table, alias] of sql.matchAll(GROWING)) names.set(alias ?? table!, table!);
  return plan.flatMap((line) => {
    const table = names.get(/^(?:SCAN|SEARCH) (\w+)/u.exec(line)?.[1] ?? "");
    return table === undefined ? [] : [{ table, line }];
  });
}

const fromReaders = (statements: Ran[]) => { ran?.push(...statements); };
const READ_FILES = /(?:home|people|places)\.db$/u;

async function recorded<T>(work: () => Promise<T>): Promise<{ value: T; statements: NonNullable<typeof ran> }> {
  const statements: NonNullable<typeof ran> = [];
  ran = statements;
  try {
    return { value: await work(), statements };
  } finally {
    ran = null;
  }
}

async function planned(statements: NonNullable<typeof ran>): Promise<Planned[]> {
  const Database = (await import("better-sqlite3")).default;
  const plans = new Map<string, Planned>();
  for (const { file, sql, params } of statements) {
    if (!/^\s*(?:SELECT|WITH)\b/iu.test(sql) || !file.endsWith(".db") || plans.has(`${file}\0${sql}`)) continue;
    const reader = new Database(file, { readonly: true, fileMustExist: true });
    try {
      const plan = (reader.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map((row) => row.detail);
      plans.set(`${file}\0${sql}`, { file: file.endsWith(join("door", "custody.db")) ? "door/custody.db" : "home.db", sql: sql.replace(/\s+/gu, " "), plan });
    } finally {
      reader.close();
    }
  }
  return [...plans.values()];
}

describe("a knock", () => {
  it("relays nothing new to the home, scans for the needs, reads a pass's seals in an answer, a restore or a seal, or opens home.db or a prepared file on the door's own thread", async () => {
    const at = makeHome({}, roots);
    const token = "synthetic-token-the-mac-of-the-knock-xxxxxx".slice(0, 43);
    const pass = mintPrincipal(openHomeFolder(at.root), { unit: UNIT, kind: "mac", scopes: ["deliver"], sources: SOURCES, token, now_ms: NOW_MS }).principal.id;
    const seeded = performance.now();
    const home = openHome(openHomeFolder(at.root), "migrate");
    home.commit((tx) => {
      tx.tables.meta.set(`setup:${UNIT}:found`, "0");
      for (const id of SOURCES) tx.tables.sources.add({ id, vendor: vendorOf(declarations(), id), connector: "fake", added_ms: 0 });
      for (const unit of PHONES) {
        tx.tables.devices.add({ unit, model: "iPhone 17 Pro", added_ms: NOW_MS });
        tx.tables.sources.add({ id: `location:local:${unit}`, vendor: vendorOf(declarations(), `location:local:${unit}`), connector: "fake", added_ms: 0 });
      }
      const delivery = (id: string, source: string, sealed_ms: number, from: string, seal: number) => {
        tx.tables.deliveries.add({ id, source, sealed_ms, stated_ms: NOW_MS, facts: {}, pass: from, seal });
        tx.tables.deliveries.move(id, source, { move: "pass" });
      };
      for (const [index, id] of SOURCES.entries()) {
        if (id !== SEALED) for (let seal = 1; seal <= SEALS; seal++) delivery(`${id}/${seal}`, id, NOW_MS - seal * 60_000 - index, pass, seal);
      }
      for (const unit of PHONES) for (let n = 1; n <= SEALS; n++) delivery(`phone:${unit}/${n}`, `location:local:${unit}`, NOW_MS - n * 600_000, "p-00000000", n);
    });
    const Database = (await import("better-sqlite3")).default;
    const raw = new Database(join(at.root, "home.db"));
    raw.transaction(() => {
      const enrichment = raw.prepare("INSERT INTO enrichments (family, item, prompt, input_hash, content, state) VALUES ('photos', ?, 'caption', 'sha256:00', '\"synthetic\"', ?)");
      for (let n = 0; n < ASKS; n++) enrichment.run(`item-${n}`, n === 0 ? "given-up" : "done");
    })();
    raw.close();

    const readerToken = "synthetic-token-the-reader-of-the-knock".padEnd(43, "x");
    mintPrincipal(openHomeFolder(at.root), { unit: "reader-of-the-knock", kind: null, scopes: ["read"], sources: [], token: readerToken, now_ms: NOW_MS });
    const stationToken = "synthetic-token-the-station-of-the-knock".padEnd(43, "x");
    mintPrincipal(openHomeFolder(at.root), { unit: "chrome-00000001", kind: "extension", scopes: ["station"], sources: [], token: stationToken, now_ms: NOW_MS });
    writePrepared(openHomeFolder(at.root), preparedFileOf(preparedDirOf(at.root, machine().dir, "people"), "people"), PEOPLE,
      { rows: new Map([["answer", new Map([["list", { people: [] }]])]]), position: "0:0" });
    const sock = testSocket(at.root);
    mkdirSync(dirname(sock.path), { recursive: true, mode: 0o700 });
    const fakeHome = createServer((socket) => socket.on("data", () => socket.end(`${JSON.stringify({ result: {} })}\n`)));
    await new Promise<void>((resolve) => fakeHome.listen(sock, resolve));

    const options = { log: () => undefined, floors: { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" }, statements: fromReaders };
    let door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, options);
    opened.length = 0;
    const doorOpens: string[] = [];
    try {
      for (let n = 0; n < SEALS; n++) {
        const bundle = acquisitionBundle({ source: SEALED, fetched_ms: NOW_MS - (SEALS - n) * 60_000, files: [[`${n}.jsonl`, Buffer.from(`{"n":${n}}\n`)]], custody: { [SEALED]: { seal: n + 1 } } });
        const sealed = await fetch(`http://127.0.0.1:${door.port}${bundle.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac }, body: bundle.bytes });
        expect(sealed.status).toBe(201);
        doorOpens.push(...opened.splice(0).filter((path) => READ_FILES.test(path)));
        home.commit((tx) => {
          tx.tables.deliveries.add({ id: bundle.id, source: SEALED, sealed_ms: NOW_MS - (SEALS - n) * 60_000, stated_ms: NOW_MS, facts: {}, pass, seal: n + 1 });
          tx.tables.deliveries.move(bundle.id, SEALED, { move: "pass" });
        });
      }
      home.close();
      report.seeded_ms = Math.round(performance.now() - seeded);

      const knock = async (offers: string[]) => {
        opened.length = 0;
        const started = performance.now();
        const { value: response, statements } = await recorded(async () => {
          const answer = await fetch(`http://127.0.0.1:${door.port}/v1/exchange?wait=0`, {
            method: "POST", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ offers }),
          });
          return { status: answer.status, body: await answer.json() as { sources: Record<string, { received: number; imported: number }>; needs: { id: string }[] } };
        });
        const opens = opened.splice(0).filter((path) => READ_FILES.test(path));
        doorOpens.push(...opens);
        return { ...response, ms: performance.now() - started, opens: opens.length, statements };
      };
      const knocks = [];
      for (let n = 0; n < 12; n++) knocks.push(await knock(ACCOUNTS));
      const after = knocks.slice(2).map((each) => each.ms).sort((a, b) => a - b);
      const first = knocks[0]!;
      expect(first.status).toBe(200);
      expect(Object.keys(first.body.sources).sort()).toEqual([...SOURCES].sort());
      const others = SOURCES.filter((source) => source !== SEALED);
      expect(first.body.sources[SEALED]).toMatchObject({ received: SEALS, imported: SEALS });
      expect(others.map((source) => first.body.sources[source])).toEqual(others.map(() => expect.objectContaining({ received: SEALS, imported: SEALS })));
      expect(first.body.needs.map((need) => need.id)).toEqual(["vault:none"]);
      expect(knocks.map((each) => each.opens)).toEqual(knocks.map(() => 0));
      expect(first.statements.some(({ file }) => file.endsWith("home.db"))).toBe(true);

      const phoneToken = "synthetic-token-the-phone-of-the-knock-xxxx".slice(0, 43);
      const phone = mintPrincipal(openHomeFolder(at.root), { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver"], sources: [PHONE_SOURCE, NOTES], token: phoneToken, now_ms: NOW_MS }).principal.id;
      const readPoint = (n: number) => new Date(NOW_MS - (SEALS - n) * 60_000).toISOString();
      const writer = openHome(openHomeFolder(at.root), "migrate");
      opened.length = 0;
      try {
        for (let n = 1; n <= SEALS; n++) {
          const bundle = phoneBundle({ domains: { "notes.jsonl": [n] }, second: n, custody: { [NOTES]: { seal: n, history_through: readPoint(n) } } });
          const sealed = await fetch(`http://127.0.0.1:${door.port}/v1/bundles/${bundle.id}`, { method: "PUT", headers: { authorization: `Bearer ${phoneToken}`, ...DEVICE.phone }, body: bundle.bytes });
          expect(sealed.status, await sealed.clone().text()).toBe(201);
          doorOpens.push(...opened.splice(0).filter((path) => READ_FILES.test(path)));
          writer.commit((tx) => {
            tx.tables.deliveries.add({ id: `${PHONE_SOURCE}/${bundle.id}`, source: NOTES, sealed_ms: NOW_MS + n, stated_ms: NOW_MS, facts: {}, pass: phone, seal: n });
            tx.tables.deliveries.move(`${PHONE_SOURCE}/${bundle.id}`, NOTES, { move: "pass" });
          });
        }
      } finally {
        writer.close();
      }
      opened.length = 0;
      const restore = await recorded(async () => {
        const answer = await fetch(`http://127.0.0.1:${door.port}/v1/restore`, { headers: { authorization: `Bearer ${phoneToken}`, ...DEVICE.phone } });
        return { status: answer.status, body: await answer.json() as { since?: Record<string, number | null> } };
      });
      expect([restore.value.status, restore.value.body.since?.[NOTES]]).toEqual([200, Date.parse(readPoint(SEALS))]);
      doorOpens.push(...opened.splice(0).filter((path) => READ_FILES.test(path)));

      const events = openHome(openHomeFolder(at.root), "migrate");
      opened.length = 0;
      let fed = "";
      const following = get(`http://127.0.0.1:${door.port}/v1/feed?from=0:0`, { headers: { authorization: `Bearer ${readerToken}` } }, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => { fed += chunk; });
      });
      try {
        await until("the feed reader's first answer", () => fed.includes("retry:"));
        events.commit((tx) => { tx.tables.events.append({ at_ms: NOW_MS, kind: "day", key: "2026-10-28" }); });
        await until("the event landed reaches the feed reader", () => fed.includes('"key":"2026-10-28"'));
      } finally {
        following.destroy();
        events.close();
      }
      const station = await fetch(`http://127.0.0.1:${door.port}/v1/stations/exchange`, {
        method: "POST", headers: { authorization: `Bearer ${stationToken}`, ...DEVICE.extension, "content-type": "application/json" },
        body: JSON.stringify({ results: [], station: { unit: "chrome-00000001", version: "1.0.0", slots: 2, errands: [], boot: "boot-a", running: [], pressed: { choose: [], stop: [] }, allowing: [], opened: [], acted: [] } }),
      });
      expect([station.status, Array.isArray(((await station.json()) as { needs?: unknown }).needs)]).toEqual([200, true]);
      const people = await fetch(`http://127.0.0.1:${door.port}/v1/people`, { headers: { authorization: `Bearer ${readerToken}`, "accept-encoding": "gzip" } });
      expect([people.status, await people.json()]).toEqual([200, expect.objectContaining({ people: [] })]);
      const blob = await fetch(`http://127.0.0.1:${door.port}/v1/blobs/sha256:${"0".repeat(64)}`, { headers: { authorization: `Bearer ${readerToken}` } });
      expect(blob.status).toBe(404);
      doorOpens.push(...opened.splice(0).filter((path) => READ_FILES.test(path)));

      await door.close();
      door = await serveDoor(at.root, { port: 0, max_bundle_bytes: 1 << 30 }, options);
      opened.length = 0;
      const next = acquisitionBundle({ source: SEALED, fetched_ms: NOW_MS, files: [["next.jsonl", Buffer.from('{"n":"next"}\n')]], custody: { [SEALED]: { seal: SEALS + 1 } } });
      const reopened = await recorded(async () => {
        const answer = await fetch(`http://127.0.0.1:${door.port}${next.path}`, { method: "PUT", headers: { authorization: `Bearer ${token}`, ...DEVICE.mac }, body: next.bytes });
        return { status: answer.status, body: await answer.json() as { sources: Record<string, { received: number; imported: number }> } };
      });
      expect([reopened.value.status, reopened.value.body.sources[SEALED]]).toEqual([201, expect.objectContaining({ received: SEALS + 1, imported: SEALS })]);
      doorOpens.push(...opened.splice(0).filter((path) => READ_FILES.test(path)));
      expect(doorOpens).toEqual([]);

      const plans = { knock: await planned(first.statements), restore: await planned(restore.statements), seal: await planned(reopened.statements) };
      report.plans = plans;
      for (const each of Object.values(plans)) expect(new Set(each.map((one) => one.file))).toEqual(new Set(["home.db", "door/custody.db"]));
      expect(Object.values(plans).flat().flatMap(({ sql, plan }) => growing(sql, plan)).filter(({ line }) => line.startsWith("SEARCH")).length).toBeGreaterThan(0);
      expect({ knock: walks(plans.knock), restore: walks(plans.restore), seal: walks(plans.seal) }).toEqual({ knock: [], restore: [], seal: [] });

      const reader = new Database(join(at.root, "home.db"), { readonly: true, fileMustExist: true, timeout: 0 });
      expect(custodyKept(reader)).toEqual(custodyRun(reader));
      const scans = performance.now();
      reader.prepare("SELECT family, item FROM enrichments NOT INDEXED WHERE state = 'given-up' ORDER BY family, item").all();
      for (const unit of PHONES) {
        reader.prepare(`SELECT max(sealed_ms) FROM deliveries NOT INDEXED WHERE source IN (SELECT id FROM sources WHERE copy = ?) OR id LIKE ?`).get(unit, `phone:${unit}/%`);
      }
      const scanned = performance.now() - scans;
      const needs = {
        given_up: (reader.prepare("EXPLAIN QUERY PLAN SELECT family, item FROM enrichments WHERE state = 'given-up' ORDER BY family, item").all() as { detail: string }[]).map((row) => row.detail),
        newest: (reader.prepare("EXPLAIN QUERY PLAN SELECT max(sealed_ms) FROM deliveries WHERE source = ?").all(SOURCES[0]) as { detail: string }[]).map((row) => row.detail),
      };
      reader.close();
      expect(needs.given_up.join(" ")).toContain("enrichments_given_up");
      expect(needs.newest.join(" ")).toContain("deliveries_sealed");
      report.knock = {
        door_thread_opens: { per_exchange: first.opens, journey: doorOpens.length },
        reader_statements: { knock: first.statements.length, restore: restore.statements.length, seal: reopened.statements.length },
        exchange_ms: { first: Math.round(first.ms), median: Math.round(after[Math.floor(after.length / 2)]!), max: Math.round(after.at(-1)!) },
        before_reads_ms: { needs_scans: Math.round(scanned) },
        needs,
      };
    } finally {
      await door.close();
      await new Promise<void>((resolve) => fakeHome.close(() => resolve()));
      rmSync(sock.path, { force: true });
    }
  });
});
