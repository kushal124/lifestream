import { isObject, type Adapters, type InputRecord, type Json, type JsonObject, type Play } from "@lifestreamprotocol/connect/sdk";

const PLAYING = 1;
const CHANGED = 3;
const CAST = "Listening on ";
const CAST_PARTS = " • ";
const CAST_LABEL = "Video Available";

export const listeningAdapters: Readonly<Record<string, Pick<Adapters, "listening">>> = {
  "now-playing": {
    listening: {
      version: "2",
      kinds: ["now-playing"],
      player: false,
      play({ version }: InputRecord): Play {
        const content = version.content;
        const fields: JsonObject = isObject(content) && isObject(content.fields) ? content.fields : {};
        const length = fields["6"];
        return {
          device: deviceOf(version.key), playing: fields["3"] === PLAYING, changed: fields["3"] === CHANGED,
          ...itemOf(text(fields["8"]), text(fields["5"])), album: text(fields["4"]), app: text(fields["15"]),
          length_s: typeof length === "number" && length > 0 ? length : null,
        };
      },
    },
  },
};

function itemOf(title: string | null, artist: string | null): { title: string | null; artist: string | null } {
  if (title === null || artist === null || !artist.startsWith(CAST)) return { title, artist };
  const parts = title.split(CAST_PARTS).map((part) => part.trim());
  if (parts.length > 1 && parts.at(-1) === CAST_LABEL) parts.pop();
  return { title: parts[0] === "" ? null : parts[0]!, artist: parts[1] === undefined || parts[1] === "" ? null : parts[1] };
}

function deviceOf(key: string): string {
  const colon = key.indexOf(":");
  return colon < 0 ? key : key.slice(0, colon);
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
