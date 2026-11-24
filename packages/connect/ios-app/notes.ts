import { checks, each, isObject, refuse, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../shared/phone-shipment.js";

const { count, exact, finite, guard, lineEnvelope, rfc3339, SHA256, text, UUID } = checks;
const { between, capture, member, readShipment } = phoneShipment;

const KINDS = { note: "notes.note", folder: "notes.folder" } as const;
const NOTE = ["id", "folder", "title", "text", "created", "modified", "pinned", "pin_order", "deleted_at", "purged", "rich", "attachments"];
const FOLDER = ["id", "name", "parent", "sort_index", "default", "created", "modified", "deleted"];
const ATTACHMENT = ["id", "filename", "uti", "blob"];
const blobRef = (value: Json | undefined): value is JsonObject => exact(value, ["hash", "bytes"]) && typeof value.hash === "string" && SHA256.test(value.hash) && count(value.bytes);

export const notes: Reader = {
  name: "notes-ios-bundle",
  kinds: { note: guard((content) => notesGuard(content, "note")), folder: guard((content) => notesGuard(content, "folder")) },
  read: (delivery, files) =>
    readShipment(delivery, files, async function* (shipment) {
      const newest = new Map<string, ReaderOutput>();
      yield* each(shipment.entries("notes"), (part) => part.where, ({ where, read }): ReaderOutput[] => {
        const { line, entry } = read();
        const kind = entry.kind;
        if (kind !== "note" && kind !== "folder") refuse(`${where} is a notes entry kind this connector does not know: ${JSON.stringify(kind)}`);
        const payload = member(entry, "payload", where);
        if (typeof payload.id !== "string" || !UUID.test(payload.id)) refuse(`${where} states no id`);
        const key = `${kind}:${payload.id}`;
        newest.delete(key);
        if (kind === "note" ? payload.purged === true : payload.deleted === true) {
          newest.set(key, { kind, key: payload.id, content: null, gone: true, ...capture(shipment, "notes", line) });
          return [];
        }
        const blobs = kind === "note" ? noteBlobs(payload) : [];
        newest.set(key, {
          kind, key: payload.id, content: { type: KINDS[kind], content: entry },
          ...(kind === "note" ? { time: between(payload.created, payload.modified, `${where}.payload`) } : {}),
          ...(blobs.length === 0 ? {} : { blobs }),
          ...capture(shipment, "notes", line),
        });
        return [];
      });
      yield* newest.values();
    }),
};

function noteBlobs(payload: JsonObject): string[] {
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const named = [payload.rich, ...attachments.map((attachment) => (isObject(attachment) ? attachment.blob : undefined))];
  return [...new Set(named.map((blob) => (isObject(blob) ? blob.hash : undefined)).filter((hash): hash is string => typeof hash === "string" && SHA256.test(hash)))];
}

function notesGuard(content: Json, kind: "note" | "folder"): string | undefined {
  if (!exact(content, ["type", "content"]) || content.type !== KINDS[kind]) return `content must be {type: ${KINDS[kind]}, content}`;
  const e = content.content;
  if (!lineEnvelope(e)) return "content.content must be the app's notes line, every member";
  if (e.domain !== "notes" || e.kind !== kind || !rfc3339(e.observed_at)) return "content.content's envelope: domain notes, its kind, an observed_at";
  const p = e.payload;
  if (kind === "folder") {
    const ok = exact(p, FOLDER) && UUID.test(String(p.id)) && text(p.name) && (p.parent === null || UUID.test(String(p.parent))) &&
      finite(p.sort_index) && typeof p.default === "boolean" && rfc3339(p.created) && rfc3339(p.modified) && p.deleted === false;
    return ok ? undefined : "content.content.payload is not a folder as the app writes it";
  }
  const ok = exact(p, NOTE) && UUID.test(String(p.id)) && (p.folder === null || UUID.test(String(p.folder))) &&
    typeof p.title === "string" && typeof p.text === "string" && rfc3339(p.created) && rfc3339(p.modified) &&
    typeof p.pinned === "boolean" && finite(p.pin_order) && (p.deleted_at === null || rfc3339(p.deleted_at)) && p.purged === false &&
    blobRef(p.rich) && Array.isArray(p.attachments) &&
    p.attachments.every((a) => exact(a, ATTACHMENT) && UUID.test(String(a.id)) && typeof a.filename === "string" && text(a.uti) && blobRef(a.blob));
  return ok ? undefined : "content.content.payload is not a note as the app writes it";
}
