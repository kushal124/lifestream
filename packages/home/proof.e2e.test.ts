import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DayDocument } from "@lifestreamprotocol/families";
import { dayPath } from "./derive.js";
import { askGeneration, serveDoor, type Door } from "./door.js";
import { admittedSet } from "./folders.js";
import { startHome, type Home } from "./home.js";
import { streamsAnswer } from "./page-streams.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { readRef } from "./refs.js";
import { askHome } from "./socket.js";
import { declaredStores } from "./stores.js";
import type { StreamsReport } from "./streams-report.js";
import { artifact, makeRoot, readHome, removeRoot, until, TICK_MS } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { editSettings, testSocket } from "./test/folder.js";
import { REPO } from "./test/support.js";
import { conformanceOf } from "./verbs/connectors-folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const PROOF = join(import.meta.dirname, "test", "proof");
const IDS = ["example-bank", "example-chat", "example-log", "example-oauth", "example-store"] as const;
const DAY = "2026-09-28";
const NOW = Date.UTC(2026, 9, 28, 9, 30);
const READER = randomBytes(32).toString("base64url");

type Fixtures = { fixtures: Record<string, (folder: string) => { source: string; facts: Record<string, unknown>; files: Record<string, unknown> }> };

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name)).map((path) => join(name, path)) : [name]));
}

