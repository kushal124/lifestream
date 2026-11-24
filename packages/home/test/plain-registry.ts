import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withRoadDefaults, type Connector, type Reader } from "@lifestreamprotocol/connect";
import type { Guard, JsonObject, LineAdapter } from "@lifestreamprotocol/core";
import { connectorsWith, families } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";

export const PLAIN_FILE = "plain-journey.json";

const EXAMPLE_LOG: Connector = withRoadDefaults({
  id: "example-log", product: "example-log", name: "Example log", vendor: "example", type: "notes", records: "Lines an example service logs.",
  noun: ["line", "lines"], sources: [{ id: "example-log:local:<home>", read: "example-log-lines", arrives: "upload" }],
});

const line: Guard = (content) => typeof content === "object" && content !== null && !Array.isArray(content) && typeof content.at === "number" && typeof content.words === "string"
  ? [] : ["a line states at and words"];

const lines: Reader = { ...fakeRows, name: "example-log-lines", kinds: { line } };

const adapter: LineAdapter = {
  version: "1",
  kinds: ["line"],
  line({ version }) {
    const content = version.content as JsonObject;
    return {
      text: content.words as string,
      ...(typeof content.title === "string" ? { title: content.title } : {}), ...(typeof content.link === "string" ? { link: content.link } : {}),
    };
  },
};

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const { digest, without } = JSON.parse(readFileSync(join(folder, PLAIN_FILE), "utf8")) as { digest: string; without?: string };
  return {
    connectors: connectorsWith([EXAMPLE_LOG]), readers: [lines],
    families: families(settings, folder, [{ connectors: [EXAMPLE_LOG], adapters: { "example-log": { line: adapter } }, digest }]).filter((family) => family.name !== without),
  };
}
