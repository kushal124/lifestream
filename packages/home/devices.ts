import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { declarations, roadsOf, type cameras, type Connector, type Road } from "@lifestreamprotocol/connect";
import { accountName, compareVersions, isObject, SourceNameError, sourceName, type DaySettings, type JsonObject, type OpenView, type ReadTables, type Tx } from "@lifestreamprotocol/core";
import { cameraVerdict, DEVICE_NAMES, type CameraLabel, type CameraWhy } from "@lifestreamprotocol/families";
import { MANIFEST_FORMAT } from "./inbox.js";
import type { Scope } from "./principals.js";
import { repoRoot } from "./programs.js";


export const DEVICE_KINDS = ["mac", "phone", "extension", "runner"] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export interface Delivered {
  readonly id: string;
  readonly connector: string;
  readonly options?: JsonObject;
}

interface Kind {
  readonly scopes: readonly Scope[];
  readonly road?: Road;
  readonly owners?: readonly string[];
  readonly lane?: string;
  readonly account: "paired" | "offered";
  readonly formats: readonly string[];
  readonly unit?: RegExp;
}

const UNIT = "<unit>";
const HOME = "<home>";
const ACCOUNT = "<account>";

export interface OwnerSource extends Delivered {
  readonly route?: string;
}

const ROUTES: Readonly<Record<string, string>> = { "places-home": "/v1/places", "devices-home": "/v1/devices" };

export const OWNER_PRODUCTS = { people: "people-home", places: "places-home", devices: "devices-home" } as const;
export type OwnerProduct = keyof typeof OWNER_PRODUCTS;

export function isOwnerProduct(value: unknown): value is OwnerProduct {
  return typeof value === "string" && Object.hasOwn(OWNER_PRODUCTS, value);
}

export function ownerProductOf(connector: string | undefined): OwnerProduct | null {
  return (Object.keys(OWNER_PRODUCTS) as OwnerProduct[]).find((product) => OWNER_PRODUCTS[product] === connector) ?? null;
}

export const DEVICES: Readonly<Record<DeviceKind, Kind>> = {
  mac: { scopes: ["deliver"], road: "mac", account: "offered", formats: [MANIFEST_FORMAT] },
  phone: {
    scopes: ["deliver", "read"], road: "phone", owners: Object.values(OWNER_PRODUCTS), lane: "phone:<unit>", account: "paired",
    formats: ["ios-bundle/1", "ios-bundle/2", "ios-bundle/3"],
  },
  extension: { scopes: ["station"], account: "offered", formats: [MANIFEST_FORMAT], unit: /^chrome-[0-9a-f]{8}$/u },
  runner: { scopes: ["run"], account: "offered", formats: [], unit: /^runner-[a-z0-9][a-z0-9-]*$/u },
};

function ownerSources(): OwnerSource[] {
  return declarations().flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes("owner"))
    .map((source): OwnerSource => ({ id: source.id, connector: source.read, ...(ROUTES[source.read] === undefined ? {} : { route: ROUTES[source.read] }) })));
}

export function kindSources(kind: DeviceKind, connectors: readonly Connector[]): Delivered[] {
  const { road, lane, owners = [] } = DEVICES[kind];
  const onRoad = road === undefined ? [] : connectors.flatMap((connector) => connector.sources.filter((source) => roadsOf(source).includes(road))
    .map((source): Delivered => ({ id: source.id, connector: source.read, ...(lane === undefined ? {} : { options: { lane } }) })));
  return [...onRoad, ...ownerSources().filter((source) => owners.includes(source.connector))];
}

export function isDeviceKind(value: unknown): value is DeviceKind {
  return typeof value === "string" && (DEVICE_KINDS as readonly string[]).includes(value);
}

export function unitSources(kind: DeviceKind, unit: string, account: string | null, home: string, connectors: readonly Connector[]): Delivered[] {
  const named = DEVICES[kind].account === "paired" && account !== null;
  return kindSources(kind, connectors).filter((source) => named || !source.id.includes(ACCOUNT))
    .map((source) => filled(source, unit, account, home));
}

export function homeSources(home: string): Delivered[] {
  return ownerSources().filter((source) => !source.id.includes(ACCOUNT)).map((source) => filled(source, UNIT, null, home));
}

export function ownerSource(id: string, home: string): OwnerSource | null {
  let parts: ReturnType<typeof sourceName>;
  try {
    parts = sourceName(id);
  } catch (error) {
    if (error instanceof SourceNameError) return null;
    throw error;
  }
  const fits = (pattern: string, part: string) => pattern === ACCOUNT || (pattern === HOME ? part === home : pattern === part);
  for (const source of ownerSources()) {
    const [product, account, copy] = source.id.split(":") as [string, string, string];
    if (product === parts.product && fits(account, parts.account) && fits(copy, parts.copy)) return { ...source, id };
  }
  return null;
}

export function pairedAccount(kind: DeviceKind, stated: string, connectors: readonly Connector[]): string | null {
  let account: string;
  try {
    account = accountName(stated);
    for (const source of kindSources(kind, connectors)) if (source.id.includes(ACCOUNT)) sourceName(filled(source, "unit", account, null).id);
  } catch (error) {
    if (error instanceof SourceNameError) return null;
    throw error;
  }
  return account;
}

