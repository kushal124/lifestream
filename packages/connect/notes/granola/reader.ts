import { carriesNothing, each, instantOf, isObject, readJson, refuse, sourceName, spanOf, utf8, type Guard, type Instant, type Json, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { API_FORMAT, holdsMeetings, MCP_FORMAT, meetingSources, PULL_MANIFEST, readMeeting, rpcAnswer, toolText, type Media } from "./answers.js";

const HEX = /^[0-9a-f]{64}$/u;
const UUID_URL = /^https:\/\/notes\.granola\.ai\/d\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const OWN = new Set(["type", "meeting"]);

const noteGuard: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  if (content.type === "granola.note") return isObject(content.note) && typeof content.note.id === "string" ? [] : ["content.note must be an object stating id"];
  if (content.type === "granola.mcp-note") return isObject(content.meeting) && typeof content.meeting.id === "string" ? [] : ["content.meeting must be an object stating id"];
  return ["type must be granola.note or granola.mcp-note"];
};

const transcriptGuard: Guard = (content) => {
  if (!isObject(content) || content.type !== "granola.transcript") return ["type must be granola.transcript"];
  return typeof content.note === "string" && Array.isArray(content.transcript) && content.transcript.length > 0 ? [] : ["content must state its note and a transcript of one line or more"];
};

export const granola: Reader = {
  name: "granola",
  kinds: { note: noteGuard, transcript: transcriptGuard },
  async *read(delivery, files) {
    const { product, account, copy } = sourceName(delivery.source);
    if (product !== "granola" || copy !== "cloud") refuse(`${delivery.source} is not a granola:<email>:cloud source`);
    if (carriesNothing(delivery)) return;
    const byPath = new Map(delivery.files.map((file) => [file.path, file]));
    const manifestFile = byPath.get(PULL_MANIFEST) ?? refuse(`a Granola pull holds ${PULL_MANIFEST}`);
    const manifest = object(json(files.bytes(manifestFile.blob), PULL_MANIFEST), PULL_MANIFEST);
    if (manifest.complete !== true || (manifest.format !== API_FORMAT && manifest.format !== MCP_FORMAT)) refuse(`${PULL_MANIFEST} is no complete Granola pull`);
    if (manifest.account !== account) refuse(`the pull states account ${JSON.stringify(manifest.account ?? null)}, not the source's ${JSON.stringify(account)}`);
    const named = new Set([PULL_MANIFEST]);
    const held = (entry: JsonObject, where: string): { bytes: Buffer; blob: string; file: string } => {
      const file = typeof entry.file === "string" ? entry.file : refuse(`${where} names no file`);
      const delivered = byPath.get(file) ?? refuse(`${where}: the pull lists ${file}, which the delivery does not hold`);
      if (typeof entry.sha256 !== "string" || !HEX.test(entry.sha256) || delivered.blob !== `sha256:${entry.sha256}` || delivered.size !== entry.bytes) refuse(`${file} does not match the hash and size the pull states`);
      return { bytes: files.bytes(delivered.blob), blob: delivered.blob, file };
    };
    if (manifest.format === API_FORMAT) {
      const notes = Array.isArray(manifest.notes) ? manifest.notes.filter(isObject) : refuse(`${PULL_MANIFEST} lists no notes`);
      for (const note of notes) for (const entry of [note, ...list(note.transcript), ...list(note.attachments)]) if (typeof entry.file === "string") named.add(entry.file);
      for (const path of byPath.keys()) if (!named.has(path)) refuse(`${path} is in the delivery but not in ${PULL_MANIFEST}`);
      yield* each(notes, (note, index) => (typeof note.file === "string" ? note.file : `${PULL_MANIFEST} notes[${index}]`), (note) => apiRows(note, held));
      return;
    }
    const answers = Array.isArray(manifest.answers) ? manifest.answers.filter(isObject) : refuse(`${PULL_MANIFEST} lists no answers`);
    for (const answer of answers) if (typeof answer.file === "string") named.add(answer.file);
    for (const path of byPath.keys()) if (!named.has(path)) refuse(`${path} is in the delivery but not in ${PULL_MANIFEST}`);
    yield* each(answers, (answer, index) => (typeof answer.file === "string" ? answer.file : `${PULL_MANIFEST} answers[${index}]`), (answer) => mcpRows(answer, held));
  },
};

type Held = (entry: JsonObject, where: string) => { bytes: Buffer; blob: string; file: string };

