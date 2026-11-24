import { GONE, isObject, textHead, type AiAdapter, type SourceRecords, type SourceRow, type Version, type View } from "@lifestreamprotocol/core";
import type { Change, RecordRead, RecordText, Touched } from "../family.js";
import { count, recordRead, recordText } from "../shared/text.js";
import { compare, pushNew } from "./read.js";

const HOUR_MS = 3_600_000;

export const TURN_CAP = 1_000;
const FILES_SHOWN = 5;

export interface SessionHour {
  provider: string;
  cwd: string | null;
  turns: { key: string; at_ms: number; words: string; chars: number }[];
  tools: string[];
  agents: string[];
  files: string[];
}

export interface SessionDay extends Omit<SessionHour, "cwd" | "tools"> {
  folder: string | null;
  tool_calls: number;
}

export type SessionHourV4 = SessionDay;

export interface Agent {
  adapter: AiAdapter;
  source: SourceRow;
}

export function sessionTouched(agent: Agent, change: Change, view: View): Touched[] {
  const { record, before, after } = change;
  const sessions = new Set<string>();
  const hours = new Set<string>();
  for (const version of [before, after]) {
    if (version === undefined) continue;
    if (version.time !== undefined) hours.add(utcHour(version.time.start_ms));
    const session = agent.adapter.session!({ source: agent.source, version }, recordsOf(view, agent.source.id));
    if (session !== null) sessions.add(session.id);
  }
  return [...sessions].sort().flatMap((session) => [...hours].sort().map((hour) => ({ unit: `${record.source}/${session}/${hour}` })));
}

export function readSessionHour(agent: Agent, view: View, session: string, hour: string): { content: SessionHour; start_ms: number; end_ms: number } | null {
  const lines = hourLines(view, agent, hour).get(session);
  if (lines === undefined || lines.length === 0) return null;
  const records = recordsOf(view, agent.source.id);
  const read = lines.map((each) => ({ ...each, read: agent.adapter.line!({ source: agent.source, version: each.version }, session, records) ?? {} }));
  const stated = lines[0]!.session.cwd;
  const cwd = typeof stated === "string" ? stated : read.find((each) => each.read.cwd !== undefined)?.read.cwd ?? null;
  const tools = new Set<string>();
  const agents = new Set<string>();
  const files: string[] = [];
  const turns: SessionDay["turns"] = [];
  for (const { key, at_ms, read: line } of read) {
    if (line.agent !== undefined && line.agent !== null) agents.add(line.agent);
    for (const tool of line.tools ?? []) tools.add(tool);
    for (const file of line.files ?? []) pushNew(files, file);
    const typed = line.typed === undefined || line.typed === null ? null : withImages(line.typed.words, line.typed.images);
    if (typed !== null) turns.push(turnOf(key, at_ms, typed));
  }
  const content: SessionHour = { provider: agent.source.product, cwd, turns, tools: [...tools], agents: [...agents], files };
  return { content, start_ms: lines[0]!.at_ms, end_ms: lines.at(-1)!.at_ms };
}

export function mergeSessions(hours: readonly (SessionHour | SessionHourV4)[]): SessionDay {
  const cwd = hours.find((hour) => "cwd" in hour && hour.cwd !== null) as SessionHour | undefined;
  const folder = cwd === undefined ? (hours.find((hour) => "folder" in hour && hour.folder !== null) as SessionHourV4 | undefined)?.folder ?? null : folderOf(cwd.cwd);
  const tools = new Set<string>();
  let counted = 0;
  const merged: SessionDay = { provider: hours[0]!.provider, folder, turns: [], tool_calls: 0, agents: [], files: [] };
  for (const hour of hours) {
    merged.turns.push(...hour.turns);
    if ("tools" in hour) for (const tool of hour.tools) tools.add(tool);
    else counted += hour.tool_calls;
    for (const agent of hour.agents) pushNew(merged.agents, agent);
    for (const file of hour.files) pushNew(merged.files, "cwd" in hour ? relative(file, cwd?.cwd ?? null) : file);
  }
  merged.tool_calls = tools.size + counted;
  merged.turns.sort((left, right) => left.at_ms - right.at_ms || compare(left.key, right.key));
  return merged;
}

function utcHour(ms: number): string {
  return new Date(ms).toISOString().slice(0, 13);
}

export function workText(day: SessionDay): string {
  const parts = [`${day.turns.length} of your turns`, plural(day.tool_calls, "tool call"), ...day.agents.length === 0 ? [] : [plural(day.agents.length, "sub-agent")]];
  const shown = day.files.slice(0, FILES_SHOWN);
  const more = day.files.length - shown.length;
  const edited = day.files.length === 0 ? "" : `; edited ${shown.join(", ")}${more === 0 ? "" : ` and ${more} more`}`;
  return `${parts.join(", ")}${edited}`;
}

