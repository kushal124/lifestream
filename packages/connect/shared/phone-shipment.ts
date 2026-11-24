import { span, type BlobReader, type Delivery, type Instant, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { blobChunks } from "./chunks.js";
import { instantOf } from "./delivery.js";
import { iosDomainEntries, readIosBundle, type IosBundle, type IosEntryLine, type IosMember, type IosMembers } from "./ios-bundle.js";
import { refuse } from "./refused.js";
import { BYTES_LIMIT } from "./zip.js";

export interface Shipment {
  readonly bundle: IosBundle;
  readonly members: IosMembers;
  readonly install: string;
  readonly unit: string | undefined;
  entries(domain: string): AsyncGenerator<IosEntryLine>;
  carriedSize(hash: string): number | undefined;
}

const LANE = /^phone:([^/]+)\//u;
const MEMBERS = "bundle/";

export async function* readShipment<T = ReaderOutput>(delivery: Delivery, files: BlobReader, read: (shipment: Shipment) => AsyncIterable<T> | Iterable<T>): AsyncGenerator<T> {
  const members = openMembers(delivery, files);
  const bundle = readIosBundle(members);
  const shipment: Shipment = {
    bundle,
    members,
    install: (bundle.manifest.device as JsonObject).install_id as string,
    unit: LANE.exec(delivery.id)?.[1],
    entries: (domain) => iosDomainEntries(members, bundle, domain),
    carriedSize: (hash) => bundle.files[`blobs/${hash.slice(7)}`]?.bytes,
  };
  yield* read(shipment);
}

function openMembers(delivery: Delivery, files: BlobReader): IosMembers {
  if (delivery.files.some((file) => !file.path.startsWith(MEMBERS))) {
    refuse(`a phone delivery holds its members under ${MEMBERS}; ${delivery.id} holds ${delivery.files.map((file) => file.path).join(", ")}`);
  }
  const members = delivery.files.map((file): IosMember => ({
    name: file.path.slice(MEMBERS.length),
    size: file.size,
    bytes(limit = BYTES_LIMIT) {
      if (file.size > limit) refuse(`${file.path} holds ${file.size} bytes, past the ${limit} a whole read takes`);
      return files.bytes(file.blob);
    },
    stream: () => blobChunks(files, file.blob),
  }));
  return { path: delivery.id, entries: () => members, entry: (name) => members.find((member) => member.name === name) };
}

export function at(text: unknown, where: string): Instant {
  if (typeof text !== "string") return refuse(`${where} must be an RFC 3339 instant`);
  return instantOf(text, "rfc3339", where);
}

export function between(start: unknown, end: unknown, where: string): Instant {
  const from = at(start, `${where}.start`);
  const to = at(end, `${where}.end`);
  if (to.start_ms < from.start_ms) refuse(`${where}: a span must not end before it starts`);
  return span(from, to);
}

export function member(value: unknown, name: string, where: string): JsonObject {
  const object = (value as JsonObject | undefined)?.[name];
  if (object === null || typeof object !== "object" || Array.isArray(object)) return refuse(`${where}.${name} must be an object`);
  return object;
}

export function capture(shipment: Shipment, domain: string, line: number): Pick<ReaderOutput, "device" | "locator"> {
  return { ...(shipment.unit === undefined ? {} : { device: shipment.unit }), locator: `${domain}.jsonl line ${line}` };
}
