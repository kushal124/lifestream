import { createHash } from "node:crypto";
import { parse, type JsonObject } from "@lifestreamprotocol/core";
import { parseLineAs } from "./lanes.js";
import { lines, LineSplitter, lineText } from "./lines.js";
import { Refused, refuseAs } from "./refused.js";
import { instantMs } from "./delivery.js";
import { openZip, type ZipSource } from "./zip.js";
import type { Connector } from "../declaration.js";

export interface IosManifestFile {
  sha256: string;
  bytes: number;
  observations: number;
  first_sequence?: number;
  last_sequence?: number;
}

export interface IosBundle {
  manifest: JsonObject;
  bundle_id: string;
  created_at: string;
  files: Record<string, IosManifestFile>;
  domains: { domain: string; file: string; declared: IosManifestFile }[];
  blobs: string[];
  sat_out: string[];
}

export interface VerifiedIosBundle extends IosBundle {
  carried: Record<string, string[]>;
}

export interface IosMember {
  readonly name: string;
  readonly size: number;
  bytes(limit?: number): Buffer;
  stream(): AsyncIterable<Buffer>;
}

export interface IosMembers {
  readonly path: string;
  entries(): Iterable<IosMember>;
  entry(name: string): IosMember | undefined;
}

const MANIFEST_LIMIT = 16 * 1024 * 1024;
export const BUNDLE_ENTRIES = 250_000;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const BLOB = /^blobs\/([0-9a-f]{64})$/u;
const DOMAIN = /^([a-z][a-z0-9_-]*)\.jsonl$/u;

export const domainOf = (connector: Connector): string => connector.phone?.domain ?? connector.product;

export function readIosBundle(members: IosMembers): IosBundle {
  return opened(members).bundle;
}

function opened(members: IosMembers): { bundle: IosBundle; listed: Map<string, IosMember> } {
  const listed = new Map<string, IosMember>();
  for (const entry of members.entries()) {
    if (listed.has(entry.name)) refuseAs(`${members.path} holds ${entry.name} twice`, "BUNDLE_MANIFEST");
    listed.set(entry.name, entry);
  }
  const member = listed.get("manifest.json");
  if (member === undefined) refuseAs(`${members.path} has no manifest.json`, "BUNDLE_MANIFEST");
  const text = member.bytes(MANIFEST_LIMIT).toString("utf8");
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return refuseAs(`manifest.json does not parse: ${(error as Error).message}`, "BUNDLE_MANIFEST");
  }
  const manifest = object(parsed, "manifest");
  const { bundle_id: stated, ...identity } = manifest;
  if (typeof stated !== "string" || !SHA256.test(stated)) refuseAs("manifest.bundle_id must be sha256 and 64 hex digits", "BUNDLE_MANIFEST");
  const computed = `sha256:${createHash("sha256").update(sortedJson(identity)).digest("hex")}`;
  if (computed !== stated) refuseAs(`manifest.bundle_id ${stated} is not its manifest's ${computed}`, "BUNDLE_INTEGRITY");
  if (manifest.schema_version !== 3) refuseAs(`schema_version ${JSON.stringify(manifest.schema_version)} is not 3`, "BUNDLE_MANIFEST");
  const device = object(manifest.device, "manifest.device");
  if (typeof device.install_id !== "string" || device.install_id.length === 0) refuseAs("manifest.device.install_id is missing", "BUNDLE_MANIFEST");
  if (typeof manifest.created_at !== "string" || instantMs(manifest.created_at) === undefined) {
    refuseAs("manifest.created_at must be a full RFC 3339 instant", "BUNDLE_MANIFEST");
  }
  const files: Record<string, IosManifestFile> = {};
  for (const [name, value] of Object.entries(object(manifest.files, "manifest.files"))) files[name] = manifestFile(name, value);
  if (Object.keys(files).length === 0) refuseAs("manifest.files is empty", "BUNDLE_MANIFEST");
  const satOut = manifest.sat_out ?? [];
  if (!Array.isArray(satOut) || satOut.some((source, index) => typeof source !== "string" || satOut.indexOf(source) !== index)) {
    refuseAs("manifest.sat_out must be a list of source ids, each once", "BUNDLE_MANIFEST");
  }

  for (const name of listed.keys()) {
    if (name !== "manifest.json" && files[name] === undefined) refuseAs(`${name} is a member the manifest does not list`, "BUNDLE_MANIFEST");
  }
  const domains: IosBundle["domains"] = [];
  const blobs: string[] = [];
  for (const [name, declared] of Object.entries(files)) {
    const entry = listed.get(name);
    const blob = BLOB.exec(name);
    const domain = DOMAIN.exec(name);
    if (entry === undefined && blob === null) refuseAs(`the manifest lists ${name}, which the bundle does not hold`, "BUNDLE_MANIFEST");
    if (entry !== undefined && entry.size !== declared.bytes) refuseAs(`${name} holds ${entry.size} bytes; the manifest states ${declared.bytes}`, "BUNDLE_INTEGRITY");
    if (blob !== null) {
      if (declared.sha256 !== `sha256:${blob[1]}`) refuseAs(`${name} is listed with another hash, ${declared.sha256}`, "BUNDLE_MANIFEST");
      blobs.push(declared.sha256);
    } else if (domain !== null) {
      domains.push({ domain: domain[1]!, file: name, declared });
    } else {
      refuseAs(`${name} is neither a domain file nor blobs/<sha256>`, "BUNDLE_MANIFEST");
    }
  }
  domains.sort((left, right) => (left.domain < right.domain ? -1 : 1));
  return { bundle: { manifest, bundle_id: stated, created_at: manifest.created_at as string, files, domains, blobs, sat_out: satOut as string[] }, listed };
}

