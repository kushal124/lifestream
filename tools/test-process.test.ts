import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const GUARD = fileURLToPath(new URL("../testing/process.mjs", import.meta.url));
const NOT_THERE = "/nonexistent/no-tailscale-of-this-machine-in-a-test/tailscale";
const folder = mkdtempSync(join(tmpdir(), "ls-tp-"));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

const named = (error: unknown) => (error as NodeJS.ErrnoException & { path?: string }).path;

describe("no Tailscale of this machine in a test", () => {
  it("runs the Mac app's program and a bare name as programs that are not there, by each of the four and promisify(execFile)", async () => {
    for (const file of [MAC_APP, "tailscale", "/opt/homebrew/bin/tailscale"]) {
      expect(named(spawnSync(file, ["serve", "status", "--json"]).error)).toBe(NOT_THERE);
      expect(named(await new Promise((done) => spawn(file, ["status"]).once("error", done).once("spawn", () => done(new Error(`${file} ran`)))))).toBe(NOT_THERE);
      expect(named(await new Promise((done) => execFile(file, ["status"], (error) => done(error))))).toBe(NOT_THERE);
      expect(() => execFileSync(file, ["status"])).toThrow(NOT_THERE);
      expect(named(await promisify(execFile)(file, ["status"]).catch((error: unknown) => error))).toBe(NOT_THERE);
    }
  });

  it("holds in a child process of the test", () => {
    const child = spawnSync(process.execPath, ["-e", `const r = require("node:child_process").spawnSync(${JSON.stringify(MAC_APP)}, ["status"]); process.stdout.write(String(r.error && r.error.path));`], { encoding: "utf8" });
    expect(child.stdout).toBe(NOT_THERE);
  });

  it("holds in a grandchild of a process that loaded it by --import alone, as node --test does", () => {
    const grandchild = `const r = require("node:child_process").spawnSync(${JSON.stringify(MAC_APP)}, ["status"]); process.stdout.write(String(r.error && r.error.path));`;
    const child = `process.stdout.write(require("node:child_process").spawnSync(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { encoding: "utf8" }).stdout);`;
    const { NODE_OPTIONS: _, ...env } = process.env;
    const run = spawnSync(process.execPath, [`--import=${GUARD}`, "-e", child], { encoding: "utf8", env });
    expect(run.stdout).toBe(NOT_THERE);
  });

  it("runs a test's fake in its temporary folder", () => {
    const fake = join(folder, "tailscale");
    writeFileSync(fake, "#!/bin/sh\necho fake \"$@\"\n");
    chmodSync(fake, 0o755);
    expect(execFileSync(fake, ["serve", "status"], { encoding: "utf8" })).toBe("fake serve status\n");
    return expect(promisify(execFile)(fake, ["serve", "status"], { encoding: "utf8" })).resolves.toEqual({ stdout: "fake serve status\n", stderr: "" });
  });
});
