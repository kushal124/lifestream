import { canonical, deliveredLines, isObject, lineText, parseLine, refuse, type Guard, type Json, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { CAMERA_PHOTO_KIND } from "../../shared/photo-image.js";
import { isCameraId } from "../../shared/exif.js";

export const CAMERAS_FILE = "cameras.ndjson";
export const PHOTO_KIND = CAMERA_PHOTO_KIND;
export const CAMERA_KIND = "camera";

const HEX = /^[0-9a-f]{64}$/u;
const BLOB_REF = /^sha256:[0-9a-f]{64}$/u;
const UNIT = /^[a-z0-9][a-z0-9-]*$/u;

export interface CameraPhoto {
  type: "cameras.photo";
  camera: string;
  gps?: { latitude: number; longitude: number };
}

export interface Camera {
  type: "cameras.camera";
  make: string | null;
  model: string | null;
  photos: number;
  first_ms: number | null;
  last_ms: number | null;
  sample: string | null;
  phones: string[];
}

const photoGuard: Guard = (content) => {
  if (!isObject(content) || !(exact(content, ["camera", "type"]) || exact(content, ["camera", "gps", "type"])) || content.type !== "cameras.photo") {
    return ["content must have exactly type cameras.photo and camera, and gps when the EXIF states one"];
  }
  const violations = typeof content.camera === "string" && isCameraId(content.camera) ? [] : ["camera must be a camera's id: <make>/<model> or phone/<unit>"];
  const gps = content.gps;
  const degrees = (value: Json | undefined, limit: number) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= limit;
  if (gps !== undefined && !(isObject(gps) && exact(gps, ["latitude", "longitude"]) && degrees(gps.latitude, 90) && degrees(gps.longitude, 180))) {
    violations.push("gps must have exactly a latitude within 90 and a longitude within 180");
  }
  return violations;
};

const cameraGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["first_ms", "last_ms", "make", "model", "phones", "photos", "sample", "type"]) || content.type !== "cameras.camera") {
    return ["content must have exactly type cameras.camera, make, model, photos, first_ms, last_ms, sample and phones"];
  }
  const violations: string[] = [];
  const named = (value: Json | undefined) => value === null || (typeof value === "string" && value !== "" && value === value.trim());
  if (!named(content.make) || !named(content.model) || (content.make === null) !== (content.model === null)) violations.push("make and model must both be trimmed text, or both null");
  if (typeof content.photos !== "number" || !Number.isSafeInteger(content.photos) || content.photos < 1) violations.push("photos must be a whole number of at least 1");
  const { first_ms, last_ms } = content;
  const timed = Number.isSafeInteger(first_ms) && Number.isSafeInteger(last_ms) && (first_ms as number) <= (last_ms as number);
  if (!(timed || (first_ms === null && last_ms === null))) violations.push("first_ms and last_ms must be integer milliseconds, first not after last, or both null");
  if (content.sample !== null && (typeof content.sample !== "string" || !BLOB_REF.test(content.sample))) violations.push("sample must be sha256:<64 hex> or null");
  const phones = content.phones;
  if (!Array.isArray(phones) || !phones.every((unit, index) => typeof unit === "string" && UNIT.test(unit) && (index === 0 || (phones[index - 1] as string) < unit))) {
    violations.push("phones must be units, sorted, each once");
  }
  return violations;
};

const GUARDS: Record<string, Guard> = { [PHOTO_KIND]: photoGuard, [CAMERA_KIND]: cameraGuard };

export function camerasLine(kind: typeof PHOTO_KIND | typeof CAMERA_KIND, key: string, content: CameraPhoto | Camera | "gone"): string {
  return canonical(content === "gone" ? { gone: true, key, kind } : { content: content as unknown as Json, key, kind });
}

export const camerasConnector: Reader = {
  name: "cameras",
  kinds: GUARDS,
  async *read(delivery, files): AsyncIterable<ReaderOutput> {
    const [listing, ...more] = delivery.files;
    if (listing === undefined || more.length > 0 || listing.path !== CAMERAS_FILE) {
      refuse(`a cameras delivery holds one ${CAMERAS_FILE}, not ${JSON.stringify(delivery.files.map((file) => file.path))}`);
    }
    for (const yielding of [false, true]) {
      for await (const { bytes, line, where } of deliveredLines(files, listing)) {
        const one = row(lineText(bytes, where), line);
        if (yielding) yield one;
      }
    }
  },
};

function row(line: string, ordinal: number): ReaderOutput {
  const at = `${CAMERAS_FILE} line ${ordinal}`;
  const value = parseLine(line, at);
  if (typeof value.kind !== "string" || !(value.kind in GUARDS)) return refuse(`${at} must state kind photo or camera`);
  const { kind, key } = value;
  if (typeof key !== "string" || !(kind === PHOTO_KIND ? HEX.test(key) : isCameraId(key))) {
    return refuse(`${at} must state a key: ${kind === PHOTO_KIND ? "the image's 64 lowercase hex" : "a camera's id"}`);
  }
  if (exact(value, ["gone", "key", "kind"]) && value.gone === true) return { kind, key, content: null, gone: true };
  if (!exact(value, ["content", "key", "kind"])) return refuse(`${at} must have exactly kind, key and content, or kind, key and gone: true`);
  const violations = GUARDS[kind]!(value.content!);
  return violations.length > 0 ? refuse(`${at}: ${violations.join("; ")}`) : { kind, key, content: value.content! };
}

function exact(value: { [member: string]: Json }, members: readonly string[]): boolean {
  const names = Object.keys(value).sort();
  return names.length === members.length && names.every((name, index) => name === members[index]);
}
