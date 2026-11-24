import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { faces as facesLabeler } from "@lifestreamprotocol/connect";
import { MEDIA_HEAD, mediaTypeOf, type BlobReader, type FileKind, type HomeFolder, type Json, type KeptFile } from "@lifestreamprotocol/core";
import { readHome } from "./lifecycle.js";
import { faceEngine } from "./programs.js";


export const SIZES = { tile: 640, screen: 2560, full: null } as const;
export type PictureSize = keyof typeof SIZES;
export const RECIPE = 2;
const MAKINGS = 4;
const MAKING_MS = 60_000;

export type Outcome = { made: "jpeg" | "png" } | { animated: true } | { cannot: string };

export type Maker = (request: { from: string; to: string; type: string; side: number | null }) => Promise<Outcome>;

export function engineMaker(engine: string): Maker {
  return async (request) => {
    const work = mkdtempSync(join(tmpdir(), "lifestream-picture-"));
    try {
      return outcomeOf(await facesLabeler.runEngine({ engine, timeoutMs: MAKING_MS }, "picture", request, work));
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  };
}

function outcomeOf(result: { [key: string]: Json }): Outcome {
  if (result.made === "jpeg" || result.made === "png") return { made: result.made };
  if (result.animated === true) return { animated: true };
  if (typeof result.cannot === "string" && result.cannot !== "") return { cannot: result.cannot };
  throw new Error(`face-engine picture: the result states no outcome: ${JSON.stringify(result)}`);
}

export interface Original {
  readonly type: string | null;
  file(): Promise<{ path: string; dispose(): void }>;
  held(): boolean | Promise<boolean>;
}

export function fromBlob(blobs: BlobReader, hash: string): Original {
  return { type: mediaTypeOf(blobs.prefix(hash, MEDIA_HEAD)), file: () => blobs.materialise(hash), held: () => blobs.has(hash) };
}

export function fromBytes(bytes: Buffer, cache: PicturesDir, held: () => boolean | Promise<boolean>): Original {
  return {
    type: mediaTypeOf(bytes.subarray(0, MEDIA_HEAD)),
    held,
    async file() {
      const name = `original-${randomBytes(6).toString("hex")}`;
      const work = cache.folder.work(name, cache.dir);
      mkdirSync(work.path, { recursive: true });
      const path = join(work.path, `.${name}`);
      writeFileSync(path, bytes);
      return {
        path,
        dispose: () => {
          rmSync(path, { force: true });
          work.empty();
        },
      };
    },
  };
}

export interface Served {
  readonly type: string;
  readonly kept: KeptFile | null;
}

export interface PicturesDir {
  readonly folder: HomeFolder;
  readonly dir: string;
}

export const PICTURE_FILE: FileKind = { role: "picture", remade: true };

export interface Pictures {
  readonly cache: PicturesDir;
  picture(hash: string, size: PictureSize, original: Original, leaving?: AbortSignal): Promise<Served | null>;
}

export function picturesDirOf(folder: HomeFolder, machine: string): PicturesDir {
  return { folder, dir: join(machine, "pictures", readHome(folder.root).id) };
}

type Kept = "jpg" | "png" | "animated" | "cannot";
const KEPT: readonly Kept[] = ["jpg", "png", "animated", "cannot"];

interface Making {
  readonly done: Promise<Kept | null>;
  waiting: number;
  begun: boolean;
  begin(): void;
}

export function openPictures(cache: PicturesDir, maker: Maker = engineMaker(faceEngine())): Pictures {
  const { folder, dir } = cache;
  const current = new Set(Object.keys(SIZES).map((size) => `${size}-${RECIPE}`));
  void readdir(dir).then((names) => Promise.all(names.filter((name) => /^[a-z]+-\d+$/u.test(name) && !current.has(name))
    .map((name) => rm(join(dir, name), { recursive: true, force: true })))).catch(() => undefined);
  const makings = new Map<string, Making>();
  const queue: Making[] = [];
  let running = 0;
  const next = (): void => {
    while (running < MAKINGS && queue.length > 0) {
      running++;
      queue.shift()!.begin();
    }
  };

  const make = async (original: Original, type: string, base: string, side: number | null): Promise<Kept | null> => {
    const name = `.${basename(base)}.${randomBytes(6).toString("hex")}`;
    const work = folder.work(`picture-${name.slice(-12)}`, dirname(base));
    const temporary = join(work.path, name);
    let file: { path: string; dispose(): void } | undefined;
    try {
      file = await original.file();
      mkdirSync(dirname(temporary), { recursive: true });
      const outcome = await maker({ from: file.path, to: temporary, type, side });
      const extension: Kept = "made" in outcome ? (outcome.made === "jpeg" ? "jpg" : "png") : "animated" in outcome ? "animated" : "cannot";
      const kept = keptOf(base, extension);
      if ("made" in outcome) await kept.adopt(temporary);
      else kept.write(Buffer.from("cannot" in outcome ? `${outcome.cannot}\n` : ""));
      if (await held(original)) return extension;
      kept.remove();
      return null;
    } finally {
      file?.dispose();
      rmSync(temporary, { force: true });
      work.empty();
    }
  };

  const keptOf = (base: string, extension: Kept): KeptFile => folder.file(PICTURE_FILE, `${base}.${extension}`);

  const share = (making: Making, base: string, leaving: AbortSignal | undefined): Promise<Kept | null> => {
    making.waiting++;
    if (leaving === undefined) return making.done;
    return new Promise((resolve, reject) => {
      const leave = () => {
        making.waiting--;
        if (!making.begun && making.waiting === 0) {
          queue.splice(queue.indexOf(making), 1);
          makings.delete(base);
        }
        reject(leaving.reason);
      };
      if (leaving.aborted) return leave();
      leaving.addEventListener("abort", leave, { once: true });
      making.done.then((kept) => {
        leaving.removeEventListener("abort", leave);
        resolve(kept);
      }, (error: unknown) => {
        leaving.removeEventListener("abort", leave);
        reject(error);
      });
    });
  };

  return {
    cache,
    async picture(hash, size, original, leaving) {
      const { type } = original;
      if (type === null) return null;
      const hex = hash.slice("sha256:".length);
      const base = join(dir, `${size}-${RECIPE}`, hex.slice(0, 2), hex);
      let making = makings.get(base);
      const known = making === undefined ? keptIn(folder, base) : undefined;
      if (known === undefined && making === undefined) {
        let begin!: () => void;
        const begun = new Promise<void>((resolve) => { begin = resolve; });
        const done = begun.then(() => make(original, type, base, SIZES[size])).finally(() => {
          running--;
          makings.delete(base);
          next();
        });
        done.catch(() => undefined);
        const created: Making = { done, waiting: 0, begun: false, begin: () => { created.begun = true; begin(); } };
        making = created;
        makings.set(base, making);
        queue.push(making);
        next();
      }
      const kept = known ?? await share(making!, base, leaving);
      if (kept === null || kept === "cannot") return null;
      if (kept === "animated") return { type, kept: null };
      return { type: kept === "jpg" ? "image/jpeg" : "image/png", kept: keptOf(base, kept) };
    },
  };
}

async function held(original: Original): Promise<boolean> {
  try {
    return await original.held();
  } catch {
    return false;
  }
}

function keptIn(folder: HomeFolder, base: string): Kept | undefined {
  return KEPT.find((extension) => folder.file(PICTURE_FILE, `${base}.${extension}`).exists());
}

export function forgetPictures(cache: PicturesDir, hash: string): string[] {
  const { dir } = cache;
  const hex = hash.slice("sha256:".length);
  let folders;
  try {
    folders = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const removed: string[] = [];
  for (const folder of folders) {
    if (!folder.isDirectory()) continue;
    const shard = join(dir, folder.name, hex.slice(0, 2));
    if (!existsSync(shard)) continue;
    for (const extension of KEPT) cache.folder.file(PICTURE_FILE, join(shard, `${hex}.${extension}`)).remove();
    removed.push(shard);
  }
  return removed;
}
