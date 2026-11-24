import { createHash } from "node:crypto";
import { civilDay, isObject, isSettled, isUnread, selects, sourceName, type BlobReader, type DaySettings, type Delivery, type JsonObject, type Landed, type ReadTables, type SourceSelector, type Tx } from "@lifestreamprotocol/core";
import { archiveFile, imports as declared, upload, vendorOf, type Connector, type Member } from "@lifestreamprotocol/connect";
import { BACKUP_PHONE, phoneUnits, unitId, type PhoneUnit } from "./devices.js";

type Listing = declared.Listing;
type ImportKind = declared.ImportKind;

export interface HeldImport {
  kind: string;
  account: string | null;
  stamp: string | null;
  time_ms: number | null;
  at_ms: number;
  answered?: true;
  named?: string[];
  answer?: string;
  refused?: string;
  ended?: true;
  failed?: string;
  digest?: string;
  device?: declared.ImportDevice;
  unit?: string | null;
  deliveries: string[];
}

export type Whose = Pick<HeldImport, "account" | "unit">;

export interface AdmittedFile {
  import: string;
  delivery: string;
  at_ms: number;
}

export type KeptListing = Listing & { hash: string };

export const HELD = "imports:held";
export const FILES = "imports:files";
const LET_GO_FILES = "imports:let-go";
export const IMPORT_OF = "import-of:";
const VOID = "import-void:";
const LET_GO = "import-let-go:";
export const GONE = "import-gone:";
export const ANCHOR = "import-anchor:";
export const LISTING = "listing:";
const CONSUMED_KEY = "consumed:";
export const DAYS = "import-days:";
export const openDayKey = (id: string): string => `import:${id}:open_day`;
export const spanKey = (id: string): string => `import:${id}:span`;
const pair = (delivery: string, source: string): string => `${delivery}|${source}`;

type Meta = Pick<ReadTables["meta"], "get">;
type JsonObjectLike = Readonly<Record<string, unknown>>;

const idOf = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 16);

const importId = (kind: string, account: string | null, which: string): string => idOf(kind, account ?? "", which);

export function importKindOf(facts: JsonObjectLike): string | null {
  const stated = facts.import;
  return isObject(stated as never) && typeof (stated as JsonObject).kind === "string" && (stated as JsonObject).kind !== "" ? (stated as JsonObject).kind as string : null;
}

export function heldImports(meta: Meta): Record<string, HeldImport> {
  const kept = meta.get(HELD);
  return kept === undefined ? {} : (JSON.parse(kept) as Record<string, HeldImport>);
}

export function admittedFiles(meta: Meta): Record<string, AdmittedFile> {
  const kept = meta.get(FILES);
  return kept === undefined ? {} : (JSON.parse(kept) as Record<string, AdmittedFile>);
}

const endedId = (kind: string, digest: string, failed: boolean): string => idOf(kind, failed ? "failed" : "refused", digest);

function letGoFiles(meta: Meta): Set<string> {
  const kept = meta.get(LET_GO_FILES);
  return new Set(kept === undefined ? [] : (JSON.parse(kept) as string[]));
}

const keepLetGo = (meta: Tx["tables"]["meta"], gone: ReadonlySet<string>): void => meta.set(LET_GO_FILES, JSON.stringify([...gone].sort()));

function heldAgain(meta: Tx["tables"]["meta"], key: string): void {
  const gone = letGoFiles(meta);
  if (gone.delete(key)) keepLetGo(meta, gone);
}

export type FileLooked = "in" | "refused" | "let-go";

export function filesLooked(meta: Meta, keys: readonly string[]): { kind: string; digest: string; state: FileLooked }[] {
  const files = admittedFiles(meta);
  const held = heldImports(meta);
  const gone = letGoFiles(meta);
  return [...new Set(keys)].flatMap((key): { kind: string; digest: string; state: FileLooked }[] => {
    const at = key.indexOf("/");
    const [kind, digest] = [key.slice(0, at), key.slice(at + 1)];
    if (Object.hasOwn(files, key)) return [{ kind, digest, state: "in" }];
    if (held[endedId(kind, digest, false)] !== undefined || held[endedId(kind, digest, true)] !== undefined) return [{ kind, digest, state: "refused" }];
    return gone.has(key) ? [{ kind, digest, state: "let-go" }] : [];
  });
}

