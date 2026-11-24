import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WAITING, type JsonObject } from "@lifestreamprotocol/core";
import type { ConnectorReport, StreamsReport } from "../streams-report.js";
import { askHome } from "../socket.js";
import { testSocket } from "./folder.js";
import { makeRoot, readHome, REPO, until } from "./harness-root.js";
import { ship } from "./harness-deliveries.js";

export const UNIT = "macbook-pro-0001";
export const GOOGLE = "google-photos:person-a@example.com:export";
export const WHATSAPP = "whatsapp:+15550000001:iphone-aa01";
export const PEOPLE = `people:local:${UNIT}`;
export const FACES = `faces:local:${UNIT}`;
export const REGISTRY = new URL("./faces-registry.ts", import.meta.url);
const FAKE = join(REPO, "packages", "connect", "labelers", "faces", "test", "fake-engine.mjs");
export const LEFT = [100, 100, 300, 300];
let enginesDir: string | undefined;
function enginePath(): string {
  if (enginesDir === undefined || !existsSync(join(enginesDir, "face-engine"))) {
    enginesDir = mkdtempSync(join(tmpdir(), "lifestream-faces-engine-"));
    writeFileSync(join(enginesDir, "face-engine"), `#!/bin/sh\nFAKE_ENGINE_DIR="$(dirname "$0")" exec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  }
  return join(enginesDir, "face-engine");
}
export const removeEngine = (): void => {
  if (enginesDir !== undefined) rmSync(enginesDir, { recursive: true, force: true });
  enginesDir = undefined;
};
const PIPELINE = { version: 1, detector: "fake-detector", recognizer: "fake-recognizer", detect_size: 1280, detect_threshold: 0.45, overlap_threshold: 0.4, tiers: [] };

export const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const CAMERA_JPEG = readFileSync(join(REPO, "packages", "families", "photos", "test", "golden", "p4.jpg"));
export const faceKey = (hex: string) => `${hex}:${LEFT.join(",")}`;

export function facesRoot(prefix: string, photos: Record<string, number>, options: { settings?: JsonObject; camera?: true; models?: false } = {}): { root: string; photos: Record<string, { hex: string; bytes: Buffer }> } {
  const root = makeRoot(prefix, { sources: { [GOOGLE]: "fake-rows", [WHATSAPP]: "fake-rows", [PEOPLE]: "people-home" }, settings: { unit: UNIT, ...options.settings } });
  const engine = join(root, "engine");
  mkdirSync(engine, { recursive: true });
  symlinkSync(enginePath(), join(engine, "face-engine"));
  const models = join(root, "tools", "faces", "models", "buffalo_l");
  mkdirSync(models, { recursive: true });
  if (options.models !== false) for (const file of ["det_10g.onnx", "w600k_r50.onnx"]) writeFileSync(join(models, file), `synthetic ${file}`);
  const made: Record<string, { hex: string; bytes: Buffer }> = {};
  const faces: Record<string, unknown> = {};
  for (const [name, tag] of Object.entries(photos)) {
    const bytes = Buffer.concat([options.camera === true ? CAMERA_JPEG : Buffer.alloc(0), Buffer.from(`synthetic photo ${name}`)]);
    made[name] = { hex: sha256(bytes), bytes };
    faces[made[name].hex] = tag === 0 ? [] : [{ box: LEFT, tier: "seed", tag }];
  }
  writeFileSync(join(engine, "engine.json"), JSON.stringify({ pipeline: PIPELINE, faces }));
  return { root, photos: made };
}

export async function shipPhotos(root: string, photos: { hex: string; bytes: Buffer }[], at: number): Promise<void> {
  await ship(root, {
    source: GOOGLE, fetched_ms: at,
    rows: photos.map(({ hex }, index) => ({
      kind: "img", key: hex, at: at - 60_000 * (index + 1), blobs: [`sha256:${hex}`],
      content: { type: "photos.asset", blobs: [{ hash: `sha256:${hex}`, bytes: 24, media_type: "image/jpeg", role: "original" }] },
    })),
    carried: Object.fromEntries(photos.map(({ hex, bytes }) => [hex, bytes])),
  });
}

export function head(root: string, kind: string, key: string): Record<string, unknown> | undefined {
  return readHome(root, (db) => {
    const row = db.prepare("SELECT v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = ? AND h.key = ?").pluck().get(FACES, kind, key) as string | undefined;
    return row === undefined ? undefined : (JSON.parse(row) as { content: Record<string, unknown> }).content;
  });
}

export async function eventually<T>(what: string, read: () => Promise<T | undefined | false>): Promise<T> {
  let value: T | undefined | false;
  await until(what, async () => (value = await read()) !== undefined && value !== false);
  return value as T;
}

export const heads = (root: string, kind: string): number =>
  readHome(root, (db) => db.prepare("SELECT count(*) FROM heads WHERE source = ? AND kind = ? AND version <> 'gone'").pluck().get(FACES, kind) as number);
export const facesRow = async (root: string): Promise<ConnectorReport> =>
  (await askHome(testSocket(root), "connectors") as StreamsReport).connectors.find((connector) => connector.id === "faces")!;
export const calls = (root: string): string[] => {
  const log = join(root, "engine", "calls.log");
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((line) => line !== "") : [];
};
export const scans = (root: string): string[][] => calls(root).filter((line) => line.startsWith("scan ")).map((line) => (JSON.parse(line.slice(5)) as { photos: { key: string }[] }).photos.map((photo) => photo.key))
  .filter((keys) => keys.length > 0);
export const resting = (root: string): string | undefined =>
  (readHome(root, (db) => db.prepare("SELECT json_extract(facts, '$.rest') FROM attempts WHERE target = 'label:faces' AND outcome <> 'ok' LIMIT 1").pluck().get()) as string | null | undefined) ?? undefined;
export const waiting = (root: string, source: string): number =>
  readHome(root, (db) => db.prepare(`SELECT count(*) FROM deliveries WHERE source = ? AND state IN ${WAITING}`).pluck().get(source) as number);
export const naming = (hex: string) => {
  const lines = [
    { kind: "person", key: "person-a", content: { type: "people.person", slug: "person-a", name: "Person A", handles: [{ kind: "name", value: "Person A", by: "subject", since: "2026-10-01T00:00:00.000Z" }], excluded: [], merged_into: null } },
    { kind: "face", key: faceKey(hex), content: { is: "person-a" } },
  ];
  return { "statements.ndjson": Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")) };
};
export const FETCH = (engine: string) => `#!/bin/sh
echo fetched >> '${join(engine, "fetch.log")}'
while [ ! -e '${join(engine, "go")}' ]; do sleep 0.05; done
mkdir -p "$1" && echo synthetic > "$1/det_10g.onnx" && echo synthetic > "$1/w600k_r50.onnx"
`;
export const personOf = (root: string, hex: string): string => readHome(root, (db) => {
  const named = db.prepare("SELECT h.key, v.text FROM heads h JOIN versions v ON v.id = h.version WHERE h.source = ? AND h.kind = 'named'").all(FACES) as { key: string; text: string }[];
  return named.find(({ text }) => (JSON.parse(text) as { content: { photos: { face: string }[] } }).content.photos.some((photo) => photo.face === faceKey(hex)))?.key ?? "";
});
