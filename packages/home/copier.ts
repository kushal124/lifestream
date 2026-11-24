import { parentPort } from "node:worker_threads";
import { openHandedFolder, openHome, type HandedFolder, type HomeDb } from "@lifestreamprotocol/core";
import { holdpoint } from "./failpoint.js";
import { jobError } from "./job-error.js";
import type { FromCopier, ToCopier } from "./copiers.js";

const port = parentPort!;
let db: HomeDb | null = null;
let last = Promise.resolve();

async function answer(asked: ToCopier): Promise<void> {
  if (typeof asked === "object") {
    db?.close();
    db = openHome(openHandedFolder(asked.attach), "write", { ownCheckpoints: true });
    return;
  }
  if (asked === "detach") {
    db?.close();
    db = null;
    port.postMessage("detached" satisfies FromCopier);
    return;
  }
  if (asked === "close") {
    db?.close();
    db = null;
    port.close();
    return;
  }
  const started = performance.now();
  let said: FromCopier;
  try {
    const { checkpointed } = db!.checkpoint("passive");
    said = { checkpointed, ms: performance.now() - started };
  } catch (error) {
    said = { failed: jobError(error) };
  }
  await holdpoint("copier.copied", JSON.stringify(said));
  port.postMessage(said);
}

port.on("message", (asked: ToCopier) => {
  last = last.then(() => answer(asked));
});
