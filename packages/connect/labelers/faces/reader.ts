import { canonical, deliveredLines, isObject, lineText, parseLine, refuse, type BlobReader, type Delivery, type Guard, type Json, type Reader, type ReaderOutput } from "@lifestreamprotocol/connect/sdk";
import { notASlug, parseFaceKey, SLUG } from "@lifestreamprotocol/core";

export const FACES_FILE = "faces.ndjson";
export const SCAN_KIND = "scan";
export const FACES_KIND = "faces";
export const NAMED_KIND = "named";
export const CLUSTER_KIND = "cluster";
export const MODEL_IMAGE_KIND = "model-image";
export const IMAGE_KIND = "image";
export const MAYBE_KIND = "maybe";

export const OUTLIERS_SIZE = 6;
export const SUGGESTED_SIZE = 3;
export const EVIDENCE_SIZE = 5;
export const MAYBE_SIZE = 200;
export const SENDER_KINDS = ["email", "jid", "network", "phone"] as const;

const HEX = /^[0-9a-f]{64}$/;
const CLUSTER_ID = /^[0-9a-f]{16}$/;
const BLOB_REF = /^sha256:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIERS = ["seed", "assign", "observe"];
const FILE = /^([0-9a-f]{64})\.(?:jpg|f32)$/;

export type Box = [number, number, number, number];

export interface ScannedFace {
  box: Box;
  landmarks: [number, number][];
  score: number;
  size: number;
  tier: "seed" | "assign" | "observe";
  crop: string | null;
}

export type Scan =
  | { pipeline: string; status: "ok"; width: number; height: number; faces: ScannedFace[]; vectors: string | null }
  | { pipeline: string; status: "unreadable"; width: null; height: null; faces: null; vectors: null };

export interface NamedFace {
  face: string;
  at_ms: number | null;
  camera: boolean;
  crop: string | null;
  tier: ScannedFace["tier"];
  size: number;
}

export interface Named {
  photos: NamedFace[];
  labels: string[];
}

export interface ClusterFace {
  face: string;
  at_ms: number | null;
  crop: string | null;
}

export interface Sender {
  kind: (typeof SENDER_KINDS)[number];
  value: string;
}

export interface Image {
  library: boolean;
  chat: boolean;
  at_ms: number | null;
  senders: Sender[];
  labels: string[];
}

export interface Evidence {
  senders: (Sender & { faces: number })[];
  labels: { name: string; faces: number }[];
}

export interface Scored {
  person: string;
  score: number;
}

export interface Cluster {
  size: number;
  photos: number;
  years: [number, number] | null;
  year_count: number;
  faces: ClusterFace[];
  outliers: string[];
  chat_share: number;
  suggested: Scored[];
  evidence: Evidence;
  rule: string;
}

export interface Maybe {
  faces: { face: string; score: number; crop: string | null }[];
}

export interface ModelImage {
  faces: { box: Box }[];
  names: ({ who: string; shown: string } | null)[];
}

export function faceKey(photo: string, box: Box): string {
  return `${photo}:${box.map((value) => Math.round(value)).join(",")}`;
}


export const scanGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["faces", "height", "pipeline", "status", "vectors", "width"])) {
    return ["content must have exactly pipeline, status, width, height, faces and vectors"];
  }
  const violations: string[] = [];
  if (typeof content.pipeline !== "string" || !DIGEST.test(content.pipeline)) violations.push("pipeline must be a digest, sha256: and 64 lowercase hex");
  if (content.status === "unreadable") {
    if (content.width !== null || content.height !== null || content.faces !== null || content.vectors !== null) {
      violations.push("an unreadable photo states width, height, faces and vectors as null");
    }
    return violations;
  }
  if (content.status !== "ok") return [...violations, "status must be ok or unreadable"];
  const { width, height, faces, vectors } = content;
  if (!positiveInteger(width)) violations.push("width must be a positive integer");
  if (!positiveInteger(height)) violations.push("height must be a positive integer");
  if (!Array.isArray(faces)) return [...violations, "faces must be an array"];
  if (faces.length === 0 ? vectors !== null : typeof vectors !== "string" || !BLOB_REF.test(vectors)) {
    violations.push("vectors must be a blob reference when a face was found, else null");
  }
  faces.forEach((face, index) => {
    const at = `faces[${index}]`;
    if (!isObject(face) || !exact(face, ["box", "crop", "landmarks", "score", "size", "tier"])) {
      violations.push(`${at} must have exactly box, landmarks, score, size, tier and crop`);
      return;
    }
    violations.push(...boxViolations(face.box, width, height, at));
    if (!Array.isArray(face.landmarks) || face.landmarks.length !== 5 || !face.landmarks.every((point) => Array.isArray(point) && point.length === 2 && point.every(finite))) {
      violations.push(`${at}.landmarks must be five points of two finite numbers`);
    }
    if (!finite(face.score) || !finite(face.size) || (face.size as number) < 0) violations.push(`${at}.score and size must be finite, size not negative`);
    violations.push(...cropViolations(face.tier, face.crop, at));
  });
  return violations;
};

