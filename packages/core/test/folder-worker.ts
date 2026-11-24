import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { HandedFolder } from "../home-folder.js";

const fs = createRequire(import.meta.url)("node:fs") as typeof import("node:fs");
const { root, handed, work } = workerData as { root: string; handed?: HandedFolder; work?: { job: string; plain: string } };
const opened: string[] = [];
const openSync = fs.openSync as (...args: unknown[]) => number;
fs.openSync = ((path: unknown, ...rest: unknown[]) => {
  if (String(path).startsWith(root)) opened.push(String(path));
  return openSync(path, ...rest);
}) as typeof fs.openSync;
syncBuiltinESMExports();

const { openHandedFolder, openHomeFolder } = await import("../home-folder.js");
let folder;
try {
  folder = handed === undefined ? openHomeFolder(root) : openHandedFolder(handed);
} catch (error) {
  parentPort!.postMessage({ refused: (error as Error).message, opened });
  process.exit(0);
}
if (work !== undefined) {
  const own = folder.work(work.job, work.plain);
  fs.writeFileSync(join(own.path, "thread.txt"), "a worker's copy");
  parentPort!.postMessage({ path: own.path, held: fs.readdirSync(own.path) });
  process.exit(0);
}
folder.store({ role: "control", remade: true }, join(root, "control.db"), { sync: "NORMAL" }).close();
parentPort!.postMessage({ form: folder.form, opened });
