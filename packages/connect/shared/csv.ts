import { refuse } from "./refused.js";
import { BYTES_LIMIT } from "./zip.js";

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const COMMA = 0x2c;
const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

/** One row of a CSV file, read only when asked so that a malformed row refuses alone. */
export interface CsvRow {
  /** Where the row is, as the file's name and the row's number. */
  readonly where: string;
  /** The row's fields by its header's column names, or Refused when the row is malformed, too large, not UTF-8 or not as wide as the header. */
  read(): Readonly<Record<string, string>>;
}

/** The bounds `csvRows` reads one row within. */
export interface CsvLimits {
  /** The most bytes one row is read in. */
  readonly bytes: number;
}

const CSV_LIMITS: CsvLimits = { bytes: BYTES_LIMIT };
const COLUMNS = 16_384;
const WIDE = " is wider than its header";

type Field = "start" | "unquoted" | "quoted" | "closing" | "after";

/** The rows of a CSV file under its header row, read from its chunks as they stream, a byte-order mark dropped and quoted fields unquoted. */
export async function* csvRows(chunks: AsyncIterable<Buffer> | Iterable<Buffer>, where: string, limits: CsvLimits = CSV_LIMITS): AsyncGenerator<CsvRow> {
  let header: readonly string[] | undefined;
  let rows = 0;
  let handed = 0;
  let state: Field = "start";
  let fields: Buffer[][] = [];
  let field: Buffer[] = [];
  let ended = 0;
  let raw = 0;
  let fault: string | null = null;
  let afterCr = false;
  let from = -1;

  const spoil = (why: string): void => {
    fault ??= why;
    fields = [];
    field = [];
  };
  const count = (): void => {
    if (++raw > limits.bytes && fault === null) spoil(` holds more than the ${limits.bytes} bytes one row is read in`);
  };
  const keep = (bytes: Buffer): void => {
    if (fault === null && bytes.length > 0) field.push(Buffer.from(bytes));
  };
  const flush = (chunk: Buffer, to: number): void => {
    if (from !== -1) keep(chunk.subarray(from, to));
    from = -1;
  };
  const endField = (): void => {
    ended++;
    if (fault === null) fields.push(field);
    field = [];
    state = "start";
    if (header === undefined ? ended > COLUMNS : ended > header.length) spoil(header === undefined ? ` has more than the ${COLUMNS} columns a header is read in` : WIDE);
  };
  const endRow = (): CsvRow | undefined => {
    const number = ++rows;
    if (state === "start" && ended === 0) return undefined;
    endField();
    const read = fields;
    const width = ended;
    let why = fault;
    fields = [];
    ended = 0;
    raw = 0;
    fault = null;
    if (header === undefined) {
      const at = `${where}: the header, row ${number}`;
      if (why !== null) refuse(`${at}${why}`);
      header = read.map((bytes) => text(bytes) ?? refuse(`${at} is not UTF-8`));
      return undefined;
    }
    const names = header;
    if (why === WIDE || (why === null && width !== names.length)) why = ` has ${width} field${width === 1 ? "" : "s"}; its header has ${names.length}`;
    const place = `${where} row ${number}`;
    handed++;
    return {
      where: place,
      read: () => {
        if (why !== null) refuse(`${place}${why}`);
        return Object.fromEntries(names.map((name, at) => [name, text(read[at]!) ?? refuse(`${place} is not UTF-8`)]));
      },
    };
  };

  for await (const chunk of unmarked(chunks)) {
    from = state === "unquoted" || state === "quoted" ? 0 : -1;
    for (let offset = 0; offset < chunk.length; offset++) {
      const byte = chunk[offset]!;
      if (afterCr) {
        afterCr = false;
        if (byte === LF) continue;
      }
      if (state === "quoted") {
        count();
        if (byte === QUOTE) {
          flush(chunk, offset);
          state = "closing";
        }
        continue;
      }
      if (byte !== CR && byte !== LF) count();
      if (byte !== COMMA && byte !== CR && byte !== LF) {
        if (state === "start") {
          state = byte === QUOTE ? "quoted" : "unquoted";
          from = byte === QUOTE ? offset + 1 : offset;
        } else if (state === "closing") {
          if (byte === QUOTE) {
            state = "quoted";
            from = offset;
          } else {
            spoil(`: field ${ended + 1} has bytes after its closing quote`);
            state = "after";
          }
        }
        continue;
      }
      flush(chunk, offset);
      if (byte === COMMA) {
        endField();
        continue;
      }
      afterCr = byte === CR;
      const part = endRow();
      if (part !== undefined) yield part;
    }
    flush(chunk, chunk.length);
  }
  if (state === "quoted") refuse(`${where}: row ${rows + 1} opens a quoted field that never closes, after ${handed} row${handed === 1 ? "" : "s"}`);
  const last = endRow();
  if (last !== undefined) yield last;
}

function text(pieces: readonly Buffer[]): string | undefined {
  try {
    return pieces.length === 0 ? "" : UTF8.decode(pieces.length === 1 ? pieces[0]! : Buffer.concat(pieces));
  } catch {
    return undefined;
  }
}

async function* unmarked(chunks: AsyncIterable<Buffer> | Iterable<Buffer>): AsyncGenerator<Buffer> {
  let head: Buffer | null = Buffer.alloc(0);
  for await (const chunk of chunks) {
    if (head === null) {
      yield chunk;
      continue;
    }
    head = Buffer.concat([head, chunk]);
    if (head.length < BOM.length && head.equals(BOM.subarray(0, head.length))) continue;
    yield head.subarray(0, BOM.length).equals(BOM) ? head.subarray(BOM.length) : head;
    head = null;
  }
  if (head !== null && head.length > 0) yield head;
}
