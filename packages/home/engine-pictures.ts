import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { faces as facesLabeler, LabelerUnavailable } from "@lifestreamprotocol/connect";
import { flush, isObject, type BlobReader, type Box, type FileKind, type HomeFolder, type Json, type KeptFile, type View } from "@lifestreamprotocol/core";
import { tagOf, type Face, type Findings, type Picture, type Pictures } from "@lifestreamprotocol/privacy";
import { readHome } from "./lifecycle.js";


export interface EnginePicturesInputs {
  engine: string;
  blobs: Pick<BlobReader, "has" | "materialise">;
  findings: FindingsDir;
  faces: (blob: string) => readonly Face[] | Promise<readonly Face[]>;
  timeoutMs?: number;
  signal?: AbortSignal;
  merged?: () => Readonly<Record<string, string>> | Promise<Readonly<Record<string, string>>>;
}

export const ENGINE_MS = 120_000;

type Kept =
  | { reader: string; status: "ok"; lines: { words: { text: string; box: Corners }[] }[]; faces: { box: Corners }[] }
  | { reader: string; status: "unreadable"; reason: string };

type Corners = [number, number, number, number];

const BLOB = /^sha256:([0-9a-f]{64})$/u;
const FORGOTTEN = "matches.forgotten";
export const FINDINGS_FILE: FileKind = { role: "findings", remade: true };
export const FORGOTTEN_FILE: FileKind = { role: "matches-forgotten" };

export interface FindingsDir {
  readonly folder: HomeFolder;
  readonly dir: string;
}
const COLOUR = /^#[0-9a-f]{6}$/u;

export function openEnginePictures(inputs: EnginePicturesInputs): Pictures {
  const { engine, blobs, findings, faces, signal } = inputs;
  const merged = inputs.merged ?? (() => ({}));
  const timeoutMs = inputs.timeoutMs ?? ENGINE_MS;
  let reader: Promise<string> | undefined;
  const reading = new Map<string, Promise<Kept>>();

  const currentReader = (): Promise<string> => {
    if (reader !== undefined) return reader;
    const asking = findings.folder.work("read");
    const asked = runEngine(engine, "read", { pictures: [] }, timeoutMs, asking.path, signal).finally(() => asking.empty()).then(readerOf);
    reader = asked;
    asked.catch(() => {
      if (reader === asked) reader = undefined;
    });
    return asked;
  };

  const kept = async (blob: string): Promise<Kept> => {
    const file = findingsFile(findings, blob);
    const stored = readKept(file);
    if (stored !== undefined && stored.reader === await currentReader()) return stored;
    const picture = await blobs.materialise(blob);
    const work = findings.folder.work("read");
    let found: Kept;
    try {
      const result = await runEngine(engine, "read", { pictures: [{ path: picture.path }] }, timeoutMs, work.path, signal);
      found = keptOf(result);
    } finally {
      work.empty();
      picture.dispose();
    }
    reader = Promise.resolve(found.reader);
    file.write(Buffer.from(`${JSON.stringify(found)}\n`));
    if (!blobs.has(blob)) {
      file.remove();
      throw new Error(`${blob} went while it was read: its findings are not kept`);
    }
    return found;
  };

  return {
    async read(blob) {
      let found = reading.get(blob);
      if (found === undefined) {
        found = kept(checkedBlob(blob)).finally(() => reading.delete(blob));
        reading.set(blob, found);
      }
      const answer = await found;
      if (answer.status === "unreadable") return { cannot: cannotLine(answer.reason) };
      const result: Findings = {
        lines: answer.lines.map((line) => ({ words: line.words.map((word) => ({ text: word.text, box: boxOf(word.box) })) })),
        faces: [...answer.faces.map((face) => ({ box: boxOf(face.box) })), ...(await faces(blob)), ...throughMerges(readMatch(matchFile(findings, blob)), await merged())],
      };
      return result;
    },

    async make(draft) {
      const original = await blobs.materialise(checkedBlob(draft.blob));
      const work = findings.folder.work("make");
      try {
        const output = join(work.path, "made.jpg");
        const result = await runEngine(engine, "make", {
          pictures: [{
            path: original.path, output, filled: draft.filled.map(cornersOf),
            covered: draft.covered.map((face) => ({ box: cornersOf(face.box), ...(face.colour === undefined ? {} : { colour: face.colour }), ...(face.placeholder === undefined ? {} : { tag: tagOf(face.placeholder) }) })),
            written: draft.written.map((face) => ({ box: cornersOf(face.box), tag: tagOf(face.placeholder) })),
          }],
        }, timeoutMs, work.path, signal);
        const made = onlyPicture("make", result);
        if (typeof result.engine !== "string" || result.engine === "") throw engineError("make", "the result names no engine");
        if (made.status === "unreadable") return { cannot: cannotLine(typeof made.reason === "string" ? made.reason : "the engine cannot decode it") };
        if (made.status !== "ok") throw engineError("make", `the picture is ${JSON.stringify(made.status)}`);
        const colours = made.covered;
        if (!Array.isArray(colours) || colours.length !== draft.covered.length || !colours.every((colour) => typeof colour === "string" && COLOUR.test(colour))) {
          throw engineError("make", "the result states no colour for each cover");
        }
        const picture: Picture = {
          jpeg: new Uint8Array(readFileSync(output)),
          recipe: {
            blob: draft.blob, filled: [...draft.filled],
            covered: draft.covered.map((face, at) => ({ ...face, colour: colours[at] as string })),
            written: [...draft.written], engine: result.engine,
          },
        };
        return picture;
      } finally {
        work.empty();
        original.dispose();
      }
    },
  };
}

