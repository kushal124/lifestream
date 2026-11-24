import { works, type Connector } from "@lifestreamprotocol/connect/sdk";

export const screen = {
  id: "screen", product: "screen", name: "Screen", vendor: "lifestream", type: "device-activity", starter: true, noun: ["frame", "frames"], counts: ["frame"], expect: "1d",
  gives: "What you saw, as text you can search.",
  records: "What’s on your screen, as video and text, so you can find anything you saw.",
  sources: [{ id: "screen:local:<unit>", read: "screen-recorder", arrives: "mac" }],
  refresh: { default: "2s", min: "1s", max: "5m", label: "Capture every" },
  fields: {
    ocr: {
      kind: "choice", label: "Text reading", default: "exact",
      options: { always: ["Every frame", "Reads every frame in full"], exact: ["Skip unchanged frames", "Reuses the text of a frame that did not change"] },
    },
    idle_pause: { kind: "duration", label: "Pause when idle for", default: "5m", min: "1m" },
    apps: { kind: "list", label: "Apps and sites", default: [], items: "modes" },
  },
  processing: { screen: works.SCREEN },
  mac: { grants: ["screenRecording"], sensor: true, recorder: true },
} satisfies Connector;
