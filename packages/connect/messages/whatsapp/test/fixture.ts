import type { Fixture } from "../../../test/drive.js";
import { fixture as messagesWhatsappFixture } from "../whatsapp.test-support.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "whatsapp-db": messagesWhatsappFixture,
};
