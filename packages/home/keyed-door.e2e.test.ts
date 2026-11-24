import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";
import { HOME_STORE, openHandedFolder, openHome, openHomeFolder, type HomeFolder, type Keys, type Program } from "@lifestreamprotocol/core";
import { openLedger } from "@lifestreamprotocol/model";
import { serveDoor, type Door } from "./door.js";
import { startHome, type Home as RunningHome } from "./home.js";
import { adopt, readHome } from "./lifecycle.js";
import { machine } from "./machine.js";
import { unitSources } from "./devices.js";
import { mintPrincipal, readPrincipals } from "./principals.js";
import { SINCE } from "./models.js";
import { askHome } from "./socket.js";
import { draftRecovery, readHandoff, Vault } from "./vault.js";
import { FAKES, LOOK_MS, TICK_MS, until } from "./test/harness-root.js";
import { testSocket, writeFolder } from "./test/folder.js";
import { acquisitionBundle, DEVICE, PHONE_UNIT, phoneBundle, sha256, startDoor } from "./test/support.js";

const SOURCE = "apple-notes:local:macbook-pro-0001";
const CANARY = "canary-6f1d0c55-keyed-door";
const TOKEN = "synthetic-token-mac".padEnd(43, "x");
const FLOORS = { mac: "1.0", phone: "1.0", extension: "1.0", runner: "1" };
const temps: string[] = [];
const at = machine();
const SENT_MS = Date.now();
const CARRIED = Buffer.from(`a carried blob ${CANARY}`);
const PHONE_TOKEN = "synthetic-token-phone".padEnd(43, "x");
const PHONE_LANE = `phone:${PHONE_UNIT}`;
const LOCATION = `location:local:${PHONE_UNIT}`;
const VOICE = `voice-notes:local:${PHONE_UNIT}`;
const CAMERA = `camera:local:${PHONE_UNIT}`;
const PHONE_SOURCES = [LOCATION, VOICE, CAMERA];
const VOICE_BLOB = Buffer.from(`fake m4a bytes of a synthetic voice note ${CANARY}`);
const CAMERA_BLOB = Buffer.from(`fake heic bytes of a synthetic camera photo ${CANARY}`);

afterAll(() => {
  if (process.env.LIFESTREAM_KEEP_ARTIFACTS !== "1") for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface TestHome {
  root: string;
  slot: Buffer | null;
  keys: Keys | undefined;
  folder: HomeFolder;
}

async function testHome(keyed: boolean): Promise<TestHome> {
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), `lifestream-keyed-door-${keyed ? "keyed" : "plain"}-`))), "home");
  temps.push(root);
  const slot = keyed ? randomBytes(32) : null;
  const handoff = slot === null ? undefined : readHandoff(JSON.stringify({ home_id: randomUUID(), slot_key: slot.toString("hex"), recovery: draftRecovery(1).recovery }));
  await adopt(root, { machine: at, ...(handoff === undefined ? {} : { keyed: handoff }), fileSystem: () => "apfs", platform: "darwin" });
  writeFolder(root, { helpers: 2, clocks: false });
  let keys: Keys | undefined;
  if (slot !== null) {
    const vault = new Vault({ root, machine: at.dir, home: readHome(root).id });
    expect(vault.start({ key: slot, why: null }, 1)).toBeNull();
    keys = vault.keys!;
  }
  const folder = openHomeFolder(root, { machine: at.dir, program: "home", ...(keys === undefined ? {} : { keys }) });
  const db = openHome(folder, "migrate");
  const phone = unitSources("phone", PHONE_UNIT, null, readHome(root).id, declarations()).filter((source) => PHONE_SOURCES.includes(source.id));
  db.commit((tx) => {
    tx.tables.sources.add({ id: SOURCE, vendor: vendorOf(declarations(), SOURCE), connector: "fake-rows", added_ms: 0 });
    for (const source of phone) tx.tables.sources.add({ id: source.id, vendor: vendorOf(declarations(), source.id), connector: source.connector, options: source.options ?? {}, added_ms: 0 });
    tx.tables.meta.set(SINCE, "1970-01-31");
  });
  db.close();
  mkdirSync(join(root, "replies"), { recursive: true });
  openLedger(folder, { mode: "migrate" }).close();
  mintPrincipal(folder, { unit: "macbook-pro-0001", kind: "mac", scopes: ["deliver"], sources: [SOURCE], token: TOKEN, now_ms: Date.now() });
  mintPrincipal(folder, { unit: PHONE_UNIT, kind: "phone", scopes: ["deliver"], sources: [PHONE_LANE, ...PHONE_SOURCES], token: PHONE_TOKEN, now_ms: Date.now() });
  return { root, slot, keys, folder };
}

