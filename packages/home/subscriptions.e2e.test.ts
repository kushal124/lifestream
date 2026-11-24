import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEVICE } from "./test/support.js";
import { makeRoot, readHome, removeRoot, TICK_MS, until } from "./test/harness-root.js";
import { ship } from "./test/harness-deliveries.js";
import { openDoor } from "./test/harness-door.js";
import { startHere } from "./test/harness-home.js";
import { note, SOURCE } from "./test/derived.js";
import { writeArtifact } from "./test/ops-support.js";
import { machine } from "./machine.js";
import { mintPrincipal } from "./principals.js";
import { codesigned, makeReady, Refused, type SignatureCheck } from "@lifestreamprotocol/model";
import { checkoutProgram } from "./programs.js";
import { programFolder, Programs, readyBinary, type ProgramName, type ProgramRow } from "./subscriptions.js";
import { openHomeFolder } from "@lifestreamprotocol/core";

const PIN = "0.166.0";
const CHILD = fileURLToPath(new URL("./test/programs-child.ts", import.meta.url));
const report: Record<string, unknown> = {};
const ends: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const end of ends.splice(0).reverse()) await end();
});
afterAll(() => writeArtifact("subscriptions", report));

function temp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ls-sub-${name}-`));
  ends.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function codexScript(version: string): string {
  return [
    "#!/bin/sh",
    `case "$1" in --version) echo "codex-cli ${version}"; exit 0;; login) [ -f "$CODEX_HOME/auth.json" ] && exit 0; echo "Not logged in" >&2; exit 1;; esac`,
    "cat > /dev/null; echo a synthetic caption from codex",
    "",
  ].join("\n");
}

function tarball(version: string, script = codexScript(version)): { bytes: Buffer; row: (url: string) => ProgramRow } {
  return packed(version, (bin) => writeFileSync(join(bin, "codex"), script, { mode: 0o755 }));
}

function packed(version: string, lay: (bin: string) => void): { bytes: Buffer; row: (url: string) => ProgramRow } {
  const staging = temp("staging");
  mkdirSync(join(staging, "package", "bin"), { recursive: true });
  lay(join(staging, "package", "bin"));
  writeFileSync(join(staging, "package", "README.md"), "a synthetic build\n");
  const out = join(staging, "codex.tgz");
  const packed = spawnSync("tar", ["-czf", out, "-C", staging, "package"]);
  expect(packed.status, String(packed.stderr)).toBe(0);
  const bytes = readFileSync(out);
  return {
    bytes,
    row: (url) => ({ name: "codex", version, team: "SYNTHETIC1", entry: "package/bin/codex", artifact: { url, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") } }),
  };
}

async function serve(files: Record<string, Buffer>): Promise<{ url: (path: string) => string; asked: Record<string, number>; mode: "up" | "down" | "held"; release(): void }> {
  const waiting: (() => void)[] = [];
  const state = {
    url: (path: string) => `http://127.0.0.1:${(server.address() as AddressInfo).port}${path}`,
    asked: {} as Record<string, number>,
    mode: "up" as "up" | "down" | "held",
    release() {
      state.mode = "up";
      for (const go of waiting.splice(0)) go();
    },
  };
  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    state.asked[path] = (state.asked[path] ?? 0) + 1;
    const answer = () => {
      const bytes = files[path];
      if (bytes === undefined) return response.writeHead(404).end();
      response.writeHead(200, { "content-length": bytes.length });
      response.end(bytes);
    };
    if (state.mode === "down") return request.socket.destroy();
    if (state.mode === "held") return void waiting.push(answer);
    answer();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  ends.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return state;
}

const signs: SignatureCheck = async (folder) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((each) => each.isFile()).map((each) => join(each.parentPath, each.name));

const settled = (programs: Programs, name: ProgramName): Promise<void> =>
  until(`${name}'s fetch ended`, () => programs.state().find((each) => each.name === name)?.state !== "fetching");

