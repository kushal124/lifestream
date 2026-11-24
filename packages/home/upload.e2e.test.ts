import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, openSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32 } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { openHome, openHomeFolder } from "@lifestreamprotocol/core";
import { mintPrincipal } from "./principals.js";
import { artifact, makeRoot, readHome, removeRoot, REPO, until } from "./test/harness-root.js";
import { DEVICE } from "./test/support.js";
import { declarations, vendorOf } from "@lifestreamprotocol/connect";


const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const LARGE_BYTES = 1.25 * GIB;
const GROWTH_BUDGET = LARGE_BYTES / 2;
const MAC = "macbook-pro-0001";
const UPLOAD = `upload:local:${MAC}`;
const DOWNLOAD = "google-search:person-a@example.com:export";
const FETCHED_AT = "2026-10-03T09:00:00Z";
const ANSWER_LINE = /^\{"status":.*\n/mu;
const TOY_EXPORT = Buffer.from(`${JSON.stringify({ at: "2026-10-01T09:00:00Z", verb: "searched", text: "synthetic query" })}\n`);

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) removeRoot(root);
});

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const file = (path: string) => pathToFileURL(join(REPO, path)).href;

describe("the upload route", () => {
  it("a file larger than the process's memory is held whole by the door, the seal, the import or a connector, or lands as anything but its bytes", async () => {
    const root = makeRoot("lifestream-upload-route-", { sources: { [UPLOAD]: "upload" }, helpers: 2 });
    roots.push(root);
    const db = openHome(openHomeFolder(root), "migrate");
    db.commit((tx) => tx.tables.sources.add({ id: DOWNLOAD, vendor: vendorOf(declarations(), DOWNLOAD), connector: "toy-download", options: { lane: UPLOAD }, added_ms: 0 }));
    db.close();
    const { token } = mintPrincipal(openHomeFolder(root), { unit: MAC, kind: "mac", scopes: ["deliver"], sources: [UPLOAD], now_ms: Date.parse(FETCHED_AT) });

    const bundle = join(root, "bundle.zip");
    const large = writeUploadBundle(bundle);
    writeFileSync(join(root, "registry.mts"), registryModule());
    const script = join(root, "route.mts");
    writeFileSync(script, routeScript());

    const started = Date.now();
    const env = { ...process.env };
    delete env.LIFESTREAM_TEST_DIST;
    const route = spawn(process.execPath, ["--max-old-space-size=128", "--import", "tsx", script, root, token, bundle], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: "", stderr: "" };
    const ended = () => route.exitCode !== null || route.signalCode !== null;
    const answered = new Promise<void>((resolve) => {
      route.stdout.on("data", (chunk: Buffer) => {
        output.stdout += chunk.toString("utf8");
        if (ANSWER_LINE.test(output.stdout)) resolve();
      });
      route.once("exit", () => resolve());
    });
    route.stderr.on("data", (chunk: Buffer) => { output.stderr += chunk.toString("utf8"); });
    let status: number | null;
    try {
      await answered;
      await until("the route's process ended once it wrote its answer (nothing it opened left running)", ended);
      status = route.exitCode;
    } finally {
      if (route.exitCode === null && route.signalCode === null) route.kill("SIGKILL");
    }
    expect(status, `the route did not finish: ${output.stderr}`).toBe(0);
    const child = JSON.parse(output.stdout.trim().split("\n").at(-1)!) as { status: number; body: { sources: Record<string, { received: number }> }; max_rss_bytes: number; base_rss_bytes: number; imported: number };
    expect(child.status, JSON.stringify(child.body)).toBe(201);
    expect(child.body.sources[UPLOAD]!.received).toBe(1);
    expect(child.imported).toBe(2);

    const heads = readHome(root, (home) => home.prepare("SELECT source, kind, key FROM heads ORDER BY source, kind, key").all()) as { source: string; kind: string; key: string }[];
    expect(heads).toEqual([
      { source: DOWNLOAD, kind: "activity", key: "2026-10-01T09:00:00Z:searched" },
      ...[large.sha256, sha(TOY_EXPORT)].sort().map((key) => ({ source: UPLOAD, kind: "file", key })),
    ]);
    expect(statSync(join(root, "blobs", large.sha256.slice(0, 2), large.sha256.slice(2, 4), large.sha256)).size).toBe(LARGE_BYTES);
    const grew = child.max_rss_bytes - child.base_rss_bytes;
    artifact(root, "upload-route", {
      file_bytes: LARGE_BYTES, base_rss_bytes: child.base_rss_bytes, max_rss_bytes: child.max_rss_bytes, grew_bytes: grew, growth_budget_bytes: GROWTH_BUDGET, heap_cap_mib: 128,
      milliseconds: Date.now() - started, heads,
    });
    expect(grew).toBeLessThan(GROWTH_BUDGET);
  });
});

