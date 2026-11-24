import { appendFileSync, existsSync } from "node:fs";

export function failpoint(name: string): void {
  if (process.env.LIFESTREAM_FAILPOINT !== name) return;
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

export async function holdpoint(name: string, what: string): Promise<void> {
  const hold = process.env.LIFESTREAM_HOLD;
  if (process.env.LIFESTREAM_FAILPOINT !== name || hold === undefined) return;
  appendFileSync(`${hold}.hits`, `${what}\n`);
  while (existsSync(hold)) await new Promise((resolve) => setTimeout(resolve, 20));
}
