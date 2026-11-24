import type { Fixture } from "../../test/drive.js";
import { cameraFixture, checkinFixture, energyFixture, locationFixture, motionFixture, notesFixture, voiceFixture } from "../phone.test-support.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "camera-ios-bundle": cameraFixture,
  "checkin-ios-bundle": checkinFixture,
  "energy-ios-bundle": energyFixture,
  "location-ios-bundle": locationFixture,
  "motion-ios-bundle": motionFixture,
  "notes-ios-bundle": notesFixture,
  "voice-ios-bundle": voiceFixture,
};
