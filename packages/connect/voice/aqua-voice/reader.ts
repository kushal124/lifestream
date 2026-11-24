import { blobIndex, blobRef, carriesNothing, each, fingerprint, instant, isObject, readJson, refuse, sourceName, TimeError, utf8, type Guard, type Instant, type JsonObject, type Reader } from "@lifestreamprotocol/connect/sdk";

export const DICTATION = "dictation";
export const HISTORY_FILE = "history.json";
export const AUDIO_INDEX_FILE = "audio.json";
const VERSION = 1;

const dictation: Guard = (content) => {
  if (!isObject(content) || Object.keys(content).sort().join() !== "audio,dictation,type") return ["members must be exactly type, dictation, audio"];
  const problems: string[] = [];
  if (content.type !== "aqua-voice.dictation") problems.push("type must be aqua-voice.dictation");
  const entry = content.dictation;
  if (!isObject(entry)) return [...problems, "dictation must be the entry Aqua states"];
  if (entry.sessionId !== null && entry.sessionId !== undefined && !(typeof entry.sessionId === "number" && Number.isSafeInteger(entry.sessionId))) problems.push("sessionId must be an integer or null");
  const time = timeOf(entry);
  if (typeof time === "string") problems.push(time);
  for (const member of ["content", "rawText", "audioFilePath"]) {
    if (entry[member] !== undefined && entry[member] !== null && typeof entry[member] !== "string") problems.push(`${member} must be text or null`);
  }
  if (content.audio !== null && !blobRef(content.audio)) problems.push("audio must be the recording's hash and bytes, or null");
  return problems;
};

export const aquaVoice: Reader = {
  name: "aqua-voice-mac",
  kinds: { [DICTATION]: dictation },
  async *read(delivery, files) {
    if (carriesNothing(delivery)) return;
    const history = delivery.files.find((entry) => entry.path === HISTORY_FILE);
    if (history === undefined) refuse(`the delivery carries no ${HISTORY_FILE}`);
    const indexFile = delivery.files.find((entry) => entry.path === AUDIO_INDEX_FILE);
    const index = indexFile === undefined ? new Map<string, { blob: string; size: number }>() : blobIndex(files.bytes(indexFile.blob));
    const { account, copy: device } = sourceName(delivery.source);
    yield* each([history], (file) => file.path, async function* (file) {
      const value = readJson(utf8(files.bytes(file.blob), HISTORY_FILE), HISTORY_FILE);
      if (!isObject(value) || value.version !== VERSION) refuse(`${HISTORY_FILE} must state version ${VERSION}`);
      const users = value.historyByUserId;
      if (!isObject(users)) refuse(`${HISTORY_FILE} must state historyByUserId as an object`);
      const entries = users[account];
      if (entries === undefined) return;
      if (!Array.isArray(entries)) refuse(`${HISTORY_FILE} historyByUserId.${account} must be a list`);
      const locator = (at: number) => `${HISTORY_FILE} historyByUserId.${account}[${at}]`;
      yield* each(entries.entries(), ([at]) => locator(at), ([at, entry]) => {
        if (!isObject(entry)) refuse(`${locator(at)} is not an object`);
        const path = entry.audioFilePath;
        const held = typeof path === "string" ? index.get(path) : undefined;
        const audio = held === undefined ? null : { hash: held.blob, bytes: held.size };
        const time = timeOf(entry);
        return [{
          kind: DICTATION,
          key: keyOf(entry),
          content: { type: "aqua-voice.dictation", dictation: entry, audio },
          ...(typeof time === "string" || time === undefined ? {} : { time }),
          ...(audio === null ? {} : { blobs: [audio.hash] }),
          device,
          locator: locator(at),
        }];
      });
    });
  },
};

function keyOf(entry: JsonObject): string {
  if (typeof entry.sessionId === "number" && Number.isSafeInteger(entry.sessionId)) return String(entry.sessionId);
  const fields: JsonObject = {};
  for (const member of ["timestamp", "audioFilePath"]) {
    const value = entry[member];
    if (value !== null && value !== undefined) fields[member] = value;
  }
  return fingerprint(fields);
}

function timeOf(entry: JsonObject): Instant | string | undefined {
  const stated = entry.timestamp;
  if (stated === undefined || stated === null) return undefined;
  if (typeof stated !== "string") return "timestamp must be an RFC 3339 instant";
  try {
    return instant(stated, "rfc3339");
  } catch (error) {
    if (error instanceof TimeError) return `timestamp ${JSON.stringify(stated)}: ${error.message}`;
    throw error;
  }
}
