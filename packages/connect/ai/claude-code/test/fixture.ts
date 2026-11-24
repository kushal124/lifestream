import type { Fixture } from "../../../test/drive.js";
import { claudeCodeFixture } from "../../test/sessions.js";

export const fixtures: Readonly<Record<string, Fixture>> = {
  "claude-code-sessions": claudeCodeFixture,
};
