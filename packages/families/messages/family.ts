import {
  civilDay, dayBounds, digest, handleId, instant, render,
  type Ask, type BlobReader, type ExtractRow, type Json, type JsonObject, type MessagesAdapter, type Prompt, type RecordRef, type SourceRow, type View,
} from "@lifestreamprotocol/core";
import { accountsOf, drawnFrom, factId, type Change, type Collection, type DayFact, type DayInput, type DayLine, type DayProjection, type Family, type FamilyInput, type Given, type Labels, type Plan, type Touched } from "../family.js";
import { chatName, joined, nameId, printed, type Named, type Printed, type Printable } from "../shared/cast.js";
import { labelerRecordsOf } from "../shared/labelers.js";
import { labelInputs, labelRead, labelText, type Books } from "../shared/labels.js";
import { statedPrompt } from "../shared/prompts.js";
import { recordRead, recordText } from "../shared/text.js";
import { chooseReplicas, type ReplicaRule } from "../shared/replicas.js";
import { chatMembers, isGroupChat, labelWho, networksOf, partyHandle, resolveChat, type Networks } from "./networks.js";
import { messageRead, messageText, readMessage, type Fact, type Part, type Read } from "./read.js";

export const MESSAGES_FAMILY = "messages";

export const CAPTION_PROMPT = "chat-image-caption";
export const TRANSCRIPT_PROMPT = "voice-note-transcript";

export const MESSAGES_PROMPTS: Readonly<Record<string, Prompt>> = {
  [CAPTION_PROMPT]: statedPrompt(new URL("./prompts/", import.meta.url), CAPTION_PROMPT),
  [TRANSCRIPT_PROMPT]: statedPrompt(new URL("./prompts/", import.meta.url), TRANSCRIPT_PROMPT),
};

export interface ChatDay {
  network: string;
  chat: string;
  day: string;
  messages: Fact[];
}

export type Described = { caption: string } | { transcript: string };

const DAY_MS = 86_400_000;

const READERS: Readonly<Record<string, (value: Json) => string | null>> = Object.fromEntries(Object.keys(MESSAGES_PROMPTS).map((prompt) => [prompt, (value: Json) => replyRefusal(prompt, value as string)]));

export function messagesFamily(books: Books): (given: readonly Given<MessagesAdapter>[]) => Family {
  return (given) => messagesOver(books, given);
}

