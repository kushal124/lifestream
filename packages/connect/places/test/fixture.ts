import type { Fixture } from "../../test/drive.js";
import { placeNamesFixture, placesFixture } from "../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "google-place-names": placeNamesFixture,
  "places-home": placesFixture,
};
