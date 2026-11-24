import type { Adapter, InputRecord } from "./adapter.js";

/** One record's line, printed at the record's own time by the plain family, for a connector whose records no other family reads. */
export interface Line {
  /** The line's words, which the day prints and search finds. */
  text: string;
  /** A title the day prints before the words and search finds the record by. */
  title?: string;
  /** The handles of the people the record names, each searched as its person. */
  who?: readonly string[];
  /** The address of a page the record is about, which search shows with its hit. */
  link?: string;
  /** A line states no time of its own, since it is placed at its record's. */
  at_ms?: never;
  /** A line states no end of its own, since it is placed at its record's. */
  end_ms?: never;
}

/** How a connector's records that no family reads become one plain line each. */
export interface LineAdapter extends Adapter {
  /** One record read as its line, or null for one that prints nothing. */
  line(record: InputRecord): Line | null;
}