export function importIdOf(meta: Meta, delivery: string): string | null {
  return meta.get(`${IMPORT_OF}${delivery}`) ?? null;
}

export function isVoid(meta: Meta, delivery: string): boolean {
  return meta.get(`${VOID}${delivery}`) !== undefined;
}

export function voidOf(meta: Meta, delivery: string): { kind: string; digest?: string; of?: string; dropped?: true } | null {
  const kept = meta.get(`${VOID}${delivery}`);
  return kept === undefined ? null : (JSON.parse(kept) as { kind: string; digest?: string; of?: string; dropped?: true });
}

export function listingOf(meta: Meta, delivery: string): KeptListing | null {
  const kept = meta.get(`${LISTING}${delivery}`);
  return kept === undefined ? null : (JSON.parse(kept) as KeptListing);
}

export function consumedOf(meta: Meta, delivery: string, source: string): string[] | null {
  const kept = meta.get(`${CONSUMED_KEY}${pair(delivery, source)}`);
  return kept === undefined ? null : (JSON.parse(kept) as string[]);
}

export function letGoOf(meta: Meta, delivery: string): string[] {
  const kept = meta.get(`${LET_GO}${delivery}`);
  return kept === undefined ? [] : (JSON.parse(kept) as string[]);
}

export function goneOf(meta: Meta, delivery: string): string[] {
  const kept = meta.get(`${GONE}${delivery}`);
  return kept === undefined ? [] : (JSON.parse(kept) as string[]);
}

function without(listing: KeptListing, gone: ReadonlySet<string>): KeptListing {
  return {
    ...listing,
    files: listing.files.filter((file) => !gone.has(file.path)),
    products: listing.products.map((each) => ({ ...each, files: each.files.filter((file) => !gone.has(file)) })).filter((each) => each.files.length > 0),
    routes: listing.routes.map((each) => ({ ...each, files: each.files.filter((file) => !gone.has(file)) })).filter((each) => each.files.length > 0),
  };
}

const anchorKey = (source: string): string => `${ANCHOR}${source}`;

export function routedSources(listing: Pick<Listing, "routes">, whose: Whose | undefined): { id: string; connector: string; of: string; files: readonly string[] }[] {
  const account = whose?.account ?? null;
  if (account === null || waitsPhone(whose!)) return [];
  return listing.routes.map((route) => ({ id: declared.sourceOf(route, account, whose!.unit ?? null), connector: route.connector, of: route.of, files: route.files }));
}

export const waitsPhone = (whose: Whose): boolean => whose.unit === null;

export function importSources(meta: Meta, delivery: string): string[] {
  const id = importIdOf(meta, delivery);
  const entry = id === null ? undefined : heldImports(meta)[id];
  const listing = listingOf(meta, delivery);
  if (entry === undefined || listing === null) return [];
  return [...new Set(routedSources(listing, entry).map((each) => each.id))].sort();
}


export interface ImportFile {
  path: string;
  blob: string;
  size: number;
  at: string;
}

export function importFiles(files: readonly { path: string; blob: string; size: number }[]): ImportFile[] {
  return files.filter((file) => file.path !== upload.UPLOAD_INDEX).map((file) => ({ path: memberPath(file.path), blob: file.blob, size: file.size, at: file.path }));
}

const memberPath = (path: string): string => (path.startsWith("files/") ? path.slice("files/".length) : path);

export const fileOfPath = (path: string): string => archiveFile(memberPath(path));

export function digestOf(files: readonly ImportFile[]): string {
  const hex = (blob: string) => blob.replace(/^sha256:/u, "");
  if (files.length === 1 && !files[0]!.path.includes("/")) return hex(files[0]!.blob);
  const lines = [...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)).map((file) => `${file.path}\t${hex(file.blob)}\n`);
  return createHash("sha256").update(lines.join("")).digest("hex");
}


export interface Looked {
  kind: string;
  digest: string;
  listing: KeptListing;
  stamp: string | null;
  named: string[];
  account: string | null;
  time_ms: number | null;
  anchor: string | null;
  refused: string | null;
  contradicted: string | null;
  checked: { source: string; anchor: string | null } | null;
  failed?: string;
  device: declared.ImportDevice | null;
}

