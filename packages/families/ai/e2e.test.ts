import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { civilDay, digest, piecesText, type Ask, type ExtractRow, type Json, type Reply, type ReaderOutput, type DaySettings } from "@lifestreamprotocol/core";
import { DayReadError, type DayAtom, type DayDocument } from "../days.js";
import { buildLabels } from "../shared/labels.js";
import { FED } from "../test/fed.js";
import { pin } from "../test/pin.js";
import { aiFamily as aiOver, AI_PROMPTS, askVoiceNote, checkTurnReply, itemOf, REPLY_PROMPT, TURN_PROMPT, turnSize, VOICE_PROMPT, voiceItem, type ConversationDay, type TurnDescription } from "./family.js";
import type { Turn } from "./read.js";
import { askKey, readReply, replyOf, ROUTE, shuffled, TestHome, worked, type Route } from "../test/drive.js";

const aiFamily = aiOver(FED.ai);
const AI_ROUTE: Route = { ...ROUTE, model: "gpt-6-luna" };
import { agentDeliveries, CLAUDE_CODE, CODEX } from "./test/agents.js";

const GOLDEN = new URL("./test/", import.meta.url);
const UPDATE = process.env.LIFESTREAM_UPDATE_GOLDEN === "1";
const SETTINGS: DaySettings = { zone: "America/New_York", day_start_hour: 4 };
const LABELS = buildLabels({ people: [], contacts: [], places: [] });
const CHATGPT = "chatgpt:user-synthetic-aa01:export";
const CLAUDE = "claude:00000000-0000-4000-8000-0000000000c1:cloud";
const CHATGPT_BROWSER = "chatgpt:user-synthetic-aa01:browser";
const CLAUDE_BROWSER = "claude:00000000-0000-4000-8000-0000000000c1:browser";
const ASK = "ask:local:macbook-pro-0001";
const MINUTE = 60_000;
const DAY_MS = 86_400_000;
const T0 = Date.UTC(2026, 8, 14, 13, 0);
const EXPORT_1 = Date.UTC(2026, 8, 20);
const EXPORT_2 = Date.UTC(2026, 8, 27);
const EXPORT_3 = Date.UTC(2026, 9, 2);

const TICKING_PATHS = [
  "current_node", "message.content[].content[].uuid", "message.content[].signature", "message.updated_at", "node.children[]",
  "node.message.metadata.model_slug", "node.message.metadata.search_result_groups", "update_time", "updated_at",
];
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const G1 = uuid(0xa1);
const G2 = uuid(0xa2);
const C1 = uuid(0xc1);


function typed(length: number, seed = "the owner"): string {
  let out = "";
  for (let step = 1; out.length < length; step++) out += `Synthetic words from ${seed}, step ${step}. `;
  return out.slice(0, length);
}

function pasted(length: number): string {
  let out = "";
  for (let line = 1; out.length < length; line++) out += `const value_${line} = compute(${line}, "fake");\n`;
  return out.slice(0, length);
}

const LONG_TURN = `Please review this listing before the synthetic release.\n\n${pasted(5_200)}\n\nWhat would you change first?`;


interface GptTurn { node: number; at: number; role: "user" | "assistant"; text: string; files?: string[] }
interface Tick { model?: string; children?: "reversed"; thumbnail?: boolean; recipient?: string; channel?: string }

function gptMsg(conversation: string, turn: GptTurn, tick: Tick = {}): ReaderOutput {
  const children = [uuid(turn.node + 1), uuid(turn.node + 2)];
  return {
    kind: "msg", key: `${conversation}:${uuid(turn.node)}`,
    time: { start_ms: turn.at, precision: "ms" },
    content: {
      type: "chatgpt.msg", conversation_id: conversation,
      node: {
        id: uuid(turn.node), parent: uuid(turn.node - 1),
        children: tick.children === "reversed" ? children.reverse() : children,
        message: {
          id: uuid(turn.node), author: { role: turn.role, name: null, metadata: {} },
          create_time: turn.at / 1000, update_time: null,
          content: { content_type: "text", parts: [turn.text] },
          status: "finished_successfully", end_turn: turn.role === "assistant", weight: 1, recipient: tick.recipient ?? "all",
          ...(tick.channel === undefined ? {} : { channel: tick.channel }),
          metadata: {
            model_slug: tick.model ?? "model-alpha",
            ...(turn.files === undefined ? {} : { attachments: turn.files.map((name, index) => ({ id: `file-fake${index}`, name, mime_type: "application/pdf" })) }),
            ...(tick.thumbnail === true ? { search_result_groups: [{ entries: [{ thumbnail_url: "https://example.com/thumb.png" }] }] } : {}),
          },
        },
      },
    },
  };
}

function gptShell(conversation: string, title: string | null, update_ms: number, current: number): ReaderOutput {
  return {
    kind: "chat", key: conversation, time: { start_ms: update_ms, precision: "ms" },
    content: { type: "chatgpt.shell", conversation_id: conversation, title, update_time: update_ms / 1000, current_node: uuid(current) },
  };
}

interface ClaudeTurn {
  id: number; at: number; sender: "human" | "assistant"; text: string;
  files?: { file_name: string; file_type: string; extracted_content: string }[];
  tool?: string;
}
interface ClaudeTick { signature?: string; nested?: string; updated?: number; degraded?: boolean }

function claudeMsg(conversation: string, turn: ClaudeTurn, tick: ClaudeTick = {}): ReaderOutput {
  const at = new Date(turn.at).toISOString();
  const blocks: Json[] = turn.sender === "assistant"
    ? [
      { type: "thinking", thinking: "Synthetic reasoning.", signature: tick.signature ?? "signature-1" },
      ...(turn.tool === undefined ? [] : [
        { type: "tool_use", name: turn.tool, input: { query: "synthetic query" } },
        { type: "tool_result", is_error: false, content: [{ type: "text", text: "synthetic result", ...(tick.nested === undefined ? {} : { uuid: tick.nested }) }] },
      ]),
      { type: "text", text: turn.text },
    ]
    : [{ type: "text", text: turn.text }];
  return {
    kind: "msg", key: `${conversation}:${uuid(turn.id)}`, time: { start_ms: turn.at, precision: "ms" },
    content: {
      type: "claude.msg", conversation_uuid: conversation,
      message: tick.degraded === true
        ? { uuid: uuid(turn.id), text: "", content: [], sender: turn.sender, created_at: at, updated_at: at, attachments: [], files: [], parent_message_uuid: null }
        : {
          uuid: uuid(turn.id), text: turn.text, content: blocks, sender: turn.sender, created_at: at,
          updated_at: new Date(tick.updated ?? turn.at).toISOString(),
          attachments: turn.files ?? [], files: [], parent_message_uuid: turn.id === 1 ? null : uuid(turn.id - 1),
        },
    },
  };
}

