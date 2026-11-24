import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Json, JsonObject } from "@lifestreamprotocol/core";
import { HOME_FILE, HOME_FORMAT, readHome } from "../lifecycle.js";
import { settingsPath } from "../settings.js";
import { socketPath, type HomeSocket } from "../socket.js";

export const TEST_UNIT = "macbook-pro-0001";

if (process.env.LIFESTREAM_MACHINE_DIR === undefined) {
  const dir = mkdtempSync(join(tmpdir(), "lifestream-machine-"));
  writeFileSync(join(dir, "machine.json"), JSON.stringify({ dnssd: join(dir, "no-dns-sd"), bonjour: "127.0.0.1", unit: TEST_UNIT }));
  process.env.LIFESTREAM_MACHINE_DIR = dir;
}

const testId = (root: string): string => `test-${basename(root)}`;

export function testSocket(root: string, machineDir: string = process.env.LIFESTREAM_MACHINE_DIR!): HomeSocket {
  return { path: socketPath(machineDir, existsSync(join(root, HOME_FILE)) ? readHome(root).id : testId(root)), folder: root };
}

export function writeFolder(root: string, settings: Record<string, Json> = {}): void {
  mkdirSync(join(root, "config"), { recursive: true });
  if (!existsSync(join(root, HOME_FILE))) {
    writeFileSync(join(root, HOME_FILE), JSON.stringify({ format: HOME_FORMAT, id: testId(root), created: "2026-09-01T00:00:00.000Z" }));
  }
  writeFileSync(settingsPath(root), JSON.stringify({ "day.zone": "UTC", unit: TEST_UNIT, "door.port": 0, "door.lan_port": 0, ...settings }, null, 2));
}

export function editSettings(root: string, members: Record<string, Json | null>): void {
  const held = JSON.parse(readFileSync(settingsPath(root), "utf8")) as JsonObject;
  for (const [key, value] of Object.entries(members)) {
    if (value === null) delete held[key];
    else held[key] = value;
  }
  writeFileSync(settingsPath(root), JSON.stringify(held, null, 2));
}