function bundleOf(now: number, seal = 1): ReturnType<typeof acquisitionBundle> {
  const rows = [
    { kind: "note", key: "note-1", content: { text: `first ${CANARY}`, at: now - 2_000 }, at: now - 2_000 },
    { kind: "note", key: "note-2", content: { text: `second ${CANARY}`, at: now - 1_000 }, at: now - 1_000 },
  ];
  return acquisitionBundle({
    source: SOURCE, feeder: "fake-rows", fetched_ms: now, files: [["rows.ndjson", Buffer.from(rows.map((row) => `${JSON.stringify(row)}\n`).join(""))]],
    blobs: [CARRIED], custody: { [SOURCE]: { seal } },
  });
}

async function put(url: string, path: string, body: Buffer): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, ...DEVICE.mac }, body } as RequestInit);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function heads(home: TestHome, sources: readonly string[] = [SOURCE]): unknown[] {
  const db = home.folder.store(HOME_STORE, join(home.root, "home.db"), { mode: "read", mustExist: true });
  try {
    return db.prepare(`SELECT source, kind, key, version FROM heads WHERE source IN (${sources.map(() => "?").join(", ")}) ORDER BY source, kind, key`).all(...sources);
  } finally {
    db.close();
  }
}

function settled(home: TestHome): boolean {
  const db = home.folder.store(HOME_STORE, join(home.root, "home.db"), { mode: "read", mustExist: true });
  try {
    const { total, imported } = db.prepare("SELECT count(*) AS total, coalesce(sum(state = 'imported'), 0) AS imported FROM deliveries").get() as { total: number; imported: number };
    return total > 0 && total === imported;
  } finally {
    db.close();
  }
}

function phoneDay(): { id: string; bytes: Buffer } {
  const captured = (minute: number) => ({ wall_rfc3339: `2026-10-03T08:${String(minute).padStart(2, "0")}:07.125+05:30`, wall_unix_seconds: 1791001807.125 + minute * 60, elapsed_seconds: 1000.5 });
  const line = (domain: string, kind: string, sequence: number, minute: number, payload: object) => ({
    schema_version: 1, domain, kind, sequence, observed_at: `2026-10-03T02:${String(minute).padStart(2, "0")}:07.125Z`, captured: captured(minute),
    process_instance_id: "00000000-0000-4000-8000-0000000000c1", payload,
  });
  const fix = (sequence: number, minute: number, latitude: number) => line("location", "fix", sequence, minute, {
    latitude, longitude: -0.25, altitude: 3.5, horizontal_accuracy: 12.25, vertical_accuracy: 4, speed: -1, course: -1, timestamp_unix_seconds: 1791001807.125 + minute * 60,
  });
  const ref = (bytes: Buffer, type: string, role: string) => ({ hash: `sha256:${sha256(bytes)}`, bytes: bytes.length, type, role });
  return phoneBundle({
    entries: {
      "location.jsonl": [fix(41, 1, 0.5), fix(42, 2, 0.5001)],
      "voice.jsonl": [line("voice", "voice_note", 1, 5, { duration_s: 4.5, blob: ref(VOICE_BLOB, "audio/mp4", "voice_note") })],
      "camera.jsonl": [line("camera", "photo", 1, 6, { blob: ref(CAMERA_BLOB, "image/heic", "photo"), orientation: 1 })],
    } as Record<string, { sequence: number }[]>,
    blobs: [VOICE_BLOB, CAMERA_BLOB],
    custody: Object.fromEntries(PHONE_SOURCES.map((source) => [source, { seal: 1 }])),
    range: { start: "2026-10-03T08:00:00+05:30", end: "2026-10-03T08:30:00+05:30" },
  });
}

