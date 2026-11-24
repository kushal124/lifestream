import type { Fixture } from "../../test/drive.js";
import { peopleFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "people-home": peopleFixture,
};
