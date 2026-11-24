import { each, isObject, refuse, type Guard, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { domainOf } from "../../shared/ios-bundle.js";
import * as phoneShipment from "../../shared/phone-shipment.js";
import { examplePhone as declared } from "./connector.js";

const { at, capture, member, readShipment } = phoneShipment;

export const NOTE = "note";
export const DOMAIN = domainOf(declared);

const note: Guard = (content) =>
  isObject(content) && content.type === "example.note" && typeof content.text === "string" && typeof content.written_at === "string" ? [] : ["a note is { type: example.note, text, written_at, … }"];

export const examplePhone: Reader = {
  name: "example-phone",
  kinds: { [NOTE]: note },
  read: (delivery, files) =>
    readShipment(delivery, files, (shipment) =>
      each(shipment.entries(DOMAIN), (part) => part.where, ({ where, read }): ReaderOutput[] => {
        const { line, sequence, entry } = read();
        if (entry.kind !== NOTE) refuse(`${where} is an entry kind this reader does not know: ${JSON.stringify(entry.kind)}`);
        const payload = member(entry, "payload", where);
        if (Object.hasOwn(payload, "type")) refuse(`${where} states a member type, which is the content's own`);
        return [{
          kind: NOTE, key: `${shipment.install}:${sequence}`, content: { type: "example.note", ...payload },
          time: at(payload.written_at, `${where}.payload.written_at`), ...capture(shipment, DOMAIN, line),
        }];
      }),
    ),
};
