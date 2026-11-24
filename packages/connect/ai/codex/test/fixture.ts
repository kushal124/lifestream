import type { Fixture } from "../../../test/drive.js";
import { codexFixture } from "../../test/sessions.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "codex-sessions": codexFixture,
};