const entries = (folder: string): string[] => existsSync(folder) ? readdirSync(folder).sort() : [];

describe("programs", () => {
  it("a build its check refuses is kept or named, or a crash at any step leaves a half program that runs, one never finished, or its tarball", async () => {
    const { bytes, row } = tarball(PIN);
    const server = await serve({ "/codex.tgz": bytes });
    const pinned = row(server.url("/codex.tgz"));

    const refusedDir = temp("refused");
    const refusing = new Programs({ dir: refusedDir, rows: [pinned], signed: async () => { throw new Refused("package/bin/codex is not signed by team SYNTHETIC1"); } });
    refusing.choose("codex");
    await settled(refusing, "codex");
    const refused = refusing.state().find((each) => each.name === "codex");
    expect(refused).toEqual({ name: "codex", state: "failed", bytes: null, total: null, why: "Codex as downloaded is not what its maker published." });
    expect(entries(programFolder(refusedDir, "codex"))).toEqual([]);
    expect(readyBinary(refusedDir, "codex", [pinned])).toBeNull();
    await refusing.close();

    const crashes: Record<string, unknown> = {};
    for (const step of ["programs.fetched", "programs.unpacked", "programs.renamed", "programs.current"]) {
      const dir = temp("crash");
      const folder = programFolder(dir, "codex");
      const child = spawn(process.execPath, [...checkoutProgram(CHILD), dir, JSON.stringify(pinned)], { env: { ...process.env, LIFESTREAM_FAILPOINT: step }, stdio: ["ignore", "ignore", "pipe"] });
      let said = "";
      child.stderr.on("data", (chunk: Buffer) => { said += chunk.toString(); });
      const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => child.once("exit", (exited, by) => resolve([exited, by])));
      expect(signal, `${step}: ${said}`).toBe("SIGKILL");
      expect(code).toBeNull();
      const left = entries(folder);
      const named = existsSync(join(folder, "current")) ? readFileSync(join(folder, "current"), "utf8").trim() : null;
      expect(named === null || named === `${PIN}/package/bin/codex`, step).toBe(true);
      expect(readyBinary(dir, "codex", [pinned]) !== null, step).toBe(step === "programs.current");
      const before = server.asked["/codex.tgz"] ?? 0;
      const next = new Programs({ dir, rows: [pinned], signed: signs });
      next.start();
      await settled(next, "codex");
      await next.close();
      expect(readyBinary(dir, "codex", [pinned]), step).toBe(join(folder, PIN, "package", "bin", "codex"));
      expect(entries(folder), step).toEqual([PIN, "current"]);
      crashes[step] = { left, named, fetched_again: (server.asked["/codex.tgz"] ?? 0) - before };
    }
    expect(Object.values(crashes).map((each) => (each as { fetched_again: number }).fetched_again)).toEqual([0, 0, 0, 0]);
    report.crashes = { refused, crashes };
  });

  it("a fetch to a new pin removes the old version, leaves current naming it, or a fetch that failed offline never comes back", async () => {
    const { bytes, row } = tarball(PIN);
    const server = await serve({ "/codex.tgz": bytes });
    const dir = temp("pin");
    const folder = programFolder(dir, "codex");
    mkdirSync(join(folder, "0.150.0", "package", "bin"), { recursive: true });
    writeFileSync(join(folder, "0.150.0", "package", "bin", "codex"), codexScript("0.150.0"), { mode: 0o755 });
    writeFileSync(join(folder, "current"), "0.150.0/package/bin/codex\n");
    expect(machine({ env: { LIFESTREAM_MACHINE_DIR: dir } }).codex).toBeNull();
    server.mode = "down";
    const lines: unknown[] = [];
    const programs = new Programs({ dir, rows: [row(server.url("/codex.tgz"))], signed: signs, retryMs: 50, log: (line) => lines.push(line) });
    ends.push(() => programs.close());
    programs.start();
    await settled(programs, "codex");
    const offline = programs.state().find((each) => each.name === "codex");
    expect(offline).toMatchObject({ state: "failed", why: "This Mac is offline." });
    expect(entries(folder)).toEqual(["0.150.0", "previous"]);
    server.mode = "up";
    await until("the retry made the pinned Codex ready", () => programs.state().find((each) => each.name === "codex")?.state === "ready");
    expect(machine({ env: { LIFESTREAM_MACHINE_DIR: dir } }).codex).toEqual({ binary: join(folder, PIN, "package", "bin", "codex"), home: join(dir, "codex") });
    expect(entries(folder)).toEqual(["0.150.0", PIN, "current"].sort());
    expect(readFileSync(join(folder, "current"), "utf8")).toBe(`${PIN}/package/bin/codex\n`);
    report.pin = { offline, lines };
  });

  it("a check that could not run removes the build or is never tried again, or one that ran and refused keeps it", async () => {
    const killed = tarball(PIN, "#!/bin/sh\nkill -9 $$\n");
    const wrong = tarball(PIN, codexScript("0.1.0"));
    const good = tarball(PIN);
    const server = await serve({ "/killed.tgz": killed.bytes, "/wrong.tgz": wrong.bytes, "/good.tgz": good.bytes });
    const dir = temp("unrun");
    const folder = programFolder(dir, "codex");
    const lines: { programs?: unknown }[] = [];
    const programs = new Programs({ dir, rows: [killed.row(server.url("/killed.tgz"))], signed: signs, retryMs: 50, log: (line) => lines.push(line) });
    ends.push(() => programs.close());
    programs.choose("codex");
    await settled(programs, "codex");
    expect(programs.state()[0]).toMatchObject({ state: "failed", why: "Codex could not be set up on this Mac." });
    expect(entries(folder)).toContain(`${PIN}.tgz`);
    expect(existsSync(join(folder, "current"))).toBe(false);
    await until("the retry ran the check again", () => lines.filter((line) => line.programs === "failed").length >= 2);
    expect(server.asked).toEqual({ "/killed.tgz": 1 });

    const unsigned = temp("no-codesign");
    const unsignedFolder = programFolder(unsigned, "codex");
    const unrun = new Programs({ dir: unsigned, rows: [good.row(server.url("/good.tgz"))], signed: async () => { throw new Error("codesign could not start"); } });
    ends.push(() => unrun.close());
    unrun.choose("codex");
    await settled(unrun, "codex");
    expect(unrun.state()[0]).toMatchObject({ state: "failed", why: "Codex could not be set up on this Mac." });
    expect(entries(unsignedFolder)).toContain(`${PIN}.tgz`);
    const native = temp("native");
    writeFileSync(join(native, "codex"), Buffer.from("cffaedfe0000000000000000", "hex"));
    const path = process.env.PATH;
    process.env.PATH = temp("empty-path");
    const startless = await codesigned(native, "SYNTHETIC1").then(() => null, (error: unknown) => error).finally(() => { process.env.PATH = path; });
    expect(startless).toBeInstanceOf(Error);
    expect(startless).not.toBeInstanceOf(Refused);

    const refusedDir = temp("wrong-version");
    const refusing = new Programs({ dir: refusedDir, rows: [wrong.row(server.url("/wrong.tgz"))], signed: signs });
    ends.push(() => refusing.close());
    refusing.choose("codex");
    await settled(refusing, "codex");
    expect(refusing.state()[0]).toMatchObject({ state: "failed", why: "Codex as downloaded is not what its maker published." });
    expect(entries(programFolder(refusedDir, "codex"))).toEqual([]);
    report.unrun = { killed: lines, refused: refusing.state()[0] };
  });

  it("an entry that is a link or no native file is run, a current naming a link out of its folder is ready, or a stop during the check publishes", async () => {
    const linked = packed(PIN, (bin) => {
      writeFileSync(join(bin, "real-codex"), codexScript(PIN), { mode: 0o755 });
      symlinkSync("real-codex", join(bin, "codex"));
    });
    const script = tarball(PIN);
    const server = await serve({ "/linked.tgz": linked.bytes, "/script.tgz": script.bytes });
    const refusals: Record<string, unknown> = {};
    for (const [name, row, signed] of [
      ["link", linked.row(server.url("/linked.tgz")), signs],
      ["script", script.row(server.url("/script.tgz")), async (folder: string) => (await signs(folder, "SYNTHETIC1")).filter((file) => !file.endsWith(join("bin", "codex")))],
    ] as const) {
      const dir = temp(`entry-${name}`);
      const programs = new Programs({ dir, rows: [row], signed });
      ends.push(() => programs.close());
      programs.choose("codex");
      await settled(programs, "codex");
      refusals[name] = programs.state()[0];
      expect(entries(programFolder(dir, "codex")), name).toEqual([]);
    }
    expect(Object.values(refusals).map((each) => (each as { why: string }).why)).toEqual(["Codex as downloaded is not what its maker published.", "Codex as downloaded is not what its maker published."]);

    const planted = temp("planted");
    const folder = programFolder(planted, "codex");
    const outside = temp("outside");
    const ran = join(outside, "ran");
    writeFileSync(join(outside, "codex"), `#!/bin/sh\ntouch ${JSON.stringify(ran)}\necho codex-cli ${PIN}\n`, { mode: 0o755 });
    mkdirSync(join(folder, PIN, "package", "bin"), { recursive: true });
    symlinkSync(join(outside, "codex"), join(folder, PIN, "package", "bin", "codex"));
    writeFileSync(join(folder, "current"), `${PIN}/package/bin/codex\n`);
    expect(readyBinary(planted, "codex", [script.row(server.url("/script.tgz"))])).toBeNull();
    expect(machine({ env: { LIFESTREAM_MACHINE_DIR: planted } }).codex).toBeNull();
    const start = new Programs({ dir: planted, rows: [script.row(server.url("/script.tgz"))], signed: signs });
    ends.push(() => start.close());
    start.start();
    await settled(start, "codex");
    expect(existsSync(ran)).toBe(false);

    const stopped = temp("stopped");
    let checking = false;
    const held = new Programs({ dir: stopped, rows: [script.row(server.url("/script.tgz"))], signed: (_folder, _team, signal) => new Promise((_, reject) => {
      checking = true;
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }) });
    held.choose("codex");
    await until("the signature check began", () => checking);
    await held.close();
    expect(existsSync(join(programFolder(stopped, "codex"), "current"))).toBe(false);
    expect(readyBinary(stopped, "codex", [script.row(server.url("/script.tgz"))])).toBeNull();
    report.entries = refusals;
  });

  it("a version's folder that is a link is checked through it and named, or a build that could not be inspected is removed", async () => {
    const script = tarball(PIN);
    const server = await serve({ "/script.tgz": script.bytes });
    const row = script.row(server.url("/script.tgz"));
    const good = temp("good");
    await makeReady(programFolder(good, "codex"), row, { signed: signs, env: process.env });
    expect(readyBinary(good, "codex", [row])).not.toBeNull();

    const linked = temp("linked");
    const folder = programFolder(linked, "codex");
    mkdirSync(folder, { recursive: true });
    symlinkSync(join(programFolder(good, "codex"), PIN), join(folder, PIN));
    expect(await makeReady(programFolder(linked, "codex"), row, { signed: signs, env: process.env }).then(() => null, (error: unknown) => error)).toBeInstanceOf(Refused);
    expect(entries(folder)).toEqual([]);
    expect(readyBinary(linked, "codex", [row])).toBeNull();
    expect(readyBinary(good, "codex", [row])).not.toBeNull();

    const locked = join(programFolder(good, "codex"), PIN, "package");
    chmodSync(locked, 0o000);
    ends.push(() => chmodSync(locked, 0o755));
    const unread = await makeReady(programFolder(good, "codex"), row, { signed: signs, env: process.env }).then(() => null, (error: unknown) => error);
    expect(unread).toBeInstanceOf(Error);
    expect(unread).not.toBeInstanceOf(Refused);
    expect((unread as NodeJS.ErrnoException).code).toBe("EACCES");
    chmodSync(locked, 0o755);
    expect(entries(programFolder(good, "codex"))).toEqual([PIN, "previous"]);
    await makeReady(programFolder(good, "codex"), row, { signed: signs, env: process.env });
    expect(entries(programFolder(good, "codex"))).toEqual([PIN, "current"]);
  });

  it("a retry fetches a program machine.json names", async () => {
    const { bytes, row } = tarball(PIN);
    const server = await serve({ "/codex.tgz": bytes });
    server.mode = "down";
    let named = false;
    const asked: string[] = [];
    const programs = new Programs({
      dir: temp("override"), rows: [row(server.url("/codex.tgz"))], signed: signs, retryMs: 50, overridden: (name) => { asked.push(name); return named; },
      log: (line) => {
        if (line.programs !== "failed") return;
        named = true;
        server.mode = "up";
      },
    });
    ends.push(() => programs.close());
    programs.choose("codex");
    const before = asked.length;
    await until("the retry asked whether machine.json names Codex", () => asked.length > before);
    expect(programs.state()[0]?.state).toBe("ready");
    expect(server.asked).toEqual({ "/codex.tgz": 1 });
  });

  it("a chosen program not ready, with no fetch running and none failed, reads as anything but failed", async () => {
    const { bytes, row } = tarball(PIN);
    const server = await serve({ "/codex.tgz": bytes });
    let named = true;
    const programs = new Programs({ dir: temp("unnamed"), rows: [row(server.url("/codex.tgz"))], signed: signs, overridden: () => named });
    ends.push(() => programs.close());
    expect(programs.choose("codex")[0]?.state).toBe("ready");
    named = false;
    const unready = programs.state()[0];
    expect(unready).toEqual({ name: "codex", state: "failed", bytes: null, total: null, why: "Codex is not ready on this Mac." });
    expect(server.asked).toEqual({});
    report.unready = unready;
  });

  it("macOS's codesign takes a file that is not the maker's, or a build with no native file", async () => {
    const system = packed("1.0.0", (bin) => copyFileSync("/bin/ls", join(bin, "claude")));
    const server = await serve({ "/claude.tgz": system.bytes });
    const dir = temp("codesign");
    const row = { ...system.row(server.url("/claude.tgz")), name: "claude" as const, team: "Q6L2SF6YDW", entry: "package/bin/claude" };
    const programs = new Programs({ dir, rows: [row] });
    ends.push(() => programs.close());
    programs.choose("claude");
    await settled(programs, "claude");
    expect(programs.state().find((each) => each.name === "claude")).toMatchObject({ state: "failed", why: "Claude Code as downloaded is not what its maker published." });
    expect(entries(programFolder(dir, "claude"))).toEqual([]);
    const none = temp("no-native");
    writeFileSync(join(none, "claude"), "#!/bin/sh\n", { mode: 0o755 });
    expect(await codesigned(none, "Q6L2SF6YDW").then(() => null, (error: unknown) => error)).toBeInstanceOf(Refused);
  });
});