function answeredFor(meta: Meta, kind: string, delivery: string, stamp: string | null): string | null {
  const held = heldImports(meta);
  const own = held[importIdOf(meta, delivery) ?? ""];
  if (own?.answer !== undefined) return own.answer;
  if (own?.answered === true && own.account !== null) return own.account;
  if (stamp === null) return null;
  const accounts = new Set(Object.values(held).filter((each) => each.kind === kind && each.stamp === stamp).flatMap((each) => (each.answer !== undefined ? [each.answer] : each.answered === true && each.account !== null ? [each.account] : [])));
  return accounts.size === 1 ? [...accounts][0]! : null;
}

export async function lookImport(
  kind: ImportKind, delivery: Delivery, files: BlobReader, meta: Meta, kept: KeptListing | null,
  options: { present: (path: string) => boolean; progress?: (listed: number) => void },
): Promise<Looked> {
  const own = importFiles(delivery.files);
  const byPath = new Map(own.map((file) => [file.path, file.at] as const));
  const projected: Delivery = { ...delivery, files: own.map(({ path, blob, size }) => ({ path, blob, size })) };
  const file = own.length === 0 ? "" : archiveFile(own[0]!.path);
  const { listing, found } = await declared.listImport(kind, projected, files, {
    present: (path) => options.present(byPath.get(path) ?? path),
    ...(options.progress === undefined ? {} : { progress: options.progress }),
    look: async (members: readonly Member[]) => {
      const whole = (refused: string) => ({ refused, named: [] as string[], stamp: null, account: null, time_ms: null, anchor: null, contradicted: null, checked: null, device: null });
      if (declared.leftOnly(kind, members.map((member) => member.name))) return whole(NOTHING_READ);
      const resolved = await kind.resolve(members);
      if ("refused" in resolved) return whole(resolved.refused);
      const named = [...new Set(resolved.products.flatMap((product) => product.named))].sort();
      const stamp = await kind.stamp(file, members);
      const device = await kind.device(members);
      const asked = heldImports(meta)[importIdOf(meta, delivery.id) ?? ""]?.answer;
      const account = named.length === 1 ? named[0]! : named.length === 0 ? answeredFor(meta, kind.id, delivery.id, stamp)
        : asked !== undefined && named.includes(asked) ? asked : null;
      const source = account !== null && ownExport(kind) && kind.reads[0] !== undefined ? declared.sourceOf(kind.reads[0], account) : null;
      const anchored = source === null ? null : meta.get(anchorKey(source)) ?? null;
      const checked = source === null ? null : { source, anchor: anchored };
      const stated = await kind.states(file, members, anchored);
      if ("refused" in stated) {
        return anchored !== null
          ? { refused: null, named, stamp, account, time_ms: null, anchor: null, contradicted: stated.refused, checked, device }
          : { refused: stated.refused, named, stamp, account, time_ms: null, anchor: null, contradicted: null, checked, device };
      }
      return { refused: null, named, stamp, account, time_ms: stated.time_ms, anchor: stated.anchor ?? null, contradicted: null, checked, device };
    },
  });
  const fresh: KeptListing = { ...listing, hash: declared.listingHash(kind) };
  return { kind: kind.id, digest: digestOf(own), listing: relisted(kept, fresh), ...found, refused: found.refused ?? (kept === null ? routedNone(kind, fresh) : null) };
}

const ownExport = (kind: ImportKind): boolean => !declared.IMPORTS.some((each) => each.kind === kind.id);

const NOTHING_READ = "Nothing Lifestream reads yet";

function routedNone(kind: ImportKind, listing: Listing): string | null {
  if (listing.routes.length > 0) return null;
  if (ownExport(kind)) return `This isn't a ${kind.name}`;
  return listing.files.length > 0 && listing.files.every((file) => file.refused !== undefined) ? "Didn't open · Download it again" : NOTHING_READ;
}

const FAILED_WORDS = "Lifestream couldn't read this file";

export function failedLook(kind: ImportKind, delivery: Pick<Delivery, "files">, error: unknown): Looked {
  const own = importFiles(delivery.files);
  const bytes = new Map<string, number>();
  for (const file of own) bytes.set(archiveFile(file.path), (bytes.get(archiveFile(file.path)) ?? 0) + file.size);
  return {
    kind: kind.id, digest: digestOf(own), stamp: null, named: [], account: null, time_ms: null, anchor: null, refused: null, contradicted: null, checked: null, device: null,
    listing: { kind: kind.id, files: [...bytes].sort(([left], [right]) => left.localeCompare(right)).map(([path, size]) => ({ path, bytes: size })), products: [], routes: [], hash: declared.listingHash(kind) },
    failed: error instanceof Error ? error.message : String(error),
  };
}

