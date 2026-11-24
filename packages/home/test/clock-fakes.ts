import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NeedsYou, NotYet, type Acquirer, type Connector, type Lent, type NeedReason, type Secrets, type WaitReason } from "@lifestreamprotocol/connect";
import type { JsonObject } from "@lifestreamprotocol/core";
import { connectorsWith } from "../registry-home.js";
import type { Registry, RegistryHome } from "../registry.js";
import { connectorSettings, type Settings } from "../settings.js";
import { fakeRows } from "./fakes.js";

const CLOCKED = {
  id: "fake-clock", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Synthetic notes, one a call.", noun: ["note", "notes"],
  sources: [{ id: "apple-notes:local:clock", read: "fake-rows", arrives: "poll" }],
  acquirers: ["fake-clock"],
  refresh: { default: "1h", min: "1m", max: "1d" },
  backfill: { pace: { default: "2m", min: "1m", max: "1h" } },
  fields: { label: { kind: "text", label: "Label", default: "synthetic" } },
} satisfies Connector;

const ON_REQUEST = {
  id: "fake-hand", product: "apple-notes", name: "Notes", vendor: "apple", type: "notes", records: "Synthetic notes, brought in by hand.",
  sources: [{ id: "apple-notes:local:hand", read: "fake-hand", arrives: "upload" }],
} satisfies Connector;

export const clockConnectors = (): readonly Connector[] => connectorsWith([CLOCKED, ON_REQUEST]);

export const SCRIPT = "clock-script.json";
export const POLLS = "clock-polls.ndjson";

export interface Answer {
  more?: true;
  facts?: JsonObject;
  next_ms?: number;
  left?: number | null;
  empty?: true;
  wait?: string;
  reason?: WaitReason;
  wait_ms?: number;
  backoff_ms?: number;
  need?: NeedReason;
  fail?: string;
}

export interface Ran {
  name: string;
  call: "fetch" | "page";
  n: number;
  label: string;
  start_ms: number | null;
}

export function ranOf(folder: string): Ran[] {
  return existsSync(join(folder, POLLS)) ? readFileSync(join(folder, POLLS), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Ran) : [];
}

function scripted(name: string, source: string, folder: string, label: string): Acquirer {
  const answered = (kind: "fetch" | "page", state: JsonObject | null, start_ms: number | null) => {
    const n = ranOf(folder).filter((each) => each.name === name && each.call === kind).length + 1;
    const script = existsSync(join(folder, SCRIPT)) ? JSON.parse(readFileSync(join(folder, SCRIPT), "utf8")) as Record<"fetch" | "page", Answer[]> : { fetch: [], page: [] };
    const answer = name === "fake-clock" ? script[kind][n - 1] ?? {} : {};
    appendFileSync(join(folder, POLLS), `${JSON.stringify({ name, call: kind, n, label, start_ms } satisfies Ran)}\n`);
    if (answer.fail !== undefined) throw new Error(answer.fail);
    if (answer.need !== undefined) throw new NeedsYou(answer.need, `synthetic: ${answer.need}`, { facts: answer.facts ?? {} });
    if (answer.wait !== undefined) {
      throw new NotYet(answer.reason ?? (answer.backoff_ms === undefined ? "retrying" : "provider-limit"), answer.wait, { next_ms: answer.wait_ms, backoff_ms: answer.backoff_ms, facts: answer.facts });
    }
    if (answer.empty === true) return { files: [], facts: answer.facts ?? {}, state: { ...state, [kind]: n }, answer };
    const at = Date.now();
    const row = { kind: "note", key: `${name}-${kind}-${n}`, content: { text: `${label} ${kind} ${n}`, at }, at };
    return {
      files: [{ path: "rows.ndjson", bytes: Buffer.from(`${JSON.stringify(row)}\n`) }], facts: answer.facts ?? {}, state: { ...state, [kind]: n },
      ...(answer.next_ms === undefined ? {} : { next_ms: answer.next_ms }), ...(answer.backoff_ms === undefined ? {} : { backoff_ms: answer.backoff_ms }), answer,
    };
  };
  return {
    name, source,
    async fetch(state, _secrets, lent) {
      const { answer, ...fetched } = answered("fetch", state, lent.start_ms);
      return { ...fetched, ...(answer.more === undefined ? {} : { more: answer.more }) };
    },
    ...(name === "fake-clock" ? {
      async page(state: JsonObject | null, _secrets: Secrets, lent: Lent) {
        const { answer, ...fetched } = answered("page", state, lent.start_ms);
        return { ...fetched, left: answer.left === undefined ? 1 : answer.left };
      },
    } : {}),
  };
}

export default function registry(settings: Settings, home: RegistryHome): Registry {
  const folder = home.root;
  const running = connectorSettings(CLOCKED, settings.connectors[CLOCKED.id]);
  const label = running.fields.label as string;
  return {
    connectors: clockConnectors(), readers: [fakeRows, { ...fakeRows, name: "fake-hand" }], families: [],
    acquirers: [
      scripted("fake-clock", "apple-notes:local:clock", folder, label),
    ],
  };
}
