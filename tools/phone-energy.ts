import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export interface EnergyRecord {
  readonly content: { readonly type: string; readonly content: Obj };
}

interface Day {
  coveredS: number;
  cpuS: number;
  joules: number;
  unclaimedCpuS: number;
  parts: Map<string, number>;
  threads: Map<string, number>;
  holdsH: Map<string, number>;
  locationWakes: number;
  counts: Map<string, number>;
  builds: Set<string>;
  diagnostics: number;
  metrickit?: { cpuS: number; writesMB: number; tenMetresH: number };
  speed?: Speed;
  hangDiagnosticsS: number[];
  power: { at: number; level: number; unplugged: boolean }[];
}

const obj = (value: Json | undefined): Obj => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const arr = (value: Json | undefined): Json[] => (Array.isArray(value) ? value : []);
const num = (value: Json | undefined): number => (typeof value === "number" ? value : 0);

function dayOf(ms: number, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

function hourOf(ms: number, zone: string): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", hourCycle: "h23" }).format(ms));
}

function quantity(value: Json | undefined): number {
  const match = typeof value === "string" ? /^([\d.]+)\s*(\w+)/u.exec(value) : null;
  if (!match) return 0;
  const scale: Record<string, number> = { sec: 1, ms: 0.001, kB: 1e3, MB: 1e6, GB: 1e9, B: 1 };
  return Number(match[1]) * (scale[match[2]!] ?? 1);
}

function histogram(value: Json | undefined): { start: number; end: number; count: number }[] {
  const buckets = obj(value).histogramValue;
  const list = Array.isArray(buckets) ? buckets : Object.values(obj(buckets));
  return list.map(obj).map((bucket) => ({ start: quantity(bucket.bucketStart), end: quantity(bucket.bucketEnd), count: num(bucket.bucketCount) }))
    .filter((bucket) => bucket.count > 0).sort((a, b) => a.start - b.start);
}

function medianBucket(value: Json | undefined): { start: number; end: number } | null {
  const buckets = histogram(value);
  const half = buckets.reduce((sum, bucket) => sum + bucket.count, 0) / 2;
  let seen = 0;
  for (const bucket of buckets) {
    seen += bucket.count;
    if (seen >= half) return bucket;
  }
  return null;
}

interface Speed {
  hangs: number;
  largestHang: { start: number; end: number } | null;
  hitchMsPerS: number | null;
  firstDraw: { start: number; end: number } | null;
  resume: { start: number; end: number } | null;
  peakMB: number | null;
}

const SPEED_SECTIONS = ["applicationResponsivenessMetrics", "animationMetrics", "applicationLaunchMetrics", "memoryMetrics"];

function speedOf(body: Obj): Speed {
  const hangs = histogram(obj(body.applicationResponsivenessMetrics).histogrammedAppHangTime);
  const launch = obj(body.applicationLaunchMetrics);
  const hitch = obj(body.animationMetrics).scrollHitchTimeRatio;
  const peak = obj(body.memoryMetrics).peakMemoryUsage;
  return {
    hangs: hangs.reduce((sum, bucket) => sum + bucket.count, 0),
    largestHang: hangs.at(-1) ?? null,
    hitchMsPerS: typeof hitch === "string" && /^[\d.]+/u.test(hitch) ? Number.parseFloat(hitch) : null,
    firstDraw: medianBucket(launch.histogrammedTimeToFirstDrawKey ?? launch.histogrammedTimeToFirstDraw),
    resume: medianBucket(launch.histogrammedResumeTime ?? launch.histogrammedApplicationResumeTime),
    peakMB: typeof peak === "string" ? quantity(peak) / 1e6 : null,
  };
}

function decoded(payload: Obj): Obj {
  try {
    return obj(JSON.parse(Buffer.from(String(payload.json_base64), "base64").toString("utf8")) as Json);
  } catch {
    return {};
  }
}

