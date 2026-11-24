import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { CONSUMED, homeBlobFault, hostFault, type BlobReader, type Delivery, type DeliveryFile, type ReaderOutput } from "@lifestreamprotocol/core";
import { blobChunks } from "./chunks.js";
import { refuse, refusedFile } from "./refused.js";
import { isTgz, openTgz, TGZ_HEAD, type TarEntry, type Tgz } from "./tar.js";
import { BYTES_LIMIT, openDeliveredZip, openZip, type Zip, type ZipEntry } from "./zip.js";

/** A file a reader reads: a delivered file, or a file inside a zip or gzipped tar the delivery carries. */
export interface Member {
  /** Its path in the delivery, or its name inside its archive. */
  readonly name: string;
  /** Where it is in the delivery, as its path or as its archive's path and its name inside it. */
  readonly where: string;
  /** The delivered file it is, absent for a file inside an archive. */
  readonly file?: DeliveryFile;
  /** The delivered path of the archive it is inside, absent for a delivered file. */
  readonly zip?: string;
  /** Its size in bytes, as the delivery or its archive's listing states it. */
  readonly size: number;
  /** Its first bytes, up to the count given, throwing Refused for a file inside an archive that cannot be read. */
  prefix(bytes: number): Promise<Buffer>;
  /** Its bytes, a chunk at a time, throwing Refused for a file inside an archive that cannot be read. */
  chunks(): AsyncIterable<Buffer>;
  /** Its bytes at once, refused before any is read when it holds more than the limit given, `BYTES_LIMIT` when none is. */
  bytes(limit?: number): Buffer;
}

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const EXTRACTED = /(?:^|\/)Takeout\/[^/]+\//u;
const ZIP_NAME = /\.zip$/iu;
const TGZ_NAME = /\.(?:tgz|tar\.gz)$/iu;

/** Hands `read` a delivery's files as members, each zip or gzipped tar known by its first bytes opened into the files inside, and yields a refusal for each archive that cannot be listed before the rows `read` yields. */
export function archive(delivery: Delivery, files: BlobReader, read: (members: readonly Member[]) => AsyncIterable<ReaderOutput>): AsyncGenerator<ReaderOutput> {
  return opened(delivery, files, false, read);
}

export type Opened = { close(): void; entries(progress?: (inflated: number) => void): Generator<ZipEntry | TarEntry> };

export function openArchiveFile(path: string): Opened | null {
  const handle = openSync(path, "r");
  const first = (bytes: number): Buffer => {
    const buffer = Buffer.alloc(bytes);
    return buffer.subarray(0, readSync(handle, buffer, 0, bytes, 0));
  };
  let kind: "zip" | "tgz" | "member";
  try {
    kind = kindOfHead(first);
  } finally {
    closeSync(handle);
  }
  return kind === "zip" ? openZip(path) : kind === "tgz" ? openTgz(path) : null;
}

function kindOf(files: BlobReader, file: DeliveryFile): "zip" | "tgz" | "member" {
  return kindOfHead((bytes) => files.prefix(file.blob, bytes));
}

function kindOfHead(first: (bytes: number) => Buffer): "zip" | "tgz" | "member" {
  const magic = first(ZIP_MAGIC.length);
  if (magic.equals(ZIP_MAGIC)) return "zip";
  return magic.length >= 2 && magic[0] === 0x1f && magic[1] === 0x8b && isTgz(first(TGZ_HEAD)) ? "tgz" : "member";
}

function handedFolder(delivery: Delivery, path: string): boolean {
  return delivery.facts.import !== undefined && archiveFile(path) !== path;
}

async function openArchive(files: BlobReader, file: DeliveryFile, kind: "zip" | "tgz"): Promise<Opened> {
  if (kind === "zip") return openDeliveredZip(files, file);
  const materialised = await files.materialise(file.blob);
  let tgz: Tgz;
  try {
    tgz = openTgz(materialised.path, () => materialised.dispose());
  } catch (error) {
    materialised.dispose();
    throw error;
  }
  return tgz;
}