async function phoneDelivered(home: TestHome): Promise<{ heads: unknown[]; status: number }> {
  let running: RunningHome | undefined;
  let door: Door | undefined;
  try {
    running = await startHome(home.root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, machine: at, slot: home.slot, log: () => undefined });
    door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1024 ** 3 }, { registry: FAKES, lookMs: LOOK_MS, machine: at, floors: FLOORS, log: () => undefined, ...(home.slot === null ? {} : { slot: { key: home.slot, why: null } }) });
    const day = phoneDay();
    const response = await fetch(`http://127.0.0.1:${door.port}/v1/bundles/${day.id}`, { method: "PUT", headers: { authorization: `Bearer ${PHONE_TOKEN}`, ...DEVICE.phone }, body: day.bytes } as RequestInit);
    const body = await response.json() as Record<string, unknown>;
    expect([response.status, body.code ?? null, body.message ?? null]).toEqual([201, null, null]);
    await until("the phone's day imported", () => settled(home));
    return { heads: heads(home, PHONE_SOURCES), status: response.status };
  } finally {
    await door?.close();
    await running?.stop();
  }
}

const NAMED_BY_HASH = (hashes: readonly string[]) => (path: string) => hashes.includes(basename(path).replace(/\.k\d+$/u, ""));

function filesUnder(...dirs: string[]): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return found;
}

function tree(root: string): Record<string, string> {
  return Object.fromEntries(filesUnder(root).filter((path) => !/\.lock(-journal)?$/u.test(path) && !path.endsWith("/config/settings.json")).map((path) => [path, `${statSync(path).size}:${statSync(path).mtimeMs}`]));
}

async function delivered(home: TestHome): Promise<{ heads: unknown[]; status: number }> {
  let running: RunningHome | undefined;
  let door: Door | undefined;
  try {
    running = await startHome(home.root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, machine: at, slot: home.slot, log: () => undefined });
    door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1024 ** 3 }, { registry: FAKES, lookMs: LOOK_MS, machine: at, floors: FLOORS, log: () => undefined, ...(home.slot === null ? {} : { slot: { key: home.slot, why: null } }) });
    const bundle = bundleOf(SENT_MS);
    const answer = await put(`http://127.0.0.1:${door.port}`, bundle.path, bundle.bytes);
    expect([answer.status, answer.body.code ?? null, answer.body.message ?? null]).toEqual([201, null, null]);
    await until("the delivery's two notes land", () => heads(home).length === 2);
    return { heads: heads(home), status: answer.status };
  } finally {
    await door?.close();
    await running?.stop();
  }
}

