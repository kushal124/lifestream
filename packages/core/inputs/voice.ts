import type { Adapter, InputRecord } from "./adapter.js";

/** One dictation at the record's time, as the person last left its words, printed as one line. */
export interface Dictation {
  /** The words, whole, which the line quotes trimmed and cut short where long. */
  words: string;
  /** The name of the app the words went into, which the line names. */
  app: string | null;
  /** The page the words went into, as a URL's host and path, which the line names after the app. */
  page: string | null;
}

/** One recording, printed as a voice note with its length and place, and transcribed by a model once the home holds its audio. */
export interface Recording {
  /** The SHA-256 of the audio's file in lower-case hex, by which the home holds its bytes. */
  sha256: string;
  /** The audio's media type, where only `audio/mp4`, `audio/x-m4a`, `audio/mpeg` and `audio/wav` are sent to be transcribed. */
  media_type: string;
  /** How long it runs, in seconds, which its line prints rounded. */
  duration_seconds: number;
  /** When it began, in milliseconds since the epoch. */
  started_ms: number;
  /** When it ended, in milliseconds since the epoch. */
  ended_ms: number;
  /** Where it was made, which its line names by the place there. */
  location: {
    /** The latitude, in degrees. */
    latitude: number;
    /** The longitude, in degrees. */
    longitude: number;
  } | null;
}

/** How a dictation product's or a recorder's records become lines of what the person said. */
export interface VoiceAdapter extends Adapter {
  /** One record read as its dictation, or null for one that states no words. */
  dictation?(record: InputRecord): Dictation | null;
  /** One record read as its recording, or null for one that states no readable recording. */
  recording?(record: InputRecord): Recording | null;
}
