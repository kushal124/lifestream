import { createHash } from "node:crypto";
import { isObject, type Guard, type Json, type JsonObject } from "@lifestreamprotocol/connect/sdk";
import { exact, ownerConnector, type Pictures, type StatementKind } from "../../shared/statements.js";

const CHAT = /^[0-9]{13}-[0-9a-f]{6}$/u;
const MSG = /^([0-9]{13}-[0-9a-f]{6}):([0-9]{4})$/u;
const TITLE_MAX = 200;
const N_MAX = 9_999;
const ENDS = ["done", "stopped", "failed"];
const QUESTION = ["type", "chat", "n", "at_ms", "role", "text"];
const ATTACHED = ["photos", "voice"];
const ANSWERED = ["seen", "refs", "steps", "access", "model", "thinking", "ms", "thought_ms", "end", "error", "failed"];
const SEEN_ENDS = ["done", "stopped"];
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const FAILURES = ["login", "door", "model", "restart"];
const BLOB = /^sha256:[0-9a-f]{64}$/u;
export const PHOTOS_MAX = 10;
export const VOICE_MS_MAX = 600_000;
export const WAV_HEADER = 44;
const SAMPLE_RATE = 16_000;
const VOICE_MEDIA = "audio/wav";
const SEEN_MEDIA = "image/jpeg";
const HEIF_BRANDS = ["heic", "heix", "heim", "heis", "hevc", "mif1", "msf1"];
export const PHOTO_HEAD = 12;

const chat: Guard = (content) => {
  if (!exact(content, ["type", "title", "at_ms"]) || content.type !== "ask.chat") return ["content must hold exactly type ask.chat, title and at_ms"];
  const out = madeAt(content.at_ms);
  if (typeof content.title !== "string" || content.title.length === 0 || content.title.length > TITLE_MAX) out.push(`title must be 1 to ${TITLE_MAX} characters`);
  return out;
};

