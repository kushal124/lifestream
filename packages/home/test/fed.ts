import { FOLDERS, providers } from "@lifestreamprotocol/connect";
import { ownProducts, type Networked } from "@lifestreamprotocol/families";
import { releaseAdmitted } from "../folders.js";
import { adaptersBy, clientsOf, fedBy } from "../registry-home.js";

export const RELEASE_FED = fedBy(providers());

export const RELEASE_NETWORKED: Networked = { messages: RELEASE_FED.messages, own: ownProducts([...RELEASE_FED.messages, ...RELEASE_FED.mail]) };

export const RELEASE_ADAPTERS = adaptersBy(releaseAdmitted().entries.map((each) => each.entry));
export const RELEASE_CLIENTS = clientsOf(releaseAdmitted().entries.map((each) => each.entry));

type ReleaseFolder = (typeof FOLDERS)[number];

export function releaseFolder<P extends ReleaseFolder["folder"]>(path: P): Extract<ReleaseFolder, { folder: P }>["module"] {
  return FOLDERS.find((each) => each.folder === path)!.module as never;
}
