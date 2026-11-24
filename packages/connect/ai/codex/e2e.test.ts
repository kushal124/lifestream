import { describe, expect, it } from "vitest";
import { isObject, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, openTestHome, type Head } from "../../test/drive.js";
import { AGENT_TURN } from "../../shared/sessions.js";
import { partsFiles, sealedBundle } from "../test/sessions.js";
import { CODEX, CODEX_LINE, codexSessions } from "./reader.js";
import { id, LOG, meta, PERSON, SOURCE } from "./test/fixtures.js";

const SEGMENT = `${PERSON}_${id("e1")}`;
const SUBAGENT = id("d4");
const ARCHIVED = id("d3");
const FIRST = sealedBundle(new URL("./test/bundle-1.zip", import.meta.url));
const SECOND = sealedBundle(new URL("./test/bundle-2.zip", import.meta.url));
const FACTS = { snapshot_taken_at: "2026-10-01T11:00:00.000Z" };

function line(head: Head): JsonObject {
  return (head.content as { line: JsonObject }).line;
}

function item(n: number): string {
  return JSON.stringify({ timestamp: "2026-10-01T10:00:01.000Z", type: "event_msg", payload: { type: "token_count", info: null }, ordinal: n });
}

describe("Codex sessions: each of these is impossible", () => {
  it("the Mac's bundles land other records than each log's lines, numbered from its first, at other times", async () => {
    expect([FIRST.feeder, SECOND.feeder]).toEqual([CODEX, CODEX]);
    const home = openTestHome();
    try {
      const first = await home.land(codexSessions, deliver(home, SOURCE, FIRST.files, FIRST.facts));
      expect(first).toMatchObject({ new: 20, refused: 0, duplicated: 0 });
      const second = await home.land(codexSessions, deliver(home, SOURCE, SECOND.files, SECOND.facts));
      expect(second).toMatchObject({ new: 2, restated: 0, changed: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      const keys = (session: string, lines: number): string[] => Array.from({ length: lines }, (_, n) => `${session}:${n + 1}`);
      expect(heads.map((head) => head.key).sort()).toEqual([
        ...keys(ARCHIVED, 2), ...keys(PERSON, 13), ...keys(SEGMENT, 3), ...keys(SUBAGENT, 4),
      ].sort());
      expect(new Set(heads.map((head) => head.kind))).toEqual(new Set([AGENT_TURN]));
      for (const head of heads) {
        expect(head.start_ms).toBe(Date.parse(line(head).timestamp as string));
        expect((head.content as JsonObject).type).toBe(CODEX_LINE);
      }
      expect(line(heads.find((head) => head.key === `${SEGMENT}:1`)!).payload).toMatchObject({ id: PERSON, history_base: { thread_id: PERSON } });
      const tokens = heads.map(line).find((stated) => isObject(stated.payload) && stated.payload.type === "token_count")!;
      expect(JSON.stringify(tokens)).toContain('"output_tokens":"9007199254740993"');
      artifact(home.dir, "heads.json", { first, second, heads });
    } finally {
      home.close();
    }
  });

  it("a reader cannot tell a typed prompt from a sub-agent's prompt, a notice, a tool result or an assistant turn", async () => {
    const home = openTestHome();
    try {
      for (const bundle of [FIRST, SECOND]) await home.land(codexSessions, deliver(home, SOURCE, bundle.files, bundle.facts));
      const role = (stated: JsonObject): string => {
        const payload = stated.payload as JsonObject;
        if (stated.type === "event_msg" && payload.type === "item_completed" && isObject(payload.item) && payload.item.type === "UserMessage") return "typed";
        if (stated.type !== "response_item") return "other";
        if (payload.type === "agent_message") return "sub-agent-prompt";
        if (payload.type === "function_call_output") return "tool-result";
        if (payload.type === "message" && (payload.role === "developer" || (payload.role === "user" && JSON.stringify(payload.content).includes("<environment_context>")))) return "notice";
        if (payload.type === "message" && payload.role === "user") return "prompt";
        if (payload.role === "assistant" || payload.type === "reasoning" || payload.type === "function_call") return "assistant";
        return "other";
      };
      const by: Record<string, string[]> = {};
      for (const head of home.heads(SOURCE)) {
        const kind = role(line(head));
        if (kind !== "other") (by[kind] ??= []).push(head.key);
      }
      for (const keys of Object.values(by)) keys.sort();
      expect(by).toEqual({
        typed: [`${PERSON}:6`],
        prompt: [`${PERSON}:5`, `${PERSON}:12`, `${SEGMENT}:2`, `${ARCHIVED}:2`].sort(),
        notice: [`${PERSON}:3`, `${PERSON}:4`].sort(),
        "tool-result": [`${PERSON}:9`],
        assistant: [`${PERSON}:7`, `${PERSON}:8`, `${PERSON}:10`, `${PERSON}:13`, `${SEGMENT}:3`, `${SUBAGENT}:4`].sort(),
        "sub-agent-prompt": [`${SUBAGENT}:3`],
      });
      const started = line(home.heads(SOURCE).find((head) => head.key === `${SUBAGENT}:1`)!).payload as JsonObject;
      expect(started).toMatchObject({ thread_source: "subagent", parent_thread_id: PERSON });
      artifact(home.dir, "roles.json", by);
    } finally {
      home.close();
    }
  });

  it("the same bundle again writes anything new", async () => {
    const home = openTestHome();
    try {
      await home.land(codexSessions, deliver(home, SOURCE, FIRST.files, FIRST.facts));
      const again = await home.land(codexSessions, deliver(home, SOURCE, FIRST.files, { snapshot_taken_at: "2026-10-01T11:10:00.000Z" }));
      expect(again).toMatchObject({ new: 0, restated: 20, changed: 0, gone: 0 });
      artifact(home.dir, "restated.json", again);
    } finally {
      home.close();
    }
  });

  it("a session a program started lands, is refused once per line, or takes another log with it; a log's first line that does not read, or is not its session's meta, lands the lines after it", async () => {
    const home = openTestHome();
    try {
      const cases: [RegExp, string][] = [
        [/a program started this session/u, meta({ originator: "codex_exec", source: "exec" })],
        [/a program started this session/u, meta({ source: "exec" })],
        [/a program started this session/u, meta({ thread_source: "automation" })],
        [/states session/u, meta({ id: id("ff") })],
        [/must be the session's meta/u, item(0)],
        [/line 1: /u, "{\"type\":\"session_meta\","],
      ];
      const other = `rollout-2026-10-01T10-00-00-${ARCHIVED}.jsonl`;
      for (const [message, first] of cases) {
        const files = partsFiles({ [LOG]: { lines: [first, item(1), item(2), item(3)] }, [other]: { lines: [meta({ id: ARCHIVED, session_id: ARCHIVED }), item(1)] } });
        const rows = await collect(codexSessions.read(deliver(home, SOURCE, files, FACTS), home.blobs));
        expect(rows.filter((row) => row.refused === undefined).map((row) => row.key), String(message)).toEqual([`${ARCHIVED}:1`, `${ARCHIVED}:2`]);
        expect(rows.filter((row) => row.refused !== undefined).map((row) => row.key), String(message)).toEqual([LOG]);
        expect(rows.find((row) => row.refused !== undefined)!.refused, String(message)).toMatch(message);
      }
      const later = await collect(codexSessions.read(deliver(home, SOURCE, partsFiles({ [LOG]: { lines: [item(40)], from_line: 41 } }), FACTS), home.blobs));
      expect(later.map((row) => row.key)).toEqual([`${PERSON}:41`]);
    } finally {
      home.close();
    }
  });

  it("a log whose name is no rollout's is read, or Codex carries a whole file", async () => {
    const home = openTestHome();
    try {
      for (const name of [`rollout-${PERSON}.jsonl`, `rollout-2026-10-01T10-00-00-${PERSON}.json`, `history.jsonl`]) {
        const files = partsFiles({ [name]: { lines: [meta({})] } });
        await expect(collect(codexSessions.read(deliver(home, SOURCE, files, FACTS), home.blobs)), name).rejects.toThrow(/not a session log/u);
      }
      const whole = partsFiles({ [LOG]: { lines: [meta({})] } }, { "attachment.png": Buffer.from("x") });
      await expect(collect(codexSessions.read(deliver(home, SOURCE, whole, FACTS), home.blobs))).rejects.toThrow(/not a session's file/u);
    } finally {
      home.close();
    }
  });
});
