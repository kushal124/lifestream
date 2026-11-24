import { randomBytes } from "node:crypto";
import { cpSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { effective } from "./settings.js";
import type { Home } from "./home.js";
import { mintPrincipal } from "./principals.js";
import { homeRegistryModule } from "./programs.js";
import { askHome } from "./socket.js";
import type { StatusReport } from "./status.js";
import type { StreamsReport } from "./streams-report.js";
import { artifact, makeRoot, readHome, removeRoot, until } from "./test/harness-root.js";
import { shipFiles } from "./test/harness-deliveries.js";
import { homeWithDoor } from "./test/harness-home.js";
import { REPO } from "./test/support.js";
import { folderVerb } from "./verbs/connectors-folder.js";
import { testSocket } from "./test/folder.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const PROOF = "packages/home/test/proof/example-bank";
const FOLDER = join(REPO, PROOF);
const ID = "example-bank";
const READ = "example-bank";
const READER = randomBytes(32).toString("base64url");

type Statements = { SOURCE: string; STATEMENT: string };

async function statements(): Promise<{ SOURCE: string; AUGUST: string[]; statement(lines: readonly string[]): Buffer }> {
  const { SOURCE, STATEMENT } = await import(pathToFileURL(join(FOLDER, "test", "fixture.ts")).href) as Statements;
  const [account = "", header = "", ...AUGUST] = STATEMENT.split("\n");
  return { SOURCE, AUGUST, statement: (lines) => Buffer.from(`${[account, header, ...lines].join("\n")}\n`) };
}

const SEPTEMBER = ["2026-09-02,SYNTHETIC CAFE,2.50,,985.00,EUR"];

describe("a home whose source's connector leaves the release, until its folder is installed", () => {
  const roots: string[] = [];
  const homes: Home[] = [];
  afterAll(async () => {
    for (const home of homes) await home.stop().catch(() => undefined);
    for (const root of roots) removeRoot(root);
  });

  it("starts with nothing deleted and the source a product no connector declares; installed, the same source reads again", async () => {
    const { SOURCE, AUGUST, statement } = await statements();
    const root = makeRoot("lifestream-gap-", { sources: {}, settings: { [`connectors.${ID}`]: {} } });
    roots.push(root);
    mintPrincipal(openHomeFolder(root), { unit: "reader", scopes: ["read"], token: READER, now_ms: 0 });
    let shipped = 0;
    const ship = async (bytes: Buffer) => {
      await shipFiles(root, SOURCE, Date.UTC(2026, 8, 2, 12) + shipped * 60_000, { "statement.csv": bytes }, { sources: [{ id: SOURCE, connector: READ }] });
      shipped++;
      await until(`${shipped} statements imported`, () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get() === shipped));
    };
    const logs: string[] = [];
    const start = async () => {
      logs.length = 0;
      const home = await homeWithDoor(root, { registry: homeRegistryModule(), log: (line) => logs.push(line) });
      homes.push(home);
      return home;
    };
    const held = () => readHome(root, (db) => ({
      source: db.prepare("SELECT id, vendor, connector FROM sources WHERE id = ?").get(SOURCE),
      heads: db.prepare("SELECT kind, key, version FROM heads WHERE source = ? ORDER BY kind, key").all(SOURCE),
      deliveries: db.prepare("SELECT id, state FROM deliveries WHERE source = ? ORDER BY id").all(SOURCE),
    }));
    const settingsBlock = () => (JSON.parse(readFileSync(join(root, "config", "settings.json"), "utf8")) as Record<string, unknown>)[`connectors.${ID}`];
    const report = async () => await askHome(testSocket(root), "connectors") as StreamsReport;

    cpSync(FOLDER, join(root, "connectors", ID), { recursive: true });
    let home = await start();
    await ship(statement(AUGUST));
    const before = held();
    expect(before.source).toEqual({ id: SOURCE, vendor: "example", connector: READ });
    expect(before.heads).toHaveLength(AUGUST.length);
    await home.stop();

    rmSync(join(root, "connectors", ID), { recursive: true });
    home = await start();
    const gap = await report();
    const port = effective(root).settings.door.port;
    const get = async (path: string) => await (await fetch(`http://127.0.0.1:${port}${path}`, { headers: { authorization: `Bearer ${READER}` } })).json() as Record<string, any>;
    const products = await get("/v1/products") as { products: Record<string, unknown> };
    const first = before.heads[0] as { kind: string; key: string };
    const record = await get(`/v1/record?source=${encodeURIComponent(SOURCE)}&kind=${first.kind}&key=${encodeURIComponent(first.key)}`);
    artifact(root, "gap-report", { rows: gap.connectors.map((row) => row.id), needs: gap.needs, products: Object.keys(products.products), record, logs: logs.filter((line) => line.includes(ID)) });
    expect(held()).toEqual(before);
    expect(settingsBlock()).toEqual({});
    expect(record).toMatchObject({ source: SOURCE, kind: first.kind, key: first.key, version: { id: (before.heads[0] as { version: string }).version }, open: null });
    expect(gap.connectors.map((row) => row.id)).not.toContain(ID);
    expect(Object.keys(products.products)).not.toContain(ID);
    expect(JSON.stringify(gap.needs)).not.toContain(SOURCE);
    expect(logs.filter((line) => line.includes(`connectors.${ID}`)).join("\n")).toContain(`this release declares no connector ${ID}: it is kept and ignored`);

    const out: string[] = [];
    const installed = await folderVerb({ root, cwd: REPO, out: (line) => out.push(line) }, ["install", PROOF]) as { installed: string };
    expect(installed.installed).toBe(join(root, "connectors", ID));
    await home.stop();
    home = await start();
    const back = await report();
    const row = back.connectors.find((each) => each.id === ID);
    artifact(root, "gap-installed", { out, row });
    expect(held()).toEqual(before);
    expect([row?.id, settingsBlock()]).toEqual([ID, {}]);
    await ship(statement(SEPTEMBER));
    const after = held();
    expect(after.source).toEqual(before.source);
    expect(after.heads).toEqual(expect.arrayContaining(before.heads));
    expect(after.heads).toHaveLength(AUGUST.length + 1);
  });

  it("waits on a folder this release refuses: a need on its connector with the install command, its delivery unread through a restart, read once the fixed folder is installed", async () => {
    const { SOURCE, AUGUST, statement } = await statements();
    const root = makeRoot("lifestream-refused-", { sources: {} });
    roots.push(root);
    const installedAt = join(root, "connectors", ID);
    const index = join(installedAt, "index.ts");
    const from = realpathSync(FOLDER);
    const install = async () => await folderVerb({ root, cwd: REPO, out: () => undefined }, ["install", PROOF]);
    const start = async () => {
      const home = await homeWithDoor(root, { registry: homeRegistryModule(), log: () => undefined });
      homes.push(home);
      return home;
    };
    const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(SOURCE) as number);
    const heads = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ?").pluck().get(SOURCE) as number);
    const importRuns = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM runs WHERE kind = 'import'").pluck().get() as number);
    const waiting = () => readHome(root, (db) => db.prepare("SELECT id, state, run, failures, error, refused FROM deliveries WHERE source = ? AND state <> 'imported'").all(SOURCE));
    const passedSince = (event: string, key: string) => readHome(root, (db) => {
      const at = db.prepare("SELECT max(at_ms) FROM events WHERE kind = ? AND key = ?").pluck().get(event, key) as number | null;
      const job = db.prepare("SELECT state, started_ms, attempts, error FROM jobs WHERE kind = 'import' AND key = ?").get(SOURCE) as { state: string; started_ms: number | null; attempts: number; error: string | null } | undefined;
      return at !== null && job !== undefined && job.state === "done" && (job.started_ms ?? 0) >= at;
    });

    await install();
    let home = await start();
    await shipFiles(root, SOURCE, Date.UTC(2026, 8, 2, 12), { "statement.csv": statement(AUGUST) }, { sources: [{ id: SOURCE, connector: READ }] });
    await until("August's statement imported", () => imported() === 1);
    const landed = heads();
    expect(landed).toBe(AUGUST.length);
    await home.stop();

    writeFileSync(index, readFileSync(index, "utf8").replace("export const contract = 3;", "export const contract = 1;"));
    home = await start();
    const runs = importRuns();
    const september = statement(SEPTEMBER);
    const shipped = await shipFiles(root, SOURCE, Date.UTC(2026, 8, 2, 13), { "statement.csv": september }, { sources: [{ id: SOURCE, connector: READ }] });
    await until("September's statement indexed and its import passed it by", () => passedSince("delivery", shipped));
    const report = await askHome(testSocket(root), "connectors") as StreamsReport;
    const status = await askHome(testSocket(root), "status", ["--json"]) as StatusReport;
    const need = report.needs.find((each) => each.id === `folder:${ID}`);
    artifact(root, "refused", { need, waiting: waiting(), notices: status.notices });
    expect(need).toMatchObject({ connector: ID, state: "needs-you", words: `${ID} didn't load`, line: "Its code has an error" });
    expect(need?.detail?.startsWith(`1 is no longer served: declare \`export const contract = 3;\`. Contract 2 narrowed the SDK`)).toBe(true);
    expect(need?.detail?.endsWith(`once the folder declares 3, the typecheck names the rest. Fix it, then run lifestream connectors install ${from}`)).toBe(true);
    expect(status.needs.find((each) => each.id === `folder:${ID}`)?.connector).toBe(ID);
    expect(waiting()).toEqual([{ id: shipped, state: "sealed", run: null, failures: 0, error: null, refused: 0 }]);
    expect(importRuns()).toBe(runs);
    expect(status.notices.filter((notice) => notice.id.startsWith("job:import:") || notice.id.startsWith("unread:"))).toEqual([]);
    await home.stop();

    home = await start();
    await until("the restarted home's import passed the waiting statement by", () => passedSince("home", "start"));
    expect(waiting()).toEqual([{ id: shipped, state: "sealed", run: null, failures: 0, error: null, refused: 0 }]);
    expect(readFileSync(join(root, "inbox", ...shipped.split("/"), "statement.csv")).equals(september)).toBe(true);
    expect([heads(), importRuns()]).toEqual([landed, runs]);
    await install();
    await home.stop();

    home = await start();
    await until("the waiting statement imported", () => imported() === 2);
    expect([waiting(), heads()]).toEqual([[], AUGUST.length + 1]);
  });

  it("fails the import of a source whose folder was deleted by hand, as one this release lacks, its folder's record gone at the next start", async () => {
    const { SOURCE, AUGUST, statement } = await statements();
    const root = makeRoot("lifestream-gone-", { sources: {} });
    roots.push(root);
    const start = async () => {
      const home = await homeWithDoor(root, { registry: homeRegistryModule(), log: () => undefined });
      homes.push(home);
      return home;
    };
    const imported = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(SOURCE) as number);
    const job = () => readHome(root, (db) => db.prepare("SELECT state, error FROM jobs WHERE kind = 'import' AND key = ?").get(SOURCE) as { state: string; error: string | null } | undefined);
    const recorded = () => readHome(root, (db) => db.prepare("SELECT key, value FROM meta WHERE substr(key, 1, 12) = 'read-folder:' ORDER BY key").all());

    cpSync(FOLDER, join(root, "connectors", ID), { recursive: true });
    let home = await start();
    await shipFiles(root, SOURCE, Date.UTC(2026, 8, 2, 12), { "statement.csv": statement(AUGUST) }, { sources: [{ id: SOURCE, connector: READ }] });
    await until("August's statement imported", () => imported() === 1);
    expect(recorded()).toEqual([{ key: `read-folder:${READ}`, value: ID }]);
    await home.stop();

    rmSync(join(root, "connectors", ID), { recursive: true });
    home = await start();
    expect(recorded()).toEqual([]);
    const september = statement(SEPTEMBER);
    const shipped = await shipFiles(root, SOURCE, Date.UTC(2026, 8, 2, 13), { "statement.csv": september }, { sources: [{ id: SOURCE, connector: READ }] });
    await until("September's import failed", () => job()?.error != null);
    artifact(root, "gone", { job: job() });
    expect(job()?.error).toContain(`${shipped}: source ${SOURCE} names connector ${READ}, which this release lacks`);
    expect(imported()).toBe(1);
  });
});
