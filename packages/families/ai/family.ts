import {
  daysOf, digest, GONE, instant, textHead,
  type AiAdapter, type Ask, type DaySettings, type Piece, type EnrichmentRow, type ExtractRow, type Json, type Prompt, type RecordRef,
  type Reply, type SourceRow, type SourceSelector, type Statement, type Version, type View,
} from "@lifestreamprotocol/core";
import { accountsOf, linesOnly, type Change, type DayInput, type DayLine, type Extracted, type Family, type FamilyInput, type Given, type NameSpan, type Plan, type Touched } from "../family.js";
import { ME } from "../shared/cast.js";
import { free, said, sayJoined, type Sayable } from "../shared/said.js";
import { statedPrompt } from "../shared/prompts.js";
import { chooseReplicas, type ReplicaRule } from "../shared/replicas.js";
import { count, recordRead, recordText } from "../shared/text.js";
import { compare, conversationOfKey, DAY_MS, statesNothing, utcDate, type Turn } from "./read.js";
import { agentTurnRead, agentTurnText, mergeSessions, readSessionHour, sessionTouched, turnWords, workText, type SessionHour } from "./sessions.js";

export const AI_FAMILY = "ai";
const AGENT_TURN = "agent-turn";
export const TURN_PROMPT = "ai-turn";
export const REPLY_PROMPT = "ai-reply";
export const VOICE_PROMPT = "ask-voice";
export const AI_PROMPTS: Readonly<Record<string, Prompt>> = {
  [TURN_PROMPT]: statedPrompt(new URL("./prompts/", import.meta.url), TURN_PROMPT),
  [REPLY_PROMPT]: statedPrompt(new URL("./prompts/", import.meta.url), REPLY_PROMPT),
  [VOICE_PROMPT]: statedPrompt(new URL("./prompts/", import.meta.url), VOICE_PROMPT),
};
const VOICE_WORK = "voice";
const VOICE_MEDIA = "audio/wav";
const NO_SPEECH = "[no speech]";
export const TURN_ASK_CHARS = 4_000;
export const REPLY_ASK_CHARS = 500;
const TURN_SHOWN = { head: 24_000, tail: 6_000 };
const FILE_SHOWN = { head: 6_000, tail: 0 };
const REPLY_SHOWN = { head: 12_000, tail: 3_000 };
const LINE_CHARS = 300;

export interface ConversationDay {
  provider: string;
  title: string | null;
  turns: Turn[];
}

export type VoiceWords = { words: string };

export type TurnDescription = {
  own: string[];
  pasted: string;
  attachments: string[];
};

const READERS: Readonly<Record<string, (value: Json) => string | null>> = {
  [TURN_PROMPT]: (value) => turnLines(value as unknown as TurnDescription),
  [REPLY_PROMPT]: (value) => checkLine(value as string, "the gist", false),
  [VOICE_PROMPT]: () => null,
};

export type AiChats = (product: string | undefined) => Given<AiAdapter> | undefined;

interface Feeds {
  chat: AiChats;
  agent(product: string | undefined): Given<AiAdapter> | undefined;
}

function chatsOf(given: readonly Given<AiAdapter>[]): Map<string, Given<AiAdapter>> {
  return new Map(given.filter((each) => each.adapter.turn !== undefined).map((each) => [each.product, each]));
}

export function aiChatsIn(families: readonly Pick<Family, "name" | "adapters">[]): AiChats {
  const chats = chatsOf((families.find((each) => each.name === AI_FAMILY)?.adapters ?? []) as readonly Given<AiAdapter>[]);
  return (product) => (product === undefined ? undefined : chats.get(product));
}

