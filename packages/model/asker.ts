import { digest, piecesText, spelledOf, statedIn, wordMarks, type Ask, type BlobReader, type Drawn, type Json, type Mark, type Piece, type Prompt, type Reply } from "@lifestreamprotocol/core";
import { readAnswer } from "./answer-types.js";
import { inputHash, requestKey, retryIdentity, type Sampling } from "./digest.js";
import type { Ledger, LedgerAttachment, NewRequest, StoredReply } from "./ledger.js";
import { extensionOf } from "./transport.js";


export type RoutedAsk = Ask & { model: string; effort: string; sampling?: Sampling; line?: "chat" };

export interface Candidate {
  reply: Reply;
}

export type Answer = Candidate | { waits: string } | null;

export type AskState =
  | Candidate
  | { waits: string }
  | { pending: Pending }
  | { failed: string; retry_ms: number }
  | { givenUp: true; tries: number };

export type Pending = "unasked" | "queued";

export interface Sending {
  send: string;
  pieces: readonly Piece[];
  quoted?: { key: string; at: number };
  faces?: readonly Drawn[];
}

export interface By {
  model: string;
}

export interface Known {
  prompt: string;
  version: number;
  input_hash: string;
}

export interface Asker {
  known(ask: Ask): Known;
  key(ask: RoutedAsk): string;
  answer(ask: Ask, by?: By): Answer;
  state(ask: RoutedAsk, by?: By): AskState;
  request(ask: RoutedAsk, by?: By): Sending | AskState;
  refuse(ask: Ask, candidate: Candidate, reason: string): void;
  accept(reply: Reply): void;
  refused(): string[];
}

export interface AskerOptions {
  ledger: Ledger;
  prompt(name: string): Prompt;
  blobs: BlobReader;
  draw?: (photo: string, faces: Drawn[]) => Buffer;
  clock?: () => number;
}

