import { refuse } from "./refused.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

export class LineSplitter {
  private pending: Buffer[] = [];

  push(chunk: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const piece = chunk.subarray(start, newline);
      out.push(this.pending.length === 0 ? piece : Buffer.concat([...this.pending, piece]));
      this.pending = [];
      start = newline + 1;
    }
    if (start < chunk.length) this.pending.push(Buffer.from(chunk.subarray(start)));
    return out;
  }

  end(): Buffer | undefined {
    if (this.pending.length === 0) return undefined;
    const last = Buffer.concat(this.pending);
    this.pending = [];
    return last;
  }
}

export async function* lines(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): AsyncGenerator<Buffer> {
  const splitter = new LineSplitter();
  for await (const chunk of chunks) yield* splitter.push(chunk);
  const last = splitter.end();
  if (last !== undefined) yield last;
}

/** Decodes a line as UTF-8, refusing it, named by the place given, when it is not UTF-8. */
export function lineText(bytes: Buffer, where: string): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return refuse(`${where} is not UTF-8`);
  }
}
