
export type TypedstreamRefusal =
  | "bad-header" | "truncated" | "bad-integer" | "bad-reference" | "unknown-shape" | "bad-utf8" | "no-text";

export type TypedstreamResult = { text: string } | { refused: TypedstreamRefusal; offset: number; detail: string };

export function decodeAttributedBody(bytes: Uint8Array): TypedstreamResult {
  try {
    return { text: new Reader(bytes).decode() };
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.reason, offset: error.offset, detail: error.message };
    return { refused: "unknown-shape", offset: 0, detail: error instanceof Error ? error.message : String(error) };
  }
}

const INTEGER_2 = -127;
const INTEGER_4 = -126;
const FLOATING = -125;
const NEW = -124;
const NIL = -123;
const END_OBJECT = -122;
const FIRST_TAG = -128;
const LAST_TAG = -111;
const FIRST_REFERENCE = -110;
const MAX_DEPTH = 64;

class Refusal extends Error {
  constructor(readonly reason: TypedstreamRefusal, readonly offset: number, message: string) {
    super(message);
  }
}

type Entry = { kind: "object" } | { kind: "cstring" } | { kind: "class"; chain: string[] };

class Reader {
  #at = 0;
  readonly #shared: Uint8Array[] = [];
  readonly #entries: Entry[] = [];
  #text: string | undefined;

  constructor(private readonly bytes: Uint8Array) {}

