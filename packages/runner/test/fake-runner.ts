import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { RunnerStated } from "@lifestreamprotocol/model";
import { FILES } from "../files.js";
import { serve } from "../serve.js";
import { fakeLibrary, type FakeScript } from "./fake-library.js";

const { values } = parseArgs({ options: { door: { type: "string" }, pass: { type: "string" }, script: { type: "string" }, power: { type: "string" }, idle: { type: "string" }, thermal: { type: "string" } } });
const script = values.script === undefined ? {} : JSON.parse(readFileSync(values.script, "utf8")) as FakeScript;
const fake = fakeLibrary(script);
const stop = new AbortController();
process.once("SIGTERM", () => stop.abort());
const { power, idle, thermal } = values;
await serve({
  door: values.door!, pass: values.pass!, rows: FILES, signal: stop.signal, libraries: { speech: fake, ollama: fake, detector: fake },
  ...power === undefined ? {} : { power: async () => readFileSync(power, "utf8").trim() as RunnerStated["power"] },
  idle: async () => (idle === undefined ? null : Number(readFileSync(idle, "utf8").trim())),
  thermal: async () => (thermal === undefined ? null : readFileSync(thermal, "utf8").trim() as RunnerStated["thermal"]),
});
process.exit(0);