async function paired(home: TestHome): Promise<{ pairing: Record<string, unknown>; exchanged: Record<string, unknown> }> {
  let running: RunningHome | undefined;
  let door: Door | undefined;
  try {
    running = await startHome(home.root, { registry: FAKES, tickMs: TICK_MS, lookMs: LOOK_MS, stopGraceMs: 50, machine: at, slot: home.slot, log: () => undefined });
    door = await serveDoor(home.root, { port: 0, max_bundle_bytes: 1024 ** 3 }, { registry: FAKES, lookMs: LOOK_MS, machine: at, floors: FLOORS, log: () => undefined, ...(home.slot === null ? {} : { slot: { key: home.slot, why: null } }) });
    const url = `http://127.0.0.1:${door.port}`;
    const { code } = await askHome(testSocket(home.root, at.dir), "pair") as { code: string };
    const pass = randomBytes(32).toString("base64url");
    const pairing = await fetch(`${url}/v1/pair`, {
      method: "POST", headers: { ...DEVICE.mac, "content-type": "application/json" }, body: JSON.stringify({ code, pass, kind: "mac", model: "MacBook Pro", serial4: "cc11", name: "Synthetic Mac" }),
    });
    expect(pairing.status).toBe(200);
    const exchanged = await fetch(`${url}/v1/exchange`, { method: "POST", headers: { authorization: `Bearer ${pass}`, ...DEVICE.mac, "content-type": "application/json" }, body: "{}" });
    expect(exchanged.status).toBe(200);
    return { pairing: (await pairing.json() as { answer: Record<string, unknown> }).answer, exchanged: await exchanged.json() as Record<string, unknown> };
  } finally {
    await door?.close();
    await running?.stop();
  }
}