export function relisted(kept: KeptListing | null, fresh: KeptListing): KeptListing {
  if (kept === null) return fresh;
  const now = new Set(fresh.files.map((file) => file.path));
  const gone = new Set(kept.files.filter((file) => !now.has(file.path)).map((file) => file.path));
  if (gone.size === 0) return fresh;
  return {
    ...fresh,
    files: [...fresh.files, ...kept.files.filter((file) => gone.has(file.path))].sort((left, right) => left.path.localeCompare(right.path)),
    products: keptBack(fresh.products, kept.products, (each) => each.id, gone).sort((left, right) => left.id.localeCompare(right.id)),
    routes: keptBack(fresh.routes, kept.routes, (each) => `${each.of}|${each.members}`, gone),
  };
}

function keptBack<T extends { readonly files: readonly string[] }>(fresh: readonly T[], kept: readonly T[], keyOf: (each: T) => string, gone: ReadonlySet<string>): T[] {
  const merged = new Map(fresh.map((each) => [keyOf(each), each]));
  for (const each of kept) {
    const files = each.files.filter((file) => gone.has(file));
    if (files.length === 0) continue;
    const held = merged.get(keyOf(each));
    merged.set(keyOf(each), { ...(held ?? each), files: held === undefined ? files : [...new Set([...held.files, ...files])].sort() });
  }
  return [...merged.values()];
}

export interface Admitted {
  sources: string[];
  stated_ms: number;
  again?: true;
  relook?: true;
}

