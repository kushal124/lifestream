import { gunzipSync } from "node:zlib";
import type { JsonObject } from "@lifestreamprotocol/connect/sdk";

export type NoteBodyRefusal = "not-gzip" | "bad-gzip" | "too-large" | "malformed" | "no-text" | "bad-utf8";

export type NoteBodyResult = { text: string } | { refused: NoteBodyRefusal; detail: string };

export const BODY_CAP_BYTES = 4 * 1024 * 1024;

const OBJECT_REPLACEMENT = /￼/gu;
const MARKER = /^\s*(?:\[[x ]\]|-|\d+\.)(?: |$)/u;
const CHECKLIST = 103;
const NUMBERED = 102;
const BULLETS = new Set([100, 101]);

export function readNoteBody(bytes: Uint8Array, attachments: readonly JsonObject[]): NoteBodyResult {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return { refused: "not-gzip", detail: "the body does not start with gzip's magic" };
  let plain: Buffer;
  try {
    plain = gunzipSync(bytes, { maxOutputLength: BODY_CAP_BYTES });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ERR_BUFFER_TOO_LARGE") return { refused: "too-large", detail: `the body inflates past ${BODY_CAP_BYTES} bytes` };
    return { refused: "bad-gzip", detail: error instanceof Error ? error.message : String(error) };
  }
  try {
    const note = fields(only(fields(only(fields(plain), 2, "document")), 3, "note"));
    const stated = only(note, 2, "text");
    const runs = note.filter((field) => field.number === 5).map((field) => readRun(field));
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stated);
    } catch {
      return { refused: "bad-utf8", detail: "the note's text is not UTF-8" };
    }
    return { text: render(text, runs, attachments).trimEnd() };
  } catch (error) {
    if (error instanceof Missing) return { refused: "no-text", detail: error.message };
    return { refused: "malformed", detail: error instanceof Error ? error.message : String(error) };
  }
}

interface Run {
  length: number;
  style: number | null;
  indent: number;
  done: boolean;
  attachment: { id: string; uti: string } | null;
}

function readRun(field: Field): Run {
  const run: Run = { length: 0, style: null, indent: 0, done: false, attachment: null };
  for (const member of fields(bytesOf(field))) {
    if (member.number === 1) run.length = numberOf(member);
    else if (member.number === 2) {
      for (const paragraph of fields(bytesOf(member))) {
        if (paragraph.number === 1) run.style = numberOf(paragraph);
        else if (paragraph.number === 4) run.indent = numberOf(paragraph);
        else if (paragraph.number === 5) run.done = fields(bytesOf(paragraph)).some((check) => check.number === 2 && numberOf(check) === 1);
      }
    } else if (member.number === 12) {
      const info = fields(bytesOf(member));
      const text = (number: number) => {
        const found = info.find((item) => item.number === number);
        return found === undefined ? "" : new TextDecoder().decode(bytesOf(found));
      };
      run.attachment = { id: text(1), uti: text(2) };
    }
  }
  return run;
}

function render(text: string, runs: readonly Run[], attachments: readonly JsonObject[]): string {
  let index = 0;
  let start = 0;
  const runAt = (at: number): Run | null => {
    while (index < runs.length && start + runs[index]!.length <= at) start += runs[index++]!.length;
    return index < runs.length ? runs[index]! : null;
  };
  const byId = new Map(attachments.filter((row) => typeof row.ZIDENTIFIER === "string").map((row) => [row.ZIDENTIFIER as string, row]));
  const out: string[] = [];
  const counts: number[] = [];
  let at = 0;
  for (const paragraph of text.split("\n")) {
    const run = runAt(at);
    const style = run?.style ?? null;
    const indent = Math.max(0, Math.min(run?.indent ?? 0, 16));
    let marker = "";
    if (style === NUMBERED) {
      counts.length = indent + 1;
      counts[indent] = (counts[indent] ?? 0) + 1;
      marker = `${counts[indent]}. `;
    } else if (style === CHECKLIST || (style !== null && BULLETS.has(style))) {
      counts.length = Math.min(counts.length, indent);
      marker = style === CHECKLIST ? (run!.done ? "[x] " : "[ ] ") : "- ";
    } else counts.length = 0;
    const words = paragraph.replace(OBJECT_REPLACEMENT, (_, offset: number) => attachmentWords(runAt(at + offset)?.attachment ?? null, byId));
    out.push((marker === "" ? "" : "  ".repeat(indent) + marker) + words);
    at += paragraph.length + 1;
  }
  return out.join("\n");
}

