import { archive, attempt, consuming, each, forThisAccount, isObject, MEDIA_HEAD, mediaTypeOf, readJson, refuse, Refused, stored, utf8, type BlobReader, type Delivery, type DeliveryFile, type Guard, type JsonObject, type Member, type Reader, type ReaderOutput, type Stored } from "@lifestreamprotocol/connect/sdk";
import { companionName, extensionless, stemOf, uneditedOf } from "./names.js";
import { photoAsset, sidecarNames } from "./photos-repair.js";

const PHOTOS = /(?:^|\/)Takeout\/Google Photos\/(.+)$/u;
const FILE = /(?:^|\/)files\/([^/]+)/u;
const img: Guard = (content) => {
  if (!isObject(content)) return ["content must be an object"];
  const out: string[] = [];
  if (content.type !== "photos.asset") out.push("type must be photos.asset");
  if (typeof content.title !== "string" || content.title === "") out.push("title must be the sidecar's");
  const blobs = content.blobs;
  const original = Array.isArray(blobs) && blobs.length === 1 ? blobs[0] : undefined;
  if (!isObject(original) || Object.keys(original).sort().join(",") !== "bytes,hash,media_type,role" || typeof original.hash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(original.hash)
    || !Number.isSafeInteger(original.bytes) || (original.bytes as number) < 0 || typeof original.media_type !== "string" || original.role !== "original") {
    out.push("blobs must hold the original alone, { hash, bytes, media_type, role: original }");
  }
  return out;
};

interface Item {
  readonly member: Member;
  readonly own: boolean;
  readonly folder: string;
  readonly name: string;
}

interface Paired {
  readonly item: Item;
  readonly names: ReadonlySet<string>;
  readonly why: string | null;
}

export const googlePhotosTakeout: Reader = {
  name: "google-photos-takeout",
  kinds: { img },
  async *read(delivery, files) {
    if (!forThisAccount(delivery)) return;
    const beside = besideFiles(delivery);
    let ownMembers: Member[] = [];
    yield* consuming(delivery, archive(delivery, files, (members) => {
      const own = items(members, true);
      ownMembers = own.map((item) => item.member);
      return withBeside(delivery, files, beside, (others) => photoRows(own, items(others, false)));
    }), () => ownMembers);
  },
};

function besideFiles(delivery: Delivery): DeliveryFile[] {
  const stated = delivery.facts.beside;
  if (stated === undefined) return [];
  if (!Array.isArray(stated)) refuse("the delivery's beside is not a list of files");
  return stated.map((file) => isObject(file) && typeof file.path === "string" && typeof file.blob === "string" && typeof file.size === "number"
    ? { path: file.path, blob: file.blob, size: file.size }
    : refuse("a file beside the delivery is { path, blob, size }"));
}

async function* withBeside(delivery: Delivery, files: BlobReader, beside: DeliveryFile[], read: (members: readonly Member[]) => AsyncIterable<ReaderOutput>): AsyncGenerator<ReaderOutput> {
  if (beside.length === 0) {
    yield* read([]);
    return;
  }
  let reading = false;
  const { import: _import, ...facts } = delivery.facts;
  for await (const row of archive({ ...delivery, facts, files: beside }, files, (members) => {
    reading = true;
    return read(members);
  })) {
    if (reading) yield row;
  }
}

function items(members: readonly Member[], own: boolean): Item[] {
  return members.flatMap((member) => {
    const inner = PHOTOS.exec(member.name)?.[1];
    if (inner === undefined) return [];
    const slash = inner.lastIndexOf("/");
    return [{ member, own, folder: slash < 0 ? "" : inner.slice(0, slash), name: inner.slice(slash + 1) }];
  });
}

function fileOf(member: Member): string {
  const place = member.zip ?? member.where;
  return FILE.exec(place)?.[1] ?? place;
}

