import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digest, fileSha256, isObject, render, type BlobReader, type FetchedFile, type Json, type JsonObject, type MessagesAdapter, type RecordRef } from "@lifestreamprotocol/connect/sdk";
import { CAMERA_PHOTO_KIND, photoImage, photoInputs, type PhotoAdapters } from "../../shared/photo-image.js";
import { handleFrom, handleOf, makeUnder, parseFaceKey, versionId, type Memo, type OpenView, type Registered, type SourceRow, type SourceSelector, type View } from "@lifestreamprotocol/core";
import { LabelerUnavailable, type Framed, type Labeler, type LabelOutput, type LabelSince } from "../../labeler.js";
import {
  boxOf, CLUSTER_KIND, EVIDENCE_SIZE, FACES_FILE, faceKey, facesConnector, facesLine, IMAGE_KIND, MAYBE_KIND, MAYBE_SIZE, MODEL_IMAGE_KIND,
  namedBlobs, NAMED_KIND, OUTLIERS_SIZE, SCAN_KIND, SUGGESTED_SIZE, type Box, type Cluster, type ClusterFace, type Evidence, type Image, type Maybe, type ModelImage, type Named,
  type NamedFace, type Scan, type ScannedFace, type Scored, type Sender,
} from "./reader.js";

export const ENGINE_TIMEOUT_MS = 3_600_000;
const DRAW_TIMEOUT_MS = 120_000;
export const SCAN_BOUND = 2_000;
export const MODEL_FILES = ["det_10g.onnx", "w600k_r50.onnx"] as const;
const CHAT_KIND = "msg";
const REREAD_PAGE = 500;
const OUTPUT_TAIL = 4096;
const BLOB_REF = /^sha256:([0-9a-f]{64})$/;
export const SCAN_NOW = "faces:now";
export const BATTERY_BACKLOG = 500;

export const GROUP_RULE = digest({
  seed: "a seed face starts a cluster only on an image a camera took (the cameras labeler's photo); any other image's seed faces are sent as assign",
  maybe: "a face no person or cluster takes is a Maybe of its best person at the maybe bar",
  suggested: "a cluster's suggestions are scored, and never a person any of its faces says it is not",
});

export const CBOR_PIPELINE = "fcb4b19c08c509a5f10034df96f9b237805a8ece7df38556c61c3395deac2dd6";

export const MEMO_VERSION = digest({
  rule: GROUP_RULE,
  values: "image: the record, null for one the guard refuses; scan: pipeline, status, vectors and each face's box, tier, size and crop; cluster: faces, outliers and suggested; named and maybe: the record; face: what the owner's statement says, null for none",
  group: "the rule, each current scan with a face (photo, version, a camera's), each face statement (key, version), each merge, and the named, cluster and maybe heads the run leaves",
});

export interface FacesSettings {
  unit: string;
  zone: string;
  engine: string;
  models: string;
  blobs: string;
  photos: PhotoAdapters;
  messages: readonly Registered<MessagesAdapter>[];
  work: string;
  memo: (version: string) => Memo;
  timeoutMs?: number;
  scanBound?: number;
  fetch: string;
  reference: string;
  battery_backlog?: number;
  onMains?: () => boolean;
  invoke?: (command: string, requestPath: string, resultPath: string, timeoutMs: number, signal?: AbortSignal) => Ran;
}

export interface FacesLabeler extends Labeler {
  draw(photo: string, faces: readonly Framed[]): Buffer;
  install(signal?: AbortSignal): Promise<JsonObject>;
  matchOne(path: string, anchors: FaceAnchors, signal?: AbortSignal): Promise<OneMatch>;
}

export interface FaceAnchors {
  photos: { key: string; pipeline: string; vectors: string; faces: Box[]; named: { box: Box; is: string }[] }[];
  merged: Record<string, string>;
}

export type OneMatch =
  | { pipeline: string; status: "ok"; width: number; height: number; faces: { box: Box; who: string | null }[] }
  | { pipeline: string; status: "unreadable"; width: null; height: null; faces: [] };

interface Naming {
  library?: number | null;
  chat?: number | null;
  senders: Map<string, Sender>;
  labels: Set<string>;
}

interface Run {
  since: LabelSince;
  stated: Map<string, Image | null>;
  whole: boolean;
  faced: boolean;
  personed: boolean;
  scanNow: boolean;
  bound: number;
}

interface Person {
  shown: string | null;
  merged_into: string | null;
}

interface Feeds {
  photos: PhotoAdapters;
  photoSources: SourceSelector;
  photoKinds: readonly string[];
  chats: ReadonlyMap<string, NonNullable<MessagesAdapter["images"]>>;
  chatSources: SourceSelector;
}

function feedsOf(settings: Pick<FacesSettings, "photos" | "messages">): Feeds {
  const { sources, kinds } = photoInputs(settings.photos);
  const chats = new Map(settings.messages.flatMap(({ product, adapter }) => adapter.images === undefined ? [] : [[product, senderHandles(product, adapter.images.bind(adapter))] as const]));
  return { photos: settings.photos, photoSources: sources, photoKinds: kinds, chats, chatSources: { product: [...chats.keys()] } };
}

function senderHandles(product: string, images: NonNullable<MessagesAdapter["images"]>): NonNullable<MessagesAdapter["images"]> {
  return (record) => {
    const said = images(record);
    if (said?.sender?.kind !== "network") return said;
    const handle = handleFrom("network", `${product}:${said.sender.value}`) ?? handleOf(said.sender.value);
    return { ...said, sender: handle === null ? null : { kind: handle.kind, value: handle.value } };
  };
}

type Statement = { photo: string; box: Box } & ({ is: string } | { is_not: string[] } | { ignore: true });

