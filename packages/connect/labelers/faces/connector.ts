import type { Connector } from "@lifestreamprotocol/connect/sdk";

export const faces = {
  id: "faces", product: "faces", name: "Faces", vendor: "lifestream", mentions: false,
  records: "Faces in your photos and chat images, and the groups you name.",
  sources: [{ id: "faces:local:<home>", read: "faces", arrives: "label" }],
  label: { labeler: "faces", install: "Get the face models" },
  fields: { battery_backlog: { kind: "number", label: "On battery, scan up to", default: 500, min: 0,
    about: "More waits for power or Scan now." } },
} satisfies Connector;