async function* photoRows(own: readonly Item[], others: readonly Item[]): AsyncGenerator<ReaderOutput> {
  const groups = new Map<string, Item[]>();
  for (const item of [...own, ...others]) {
    const key = `${item.folder}/${stemOf(item.name)}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [item]);
    else group.push(item);
  }
  const besides = new Map<string, Item[]>();
  for (const item of others) {
    if (isJson(item.name)) continue;
    const at = `${item.name}|${item.member.size}`;
    besides.set(at, [...besides.get(at) ?? [], item]);
  }
  const earlier = async (item: Item, hash: string): Promise<boolean> => {
    for (const other of besides.get(`${item.name}|${item.member.size}`) ?? []) {
      if (fileOf(other.member) >= fileOf(item.member)) continue;
      if ((await stored(other.member)).hash === hash) return true;
    }
    return false;
  };
  const stated = new Set<string>();
  for (const key of [...groups.keys()].sort(compare)) {
    const group = groups.get(key)!.sort((left, right) => Number(right.own) - Number(left.own) || compare(left.member.where, right.member.where));
    if (group.some((item) => item.own)) yield* groupRows(group, stated, earlier);
  }
}

async function* groupRows(group: readonly Item[], stated: Set<string>, earlier: (item: Item, hash: string) => Promise<boolean>): AsyncGenerator<ReaderOutput> {
  const media = group.filter((item) => !isJson(item.name));
  const byName = new Map<string, Paired>();
  const byBare = new Map<string, Paired>();
  const pairs = group.filter((item) => isSidecar(item.name)).map((item): Paired => {
    const fields = attempt(() => fieldsOf(item));
    const paired = { item, names: sidecarNames(item.name, fields instanceof Refused ? null : fields.title as string), why: fields instanceof Refused ? fields.message : null };
    for (const name of paired.names) {
      if (!byName.has(name)) byName.set(name, paired);
      if (!byBare.has(extensionless(name))) byBare.set(extensionless(name), paired);
    }
    return paired;
  });
  const mediaNamed = new Set(media.map((item) => item.name));
  const ownNamed = new Set(media.filter((item) => item.own).map((item) => item.name));
  const borrowed = (name: string, type: string): Paired | undefined => {
    const original = uneditedOf(name);
    if (original !== null) return byName.get(original);
    return type.startsWith("video/") && companionName(name) ? byBare.get(name) ?? byBare.get(extensionless(name)) : undefined;
  };

  yield* each(media.filter((item) => item.own), (item) => item.member.where, async (item) => {
    const where = item.member.where;
    const type = mediaTypeOf(await item.member.prefix(MEDIA_HEAD)) ?? refuse(`${where}: its first bytes are no photo's or video's`);
    const own = byName.get(item.name);
    const sidecar = own ?? borrowed(item.name, type);
    if (sidecar === undefined) refuse("waiting for its sidecar: no file of the archive the home holds has it");
    if (sidecar.why !== null) refuse(`${where}: its sidecar ${sidecar.item.member.where} does not read: ${sidecar.why}`);
    const held = await stored(item.member);
    if (stated.has(held.hash) || await earlier(item, held.hash)) return [];
    stated.add(held.hash);
    return [photoRow(item, type, sidecar, own === undefined, held)];
  });

  yield* each(pairs.filter((paired) => paired.item.own), (paired) => paired.item.member.where, (paired) => {
    if ([...paired.names].some((name) => ownNamed.has(name))) return [];
    if (paired.why !== null) refuse(paired.why);
    if (![...paired.names].some((name) => mediaNamed.has(name))) refuse("waiting for its photo: no file of the archive the home holds has it");
    return [];
  });
}

function fieldsOf(item: Item): JsonObject {
  const where = item.member.where;
  const value = readJson(utf8(item.member.bytes(), where), where);
  if (!isObject(value)) refuse(`${where} is not a JSON object`);
  if (typeof value.title !== "string" || value.title === "") refuse(`${where} states no title`);
  return value;
}

const isJson = (name: string): boolean => /\.json$/iu.test(name);

function isSidecar(name: string): boolean {
  return isJson(name) && name.replace(/\.json$/iu, "").replace(/\(\d+\)$/u, "").indexOf(".", 1) > 0;
}

function photoRow(item: Item, type: string, sidecar: Paired, borrowed: boolean, held: Stored): ReaderOutput {
  const where = sidecar.item.member.where;
  let asset: ReturnType<typeof photoAsset>;
  try {
    asset = photoAsset(fieldsOf(sidecar.item), where, { hash: held.hash, bytes: held.size, media_type: type }, borrowed ? item.name : undefined);
  } catch (error) {
    if (error instanceof Refused) throw error;
    refuse((error as Error).message);
  }
  const { content, time } = asset;
  return {
    kind: "img", key: held.hash.slice("sha256:".length), content, time, blobs: [held.hash],
    ...(held.streamed === undefined ? {} : { streamed: [held.streamed] }),
    locator: item.member.where,
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