function messagesOver(books: Books, given: readonly Given<MessagesAdapter>[]): Family {
  const networks = networksOf(given);
  const sources = { product: [...networks.products] };
  const inputs: FamilyInput[] = [
    ...given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    ...given.flatMap((each): FamilyInput[] => each.adapter.labels === undefined || each.adapter.labelText === undefined ? [] : [{ sources: { product: [each.product] }, kinds: [...each.adapter.labels.kinds], role: "labels" }]),
    ...labelInputs(books),
  ];
  const labelKinds = given.flatMap((each) => each.adapter.labelText === undefined ? [] : each.adapter.labels?.kinds ?? []);
  return {
    name: MESSAGES_FAMILY,
    adapters: given,
    type: "messages",
    code: "4",
    inputs,
    prompts: MESSAGES_PROMPTS,
    readers: READERS,
    works: { photos: sources, voice: sources },

    touched(changes: readonly Change[], view: View): Touched[] {
      return changes.flatMap((change): Touched[] => {
        const source = view.source(change.record.source);
        const adapter = source === undefined ? undefined : networks.of(source.product);
        if (source === undefined || adapter === undefined || !adapter.kinds.includes(change.record.kind)) return [];
        const units = new Set<string>();
        for (const version of [change.before, change.after]) {
          const read = version === undefined ? null : readMessage(adapter, source, version);
          if (read !== null) units.add(messagesUnit(read));
        }
        for (const read of replicaHeads(view, networks, source.product, change.record.key, change.record.source)) units.add(messagesUnit(read));
        return [...units].sort(compare).map((unit) => ({ unit }));
      });
    },

    extract(unit, view, files) {
      const { day, network, chat } = parseMessagesUnit(unit);
      if (networks.of(network) === undefined) return null;
      const reads = dayReads(view, networks, network, day);
      const shown = new Map<string, Fact>();
      const decided = new Set<string>();
      for (const read of reads.byChat.get(chat) ?? []) {
        if (decided.has(read.fact.key)) continue;
        decided.add(read.fact.key);
        const sameDay = reads.byKey.get(read.fact.key) ?? [];
        const elsewhere = replicaHeads(view, networks, network, read.fact.key, ...sameDay.map((copy) => copy.fact.source));
        const [choice] = chooseReplicas([...sameDay, ...elsewhere], REPLICAS);
        if (choice !== undefined && choice.chosen.chat === chat && choice.chosen.day === day) shown.set(read.fact.key, withFiles(choice.chosen.fact, files));
      }
      if (shown.size === 0) return null;
      const content: ChatDay = { network, chat, day, messages: [...shown.values()].sort(byTime) };
      const json = content as unknown as Json;
      return { content: json, start_ms: content.messages[0]!.at, end_ms: content.messages.at(-1)!.at, reading: digest(json) };
    },

    days(extract, settings) {
      return [...new Set(chatDay(extract).messages.map((message) => civilDay(message.at, settings)))].sort(compare);
    },

    items(extract) {
      return asked(chatDay(extract)).map(({ item, prompt }) => ({ item, prompt }));
    },

    plan(extract, answered) {
      const plan: Required<Plan> = { asks: [], answers: [], refusals: [] };
      for (const { item, prompt, ask } of asked(chatDay(extract))) {
        const reply = answered.get(item);
        if (reply === undefined) {
          plan.asks.push(ask);
          continue;
        }
        const refused = READERS[prompt]!(reply.value);
        if (refused !== null) plan.refusals.push({ item, reason: refused });
        else plan.answers.push({ item, content: described(prompt, reply.value as string) as Json });
      }
      return plan;
    },

    day: (input) => dayProjection(input, networks),
    collections: MESSAGES_COLLECTIONS,

    replicas(thing, view, labels) {
      const records: RecordRef[] = [];
      const items = new Set<string>();
      const images = new Set<string>();
      for (const network of networks.products) {
        const adapter = networks.of(network)!;
        for (const source of sourcesOf(view, network)) for (const key of keysOf(networks, network, thing, labels)) {
          const record = { source: source.id, kind: "msg", key };
          if (view.head(record) === undefined) continue;
          records.push(record);
          for (const id of new Set(view.history(record).map((statement) => statement.version))) {
            const version = id === "gone" ? undefined : view.version(id);
            const read = version === undefined ? null : readMessage(adapter, source, version);
            for (const part of read?.fact.parts ?? []) {
              if (part.blob === undefined) continue;
              if (part.ask !== undefined) items.add(part.blob);
              if (part.media_type?.startsWith("image/") === true) images.add(part.blob);
            }
          }
        }
      }
      const labelled = [...images].sort(compare).flatMap((blob) => labelerRecordsOf(view, blob.slice("sha256:".length), records));
      return { records: [...records, ...labelled], items: [...items].sort(compare) };
    },

    text: {
      version: "4",
      kinds: [...new Set(["msg", ...labelKinds, "contact", "person"])],
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const adapter = source === undefined ? undefined : networks.of(source.product);
        if (record.kind !== "msg") {
          if (source === undefined || adapter?.labels?.kinds.includes(record.kind) !== true) return labelText(record.kind, version.content);
          const said = adapter.labelText?.({ source, version }) ?? null;
          return said === null ? null : recordText({ title: said.title, who: said.who.flatMap((id) => labelWho(networks, source.product, id) ?? []) });
        }
        return source === undefined || adapter === undefined ? null : messageText(adapter, source, version);
      },
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const adapter = source === undefined ? undefined : networks.of(source.product);
        if (record.kind !== "msg") {
          if (source === undefined || adapter?.labels?.kinds.includes(record.kind) !== true) return labelRead(record.kind, version.content);
          const said = adapter.labelText?.({ source, version }) ?? null;
          return said === null ? null : recordRead({ title: said.title, who: said.who.flatMap((id) => labelWho(networks, source.product, id) ?? []) });
        }
        return source === undefined || adapter === undefined ? null : messageRead(adapter, source, version);
      },
    },
  };
}