function writeUploadBundle(path: string): { sha256: string } {
  const zero = Buffer.alloc(64 * MIB);
  let crc = 0;
  const digest = createHash("sha256");
  for (let left = LARGE_BYTES; left > 0; left -= zero.length) {
    const chunk = zero.subarray(0, Math.min(zero.length, left));
    crc = crc32(chunk, crc);
    digest.update(chunk);
  }
  const largeSha = digest.digest("hex");
  const index = Buffer.from(`${JSON.stringify({
    format: "org.lifestreamprotocol.upload/1",
    files: [
      { path: "exports/toy-export-001.jsonl", modified_at: "2026-10-02T07:00:00.000Z" },
      { path: "takeout/takeout-001.zip", media_type: "application/zip", modified_at: "2026-10-02T08:00:00.000Z" },
    ],
  })}\n`);
  const listed = [
    { name: "upload.json", bytes: index },
    { name: "files/exports/toy-export-001.jsonl", bytes: TOY_EXPORT },
  ];
  const manifest = Buffer.from(`${JSON.stringify({
    format: "org.lifestreamprotocol.acquisition/1", source_id: UPLOAD, feeder: "upload-folder", fetched_at: FETCHED_AT, complete: true,
    files: [
      ...listed.map((member) => ({ file: member.name, sha256: sha(member.bytes), bytes: member.bytes.length })),
      { file: "files/takeout/takeout-001.zip", sha256: largeSha, bytes: LARGE_BYTES },
    ],
    facts: { files: 2, snapshot_taken_at: FETCHED_AT, blobs_carried: 0 },
    custody: { [UPLOAD]: { seal: 1 } },
  })}\n`);
  const writer = zip64Writer(path);
  for (const member of listed) writer.add(member.name, member.bytes.length, crc32(member.bytes), member.bytes);
  writer.add("files/takeout/takeout-001.zip", LARGE_BYTES, crc, null);
  writer.add("manifest.json", manifest.length, crc32(manifest), manifest);
  writer.close();
  return { sha256: largeSha };
}

function zip64Writer(path: string): { add(name: string, size: number, crc: number, bytes: Buffer | null): void; close(): void } {
  const fd = openSync(path, "w");
  let at = 0;
  const central: Buffer[] = [];
  const write = (buffer: Buffer): void => {
    writeSync(fd, buffer, 0, buffer.length, at);
    at += buffer.length;
  };
  return {
    add(name, size, crc, bytes) {
      const encoded = Buffer.from(name, "utf8");
      const local = Buffer.alloc(30 + encoded.length + 20);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(0x0800, 6);
      local.writeUInt32LE(crc >>> 0, 14);
      local.writeUInt32LE(0xffffffff, 18);
      local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(encoded.length, 26);
      local.writeUInt16LE(20, 28);
      encoded.copy(local, 30);
      local.writeUInt16LE(0x0001, 30 + encoded.length);
      local.writeUInt16LE(16, 32 + encoded.length);
      local.writeBigUInt64LE(BigInt(size), 34 + encoded.length);
      local.writeBigUInt64LE(BigInt(size), 42 + encoded.length);
      const offset = at;
      write(local);
      if (bytes === null) {
        at += size;
        ftruncateSync(fd, at);
      } else {
        write(bytes);
      }
      const record = Buffer.alloc(46 + encoded.length + 28);
      record.writeUInt32LE(0x02014b50, 0);
      record.writeUInt16LE(45, 4);
      record.writeUInt16LE(45, 6);
      record.writeUInt16LE(0x0800, 8);
      record.writeUInt32LE(crc >>> 0, 16);
      record.writeUInt32LE(0xffffffff, 20);
      record.writeUInt32LE(0xffffffff, 24);
      record.writeUInt16LE(encoded.length, 28);
      record.writeUInt16LE(28, 30);
      record.writeUInt32LE(0xffffffff, 42);
      encoded.copy(record, 46);
      record.writeUInt16LE(0x0001, 46 + encoded.length);
      record.writeUInt16LE(24, 48 + encoded.length);
      record.writeBigUInt64LE(BigInt(size), 50 + encoded.length);
      record.writeBigUInt64LE(BigInt(size), 58 + encoded.length);
      record.writeBigUInt64LE(BigInt(offset), 66 + encoded.length);
      central.push(record);
    },
    close() {
      const start = at;
      for (const record of central) write(record);
      const length = at - start;
      const end64 = Buffer.alloc(56);
      const end64At = at;
      end64.writeUInt32LE(0x06064b50, 0);
      end64.writeBigUInt64LE(44n, 4);
      end64.writeUInt16LE(45, 12);
      end64.writeUInt16LE(45, 14);
      end64.writeBigUInt64LE(BigInt(central.length), 24);
      end64.writeBigUInt64LE(BigInt(central.length), 32);
      end64.writeBigUInt64LE(BigInt(length), 40);
      end64.writeBigUInt64LE(BigInt(start), 48);
      write(end64);
      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(0x07064b50, 0);
      locator.writeBigUInt64LE(BigInt(end64At), 8);
      locator.writeUInt32LE(1, 16);
      write(locator);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(0xffff, 8);
      end.writeUInt16LE(0xffff, 10);
      end.writeUInt32LE(0xffffffff, 12);
      end.writeUInt32LE(0xffffffff, 16);
      write(end);
      closeSync(fd);
    },
  };
}

