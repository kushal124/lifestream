import { createServer } from "node:net";
import { onTestFinished } from "vitest";
import type { Connector } from "@lifestreamprotocol/connect";
import { askGeneration, serveDoor, type Door, type DoorOptions } from "../door.js";
import { startingSettings } from "../lifecycle.js";
import { machine, type Machine } from "../machine.js";
import { effectiveOf, settingsPath, type DoorAddress } from "../settings.js";
import { editSettings } from "./folder.js";
import { LOOK_MS } from "./harness-root.js";

export async function openDoor(root: string | null, options: DoorOptions & { settings?: DoorAddress } = {}): Promise<{ door: Door; url: string; logs: string[] }> {
  const logs: string[] = [];
  const { settings = { port: 0, max_bundle_bytes: 1 << 30 }, ...rest } = options;
  const door = await serveDoor(root, settings, { lookMs: LOOK_MS, needsMs: 20, ...rest, log: (line) => logs.push(line) });
  onTestFinished(() => door.close());
  return { door, url: `http://127.0.0.1:${door.port}`, logs };
}

export async function doorHere(root: string, options: { registry?: string | URL; connectors?: readonly Connector[]; clock?: () => number; space?: DoorOptions["space"]; generation?: DoorOptions["generation"]; machine?: Machine; needsMs?: number } = {}): Promise<{ door: Door; url: string; lan: number | undefined; logs: string[]; stop(): Promise<void> }> {
  editSettings(root, { "door.port": 0 });
  const { door, url, logs } = await openDoor(root, {
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.connectors === undefined ? {} : { connectors: options.connectors }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.space === undefined ? {} : { space: options.space }),
    ...(options.machine === undefined ? {} : { machine: options.machine }),
    ...(options.needsMs === undefined ? {} : { needsMs: options.needsMs }),
    settings: effectiveOf(startingSettings(root, options.machine ?? machine()), settingsPath(root)).settings.door, generation: options.generation ?? askGeneration,
  });
  const opened = JSON.parse(logs.find((line) => line.includes('"door":"open"'))!) as { lan?: number };
  editSettings(root, { "door.port": door.port, ...(opened.lan === undefined ? {} : { "door.lan_port": opened.lan }) });
  return { door, url, lan: opened.lan, logs, stop: () => door.close() };
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
