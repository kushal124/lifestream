import type { Fixture } from "../../../test/drive.js";
import { healthFixture } from "../../../ios-app/phone.test-support.js";
import { healthExportFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "health-export": healthExportFixture,
  "health-ios-bundle": healthFixture,
};
