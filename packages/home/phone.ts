import { isObject, type BlobReader, type HomeFolder, type JsonObject } from "@lifestreamprotocol/core";
import { CodedRefused, iosDomainOf, openZip, Refused, verifyIosBundle, type IosBundle, type RefusedCode, type VerifiedIosBundle } from "@lifestreamprotocol/connect";
import { zipSourceOf } from "./bundle.js";
import { UPLOAD, type Custody, type DoorStamp, type Lane, type Sealing } from "./inbox.js";
import { refuse } from "./refusal.js";


const HISTORY_MS = 7 * 86_400_000;
const CODES: Partial<Record<RefusedCode, string>> = {
  BUNDLE_MANIFEST: "IOS_BUNDLE_BAD_MANIFEST",
  BUNDLE_INTEGRITY: "IOS_BUNDLE_INTEGRITY_MISMATCH",
  BUNDLE_ENTRY: "IOS_BUNDLE_BAD_ENTRY",
};

function wireCode(error: unknown): never {
  if (error instanceof Refused) refuse(422, (error instanceof CodedRefused ? CODES[error.code] : undefined) ?? "IOS_BUNDLE_BAD_ZIP", error.message);
  throw error;
}

export async function openPhoneBundle(folder: HomeFolder, path: string): Promise<VerifiedIosBundle> {
  return await verifyIosBundle(path, zipSourceOf(folder.file(UPLOAD, path))).catch(wireCode);
}

export async function sealPhoneBundle(
  folder: HomeFolder, path: string, bundle: VerifiedIosBundle, sealing: Sealing,
  door: { lane: Lane; home: Pick<BlobReader, "has">; custody: Custody | undefined; stamp: DoorStamp },
): Promise<void> {
  const { lane, home, custody } = door;
  const zip = openZip(path, undefined, zipSourceOf(folder.file(UPLOAD, path)));
  try {
    for (const hash of bundle.blobs) {
      const hex = hash.slice("sha256:".length);
      if (lane.has(hex) === "other") refuse(422, "IOS_BUNDLE_BLOB_MISMATCH", `blob ${hash} is not a file in the store`);
      const entry = zip.entry(`blobs/${hex}`)!;
      if (!await lane.store(hex, entry.stream(), entry.size).catch(wireCode)) refuse(422, "IOS_BUNDLE_BLOB_MISMATCH", `blob ${hash} bytes do not match its name`);
    }
    const referenced = new Set<string>();
    for (const { domain } of bundle.domains) {
      const missing: string[] = [];
      for (const hash of bundle.carried[domain] ?? []) {
        referenced.add(hash);
        const held = lane.has(hash.slice("sha256:".length));
        if (held === "other") refuse(422, "IOS_BUNDLE_BLOB_MISMATCH", `blob ${hash} is not a file in the store`);
        if (held === "absent" && !home.has(hash)) missing.push(hash);
      }
      const source = Object.keys(custody ?? {}).find((id) => iosDomainOf(id) === domain);
      const lost = source === undefined ? 0 : (custody![source]!.lost ?? []).reduce((sum, entry) => sum + entry.items, 0);
      if (missing.length > lost) {
        refuse(422, "IOS_BUNDLE_BLOB_MISSING", `${missing.length} missing blobs of ${domain}.jsonl, ${lost} stated lost: ${missing.slice(0, 3).join(", ")}`);
      }
    }
    for (const name of ["manifest.json", ...bundle.domains.map(({ file }) => file)]) {
      await sealing.write(`bundle/${name}`, zip.entry(name)!.stream()).catch(wireCode);
    }
    sealing.seal(phoneFacts(bundle, { carried: bundle.blobs.length, referenced: referenced.size }, Date.parse(door.stamp.sealed_at)), undefined, door.stamp);
  } finally {
    zip.close();
  }
}

export function phoneShare(facts: JsonObject, source: string): "lines" | "sat-out" | "none" {
  const domains = facts.domains;
  if (!isObject(domains)) return "lines";
  const domain = iosDomainOf(source);
  if (domain !== null && domains[`${domain}.jsonl`] !== undefined) return "lines";
  return Array.isArray(facts.sat_out) && facts.sat_out.includes(source) ? "sat-out" : "none";
}

function phoneFacts(bundle: IosBundle, blobs: { carried: number; referenced: number }, sealed_ms: number): JsonObject {
  const domains: JsonObject = {};
  for (const { file, declared } of bundle.domains) {
    domains[file] = {
      observations: declared.observations,
      ...(declared.first_sequence === undefined ? {} : { first_sequence: declared.first_sequence, last_sequence: declared.last_sequence! }),
    };
  }
  const range = bundle.manifest.time_range_covered;
  const end = typeof range === "object" && range !== null && !Array.isArray(range) && typeof range.end === "string" ? Date.parse(range.end) : NaN;
  return {
    ...(end < sealed_ms - HISTORY_MS ? { history: true } : {}),
    bundle_id: bundle.bundle_id, created_at: bundle.created_at, install_id: (bundle.manifest.device as JsonObject).install_id!,
    time_range_covered: typeof range === "object" && range !== null && !Array.isArray(range) ? { ...range } : {}, domains,
    blobs_carried: blobs.carried, blobs_referenced: blobs.referenced,
    ...(bundle.sat_out.length === 0 ? {} : { sat_out: [...bundle.sat_out] }),
  };
}

