import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ownerOnly } from "@lifestreamprotocol/core";
import { detectorLibrary } from "./detector.js";
import { ROWS } from "./files.js";
import { ollamaLibrary } from "./ollama.js";
import { openOllama } from "./ollama-child.js";
import { serve } from "./serve.js";
import { speechLibrary } from "./speech.js";


ownerOnly();
const USAGE = "usage: runner serve --door <address> --pass <file> --files <folder>";
const { positionals, values } = parseArgs({ allowPositionals: true, options: { door: { type: "string" }, pass: { type: "string" }, files: { type: "string" } } });
if (positionals.join(" ") !== "serve" || values.door === undefined || values.pass === undefined || values.files === undefined) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}
const files = resolve(values.files);
mkdirSync(files, { recursive: true });
const stop = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => stop.abort());
await serve({
  door: values.door, pass: resolve(values.pass), rows: ROWS, signal: stop.signal,
  libraries: { speech: speechLibrary(join(files, "speech")), ollama: ollamaLibrary(openOllama(join(files, "ollama"))), detector: detectorLibrary(join(files, "detector")) },
});
process.exit(0);