const msg: Guard = (content) => {
  if (!isObject(content) || content.type !== "ask.msg") return ["content must hold type ask.msg"];
  const question = content.role === "user";
  if (!question && content.role !== "assistant") return ["role must be user or assistant"];
  if (!exact(content, QUESTION, question ? ATTACHED : ANSWERED)) {
    return [`a question holds exactly ${QUESTION.join(", ")}, and may hold ${ATTACHED.join(" and ")}; an answer may also hold ${ANSWERED.join(", ")}`];
  }
  const out = madeAt(content.at_ms);
  const has = (member: string) => Object.hasOwn(content, member);
  if (typeof content.chat !== "string" || !CHAT.test(content.chat)) out.push("chat must be a conversation's id, <13 digits>-<6 hex>");
  if (!Number.isSafeInteger(content.n) || (content.n as number) < 1 || (content.n as number) > N_MAX) out.push(`n must be 1 to ${N_MAX}`);
  const spoken = has("voice");
  if (typeof content.text !== "string") out.push("text must be a string");
  else if (question && spoken && content.text !== "") out.push("a voice note's question has no typed words: its text is \"\"");
  else if (question && !spoken && content.text.trim() === "") out.push("a question's text must hold words");
  if (has("photos") && !(Array.isArray(content.photos) && content.photos.length >= 1 && content.photos.length <= PHOTOS_MAX && content.photos.every((photo) => typeof photo === "string" && BLOB.test(photo))
    && new Set(content.photos).size === content.photos.length)) {
    out.push(`photos must be 1 to ${PHOTOS_MAX} distinct blobs, sha256:<64 hex>`);
  }
  if (spoken && !(exact(content.voice, ["audio", "ms"]) && typeof content.voice.audio === "string" && BLOB.test(content.voice.audio)
    && Number.isSafeInteger(content.voice.ms) && (content.voice.ms as number) >= 1 && (content.voice.ms as number) <= VOICE_MS_MAX)) {
    out.push(`voice must be {audio, ms}: audio a blob, sha256:<64 hex>, ms 1 to ${VOICE_MS_MAX}`);
  }
  if (has("refs") && !(isObject(content.refs) && Object.entries(content.refs).every(([handle, cited]) => HANDLE(handle) && isCited(cited)))) {
    out.push("refs must map each handle r<n> to the door's citation of its ref (packages/home/search-contract.ts `citation`), as the door made it, or to {ref} alone");
  }
  if (has("seen") && !(isSeen(content.seen, content.text) && SEEN_ENDS.includes(content.end as string))) {
    out.push(`seen must be {asked, answered, spoken?, photos?} on a done or stopped answer: asked and answered sorted lists of spans with whole-number offsets, each {start, end, placeholder} or a zero-width {start, end, added} (answered: placeholders only, within the answer's text), spoken a string, photos 1 to ${PHOTOS_MAX} entries each a blob, sha256:<64 hex>, or null`);
  }
  if (has("steps") && !(Array.isArray(content.steps) && content.steps.every((step) => exact(step, ["name", "words", "ms"], ["error", "line"]) && words(step.name) && words(step.words) && isMs(step.ms)
    && (!Object.hasOwn(step, "error") || words(step.error)) && (!Object.hasOwn(step, "line") || words(step.line))))) {
    out.push("steps must be a list of {name, words, ms, error?, line?}");
  }
  if (has("access") && !(Array.isArray(content.access) && content.access.length >= 1 && content.access.every(isAccessChange))) {
    out.push("access must be a list of the door's changes of an access, each {id, kind: narrowed, reader, words (text or bold runs), undo: {access, expect}}, {id, kind: unchanged, reader, words} or {id, kind: asked, snapshot}");
  }
  if (has("model") && !words(content.model)) out.push("model must be a model's id");
  if (has("thinking") && !THINKING.includes(content.thinking as string)) out.push(`thinking must be ${THINKING.join(", ")}`);
  if (has("ms") && !isMs(content.ms)) out.push("ms must be a whole number of milliseconds");
  if (has("thought_ms") && !isMs(content.thought_ms)) out.push("thought_ms must be a whole number of milliseconds");
  if (has("end") && !ENDS.includes(content.end as string)) out.push(`end must be ${ENDS.join(", ")}`);
  if (has("error") && (!words(content.error) || content.end !== "failed")) out.push("error must say what failed, on a failed answer only");
  if (has("failed") && (!FAILURES.includes(content.failed as string) || content.end !== "failed")) out.push(`failed must be ${FAILURES.join(", ")}, on a failed answer only`);
  return out;
};

const KINDS: Readonly<Record<string, StatementKind>> = {
  chat: { guard: chat, time: "at_ms", key: (key) => (CHAT.test(key) ? undefined : `${JSON.stringify(key)} is not a conversation's id, <13 digits>-<6 hex>`) },
  msg: {
    guard: msg,
    time: "at_ms",
    blobs: (content) => filesOf(content),
    picture: (content, pictures) => fileFault(content, pictures),
    key: (key, content) => {
      const parts = MSG.exec(key);
      if (parts === null || parts[2] === "0000") return `${JSON.stringify(key)} is not a message's key, <chat>:<n from 0001>`;
      return content === null || (isObject(content) && content.chat === parts[1] && content.n === Number(parts[2])) ? undefined : "its key must be <its chat>:<its n, four digits>";
    },
  },
};

export const askHome = ownerConnector("ask-home", KINDS);

type Rule = (value: Json | undefined) => boolean;
type Members = readonly [required: Readonly<Record<string, Rule>>, optional?: Readonly<Record<string, Rule>>];

const text = (pattern?: RegExp): Rule => (value) => typeof value === "string" && (pattern === undefined || pattern.test(value));
const oneOf = (...values: string[]): Rule => (value) => typeof value === "string" && values.includes(value);
const WORDS = text();
const REF = text(/^\S/u);
const HANDLE = text(/^r\d+$/u);
const DAY = text(/^\d{4}-\d{2}-\d{2}$/u);
const INSTANT = text(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/u);
const FOCUS = text(/^(?:rec:\S+ \S+ \S.*|u:\S.*)$/su);
const COUNT: Rule = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const SPAN: Rule = (value) => fits(value, [{ from_ms: COUNT, to_ms: COUNT }]);
const PERSON: Rule = (value) => value === null || REF(value);
const OPENS: Rule = (value) => fits(value, [{ page: oneOf("days"), day: DAY }, { focus: FOCUS, span: SPAN }])
  || fits(value, [{ page: oneOf("people", "places"), id: WORDS }, { person: PERSON, group: REF }]) || fits(value, [{ page: oneOf("read") }]);

