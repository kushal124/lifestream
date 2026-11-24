import type { Adapter, InputRecord } from "./adapter.js";

/** One thing a browser's history states at the record's time, which the day prints in the browser's hour on its machine. */
export interface WebItem {
  /** What the browser did. */
  what:
    /** It showed the person a page, printed with the site and its titles. */
    | "visit"
    /** The person searched, printed with the words. */
    | "search"
    /** It downloaded a file, printed with the file's name and site. */
    | "download"
    /** A tab was open on another device, printed with its title. */
    | "tab";
  /** The page's address, from which the day reads the site, and by which a visit to a search's results page prints as that search. */
  url: string | null;
  /** The page's title, which a visit's or a tab's line prints. */
  title: string | null;
  /** A search's words. */
  term?: string;
  /** A download's file name. */
  file?: string;
  /** A download's state in words where it did not finish, such as `cancelled`, which its line prints. */
  state?: string;
  /** It was done on another device and synced here, naming no device, which the day prints under another device. */
  synced?: true;
  /** The name of the device a tab is open on, which the day prints it under. */
  device?: string;
  /** The tab a station browser's visit was in, by which a page an errand of the home's loaded in a claimed tab prints as no page shown. */
  tab?: {
    /** The tab's id in the browser. */
    id: number;
    /** Whether the person ever had the tab in front. */
    shown: boolean;
  };
}

/** How a browser's history becomes the pages, searches, downloads and tabs of a day. */
export interface WebAdapter extends Adapter {
  /** The browser is one a station runs errands in, so its visits name their tab. */
  station?: true;
  /** One record read as its item, or null for what was no page shown to the person, such as a redirect's hop. */
  item(record: InputRecord): WebItem | null;
  /** One visit record as the browser kept it, shown or not, by which a page's reload of itself prints once, or null for a record that is no visit. */
  visit?(record: InputRecord): WebVisit | null;
}

/** A visit as the browser kept it, which tells a page's own repeat of itself from a person's act. */
export interface WebVisit {
  /** The page's address. */
  url: string | null;
  /** The id of the tab it was in. */
  tab?: number;
  /** The key prefix, in the same source, of the record of the visit this one came from, where the page made it with no act of the person's. */
  from?: string;
}
