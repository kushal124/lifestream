import {
  callingCode, canonical, canonicalJid, canonicalPhone, civilDay, digest, GONE, handleFrom, handleId, handleOf, isObject, readPersonRecord,
  type Adapter, type DaySettings, type Handle, type HandleKind, type Json, type LabelsAdapter, type MessageLabel, type MessagesAdapter, type PersonRecord, type SourceRow, type SourceSelector, type Version, type View,
} from "@lifestreamprotocol/core";
import type { Family, FamilyInput, Given, Labels, PersonLabel, ProviderLabel, RecordRead, RecordText } from "../family.js";
import { quiet as quietOn, type Span } from "../messages/groups.js";
import { networksOf, partyHandle, providerUnit, type Networks } from "../messages/networks.js";
import { chatName, nameId, type NamedBy } from "./cast.js";
import { areaOf } from "./geography.js";
import { cardParts, readCard, readRecord, resolve, type Card, type OwnHandle, type RecordState } from "./people.js";
import { hiddenAt, nearestPlace, placeOf, placeTable, type Circle, type GoogleName, type Hidden, type Place, type PlaceTable, type Where } from "./places.js";
import { recordRead, recordText } from "./text.js";

export const PEOPLE_SOURCES: SourceSelector = { product: ["people"] };
export const CONTACT_KIND = "contact";
const ANY_SOURCE: SourceSelector = {};
export function ownProducts(given: readonly Given<Adapter & { owner?: "account" }>[]): string[] {
  return [...new Set(given.flatMap((each) => each.adapter.owner === "account" ? [each.product] : []))].sort(compare);
}

export function ownProductsIn(families: readonly Pick<Family, "adapters">[]): string[] {
  return ownProducts(families.flatMap((family) => family.adapters ?? []));
}

export function ownHandles(view: View, products: readonly string[], networks: Networks): OwnHandle[] {
  if (products.length === 0) return [];
  return view.sources({ product: [...products] }).flatMap(({ account, product }) => {
    const handle = accountHandle(networks, product, account);
    return handle === null ? [] : [{ ...handle, product }];
  });
}

export function accountHandle(networks: Networks, product: string, account: string): Handle | null {
  if (account === NO_ACCOUNT) return null;
  const network = networks.of(product);
  if (network === undefined) return handleFrom("email", account);
  return partyHandle(product, { id: network.self?.(account) ?? account, kind: "network" });
}
const NO_ACCOUNT = "local";

export interface Books {
  readonly books: readonly Given<LabelsAdapter>[];
}

export function labelInputs({ books }: Books): FamilyInput[] {
  const products = [...new Set(books.map((each) => each.product))].sort(compare);
  return [
    { sources: PEOPLE_SOURCES, kinds: ["person"], role: "labels" },
    ...(products.length === 0 ? [] : [{ sources: { product: products }, kinds: [CONTACT_KIND], role: "labels" as const }]),
  ];
}

const DEVICE_THRESHOLD = 50;
const PAIRED_CAMERA = "phone/";
export const CAMERA_UNIT = "camera:";
export const GROUP_UNIT = "group:";
export const MONTH_KIND = "month";

export function groupSources(home: string | null): SourceSelector {
  return { product: ["groups"], copy: home === null ? [] : [home] };
}

export function groupUnit(row: LabelRow | undefined): readonly Span[] | undefined {
  const content = row?.content;
  if (!isObject(content) || !Array.isArray(content.yours)) return undefined;
  return content.yours.flatMap((span): Span[] => Array.isArray(span) && span.length === 2 && typeof span[0] === "string" && typeof span[1] === "string" ? [[span[0], span[1]]] : []);
}

export function readGroupMonth(view: View, home: string | null, unit: string): Json | undefined {
  const key = unit.slice(GROUP_UNIT.length);
  for (const source of sourceIds(view, groupSources(home))) {
    const head = view.head({ source, kind: MONTH_KIND, key });
    if (head !== undefined && head.version !== "gone") return view.version(head.version).content;
  }
  return undefined;
}

