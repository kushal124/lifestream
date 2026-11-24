import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openHome } from "../home-db.js";
import { openHomeFolder, type HomeFolder } from "../home-folder.js";
import { keyedFolder } from "./keyed.js";
import { spillingSort } from "./sorts.js";

function sortedIn(folder: HomeFolder): number {
  openHome(folder, "migrate").close();
  const db = folder.store({ role: "custody", remade: true }, join(folder.root, "custody.db"));
  try {
    return spillingSort(db);
  } finally {
    db.close();
  }
}

const root = process.argv[2]!;
const inherited = process.env.SQLITE_TMPDIR ?? null;
const there = inherited !== null && existsSync(inherited);
mkdirSync(join(root, "plain"), { recursive: true });
const plain = sortedIn(openHomeFolder(join(root, "plain")));
const keyed = sortedIn(keyedFolder(join(root, "keyed"), join(root, "machine")));
process.stdout.write(`${JSON.stringify({ inherited, there, plain, keyed, sorts: process.env.SQLITE_TMPDIR })}\n`);
