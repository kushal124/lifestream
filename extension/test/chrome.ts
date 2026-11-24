import { spawn, type ChildProcess } from "node:child_process";
import { until } from "./until.js";

export function chrome(binary: string, args: string[]): { child: ChildProcess; stop: () => Promise<void> } {
  const child = spawn(binary, args, { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let closed = false;
  child.once("close", () => { closed = true; });
  const stop = async (): Promise<void> => {
    try {
      if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid!, "SIGKILL");
    } catch {
    }
    await until("every process of Chrome gone", () => closed);
  };
  return { child, stop };
}
