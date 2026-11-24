import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { PoolOptions, WorkerRequest } from "vitest/node";
import { ForksNamingDeath, pruneTsxCache } from "../testing/run.mjs";
import { reds } from "./check.js";

const dir = mkdtempSync(join(tmpdir(), "lifestream-test-run-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const name = (i: number) => `17945-${String(i).padStart(40, "0")}`;

function cache(folder: string, count: number): string {
  const path = join(dir, folder);
  mkdirSync(path);
  for (let i = 0; i < count; i += 1) {
    writeFileSync(join(path, name(i)), "{}");
    utimesSync(join(path, name(i)), i, i);
  }
  return path;
}

describe("the tsx cache's bound", () => {
  it("leaves a cache at its bound whole, and prunes one past it to the newest half", () => {
    const at = cache("at", 10);
    pruneTsxCache(at, 10);
    expect(readdirSync(at)).toHaveLength(10);

    const past = cache("past", 11);
    pruneTsxCache(past, 10);
    expect(readdirSync(past).sort()).toEqual([6, 7, 8, 9, 10].map(name));
  });
});

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(dir, "dist");
mkdirSync(join(DIST, "workers"), { recursive: true });
writeFileSync(join(DIST, "workers", "forks.js"), `process.on("message", (message) => {
  if (message.type !== "run") return;
  const file = message.context.files[0].filepath;
  if (file.endsWith("killed.test.ts")) process.kill(process.pid, "SIGKILL");
  else if (file.endsWith("exits.test.ts")) process.exit(3);
  else process.send({ __vitest_worker_response__: true, type: "testfileFinished" });
});
`);

const options = { distPath: DIST, method: "run", env: process.env, execArgv: [], project: { vitest: { config: { root: ROOT }, logger: { outputStream: new PassThrough(), errorStream: new PassThrough() } } } } as unknown as PoolOptions;
const run = (file: string) => ({ __vitest_worker_request__: true, type: "run", context: { files: [{ filepath: join(ROOT, file) }] } }) as unknown as WorkerRequest;

function worker(): { forks: ForksNamingDeath; said: Promise<string> } {
  let forks: ForksNamingDeath | undefined;
  const said = new Promise<string>((resolve) => {
    forks = new ForksNamingDeath(options, resolve);
  });
  return { forks: forks!, said };
}

function finished(forks: ForksNamingDeath): Promise<void> {
  return new Promise((resolve) => forks.on("message", (message: { type?: string }) => message.type === "testfileFinished" && resolve()));
}

describe("a vitest worker that dies", () => {
  it("is named with the file it was running and its signal, which the check reads as red, after the files its process ran before", async () => {
    const { forks, said } = worker();
    await forks.start();
    const passed = finished(forks);
    forks.send(run("packages/home/passes.test.ts"));
    await passed;
    forks.send(run("packages/home/killed.test.ts"));
    const line = await said;
    expect(line).toBe("worker died running packages/home/killed.test.ts: signal SIGKILL\n  its process ran before: packages/home/passes.test.ts\n");
    expect(reds("vitest", line)).toEqual(["packages/home/killed.test.ts"]);
  });

  it("is named with its exit code when code in it ended the process", async () => {
    const { forks, said } = worker();
    await forks.start();
    forks.send(run("packages/core/exits.test.ts"));
    const line = await said;
    expect(line).toBe("worker died running packages/core/exits.test.ts: exit code 3\n");
    expect(reds("vitest", line)).toEqual(["packages/core/exits.test.ts"]);
  });

  it("says nothing when vitest stops it", async () => {
    const lines: string[] = [];
    const forks = new ForksNamingDeath(options, (line) => lines.push(line));
    await forks.start();
    const passed = finished(forks);
    forks.send(run("packages/home/passes.test.ts"));
    await passed;
    await forks.stop();
    expect(lines).toEqual([]);
  });
});