export function admitImport(
  tx: Tx, connectors: readonly Connector[], delivery: { id: string; facts: JsonObjectLike; stated_ms: number }, lane: string, looked: Looked | null, now: number, passes: readonly PassOf[],
): Admitted {
  const meta = tx.tables.meta;
  const none: Admitted = { sources: [], stated_ms: delivery.stated_ms };
  const kind = importKindOf(delivery.facts);
  if (kind === null || isVoid(meta, delivery.id)) return none;
  const held = heldImports(meta);
  const was = importIdOf(meta, delivery.id);
  const prior = was === null ? undefined : held[was];
  const fed = (entry: HeldImport): Admitted => ({ sources: importSources(meta, delivery.id), stated_ms: entry.time_ms ?? delivery.stated_ms });
  if (looked === null) return prior === undefined ? none : fed(prior);
  const gone = new Set(goneOf(meta, delivery.id));
  if (gone.size > 0) looked = { ...looked, listing: relisted(listingOf(meta, delivery.id), without(looked.listing, gone)) };
  if (prior !== undefined && prior.account !== null && !waitsPhone(prior)) {
    if (looked.failed !== undefined) return fed(prior);
    const kept = listingOf(meta, delivery.id);
    meta.set(`${LISTING}${delivery.id}`, JSON.stringify(looked.listing));
    feed(tx, connectors, lane, kind, looked.listing, prior, now);
    claimsGrew(tx, delivery.id, kept, looked.listing, prior);
    return fed(prior);
  }
  const files = admittedFiles(meta);
  const fileKey = `${kind}/${looked.digest}`;
  const admitted = files[fileKey];
  if (admitted !== undefined && admitted.delivery !== delivery.id) {
    meta.set(`${VOID}${delivery.id}`, JSON.stringify({ kind, digest: looked.digest, of: admitted.delivery }));
    return none;
  }
  if (looked.checked !== null && (meta.get(anchorKey(looked.checked.source)) ?? null) !== looked.checked.anchor) return { ...none, again: true };
  meta.set(`${LISTING}${delivery.id}`, JSON.stringify(looked.listing));
  const leave = (id: string | null) => {
    if (id === null || held[id] === undefined) return;
    held[id]!.deliveries = held[id]!.deliveries.filter((each) => each !== delivery.id);
    if (held[id]!.deliveries.length === 0) delete held[id];
  };
  const join = (id: string, entry: HeldImport) => {
    if (was !== id) leave(was);
    held[id] = { ...entry, deliveries: entry.deliveries.includes(delivery.id) ? entry.deliveries : [...entry.deliveries, delivery.id] };
    meta.set(`${IMPORT_OF}${delivery.id}`, id);
    meta.set(HELD, JSON.stringify(held));
  };
  const at = { stamp: looked.stamp, time_ms: looked.time_ms, at_ms: now };
  if (looked.failed !== undefined || looked.refused !== null) {
    const id = endedId(kind, looked.digest, looked.failed !== undefined);
    join(id, { kind, account: null, ...at, refused: looked.refused ?? FAILED_WORDS, ended: true, ...looked.failed === undefined ? {} : { failed: looked.failed }, digest: looked.digest, deliveries: held[id]?.deliveries ?? [] });
    heldAgain(meta, fileKey);
    return none;
  }
  const phone = looked.device === null ? undefined : backupPhone(tx, connectors, kind, looked.device, passes, now);
  const unit = phone === undefined ? undefined : phone?.unit ?? null;
  const relook = phone?.fresh === true && wakePhone(tx, looked.device!.device, delivery.id);
  const byPhone = looked.contradicted === null && looked.account === null && typeof unit === "string" ? phoneAccount(tx, connectors, looked, unit, passes) : null;
  const account = looked.contradicted === null ? looked.account ?? byPhone : null;
  const device = unit === undefined ? {} : { device: looked.device!, unit };
  const which = looked.stamp ?? `#${looked.digest}`;
  const id = importId(kind, account, which);
  files[fileKey] = { import: id, delivery: delivery.id, at_ms: admitted?.at_ms ?? now };
  meta.set(FILES, JSON.stringify(files));
  heldAgain(meta, fileKey);
  const before = held[id];
  if (account === null) {
    const { answer: _answer, refused: _refused, named: _named, ...rest } = before ?? { kind, account: null, ...at, deliveries: [] };
    join(id, { ...rest, ...device, ...looked.named.length > 1 ? { named: looked.named } : {}, ...looked.contradicted === null ? {} : { refused: looked.contradicted } });
    return relook ? { ...none, relook: true } : none;
  }
  const entry: HeldImport = { ...before ?? { kind, account, ...at, deliveries: [] }, ...device };
  if (entry.time_ms === null && looked.time_ms !== null) entry.time_ms = looked.time_ms;
  if (looked.named.length === 0 && byPhone === null) entry.answered = true;
  join(id, entry);
  const sources = importSources(meta, delivery.id);
  if (looked.anchor !== null) {
    for (const source of sources) if (meta.get(anchorKey(source)) === undefined) meta.set(anchorKey(source), looked.anchor);
  }
  feed(tx, connectors, lane, kind, looked.listing, entry, now);
  const fedNow = new Set(sources);
  for (const other of held[id]!.deliveries) {
    if (other === delivery.id) continue;
    for (const row of tx.tables.deliveries.shipment(other)) {
      if (fedNow.has(row.source) && row.refused > 0 && row.read_by !== null) tx.tables.deliveries.move(other, row.source, { move: "unread" });
    }
  }
  return { sources, stated_ms: entry.time_ms ?? delivery.stated_ms, ...relook ? { relook: true as const } : {} };
}

export type PassOf = { readonly unit: string; readonly kind: string | null; readonly account: string | null };

export function backupPhone(
  tx: Tx, connectors: readonly Connector[], kind: string, device: declared.ImportDevice, passes: readonly PassOf[], now: number,
): { unit: string; fresh: boolean } | null {
  const meta = tx.tables.meta;
  const kept = meta.get(`${BACKUP_PHONE}${device.device}`);
  if (kept !== undefined) return { unit: kept, fresh: false };
  const phones = phoneUnits(tx.tables, passes);
  const holding = phonesHolding(tx, kindProducts(connectors, kind), device.accounts, phones);
  const unit = holding.length === 1 ? holding[0]!.unit : phones.length === 0 ? newPhone(tx, device, now) : null;
  if (unit === null) return null;
  meta.set(`${BACKUP_PHONE}${device.device}`, unit);
  return { unit, fresh: true };
}

const kindProducts = (connectors: readonly Connector[], kind: string): Set<string> =>
  new Set(connectors.filter((connector) => declared.importOf(connector)?.kind === kind).map((connector) => connector.product));

