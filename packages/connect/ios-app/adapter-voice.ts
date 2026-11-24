import { instant, isObject, type Adapters, type InputRecord, type Recording } from "@lifestreamprotocol/connect/sdk";

export const voiceAdapters: Readonly<Record<string, Pick<Adapters, "voice">>> = {
  "voice-notes": {
    voice: {
      version: "1",
      kinds: ["voice"],
      recording({ version }: InputRecord): Recording | null {
        const content = version.content;
        if (!isObject(content) || content.type !== "voice.note" || !isObject(content.content) || !isObject(content.content.payload)) return null;
        const note = content.content.payload;
        const blob = note.blob;
        if (!isObject(blob) || typeof blob.hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(blob.hash) || typeof blob.type !== "string") return null;
        if (typeof note.duration_seconds !== "number" || !(note.duration_seconds >= 0)) return null;
        if (typeof note.started_at !== "string" || typeof note.ended_at !== "string") return null;
        let started_ms: number;
        let ended_ms: number;
        try {
          started_ms = instant(note.started_at, "rfc3339").start_ms;
          ended_ms = instant(note.ended_at, "rfc3339").start_ms;
        } catch {
          return null;
        }
        const where = note.location;
        const location = isObject(where) && typeof where.latitude === "number" && typeof where.longitude === "number"
          ? { latitude: where.latitude, longitude: where.longitude } : null;
        return {
          sha256: blob.hash.slice("sha256:".length), media_type: blob.type, duration_seconds: note.duration_seconds,
          started_ms, ended_ms: Math.max(started_ms, ended_ms), location,
        };
      },
    },
  },
};