describe("the door of an encrypted home", () => {
  it("says keyed in the pairing answer of an encrypted home alone, and in no ordinary answer", async () => {
    const keyed = await paired(await testHome(true));
    const plain = await paired(await testHome(false));
    expect([keyed.pairing.keyed, plain.pairing.keyed, keyed.exchanged.keyed, plain.exchanged.keyed]).toEqual([true, undefined, undefined, undefined]);
    expect(Object.keys(keyed.pairing).filter((key) => !(key in plain.pairing))).toEqual(["keyed"]);
  });

  it("a bundle it takes leaves no canary under inbox/ or door/ and lands the same records as on a plain home, whose inbox keeps today's names and bytes", async () => {
    const plain = await testHome(false);
    const fromPlain = await delivered(plain);
    const keyed = await testHome(true);
    const fromKeyed = await delivered(keyed);
    expect(fromKeyed).toEqual(fromPlain);
    expect(fromPlain.status).toBe(201);

    const sealedFiles = filesUnder(join(keyed.root, "inbox"), join(keyed.root, "door"));
    expect(sealedFiles.length).toBeGreaterThan(0);
    expect(sealedFiles.filter((path) => readFileSync(path).includes(CANARY))).toEqual([]);
    expect(sealedFiles.filter((path) => /(?:manifest\.json|rows\.ndjson)$/u.test(path))).toEqual([]);
    expect(filesUnder(keyed.root).filter(NAMED_BY_HASH([sha256(CARRIED)]))).toEqual([]);

    const plainFiles = filesUnder(join(plain.root, "inbox")).map((path) => path.slice(plain.root.length));
    expect(plainFiles.some((path) => path.endsWith("/manifest.json"))).toBe(true);
    expect(plainFiles.some((path) => path.endsWith("/rows.ndjson"))).toBe(true);
    expect(plainFiles.filter((path) => /\.k\d+$/u.test(path))).toEqual([]);
    expect(plainFiles).toContain(`/inbox/${SOURCE}/blobs/${sha256(CARRIED)}`);
    const rows = filesUnder(join(plain.root, "inbox")).find((path) => path.endsWith("/rows.ndjson"));
    expect(rows === undefined ? "" : readFileSync(rows, "utf8")).toContain(CANARY);
  });

  it("started with this Mac's slot key on fd 3 it opens the encrypted folder and answers from its store; started with none it answers 503 LOCKED with Retry-After 60, opens no store and changes no file", async () => {
    const keyed = await testHome(true);
    const bundle = bundleOf(Date.now());
    const handed = await startDoor({ root: keyed.root, tokens: {}, ids: {} }, {}, undefined, false, keyed.slot!);
    try {
      const answer = await put(handed.url, bundle.path, bundle.bytes);
      expect(answer).toMatchObject({ status: 201, body: { sources: { [SOURCE]: { received: 1 } } } });
      expect(handed.logs.join("\n")).not.toContain(keyed.slot!.toString("hex"));
    } finally {
      await handed.stop();
    }

    const before = tree(keyed.root);
    const bare = await startDoor({ root: keyed.root, tokens: {}, ids: {} });
    try {
      const next = bundleOf(Date.now() + 60_000, 2);
      const refused = await fetch(`${bare.url}${next.path}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, ...DEVICE.mac }, body: next.bytes } as RequestInit);
      expect([refused.status, refused.headers.get("retry-after"), await refused.json()]).toEqual([503, "60", { code: "LOCKED", message: "Lifestream is locked: unlock it on your Mac." }]);
      await until("the door says why it cannot open the folder", () => bare.logs.some((line) => line.includes("encrypted home")));
    } finally {
      await bare.stop();
    }
    expect(tree(keyed.root)).toEqual(before);
  });

  it("its start empties what a door before it left in its own work, and leaves the home's and a call's", async () => {
    const keyed = await testHome(true);
    const handed = (program: Program) => openHandedFolder({ root: keyed.root, form: "keyed", machine: at.dir, program, keys: keyed.keys!.only(["files"]).hand() });
    const works = (["home", "door", "call"] as const).map((program) => handed(program).work("materialise"));
    for (const work of works) writeFileSync(join(work.path, "copy.jpg"), "a synthetic working copy");
    const door = await serveDoor(keyed.root, { port: 0, max_bundle_bytes: 1024 ** 3 }, { machine: at, floors: FLOORS, log: () => undefined, slot: { key: keyed.slot!, why: null } });
    try {
      expect(works.map((work) => existsSync(work.path))).toEqual([true, false, true]);
    } finally {
      await door.close();
      for (const work of works) work.empty();
    }
  });

  it("a phone's bundle lands the same records on an encrypted home as on a plain one; its carried blobs are sealed and named by no SHA-256, a plain home's by their hex", async () => {
    const plain = await testHome(false);
    const fromPlain = await phoneDelivered(plain);
    const keyed = await testHome(true);
    const fromKeyed = await phoneDelivered(keyed);
    expect(fromPlain.heads.length).toBeGreaterThan(0);
    expect(fromKeyed).toEqual(fromPlain);
    const hashes = [VOICE_BLOB, CAMERA_BLOB].map(sha256);
    const keyedFiles = filesUnder(keyed.root);
    expect(keyedFiles.filter(NAMED_BY_HASH(hashes))).toEqual([]);
    expect(filesUnder(join(keyed.root, "inbox"), join(keyed.root, "door")).filter((path) => readFileSync(path).includes(CANARY))).toEqual([]);
    expect(filesUnder(join(plain.root, "inbox", PHONE_LANE, "blobs")).map((path) => basename(path)).sort()).toEqual([...hashes].sort());
  });

  it("the passes file of an encrypted home is sealed, holds no canary, and reads back; a plain home's is today's bytes, mode and name", async () => {
    const keyed = await testHome(true);
    const plain = await testHome(false);
    for (const home of [keyed, plain]) mintPrincipal(home.folder, { unit: "reader-0001", scopes: ["read"], account: `person-a@example.com ${CANARY}`, now_ms: 1 });
    expect(existsSync(join(keyed.root, "config", "principals.json"))).toBe(false);
    expect(existsSync(join(keyed.root, "config", "principals.json.k1"))).toBe(true);
    expect(filesUnder(join(keyed.root, "config")).filter((path) => readFileSync(path).includes(CANARY) || readFileSync(path).includes(TOKEN))).toEqual([]);
    expect(readPrincipals(keyed.folder).principals.map((row) => row.account)).toEqual([null, null, `person-a@example.com ${CANARY}`]);
    const plainFile = join(plain.root, "config", "principals.json");
    expect(readFileSync(plainFile, "utf8")).toBe(`${JSON.stringify(readPrincipals(plain.folder))}\n`);
    expect(statSync(plainFile).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(plain.root, "config")).filter((name) => name.startsWith("principals"))).toEqual(["principals.json"]);
  });
});
