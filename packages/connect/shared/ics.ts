import { ics } from "@lifestreamprotocol/core";

/** One content line read as a property: its name, its parameters and its value. */
export interface IcsProperty {
  /** The property's name, upper-cased, as `DTSTART`. */
  readonly name: string;
  /** Each parameter by its upper-cased name, its value unquoted, its caret escapes undone and a list's values joined by commas. */
  readonly params: Readonly<Record<string, string>>;
  /** The value as the line writes it, still escaped, for `unescapeText` or `timeValue` to read. */
  readonly value: string;
}

let component: (parsed: ics.IcsComponent) => IcsComponent;
let componentOf: (made: IcsComponent, where: string) => ics.IcsComponent;

/** One VEVENT of a calendar file, which only `parseCalendar` makes and `single` reads a property of. */
export class IcsComponent {
  static {
    component = (parsed) => new IcsComponent(parsed);
    componentOf = (made, where) => (#parsed in made ? made.#parsed : notParsed(where));
  }

  readonly #parsed: ics.IcsComponent;
  /** The component's text exactly as the file holds it, folding and line breaks included. */
  readonly content: string;
  /** The UTF-8 byte offset in the text at which the component's BEGIN line starts. */
  readonly startByte: number;

  private constructor(parsed: ics.IcsComponent) {
    this.#parsed = parsed;
    this.content = parsed.content;
    this.startByte = parsed.startByte;
  }
}

let zone: (parsed: ics.VTimezone) => VTimezone;
let zoneOf: (made: VTimezone, where: string) => ics.VTimezone;

/** A zone a calendar file defines in a VTIMEZONE, which only `parseCalendar` makes and whose rules give the file's local times their offsets. */
export class VTimezone {
  static {
    zone = (parsed) => new VTimezone(parsed);
    zoneOf = (made, where) => (#parsed in made ? made.#parsed : notParsed(where));
  }

  readonly #parsed: ics.VTimezone;
  /** The zone's name, as the file's TZID parameters cite it. */
  readonly tzid: string;

  private constructor(parsed: ics.VTimezone) {
    this.#parsed = parsed;
    this.tzid = parsed.tzid;
  }
}

function notParsed(where: string): never {
  throw new Error(`${where}: was not made by parseCalendar`);
}

/** A calendar file read whole: its events and the zones it defines. */
export interface IcsCalendar {
  /** The VEVENT components directly inside the file's VCALENDAR, in file order. */
  readonly events: readonly IcsComponent[];
  /** The zones the file defines, by TZID. */
  readonly zones: ReadonlyMap<string, VTimezone>;
}

/** A wall-clock date and time with no zone, as an iCalendar value spells it. */
export interface LocalDateTime {
  /** The year of the common era. */
  readonly year: number;
  /** The month of the year, 1 for January. */
  readonly month: number;
  /** The day of the month, from 1. */
  readonly day: number;
  /** The hour of a 24-hour clock, from 0. */
  readonly hour: number;
  /** The minute of the hour, from 0. */
  readonly minute: number;
  /** The second of the minute, from 0. */
  readonly second: number;
}

/** A DTSTART, DTEND or RECURRENCE-ID value: a UTC time, a wall-clock time in a zone the file names, or a date. */
export type IcsTime =
  | {
    /** A time in UTC. */
    readonly form: "utc";
    /** The time as RFC 3339 text ending in `Z`. */
    readonly text: string;
  }
  | {
    /** A wall-clock time in a zone the file names. */
    readonly form: "local";
    /** The wall-clock date and time. */
    readonly local: LocalDateTime;
    /** The TZID of the zone, which `timedText` looks up among the file's zones. */
    readonly tzid: string;
  }
  | {
    /** A whole day, with no time. */
    readonly form: "date";
    /** The day, as `YYYY-MM-DD`. */
    readonly date: string;
  };

/** Reads a whole calendar file into its events and the zones it defines, naming `where` in any error. */
export function parseCalendar(bytes: Uint8Array, where: string): IcsCalendar {
  const calendar = ics.parseCalendar(bytes, where);
  return { events: calendar.events.map(component), zones: new Map([...calendar.zones].map(([tzid, held]) => [tzid, zone(held)])) };
}

/** The properties of a text that is one VEVENT, in source order and without its nested components' lines, or null when it does not read as one. */
export const readEvent: (text: string) => IcsProperty[] | null = ics.readEvent;

/** The one property of a name an event holds, or undefined when it holds none. */
export function single(made: IcsComponent, name: string, where: string): IcsProperty | undefined {
  return ics.single(componentOf(made, where), name, where);
}

/** A TEXT value with its backslash escapes undone, so `\n` becomes a line break and `\,` a comma. */
export const unescapeText: (value: string) => string = ics.unescapeText;

/** Reads a DTSTART, DTEND or RECURRENCE-ID property as a UTC time, a wall-clock time in a named zone, or a date. */
export const timeValue: (property: IcsProperty, where: string) => IcsTime = ics.timeValue;

/** A UTC or wall-clock time as RFC 3339 text, a wall-clock time with the offset its zone's rules in the file give it then. */
export function timedText(value: Exclude<IcsTime, { form: "date" }>, defined: ReadonlyMap<string, VTimezone>, where: string): string {
  return ics.timedText(value, new Map([...defined].map(([tzid, made]) => [tzid, zoneOf(made, where)])), where);
}

/** Whether a text is a `YYYY-MM-DD` date that exists on the calendar. */
export const isDate: (value: string) => boolean = ics.isDate;
