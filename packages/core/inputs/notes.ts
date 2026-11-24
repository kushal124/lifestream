import type { Adapter, InputRecord } from "./adapter.js";

/** A note as its app holds it, printed on the day the record's time says it was created and the day it was last edited. */
export interface Note {
  /** Marks the record a note. */
  shape: "note";
  /** The title the app shows, which its line quotes. */
  title: string;
  /** Its words as plain lines, the title's line among them, where a list line opens with its marker as the app shows it, such as `[x] `, `[ ] `, `- ` or `1. `, indented two spaces a level. */
  text: string;
  /** Whether the note is locked, which its line says. */
  locked: boolean;
  /** Whether it is in the app's Recently Deleted and still recoverable, which its line says. */
  trashed: boolean;
  /** Whether it is marked to be purged, which keeps it from every day and from search. */
  marked: boolean;
}

/** A meeting's notes, printed as one line over the record's time. */
export interface Meeting {
  /** Marks the record a meeting's notes. */
  shape: "meeting";
  /** The meeting's title, which its line quotes and its fact is keyed by. */
  title: string;
  /** The people there other than the account itself, each by name or else by address, whom its line names. */
  people: readonly string[];
  /** Every address the people there are known by, the account's own among them, by which search finds it. */
  emails: readonly string[];
  /** Its summary and the person's own notes, each a part of the text search finds it by. */
  words: readonly string[];
}

/** How a notes app's records become notes and meetings on a day. */
export interface NotesAdapter extends Adapter {
  /** Its sources of one account hold the same notes, so the copy edited last decides what prints. */
  copies?: "edited-last";
  /** One record read as its note or meeting, or null for one that is neither. */
  note(record: InputRecord): Note | Meeting | null;
}
