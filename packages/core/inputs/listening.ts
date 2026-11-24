import type { Adapter, InputRecord } from "./adapter.js";

/** What was playing, each field in the provider's own words, which together tell one item from another. */
export interface PlayItem {
  /** The item's title, which its line prints and search finds. */
  title: string | null;
  /** Its artist, which its line prints after `by` and the day totals time for. */
  artist: string | null;
  /** Its album, which search finds. */
  album: string | null;
  /** The bundle id of the app that played it, which its line names. */
  app: string | null;
  /** The item's length in seconds, which bounds how long a log's play may run without another entry. */
  length_s: number | null;
}

/** One entry of a log of what each device is playing, at the record's time. */
export interface PlayEntry extends PlayItem {
  /** The id the log names the device by, whose entries make one run of plays. */
  device: string;
  /** Whether the entry says the item is playing, which starts or continues a play. */
  playing: boolean;
  /** Whether the entry is a change of item naming the item that played before, which ends that item's play. */
  changed: boolean;
}

/** One play from a player's history, heard up to the record's time. */
export interface PlayHeard extends PlayItem {
  /** The platform the history lists it on, which its line names after the player, or the empty string for none. */
  device: string;
  /** How long it played, in milliseconds, where a play that heard nothing is not read. */
  played_ms: number | null;
  /** It was heard offline, so its time is when the player logged it, which its line says. */
  offline?: true;
}

/** One record read as a log's entry or a history's play. */
export type Play = PlayEntry | PlayHeard;

/** How a log of what devices play, or a player's history, becomes sessions of plays on a day. */
export interface ListeningAdapter extends Adapter {
  /** Its records are a log that names no player, so its entries are read as `PlayEntry` and its plays named by device. */
  player?: false;
  /** One record read as its entry or play, or null for one the family does not read. */
  play(record: InputRecord): Play | null;
}
