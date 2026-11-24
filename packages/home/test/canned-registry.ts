import type { Guard } from "@lifestreamprotocol/core";
import { families } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import groups from "./groups-registry.js";

const accept: Guard = () => [];

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const base = groups(settings, home);
  return {
    ...base,
    readers: base.readers.map((reader) => (reader.name === "people-rows" ? { ...reader, kinds: { ...reader.kinds, call: accept } } : reader)),
    families: [...base.families, ...families(settings, home.root).filter((family) => family.name === "calls")],
  };
}
