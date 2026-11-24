import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./harness-root.js";

export const FACES_FETCHED = process.platform === "darwin" && existsSync(join(REPO, "faces", ".build", "artifacts", "faces", "onnxruntime"));

export interface Facts { width: number; height: number; orientation?: number; gps: boolean; alpha: boolean; type: string; frames: number; corners: string[]; shown: string[] }
export const UPRIGHT = ["red", "green", "blue", "black"];

interface Running { readonly named: string; said: string }
const running = new Map<ChildProcess, Running>();
process.once("exit", () => {
  for (const child of running.keys()) child.kill("SIGKILL");
});

const tail = (said: string) => said.slice(-2000);

export function run(program: string, args: readonly string[]): Promise<string> {
  const named = `${program} ${args.join(" ")}`;
  const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
  const seen: Running = { named, said: "" };
  running.set(child, seen);
  let out = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    out += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    seen.said += chunk;
  });
  return new Promise<string>((resolve, reject) => {
    child.once("error", (error) => {
      running.delete(child);
      reject(new Error(`${named} did not start: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      running.delete(child);
      if (code === 0) resolve(out);
      else reject(new Error(`${named} ended ${signal === null ? `with ${code}` : `by ${signal}`}: ${tail(`${out}${seen.said}`)}`));
    });
  });
}

export function endRuns(): void {
  const left = [...running].map(([child, seen]) => {
    child.kill("SIGKILL");
    return `${seen.named} (pid ${child.pid}), which said: ${tail(seen.said) || "nothing"}`;
  });
  if (left.length > 0) throw new Error(`still running when its file ended, now killed: ${left.join("; ")}`);
}

const FACES = join(REPO, "faces");
const BUILT_ENGINE = join(FACES, ".build", "debug", "face-engine");

function newestUnder(path: string): number {
  const stat = statSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return 0;
  if (!stat.isDirectory()) return stat.mtimeMs;
  return Math.max(stat.mtimeMs, ...readdirSync(path).map((name) => newestUnder(join(path, name))));
}

const engineCurrent = () => newestUnder(BUILT_ENGINE) > Math.max(...["Sources", "Package.swift", "Package.resolved"].map((name) => newestUnder(join(FACES, name))));

export async function buildEngine(): Promise<string> {
  if (engineCurrent()) return BUILT_ENGINE;
  const swift = (...args: string[]) => run("swift", [...args, "--package-path", FACES]);
  await swift("build", "--product", "face-engine");
  return join((await swift("build", "--show-bin-path")).trim(), "face-engine");
}

export interface Samples {
  sample(name: string, ...args: string[]): Promise<Buffer>;
  facts(file: string): Promise<Facts>;
  run(...args: string[]): Promise<string>;
}

const SAMPLES_MAIN = "try await Samples.tool(CommandLine.arguments)\n";

async function samplesBuilt(): Promise<string> {
  const source = join(FACES, "EngineTests", "Samples.swift");
  const digest = createHash("sha256").update(readFileSync(source)).update(SAMPLES_MAIN).digest("hex").slice(0, 16);
  const tool = join(FACES, ".build", "test-samples", digest);
  if (existsSync(tool)) return tool;
  mkdirSync(join(FACES, ".build", "test-samples"), { recursive: true });
  const scratch = mkdtempSync(`${tool}-`);
  try {
    const main = join(scratch, "main.swift");
    writeFileSync(main, SAMPLES_MAIN);
    await run("swiftc", ["-o", join(scratch, "samples"), source, main]);
    renameSync(join(scratch, "samples"), tool);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return tool;
}

export async function samplesTool(dir: string): Promise<Samples> {
  const tool = await samplesBuilt();
  return {
    async sample(name, ...args) {
      const file = join(dir, name);
      await run(tool, [...args, file]);
      return readFileSync(file);
    },
    facts: async (file) => JSON.parse(await run(tool, ["facts", file])) as Facts,
    run: (...args) => run(tool, args),
  };
}
