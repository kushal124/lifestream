import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync, type FSWatcher, type WriteStream } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import { civilDay, HOME_STORE, openHomeFolder, RELEASE, type DaySettings, type HomeFolder } from "@lifestreamprotocol/core";
import { dayPath } from "../packages/home/derive.js";
import { report as homeReport, size, spread, withDb, type Report, type Spread } from "../packages/home/report.js";
import { effective, change } from "../packages/home/settings.js";
import { HomeFile } from "../packages/home/home-file.js";
import { checkoutProgram, homeCommand, homeRegistryModule } from "../packages/home/programs.js";
import { homeOf, loadRegistry } from "../packages/home/registry.js";
import { readStatus, readStreams, withLedger } from "../packages/home/status.js";
import { homeSocket, slotFolder } from "../packages/home/lifecycle.js";
import { CREDENTIAL, draftRecovery } from "../packages/home/vault.js";
import { askHome } from "../packages/home/socket.js";
import { DEVICE, REPO } from "../packages/home/test/support.js";
import {
  ACCOUNT, CHROME_PROFILE, count, DAY_MS, Life, MAC_STREAMS, macDelivery, PHONE_DOMAINS, PHONE_STREAMS, phoneDelivery, SIZES, TAKEOUT_BAD, TAKEOUT_PRODUCTS,
  WHATSAPP_ACCOUNT, type MacStream, type Page, type PhoneContent, type PhoneStream, type Size, type Upload,
} from "./volume-life.js";

export type SizeName = keyof typeof SIZES;

export interface VolumeOptions {
  size: SizeName;
  seed: number;
  out: string;
  against?: string;
  keep?: boolean;
  helpers?: number | "auto";
  keyed?: boolean;
  at?: string;
  scale?: number;
  log?: (line: string) => void;
}

const DAY: DaySettings = { zone: "UTC", day_start_hour: 4 };
const REBUILD_HOUR = 5;
const MAC_MODEL = "MacBook Pro";
const MAC_SERIAL4 = "0001";
const MAC_UNIT = "macbook-pro-0001";
const REBUILT_FAMILY = "messages";
const WORSE = 0.25;


export interface VolumeRun {
  report: VolumeReport;
  json: string;
  md: string;
  root: string;
}

export interface VolumeReport {
  tool: { size: SizeName; helpers: number | "auto"; keyed: boolean; scale: number; seed: number; started: string; seconds: number; release: string; node: string; cpus: number; platform: string };
  life: { streams: Record<string, { history: number; full: number }>; deliveries: number; rows: number; bytes: number };
  scenarios: {
    first_day: FirstDay;
    live: { deliveries: number; imports: number; observed: number; sent_to_observed_seconds: Record<string, Spread | null> };
    reads: { requests: number; routes: Record<string, { requests: number; ms: Spread; refusals: Record<string, number> }> };
    rebuild: Rebuild;
    interrupted: Interrupted;
    takeout: Record<string, { state: string; rows: number; refusals: string[]; error: string | null }>;
    reports: ReportsCost;
  };
  log: { largest_seen_bytes: number };
  report: Report;
  worse?: Worse[];
}

interface ReportRead {
  open_ms: number;
  ms: number;
  statements: number;
  statements_ms: number;
  slowest: { sql: string; ms: number } | null;
}

interface ReportsCost {
  pending: { asks: number; wanted_files: number };
  cold: Record<"status" | "connectors", ReportRead> | null;
  warm: Record<"status" | "connectors", ReportRead>;
}

interface FirstDay {
  sources: Record<string, { live_rows: number; sent_seconds: number; imported_seconds: number | null; rendered_seconds: number | null }>;
  history_in_seconds: number;
  deliveries: number;
  rows: number;
  bytes: number;
  bytes_a_second: number;
  rows_a_second: number;
}

interface Rebuild {
  family: { name: string; seconds: number; extract_runs: number; statements: number };
  every_day: { seconds: number; days_rendered: number; render_runs: number };
}

interface Interrupted {
  rows: number;
  killed: boolean;
  seconds_before_kill: number;
  landed_before_kill: number;
  seconds_after_restart: number;
  new: number;
  duplicated: number;
  replay_share: number | null;
}

interface Worse {
  path: string;
  before: number;
  after: number;
  change: string;
}

type Shows = { day: string } & ({ messages: string[] } | { screen_ms: number });

interface Sent {
  products: string[];
  id: string;
  what: "live" | "history" | "tick" | "takeout" | "interrupted";
  rows: number;
  by: Record<string, number>;
  bytes: number;
  sent_ms: number;
  shows?: Record<string, Shows>;
}