export function aiFamily(given: readonly Given<AiAdapter>[]): Family {
  const chats = chatsOf(given);
  const agents = new Map(given.filter((each) => each.adapter.session !== undefined && each.adapter.line !== undefined).map((each) => [each.product, each]));
  const feeds: Feeds = {
    chat: (product) => (product === undefined ? undefined : chats.get(product)),
    agent: (product) => (product === undefined ? undefined : agents.get(product)),
  };
  const chatSources: SourceSelector = { product: [...chats.keys()] };
  const voiced = [...chats.values()].filter((each) => each.adapter.voice === true).map((each) => each.product);
  const inputs: FamilyInput[] = given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" }));

  return {
    name: AI_FAMILY,
    type: "ai",
    code: "5",
    inputs,

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const { record, before, after } = change;
        const source = view.source(record.source);
        const agent = feeds.agent(source?.product);
        if (agent !== undefined) return agent.adapter.kinds.includes(record.kind) ? sessionTouched({ adapter: agent.adapter, source: source! }, change, view) : [];
        const chat = feeds.chat(source?.product);
        if (chat === undefined) return [];
        const account = namedCopyOf(feeds.chat, record.source)!;
        const others = copiesOf(feeds, view, account).filter((other) => other !== record.source);
        if (record.kind === "msg") {
          const replicas = others.map((other) => headVersion(view, { source: other, kind: "msg", key: record.key }));
          const days = new Set([before, after, ...replicas].flatMap((version) => version?.time === undefined ? [] : [utcDate(version.time.start_ms)]));
          return [...days].sort().map((day) => ({ unit: unitOf(account, conversationOfKey(record.key), day) }));
        }
        if (record.kind !== "chat") return [];
        const title = (version: Version | undefined, row: SourceRow | undefined) => version === undefined || row === undefined ? null : chat.adapter.title?.({ source: row, version }) ?? null;
        const theirs = others.map((other) => title(headVersion(view, { source: other, kind: "chat", key: record.key }), view.source(other)));
        if (title(before, source) === title(after, source) && theirs.every((other) => other === null || other === title(after, source))) return [];
        return [...view.extractsUnder(AI_FAMILY, `${account}/${record.key}/`)].map((row) => ({ unit: row.unit }));
      });
    },

    extract(unit: string, view: View): Extracted | null {
      const parsed = parseUnit(unit);
      if (parsed !== null && namedCopyOf(feeds.chat, parsed.source) === parsed.source) return extractChat(feeds, parsed.source, parsed.conversation, parsed.day, view);
      const source = parsed === null ? undefined : view.source(parsed.source);
      const agent = feeds.agent(source?.product);
      if (parsed !== null && agent !== undefined) {
        const session = readSessionHour({ adapter: agent.adapter, source: source! }, view, parsed.conversation, parsed.day);
        return session === null ? null
          : { content: session.content as unknown as Json, start_ms: session.start_ms, end_ms: session.end_ms, reading: digest(session as unknown as Json) };
      }
      return null;
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (extract.start_ms === null || extract.end_ms === null) return [];
      if (isSession(extract) && parseUnit(extract.unit)?.day.length !== 13) return [];
      return daysOf({ start_ms: extract.start_ms, end_ms: extract.end_ms + 1, precision: "ms" }, settings);
    },

    items(extract: ExtractRow): { item: string; prompt: string }[] {
      if (isSession(extract)) return [];
      return asked(feeds, dayOf(extract)).map(({ item, prompt }) => ({ item, prompt }));
    },

    prompts: AI_PROMPTS,
    readers: READERS,
    works: { chats: chatSources, ...(voiced.length === 0 ? {} : { [VOICE_WORK]: { product: voiced } }) },

    plan(extract: ExtractRow, answered: ReadonlyMap<string, Reply>): Plan {
      if (isSession(extract)) return { asks: [] };
      const { source } = parseUnit(extract.unit)!;
      const asks: Ask[] = [];
      const answers: { item: string; content: Json }[] = [];
      const refusals: { item: string; reason: string }[] = [];
      const seen = new Set<string>();
      for (const { turn, item, prompt } of asked(feeds, dayOf(extract))) {
        if (seen.has(item)) continue;
        seen.add(item);
        const reply = answered.get(item);
        if (reply === undefined) {
          asks.push(prompt === VOICE_PROMPT ? askVoiceNote(turn.voice!.audio, turn.source ?? source) : {
            family: AI_FAMILY, item, prompt, input: prompt === TURN_PROMPT ? turnInput(turn) : replyInput(turn), work: "chats", source: turn.source ?? source,
          });
          continue;
        }
        const checked = READERS[prompt]!(reply.value) ?? (prompt === TURN_PROMPT ? checkTurnReply(turn, reply.value as unknown as TurnDescription)
          : prompt === VOICE_PROMPT ? { words: (reply.value as string).trim() } : { gist: (reply.value as string).trim() });
        if (typeof checked === "string") refusals.push({ item, reason: checked });
        else answers.push({ item, content: checked });
      }
      return { asks, answers, refusals };
    },

    text: {
      version: "1",
      kinds: [...new Set(given.flatMap((each) => each.adapter.kinds))].sort(),
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const agent = feeds.agent(source?.product);
        if (agent !== undefined) return agent.adapter.kinds.includes(record.kind) ? agentTurnText(agent.adapter, agent.adapter.said?.({ source: source!, version }) ?? null) : null;
        const chat = feeds.chat(source?.product);
        if (chat === undefined) return null;
        if (record.kind === "chat") return recordText({ title: chat.adapter.title?.({ source: source!, version }) ?? null });
        if (record.kind !== "msg") return null;
        const turn = chat.adapter.turn!({ source: source!, version });
        if (turn === null) return null;
        if (turn.voice == null) return recordText({ text: turn.words });
        const written = view.enrichment(AI_FAMILY, voiceItem(turn.voice.audio), VOICE_PROMPT);
        const words = written?.state === "done" ? (written.content as unknown as VoiceWords).words : null;
        return words === null || words === NO_SPEECH ? null : recordText({ text: words });
      },
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const agent = feeds.agent(source?.product);
        if (agent !== undefined) return agent.adapter.kinds.includes(record.kind) ? agentTurnRead(agent.adapter, agent.adapter.said?.({ source: source!, version }) ?? null) : null;
        const chat = feeds.chat(source?.product);
        if (chat === undefined) return null;
        if (record.kind === "chat") return recordRead({ title: chat.adapter.title?.({ source: source!, version }) ?? null });
        if (record.kind !== "msg") return null;
        const turn = chat.adapter.turn!({ source: source!, version });
        return turn === null ? null : recordRead({ text: turn.words, ...(turn.role === "user" ? { from: null } : {}) });
      },
    },

    day: linesOnly((input: DayInput): DayLine[] => {
      const sessions = new Map<string, ExtractRow[]>();
      for (const extract of input.extracts.filter(isSession).sort((left, right) => left.start_ms! - right.start_ms! || compare(left.unit, right.unit))) {
        const { source, conversation } = parseUnit(extract.unit)!;
        const hours = sessions.get(`${source}/${conversation}`);
        if (hours === undefined) sessions.set(`${source}/${conversation}`, [extract]);
        else hours.push(extract);
      }
      return [...[...sessions.values()].flatMap((hours) => sessionLines(feeds, hours)), ...input.extracts.filter((extract) => !isSession(extract)).flatMap((extract) => {
        const { source, conversation } = parseUnit(extract.unit)!;
        const day = dayOf(extract);
        const { title, turns } = day;
        const fed = feeds.chat(day.provider);
        const name = nameOf(fed, day.provider);
        const assistant = spoken(name, fed);
        const block = { key: `${source}/${conversation}`, title: title === null ? `${name} conversation` : `${name} · ${title}`, ...assistant };
        return turns.map((turn): DayLine => {
          const item = askedOf(feeds, day.provider, turn)?.item;
          const record: RecordRef = { source: turn.source ?? source, kind: "msg", key: turn.key };
          return {
            family: AI_FAMILY, unit: extract.unit, units: [extract.unit], start_ms: turn.at_ms, end_ms: null,
            text: turnText(feeds, day.provider, turn, item === undefined ? undefined : input.enrichments.get(item)),
            ...(turn.role === "assistant" ? assistant : {}),
            record,
            ...(item === undefined ? {} : { item }),
            block,
            chat: block.key,
          };
        });
      })];
    }),

    replicas(thing, view) {
      const records: RecordRef[] = [];
      const items = new Set<string>();
      const sources = view.sources(chatSources).sort((left, right) => compare(left.product, right.product) || compare(left.account, right.account)
        || Number(!named(feeds, left)) - Number(!named(feeds, right)) || compare(left.id, right.id));
      for (const row of sources) {
        const record = { source: row.id, kind: "msg", key: thing };
        if (view.head(record) === undefined) continue;
        records.push(record);
        const chat = feeds.chat(row.product)!;
        for (const id of new Set(view.history(record).map((statement) => statement.version))) {
          const version = id === GONE ? undefined : view.version(id);
          const turn = version === undefined ? null : turnOf(chat, row, version);
          const asks = turn === null ? undefined : askedOf(feeds, row.product, turn);
          if (asks !== undefined) items.add(asks.item);
        }
      }
      return { records, items: [...items].sort(compare) };
    },
  };
}

