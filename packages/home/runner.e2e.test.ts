import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { startHome } from "./home.js";
import { passOf } from "./principals.js";
import { checkoutProgram } from "./programs.js";
import { askHome } from "./socket.js";
import { editSettings, testSocket } from "./test/folder.js";
import { artifact, FAKES, makeRoot, readHome, readLedger, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { doorHere } from "./test/harness-door.js";
import { cleanup, makeHome, REPO } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const RUNNER = "runner-macbook-pro-0001";
const MODEL = "qwen3.5-4b";
const JPEG = { media_type: "image/jpeg", base64: Buffer.from("synthetic jpeg").toString("base64") };
const roots: string[] = [];
const homes: string[] = [];
afterAll(() => {
  cleanup(roots);
  for (const root of homes) removeRoot(root);
});

describe("the runner journey", () => {
  it("answers a call placed on the door's drive half on a call's pass by the runner's program, and lets a runner's pass reach the runner half alone", async () => {
    const home = makeHome({
      runner: { scopes: ["run"], kind: "runner", unit: RUNNER },
      drive: { scopes: ["drive"], unit: "home" },
      call: { scopes: ["call"], unit: "home" },
      reader: { scopes: ["read"] },
    }, roots);
    editSettings(home.root, { [`model.runners.${RUNNER}.files`]: [MODEL] });
    const door = await doorHere(home.root);
    onTestFinished(async () => { await door.stop(); });
    const as = (pass: string, device?: string) => ({ authorization: `Bearer ${home.tokens[pass]}`, ...(device === undefined ? {} : { "lifestream-device": device }) });
    const listed = async () => ((await (await fetch(`${door.url}/v1/runners`, { headers: as("drive") })).json()) as { runners: { unit: string; present: boolean; running: string[]; files: { id: string; state: string }[] }[] }).runners;

    const dir = mkdtempSync(join(tmpdir(), "runner-journey-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "door-token"), `${home.tokens.runner}\n`, { mode: 0o600 });
    const said: string[] = [];
    const start = () => {
      const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", join(dir, "door-token")], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
      program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
      const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
      onTestFinished(async () => {
        program.kill("SIGTERM");
        await exited;
      });
      return { program, exited };
    };
    const first = start();

    await until("the runner is present with the file the home wants on it ready", async () => (await listed()).some((runner) => runner.unit === RUNNER && runner.present && runner.files.some((file) => file.id === MODEL && file.state === "ready")))
      .catch(async (error: Error) => { throw new Error(`${error.message}; the door lists ${JSON.stringify(await listed())}; the runner said ${said.join("")}`); });
    const place = (input: string, signal?: AbortSignal) => fetch(`${door.url}/v1/runners/calls`, {
      method: "POST", headers: as("call"), body: JSON.stringify({ runner: RUNNER, model: MODEL, input, attachments: [JPEG] }), ...(signal === undefined ? {} : { signal }),
    });
    const answered = JSON.parse(await (await place("Describe this photo.")).text()) as unknown;
    expect(answered).toEqual({ ok: { text: "seen: Describe this photo.", model: MODEL } });

    const gone = new AbortController();
    const holding = place("hold", gone.signal).then((response) => response.text()).catch(() => null);
    const running = async (): Promise<string[]> => (await listed()).find((runner) => runner.unit === RUNNER)?.running ?? [];
    await until("the runner says it runs the held call", async () => (await running()).length === 1);
    gone.abort();
    expect(await holding).toBe(null);
    await until("the runner says the call has ended", async () => (await running()).length === 0);

    const lost = place("hold").then(async (response) => JSON.parse(await response.text()) as unknown);
    await until("the runner says it runs the call", async () => (await running()).length === 1);
    first.program.kill("SIGKILL");
    await first.exited;
    start();
    const restarted = await lost;
    expect(restarted).toEqual({ error: { code: "INTERRUPTED", reason: "restarted", runner: RUNNER } });
    await until("the new start is present and runs nothing", async () => (await listed()).some((runner) => runner.unit === RUNNER && runner.present && runner.running.length === 0));

    const refusals: Record<string, { status: number; code: unknown }> = {};
    const tried = async (name: string, path: string, init: RequestInit) => {
      const response = await fetch(`${door.url}${path}`, init);
      refusals[name] = { status: response.status, code: ((await response.json().catch(() => ({}))) as { code?: unknown }).code };
    };
    const exchange = JSON.stringify({ runner: { name: "Synthetic Mac", version: "1", boot: "boot-z", slots: 1, power: null, idle_s: null, thermal: null, memory_gb: 16, running: [], files: [] }, results: [] });
    await tried("a runner's pass reads", "/v1/connectors", { headers: as("runner", "runner/1") });
    await tried("a runner's pass exchanges as a station", "/v1/stations/exchange", { method: "POST", headers: as("runner", "runner/1"), body: "{}" });
    await tried("a runner's pass places a call", "/v1/runners/calls", { method: "POST", headers: as("runner", "runner/1"), body: "{}" });
    await tried("a runner's pass lists the runners", "/v1/runners", { headers: as("runner", "runner/1") });
    await tried("a reader exchanges as a runner", "/v1/runners/exchange", { method: "POST", headers: as("reader"), body: exchange });
    await tried("a reader lists the runners", "/v1/runners", { headers: as("reader") });
    await tried("a call's pass lists the runners", "/v1/runners", { headers: as("call") });
    await tried("the drive pass places a call", "/v1/runners/calls", { method: "POST", headers: as("drive"), body: "{}" });
    await tried("a call's pass reads", "/v1/connectors", { headers: as("call") });
    await tried("a call's pass exchanges as a runner", "/v1/runners/exchange", { method: "POST", headers: as("call", "runner/1"), body: exchange });
    await tried("a runner that names no device", "/v1/runners/exchange", { method: "POST", headers: as("runner"), body: exchange });
    await tried("a runner below the floor", "/v1/runners/exchange", { method: "POST", headers: as("runner", "runner/0"), body: exchange });
    artifact(home.root, "runner", { answered, restarted, runners: await listed(), refusals, said: said.join("") });
    expect(refusals).toEqual({
      "a runner's pass reads": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a runner's pass exchanges as a station": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a runner's pass places a call": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a runner's pass lists the runners": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a reader exchanges as a runner": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a reader lists the runners": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a call's pass lists the runners": { status: 403, code: "PRINCIPAL_SCOPE" },
      "the drive pass places a call": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a call's pass reads": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a call's pass exchanges as a runner": { status: 403, code: "PRINCIPAL_SCOPE" },
      "a runner that names no device": { status: 426, code: "DEVICE_TOO_OLD" },
      "a runner below the floor": { status: 426, code: "DEVICE_TOO_OLD" },
    });
  });

  it("answers an item of a stream set to a runner's file, end to end: the home's pass for its runner, the file asked for, the call placed on the drive pass it is handed, the answer printed", async () => {
    const SOURCE = "apple-notes:local:device-a";
    const at = Date.UTC(2026, 5, 1, 12, 0);
    const root = makeRoot("lifestream-runner-item-", { sources: { [SOURCE]: "fake-rows" }, defaults: false });
    homes.push(root);
    const door = await doorHere(root);
    const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, log: () => undefined, tickMs: TICK_MS });
    const verb = (name: string, args: string[]) => askHome(testSocket(root), name, args);
    const route = `runner:${RUNNER}/${MODEL}`;
    const stored = () => (JSON.parse(readHome(root, (db) => db.prepare("SELECT value FROM meta WHERE key = 'llm:models'").pluck().get() as string)) as
      { routes: { id: string; state: string; model: string }[]; runners: { unit: string; present: boolean }[] });
    const events = () => readHome(root, (db) => db.prepare("SELECT count(*) FROM events WHERE kind = 'models'").pluck().get() as number);

    const passFile = join(process.env.LIFESTREAM_MACHINE_DIR!, "runner", "door-token");
    const pass = passOf(openHomeFolder(root), readFileSync(passFile, "utf8").trim())!;
    expect([pass.unit, pass.kind, pass.scopes, pass.revoked_at]).toEqual([RUNNER, "runner", ["run"], null]);
    const program = spawn(process.execPath, [...checkoutProgram(join(REPO, "packages", "runner", "test", "fake-runner.ts")), "--door", door.url, "--pass", passFile], { cwd: REPO, stdio: ["ignore", "ignore", "pipe"] });
    const said: string[] = [];
    program.stderr!.on("data", (chunk: Buffer) => said.push(chunk.toString("utf8")));
    const exited = new Promise<void>((resolve) => program.once("exit", () => resolve()));
    try {
      const before = events();
      await until("the door holds the runner: its file is asked for", () => verb("models", ["file", RUNNER, MODEL, "fetch"]).then(() => true, (error: Error) => {
        if (error.message.includes("That runner isn't connected.")) return false;
        throw error;
      }));
      await expect(verb("models", ["file", "runner-nobody-0000", MODEL, "fetch"])).rejects.toThrow("That runner isn't connected.");
      await expect(verb("models", ["file", RUNNER, "no-such-file", "fetch"])).rejects.toThrow(/'s runner doesn't have no-such-file\.$/u);
      await until("the runner's file a ready route of the home", () => stored().routes.some((each) => each.id === route && each.state === "ready"))
        .catch((error: Error) => { throw new Error(`${error.message}; the home stored ${JSON.stringify(stored())}; the runner said ${said.join("")}`); });
      expect(stored().runners.map((each) => [each.unit, each.present])).toEqual([[RUNNER, true]]);
      expect(stored().routes.find((each) => each.id === route)!.model).toBe(MODEL);
      expect(events()).toBeGreaterThan(before);

      await verb("connectors", ["set", "fake-poll", "llm.photos", route]);
      await ship(root, { source: SOURCE, fetched_ms: Date.now() - 60_000, rows: [{ kind: "note", key: "n1", content: { text: "synthetic note n1", at, photo: true }, at }] });
      await until("the caption answered", () => readHome(root, (db) => db.prepare("SELECT count(*) FROM enrichments WHERE state = 'done'").pluck().get() as number) === 1);
      const requests = readLedger(root, (db) => db.prepare(`SELECT r.model, a.transport, a.state FROM requests r JOIN attempts a ON a.key = r.key`).all()) as { model: string; transport: string; state: string }[];
      expect(requests).toEqual([{ model: MODEL, transport: "runner", state: "replied" }]);
      const [answer] = readHome(root, (db) => db.prepare("SELECT content FROM enrichments WHERE state = 'done'").pluck().all() as string[]);
      expect(JSON.parse(answer!) as string).toMatch(/^seen: /u);
      await until("the day prints the answer", () => readFileSync(join(root, "days", "2026-06-01.day.txt"), "utf8").includes(`[${JSON.parse(answer!) as string}`));
      artifact(root, "runner-item", { requests, day: readFileSync(join(root, "days", "2026-06-01.day.txt"), "utf8") });
    } finally {
      program.kill("SIGTERM");
      await exited;
      await home.stop();
      await door.stop();
    }
  });
});
