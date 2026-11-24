import { parentPort, workerData } from "node:worker_threads";
import { openHome } from "../home-db.js";
import { openHandedFolder, type HandedFolder } from "../home-folder.js";

const { handed, source, kind } = workerData as { handed: HandedFolder; source: string; kind: string };
const db = openHome(openHandedFolder(handed), "read");
const view = db.view();
try {
  parentPort!.postMessage({ through: view.through, heads: [...view.heads(source, kind)] });
} finally {
  view.close();
  db.close();
}