function replyRefusal(prompt: string, answer: string): string | null {
  const text = answer.trim();
  if (text.length === 0) return "the reply is empty";
  if (prompt === CAPTION_PROMPT && /\b(?:can(?:no|')t|unable to|do not|don't) (?:see|view|access|open)\b[^.]*\bimage\b|\bno image (?:is |was )?(?:attached|provided)\b/iu.test(text)) {
    return "the reply says it cannot see the image";
  }
  return null;
}

function described(prompt: string, answer: string): Described {
  return prompt === CAPTION_PROMPT ? { caption: answer.trim() } : { transcript: answer.trim() };
}

export function transcriptIdentity(blob: string, format: string): JsonObject {
  return { audio: blob, format };
}

export function messagesUnit(read: Pick<Read, "day" | "network" | "chat">): string {
  return `${read.day}:${read.network}:${read.chat}`;
}

export function parseMessagesUnit(unit: string): { day: string; network: string; chat: string } {
  const match = /^(\d{4}-\d{2}-\d{2}):([a-z0-9][a-z0-9-]*):(.+)$/su.exec(unit);
  if (match === null) throw new TypeError(`not a messages unit: ${JSON.stringify(unit)}`);
  return { day: match[1]!, network: match[2]!, chat: match[3]! };
}


const REPLICAS: ReplicaRule<Read> = {
  same: (read) => read.fact.key,
  prefer: (left, right) => preferFact(left.fact, right.fact),
  id: (read) => `${read.fact.source}\0${read.fact.key}`,
};

function preferFact(left: Fact, right: Fact): number {
  return Number(right.withdrawn === true) - Number(left.withdrawn === true) || richness(right) - richness(left);
}

function richness(fact: Fact): number {
  return 2 * (fact.parts ?? []).filter((part) => part.blob !== undefined).length + (fact.text === undefined ? 0 : 1);
}

interface DayReads {
  byChat: Map<string, Read[]>;
  byKey: Map<string, Read[]>;
}

const readsByView = new WeakMap<View, Map<string, DayReads>>();
const sourcesByView = new WeakMap<View, Map<string, SourceRow[]>>();

function dayReads(view: View, networks: Networks, network: string, day: string): DayReads {
  let cache = readsByView.get(view);
  if (cache === undefined) readsByView.set(view, (cache = new Map()));
  const name = `${network}\0${day}`;
  const known = cache.get(name);
  if (known !== undefined) return known;
  const adapter = networks.of(network)!;
  const start_ms = instant(day, "date").start_ms;
  const reads: DayReads = { byChat: new Map(), byKey: new Map() };
  for (const source of sourcesOf(view, network)) {
    for (const kind of adapter.kinds) {
      for (const { version } of view.records(source.id, kind, { start_ms, end_ms: start_ms + DAY_MS })) {
        const read = readMessage(adapter, source, version);
        if (read === null || read.day !== day) continue;
        push(reads.byChat, read.chat, read);
        push(reads.byKey, read.fact.key, read);
      }
    }
  }
  cache.set(name, reads);
  return reads;
}

export function shownCopy(view: View, networks: Networks, network: string, key: string): Read | null {
  return chooseReplicas(replicaHeads(view, networks, network, key), REPLICAS)[0]?.chosen ?? null;
}

function replicaHeads(view: View, networks: Networks, network: string, key: string, ...except: string[]): Read[] {
  const adapter = networks.of(network);
  if (adapter === undefined) return [];
  const out: Read[] = [];
  for (const source of sourcesOf(view, network)) {
    if (except.includes(source.id)) continue;
    for (const kind of adapter.kinds) {
      const head = view.head({ source: source.id, kind, key });
      const version = head === undefined || head.version === "gone" ? undefined : view.version(head.version);
      const read = version === undefined ? null : readMessage(adapter, source, version);
      if (read !== null) out.push(read);
    }
  }
  return out;
}

function sourcesOf(view: View, network: string): SourceRow[] {
  let cache = sourcesByView.get(view);
  if (cache === undefined) sourcesByView.set(view, (cache = new Map()));
  let sources = cache.get(network);
  if (sources === undefined) {
    sources = view.sources({ product: [network] }).sort((left, right) => compare(left.id, right.id));
    cache.set(network, sources);
  }
  return sources;
}

function withFiles(fact: Fact, files: BlobReader): Fact {
  if (fact.parts?.some((part) => part.ask !== undefined) !== true) return fact;
  const parts = fact.parts.map((part): Part => {
    if (part.ask === undefined || part.blob === undefined) return part;
    const { ask, format: _format, ...bare } = part;
    if (!files.has(part.blob)) return bare;
    if (ask !== "transcript") return part;
    let sent = containers.get(part.blob);
    if (sent === undefined) containers.set(part.blob, (sent = AUDIO[audioContainer(files.bytes(part.blob)) ?? "none"] ?? null));
    return sent === null ? bare : { ...bare, ...sent, ask };
  });
  return { ...fact, parts };
}

export function voiceNoteOf(fact: Fact): { blob: string; seconds?: number } | null {
  if (fact.withdrawn === true) return null;
  const part = fact.parts?.find((each) => each.ask === "transcript" && each.blob !== undefined);
  if (part === undefined) return null;
  return { blob: part.blob!, ...(part.seconds === undefined ? {} : { seconds: part.seconds }) };
}

const AUDIO: Readonly<Record<string, { format: string; media_type: string } | null>> = {
  ogg: { format: "ogg", media_type: "audio/ogg" },
  caf: { format: "m4a", media_type: "audio/x-caf" },
  mp4: { format: "m4a", media_type: "audio/mp4" },
  aac: { format: "aac", media_type: "audio/aac" },
  mp3: { format: "mp3", media_type: "audio/mpeg" },
  wav: { format: "wav", media_type: "audio/wav" },
  none: null,
};

const containers = new Map<string, { format: string; media_type: string } | null>();

function audioContainer(bytes: Uint8Array): string | null {
  const ascii = (at: number, length: number) => at + length > bytes.length ? "" : String.fromCharCode(...bytes.subarray(at, at + length));
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "caff") return "caf";
  if (ascii(4, 4) === "ftyp") return "mp4";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "wav";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return (bytes[1]! & 0x06) === 0 ? "aac" : "mp3";
  return null;
}


