import { isObject, type Instant, type Json, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import type { Reader } from "../seams.js";
import { count, exact, first, guard, positive, rfc3339, SHA256, text } from "./checks.js";
import { at, between, capture, member, readShipment } from "./phone-shipment.js";
import { each, refuse } from "./refused.js";

export interface SensorDomain {
  connector: string;
  kinds: Record<string, { kind: string; type: string }>;
  clock: "captured" | "observed";
  blob: boolean;
}

export function sensorReader(domain: string, spec: SensorDomain): Reader {
  const kinds: Record<string, ReturnType<typeof guard>> = {};
  for (const kind of new Set(Object.values(spec.kinds).map((mapping) => mapping.kind))) {
    kinds[kind] = guard((content) => lineGuard(content, domain, spec, kind));
  }
  return {
    name: spec.connector,
    kinds,
    read: (delivery, files) =>
      readShipment(delivery, files, (shipment) =>
        each(shipment.entries(domain), (part) => part.where, ({ where, read }): ReaderOutput[] => {
          const { line, sequence, entry } = read();
          const mapping = mappingOf(spec, entry.kind);
          if (mapping === undefined) refuse(`${where} is an entry kind this connector does not know: ${JSON.stringify(entry.kind)}`);
          if (spec.blob) {
            const blob = member(entry, "payload", where).blob as JsonObject | undefined;
            const hash = blob?.hash;
            if (typeof hash !== "string" || !SHA256.test(hash)) refuse(`${where} names no blob`);
            const carried = shipment.carriedSize(hash);
            if (carried !== undefined && carried !== blob!.bytes) refuse(`${where} states ${String(blob!.bytes)} bytes for a blob of ${carried}`);
          }
          const row: ReaderOutput = {
            kind: mapping.kind,
            key: `${shipment.install}:${sequence}`,
            content: { type: mapping.type, content: entry },
            time: timeOf(domain, spec, entry, line),
            ...capture(shipment, domain, line),
          };
          const blobs = spec.blob ? sensorBlobs(row.content!) : [];
          if (blobs.length > 0) row.blobs = blobs;
          return [row];
        }),
      ),
  };
}

function sensorBlobs(content: Json): string[] {
  const entry = isObject(content) ? content.content : undefined;
  const payload = isObject(entry) ? entry.payload : undefined;
  const hash = isObject(payload) && isObject(payload.blob) ? payload.blob.hash : undefined;
  return typeof hash === "string" ? [hash] : [];
}

function mappingOf(spec: SensorDomain, entryKind: Json | undefined): { kind: string; type: string } | undefined {
  return typeof entryKind === "string" && Object.hasOwn(spec.kinds, entryKind) ? spec.kinds[entryKind] : undefined;
}

function timeOf(domain: string, spec: SensorDomain, entry: JsonObject, line: number): Instant {
  const where = `${domain}.jsonl line ${line}`;
  if (domain === "location" && entry.kind === "gap") {
    const payload = member(entry, "payload", where);
    return between(payload.start, payload.end, `${where}.payload`);
  }
  if (domain === "energy" && entry.kind === "parts") {
    const window = member(member(entry, "payload", where), "window", `${where}.payload`);
    return between(window.start, window.end, `${where}.payload.window`);
  }
  if (domain === "energy" && (entry.kind === "metrickit_payload" || entry.kind === "metrickit_diagnostic")) {
    const payload = member(entry, "payload", where);
    return between(payload.range_start, payload.range_end, `${where}.payload range`);
  }
  if (spec.clock === "captured") return at(member(entry, "captured", where).wall_rfc3339, `${where}.captured.wall_rfc3339`);
  if (entry.kind === "activity_segment") {
    const interval = member(member(member(entry, "payload", where), "data", `${where}.payload`), "dateInterval", `${where}.payload.data`);
    const time = between(member(interval, "start", "dateInterval").rfc3339, member(interval, "end", "dateInterval").rfc3339, `${where} dateInterval`);
    if (time.end_ms === undefined || time.end_ms <= time.start_ms) refuse(`${where}: an activity segment must end after it starts`);
    return time;
  }
  return at(entry.observed_at, `${where}.observed_at`);
}

function lineGuard(content: Json, domain: string, spec: SensorDomain, kind: string): string | undefined {
  const entryKinds = Object.keys(spec.kinds).filter((entryKind) => spec.kinds[entryKind]!.kind === kind);
  if (!exact(content, ["type", "content"])) return "content must be {type, content}";
  const line = content.content;
  if (!isObject(line)) return "content.content must be the phone's line";
  const mapping = mappingOf(spec, line.kind);
  if (mapping?.kind !== kind) return `content.kind must be one of ${entryKinds.join(", ")}`;
  if (content.type !== mapping.type) return `content must be {type: ${mapping.type}, content}`;
  const payload = line.payload;
  return first([
    ["content.domain", () => line.domain === domain],
    ["content.sequence must be a positive integer", () => positive(line.sequence)],
    ["content.captured.wall_rfc3339 must be an RFC 3339 instant", () => isObject(line.captured) && rfc3339(line.captured.wall_rfc3339)],
    ["content.payload must be an object", () => isObject(payload)],
    ["content.observed_at must be an RFC 3339 instant in UTC (Z)", () => spec.clock === "captured" || (rfc3339(line.observed_at) && line.observed_at.endsWith("Z"))],
    ["content.capture_replay_key must be a non-empty string", () => line.capture_replay_key === undefined || text(line.capture_replay_key)],
    ["content.payload.blob must state hash, bytes, type and role", () => !spec.blob || blobRef((payload as JsonObject).blob)],
  ]);
}

function blobRef(blob: Json | undefined): boolean {
  return isObject(blob) && typeof blob.hash === "string" && SHA256.test(blob.hash) && count(blob.bytes) && text(blob.type) && text(blob.role);
}
