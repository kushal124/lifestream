import { isUtf8 } from "node:buffer";
import { refuse } from "./refused.js";

const BEGIN = Buffer.from("BEGIN:VCARD");
const END = Buffer.from("END:VCARD");

/** One vCard cut out of a file, from its `BEGIN:VCARD` line through its `END:VCARD` line. */
export interface SlicedCard {
  /** The byte offset in the file where the card begins. */
  start: number;
  /** The byte offset in the file just past the card's last line. */
  end: number;
  /** The card's bytes, which are UTF-8. */
  bytes: Buffer;
}

/** How many vCards a file holds, refusing a file whose cards are not whole and apart. */
export function cardCount(bytes: Buffer, where: string): number {
  const slicer = new Slicer(where);
  let count = 0;
  for (let start = 0; start < bytes.length; ) {
    const lf = bytes.indexOf(0x0a, start);
    const end = lf === -1 ? bytes.length : lf + 1;
    if (slicer.line(bytes.subarray(start, end)) !== undefined) count++;
    start = end;
  }
  slicer.end();
  return count;
}

/** The vCards a file holds, cut from its chunks as they stream, refusing a card that is not UTF-8 and a file whose cards are not whole and apart. */
export async function* streamCards(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, where: string): AsyncGenerator<SlicedCard> {
  const slicer = new Slicer(where);
  let rest: Buffer[] = [];
  for await (const chunk of chunks) {
    let from = 0;
    for (let lf = chunk.indexOf(0x0a, from); lf !== -1; lf = chunk.indexOf(0x0a, from)) {
      const piece = chunk.subarray(from, lf + 1);
      const card = slicer.line(rest.length === 0 ? piece : Buffer.concat([...rest, piece]));
      rest = [];
      from = lf + 1;
      if (card !== undefined) yield card;
    }
    if (from < chunk.length) rest.push(chunk.subarray(from));
  }
  if (rest.length > 0) {
    const card = slicer.line(Buffer.concat(rest));
    if (card !== undefined) yield card;
  }
  slicer.end();
}

class Slicer {
  #at = 0;
  #open: number | undefined;
  #lines: Buffer[] = [];
  readonly where: string;

  constructor(where: string) {
    this.where = where;
  }

  line(bytes: Buffer): SlicedCard | undefined {
    const start = this.#at;
    this.#at += bytes.length;
    const lf = bytes.length > 0 && bytes[bytes.length - 1] === 0x0a;
    const contentEnd = !lf ? bytes.length : bytes.length > 1 && bytes[bytes.length - 2] === 0x0d ? bytes.length - 2 : bytes.length - 1;
    const content = bytes.subarray(0, contentEnd);
    if (content.equals(BEGIN)) {
      if (this.#open !== undefined) refuse(`${this.where}: a card begins inside a card at byte ${start}`);
      this.#open = start;
      this.#lines = [bytes];
      return undefined;
    }
    if (content.equals(END)) {
      if (this.#open === undefined) refuse(`${this.where}: END:VCARD outside a card at byte ${start}`);
      this.#lines.push(bytes);
      const card = Buffer.concat(this.#lines);
      if (!isUtf8(card)) refuse(`${this.where}: the vCard is not UTF-8`);
      const sliced = { start: this.#open, end: this.#at, bytes: card };
      this.#open = undefined;
      this.#lines = [];
      return sliced;
    }
    if (this.#open !== undefined) this.#lines.push(bytes);
    else if (bytes.some((byte) => byte !== 0x20 && (byte < 0x09 || byte > 0x0d))) refuse(`${this.where}: bytes outside a card at byte ${start}`);
    return undefined;
  }

  end(): void {
    if (this.#open !== undefined) refuse(`${this.where}: the card at byte ${this.#open} never ends`);
  }
}
