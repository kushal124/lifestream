import { sensorReader } from "../shared/sensor-reader.js";

export const usage = sensorReader("usage", {
  connector: "usage-ios-bundle",
  clock: "observed",
  blob: false,
  kinds: {
    activity_segment: { kind: "usage", type: "usage.segment" },
    activity_catalog: { kind: "catalog", type: "usage.catalog" },
    shortcut_marker: { kind: "usage-event", type: "usage.event" },
    monitor_callback: { kind: "usage-event", type: "usage.event" },
    usage_acquisition: { kind: "recorder", type: "usage.recorder" },
  },
});
