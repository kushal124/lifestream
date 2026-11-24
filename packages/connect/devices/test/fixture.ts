import type { Fixture } from "../../test/drive.js";
import { devicesFixture } from "../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "devices-home": devicesFixture,
};
