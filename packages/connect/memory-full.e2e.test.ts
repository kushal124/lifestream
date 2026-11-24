import { createHash } from "node:crypto";
import { appendFileSync, closeSync, openSync, readFileSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openHomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { adopt, artifact, boundedRead, childScript, CONNECT_ROOT, deliver, exportLines, HEAP_MiB, MiB, openTestHome, temp, wholeReads, writeZip } from "./test/drive.js";
import { LOG as CLAUDE_CODE_LOG, SOURCE as CLAUDE_CODE_SOURCE, typed } from "./ai/claude-code/test/fixtures.js";
import { LOG as CODEX_LOG, meta, SOURCE as CODEX_SOURCE } from "./ai/codex/test/fixtures.js";
import { chatgptShard } from "./ai/test/fixtures.js";
import { FACTS as BIOME_FACTS, NOW_PLAYING_SOURCE, PHONE_SYNC, playing, segment } from "./biome/test/fixture.js";
import { APP_FORMAT } from "./health/whoop/app.js";
import { CHROME_FILE } from "./browser/chrome/reader.js";
import { CHROME_SOURCE, createHistory, SNAPSHOT as CHROME_SNAPSHOT, T0 as CHROME_T0 } from "./browser/chrome/test/fixture.js";
import { ROOT as ACTIVITY_ROOT, ZIP_NAME as ACTIVITY_ZIP } from "./google/my-activity/test/fixtures.js";
import { exportXml, fillerRecord, SOURCE as HEALTH_SOURCE } from "./health/apple/health.test-support.js";
import { HEALTH_ACCOUNT, largeShipment, UNIT as PHONE_UNIT } from "./ios-app/phone.test-support.js";
import { folderAt, frameLine, observation, RECORDER_SOURCE } from "./macos-app/screen/test/fixture.js";
import { largeMbox } from "./mail/gmail/test/fixtures.js";
import { bigStore as imessageStore, deliver as imessageDelivery, MAC_SOURCE as IMESSAGE_SOURCE } from "./messages/imessage/imessage.test-support.js";
import { bigStore as whatsappStore, deliver as whatsappDelivery, MAC_SOURCE as WHATSAPP_SOURCE } from "./messages/whatsapp/whatsapp.test-support.js";
import { jpeg, sidecar, SOURCE as PHOTOS_SOURCE } from "./photos/google/test/fixtures.js";
import { BASE as COAST_BASE, COAST_SOURCE, FakeCoast } from "./screen/coast/test/fixture.js";
import { chatStore } from "./shared/sqlite.test-support.js";
import { BYTES_LIMIT } from "./shared/zip.js";
import { exportMembers as instagramMembers, PROFILE, SOURCE as INSTAGRAM_SOURCE } from "./social/instagram/test/fixtures.js";
import { archiveMembers, SOURCE as X_SOURCE, ZIP_NAME as X_ZIP } from "./social/x/test/fixtures.js";
import { WISPR_FILE } from "./voice/wispr-flow/reader.js";
import { createFlowStore, SNAPSHOT as WISPR_SNAPSHOT, T as WISPR_DAY, WISPR_SOURCE } from "./voice/wispr-flow/test/fixture.js";

const url = (relative: string): string => JSON.stringify(pathToFileURL(join(CONNECT_ROOT, relative)).href);

const T1 = Date.UTC(2026, 9, 1, 4);

function countingScript(dir: string, module: string, name: string, delivery: object): string {
  const script = join(dir, "child.mts");
  writeFileSync(script, `
    import { openHomeFolder } from ${url("../core/index.ts")};
    import { ${name} } from ${url(module)};
    const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(${JSON.stringify(join(dir, "blobs"))});
    let rows = 0;
    for await (const row of ${name}.read(${JSON.stringify(delivery)}, blobs)) rows++;
    console.log(JSON.stringify({ rows }));
  `);
  return script;
}

function archiveReader(zip: string): string {
  return `{
        has: () => false,
        prefix: (_hash, bytes) => {
          const fd = openSync(${JSON.stringify(zip)}, "r");
          try {
            const out = Buffer.alloc(bytes);
            return out.subarray(0, readSync(fd, out, 0, bytes, 0));
          } finally {
            closeSync(fd);
          }
        },
        bytes: () => { throw new Error("no whole read"); },
        text: () => { throw new Error("no whole read"); },
        materialise: async () => ({ path: ${JSON.stringify(zip)}, dispose() {} }),
      }`;
}

const sha = (chunks: Iterable<Buffer>): string => {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
};

describe("every reader's memory: each of these is impossible", () => {
  it("Claude Code: memory grows with delivery size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const path = join(dir, CLAUDE_CODE_LOG);
    const fd = openSync(path, "w");
    let lines = 0;
    try {
      const output = "x".repeat(4000);
      for (let written = 0; written < size; lines++) {
        const text = `${typed(lines, { type: "user", toolUseResult: { stdout: output } })}\n`;
        writeSync(fd, text);
        written += Buffer.byteLength(text);
      }
    } finally {
      closeSync(fd);
    }
    const parts = Buffer.from(JSON.stringify({ parts: [{ file: CLAUDE_CODE_LOG, from_byte: 0, from_line: 1, lines }], files: [] }));
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const files = [{ path: "parts.json", blob: blobs.put(parts), size: parts.length }, { path: CLAUDE_CODE_LOG, ...adopt(blobs, path) }];
    const delivery = { id: "d", source: CLAUDE_CODE_SOURCE, sealed_ms: 1, stated_ms: 1, facts: {}, files };
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "ai/claude-code/reader.ts", "claudeCodeSessions", delivery));
    expect(measured.rows).toBe(lines);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("Codex: memory grows with delivery size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const path = join(dir, CODEX_LOG);
    const fd = openSync(path, "w");
    let lines = 1;
    try {
      writeSync(fd, `${meta({})}\n`);
      const output = "x".repeat(4000);
      for (let written = 0; written < size; lines++) {
        const text = `${JSON.stringify({ timestamp: "2026-10-01T10:00:01.000Z", type: "response_item", payload: { type: "function_call_output", call_id: `call_${lines}`, output }, ordinal: lines })}\n`;
        writeSync(fd, text);
        written += Buffer.byteLength(text);
      }
    } finally {
      closeSync(fd);
    }
    const parts = Buffer.from(JSON.stringify({ parts: [{ file: CODEX_LOG, from_byte: 0, from_line: 1, lines }], files: [] }));
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const files = [{ path: "parts.json", blob: blobs.put(parts), size: parts.length }, { path: CODEX_LOG, ...adopt(blobs, path) }];
    const delivery = { id: "d", source: CODEX_SOURCE, sealed_ms: 1, stated_ms: 1, facts: {}, files };
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "ai/codex/reader.ts", "codexSessions", delivery));
    expect(measured.rows).toBe(lines);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("ChatGPT: memory grows with the size of a shard", () => {
    const dir = temp();
    const conversations = Math.ceil((HEAP_MiB * MiB) / chatgptShard(1).length);
    const large = join(dir, "large.json");
    writeFileSync(large, chatgptShard(conversations));
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { closeSync, openSync, readSync } from "node:fs";
      import { chatgptConnector } from ${url("ai/chatgpt/reader.ts")};
      const user = Buffer.from(JSON.stringify({ id: "user-synthetic0001" }));
      const reader = {
        has: () => true,
        // Its first bytes, as the store reads them to know an archive: user.json's, or the shard's from disk.
        prefix: (hash, bytes) => {
          if (hash.endsWith("0")) return user.subarray(0, bytes);
          const fd = openSync(${JSON.stringify(large)}, "r");
          try {
            const out = Buffer.alloc(bytes);
            return out.subarray(0, readSync(fd, out, 0, bytes, 0));
          } finally {
            closeSync(fd);
          }
        },
        bytes: () => user,
        text: () => user.toString(),
        materialise: () => ({ path: ${JSON.stringify(large)}, dispose() {} }),
      };
      const delivery = { id: "d", source: "chatgpt:user-synthetic0001:export", sealed_ms: 1, stated_ms: 1, facts: {}, files: [
        { path: "user.json", blob: "sha256:" + "0".repeat(64), size: user.length },
        { path: "conversations-000.json", blob: "sha256:" + "1".repeat(64), size: 0 },
      ] };
      let rows = 0;
      for await (const row of chatgptConnector.read(delivery, reader)) rows++;
      console.log(JSON.stringify({ rows }));
    `);
    const measured = boundedRead<{ rows: number }>(script);
    expect(measured.rows).toBe(conversations * 2);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, shard_mib: readFileSync(large).length / MiB });
  });

  it("Biome now playing: memory grows with the delivery", () => {
    const dir = temp();
    const count = HEAP_MiB;
    const title = "x".repeat(2_000);
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const files: Record<string, Buffer> = {};
    for (let file = 0; file < count; file++) {
      const entries = [];
      for (let entry = 0; entry < 500; entry++) entries.push(playing(810_000_000 + file * 10_000 + entry, 1, `Synthetic Track ${entry} ${title}`));
      files[`remote/${PHONE_SYNC}/${810_000_000_000_000 + file}.segb`] = segment(entries, MiB + 128 * 1024, 1);
    }
    const delivery = deliver(blobs, NOW_PLAYING_SOURCE, files, BIOME_FACTS);
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "biome/reader.ts", "biomeNowPlaying", delivery));
    expect(measured.rows).toBe(count * 500);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, segments: count });
  });

  it("WHOOP: memory grows with the capture's heart-rate readings", () => {
    const dir = temp();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const user = "10000001";
    const slices = 10;
    const readings = 7 * 1440;
    const start = Date.UTC(2026, 8, 1);
    const files: Record<string, Buffer> = {};
    const heart_rate: JsonObject[] = [];
    for (let slice = 0; slice < slices; slice++) {
      const values = Array.from({ length: readings }, (_, index) => ({ time: start + (slice * readings + index) * 60_000, data: 60 + (index % 60) }));
      const bytes = Buffer.from(JSON.stringify({ name: "heart_rate", values }));
      const file = `heart-rate-${slice}.json`;
      files[`app/${file}`] = bytes;
      heart_rate.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), step: 60, readings, request_url: `https://api.prod.whoop.com/metrics-service/v1/metrics/user/${user}?apiVersion=7&name=heart_rate&step=60` });
    }
    files["app/manifest.json"] = Buffer.from(JSON.stringify({
      format: APP_FORMAT, started_at: "2026-11-10T00:00:00Z", finished_at: "2026-11-10T00:00:00Z", complete: true,
      date_range: { start: "2026-09-01", end: "2026-11-09", timezone: "UTC" }, hr_step_s: 60, cycles: [], sleep_events: [], heart_rate, stress: [],
    }));
    const delivery = deliver(blobs, `whoop:${user}:cloud`, files, {}, T1);
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "health/whoop/reader.ts", "whoopConnector", delivery));
    expect(measured.rows).toBe(slices * readings);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, slices, readings });
  });

  it("Chrome: memory grows with the history's size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const large = join(dir, "large.sqlite");
    createHistory(large, { urls: [], visits: [], searches: [], downloads: [] });
    const visits = Math.round(size / 2_300);
    const db = new Database(large);
    db.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${visits})
      INSERT INTO urls SELECT i, 'https://example.com/' || i || '/' || printf('%.200c', 'x'), printf('%.2000c', 't'), 1, 0, ${CHROME_T0} + i, 0 FROM n;
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${visits})
      INSERT INTO visits SELECT i, i, ${CHROME_T0} + i * 1000, 0, '', 805306368, 0, 0, 0, 0, '', 0, 0, 0, 0, 1, 0, NULL FROM n;
    `);
    db.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { ...deliver(blobs, CHROME_SOURCE, {}, { ...CHROME_SNAPSHOT, through: visits }), files: [{ path: CHROME_FILE, ...adopt(blobs, large) }] };
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { chromeHistory } from ${url("browser/chrome/reader.ts")};
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(${JSON.stringify(join(dir, "blobs"))});
      let rows = 0, bytes = 0;
      for await (const row of chromeHistory.read(${JSON.stringify(delivery)}, blobs)) { rows++; bytes += JSON.stringify(row.content).length; }
      console.log(JSON.stringify({ rows, bytes }));
    `);
    const measured = boundedRead<{ rows: number; bytes: number }>(script);
    expect(measured.rows).toBe(visits);
    expect(measured.bytes).toBeGreaterThan(size * 0.85);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("Google My Activity: memory grows with the size of a folder", () => {
    const dir = temp();
    const target = 2 * HEAP_MiB * MiB;
    const zip = join(dir, ACTIVITY_ZIP);
    let entries = 0;
    function* folder(): Generator<Buffer> {
      yield Buffer.from("[");
      const pad = "x".repeat(400);
      for (let written = 0; written < target; ) {
        const second = String(entries % 60).padStart(2, "0");
        const text = `${entries === 0 ? "" : ","}{"header":"Maps","title":"Viewed area around Example Town ${entries} ${pad}","titleUrl":"https://www.google.com/maps/@0.1,0.2,${entries}a","time":"2026-09-04T09:00:${second}.${String(entries % 1000).padStart(3, "0")}Z","products":["Maps"],"activityControls":["Web & App Activity"]}`;
        const chunk = Buffer.from(text);
        written += chunk.length;
        entries++;
        yield chunk;
      }
      yield Buffer.from("]");
    }
    writeZip(zip, [{ name: `${ACTIVITY_ROOT}/Maps/MyActivity.json`, bytes: folder, method: "deflate" }]);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { closeSync, openSync, readSync } from "node:fs";
      import { myActivity } from ${url("google/my-activity/reader.ts")};
      const reader = ${archiveReader(zip)};
      const delivery = { id: "d", source: "google-maps:person-a@example.com:export", sealed_ms: 1, stated_ms: 1, facts: {},
        files: [{ path: ${JSON.stringify(ACTIVITY_ZIP)}, blob: "sha256:" + "0".repeat(64), size: 0 }] };
      let rows = 0;
      for await (const row of myActivity.read(delivery, reader)) rows++;
      console.log(JSON.stringify({ rows }));
    `);
    const measured = boundedRead<{ rows: number }>(script);
    expect(measured.rows).toBe(entries);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, folder_mib: target / MiB });
  });

  it("Apple Health export: memory grows with delivery size", () => {
    const dir = temp();
    const size = 2 * HEAP_MiB * MiB;
    const [head, tail] = exportXml("\u0000").split("\u0000") as [string, string];
    function* chunks(): Generator<Buffer> {
      yield Buffer.from(head);
      let written = 0;
      for (let n = 0; written < size; n += 512) {
        const chunk = Buffer.from(Array.from({ length: 512 }, (_, i) => fillerRecord(n + i)).join(""));
        written += chunk.length;
        yield chunk;
      }
      yield Buffer.from(tail);
    }
    const large = join(dir, "large.zip");
    writeZip(large, [{ name: "apple_health_export/export.xml", bytes: chunks, method: "deflate" }]);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { join } from "node:path";
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { readers } from ${url("health/apple/index.ts")};
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(join(${JSON.stringify(dir)}, "blobs"));
      const blob = await blobs.putFile(${JSON.stringify(large)});
      let rows = 0;
      for await (const row of readers[0].read({ id: "x", source: ${JSON.stringify(HEALTH_SOURCE)}, sealed_ms: 0, stated_ms: 0, facts: {}, files: [{ path: "export.zip", blob, size: 0 }] }, blobs)) rows++;
      console.log(JSON.stringify({ rows }));
    `);
    const measured = boundedRead<{ rows: number }>(script);
    expect(measured.rows).toBeGreaterThan(size / 1024);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, export_mib: size / MiB });
  });

  it("the iPhone app's location and health: memory grows with delivery size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const files = [];
    for (const member of largeShipment(size).members) {
      const path = join(dir, member.name);
      writeFileSync(path, "");
      for (const chunk of member.bytes()) appendFileSync(path, chunk);
      files.push({ path: `bundle/${member.name}`, ...adopt(blobs, path) });
    }
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { join } from "node:path";
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { readers as phone } from ${url("ios-app/index.ts")};
      import { readers as health } from ${url("health/apple/index.ts")};
      const readers = [...phone, ...health];
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(join(${JSON.stringify(dir)}, "blobs"));
      const files = ${JSON.stringify(files)};
      const rows = {};
      for (const [name, source] of [["location-ios-bundle", "location:local:${PHONE_UNIT}"], ["health-ios-bundle", "apple-health:${HEALTH_ACCOUNT}:cloud"]]) {
        const connector = readers.find((c) => c.name === name);
        let count = 0;
        for await (const row of connector.read({ id: "phone:${PHONE_UNIT}/x", source, sealed_ms: 0, stated_ms: 0, facts: {}, files }, blobs)) count++;
        rows[name] = count;
      }
      console.log(JSON.stringify({ rows }));
    `);
    const measured = boundedRead<{ rows: Record<string, number> }>(script);
    expect(measured.rows["location-ios-bundle"]).toBeGreaterThan(size / 1024);
    expect(measured.rows["health-ios-bundle"]).toBeGreaterThan(size / 1024);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, domain_file_mib: size / MiB });
  });

  it("the screen recorder: memory grows with delivery size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const large = join(dir, "large.jsonl");
    const fd = openSync(large, "w");
    let lines = 0;
    const ocr = `"ocr":[${Array.from({ length: 40 }, (_, n) => `{"text":"SYNTHETIC LINE ${n} ${"x".repeat(200)}"}`).join(",")}],`;
    try {
      for (let written = 0; written < size; lines++) {
        const at = 1_790_000_000_000 + lines * 2000;
        const line = `${frameLine(folderAt(at, lines), observation(at, "").replace('"ocr":[],', ocr))}\n`;
        writeSync(fd, line);
        written += Buffer.byteLength(line);
      }
    } finally {
      closeSync(fd);
    }
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { id: "d", source: RECORDER_SOURCE, sealed_ms: 1, stated_ms: 1, facts: {}, files: [{ path: "observations.jsonl", ...adopt(blobs, large) }] };
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "macos-app/screen/reader.ts", "screenRecorder", delivery));
    expect(measured.rows).toBe(lines);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("Gmail's Takeout mbox: memory grows with delivery size", () => {
    const dir = temp();
    const size = 16 * MiB;
    const path = join(dir, "export.mbox");
    const messages = largeMbox(path, size);
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { id: "d", source: "gmail:person-a@example.com:cloud", sealed_ms: 1, stated_ms: 1, facts: { sources: [{ id: "gmail:person-a@example.com:cloud", connector: "gmail-takeout" }] }, files: [{ path: "a.mbox", ...adopt(blobs, path) }] };
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { join } from "node:path";
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { gmail } from ${url("mail/gmail/reader.ts")};
      ${wholeReads([blobs.root])}
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(join(${JSON.stringify(dir)}, "blobs"));
      let rows = 0;
      for await (const row of gmail.read(${JSON.stringify(delivery)}, blobs)) rows++;
      console.log(JSON.stringify({ rows, largest: whole.largest() }));
    `);
    const measured = boundedRead<{ rows: number; largest: number }>(script);
    expect(measured.rows).toBe(messages + Math.min(500, messages));
    expect(measured.largest).toBeLessThanOrEqual(2 * MiB);
    artifact(dir, "memory.json", { ...measured, messages, heap_mib: HEAP_MiB, export_mib: size / MiB });
  });

  it("iMessage: memory grows with delivery size", async () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const large = join(dir, "large.db");
    imessageStore(large, Math.round(size / 4_100), 4_000);
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { ...(await imessageDelivery(blobs, IMESSAGE_SOURCE, T1, {})), files: [{ path: "messages.db", ...adopt(blobs, large) }] };
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { imessageConnector } from ${url("messages/imessage/reader.ts")};
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(${JSON.stringify(join(dir, "blobs"))});
      let rows = 0, bytes = 0;
      for await (const row of imessageConnector.read(${JSON.stringify(delivery)}, blobs)) { rows++; bytes += row.content.text?.length ?? 0; }
      console.log(JSON.stringify({ rows, bytes }));
    `);
    const measured = boundedRead<{ rows: number; bytes: number }>(script);
    expect(measured.bytes).toBeGreaterThan(size * 0.85);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("WhatsApp: memory grows with delivery size", async () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const large = join(dir, "large.sqlite");
    whatsappStore(large, Math.round(size / 4_100), 4_000);
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { ...(await whatsappDelivery(blobs, WHATSAPP_SOURCE, T1, {})), files: [{ path: "chats.sqlite", ...adopt(blobs, large) }] };
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { whatsappConnector } from ${url("messages/whatsapp/reader.ts")};
      const blobs = openHomeFolder(${JSON.stringify(dir)}).blobs(${JSON.stringify(join(dir, "blobs"))});
      let rows = 0, bytes = 0;
      for await (const row of whatsappConnector.read(${JSON.stringify(delivery)}, blobs)) { rows++; bytes += row.content.message?.ZTEXT?.length ?? 0; }
      console.log(JSON.stringify({ rows, bytes }));
    `);
    const measured = boundedRead<{ rows: number; bytes: number }>(script);
    expect(measured.bytes).toBeGreaterThan(size * 0.85);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("Google Photos Takeout: memory grows with delivery size", () => {
    const dir = temp();
    const count = 2 * HEAP_MiB;
    const album = "Takeout/Google Photos/Photos from 2026";
    const zip = join(dir, "takeout.zip");
    writeZip(zip, Array.from({ length: count }, (_, i) => [
      { name: `${album}/IMG_${i}.jpg`, bytes: () => [jpeg(undefined, `photo ${i}`), Buffer.alloc(MiB, i)] },
      { name: `${album}/IMG_${i}.jpg.supplemental-metadata.json`, bytes: sidecar(`IMG_${i}.jpg`, String(1788775200 + i)) },
    ]).flat());
    const delivery = deliver(openHomeFolder(dir).blobs(join(dir, "blobs")), PHOTOS_SOURCE, { "files/takeout.zip": zip }, {}, 1);
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "photos/google/reader.ts", "googlePhotosTakeout", delivery));
    expect(measured.rows).toBe(count);
    artifact(dir, "memory.json", { ...measured, photos: count, photo_mib: 1, heap_mib: HEAP_MiB });
  });

  it("Coast: memory grows with delivery size", () => {
    const dir = temp();
    const frames = Math.ceil((HEAP_MiB * MiB) / 6_000 / 50) * 50;
    const store = new FakeCoast(join(dir, "large.db"), "hash");
    store.video(1, "a".repeat(64));
    store.db.exec("BEGIN");
    for (let id = 1; id <= frames; id++) {
      if (id % 50 === 1) store.segment(id, id, 1, 1, "https://example.com/");
      store.frame(id, COAST_BASE + id * 2_000, id - ((id - 1) % 50), [1, id], `SYNTHETIC OCR ${"x".repeat(6_000)}`);
      if (id % 10 === 0) store.tree(id, COAST_BASE + id * 2_000);
    }
    store.db.exec("COMMIT");
    store.close();
    const blobs = openHomeFolder(dir).blobs(join(dir, "blobs"));
    const delivery = { id: "d", source: COAST_SOURCE, sealed_ms: 1, stated_ms: 1, facts: {}, files: [{ path: "coast.sqlite", ...adopt(blobs, join(dir, "large.db")) }] };
    const measured = boundedRead<{ rows: number }>(countingScript(dir, "screen/coast/reader.ts", "coast", delivery));
    expect(measured.rows).toBe(frames + frames / 50 + frames / 10);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, text_mib: (frames * 6_000) / MiB });
  });

  it("the shared SQLite reader: memory grows with the size of the database", () => {
    const dir = temp();
    const large = join(dir, "large.sqlite");
    const size = HEAP_MiB * MiB;
    chatStore(large, Math.round(size / 1_060), "hex(randomblob(500))");
    const script = childScript(dir, `
      import { openSqlite } from "./sqlite.ts";
      const db = openSqlite(${JSON.stringify(large)});
      let rows = 0, bytes = 0;
      for (const part of db.rows("ZWAMESSAGE", "Z_PK")) { rows++; bytes += part.read().ZTEXT.length; }
      for (const row of db.query("SELECT ZTEXT FROM ZWAMESSAGE")) { bytes += row.ZTEXT.length; }
      db.close();
      console.log(JSON.stringify({ rows, bytes }));
    `);
    const measured = boundedRead<{ rows: number; bytes: number }>(script);
    expect(measured.bytes).toBeGreaterThan(size * 1.8);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: size / MiB });
  });

  it("the shared ZIP reader: memory grows with the size of a member or the archive", () => {
    const dir = temp();
    const large = join(dir, "large.zip");
    const size = 16 * MiB;
    const stored = 4 * MiB;
    writeZip(large, [
      { name: "Takeout/Mail/All mail.mbox", bytes: () => exportLines(size), method: "deflate" },
      { name: "Takeout/Photos/video.mov", bytes: () => exportLines(stored) },
    ]);
    const script = childScript(dir, `
      import { createHash } from "node:crypto";
      import { openZip } from "./zip.ts";
      ${wholeReads([large])}
      const zip = openZip(${JSON.stringify(large)});
      const read = {};
      for (const entry of zip.entries()) {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of entry.stream()) { hash.update(chunk); bytes += chunk.length; }
        read[entry.name] = { bytes, sha256: hash.digest("hex") };
      }
      zip.close();
      console.log(JSON.stringify({ read, largest: whole.largest() }));
    `);
    const measured = boundedRead<{ read: Record<string, { bytes: number; sha256: string }>; largest: number }>(script);
    expect(measured.read["Takeout/Mail/All mail.mbox"]).toEqual({ bytes: size, sha256: sha(exportLines(size)) });
    expect(measured.read["Takeout/Photos/video.mov"]).toEqual({ bytes: stored, sha256: sha(exportLines(stored)) });
    expect(measured.largest).toBeLessThanOrEqual(2 * MiB);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, member_mib: size / MiB, archive_mib: statSync(large).size / MiB });
  });

  it("Instagram: memory grows with the size of a file", () => {
    const dir = temp();
    const target = 4 * HEAP_MiB * MiB;
    const zip = join(dir, "instagram.zip");
    let likes = 0;
    let follows = 0;
    const pad = "x".repeat(400);
    function* likedPosts(): Generator<Buffer> {
      yield Buffer.from("[");
      for (let written = 0; written < target / 2; likes++) {
        const chunk = Buffer.from(`${likes === 0 ? "" : ","}{"timestamp":${1757000000 + likes},"media":[],"label_values":[{"label":"URL","value":"${pad}","href":"https://www.instagram.com/p/${likes}/"}],"fbid":"${17900000000000000 + likes}"}`);
        written += chunk.length;
        yield chunk;
      }
      yield Buffer.from("]");
    }
    function* following(): Generator<Buffer> {
      yield Buffer.from('{\n  "relationships_following": [');
      for (let written = 0; written < target / 2; follows++) {
        const chunk = Buffer.from(`${follows === 0 ? "" : ","}{"title":"person-${follows}-${pad}","string_list_data":[{"href":"https://www.instagram.com/_u/person-${follows}","timestamp":${1757000000 + follows}}]}`);
        written += chunk.length;
        yield chunk;
      }
      yield Buffer.from("]\n}\n");
    }
    writeZip(zip, [
      { name: PROFILE, bytes: instagramMembers()[PROFILE]!, method: "deflate" },
      { name: "your_instagram_activity/likes/liked_posts.json", bytes: likedPosts, method: "deflate" },
      { name: "connections/followers_and_following/following.json", bytes: following, method: "deflate" },
    ]);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { closeSync, openSync, readSync } from "node:fs";
      import { instagram } from ${url("social/instagram/reader.ts")};
      const reader = ${archiveReader(zip)};
      const delivery = { id: "d", source: ${JSON.stringify(INSTAGRAM_SOURCE)}, sealed_ms: 1, stated_ms: 1, facts: {},
        files: [{ path: "instagram.zip", blob: "sha256:" + "0".repeat(64), size: 0 }] };
      const rows = {};
      for await (const row of instagram.read(delivery, reader)) rows[row.kind] = (rows[row.kind] ?? 0) + 1;
      console.log(JSON.stringify({ rows }));
    `);
    const measured = boundedRead<{ rows: Record<string, number> }>(script);
    expect(measured.rows).toEqual({ like: likes, follow: follows });
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, file_mib: target / MiB });
  });

  it("X: memory grows with the size of a data file, or a media file past a whole read's limit is held whole or not stored", () => {
    const dir = temp();
    const target = 2 * HEAP_MiB * MiB;
    let posts = 0;
    function* tweets(): Generator<Buffer> {
      yield Buffer.from("window.YTD.tweets.part0 = [");
      const pad = "x".repeat(400);
      for (let written = 0; written < target; ) {
        const id = String(1800000000000000000n + BigInt(posts + 1));
        const second = String(posts % 60).padStart(2, "0");
        const chunk = Buffer.from(`${posts === 0 ? "" : ","}{"tweet":{"id_str":"${id}","id":"${id}","created_at":"Tue Sep 01 08:00:${second} +0000 2026","full_text":"synthetic ${posts} ${pad}","entities":{"hashtags":[],"urls":[]}}}`);
        written += chunk.length;
        posts++;
        yield chunk;
      }
      yield Buffer.from("]");
    }
    const videoBytes = BYTES_LIMIT + 1;
    const video = createHash("sha256");
    function* clip(): Generator<Buffer> {
      const block = Buffer.alloc(MiB, 7);
      for (let left = videoBytes; left > 0; left -= MiB) {
        const chunk = left >= MiB ? block : block.subarray(0, left);
        video.update(chunk);
        yield chunk;
      }
    }
    const zip = join(dir, X_ZIP);
    const small = archiveMembers();
    writeZip(zip, [
      { name: "data/manifest.js", bytes: small["data/manifest.js"]! },
      { name: "data/account.js", bytes: small["data/account.js"]! },
      { name: "data/tweets.js", bytes: tweets, method: "deflate" },
      { name: "data/tweets_media/1800000000000000001-SyntheticLongClip.mp4", bytes: clip, method: "deflate" },
    ]);
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { createHash } from "node:crypto";
      import { closeSync, openSync, readSync } from "node:fs";
      import { xArchive } from ${url("social/x/reader.ts")};
      const reader = ${archiveReader(zip)};
      const delivery = { id: "d", source: ${JSON.stringify(X_SOURCE)}, sealed_ms: 1, stated_ms: 1, facts: {},
        files: [{ path: ${JSON.stringify(X_ZIP)}, blob: "sha256:" + "0".repeat(64), size: 0 }] };
      const before = process.resourceUsage().maxRSS;
      let rows = 0;
      let clip;
      for await (const row of xArchive.read(delivery, reader)) {
        if (rows++ > 0) continue;
        // The clip's bytes as the home stores them, read again in chunks while the read runs.
        const stored = [];
        for (const each of row.streamed ?? []) {
          const digest = createHash("sha256");
          let size = 0;
          for await (const chunk of each.chunks()) { digest.update(chunk); size += chunk.length; }
          stored.push({ hash: each.hash, size: each.size, read: "sha256:" + digest.digest("hex"), bytes: size });
        }
        clip = { blobs: row.blobs, listed: row.content.blobs, carried: row.bytes?.length ?? 0, stored };
      }
      console.log(JSON.stringify({ rows, clip, grew_mib: Math.round((process.resourceUsage().maxRSS - before) / 1024) }));
    `);
    const measured = boundedRead<{ rows: number; clip: { blobs: string[]; listed: JsonObject[]; carried: number; stored: JsonObject[] }; grew_mib: number }>(script);
    expect(measured.rows).toBe(posts);
    const name = `sha256:${video.digest("hex")}`;
    expect(measured.clip).toEqual({
      blobs: [name], listed: [{ hash: name, bytes: videoBytes, media_type: "video/mp4", role: "attachment", file: "1800000000000000001-SyntheticLongClip.mp4" }], carried: 0,
      stored: [{ hash: name, size: videoBytes, read: name, bytes: videoBytes }],
    });
    expect(measured.grew_mib).toBeLessThan((target + videoBytes) / MiB);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, tweets_mib: target / MiB, clip_mib: videoBytes / MiB });
  });

  it("Wispr Flow: memory grows with delivery size", () => {
    const dir = temp();
    const size = HEAP_MiB * MiB;
    const path = join(dir, "large.sqlite");
    createFlowStore(path, []);
    const text = "synthetic words ".repeat(1024);
    const audio = Buffer.alloc(1024, 7);
    const db = new Database(path);
    const insert = db.prepare("INSERT INTO History (transcriptEntityId, formattedText, timestamp, audio) VALUES (?, ?, ?, ?)");
    const count = Math.round(size / text.length);
    db.transaction(() => {
      for (let n = 0; n < count; n++) insert.run(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, `${n} ${text}`, `${WISPR_DAY} 08:00:00.000 +00:00`, audio);
    })();
    db.close();
    const home = openTestHome();
    const delivery = { ...deliver(home, WISPR_SOURCE, {}, WISPR_SNAPSHOT), files: [{ path: WISPR_FILE, ...adopt(home.blobs, path) }] };
    const script = join(dir, "child.mts");
    writeFileSync(script, `
      import { openHomeFolder } from ${url("../core/index.ts")};
      import { wisprFlow } from ${url("voice/wispr-flow/reader.ts")};
      const blobs = openHomeFolder(${JSON.stringify(home.dir)}).blobs(${JSON.stringify(join(home.dir, "blobs"))});
      let rows = 0, chars = 0, bytes = 0;
      for await (const row of wisprFlow.read(${JSON.stringify(delivery)}, blobs)) {
        rows++; chars += row.content.History.formattedText.length; bytes += row.bytes?.[0]?.length ?? 0;
      }
      console.log(JSON.stringify({ rows, chars, bytes }));
    `);
    const measured = boundedRead<{ rows: number; chars: number; bytes: number }>(script);
    expect(measured.rows).toBe(count);
    expect(measured.chars).toBeGreaterThan(size);
    expect(measured.bytes).toBe(count * audio.length);
    artifact(dir, "memory.json", { ...measured, heap_mib: HEAP_MiB, text_mib: size / MiB });
  });
});
