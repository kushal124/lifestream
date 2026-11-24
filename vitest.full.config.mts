import { configDefaults, defineConfig } from "vitest/config";
import { Slow } from "./testing/run.mjs";
import check, { FULL, PROJECTS } from "./vitest.config.mjs";

export default defineConfig({
  ...check,
  test: {
    ...check.test,
    exclude: configDefaults.exclude,
    testTimeout: 3_600_000,
    reporters: ["default", new Slow()],
    projects: [{ extends: true, test: { name: "full", isolate: true, include: PROJECTS.flatMap((path) => FULL.map((pattern) => `${path}/${pattern}`)) } }],
  },
});
