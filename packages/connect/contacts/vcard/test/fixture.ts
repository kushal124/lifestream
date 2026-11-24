import type { Fixture } from "../../../test/drive.js";
import { contactsFixture } from "../../../ios-app/phone.test-support.js";
import { fixture as contactsVcardFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "contacts-ios-bundle": contactsFixture,
  "contacts-vcard": contactsVcardFixture,
};
