import { describe, expect, it } from "vitest";
import { instant, type Delivery, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { artifact, collect, openTestHome, type TestHome } from "../test/drive.js";
import { energy } from "./sensors.js";
import { bundle, INSTALL, PROCESS, sealedFiles, UNIT, type SyntheticBundle } from "./phone.test-support.js";

const SOURCE = `energy:local:${UNIT}`;
const REINSTALL = "00000000-0000-4000-8000-0000000000a2";

function line(sequence: number, kind: string, observed_at: string, payload: object): object {
  return {
    schema_version: 1,
    domain: "energy",
    kind,
    sequence,
    observed_at,
    captured: { wall_rfc3339: observed_at.replace("Z", "+00:00"), wall_unix_seconds: Date.parse(observed_at) / 1000, elapsed_seconds: 5000.25 + sequence },
    process_instance_id: PROCESS,
    payload,
  };
}

interface Account {
  parts: string[];
  cpu: number;
  energy?: number;
}

function window(start: string, end: string, accounts: Account[], extra: { holds?: [string, string, number][]; wakes?: Record<string, number>; transfers?: [string, number, number][]; open?: string[] } = {}): object {
  const ns = (seconds: number) => Math.round(seconds * 1e9);
  const cpu = accounts.reduce((sum, account) => sum + ns(account.cpu), 0);
  const energy = accounts.reduce((sum, account) => sum + ns(account.energy ?? 0), 0);
  const elapsed = Date.parse(end) - Date.parse(start);
  return {
    window: { start, end, elapsed_ns: elapsed * 1e6 },
    process: {
      start: { cpu_ns: 40_000_000_000, cpu_p_ns: 9_000_000_000, energy_nj: 31_000_000_000, interrupt_wakeups: 12_000, idle_wakeups: 3_000 },
      end: { cpu_ns: 40_000_000_000 + cpu, cpu_p_ns: 9_000_000_000 + Math.round(cpu / 4), energy_nj: 31_000_000_000 + energy, interrupt_wakeups: 12_400, idle_wakeups: 3_090 },
    },
    energy_stated: true,
    accounts: accounts.map((account) => ({
      parts: account.parts, elapsed_ns: Math.round(elapsed * 1e6 / accounts.length), cpu_ns: ns(account.cpu), cpu_p_ns: Math.round(ns(account.cpu) / 4),
      energy_nj: ns(account.energy ?? 0), interrupt_wakeups: 100, idle_wakeups: 20,
    })),
    intervals: Object.fromEntries(accounts.flatMap((account) => account.parts).map((part) => [part, 12])),
    open: extra.open ?? [],
    holds: (extra.holds ?? []).map(([resource, setting, seconds]) => ({ resource, setting, held_ns: ns(seconds) })),
    wakes: extra.wakes ?? {},
    transfers: (extra.transfers ?? []).map(([interface_, sent, received]) => ({ part: "shipping", interface: interface_, tasks: 1, sent_bytes: sent, received_bytes: received })),
  };
}

function powerState(level: number, reason: string): object {
  return {
    reason, battery_level: level, battery_state: "unplugged", whole_device_battery_change_percent: (0.86 - level) * 100,
    estimate_method: "same-day_unplugged_level_delta; charging_resets_baseline", low_power_mode: false, thermal_state: "nominal",
    background_refresh_status: "available", degraded: false, degraded_reason: "none", timezone_identifier: "Etc/GMT-5",
  };
}

const METRICKIT = {
  cpuMetrics: { cumulativeCPUTime: "15 sec", cumulativeCPUInstructions: "41000000000 instructions" },
  gpuMetrics: { cumulativeGPUTime: "2 sec" },
  applicationTimeMetrics: { cumulativeForegroundTime: "600 sec", cumulativeBackgroundTime: "6000 sec", cumulativeBackgroundLocationTime: "5400 sec", cumulativeBackgroundAudioTime: "0 sec" },
  locationActivityMetrics: {
    cumulativeBestAccuracyForNavigationTime: "0 sec", cumulativeBestAccuracyTime: "0 sec", cumulativeNearestTenMetersAccuracyTime: "3600 sec",
    cumulativeHundredMetersAccuracyTime: "0 sec", cumulativeKilometerAccuracyTime: "0 sec", cumulativeThreeKilometersAccuracyTime: "1800 sec",
  },
  networkTransferMetrics: { cumulativeWifiUpload: "1200 kB", cumulativeWifiDownload: "40 kB", cumulativeCellularUpload: "0 kB", cumulativeCellularDownload: "0 kB" },
  signpostMetrics: [
    { signpostCategory: "Parts", signpostName: "location", totalSignpostCount: 640, signpostIntervalData: { signpostCumulativeCPUTime: "2 sec", signpostAverageMemory: "30 MB", signpostCumulativeLogicalWrites: "4 MB" } },
    { signpostCategory: "Parts", signpostName: "photos", totalSignpostCount: 3, signpostIntervalData: { signpostCumulativeCPUTime: "3 sec", signpostAverageMemory: "60 MB", signpostCumulativeLogicalWrites: "1 MB" } },
  ],
};

function metrickit(): object {
  const bytes = Buffer.from(JSON.stringify(METRICKIT));
  return {
    delivery: "subscriber", range_start: "2026-10-02T18:30:00.000000000Z", range_end: "2026-10-03T18:30:00.000000000Z",
    latest_application_version: "0.1.0", includes_multiple_application_versions: false, json_base64: bytes.toString("base64"), json_bytes: bytes.length,
  };
}

function day(): object[] {
  return [
    line(1, "parts", "2026-10-03T02:15:00.000000000Z", window("2026-10-03T02:00:00.000000000Z", "2026-10-03T02:15:00.000000000Z", [
      { parts: [], cpu: 0.4, energy: 0.2 },
      { parts: ["location"], cpu: 2.1, energy: 1.9 },
      { parts: ["shipping"], cpu: 0.6, energy: 0.5 },
      { parts: ["location", "shipping"], cpu: 0.05, energy: 0.04 },
    ], { holds: [["location.precise", "10", 900]], wakes: { location: 31, background_refresh: 1 }, transfers: [["other", 1_200_000, 40_000]] })),
    line(2, "power_state", "2026-10-03T02:15:01.000000000Z", powerState(0.82, "notification:UIDeviceBatteryLevelDidChangeNotification")),
    line(3, "parts", "2026-10-03T02:31:00.000000000Z", window("2026-10-03T02:15:00.000000000Z", "2026-10-03T02:31:00.000000000Z", [
      { parts: [], cpu: 6.0, energy: 5.1 },
      { parts: ["contacts"], cpu: 0.2, energy: 0.1 },
      { parts: ["energy"], cpu: 0.002, energy: 0.001 },
      { parts: ["health"], cpu: 1.1, energy: 0.8 },
      { parts: ["photos"], cpu: 3.2, energy: 2.9 },
    ], { holds: [["foreground", "active", 600], ["location.precise", "10", 300], ["location.keepalive", "3000", 660]], open: ["health"] })),
    line(4, "power_state", "2026-10-03T02:31:00.500000000Z", powerState(0.8, "five_minute_poll")),
    line(5, "metrickit_payload", "2026-10-03T02:31:02.000000000Z", metrickit()),
  ];
}

async function seal(home: TestHome, shipment: SyntheticBundle): Promise<Delivery> {
  const stated_ms = instant(shipment.created_at, "rfc3339").start_ms;
  return {
    id: `phone:${UNIT}/${shipment.bundle_id}`, source: SOURCE, sealed_ms: stated_ms, stated_ms,
    facts: { bundle_id: shipment.bundle_id, created_at: shipment.created_at }, files: sealedFiles(home.blobs, shipment),
  };
}

const motionLine = { schema_version: 1, domain: "motion", kind: "recorder_event", sequence: 1, observed_at: "2026-10-03T02:00:00Z",
  captured: { wall_rfc3339: "2026-10-03T07:30:00+05:30", wall_unix_seconds: 1791001800, elapsed_seconds: 1 }, process_instance_id: PROCESS, payload: { event: "x" } };

const first = () => bundle("energy-1", "2026-10-03T02:32:00Z", { energy: day(), motion: [motionLine] });

describe("the phone's energy domain: each of these is impossible", () => {
  it("a synthetic shipment lands other heads than its energy lines, or reads another domain's", async () => {
    const home = openTestHome();
    try {
      const landed = await home.land(energy, await seal(home, first()));
      expect(landed).toMatchObject({ new: 5, refused: 0, duplicated: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => [head.kind, head.key])).toEqual([1, 2, 3, 4, 5].map((sequence) => ["energy", `${INSTALL}:${sequence}`]));
      expect(heads.map((head) => (head.content as JsonObject).type)).toEqual(["energy.parts", "energy.power-state", "energy.parts", "energy.power-state", "energy.metrickit"]);
      expect(heads.map((head) => [head.start_ms, head.end_ms])).toEqual([
        [Date.parse("2026-10-03T02:00:00Z"), Date.parse("2026-10-03T02:15:00Z")],
        [Date.parse("2026-10-03T02:15:01Z"), null],
        [Date.parse("2026-10-03T02:15:00Z"), Date.parse("2026-10-03T02:31:00Z")],
        [Date.parse("2026-10-03T02:31:00.5Z"), null],
        [Date.parse("2026-10-02T18:30:00Z"), Date.parse("2026-10-03T18:30:00Z")],
      ]);
      expect((heads[0]!.content as JsonObject).content).toEqual(day()[0]);
      const rows = await collect(energy.read(await seal(home, first()), home.blobs));
      expect(rows.every((row) => row.device === UNIT && /^energy\.jsonl line [1-5]$/u.test(row.locator ?? ""))).toBe(true);
      artifact(home.dir, "heads.json", { landed, heads });
    } finally {
      home.close();
    }
  });

  it("a MetricKit diagnostic lands as anything but an energy record timed by its range", async () => {
    const home = openTestHome();
    try {
      const bytes = Buffer.from(JSON.stringify({ diskWriteExceptionDiagnostics: [] }));
      const diagnostic = line(1, "metrickit_diagnostic", "2026-10-03T03:00:00.000000000Z", {
        delivery: "subscriber", range_start: "2026-10-03T02:40:00.000000000Z", range_end: "2026-10-03T02:40:00.000000000Z",
        json_base64: bytes.toString("base64"), json_bytes: bytes.length,
      });
      const landed = await home.land(energy, await seal(home, bundle("energy-d", "2026-10-03T03:01:00Z", { energy: [diagnostic] })));
      expect(landed).toMatchObject({ new: 1, refused: 0 });
      const [head] = home.heads(SOURCE);
      expect((head!.content as JsonObject).type).toBe("energy.metrickit-diagnostic");
      expect((head!.content as JsonObject).content).toEqual(diagnostic);
      expect(head!.start_ms).toBe(Date.parse("2026-10-03T02:40:00Z"));
    } finally {
      home.close();
    }
  });

  it("the same shipment again writes anything, or an overlapping later one loses a line", async () => {
    const home = openTestHome();
    try {
      await home.land(energy, await seal(home, first()));
      const again = await home.land(energy, await seal(home, first()));
      expect(again).toMatchObject({ new: 0, restated: 5, changed: 0, gone: 0 });
      const differs = line(5, "power_state", "2026-10-03T02:31:02.000000000Z", powerState(0.79, "five_minute_poll"));
      const later = bundle("energy-2", "2026-10-03T03:00:00Z", {
        energy: [differs, line(6, "power_state", "2026-10-03T02:59:00.000000000Z", powerState(0.78, "five_minute_poll"))],
      });
      const landed = await home.land(energy, await seal(home, later));
      expect(landed).toMatchObject({ new: 1, changed: 1, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => head.key)).toEqual([1, 2, 3, 4, 5, 6].map((sequence) => `${INSTALL}:${sequence}`));
      expect(heads.every((head) => !head.gone)).toBe(true);
      expect(((heads[4]!.content as JsonObject).content as JsonObject).kind).toBe("power_state");
      artifact(home.dir, "heads.json", heads);
    } finally {
      home.close();
    }
  });

  it("a reinstall's lines, starting again at sequence 1, overwrite the earlier install's records", async () => {
    const home = openTestHome();
    try {
      await home.land(energy, await seal(home, first()));
      const reinstalled = bundle("energy-3", "2026-10-04T02:00:00Z", { energy: [line(1, "power_state", "2026-10-04T01:00:00.000000000Z", powerState(0.9, "monitor_started"))] }, [], [], REINSTALL);
      expect(await home.land(energy, await seal(home, reinstalled))).toMatchObject({ new: 1, changed: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.filter((head) => head.key.startsWith(INSTALL)).length).toBe(5);
      expect(heads.filter((head) => head.key === `${REINSTALL}:1`).length).toBe(1);
    } finally {
      home.close();
    }
  });

  it("a window that ends before it starts, a payload with no range, or an entry kind the phone does not write lands, or takes the lines after it with it", async () => {
    const home = openTestHome();
    try {
      const backwards = line(1, "parts", "2026-10-03T02:15:00.000000000Z", window("2026-10-03T02:15:00.000000000Z", "2026-10-03T02:00:00.000000000Z", [{ parts: [], cpu: 1 }]));
      const { range_start: _dropped, ...rangeless } = metrickit() as JsonObject;
      const noRange = line(2, "metrickit_payload", "2026-10-03T02:15:00.000000000Z", rangeless);
      const unknown = line(3, "estimate", "2026-10-03T02:15:00.000000000Z", { joules: 3 });
      const power = line(4, "power_state", "2026-10-03T02:16:00.000000000Z", powerState(0.5, "level_changed"));
      const landed = await home.land(energy, await seal(home, bundle("bad-1", "2026-10-03T03:00:00Z", { energy: [backwards, noRange, unknown, power] })));
      expect(landed).toMatchObject({ new: 1, refused: 3 });
      expect(landed.refusals.map((refusal) => `${refusal.key} ${refusal.violations.join()}`)).toEqual([
        expect.stringMatching(/^energy\.jsonl line 1 .*must not end before it starts/u),
        expect.stringMatching(/^energy\.jsonl line 2 .*payload range\.start must be an RFC 3339 instant/u),
        expect.stringMatching(/^energy\.jsonl line 3 .*is an entry kind this connector does not know/u),
      ]);
      expect(home.heads(SOURCE).map((head) => head.key)).toEqual([`${INSTALL}:4`]);
    } finally {
      home.close();
    }
  });

  it("a row of another type passes the guard", async () => {
    const home = openTestHome();
    try {
      const delivery = await seal(home, first());
      const rows = await collect(energy.read(delivery, home.blobs));
      const mislabelled: ReaderOutput = { ...rows[1]!, content: { ...(rows[1]!.content as JsonObject), type: "energy.parts" } };
      const landed = await home.land(energy, delivery, [rows[0]!, mislabelled]);
      expect(landed).toMatchObject({ new: 1, refused: 1 });
      expect(landed.refusals[0]).toMatchObject({ key: `${INSTALL}:2` });
    } finally {
      home.close();
    }
  });

  it("a shipment that carries no energy file yields a row, or is refused", async () => {
    const home = openTestHome();
    try {
      const other = bundle("motion-only", "2026-10-03T03:00:00Z", { motion: [motionLine] });
      expect(await collect(energy.read(await seal(home, other), home.blobs))).toEqual([]);
    } finally {
      home.close();
    }
  });

  it("one day's records cannot say what drained what", async () => {
    const home = openTestHome();
    try {
      await home.land(energy, await seal(home, first()));
      const report = dayReport(home.heads(SOURCE).map((head) => ({ content: head.content as JsonObject, start_ms: head.start_ms! })), "2026-10-03");
      expect(report.parts.find((row) => row.parts === "location")).toMatchObject({ cpu_s: 2.1, energy_j: 1.9 });
      expect(report.parts.find((row) => row.parts === "(no part: the app's other work)")).toMatchObject({ cpu_s: 6.4 });
      expect(report.metrickit.coverage).toBe("91%");
      expect(report.holds["location.precise@10"]).toBe("0.33 h");
      artifact(home.dir, "day-report.json", report);
    } finally {
      home.close();
    }
  });
});

function dayReport(records: { content: JsonObject; start_ms: number }[], day: string) {
  const lines = records.map((record) => ({ ...record, line: record.content.content as JsonObject }));
  const windows = lines.filter((record) => record.line.kind === "parts").map((record) => record.line.payload as JsonObject);
  const sums = new Map<string, { cpu: number; energy: number }>();
  const holds: Record<string, number> = {};
  const wakes: Record<string, number> = {};
  let sent = 0;
  for (const window of windows) {
    for (const account of window.accounts as JsonObject[]) {
      const key = (account.parts as string[]).length === 0 ? "(no part: the app's other work)" : (account.parts as string[]).join(" + ");
      const sum = sums.get(key) ?? { cpu: 0, energy: 0 };
      sum.cpu += (account.cpu_ns as number) / 1e9;
      sum.energy += (account.energy_nj as number) / 1e9;
      sums.set(key, sum);
    }
    for (const hold of window.holds as JsonObject[]) holds[`${hold.resource as string}@${hold.setting as string}`] = (holds[`${hold.resource as string}@${hold.setting as string}`] ?? 0) + (hold.held_ns as number) / 1e9;
    for (const [trigger, count] of Object.entries(window.wakes as JsonObject)) wakes[trigger] = (wakes[trigger] ?? 0) + (count as number);
    for (const transfer of window.transfers as JsonObject[]) sent += transfer.sent_bytes as number;
  }
  const cpu = [...sums.values()].reduce((total, sum) => total + sum.cpu, 0);
  const round = (value: number, places = 2) => Number(value.toFixed(places));
  const battery = lines.filter((record) => record.line.kind === "power_state").map((record) => (record.line.payload as JsonObject).battery_level as number);
  const kit = lines.find((record) => record.line.kind === "metrickit_payload")?.line.payload as JsonObject | undefined;
  const payload = kit === undefined ? undefined : (JSON.parse(Buffer.from(kit.json_base64 as string, "base64").toString("utf8")) as Record<string, Record<string, string>>);
  const seconds = (text: string | undefined) => Number.parseFloat(text ?? "0");
  const kitCPU = seconds(payload?.cpuMetrics?.cumulativeCPUTime);
  return {
    day,
    method: "each part's own CPU time and the kernel's CPU-energy estimate, from the app's counters partitioned by which parts had work open; parts open together share a row",
    app_cpu_s: round(cpu),
    parts: [...sums.entries()].sort((a, b) => b[1].cpu - a[1].cpu).map(([parts, sum]) => ({
      parts, cpu_s: round(sum.cpu), share: `${Math.round((sum.cpu / cpu) * 100)}%`, energy_j: round(sum.energy),
    })).sort((a, b) => (a.parts.startsWith("(") ? 1 : 0) - (b.parts.startsWith("(") ? 1 : 0)),
    holds: Object.fromEntries(Object.entries(holds).map(([key, value]) => [key, `${round(value / 3600)} h`])),
    wakes,
    shipping_sent_bytes: sent,
    whole_device_battery: battery.length === 0 ? null : `${Math.round(battery[0]! * 100)}% to ${Math.round(battery.at(-1)! * 100)}% (whole phone, every app)`,
    metrickit: {
      cpu_s: kitCPU,
      coverage: kitCPU === 0 ? null : `${Math.round((cpu / kitCPU) * 100)}%`,
      background_location: payload?.applicationTimeMetrics?.cumulativeBackgroundLocationTime ?? null,
      location_at_10m: payload?.locationActivityMetrics?.cumulativeNearestTenMetersAccuracyTime ?? null,
      wifi_upload: payload?.networkTransferMetrics?.cumulativeWifiUpload ?? null,
    },
  };
}