export function groupMonths(view: View, home: string | null): string[] {
  return sourceIds(view, groupSources(home)).flatMap((source) => [...view.heads(source, MONTH_KIND)].map((head) => `${GROUP_UNIT}${head.key}`));
}

export interface CameraWord {
  mine: boolean;
  from?: string;
  to?: string;
}

export interface CameraLabel {
  mine_by_count: boolean;
  paired?: true;
  word?: CameraWord;
}

export type CameraWhy = "owner" | "count" | "paired" | "none";

export function cameraSources(home: string | null): { counts: SourceSelector; words: SourceSelector } {
  const copy = home === null ? [] : [home];
  return { counts: { product: ["cameras"], copy }, words: { product: ["devices"], copy } };
}

export function cameraVerdict(label: CameraLabel | undefined, at_ms: number, day: DaySettings): { mine: boolean; why: CameraWhy } {
  const word = label?.word;
  if (word !== undefined) {
    const on = civilDay(at_ms, day);
    if ((word.from === undefined || word.from <= on) && (word.to === undefined || on <= word.to)) return { mine: word.mine, why: "owner" };
  }
  if (label?.mine_by_count !== true) return { mine: false, why: "none" };
  return { mine: true, why: label.paired === true ? "paired" : "count" };
}

function cameraLabelOf(camera: string, counted: Json | undefined, word: Json | undefined): CameraLabel | null {
  const photos = isObject(counted) && counted.type === "cameras.camera" && typeof counted.photos === "number" ? counted.photos : 0;
  const said = isObject(word) && word.type === "devices.camera" && typeof word.mine === "boolean" ? word : undefined;
  if (counted === undefined && said === undefined) return null;
  const paired = camera.startsWith(PAIRED_CAMERA) || (isObject(counted) && Array.isArray(counted.phones) && counted.phones.length > 0);
  return {
    mine_by_count: photos >= DEVICE_THRESHOLD || paired,
    ...(paired ? { paired: true as const } : {}),
    ...(said === undefined ? {} : { word: {
      mine: said.mine as boolean,
      ...(typeof said.from === "string" ? { from: said.from } : {}),
      ...(typeof said.to === "string" ? { to: said.to } : {}),
    } }),
  };
}

export function readCamera(view: View, home: string | null, camera: string): { label: CameraLabel; counted: Json | undefined } | null {
  const sources = cameraSources(home);
  const content = (selector: SourceSelector): Json | undefined => {
    for (const source of sourceIds(view, selector)) {
      const head = view.head({ source, kind: "camera", key: camera });
      if (head !== undefined && head.version !== "gone") return view.version(head.version).content;
    }
    return undefined;
  };
  const counted = content(sources.counts);
  const label = cameraLabelOf(camera, counted, content(sources.words));
  return label === null ? null : { label, counted };
}

export function readCameras(view: View, home: string | null): { camera: string; label: CameraLabel; counted: Json | undefined }[] {
  const sources = cameraSources(home);
  const contents = (selector: SourceSelector): Map<string, Json> => {
    const found = new Map<string, Json>();
    for (const source of sourceIds(view, selector)) {
      for (const { head, version } of byKey(view.records(source, "camera"))) if (!found.has(head.key)) found.set(head.key, version.content);
    }
    return found;
  };
  const [counted, words] = [contents(sources.counts), contents(sources.words)];
  return [...new Set([...counted.keys(), ...words.keys()])].sort(compare)
    .flatMap((camera) => {
      const label = cameraLabelOf(camera, counted.get(camera), words.get(camera));
      return label === null ? [] : [{ camera, label, counted: counted.get(camera) }];
    });
}

export function cameraUnit(row: LabelRow | undefined): CameraLabel | undefined {
  return row?.content as unknown as CameraLabel | undefined;
}

export interface DayLabels extends Labels {
  readonly version: string;
  readonly table: LabelTable;
  readonly contents: ReadonlyMap<string, Json>;
}

export interface LabelTable {
  people: [string, string, string, string, PersonLabel["by"], string | null, boolean][];
  places: Place[];
  google: GoogleName[];
  hidden: Hidden[];
  providers: [string, ProviderLabel][];
  cameras: [string, CameraLabel][];
}