export const namedGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["labels", "photos"])) return ["content must have exactly photos and labels"];
  const violations: string[] = [];
  const { photos, labels } = content;
  if (!Array.isArray(photos) || photos.length === 0) violations.push("photos must be a list of at least one face");
  else {
    photos.forEach((photo, index) => {
      const at = `photos[${index}]`;
      if (!isObject(photo) || !exact(photo, ["at_ms", "camera", "crop", "face", "size", "tier"])) {
        violations.push(`${at} must have exactly face, at_ms, camera, crop, tier and size`);
        return;
      }
      if (typeof photo.face !== "string" || parseFaceKey(photo.face) === null) violations.push(`${at}.face must be a face key`);
      if (photo.at_ms !== null && !Number.isSafeInteger(photo.at_ms)) violations.push(`${at}.at_ms must be integer milliseconds or null`);
      if (typeof photo.camera !== "boolean") violations.push(`${at}.camera must be a boolean`);
      if (!finite(photo.size) || (photo.size as number) < 0) violations.push(`${at}.size must be finite, not negative`);
      violations.push(...cropViolations(photo.tier, photo.crop, at));
    });
    const faces = photos.map((photo) => (photo as { face: string }).face);
    const order = photos.map((photo) => [(photo as { at_ms: number | null }).at_ms === null ? 1 : 0, -((photo as { at_ms: number | null }).at_ms ?? 0), (photo as { face: string }).face]);
    if (violations.length === 0 && (!ordered(order) || new Set(faces).size !== faces.length)) violations.push("photos must be newest first, untimed last, then by face key, each once");
  }
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string" && label.trim() !== "") || !ordered(labels.map((label) => [label as string]))) {
    violations.push("labels must be names, sorted, each once");
  }
  return violations;
};

function cropViolations(tier: Json | undefined, crop: Json | undefined, at: string): string[] {
  if (typeof tier !== "string" || !TIERS.includes(tier)) return [`${at}.tier must be seed, assign or observe`];
  return (tier === "observe" ? crop === null : typeof crop === "string" && BLOB_REF.test(crop)) ? [] : [`${at}.crop must be a blob reference for a seed or assign face, null for an observe face`];
}

export const clusterGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["chat_share", "evidence", "faces", "outliers", "photos", "rule", "size", "suggested", "year_count", "years"])) {
    return ["content must have exactly size, photos, years, year_count, faces, outliers, chat_share, suggested, evidence and rule"];
  }
  const violations: string[] = [];
  const { size, photos, years, year_count, faces, outliers, chat_share, suggested, evidence, rule } = content;
  if (typeof rule !== "string" || !DIGEST.test(rule)) violations.push("rule must be a digest, sha256: and 64 lowercase hex");
  if (!positiveInteger(size)) violations.push("size must be a positive integer");
  if (!positiveInteger(photos) || (positiveInteger(size) && (photos as number) > (size as number))) violations.push("photos must be a positive integer, at most size");
  const span = years !== null && Array.isArray(years) && years.length === 2 && years.every((year) => Number.isSafeInteger(year)) && (years[0] as number) <= (years[1] as number);
  if (years !== null && !span) violations.push("years must be [first, last] whole years, or null");
  if (!Number.isSafeInteger(year_count) || (year_count as number) < 0) violations.push("year_count must be a whole number");
  else if (years === null ? year_count !== 0 : span && !spans(year_count as number, years as [number, number])) {
    violations.push("year_count must be 0 with no years, else the distinct years its photos span, the first and the last among them");
  }
  violations.push(...clusterFacesViolations(faces, size, photos));
  if (!Array.isArray(outliers) || outliers.length > OUTLIERS_SIZE || outliers.some((key) => typeof key !== "string" || parseFaceKey(key) === null) || new Set(outliers).size !== outliers.length) {
    violations.push(`outliers must be at most ${OUTLIERS_SIZE} distinct face keys`);
  }
  if (!finite(chat_share) || (chat_share as number) < 0 || (chat_share as number) > 1 || Math.round((chat_share as number) * 100) / 100 !== chat_share) {
    violations.push("chat_share must be a share from 0 to 1, to 2 places");
  }
  const slugged = !Array.isArray(suggested) || suggested.every((each) => !isObject(each) || typeof each.person !== "string" || SLUG.test(each.person));
  if (!slugged) violations.push(notASlug("each suggested person"));
  else if (!Array.isArray(suggested) || suggested.length > SUGGESTED_SIZE || !suggested.every(isScored) || new Set(suggested.map((each) => (each as { person: string }).person)).size !== suggested.length ||
    !best(suggested as unknown as Scored[])) {
    violations.push(`suggested must be at most ${SUGGESTED_SIZE} distinct people, each a slug and a score, best first`);
  }
  violations.push(...evidenceViolations(evidence, positiveInteger(size) ? (size as number) : Infinity));
  return violations;
};