function extractChat(feeds: Feeds, account: string, conversation: string, day: string, view: View): Extracted | null {
  const chat = feeds.chat(partsOf(account).product);
  if (chat === undefined) return null;
  const start = instant(day, "date").start_ms;
  const sources = copiesOf(feeds, view, account);
  const keys = new Set<string>();
  for (const source of sources) {
    for (const { head } of view.records(source, "msg", { start_ms: start, end_ms: start + DAY_MS })) {
      if (conversationOfKey(head.key) !== conversation || head.start_ms === null) continue;
      if (head.start_ms >= start && head.start_ms < start + DAY_MS) keys.add(head.key);
    }
  }
  const copies = [...keys].flatMap((key) => sources.flatMap((source): Copy[] => {
    const head = headVersion(view, { source, kind: "msg", key });
    const row = view.source(source)!;
    const turn = head === undefined ? null : shownTurn(chat, row, { source, kind: "msg", key }, head, view);
    return turn === null ? [] : [{ source, other: !named(feeds, row), turn }];
  }));
  const turns = chooseReplicas(copies, TURNS).flatMap(({ chosen }) =>
    chosen.turn.at_ms < start || chosen.turn.at_ms >= start + DAY_MS ? [] : [chosen.source === account ? chosen.turn : { ...chosen.turn, source: chosen.source }]);
  if (turns.length === 0) return null;
  turns.sort((left, right) => left.at_ms - right.at_ms || compare(left.key, right.key));
  const content: ConversationDay = { provider: chat.product, title: shownTitle(feeds, chat, account, conversation, view), turns };
  return { content: content as unknown as Json, start_ms: turns[0]!.at_ms, end_ms: turns.at(-1)!.at_ms, reading: digest(content as unknown as Json) };
}