export async function runVolume(options: VolumeOptions): Promise<VolumeRun> {
  const size = scaled(options.helpers === undefined ? SIZES[options.size] : { ...SIZES[options.size], helpers: options.helpers }, options.scale ?? 1);
  const log = options.log ?? (() => undefined);
  mkdirSync(options.out, { recursive: true });
  const started = Date.now();
  const scratch = await Scratch.make(options.out, size, { keyed: options.keyed === true, ...(options.at === undefined ? {} : { at: options.at }) });
  log(`scratch home ${scratch.root}`);
  let reads: Reads | undefined;
  try {
    await scratch.startDoor();
    await scratch.startHome();
    const devices = await pair(scratch);
    const life = new Life(size, options.seed, Date.now());
    const today = civilDay(life.end, DAY);
    reads = new Reads(scratch.url, devices.reader, [
      "/v1/status", `/v1/days?from=${civilDay(life.end - 7 * DAY_MS, DAY)}&to=${today}`, `/v1/days/${today}?file=json`,
      `/v1/extracts?family=messages&day=${today}`, `/v1/records?source=${encodeURIComponent(devices.mac.sources.whatsapp)}&kind=msg&limit=50`,
      "/v1/search?lists=record&query=synthetic", `/v1/where?from=${today}&to=${today}`, "/v1/sources",
    ]);
    const running = reads.run();
    log("first day");
    const first = await firstDay(scratch, life, devices, log);
    log("rebuild");
    const rebuild = await rebuildScenario(scratch, devices);
    log("interrupted import");
    const interrupted = await interruptedImport(scratch, life, devices, first.largest);
    log("sweep");
    await scratch.ask("sweep", []);
    await scratch.settled(devices);
    await reads.stop();
    await running;
    const takeout = scratch.read((db) => takeoutOf(db, devices.takeout));
    log("the reports' cost");
    const reports = await reportsCost(scratch);
    const report: VolumeReport = {
      tool: { size: options.size, helpers: size.helpers, keyed: options.keyed === true, scale: options.scale ?? 1, seed: options.seed, started: new Date(started).toISOString(), seconds: (Date.now() - started) / 1000, release: RELEASE, node: process.versions.node, cpus: availableParallelism(), platform: process.platform },
      life: {
        streams: Object.fromEntries(Object.entries(life.streams).map(([name, stream]) => [name, { history: stream.history, full: stream.full }])),
        deliveries: devices.sent.length, rows: devices.sent.reduce((sum, sent) => sum + sent.rows, 0), bytes: devices.sent.reduce((sum, sent) => sum + sent.bytes, 0),
      },
      scenarios: { first_day: first.result, live: first.live, reads: reads.result(), rebuild, interrupted, takeout, reports },
      log: { largest_seen_bytes: scratch.largestLog },
      report: await homeReport(scratch.folder, { from_ms: started, to_ms: Date.now(), door_log: scratch.doorLog, machine: scratch.machine }),
    };
    if (options.against !== undefined) report.worse = worseThan(JSON.parse(readFileSync(options.against, "utf8")) as VolumeReport, report);
    const json = join(options.out, "report.json"), md = join(options.out, "report.md");
    writeFileSync(json, `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(md, markdown(report));
    return { report, json, md, root: scratch.root };
  } finally {
    await reads?.stop();
    await scratch.close(options.keep === true);
  }
}


function scaled(size: Size, scale: number): Size {
  if (scale === 1) return size;
  const rates = (of: Size["full"]) => Object.fromEntries(Object.entries(of).map(([name, rate]) => [name, Math.round(rate * scale)])) as Size["full"];
  return { ...size, full: rates(size.full), light: rates(size.light) };
}


class Scratch {
  home: ChildProcess | null = null;
  door: ChildProcess | null = null;
  url = "";
  largestLog = 0;
  readonly #env: NodeJS.ProcessEnv;
  readonly #logs: WriteStream[] = [];
  #folder: HomeFolder | undefined;

  private constructor(readonly root: string, readonly machine: string, readonly out: string, readonly slot: Buffer | null) {
    this.#env = { ...process.env, LIFESTREAM_MACHINE_DIR: machine, ...(slot === null ? {} : { CREDENTIALS_DIRECTORY: join(machine, "credentials") }) };
  }

  get folder(): HomeFolder {
    return (this.#folder ??= this.slot === null ? openHomeFolder(this.root, { machine: this.machine, program: "home" }) : slotFolder(this.root, this.machine, "home", { key: this.slot, why: null }, Date.now()));
  }

  get doorLog(): string {
    return join(this.out, "door.log");
  }

  static async make(out: string, size: Size, form: { keyed: boolean; at?: string }): Promise<Scratch> {
    if (form.at !== undefined) mkdirSync(form.at, { recursive: true, mode: 0o700 });
    const root = form.at === undefined ? realpathSync(mkdtempSync(join(tmpdir(), "vol-"))) : join(realpathSync(form.at), "home");
    const machine = form.at === undefined ? mkdtempSync(join(tmpdir(), "vol-machine-")) : join(realpathSync(form.at), "machine");
    mkdirSync(machine, { recursive: true, mode: 0o700 });
    writeFileSync(join(machine, "machine.json"), JSON.stringify({ dnssd: join(machine, "no-dns-sd") }));
    const slot = form.keyed ? randomBytes(32) : null;
    if (slot !== null) {
      mkdirSync(join(machine, "credentials"), { mode: 0o700 });
      writeFileSync(join(machine, "credentials", CREDENTIAL), slot, { mode: 0o600 });
    }
    const scratch = new Scratch(root, machine, out, slot);
    for (const name of ["home.log", "door.log"]) rmSync(join(out, name), { force: true });
    if (slot === null) await scratch.#cli(["adopt", root]);
    else await scratch.#cli(["adopt", root, "--keyed"], JSON.stringify({ home_id: randomUUID(), slot_key: slot.toString("hex"), recovery: draftRecovery(Date.now()).recovery }));
    for (const [key, value] of [["day.zone", DAY.zone], ["day.day_start_hour", DAY.day_start_hour], ["helpers", size.helpers]] as const) {
      change(scratch.folder, key, value);
    }
    change(scratch.folder, "door.port", 0);
    change(scratch.folder, "door.lan_port", 0);
    return scratch;
  }

  async startHome(env: Record<string, string> = {}): Promise<void> {
    this.home = (await this.#spawn(["packages/home/cli.ts", "serve", "--root", this.root], "home.log", '"home":"started"', env)).child;
  }

  async stopHome(): Promise<void> {
    await stop(this.home);
    this.home = null;
  }

  async startDoor(): Promise<void> {
    const { child, line } = await this.#spawn(["packages/home/door-main.ts", "serve", "--root", this.root], "door.log", '"door":"open"');
    this.door = child;
    const { port } = JSON.parse(line!) as { port: number };
    change(this.folder, "door.port", port);
    this.url = `http://127.0.0.1:${port}`;
  }

  async ask(verb: string, args: string[]): Promise<{ result: unknown; lines: string[] }> {
    const lines: string[] = [];
    const result = await askHome(homeSocket(this.root, this.machine), verb, args, (line) => lines.push(line));
    return { result, lines };
  }

  read<T>(work: (db: Database.Database) => T): T {
    return withDb(this.folder, HOME_STORE, join(this.root, "home.db"), work);
  }

  async settled(devices: Devices): Promise<void> {
    const idle = () => this.read((db) =>
      (db.prepare("SELECT count(*) FROM jobs WHERE state = 'running' OR (state = 'queued' AND not_before_ms <= ?)").pluck().get(Date.now()) as number) === 0
      && (db.prepare("SELECT count(*) FROM deliveries WHERE state IN ('sealed', 'importing')").pluck().get() as number) === 0);
    for (;;) {
      this.largestLog = Math.max(this.largestLog, size(join(this.root, "home.db-wal")));
      if ((await devices.mac.caughtUp()) && (await devices.phone.caughtUp()) && idle()) return;
      await sleep(25);
    }
  }

  async close(keep: boolean): Promise<void> {
    await stop(this.home);
    await stop(this.door);
    for (const stream of this.#logs) await new Promise<void>((resolve) => stream.end(resolve));
    if (!keep) {
      rmSync(this.root, { recursive: true, force: true });
      rmSync(this.machine, { recursive: true, force: true });
    }
  }

  async #cli(args: string[], input?: string): Promise<void> {
    const [command, ...base] = homeCommand();
    const child = spawn(command!, [...base, ...args], { cwd: REPO, env: this.#env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (input !== undefined) child.stdin!.end(input);
    let output = "";
    child.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    child.stderr!.on("data", (chunk: Buffer) => { output += chunk.toString("utf8"); });
    const status = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    if (status !== 0) throw new Error(`home ${args.join(" ")} exited ${status}: ${output}`);
  }

  async #spawn(args: string[], log: string, ready: string, env: Record<string, string> = {}): Promise<{ child: ChildProcess; line: string | null }> {
    const file = createWriteStream(join(this.out, log), { flags: "a" });
    this.#logs.push(file);
    const [entry, ...rest] = args;
    const [command, ...base] = entry === "packages/home/cli.ts" ? homeCommand() : [process.execPath, ...checkoutProgram(join(REPO, entry!))];
    const child = spawn(command!, [...base, ...rest], { cwd: REPO, env: { ...this.#env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stderr!.pipe(file, { end: false });
    const line = await new Promise<string | null>((resolve) => {
      let pending = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        file.write(chunk);
        const lines = (pending + chunk.toString("utf8")).split("\n");
        pending = lines.pop()!;
        const found = lines.find((each) => each.includes(ready));
        if (found !== undefined) resolve(found);
      });
      child.once("exit", () => resolve(null));
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      if (env.LIFESTREAM_FAILPOINT === undefined) throw new Error(`${args[0]} exited (${child.exitCode ?? child.signalCode}) before it was ready: see ${join(this.out, log)}`);
    }
    return { child, line };
  }
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await exited;
}


interface Devices {
  mac: Device & { sources: Record<MacStream | "upload", string> };
  phone: Device & { sources: Record<PhoneStream, string> };
  reader: string;
  takeout: Record<string, string>;
  sent: Sent[];
}

class Device {
  readonly #seals = new Map<string, number>();
  readonly #queues = new Map<string, Promise<unknown>>();
  #fetched = 0;

  constructor(readonly url: string, readonly kind: "mac" | "phone", readonly pass: string, readonly unit: string, readonly sent: Sent[]) {}

  seal(source: string): number {
    const next = (this.#seals.get(source) ?? 0) + 1;
    this.#seals.set(source, next);
    return next;
  }

  fetched(): number {
    this.#fetched = Math.max(Date.now(), this.#fetched + 1);
    return this.#fetched;
  }

  send(queue: string, what: Sent["what"], products: string[], make: () => Upload): Promise<Sent> {
    const sending = (this.#queues.get(queue) ?? Promise.resolve()).then(async () => {
      const upload = make();
      const sent_ms = Date.now();
      const answer = await request(this.url, "PUT", upload.path, { authorization: `Bearer ${this.pass}`, ...DEVICE[this.kind] }, upload.bytes);
      if (answer.status !== 201 && answer.status !== 200) throw new Error(`${this.kind} PUT ${upload.path}: ${answer.status} ${JSON.stringify(answer.body)}`);
      const id = this.kind === "phone" ? `phone:${this.unit}/${upload.path.slice("/v1/bundles/".length)}` : decodeURIComponent(upload.path.slice("/v1/acquisitions/".length));
      const sent: Sent = { products, id, what, rows: upload.rows, by: upload.by, bytes: upload.bytes.length, sent_ms };
      this.sent.push(sent);
      return sent;
    });
    this.#queues.set(queue, sending.catch(() => undefined));
    return sending;
  }

  async custody(): Promise<Record<string, { received: number; imported: number }>> {
    const answer = await request(this.url, "POST", "/v1/exchange", { authorization: `Bearer ${this.pass}`, ...DEVICE[this.kind], "content-type": "application/json" }, "{}");
    if (answer.status !== 200) throw new Error(`${this.kind} exchange: ${answer.status} ${JSON.stringify(answer.body)}`);
    return answer.body.sources as Record<string, { received: number; imported: number }>;
  }

  async caughtUp(sources?: readonly string[]): Promise<boolean> {
    const held = await this.custody();
    return Object.entries(held).every(([source, { received, imported }]) => (sources !== undefined && !sources.includes(source)) || imported >= received);
  }

  async pace(sources: readonly string[]): Promise<void> {
    while (!(await this.caughtUp(sources))) await sleep(25);
  }
}

async function pair(scratch: Scratch): Promise<Devices> {
  const sent: Sent[] = [];
  const code = async () => ((await scratch.ask("pair", [])).result as { code: string }).code;
  const pass = () => randomBytes(32).toString("base64url");
  const offers = [`whatsapp:${WHATSAPP_ACCOUNT}:${MAC_UNIT}`, `imessage:${ACCOUNT}:${MAC_UNIT}`, `chrome:${CHROME_PROFILE}:${MAC_UNIT}`];
  const macPass = pass();
  const mac = await request(scratch.url, "POST", "/v1/pair", { ...DEVICE.mac, "content-type": "application/json" },
    JSON.stringify({ code: await code(), pass: macPass, kind: "mac", model: MAC_MODEL, serial4: MAC_SERIAL4, offers }));
  const phonePass = pass();
  const phone = await request(scratch.url, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" },
    JSON.stringify({ code: await code(), pass: phonePass, kind: "phone", model: "iPhone 17 Pro", account: ACCOUNT, new: true }));
  if (mac.status !== 200 || phone.status !== 200) throw new Error(`pairing: mac ${mac.status} ${JSON.stringify(mac.body)}, phone ${phone.status} ${JSON.stringify(phone.body)}`);
  const sourcesOf = (body: Record<string, unknown>) => Object.keys((body.answer as { sources: object }).sources);
  const product = (ids: string[], name: string) => ids.find((id) => id.split(":")[0] === name) ?? fail(`pairing made no ${name} source: ${ids.join(", ")}`);
  const macDevice = new Device(scratch.url, "mac", macPass, mac.body.unit as string, sent);
  await scratch.ask("setup", ["skip", macDevice.unit, "found"]);
  const macIds = Object.keys(await macDevice.custody()), phoneIds = sourcesOf(phone.body);
  const phoneUnit = phone.body.unit as string;
  const minted = await scratch.ask("principals", ["mint", "--unit", "volume-reader", "--scope", "read"]);
  const reader = /: (\S+)$/u.exec(minted.lines.find((line) => line.startsWith("token for")) ?? "")?.[1] ?? fail("principals mint printed no token");
  const takeout: Record<string, string> = {};
  for (const name of TAKEOUT_PRODUCTS) {
    takeout[name] = `${name}:${ACCOUNT}:export`;
    await scratch.ask("source", ["add", takeout[name], "--connector", "google-my-activity", "--options", JSON.stringify({ lane: `upload:local:${MAC_UNIT}` })]);
  }
  return {
    mac: Object.assign(macDevice, {
      sources: Object.fromEntries([...MAC_STREAMS, "upload" as const].map((name) => [name, product(macIds, name)])) as Record<MacStream | "upload", string>,
    }),
    phone: Object.assign(new Device(scratch.url, "phone", phonePass, phoneUnit, sent), {
      sources: Object.fromEntries(PHONE_STREAMS.map((name) => [name, product(phoneIds, name)])) as Record<PhoneStream, string>,
    }),
    reader, takeout, sent,
  };
}


async function firstDay(scratch: Scratch, life: Life, devices: Devices, log: (line: string) => void) {
  const { mac, phone } = devices;
  const start = Date.now();
  const firsts = new Map<string, Sent>();
  let largest = 0;
  const keepFirst = (sent: Sent) => {
    for (const name of sent.products) if (!firsts.has(name)) firsts.set(name, sent);
    if (sent.what === "history") largest = Math.max(largest, sent.rows);
    return sent;
  };
  const macSync = async (stream: MacStream) => {
    const source = mac.sources[stream];
    for (const page of life.pages([stream])) {
      const ordinals = life.streams[stream].within(page.from_ms, page.to_ms);
      if (ordinals === null) continue;
      if (page.history) await mac.pace([source]);
      keepFirst(await mac.send(source, page.history ? "history" : "live", [stream], () =>
        macDelivery(life, source, { stream, ordinals, history: page.history }, mac.seal(source), mac.fetched())));
    }
  };
  const phoneSync = async () => {
    for (const page of life.pages(PHONE_STREAMS)) {
      const content = phoneContent(life, page);
      if (Object.keys(content).length === 0) continue;
      if (page.history) await phone.pace(Object.keys(content).map((name) => phone.sources[name as PhoneStream]));
      keepFirst(await phone.send("phone", page.history ? "history" : "live", Object.keys(content), () => phoneDelivery(life, content, phoneSeals(phone, content), Date.now())));
    }
  };
  const takeout = mac.send(mac.sources.upload, "takeout", [...TAKEOUT_PRODUCTS], () => macDelivery(life, mac.sources.upload, { takeout: true }, mac.seal(mac.sources.upload), mac.fetched()));
  const watch = new DayWatch(scratch.root);
  let history_in_ms: number;
  try {
    await Promise.all([...MAC_STREAMS.map(macSync), phoneSync(), takeout, liveTicks(life, devices)]);
    history_in_ms = Date.now();
    await scratch.settled(devices);
    log(`first day settled: ${devices.sent.length} deliveries`);
  } finally {
    watch.stop();
  }
  const today = civilDay(life.end, DAY);
  const sources: FirstDay["sources"] = {};
  const timed = new Timing(scratch.folder.store(HOME_STORE, join(scratch.root, "home.db"), { mode: "read", mustExist: true, timeout: 5_000 }));
  for (const [name, sent] of firsts) {
    if (sent.what === "takeout") continue;
    const times = timed.of(sent, name, devices, today);
    const phoned = (PHONE_STREAMS as readonly string[]).includes(name);
    sources[name] = {
      live_rows: sent.by[name] ?? sent.rows, sent_seconds: (sent.sent_ms - start) / 1000,
      imported_seconds: times.imported_ms === null ? null : (times.imported_ms - start) / 1000,
      rendered_seconds: phoned || times.rendered_ms === null ? null : (times.rendered_ms - start) / 1000,
    };
  }
  const first = devices.sent.filter((sent) => sent.what !== "tick");
  const rows = first.reduce((sum, sent) => sum + sent.rows, 0), bytes = first.reduce((sum, sent) => sum + sent.bytes, 0);
  const imported = Math.max(history_in_ms, ...first.flatMap((sent) => sent.products.map((name) => timed.of(sent, name, devices, today).imported_ms ?? 0)));
  const seconds = (imported - start) / 1000;
  const ticks = devices.sent.filter((sent) => sent.what === "tick");
  const waits: Record<string, number[]> = {};
  let shown = 0, imports = 0;
  for (const sent of ticks) {
    for (const name of sent.products.filter((product) => sent.shows?.[product] !== undefined)) {
      imports++;
      const shown_ms = watch.shown(sent, name, { written: (day, inputs) => timed.written(day, inputs) });
      if (shown_ms === null) continue;
      shown++;
      (waits[name] ??= []).push((shown_ms - sent.sent_ms) / 1000);
    }
  }
  timed.close();
  return {
    largest,
    result: { sources, history_in_seconds: seconds, deliveries: first.length, rows, bytes, bytes_a_second: bytes / seconds, rows_a_second: rows / seconds } satisfies FirstDay,
    live: {
      deliveries: ticks.length, imports, observed: shown,
      sent_to_observed_seconds: Object.fromEntries(Object.entries(waits).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, values]) => [name, spread(values)])),
    },
  };
}

async function liveTicks(life: Life, devices: Devices): Promise<void> {
  const { mac, phone } = devices;
  const { rounds, every_ms } = life.size.live;
  for (let round = 0; round < rounds; round++) {
    await sleep(every_ms);
    const now = Date.now();
    const at = (n: number, step: number) => Array.from({ length: n }, (_, i) => now - (n - 1 - i) * step);
    const sends: Promise<Sent>[] = [];
    for (const [stream, times] of [["whatsapp", at(3, 1_000)], ["screen", at(12, 5_000)]] as const) {
      const source = mac.sources[stream];
      const ordinals = life.streams[stream].append([...times]);
      const shows: Shows = { day: civilDay(now, DAY), ...(stream === "whatsapp"
        ? { messages: Array.from({ length: count(ordinals) }, (_, i) => `SYNTH-${life.seed}-${ordinals[0] + i}`) } : { screen_ms: times.at(-1)! }) };
      sends.push(mac.send(source, "tick", [stream], () => macDelivery(life, source, { stream, ordinals, history: false }, mac.seal(source), mac.fetched()))
        .then((sent) => Object.assign(sent, { shows: { [stream]: shows } })));
    }
    const content: PhoneContent = { location: life.streams.location.append(at(6, 10_000)), "apple-health": life.streams["apple-health"].append(at(30, 2_000)) };
    sends.push(phone.send("phone", "tick", Object.keys(content), () => phoneDelivery(life, content, phoneSeals(phone, content), Date.now())));
    await Promise.all(sends);
  }
}

function phoneContent(life: Life, page: Page): PhoneContent {
  const content: PhoneContent = {};
  for (const name of PHONE_STREAMS) {
    const range = life.streams[name].within(page.from_ms, page.to_ms);
    if (count(range) > 0) content[name] = range!;
  }
  return content;
}

function phoneSeals(phone: Devices["phone"], content: PhoneContent): Record<string, number> {
  return Object.fromEntries(Object.keys(content).map((name) => [phone.sources[name as PhoneStream], phone.seal(phone.sources[name as PhoneStream])]));
}

class Timing {
  readonly #db: Database.Database;
  readonly #delivery: Database.Statement;
  readonly #run: Database.Statement;
  readonly #rendered: Database.Statement;
  readonly #written: Database.Statement;

  constructor(db: Database.Database) {
    this.#db = db;
    this.#delivery = db.prepare("SELECT run, state FROM deliveries WHERE id = ? AND source = ?");
    this.#run = db.prepare("SELECT ended_ms FROM runs WHERE id = ? AND outcome = 'ok'").pluck();
    this.#rendered = db.prepare("SELECT at_ms FROM events WHERE at_ms >= ? AND kind = 'day' AND key = ? ORDER BY at_ms LIMIT 1").pluck();
    this.#written = db.prepare("SELECT min(at_ms) FROM events WHERE kind = 'day' AND key = ? AND json_extract(detail, '$.inputs') = ?").pluck();
  }

  of(sent: Sent, name: string, devices: Devices, day: string): { imported_ms: number | null; rendered_ms: number | null } {
    const source = sourceOf(devices, name);
    const row = this.#delivery.get(sent.id, source) as { run: number | null; state: string } | undefined;
    const imported_ms = row?.run == null ? null : ((this.#run.get(row.run) as number | undefined) ?? null);
    const rendered_ms = imported_ms === null ? null : ((this.#rendered.get(imported_ms, day) as number | undefined) ?? null);
    return { imported_ms, rendered_ms };
  }

  written(day: string, inputs: string): number | null {
    return (this.#written.get(day, inputs) as number | null | undefined) ?? null;
  }

  close(): void {
    this.#db.close();
  }
}

function sourceOf(devices: Devices, name: string): string {
  return (devices.mac.sources as Record<string, string>)[name] ?? (devices.phone.sources as Record<string, string>)[name] ?? devices.takeout[name] ?? fail(`no source for ${name}`);
}

interface DaySeen {
  day: string;
  inputs: string;
  messages: Set<string>;
  screen_ms: number;
}

export interface Recorded {
  written(day: string, inputs: string): number | null;
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.day\.json$/u;

export class DayWatch {
  readonly #seen: DaySeen[] = [];
  readonly #versions = new Set<string>();
  readonly #days = new Set<string>();
  #home: FSWatcher | null = null;
  #folder: FSWatcher | null = null;

  constructor(readonly root: string) {
    this.#home = watch(root, (_, name) => { if (name === "days") this.#attach(); });
    this.#home.on("error", () => undefined);
    this.#attach();
  }

  #attach(): void {
    if (this.#folder !== null) return;
    try {
      this.#folder = watch(join(this.root, "days"), (_, name) => {
        if (name === null) return this.#look();
        const day = DAY_FILE.exec(name)?.[1];
        if (day !== undefined) this.#day(day);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    this.#folder.on("error", () => undefined);
    this.#home?.close();
    this.#home = null;
    this.#look();
  }

  #look(): void {
    for (const day of new Set([civilDay(Date.now() - DAY_MS, DAY), civilDay(Date.now(), DAY), ...this.#days])) this.#day(day);
  }

  #day(day: string): void {
    let document: { inputs: string; atoms: { family: string; end_ms: number | null; record?: { key: string } }[] };
    try {
      document = JSON.parse(readFileSync(dayPath(this.root, day, "json"), "utf8"));
    } catch {
      return;
    }
    this.#days.add(day);
    const version = `${day} ${document.inputs}`;
    if (this.#versions.has(version)) return;
    this.#versions.add(version);
    const messages = new Set<string>();
    let screen_ms = 0;
    for (const atom of document.atoms) {
      if (atom.record !== undefined) messages.add(atom.record.key.slice(atom.record.key.lastIndexOf(":") + 1));
      if (atom.family === "screen" && atom.end_ms !== null) screen_ms = Math.max(screen_ms, atom.end_ms);
    }
    this.#seen.push({ day, inputs: document.inputs, messages, screen_ms });
  }

  shown(sent: Sent, name: string, recorded: Recorded): number | null {
    const shows = sent.shows?.[name];
    if (shows === undefined) return null;
    const holds = (seen: DaySeen) => "messages" in shows ? shows.messages.every((key) => seen.messages.has(key)) : seen.screen_ms >= shows.screen_ms;
    const after = this.#seen.filter((seen) => seen.day === shows.day && holds(seen))
      .map((seen) => recorded.written(seen.day, seen.inputs)).filter((at_ms): at_ms is number => at_ms !== null && at_ms >= sent.sent_ms);
    return after.length > 0 ? Math.min(...after) : null;
  }

  stop(): void {
    this.#home?.close();
    this.#folder?.close();
    this.#home = this.#folder = null;
    this.#look();
  }
}


class Reads {
  #stopped = false;
  readonly #ms = new Map<string, number[]>();
  readonly #refusals = new Map<string, Record<string, number>>();

  constructor(readonly url: string, readonly token: string, readonly routes: string[]) {}

  async run(): Promise<void> {
    for (let at = 0; !this.#stopped; at++) {
      const route = this.routes[at % this.routes.length]!;
      const name = `GET ${route.split("?")[0]!.replace(/^\/v1\/days\/.+$/u, "/v1/days/*")}`;
      const began = performance.now();
      let status: number;
      try {
        const response = await fetch(`${this.url}${route}`, { headers: { authorization: `Bearer ${this.token}` } });
        await response.arrayBuffer();
        status = response.status;
      } catch {
        status = 0;
      }
      (this.#ms.get(name) ?? this.#ms.set(name, []).get(name)!).push(performance.now() - began);
      if (status >= 400 || status === 0) {
        const refusals = this.#refusals.get(name) ?? {};
        refusals[String(status)] = (refusals[String(status)] ?? 0) + 1;
        this.#refusals.set(name, refusals);
      }
      await sleep(100);
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
  }

  result(): VolumeReport["scenarios"]["reads"] {
    const routes = Object.fromEntries([...this.#ms].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, ms]) => [name, { requests: ms.length, ms: spread(ms, true)!, refusals: this.#refusals.get(name) ?? {} }]));
    return { requests: [...this.#ms.values()].reduce((sum, ms) => sum + ms.length, 0), routes };
  }
}


async function rebuildScenario(scratch: Scratch, devices: Devices): Promise<Rebuild> {
  const runsSince = (kind: string, subject: string | null, since: number) => scratch.read((db) =>
    db.prepare(`SELECT counts FROM runs WHERE kind = ? AND (? IS NULL OR subject = ?) AND started_ms >= ?`).pluck().all(kind, subject, subject, since) as string[])
    .map((counts) => JSON.parse(counts) as Record<string, number>);
  const family = Date.now();
  await scratch.ask("rebuild", ["extracts", "--family", REBUILT_FAMILY]);
  await scratch.settled(devices);
  const familyRuns = runsSince("extract", REBUILT_FAMILY, family);
  const familySeconds = (Date.now() - family) / 1000;
  const days = Date.now();
  await scratch.ask("settings", ["set", "day.day_start_hour", String(REBUILD_HOUR)]);
  await scratch.stopHome();
  await scratch.startHome();
  await scratch.settled(devices);
  const renders = runsSince("render", null, days);
  return {
    family: { name: REBUILT_FAMILY, seconds: familySeconds, extract_runs: familyRuns.length, statements: familyRuns.reduce((sum, counts) => sum + (counts.statements ?? 0), 0) },
    every_day: { seconds: (Date.now() - days) / 1000, days_rendered: renders.reduce((sum, counts) => sum + (counts.days ?? 0), 0), render_runs: renders.length },
  };
}


async function interruptedImport(scratch: Scratch, life: Life, devices: Devices, largest: number): Promise<Interrupted> {
  const { mac } = devices;
  const source = mac.sources.whatsapp;
  const rows = Math.max(1, largest);
  await scratch.stopHome();
  const times = Array.from({ length: rows }, (_, i) => life.history_start - 365 * DAY_MS + Math.floor((i * DAY_MS) / rows));
  const ordinals = life.streams.whatsapp.append(times);
  const sent = await mac.send(source, "interrupted", ["whatsapp"], () => macDelivery(life, source, { stream: "whatsapp", ordinals, history: true }, mac.seal(source), mac.fetched()));
  const imported = () => scratch.read((db) => db.prepare("SELECT state FROM deliveries WHERE id = ? AND source = ?").pluck().get(sent.id, source)) === "imported";
  const started = Date.now();
  await scratch.startHome({ LIFESTREAM_FAILPOINT: "home.slice" });
  const home = scratch.home!;
  const exited = new Promise((resolve) => (home.exitCode !== null || home.signalCode !== null ? resolve(undefined) : home.once("exit", resolve)));
  for (let done = false; !done;) done = await Promise.race([exited.then(() => true), sleep(200).then(() => existsSync(join(scratch.root, "home.db")) && imported())]);
  const killed = home.signalCode === "SIGKILL";
  await scratch.stopHome();
  const before = Date.now();
  const landed = scratch.read((db) => {
    const progress = db.prepare("SELECT progress FROM jobs WHERE kind = 'import' AND key = ?").pluck().get(source) as string | null | undefined;
    const counts = progress == null ? {} : ((JSON.parse(progress) as { counts?: Record<string, unknown> }).counts ?? {});
    return Object.values(counts).reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  });
  const restarted = Date.now();
  await scratch.startHome();
  await scratch.settled(devices);
  const run = scratch.read((db) => {
    const delivery = db.prepare("SELECT run FROM deliveries WHERE id = ? AND source = ?").get(sent.id, source) as { run: number | null } | undefined;
    return delivery?.run == null ? undefined : (db.prepare("SELECT ended_ms, counts FROM runs WHERE id = ?").get(delivery.run) as { ended_ms: number; counts: string });
  }) ?? fail(`the interrupted page ${sent.id} was not imported`);
  const counts = JSON.parse(run.counts) as Record<string, number>;
  const landedRows = Object.entries(counts).reduce((sum, [name, n]) => sum + (name !== "duplicated" && typeof n === "number" ? n : 0), 0);
  return {
    rows, killed, seconds_before_kill: (before - started) / 1000, landed_before_kill: landed, seconds_after_restart: (run.ended_ms - restarted) / 1000,
    new: counts.new ?? 0, duplicated: counts.duplicated ?? 0, replay_share: landedRows === 0 ? null : (counts.duplicated ?? 0) / landedRows,
  };
}


function takeoutOf(db: Database.Database, sources: Record<string, string>): VolumeReport["scenarios"]["takeout"] {
  const out: VolumeReport["scenarios"]["takeout"] = {};
  for (const [name, source] of Object.entries(sources)) {
    const row = db.prepare("SELECT state, error, run FROM deliveries WHERE source = ? ORDER BY sealed_ms DESC LIMIT 1").get(source) as { state: string; error: string | null; run: number | null } | undefined;
    const run = row?.run == null ? undefined : (db.prepare("SELECT counts FROM runs WHERE id = ?").pluck().get(row.run) as string | null);
    const counts = run == null ? {} : (JSON.parse(run) as { new?: number; refusals?: unknown });
    const refusals = Array.isArray(counts.refusals) ? counts.refusals.map((refusal) => JSON.stringify(refusal)) : [];
    out[name] = { state: row?.state ?? "none", rows: counts.new ?? 0, refusals, error: row?.error ?? null };
  }
  return out;
}

async function reportsCost(scratch: Scratch): Promise<ReportsCost> {
  const { root, folder } = scratch;
  const settings = effective(folder).settings;
  const registry = await loadRegistry(homeRegistryModule().href, settings, homeOf(folder));
  const pending = scratch.read((db) => ({
    asks: db.prepare("SELECT count(*) FROM asks WHERE state = 'pending'").pluck().get() as number,
    wanted_files: db.prepare("SELECT count(DISTINCT blob) FROM wanted_blobs").pluck().get() as number,
  }));
  const files = ["home.db", "home.db-wal", join("replies", "replies.db"), join("replies", "replies.db-wal")].map((file) => join(root, file)).filter((file) => existsSync(file));
  const status = () => timedRead(folder, (db) => withLedger(folder, (ledger) => readStatus(db, {
    folder, now_ms: Date.now(), settings, connectors: registry.connectors, families: registry.families, ledger, door: null, stated: null, refused: [],
  })));
  const connectors = () => timedRead(folder, (db) => withLedger(folder, (ledger) => readStreams(db, {
    folder, now_ms: Date.now(), settings, registry, ledger, machine: scratch.machine, sites: null, present: [], refused: [], stated: null,
  })));
  const cold = dropCache(files) ? { status: status(), connectors: dropCache(files) ? connectors() : fail("the file cache could not be dropped again") } : null;
  return { pending, cold, warm: { status: status(), connectors: connectors() } };
}

function dropCache(files: readonly string[]): boolean {
  if (process.platform !== "linux") return false;
  const program = "import os, sys\nfor path in sys.argv[1:]:\n    fd = os.open(path, os.O_RDONLY)\n    os.fsync(fd)\n    os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)\n    os.close(fd)\n";
  const ran = spawnSync("python3", ["-I", "-c", program, ...files], { stdio: "inherit" });
  return ran.status === 0;
}

function timedRead(folder: HomeFolder, read: (db: Database.Database) => unknown): ReportRead {
  const probe = new Database(":memory:");
  const statement = Object.getPrototypeOf(probe.prepare("SELECT 1")) as Record<string, (...args: unknown[]) => unknown>;
  probe.close();
  const ran: { sql: string; ms: number }[] = [];
  const originals = Object.fromEntries(["get", "all", "run", "iterate"].map((name) => [name, statement[name]!]));
  for (const [name, original] of Object.entries(originals)) {
    statement[name] = function (this: { source: string }, ...args: unknown[]) {
      const started = performance.now();
      const result = original.apply(this, args);
      if (name !== "iterate") {
        ran.push({ sql: this.source, ms: performance.now() - started });
        return result;
      }
      const each = { sql: this.source, ms: performance.now() - started };
      ran.push(each);
      const steps = result as IterableIterator<unknown>;
      return {
        [Symbol.iterator]() { return this; },
        next() {
          const at = performance.now();
          const step = steps.next();
          each.ms += performance.now() - at;
          return step;
        },
        return(value?: unknown) { return steps.return?.(value) ?? { done: true, value }; },
      };
    };
  }
  const started = performance.now();
  let opened = 0;
  try {
    new HomeFile(folder, 5_000).read((db) => {
      opened = performance.now();
      return read(db);
    });
  } finally {
    Object.assign(statement, originals);
  }
  const ms = performance.now() - started;
  const slowest = ran.reduce<{ sql: string; ms: number } | null>((worst, each) => (worst === null || each.ms > worst.ms ? each : worst), null);
  return {
    open_ms: opened - started, ms, statements: ran.length, statements_ms: ran.reduce((sum, each) => sum + each.ms, 0),
    slowest: slowest === null ? null : { sql: slowest.sql.replace(/\s+/gu, " ").trim(), ms: slowest.ms },
  };
}

export function namesBadFile(entry: { refusals: string[]; error: string | null }): boolean {
  return entry.refusals.some((refusal) => refusal.includes(TAKEOUT_BAD)) || (entry.error ?? "").includes(TAKEOUT_BAD);
}


export function worseThan(before: VolumeReport, after: VolumeReport): Worse[] {
  const old = new Map(leaves(before));
  const out: Worse[] = [];
  for (const [path, value] of leaves(after)) {
    const was = old.get(path);
    const direction = directionOf(path);
    if (was === undefined || direction === null || was === 0) continue;
    const ratio = value / was;
    if ((direction === "lower" && ratio >= 1 + WORSE) || (direction === "higher" && ratio <= 1 - WORSE)) {
      out.push({ path, before: was, after: value, change: `${ratio >= 1 ? "+" : ""}${Math.round((ratio - 1) * 100)}%` });
    }
  }
  return out;
}

function directionOf(path: string): "lower" | "higher" | null {
  if (/^report\.disk\.(free_bytes|days_left)$/u.test(path)) return "higher";
  if (/^report\.disk\.bytes\.(home\.db(?:-wal)?|replies\.db|search)$/u.test(path)) return "lower";
  if (/^report\.imports\.[^.]+\.rows_a_second$/u.test(path)
    || /^report\.families\.by_family\.[^.]+\.(extract\.statements_a_second|plan\.units_a_second)$/u.test(path)
    || path === "report.families.render.days_a_second"
    || /^scenarios\.first_day\.(rows|bytes)_a_second$/u.test(path)) return "higher";
  if (/^report\.(imports\.[^.]+\.(busy_seconds|seal_to_import_seconds\.(p50|p90|max))|live\.[^.]+\.import_to_render_seconds\.(p50|p90|max))$/u.test(path)
    || /^report\.families\.(by_family\.[^.]+\.(extract|plan)\.(busy_seconds|ms_a_unit)|(render|search)\.busy_seconds)$/u.test(path)
    || /^(report|scenarios)\.reads\.routes\..+\.ms\.(p50|p90|p99|max)$/u.test(path)
    || /^report\.log\.(wal_bytes|largest_bytes|drained_ms|longest_drain_ms|held_ms|longest_hold_ms)$/u.test(path)
    || path === "report.sweep.seconds" || path === "log.largest_seen_bytes"
    || /^scenarios\.first_day\.(history_in_seconds|sources\.[^.]+\.(sent|imported|rendered)_seconds)$/u.test(path)
    || /^scenarios\.live\.sent_to_observed_seconds\.[^.]+\.(p50|p90|max)$/u.test(path)
    || /^scenarios\.rebuild\.(family|every_day)\.seconds$/u.test(path)
    || /^scenarios\.reports\.(cold|warm)\.(status|connectors)\.(open_ms|ms|statements|statements_ms|slowest\.ms)$/u.test(path)
    || /^scenarios\.interrupted\.(seconds_before_kill|seconds_after_restart|replay_share)$/u.test(path)) return "lower";
  return null;
}

function leaves(value: unknown, path = ""): [string, number][] {
  if (typeof value === "number") return [[path, value]];
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, inner]) => leaves(inner, path === "" ? key : `${path}.${key}`));
}

function markdown(report: VolumeReport): string {
  const lines: string[] = [];
  const s = (value: number | null | undefined, digits = 2) => (value === null || value === undefined ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(digits));
  const at = (spread: Spread | null | undefined) => (spread == null ? "–" : `${s(spread.p50)} / ${s(spread.p90)}${spread.p99 === undefined ? "" : ` / ${s(spread.p99)}`} / ${s(spread.max)}`);
  const { tool, life, scenarios, report: home } = report;
  lines.push(`# Volume report: ${tool.size}`, "", `Seed ${tool.seed}, started ${tool.started}, ${s(tool.seconds, 1)} s; release ${tool.release}, Node ${tool.node}, ${tool.cpus} cores, ${tool.platform}.`, "");
  if (report.worse !== undefined) {
    lines.push("## A quarter worse or more", "");
    if (report.worse.length === 0) lines.push("Nothing.", "");
    else lines.push("| Number | Before | Now | Change |", "|---|---|---|---|", ...report.worse.map((worse) => `| \`${worse.path}\` | ${s(worse.before)} | ${s(worse.after)} | ${worse.change} |`), "");
  }
  lines.push("## The life", "", `${life.deliveries} deliveries, ${life.rows} rows, ${(life.bytes / 1024 / 1024).toFixed(1)} MiB.`, "",
    "| Stream | History items | Full-rate items |", "|---|---|---|",
    ...Object.entries(life.streams).map(([name, stream]) => `| ${name} | ${stream.history} | ${stream.full} |`), "");
  const first = scenarios.first_day;
  lines.push("## First day", "", `All history in after ${s(first.history_in_seconds, 1)} s: ${first.deliveries} deliveries, ${first.rows} rows, ${s(first.rows_a_second, 0)} rows/s, ${(first.bytes_a_second / 1024 / 1024).toFixed(2)} MiB/s.`, "",
    "| Source | Live rows | Sent (s) | Imported (s) | Day rendered after import (s) |", "|---|---|---|---|---|",
    ...Object.entries(first.sources).map(([name, row]) => `| ${name} | ${row.live_rows} | ${s(row.sent_seconds)} | ${s(row.imported_seconds)} | ${s(row.rendered_seconds)} |`), "");
  lines.push("## Live under load", "", `${scenarios.live.deliveries} live deliveries; of their ${scenarios.live.imports} imports of messages and the screen, ${scenarios.live.observed} observed on their day's file (a phone stream's import is timed under Imports). Seconds from sent to observed, p50 / p90 / max:`, "",
    "| Source | Seconds |", "|---|---|", ...Object.entries(scenarios.live.sent_to_observed_seconds).map(([name, spread]) => `| ${name} | ${at(spread)} |`), "");
  lines.push("## Reads under load", "", `${scenarios.reads.requests} requests. Milliseconds, p50 / p90 / p99 / max:`, "", "| Route | Requests | ms | Refused |", "|---|---|---|---|",
    ...Object.entries(scenarios.reads.routes).map(([name, route]) => `| ${name} | ${route.requests} | ${at(route.ms)} | ${Object.entries(route.refusals).map(([code, n]) => `${code}: ${n}`).join(", ") || "–"} |`), "");
  const { family, every_day } = scenarios.rebuild;
  lines.push("## A rebuild", "", `The ${family.name} family rebuilt in ${s(family.seconds, 1)} s (${family.extract_runs} extract runs, ${family.statements} statements). Every day rendered again, with every family rebuilt, in ${s(every_day.seconds, 1)} s (${every_day.days_rendered} days in ${every_day.render_runs} render runs).`, "");
  const cut = scenarios.interrupted;
  lines.push("## Interrupted import", "", `A page of ${cut.rows} messages; the home ${cut.killed ? "died at its first slice" : "was not killed (the page imported in one go)"} with ${cut.landed_before_kill} rows landed after ${s(cut.seconds_before_kill)} s. Started again, the import ended ${s(cut.seconds_after_restart)} s later: ${cut.new} new, ${cut.duplicated} duplicated (the replay, ${cut.replay_share === null ? "–" : `${Math.round(cut.replay_share * 100)}%`} of the page).`, "");
  const { reports } = scenarios;
  const cost = (name: string, read: ReportRead) => `| ${name} | ${read.statements} | ${s(read.statements_ms, 1)} | ${s(read.ms, 1)} | ${s(read.open_ms, 1)} | ${read.slowest === null ? "–" : `${s(read.slowest.ms, 1)}: \`${read.slowest.sql.slice(0, 120)}\``} |`;
  lines.push("## The reports' cost", "", `Pending: ${reports.pending.asks} asks, ${reports.pending.wanted_files} distinct wanted files. Read as the door's reader reads them; milliseconds.`, "",
    "| Report | Statements | Their ms | ms | Open ms | Slowest |", "|---|---|---|---|---|---|",
    ...reports.cold === null ? ["| cold | not measured: no way to drop a file from the cache here | | | | |"] : [cost("status, cold", reports.cold.status), cost("connectors, cold", reports.cold.connectors)],
    cost("status, warm", reports.warm.status), cost("connectors, warm", reports.warm.connectors), "");
  lines.push("## The Takeout", "", "| Product | State | Rows | Bad file named |", "|---|---|---|---|",
    ...Object.entries(scenarios.takeout).map(([name, row]) => `| ${name} | ${row.state} | ${row.rows} | ${namesBadFile(row) ? "yes" : "no"} |`), "");
  lines.push("## lifestream report", "", `The window ${new Date(home.window.from_ms).toISOString()} to ${new Date(home.window.to_ms).toISOString()}.`, "",
    "| Product | Deliveries | Failed | Rows | Rows/s | Seal to import (s), p50 / p90 / max | Import to render (s) | Shown |", "|---|---|---|---|---|---|---|---|",
    ...Object.entries(home.imports).map(([name, row]) => {
      const live = home.live[name];
      return `| ${name} | ${row.deliveries} | ${row.failed} | ${Object.values(row.rows).reduce((sum, n) => sum + n, 0)} | ${s(row.rows_a_second, 0)} | ${at(row.seal_to_import_seconds)} | ${at(live?.import_to_render_seconds)} | ${live === undefined ? "–" : `${live.shown}/${live.imports}`} |`;
    }), "",
    "| Family | Extract runs | Statements/s | ms a unit | Plan runs | Units/s |", "|---|---|---|---|---|---|",
    ...Object.entries(home.families.by_family).map(([name, row]) => `| ${name} | ${row.extract?.runs ?? 0} | ${s(row.extract?.statements_a_second, 0)} | ${s(row.extract?.ms_a_unit)} | ${row.plan?.runs ?? 0} | ${s(row.plan?.units_a_second, 0)} |`), "",
    `Render: ${home.families.render.runs} runs, ${home.families.render.days} days, ${s(home.families.render.days_a_second)} days/s. Search: ${home.families.search.runs} runs.`, "",
    "| Door route | Requests | ms, p50 / p90 / p99 / max | Refused |", "|---|---|---|---|",
    ...Object.entries(home.reads.routes).map(([name, route]) => `| ${name} | ${route.requests} | ${at(route.ms)} | ${Object.entries(route.refusals).map(([code, n]) => `${code}: ${n}`).join(", ") || "–"} |`), "",
    `Write-ahead log: ${mib(home.log.wal_bytes)} now, ${mib(Math.max(home.log.largest_bytes, report.log.largest_seen_bytes))} the largest seen; ${home.log.drains} drains (${home.log.emptied} emptied it, ${home.log.outlasted} outlasted by a job, ${home.log.outside} held from outside), holding job starts ${s(home.log.drained_ms / 1000)} s in all, the longest ${s(home.log.longest_drain_ms / 1000)} s; behind ${home.log.behind} times, its need standing ${s(home.log.behind_ms / 1000)} s.`, "",
    `Disk: ${mib(home.disk.free_bytes)} free, ${home.disk.days_left === null ? "no days-left estimate" : `${home.disk.days_left} days left`}; ${Object.entries(home.disk.bytes).map(([name, bytes]) => `${name} ${mib(bytes)}`).join(", ")}.`, "",
    `Health: ${home.health.starts} starts; dead jobs ${JSON.stringify(home.health.dead_jobs)}, dead deliveries ${JSON.stringify(home.health.dead_deliveries)}, failed deliveries ${JSON.stringify(home.health.failed_deliveries)}; set aside ${JSON.stringify(home.health.set_aside_units)} units, ${home.health.set_aside_days} days; ${home.health.pauses.length} pauses.`, "",
    `Sweep: ${home.sweep === null ? "none in the last two days" : `at ${new Date(home.sweep.at_ms).toISOString()}, ${s(home.sweep.seconds)} s, removed ${JSON.stringify(home.sweep.removed)}`}.`, "");
  return `${lines.join("\n")}\n`;
}


async function request(url: string, method: string, path: string, headers: Record<string, string>, body?: Buffer | string): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  for (let tries = 1; ; tries++) {
    try {
      response = await fetch(`${url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
      break;
    } catch (error) {
      if (!(error instanceof TypeError) || tries === 3) throw error;
    }
  }
  const text = await response.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { text };
  }
  return { status: response.status, body: parsed };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function fail(message: string): never {
  throw new Error(message);
}


if (process.argv[1] !== undefined && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = "usage: npx tsx tools/volume.ts --size tiny|week|heavy|founder [--seed <n>] [--out <dir>] [--against <report.json>] [--keep] [--helpers <n>|auto] [--keyed] [--at <dir>] [--scale <fraction>]";
  let values: { size?: string; seed?: string; out?: string; against?: string; keep?: boolean; helpers?: string; keyed?: boolean; at?: string; scale?: string };
  try {
    ({ values } = parseArgs({ options: { size: { type: "string" }, seed: { type: "string" }, out: { type: "string" }, against: { type: "string" }, keep: { type: "boolean" }, helpers: { type: "string" }, keyed: { type: "boolean" }, at: { type: "string" }, scale: { type: "string" } }, strict: true }));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${usage}\n`);
    process.exit(2);
  }
  const named = values.size ?? "";
  if (!Object.hasOwn(SIZES, named) || (values.seed !== undefined && !/^\d+$/u.test(values.seed)) || (values.helpers !== undefined && !/^(auto|[1-9]\d*)$/u.test(values.helpers)) || (values.scale !== undefined && !(Number(values.scale) > 0))) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  const sized = named as SizeName;
  runVolume({
    size: sized, seed: Number(values.seed ?? 1), out: values.out ?? join(REPO, ".build", "volume", sized),
    ...(values.against === undefined ? {} : { against: values.against }), keep: values.keep === true,
    ...(values.helpers === undefined ? {} : { helpers: values.helpers === "auto" ? "auto" as const : Number(values.helpers) }),
    keyed: values.keyed === true, ...(values.at === undefined ? {} : { at: values.at }), ...(values.scale === undefined ? {} : { scale: Number(values.scale) }),
    log: (line) => process.stderr.write(`${new Date().toISOString()} ${line}\n`),
  }).then(
    (run) => process.stdout.write(`${run.json}\n${run.md}\n`),
    (error: unknown) => {
      process.stderr.write(`${(error as Error).stack ?? String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
