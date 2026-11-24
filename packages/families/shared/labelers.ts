import type { RecordRef, SourceSelector, View } from "@lifestreamprotocol/core";
import { PEOPLE_SOURCES } from "./labels.js";

const KEYED: readonly { sources: SourceSelector; kinds: readonly string[] }[] = [
  { sources: { product: ["faces"] }, kinds: ["image", "scan", "faces", "model-image"] },
  { sources: { product: ["cameras"] }, kinds: ["photo"] },
];

export function labelerRecordsOf(view: View, hex: string, erased: readonly RecordRef[]): RecordRef[] {
  if (namedBeyond(view, `sha256:${hex}`, erased)) return [];
  const records: RecordRef[] = [];
  for (const { sources, kinds } of KEYED) {
    for (const { id } of view.sources(sources)) {
      for (const kind of kinds) if (view.head({ source: id, kind, key: hex }) !== undefined) records.push({ source: id, kind, key: hex });
    }
  }
  for (const { id } of view.sources(PEOPLE_SOURCES)) {
    for (const head of view.keyedUnder(id, "face", `${hex}:`)) records.push({ source: id, kind: "face", key: head.key });
  }
  return records;
}

function namedBeyond(view: View, blob: string, erased: readonly RecordRef[]): boolean {
  const skip = new Set(erased.map((record) => `${record.source}\0${record.kind}\0${record.key}`));
  const sources = view.sources().map((source) => source.id);
  for (const version of view.naming(blob)) {
    for (const source of sources) {
      if (skip.has(`${source}\0${version.kind}\0${version.key}`)) continue;
      if (view.head({ source, kind: version.kind, key: version.key })?.version === version.id) return true;
    }
  }
  return false;
}
