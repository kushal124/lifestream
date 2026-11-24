import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { DAYS_MARK, homeSchema, type JsonObject, openHomeFolder } from "@lifestreamprotocol/core";
import { readDayHead } from "./derive.js";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home } from "./home.js";
import { basicInstant, MANIFEST_FILE, MANIFEST_FORMAT } from "./inbox.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { askHome } from "./socket.js";
import { artifact, FAKES, hex, makeRoot, readHome, readLedger, removeRoot, settled, until, TICK_MS } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { statusOf } from "./test/harness-status.js";
import { acquisitionBundle, DEVICE, REPO } from "./test/support.js";
import { testSocket } from "./test/folder.js";

const A = "apple-notes:local:device-a";
const DAYS = ["2026-09-20", "2026-09-21", "2026-09-22"];
const at = (day: number) => Date.parse(`${DAYS[day]}T06:00:00Z`);
const note = (key: string, day: number) => ({ kind: "note", key, content: { text: `synthetic note ${key}`, at: at(day), photo: true }, at: at(day) });
const TOKENS = { device: "synthetic-token-device".padEnd(43, "d"), spare: "synthetic-token-spare".padEnd(43, "s"), reader: "synthetic-token-reader".padEnd(43, "r") };
const KEPT = { kept: true, by: "release N+1" };

function write(path: string, sql: string, ...params: unknown[]): void {
  const db = new Database(path);
  try {
    db.prepare(sql).run(...params);
  } finally {
    db.close();
  }
}

function later(root: string) {
  const inbox = join(root, "inbox", A);
  return {
    home: readHome(root, (db) => ({
      deliveries: db.prepare("SELECT id, state FROM deliveries ORDER BY sealed_ms").all(),
    })),
    ledger: readLedger(root, (db) => ({
      requests: db.prepare("SELECT unit, sampling FROM requests ORDER BY rowid").all(),
    })),
    principals: JSON.parse(readFileSync(join(root, "config", "principals.json"), "utf8")) as JsonObject,
    manifests: Object.fromEntries(readHome(root, (db) => db.prepare("SELECT id FROM deliveries ORDER BY sealed_ms").pluck().all() as string[])
      .map((id) => [id, JSON.parse(readFileSync(join(inbox, id.slice(A.length + 1), MANIFEST_FILE), "utf8")) as JsonObject])),
  };
}

const summary: Record<string, unknown> = {};
let root: string | undefined;
let home: Home | undefined;
let door: Door | undefined;
afterAll(() => {
  mkdirSync(join(REPO, "packages", "home", ".build", "e2e"), { recursive: true });
  writeFileSync(join(REPO, "packages", "home", ".build", "e2e", "formats.json"), `${JSON.stringify(summary, null, 2)}\n`);
  if (root !== undefined) {
    artifact(root, "formats", summary);
    removeRoot(root);
  }
});

