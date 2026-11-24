import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { BODY_CAP_BYTES, readNoteBody } from "./body.js";

type Field = [number, number | Uint8Array | string | Field[]];

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function message(fields: readonly Field[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [number, value] of fields) {
    if (typeof value === "number") {
      parts.push(Uint8Array.from([...varint(number * 8), ...varint(value)]));
      continue;
    }
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : message(value);
    parts.push(Uint8Array.from([...varint(number * 8 + 2), ...varint(bytes.length)]), bytes);
  }
  return Buffer.concat(parts);
}

interface Run { length: number; style?: number; indent?: number; done?: 0 | 1; attachment?: { id: string; uti: string } }

function runOf(run: Run): Field[] {
  const paragraph: Field[] = [];
  if (run.style !== undefined) paragraph.push([1, run.style]);
  if (run.indent !== undefined) paragraph.push([4, run.indent]);
  if (run.done !== undefined) paragraph.push([5, [[1, new Uint8Array(16)], [2, run.done]]]);
  const fields: Field[] = [[1, run.length]];
  if (paragraph.length > 0) fields.push([2, paragraph]);
  fields.push([13, 7]);
  if (run.attachment !== undefined) fields.push([12, [[1, run.attachment.id], [2, run.attachment.uti]]]);
  return fields;
}

function noteProto(text: string, runs: readonly Run[]): Uint8Array {
  const note: Field[] = [[2, text], [3, [[1, [[1, 1], [2, 1]]], [2, 4]]], [4, [[1, new Uint8Array(16)]]], ...runs.map((run): Field => [5, runOf(run)])];
  return message([[1, 0], [2, [[1, 0], [2, 0], [3, note]]]]);
}

function body(text: string, runs: readonly Run[] = [{ length: text.length }]): Uint8Array {
  return gzipSync(noteProto(text, runs));
}

const GROCERIES_TEXT = "Groceries\n😀 fake list\nsynthetic milk\nsynthetic eggs\nsynthetic bread\n";
const GROCERIES = body(GROCERIES_TEXT, [
  { length: 10, style: 0 },
  { length: 13 },
  { length: 15, style: 103, done: 1 },
  { length: 15, style: 103, done: 0 },
  { length: 16, style: 103, done: 0 },
]);

const PLAN_TEXT = "Plan\nfirst synthetic step\nsecond synthetic step\nnested bullet\nthird synthetic step\n";
const PLAN = body(PLAN_TEXT, [
  { length: 5, style: 0 },
  { length: 21, style: 102 },
  { length: 22, style: 102 },
  { length: 14, style: 101, indent: 1 },
  { length: 21, style: 102 },
]);

const SKETCH_TEXT = "Sketches\nsee ￼ and ￼\nalso ￼\n￼";
const SKETCH = body(SKETCH_TEXT, [
  { length: 9, style: 0 },
  { length: 4 }, { length: 1, attachment: { id: "ATT-IMAGE-1", uti: "public.png" } }, { length: 5 },
  { length: 1, attachment: { id: "ATT-DRAW-1", uti: "com.apple.drawing.2" } }, { length: 6 },
  { length: 1, attachment: { id: "ATT-LINK-1", uti: "public.url" } }, { length: 1 },
  { length: 1, attachment: { id: "ATT-ODD-1", uti: "com.example.synthetic" } },
]);
const SKETCH_ATTACHMENTS = [
  { id: "ATT-IMAGE-1", uti: "public.png" },
  { id: "ATT-DRAW-1", uti: "com.apple.drawing.2" },
  { id: "ATT-LINK-1", uti: "public.url", url: "https://example.com/synthetic" },
  { id: "ATT-ODD-1", uti: "com.example.synthetic", title: "synthetic file.bin" },
];

function textOf(spec: Uint8Array): string | null {
  const read = readNoteBody(spec, []);
  return "text" in read ? read.text : null;
}

describe("the Notes body: what must be impossible", () => {
  it("a body is read as text when it is not one, or one that inflates past the cap is read whole", () => {
    expect(readNoteBody(Uint8Array.from([0x9e, 0x11, 0x42, 0x07]), [])).toMatchObject({ refused: "not-gzip" });
    expect(readNoteBody(GROCERIES.subarray(0, GROCERIES.length - 9), [])).toMatchObject({ refused: "bad-gzip" });
    expect(readNoteBody(gzipSync(Uint8Array.from([0x0a, 0xff, 0xff])), [])).toMatchObject({ refused: "malformed" });
    expect(readNoteBody(gzipSync(message([[1, 0], [2, [[1, 0]]]])), [])).toMatchObject({ refused: "no-text" });
    const badUtf8 = message([[1, 0], [2, [[1, 0], [3, [[2, Uint8Array.from([0xc3, 0x28])]]]]]]);
    expect(readNoteBody(gzipSync(badUtf8), [])).toMatchObject({ refused: "bad-utf8" });
    const bomb = gzipSync(noteProto("a".repeat(BODY_CAP_BYTES + 1), [{ length: BODY_CAP_BYTES + 1 }]));
    expect(bomb.length).toBeLessThan(BODY_CAP_BYTES / 100);
    expect(readNoteBody(bomb, [])).toMatchObject({ refused: "too-large" });
  });

  it("a style lands on the wrong paragraph, a checklist's state or a list's count is lost, or runs that miss the text lose it", () => {
    expect(textOf(GROCERIES)).toBe("Groceries\n😀 fake list\n[x] synthetic milk\n[ ] synthetic eggs\n[ ] synthetic bread");
    expect(textOf(PLAN)).toBe("Plan\n1. first synthetic step\n2. second synthetic step\n  - nested bullet\n3. third synthetic step");
    expect(textOf(body("Short\nrest of the synthetic text", [{ length: 6, style: 0 }]))).toBe("Short\nrest of the synthetic text");
    expect(textOf(body("Over", [{ length: 400, style: 103, done: 1 }]))).toBe("[x] Over");
    expect(textOf(body("\uFEFFTitle\nmilk ￼", [{ length: 7 }, { length: 5, style: 103, done: 0 }, { length: 1, style: 103, attachment: { id: "ATT-IMAGE-1", uti: "public.png" } }]))).toBe("\uFEFFTitle\n[ ] milk [image]");
  });

  it("an attachment prints as U+FFFC or by its identifier, or a link loses its address", () => {
    const read = readNoteBody(SKETCH, SKETCH_ATTACHMENTS.map((attachment) => ({ ZIDENTIFIER: attachment.id, ZTYPEUTI: attachment.uti, ZURLSTRING: attachment.url ?? null, ZTITLE: attachment.title ?? null })));
    expect(read).toEqual({ text: "Sketches\nsee [image] and [drawing]\nalso [link: https://example.com/synthetic]\n[attachment: synthetic file.bin]" });
    expect(textOf(SKETCH)).toBe("Sketches\nsee [image] and [drawing]\nalso [link]\n[attachment]");
    expect(textOf(body("lone ￼"))).toBe("lone [attachment]");
    expect(JSON.stringify(read)).not.toMatch(/ATT-|￼/u);
  });
});
