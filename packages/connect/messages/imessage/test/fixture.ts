import type { Fixture } from "../../../test/drive.js";
import { fixture as messagesImessageFixture } from "../imessage.test-support.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "imessage-db": messagesImessageFixture,
};