export function unmarked(line: string): string {
  return line.replace(MARKER, "").trim();
}

function attachmentWords(attachment: { id: string; uti: string } | null, byId: ReadonlyMap<string, JsonObject>): string {
  if (attachment === null) return "[attachment]";
  const row = byId.get(attachment.id);
  const kind = kindOf(stated(row?.ZTYPEUTI) ?? attachment.uti);
  const detail = stated(kind === "link" ? row?.ZURLSTRING : row?.ZTITLE);
  return detail === null ? `[${kind}]` : `[${kind}: ${detail}]`;
}

export function stated(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const KINDS: [string, (uti: string) => boolean][] = [
  ["image", (uti) => ["public.jpeg", "public.png", "public.heic", "public.heif", "public.tiff", "public.image", "com.compuserve.gif", "org.webmproject.webp"].includes(uti)],
  ["drawing", (uti) => uti.startsWith("com.apple.drawing") || uti.startsWith("com.apple.paper") || uti.startsWith("com.apple.notes.sketch")],
  ["scan", (uti) => uti === "com.apple.notes.gallery"],
  ["video", (uti) => ["com.apple.quicktime-movie", "public.mpeg-4", "public.movie", "public.video"].includes(uti)],
  ["audio", (uti) => ["public.audio", "com.apple.m4a-audio", "public.mp3", "com.microsoft.waveform-audio", "com.apple.coreaudio-format"].includes(uti)],
  ["link", (uti) => uti === "public.url"],
  ["table", (uti) => uti === "com.apple.notes.table"],
  ["PDF", (uti) => uti === "com.adobe.pdf"],
  ["tag", (uti) => uti === "com.apple.notes.inlinetextattachment.hashtag"],
  ["mention", (uti) => uti === "com.apple.notes.inlinetextattachment.mention"],
];

function kindOf(uti: string): string {
  return KINDS.find(([, test]) => test(uti))?.[0] ?? "attachment";
}


interface Field {
  number: number;
  wire: number;
  value: number | Uint8Array;
}

class Missing extends Error {}

function fields(bytes: Uint8Array): Field[] {
  const out: Field[] = [];
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (let count = 0; count < 10; count++) {
      if (at >= bytes.length) throw new Error(`a varint runs past the end at ${at}`);
      const byte = bytes[at++]!;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (!Number.isSafeInteger(value)) throw new Error(`a varint past 2^53 at ${at}`);
        return value;
      }
      scale *= 0x80;
    }
    throw new Error(`a varint longer than ten bytes at ${at}`);
  };
  while (at < bytes.length) {
    const key = varint();
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (number === 0) throw new Error(`field number 0 at ${at}`);
    if (wire === 0) out.push({ number, wire, value: varint() });
    else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (at + size > bytes.length) throw new Error(`a fixed field runs past the end at ${at}`);
      out.push({ number, wire, value: bytes.subarray(at, at + size) });
      at += size;
    } else if (wire === 2) {
      const length = varint();
      if (at + length > bytes.length) throw new Error(`a field of ${length} bytes runs past the end at ${at}`);
      out.push({ number, wire, value: bytes.subarray(at, at + length) });
      at += length;
    } else throw new Error(`wire type ${wire} at ${at}`);
  }
  return out;
}

function only(list: readonly Field[], number: number, what: string): Uint8Array {
  const found = list.find((field) => field.number === number && field.wire === 2);
  if (found === undefined) throw new Missing(`the body holds no ${what} (field ${number})`);
  return found.value as Uint8Array;
}

function bytesOf(field: Field): Uint8Array {
  if (field.wire !== 2) throw new Error(`field ${field.number} is wire type ${field.wire}, not bytes`);
  return field.value as Uint8Array;
}

function numberOf(field: Field): number {
  if (field.wire !== 0) throw new Error(`field ${field.number} is wire type ${field.wire}, not a number`);
  return field.value as number;
}