export async function verifyIosBundle(path: string, source?: ZipSource): Promise<VerifiedIosBundle> {
  const zip = openZip(path, undefined, source);
  try {
    if (zip.count > BUNDLE_ENTRIES) refuseAs(`${path} lists ${zip.count} members; a bundle holds at most ${BUNDLE_ENTRIES}`, "BUNDLE_ENTRY");
    const { bundle, listed } = opened(zip);
    const carried: Record<string, string[]> = {};
    for (const [name, declared] of Object.entries(bundle.files)) {
      const entry = listed.get(name) ?? refuseAs(`the manifest lists ${name}, which the bundle does not hold`, "BUNDLE_MANIFEST");
      const hash = createHash("sha256");
      const domain = bundle.domains.find((candidate) => candidate.file === name);
      const check = domain === undefined ? undefined : domainCheck(domain.domain, declared);
      const splitter = new LineSplitter();
      const files = new Set<string>();
      let count = 0;
      for await (const chunk of entry.stream()) {
        hash.update(chunk as Buffer);
        if (check === undefined) continue;
        for (const line of splitter.push(chunk as Buffer)) {
          const read = check.placed(line, ++count);
          if (read !== undefined) for (const file of carriedBy(read)) files.add(file);
        }
      }
      if (`sha256:${hash.digest("hex")}` !== declared.sha256) refuseAs(`${name} does not hash to what the manifest states`, "BUNDLE_INTEGRITY");
      if (check !== undefined) {
        if (splitter.end() !== undefined) refuseAs(`${name} ends inside a line`, "BUNDLE_INTEGRITY");
        check.end(count);
        carried[domain!.domain] = [...files];
      }
    }
    return { ...bundle, carried };
  } finally {
    zip.close();
  }
}

export interface IosEntryLine {
  readonly line: number;
  readonly where: string;
  readonly bytes: Buffer;
  read(): IosEntry;
}

export interface IosEntry {
  line: number;
  sequence: number;
  entry: JsonObject;
}

export async function* iosDomainEntries(members: IosMembers, bundle: IosBundle, domain: string): AsyncGenerator<IosEntryLine> {
  const file = `${domain}.jsonl`;
  const declared = bundle.files[file];
  if (declared === undefined) return;
  const entry = members.entry(file);
  if (entry === undefined) refuseAs(`the manifest lists ${file}, which the bundle does not hold`, "BUNDLE_MANIFEST");
  const check = domainCheck(domain, declared);
  let count = 0;
  for await (const bytes of lines(entry.stream())) {
    const line = ++count;
    yield { line, where: `${file} line ${line}`, bytes, read: () => check.line(bytes, line) };
  }
  check.end(count);
}

function oneClock(entry: JsonObject): boolean {
  const captured = entry.captured;
  const clock = captured !== null && typeof captured === "object" && !Array.isArray(captured) ? captured : {};
  const boot = entry.boot_id !== undefined || clock.monotonic_seconds !== undefined;
  return boot ? entry.boot_id !== undefined && clock.monotonic_seconds !== undefined && clock.elapsed_seconds === undefined : true;
}

