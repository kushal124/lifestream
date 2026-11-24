import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openHomeFolder, type HomeFolder, type Program } from "../home-folder.js";
import { Keys } from "../keys.js";
import { keyId } from "../secrets.js";
import { testMachine } from "./machine.js";

export { testMachine };

export const TEST_DATA_KEY = Buffer.alloc(32, 0x5a);
export const TEST_KEY_ID = keyId(TEST_DATA_KEY);

export function keyedFolder(root: string, machine: string = testMachine(), program: Program = "home"): HomeFolder {
  mkdirSync(join(root, "config"), { recursive: true, mode: 0o700 });
  const vault = { version: 2, counter: 1, key_id: TEST_KEY_ID, slots: [], keys: [{ kind: "data", id: 1, made_ms: 0, wrapped: "c3ludGhldGlj" }] };
  writeFileSync(join(root, "config", "vault.json"), JSON.stringify(vault));
  return openHomeFolder(root, { machine, program, keys: Keys.derive(TEST_DATA_KEY), vault: TEST_KEY_ID });
}