export function unitOf(source: string, conversation: string, day: string): string {
  return `${source}/${conversation}/${day}`;
}

function parseUnit(unit: string): { source: string; conversation: string; day: string } | null {
  const match = /^([^/]+)\/([^/]+)\/(\d{4}-\d{2}-\d{2}(?:T\d{2})?)$/u.exec(unit);
  return match === null ? null : { source: match[1]!, conversation: match[2]!, day: match[3]! };
}

export function itemOf(turn: Turn): string {
  return turn.role === "user"
    ? digest({ role: "user", words: turn.words, attachments: turn.attachments.map(({ name, mime, text }) => ({ name, mime, text })) })
    : digest({ role: "assistant", words: turn.words });
}

export function turnSize(turn: Turn): number {
  return turn.words.length + turn.attachments.reduce((sum, file) => sum + (file.text?.length ?? 0), 0);
}

function promptOf(feeds: Feeds, provider: string, turn: Turn): string | null {
  if (turn.role === "user" && turn.voice != null) return feeds.chat(provider)?.adapter.voice === true ? VOICE_PROMPT : null;
  if (turn.role === "user") return turnSize(turn) >= TURN_ASK_CHARS ? TURN_PROMPT : null;
  return feeds.chat(provider)?.adapter.gist === true && turn.words.length >= REPLY_ASK_CHARS ? REPLY_PROMPT : null;
}

function askedOf(feeds: Feeds, provider: string, turn: Turn): { item: string; prompt: string } | undefined {
  const prompt = promptOf(feeds, provider, turn);
  if (prompt === null) return undefined;
  return { item: prompt === VOICE_PROMPT ? voiceItem(turn.voice!.audio) : itemOf(turn), prompt };
}

function asked(feeds: Feeds, day: ConversationDay): { turn: Turn; item: string; prompt: string }[] {
  return day.turns.flatMap((turn) => {
    const asks = askedOf(feeds, day.provider, turn);
    return asks === undefined ? [] : [{ turn, ...asks }];
  });
}

