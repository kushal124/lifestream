import type { Fixture } from "../../../test/drive.js";
import { askFixture } from "../../../test/home-sources.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "ask-home": askFixture,
};
