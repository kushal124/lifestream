import type { ReaderOutput } from "@lifestreamprotocol/core";

export type RefusedCode = "BUNDLE_MANIFEST" | "BUNDLE_INTEGRITY" | "BUNDLE_ENTRY" | "ZIP";

const REFUSED: unique symbol = Symbol.for("lifestream.refused") as never;

/** The error a reader throws for a part of a delivery it cannot read, which becomes a refusal of that part while the rest of the delivery lands. */
export class Refused extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    if (this !== Refused) return Function.prototype[Symbol.hasInstance].call(this, value);
    return value instanceof Error && (value as { [REFUSED]?: true })[REFUSED] === true;
  }

  readonly [REFUSED] = true as const;

  constructor(message: string) {
    super(message);
    this.name = "Refused";
  }
}

export class CodedRefused extends Refused {
  constructor(
    message: string,
    readonly code: RefusedCode,
  ) {
    super(message);
  }
}

/** Throws a Refused with the message given. */
export function refuse(message: string): never {
  throw new Refused(message);
}

export function refuseAs(message: string, code: RefusedCode): never {
  throw new CodedRefused(message, code);
}

/** A row refusing the part of a delivery at the place given, for the reason given. */
export function refusedFile(where: string, why: string): ReaderOutput {
  return { kind: "file", key: where, content: null, refused: why, locator: where };
}

/** How `each` passes on a part's rows. */
export interface EachOptions {
  /** Passes on each part's rows as they are, without naming the part on the refusals among them. */
  group?: true;
}

/** Yields each part's rows in turn, a Refused thrown while deriving a part becoming a refusal of that part alone, named by `where`, before the next part is read. */
export async function* each<P>(
  parts: AsyncIterable<P> | Iterable<P>,
  where: (part: P, index: number) => string,
  derive: (part: P) => AsyncIterable<ReaderOutput> | Iterable<ReaderOutput> | Promise<Iterable<ReaderOutput>>,
  options: EachOptions = {},
): AsyncGenerator<ReaderOutput> {
  let index = 0;
  for await (const part of parts) {
    const at = index++;
    let refusal: ReaderOutput | undefined;
    let member: string | undefined;
    const named = (row: ReaderOutput): ReaderOutput => (row.refused === undefined ? row : { ...row, member: (member ??= where(part, at)) });
    try {
      for await (const row of await derive(part)) yield options.group === true ? row : named(row);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      refusal = named(refusedFile(where(part, at), error.message));
    }
    if (refusal !== undefined) yield refusal;
  }
}

/** Runs a read and returns its value, or the Refused it threw. */
export function attempt<T>(read: () => T): T | Refused {
  try {
    return read();
  } catch (error) {
    if (error instanceof Refused) return error;
    throw error;
  }
}
