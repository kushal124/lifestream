import { act } from "./act.js";
import { agents } from "./agents.js";
import { erase } from "./erase.js";
import { claude } from "./claude.js";
import { codex } from "./codex.js";
import { connect } from "./connect.js";
import { connectors } from "./connectors.js";
import type { Verb } from "./context.js";
import { device } from "./device.js";
import { drop } from "./drop.js";
import { faces } from "./faces.js";
import { importVerb } from "./import.js";
import { pause, resume, run } from "./loop.js";
import { models } from "./models.js";
import { outbound } from "./outbound.js";
import { pair } from "./pair.js";
import { principals } from "./principals.js";
import { rebuild } from "./rebuild.js";
import { repair } from "./repair.js";
import { report } from "./report.js";
import { settings } from "./settings.js";
import { setup } from "./setup.js";
import { source } from "./source.js";
import { status } from "./status.js";
import { rehydrate, sweep } from "./sweep.js";
import { undo } from "./undo.js";

export const VERBS: Readonly<Record<string, Verb>> = {
  status, report, outbound, codex, claude, settings, repair, undo, rebuild, erase, drop, act, import: importVerb, source, device, setup, pair, connect, connectors, models, agents, faces, principals, sweep, rehydrate, run,
  pause, resume,
};

export { maintenance } from "./maintenance.js";
export { fail, readOpsSettings, VerbError, type OpsSettings, type Verb, type VerbContext } from "./context.js";
