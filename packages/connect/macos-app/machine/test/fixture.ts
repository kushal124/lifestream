import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Fixture } from "../../../test/drive.js";
import { machineFixture } from "../../../ios-app/phone.test-support.js";
export const MACHINE_UNIT = "macbook-pro-0001";
export const MACHINE_SOURCE = `machine:local:${MACHINE_UNIT}`;

type Detail = Record<string, string | number | boolean>;

export function machineLine(at: string, event: string, detail: Detail = {}): string {
  const members = Object.keys(detail).sort().map((key) => `${JSON.stringify(key)}:${JSON.stringify(detail[key])}`);
  return `{"at":${JSON.stringify(at)},"event":${JSON.stringify(event)},"detail":{${members.join(",")}}}`;
}

export function logFile(lines: string[]): Buffer {
  return Buffer.from(lines.map((line) => `${line}\n`).join(""));
}

const STATE: Detail = {
  awake: true, display_awake: true, session_active: true, locked: false, power: "ac",
  battery_percent: 72, lid_open: true, wifi_joined: true, wifi_name: "synthetic-network",
};

export function machineFiles(): Record<string, Buffer> {
  return {
    "20260906T230000.000Z.jsonl": logFile([
      machineLine("2026-09-06T23:00:00.000Z", "state", STATE),
      machineLine("2026-09-06T23:05:00.000Z", "lock"),
      machineLine("2026-09-06T23:10:00.250Z", "wifi_join", { name_unavailable: true }),
      machineLine("2026-09-06T23:10:00.250Z", "wifi_join", { name: "synthetic-network-2" }),
      machineLine("2026-09-06T23:11:00.125Z", "output_volume", { volume: 0.25, muted: false }),
    ]),
    "20260907T223000.000Z.jsonl": logFile([
      machineLine("2026-09-07T22:30:00.000Z", "state", STATE),
      machineLine("2026-09-07T22:31:00.001Z", "power_battery", { battery_percent: 71 }),
      machineLine("2026-09-07T22:35:00.999Z", "sleep"),
    ]),
    "current.jsonl": logFile([machineLine("2026-09-08T22:30:00.000Z", "state", STATE)]),
  };
}

export const MACHINE_FACTS = { snapshot_taken_at: "2026-09-07T22:40:00.000Z" };

export function peripheralFiles(): Record<string, Buffer> {
  const display = {
    display: 7, name: "Synthetic Monitor", built_in: false, main: false, x: 1512, y: -400, width: 2560, height: 1440,
    pixel_width: 5120, pixel_height: 2880, width_mm: 597, height_mm: 336,
  };
  const headphones = {
    address: "00-00-5e-00-53-01", name: "Synthetic Headphones", class_of_device: 2360344, major: "audio_video", minor: "headphones",
  };
  return {
    "20260909T080000.000Z.jsonl": logFile([
      machineLine("2026-09-09T08:00:00.000Z", "state", {
        ...STATE, displays: 1, display_names: "Synthetic Built-in Display", bluetooth_connected: 0, ambient_lux: 67,
      }),
      machineLine("2026-09-09T08:01:00.000Z", "display_attach", display),
      machineLine("2026-09-09T08:01:30.000Z", "display_change", { ...display, x: 0, main: true }),
      machineLine("2026-09-09T08:02:00.000Z", "bluetooth_connect", headphones),
      machineLine("2026-09-09T08:03:00.000Z", "ambient_light", { lux: 410 }),
      machineLine("2026-09-09T08:04:00.000Z", "bluetooth_disconnect", headphones),
      machineLine("2026-09-09T08:05:00.000Z", "display_detach", { ...display, x: 0, main: true }),
    ]),
  };
}

export const fixture: Fixture = (folder) => {
  const { "current.jsonl": _open, ...sealed } = machineFiles();
  for (const [path, bytes] of Object.entries(sealed)) writeFileSync(join(folder, path), bytes);
  const event = (key: string) => `machine-event ${key}`;
  return {
    source: MACHINE_SOURCE,
    facts: MACHINE_FACTS,
    files: {
      "20260906T230000.000Z.jsonl": {
        alone: ["20260906T230000Z:state", "20260906T230500Z:lock", "20260906T231000.25Z:wifi_join", "20260906T231000.25Z:wifi_join:1", "20260906T231100.125Z:output_volume"].map(event),
        prefix: [event("20260906T230000Z:state")],
      },
      "20260907T223000.000Z.jsonl": { alone: ["20260907T223000Z:state", "20260907T223100.001Z:power_battery", "20260907T223500.999Z:sleep"].map(event) },
    },
  };
};

export const fixtures: Readonly<Record<string, Fixture>> = {
  "machine-events": fixture,
  "machine-ios-bundle": machineFixture,
};
