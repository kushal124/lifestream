import { existsSync } from "node:fs";
import { join, normalize, sep } from "node:path";

/**
 * @param {string} source
 * @returns {string[]}
 */
export function bundledProgram(source) {
  const dist = process.env.LIFESTREAM_TEST_DIST;
  if (dist !== undefined) {
    const bundle = join(dist, `${normalize(source).replace(/\.ts$/u, "").split(sep).join("~")}.mjs`);
    if (existsSync(bundle)) return ["--import", "./testing/process.mjs", bundle];
  }
  return ["--import", "tsx", "--import", "./testing/process.mjs", source];
}
