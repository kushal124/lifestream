import { instant, type Delivery, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, counts, deliver, expectParity, openTestHome, temp, type TestHome } from "../../test/drive.js";
import { describe, expect, it } from "vitest";
import { iosDomainOf } from "../../index.js";
import { bundle, entry, INSTALL, sealedFiles, UNIT, type SyntheticBundle } from "../../ios-app/phone.test-support.js";
import { machine } from "./connector.js";
import { machineEvents, machineIosBundle } from "./reader.js";
import { logFile, MACHINE_FACTS, MACHINE_SOURCE, machineFiles, machineLine, peripheralFiles } from "./test/fixture.js";

const GOLDEN = new URL("./test/parity.golden.json", import.meta.url);

const PHONE_SOURCE = `machine:local:${UNIT}`;

const diaryLine = (sequence: number, observed_at: string, event: string, detail: Record<string, string>, kind = "machine-event") =>
  entry("machine", kind, sequence, observed_at, { event, detail });

const diary = () => [
  diaryLine(1, "2026-10-03T02:00:00.125Z", "state", { access_location: "not-asked", access_motion: "on", access_photos: "not-now", access_health: "asked" }),
  diaryLine(2, "2026-10-03T02:01:30Z", "access", { grant: "location", state: "limited" }),
];

function sealedPhone(home: TestHome, shipment: SyntheticBundle): Delivery {
  const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
  return {
    id: `phone:${UNIT}/${shipment.bundle_id}`, source: PHONE_SOURCE, sealed_ms: stated_ms, stated_ms,
    facts: { bundle_id: shipment.bundle_id, created_at: shipment.created_at }, files: sealedFiles(home.blobs, shipment),
  };
}

