import { stations } from "@lifestreamprotocol/connect";
import { voiceFamily, webFamily } from "@lifestreamprotocol/families";
import dashboard from "../../packages/home/test/dashboard-registry.js";
import ask from "../../packages/home/test/ask-registry.js";
import { RELEASE_FED } from "../../packages/home/test/fed.js";
import type { Registry, RegistryHome } from "../../packages/home/registry.js";
import type { Settings } from "../../packages/home/settings.js";

const VOICE = process.env.LIFESTREAM_MCP_VOICE === "1";

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const base = dashboard(settings, home);
  const asked = ask();
  const readers = base.readers.map((reader) => (reader.name === "dashboard-rows"
    ? { ...reader, kinds: { ...reader.kinds, "page-visit": () => [], ...(VOICE ? { voice: reader.kinds.msg! } : {}) } }
    : reader));
  return {
    ...base, readers: [...readers, ...asked.readers, ...stations.readers],
    families: [...base.families, ...asked.families, webFamily()(RELEASE_FED.web), ...(VOICE ? [voiceFamily(RELEASE_FED.voice)] : [])],
  };
}