function domainCheck(domain: string, declared: IosManifestFile): {
  line(bytes: Buffer, line: number): IosEntry; placed(bytes: Buffer, line: number): JsonObject | undefined; end(count: number): void;
} {
  const file = `${domain}.jsonl`;
  const place = (sequence: number, line: number, where: string): void => {
    const placed = declared.first_sequence === undefined ? undefined : declared.first_sequence + line - 1;
    if (sequence !== placed) {
      refuseAs(
        line === 1 ? `${file} starts at sequence ${sequence}; the manifest states ${String(declared.first_sequence)}` : `${where} has sequence ${sequence}; its place states ${String(placed)}`,
        line === 1 ? "BUNDLE_INTEGRITY" : "BUNDLE_ENTRY",
      );
    }
  };
  const read = (bytes: Buffer, where: string): JsonObject => parseLineAs(lineText(bytes, where), where, "BUNDLE_ENTRY");
  return {
    line(bytes, line) {
      const where = `${file} line ${line}`;
      const entry = read(bytes, where);
      if (entry.domain !== domain) refuseAs(`${where} states domain ${JSON.stringify(entry.domain)}`, "BUNDLE_ENTRY");
      if (!oneClock(entry)) {
        refuseAs(`${where} mixes its clocks; a line states captured.elapsed_seconds and no boot, or boot_id with captured.monotonic_seconds`, "BUNDLE_ENTRY");
      }
      const sequence = entry.sequence;
      if (!positive(sequence)) refuseAs(`${where} has no positive integer sequence`, "BUNDLE_ENTRY");
      place(sequence, line, where);
      return { line, sequence, entry };
    },
    placed(bytes, line) {
      const where = `${file} line ${line}`;
      let entry: JsonObject;
      try {
        entry = read(bytes, where);
      } catch (error) {
        if (error instanceof Refused) return undefined;
        throw error;
      }
      if (positive(entry.sequence)) place(entry.sequence, line, where);
      return entry;
    },
    end(count) {
      const last = count === 0 ? undefined : (declared.first_sequence ?? Number.NaN) + count - 1;
      if (count !== declared.observations || last !== declared.last_sequence) {
        refuseAs(`${file} holds ${count} lines; the manifest states ${declared.observations} through sequence ${String(declared.last_sequence)}`, "BUNDLE_INTEGRITY");
      }
    },
  };
}

const positive = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

function carriedBy(entry: JsonObject): string[] {
  if (entry.kind === "gone") return [];
  const hashes: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (key === "hash" && typeof item === "string" && SHA256.test(item)) hashes.push(item);
      else visit(item);
    }
  };
  visit(entry);
  return hashes;
}

function manifestFile(name: string, value: unknown): IosManifestFile {
  const file = object(value, `manifest.files[${JSON.stringify(name)}]`);
  if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) refuseAs(`${name}.sha256 must be sha256 and 64 hex digits`, "BUNDLE_MANIFEST");
  const count = (member: string, minimum: number): number | undefined => {
    const stated = file[member];
    if (stated === undefined) return undefined;
    if (typeof stated !== "number" || !Number.isSafeInteger(stated) || stated < minimum) refuseAs(`${name}.${member} must be an integer of at least ${minimum}`, "BUNDLE_MANIFEST");
    return stated;
  };
  const bytes = count("bytes", 0);
  const observations = count("observations", 0);
  if (bytes === undefined || observations === undefined) refuseAs(`${name} must state bytes and observations`, "BUNDLE_MANIFEST");
  const first = count("first_sequence", 1);
  const last = count("last_sequence", 1);
  if ((first === undefined) !== (last === undefined) || (first !== undefined && last! < first)) {
    refuseAs(`${name} must state first_sequence and last_sequence, in order, or neither`, "BUNDLE_MANIFEST");
  }
  if ((observations > 0) !== (first !== undefined) && name.endsWith(".jsonl")) {
    refuseAs(`${name} states ${observations} observations and ${first === undefined ? "no" : "a"} sequence range`, "BUNDLE_MANIFEST");
  }
  return { sha256: file.sha256, bytes, observations, ...(first === undefined ? {} : { first_sequence: first, last_sequence: last! }) };
}

function object(value: unknown, where: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuseAs(`${where} must be an object`, "BUNDLE_MANIFEST");
  return value as JsonObject;
}

function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const members = value as Record<string, unknown>;
    return `{${Object.keys(members).sort().map((key) => `${JSON.stringify(key)}:${sortedJson(members[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