export function offered(kind: DeviceKind, unit: string, id: string, connectors: readonly Connector[]): Delivered | null {
  if (DEVICES[kind].account !== "offered") return null;
  let parts: ReturnType<typeof sourceName>;
  try {
    parts = sourceName(id);
  } catch (error) {
    if (error instanceof SourceNameError) return null;
    throw error;
  }
  for (const source of kindSources(kind, connectors)) {
    const [product, account, copy] = source.id.split(":") as [string, string, string];
    if (account === ACCOUNT && product === parts.product && copy.replace(UNIT, unit) === parts.copy) return filled(source, unit, parts.account, null);
  }
  return null;
}

export function laneOf(kind: DeviceKind, unit: string): string | null {
  return DEVICES[kind].lane?.replace(UNIT, unit) ?? null;
}

function filled(source: Delivered, unit: string, account: string | null, home: string | null): Delivered {
  const fill = (text: string) => text.replace(UNIT, unit).replace(HOME, home ?? HOME).replace(ACCOUNT, account ?? ACCOUNT);
  return {
    id: fill(source.id), connector: source.connector,
    options: Object.fromEntries(Object.entries(source.options ?? {}).map(([key, value]) => [key, typeof value === "string" ? fill(value) : value])),
  };
}

export function deviceHeader(header: string | string[] | undefined): { kind: DeviceKind; version: string } | null {
  const match = typeof header === "string" ? /^([a-z]+)\/(\d+(?:\.\d+)*)$/u.exec(header.trim()) : null;
  return match !== null && isDeviceKind(match[1]) ? { kind: match[1], version: match[2]! } : null;
}

export type Floors = Readonly<Record<DeviceKind, string>>;

export function releaseFloors(path = join(repoRoot(), "packages", "home", "release.json")): Floors {
  const stated = (JSON.parse(readFileSync(path, "utf8")) as JsonObject).floors;
  const broken = `${path} must state floors: a version for each of ${DEVICE_KINDS.join(", ")}`;
  if (!isObject(stated)) throw new Error(broken);
  for (const kind of DEVICE_KINDS) if (typeof stated[kind] !== "string" || !/^\d+(?:\.\d+)*$/u.test(stated[kind] as string)) throw new Error(broken);
  return Object.fromEntries(DEVICE_KINDS.map((kind) => [kind, stated[kind] as string])) as Floors;
}

export function belowFloor(floors: Floors, kind: DeviceKind, version: string): boolean {
  return compareVersions(version, floors[kind]) < 0;
}

export function unitId(model: string, serial4: string | undefined, random: (bytes: number) => Buffer = randomBytes): string | null {
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
  return slug === "" ? null : `${slug}-${serial4 ?? random(2).toString("hex")}`;
}

export const BACKUP_PHONE = "backup-phone:";

export interface PhoneUnit {
  readonly unit: string;
  readonly model: string;
  readonly retired: boolean;
  readonly account: string | null;
  readonly passed: boolean;
}

export function phoneUnits(tables: Pick<ReadTables, "meta" | "devices">, passes: readonly { readonly unit: string; readonly kind: string | null; readonly account: string | null }[]): PhoneUnit[] {
  const phonePasses = passes.filter((pass) => pass.kind === "phone");
  const backups = tables.meta.under(BACKUP_PHONE).map((device) => tables.meta.get(`${BACKUP_PHONE}${device}`)!);
  const units = new Set([...phonePasses.map((pass) => pass.unit), ...backups]);
  return [...units].sort().flatMap((unit): PhoneUnit[] => {
    const device = tables.devices.get(unit);
    if (device === undefined) return [];
    const own = phonePasses.filter((pass) => pass.unit === unit);
    return [{ unit, model: device.model, retired: device.retired_ms !== null, account: own.at(-1)?.account ?? null, passed: own.length > 0 }];
  });
}

export const nameKey = (unit: string): string => `name:${unit}`;

export function shownName(tables: Pick<ReadTables, "meta" | "devices">, unit: string): string {
  return tables.meta.get(nameKey(unit)) ?? tables.devices.get(unit)?.model ?? unit;
}

export function cameraNamed(view: OpenView, camera: string, label: CameraLabel | undefined, count: cameras.Camera | undefined, at_ms: number, day: DaySettings):
  { name: string; mine: boolean; why: CameraWhy; rule: CameraWhy } {
  const rule = label === undefined ? undefined : (({ word: _word, ...rest }: CameraLabel) => rest)(label);
  return { name: cameraName(view, camera, count), ...cameraVerdict(label, at_ms, day), rule: cameraVerdict(rule, at_ms, day).why };
}

function cameraName(view: OpenView, camera: string, count: cameras.Camera | undefined): string {
  if (count?.make != null && count.model != null) return `${count.make} ${count.model}`;
  const unit = camera.startsWith("phone/") ? camera.slice("phone/".length) : undefined;
  const phone = unit === undefined ? undefined : view.tables.meta.get(nameKey(unit)) ?? view.tables.devices.get(unit)?.model;
  return phone === undefined ? camera : `${phone} (paired)`;
}
export const NAME_CHARS = 64;

export function deviceName(typed: string): { name: string } | { refused: string } {
  const name = typed.trim();
  if (name === "") return { refused: "Type a name." };
  if ([...name].length > NAME_CHARS) return { refused: `A name is at most ${NAME_CHARS} characters.` };
  if (/\p{Cc}/u.test(name)) return { refused: "A name is one line of text." };
  return { name };
}

export function nameDevice(tx: Tx, unit: string, name: string, at_ms: number): void {
  if (tx.tables.meta.get(nameKey(unit)) === name) return;
  tx.tables.meta.set(nameKey(unit), name);
  tx.tables.events.append({ at_ms, kind: "device-name", key: unit, detail: { name } });
  tx.tables.dirty.days(tx.derived.dayUnits.days(DEVICE_NAMES, unit));
}
