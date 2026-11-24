import { canonical, digest, isObject, selects, type Json, type LabelsAdapter, type MailAdapter, type MessagesAdapter, type SourceRow, type Version, type View } from "@lifestreamprotocol/core";
import { linesOnly, type Change, type Extracted, type Family, type Given, type Touched } from "../family.js";
import {
  buildLabels, CAMERA_UNIT, cameraSources, GROUP_UNIT, groupMonths, groupSources, labelReading, LABELS_CODE, LABELS_FAMILY, MONTH_KIND, ownProducts,
  PEOPLE_SOURCES, PLACES_UNIT, placesContent, readCamera, readCameras, readGroupMonth, readLabelRecords, readPeople, renamedPerson,
} from "../shared/labels.js";
import { mergeTree, registryNames } from "../shared/people.js";
import { placeSources, placeTable } from "../shared/places.js";

export interface LabelsSettings {
  home: string | null;
  messages: readonly Given<MessagesAdapter>[];
  mail: readonly Given<MailAdapter>[];
}

export function labelsFamily(settings: LabelsSettings): (given: readonly Given<LabelsAdapter>[]) => Family {
  return (given) => labelsOver(settings, given);
}

function labelsOver(settings: LabelsSettings, given: readonly Given<LabelsAdapter>[]): Family {
  const byProduct = new Map(given.map((each) => [each.product, each.adapter]));
  const content = (source: SourceRow | undefined, version: Version): Json => {
    const adapter = source === undefined ? undefined : byProduct.get(source.product);
    if (source === undefined || adapter?.card === undefined || !isObject(version.content)) return version.content;
    const card = adapter.card({ source, version });
    return card === null ? version.content : { ...version.content, card };
  };
  const books = { sources: { product: given.map((each) => each.product) }, content };
  const networked = { messages: settings.messages, own: ownProducts([...settings.messages, ...settings.mail]) };
  const networks = new Map(settings.messages.flatMap((each) => each.adapter.labels === undefined || each.adapter.label === undefined ? [] : [[each.product, each.adapter] as const]));
  const said = (source: SourceRow | undefined, kind: string, version: Version): Json | undefined => {
    const adapter = source === undefined ? undefined : networks.get(source.product);
    return adapter?.labels?.kinds.includes(kind) === true ? (adapter.label!({ source: source!, version }) ?? null) as unknown as Json : undefined;
  };
  const read = new WeakMap<View, Map<string, Json>>();
  const contentsOf = (view: View): Map<string, Json> => {
    let contents = read.get(view);
    if (contents === undefined) read.set(view, contents = new Map(buildLabels(readLabelRecords(view, settings.home, books, networked)).contents));
    return contents;
  };
  const renames = new WeakMap<View, Map<string, Json>>();
  const renamesOf = (view: View): Map<string, Json> => {
    let held = renames.get(view);
    if (held === undefined) renames.set(view, held = new Map());
    return held;
  };
  const places = placeSources(settings.home);
  const cameras = cameraSources(settings.home);
  const isPlace = ({ record }: Change, view: View): boolean => {
    const source = view.source(record.source);
    if (source === undefined) return false;
    return (selects(places.owner, source) && (record.kind === "place" || record.kind === "hidden")) || (selects(places.google, source) && record.kind === "place");
  };
  const renamed = (changes: readonly Change[], view: View): Map<string, Json> | null => {
    if (view.unitsPending(LABELS_FAMILY)) return null;
    const slugs: string[] = [];
    for (const { record, before, after } of changes) {
      const source = view.source(record.source);
      if (record.kind !== "person" || source === undefined || !selects(PEOPLE_SOURCES, source)) return null;
      const slug = renamedPerson(before && content(source, before), after && content(source, after));
      if (slug === null) return null;
      slugs.push(slug);
    }
    const names = registryNames(mergeTree(readPeople(view)), slugs);
    if (names === null) return null;
    const units = new Map<string, Json>();
    for (const { unit, content: stored } of view.extracts(LABELS_FAMILY)) {
      const person = isObject(stored) && isObject(stored.person) ? stored.person : undefined;
      const name = typeof person?.id === "string" ? names.get(person.id) : undefined;
      if (name !== undefined) units.set(unit, { ...stored as Record<string, Json>, person: { ...person, name, by: "registry" } });
    }
    return units;
  };
  return {
    name: LABELS_FAMILY,
    adapters: given,
    borrowed: { messages: settings.messages, mail: settings.mail },
    type: null,
    code: LABELS_CODE,
    inputs: [
      { sources: PEOPLE_SOURCES, kinds: ["person"], role: "labels" },
      ...given.map((each) => ({ sources: { product: [each.product] }, kinds: [...each.adapter.kinds], role: "labels" as const })),
      ...[...networks].map(([product, adapter]) => ({ sources: { product: [product] }, kinds: [...adapter.labels!.kinds], role: "labels" as const })),
      { sources: places.owner, kinds: ["place", "hidden"], role: "labels" },
      { sources: places.google, kinds: ["place"], role: "labels" },
      { sources: cameras.counts, kinds: ["camera"], role: "labels" },
      { sources: cameras.words, kinds: ["camera"], role: "labels" },
      { sources: groupSources(settings.home), kinds: [MONTH_KIND], role: "labels" },
    ],

    touched(all, view): Touched[] {
      const reading = (change: (typeof all)[number], version: Version | undefined): string => {
        if (version === undefined) return "";
        const source = view.source(change.record.source);
        const network = said(source, change.record.kind, version);
        return network !== undefined ? canonical(network) : labelReading(change.record, content(source, version));
      };
      const changes = all.filter((change) => reading(change, change.before) !== reading(change, change.after));
      if (all.length > 0 && changes.length === 0) return [];
      const own = (change: (typeof changes)[number]) => change.record.kind === "camera" || change.record.kind === MONTH_KIND;
      const units = new Set(changes.filter(own).map((change) => change.record.kind === "camera" ? `${CAMERA_UNIT}${change.record.key}` : `${GROUP_UNIT}${change.record.key}`));
      const rest = changes.filter((change) => !own(change));
      const whole = (): void => {
        for (const unit of contentsOf(view).keys()) units.add(unit);
        for (const stored of view.extracts(LABELS_FAMILY)) if (all.length === 0 || !(stored.unit.startsWith(CAMERA_UNIT) || stored.unit.startsWith(GROUP_UNIT))) units.add(stored.unit);
      };
      if (all.length === 0) {
        whole();
        for (const { camera } of readCameras(view, settings.home)) units.add(`${CAMERA_UNIT}${camera}`);
        for (const unit of groupMonths(view, settings.home)) units.add(unit);
      } else if (rest.length > 0 && rest.every((change) => isPlace(change, view))) {
        units.add(PLACES_UNIT);
      } else if (rest.length > 0) {
        const names = renamed(rest, view);
        if (names === null) whole();
        for (const [unit, label] of names ?? []) {
          renamesOf(view).set(unit, label);
          units.add(unit);
        }
      }
      return [...units].map((unit) => ({ unit }));
    },

    extract(unit, view): Extracted | null {
      const content: Json | undefined = unit.startsWith(CAMERA_UNIT)
        ? readCamera(view, settings.home, unit.slice(CAMERA_UNIT.length))?.label as unknown as Json | undefined
        : unit.startsWith(GROUP_UNIT) ? readGroupMonth(view, settings.home, unit)
        : unit === PLACES_UNIT ? placesContent(placeTable(view, settings.home))
        : read.has(view) ? read.get(view)!.get(unit)
        : renames.get(view)?.get(unit) ?? contentsOf(view).get(unit);
      return content === undefined ? null : { content, start_ms: null, end_ms: null, reading: digest(content) };
    },

    days: () => [],
    day: linesOnly(() => []),
  };
}