interface Asked {
  item: string;
  prompt: string;
  ask: Ask;
}

function asked(content: ChatDay): Asked[] {
  const out = new Map<string, Asked>();
  for (const message of content.messages) {
    for (const part of message.parts ?? []) {
      if (part.blob === undefined || part.ask === undefined || out.has(part.blob)) continue;
      if (part.ask === "transcript" && part.format === undefined) continue;
      const [prompt, work] = part.ask === "caption" ? [CAPTION_PROMPT, "photos"] : [TRANSCRIPT_PROMPT, "voice"];
      const ask: Ask = {
        family: MESSAGES_FAMILY,
        item: part.blob,
        prompt,
        input: [],
        attachments: [{ blob: part.blob, media_type: part.media_type ?? "application/octet-stream" }],
        ...(part.ask === "transcript" ? { identity: transcriptIdentity(part.blob, part.format!) } : {}),
        work, source: message.source,
      };
      out.set(part.blob, { item: part.blob, prompt, ask });
    }
  }
  return [...out.values()];
}


export const QUIET_TITLE = "You were quiet in";

interface Shown {
  unit: string;
  network: string;
  chat: string;
  fact: Fact;
}

function dayProjection(input: DayInput, networks: Networks): DayProjection {
  const { labels } = input;
  const things = shownOnce(input.extracts, labels, networks);
  const shown = [...things.entries()].sort(([, left], [, right]) => byTime(left.fact, right.fact));
  const inOrder = shown.map(([, message]) => message);
  const titles = new Map<string, Printed>();
  const quiet = new Map<string, boolean>();
  for (const [, message] of shown) {
    const block = `${message.network}:${message.chat}`;
    if (!titles.has(block)) titles.set(block, title(networks, message.network, message.chat, inOrder, labels));
    if (!quiet.has(block)) quiet.set(block, isGroupChat(networks, message.network, message.chat) && labels.quiet(message.network, message.chat, input.day));
  }
  const window = dayBounds(input.day, input.settings);
  const folded = new Map<string, [string, Shown][]>();
  const lines: DayLine[] = [];
  const facts: DayFact[] = [];
  for (const [thing, message] of shown) {
    const block = `${message.network}:${message.chat}`;
    if (quiet.get(block) === true) {
      if (message.fact.at >= window.start_ms && message.fact.at < window.end_ms) push(folded, block, [thing, message]);
      continue;
    }
    const line = lines.push(messageLine(message, things, input, networks, titles.get(block)!)) - 1;
    if (isMessage(message.fact)) facts.push(messageFact(thing, message, networks, line));
  }
  for (const [block, messages] of folded) {
    const line = lines.push({
      family: MESSAGES_FAMILY,
      unit: messages[0]![1].unit,
      units: [...new Set(messages.map(([, message]) => message.unit))],
      accounts: accountsOf(messages.map(([, message]) => message.fact.source)),
      start_ms: null,
      end_ms: null,
      ...printed`${titles.get(block)!} · ${messages.length} ${messages.length === 1 ? "message" : "messages"}`,
      block: { key: block, title: QUIET_TITLE },
      chat: block,
    }) - 1;
    for (const [thing, message] of messages) if (isMessage(message.fact)) facts.push(messageFact(thing, message, networks, line));
  }
  return { lines, facts };
}


