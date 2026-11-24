import { groups } from "@lifestreamprotocol/connect";
import { machine as thisMachine } from "../machine.js";
import { peopleFileOf, readGroups } from "../people.js";
import type { Registry, RegistryHome } from "../registry.js";
import type { Settings } from "../settings.js";
import people from "./people-registry.js";
import { dirname } from "node:path";

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const base = people(settings);
  return {
    ...base,
    readers: [...base.readers, groups.groupsConnector],
    labelers: [groups.groupsLabeler({ unit: settings.unit, rows: () => readGroups(home.folder(), peopleFileOf(folder, thisMachine().dir)) })],
  };
}