function phonesHolding(tx: Tx, products: ReadonlySet<string>, accounts: readonly string[], phones: readonly PhoneUnit[]): PhoneUnit[] {
  const named = new Set(accounts);
  const units = new Set(tx.tables.sources.list().flatMap((source) => {
    const { product, account, copy } = sourceName(source.id);
    return products.has(product) && named.has(account) ? [copy] : [];
  }));
  return phones.filter((phone) => units.has(phone.unit));
}

function newPhone(tx: Tx, device: declared.ImportDevice, now: number): string {
  const unit = (unitId(device.model_name, device.serial4 ?? undefined) ?? unitId("iPhone", device.serial4 ?? undefined))!;
  if (tx.tables.devices.get(unit) === undefined) tx.tables.devices.add({ unit, model: device.model_name, added_ms: now });
  return unit;
}

function wakePhone(tx: Tx, device: string, admitting: string | null): boolean {
  let woke = false;
  for (const entry of Object.values(heldImports(tx.tables.meta))) {
    if (entry.device?.device !== device || entry.unit !== null) continue;
    for (const delivery of entry.deliveries) {
      if (delivery === admitting) continue;
      tx.tables.meta.delete(`${LISTING}${delivery}`);
      woke = true;
    }
  }
  return woke;
}

function phoneAccount(tx: Tx, connectors: readonly Connector[], looked: Looked, unit: string, passes: readonly PassOf[]): string | null {
  const products = new Set(looked.listing.routes.map((route) => route.product));
  const offered = (account: string) => looked.named.length === 0 || looked.named.includes(account);
  const held = [...new Set(tx.tables.sources.list().flatMap((source) => {
    const name = sourceName(source.id);
    return products.has(name.product) && name.copy === unit && offered(name.account) ? [name.account] : [];
  }))];
  if (held.length === 1) return held[0]!;
  if (held.length > 1) return null;
  const apple = [...products].some((product) => connectors.find((connector) => connector.product === product)?.vendor === "apple");
  const pass = phoneUnits(tx.tables, passes).find((phone) => phone.unit === unit)?.account ?? null;
  return apple && pass !== null && offered(pass) ? pass : null;
}

export function answerPhone(tx: Tx, id: string, chosen: string, passes: readonly PassOf[], now: number): string[] {
  const entry = heldImports(tx.tables.meta)[id];
  if (entry === undefined || entry.device === undefined || entry.unit !== null) throw new Error(`import ${id} is not asked which phone it is of`);
  const unit = chosen === "new" ? newPhone(tx, entry.device, now) : chosen;
  if (chosen !== "new" && !phoneUnits(tx.tables, passes).some((phone) => phone.unit === unit)) throw new Error(`the home holds no phone ${unit}`);
  tx.tables.meta.set(`${BACKUP_PHONE}${entry.device.device}`, unit);
  wakePhone(tx, entry.device.device, null);
  return entry.deliveries;
}

function claimsGrew(tx: Tx, delivery: string, kept: Listing | null, listing: Listing, whose: Whose): void {
  const claims = (of: Listing | null) => {
    const out = new Map<string, Set<string>>();
    for (const route of of?.routes ?? []) {
      const source = declared.sourceOf(route, whose.account!, whose.unit ?? null);
      const held = out.get(source) ?? new Set<string>();
      for (const file of route.files) held.add(`${route.members}\0${file}`);
      out.set(source, held);
    }
    return out;
  };
  const before = claims(kept);
  for (const [source, now] of claims(listing)) {
    const was = before.get(source);
    if (was === undefined || [...now].every((claim) => was.has(claim))) continue;
    const row = tx.tables.deliveries.shipment(delivery).find((each) => each.source === source);
    if (row === undefined) continue;
    if (row.state === "imported" && !isUnread(row)) tx.tables.deliveries.move(delivery, source, { move: "relist" });
    else if (isUnread(row) && row.read_by !== null) tx.tables.deliveries.move(delivery, source, { move: "unread" });
  }
}

function feed(tx: Tx, connectors: readonly Connector[], lane: string, kind: string, listing: Listing, whose: Whose, now: number): void {
  for (const { id, connector } of routedSources(listing, whose)) {
    if (tx.tables.sources.get(id) !== undefined) continue;
    const cloud = id.endsWith(":cloud");
    tx.tables.sources.add({ id, vendor: vendorOf(connectors, id), connector, options: cloud ? {} : { lane, import: kind }, added_ms: now });
  }
}

