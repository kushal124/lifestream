import { readFileSync } from "node:fs";
import type { JsonObject } from "@lifestreamprotocol/core";
import { CHAT_LINE, RUNNER_CALLS, RUNNERS, type RunnerEnded, type RunnerListing, type RunnerPlaced } from "../runner-wire.js";
import { errorText, SendFailed, transcript, type Offer, type Transport } from "../transport.js";


export const CALL_PASS = "call";
const AWAY_MS = 15_000;
const BUSY_MS = 30_000;
const TIMEOUT_MS = 5 * 60_000;
const LISTING_MS = 5_000;

export interface RunnerOptions {
  door: string | undefined;
  pass: () => string | undefined;
  runners?: readonly RunnerListing[];
  fetch?: typeof fetch;
  clock?: () => number;
}

export function runnerTransport(options: RunnerOptions): Transport {
  const fetcher = options.fetch ?? fetch;
  const clock = options.clock ?? Date.now;
  const door = options.door?.replace(/\/+$/u, "");
  const runners = options.runners ?? [];
  return {
    name: "runner",
    provider: "the runner",
    cost: "free",
    leaves: null,
    defaults: { effort: "none", timeout_ms: TIMEOUT_MS, concurrency: runners.filter((runner) => runner.present).reduce((slots, runner) => slots + runner.slots, 0) },
    async available() {
      return door === undefined ? { ok: false, reason: "away", detail: "no door is known", until_ms: clock() + AWAY_MS } : { ok: true };
    },
    async offers() {
      return runners.flatMap((runner) => runner.files.map((file): Offer => ({
        model: file.id, name: file.name, kinds: file.kinds, text_chars: file.text_chars,
        runner: { unit: runner.unit, name: runner.name, battery: runner.power === "battery" }, ready: runner.present && file.state === "ready",
      })));
    },
    async send(request, attachments) {
      const pass = options.pass();
      const away = (message: string, scope?: "runner" | "route", ms = AWAY_MS) =>
        new SendFailed("runner", message, null, { until_ms: clock() + ms, ...(scope === undefined ? {} : { scope }) });
      if (door === undefined || pass === undefined) throw away("no door or call pass is handed");
      if (request.runner === undefined) throw new Error("a runner's call names its runner");
      const placed: RunnerPlaced = {
        runner: request.runner, model: request.model, input: request.input,
        ...(request.schema === undefined ? {} : { schema: JSON.parse(readFileSync(request.schema, "utf8")) as JsonObject }),
        attachments: attachments.map((file) => ({ media_type: file.media_type, base64: readFileSync(file.path).toString("base64") })),
        ...(request.line === undefined ? {} : { line: CHAT_LINE }),
      };
      let status: number;
      let body: string;
      try {
        const response = await fetcher(`${door}${RUNNER_CALLS}`, {
          method: "POST", headers: { authorization: `Bearer ${pass}`, "content-type": "application/json" }, body: JSON.stringify(placed), signal: request.signal,
        });
        status = response.status;
        body = await response.text();
      } catch (error) {
        if (request.signal.aborted) throw request.signal.reason;
        throw away(`the call's connection to the door was lost: ${errorText(error)}`);
      }
      if (status === 413) throw new Error("the call is larger than the door takes");
      if (status !== 200) throw away(`the door answered ${status}`);
      const ended = JSON.parse(body.trim()) as RunnerEnded;
      if ("ok" in ended) {
        const { text: said, model, input_tokens, output_tokens } = ended.ok;
        const text = attachments.some((file) => file.media_type.startsWith("audio/")) ? transcript(said) : said;
        return { text, model, ...(input_tokens === undefined ? {} : { input_tokens }), ...(output_tokens === undefined ? {} : { output_tokens }) };
      }
      const { code, reason, seconds } = ended.error;
      const said = `the runner's call ended ${code}${reason === undefined ? "" : ` (${reason})`}${seconds === undefined ? "" : `, ${seconds} s at most`}`;
      switch (code) {
        case "FAILED":
          if (reason === "failed") throw new SendFailed("runner", said, null, { scope: "route" });
          throw new Error(said);
        case "NOT_READY": throw away(said, "route");
        case "BUSY": throw away(said, "runner", BUSY_MS);
        case "INTERRUPTED":
          if (reason === "preempted") throw new SendFailed("runner", said, null, { yielded: true });
          throw away(said, "runner");
        case "NO_RUNNER": throw away(said, "runner");
      }
    },
  };
}

export async function listRunners(door: string, pass: string, fetcher: typeof fetch = fetch, timeoutMs = LISTING_MS): Promise<RunnerListing[]> {
  const response = await fetcher(`${door.replace(/\/+$/u, "")}${RUNNERS}`, { headers: { authorization: `Bearer ${pass}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (response.status !== 200) throw new Error(`the door answered ${response.status}`);
  return ((await response.json()) as { runners: RunnerListing[] }).runners;
}

export async function warmRunner(door: string, pass: string, runner: string, model: string, signal: AbortSignal, fetcher: typeof fetch = fetch): Promise<RunnerEnded> {
  const placed: RunnerPlaced = { runner, model, input: "", attachments: [], line: CHAT_LINE, warm: true };
  const response = await fetcher(`${door.replace(/\/+$/u, "")}${RUNNER_CALLS}`, {
    method: "POST", headers: { authorization: `Bearer ${pass}`, "content-type": "application/json" }, body: JSON.stringify(placed), signal,
  });
  const body = await response.text();
  if (response.status !== 200) throw new Error(`the door answered ${response.status}`);
  return JSON.parse(body.trim()) as RunnerEnded;
}
