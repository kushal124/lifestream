import type { ExtractRow, RecordRef } from "@lifestreamprotocol/core";
import { MESSAGES_FAMILY, recordingAudioOf, VOICE_FAMILY, voiceNoteOf, type ChatDay } from "@lifestreamprotocol/families";
import { makeRef } from "./refs.js";
import type { Voice } from "./search-contract.js";

interface Heard {
  blob: string;
  seconds?: number;
  mine: boolean;
}

const HEARD = new Map<string, (extract: ExtractRow, record: RecordRef) => Heard | undefined>([
  [MESSAGES_FAMILY, (extract, record) => {
    const message = (extract.content as unknown as ChatDay).messages.find((each) => each.source === record.source && each.key === record.key);
    const note = message === undefined ? null : voiceNoteOf(message);
    return note === null ? undefined : { ...note, mine: message!.from.kind === "me" };
  }],
  [VOICE_FAMILY, (extract) => {
    const audio = recordingAudioOf(extract);
    return audio === null ? undefined : { ...audio, mine: true };
  }],
]);

export function voiced(family: string): boolean {
  return HEARD.has(family);
}

export function voiceOf(extract: ExtractRow, record: RecordRef, speaker: () => string | undefined): Voice | undefined {
  const heard = HEARD.get(extract.family)?.(extract, record);
  if (heard === undefined) return undefined;
  const from = heard.mine ? undefined : speaker();
  return {
    audio: heard.blob, record: makeRef("record", record),
    ...(heard.seconds === undefined ? {} : { seconds: heard.seconds }),
    ...(heard.mine ? { mine: true as const } : {}), ...(from === undefined ? {} : { from }),
  };
}
