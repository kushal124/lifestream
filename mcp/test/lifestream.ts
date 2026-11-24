import { fileURLToPath } from "node:url";
import { checkoutProgram } from "../../packages/home/programs.js";
import { testDist } from "../../packages/home/test/bundle.js";

process.env.LIFESTREAM_TEST_DIST ??= (await testDist()).dist;
process.stdout.write(`${JSON.stringify(checkoutProgram(fileURLToPath(new URL("../../packages/home/test/cli-child.ts", import.meta.url))))}\n`);