export function answerImport(tx: Tx, id: string, account: string): string[] {
  const held = heldImports(tx.tables.meta);
  const entry = held[id];
  if (entry === undefined) throw new Error(`no import ${id}`);
  if (entry.account !== null || entry.ended === true || entry.unit === null) throw new Error(`import ${id} is not asked whose it is`);
  held[id] = { ...entry, answer: account };
  tx.tables.meta.set(HELD, JSON.stringify(held));
  for (const delivery of entry.deliveries) tx.tables.meta.delete(`${LISTING}${delivery}`);
  return entry.deliveries;
}

export const fileId = (delivery: string, path: string): string => idOf(delivery, path);

export function letGo(tx: Tx, delivery: string, files: readonly string[]): void {
  const kept = new Set([...letGoOf(tx.tables.meta, delivery), ...files]);
  tx.tables.meta.set(`${LET_GO}${delivery}`, JSON.stringify([...kept].sort()));
}

export function dropImport(tx: Tx, id: string): void {
  const meta = tx.tables.meta;
  const held = heldImports(meta);
  const entry = held[id];
  if (entry === undefined) return;
  for (const delivery of entry.deliveries) {
    meta.set(`${VOID}${delivery}`, JSON.stringify({ kind: entry.kind, dropped: true }));
    for (const key of [IMPORT_OF, LISTING, LET_GO, GONE]) meta.delete(`${key}${delivery}`);
  }
  const files = admittedFiles(meta);
  const gone = letGoFiles(meta);
  for (const [key, file] of Object.entries(files)) {
    if (file.import !== id) continue;
    delete files[key];
    gone.add(key);
  }
  if (entry.digest !== undefined) gone.add(`${entry.kind}/${entry.digest}`);
  meta.set(FILES, JSON.stringify(files));
  keepLetGo(meta, gone);
  delete held[id];
  meta.set(HELD, JSON.stringify(held));
}


export function besideOf(meta: Meta, delivery: string, source: string): string[] {
  const id = importIdOf(meta, delivery);
  if (id === null) return [];
  return (heldImports(meta)[id]?.deliveries ?? []).filter((other) => other !== delivery && importSources(meta, other).includes(source));
}

export function readerFacts<T extends JsonObjectLike>(meta: Meta, delivery: string, facts: T, zone: string, source: string): T {
  const kind = importKindOf(facts);
  const id = importIdOf(meta, delivery);
  const listing = listingOf(meta, delivery);
  const entry = id === null ? undefined : heldImports(meta)[id];
  const routed = entry === undefined || listing === null ? [] : routedSources(listing, entry).map(({ id, connector }) => ({ id, connector }));
  return {
    ...facts, zone,
    ...(kind === null ? {} : { import: { kind, id } }),
    account: sourceName(source).account,
    sources: [...new Map(routed.map((each) => [each.id, each])).values()],
  };
}


export interface Tally {
  days: Record<string, number>;
  kinds: Record<string, number>;
  lines?: Record<string, number>;
  refused?: { count: number; members: Record<string, number> };
}

function joined(left: Tally, right: Tally, by: (left: number, right: number) => number): Tally {
  const join = (one: Record<string, number> = {}, other: Record<string, number> = {}) => {
    const out = { ...one };
    for (const [key, count] of Object.entries(other)) out[key] = by(out[key] ?? 0, count);
    return out;
  };
  return { days: join(left.days, right.days), kinds: join(left.kinds, right.kinds), lines: join(left.lines, right.lines) };
}

export function widest(kept: Tally | null | undefined, tally: Tally): Tally {
  return kept === null || kept === undefined ? tally : joined(kept, tally, Math.max);
}

export function tallied(tally: Tally, seen: Set<number>, settings: DaySettings, lined: (kind: string) => boolean): (record: { kind: string; key: string; time?: { start_ms: number } }) => void {
  return (record) => {
    const digest = recordDigest(record.kind, record.key);
    if (seen.has(digest)) return;
    seen.add(digest);
    tally.kinds[record.kind] = (tally.kinds[record.kind] ?? 0) + 1;
    if (record.time === undefined) return;
    const day = civilDay(record.time.start_ms, settings);
    tally.days[day] = (tally.days[day] ?? 0) + 1;
    if (lined(record.kind)) (tally.lines ??= {})[day] = (tally.lines[day] ?? 0) + 1;
  };
}

