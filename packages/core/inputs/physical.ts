import type { Adapter, InputRecord } from "./adapter.js";

/** How a witness knows where the person was, which the day says beside what it is not sure of. */
export type How =
  /** Its own sensors measured it, as a phone's fixes do. */
  | "observed"
  /** A photo was taken there. */
  | "seen"
  /** A provider says so, which the day prints as stated by the witness and photos taken elsewhere may doubt. */
  | "stated";

/** A point on Earth. */
interface Point {
  /** The latitude, in degrees. */
  latitude: number;
  /** The longitude, in degrees. */
  longitude: number;
}

/** Where the phone was at one moment, which the family joins with the other fixes into stays and trips. */
export interface Fix extends Point {
  /** When the phone took the fix, in milliseconds since the epoch. */
  at_ms: number;
  /** The radius the phone is sure the point lies within, in metres, where a fix too unsure is left out. */
  accuracy_m: number;
  /** The height above sea level, in metres, which helps tell a flight. */
  altitude_m: number;
  /** How fast the phone was moving at that moment, in metres per second. */
  speed_mps: number | null;
}

/** What the phone's motion sensors said the person was doing from one moment, which tells a trip's legs apart and speaks for the time between fixes. */
export interface Motion {
  /** When the reading began, in milliseconds since the epoch. */
  at_ms: number;
  /** Whether the phone was still. */
  stationary: boolean;
  /** Whether the person was walking. */
  walking: boolean;
  /** Whether the person was running. */
  running: boolean;
  /** Whether the person was in a vehicle. */
  automotive: boolean;
  /** Whether the person was cycling. */
  cycling: boolean;
  /** Whether the phone could not tell, which keeps a still reading from deciding anything. */
  unknown: boolean;
}

/** A stay a provider says the person made, which the day prints at its place unless a better witness covers it. */
export interface Visit {
  /** When the stay began, in milliseconds since the epoch. */
  start_ms: number;
  /** When the stay ended, in milliseconds since the epoch. */
  end_ms: number;
  /** The point the provider gives for the place. */
  centre: Point;
  /** The provider's id of the place, as `<provider>:<id>` such as `google:<place ID>`, by which the place's name is found. */
  place: string | null;
}

/** A trip a provider says the person made, one leg of one kind of travel, which the day prints between the stays beside it. */
export interface Activity {
  /** When the trip began, in milliseconds since the epoch. */
  start_ms: number;
  /** When the trip ended, in milliseconds since the epoch. */
  end_ms: number;
  /** The kind of travel in the provider's words, which the day prints as the leg. */
  stated: string;
  /** The kind of travel it was, which the day keeps only where the trip's speed bears it out. */
  mode:
    | "walk"
    | "cycle"
    | "road_vehicle"
    | "flight";
  /** How far it went, in metres, which the day prints. */
  distance_m: number;
  /** Where it started, which a visit ending at its start replaces. */
  from: Point | null;
  /** Where it ended, which a visit starting at its end replaces. */
  to: Point | null;
}

/** The answers the person gave to a check-in, printed as one line at that moment. */
export interface Report {
  /** When the person answered, in milliseconds since the epoch. */
  at_ms: number;
  /** The check-in's name in lower-case snake case, which the line prints with spaces. */
  form: string;
  /** Each question's answer, in the order the line prints them. */
  items: {
    /** The question's name, which the line prints before its answer. */
    id: string;
    /** The answer, where a number prints out of its scale and a boolean as yes or no. */
    value: string | number | boolean;
    /** The highest a number answer can be. */
    scale: number;
  }[];
  /** What the person wrote beside the answers. */
  note: string | null;
}

/** One trial of a vigilance test, where a response of 500 milliseconds or more counts as a lapse. */
export type Trial = {
  /** The person responded to the stimulus. */
  outcome: "response";
  /** How long the person took to respond, in milliseconds. */
  rt_ms: number;
} | {
  /** The person did not respond in time, which counts as a lapse, or responded before the stimulus. */
  outcome: "timeout" | "false_start";
};

/** A vigilance test, printed as one line with its responses, median reaction time, lapses and false starts. */
export interface Vigilance {
  /** When the test was taken, in milliseconds since the epoch. */
  at_ms: number;
  /** Whether it ran to its end, which the line says when it did not. */
  completed: boolean;
  /** Its trials, from which the line counts responses, lapses and false starts and takes the median reaction time. */
  trials: Trial[];
}

/** How a stream of where the person was and how they moved becomes evidence the family weighs against the other witnesses. */
export interface Witness extends Adapter {
  /** The witness's name, which the day prints beside what only it states. */
  name?: string;
  /** Where its evidence stands among the witnesses', the lower believed first, where the phone is 10, photos 20 and Timeline 40. */
  rank?: number;
  /** How it knows. */
  how?: How;
  /** One `fix` record read as its fix, or null for one that states no point. */
  fix?(record: InputRecord): Fix | null;
  /** One `motion` record read as its reading, or null for one that is no reading at its own time. */
  motion?(record: InputRecord): Motion | null;
  /** One `place-visit` record read as its stay, or null for one that is no stay of the person's. */
  visit?(record: InputRecord): Visit | null;
  /** One `trip` record read as its trip, or null for one that states no kind of travel or distance. */
  activity?(record: InputRecord): Activity | null;
  /** One `report` record read as its check-in, or null for one that is none. */
  report?(record: InputRecord): Report | null;
  /** One `vigilance` record read as its test, or null for one that is none. */
  vigilance?(record: InputRecord): Vigilance | null;
}
