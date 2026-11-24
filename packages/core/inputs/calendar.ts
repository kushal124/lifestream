import type { Adapter, InputRecord } from "./adapter.js";

/** A party to an event, named on its line and joined to a person by its address. */
export interface CalendarParty {
  /** The party's email address, which People reads as its handle. */
  address: string;
  /** The name the calendar shows it by, printed where People knows no better one. */
  name: string | null;
}

/** What one copy of an event prints on its line. */
export interface CalendarEvent {
  /** The event's title, which begins its line and keys its fact. */
  title: string;
  /** When it starts, in milliseconds since the epoch, or midnight UTC of its first date for a date-only event. */
  start_ms: number;
  /** When it ends, in milliseconds since the epoch, or midnight UTC after its last date for a date-only event, which sets the meeting minutes the day counts. */
  end_ms: number | null;
  /** Whether it is held on whole calendar dates, which prints it on those dates in every zone. */
  date_only: boolean;
  /** The zone its start is stated in, as an IANA zone name, which its line names when it is another zone than the day's. */
  zone: string | null;
  /** Its iCalendar STATUS in capitals, which its line prints when it is not `CONFIRMED`. */
  status: string | null;
  /** Who organised it, whom its line names unless it is the source's own account. */
  organizer: CalendarParty | null;
  /** How many attendees the copy names, which its line counts. */
  attendees: number;
  /** The account's own answer as an iCalendar PARTSTAT in capitals, such as `ACCEPTED`, which its line prints as the person's reply. */
  response: string | null;
  /** Whether it carries a video call, which its line says. */
  video: boolean;
  /** Where it is held, in the calendar's words, which its line prints. */
  location: string | null;
  /** How often its series repeats in words, such as `weekly`, which its line prints, or the empty string for a series whose rule the adapter cannot put in words. */
  repeats: string | null;
}

/** What one copy of a reminder prints on its lines. */
export interface Reminder {
  /** The reminder's title, which its lines quote. */
  title: string;
  /** When it is due, which puts its due line on a day, or null for a reminder with no due time. */
  due: {
    /** When it falls due, in milliseconds since the epoch, or midnight UTC of its date for an all-day reminder. */
    start_ms: number;
    /** When its due time ends, in milliseconds since the epoch, or midnight UTC after its last date for an all-day reminder. */
    end_ms: number | null;
    /** Whether it is due on whole calendar dates. */
    date_only: boolean;
  } | null;
  /** Whether it is done, which its due line says. */
  completed: boolean;
  /** When it was done, in milliseconds since the epoch, which puts a completed line on that day. */
  completed_ms: number | null;
  /** The name of the list it is in, which its lines print. */
  list: string | null;
  /** Whether it is flagged, which its due line says. */
  flagged: boolean;
}

/** One record's copy of an event or a reminder, with what ranks it among the other copies of the same thing. */
export interface CalendarCopy<T> {
  /** What the copy prints. */
  value: T;
  /** When the store last changed the copy, in milliseconds since the epoch, or `-Infinity` where it states none, so that the copy changed last decides what prints. */
  modified: number;
  /** Whether the store marks a reminder deleted, which keeps it from every day. */
  deleted?: boolean;
  /** Among copies that print the same, the one with the lowest rank is shown, as 0 where absent. */
  rank?: number;
}

/** The words one record is searched by. */
export interface CalendarWords {
  /** The title search finds it by. */
  title: string | null;
  /** The rest of its words. */
  text: string;
  /** The addresses of its parties, each searched as its person. */
  who: readonly string[];
}

/** How a calendar or a reminder store's records become one event or reminder each, however many copies hold it. */
export interface CalendarAdapter extends Adapter {
  /** Whether its store decides the events it holds or mirrors a store that does. */
  authority:
    /** The account's own calendar, whose events it states gone are cancelled. */
    | "own"
    /** A device's copy of an own calendar, whose events print only while no own calendar holds the same one, and whose reminders join the own reminder store of its connector's vendor. */
    | "mirror";
  /** How a record's key names the event or reminder it is a copy of. */
  keys:
    /** The key is the thing's own name, such as an iCalendar UID. */
    | "name"
    /** The key is `<name>:<holder>`, the name and the calendar or account that holds the copy. */
    | "held";
  /** How the units of its own sources are named. */
  units:
    /** As `<account>/<name>`. */
    | "account"
    /** As `<product>:<account>/<name>`. */
    | "product";
  /** One event record read as its copy, or null for a record that prints nothing. */
  event?(record: InputRecord): CalendarCopy<CalendarEvent> | null;
  /** One reminder record read as its copy, or null for a record that prints nothing. */
  reminder?(record: InputRecord): CalendarCopy<Reminder> | null;
  /** What its connector calls a reminder, capitalised as a line begins with it, such as `Task`, where `Reminder` is said when absent. */
  reminderWord?: string;
  /** One record's search words, or null for a record that has none or prints nothing. */
  words(record: InputRecord): CalendarWords | null;
}