function clusterFacesViolations(faces: Json | undefined, size: Json | undefined, photos: Json | undefined): string[] {
  const each = Array.isArray(faces) && faces.every((face) => isObject(face) && exact(face, ["at_ms", "crop", "face"]) && typeof face.face === "string" && parseFaceKey(face.face) !== null &&
    (face.at_ms === null || Number.isSafeInteger(face.at_ms)) && (face.crop === null || (typeof face.crop === "string" && BLOB_REF.test(face.crop))));
  if (!each) return ["faces must be a list of a face key, its photo's time and its crop"];
  const keys = (faces as { face: string }[]).map((face) => face.face);
  if (!ordered(keys.map((key) => [key]))) return ["faces must be by face key, each once"];
  if (keys.length !== size || new Set(keys.map((key) => parseFaceKey(key)!.photo)).size !== photos) return ["faces must be size faces on photos photos"];
  return [];
}

function evidenceViolations(evidence: Json | undefined, size: number): string[] {
  if (!isObject(evidence) || !exact(evidence, ["labels", "senders"]) || !Array.isArray(evidence.senders) || !Array.isArray(evidence.labels)) {
    return ["evidence must have exactly senders and labels, two lists"];
  }
  const violations: string[] = [];
  const counted = (faces: Json | undefined) => positiveInteger(faces) && (faces as number) <= size;
  const senders = evidence.senders;
  if (senders.length > EVIDENCE_SIZE || !senders.every((sender) => isObject(sender) && exact(sender, ["faces", "kind", "value"]) && isSender(sender) && counted(sender.faces))) {
    violations.push(`evidence.senders must be at most ${EVIDENCE_SIZE} senders, each a kind, a value and the faces it touches`);
  } else if (!ordered(senders.map((sender) => [-(sender as { faces: number }).faces, (sender as { value: string }).value, (sender as { kind: string }).kind]))) {
    violations.push("evidence.senders must be the most faces first, then by value and kind, each once");
  }
  const labels = evidence.labels;
  if (labels.length > EVIDENCE_SIZE || !labels.every((label) => isObject(label) && exact(label, ["faces", "name"]) && typeof label.name === "string" && label.name !== "" && counted(label.faces))) {
    violations.push(`evidence.labels must be at most ${EVIDENCE_SIZE} names, each with the faces it touches`);
  } else if (!ordered(labels.map((label) => [-(label as { faces: number }).faces, (label as { name: string }).name]))) {
    violations.push("evidence.labels must be the most faces first, then by name, each once");
  }
  return violations;
}

export const maybeGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["faces"]) || !Array.isArray(content.faces)) return ["content must have exactly faces, a list"];
  const faces = content.faces;
  const each = faces.every((face) => isObject(face) && exact(face, ["crop", "face", "score"]) && typeof face.face === "string" && parseFaceKey(face.face) !== null && isScore(face.score) &&
    (face.crop === null || (typeof face.crop === "string" && BLOB_REF.test(face.crop))));
  if (faces.length === 0 || faces.length > MAYBE_SIZE || !each) return [`faces must be 1 to ${MAYBE_SIZE} faces, each a face key, a score and a crop`];
  return ordered(faces.map((face) => [-(face as { score: number }).score, (face as { face: string }).face])) ? [] : ["faces must be best first, then by key, each once"];
};

