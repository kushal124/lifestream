import { roadsOf, vendorOf } from "@lifestreamprotocol/connect";
import { SourceNameError, sourceName, type JsonObject } from "@lifestreamprotocol/core";
import { declaredOf } from "../catalog.js";
import { readerFor } from "../registry.js";
import { readArgs, required } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "source add <product>:<account>:<copy> --connector <reader> [--options <json>]";

export async function source(ctx: VerbContext, args: readonly string[]) {
  const { values, positionals } = readArgs("source", args, { connector: { type: "string" }, options: { type: "string" } }, USAGE, 2);
  const [what, id] = positionals as [string, string];
  if (what !== "add") fail(`usage: ${CLI} ${USAGE}`);
  try {
    sourceName(id);
  } catch (error) {
    if (error instanceof SourceNameError) fail(`${error.message}\nusage: ${CLI} ${USAGE}`);
    throw error;
  }
  const connector = required(values.connector, "connector", USAGE);
  let options: unknown;
  try {
    options = values.options === undefined ? {} : JSON.parse(values.options);
  } catch (error) {
    fail(`--options is a JSON object: ${(error as Error).message}`);
  }
  if (typeof options !== "object" || options === null || Array.isArray(options)) fail("--options is a JSON object");
  const registry = await ctx.registry();
  let vendor: string;
  try {
    vendor = vendorOf(registry.connectors, id);
  } catch (error) {
    if (error instanceof SourceNameError) fail(`${error.message}\nusage: ${CLI} ${USAGE}`);
    throw error;
  }
  if (readerFor(registry, { connector }) === undefined) {
    const known = registry.readers.map((each) => each.name);
    fail(`no connector ${connector}; the home knows ${known.sort().join(", ") || "none"}`);
  }
  const { product, copy } = sourceName(id);
  const site = registry.connectors.find((each) => each.product === product && each.chrome !== undefined
    && each.sources.some((declared) => declared.read === connector || declared.feeders?.includes(connector) === true));
  const named = (key: string) => typeof (options as JsonObject)[key] === "string" && ((options as JsonObject)[key] as string).trim() !== "";
  if (site !== undefined && copy !== "export" && roadsOf(declaredOf(site, { connector, options: options as JsonObject })).includes("chrome")
    && !named("email") && !named("name")) {
    fail(`${id} is read in Chrome, where its account is named as the site shows it: add --options '{"name":"<your name as ${site.name} shows it>"}' (or "email", where it shows one)`);
  }
  const now = ctx.now();
  return ctx.db.commit((tx) => {
    if (tx.tables.sources.get(id) !== undefined) fail(`source ${id} exists`);
    tx.tables.sources.add({ id, vendor, connector, options: options as JsonObject, added_ms: now });
    tx.tables.events.append({ at_ms: now, kind: "source-add", key: id, detail: { connector } });
    return tx.tables.sources.get(id)!;
  });
}
source.usage = USAGE;
