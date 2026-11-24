import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it, onTestFinished } from "vitest";
import { CHECKPOINT_PAGES, Keys, openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { openCopier, type CopierAnswer } from "./copiers.js";
import { ACTS } from "./door.js";
import { startHome, type Home } from "./home.js";
import { ask, askHome } from "./socket.js";
import { testSocket } from "./test/folder.js";
import { artifact, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { RESIDUE_PAGES } from "./write-log.js";

const UNIT = "macbook-pro-0001";
const PEOPLE = `people:local:${UNIT}`;
const REGISTRY = join(REPO, "packages", "home", "test", "people-registry.ts");
const MINUTE = 60_000;

type Line = Record<string, unknown>;
type Stands = { log: number; checkpointed: number };

const quiet = (root: string) => readHome(root, (db) => db.prepare("SELECT count(*) FROM jobs WHERE state IN ('queued', 'running')").pluck().get() === 0);

function fillLog(root: string): void {
  const db = new Database(join(root, "home.db"));
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO meta (key, value) VALUES ('test-filler', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run("a".repeat((CHECKPOINT_PAGES + 64) * 4096));
  db.close();
}

describe("a checkpoint beside a person", () => {
  it("a person's act is answered and lands while the copier's copy is out, the thread makes no checkpoint call until it answers, then one truncate of under RESIDUE_PAGES empties the log", async () => {
    const root = makeRoot("lifestream-copier-home-", { sources: { [PEOPLE]: "people-home" }, settings: { unit: UNIT }, clocks: true });
    const hold = join(root, "copier-hold");
    writeFileSync(hold, "");
    const kept = { failpoint: process.env.LIFESTREAM_FAILPOINT, hold: process.env.LIFESTREAM_HOLD };
    process.env.LIFESTREAM_FAILPOINT = "copier.copied";
    process.env.LIFESTREAM_HOLD = hold;
    const pragma = Database.prototype.pragma;
    const mine = new WeakSet<Database.Database>();
    const calls: { source: string; left: number }[] = [];
    Database.prototype.pragma = function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
      if (source.startsWith("wal_checkpoint(") && this.name.endsWith("home.db") && !mine.has(this)) {
        const [row] = pragma.call(this, "wal_checkpoint(NOOP)") as Stands[];
        calls.push({ source, left: row!.log - row!.checkpointed });
      }
      return pragma.call(this, source, options);
    } as typeof pragma;
    const logs: Line[] = [];
    let ahead = 0;
    let home: Home | undefined;
    onTestFinished(async () => {
      rmSync(hold, { force: true });
      await home?.stop();
      Database.prototype.pragma = pragma;
      for (const [name, value] of [["LIFESTREAM_FAILPOINT", kept.failpoint], ["LIFESTREAM_HOLD", kept.hold]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      removeRoot(root);
    });
    const frames = (): Stands => {
      const db = new Database(join(root, "home.db"));
      mine.add(db);
      try {
        return (db.pragma("wal_checkpoint(NOOP)") as Stands[])[0]!;
      } finally {
        db.close();
      }
    };
    home = await startHome(root, { stopGraceMs: 50, registry: REGISTRY, clock: () => Date.now() + ahead, log: (line) => logs.push(JSON.parse(line) as Line), tickMs: TICK_MS });
    const sock = testSocket(root);
    await until("the start's jobs ended", () => quiet(root));
    await askHome(sock, "pause", ["home", "--reason", "a test reads the checkpoint alone"]);

    fillLog(root);
    await until("the copier held after its copy", () => existsSync(`${hold}.hits`));
    const held = calls.length;
    const sent_ms = Date.now();
    const action = { of: "people", kind: "you", request: randomUUID(), name: "Sam" };
    const answer = await ask(sock, { verb: "owner-act", device: `dashboard-${UNIT}`, action, deadline_ms: sent_ms + ACTS["POST /v1/owner/act"].wait_ms }) as { act: string; id: string };
    expect(answer.id).toBe("person:sam");
    expect(readHome(root, (db) => db.prepare("SELECT state FROM deliveries WHERE id = ?").pluck().get(answer.act))).toBe("imported");
    const ticks = home.stats().ticks.count;
    await until("two ticks with the copy out", () => home!.stats().ticks.count > ticks + 1);
    expect(calls.slice(held)).toEqual([]);
    expect(readFileSync(`${hold}.hits`, "utf8").trim().split("\n")).toHaveLength(1);

    rmSync(hold);
    const truncates = () => calls.filter((call) => call.source === "wal_checkpoint(TRUNCATE)");
    await until("the thread's truncate after the copy", () => truncates().length > 0);
    expect(truncates()).toEqual([{ source: "wal_checkpoint(TRUNCATE)", left: expect.any(Number) }]);
    expect(truncates()[0]!.left).toBeLessThan(RESIDUE_PAGES);
    expect(frames().log).toBeLessThan(CHECKPOINT_PAGES);

    ahead += 5 * MINUTE;
    await until("the clock's layer line", () => logs.some((line) => line.layer !== undefined));
    const layer = logs.find((line) => line.layer !== undefined)!.layer as Line;
    expect(layer).toMatchObject({ copies: 1, copy_max_ms: expect.any(Number) });
    for (const call of calls) if (call.source === "wal_checkpoint(TRUNCATE)") expect(call.left).toBeLessThan(RESIDUE_PAGES);
    artifact(root, "copier-held", { calls, layer, answer, ms: Date.now() - sent_ms });
  });
});

describe("the copier", () => {
  it("one lost before its answer says why and copies nothing, the next copy opens another, and its close waits for a copy out and answers it closed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-copier-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const said: CopierAnswer[] = [];
    const copier = openCopier(openHomeFolder(dir).handOver(), (answer) => said.push(answer));

    copier.copy();
    expect(() => copier.copy()).toThrow("a copy is out already");
    await until("the lost copy answered", () => said.length === 1);
    expect(said).toEqual([{ lost: expect.objectContaining({ message: expect.stringMatching(/^the copier ended: /u) }) }]);

    openHome(openHomeFolder(dir), "migrate").close();
    copier.copy();
    await until("the copy answered", () => said.length === 2);
    expect(said[1]).toEqual({ checkpointed: expect.any(Number), ms: expect.any(Number) });

    copier.copy();
    await copier.close();
    expect(said.slice(2)).toEqual(["closed"]);
    expect(() => copier.copy()).toThrow("the copier is closed");
  });

  it("on an encrypted home it is handed the folder and its key, and checkpoints home.db, or dies opening a folder no one handed it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-copier-keyed-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const root = join(dir, "home");
    mkdirSync(join(root, "config"), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "config", "vault.json"), JSON.stringify({ version: 2, counter: 1, key_id: "0a0b0c0d", slots: [], keys: [{ kind: "data", id: 1, made_ms: 0, wrapped: "c3ludGhldGlj" }] }));
    const folder = openHomeFolder(root, { machine: join(dir, "machine"), program: "home", keys: Keys.derive(randomBytes(32)), vault: "0a0b0c0d" });
    const db = openHome(folder, "migrate", { ownCheckpoints: true });
    onTestFinished(() => db.close());
    db.commit((tx) => tx.tables.meta.set("test-filler", "a".repeat(64 * 4096)));
    const said: CopierAnswer[] = [];
    const copier = openCopier(folder.handOver(["store:home"]), (answer) => said.push(answer));
    onTestFinished(() => copier.close());
    copier.copy();
    await until("the keyed copy answered", () => said.length === 1);
    expect(said[0]).toEqual({ checkpointed: expect.any(Number), ms: expect.any(Number) });
    expect((said[0] as { checkpointed: number }).checkpointed).toBeGreaterThan(0);
  });
});