export function voiceItem(audio: string): string {
  return `voice:${audio.replace(/^sha256:/u, "")}`;
}

export function askVoiceNote(audio: string, source: string): Ask {
  return {
    family: AI_FAMILY, item: voiceItem(audio), prompt: VOICE_PROMPT,
    input: [], attachments: [{ blob: audio, media_type: VOICE_MEDIA }], identity: { audio }, work: VOICE_WORK, source,
  };
}

function shownTurn(chat: Given<AiAdapter>, row: SourceRow, record: RecordRef, head: Version, view: View): Turn | null {
  const read = (version: Version) => turnOf(chat, row, version);
  const turn = read(head);
  if (turn === null || !statesNothing(turn)) return turn;
  for (const statement of newestFirst(view.history(record))) {
    if (statement.version === GONE) break;
    if (statement.version === head.id) continue;
    const earlier = read(view.version(statement.version));
    if (earlier !== null && !statesNothing(earlier)) return earlier;
  }
  return null;
}

function turnOf(chat: Given<AiAdapter>, source: SourceRow, version: Version): Turn | null {
  if (version.time === undefined) return null;
  const read = chat.adapter.turn!({ source, version });
  return read === null ? null : { key: version.key, at_ms: version.time.start_ms, ...read };
}


function partsOf(source: string): { product: string; account: string } {
  const [product = "", account = ""] = source.split(":");
  return { product, account };
}

export function namedCopyOf(chats: AiChats, source: string): string | null {
  const { product, account } = partsOf(source);
  const chat = chats(product);
  if (chat === undefined || account === "") return null;
  const { copy } = chat.adapter;
  return copy === undefined ? source : `${product}:${account}:${copy}`;
}

function copiesOf(feeds: Feeds, view: View, account: string): string[] {
  const { product, account: name } = partsOf(account);
  return view.sources({ product: [product] }).filter((row) => row.account === name)
    .sort((left, right) => Number(!named(feeds, left)) - Number(!named(feeds, right)) || compare(left.id, right.id))
    .map((row) => row.id);
}

function named(feeds: Feeds, row: SourceRow): boolean {
  const copy = feeds.chat(row.product)?.adapter.copy;
  return copy === undefined || row.copy === copy;
}

interface Copy {
  source: string;
  other: boolean;
  turn: Turn;
}

const TURNS: ReplicaRule<Copy> = {
  same: (copy) => copy.turn.key,
  prefer: (left, right) => turnSize(right.turn) - turnSize(left.turn) || parts(right.turn) - parts(left.turn) || Number(left.other) - Number(right.other),
  id: (copy) => `${copy.source}\0${copy.turn.key}`,
};

function parts(turn: Turn): number {
  return turn.attachments.length + turn.images + turn.tools.length + turn.documents.length + (turn.voice == null ? 0 : 1);
}

interface Titled {
  source: string;
  other: boolean;
  title: string;
  at_ms: number;
}

const TITLES: ReplicaRule<Titled> = {
  same: () => "",
  prefer: (left, right) => right.at_ms - left.at_ms || Number(left.other) - Number(right.other),
  id: (titled) => titled.source,
};

function shownTitle(feeds: Feeds, chat: Given<AiAdapter>, account: string, conversation: string, view: View): string | null {
  const titles = copiesOf(feeds, view, account).flatMap((source): Titled[] => {
    const row = view.source(source)!;
    const record = { source, kind: "chat", key: conversation };
    const head = view.head(record);
    if (head === undefined || head.version === GONE) return [];
    for (const statement of [{ version: head.version }, ...newestFirst(view.history(record))]) {
      if (statement.version === GONE) break;
      const version = view.version(statement.version);
      const title = chat.adapter.title?.({ source: row, version }) ?? null;
      if (title !== null) return [{ source, other: !named(feeds, row), title, at_ms: version.time?.start_ms ?? 0 }];
    }
    return [];
  });
  return chooseReplicas(titles, TITLES)[0]?.chosen.title ?? null;
}