export const MESSAGES_COLLECTIONS: Readonly<Record<string, Collection>> = {
  messages: { keys: ["chat", "direction", "product", "searchable"], measures: {} },
};

function isMessage(fact: Fact): boolean {
  if (fact.from.kind === "system") return false;
  return !(fact.parts ?? []).some((part) => part.what.startsWith("reaction") || part.what.startsWith("group event"));
}

function messageFact(thing: string, message: Shown, networks: Networks, line: number): DayFact {
  const { fact, network } = message;
  const sent = fact.from.kind === "me";
  const parties = sent ? chatMembers(networks, network, message.chat) : [fact.from];
  const handles = [...new Set(parties.flatMap((party) => {
    const handle = partyHandle(network, party);
    return handle === null ? [] : [handleId(handle)];
  }))].sort(compare);
  const role = sent ? "receiver" : "sender";
  return {
    of: "messages", id: factId("messages", thing), time_ms: fact.at, start_ms: fact.at, end_ms: fact.at,
    keys: { chat: `${network}:${message.chat}`, direction: sent ? "sent" : "received", product: network, searchable: fact.text === undefined ? "no" : "yes" },
    measures: {},
    who: handles.map((handle) => ({ handle, role })),
    from: { units: [message.unit], record: { source: fact.source, kind: "msg", key: fact.key }, alone: true },
    lines: [line],
  };
}

function messageLine(message: Shown, things: ReadonlyMap<string, Shown>, input: DayInput, networks: Networks, title: Printed): DayLine {
  const parent = parentOf(message, things, input, networks);
  const record = { source: message.fact.source, kind: "msg", key: message.fact.key };
  return {
    family: MESSAGES_FAMILY,
    unit: message.unit,
    units: [message.unit],
    ...drawnFrom([message.unit], parent === undefined ? [record] : [record, { source: parent.fact.source, kind: "msg", key: parent.fact.key }]),
    start_ms: message.fact.at,
    end_ms: null,
    ...printed`${partyName(message, input.labels)}: ${body(message, parent, input)}`,
    record,
    block: { key: `${message.network}:${message.chat}`, title: title.text, names: title.names },
    chat: `${message.network}:${message.chat}`,
    ...picturesOf(message.fact),
  };
}

function picturesOf(fact: Fact): { pictures?: number } {
  const pictures = new Set((fact.parts ?? []).flatMap((part) => (part.blob !== undefined && part.media_type?.startsWith("image/") === true ? [part.blob] : []))).size;
  return pictures === 0 ? {} : { pictures };
}

export interface Conversation {
  title: string;
  messages: { line: DayLine; fact: Fact }[];
}

export function conversationOn(input: DayInput, chat: string, networks: Networks): Conversation {
  const { labels } = input;
  const colon = chat.indexOf(":");
  const network = chat.slice(0, colon);
  const id = resolveChat(networks, network, chat.slice(colon + 1), labels);
  const things = shownOnce(input.extracts, labels, networks);
  const shown = [...things.values()].filter((message) => message.network === network && message.chat === id).sort((left, right) => byTime(left.fact, right.fact));
  const named = title(networks, network, id, shown, labels);
  const window = dayBounds(input.day, input.settings);
  return {
    title: named.text,
    messages: shown.filter((message) => message.fact.at >= window.start_ms && message.fact.at < window.end_ms)
      .map((message) => ({ line: messageLine(message, things, input, networks, named), fact: message.fact })),
  };
}

function shownOnce(extracts: Iterable<ExtractRow>, labels: Labels, networks: Networks): Map<string, Shown> {
  const things = new Map<string, Shown>();
  for (const extract of extracts) {
    const content = chatDay(extract);
    const chat = resolveChat(networks, content.network, content.chat, labels);
    for (const fact of content.messages) {
      const thing = thingOf(networks, content.network, fact.key, labels);
      const known = things.get(thing);
      const candidate: Shown = { unit: extract.unit, network: content.network, chat, fact };
      if (known === undefined || preferShown(candidate, known) < 0) things.set(thing, candidate);
    }
  }
  return things;
}

export function shownUnit(unit: string, labels: Labels, networks: Networks): string {
  const { day, network, chat } = parseMessagesUnit(unit);
  return `${day}:${network}:${resolveChat(networks, network, chat, labels)}`;
}

