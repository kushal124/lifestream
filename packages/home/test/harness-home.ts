import { onTestFinished } from "vitest";
import { askGeneration, type Generated } from "../door.js";
import { homeFolders } from "../folders.js";
import { startHome, type Home, type HomeOptions } from "../home.js";
import { machine } from "../machine.js";
import { doorHere } from "./harness-door.js";
import { FAKES, LOOK_MS, TICK_MS, until } from "./harness-root.js";

export function startHere(root: string | null, options: Partial<HomeOptions> = {}): Promise<Home> {
  const ending = new AbortController();
  const starting = startHome(root, { registry: FAKES, lookMs: LOOK_MS, tickMs: TICK_MS, stopGraceMs: 50, ...options, signal: ending.signal });
  starting.catch(() => undefined);
  onTestFinished(async () => {
    ending.abort();
    await starting.then((home) => home.stop(), () => undefined);
  });
  return starting;
}

export async function serveOnce(root: string | null, options: Partial<HomeOptions> = {}): Promise<string[]> {
  const logs: string[] = [];
  await (await startHere(root, { ...options, log: (line) => logs.push(line) })).stop();
  return logs;
}

const doors = new Map<string, { logs: string[]; serves: Generated }>();

export async function homeWithDoor(root: string, options: HomeOptions): Promise<Home> {
  let door = doors.get(root);
  if (door === undefined) {
    const { logs } = await doorHere(root, { registry: options.registry, ...(options.clock === undefined ? {} : { clock: options.clock }) });
    door = { logs, serves: homeFolders(root).length === 0 ? "[]" : null };
    doors.set(root, door);
    onTestFinished(() => { doors.delete(root); });
  }
  const serving = () => door.logs.filter((line) => line.includes('"door":"serving"')).length;
  const before = serving();
  const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, ...options });
  const admitted = await askGeneration(root, (options.machine ?? machine()).dir);
  if (admitted !== door.serves) await until("the door serves the connectors the home's start admitted", () => serving() > before);
  door.serves = admitted;
  return home;
}

export async function doorThenHome(root: string, options: HomeOptions, door: { registry?: string | URL; clock?: () => number } = {}): Promise<{ home: Home; door: Awaited<ReturnType<typeof doorHere>> }> {
  const opened = await doorHere(root, door);
  const serving = () => opened.logs.filter((line) => line.includes('"door":"serving"')).length;
  const before = serving();
  const home = await startHome(root, { tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, ...options });
  if (await askGeneration(root, (options.machine ?? machine()).dir) !== (homeFolders(root).length === 0 ? "[]" : null)) await until("the door serves the connectors the home's start admitted", () => serving() > before);
  return { home, door: opened };
}