function registryModule(): string {
  return `import { instant } from ${JSON.stringify(file("packages/core/index.ts"))};
import { blobChunks, declarations, lines } from ${JSON.stringify(file("packages/connect/index.ts"))};
import { uploadConnector, uploadedFiles } from ${JSON.stringify(file("packages/connect/upload/index.ts"))};

const toyDownload = {
  name: "toy-download",
  kinds: { activity: () => [] },
  async *read(delivery, files) {
    for await (const uploaded of uploadedFiles(delivery, files)) {
      if (!/(?:^|\\/)toy-export-\\d{3}\\.jsonl$/u.test(uploaded.path)) continue;
      for await (const text of lines(blobChunks(files, uploaded.blob))) {
        const entry = JSON.parse(text);
        yield { kind: "activity", key: entry.at + ":" + entry.verb, content: { type: "toy.activity", ...entry }, time: instant(entry.at, "rfc3339") };
      }
    }
  },
};

export default function registry() {
  return { families: [], readers: [uploadConnector, toyDownload], connectors: declarations() };
}
`;
}

function routeScript(): string {
  return `import { createReadStream, statSync } from "node:fs";
import { request } from "node:http";
import { createRequire } from "node:module";
import { join } from "node:path";
import { serveDoor } from ${JSON.stringify(file("packages/home/door.ts"))};
import { startHome } from ${JSON.stringify(file("packages/home/home.ts"))};

const Database = createRequire(${JSON.stringify(join(REPO, "packages", "home", "package.json"))})("better-sqlite3");
const [root, token, bundle] = process.argv.slice(2);
const door = await serveDoor(root, { port: 0, max_bundle_bytes: 8 * 1024 ** 3 }, { log: () => undefined });
const base_rss_bytes = process.memoryUsage().rss;
const answer = await new Promise((resolve, reject) => {
  const put = request({ host: "127.0.0.1", port: door.port, method: "PUT", path: "/v1/acquisitions/" + encodeURIComponent(${JSON.stringify(UPLOAD)}) + "/20261003T090000Z",
    headers: { authorization: "Bearer " + token, "lifestream-device": ${JSON.stringify(DEVICE.mac["lifestream-device"])}, "content-type": "application/zip", "content-length": statSync(bundle).size } }, (response) => {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", (chunk) => { body += chunk; });
    response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  });
  put.on("error", reject);
  createReadStream(bundle).pipe(put);
});
await door.close();
if (answer.status !== 201) {
  process.stdout.write(JSON.stringify({ ...answer, imported: 0, max_rss_bytes: 0 }) + "\\n");
  process.exit(0);
}
const home = await startHome(root, { stopGraceMs: 50, registry: join(root, "registry.mts"), log: () => undefined });
const imported = () => {
  const db = new Database(join(root, "home.db"), { readonly: true, timeout: 5000 });
  try { return db.prepare("SELECT count(*) FROM deliveries WHERE state = 'imported'").pluck().get(); } finally { db.close(); }
};
while (imported() < 2) await new Promise((resolve) => setTimeout(resolve, 100));
const count = imported();
await home.stop();
process.stdout.write(JSON.stringify({ ...answer, imported: count, max_rss_bytes: process.resourceUsage().maxRSS * 1024, base_rss_bytes }) + "\\n");
`;
}
