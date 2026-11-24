import { existsSync } from "node:fs";
import { join } from "node:path";
import { cameras, faces, people } from "@lifestreamprotocol/connect";
import { labelsFamily, photosFamily } from "@lifestreamprotocol/families";
import type { Registry, RegistryHome } from "../registry.js";
import { connectors, facesRun, facesSettings } from "../registry-home.js";
import type { Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";
import { RELEASE_FED } from "./fed.js";

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const engine = join(folder, "engine");
  return {
    connectors: connectors(), readers: [fakeRows, people.peopleHome, ...faces.readers, ...cameras.readers], faceEngine: join(engine, "face-engine"),
    families: [photosFamily({ faces: facesRun(settings, folder) })(RELEASE_FED.photos), labelsFamily({ home: settings.unit, messages: RELEASE_FED.messages, mail: RELEASE_FED.mail })(RELEASE_FED.labels)],
    labelers: [
      faces.facesLabeler({
        ...facesSettings(settings, home, RELEASE_FED), engine: join(engine, "face-engine"), fetch: join(engine, "fetch-models.sh"), reference: join(engine, "reference"),
        onMains: () => !existsSync(join(engine, "on-battery")),
      }),
      cameras.camerasLabeler({ unit: settings.unit!, photos: RELEASE_FED.photos }),
    ],
  };
}
