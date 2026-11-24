import { withRoadDefaults, type Connector } from "@lifestreamprotocol/connect";
import { healthFamily, mailFamily } from "@lifestreamprotocol/families";
import { connectorsWith, feedersOf } from "../registry-home.js";
import type { Registry } from "../registry.js";
import { RELEASE_FED, releaseFolder } from "./fed.js";

const declared: readonly Connector[] = [...releaseFolder("mail/gmail").connectors, ...releaseFolder("health/whoop").connectors].map(withRoadDefaults);

export default function registry(): Registry {
  return { connectors: connectorsWith(declared), readers: [], feeders: feedersOf(declared), families: [mailFamily({ books: RELEASE_FED.labels })(RELEASE_FED.mail), healthFamily(RELEASE_FED.health)], acquirers: [] };
}