function claudeShell(conversation: string, name: string, updated_ms: number): ReaderOutput {
  return {
    kind: "chat", key: conversation, time: { start_ms: updated_ms, precision: "ms" },
    content: {
      type: "claude.shell", conversation_uuid: conversation, name, summary: "",
      created_at: new Date(T0).toISOString(), updated_at: new Date(updated_ms).toISOString(),
    },
  };
}

const G1_TURNS: GptTurn[] = [
  { node: 0x101, at: T0, role: "user", text: "How should I order the synthetic release steps?" },
  { node: 0x111, at: T0 + 2 * MINUTE, role: "assistant", text: typed(900, "the assistant") },
  { node: 0x121, at: T0 + 10 * MINUTE, role: "user", text: LONG_TURN, files: ["fake-plan.pdf"] },
  { node: 0x131, at: T0 + 12 * MINUTE, role: "assistant", text: "Start with the tests." },
  { node: 0x141, at: Date.UTC(2026, 8, 15, 2, 30), role: "user", text: "One more synthetic question tonight." },
];

const C1_TURNS: ClaudeTurn[] = [
  { id: 1, at: T0 + 120 * MINUTE, sender: "human", text: "Here is the synthetic itinerary, what is missing?",
    files: [{ file_name: "itinerary.txt", file_type: "text/plain", extracted_content: typed(4_200, "the itinerary") }] },
  { id: 2, at: T0 + 122 * MINUTE, sender: "assistant", text: typed(300, "the assistant"), tool: "web_search" },
  { id: 3, at: T0 + 130 * MINUTE, sender: "human", text: `I typed all of this myself.\n${typed(4_500, "the owner")}` },
  { id: 4, at: T0 + 133 * MINUTE, sender: "assistant", text: typed(650, "the assistant") },
];

function exportRows(tick: Tick & ClaudeTick = {}, shellAt = EXPORT_1): { chatgpt: ReaderOutput[]; claude: ReaderOutput[] } {
  return {
    chatgpt: [...G1_TURNS.map((turn) => gptMsg(G1, turn, tick)), gptShell(G1, "Synthetic release checklist", shellAt, 0x141)],
    claude: [...C1_TURNS.map((turn) => claudeMsg(C1, turn, tick)), claudeShell(C1, "Synthetic travel notes", shellAt)],
  };
}


const homes: TestHome[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) home.close();
});

function newHome(): TestHome {
  const home = new TestHome("families-ai-", { families: [aiFamily], settings: SETTINGS });
  home.addSource(CHATGPT, "chatgpt-export");
  home.addSource(CLAUDE, "claude-export");
  homes.push(home);
  return home;
}

function browserHome(): TestHome {
  const home = newHome();
  home.addSource(CHATGPT_BROWSER, "chatgpt-browser");
  home.addSource(CLAUDE_BROWSER, "claude-browser");
  return home;
}

function browserClaude(row: ReaderOutput, change: (message: Record<string, Json>) => void = () => undefined): ReaderOutput {
  const content = structuredClone(row.content) as { message: Record<string, Json> };
  Object.assign(content.message, { index: 0, truncated: false, sync_sources: [] }, content.message.sender === "assistant" ? { stop_reason: "stop_sequence" } : {});
  change(content.message);
  return { ...row, content: content as unknown as Json };
}

function atoms(home: TestHome, day: string): Pick<DayAtom, "text" | "record">[] {
  return (JSON.parse(home.render(day, LABELS).json) as DayDocument).atoms.map(({ text, record }) => ({ text, ...(record === undefined ? {} : { record }) }));
}

function deliver(home: TestHome, at: number, rows: { chatgpt: ReaderOutput[]; claude: ReaderOutput[] }, sources = { chatgpt: CHATGPT, claude: CLAUDE }) {
  const first = home.deliver(sources.chatgpt, at, rows.chatgpt);
  const second = home.deliver(sources.claude, at, rows.claude);
  return {
    changed: first.landed.changed + second.landed.changed,
    changedPaths: { ...first.landed.changedPaths, ...second.landed.changedPaths },
    touched: [...first.touched, ...second.touched],
    written: [...first.written, ...second.written],
    days: [...new Set([...first.days, ...second.days])].sort(),
  };
}

function deliverBrowser(home: TestHome, at: number, rows: { chatgpt: ReaderOutput[]; claude: ReaderOutput[] }) {
  return deliver(home, at, rows, { chatgpt: CHATGPT_BROWSER, claude: CLAUDE_BROWSER });
}

class FakeModel {
  calls = 0;
  readonly asked: string[] = [];
  readonly #ledger = new Map<string, string>();
  constructor(private readonly respond: (ask: Ask) => string = honest) {}

  reply(ask: Ask): Reply | undefined {
    const key = digest({ model: AI_ROUTE.model, prompt: ask.prompt, input: piecesText(ask.input) });
    let text = this.#ledger.get(key);
    if (text === undefined) {
      this.calls++;
      this.asked.push(`${ask.prompt} ${ask.item}`);
      text = this.respond(ask);
      this.#ledger.set(key, text);
    }
    return replyOf(AI_PROMPTS[ask.prompt]!, key, AI_ROUTE.model, text);
  }
}

function honest(ask: Ask): string {
  if (ask.prompt === REPLY_PROMPT) return `A synthetic gist of a ${piecesText(ask.input).length}-character reply.`;
  const lines = piecesText(ask.input).split("\n");
  const files = lines.filter((line) => line.startsWith("Attached file ")).length;
  return JSON.stringify({ own: [lines[1]!], pasted: "a synthetic code listing", attachments: Array.from({ length: files }, (_, index) => `synthetic file ${index + 1}`) });
}

function answerAll(home: TestHome, model: FakeModel): { refused: { item: string; reason: string }[] } {
  const refused: { item: string; reason: string }[] = [];
  for (const extract of home.extracts("ai")) {
    const first = aiFamily.plan!(extract, new Map());
    expect(first.answers ?? []).toEqual([]);
    for (const ask of first.asks) worked(aiFamily, ask);
    const answered = new Map(first.asks.flatMap((ask) => {
      const reply = model.reply(ask);
      return reply === undefined ? [] : [[ask.item, reply] as const];
    }));
    const plan = aiFamily.plan!(extract, answered);
    expect(plan.asks.map((ask) => ask.item)).toEqual(first.asks.filter((ask) => !answered.has(ask.item)).map((ask) => ask.item));
    refused.push(...plan.refusals ?? []);
    const prompts = new Map(aiFamily.items!(extract).map(({ item, prompt }) => [item, prompt]));
    for (const { item, content } of plan.answers ?? []) {
      const ask = first.asks.find((entry) => entry.item === item)!;
      home.putEnrichment({ family: "ai", item, prompt: prompts.get(item)!, input_hash: digest(piecesText(ask.input)), reply_key: answered.get(item)!.key, reused_from: null, content, state: "done" });
    }
  }
  return { refused };
}

function turnsOf(row: ExtractRow): Turn[] {
  return (row.content as unknown as ConversationDay).turns;
}

