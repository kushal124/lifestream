import { describe, expect, it } from "vitest";
import { isObject, type JsonObject } from "@lifestreamprotocol/core";
import { artifact, collect, deliver, openTestHome, type Head } from "../../test/drive.js";
import { Refused } from "../../shared/refused.js";
import { AGENT_TURN } from "../../shared/sessions.js";
import { partsFiles, sealedBundle } from "../test/sessions.js";
import { CLAUDE_CODE, CLAUDE_CODE_LINE, claudeCodeSessions } from "./reader.js";
import { LOG, SESSION, SOURCE, typed, uuid } from "./test/fixtures.js";

const AGENT = `${SESSION}/subagents/agent-a0000000000000001.jsonl`;
const FIRST = sealedBundle(new URL("./test/bundle-1.zip", import.meta.url));
const SECOND = sealedBundle(new URL("./test/bundle-2.zip", import.meta.url));

function line(head: Head): JsonObject {
  const content = head.content as { line: JsonObject };
  return content.line;
}

describe("Claude Code sessions: each of these is impossible", () => {
  it("the Mac's bundles land other records than their lines' uuids, at other times", async () => {
    expect([FIRST.feeder, SECOND.feeder]).toEqual([CLAUDE_CODE, CLAUDE_CODE]);
    const home = openTestHome();
    try {
      const first = await home.land(claudeCodeSessions, deliver(home, SOURCE, FIRST.files, FIRST.facts));
      expect(first).toMatchObject({ new: 10, refused: 0, duplicated: 0 });
      const second = await home.land(claudeCodeSessions, deliver(home, SOURCE, SECOND.files, SECOND.facts));
      expect(second).toMatchObject({ new: 4, restated: 0, changed: 0, gone: 0 });
      const heads = home.heads(SOURCE);
      expect(heads.map((head) => head.key)).toEqual([...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 101, 102, 103, 301].map(uuid)]);
      expect(new Set(heads.map((head) => head.kind))).toEqual(new Set([AGENT_TURN]));
      for (const head of heads) {
        expect(head.start_ms).toBe(Date.parse(line(head).timestamp as string));
        expect((head.content as JsonObject).type).toBe(CLAUDE_CODE_LINE);
        expect(line(head).uuid).toBe(head.key);
      }
      artifact(home.dir, "heads.json", { first, second, heads });
    } finally {
      home.close();
    }
  });

  it("a reader cannot tell a typed prompt from a sub-agent's prompt, a notice, a tool result or an assistant turn", async () => {
    const home = openTestHome();
    try {
      for (const bundle of [FIRST, SECOND]) await home.land(claudeCodeSessions, deliver(home, SOURCE, bundle.files, bundle.facts));
      const role = (stated: JsonObject): string => {
        if (stated.type === "assistant") return "assistant";
        if (stated.type === "system") return "system";
        if (stated.type === "attachment" || stated.isMeta === true) return "notice";
        const message = stated.message as JsonObject;
        if (stated.toolUseResult !== undefined || (Array.isArray(message.content) && message.content.some((part) => isObject(part) && part.type === "tool_result"))) return "tool-result";
        if (stated.isSidechain === true && stated.parentUuid === null) return "sub-agent-prompt";
        if (isObject(stated.origin) && stated.origin.kind === "human") return "typed";
        return "other";
      };
      const by: Record<string, string[]> = {};
      for (const head of home.heads(SOURCE)) (by[role(line(head))] ??= []).push(head.key);
      expect(by).toEqual({
        typed: [uuid(1), uuid(8), uuid(301)],
        "sub-agent-prompt": [uuid(101)],
        notice: [uuid(2), uuid(5), uuid(102)],
        "tool-result": [uuid(4), uuid(10)],
        assistant: [uuid(3), uuid(7), uuid(9), uuid(103)],
        system: [uuid(6)],
      });
      expect(home.heads(SOURCE).filter((head) => line(head).agentId === "a0000000000000001").map((head) => head.key)).toEqual([101, 102, 103].map(uuid));
      artifact(home.dir, "roles.json", by);
    } finally {
      home.close();
    }
  });

  it("the same bundle again writes anything new, or a later one moves or drops an earlier line", async () => {
    const home = openTestHome();
    try {
      await home.land(claudeCodeSessions, deliver(home, SOURCE, FIRST.files, FIRST.facts));
      const before = home.heads(SOURCE);
      const again = await home.land(claudeCodeSessions, deliver(home, SOURCE, FIRST.files, { snapshot_taken_at: "2026-10-01T11:10:00.000Z" }));
      expect(again).toMatchObject({ new: 0, restated: 10, changed: 0, gone: 0 });
      await home.land(claudeCodeSessions, deliver(home, SOURCE, SECOND.files, SECOND.facts));
      const after = new Map(home.heads(SOURCE).map((head) => [head.key, head.version]));
      for (const head of before) expect(after.get(head.key)).toBe(head.version);
      artifact(home.dir, "restated.json", again);
    } finally {
      home.close();
    }
  });

  it("a line that names a tool output does not link its bytes, whichever delivery carried them, or a session's other files are lost", async () => {
    const home = openTestHome();
    try {
      const first = deliver(home, SOURCE, FIRST.files, FIRST.facts);
      const firstRows = await collect(claudeCodeSessions.read(first, home.blobs));
      await home.land(claudeCodeSessions, first, firstRows);
      const second = deliver(home, SOURCE, SECOND.files, SECOND.facts);
      const secondRows = await collect(claudeCodeSessions.read(second, home.blobs));
      await home.land(claudeCodeSessions, second, secondRows);
      const blobOf = (delivery: typeof first, name: string): string => delivery.files.find((file) => file.path === `${SESSION}/tool-results/${name}`)!.blob;
      const rows = new Map([...firstRows, ...secondRows].map((row) => [row.key, row]));
      expect(rows.get(uuid(4))!.blobs).toEqual([blobOf(first, "toolu_01.txt")]);
      expect(rows.get(uuid(10))!.blobs).toEqual([blobOf(first, "toolu_01.txt"), blobOf(second, "toolu_02.txt")]);
      for (const blob of rows.get(uuid(10))!.blobs!) expect(home.blobs.has(blob)).toBe(true);
      expect(first.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        `${SESSION}/tool-results/toolu_09.txt`, `${SESSION}/subagents/agent-a0000000000000001.meta.json`,
        `${SESSION}/tool-results/pdf-00000000-0000-4000-8000-0000000000f1/page-1.jpg`,
      ]));
      expect([...rows.values()].filter((row) => (row.blobs ?? []).length > 0).map((row) => row.key)).toEqual([uuid(4), uuid(10)]);
      artifact(home.dir, "blobs.json", [...rows.values()].map((row) => ({ key: row.key, blobs: row.blobs ?? [] })));
    } finally {
      home.close();
    }
  });

  it("a line that is not JSON lands, refuses its neighbours, or its refusal does not name its log and line", async () => {
    const home = openTestHome();
    try {
      const files = partsFiles({ [LOG]: { lines: [typed(1), "{\"type\":", typed(2)], from_line: 12, from_byte: 4096 } });
      const landed = await home.land(claudeCodeSessions, deliver(home, SOURCE, files, { snapshot_taken_at: "2026-10-01T11:00:00.000Z" }));
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals).toEqual([{ kind: "file", key: `${LOG} line 13`, violations: [expect.stringContaining(`${LOG} line 13`)] }]);
      artifact(home.dir, "refused.json", landed);
    } finally {
      home.close();
    }
  });

  it("a delivery whose parts.json disagrees with what it carries is read", async () => {
    const home = openTestHome();
    const facts = { snapshot_taken_at: "2026-10-01T11:00:00.000Z" };
    try {
      const good = partsFiles({ [LOG]: { lines: [typed(1)] } });
      const cases: [RegExp, Record<string, Buffer>][] = [
        [/carries no parts\.json/u, { [LOG]: good[LOG]! }],
        [/is carried but parts\.json states no part of it/u, { ...good, [AGENT]: Buffer.from(`${typed(2)}\n`) }],
        [/which the delivery does not carry/u, { "parts.json": partsFiles({ [LOG]: { lines: [typed(1)] }, [AGENT]: { lines: [typed(2)] } })["parts.json"]!, [LOG]: good[LOG]! }],
        [/which is not a session log/u, partsFiles({ "notes/../memory.md": { lines: [typed(1)] } })],
        [/starts at byte 0 but line 3/u, partsFiles({ [LOG]: { lines: [typed(1)], from_line: 3, from_byte: 0 } })],
        [/is not the bytes parts\.json states/u, { ...partsFiles({ [LOG]: { lines: [typed(1)] } }, { [`${SESSION}/tool-results/a.txt`]: Buffer.from("one") }), [`${SESSION}/tool-results/a.txt`]: Buffer.from("two") }],
        [/which is not a session's file/u, partsFiles({ [LOG]: { lines: [typed(1)] } }, { [`${SESSION}/tool-results/../../memory.md`]: Buffer.from("x") })],
      ];
      for (const [message, files] of cases) {
        const read = collect(claudeCodeSessions.read(deliver(home, SOURCE, files, facts), home.blobs));
        await expect(read, String(message)).rejects.toThrow(Refused);
        await expect(read, String(message)).rejects.toThrow(message);
      }
      const counted = { ...partsFiles({ [LOG]: { lines: [typed(1)] }, [AGENT]: { lines: [typed(3)] } }), [LOG]: Buffer.from(`${typed(1)}\n${typed(2)}\n`) };
      const landed = await home.land(claudeCodeSessions, deliver(home, SOURCE, counted, facts));
      expect(landed).toMatchObject({ new: 3, refused: 1 });
      expect(landed.refusals[0]).toMatchObject({ key: LOG, violations: [expect.stringMatching(/holds 2 lines from line 1; parts\.json states 1/u)] });
    } finally {
      home.close();
    }
  });

  it("a session a program started lands, is refused once per line, or takes another session with it; a log whose lines before its entrypoint do not read lands the lines after", async () => {
    const home = openTestHome();
    try {
      const files = partsFiles({
        [LOG]: { lines: ["{\"type\":\"queue-operation\",\"operation\":\"enqueue\"}", typed(1, { entrypoint: "sdk-cli", promptSource: "sdk" }), typed(2)] },
        [AGENT]: { lines: [typed(3)] },
      });
      const landed = await home.land(claudeCodeSessions, deliver(home, SOURCE, files, { snapshot_taken_at: "2026-10-01T11:00:00.000Z" }));
      expect(landed).toMatchObject({ new: 1, refused: 1 });
      expect(landed.refusals.map((refusal) => refusal.key)).toEqual([LOG]);
      expect(landed.refusals[0]!.violations[0]).toMatch(/line 2: a program started this session/u);
      expect(home.heads(SOURCE).map((head) => head.key)).toEqual([uuid(3)]);
      const unread = partsFiles({ [LOG]: { lines: ["{\"type\":", typed(1), typed(2)] } });
      const rows = await collect(claudeCodeSessions.read(deliver(home, SOURCE, unread, { snapshot_taken_at: "2026-10-01T11:00:00.000Z" }), home.blobs));
      expect(rows.map((row) => [row.key, row.refused === undefined])).toEqual([[LOG, false]]);
      const later = partsFiles({ [LOG]: { lines: [typed(1), typed(2, { entrypoint: "sdk-cli" })] } });
      expect(await collect(claudeCodeSessions.read(deliver(home, SOURCE, later, { snapshot_taken_at: "2026-10-01T11:00:00.000Z" }), home.blobs))).toHaveLength(2);
    } finally {
      home.close();
    }
  });

  it("a turn outside the contract lands, or takes the delivery's other turns with it", async () => {
    const home = openTestHome();
    try {
      const files = partsFiles({ [LOG]: { lines: [typed(1), typed(2, { timestamp: "yesterday" }), typed(3)] } });
      const landed = await home.land(claudeCodeSessions, deliver(home, SOURCE, files, { snapshot_taken_at: "2026-10-01T11:00:00.000Z" }));
      expect(landed).toMatchObject({ new: 2, refused: 1 });
      expect(landed.refusals[0]!.violations).toEqual(["line.timestamp must be an RFC 3339 instant"]);
      artifact(home.dir, "landed.json", landed);
    } finally {
      home.close();
    }
  });
});
