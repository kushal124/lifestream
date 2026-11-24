import { planKind, sendKind } from "./asks.js";
import { extractKind, renderKind, walkKind } from "./derive.js";
import { HANDED_KEY, handedKind } from "./handed.js";
import { importKind, indexKind as inboxKind, labelKind, pollKind } from "./import.js";
import { indexKind, INDEXES } from "./index-job.js";
import type { Kind } from "./jobs.js";
import { peopleKind } from "./people.js";
import { placesKind } from "./places.js";
import { QUIET_KEY, quietKind } from "./quiet.js";
import type { Registry } from "./registry.js";
import { repairKind } from "./repair.js";
import { STORED_KEY, storedKind } from "./stored.js";
import { sweepKind } from "./sweep.js";
import { HELD_KEY, heldKind, LEFT_KEY, leftKind, TALLY_KEY, tallyKind } from "./tally.js";
import { installKind } from "./verbs/faces.js";

export const KINDS: Readonly<Record<string, Kind>> = {
  "index-inbox": inboxKind, import: importKind, poll: pollKind, label: labelKind,
  extract: extractKind, walk: walkKind, render: renderKind,
  plan: planKind, send: sendKind,
  sweep: sweepKind, repair: repairKind, index: indexKind, people: peopleKind, places: placesKind, install: installKind, tally: tallyKind, held: heldKind, left: leftKind, quiet: quietKind,
  stored: storedKind, handed: handedKind,
};

export const ONE_KEY: Readonly<Record<string, string>> = { render: "days", "index-inbox": "inbox", people: "people", places: "places", install: "faces", tally: TALLY_KEY, held: HELD_KEY, left: LEFT_KEY, quiet: QUIET_KEY, stored: STORED_KEY, handed: HANDED_KEY };
export const ANY_KEY: readonly string[] = ["sweep", "repair"];

export function unrun(registry: Registry, sources: ReadonlySet<string>, kind: string, key: string): string | null {
  if (!Object.hasOwn(KINDS, kind)) return `no job kind ${kind}; the home runs ${Object.keys(KINDS).sort().join(", ")}`;
  const one = ONE_KEY[kind];
  if (one !== undefined) return key === one ? null : `the one ${kind} job's key is ${one}`;
  if (ANY_KEY.includes(kind)) return null;
  if (kind === "import") return sources.has(key) ? null : `no source ${key} is added`;
  if (kind === "index") return INDEXES.some((index) => index.name === key) ? null : `no index ${key}; the home's indexes: ${INDEXES.map((index) => index.name).join(", ")}`;
  const keys = kind === "poll" ? (registry.acquirers ?? []).map((acquirer) => acquirer.name)
    : kind === "label" ? (registry.labelers ?? []).map((labeler) => labeler.name)
    : registry.families.map((family) => family.name);
  return keys.includes(key) ? null : `no ${kind} job ${key}; the home's ${kind} jobs: ${keys.sort().join(", ") || "none"}`;
}

export function unpausable(registry: Registry, sources: ReadonlySet<string>, target: string, runners: ReadonlySet<string>): string | null {
  if (target === "home") return null;
  const [kind = "", key = ""] = target.split(/:(.*)/su);
  const forms = "a pause is home, kind:<kind>, <kind>:<key>, pause:<connector>, pause:<connector>:history or runner:<unit>";
  if (key === "") return `${forms}, not ${target}`;
  if (kind === "pause") {
    const connector = key.endsWith(":history") ? key.slice(0, -":history".length) : key;
    return registry.connectors.some((each) => each.id === connector) ? null : `no connector ${connector} is declared`;
  }
  if (kind === "runner") return runners.has(key) ? null : `the door holds no runner ${key}; it holds ${[...runners].sort().join(", ") || "none"}`;
  const what = kind === "kind" ? key : kind;
  if (!Object.hasOwn(KINDS, what)) return `${forms}: no job kind ${what}; the home runs ${Object.keys(KINDS).sort().join(", ")}`;
  if (kind === "kind") return null;
  if (ANY_KEY.includes(kind)) return `a ${kind} job's key is a day or a run: pause kind:${kind}`;
  return unrun(registry, sources, kind, key);
}