async function* withMembers(
  delivery: Delivery, files: BlobReader, named: boolean, use: (members: readonly Member[], refusals: readonly ReaderOutput[]) => AsyncIterable<ReaderOutput>,
  progress?: (listed: number) => void,
): AsyncGenerator<ReaderOutput> {
  const sorted = [...delivery.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const members: Member[] = [];
  const refusals: ReaderOutput[] = [];
  const archives: { file: DeliveryFile; kind: "zip" | "tgz" }[] = [];
  const open: Opened[] = [];
  try {
    for (const file of sorted) {
      const kind = named || !(EXTRACTED.test(file.path) || handedFolder(delivery, file.path)) ? kindOf(files, file) : "member";
      const wanted = !named ? kind : ZIP_NAME.test(file.path) ? "zip" : "tgz";
      if (kind !== "member" && kind === wanted) archives.push({ file, kind });
      else if (named) refusals.push(refusedFile(file.path, `named ${wanted === "zip" ? ".zip" : "as a gzipped tar"}, its first bytes are not a ${wanted === "zip" ? "zip" : "gzipped tar"}'s`));
      else members.push(fileMember(files, file));
    }
    for (const { file, kind } of archives) {
      const unlisted = (error: unknown) => {
        if (homeBlobFault(error) || hostFault(error)) throw error;
        refusals.push(refusedFile(file.path, `its first bytes are a ${kind === "zip" ? "zip" : "gzipped tar"}'s, and it cannot be listed: ${(error as Error).message}`));
      };
      let handle: Opened;
      try {
        handle = await openArchive(files, file, kind);
      } catch (error) {
        unlisted(error);
        continue;
      }
      open.push(handle);
      const entries = handle.entries(progress === undefined ? undefined : () => progress(members.length));
      for (;;) {
        let next: IteratorResult<ZipEntry | TarEntry>;
        try {
          next = entries.next();
        } catch (error) {
          unlisted(error);
          break;
        }
        if (next.done === true) break;
        if (!next.value.directory) members.push(entryMember(file.path, next.value));
        progress?.(members.length);
      }
    }
    yield* use(members, refusals);
  } finally {
    for (const handle of open) handle.close();
  }
}

async function* opened(delivery: Delivery, files: BlobReader, named: boolean, read: (members: readonly Member[]) => AsyncIterable<ReaderOutput>): AsyncGenerator<ReaderOutput> {
  yield* withMembers(delivery, files, named, async function* (members, refusals) {
    yield* refusals;
    yield* read(members);
  });
}

export interface ListedFile {
  readonly path: string;
  readonly bytes: number;
  readonly members: readonly { readonly name: string; readonly size: number }[];
  readonly refused?: string;
}

export async function listed<T>(
  delivery: Delivery, files: BlobReader, look: (members: readonly Member[]) => Promise<T>, progress?: (listed: number) => void,
): Promise<{ files: ListedFile[]; found: T }> {
  let found!: T;
  const listedFiles: ListedFile[] = [];
  const reading = withMembers(delivery, files, false, async function* (members, refusals) {
    const byFile = new Map<string, { name: string; size: number }[]>();
    for (const member of members) {
      const at = member.zip ?? member.where;
      const list = byFile.get(at) ?? [];
      list.push({ name: member.name, size: member.size });
      byFile.set(at, list);
    }
    const why = new Map(refusals.map((row) => [row.key, row.refused!]));
    for (const file of [...delivery.files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))) {
      const refused = why.get(file.path);
      listedFiles.push({ path: file.path, bytes: file.size, members: byFile.get(file.path) ?? [], ...(refused === undefined ? {} : { refused }) });
    }
    found = await look(members);
  }, progress);
  for await (const _ of reading) {
  }
  return { files: listedFiles, found };
}

/** Yields a reader's rows and then, for an import none of whose rows refused, a `CONSUMED` row for each delivered file a member `read` returns came from, which the home may then let go. */
export async function* consuming(delivery: Delivery, rows: AsyncIterable<ReaderOutput>, read: () => Iterable<Member>): AsyncGenerator<ReaderOutput> {
  let refused = false;
  for await (const row of rows) {
    if (row.refused !== undefined) refused = true;
    yield row;
  }
  if (refused || delivery.facts.import === undefined) return;
  const consumed = new Set<string>();
  for (const member of read()) consumed.add(member.zip ?? archiveFile(member.where));
  for (const file of [...consumed].sort()) yield { kind: CONSUMED, key: file, content: null, locator: file };
}