export function facesLabeler(settings: FacesSettings): FacesLabeler {
  const source = `faces:local:${settings.unit}`;
  const people = `people:local:${settings.unit}`;
  const cameras = `cameras:local:${settings.unit}`;
  const blobPath = (hex: string) => join(settings.blobs, hex.slice(0, 2), hex.slice(2, 4), hex);
  const feeds = feedsOf(settings);

  const draw = (photo: string, faces: readonly Framed[]): Buffer => {
    if (!BLOB_REF.test(photo)) throw new TypeError(`a photo to draw is a blob, not ${photo}`);
    makeUnder(dirname(settings.work), settings.work);
    const work = mkdtempSync(join(settings.work, "draw-"));
    try {
      const output = join(work, "drawn.jpg");
      const result = engineSync(settings.engine, "draw", { images: [{ path: blobPath(photo.slice(7)), output, faces }] }, work, Math.min(settings.timeoutMs ?? Infinity, DRAW_TIMEOUT_MS), settings.invoke);
      const image = Array.isArray(result.images) && result.images.length === 1 ? result.images[0] : undefined;
      if (!isObject(image) || image.status !== "ok") throw new Error(`face-engine draw did not draw ${photo}: ${JSON.stringify(image ?? result)}`);
      return readFileSync(output);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };

  return {
    name: "faces",
    source,
    inputs: [
      { sources: feeds.photoSources, kinds: [...feeds.photoKinds] },
      { sources: feeds.chatSources, kinds: [CHAT_KIND], linked: true },
      { sources: { product: ["people"], copy: [settings.unit] }, kinds: ["person", "face"] },
      { sources: { product: ["cameras"], copy: [settings.unit] }, kinds: [CAMERA_PHOTO_KIND] },
    ],
    reading: { code: "1", borrows: ["photos", "messages"] },
    draw,
    install: (signal) => install(settings, signal),
    matchOne,

    async label(view: OpenView, blobs: BlobReader, since: LabelSince, signal?: AbortSignal) {
      const missing = notInstalled(settings);
      if (missing !== null) throw new LabelerUnavailable("not-installed", missing);

      const bound = settings.scanBound ?? SCAN_BOUND;
      const { whole, moved, erased, stated } = inventory(view, blobs, feeds, source, since);
      const faced = since.seq > 0 && statedSince(view, since.seq, [people], ["face"], 1) > 0;
      const personed = since.seq > 0 && statedSince(view, since.seq, [people], ["person"], 1) > 0;
      const photographed = since.seq > 0 && statedSince(view, since.seq, [cameras], [CAMERA_PHOTO_KIND], 1) > 0;
      const scanNow = view.tables.meta.get(SCAN_NOW) !== undefined;
      const bounded = statedSince(view, since.seq, [source], [SCAN_KIND], bound) === bound;
      const repaired = since.seq > 0 && repairedSince(view, since.seq, source);
      if (!whole && !erased && stated.size === 0 && !faced && !personed && !photographed && !scanNow && !bounded && !repaired && since.resting === undefined && (moved || statedSince(view, since.seq, [source], undefined, 1) > 0)) return null;
      const memo = settings.memo(MEMO_VERSION);
      try {
        return await labelRecords(view, blobs, memo, { since, stated, whole, faced, personed, scanNow, bound }, signal);
      } finally {
        memo.close();
      }
    },
  };

  async function matchOne(path: string, anchors: FaceAnchors, signal?: AbortSignal): Promise<OneMatch> {
    const missing = notInstalled(settings);
    if (missing !== null) throw new LabelerUnavailable("not-installed", missing);
    makeUnder(dirname(settings.work), settings.work);
    const work = mkdtempSync(join(settings.work, "match-"));
    try {
      const engine = (command: string, request: object) => runEngine(settings, command, request, work, signal);
      const output = join(work, "scan");
      const result = await engine("scan", { models: settings.models, output, photos: [{ key: ASKED, path }] });
      const pipeline = digest(readPipeline(result));
      const [photo] = readScanPhotos(result, [ASKED]);
      if (photo === null || photo === undefined) return { pipeline, status: "unreadable", width: null, height: null, faces: [] };
      const placed = (who: ReadonlyMap<string, string>): OneMatch => ({
        pipeline, status: "ok", width: photo.width, height: photo.height,
        faces: photo.faces.map(({ box }) => ({ box, who: who.has(faceKey(ASKED, box)) ? `person:${who.get(faceKey(ASKED, box))}` : null })),
      });
      const named = anchors.photos.filter((each) => each.pipeline === pipeline);
      if (photo.vectors === null || named.length === 0) return placed(new Map());
      const current = new Map<string, Seen>([
        ...named.map((each): [string, Seen] => [each.key, { pipeline, status: "ok", vectors: each.vectors, faces: each.faces.map((box) => ({ box, tier: "observe", size: 0, crop: null })) }]),
        [ASKED, { pipeline, status: "ok", vectors: null, faces: photo.faces.map(({ box, tier }) => ({ box, tier: tier === "seed" ? "assign" : tier, size: 0, crop: null })) }],
      ]);
      const grouped = readGroup(await engine("group", {
        photos: [...current].sort(([left], [right]) => compare(left, right)).map(([key, seen]) => ({
          key, vectors: key === ASKED ? join(output, photo.vectors!) : blobPath(seen.vectors!.slice(7)), faces: seen.faces.map(({ box, tier }) => ({ box, tier })),
        })),
        statements: named.flatMap((each) => each.named.map(({ box, is }) => ({ photo: each.key, box, is }))),
        people: anchors.merged,
      }), current);
      return placed(grouped.who);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }

  async function labelRecords(view: OpenView, blobs: BlobReader, memo: Memo, run: Run, signal?: AbortSignal): Promise<LabelOutput | null> {
    const { stated, faced, personed, scanNow, bound } = run;
    const merged = personed && mergesMoved(view, people, run.since.seq);
    const images = standingImages(view, memo, source, stated);
    const scans = held(view, memo, source, SCAN_KIND, seenOf);
    const named = held(view, memo, source, NAMED_KIND, (content) => content as unknown as Named);
    const clusterHeads = held(view, memo, source, CLUSTER_KIND, clusterSeen);
    const maybes = held(view, memo, source, MAYBE_KIND, (content) => content as unknown as Maybe);
    const own: Record<string, Map<string, string>> = {
      [NAMED_KIND]: versionsOf(named), [CLUSTER_KIND]: versionsOf(clusterHeads),
      [MAYBE_KIND]: versionsOf(maybes),
      [MODEL_IMAGE_KIND]: new Map([...view.heads(source, MODEL_IMAGE_KIND)].map((head) => [head.key, head.version])),
    };
    const byCamera = new Set([...view.heads(cameras, CAMERA_PHOTO_KIND)].map((head) => head.key));
    const persons = readPersons(view, people);
    const { statements, said } = readStatements(view, memo, people);
    const cborScans = new Map([...scans].flatMap(([hex, { version, value }]): [string, Scan][] => {
      if (value.pipeline !== CBOR_PIPELINE) return [];
      const content = view.version(version).content;
      return namedBlobs(SCAN_KIND, content).every((blob) => blobs.has(blob)) ? [[hex, content as unknown as Scan]] : [];
    }));

    const work = join(settings.work, "run");
    rmSync(work, { recursive: true, force: true });
    makeUnder(dirname(settings.work), work);
    const engine = (command: string, request: object) => runEngine(settings, command, request, work, signal);

    const pipeline = digest(readPipeline(await engine("scan", { models: settings.models, output: join(work, "scan"), photos: [] })));
    const scanOf = new Map([...scans].map(([hex, { version, value }]) => [hex, { version, scan: value }]));
    const restated = new Map([...cborScans].map(([hex, scan]): [string, Scan] => [hex, { ...scan, pipeline }]));
    for (const [hex, scan] of restated) scanOf.set(hex, { version: versionId(SCAN_KIND, hex, scan as unknown as Json).id, scan: seenOf(scan as unknown as Json) });
    const current = new Map<string, Seen>();
    for (const [hex, { scan }] of scanOf) {
      if (images.has(hex) && scan.pipeline === pipeline && (scan.vectors === null || blobs.has(scan.vectors))) current.set(hex, scan);
    }
    const owed = [...images.keys()].filter((hex) => !current.has(hex))
      .sort((left, right) => (images.get(right)!.at_ms ?? -Infinity) - (images.get(left)!.at_ms ?? -Infinity) || compare(left, right));
    const backlog = settings.battery_backlog ?? BATTERY_BACKLOG;
    const waits = owed.length > backlog && !scanNow && !(settings.onMains ?? onMains)();
    const taken = waits ? [] : owed.slice(0, bound);
    const files = new Map<string, string>();
    const deliver = (path: string, extension: string): string => {
      const hex = fileSha256(path);
      files.set(`${hex}.${extension}`, path);
      return `sha256:${hex}`;
    };
    const fresh = new Map<string, Scan>();
    if (taken.length > 0) {
      const output = join(work, "scan");
      const result = await engine("scan", { models: settings.models, output, photos: taken.map((hex) => ({ key: hex, path: blobPath(hex) })) });
      if (digest(readPipeline(result)) !== pipeline) unreadable("scan", "the pipeline changed during the run");
      for (const [index, photo] of readScanPhotos(result, taken).entries()) {
        const hex = taken[index]!;
        const scan: Scan = photo === null
          ? { pipeline, status: "unreadable", width: null, height: null, faces: null, vectors: null }
          : {
              pipeline, status: "ok", width: photo.width, height: photo.height,
              faces: photo.faces.map((face) => ({ ...face, crop: face.crop === null ? null : deliver(join(output, face.crop), "jpg") })),
              vectors: photo.vectors === null ? null : deliver(join(output, photo.vectors), "f32"),
            };
        fresh.set(hex, scan);
        const seen = seenOf(scan as unknown as Json);
        scanOf.set(hex, { version: versionId(SCAN_KIND, hex, scan as unknown as Json).id, scan: seen });
        current.set(hex, seen);
      }
    }
    const vectorsPath = (hex: string, scan: Seen): string | null =>
      scan.vectors === null ? null : fresh.has(hex) ? files.get(`${scan.vectors.slice(7)}.f32`)! : blobPath(scan.vectors.slice(7));
    const found = new Map<string, SeenFace & { photo: string }>();
    for (const [hex, { scan }] of scanOf) for (const face of scan.faces) found.set(faceKey(hex, face.box), { ...face, photo: hex });

    const lines: string[] = [];
    for (const [hex, image] of stated) lines.push(facesLine(IMAGE_KIND, hex, image ?? "gone"));
    const state = (kind: string, key: string, content: Named | Cluster | Maybe | ModelImage | "gone") => {
      const standing = own[kind]!;
      const version = content === "gone" ? undefined : versionId(kind, key, content as unknown as Json).id;
      if (standing.get(key) === version) return;
      lines.push(facesLine(kind, key, content));
      if (version === undefined) standing.delete(key);
      else standing.set(key, version);
    };
    const stateAll = (kind: string, made: ReadonlyMap<string, Named | Cluster | Maybe>) => {
      for (const [key, content] of made) state(kind, key, content);
      for (const key of [...own[kind]!.keys()]) if (!made.has(key)) state(kind, key, "gone");
    };
    const groupKey = (): string => digest({
      rule: GROUP_RULE,
      scans: [...current].filter(([, scan]) => scan.faces.length > 0).sort(([left], [right]) => compare(left, right))
        .map(([hex]) => [hex, scanOf.get(hex)!.version, byCamera.has(hex)]),
      said,
      merged: [...persons].flatMap(([slug, person]) => (person.merged_into === null ? [] : [[slug, person.merged_into]])),
      own: [NAMED_KIND, CLUSTER_KIND, MAYBE_KIND].map((kind) => [...own[kind]!].sort(([left], [right]) => compare(left, right))),
    });

    const settled = owed.length === taken.length;
    const owedKey = groupKey();
    const grouping = !memo.values("group", [owedKey], () => undefined).has(owedKey) && (settled || faced || merged);
    const facts: JsonObject = {
      whole: run.whole, images: stated.size, photos: images.size, pipeline, scanned: fresh.size, restated: restated.size, unreadable: [...fresh.values()].filter((scan) => scan.status === "unreadable").length,
      owed: owed.length - taken.length, sources: [{ id: source, connector: facesConnector.name }],
    };
    let who = new Map([...named].flatMap(([slug, { value }]) => value.photos.map((photo): [string, string] => [photo.face, slug])));
    let basis = standing(clusterHeads, current);
    if (grouping) {
      const grouped = readGroup(await engine("group", {
        photos: [...current].filter(([, scan]) => scan.status === "ok" && scan.faces.length > 0).sort(([left], [right]) => compare(left, right))
          .map(([hex, scan]) => ({
            key: hex, vectors: vectorsPath(hex, scan),
            faces: scan.faces.map(({ box, tier }) => ({ box, tier: tier === "seed" && !byCamera.has(hex) ? "assign" : tier })),
          })),
        statements,
        people: Object.fromEntries([...persons].flatMap(([slug, person]) => (person.merged_into === null ? [] : [[slug, person.merged_into]]))),
      }), current);
      for (const [face, slug] of who) if (!current.has(parseFaceKey(face)!.photo)) grouped.who.set(face, slug);
      who = grouped.who;
      basis = grouped.clusters;
      stateAll(MAYBE_KIND, new Map([...grouped.maybe].map(([slug, faces]): [string, Maybe] => [slug, { faces: faces.map((face) => ({ ...face, crop: found.get(face.face)!.crop })) }])));
      Object.assign(facts, { grouped: true, faces: grouped.faces, maybe: grouped.maybe.size, unmatched: grouped.unmatched });
    } else {
      stateAll(MAYBE_KIND, new Map([...maybes].flatMap(([slug, { value }]): [string, Maybe][] => {
        const faces = value.faces.filter((face) => images.has(parseFaceKey(face.face)!.photo));
        return faces.length === 0 ? [] : [[slug, { faces }]];
      })));
      facts.grouped = false;
    }
    for (const [face, slug] of who) if (!images.has(parseFaceKey(face)!.photo)) who.delete(face);
    stateAll(NAMED_KIND, namedRecords(who, images, found, byCamera, named));
    const clusters = clusterRecords(basis, images, found, clusterHeads, settings.zone);
    stateAll(CLUSTER_KIND, clusters);
    facts.clusters = clusters.size;
    for (const [hex, scan] of [...restated, ...fresh]) lines.push(facesLine(SCAN_KIND, hex, scan));

    const stating = grouping || settled || personed;
    for (const [hex, image] of (stating ? [...images] : [...fresh.keys()].flatMap((hex) => images.has(hex) ? [[hex, images.get(hex)!] as const] : [])).sort(([left], [right]) => compare(left, right))) {
      const scan = current.get(hex);
      if (!image.library || scan?.status !== "ok" || (!fresh.has(hex) && !grouping && !settled && !own[MODEL_IMAGE_KIND]!.has(hex))) continue;
      state(MODEL_IMAGE_KIND, hex, modelImage(hex, scan, who, persons));
    }
    if (grouping) memo.values("group", [groupKey()], () => true);

    const output = lines.length === 0 ? null : {
      files: [{ path: FACES_FILE, bytes: Buffer.from(lines.map((line) => `${line}\n`).join("")) }, ...[...files].map(([path, file]): FetchedFile => ({ path, file }))],
      facts,
    };
    if (waits) throw new LabelerUnavailable("waiting-for-power", `${owed.length} images are owed a scan, more than faces.battery_backlog (${backlog}): the scan waits for mains power, or Scan now`, output);
    return output;
  }
}

const ASKED = "asked";

export function faceAnchors(view: Pick<View, "records" | "head" | "version">, unit: string): FaceAnchors {
  const people = `people:local:${unit}`;
  const byPhoto = new Map<string, { box: Box; is: string }[]>();
  for (const { head, version } of view.records(people, "face")) {
    const said = saidOf(version.content);
    const at = parseFaceKey(head.key);
    if (at === null || said === null || !("is" in said)) continue;
    byPhoto.set(at.photo, [...byPhoto.get(at.photo) ?? [], { box: at.box, is: said.is }]);
  }
  const photos = [...byPhoto].sort(([left], [right]) => compare(left, right)).flatMap(([key, named]): FaceAnchors["photos"] => {
    const head = view.head({ source: `faces:local:${unit}`, kind: SCAN_KIND, key });
    if (head === undefined || head.version === "gone") return [];
    const scan = seenOf(view.version(head.version).content);
    return scan.status !== "ok" || scan.vectors === null ? [] : [{ key, pipeline: scan.pipeline, vectors: scan.vectors, faces: scan.faces.map(({ box }) => box), named }];
  });
  const merged = Object.fromEntries([...readPersons(view, people)].flatMap(([slug, person]) => (person.merged_into === null ? [] : [[slug, person.merged_into]])));
  return { photos, merged };
}

async function install(settings: FacesSettings, signal?: AbortSignal): Promise<JsonObject> {
  if (!engineBuilt(settings.engine)) throw new Error(engineMissing(settings.engine));
  const unchecked = uncheckedOf(settings.models);
  mkdirSync(dirname(unchecked), { recursive: true });
  writeFileSync(unchecked, "");
  if (MODEL_FILES.some((file) => !existsSync(join(settings.models, file)))) {
    const fetched = await run("sh", [settings.fetch, settings.models], settings.timeoutMs ?? ENGINE_TIMEOUT_MS, signal);
    if (fetched.code !== 0) throw new Error(`fetching the face models failed: ${fetched.timedOut ? "timeout" : `exit ${fetched.code ?? fetched.signal}`}: ${fetched.stderr.trim()}`);
  }
  const check = checkEngine(settings.engine, settings.models, settings.reference, settings.timeoutMs);
  rmSync(unchecked, { force: true });
  return check;
}

function notInstalled(settings: FacesSettings): string | null {
  if (!engineBuilt(settings.engine)) return engineMissing(settings.engine);
  const missing = MODEL_FILES.filter((file) => !existsSync(join(settings.models, file)));
  if (missing.length > 0) return `the face models are not installed: ${missing.join(", ")} missing from ${settings.models} (lifestream faces on)`;
  return modelsInstalled(settings.models) ? null : `the face models in ${settings.models} have not passed the engine's self-check (lifestream faces on checks them again)`;
}

function engineBuilt(engine: string): boolean {
  try {
    accessSync(engine, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const engineMissing = (engine: string) => `the face engine is not built: ${engine} is missing (swift build -c release in faces/)`;

function onMains(): boolean {
  const said = spawnSync("pmset", ["-g", "ps"], { encoding: "utf8", timeout: 10_000 });
  return said.status !== 0 || !said.stdout.includes("'Battery Power'");
}

export function modelsInstalled(models: string): boolean {
  return MODEL_FILES.every((file) => existsSync(join(models, file))) && !existsSync(uncheckedOf(models));
}

function uncheckedOf(models: string): string {
  return `${models}.unchecked`;
}

export function checkEngine(engine: string, models: string, reference: string, timeoutMs = ENGINE_TIMEOUT_MS): JsonObject {
  const work = mkdtempSync(join(tmpdir(), "face-engine-check-"));
  try {
    const check = engineSync(engine, "self-check", { models, reference }, work, timeoutMs);
    if (check.ok !== true) throw new Error(`face-engine self-check did not pass: ${JSON.stringify(check)}`);
    return check;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function inventory(view: OpenView, blobs: BlobReader, feeds: Feeds, source: string, since: LabelSince): { whole: boolean; moved: boolean; erased: boolean; stated: Map<string, Image | null> } {
  const whole = since.seq === 0;
  const stated = new Map<string, Image | null>();
  const state = (hex: string, image: Image | null) => {
    const held = view.head({ source, kind: IMAGE_KIND, key: hex })?.version ?? "gone";
    if (held !== (image === null ? "gone" : versionId(IMAGE_KIND, hex, image as unknown as Json).id)) stated.set(hex, image);
  };
  if (whole) {
    const images = readImages(view, blobs, feeds);
    for (const { key } of view.heads(source, IMAGE_KIND)) if (!images.has(key)) state(key, null);
    for (const [hex, image] of images) state(hex, image);
    return { whole, moved: true, erased: false, stated };
  }
  const inputs = inputsOf(view, feeds);
  const { hexes, erased } = movedImages(view, inputs, since);
  for (const hex of hexes) state(hex, imageOf(view, blobs, feeds, inputs, hex));
  return { whole, moved: hexes.size > 0, erased, stated };
}

function standingImages(view: OpenView, memo: Memo, source: string, stated: Map<string, Image | null>): Map<string, Image> {
  const images = new Map<string, Image>();
  for (const [hex, { value }] of held(view, memo, source, IMAGE_KIND, (content) => content as unknown as Image)) if (!stated.has(hex)) images.set(hex, value);
  for (const [hex, image] of stated) if (image !== null) images.set(hex, image);
  return images;
}

function repairedSince(view: OpenView, after: number, source: string): boolean {
  for (const statement of view.statements(after, { sources: [source] })) if (statement.origin === "repair") return true;
  return false;
}

function statedSince(view: OpenView, after: number, sources: string[], kinds: string[] | undefined, most: number): number {
  let count = 0;
  for (const _ of view.statements(after, kinds === undefined ? { sources } : { sources, kinds })) if (++count === most) break;
  return count;
}

type Inputs = Readonly<Record<string, readonly SourceRow[]>>;

function inputsOf(view: OpenView, feeds: Feeds): Inputs {
  const photos = view.sources(feeds.photoSources);
  return { ...Object.fromEntries(feeds.photoKinds.map((kind) => [kind, photos])), [CHAT_KIND]: view.sources(feeds.chatSources) };
}

function readImages(view: OpenView, blobs: BlobReader, feeds: Feeds): Map<string, Image> {
  const named = new Map<string, Naming>();
  const add = (hex: string, note: (naming: Naming) => void) => {
    if (!blobs.has(`sha256:${hex}`)) return;
    const naming = named.get(hex) ?? { senders: new Map(), labels: new Set() };
    note(naming);
    named.set(hex, naming);
  };
  for (const row of view.sources(feeds.photoSources)) {
    for (const kind of feeds.photoKinds) {
      for (const { head, version } of view.records(row.id, kind)) {
        const hex = photoImage(view, feeds.photos, row, head, version);
        if (hex !== null) add(hex, (naming) => noteLibrary(naming, head.start_ms, version.content));
      }
    }
  }
  for (const row of view.sources(feeds.chatSources)) {
    const images = feeds.chats.get(row.product)!;
    for (const { head } of view.linked(row.id, CHAT_KIND)) {
      const said = images({ source: row, version: view.version(head.version) });
      for (const hash of said?.blobs ?? []) add(hash.slice("sha256:".length), (naming) => noteChat(naming, head.start_ms, said!.sender));
    }
  }
  return new Map([...named].map(([hex, naming]) => [hex, imageOfNaming(naming)]));
}

function movedImages(view: OpenView, inputs: Inputs, since: LabelSince): { hexes: Set<string>; erased: boolean } {
  const sourcesOf = new Map(Object.entries(inputs).map(([kind, rows]) => [kind, new Set(rows.map((row) => row.id))]));
  const input = (record: RecordRef) => sourcesOf.get(record.kind)?.has(record.source) === true;
  const records = new Map<string, RecordRef>();
  const sources = [...new Set([...sourcesOf.values()].flatMap((each) => [...each]))];
  for (const statement of view.statements(since.seq, { sources, kinds: [...sourcesOf.keys()] })) {
    if (input(statement)) records.set(`${statement.source}\0${statement.kind}\0${statement.key}`, { source: statement.source, kind: statement.kind, key: statement.key });
  }
  const versions = new Set<string>();
  let erased = false;
  for (const record of records.values()) {
    let replaced: string | undefined;
    for (const statement of view.history(record)) {
      if (statement.seq > since.seq) versions.add(statement.version);
      else if (!statement.late) replaced = statement.version;
    }
    if (replaced !== undefined) versions.add(replaced);
  }
  for (let after = since.reread; ;) {
    const page = view.rereads(after, REREAD_PAGE);
    for (const reread of page) {
      erased ||= !("record" in reread);
      if (!("record" in reread) || !input(reread.record)) continue;
      const head = view.head(reread.record);
      if (head !== undefined) versions.add(head.version);
    }
    if (page.length < REREAD_PAGE) break;
    after = page.at(-1)!.seq;
  }
  versions.delete("gone");
  const hexes = new Set<string>();
  for (const version of versions) for (const blob of view.blobsOf(version)) hexes.add(blob.slice("sha256:".length));
  return { hexes, erased };
}

function imageOf(view: OpenView, blobs: BlobReader, feeds: Feeds, inputs: Inputs, hex: string): Image | null {
  const hash = `sha256:${hex}`;
  if (!blobs.has(hash)) return null;
  const naming: Naming = { senders: new Map(), labels: new Set() };
  for (const version of view.naming(hash)) {
    for (const row of inputs[version.kind] ?? []) {
      const head = view.head({ source: row.id, kind: version.kind, key: version.key });
      if (head?.version !== version.id) continue;
      if (feeds.photoKinds.includes(version.kind)) {
        if (photoImage(view, feeds.photos, row, head, version) === hex) noteLibrary(naming, head.start_ms, version.content);
        continue;
      }
      const said = feeds.chats.get(row.product)?.({ source: row, version }) ?? null;
      if (said?.blobs.includes(hash) === true) noteChat(naming, head.start_ms, said.sender);
    }
  }
  return naming.library === undefined && naming.chat === undefined ? null : imageOfNaming(naming);
}

function noteLibrary(naming: Naming, at_ms: number | null, content: Json): void {
  naming.library = earliest(naming.library, at_ms);
  for (const name of sidecarPeople(content)) naming.labels.add(name);
}

function noteChat(naming: Naming, at_ms: number | null, sender: Sender | null): void {
  naming.chat = earliest(naming.chat, at_ms);
  if (sender !== null) naming.senders.set(`${sender.kind}\0${sender.value}`, sender);
}

function earliest(known: number | null | undefined, at_ms: number | null): number | null {
  return known === undefined || known === null ? at_ms : at_ms === null ? known : Math.min(known, at_ms);
}

function imageOfNaming(naming: Naming): Image {
  return {
    library: naming.library !== undefined, chat: naming.chat !== undefined, at_ms: naming.library ?? naming.chat ?? null,
    senders: [...naming.senders.values()].sort((left, right) => compare(left.kind, right.kind) || compare(left.value, right.value)),
    labels: [...naming.labels].sort(compare),
  };
}

function sidecarPeople(content: Json): string[] {
  if (!isObject(content) || content.type !== "photos.asset" || !Array.isArray(content.people)) return [];
  return content.people.flatMap((person) => isObject(person) && typeof person.name === "string" && person.name.trim() !== "" ? [person.name] : []);
}

function held<T>(view: OpenView, memo: Memo, source: string, kind: string, value: (content: Json) => T): Map<string, { version: string; value: T }> {
  const heads = [...view.heads(source, kind)];
  const values = memo.values(kind, heads.map((head) => head.version), (version) => value(view.version(version).content));
  return new Map(heads.map((head) => [head.key, { version: head.version, value: values.get(head.version)! }]));
}

function versionsOf(records: ReadonlyMap<string, { version: string }>): Map<string, string> {
  return new Map([...records].map(([key, { version }]) => [key, version]));
}

interface SeenFace {
  box: Box;
  tier: ScannedFace["tier"];
  size: number;
  crop: string | null;
}

interface Seen {
  pipeline: string;
  status: Scan["status"];
  vectors: string | null;
  faces: SeenFace[];
}

function seenOf(content: Json): Seen {
  const scan = content as unknown as Scan;
  return {
    pipeline: scan.pipeline, status: scan.status, vectors: scan.vectors,
    faces: (scan.faces ?? []).map(({ box, tier, size, crop }) => ({ box, tier, size, crop })),
  };
}

interface ClusterSeen {
  faces: ClusterFace[];
  outliers: string[];
  suggested: Scored[];
}

function clusterSeen(content: Json): ClusterSeen {
  const cluster = content as unknown as Partial<Cluster>;
  return { faces: Array.isArray(cluster.faces) ? cluster.faces : [], outliers: cluster.outliers ?? [], suggested: Array.isArray(cluster.suggested) ? cluster.suggested : [] };
}

function readPersons(view: Pick<View, "records">, source: string): Map<string, Person> {
  const persons = new Map<string, Person>();
  const text = (value: Json | undefined) => (typeof value === "string" && value.trim() !== "" ? value : null);
  for (const { head, version } of view.records(source, "person")) {
    const content = version.content;
    if (!isObject(content)) continue;
    const shown = (content.show === "full_name" ? text(content.full_name) : null) ?? text(content.name);
    persons.set(head.key, { shown, merged_into: text(content.merged_into) });
  }
  return persons;
}

function modelImage(hex: string, scan: Seen, who: ReadonlyMap<string, string>, persons: ReadonlyMap<string, Person>): ModelImage {
  return {
    faces: scan.faces.map(({ box }) => ({ box })),
    names: scan.faces.map(({ box }) => {
      const slug = who.get(faceKey(hex, box));
      const shown = slug === undefined ? null : persons.get(slug)?.shown ?? null;
      return slug === undefined || shown === null ? null : { who: `person:${slug}`, shown };
    }),
  };
}

function mergesMoved(view: OpenView, source: string, after: number): boolean {
  const mergedInto = (version: string): Json | null => {
    if (version === "gone") return null;
    const content = view.version(version).content;
    return isObject(content) && typeof content.merged_into === "string" ? content.merged_into : null;
  };
  const keys = new Set<string>();
  for (const statement of view.statements(after, { sources: [source], kinds: ["person"] })) keys.add(statement.key);
  for (const key of keys) {
    const record = { source, kind: "person", key };
    let before = "gone";
    for (const statement of view.history(record)) if (statement.seq <= after && !statement.late) before = statement.version;
    if (mergedInto(before) !== mergedInto(view.head(record)?.version ?? "gone")) return true;
  }
  return false;
}

type Said = { is: string } | { is_not: string[] } | { ignore: true } | null;

function readStatements(view: OpenView, memo: Memo, source: string): { statements: Statement[]; said: [string, string][] } {
  const statements: Statement[] = [];
  const said: [string, string][] = [];
  for (const [key, { version, value }] of held(view, memo, source, "face", saidOf)) {
    said.push([key, version]);
    const at = parseFaceKey(key);
    if (at !== null && value !== null) statements.push({ ...at, ...value });
  }
  return { statements, said };
}

function saidOf(content: Json): Said {
  if (!isObject(content)) return null;
  if (typeof content.is === "string") return { is: content.is };
  if (Array.isArray(content.is_not)) return { is_not: content.is_not as string[] };
  return content.ignore === true ? { ignore: true } : null;
}

interface Grouped {
  who: Map<string, string>;
  clusters: Basis;
  maybe: Map<string, { face: string; score: number }[]>;
  faces: number;
  unmatched: number;
}

type Basis = Map<string, { members: { face: string; photo: string }[]; outliers: string[]; suggested: Scored[] }>;

function standing(clusters: ReadonlyMap<string, { value: ClusterSeen }>, current: ReadonlyMap<string, Seen>): Basis {
  return new Map([...clusters].map(([id, { value }]) => [id, {
    members: value.faces.map(({ face }) => ({ face, photo: parseFaceKey(face)!.photo })).filter((member) => current.has(member.photo)), outliers: value.outliers, suggested: value.suggested,
  }]));
}

function clusterRecords(basis: Basis, images: ReadonlyMap<string, Image>, found: ReadonlyMap<string, SeenFace>, held: ReadonlyMap<string, { value: ClusterSeen }>, zone: string): Map<string, Cluster> {
  const crops = new Map([...held.values()].flatMap(({ value }) => value.faces.map((face): [string, string | null] => [face.face, face.crop])));
  const records = new Map<string, Cluster>();
  for (const [id, { members, outliers, suggested }] of basis) {
    if (members.length === 0) continue;
    const faces = members.map(({ face, photo }): ClusterFace => ({ face, at_ms: images.get(photo)?.at_ms ?? null, crop: found.get(face)?.crop ?? crops.get(face) ?? null }))
      .sort((left, right) => compare(left.face, right.face));
    const years = faces.flatMap((face) => (face.at_ms === null ? [] : [Number(render(face.at_ms, zone, "minute").slice(0, 4))]));
    const chat = members.filter((member) => images.get(member.photo)?.chat === true && images.get(member.photo)?.library !== true).length;
    records.set(id, {
      size: members.length,
      photos: new Set(members.map((member) => member.photo)).size,
      years: years.length === 0 ? null : [Math.min(...years), Math.max(...years)],
      year_count: new Set(years).size,
      faces,
      outliers,
      chat_share: Math.round((100 * chat) / members.length) / 100,
      suggested,
      evidence: evidenceOf(members.map((member) => images.get(member.photo))),
      rule: GROUP_RULE,
    });
  }
  return records;
}

function evidenceOf(images: readonly (Image | undefined)[]): Evidence {
  const senders = new Map<string, Sender & { faces: number }>();
  const labels = new Map<string, number>();
  for (const image of images) {
    for (const sender of image?.senders ?? []) {
      const key = `${sender.kind}\0${sender.value}`;
      senders.set(key, { kind: sender.kind, value: sender.value, faces: (senders.get(key)?.faces ?? 0) + 1 });
    }
    for (const name of image?.labels ?? []) labels.set(name, (labels.get(name) ?? 0) + 1);
  }
  return {
    senders: [...senders.values()].sort((left, right) => right.faces - left.faces || compare(left.value, right.value) || compare(left.kind, right.kind))
      .slice(0, EVIDENCE_SIZE).map(({ kind, value, faces }) => ({ faces, kind, value })),
    labels: [...labels].map(([name, faces]) => ({ faces, name })).sort((left, right) => right.faces - left.faces || compare(left.name, right.name)).slice(0, EVIDENCE_SIZE),
  };
}

function namedRecords(who: ReadonlyMap<string, string>, images: ReadonlyMap<string, Image>, found: ReadonlyMap<string, SeenFace & { photo: string }>,
  byCamera: ReadonlySet<string>, held: ReadonlyMap<string, { value: Named }>): Map<string, Named> {
  const before = new Map([...held.values()].flatMap(({ value }) => value.photos.map((photo): [string, NamedFace] => [photo.face, photo])));
  const counted = new Map<string, number>();
  for (const { photo } of found.values()) counted.set(photo, (counted.get(photo) ?? 0) + 1);
  const faces = new Map<string, NamedFace[]>();
  const labels = new Map<string, Set<string>>();
  for (const [face, slug] of who) {
    const photo = parseFaceKey(face)!.photo;
    const scanned = found.get(face) ?? before.get(face)!;
    faces.set(slug, [...faces.get(slug) ?? [], {
      face, at_ms: images.get(photo)?.at_ms ?? null, camera: byCamera.has(photo), crop: scanned.crop, tier: scanned.tier, size: scanned.size,
    }]);
    if (counted.get(photo) === 1) for (const label of images.get(photo)?.labels ?? []) (labels.get(slug) ?? labels.set(slug, new Set()).get(slug)!).add(label);
  }
  return new Map([...faces].sort(([left], [right]) => compare(left, right)).map(([slug, photos]): [string, Named] => [slug, {
    photos: photos.sort((left, right) => (right.at_ms ?? -Infinity) - (left.at_ms ?? -Infinity) || compare(left.face, right.face)),
    labels: [...labels.get(slug) ?? []].sort(compare),
  }]));
}


export async function runEngine(settings: Pick<FacesSettings, "engine" | "timeoutMs" | "invoke">, command: string, request: object, work: string, signal?: AbortSignal): Promise<JsonObject> {
  const [requestPath, resultPath] = requestFiles(work, command, request);
  const timeoutMs = settings.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const ran = settings.invoke !== undefined ? settings.invoke(command, requestPath, resultPath, timeoutMs, signal) : await run(settings.engine, [command, requestPath, resultPath], timeoutMs, signal);
  return judge(command, ran, timeoutMs, resultPath);
}

function engineSync(engine: string, command: string, request: object, work: string, timeoutMs = ENGINE_TIMEOUT_MS, invoke?: FacesSettings["invoke"]): JsonObject {
  const [requestPath, resultPath] = requestFiles(work, command, request);
  if (invoke !== undefined) return judge(command, invoke(command, requestPath, resultPath, timeoutMs), timeoutMs, resultPath);
  const ran = spawnSync(engine, [command, requestPath, resultPath], { stdio: ["ignore", "ignore", "pipe"], timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1 << 20 });
  return judge(command, {
    code: ran.status, signal: ran.signal, timedOut: (ran.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    stderr: (ran.stderr?.toString("utf8") ?? "").slice(-OUTPUT_TAIL), ...(ran.error === undefined ? {} : { error: ran.error.message }),
  }, timeoutMs, resultPath);
}

function requestFiles(work: string, command: string, request: object): [request: string, result: string] {
  const requestPath = join(work, `${command}-request.json`);
  const resultPath = join(work, `${command}-result.json`);
  rmSync(resultPath, { force: true });
  writeFileSync(requestPath, JSON.stringify(request));
  return [requestPath, resultPath];
}

function judge(command: string, ran: Ran, timeoutMs: number, resultPath: string): JsonObject {
  const said = ran.stderr.trim();
  if (ran.timedOut) throw new LabelerUnavailable("timeout", `face-engine ${command} ran past the ${timeoutMs / 1000} s limit and was stopped`);
  if (ran.error !== undefined) throw new LabelerUnavailable("crashed", `face-engine ${command} could not start: ${ran.error}`);
  if (ran.code === 2) throw new LabelerUnavailable("unreadable", `face-engine ${command} could not read the request${said === "" ? "" : `: ${said}`}`);
  if (ran.code !== 0) throw new LabelerUnavailable("crashed", `face-engine ${command} failed: ${ran.code === null ? `signal ${ran.signal}` : `exit ${ran.code}`}${said === "" ? "" : `: ${said}`}`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch (error) {
    return unreadable(command, (error as Error).message);
  }
  return isObject(value as Json) ? (value as JsonObject) : unreadable(command, "the result is not an object");
}

export interface Ran {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stderr: string;
  error?: string;
}

function run(program: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { stdio: ["ignore", "ignore", "pipe"], killSignal: "SIGKILL", ...(signal === undefined ? {} : { signal }) });
    let stderr = "";
    let timedOut = false;
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, timedOut, stderr, error: error.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stderr });
    });
  });
}

function unreadable(command: string, why: string): never {
  throw new LabelerUnavailable("unreadable", `face-engine ${command}: ${why}`);
}

function readPipeline(result: JsonObject): JsonObject {
  return isObject(result.pipeline) ? result.pipeline : unreadable("scan", "the result states no pipeline");
}

function readScanPhotos(result: JsonObject, keys: readonly string[]): ({ width: number; height: number; faces: ScannedFace[]; vectors: string | null } | null)[] {
  const photos = Array.isArray(result.photos) ? result.photos : unreadable("scan", "photos must be a list");
  if (photos.length !== keys.length) unreadable("scan", `${photos.length} photos for ${keys.length} asked`);
  return photos.map((photo, index) => {
    const at = `photo ${keys[index]}`;
    if (!isObject(photo) || photo.key !== keys[index]) return unreadable("scan", `${at} is missing or out of order`);
    if (photo.status === "unreadable") return null;
    const faces = Array.isArray(photo.faces) ? photo.faces : unreadable("scan", `${at} states no faces`);
    if (photo.status !== "ok" || !positiveInteger(photo.width) || !positiveInteger(photo.height)) unreadable("scan", `${at} must be ok with a width and height, or unreadable`);
    if (faces.length === 0 ? photo.vectors !== undefined : typeof photo.vectors !== "string") unreadable("scan", `${at} must name its vectors when it has faces`);
    return {
      width: photo.width as number, height: photo.height as number, vectors: faces.length === 0 ? null : (photo.vectors as string),
      faces: faces.map((face, number): ScannedFace => {
        const box = isObject(face) ? boxOf(face.box) : null;
        if (!isObject(face) || box === null || !Array.isArray(face.landmarks) || typeof face.score !== "number" || typeof face.size !== "number" ||
          typeof face.tier !== "string" || (face.crop !== undefined && typeof face.crop !== "string")) {
          return unreadable("scan", `${at} face ${number} must state box, landmarks, score, size, tier and a crop or none`);
        }
        return { box, landmarks: face.landmarks as [number, number][], score: face.score, size: face.size, tier: face.tier as ScannedFace["tier"], crop: (face.crop as string | undefined) ?? null };
      }),
    };
  });
}

function readGroup(result: JsonObject, current: ReadonlyMap<string, Seen>): Grouped {
  const bars = isObject(result.bars) ? result.bars : undefined;
  if (bars === undefined || typeof bars.edge !== "number") unreadable("group", "the result states no bars");
  if (!Array.isArray(result.photos) || !Array.isArray(result.clusters) || !Array.isArray(result.unmatched)) unreadable("group", "photos, clusters and unmatched must be lists");
  const who = new Map<string, string>();
  const members = new Map<string, { face: string; photo: string; typical: number }[]>();
  const maybes = new Map<string, { face: string; score: number }[]>();
  let count = 0;
  for (const photo of result.photos as Json[]) {
    const scan = isObject(photo) && typeof photo.key === "string" ? current.get(photo.key) : undefined;
    if (!isObject(photo) || scan?.status !== "ok" || !Array.isArray(photo.faces) || photo.faces.length !== scan.faces.length) {
      return unreadable("group", `photo ${JSON.stringify(isObject(photo) ? photo.key : photo)} is not one asked, with its faces`);
    }
    const hex = photo.key as string;
    photo.faces.forEach((face, index) => {
      const { box } = scan.faces[index]!;
      if (!isObject(face) || face.face !== faceKey(hex, box) || typeof face.person !== "string" || typeof face.cluster !== "string" || (face.person !== "" && face.cluster !== "")) {
        unreadable("group", `photo ${hex} face ${index} must state its key, and a person or a cluster or neither`);
      }
      count++;
      if (face.person !== "") who.set(face.face, face.person);
      if (face.cluster !== "") {
        if (typeof face.typical !== "number") unreadable("group", `face ${face.face} of a cluster states no typical`);
        members.set(face.cluster, [...members.get(face.cluster) ?? [], { face: face.face, photo: hex, typical: face.typical as number }]);
      }
      if (face.maybe !== undefined) {
        const maybe = scoredOf(face.maybe);
        if (maybe === null || face.person !== "" || face.cluster !== "") unreadable("group", `face ${face.face} states a maybe that is not a person and a score, or is taken`);
        maybes.set(maybe.person, [...maybes.get(maybe.person) ?? [], { face: face.face, score: maybe.score }]);
      }
    });
  }
  const edge = bars!.edge as number;
  const clusters: Basis = new Map([...members].map(([id, list]) => [id, {
    members: list.sort((left, right) => compare(left.face, right.face)),
    outliers: list.filter((member) => member.typical < edge).sort((left, right) => left.typical - right.typical || compare(left.face, right.face)).slice(0, OUTLIERS_SIZE).map((member) => member.face),
    suggested: [],
  }]));
  for (const cluster of result.clusters as Json[]) {
    const suggested = isObject(cluster) && Array.isArray(cluster.suggested) ? cluster.suggested.map(scoredOf) : [null];
    if (!isObject(cluster) || typeof cluster.id !== "string" || suggested.some((each) => each === null) || cluster.size !== members.get(cluster.id)?.length) {
      return unreadable("group", `cluster ${JSON.stringify(isObject(cluster) ? cluster.id : cluster)} must state its id, its size as its faces count, and suggested people with their scores`);
    }
    const held = clusters.get(cluster.id);
    if (held !== undefined) held.suggested = (suggested as Scored[]).slice(0, SUGGESTED_SIZE);
  }
  const maybe = new Map([...maybes].map(([slug, list]) => [slug, list.sort((left, right) => right.score - left.score || compare(left.face, right.face)).slice(0, MAYBE_SIZE)]));
  return { who, clusters, maybe, faces: count, unmatched: (result.unmatched as Json[]).length };
}

function scoredOf(value: Json): Scored | null {
  if (!isObject(value) || typeof value.person !== "string" || value.person === "" || typeof value.score !== "number" || !(value.score >= 0 && value.score <= 1)) return null;
  return { person: value.person, score: Math.round(value.score * 10_000) / 10_000 };
}

function positiveInteger(value: Json | undefined): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
