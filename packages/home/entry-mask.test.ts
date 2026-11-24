import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest";
import { REPO } from "./test/support.js";

const AT_EXIT = `data:text/javascript,${encodeURIComponent(`import { writeFileSync } from "node:fs"; process.on("exit", () => writeFileSync(process.env.MASK_OUT, ""));`)}`;

let was = 0;
beforeAll(() => {
  was = process.umask(0o022);
});
afterAll(() => {
  process.umask(was);
});

describe("every entry sets the owner-only mask", () => {
  it.each([
    ["the home's command", ["packages/home/cli.ts", "help"]],
    ["the door", ["packages/home/door-main.ts"]],
    ["the runner", ["packages/runner/main.ts"]],
  ])("%s", (_name, args) => {
    const dir = mkdtempSync(join(tmpdir(), "lifestream-mask-"));
    onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, "made");
    const ran = spawnSync(process.execPath, ["--import", "tsx", "--import", AT_EXIT, ...args], {
      cwd: REPO, encoding: "utf8", env: { ...process.env, MASK_OUT: out, LIFESTREAM_MACHINE_DIR: join(dir, "machine") },
    });
    expect([ran.error, statSync(out).mode & 0o777], ran.stderr).toEqual([undefined, 0o600]);
  });
});
