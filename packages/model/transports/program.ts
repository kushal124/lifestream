import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { errorText, SendFailed, type Unavailable } from "../transport.js";


export interface ProgramAt {
  readonly binary: string;
  readonly home: string;
}

export type ProgramCheck =
  | { state: "missing"; path: null; version: null; why: string }
  | { state: "unusable"; path: string; version: string | null; why: string }
  | { state: "signed_out"; path: string; version: string; why: string }
  | { state: "signed_in"; path: string; version: string; why: null };

export const UNAVAILABLE: Readonly<Record<Exclude<ProgramCheck["state"], "signed_in">, Unavailable>> = { missing: "no_program", unusable: "unusable", signed_out: "signed_out" };

export interface Judging {
  name: string;
  missing: string;
  env: (home: string) => NodeJS.ProcessEnv;
  signIn: { args: readonly string[]; judge: (printed: Probed) => string | null };
}

const PROBE_MS = 10_000;

export interface Probed {
  error: Error | null;
  stdout: string;
  stderr: string;
}

export async function checkProgram(at: ProgramAt | undefined, judging: Judging): Promise<ProgramCheck> {
  if (at === undefined) return { state: "missing", path: null, version: null, why: judging.missing };
  const { binary, home } = at;
  const named = `${judging.name} binary ${binary}`;
  const unusable = (why: string, version: string | null = null): ProgramCheck => ({ state: "unusable", path: binary, version, why });
  try {
    if (!statSync(binary).isFile()) return unusable(`${named} is not a file`);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? unusable(`${named} is missing`) : unusable(`${named} cannot be read: ${errorText(error)}`);
  }
  try { accessSync(binary, constants.X_OK); } catch { return unusable(`${named} is not executable`); }
  const env = judging.env(home);
  const printed = await probe(binary, ["--version"], env);
  if (printed === "late") return unusable(`${named} did not answer --version within ${PROBE_MS / 1000} s`);
  if (printed.error !== null) return unusable(`${named} --version failed: ${errorText(printed.error)}`);
  const version = /\d+\.\d+\.\d+/u.exec(printed.stdout)?.[0];
  if (version === undefined) return unusable(`${named} --version printed no version`);
  const status = await probe(binary, judging.signIn.args, env);
  if (status === "late") return unusable(`${named} did not answer ${judging.signIn.args.join(" ")} within ${PROBE_MS / 1000} s`, version);
  const why = judging.signIn.judge(status);
  return why === null ? { state: "signed_in", path: binary, version, why: null } : { state: "signed_out", path: binary, version, why };
}

function probe(binary: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<Probed | "late"> {
  return new Promise((resolve) => {
    execFile(binary, args, { timeout: PROBE_MS, killSignal: "SIGKILL", env }, (error, stdout, stderr) => {
      resolve((error as { killed?: boolean } | null)?.killed === true ? "late" : { error, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export interface Running {
  env: NodeJS.ProcessEnv;
  cwd?: string;
  stdin: string;
  signal: AbortSignal;
  line?: (text: string) => void;
}

export async function run(name: string, at: ProgramAt, args: readonly string[], running: Running): Promise<{ code: number; stdout: string; stderr: string }> {
  const never = (error: unknown) => new SendFailed(name, `${name} binary ${at.binary} cannot run: ${errorText(error)}`, null, { cause: error });
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(at.binary, args, { detached: true, stdio: ["pipe", "pipe", "pipe"], env: running.env, ...(running.cwd === undefined ? {} : { cwd: running.cwd }) });
  } catch (error) {
    throw never(error);
  }
  return await collect(child, running).catch((error: unknown) => {
    throw child.pid === undefined ? never(error) : error;
  });
}

function collect(child: ChildProcessWithoutNullStreams, { stdin, signal, line }: Running): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let heard = 0;
    const group = (name: "SIGTERM" | "SIGKILL") => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, name);
      } catch {
      }
    };
    const abort = () => {
      group("SIGTERM");
      setTimeout(() => group("SIGKILL"), 1_000);
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      reject(signal.reason);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      for (let end = stdout.indexOf("\n", heard); end >= 0; end = stdout.indexOf("\n", heard)) {
        line?.(stdout.slice(heard, end));
        heard = end + 1;
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.stdin.on("error", () => {
    });
    child.once("error", (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", () => group("SIGKILL"));
    child.once("close", (code) => {
      signal.removeEventListener("abort", abort);
      if (heard < stdout.length) line?.(stdout.slice(heard));
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.end(stdin);
  });
}
