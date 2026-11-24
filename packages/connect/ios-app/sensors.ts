import { sensorReader, type SensorDomain } from "../shared/sensor-reader.js";

const DOMAINS: Record<string, SensorDomain> = {
  location: {
    connector: "location-ios-bundle",
    clock: "captured",
    blob: false,
    kinds: {
      fix: { kind: "fix", type: "location.fix" },
      gap: { kind: "gap", type: "location.gap" },
      recorder_event: { kind: "recorder", type: "location.recorder" },
      lifecycle: { kind: "recorder", type: "location.recorder" },
    },
  },
  motion: {
    connector: "motion-ios-bundle",
    clock: "captured",
    blob: false,
    kinds: {
      activity: { kind: "motion", type: "motion.activity" },
      pedometer_day: { kind: "sample", type: "motion.pedometer-day" },
      recorder_event: { kind: "recorder", type: "motion.recorder" },
    },
  },
  voice: { connector: "voice-ios-bundle", clock: "observed", blob: true, kinds: { voice_note: { kind: "voice", type: "voice.note" } } },
  camera: { connector: "camera-ios-bundle", clock: "observed", blob: true, kinds: { photo: { kind: "img", type: "camera.photo" } } },
  energy: {
    connector: "energy-ios-bundle",
    clock: "observed",
    blob: false,
    kinds: {
      parts: { kind: "energy", type: "energy.parts" },
      power_state: { kind: "energy", type: "energy.power-state" },
      metrickit_payload: { kind: "energy", type: "energy.metrickit" },
      metrickit_diagnostic: { kind: "energy", type: "energy.metrickit-diagnostic" },
    },
  },
};

export const location = sensorReader("location", DOMAINS.location!);
export const motion = sensorReader("motion", DOMAINS.motion!);
export const voice = sensorReader("voice", DOMAINS.voice!);
export const camera = sensorReader("camera", DOMAINS.camera!);
export const energy = sensorReader("energy", DOMAINS.energy!);
