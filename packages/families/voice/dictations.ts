import { textHead, type Dictation, type ExtractRow } from "@lifestreamprotocol/core";
import type { DayLine, RecordRead, RecordText } from "../family.js";
import { count, recordRead, recordText } from "../shared/text.js";

export const WORDS_CAP = 1_000;
export const GROUP_GAP_MS = 5 * 60_000;

export const DICTATION_KIND = "dictation";

export interface Dictating {
  name: string;
  kind: string;
}

export interface DictationContent {
  product: string;
  at_ms: number;
  words: string;
  chars: number;
  app: string | null;
  page: string | null;
}

export function readDictation(product: string, dictation: Dictation | null, at_ms: number | undefined): DictationContent | null {
  if (at_ms === undefined || dictation === null || dictation.words.trim() === "") return null;
  const words = dictation.words.trim();
  return { product, at_ms, words: textHead(words, WORDS_CAP), chars: words.length, app: dictation.app, page: dictation.page };
}

export function dictationText(dictation: Dictation | null): RecordText | null {
  return dictation === null ? null : recordText({ text: dictation.words });
}

export function dictationRead(dictation: Dictation | null): RecordRead | null {
  return dictation === null ? null : recordRead({ text: dictation.words, from: null });
}

export function dictationLines(extracts: readonly ExtractRow[], products: ReadonlyMap<string, Dictating>): DayLine[] {
  const sorted = extracts
    .map((extract) => ({ extract, dictation: extract.content as unknown as DictationContent }))
    .sort((left, right) => left.dictation.at_ms - right.dictation.at_ms || (left.extract.unit < right.extract.unit ? -1 : 1));
  const out: DayLine[] = [];
  for (let index = 0; index < sorted.length;) {
    const first = sorted[index]!;
    const target = targetOf(first.dictation, products);
    let end = index + 1;
    while (end < sorted.length && targetOf(sorted[end]!.dictation, products) === target &&
      sorted[end]!.dictation.at_ms - sorted[end - 1]!.dictation.at_ms <= GROUP_GAP_MS) end++;
    const run = sorted.slice(index, end);
    index = end;
    const block = run.length === 1 ? undefined : { key: `dictation/${target}/${first.dictation.at_ms}`, title: target };
    for (const { extract, dictation } of run) {
      const slash = extract.unit.indexOf("/");
      const [source, key] = [extract.unit.slice(0, slash), extract.unit.slice(slash + 1)];
      out.push({
        family: "voice", unit: extract.unit, units: [extract.unit], start_ms: dictation.at_ms, end_ms: null,
        text: block === undefined ? `${target}: ${quoted(dictation)}` : quoted(dictation),
        record: { source, kind: products.get(dictation.product)?.kind ?? DICTATION_KIND, key },
        ...(block === undefined ? {} : { block }),
      });
    }
  }
  return out;
}

function targetOf(dictation: DictationContent, products: ReadonlyMap<string, Dictating>): string {
  if (dictation.app === null) return `Dictated with ${products.get(dictation.product)?.name ?? dictation.product}`;
  return `Dictated into ${dictation.app}${dictation.page === null ? "" : ` (${dictation.page})`}`;
}

function quoted(dictation: DictationContent): string {
  const cut = dictation.chars > dictation.words.length;
  return `"${dictation.words}${cut ? "…" : ""}"${cut ? ` [${count(dictation.chars)} characters]` : ""}`;
}
