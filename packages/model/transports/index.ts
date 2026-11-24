import type { RunnerListing } from "../runner-wire.js";
import type { TransportSettings } from "../settings.js";
import type { Transport } from "../transport.js";
import { addressTransport } from "./address.js";
import { claudeTransport } from "./claude.js";
import { codexTransport } from "./codex.js";
import { fakeTransport } from "./fake.js";
import { OPENROUTER_SECRET, openRouterTransport } from "./openrouter.js";
import type { ProgramAt } from "./program.js";
import { CALL_PASS, runnerTransport } from "./runner.js";
import { CLOUD_VOICE, transcriptionsTransport } from "./transcriptions.js";


export interface Found {
  programs?: Readonly<Record<string, ProgramAt>>;
  door?: string;
  runners?: readonly RunnerListing[];
  held?(name: string): boolean;
  secret?(name: string): string | undefined;
}

export function configured(transports: TransportSettings | undefined): string[] {
  return ["runner", "codex", "claude", "openrouter", CLOUD_VOICE.transport, ...transports?.address === undefined ? [] : ["address"], ...transports?.fake === undefined ? [] : ["fake"]];
}

export function priced(transports: TransportSettings | undefined): string[] {
  return configured(transports).filter((name) => transportOf(name, transports).cost === "priced");
}

export function transportOf(name: string, transports: TransportSettings | undefined, found: Found = {}): Transport {
  const settings = transports ?? {};
  const held = (secret: string) => found.held?.(secret) ?? false;
  const value = (secret: string) => found.secret?.(secret);
  switch (name) {
    case "codex":
      return codexTransport({ codex: found.programs?.codex });
    case "claude":
      return claudeTransport({ claude: found.programs?.claude });
    case "openrouter":
      return openRouterTransport({ held: () => held(OPENROUTER_SECRET), key: () => value(OPENROUTER_SECRET) });
    case CLOUD_VOICE.transport:
      return transcriptionsTransport({ held: () => held(OPENROUTER_SECRET), key: () => value(OPENROUTER_SECRET) });
    case "address": {
      const address = settings.address;
      if (address === undefined) throw new TypeError("no address is set (model.transports.address)");
      const secret = address.secret;
      return addressTransport({ ...address, held: () => secret === undefined || held(secret), key: () => (secret === undefined ? undefined : value(secret)) });
    }
    case "runner":
      return runnerTransport({ door: found.door, pass: () => value(CALL_PASS), ...(found.runners === undefined ? {} : { runners: found.runners }) });
    case "fake":
      return fakeTransport(settings.fake ?? {});
    default:
      throw new TypeError(`no transport is named ${name}`);
  }
}

export function transportSecret(name: string, transports: TransportSettings | undefined): string | null {
  if (name === "openrouter" || name === CLOUD_VOICE.transport) return OPENROUTER_SECRET;
  if (name === "runner") return CALL_PASS;
  if (name === "address") return transports?.address?.secret ?? null;
  return null;
}
