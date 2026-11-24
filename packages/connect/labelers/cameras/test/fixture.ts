import type { Fixture } from "../../../test/drive.js";
import { camerasFixture } from "../../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "cameras": camerasFixture,
};
