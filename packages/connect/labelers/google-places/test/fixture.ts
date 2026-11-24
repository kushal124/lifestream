import type { Fixture } from "../../../test/drive.js";
import { googlePlacesFixture } from "../../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "google-places": googlePlacesFixture,
};
