import { isObject, type JsonObject } from "@lifestreamprotocol/core";
import { change, changeAll, effective, reset, SettingRefused, type Shown } from "../settings.js";
import { refuse } from "../refusal.js";
import { read, readArgs } from "./args.js";
import { fail, type VerbContext } from "./context.js";
import { CLI } from "../cli-name.js";

const USAGE = "settings [show] | settings set <key> <value> | settings set <object> | settings reset <key>";
const runs = (key: string) => key === "sources.off" ? "it runs from each device's next exchange, and the home's next poll and import"
  : key.startsWith("connectors.") ? "it runs from the connector's next poll"
  : key.startsWith("model.") ? "it runs at once: the next plan, pick and send follow it"
  : key.startsWith("privacy.") ? "it runs at once: the next hide and the marking job follow it"
  : key.startsWith("search.") ? "it runs at once: the runner is told its file, and the screen index's next run follows it" : "it runs from the home's next start";

export async function settings(ctx: VerbContext, args: readonly string[]) {
  const { positionals } = readArgs("settings", args, {}, USAGE, { min: 0, max: 3 });
  const [action = "show", key, value] = positionals;
  if (action === "show" && positionals.length <= 1) {
    const { shown, notices } = effective(ctx.folder);
    for (const each of shown) ctx.out(line(each));
    for (const notice of notices) ctx.out(`(info) ${notice.what}`);
    return { settings: shown, notices };
  }
  if (action === "set" && key !== undefined && value === undefined) {
    const members = read(key);
    if (!isObject(members)) return fail(`settings set takes a key and its value, or one JSON object of keys and values\nusage: ${CLI} ${USAGE}`);
    for (const each of Object.keys(members)) ownAct(each);
    const changed = refusing(() => changeAll(ctx.folder, members as JsonObject));
    ctx.settingsChanged?.(changed.map((each) => each.key));
    for (const each of changed) ctx.out(`${line(each)}; ${runs(each.key)}`);
    return { changed };
  }
  if (action === "set" && key !== undefined && value !== undefined) {
    ownAct(key);
    const written = read(value);
    const changed = refusing(() => change(ctx.folder, key, written));
    ctx.settingsChanged?.([changed.key]);
    ctx.out(`${line(changed)}; ${runs(changed.key)}`);
    return { changed };
  }
  if (action === "reset" && key !== undefined && value === undefined) {
    const changed = reset(ctx.folder, key);
    ctx.settingsChanged?.([changed.key]);
    ctx.out(`${line(changed)}; ${runs(changed.key)}`);
    return { changed };
  }
  return fail(`usage: ${CLI} ${USAGE}`);
}
settings.usage = USAGE;

function refusing<T>(set: () => T): T {
  try {
    return set();
  } catch (error) {
    if (error instanceof SettingRefused) refuse(422, "SETTING_REFUSED", error.message);
    throw error;
  }
}

function ownAct(key: string): void {
  if (key.startsWith("connectors.")) fail(`${key} is set a member at a time: use ${CLI} connectors set ${key.slice("connectors.".length)} <member> <value>`);
  if (key.startsWith("model.defaults.")) fail(`${key} is set by its own act: use ${CLI} models default ${key.slice("model.defaults.".length)} <route|none>`);
}

function line(shown: Shown): string {
  const whose = shown.from === "release" ? "the release's default" : shown.from === "unset" ? "the person's, not set" : "the person's";
  const limited = shown.written === undefined ? "" : `, written ${JSON.stringify(shown.written)} and run at the limit`;
  return `${shown.key} = ${shown.value === null ? "-" : JSON.stringify(shown.value)}  (${whose}${limited})`;
}