describe("the five proof connectors, loaded by a home", () => {
  let root: string;
  let home: Home | undefined;
  let door: Door | undefined;
  let url: string;
  let shipped = 0;
  const sources: Record<string, string> = {};

  const get = async (path: string): Promise<Record<string, any>> => {
    const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${READER}` } });
    expect([path, response.status]).toEqual([path, 200]);
    return await response.json() as Record<string, any>;
  };
  const atoms = (): DayDocument["atoms"] => {
    try {
      return (JSON.parse(readFileSync(dayPath(root, DAY, "json"), "utf8")) as DayDocument).atoms;
    } catch {
      return [];
    }
  };
  const settled = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped
    && db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running') AND kind != 'label'").pluck().get() === 0 && db.prepare("SELECT count(*) FROM dirty_days").pluck().get() === 0);

  beforeAll(async () => {
    root = makeRoot("lifestream-proof-", { sources: {}, settings: { "connectors.example-log": { file: "/Users/person-a/Library/Logs/example-log.ndjson" }, "connectors.example-bank": { since: "2019-03-01" } } });
    for (const id of IDS) cpSync(join(PROOF, id), join(root, "connectors", id), { recursive: true });
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: READER, now_ms: 0 });
    const said: string[] = [];
    door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: (line) => said.push(line), registry: homeRegistryModule(), generation: askGeneration, clock: () => NOW });
    editSettings(root, { "door.port": door.port });
    home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: homeRegistryModule(), clock: () => NOW, log: () => undefined });
    await until("the door serves the home's connectors", () => said.some((line) => line.includes('"door":"serving"')));
    url = `http://127.0.0.1:${door.port}`;
    for (const id of IDS) {
      const { fixtures } = await import(pathToFileURL(join(PROOF, id, "test", "fixture.ts")).href) as Fixtures;
      for (const fixture of Object.values(fixtures)) {
        const folder = mkdtempSync(join(tmpdir(), `lifestream-proof-${id}-`));
        const made = fixture(folder);
        const files = Object.fromEntries(filesUnder(folder).map((path) => [relative(folder, join(folder, path)), readFileSync(join(folder, path))]));
        await shipFiles(root, made.source, Date.UTC(2026, 8, 28, 12) + shipped * 60_000, files, made.facts as never);
        sources[id] = made.source;
        shipped++;
      }
    }
    await until("every delivery imported and every day rendered", settled).catch((error: Error) => {
      const held = readHome(root, (db) => ({
        deliveries: db.prepare("SELECT id, source, state FROM deliveries").all(), jobs: db.prepare("SELECT kind, key, state FROM jobs WHERE state != 'done'").all(),
        dirty: db.prepare("SELECT count(*) FROM dirty_days").pluck().get(), failed: db.prepare("SELECT kind, subject, outcome, error FROM runs WHERE outcome != 'ok' ORDER BY id DESC LIMIT 10").all(),
      }));
      throw new Error(`${error.message}: ${JSON.stringify(held)}`);
    });
  });

  afterAll(async () => {
    await door?.close().catch(() => undefined);
    await home?.stop().catch(() => undefined);
    if (root !== undefined) removeRoot(root);
  });

  it("a folder does not load, or the report leaves a row out, draws a member with no control, a route without its id or client, or Refresh now where none stands", async () => {
    const report = await askHome(testSocket(root), "connectors") as StreamsReport;
    const rows = report.connectors.filter((row) => (IDS as readonly string[]).includes(row.id));
    artifact(root, "proof-report", rows);
    expect(report.needs.filter((need) => need.id.startsWith("folder:"))).toEqual([]);
    expect(rows.map((row) => row.id).sort()).toEqual([...IDS]);
    for (const row of rows) for (const member of row.members) expect([row.id, member.key, member.control]).toEqual([row.id, member.key, expect.any(String)]);
    const controls = new Set(rows.flatMap((row) => row.members.map((member) => member.control)));
    expect([...controls].sort()).toEqual(["date", "email", "list", "menu", "path", "secret", "stepper", "text", "toggle", "zone"]);
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(by["example-bank"]!.members.find((member) => member.key === "since")).toMatchObject({ kind: "date", control: "date", value: "2019-03-01" });
    expect(by["example-oauth"]!.routes).toEqual([expect.objectContaining({ id: "example-oauth", way: "client", client: expect.objectContaining({ id: "example", name: "Example", held: false }) })]);
    expect(Object.fromEntries(rows.map((row) => [row.id, row.refresh_now === null ? null : row.refresh_now.blocked?.reason ?? "act"]))).toEqual({
      "example-bank": null, "example-chat": null, "example-log": "act", "example-oauth": null, "example-store": null,
    });
  });

  it("a fixture delivered reaches no day file: the bank's lines under its name, the chat's messages, the log's plain line", async () => {
    const day = atoms().filter((atom) => atom.record !== undefined && Object.values(sources).includes(atom.record.source));
    artifact(root, "proof-day", day);
    const of = (id: string) => day.filter((atom) => atom.record!.source === sources[id]).map((atom) => [atom.family, atom.text]);
    expect(of("example-bank")).toEqual([["money", expect.stringContaining("Example Bank …1234")], ["money", expect.stringContaining("Example Bank …1234")]]);
    expect(of("example-chat")).toEqual([["messages", expect.stringContaining("Are we still on for lunch?")], ["messages", expect.stringContaining("Yes, at noon")]]);
    expect(of("example-log")).toEqual([["plain", "Synthetic entry one: the first line"], ["plain", "the second line"]]);
    const line = day.find((atom) => atom.family === "plain")!;
    expect([line.type, line.block]).toEqual(["notes", { key: sources["example-log"], title: "Example Log" }]);
  });

  it("a record is answered without its link, a product is missing, the index holds none of their words, or the chat's party is no network handle, found or named", async () => {
    const record = await get(`/v1/record?source=${encodeURIComponent(sources["example-log"]!)}&kind=entry&key=l-1`);
    expect(record.open).toEqual({ label: "Open in Example Log", href: "https://log.example.com/entries/l-1" });
    const products = (await get("/v1/products")).products as Record<string, { name: string; connector: string }>;
    expect(IDS.map((id) => [id, products[id]?.name, products[id]?.connector])).toEqual(IDS.map((id) => [id, expect.any(String), id]));
    const searched: Record<string, unknown> = {};
    const records = (answer: Record<string, any>) => (answer.record?.hits ?? []).flatMap((hit: { ref: string }) => {
      const ref = readRef(hit.ref, "ref", ["record", "line"]);
      return ref.kind === "record" ? [ref.parts] : [];
    }) as { source: string; key: string }[];
    for (const [query, id] of [["lunch", "example-chat"], ["first line", "example-log"], ["grocer", "example-bank"]] as const) {
      await until(`the index holds ${id}'s words`, async () => ((searched[query] = await get(`/v1/search?lists=record&query=${encodeURIComponent(query)}`)).record?.total ?? 0) > 0);
    }
    let people: Record<string, any> = {};
    await until("People holds the chat's partner", async () => (people = await get("/v1/people")).chats.length > 0);
    expect(people.chats).toEqual([expect.objectContaining({ key: "example-chat:12345", network: "example-chat", chat: "12345", group: false, total: 2, mine: 1 })]);
    const theirs = await get(`/v1/search?lists=record&person=${encodeURIComponent("example-chat:12345")}&order=oldest`);
    expect(records(theirs).map((ref) => ref.key)).toEqual(["12345:c-1", "12345:c-2"]);
    const [[, name]] = (await get(`/v1/labels?id=${encodeURIComponent("example-chat:12345")}`)).names;
    expect(atoms().find((atom) => atom.record?.source === sources["example-chat"])!.text).toContain(`${name}: Are we still on for lunch?`);
    expect(name).toBe("12345");
    artifact(root, "proof-reads", { record, products, searched, people, theirs });
  });

  it("the clients' proof fixtures hold rows the home does not draw", async () => {
    const report = await askHome(testSocket(root), "connectors") as StreamsReport;
    const rows = report.connectors.filter((row) => (IDS as readonly string[]).includes(row.id));
    const declared = (await admittedSet(root)).flatMap((each) => each.entry.connectors);
    clientRows(rows, declaredStores(declared).stores["example-store"]);
  });
});

