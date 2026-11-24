import {
  daysOf, digest, isObject,
  type Ask, type BlobReader, type DaySettings, type ExtractRow, type Json, type Recording, type Reply, type SourceRow, type Version, type View, type VoiceAdapter,
} from "@lifestreamprotocol/core";
import { linesOnly, type Change, type DayLine, type Extracted, type Family, type FamilyInput, type Given, type Plan, type Touched } from "../family.js";
import { statedPrompt } from "../shared/prompts.js";
import { dictationLines, dictationRead, dictationText, readDictation, type Dictating } from "./dictations.js";

export const VOICE_TRANSCRIPT = "voice-transcript";
export const VOICE_TRANSCRIPT_PROMPT = statedPrompt(new URL("./prompts/", import.meta.url), VOICE_TRANSCRIPT);
export const VOICE_FAMILY = "voice";
const SENT_MEDIA = new Set(["audio/mp4", "audio/x-m4a", "audio/mpeg", "audio/wav"]);

export interface RecordingContent extends Recording {
  ask: boolean;
}

const READERS: Readonly<Record<string, (value: Json) => string | null>> = {
  [VOICE_TRANSCRIPT]: (value) => (value as string).trim() === "" ? "transcript is empty" : null,
};

export function voiceFamily(given: readonly Given<VoiceAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each]));
  const dictating = new Map(given.flatMap((each): [string, Dictating][] => (each.adapter.dictation === undefined ? [] : [[each.product, { name: each.name, kind: each.adapter.kinds[0]! }]])));
  const recorders = given.filter((each) => each.adapter.recording !== undefined).map((each) => each.product);
  const read = (view: View, unit: string): { adapter: VoiceAdapter; record: { source: SourceRow; version: Version } | null } | null => {
    const slash = unit.indexOf("/");
    const source = slash < 0 ? undefined : view.source(unit.slice(0, slash));
    const adapter = source === undefined ? undefined : byProduct.get(source.product)?.adapter;
    if (adapter === undefined) return null;
    for (const kind of adapter.kinds) {
      const head = view.head({ source: source!.id, kind, key: unit.slice(slash + 1) });
      if (head !== undefined && head.version !== "gone") return { adapter, record: { source: source!, version: view.version(head.version) } };
    }
    return { adapter, record: null };
  };
  return {
    name: VOICE_FAMILY,
    type: "voice",
    code: "2",
    inputs: given.map((each): FamilyInput => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "evidence" })),
    prompts: { [VOICE_TRANSCRIPT]: VOICE_TRANSCRIPT_PROMPT },
    readers: READERS,
    ...(recorders.length === 0 ? {} : { works: { voice: { product: recorders } } }),

    touched(changes: readonly Change[]): Touched[] {
      return changes.flatMap((change): Touched[] => {
        return [{ unit: `${change.record.source}/${change.record.key}` }];
      });
    },

    extract(unit: string, view: View, files: BlobReader): Extracted | null {
      const found = read(view, unit);
      if (found === null) return null;
      const { adapter, record } = found;
      if (adapter.dictation !== undefined) {
        const dictation = record === null ? null : readDictation(record.source.product, adapter.dictation(record), record.version.time?.start_ms);
        return dictation === null ? null
          : { content: dictation as unknown as Json, start_ms: dictation.at_ms, end_ms: dictation.at_ms, reading: digest(dictation as unknown as Json) };
      }
      const recording_ = record === null || adapter.recording === undefined ? null : adapter.recording(record);
      if (recording_ === null) return null;
      const content: RecordingContent = { ...recording_, ask: SENT_MEDIA.has(recording_.media_type) && files.has(`sha256:${recording_.sha256}`) };
      return { content: content as unknown as Json, start_ms: content.started_ms, end_ms: content.ended_ms, reading: digest(content as unknown as Json) };
    },

    days(extract: ExtractRow, settings: DaySettings): string[] {
      if (!isRecording(extract)) return daysOf({ start_ms: extract.start_ms!, end_ms: extract.start_ms! + 1, precision: "ms" }, settings);
      const recording = recordingOf(extract);
      return daysOf({ start_ms: recording.started_ms, end_ms: recording.ended_ms, precision: "ms" }, settings);
    },

    items: voiceItems,

    plan(extract: ExtractRow, answered: ReadonlyMap<string, Reply>): Plan {
      if (!isRecording(extract)) return { asks: [] };
      const recording = recordingOf(extract);
      if (!recording.ask) return { asks: [] };
      const item = itemOf(recording);
      const reply = answered.get(item);
      if (reply === undefined) return { asks: [transcriptAsk(item, recording, extract.unit.slice(0, extract.unit.indexOf("/")))] };
      const refused = READERS[VOICE_TRANSCRIPT]!(reply.value);
      return refused !== null
        ? { asks: [], refusals: [{ item, reason: refused }] }
        : { asks: [], answers: [{ item, content: (reply.value as string).trim() }] };
    },

    day: linesOnly((input): DayLine[] => {
      const dictations = input.extracts.filter((extract) => !isRecording(extract));
      return [...input.extracts.filter(isRecording).map((extract): DayLine => {
        const recording = recordingOf(extract);
        const slash = extract.unit.indexOf("/");
        const source = extract.unit.slice(0, slash);
        const item = itemOf(recording);
        const enrichment = input.enrichments.get(item);
        const transcript = enrichment?.state === "done" && typeof enrichment.content === "string" ? enrichment.content : null;
        const place = recording.location === null ? undefined : input.labels.place(recording.location.latitude, recording.location.longitude)?.name;
        const facts = `Voice note, ${Math.round(recording.duration_seconds)} s${place === undefined ? "" : ` at ${place}`}`;
        const product = input.sources.get(source)?.product;
        const kind = (product === undefined ? undefined : byProduct.get(product)?.adapter.kinds[0]) ?? RECORDING_KIND;
        return {
          family: VOICE_FAMILY, unit: extract.unit, units: [extract.unit], start_ms: recording.started_ms, end_ms: recording.ended_ms,
          text: transcript === null ? facts : `${facts}: ${transcript}`,
          record: { source, kind, key: extract.unit.slice(slash + 1) }, item,
        };
      }), ...dictationLines(dictations, dictating)];
    }),

    text: {
      version: "1",
      kinds: [...new Set(given.flatMap((each) => (each.adapter.dictation === undefined ? [] : each.adapter.kinds)))].sort(),
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const adapter = source === undefined ? undefined : byProduct.get(source.product)?.adapter;
        return adapter?.dictation === undefined || !adapter.kinds.includes(record.kind) ? null : dictationText(adapter.dictation({ source: source!, version }));
      },
    },

    read: {
      of(record, version, _files, view) {
        const source = view.source(record.source);
        const adapter = source === undefined ? undefined : byProduct.get(source.product)?.adapter;
        return adapter?.dictation === undefined || !adapter.kinds.includes(record.kind) ? null : dictationRead(adapter.dictation({ source: source!, version }));
      },
    },
  };
}