export function linedKinds(families: readonly { inputs: readonly { sources: SourceSelector; kinds: readonly string[]; role: string }[] }[], source: { id: string; vendor: string }): Set<string> {
  const parts = { ...sourceName(source.id), vendor: source.vendor };
  return new Set(families.flatMap((family) => family.inputs.filter((input) => input.role === "evidence" && selects(input.sources, parts)).flatMap((input) => input.kinds)));
}

function recordDigest(kind: string, key: string): number {
  const hash = createHash("sha256").update(kind).update("\0").update(key).digest();
  return hash.readUIntBE(0, 6) * 32 + (hash[6]! >> 3);
}

export function tallyOf(meta: Meta, delivery: string, source: string): Tally | null {
  const kept = meta.get(`${DAYS}${pair(delivery, source)}`);
  return kept === undefined ? null : (JSON.parse(kept) as Tally);
}

export function importImported(tx: Tx, delivery: string, source: string, landed: Pick<Landed, "consumed" | "refused" | "refusedMembers">, tally: Tally | null): void {
  const id = importIdOf(tx.tables.meta, delivery);
  if (id === null) return;
  const key = pair(delivery, source);
  if (landed.refused === 0 && landed.consumed !== undefined && landed.consumed.length > 0) tx.tables.meta.set(`${CONSUMED_KEY}${key}`, JSON.stringify(landed.consumed));
  else tx.tables.meta.delete(`${CONSUMED_KEY}${key}`);
  if (tally !== null) keepTally(tx, key, landed, tally);
  importIn(tx, id);
}

export function importDropped(tx: Tx, delivery: string, source: string, landed: Pick<Landed, "refused" | "refusedMembers">, tally: Tally, reread: boolean): void {
  const id = importIdOf(tx.tables.meta, delivery);
  if (id === null) return;
  const key = pair(delivery, source);
  const before = reread ? tallyOf(tx.tables.meta, delivery, source) : null;
  if (before !== null) tx.tables.meta.set(`${DAYS}${key}`, JSON.stringify({ ...before, ...widest(before, tally) } satisfies Tally));
  else keepTally(tx, key, landed, tally);
  importIn(tx, id);
}

function keepTally(tx: Tx, key: string, landed: Pick<Landed, "refused" | "refusedMembers">, tally: Tally): void {
  const refused = landed.refused === 0 ? {} : { refused: { count: landed.refused, members: Object.fromEntries(landed.refusedMembers ?? []) } };
  tx.tables.meta.set(`${DAYS}${key}`, JSON.stringify({ days: tally.days, kinds: tally.kinds, ...tally.lines === undefined ? {} : { lines: tally.lines }, ...refused } satisfies Tally));
}

export function importIn(tx: Tx, id: string): void {
  const held = heldImports(tx.tables.meta)[id];
  if (held === undefined || held.account === null) return;
  const sources = new Set(held.deliveries.flatMap((each) => importSources(tx.tables.meta, each)));
  const rows = held.deliveries.flatMap((each) => tx.tables.deliveries.shipment(each)).filter((row) => sources.has(row.source));
  if (!rows.every(isSettled)) return;
  const days = new Set<string>();
  const lined = new Set<string>();
  for (const row of rows) {
    const tally = tallyOf(tx.tables.meta, row.id, row.source);
    for (const [day, count] of Object.entries(tally?.days ?? {})) if (count > 0) days.add(day);
    for (const [day, count] of Object.entries(tally?.lines ?? {})) if (count > 0) lined.add(day);
  }
  const span = spanOf(days);
  if (span === null) tx.tables.meta.delete(spanKey(id));
  else tx.tables.meta.set(spanKey(id), JSON.stringify(span));
  const open = [...lined].sort().at(-1);
  if (open === undefined) tx.tables.meta.delete(openDayKey(id));
  else tx.tables.meta.set(openDayKey(id), open);
}

export function spanOf(days: Iterable<string>): { from: string; to: string } | null {
  const sorted = [...days].sort();
  return sorted.length === 0 ? null : { from: sorted[0]!, to: sorted.at(-1)! };
}
