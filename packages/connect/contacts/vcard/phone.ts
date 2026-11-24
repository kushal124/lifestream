import { cardCount, checks, each, refuse, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import * as phoneShipment from "../../shared/phone-shipment.js";

const { count, exact, guard, oneOf, rfc3339, SHA256, text } = checks;
const { capture, member, readShipment } = phoneShipment;
type Shipment = phoneShipment.Shipment;

const AUTHORIZATIONS = ["authorized", "limited", "denied", "restricted", "not_determined"];
const SERIALIZER = "CNContactVCardSerialization";

export const contacts: Reader = {
  name: "contacts-ios-bundle",
  kinds: {
    contact: guard((content) =>
      exact(content, ["type", "card"], ["photo"]) && content.type === "contacts.card" && typeof content.card === "string" && (content.photo === undefined || photoRef(content.photo))
        ? undefined
        : "content must be {type: contacts.card, card, photo?}, photo {hash, bytes, media_type}"),
  },
  read: (delivery, files) =>
    readShipment(delivery, files, (shipment) =>
      each(shipment.entries("contacts"), (part) => part.where, function* ({ where, read }) {
        const { line, entry } = read();
        if (!rfc3339(entry.observed_at)) refuse(`${where}.observed_at must be an RFC 3339 instant`);
        const payload = member(entry, "payload", where);
        if (entry.kind === "access") {
          if (!exact(payload, ["authorization"]) || !oneOf(payload.authorization, AUTHORIZATIONS)) refuse(`${where} is not an access change`);
        } else if (entry.kind === "gone") {
          if (!exact(payload, ["id"]) || !text(payload.id)) refuse(`${where} is not a contact gone: {id}`);
          yield { kind: "contact", key: payload.id, content: null, gone: true, ...capture(shipment, "contacts", line) };
        } else if (entry.kind === "card") {
          yield { ...cardRow(shipment, payload, where), ...capture(shipment, "contacts", line) };
        } else {
          refuse(`${where} is a contacts entry kind this connector does not know: ${JSON.stringify(entry.kind)}`);
        }
      })),
};

function cardRow(shipment: Shipment, payload: JsonObject, where: string): ReaderOutput {
  if (!exact(payload, ["id", "card", "serializer"], ["photo"]) || !text(payload.id) || typeof payload.card !== "string") refuse(`${where} is not a contact card: {id, card, serializer, photo?}`);
  if (payload.serializer !== SERIALIZER) refuse(`${where}.payload.serializer must be ${SERIALIZER}`);
  if (cardCount(Buffer.from(payload.card, "utf8"), `${where}.payload.card`) !== 1) refuse(`${where}.payload.card must be one vCard`);
  const content: JsonObject = { type: "contacts.card", card: payload.card };
  if (payload.photo === undefined) return { kind: "contact", key: payload.id, content };
  const photo = payload.photo;
  if (!photoRef(photo)) refuse(`${where}.payload.photo must name a blob: hash, bytes, media_type`);
  const carried = shipment.carriedSize(photo.hash);
  if (carried !== undefined && carried !== photo.bytes) refuse(`${where} states ${photo.bytes} bytes for a photo of ${carried}`);
  return { kind: "contact", key: payload.id, content: { ...content, photo }, blobs: [photo.hash], media: { [photo.hash]: photo.media_type } };
}

function photoRef(value: Json | undefined): value is JsonObject & { hash: string; bytes: number; media_type: string } {
  return exact(value, ["hash", "bytes", "media_type"]) && typeof value.hash === "string" && SHA256.test(value.hash) && count(value.bytes) && text(value.media_type);
}
