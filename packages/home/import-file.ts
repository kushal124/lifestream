import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { BlobStore, HomeFolder } from "@lifestreamprotocol/core";
import { imports as declaredImports } from "@lifestreamprotocol/connect";
import { basicInstant, deliveryDirectory, isSegment, openSealing, type SealDisk, type Sealing } from "./inbox.js";
import { kindsOf } from "./import.js";
import type { Registry } from "./registry.js";

export const IMPORT_LANE = "import";
const IMPORT_FEEDER = "import-home";

export interface Handed {
  readonly path: string;
  put(sealing: Sealing): Promise<unknown>;
}

export function filesAt(path: string, adopt = false): Handed[] {
  const name = basename(path);
  const handed = (at: string, from: string): Handed => ({
    path: at,
    put: async (sealing) => (adopt ? sealing.adopt(at, from, await measured(from)) : sealing.write(at, createReadStream(from))),
  });
  if (!statSync(path).isDirectory()) return [handed(`files/${name}`, path)];
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).filter((entry) => !entry.name.startsWith(".")).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []));
  const files = walk(path).sort().map((file) => handed(`files/${name}/${relative(path, file).split("\\").join("/")}`, file));
  if (files.length === 0) throw new Error(`${path} holds no file`);
  return files;
}

export function blobHanded(name: string, blob: string, blobs: Pick<BlobStore, "stream">): Handed {
  const at = `files/${handedName(name, blob)}`;
  return { path: at, put: (sealing) => sealing.write(at, blobs.stream(blob)) };
}

function handedName(name: string, blob: string): string {
  const last = name.slice(name.lastIndexOf("/") + 1);
  return isSegment(last) ? last : blob.replace(/^sha256:/u, "");
}

export async function sealImport(folder: HomeFolder, registry: Pick<Registry, "connectors" | "readers">, kind: string, files: readonly Handed[], at_ms: number, disk?: SealDisk): Promise<string> {
  if (declaredImports.importKind(kindsOf(registry), kind) === undefined) {
    throw new Error(`${kind} is no import kind of this home: ${kindsOf(registry).map((each) => each.id).sort().join(", ")}`);
  }
  if (files.length === 0) throw new Error("an import holds no file");
  let at = at_ms;
  while (existsSync(deliveryDirectory(folder, IMPORT_LANE, basicInstant(new Date(at).toISOString())))) at++;
  const fetched_at = new Date(at).toISOString();
  const name = basicInstant(fetched_at);
  const sealing = openSealing(folder, { source: IMPORT_LANE, name, feeder: IMPORT_FEEDER, fetched_at }, disk);
  try {
    for (const file of files) await file.put(sealing);
    sealing.seal({ import: { kind }, history: true });
  } catch (error) {
    sealing.abandon();
    throw error;
  }
  return `${IMPORT_LANE}/${name}`;
}

async function measured(file: string): Promise<{ sha256: string; bytes: number }> {
  const digest = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    digest.update(chunk);
    bytes += chunk.byteLength;
  }
  return { sha256: digest.digest("hex"), bytes };
}