describe("the home's programs", () => {
  const roots: string[] = [];
  afterAll(() => { for (const root of roots) removeRoot(root); });

  it("two choices at once fetch twice, a phone or a reader starts a download, or a chosen, signed-in Codex serves no call", async () => {
    const { bytes, row } = tarball(PIN);
    const server = await serve({ "/codex.tgz": bytes });
    server.mode = "held";
    const dir = temp("choose");
    mkdirSync(join(dir, "codex"), { recursive: true });
    writeFileSync(join(dir, "codex", "auth.json"), JSON.stringify({ synthetic: "a ChatGPT sign-in" }), { mode: 0o600 });
    const root = makeRoot("lifestream-subscriptions-", { sources: { [SOURCE]: "fake-rows" }, settings: { "model.defaults.pictures": "codex:gpt-6-luna" } });
    roots.push(root);
    const lines: string[] = [];
    const at = machine({ env: { LIFESTREAM_MACHINE_DIR: dir } });
    await startHere(root, {
      tickMs: TICK_MS, log: (line) => lines.push(line), machine: at,
      programs: { rows: [row(server.url("/codex.tgz"))], signed: signs },
    });
    const { url } = await openDoor(root, { machine: at });
    const passes = openHomeFolder(root);
    const mac = randomBytes(32).toString("base64url");
    mintPrincipal(passes, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: ["apple-notes:local:macbook-pro-0001"], token: mac, now_ms: Date.now() });
    const phone = randomBytes(32).toString("base64url");
    mintPrincipal(passes, { unit: "iphone-17-pro-aa01", kind: "phone", scopes: ["deliver", "read"], sources: ["location:local:iphone-17-pro-aa01"], token: phone, now_ms: Date.now() });
    const reader = mintPrincipal(passes, { unit: "reader", scopes: ["read"], now_ms: Date.now() }).token;
    const ask = async (method: string, path: string, token: string, device: string) => {
      const response = await fetch(`${url}${path}`, { method, headers: { authorization: `Bearer ${token}`, "lifestream-device": device } });
      return { status: response.status, body: await response.json() as { programs?: { name: string; state: string }[]; code?: string } };
    };
    const codexOf = (body: { programs?: { name: string; state: string }[] }) => body.programs?.find((each) => each.name === "codex");

    const chosen = await Promise.all([ask("POST", "/v1/subscriptions/codex", mac, DEVICE.mac["lifestream-device"]), ask("POST", "/v1/subscriptions/codex", mac, DEVICE.mac["lifestream-device"])]);
    expect(chosen.map((each) => [each.status, codexOf(each.body)?.state])).toEqual([[200, "fetching"], [200, "fetching"]]);
    await until("the fetch asked the server", () => server.asked["/codex.tgz"] === 1);
    const refused = {
      read: await ask("GET", "/v1/subscriptions", phone, "phone/1.0.0"),
      choose: await ask("POST", "/v1/subscriptions/claude", phone, "phone/1.0.0"),
      reader_read: await ask("GET", "/v1/subscriptions", reader, "reader"),
      reader_choose: await ask("POST", "/v1/subscriptions/claude", reader, "reader"),
      unknown: await ask("POST", "/v1/subscriptions/gemini", mac, DEVICE.mac["lifestream-device"]),
    };
    expect(Object.fromEntries(Object.entries(refused).map(([name, each]) => [name, [each.status, each.body.code ?? null]]))).toEqual({
      read: [403, "PRINCIPAL_SCOPE"], choose: [403, "PRINCIPAL_SCOPE"], reader_read: [403, "PRINCIPAL_SCOPE"], reader_choose: [403, "PRINCIPAL_SCOPE"], unknown: [404, null],
    });
    expect(existsSync(programFolder(dir, "claude"))).toBe(false);
    server.release();
    await until("Codex ready, as the door says", async () => codexOf((await ask("GET", "/v1/subscriptions", mac, DEVICE.mac["lifestream-device"])).body)?.state === "ready");
    expect(server.asked).toEqual({ "/codex.tgz": 1 });

    await ship(root, { source: SOURCE, fetched_ms: Date.now(), rows: [note("n1", "a beach", Date.now() - 3_600_000, { photo: "p1" })] }, { machineDir: dir });
    const captions = () => readHome(root, (db) => db.prepare("SELECT state, content FROM enrichments WHERE family = 'notes'").all()) as { state: string; content: string | null }[];
    await until("the note's caption answered through Codex", () => captions().some((each) => each.state === "done"));
    expect(captions().find((each) => each.state === "done")!.content).toContain("a synthetic caption from codex");
    report.chosen = { chosen: chosen.map((each) => each.body), refused, captions: captions(), log: lines.filter((line) => line.includes('"programs"')) };
  });
});