export function personHandles(table: LabelTable, id: string): string[] | undefined {
  let person = id;
  if (!id.startsWith("person:")) {
    const handle = handleOfId(id);
    if (handle === null) return undefined;
    const row = table.people.find(([kind, value]) => kind === handle.kind && value === handle.value);
    if (row === undefined) return [handle.value];
    person = row[2];
  }
  const values = table.people.filter((row) => row[2] === person).map((row) => row[1]);
  return values.length === 0 ? undefined : values;
}

export function labelText(kind: string, content: Json): RecordText | null {
  const parts = labelParts(kind, content);
  return parts === null ? null : recordText(parts);
}

export function labelRead(kind: string, content: Json): RecordRead | null {
  const parts = labelParts(kind, content);
  return parts === null ? null : recordRead(parts);
}

function labelParts(kind: string, content: Json): { title: string | null; text?: string; who: string[] } | null {
  if (kind === "person") {
    const record = readPersonRecord(content);
    if (record === null || record.merged_into !== null) return null;
    const names = [record.name, record.full_name].flatMap((name) => name === null ? [] : [name]);
    const held = [...(record.anchor === null ? [] : [record.anchor]), ...record.handles];
    return { title: names[0] ?? null, text: names.slice(1).join("\n"), who: held.map((handle) => handle.value) };
  }
  if (!isObject(content)) return null;
  if (kind === "contact") {
    const card = cardParts(content);
    return card === null ? null : { title: card.name, who: [...card.phones.map((phone) => canonicalPhone(phone) ?? phone), ...card.emails] };
  }
  return null;
}

export function labelReading(record: { kind: string; key: string }, content: Json | undefined): string {
  const { kind } = record;
  if (content === undefined) return "";
  if (kind === "person") {
    const read = readPersonRecord(content);
    if (read === null) return canonical(null);
    const { name, full_name, show } = read;
    return canonical({ ...personHeld(read), name, full_name, show } as unknown as Json);
  }
  if (!isObject(content)) return canonical(content);
  if (kind === "contact" && typeof content.card === "string") {
    const card = cardParts(content);
    return canonical(card === null ? null : { name: card.name, phones: card.phones, emails: card.emails });
  }
  return canonical(content);
}

export function renamedPerson(before: Json | undefined, after: Json | undefined): string | null {
  const was = before === undefined ? null : readPersonRecord(before);
  const now = after === undefined ? null : readPersonRecord(after);
  if (was === null || now === null) return null;
  return canonical(personHeld(was) as unknown as Json) === canonical(personHeld(now) as unknown as Json) ? now.slug : null;
}

function personHeld({ slug, anchor, handles, excluded, merged_into, me }: PersonRecord): Pick<PersonRecord, "slug" | "anchor" | "handles" | "excluded" | "merged_into" | "me"> {
  return { slug, anchor, handles, excluded, merged_into, me };
}

const UTC_DAY: DaySettings = { zone: "UTC", day_start_hour: 0 };

