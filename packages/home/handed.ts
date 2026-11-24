import { GONE, isObject, type Json, type RecordRef } from "@lifestreamprotocol/core";
import { imports as declaredImports, upload } from "@lifestreamprotocol/connect";
import { blobHanded, sealImport } from "./import-file.js";
import { kindsOf, lookAtInbox } from "./import.js";
import { filesLooked } from "./imports.js";
import type { HelperEnv, Kind, Task } from "./jobs.js";
import type { Inputs } from "./registry.js";

export const HANDED = "handed";
export const HANDED_KEY = "files";
const FILE_KIND = "file";
const SOURCES = { product: [upload.UPLOAD_CONNECTOR] };
export const HANDED_INPUTS: Inputs = [{ sources: SOURCES, kinds: [FILE_KIND] }];
const REREAD_PAGE = 500;

interface Since {
  seq: number;
  reread: number;
}

interface Sealed {
  delivery: string;
  kind: string;
  source: string;
  key: string;
}

interface HandedResult extends Since {
  sealed: Sealed[];
}

type Found = declaredImports.HandedFile & RecordRef;

export function handedFile(content: Json): declaredImports.HandedFile | null {
  if (!isObject(content) || typeof content.name !== "string" || !Array.isArray(content.blobs)) return null;
  const original = content.blobs.find((blob) => isObject(blob) && blob.role === "original");
  if (!isObject(original) || typeof original.hash !== "string" || typeof original.bytes !== "number") return null;
  return { name: content.name, blob: original.hash, size: original.bytes };
}

async function* handedHelper(env: HelperEnv, task: Task<Since>): AsyncGenerator<never, HandedResult, undefined> {
  const found: Found[] = [];
  let through: Since;
  const view = env.db.view();
  try {
    through = { seq: view.through, reread: view.newestReread() };
    const sources = new Set(view.sources(SOURCES).map((row) => row.id));
    const records = new Map<string, RecordRef>();
    const note = (ref: RecordRef) => {
      if (sources.has(ref.source) && ref.kind === FILE_KIND) records.set(`${ref.source}\0${ref.key}`, ref);
    };
    if (sources.size > 0) for (const statement of view.statements(task.data.seq, { sources: [...sources], kinds: [FILE_KIND] })) note(statement);
    for (let after = task.data.reread; ;) {
      const page = view.rereads(after, REREAD_PAGE);
      for (const reread of page) if ("record" in reread) note(reread.record);
      if (page.length < REREAD_PAGE) break;
      after = page.at(-1)!.seq;
    }
    const blobs = new Set<string>();
    for (const ref of records.values()) {
      const head = view.head(ref);
      if (head === undefined || head.version === GONE) continue;
      const file = handedFile(view.version(head.version).content);
      if (file === null || blobs.has(file.blob) || !env.blobs.has(file.blob)) continue;
      blobs.add(file.blob);
      found.push({ ...ref, ...file });
    }
  } finally {
    view.close();
  }
  const kinds = kindsOf(env.registry);
  const recognised: { file: Found; kind: string }[] = [];
  for (const file of found) {
    env.signal.throwIfAborted();
    const kind = await declaredImports.recognisedKind(kinds, file, env.blobs);
    if (kind !== null) recognised.push({ file, kind: kind.id });
  }
  const sealed: Sealed[] = [];
  if (recognised.length === 0) return { ...through, sealed };
  const looked = env.db.view();
  let fresh: typeof recognised;
  try {
    const keys = recognised.map(({ file, kind }) => `${kind}/${file.blob.replace(/^sha256:/u, "")}`);
    const seen = new Set(filesLooked(looked.tables.meta, keys).map((each) => `${each.kind}/${each.digest}`));
    fresh = recognised.filter((_, at) => !seen.has(keys[at]!));
  } finally {
    looked.close();
  }
  for (const { file, kind } of fresh) {
    env.signal.throwIfAborted();
    const delivery = await sealImport(env.folder, env.registry, kind, [blobHanded(file.name, file.blob, env.blobs)], task.now_ms);
    sealed.push({ delivery, kind, source: file.source, key: file.key });
  }
  return { ...through, sealed };
}

export const handedKind: Kind<Since, never, HandedResult, null> = {
  dies: true,
  begin(_main, tx) {
    const cursor = tx.tables.cursors.get(HANDED);
    return { data: { seq: cursor?.seq ?? 0, reread: cursor?.reread ?? 0 }, state: null };
  },
  helper: handedHelper,
  done(main, tx, _running, result) {
    const now = main.now();
    tx.tables.cursors.move(HANDED, { seq: result.seq, reread: result.reread, at_ms: now });
    if (result.sealed.length === 0) return;
    lookAtInbox(tx, now);
    main.log({ handed: result.sealed.map((each) => ({ ...each })) });
  },
};