export function findingsDirOf(folder: HomeFolder, machine: string): FindingsDir {
  return { folder, dir: join(machine, "privacy", readHome(folder.root).id, "findings") };
}

export function forgetFindings(findings: FindingsDir, hash: string, held?: Pick<BlobReader, "has">): string[] {
  const file = findingsFile(findings, hash);
  if (held?.has(hash) === true || !existsSync(dirname(file.path))) return [];
  file.remove();
  matchFile(findings, hash).remove();
  return [dirname(file.path)];
}

export function keepMatch(findings: FindingsDir, blob: string, faces: readonly Face[], held: Pick<BlobReader, "has">, forgotten: number): void {
  const file = matchFile(findings, blob);
  const kept = { faces: faces.map((face) => ({ box: cornersOf(face.box), ...(face.who === undefined ? {} : { who: face.who }) })) };
  file.write(Buffer.from(`${JSON.stringify(kept)}\n`));
  if (!held.has(blob)) {
    file.remove();
    throw new Error(`${blob} went while it was matched: its match is not kept`);
  }
  if (matchesForgotten(findings) !== forgotten) {
    file.remove();
    throw new Error(`face data was deleted while ${blob} was matched: its match is not kept`);
  }
}

export function matchesForgotten(findings: FindingsDir): number {
  try {
    const count = Number(forgottenFile(findings).read()?.toString("utf8").trim());
    return Number.isSafeInteger(count) && count >= 0 ? count : 0;
  } catch {
    return 0;
  }
}

export function forgetMatches(findings: FindingsDir): string[] {
  const { folder, dir } = findings;
  const first = mkdirSync(dir, { recursive: true, mode: 0o700 });
  forgottenFile(findings).write(Buffer.from(`${matchesForgotten(findings) + 1}\n`));
  if (first !== undefined) for (let at = dir; at !== dirname(first); at = dirname(at)) flush(dirname(at));
  const folders: string[] = [];
  for (const shard of folder.names(dir)) {
    if (!/^[0-9a-f]{2}$/u.test(shard)) continue;
    const at = join(dir, shard);
    const matches = folder.names(at).filter((name) => name.endsWith(".match.json"));
    for (const name of matches) folder.file(FINDINGS_FILE, join(at, name)).remove();
    if (matches.length > 0) folders.push(at);
  }
  return folders;
}

export function mergedPeople(view: Pick<View, "records">, unit: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const { head, version } of view.records(`people:local:${unit}`, "person")) {
    const content = version.content;
    if (isObject(content) && typeof content.merged_into === "string" && content.merged_into.trim() !== "") merged[head.key] = content.merged_into;
  }
  return merged;
}

function throughMerges(faces: readonly Face[], merged: Readonly<Record<string, string>>): Face[] {
  return faces.map((face) => {
    if (face.who === undefined || !face.who.startsWith("person:")) return face;
    let slug = face.who.slice("person:".length);
    const seen = new Set<string>();
    while (merged[slug] !== undefined && !seen.has(slug)) {
      seen.add(slug);
      slug = merged[slug]!;
    }
    return { ...face, who: `person:${slug}` };
  });
}

export function scannedFaces(view: Pick<View, "sources" | "head" | "version">, blob: string): Face[] {
  const key = checkedBlob(blob).slice(7);
  return view.sources({ product: ["faces"] }).flatMap((source) => {
    const head = view.head({ source: source.id, kind: "scan", key });
    if (head === undefined || head.version === "gone") return [];
    const content = view.version(head.version).content;
    if (!isObject(content) || content.status !== "ok" || !Array.isArray(content.faces)) return [];
    const boxes = content.faces.flatMap((face) => {
      const corners = isObject(face) ? cornersFrom(face.box) : null;
      return corners === null ? [] : [corners];
    });
    const names = namesOf(view, source.id, key, boxes);
    return boxes.map((corners, at) => ({ box: boxOf(corners), ...(names[at] === undefined ? {} : { who: names[at] }) }));
  });
}

function namesOf(view: Pick<View, "head" | "version">, source: string, key: string, boxes: readonly Corners[]): (string | undefined)[] {
  const head = view.head({ source, kind: "model-image", key });
  if (head === undefined || head.version === "gone") return [];
  const content = view.version(head.version).content;
  if (!isObject(content) || !Array.isArray(content.faces) || !Array.isArray(content.names) || content.faces.length !== boxes.length) return [];
  const { faces, names } = content;
  const same = faces.every((face, at) => {
    const corners = isObject(face) ? cornersFrom(face.box) : null;
    return corners !== null && corners.every((value, index) => value === boxes[at]![index]);
  });
  if (!same) return [];
  return names.map((name) => (isObject(name) && typeof name.who === "string" ? name.who : undefined));
}