  decode(): string {
    if (this.byte() !== 4 || this.byte() !== 11) throw new Refusal("bad-header", 0, "expected version 4 and an 11-byte signature");
    if (ascii(this.take(11)) !== "streamtyped") throw new Refusal("bad-header", 2, "expected the streamtyped signature");
    if (this.integer(false) !== 1000) this.refuse("unknown-shape", "system version is not 1000");
    if (encodings(this.shared(), this.#at).join() !== "@") this.refuse("unknown-shape", "the root is not one object");
    const classes = this.object(0);
    if (this.#at !== this.bytes.byteLength) this.refuse("unknown-shape", "values after the root object");
    if (!classes.includes("NSAttributedString") && !classes.includes("NSMutableAttributedString")) {
      this.refuse("unknown-shape", "the root is not an attributed string");
    }
    if (this.#text === undefined) this.refuse("no-text", "the attributed string has no string value");
    return this.#text;
  }

  private object(depth: number): string[] {
    if (depth > MAX_DEPTH) this.refuse("unknown-shape", `objects nest deeper than ${MAX_DEPTH}`);
    const at = this.#at;
    const head = this.head();
    if (head === NIL) this.refuse("unknown-shape", "nil where an object was required");
    if (head !== NEW) {
      this.reference(head, at, this.#entries.length);
      return [];
    }
    this.#entries.push({ kind: "object" });
    const classes = this.classChain();
    const isString = classes.includes("NSString") || classes.includes("NSMutableString");
    for (;;) {
      const groupAt = this.#at;
      const next = this.head();
      if (next === END_OBJECT) return classes;
      for (const encoding of encodings(this.shared(next), groupAt)) this.value(encoding, depth + 1, isString);
    }
  }

  private classChain(): string[] {
    const slots: number[] = [];
    const names: string[] = [];
    let head = this.head();
    while (head === NEW) {
      slots.push(this.#entries.length);
      this.#entries.push({ kind: "class", chain: [] });
      const at = this.#at;
      const name = ascii(this.shared());
      if (name === null) throw new Refusal("unknown-shape", at, "a class name is not ASCII");
      names.push(name);
      this.integer(true);
      head = this.head();
    }
    let tail: string[] = [];
    if (head !== NIL) {
      const at = this.#at - 1;
      const entry = this.#entries[this.reference(head, at, this.#entries.length)]!;
      if (entry.kind !== "class") throw new Refusal("unknown-shape", at, "a class reference names no class");
      tail = entry.chain;
    }
    slots.forEach((slot, index) => { this.#entries[slot] = { kind: "class", chain: [...names.slice(index), ...tail] }; });
    const chain = [...names, ...tail];
    if (chain.length === 0) this.refuse("unknown-shape", "an object has no class");
    return chain;
  }

  private value(encoding: string, depth: number, inString: boolean): void {
    if (depth > MAX_DEPTH) this.refuse("unknown-shape", `values nest deeper than ${MAX_DEPTH}`);
    if (encoding === "@") { this.object(depth); return; }
    if (encoding === "+") {
      const at = this.#at;
      const raw = this.unshared();
      if (raw === null) this.refuse("unknown-shape", "nil string bytes");
      if (inString && this.#text === undefined) {
        try {
          this.#text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
        } catch {
          throw new Refusal("bad-utf8", at, "the string's bytes are not UTF-8");
        }
      }
      return;
    }
    if (encoding === "*") { this.cString(); return; }
    if (encoding === "%" || encoding === ":") { this.shared(); return; }
    if (encoding === "#") { this.classChain(); return; }
    if (encoding === "B" || encoding === "C" || encoding === "c") { this.byte(); return; }
    if ("SILQsilq".includes(encoding) && encoding.length === 1) { this.integer(encoding === encoding.toLowerCase()); return; }
    if (encoding === "f" || encoding === "d") {
      const head = this.head();
      if (head === FLOATING) this.take(encoding === "f" ? 4 : 8);
      else this.integer(true, head);
      return;
    }
    if (encoding === "!") return;
    if (encoding.startsWith("[")) {
      const match = /^\[(\d+)(.+)\]$/u.exec(encoding);
      if (match === null) this.refuse("unknown-shape", `array encoding ${encoding}`);
      const count = Number(match[1]);
      if (match[2] === "C" || match[2] === "c") {
        this.take(count);
        return;
      }
      for (let index = 0; index < count; index++) {
        const before = this.#at;
        this.value(match[2]!, depth + 1, false);
        if (this.#at === before) this.refuse("unknown-shape", `an array of ${encoding} whose element reads no bytes`);
      }
      return;
    }
    if (encoding.startsWith("{")) {
      const equals = encoding.indexOf("=");
      const fields = new TextEncoder().encode(encoding.slice(equals >= 0 ? equals + 1 : 1, -1));
      for (const field of encodings(fields, this.#at)) this.value(field, depth + 1, false);
      return;
    }
    this.refuse("unknown-shape", `type encoding ${JSON.stringify(encoding)}`);
  }

  private cString(): void {
    const at = this.#at;
    const head = this.head();
    if (head === NIL) return;
    if (head !== NEW) { this.reference(head, at, this.#entries.length); return; }
    this.#entries.push({ kind: "cstring" });
    if (this.shared().includes(0)) throw new Refusal("unknown-shape", at, "a C string holds NUL");
  }

  private unshared(head = this.head()): Uint8Array | null {
    return head === NIL ? null : this.take(this.integer(false, head));
  }

  private shared(head?: number): Uint8Array {
    const at = this.#at;
    const actual = head ?? this.head();
    if (actual === NIL) this.refuse("unknown-shape", "nil shared string");
    if (actual === NEW) {
      const value = this.unshared();
      if (value === null) this.refuse("unknown-shape", "nil shared string");
      this.#shared.push(value);
      return value;
    }
    return this.#shared[this.reference(actual, at, this.#shared.length)]!;
  }

  private reference(head: number, at: number, limit: number): number {
    const index = this.integer(true, head) - FIRST_REFERENCE;
    if (index < 0 || index >= limit) throw new Refusal("bad-reference", at, `reference ${index} is not defined`);
    return index;
  }

  private integer(signed: boolean, head = this.head()): number {
    const at = this.#at;
    if (head < FIRST_TAG || head > LAST_TAG) return signed ? head : head & 0xff;
    if (head !== INTEGER_2 && head !== INTEGER_4) throw new Refusal("bad-integer", at, "a tag where an integer was required");
    const width = head === INTEGER_2 ? 2 : 4;
    const raw = this.take(width);
    let value = 0;
    for (let index = width - 1; index >= 0; index--) value = value * 256 + raw[index]!;
    return signed && value >= 2 ** (width * 8 - 1) ? value - 2 ** (width * 8) : value;
  }

  private head(): number {
    const value = this.byte();
    return value >= 0x80 ? value - 0x100 : value;
  }

  private byte(): number {
    if (this.#at >= this.bytes.byteLength) this.refuse("truncated", "the archive ends early");
    return this.bytes[this.#at++]!;
  }

  private take(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0) this.refuse("bad-integer", `length ${length}`);
    if (length > this.bytes.byteLength - this.#at) this.refuse("truncated", `wanted ${length} bytes`);
    return this.bytes.subarray(this.#at, (this.#at += length));
  }

  private refuse(reason: TypedstreamRefusal, message: string): never {
    throw new Refusal(reason, this.#at, message);
  }
}

function encodings(bytes: Uint8Array, at: number): string[] {
  const text = ascii(bytes);
  if (text === null) throw new Refusal("unknown-shape", at, "a type encoding is not ASCII");
  const out: string[] = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    const opening = text[index]!;
    if (opening === "[" || opening === "{") {
      const closing = opening === "[" ? "]" : "}";
      let depth = 0;
      do {
        const character = text[index++];
        if (character === opening) depth++;
        else if (character === closing) depth--;
      } while (depth > 0 && index < text.length);
      if (depth !== 0) throw new Refusal("unknown-shape", at, "an unterminated compound type encoding");
    } else {
      index++;
    }
    out.push(text.slice(start, index));
  }
  return out;
}

function ascii(bytes: Uint8Array): string | null {
  return bytes.every((byte) => byte < 0x80) ? String.fromCharCode(...bytes) : null;
}