const THING = { ref: REF, opens: OPENS };
const PLACED = { day: DAY, at: INSTANT, title: WORDS, chat: REF, chat_title: WORDS };
const NAMED = { ref: REF, name: WORDS, opens: OPENS };
const VOICE: Rule = (value) => fits(value, [{ audio: WORDS, record: REF }, { seconds: COUNT, from: WORDS, mine: (mine) => mine === true }]);
const VOICED = { ...PLACED, voice: VOICE };
const CITATION: Readonly<Record<string, Members>> = {
  record: [THING, VOICED],
  message: [THING, VOICED],
  turn: [THING, PLACED],
  line: [THING, VOICED],
  photo: [{ ...THING, image: WORDS }, PLACED],
  window: [{ ...THING, day: DAY, app: WORDS, title: WORDS }, { at: INSTANT }],
  row: [{ ref: REF, asked: WORDS, n: COUNT, opens: OPENS }],
  person: [NAMED],
  chat: [NAMED],
  place: [NAMED],
  gone: [{ ref: REF, why: WORDS }],
};
const ALONE: Members = [{ ref: REF }];

function isCited(cited: Json): boolean {
  if (!isObject(cited)) return false;
  if (!Object.hasOwn(cited, "kind")) return fits(cited, ALONE);
  const kind = cited.kind;
  if (typeof kind !== "string" || !Object.hasOwn(CITATION, kind)) return false;
  const [required, optional] = CITATION[kind]!;
  return fits(cited, [{ ...required, kind: oneOf(kind) }, optional ?? {}]);
}

function fits(value: Json | undefined, [required, optional = {}]: Members): boolean {
  if (!isObject(value)) return false;
  const may = (name: string) => Object.hasOwn(required, name) || Object.hasOwn(optional, name);
  return Object.keys(value).every(may)
    && Object.entries(required).every(([name, rule]) => Object.hasOwn(value, name) && rule(value[name]))
    && Object.entries(optional).every(([name, rule]) => !Object.hasOwn(value, name) || rule(value[name]));
}

function filesOf(content: JsonObject): Record<string, string | null> {
  const photos = Array.isArray(content.photos) ? (content.photos as string[]) : [];
  const voice = isObject(content.voice) ? content.voice : undefined;
  return {
    ...Object.fromEntries(photos.map((photo) => [photo, null])), ...Object.fromEntries(seenPhotos(content).map((photo) => [photo, SEEN_MEDIA])),
    ...(voice === undefined ? {} : { [voice.audio as string]: VOICE_MEDIA }),
  };
}

function seenPhotos(content: JsonObject): string[] {
  const photos = isObject(content.seen) && Array.isArray(content.seen.photos) ? content.seen.photos : [];
  return photos.filter((photo): photo is string => typeof photo === "string");
}

function fileFault(content: JsonObject, pictures: Pictures): string | undefined {
  const photos = Array.isArray(content.photos) ? (content.photos as string[]) : [];
  const voice = isObject(content.voice) ? (content.voice as { audio: string; ms: number }) : undefined;
  for (const photo of photos) {
    const read = readable(photo, pictures);
    if (typeof read === "string") return `its photo ${photo} ${read}`;
    if (read !== null && !isPhoto(read.head(PHOTO_HEAD))) return `its photo ${photo} is no JPEG, PNG, HEIC or WebP`;
  }
  for (const photo of seenPhotos(content)) {
    const read = readable(photo, pictures);
    if (typeof read === "string") return `the picture the model saw ${photo} ${read}`;
  }
  if (voice === undefined) return undefined;
  const read = readable(voice.audio, pictures);
  if (typeof read === "string") return `its voice note ${voice.audio} ${read}`;
  return read === null ? undefined : wavFault(read.size, read.head(WAV_HEADER), voice.ms);
}

