import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { startHome, type Home } from "./home.js";
import { askHome } from "./socket.js";
import { FAKES, makeRoot, readHome, removeRoot, REPO, TICK_MS, until } from "./test/harness-root.js";
import { doorHere } from "./test/harness-door.js";
import { DEVICE, phoneBundle, photoLine, sha256 } from "./test/support.js";
import { openHomeFolder } from "@lifestreamprotocol/core";
import { testSocket } from "./test/folder.js";

const report: Record<string, unknown> = {};
const roots: string[] = [];
const homes: Home[] = [];
const doors: { stop(): Promise<void> }[] = [];

afterEach(async () => {
  for (const door of doors.splice(0)) await door.stop();
  for (const home of homes.splice(0)) await home.stop();
  for (const root of roots.splice(0)) removeRoot(root);
});

afterAll(() => {
  const directory = join(REPO, "packages", "home", ".build", "e2e");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "phone-media.json"), `${JSON.stringify(report, null, 2)}\n`);
});

async function start(root: string): Promise<{ url: string; stop(): Promise<void> }> {
  const door = await doorHere(root);
  doors.push(door);
  const home = await startHome(root, { stopGraceMs: 50, registry: FAKES, tickMs: TICK_MS, log: () => undefined });
  homes.push(home);
  return door;
}

async function request(url: string, method: string, path: string, headers: Record<string, string>, body: Buffer | string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${url}${path}`, { method, headers, body });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function storedBlobs(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(directory, entry.name));
      else if (/^[0-9a-f]{64}$/u.test(entry.name)) found.push(entry.name);
    }
  };
  walk(join(root, "blobs"));
  return found.sort();
}

describe("a phone's photos", () => {
  it("successive shipments import every photo once, and blobs/ holds each photo once", async () => {
    const root = makeRoot("lifestream-phone-media-", { sources: {} });
    roots.push(root);
    const door = await start(root);
    const sock = testSocket(root);

    const pass = randomBytes(32).toString("base64url");
    const { code } = (await askHome(sock, "pair", [])) as { code: string };
    const paired = await request(door.url, "POST", "/v1/pair", { ...DEVICE.phone, "content-type": "application/json" },
      JSON.stringify({ code, pass, kind: "phone", model: "iPhone 17 Pro", account: "person-a@example.com", new: true }));
    expect(paired.status).toBe(200);
    const unit = paired.body.unit as string;
    const lane = `phone:${unit}`;
    const photos = `apple-photos:person-a@example.com:${unit}`;

    const photo = (n: number) => Buffer.from(`synthetic jpeg bytes of photo ${n}, ${"x".repeat(64)}`);
    const shipment = (seal: number, lines: number[], carried: number[]) => phoneBundle({
      entries: { "photos.jsonl": lines.map((n) => photoLine(n, photo(n))) }, blobs: carried.map(photo), second: seal,
      custody: { [photos]: { seal } },
    });
    const ship = (bundle: { id: string; bytes: Buffer }) =>
      request(door.url, "PUT", `/v1/bundles/${bundle.id}`, { authorization: `Bearer ${pass}`, ...DEVICE.phone }, bundle.bytes);
    const imported = () => readHome(root, (db) =>
      db.prepare("SELECT count(*) FROM deliveries WHERE source = ? AND state = 'imported'").pluck().get(photos)) as number;

    const first = shipment(1, [1, 2], [1, 2]);
    expect((await ship(first)).status).toBe(201);
    await until("seal 1 imported", () => imported() === 1);

    const second = shipment(2, [2, 3], [2, 3]);
    expect((await ship(second)).status).toBe(201);
    await until("seal 2 imported", () => imported() === 2);

    const third = shipment(3, [3, 4], [4]);
    expect((await ship(third)).status).toBe(201);
    await until("seal 3 imported", () => imported() === 3);

    const inbox = join(root, "inbox");
    const files = (id: string) => (JSON.parse(readFileSync(join(inbox, lane, id, "manifest.json"), "utf8")) as { files: { file: string }[] }).files.map((file) => file.file);
    const shapes = { first: files(first.id), second: files(second.id), third: files(third.id) };
    expect(shapes).toEqual({
      first: ["bundle/manifest.json", "bundle/photos.jsonl"], second: ["bundle/manifest.json", "bundle/photos.jsonl"], third: ["bundle/manifest.json", "bundle/photos.jsonl"],
    });
    expect([existsSync(join(inbox, lane, first.id, "bundle.zip")), readdirSync(join(root, "door", "uploads"))]).toEqual([false, []]);

    const store = openHomeFolder(root).blobs(join(root, "blobs"), { reading: true });
    const stored = storedBlobs(root);
    const held = Object.fromEntries([1, 2, 3, 4].map((n) => {
      const hex = sha256(photo(n));
      const holding = stored.filter((other) => other !== hex && store.bytes(`sha256:${other}`).includes(photo(n)));
      const records = readHome(root, (db) => db.prepare(
        "SELECT h.key FROM heads h JOIN version_blobs b ON b.version = h.version WHERE h.source = ? AND h.kind = 'img' AND b.blob = ?").pluck().all(photos, `sha256:${hex}`)) as string[];
      return [`photo ${n}`, { named: stored.filter((name) => name === hex).length, inside_other_blobs: holding.length, records }];
    }));
    const wanted = readHome(root, (db) => db.prepare("SELECT count(*) FROM wanted_blobs").pluck().get()) as number;
    report.shapes = shapes;
    report.photos = held;
    report.wanted = wanted;
    expect(held).toEqual({
      "photo 1": { named: 1, inside_other_blobs: 0, records: ["SYNTHETIC-ASSET-1:null"] },
      "photo 2": { named: 1, inside_other_blobs: 0, records: ["SYNTHETIC-ASSET-2:null"] },
      "photo 3": { named: 1, inside_other_blobs: 0, records: ["SYNTHETIC-ASSET-3:null"] },
      "photo 4": { named: 1, inside_other_blobs: 0, records: ["SYNTHETIC-ASSET-4:null"] },
    });
    expect(wanted).toBe(0);
  });
});
