import type { Fixture } from "../../test/drive.js";
import { uploadFixture } from "../../ios-app/phone.test-support.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "upload": uploadFixture,
};