function cannotLine(reason: string): string {
  return `This picture cannot be hidden: ${reason}.`;
}

function findingsFile({ folder, dir }: FindingsDir, blob: string): KeptFile {
  const hex = checkedBlob(blob).slice(7);
  return folder.file(FINDINGS_FILE, join(dir, hex.slice(0, 2), `${hex}.json`));
}

function matchFile({ folder, dir }: FindingsDir, blob: string): KeptFile {
  const hex = checkedBlob(blob).slice(7);
  return folder.file(FINDINGS_FILE, join(dir, hex.slice(0, 2), `${hex}.match.json`));
}

function forgottenFile({ folder, dir }: FindingsDir): KeptFile {
  return folder.file(FORGOTTEN_FILE, join(dir, FORGOTTEN));
}

function readJson(file: KeptFile): Json | undefined {
  try {
    const bytes = file.read();
    return bytes === undefined ? undefined : JSON.parse(bytes.toString("utf8")) as Json;
  } catch {
    return undefined;
  }
}

function readMatch(file: KeptFile): Face[] {
  const value = readJson(file);
  if (!isObject(value) || !Array.isArray(value.faces)) return [];
  return value.faces.flatMap((face) => {
    const corners = isObject(face) ? cornersFrom(face.box) : null;
    if (corners === null || !isObject(face)) return [];
    return [{ box: boxOf(corners), ...(typeof face.who === "string" ? { who: face.who } : {}) }];
  });
}

function checkedBlob(blob: string): string {
  if (!BLOB.test(blob)) throw new TypeError(`a picture is a blob, sha256:<64 hex>, not ${JSON.stringify(blob)}`);
  return blob;
}

function boxOf([x1, y1, x2, y2]: Corners): Box {
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function cornersOf(box: Box): Corners {
  return [box.x, box.y, box.x + box.width, box.y + box.height];
}

function cornersFrom(value: Json | undefined): Corners | null {
  return Array.isArray(value) && value.length === 4 && value.every((n) => typeof n === "number" && Number.isFinite(n)) ? (value as Corners) : null;
}

function readKept(file: KeptFile): Kept | undefined {
  const value = readJson(file);
  if (value === undefined) return undefined;
  try {
    return keptOf({ reader: isObject(value) ? value.reader ?? null : null, pictures: [value] });
  } catch {
    return undefined;
  }
}

function readerOf(result: { [key: string]: Json }): string {
  if (typeof result.reader !== "string" || result.reader === "") throw engineError("read", "the result names no reader");
  return result.reader;
}

function keptOf(result: { [key: string]: Json }): Kept {
  const reader = readerOf(result);
  const found = onlyPicture("read", result);
  if (found.status === "unreadable") return { reader, status: "unreadable", reason: typeof found.reason === "string" ? found.reason : "the engine cannot decode it" };
  const bad = (what: string): never => {
    throw engineError("read", what);
  };
  if (found.status !== "ok") bad("the picture must be ok or unreadable");
  const lines = Array.isArray(found.lines) ? found.lines : bad("lines must be a list");
  const faces = Array.isArray(found.faces) ? found.faces : bad("faces must be a list");
  return {
    reader, status: "ok",
    lines: lines.map((line) => {
      if (!isObject(line) || !Array.isArray(line.words)) return bad("each line states its words");
      return {
        words: line.words.map((word) => {
          const box = isObject(word) ? cornersFrom(word.box) : null;
          return isObject(word) && typeof word.text === "string" && box !== null ? { text: word.text, box } : bad("each word states its text and its box");
        }),
      };
    }),
    faces: faces.map((face) => {
      const box = isObject(face) ? cornersFrom(face.box) : null;
      return box !== null ? { box } : bad("each face states its box");
    }),
  };
}

function onlyPicture(command: string, result: { [key: string]: Json }): { [key: string]: Json } {
  const pictures = result.pictures;
  if (!Array.isArray(pictures) || pictures.length !== 1 || !isObject(pictures[0])) throw engineError(command, "the result must state the one picture asked");
  return pictures[0];
}

function engineError(command: string, why: string): Error {
  return new Error(`face-engine ${command}: ${why}`);
}

async function runEngine(engine: string, command: string, request: object, timeoutMs: number, work: string, signal?: AbortSignal): Promise<{ [key: string]: Json }> {
  try {
    return await facesLabeler.runEngine({ engine, timeoutMs }, command, request, work, signal);
  } catch (error) {
    if (signal?.aborted === true) throw signal.reason;
    if (!(error instanceof LabelerUnavailable)) throw error;
    throw new Error(existsSync(engine) ? error.message : `the face engine is not built: ${engine} cannot run`, { cause: error });
  }
}
