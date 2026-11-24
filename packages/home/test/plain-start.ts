import { createRequire } from "node:module";
import { startHome } from "../home.js";

const [root, registry] = process.argv.slice(2) as [string, string];
const home = await startHome(root, { registry, slot: null, log: () => undefined });
await home.stop();
const ENGINE = "better-sqlite3-multiple-ciphers";
const modules = Object.keys(createRequire(import.meta.url).cache).filter((path) => path.includes(ENGINE));
const report = process.report.getReport() as unknown as { sharedObjects: string[] };
const binaries = report.sharedObjects.filter((path) => path.includes(ENGINE));
process.stdout.write(`${JSON.stringify({ modules: modules.length, binaries: binaries.length, started: true })}\n`);
process.exit(0);
