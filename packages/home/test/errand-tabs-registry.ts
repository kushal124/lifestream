import { stations } from "@lifestreamprotocol/connect";
import { webFamily } from "@lifestreamprotocol/families";
import { RELEASE_FED, releaseFolder } from "./fed.js";
import type { Registry } from "../registry.js";
import { connectors } from "../registry-home.js";
import { fakeRows } from "./fakes.js";

export default function registry(): Registry {
  return { connectors: connectors(), readers: [...releaseFolder("browser/chrome").readers, ...stations.readers, fakeRows], families: [webFamily({ screen: RELEASE_FED.screen })(RELEASE_FED.web)] };
}