function readable(blob: string, pictures: Pictures): { size: number; head(length: number): Buffer } | null | string {
  const carried = pictures.carried(blob);
  if (carried !== undefined) {
    const bytes = carried.bytes();
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== blob) return "is carried under another hash than its bytes'";
    return { size: carried.size, head: (length) => bytes.subarray(0, length) };
  }
  const staged = pictures.staged?.(blob);
  if (staged !== undefined) return staged;
  return pictures.held(blob) ? null : "is neither carried by the bundle, staged by the door, nor held by the home";
}

export function isPhoto(head: Buffer): boolean {
  const ascii = (at: number, length: number) => head.subarray(at, at + length).toString("latin1");
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true;
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
  if (head.length >= 12 && ascii(4, 4) === "ftyp" && HEIF_BRANDS.includes(ascii(8, 4))) return true;
  return head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
}

export function wavHeader(data: number): Buffer {
  const header = Buffer.alloc(WAV_HEADER);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(data + WAV_HEADER - 8, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data, 40);
  return header;
}

function wavFault(size: number, head: Buffer, ms: number): string | undefined {
  const data = size - WAV_HEADER;
  if (data <= 0 || data % 2 !== 0 || !head.equals(wavHeader(data))) return "its voice note is no WAV of 16 kHz mono 16-bit PCM with the canonical 44-byte header";
  const length = voiceMs(data / 2);
  return length === ms ? undefined : `its voice note's samples last ${length} ms, not its ms ${ms}`;
}

export function voiceMs(samples: number): number {
  return Math.ceil((samples * 1_000) / SAMPLE_RATE);
}

function isSeen(seen: Json | undefined, text: Json | undefined): boolean {
  if (!exact(seen, ["asked", "answered"], ["spoken", "photos"]) || typeof text !== "string") return false;
  return isSpans(seen.asked, true) && isSpans(seen.answered, false, text.length)
    && (!Object.hasOwn(seen, "spoken") || typeof seen.spoken === "string")
    && (!Object.hasOwn(seen, "photos") || (Array.isArray(seen.photos) && seen.photos.length >= 1 && seen.photos.length <= PHOTOS_MAX
      && seen.photos.every((photo) => photo === null || (typeof photo === "string" && BLOB.test(photo)))));
}

function isSpans(spans: Json | undefined, added: boolean, within = Number.MAX_SAFE_INTEGER): boolean {
  if (!Array.isArray(spans)) return false;
  let from = 0;
  return spans.every((span) => {
    const placed = exact(span, ["start", "end", "placeholder"]) && words(span.placeholder);
    const said = added && exact(span, ["start", "end", "added"]) && typeof span.added === "string" && span.added !== "" && span.start === span.end;
    if (!(placed || said) || !isMs(span.start) || !isMs(span.end) || (span.start as number) < from || (span.end as number) < (span.start as number) || (span.end as number) > within) return false;
    from = span.end as number;
    return true;
  });
}

function isAccessChange(change: Json): boolean {
  if (!isObject(change) || !words(change.id)) return false;
  if (change.kind === "narrowed") return exact(change, ["id", "kind", "reader", "words", "undo"]) && words(change.reader) && (words(change.words) || bolded(change.words)) && exact(change.undo, ["access", "expect"]) && isObject(change.undo.access) && isMs(change.undo.expect);
  if (change.kind === "unchanged") return exact(change, ["id", "kind", "reader", "words"]) && words(change.reader) && words(change.words);
  return change.kind === "asked" && exact(change, ["id", "kind", "snapshot"]) && isObject(change.snapshot) && change.snapshot.id === change.id;
}

function madeAt(value: Json | undefined): string[] {
  return isMs(value) && (value as number) > 0 ? [] : ["at_ms must be ms since the epoch"];
}

function bolded(value: Json | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  const runs = value.filter((run) => exact(run, ["text"], ["bold"]) && typeof run.text === "string" && (run.bold === undefined || run.bold === true)) as JsonObject[];
  return runs.length === value.length && words(runs.map((run) => run.text as string).join(""));
}

function words(value: Json | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

function isMs(value: Json | undefined): boolean {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