function isScored(value: Json): boolean {
  return isObject(value) && exact(value, ["person", "score"]) && typeof value.person === "string" && SLUG.test(value.person) && isScore(value.score);
}

function isScore(value: Json | undefined): boolean {
  return finite(value) && (value as number) >= 0 && (value as number) <= 1 && Math.round((value as number) * 10_000) / 10_000 === value;
}

function best(scored: readonly Scored[]): boolean {
  return scored.every((each, index) => index === 0 || scored[index - 1]!.score >= each.score);
}

export const modelImageGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["faces", "names"]) || !Array.isArray(content.faces) || !Array.isArray(content.names)) {
    return ["content must have exactly faces and names, two arrays"];
  }
  const violations: string[] = [];
  content.faces.forEach((face, index) => {
    if (!isObject(face) || !exact(face, ["box"]) || boxOf(face.box) === null) violations.push(`faces[${index}] must have exactly a box of four finite numbers`);
  });
  if (content.names.length !== content.faces.length) violations.push("names must hold one entry per face");
  content.names.forEach((name, index) => {
    if (name === null) return;
    if (!isObject(name) || !exact(name, ["shown", "who"]) || typeof name.who !== "string" || !name.who.startsWith("person:") || typeof name.shown !== "string" || name.shown === "") {
      violations.push(`names[${index}] must be null, or exactly a who (person:<slug>) and a non-empty shown`);
    }
  });
  return violations;
};

export const imageGuard: Guard = (content) => {
  if (!isObject(content) || !exact(content, ["at_ms", "chat", "labels", "library", "senders"])) return ["content must have exactly library, chat, at_ms, senders and labels"];
  const violations: string[] = [];
  if (typeof content.library !== "boolean" || typeof content.chat !== "boolean") violations.push("library and chat must be booleans");
  else if (!content.library && !content.chat) violations.push("an image is named by a library photo, a chat message or both");
  if (content.at_ms !== null && !Number.isSafeInteger(content.at_ms)) violations.push("at_ms must be integer milliseconds or null");
  const { senders, labels } = content;
  if (!Array.isArray(senders) || !senders.every((sender) => isObject(sender) && exact(sender, ["kind", "value"]) && isSender(sender))) {
    violations.push(`senders must be a list of a kind (${SENDER_KINDS.join(", ")}) and a value`);
  } else if (!ordered(senders.map((sender) => [(sender as { kind: string }).kind, (sender as { value: string }).value]))) {
    violations.push("senders must be sorted by kind, then value, each once");
  } else if (senders.length > 0 && content.chat !== true) violations.push("only an image a chat names has a sender");
  if (!Array.isArray(labels) || !labels.every((label) => typeof label === "string" && label.trim() !== "")) violations.push("labels must be a list of names");
  else if (!ordered(labels.map((label) => [label as string]))) violations.push("labels must be sorted, each once");
  else if (labels.length > 0 && content.library !== true) violations.push("only an image a library names has labels");
  return violations;
};

function spans(count: number, [first, last]: [number, number]): boolean {
  return count >= (first === last ? 1 : 2) && count <= last - first + 1;
}

function isSender(value: { [member: string]: Json }): boolean {
  return typeof value.kind === "string" && (SENDER_KINDS as readonly string[]).includes(value.kind) && typeof value.value === "string" && value.value !== "";
}

function ordered(tuples: (string | number)[][]): boolean {
  return tuples.every((tuple, index) => index === 0 || compareTuples(tuples[index - 1]!, tuple) < 0);
}