describe("the proof connectors, run by `lifestream connectors test`", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made) removeRoot(dir);
  });

  it("a folder fails the run, or its lines, its records' words or its Open in links do not show; or one whose adapter lacks a required call passes", async () => {
    const ran = Object.fromEntries(await Promise.all(IDS.map((id) => [id, join(PROOF, id)] as const).map(async ([id, dir]) => [id, await conformanceOf(dir)] as const)));
    const work = mkdtempSync(join(tmpdir(), "lifestream-proof-run-"));
    made.push(work);
    artifact(work, "proof-run", ran);
    expect(Object.fromEntries(Object.entries(ran).map(([id, run]) => [id, run.faults]))).toEqual(Object.fromEntries(Object.keys(ran).map((id) => [id, []])));
    const day = (id: string) => ran[id]!.lines.filter((line) => /^\d{4}-\d\d-\d\d /u.test(line));
    expect(day("example-bank")).toEqual([expect.stringContaining("Example Bank …1234"), expect.stringContaining("Example Bank …1234")]);
    expect(day("example-chat").join("\n")).toContain("Are we still on for lunch?");
    expect(ran["example-chat"]!.lines).toContain("open chat 12345: Open in Example Chat https://chat.example.com/c/12345");
    expect(day("example-log")).toEqual(["2026-09-28 10:00–10:10 Example Log (2)", "2026-09-28   10:00 Synthetic entry one: the first line", "2026-09-28   10:10 the second line"]);
    expect(ran["example-log"]!.lines).toContain("open entry l-1: Open in Example Log https://log.example.com/entries/l-1");
    expect(ran["example-bank"]!.lines.filter((line) => line.startsWith("open "))).toEqual([
      "open txn: none: example-bank declares no open.record naming txn, so no record of it opens at Example Bank; its page from the record's key, account and content is connector.ts `open: { record: { kinds: [\"txn\"], url: \"https://…/{key}\" } }`, {content.<path>} a value its content states (alone, the whole address), a part cut by |before:<c>, |after:<c> or |hex",
    ]);
    expect(ran["example-chat"]!.lines.filter((line) => line.startsWith("open ") && line.includes(": none"))).toEqual([]);
    for (const id of ["example-oauth", "example-store"]) expect([id, day(id).length > 0]).toEqual([id, true]);
    for (const [id, run] of Object.entries(ran)) expect([id, run.lines.some((line) => /^search .*: (?!\(no words\))/u.test(line))]).toEqual([id, true]);

    const broken = join(work, "example-chat");
    cpSync(join(PROOF, "example-chat"), broken, { recursive: true });
    writeFileSync(join(broken, "adapter.ts"), readFileSync(join(broken, "adapter.ts"), "utf8").replace(/^ {2}message,\n/mu, ""));
    expect((await conformanceOf(broken)).faults).toEqual([
      expect.stringMatching(/^adapter\.ts:\d+:\d+ Property 'message' is missing in type .* but required in type 'MessagesAdapter'\.$/u),
      "adapters.example-chat.messages.message: is no call: the messages family calls it",
    ]);
  });
});

function clientRows(rows: readonly unknown[], store: unknown): void {
  const fixtures = join(REPO, "homelink", "Tests", "Fixtures");
  const pin = (value: unknown) => JSON.parse(JSON.stringify(value, (key, each: unknown) => (key.endsWith("_ms") && typeof each === "number" ? NOW : each))) as Record<string, unknown>;
  const report = JSON.parse(readFileSync(join(fixtures, "proof-report.json"), "utf8")) as { connectors: { id: string }[], devices: { streams?: unknown[] }[] };
  const canned = JSON.parse(readFileSync(join(fixtures, "report.json"), "utf8")) as { home: unknown };
  const drawn = new Map(rows.map((row) => [(row as { id: string }).id, pin(row)]));
  const nextReport = { ...report, home: canned.home, connectors: report.connectors.map((row) => drawn.get(row.id) ?? row),
    devices: report.devices.map((device) => ({ ...device, streams: device.streams ?? [] })) };
  const answer = JSON.parse(readFileSync(join(fixtures, "proof-answer.json"), "utf8")) as { stores: Record<string, unknown> };
  const nextAnswer = { ...answer, stores: { ...answer.stores, "example-store": store } };
  const write = (name: string, value: unknown) => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.LIFESTREAM_FIXTURES === "write") {
      mkdirSync(fixtures, { recursive: true });
      writeFileSync(join(fixtures, name), text);
    }
    expect(readFileSync(join(fixtures, name), "utf8"), `${name}: run with LIFESTREAM_FIXTURES=write`).toBe(text);
  };
  write("proof-report.json", streamsAnswer(nextReport as unknown as StreamsReport, 0, { device: "mac", unit: null }));
  write("proof-answer.json", nextAnswer);
}
