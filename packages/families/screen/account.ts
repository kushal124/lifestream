import { readFileSync } from "node:fs";
import { piecesText, spelledOf, wordMarks, type Ask, type Json, type Piece, type Prompt, type Reply } from "@lifestreamprotocol/core";
import type { Plan } from "../family.js";
import { statedPrompt } from "../shared/prompts.js";
import { free, said, sayJoined } from "../shared/said.js";
import { clockReader, visibleOf, type Clock } from "./evidence.js";

export const PART_PROMPT = "screen-part";
export const COMPOSE_PROMPT = "screen-compose";
export const SITTING_PROMPT = "screen-sitting";
export const ACCOUNT = "screen-account";

const FOLDER = new URL("./prompts/", import.meta.url);
const part = (name: string) => readFileSync(new URL(`parts/${name}`, FOLDER), "utf8");
const CORE = part("core.md").replaceAll("{SCHEMA}", part("schema.json").trim());

export const SCREEN_PROMPTS: Readonly<Record<string, Prompt>> = {
  [PART_PROMPT]: statedPrompt(FOLDER, PART_PROMPT, (text) => text.replaceAll("{CORE}", CORE)),
  [COMPOSE_PROMPT]: statedPrompt(FOLDER, COMPOSE_PROMPT, (text) => text.replaceAll("{CORE}", CORE)),
  [SITTING_PROMPT]: statedPrompt(FOLDER, SITTING_PROMPT),
};

export const SCREEN_READERS: Readonly<Record<string, (value: Json) => string | null>> = {
  [PART_PROMPT]: (value) => accountProblems(withStarts(value as unknown as Written)).join("\n") || null,
  [COMPOSE_PROMPT]: (value) => accountProblems(withStarts(value as unknown as Written)).join("\n") || null,
  [SITTING_PROMPT]: (value) => {
    const read = readSitting(value as string, () => true);
    return "problems" in read ? read.problems.join("\n") : null;
  },
};

export interface Part {
  start_ms: number;
  end_ms: number;
  carry: Piece[];
  empty: boolean;
  evidence: Piece[];
}

export interface Block {
  start_ms: number;
  end_ms: number;
  parts: Part[];
}

interface Written {
  summary: string;
  timeline: { start: string; end: string; present: "yes" | "no" | "unsure"; present_why: string; doing: string; task: string; where: string }[];
  actions: { at: string; what: string }[];
  life: { people: string[]; projects: string[]; other: string[] };
}

export interface Account {
  summary: string;
  timeline: { start_ms: number; end_ms: number; present: "yes" | "no" | "unsure"; present_why: string; doing: string; task: string; where: string }[];
  actions: { at_ms: number; what: string }[];
  life: { people: string[]; projects: string[]; other: string[] };
}

