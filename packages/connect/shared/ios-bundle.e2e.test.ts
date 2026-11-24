import { artifact, temp, writeZip, type FixtureMember } from "../test/drive.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { iosBundleSources } from "../index.js";
import { BUNDLE_ENTRIES, iosDomainEntries, readIosBundle, verifyIosBundle } from "./ios-bundle.js";
import { CodedRefused, Refused } from "./refused.js";
import { openZip } from "./zip.js";

const INSTALL = "00000000-0000-0000-0000-0000000000a1";
const UNIT = "iphone-aa01";
const hash = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function sorted(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sorted).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${sorted(object[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function domainLines(domain: string, first: number, count: number): Buffer {
  const lines: string[] = [];
  for (let sequence = first; sequence < first + count; sequence++) {
    lines.push(JSON.stringify({
      domain,
      kind: domain === "location" ? "fix" : "activity",
      sequence,
      captured: { wall_rfc3339: `2026-10-03T08:${String(sequence % 60).padStart(2, "0")}:00+05:30` },
      payload: { latitude: 12.5 + sequence / 1000, longitude: 77.25, note: "fake" },
    }));
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

interface Build {
  files: Record<string, Buffer>;
  edit?: (manifest: Record<string, unknown>) => void;
  tamper?: Record<string, Buffer>;
  extra?: Record<string, Buffer>;
  omit?: string[];
  stateId?: (computed: string) => string;
}

function bundle(dir: string, name: string, build: Build): string {
  const files: Record<string, unknown> = {};
  for (const [file, bytes] of Object.entries(build.files)) {
    const lines = file.endsWith(".jsonl") ? bytes.toString().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sequence: number }) : [];
    files[file] = {
      sha256: hash(bytes),
      bytes: bytes.length,
      observations: lines.length,
      ...(lines.length === 0 ? {} : { first_sequence: lines[0]!.sequence, last_sequence: lines[lines.length - 1]!.sequence }),
    };
  }
  const manifest: Record<string, unknown> = {
    schema_version: 3,
    device: {
      machine_model: "iPhoneSynthetic,1",
      marketing_name: "Synthetic iPhone",
      os_version: "SyntheticOS 1.0",
      install_id: INSTALL,
      enrolled_at: "2026-08-31T09:00:00+05:30",
    },
    app_version: "1.0 (1)",
    created_at: "2026-10-03T09:00:00.250+05:30",
    time_range_covered: { start: "2026-10-03T08:00:00+05:30", end: "2026-10-03T09:00:00+05:30" },
    files,
  };
  build.edit?.(manifest);
  const id = hash(Buffer.from(sorted(manifest)));
  manifest.bundle_id = build.stateId?.(id) ?? id;
  const members: FixtureMember[] = [{ name: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) }];
  for (const [file, bytes] of Object.entries(build.files)) {
    if (build.omit?.includes(file)) continue;
    members.push({ name: file, bytes: build.tamper?.[file] ?? bytes, method: file.endsWith(".jsonl") ? "deflate" : "stored" });
  }
  for (const [file, bytes] of Object.entries(build.extra ?? {})) members.push({ name: file, bytes });
  const path = join(dir, `${name}.zip`);
  writeZip(path, members);
  return path;
}

async function code(path: string): Promise<string> {
  try {
    await verifyIosBundle(path);
    return "verified";
  } catch (error) {
    if (error instanceof Refused) return error instanceof CodedRefused ? error.code : "words";
    throw error;
  }
}

const photo = Buffer.from("fake jpeg bytes from iphone-aa01");
const blobName = `blobs/${hash(photo).slice(7)}`;
const healthy = (): Record<string, Buffer> => ({
  "location.jsonl": domainLines("location", 41, 30),
  "motion.jsonl": domainLines("motion", 7, 3),
  "camera.jsonl": Buffer.alloc(0),
  "orbit.jsonl": domainLines("orbit", 1, 1),
  [blobName]: photo,
});

function listing(path: string, count: number): string {
  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE(45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeUInt32LE(1, 16);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.fill(0xff, 4, 20);
  writeFileSync(path, Buffer.concat([record, locator, end]));
  return path;
}

describe("the iOS bundle verifier: each of these is impossible", () => {
  it("a bundle that lists more members than the bound is opened and its members mapped", async () => {
    const dir = temp("ios-bundle-entries-");
    const refusal = (path: string) => verifyIosBundle(path).then(() => "verified", (error: unknown) => error instanceof Refused ? [error instanceof CodedRefused ? error.code : undefined, error.message] : "threw");
    const over = listing(join(dir, "over.zip"), BUNDLE_ENTRIES + 1);
    expect(await refusal(over)).toEqual(["BUNDLE_ENTRY", `${over} lists ${BUNDLE_ENTRIES + 1} members; a bundle holds at most ${BUNDLE_ENTRIES}`]);
    const at = listing(join(dir, "at.zip"), BUNDLE_ENTRIES);
    expect(await refusal(at)).toEqual(["ZIP", expect.stringContaining("the central directory is shorter than its records")]);
  });


  it("a bundle verifies with a member whose bytes differ from its manifest", async () => {
    const dir = temp();
    const good = bundle(dir, "good", { files: healthy() });
    const location = healthy()["location.jsonl"]!;
    const flipped = Buffer.from(location);
    flipped[100] = flipped[100] === 0x31 ? 0x32 : 0x31;
    const tampered = bundle(dir, "tampered", { files: healthy(), tamper: { "location.jsonl": flipped } });
    const tamperedBlob = bundle(dir, "blob", { files: healthy(), tamper: { [blobName]: Buffer.from("fake jpeg bytes from iphone-aa02") } });
    const verified = await verifyIosBundle(good);
    const codes = [await code(tampered), await code(tamperedBlob)];
    expect(codes).toEqual(["BUNDLE_INTEGRITY", "BUNDLE_INTEGRITY"]);
    expect(verified.blobs).toEqual([hash(photo)]);
    artifact(dir, "tampered.json", { verified: verified.bundle_id, codes });
  });

  it("a bundle verifies after its manifest was edited", async () => {
    const dir = temp();
    const edited = bundle(dir, "edited", { files: healthy(), stateId: () => hash(Buffer.from("another manifest")) });
    const wrongCount = bundle(dir, "count", {
      files: healthy(),
      edit: (manifest) => {
        ((manifest.files as Record<string, Record<string, number>>)["location.jsonl"]!).observations = 29;
      },
    });
    const wrongRange = bundle(dir, "range", {
      files: healthy(),
      edit: (manifest) => {
        ((manifest.files as Record<string, Record<string, number>>)["motion.jsonl"]!).first_sequence = 6;
      },
    });
    const codes = [await code(edited), await code(wrongCount), await code(wrongRange)];
    expect(codes).toEqual(["BUNDLE_INTEGRITY", "BUNDLE_INTEGRITY", "BUNDLE_INTEGRITY"]);
    artifact(dir, "edited.json", codes);
  });

  it("a bundle verifies at a schema version other than 3", async () => {
    const dir = temp();
    const codes: string[] = [];
    for (const version of [1, 2, 4, "3"]) {
      codes.push(await code(bundle(dir, `version-${String(version)}`, { files: healthy(), edit: (manifest) => { manifest.schema_version = version; } })));
    }
    expect(codes).toEqual(["BUNDLE_MANIFEST", "BUNDLE_MANIFEST", "BUNDLE_MANIFEST", "BUNDLE_MANIFEST"]);
    artifact(dir, "versions.json", codes);
  });

  it("a bundle verifies with a member its manifest does not list, or without one it lists", async () => {
    const dir = temp();
    const extra = bundle(dir, "extra", { files: healthy(), extra: { "notes.txt": Buffer.from("fake") } });
    const missing = bundle(dir, "missing", { files: healthy(), omit: ["motion.jsonl"] });
    const misnamed = bundle(dir, "misnamed", { files: { ...healthy(), "blobs/0123": photo } });
    const noBlob = bundle(dir, "no-blob", { files: healthy(), omit: [blobName] });
    const codes = [await code(extra), await code(missing), await code(misnamed), await code(noBlob)];
    expect(codes).toEqual(["BUNDLE_MANIFEST", "BUNDLE_MANIFEST", "BUNDLE_MANIFEST", "BUNDLE_MANIFEST"]);
    const zip = openZip(noBlob);
    try {
      expect(readIosBundle(zip).blobs).toEqual([hash(photo)]);
    } finally {
      zip.close();
    }
    artifact(dir, "topology.json", codes);
  });

  it("a bundle states a derived source it does not carry, or hides one it does", async () => {
    const dir = temp();
    const verified = await verifyIosBundle(bundle(dir, "good", { files: healthy() }));
    const sources = iosBundleSources(verified, { unit: UNIT, apple_id: "person-a" });
    expect(sources).toEqual([
      { domain: "camera", file: "camera.jsonl", source: `camera:local:${UNIT}` },
      { domain: "location", file: "location.jsonl", source: `location:local:${UNIT}` },
      { domain: "motion", file: "motion.jsonl", source: `motion:local:${UNIT}` },
      { domain: "orbit", file: "orbit.jsonl", source: null },
    ]);
    artifact(dir, "sources.json", sources);
  });

  it("a domain's entries read out of sequence, from another domain, or past what the manifest states", async () => {
    const dir = temp();
    const shuffled = domainLines("motion", 7, 3).toString().split("\n");
    [shuffled[0], shuffled[1]] = [shuffled[1]!, shuffled[0]!];
    const wrongDomain = Buffer.from(domainLines("location", 7, 3).toString());
    const paths = {
      good: bundle(dir, "good", { files: healthy() }),
      shuffled: bundle(dir, "shuffled", { files: { ...healthy(), "motion.jsonl": Buffer.from(shuffled.join("\n")) } }),
      foreign: bundle(dir, "foreign", { files: { ...healthy(), "motion.jsonl": wrongDomain } }),
    };
    const read = async (path: string): Promise<string[]> => {
      const zip = openZip(path);
      try {
        const opened = readIosBundle(zip);
        const out: string[] = [];
        for await (const part of iosDomainEntries(zip, opened, "motion")) {
          const { line, sequence } = part.read();
          out.push(`${line}:${sequence}`);
        }
        return out;
      } finally {
        zip.close();
      }
    };
    expect(await read(paths.good)).toEqual(["1:7", "2:8", "3:9"]);
    const codes: string[] = [];
    for (const path of [paths.shuffled, paths.foreign]) {
      try {
        await read(path);
        codes.push("read");
      } catch (error) {
        codes.push(error instanceof Refused ? (error instanceof CodedRefused ? error.code : "words") : "threw");
      }
    }
    expect(codes).toEqual(["BUNDLE_ENTRY", "BUNDLE_ENTRY"]);
    const zip = openZip(paths.good);
    try {
      const none: unknown[] = [];
      for await (const entry of iosDomainEntries(zip, readIosBundle(zip), "voice")) none.push(entry);
      expect(none).toEqual([]);
    } finally {
      zip.close();
    }
    artifact(dir, "entries.json", { good: await read(paths.good), codes });
  });
});