function compareTuples(left: (string | number)[], right: (string | number)[]): number {
  for (let at = 0; at < Math.max(left.length, right.length); at++) {
    const a = left[at], b = right[at];
    if (a === b) continue;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

const GONE_KINDS = new Set([IMAGE_KIND, FACES_KIND, NAMED_KIND, CLUSTER_KIND, MAYBE_KIND]);

const goneOnly: Guard = () => ["a faces record is stated only gone: a photo's faces are its scan's, and who they are its person's named record"];

const GUARDS: Record<string, Guard> = {
  [IMAGE_KIND]: imageGuard, [SCAN_KIND]: scanGuard, [FACES_KIND]: goneOnly, [NAMED_KIND]: namedGuard, [CLUSTER_KIND]: clusterGuard, [MODEL_IMAGE_KIND]: modelImageGuard, [MAYBE_KIND]: maybeGuard,
};
const KEYS: Record<string, [RegExp, (at: string) => string]> = {
  [CLUSTER_KIND]: [CLUSTER_ID, (at) => `${at} must state a key of 16 lowercase hex`], [NAMED_KIND]: [SLUG, (at) => notASlug(`${at}'s key`)], [MAYBE_KIND]: [SLUG, (at) => notASlug(`${at}'s key`)],
};

export function facesLine(kind: string, key: string, content: Image | Scan | Named | Cluster | ModelImage | Maybe | "gone"): string {
  return canonical(content === "gone" ? { gone: true, key, kind } : { content: content as unknown as Json, key, kind });
}

export function namedBlobs(kind: string, content: Json): string[] {
  if (!isObject(content) || kind !== SCAN_KIND) return [];
  const crops = Array.isArray(content.faces) ? content.faces.flatMap((face) => (isObject(face) && typeof face.crop === "string" ? [face.crop] : [])) : [];
  return [...new Set([...(typeof content.vectors === "string" ? [content.vectors] : []), ...crops])].sort();
}

export const facesConnector: Reader = {
  name: "faces",
  kinds: GUARDS,
  async *read(delivery: Delivery, files: BlobReader): AsyncIterable<ReaderOutput> {
    const listing = delivery.files.filter((file) => file.path === FACES_FILE);
    const named = delivery.files.filter((file) => file.path !== FACES_FILE);
    const misnamed = named.find((file) => FILE.exec(file.path)?.[1] === undefined || file.blob !== `sha256:${FILE.exec(file.path)![1]}`);
    if (listing.length !== 1 || misnamed !== undefined) {
      refuse(`a faces delivery holds one ${FACES_FILE} and files named <their sha256>.jpg or .f32, not ${JSON.stringify(delivery.files.map((each) => each.path))}`);
    }
    const carried = new Set(named.map((file) => file.blob));
    const held = (blob: string): boolean => carried.has(blob) || files.has(blob);
    for (const yielding of [false, true]) {
      for await (const { bytes, line, where } of deliveredLines(files, listing[0]!)) {
        const one = row(lineText(bytes, where), line, held);
        if (yielding) yield one;
      }
    }
  },
};

function row(line: string, ordinal: number, held: (blob: string) => boolean): ReaderOutput {
  const at = `${FACES_FILE} line ${ordinal}`;
  const value = parseLine(line, at);
  if (typeof value.kind !== "string" || !(value.kind in GUARDS)) return refuse(`${at} must state kind image, scan, named, cluster, maybe or model-image, or faces gone`);
  const { kind, key } = value;
  const [pattern, words] = KEYS[kind] ?? [HEX, (where: string) => `${where} must state a key of 64 lowercase hex`];
  if (typeof key !== "string" || !pattern.test(key)) return refuse(words(at));
  if (GONE_KINDS.has(kind) && exact(value, ["gone", "key", "kind"]) && value.gone === true) return { kind, key, content: null, gone: true };
  if (!exact(value, ["content", "key", "kind"])) return refuse(`${at} must have exactly kind, key and content, or an image, faces, named, cluster or maybe kind, key and gone: true`);
  const content = value.content!;
  const violations = GUARDS[kind]!(content);
  if (violations.length > 0) return refuse(`${at}: ${violations.join("; ")}`);
  const blobs = namedBlobs(kind, content);
  const missing = blobs.find((blob) => !held(blob));
  if (missing !== undefined) return refuse(`${at}: ${missing} is neither a file of this delivery nor held by the home`);
  return { kind, key, content, ...(blobs.length === 0 ? {} : { blobs }) };
}

export function boxOf(value: Json | undefined): Box | null {
  return Array.isArray(value) && value.length === 4 && value.every(finite) ? (value as Box) : null;
}

function boxViolations(value: Json | undefined, width: Json | undefined, height: Json | undefined, at: string): string[] {
  const box = boxOf(value);
  if (box === null) return [`${at}.box must be four finite numbers`];
  const [x1, y1, x2, y2] = box;
  const inside = x1 >= 0 && y1 >= 0 && x1 <= x2 && y1 <= y2 && (typeof width !== "number" || x2 <= width) && (typeof height !== "number" || y2 <= height);
  return inside ? [] : [`${at}.box must be x1 ≤ x2 and y1 ≤ y2 inside the image`];
}

export function exact(value: { [member: string]: Json }, members: string[]): boolean {
  const names = Object.keys(value).sort();
  return names.length === members.length && names.every((name, index) => name === members[index]);
}

function finite(value: Json | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: Json | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