export function planAccount(unit: string, blocks: readonly Block[], stated: Stated, answered: ReadonlyMap<string, Reply>, clock: Clock): Plan {
  const asks: Ask[] = [];
  const refusals: { item: string; reason: string }[] = [];
  const written: { block: Block; account: Written }[] = [];
  for (const block of blocks) {
    const step = blockStep(unit, block, stated, answered, clock);
    if ("ask" in step) asks.push(step.ask);
    else if ("refusal" in step) refusals.push(step.refusal);
    else written.push({ block, account: step.account });
  }
  if (asks.length > 0 || refusals.length > 0) return { asks, ...(refusals.length === 0 ? {} : { refusals }) };
  const joined = joinBlocks(written, clock);
  const answer = (account: Account): Plan => ({ asks: [], answers: [{ item: unit, content: account as unknown as Json }] });
  const described = blocks.filter((block) => block.parts.some((part) => !part.empty)).length;
  if (described <= 1) return answer(joined);
  const start = blocks[0]!.start_ms;
  const end = blocks.at(-1)!.end_ms;
  const hours = sayJoined(written.map(({ block, account }) => {
    const seconds = new Map<string, number>();
    const at = clockReader(block.start_ms, clock);
    for (const entry of account.timeline) seconds.set(entry.task, (seconds.get(entry.task) ?? 0) + Math.max(0, (at(entry.end) - at(entry.start)) / 1000));
    return said`--- ${clock.hms(block.start_ms)}–${clock.hms(block.end_ms)} ---\n${free(JSON.stringify({
      summary: account.summary, tasks: Object.fromEntries([...seconds].map(([task, total]) => [task, Math.round(total)])), ...account.life,
    }))}`;
  }), "\n\n");
  const input = said`\nSTRETCH: ${clock.hms(start)} to ${clock.hms(end)} ${clock.zone}, ${clock.day(start)}, described in ${written.length} hours\n\nHOURS\n${hours}`;
  const sitting: Ask = { family: "screen", item: `${unit}/sitting`, prompt: SITTING_PROMPT, input, ...stated };
  const reply = answered.get(sitting.item);
  if (reply === undefined) return { asks: [sitting] };
  const refused = SCREEN_READERS[SITTING_PROMPT]!(reply.value);
  if (refused !== null) return { asks: [], refusals: [{ item: sitting.item, reason: refused }] };
  const labels = new Set(joined.timeline.map((entry) => entry.task));
  const merged = readSitting(reply.value as string, (label) => labels.has(label));
  if ("problems" in merged) return { asks: [], refusals: [{ item: sitting.item, reason: merged.problems.join("\n") }] };
  return answer({
    ...joined,
    summary: merged.summary,
    timeline: joined.timeline.map((entry) => ({ ...entry, task: merged.tasks[entry.task] ?? entry.task })),
    life: { people: merged.people, projects: merged.projects, other: merged.other },
  });
}

export type Stated = Pick<Ask, "work" | "source" | "needs">;

type Step = { ask: Ask } | { refusal: { item: string; reason: string } } | { account: Written };

function blockStep(unit: string, block: Block, stated: Stated, answered: ReadonlyMap<string, Reply>, clock: Clock): Step {
  const { hms } = clock;
  const outputs: Written[] = [];
  const quoted: Piece[] = [];
  let previous: Piece[] | null = null;
  for (const [k, part] of block.parts.entries()) {
    if (part.empty) {
      const nobody = emptyAccount(part.start_ms, part.end_ms, clock);
      outputs.push(nobody);
      quoted.push(free(JSON.stringify(nobody)));
      previous = [quoted.at(-1)!];
      continue;
    }
    const head = said`This is part ${k + 1} of the stretch that began at ${hms(block.start_ms)} ${clock.zone}. This call covers ${hms(part.start_ms)}–${hms(part.end_ms)} ${clock.zone} only; the instructions above are written for that part.${
      part.carry.length > 0 ? said`\nCarried over from before this part: ${part.carry}` : ""}${
      previous !== null ? said`\nThe JSON you returned for the previous part, for continuity (reuse its task labels when the same work continues):\n${previous}` : ""}`;
    const ask: Ask = { family: "screen", item: `${unit}/part/${part.start_ms}`, prompt: PART_PROMPT, input: said`\n${head}\n\nEVIDENCE\n${part.evidence}`, ...stated };
    const reply = answered.get(ask.item);
    if (reply === undefined) return { ask };
    const read = readAccount(PART_PROMPT, reply.value, part.start_ms, part.end_ms, clock, visibleOf(piecesText(part.evidence)));
    if ("problems" in read) return { refusal: { item: ask.item, reason: read.problems.join("\n") } };
    outputs.push(read.account);
    quoted.push(quote(JSON.stringify(read.account), reply));
    previous = [quoted.at(-1)!];
  }
  if (outputs.length === 1) return { account: outputs[0]! };
  if (block.parts.every((part) => part.empty)) return { account: emptyAccount(block.start_ms, block.end_ms, clock) };
  const parts = sayJoined(quoted.map((output, index) => said`--- part ${index + 1} of ${outputs.length} ---\n${output}`), "\n\n");
  const input = said`\nSTRETCH: ${hms(block.start_ms)} to ${hms(block.end_ms)} ${clock.zone}, ${clock.day(block.start_ms)}, read in ${outputs.length} parts\n\nPARTS\n${parts}`;
  const compose: Ask = { family: "screen", item: `${unit}/compose/${block.start_ms}`, prompt: COMPOSE_PROMPT, input, ...stated };
  const reply = answered.get(compose.item);
  if (reply === undefined) return { ask: compose };
  const visible = block.parts.map((part) => visibleOf(piecesText(part.evidence))).join("\n");
  const read = readAccount(COMPOSE_PROMPT, reply.value, block.start_ms, block.end_ms, clock, visible);
  if ("problems" in read) return { refusal: { item: compose.item, reason: read.problems.join("\n") } };
  return { account: read.account };
}