export function buildLabels(input: {
  people?: readonly RecordState[];
  contacts?: readonly Card[];
  country?: string | null;
  own?: readonly OwnHandle[];
  places: readonly Place[];
  google?: readonly GoogleName[];
  hidden?: readonly Hidden[];
  providers?: readonly (readonly [product: string, labels: ReadonlyMap<string, ProviderLabel>])[];
  networks?: Networks;
  cameras?: readonly [string, CameraLabel][];
}): DayLabels {
  const networks = input.networks ?? networksOf([]);
  const providers = new Map((input.providers ?? []).flatMap(([product, labels]) => [...labels].map(([id, label]) => [providerUnit(networks, product, id), label] as const)));
  const people = resolve({ cards: input.contacts ?? [], records: input.people ?? [], providers, networks, country: input.country ?? null, own: input.own ?? [] });
  const rows: LabelTable["people"] = [];
  for (const person of people.all) {
    if (!person.me && person.by === "none" && person.handles.length <= 1 && person.record === null && person.cards.length === 0) continue;
    for (const handle of person.handles) rows.push([handle.kind, handle.value, person.id, person.name, person.by, person.slug, person.me]);
  }
  const table: LabelTable = {
    people: rows.sort((left, right) => compare(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`)), ...placesOf({ places: input.places, google: input.google ?? [], hidden: input.hidden ?? [] }),
    providers: [...providers].sort(([left], [right]) => compare(left, right)).map(([id, label]) => [id, { ...label }]),
    cameras: [...input.cameras ?? []].sort(([left], [right]) => compare(left, right)).map(([id, label]) => [id, copyCamera(label)]),
  };
  const contents = labelContents(table);
  const read = (unit: string): LabelRow | undefined => (contents.has(unit) ? { content: contents.get(unit)! } : undefined);
  return { version: digest(servedTable(table)), table, contents, ...labelsFrom(read, UTC_DAY) };
}

export function servedTable(table: LabelTable): Json {
  return { ...table, places: table.places.map(({ also, ...place }) => (also.length === 0 ? place : { ...place, also })) } as unknown as Json;
}

export const LABELS_FAMILY = "labels";

export const LABELS_CODE = "9";

export interface LabelRow {
  content: Json;
}

export const PLACES_UNIT = "places";

interface IdLabels {
  person?: Omit<PersonLabel, "me"> & { me?: boolean };
  provider?: ProviderLabel;
}

export function labelContents(table: LabelTable): Map<string, Json> {
  const ids = new Map<string, IdLabels>();
  const of = (unit: string): IdLabels => {
    let found = ids.get(unit);
    if (found === undefined) ids.set(unit, found = {});
    return found;
  };
  for (const [kind, handle, id, name, by, slug, me] of table.people) of(handleId({ kind: kind as HandleKind, value: handle })).person = { id, name, by, slug, me };
  for (const [unit, label] of table.providers) of(unit).provider = { ...label };
  const units: [string, Json][] = [...ids].map(([unit, content]) => [unit, content as unknown as Json]);
  for (const [camera, label] of table.cameras) units.push([`${CAMERA_UNIT}${camera}`, copyCamera(label) as unknown as Json]);
  const out = new Map<string, Json>(units.sort(([left], [right]) => compare(left, right)));
  const places = placesContent(table);
  if (places !== undefined) out.set(PLACES_UNIT, places);
  return out;
}

export function placesContent(table: PlaceTable): Json | undefined {
  if (table.places.length === 0 && table.google.length === 0 && table.hidden.length === 0) return undefined;
  return placesStored(placesOf(table)) as unknown as Json;
}

export function labelTable(units: Iterable<LabelRow & { unit: string }>): LabelTable {
  const table: LabelTable = { people: [], places: [], google: [], hidden: [], providers: [], cameras: [] };
  for (const row of units) {
    const { unit, content } = row;
    if (unit === PLACES_UNIT) {
      Object.assign(table, placesUnit(row));
      continue;
    }
    if (unit.startsWith(CAMERA_UNIT)) {
      const label = cameraUnit(row);
      if (label !== undefined) table.cameras.push([unit.slice(CAMERA_UNIT.length), copyCamera(label)]);
      continue;
    }
    if (unit.startsWith(GROUP_UNIT)) continue;
    const id = content as IdLabels;
    const colon = unit.indexOf(":");
    const [kind, handle] = HANDLE_UNITS.includes(unit.slice(0, colon)) ? [unit.slice(0, colon), unit.slice(colon + 1)] : ["network", unit];
    if (id.person !== undefined) table.people.push([kind, handle, id.person.id, id.person.name, id.person.by, id.person.slug, id.person.me === true]);
    if (id.provider !== undefined) table.providers.push([unit, { ...id.provider }]);
  }
  const byHandle = (left: [string, string, ...unknown[]], right: [string, string, ...unknown[]]) =>
    compare(`${left[0]}\0${left[1]}`, `${right[0]}\0${right[1]}`);
  table.people.sort(byHandle);
  table.providers.sort(([left], [right]) => compare(left, right));
  table.cameras.sort(([left], [right]) => compare(left, right));
  return table;
}

export function labelsFrom(read: (unit: string) => LabelRow | undefined, day: DaySettings): Labels {
  const cache = new Map<string, LabelRow | undefined>();
  const units = (unit: string): LabelRow | undefined => {
    if (!cache.has(unit)) cache.set(unit, read(unit));
    return cache.get(unit);
  };
  const id = (unit: string) => units(unit)?.content as IdLabels | undefined;
  let table: PlaceTable | undefined;
  const places = (): PlaceTable => (table ??= placesUnit(units(PLACES_UNIT)));
  return {
    person(value) {
      const handle = handleOf(value) ?? handleFrom("network", value);
      const person = handle === null ? undefined : id(handleId(handle))?.person;
      return person === undefined ? undefined : { ...person, me: person.me === true };
    },
    place(latitude, longitude, id) {
      return placeOf({ latitude, longitude, ...(id === undefined ? {} : { id }) }, places()) ?? undefined;
    },
    nearest(latitude, longitude) {
      const found = nearestPlace({ latitude, longitude }, places());
      return found === null ? undefined : { name: found.place.name, distance_m: found.distance_m };
    },
    hidden(latitude, longitude) {
      return hiddenAt({ latitude, longitude }, places().hidden) !== undefined;
    },
    provider(value, network) {
      return id(network !== undefined ? `${network}:${value}` : `jid:${canonicalJid(value) ?? value.trim()}`)?.provider;
    },
    mine(camera, at_ms) {
      return cameraVerdict(cameraUnit(units(`${CAMERA_UNIT}${camera}`)), at_ms, day).mine;
    },
    quiet(network, chat, on) {
      const yours = groupUnit(units(`${GROUP_UNIT}${network}:${chat}:${on.slice(0, 7)}`));
      return yours !== undefined && quietOn(yours, on);
    },
  };
}

export function readLabels(view: View, home: string | null, networks: Networked): DayLabels {
  return buildLabels({ ...readLabelRecords(view, home, STATED_CARDS, networks), cameras: readCameras(view, home).map(({ camera, label }) => [camera, label]) });
}

export interface Networked {
  messages: readonly Given<MessagesAdapter>[];
  own: readonly string[];
}

const NO_NETWORKS: Networked = { messages: [], own: [] };

export interface Cards {
  sources: SourceSelector;
  content(source: SourceRow, version: Version): Json;
}

const STATED_CARDS: Cards = { sources: ANY_SOURCE, content: (_source, version) => version.content };

export function readPeople(view: View): RecordState[] {
  const records: RecordState[] = [];
  for (const source of sourceIds(view, PEOPLE_SOURCES)) {
    for (const head of view.heads(source, "person")) {
      const state = readRecord(view, { source, kind: "person", key: head.key });
      if (state !== null) records.push(state);
    }
  }
  return records;
}

export function readLabelRecords(view: View, home: string | null, books: Cards = STATED_CARDS, networked: Networked = NO_NETWORKS): Parameters<typeof buildLabels>[0] {
  const records = readPeople(view);
  const cards: Card[] = [];
  for (const row of view.sources(books.sources).sort((left, right) => compare(left.id, right.id))) {
    for (const { head, version } of byKey(view.records(row.id, CONTACT_KIND))) {
      const parts = cardParts(books.content(row, version));
      if (parts !== null) cards.push(readCard(head, head.since_ms, parts));
    }
  }
  const networks = networksOf(networked.messages);
  const providers: [string, Map<string, ProviderLabel>][] = [];
  for (const { product, adapter } of networked.messages) {
    const label = adapter.label;
    const sources = view.sources({ product: [product] }).sort((left, right) => compare(left.id, right.id));
    if (adapter.labels === undefined || label === undefined) continue;
    const said: ProviderRecord[] = [];
    const own = new Set<string>();
    for (const source of sources) {
      for (const kind of adapter.labels.kinds) {
        for (const { head, version } of view.records(source.id, kind)) {
          const saying = label({ source, version });
          if (saying === null) continue;
          said.push({ source: source.id, kind, key: head.key, stated_ms: head.stated_ms, said: saying });
          const self = adapter.self?.(source.account) ?? null;
          if (self !== null) own.add(self);
        }
      }
    }
    if (said.length === 0) continue;
    const reread = (record: ProviderRecord, version: Version) => label({ source: sources.find((each) => each.id === record.source)!, version });
    providers.push([product, foldProviders(said, own, (record) => began(view, record, reread))]);
  }
  return {
    people: records, contacts: cards, country: ownCountry(view, networks),
    own: ownHandles(view, networked.own, networks), ...placeTable(view, home),
    ...(providers.length === 0 ? {} : { providers }), networks,
  };
}

export function ownCountry(view: View, networks: Networks): string | null {
  const sources = networks.products.flatMap((product) => {
    const self = networks.of(product)?.self;
    return self === undefined ? [] : view.sources({ product: [product] }).filter((source) => self(source.account) !== null);
  }).sort((left, right) => compare(left.id, right.id));
  for (const { product, account } of sources) {
    const handle = accountHandle(networks, product, account);
    if (handle?.kind === "phone") return callingCode(handle.value);
  }
  return null;
}

function began(view: View, record: ProviderRecord, reread: (record: ProviderRecord, version: Version) => MessageLabel | null): Map<string, number> {
  const names = new Map(slots(record.said).names);
  const dates = new Map([...names.keys()].map((slot) => [slot, record.stated_ms]));
  const readings = new Map<string, Map<string, string>>();
  for (const statement of view.history(record).sort((left, right) => right.stated_ms - left.stated_ms || right.seq - left.seq)) {
    if (statement.late || statement.stated_ms > record.stated_ms) continue;
    if (statement.version === GONE) break;
    if (!readings.has(statement.version)) readings.set(statement.version, new Map(slots(reread(record, view.version(statement.version))).names));
    const reading = readings.get(statement.version)!;
    for (const [slot, name] of names) {
      if (reading.get(slot) !== name) names.delete(slot);
      else dates.set(slot, statement.stated_ms);
    }
    if (names.size === 0) break;
  }
  return dates;
}

export type ResolvedName = [id: string, name: string, by: NamedBy, person: string | null];

export function resolvedName(id: string, labels: Labels, networks: Networks): ResolvedName {
  const colon = id.indexOf(":");
  const network = colon > 0 && colon < id.length - 1 && networks.of(id.slice(0, colon)) !== undefined ? id.slice(0, colon) : undefined;
  const { name, by, person } = network === undefined ? nameId(id, labels) : nameId(id.slice(colon + 1), labels, "network", network);
  return [id, name, by, person];
}

export function resolvedChat(key: string, labels: Labels, networks: Networks): [chat: string, title: string, group: boolean] | null {
  const colon = key.indexOf(":");
  const network = colon < 0 ? undefined : networks.of(key.slice(0, colon));
  const chat = key.slice(colon + 1);
  if (network === undefined || chat.length === 0) return null;
  return [key, chatName(networks, key.slice(0, colon), chat, labels).text, network.group(chat)];
}

export function resolvedPlace(point: Where, labels: Labels): [latitude: number, longitude: number, slug: string | null, name: string | null, shown: string] {
  const place = labels.place(point.latitude, point.longitude, point.id);
  return [point.latitude, point.longitude, place?.slug ?? null, place?.name ?? null, placeWords(point, labels)];
}

export const HIDDEN_WORDS = "a hidden place";

const TOLD_BY_CITY_M = 10_000;

export function placeWords(point: Where, labels: Labels): string {
  const name = labels.place(point.latitude, point.longitude, point.id)?.name;
  if (name !== undefined) return name;
  if (labels.hidden?.(point.latitude, point.longitude) === true) return HIDDEN_WORDS;
  const nearest = labels.nearest(point.latitude, point.longitude);
  if (nearest === undefined || nearest.distance_m >= TOLD_BY_CITY_M) {
    const city = areaOf(point).city;
    if (city !== null) return `an unnamed place in ${city}`;
  }
  if (nearest === undefined) return "an unnamed place";
  const km = nearest.distance_m / 1_000;
  return `an unnamed place ${km < 10 ? (Math.round(km * 10) / 10).toFixed(1) : String(Math.round(km))} km from ${nearest.name}`;
}

export interface ProviderRecord {
  source: string;
  kind: string;
  key: string;
  stated_ms: number;
  said: MessageLabel;
}

export function foldProviders(records: readonly ProviderRecord[], own: ReadonlySet<string> = new Set(), began: (record: ProviderRecord) => ReadonlyMap<string, number> = (record) => new Map(slots(record.said).names.map(([slot]) => [slot, record.stated_ms]))): Map<string, ProviderLabel> {
  const said = records.map((record) => ({ record, ...slots(record.said) }));
  const given = new Map<string, Set<string>>();
  for (const { names } of said) for (const [slot, name] of names) given.set(slot, (given.get(slot) ?? new Set()).add(name));
  const named = said.flatMap(({ record, names }) => {
    const dates = names.some(([slot]) => given.get(slot)!.size > 1) ? began(record) : undefined;
    return names.map(([slot, name]) => ({ record, slot, name, at: dates?.get(slot) ?? record.stated_ms }));
  });
  named.sort((left, right) => right.at - left.at || compare(left.record.source, right.record.source)
    || compare(left.record.kind, right.record.kind) || compare(left.record.key, right.record.key));
  const chosen = new Map<string, string>();
  for (const { slot, name } of named) if (!chosen.has(slot)) chosen.set(slot, name);
  const paired = new Map<string, Set<string>>();
  for (const { record } of said) {
    const pair = record.said.pair;
    if (pair === undefined) continue;
    for (const [from, to] of [pair, [pair[1], pair[0]]] as const) paired.set(from, (paired.get(from) ?? new Set()).add(to));
  }
  const archived = new Map<string, boolean>();
  for (const { record } of said) if (record.said.archived !== undefined) archived.set(record.key, (archived.get(record.key) ?? true) && record.said.archived);
  const business = new Map<string, { level: number; name?: string; record: ProviderRecord }>();
  for (const { record } of said) {
    const listed = record.said.business;
    if (listed === undefined) continue;
    for (const id of listed.ids) {
      const held = business.get(id);
      const wins = held === undefined || listed.level > held.level
        || (listed.level === held.level && (record.stated_ms > held.record.stated_ms || (record.stated_ms === held.record.stated_ms && compare(record.key, held.record.key) < 0)));
      if (wins) business.set(id, { level: listed.level, ...(listed.name === undefined ? {} : { name: listed.name }), record });
    }
  }
  const names = new Map([...chosen].flatMap(([slot, name]) => slot.startsWith("name\0") ? [[slot.slice(5), name] as const] : []));
  const pushNames = new Map([...chosen].flatMap(([slot, name]) => slot.startsWith("push\0") ? [[slot.slice(5), name] as const] : []));
  const alias = (id: string): string | undefined => {
    const to = paired.get(id);
    if (to?.size !== 1) return undefined;
    const other = [...to][0]!;
    return paired.get(other)?.size === 1 ? other : undefined;
  };
  const out = new Map<string, ProviderLabel>();
  for (const id of [...new Set([...names.keys(), ...pushNames.keys(), ...paired.keys(), ...business.keys(), ...[...archived].flatMap(([group, is]) => is ? [group] : [])])].sort(compare)) {
    const other = alias(id);
    const mine = own.has(id) || (other !== undefined && own.has(other));
    const name = mine ? undefined : names.get(id) ?? (other === undefined ? undefined : names.get(other));
    const pushName = pushNames.get(id) ?? (other === undefined ? undefined : pushNames.get(other));
    const listed = business.get(id) ?? (other === undefined ? undefined : business.get(other));
    const label: ProviderLabel = {
      ...(name === undefined ? {} : { name }),
      ...(pushName === undefined ? {} : { pushName }),
      ...(listed === undefined ? {} : { business: listed.level, ...(listed.name === undefined ? {} : { businessName: listed.name }) }),
      ...(other === undefined ? {} : { aliases: [other] }),
      ...(archived.get(id) === true ? { archived: true as const } : {}),
    };
    if (Object.keys(label).length > 0) out.set(id, label);
  }
  for (const [chat, name] of chatNames(records)) if (!out.has(chat)) out.set(chat, { name });
  return out;
}

function chatNames(records: readonly ProviderRecord[]): Map<string, string> {
  const chatOf = new Map<string, string>();
  for (const record of records) if (record.said.chat !== undefined) chatOf.set(`${record.source}\0${record.key}`, record.said.chat);
  const named = records.flatMap((record) => {
    const said = record.said.named;
    const chat = said === undefined ? undefined : chatOf.get(`${record.source}\0${said[0]}`);
    return chat === undefined ? [] : [{ record, chat, name: said![1] }];
  }).sort((left, right) => right.record.stated_ms - left.record.stated_ms || compare(left.record.source, right.record.source) || compare(left.record.key, right.record.key));
  const out = new Map<string, string>();
  for (const { chat, name } of named) if (!out.has(chat)) out.set(chat, name);
  return out;
}

function slots(said: MessageLabel | null): { names: [string, string][] } {
  if (said === null) return { names: [] };
  return { names: [...said.names.map(([id, name]): [string, string] => [`name\0${id}`, name]), ...(said.pushName === undefined ? [] : [[`push\0${said.pushName[0]}`, said.pushName[1]] as [string, string]])] };
}

export function placesUnit(row: LabelRow | undefined): PlaceTable {
  if (row === undefined) return { places: [], google: [], hidden: [] };
  const stored = row.content as unknown as { places: (Omit<Place, "ids" | "also"> & { ids?: string[]; also?: Circle[] })[]; google?: GoogleName[]; hidden?: Hidden[] };
  return placesOf({ places: stored.places.map((place) => ({ ...place, ids: place.ids ?? [], also: place.also ?? [] })), google: stored.google ?? [], hidden: stored.hidden ?? [] });
}

function copyCamera(label: CameraLabel): CameraLabel {
  return { mine_by_count: label.mine_by_count, ...(label.paired === true ? { paired: true } : {}), ...(label.word === undefined ? {} : { word: { ...label.word } }) };
}

function placesOf(table: { places: readonly Place[]; google: readonly GoogleName[]; hidden?: readonly Hidden[] }): PlaceTable {
  return {
    places: table.places.map((place) => ({ ...place, ids: [...place.ids], also: place.also.map((circle) => ({ ...circle })) })), google: table.google.map((name) => ({ ...name })),
    hidden: (table.hidden ?? []).map((circle) => ({ ...circle })),
  };
}

function placesStored(table: PlaceTable): Omit<PlaceTable, "hidden" | "places"> & { places: (Omit<Place, "also"> & { also?: Circle[] })[]; hidden?: Hidden[] } {
  const { hidden, places, ...named } = table;
  const stored = places.map(({ also, ...place }) => also.length === 0 ? place : { ...place, also });
  return hidden.length === 0 ? { ...named, places: stored } : { ...named, places: stored, hidden };
}

const HANDLE_UNITS: readonly string[] = ["phone", "email", "jid"];

export function handleOfId(id: string): Handle | null {
  const colon = id.indexOf(":");
  if (colon < 0 || id.startsWith(CONTACT_ID)) return null;
  return HANDLE_UNITS.includes(id.slice(0, colon)) ? handleOf(id.slice(colon + 1)) : handleFrom("network", id);
}
const CONTACT_ID = "contact:";

function sourceIds(view: View, selector: SourceSelector): string[] {
  return view.sources(selector).map((source) => source.id).sort(compare);
}

function byKey<T extends { head: { key: string } }>(rows: Iterable<T>): T[] {
  return [...rows].sort((left, right) => compare(left.head.key, right.head.key));
}

function text(value: Json | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