export function shownChatDay(extracts: readonly ExtractRow[], labels: Labels, networks: Networks): ChatDay {
  const first = chatDay(extracts[0]!);
  const messages = [...shownOnce(extracts, labels, networks).values()].map((shown) => shown.fact).sort(byTime);
  return { network: first.network, chat: resolveChat(networks, first.network, first.chat, labels), day: first.day, messages };
}

function preferShown(left: Shown, right: Shown): number {
  return preferFact(left.fact, right.fact) ||
    compare(`${left.fact.source}\0${left.fact.key}`, `${right.fact.source}\0${right.fact.key}`);
}

function thingOf(networks: Networks, network: string, key: string, labels: Labels): string {
  const colon = key.indexOf(":");
  if (networks.of(network)?.keyed !== "chat") return `${network}\0${key}`;
  return `${network}\0${resolveChat(networks, network, key.slice(0, colon), labels)}\0${key.slice(colon + 1)}`;
}

function keysOf(networks: Networks, network: string, key: string, labels: Labels): string[] {
  const colon = key.indexOf(":");
  if (networks.of(network)?.keyed !== "chat" || colon < 0) return [key];
  const chat = key.slice(0, colon);
  const same = thingOf(networks, network, key, labels);
  return [chat, ...(labels.provider?.(chat)?.aliases ?? [])]
    .map((alias) => `${alias}${key.slice(colon)}`)
    .filter((each, index, all) => all.indexOf(each) === index && thingOf(networks, network, each, labels) === same);
}

function parentOf(message: Shown, things: ReadonlyMap<string, Shown>, input: DayInput, networks: Networks): Shown | undefined {
  const { reply_to } = message.fact;
  return reply_to === undefined ? undefined : things.get(thingOf(networks, message.network, reply_to, input.labels));
}

function body(message: Shown, parent: Shown | undefined, input: DayInput): Printable {
  const { fact } = message;
  const words: Printable[] = [];
  if (fact.forwarded === true) words.push("(forwarded)");
  if (fact.text !== undefined) words.push(fact.text);
  for (const part of fact.parts ?? []) words.push(partWords(part, input));
  if (fact.reply_to !== undefined) {
    const reacts = fact.parts?.some((part) => part.what.startsWith("reaction:")) === true;
    words.push(parent === undefined
      ? `(${reacts ? "to" : "reply to"} an earlier message)`
      : printed`(${reacts ? "to" : "reply to"} ${partyName(parent, input.labels)}, ${render(parent.fact.at, input.settings.zone, "minute", input.day)})`);
  }
  if (fact.edited === true) words.push("(edited)");
  return words.length === 0 ? "[empty message]" : joined(words, " ");
}

function partWords(part: Part, input: DayInput): string {
  const seconds = part.seconds === undefined ? "" : `, ${part.seconds} s`;
  if (part.lat !== undefined && part.lon !== undefined) {
    const place = input.labels.place(part.lat, part.lon)?.name;
    return `[${part.what}: ${place ?? `${part.lat.toFixed(5)}, ${part.lon.toFixed(5)}`}]`;
  }
  const row = part.blob === undefined || part.ask === undefined ? undefined : input.enrichments.get(part.blob);
  const described = row?.state === "done" ? row.content as Described : undefined;
  if (described !== undefined && "caption" in described) return `[${part.what}: ${described.caption}]`;
  if (described !== undefined && "transcript" in described) {
    const words = described.transcript.trim();
    return `[${part.what}${seconds}: ${words === "[no speech]" ? "no speech" : `"${words}"`}]`;
  }
  return `[${part.what}${seconds}]`;
}

function title(networks: Networks, network: string, chat: string, shown: readonly Shown[], labels: Labels): Printed {
  const writers = shown.filter((message) => message.network === network && message.chat === chat && message.fact.from.kind !== "system")
    .map((message) => partyName(message, labels));
  return chatName(networks, network, chat, labels, writers);
}

function partyName({ network, fact: { from } }: Shown, labels: Labels): Named {
  return nameId(from.id, labels, from.kind, network);
}


function chatDay(extract: ExtractRow): ChatDay {
  return extract.content as unknown as ChatDay;
}

function byTime(left: Fact, right: Fact): number {
  return left.at - right.at || compare(left.key, right.key) || compare(left.source, right.source);
}

function push<V>(map: Map<string, V[]>, key: string, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
