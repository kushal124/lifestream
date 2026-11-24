import { each, fingerprint, isObject, refuse, tryInstant, unitOf, type BlobReader, type Delivery, type Guard, type Instant, type JsonObject, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { basicMicros, microsSpelling, protobufFields, segbRecords } from "./segb.js";

export const APP_FOCUS = "app-focus";
export const NOW_PLAYING = "now-playing";

const LOCAL_SEGMENT = /^local\/(\d+)\.segb$/u;
const REMOTE_SEGMENT = /^remote\/([^/:]+)\/(\d+)\.segb$/u;

interface Stream {
  name: string;
  kind: string;
  type: string;
  messages: ReadonlySet<number>;
  key(fields: JsonObject): string | null;
  time: string;
}

function segments(delivery: Delivery): { path: string; blob: string; device: string }[] {
  const found: { path: string; blob: string; device: string; name: string }[] = [];
  for (const file of delivery.files) {
    const local = LOCAL_SEGMENT.exec(file.path);
    const remote = REMOTE_SEGMENT.exec(file.path);
    if (local !== null) found.push({ path: file.path, blob: file.blob, device: localDevice(delivery), name: local[1]! });
    else if (remote !== null) found.push({ path: file.path, blob: file.blob, device: remote[1]!, name: remote[2]! });
  }
  return found.sort((a, b) => (a.device < b.device ? -1 : a.device > b.device ? 1 : a.name.length - b.name.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
}

function localDevice(delivery: Delivery): string {
  const device = delivery.facts.local_device;
  if (typeof device !== "string" || device === "" || device.includes(":") || device.includes("/")) {
    refuse(`${delivery.id} ships local segments and its facts state no local_device to name this Mac by`);
  }
  return device;
}

function connector(stream: Stream, guard: Guard): Reader {
  return {
    name: stream.name,
    kinds: { [stream.kind]: guard },
    async *read(delivery: Delivery, files: BlobReader) {
      const device = unitOf(delivery.source);
      yield* each(segments(delivery), (segment) => segment.path, (segment) => {
        const bytes = files.bytes(segment.blob);
        return each(segbRecords(bytes, segment.path), (record) => `${segment.path}:entry ${record.index}`, (record): ReaderOutput[] => {
          const locator = `${segment.path}:entry ${record.index}`;
          const fields = protobufFields(record.protobuf, stream.messages, locator);
          const content = { type: stream.type, format: record.format, written: record.written, fields };
          const row: ReaderOutput = {
            kind: stream.kind,
            key: `${segment.device}:${stream.key(fields) ?? unkeyed(fields, locator)}`,
            content,
            device,
            locator,
          };
          const time = when(fields[stream.time]);
          if (time !== null) row.time = time;
          return [row];
        });
      });
    },
  };
}

function unkeyed(fields: JsonObject, locator: string): string {
  return Object.keys(fields).length === 0 ? locator : fingerprint(fields);
}

function when(at: unknown): Instant | null {
  return typeof at !== "number" ? null : tryInstant(microsSpelling(at), "apple-s") ?? null;
}

function record(content: unknown, type: string): string[] {
  if (!isObject(content) || Object.keys(content).sort().join() !== "fields,format,type,written") {
    return ["members must be exactly type, format, written, fields"];
  }
  const problems: string[] = [];
  if (content.type !== type) problems.push(`type must be ${type}`);
  if (!Number.isSafeInteger(content.format)) problems.push("format must be a whole number");
  if (typeof content.written !== "number") problems.push("written must be a number");
  if (!isObject(content.fields) || Object.keys(content.fields).length === 0) problems.push("fields must state at least one field");
  return problems;
}

const APP_IN_FOCUS: Stream = {
  name: "biome-app-in-focus",
  kind: APP_FOCUS,
  type: "biome.app-in-focus",
  messages: new Set(),
  time: "4",
  key(fields) {
    const [at, app, starts] = [fields["4"], fields["6"], fields["3"]];
    if (typeof at !== "number" || when(at) === null || typeof app !== "string" || (starts !== 0 && starts !== 1)) return null;
    return `${basicMicros(at)}:${app}:${starts === 1 ? "in" : "out"}`;
  },
};

const appFocus: Guard = (content) => record(content, APP_IN_FOCUS.type);

const NOW_PLAYING_STREAM: Stream = {
  name: "biome-now-playing",
  kind: NOW_PLAYING,
  type: "biome.now-playing",
  messages: new Set([14]),
  time: "2",
  key(fields) {
    const [at, state] = [fields["2"], fields["3"]];
    if (typeof at !== "number" || when(at) === null || !Number.isSafeInteger(state)) return null;
    return `${basicMicros(at)}:${state as number}`;
  },
};

const nowPlaying: Guard = (content) => record(content, NOW_PLAYING_STREAM.type);

export const biomeAppInFocus = connector(APP_IN_FOCUS, appFocus);
export const biomeNowPlaying = connector(NOW_PLAYING_STREAM, nowPlaying);
