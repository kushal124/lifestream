import { mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { ensureArtifact, removeArtifact } from "@lifestreamprotocol/model";
import { decodeAudio } from "./audio.js";
import type { SpeechRow } from "./files.js";
import { Failed, type Library } from "./library.js";
import { checkedLoad, oneModel } from "./one-model.js";


export interface Transcriber {
  transcribe(samples: Float32Array, options: { signal: AbortSignal }): Promise<{ text: string; aborted?: boolean }>;
  dispose(): void;
}

export type Load = (path: string) => Promise<Transcriber>;

const loadTranscribeCpp: Load = async (path) => (await import("transcribe-cpp")).TranscribeModel.load(path);

export function speechLibrary(folder: string, load: Load = loadTranscribeCpp): Library {
  const fileOf = (row: SpeechRow): string => join(folder, basename(new URL(row.source.url).pathname));
  const scratch = join(folder, "scratch");
  rmSync(scratch, { recursive: true, force: true });
  const models = oneModel<SpeechRow, Transcriber>((row) => checkedLoad(row.id, [{ path: fileOf(row), artifact: row.source }], () => load(fileOf(row))));

  return {
    async fetch(row, progress, signal) {
      mkdirSync(folder, { recursive: true });
      await ensureArtifact((row as SpeechRow).source, fileOf(row as SpeechRow), { signal, progress });
    },
    async remove(row, signal) {
      await models.letGo(row as SpeechRow, signal);
      await removeArtifact(fileOf(row as SpeechRow), signal);
    },
    async run(row, call, signal) {
      if (call.warm === true) {
        return models.use(row as SpeechRow, signal, async (model) => {
          await model();
          return { text: "", model: row.id };
        });
      }
      const note = call.attachments.find((attachment) => attachment.media_type.startsWith("audio/"));
      if (note === undefined) throw new Failed("unreadable", `${row.id} transcribes a voice note, and the call carries none`);
      return models.use(row as SpeechRow, signal, async (model) => {
        mkdirSync(scratch, { recursive: true });
        const samples = await decodeAudio(note.media_type, Buffer.from(note.base64, "base64"), scratch, signal);
        const heard = await (await model()).transcribe(samples, { signal });
        if (heard.aborted === true || signal.aborted) throw signal.reason ?? new Error("the transcript was stopped");
        return { text: heard.text.trim(), model: row.id };
      });
    },
    close: () => models.close(),
  };
}
