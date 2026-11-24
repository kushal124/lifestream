import type { Adapter, InputRecord } from "./adapter.js";
import type { MessageParty } from "./messages.js";

/** One party to a call, named on its line and joined to a person by its id. */
export interface CallParty extends MessageParty {
  /** The name the provider's app showed for it, printed where People knows no better one and titling the call in search. */
  provider?: string | null;
}

/** One call as a day prints it, one line for each call however many sources hold it. */
export interface Call {
  /** The service it was placed on, by a key of the adapter's `services`, which also keys the call's fact. */
  service: string;
  /** Who placed it. */
  direction:
    /** The other party called the person. */
    | "incoming"
    /** The person called the other party. */
    | "outgoing";
  /** How it ended, which its line says. */
  outcome:
    /** Answered, which its line prints with its length. */
    | "connected"
    /** An incoming call the person did not answer, printed as missed. */
    | "missed"
    /** A call no one answered that was not missed, printed as no answer or not answered. */
    | "not-connected";
  /** When it began, in milliseconds since the epoch. */
  start_ms: number;
  /** When it ended, in milliseconds since the epoch, which gives its length, or null for a call with no length. */
  end_ms: number | null;
  /** The other parties to it, which its line names. */
  parties: CallParty[];
  /** The group chat it was placed in, spelled as the same network's messages spell it, which its line names. */
  group?: string;
}

/** How a calling app's records become one line per call. */
export interface CallsAdapter extends Adapter {
  /** The messages network its calls belong to, which begins each call's unit and ties a call to its chat, as its product where absent. */
  network?: string;
  /** The words each service prints on a line, such as `FaceTime video call`, by the service's key, where a service it does not name prints `Call`. */
  services: Readonly<Record<string, string>>;
  /** One call record read as its call, or null for a record that is no call. */
  call(record: InputRecord): Call | null;
}