function quote(text: string, reply: Reply): Piece {
  return free(text, undefined, wordMarks(text, spelledOf(reply.text, reply.marks ?? [])));
}

function emptyAccount(a: number, b: number, clock: Clock): Written {
  return {
    summary: "",
    timeline: [{ start: clock.hms(a), end: clock.hms(b), present: "no", present_why: "nothing on screen", doing: "Away from the Mac", task: "away", where: "" }],
    actions: [],
    life: { people: [], projects: [], other: [] },
  };
}

function joinBlocks(blocks: readonly { block: Block; account: Written }[], clock: Clock): Account {
  const timeline: Account["timeline"] = [];
  const actions: Account["actions"] = [];
  const life = { people: [] as string[], projects: [] as string[], other: [] as string[] };
  const summaries: string[] = [];
  for (const { block, account } of blocks) {
    const timelineAt = clockReader(block.start_ms, clock);
    const actionAt = clockReader(block.start_ms, clock);
    for (const entry of account.timeline) {
      timeline.push({ start_ms: timelineAt(entry.start), end_ms: timelineAt(entry.end), present: entry.present, present_why: entry.present_why, doing: entry.doing, task: entry.task, where: entry.where });
    }
    for (const act of account.actions) actions.push({ at_ms: actionAt(act.at), what: act.what });
    for (const key of ["people", "projects", "other"] as const) {
      for (const name of account.life[key]) {
        if (!life[key].some((known) => known.trim().toLowerCase() === name.trim().toLowerCase())) life[key].push(name);
      }
    }
    if (account.summary.trim()) summaries.push(account.summary.trim());
  }
  actions.sort((left, right) => left.at_ms - right.at_ms);
  return { summary: summaries.join(" "), timeline, actions, life };
}