function* apiRows(entry: JsonObject, held: Held): Generator<ReaderOutput> {
  const { bytes, file } = held(entry, "a note");
  const stated = object(json(bytes, file), file);
  const id = typeof stated.id === "string" && stated.id !== "" ? stated.id : refuse(`${file} states no id`);
  const key = keyOf(stated, id);
  if (stated.deleted_at !== null && stated.deleted_at !== undefined) {
    yield { kind: "note", key, content: null, gone: true, locator: file };
    yield { kind: "transcript", key, content: null, gone: true, locator: file };
    return;
  }
  const pages = list(entry.transcript);
  const lines: Json[] = pages.length === 0
    ? (Array.isArray(stated.transcript) ? stated.transcript : [])
    : pages.flatMap((page, index) => {
      const read = held(page, `${file}'s transcript page ${index + 1}`);
      const body = object(json(read.bytes, read.file), read.file);
      return Array.isArray(body.transcript) ? body.transcript : refuse(`${read.file} states no transcript`);
    });
  const fetched = new Map(list(entry.attachments).map((attachment) => [attachment.id, attachment]));
  const blobs: string[] = [];
  const attachments = (Array.isArray(stated.attachments) ? stated.attachments : []).map((value, index) => {
    const attachment = object(value, `${file} attachments[${index}]`);
    const sealed = fetched.get(attachment.id ?? null) ?? refuse(`${file}: attachment ${JSON.stringify(attachment.id ?? null)} was not fetched`);
    const { blob } = held(sealed, `${file}'s attachment ${String(attachment.id)}`);
    if (Object.hasOwn(attachment, "hash")) refuse(`${file}: attachment ${String(attachment.id)} states a hash of its own`);
    if (!blobs.includes(blob)) blobs.push(blob);
    return { ...without(attachment, "url"), hash: blob };
  });
  const note: JsonObject = { ...without(stated, "transcript"), ...(Array.isArray(stated.attachments) ? { attachments } : {}) };
  const span = lines.length > 0 ? transcriptSpan(lines, file) : undefined;
  yield { kind: "note", key, content: { type: "granola.note", note }, time: span ?? noteTime(stated, file), ...(blobs.length === 0 ? {} : { blobs }), locator: file };
  if (span !== undefined) yield { kind: "transcript", key, content: { type: "granola.transcript", note: id, transcript: lines }, time: span, locator: file };
}

function keyOf(note: JsonObject, id: string): string {
  const url = typeof note.web_url === "string" ? UUID_URL.exec(note.web_url) : null;
  return url === null ? id : url[1]!.toLowerCase();
}

function transcriptSpan(lines: readonly Json[], file: string): Instant {
  const first = object(lines[0]!, `${file} transcript[0]`);
  const last = object(lines.at(-1)!, `${file} transcript[${lines.length - 1}]`);
  return spanOf(time(first.start_time, `${file} transcript[0].start_time`), time(last.end_time, `${file} transcript[${lines.length - 1}].end_time`), `${file} transcript`);
}

function noteTime(note: JsonObject, file: string): Instant {
  const event = isObject(note.calendar_event) ? note.calendar_event : undefined;
  if (event !== undefined && typeof event.scheduled_start_time === "string" && typeof event.scheduled_end_time === "string") {
    return spanOf(time(event.scheduled_start_time, `${file} scheduled_start_time`), time(event.scheduled_end_time, `${file} scheduled_end_time`), `${file} calendar_event`);
  }
  return time(note.created_at, `${file} created_at`);
}

async function* mcpRows(entry: JsonObject, held: Held): AsyncGenerator<ReaderOutput> {
  if (entry.tool !== "get_meetings") return;
  const { bytes, file } = held(entry, "an answer");
  const media: Media = entry.media === "sse" ? "sse" : entry.media === "json" ? "json" : refuse(`${file}: the pull states no media`);
  const rpc = typeof entry.rpc === "number" ? entry.rpc : refuse(`${file}: the pull states no request id`);
  const answer = toolText(rpcAnswer(utf8(bytes, file), media, rpc, file), file);
  if (answer.error) return;
  if (!holdsMeetings(answer.text)) refuse(`${file} holds no meetings_data`);
  yield* each(meetingSources(answer.text), (_source, index) => `${file}[${index}]`, (source) => [meetingRow(source, file)]);
}

function meetingRow(source: string, file: string): ReaderOutput {
  const element = readMeeting(source, file);
  const meeting = element.attributes;
  const id = meeting.id !== undefined && UUID.test(meeting.id) ? meeting.id.toLowerCase() : refuse(`${file}: a meeting states no id`);
  const at = meeting.meeting_at ?? refuse(`${file}: meeting ${id} states no meeting_at`);
  const content: JsonObject = { type: "granola.mcp-note", meeting };
  for (const child of element.children) {
    if (OWN.has(child.name) || Object.hasOwn(content, child.name)) refuse(`${file}: meeting ${id} states <${child.name}> where the content has its own, or twice`);
    if (Object.hasOwn(child.attributes, "text")) refuse(`${file}: meeting ${id}'s <${child.name}> states an attribute named text`);
    content[child.name] = { ...child.attributes, ...(child.text === null ? {} : { text: child.text }) };
  }
  return { kind: "note", key: id, content, time: time(at, `${file} meeting ${id} meeting_at`), locator: `${file} ${id}` };
}

function time(value: Json | undefined, where: string): Instant {
  if (typeof value !== "string") refuse(`${where} is not a time`);
  return instantOf(value, "rfc3339", where);
}

function without(object: JsonObject, member: string): JsonObject {
  return Object.fromEntries(Object.entries(object).filter(([name]) => name !== member));
}

function list(value: Json | undefined): JsonObject[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function object(value: Json, where: string): JsonObject {
  if (!isObject(value)) refuse(`${where} is not an object`);
  return value;
}

function json(bytes: Buffer, where: string): Json {
  return readJson(utf8(bytes, where), where);
}
