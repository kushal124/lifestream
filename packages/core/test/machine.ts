import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { madeScratch, SORTS, spillSorts } from "../scratch.js";

let shared: string | undefined;

export function testMachine(): string {
  if (shared === undefined) {
    const made = mkdtempSync(join(tmpdir(), "lifestream-machine-"));
    process.once("exit", () => rmSync(made, { recursive: true, force: true }));
    const refused = spillSorts(join(madeScratch(made), SORTS));
    if (refused !== null) throw new Error(refused);
    shared = made;
  }
  return shared;
}
