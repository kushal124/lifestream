import type { DetailType, Mark, Piece } from "@lifestreamprotocol/core";

export type Sayable = string | number | Piece | readonly Piece[];

export function free(text: string, whole?: string, known?: readonly Mark[]): Piece {
  if (whole !== undefined && !whole.startsWith(text)) throw new TypeError("a free piece's whole begins with its text");
  return {
    text, free: true,
    ...(whole === undefined || whole.length === text.length ? {} : { whole }),
    ...(known === undefined || known.length === 0 ? {} : { known }),
  };
}

export function detail(text: string, is: DetailType, who?: string): Piece {
  return { text, is, ...(who === undefined ? {} : { who }) };
}

export function said(strings: TemplateStringsArray, ...parts: readonly Sayable[]): Piece[] {
  const out: Piece[] = [];
  put(out, strings[0]!);
  parts.forEach((part, index) => {
    put(out, part);
    put(out, strings[index + 1]!);
  });
  return out;
}

export function sayJoined(parts: readonly Sayable[], separator: string): Piece[] {
  const out: Piece[] = [];
  parts.forEach((part, index) => {
    if (index > 0) put(out, separator);
    put(out, part);
  });
  return out;
}

function put(out: Piece[], part: Sayable): void {
  if (typeof part === "string" || typeof part === "number") return own(out, String(part));
  if (isPieces(part)) {
    for (const piece of part) put(out, piece);
    return;
  }
  if (!("free" in part) && !("is" in part)) return own(out, part.text);
  if (part.text !== "") out.push(part);
}

function own(out: Piece[], text: string): void {
  if (text === "") return;
  const last = out.at(-1);
  if (last !== undefined && !("free" in last) && !("is" in last)) out[out.length - 1] = { text: last.text + text };
  else out.push({ text });
}

function isPieces(part: Piece | readonly Piece[]): part is readonly Piece[] {
  return Array.isArray(part);
}
