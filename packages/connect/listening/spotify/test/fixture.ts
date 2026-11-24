import type { Fixture } from "../../../test/drive.js";
import { spotifyFixture } from "./fixtures.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "spotify-export": spotifyFixture,
};
