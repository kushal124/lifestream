import { checks, each, isObject, refuse, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../../shared/phone-shipment.js";
import { img, imgFile, PHOTO_FILE_KIND, photoRow } from "./entries.js";

const { exact, first, guard, positive, rfc3339 } = checks;
const { at, capture, member, readShipment } = phoneShipment;
type Shipment = phoneShipment.Shipment;

export const PHOTOS_CONNECTOR = "photos-ios-bundle";

export const photos: Reader = {
  name: PHOTOS_CONNECTOR,
  kinds: { img, [PHOTO_FILE_KIND]: imgFile, recorder: guard(recorderGuard) },
  read: (delivery, files) =>
    readShipment(delivery, files, (shipment) =>
      each(shipment.entries("photos"), (part) => part.where, ({ where, read }): ReaderOutput[] => {
        const { line, sequence, entry } = read();
        const wall = member(entry, "captured", where).wall_rfc3339;
        const observed = at(wall, `${where}.captured.wall_rfc3339`);
        if (entry.kind === "sweep") {
          return [{ kind: "recorder", key: `${shipment.install}:${sequence}`, content: { type: "photos.apple.recorder", content: entry }, time: observed, ...capture(shipment, "photos", line) }];
        }
        const payload = member(entry, "payload", where);
        checkCarried(shipment, payload, where);
        if (entry.kind === "resource_availability") checkBinding(payload, where);
        return [{ ...photoRow(entry.kind, payload, observed, where), ...capture(shipment, "photos", line) }];
      }),
    ),
};

function checkBinding(payload: JsonObject, where: string): void {
  const snapshot = `photos:${String(payload.local_identifier)}:${payload.modification_date === null ? "null" : String(payload.modification_date)}`;
  if (payload.snapshot_replay_key !== snapshot) refuse(`${where}: the availability does not name its snapshot`);
}

function checkCarried(shipment: Shipment, payload: JsonObject, where: string): void {
  const resources = Array.isArray(payload.resources) ? payload.resources : [];
  for (const resource of resources) {
    const blob = isObject(resource) ? resource.blob : undefined;
    if (!isObject(blob) || typeof blob.hash !== "string") continue;
    const carried = shipment.carriedSize(blob.hash);
    if (carried !== undefined && carried !== blob.bytes) refuse(`${where} states ${String(blob.bytes)} bytes for a blob of ${carried}`);
  }
}

function recorderGuard(content: Json): string | undefined {
  if (!exact(content, ["type", "content"]) || content.type !== "photos.apple.recorder" || !isObject(content.content)) return "content must be {type: photos.apple.recorder, content}";
  const line = content.content;
  return first([
    ["content.domain and kind must be photos and sweep", () => line.domain === "photos" && line.kind === "sweep"],
    ["content.sequence must be a positive integer", () => positive(line.sequence)],
    ["content.captured.wall_rfc3339 must be an RFC 3339 instant", () => isObject(line.captured) && rfc3339(line.captured.wall_rfc3339)],
    ["content.payload must be an object", () => isObject(line.payload)],
  ]);
}