/** The members whose delivered file was read whole, leaving out every member of a file that holds a member `read` turns down and that is not text of at most 16 MiB. */
export function wholeFiles(members: readonly Member[], read: (member: Member) => boolean): Member[] {
  const of = (member: Member) => member.zip ?? archiveFile(member.where);
  const partly = new Set(members.filter((member) => !read(member) && !keptText(member.name, member.size)).map(of));
  return members.filter((member) => !partly.has(of(member)));
}

const TEXT = new Set([".json", ".jsonl", ".ndjson", ".js", ".html", ".htm", ".csv", ".ics", ".txt", ".xml", ".md", ".vcf", ".mbox"]);
export const TEXT_KEPT_BYTES = 16 * 1024 * 1024;

export function keptText(name: string, bytes: number): boolean {
  const dot = name.lastIndexOf(".");
  return dot > name.lastIndexOf("/") && TEXT.has(name.slice(dot).toLowerCase()) && bytes <= TEXT_KEPT_BYTES;
}

export function archiveFile(path: string): string {
  const parts = path.split("/");
  return parts[0] === "files" && parts.length > 1 ? `files/${parts[1]}` : parts[0]!;
}

function entryMember(zip: string, entry: ZipEntry | TarEntry): Member {
  return {
    name: entry.name, where: `${zip}/${entry.name}`, zip, size: entry.size,
    prefix: async (bytes) => {
      const parts: Buffer[] = [];
      let held = 0;
      const stream = entry.stream();
      try {
        for await (const chunk of stream as AsyncIterable<Buffer>) {
          parts.push(chunk);
          held += chunk.length;
          if (held >= bytes) break;
        }
      } finally {
        stream.destroy();
      }
      return Buffer.concat(parts).subarray(0, bytes);
    },
    chunks: () => entry.stream(),
    bytes: (limit) => entry.bytes(limit),
  };
}

/** A delivered file as a member, read from the blob store. */
export function fileMember(files: BlobReader, file: DeliveryFile): Member {
  return {
    name: file.path, where: file.path, file, size: file.size,
    prefix: async (bytes) => files.prefix(file.blob, bytes),
    chunks: () => blobChunks(files, file.blob),
    bytes: (limit = BYTES_LIMIT) => (file.size > limit ? refuse(`${file.path} holds ${file.size} bytes, past the ${limit} a whole read takes`) : files.bytes(file.blob)),
  };
}

/** A file a reader hands the home to keep as a blob by streaming its bytes, with the hash and size they must match. */
export type Streamed = NonNullable<ReaderOutput["streamed"]>[number];

/** The blob a member is kept as. */
export interface Stored {
  /** The blob's name, the `sha256:` hash of the member's bytes. */
  readonly hash: string;
  /** The member's size in bytes. */
  readonly size: number;
  /** How the home streams the member into the blob store, absent for a delivered file, which is a blob already. */
  readonly streamed?: Streamed;
}

const storedOf = new WeakMap<Member, Promise<Stored>>();

/** The blob a member is kept as, hashed by reading it through in chunks once per member. */
export function stored(member: Member): Promise<Stored> {
  let held = storedOf.get(member);
  if (held === undefined) storedOf.set(member, (held = hashed(member)));
  return held;
}

async function hashed(member: Member): Promise<Stored> {
  if (member.file !== undefined) return { hash: member.file.blob, size: member.file.size };
  const digest = createHash("sha256");
  let size = 0;
  for await (const chunk of member.chunks()) {
    digest.update(chunk);
    size += chunk.length;
  }
  const hash = `sha256:${digest.digest("hex")}`;
  return { hash, size, streamed: { hash, size, chunks: () => member.chunks() } };
}

/** Hands `read` the members of the delivery's files named `.zip`, `.tgz` or `.tar.gz`, each opened as the archive its name says, and yields a refusal for each whose first bytes are not that archive's or that cannot be listed before the rows `read` yields. */
export function zipped(delivery: Delivery, files: BlobReader, read: (members: readonly Member[]) => AsyncIterable<ReaderOutput>): AsyncGenerator<ReaderOutput> {
  return opened({ ...delivery, files: delivery.files.filter((file) => ZIP_NAME.test(file.path) || TGZ_NAME.test(file.path)) }, files, true, read);
}
