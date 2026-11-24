import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { type DaySettings, type ExtractRow, type JsonObject, type ReaderOutput } from "@lifestreamprotocol/core";
import { checkDayFile, type DayDocument } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import { FED } from "../test/fed.js";
import { aiFamily as aiOver } from "./family.js";
import { HOURS_HELD, mergeSessions, TURN_CAP, type SessionDay, type SessionHour } from "./sessions.js";
import { A1, agentDeliveries, C3, CLAUDE_CODE, claudeCodeRow, CODEX, codexRows, D1, D3 } from "./test/agents.js";
import { shuffled, TestHome } from "../test/drive.js";

const aiFamily = aiOver(FED.ai);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const DAY = "2026-10-01";
const S1 = "00000000-0000-4000-8000-0000000000e1";
const S2 = "00000000-0000-4000-8000-0000000000e2";
const T2 = "00000000-0000-7000-8000-0000000000f2";

const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(): TestHome {
  const home = new TestHome("families-ai-sessions-", { families: [aiFamily], settings: SETTINGS });
  homes.push(home);
  return home;
}

function deliverFixtures(home: TestHome, order: "forward" | "reversed" = "forward", seed = 0): void {
  const { claudeCode, codex } = agentDeliveries();
  const steps = [
    ...claudeCode.map((rows, index) => [CLAUDE_CODE, rows, index] as const),
    ...codex.map((rows, index) => [CODEX, rows, index] as const),
  ];
  for (const [source, rows, index] of order === "forward" ? steps : [...steps].reverse()) home.deliver(source, Date.UTC(2026, 9, 2) + index, seed === 0 ? rows : shuffled(rows, seed));
}

function sessions(home: TestHome): (ExtractRow & { day: SessionHour })[] {
  return home.extracts("ai").map((row) => ({ ...row, day: row.content as unknown as SessionHour }));
}

function session(home: TestHome, source: string, id: string, day = DAY): SessionDay {
  const hours = sessions(home).filter((row) => row.unit.startsWith(`${source}/${id}/${day}T`));
  expect(hours.length, `${source}/${id}/${day}`).toBeGreaterThan(0);
  return mergeSessions(hours.map((row) => row.day));
}

function timed(txt: string): string[] {
  const lines = txt.split("\n");
  return lines.slice(lines.indexOf("") + 1, lines.indexOf("Coverage") - 1);
}

function cc(session: string, uuid: string, at: string, fields: JsonObject): ReaderOutput {
  return claudeCodeRow({
    parentUuid: "10000000-0000-4000-8000-0000000000ff", isSidechain: false, uuid, timestamp: at, userType: "external", entrypoint: "cli",
    cwd: "/Users/person-a/projects/example-repo", sessionId: session, version: "2.1.290", gitBranch: "main", ...fields,
  })[0]!;
}

