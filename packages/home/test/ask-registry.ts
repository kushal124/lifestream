import { ask } from "@lifestreamprotocol/connect";
import { aiFamily } from "@lifestreamprotocol/families";
import type { Registry } from "../registry.js";
import { connectors } from "../registry-home.js";
import { RELEASE_FED } from "./fed.js";

export default function registry(): Registry {
  return { connectors: connectors(), readers: [...ask.readers], families: [{ ...aiFamily(RELEASE_FED.ai), adapters: RELEASE_FED.ai }] };
}
