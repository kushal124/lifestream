import { type Drawn, type JsonObject, type Level, type Piece, type PlaceholderTable, type Quote } from "@lifestreamprotocol/core";
import type { Connector } from "@lifestreamprotocol/connect";
import type { Ledger, TablePart } from "@lifestreamprotocol/model";
import { levelOf, type Hider, type NamedLevel, type Text } from "@lifestreamprotocol/privacy";


export interface CopyAsked {
  op: "copy";
  key: string;
  revision: string;
  pieces: readonly Piece[];
  quoted?: { key: string; at: number };
  attachments: readonly { blob: string; media_type: string; drawn?: readonly Drawn[] }[];
  receiver: string;
  route: string;
  level: NamedLevel;
  epoch: number;
}

export type CopyAnswer = { copy: number } | { wait: string } | { cannot: string } | { error: string };

export const HIDING_META = "privacy.waiting";
export type HidingWaits = Partial<Record<Exclude<NamedLevel, "none">, string>>;

export function hidingWaits(hider: Pick<Hider, "ready">): HidingWaits {
  const waits: HidingWaits = {};
  for (const level of ["all", "names"] as const) {
    const ready = hider.ready(level);
    if (ready !== true) waits[level] = ready.wait;
  }
  return waits;
}

export function sentLevel(settings: Parameters<typeof levelOf>[0], connectors: readonly Pick<Connector, "id" | "processing">[], work_id: string | null): NamedLevel {
  return asIs(connectors, work_id) ? "none" : levelOf(settings, work_id);
}

export function asIs(connectors: readonly Pick<Connector, "id" | "processing">[], work_id: string | null): boolean {
  if (work_id === null) return false;
  const at = work_id.indexOf("/");
  return connectors.find((connector) => connector.id === work_id.slice(0, at))?.processing?.[work_id.slice(at + 1)]?.as_is === true;
}

export const AUDIO_LINE = "Audio cannot be hidden. Choose a model on this Mac, or send voice notes as they are.";

const ERASED = "Lifestream is erasing something you asked it to: hiding goes on once it is done";

const TRIES = 3;

export interface CopiesInputs {
  ledger: Ledger;
  hider: () => Hider;
  clock: () => number;
}

export interface Copies {
  make(asked: CopyAsked): Promise<CopyAnswer>;
}

export function openCopies(inputs: CopiesInputs): Copies {
  const { ledger } = inputs;
  return {
    async make(asked) {
      const base = { key: asked.key, receiver: asked.receiver, route: asked.route, level: asked.level as Level };
      const now = ledger.placeholders.epoch();
      if (now.erasing || now.epoch !== asked.epoch) return { wait: ERASED };
      if (asked.level === "none") {
        const made = ledger.sent.make({ ...base, body: null, pictures: [], counts: {}, detector: null }, inputs.clock(), asked.epoch);
        return "id" in made ? { copy: made.id } : { wait: ERASED };
      }
      if (asked.attachments.some((file) => file.media_type.startsWith("audio/"))) return { cannot: AUDIO_LINE };
      const written = asked.quoted === undefined ? undefined : ledger.sent.written(asked.quoted.key, asked.receiver, asked.level);
      const pieces: (Piece | Quote)[] = asked.pieces.map((piece, index) => (written !== undefined && index === asked.quoted!.at ? { text: written, quote: true } : piece));
      const texts: Text[] = [pieces, ...asked.attachments.map((file) => ({ picture: file.blob, ...(file.drawn === undefined ? {} : { faces: file.drawn }) }))];
      const scope = `ask:${asked.revision}`;
      for (let tried = 0; tried < TRIES; tried++) {
        let read: TablePart | undefined;
        const part = (wanted: Parameters<Ledger["placeholders"]["part"]>[1]): PlaceholderTable => (read = ledger.placeholders.part(scope, wanted)).table;
        const answer = await inputs.hider().hide(texts, asked.level, part);
        if ("wait" in answer) return answer;
        const cannot = answer.texts.find((text): text is { cannot: string } => typeof text === "object" && "cannot" in text);
        if (cannot !== undefined) return { cannot: cannot.cannot };
        const [body, ...pictures] = answer.texts as [string, ...{ jpeg: Uint8Array; recipe: object }[]];
        const made = ledger.sent.make({ ...base, body, pictures: pictures.map((picture) => ({ jpeg: picture.jpeg, recipe: picture.recipe as JsonObject })), counts: answer.counts, detector: answer.detector },
          inputs.clock(), asked.epoch, read === undefined ? undefined : { read, answered: answer.table });
        if ("id" in made) return { copy: made.id };
        if (!("stale" in made)) return { wait: ERASED };
      }
      return { wait: "The request's placeholders were written by another call: it is hidden again" };
    },
  };
}
