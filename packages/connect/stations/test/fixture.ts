import type { Fixture } from "../../test/drive.js";
import { stationsFixture } from "../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "stations-home": stationsFixture,
};