export function turnWords(turn: SessionDay["turns"][number]): string {
  return turn.chars > turn.words.length ? `${turn.words}… [${count(turn.chars)} characters]` : turn.words;
}

export function agentTurnText(adapter: AiAdapter, said: ReturnType<NonNullable<AiAdapter["said"]>>): RecordText | null {
  const words = said === null ? null : withImages(said.words, said.images ?? 0);
  return words === null ? null : recordText({ ...(adapter.folder === true ? { title: folderOf(said!.cwd ?? null) } : {}), text: words });
}

export function agentTurnRead(adapter: AiAdapter, said: ReturnType<NonNullable<AiAdapter["said"]>>): RecordRead | null {
  const words = said === null ? null : withImages(said.words, said.images ?? 0);
  return words === null ? null : recordRead({ ...(adapter.folder === true ? { title: folderOf(said!.cwd ?? null) } : {}), text: words });
}


interface Line {
  key: string;
  at_ms: number;
  version: Version;
  session: { id: string; cwd?: string | null };
}

export const HOURS_HELD = { bytes: 64 * 1024 * 1024 };

const linesByView = new WeakMap<View, { hours: Map<string, { lines: Map<string, Line[]>; bytes: number }>; bytes: number }>();

function hourLines(view: View, agent: Agent, hour: string): Map<string, Line[]> {
  let held = linesByView.get(view);
  if (held === undefined) linesByView.set(view, (held = { hours: new Map(), bytes: 0 }));
  const source = agent.source.id;
  const name = `${source}\0${hour}`;
  const known = held.hours.get(name);
  if (known !== undefined) {
    held.hours.delete(name);
    held.hours.set(name, known);
    return known.lines;
  }
  const start = Date.parse(`${hour}:00:00Z`);
  const records = recordsOf(view, source);
  const bySession = new Map<string, Line[]>();
  for (const kind of agent.adapter.kinds) {
    for (const { head, version } of view.records(source, kind, { start_ms: start, end_ms: start + HOUR_MS })) {
      if (head.start_ms === null || head.start_ms < start || head.start_ms >= start + HOUR_MS || !isObject(version.content)) continue;
      const session = agent.adapter.session!({ source: agent.source, version }, records);
      if (session === null) continue;
      const list = bySession.get(session.id) ?? [];
      list.push({ key: head.key, at_ms: head.start_ms, version, session });
      bySession.set(session.id, list);
    }
  }
  for (const list of bySession.values()) list.sort((left, right) => left.at_ms - right.at_ms || compare(left.key, right.key));
  let bytes = 0;
  for (const list of bySession.values()) for (const line of list) bytes += line.version.text.length;
  held.hours.set(name, { lines: bySession, bytes });
  held.bytes += bytes;
  for (const [other, each] of held.hours) {
    if (held.bytes <= HOURS_HELD.bytes || other === name) break;
    held.hours.delete(other);
    held.bytes -= each.bytes;
  }
  return bySession;
}

const recordsByView = new WeakMap<View, Map<string, SourceRecords>>();

function recordsOf(view: View, source: string): SourceRecords {
  let cache = recordsByView.get(view);
  if (cache === undefined) recordsByView.set(view, (cache = new Map()));
  let records = cache.get(source);
  if (records === undefined) {
    records = {
      version(kind, key) {
        const head = view.head({ source, kind, key });
        return head === undefined || head.version === GONE ? undefined : view.version(head.version);
      },
    };
    cache.set(source, records);
  }
  return records;
}


function turnOf(key: string, at_ms: number, words: string): SessionDay["turns"][number] {
  return { key, at_ms, words: textHead(words, TURN_CAP), chars: words.length };
}

function withImages(words: string, images: number): string | null {
  const trimmed = words.trim();
  const mark = images === 0 ? "" : images === 1 ? "[image]" : `[${images} images]`;
  const joined = [trimmed, mark].filter((part) => part !== "").join(" ");
  return joined === "" ? null : joined;
}

function relative(path: string, cwd: string | null): string {
  if (!path.startsWith("/")) return path;
  if (cwd !== null && path.startsWith(`${cwd.replace(/\/$/u, "")}/`)) return path.slice(cwd.replace(/\/$/u, "").length + 1);
  return path.slice(path.lastIndexOf("/") + 1);
}

function folderOf(cwd: string | null): string | null {
  if (cwd === null) return null;
  const parts = cwd.split("/").filter((part) => part !== "");
  return parts.at(-1) ?? null;
}

function plural(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