describe("release N on a home release N+1 of the same versions wrote", () => {
  it("N refuses N+1's home, or drops what N+1 wrote", async () => {
    try {
      root = makeRoot("lifestream-formats-", { sources: { [A]: "fake-rows" } });
      const principals = openHomeFolder(root);
      const ids: Record<string, string> = {};
      for (const [name, scopes, sources] of [["device", ["deliver"], [A]], ["spare", ["deliver"], [A]], ["reader", ["read"], []]] as const) {
        ids[name] = mintPrincipal(principals, { unit: name, kind: name === "reader" ? null : "mac", scopes: [...scopes], sources: [...sources], token: TOKENS[name], now_ms: 0 }).principal.id;
      }

      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
      await ship(root, { source: A, fetched_ms: at(0), rows: [note("n1", 0)] });
      await until("the first note settled", () => settled(root!, 1));
      await until("its day rendered and captioned", () => readFileSync(join(root!, "days", `${DAYS[0]}.day.txt`), "utf8").includes("[fake reply "));
      await home.stop();
      home = undefined;

      const ledger = join(root, "replies", "replies.db");
      write(ledger, "UPDATE requests SET sampling = ?", JSON.stringify({ synthetic_later: KEPT }));
      const file = readPrincipals(principals);
      writeFileSync(join(root, "config", "principals.json"), `${JSON.stringify({ ...file, synthetic_later: KEPT, principals: file.principals.map((row) => ({ ...row, synthetic_label: `${row.unit} label` })) })}\n`);
      const rows = Buffer.from(`${JSON.stringify(note("n2", 1))}\n`);
      const name = basicInstant(new Date(at(1)).toISOString());
      mkdirSync(join(root, "inbox", A, name), { recursive: true });
      writeFileSync(join(root, "inbox", A, name, "rows.ndjson"), rows);
      writeFileSync(join(root, "inbox", A, name, MANIFEST_FILE), `${JSON.stringify({
        format: MANIFEST_FORMAT, source_id: A, feeder: "fake-rows", fetched_at: new Date(at(1)).toISOString(), complete: true,
        files: [{ file: "rows.ndjson", sha256: hex(rows), bytes: rows.length, synthetic_role: "rows" }], facts: {}, synthetic_later: KEPT,
      })}\n`);
      const dayJson = join(root, "days", `${DAYS[0]}.day.json`);
      writeFileSync(dayJson, readFileSync(dayJson, "utf8").replace(/^\{\n/u, `{\n  "synthetic_later": ${JSON.stringify(KEPT)},\n`));
      const left = later(root);
      summary.n1_left = left;

      door = await serveDoor(root, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined });
      const url = `http://127.0.0.1:${door.port}`;
      const get = async (path: string, who: keyof typeof TOKENS = "reader") => {
        const response = await fetch(`${url}${path}`, { headers: { authorization: `Bearer ${TOKENS[who]}` } });
        return { status: response.status, body: await response.text() };
      };
      expect(readDayHead(openHomeFolder(root), DAYS[0]!)).toMatchObject({ synthetic_later: KEPT });
      const answers: Record<string, number> = {};
      for (const path of ["/v1/days", `/v1/days/${DAYS[0]}`, `/v1/records?source=${A}&kind=note`, "/v1/status"]) {
        const answer = await get(path);
        answers[path] = answer.status;
        expect(answer.status, `${path}: ${answer.body}`).toBe(200);
      }
      const held = readdirSync(join(root, "days")).filter((name) => name.endsWith(".day.json")).map((name) => name.slice(0, -".day.json".length)).sort();
      expect(held).toContain(DAYS[0]);
      expect((JSON.parse((await get("/v1/days")).body) as { days: { day: string }[] }).days.map((day) => day.day)).toEqual(held);

      home = await startHome(root, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: () => undefined });
      await until("N+1's delivery imported", () => settled(root!, 2));
      const bundled = Buffer.from(`${JSON.stringify(note("n3", 2))}\n`);
      const bundle = acquisitionBundle({
        source: A, feeder: "fake-rows", fetched_ms: at(2), files: [["rows.ndjson", bundled]], custody: { [A]: { seal: 1 } },
        manifest: (manifest) => ({ ...manifest, synthetic_later: KEPT, files: (manifest.files as JsonObject[]).map((entry) => ({ ...entry, synthetic_role: "rows" })) }),
      });
      const put = await fetch(`${url}${bundle.path}`, { method: "PUT", body: bundle.bytes, headers: { authorization: `Bearer ${TOKENS.device}`, ...DEVICE.mac } });
      answers[`PUT ${bundle.path}`] = put.status;
      expect(put.status, await put.clone().text()).toBe(201);
      await until("the bundle imported", () => settled(root!, 3));

      const revoked = await askHome(testSocket(root), "principals", ["revoke", ids.spare!]) as { principal: JsonObject };
      expect(revoked.principal).toMatchObject({ id: ids.spare, synthetic_label: "spare label" });
      expect((await get(`/v1/records?source=${A}&kind=note`, "spare")).status).toBe(401);
      const status = statusOf(root) as unknown as JsonObject;
      expect(status.needs).toBeDefined();
      answers["/v1/status after"] = (await get("/v1/status")).status;
      expect(answers["/v1/status after"]).toBe(200);
      summary.n_answered = answers;
      await door.close();
      door = undefined;
      await home.stop();
      home = undefined;

      const after = later(root);
      summary.n_left = after;
      expect(after.home.deliveries.slice(0, 1)).toEqual(left.home.deliveries);
      expect(after.home.deliveries.slice(1)).toMatchObject([{ state: "imported" }, { state: "imported" }]);
      expect(after.ledger!.requests.slice(0, 1)).toEqual(left.ledger!.requests);
      expect(after.ledger!.requests.slice(1)).toMatchObject([{ sampling: null }, { sampling: null }]);
      expect(after.principals.synthetic_later).toEqual(KEPT);
      const passes = after.principals.principals as JsonObject[];
      expect(passes.filter((row) => row.unit === "home").map((row) => (row.scopes as string[]).join()).sort()).toEqual(["call", "drive"]);
      const runner = String(passes.find((row) => row.kind === "runner")?.unit);
      expect(runner).toMatch(/^runner-/u);
      expect(passes.filter((row) => row.unit !== "home").map((row) => [row.unit, row.synthetic_label, row.revoked_at !== null])).toEqual([
        ["device", "device label", false], ["spare", "spare label", true], ["reader", "reader label", false],
        ["dashboard", "dashboard label", false], ["ask", "ask label", false], ["mcp", "mcp label", false], ["stations", "stations label", false],
        [runner, `${runner} label`, false],
      ]);
      const manifests = Object.values(after.manifests);
      expect(manifests.slice(1).map((manifest) => [manifest.synthetic_later, (manifest.files as JsonObject[]).map((entry) => entry.synthetic_role)]))
        .toEqual([[KEPT, ["rows"]], [KEPT, ["rows"]]]);

      const again = later(root);
      summary.n1_found = again;
      expect((again.ledger!.requests[0] as { sampling: string }).sampling).toBe(JSON.stringify({ synthetic_later: KEPT }));
      expect(again.principals).toEqual(after.principals);
      expect(again.manifests).toEqual(after.manifests);
    } finally {
      await door?.close();
      await home?.stop();
    }
  });
});