const HMS = /^\d\d:\d\d:\d\d$/u;
const PIPELINE_PHRASES = /\b(?:no capture|not captured|(?:frames?|samples?) (?:show|shows|showed)|marked idle|(?:recorder|OCR|input log|AX tree|accessibility tree)(?:'s)? (?:shows?|showed|captured|recorded|saw|logged|read))\b/iu;
const PIPELINE_TERMS = [/\brecorder\b/iu, /\bOCR\b/iu, /\binput log\b/iu, /\bAX tree\b/iu, /\baccessibility tree\b/iu];

function readAccount(prompt: string, value: Json, a: number, b: number, clock: Clock, visible: string): { account: Written } | { problems: string[] } {
  const refused = SCREEN_READERS[prompt]!(value);
  if (refused !== null) return { problems: [refused] };
  const account = withStarts(value as unknown as Written);
  const problems = collected(account, PIPELINE_TERMS.filter((term) => !term.test(visible)));
  return problems.length > 0 ? { problems } : { account: tiled(account, a, b, clock) };
}

function accountProblems(account: Written): string[] {
  const problems: string[] = [];
  if (account.timeline.length === 0) problems.push('"timeline" must be a non-empty array');
  account.timeline.forEach((entry, index) => {
    if (!HMS.test(entry.start) || !HMS.test(entry.end)) problems.push(`timeline[${index}] times must be HH:MM:SS`);
  });
  account.actions.forEach((act, index) => {
    if (!HMS.test(act.at)) problems.push(`actions[${index}] must be {at: HH:MM:SS, what}`);
  });
  if (problems.length > 0) return problems.slice(0, 30);
  return collected(account, [PIPELINE_PHRASES]);
}

function collected(account: Written, terms: readonly RegExp[]): string[] {
  const words = [account.summary, ...account.timeline.map((entry) => entry.doing), ...account.actions.map((act) => act.what)];
  const hits = words.filter((word) => terms.some((term) => term.test(word)));
  return hits.length === 0 ? [] : [`write about the person's time, never how the evidence was collected; these say it: ${hits.slice(0, 5).map((hit) => JSON.stringify(hit.slice(0, 120))).join("; ")}`];
}

function parseJson(reply: string): unknown {
  const text = reply.trim();
  const start = text.indexOf("{");
  if (start < 0) return JSON.parse(text);
  try {
    return objectAt(text, start);
  } catch (error) {
    const fence = /```(?:json)?/u.exec(text);
    const inside = fence === null ? -1 : text.indexOf("{", fence.index + fence[0].length);
    if (inside < 0 || inside === start) throw error;
    try {
      return objectAt(text, inside);
    } catch {
      throw error;
    }
  }
}

function objectAt(text: string, start: number): unknown {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === "\\") index++;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return JSON.parse(text.slice(start, index + 1));
  }
  return JSON.parse(text.slice(start));
}

function withStarts(account: Written): Written {
  return {
    ...account,
    actions: account.actions.map((act) => ({ ...act, at: /^(\d\d:\d\d:\d\d)\s*[–—-]\s*\d\d:\d\d:\d\d$/u.exec(act.at)?.[1] ?? act.at })),
  };
}

function isObject(item: unknown): item is Record<string, unknown> {
  return typeof item === "object" && item !== null && !Array.isArray(item);
}
const strings = (list: unknown): list is string[] => Array.isArray(list) && list.every((item) => typeof item === "string");

function tiled(account: Written, a: number, b: number, clock: Clock): Written {
  const { hms } = clock;
  const at = clockReader(a, clock);
  const timeline: Written["timeline"] = [];
  let cursor = a - (a % 1000);
  for (const entry of account.timeline) {
    const end = Math.min(at(entry.end), b);
    if (end <= cursor) continue;
    timeline.push({ ...entry, start: hms(cursor), end: hms(end) });
    cursor = end;
  }
  if (timeline.length === 0) timeline.push({ ...account.timeline[0]!, start: hms(a), end: hms(b) });
  else timeline.at(-1)!.end = hms(b);
  return {
    summary: account.summary.trim(),
    timeline: timeline.map(({ start, end, present, present_why, doing, task, where }) => ({ start, end, present, present_why, doing, task, where })),
    actions: account.actions.map(({ at: when, what }) => ({ at: when, what })),
    life: { people: [...account.life.people], projects: [...account.life.projects], other: [...account.life.other] },
  };
}

function readSitting(reply: string, used: (label: string) => boolean):
  { summary: string; tasks: Record<string, string>; people: string[]; projects: string[]; other: string[] } | { problems: string[] } {
  let value: unknown;
  try {
    value = parseJson(reply);
  } catch (error) {
    return { problems: [`the answer is not JSON: ${(error as Error).message}`] };
  }
  const wrong = ["the answer is not one JSON object with summary, tasks (only labels the hours used), people, projects and other"];
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim() || !isObject(value.tasks) ||
      !strings(value.people) || !strings(value.projects) || !strings(value.other)) return { problems: wrong };
  const tasks: Record<string, string> = {};
  for (const [from, to] of Object.entries(value.tasks)) {
    if (!used(from) || typeof to !== "string" || !to.trim()) return { problems: wrong };
    tasks[from] = to.trim();
  }
  return { summary: value.summary.trim(), tasks, people: value.people, projects: value.projects, other: value.other };
}