const uuid = (n: number) => `20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const typed = (text: string): JsonObject => ({ type: "user", message: { role: "user", content: text }, promptSource: "typed", origin: { kind: "human" } });
const toolUse = (id: string, name: string, input: JsonObject): JsonObject => ({
  type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
});

describe("ai family, agent sessions: what must be impossible", () => {
  it("a line the person did not type prints as their turn, or a typed one is lost", () => {
    const home = newHome();
    deliverFixtures(home);
    const words = (day: SessionDay) => day.turns.map((turn) => turn.words);
    expect(words(session(home, CLAUDE_CODE, A1))).toEqual(["Fix the failing test in the example project.", "Now run the whole suite."]);
    expect(words(session(home, CLAUDE_CODE, C3))).toEqual(["Explain the build."]);
    expect(words(session(home, CODEX, D1))).toEqual(["Rename the helper.", "Also update the docs.", "Rename it differently."]);
    expect(words(session(home, CODEX, D3, "2026-09-20"))).toEqual(["Archive me."]);
    home.artifact("turns.json", sessions(home).map(({ unit, day }) => ({ unit, turns: day.turns })));
  });

  it("a session prints apart from its sub-agents or later segments, or counts their tool calls elsewhere", () => {
    const home = newHome();
    deliverFixtures(home);
    expect(sessions(home).map((row) => row.unit).sort()).toEqual([
      `${CLAUDE_CODE}/${A1}/${DAY}T09`, `${CLAUDE_CODE}/${C3}/${DAY}T09`, `${CODEX}/${D1}/${DAY}T10`, `${CODEX}/${D3}/2026-09-20T08`,
    ].sort());
    expect(session(home, CLAUDE_CODE, A1)).toMatchObject({ provider: "claude-code", folder: "project", tool_calls: 1, agents: [expect.any(String)], files: [] });
    expect(session(home, CODEX, D1)).toMatchObject({ provider: "codex", folder: "project", tool_calls: 1, agents: [expect.any(String)], files: [] });
    const d1 = sessions(home).find((row) => row.unit === `${CODEX}/${D1}/${DAY}T10`)!;
    expect([d1.start_ms, d1.end_ms]).toEqual([Date.parse("2026-10-01T10:00:00.000Z"), Date.parse("2026-10-01T10:40:09.000Z")]);
    for (const row of home.extracts("ai")) {
      expect(aiFamily.items!(row)).toEqual([]);
      expect(aiFamily.plan!(row, new Map())).toEqual({ asks: [] });
    }
  });

  it("units differ when the same lines arrive in another order", () => {
    const runs = [["forward", 0], ["reversed", 0], ["reversed", 5]] as const;
    const results = runs.map(([order, seed]) => {
      const home = newHome();
      deliverFixtures(home, order, seed);
      return {
        extracts: home.extracts("ai").map(({ unit, reading, content, start_ms, end_ms, days }) => ({ unit, reading, content, start_ms, end_ms, days })),
        day: home.render(DAY, LABELS).txt,
      };
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });

  it("an extract is written when only an unread field ticked (usage, model, request ids, versions, token counts)", () => {
    const home = newHome();
    deliverFixtures(home);
    const before = home.extracts("ai");
    const { claudeCode, codex } = agentDeliveries();
    const tick = (row: ReaderOutput): ReaderOutput => {
      const content = structuredClone(row.content) as { line: JsonObject };
      const line = content.line;
      line.version = "2.1.999";
      if (typeof line.requestId === "string") line.requestId = `${line.requestId}-again`;
      if (typeof line.promptId === "string") line.promptId = `${line.promptId}-again`;
      const message = line.message as JsonObject | undefined;
      if (message?.usage !== undefined) message.usage = { input_tokens: 99, output_tokens: 99 };
      if (message?.model !== undefined) message.model = "claude-other";
      if (line.type === "event_msg" || line.type === "turn_context") line.payload = { ...(line.payload as JsonObject), ticked: true };
      if (line.type === "session_meta") line.payload = { ...(line.payload as JsonObject), cli_version: "9.9.9" };
      return { ...row, content: content as unknown as ReaderOutput["content"] };
    };
    const written = [
      ...claudeCode.map((rows, index) => home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 3) + index, rows.map(tick))),
      ...codex.map((rows, index) => home.deliver(CODEX, Date.UTC(2026, 9, 3) + index, rows.map(tick))),
    ];
    expect(written.reduce((sum, each) => sum + each.landed.changed, 0)).toBeGreaterThan(20);
    expect(written.flatMap((each) => each.touched).length).toBeGreaterThan(0);
    expect(written.flatMap((each) => each.written)).toEqual([]);
    expect(home.extracts("ai")).toEqual(before);
  });

  it("a session's hours print as two blocks or count a sub-agent twice, or a line in one hour reads the session's other hours again", () => {
    const home = newHome();
    const root = "/Users/person-a/projects/example-repo";
    const agent = { isSidechain: true, agentId: "a0000000000000031" };
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [
      cc(S1, uuid(30), "2026-10-01T10:50:00.000Z", typed("A prompt before the hour turns.")),
      cc(S1, uuid(31), "2026-10-01T10:55:00.000Z", { ...toolUse("toolu_h1", "Edit", { file_path: `${root}/src/a.ts`, old_string: "x", new_string: "y" }), ...agent }),
      cc(S1, uuid(32), "2026-10-01T11:05:00.000Z", { ...toolUse("toolu_h2", "Edit", { file_path: `${root}/src/a.ts`, old_string: "y", new_string: "z" }), ...agent }),
      cc(S1, uuid(33), "2026-10-01T11:10:00.000Z", typed("A prompt after it.")),
    ]);
    expect(sessions(home).map((row) => row.unit)).toEqual([`${CLAUDE_CODE}/${S1}/${DAY}T10`, `${CLAUDE_CODE}/${S1}/${DAY}T11`]);
    expect(session(home, CLAUDE_CODE, S1)).toMatchObject({ tool_calls: 2, agents: ["a0000000000000031"], files: ["src/a.ts"] });
    expect(timed(home.render(DAY, LABELS).txt)).toEqual([
      "06:50–07:10 Claude Code in example-repo (3)",
      "  06:50–07:10 2 of your turns, 2 tool calls, 1 sub-agent; edited src/a.ts",
      "  06:50 the user: A prompt before the hour turns.",
      "  07:10 the user: A prompt after it.",
    ]);
    const later = home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2) + 1, [cc(S1, uuid(34), "2026-10-01T11:20:00.000Z", typed("One more."))]);
    expect(later.touched).toEqual([`ai ${CLAUDE_CODE}/${S1}/${DAY}T11`]);
  });

  it("a view holds every hour's lines it read, so a rebuild's week of hours lives to its end, or reads one hour again for each of its sessions", () => {
    const home = newHome();
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [
      cc(S1, uuid(40), "2026-10-01T10:05:00.000Z", typed("The first session at ten.")),
      cc(S2, uuid(41), "2026-10-01T10:15:00.000Z", typed("The second session at ten.")),
      cc(S1, uuid(42), "2026-10-01T11:05:00.000Z", typed("The first session at eleven.")),
    ]);
    const unit = (id: string, hour: string) => `${CLAUDE_CODE}/${id}/${DAY}T${hour}`;
    const stored = new Map(sessions(home).map((row) => [row.unit, row.reading]));
    expect([...stored.keys()].sort()).toEqual([unit(S1, "10"), unit(S1, "11"), unit(S2, "10")]);
    const reads = (order: readonly (readonly [string, string])[]): string[] => {
      const read: string[] = [];
      const spied = home.db.view();
      try {
        const view = new Proxy(spied, {
          get: (target, property, receiver) => {
            const value = Reflect.get(target, property, receiver) as unknown;
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const range = args[2] as { start_ms?: number } | undefined;
              if (property === "records" && args[0] === CLAUDE_CODE && range?.start_ms !== undefined) read.push(new Date(range.start_ms).toISOString().slice(11, 13));
              return (value as (...args: unknown[]) => unknown).apply(target, args);
            };
          },
        });
        for (const [id, hour] of order) expect(aiFamily.extract(unit(id, hour), view, home.blobs)?.reading).toBe(stored.get(unit(id, hour)));
      } finally {
        spied.close();
      }
      return read;
    };
    const order = [[S1, "10"], [S1, "11"], [S2, "10"], [S1, "10"]] as const;
    const held = reads(order);
    const kinds = held.filter((hour) => hour === "11").length;
    const times = (hour: string) => Array.from({ length: kinds }, () => hour);
    expect(held).toEqual([...times("10"), ...times("11")]);
    const bytes = HOURS_HELD.bytes;
    HOURS_HELD.bytes = 1;
    try {
      expect(reads([[S1, "10"], [S2, "10"], [S1, "11"], [S1, "10"]])).toEqual([...times("10"), ...times("11"), ...times("10")]);
    } finally {
      HOURS_HELD.bytes = bytes;
    }
  });

  it("an hour code 4 stored (its tool calls counted, its folder named, its files relative to it) throws in the day or prints otherwise than this code's, or a day unit an older code stored enters the session", () => {
    const older = JSON.parse(readFileSync(new URL("./test/session-hours.code-4.json", import.meta.url), "utf8")) as ExtractRow[];
    const root = "/Users/person-a/projects/example-repo";
    const lines = [
      cc(S1, uuid(0x60), "2026-10-01T10:00:00.000Z", typed("Edit the two files.")),
      cc(S1, uuid(0x61), "2026-10-01T10:01:00.000Z", toolUse("toolu_a", "Edit", { file_path: `${root}/src/a.ts` })),
      cc(S1, uuid(0x62), "2026-10-01T10:02:00.000Z", toolUse("toolu_b", "Write", { file_path: `${root}/src/b.ts` })),
    ];
    const current = newHome();
    current.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), lines);
    const home = newHome();
    home.land(CLAUDE_CODE, Date.UTC(2026, 9, 2), lines);
    const dayUnit = { ...older[0]!, code: "3", unit: `${CLAUDE_CODE}/${S1}/${DAY}`, content: { provider: "claude-code", folder: "example-repo", turns: [], tool_calls: 8, sub_agents: 1, files: [] } };
    home.db.commit((tx) => {
      for (const row of [...older, dayUnit]) tx.derived.extracts.put({ ...row, seq: 1 } as ExtractRow);
    });
    const day = home.render(DAY, LABELS);
    const session = (txt: string) => timed(txt).filter((line) => line.includes("of your turns"));
    expect(session(day.txt)).toEqual(expect.arrayContaining(session(current.render(DAY, LABELS).txt)));
    expect(day.txt).toContain("2 of your turns, 1 tool call, 1 sub-agent");
    expect(day.units.filter((unit) => unit.family === "ai").map((unit) => unit.unit).sort()).toEqual(older.map((row) => row.unit).sort());
    home.artifact("code-4.json", { stored: home.extracts("ai"), day: day.txt });
  });

  it("a sidechain-only first hour supplies the folder, counts a repeated tool id twice, or shortens the same file two ways", () => {
    const home = newHome();
    const root = "/Users/person-a/projects/example-repo";
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [
      cc(S1, uuid(61), "2026-10-01T10:59:00Z", { ...toolUse("toolu_split", "Edit", { file_path: `${root}/src/a.ts` }), isSidechain: true, agentId: "agent-a", cwd: "/tmp/synthetic-worktree" }),
      cc(S1, uuid(62), "2026-10-01T11:01:00Z", toolUse("toolu_split", "Edit", { file_path: `${root}/src/a.ts` })),
      cc(S1, uuid(63), "2026-10-01T11:02:00Z", typed("Finish the synthetic change.")),
    ]);
    const rendered = home.render(DAY, LABELS);
    expect(rendered.txt).toContain("Claude Code in example-repo");
    expect(rendered.txt).toContain("1 of your turns, 1 tool call, 1 sub-agent; edited src/a.ts");
    expect(session(home, CLAUDE_CODE, S1).files).toEqual(["src/a.ts"]);
    home.artifact("cross-hour.json", { stored: home.extracts("ai"), day: rendered.txt });
  });

  it("a session's work line states no account, or another than its session's source's", () => {
    const home = newHome();
    deliverFixtures(home);
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 3), [cc(S2, uuid(40), "2026-10-01T10:50:00.000Z", typed("Before the hour.")), cc(S2, uuid(41), "2026-10-01T11:10:00.000Z", typed("After it."))]);
    const day = JSON.parse(home.render(DAY, LABELS).json) as DayDocument;
    const work = day.atoms.filter((atom) => atom.family === "ai" && atom.record === undefined);
    expect(work.some((atom) => atom.units.length > 1)).toBe(true);
    expect([...new Set(work.map((atom) => JSON.stringify([atom.block!.key.slice(0, atom.block!.key.lastIndexOf("/")), atom.accounts])))].sort())
      .toEqual([[CLAUDE_CODE, ["claude-code:local"]], [CODEX, ["codex:local"]]].map((pair) => JSON.stringify(pair)));
  });

  it("a later line that moves only the session's end (the agent's prose, no tool call) leaves the stored end where it was", () => {
    const home = newHome();
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [cc(S1, uuid(40), "2026-10-01T10:00:00.000Z", typed("A synthetic prompt."))]);
    const prose = { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "A synthetic answer in prose." }] } };
    const later = home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2) + 1, [cc(S1, uuid(41), "2026-10-01T10:15:00.000Z", prose)]);
    expect(later.written).toEqual([`ai ${CLAUDE_CODE}/${S1}/${DAY}T10`]);
    const stored = sessions(home).find((row) => row.unit === `${CLAUDE_CODE}/${S1}/${DAY}T10`)!;
    expect([stored.start_ms, stored.end_ms]).toEqual([Date.parse("2026-10-01T10:00:00.000Z"), Date.parse("2026-10-01T10:15:00.000Z")]);
    const fresh = newHome();
    fresh.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [cc(S1, uuid(40), "2026-10-01T10:00:00.000Z", typed("A synthetic prompt.")), cc(S1, uuid(41), "2026-10-01T10:15:00.000Z", prose)]);
    const strip = ({ seq: _seq, ...row }: ExtractRow) => row;
    expect(fresh.extracts("ai").map(strip)).toEqual(home.extracts("ai").map(strip));
  });

  it("an older Claude Code's line is told wrongly: a compaction summary, a slash command's output, or a sub-agent's prompt as typed; a slash command or a typed prompt a fork restates as not", () => {
    const home = newHome();
    const old = (fields: JsonObject): JsonObject => ({ type: "user", version: "1.0.0", ...fields });
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [
      cc(S1, uuid(1), "2026-10-01T14:00:00.000Z", old({ message: { role: "user", content: "An older typed prompt." } })),
      cc(S1, uuid(2), "2026-10-01T14:00:05.000Z", old({ message: { role: "user", content: [{ type: "text", text: "A typed prompt with a picture." }, { type: "image", source: { type: "base64", data: "AAAA" } }] } })),
      cc(S1, uuid(3), "2026-10-01T14:01:00.000Z", old({ isCompactSummary: true, message: { role: "user", content: "This session is being continued from a synthetic summary." } })),
      cc(S1, uuid(4), "2026-10-01T14:02:00.000Z", old({ message: { role: "user", content: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>example-model</command-args>" } })),
      cc(S1, uuid(5), "2026-10-01T14:02:01.000Z", old({ message: { role: "user", content: "<local-command-stdout>Set model to example-model</local-command-stdout>" } })),
      cc(S1, uuid(6), "2026-10-01T14:03:00.000Z", old({ isMeta: true, message: { role: "user", content: "Caveat: a synthetic injected notice." } })),
      cc(S1, uuid(7), "2026-10-01T14:04:00.000Z", old({ isSidechain: true, parentUuid: null, agentId: "a0000000000000009", message: { role: "user", content: "A prompt the agent wrote for its sub-agent." } })),
      cc(S1, uuid(8), "2026-10-01T14:05:00.000Z", { type: "user", message: { role: "user", content: "A notification the program queued." }, promptSource: "system", origin: { kind: "task-notification" } }),
      cc(S2, uuid(9), "2026-10-01T15:00:00.000Z", { ...typed("A prompt the person typed, restated by a fork."), parentUuid: null, isSidechain: true, agentId: "a0000000000000010" }),
    ]);
    expect(session(home, CLAUDE_CODE, S1).turns.map((turn) => turn.words)).toEqual(["An older typed prompt.", "A typed prompt with a picture. [image]", "/model example-model"]);
    expect(session(home, CLAUDE_CODE, S1).agents).toHaveLength(1);
    expect(session(home, CLAUDE_CODE, S2).turns.map((turn) => turn.words)).toEqual(["A prompt the person typed, restated by a fork."]);
  });

  it("the files an agent edited are lost, named by their whole path, or listed past five unsaid; a long turn prints past the cap unsaid", () => {
    const home = newHome();
    const root = "/Users/person-a/projects/example-repo";
    const long = "Synthetic typed words. ".repeat(70).trim();
    expect(long.length).toBeGreaterThan(TURN_CAP);
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 2), [
      cc(S1, uuid(20), "2026-10-01T16:00:00.000Z", typed(long)),
      cc(S1, uuid(21), "2026-10-01T16:01:00.000Z", toolUse("toolu_e1", "Edit", { file_path: `${root}/src/a.ts`, old_string: "x", new_string: "y" })),
      cc(S1, uuid(22), "2026-10-01T16:02:00.000Z", toolUse("toolu_e2", "Write", { file_path: `${root}/src/b.ts`, content: "synthetic" })),
      cc(S1, uuid(23), "2026-10-01T16:03:00.000Z", toolUse("toolu_e3", "Edit", { file_path: `${root}/src/a.ts`, old_string: "y", new_string: "z" })),
      cc(S1, uuid(24), "2026-10-01T16:04:00.000Z", toolUse("toolu_e4", "Read", { file_path: `${root}/src/c.ts` })),
      cc(S1, uuid(25), "2026-10-01T16:05:00.000Z", toolUse("toolu_e5", "NotebookEdit", { notebook_path: `${root}/notes.ipynb`, new_source: "x" })),
      cc(S1, uuid(26), "2026-10-01T16:06:00.000Z", toolUse("toolu_e6", "Write", { file_path: "/tmp/elsewhere/scratch.txt", content: "x" })),
      cc(S1, uuid(27), "2026-10-01T16:07:00.000Z", toolUse("toolu_e7", "MultiEdit", { file_path: `${root}/src/d.ts`, edits: [] })),
      cc(S1, uuid(28), "2026-10-01T16:08:00.000Z", toolUse("toolu_e8", "Edit", { file_path: `${root}/src/e.ts`, old_string: "x", new_string: "y" })),
    ]);
    const meta = { timestamp: "2026-10-01T17:00:00.000Z", type: "session_meta", payload: { id: T2, cwd: root, originator: "Codex Desktop", source: "vscode", thread_source: "user" } };
    const patch = `*** Begin Patch\n*** Update File: ${root}/src/a.ts\n@@\n-x\n+y\n*** Add File: src/new.ts\n+export {};\n*** End Patch\n`;
    home.deliver(CODEX, Date.UTC(2026, 9, 2), codexRows(T2, [
      meta,
      { timestamp: "2026-10-01T17:00:01.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for the synthetic repo" }] } },
      { timestamp: "2026-10-01T17:00:02.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Patch the synthetic files." }, { type: "input_image", image_url: "data:image/png;base64,AAAA" }] } },
      { timestamp: "2026-10-01T17:00:03.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: "call_p1", input: patch } },
      { timestamp: "2026-10-01T17:00:04.000Z", type: "response_item", payload: { type: "function_call", name: "apply_patch", call_id: "call_p2", arguments: JSON.stringify({ input: `*** Begin Patch\n*** Delete File: src/old.ts\n*** End Patch\n` }) } },
      { timestamp: "2026-10-01T17:00:05.000Z", type: "response_item", payload: { type: "web_search_call", status: "completed" } },
    ]));
    const claude = session(home, CLAUDE_CODE, S1);
    expect(claude.files).toEqual(["src/a.ts", "src/b.ts", "notes.ipynb", "scratch.txt", "src/d.ts", "src/e.ts"]);
    expect(claude.tool_calls).toBe(8);
    expect(claude.turns[0]!.words.length).toBe(TURN_CAP);
    expect(claude.turns[0]!.chars).toBe(long.length);
    const codex = session(home, CODEX, T2);
    expect(codex).toMatchObject({ folder: "example-repo", tool_calls: 3, files: ["src/a.ts", "src/new.ts", "src/old.ts"] });
    expect(codex.turns.map((turn) => turn.words)).toEqual(["Patch the synthetic files. [image]"]);
    const lines = timed(home.render(DAY, LABELS).txt);
    expect(lines).toContain("  12:00–12:08 1 of your turns, 8 tool calls; edited src/a.ts, src/b.ts, notes.ipynb, scratch.txt, src/d.ts and 1 more");
    expect(lines).toContain(`  12:00 the user: ${long.slice(0, TURN_CAP)}… [${long.length.toLocaleString("en-US")} characters]`);
    expect(lines).toContain("  13:00 1 of your turns, 3 tool calls; edited src/a.ts, src/new.ts, src/old.ts");
    home.artifact("files.json", { claude, codex, lines });
  });

  it("a line's search text holds thinking, a signature, a tool call or its result, an injected notice or the program's own event, or loses what the person or the assistant wrote", () => {
    const home = newHome();
    deliverFixtures(home);
    const long = `${"typed ".repeat(10_922)}abcé and more`;
    home.deliver(CLAUDE_CODE, Date.UTC(2026, 9, 3), [
      cc(S1, uuid(50), "2026-10-01T17:00:00.000Z", {
        type: "assistant", message: { role: "assistant", content: [
          { type: "thinking", thinking: "Synthetic hidden reasoning.", signature: "c2lnbmF0dXJlLXN5bnRoZXRpYw==" },
          { type: "text", text: "First the synthetic answer." },
          { type: "tool_use", id: "toolu_e9", name: "Bash", input: { command: "echo synthetic" } },
          { type: "text", text: "Then its second part." },
        ] },
      }),
      cc(S1, uuid(51), "2026-10-01T17:01:00.000Z", { type: "user", isCompactSummary: true, message: { role: "user", content: "This session is being continued from a synthetic summary." } }),
      cc(S1, uuid(52), "2026-10-01T17:02:00.000Z", typed(long)),
    ]);
    const texts = new Map(home.texts(aiFamily).map(({ record, text }) => [record, text]));
    expect(texts.get(`${CLAUDE_CODE} agent-turn ${uuid(52)}`)).toEqual({ title: "example-repo", text: `${"typed ".repeat(10_922)}abc` });
    texts.delete(`${CLAUDE_CODE} agent-turn ${uuid(52)}`);
    const words = new Map([...texts].filter(([, text]) => text !== null));
    expect(Object.fromEntries(words)).toEqual({
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000001`]: { title: "project", text: "Fix the failing test in the example project." },
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000007`]: { title: "project", text: "The test is fixed." },
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000008`]: { title: "project", text: "Now run the whole suite." },
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000009`]: { title: "project", text: "The suite passes." },
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000103`]: { title: "project", text: "The failing test is example.test.ts." },
      [`${CLAUDE_CODE} agent-turn 10000000-0000-4000-8000-000000000301`]: { title: "project", text: "Explain the build." },
      [`${CLAUDE_CODE} agent-turn ${uuid(50)}`]: { title: "example-repo", text: "First the synthetic answer.\nThen its second part." },
      [`${CODEX} agent-turn ${D1}:5`]: { text: "Rename the helper." },
      [`${CODEX} agent-turn ${D1}:10`]: { text: "Renamed." },
      [`${CODEX} agent-turn ${D1}:12`]: { text: "Also update the docs." },
      [`${CODEX} agent-turn ${D1}:13`]: { text: "Docs updated." },
      [`${CODEX} agent-turn ${D1}_00000000-0000-7000-8000-0000000000e1:2`]: { text: "Rename it differently." },
      [`${CODEX} agent-turn ${D1}_00000000-0000-7000-8000-0000000000e1:3`]: { text: "Renamed differently." },
      [`${CODEX} agent-turn ${D3}:2`]: { text: "Archive me." },
      [`${CODEX} agent-turn 00000000-0000-7000-8000-0000000000d4:4`]: { text: "The tests pass." },
    });
    expect(texts.size - words.size).toBe(23);
    home.artifact("texts.json", [...texts]);
  });

  it("the day prints a session other than as its work, then each turn the person typed, in the session's block", () => {
    const home = newHome();
    deliverFixtures(home);
    const rendered = home.render(DAY, LABELS);
    expect(checkDayFile(JSON.parse(rendered.json))).toEqual([]);
    const path = new URL("./test/sessions.day.txt", import.meta.url);
    if (UPDATE) writeFileSync(path, rendered.txt);
    expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
    expect(rendered.txt).toBe(readFileSync(path, "utf8"));
    expect(timed(rendered.txt)).toEqual([
      "05:00–05:10 Claude Code in project (3)",
      "  05:00–05:10 2 of your turns, 1 tool call, 1 sub-agent",
      "  05:00 the user: Fix the failing test in the example project.",
      "  05:10 the user: Now run the whole suite.",
      "05:12 Claude Code in project (2)",
      "  05:12 1 of your turns, 0 tool calls",
      "  the user: Explain the build.",
      "06:00–06:40 Codex in project (4)",
      "  06:00–06:40 3 of your turns, 1 tool call, 1 sub-agent",
      "  06:00 the user: Rename the helper.",
      "  06:20 the user: Also update the docs.",
      "  06:30 the user: Rename it differently.",
    ]);
    home.artifact("day.json", JSON.parse(rendered.json));
  });
});