const RECORDING_KIND = "voice";

export function voiceItems(extract: ExtractRow): { item: string; prompt: string }[] {
  if (!isRecording(extract)) return [];
  const recording = recordingOf(extract);
  return recording.ask ? [{ item: itemOf(recording), prompt: VOICE_TRANSCRIPT }] : [];
}

export function transcriptAsk(item: string, recording: RecordingContent, source: string): Ask {
  return {
    family: VOICE_FAMILY, item, prompt: VOICE_TRANSCRIPT,
    input: [{ text: `note ${recording.sha256}, ${recording.duration_seconds} s, ${recording.media_type}` }],
    attachments: [{ blob: `sha256:${recording.sha256}`, media_type: recording.media_type }], identity: `sha256:${recording.sha256}`,
    work: "voice", source,
  };
}

export function recordingAudioOf(extract: ExtractRow): { blob: string; seconds: number } | null {
  if (!isRecording(extract)) return null;
  const recording = recordingOf(extract);
  return recording.ask ? { blob: `sha256:${recording.sha256}`, seconds: Math.round(recording.duration_seconds) } : null;
}

export function isRecording(extract: ExtractRow): boolean {
  return isObject(extract.content) && typeof extract.content.sha256 === "string";
}

function recordingOf(extract: ExtractRow): RecordingContent {
  if (!isRecording(extract)) throw new TypeError(`voice extract ${extract.unit} is not a recording`);
  return extract.content as unknown as RecordingContent;
}

function itemOf(recording: { sha256: string }): string {
  return `voice:${recording.sha256}`;
}