function headVersion(view: View, record: RecordRef): Version | undefined {
  const head = view.head(record);
  return head === undefined || head.version === GONE ? undefined : view.version(head.version);
}

function newestFirst(statements: Statement[]): Statement[] {
  return [...statements].sort((left, right) => right.stated_ms - left.stated_ms || right.seq - left.seq);
}


function turnInput(turn: Turn): Piece[] {
  const parts: Sayable[] = [`Message (${count(turn.words.length)} characters):`, shown(turn.words, TURN_SHOWN)];
  turn.attachments.forEach((file, index) => {
    const what = said`Attached file ${index + 1} of ${turn.attachments.length}: ${free(file.name)}${file.mime === null ? "" : ` (${file.mime})`}`;
    parts.push("", file.text === null ? said`${what}, no text stated` : said`${what}, ${count(file.text.length)} characters of text:`);
    if (file.text !== null) parts.push(shown(file.text, FILE_SHOWN));
  });
  return said`${sayJoined(parts, "\n")}\n`;
}

function replyInput(turn: Turn): Piece[] {
  return said`Reply (${count(turn.words.length)} characters):\n${shown(turn.words, REPLY_SHOWN)}\n`;
}

export function checkTurnReply(turn: Turn, answer: TurnDescription): TurnDescription | string {
  const words = loose(turn.words);
  let from = 0;
  for (const [index, entry] of answer.own.entries()) {
    const excerpt = loose(entry);
    const at = words.indexOf(excerpt, from);
    if (at < 0) {
      return words.includes(excerpt)
        ? `own[${index}] is out of order or repeated: ${JSON.stringify(textHead(entry, 80))}`
        : `own[${index}] is not in the message word for word: ${JSON.stringify(textHead(entry, 80))}`;
    }
    from = at + excerpt.length;
  }
  if (answer.attachments.length !== turn.attachments.length) return `attachments has ${answer.attachments.length} lines for ${turn.attachments.length} attached files`;
  return { own: answer.own, pasted: answer.pasted.trim(), attachments: answer.attachments.map((entry) => entry.trim()) };
}

function turnLines(answer: TurnDescription): string | null {
  const empty = answer.own.findIndex((entry) => entry.trim() === "");
  if (empty >= 0) return `own[${empty}] is empty`;
  const pasted = checkLine(answer.pasted, "pasted", true);
  if (pasted !== null) return pasted;
  for (const [index, entry] of answer.attachments.entries()) {
    const line = checkLine(entry, `attachments[${index}]`, false);
    if (line !== null) return line;
  }
  return null;
}

function checkLine(value: string, name: string, mayBeEmpty: boolean): string | null {
  const line = value.trim();
  if (line === "" && !mayBeEmpty) return `${name} is empty`;
  if (/[\r\n]/u.test(line)) return `${name} is more than one line`;
  if (line.length > LINE_CHARS) return `${name} is ${line.length} characters, over ${LINE_CHARS}`;
  return null;
}

function loose(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}


function turnText(feeds: Feeds, provider: string, turn: Turn, enrichment: EnrichmentRow | undefined): string {
  const speaker = turn.role === "user" ? ME : nameOf(feeds.chat(provider), provider);
  const done = enrichment?.state === "done" ? enrichment.content : undefined;
  const marks = [
    ...turn.tools.length === 0 ? [] : [`[used ${turn.tools.join(", ")}]`],
    ...turn.documents.map((title) => `[made: ${title}]`),
    ...turn.images === 0 ? [] : [turn.images === 1 ? "[image]" : `[${turn.images} images]`],
  ];
  const promptName = promptOf(feeds, provider, turn);
  if (promptName === VOICE_PROMPT) return [`${speaker}: ${voiceText(turn.voice!, done as unknown as VoiceWords | undefined)}`, ...marks].join(" ");
  if (promptName === null) {
    return [`${speaker}: ${turn.words}`, ...turn.attachments.map((file) => `[attached: ${file.name}]`), ...marks].join(" ");
  }
  const size = count(turn.role === "user" ? turnSize(turn) : turn.words.length);
  const waiting = enrichment === undefined ? "description pending" : "not described";
  if (turn.role === "assistant") {
    const gist = done === undefined ? null : (done as { gist: string }).gist;
    return [gist === null ? `${speaker}: ${textHead(turn.words, 200)}… [${size}-character reply, ${waiting}]` : `${speaker}: ${gist} [${size}-character reply]`, ...marks].join(" ");
  }
  if (done === undefined) {
    return [`${speaker}: ${textHead(turn.words, 300)}… [${size} characters, ${waiting}]`, ...turn.attachments.map((file) => `[attached: ${file.name}]`), ...marks].join(" ");
  }
  const description = done as unknown as TurnDescription;
  return [
    `${speaker}: ${description.own.length === 0 ? "(only pasted)" : description.own.join(" … ")}`,
    ...description.pasted === "" ? [] : [`[pasted: ${description.pasted}]`],
    ...turn.attachments.map((file, index) => `[attached ${file.name}: ${description.attachments[index] ?? ""}]`),
    ...marks,
  ].join(" ");
}

