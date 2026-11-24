import { resolve } from "node:path";
import { serveDoor } from "../door.js";
import { effective } from "../settings.js";
import { fakeDeclarations } from "./fakes.js";

const LOOK_MS = 10;
const folder = resolve(process.argv[2]!);
const signal = new Promise<true>((settle) => {
  for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => settle(true));
});
const door = await serveDoor(folder, effective(folder).settings.door, { registry: new URL("./fakes.ts", import.meta.url), connectors: fakeDeclarations(), lookMs: LOOK_MS });
const signalled = await Promise.race([signal, door.closed.then(() => false as const)]);
await door.close();
process.exit(signalled ? 0 : 1);
