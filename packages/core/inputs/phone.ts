import type { Adapter, InputRecord } from "./adapter.js";

/** One app coming into focus or leaving it on one device, at the record's time, which the family pairs into the device's time in each app. */
export interface Focus {
  /** The id the log names the device by, the same on every copy of the log, whose apps make one stretch of use. */
  device: string;
  /** The app's bundle id, which the day prints with its minutes. */
  app: string;
  /** Whether the app came into focus, or else left it. */
  in: boolean;
}

/** How an activity log of the person's other devices becomes their time in each app. */
export interface PhoneAdapter extends Adapter {
  /** One record read as its focus, or null for one that states none. */
  focus(record: InputRecord): Focus | null;
}
