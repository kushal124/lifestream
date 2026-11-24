import type { Adapter, AdapterSource } from "./adapter.js";

/** How a connector's sources serve as evidence of what was on a machine's screen, read whole by the screen family. */
export interface ScreenAdapter extends Adapter {
  /** The part its sources play in a sitting at the machine their copy names. */
  role:
    /** The screen's frames, from the cutover on: the app, the window, its text and the recorder's gaps. */
    | "frames"
    /** The person's keys, clicks, scrolls, app switches and screen locks. */
    | "input"
    /** The machine's own events, such as sleep, wake, lock, lid, microphone and camera. */
    | "machine"
    /** The screen as read before the cutover. */
    | "prior";
  /** Whether a source plays its role, where every source does when absent. */
  plays?(source: AdapterSource): boolean;
}
