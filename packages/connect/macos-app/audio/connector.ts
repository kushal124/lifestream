import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const audio = {
  id: "audio", product: "audio", name: "Audio", vendor: "lifestream", type: "voice", icon: "audio", noun: ["recording", "recordings"], counts: ["mic-recording"],
  gives: "Both sides of your calls and meetings.",
  records: "Both sides of calls, voice notes and dictation, only while an app uses the mic.",
  sources: [{ id: "audio:local:<unit>", read: "audio-recording", arrives: "mac" }],
  mac: { grants: ["microphone", "systemAudio"], sensor: true },
} satisfies Connector;