function golden(name: string, text: string): void {
  const path = new URL(name, GOLDEN);
  if (UPDATE) writeFileSync(path, text);
  expect(existsSync(path), `${path.pathname} is missing; run with LIFESTREAM_UPDATE_GOLDEN=1`).toBe(true);
  expect(text).toBe(readFileSync(path, "utf8"));
}


describe("ai family: what must be impossible", () => {
  it("an extract is written when only an unread field ticked (update_time, current_node, model slugs, children order, nested block ids, thinking signatures)", () => {
    const home = newHome();
    const model = new FakeModel();
    const first = deliver(home, EXPORT_1, exportRows());
    expect(first.written.length).toBe(3);
    answerAll(home, model);
    const calls = model.calls;
    const before = home.extracts("ai");
    const days = Object.fromEntries(["2026-09-14", "2026-09-15"].map((day) => [day, home.render(day, LABELS)]));

    const ticked = exportRows({ model: "model-beta", children: "reversed", thumbnail: true, signature: "signature-2", nested: uuid(0xfff), updated: T0 + DAY_MS }, EXPORT_2);
    ticked.chatgpt[ticked.chatgpt.length - 1] = gptShell(G1, "Synthetic release checklist", EXPORT_2, 0x999);
    const second = deliver(home, EXPORT_2, ticked);
    expect(second.changed).toBe(G1_TURNS.length + C1_TURNS.length + 2);
    expect(Object.keys(second.changedPaths).sort()).toEqual(TICKING_PATHS);
    expect(second.touched).toEqual([`ai ${CHATGPT}/${G1}/2026-09-14`, `ai ${CHATGPT}/${G1}/2026-09-15`, `ai ${CLAUDE}/${C1}/2026-09-14`]);
    expect(second.written).toEqual([]);
    expect(second.days).toEqual([]);
    expect(home.extracts("ai")).toEqual(before);
    answerAll(home, model);
    expect(model.calls).toBe(calls);
    for (const [day, rendered] of Object.entries(days)) expect(home.render(day, LABELS)).toEqual(rendered);
    home.artifact("unread-ticks.json", { changed: second.changed, changedPaths: second.changedPaths, touched: second.touched, written: second.written, calls });
  });

  it("units differ when the same data arrives in another order", () => {
    const older = exportRows();
    const newer = exportRows({}, EXPORT_2);
    newer.chatgpt = [
      ...G1_TURNS.map((turn) => gptMsg(G1, turn.node === 0x131 ? { ...turn, text: "Start with the synthetic tests, then the docs." } : turn)),
      gptMsg(G1, { node: 0x151, at: Date.UTC(2026, 8, 16, 9), role: "user", text: "Back again two days later." }),
      gptShell(G1, "Synthetic release plan", EXPORT_2, 0x151),
    ];
    newer.claude = [];
    const runs = [
      [[EXPORT_1, older], [EXPORT_2, newer]],
      [[EXPORT_2, newer], [EXPORT_1, older]],
    ] as const;
    const results = runs.map((order, index) => {
      const home = newHome();
      for (const [at, rows] of order) deliver(home, at, { chatgpt: shuffled(rows.chatgpt, index + 1), claude: shuffled(rows.claude, index + 7) });
      return {
        extracts: home.extracts("ai").map(({ unit, reading, content, start_ms, end_ms, days }) => ({ unit, reading, content, start_ms, end_ms, days })),
        days: ["2026-09-14", "2026-09-16"].map((day) => home.render(day, LABELS)),
        home,
      };
    });
    expect(results[1]!.extracts).toEqual(results[0]!.extracts);
    expect(results[1]!.days).toEqual(results[0]!.days);
    const g1 = results[0]!.extracts.filter((row) => row.unit.includes(G1));
    expect(g1.map((row) => row.unit)).toEqual([`${CHATGPT}/${G1}/2026-09-14`, `${CHATGPT}/${G1}/2026-09-15`, `${CHATGPT}/${G1}/2026-09-16`]);
    expect(g1.every((row) => (row.content as unknown as ConversationDay).title === "Synthetic release plan")).toBe(true);
    expect(results[0]!.extracts.filter((row) => row.unit.includes(C1)).length).toBe(1);
    results[0]!.home.artifact("order.json", results[0]!.extracts as unknown as Json);
  });

  it("an answered item is asked again (a re-export, an edit back to the same text, the same paste in another conversation)", () => {
    const home = newHome();
    const model = new FakeModel();
    deliver(home, EXPORT_1, exportRows());
    answerAll(home, model);
    expect(model.calls).toBe(5);
    expect(new Set(model.asked).size).toBe(5);
    const items = home.extracts("ai").flatMap((row) => aiFamily.items!(row)).map((entry) => entry.item).sort();

    deliver(home, EXPORT_2, exportRows({ model: "model-beta", signature: "signature-2" }, EXPORT_2));
    answerAll(home, model);
    expect(model.calls).toBe(5);

    deliver(home, EXPORT_2 + 1, {
      chatgpt: [gptMsg(G2, { node: 0x201, at: Date.UTC(2026, 8, 18, 15), role: "user", text: LONG_TURN, files: ["fake-plan.pdf"] }), gptShell(G2, "Another synthetic chat", EXPORT_2, 0x201)],
      claude: [],
    });
    answerAll(home, model);
    expect(model.calls).toBe(5);
    const g2 = home.extracts("ai").find((row) => row.unit.includes(G2))!;
    const [shared] = aiFamily.items!(g2);
    expect(items).toContain(shared!.item);

    const edited = (text: string) => ({ chatgpt: [gptMsg(G1, { ...G1_TURNS[2]!, text })], claude: [] });
    deliver(home, EXPORT_3, edited(`${LONG_TURN}\nAnd one more typed line.`));
    answerAll(home, model);
    expect(model.calls).toBe(6);
    deliver(home, EXPORT_3 + 1, edited(LONG_TURN));
    answerAll(home, model);
    expect(model.calls).toBe(6);
    expect(home.extracts("ai").flatMap((row) => aiFamily.items!(row)).map((entry) => entry.item).sort()).toEqual([...items, shared!.item].sort());

    const day = home.render("2026-09-14", LABELS);
    expect(day.txt).toContain("the user: Please review this listing before the synthetic release. [pasted: a synthetic code listing] [attached fake-plan.pdf: synthetic file 1]");
    golden("2026-09-14.day.txt", day.txt);
    golden("extracts.golden.json", `${JSON.stringify(home.extracts("ai").map(({ seq: _seq, ...row }) => row), null, 2)}\n`);
    home.artifact("asked.json", { calls: model.calls, asked: model.asked, enrichments: home.enrichments("ai") as unknown as Json });
    pin(aiFamily, { ai: FED.ai }, home.extracts("ai"));
  });

  it("a turn under 4,000 characters or a reply under 500 is asked", () => {
    const home = newHome();
    const at = Date.UTC(2026, 8, 19, 14);
    const sized = [
      { node: 0x301, role: "user" as const, text: typed(3_999) },
      { node: 0x311, role: "user" as const, text: typed(4_000) },
      { node: 0x321, role: "assistant" as const, text: typed(499, "the assistant") },
      { node: 0x331, role: "assistant" as const, text: typed(500, "the assistant") },
    ];
    deliver(home, EXPORT_1, {
      chatgpt: [...sized.map((turn, index) => gptMsg(G2, { ...turn, at: at + index * MINUTE })), gptShell(G2, null, EXPORT_1, 0x331)],
      claude: [
        claudeMsg(C1, { id: 1, at, sender: "human", text: typed(100), files: [{ file_name: "a.txt", file_type: "text/plain", extracted_content: typed(3_899, "file a") }] }),
        claudeMsg(C1, { id: 2, at: at + MINUTE, sender: "human", text: typed(100), files: [{ file_name: "b.txt", file_type: "text/plain", extracted_content: typed(3_900, "file b") }] }),
        claudeShell(C1, "Synthetic sizes", EXPORT_1),
      ],
    });
    const asked = home.extracts("ai").flatMap((row) => {
      return aiFamily.plan!(row, new Map()).asks.map((ask) => {
        const turn = turnsOf(row).find((entry) => itemOf(entry) === ask.item)!;
        return { prompt: ask.prompt, key: turn.key, size: turnSize(turn), work: ask.work, source: ask.source };
      });
    });
    expect(asked.map(({ prompt, key, work, source }) => [prompt, key, work, source]).sort()).toEqual([
      [REPLY_PROMPT, `${G2}:${uuid(0x331)}`, "chats", CHATGPT],
      [TURN_PROMPT, `${C1}:${uuid(2)}`, "chats", CLAUDE],
      [TURN_PROMPT, `${G2}:${uuid(0x311)}`, "chats", CHATGPT],
    ].sort());
    const txt = home.render("2026-09-19", LABELS).txt;
    expect(txt).toContain(`the user: ${typed(3_999)}`.replace(/\s+/gu, " ").trim());
    expect(txt).toContain(`ChatGPT: ${typed(499, "the assistant")}`.replace(/\s+/gu, " ").trim());
    expect(txt).toContain("[4,000 characters, description pending]");
    home.artifact("thresholds.json", asked as unknown as Json);
  });

  it("an assistant message to a tool, or on the analysis channel, prints as a reply or is asked for a gist", () => {
    const home = newHome();
    const at = Date.UTC(2026, 8, 19, 15);
    deliver(home, EXPORT_1, {
      chatgpt: [
        gptMsg(G2, { node: 0x401, role: "user", at, text: "Synthetic question." }),
        gptMsg(G2, { node: 0x411, role: "assistant", at: at + MINUTE, text: typed(600, "tool arguments") }, { recipient: "python", channel: "commentary" }),
        gptMsg(G2, { node: 0x421, role: "assistant", at: at + 2 * MINUTE, text: typed(600, "reasoning") }, { channel: "analysis" }),
        gptMsg(G2, { node: 0x431, role: "assistant", at: at + 3 * MINUTE, text: "Synthetic answer." }, { channel: "final" }),
        gptShell(G2, null, EXPORT_1, 0x431),
      ],
      claude: [],
    });
    const rows = home.extracts("ai");
    expect(rows.flatMap((row) => turnsOf(row).map((turn) => turn.key))).toEqual([`${G2}:${uuid(0x401)}`, `${G2}:${uuid(0x431)}`]);
    expect(rows.flatMap((row) => aiFamily.plan!(row, new Map()).asks)).toEqual([]);
    const txt = home.render("2026-09-19", LABELS).txt;
    expect(txt).toContain("ChatGPT: Synthetic answer.");
    expect(txt).not.toContain("tool arguments");
    expect(txt).not.toContain("reasoning");
    home.artifact("tool-turns.json", rows.map((row) => row.content));
  });

  it("a conversation's search text holds thinking, a tool's call or result, or what was never shown, or loses a turn's words or the title", () => {
    const home = newHome();
    const at = Date.UTC(2026, 8, 19, 15);
    deliver(home, EXPORT_1, exportRows());
    deliver(home, EXPORT_1 + 1, {
      chatgpt: [
        gptMsg(G2, { node: 0x411, role: "assistant", at, text: typed(600, "tool arguments") }, { recipient: "python", channel: "commentary" }),
        gptMsg(G2, { node: 0x421, role: "assistant", at: at + MINUTE, text: typed(600, "reasoning") }, { channel: "analysis" }),
        gptShell(G2, null, EXPORT_1, 0x421),
      ],
      claude: [],
    });
    const gpt = (turn: GptTurn) => `${CHATGPT} msg ${G1}:${uuid(turn.node)}`;
    const claude = (turn: ClaudeTurn) => `${CLAUDE} msg ${C1}:${uuid(turn.id)}`;
    expect(Object.fromEntries(home.texts(aiFamily).map(({ record, text }) => [record, text]))).toEqual({
      [`${CHATGPT} chat ${G1}`]: { title: "Synthetic release checklist", text: "" },
      [`${CHATGPT} chat ${G2}`]: null,
      ...Object.fromEntries(G1_TURNS.map((turn) => [gpt(turn), { text: turn.text.trim() }])),
      [`${CHATGPT} msg ${G2}:${uuid(0x411)}`]: null,
      [`${CHATGPT} msg ${G2}:${uuid(0x421)}`]: null,
      [`${CLAUDE} chat ${C1}`]: { title: "Synthetic travel notes", text: "" },
      ...Object.fromEntries(C1_TURNS.map((turn) => [claude(turn), { text: turn.text.trim() }])),
    });

    deliver(home, EXPORT_2, { chatgpt: [], claude: [...C1_TURNS.map((turn) => claudeMsg(C1, turn, { degraded: true })), claudeShell(C1, "", EXPORT_2)] });
    const degraded = home.texts(aiFamily).filter(({ record }) => record.startsWith(CLAUDE));
    expect(degraded.map(({ text }) => text)).toEqual([null, null, null, null, null]);
    home.artifact("texts.json", home.texts(aiFamily));
  });

  it("a 'verbatim' reply that is not verbatim is accepted (words out of order, or copied more often than written)", () => {
    const turn: Turn = {
      key: "k", at_ms: T0, role: "user", words: `First line I typed.\nSecond   line,\tsame thought.\n${pasted(4_000)}`,
      attachments: [{ name: "notes.txt", mime: "text/plain", text: "synthetic notes" }], images: 0, tools: [], documents: [],
    };
    const answer = (text: string) => {
      const read = readReply(AI_PROMPTS[TURN_PROMPT]!, text);
      return "value" in read ? aiFamily.readers![TURN_PROMPT]!(read.value) ?? checkTurnReply(turn, read.value as unknown as TurnDescription) : read.violations;
    };
    const reply = (value: Json) => JSON.stringify(value);
    const good = { own: ["First line I typed.", "Second line, same thought."], pasted: "a synthetic code listing", attachments: ["synthetic notes"] };
    expect(answer(reply(good))).toEqual(good);
    expect(answer(`\`\`\`json\n${reply(good)}\n\`\`\``)).toEqual(good);
    const refusals = [
      [{ ...good, own: ["First line I typed!"] }, 'own[0] is not in the message word for word: "First line I typed!"'],
      [{ ...good, own: ["first line I typed."] }, 'own[0] is not in the message word for word: "first line I typed."'],
      [{ ...good, own: ["First line I typed.", "A line the owner never wrote."] }, 'own[1] is not in the message word for word: "A line the owner never wrote."'],
      [{ ...good, own: ["synthetic notes"] }, 'own[0] is not in the message word for word: "synthetic notes"'],
      [{ ...good, own: [""] }, "own[0] is empty"],
      [{ ...good, own: ["Second line, same thought.", "First line I typed."] }, 'own[1] is out of order or repeated: "First line I typed."'],
      [{ ...good, own: ["First line I typed.", "First line I typed."] }, 'own[1] is out of order or repeated: "First line I typed."'],
      [{ ...good, own: ["First line I typed.", "line I typed."] }, 'own[1] is out of order or repeated: "line I typed."'],
      [{ ...good, pasted: "two\nlines" }, "pasted is more than one line"],
      [{ ...good, attachments: [] }, "attachments has 0 lines for 1 attached files"],
      [{ ...good, attachments: ["x".repeat(301)] }, "attachments[0] is 301 characters, over 300"],
    ] as const;
    for (const [value, reason] of refusals) expect(answer(reply(value as unknown as Json))).toBe(reason);
    expect(answer(reply({ ...good, own: "First line I typed." }))).toEqual([expect.stringContaining('"own" must be an array')]);
    expect(answer("Sure! Here it is.")).toEqual(["the answer holds no JSON object"]);
    expect(aiFamily.readers![REPLY_PROMPT]!("Line one.\nLine two.")).toBe("the gist is more than one line");
    expect(aiFamily.readers![REPLY_PROMPT]!("  A synthetic gist.  ")).toBeNull();

    const home = newHome();
    deliver(home, EXPORT_1, exportRows());
    const liar = new FakeModel((ask) => ask.prompt === TURN_PROMPT
      ? JSON.stringify({ own: ["Please review this listing before release."], pasted: "code", attachments: ["a file"] })
      : honest(ask));
    const { refused } = answerAll(home, liar);
    const reason = 'own[0] is not in the message word for word: "Please review this listing before release."';
    expect(refused).toEqual(Array.from({ length: 3 }, () => ({ item: expect.stringMatching(/^sha256:/u), reason })));
    expect(home.enrichments("ai").length).toBe(2);
    expect(home.enrichments("ai").filter((row) => refused.some((entry) => entry.item === row.item))).toEqual([]);
    home.artifact("verbatim.json", { refusals: refusals.map(([, reason]) => reason), refused } as unknown as Json);
  });

  it("a degraded re-export deletes a line or asks again", () => {
    const home = newHome();
    const model = new FakeModel();
    deliver(home, EXPORT_1, exportRows());
    answerAll(home, model);
    const calls = model.calls;
    const before = home.extracts("ai");
    const days = ["2026-09-14", "2026-09-15"].map((day) => home.render(day, LABELS));

    const degraded = {
      chatgpt: [],
      claude: [...C1_TURNS.map((turn) => claudeMsg(C1, turn, { degraded: true })), claudeShell(C1, "", EXPORT_2)],
    };
    const landed = deliver(home, EXPORT_2, degraded);
    expect(landed.changed).toBe(C1_TURNS.length + 1);
    home.read((view) => {
      const head = view.version(view.head({ source: CLAUDE, kind: "msg", key: `${C1}:${uuid(3)}` })!.version)!;
      expect((head.content as { message: { content: Json[] } }).message.content).toEqual([]);
    });
    expect(landed.written).toEqual([]);
    expect(home.extracts("ai")).toEqual(before);
    answerAll(home, model);
    expect(model.calls).toBe(calls);
    expect(["2026-09-14", "2026-09-15"].map((day) => home.render(day, LABELS))).toEqual(days);

    const returned = deliver(home, EXPORT_3, exportRows({}, EXPORT_3));
    expect(returned.written).toEqual([]);
    const empty = deliver(home, EXPORT_3 + 1, { chatgpt: [], claude: [claudeMsg(C1, { id: 9, at: T0 + 140 * MINUTE, sender: "human", text: "" }, { degraded: true })] });
    expect(empty.written).toEqual([]);
    expect(turnsOf(home.extracts("ai").find((row) => row.unit.includes(C1))!).map((turn) => turn.key)).toEqual(C1_TURNS.map((turn) => `${C1}:${uuid(turn.id)}`));
    home.artifact("degraded.json", { changed: landed.changed, changedPaths: landed.changedPaths, written: landed.written, calls: model.calls });
  });

  it("a long turn's or reply's input moves from what the release before sent, byte for byte", () => {
    const line = (index: number) => `Synthetic line ${index} of a long paste, with person-a@example.com and +15550000142 in it.\n`;
    const long = (lines: number) => Array.from({ length: lines }, (_, index) => line(index)).join("");
    const turn = (key: string, role: Turn["role"], words: string, attachments: Turn["attachments"] = []): Turn =>
      ({ key, at_ms: Date.parse("2026-09-14T10:00:00Z"), role, words, attachments, images: 0, tools: [], documents: [] });
    const content: ConversationDay = { provider: "chatgpt", title: "A synthetic chat", turns: [
      turn("c:1", "user", `Please read this.\n${long(400)}🏴tail`, [
        { name: "big notes.txt", mime: "text/plain", text: long(90) },
        { name: "scan.pdf", mime: null, text: null },
        { name: "small.csv", mime: "text/csv", text: "a,b\n1,2\n" },
      ]),
      turn("c:2", "assistant", long(200)),
      turn("c:3", "assistant", long(8)),
    ] };
    const row = { family: "ai", unit: "chatgpt:user-synthetic-aa01:export/00000000-0000-4000-8000-0000000000a9/2026-09-14", code: aiFamily.code, seq: 1, days: [], content: content as unknown as Json, start_ms: 0, end_ms: 0, reading: "r" } as unknown as ExtractRow;
    const sent = Object.fromEntries(aiFamily.plan!(row, new Map()).asks.map((ask) => [`${ask.prompt} ${ask.item}`, digest(piecesText(ask.input))]));
    expect(Object.keys(sent)).toHaveLength(3);
    const path = new URL("asks-cut.golden.json", GOLDEN);
    const text = `${JSON.stringify(sent, null, 2)}\n`;
    expect(text).toBe(readFileSync(path, "utf8"));
  });

  it("an agent session moves a paid ask: the asks of the exports, with every session landed beside them, differ from the golden by request key", () => {
    const home = newHome();
    deliver(home, EXPORT_1, exportRows());
    const agents = agentDeliveries();
    agents.claudeCode.forEach((rows, index) => home.deliver(CLAUDE_CODE, EXPORT_1 + index + 1, rows));
    agents.codex.forEach((rows, index) => home.deliver(CODEX, EXPORT_1 + index + 1, rows));
    const asks = home.extracts("ai")
      .flatMap((row) => aiFamily.plan!(row, new Map()).asks.map((ask) => ({ unit: row.unit, item: ask.item, prompt: ask.prompt, model: AI_ROUTE.model, ...askKey(aiFamily, ask, AI_ROUTE) })))
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    const items = home.extracts("ai").flatMap((row) => aiFamily.items!(row)).sort((left, right) => left.item < right.item ? -1 : 1);
    expect(asks.length).toBe(5);
    expect(home.extracts("ai").filter((row) => row.unit.startsWith(`${CLAUDE_CODE}/`) || row.unit.startsWith(`${CODEX}/`)).length).toBe(4);
    golden("asks.golden.json", `${JSON.stringify({ asks, items }, null, 2)}\n`);
    home.artifact("asks.json", { asks, items });
  });

  it("renderDay reads outside days()", () => {
    const home = newHome();
    deliver(home, EXPORT_1, exportRows());
    const extracts = home.extracts("ai");
    const late = extracts.find((row) => row.unit.endsWith("/2026-09-15"))!;
    expect(late.days).toEqual(["2026-09-14"]);
    expect(civilDay(late.start_ms!, SETTINGS)).toBe("2026-09-14");
    const reads: string[] = [];
    let atoms = 0;
    for (let day = "2026-09-12"; day <= "2026-09-17"; day = new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10)) {
      const rendered = home.render(day, LABELS, (reader) => ({
        ...reader,
        extractsOn: (family, asked) => {
          const rows = [...reader.extractsOn(family, asked)];
          reads.push(...rows.map((row) => `${asked} ${row.unit}`));
          return rows;
        },
      }));
      const document = JSON.parse(rendered.json) as DayDocument;
      for (const atom of document.atoms) {
        for (const unit of atom.units) expect(extracts.find((row) => row.unit === unit)!.days).toContain(day);
        expect(civilDay(atom.start_ms!, SETTINGS)).toBe(day);
        const product = atom.unit.split(":")[0];
        const speaker = atom.text.slice(0, atom.text.indexOf(":"));
        expect(atom.names).toEqual(speaker === "the user" ? undefined : [{ start: 0, end: speaker.length, who: `assistant:${product}` }]);
        expect(atom.block?.names).toEqual([{ start: 0, end: atom.block!.title.indexOf(" "), who: `assistant:${product}` }]);
      }
      atoms += document.atoms.length;
    }
    expect(atoms).toBe(extracts.reduce((sum, row) => sum + turnsOf(row).length, 0));
    const stray = extracts.find((row) => !row.days.includes("2026-09-16"))!;
    expect(() => home.render("2026-09-16", LABELS, (reader) => ({ ...reader, extractsOn: () => [stray] }))).toThrow(DayReadError);
    home.artifact("reads.json", reads);
  });

  it("a line of an assistant whose connector is no longer given states it, and People holds no bot by its id", () => {
    const home = newHome();
    deliver(home, EXPORT_1, exportRows());
    const extracts = home.extracts("ai");
    const without = aiOver(FED.ai.filter((each) => each.product !== "claude"));
    const lines = without.day({ day: "2026-09-14", settings: SETTINGS, extracts: extracts.filter((row) => row.days.includes("2026-09-14")), enrichments: new Map(), labels: LABELS, sources: new Map(), device: (unit) => unit }).lines;
    const claude = lines.filter((line) => line.unit.startsWith("claude:"));
    const chatgpt = lines.filter((line) => line.unit.startsWith("chatgpt:"));
    expect(claude.length).toBeGreaterThan(0);
    expect(claude.flatMap((line) => [...line.names ?? [], ...line.block?.names ?? []])).toEqual([]);
    expect(chatgpt.some((line) => line.names?.[0]?.who === "assistant:chatgpt")).toBe(true);
  });

  it("a conversation both the export and the browser hold prints twice, or reads differently from the export alone", () => {
    const exported = newHome();
    deliver(exported, EXPORT_1, exportRows());
    const both = browserHome();
    deliver(both, EXPORT_1, exportRows());
    const browser = exportRows();
    const second = deliverBrowser(both, EXPORT_1 + DAY_MS, { chatgpt: browser.chatgpt, claude: browser.claude.map((row) => row.kind === "msg" ? browserClaude(row) : row) });
    expect(second.touched).toEqual([`ai ${CHATGPT}/${G1}/2026-09-14`, `ai ${CHATGPT}/${G1}/2026-09-15`, `ai ${CLAUDE}/${C1}/2026-09-14`]);
    expect(second.written).toEqual([]);
    expect(both.extracts("ai")).toEqual(exported.extracts("ai"));
    expect(atoms(both, "2026-09-14")).toEqual(atoms(exported, "2026-09-14"));
    expect(atoms(both, "2026-09-14").length).toBe(9);
    both.artifact("both.json", atoms(both, "2026-09-14") as unknown as Json);
  });

  it("a message only the browser holds is missing from the day, or cites the export", () => {
    const home = browserHome();
    deliver(home, EXPORT_1, exportRows());
    const later = { id: 5, at: T0 + 150 * MINUTE, sender: "human" as const, text: "A synthetic follow-up the export has not seen." };
    const landed = deliverBrowser(home, EXPORT_2, { chatgpt: [], claude: [browserClaude(claudeMsg(C1, later)), claudeShell(C1, "Synthetic travel notes", EXPORT_2)] });
    expect(landed.written).toEqual([`ai ${CLAUDE}/${C1}/2026-09-14`]);
    const shown = atoms(home, "2026-09-14").filter((atom) => atom.record?.key.startsWith(C1) === true);
    expect(shown.map((atom) => atom.record!.source)).toEqual([CLAUDE, CLAUDE, CLAUDE, CLAUDE, CLAUDE_BROWSER]);
    expect(shown.at(-1)!.text).toBe("the user: A synthetic follow-up the export has not seen.");
    home.artifact("browser-only.json", shown as unknown as Json);
    const long = { id: 6, at: T0 + 160 * MINUTE, sender: "human" as const, text: typed(4_000) };
    deliverBrowser(home, EXPORT_2 + 1, { chatgpt: [], claude: [browserClaude(claudeMsg(C1, long))] });
    const asks = home.extracts("ai").flatMap((row) => aiFamily.plan!(row, new Map()).asks);
    expect(asks.filter((ask) => ask.source === CLAUDE_BROWSER).map((ask) => [ask.prompt, ask.work])).toEqual([[TURN_PROMPT, "chats"]]);
  });

  it("a browser copy that states less shows over the export's, or an export placeholder hides the browser's copy", () => {
    const home = browserHome();
    const model = new FakeModel();
    deliver(home, EXPORT_1, exportRows());
    answerAll(home, model);
    const calls = model.calls;
    const before = atoms(home, "2026-09-14");
    deliverBrowser(home, EXPORT_2, {
      chatgpt: [],
      claude: exportRows().claude.map((row) => row.kind !== "msg" ? row : browserClaude(row, (message) => {
        message.attachments = [];
        for (const block of message.content as Record<string, Json>[]) if (block.type === "tool_result") block.content = [];
      })),
    });
    answerAll(home, model);
    expect(atoms(home, "2026-09-14")).toEqual(before);
    expect(model.calls).toBe(calls);
    const late = { id: 9, at: T0 + 140 * MINUTE, sender: "human" as const, text: "Synthetic words only the browser kept." };
    deliver(home, EXPORT_3, { chatgpt: [], claude: [claudeMsg(C1, late, { degraded: true })] });
    deliverBrowser(home, EXPORT_3 + 1, { chatgpt: [], claude: [browserClaude(claudeMsg(C1, late))] });
    const shown = atoms(home, "2026-09-14").filter((atom) => atom.record?.key.startsWith(C1) === true);
    expect(shown.map((atom) => atom.record!.source)).toEqual([CLAUDE, CLAUDE, CLAUDE, CLAUDE, CLAUDE_BROWSER]);
    expect(shown.at(-1)!.text).toBe("the user: Synthetic words only the browser kept.");
    home.artifact("states-more.json", shown as unknown as Json);
  });

  it("a newer title from either source is lost, or an older one wins", () => {
    const home = browserHome();
    deliver(home, EXPORT_1, exportRows());
    const title = () => (home.extracts("ai").find((row) => row.unit.includes(C1))!.content as unknown as ConversationDay).title;
    deliverBrowser(home, EXPORT_2, { chatgpt: [], claude: [claudeShell(C1, "Synthetic travel notes, renamed", EXPORT_2)] });
    expect(title()).toBe("Synthetic travel notes, renamed");
    const back = deliver(home, EXPORT_3, { chatgpt: [], claude: [claudeShell(C1, "Synthetic travel notes", EXPORT_3)] });
    expect(back.touched).toEqual([`ai ${CLAUDE}/${C1}/2026-09-14`]);
    expect(title()).toBe("Synthetic travel notes");
    deliverBrowser(home, EXPORT_3 + 1, { chatgpt: [], claude: [claudeShell(C1, "Synthetic travel notes, tied", EXPORT_3)] });
    expect(title()).toBe("Synthetic travel notes");
  });

  it("an Ask answer prints its citation handles, is asked for a gist or missed by Find, a stopped or failed answer loses the words written, or a new title misses the turns of an earlier day", () => {
    const home = newHome();
    home.addSource(ASK, "ask-home");
    const day1 = Date.UTC(2026, 8, 21, 14);
    const day2 = day1 + DAY_MS;
    const chat = `${day1}-3fa9c2`;
    const shell = (title: string, at_ms: number): ReaderOutput => ({ kind: "chat", key: chat, time: { start_ms: at_ms, precision: "ms" }, content: { type: "ask.chat", title, at_ms } });
    const said = (n: number, at_ms: number, role: "user" | "assistant", text: string, answer: Record<string, Json> = {}): ReaderOutput => {
      const key = `${chat}:${String(n).padStart(4, "0")}`;
      return { kind: "msg", key, time: { start_ms: at_ms, precision: "ms" }, content: { type: "ask.msg", chat, n, at_ms, role, text, ...answer } };
    };
    const refs = {
      r1: { ref: "line.WyJsaW5lIiwiMjAyNi0wOS0yMCIsInNsZWVwL24zIixudWxsLCJyZXYxIl0", kind: "line", day: "2026-09-20", title: "Sleep" },
      r2: { ref: "record.WyJyZWNvcmQiLCJhc2s6bG9jYWw6bWFjYm9vay1wcm8tYWE0MiIsIm1zZyIsIkNIQVQ6MDAwMSJd", kind: "turn", day: "2026-09-21", title: "A question" },
    };
    home.deliver(ASK, day1 + MINUTE, [
      shell("How did I sleep", day1 + 30_000), said(1, day1, "user", "How did I sleep in the synthetic week?"),
      said(2, day1 + 30_000, "assistant", "About seven synthetic hours a night [r1], best on Sunday [r2][r1].", { refs, steps: [{ name: "day", words: "Read 20 Sep", ms: 40 }], model: "gpt-6-luna", ms: 30_000, end: "done" }),
    ]);
    home.deliver(ASK, day2 + 5 * MINUTE, [
      shell("Synthetic sleep", day2 + 3 * MINUTE),
      said(3, day2, "user", "And the synthetic week before?"), said(4, day2 + MINUTE, "assistant", "Interrupted lighthouse words [r1]", { end: "stopped" }),
      said(5, day2 + 2 * MINUTE, "user", "Try the synthetic question again."), said(6, day2 + 2 * MINUTE + 1_000, "assistant", "", { end: "failed", error: "model" }),
      said(7, day2 + 3 * MINUTE - 1_000, "user", "Once more."), said(8, day2 + 3 * MINUTE, "assistant", `Partial harbour words. ${typed(600, "Ask")}`, { end: "failed", error: "door" }),
    ]);
    const lines = (day: string) => home.render(day, LABELS).txt.split("\n").filter((line) => line.includes("the user:") || line.includes("Ask"));
    expect({ "2026-09-21": lines("2026-09-21"), "2026-09-22": lines("2026-09-22") }).toEqual({
      "2026-09-21": [
        "10:00 Ask · Synthetic sleep (2)",
        "  10:00 the user: How did I sleep in the synthetic week?",
        "  Ask: About seven synthetic hours a night, best on Sunday.",
      ],
      "2026-09-22": [
        "10:00–10:03 Ask · Synthetic sleep (5)",
        "  10:00 the user: And the synthetic week before?",
        "  10:01 Ask: Interrupted lighthouse words",
        "  10:02 the user: Try the synthetic question again.",
        "  the user: Once more.",
        `  10:03 Ask: Partial harbour words. ${typed(600, "Ask")}`.trimEnd(),
      ],
    });
    expect(home.extracts("ai").flatMap((row) => aiFamily.plan!(row, new Map()).asks)).toEqual([]);
    const texts = Object.fromEntries(home.texts(aiFamily).filter(({ record }) => record.startsWith(ASK)).map(({ record, text }) => [record.slice(ASK.length + 1), text]));
    expect(texts).toEqual({
      [`chat ${chat}`]: { title: "Synthetic sleep", text: "" },
      [`msg ${chat}:0001`]: { text: "How did I sleep in the synthetic week?" },
      [`msg ${chat}:0002`]: { text: "About seven synthetic hours a night, best on Sunday." },
      [`msg ${chat}:0003`]: { text: "And the synthetic week before?" },
      [`msg ${chat}:0004`]: { text: "Interrupted lighthouse words" },
      [`msg ${chat}:0005`]: { text: "Try the synthetic question again." },
      [`msg ${chat}:0006`]: null,
      [`msg ${chat}:0007`]: { text: "Once more." },
      [`msg ${chat}:0008`]: { text: `Partial harbour words. ${typed(600, "Ask")}`.trim() },
    });
    const time = home.read((view) => view.version(view.head({ source: ASK, kind: "chat", key: chat })!.version)!.time);
    expect(time).toEqual({ start_ms: day2 + 3 * MINUTE, precision: "ms" });
    home.artifact("ask.json", { lines: { "2026-09-21": lines("2026-09-21"), "2026-09-22": lines("2026-09-22") }, texts } as unknown as Json);
  });

  it("an Ask voice note is asked twice or under another work, prints or finds no words once written, or a question's photos are lost", () => {
    const home = newHome();
    home.addSource(ASK, "ask-home");
    const day = Date.UTC(2026, 8, 23, 14);
    const chat = `${day}-5ab0c1`;
    const blob = (n: number) => `sha256:${n.toString(16).padStart(64, "0")}`;
    const [note, quiet, photo1, photo2] = [blob(0xa1), blob(0xa2), blob(0xb1), blob(0xb2)];
    const said = (n: number, at_ms: number, role: "user" | "assistant", text: string, more: Record<string, Json> = {}): ReaderOutput => {
      const key = `${chat}:${String(n).padStart(4, "0")}`;
      return { kind: "msg", key, time: { start_ms: at_ms, precision: "ms" }, content: { type: "ask.msg", chat, n, at_ms, role, text, ...more } };
    };
    home.deliver(ASK, day + 10 * MINUTE, [
      { kind: "chat", key: chat, time: { start_ms: day + 4 * MINUTE, precision: "ms" }, content: { type: "ask.chat", title: "Synthetic harbour", at_ms: day + 4 * MINUTE } },
      said(1, day, "user", "Where was this?", { photos: [photo1, photo2] }), said(2, day + 10_000, "assistant", "A synthetic harbour.", { end: "done" }),
      said(3, day + MINUTE, "user", "", { voice: { audio: note, ms: 38_412 }, photos: [photo1] }), said(4, day + MINUTE + 10_000, "assistant", "The same harbour.", { end: "done" }),
      said(5, day + 2 * MINUTE, "user", "", { voice: { audio: note, ms: 38_412 } }), said(6, day + 2 * MINUTE + 10_000, "assistant", "Still the harbour.", { end: "done" }),
      said(7, day + 3 * MINUTE, "user", "", { voice: { audio: quiet, ms: 1_600 } }), said(8, day + 4 * MINUTE, "assistant", "I heard nothing.", { end: "done" }),
    ]);
    const lines = () => home.render("2026-09-23", LABELS).txt.split("\n").filter((line) => line.includes("the user:"));
    const before = lines();
    expect(before).toEqual([
      "  10:00 the user: Where was this? [2 images]",
      "  10:01 the user: [voice note, 38 s] [image]",
      "  10:02 the user: [voice note, 38 s]",
      "  10:03 the user: [voice note, 2 s]",
    ]);
    const [row] = home.extracts("ai").filter((each) => each.unit.startsWith(ASK));
    const asks = aiFamily.plan!(row!, new Map()).asks;
    expect(asks).toEqual([askVoiceNote(note, ASK), askVoiceNote(quiet, ASK)]);
    for (const ask of asks) worked(aiFamily, ask);
    expect(asks[0]).toMatchObject({ item: voiceItem(note), prompt: VOICE_PROMPT, input: [], attachments: [{ blob: note, media_type: "audio/wav" }], identity: { audio: note }, work: "voice" });
    expect(aiFamily.works).toEqual({ chats: { product: expect.arrayContaining(["ask", "chatgpt", "claude"]) }, voice: { product: ["ask"] } });
    expect(new Set(aiFamily.items!(row!).map(({ item, prompt }) => `${prompt} ${item}`))).toEqual(new Set([`${VOICE_PROMPT} ${voiceItem(note)}`, `${VOICE_PROMPT} ${voiceItem(quiet)}`]));
    const textOf = (n: number) => home.texts(aiFamily).find(({ record }) => record === `${ASK} msg ${chat}:${String(n).padStart(4, "0")}`)!.text;
    expect([textOf(1), textOf(3), textOf(7)]).toEqual([{ text: "Where was this?" }, null, null]);

    const reply = (item: string, text: string) => replyOf(AI_PROMPTS[VOICE_PROMPT]!, `key-${item}-${text.length}`, AI_ROUTE.model, text)!;
    const plan = aiFamily.plan!(row!, new Map([[voiceItem(note), reply(voiceItem(note), "  Synthetic words about the harbour.\n")], [voiceItem(quiet), reply(voiceItem(quiet), "[no speech]")]]));
    expect(plan).toEqual({ asks: [], answers: [{ item: voiceItem(note), content: { words: "Synthetic words about the harbour." } }, { item: voiceItem(quiet), content: { words: "[no speech]" } }], refusals: [] });
    for (const { item, content } of plan.answers!) {
      home.putEnrichment({ family: "ai", item, prompt: VOICE_PROMPT, input_hash: digest({ audio: item }), reply_key: `key-${item}`, reused_from: null, content, state: "done" });
    }
    expect(lines()).toEqual([
      "  10:00 the user: Where was this? [2 images]",
      "  10:01 the user: [voice note, 38 s: \"Synthetic words about the harbour.\"] [image]",
      "  10:02 the user: [voice note, 38 s: \"Synthetic words about the harbour.\"]",
      "  10:03 the user: [voice note, 2 s: no speech]",
    ]);
    expect([textOf(3), textOf(5), textOf(7)]).toEqual([{ text: "Synthetic words about the harbour." }, { text: "Synthetic words about the harbour." }, null]);
    expect(home.read((view) => aiFamily.replicas!(`${chat}:0003`, view, LABELS))).toEqual({ records: [{ source: ASK, kind: "msg", key: `${chat}:0003` }], items: [voiceItem(note)] });
    home.artifact("ask-voice.json", { before, after: lines(), asks } as unknown as Json);
  });

  it("an erasure of a message leaves its browser copy, or its ask, behind", () => {
    const home = browserHome();
    deliver(home, EXPORT_1, exportRows());
    deliverBrowser(home, EXPORT_2, { chatgpt: [], claude: [browserClaude(claudeMsg(C1, C1_TURNS[2]!))] });
    const key = `${C1}:${uuid(3)}`;
    const named = home.read((view) => aiFamily.replicas!(key, view, LABELS));
    expect(named.records).toEqual([{ source: CLAUDE, kind: "msg", key }, { source: CLAUDE_BROWSER, kind: "msg", key }]);
    const turn = turnsOf(home.extracts("ai").find((row) => row.unit.includes(C1))!).find((each) => each.key === key)!;
    expect(named.items).toEqual([itemOf(turn)]);
  });
});