export function openAsker(options: AskerOptions): Asker {
  const { ledger } = options;
  const clock = options.clock ?? Date.now;
  const draw: NonNullable<AskerOptions["draw"]> = options.draw ?? ((photo) => {
    throw new Error(`no draw is given: ${photo} cannot be sent drawn`);
  });

  const fingerprint = (ask: Ask): string => {
    const input = piecesText(ask.input);
    return inputHash(input, askIdentity(ask, input));
  };
  let refusedNow: string[] = [];

  const keyOf = (ask: RoutedAsk, version: number, input_hash: string): string => requestKey({
    model: ask.model, prompt: ask.prompt, version, input_hash, effort: ask.effort, sampling: ask.sampling ?? null,
  });

  const readOf = (ask: Ask, prompt: Prompt, reply: StoredReply): Candidate | undefined => {
    const read = readAnswer(prompt, reply.version!, reply.text);
    if ("value" in read) {
      const marks = keptMarks(ask.input, reply);
      const faces = drawnOf(ask) === undefined ? [] : facesOf(ledger.row(reply.key)?.revision ?? reply.key);
      return { reply: {
        key: reply.key, model: reply.model, text: reply.text, value: read.value, version: reply.version!, at_ms: reply.created_ms,
        ...(marks.length === 0 ? {} : { marks }), ...(faces.length === 0 ? {} : { faces }),
      } };
    }
    if (reply.version === prompt.version) {
      ledger.refuse(reply.key, { family: ask.family, unit: ask.item }, read.violations.join("\n"), clock());
      refusedNow.push(reply.key);
    }
    return undefined;
  };

  const newest = (ask: Ask, prompt: Prompt, input_hash: string, by?: By): Candidate | undefined => {
    const versions = [prompt.version, ...prompt.keeps.map((kept) => kept.version)];
    for (const reply of ledger.found(ask.prompt, input_hash, versions, by?.model)) {
      const found = readOf(ask, prompt, reply);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const facesOf = (revision: string): Drawn[] => ledger.placeholders.faces(`ask:${revision}`);

  const answer = (ask: Ask, by?: By): Answer => {
    const prompt = options.prompt(ask.prompt);
    const input_hash = fingerprint(ask);
    const found = newest(ask, prompt, input_hash, by);
    if (found !== undefined) return found;
    const waits = ledger.flying(ask.prompt, [prompt.version, ...prompt.keeps.map((kept) => kept.version)], input_hash);
    return waits === undefined ? null : { waits };
  };

  const state = (ask: RoutedAsk, by?: By): AskState => {
    const answered = answer(ask, by);
    if (answered !== null) return answered;
    const prompt = options.prompt(ask.prompt);
    const root = keyOf(ask, prompt.version, fingerprint(ask));
    const next = ledger.next(root, clock(), ask.line);
    if ("answered" in next) return readOf(ask, prompt, ledger.standing(next.answered)!) ?? state(ask, by);
    if ("givenUp" in next) return { givenUp: true, tries: next.givenUp };
    if ("wait" in next) return next.wait.why === "failed" ? { failed: next.wait.error, retry_ms: next.wait.retry_ms } : { waits: root };
    return { pending: next.send === null ? "unasked" : "queued" };
  };

  const attachments = (ask: Ask, faces: readonly Drawn[]): LedgerAttachment[] => (ask.attachments ?? []).map((file) => {
    const kind = file.media_type.startsWith("image/") ? "image" : file.media_type.startsWith("audio/") ? "audio" : undefined;
    if (kind === undefined) throw new TypeError(`an attachment is an image or audio, not ${file.media_type}`);
    const extension = extensionOf(file.media_type);
    if (file.drawn !== undefined) return { kind, sha256: ledger.keep(draw(file.blob, [...faces])), extension };
    const sha256 = ledger.keep(options.blobs.bytes(file.blob));
    if (`sha256:${sha256}` !== file.blob) throw new Error(`blob ${file.blob} read back as sha256:${sha256}`);
    return { kind, sha256, extension };
  });

  const newRequest = (ask: RoutedAsk, prompt: Prompt, revision: string, key: string, input_hash: string, text: string, faces: readonly Drawn[]): NewRequest => ({
    key, family: ask.family, unit: ask.item, revision, model: ask.model, effort: ask.effort,
    ...(ask.sampling === undefined ? {} : { sampling: ask.sampling }),
    prompt: { name: ask.prompt, version: prompt.version, text: prompt.text, type: prompt.type },
    input_hash, body: text, attachments: attachments(ask, faces),
  });

  const sending = (ask: Ask, root: string, key: string, chain: readonly { key: string }[]): Sending => {
    const { body, prompt_hash } = ledger.row(key)!;
    const text = ledger.text(prompt_hash) ?? "";
    const original: Piece[] = [{ text }, ...ask.input];
    const written: Piece[] = body.startsWith(text) ? [{ text }, { text: body.slice(text.length), free: true }] : [{ text: body, free: true }];
    if (key === root) return { send: key, pieces: piecesText(original) === body ? original : written };
    const link = chain.length > 1 ? chain.at(-2)!.key : root;
    const answer = ledger.reply(link) ?? { text: "", marks: [], unknown: [] };
    const head = piecesText(retryPieces(original, answer, "").slice(0, -2));
    if (!body.startsWith(head) || !body.endsWith(RETRY_TAIL) || body.length < head.length + RETRY_TAIL.length) return { send: key, pieces: written };
    const retry = retryPieces(original, answer, body.slice(head.length, body.length - RETRY_TAIL.length));
    return { send: key, pieces: retry, quoted: { key: link, at: ANSWER_AT(original) } };
  };

  return {
    known: (ask) => ({ prompt: ask.prompt, version: options.prompt(ask.prompt).version, input_hash: fingerprint(ask) }),
    key: (ask) => keyOf(ask, options.prompt(ask.prompt).version, fingerprint(ask)),
    answer,
    state,

    request(ask, by) {
      const now = state(ask, by);
      if (!("pending" in now)) return now;
      const prompt = options.prompt(ask.prompt);
      const input_hash = fingerprint(ask);
      const root = keyOf(ask, prompt.version, input_hash);
      const chain = ledger.chain(root);
      const current = chain.at(-1) ?? ledger.row(root);
      const drawn = drawnOf(ask);
      if (now.pending === "queued") return { ...sending(ask, root, current!.key, chain), ...(drawn === undefined ? {} : { faces: facesOf(root) }) };
      const original: Piece[] = [{ text: prompt.text }, ...ask.input];
      const link = current?.key ?? (ledger.reply(root)?.validation === "refused" ? root : undefined);
      const starts = current === undefined;
      const faces = drawn === undefined ? [] : starts ? drawn : facesOf(root);
      const write = (request: NewRequest) => ledger.request(starts && faces.length > 0 ? { ...request, faces } : request, clock());
      const drew = drawn === undefined ? {} : { faces };
      if (link === undefined) {
        write(newRequest(ask, prompt, root, root, input_hash, piecesText(original), faces));
        return { send: root, pieces: original, ...drew };
      }
      const refused = ledger.reply(link)!;
      const retry = retryPieces(original, refused, ledger.lastFailure(root)!);
      const identity = retryIdentity(refused.input_hash, refused.text);
      const key = keyOf(ask, prompt.version, identity);
      write(newRequest(ask, prompt, root, key, identity, piecesText(retry), faces));
      return { send: key, pieces: retry, quoted: { key: link, at: ANSWER_AT(original) }, ...drew };
    },

    refuse(ask, { reply }, reason) {
      ledger.refuse(reply.key, { family: ask.family, unit: ask.item }, reason, clock());
    },

    accept(reply) {
      ledger.accept(reply.key, clock());
    },

    refused() {
      const drained = refusedNow;
      refusedNow = [];
      return drained;
    },
  };
}

function drawnOf(ask: Ask): readonly Drawn[] | undefined {
  return ask.attachments?.find((file) => file.drawn !== undefined)?.drawn;
}

export function askIdentity(ask: Ask, input: string): Json | undefined {
  if (ask.identity !== undefined || ask.attachments === undefined || ask.attachments.length === 0) return ask.identity;
  return { input: digest(input), attachments: ask.attachments.map((file) => (file.drawn === undefined ? file.blob : { blob: file.blob, drawn: file.drawn })) };
}

const RETRY_TAIL = "\n\nAnswer the request above again, correcting every problem named.";

const ANSWER_AT = (original: readonly Piece[]): number => original.length + 1;

function retryPieces(original: readonly Piece[], answer: Pick<StoredReply, "text" | "marks" | "unknown">, reason: string): Piece[] {
  const known = keptMarks(original, answer);
  const named = wordMarks(reason, spelledOf(answer.text, known));
  return [
    ...original,
    { text: "\n\n----\n\nYour previous answer to this request was refused. Your previous answer:\n\n" },
    { text: answer.text, free: true, ...(known.length === 0 ? {} : { known }) },
    { text: "\n\n----\n\nWhy it was refused:\n" },
    answer.unknown.length > 0 ? { text: reason } : { text: reason, free: true, ...(named.length === 0 ? {} : { known: named }) },
    { text: RETRY_TAIL },
  ];
}

function keptMarks(pieces: readonly Piece[], reply: Pick<StoredReply, "text" | "marks">): Mark[] {
  const stated = wordMarks(reply.text, statedIn(pieces)).filter((mark) => !reply.marks.some((kept) => mark.start < kept.end && kept.start < mark.end));
  return [...reply.marks, ...stated].sort((left, right) => left.start - right.start);
}