function add(map: Map<string, number>, key: string, amount: number): void {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function summarize(records: readonly EnergyRecord[], zone: string): Map<string, Day> {
  const days = new Map<string, Day>();
  const dayFor = (key: string): Day => {
    let day = days.get(key);
    if (!day) {
      day = { coveredS: 0, cpuS: 0, joules: 0, unclaimedCpuS: 0, parts: new Map(), threads: new Map(), holdsH: new Map(),
        locationWakes: 0, counts: new Map(), builds: new Set(), diagnostics: 0, hangDiagnosticsS: [], power: [] };
      days.set(key, day);
    }
    return day;
  };
  const diagnosticsSeen = new Set<string>();
  for (const record of records) {
    const line = record.content.content;
    const payload = obj(line.payload);
    if (record.content.type === "energy.parts") {
      const window = obj(payload.window);
      const start = Date.parse(String(window.start));
      const day = dayFor(dayOf(start, zone));
      day.coveredS += num(window.elapsed_ns) / 1e9;
      if (typeof payload.build === "string") day.builds.add(payload.build);
      for (const account of arr(payload.accounts).map(obj)) {
        const cpu = num(account.cpu_ns) / 1e9;
        const joules = num(account.energy_nj) / 1e9;
        const parts = arr(account.parts).map(String);
        const name = parts.length === 0 ? "(none)" : parts.join("+");
        day.cpuS += cpu;
        day.joules += joules;
        if (parts.length === 0) day.unclaimedCpuS += cpu;
        add(day.parts, name, joules);
      }
      for (const thread of arr(payload.threads).map(obj)) add(day.threads, String(thread.thread), num(thread.cpu_ns) / 1e9);
      for (const hold of arr(payload.holds).map(obj)) add(day.holdsH, `${hold.resource}@${hold.setting}`, num(hold.held_ns) / 3.6e12);
      day.locationWakes += num(obj(payload.wakes).location);
      for (const [name, amount] of Object.entries(obj(payload.counts))) {
        if (name.startsWith("store_level_")) day.counts.set(name, num(amount));
        else add(day.counts, name, num(amount));
      }
    } else if (record.content.type === "energy.metrickit") {
      const body = decoded(payload);
      const key = dayOf(Date.parse(String(payload.range_start)) + 3_600_000, zone);
      if (SPEED_SECTIONS.some((section) => section in body)) dayFor(key).speed = speedOf(body);
      const cpu = quantity(obj(body.cpuMetrics).cumulativeCPUTime);
      if (cpu === 0) continue;
      const day = dayFor(key);
      day.metrickit = {
        cpuS: cpu,
        writesMB: quantity(obj(body.diskIOMetrics).cumulativeLogicalWrites) / 1e6,
        tenMetresH: quantity(obj(body.locationActivityMetrics).cumulativeNearestTenMetersAccuracyTime) / 3600,
      };
    } else if (record.content.type === "energy.metrickit-diagnostic") {
      const key = String(payload.json_base64);
      if (diagnosticsSeen.has(key)) continue;
      diagnosticsSeen.add(key);
      const day = dayFor(dayOf(Date.parse(String(payload.range_start)), zone));
      day.diagnostics += 1;
      for (const hang of arr(decoded(payload).hangDiagnostics).map(obj)) {
        day.hangDiagnosticsS.push(quantity(obj(hang.diagnosticMetaData).hangDuration));
      }
    } else if (record.content.type === "energy.power-state") {
      const at = Date.parse(String(line.observed_at));
      dayFor(dayOf(at, zone)).power.push({
        at, level: num(payload.battery_level), unplugged: String(payload.battery_state).includes("rawValue: 1"),
      });
    }
  }
  return new Map([...days.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

function nightDrain(power: Day["power"], zone: string): number | null {
  const night = power.filter((p) => hourOf(p.at, zone) < 6).sort((a, b) => a.at - b.at);
  let drop = 0;
  let hours = 0;
  for (let index = 1; index < night.length; index += 1) {
    const [before, after] = [night[index - 1]!, night[index]!];
    if (!before.unplugged || !after.unplugged || after.level > before.level) continue;
    drop += (before.level - after.level) * 100;
    hours += (after.at - before.at) / 3.6e6;
  }
  return hours >= 2 ? drop / hours : null;
}

const top = (map: Map<string, number>, n: number, unit: string, digits = 0): string =>
  [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n)
    .map(([key, value]) => `${key} ${value.toFixed(digits)}${unit}`).join(", ") || "-";

const ms = (seconds: number): string => `${Math.round(seconds * 1000)}`;
const range = (bucket: { start: number; end: number } | null): string => (bucket ? `${ms(bucket.start)}-${ms(bucket.end)} ms` : "-");

function speedLine(day: Day): string {
  const speed = day.speed;
  const hangs = day.hangDiagnosticsS.length === 0 ? "0"
    : `${day.hangDiagnosticsS.length} (${day.hangDiagnosticsS.sort((a, b) => b - a).map((s) => `${s.toFixed(1)} s`).join(", ")})`;
  const field = speed
    ? `hangs ${speed.hangs}${speed.largestHang ? `, largest ${range(speed.largestHang)}` : ""}`
      + `  scroll hitch ${speed.hitchMsPerS === null ? "-" : `${speed.hitchMsPerS} ms/s`}`
      + `  first draw median ${range(speed.firstDraw)}  resume median ${range(speed.resume)}`
      + `  peak memory ${speed.peakMB === null ? "-" : `${speed.peakMB.toFixed(1)} MB`}`
    : "-";
  return `  speed: ${field}  hang diagnostics ${hangs}`;
}

export function render(days: Map<string, Day>, zone: string): string {
  const out: string[] = [];
  for (const [key, day] of days) {
    const drain = nightDrain(day.power, zone);
    const checks = new Map([...day.counts].filter(([name]) => name.startsWith("location_checks_"))
      .map(([name, value]) => [name.replace("location_checks_", ""), value] as [string, number]));
    const noFreshFix = checks.get("no_fresh_fix");
    checks.delete("no_fresh_fix");
    const checkCount = [...checks.values()].reduce((sum, value) => sum + value, 0);
    const late = ["lt1s", "1to5s", "5to15s", "ge15s"].map((bucket) => `${bucket} ${day.counts.get(`location_check_late_${bucket}`) ?? 0}`);
    const pairLate = day.counts.get("location_check_pair_late_ge15s") ?? 0;
    const others = new Map([...day.counts].filter(([name]) => !name.startsWith("location_checks_") && !name.startsWith("location_check_")));
    out.push(
      `${key}  covered ${(day.coveredS / 3600).toFixed(1)} h  builds ${[...day.builds].sort().join(" ") || "-"}`,
      `  cpu ${day.cpuS.toFixed(0)} s  cpu energy ${day.joules.toFixed(0)} J  unclaimed ${day.cpuS > 0 ? ((100 * day.unclaimedCpuS) / day.cpuS).toFixed(0) : 0}%`,
      `  by part (J): ${top(day.parts, 6, "")}`,
      `  threads (cpu s): ${top(day.threads, 4, "")}`,
      `  location held (h): ${top(day.holdsH, 4, "", 1)}  location wakes ${day.locationWakes}`,
      `  checks: ${checkCount} (${top(checks, 6, "")})${noFreshFix ? `  of them: no_fresh_fix ${noFreshFix}` : ""}`
        + `  timers late: ${late.join(", ")}, pair ge15s ${pairLate}`,
      `  counts: ${[...others.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name} ${value}`).join(", ") || "-"}`,
      `  metrickit: ${day.metrickit ? `cpu ${day.metrickit.cpuS.toFixed(0)} s, writes ${day.metrickit.writesMB.toFixed(0)} MB, 10 m location ${day.metrickit.tenMetresH.toFixed(1)} h` : "-"}  diagnostics ${day.diagnostics}`,
      speedLine(day),
      `  phone overnight drain: ${drain === null ? "-" : `${drain.toFixed(2)} %/h`}`,
      "",
    );
  }
  return out.join("\n");
}

async function door(route: string): Promise<Obj> {
  const machine = process.env.LIFESTREAM_MACHINE_DIR ?? join(homedir(), "Library/Application Support/Lifestream");
  const token = process.env.LIFESTREAM_DOOR_TOKEN ?? readFileSync(join(machine, "reader-token"), "utf8").trim();
  const response = await fetch(`${process.env.LIFESTREAM_DOOR ?? "http://127.0.0.1:4680"}${route}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as Obj;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const days = Number(option("--days") ?? 7);
  let source = option("--source");
  if (!source) {
    const sources = arr((await door("/v1/sources?product=energy")).sources).map(obj)
      .filter((row) => String(row.id).startsWith("energy:local:"))
      .sort((a, b) => num(b.read_through_ms) - num(a.read_through_ms));
    source = sources[0] === undefined ? undefined : String(sources[0].id);
    if (!source) throw new Error("no energy:local source on this home");
  }
  const from = Date.now() - days * 86_400_000;
  const records: EnergyRecord[] = [];
  let after: string | undefined;
  do {
    const page = await door(`/v1/records?source=${encodeURIComponent(source)}&kind=energy&from_ms=${from}&limit=1024${after ? `&after=${after}` : ""}`);
    records.push(...(arr(page.records) as unknown as EnergyRecord[]));
    after = typeof page.next === "string" ? page.next : undefined;
  } while (after);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.stdout.write(render(summarize(records, zone), zone));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