function voiceText(voice: { ms: number }, written: VoiceWords | undefined): string {
  const length = `voice note, ${Math.max(1, Math.round(voice.ms / 1_000))} s`;
  if (written === undefined) return `[${length}]`;
  return `[${length}: ${written.words === NO_SPEECH ? "no speech" : `"${written.words}"`}]`;
}

function sessionLines(feeds: Feeds, hours: readonly ExtractRow[]): DayLine[] {
  const { source, conversation: session } = parseUnit(hours[0]!.unit)!;
  const day = mergeSessions(hours.map((extract) => extract.content as unknown as SessionHour));
  const units = new Map(hours.flatMap((extract) => (extract.content as unknown as SessionHour).turns.map((turn) => [turn.key, extract.unit])));
  const fed = feeds.agent(day.provider);
  const name = nameOf(fed, day.provider);
  const block = { key: `${source}/${session}`, title: `${name} ${day.folder === null ? "session" : `in ${day.folder}`}`, ...spoken(name, fed) };
  const end = Math.max(...hours.map((extract) => extract.end_ms!));
  return [
    {
      family: AI_FAMILY, unit: hours[0]!.unit, units: hours.map((extract) => extract.unit),
      accounts: accountsOf(hours.map((extract) => parseUnit(extract.unit)!.source)), start_ms: hours[0]!.start_ms, end_ms: end, text: workText(day), block,
    },
    ...day.turns.map((turn): DayLine => ({
      family: AI_FAMILY, unit: units.get(turn.key)!, units: [units.get(turn.key)!], start_ms: turn.at_ms, end_ms: null, text: `${ME}: ${turnWords(turn)}`,
      record: { source, kind: AGENT_TURN, key: turn.key }, block,
    })),
  ];
}


function isSession(extract: ExtractRow): boolean {
  const content = extract.content as Record<string, unknown> | null;
  return content !== null && ("tools" in content || "tool_calls" in content);
}

export function assistantsOf(family: Pick<Family, "adapters"> | undefined): { product: string; name: string; who: string }[] {
  return (family?.adapters ?? []).map(({ product, name }) => ({ product, name, who: assistantWho(product) })).sort((left, right) => compare(left.product, right.product));
}

export function assistantWho(product: string): string {
  return `assistant:${product}`;
}

function spoken(name: string, fed: Given<AiAdapter> | undefined): { names?: NameSpan[] } {
  return fed === undefined || name.trim() === "" || name !== name.trim() ? {} : { names: [{ start: 0, end: name.length, who: assistantWho(fed.product) }] };
}

function nameOf(fed: Given<AiAdapter> | undefined, product: string): string {
  return fed?.name ?? product;
}

function dayOf(extract: ExtractRow): ConversationDay {
  return extract.content as unknown as ConversationDay;
}

function shown(text: string, { head, tail }: { head: number; tail: number }): Piece[] {
  if (text.length <= head + tail) return [free(text)];
  const first = textHead(text, head);
  let from = text.length - tail;
  if (tail > 0 && isLowSurrogate(text.charCodeAt(from))) from++;
  const last = tail === 0 ? "" : text.slice(from);
  return said`${free(first, text)}\n[… ${count(from - first.length)} characters left out …]${last === "" ? "" : said`\n${free(last)}`}`;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