describe("machine events: each of these is impossible", () => {
  it("a synthetic delivery lands different heads than expected", async () => {
    const home = openTestHome();
    try {
      const delivery = deliver(home, MACHINE_SOURCE, machineFiles(), MACHINE_FACTS);
      const landed = await home.land(machineEvents, delivery);
      expect(landed).toMatchObject({ new: 8, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(MACHINE_SOURCE);
      expect(heads.map((head) => head.key)).toEqual([
        "20260906T230000Z:state",
        "20260906T230500Z:lock",
        "20260906T231000.25Z:wifi_join",
        "20260906T231000.25Z:wifi_join:1",
        "20260906T231100.125Z:output_volume",
        "20260907T223000Z:state",
        "20260907T223100.001Z:power_battery",
        "20260907T223500.999Z:sleep",
      ]);
      expect(heads.some((head) => head.key.startsWith("20260908"))).toBe(false);
      expect(home.readThrough(MACHINE_SOURCE)).toBe(Date.parse(MACHINE_FACTS.snapshot_taken_at));
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("the parity golden differs", async () => {
    const home = openTestHome();
    try {
      const rows = await collect(machineEvents.read(deliver(home, MACHINE_SOURCE, machineFiles(), MACHINE_FACTS), home.blobs));
      const parity = expectParity(rows, GOLDEN);
      expect(rows.every((row) => row.device === "macbook-pro-0001" && /\.jsonl:line \d+$/u.test(row.locator ?? ""))).toBe(true);
      artifact(home.dir, "parity.json", parity);
    } finally {
      home.close();
    }
  });

  it("a later delivery without an earlier file lands a gone", async () => {
    const home = openTestHome();
    try {
      await home.land(machineEvents, deliver(home, MACHINE_SOURCE, machineFiles(), MACHINE_FACTS));
      const later = { "20260908T000000.000Z.jsonl": logFile([machineLine("2026-09-08T00:00:00.000Z", "wake")]) };
      const landed = await home.land(machineEvents, deliver(home, MACHINE_SOURCE, later, { snapshot_taken_at: "2026-09-08T00:05:00.000Z" }));
      expect(landed).toMatchObject({ new: 1, gone: 0 });
      expect(home.heads(MACHINE_SOURCE).filter((head) => head.version === "gone")).toEqual([]);
      artifact(home.dir, "heads.json", home.heads(MACHINE_SOURCE));
    } finally {
      home.close();
    }
  });

  it("two lines in one delivery state one key, or a malformed event refuses the whole delivery", async () => {
    const home = openTestHome();
    try {
      const files = {
        "20260906T230000.000Z.jsonl": logFile([
          machineLine("2026-09-06T23:00:00.000Z", "lock"),
          machineLine("2026-09-06T23:00:00.000Z", "lock"),
          machineLine("2026-09-06T23:01:00.000Z", "teleport"),
          machineLine("2026-09-06T23:02:00.000Z", "wake", { nested: { no: 1 } } as never),
        ]),
      };
      const landed = await home.land(machineEvents, deliver(home, MACHINE_SOURCE, files, MACHINE_FACTS));
      expect(landed).toMatchObject({ new: 2, duplicated: 0, refused: 2 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual(["20260906T230100Z:teleport", "20260906T230200Z:wake"]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a line that is no JSON object, is not UTF-8, or states no instant it can read takes the lines after it with it, or lands", async () => {
    const home = openTestHome();
    try {
      const log = Buffer.concat([
        logFile([machineLine("2026-09-06T23:00:00.000Z", "lock"), "not json"]),
        Buffer.from([0xff, 0xfe, 0x0a]),
        logFile([
          '{"event":"lock","detail":{}}',
          '{"at":"2026-09-06 23:00:00","event":"lock","detail":{}}',
          machineLine("2026-13-06T23:00:00.000Z", "lock"),
          machineLine("2026-09-06T23:05:00.000Z", "unlock"),
        ]),
      ]);
      const landed = await home.land(machineEvents, deliver(home, MACHINE_SOURCE, { "20260906T230000.000Z.jsonl": log }, MACHINE_FACTS));
      expect(landed).toMatchObject({ new: 2, refused: 5 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([2, 3, 4, 5, 6].map((line) => `20260906T230000.000Z.jsonl:${line}`));
      expect(home.heads(MACHINE_SOURCE).map((head) => head.key)).toEqual(["20260906T230000Z:lock", "20260906T230500Z:unlock"]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });

  it("a display, Bluetooth or light line the recorder writes is refused, or lands with less than it states", async () => {
    const home = openTestHome();
    try {
      const files = peripheralFiles();
      const landed = await home.land(machineEvents, deliver(home, MACHINE_SOURCE, files, { snapshot_taken_at: "2026-09-09T08:10:00.000Z" }));
      expect(landed).toMatchObject({ new: 7, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(MACHINE_SOURCE);
      expect(heads.map((head) => head.key)).toEqual([
        "20260909T080000Z:state",
        "20260909T080100Z:display_attach",
        "20260909T080130Z:display_change",
        "20260909T080200Z:bluetooth_connect",
        "20260909T080300Z:ambient_light",
        "20260909T080400Z:bluetooth_disconnect",
        "20260909T080500Z:display_detach",
      ]);
      const rows = await collect(machineEvents.read(deliver(home, MACHINE_SOURCE, files, MACHINE_FACTS), home.blobs));
      const stated = files["20260909T080000.000Z.jsonl"]!.toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as { event: string; detail: object });
      expect(rows.map((row) => row.content)).toEqual(stated.map(({ event, detail }) => ({ type: "machine.event", event, detail })));
      artifact(home.dir, "peripherals.json", { landed, heads, contents: rows.map((row) => row.content) });
    } finally {
      home.close();
    }
  });

  it("a phone's state and access lines land as anything but its machine source's events, keyed by install and sequence and timed when observed, or another domain's line is read", async () => {
    const home = openTestHome();
    try {
      const motion = entry("motion", "recorder_event", 1, "2026-10-03T02:00:00Z", { event: "x" });
      const shipment = bundle("machine-1", "2026-10-03T02:05:00Z", { machine: diary(), motion: [motion] });
      expect(iosDomainOf(PHONE_SOURCE)).toBe("machine");
      expect(machine.sources.filter((source) => source.arrives === "phone").map((source) => [source.id, source.read])).toEqual([["machine:local:<unit>", "machine-ios-bundle"]]);
      const landed = await home.land(machineIosBundle, sealedPhone(home, shipment));
      expect(landed).toMatchObject({ new: 2, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(PHONE_SOURCE);
      expect(heads.map((head) => [head.kind, head.key, head.start_ms])).toEqual([
        ["machine-event", `${INSTALL}:1`, Date.parse("2026-10-03T02:00:00.125Z")],
        ["machine-event", `${INSTALL}:2`, Date.parse("2026-10-03T02:01:30Z")],
      ]);
      expect(heads.map((head) => head.content)).toEqual(diary().map((line) => ({ type: "machine.event", ...(line as { payload: JsonObject }).payload })));
      const rows = await collect(machineIosBundle.read(sealedPhone(home, shipment), home.blobs));
      expect(rows.map((row) => [row.device, row.locator])).toEqual([[UNIT, "machine.jsonl line 1"], [UNIT, "machine.jsonl line 2"]]);
      artifact(home.dir, "phone-heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a Mac's access line is refused, a phone's line outside the one list lands, or a phone line of another kind takes the lines after it with it", async () => {
    const home = openTestHome();
    try {
      const mac = { "20260910T080000.000Z.jsonl": logFile([
        machineLine("2026-09-10T08:00:00.000Z", "state", { awake: true, access_screenRecording: "on", access_fullDiskAccess: "not-asked" }),
        machineLine("2026-09-10T08:01:00.000Z", "access", { grant: "screenRecording", state: "off" }),
      ]) };
      expect(await home.land(machineEvents, deliver(home, MACHINE_SOURCE, mac, { snapshot_taken_at: "2026-09-10T08:05:00.000Z" }))).toMatchObject({ new: 2, refused: 0 });
      const outside = bundle("machine-2", "2026-10-03T02:05:00Z", { machine: [...diary(), diaryLine(3, "2026-10-03T02:02:00Z", "teleport", {})] });
      const landed = await home.land(machineIosBundle, sealedPhone(home, outside));
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([`${INSTALL}:3`]);
      const other = bundle("machine-3", "2026-10-03T02:06:00Z", { machine: [
        diaryLine(11, "2026-10-03T02:00:00Z", "state", {}, "snapshot"),
        diaryLine(12, "2026-10-03T02:03:00Z", "lock", {}),
        diaryLine(13, "2026-10-03T25:00:00Z", "unlock", {}),
      ] });
      const lines = await home.land(machineIosBundle, sealedPhone(home, other));
      expect(lines).toMatchObject({ new: 1, refused: 2 });
      expect(lines.refusals.map((refusal) => refusal.key)).toEqual(["machine.jsonl line 1", "machine.jsonl line 3"]);
      artifact(home.dir, "lists.json", { mac: home.heads(MACHINE_SOURCE), phone: home.heads(PHONE_SOURCE), landed, lines });
    } finally {
      home.close();
    }
  });
});
