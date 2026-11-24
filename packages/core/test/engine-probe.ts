import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { openHome } from "../home-db.js";
import { openHandedFolder, openHomeFolder, type HandedFolder, type HomeFolder, type StoreKind } from "../home-folder.js";
import { openMemo } from "../memo.js";
import { keyedFolder } from "./keyed.js";

const ENGINE = "better-sqlite3-multiple-ciphers";
const CUSTODY: StoreKind = { role: "custody", remade: true };
const SEARCH: StoreKind = { role: "search", remade: true };

interface Written {
  form: string;
  rows: string[];
}

function writeAndRead(folder: HomeFolder, by: string): { written: Written; close(): void } {
  const db = folder.store(CUSTODY, join(folder.root, "both.db"));
  db.exec("CREATE TABLE IF NOT EXISTS probe (by TEXT NOT NULL)");
  db.prepare("INSERT INTO probe (by) VALUES (?)").run(by);
  const rows = db.prepare("SELECT by FROM probe ORDER BY rowid").pluck().all() as string[];
  return { written: { form: folder.form, rows }, close: () => db.close() };
}

function both(folders: readonly HomeFolder[], by: string): Written[] {
  const opened = folders.map((folder) => writeAndRead(folder, by));
  const written = opened.map((each) => each.written);
  for (const each of opened) each.close();
  return written;
}

function loaded(): { modules: number; binaries: number } {
  const modules = Object.keys(createRequire(import.meta.url).cache).filter((path) => path.includes(ENGINE));
  const report = process.report.getReport() as unknown as { sharedObjects: string[] };
  const binaries = report.sharedObjects.filter((path) => path.includes(ENGINE));
  return { modules: modules.length, binaries: binaries.length };
}

if (!isMainThread) {
  const folders = (workerData as HandedFolder[]).map(openHandedFolder);
  parentPort!.postMessage(both(folders, "worker"));
} else {
  const [root, form] = process.argv.slice(2) as [string, "plain" | "keyed" | "both"];
  if (form === "both") {
    for (const name of ["keyed", "plain"]) mkdirSync(join(root, name), { recursive: true });
    const folders = [keyedFolder(join(root, "keyed"), join(root, "machine")), openHomeFolder(join(root, "plain"))];
    const held = folders.map((folder) => writeAndRead(folder, "main"));
    const worker = new Worker(new URL(import.meta.url), { workerData: folders.map((folder) => folder.handOver()) });
    const threaded = await new Promise<Written[]>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    await worker.terminate();
    const main = held.map((each) => each.written);
    for (const each of held) each.close();
    const after = both(folders, "main-after");
    process.stdout.write(`${JSON.stringify({ ...loaded(), main, worker: threaded, after })}\n`);
  } else {
    const folder = form === "keyed" ? keyedFolder(root, join(root, "machine")) : openHomeFolder(root);
    openHome(folder, "migrate").close();
    openHome(folder, "write").close();
    openHome(folder, "read").close();
    folder.store(CUSTODY, join(root, "custody.db")).close();
    folder.store(SEARCH, join(root, "search.db"), { sync: "NORMAL" }).close();
    openMemo(folder, join(root, "memo.db"), "1").close();
    process.stdout.write(`${JSON.stringify(loaded())}\n`);
  }
}
