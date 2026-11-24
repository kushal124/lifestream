import { ownerOnly } from "@lifestreamprotocol/core";
import { runCli } from "../cli.js";

ownerOnly();
runCli(process.argv.slice(2)).then((status) => process.stdout.write("", () => process.exit(status)));