describe("this release on a home whose day files and day list parted", () => {
  it("lists the days of a file the home has not migrated yet, lists stale days after a restore, or publishes an unreadable folder as no days", async () => {
    const dir = makeRoot("lifestream-formats-days-", { sources: { [A]: "fake-rows" } });
    const path = join(dir, "home.db");
    const sock = testSocket(dir);
    const days = ["2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"];
    const row = (key: string, day: number, text = `synthetic note ${key}`) => ({ kind: "note", key, content: { text, at: Date.parse(`${days[day]}T06:00:00Z`) }, at: Date.parse(`${days[day]}T06:00:00Z`) });
    const logs: Record<string, unknown>[] = [];
    const start = () => startHome(dir, { stopGraceMs: 50, tickMs: TICK_MS, registry: FAKES, log: (line) => logs.push(JSON.parse(line) as Record<string, unknown>) });
    let started: Home | undefined;
    let behind: Door | undefined;
    let shipped = 0;
    const send = async (rows: ReturnType<typeof row>[]) => {
      await ship(dir, { source: A, fetched_ms: Date.now() + shipped, rows });
      shipped++;
      await until("the home settled", () => settled(dir, shipped));
    };
    const stated = () => readdirSync(join(dir, "days")).filter((name) => name.endsWith(".day.json")).map((name) => name.slice(0, -".day.json".length)).sort()
      .map((day) => ({ day, inputs: readDayHead(openHomeFolder(dir), day)!.inputs, counts: readDayHead(openHomeFolder(dir), day)!.counts }));
    const kept = (file = path) => {
      const db = new Database(file, { readonly: true });
      try {
        return (db.prepare("SELECT day, inputs, counts FROM days ORDER BY day").all() as { day: string; inputs: string; counts: string }[])
          .map((each) => ({ ...each, counts: JSON.parse(each.counts) as unknown }));
      } finally {
        db.close();
      }
    };
    const files = (base: string) => ["", "-wal", "-shm"].map((suffix) => `${base}${suffix}`);
    try {
      mintPrincipal(openHomeFolder(dir), { unit: "reader", kind: null, scopes: ["read"], sources: [], token: TOKENS.reader, now_ms: 0 });
      behind = await serveDoor(dir, { port: 0, max_bundle_bytes: 1 << 30 }, { log: () => undefined });
      const url = `http://127.0.0.1:${behind.port}`;
      const list = async () => {
        const response = await fetch(`${url}/v1/days`, { headers: { authorization: `Bearer ${TOKENS.reader}` } });
        const body = await response.json() as { days?: unknown[]; code?: string; message?: string };
        return { status: response.status, days: body.days, code: body.code, message: body.message };
      };

      started = await start();
      await send([row("n0", 0), row("n1", 1), row("n2", 2), row("n3", 3)]);
      await askHome(sock, "pause", ["home", "--reason", "the test reads what the start alone does"]);
      await started.stop();
      started = undefined;
      const lived = stated();
      expect(lived.map((each) => each.day)).toEqual(expect.arrayContaining(days.slice(0, 4)));

      const older = new Database(path);
      try {
        older.exec("DELETE FROM days");
        older.pragma(`user_version = ${homeSchema.latest - 1}`);
      } finally {
        older.close();
      }
      const before = await list();
      expect([before.status, before.code, before.message]).toEqual([503, "NOT_NOW", expect.stringContaining(`home.db is at version ${homeSchema.latest - 1}; this release reads ${homeSchema.latest}: the home has not started this release yet`)]);
      const migrated = new Database(path);
      try {
        migrated.pragma(`user_version = ${homeSchema.latest}`);
      } finally {
        migrated.close();
      }
      started = await start();
      const listed = await list();
      expect(listed).toMatchObject({ status: 200, days: lived });
      expect(kept()).toEqual(lived);

      await started.stop();
      started = undefined;
      const copy = join(dir, "copy");
      mkdirSync(copy);
      for (const [from, to] of files(path).map((file, index) => [file, files(join(copy, "home.db"))[index]!] as const)) if (existsSync(from)) copyFileSync(from, to);
      started = await start();
      await askHome(sock, "resume", ["home"]);
      await send([row("n0", 0, "synthetic note n0, edited"), row("n4", 4)]);
      await askHome(sock, "pause", ["home", "--reason", "the test reads what the start alone does"]);
      await started.stop();
      started = undefined;
      for (const suffix of [".day.json", ".day.txt", ".day.lines.json"]) rmSync(join(dir, "days", `${days[1]}${suffix}`));
      for (const [from, to] of files(join(copy, "home.db")).map((file, index) => [file, files(path)[index]!] as const)) {
        rmSync(to, { force: true });
        if (existsSync(from)) copyFileSync(from, to);
      }
      const restored = kept();
      const now = stated();
      const inputsOf = (rows: { day: string; inputs: string }[], day: string) => rows.find((each) => each.day === day)?.inputs;
      const parted = [...new Set([...restored, ...now].map((each) => each.day))].filter((day) => inputsOf(restored, day) !== inputsOf(now, day)).sort();
      expect(parted).toEqual(expect.arrayContaining([days[0], days[1], days[4]]));
      expect(parted).not.toContain(days[2]);
      expect(parted).not.toContain(days[3]);
      const startedAt = () => readHome(dir, (db) => db.prepare("SELECT max(seq) FROM events WHERE kind = 'home' AND key = 'start'").pluck().get() as number);
      started = await start();
      const exact = await list();
      const told = readHome(dir, (db) => db.prepare("SELECT key FROM events WHERE kind = 'day' AND seq > ? ORDER BY key").pluck().all(startedAt()) as string[]);
      expect(exact).toMatchObject({ status: 200, days: now });
      expect(told).toEqual(parted);
      expect(logs.filter((line) => line.start !== undefined).at(-1)?.days).toEqual({ listed: now.length, changed: parted.length, unread: 0 });

      await started.stop();
      started = undefined;
      const blocked = join(dir, "days", `${days[2]}.day.json`);
      chmodSync(blocked, 0o000);
      try {
        started = await start();
        const partly = await list();
        const queued = readHome(dir, (db) => db.prepare("SELECT day FROM dirty_days WHERE day = ?").pluck().all(days[2]));
        expect(partly).toMatchObject({ status: 200, days: now });
        expect(kept()).toEqual(exact.days);
        expect(logs.filter((line) => line.start !== undefined).at(-1)?.days).toEqual({ listed: now.length, changed: 0, unread: 1 });
        expect(queued).toEqual([days[2]]);
        await started.stop();
        started = undefined;
      } finally {
        chmodSync(blocked, 0o644);
      }

      chmodSync(join(dir, "days"), 0o000);
      try {
        started = await start();
        const unread = await list();
        const mark = readHome(dir, (db) => db.prepare("SELECT value FROM meta WHERE key = ?").pluck().get(DAYS_MARK) ?? null);
        expect({ status: unread.status, code: unread.code, mark }).toEqual({ status: 503, code: "NOT_NOW", mark: null });
        expect(logs.filter((line) => line.start !== undefined).at(-1)?.days).toEqual({ error: expect.any(String) });
        summary.day_list = { before: before.status, listed: lived.length, parted, told, unread: unread.status };
        await started.stop();
        started = undefined;
      } finally {
        chmodSync(join(dir, "days"), 0o755);
      }
    } finally {
      await started?.stop();
      await behind?.close();
      removeRoot(dir);
    }
  });
});
