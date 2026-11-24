import { resolve } from "node:path";
import { ownerOnly } from "@lifestreamprotocol/core";
import { askGeneration, serveDoor } from "./door.js";
import { startingSettings } from "./lifecycle.js";
import { machine } from "./machine.js";
import { homeRegistryModule } from "./programs.js";
import { effectiveOf, settingsPath } from "./settings.js";
import { takeSlotKey } from "./vault.js";
import { CLI } from "./cli-name.js";

async function main(argv: readonly string[]): Promise<number> {
  const slot = takeSlotKey();
  const named = argv[1] === "--root" && argv.length === 3 ? argv[2] : undefined;
  if (argv[0] !== "serve" || (argv.length !== 1 && named === undefined)) {
    process.stderr.write("usage: door-main.ts serve [--root <folder>]\n");
    return 2;
  }
  const folder = named === undefined ? machine().home : resolve(named);
  if (folder === null) throw new Error(`this machine holds no home: ${CLI} adopt <folder> makes one`);
  const signal = new Promise<true>((resolve) => {
    for (const name of ["SIGTERM", "SIGINT"] as const) process.once(name, () => resolve(true));
  });
  const door = await serveDoor(named === undefined ? null : folder, effectiveOf(startingSettings(folder, machine()), settingsPath(folder)).settings.door, {
    registry: homeRegistryModule(), generation: askGeneration, slot,
  });
  const signalled = await Promise.race([signal, door.closed.then(() => false as const)]);
  await door.close();
  return signalled ? 0 : 1;
}

ownerOnly();
main(process.argv.slice(2)).then(
  (status) => process.exit(status),
  (error: unknown) => {
    process.stderr.write(`${JSON.stringify({ at: new Date().toISOString(), door: "failed", message: (error as Error).message })}\n`);
    process.exit(1);
  },
);
