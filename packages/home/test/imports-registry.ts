import { people, upload } from "@lifestreamprotocol/connect";
import type { Family } from "@lifestreamprotocol/families";
import type { Registry, RegistryHome } from "../registry.js";
import { connectors, families, feedersOf } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { releaseFolder } from "./fed.js";

const readingOnly = (family: Family): Family => ({
  name: family.name, type: family.type, code: family.code, inputs: family.inputs, ...family.adapters === undefined ? {} : { adapters: family.adapters },
  touched: () => [], extract: () => null, days: () => [], day: () => ({ lines: [], facts: [] }),
});

export default function registry(settings?: Settings, home?: RegistryHome): Registry {
  const folder = home?.root;
  const declared = connectors();
  return {
    connectors: declared,
    readers: [
      ...upload.readers, ...releaseFolder("google/my-activity").readers, ...releaseFolder("mail/gmail").readers, ...releaseFolder("calendar/google").readers,
      ...people.readers, ...releaseFolder("contacts/vcard").readers, ...releaseFolder("photos/google").readers,
      ...releaseFolder("listening/spotify").readers, ...releaseFolder("ai").readers, ...releaseFolder("location/google-timeline").readers,
      ...releaseFolder("messages/imessage").readers, ...releaseFolder("messages/whatsapp").readers, ...releaseFolder("calls/apple").readers,
    ],
    feeders: feedersOf(declared),
    families: settings === undefined || folder === undefined ? [] : families(settings, folder).map(readingOnly),
  };
}
