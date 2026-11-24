import type { RecordRef } from "../types.js";
import type { Adapter, AdapterSource, AdapterVersion } from "./adapter.js";

/** One file a copy of a photo names. */
export interface PhotoFile {
  /** The file's SHA-256 in lower-case hex, by which the home holds its bytes and joins the copies that name it. */
  sha256: string;
  /** The file's media type, which the day's photo is shown with. */
  media_type: string;
}

/** One file a copy needs to be whole, as its route states it before any byte is fetched. */
export interface PhotoResource {
  /** The kind of file the route calls it, which names it in the list of what a photo still lacks and what the home asks the device to send. */
  type: string;
  /** The file's original name. */
  name: string | null;
  /** The file's size in bytes, shown beside what a photo still lacks. */
  size: number | null;
  /** The SHA-256s in lower-case hex stated for it, any one of which the home holding makes it held. */
  files: string[];
  /** Whether the route says it can never fetch the file, so the home stops asking for it. */
  refused: boolean;
}

/** One route's copy of a photo, however many files it is, which the family joins with every other route's copy of the same photo. */
export interface Copy {
  /** The copy's id within its source, a library's local identifier or else the record's key. */
  id: string;
  /** The records the copy is made of, whose first is the one its place is read from. */
  records: RecordRef[];
  /** When it was taken, in milliseconds since the epoch, where the first dated copy in the routes' rank order times the photo. */
  at_ms: number | null;
  /** A library's cloud identifier, which joins two libraries' copies of the same photo. */
  cloud: string | null;
  /** The camera's names of its original and of its motion, such as `IMG_0001.HEIC`, which join a library's copy to a file's taken near the same time. */
  names: string[];
  /** Whether the copy is a video, which the day prints with its length. */
  video: boolean;
  /** Every original file any of its records names, the newest stated first. */
  originals: PhotoFile[];
  /** The current edit's renders, the newest stated first, which the day shows over an original. */
  renders: PhotoFile[];
  /** The files of a still's moving part, such as a Live Photo's video, which makes the day print it as live. */
  motion: {
    /** The moving part's current renders, the newest stated first. */
    renders: PhotoFile[];
    /** The moving part's originals. */
    originals: PhotoFile[];
  };
  /** A video's length in milliseconds, which the day prints. */
  duration_ms: number | null;
  /** The SHA-256s in lower-case hex of every original, render or motion file any of its records ever named, by which it joins other copies. */
  files: string[];
  /** The files the copy needs to be whole, which the home asks a library's device to send. */
  resources: PhotoResource[];
  /** When its newest edit was made, in milliseconds since the epoch, so that a newer edit's render wins, or `Number.MIN_SAFE_INTEGER` where it states none. */
  modified_ms: number;
  /** Whether the person erased one of its records, which keeps the photo from every day. */
  erased: boolean;
}

/** Where a photo was taken, as one record states it, which places the person there on the day. */
export interface PhotoPosition {
  /** The latitude, in degrees. */
  latitude: number;
  /** The longitude, in degrees. */
  longitude: number;
  /** How far off the point may be, in metres. */
  accuracy_m: number | null;
}

/** What a photos adapter may read of the records its home holds. */
export interface PhotoView {
  /** The head of one record, or undefined when the home holds none. */
  head(ref: RecordRef): PhotoHead | undefined;
  /** The head of each record of one kind a source holds, timed within the range when one is given. */
  heads(source: string, kind: string, range?: { readonly start_ms?: number; readonly end_ms?: number }): Iterable<PhotoHead>;
  /** The head of each record of one kind a source holds whose key starts with the prefix. */
  keyedUnder(source: string, kind: string, prefix: string): readonly PhotoHead[];
  /** Whether the person erased a record of one kind a source held whose key starts with the prefix. */
  erasedUnder(source: string, kind: string, prefix: string): boolean;
  /** The version a head names by its id. */
  version(id: string): AdapterVersion;
}

/** Where one held record stands, as a photos adapter reads it. */
export interface PhotoHead extends RecordRef {
  /** The id of the record's current version, or "gone" when its source removed it. */
  readonly version: string;
  /** When the record's current version starts, in ms since the epoch, or null when it states no time. */
  readonly start_ms: number | null;
}

/** How a photo route's records become copies of photos, which the family joins across routes into one photo each. */
export interface PhotosAdapter extends Adapter {
  /** Where a source stands in the order that times a photo, the lower first. */
  rank(source: AdapterSource): number;
  /** Its records are keyed by their original's hash, so a copy is one record or a still and its companion video. */
  keyed?: boolean;
  /** Its sources are libraries, where a copy is every record keyed `<local identifier>:…` and the device sends a photo's files when the home asks. */
  library?: boolean;
  /** Whether a source holds the photos of a device paired with the home, so that a photo whose image the home does not hold yet still places that device where it was taken. */
  paired?(source: AdapterSource): boolean;
  /** The copy that `id` names in a source as the home holds it now, or null for none. */
  copy(view: PhotoView, source: AdapterSource, id: string): Copy | null;
  /** The SHA-256s in lower-case hex of the originals, renders and motion files one version of a record names, which find the copies it joins. */
  files(version: AdapterVersion, key: string): string[];
  /** The SHA-256 in lower-case hex of the one image a version of a record shows, or null where it names none or two that differ. */
  image(view: PhotoView, source: AdapterSource, version: AdapterVersion, key: string): string | null;
  /** The key of the record whose time is this version's photo's, inside an object, or null where the version's own time is the photo's. */
  placedBy(version: AdapterVersion, key: string): { key: string | null } | null;
  /** Where the photo a version states was taken, inside an object, or null for a record that places no photo. */
  position(version: AdapterVersion): { position: PhotoPosition | null } | null;
}
