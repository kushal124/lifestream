import { readdirSync } from "node:fs";
import { join } from "node:path";
import { makeReady } from "@lifestreamprotocol/model";
import { failpoint } from "../failpoint.js";
import { programFolder, type ProgramRow } from "../subscriptions.js";

const signs = async (folder: string) => readdirSync(folder, { recursive: true, withFileTypes: true }).filter((each) => each.isFile()).map((each) => join(each.parentPath, each.name));
const row = JSON.parse(process.argv[3]!) as ProgramRow;
await makeReady(programFolder(process.argv[2]!, row.name), row, { signed: signs, env: process.env, failpoint: (at) => failpoint(`programs.${at}`) });
