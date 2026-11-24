import type { Fixture } from "../../../test/drive.js";
import { googlePhotosFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "google-photos-takeout": googlePhotosFixture,
};
