import { fileURLToPath } from "node:url";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import fakes from "./fakes.js";
import { releaseFolder } from "./fed.js";

export const START_REGISTRY = fileURLToPath(new URL("./start-registry.ts", import.meta.url));
export const GMAIL_ACCOUNT = "person-a@example.com";
export const GMAIL_SOURCE = `gmail:${GMAIL_ACCOUNT}:cloud`;

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const fake = fakes(settings, home);
  const gmail = releaseFolder("mail/gmail").gmailImapAcquirer({ account: GMAIL_ACCOUNT, password: "gmail.password" });
  return { ...fake, acquirers: [...fake.acquirers ?? [], gmail] };
}
